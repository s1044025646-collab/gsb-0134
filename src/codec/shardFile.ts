import { AppError } from '../errors.js';
import { sha256 } from '../crypto/digest.js';

/**
 * Self-describing shard container (little-endian):
 *
 *   offset  size  field
 *   0       4     magic "ECSD"
 *   4       1     format version (1)
 *   5       4     stripe index (u32)
 *   9       2     shard index (u16)
 *   11      1     kind (0=data, 1=parity)
 *   12      4     payload length (u32)
 *   16      32    SHA-256 over [versionId utf8 bytes]
 *   48      N     payload bytes
 *   48+N    32    SHA-256 over bytes [0 .. 48+N)  (integrity trailer)
 *
 * The trailer covers the entire header, version-id hash and payload, so any
 * bit flip in a shard file is detected before the shard is treated as valid.
 */
export const SHARD_MAGIC = Buffer.from('ECSD', 'ascii');
export const SHARD_FORMAT_VERSION = 1;
const HEADER_LEN = 48;
const TRAILER_LEN = 32;

export interface ParsedShard {
  stripeIndex: number;
  shardIndex: number;
  kind: 'data' | 'parity';
  payload: Buffer;
  versionIdDigest: Buffer;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

export function encodeShardFile(args: {
  stripeIndex: number;
  shardIndex: number;
  kind: 'data' | 'parity';
  payload: Buffer;
  versionIdDigest: Buffer;
}): Buffer {
  if (args.versionIdDigest.length !== 32) throw new Error('version id digest must be 32 bytes');
  const header = Buffer.concat([
    SHARD_MAGIC,
    Buffer.from([SHARD_FORMAT_VERSION]),
    u32(args.stripeIndex),
    Buffer.from([args.shardIndex & 0xff, (args.shardIndex >> 8) & 0xff]),
    Buffer.from([args.kind === 'data' ? 0 : 1]),
    u32(args.payload.length),
    Buffer.from(args.versionIdDigest),
  ]);
  if (header.length !== HEADER_LEN) throw new Error('bad header length');
  const body = Buffer.concat([header, args.payload]);
  const trailer = Buffer.from(sha256(new Uint8Array(body)), 'hex');
  return Buffer.concat([body, trailer]);
}

export function parseShardFile(raw: Buffer): ParsedShard {
  if (raw.length < HEADER_LEN + TRAILER_LEN) {
    throw new AppError('SHARD_DIGEST_MISMATCH', 'shard file truncated');
  }
  if (!raw.subarray(0, 4).equals(SHARD_MAGIC)) {
    throw new AppError('SHARD_DIGEST_MISMATCH', 'shard magic mismatch');
  }
  if (raw[4] !== SHARD_FORMAT_VERSION) {
    throw new AppError('SHARD_DIGEST_MISMATCH', 'unsupported shard format version');
  }
  const bodyEnd = raw.length - TRAILER_LEN;
  const expectedTrailer = Buffer.from(sha256(new Uint8Array(raw.subarray(0, bodyEnd))), 'hex');
  if (!expectedTrailer.equals(raw.subarray(bodyEnd))) {
    throw new AppError('SHARD_DIGEST_MISMATCH', 'shard integrity digest mismatch (bit flip detected)');
  }
  const stripeIndex = raw.readUInt32LE(5);
  const shardIndex = raw.readUInt16LE(9);
  const kindByte = raw[11]!;
  if (kindByte > 1) {
    throw new AppError('SHARD_DIGEST_MISMATCH', 'invalid shard kind');
  }
  const payloadLength = raw.readUInt32LE(12);
  if (HEADER_LEN + payloadLength + TRAILER_LEN !== raw.length) {
    throw new AppError('SHARD_DIGEST_MISMATCH', 'shard length field inconsistent');
  }
  return {
    stripeIndex,
    shardIndex,
    kind: kindByte === 0 ? 'data' : 'parity',
    payload: Buffer.from(raw.subarray(HEADER_LEN, HEADER_LEN + payloadLength)),
    versionIdDigest: Buffer.from(raw.subarray(16, 48)),
  };
}

export { HEADER_LEN, TRAILER_LEN };
