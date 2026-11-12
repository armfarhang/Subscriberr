import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from '../../src/config.js';
import { FakeClock } from '../../src/core/time.js';
import { clientIpFrom } from '../../src/http/middleware.js';
import { rateLimit } from '../../src/http/rate-limit.js';
import { FakeGoogleAuthProvider } from '../../src/modules/auth/fake-google.js';
import { createGoogleAuthProvider, createPkcePair, GMAIL_SCOPES, hasGmailScopes, isInvalidGrant, pkceChallenge, SIGN_IN_SCOPES } from '../../src/modules/auth/google.js';
import { safeReturnTo } from '../../src/modules/auth/oauth-state.js';
import { resolveInWorkspace, workspaceDir } from '../../src/modules/workspaces/files.js';
import { Hono } from 'hono';

describe('TRUST_PROXY and client IP (Spec §5.4)', () => {
  it('parses true/false/hop counts', () => {
    expect(parseTrustProxy(undefined)).toBe(0);
    expect(parseTrustProxy('false')).toBe(0);
    expect(parseTrustProxy('true')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('maybe')).toBeNull();
    expect(parseTrustProxy('11')).toBeNull();
  });

  it('takes the address the trusted proxy appended, not a client-supplied one', () => {
    // A client sends its own X-Forwarded-For; NPM appends the real address.
    expect(clientIpFrom('6.6.6.6, 203.0.113.9', '172.18.0.2', 1)).toBe('203.0.113.9');
    // Two proxies (e.g. Cloudflare → NPM): the second-to-last hop.
    expect(clientIpFrom('6.6.6.6, 198.51.100.7, 162.158.0.1', '172.18.0.2', 2)).toBe('198.51.100.7');
    // Without TRUST_PROXY the header is ignored entirely.
    expect(clientIpFrom('6.6.6.6', '192.168.1.20', 0)).toBe('192.168.1.20');
    expect(clientIpFrom(undefined, '192.168.1.20', 1)).toBe('192.168.1.20');
  });
});

describe('PKCE and scopes', () => {
  it('uses S256 challenges (RFC 7636 appendix B vector)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const pair = createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pkceChallenge(pair.verifier)).toBe(pair.challenge);
  });

  it('requires both Gmail scopes', () => {
    expect(hasGmailScopes(SIGN_IN_SCOPES)).toBe(true);
    expect(hasGmailScopes(['openid', 'email', GMAIL_SCOPES[0]])).toBe(false);
  });

  it('recognises invalid_grant errors', () => {
    expect(isInvalidGrant({ response: { data: { error: 'invalid_grant' } } })).toBe(true);
    expect(isInvalidGrant(new Error('invalid_grant: Token has been expired or revoked.'))).toBe(true);
    expect(isInvalidGrant(new Error('ECONNRESET'))).toBe(false);
  });

  it('the real provider builds an offline, consent, PKCE authorization URL with the BASE_URL redirect (no network)', async () => {
    const google = await createGoogleAuthProvider({ clientId: 'client-123', clientSecret: 'secret', redirectUri: 'https://subscriberr.mediaservers.org/auth/google/callback' });
    const url = new URL(google.authorizationUrl({ state: 'st', codeChallenge: 'ch', loginHint: 'a@example.com' }));
    expect(url.origin).toBe('https://accounts.google.com');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe('client-123');
    expect(p.get('redirect_uri')).toBe('https://subscriberr.mediaservers.org/auth/google/callback');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('state')).toBe('st');
    expect(p.get('code_challenge')).toBe('ch');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('login_hint')).toBe('a@example.com');
    expect(p.get('scope')!.split(' ').sort()).toEqual([...SIGN_IN_SCOPES].sort());
    const switching = new URL(google.authorizationUrl({ state: 's', codeChallenge: 'c', selectAccount: true })).searchParams;
    expect(switching.get('prompt')).toBe('consent select_account');
    expect(switching.has('login_hint')).toBe(false);
  }, 60_000);

  it('the fake provider enforces single-use codes and PKCE', async () => {
    const google = new FakeGoogleAuthProvider('http://localhost:3000', new FakeClock());
    const { verifier, challenge } = createPkcePair();
    const code = google.issueCode({ email: 'A@Example.com', codeChallenge: challenge });
    await expect(google.exchangeCode({ code, codeVerifier: 'wrong' })).rejects.toThrow(/PKCE/);
    const code2 = google.issueCode({ email: 'a@example.com', codeChallenge: challenge });
    const result = await google.exchangeCode({ code: code2, codeVerifier: verifier });
    expect(result.identity).toEqual({ sub: 'fake:a@example.com', email: 'a@example.com', emailVerified: true, name: null });
    await expect(google.exchangeCode({ code: code2, codeVerifier: verifier })).rejects.toThrow(/used/);
    expect(await google.refreshAccessToken(result.refreshToken!)).toEqual({ ok: true });
    google.invalidate(result.refreshToken!);
    expect(await google.refreshAccessToken(result.refreshToken!)).toMatchObject({ ok: false, reason: 'invalid_grant' });
  });
});

describe('return_to after sign-in', () => {
  const dev = { baseUrl: 'http://localhost:3000', isProduction: false };
  const prod = { baseUrl: 'https://subscriberr.mediaservers.org', isProduction: true };
  it('allows same-origin paths and, in development, the local Vite server', () => {
    expect(safeReturnTo('/settings', prod)).toBe('/settings');
    expect(safeReturnTo('https://subscriberr.mediaservers.org/members?x=1', prod)).toBe('/members?x=1');
    expect(safeReturnTo('http://localhost:5173/', dev)).toBe('http://localhost:5173/');
  });
  it('refuses open redirects', () => {
    for (const bad of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'http://localhost:5173/']) {
      expect(safeReturnTo(bad, prod), bad).toBe('/');
    }
    expect(safeReturnTo(undefined, prod)).toBe('/');
  });
});

describe('rate limiting', () => {
  it('limits per key per window and resets', async () => {
    const clock = new FakeClock();
    const app = new Hono();
    app.use('*', rateLimit({ windowMs: 60_000, max: 2, clock, key: (c) => c.req.header('x-ip') ?? null, onLimited: (c) => c.text('slow down', 429) }));
    app.get('/', (c) => c.text('ok'));
    const hit = (ip: string) => app.request('/', { headers: { 'x-ip': ip } });
    expect((await hit('a')).status).toBe(200);
    expect((await hit('a')).status).toBe(200);
    const limited = await hit('a');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await hit('b')).status).toBe(200);
    clock.advanceMs(60_001);
    expect((await hit('a')).status).toBe(200);
  });
});

describe('workspace files (Spec §5.5)', () => {
  it('stay inside the workspace directory', () => {
    const root = '/data/workspaces';
    expect(workspaceDir(root, 7).replace(/\\/g, '/')).toMatch(/\/data\/workspaces\/7$/);
    expect(resolveInWorkspace(root, 7, 'templates/custom/layout.html').replace(/\\/g, '/')).toMatch(/\/data\/workspaces\/7\/templates\/custom\/layout\.html$/);
    for (const bad of ['../8/templates/x.html', '../../etc/passwd', '/etc/passwd', 'a/../../8']) {
      expect(() => resolveInWorkspace(root, 7, bad), bad).toThrow();
    }
    expect(() => workspaceDir(root, 0)).toThrow();
  });
});
