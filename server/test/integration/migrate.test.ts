import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/core/logger.js';
import { FakeClock, nowIso } from '../../src/core/time.js';
import { bootDatabase, DatabaseCorruptError } from '../../src/db/boot.js';
import { openDatabase } from '../../src/db/client.js';
import { currentSchemaVersion, getMeta, latestSchemaVersion, listMigrations, migrate, MIGRATIONS_DIR, SchemaTooNewError } from '../../src/db/migrate.js';
import { createBackup } from '../../src/modules/system/backup.js';
import { verifyBackupFile } from '../../src/modules/system/verify.js';
import { insertAccount, onCleanup, tempDir, TEST_TZ } from '../helpers/env.js';

const clock = new FakeClock('2026-11-11T15:00:00Z');

/** A copy of the real migrations plus one extra, to simulate an app upgrade. */
function migrationsWithExtra(root: string): string {
  const dir = path.join(root, 'migrations-next');
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const next = String(latestSchemaVersion() + 1).padStart(4, '0');
  writeFileSync(path.join(dir, `${next}_add_demo.sql`), 'CREATE TABLE upgrade_demo (id INTEGER PRIMARY KEY, note TEXT) STRICT;\n');
  return dir;
}

describe('migrations (Spec §6.0 rule 8)', () => {
  it('initialises a new database and records schema/app version and created_at', async () => {
    const root = tempDir();
    const dbFile = path.join(root, 'data', 'subscriberr.db');
    const boot = await bootDatabase({ dbFile, appVersion: '0.1.0', nowIso: nowIso(clock) });
    onCleanup(() => boot.db.close());
    expect(boot.created).toBe(true);
    expect(boot.migration).toMatchObject({ from: 0, to: latestSchemaVersion() });
    expect(currentSchemaVersion(boot.db)).toBe(listMigrations().length);
    expect(getMeta(boot.db, 'app_version')).toBe('0.1.0');
    expect(getMeta(boot.db, 'created_at')).toBe('2026-11-11T15:00:00Z');
    expect(boot.db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('is idempotent and only bumps app_version on a later boot', async () => {
    const dbFile = path.join(tempDir(), 'subscriberr.db');
    (await bootDatabase({ dbFile, appVersion: '0.1.0', nowIso: nowIso(clock) })).db.close();
    const again = await bootDatabase({ dbFile, appVersion: '0.2.0', nowIso: '2027-01-01T00:00:00Z' });
    onCleanup(() => again.db.close());
    expect(again.created).toBe(false);
    expect(again.migration.applied).toEqual([]);
    expect(getMeta(again.db, 'app_version')).toBe('0.2.0');
    expect(getMeta(again.db, 'created_at')).toBe('2026-11-11T15:00:00Z');
  });

  it('refuses to start when the database schema is newer than the app', async () => {
    const dbFile = path.join(tempDir(), 'subscriberr.db');
    const first = await bootDatabase({ dbFile, appVersion: '0.1.0', nowIso: nowIso(clock) });
    first.db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(latestSchemaVersion() + 5));
    first.db.close();
    await expect(bootDatabase({ dbFile, appVersion: '0.1.0', nowIso: nowIso(clock) })).rejects.toBeInstanceOf(SchemaTooNewError);
    // Nothing was changed by the refused boot.
    const db = openDatabase(dbFile);
    onCleanup(() => db.close());
    expect(currentSchemaVersion(db)).toBe(latestSchemaVersion() + 5);
  });

  it('rolls back completely when a migration fails', () => {
    const root = tempDir();
    const dir = path.join(root, 'bad');
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const next = String(latestSchemaVersion() + 1).padStart(4, '0');
    writeFileSync(path.join(dir, `${next}_bad.sql`), 'CREATE TABLE ok_table (id INTEGER PRIMARY KEY) STRICT;\nCREATE TABLE broken (;\n');
    const db = openDatabase(':memory:');
    onCleanup(() => db.close());
    expect(() => migrate(db, { appVersion: 'x', nowIso: nowIso(clock), dir })).toThrow();
    expect(currentSchemaVersion(db)).toBe(0);
    expect(db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`).get()).toEqual({ n: 0 });
  });

  it('takes a verified pre-migration backup of an existing database before upgrading it', async () => {
    const root = tempDir();
    const dataDir = path.join(root, 'data');
    const backupDir = path.join(root, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const dbFile = path.join(dataDir, 'subscriberr.db');

    // Existing installation with data, at the current schema.
    let calls = 0;
    const first = await bootDatabase({ dbFile, appVersion: '0.1.0', nowIso: nowIso(clock), beforeMigrate: async () => void calls++ });
    insertAccount(first.db, 'owner@example.com');
    first.db.close();
    expect(calls).toBe(0); // a brand-new database has nothing to back up

    // "Upgrade": one more migration is available.
    let backupFile: string | null = null;
    const upgraded = await bootDatabase({
      dbFile,
      appVersion: '0.2.0',
      nowIso: nowIso(clock),
      migrationsDir: migrationsWithExtra(root),
      async beforeMigrate(db, info) {
        expect(info.from).toBe(latestSchemaVersion());
        expect(info.pending).toHaveLength(1);
        const outcome = await createBackup(
          { ctx: { sqlite: db }, dbFile, workspacesDir: path.join(dataDir, 'workspaces'), dataDir, backupDir, appVersion: '0.2.0', timeZone: TEST_TZ, clock, log: silentLogger },
          'pre_migration',
        );
        expect(outcome.error).toBeNull();
        expect(outcome.verified).toBe(true);
        backupFile = outcome.file;
      },
    });
    onCleanup(() => upgraded.db.close());

    expect(upgraded.migration).toMatchObject({ from: latestSchemaVersion(), to: latestSchemaVersion() + 1 });
    expect(backupFile).toMatch(/^subscriberr-20261111-100000-pre_migration\.zip$/); // 15:00Z = 10:00 Toronto
    expect(readdirSync(backupDir)).toEqual([backupFile]);

    // The snapshot holds the PRE-migration schema and the existing data.
    const verified = await verifyBackupFile(path.join(backupDir, backupFile!));
    expect(verified.ok).toBe(true);
    expect(verified.manifest!.schemaVersion).toBe(latestSchemaVersion());
    expect(verified.manifest!.rowCounts.accounts).toBe(1);
    expect(verified.manifest!.rowCounts.upgrade_demo).toBeUndefined();
  });

  it('does not migrate when the pre-migration backup fails', async () => {
    const root = tempDir();
    const dbFile = path.join(root, 'subscriberr.db');
    (await bootDatabase({ dbFile, appVersion: '0.1.0', nowIso: nowIso(clock) })).db.close();
    await expect(
      bootDatabase({
        dbFile,
        appVersion: '0.2.0',
        nowIso: nowIso(clock),
        migrationsDir: migrationsWithExtra(root),
        beforeMigrate: async () => {
          throw new Error('backup volume missing');
        },
      }),
    ).rejects.toThrow(/backup volume missing/);
    const db = openDatabase(dbFile);
    onCleanup(() => db.close());
    expect(currentSchemaVersion(db)).toBe(latestSchemaVersion());
  });

  it('refuses a corrupt database without deleting or recreating it', async () => {
    const dbFile = path.join(tempDir(), 'subscriberr.db');
    writeFileSync(dbFile, Buffer.from('this is not a sqlite database, just garbage bytes '.repeat(200)));
    await expect(bootDatabase({ dbFile, appVersion: '0.1.0', nowIso: nowIso(clock) })).rejects.toBeInstanceOf(DatabaseCorruptError);
    expect(existsSync(dbFile)).toBe(true);
  });
});
