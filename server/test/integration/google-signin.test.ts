import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/core/logger.js';
import { FakeGoogleAuthProvider } from '../../src/modules/auth/fake-google.js';
import { SIGN_IN_SCOPES } from '../../src/modules/auth/google.js';
import { checkGmailTokens } from '../../src/modules/gmail/tokens.js';
import { AUTH_RATE_LIMIT } from '../../src/app.js';
import { allowEmail, createWorld, insertAccount, testApp, testConfig } from '../helpers/env.js';
import { CSRF, cookieFrom, googleSignIn, setCookieHeader } from '../helpers/http.js';

function setup(env: NodeJS.ProcessEnv = {}) {
  const world = createWorld({ env });
  const { app, google, secretBox } = testApp(world);
  return { world, app, google: google as FakeGoogleAuthProvider, secretBox };
}

const accounts = (world: ReturnType<typeof createWorld>) =>
  world.db.prepare('SELECT id, email, role, gmail_status, refresh_token_enc, scopes FROM accounts ORDER BY id').all() as Array<{
    id: number;
    email: string;
    role: string;
    gmail_status: string;
    refresh_token_enc: string | null;
    scopes: string | null;
  }>;

describe('Google sign-in: authorization code + PKCE (Spec §5.1)', () => {
  it('start redirects to Google with state and an S256 challenge, in a short-lived HttpOnly cookie', async () => {
    const { app } = setup();
    const res = await app.request('/auth/google/start', { headers: { 'x-forwarded-host': 'evil.example', host: 'evil.example' } });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.origin).toBe('http://localhost:3000'); // the fake consent page, built from BASE_URL only
    expect(url.pathname).toBe('/dev/google/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')!.length).toBeGreaterThanOrEqual(32);
    const cookie = setCookieHeader(res, 'subscriberr_oauth')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/auth\/google/);
    expect(cookie).toMatch(/Max-Age=600/);
    // The cookie is encrypted: neither the state nor the verifier is readable.
    expect(cookie).not.toContain(url.searchParams.get('state')!);
  });

  it('the first account becomes the owner; the refresh token is stored encrypted', async () => {
    const { world, app, google, secretBox } = setup();
    const flow = await googleSignIn(app, google, { email: 'Owner@Example.com' });
    expect(flow.callback.status).toBe(302);
    expect(flow.location).toBe('/');
    expect(flow.sessionCookie).toBeTruthy();
    expect(cookieFrom(flow.callback, 'subscriberr_oauth')).toBe('subscriberr_oauth='); // cleared: single use

    const [row] = accounts(world);
    expect(row).toMatchObject({ email: 'owner@example.com', role: 'owner', gmail_status: 'connected', scopes: SIGN_IN_SCOPES.join(' ') });
    const issued = google.issuedRefreshTokens.at(-1)!;
    expect(row!.refresh_token_enc).toMatch(/^v1:k1:/);
    expect(row!.refresh_token_enc).not.toContain(issued);
    expect(secretBox.decrypt(row!.refresh_token_enc!)).toBe(issued);

    const me = await app.request('/api/me', { headers: { cookie: flow.sessionCookie! } });
    expect(await me.json()).toMatchObject({ email: 'owner@example.com', role: 'owner', gmailStatus: 'connected', onboardingCompleted: false });
    // The token is never exposed by the API.
    expect(JSON.stringify(await (await app.request('/api/workspace/settings', { headers: { cookie: flow.sessionCookie! } })).json())).not.toContain('refresh');
    expect(existsSync(path.join(world.workspacesDir, String(row!.id)))).toBe(true);
  });

  it('rejects a missing, forged or replayed state', async () => {
    const { world, app, google } = setup();
    const start = await app.request('/auth/google/start');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const oauthCookie = cookieFrom(start, 'subscriberr_oauth')!;
    const challenge = new URL(start.headers.get('location')!).searchParams.get('code_challenge')!;
    const code = google.issueCode({ email: 'a@example.com', codeChallenge: challenge });

    const noCookie = await app.request(`/auth/google/callback?code=${code}&state=${state}`);
    expect(noCookie.headers.get('location')).toBe('/?auth_error=state_mismatch');
    const wrongState = await app.request(`/auth/google/callback?code=${code}&state=forged`, { headers: { cookie: oauthCookie } });
    expect(wrongState.headers.get('location')).toBe('/?auth_error=state_mismatch');
    const mid = Math.floor(oauthCookie.length / 2);
    const flipped = oauthCookie.slice(0, mid) + (oauthCookie[mid] === 'A' ? 'B' : 'A') + oauthCookie.slice(mid + 1);
    const tampered = await app.request(`/auth/google/callback?code=${code}&state=${state}`, { headers: { cookie: flipped } });
    expect(tampered.headers.get('location')).toBe('/?auth_error=state_mismatch');
    expect(accounts(world)).toEqual([]);

    // A real, completed callback cannot be replayed: the code is single use.
    const ok = await app.request(`/auth/google/callback?code=${code}&state=${state}`, { headers: { cookie: oauthCookie } });
    expect(ok.headers.get('location')).toBe('/');
    const replay = await app.request(`/auth/google/callback?code=${code}&state=${state}`, { headers: { cookie: oauthCookie } });
    expect(replay.headers.get('location')).toBe('/?auth_error=exchange_failed');
    expect(cookieFrom(replay, 'subscriberr_session')).toBeNull();
  });

  it('expires the pending sign-in after 10 minutes', async () => {
    const { world, app } = setup();
    const start = await app.request('/auth/google/start');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    world.clock.advanceMs(10 * 60_000 + 1000);
    const res = await app.request(`/auth/google/callback?code=x&state=${state}`, { headers: { cookie: cookieFrom(start, 'subscriberr_oauth')! } });
    expect(res.headers.get('location')).toBe('/?auth_error=state_mismatch');
  });

  it('fails the exchange when the PKCE verifier does not match', async () => {
    const { world, app, google } = setup();
    const start = await app.request('/auth/google/start');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    // An attacker's code, issued for a different challenge.
    const code = google.issueCode({ email: 'a@example.com', codeChallenge: 'attacker-challenge' });
    const res = await app.request(`/auth/google/callback?code=${code}&state=${state}`, { headers: { cookie: cookieFrom(start, 'subscriberr_oauth')! } });
    expect(res.headers.get('location')).toBe('/?auth_error=exchange_failed');
    expect(accounts(world)).toEqual([]);
  });

  it('handles cancel on the consent screen and unverified emails', async () => {
    const { world, app, google } = setup();
    const start = await app.request('/auth/google/start');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const denied = await app.request(`/auth/google/callback?error=access_denied&state=${state}`, { headers: { cookie: cookieFrom(start, 'subscriberr_oauth')! } });
    expect(denied.headers.get('location')).toBe('/?auth_error=access_denied');
    const unverified = await googleSignIn(app, google, { email: 'a@example.com', emailVerified: false });
    expect(unverified.location).toBe('/?auth_error=email_unverified');
    expect(accounts(world)).toEqual([]);
  });

  it('when Gmail access is not granted the account signs in but Gmail stays disconnected', async () => {
    const { world, app, google } = setup();
    const flow = await googleSignIn(app, google, { email: 'owner@example.com', grantGmail: false });
    expect(flow.location).toBe('/?auth_notice=gmail_not_connected');
    expect(flow.sessionCookie).toBeTruthy();
    expect(accounts(world)[0]).toMatchObject({ gmail_status: 'disconnected', refresh_token_enc: null });
    // Signing in again with Gmail granted connects it.
    await googleSignIn(app, google, { email: 'owner@example.com' });
    expect(accounts(world)[0]).toMatchObject({ gmail_status: 'connected' });
  });

  it('returns to the Vite dev server in development, never to a foreign site', async () => {
    const { app, google } = setup();
    expect((await googleSignIn(app, google, { email: 'o@example.com', returnTo: 'http://localhost:5173/' })).location).toBe('http://localhost:5173/');
    expect((await googleSignIn(app, google, { email: 'o@example.com', returnTo: 'https://evil.example/' })).location).toBe('/');
  });

  it('issues a new session id on every sign-in', async () => {
    const { world, app, google } = setup();
    const first = await googleSignIn(app, google, { email: 'o@example.com' });
    const second = await googleSignIn(app, google, { email: 'o@example.com', cookie: first.sessionCookie! });
    expect(second.sessionCookie).not.toBe(first.sessionCookie);
    expect((await app.request('/api/me', { headers: { cookie: first.sessionCookie! } })).status).toBe(401);
    expect(world.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  });
});

