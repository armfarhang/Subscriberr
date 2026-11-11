import { Hono } from 'hono';
import { conflict } from '../../core/errors.js';
import { requireOwner } from '../../http/middleware.js';
import type { AppDeps, AppEnv } from '../../http/types.js';
import { listBackupRuns, runBackup } from './backup.js';
import { getSystemStatus } from './status.js';

/** /api/system — status and backups. Restore is intentionally NOT exposed here (CLI only, §6.9). */
export function systemRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  let manualBackupRunning = false;

  app.get('/status', (c) =>
    c.json(
      getSystemStatus({
        ctx: deps.ctx,
        clock: deps.clock,
        appVersion: deps.backupEnv.appVersion,
        demoMode: deps.config.seedDemo,
        dataDir: deps.config.dataDir,
        backupDir: deps.config.backupDir,
      }),
    ),
  );

  // Backups are global (they contain every workspace), so only the Owner sees or creates them.
  app.get('/backups', requireOwner, (c) => c.json({ items: listBackupRuns(deps.ctx) }));

  app.post('/backups', requireOwner, async (c) => {
    if (manualBackupRunning) throw conflict('A backup is already running');
    manualBackupRunning = true;
    try {
      const result = await runBackup(deps.backupEnv, 'manual');
      const run = listBackupRuns(deps.ctx).find((r) => r.id === result.id);
      return c.json({ run }, result.outcome.verified ? 201 : 500);
    } finally {
      manualBackupRunning = false;
    }
  });

  return app;
}
