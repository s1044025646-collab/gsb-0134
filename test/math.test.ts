import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gf from '../src/math/gf256.js';
import { invert, identity } from '../src/math/matrix.js';
import { generatorMatrix, encode, decode } from '../src/math/rs.js';

function combinations<T>(arr: T[], r: number): T[][] {
  if (r === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i <= arr.length - r; i++) {
    for (const tail of combinations(arr.slice(i + 1), r - 1)) out.push([arr[i]!, ...tail]);
  }
  return out;
}

test('GF(256) field axioms and inverse', () => {
  assert.equal(gf.mul(0, 123), 0);
  assert.equal(gf.mul(1, 200), 200);
  for (let a = 1; a < 256; a++) {
    assert.equal(gf.mul(a, gf.inverse(a)), 1);
    assert.equal(gf.div(a, a), 1);
    for (let b = 1; b < 256; b++) {
      assert.equal(gf.mul(a, b), gf.mul(b, a));
      assert.equal(gf.div(gf.mul(a, b), b), a);
    }
  }
  assert.throws(() => gf.inverse(0));
});

test('matrix inverse of identity is identity', () => {
  assert.deepEqual(invert(identity(3)), identity(3));
});

test('singular matrix detected', () => {
  assert.throws(
    () => invert([[1, 1], [1, 1]]),
    /SINGULAR/,
  );
});

test('systematic generator has identity data rows and Cauchy parity rows', () => {
  const g = generatorMatrix(3, 2);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) assert.equal(g[i]![j], i === j ? 1 : 0);
  }
  // G[3][0] = inv(0 XOR (m+k+0)) = inv(5)
  assert.equal(g[3]![0], gf.inverse(2 + 3));
});

test('exhaustive recoverable subsets for small k,m (byte-exact)', () => {
  let subsets = 0;
  for (let k = 1; k <= 4; k++) {
    for (let m = 1; m <= 4; m++) {
      if (m + 2 * k > 256) continue;
      const n = k + m;
      const len = 5;
      const data = Array.from({ length: k }, (_, i) =>
        Uint8Array.from({ length: len }, (_, j) => (i * 37 + j * 11 + 3) & 255),
      );
      const parity = encode(data, m);
      const all = [...data, ...parity];
      for (const pick of combinations(
        [...Array(n).keys()],
        k,
      )) {
        const got = decode(k, m, pick.map((idx) => ({ index: idx, data: all[idx]! })));
        for (let c = 0; c < k; c++)
          for (let i = 0; i < len; i++) assert.equal(got[c]![i], data[c]![i]);
        subsets++;
      }
    }
  }
  assert.ok(subsets > 100);
});

test('decode rejects duplicate and out-of-range indices', () => {
  const data = [Uint8Array.of(1, 2), Uint8Array.of(3, 4)];
  const all = [...data, ...encode(data, 1)];
  assert.throws(
    () => decode(2, 1, [{ index: 0, data: all[0]! }, { index: 0, data: all[1]! }]),
    /DUPLICATE_SHARD_INDEX/,
  );
  assert.throws(
    () => decode(2, 1, [{ index: 0, data: all[0]! }, { index: 9, data: all[1]! }]),
    /SHARD_INDEX_OUT_OF_RANGE/,
  );
  assert.throws(
    () => decode(2, 1, [{ index: 0, data: all[0]! }]),
    /INSUFFICIENT_SHARDS/,
  );
});
