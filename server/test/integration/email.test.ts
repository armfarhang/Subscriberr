import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EmailQueueItem, EmailQueueStatus, PackDetail, PackSummary } from '@subscriberr/shared';
import { DEFAULT_EMAIL_SETTINGS } from '@subscriberr/shared';
import { silentLogger } from '../../src/core/logger.js';
import { forWorkspace } from '../../src/core/workspace-context.js';
import { seedDemo } from '../../src/db/seed-demo.js';
import { alertOwnerOfIntegrityProblems } from '../../src/modules/email/automated.js';
import { drainWorkspace } from '../../src/modules/email/drain.js';
import { DEFAULT_BUILTIN_DIR } from '../../src/modules/email/packs.js';
import { FakeGmail } from '../../src/modules/gmail/fake.js';
import { runDaily } from '../../src/modules/jobs/daily.js';
import { createServices } from '../../src/wiring.js';
import { allowEmail, createWorld, testApp } from '../helpers/env.js';
import { CSRF, cookieFrom } from '../helpers/http.js';
import { forgeEntryName, writeZip } from '../helpers/zip.js';

async function setup(start = '2026-11-03T15:00:00Z') {
  const world = createWorld({ start });
  seedDemo(world.db, world.clock.now(), 'America/Toronto');
  const inbox = await FakeGmail.fromFixtures();
  const { app } = testApp(world, { gmail: async () => inbox });
  const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: '{}' });
  const cookie = cookieFrom(res, 'subscriberr_session')!;
  const call = (p: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    app.request(p, { method: init.method ?? 'GET', headers: { ...CSRF, cookie, ...(init.headers ?? {}) }, body: init.body === undefined ? undefined : (init.body instanceof FormData ? init.body : JSON.stringify(init.body)) });
  const json = async <T>(p: string, init: { method?: string; body?: unknown } = {}, status = 200): Promise<T> => {
    const r = await call(p, init);
    const text = await r.text();
    expect(r.status, `${init.method ?? 'GET'} ${p}: ${text.slice(0, 400)}`).toBe(status);
    return JSON.parse(text) as T;
  };
  const queue = async (q = '') => (await json<{ items: EmailQueueItem[] }>(`/api/email/queue${q}`)).items;
  const ws = forWorkspace(world.ctx, 1);
  const drain = () => drainWorkspace(ws, { clock: world.clock, log: silentLogger, gmail: async () => inbox, throttleMs: 0 });
  return { world, app, call, json, queue, inbox, ws, drain };
}

