import { rmSync } from 'node:fs';
import path from 'node:path';
import {
  addDays,
  type BackupKind,
  type BackupRetention,
  type BackupTier,
  isoWeekKey,
  isoWeekStart,
  localDate,
  monthKey,
  shiftMonthKey,
} from '@subscriberr/shared';
import type { SystemContext } from '../../core/workspace-context.js';

// Retention (Spec §6.9 layer 2). Defaults: 2 daily / 4 weekly / 6 monthly.
//  - daily:   the newest N verified nightly backups
//  - weekly:  the FIRST verified nightly backup of each of the last N ISO weeks
//  - monthly: the FIRST verified nightly backup of each of the last N calendar months
//  - safety snapshots (manual / pre_migration / pre_import): newest 3 verified of each kind
//  - the newest verified backup is never removed
//  - backups that failed verification are not counted; the newest 3 are kept for inspection
// Weeks and months are evaluated in the server timezone.

export const SAFETY_KEEP_PER_KIND = 3;
export const FAILED_KEEP = 3;

export interface RetentionInput {
  id: number;
  kind: BackupKind;
  startedAt: string;
  verified: boolean;
}

export interface RetentionPlan {
  /** id → the tier that keeps this backup alive. */
  keep: Map<number, BackupTier>;
  /** ids kept only because they failed verification and are awaiting inspection. */
  keepFailed: number[];
  remove: number[];
}

const newestFirst = (a: RetentionInput, b: RetentionInput) => (a.startedAt === b.startedAt ? b.id - a.id : a.startedAt < b.startedAt ? 1 : -1);

export function planRetention(runs: RetentionInput[], retention: BackupRetention, timeZone: string, now: Date): RetentionPlan {
  const keep = new Map<number, BackupTier>();
  const sorted = [...runs].sort(newestFirst);
  const verified = sorted.filter((r) => r.verified);
  const nightly = verified.filter((r) => r.kind === 'nightly');
  const dateOf = (r: RetentionInput) => localDate(r.startedAt, timeZone);

  // Applied in increasing lifetime so the longest-lived tier wins the label.
  for (const r of nightly.slice(0, retention.daily)) keep.set(r.id, 'daily');

  const today = localDate(now, timeZone);
  const oldestFirst = [...nightly].reverse();

  const thisWeek = isoWeekStart(today);
  for (let i = 0; i < retention.weekly; i++) {
    const key = isoWeekKey(addDays(thisWeek, -7 * i));
    const first = oldestFirst.find((r) => isoWeekKey(dateOf(r)) === key);
    if (first) keep.set(first.id, 'weekly');
  }

  const thisMonth = monthKey(today);
  for (let i = 0; i < retention.monthly; i++) {
    const key = shiftMonthKey(thisMonth, -i);
    const first = oldestFirst.find((r) => monthKey(dateOf(r)) === key);
    if (first) keep.set(first.id, 'monthly');
  }

  for (const kind of ['manual', 'pre_migration', 'pre_import'] as const) {
    for (const r of verified.filter((x) => x.kind === kind).slice(0, SAFETY_KEEP_PER_KIND)) keep.set(r.id, 'safety');
  }

  const newestVerified = verified[0];
  if (newestVerified && !keep.has(newestVerified.id)) {
    keep.set(newestVerified.id, newestVerified.kind === 'nightly' ? 'daily' : 'safety');
  }

  const keepFailed = sorted
    .filter((r) => !r.verified)
    .slice(0, FAILED_KEEP)
    .map((r) => r.id);

  const remove = sorted.filter((r) => !keep.has(r.id) && !keepFailed.includes(r.id)).map((r) => r.id);
  return { keep, keepFailed, remove };
}

interface BackupRow {
  id: number;
  kind: BackupKind;
  started_at: string;
  verified: number;
  file: string | null;
}

export interface PruneResult {
  removed: string[];
  kept: number;
}

/** Applies the retention plan: deletes files that satisfy no tier and records it on the row. */
export function pruneBackups(
  ctx: SystemContext,
  options: { backupDir: string; retention: BackupRetention; timeZone: string; now: Date; nowIso: string },
): PruneResult {
  const rows = ctx.sqlite
    .prepare(`SELECT id, kind, started_at, verified, file FROM backup_runs WHERE pruned_at IS NULL AND file IS NOT NULL`)
    .all() as BackupRow[];
  const plan = planRetention(
    rows.map((r) => ({ id: r.id, kind: r.kind, startedAt: r.started_at, verified: r.verified === 1 })),
    options.retention,
    options.timeZone,
    options.now,
  );

  const setTier = ctx.sqlite.prepare('UPDATE backup_runs SET tier = ? WHERE id = ?');
  const markPruned = ctx.sqlite.prepare('UPDATE backup_runs SET pruned_at = ? WHERE id = ?');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const removed: string[] = [];

  for (const [id, tier] of plan.keep) setTier.run(tier, id);
  for (const id of plan.remove) {
    const file = byId.get(id)?.file;
    if (!file) continue;
    // Only ever delete plain file names inside the backup directory.
    if (path.basename(file) !== file) continue;
    rmSync(path.join(options.backupDir, file), { force: true });
    markPruned.run(options.nowIso, id);
    removed.push(file);
  }
  return { removed, kept: plan.keep.size + plan.keepFailed.length };
}
