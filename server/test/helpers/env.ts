import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { type Config, loadConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { createSecretBox } from '../../src/core/crypto.js';
import { silentLogger } from '../../src/core/logger.js';
import { FakeGoogleAuthProvider } from '../../src/modules/auth/fake-google.js';
import type { GoogleAuthProvider } from '../../src/modules/auth/google.js';
import { FakeClock, nowIso } from '../../src/core/time.js';
import { createSystemContext, type SystemContext } from '../../src/core/workspace-context.js';
import { openDatabase, type Sqlite } from '../../src/db/client.js';
import { migrate } from '../../src/db/migrate.js';
import type { BackupEnv } from '../../src/modules/system/backup.js';
import { createMediaProviderFactory } from '../../src/modules/media/factory.js';
import { createGmailClientFactory, type GmailClientFactory } from '../../src/modules/gmail/factory.js';
import type { AppDeps } from '../../src/http/types.js';
import { createServices } from '../../src/wiring.js';
import { DEFAULT_BUILTIN_DIR } from '../../src/modules/email/packs.js';

export const TEST_SECRET = 'test-secret-test-secret-test-secret-0123456789';
export const TEST_TZ = 'America/Toronto';

const cleanups: Array<() => void> = [];

/** Registers cleanup that runs after the current test (closing DBs before removing dirs). */
export function onCleanup(fn: () => void): void {
  cleanups.push(fn);
}

afterEach(() => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()!();
    } catch {
      /* best effort */
    }
  }
});

export function tempDir(prefix = 'subscriberr-test-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  onCleanup(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

/** A migrated in-memory database. */
export function memoryDb(clock = new FakeClock()): Sqlite {
  const db = openDatabase(':memory:');
  migrate(db, { appVersion: 'test', nowIso: nowIso(clock) });
  onCleanup(() => db.close());
  return db;
}

export function insertAccount(db: Sqlite, email = 'owner@example.com', role: 'owner' | 'operator' = 'owner'): number {
  return Number(
    db
      .prepare(`INSERT INTO accounts (google_sub, email, role, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00Z')`)
      .run(`fake:${email}`, email, role).lastInsertRowid,
  );
}

export function insertMember(db: Sqlite, accountId: number, displayName = 'Member'): number {
  return Number(
    db
      .prepare(`INSERT INTO members (account_id, display_name, created_at, updated_at) VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
      .run(accountId, displayName).lastInsertRowid,
  );
}

export interface TestWorld {
  root: string;
  dataDir: string;
  backupDir: string;
  dbFile: string;
  workspacesDir: string;
  db: Sqlite;
  ctx: SystemContext;
  clock: FakeClock;
  config: Config;
  backupEnv: BackupEnv;
}

export function testConfig(dataDir: string, backupDir: string, overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig(
    {
      APP_SECRET: TEST_SECRET,
      BASE_URL: 'http://localhost:3000',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupDir,
      TZ: TEST_TZ,
      DEV_FAKE_LOGIN: 'true',
      SEED_DEMO: 'true',
      NODE_ENV: 'test',
      ...overrides,
    },
    dataDir,
  );
}

/** A file-backed, migrated database with data + backup directories (for backup/restore tests). */
export function createWorld(options: { start?: string; env?: NodeJS.ProcessEnv } = {}): TestWorld {
  const root = tempDir();
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const workspacesDir = path.join(dataDir, 'workspaces');
  mkdirSync(workspacesDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  const clock = new FakeClock(options.start ?? '2026-11-11T15:00:00Z');
  const dbFile = path.join(dataDir, 'subscriberr.db');
  const db = openDatabase(dbFile);
  migrate(db, { appVersion: 'test', nowIso: nowIso(clock) });
  onCleanup(() => {
    if (db.open) db.close();
  });
  const ctx = createSystemContext(db);
  const config = testConfig(dataDir, backupDir, options.env);
  const backupEnv: BackupEnv = { ctx, dbFile, workspacesDir, dataDir, backupDir, appVersion: 'test', timeZone: TEST_TZ, clock, log: silentLogger };
  return { root, dataDir, backupDir, dbFile, workspacesDir, db, ctx, clock, config, backupEnv };
}

/** Puts an email on the sign-in allowlist (owned by account 1 unless given). */
export function allowEmail(db: Sqlite, email: string, ownerId = 1): void {
  db.prepare(`INSERT INTO allowed_accounts (account_id, email, added_by, created_at) VALUES (?, ?, 'test', '2026-01-01T00:00:00Z')`).run(ownerId, email);
}

export const testSecretBox = () => createSecretBox(TEST_SECRET);

/** The app wired like main.ts, with the in-process fake Google unless another provider is given. */
export function testApp(world: TestWorld, options: { webDir?: string; google?: GoogleAuthProvider | null; config?: Config; gmail?: GmailClientFactory; onPaymentStored?: AppDeps['onPaymentStored'] } = {}) {
  const config = options.config ?? world.config;
  const google = options.google === undefined ? new FakeGoogleAuthProvider(config.baseUrl, world.clock) : options.google;
  const secretBox = testSecretBox();
  const packs = { builtinDir: DEFAULT_BUILTIN_DIR, workspacesDir: world.workspacesDir };
  const services = createServices({ clock: world.clock, log: silentLogger, packs });
  const app = createApp({ config, ctx: world.ctx, clock: world.clock, log: silentLogger, secretBox, google, backupEnv: world.backupEnv, webDir: options.webDir, media: createMediaProviderFactory(config), gmail: options.gmail ?? createGmailClientFactory(config), onPaymentStored: options.onPaymentStored ?? services.onPaymentStored, billingEvents: services.billingEvents, packs, emailThrottleMs: 0 });
  return { app, google, secretBox, config, services };
}
