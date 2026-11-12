import { writeAudit } from '../../core/audit.js';
import type { SecretBox } from '../../core/crypto.js';
import type { Logger } from '../../core/logger.js';
import type { Clock } from '../../core/time.js';
import { forWorkspace, type SystemContext, type WorkspaceContext } from '../../core/workspace-context.js';
import type { GoogleAuthProvider } from '../auth/google.js';

// Gmail credential lifecycle (Spec §5.3): encrypted refresh token, invalid_grant → Disconnected
// (banner + scanning/sending paused), "Disconnect Google account" revokes and clears.

export interface TokenDeps {
  ctx: SystemContext;
  clock: Clock;
  secretBox: SecretBox;
  google: GoogleAuthProvider | null;
  log: Logger;
}

/** Marks a workspace's Gmail as disconnected and forgets the (unusable) refresh token. */
export function markGmailDisconnected(ws: WorkspaceContext, clock: Clock, reason: string): void {
  ws.sqlite.transaction(() => {
    ws.sqlite.prepare(`UPDATE accounts SET gmail_status = 'disconnected', refresh_token_enc = NULL WHERE id = ?`).run(ws.accountId);
    writeAudit(ws, clock, { actor: 'system', action: 'gmail.disconnected', entity: 'account', entityId: ws.accountId, details: { reason } });
  })();
}

/** The decrypted refresh token of a workspace, or null when there is none / it cannot be read. */
export function readRefreshToken(ws: WorkspaceContext, secretBox: SecretBox): string | null {
  const row = ws.sqlite.prepare('SELECT refresh_token_enc FROM accounts WHERE id = ?').get(ws.accountId) as { refresh_token_enc: string | null } | undefined;
  if (!row?.refresh_token_enc) return null;
  return secretBox.decrypt(row.refresh_token_enc);
}

/** "Disconnect Google account": revoke at Google (best effort), then clear the stored credentials. */
export async function disconnectGoogle(ws: WorkspaceContext, deps: Omit<TokenDeps, 'ctx'>, actor: string): Promise<{ revoked: boolean }> {
  let revoked = false;
  let token: string | null;
  try {
    token = readRefreshToken(ws, deps.secretBox);
  } catch {
    token = null; // unreadable (e.g. APP_SECRET changed): nothing to revoke, still clear it
  }
  if (token && deps.google) {
    try {
      await deps.google.revokeToken(token);
      revoked = true;
    } catch (err) {
      deps.log.warn('google token revoke failed; clearing local credentials anyway', { accountId: ws.accountId, err });
    }
  }
  ws.sqlite.transaction(() => {
    ws.sqlite.prepare(`UPDATE accounts SET gmail_status = 'disconnected', refresh_token_enc = NULL, scopes = NULL WHERE id = ?`).run(ws.accountId);
    writeAudit(ws, deps.clock, { actor, action: 'gmail.disconnected_by_admin', entity: 'account', entityId: ws.accountId, details: { revoked } });
  })();
  return { revoked };
}

export interface TokenHealthStats {
  checked: number;
  ok: number;
  disconnected: number;
  errors: number;
}

/**
 * Hourly token health check over every workspace that holds a token. One workspace's failure
 * never blocks another (Spec §5.5).
 */
export async function checkGmailTokens(deps: TokenDeps): Promise<TokenHealthStats> {
  const stats: TokenHealthStats = { checked: 0, ok: 0, disconnected: 0, errors: 0 };
  if (!deps.google) return stats;
  const accounts = deps.ctx.sqlite.prepare('SELECT id FROM accounts WHERE refresh_token_enc IS NOT NULL ORDER BY id').all() as Array<{ id: number }>;
  for (const { id } of accounts) {
    const ws = forWorkspace(deps.ctx, id);
    stats.checked++;
    try {
      let token: string | null;
      try {
        token = readRefreshToken(ws, deps.secretBox);
      } catch {
        // Encrypted with a different APP_SECRET: the owner must re-link Google (§6.9 "Lost APP_SECRET").
        deps.ctx.sqlite.prepare(`UPDATE accounts SET gmail_status = 'error' WHERE id = ?`).run(id);
        stats.errors++;
        continue;
      }
      if (!token) continue;
      const result = await deps.google.refreshAccessToken(token);
      if (result.ok) {
        deps.ctx.sqlite.prepare(`UPDATE accounts SET gmail_status = 'connected' WHERE id = ? AND gmail_status <> 'connected'`).run(id);
        stats.ok++;
      } else if (result.reason === 'invalid_grant') {
        markGmailDisconnected(ws, deps.clock, 'invalid_grant');
        deps.log.warn('gmail token revoked or expired; workspace disconnected', { accountId: id });
        stats.disconnected++;
      } else {
        deps.log.warn('gmail token check failed (will retry)', { accountId: id, error: result.message });
        stats.errors++;
      }
    } catch (err) {
      deps.log.error('gmail token check crashed for one workspace', { accountId: id, err });
      stats.errors++;
    }
  }
  return stats;
}
