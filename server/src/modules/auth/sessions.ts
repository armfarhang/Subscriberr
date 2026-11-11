import { toUtcIso } from '@subscriberr/shared';
import { hashToken, randomToken } from '../../core/crypto.js';
import { type Clock, nowIso } from '../../core/time.js';
import type { SystemContext } from '../../core/workspace-context.js';
import { type AccountRecord, findAccountById } from './accounts.js';

// Server-side sessions (Spec §5.1): the cookie carries a random token, the database stores only
// its sha256. Sliding 14-day expiry.

export const SESSION_COOKIE = 'subscriberr_session';
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** `last_seen_at` / expiry are refreshed at most this often to keep writes rare. */
const TOUCH_INTERVAL_MS = 60_000;

export function createSession(ctx: SystemContext, clock: Clock, accountId: number, meta: { userAgent?: string | null; ip?: string | null } = {}): string {
  const token = randomToken(32);
  const now = clock.now();
  ctx.sqlite
    .prepare(`INSERT INTO sessions (id, account_id, created_at, expires_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(hashToken(token), accountId, toUtcIso(now), toUtcIso(new Date(now.getTime() + SESSION_TTL_MS)), toUtcIso(now), meta.userAgent?.slice(0, 400) ?? null, meta.ip ?? null);
  return token;
}

/** Resolves a cookie token to its account, sliding the expiry. Expired sessions are deleted. */
export function resolveSession(ctx: SystemContext, clock: Clock, token: string): AccountRecord | null {
  const id = hashToken(token);
  const row = ctx.sqlite.prepare('SELECT account_id, expires_at, last_seen_at FROM sessions WHERE id = ?').get(id) as
    | { account_id: number; expires_at: string; last_seen_at: string }
    | undefined;
  if (!row) return null;
  const now = clock.now();
  if (Date.parse(row.expires_at) <= now.getTime()) {
    ctx.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  if (now.getTime() - Date.parse(row.last_seen_at) >= TOUCH_INTERVAL_MS) {
    ctx.sqlite
      .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(toUtcIso(now), toUtcIso(new Date(now.getTime() + SESSION_TTL_MS)), id);
  }
  return findAccountById(ctx, row.account_id);
}

export function deleteSession(ctx: SystemContext, token: string): void {
  ctx.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
}

export function deleteExpiredSessions(ctx: SystemContext, clock: Clock): number {
  return ctx.sqlite.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso(clock)).changes;
}
