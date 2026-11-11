import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sqlite } from './client.js';

// Forward-only SQL migrations (Spec §6.0 rule 8). Files are `NNNN_name.sql`; the number is the
// schema version. `meta.schema_version` records the highest applied version. The app refuses to
// run against a database whose schema is newer than the migrations it ships with.

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export class SchemaTooNewError extends Error {
  constructor(
    public readonly databaseVersion: number,
    public readonly appSchemaVersion: number,
  ) {
    super(
      `Database schema version ${databaseVersion} is newer than this app supports (${appSchemaVersion}). ` +
        'Refusing to start: upgrade the app, or restore a backup taken with this version.',
    );
    this.name = 'SchemaTooNewError';
  }
}

export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.slice(0, 4)), name: f, sql: readFileSync(path.join(dir, f), 'utf8') }));
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migration files must be numbered contiguously from 0001 (found ${m.name})`);
  });
  return migrations;
}

/** Highest schema version this build knows about. */
export function latestSchemaVersion(dir: string = MIGRATIONS_DIR): number {
  return listMigrations(dir).length;
}

/** Schema version recorded in the database; 0 for a brand-new (empty) database. */
export function currentSchemaVersion(db: Sqlite): number {
  const hasMeta = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get();
  if (!hasMeta) return 0;
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function getMeta(db: Sqlite, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Sqlite, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

export interface MigrateOptions {
  appVersion: string;
  /** UTC ISO timestamp recorded as `created_at` on first initialisation. */
  nowIso: string;
  dir?: string;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: string[];
}

export function pendingMigrations(db: Sqlite, dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = listMigrations(dir);
  const current = currentSchemaVersion(db);
  if (current > migrations.length) throw new SchemaTooNewError(current, migrations.length);
  return migrations.filter((m) => m.version > current);
}

/** Applies all pending migrations in ONE transaction; either all of them land or none. */
export function migrate(db: Sqlite, options: MigrateOptions): MigrateResult {
  const from = currentSchemaVersion(db);
  const pending = pendingMigrations(db, options.dir);
  if (pending.length > 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const m of pending) {
        db.exec(m.sql);
        setMeta(db, 'schema_version', String(m.version));
      }
      if (getMeta(db, 'created_at') === null) setMeta(db, 'created_at', options.nowIso);
      setMeta(db, 'app_version', options.appVersion);
      db.exec('COMMIT');
    } catch (err) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw err;
    }
  } else if (from > 0 && getMeta(db, 'app_version') !== options.appVersion) {
    setMeta(db, 'app_version', options.appVersion);
  }
  return { from, to: currentSchemaVersion(db), applied: pending.map((m) => m.name) };
}
