import { describe, expect, it } from 'vitest';
import { jaroWinkler, type MatchMember, matchPayment } from '../../src/modules/payments/matching/matcher.js';
import { evaluateRule, regexTest, type RuleInput, validateRegex } from '../../src/modules/payments/matching/rules.js';

const member = (id: number, displayName: string, extra: Partial<MatchMember> = {}): MatchMember => ({
  id,
  displayName,
  etransferName: null,
  email: null,
  archived: false,
  nameAliases: [],
  emailAliases: [],
  ...extra,
});

const rule = (id: number, memberId: number, extra: Partial<RuleInput> = {}): RuleInput => ({
  id,
  memberId,
  label: `rule ${id}`,
  enabled: true,
  priority: 100,
  managed: false,
  senderName: null,
  senderEmail: null,
  memoMode: null,
  memoValue: null,
  amountMinCents: null,
  amountMaxCents: null,
  action: 'assign',
  ...extra,
});

const facts = (senderName: string | null, senderEmail: string | null = null, memo: string | null = null, amountCents: number | null = 1500) => ({ senderName, senderEmail, memo, amountCents });

describe('matching (Spec §7.4)', () => {
  const ann = member(1, 'Ann (neighbour)', { etransferName: 'ANN SMITH', email: 'ann@example.com' });
  const pat = member(2, 'Pat', { email: 'pat@example.com', emailAliases: ['pat.work@example.com'] });
  const bob = member(3, 'Bob', { etransferName: 'Robert Example', nameAliases: ['bobby e'] });

  it('matches a unique name (case, spacing, accents) including one-word names and aliases', () => {
    expect(matchPayment(facts('ann  smith'), [ann, pat, bob], [])).toMatchObject({ status: 'matched', memberId: 1, matchedBy: 'name' });
    expect(matchPayment(facts('PAT'), [ann, pat, bob], [])).toMatchObject({ status: 'matched', memberId: 2, matchedBy: 'name' });
    expect(matchPayment(facts('Bóbby E'), [ann, pat, bob], [])).toMatchObject({ status: 'matched', memberId: 3 });
  });

  it('falls back to the Reply-To email (member email or email alias)', () => {
    expect(matchPayment(facts('Unknown Person', 'PAT.work@example.com'), [ann, pat, bob], [])).toMatchObject({ status: 'matched', memberId: 2, matchedBy: 'email' });
  });

  it('sends a name-vs-email disagreement to review', () => {
    expect(matchPayment(facts('ANN SMITH', 'pat@example.com'), [ann, pat, bob], [])).toMatchObject({ status: 'needs_review', memberId: null, reason: expect.stringMatching(/email matches Pat/) });
  });

  it('shared names: never matched by name; memo rules tell them apart; a missing memo goes to review', () => {
    const js1 = member(10, 'John (uncle)', { etransferName: 'JOHN SMITH', paymentMemoCode: 'JS-1' } as Partial<MatchMember>);
    const js2 = member(11, 'John (cousin)', { etransferName: 'John Smith' });
    const rules = [rule(1, 10, { managed: true, senderName: 'john smith', memoMode: 'contains', memoValue: 'JS-1' }), rule(2, 11, { senderName: 'john smith', memoMode: 'contains', memoValue: 'JS-2' })];
    expect(matchPayment(facts('JOHN SMITH', null, 'for js 2 november'), [js1, js2], rules)).toMatchObject({ status: 'matched', memberId: 11, matchedBy: 'rule', ruleId: 2 });
    expect(matchPayment(facts('JOHN SMITH', null, 'Dec — JS-1'), [js1, js2], rules)).toMatchObject({ status: 'matched', memberId: 10, ruleId: 1 });
    expect(matchPayment(facts('JOHN SMITH', null, null), [js1, js2], rules)).toMatchObject({ status: 'needs_review', reason: expect.stringMatching(/Shared name/) });
    expect(matchPayment(facts('JOHN SMITH', null, 'nothing useful'), [js1, js2], rules)).toMatchObject({ status: 'needs_review' });
  });

  it('rule priority, conflicts and review actions', () => {
    const a = member(1, 'A', { etransferName: 'Same' });
    const b = member(2, 'B');
    expect(matchPayment(facts('Same', null, 'x'), [a, b], [rule(1, 1, { senderName: 'same', priority: 5 }), rule(2, 2, { senderName: 'same', priority: 1 })])).toMatchObject({
      status: 'needs_review',
      reason: expect.stringMatching(/Rule conflict/),
    });
    expect(matchPayment(facts('Same'), [a, b], [rule(1, 1, { senderName: 'same', priority: 5 }), rule(2, 1, { senderName: 'same', priority: 1, action: 'review', label: 'Check' })])).toMatchObject({
      status: 'needs_review',
      ruleId: 2,
      reason: expect.stringMatching(/Check/),
    });
    expect(matchPayment(facts('Same'), [a, b], [rule(1, 1, { senderName: 'same', enabled: false })])).toMatchObject({ status: 'matched', matchedBy: 'name' });
  });

  it('fuzzy near-misses are only proposals; unknown senders are unmatched; archived members go to review', () => {
    const d = matchPayment(facts('ANN SMITHE'), [ann, pat], []);
    expect(d).toMatchObject({ status: 'needs_review', memberId: null, proposal: { memberId: 1 } });
    expect(matchPayment(facts('Zed Quux'), [ann, pat], [])).toMatchObject({ status: 'unmatched' });
    expect(matchPayment(facts('Pat'), [{ ...pat, archived: true }], [])).toMatchObject({ status: 'needs_review', reason: expect.stringMatching(/archived/) });
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 2);
  });
});

describe('rules (Spec §7.4.1)', () => {
  it('memo modes, email and amount conditions', () => {
    const base = rule(1, 1, { senderName: 'pat' });
    expect(evaluateRule({ ...base, memoMode: 'equals', memoValue: 'July / Aug' }, facts('Pat', null, 'july / aug'), 'Pat').matches).toBe(true);
    expect(evaluateRule({ ...base, memoMode: 'regex', memoValue: '^js-?\\d$' }, facts('Pat', null, 'JS-3'), 'Pat').matches).toBe(true);
    expect(evaluateRule({ ...base, senderEmail: 'p@example.com' }, facts('Pat', 'P@Example.com'), 'Pat').matches).toBe(true);
    expect(evaluateRule({ ...base, amountMinCents: 1000, amountMaxCents: 2000 }, facts('Pat', null, null, 2500), 'Pat')).toMatchObject({ matches: false });
    expect(evaluateRule({ ...rule(1, 1), memoMode: 'contains', memoValue: 'x' }, facts('Robert Example', null, 'x'), 'Robert Example').matches).toBe(true); // default sender name
  });

  it('stops a catastrophic regex instead of hanging', () => {
    expect(validateRegex('(a+)+$')).toBeNull();
    expect(validateRegex('(')).not.toBeNull();
    expect(validateRegex('a'.repeat(201))).not.toBeNull();
    const started = Date.now();
    expect(() => regexTest('^(a+)+$', `${'a'.repeat(40)}!`)).toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(evaluateRule({ ...rule(1, 1, { senderName: 'pat' }), memoMode: 'regex', memoValue: '^(a+)+$' }, facts('Pat', null, `${'a'.repeat(40)}!`), 'Pat')).toMatchObject({
      matches: false,
      failed: expect.stringMatching(/too long/),
    });
  });
});
