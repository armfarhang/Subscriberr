import { Cron } from 'croner';
import type { Logger } from '../../core/logger.js';
import { type Clock, nowIso } from '../../core/time.js';
import type { SystemContext } from '../../core/workspace-context.js';

// In-process scheduler (Spec §11): single-flight per job (per workspace), every run recorded in
// `job_runs`, and a "run now" entry point for the System page.

export interface JobDefinition {
  name: string;
  /** Cron pattern; omit for on-demand-only jobs. */
  cron?: string;
  timeZone?: string;
  run(): Promise<Record<string, unknown> | void>;
}

export interface JobRunSummary {
  id: number;
  status: 'ok' | 'error' | 'skipped';
  error?: string;
  stats?: Record<string, unknown>;
}

export class Scheduler {
  private readonly jobs = new Map<string, JobDefinition>();
  private readonly running = new Set<string>();
  private readonly crons: Cron[] = [];

  constructor(
    private readonly ctx: SystemContext,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  register(job: JobDefinition): void {
    if (this.jobs.has(job.name)) throw new Error(`Job "${job.name}" is already registered`);
    this.jobs.set(job.name, job);
  }

  names(): string[] {
    return [...this.jobs.keys()];
  }

  /** Registered jobs with their cron schedule (null = on demand only). */
  list(): Array<{ name: string; schedule: string | null }> {
    return [...this.jobs.values()].map((j) => ({ name: j.name, schedule: j.cron ?? null }));
  }

  has(name: string): boolean {
    return this.jobs.has(name);
  }

  /** Marks runs left in `running` by a previous process as failed, then starts the cron timers. */
  start(): void {
    this.ctx.sqlite
      .prepare(`UPDATE job_runs SET status = 'error', error = 'interrupted by restart', finished_at = ? WHERE status = 'running'`)
      .run(nowIso(this.clock));
    for (const job of this.jobs.values()) {
      if (!job.cron) continue;
      this.crons.push(
        new Cron(job.cron, { timezone: job.timeZone, protect: true }, () => {
          void this.runNow(job.name);
        }),
      );
    }
  }

  stop(): void {
    for (const c of this.crons) c.stop();
    this.crons.length = 0;
  }

  /** Runs a job unless it is already running (single-flight). Never throws. */
  async runNow(name: string, accountId: number | null = null): Promise<JobRunSummary> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Unknown job "${name}"`);
    const key = `${name}:${accountId ?? 'global'}`;
    if (this.running.has(key)) return { id: 0, status: 'skipped' };
    this.running.add(key);

    const id = Number(
      this.ctx.sqlite
        .prepare(`INSERT INTO job_runs (job, account_id, started_at, status) VALUES (?, ?, ?, 'running')`)
        .run(name, accountId, nowIso(this.clock)).lastInsertRowid,
    );
    const finish = this.ctx.sqlite.prepare('UPDATE job_runs SET status = ?, error = ?, stats = ?, finished_at = ? WHERE id = ?');
    try {
      const stats = (await job.run()) ?? undefined;
      finish.run('ok', null, stats ? JSON.stringify(stats) : null, nowIso(this.clock), id);
      return { id, status: 'ok', stats };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('job failed', { job: name, err });
      finish.run('error', message, null, nowIso(this.clock), id);
      return { id, status: 'error', error: message };
    } finally {
      this.running.delete(key);
    }
  }
}
