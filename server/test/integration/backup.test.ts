import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDays } from '@subscriberr/shared';
import { extractZipSafely } from '../../src/core/safe-zip.js';
import { getMeta, latestSchemaVersion } from '../../src/db/migrate.js';
import { checkBackupDestination } from '../../src/modules/system/backup-destination.js';
import { backupFileName, createBackup, listBackupRuns, runBackup } from '../../src/modules/system/backup.js';
import { BACKUP_ZIP_LIMITS } from '../../src/modules/system/manifest.js';
import { getSystemStatus } from '../../src/modules/system/status.js';
import { verifyBackupFile } from '../../src/modules/system/verify.js';
import { createWorld, insertAccount, insertMember, tempDir } from '../helpers/env.js';
import { writeZip } from '../helpers/zip.js';

function seed(world: ReturnType<typeof createWorld>) {
  const accountId = insertAccount(world.db, 'owner@example.com');
  insertMember(world.db, accountId, 'Ann');
  insertMember(world.db, accountId, 'Pat');
  const packDir = path.join(world.workspacesDir, String(accountId), 'templates', 'custom');
  mkdirSync(packDir, { recursive: true });
  writeFileSync(path.join(packDir, 'layout.html'), '<html>{{{content}}}</html>');
  return accountId;
}

describe('backup engine (Spec §6.9 layer 2)', () => {
  it('produces one verifiable zip with the database, workspaces/ and a manifest', async () => {
    const world = createWorld();
    const accountId = seed(world);

    const { id, outcome } = await runBackup(world.backupEnv, 'manual');
    expect(outcome.error).toBeNull();
    expect(outcome.verified).toBe(true);
    expect(outcome.file).toBe('subscriberr-20261111-100000-manual.zip');
    expect(readdirSync(world.backupDir)).toEqual([outcome.file]); // no scratch files left behind

    const zip = path.join(world.backupDir, outcome.file!);
    const out = tempDir();
    const files = await extractZipSafely(zip, out, BACKUP_ZIP_LIMITS);
    expect(files.sort()).toEqual(['manifest.json', 'subscriberr.db', `workspaces/${accountId}/templates/custom/layout.html`]);
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      app: 'subscriberr',
      formatVersion: 1,
      appVersion: 'test',
      schemaVersion: latestSchemaVersion(),
      kind: 'manual',
      createdAt: '2026-11-11T15:00:00Z',
      db: { file: 'subscriberr.db', sha256: outcome.sha256 },
    });
    expect(manifest.rowCounts).toMatchObject({ accounts: 1, members: 2, payments: 0 });

    // Recorded, and meta.last_backup_ok_at drives the dashboard warning.
    const [run] = listBackupRuns(world.ctx);
    expect(run).toMatchObject({ id, kind: 'manual', tier: 'safety', verified: true, file: outcome.file, error: null, schemaVersion: latestSchemaVersion() });
    expect(getMeta(world.db, 'last_backup_ok_at')).toBe('2026-11-11T15:00:00Z');

    expect((await verifyBackupFile(zip)).ok).toBe(true);
  });

  it('is a consistent snapshot taken while the app keeps writing', async () => {
    const world = createWorld();
    const accountId = seed(world);
    const pending = createBackup(world.backupEnv, 'manual');
    for (let i = 0; i < 50; i++) insertMember(world.db, accountId, `Late ${i}`);
    const outcome = await pending;
    expect(outcome.verified).toBe(true);
    const verified = await verifyBackupFile(path.join(world.backupDir, outcome.file!));
    expect(verified.ok).toBe(true); // row counts in the manifest match the snapshot, whatever instant it captured
    expect([2, 52]).toContain(verified.manifest!.rowCounts.members);
  });

  it('never overwrites an existing backup taken in the same second', async () => {
    const world = createWorld();
    const a = await createBackup(world.backupEnv, 'manual');
    const b = await createBackup(world.backupEnv, 'manual');
    expect(a.file).toBe('subscriberr-20261111-100000-manual.zip');
    expect(b.file).toBe('subscriberr-20261111-100000-manual-2.zip');
    expect(backupFileName(new Date('2026-01-05T04:59:59Z'), 'America/Toronto', 'nightly')).toBe('subscriberr-20260104-235959-nightly.zip');
  });

  it('a corrupted backup fails verification', async () => {
    const world = createWorld();
    seed(world);
    const { outcome } = await runBackup(world.backupEnv, 'manual');
    const zip = path.join(world.backupDir, outcome.file!);

    // Flip bytes in the middle of the archive (inside the compressed database).
    const bytes = readFileSync(zip);
    for (let i = Math.floor(bytes.length / 2); i < Math.floor(bytes.length / 2) + 64; i++) bytes[i] = bytes[i]! ^ 0xff;
    const corrupt = path.join(world.root, 'corrupt.zip');
    writeFileSync(corrupt, bytes);
    const result = await verifyBackupFile(corrupt);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    // Truncated file.
    writeFileSync(corrupt, readFileSync(zip).subarray(0, 2000));
    expect((await verifyBackupFile(corrupt)).ok).toBe(false);
    // Missing file.
    expect((await verifyBackupFile(path.join(world.root, 'nope.zip'))).error).toMatch(/not found/);
  });

  it('detects a database that does not match its manifest (checksum and row counts)', async () => {
    const world = createWorld();
    seed(world);
    const { outcome } = await runBackup(world.backupEnv, 'manual');
    const out = tempDir();
    await extractZipSafely(path.join(world.backupDir, outcome.file!), out, BACKUP_ZIP_LIMITS);
    const db = readFileSync(path.join(out, 'subscriberr.db'));
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));

    const tampered = path.join(world.root, 'tampered.zip');
    // Same database, manifest claims a different checksum.
    await writeZip(tampered, { 'subscriberr.db': db, 'manifest.json': JSON.stringify({ ...manifest, db: { ...manifest.db, sha256: 'a'.repeat(64) } }) });
    expect((await verifyBackupFile(tampered)).error).toMatch(/sha256/);

    // Checksum right, row counts wrong.
    await writeZip(tampered, { 'subscriberr.db': db, 'manifest.json': JSON.stringify({ ...manifest, rowCounts: { ...manifest.rowCounts, members: 99 } }) });
    expect((await verifyBackupFile(tampered)).error).toMatch(/Row count mismatch.*members/);

    // No manifest / no database.
    await writeZip(tampered, { 'subscriberr.db': db });
    expect((await verifyBackupFile(tampered)).error).toMatch(/manifest\.json is missing/);
    await writeZip(tampered, { 'manifest.json': JSON.stringify(manifest) });
    expect((await verifyBackupFile(tampered)).error).toMatch(/subscriberr\.db is missing/);
  });

  it('a backup that fails verification is flagged, kept, not counted, and does not trigger pruning', async () => {
    const world = createWorld({ start: '2026-11-01T08:00:00Z' });
    seed(world);
    // Five good nightly backups on consecutive days.
    for (let i = 0; i < 5; i++) {
      await runBackup(world.backupEnv, 'nightly');
      world.clock.advanceDays(1);
    }
    const before = readdirSync(world.backupDir).sort();
    const okAt = getMeta(world.db, 'last_backup_ok_at');

    // The destination disappears: the backup fails.
    rmSync(world.backupDir, { recursive: true, force: true });
    writeFileSync(world.backupDir, 'not a directory'); // mkdir cannot succeed either
    const failed = await runBackup(world.backupEnv, 'nightly');
    expect(failed.outcome.verified).toBe(false);
    expect(failed.outcome.error).toMatch(/missing/);
    expect(failed.pruned).toBeNull(); // the pruner never runs after a failed backup
    expect(getMeta(world.db, 'last_backup_ok_at')).toBe(okAt);

    const runs = listBackupRuns(world.ctx);
    expect(runs[0]).toMatchObject({ verified: false, file: null });
    expect(runs.filter((r) => r.verified && !r.prunedAt).map((r) => r.file).sort()).toEqual(before);
  });

  it('prunes real files by retention across simulated dates and keeps the newest verified backup', async () => {
    const world = createWorld({ start: '2026-09-28T07:00:00Z' }); // 03:00 Toronto (EDT), a Monday
    seed(world);
    const start = '2026-09-28';
    for (let i = 0; i < 45; i++) {
      const result = await runBackup(world.backupEnv, 'nightly');
      expect(result.outcome.verified, `day ${i}`).toBe(true);
      world.clock.advanceDays(1);
    }
    // Last backup: 2026-11-11 (Wed).
    const files = readdirSync(world.backupDir).sort();
    const dates = files.map((f) => `${f.slice(12, 16)}-${f.slice(16, 18)}-${f.slice(18, 20)}`);
    expect(dates).toEqual([
      addDays(start, 0), // 09-28: first backup of September → monthly
      '2026-10-01', // monthly
      '2026-10-19', // weekly (ISO week 43)
      '2026-10-26', // weekly (week 44)
      '2026-11-01', // monthly
      '2026-11-02', // weekly (week 45)
      '2026-11-09', // weekly (week 46)
      '2026-11-10', // daily
      '2026-11-11', // daily
    ]);

    const live = listBackupRuns(world.ctx, 500).filter((r) => !r.prunedAt);
    expect(live.map((r) => r.file).sort()).toEqual(files);
    expect(live.map((r) => r.tier).sort()).toEqual(['daily', 'daily', 'monthly', 'monthly', 'monthly', 'weekly', 'weekly', 'weekly', 'weekly']);
    expect(listBackupRuns(world.ctx, 500).filter((r) => r.prunedAt)).toHaveLength(45 - 9);
    for (const f of files) expect((await verifyBackupFile(path.join(world.backupDir, f))).ok).toBe(true);
  });

  it('keeps the three newest safety snapshots of a kind', async () => {
    const world = createWorld();
    seed(world);
    for (let i = 0; i < 5; i++) {
      await runBackup(world.backupEnv, 'pre_import');
      world.clock.advanceMs(60_000);
    }
    expect(readdirSync(world.backupDir).sort()).toEqual([
      'subscriberr-20261111-100200-pre_import.zip',
      'subscriberr-20261111-100300-pre_import.zip',
      'subscriberr-20261111-100400-pre_import.zip',
    ]);
  });
});

