import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeHarness, randomBytes } from './helpers.js';

test('mid-encode failure rolls back DB transaction (no partial version/shards)', () => {
  const h = makeHarness();
  try {
    const data = randomBytes(400, 5);
    let call = 0;
    const orig = fs.writeFileSync;
    // Fail once after the first few shard files have been written, forcing the
    // encode transaction to roll back while files may remain on disk.
    (fs as any).writeFileSync = function patched(...args: unknown[]) {
      call++;
      if (call === 4) throw new Error('simulated disk failure');
      return (orig as any).apply(fs, args);
    };
    assert.throws(() =>
      h.service.encodeBuffer(data, 'rollback.bin', { k: 3, m: 2, stripeSize: 16 }),
    );
    (fs as any).writeFileSync = orig;

    // No version row and no shard rows should be committed.
    const versions = h.service.repo.listVersions(null, 10).rows;
    assert.equal(versions.length, 0);

    // Database remains usable after the rolled-back transaction.
    const v = h.service.encodeBuffer(data, 'ok.bin', { k: 3, m: 2, stripeSize: 16 });
    const shardRows = h.service.repo.listShards(v.id, null, 200).rows;
    assert.equal(shardRows.length, v.stripe_count * 5);
  } finally {
    h.cleanup();
  }
});

test('migrations are repeatable across multiple opens', () => {
  const h = makeHarness();
  try {
    h.service.encodeBuffer(randomBytes(20, 1), 'a.bin', { k: 2, m: 1, stripeSize: 8 });
    h.reopen();
    h.reopen();
    const rows = h.db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as {
      id: number;
    }[];
    assert.deepEqual(rows.map((r) => r.id), [1, 2]);
  } finally {
    h.cleanup();
  }
});
