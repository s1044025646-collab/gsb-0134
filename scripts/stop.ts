import fs from 'node:fs';
import path from 'node:path';

/**
 * Stops only the server whose PID this project recorded in its own run
 * directory. Never enumerates or kills unrelated processes.
 */
function main(): void {
  const root = path.resolve(process.env.EC_DATA_DIR ?? path.join(process.cwd(), 'ec-data'));
  const pidFile = path.join(root, 'run', 'server.pid');
  if (!fs.existsSync(pidFile)) {
    console.log('no pid file at', pidFile);
    return;
  }
  const lines = fs.readFileSync(pidFile, 'utf8').trim().split(/\r?\n/);
  const pid = Number(lines[0]);
  if (!Number.isInteger(pid) || pid <= 0) {
    console.error('invalid pid file');
    process.exit(1);
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log('sent SIGTERM to project server pid', pid);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      console.log('process', pid, 'not running');
    } else {
      throw err;
    }
  }
  fs.rmSync(pidFile, { force: true });
}

main();
