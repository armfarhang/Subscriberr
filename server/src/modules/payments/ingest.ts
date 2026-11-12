import { normalizeEmail, type RescanResult, type ScanState, type ScanStats } from '@subscriberr/shared';
import { writeAudit } from '../../core/audit.js';
import { conflict } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { type Clock, nowIso } from '../../core/time.js';
import type { WorkspaceContext } from '../../core/workspace-context.js';
import { isInvalidGrant } from '../auth/google.js';
import { type GmailClient, LABEL_NEEDS_REVIEW, LABEL_PROCESSED } from '../gmail/client.js';
import type { GmailClientFactory } from '../gmail/factory.js';
import { markGmailDisconnected } from '../gmail/tokens.js';
import { addAlias } from '../members/aliases.js';
import { matchDirectory, ruleInputs } from '../members/directory.js';
import { getWorkspaceSettings } from '../workspaces/settings.js';
import { parseEmail } from './interac/email.js';
import { type Analysis, analyzeEmail } from './interac/parse.js';
import { type MatchDecision, type MatchMember, matchPayment } from './matching/matcher.js';
import type { RuleInput } from './matching/rules.js';
import type { PaymentSnapshot } from './store.js';

// The only impure glue of the e-Transfer pipeline (Spec §4.1): scan → parse → authenticate →
// match → persist (one transaction per message) → label. Idempotent: payments are keyed on the
// Gmail message id and the Interac reference (§7.6), so rescans are no-ops for known mail.

export interface IngestDeps {
  clock: Clock;
  log: Logger;
  gmail: GmailClientFactory;
  /**
   * Called inside the payment's transaction for every newly stored payment, so the billing
   * module can apply it (Milestone 6). Optional: without it, matched payments wait as `matched`.
   */
  onStored?: (ws: WorkspaceContext, paymentId: number, opts: { rescan: boolean; receivedAt: string }) => void;
}

const emptyStats = (): ScanStats => ({ messages: 0, known: 0, ignored: 0, stored: 0, matched: 0, review: 0, pendingDeposit: 0, duplicate: 0, rejected: 0, errors: 0 });

interface Plan {
  status: 'matched' | 'unmatched' | 'needs_review' | 'pending_deposit' | 'duplicate' | 'rejected';
  memberId: number | null;
  matchedBy: MatchDecision['matchedBy'];
  ruleId: number | null;
  reason: string | null;
  proposal: MatchDecision['proposal'];
  learnEmail: string | null;
}

/** Decides what a message becomes. Pure apart from the reads passed in. */
export function planPayment(
  analysis: Analysis,
  directory: MatchMember[],
  rules: RuleInput[],
  opts: { duplicateOf: number | null; reviewNewEmail: boolean; memberCurrency: (id: number) => string | null },
): Plan {
  const f = analysis.fields;
  const plan: Plan = { status: 'needs_review', memberId: null, matchedBy: null, ruleId: null, reason: analysis.reason, proposal: null, learnEmail: null };
  if (analysis.verdict === 'rejected') return { ...plan, status: 'rejected' };
  if (opts.duplicateOf !== null) return { ...plan, status: 'duplicate', reason: `Duplicate of payment #${opts.duplicateOf} (same Interac reference ${f.reference})` };

  const decision = matchPayment({ senderName: f.senderName, senderEmail: f.senderEmail, memo: f.memo, amountCents: f.amountCents }, directory, rules);
  if (analysis.verdict === 'needs_review') {
    // Keep the matcher's opinion as a suggestion only.
    const suggestion = decision.memberId !== null ? { memberId: decision.memberId, score: 1 } : decision.proposal;
    return { ...plan, status: f.kind === 'awaiting_deposit' ? 'pending_deposit' : 'needs_review', proposal: suggestion, reason: analysis.reason };
  }

  let status: Plan['status'] = decision.status;
  let reason = decision.reason;
  if (decision.status === 'matched' && decision.memberId !== null) {
    const currency = f.currency ?? 'CAD';
    if (currency !== 'CAD' && opts.memberCurrency(decision.memberId) !== currency) {
      status = 'needs_review';
      reason = `Paid in ${currency}, which is not this member's currency`;
    }
    // Learning sender emails (§7.4): a name match from a Reply-To the member does not have yet.
    const email = f.senderEmail ? normalizeEmail(f.senderEmail) : null;
    const m = directory.find((d) => d.id === decision.memberId)!;
    const known = email ? (m.email && normalizeEmail(m.email) === email) || m.emailAliases.includes(email) : true;
    const ownedByOther = email ? directory.some((d) => d.id !== m.id && ((d.email && normalizeEmail(d.email) === email) || d.emailAliases.includes(email))) : false;
    if (status === 'matched' && email && !known && !ownedByOther && decision.matchedBy === 'name') {
      if (opts.reviewNewEmail) {
        status = 'needs_review';
        reason = `Known name from a new email (${email})`;
      } else plan.learnEmail = email;
    }
  }
  if (f.kind === 'awaiting_deposit') {
    // Pending transfers never extend access by themselves (§8.4); the match is kept for later.
    return { ...plan, status: 'pending_deposit', memberId: status === 'matched' ? decision.memberId : null, matchedBy: status === 'matched' ? decision.matchedBy : null, ruleId: decision.ruleId, reason: status === 'matched' ? null : reason, proposal: decision.proposal };
  }
  if (status === 'matched') return { ...plan, status, memberId: decision.memberId, matchedBy: decision.matchedBy, ruleId: decision.ruleId, reason: null, proposal: null };
  // Anything that is not a clean match keeps the member only as a suggestion for the reviewer.
  const suggestion = decision.memberId !== null ? { memberId: decision.memberId, score: 1 } : decision.proposal;
  return { ...plan, status, memberId: null, matchedBy: null, ruleId: decision.ruleId, reason, proposal: suggestion, learnEmail: null };
}

