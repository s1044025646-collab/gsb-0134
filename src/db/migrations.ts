export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS encoding_schemes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  k INTEGER NOT NULL,
  m INTEGER NOT NULL,
  stripe_size INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(k, m, stripe_size)
);

CREATE TABLE IF NOT EXISTS data_versions (
  id TEXT PRIMARY KEY,
  scheme_id INTEGER NOT NULL REFERENCES encoding_schemes(id),
  original_name TEXT NOT NULL,
  original_size INTEGER NOT NULL,
  original_digest TEXT NOT NULL,
  stripe_count INTEGER NOT NULL,
  tail_original_length INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'encoded',
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id TEXT NOT NULL REFERENCES data_versions(id),
  stripe_index INTEGER NOT NULL,
  shard_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_length INTEGER NOT NULL,
  digest TEXT NOT NULL,
  file_path TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'present',
  fault TEXT,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(version_id, stripe_index, shard_index)
);
CREATE INDEX IF NOT EXISTS idx_shards_version ON shards(version_id);
CREATE INDEX IF NOT EXISTS idx_shards_lookup ON shards(version_id, stripe_index);

CREATE TABLE IF NOT EXISTS recoveries (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES data_versions(id),
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL,
  selected_shard_indices TEXT NOT NULL,
  missing_shard_indices TEXT NOT NULL,
  recovered_digest TEXT,
  output_path TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_recoveries_version ON recoveries(version_id);
`,
  },
  {
    id: 2,
    name: 'shard_version_digest',
    sql: `
ALTER TABLE shards ADD COLUMN version_digest TEXT NOT NULL DEFAULT '';
`,
  },
];