describe('backup destination health (Spec §6.9 layer 3)', () => {
  it('warns when the directory is missing', () => {
    const root = tempDir();
    const dest = checkBackupDestination(path.join(root, 'missing'), root);
    expect(dest).toMatchObject({ ok: false, exists: false, writable: false, freeBytes: null });
    expect(dest.problems[0]).toMatch(/missing/);
  });

  it('warns loudly when backups share a filesystem with the data', () => {
    const world = createWorld(); // both under the same temp dir → same st_dev
    const dest = checkBackupDestination(world.backupDir, world.dataDir);
    expect(dest.exists).toBe(true);
    expect(dest.writable).toBe(true);
    expect(dest.sameFilesystemAsData).toBe(true);
    expect(dest.ok).toBe(false);
    expect(dest.problems.join(' ')).toMatch(/same filesystem/);
    expect(dest.freeBytes).toBeGreaterThan(0);
  });

  it('system status flags a stale or missing backup (36 h)', async () => {
    const world = createWorld();
    const deps = { ctx: world.ctx, clock: world.clock, appVersion: 'test', demoMode: true, dataDir: world.dataDir, backupDir: world.backupDir };
    expect(getSystemStatus(deps)).toMatchObject({ lastBackupOkAt: null, backupStale: true, schemaVersion: latestSchemaVersion() });
    await runBackup(world.backupEnv, 'nightly');
    expect(getSystemStatus(deps).backupStale).toBe(false);
    world.clock.advanceMs(35 * 3600_000);
    expect(getSystemStatus(deps).backupStale).toBe(false);
    world.clock.advanceMs(2 * 3600_000);
    expect(getSystemStatus(deps).backupStale).toBe(true);
  });

  it('writes backup files that only the owner can read (POSIX)', async () => {
    const world = createWorld();
    const { outcome } = await runBackup(world.backupEnv, 'manual');
    const mode = statSync(path.join(world.backupDir, outcome.file!)).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
    expect(existsSync(path.join(world.backupDir, outcome.file!))).toBe(true);
  });
});
