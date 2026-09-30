import { openDatabase } from './db/database.js';
import { resolvePaths, ensureDirs } from './config.js';
import { startHttpServer, writePidFile } from './api/httpServer.js';

async function main(): Promise<void> {
  const paths = resolvePaths();
  ensureDirs(paths);
  const db = openDatabase(paths.dbFile);
  const listening = await startHttpServer(db, {
    shardsDir: paths.shardsDir,
    tmpDir: paths.tmpDir,
    recoveredDir: paths.recoveredDir,
  });
  writePidFile(paths.runDir, listening.port);
  console.log(`[ec] listening on http://127.0.0.1:${listening.port}`);
  console.log(`[ec] data dir: ${paths.root}`);
  console.log(`[ec] pid file: ${paths.runDir}/server.pid`);

  const shutdown = (): void => {
    listening
      .close()
      .then(() => db.close())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
