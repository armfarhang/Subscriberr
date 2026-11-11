import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { writeAudit } from '../../src/core/audit.js';
import { silentLogger } from '../../src/core/logger.js';
import { forWorkspace } from '../../src/core/workspace-context.js';
import { checkIntegrity } from '../../src/db/client.js';
import { DEMO_MEMBERS, DEMO_OWNER_EMAIL, seedDemo } from '../../src/db/seed-demo.js';
import { INTERAC_SENDER } from '../../src/modules/gmail/client.js';
import { createGmailClientFactory } from '../../src/modules/gmail/factory.js';
import { Scheduler } from '../../src/modules/jobs/scheduler.js';
import { createMediaProviderFactory } from '../../src/modules/media/factory.js';
import { JOB_BACKUP, JOB_BACKUP_DESTINATION, registerSystemJobs } from '../../src/modules/system/jobs.js';
import { createWorld, memoryDb } from '../helpers/env.js';

describe('demo seed (SEED_DEMO)', () => {
  it('creates one demo workspace, once, that satisfies every constraint', () => {
    const db = memoryDb();
    const now = new Date('2026-11-11T15:00:00Z');
    const first = seedDemo(db, now, 'America/Toronto');
    expect(first.seeded).toBe(true);
    expect(seedDemo(db, now, 'America/Toronto')).toEqual({ seeded: false, accountId: null });

    expect(db.prepare('SELECT email, role, gmail_status FROM accounts').all()).toEqual([{ email: DEMO_OWNER_EMAIL, role: 'owner', gmail_status: 'connected' }]);
    expect(db.prepare('SELECT count(*) AS n FROM members').get()).toEqual({ n: DEMO_MEMBERS.length });
    expect(db.prepare('SELECT type, base_url, enforcement_enabled FROM media_servers ORDER BY id').all()).toEqual([
      { type: 'plex', base_url: 'fake://plex', enforcement_enabled: 0 },
      { type: 'jellyfin', base_url: 'fake://jellyfin', enforcement_enabled: 0 },
    ]);
    expect(checkIntegrity(db).ok).toBe(true);
  });

  it('never writes the billing caches directly (they belong to the ledger, §6.5a)', () => {
    const db = memoryDb();
    seedDemo(db, new Date('2026-11-11T15:00:00Z'), 'America/Toronto');
    expect(db.prepare('SELECT count(*) AS n FROM members WHERE paid_through IS NOT NULL OR credit_cents <> 0 OR last_payment_at IS NOT NULL').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM ledger_entries').get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT DISTINCT status FROM members`).all()).toEqual([{ status: 'expired' }]); // no access implied
  });

  it('demo members line up with the e-Transfer fixtures and the fake servers', async () => {
    const db = memoryDb();
    const { accountId } = seedDemo(db, new Date('2026-11-11T15:00:00Z'), 'America/Toronto');

    // Every Interac fixture's Reply-To belongs to a seeded member.
    const gmail = await createGmailClientFactory({ seedDemo: true })(accountId!);
    const emails = new Set((db.prepare('SELECT email FROM members WHERE email IS NOT NULL').all() as Array<{ email: string }>).map((m) => m.email));
    for (const ref of await gmail.listMessages({ from: [INTERAC_SENDER] })) {
      const raw = (await gmail.getMessage(ref.id)).raw.toString('latin1');
      const replyTo = /^Reply-To:.*<([^>]+)>/m.exec(raw)?.[1];
      expect(emails.has(replyTo ?? ''), ref.id).toBe(true);
    }

    // Every server link points at a real, non-admin user of the matching fake server.
    const providers = createMediaProviderFactory({ seedDemo: true });
    const links = db
      .prepare(`SELECT s.id, s.type, s.base_url AS baseUrl, l.external_user_id AS userId FROM member_server_accounts l JOIN media_servers s ON s.id = l.server_id`)
      .all() as Array<{ id: number; type: 'plex' | 'jellyfin'; baseUrl: string; userId: string }>;
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const users = await providers(link).listUsers();
      const user = users.find((u) => u.id === link.userId);
      expect(user, `${link.type}:${link.userId}`).toBeDefined();
      expect(user!.isAdmin).toBe(false);
    }
  });

  it('audit entries are written through a workspace context', () => {
    const world = createWorld();
    const { accountId } = seedDemo(world.db, world.clock.now(), 'America/Toronto');
    writeAudit(forWorkspace(world.ctx, accountId!), world.clock, { actor: 'admin:demo@example.com', action: 'member.updated', entity: 'member', entityId: 1, details: { field: 'notes' } });
    expect(world.db.prepare(`SELECT actor, action, entity_id, details, at FROM audit_log WHERE action = 'member.updated'`).get()).toEqual({
      actor: 'admin:demo@example.com',
      action: 'member.updated',
      entity_id: 1,
      details: '{"field":"notes"}',
      at: '2026-11-11T15:00:00Z',
    });
    expect(() => forWorkspace(world.ctx, 0)).toThrow();
  });
});

