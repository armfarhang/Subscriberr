import type { Config } from '../../config.js';
import type { SecretBox } from '../../core/crypto.js';
import { forWorkspace, type SystemContext } from '../../core/workspace-context.js';
import type { GmailClient } from './client.js';
import { FakeGmail } from './fake.js';
import { createGoogleGmailClient } from './google-client.js';
import { readRefreshToken } from './tokens.js';

/** Returns the Gmail client for a workspace. */
export type GmailClientFactory = (accountId: number) => Promise<GmailClient>;

export class GmailUnavailableError extends Error {}

/**
 * Demo mode: one in-memory FakeGmail per workspace, pre-loaded with the fixtures (never the
 * network). Real mode: the workspace's own Google refresh token; fails loudly when Gmail is not
 * connected.
 */
export function createGmailClientFactory(
  config: Pick<Config, 'seedDemo'> & Partial<Pick<Config, 'googleClientId' | 'googleClientSecret'>>,
  deps?: { ctx: SystemContext; secretBox: SecretBox },
): GmailClientFactory {
  const demoClients = new Map<number, Promise<FakeGmail>>();
  return async (accountId) => {
    if (config.seedDemo) {
      let client = demoClients.get(accountId);
      if (!client) {
        client = FakeGmail.fromFixtures();
        demoClients.set(accountId, client);
      }
      return client;
    }
    if (!deps || !config.googleClientId || !config.googleClientSecret) throw new GmailUnavailableError('Google is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
    const ws = forWorkspace(deps.ctx, accountId);
    const status = ws.sqlite.prepare('SELECT gmail_status FROM accounts WHERE id = ?').get(accountId) as { gmail_status: string } | undefined;
    if (status?.gmail_status !== 'connected') throw new GmailUnavailableError('Gmail is not connected for this workspace.');
    const token = readRefreshToken(ws, deps.secretBox);
    if (!token) throw new GmailUnavailableError('Gmail is not connected for this workspace.');
    return createGoogleGmailClient({ clientId: config.googleClientId, clientSecret: config.googleClientSecret, refreshToken: token });
  };
}
