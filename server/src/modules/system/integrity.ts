import { existsSync } from 'node:fs';
import { type DatabaseInspection, inspectDatabaseFile } from '../../db/snapshot.js';

/**
 * `integrity-check` subcommand: PRAGMA integrity_check + foreign_key_check on the database file
 * (read-only). The ledger replay comparison joins this check with the billing engine (M6).
 */
export function checkDatabaseFile(dbFile: string): DatabaseInspection {
  if (!existsSync(dbFile)) {
    return { ok: false, problems: [`No database found at ${dbFile}`], schemaVersion: 0, rowCounts: {} };
  }
  return inspectDatabaseFile(dbFile);
}
