import {
  DEFAULT_MEMBER_DEFAULTS,
  memberDefaultsSchema,
  type MemberDefaults,
  type UpdateWorkspaceSettings,
  type WorkspaceSettings,
} from '@subscriberr/shared';
import { z } from 'zod';
import { writeAudit } from '../../core/audit.js';
import { badRequest } from '../../core/errors.js';
import type { Clock } from '../../core/time.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';

// Workspace settings live in `settings` (account_id, key, JSON value), always scoped by the
// workspace context. The timezone is the one exception: it is a column on `accounts`, so there
// is a single source of truth for it.

const KEYS = {
  etransferEmail: 'etransfer_email',
  etransferInstructions: 'etransfer_instructions',
  memberDefaults: 'member_defaults',
  onboardingCompleted: 'onboarding_completed',
} as const;

function readRaw(ws: WorkspaceContext): Map<string, unknown> {
  const rows = ws.sqlite.prepare('SELECT key, value FROM settings WHERE account_id = ?').all(ws.accountId) as Array<{ key: string; value: string }>;
  return new Map(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
}

function parseOr<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

export function getWorkspaceSettings(ws: WorkspaceContext): WorkspaceSettings {
  const raw = readRaw(ws);
  const account = ws.sqlite.prepare('SELECT timezone FROM accounts WHERE id = ?').get(ws.accountId) as { timezone: string } | undefined;
  if (!account) throw new Error(`Workspace ${ws.accountId} does not exist`);
  return {
    timezone: account.timezone,
    etransferEmail: parseOr(z.string().nullable(), raw.get(KEYS.etransferEmail), null),
    etransferInstructions: parseOr(z.string(), raw.get(KEYS.etransferInstructions), ''),
    memberDefaults: { ...DEFAULT_MEMBER_DEFAULTS, ...parseOr(memberDefaultsSchema.partial(), raw.get(KEYS.memberDefaults), {}) } as MemberDefaults,
    onboardingCompleted: parseOr(z.boolean(), raw.get(KEYS.onboardingCompleted), false),
  };
}

function put(ws: WorkspaceContext, key: string, value: unknown): void {
  ws.sqlite
    .prepare('INSERT INTO settings (account_id, key, value) VALUES (?, ?, ?) ON CONFLICT (account_id, key) DO UPDATE SET value = excluded.value')
    .run(ws.accountId, key, JSON.stringify(value));
}

/** Applies a validated patch in one transaction and audit-logs which fields changed. */
export function updateWorkspaceSettings(ws: WorkspaceContext, clock: Clock, actor: string, patch: UpdateWorkspaceSettings): WorkspaceSettings {
  const before = getWorkspaceSettings(ws);
  ws.sqlite.transaction(() => {
    if (patch.timezone !== undefined) ws.sqlite.prepare('UPDATE accounts SET timezone = ? WHERE id = ?').run(patch.timezone, ws.accountId);
    if (patch.etransferEmail !== undefined) put(ws, KEYS.etransferEmail, patch.etransferEmail);
    if (patch.etransferInstructions !== undefined) put(ws, KEYS.etransferInstructions, patch.etransferInstructions);
    if (patch.memberDefaults !== undefined) put(ws, KEYS.memberDefaults, patch.memberDefaults);
    const changed = Object.keys(patch).filter((k) => JSON.stringify(patch[k as keyof UpdateWorkspaceSettings]) !== JSON.stringify(before[k as keyof WorkspaceSettings]));
    if (changed.length > 0) writeAudit(ws, clock, { actor, action: 'settings.updated', entity: 'workspace', entityId: ws.accountId, details: { fields: changed } });
  })();
  return getWorkspaceSettings(ws);
}

/** What the first-run wizard must have collected before the workspace is usable. */
export function missingForOnboarding(settings: WorkspaceSettings): string[] {
  const missing: string[] = [];
  if (!settings.etransferEmail) missing.push('etransferEmail');
  if (settings.memberDefaults.planAmountCents === null) missing.push('memberDefaults.planAmountCents');
  return missing;
}

export function completeOnboarding(ws: WorkspaceContext, clock: Clock, actor: string): WorkspaceSettings {
  const settings = getWorkspaceSettings(ws);
  const missing = missingForOnboarding(settings);
  if (missing.length > 0) throw badRequest('Finish the setup steps first', { missing });
  ws.sqlite.transaction(() => {
    put(ws, KEYS.onboardingCompleted, true);
    writeAudit(ws, clock, { actor, action: 'onboarding.completed', entity: 'workspace', entityId: ws.accountId });
  })();
  return getWorkspaceSettings(ws);
}

/** Raw JSON setting of this workspace (for module-owned keys such as import mapping presets). */
export function readJsonSetting(ws: WorkspaceContext, key: string): unknown {
  return readRaw(ws).get(key);
}

export function writeJsonSetting(ws: WorkspaceContext, key: string, value: unknown): void {
  put(ws, key, value);
}
