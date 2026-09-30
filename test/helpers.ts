import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../src/db/database.js';
import { resolvePaths, ensureDirs, type AppPaths } from '../src/config.js';
import { ErasureService } from '../src/service/erasureService.js';

let counter = 0;

export function makeHarness(): {
  paths: AppPaths;
  service: ErasureService;
  db: ReturnType<typeof openDatabase>;
  cleanup: () => void;
  reopen: () => ErasureService;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ec-test-${process.pid}-${counter++}-`));
  const paths = resolvePaths(root);
  ensureDirs(paths);
  let db = openDatabase(paths.dbFile);
  let service = new ErasureService(db, paths);
  const state = {
    paths,
    service,
    get db() {
      return db;
    },
    reopen(): ErasureService {
      db.close();
      db = openDatabase(paths.dbFile);
      service = new ErasureService(db, paths);
      state.service = service;
      return service;
    },
    cleanup(): void {
      try {
        db.close();
      } catch {
        // ignore
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return state;
}

export function randomBytes(n: number, seed = 1): Buffer {
  let a = seed >>> 0;
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    buf[i] = ((t ^ (t >>> 14)) >>> 0) & 255;
  }
  return buf;
}