describe('who may sign in (Spec §3, §5.5)', () => {
  it('after the owner, only allowlisted accounts get in, each as an operator with its own workspace', async () => {
    const { world, app, google } = setup();
    await googleSignIn(app, google, { email: 'owner@example.com' });
    const stranger = await googleSignIn(app, google, { email: 'stranger@example.com' });
    expect(stranger.location).toBe('/?auth_error=not_authorized');
    expect(stranger.sessionCookie).toBeNull();

    allowEmail(world.db, 'friend@example.com');
    const friend = await googleSignIn(app, google, { email: 'friend@example.com' });
    expect(friend.location).toBe('/');
    expect(accounts(world).map((a) => [a.email, a.role])).toEqual([
      ['owner@example.com', 'owner'],
      ['friend@example.com', 'operator'],
    ]);
  });

  it('ADMIN_EMAILS restricts who can claim a fresh install, and allows those people later', async () => {
    const { world, app, google } = setup({ ADMIN_EMAILS: 'boss@example.com, deputy@example.com' });
    const squatter = await googleSignIn(app, google, { email: 'squatter@example.com' });
    expect(squatter.location).toBe('/?auth_error=not_authorized');
    expect(accounts(world)).toEqual([]);
    await googleSignIn(app, google, { email: 'boss@example.com' });
    await googleSignIn(app, google, { email: 'deputy@example.com' });
    expect(accounts(world).map((a) => [a.email, a.role])).toEqual([
      ['boss@example.com', 'owner'],
      ['deputy@example.com', 'operator'],
    ]);
  });

  it('never re-binds an existing email to a different Google account', async () => {
    const { world, app, google } = setup();
    world.db.prepare(`INSERT INTO accounts (google_sub, email, role, created_at) VALUES ('google-sub-1', 'owner@example.com', 'owner', '2026-01-01T00:00:00Z')`).run();
    const res = await googleSignIn(app, google, { email: 'owner@example.com' }); // fake sub "fake:owner@example.com"
    expect(res.location).toBe('/?auth_error=account_mismatch');
  });

  it('there can only ever be one owner (database guard)', () => {
    const world = createWorld();
    insertAccount(world.db, 'a@example.com', 'owner');
    expect(() => insertAccount(world.db, 'b@example.com', 'owner')).toThrow(/UNIQUE/);
  });
});

