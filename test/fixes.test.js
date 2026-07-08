import test from 'node:test';
import assert from 'node:assert/strict';

import { ProxmoxServer } from '../index.js';

function makeServer() {
  process.env.PROXMOX_HOST ??= 'example.invalid';
  process.env.PROXMOX_TOKEN_VALUE ??= 'test-token';
  process.env.PROXMOX_ALLOW_ELEVATED = 'true';
  return new ProxmoxServer();
}

// Records every proxmoxRequest call and returns canned responses.
function recordRequests(server, responder = () => ({})) {
  const calls = [];
  server.proxmoxRequest = async (endpoint, method = 'GET', body = null) => {
    calls.push({ endpoint, method, body });
    return responder(endpoint, method, body);
  };
  return calls;
}

// Finding 4: type is validated before it reaches the URL.
test('validateGuestType rejects anything but qemu/lxc', () => {
  const s = makeServer();
  assert.equal(s.validateGuestType('qemu'), 'qemu');
  assert.equal(s.validateGuestType('lxc'), 'lxc');
  assert.equal(s.validateGuestType(undefined, 'qemu'), 'qemu');
  assert.throws(() => s.validateGuestType('qemu/100/../../cluster'), /Invalid guest type/);
});

test('getVMStatus rejects an injected type instead of interpolating it', async () => {
  const s = makeServer();
  const calls = recordRequests(s, () => ({ status: 'running', name: 'x' }));
  const result = await s.getVMStatus('pve1', '100', 'qemu/100/../../cluster/resources');
  assert.match(result.content[0].text, /Invalid guest type/);
  assert.equal(calls.length, 0, 'no request should be issued for a bad type');
});

// Finding 6: fractional disk sizes are not corrupted.
test('createVM keeps fractional disk sizes intact', async () => {
  const s = makeServer();
  const calls = recordRequests(s, () => 'UPID:task');
  await s.createVM({ node: 'pve1', vmid: '100', disk_size: '1.5G', storage: 'local-lvm' });
  const create = calls.find(c => c.endpoint === '/nodes/pve1/qemu' && c.method === 'POST');
  assert.equal(create.body.scsi0, 'local-lvm:1.5', 'must not become local-lvm:15');
});

test('createVM handles a plain integer size', async () => {
  const s = makeServer();
  const calls = recordRequests(s, () => 'UPID:task');
  await s.createVM({ node: 'pve1', vmid: '100', disk_size: '32G', storage: 'fast' });
  const create = calls.find(c => c.endpoint === '/nodes/pve1/qemu' && c.method === 'POST');
  assert.equal(create.body.scsi0, 'fast:32');
});

// Finding 1: LXC command execution fails clearly without hitting a dead endpoint.
test('executeVMCommand refuses LXC without calling the missing exec endpoint', async () => {
  const s = makeServer();
  const calls = recordRequests(s);
  const result = await s.executeVMCommand('pve1', '200', 'ls -la', 'lxc');
  assert.match(result.content[0].text, /not supported for LXC/i);
  assert.equal(calls.length, 0, 'must not POST to /lxc/{vmid}/exec');
});

// Finding 3: QEMU exec sends the command as an argv array.
test('executeVMCommand sends the QEMU command as a list of args', async () => {
  const s = makeServer();
  const calls = recordRequests(s, () => ({ pid: 42 }));
  await s.executeVMCommand('pve1', '100', 'ls -la /tmp', 'qemu');
  const exec = calls.find(c => c.endpoint.endsWith('/agent/exec'));
  assert.deepEqual(exec.body.command, ['ls', '-la', '/tmp']);
});

// Finding 5: changing a NIC model preserves the existing MAC.
test('updateNetworkVM preserves the MAC when switching model', async () => {
  const s = makeServer();
  const calls = recordRequests(s, (endpoint, method) => {
    if (method === 'GET') {
      return { net0: 'virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,firewall=1' };
    }
    return 'UPID:task';
  });
  await s.updateNetworkVM('pve1', '100', 'net0', undefined, 'e1000', undefined, undefined, undefined);
  const put = calls.find(c => c.method === 'PUT');
  assert.match(put.body.net0, /e1000=BC:24:11:AA:BB:CC/, 'MAC must carry over to the new model');
  assert.doesNotMatch(put.body.net0, /virtio=/, 'old model key must be gone');
});

// Finding 2: restore uses the correct per-type parameters.
test('restoreBackup uses archive for QEMU and no restore key', async () => {
  const s = makeServer();
  const calls = recordRequests(s, () => 'UPID:task');
  await s.restoreBackup('pve1', '100', 'local:backup/vzdump-qemu-100.vma.zst', undefined, 'qemu');
  const post = calls.find(c => c.endpoint === '/nodes/pve1/qemu' && c.method === 'POST');
  assert.equal(post.body.archive, 'local:backup/vzdump-qemu-100.vma.zst');
  assert.equal(post.body.restore, undefined);
  assert.equal(post.body.ostemplate, undefined);
});

test('restoreBackup uses ostemplate + restore for LXC', async () => {
  const s = makeServer();
  const calls = recordRequests(s, () => 'UPID:task');
  await s.restoreBackup('pve1', '200', 'local:backup/vzdump-lxc-200.tar.zst', 'local-lvm', 'lxc');
  const post = calls.find(c => c.endpoint === '/nodes/pve1/lxc' && c.method === 'POST');
  assert.equal(post.body.ostemplate, 'local:backup/vzdump-lxc-200.tar.zst');
  assert.equal(post.body.restore, 1);
  assert.equal(post.body.archive, undefined);
  assert.equal(post.body.storage, 'local-lvm');
});

// Finding 7: shared storage across nodes is not silently collapsed.
test('getStorage lists a shared storage once per node', async () => {
  const s = makeServer();
  recordRequests(s, (endpoint) => {
    if (endpoint === '/nodes') return [{ node: 'pve1' }, { node: 'pve2' }];
    if (endpoint.endsWith('/storage')) {
      return [{ storage: 'nas', type: 'nfs', enabled: 1, total: 100, used: 50 }];
    }
    return [];
  });
  const result = await s.getStorage();
  const text = result.content[0].text;
  assert.match(text, /Node: pve1/);
  assert.match(text, /Node: pve2/);
});
