import { type AddAlias, type AliasSource, type MemberAlias, normalizeEmail, normalizeName } from '@subscriberr/shared';
import { writeAudit } from '../../core/audit.js';
import { conflict, notFound } from '../../core/errors.js';
import { type Clock, nowIso } from '../../core/time.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';

// Aliases (Spec §6.2): extra names/emails a member pays from. Values are stored normalized and
// are unique per workspace, so one alias can never point at two members.

interface AliasRow {
  id: number;
  member_id: number;
  kind: 'name' | 'email';
  value: string;
  source: AliasSource;
  created_at: string;
}

const toAlias = (r: AliasRow): MemberAlias => ({ id: r.id, kind: r.kind, value: r.value, source: r.source, createdAt: r.created_at });

export function normalizeAlias(kind: 'name' | 'email', value: string): string {
  return kind === 'email' ? normalizeEmail(value) : normalizeName(value);
}

export function listAliases(ws: WorkspaceContext, memberId: number): MemberAlias[] {
  const rows = ws.sqlite
    .prepare('SELECT id, member_id, kind, value, source, created_at FROM member_aliases WHERE account_id = ? AND member_id = ? ORDER BY kind, value')
    .all(ws.accountId, memberId) as AliasRow[];
  return rows.map(toAlias);
}

export function addAlias(ws: WorkspaceContext, clock: Clock, actor: string, memberId: number, input: AddAlias, source: AliasSource = 'manual'): MemberAlias {
  const member = ws.sqlite
    .prepare('SELECT id, display_name, etransfer_name, email FROM members WHERE account_id = ? AND id = ?')
    .get(ws.accountId, memberId) as { id: number; display_name: string; etransfer_name: string | null; email: string | null } | undefined;
  if (!member) throw notFound('Member not found');

  const value = normalizeAlias(input.kind, input.value);
  const own =
    input.kind === 'email'
      ? [member.email ? normalizeEmail(member.email) : null]
      : [normalizeName(member.display_name), member.etransfer_name ? normalizeName(member.etransfer_name) : null];
  if (own.includes(value)) {
    throw conflict(input.kind === 'email' ? 'This is already the member’s email.' : 'This is already one of the member’s names.', { reason: 'redundant' });
  }

  const existing = ws.sqlite
    .prepare(
      `SELECT a.member_id, m.display_name FROM member_aliases a JOIN members m ON m.account_id = a.account_id AND m.id = a.member_id
       WHERE a.account_id = ? AND a.kind = ? AND a.value = ?`,
    )
    .get(ws.accountId, input.kind, value) as { member_id: number; display_name: string } | undefined;
  if (existing) {
    if (existing.member_id === memberId) throw conflict('This alias already exists.', { reason: 'exists' });
    throw conflict(`This alias already belongs to ${existing.display_name}.`, { reason: 'taken', memberId: existing.member_id, displayName: existing.display_name });
  }

  const at = nowIso(clock);
  const id = ws.sqlite.transaction(() => {
    const newId = Number(
      ws.sqlite
        .prepare('INSERT INTO member_aliases (account_id, member_id, kind, value, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ws.accountId, memberId, input.kind, value, source, at).lastInsertRowid,
    );
    writeAudit(ws, clock, { actor, action: 'member.alias_added', entity: 'member', entityId: memberId, details: { kind: input.kind, value, source } });
    return newId;
  })();
  return { id, kind: input.kind, value, source, createdAt: at };
}

export function removeAlias(ws: WorkspaceContext, clock: Clock, actor: string, memberId: number, aliasId: number): void {
  const row = ws.sqlite
    .prepare('SELECT id, member_id, kind, value, source, created_at FROM member_aliases WHERE account_id = ? AND member_id = ? AND id = ?')
    .get(ws.accountId, memberId, aliasId) as AliasRow | undefined;
  if (!row) throw notFound('Alias not found');
  ws.sqlite.transaction(() => {
    ws.sqlite.prepare('DELETE FROM member_aliases WHERE account_id = ? AND id = ?').run(ws.accountId, aliasId);
    writeAudit(ws, clock, { actor, action: 'member.alias_removed', entity: 'member', entityId: memberId, details: { kind: row.kind, value: row.value } });
  })();
}
