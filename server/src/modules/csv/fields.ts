import {
  type AliasKind,
  centsToDecimal,
  CSV_BASE_FIELDS,
  type CsvBaseField,
  isIsoDate,
  isServerField,
  MEMBER_STATUSES,
  memberFieldsSchema,
  normalizeEmail,
  normalizeName,
  parseMoneyToCents,
  SERVER_FIELD_PREFIX,
} from '@subscriberr/shared';
import { z } from 'zod';
import { headerKey } from './csv.js';

// Per-field rules of the CSV format (Spec §12.1–§12.3): parsing a cell into a canonical value,
// and what a blank cell means for an existing member.

export interface Parsed {
  /** Canonical text ("15.00", "2026-12-01", "true", "a@b.co|ann s") or null when blank. */
  value: string | null;
  error?: string;
}

/**
 * What a blank cell does to an existing member:
 * - `inherit`: plan terms — blank means "use the workspace default" (§12.1).
 * - `clear`: optional text — blank removes the value (shown as a warning).
 * - `keep`: balances, status, flags, required name, aliases and server links — blank never changes anything.
 */
export type BlankMeaning = 'inherit' | 'clear' | 'keep';

export function blankMeaning(field: string): BlankMeaning {
  if (field === 'plan_amount' || field === 'plan_period_days' || field === 'tolerance' || field === 'grace_days') return 'inherit';
  if (field === 'etransfer_name' || field === 'email' || field === 'notes' || field === 'payment_memo_code') return 'clear';
  return 'keep';
}

/** Header synonyms for auto-mapping (compared as `headerKey`). */
const SYNONYMS: Record<CsvBaseField, string[]> = {
  id: ['member_id', 'memberid', 'subscriberr_id'],
  display_name: ['name', 'display', 'displayname', 'member', 'member_name', 'friendly_name', 'nickname', 'full_name'],
  etransfer_name: ['e_transfer_name', 'etransfer', 'interac_name', 'sender_name', 'payer_name', 'payer', 'bank_name', 'name_on_etransfer', 'name_on_e_transfer'],
  email: ['e_mail', 'email_address', 'mail'],
  notes: ['note', 'comment', 'comments', 'remarks'],
  plan_amount: ['amount', 'price', 'plan', 'fee', 'monthly_amount', 'plan_price'],
  plan_period_days: ['period', 'period_days', 'days', 'plan_period', 'billing_period'],
  currency: ['cur', 'ccy'],
  tolerance: ['tolerance_amount', 'underpayment_tolerance'],
  grace_days: ['grace', 'grace_period', 'grace_period_days'],
  paid_through: ['paid_until', 'paid_thru', 'due', 'due_date', 'next_due', 'expires', 'expiry', 'expiry_date'],
  credit: ['balance', 'credit_amount'],
  status: ['state'],
  reminders_enabled: ['reminders', 'send_reminders'],
  emails_enabled: ['emails', 'send_emails'],
  aliases: ['alias', 'other_names', 'aka'],
  payment_memo_code: ['memo_code', 'memo', 'code', 'payment_code'],
};

/** Auto-maps headers to fields; each field is used at most once (first header wins). */
export function autoMap(headers: string[], serverNames: string[]): Array<string | null> {
  const used = new Set<string>();
  const byKey = new Map<string, string>();
  for (const f of CSV_BASE_FIELDS) {
    byKey.set(headerKey(f), f);
    for (const s of SYNONYMS[f]) if (!byKey.has(s)) byKey.set(s, f);
  }
  for (const name of serverNames) byKey.set(headerKey(`${SERVER_FIELD_PREFIX}${name}`), `${SERVER_FIELD_PREFIX}${name}`);
  return headers.map((h) => {
    const f = byKey.get(headerKey(h)) ?? null;
    if (!f || used.has(f)) return null;
    used.add(f);
    return f;
  });
}

const BOOL_TRUE = new Set(['true', 'yes', 'y', '1', 'on', 'x']);
const BOOL_FALSE = new Set(['false', 'no', 'n', '0', 'off']);

function money(text: string, opts: { positive: boolean }): Parsed {
  const cents = parseMoneyToCents(text);
  if (cents === null || cents < 0 || (opts.positive && cents === 0) || cents > 1_000_000_000) {
    return { value: null, error: opts.positive ? 'Enter an amount such as 15.00' : 'Enter an amount such as 0.00 (not negative)' };
  }
  return { value: centsToDecimal(cents) };
}

