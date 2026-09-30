import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Repository, type RecoveryRow, type VersionRow } from '../db/repository.js';
import { systemClock, type Clock } from '../db/database.js';
import { AppError, fail } from '../errors.js';
import { sha256 } from '../crypto/digest.js';
import { encode as rsEncode, decode as rsDecode } from '../math/rs.js';
import { encodeShardFile, parseShardFile } from '../codec/shardFile.js';

export interface Rng {
  uuid(): string;
}
export const systemRng: Rng = { uuid: () => randomUUID() };

export interface EncodingParams {
  k: number;
  m: number;
  stripeSize: number;
}

function validateParams(p: EncodingParams): void {
  if (!Number.isInteger(p.k) || !Number.isInteger(p.m) || !Number.isInteger(p.stripeSize)) {
    fail('VALIDATION_ERROR', 'k, m and stripeSize must be integers', p);
  }
  if (p.k < 1 || p.m < 1) fail('VALIDATION_ERROR', 'k and m must be >= 1', p);
  if (p.stripeSize < 1 || p.stripeSize > 1 << 24)
    fail('VALIDATION_ERROR', 'stripeSize must be between 1 and 16777216', p);
  if (p.m + 2 * p.k > 256) fail('VALIDATION_ERROR', 'm + 2k must be <= 256 (GF(256) limit)', p);
}

export class ErasureService {
  readonly repo: Repository;
  constructor(
    private readonly db: DatabaseSync,
    private readonly dirs: {
      shardsDir: string;
      tmpDir: string;
      recoveredDir: string;
    },
    private readonly clock: Clock = systemClock,
    private readonly rng: Rng = systemRng,
  ) {
    this.repo = new Repository(db);
  }

