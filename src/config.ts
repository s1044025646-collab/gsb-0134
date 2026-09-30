import path from 'node:path';
import fs from 'node:fs';

export interface AppPaths {
  root: string;
  dbFile: string;
  shardsDir: string;
  tmpDir: string;
  recoveredDir: string;
  sourcesDir: string;
  runDir: string;
}

export function resolvePaths(root?: string): AppPaths {
  const resolvedRoot = path.resolve(root ?? process.env.EC_DATA_DIR ?? path.join(process.cwd(), 'ec-data'));
  return {
    root: resolvedRoot,
    dbFile: path.join(resolvedRoot, 'erasure.db'),
    shardsDir: path.join(resolvedRoot, 'shards'),
    tmpDir: path.join(resolvedRoot, 'tmp'),
    recoveredDir: path.join(resolvedRoot, 'recovered'),
    sourcesDir: path.join(resolvedRoot, 'sources'),
    runDir: path.join(resolvedRoot, 'run'),
  };
}

export function ensureDirs(paths: AppPaths): void {
  for (const dir of [
    paths.root,
    paths.shardsDir,
    paths.tmpDir,
    paths.recoveredDir,
    paths.sourcesDir,
    paths.runDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