describe('scheduler (Spec §11)', () => {
  it('records every run, is single-flight, and survives a failing job', async () => {
    const world = createWorld();
    const scheduler = new Scheduler(world.ctx, world.clock, silentLogger);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    scheduler.register({
      name: 'slow',
      async run() {
        runs++;
        await gate;
        return { processed: 3 };
      },
    });
    scheduler.register({
      name: 'broken',
      async run() {
        throw new Error('kaboom');
      },
    });
    expect(() => scheduler.register({ name: 'slow', run: async () => {} })).toThrow(/already registered/);

    const first = scheduler.runNow('slow');
    const second = await scheduler.runNow('slow'); // while the first is still running
    expect(second.status).toBe('skipped');
    release();
    expect(await first).toMatchObject({ status: 'ok', stats: { processed: 3 } });
    expect(runs).toBe(1);

    expect(await scheduler.runNow('broken')).toMatchObject({ status: 'error', error: 'kaboom' });
    expect(world.db.prepare('SELECT job, status, error, stats FROM job_runs ORDER BY id').all()).toEqual([
      { job: 'slow', status: 'ok', error: null, stats: '{"processed":3}' },
      { job: 'broken', status: 'error', error: 'kaboom', stats: null },
    ]);
  });

  it('marks runs interrupted by a restart as failed', () => {
    const world = createWorld();
    world.db.prepare(`INSERT INTO job_runs (job, started_at, status) VALUES ('backup', '2026-11-10T08:00:00Z', 'running')`).run();
    const scheduler = new Scheduler(world.ctx, world.clock, silentLogger);
    scheduler.start();
    scheduler.stop();
    expect(world.db.prepare('SELECT status, error FROM job_runs').get()).toEqual({ status: 'error', error: 'interrupted by restart' });
  });

  it('the nightly backup and destination-health jobs run through the scheduler', async () => {
    const world = createWorld();
    const scheduler = new Scheduler(world.ctx, world.clock, silentLogger);
    registerSystemJobs(scheduler, world.backupEnv);
    expect(scheduler.names()).toEqual([JOB_BACKUP, JOB_BACKUP_DESTINATION]);

    const backup = await scheduler.runNow(JOB_BACKUP);
    expect(backup.status).toBe('ok');
    expect(readdirSync(world.backupDir)).toEqual(['subscriberr-20261111-100000-nightly.zip']);
    expect(world.db.prepare('SELECT kind, tier, verified FROM backup_runs').all()).toEqual([{ kind: 'nightly', tier: 'monthly', verified: 1 }]);

    const health = await scheduler.runNow(JOB_BACKUP_DESTINATION);
    expect(health).toMatchObject({ status: 'ok', stats: { ok: false } }); // same disk in the test sandbox → flagged
  });
});
