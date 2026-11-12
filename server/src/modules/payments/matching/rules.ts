import { Script, createContext } from 'node:vm';
import { normalizeEmail, normalizeName } from '@subscriberr/shared';

// Matching rules (Spec §7.4.1). Pure. Every condition that is set must hold. A missing memo
// never matches a memo rule. Regex memo rules are length-capped and run with a time limit so a
// catastrophic pattern cannot hang the scan.

export const REGEX_MAX_LENGTH = 200;
export const REGEX_TIMEOUT_MS = 50;

export interface RuleInput {
  id: number;
  memberId: number;
  label: string;
  enabled: boolean;
  priority: number;
  managed: boolean;
  /** Normalized; null = the member's own e-Transfer name (or display name). */
  senderName: string | null;
  senderEmail: string | null;
  memoMode: 'contains' | 'equals' | 'regex' | null;
  memoValue: string | null;
  amountMinCents: number | null;
  amountMaxCents: number | null;
  action: 'assign' | 'review';
}

export interface PaymentFacts {
  senderName: string | null;
  senderEmail: string | null;
  /** In memory only for awaiting-deposit transfers. */
  memo: string | null;
  amountCents: number | null;
}

export type RuleOutcome = { matches: true } | { matches: false; failed: string };

/** Memo text compared like names: case-folded, accents stripped, whitespace collapsed. */
export const normalizeMemo = (s: string) => normalizeName(s);

export function validateRegex(pattern: string): string | null {
  if (pattern.length > REGEX_MAX_LENGTH) return `Use at most ${REGEX_MAX_LENGTH} characters`;
  try {
    new RegExp(pattern, 'i');
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid regular expression';
  }
}

/** Runs a case-insensitive regex test with a hard time limit. Throws on timeout. */
export function regexTest(pattern: string, text: string): boolean {
  const context = createContext({ pattern, text, result: false });
  new Script('result = new RegExp(pattern, "i").test(text)').runInContext(context, { timeout: REGEX_TIMEOUT_MS });
  return context.result === true;
}

export function evaluateRule(rule: RuleInput, facts: PaymentFacts, memberDefaultName: string): RuleOutcome {
  const name = facts.senderName ? normalizeName(facts.senderName) : null;
  const expectedName = rule.senderName ?? normalizeName(memberDefaultName);
  if (expectedName && name !== expectedName) return { matches: false, failed: `sender name is not “${expectedName}”` };
  if (rule.senderEmail && (!facts.senderEmail || normalizeEmail(facts.senderEmail) !== normalizeEmail(rule.senderEmail))) {
    return { matches: false, failed: `sender email is not ${rule.senderEmail}` };
  }
  if (rule.memoMode && rule.memoValue !== null) {
    if (!facts.memo) return { matches: false, failed: 'the payment has no message (memo)' };
    const memo = normalizeMemo(facts.memo);
    // "contains" compares letters and digits only, so "js 2", "JS-2" and "js2" all contain code JS-2.
    const compact = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '');
    if (rule.memoMode === 'contains' && !compact(memo).includes(compact(normalizeMemo(rule.memoValue)))) {
      return { matches: false, failed: `the message does not contain “${rule.memoValue}”` };
    }
    if (rule.memoMode === 'equals' && memo !== normalizeMemo(rule.memoValue)) return { matches: false, failed: `the message is not “${rule.memoValue}”` };
    if (rule.memoMode === 'regex') {
      let ok: boolean;
      try {
        ok = regexTest(rule.memoValue, memo);
      } catch {
        return { matches: false, failed: 'the regular expression took too long and was stopped' };
      }
      if (!ok) return { matches: false, failed: `the message does not match /${rule.memoValue}/` };
    }
  }
  if (rule.amountMinCents !== null && (facts.amountCents === null || facts.amountCents < rule.amountMinCents)) return { matches: false, failed: 'the amount is below the minimum' };
  if (rule.amountMaxCents !== null && (facts.amountCents === null || facts.amountCents > rule.amountMaxCents)) return { matches: false, failed: 'the amount is above the maximum' };
  return { matches: true };
}
