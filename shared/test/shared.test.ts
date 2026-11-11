import { describe, expect, it } from 'vitest';
import {
  addDays,
  centsToDecimal,
  diffDays,
  formatCents,
  isIsoDate,
  isoWeekKey,
  isoWeekStart,
  localDate,
  parseMoneyToCents,
  shiftMonthKey,
  toUtcIso,
} from '../src/index.js';

describe('money', () => {
  it('parses decimal dollars into integer cents', () => {
    expect(parseMoneyToCents('15')).toBe(1500);
    expect(parseMoneyToCents('15.5')).toBe(1550);
    expect(parseMoneyToCents('$1,234.56')).toBe(123456);
    expect(parseMoneyToCents('0.07')).toBe(7);
    expect(parseMoneyToCents('-2.00')).toBe(-200);
  });
  it('rejects anything that is not a plain amount', () => {
    for (const bad of ['', 'abc', '1.234', '1e3', '15.', '.5']) expect(parseMoneyToCents(bad)).toBeNull();
  });
  it('formats cents', () => {
    expect(centsToDecimal(1500)).toBe('15.00');
    expect(centsToDecimal(-5)).toBe('-0.05');
    expect(formatCents(123456)).toBe('$1,234.56');
  });
});

describe('dates', () => {
  it('validates ISO dates', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-2-3')).toBe(false);
  });
  it('adds and diffs days across month, year and DST boundaries', () => {
    expect(addDays('2026-01-31', 30)).toBe('2026-03-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(diffDays('2026-01-01', '2026-12-31')).toBe(364);
    expect(diffDays('2026-03-02', '2026-01-31')).toBe(-30);
  });
  it('converts instants to a local calendar date', () => {
    expect(localDate('2026-07-01T03:30:00Z', 'America/Toronto')).toBe('2026-06-30');
    expect(localDate('2026-07-01T04:00:00Z', 'America/Toronto')).toBe('2026-07-01');
    expect(toUtcIso(new Date('2026-07-01T14:03:00.123Z'))).toBe('2026-07-01T14:03:00Z');
  });
  it('computes ISO weeks', () => {
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01');
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
    expect(isoWeekKey('2024-12-30')).toBe('2025-W01');
    expect(isoWeekKey('2026-11-11')).toBe('2026-W46');
    expect(isoWeekStart('2026-11-11')).toBe('2026-11-09');
  });
  it('shifts month keys', () => {
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(shiftMonthKey('2026-11', -5)).toBe('2026-06');
    expect(shiftMonthKey('2026-12', 1)).toBe('2027-01');
  });
});
