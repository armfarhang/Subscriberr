import type { ParsedEmail } from './email.js';

// Authenticity (Spec §7.3). Mail may be forwarded, so SPF is NOT the test. We trust Gmail's
// own verdict for this mailbox's copy: the TOPMOST Authentication-Results header whose
// authserv-id is mx.google.com (ARC-* and lower/duplicate headers are ignored), and require
// DKIM aligned with the sender's domain to pass and DMARC not to fail. Signatures are never
// re-verified here (the redacted fixtures could not pass that anyway).

export const GMAIL_AUTHSERV_ID = 'mx.google.com';

export interface AuthVerdict {
  ok: boolean;
  /** Why it failed (when !ok). */
  reason: string | null;
  dkim: 'pass' | 'fail' | 'none';
  /** The domain whose DKIM signature passed, aligned with the sender. */
  dkimDomain: string | null;
  dmarc: string | null;
  senderAllowed: boolean;
}

/** Removes RFC 5322 comments "( … )", which may contain misleading text like "dkim=pass". */
function stripComments(value: string): string {
  let out = value;
  for (let i = 0; i < 5 && /\([^()]*\)/.test(out); i++) out = out.replace(/\([^()]*\)/g, ' ');
  return out;
}

interface MethodResult {
  method: string;
  result: string;
  props: Map<string, string>;
}

export function parseAuthResults(value: string): { authservId: string; results: MethodResult[] } {
  const [authserv = '', ...rest] = stripComments(value).split(';');
  const results: MethodResult[] = [];
  for (const part of rest) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const head = tokens.shift();
    const m = head ? /^([a-z0-9-]+)=([a-z]+)$/i.exec(head) : null;
    if (!m) continue;
    const props = new Map<string, string>();
    for (const t of tokens) {
      const kv = /^([a-z0-9.-]+)=(.*)$/i.exec(t);
      if (kv) props.set(kv[1]!.toLowerCase(), kv[2]!.replace(/^"|"$/g, ''));
    }
    results.push({ method: m[1]!.toLowerCase(), result: m[2]!.toLowerCase(), props });
  }
  return { authservId: authserv.trim().split(/\s+/)[0]?.toLowerCase() ?? '', results };
}

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/** True when the DKIM identity (header.i / header.d) is the sender's domain or a subdomain of it. */
function aligned(props: Map<string, string>, senderDomain: string): string | null {
  const i = props.get('header.i');
  const d = props.get('header.d');
  const domain = (i ? domainOf(i) : d ?? '').toLowerCase();
  if (!domain) return null;
  return domain === senderDomain || domain.endsWith(`.${senderDomain}`) ? domain : null;
}

export function checkAuthenticity(email: ParsedEmail, allowedSenders: string[]): AuthVerdict {
  const from = email.from?.address ?? '';
  const senderAllowed = allowedSenders.map((s) => s.toLowerCase()).includes(from);
  const base: AuthVerdict = { ok: false, reason: null, dkim: 'none', dkimDomain: null, dmarc: null, senderAllowed };
  if (!senderAllowed) return { ...base, reason: `Sender ${from || '(none)'} is not an allowed e-Transfer sender` };

  const gmail = (email.headers.get('authentication-results') ?? []).map(parseAuthResults).find((h) => h.authservId === GMAIL_AUTHSERV_ID);
  if (!gmail) return { ...base, reason: 'No Authentication-Results header from mx.google.com' };

  const senderDomain = domainOf(from);
  const dkims = gmail.results.filter((r) => r.method === 'dkim');
  const good = dkims.find((r) => r.result === 'pass' && aligned(r.props, senderDomain));
  const dmarc = gmail.results.find((r) => r.method === 'dmarc')?.result ?? null;
  const verdict: AuthVerdict = {
    ...base,
    dkim: good ? 'pass' : dkims.length > 0 ? 'fail' : 'none',
    dkimDomain: good ? aligned(good.props, senderDomain) : null,
    dmarc,
  };
  if (!good) return { ...verdict, reason: `No passing DKIM signature from ${senderDomain}` };
  if (dmarc === 'fail') return { ...verdict, reason: 'DMARC failed' };
  return { ...verdict, ok: true };
}
