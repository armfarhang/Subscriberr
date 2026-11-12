import { describe, expect, it } from 'vitest';
import { addAliasSchema, createMemberSchema, derivedStatus, normalizeEmail, normalizeMemoCode, normalizeName, updateMemberSchema } from '../src/index.js';

describe('name normalization (Spec §7.4)', () => {
  it('folds case, strips diacritics and collapses whitespace', () => {
    expect(normalizeName('  JOSÉ   Exámple ')).toBe('jose example');
    expect(normalizeName('PAYER\tONE')).toBe('payer one');
    expect(normalizeName('Zoë')).toBe(normalizeName('ZOE'));
    expect(normalizeName('Pat')).toBe('pat');
  });
  it('normalizes emails and memo codes', () => {
    expect(normalizeEmail(' Pat@Example.COM ')).toBe('pat@example.com');
    expect(normalizeMemoCode(' js - 1 ')).toBe(normalizeMemoCode('JS-1'));
    expect(normalizeMemoCode('JS-1')).not.toBe(normalizeMemoCode('JS-10'));
  });
});

describe('derived status (Spec §8.3)', () => {
  it('follows the paid-through date and grace days', () => {
    expect(derivedStatus(null, 3, '2026-11-12')).toBe('expired');
    expect(derivedStatus('2026-11-12', 3, '2026-11-12')).toBe('active');
    expect(derivedStatus('2026-11-11', 3, '2026-11-12')).toBe('grace');
    expect(derivedStatus('2026-11-09', 3, '2026-11-12')).toBe('grace');
    expect(derivedStatus('2026-11-08', 3, '2026-11-12')).toBe('expired');
    expect(derivedStatus('2026-11-11', 0, '2026-11-12')).toBe('expired');
  });
});

describe('member schemas', () => {
  it('needs only a display name and turns blanks into null', () => {
    expect(createMemberSchema.parse({ displayName: '  Ann  ', email: ' ', etransferName: '' })).toEqual({ displayName: 'Ann', email: null, etransferName: null });
    expect(createMemberSchema.safeParse({}).success).toBe(false);
    expect(createMemberSchema.safeParse({ displayName: '   ' }).success).toBe(false);
  });
  it('lower-cases emails and validates them', () => {
    expect(updateMemberSchema.parse({ email: 'Ann@Example.com' })).toEqual({ email: 'ann@example.com' });
    expect(updateMemberSchema.safeParse({ email: 'nope' }).success).toBe(false);
  });
  it('never accepts balances or status (they come from the ledger, §6.5a)', () => {
    for (const key of ['paidThrough', 'creditCents', 'lastPaymentAt', 'status']) {
      expect(updateMemberSchema.safeParse({ [key]: key === 'creditCents' ? 100 : '2026-01-01' }).success, key).toBe(false);
    }
  });
  it('validates memo codes and plan overrides', () => {
    expect(updateMemberSchema.safeParse({ paymentMemoCode: 'JS-1' }).success).toBe(true);
    expect(updateMemberSchema.safeParse({ paymentMemoCode: 'x' }).success).toBe(false);
    expect(updateMemberSchema.safeParse({ paymentMemoCode: 'a<b>' }).success).toBe(false);
    expect(updateMemberSchema.safeParse({ planAmountCents: null, graceDays: null }).success).toBe(true);
    expect(updateMemberSchema.safeParse({ planAmountCents: 0 }).success).toBe(false);
    expect(updateMemberSchema.safeParse({ toleranceCents: -1 }).success).toBe(false);
    expect(updateMemberSchema.safeParse({ planPeriodDays: 1.5 }).success).toBe(false);
  });
  it('checks email aliases are emails', () => {
    expect(addAliasSchema.safeParse({ kind: 'email', value: 'a@b.co' }).success).toBe(true);
    expect(addAliasSchema.safeParse({ kind: 'email', value: 'Ann' }).success).toBe(false);
    expect(addAliasSchema.safeParse({ kind: 'name', value: 'Ann' }).success).toBe(true);
  });
});
