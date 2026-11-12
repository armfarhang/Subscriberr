import { describe, expect, it } from 'vitest';
import type { Dashboard, JobInfo, LogLine, MemberDetail } from '@subscriberr/shared';
import { createLogBuffer, createLogger } from '../../src/core/logger.js';
import { Scheduler } from '../../src/modules/jobs/scheduler.js';
import { allowEmail, createWorld, testApp } from '../helpers/env.js';
import { CSRF, cookieFrom } from '../helpers/http.js';

// M10: dashboard numbers, System jobs / logs, and the backup download (Spec §13.1 #2, #11).

const DEFAULTS = { planAmountCents: 1500, planPeriodDays: 30, currency: 'CAD', toleranceCents: 0, graceDays: 3 };

async function setup() {
  const world = createWorld({ start: '2026-11-12T15:00:00Z' });
  const logBuffer = createLogBuffer(50);
  const log = createLogger('info', logBuffer.tee(() => {}));
  const scheduler = new Scheduler(world.ctx, world.clock, log);
  let ran = 0;
  scheduler.register({ name: 'test-job', cron: '0 3 * * *', run: async () => ({ ran: ++ran }) });
  scheduler.register({
    name: 'broken-job',
    run: async () => {
      throw new Error('boom');
    },
  });
  const { app } = testApp(world, { scheduler, logBuffer });
  const login = async (email: string) => {
    const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: JSON.stringify({ email }) });
    expect(res.status).toBe(200);
    return cookieFrom(res, 'subscriberr_session')!;
  };
  const owner = await login('owner@example.com');
  const call = (cookie: string, p: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(p, { method: init.method ?? 'GET', headers: { ...CSRF, cookie }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const json = async <T>(cookie: string, p: string, init: { method?: string; body?: unknown } = {}, status = 200): Promise<T> => {
    const res = await call(cookie, p, init);
    const body = (await res.json()) as T;
    expect(res.status, `${init.method ?? 'GET'} ${p}: ${JSON.stringify(body)}`).toBe(status);
    return body;
  };
  await json(owner, '/api/workspace/settings', { method: 'PATCH', body: { memberDefaults: DEFAULTS } });
  return { world, app, owner, login, call, json, log };
}

describe('dashboard (Spec §13.1 #2)', () => {
  it('counts statuses, lists who is due soon and sums this month’s payments', async () => {
    const { owner, json } = await setup();
    const create = (displayName: string) => json<MemberDetail>(owner, '/api/members', { method: 'POST', body: { displayName } }, 201);
    const soon = await create('Due in 2 days');
    const later = await create('Due in 20 days');
    await create('Never paid'); // expired
    await json(owner, `/api/billing/members/${soon.id}/set`, { method: 'POST', body: { paidThrough: '2026-11-14', note: 'opening' } });
    await json(owner, `/api/billing/members/${later.id}/set`, { method: 'POST', body: { paidThrough: '2026-12-02', note: 'opening' } });
    await json(owner, '/api/billing/payments', { method: 'POST', body: { memberId: later.id, amountCents: 1500, date: '2026-11-10', note: null } }, 201);

    const d = await json<Dashboard>(owner, '/api/dashboard');
    expect(d.today).toBe('2026-11-12');
    expect(d.counts).toMatchObject({ active: 2, expired: 1, grace: 0, dueSoon: 1 });
    expect(d.dueSoon).toEqual([{ id: soon.id, displayName: 'Due in 2 days', paidThrough: '2026-11-14', dueInDays: 2 }]);
    expect(d.paymentsThisMonth).toEqual({ count: 1, totalCents: 1500, currency: 'CAD' });
    expect(d.reviewQueue).toBe(0);
    expect(d.emailQueue).toMatchObject({ cap: expect.any(Number) });
    expect(d.gmail).toMatchObject({ status: 'disconnected', scan: { lastScanAt: null, running: false } });
  });

  it('is scoped to the signed-in workspace', async () => {
    const { owner, json, world, login } = await setup();
    await json(owner, '/api/members', { method: 'POST', body: { displayName: 'Owner member' } }, 201);
    allowEmail(world.db, 'operator@example.com');
    const op = await login('operator@example.com');
    const d = await json<Dashboard>(op, '/api/dashboard');
    expect(Object.values(d.counts).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('System: jobs, logs, backup download (Spec §13.1 #11)', () => {
  it('lists jobs with their last run and runs one now (Owner only)', async () => {
    const { owner, json, call, world, login } = await setup();
    let jobs = (await json<{ items: JobInfo[] }>(owner, '/api/system/jobs')).items;
    expect(jobs.map((j) => [j.name, j.schedule, j.lastRun])).toEqual([
      ['test-job', '0 3 * * *', null],
      ['broken-job', null, null],
    ]);
    expect(await json(owner, '/api/system/jobs/test-job/run', { method: 'POST' })).toMatchObject({ status: 'ok', stats: { ran: 1 } });
    expect(await json(owner, '/api/system/jobs/broken-job/run', { method: 'POST' })).toMatchObject({ status: 'error', error: 'boom' });
    jobs = (await json<{ items: JobInfo[] }>(owner, '/api/system/jobs')).items;
    expect(jobs[0]!.lastRun).toMatchObject({ status: 'ok', stats: { ran: 1 } });
    expect(jobs[1]!.lastError).toMatchObject({ error: 'boom' });
    expect((await call(owner, '/api/system/jobs/nope/run', { method: 'POST' })).status).toBe(404);

    allowEmail(world.db, 'operator@example.com');
    const op = await login('operator@example.com');
    expect((await call(op, '/api/system/jobs')).status).toBe(403);
    expect((await call(op, '/api/system/jobs/test-job/run', { method: 'POST' })).status).toBe(403);
    expect((await call(op, '/api/system/logs')).status).toBe(403);
  });

  it('shows recent log lines, newest first, filtered by level', async () => {
    const { owner, json, log } = await setup();
    log.info('hello', { a: 1 });
    log.error('it broke', { job: 'x' });
    const all = (await json<{ items: LogLine[] }>(owner, '/api/system/logs')).items;
    expect(all.slice(0, 2).map((l) => l.msg)).toEqual(['it broke', 'hello']);
    expect(all[1]!.fields).toEqual({ a: 1 });
    const errors = (await json<{ items: LogLine[] }>(owner, '/api/system/logs?level=error')).items;
    expect(errors.every((l) => l.level === 'error')).toBe(true);
    expect(errors.map((l) => l.msg)).toContain('it broke');
  });

  it('downloads a verified backup as a zip (Owner only, audited)', async () => {
    const { owner, json, call, world, login } = await setup();
    const { run } = await json<{ run: { id: number; file: string } }>(owner, '/api/system/backups', { method: 'POST' }, 201);
    const res = await call(owner, `/api/system/backups/${run.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${run.file}"`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]); // "PK"
    const audit = world.db.prepare(`SELECT details FROM audit_log WHERE action = 'backup.downloaded'`).get() as { details: string };
    expect(JSON.parse(audit.details)).toMatchObject({ backupId: run.id });

    expect((await call(owner, '/api/system/backups/9999/download')).status).toBe(404);
    allowEmail(world.db, 'operator@example.com');
    const op = await login('operator@example.com');
    expect((await call(op, `/api/system/backups/${run.id}/download`)).status).toBe(403);
  });
});

describe('members list quick action: send reminder (Spec §13.1 #3)', () => {
  it('queues one reminder for a member with a due date and an email, once per day', async () => {
    const { owner, json, world } = await setup();
    const m = await json<MemberDetail>(owner, '/api/members', { method: 'POST', body: { displayName: 'Remind me', email: 'remind@example.com' } }, 201);
    expect(await json(owner, `/api/email/members/${m.id}/remind`, { method: 'POST' })).toEqual({ queued: false, reason: 'this member has no due date yet' });

    await json(owner, `/api/billing/members/${m.id}/set`, { method: 'POST', body: { paidThrough: '2026-11-15', note: 'opening' } });
    expect(await json(owner, `/api/email/members/${m.id}/remind`, { method: 'POST' })).toEqual({ queued: true });
    expect(await json(owner, `/api/email/members/${m.id}/remind`, { method: 'POST' })).toEqual({ queued: false, reason: 'already queued' });
    const row = world.db.prepare(`SELECT kind, to_address, subject FROM email_queue WHERE member_id = ?`).all(m.id) as Array<{ kind: string; to_address: string }>;
    expect(row).toEqual([expect.objectContaining({ kind: 'reminder', to_address: 'remind@example.com' })]);
    const timeline = (await json<MemberDetail>(owner, `/api/members/${m.id}`)).timeline.map((e) => e.action);
    expect(timeline).toContain('email.reminder_requested');
  });

  it('refuses a member of another workspace', async () => {
    const { owner, json, call, world, login } = await setup();
    const m = await json<MemberDetail>(owner, '/api/members', { method: 'POST', body: { displayName: 'Not yours', email: 'x@example.com' } }, 201);
    allowEmail(world.db, 'operator@example.com');
    const op = await login('operator@example.com');
    expect((await call(op, `/api/email/members/${m.id}/remind`, { method: 'POST' })).status).toBe(404);
  });
});
