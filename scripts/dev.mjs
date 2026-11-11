// Dev runner: builds shared once, then runs shared (tsc watch), server (tsx watch, :3000) and
// web (vite, :5173). Stopping it stops every child process tree (on Windows, killing the
// cmd.exe wrapper alone would leave vite/node orphaned and holding the ports).
import { spawn, spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';
const opts = { stdio: ['ignore', 'inherit', 'inherit'], shell: isWindows, detached: !isWindows };

const first = spawnSync(npm, ['run', 'build', '-w', 'shared'], { stdio: 'inherit', shell: isWindows });
if (first.status !== 0) process.exit(first.status ?? 1);

const children = [
  spawn(npm, ['exec', '-w', 'shared', '--', 'tsc', '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], opts),
  spawn(npm, ['run', 'dev', '-w', 'server'], opts),
  spawn(npm, ['run', 'dev', '-w', 'web', '--', '--strictPort'], opts),
];

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM'); // detached → own process group
  } catch {
    /* already gone */
  }
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach(killTree);
  process.exit(code);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
process.on('SIGHUP', () => stop(0));
children.forEach((c) =>
  c.on('exit', (code) => {
    if (!stopping && code !== 0) stop(code ?? 1);
  }),
);
