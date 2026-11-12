import { describe, expect, it } from 'vitest';
import type { LedgerEntryView, MemberDetail, PaymentList, PaymentView } from '@subscriberr/shared';
import { addDays } from '@subscriberr/shared';
import { silentLogger } from '../../src/core/logger.js';
import { forWorkspace } from '../../src/core/workspace-context.js';
import { seedDemo } from '../../src/db/seed-demo.js';
import { recordManualAdjust, recordManualPayment, recordManualSet, verifyLedger, voidPayment } from '../../src/modules/billing/ledger.js';
import { FakeGmail } from '../../src/modules/gmail/fake.js';
import { runDaily } from '../../src/modules/jobs/daily.js';
import { runIntegrityCheck } from '../../src/modules/system/integrity.js';
import { createServices } from '../../src/wiring.js';
import { DEFAULT_BUILTIN_DIR } from '../../src/modules/email/packs.js';
import { createWorld, insertAccount, testApp } from '../helpers/env.js';
import { CSRF, cookieFrom } from '../helpers/http.js';

async function setup(start = '2026-11-12T15:00:00Z') {
  const world = createWorld({ start });
  seedDemo(world.db, world.clock.now(), 'America/Toronto');
  const inbox = await FakeGmail.fromFixtures();
  const { app, services } = testApp(world, { gmail: async () => inbox });
  const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: '{}' });
  const cookie = cookieFrom(res, 'subscriberr_session')!;
  const json = async <T>(p: string, init: { method?: string; body?: unknown } = {}, status = 200): Promise<T> => {
    const r = await app.request(p, { method: init.method ?? 'GET', headers: { ...CSRF, cookie }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const text = await r.text();
    expect(r.status, `${init.method ?? 'GET'} ${p}: ${text.slice(0, 300)}`).toBe(status);
    return JSON.parse(text) as T;
  };
  const member = (id: number) => json<MemberDetail>(`/api/members/${id}`);
  return { world, app, json, member, services, ws: forWorkspace(world.ctx, 1) };
}

describe('ingested payments are applied (Spec §8.2)', () => {
  it('extends matched auto-deposits through the ledger; awaiting deposits change nothing', async () => {
    const { json, member, world } = await setup();
    await json('/api/payments/scan', { method: 'POST' });
    // Payer One: $10 on a $10 plan, Nov 1 → paid through Dec 1, active.
    expect(await member(1)).toMatchObject({ paidThrough: '2026-12-01', creditCents: 0, status: 'active', lastPaymentAt: '2026-11-01T13:36:40Z' });
    // Pat: $30 on the $15 default, July 10 → 2 periods → Sep 8; long past grace by Nov 12.
    expect(await member(2)).toMatchObject({ paidThrough: '2026-09-08', status: 'expired' });
    // Sam Payer: awaiting deposit → no extension.
    expect(await member(3)).toMatchObject({ paidThrough: null, status: 'expired' });
    expect(world.db.prepare(`SELECT kind, payment_id, amount_cents, plan_amount_snapshot_cents, period_days_snapshot, periods_applied FROM ledger_entries ORDER BY effective_at`).all()).toEqual([
      { kind: 'payment', payment_id: 2, amount_cents: 3000, plan_amount_snapshot_cents: 1500, period_days_snapshot: 30, periods_applied: 2 },
      { kind: 'payment', payment_id: 3, amount_cents: 1000, plan_amount_snapshot_cents: 1000, period_days_snapshot: 30, periods_applied: 1 },
    ]);
    // A rescan never applies twice.
    await json('/api/payments/rescan', { method: 'POST', body: { since: '2017-01-01', dryRun: false } });
    expect(world.db.prepare('SELECT count(*) AS n FROM ledger_entries').get()).toEqual({ n: 2 });
    expect(verifyLedger(forWorkspace(world.ctx, 1))).toEqual([]);
  });

  it('underpaid and overpaid statuses; a member without a plan amount sends the payment to review', async () => {
    const { json, member, world } = await setup();
    await json('/api/workspace/settings', { method: 'PATCH', body: { memberDefaults: { planAmountCents: 4000, planPeriodDays: 30, currency: 'CAD', toleranceCents: 0, graceDays: 3 } } });
    await json('/api/members/1', { method: 'PATCH', body: { planAmountCents: 600 } });
    await json('/api/payments/scan', { method: 'POST' });
    const list = (await json<PaymentList>('/api/payments')).items;
    expect(list.find((p) => p.senderName === 'Pat')).toMatchObject({ status: 'underpaid' });
    expect(await member(2)).toMatchObject({ paidThrough: null, creditCents: 3000 });
    expect(list.find((p) => p.senderName === 'PAYER ONE')).toMatchObject({ status: 'overpaid' });
    expect(await member(1)).toMatchObject({ paidThrough: '2026-12-01', creditCents: 400 });

    // No plan amount anywhere → review, nothing applied.
    const world2 = await setup();
    world2.world.db.prepare(`UPDATE settings SET value = json_set(value, '$.planAmountCents', NULL) WHERE key = 'member_defaults'`).run();
    await world2.json('/api/payments/scan', { method: 'POST' });
    const pat = (await world2.json<PaymentList>('/api/payments?tab=review')).items.find((p) => p.senderName === 'Pat');
    expect(pat).toMatchObject({ status: 'needs_review', memberId: null, reviewReason: expect.stringMatching(/no plan amount/) });
    void world;
  });
});

describe('manual billing actions', () => {
  it('records a manual payment, voids it, adjusts and sets the balance, all audited and replayable', async () => {
    const { json, member, ws } = await setup();
    const p = await json<PaymentView>('/api/billing/payments', { method: 'POST', body: { memberId: 4, amountCents: 3000, date: '2026-11-10', note: 'cash' } }, 201);
    expect(p).toMatchObject({ status: 'manual', source: 'manual', memberId: 4 });
    expect(await member(4)).toMatchObject({ paidThrough: '2027-01-09', status: 'active' });

    await json(`/api/billing/payments/${p.id}/void`, { method: 'POST', body: { reason: '' } }, 400);
    expect(await json<PaymentView>(`/api/billing/payments/${p.id}/void`, { method: 'POST', body: { reason: 'entered twice' } })).toMatchObject({ status: 'voided', voidReason: 'entered twice' });
    expect(await member(4)).toMatchObject({ paidThrough: null, status: 'expired', lastPaymentAt: null });
    await json(`/api/billing/payments/${p.id}/void`, { method: 'POST', body: { reason: 'again' } }, 409);

    await json('/api/billing/members/4/set', { method: 'POST', body: { paidThrough: '2026-12-31', creditCents: 250, note: 'opening balance' } });
    expect(await json<MemberDetail>('/api/billing/members/4/adjust', { method: 'POST', body: { days: 5, creditCents: -50, note: 'goodwill' } })).toMatchObject({ paidThrough: '2027-01-05', creditCents: 200 });
    await json('/api/billing/members/4/adjust', { method: 'POST', body: { creditCents: -500, note: 'too much' } }, 400);
    await json('/api/billing/members/4/adjust', { method: 'POST', body: { note: 'nothing' } }, 400);

    const ledger = (await json<{ items: LedgerEntryView[] }>('/api/billing/members/4/ledger')).items;
    expect(ledger.map((e) => [e.kind, e.reversed])).toEqual([
      ['manual_adjust', false],
      ['manual_set', false],
      ['void', false],
      ['payment', true],
    ]);
    expect((await member(4)).timeline.map((e) => e.action)).toEqual(expect.arrayContaining(['payment.recorded', 'payment.applied', 'payment.voided', 'ledger.voided', 'ledger.manual_set', 'ledger.manual_adjust']));
    expect(verifyLedger(ws)).toEqual([]);
  });

  it('Mark as deposited applies the pending transfer with a corrected amount and date; unmarked ones expire', async () => {
    const { json, member, world } = await setup();
    await json('/api/payments/scan', { method: 'POST' });
    const sam = (await json<PaymentList>('/api/payments?tab=awaiting')).items[0]!;
    expect(sam).toMatchObject({ senderName: 'Sam Payer', status: 'pending_deposit', memberId: 3 });
    await json(`/api/billing/payments/${sam.id}/deposited`, { method: 'POST', body: { amountCents: 3000, date: '2026-11-12' } });
    expect(await json<PaymentView>(`/api/payments/${sam.id}`)).toMatchObject({ status: 'matched', amountCents: 3000, reference: 'CA0TEST1' });
    expect(await member(3)).toMatchObject({ paidThrough: '2027-01-11', status: 'active' });
    await json(`/api/billing/payments/${sam.id}/deposited`, { method: 'POST', body: {} }, 409);

    // A second pending transfer that is never deposited expires in the daily run.
    world.db
      .prepare(
        `INSERT INTO payments (account_id, member_id, amount_cents, received_at, sender_name, message_type, expires_on, status, source, created_at)
         VALUES (1, 4, 1500, '2026-11-01T00:00:00Z', 'JORDAN EXAMPLE', 'awaiting_deposit', '2026-11-11', 'pending_deposit', 'gmail', '2026-11-01T00:00:00Z')`,
      )
      .run();
    const services = createServices({ clock: world.clock, log: silentLogger, packs: { builtinDir: DEFAULT_BUILTIN_DIR, workspacesDir: world.workspacesDir } });
    world.clock.set('2026-11-12T14:30:00Z'); // 09:30 in Toronto
    const out = await runDaily(world.ctx, world.clock, silentLogger, services.dailySteps);
    expect(out['workspace 1']).toMatchObject({ 'expire-pending-deposits': { expired: 1 } });
    expect((await json<PaymentList>('/api/payments?status=expired')).items).toHaveLength(1);
    expect((await member(4)).timeline.map((e) => e.action)).toContain('payment.deposit_expired');
    // Once per local day.
    expect(await runDaily(world.ctx, world.clock, silentLogger, services.dailySteps)).toEqual({});
  });

  it('the daily run moves members into grace and then expired as days pass (§8.3)', async () => {
    const { json, member, world } = await setup('2026-11-30T15:00:00Z');
    await json('/api/billing/members/1/set', { method: 'POST', body: { paidThrough: '2026-11-30', note: 'test' } });
    expect((await member(1)).status).toBe('active');
    const services = createServices({ clock: world.clock, log: silentLogger, packs: { builtinDir: DEFAULT_BUILTIN_DIR, workspacesDir: world.workspacesDir } });
    const statusOn = async (instant: string) => {
      world.clock.set(instant);
      await runDaily(world.ctx, world.clock, silentLogger, services.dailySteps);
      return (await member(1)).status;
    };
    expect(await statusOn('2026-12-01T15:00:00Z')).toBe('grace');
    expect(await statusOn('2026-12-03T15:00:00Z')).toBe('grace'); // paid_through + 3 grace days
    expect(await statusOn('2026-12-04T15:00:00Z')).toBe('expired');
    expect(await statusOn('2026-12-05T08:00:00Z')).toBe('expired'); // before 09:00 local: not run yet
  });
});

describe('ledger invariants (Spec §6.5a, §6.9, §17)', () => {
  it('property: random payments, voids, adjustments and sets always replay to the cached state', () => {
    const world = createWorld({ start: '2026-01-01T15:00:00Z' });
    const accountId = insertAccount(world.db, 'prop@example.com');
    world.db.prepare(`INSERT INTO settings (account_id, key, value) VALUES (?, 'member_defaults', ?)`).run(accountId, JSON.stringify({ planAmountCents: 1500, planPeriodDays: 30, currency: 'CAD', toleranceCents: 100, graceDays: 3 }));
    const ws = forWorkspace(world.ctx, accountId);
    const deps = { clock: world.clock };
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let memberN = 0; memberN < 8; memberN++) {
      const memberId = Number(world.db.prepare(`INSERT INTO members (account_id, display_name, created_at, updated_at) VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run(accountId, `M${memberN}`).lastInsertRowid);
      const payments: number[] = [];
      for (let step = 0; step < 25; step++) {
        world.clock.advanceDays(rand(9));
        const date = world.clock.now().toISOString().slice(0, 10);
        const op = rand(10);
        if (op < 5) payments.push(recordManualPayment(ws, deps, 'admin:t', { memberId, amountCents: 500 + rand(4000), date: addDays(date, -rand(20)), note: null }));
        else if (op < 7 && payments.length > 0) {
          const target = payments.splice(rand(payments.length), 1)[0]!;
          voidPayment(ws, deps, 'admin:t', target, 'random void');
        } else if (op < 9) {
          const credit = -rand(300);
          const current = (world.db.prepare('SELECT credit_cents FROM members WHERE id = ?').get(memberId) as { credit_cents: number }).credit_cents;
          recordManualAdjust(ws, deps, 'admin:t', memberId, { days: rand(15) - 5 || 1, creditCents: Math.max(credit, -current), note: 'random' });
        } else recordManualSet(ws, deps, 'admin:t', memberId, { creditCents: rand(2000), note: 'random set' });
      }
    }
    expect(verifyLedger(ws)).toEqual([]);
    for (const m of world.db.prepare('SELECT credit_cents FROM members WHERE account_id = ?').all(accountId) as Array<{ credit_cents: number }>) expect(m.credit_cents).toBeGreaterThanOrEqual(0);
  });

  it('the nightly verification detects a corrupted cache and never fixes it', async () => {
    const { json, world } = await setup();
    await json('/api/payments/scan', { method: 'POST' });
    expect(runIntegrityCheck(world.ctx, world.clock)).toMatchObject({ ok: true, problems: [] });
    world.db.prepare(`UPDATE members SET paid_through = '2099-01-01' WHERE id = 1`).run();
    const result = runIntegrityCheck(world.ctx, world.clock);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/member #1, paid_through: cached "2099-01-01" ≠ replayed "2026-12-01"/);
    expect(world.db.prepare('SELECT paid_through FROM members WHERE id = 1').get()).toEqual({ paid_through: '2099-01-01' });
    const status = await json<{ integrity: { ok: boolean; problems: string[] } }>('/api/system/status');
    expect(status.integrity).toMatchObject({ ok: false });
  });

  it('billing is workspace-scoped', async () => {
    const { app, world } = await setup();
    insertAccount(world.db, 'other@example.com', 'operator');
    world.db.prepare(`INSERT INTO allowed_accounts (account_id, email, added_by, created_at) VALUES (1, 'other@example.com', 't', '2026-01-01T00:00:00Z')`).run();
    const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: JSON.stringify({ email: 'other@example.com' }) });
    const other = { ...CSRF, cookie: cookieFrom(res, 'subscriberr_session')! };
    for (const [p, body] of [
      ['/api/billing/payments', { memberId: 1, amountCents: 100, date: '2026-11-01' }],
      ['/api/billing/members/1/set', { paidThrough: '2030-01-01', note: 'x' }],
      ['/api/billing/members/1/adjust', { days: 5, note: 'x' }],
    ] as const) {
      expect((await app.request(p, { method: 'POST', headers: other, body: JSON.stringify(body) })).status, p).toBe(404);
    }
    expect((await app.request('/api/billing/members/1/ledger', { headers: other })).status).toBe(404);
  });
});
