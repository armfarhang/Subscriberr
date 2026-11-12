import { localParts } from '@subscriberr/shared';
import type { Logger } from '../../core/logger.js';
import { type Clock, today } from '../../core/time.js';
import { forWorkspace, type SystemContext, type WorkspaceContext } from '../../core/workspace-context.js';
import { getWorkspaceSettings, readJsonSetting, writeJsonSetting } from '../workspaces/settings.js';
import type { Scheduler } from './scheduler.js';

// The per-workspace daily run (Spec §11): "status recompute + reminders + enforcement reconcile +
// expire stale pending deposits", at 09:00 in each workspace's own timezone. Modules add steps;
// each step runs once per local day per workspace, and a failing step never blocks the others.
// After downtime it catches up on the next tick (no double run: the last run date is stored).

export const JOB_DAILY = 'daily-workspace';
export const DAILY_HOUR = 9;
const LAST_RUN_KEY = 'daily_last_run';

export interface DailyStep {
  name: string;
  run(ws: WorkspaceContext): Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
}

export function registerDailyJob(scheduler: Scheduler, ctx: SystemContext, clock: Clock, log: Logger, steps: DailyStep[], timeZone: string): void {
  scheduler.register({
    name: JOB_DAILY,
    cron: '*/10 * * * *',
    timeZone,
    async run() {
      return runDaily(ctx, clock, log, steps);
    },
  });
}

export async function runDaily(ctx: SystemContext, clock: Clock, log: Logger, steps: DailyStep[], opts: { force?: boolean } = {}): Promise<Record<string, unknown>> {
  const accounts = ctx.sqlite.prepare('SELECT id FROM accounts ORDER BY id').all() as Array<{ id: number }>;
  const out: Record<string, unknown> = {};
  for (const { id } of accounts) {
    const ws = forWorkspace(ctx, id);
    const tz = getWorkspaceSettings(ws).timezone;
    const day = today(clock, tz);
    if (!opts.force && (localParts(clock.now(), tz).hour < DAILY_HOUR || readJsonSetting(ws, LAST_RUN_KEY) === day)) continue;
    const results: Record<string, unknown> = {};
    for (const step of steps) {
      try {
        results[step.name] = (await step.run(ws)) ?? 'ok';
      } catch (err) {
        results[step.name] = { error: err instanceof Error ? err.message : String(err) };
        log.error('daily step failed', { accountId: id, step: step.name, err });
      }
    }
    writeJsonSetting(ws, LAST_RUN_KEY, day);
    out[`workspace ${id}`] = results;
  }
  return out;
}
