// Day-math helpers. Calendar dates are date-only strings (YYYY-MM-DD); instants are UTC ISO-8601
// strings with second precision (2026-07-01T14:03:00Z). Spec §6.0.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function toEpochDay(date: string): number {
  if (!isIsoDate(date)) throw new Error(`Invalid date: ${date}`);
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function fromEpochDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromEpochDay(toEpochDay(date) + days);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function diffDays(from: string, to: string): number {
  return toEpochDay(to) - toEpochDay(from);
}

/** UTC instant with second precision, e.g. 2026-07-01T14:03:00Z. */
export function toUtcIso(instant: Date): string {
  return `${instant.toISOString().slice(0, 19)}Z`;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of an instant in an IANA timezone. */
export function localParts(instant: Date | string, timeZone: string): LocalParts {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 0,
    day: out.day ?? 0,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Calendar date (YYYY-MM-DD) of an instant in an IANA timezone. */
export function localDate(instant: Date | string, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** ISO weekday of an epoch day: Mon=1..Sun=7 (1970-01-01 was a Thursday). */
function isoWeekday(day: number): number {
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

/** ISO-8601 week key of a calendar date, e.g. "2026-W46". */
export function isoWeekKey(date: string): string {
  const day = toEpochDay(date);
  const thursday = day - isoWeekday(day) + 4;
  const year = Number(fromEpochDay(thursday).slice(0, 4));
  const jan1 = toEpochDay(`${pad(year, 4)}-01-01`);
  const week = Math.floor((thursday - jan1) / 7) + 1;
  return `${pad(year, 4)}-W${pad(week)}`;
}

/** Monday (YYYY-MM-DD) of the ISO week containing `date`. */
export function isoWeekStart(date: string): string {
  const day = toEpochDay(date);
  return fromEpochDay(day - isoWeekday(day) + 1);
}

/** Calendar month key, e.g. "2026-11". */
export function monthKey(date: string): string {
  if (!isIsoDate(date)) throw new Error(`Invalid date: ${date}`);
  return date.slice(0, 7);
}

/** Month key shifted by `months` (negative = earlier). */
export function shiftMonthKey(key: string, months: number): string {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const total = year * 12 + (month - 1) + months;
  return `${pad(Math.floor(total / 12), 4)}-${pad((total % 12) + 1)}`;
}
