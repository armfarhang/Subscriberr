import type { MediaServerType } from '@subscriberr/shared';
import type { Config } from '../../config.js';
import { DEMO_JELLYFIN_URL, DEMO_PLEX_URL } from '../../db/seed-demo.js';
import { createDemoJellyfin, createDemoPlex, type FakeMediaServer } from './fake.js';
import type { MediaServerProvider } from './provider.js';

export interface MediaServerRef {
  id: number;
  type: MediaServerType;
  baseUrl: string;
}

export type MediaProviderFactory = (server: MediaServerRef) => MediaServerProvider;

/**
 * Resolves a configured server to its provider. `fake://` servers exist only in demo mode
 * (SEED_DEMO); real Plex/Jellyfin adapters arrive in Milestone 9 and fail loudly until then,
 * so nothing can accidentally contact a real server.
 */
export function createMediaProviderFactory(config: Pick<Config, 'seedDemo'>): MediaProviderFactory {
  const fakes = new Map<number, FakeMediaServer>();
  return (server) => {
    if (server.baseUrl.startsWith('fake://')) {
      if (!config.seedDemo) throw new Error('fake:// media servers are only available in demo mode (SEED_DEMO=true)');
      let fake = fakes.get(server.id);
      if (!fake) {
        if (server.baseUrl === DEMO_PLEX_URL && server.type === 'plex') fake = createDemoPlex();
        else if (server.baseUrl === DEMO_JELLYFIN_URL && server.type === 'jellyfin') fake = createDemoJellyfin();
        else throw new Error(`Unknown fake media server ${server.baseUrl}`);
        fakes.set(server.id, fake);
      }
      return fake;
    }
    throw new Error(`The real ${server.type} adapter is not available yet (Milestone 9).`);
  };
}
