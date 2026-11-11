import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { is } from 'drizzle-orm';
import { SQLiteTable as SQLiteTableClass } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import type { Sqlite } from '../../src/db/client.js';
import * as schema from '../../src/db/schema/index.js';
import { insertAccount, insertMember, memoryDb } from '../helpers/env.js';

const T = '2026-01-01T00:00:00Z';

function insertPayment(db: Sqlite, accountId: number, overrides: Record<string, unknown> = {}): number {
  const row = {
    account_id: accountId,
    member_id: null,
    amount_cents: 1500,
    received_at: T,
    interac_reference: 'REF1',
    gmail_message_id: 'msg-1',
    message_type: 'autodeposit',
    status: 'matched',
    source: 'gmail',
    created_at: T,
    ...overrides,
  };
  const cols = Object.keys(row);
  return Number(
    db.prepare(`INSERT INTO payments (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row)).lastInsertRowid,
  );
}

function insertLedger(db: Sqlite, accountId: number, memberId: number, overrides: Record<string, unknown> = {}): number {
  const row = { account_id: accountId, member_id: memberId, created_at: T, created_by: 'system', kind: 'manual_set', effective_at: T, set_paid_through: '2026-02-01', ...overrides };
  const cols = Object.keys(row);
  return Number(
    db.prepare(`INSERT INTO ledger_entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row)).lastInsertRowid,
  );
}

