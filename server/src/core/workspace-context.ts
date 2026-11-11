import type Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema/index.js';

// The ONLY way for modules to obtain a database handle (Spec §4.1 rule 3, §5.5).
// - SystemContext: platform-level work that is not workspace data (meta, sessions, accounts,
//   job/backup runs). Used by auth, jobs and system modules only.
// - WorkspaceContext: everything that belongs to one Google account's workspace. It carries the
//   account id that every query must be scoped by; the composite foreign keys in the schema are
//   the second wall.

export type Db = BetterSQLite3Database<typeof schema>;

export interface SystemContext {
  readonly sqlite: Database.Database;
  readonly db: Db;
}

export interface WorkspaceContext extends SystemContext {
  readonly accountId: number;
}

export function createSystemContext(sqlite: Database.Database): SystemContext {
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

export function forWorkspace(system: SystemContext, accountId: number): WorkspaceContext {
  if (!Number.isInteger(accountId) || accountId <= 0) throw new Error('A workspace context needs a valid account id');
  return { sqlite: system.sqlite, db: system.db, accountId };
}
