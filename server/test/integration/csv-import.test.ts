import { describe, expect, it } from 'vitest';
import type { ImportBatchView, ImportRowsPage, ImportRowView, MemberDetail } from '@subscriberr/shared';
import { seedDemo } from '../../src/db/seed-demo.js';
import { runImportCleanup } from '../../src/modules/csv/jobs.js';
import { allowEmail, createWorld, testApp } from '../helpers/env.js';
import { type App, CSRF, cookieFrom } from '../helpers/http.js';

async function login(app: App, email: string): Promise<string> {
  const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: JSON.stringify({ email }) });
  expect(res.status, email).toBe(200);
  return cookieFrom(res, 'subscriberr_session')!;
}

const DEFAULTS = { planAmountCents: 1500, planPeriodDays: 30, currency: 'CAD', toleranceCents: 0, graceDays: 3 };

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
    const text = await res.text();
    expect(res.status, `${init.method ?? 'GET'} ${p}: ${text.slice(0, 400)}`).toBe(status);
    return JSON.parse(text) as T;
  };
  for (const c of [owner, operator]) await json(c, '/api/workspace/settings', { method: 'PATCH', body: { memberDefaults: DEFAULTS } });
  const create = (cookie: string, body: Record<string, unknown>) => json<MemberDetail>(cookie, '/api/members', { method: 'POST', body }, 201);
  const upload = (cookie: string, content: string | Uint8Array, name = 'members.csv') => {
    const fd = new FormData();
    fd.append('file', new File([typeof content === "string" ? content : Buffer.from(content)], name, { type: 'text/csv' }));
    return app.request('/api/csv/imports', { method: 'POST', headers: { 'x-requested-with': 'subscriberr', cookie }, body: fd });
  };
  /** Upload + accept the automatic mapping → review stage. */
  const stage = async (cookie: string, content: string, mapping?: { columns?: Array<string | null>; defaults?: Record<string, string> }) => {
    const res = await upload(cookie, content);
    const uploaded = (await res.json()) as ImportBatchView;
    expect(res.status, JSON.stringify(uploaded)).toBe(201);
    const batch = await json<ImportBatchView>(cookie, `/api/csv/imports/${uploaded.id}/mapping`, {
      method: 'PUT',
      body: { columns: mapping?.columns ?? uploaded.columns, defaults: mapping?.defaults ?? {}, stage: true },
    });
    const rows = await json<ImportRowsPage>(cookie, `/api/csv/imports/${uploaded.id}/rows?pageSize=200`);
    return { id: uploaded.id, batch, rows: rows.items, summary: rows.summary };
  };
  const plexId = Number(
    world.db.prepare(`INSERT INTO media_servers (account_id, type, name, base_url, created_at) VALUES (1, 'plex', 'Plex', 'fake://plex', '2026-01-01T00:00:00Z')`).run().lastInsertRowid,
  );
  return { world, app, owner, operator, call, json, create, upload, stage, plexId };
}

const byRow = (rows: ImportRowView[], n: number) => rows.find((r) => r.rowNumber === n)!;
const cell = (row: ImportRowView, field: string) => row.cells.find((c) => c.field === field)!;

