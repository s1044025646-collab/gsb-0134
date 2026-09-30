import type { DatabaseSync } from 'node:sqlite';

export interface SchemeRow {
  id: number;
  k: number;
  m: number;
  stripe_size: number;
  created_at_ms: number;
}
export interface VersionRow {
  id: string;
  scheme_id: number;
  original_name: string;
  original_size: number;
  original_digest: string;
  stripe_count: number;
  tail_original_length: number;
  status: string;
  created_at_ms: number;
}
export interface ShardRow {
  id: number;
  version_id: string;
  stripe_index: number;
  shard_index: number;
  kind: string;
  payload_length: number;
  version_digest: string;
  digest: string;
  file_path: string;
  state: string;
  fault: string | null;
  updated_at_ms: number;
}

export class Repository {
  constructor(private readonly db: DatabaseSync) {}

  getOrCreateScheme(k: number, m: number, stripeSize: number, now: number): SchemeRow {
    const existing = this.db
      .prepare('SELECT * FROM encoding_schemes WHERE k=? AND m=? AND stripe_size=?')
      .get(k, m, stripeSize) as unknown as SchemeRow | undefined;
    if (existing) return existing;
    const info = this.db
      .prepare('INSERT INTO encoding_schemes (k,m,stripe_size,created_at_ms) VALUES (?,?,?,?)')
      .run(k, m, stripeSize, now);
    return this.db
      .prepare('SELECT * FROM encoding_schemes WHERE id=?')
      .get(Number(info.lastInsertRowid)) as unknown as SchemeRow;
  }

  getScheme(id: number): SchemeRow | undefined {
    return cast<SchemeRow | undefined>(this.db.prepare('SELECT * FROM encoding_schemes WHERE id=?').get(id));
  }

  insertVersion(v: VersionRow): void {
    this.db
      .prepare(
        `INSERT INTO data_versions
         (id,scheme_id,original_name,original_size,original_digest,stripe_count,tail_original_length,status,created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        v.id,
        v.scheme_id,
        v.original_name,
        v.original_size,
        v.original_digest,
        v.stripe_count,
        v.tail_original_length,
        v.status,
        v.created_at_ms,
      );
  }

  getVersion(id: string): VersionRow | undefined {
    return cast<VersionRow | undefined>(this.db.prepare('SELECT * FROM data_versions WHERE id=?').get(id));
  }

  listVersions(afterId: string | null, limit: number): { rows: VersionRow[]; next: string | null } {
    const rows = (this.db
      .prepare(
        `SELECT * FROM data_versions
         ${afterId ? 'WHERE id > ?' : ''}
         ORDER BY id ASC LIMIT ?`,
      )
      .all(...(afterId ? [afterId, limit] : [limit])) as unknown as VersionRow[]);
    return { rows, next: rows.length === limit ? (rows[rows.length - 1]!.id as string) : null };
  }

  upsertShard(s: Omit<ShardRow, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO shards
           (version_id,stripe_index,shard_index,kind,payload_length,version_digest,digest,file_path,state,fault,updated_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(version_id,stripe_index,shard_index) DO UPDATE SET
           payload_length=excluded.payload_length,
           version_digest=excluded.version_digest,
           digest=excluded.digest,
           file_path=excluded.file_path,
           state=excluded.state,
           fault=excluded.fault,
           updated_at_ms=excluded.updated_at_ms`,
      )
      .run(
        s.version_id,
        s.stripe_index,
        s.shard_index,
        s.kind,
        s.payload_length,
        s.version_digest,
        s.digest,
        s.file_path,
        s.state,
        s.fault,
        s.updated_at_ms,
      );
  }

  getShard(versionId: string, stripeIndex: number, shardIndex: number): ShardRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM shards WHERE version_id=? AND stripe_index=? AND shard_index=?',
      )
      .get(versionId, stripeIndex, shardIndex) as unknown as ShardRow | undefined;
  }

  listShards(
    versionId: string,
    afterId: number | null,
    limit: number,
  ): { rows: ShardRow[]; next: number | null } {
    const rows = this.db
      .prepare(
        `SELECT * FROM shards WHERE version_id=?
         ${afterId ? 'AND id > ?' : ''}
         ORDER BY id ASC LIMIT ?`,
      )
      .all(...(afterId ? [versionId, afterId, limit] : [versionId, limit])) as unknown as ShardRow[];
    return { rows, next: rows.length === limit ? (rows[rows.length - 1]!.id as number) : null };
  }

  setShardState(
    versionId: string,
    stripeIndex: number,
    shardIndex: number,
    state: string,
    fault: string | null,
    now: number,
  ): void {
    this.db
      .prepare(
        'UPDATE shards SET state=?, fault=?, updated_at_ms=? WHERE version_id=? AND stripe_index=? AND shard_index=?',
      )
      .run(state, fault, now, versionId, stripeIndex, shardIndex);
  }

  insertRecovery(r: {
    id: string;
    version_id: string;
    idempotency_key: string | null;
    status: string;
    selected: number[];
    missing: number[];
    created_at_ms: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO recoveries
         (id,version_id,idempotency_key,status,selected_shard_indices,missing_shard_indices,created_at_ms)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        r.id,
        r.version_id,
        r.idempotency_key,
        r.status,
        JSON.stringify(r.selected),
        JSON.stringify(r.missing),
        r.created_at_ms,
      );
  }

  getRecoveryByIdempotency(key: string) {
    return this.db
      .prepare('SELECT * FROM recoveries WHERE idempotency_key=?')
      .get(key) as unknown as RecoveryRow | undefined;
  }

  getRecovery(id: string) {
    return cast<RecoveryRow | undefined>(this.db.prepare('SELECT * FROM recoveries WHERE id=?').get(id));
  }

  completeRecovery(
    id: string,
    fields: {
      status: string;
      recovered_digest?: string | null;
      output_path?: string | null;
      error_code?: string | null;
      error_message?: string | null;
      completed_at_ms: number;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE recoveries SET status=?, recovered_digest=?, output_path=?, error_code=?,
           error_message=?, completed_at_ms=? WHERE id=?`,
      )
      .run(
        fields.status,
        fields.recovered_digest ?? null,
        fields.output_path ?? null,
        fields.error_code ?? null,
        fields.error_message ?? null,
        fields.completed_at_ms,
        id,
      );
  }

  listRecoveries(
    versionId: string,
    afterId: string | null,
    limit: number,
  ): { rows: RecoveryRow[]; next: string | null } {
    const rows = this.db
      .prepare(
        `SELECT * FROM recoveries WHERE version_id=?
         ${afterId ? 'AND id > ?' : ''}
         ORDER BY id ASC LIMIT ?`,
      )
      .all(...(afterId ? [versionId, afterId, limit] : [versionId, limit])) as unknown as RecoveryRow[];
    return { rows, next: rows.length === limit ? (rows[rows.length - 1]!.id as string) : null };
  }
}

export interface RecoveryRow {
  id: string;
  version_id: string;
  idempotency_key: string | null;
  status: string;
  selected_shard_indices: string;
  missing_shard_indices: string;
  recovered_digest: string | null;
  output_path: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at_ms: number;
  completed_at_ms: number | null;
}

function cast<T>(value: unknown): T {
  return value as T;
}
