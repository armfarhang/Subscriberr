import type { MediaServerType } from '@subscriberr/shared';
import type { Config } from '../../config.js';
import { DEMO_JELLYFIN_URL, DEMO_PLEX_URL } from '../../db/seed-demo.js';
import { createDemoJellyfin, createDemoPlex, type FakeMediaServer } from './fake.js';
import { JellyfinProvider } from './jellyfin.js';
import { guardedFetch, mediaUrlProblem } from './net-guard.js';
import { PlexProvider } from './plex.js';
import type { MediaServerProvider } from './provider.js';

export interface MediaServerRef {
  id: number;
  type: MediaServerType;
  baseUrl: string;
}

export interface ServerSecrets {
  /** Plex: the admin token. Jellyfin: the API key. */
  token: string;
  /** Plex: the server's machine identifier (filled in by "Test connection"). */
  machineId?: string | null;
  options?: { disableOnRevoke?: boolean; endSessionsOnRevoke?: boolean };
}

export type MediaProviderFactory = (server: MediaServerRef) => MediaServerProvider;

export interface FactoryOptions {
  /** Decrypted credentials of a configured server (main.ts wires it to the database). */
  credentialsFor?: (serverId: number) => ServerSecrets | null;
  /** Injectable HTTP (tests use mocked responses; nothing contacts real servers in tests). */
  fetch?: typeof fetch;
}

/**
 * Resolves a configured server to its provider. `fake://` servers exist only in demo mode; real
 * URLs get the Plex / Jellyfin adapters with the server's own credentials.
 */
export function createMediaProviderFactory(config: Pick<Config, 'seedDemo'> & Partial<Pick<Config, 'isProduction'>>, opts: FactoryOptions = {}): MediaProviderFactory {
  // SSRF guard (see net-guard.ts). Loopback is only reachable in development outside Docker;
  // host names are resolved and checked only for the real network (an injected fetch is a mock).
  const guard = { allowLoopback: config.isProduction === false };
  const http = guardedFetch(opts.fetch ?? fetch, { ...guard, resolve: opts.fetch ? null : undefined });
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
    const secrets = opts.credentialsFor?.(server.id);
    if (!secrets?.token) throw new Error('This server has no credentials. Edit it and enter the token / API key.');
    const problem = mediaUrlProblem(server.baseUrl, guard);
    if (problem) throw new Error(`This server's address cannot be used: ${problem}.`);
    return server.type === 'plex'
      ? new PlexProvider(server.baseUrl, { token: secrets.token, machineId: secrets.machineId }, http)
      : new JellyfinProvider(server.baseUrl, secrets.token, secrets.options ?? {}, http);
  };
}
