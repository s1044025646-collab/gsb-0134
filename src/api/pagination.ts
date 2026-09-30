import { fail } from '../errors.js';

export interface PageParams {
  limit: number;
  cursor: string | null;
}

export function parsePageParams(url: URL): PageParams {
  const limitRaw = url.searchParams.get('limit') ?? '50';
  const cursor = url.searchParams.get('cursor');
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    fail('VALIDATION_ERROR', 'limit must be an integer between 1 and 200', { limit: limitRaw });
  }
  return { limit, cursor };
}

export function encodeCursor(value: string | number | null): string | null {
  if (value === null) return null;
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null): string | null {
  if (cursor === null) return null;
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    fail('VALIDATION_ERROR', 'invalid cursor', { cursor });
  }
}

export function decodeCursorInt(cursor: string | null): number | null {
  const s = decodeCursor(cursor);
  if (s === null) return null;
  const n = Number(s);
  if (!Number.isInteger(n)) fail('VALIDATION_ERROR', 'invalid numeric cursor', { cursor });
  return n;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
