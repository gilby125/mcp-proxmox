import test from 'node:test';
import assert from 'node:assert/strict';

import { ProxmoxServer } from '../index.js';

function makeServer(env = {}) {
  process.env.PROXMOX_HOST ??= 'example.invalid';
  process.env.PROXMOX_TOKEN_VALUE ??= 'test-token';
  process.env.PROXMOX_ALLOW_ELEVATED = 'true';
  delete process.env.PROXMOX_NODE_ALLOWLIST;
  delete process.env.PROXMOX_VMID_ALLOWLIST;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const s = new ProxmoxServer();
  s.sleep = async () => {}; // never actually pause in tests
  return s;
}

function recordRequests(server, responder = () => ({})) {
  const calls = [];
  server.proxmoxRequest = async (endpoint, method = 'GET', body = null) => {
    calls.push({ endpoint, method, body });
    return responder(endpoint, method, body);
  };
  return calls;
}

// ---------- UPID validation ----------
test('validateUPID accepts a real UPID and rejects junk', () => {
  const s = makeServer();
  const upid = 'UPID:pve1:0000ABCD:12345678:5F3A1B2C:vzdump:100:root@pam:';
  assert.equal(s.validateUPID(upid), upid);
  assert.throws(() => s.validateUPID('not-a-upid'), /Invalid UPID/);
  assert.throws(() => s.validateUPID('UPID:pve1;rm -rf/'), /Invalid UPID/);
});

// ---------- getTaskStatus ----------
test('getTaskStatus reports success and structured content', async () => {
  const s = makeServer();
  recordRequests(s, () => ({ status: 'stopped', exitstatus: 'OK', type: 'qmclone', pid: 999 }));
  const upid = 'UPID:pve1:0000ABCD:12345678:5F3A1B2C:qmclone:100:root@pam:';
  const res = await s.getTaskStatus('pve1', upid);
  assert.match(res.content[0].text, /✅/);
  assert.equal(res.structuredContent.success, true);
  assert.equal(res.structuredContent.finished, true);
});

test('getTaskStatus with wait polls until the task stops', async () => {
  const s = makeServer();
  let n = 0;
  recordRequests(s, () => (++n < 3 ? { status: 'running' } : { status: 'stopped', exitstatus: 'OK' }));
  const upid = 'UPID:pve1:0000ABCD:12345678:5F3A1B2C:qmclone:100:root@pam:';
  const res = await s.getTaskStatus('pve1', upid, true, 60);
  assert.equal(res.structuredContent.success, true);
  assert.ok(n >= 3, 'should have polled multiple times');
});

// ---------- executeVMCommand polling ----------
test('executeVMCommand polls exec-status and returns stdout + exit code', async () => {
  const s = makeServer();
  const calls = recordRequests(s, (endpoint, method) => {
    if (endpoint.includes('/agent/exec') && method === 'POST') return { pid: 77 };
    if (endpoint.includes('/agent/exec-status')) {
      return { exited: 1, exitcode: 0, 'out-data': 'hello\n', 'err-data': '' };
    }
    return {};
  });
  const res = await s.executeVMCommand('pve1', '100', 'echo hello', 'qemu');
  const statusCall = calls.find(c => c.endpoint.includes('/agent/exec-status'));
  assert.ok(statusCall, 'must poll exec-status');
  assert.match(statusCall.endpoint, /pid=77/);
  assert.equal(res.structuredContent.exitcode, 0);
  assert.equal(res.structuredContent.stdout, 'hello\n');
  assert.match(res.content[0].text, /hello/);
});

test('executeVMCommand handles boolean exited=true (no 30s hang, reports success)', async () => {
  const s = makeServer();
  recordRequests(s, (endpoint, method) => {
    if (endpoint.includes('/agent/exec') && method === 'POST') return { pid: 5 };
    if (endpoint.includes('/agent/exec-status')) {
      return { exited: true, exitcode: 0, 'out-data': 'ok\n' };
    }
    return {};
  });
  const res = await s.executeVMCommand('pve1', '100', 'true', 'qemu');
  assert.equal(res.structuredContent.exited, true);
  assert.match(res.content[0].text, /✅/);
  assert.ok(!res.isError);
});

