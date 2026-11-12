import type { AllowedAccount } from '@subscriberr/shared';
import type { Config } from '../../config.js';
import { writeAudit } from '../../core/audit.js';
import { conflict, notFound } from '../../core/errors.js';
import { type Clock, nowIso } from '../../core/time.js';
import { forWorkspace, type SystemContext } from '../../core/workspace-context.js';
import { type AccountRecord, findAccountByEmail } from './accounts.js';

// Sign-in allowlist (Spec §5.5): after the first account (the Owner), only emails on this list —
// managed by the Owner in Settings, plus the optional ADMIN_EMAILS seed — may sign in.

const normalize = (email: string) => email.trim().toLowerCase();

export function isEmailAllowed(ctx: SystemContext, config: Pick<Config, 'adminEmails'>, email: string): boolean {
  const e = normalize(email);
  if (config.adminEmails.includes(e)) return true;
  return Boolean(ctx.sqlite.prepare('SELECT 1 FROM allowed_accounts WHERE email = ?').get(e));
}

/** Whether an existing account may still sign in / keep its sessions. The Owner always may. */
export function mayUseAccount(ctx: SystemContext, config: Pick<Config, 'adminEmails'>, account: AccountRecord): boolean {
  return account.role === 'owner' || isEmailAllowed(ctx, config, account.email);
}

export function listAllowedAccounts(ctx: SystemContext, config: Pick<Config, 'adminEmails'>): AllowedAccount[] {
  const rows = ctx.sqlite
    .prepare(
      `SELECT a.email, a.added_by, a.created_at, acc.role
         FROM allowed_accounts a LEFT JOIN accounts acc ON acc.email = a.email
        ORDER BY a.email`,
    )
    .all() as Array<{ email: string; added_by: string | null; created_at: string; role: AccountRecord['role'] | null }>;
  const items: AllowedAccount[] = config.adminEmails.map((email) => ({
    email,
    source: 'env',
    addedBy: 'ADMIN_EMAILS',
    createdAt: null,
    role: findAccountByEmail(ctx, email)?.role ?? null,
  }));
  for (const r of rows) {
    if (config.adminEmails.includes(r.email)) continue; // shown once, as the env entry
    items.push({ email: r.email, source: 'settings', addedBy: r.added_by, createdAt: r.created_at, role: r.role });
  }
  return items.sort((a, b) => a.email.localeCompare(b.email));
}

export function addAllowedAccount(ctx: SystemContext, clock: Clock, owner: AccountRecord, email: string): void {
  const e = normalize(email);
  if (e === owner.email) throw conflict('You are the owner; your account is always allowed');
  const exists = ctx.sqlite.prepare('SELECT 1 FROM allowed_accounts WHERE email = ?').get(e);
  if (exists) throw conflict('That email is already allowed');
  ctx.sqlite.transaction(() => {
    ctx.sqlite
      .prepare('INSERT INTO allowed_accounts (account_id, email, added_by, created_at) VALUES (?, ?, ?, ?)')
      .run(owner.id, e, `admin:${owner.email}`, nowIso(clock));
    writeAudit(forWorkspace(ctx, owner.id), clock, { actor: `admin:${owner.email}`, action: 'allowlist.added', entity: 'allowlist', details: { email: e } });
  })();
}

/**
 * Removes an email. If that person already has a workspace, their sessions end immediately and
 * they cannot sign in again (their workspace data is kept, not deleted). ADMIN_EMAILS entries
 * can only be removed from the environment.
 */
export function removeAllowedAccount(ctx: SystemContext, clock: Clock, config: Pick<Config, 'adminEmails'>, owner: AccountRecord, email: string): { sessionsEnded: number } {
  const e = normalize(email);
  if (config.adminEmails.includes(e)) throw conflict('This email comes from ADMIN_EMAILS; remove it from the environment instead');
  const row = ctx.sqlite.prepare('SELECT 1 FROM allowed_accounts WHERE email = ?').get(e);
  if (!row) throw notFound('That email is not on the allowlist');
  return ctx.sqlite.transaction(() => {
    ctx.sqlite.prepare('DELETE FROM allowed_accounts WHERE email = ?').run(e);
    const account = findAccountByEmail(ctx, e);
    let sessionsEnded = 0;
    if (account && account.role !== 'owner') {
      sessionsEnded = ctx.sqlite.prepare('DELETE FROM sessions WHERE account_id = ?').run(account.id).changes;
    }
    writeAudit(forWorkspace(ctx, owner.id), clock, { actor: `admin:${owner.email}`, action: 'allowlist.removed', entity: 'allowlist', details: { email: e, sessionsEnded } });
    return { sessionsEnded };
  })();
}