describe('CSV export (Spec §12.1)', () => {
  it('exports stable columns with a BOM, server columns, the formula guard and the list filters', async () => {
    const { owner, call, create, json, world, plexId } = await setup();
    const ann = await create(owner, { displayName: 'Ann', etransferName: 'ANN SMITH', email: 'ann@example.com', notes: '=HYPERLINK("x")', planAmountCents: 2000, paymentMemoCode: 'AS-1' });
    await json(owner, `/api/members/${ann.id}/aliases`, { method: 'POST', body: { kind: 'name', value: 'A Smith' } }, 201);
    world.db.prepare(`INSERT INTO member_server_accounts (account_id, member_id, server_id, external_user_id, external_username) VALUES (1, ?, ?, 'plex-102', 'pat')`).run(ann.id, plexId);
    const bob = await create(owner, { displayName: 'Bob' });
    await json(owner, `/api/members/${bob.id}/status`, { method: 'POST', body: { action: 'archive' } });

    const res = await call(owner, '/api/csv/export?status=all');
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="subscriberr-members-2026-11-12.csv"');
    const raw = new Uint8Array(await res.arrayBuffer());
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'id,display_name,etransfer_name,email,notes,plan_amount,plan_period_days,currency,tolerance,grace_days,paid_through,credit,status,reminders_enabled,emails_enabled,aliases,payment_memo_code,server:Plex',
    );
    expect(lines[1]).toBe(`${ann.id},Ann,ANN SMITH,ann@example.com,"'=HYPERLINK(""x"")",20.00,,CAD,,,,0.00,expired,true,true,a smith,AS-1,pat`);
    expect(lines[2]).toBe(`${bob.id},Bob,,,,,,CAD,,,,0.00,archived,true,true,,,`);

    const current = await (await call(owner, '/api/csv/export')).text();
    expect(current).not.toContain('Bob'); // default filter hides archived, like the list
    const template = await (await call(owner, '/api/csv/template')).text();
    expect(template.slice(1).split('\r\n')[0]).toContain('server:Plex');
    expect(template).toContain('Ann (neighbour)');
  });

  it('an exported file re-imports with no changes', async () => {
    const { owner, call, create, json, stage } = await setup();
    const a = await create(owner, { displayName: 'Ann', etransferName: 'ANN SMITH', email: 'ann@example.com', notes: 'line1\nline2 = ok', planAmountCents: 2000 });
    await json(owner, `/api/members/${a.id}/aliases`, { method: 'POST', body: { kind: 'email', value: 'ann.work@example.com' } }, 201);
    await create(owner, { displayName: 'José', graceDays: 0, emailsEnabled: false });
    const csv = await (await call(owner, '/api/csv/export')).text();
    const { id, summary, rows } = await stage(owner, csv);
    expect(summary).toMatchObject({ rows: 2, create: 0, update: 0, unchanged: 2, errorRows: 0 });
    expect(rows.every((r) => r.match.type === 'id' && r.changes === 0)).toBe(true);
    expect((await call(owner, `/api/csv/imports/${id}/commit`, { method: 'POST' })).status).toBe(400);
  });
});

describe('demo workspace round trip', () => {
  it('the seeded demo exports and re-imports with no changes and no warnings (server links resolve)', async () => {
    const world = createWorld({ start: '2026-11-12T15:00:00Z' });
    seedDemo(world.db, world.clock.now(), 'America/Toronto');
    const { app } = testApp(world);
    const res = await app.request('/auth/dev-login', { method: 'POST', headers: CSRF, body: '{}' });
    const cookie = cookieFrom(res, 'subscriberr_session')!;
    const headers = { ...CSRF, cookie };
    const csv = await (await app.request('/api/csv/export?status=all', { headers })).text();
    expect(csv).toContain(',payer.one');
    const fd = new FormData();
    fd.append('file', new File([csv], 'demo.csv'));
    const uploaded = (await (await app.request('/api/csv/imports', { method: 'POST', headers: { 'x-requested-with': 'subscriberr', cookie }, body: fd })).json()) as ImportBatchView;
    await app.request(`/api/csv/imports/${uploaded.id}/mapping`, { method: 'PUT', headers, body: JSON.stringify({ columns: uploaded.columns, stage: true }) });
    const page = (await (await app.request(`/api/csv/imports/${uploaded.id}/rows?pageSize=200`, { headers })).json()) as ImportRowsPage;
    expect(page.items.flatMap((r) => r.warnings)).toEqual([]);
    expect(page.summary).toMatchObject({ rows: 5, unchanged: 5, create: 0, update: 0, errorRows: 0, warningRows: 0, safetyWarnings: [] });
  });
});