test('executeVMCommand preserves the PID when exec-status polling fails', async () => {
  const s = makeServer();
  recordRequests(s, (endpoint, method) => {
    if (endpoint.includes('/agent/exec') && method === 'POST') return { pid: 99 };
    if (endpoint.includes('/agent/exec-status')) throw new Error('transient 500');
    return {};
  });
  const res = await s.executeVMCommand('pve1', '100', 'sleep 1', 'qemu');
  assert.match(res.content[0].text, /launched/i);
  assert.match(res.content[0].text, /99/);
  assert.equal(res.structuredContent.pid, 99);
  assert.ok(!res.isError, 'a launched command must not be reported as a hard failure');
});

test('executeVMCommand does not mark success as failure when exitcode is absent', async () => {
  const s = makeServer();
  recordRequests(s, (endpoint, method) => {
    if (endpoint.includes('/agent/exec') && method === 'POST') return { pid: 7 };
    if (endpoint.includes('/agent/exec-status')) return { exited: 1, 'out-data': 'done' };
    return {};
  });
  const res = await s.executeVMCommand('pve1', '100', 'echo done', 'qemu');
  assert.ok(!res.isError, 'missing exitcode must not be treated as failure');
  assert.match(res.content[0].text, /✅/);
});

test('requireElevated result is flagged isError', async () => {
  const s = makeServer();
  s.allowElevated = false;
  const res = await s.migrateGuest('pve1', '100', 'pve2');
  assert.equal(res.isError, true);
});

test('migrateGuest(wait=true) surfaces a failed task as isError', async () => {
  const s = makeServer();
  recordRequests(s, (endpoint, method) => {
    if (endpoint.endsWith('/migrate') && method === 'POST') return 'UPID:pve1:0:0:0:qmigrate:100:root@pam:';
    if (endpoint.includes('/tasks/')) return { status: 'stopped', exitstatus: 'command failed' };
    return {};
  });
  const res = await s.migrateGuest('pve1', '100', 'pve2', 'qemu', false, true);
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.task.success, false);
});

// ---------- whoami ----------
test('whoami returns identity and permissions', async () => {
  const s = makeServer();
  recordRequests(s, () => ({ '/': { 'Sys.Audit': 1 }, '/vms': { 'VM.Audit': 1, 'VM.PowerMgmt': 0 } }));
  const res = await s.whoami();
  assert.match(res.content[0].text, /Sys\.Audit/);
  assert.equal(res.structuredContent.user, s.proxmoxUser);
  assert.ok(res.structuredContent.permissions['/vms']);
});

// ---------- getVMConfig ----------
test('getVMConfig returns raw config in structuredContent', async () => {
  const s = makeServer();
  recordRequests(s, () => ({ cores: 2, memory: 2048, name: 'web', net0: 'virtio=AA,bridge=vmbr0' }));
  const res = await s.getVMConfig('pve1', '100', 'qemu');
  assert.equal(res.structuredContent.config.cores, 2);
  assert.match(res.content[0].text, /cores/);
});

// ---------- migrateGuest ----------
test('migrateGuest sends online flag for qemu and returns UPID', async () => {
  const s = makeServer();
  const calls = recordRequests(s, () => 'UPID:pve1:0:0:0:qmigrate:100:root@pam:');
  const res = await s.migrateGuest('pve1', '100', 'pve2', 'qemu', true, false);
  const post = calls.find(c => c.endpoint.endsWith('/migrate'));
  assert.equal(post.body.target, 'pve2');
  assert.equal(post.body.online, 1);
  assert.equal(res.structuredContent.upid, 'UPID:pve1:0:0:0:qmigrate:100:root@pam:');
});

