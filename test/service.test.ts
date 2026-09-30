import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeHarness, randomBytes } from './helpers.js';
import { AppError } from '../src/errors.js';

function combinations<T>(arr: T[], r: number): T[][] {
  if (r === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i <= arr.length - r; i++)
    for (const tail of combinations(arr.slice(i + 1), r - 1)) out.push([arr[i]!, ...tail]);
  return out;
}

test('encode + recover round trip byte-exact with tail padding', () => {
  const h = makeHarness();
  try {
    const data = randomBytes(401, 7);
    const v = h.service.encodeBuffer(data, '中文文件.bin', { k: 3, m: 2, stripeSize: 16 });
    assert.equal(v.stripe_count, Math.ceil(401 / (3 * 16)));
    assert.equal(v.tail_original_length, 401 - (v.stripe_count - 1) * 48);
    const r = h.service.recover(v.id);
    assert.equal(r.status, 'succeeded');
    assert.ok(fs.readFileSync(r.output_path!).equals(data));
  } finally {
    h.cleanup();
  }
});

test('empty file has explicit version and recovers to zero bytes', () => {
  const h = makeHarness();
  try {
    const v = h.service.encodeBuffer(Buffer.alloc(0), '空.bin', { k: 2, m: 2, stripeSize: 8 });
    assert.equal(v.stripe_count, 0);
    assert.equal(v.tail_original_length, 0);
    const r = h.service.recover(v.id);
    assert.equal(fs.statSync(r.output_path!).size, 0);
  } finally {
    h.cleanup();
  }
});

test('all-zero content recovers exactly', () => {
  const h = makeHarness();
  try {
    const data = Buffer.alloc(300);
    const v = h.service.encodeBuffer(data, 'zeros.bin', { k: 3, m: 3, stripeSize: 10 });
    const r = h.service.recover(v.id);
    assert.ok(fs.readFileSync(r.output_path!).equals(data));
  } finally {
    h.cleanup();
  }
});

test('bit flip is detected as an erasure but still recoverable', () => {
  const h = makeHarness();
  try {
    const data = randomBytes(200, 3);
    const v = h.service.encodeBuffer(data, 'r.bin', { k: 2, m: 2, stripeSize: 10 });
    h.service.injectFault(v.id, 0, 0, 'bitflip');
    const insp = h.service.inspect(v.id);
    assert.deepEqual(insp.stripes[0]!.erased, [0]);
    assert.equal(insp.recoverable, true);
    const r = h.service.recover(v.id);
    assert.ok(fs.readFileSync(r.output_path!).equals(data));
  } finally {
    h.cleanup();
  }
});

test('discontinuous losses and missing parity shard recover', () => {
  const h = makeHarness();
  try {
    const data = randomBytes(300, 11);
    const v = h.service.encodeBuffer(data, 'd.bin', { k: 3, m: 3, stripeSize: 12 });
    h.service.injectFault(v.id, 0, 5, 'lose'); // parity
    h.service.injectFault(v.id, 0, 1, 'lose'); // data (discontinuous)
    h.service.injectFault(v.id, 1, 3, 'lose'); // parity
    const r = h.service.recover(v.id);
    assert.ok(fs.readFileSync(r.output_path!).equals(data));
  } finally {
    h.cleanup();
  }
});

test('exhaustive recoverable subsets across small schemes', () => {
  const h = makeHarness();
  try {
    for (const [k, m] of [
      [1, 1],
      [2, 1],
      [2, 2],
      [3, 2],
    ] as const) {
      const data = randomBytes(k * 8 * 3 + 5, k * 13 + m);
      const v = h.service.encodeBuffer(data, `s_${k}_${m}.bin`, { k, m, stripeSize: 8 });
      for (const subset of combinations(
        [...Array(k + m).keys()],
        k,
      )) {
        // apply loss to indices NOT in subset across every stripe
        const excluded = [...Array(k + m).keys()].filter((i) => !subset.includes(i));
        for (const idx of excluded) {
          for (let s = 0; s < v.stripe_count; s++) {
            h.service.injectFault(v.id, s, idx, 'lose');
          }
        }
        const key = `k-${k}-m-${m}-${subset.join('')}`;
        const r = h.service.recover(v.id, { selectedIndices: subset, idempotencyKey: key });
        assert.ok(fs.readFileSync(r.output_path!).equals(data), `k=${k} m=${m} subset=${subset}`);
        // idempotent re-run with same key
        const again = h.service.recover(v.id, {
          selectedIndices: subset,
          idempotencyKey: key,
        });
        assert.equal(again.id, r.id);
        // restore by re-encoding into a fresh version for next subset
        const nv = h.service.encodeBuffer(data, `s_${k}_${m}.bin`, { k, m, stripeSize: 8 });
        (v as any).id = nv.id;
      }
    }
  } finally {
    h.cleanup();
  }
});

