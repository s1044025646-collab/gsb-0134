import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function openDatabase(dbFile: string, clock: Clock = systemClock): DatabaseSync {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  runMigrations(db, clock);
  return db;
}

/** Applies only migrations not yet recorded; safe and repeatable. */
export function runMigrations(db: DatabaseSync, clock: Clock = systemClock): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );`,
  );
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    const tx = db.prepare(
      'INSERT INTO schema_migrations (id, name, applied_at_ms) VALUES (?, ?, ?)',
    );
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      tx.run(migration.id, migration.name, clock.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