  // ---------------------------------------------------------------- encoding
  encodeBuffer(data: Buffer, originalName: string, params: EncodingParams): VersionRow {
    validateParams(params);
    const { k, m, stripeSize } = params;
    const now = this.clock.now();
    const versionId = this.rng.uuid();
    const versionIdDigestHex = sha256(Buffer.from(versionId, 'utf8'));
    const versionIdDigest = Buffer.from(versionIdDigestHex, 'hex');
    const originalDigest = sha256(data);
    const totalSize = data.length;

    const bytesPerStripe = k * stripeSize;
    // Empty file: zero stripes, no shards, but an explicit version row.
    const stripeCount = Math.ceil(totalSize / bytesPerStripe);
    // Original (unpadded) bytes present in the final stripe, before zero fill.
    const tailOriginalLength =
      totalSize === 0 ? 0 : totalSize - (stripeCount - 1) * bytesPerStripe;

    const scheme = this.repo.getOrCreateScheme(k, m, stripeSize, now);
    const versionDir = path.join(this.dirs.shardsDir, versionId);
    fs.mkdirSync(versionDir, { recursive: true });

    this.db.exec('BEGIN');
    try {
      this.repo.insertVersion({
        id: versionId,
        scheme_id: scheme.id,
        original_name: originalName,
        original_size: totalSize,
        original_digest: originalDigest,
        stripe_count: stripeCount,
        tail_original_length: tailOriginalLength,
        status: 'encoded',
        created_at_ms: now,
      });

      for (let s = 0; s < stripeCount; s++) {
        const start = s * bytesPerStripe;
        const len = s === stripeCount - 1 ? tailOriginalLength : stripeSize;
        const dataVecs: Buffer[] = [];
        for (let d = 0; d < k; d++) {
          const vec = Buffer.alloc(stripeSize);
          const chunk = data.subarray(start + d * stripeSize, start + (d + 1) * stripeSize);
          chunk.copy(vec, 0); // tail beyond EOF stays as zero fill
          dataVecs.push(vec);
        }
        const parityVecs = rsEncode(dataVecs.map((v) => new Uint8Array(v)), m).map(
          (v) => Buffer.from(v),
        );
        const all = [...dataVecs, ...parityVecs];
        for (let idx = 0; idx < all.length; idx++) {
          const payload = all[idx]!;
          const isData = idx < k;
          const file = encodeShardFile({
            stripeIndex: s,
            shardIndex: idx,
            kind: isData ? 'data' : 'parity',
            payload,
            versionIdDigest,
          });
          const fileName = `s${s}_i${idx}.shard`;
          const filePath = path.join(versionDir, fileName);
          fs.writeFileSync(filePath, file);
          this.repo.upsertShard({
            version_id: versionId,
            stripe_index: s,
            shard_index: idx,
            kind: isData ? 'data' : 'parity',
            payload_length: stripeSize,
            version_digest: versionIdDigestHex,
            digest: sha256(file),
            file_path: filePath,
            state: 'present',
            fault: null,
            updated_at_ms: now,
          });
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.repo.getVersion(versionId)!;
  }

 // --------------------------------------------------------------- fault inj
  injectFault(
    versionId: string,
    stripeIndex: number,
    shardIndex: number,
    fault: 'lose' | 'bitflip',
  ): { state: string } {
    const version = this.requireVersion(versionId);
    const row = this.repo.getShard(versionId, stripeIndex, shardIndex);
    if (!row) fail('NOT_FOUND', 'shard not found', { stripeIndex, shardIndex });
    const now = this.clock.now();

    if (fault === 'lose') {
      if (fs.existsSync(row.file_path)) fs.rmSync(row.file_path, { force: true });
      this.repo.setShardState(versionId, stripeIndex, shardIndex, 'lost', 'lose', now);
    } else {
      if (!fs.existsSync(row.file_path)) fail('SHARD_LOST', 'shard already lost', row);
      const buf = fs.readFileSync(row.file_path);
      const pos = (stripeIndex * 131 + shardIndex * 17 + 7) % buf.length;
      buf[pos] = buf[pos]! ^ 0xff;
      fs.writeFileSync(row.file_path, buf);
      this.repo.setShardState(versionId, stripeIndex, shardIndex, 'corrupt', 'bitflip', now);
    }
    void version;
    return { state: fault === 'lose' ? 'lost' : 'corrupt' };
  }

  // ------------------------------------------------------------- inspection
  /** Read and validate a single shard, returning parsed payload or an erasure. */
  private readShard(
    version: VersionRow,
    stripeIndex: number,
    shardIndex: number,
  ): { ok: true; payload: Buffer } | { ok: false; reason: string } {
    const row = this.repo.getShard(version.id, stripeIndex, shardIndex);
    if (!row) return { ok: false, reason: 'unknown_shard' };
    if (row.state !== 'present' || !fs.existsSync(row.file_path)) {
      return { ok: false, reason: 'lost' };
    }
    const raw = fs.readFileSync(row.file_path);
    try {
      const parsed = parseShardFile(raw);
      if (parsed.stripeIndex !== stripeIndex || parsed.shardIndex !== shardIndex) {
        return { ok: false, reason: 'header_index_mismatch' };
      }
      const expectedVersionDigest = Buffer.from(row.version_digest, 'hex');
      if (!parsed.versionIdDigest.equals(expectedVersionDigest)) {
        return { ok: false, reason: 'STALE_VERSION' };
      }
      return { ok: true, payload: parsed.payload };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, reason: err.code };
      throw err;
    }
  }

  /**
   * Inspect all shards of a version and report per-shard validity. Detected
   * corrupt/lost shards are classified as erasures.
   */
  inspect(versionId: string): {
    version: VersionRow;
    stripes: { stripeIndex: number; available: number[]; erased: number[] }[];
    recoverable: boolean;
  } {
    const version = this.requireVersion(versionId);
    const scheme = this.repo.getScheme(version.scheme_id)!;
    const stripes = [];
    let recoverable = true;
    for (let s = 0; s < version.stripe_count; s++) {
      const available: number[] = [];
      const erased: number[] = [];
      for (let idx = 0; idx < scheme.k + scheme.m; idx++) {
        const r = this.readShard(version, s, idx);
        if (r.ok) available.push(idx);
        else erased.push(idx);
      }
      if (available.length < scheme.k) recoverable = false;
      stripes.push({ stripeIndex: s, available, erased });
    }
    return { version, stripes, recoverable };
  }

  // ---------------------------------------------------------------- recovery
  /**
   * Recover the original file. selectedIndices (optional) restricts which
   * shard indices may be used globally; exactly k distinct valid shards are
   * required per stripe. Recovery writes a temp file and only publishes it
   * atomically after every stripe decodes and the full digest matches.
   */
  recover(
    versionId: string,
    opts: { idempotencyKey?: string; selectedIndices?: number[] } = {},
  ): RecoveryRow {
    const version = this.requireVersion(versionId);
    const scheme = this.repo.getScheme(version.scheme_id)!;
    const { k, m, stripe_size: stripeSize } = scheme;
    const now = this.clock.now();

    if (opts.idempotencyKey) {
      const prior = this.repo.getRecoveryByIdempotency(opts.idempotencyKey);
      if (prior) {
        if (prior.version_id !== versionId) {
          fail('IDEMPOTENCY_MISMATCH', 'idempotency key used with a different version', {
            priorVersion: prior.version_id,
          });
        }
        return prior;
      }
    }

    let selected = opts.selectedIndices;
    if (selected) {
      if (new Set(selected).size !== selected.length) {
        fail('DUPLICATE_SHARD_INDEX', 'selected shard indices contain duplicates', selected);
      }
      for (const idx of selected) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= k + m) {
          fail('SHARD_INDEX_OUT_OF_RANGE', 'selected index out of range', { idx, n: k + m });
        }
      }
    }

    const recoveryId = this.rng.uuid();
    this.repo.insertRecovery({
      id: recoveryId,
      version_id: versionId,
      idempotency_key: opts.idempotencyKey ?? null,
      status: 'running',
      selected: selected ?? [],
      missing: [],
      created_at_ms: now,
    });

    let tmpPath: string | null = null;
    try {
      const allowed = new Set(selected ?? Array.from({ length: k + m }, (_, i) => i));
      const chunks: Buffer[] = [];
      const missing: number[] = [];

      for (let s = 0; s < version.stripe_count; s++) {
        const present: { index: number; data: Uint8Array }[] = [];
        for (const idx of allowed) {
          const r = this.readShard(version, s, idx);
          if (r.ok) present.push({ index: idx, data: new Uint8Array(r.payload) });
          else missing.push(idx);
        }
        if (present.length < k) {
          fail('OVER_FAULT_TOLERANCE', `stripe ${s} has fewer than k valid shards`, {
            stripe: s,
            available: present.length,
            required: k,
          });
        }
        let decoded: Uint8Array[];
        try {
          decoded = rsDecode(k, m, present);
        } catch (err) {
          if (err instanceof Error && err.message === 'SINGULAR') {
            fail('SINGULAR_MATRIX', 'selected shards produced a singular matrix');
          }
          throw err;
        }
        // Concatenate the k data vectors of this stripe.
        const stripeBuf = Buffer.concat(decoded.map((v) => Buffer.from(v)));
        // Only the final stripe may be zero-padded; keep exactly its
        // recorded original byte count (0 for an empty-file version).
        const len = s === version.stripe_count - 1 ? version.tail_original_length : stripeBuf.length;
        chunks.push(stripeBuf.subarray(0, len));
      }

      const recovered = Buffer.concat(chunks);
      const recoveredDigest = sha256(recovered);
      if (recoveredDigest !== version.original_digest || recovered.length !== version.original_size) {
        fail('RECOVERY_FAILED', 'recovered digest/length does not match the recorded original', {
          expected: version.original_digest,
          actual: recoveredDigest,
        });
      }

      // Temp file inside the project, atomic publish via rename.
      const safeName = version.original_name.replace(/[\\/:*?"<>|]/g, '_');
      const finalPath = path.join(this.dirs.recoveredDir, `${versionId}__${safeName}`);
      tmpPath = path.join(
        this.dirs.tmpDir,
        `${recoveryId}.rec.tmp`,
      );
      fs.mkdirSync(this.dirs.tmpDir, { recursive: true });
      fs.mkdirSync(this.dirs.recoveredDir, { recursive: true });
      fs.writeFileSync(tmpPath, recovered);
      fs.renameSync(tmpPath, finalPath); // atomic on the same volume
      tmpPath = null;

      const doneAt = this.clock.now();
      this.repo.completeRecovery(recoveryId, {
        status: 'succeeded',
        recovered_digest: recoveredDigest,
        output_path: finalPath,
        completed_at_ms: doneAt,
      });
      this.db
        .prepare('UPDATE recoveries SET missing_shard_indices=? WHERE id=?')
        .run(JSON.stringify([...new Set(missing)].sort((a, b) => a - b)), recoveryId);
      return this.repo.getRecovery(recoveryId)!;
    } catch (err) {
      if (tmpPath && fs.existsSync(tmpPath)) {
        fs.rmSync(tmpPath, { force: true });
      }
      const appErr = err instanceof AppError ? err : new AppError('INTERNAL', String(err));
      this.repo.completeRecovery(recoveryId, {
        status: 'failed',
        error_code: appErr.code,
        error_message: appErr.message,
        completed_at_ms: this.clock.now(),
      });
      throw appErr;
    }
  }

  requireVersion(versionId: string): VersionRow {
    return this.repo.getVersion(versionId) ?? fail('NOT_FOUND', 'version not found', { versionId });
  }
}