test('beyond fault tolerance is rejected and leaves no temp/output', () => {
  const h = makeHarness();
  try {
    const data = randomBytes(64, 5);
    const v = h.service.encodeBuffer(data, 'x.bin', { k: 2, m: 1, stripeSize: 16 });
    h.service.injectFault(v.id, 0, 0, 'lose');
    h.service.injectFault(v.id, 0, 2, 'bitflip');
    assert.throws(
      () => h.service.recover(v.id),
      (e: unknown) => e instanceof AppError && e.code === 'OVER_FAULT_TOLERANCE',
    );
    assert.equal(fs.readdirSync(h.paths.tmpDir).filter((f) => f.endsWith('.tmp')).length, 0);
    const recs = h.service.repo.listRecoveries(v.id, null, 10).rows;
    assert.equal(recs[0]!.status, 'failed');
  } finally {
    h.cleanup();
  }
});

test('duplicate selected indices rejected', () => {
  const h = makeHarness();
  try {
    const v = h.service.encodeBuffer(randomBytes(64, 1), 'x.bin', { k: 2, m: 1, stripeSize: 16 });
    assert.throws(
      () => h.service.recover(v.id, { selectedIndices: [0, 0] }),
      (e: unknown) => e instanceof AppError && e.code === 'DUPLICATE_SHARD_INDEX',
    );
  } finally {
    h.cleanup();
  }
});

test('parameter validation rejects bad schemes', () => {
  const h = makeHarness();
  try {
    assert.throws(
      () => h.service.encodeBuffer(Buffer.alloc(1), 'x', { k: 0, m: 2, stripeSize: 8 }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => h.service.encodeBuffer(Buffer.alloc(1), 'x', { k: 200, m: 200, stripeSize: 8 }),
      (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
  } finally {
    h.cleanup();
  }
});

test('state persists across restart (reopen database)', () => {
  const h = makeHarness();
  try {
    const data = randomBytes(120, 19);
    const v = h.service.encodeBuffer(data, 'persist.bin', { k: 2, m: 2, stripeSize: 16 });
    h.service.injectFault(v.id, 0, 3, 'lose');
    const service2 = h.reopen();
    const again = service2.recover(v.id);
    assert.equal(again.status, 'succeeded');
    assert.ok(fs.readFileSync(again.output_path!).equals(data));
    // migrations are repeatable and do not error on second open
    const service3 = h.reopen();
    assert.ok(service3.repo.getVersion(v.id));
  } finally {
    h.cleanup();
  }
});

test('idempotency key reused across different versions is rejected', () => {
  const h = makeHarness();
  try {
    const a = h.service.encodeBuffer(randomBytes(40, 1), 'a', { k: 2, m: 1, stripeSize: 16 });
    const b = h.service.encodeBuffer(randomBytes(40, 2), 'b', { k: 2, m: 1, stripeSize: 16 });
    h.service.recover(a.id, { idempotencyKey: 'shared' });
    assert.throws(
      () => h.service.recover(b.id, { idempotencyKey: 'shared' }),
      (e: unknown) => e instanceof AppError && e.code === 'IDEMPOTENCY_MISMATCH',
    );
  } finally {
    h.cleanup();
  }
});

test('cross-version shard mix is rejected: a shard carries a version digest', () => {
  const h = makeHarness();
  try {
    const a = h.service.encodeBuffer(randomBytes(80, 1), 'a.bin', { k: 2, m: 1, stripeSize: 16 });
    const b = h.service.encodeBuffer(randomBytes(80, 2), 'b.bin', { k: 2, m: 1, stripeSize: 16 });
    // overwrite version A stripe0 shard0 file with version B's shard0 file
    const aRow = h.service.repo.getShard(a.id, 0, 0)!;
    const bRow = h.service.repo.getShard(b.id, 0, 0)!;
    fs.copyFileSync(bRow.file_path, aRow.file_path);
    // The swapped-in file carries B's version-id digest and is classified as
    // an erasure. Lose another shard so stripe 0 has fewer than k valid shards.
    h.service.injectFault(a.id, 0, 1, 'lose');
    assert.throws(
      () => h.service.recover(a.id),
      (e: unknown) => e instanceof AppError && e.code === 'OVER_FAULT_TOLERANCE',
    );
  } finally {
    h.cleanup();
  }
});