describe('upload and mapping (Spec §12.2 steps 1–2)', () => {
  it('detects encoding and delimiter, and auto-maps headers', async () => {
    const { owner, upload } = await setup();
    const latin1 = new Uint8Array([...Buffer.from('Name;E-mail;Payer\nJos', 'latin1'), 0xe9, ...Buffer.from(';jose@example.com;JOSE G\n', 'latin1')]);
    const res = await upload(owner, latin1);
    expect(res.status).toBe(201);
    const view = (await res.json()) as ImportBatchView;
    expect(view).toMatchObject({ status: 'staged', stage: 'mapping', encoding: 'windows-1252', delimiter: 'semicolon', headers: ['Name', 'E-mail', 'Payer'], columns: ['display_name', 'email', 'etransfer_name'] });
    expect(view.sample).toEqual([['José', 'jose@example.com', 'JOSE G']]);
    expect(view.availableFields).toContain('server:Plex');
  });

  it('refuses empty, header-only, oversized and malformed files', async () => {
    const { owner, upload } = await setup();
    expect((await upload(owner, '')).status).toBe(400);
    expect((await upload(owner, 'display_name\n')).status).toBe(400);
    expect((await upload(owner, 'display_name\n"open')).status).toBe(400);
    expect((await upload(owner, `display_name\n${'x\n'.repeat(5001)}`)).status).toBe(413);
    expect((await upload(owner, new Uint8Array(5 * 1024 * 1024 + 1).fill(0x41))).status).toBe(413);
  });

  it('validates the mapping and applies defaults for unmapped fields', async () => {
    const { owner, upload, call, stage } = await setup();
    const { id } = (await (await upload(owner, 'Name,Note,Junk\nAnn,hi,x\n')).json()) as ImportBatchView;
    const put = (body: unknown) => call(owner, `/api/csv/imports/${id}/mapping`, { method: 'PUT', body });
    expect((await put({ columns: ['display_name', 'display_name', null] })).status).toBe(400);
    expect((await put({ columns: ['display_name', 'shoe_size', null] })).status).toBe(400);
    expect((await put({ columns: [null, 'notes', null] })).status).toBe(400); // nothing identifies the member
    expect((await put({ columns: ['display_name', null] })).status).toBe(400); // wrong length
    expect((await put({ columns: ['display_name', 'notes', null], defaults: { email: 'x@example.com' } })).status).toBe(400);

    const staged = await stage(owner, 'Name\nAnn\n', { columns: ['display_name'], defaults: { grace_days: '5', currency: 'usd' } });
    expect(staged.rows[0]!.cells.map((c) => [c.field, c.value])).toEqual([
      ['display_name', 'Ann'],
      ['grace_days', '5'],
      ['currency', 'USD'],
    ]);
  });
});

