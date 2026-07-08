import test from 'node:test';
import assert from 'node:assert/strict';

import { ProxmoxServer } from '../index.js';

function makeServer(routes) {
  process.env.PROXMOX_HOST ??= 'example.invalid';
  process.env.PROXMOX_TOKEN_VALUE ??= 'test-token';

  const server = new ProxmoxServer();
  server.proxmoxRequest = async (endpoint) => {
    if (endpoint in routes) return routes[endpoint];
    throw new Error(`Unexpected endpoint in test: ${endpoint}`);
  };
  return server;
}

const QEMU_CONFIG = {
  name: 'web-server',
  cores: 4,
  sockets: 1,
  memory: 4096,
  onboot: 1,
  ostype: 'l26',
  agent: '1',
  scsihw: 'virtio-scsi-single',
  boot: 'order=scsi0;ide2',
  scsi0: 'local-lvm:vm-100-disk-0,iothread=1,size=32G,ssd=1',
  ide2: 'local:iso/debian-12.iso,media=cdrom',
  net0: 'virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,firewall=1,tag=20',
  digest: 'abc123',
};

const LXC_CONFIG = {
  hostname: 'db-container',
  cores: 2,
  memory: 1024,
  swap: 512,
  onboot: 1,
  unprivileged: 1,
  ostype: 'debian',
  features: 'nesting=1',
  rootfs: 'local-lvm:subvol-200-disk-0,size=8G',
  mp0: 'local-lvm:subvol-200-disk-1,mp=/mnt/data,size=10G',
  net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:11:22,ip=192.168.1.50/24,gw=192.168.1.1,firewall=1',
  digest: 'def456',
};

