// Starts the BUILT server in demo mode on a fresh temporary data dir, for Playwright.
// Demo mode only: fake Gmail / Plex / Jellyfin / sign-in; nothing real is contacted.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.E2E_PORT ?? '3210';
const scratch = mkdtempSync(path.join(tmpdir(), 'subscriberr-e2e-'));

const child = spawn(process.execPath, [path.join(root, 'server/dist/cli.js'), 'serve'], {
  cwd: scratch, // no .env here, so the developer's own .env is never read
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    NODE_ENV: 'development',
    PORT: port,
    BASE_URL: `http://localhost:${port}`,
    APP_SECRET: 'e2e-only-secret-e2e-only-secret-0123456789abcdef',
    DATA_DIR: path.join(scratch, 'data'),
    BACKUP_DIR: path.join(scratch, 'backups'),
    TZ: 'America/Toronto',
    SEED_DEMO: 'true',
    DEV_FAKE_LOGIN: 'true',
    LOG_LEVEL: 'warn',
  },
});
const stop = (sig) => child.kill(sig);
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('exit', (code) => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // best effort
  }
  process.exit(code ?? 0);
});
