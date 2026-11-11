import { describe, expect, it } from 'vitest';
import { addDays, DEFAULT_BACKUP_RETENTION } from '@subscriberr/shared';
import { planRetention, type RetentionInput } from '../../src/modules/system/prune.js';
import { TEST_TZ } from '../helpers/env.js';

// Nightly backups run at 03:00 Toronto = 08:00 UTC (EST) — the exact hour is irrelevant here.
const nightlyAt = (date: string) => `${date}T08:00:00Z`;

function simulateNightly(startDate: string, days: number): { runs: RetentionInput[]; now: Date } {
  let live: RetentionInput[] = [];
  let now = new Date();
  for (let i = 0; i < days; i++) {
    const date = addDays(startDate, i);
    now = new Date(nightlyAt(date));
    live.push({ id: i + 1, kind: 'nightly', startedAt: nightlyAt(date), verified: true });
    const plan = planRetention(live, DEFAULT_BACKUP_RETENTION, TEST_TZ, now);
    live = live.filter((r) => !plan.remove.includes(r.id));
  }
  return { runs: live, now };
}

describe('backup retention (2 daily / 4 weekly / 6 monthly)', () => {
  it('keeps everything while there are only two backups', () => {
    const runs: RetentionInput[] = [
      { id: 1, kind: 'nightly', startedAt: nightlyAt('2026-11-10'), verified: true },
      { id: 2, kind: 'nightly', startedAt: nightlyAt('2026-11-11'), verified: true },
    ];
    const plan = planRetention(runs, DEFAULT_BACKUP_RETENTION, TEST_TZ, new Date(nightlyAt('2026-11-11')));
    expect(plan.remove).toEqual([]);
  });

  it('labels each kept backup with its longest-lived tier', () => {
    // Wed 2026-11-11. Week starts Mon 11-09; month starts 11-01.
    const dates = ['2026-11-01', '2026-11-02', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11'];
    const runs = dates.map((d, i): RetentionInput => ({ id: i + 1, kind: 'nightly', startedAt: nightlyAt(d), verified: true }));
    const plan = planRetention(runs, DEFAULT_BACKUP_RETENTION, TEST_TZ, new Date(nightlyAt('2026-11-11')));
    expect(plan.keep.get(1)).toBe('monthly'); // first of November (also first of ISO week 44)
    expect(plan.keep.get(2)).toBe('weekly'); // first of week 45 (Mon 11-02)
    expect(plan.keep.get(4)).toBe('weekly'); // first of week 46 (Mon 11-09)
    expect(plan.keep.get(5)).toBe('daily');
    expect(plan.keep.get(6)).toBe('daily');
    expect(plan.remove).toEqual([3]); // Sun 11-08: not first of its week, not among the newest two
  });

  it('converges to the expected set after a year of nightly backups', () => {
    const { runs, now } = simulateNightly('2026-01-01', 365); // last run: 2026-12-31 (Thu)
    const dates = runs.map((r) => r.startedAt.slice(0, 10)).sort();
    expect(dates).toEqual([
      '2026-07-01', // monthly ×6: Jul..Dec
      '2026-08-01',
      '2026-09-01',
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
      '2026-12-07', // weekly ×4: ISO weeks 50, 51, 52, 53 (Mondays)
      '2026-12-14',
      '2026-12-21',
      '2026-12-28',
      '2026-12-30', // daily ×2
      '2026-12-31',
    ]);
    // Stable: planning again removes nothing more.
    expect(planRetention(runs, DEFAULT_BACKUP_RETENTION, TEST_TZ, now).remove).toEqual([]);
  });

  it('never keeps more than daily + weekly + monthly nightly backups, at any point', () => {
    let live: RetentionInput[] = [];
    for (let i = 0; i < 500; i++) {
      const date = addDays('2025-06-15', i);
      live.push({ id: i + 1, kind: 'nightly', startedAt: nightlyAt(date), verified: true });
      const plan = planRetention(live, DEFAULT_BACKUP_RETENTION, TEST_TZ, new Date(nightlyAt(date)));
      live = live.filter((r) => !plan.remove.includes(r.id));
      expect(live.length).toBeLessThanOrEqual(12);
      expect(live.at(-1)!.id).toBe(i + 1); // the newest verified backup always survives
    }
  });

  it('does not count failed backups and never removes the newest verified one', () => {
    const runs: RetentionInput[] = [
      { id: 1, kind: 'nightly', startedAt: nightlyAt('2026-03-01'), verified: true },
      ...[2, 3, 4, 5, 6].map((d): RetentionInput => ({ id: d, kind: 'nightly', startedAt: nightlyAt(`2026-11-0${d}`), verified: false })),
    ];
    const plan = planRetention(runs, DEFAULT_BACKUP_RETENTION, TEST_TZ, new Date(nightlyAt('2026-11-11')));
    expect(plan.keep.has(1)).toBe(true); // months old, outside every window — but it is the newest verified
    expect([...plan.keep.keys()]).toEqual([1]);
    expect(plan.keepFailed).toEqual([6, 5, 4]); // newest three failures kept for inspection
    expect(plan.remove.sort()).toEqual([2, 3]);
  });

  it('keeps the newest three safety snapshots of each kind, independent of nightly tiers', () => {
    const runs: RetentionInput[] = [];
    let id = 0;
    for (const kind of ['manual', 'pre_migration', 'pre_import'] as const) {
      for (let d = 1; d <= 5; d++) runs.push({ id: ++id, kind, startedAt: `2026-10-0${d}T12:00:00Z`, verified: true });
    }
    runs.push({ id: id + 1, kind: 'nightly', startedAt: nightlyAt('2026-11-11'), verified: true });
    const plan = planRetention(runs, DEFAULT_BACKUP_RETENTION, TEST_TZ, new Date(nightlyAt('2026-11-11')));
    const keptSafety = [...plan.keep.entries()].filter(([, tier]) => tier === 'safety').map(([i]) => i);
    expect(keptSafety.sort((a, b) => a - b)).toEqual([3, 4, 5, 8, 9, 10, 13, 14, 15]);
    expect(plan.remove.sort((a, b) => a - b)).toEqual([1, 2, 6, 7, 11, 12]);
  });

  it('respects edited retention settings', () => {
    const { runs } = simulateNightly('2026-01-01', 60);
    const plan = planRetention(runs, { daily: 1, weekly: 0, monthly: 0 }, TEST_TZ, new Date(nightlyAt('2026-03-01')));
    expect(plan.keep.size).toBe(1);
  });
});
