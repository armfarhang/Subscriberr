import { forWorkspace, type SystemContext } from '../../core/workspace-context.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { getWorkspaceSettings } from '../workspaces/settings.js';
import { getScanState, type IngestDeps, scanMailbox } from './ingest.js';

export const JOB_GMAIL_SCAN = 'gmail-scan';

/**
 * Gmail scan (Spec §7.1, §11): checks every minute which connected workspaces are due
 * (their own interval, default 5 min) and scans them one after another. One workspace's
 * failure never stops the others.
 */
export function registerPaymentJobs(scheduler: Scheduler, ctx: SystemContext, deps: IngestDeps, timeZone: string): void {
  scheduler.register({
    name: JOB_GMAIL_SCAN,
    cron: '* * * * *',
    timeZone,
    async run() {
      return runDueScans(ctx, deps);
    },
  });
}

export async function runDueScans(ctx: SystemContext, deps: IngestDeps): Promise<{ scanned: number; failed: number; stored: number }> {
  const accounts = ctx.sqlite.prepare(`SELECT id FROM accounts WHERE gmail_status = 'connected' ORDER BY id`).all() as Array<{ id: number }>;
  const now = deps.clock.now().getTime();
  const out = { scanned: 0, failed: 0, stored: 0 };
  for (const { id } of accounts) {
    const ws = forWorkspace(ctx, id);
    const state = getScanState(ws);
    const interval = getWorkspaceSettings(ws).scanning.intervalMinutes * 60_000;
    if (state.running || (state.lastScanAt && now - Date.parse(state.lastScanAt) < interval - 5_000)) continue;
    try {
      const result = await scanMailbox(ws, deps);
      out.scanned++;
      out.stored += result.stats.stored;
    } catch (err) {
      out.failed++;
      deps.log.warn('gmail scan failed', { accountId: id, err });
    }
  }
  return out;
}
