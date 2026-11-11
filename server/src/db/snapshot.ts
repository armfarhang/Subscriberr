import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { checkIntegrity, openDatabase, type Sqlite, tableRowCounts } from './client.js';
import { currentSchemaVersion } from './migrate.js';

// Low-level helpers used by the backup / verify / restore code in modules/system.

/** Consistent online copy of a live database (better-sqlite3 backup API; safe while the app runs). */
export async function snapshotDatabase(db: Sqlite, destFile: string): Promise<void> {
  await db.backup(destFile);
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export interface DatabaseInspection {
  ok: boolean;
  problems: string[];
  schemaVersion: number;
  rowCounts: Record<string, number>;
}

/** Opens a database file read-only and reports integrity, schema version and row counts. */
export function inspectDatabaseFile(file: string): DatabaseInspection {
  let db: Sqlite;
  try {
    db = openDatabase(file, { readonly: true, mustExist: true });
  } catch (err) {
    return { ok: false, problems: [`cannot open database: ${err instanceof Error ? err.message : String(err)}`], schemaVersion: 0, rowCounts: {} };
  }
  try {
    const report = checkIntegrity(db);
    const problems = [...report.integrity];
    if (report.foreignKeyViolations > 0) problems.push(`${report.foreignKeyViolations} foreign key violation(s)`);
    return { ok: report.ok, problems, schemaVersion: currentSchemaVersion(db), rowCounts: tableRowCounts(db) };
  } catch (err) {
    return { ok: false, problems: [err instanceof Error ? err.message : String(err)], schemaVersion: 0, rowCounts: {} };
  } finally {
    db.close();
  }
}

/**
 * Tries to take an exclusive lock on a database file. Returns false when another process is
 * using it (used by `restore` as a second guard next to the run lock).
 */
export function canLockExclusively(file: string): boolean {
  let db: Sqlite | undefined;
  try {
    db = openDatabase(file, { mustExist: true });
    db.pragma('busy_timeout = 250');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('ROLLBACK');
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
