import { normalizeEmail, normalizeName } from '@subscriberr/shared';
import { evaluateRule, type PaymentFacts, type RuleInput } from './rules.js';

// The matching algorithm of Spec §7.4. Pure: plain data in, a decision out. The first step that
// yields a result wins; the app never guesses between people.

export interface MatchMember {
  id: number;
  displayName: string;
  etransferName: string | null;
  email: string | null;
  archived: boolean;
  nameAliases: string[];
  emailAliases: string[];
}

export interface MatchDecision {
  status: 'matched' | 'needs_review' | 'unmatched';
  memberId: number | null;
  matchedBy: 'name' | 'email' | 'rule' | null;
  ruleId: number | null;
  reason: string | null;
  /** Fuzzy near-miss: proposed, never applied (§7.4 step 6). */
  proposal: { memberId: number; score: number } | null;
}

export const FUZZY_THRESHOLD = 0.88;

/** Jaro-Winkler similarity of two normalized strings (0..1). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

const decision = (d: Partial<MatchDecision> & Pick<MatchDecision, 'status'>): MatchDecision => ({ memberId: null, matchedBy: null, ruleId: null, reason: null, proposal: null, ...d });

export function identityNames(m: MatchMember): string[] {
  return [...new Set([m.displayName, m.etransferName, ...m.nameAliases].filter((x): x is string => Boolean(x)).map(normalizeName))].filter(Boolean);
}

export function matchPayment(facts: PaymentFacts, members: MatchMember[], rules: RuleInput[]): MatchDecision {
  const byId = new Map(members.map((m) => [m.id, m]));
  const defaultName = (id: number) => {
    const m = byId.get(id);
    return m ? (m.etransferName ?? m.displayName) : '';
  };
  const finish = (d: MatchDecision): MatchDecision => {
    if (d.status === 'matched' && d.memberId !== null && byId.get(d.memberId)?.archived) {
      return { ...d, status: 'needs_review', reason: `Matched ${byId.get(d.memberId)!.displayName}, who is archived` };
    }
    return d;
  };

  // 1. Rules, in priority order.
  const hits = rules
    .filter((r) => r.enabled && byId.has(r.memberId))
    .sort((a, b) => a.priority - b.priority || a.id - b.id)
    .filter((r) => evaluateRule(r, facts, defaultName(r.memberId)).matches);
  if (hits.length > 0) {
    const memberIds = new Set(hits.map((h) => h.memberId));
    if (memberIds.size > 1) {
      return decision({ status: 'needs_review', reason: `Rule conflict: rules for different members match (${hits.map((h) => `#${h.id}`).join(', ')})` });
    }
    const top = hits[0]!;
    if (top.action === 'review') return decision({ status: 'needs_review', memberId: top.memberId, ruleId: top.id, reason: `Rule “${top.label}” sends this payment to review` });
    return finish(decision({ status: 'matched', memberId: top.memberId, matchedBy: 'rule', ruleId: top.id }));
  }

  const name = facts.senderName ? normalizeName(facts.senderName) : '';
  const email = facts.senderEmail ? normalizeEmail(facts.senderEmail) : '';
  const byName = name ? members.filter((m) => identityNames(m).includes(name)) : [];

  // 2. Shared-name guard: name matching is disabled for a name configured on several members.
  if (byName.length > 1) return decision({ status: 'needs_review', reason: `Shared name “${name}” (${byName.map((m) => m.displayName).join(', ')}) and no rule matched` });

  // 3. Name, 4. email.
  const nameMatch = byName[0] ?? null;
  const byEmail = email ? members.filter((m) => (m.email && normalizeEmail(m.email) === email) || m.emailAliases.includes(email)) : [];
  const emailMatch = byEmail.length === 1 ? byEmail[0]! : null;

  // 5. Conflict check.
  if (nameMatch && emailMatch && nameMatch.id !== emailMatch.id) {
    return decision({ status: 'needs_review', reason: `Name matches ${nameMatch.displayName} but the email matches ${emailMatch.displayName}` });
  }
  if (nameMatch) return finish(decision({ status: 'matched', memberId: nameMatch.id, matchedBy: 'name' }));
  if (byEmail.length > 1) return decision({ status: 'needs_review', reason: `The email ${email} belongs to several members` });
  if (emailMatch) return finish(decision({ status: 'matched', memberId: emailMatch.id, matchedBy: 'email' }));

  // 6. Fuzzy: a proposal only.
  if (name) {
    let best: { memberId: number; score: number } | null = null;
    for (const m of members) {
      for (const n of identityNames(m)) {
        const score = jaroWinkler(name, n);
        if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) best = { memberId: m.id, score: Math.round(score * 100) / 100 };
      }
    }
    if (best) return decision({ status: 'needs_review', proposal: best, reason: `Close to ${byId.get(best.memberId)!.displayName} (similarity ${best.score}); please confirm` });
  }

  // 7. Unmatched.
  return decision({ status: 'unmatched', reason: 'No member has this name or email' });
}
