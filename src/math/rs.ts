import * as gf from './gf256.js';
import { invert, type Matrix } from './matrix.js';

/**
 * Systematic Reed-Solomon generator matrix over GF(256).
 *
 * Layout (n = k + m rows, k columns):
 *   - Rows 0 .. k-1 : k x k identity matrix, so data shard i equals the
 *     i-th data stripe vector (systematic form; shards are *not* copies of
 *     the whole file, each is a fixed-size stripe fragment).
 *   - Rows k .. n-1 : parity rows from a Cauchy construction.
 *
 * Parity coefficient for parity row p (p = 0..m-1), data column c (0..k-1):
 *   x = p,  y = m + k + c
 *   G[k+p][c] = 1 / (x XOR y)
 *
 * Cauchy matrices have the property that every square submatrix of a
 * Cauchy matrix is invertible, hence any k distinct rows of the full
 * (n x k) generator matrix are linearly independent and reconstruct the
 * k data vectors whenever at least k valid, distinct shards survive.
 */
export function generatorMatrix(k: number, m: number): Matrix {
  const n = k + m;
  if (k < 1 || m < 1) throw new Error('k and m must be >= 1');
  // Cauchy construction needs disjoint x and y sets over GF(256).
  // x uses 0..m-1 and y uses m+k..m+2k-1, so m+2k <= 256.
  if (m + 2 * k > 256) throw new Error('Cauchy sets exceed GF(256)');

  const g: Matrix = [];
  for (let i = 0; i < k; i++) {
    const row = new Array<number>(k).fill(0);
    row[i] = 1;
    g.push(row);
  }
  for (let p = 0; p < m; p++) {
    const row: number[] = [];
    const x = p;
    for (let c = 0; c < k; c++) {
      const y = m + k + c;
      const denom = x ^ y; // never zero because the x and y sets are disjoint
      row.push(gf.inverse(denom));
    }
    g.push(row);
  }
  void n;
  return g;
}

/**
 * Compute parity stripe vectors from the k data vectors.
 * dataShards has length k, each a Uint8Array of identical length.
 * Returns m parity Uint8Arrays.
 */
export function encode(dataShards: Uint8Array[], m: number): Uint8Array[] {
  const k = dataShards.length;
  const stripeLen = dataShards[0]?.length ?? 0;
  for (const d of dataShards) {
    if (d.length !== stripeLen) throw new Error('unequal stripe lengths');
  }
  const g = generatorMatrix(k, m);
  const parity: Uint8Array[] = [];
  for (let p = 0; p < m; p++) {
    const coeffs = g[k + p]!;
    const out = new Uint8Array(stripeLen);
    for (let c = 0; c < k; c++) {
      const coeff = coeffs[c]!;
      const src = dataShards[c]!;
      for (let i = 0; i < stripeLen; i++) {
        out[i] = gf.add(out[i]!, gf.mul(coeff, src[i]!));
      }
    }
    parity.push(out);
  }
  return parity;
}

/**
 * Reconstruct the k data vectors from any k available shards.
 * available: array of { index, data } where index is 0..n-1 and data is a
 * stripe vector. Exactly k distinct valid shards are required.
 * Returns the ordered k data vectors.
 */
export function decode(
  k: number,
  m: number,
  available: ReadonlyArray<{ index: number; data: Uint8Array }>,
): Uint8Array[] {
  const n = k + m;
  if (available.length < k) throw new Error('INSUFFICIENT_SHARDS');
  const chosen = available.slice(0, k);
  const seen = new Set<number>();
  for (const s of chosen) {
    if (s.index < 0 || s.index >= n) throw new Error('SHARD_INDEX_OUT_OF_RANGE');
    if (seen.has(s.index)) throw new Error('DUPLICATE_SHARD_INDEX');
    seen.add(s.index);
  }
  const stripeLen = chosen[0]!.data.length;
  for (const s of chosen) {
    if (s.data.length !== stripeLen) throw new Error('UNEQUAL_SHARD_LENGTH');
  }

  const g = generatorMatrix(k, m);
  const sub: Matrix = chosen.map((s) => g[s.index]!.slice());
  const subInv = invert(sub); // throws SINGULAR if dependent (should not happen for Cauchy)

  const result: Uint8Array[] = [];
  for (let c = 0; c < k; c++) {
    const out = new Uint8Array(stripeLen);
    for (let r = 0; r < k; r++) {
      const coeff = subInv[c]![r]!;
      const src = chosen[r]!.data;
      for (let i = 0; i < stripeLen; i++) {
        out[i] = gf.add(out[i]!, gf.mul(coeff, src[i]!));
      }
    }
    result.push(out);
  }
  return result;
}
