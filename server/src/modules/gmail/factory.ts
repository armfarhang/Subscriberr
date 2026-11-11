import type { Config } from '../../config.js';
import type { GmailClient } from './client.js';
import { FakeGmail } from './fake.js';

/** Returns the Gmail client for a workspace. */
export type GmailClientFactory = (accountId: number) => Promise<GmailClient>;

/**
 * Demo mode: one in-memory FakeGmail per workspace, pre-loaded with the fixtures.
 * Real mode: implemented with Google OAuth in Milestone 2 / ingestion in Milestone 5; until then
 * it fails loudly rather than pretending.
 */
export function createGmailClientFactory(config: Pick<Config, 'seedDemo'>): GmailClientFactory {
  const demoClients = new Map<number, Promise<FakeGmail>>();
  return (accountId) => {
    if (!config.seedDemo) {
      return Promise.reject(new Error('The real Gmail client is not available yet (Milestone 2/5). Use demo mode (SEED_DEMO=true).'));
    }
    let client = demoClients.get(accountId);
    if (!client) {
      client = FakeGmail.fromFixtures();
      demoClients.set(accountId, client);
    }
    return client;
  };
}
