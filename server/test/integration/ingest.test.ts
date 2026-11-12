import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PaymentList, PaymentView, RescanResult, RuleTestResult } from '@subscriberr/shared';
import { silentLogger } from '../../src/core/logger.js';
import { forWorkspace } from '../../src/core/workspace-context.js';
import { seedDemo } from '../../src/db/seed-demo.js';
import { FakeGmail } from '../../src/modules/gmail/fake.js';
import { GmailUnavailableError } from '../../src/modules/gmail/factory.js';
import { runDueScans } from '../../src/modules/payments/jobs.js';
import { allowEmail, createWorld, testApp } from '../helpers/env.js';
import { CSRF, cookieFrom } from '../helpers/http.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/etransfer');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));
const tamper = (name: string, edit: (s: string) => string) => Buffer.from(edit(fixture(name).toString('latin1')), 'latin1');

async function setup() {
  const world = createWorld({ start: '2026-11-12T15:00:00Z' });
  seedDemo(world.db, world.clock.now(), 'America/Toronto');
  const inboxes = new Map<number, FakeGmail>();
  const gmail = async (accountId: number) => {
    let inbox = inboxes.get(accountId);
    if (!inbox) {
      inbox = accountId === 1 ? await FakeGmail.fromFixtures() : new FakeGmail();
      inboxes.set(accountId, inbox);
    }
    return inbox;
  };
  const { app } = testApp(world, { gmail });
  const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: '{}' });
  const owner = cookieFrom(res, 'subscriberr_session')!;
  const json = async <T>(cookie: string, p: string, init: { method?: string; body?: unknown } = {}, status = 200): Promise<T> => {
    const r = await app.request(p, { method: init.method ?? 'GET', headers: { ...CSRF, cookie }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const text = await r.text();
    expect(r.status, `${init.method ?? 'GET'} ${p}: ${text.slice(0, 300)}`).toBe(status);
    return JSON.parse(text) as T;
  };
  // Look back far enough to include the 2017 fixture.
  await json(owner, '/api/workspace/settings', { method: 'PATCH', body: { scanning: { intervalMinutes: 5, senders: ['notify@payments.interac.ca'], reviewNewEmailForKnownName: false, initialLookbackDays: 5000 } } });
  const inbox = await gmail(1);
  const payments = async (tab = 'all') => (await json<PaymentList>(owner, `/api/payments?tab=${tab}`)).items;
  return { world, app, owner, json, inbox, gmail, payments };
}

describe('mailbox scan (Spec §7)', () => {
  it('stores the three Interac fixtures, ignores the bank alert, matches the demo members and labels the mail', async () => {
    const { owner, json, inbox, payments, world } = await setup();
    const result = await json<RescanResult>(owner, '/api/payments/scan', { method: 'POST' });
    expect(result.stats).toMatchObject({ messages: 3, stored: 3, matched: 2, pendingDeposit: 1, review: 0, errors: 0 });

    const list = await payments();
    const by = (name: string) => list.find((p) => p.senderName === name)!;
    expect(by('PAYER ONE')).toMatchObject({ status: 'matched', memberName: 'Payer One', matchedBy: 'name', amountCents: 1000, reference: 'C1AAAAAAAAA1', messageType: 'autodeposit', auth: { ok: true } });
    expect(by('Pat')).toMatchObject({ status: 'matched', memberName: 'Pat (cousin)', memo: 'july/ aug', amountCents: 3000 });
    expect(by('Sam Payer')).toMatchObject({ status: 'pending_deposit', memberName: 'Sam Payer', messageType: 'awaiting_deposit', expiresOn: '2017-09-04', memo: null });
    // The awaiting-deposit memo (security hint) is stored nowhere.
    expect(JSON.stringify(world.db.prepare('SELECT * FROM payments').all())).not.toMatch(/password/i);
    for (const id of ['fake-autodeposit-01', 'fake-autodeposit-with-memo-02', 'fake-legacy-sent-you-money-03']) {
      expect((await inbox.getMessage(id)).labels).toContain('Subscriberr/Processed');
    }
    expect((await inbox.getMessage('fake-outgoing-bank-alert-04')).labels).not.toContain('Subscriberr/Processed');
    expect(await json(owner, '/api/payments/scan')).toMatchObject({ lastError: null, lastSuccessAt: '2026-11-12T15:00:00Z' });
  });

  it('is idempotent: a second scan and a rescan from date add nothing; a dry run shows what would happen', async () => {
    const { owner, json, world } = await setup();
    await json(owner, '/api/payments/scan', { method: 'POST' });
    expect((await json<RescanResult>(owner, '/api/payments/scan', { method: 'POST' })).stats).toMatchObject({ messages: 0, stored: 0 });
    const dry = await json<RescanResult>(owner, '/api/payments/rescan', { method: 'POST', body: { since: '2017-01-01', dryRun: true } });
    expect(dry).toMatchObject({ dryRun: true, stats: { messages: 3, known: 3, stored: 0 } });
    expect((await json<RescanResult>(owner, '/api/payments/rescan', { method: 'POST', body: { since: '2017-01-01', dryRun: false } })).stats).toMatchObject({ known: 3, stored: 0 });
    expect(world.db.prepare('SELECT count(*) AS n FROM payments').get()).toEqual({ n: 3 });
  });

  it('a rescan of an emptied database rebuilds the payments (dry run first)', async () => {
    const { owner, json, inbox } = await setup();
    // Simulate mail that was already labelled Processed by an earlier install.
    for (const id of ['fake-autodeposit-01', 'fake-autodeposit-with-memo-02']) await inbox.addLabel(id, 'Subscriberr/Processed');
    expect((await json<RescanResult>(owner, '/api/payments/scan', { method: 'POST' })).stats.stored).toBe(1);
    const dry = await json<RescanResult>(owner, '/api/payments/rescan', { method: 'POST', body: { since: '2026-01-01', dryRun: true } });
    expect(dry.stats).toMatchObject({ messages: 2, stored: 2 });
    expect(dry.preview.map((p) => p.memberName)).toEqual(['Pat (cousin)', 'Payer One']);
    expect((await json<RescanResult>(owner, '/api/payments/rescan', { method: 'POST', body: { since: '2026-01-01', dryRun: false } })).stats.stored).toBe(2);
  });

  it('a second notice with a known reference is stored as a duplicate, and forged mail is rejected', async () => {
    const { owner, json, inbox, payments } = await setup();
    await inbox.addMessage('copy-of-01.eml', fixture('autodeposit_01.eml'));
    await inbox.addMessage('forged.eml', tamper('autodeposit_with_memo_02.eml', (s) => s.replace(/header\.i=@payments\.interac\.ca/g, 'header.i=@evil.example').replace(/C1BBBBBBBBB2/g, 'C1FORGED0001')));
    const r = await json<RescanResult>(owner, '/api/payments/scan', { method: 'POST' });
    expect(r.stats).toMatchObject({ stored: 5, duplicate: 1, rejected: 1 });
    const review = await payments('review');
    expect(review.map((p) => [p.status, p.reference])).toEqual(
      expect.arrayContaining([
        ['duplicate', 'C1AAAAAAAAA1'],
        ['rejected', 'C1FORGED0001'],
      ]),
    );
    const forged = review.find((p) => p.status === 'rejected')!;
    expect(forged).toMatchObject({ memberId: null, auth: { ok: false }, reviewReason: expect.stringMatching(/DKIM/) });
    expect((await inbox.getMessage('fake-forged')).labels).toContain('Subscriberr/NeedsReview');

    // Approving a rejected notice needs an explicit "verified in my bank".
    const p = await json<{ error: { details: unknown } }>(owner, `/api/payments/${forged.id}/resolve`, { method: 'POST', body: { action: 'assign', memberId: 2 } }, 400);
    expect(p.error.details).toEqual({ reason: 'verify_in_bank' });
    await json(owner, `/api/payments/${forged.id}/resolve`, { method: 'POST', body: { action: 'assign', memberId: 2, verifiedInBank: true } });
    const dup = review.find((p) => p.status === 'duplicate')!;
    await json(owner, `/api/payments/${dup.id}/resolve`, { method: 'POST', body: { action: 'assign', memberId: 1 } }, 409);
    await json(owner, `/api/payments/${dup.id}/resolve`, { method: 'POST', body: { action: 'dismiss', note: 'same notice twice' } });
    expect(await payments('review')).toEqual([]);
  });
});

describe('Review Queue, rules and learning (Spec §7.4, §7.5)', () => {
  it('shared names go to review; a memo rule and "re-run" resolves them; the tester explains', async () => {
    const { owner, json, inbox, payments } = await setup();
    // A second member who also sends e-Transfers as "Pat".
    const other = await json<{ id: number }>(owner, '/api/members', { method: 'POST', body: { displayName: 'Pat (aunt)', etransferName: 'PAT' } }, 201);
    await json(owner, '/api/payments/scan', { method: 'POST' });
    const pat = (await payments('review')).find((p) => p.senderName === 'Pat')!;
    expect(pat).toMatchObject({ status: 'needs_review', reviewReason: expect.stringMatching(/Shared name/) });

    const tested = await json<RuleTestResult>(owner, '/api/payments/rules/test', { method: 'POST', body: { paymentId: pat.id } });
    expect(tested.decision.status).toBe('needs_review');
    await json(owner, '/api/payments/rules', { method: 'POST', body: { memberId: 2, label: 'Summer months', memoMode: 'contains', memoValue: 'july' } }, 201);
    const after = await json<RuleTestResult>(owner, '/api/payments/rules/test', { method: 'POST', body: { paymentId: pat.id } });
    expect(after.decision).toMatchObject({ status: 'matched', memberName: 'Pat (cousin)', matchedBy: 'rule' });
    expect(after.rules.find((r) => r.label === 'Summer months')).toMatchObject({ matches: true });

    expect(await json(owner, '/api/payments/review/rerun', { method: 'POST' })).toEqual({ checked: 1, matched: 1 });
    expect(await json<PaymentView>(owner, `/api/payments/${pat.id}`)).toMatchObject({ status: 'matched', memberId: 2, matchedBy: 'rule', inReview: false });
    void other;
    void inbox;
  });

  it('unmatched senders can be assigned (remembering the sender) or dismissed; new reply-to emails are learned', async () => {
    const { owner, json, inbox, payments, world } = await setup();
    await inbox.addMessage(
      'stranger.eml',
      tamper('autodeposit_01.eml', (s) => s.replace(/PAYER ONE/g, 'NEW PERSON').replace(/C1AAAAAAAAA1/g, 'C1NEWNEW0001').replace(/payer1@example\.com/g, 'new.person@example.com')),
    );
    await inbox.addMessage(
      'payer-one-new-email.eml',
      tamper('autodeposit_01.eml', (s) => s.replace(/C1AAAAAAAAA1/g, 'C1AAAAAAAAA7').replace(/payer1@example\.com/g, 'payer.one.work@example.com')),
    );
    await json(owner, '/api/payments/scan', { method: 'POST' });
    const stranger = (await payments('review')).find((p) => p.senderName === 'NEW PERSON')!;
    expect(stranger).toMatchObject({ status: 'unmatched' });
    // Learned: Payer One paid from a new Reply-To address → email alias (source learned).
    expect(world.db.prepare(`SELECT value, source FROM member_aliases WHERE member_id = 1`).all()).toEqual([{ value: 'payer.one.work@example.com', source: 'learned' }]);

    await json(owner, `/api/payments/${stranger.id}/resolve`, { method: 'POST', body: { action: 'assign', memberId: 4, rememberSender: true } });
    expect(world.db.prepare(`SELECT kind, value FROM member_aliases WHERE member_id = 4 ORDER BY kind`).all()).toEqual(
      expect.arrayContaining([
        { kind: 'email', value: 'new.person@example.com' },
        { kind: 'name', value: 'new person' },
      ]),
    );
    expect(world.db.prepare(`SELECT action FROM audit_log WHERE action = 'payment.assigned'`).all()).toHaveLength(1);
  });

  it('with "review new emails" on, a known name from a new email waits for a decision', async () => {
    const { owner, json, inbox, payments } = await setup();
    await json(owner, '/api/workspace/settings', { method: 'PATCH', body: { scanning: { intervalMinutes: 5, senders: ['notify@payments.interac.ca'], reviewNewEmailForKnownName: true, initialLookbackDays: 5000 } } });
    await inbox.addMessage('new-email.eml', tamper('autodeposit_01.eml', (s) => s.replace(/C1AAAAAAAAA1/g, 'C1AAAAAAAAA8').replace(/payer1@example\.com/g, 'other@example.com')));
    await json(owner, '/api/payments/scan', { method: 'POST' });
    expect((await payments('review')).map((p) => p.reviewReason)).toEqual([expect.stringMatching(/new email \(other@example\.com\)/)]);
  });
});

describe('isolation, availability and the scan job', () => {
  it('payments, rules and scans are per workspace', async () => {
    const { owner, json, app, world } = await setup();
    await json(owner, '/api/payments/scan', { method: 'POST' });
    allowEmail(world.db, 'operator@example.com');
    const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: JSON.stringify({ email: 'operator@example.com' }) });
    const operator = cookieFrom(res, 'subscriberr_session')!;
    expect((await json<PaymentList>(operator, '/api/payments')).items).toEqual([]);
    await json(operator, '/api/payments/1', {}, 404);
    await json(operator, '/api/payments/1/resolve', { method: 'POST', body: { action: 'dismiss' } }, 404);
    await json(operator, '/api/payments/rules', { method: 'POST', body: { memberId: 1, label: 'x', senderName: 'x' } }, 404);
    expect((await json<RescanResult>(operator, '/api/payments/scan', { method: 'POST' })).stats.messages).toBe(0); // its own (empty) mailbox
  });

  it('reports an unavailable Gmail; the job scans only due, connected workspaces', async () => {
    const world = createWorld({ start: '2026-11-12T15:00:00Z' });
    seedDemo(world.db, world.clock.now(), 'America/Toronto');
    const fake = await FakeGmail.fromFixtures();
    let calls = 0;
    const gmail = async () => {
      calls++;
      return fake;
    };
    const deps = { clock: world.clock, log: silentLogger, gmail };
    expect(await runDueScans(world.ctx, deps)).toMatchObject({ scanned: 1, failed: 0 });
    expect(await runDueScans(world.ctx, deps)).toMatchObject({ scanned: 0 }); // not due yet
    world.clock.advanceMs(5 * 60_000);
    expect(await runDueScans(world.ctx, deps)).toMatchObject({ scanned: 1 });
    expect(calls).toBe(2);
    world.db.prepare(`UPDATE accounts SET gmail_status = 'disconnected'`).run();
    world.clock.advanceMs(5 * 60_000);
    expect(await runDueScans(world.ctx, deps)).toMatchObject({ scanned: 0 });

    const down = testApp(world, {
      gmail: async () => {
        throw new GmailUnavailableError('Gmail is not connected for this workspace.');
      },
    }).app;
    const res = await down.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: '{}' });
    const r = await down.request('/api/payments/scan', { method: 'POST', headers: { ...CSRF, cookie: cookieFrom(res, 'subscriberr_session')! } });
    expect(r.status).toBe(503);
    expect(forWorkspace(world.ctx, 1).sqlite.prepare('SELECT last_error FROM gmail_scan_state WHERE account_id = 1').get()).toEqual({ last_error: 'Gmail is not connected for this workspace.' });
  });
});
