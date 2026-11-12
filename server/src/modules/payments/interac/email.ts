import { simpleParser } from 'mailparser';

// A decoded email, reduced to what the e-Transfer pipeline needs. Built with a real MIME parser
// (Spec §7.2: never regex the raw source); everything after this works on decoded text.

export interface Address {
  address: string;
  name: string;
}

export interface ParsedEmail {
  from: Address | null;
  replyTo: Address | null;
  subject: string;
  /** The Date header (null when missing or invalid). */
  date: Date | null;
  /** Header values by lower-case name, in message order (topmost first). */
  headers: Map<string, string[]>;
  /** text/plain part, or text converted from HTML when there is none. */
  text: string;
}

function firstAddress(value: unknown): Address | null {
  const list = (value as { value?: Array<{ address?: string; name?: string }> } | undefined)?.value;
  const a = list?.[0];
  return a?.address ? { address: a.address.toLowerCase(), name: (a.name ?? '').trim() } : null;
}

export async function parseEmail(raw: Buffer): Promise<ParsedEmail> {
  const p = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const headers = new Map<string, string[]>();
  for (const line of p.headerLines) {
    // `line` is the full raw header line ("Name: value"), unfolded.
    const value = line.line.slice(line.line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim();
    headers.set(line.key, [...(headers.get(line.key) ?? []), value]);
  }
  const date = p.date && !Number.isNaN(p.date.getTime()) ? p.date : null;
  return { from: firstAddress(p.from), replyTo: firstAddress(p.replyTo), subject: (p.subject ?? '').trim(), date, headers, text: p.text ?? '' };
}

export function header(email: ParsedEmail, name: string): string | null {
  return email.headers.get(name.toLowerCase())?.[0]?.trim() ?? null;
}
