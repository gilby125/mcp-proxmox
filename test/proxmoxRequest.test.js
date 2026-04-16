import test from 'node:test';
import assert from 'node:assert/strict';

import { ProxmoxServer } from '../index.js';

function createServer() {
  process.env.PROXMOX_HOST ??= 'example.invalid';
  process.env.PROXMOX_TOKEN_VALUE ??= 'test-token';
  return new ProxmoxServer();
}

function mockResponse({ ok, status, bodyText }) {
  return {
    ok,
    status,
    text: async () => bodyText
  };
}

test('proxmoxRequest wraps genuine network errors as failed connections', async () => {
  const server = createServer();
  server.fetch = async () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:8006');
    error.code = 'ECONNREFUSED';
    throw error;
  };

  await assert.rejects(
    server.proxmoxRequest('/version'),
    (error) =>
      error.message.startsWith('Failed to connect to Proxmox:') &&
      /ECONNREFUSED/.test(error.message)
  );
});

test('proxmoxRequest leaves 401 API errors unwrapped', async () => {
  const server = createServer();
  server.fetch = async () => mockResponse({
    ok: false,
    status: 401,
    bodyText: 'authentication failure'
  });

  await assert.rejects(
    server.proxmoxRequest('/version'),
    (error) =>
      error.message.startsWith('Proxmox API error: 401') &&
      !error.message.startsWith('Failed to connect to Proxmox:')
  );
});

test('proxmoxRequest leaves 403 API errors unwrapped', async () => {
  const server = createServer();
  server.fetch = async () => mockResponse({
    ok: false,
    status: 403,
    bodyText: 'permission check failed'
  });

  await assert.rejects(
    server.proxmoxRequest('/nodes/Pve1/lxc/100/status/current'),
    (error) =>
      error.message.startsWith('Proxmox API error: 403') &&
      !error.message.startsWith('Failed to connect to Proxmox:')
  );
});

test('proxmoxRequest skips node hinting for non-node endpoints', async () => {
  const server = createServer();
  let nodesListingRequested = false;
  server.fetch = async (url) => {
    if (url.endsWith('/api2/json/nodes')) {
      nodesListingRequested = true;
    }
    return mockResponse({ ok: false, status: 596, bodyText: 'proxy timeout' });
  };

  await assert.rejects(
    server.proxmoxRequest('/cluster/resources'),
    (error) =>
      error.message.startsWith('Proxmox API error: 596') &&
      !/Did you mean/.test(error.message)
  );

  assert.equal(nodesListingRequested, false);
});

test('proxmoxRequest does not recurse when /nodes itself returns 596', async () => {
  const server = createServer();
  let callCount = 0;
  server.fetch = async () => {
    callCount += 1;
    return mockResponse({ ok: false, status: 596, bodyText: "no such cluster node 'pve1'" });
  };

  await assert.rejects(
    server.proxmoxRequest('/nodes'),
    (error) => error.message.startsWith('Proxmox API error: 596')
  );

  assert.equal(callCount, 1);
});

test('proxmoxRequest suggests the canonical node name on case mismatches', async () => {
  const server = createServer();
  const calls = [];
  server.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/api2/json/nodes')) {
      return mockResponse({
        ok: true,
        status: 200,
        bodyText: JSON.stringify({ data: [{ node: 'Pve1' }, { node: 'Pve2' }] })
      });
    }

    return mockResponse({
      ok: false,
      status: 596,
      bodyText: "no such cluster node 'pve1'"
    });
  };

  await assert.rejects(
    server.proxmoxRequest('/nodes/pve1/lxc/100/status/current'),
    (error) =>
      /Did you mean "Pve1"\?/.test(error.message) &&
      /Known nodes: Pve1, Pve2/.test(error.message) &&
      /case-sensitive/.test(error.message)
  );

  assert.equal(calls.length, 2);
});

test('proxmoxRequest lists known nodes when the requested node is unknown', async () => {
  const server = createServer();
  const calls = [];
  server.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/api2/json/nodes')) {
      return mockResponse({
        ok: true,
        status: 200,
        bodyText: JSON.stringify({
          data: [{ node: 'Pve1' }, { node: 'Pve2' }, { node: 'Pve3' }]
        })
      });
    }

    return mockResponse({
      ok: false,
      status: 596,
      bodyText: "no such cluster node 'completely-fake'"
    });
  };

  await assert.rejects(
    server.proxmoxRequest('/nodes/completely-fake/lxc/100/status/current'),
    (error) =>
      /The node is unknown to the cluster/.test(error.message) &&
      /Known nodes: Pve1, Pve2, Pve3/.test(error.message) &&
      !/Did you mean/.test(error.message)
  );

  assert.equal(calls.length, 2);
});

test('proxmoxRequest falls back to the raw 596 when the nodes probe fails', async () => {
  const server = createServer();
  server.fetch = async (url) => {
    if (url.endsWith('/api2/json/nodes')) {
      return mockResponse({ ok: false, status: 500, bodyText: 'internal' });
    }

    return mockResponse({
      ok: false,
      status: 596,
      bodyText: "no such cluster node 'pve1'"
    });
  };

  await assert.rejects(
    server.proxmoxRequest('/nodes/pve1/lxc/100/status/current'),
    (error) =>
      error.message.startsWith('Proxmox API error: 596') &&
      !/Did you mean/.test(error.message) &&
      !/Known nodes/.test(error.message)
  );
});

test('proxmoxRequest falls back to the raw 596 when the nodes probe JSON is invalid', async () => {
  const server = createServer();
  server.fetch = async (url) => {
    if (url.endsWith('/api2/json/nodes')) {
      return mockResponse({ ok: true, status: 200, bodyText: 'not json {' });
    }

    return mockResponse({
      ok: false,
      status: 596,
      bodyText: "no such cluster node 'pve1'"
    });
  };

  await assert.rejects(
    server.proxmoxRequest('/nodes/pve1/lxc/100/status/current'),
    (error) =>
      error.message.startsWith('Proxmox API error: 596') &&
      !/Did you mean/.test(error.message) &&
      !/Failed to parse/.test(error.message)
  );
});

test('proxmoxRequest preserves raw 596 errors that are not missing-node errors', async () => {
  const server = createServer();
  let callCount = 0;
  server.fetch = async () => {
    callCount += 1;
    return mockResponse({ ok: false, status: 596, bodyText: 'proxy timeout' });
  };

  await assert.rejects(
    server.proxmoxRequest('/nodes/Pve1/lxc/100/status/current'),
    (error) =>
      error.message.startsWith('Proxmox API error: 596 - proxy timeout') &&
      !/Did you mean/.test(error.message) &&
      !/unknown to the cluster/i.test(error.message)
  );

  assert.equal(callCount, 1);
});
