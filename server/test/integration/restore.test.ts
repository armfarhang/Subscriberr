import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { silentLogger } from '../../src/core/logger.js';
import { nowIso } from '../../src/core/time.js';
import { createSystemContext } from '../../src/core/workspace-context.js';
import { bootDatabase } from '../../src/db/boot.js';
import { checkIntegrity, openDatabase } from '../../src/db/client.js';
import { currentSchemaVersion, latestSchemaVersion, MIGRATIONS_DIR } from '../../src/db/migrate.js';
import { runBackup } from '../../src/modules/system/backup.js';
import { checkDatabaseFile } from '../../src/modules/system/integrity.js';
import { acquireRunLock, isAppRunning } from '../../src/modules/system/lock.js';
import { RestoreError, restoreBackup } from '../../src/modules/system/restore.js';
import { createWorld, insertAccount, insertMember, onCleanup, tempDir, TEST_TZ, testConfig } from '../helpers/env.js';

async function worldWithBackup() {
  const world = createWorld();
  const accountId = insertAccount(world.db, 'owner@example.com');
  const memberId = insertMember(world.db, accountId, 'Ann');
  world.db
    .prepare(`INSERT INTO ledger_entries (account_id, member_id, created_at, created_by, kind, effective_at, set_paid_through, paid_through_after) VALUES (?, ?, ?, 'system', 'manual_set', ?, '2026-12-01', '2026-12-01')`)
    .run(accountId, memberId, nowIso(world.clock), nowIso(world.clock));
  const pack = path.join(world.workspacesDir, String(accountId), 'templates', 'mine');
  mkdirSync(pack, { recursive: true });
  writeFileSync(path.join(pack, 'layout.html'), 'custom layout');
  const { outcome } = await runBackup(world.backupEnv, 'manual');
  expect(outcome.verified).toBe(true);
  return { world, accountId, memberId, backupFile: path.join(world.backupDir, outcome.file!) };
}

const restoreOptions = (backupFile: string, dataDir: string, world: ReturnType<typeof createWorld>) => ({
  backupFile,
  dataDir,
  appVersion: 'test',
  timeZone: TEST_TZ,
  clock: world.clock,
  log: silentLogger,
});