describe('cookies and headers behind Nginx Proxy Manager (Spec §5.4)', () => {
  it('uses Secure cookies and HSTS for an https BASE_URL; the redirect URI comes from BASE_URL', async () => {
    const world = createWorld();
    const config = testConfig(world.dataDir, world.backupDir, {
      BASE_URL: 'https://subscriberr.mediaservers.org',
      TRUST_PROXY: 'true',
      DEV_FAKE_LOGIN: 'false',
      SEED_DEMO: 'false',
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      NODE_ENV: 'production',
    });
    expect(config.googleRedirectUri).toBe('https://subscriberr.mediaservers.org/auth/google/callback');
    const google = new FakeGoogleAuthProvider(config.baseUrl, world.clock);
    const { app } = testApp(world, { config, google });
    const proxied = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'subscriberr.mediaservers.org', 'x-forwarded-for': '203.0.113.9' };
    const flow = await googleSignIn(app, google, { email: 'owner@example.com', headers: proxied });
    expect(setCookieHeader(flow.start, 'subscriberr_oauth')).toMatch(/Secure/);
    expect(setCookieHeader(flow.callback, 'subscriberr_session')).toMatch(/Secure/);
    expect(flow.start.headers.get('strict-transport-security')).toContain('max-age=');
    expect(world.db.prepare('SELECT ip FROM sessions').get()).toEqual({ ip: '203.0.113.9' });
    // Demo endpoints do not exist in production.
    expect((await app.request('/auth/dev-login', { method: 'POST', headers: { ...CSRF, origin: 'https://subscriberr.mediaservers.org' }, body: '{}' })).status).toBe(404);
  });

  it('rate-limits sign-in per client IP', async () => {
    const { app } = setup({ TRUST_PROXY: 'true' });
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    for (let i = 0; i < AUTH_RATE_LIMIT.max; i++) expect((await app.request('/auth/google/start', { headers: from('198.51.100.1') })).status).toBe(302);
    const limited = await app.request('/auth/google/start', { headers: from('198.51.100.1') });
    expect(limited.headers.get('location')).toBe('/?auth_error=rate_limited');
    const json = await app.request('/auth/dev-login', { method: 'POST', headers: { ...CSRF, ...from('198.51.100.1') }, body: '{}' });
    expect(json.status).toBe(429);
    expect(await json.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // Another client is unaffected.
    expect((await app.request('/auth/google/start', { headers: from('198.51.100.2') })).headers.get('location')).toContain('/dev/google/authorize');
  });

  it('without TRUST_PROXY a spoofed X-Forwarded-For does not escape the limit', async () => {
    const { app } = setup();
    for (let i = 0; i < AUTH_RATE_LIMIT.max; i++) await app.request('/auth/google/start', { headers: { 'x-forwarded-for': `10.0.0.${i}` } });
    expect((await app.request('/auth/google/start', { headers: { 'x-forwarded-for': '10.9.9.9' } })).headers.get('location')).toBe('/?auth_error=rate_limited');
  });
});