test('migrateGuest maps online to restart for lxc', async () => {
  const s = makeServer();
  const calls = recordRequests(s, () => 'UPID:pve1:0:0:0:vzmigrate:200:root@pam:');
  await s.migrateGuest('pve1', '200', 'pve2', 'lxc', true, false);
  const post = calls.find(c => c.endpoint.endsWith('/migrate'));
  assert.equal(post.body.restart, 1);
  assert.equal(post.body.online, undefined);
});

test('migrateGuest refuses migrating to the same node', async () => {
  const s = makeServer();
  recordRequests(s, () => 'UPID:x');
  const res = await s.migrateGuest('pve1', '100', 'pve1', 'qemu');
  assert.match(res.content[0].text, /same/i);
});

test('migrateGuest is blocked without elevated permissions', async () => {
  const s = makeServer();
  s.allowElevated = false;
  const calls = recordRequests(s);
  const res = await s.migrateGuest('pve1', '100', 'pve2');
  assert.match(res.content[0].text, /Elevated Permissions/);
  assert.equal(calls.length, 0);
});

// ---------- getGuestIPs ----------
test('getGuestIPs parses guest agent interfaces', async () => {
  const s = makeServer();
  recordRequests(s, () => ({
    result: [
      { name: 'eth0', 'hardware-address': 'AA:BB:CC:DD:EE:FF', 'ip-addresses': [
        { 'ip-address-type': 'ipv4', 'ip-address': '192.168.1.50', prefix: 24 },
      ] },
    ],
  }));
  const res = await s.getGuestIPs('pve1', '100');
  assert.match(res.content[0].text, /192\.168\.1\.50/);
  assert.equal(res.structuredContent.interfaces[0].addresses[0].address, '192.168.1.50');
});

// ---------- convertToTemplate ----------
test('convertToTemplate POSTs to the template endpoint', async () => {
  const s = makeServer();
  const calls = recordRequests(s, () => '');
  const res = await s.convertToTemplate('pve1', '100', 'qemu');
  const post = calls.find(c => c.endpoint.endsWith('/template') && c.method === 'POST');
  assert.ok(post);
  assert.equal(res.structuredContent.template, true);
});

// ---------- setCloudInit ----------
test('setCloudInit sets only provided fields and url-encodes sshkeys', async () => {
  const s = makeServer();
  const calls = recordRequests(s, () => 'UPID:x');
  await s.setCloudInit({ node: 'pve1', vmid: '100', ciuser: 'debian', sshkeys: 'ssh-rsa AAAA test@host' });
  const put = calls.find(c => c.method === 'PUT');
  assert.equal(put.body.ciuser, 'debian');
  assert.equal(put.body.sshkeys, encodeURIComponent('ssh-rsa AAAA test@host'));
  assert.equal(put.body.cipassword, undefined);
});

test('setCloudInit rejects when no fields supplied', async () => {
  const s = makeServer();
  const calls = recordRequests(s);
  const res = await s.setCloudInit({ node: 'pve1', vmid: '100' });
  assert.match(res.content[0].text, /No cloud-init fields/);
  assert.equal(calls.length, 0);
});

