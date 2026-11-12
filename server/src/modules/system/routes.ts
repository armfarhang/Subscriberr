import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { conflict, notFound } from '../../core/errors.js';
import { backupRetentionSchema, type JobInfo } from '@subscriberr/shared';
import { writeAudit } from '../../core/audit.js';
import { actorOf, requireOwner, workspaceOf } from '../../http/middleware.js';
import type { AppDeps, AppEnv } from '../../http/types.js';
import { jsonBody } from '../../http/validate.js';
import { getBackupRetention, listBackupRuns, runBackup } from './backup.js';
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

  // Download one backup (§6.9). Backups are unencrypted and contain every workspace's personal
  // data, so this is Owner only and audited; the UI shows a privacy warning before the click.
  app.get('/backups/:id/download', requireOwner, (c) => {
    const id = Number(c.req.param('id'));
    const run = listBackupRuns(deps.ctx, 1000).find((r) => r.id === id);
    if (!run || !run.file || run.prunedAt || !run.verified) throw notFound('Backup not found (it may have been pruned)');
    // `file` is a bare file name written by the backup engine; refuse anything else.
    if (path.basename(run.file) !== run.file || !run.file.endsWith('.zip')) throw notFound('Backup not found');
    const full = path.join(deps.config.backupDir, run.file);
    let size: number;
    try {
      size = statSync(full).size;
    } catch {
      throw notFound('The backup file is missing from the backups folder');
    }
    const ws = workspaceOf(c);
    writeAudit(ws, deps.clock, { actor: actorOf(c), action: 'backup.downloaded', entity: 'workspace', entityId: ws.accountId, details: { backupId: id, file: run.file } });
    deps.log.info('backup downloaded', { backupId: id, file: run.file, by: actorOf(c) });
    return new Response(Readable.toWeb(createReadStream(full)) as ReadableStream, {
      headers: {
        'content-type': 'application/zip',
        'content-length': String(size),
        'content-disposition': `attachment; filename="${run.file}"`,
        'cache-control': 'no-store',
      },
    });
  });

  // Jobs (§11): every scheduled job with its latest run; "Run now" for the Owner. Jobs work across
  // all workspaces, so only the Owner sees or starts them.
  app.get('/jobs', requireOwner, (c) => {
    const latest = deps.ctx.sqlite.prepare('SELECT * FROM job_runs WHERE job = ? ORDER BY id DESC LIMIT 1');
    const lastError = deps.ctx.sqlite.prepare(`SELECT started_at, error FROM job_runs WHERE job = ? AND status = 'error' ORDER BY id DESC LIMIT 1`);
    const items: JobInfo[] = (deps.scheduler?.list() ?? []).map((j) => {
      const r = latest.get(j.name) as { id: number; started_at: string; finished_at: string | null; status: 'running' | 'ok' | 'error'; error: string | null; stats: string | null } | undefined;
      const e = lastError.get(j.name) as { started_at: string; error: string | null } | undefined;
      return {
        name: j.name,
        schedule: j.schedule,
        lastRun: r ? { id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, error: r.error, stats: r.stats ? (JSON.parse(r.stats) as Record<string, unknown>) : null } : null,
        lastError: e ? { startedAt: e.started_at, error: e.error ?? '' } : null,
      };
    });
    return c.json({ items });
  });

  app.post('/jobs/:name/run', requireOwner, async (c) => {
    const name = c.req.param('name');
    if (!deps.scheduler?.has(name)) throw notFound(`Unknown job "${name}"`);
    const ws = workspaceOf(c);
    writeAudit(ws, deps.clock, { actor: actorOf(c), action: 'job.run_now', entity: 'workspace', entityId: ws.accountId, details: { job: name } });
    return c.json(await deps.scheduler.runNow(name));
  });

  // Recent log lines kept in memory (newest first). They can mention any workspace → Owner only.
  app.get('/logs', requireOwner, (c) => {
    const level = c.req.query('level');
    const minLevel = level === 'error' || level === 'warn' || level === 'info' ? level : 'debug';
    return c.json({ items: deps.logBuffer?.lines({ minLevel, limit: 200 }) ?? [] });
  });

  // Backup retention (Settings, Owner only; default 2 daily / 4 weekly / 6 monthly).
  app.get('/backup-retention', requireOwner, (c) => c.json(getBackupRetention(deps.ctx)));
  app.put('/backup-retention', requireOwner, jsonBody(backupRetentionSchema), (c) => {
    const ws = workspaceOf(c);
    const value = c.req.valid('json');
    ws.sqlite.transaction(() => {
      ws.sqlite
        .prepare(`INSERT INTO settings (account_id, key, value) VALUES (?, 'backup_retention', ?) ON CONFLICT (account_id, key) DO UPDATE SET value = excluded.value`)
        .run(ws.accountId, JSON.stringify(value));
      writeAudit(ws, deps.clock, { actor: actorOf(c), action: 'backup_retention.updated', entity: 'workspace', entityId: ws.accountId, details: value });
    })();
    return c.json(getBackupRetention(deps.ctx));
  });

  return app;
}
