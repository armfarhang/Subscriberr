import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKUP_RETENTION } from '@subscriberr/shared';
import { forWorkspace } from '../../src/core/workspace-context.js';
import { seedDemo } from '../../src/db/seed-demo.js';
import { getBackupRetention } from '../../src/modules/system/backup.js';
import { getWorkspaceSettings, updateWorkspaceSettings } from '../../src/modules/workspaces/settings.js';
import { allowEmail, createWorld, testApp } from '../helpers/env.js';
import { type App, CSRF, cookieFrom } from '../helpers/http.js';

async function login(app: App, email: string): Promise<string> {
  const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: JSON.stringify({ email }) });
  expect(res.status, email).toBe(200);
  return cookieFrom(res, 'subscriberr_session')!;
}

/** An owner and an allowlisted operator, each signed in. */
async function twoWorkspaces(env: NodeJS.ProcessEnv = {}) {
  const world = createWorld({ env });
  const { app } = testApp(world);
  const owner = await login(app, 'owner@example.com');
  allowEmail(world.db, 'operator@example.com');
  const operator = await login(app, 'operator@example.com');
  const call = (cookie: string, path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { ...CSRF, cookie, ...(init.headers as Record<string, string> | undefined) } });
  return { world, app, owner, operator, call };
}

const validSettings = {
  timezone: 'America/Vancouver',
  etransferEmail: 'Pay.Me@Example.com',
  etransferInstructions: 'Use Autodeposit, please.',
  memberDefaults: { planAmountCents: 1500, planPeriodDays: 30, currency: 'CAD', toleranceCents: 50, graceDays: 3 },
};

