import type { GmailStatus, MemberStatus } from '../enums.js';
import type { EmailQueueStatus } from './email.js';
import type { ScanState } from './payments.js';

// Dashboard (Spec §13.1 #2): one call with everything the landing page shows.

export interface DueSoonMember {
  id: number;
  displayName: string;
  paidThrough: string;
  dueInDays: number;
}

export interface Dashboard {
  today: string;
  counts: Record<MemberStatus, number> & { dueSoon: number };
  /** Members whose paid-through date falls within `dueSoonDays` (today included), soonest first. */
  dueSoon: DueSoonMember[];
  dueSoonDays: number;
  /** Payments credited to a member this calendar month (workspace timezone). */
  paymentsThisMonth: { count: number; totalCents: number; currency: string };
  reviewQueue: number;
  awaitingDeposit: number;
  gmail: { status: GmailStatus; scan: ScanState };
  emailQueue: EmailQueueStatus;
}

/** A job of the in-process scheduler, with its latest run (System page). */
export interface JobInfo {
  name: string;
  schedule: string | null;
  lastRun: { id: number; startedAt: string; finishedAt: string | null; status: 'running' | 'ok' | 'error'; error: string | null; stats: Record<string, unknown> | null } | null;
  lastError: { startedAt: string; error: string } | null;
}

/** One structured log line kept in memory for the System page. */
export interface LogLine {
  time: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields: Record<string, unknown>;
}
