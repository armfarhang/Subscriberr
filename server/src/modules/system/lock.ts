import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Run lock: `<DATA_DIR>/subscriberr.lock`, refreshed every few seconds while the app serves.
// `restore` refuses to run while the lock is fresh (Spec §6.9 layer 5). A heartbeat (mtime) is
// used instead of a bare PID because restore usually runs in a different container.

export const LOCK_FILE = 'subscriberr.lock';
export const HEARTBEAT_MS = 5_000;
export const STALE_AFTER_MS = 20_000;

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

function readLock(file: string): { info: LockInfo | null; ageMs: number } | null {
  try {
    const ageMs = Date.now() - statSync(file).mtimeMs;
    let info: LockInfo | null = null;
    try {
      info = JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
    } catch {
      info = null;
    }
    return { info, ageMs };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when another live instance appears to be serving from this data directory. */
export function isAppRunning(dataDir: string): boolean {
  const lock = readLock(path.join(dataDir, LOCK_FILE));
  if (!lock) return false;
  if (lock.ageMs > STALE_AFTER_MS) return false;
  // Same machine: we can tell a crashed process from a live one immediately.
  if (lock.info && lock.info.host === os.hostname()) {
    if (lock.info.pid === process.pid) return false; // left behind by a previous incarnation of this container
    return pidAlive(lock.info.pid);
  }
  return true;
}

export interface RunLock {
  release(): void;
}

/**
 * Takes the run lock for `serve`. If a fresh lock from another instance exists, waits for it to
 * go stale (an unclean stop) and fails if it keeps being refreshed (a second instance).
 */
export async function acquireRunLock(dataDir: string, options: { waitMs?: number } = {}): Promise<RunLock> {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, LOCK_FILE);
  const deadline = Date.now() + (options.waitMs ?? STALE_AFTER_MS + 2 * HEARTBEAT_MS);
  while (isAppRunning(dataDir)) {
    if (Date.now() > deadline) {
      throw new Error(`Another Subscriberr instance is already using ${dataDir} (lock file ${file} is being refreshed).`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const info: LockInfo = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(info));
  const timer = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch {
      /* the data dir may be briefly unavailable; the next beat retries */
    }
  }, HEARTBEAT_MS);
  timer.unref();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      if (existsSync(file)) rmSync(file, { force: true });
    },
  };
}
