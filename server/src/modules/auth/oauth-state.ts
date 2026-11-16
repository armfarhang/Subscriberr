import { timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { isLocalhostUrl } from '../../config.js';
import { randomToken, type SecretBox } from '../../core/crypto.js';
import type { Clock } from '../../core/time.js';
import { createPkcePair } from './google.js';

// OAuth `state` + PKCE verifier between /auth/google/start and the callback (Spec §5.1).
// Stored in a short-lived, encrypted, HttpOnly cookie scoped to /auth/google — nothing to clean
// up server-side, survives restarts, and is single use (the callback always deletes it).

export const OAUTH_COOKIE = 'subscriberr_oauth';
const COOKIE_PATH = '/auth/google';
const TTL_MS = 10 * 60_000;

export interface OAuthPending {
  state: string;
  verifier: string;
  /** Where to land after sign-in (validated before it is stored). */
  returnTo: string;
  expiresAt: number;
}

export function beginOAuth(c: Context, box: SecretBox, clock: Clock, options: { secure: boolean; returnTo: string }): { state: string; challenge: string } {
  const { verifier, challenge } = createPkcePair();
  const pending: OAuthPending = { state: randomToken(24), verifier, returnTo: options.returnTo, expiresAt: clock.now().getTime() + TTL_MS };
  setCookie(c, OAUTH_COOKIE, box.encrypt(JSON.stringify(pending)), {
    httpOnly: true,
    // Lax: the browser sends it on Google's top-level GET redirect back to us.
    sameSite: 'Lax',
    secure: options.secure,
    path: COOKIE_PATH,
    maxAge: Math.floor(TTL_MS / 1000),
  });
  return { state: pending.state, challenge };
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Reads and ALWAYS clears the pending OAuth cookie. Returns null when missing, expired, tampered or the state differs. */
export function consumeOAuth(c: Context, box: SecretBox, clock: Clock, options: { secure: boolean; state: string | undefined }): OAuthPending | null {
  const raw = getCookie(c, OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, { path: COOKIE_PATH, secure: options.secure });
  if (!raw || !options.state) return null;
  try {
    const pending = JSON.parse(box.decrypt(raw)) as OAuthPending;
    if (typeof pending.state !== 'string' || typeof pending.verifier !== 'string') return null;
    if (pending.expiresAt < clock.now().getTime()) return null;
    return sameString(pending.state, options.state) ? pending : null;
  } catch {
    return null;
  }
}

/**
 * Validates a post-sign-in destination. Same-origin paths are always fine; in development the
 * Vite dev server on another localhost port is allowed too. Anything else falls back to "/".
 */
export function safeReturnTo(value: string | undefined, options: { baseUrl: string; isProduction: boolean }): string {
  if (!value || value.length > 2000) return '/';
  // Browsers strip tabs/newlines inside URLs ("/<tab>/evil.example" becomes "//evil.example"), so
  // any control character disqualifies the value outright.
  if ([...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return '/';
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return value;
  try {
    const url = new URL(value);
    if (url.origin === new URL(options.baseUrl).origin) return url.pathname + url.search;
    // The Vite dev server is only a valid destination while the app itself runs on localhost.
    const localDev = !options.isProduction && isLocalhostUrl(options.baseUrl);
    if (localDev && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) return url.toString();
  } catch {
    /* not a URL */
  }
  return '/';
}
