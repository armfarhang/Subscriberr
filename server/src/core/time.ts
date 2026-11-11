import { localDate, toUtcIso } from '@subscriberr/shared';

/** Injectable clock. Nothing outside this file calls `new Date()` / `Date.now()` for business time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Mutable clock for tests and simulated-date scenarios. */
export class FakeClock implements Clock {
  private current: Date;
  constructor(start: string | Date = '2026-01-01T12:00:00Z') {
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  set(instant: string | Date): void {
    this.current = new Date(instant);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  advanceDays(days: number): void {
    this.advanceMs(days * 86_400_000);
  }
}

/** Current instant as a UTC ISO string with second precision (DB timestamp format). */
export function nowIso(clock: Clock): string {
  return toUtcIso(clock.now());
}

/** Today's calendar date in the given timezone. */
export function today(clock: Clock, timeZone: string): string {
  return localDate(clock.now(), timeZone);
}