describe('restore (Spec §6.9 layer 5)', () => {
  it('restores into an empty directory; the app then boots and the data verifies', async () => {
    const { world, accountId, memberId, backupFile } = await worldWithBackup();
    const freshData = path.join(tempDir(), 'data');

    const result = await restoreBackup(restoreOptions(backupFile, freshData, world));
    expect(result.movedAside).toEqual([]);
    expect(result.manifest.rowCounts).toMatchObject({ accounts: 1, members: 1, ledger_entries: 1 });
    expect(readFileSync(path.join(freshData, 'workspaces', String(accountId), 'templates', 'mine', 'layout.html'), 'utf8')).toBe('custom layout');
    expect(readdirSync(freshData).sort()).toEqual(['subscriberr.db', 'workspaces']); // no scratch left behind

    // The integrity-check subcommand passes on the restored database…
    expect(checkDatabaseFile(path.join(freshData, 'subscriberr.db'))).toMatchObject({ ok: true, schemaVersion: latestSchemaVersion() });

    // …and the app boots on it.
    const boot = await bootDatabase({ dbFile: path.join(freshData, 'subscriberr.db'), appVersion: 'test', nowIso: nowIso(world.clock) });
    onCleanup(() => boot.db.close());
    expect(boot.created).toBe(false);
    expect(boot.migration.applied).toEqual([]);
    expect(checkIntegrity(boot.db).ok).toBe(true);
    const ctx = createSystemContext(boot.db);
    const config = testConfig(freshData, path.join(world.root, 'backups2'));
    const app = createApp({ config, ctx, clock: world.clock, log: silentLogger, backupEnv: { ...world.backupEnv, ctx, dataDir: freshData } });
    const health = await app.request('/healthz');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', schemaVersion: latestSchemaVersion() });

    // The ledger and the member cache inputs came back exactly (replay comparison joins in M6).
    expect(boot.db.prepare('SELECT member_id, kind, set_paid_through, paid_through_after FROM ledger_entries').all()).toEqual([
      { member_id: memberId, kind: 'manual_set', set_paid_through: '2026-12-01', paid_through_after: '2026-12-01' },
    ]);
  });

  it('moves the current data aside instead of deleting it', async () => {
    const { world, accountId, backupFile } = await worldWithBackup();
    // Changes made after the backup…
    insertMember(world.db, accountId, 'Added after the backup');
    writeFileSync(path.join(world.workspacesDir, 'after-backup.txt'), 'x');
    world.db.close(); // the app is stopped

    world.clock.set('2026-11-12T01:02:03Z');
    const result = await restoreBackup(restoreOptions(backupFile, world.dataDir, world));
    expect(result.movedAside.map((p) => path.basename(p)).sort()).toEqual([
      'subscriberr.db.before-restore-20261111-200203',
      'workspaces.before-restore-20261111-200203',
    ]);

    const restored = openDatabase(world.dbFile);
    onCleanup(() => restored.close());
    expect(restored.prepare('SELECT count(*) AS n FROM members').get()).toEqual({ n: 1 });
    expect(existsSync(path.join(world.workspacesDir, 'after-backup.txt'))).toBe(false);

    // …are still there in the set-aside copy.
    const aside = openDatabase(result.movedAside.find((p) => p.includes('subscriberr.db'))!, { readonly: true });
    onCleanup(() => aside.close());
    expect(aside.prepare('SELECT count(*) AS n FROM members').get()).toEqual({ n: 2 });
    expect(existsSync(path.join(world.dataDir, 'workspaces.before-restore-20261111-200203', 'after-backup.txt'))).toBe(true);
  });

  it('refuses to run while the app is running', async () => {
    const { world, backupFile } = await worldWithBackup();
    const lock = await acquireRunLock(world.dataDir);
    onCleanup(() => lock.release());
    // Simulate "another container": the lock's pid/host are not ours.
    writeFileSync(path.join(world.dataDir, 'subscriberr.lock'), JSON.stringify({ pid: 1, host: 'another-container', startedAt: 'x' }));
    expect(isAppRunning(world.dataDir)).toBe(true);
    await expect(restoreBackup(restoreOptions(backupFile, world.dataDir, world))).rejects.toThrow(/appears to be running/);
    expect(world.db.prepare('SELECT count(*) AS n FROM members').get()).toEqual({ n: 1 }); // untouched

    lock.release();
    expect(isAppRunning(world.dataDir)).toBe(false);
  });

  it('refuses when the database is locked by another process, even without a run lock', async () => {
    const { world, backupFile } = await worldWithBackup();
    world.db.exec('BEGIN EXCLUSIVE');
    try {
      await expect(restoreBackup(restoreOptions(backupFile, world.dataDir, world))).rejects.toThrow(/in use/);
    } finally {
      world.db.exec('ROLLBACK');
    }
  });

  it('verifies first and changes nothing when the backup is bad', async () => {
    const { world, backupFile } = await worldWithBackup();
    world.db.close();
    const bad = path.join(world.root, 'bad.zip');
    writeFileSync(bad, readFileSync(backupFile).subarray(0, 1500));
    const before = readdirSync(world.dataDir).sort();
    await expect(restoreBackup(restoreOptions(bad, world.dataDir, world))).rejects.toBeInstanceOf(RestoreError);
    expect(readdirSync(world.dataDir).sort()).toEqual(before);
  });

  it('migrates an older backup forward, and refuses one from a newer app', async () => {
    const { world, backupFile } = await worldWithBackup();
    const next = path.join(world.root, 'migrations-next');
    cpSync(MIGRATIONS_DIR, next, { recursive: true });
    writeFileSync(path.join(next, `${String(latestSchemaVersion() + 1).padStart(4, '0')}_more.sql`), 'CREATE TABLE later (id INTEGER PRIMARY KEY) STRICT;');

    // Older backup + newer app → migrated on restore.
    const target = path.join(tempDir(), 'data');
    const result = await restoreBackup({ ...restoreOptions(backupFile, target, world), migrationsDir: next });
    expect(result).toMatchObject({ migratedFrom: latestSchemaVersion(), migratedTo: latestSchemaVersion() + 1 });
    const db = openDatabase(path.join(target, 'subscriberr.db'));
    expect(currentSchemaVersion(db)).toBe(latestSchemaVersion() + 1);
    db.close();

    // Backup of that newer schema + this (older) app → refused, nothing written.
    const newerDb = openDatabase(path.join(target, 'subscriberr.db'));
    const newerCtx = createSystemContext(newerDb);
    const newerBackups = path.join(world.root, 'newer-backups');
    mkdirSync(newerBackups);
    const { outcome } = await runBackup({ ...world.backupEnv, ctx: newerCtx, dbFile: path.join(target, 'subscriberr.db'), dataDir: target, workspacesDir: path.join(target, 'workspaces'), backupDir: newerBackups }, 'manual');
    newerDb.close();
    expect(outcome.verified).toBe(true);
    const empty = path.join(tempDir(), 'data');
    await expect(restoreBackup(restoreOptions(path.join(newerBackups, outcome.file!), empty, world))).rejects.toThrow(/schema version/);
    expect(existsSync(path.join(empty, 'subscriberr.db'))).toBe(false);
  });
});

describe('run lock', () => {
  it('a stale lock (crashed app) does not block', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'subscriberr.lock'), JSON.stringify({ pid: 999_999_99, host: 'another-container', startedAt: 'x' }));
    const { utimesSync } = await import('node:fs');
    const old = new Date(Date.now() - 120_000);
    utimesSync(path.join(dir, 'subscriberr.lock'), old, old);
    expect(isAppRunning(dir)).toBe(false);
    const lock = await acquireRunLock(dir, { waitMs: 100 });
    lock.release();
    expect(existsSync(path.join(dir, 'subscriberr.lock'))).toBe(false);
  });

  it('a second instance cannot take a live lock', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'subscriberr.lock'), JSON.stringify({ pid: 1, host: 'another-container', startedAt: 'x' }));
    await expect(acquireRunLock(dir, { waitMs: 50 })).rejects.toThrow(/already using/);
  });
});
