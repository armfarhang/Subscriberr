import type { Config } from '../../config.js';
import type { Clock } from '../../core/time.js';
import { FakeGoogleAuthProvider } from './fake-google.js';
import { createGoogleAuthProvider, type GoogleAuthProvider } from './google.js';

/**
 * Picks the Google provider for this configuration:
 *  - demo mode (SEED_DEMO) or fake login without real credentials → the in-process fake;
 *  - real credentials and no demo mode → real Google;
 *  - otherwise none (the "Sign in with Google" button is hidden).
 * Demo mode never talks to real Google, even when credentials are present.
 */
export async function createGoogleProviderForConfig(config: Config, clock: Clock): Promise<GoogleAuthProvider | null> {
  const hasRealCredentials = Boolean(config.googleClientId && config.googleClientSecret);
  if (config.seedDemo || (config.devFakeLogin && !hasRealCredentials)) return new FakeGoogleAuthProvider(config.baseUrl, clock);
  if (hasRealCredentials) {
    return createGoogleAuthProvider({ clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: config.googleRedirectUri });
  }
  return null;
}