describe('workspace settings and the first-run wizard (Spec §13.1)', () => {
  it('a new workspace starts with defaults and onboarding not completed', async () => {
    const { operator, call } = await twoWorkspaces();
    const res = await call(operator, '/api/workspace/settings');
    expect(await res.json()).toEqual({
      timezone: 'America/Toronto',
      etransferEmail: null,
      etransferInstructions: '',
      memberDefaults: { planAmountCents: null, planPeriodDays: 30, currency: 'CAD', toleranceCents: 0, graceDays: 3 },
      scanning: { intervalMinutes: 5, senders: ['notify@payments.interac.ca'], reviewNewEmailForKnownName: false, initialLookbackDays: 30 },
      onboardingCompleted: false,
    });
  });

  it('validates every field with the shared schema', async () => {
    const { owner, call } = await twoWorkspaces();
    const patch = (body: unknown) => call(owner, '/api/workspace/settings', { method: 'PATCH', body: JSON.stringify(body) });
    expect((await patch({ timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await patch({ etransferEmail: 'not-an-email' })).status).toBe(400);
    expect((await patch({ memberDefaults: { ...validSettings.memberDefaults, toleranceCents: -1 } })).status).toBe(400);
    expect((await patch({ memberDefaults: { ...validSettings.memberDefaults, currency: 'cad' } })).status).toBe(400);
    expect((await patch({ onboardingCompleted: true })).status).toBe(400); // only via the wizard's complete step
    expect((await patch({ somethingElse: 1 })).status).toBe(400);
  });

  it('onboarding can only be completed once the required answers exist', async () => {
    const { owner, call, world } = await twoWorkspaces();
    const early = await call(owner, '/api/workspace/onboarding/complete', { method: 'POST' });
    expect(early.status).toBe(400);
    expect(await early.json()).toMatchObject({ error: { details: { missing: ['etransferEmail', 'memberDefaults.planAmountCents'] } } });

    const saved = await call(owner, '/api/workspace/settings', { method: 'PATCH', body: JSON.stringify(validSettings) });
    expect(await saved.json()).toMatchObject({ ...validSettings, etransferEmail: 'pay.me@example.com', onboardingCompleted: false });
    expect((await call(owner, '/api/workspace/onboarding/complete', { method: 'POST' })).status).toBe(200);
    expect(await (await call(owner, '/api/me')).json()).toMatchObject({ onboardingCompleted: true, timezone: 'America/Vancouver' });

    const audit = world.db.prepare(`SELECT account_id, actor, action FROM audit_log WHERE action IN ('settings.updated', 'onboarding.completed') ORDER BY id`).all();
    expect(audit).toEqual([
      { account_id: 1, actor: 'admin:owner@example.com', action: 'settings.updated' },
      { account_id: 1, actor: 'admin:owner@example.com', action: 'onboarding.completed' },
    ]);
  });

  it('the demo workspace is already set up', () => {
    const world = createWorld();
    const { accountId } = seedDemo(world.db, world.clock.now(), 'America/Toronto');
    expect(getWorkspaceSettings(forWorkspace(world.ctx, accountId!))).toMatchObject({ onboardingCompleted: true, etransferEmail: 'demo@example.com', memberDefaults: { planAmountCents: 1500 } });
  });
});

describe('cross-workspace isolation (Spec §5.5)', () => {
  it('each workspace reads and writes only its own settings', async () => {
    const { world, owner, operator, call } = await twoWorkspaces();
    await call(owner, '/api/workspace/settings', { method: 'PATCH', body: JSON.stringify(validSettings) });
    await call(operator, '/api/workspace/settings', { method: 'PATCH', body: JSON.stringify({ etransferEmail: 'operator-pay@example.com', timezone: 'Europe/Paris' }) });

    expect(await (await call(owner, '/api/workspace/settings')).json()).toMatchObject({ etransferEmail: 'pay.me@example.com', timezone: 'America/Vancouver' });
    expect(await (await call(operator, '/api/workspace/settings')).json()).toMatchObject({ etransferEmail: 'operator-pay@example.com', timezone: 'Europe/Paris', memberDefaults: { planAmountCents: null } });

    const rows = world.db.prepare(`SELECT account_id, key, value FROM settings WHERE key = 'etransfer_email' ORDER BY account_id`).all();
    expect(rows).toEqual([
      { account_id: 1, key: 'etransfer_email', value: '"pay.me@example.com"' },
      { account_id: 2, key: 'etransfer_email', value: '"operator-pay@example.com"' },
    ]);
    // The audit trail of each change lives in the workspace that made it.
    expect(world.db.prepare(`SELECT account_id FROM audit_log WHERE action = 'settings.updated' ORDER BY id`).all()).toEqual([{ account_id: 1 }, { account_id: 2 }]);
  });

  it('the settings module cannot write outside the context it was given', () => {
    const world = createWorld();
    world.db.prepare(`INSERT INTO accounts (google_sub, email, role, created_at) VALUES ('s1', 'a@example.com', 'owner', '2026-01-01T00:00:00Z'), ('s2', 'b@example.com', 'operator', '2026-01-01T00:00:00Z')`).run();
    updateWorkspaceSettings(forWorkspace(world.ctx, 2), world.clock, 'admin:b@example.com', { etransferInstructions: 'B only' });
    expect(getWorkspaceSettings(forWorkspace(world.ctx, 1)).etransferInstructions).toBe('');
    expect(getWorkspaceSettings(forWorkspace(world.ctx, 2)).etransferInstructions).toBe('B only');
  });

  it('operators cannot reach owner-only endpoints', async () => {
    const { operator, call } = await twoWorkspaces();
    expect((await call(operator, '/api/allowlist')).status).toBe(403);
    expect((await call(operator, '/api/allowlist', { method: 'POST', body: JSON.stringify({ email: 'x@example.com' }) })).status).toBe(403);
    expect((await call(operator, '/api/system/backups')).status).toBe(403);
    expect((await call(operator, '/api/system/backup-retention', { method: 'PUT', body: JSON.stringify({ daily: 1, weekly: 0, monthly: 0 }) })).status).toBe(403);
  });
});

describe('allowlist management (Owner)', () => {
  it('adds, lists and removes; removing ends that operator’s sessions and blocks sign-in', async () => {
    const { world, app, owner, operator, call } = await twoWorkspaces({ ADMIN_EMAILS: 'owner@example.com, seed@example.com' });
    const added = await call(owner, '/api/allowlist', { method: 'POST', body: JSON.stringify({ email: '  New.Person@Example.com ' }) });
    expect(added.status).toBe(201);
    const list = ((await (await call(owner, '/api/allowlist')).json()) as { items: unknown[] }).items;
    expect(list).toEqual([
      { email: 'new.person@example.com', source: 'settings', addedBy: 'admin:owner@example.com', createdAt: '2026-11-11T15:00:00Z', role: null },
      { email: 'operator@example.com', source: 'settings', addedBy: 'test', createdAt: '2026-01-01T00:00:00Z', role: 'operator' },
      { email: 'owner@example.com', source: 'env', addedBy: 'ADMIN_EMAILS', createdAt: null, role: 'owner' },
      { email: 'seed@example.com', source: 'env', addedBy: 'ADMIN_EMAILS', createdAt: null, role: null },
    ]);

    expect((await call(owner, '/api/allowlist', { method: 'POST', body: JSON.stringify({ email: 'new.person@example.com' }) })).status).toBe(409);
    expect((await call(owner, '/api/allowlist', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com' }) })).status).toBe(409);
    expect((await call(owner, '/api/allowlist', { method: 'POST', body: JSON.stringify({ email: 'nope' }) })).status).toBe(400);
    expect((await call(owner, '/api/allowlist/seed%40example.com', { method: 'DELETE' })).status).toBe(409);
    expect((await call(owner, '/api/allowlist/ghost%40example.com', { method: 'DELETE' })).status).toBe(404);

    expect((await call(operator, '/api/me')).status).toBe(200);
    const removed = await call(owner, '/api/allowlist/operator%40example.com', { method: 'DELETE' });
    expect(await removed.json()).toMatchObject({ sessionsEnded: 1 });
    expect((await call(operator, '/api/me')).status).toBe(401);
    expect((await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: JSON.stringify({ email: 'operator@example.com' }) })).status).toBe(403);
    // Their workspace data is kept.
    expect(world.db.prepare(`SELECT count(*) AS n FROM accounts WHERE email = 'operator@example.com'`).get()).toEqual({ n: 1 });
  });

  it('a session that survives removal is still refused (defence in depth)', async () => {
    const { world, operator, call } = await twoWorkspaces();
    world.db.prepare(`DELETE FROM allowed_accounts WHERE email = 'operator@example.com'`).run(); // sessions left behind
    expect((await call(operator, '/api/me')).status).toBe(401);
    expect(world.db.prepare('SELECT count(*) AS n FROM sessions WHERE account_id = 2').get()).toEqual({ n: 0 });
  });
});

describe('backup retention setting (Owner)', () => {
  it('defaults to 2/4/6 and can be changed with validation', async () => {
    const { world, owner, call } = await twoWorkspaces();
    expect(await (await call(owner, '/api/system/backup-retention')).json()).toEqual(DEFAULT_BACKUP_RETENTION);
    expect((await call(owner, '/api/system/backup-retention', { method: 'PUT', body: JSON.stringify({ daily: 0, weekly: 4, monthly: 6 }) })).status).toBe(400);
    const res = await call(owner, '/api/system/backup-retention', { method: 'PUT', body: JSON.stringify({ daily: 3, weekly: 2, monthly: 12 }) });
    expect(await res.json()).toEqual({ daily: 3, weekly: 2, monthly: 12 });
    expect(getBackupRetention(world.ctx)).toEqual({ daily: 3, weekly: 2, monthly: 12 });
  });
});
