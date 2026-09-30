import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startHttpServer } from '../src/api/httpServer.js';
import { makeHarness, randomBytes } from './helpers.js';
import type { CreatedServer } from '../src/api/httpServer.js';

async function api(
  server: CreatedServer,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('HTTP API end to end: encode, fault, recover, pagination, errors', async () => {
  const h = makeHarness();
  let server: CreatedServer;
  try {
    server = await startHttpServer(h.db, {
      shardsDir: h.paths.shardsDir,
      tmpDir: h.paths.tmpDir,
      recoveredDir: h.paths.recoveredDir,
    });
    const health = await api(server, 'GET', '/health');
    assert.equal(health.status, 200);

    const data = randomBytes(300, 77);
    const enc = await api(server, 'POST', '/api/versions', {
      name: '接口文件.bin',
      dataBase64: data.toString('base64'),
      k: 3,
      m: 2,
      stripeSize: 16,
    });
    assert.equal(enc.status, 201);
    const versionId = enc.json.version.id;

    const bad = await api(server, 'POST', '/api/versions', {
      name: 'x',
      dataBase64: '',
      k: 0,
      m: 2,
      stripeSize: 16,
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'VALIDATION_ERROR');

    await api(server, 'POST', `/api/versions/${versionId}/faults`, {
      stripeIndex: 0,
      shardIndex: 4,
      fault: 'lose',
    });
    const inspect = await api(server, 'GET', `/api/versions/${versionId}/inspect`);
    assert.equal(inspect.json.recoverable, true);

    const r1 = await api(server, 'POST', `/api/versions/${versionId}/recover`, {
      idempotencyKey: 'k1',
    });
    assert.equal(r1.status, 200);
    const r2 = await api(server, 'POST', `/api/versions/${versionId}/recover`, {
      idempotencyKey: 'k1',
    });
    assert.equal(r2.json.recovery.id, r1.json.recovery.id);
    assert.ok(fs.readFileSync(r1.json.recovery.output_path).equals(data));

    // pagination: 15 shards per stripe, request small pages and walk cursor
    let cursor: string | null = null;
    let total = 0;
    do {
      const page = await api(
        server,
        'GET',
        `/api/versions/${versionId}/shards?limit=10${cursor ? `&cursor=${cursor}` : ''}`,
      );
      total += page.json.items.length;
      cursor = page.json.nextCursor;
    } while (cursor);
    const expected = enc.json.version.stripe_count * 5;
    assert.equal(total, expected);

    const invalidLimit = await api(server, 'GET', `/api/versions?limit=9999`);
    assert.equal(invalidLimit.status, 400);

    const notFound = await api(server, 'GET', '/api/versions/does-not-exist');
    assert.equal(notFound.status, 404);

    await server.close();
  } finally {
    h.cleanup();
  }
});

test('server binds only loopback', async () => {
  const h = makeHarness();
  const server = await startHttpServer(h.db, {
    shardsDir: h.paths.shardsDir,
    tmpDir: h.paths.tmpDir,
    recoveredDir: h.paths.recoveredDir,
  });
  try {
    const addr = server.server.address();
    assert.equal(typeof addr, 'object');
    assert.equal((addr as any).address, '127.0.0.1');
  } finally {
    await server.close();
    h.cleanup();
  }
});
