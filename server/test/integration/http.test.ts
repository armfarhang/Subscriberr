import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { silentLogger } from '../../src/core/logger.js';
import { seedDemo } from '../../src/db/seed-demo.js';
import { SESSION_TTL_MS } from '../../src/modules/auth/sessions.js';
import { createWorld, insertAccount, testConfig } from '../helpers/env.js';

const CSRF = { 'x-requested-with': 'subscriberr', 'content-type': 'application/json' };

function setup(env: NodeJS.ProcessEnv = {}, options: { webDir?: string } = {}) {
  const world = createWorld({ env });
  const app = createApp({ config: world.config, ctx: world.ctx, clock: world.clock, log: silentLogger, backupEnv: world.backupEnv, webDir: options.webDir });
  return { world, app };
}

async function login(app: ReturnType<typeof createApp>, email?: string) {
  const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: JSON.stringify(email ? { email } : {}) });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { res, cookie };
}

describe('HTTP: health and public config', () => {
  it('GET /healthz needs no session and reports version + schema', async () => {
    const { app } = setup();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', version: '0.1.0', schemaVersion: 1, time: '2026-11-11T15:00:00Z' });
  });

  it('sends security headers', async () => {
    const { app } = setup();
    const res = await app.request('/healthz');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('GET /api/public-config tells the sign-in page whether demo sign-in exists', async () => {
    expect(await (await setup().app.request('/api/public-config')).json()).toEqual({ appName: 'Subscriberr', version: '0.1.0', devFakeLogin: true, demoMode: true });
    const real = setup({ DEV_FAKE_LOGIN: 'false', SEED_DEMO: 'false', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
    expect(await (await real.app.request('/api/public-config')).json()).toMatchObject({ devFakeLogin: false, demoMode: false });
  });

  it('unknown API routes and unauthenticated calls use the error envelope', async () => {
    const { app } = setup();
    const unauth = await app.request('/api/me');
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ error: { code: 'unauthorized', message: 'Sign in required' } });
    expect((await app.request('/api/system/status')).status).toBe(401);
    expect((await app.request('/api/nope')).status).toBe(401); // nothing under /api leaks without a session
    const { cookie } = await login(app);
    const missing = await app.request('/api/nope', { headers: { cookie } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });
});

describe('HTTP: fake sign-in (demo mode) and sessions', () => {
  it('signs in as the demo owner, stores only a hash of the session id, and signs out', async () => {
    const { app, world } = setup();
    seedDemo(world.db, world.clock.now(), 'America/Toronto');

    const { res, cookie } = await login(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: 'demo@example.com', role: 'owner', gmailStatus: 'connected' });
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/Secure/i); // http://localhost

    const token = cookie.split('=')[1]!;
    const stored = world.db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]!.id).not.toBe(token);

    const me = await app.request('/api/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'demo@example.com', timezone: 'America/Toronto' });

    const out = await app.request('/auth/logout', { method: 'POST', headers: { ...CSRF, cookie } });
    expect(out.status).toBe(200);
    expect(world.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect((await app.request('/api/me', { headers: { cookie } })).status).toBe(401);
  });

  it('the first account becomes the owner; unknown accounts are refused afterwards', async () => {
    const { app, world } = setup();
    const first = await login(app, 'First@Example.com');
    expect(await first.res.json()).toMatchObject({ email: 'first@example.com', role: 'owner' });
    const stranger = await login(app, 'stranger@example.com');
    expect(stranger.res.status).toBe(403);
    expect(world.db.prepare('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 1 });
    // An existing (allowlisted) operator can sign in.
    insertAccount(world.db, 'op@example.com', 'operator');
    expect(await (await login(app, 'op@example.com')).res.json()).toMatchObject({ role: 'operator' });
  });

  it('does not exist unless DEV_FAKE_LOGIN is on', async () => {
    const { app, world } = setup({ DEV_FAKE_LOGIN: 'false', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
    const { res } = await login(app);
    expect(res.status).toBe(404);
    expect(world.db.prepare('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 0 });
  });

  it('sessions slide and expire after 14 days of inactivity', async () => {
    const { app, world } = setup();
    const { cookie } = await login(app);
    world.clock.advanceMs(SESSION_TTL_MS - 3600_000);
    expect((await app.request('/api/me', { headers: { cookie } })).status).toBe(200); // slides the expiry
    world.clock.advanceMs(SESSION_TTL_MS - 3600_000);
    expect((await app.request('/api/me', { headers: { cookie } })).status).toBe(200);
    world.clock.advanceMs(SESSION_TTL_MS + 1000);
    expect((await app.request('/api/me', { headers: { cookie } })).status).toBe(401);
    expect(world.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('rejects state-changing requests without the CSRF header or from another origin', async () => {
    const { app } = setup();
    const noHeader = await app.request('/auth/dev-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(noHeader.status).toBe(403);
    const crossOrigin = await app.request('/auth/dev-login', { method: 'POST', headers: { ...CSRF, origin: 'https://evil.example' }, body: '{}' });
    expect(crossOrigin.status).toBe(403);
    const viteDev = await app.request('/auth/dev-login', { method: 'POST', headers: { ...CSRF, origin: 'http://localhost:5173' }, body: '{}' });
    expect(viteDev.status).toBe(200);
  });

  it('validates request bodies with the shared Zod schema', async () => {
    const { app } = setup();
    const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: JSON.stringify({ email: 'not-an-email' }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'bad_request', details: [{ path: 'email' }] } });
  });
});

describe('HTTP: system', () => {
  it('reports status and lets the owner back up now; operators cannot see backups', async () => {
    const { app, world } = setup();
    const owner = await login(app);
    const status = await app.request('/api/system/status', { headers: { cookie: owner.cookie } });
    expect(await status.json()).toMatchObject({ version: 'test', demoMode: true, backupStale: true, lastBackupOkAt: null, backupDestination: { exists: true, sameFilesystemAsData: true } });

    const created = await app.request('/api/system/backups', { method: 'POST', headers: { ...CSRF, cookie: owner.cookie } });
    expect(created.status).toBe(201);
    const { run } = (await created.json()) as { run: { file: string; verified: boolean; kind: string } };
    expect(run).toMatchObject({ kind: 'manual', verified: true });
    expect(readdirSync(world.backupDir)).toEqual([run.file]);

    const list = await app.request('/api/system/backups', { headers: { cookie: owner.cookie } });
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);

    insertAccount(world.db, 'op@example.com', 'operator');
    const op = await login(app, 'op@example.com');
    expect((await app.request('/api/system/backups', { headers: { cookie: op.cookie } })).status).toBe(403);
    expect((await app.request('/api/system/backups', { method: 'POST', headers: { ...CSRF, cookie: op.cookie } })).status).toBe(403);
  });

  it('has no restore endpoint (CLI only)', async () => {
    const { app } = setup();
    const { cookie } = await login(app);
    for (const p of ['/api/system/restore', '/api/system/backups/restore', '/api/system/backups/1/restore']) {
      expect((await app.request(p, { method: 'POST', headers: { ...CSRF, cookie } })).status).toBe(404);
    }
  });
});

describe('HTTP: static web app', () => {
  it('serves the built app with an SPA fallback, but never for /api', async () => {
    const world = createWorld();
    const webDir = path.join(world.root, 'web');
    mkdirSync(path.join(webDir, 'assets'), { recursive: true });
    writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Subscriberr</title>');
    writeFileSync(path.join(webDir, 'assets', 'app.js'), 'console.log(1)');
    const app = createApp({ config: testConfig(world.dataDir, world.backupDir), ctx: world.ctx, clock: world.clock, log: silentLogger, backupEnv: world.backupEnv, webDir });

    expect(await (await app.request('/')).text()).toContain('<title>Subscriberr</title>');
    expect(await (await app.request('/members/42')).text()).toContain('<title>Subscriberr</title>');
    const asset = await app.request('/assets/app.js');
    expect(await asset.text()).toBe('console.log(1)');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await app.request('/api/unknown')).headers.get('content-type')).toContain('application/json');
    expect((await app.request('/../../etc/passwd')).status).not.toBe(500);
  });
});
