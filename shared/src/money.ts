// Integer-cents helpers. Money is never a float anywhere in the app (Spec §6.0).

/** Parses "15", "15.5", "$1,234.50" into integer cents. Returns null when not a valid amount. */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, '').replace(/,/g, '');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '').padEnd(2, '0'));
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents)) return null;
  return m[1] === '-' ? -cents : cents;
}

/** 1500 -> "15.00" (decimal dollars, as used in CSV). */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 1500 -> "$15.00" for display. */
export function formatCents(cents: number, currency = 'CAD'): string {
  const body = centsToDecimal(Math.abs(cents)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const prefix = currency === 'CAD' || currency === 'USD' ? '$' : `${currency} `;
  return `${cents < 0 ? '-' : ''}${prefix}${body}`;
}
