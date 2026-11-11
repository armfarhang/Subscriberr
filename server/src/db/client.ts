import Database from 'better-sqlite3';

// Raw SQLite access. Only core/ and db/ may import this file (ESLint enforces it);
// feature modules receive a handle from core/workspace-context.ts.

export type Sqlite = Database.Database;

export interface OpenOptions {
  readonly?: boolean;
  /** Throw instead of creating the file when it does not exist. */
  mustExist?: boolean;
}

/** Opens a database with the binding connection settings of Spec §6.0 rule 7. */
export function openDatabase(file: string, options: OpenOptions = {}): Sqlite {
  const db = new Database(file, { readonly: options.readonly ?? false, fileMustExist: options.mustExist ?? false });
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  }
  return db;
}

export interface IntegrityReport {
  ok: boolean;
  integrity: string[];
  foreignKeyViolations: number;
}

/** `PRAGMA integrity_check` + `PRAGMA foreign_key_check`. */
export function checkIntegrity(db: Sqlite): IntegrityReport {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const integrity = rows.map((r) => r.integrity_check);
  const fk = db.pragma('foreign_key_check') as unknown[];
  const integrityOk = integrity.length === 1 && integrity[0] === 'ok';
  return { ok: integrityOk && fk.length === 0, integrity: integrityOk ? [] : integrity, foreignKeyViolations: fk.length };
}

/** Row count of every user table (used by backup manifests and verification). */
export function tableRowCounts(db: Sqlite): Record<string, number> {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string }>;
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const row = db.prepare(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number };
    counts[name] = row.n;
  }
  return counts;
}