// ---------- cluster/resources inventory ----------
test('getVMs uses /cluster/resources in one call', async () => {
  const s = makeServer();
  const calls = recordRequests(s, (endpoint) => {
    if (endpoint === '/cluster/resources?type=vm') {
      return [
        { vmid: '100', name: 'web', type: 'qemu', node: 'pve1', status: 'running', cpu: 0.1, mem: 100, maxmem: 200 },
        { vmid: '200', name: 'ct', type: 'lxc', node: 'pve2', status: 'stopped' },
      ];
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
  const res = await s.getVMs();
  assert.equal(calls.length, 1, 'should be a single cluster call');
  assert.equal(res.structuredContent.count, 2);
  assert.match(res.content[0].text, /web/);
  assert.match(res.content[0].text, /Node: pve2/);
});

test('getVMs falls back to per-node enumeration when cluster call fails', async () => {
  const s = makeServer();
  recordRequests(s, (endpoint) => {
    if (endpoint === '/cluster/resources?type=vm') throw new Error('403');
    if (endpoint === '/nodes') return [{ node: 'pve1' }];
    if (endpoint === '/nodes/pve1/qemu') return [{ vmid: '100', name: 'web', status: 'running' }];
    if (endpoint === '/nodes/pve1/lxc') return [];
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
  const res = await s.getVMs(null, 'qemu');
  assert.equal(res.structuredContent.count, 1);
  assert.equal(res.structuredContent.vms[0].node, 'pve1');
});

// ---------- allowlists ----------
test('node allowlist blocks nodes outside the set', () => {
  const s = makeServer({ PROXMOX_NODE_ALLOWLIST: 'pve1,pve2' });
  assert.equal(s.validateNodeName('pve1'), 'pve1');
  assert.throws(() => s.validateNodeName('pve9'), /not in PROXMOX_NODE_ALLOWLIST/);
});

test('vmid allowlist blocks vmids outside the set', () => {
  const s = makeServer({ PROXMOX_VMID_ALLOWLIST: '100,101' });
  assert.equal(s.validateVMID('100'), '100');
  assert.throws(() => s.validateVMID('500'), /not in PROXMOX_VMID_ALLOWLIST/);
});

// ---------- firewall / pools / ha reads ----------
test('getFirewallRules reads the guest-level endpoint', async () => {
  const s = makeServer();
  const calls = recordRequests(s, () => [{ pos: 0, type: 'in', action: 'ACCEPT', proto: 'tcp', dport: '22' }]);
  const res = await s.getFirewallRules('guest', 'pve1', '100', 'qemu');
  assert.match(calls[0].endpoint, /\/nodes\/pve1\/qemu\/100\/firewall\/rules/);
  assert.equal(res.structuredContent.count, 1);
});

// ---------- protection safety rail ----------
test('deleteVM refuses a protected guest', async () => {
  const s = makeServer();
  const calls = recordRequests(s, (endpoint, method) => {
    if (endpoint.endsWith('/config') && method === 'GET') return { protection: 1 };
    return 'UPID:x';
  });
  const res = await s.deleteVM('pve1', '100', 'qemu');
  assert.match(res.content[0].text, /protected/i);
  assert.ok(!calls.some(c => c.method === 'DELETE'), 'must not issue DELETE for a protected guest');
});

test('deleteVM proceeds when not protected', async () => {
  const s = makeServer();
  const calls = recordRequests(s, (endpoint, method) => {
    if (endpoint.endsWith('/config') && method === 'GET') return { protection: 0 };
    return 'UPID:pve1:0:0:0:qmdestroy:100:root@pam:';
  });
  await s.deleteVM('pve1', '100', 'qemu');
  assert.ok(calls.some(c => c.method === 'DELETE'), 'must issue DELETE');
});

test('getPools lists pools', async () => {
  const s = makeServer();
  recordRequests(s, () => [{ poolid: 'prod', comment: 'production' }]);
  const res = await s.getPools();
  assert.match(res.content[0].text, /prod/);
  assert.equal(res.structuredContent.count, 1);
});

// ---------- MCP resources & prompts ----------
test('readResourcePayload maps URIs to endpoints', async () => {
  const s = makeServer();
  const calls = recordRequests(s, () => [{ ok: true }]);
  await s.readResourcePayload('proxmox://nodes');
  await s.readResourcePayload('proxmox://vms');
  await s.readResourcePayload('proxmox://storage');
  assert.deepEqual(calls.map(c => c.endpoint), [
    '/nodes',
    '/cluster/resources?type=vm',
    '/cluster/resources?type=storage',
  ]);
  await assert.rejects(() => s.readResourcePayload('proxmox://bogus'), /Unknown resource/);
});

test('getPromptText renders known prompts and rejects unknown', () => {
  const s = makeServer();
  assert.match(s.getPromptText('provision_lxc', { distro: 'ubuntu-22.04' }), /ubuntu-22\.04/);
  assert.match(s.getPromptText('health_check'), /health check/i);
  assert.match(s.getPromptText('diagnose_permissions'), /proxmox_whoami/);
  assert.throws(() => s.getPromptText('nope'), /Unknown prompt/);
});
