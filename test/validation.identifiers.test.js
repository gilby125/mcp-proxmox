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

test('validateDiskName rejects invalid identifiers', () => {
  const server = createServer();

  assert.throws(() => server.validateDiskName('scsi31'), /out of range/i);
  assert.throws(() => server.validateDiskName('invalid0'), /invalid disk name/i);
  assert.throws(() => server.validateDiskName(''), /required/i);
});

test('validateBridgeName accepts dotted bridge identifiers', () => {
  const server = createServer();

  assert.equal(server.validateBridgeName('vmbr0.100'), 'vmbr0.100');
});

test('validateBridgeName rejects invalid identifiers', () => {
  const server = createServer();

  assert.throws(() => server.validateBridgeName('bridge;injection'), /invalid bridge name/i);
  assert.throws(() => server.validateBridgeName(''), /required/i);
});