describe('schema conventions (Spec §6.0)', () => {
  it('every table is STRICT and every scoped table has account_id + UNIQUE (account_id, id)', () => {
    const db = memoryDb();
    const tables = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string; sql: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(
      [
        'accounts', 'allowed_accounts', 'announcements', 'audit_log', 'backup_runs', 'email_queue', 'gmail_scan_state',
        'import_batches', 'import_before_images', 'import_rows', 'job_runs', 'ledger_entries', 'matching_rules',
        'media_servers', 'member_aliases', 'member_server_accounts', 'members', 'meta', 'payments', 'sessions', 'settings',
      ].sort(),
    );
    for (const t of tables) expect(t.sql, t.name).toMatch(/\)\s*STRICT\s*$/);

    // Parents referenced by composite foreign keys.
    for (const parent of ['members', 'media_servers', 'payments', 'ledger_entries', 'matching_rules', 'announcements', 'import_batches', 'email_queue']) {
      const sql = tables.find((t) => t.name === parent)!.sql;
      expect(sql, parent).toMatch(/UNIQUE \(account_id, id\)/);
      expect(sql, parent).toMatch(/account_id\s+INTEGER NOT NULL/);
    }
  });

  it('uses the binding connection settings', () => {
    const db = memoryDb();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('synchronous', { simple: true })).toBe(2); // FULL
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('has the required indexes (§6.8)', () => {
    const db = memoryDb();
    const indexCols = (table: string) =>
      (db.prepare(`SELECT name FROM pragma_index_list(?)`).all(table) as Array<{ name: string }>).map((i) =>
        (db.prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`).all(i.name) as Array<{ name: string }>).map((c) => c.name).join(','),
      );
    expect(indexCols('payments')).toEqual(expect.arrayContaining(['account_id,status', 'account_id,member_id,received_at']));
    expect(indexCols('members')).toEqual(expect.arrayContaining(['account_id,status', 'account_id,paid_through']));
    expect(indexCols('member_aliases')).toEqual(expect.arrayContaining(['account_id,value']));
    expect(indexCols('ledger_entries')).toEqual(expect.arrayContaining(['account_id,member_id,effective_at']));
    expect(indexCols('email_queue')).toEqual(expect.arrayContaining(['status,not_before', 'account_id,sent_at']));
    expect(indexCols('audit_log')).toEqual(expect.arrayContaining(['account_id,entity,entity_id,at']));
  });

  it('the Drizzle schema declares exactly the columns of the real tables', () => {
    const db = memoryDb();
    const drizzleTables = (Object.values(schema) as unknown[]).filter((v): v is SQLiteTable => is(v, SQLiteTableClass));
    const declared = new Map(drizzleTables.map((t) => [getTableConfig(t).name, getTableConfig(t).columns.map((c) => c.name).sort()]));
    const real = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>;
    expect([...declared.keys()].sort()).toEqual(real.map((r) => r.name).sort());
    for (const { name } of real) {
      const cols = (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(name) as Array<{ name: string }>).map((c) => c.name).sort();
      expect(declared.get(name), name).toEqual(cols);
    }
  });
});

describe('schema rejects bad data (Spec §17 data-safety)', () => {
  it('cross-workspace references violate the composite foreign keys', () => {
    const db = memoryDb();
    const a = insertAccount(db, 'a@example.com');
    const b = insertAccount(db, 'b@example.com', 'operator');
    const memberOfA = insertMember(db, a);

    // A payment in workspace B pointing at workspace A's member.
    expect(() => insertPayment(db, b, { member_id: memberOfA })).toThrow(/FOREIGN KEY/);
    // An alias, a ledger entry and a queued email likewise.
    expect(() => db.prepare(`INSERT INTO member_aliases (account_id, member_id, kind, value, created_at) VALUES (?, ?, 'name', 'x', ?)`).run(b, memberOfA, T)).toThrow(/FOREIGN KEY/);
    expect(() => insertLedger(db, b, memberOfA)).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.prepare(`INSERT INTO email_queue (account_id, kind, member_id, to_address, subject, html, text, created_at) VALUES (?, 'thanks', ?, 'x@example.com', 's', 'h', 't', ?)`).run(b, memberOfA, T),
    ).toThrow(/FOREIGN KEY/);

    // A server link mixing workspaces.
    const serverOfB = Number(db.prepare(`INSERT INTO media_servers (account_id, type, name, base_url, created_at) VALUES (?, 'plex', 'P', 'fake://plex', ?)`).run(b, T).lastInsertRowid);
    expect(() => db.prepare(`INSERT INTO member_server_accounts (account_id, member_id, server_id, external_user_id) VALUES (?, ?, ?, 'u1')`).run(a, memberOfA, serverOfB)).toThrow(/FOREIGN KEY/);

    // The same rows are fine inside one workspace.
    expect(insertPayment(db, a, { member_id: memberOfA })).toBeGreaterThan(0);
  });

  it('rejects invalid enums, booleans and JSON, and wrong types (STRICT)', () => {
    const db = memoryDb();
    const a = insertAccount(db);
    const m = insertMember(db, a);
    expect(() => db.prepare(`UPDATE members SET status = 'banana' WHERE id = ?`).run(m)).toThrow(/CHECK/);
    expect(() => db.prepare(`UPDATE members SET emails_enabled = 2 WHERE id = ?`).run(m)).toThrow(/CHECK/);
    expect(() => db.prepare(`UPDATE members SET display_name = '   ' WHERE id = ?`).run(m)).toThrow(/CHECK/);
    expect(() => db.prepare(`UPDATE members SET plan_amount_cents = 'fifteen' WHERE id = ?`).run(m)).toThrow(/cannot store TEXT value in INTEGER column/);
    expect(() => db.prepare(`INSERT INTO settings (account_id, key, value) VALUES (?, 'k', '{not json')`).run(a)).toThrow(/CHECK/);
    expect(() => insertPayment(db, a, { status: 'paid' })).toThrow(/CHECK/);
    expect(() => insertPayment(db, a, { raw_snapshot: '{oops' })).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO accounts (google_sub, email, role, created_at) VALUES ('s', 'x@example.com', 'root', ?)`).run(T)).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO backup_runs (kind, tier, started_at) VALUES ('hourly', 'daily', ?)`).run(T)).toThrow(/CHECK/);
  });

  it('rejects negative credit', () => {
    const db = memoryDb();
    const m = insertMember(db, insertAccount(db));
    expect(() => db.prepare('UPDATE members SET credit_cents = -1 WHERE id = ?').run(m)).toThrow(/CHECK/);
  });

  it('rejects a duplicate interac_reference unless the copy is stored as duplicate', () => {
    const db = memoryDb();
    const a = insertAccount(db, 'a@example.com');
    const b = insertAccount(db, 'b@example.com', 'operator');
    insertPayment(db, a, { interac_reference: 'C1AAAAAAAAA1', gmail_message_id: 'm1' });
    expect(() => insertPayment(db, a, { interac_reference: 'C1AAAAAAAAA1', gmail_message_id: 'm2' })).toThrow(/UNIQUE/);
    // The second email is kept for audit as a duplicate…
    expect(insertPayment(db, a, { interac_reference: 'C1AAAAAAAAA1', gmail_message_id: 'm2', status: 'duplicate' })).toBeGreaterThan(0);
    // …the same Gmail message can never be stored twice…
    expect(() => insertPayment(db, a, { interac_reference: 'OTHER', gmail_message_id: 'm1' })).toThrow(/UNIQUE/);
    // …and uniqueness is per workspace.
    expect(insertPayment(db, b, { interac_reference: 'C1AAAAAAAAA1', gmail_message_id: 'm1' })).toBeGreaterThan(0);
    // Manual payments have no reference or message id and never collide.
    insertPayment(db, a, { interac_reference: null, gmail_message_id: null, message_type: 'manual', status: 'manual', source: 'manual' });
    insertPayment(db, a, { interac_reference: null, gmail_message_id: null, message_type: 'manual', status: 'manual', source: 'manual' });
  });

  it('never stores a memo for awaiting-deposit transfers (§7.2)', () => {
    const db = memoryDb();
    const a = insertAccount(db);
    expect(() => insertPayment(db, a, { message_type: 'awaiting_deposit', status: 'pending_deposit', memo: 'the answer is blue' })).toThrow(/CHECK/);
    expect(insertPayment(db, a, { message_type: 'awaiting_deposit', status: 'pending_deposit', expires_on: '2017-09-05' })).toBeGreaterThan(0);
  });

  it('aliases and memo codes are unique per workspace', () => {
    const db = memoryDb();
    const a = insertAccount(db);
    const m1 = insertMember(db, a, 'One');
    const m2 = insertMember(db, a, 'Two');
    const alias = db.prepare(`INSERT INTO member_aliases (account_id, member_id, kind, value, created_at) VALUES (?, ?, 'name', 'ann', ?)`);
    alias.run(a, m1, T);
    expect(() => alias.run(a, m2, T)).toThrow(/UNIQUE/);
    db.prepare(`UPDATE members SET payment_memo_code = 'JS-1' WHERE id = ?`).run(m1);
    expect(() => db.prepare(`UPDATE members SET payment_memo_code = 'JS-1' WHERE id = ?`).run(m2)).toThrow(/UNIQUE/);
  });
});

describe('append-only and history protection', () => {
  it('audit_log rows cannot be updated or deleted', () => {
    const db = memoryDb();
    const a = insertAccount(db);
    const id = db.prepare(`INSERT INTO audit_log (account_id, at, actor, action, entity) VALUES (?, ?, 'system', 'test', 'member')`).run(a, T).lastInsertRowid;
    expect(() => db.prepare(`UPDATE audit_log SET action = 'edited' WHERE id = ?`).run(id)).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log WHERE id = ?').run(id)).toThrow(/append-only/);
    expect((db.prepare('SELECT action FROM audit_log WHERE id = ?').get(id) as { action: string }).action).toBe('test');
  });

  it('ledger inputs are immutable, outputs are rewritable, rows cannot be deleted', () => {
    const db = memoryDb();
    const a = insertAccount(db);
    const m = insertMember(db, a);
    const id = insertLedger(db, a, m);
    for (const sql of [
      `UPDATE ledger_entries SET amount_cents = 999 WHERE id = ?`,
      `UPDATE ledger_entries SET kind = 'payment' WHERE id = ?`,
      `UPDATE ledger_entries SET effective_at = '2020-01-01T00:00:00Z' WHERE id = ?`,
      `UPDATE ledger_entries SET set_paid_through = '2099-01-01' WHERE id = ?`,
      `UPDATE ledger_entries SET plan_amount_snapshot_cents = 1 WHERE id = ?`,
      `UPDATE ledger_entries SET member_id = member_id WHERE id = ?`,
      `UPDATE ledger_entries SET note = 'rewritten' WHERE id = ?`,
    ]) {
      expect(() => db.prepare(sql).run(id), sql).toThrow(/immutable/);
    }
    expect(() => db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(id)).toThrow(/append-only/);
    // The replay routine may rewrite outputs.
    db.prepare(`UPDATE ledger_entries SET periods_applied = 1, days_delta = 30, paid_through_after = '2026-02-01', credit_after_cents = 0 WHERE id = ?`).run(id);
  });

  it('a void must name the entry it reverses, and an entry can be reversed only once', () => {
    const db = memoryDb();
    const a = insertAccount(db);
    const m = insertMember(db, a);
    const id = insertLedger(db, a, m);
    expect(() => insertLedger(db, a, m, { kind: 'void', set_paid_through: null })).toThrow(/CHECK/);
    insertLedger(db, a, m, { kind: 'void', set_paid_through: null, reverses_entry_id: id });
    expect(() => insertLedger(db, a, m, { kind: 'void', set_paid_through: null, reverses_entry_id: id })).toThrow(/UNIQUE/);
  });

  it('payments are never deleted', () => {
    const db = memoryDb();
    const id = insertPayment(db, insertAccount(db));
    expect(() => db.prepare('DELETE FROM payments WHERE id = ?').run(id)).toThrow(/never deleted/);
  });

  it('a member with payments or ledger history cannot be hard-deleted; one without history can', () => {
    const db = memoryDb();
    const a = insertAccount(db);
    const withPayment = insertMember(db, a, 'Has payment');
    const withLedger = insertMember(db, a, 'Has ledger');
    const fresh = insertMember(db, a, 'No history');
    insertPayment(db, a, { member_id: withPayment });
    insertLedger(db, a, withLedger);
    db.prepare(`INSERT INTO member_aliases (account_id, member_id, kind, value, created_at) VALUES (?, ?, 'name', 'fresh', ?)`).run(a, fresh, T);
    const queued = db
      .prepare(`INSERT INTO email_queue (account_id, kind, member_id, to_address, subject, html, text, created_at) VALUES (?, 'reminder', ?, 'x@example.com', 's', 'h', 't', ?)`)
      .run(a, fresh, T).lastInsertRowid;

    expect(() => db.prepare('DELETE FROM members WHERE id = ?').run(withPayment)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare('DELETE FROM members WHERE id = ?').run(withLedger)).toThrow(/FOREIGN KEY/);
    expect(db.prepare('DELETE FROM members WHERE id = ?').run(fresh).changes).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM member_aliases').get()).toEqual({ n: 0 });
    // The email that was already queued/sent stays as a record, detached from the member.
    expect(db.prepare('SELECT member_id FROM email_queue WHERE id = ?').get(queued)).toEqual({ member_id: null });
  });

  it('deleting a matching rule keeps the payments it matched', () => {
    const db = memoryDb();
    const a = insertAccount(db);
    const m = insertMember(db, a);
    const rule = db
      .prepare(`INSERT INTO matching_rules (account_id, member_id, label, memo_mode, memo_value, created_at, updated_at) VALUES (?, ?, 'memo', 'contains', 'JS-1', ?, ?)`)
      .run(a, m, T, T).lastInsertRowid;
    const p = insertPayment(db, a, { member_id: m, matched_by: 'rule', matched_rule_id: rule });
    db.prepare('DELETE FROM matching_rules WHERE id = ?').run(rule);
    expect(db.prepare('SELECT matched_rule_id, matched_by FROM payments WHERE id = ?').get(p)).toEqual({ matched_rule_id: null, matched_by: 'rule' });
  });
});
