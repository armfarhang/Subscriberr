import type { AccountRole, GmailStatus, Me } from '@subscriberr/shared';
import { type Clock, nowIso } from '../../core/time.js';
import type { SystemContext } from '../../core/workspace-context.js';

export interface AccountRecord {
  id: number;
  googleSub: string;
  email: string;
  role: AccountRole;
  gmailStatus: GmailStatus;
  timezone: string;
}

interface AccountRow {
  id: number;
  google_sub: string;
  email: string;
  role: AccountRole;
  gmail_status: GmailStatus;
  timezone: string;
}

const COLUMNS = 'id, google_sub, email, role, gmail_status, timezone';

const toRecord = (r: AccountRow): AccountRecord => ({
  id: r.id,
  googleSub: r.google_sub,
  email: r.email,
  role: r.role,
  gmailStatus: r.gmail_status,
  timezone: r.timezone,
});

export function findAccountById(ctx: SystemContext, id: number): AccountRecord | null {
  const row = ctx.sqlite.prepare(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined;
  return row ? toRecord(row) : null;
}

export function findAccountByEmail(ctx: SystemContext, email: string): AccountRecord | null {
  const row = ctx.sqlite.prepare(`SELECT ${COLUMNS} FROM accounts WHERE email = ?`).get(email.trim().toLowerCase()) as AccountRow | undefined;
  return row ? toRecord(row) : null;
}

export function countAccounts(ctx: SystemContext): number {
  return (ctx.sqlite.prepare('SELECT count(*) AS n FROM accounts').get() as { n: number }).n;
}

export function createAccount(
  ctx: SystemContext,
  clock: Clock,
  input: { googleSub: string; email: string; role: AccountRole; timezone: string; gmailStatus?: GmailStatus },
): AccountRecord {
  const info = ctx.sqlite
    .prepare(`INSERT INTO accounts (google_sub, email, role, gmail_status, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(input.googleSub, input.email.trim().toLowerCase(), input.role, input.gmailStatus ?? 'disconnected', input.timezone, nowIso(clock));
  const account = findAccountById(ctx, Number(info.lastInsertRowid));
  if (!account) throw new Error('Account insert failed');
  return account;
}

export const toMe = (a: AccountRecord): Me => ({ id: a.id, email: a.email, role: a.role, gmailStatus: a.gmailStatus, timezone: a.timezone });
