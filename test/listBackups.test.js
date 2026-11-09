import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxmoxServer } from '../index.js';

process.env.PROXMOX_HOST ??= 'example.invalid';
process.env.PROXMOX_TOKEN_VALUE ??= 'test-token';

function elevatedServer() {
  const prev = process.env.PROXMOX_ALLOW_ELEVATED;
  process.env.PROXMOX_ALLOW_ELEVATED = 'true';
  const s = new ProxmoxServer();
  if (prev === undefined) delete process.env.PROXMOX_ALLOW_ELEVATED;
  else process.env.PROXMOX_ALLOW_ELEVATED = prev;
  return s;
}

const STORAGES = [
  { storage: 'local', type: 'dir', content: 'iso,vztmpl,backup' },
  { storage: 'local-lvm', type: 'lvmthin', content: 'images,rootdir' }, // not backup-capable
  { storage: 'pbs1', type: 'pbs', content: 'backup' },
];
const BK = {
  local: [{ volid: 'local:backup/vzdump-lxc-100-2025_11_06-10_35_58.tar.zst', size: 100, ctime: 1 }],
  pbs1: [{ volid: 'pbs1:backup/ct/104/2026-11-09T17:52:29Z', vmid: 104, size: 200, ctime: 2 }],
};

test('listBackups aggregates across all backup-capable storages when storage omitted', async () => {
  const s = elevatedServer();
  s.proxmoxRequest = async (path) => {
    if (path === '/nodes/pve1/storage') return STORAGES;
    const m = path.match(/storage\/([^/]+)\/content/);
    return BK[m[1]] || [];
  };
  const res = await s.listBackups('pve1');
  const text = res.content[0].text;
  assert.match(text, /across all storages/);
  assert.match(text, /### local/);
  assert.match(text, /### pbs1/);
  assert.doesNotMatch(text, /local-lvm/); // not backup-capable, skipped
  assert.match(text, /104 \(LXC\)/);      // PBS volid parsed to LXC 104
  assert.match(text, /Grand total\*\*: 2 backup/);
});

test('listBackups with an explicit storage lists only that one', async () => {
  const s = elevatedServer();
  s.proxmoxRequest = async (path) => {
    assert.match(path, /storage\/pbs1\/content/);
    return BK.pbs1;
  };
  const res = await s.listBackups('pve1', 'pbs1');
  const text = res.content[0].text;
  assert.match(text, /Backups on pbs1/);
  assert.match(text, /Total\*\*: 1 backup/);
});

test('empty storage shows all three permission layers (PVE token, PBS role, namespace)', async () => {
  const s = elevatedServer();
  s.proxmoxRequest = async () => [];
  const res = await s.listBackups('pve1', 'pbs1');
  const text = res.content[0].text;
  assert.match(text, /namespace mismatch/i);
  assert.match(text, /Datastore\.Allocate/);   // PVE token privilege
  assert.match(text, /VM\.Backup/);             // PVE token privilege
  assert.match(text, /DatastoreReader/);        // PBS datastore role
});

test('aggregate shows scoped guidance for an empty storage even when another has backups', async () => {
  const s = elevatedServer();
  s.proxmoxRequest = async (path) => {
    if (path === '/nodes/pve1/storage') return STORAGES;
    const name = path.match(/storage\/([^/]+)\/content/)[1];
    return name === 'local' ? BK.local : []; // pbs1 empty
  };
  const res = await s.listBackups('pve1');
  const text = res.content[0].text;
  assert.match(text, /Grand total\*\*: 1 backup/);   // local still counted
  assert.match(text, /`pbs1` returned no backups/);  // scoped guidance for the empty one
  assert.match(text, /Datastore\.Allocate/);
});

test('a failed storage read is not treated as empty and marks the total incomplete', async () => {
  const s = elevatedServer();
  s.proxmoxRequest = async (path) => {
    if (path === '/nodes/pve1/storage') return STORAGES;
    const name = path.match(/storage\/([^/]+)\/content/)[1];
    if (name === 'pbs1') throw new Error('Proxmox API error: 500 - boom');
    return BK.local;
  };
  const res = await s.listBackups('pve1');
  const text = res.content[0].text;
  assert.match(text, /could not be read/);                 // failure surfaced
  assert.match(text, /incomplete/);                        // total flagged
  assert.match(text, /Grand total\*\*: 1 backup/);         // failed read not counted as 0-in-total silently
  // The failed storage must NOT get empty-state (namespace) guidance.
  assert.doesNotMatch(text, /`pbs1` returned no backups/);
});

test('single-storage read failure does not emit empty-state guidance', async () => {
  const s = elevatedServer();
  s.proxmoxRequest = async () => { throw new Error('Proxmox API error: 500 - boom'); };
  const res = await s.listBackups('pve1', 'pbs1');
  const text = res.content[0].text;
  assert.match(text, /could not be read/);
  assert.doesNotMatch(text, /namespace mismatch/i);
});

test('listBackups still requires elevated permissions', async () => {
  const prev = process.env.PROXMOX_ALLOW_ELEVATED;
  delete process.env.PROXMOX_ALLOW_ELEVATED;
  const s = new ProxmoxServer();
  if (prev !== undefined) process.env.PROXMOX_ALLOW_ELEVATED = prev;
  const res = await s.listBackups('pve1');
  assert.match(res.content[0].text, /Requires Elevated Permissions/);
});