describe('Gmail credentials (Spec §5.3)', () => {
  it('disconnect revokes at Google and clears the stored token; signing in again reconnects', async () => {
    const { world, app, google } = setup();
    const flow = await googleSignIn(app, google, { email: 'owner@example.com' });
    const issued = google.issuedRefreshTokens.at(-1)!;
    const res = await app.request('/api/workspace/google/disconnect', { method: 'POST', headers: { ...CSRF, cookie: flow.sessionCookie! } });
    expect(await res.json()).toEqual({ revoked: true });
    expect(google.revoked).toEqual([issued]);
    expect(accounts(world)[0]).toMatchObject({ gmail_status: 'disconnected', refresh_token_enc: null, scopes: null });
    expect(await (await app.request('/api/me', { headers: { cookie: flow.sessionCookie! } })).json()).toMatchObject({ gmailStatus: 'disconnected' });
    await googleSignIn(app, google, { email: 'owner@example.com' });
    expect(accounts(world)[0]).toMatchObject({ gmail_status: 'connected' });
  });

  it('the hourly check disconnects a revoked token without affecting other workspaces', async () => {
    const { world, app, google, secretBox } = setup();
    await googleSignIn(app, google, { email: 'owner@example.com' });
    allowEmail(world.db, 'a@example.com');
    allowEmail(world.db, 'b@example.com');
    await googleSignIn(app, google, { email: 'a@example.com' });
    const tokenA = google.issuedRefreshTokens.at(-1)!;
    await googleSignIn(app, google, { email: 'b@example.com' });
    // Workspace b's token was encrypted with another APP_SECRET (e.g. after a lost secret).
    world.db.prepare(`UPDATE accounts SET refresh_token_enc = 'v1:k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' WHERE email = 'b@example.com'`).run();
    google.invalidate(tokenA);

    const stats = await checkGmailTokens({ ctx: world.ctx, clock: world.clock, secretBox, google, log: silentLogger });
    expect(stats).toEqual({ checked: 3, ok: 1, disconnected: 1, errors: 1 });
    expect(accounts(world).map((a) => [a.email, a.gmail_status, a.refresh_token_enc === null])).toEqual([
      ['owner@example.com', 'connected', false],
      ['a@example.com', 'disconnected', true],
      ['b@example.com', 'error', false],
    ]);
    const audit = world.db.prepare(`SELECT account_id, action, details FROM audit_log WHERE action = 'gmail.disconnected'`).all();
    expect(audit).toEqual([{ account_id: 2, action: 'gmail.disconnected', details: '{"reason":"invalid_grant"}' }]);
  });
});

describe('the fake Google consent page (demo mode only)', () => {
  it('renders a consent form and returns to the app callback with a code, or access_denied', async () => {
    const { app } = setup();
    const page = await app.request('/dev/google/authorize?state=abc&code_challenge=xyz&login_hint=%22%3E%3Cscript%3E');
    const html = await page.text();
    expect(html).toContain('DEMO — fake Google');
    expect(html).not.toContain('"><script>'); // login_hint is escaped
    const form = (fields: Record<string, string>, origin = 'http://localhost:3000') =>
      app.request('/dev/google/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: new URLSearchParams(fields).toString() });

    const allow = await form({ state: 'abc', code_challenge: 'xyz', email: 'demo@example.com', gmail: '1', decision: 'allow', redirect_uri: 'https://evil.example/cb' });
    const to = new URL(allow.headers.get('location')!);
    expect(`${to.origin}${to.pathname}`).toBe('http://localhost:3000/auth/google/callback'); // redirect_uri from the request is ignored
    expect(to.searchParams.get('state')).toBe('abc');
    expect(to.searchParams.get('code')).toMatch(/^fake-code-/);

    const deny = await form({ state: 'abc', code_challenge: 'xyz', email: 'demo@example.com', decision: 'deny' });
    expect(new URL(deny.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect((await form({ state: 'abc', code_challenge: 'xyz', email: 'x@example.com', decision: 'allow' }, 'https://evil.example')).status).toBe(403);
  });

  it('does not exist when the real provider (or none) is configured', async () => {
    const world = createWorld();
    const { app } = testApp(world, { google: null });
    expect((await app.request('/dev/google/authorize?state=a&code_challenge=b')).status).toBe(404);
    expect((await app.request('/auth/google/start')).headers.get('location')).toBe('/?auth_error=google_unavailable');
    expect(await (await app.request('/api/public-config')).json()).toMatchObject({ googleSignIn: false });
  });
});
