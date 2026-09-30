/**
 * GF(256) finite field arithmetic.
 *
 * Public field definition:
 *  - Prime field base: GF(2)
 *  - Extension degree: 8, hence GF(2^8) = GF(256)
 *  - Primitive (generator) element: alpha = 2 (binary 0b10 = x)
 *  - Primitive polynomial: p(x) = x^8 + x^4 + x^3 + x^2 + 1
 *    This is 0x11D when written as a 9-bit coefficient vector
 *    (1_0001_1101), and 0x1D in the low 8 bits. This is the same
 *    reduction polynomial used by AES/Rijndael.
 *
 * All tables are derived deterministically from the primitive polynomial;
 * no lookup constants are hard-coded.
 */

export const PRIMITIVE_POLYNOMIAL = 0x11d;
export const FIELD_SIZE = 256;

function buildTables(): { exp: Uint8Array; log: Uint8Array } {
  const exp = new Uint8Array(2 * FIELD_SIZE - 1);
  const log = new Uint8Array(FIELD_SIZE);
  let value = 1;
  for (let i = 0; i < FIELD_SIZE - 1; i++) {
    exp[i] = value;
    log[value] = i;
    // multiply by alpha = x (a left shift), reduce modulo primitive polynomial
    value <<= 1;
    if (value & 0x100) {
      value ^= PRIMITIVE_POLYNOMIAL;
    }
  }
  // duplicate first period to avoid modular indexing during products
  for (let i = FIELD_SIZE - 1; i < 2 * FIELD_SIZE - 2; i++) {
    exp[i] = exp[i - (FIELD_SIZE - 1)]!;
  }
  return { exp, log };
}

const { exp: EXP, log: LOG } = buildTables();

export function add(a: number, b: number): number {
  return a ^ b;
}

export function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

export function div(a: number, b: number): number {
  if (b === 0) throw new Error('GF(256) division by zero');
  if (a === 0) return 0;
  return EXP[(LOG[a]! - LOG[b]! + FIELD_SIZE - 1) % (FIELD_SIZE - 1)]!;
}

export function inverse(a: number): number {
  if (a === 0) throw new Error('GF(256) inverse of zero');
  return EXP[FIELD_SIZE - 1 - LOG[a]!]!;
}

/** Scalar * vector (in place into out). */
export function scaleVec(scalar: number, vec: Uint8Array, out: Uint8Array): Uint8Array {
  if (scalar === 0) {
    out.fill(0);
    return out;
  }
  const logS = LOG[scalar]!;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!;
    out[i] = v === 0 ? 0 : EXP[logS + LOG[v]!]!;
  }
  return out;
}
