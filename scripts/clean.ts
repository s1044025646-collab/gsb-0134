import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths } from '../src/config.js';

/**
 * Removes project-owned data/run artifacts only. Never touches files outside
 * the resolved project data directory.
 */
function main(): void {
  const targets = [
    path.join(process.cwd(), 'dist'),
    process.env.EC_DATA_DIR
      ? path.resolve(process.env.EC_DATA_DIR)
      : path.join(process.cwd(), 'ec-data'),
    path.join(process.cwd(), 'demo-data'),
    path.join(process.cwd(), '.tmp-sanity'),
  ];
  for (const target of targets) {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      console.log('removed', target);
    }
  }
  void resolvePaths;
}

main();
