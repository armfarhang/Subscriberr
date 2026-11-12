import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MemberDetail, MemberList } from '@subscriberr/shared';
import { allowEmail, createWorld, testApp } from '../helpers/env.js';
import { type App, CSRF, cookieFrom } from '../helpers/http.js';

async function login(app: App, email: string): Promise<string> {
  const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: JSON.stringify({ email }) });
  expect(res.status, email).toBe(200);
  return cookieFrom(res, 'subscriberr_session')!;
}

const DEFAULTS = { planAmountCents: 1500, planPeriodDays: 30, currency: 'CAD', toleranceCents: 0, graceDays: 3 };

/** Owner (account 1) and operator (account 2), each signed in, owner with member defaults set. */
async function setup() {
  const world = createWorld({ start: '2026-11-12T15:00:00Z' });
  const { app } = testApp(world);
  const owner = await login(app, 'owner@example.com');
  allowEmail(world.db, 'operator@example.com');
  const operator = await login(app, 'operator@example.com');
  const call = (cookie: string, p: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(p, { method: init.method ?? 'GET', headers: { ...CSRF, cookie }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const json = async <T>(cookie: string, p: string, init: { method?: string; body?: unknown } = {}, status = 200): Promise<T> => {
    const res = await call(cookie, p, init);
    const body = (await res.json()) as T;
    expect(res.status, `${init.method ?? 'GET'} ${p}: ${JSON.stringify(body)}`).toBe(status);
    return body;
  };
  await json(owner, '/api/workspace/settings', { method: 'PATCH', body: { memberDefaults: DEFAULTS } });
  const create = (cookie: string, body: Record<string, unknown>) => json<MemberDetail>(cookie, '/api/members', { method: 'POST', body }, 201);
  return { world, app, owner, operator, call, json, create };
}

describe('members CRUD (Spec §6.2)', () => {
  it('a new member needs only a display name and inherits the workspace defaults', async () => {
    const { owner, create, world } = await setup();
    const m = await create(owner, { displayName: 'Ann (neighbour)' });
    expect(m).toMatchObject({
      displayName: 'Ann (neighbour)',
      etransferName: null,
      email: null,
      status: 'expired',
      currency: 'CAD',
      paidThrough: null,
      creditCents: 0,
      dueInDays: null,
      remindersEnabled: true,
      emailsEnabled: true,
      overrides: { planAmountCents: null, planPeriodDays: null, toleranceCents: null, graceDays: null },
      terms: {
        planAmountCents: { value: 1500, inherited: true },
        planPeriodDays: { value: 30, inherited: true },
        toleranceCents: { value: 0, inherited: true },
        graceDays: { value: 3, inherited: true },
      },
      canDelete: true,
      managedRule: null,
    });
    expect(m.warnings.map((w) => w.code)).toEqual(['no_email']);
    expect(m.timeline).toMatchObject([{ action: 'member.created', actor: 'admin:owner@example.com' }]);
    expect(world.db.prepare('SELECT account_id FROM members WHERE id = ?').get(m.id)).toEqual({ account_id: 1 });
  });

  it('validates input and refuses balance or status fields', async () => {
    const { owner, call, create } = await setup();
    const post = (body: unknown) => call(owner, '/api/members', { method: 'POST', body });
    expect((await post({})).status).toBe(400);
    expect((await post({ displayName: '  ' })).status).toBe(400);
    expect((await post({ displayName: 'A', email: 'nope' })).status).toBe(400);
    expect((await post({ displayName: 'A', paidThrough: '2027-01-01' })).status).toBe(400);
    expect((await post({ displayName: 'A', planAmountCents: 12.5 })).status).toBe(400);
    const m = await create(owner, { displayName: 'A' });
    for (const body of [{ paidThrough: '2027-01-01' }, { creditCents: 500 }, { lastPaymentAt: '2026-01-01T00:00:00Z' }, { status: 'active' }, { graceDays: -1 }]) {
      expect((await call(owner, `/api/members/${m.id}`, { method: 'PATCH', body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('overrides are per member, can be cleared back to inherit, and are audited', async () => {
    const { owner, json, create } = await setup();
    const m = await create(owner, { displayName: 'Bo', email: 'BO@example.com', planAmountCents: 2000, graceDays: 0 });
    expect(m.email).toBe('bo@example.com');
    expect(m.terms.planAmountCents).toEqual({ value: 2000, inherited: false });
    expect(m.terms.graceDays).toEqual({ value: 0, inherited: false });

    const cleared = await json<MemberDetail>(owner, `/api/members/${m.id}`, { method: 'PATCH', body: { planAmountCents: null, notes: 'Pays on the 1st. Phone 555-0100.' } });
    expect(cleared.terms.planAmountCents).toEqual({ value: 1500, inherited: true });
    expect(cleared.notes).toBe('Pays on the 1st. Phone 555-0100.');
    const update = cleared.timeline.find((e) => e.action === 'member.updated')!;
    expect(update.details).toEqual({ fields: ['notes', 'planAmountCents'], changes: { planAmountCents: { from: 2000, to: null }, notes: { changed: true } } });
    expect(JSON.stringify(cleared.timeline)).not.toContain('555-0100'); // notes text is never copied into the audit log

    // The workspace default flows through to inheriting members.
    await json(owner, '/api/workspace/settings', { method: 'PATCH', body: { memberDefaults: { ...DEFAULTS, planAmountCents: 1800 } } });
    expect((await json<MemberDetail>(owner, `/api/members/${m.id}`)).terms.planAmountCents).toEqual({ value: 1800, inherited: true });

    // A no-op patch writes nothing.
    const before = cleared.timeline.length;
    expect((await json<MemberDetail>(owner, `/api/members/${m.id}`, { method: 'PATCH', body: { email: 'bo@example.com', graceDays: 0 } })).timeline).toHaveLength(before);
  });

  it('lists with search, filters, sorting, counts and pagination', async () => {
    const { owner, json, create, world } = await setup();
    const ann = await create(owner, { displayName: 'Ann', etransferName: 'ANN SMITH', email: 'ann@example.com' });
    const jose = await create(owner, { displayName: 'José García', notes: 'Brother-in-law' });
    const zed = await create(owner, { displayName: 'zed' });
    await json(owner, `/api/members/${zed.id}/aliases`, { method: 'POST', body: { kind: 'name', value: 'Zedekiah Q' } }, 201);
    await json(owner, `/api/members/${jose.id}/status`, { method: 'POST', body: { action: 'archive' } });
    // Simulate ledger-derived due dates (the billing module writes these from M6 on).
    world.db.prepare(`UPDATE members SET paid_through = '2026-11-20', status = 'active' WHERE id = ?`).run(zed.id);
    world.db.prepare(`UPDATE members SET paid_through = '2026-12-01', status = 'active' WHERE id = ?`).run(ann.id);

    const names = (l: MemberList) => l.items.map((i) => i.displayName);
    const list = await json<MemberList>(owner, '/api/members');
    expect(names(list)).toEqual(['Ann', 'zed']); // archived hidden by default, case-insensitive name sort
    expect(list.counts).toEqual({ active: 2, grace: 0, expired: 0, paused: 0, archived: 1 });
    expect(list.items.find((i) => i.id === zed.id)!.dueInDays).toBe(8);

    expect(names(await json<MemberList>(owner, '/api/members?status=all'))).toEqual(['Ann', 'José García', 'zed']);
    expect(names(await json<MemberList>(owner, '/api/members?status=archived'))).toEqual(['José García']);
    expect(names(await json<MemberList>(owner, '/api/members?status=all&q=jose'))).toEqual(['José García']); // diacritics
    expect(names(await json<MemberList>(owner, '/api/members?status=all&q=BROTHER'))).toEqual(['José García']); // notes
    expect(names(await json<MemberList>(owner, '/api/members?q=smith'))).toEqual(['Ann']); // e-Transfer name
    expect(names(await json<MemberList>(owner, '/api/members?q=ann%40example'))).toEqual(['Ann']); // email
    expect(names(await json<MemberList>(owner, '/api/members?q=zedekiah'))).toEqual(['zed']); // alias
    expect(names(await json<MemberList>(owner, '/api/members?status=all&sort=due'))).toEqual(['zed', 'Ann', 'José García']); // no due date last
    expect(names(await json<MemberList>(owner, '/api/members?status=all&sort=due&dir=desc'))).toEqual(['Ann', 'zed', 'José García']);
    expect(names(await json<MemberList>(owner, '/api/members?status=all&sort=status'))).toEqual(['Ann', 'zed', 'José García']);

    const page2 = await json<MemberList>(owner, '/api/members?status=all&pageSize=2&page=2');
    expect(page2).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(names(page2)).toEqual(['zed']);
    expect((await json<{ error: unknown }>(owner, '/api/members?status=bogus', {}, 400)).error).toBeDefined();
  });

  it('includes linked media-server accounts', async () => {
    const { owner, create, json, world } = await setup();
    const m = await create(owner, { displayName: 'Linked' });
    const serverId = Number(
      world.db
        .prepare(`INSERT INTO media_servers (account_id, type, name, base_url, created_at) VALUES (1, 'plex', 'Home Plex', 'fake://plex', '2026-01-01T00:00:00Z')`)
        .run().lastInsertRowid,
    );
    world.db.prepare(`INSERT INTO member_server_accounts (account_id, member_id, server_id, external_user_id, external_username, access_state) VALUES (1, ?, ?, 'u1', 'linked_user', 'granted')`).run(m.id, serverId);
    const detail = await json<MemberDetail>(owner, `/api/members/${m.id}`);
    expect(detail.servers).toEqual([{ serverId, serverName: 'Home Plex', serverType: 'plex', externalUsername: 'linked_user', accessState: 'granted', lastSyncedAt: null }]);
    expect((await json<MemberList>(owner, '/api/members')).items[0]!.servers).toHaveLength(1);
  });
});

describe('payment memo codes and the managed rule (Spec §7.4.1)', () => {
  it('setting a code maintains one managed rule; clearing it removes the rule', async () => {
    const { owner, json, create, world } = await setup();
    const m = await create(owner, { displayName: 'John S (uncle)', etransferName: 'JOHN  SMITH', paymentMemoCode: 'JS-1' });
    expect(m.managedRule).toMatchObject({ senderName: 'john smith', memoValue: 'JS-1', enabled: true });
    const rules = () => world.db.prepare(`SELECT member_id, managed, sender_name, memo_mode, memo_value, action FROM matching_rules`).all();
    expect(rules()).toEqual([{ member_id: m.id, managed: 1, sender_name: 'john smith', memo_mode: 'contains', memo_value: 'JS-1', action: 'assign' }]);

    await json(owner, `/api/members/${m.id}`, { method: 'PATCH', body: { paymentMemoCode: 'JS-9', etransferName: 'John Smith Jr' } });
    expect(rules()).toEqual([{ member_id: m.id, managed: 1, sender_name: 'john smith jr', memo_mode: 'contains', memo_value: 'JS-9', action: 'assign' }]);

    const cleared = await json<MemberDetail>(owner, `/api/members/${m.id}`, { method: 'PATCH', body: { paymentMemoCode: '' } });
    expect(cleared.paymentMemoCode).toBeNull();
    expect(cleared.managedRule).toBeNull();
    expect(rules()).toEqual([]);
  });

  it('without an e-Transfer name the rule still requires a sender name (the display name)', async () => {
    const { owner, create } = await setup();
    const m = await create(owner, { displayName: 'Kim', paymentMemoCode: 'KIM-1' });
    expect(m.managedRule?.senderName).toBe('kim');
  });

  it('codes are unique per workspace ignoring case and spacing; overlapping codes warn', async () => {
    const { owner, operator, call, create } = await setup();
    const a = await create(owner, { displayName: 'A', paymentMemoCode: 'JS-1' });
    const dup = await call(owner, '/api/members', { method: 'POST', body: { displayName: 'B', paymentMemoCode: ' js-1 ' } });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: { code: 'conflict', details: { field: 'paymentMemoCode', memberId: a.id } } });
    // Another workspace may use the same code.
    await create(operator, { displayName: 'Other', paymentMemoCode: 'JS-1' });

    const b = await create(owner, { displayName: 'B', paymentMemoCode: 'JS-10' });
    expect(b.warnings.find((w) => w.code === 'memo_overlap')).toMatchObject({ others: [{ id: a.id, displayName: 'A' }] });
  });
});

describe('aliases and shared names', () => {
  it('stores aliases normalized and refuses duplicates', async () => {
    const { owner, call, json, create } = await setup();
    const a = await create(owner, { displayName: 'Ann', etransferName: 'Ann Smith', email: 'ann@example.com' });
    const b = await create(owner, { displayName: 'Ben' });
    const add = (id: number, kind: string, value: string) => call(owner, `/api/members/${id}/aliases`, { method: 'POST', body: { kind, value } });

    const withAlias = await json<MemberDetail>(owner, `/api/members/${a.id}/aliases`, { method: 'POST', body: { kind: 'name', value: '  ÁNN   S. ' } }, 201);
    expect(withAlias.aliases).toMatchObject([{ kind: 'name', value: 'ann s.', source: 'manual' }]);
    await json(owner, `/api/members/${a.id}/aliases`, { method: 'POST', body: { kind: 'email', value: 'Ann.Work@Example.com' } }, 201);

    expect((await add(a.id, 'name', 'ann s.')).status).toBe(409); // already exists
    const taken = await add(b.id, 'email', 'ann.work@example.com');
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: { details: { reason: 'taken', memberId: a.id } } });
    expect((await add(a.id, 'name', 'ANN SMITH')).status).toBe(409); // already the e-Transfer name
    expect((await add(a.id, 'email', 'ANN@example.com')).status).toBe(409); // already the email
    expect((await add(a.id, 'email', 'not-an-email')).status).toBe(400);

    const detail = await json<MemberDetail>(owner, `/api/members/${a.id}`);
    const nameAlias = detail.aliases.find((x) => x.kind === 'name')!;
    const after = await json<MemberDetail>(owner, `/api/members/${a.id}/aliases/${nameAlias.id}`, { method: 'DELETE' });
    expect(after.aliases.map((x) => x.value)).toEqual(['ann.work@example.com']);
    expect(after.timeline.map((e) => e.action)).toEqual(['member.alias_removed', 'member.alias_added', 'member.alias_added', 'member.created']);
    // An alias id of another member is not found through this member.
    expect((await call(owner, `/api/members/${b.id}/aliases/${after.aliases[0]!.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('flags members who share a name (e-Transfer name, display name or alias) on both sides', async () => {
    const { owner, json, create } = await setup();
    const a = await create(owner, { displayName: 'John (uncle)', etransferName: 'JOHN SMITH', email: 'j1@example.com' });
    const b = await create(owner, { displayName: 'John (cousin)', etransferName: 'John  Smith', email: 'j2@example.com' });
    const warning = (m: MemberDetail) => m.warnings.find((w) => w.code === 'shared_name');
    expect(warning(b)).toMatchObject({ others: [{ id: a.id }] });
    expect(warning(await json<MemberDetail>(owner, `/api/members/${a.id}`))).toMatchObject({ others: [{ id: b.id }] });

    const c = await create(owner, { displayName: 'Carla', email: 'c@example.com' });
    expect(warning(c)).toBeUndefined();
    await json(owner, `/api/members/${c.id}/aliases`, { method: 'POST', body: { kind: 'name', value: 'john smith' } }, 201);
    expect(warning(await json<MemberDetail>(owner, `/api/members/${c.id}`))?.others.map((o) => o.id).sort()).toEqual([a.id, b.id]);

    await json(owner, `/api/members/${c.id}`, { method: 'PATCH', body: { email: 'j1@example.com' } });
    expect((await json<MemberDetail>(owner, `/api/members/${c.id}`)).warnings.find((w) => w.code === 'shared_email')).toMatchObject({ others: [{ id: a.id }] });
  });
});

describe('status changes and deletion', () => {
  it('pause, archive and reactivate follow §8.3', async () => {
    const { owner, call, json, create, world } = await setup();
    const m = await create(owner, { displayName: 'Dee' });
    const act = (action: string) => call(owner, `/api/members/${m.id}/status`, { method: 'POST', body: { action } });

    expect((await act('reactivate')).status).toBe(409); // not paused/archived
    expect(((await (await act('pause')).json()) as MemberDetail).status).toBe('paused');
    expect((await act('pause')).status).toBe(409);
    expect(((await (await act('archive')).json()) as MemberDetail).status).toBe('archived');
    expect((await act('pause')).status).toBe(409); // reactivate first
    expect(((await (await act('reactivate')).json()) as MemberDetail).status).toBe('expired'); // never paid

    // With a ledger-derived due date, reactivation recomputes the automatic status (today = 2026-11-12).
    world.db.prepare(`UPDATE members SET paid_through = '2026-11-10' WHERE id = ?`).run(m.id);
    await act('archive');
    expect(((await (await act('reactivate')).json()) as MemberDetail).status).toBe('grace');
    world.db.prepare(`UPDATE members SET paid_through = '2026-12-10' WHERE id = ?`).run(m.id);
    await act('pause');
    const back = await json<MemberDetail>(owner, `/api/members/${m.id}/status`, { method: 'POST', body: { action: 'reactivate' } });
    expect(back.status).toBe('active');
    expect(back.timeline[0]).toMatchObject({ action: 'member.status_changed', details: { action: 'reactivate', from: 'paused', to: 'active' } });
    expect((await act('delete')).status).toBe(400);
  });

  it('deletes only members without history; aliases and rules go with them, the audit trail stays', async () => {
    const { owner, call, json, create, world } = await setup();
    const m = await create(owner, { displayName: 'Temp', paymentMemoCode: 'TMP-1' });
    await json(owner, `/api/members/${m.id}/aliases`, { method: 'POST', body: { kind: 'name', value: 'Temporary' } }, 201);
    await json(owner, `/api/members/${m.id}`, { method: 'DELETE' });
    expect((await call(owner, `/api/members/${m.id}`)).status).toBe(404);
    expect(world.db.prepare('SELECT (SELECT count(*) FROM member_aliases) + (SELECT count(*) FROM matching_rules) AS n').get()).toEqual({ n: 0 });
    expect(world.db.prepare(`SELECT action FROM audit_log WHERE entity = 'member' AND entity_id = ? ORDER BY id DESC LIMIT 1`).get(m.id)).toEqual({ action: 'member.deleted' });

    const paid = await create(owner, { displayName: 'Has history' });
    world.db
      .prepare(
        `INSERT INTO payments (account_id, member_id, amount_cents, currency, received_at, sender_name, message_type, status, source, created_at)
         VALUES (1, ?, 1500, 'CAD', '2026-11-01T00:00:00Z', 'X', 'manual', 'manual', 'manual', '2026-11-01T00:00:00Z')`,
      )
      .run(paid.id);
    expect((await json<MemberDetail>(owner, `/api/members/${paid.id}`)).canDelete).toBe(false);
    const refused = await call(owner, `/api/members/${paid.id}`, { method: 'DELETE' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { details: { reason: 'has_history' } } });

    const ledger = await create(owner, { displayName: 'Opening balance' });
    world.db
      .prepare(`INSERT INTO ledger_entries (account_id, member_id, created_at, created_by, kind, effective_at, set_paid_through) VALUES (1, ?, '2026-11-01T00:00:00Z', 'system', 'manual_set', '2026-11-01T00:00:00Z', '2026-12-01')`)
      .run(ledger.id);
    expect((await call(owner, `/api/members/${ledger.id}`, { method: 'DELETE' })).status).toBe(409);
  });
});

describe('workspace isolation (Spec §5.5)', () => {
  it('an operator can neither see nor touch the owner’s members, and vice versa', async () => {
    const { owner, operator, call, json, create } = await setup();
    const ownersMember = await create(owner, { displayName: 'Owner’s member', etransferName: 'Shared Name' });
    const opsMember = await create(operator, { displayName: 'Operator’s member', etransferName: 'Shared Name' });

    expect((await json<MemberList>(operator, '/api/members?status=all')).items.map((i) => i.id)).toEqual([opsMember.id]);
    expect((await json<MemberList>(owner, '/api/members?status=all')).items.map((i) => i.id)).toEqual([ownersMember.id]);
    // Same e-Transfer name in two workspaces is not a shared name.
    expect(opsMember.warnings.map((w) => w.code)).not.toContain('shared_name');

    const id = ownersMember.id;
    const attempts: Array<[string, string, unknown?]> = [
      ['GET', `/api/members/${id}`],
      ['PATCH', `/api/members/${id}`, { displayName: 'Hijacked' }],
      ['POST', `/api/members/${id}/status`, { action: 'archive' }],
      ['POST', `/api/members/${id}/aliases`, { kind: 'name', value: 'x' }],
      ['DELETE', `/api/members/${id}`],
    ];
    for (const [method, p, body] of attempts) {
      expect((await call(operator, p, { method, body })).status, `${method} ${p}`).toBe(404);
    }
    expect(await json<MemberDetail>(owner, `/api/members/${id}`)).toMatchObject({ displayName: 'Owner’s member', status: 'expired', aliases: [] });

    // Alias values are unique per workspace only.
    await json(owner, `/api/members/${id}/aliases`, { method: 'POST', body: { kind: 'email', value: 'same@example.com' } }, 201);
    await json(operator, `/api/members/${opsMember.id}/aliases`, { method: 'POST', body: { kind: 'email', value: 'same@example.com' } }, 201);
  });

  it('needs a session and treats malformed ids as not found', async () => {
    const { app, owner, call } = await setup();
    expect((await app.request('/api/members')).status).toBe(401);
    for (const bad of ['abc', '0', '-1', '1.5', '99999']) expect((await call(owner, `/api/members/${bad}`)).status, bad).toBe(404);
  });
});

describe('invariant: no ledger-cache writes outside the billing module (Spec §6.5a)', () => {
  it('no server source outside modules/billing writes paid_through, credit_cents or last_payment_at', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|sql)$/.test(name)) files.push(full);
      }
    };
    walk(src);
    const offenders = files
      .filter((f) => !/[\\/]modules[\\/]billing[\\/]/.test(f) && !/[\\/]db[\\/]migrations[\\/]/.test(f))
      .filter((f) => {
        const text = readFileSync(f, 'utf8');
        return (
          /UPDATE\s+members\s+SET[^;`]*\b(paid_through|credit_cents|last_payment_at)\s*=/i.test(text) ||
          /INSERT\s+INTO\s+members\s*\([^)]*\b(paid_through|credit_cents|last_payment_at)\b/i.test(text) ||
          /\.set\(\s*\{[^}]*\b(paidThrough|creditCents|lastPaymentAt)\b/.test(text)
        );
      });
    expect(files.length).toBeGreaterThan(20);
    expect(offenders.map((f) => path.relative(src, f))).toEqual([]);
  });
});
