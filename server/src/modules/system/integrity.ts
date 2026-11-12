import { existsSync } from 'node:fs';
import type { Clock } from '../../core/time.js';
import { nowIso } from '../../core/time.js';
import { forWorkspace, type SystemContext } from '../../core/workspace-context.js';
import { type DatabaseInspection, inspectDatabaseFile } from '../../db/snapshot.js';
import { verifyLedger } from '../billing/ledger.js';

/** `integrity-check` subcommand: PRAGMA integrity_check + foreign_key_check on the database file (read-only). */
export function checkDatabaseFile(dbFile: string): DatabaseInspection {
  if (!existsSync(dbFile)) {
    return { ok: false, problems: [`No database found at ${dbFile}`], schemaVersion: 0, rowCounts: {} };
  }
  return inspectDatabaseFile(dbFile);
}

export interface IntegrityResult {
  ok: boolean;
  checkedAt: string;
  problems: string[];
}

/**
 * Nightly verification (Spec §6.9 layer 1, 03:30): integrity_check, foreign_key_check and the
 * ledger replay comparison for every member of every workspace. Differences are reported, never
 * silently fixed. The result is kept in `meta` for the System page / dashboard banner.
 */
export function runIntegrityCheck(ctx: SystemContext, clock: Clock): IntegrityResult {
  const problems: string[] = [];
  const integrity = ctx.sqlite.pragma('integrity_check') as Array<{ integrity_check: string }>;
  for (const r of integrity) if (r.integrity_check !== 'ok') problems.push(`integrity_check: ${r.integrity_check}`);
  const fk = ctx.sqlite.pragma('foreign_key_check') as Array<{ table: string; rowid: number; parent: string }>;
  for (const r of fk) problems.push(`foreign key: ${r.table} row ${r.rowid} → ${r.parent}`);
  const accounts = ctx.sqlite.prepare('SELECT id FROM accounts').all() as Array<{ id: number }>;
  for (const { id } of accounts) {
    for (const m of verifyLedger(forWorkspace(ctx, id))) {
      problems.push(`ledger: workspace ${id}, member #${m.memberId}, ${m.field}: cached ${JSON.stringify(m.cached)} ≠ replayed ${JSON.stringify(m.replayed)}`);
    }
  }
  const result: IntegrityResult = { ok: problems.length === 0, checkedAt: nowIso(clock), problems: problems.slice(0, 200) };
  const put = ctx.sqlite.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  put.run('last_integrity_result', JSON.stringify(result));
  if (result.ok) put.run('last_integrity_ok_at', result.checkedAt);
  return result;
}

export function lastIntegrityResult(ctx: SystemContext): IntegrityResult | null {
  const row = ctx.sqlite.prepare(`SELECT value FROM meta WHERE key = 'last_integrity_result'`).get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as IntegrityResult) : null;
}
