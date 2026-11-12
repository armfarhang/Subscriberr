import { toUtcIso } from '@subscriberr/shared';
import type { Sqlite } from './client.js';

// Demo data (SEED_DEMO=true). Everything here is fictional and matches the redacted fixtures in
// fixtures/etransfer/, so the whole pipeline can be exercised with no real accounts (Spec §17).

export const DEMO_OWNER_EMAIL = 'demo@example.com';
export const DEMO_PLEX_URL = 'fake://plex';
export const DEMO_JELLYFIN_URL = 'fake://jellyfin';

export interface DemoMember {
  displayName: string;
  etransferName: string | null;
  email: string | null;
  notes?: string;
  planAmountCents?: number;
  plexUserId?: string;
  jellyfinUserId?: string;
}

/** The first three are the payers in the e-Transfer fixtures. */
export const DEMO_MEMBERS: DemoMember[] = [
  { displayName: 'Payer One', etransferName: 'PAYER ONE', email: 'payer1@example.com', planAmountCents: 1000, plexUserId: 'plex-101', jellyfinUserId: 'jf-101' },
  { displayName: 'Pat (cousin)', etransferName: 'Pat', email: 'payer2@example.com', plexUserId: 'plex-102' },
  { displayName: 'Sam Payer', etransferName: 'Sam Payer', email: 'payer3@example.com', jellyfinUserId: 'jf-103' },
  { displayName: 'Jordan Example', etransferName: 'JORDAN EXAMPLE', email: 'jordan@example.com', plexUserId: 'plex-104', jellyfinUserId: 'jf-104' },
  { displayName: 'Riley (no email yet)', etransferName: 'Riley Sample', email: null, notes: 'Demo member without an email on file.' },
];

export const DEMO_MEMBER_DEFAULTS = {
  planAmountCents: 1500,
  planPeriodDays: 30,
  currency: 'CAD',
  toleranceCents: 0,
  graceDays: 3,
};

export interface SeedResult {
  seeded: boolean;
  accountId: number | null;
}

/**
 * Seeds the demo workspace once (only when the database has no accounts at all).
 * Members start with no paid-through date: balances are only ever written through the billing
 * ledger (§6.5a), which arrives in Milestone 6.
 */
export function seedDemo(db: Sqlite, now: Date, timeZone: string): SeedResult {
  const existing = (db.prepare('SELECT count(*) AS n FROM accounts').get() as { n: number }).n;
  if (existing > 0) return { seeded: false, accountId: null };

  const at = toUtcIso(now);
  const run = db.transaction((): number => {
    const accountId = Number(
      db
        .prepare(`INSERT INTO accounts (google_sub, email, role, gmail_status, timezone, created_at) VALUES (?, ?, 'owner', 'connected', ?, ?)`)
        .run(`fake:${DEMO_OWNER_EMAIL}`, DEMO_OWNER_EMAIL, timeZone, at).lastInsertRowid,
    );

    const setting = db.prepare('INSERT INTO settings (account_id, key, value) VALUES (?, ?, ?)');
    setting.run(accountId, 'member_defaults', JSON.stringify(DEMO_MEMBER_DEFAULTS));
    setting.run(accountId, 'etransfer_email', JSON.stringify(DEMO_OWNER_EMAIL));
    setting.run(accountId, 'onboarding_completed', 'true');
    setting.run(accountId, 'etransfer_instructions', JSON.stringify('Send an Interac e-Transfer to demo@example.com (Autodeposit is enabled).'));

    const server = db.prepare(
      `INSERT INTO media_servers (account_id, type, name, base_url, enforcement_enabled, default_library_ids, enabled, created_at)
       VALUES (?, ?, ?, ?, 0, ?, 1, ?)`,
    );
    const plexId = Number(server.run(accountId, 'plex', 'Demo Plex', DEMO_PLEX_URL, JSON.stringify(['1', '2']), at).lastInsertRowid);
    const jellyfinId = Number(server.run(accountId, 'jellyfin', 'Demo Jellyfin', DEMO_JELLYFIN_URL, JSON.stringify(['movies', 'shows']), at).lastInsertRowid);

    const member = db.prepare(
      `INSERT INTO members (account_id, display_name, etransfer_name, email, notes, plan_amount_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const link = db.prepare(
      `INSERT INTO member_server_accounts (account_id, member_id, server_id, external_user_id, external_username)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const m of DEMO_MEMBERS) {
      const memberId = Number(
        member.run(accountId, m.displayName, m.etransferName, m.email, m.notes ?? null, m.planAmountCents ?? null, at, at).lastInsertRowid,
      );
      if (m.plexUserId) link.run(accountId, memberId, plexId, m.plexUserId, m.displayName);
      if (m.jellyfinUserId) link.run(accountId, memberId, jellyfinId, m.jellyfinUserId, m.displayName);
    }

    db.prepare(`INSERT INTO audit_log (account_id, at, actor, action, entity, details) VALUES (?, ?, 'system', 'demo.seeded', 'workspace', ?)`).run(
      accountId,
      at,
      JSON.stringify({ members: DEMO_MEMBERS.length, servers: 2 }),
    );
    return accountId;
  });

  return { seeded: true, accountId: run() };
}
