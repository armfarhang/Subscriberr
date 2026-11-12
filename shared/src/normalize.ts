// Name/email normalization used for aliases, shared-name detection and (in M5) payment matching.
// Spec §7.4: case-insensitive, trimmed, whitespace collapsed, diacritics stripped.

/** "  JOSÉ   Example " → "jose example". */
export function normalizeName(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Email addresses compare case-insensitively after trimming. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/** Memo codes compare like names, but whitespace is removed entirely ("JS - 1" ≈ "js-1"). */
export function normalizeMemoCode(input: string): string {
  return normalizeName(input).replace(/\s/g, '');
}
