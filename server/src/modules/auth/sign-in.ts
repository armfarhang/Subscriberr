import type { AuthErrorCode } from '@subscriberr/shared';
import type { Config } from '../../config.js';
import { writeAudit } from '../../core/audit.js';
import type { SecretBox } from '../../core/crypto.js';
import type { Clock } from '../../core/time.js';
import { forWorkspace, type SystemContext } from '../../core/workspace-context.js';
import { ensureWorkspaceDir } from '../workspaces/files.js';
import { type AccountRecord, countAccounts, createAccount, findAccountByEmail, findAccountById } from './accounts.js';
import { isEmailAllowed } from './allowlist.js';
import { type GoogleIdentity, hasGmailScopes } from './google.js';

// Who may sign in, and what a sign-in writes (Spec §3, §5.1–§5.3, §5.5).
//  1. The email must be verified by Google.
//  2. A returning account is matched by its stable Google `sub`. An existing account with the
//     same email but a different `sub` is refused (never silently re-bound).
//  3. The very first account becomes the Owner. If ADMIN_EMAILS is set, the first account must
//     be one of those emails, so a stranger who finds a fresh install cannot claim it.
//  4. Everyone else must be on the allowlist (Settings or ADMIN_EMAILS) and becomes an Operator
//     with their own isolated workspace.
//  5. The refresh token is stored encrypted, and only when both Gmail scopes were granted.

export interface SignInDeps {
  ctx: SystemContext;
  clock: Clock;
  config: Pick<Config, 'adminEmails' | 'timezone' | 'workspacesDir'>;
  secretBox: SecretBox;
}

export interface SignInInput {
  identity: GoogleIdentity;
  /** Token result from Google; null for the development fake login, which touches no tokens. */
  tokens: { refreshToken: string | null; scopes: string[] } | null;
}

export type SignInResult =
  | { ok: true; account: AccountRecord; created: boolean; gmail: 'connected' | 'not_connected' | 'unchanged' }
  | { ok: false; reason: Extract<AuthErrorCode, 'email_unverified' | 'not_authorized' | 'account_mismatch'> };

export function completeSignIn(deps: SignInDeps, input: SignInInput): SignInResult {
  const { ctx, clock, config, secretBox } = deps;
  const { identity } = input;
  const email = identity.email.trim().toLowerCase();
  if (!identity.emailVerified) return { ok: false, reason: 'email_unverified' };

  // One synchronous transaction: two simultaneous first sign-ins cannot both become Owner
  // (and the single-owner unique index backs this up).
  const decided = ctx.sqlite.transaction((): SignInResult => {
    const bySub = ctx.sqlite.prepare('SELECT id FROM accounts WHERE google_sub = ?').get(identity.sub) as { id: number } | undefined;
    let account = bySub ? findAccountById(ctx, bySub.id) : null;
    let created = false;

    if (!account) {
      const sameEmail = findAccountByEmail(ctx, email);
      if (sameEmail) return { ok: false, reason: 'account_mismatch' };
      if (countAccounts(ctx) === 0) {
        if (config.adminEmails.length > 0 && !config.adminEmails.includes(email)) return { ok: false, reason: 'not_authorized' };
        account = createAccount(ctx, clock, { googleSub: identity.sub, email, role: 'owner', timezone: config.timezone });
      } else {
        if (!isEmailAllowed(ctx, config, email)) return { ok: false, reason: 'not_authorized' };
        account = createAccount(ctx, clock, { googleSub: identity.sub, email, role: 'operator', timezone: config.timezone });
      }
      created = true;
    } else {
      if (account.role !== 'owner' && !isEmailAllowed(ctx, config, account.email)) return { ok: false, reason: 'not_authorized' };
      if (account.email !== email) {
        // The Google account's address changed; keep following the stable `sub`.
        if (findAccountByEmail(ctx, email)) return { ok: false, reason: 'account_mismatch' };
        ctx.sqlite.prepare('UPDATE accounts SET email = ? WHERE id = ?').run(email, account.id);
      }
    }

    let gmail: 'connected' | 'not_connected' | 'unchanged' = 'unchanged';
    if (input.tokens) {
      const granted = hasGmailScopes(input.tokens.scopes);
      const existing = ctx.sqlite.prepare('SELECT refresh_token_enc FROM accounts WHERE id = ?').get(account.id) as { refresh_token_enc: string | null };
      if (granted && (input.tokens.refreshToken || existing.refresh_token_enc)) {
        const enc = input.tokens.refreshToken ? secretBox.encrypt(input.tokens.refreshToken) : existing.refresh_token_enc;
        ctx.sqlite
          .prepare(`UPDATE accounts SET refresh_token_enc = ?, scopes = ?, gmail_status = 'connected' WHERE id = ?`)
          .run(enc, input.tokens.scopes.join(' '), account.id);
        gmail = 'connected';
      } else {
        // Gmail was not granted: the workspace stays signed in, but scanning/sending is paused.
        ctx.sqlite
          .prepare(`UPDATE accounts SET refresh_token_enc = NULL, scopes = ?, gmail_status = 'disconnected' WHERE id = ?`)
          .run(input.tokens.scopes.join(' '), account.id);
        gmail = 'not_connected';
      }
    }

    writeAudit(forWorkspace(ctx, account.id), clock, {
      actor: `admin:${email}`,
      action: created ? 'auth.account_created' : 'auth.signed_in',
      entity: 'account',
      entityId: account.id,
      details: { role: account.role, gmail, method: input.tokens ? 'google' : 'dev' },
    });
    return { ok: true, account: findAccountById(ctx, account.id)!, created, gmail };
  })();

  if (decided.ok && decided.created) ensureWorkspaceDir(config.workspacesDir, decided.account.id);
  return decided;
}
