// test/proxmoxRequest.test.js
//
// Unit tests for `proxmoxRequest`'s error-handling behavior on node-scoped
// endpoints. Uses Node's built-in test runner (`node --test`) and
// instance-level fetch injection (`server.fetch = ...`). No new deps.
//
// Node names (Pve1/Pve2/Pve3) and VMID (100) are illustrative only.

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
    text: async () => bodyText,
  };
}

// --- Part 1: narrow the "Failed to connect" wrap ------------------------

test('proxmoxRequest: genuine network error (ECONNREFUSED) still wraps as "Failed to connect"', async () => {
  const server = createServer();
  server.fetch = async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:8006');
    err.code = 'ECONNREFUSED';
    throw err;
  };

  await assert.rejects(
    server.proxmoxRequest('/version'),
    (err) => err.message.startsWith('Failed to connect to Proxmox:') &&
            /ECONNREFUSED/.test(err.message)
  );
});

test('proxmoxRequest: 401 Proxmox API error is NOT wrapped as "Failed to connect"', async () => {
  const server = createServer();
  server.fetch = async () => mockResponse({
    ok: false, status: 401, bodyText: 'authentication failure',
  });

  await assert.rejects(
    server.proxmoxRequest('/version'),
    (err) => err.message.startsWith('Proxmox API error: 401') &&
            !err.message.startsWith('Failed to connect to Proxmox:')
  );
});

test('proxmoxRequest: 403 Proxmox API error is NOT wrapped as "Failed to connect"', async () => {
  const server = createServer();
  server.fetch = async () => mockResponse({
    ok: false, status: 403, bodyText: 'permission check failed',
  });

  await assert.rejects(
    server.proxmoxRequest('/nodes/Pve1/lxc/100/status/current'),
    (err) => err.message.startsWith('Proxmox API error: 403') &&
            !err.message.startsWith('Failed to connect to Proxmox:')
  );
});

// --- Part 2: node-path 596 hint — over-trigger guards -------------------

test('proxmoxRequest: 596 on a non-/nodes endpoint is NOT wrapped and no hint is emitted', async () => {
  const server = createServer();
  let nodesListingRequested = false;
  server.fetch = async (url) => {
    if (url.endsWith('/api2/json/nodes')) nodesListingRequested = true;
    return mockResponse({ ok: false, status: 596, bodyText: 'proxy timeout' });
  };

  await assert.rejects(
    server.proxmoxRequest('/cluster/resources'),
    (err) => err.message.startsWith('Proxmox API error: 596') &&
            !/Did you mean/.test(err.message) &&
            !err.message.startsWith('Failed to connect to Proxmox:')
  );
  assert.equal(nodesListingRequested, false, 'hint logic must not probe /nodes for non-node endpoints');
});

test('proxmoxRequest: 596 on /nodes itself (the listing) does NOT trigger the hint recursion', async () => {
  // Edge case: the endpoint `/nodes` matches /^\/nodes\/([^\/]+)/ only if a
  // sub-path is present. Verify the hint is correctly skipped for the bare
  // /nodes listing so we don't produce an infinite loop on 596.
  const server = createServer();
  let callCount = 0;
  server.fetch = async () => {
    callCount += 1;
    return mockResponse({ ok: false, status: 596, bodyText: 'proxy timeout' });
  };

  await assert.rejects(
    server.proxmoxRequest('/nodes'),
    (err) => err.message.startsWith('Proxmox API error: 596')
  );
  assert.equal(callCount, 1, 'the hint path must not re-fetch /nodes when the request itself is /nodes');
});

// --- Part 2: node-path 596 hint — happy paths ---------------------------

test('proxmoxRequest: 596 on /nodes/{case-variant}/... suggests canonical case', async () => {
  const server = createServer();
  const calls = [];
  server.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/api2/json/nodes')) {
      return mockResponse({
        ok: true, status: 200,
        bodyText: JSON.stringify({ data: [{ node: 'Pve1' }, { node: 'Pve2' }] }),
      });
    }
    return mockResponse({ ok: false, status: 596, bodyText: "no such cluster node 'pve1'" });
  };

  await assert.rejects(
    server.proxmoxRequest('/nodes/pve1/lxc/100/status/current'),
    (err) => /Did you mean "Pve1"\?/.test(err.message) &&
            /Known nodes: Pve1, Pve2/.test(err.message) &&
            /case-sensitive/.test(err.message)
  );
  assert.equal(calls.length, 2, 'exactly one main call + one /nodes probe');
  assert.match(calls[0], /\/nodes\/pve1\/lxc\/100\/status\/current$/);
  assert.match(calls[1], /\/api2\/json\/nodes$/);
});