describe('matching, review and corrections (Spec §12.2 steps 3–5)', () => {
  it('matches by id → email → e-Transfer name → display name, and never guesses between two members', async () => {
    const { owner, create, stage } = await setup();
    const a = await create(owner, { displayName: 'Ann', email: 'ann@example.com', etransferName: 'ANN SMITH' });
    const b = await create(owner, { displayName: 'Bea', etransferName: 'BEA JONES' });
    await create(owner, { displayName: 'Sam' });
    await create(owner, { displayName: 'sam' });
    const csv = [
      'id,display_name,email,etransfer_name',
      `${a.id},X,,`, // id
      ',X,ANN@example.com,', // email
      ',X,,bea  jones', // e-Transfer name
      ',Bea,,', // display name
      ',Sam,,', // ambiguous
      ',Newcomer,,', // none
      '999,Ghost,,', // unknown id, falls through
    ].join('\n');
    const { rows, summary } = await stage(owner, csv);
    expect(rows.map((r) => [r.match.type, r.match.confidence, r.match.memberId, r.action])).toEqual([
      ['id', 'exact', a.id, 'update'],
      ['email', 'high', a.id, 'update'],
      ['etransfer_name', 'medium', b.id, 'update'],
      ['display_name', 'medium', b.id, 'update'],
      ['ambiguous', null, null, 'skip'],
      ['none', null, null, 'create'],
      ['none', null, null, 'create'],
    ]);
    expect(byRow(rows, 6).match.candidates).toHaveLength(2);
    expect(byRow(rows, 8).warnings[0]).toMatch(/999 does not exist/);
    // Rows 2–3 and 4–5 update the same member: both are errors until one is fixed.
    expect(byRow(rows, 2).errors.join()).toMatch(/Another row \(row 3\)/);
    expect(summary).toMatchObject({ rows: 7, skip: 1, create: 2, errorRows: 4 });
  });

  it('shows per-field diffs, blank-cell meanings, keep-DB toggles, manual matching and reset', async () => {
    const { owner, create, stage, json } = await setup();
    const a = await create(owner, { displayName: 'Ann', email: 'ann@example.com', etransferName: 'ANN', notes: 'old note', planAmountCents: 2000 });
    const csv = 'email,display_name,etransfer_name,notes,plan_amount,paid_through,status\nann@example.com,Ann,ANN,,,,\nnew@example.com,New,,,9.00,2026-12-01,active\n';
    const { id, rows } = await stage(owner, csv);
    const row = byRow(rows, 2);
    expect(cell(row, 'display_name')).toMatchObject({ state: 'unchanged' });
    expect(cell(row, 'notes')).toMatchObject({ state: 'changed', db: 'old note', value: null, warning: expect.stringMatching(/Clears/) });
    expect(cell(row, 'plan_amount')).toMatchObject({ state: 'changed', db: '20.00', value: null }); // blank = inherit the default
    expect(cell(row, 'paid_through')).toMatchObject({ state: 'unchanged' }); // blank never clears a balance
    expect(row.changes).toBe(2);
    const fresh = byRow(rows, 3);
    expect(fresh).toMatchObject({ action: 'create', changes: 4 });
    expect(cell(fresh, 'status')).toMatchObject({ state: 'unchanged', warning: expect.stringMatching(/calculated from the paid-through/) });

    // Keep the DB value for notes.
    let patched = await json<{ row: ImportRowView }>(owner, `/api/csv/imports/${id}/rows/${row.id}`, { method: 'PATCH', body: { use: { notes: 'db' } } });
    expect(patched.row.changes).toBe(1);
    // Edit a cell with live validation.
    patched = await json(owner, `/api/csv/imports/${id}/rows/${row.id}`, { method: 'PATCH', body: { values: { plan_amount: 'abc' } } });
    expect(patched.row.errors).toEqual(['Plan amount: Enter an amount such as 15.00']);
    expect(cell(patched.row, 'plan_amount')).toMatchObject({ edited: true, original: '' });
    patched = await json(owner, `/api/csv/imports/${id}/rows/${row.id}`, { method: 'PATCH', body: { values: { plan_amount: '25' } } });
    expect(cell(patched.row, 'plan_amount')).toMatchObject({ value: '25.00', state: 'changed', db: '20.00' });
    // Manual match: the new row really is Ann → re-matched and redrawn.
    patched = await json(owner, `/api/csv/imports/${id}/rows/${fresh.id}`, { method: 'PATCH', body: { matchMemberId: a.id } });
    expect(patched.row).toMatchObject({ action: 'update', match: { type: 'manual', memberId: a.id } });
    expect(cell(patched.row, 'email')).toMatchObject({ state: 'changed', db: 'ann@example.com', value: 'new@example.com' });
    patched = await json(owner, `/api/csv/imports/${id}/rows/${fresh.id}`, { method: 'PATCH', body: { matchMemberId: null } });
    expect(patched.row).toMatchObject({ action: 'create', match: { memberId: null } });
    patched = await json(owner, `/api/csv/imports/${id}/rows/${row.id}`, { method: 'PATCH', body: { reset: true } });
    expect(patched.row).toMatchObject({ edited: false, changes: 2 });
    expect((await json<{ error: unknown }>(owner, `/api/csv/imports/${id}/rows/${row.id}`, { method: 'PATCH', body: { values: { shoe: 'x' } } }, 400)).error).toBeDefined();
  });

  it('errors block the commit; bulk tools skip and re-accept rows', async () => {
    const { owner, stage, json, call } = await setup();
    const csv = 'display_name,email,payment_memo_code\nGood,good@example.com,G-1\nBad,not-an-email,\nDupA,a@example.com,X-1\nDupB,b@example.com,x-1\n';
    const { id, summary, rows } = await stage(owner, csv);
    expect(summary.errorRows).toBe(3);
    expect(byRow(rows, 4).errors.join()).toMatch(/Memo code is repeated in row 5/);
    const blocked = await call(owner, `/api/csv/imports/${id}/commit`, { method: 'POST' });
    expect(blocked.status).toBe(409);

    let s = (await json<{ summary: ImportRowsPage['summary'] }>(owner, `/api/csv/imports/${id}/bulk`, { method: 'POST', body: { op: 'skip_errors' } })).summary;
    expect(s).toMatchObject({ errorRows: 0, skip: 3, create: 1 });
    s = (await json<{ summary: ImportRowsPage['summary'] }>(owner, `/api/csv/imports/${id}/bulk`, { method: 'POST', body: { op: 'accept_valid' } })).summary;
    expect(s).toMatchObject({ skip: 3 }); // rows with errors stay skipped
    const filtered = await json<ImportRowsPage>(owner, `/api/csv/imports/${id}/rows?filter=skipped`);
    expect(filtered.items.map((r) => r.rowNumber)).toEqual([3, 4, 5]);
  });

  it('memo codes and aliases are checked against existing members; server users are resolved on the server', async () => {
    const { owner, create, stage, json, plexId, world } = await setup();
    const a = await create(owner, { displayName: 'Ann', email: 'ann@example.com', paymentMemoCode: 'AN-1' });
    await json(owner, `/api/members/${a.id}/aliases`, { method: 'POST', body: { kind: 'name', value: 'Annie' } }, 201);
    const pat = await create(owner, { displayName: 'Pat', email: 'pat@example.com' });
    world.db.prepare(`INSERT INTO member_server_accounts (account_id, member_id, server_id, external_user_id, external_username) VALUES (1, ?, ?, 'plex-101', 'payer.one')`).run(a.id, plexId);
    const csv = 'display_name,email,payment_memo_code,aliases,server:Plex\nPat,pat@example.com,an-1,Annie|P,payer2@example.com\nNew1,n1@example.com,,,nobody\nNew2,n2@example.com,,,demo-owner\nNew3,n3@example.com,,,payer.one\n';
    const { rows } = await stage(owner, csv);
    const p = byRow(rows, 2);
    expect(p.match.memberId).toBe(pat.id);
    expect(p.errors).toEqual(['Memo code: “an-1” is already used by Ann']);
    expect(p.warnings.join()).toMatch(/“annie” already belongs to Ann; skipped/);
    expect(cell(p, 'server:Plex')).toMatchObject({ state: 'changed', db: null });
    expect(cell(byRow(rows, 3), 'server:Plex').warning).toMatch(/No user “nobody”/);
    expect(cell(byRow(rows, 4), 'server:Plex').warning).toMatch(/admin account/);
    expect(cell(byRow(rows, 5), 'server:Plex').warning).toMatch(/already linked to Ann/);
  });
});