describe('automated emails (Spec §9.3)', () => {
  it('a fresh payment queues a thank-you rendered with the active pack; old payments send nothing', async () => {
    // Nov 3: Payer One's Nov 1 payment is within the 3-day window; Pat's July payment is not.
    const { json, queue } = await setup();
    await json('/api/payments/scan', { method: 'POST' });
    const items = await queue();
    expect(items).toMatchObject([{ kind: 'thanks', memberName: 'Payer One', toAddress: 'payer1@example.com', status: 'queued', templatePack: 'default' }]);
    expect(items[0]!.subject).toBe("Thanks Payer One, you're paid through December 1, 2026");
    const full = await json<{ html: string; text: string }>(`/api/email/queue/${items[0]!.id}`);
    expect(full.text).toContain('$10.00');
    expect(full.html).toContain('December 1, 2026');
    // A rescan never queues it again (dedupe key per payment).
    await json('/api/payments/rescan', { method: 'POST', body: { since: '2017-01-01', dryRun: false } });
    expect(await queue()).toHaveLength(1);
  });

  it('an underpayment queues a deficit notice; opted-out members and members without email get nothing', async () => {
    const { json, queue, world } = await setup('2026-07-11T15:00:00Z');
    await json('/api/workspace/settings', { method: 'PATCH', body: { memberDefaults: { planAmountCents: 4000, planPeriodDays: 30, currency: 'CAD', toleranceCents: 0, graceDays: 3 } } });
    await json('/api/payments/scan', { method: 'POST' });
    const deficit = (await queue()).find((e) => e.kind === 'deficit')!;
    expect(deficit).toMatchObject({ memberName: 'Pat (cousin)', subject: 'We received $30.00, $10.00 short' });

    const before = (await queue()).length;
    world.db.prepare('UPDATE members SET emails_enabled = 0 WHERE id = 1').run();
    await json('/api/billing/payments', { method: 'POST', body: { memberId: 1, amountCents: 1000, date: '2026-07-11' } }, 201);
    await json('/api/billing/payments', { method: 'POST', body: { memberId: 5, amountCents: 4000, date: '2026-07-11' } }, 201); // Riley: no email
    expect(await queue()).toHaveLength(before);
  });

  it('reminders go out 7/3/1 days before, on the day and when overdue, once each; paying stops them', async () => {
    const { json, queue, world } = await setup('2026-11-03T15:00:00Z');
    await json('/api/billing/members/4/set', { method: 'POST', body: { paidThrough: '2026-11-10', note: 'test' } });
    const services = createServices({ clock: world.clock, log: silentLogger, packs: { builtinDir: DEFAULT_BUILTIN_DIR, workspacesDir: world.workspacesDir } });
    const day = async (date: string) => {
      world.clock.set(`${date}T15:00:00Z`);
      await runDaily(world.ctx, world.clock, silentLogger, services.dailySteps);
    };
    for (const d of ['2026-11-03', '2026-11-04', '2026-11-07', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-13']) await day(d);
    const reminders = (await queue('?kind=reminder')).map((e) => e.subject).reverse();
    expect(reminders).toEqual(['Your payment is due in 7 day(s)', 'Your payment is due in 3 day(s)', 'Your payment is due in 1 day(s)', 'Your payment is due', 'Your payment is due', 'Your payment is due']);
    // Forcing a second run on the same day does not duplicate anything.
    await runDaily(world.ctx, world.clock, silentLogger, services.dailySteps, { force: true });
    expect(await queue('?kind=reminder')).toHaveLength(6);
    // Paid: the due date moves, no reminder for the paid period.
    await json('/api/billing/payments', { method: 'POST', body: { memberId: 4, amountCents: 1500, date: '2026-11-13' } }, 201);
    await day('2026-11-14');
    expect(await queue('?kind=reminder')).toHaveLength(6);
  });

  it('settings: turning a kind off stops it; the "access paused" email is opt-in', async () => {
    const { json, queue, world } = await setup('2026-11-03T15:00:00Z');
    await json('/api/email/settings', { method: 'PUT', body: { ...DEFAULT_EMAIL_SETTINGS, enabled: { thanks: false, deficit: true, reminder: true, expired: true } } });
    await json('/api/payments/scan', { method: 'POST' });
    expect(await queue('?kind=thanks')).toEqual([]);
    await json('/api/billing/members/4/set', { method: 'POST', body: { paidThrough: '2026-11-01', note: 'test' } });
    world.clock.set('2026-11-05T15:00:00Z');
    const services = createServices({ clock: world.clock, log: silentLogger, packs: { builtinDir: DEFAULT_BUILTIN_DIR, workspacesDir: world.workspacesDir } });
    await runDaily(world.ctx, world.clock, silentLogger, services.dailySteps);
    expect((await queue('?kind=expired')).map((e) => e.memberName)).toEqual(['Jordan Example']);
  });
});

describe('the queue and the drainer (Spec §9.5)', () => {
  it('sends one message per recipient through Gmail, records it, and audits it on the member', async () => {
    const { json, queue, inbox, drain } = await setup();
    await json('/api/payments/scan', { method: 'POST' });
    expect(await drain()).toMatchObject({ sent: 1, failed: 0 });
    expect(inbox.sent).toHaveLength(1);
    const raw = inbox.sent[0]!.raw.toString();
    expect(raw).toContain('To: payer1@example.com');
    expect(raw).toContain('From: demo@example.com');
    expect(raw).toMatch(/multipart\/alternative/);
    expect(await queue()).toMatchObject([{ status: 'sent', sentAt: '2026-11-03T15:00:00Z' }]);
    const member = await json<{ timeline: Array<{ action: string }> }>('/api/members/1');
    expect(member.timeline.map((e) => e.action)).toContain('email.sent');
  });

  it('honours the rolling 24h cap, keeps a reserve for transactional mail and resumes as the window frees', async () => {
    const { json, ws, world, drain, inbox } = await setup();
    await json('/api/email/settings', { method: 'PUT', body: { ...DEFAULT_EMAIL_SETTINGS, dailyCap: 4, transactionalReserve: 2 } });
    const insert = (kind: string, priority: number, n: number) => {
      for (let i = 0; i < n; i++) {
        world.db
          .prepare(`INSERT INTO email_queue (account_id, kind, to_address, subject, html, text, priority, status, dedupe_key, created_at) VALUES (1, ?, 'x@example.com', ?, '<p>x</p>', 'x', ?, 'queued', ?, '2026-11-03T14:00:00Z')`)
          .run(kind, `${kind} ${i}`, priority, `${kind}-${i}`);
      }
    };
    insert('announcement', 50, 5);
    insert('reminder', 10, 1);
    // Transactional first; announcements may only fill the cap minus the reserve (4 − 2 = 2 sent in total).
    expect(await drain()).toMatchObject({ sent: 2 });
    expect(inbox.sent.map((s) => /Subject: (.*)/.exec(s.raw.toString())![1])).toEqual(['reminder 0', 'announcement 0']);
    insert('thanks', 10, 3);
    expect(await drain()).toMatchObject({ sent: 2 }); // transactional may use the reserve, but never exceeds the cap
    const status = await json<EmailQueueStatus>('/api/email/status');
    expect(status).toMatchObject({ sentLast24h: 4, cap: 4, queued: 5, queuedAnnouncements: 4 });
    expect(status.resumesAt).toBe('2026-11-04T15:00:00Z');
    world.clock.advanceMs(24 * 3_600_000 + 1000);
    expect(await drain()).toMatchObject({ sent: 2 }); // the window freed: 1 thanks + 1 announcement (up to the reserve again)
    expect(inbox.sent.map((s) => /Subject: (.*)/.exec(s.raw.toString())![1]).slice(-2)).toEqual(['thanks 2', 'announcement 1']);
    void ws;
  });

  it('retries temporary failures with backoff, fails permanent ones, and never resends an interrupted message', async () => {
    const { world, inbox, ws } = await setup();
    const insert = (key: string) =>
      world.db
        .prepare(`INSERT INTO email_queue (account_id, kind, to_address, subject, html, text, priority, status, dedupe_key, created_at) VALUES (1, 'test', 'x@example.com', 's', 'h', 't', 10, 'queued', ?, '2026-11-03T14:00:00Z')`)
        .run(key);
    insert('a');
    let failure: unknown = Object.assign(new Error('Backend Error'), { code: 503 });
    const flaky = { ...inbox, send: async () => Promise.reject(failure) } as unknown as FakeGmail;
    const run = () => drainWorkspace(ws, { clock: world.clock, log: silentLogger, gmail: async () => flaky, throttleMs: 0 });
    expect(await run()).toMatchObject({ retried: 1 });
    expect(world.db.prepare('SELECT status, attempts, not_before FROM email_queue').get()).toEqual({ status: 'queued', attempts: 1, not_before: '2026-11-03T15:02:00Z' });
    expect(await run()).toMatchObject({ retried: 0, sent: 0 }); // not due yet
    failure = Object.assign(new Error('Invalid To header'), { code: 400 });
    world.clock.advanceMs(3 * 60_000);
    expect(await run()).toMatchObject({ failed: 1 });
    expect(world.db.prepare('SELECT status, error FROM email_queue').get()).toEqual({ status: 'failed', error: 'Invalid To header' });

    world.db.prepare(`INSERT INTO email_queue (account_id, kind, to_address, subject, html, text, priority, status, dedupe_key, created_at, not_before) VALUES (1, 'test', 'y@example.com', 's', 'h', 't', 10, 'sending', 'stuck', '2026-11-03T14:00:00Z', '2026-11-03T14:00:00Z')`).run();
    await run();
    expect(world.db.prepare(`SELECT status, error FROM email_queue WHERE dedupe_key = 'stuck'`).get()).toMatchObject({ status: 'failed', error: expect.stringMatching(/Interrupted/) });
  });

  it('dry run shows what would be sent and sends nothing; retry and cancel work from the API', async () => {
    const { json, queue, drain, inbox } = await setup();
    await json('/api/email/settings', { method: 'PUT', body: { ...DEFAULT_EMAIL_SETTINGS, dryRun: true } });
    await json('/api/payments/scan', { method: 'POST' });
    expect(await drain()).toMatchObject({ dryRun: 1, sent: 0 });
    expect(inbox.sent).toEqual([]);
    const [item] = await queue();
    expect(item).toMatchObject({ status: 'cancelled', error: 'Dry run: not sent' });
    await json('/api/email/settings', { method: 'PUT', body: { ...DEFAULT_EMAIL_SETTINGS, dryRun: false } });
    await json(`/api/email/queue/${item!.id}/retry`, { method: 'POST' });
    await json(`/api/email/queue/${item!.id}/cancel`, { method: 'POST' });
    await json(`/api/email/queue/${item!.id}/cancel`, { method: 'POST' }, 409);
  });

  it('an integrity failure emails the Owner once per day', async () => {
    const { world, queue } = await setup();
    alertOwnerOfIntegrityProblems(world.ctx, world.clock, ['ledger: member #1 …']);
    alertOwnerOfIntegrityProblems(world.ctx, world.clock, ['ledger: member #1 …']);
    expect((await queue('?kind=test')).map((e) => [e.toAddress, e.subject])).toEqual([['demo@example.com', 'Subscriberr: the nightly integrity check found 1 problem(s)']]);
  });
});

describe('template packs (Spec §9.1)', () => {
  it('lists built-ins, duplicates to an editable custom pack, validates edits and switches the active pack', async () => {
    const { json, call } = await setup();
    const packs = (await json<{ items: PackSummary[] }>('/api/templates')).items;
    expect(packs.map((p) => [p.id, p.builtin, p.active])).toEqual([
      ['default', true, true],
      ['minimal', true, false],
    ]);
    await json('/api/templates/default/file', { method: 'PUT', body: { path: 'thanks.html', content: 'x' } }, 409);
    const custom = await json<PackDetail>('/api/templates', { method: 'POST', body: { fromPackId: 'default', name: 'Our Brand' } }, 201);
    expect(custom).toMatchObject({ id: 'custom-our-brand', name: 'Our Brand', builtin: false });

    const bad = await call('/api/templates/custom-our-brand/file', { method: 'PUT', body: { path: 'thanks.html', content: '<p>{{member.email}}<script>x</script></p>' } });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { details: Array<{ message: string }> } }).error.details.map((d) => d.message)).toEqual(expect.arrayContaining(['Unknown variable {{member.email}}', '<script> is not allowed']));
    await json('/api/templates/custom-our-brand/file', { method: 'PUT', body: { path: 'thanks.html', content: '<h1>Merci {{member.display_name}}</h1>' } });
    await json('/api/templates/custom-our-brand/activate', { method: 'POST' });
    await json('/api/templates/custom-our-brand/theme', { method: 'PUT', body: { values: { accent_color: 'red' } } }, 400);
    expect((await json<PackDetail>('/api/templates/custom-our-brand/theme', { method: 'PUT', body: { values: { header_color: '#000000' } } })).themeValues.header_color).toBe('#000000');

    const preview = await json<{ subject: string; html: string; problems: unknown[] }>('/api/templates/preview', { method: 'POST', body: { packId: 'custom-our-brand', kind: 'thanks' } });
    expect(preview.html).toContain('Merci Ann (neighbour)');
    expect(preview.html).toContain('background: #000000');
    const unsaved = await json<{ html: string; problems: Array<{ message: string }> }>('/api/templates/preview', { method: 'POST', body: { packId: 'default', kind: 'thanks', files: { 'thanks.html': '{{oops}}' } } });
    expect(unsaved.problems).toEqual([{ file: 'thanks.html', message: 'Unknown variable {{oops}}' }]);

    // Deleting the active pack falls back to the default.
    await json('/api/templates/default', { method: 'DELETE' }, 409);
    await json('/api/templates/custom-our-brand', { method: 'DELETE' });
    expect((await json<{ items: PackSummary[] }>('/api/templates')).items.find((p) => p.active)?.id).toBe('default');
  });

  it('downloads and re-uploads a pack as a zip; wraps a single .html layout; rejects zip-slip', async () => {
    const { call, json, app } = await setup();
    const zip = Buffer.from(await (await call('/api/templates/minimal/download')).arrayBuffer());
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    const cookie = (await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: '{}' })).headers.getSetCookie()[0]!.split(';')[0]!;
    const upload = (name: string, content: Buffer | string) => {
      const fd = new FormData();
      fd.append('file', new File([typeof content === 'string' ? content : new Uint8Array(content)], name));
      return app.request('/api/templates/upload', { method: 'POST', body: fd, headers: { 'x-requested-with': 'subscriberr', cookie } });
    };
    const r1 = await upload('minimal.zip', zip);
    expect(r1.status).toBe(201);
    expect(((await r1.json()) as PackDetail).id).toBe('custom-minimal');
    const r2 = await upload('brand.html', '<html><body><div>{{{content}}}</div><p>{{theme.footer_text}}</p></body></html>');
    expect(r2.status).toBe(201);
    expect(((await r2.json()) as PackDetail).id).toBe('custom-brand');
    expect((await upload('evil.html', '<html>{{{content}}}<script>x</script></html>')).status).toBe(422);

    const dir = mkdtempSync(path.join(os.tmpdir(), 'pack-zip-'));
    try {
      const file = path.join(dir, 'slip.zip');
      await writeZip(file, { 'pack.json': '{}', 'AAAAAAevil.html': 'x' });
      forgeEntryName(file, 'AAAAAAevil.html', '../../evil.html');
      const { readFileSync } = await import('node:fs');
      const r = await upload('slip.zip', readFileSync(file));
      expect(r.status).toBe(400);
      expect(await r.text()).toMatch(/Unsafe zip/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect((await json<{ items: PackSummary[] }>('/api/templates')).items).toHaveLength(4);
  });

  it('test send goes to the signed-in account; packs and queues are per workspace', async () => {
    const { json, app, world, queue } = await setup();
    expect(await json('/api/templates/default/test', { method: 'POST', body: { kind: 'reminder' } })).toEqual({ queued: true, to: 'demo@example.com' });
    expect((await queue('?kind=test'))[0]!.subject).toMatch(/^\[Test\] /);
    await json('/api/templates', { method: 'POST', body: { fromPackId: 'default', name: 'Mine' } }, 201);

    allowEmail(world.db, 'operator@example.com');
    const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: JSON.stringify({ email: 'operator@example.com' }) });
    const other = { ...CSRF, cookie: cookieFrom(res, 'subscriberr_session')! };
    expect((await app.request('/api/templates/custom-mine', { headers: other })).status).toBe(404);
    expect(((await (await app.request('/api/email/queue', { headers: other })).json()) as { items: unknown[] }).items).toEqual([]);
    const firstId = (await queue())[0]!.id;
    expect((await app.request(`/api/email/queue/${firstId}`, { headers: other })).status).toBe(404);
  });
});
