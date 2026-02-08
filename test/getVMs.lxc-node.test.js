import test from 'node:test';
import assert from 'node:assert/strict';

import { ProxmoxServer } from '../index.js';

test('getVMs assigns LXC node from the iterated node (not VM payload)', async () => {
  process.env.PROXMOX_HOST ??= 'example.invalid';
  process.env.PROXMOX_TOKEN_VALUE ??= 'test-token';

  const server = new ProxmoxServer();

  server.proxmoxRequest = async (endpoint) => {
    if (endpoint === '/nodes') {
      return [{ node: 'pve1' }];
    }
    if (endpoint === '/nodes/pve1/lxc') {
      return [
        { vmid: '200', name: 'ct200', status: 'running', node: 'wrong-node' },
      ];
    }
    throw new Error(`Unexpected endpoint in test: ${endpoint}`);
  };

  const result = await server.getVMs(null, 'lxc');
  const text = result?.content?.[0]?.text ?? '';

  assert.match(text, /Node:\s+pve1/);
  assert.doesNotMatch(text, /wrong-node/);
});