describe('commit and undo (Spec §12.2 step 6, §12.3)', () => {
  const CSV = [
    'email,display_name,etransfer_name,plan_amount,paid_through,credit,aliases,status,server:Plex',
    'ann@example.com,Ann,ANN SMITH,25.00,2026-12-31,5.00,A Smith|ann.work@example.com,,pat',
    'new@example.com,Newbie,NEW BIE,,2026-11-01,,,,',
    'plain@example.com,Plain,,,,,,paused,',
  ].join('\n');

  it('backs up first, writes balances as manual_set ledger entries, links and aliases, never sends email; undo restores', async () => {
    const { owner, create, stage, json, call, world, plexId } = await setup();
    const ann = await create(owner, { displayName: 'Ann', email: 'ann@example.com', etransferName: 'ANN SMITH', planAmountCents: 2000 });
    const { id, summary } = await stage(owner, CSV);
    expect(summary).toMatchObject({ create: 2, update: 1, errorRows: 0 });
    expect(summary.safetyWarnings.join(' ')).toMatch(/1 imported member is already past the grace period/);
    expect(summary.safetyWarnings.join(' ')).toMatch(/1 media-server link/);

    const committed = await json<ImportBatchView>(owner, `/api/csv/imports/${id}/commit`, { method: 'POST' });
    expect(committed).toMatchObject({ status: 'committed', result: { created: 2, updated: 1, ledgerEntries: 2, aliasesAdded: 2, serverLinks: 1 }, undo: { available: true } });
    expect(world.db.prepare(`SELECT kind, verified FROM backup_runs WHERE kind = 'pre_import'`).all()).toEqual([{ kind: 'pre_import', verified: 1 }]);

    const db = world.db;
    const member = (email: string) => db.prepare('SELECT id, plan_amount_cents, paid_through, credit_cents, status, import_batch_id FROM members WHERE email = ?').get(email) as Record<string, unknown>;
    expect(member('ann@example.com')).toMatchObject({ id: ann.id, plan_amount_cents: 2500, paid_through: '2026-12-31', credit_cents: 500, status: 'active', import_batch_id: id });
    expect(member('new@example.com')).toMatchObject({ paid_through: '2026-11-01', status: 'expired', import_batch_id: id });
    expect(member('plain@example.com')).toMatchObject({ paid_through: null, status: 'paused' });
    expect(db.prepare(`SELECT kind, set_paid_through, set_credit_cents, note, paid_through_after FROM ledger_entries ORDER BY id`).all()).toEqual([
      { kind: 'manual_set', set_paid_through: '2026-12-31', set_credit_cents: 500, note: `CSV import #${id}`, paid_through_after: '2026-12-31' },
      { kind: 'manual_set', set_paid_through: '2026-11-01', set_credit_cents: null, note: `CSV import #${id}`, paid_through_after: '2026-11-01' },
    ]);
    expect(db.prepare(`SELECT kind, value, source FROM member_aliases WHERE member_id = ? ORDER BY value`).all(ann.id)).toEqual([
      { kind: 'name', value: 'a smith', source: 'import' },
      { kind: 'email', value: 'ann.work@example.com', source: 'import' },
    ]);
    expect(db.prepare('SELECT member_id, server_id, external_user_id FROM member_server_accounts').all()).toEqual([{ member_id: ann.id, server_id: plexId, external_user_id: 'plex-102' }]);
    expect(db.prepare('SELECT count(*) AS n FROM import_before_images').get()).toEqual({ n: 3 });
    expect(db.prepare('SELECT count(*) AS n FROM email_queue').get()).toEqual({ n: 0 });
    const annTimeline = (await json<MemberDetail>(owner, `/api/members/${ann.id}`)).timeline.map((e) => e.action);
    expect(annTimeline).toEqual(expect.arrayContaining(['member.updated', 'ledger.manual_set', 'member.alias_added', 'member.server_linked']));

    // A second commit or edits after the commit are refused.
    expect((await call(owner, `/api/csv/imports/${id}/commit`, { method: 'POST' })).status).toBe(409);

    const undone = await json<ImportBatchView>(owner, `/api/csv/imports/${id}/undo`, { method: 'POST' });
    expect(undone).toMatchObject({ status: 'undone', undo: { available: false } });
    expect(member('ann@example.com')).toMatchObject({ plan_amount_cents: 2000, paid_through: null, credit_cents: 0, status: 'expired', import_batch_id: null });
    // Newbie got a balance (append-only ledger) → archived; Plain had none → deleted.
    expect(member('new@example.com')).toMatchObject({ status: 'archived', paid_through: null });
    expect(db.prepare(`SELECT count(*) AS n FROM members WHERE email = 'plain@example.com'`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT kind, reverses_entry_id FROM ledger_entries WHERE kind = 'void' ORDER BY id`).all()).toHaveLength(2);
    expect(db.prepare('SELECT count(*) AS n FROM member_aliases').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM member_server_accounts').get()).toEqual({ n: 0 });
    expect((await call(owner, `/api/csv/imports/${id}/undo`, { method: 'POST' })).status).toBe(409);
  });

  it('undo is refused after later changes to an imported member, and after 24 hours', async () => {
    const { owner, create, stage, json, call, world } = await setup();
    const ann = await create(owner, { displayName: 'Ann', email: 'ann@example.com' });
    const first = await stage(owner, 'email,notes\nann@example.com,imported note\n');
    await json(owner, `/api/csv/imports/${first.id}/commit`, { method: 'POST' });
    await json(owner, `/api/members/${ann.id}`, { method: 'PATCH', body: { displayName: 'Ann B' } });
    const view = await json<ImportBatchView>(owner, `/api/csv/imports/${first.id}`);
    expect(view.undo).toMatchObject({ available: false, reason: expect.stringMatching(/changed after the import.*Ann B/) });
    expect((await call(owner, `/api/csv/imports/${first.id}/undo`, { method: 'POST' })).status).toBe(409);

    const second = await stage(owner, 'email,notes\nann@example.com,second\n');
    await json(owner, `/api/csv/imports/${second.id}/commit`, { method: 'POST' });
    world.clock.advanceMs(25 * 3_600_000);
    expect((await json<ImportBatchView>(owner, `/api/csv/imports/${second.id}`)).undo).toMatchObject({ available: false, reason: expect.stringMatching(/24 hours/) });
  });

  it('status cells pause, archive and reactivate', async () => {
    const { owner, create, stage, json } = await setup();
    const a = await create(owner, { displayName: 'A', email: 'a@example.com' });
    const b = await create(owner, { displayName: 'B', email: 'b@example.com' });
    await json(owner, `/api/members/${b.id}/status`, { method: 'POST', body: { action: 'archive' } });
    const { id } = await stage(owner, 'email,status\na@example.com,archived\nb@example.com,active\n');
    await json(owner, `/api/csv/imports/${id}/commit`, { method: 'POST' });
    expect((await json<MemberDetail>(owner, `/api/members/${a.id}`)).status).toBe('archived');
    expect((await json<MemberDetail>(owner, `/api/members/${b.id}`)).status).toBe('expired');
  });
});

describe('isolation and housekeeping', () => {
  it('imports are workspace-scoped: another workspace can neither see nor touch them, nor match its members', async () => {
    const { owner, operator, create, stage, call, json } = await setup();
    const ann = await create(owner, { displayName: 'Ann', email: 'ann@example.com' });
    const { id, rows } = await stage(owner, 'email,display_name\nann@example.com,Ann\n');
    expect(rows[0]!.match.memberId).toBe(ann.id);
    for (const [method, p, body] of [
      ['GET', `/api/csv/imports/${id}`],
      ['GET', `/api/csv/imports/${id}/rows`],
      ['PUT', `/api/csv/imports/${id}/mapping`, { columns: ['email', 'display_name'] }],
      ['PATCH', `/api/csv/imports/${id}/rows/${rows[0]!.id}`, { action: 'skip' }],
      ['POST', `/api/csv/imports/${id}/commit`],
      ['POST', `/api/csv/imports/${id}/undo`],
      ['DELETE', `/api/csv/imports/${id}`],
    ] as Array<[string, string, unknown?]>) {
      expect((await call(operator, p, { method, body })).status, `${method} ${p}`).toBe(404);
    }
    expect((await json<{ items: unknown[] }>(operator, '/api/csv/imports')).items).toEqual([]);
    // The same file in the operator's workspace creates a member there instead of matching the owner's Ann.
    const theirs = await stage(operator, 'email,display_name\nann@example.com,Ann\n');
    expect(theirs.rows[0]).toMatchObject({ action: 'create', match: { memberId: null } });
    expect(await (await call(operator, '/api/csv/export')).text()).not.toContain('ann@example.com');
    expect((await call(operator, `/api/csv/imports/${theirs.id}/rows/${rows[0]!.id}`, { method: 'PATCH', body: { action: 'skip' } })).status).toBe(404);
  });

  it('abandoned staging is purged after 7 days; committed imports are kept', async () => {
    const { owner, stage, json, world } = await setup();
    const old = await stage(owner, 'display_name\nOld\n');
    const done = await stage(owner, 'display_name\nDone\n');
    await json(owner, `/api/csv/imports/${done.id}/commit`, { method: 'POST' });
    world.clock.advanceDays(8);
    const fresh = await stage(owner, 'display_name\nFresh\n');
    expect(runImportCleanup(world.ctx, world.clock)).toEqual({ abandoned: 1 });
    const status = (id: number) => (world.db.prepare('SELECT status FROM import_batches WHERE id = ?').get(id) as { status: string }).status;
    expect([status(old.id), status(done.id), status(fresh.id)]).toEqual(['abandoned', 'committed', 'staged']);
    expect(world.db.prepare('SELECT count(*) AS n FROM import_rows WHERE batch_id = ?').get(old.id)).toEqual({ n: 0 });
  });
});