test('generateTerraform renders a QEMU VM with import block', async () => {
  const server = makeServer({
    '/nodes/pve1/qemu': [{ vmid: 100, name: 'web-server' }],
    '/nodes/pve1/lxc': [],
    '/nodes/pve1/qemu/100/config': QEMU_CONFIG,
  });

  const result = await server.generateTerraform('pve1', '100', 'all', true);
  const text = result?.content?.[0]?.text ?? '';

  assert.match(text, /resource "proxmox_virtual_environment_vm" "vm_100_web_server"/);
  assert.match(text, /node_name\s+= "pve1"/);
  assert.match(text, /vm_id\s+= 100/);
  assert.match(text, /cores\s+= 4/);
  assert.match(text, /dedicated = 4096/);
  // disk parsed from scsi0
  assert.match(text, /interface\s+= "scsi0"/);
  assert.match(text, /datastore_id = "local-lvm"/);
  assert.match(text, /size\s+= 32/);
  assert.match(text, /ssd\s+= true/);
  // cdrom kept separate from disks
  assert.match(text, /file_id\s+= "local:iso\/debian-12\.iso"/);
  // network device with model-embedded MAC
  assert.match(text, /model\s+= "virtio"/);
  assert.match(text, /mac_address = "BC:24:11:AA:BB:CC"/);
  assert.match(text, /vlan_id\s+= 20/);
  assert.match(text, /boot_order\s+= \["scsi0", "ide2"\]/);
  // import block for adoption
  assert.match(text, /import \{/);
  assert.match(text, /to = proxmox_virtual_environment_vm\.vm_100_web_server/);
  assert.match(text, /id = "pve1\/100"/);
  // provider scaffolding requested
  assert.match(text, /source\s+= "bpg\/proxmox"/);
});

test('generateTerraform renders an LXC container with network and mount point', async () => {
  const server = makeServer({
    '/nodes/pve1/qemu': [],
    '/nodes/pve1/lxc': [{ vmid: 200, name: 'db-container' }],
    '/nodes/pve1/lxc/200/config': LXC_CONFIG,
  });

  const result = await server.generateTerraform('pve1', '200', 'lxc', false);
  const text = result?.content?.[0]?.text ?? '';

  assert.match(text, /resource "proxmox_virtual_environment_container" "ct_200_db_container"/);
  assert.match(text, /unprivileged\s+= true/);
  assert.match(text, /nesting = true/);
  assert.match(text, /swap\s+= 512/);
  assert.match(text, /volume = "local-lvm:subvol-200-disk-1"/);
  assert.match(text, /path\s+= "\/mnt\/data"/);
  assert.match(text, /name\s+= "eth0"/);
  assert.match(text, /mac_address = "BC:24:11:00:11:22"/);
  assert.match(text, /address = "192\.168\.1\.50\/24"/);
  assert.match(text, /gateway = "192\.168\.1\.1"/);
  assert.match(text, /hostname = "db-container"/);
  assert.match(text, /id = "pve1\/200"/);
  // include_provider=false suppresses scaffolding
  assert.doesNotMatch(text, /required_providers/);
});

test('generateTerraform emits at most one cdrom block when a VM has multiple ISOs', async () => {
  // Mirrors a real Windows VM: install ISO on ide2 + virtio driver ISO on ide3.
  const multiCdrom = {
    name: 'dc01',
    cores: 2,
    sockets: 1,
    memory: 4096,
    ide2: 'local:iso/windows-server-2022.iso,media=cdrom,size=4925874K',
    ide3: 'local:iso/virtio-win.iso,media=cdrom,size=771138K',
    scsi0: 'local-lvm:vm-200-disk-0,size=60G',
    digest: 'x',
  };
  const server = makeServer({
    '/nodes/pve1/qemu': [{ vmid: 200 }],
    '/nodes/pve1/lxc': [],
    '/nodes/pve1/qemu/200/config': multiCdrom,
  });

  const result = await server.generateTerraform('pve1', '200', 'qemu', false);
  const text = result?.content?.[0]?.text ?? '';

  const cdromBlocks = (text.match(/^\s*cdrom \{/gm) || []).length;
  assert.equal(cdromBlocks, 1, 'exactly one cdrom block is allowed by the provider');
  assert.match(text, /Additional CD-ROM not emitted/);
  assert.match(text, /ide3 = local:iso\/virtio-win\.iso/);
});

test('generateTerraform reports when the requested vmid does not exist', async () => {
  const server = makeServer({
    '/nodes/pve1/qemu': [],
    '/nodes/pve1/lxc': [],
  });

  const result = await server.generateTerraform('pve1', '999', 'all', true);
  const text = result?.content?.[0]?.text ?? '';
  assert.match(text, /No .* with ID 999/);
});

test('generateTerraform sweeps all nodes when no node filter is given', async () => {
  const server = makeServer({
    '/nodes': [{ node: 'pve1' }, { node: 'pve2' }],
    '/nodes/pve1/qemu': [{ vmid: 100 }],
    '/nodes/pve1/lxc': [],
    '/nodes/pve2/qemu': [],
    '/nodes/pve2/lxc': [{ vmid: 200 }],
    '/nodes/pve1/qemu/100/config': QEMU_CONFIG,
    '/nodes/pve2/lxc/200/config': LXC_CONFIG,
  });

  const result = await server.generateTerraform(undefined, undefined, 'all', true);
  const text = result?.content?.[0]?.text ?? '';

  assert.match(text, /2 resources/);
  assert.match(text, /proxmox_virtual_environment_vm\.vm_100_web_server/);
  assert.match(text, /proxmox_virtual_environment_container\.ct_200_db_container/);
  assert.match(text, /node_name\s+= "pve2"/);
});

test('hclString escapes quotes, template sequences and newlines', () => {
  process.env.PROXMOX_HOST ??= 'example.invalid';
  process.env.PROXMOX_TOKEN_VALUE ??= 'test-token';
  const server = new ProxmoxServer();

  assert.equal(server.hclString('plain'), '"plain"');
  assert.equal(server.hclString('a "quoted" value'), '"a \\"quoted\\" value"');
  assert.equal(server.hclString('${injection}'), '"$${injection}"');
  assert.equal(server.hclString('line1\nline2'), '"line1\\nline2"');
});

test('sizeToGB normalizes Proxmox size strings', () => {
  process.env.PROXMOX_HOST ??= 'example.invalid';
  process.env.PROXMOX_TOKEN_VALUE ??= 'test-token';
  const server = new ProxmoxServer();

  assert.equal(server.sizeToGB('32G'), 32);
  assert.equal(server.sizeToGB('8'), 8);
  assert.equal(server.sizeToGB('512M'), 1);
  assert.equal(server.sizeToGB('2048M'), 2);
  assert.equal(server.sizeToGB('1T'), 1024);
  assert.equal(server.sizeToGB('garbage'), null);
});