test('proxmoxRequest: 596 on /nodes/{unknown}/... lists known nodes (no false suggestion)', async () => {
  const server = createServer();
  const calls = [];
  server.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/api2/json/nodes')) {
      return mockResponse({
        ok: true, status: 200,
        bodyText: JSON.stringify({
          data: [{ node: 'Pve1' }, { node: 'Pve2' }, { node: 'Pve3' }],
        }),
      });
    }
    return mockResponse({
      ok: false, status: 596, bodyText: "no such cluster node 'completely-fake'",
    });
  };

  await assert.rejects(
    server.proxmoxRequest('/nodes/completely-fake/lxc/100/status/current'),
    (err) => /The node is unknown to the cluster/.test(err.message) &&
            /Known nodes: Pve1, Pve2, Pve3/.test(err.message) &&
            !/Did you mean/.test(err.message)
  );
  assert.equal(calls.length, 2, 'exactly one main call + one /nodes probe');
  assert.match(calls[0], /\/nodes\/completely-fake\/lxc\/100\/status\/current$/);
  assert.match(calls[1], /\/api2\/json\/nodes$/);
});

test('proxmoxRequest: 596 on /nodes/... when /nodes listing itself fails, falls through to raw 596', async () => {
  const server = createServer();
  server.fetch = async (url) => {
    if (url.endsWith('/api2/json/nodes')) {
      return mockResponse({ ok: false, status: 500, bodyText: 'internal' });
    }
    return mockResponse({ ok: false, status: 596, bodyText: "no such cluster node 'pve1'" });
  };

  await assert.rejects(
    server.proxmoxRequest('/nodes/pve1/lxc/100/status/current'),
    (err) => err.message.startsWith('Proxmox API error: 596') &&
            !/Did you mean/.test(err.message) &&
            !/Known nodes/.test(err.message) &&
            !/\b500\b/.test(err.message) &&
            !/internal/i.test(err.message)
  );
});

test('proxmoxRequest: 596 on /nodes/... when /nodes returns malformed JSON, falls through to raw 596', async () => {
  const server = createServer();
  server.fetch = async (url) => {
    if (url.endsWith('/api2/json/nodes')) {
      return mockResponse({ ok: true, status: 200, bodyText: 'not json {' });
    }
    return mockResponse({ ok: false, status: 596, bodyText: "no such cluster node 'pve1'" });
  };
  await assert.rejects(
    server.proxmoxRequest('/nodes/pve1/lxc/100/status/current'),
    (err) => err.message.startsWith('Proxmox API error: 596') &&
            !/Did you mean/.test(err.message) &&
            !/Failed to parse/.test(err.message)
  );
});

test('proxmoxRequest: 596 on /nodes/{exact-case-match}/... surfaces generic 596 (not "unknown")', async () => {
  const server = createServer();
  const calls = [];
  server.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/api2/json/nodes')) {
      return mockResponse({
        ok: true, status: 200,
        bodyText: JSON.stringify({ data: [{ node: 'Pve1' }, { node: 'Pve2' }] }),
      });
    }
    // Pve1 is a real cluster node, but this specific request still returns 596 —
    // plausible causes: proxy timeout, certificate issue, forwarded-request failure.
    return mockResponse({ ok: false, status: 596, bodyText: 'proxy timeout' });
  };

  await assert.rejects(
    server.proxmoxRequest('/nodes/Pve1/lxc/100/status/current'),
    (err) => /known cluster member/i.test(err.message) &&
            /proxy timeout|certificate issue|forwarded-request/i.test(err.message) &&
            !/Did you mean/.test(err.message) &&
            !/unknown to the cluster/.test(err.message)
  );
  assert.equal(calls.length, 2, 'exactly one main call + one /nodes probe');
});
