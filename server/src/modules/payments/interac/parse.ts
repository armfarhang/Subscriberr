import { normalizeName, parseMoneyToCents, toUtcIso } from '@subscriberr/shared';
import { type AuthVerdict, checkAuthenticity } from './authenticity.js';
import { header, type ParsedEmail } from './email.js';

// Classifier + parser for Interac e-Transfer notifications (Spec §7.2). Pure. It reads only the
// decoded text part and headers; links are never extracted for use, stored or logged (the deposit
// link's key is compared with the reference and then dropped).

export type MessageKind = 'autodeposit' | 'awaiting_deposit' | 'unknown';

export interface InteracFields {
  kind: MessageKind;
  amountCents: number | null;
  currency: string | null;
  /** Payer name as written in the body ("Sent From" / the "sent you" sentence). */
  senderName: string | null;
  /** Payer email from Reply-To (covered by Interac's DKIM signature). */
  senderEmail: string | null;
  reference: string | null;
  /** The e-Transfer message. In memory only for awaiting-deposit transfers (§7.2). */
  memo: string | null;
  /** YYYY-MM-DD, awaiting-deposit only. */
  expiresOn: string | null;
  /** UTC ISO instant from the Date header. */
  receivedAt: string | null;
}

export interface Analysis {
  /** ignored = not from an allowed sender (e.g. a bank's own alert); never stored. */
  verdict: 'ok' | 'needs_review' | 'rejected' | 'ignored';
  reason: string | null;
  fields: InteracFields;
  auth: AuthVerdict;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Nov 1, 2026" / "September 4, 2017" → "2026-11-01". */
export function parseLongDate(text: string): string | null {
  const m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const iso = `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The lines after "Message:" up to the next blank line. */
function memoBlock(lines: string[]): string | null {
  const i = lines.findIndex((l) => /^\s*Message:\s*$/i.test(l));
  if (i < 0) {
    const inline = lines.map((l) => /^\s*Message:\s*(\S.*)$/i.exec(l)).find(Boolean);
    return inline ? collapse(inline[1]!) : null;
  }
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() === '') {
      if (out.length > 0) break;
      continue;
    }
    out.push(l.trim());
  }
  return out.length > 0 ? collapse(out.join(' ')) : null;
}

function labeled(lines: string[], label: string): string | null {
  const re = new RegExp(`^\\s*${label}:\\s*(.+?)\\s*$`, 'i');
  for (const l of lines) {
    const m = re.exec(l);
    if (m) return m[1]!;
  }
  return null;
}

function money(text: string | null): { cents: number | null; currency: string | null } {
  if (!text) return { cents: null, currency: null };
  const m = /\$\s*([\d,]+\.\d{2})\s*(?:\(([A-Z]{3})\))?/.exec(text);
  if (!m) return { cents: null, currency: null };
  return { cents: parseMoneyToCents(m[1]!), currency: m[2] ?? null };
}

const SUBJECT_AUTODEPOSIT = /You['’]ve received \$([\d,]+\.\d{2}) from (.+?) and it has been automatically deposited/i;
const SUBJECT_AWAITING = /e-Transfer:\s*(.+?)\s+sent you money/i;
const BODY_AUTODEPOSIT = /Funds Deposited!/i;
const BODY_AWAITING = /sent you a money transfer for the amount of/i;
const TYPE_BY_HEADER: Record<string, MessageKind> = { '602': 'autodeposit', '2': 'awaiting_deposit' };

export function analyzeEmail(email: ParsedEmail, opts: { allowedSenders: string[] }): Analysis {
  const auth = checkAuthenticity(email, opts.allowedSenders);
  const fields: InteracFields = {
    kind: 'unknown',
    amountCents: null,
    currency: null,
    senderName: null,
    senderEmail: email.replyTo?.address ?? null,
    reference: null,
    memo: null,
    expiresOn: null,
    receivedAt: email.date ? toUtcIso(email.date) : null,
  };
  if (!auth.senderAllowed) return { verdict: 'ignored', reason: auth.reason, fields, auth };

  const text = email.text.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const problems: string[] = [];

  // Classification: several signals; the body is authoritative and any disagreement → review.
  const bodyAuto = BODY_AUTODEPOSIT.test(text);
  const bodyAwait = BODY_AWAITING.test(text);
  const kind: MessageKind = bodyAuto && !bodyAwait ? 'autodeposit' : bodyAwait && !bodyAuto ? 'awaiting_deposit' : 'unknown';
  fields.kind = kind;
  const typeHeader = header(email, 'x-messagetype');
  const headerKind = typeHeader ? TYPE_BY_HEADER[typeHeader] : undefined;
  const subjectKind: MessageKind | null = SUBJECT_AUTODEPOSIT.test(email.subject) ? 'autodeposit' : SUBJECT_AWAITING.test(email.subject) ? 'awaiting_deposit' : null;
  if (kind === 'unknown') problems.push('Unrecognized Interac message (neither an auto-deposit nor a transfer awaiting deposit)');
  if (kind !== 'unknown' && headerKind && headerKind !== kind) problems.push(`X-MessageType ${typeHeader} disagrees with the message body`);
  if (kind !== 'unknown' && subjectKind && subjectKind !== kind) problems.push('Subject and body describe different kinds of transfer');

  // Fields.
  if (kind === 'autodeposit') {
    const amount = money(labeled(lines, 'Amount'));
    fields.amountCents = amount.cents;
    fields.currency = amount.currency;
    fields.senderName = labeled(lines, 'Sent From');
    fields.reference = labeled(lines, 'Reference Number');
    fields.memo = memoBlock(lines);
  } else if (kind === 'awaiting_deposit') {
    const m = /^\s*(.+?)\s+sent you a money transfer for the amount of\s+\$\s*([\d,]+\.\d{2})\s*\(([A-Z]{3})\)/im.exec(text);
    if (m) {
      fields.senderName = m[1]!;
      fields.amountCents = parseMoneyToCents(m[2]!);
      fields.currency = m[3]!;
    }
    fields.memo = memoBlock(lines);
    const expiry = labeled(lines, 'Expiry Date');
    fields.expiresOn = expiry ? parseLongDate(expiry) : null;
    if (expiry && !fields.expiresOn) problems.push(`Unreadable expiry date "${expiry}"`);
    // The deposit link's key must equal the reference; the link itself is not kept.
    const key = /https:\/\/etransfer\.interac\.ca\/(?:[a-z]{2}\/)?([A-Za-z0-9]+)\b/.exec(text)?.[1] ?? null;
    fields.reference = key;
  }
  if (fields.senderName) fields.senderName = collapse(fields.senderName);

  if (kind !== 'unknown') {
    if (fields.amountCents === null) problems.push('Amount not found');
    if (!fields.senderName) problems.push('Payer name not found');
    if (!fields.reference) problems.push('Reference number not found');
    if (!fields.currency) problems.push('Currency not found');
  }

  // Cross-checks (§7.2): subject, X-PaymentKey and From name against the body.
  const paymentKey = header(email, 'x-paymentkey');
  if (paymentKey && fields.reference && paymentKey !== fields.reference) problems.push(`X-PaymentKey ${paymentKey} does not match the reference ${fields.reference}`);
  if (!fields.reference && paymentKey && kind !== 'unknown') fields.reference = paymentKey;
  const subjectAuto = SUBJECT_AUTODEPOSIT.exec(email.subject);
  if (kind === 'autodeposit' && subjectAuto) {
    if (fields.amountCents !== null && parseMoneyToCents(subjectAuto[1]!) !== fields.amountCents) problems.push('The amount in the subject differs from the body');
    if (fields.senderName && normalizeName(subjectAuto[2]!) !== normalizeName(fields.senderName)) problems.push('The payer name in the subject differs from the body');
  }
  const subjectAwait = SUBJECT_AWAITING.exec(email.subject);
  if (kind === 'awaiting_deposit' && subjectAwait && fields.senderName && normalizeName(subjectAwait[1]!) !== normalizeName(fields.senderName)) {
    problems.push('The payer name in the subject differs from the body');
  }
  if (email.from?.name && fields.senderName && normalizeName(email.from.name) !== normalizeName(fields.senderName)) {
    problems.push('The sender name in the From header differs from the body');
  }
  if (!fields.receivedAt) problems.push('Missing or invalid Date header');

  if (!auth.ok) return { verdict: 'rejected', reason: auth.reason, fields, auth };
  if (problems.length > 0) return { verdict: 'needs_review', reason: problems.join('; '), fields, auth };
  return { verdict: 'ok', reason: null, fields, auth };
}