const running = new Set<number>();

export function getScanState(ws: WorkspaceContext): ScanState {
  const row = ws.sqlite.prepare('SELECT last_scan_at, last_success_at, last_error FROM gmail_scan_state WHERE account_id = ?').get(ws.accountId) as
    | { last_scan_at: string | null; last_success_at: string | null; last_error: string | null }
    | undefined;
  return { lastScanAt: row?.last_scan_at ?? null, lastSuccessAt: row?.last_success_at ?? null, lastError: row?.last_error ?? null, running: running.has(ws.accountId) };
}

function saveScanState(ws: WorkspaceContext, at: string, ok: boolean, error: string | null) {
  ws.sqlite
    .prepare(
      `INSERT INTO gmail_scan_state (account_id, last_scan_at, last_success_at, last_error) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET last_scan_at = excluded.last_scan_at, last_success_at = COALESCE(excluded.last_success_at, gmail_scan_state.last_success_at), last_error = excluded.last_error`,
    )
    .run(ws.accountId, at, ok ? at : null, error);
}

interface RunOptions {
  /** Rescan from date: ignore the Processed label (§6.9 layer 4). */
  rescan?: { since: Date };
  dryRun?: boolean;
}

/** One scan of a workspace's mailbox. Single-flight per workspace. */
export async function scanMailbox(ws: WorkspaceContext, deps: IngestDeps, opts: RunOptions = {}): Promise<RescanResult> {
  if (running.has(ws.accountId)) throw conflict('A mailbox scan is already running for this workspace.');
  running.add(ws.accountId);
  const startedAt = nowIso(deps.clock);
  const stats = emptyStats();
  const preview: RescanResult['preview'] = [];
  try {
    const settings = getWorkspaceSettings(ws);
    const state = getScanState(ws);
    let gmail: GmailClient;
    try {
      gmail = await deps.gmail(ws.accountId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!opts.dryRun) saveScanState(ws, startedAt, false, message);
      throw err;
    }
    const lookback = new Date(deps.clock.now().getTime() - settings.scanning.initialLookbackDays * 86_400_000);
    // A day of overlap: Gmail's "after:" is coarse and late-arriving mail must not be missed.
    const after = opts.rescan ? opts.rescan.since : state.lastSuccessAt ? new Date(Date.parse(state.lastSuccessAt) - 86_400_000) : lookback;
    let refs;
    try {
      refs = await gmail.listMessages({ from: settings.scanning.senders, withoutLabel: opts.rescan ? undefined : LABEL_PROCESSED, after });
    } catch (err) {
      if (isInvalidGrant(err)) markGmailDisconnected(ws, deps.clock, 'invalid_grant while scanning');
      throw err;
    }
    stats.messages = refs.length;

    const knownIds = new Set(
      (ws.sqlite.prepare('SELECT gmail_message_id FROM payments WHERE account_id = ? AND gmail_message_id IS NOT NULL').all(ws.accountId) as Array<{ gmail_message_id: string }>).map((r) => r.gmail_message_id),
    );
    const directory = matchDirectory(ws);
    const rules = ruleInputs(ws);
    const names = new Map(directory.map((m) => [m.id, m.displayName]));
    const currencies = new Map((ws.sqlite.prepare('SELECT id, currency FROM members WHERE account_id = ?').all(ws.accountId) as Array<{ id: number; currency: string }>).map((r) => [r.id, r.currency]));
    const seenRefs = new Map<string, number>();

    for (const ref of refs) {
      if (knownIds.has(ref.id)) {
        stats.known++;
        continue;
      }
      try {
        const message = await gmail.getMessage(ref.id);
        const analysis = analyzeEmail(await parseEmail(message.raw), { allowedSenders: settings.scanning.senders });
        if (analysis.verdict === 'ignored') {
          stats.ignored++;
          continue;
        }
        const f = analysis.fields;
        const existing = f.reference
          ? ((ws.sqlite.prepare(`SELECT id FROM payments WHERE account_id = ? AND interac_reference = ? AND status <> 'duplicate'`).get(ws.accountId, f.reference) as { id: number } | undefined)?.id ??
            (opts.dryRun ? (seenRefs.get(f.reference) ?? null) : null))
          : null;
        const plan = planPayment(analysis, directory, rules, { duplicateOf: existing, reviewNewEmail: settings.scanning.reviewNewEmailForKnownName, memberCurrency: (id) => currencies.get(id) ?? null });
        const receivedAt = f.receivedAt ?? nowIso({ now: () => message.internalDate });
        if (f.reference) seenRefs.set(f.reference, -1);
        stats.stored++;
        if (plan.status === 'matched') stats.matched++;
        else if (plan.status === 'pending_deposit') stats.pendingDeposit++;
        else if (plan.status === 'duplicate') stats.duplicate++;
        else if (plan.status === 'rejected') stats.rejected++;
        else stats.review++;
        if (opts.dryRun) {
          preview.push({ receivedAt, senderName: f.senderName, amountCents: f.amountCents, status: plan.status, memberName: plan.memberId ? (names.get(plan.memberId) ?? null) : null });
          continue;
        }

        const snapshot: PaymentSnapshot = {
          kind: f.kind,
          verdict: analysis.verdict,
          reason: analysis.reason,
          auth: { ok: analysis.auth.ok, reason: analysis.auth.reason, dkim: analysis.auth.dkim, dkimDomain: analysis.auth.dkimDomain, dmarc: analysis.auth.dmarc },
          proposal: plan.proposal,
        };
        const messageType = f.kind === 'awaiting_deposit' ? 'awaiting_deposit' : 'autodeposit';
        ws.sqlite.transaction(() => {
          const id = Number(
            ws.sqlite
              .prepare(
                `INSERT INTO payments (account_id, member_id, amount_cents, currency, received_at, sender_name, sender_email, interac_reference, gmail_message_id, gmail_thread_id,
                   memo, message_type, expires_on, status, matched_by, matched_rule_id, review_reason, source, raw_snapshot, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gmail', ?, ?)`,
              )
              .run(
                ws.accountId,
                plan.memberId,
                f.amountCents,
                f.currency ?? 'CAD',
                receivedAt,
                f.senderName,
                f.senderEmail,
                f.reference,
                message.id,
                message.threadId,
                // The memo is stored for auto-deposits only: awaiting-deposit memos can hold security-answer hints (§7.2).
                messageType === 'autodeposit' ? f.memo : null,
                messageType,
                messageType === 'awaiting_deposit' ? f.expiresOn : null,
                plan.status,
                plan.matchedBy,
                plan.ruleId,
                plan.reason,
                JSON.stringify(snapshot),
                nowIso(deps.clock),
              ).lastInsertRowid,
          );
          if (plan.learnEmail && plan.memberId) {
            addAlias(ws, deps.clock, 'system', plan.memberId, { kind: 'email', value: plan.learnEmail }, 'learned');
            const m = directory.find((d) => d.id === plan.memberId);
            m?.emailAliases.push(plan.learnEmail);
          }
          if (plan.memberId && plan.status !== 'needs_review') {
            writeAudit(ws, deps.clock, { actor: 'system', action: 'payment.received', entity: 'member', entityId: plan.memberId, details: { paymentId: id, amountCents: f.amountCents, status: plan.status, matchedBy: plan.matchedBy } });
          }
          deps.onStored?.(ws, id, { rescan: Boolean(opts.rescan), receivedAt });
        })();

        // Labels after the commit; a labelling failure never loses the payment (the id is known now).
        try {
          await gmail.addLabel(message.id, LABEL_PROCESSED);
          if (['needs_review', 'unmatched', 'rejected', 'duplicate'].includes(plan.status)) await gmail.addLabel(message.id, LABEL_NEEDS_REVIEW);
        } catch (err) {
          deps.log.warn('could not label message', { accountId: ws.accountId, messageId: message.id, err });
        }
      } catch (err) {
        if (isInvalidGrant(err)) {
          markGmailDisconnected(ws, deps.clock, 'invalid_grant while scanning');
          throw err;
        }
        stats.errors++;
        deps.log.error('could not process message', { accountId: ws.accountId, messageId: ref.id, err });
      }
    }
    if (!opts.dryRun) saveScanState(ws, startedAt, stats.errors === 0, stats.errors > 0 ? `${stats.errors} message(s) could not be processed` : null);
    if (opts.rescan && !opts.dryRun) writeAudit(ws, deps.clock, { actor: 'system', action: 'gmail.rescan', entity: 'workspace', entityId: ws.accountId, details: { since: opts.rescan.since.toISOString(), ...stats } });
    return { dryRun: Boolean(opts.dryRun), since: (opts.rescan?.since ?? after).toISOString().slice(0, 10), stats, preview };
  } finally {
    running.delete(ws.accountId);
  }
}
