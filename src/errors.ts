export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_SHARDS'
  | 'DUPLICATE_SHARD_INDEX'
  | 'SHARD_INDEX_OUT_OF_RANGE'
  | 'UNEQUAL_SHARD_LENGTH'
  | 'SHARD_DIGEST_MISMATCH'
  | 'SHARD_LOST'
  | 'CROSS_STRIPE_MIX'
  | 'STALE_VERSION'
  | 'SINGULAR_MATRIX'
  | 'OVER_FAULT_TOLERANCE'
  | 'RECOVERY_FAILED'
  | 'IDEMPOTENCY_MISMATCH'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new AppError(code, message, details);
}
