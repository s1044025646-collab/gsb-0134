import * as gf from './gf256.js';

/** A matrix over GF(256), stored row-major as rows of byte arrays. */
export type Matrix = number[][];

export function identity(n: number): Matrix {
  const m: Matrix = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n).fill(0);
    row[i] = 1;
    m.push(row);
  }
  return m;
}

export function clone(m: Matrix): Matrix {
  return m.map((row) => row.slice());
}

/**
 * Invert an n x n matrix over GF(256) using Gauss-Jordan elimination.
 * Throws Error('SINGULAR') when the matrix is not invertible.
 */
export function invert(input: Matrix): Matrix {
  const n = input.length;
  const a: Matrix = input.map((row, i) => {
    if (row.length !== n) throw new Error('SINGULAR');
    return [...row];
  });
  const inv = identity(n);

  for (let col = 0; col < n; col++) {
    let pivot = -1;
    for (let r = col; r < n; r++) {
      if (a[r]![col] !== 0) {
        pivot = r;
        break;
      }
    }
    if (pivot === -1) throw new Error('SINGULAR');
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot]!, a[col]!];
      [inv[col], inv[pivot]] = [inv[pivot]!, inv[col]!];
    }
    const diag = a[col]![col]!;
    const invDiag = gf.inverse(diag);
    for (let j = 0; j < n; j++) {
      a[col]![j] = gf.mul(a[col]![j]!, invDiag);
      inv[col]![j] = gf.mul(inv[col]![j]!, invDiag);
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < n; j++) {
        a[r]![j] = gf.add(a[r]![j]!, gf.mul(factor, a[col]![j]!));
        inv[r]![j] = gf.add(inv[r]![j]!, gf.mul(factor, inv[col]![j]!));
      }
    }
  }
  return inv;
}
