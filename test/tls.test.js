import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProxmoxServer } from '../index.js';

// Ensure the required connection env vars exist; TLS vars are managed per test.
process.env.PROXMOX_HOST ??= 'example.invalid';
process.env.PROXMOX_TOKEN_VALUE ??= 'test-token';

function withTlsEnv({ verify, caCert }, fn) {
  const prevVerify = process.env.PROXMOX_VERIFY_TLS;
  const prevCa = process.env.PROXMOX_CA_CERT;
  if (verify === undefined) delete process.env.PROXMOX_VERIFY_TLS;
  else process.env.PROXMOX_VERIFY_TLS = verify;
  if (caCert === undefined) delete process.env.PROXMOX_CA_CERT;
  else process.env.PROXMOX_CA_CERT = caCert;
  try {
    return fn();
  } finally {
    if (prevVerify === undefined) delete process.env.PROXMOX_VERIFY_TLS;
    else process.env.PROXMOX_VERIFY_TLS = prevVerify;
    if (prevCa === undefined) delete process.env.PROXMOX_CA_CERT;
    else process.env.PROXMOX_CA_CERT = prevCa;
  }
}

test('TLS verification is enabled by default (secure by default)', () => {
  withTlsEnv({}, () => {
    const server = new ProxmoxServer();
    assert.equal(server.verifyTls, true);
    assert.equal(server.httpsAgent.options.rejectUnauthorized, true);
  });
});

test('PROXMOX_VERIFY_TLS=false disables verification (homelab opt-out)', () => {
  withTlsEnv({ verify: 'false' }, () => {
    const server = new ProxmoxServer();
    assert.equal(server.verifyTls, false);
    assert.equal(server.httpsAgent.options.rejectUnauthorized, false);
  });
});

test('PROXMOX_VERIFY_TLS=true keeps verification enabled', () => {
  withTlsEnv({ verify: 'true' }, () => {
    const server = new ProxmoxServer();
    assert.equal(server.verifyTls, true);
    assert.equal(server.httpsAgent.options.rejectUnauthorized, true);
  });
});

test('a non-"false" value keeps verification enabled', () => {
  withTlsEnv({ verify: '0' }, () => {
    const server = new ProxmoxServer();
    assert.equal(server.verifyTls, true);
  });
});

test('PROXMOX_CA_CERT loads a custom CA into the agent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-proxmox-ca-'));
  const caPath = join(dir, 'ca.pem');
  const pem = '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n';
  writeFileSync(caPath, pem);
  try {
    withTlsEnv({ caCert: caPath }, () => {
      const server = new ProxmoxServer();
      assert.ok(server.httpsAgent.options.ca, 'ca should be set on the agent');
      assert.equal(server.httpsAgent.options.ca.toString(), pem);
      // CA is supplied and verification stays on by default.
      assert.equal(server.httpsAgent.options.rejectUnauthorized, true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable PROXMOX_CA_CERT path fails fast with a clear error', () => {
  withTlsEnv({ caCert: '/nonexistent/path/to/ca.pem' }, () => {
    assert.throws(
      () => new ProxmoxServer(),
      (error) =>
        /PROXMOX_CA_CERT/.test(error.message) &&
        /could not be read/.test(error.message)
    );
  });
});
