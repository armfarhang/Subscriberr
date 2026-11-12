import { type MemberWarning, normalizeEmail, normalizeMemoCode, normalizeName } from '@subscriberr/shared';
import type { WorkspaceContext } from '../../core/workspace-context.js';

// Guard rails shown on the member (Spec §7.4.1): shared e-Transfer names, overlapping memo
// codes, shared emails. They never block saving; they explain what matching will do.

interface IdentityRow {
  id: number;
  display_name: string;
  etransfer_name: string | null;
  email: string | null;
  payment_memo_code: string | null;
}

interface AliasRow {
  member_id: number;
  kind: 'name' | 'email';
  value: string;
}

export interface WarningSubject {
  id: number;
  displayName: string;
  etransferName: string | null;
  email: string | null;
  paymentMemoCode: string | null;
  aliases: Array<{ kind: 'name' | 'email'; value: string }>;
  planAmountCents: number | null;
}

/** The normalized names a payment sender could be matched on (§7.4 step 3). */
export function identityNames(m: { displayName: string; etransferName: string | null; aliases: Array<{ kind: string; value: string }> }): Set<string> {
  const names = new Set<string>();
  names.add(normalizeName(m.displayName));
  if (m.etransferName) names.add(normalizeName(m.etransferName));
  for (const a of m.aliases) if (a.kind === 'name') names.add(normalizeName(a.value));
  names.delete('');
  return names;
}

function identityEmails(m: { email: string | null; aliases: Array<{ kind: string; value: string }> }): Set<string> {
  const emails = new Set<string>();
  if (m.email) emails.add(normalizeEmail(m.email));
  for (const a of m.aliases) if (a.kind === 'email') emails.add(normalizeEmail(a.value));
  return emails;
}

export function memberWarnings(ws: WorkspaceContext, subject: WarningSubject): MemberWarning[] {
  const others = ws.sqlite
    .prepare('SELECT id, display_name, etransfer_name, email, payment_memo_code FROM members WHERE account_id = ? AND id <> ?')
    .all(ws.accountId, subject.id) as IdentityRow[];
  const otherAliases = ws.sqlite
    .prepare('SELECT member_id, kind, value FROM member_aliases WHERE account_id = ? AND member_id <> ?')
    .all(ws.accountId, subject.id) as AliasRow[];
  const aliasesOf = new Map<number, AliasRow[]>();
  for (const a of otherAliases) aliasesOf.set(a.member_id, [...(aliasesOf.get(a.member_id) ?? []), a]);

  const myNames = identityNames(subject);
  const myEmails = identityEmails(subject);
  const myCode = subject.paymentMemoCode ? normalizeMemoCode(subject.paymentMemoCode) : null;

  const sharedNames = new Map<string, Array<{ id: number; displayName: string }>>();
  const sharedEmails = new Map<string, Array<{ id: number; displayName: string }>>();
  const overlappingCodes: Array<{ id: number; displayName: string; code: string }> = [];

  for (const o of others) {
    const aliases = aliasesOf.get(o.id) ?? [];
    const ref = { id: o.id, displayName: o.display_name };
    for (const n of identityNames({ displayName: o.display_name, etransferName: o.etransfer_name, aliases })) {
      if (myNames.has(n)) sharedNames.set(n, [...(sharedNames.get(n) ?? []), ref]);
    }
    for (const e of identityEmails({ email: o.email, aliases })) {
      if (myEmails.has(e)) sharedEmails.set(e, [...(sharedEmails.get(e) ?? []), ref]);
    }
    if (myCode && o.payment_memo_code) {
      const theirs = normalizeMemoCode(o.payment_memo_code);
      if (theirs !== myCode && (theirs.includes(myCode) || myCode.includes(theirs))) overlappingCodes.push({ ...ref, code: o.payment_memo_code });
    }
  }

  const warnings: MemberWarning[] = [];
  const names = (list: Array<{ displayName: string }>) => list.map((o) => o.displayName).join(', ');
  for (const [name, list] of sharedNames) {
    warnings.push({
      code: 'shared_name',
      message: `The name "${name}" is also used by ${names(list)}. Payments from that name are never matched by name; they go to the Review Queue unless a memo code or rule tells the members apart.`,
      others: list,
    });
  }
  if (overlappingCodes.length > 0) {
    warnings.push({
      code: 'memo_overlap',
      message: `This memo code overlaps with ${overlappingCodes.map((o) => `"${o.code}" (${o.displayName})`).join(', ')}: one contains the other, so a memo could match both. Choose codes that do not contain each other.`,
      others: overlappingCodes.map(({ id, displayName }) => ({ id, displayName })),
    });
  }
  for (const [email, list] of sharedEmails) {
    warnings.push({ code: 'shared_email', message: `The email ${email} is also used by ${names(list)}.`, others: list });
  }
  if (!subject.email) {
    warnings.push({ code: 'no_email', message: 'No email on file: this member will not receive reminders or payment confirmations.', others: [] });
  }
  if (subject.planAmountCents === null) {
    warnings.push({ code: 'no_plan_amount', message: 'No plan amount: set one here or in the workspace member defaults.', others: [] });
  }
  return warnings;
}
