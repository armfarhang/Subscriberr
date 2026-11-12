import { describe, expect, it } from 'vitest';
import type { ServerUsersView, ServerView, SyncResult } from '@subscriberr/shared';
import { silentLogger } from '../../src/core/logger.js';
import { forWorkspace } from '../../src/core/workspace-context.js';
import { seedDemo } from '../../src/db/seed-demo.js';
import type { FakeMediaServer } from '../../src/modules/media/fake.js';
import { processPendingSyncs, reconcileWorkspace } from '../../src/modules/media/sync.js';
import { allowEmail, createWorld, testApp } from '../helpers/env.js';
import { CSRF, cookieFrom } from '../helpers/http.js';

async function setup() {
  const world = createWorld({ start: '2026-11-12T15:00:00Z' });
  seedDemo(world.db, world.clock.now(), 'America/Toronto');
  const { app, media } = testApp(world);
  const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: '{}' });
  const cookie = cookieFrom(res, 'subscriberr_session')!;
  const json = async <T>(p: string, init: { method?: string; body?: unknown } = {}, status = 200, headers = { ...CSRF, cookie }): Promise<T> => {
    const r = await app.request(p, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const text = await r.text();
    expect(r.status, `${init.method ?? 'GET'} ${p}: ${text.slice(0, 400)}`).toBe(status);
    return JSON.parse(text) as T;
  };
  const plex = media({ id: 1, type: 'plex', baseUrl: 'fake://plex' }) as FakeMediaServer;
  const jellyfin = media({ id: 2, type: 'jellyfin', baseUrl: 'fake://jellyfin' }) as FakeMediaServer;
  const syncDeps = { clock: world.clock, media, log: silentLogger };
  const pending = () => processPendingSyncs(world.ctx, syncDeps);
  const link = (memberId: number) => world.db.prepare('SELECT access_state, last_error, last_granted_library_ids, attempts FROM member_server_accounts WHERE member_id = ? AND server_id = 1').get(memberId) as Record<string, unknown>;
  return { world, app, json, plex, jellyfin, pending, link, syncDeps, ws: forWorkspace(world.ctx, 1) };
}

describe('servers, users and links (Spec §10.1)', () => {
  it('lists the demo servers, tests them, shows users with admin and pending flags, and libraries', async () => {
    const { json } = await setup();
    const servers = (await json<{ items: ServerView[] }>('/api/media/servers')).items;
    expect(servers.map((s) => [s.name, s.type, s.enforcementEnabled, s.linked])).toEqual([
      ['Demo Jellyfin', 'jellyfin', false, 3],
      ['Demo Plex', 'plex', false, 3],
    ]);
    expect(await json('/api/media/servers/1/test', { method: 'POST' })).toEqual({ ok: true, detail: 'Fake plex server' });
    const users = await json<ServerUsersView>('/api/media/servers/1/users');
    expect(users.users.find((u) => u.isAdmin)).toMatchObject({ username: 'demo-owner', linkedMember: null });
    expect(users.users.find((u) => u.id === 'plex-101')).toMatchObject({ linkedMember: { id: 1, displayName: 'Payer One' } });
    expect(users.pendingInvites).toEqual([{ id: 'plex-invite-9', email: 'not-accepted-yet@example.com' }]);
    expect((await json<{ items: unknown[] }>('/api/media/servers/1/libraries')).items).toHaveLength(3);
  });

  it('links only accepted, non-admin, unlinked accounts; credentials are never returned', async () => {
    const { json, world } = await setup();
    await json('/api/media/members/5/links', { method: 'POST', body: { serverId: 1, externalUserId: 'plex-1' } }, 400); // admin
    await json('/api/media/members/5/links', { method: 'POST', body: { serverId: 1, externalUserId: 'plex-invite-9' } }, 400); // pending
    await json('/api/media/members/5/links', { method: 'POST', body: { serverId: 1, externalUserId: 'plex-102' } }, 409); // Pat's
    await json('/api/media/members/3/links', { method: 'POST', body: { serverId: 1, externalUserId: 'plex-102' } }, 409);
    await json('/api/media/members/2/links/1', { method: 'DELETE' });
    await json('/api/media/members/5/links', { method: 'POST', body: { serverId: 1, externalUserId: 'plex-102', libraryIds: ['1'] } }, 201);
    expect(world.db.prepare('SELECT member_id, library_ids_override FROM member_server_accounts WHERE server_id = 1 AND external_user_id = ?').get('plex-102')).toEqual({ member_id: 5, library_ids_override: '["1"]' });

    const created = await json<ServerView>('/api/media/servers', { method: 'POST', body: { type: 'jellyfin', name: 'Real JF', baseUrl: 'https://jf.example.com/', token: 'secret-api-key-123' } }, 201);
    expect(created).toMatchObject({ baseUrl: 'https://jf.example.com', hasCredentials: true });
    expect(JSON.stringify(created)).not.toContain('secret-api-key-123');
    expect(String((world.db.prepare('SELECT credentials_enc FROM media_servers WHERE id = ?').get(created.id) as { credentials_enc: string }).credentials_enc)).toMatch(/^v1:/);
    await json('/api/media/servers', { method: 'POST', body: { type: 'plex', name: 'Real JF', baseUrl: 'https://x.example.com', token: 'another-token' } }, 409);
  });
});

