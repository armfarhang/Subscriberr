import { type Clock, nowIso } from './time.js';
import type { WorkspaceContext } from './workspace-context.js';

export interface AuditEvent {
  /** 'admin:<email>' or 'system' */
  actor: string;
  action: string;
  entity: string;
  entityId?: number | null;
  details?: unknown;
}

/** Appends one row to the append-only audit log of the context's workspace. */
export function writeAudit(ctx: WorkspaceContext, clock: Clock, event: AuditEvent): void {
  ctx.sqlite
    .prepare(
      `INSERT INTO audit_log (account_id, at, actor, action, entity, entity_id, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.accountId,
      nowIso(clock),
      event.actor,
      event.action,
      event.entity,
      event.entityId ?? null,
      event.details === undefined ? null : JSON.stringify(event.details),
    );
}