function int(text: string, min: number, max: number): Parsed {
  if (!/^\d+$/.test(text)) return { value: null, error: 'Enter a whole number' };
  const n = Number(text);
  return n < min || n > max ? { value: null, error: `Must be between ${min} and ${max}` } : { value: String(n) };
}

function zodText(schema: z.ZodType, text: string): Parsed {
  const r = schema.safeParse(text);
  return r.success ? { value: r.data === null ? null : String(r.data) } : { value: null, error: r.error.issues[0]?.message ?? 'Invalid value' };
}

/** Splits an aliases cell ("ANN S | ann.work@example.com") into normalized aliases. */
export function parseAliases(text: string): { aliases: Array<{ kind: AliasKind; value: string }>; error?: string } {
  const out = new Map<string, { kind: 'name' | 'email'; value: string }>();
  for (const part of text.split('|')) {
    const t = part.trim();
    if (!t) continue;
    if (t.includes('@')) {
      if (!z.email().safeParse(normalizeEmail(t)).success) return { aliases: [], error: `"${t}" is not a valid email alias` };
      out.set(`email:${normalizeEmail(t)}`, { kind: 'email', value: normalizeEmail(t) });
    } else {
      if (t.length > 200) return { aliases: [], error: 'An alias is longer than 200 characters' };
      out.set(`name:${normalizeName(t)}`, { kind: 'name', value: normalizeName(t) });
    }
  }
  return { aliases: [...out.values()].sort((a, b) => (a.kind + a.value).localeCompare(b.kind + b.value)) };
}

export const aliasesText = (aliases: Array<{ value: string }>) => aliases.map((a) => a.value).join('|');

/** Dates as YYYY-MM-DD; also YYYY/MM/DD and YYYY.MM.DD. Day/month orders like 01/12/2026 are ambiguous and refused. */
export function parseDate(text: string): Parsed {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (m) {
    const iso = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
    if (isIsoDate(iso)) return { value: iso };
  }
  return { value: null, error: 'Use a date like 2026-12-01 (YYYY-MM-DD)' };
}

/** Parses one cell. Blank → { value: null }. */
export function parseCell(field: string, raw: string): Parsed {
  const text = raw.trim();
  if (text === '') return { value: null };
  if (isServerField(field)) return text.length > 200 ? { value: null, error: 'Too long' } : { value: text };
  switch (field as CsvBaseField) {
    case 'id':
      return /^\d{1,15}$/.test(text) ? { value: String(Number(text)) } : { value: null, error: 'Must be a member id number' };
    case 'display_name':
      return zodText(memberFieldsSchema.shape.displayName, text);
    case 'etransfer_name':
      return zodText(memberFieldsSchema.shape.etransferName, text);
    case 'email':
      return zodText(memberFieldsSchema.shape.email, text);
    case 'notes':
      return zodText(memberFieldsSchema.shape.notes, raw.trim());
    case 'payment_memo_code':
      return zodText(memberFieldsSchema.shape.paymentMemoCode, text);
    case 'plan_amount':
      return money(text, { positive: true });
    case 'tolerance':
    case 'credit':
      return money(text, { positive: false });
    case 'plan_period_days': {
      const lower = text.toLowerCase();
      if (lower === 'monthly' || lower === 'month') return { value: '30' };
      if (lower === 'yearly' || lower === 'year' || lower === 'annual' || lower === 'annually') return { value: '365' };
      return int(text, 1, 3650);
    }
    case 'grace_days':
      return int(text, 0, 365);
    case 'currency':
      return /^[A-Za-z]{3}$/.test(text) ? { value: text.toUpperCase() } : { value: null, error: 'Use a 3-letter currency code such as CAD' };
    case 'paid_through':
      return parseDate(text);
    case 'status': {
      const s = text.toLowerCase().replace(/[\s_-]+/g, ' ');
      const value = s === 'grace period' ? 'grace' : s;
      return (MEMBER_STATUSES as readonly string[]).includes(value) ? { value } : { value: null, error: `Use one of: ${MEMBER_STATUSES.join(', ')}` };
    }
    case 'reminders_enabled':
    case 'emails_enabled': {
      const b = text.toLowerCase();
      if (BOOL_TRUE.has(b)) return { value: 'true' };
      if (BOOL_FALSE.has(b)) return { value: 'false' };
      return { value: null, error: 'Use true or false' };
    }
    case 'aliases': {
      const r = parseAliases(text);
      return r.error ? { value: null, error: r.error } : { value: r.aliases.length > 0 ? aliasesText(r.aliases) : null };
    }
    default:
      return { value: null, error: 'Unknown column' };
  }
}

export const isAutomaticStatus = (s: string | null) => s === 'active' || s === 'grace' || s === 'expired';
