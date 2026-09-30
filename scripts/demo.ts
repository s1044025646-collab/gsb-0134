import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths, ensureDirs } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { ErasureService } from '../src/service/erasureService.js';
import { buildFixture, mulberry32 } from '../src/fixtures/generate.js';
import { AppError } from '../src/errors.js';

// Deterministic, fixed UUIDs for repeatability.
let idCounter = 0;
const fixedRng = { uuid: () => `11111111-0000-4000-8000-${String(++idCounter).padStart(12, '0')}` };
let tick = 1_700_000_000_000;
const fixedClock = { now: () => (tick += 1) };

function assert(cond: boolean, message: string): void {
  if (!cond) {
    console.error('DEMO ASSERTION FAILED:', message);
    process.exit(1);
  }
  console.log('  ✓', message);
}

function main(): void {
  const paths = resolvePaths(path.join(process.cwd(), 'demo-data'));
  fs.rmSync(paths.root, { recursive: true, force: true });
  ensureDirs(paths);
  const db = openDatabase(paths.dbFile, fixedClock);
  const service = new ErasureService(db, paths, fixedClock, fixedRng);

  console.log('== GF(256)/RS local erasure-coding demo (deterministic) ==');

  // 1) Chinese-named random content
  const data = buildFixture({ name: 'x', bytes: 401, kind: 'random', seed: 7 });
  const version = service.encodeBuffer(data, '季度数据-报告.bin', { k: 3, m: 2, stripeSize: 16 });
  console.log('encoded', version.id, 'stripes', version.stripe_count, 'tail', version.tail_original_length);

  // 2) discontinuous losses incl. a parity shard
  service.injectFault(version.id, 0, 4, 'lose'); // parity missing in stripe 0
  service.injectFault(version.id, 1, 4, 'lose'); // parity missing in stripe 1 (discontinuous)
  service.injectFault(version.id, 2, 4, 'bitflip'); // detected erasure in stripe 2
  const inspection = service.inspect(version.id);
  assert(inspection.recoverable, 'discontinuous + parity loss still recoverable');

  // 3) idempotent recovery
  const r1 = service.recover(version.id, { idempotencyKey: 'demo-key-1' });
  const r2 = service.recover(version.id, { idempotencyKey: 'demo-key-1' });
  assert(r1.id === r2.id, 'repeat recovery with same key is idempotent');
  const back = fs.readFileSync(r1.output_path!);
  assert(back.equals(data), 'recovered file byte-identical to original');

  // 4) selected subset recovery
  // Shard 4 is erased in the first three stripes (lost or bit-flipped), so a
  // subset that excludes index 4 must succeed.
  const r3 = service.recover(version.id, { selectedIndices: [0, 1, 3] });
  assert(r3.status === 'succeeded', 'recovery using selected subset succeeds');

  // 5) over fault tolerance -> failure, no bogus output
  const v2 = service.encodeBuffer(
    buildFixture({ name: 'z', bytes: 64, kind: 'random', seed: 9 }),
    'small.bin',
    { k: 2, m: 1, stripeSize: 16 },
  );
  service.injectFault(v2.id, 0, 0, 'lose');
  service.injectFault(v2.id, 0, 2, 'lose');
  let caught: AppError | null = null;
  try {
    service.recover(v2.id);
  } catch (e) {
    caught = e as AppError;
  }
  assert(caught?.code === 'OVER_FAULT_TOLERANCE', 'fewer than k shards rejected');
  const tmpLeftovers = fs.readdirSync(paths.tmpDir).filter((f) => f.endsWith('.tmp'));
  assert(tmpLeftovers.length === 0, 'failed recovery leaves no temp file');

  // 6) empty file
  const empty = service.encodeBuffer(Buffer.alloc(0), '空-empty.bin', { k: 2, m: 2, stripeSize: 8 });
  const er = service.recover(empty.id);
  assert(fs.statSync(er.output_path!).size === 0, 'empty file recovers to zero bytes');

  console.log('demo data dir:', paths.root);
  db.close();
  void mulberry32;
}

main();
