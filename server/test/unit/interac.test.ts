import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAuthResults } from '../../src/modules/payments/interac/authenticity.js';
import { parseEmail } from '../../src/modules/payments/interac/email.js';
import { analyzeEmail, parseLongDate } from '../../src/modules/payments/interac/parse.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/etransfer');
const raw = (name: string) => readFileSync(path.join(FIXTURES, name));
const SENDERS = ['notify@payments.interac.ca'];
const analyze = async (buf: Buffer) => analyzeEmail(await parseEmail(buf), { allowedSenders: SENDERS });
/** Edits a fixture's raw text (headers or body) to build negative cases. */
const tamper = (name: string, edit: (s: string) => string) => Buffer.from(edit(raw(name).toString('latin1')), 'latin1');

describe('Interac fixtures (Spec §7.2, §17)', () => {
  it('auto-deposit without memo', async () => {
    const a = await analyze(raw('autodeposit_01.eml'));
    expect(a).toMatchObject({ verdict: 'ok', reason: null, auth: { ok: true, dkim: 'pass', dkimDomain: 'payments.interac.ca' } });
    expect(a.fields).toEqual({
      kind: 'autodeposit',
      amountCents: 1000,
      currency: 'CAD',
      senderName: 'PAYER ONE',
      senderEmail: 'payer1@example.com',
      reference: 'C1AAAAAAAAA1',
      memo: null,
      expiresOn: null,
      receivedAt: '2026-11-01T13:36:40Z',
    });
  });

  it('auto-deposit with a memo and a one-word payer name', async () => {
    const a = await analyze(raw('autodeposit_with_memo_02.eml'));
    expect(a.verdict).toBe('ok');
    expect(a.fields).toMatchObject({ kind: 'autodeposit', amountCents: 3000, senderName: 'Pat', senderEmail: 'payer2@example.com', reference: 'C1BBBBBBBBB2', memo: 'july/ aug' });
  });

  it('legacy "sent you money" → awaiting deposit with expiry; passes without a DMARC verdict', async () => {
    const a = await analyze(raw('legacy_sent_you_money_03.eml'));
    expect(a).toMatchObject({ verdict: 'ok', auth: { ok: true, dmarc: null } });
    expect(a.fields).toMatchObject({ kind: 'awaiting_deposit', amountCents: 4000, currency: 'CAD', senderName: 'Sam Payer', reference: 'CA0TEST1', expiresOn: '2017-09-04', senderEmail: 'payer3@example.com' });
    expect(a.fields.memo).toMatch(/password/); // read in memory; ingest never stores it (§7.2)
  });

  it('a bank alert from another sender is ignored', async () => {
    const a = await analyze(raw('outgoing_bank_alert_04.eml'));
    expect(a.verdict).toBe('ignored');
    expect(a.auth.senderAllowed).toBe(false);
  });
});

describe('authenticity (Spec §7.3)', () => {
  it('rejects a forged sender without an aligned DKIM pass', async () => {
    const forged = tamper('autodeposit_01.eml', (s) => s.replace(/header\.i=@payments\.interac\.ca/g, 'header.i=@evil.example'));
    const a = await analyze(forged);
    expect(a).toMatchObject({ verdict: 'rejected', reason: expect.stringMatching(/No passing DKIM signature/) });
    expect(a.fields.amountCents).toBe(1000); // still parsed for display
  });

  it('rejects dmarc=fail, and ignores comments and lower / non-Gmail headers', async () => {
    const dmarcFail = tamper('autodeposit_with_memo_02.eml', (s) => s.replace('Authentication-Results: mx.google.com;', 'Authentication-Results: mx.google.com; dmarc=fail (p=REJECT) header.from=payments.interac.ca;'));
    expect((await analyze(dmarcFail)).reason).toBe('DMARC failed');

    // A spoofer can add their own Authentication-Results lower in the message or from another server.
    const spoof = tamper('autodeposit_01.eml', (s) =>
      s
        .replace(/header\.i=@payments\.interac\.ca/g, 'header.i=@evil.example')
        .replace(/^(From: )/m, 'Authentication-Results: other.example; dkim=pass header.i=@payments.interac.ca\r\n$1'),
    );
    expect((await analyze(spoof)).verdict).toBe('rejected');
    expect(parseAuthResults('mx.google.com; dkim=fail (but the comment says dkim=pass header.i=@payments.interac.ca) header.i=@x.example').results).toEqual([
      expect.objectContaining({ method: 'dkim', result: 'fail' }),
    ]);
  });

  it('accepts other allowed senders only with DKIM aligned to their own domain', async () => {
    const parsed = await parseEmail(raw('autodeposit_01.eml'));
    expect(analyzeEmail(parsed, { allowedSenders: ['someone@else.example'] }).verdict).toBe('ignored');
  });
});

describe('parser cross-checks → needs_review, never a guess', () => {
  it('X-PaymentKey must match the body reference', async () => {
    const a = await analyze(tamper('autodeposit_01.eml', (s) => s.replace('X-PaymentKey: C1AAAAAAAAA1', 'X-PaymentKey: C1ZZZZZZZZZ9')));
    expect(a).toMatchObject({ verdict: 'needs_review', reason: expect.stringMatching(/X-PaymentKey/) });
  });
  it('subject amount must match the body', async () => {
    const a = await analyze(tamper('autodeposit_01.eml', (s) => s.replace("received $10.00 from", "received $99.00 from")));
    expect(a).toMatchObject({ verdict: 'needs_review', reason: expect.stringMatching(/amount in the subject/) });
  });
  it('X-MessageType must agree with the body', async () => {
    const a = await analyze(tamper('autodeposit_01.eml', (s) => s.replace('X-MessageType: 602', 'X-MessageType: 2')));
    expect(a).toMatchObject({ verdict: 'needs_review', reason: expect.stringMatching(/X-MessageType/) });
  });
  it('an unknown layout goes to review', async () => {
    const a = await analyze(tamper('autodeposit_01.eml', (s) => s.replace(/Funds Deposited!/g, 'Something new!')));
    expect(a).toMatchObject({ verdict: 'needs_review', reason: expect.stringMatching(/Unrecognized/) });
  });
  it('parses long and short month dates', () => {
    expect(parseLongDate('Nov 1, 2026')).toBe('2026-11-01');
    expect(parseLongDate('September 4, 2017')).toBe('2017-09-04');
    expect(parseLongDate('Feb 30, 2026')).toBeNull();
  });
});