describe('enforcement (Spec §10.2)', () => {
  it('the first sync is a dry run; nothing changes until the admin applies it', async () => {
    const { json, plex, pending, ws } = await setup();
    const plan = await json<SyncResult>('/api/media/servers/1/plan');
    expect(plan).toMatchObject({ dryRun: true, changed: 0 });
    // Everyone in the demo is expired (no payments yet): the plan revokes all three; the admin account is not even linked.
    expect(plan.items.map((i) => [i.displayName, i.action])).toEqual([
      ['Jordan Example', 'revoke'],
      ['Pat (cousin)', 'revoke'],
      ['Payer One', 'revoke'],
    ]);
    await json('/api/media/servers/1/sync', { method: 'POST' }, 409); // enforcement off
    expect((await json<ServerView>('/api/media/servers/1/enforcement', { method: 'POST', body: { enabled: true } })).enforcementConfirmed).toBe(false);
    // Automatic processing does nothing before the admin confirmed the first sync.
    ws.sqlite.prepare('UPDATE member_server_accounts SET sync_pending = 1').run();
    expect(await pending()).toMatchObject({ servers: 0 });
    expect(plex.calls).toEqual([]);

    const applied = await json<SyncResult>('/api/media/servers/1/sync', { method: 'POST' });
    expect(applied).toMatchObject({ dryRun: false, changed: 3, failed: 0 });
    expect(plex.calls.map((c) => [c.op, c.userId])).toEqual([
      ['revoke', 'plex-104'],
      ['revoke', 'plex-102'],
      ['revoke', 'plex-101'],
    ]);
    expect((await json<ServerView>('/api/media/servers/1')).enforcementConfirmed).toBe(true);
    // Idempotent: nothing differs any more, nothing is called.
    expect(await json<SyncResult>('/api/media/servers/1/sync', { method: 'POST' })).toMatchObject({ changed: 0 });
    expect(plex.calls).toHaveLength(3);
    const member = await json<{ timeline: Array<{ action: string }> }>('/api/members/1');
    expect(member.timeline.map((e) => e.action)).toContain('member.access_revoked');
  });

  it('a payment grants the resolved libraries; expiry revokes; paused is left alone; a re-grant uses the same set', async () => {
    const { json, plex, pending, link, world } = await setup();
    await json('/api/media/servers/1/enforcement', { method: 'POST', body: { enabled: true } });
    await json('/api/media/servers/1/sync', { method: 'POST' });
    plex.calls.length = 0;

    await json('/api/billing/payments', { method: 'POST', body: { memberId: 1, amountCents: 1000, date: '2026-11-12' } }, 201);
    expect(link(1)).toMatchObject({ access_state: 'revoked' }); // pending until processed
    await pending();
    expect(plex.calls).toEqual([{ op: 'grant', userId: 'plex-101', libraryIds: ['1', '2'] }]);
    expect(link(1)).toMatchObject({ access_state: 'granted', last_granted_library_ids: '["1","2"]' });

    // Member override wins over the server default.
    await json('/api/media/members/1/links/1', { method: 'PUT', body: { libraryIds: ['1', '3'] } });
    await pending();
    expect(plex.calls.at(-1)).toEqual({ op: 'grant', userId: 'plex-101', libraryIds: ['1', '3'] });

    // Paused: untouched by syncs.
    await json('/api/members/1/status', { method: 'POST', body: { action: 'pause' } });
    await pending();
    expect(plex.calls).toHaveLength(2);

    // Archived → revoke.
    await json('/api/members/1/status', { method: 'POST', body: { action: 'reactivate' } });
    await json('/api/members/1/status', { method: 'POST', body: { action: 'archive' } });
    await pending();
    expect(plex.calls.at(-1)).toMatchObject({ op: 'revoke', userId: 'plex-101' });
    expect(link(1)).toMatchObject({ access_state: 'revoked', last_granted_library_ids: '["1","3"]' });
    void world;
  });

  it('the daily reconcile detects and fixes drift; unlinked members and admins are never touched', async () => {
    const { json, plex, ws, syncDeps } = await setup();
    await json('/api/media/servers/1/enforcement', { method: 'POST', body: { enabled: true } });
    await json('/api/media/servers/1/sync', { method: 'POST' });
    // Someone re-shared libraries by hand on the server.
    await plex.grantAccess({ id: 'plex-102', username: 'pat', isAdmin: false }, ['1']);
    plex.calls.length = 0;
    const drift = await json<SyncResult>('/api/media/servers/1/plan');
    expect(drift.items.find((i) => i.externalUserId === 'plex-102')).toMatchObject({ action: 'revoke', current: { state: 'granted', libraryIds: ['1'] } });
    expect(await reconcileWorkspace(ws, syncDeps)).toEqual({ 'Demo Plex': { changed: 1, failed: 0 } });
    expect(plex.calls.map((c) => c.userId)).toEqual(['plex-102']);
    // The admin's own library access is never part of any change.
    expect(plex.calls.some((c) => c.userId === 'plex-1')).toBe(false);
  });

  it('failures are recorded with backoff, a failed revoke is surfaced, and the retry fixes it', async () => {
    const { json, plex, pending, link, world } = await setup();
    await json('/api/media/servers/1/enforcement', { method: 'POST', body: { enabled: true } });
    await json('/api/media/servers/1/sync', { method: 'POST' });
    await json('/api/billing/payments', { method: 'POST', body: { memberId: 1, amountCents: 1000, date: '2026-11-12' } }, 201);
    await pending();
    // Payer One's payment is voided → expired → revoke, but the server is down.
    plex.offline = true;
    const p = (await json<{ items: Array<{ id: number }> }>('/api/payments?memberId=1')).items[0]!;
    await json(`/api/billing/payments/${p.id}/void`, { method: 'POST', body: { reason: 'bounced' } });
    await pending();
    expect(link(1)).toMatchObject({ access_state: 'error', attempts: 1 });
    expect((await json<ServerView>('/api/media/servers/1')).failing).toEqual([{ memberId: 1, displayName: 'Payer One', error: expect.stringMatching(/offline/), pendingRevoke: true }]);
    // Not retried before the backoff (10 min after the first failure).
    plex.offline = false;
    await pending();
    expect(link(1)).toMatchObject({ access_state: 'error' });
    world.clock.advanceMs(11 * 60_000);
    await pending();
    expect(link(1)).toMatchObject({ access_state: 'revoked', attempts: 0, last_error: null });
  });

  it('is workspace-scoped', async () => {
    const { json, app, world } = await setup();
    allowEmail(world.db, 'operator@example.com');
    const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: JSON.stringify({ email: 'operator@example.com' }) });
    const other = { ...CSRF, cookie: cookieFrom(res, 'subscriberr_session')! };
    expect((await json<{ items: unknown[] }>('/api/media/servers', {}, 200, other)).items).toEqual([]);
    for (const [method, p, body] of [
      ['GET', '/api/media/servers/1/users'],
      ['GET', '/api/media/servers/1/plan'],
      ['POST', '/api/media/servers/1/enforcement', { enabled: true }],
      ['POST', '/api/media/servers/1/sync'],
      ['DELETE', '/api/media/members/1/links/1'],
    ] as Array<[string, string, unknown?]>) {
      await json(p, { method, body }, 404, other);
    }
  });
});
