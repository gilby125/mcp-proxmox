import test from 'node:test';
import assert from 'node:assert/strict';

import { ProxmoxServer } from '../index.js';

function createServer() {
  process.env.PROXMOX_HOST ??= 'example.invalid';
  process.env.PROXMOX_TOKEN_VALUE ??= 'test-token';
  return new ProxmoxServer();
}

test('validateDiskName accepts Proxmox disk identifiers beyond the previous narrow range', () => {
  const server = createServer();

  assert.equal(server.validateDiskName('scsi30'), 'scsi30');
  assert.equal(server.validateDiskName('unused0'), 'unused0');
  assert.equal(server.validateDiskName('unused255'), 'unused255');
});

test('validateBridgeName accepts dotted bridge identifiers', () => {
  const server = createServer();

  assert.equal(server.validateBridgeName('vmbr0.100'), 'vmbr0.100');
});
