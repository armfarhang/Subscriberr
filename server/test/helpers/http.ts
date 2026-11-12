import { expect } from 'vitest';
import type { createApp } from '../../src/app.js';
import type { FakeGoogleAuthProvider } from '../../src/modules/auth/fake-google.js';

export type App = ReturnType<typeof createApp>;

export const CSRF = { 'x-requested-with': 'subscriberr', 'content-type': 'application/json' };

/** `name=value` of a Set-Cookie header with the given cookie name, or null. */
export function cookieFrom(res: Response, name: string): string | null {
  const header = res.headers.getSetCookie().find((h) => h.startsWith(`${name}=`));
  return header ? header.split(';')[0]! : null;
}

export function setCookieHeader(res: Response, name: string): string | null {
  return res.headers.getSetCookie().find((h) => h.startsWith(`${name}=`)) ?? null;
}

export interface GoogleSignInOptions {
  email: string;
  grantGmail?: boolean;
  emailVerified?: boolean;
  /** Existing cookies (e.g. a current session) sent with every request. */
  cookie?: string;
  returnTo?: string;
  headers?: Record<string, string>;
}

/** Walks the whole browser flow: /auth/google/start → (fake) Google consent → /auth/google/callback. */
export async function googleSignIn(app: App, google: FakeGoogleAuthProvider, options: GoogleSignInOptions) {
  const base = { ...(options.headers ?? {}), ...(options.cookie ? { cookie: options.cookie } : {}) };
  const start = await app.request(`/auth/google/start${options.returnTo ? `?return_to=${encodeURIComponent(options.returnTo)}` : ''}`, { headers: base });
  expect(start.status).toBe(302);
  const authorizeUrl = new URL(start.headers.get('location')!);
  const state = authorizeUrl.searchParams.get('state')!;
  const challenge = authorizeUrl.searchParams.get('code_challenge')!;
  const oauthCookie = cookieFrom(start, 'subscriberr_oauth')!;
  const code = google.issueCode({ email: options.email, codeChallenge: challenge, grantGmail: options.grantGmail, emailVerified: options.emailVerified });
  const cookie = [options.cookie, oauthCookie].filter(Boolean).join('; ');
  const callback = await app.request(`/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, { headers: { ...(options.headers ?? {}), cookie } });
  return {
    start,
    authorizeUrl,
    state,
    challenge,
    code,
    oauthCookie,
    callback,
    location: callback.headers.get('location'),
    sessionCookie: cookieFrom(callback, 'subscriberr_session'),
  };
}
