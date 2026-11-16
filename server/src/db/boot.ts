import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { checkIntegrity, openDatabase, type Sqlite } from './client.js';
import { currentSchemaVersion, migrate, type MigrateResult, pendingMigrations } from './migrate.js';

export class DatabaseCorruptError extends Error {
  constructor(file: string, detail: string) {
    super(
      `The database at ${file} failed its integrity check and will not be opened:\n${detail}\n` +
        'Nothing was changed or deleted. Restore the most recent verified backup with ' +
        '`restore <backup.zip>` (see README, "Restore"), then use "Rescan mailbox from date".',
    );
    this.name = 'DatabaseCorruptError';
  }
}

export interface BootOptions {
  dbFile: string;
  appVersion: string;
  nowIso: string;
  migrationsDir?: string;
  /**
   * Called before migrations are applied to an EXISTING database (never for a brand-new one),
   * so the caller can take the `pre_migration` safety backup (Spec §6.9). A rejection aborts boot.
   */
  beforeMigrate?: (db: Sqlite, info: { from: number; pending: string[] }) => Promise<void>;
}

export interface BootResult {
  db: Sqlite;
  created: boolean;
  migration: MigrateResult;
}

/**
 * Opens (or creates) the database, checks it is healthy, takes the pre-migration backup when
 * needed and applies pending migrations. Never deletes or recreates an existing database.
 */
export async function bootDatabase(options: BootOptions): Promise<BootResult> {
  const created = !existsSync(options.dbFile);
  mkdirSync(path.dirname(options.dbFile), { recursive: true });

  let db: Sqlite;
  try {
    db = openDatabase(options.dbFile);
    if (!created) {
      const rows = db.pragma('quick_check') as Array<{ quick_check: string }>;
      if (!(rows.length === 1 && rows[0]?.quick_check === 'ok')) {
        const detail = rows.map((r) => r.quick_check).join('\n');
        db.close();
        throw new DatabaseCorruptError(options.dbFile, detail);
      }
    }
  } catch (err) {
    if (err instanceof DatabaseCorruptError) throw err;
    throw new DatabaseCorruptError(options.dbFile, err instanceof Error ? err.message : String(err));
  }

  try {
    // Older installs created these world-readable (0644); the data is personal, so close them.
    for (const file of [options.dbFile, `${options.dbFile}-wal`, `${options.dbFile}-shm`]) {
      try {
        if (existsSync(file)) chmodSync(file, 0o600);
      } catch {
        /* not the owner / filesystem without modes: the entrypoint and umask still apply */
      }
    }
    const from = currentSchemaVersion(db);
    const pending = pendingMigrations(db, options.migrationsDir); // throws SchemaTooNewError
    if (from > 0 && pending.length > 0 && options.beforeMigrate) {
      await options.beforeMigrate(db, { from, pending: pending.map((m) => m.name) });
    }
    const migration = migrate(db, { appVersion: options.appVersion, nowIso: options.nowIso, dir: options.migrationsDir });
    return { db, created, migration };
  } catch (err) {
    db.close();
    throw err;
  }
}

export { checkIntegrity };
