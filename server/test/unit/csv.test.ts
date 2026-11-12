import { describe, expect, it } from 'vitest';
import { replayLedger } from '../../src/modules/billing/engine.js';
import { decodeCsvBytes, detectDelimiter, guardCell, headerKey, parseCsv, serializeCsv, unguardCell } from '../../src/modules/csv/csv.js';
import { autoMap, blankMeaning, parseCell } from '../../src/modules/csv/fields.js';

const bytes = (...parts: Array<number[] | string>) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'utf8')] : p)));

describe('CSV decoding (Spec §12.2 step 1)', () => {
  it('reads UTF-8 with and without BOM', () => {
    expect(decodeCsvBytes(bytes([0xef, 0xbb, 0xbf], 'name\nJosé'))).toEqual({ text: 'name\nJosé', encoding: 'utf-8' });
    expect(decodeCsvBytes(bytes('name\nZoë'))).toEqual({ text: 'name\nZoë', encoding: 'utf-8' });
  });
  it('falls back to Windows-1252 for bytes that are not UTF-8', () => {
    // "José" in Windows-1252: é = 0xE9 (an invalid lone byte in UTF-8)
    expect(decodeCsvBytes(bytes('name\nJos', [0xe9]))).toEqual({ text: 'name\nJosé', encoding: 'windows-1252' });
    expect(decodeCsvBytes(bytes('price\n', [0x80], '5')).text).toBe('price\n€5');
  });
  it('reads UTF-16LE with BOM (Excel "Unicode text")', () => {
    const b = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\tb\nÀ\t2', 'utf16le')]);
    expect(decodeCsvBytes(new Uint8Array(b))).toEqual({ text: 'a\tb\nÀ\t2', encoding: 'utf-16le' });
  });
  it('detects comma, semicolon and tab delimiters from the header line', () => {
    expect(detectDelimiter('a,b,c\n1;2;3;4;5')).toBe(',');
    expect(detectDelimiter('a;b;c\n1,2')).toBe(';');
    expect(detectDelimiter('a\tb\n1,2')).toBe('\t');
    expect(detectDelimiter('"x,y";b;c\n')).toBe(';'); // commas inside quotes do not count
    expect(detectDelimiter('single')).toBe(',');
  });
});

describe('RFC 4180 parsing', () => {
  it('handles quotes, escaped quotes, delimiters and newlines inside fields, and all line endings', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\rlast,1', ',')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', 'z'],
      ['last', '1'],
    ]);
  });
  it('keeps empty cells, drops blank lines and handles a missing final newline', () => {
    expect(parseCsv('a,b,c\n\n1,,3\n,,\n', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
      ['', '', ''],
    ]);
  });
  it('refuses an unterminated quote', () => {
    expect(() => parseCsv('a\n"open', ',')).toThrow(/quoted field/);
  });
});

describe('CSV export encoding (Spec §12.1)', () => {
  it('adds a BOM, quotes when needed and guards formulas', () => {
    const out = serializeCsv([
      ['name', 'note'],
      ['=SUM(A1)', 'a,b'],
      ['+1', '-2'],
      ['@cmd', 'say "x"'],
      ['\tTAB', 'ok'],
    ]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toBe(`name,note\r\n'=SUM(A1),"a,b"\r\n'+1,'-2\r\n'@cmd,"say ""x"""\r\n'\tTAB,ok\r\n`);
  });
  it('round-trips through the parser, removing the guard again', () => {
    const rows = [['id', 'notes'], ['1', '=not a formula, really'], ['2', 'line1\nline2']];
    const parsed = parseCsv(serializeCsv(rows).slice(1), ',').map((r) => r.map(unguardCell));
    expect(parsed).toEqual(rows);
    expect(guardCell('safe')).toBe('safe');
    expect(unguardCell("'plain")).toBe("'plain"); // only a guarded formula character is unwrapped
  });
});

describe('field parsing and mapping', () => {
  it('normalizes money, dates, booleans, enums and periods', () => {
    expect(parseCell('plan_amount', ' $1,234.5 ')).toEqual({ value: '1234.50' });
    expect(parseCell('plan_amount', '0')).toMatchObject({ value: null, error: expect.any(String) });
    expect(parseCell('credit', '0')).toEqual({ value: '0.00' });
    expect(parseCell('credit', '-1')).toMatchObject({ error: expect.any(String) });
    expect(parseCell('paid_through', '2026/12/1')).toEqual({ value: '2026-12-01' });
    expect(parseCell('paid_through', '01/12/2026')).toMatchObject({ error: expect.stringMatching(/YYYY-MM-DD/) });
    expect(parseCell('paid_through', '2026-02-30')).toMatchObject({ error: expect.any(String) });
    expect(parseCell('reminders_enabled', 'Yes')).toEqual({ value: 'true' });
    expect(parseCell('emails_enabled', 'off')).toEqual({ value: 'false' });
    expect(parseCell('emails_enabled', 'maybe')).toMatchObject({ error: expect.any(String) });
    expect(parseCell('status', 'Grace Period')).toEqual({ value: 'grace' });
    expect(parseCell('status', 'gone')).toMatchObject({ error: expect.any(String) });
    expect(parseCell('plan_period_days', 'Yearly')).toEqual({ value: '365' });
    expect(parseCell('plan_period_days', '0')).toMatchObject({ error: expect.any(String) });
    expect(parseCell('currency', 'cad')).toEqual({ value: 'CAD' });
    expect(parseCell('email', ' Ann@Example.COM ')).toEqual({ value: 'ann@example.com' });
    expect(parseCell('email', 'nope')).toMatchObject({ error: expect.any(String) });
    expect(parseCell('aliases', ' ANN S | Ann.Work@Example.com || ann s ')).toEqual({ value: 'ann.work@example.com|ann s' });
    expect(parseCell('aliases', 'bad@')).toMatchObject({ error: expect.any(String) });
    expect(parseCell('payment_memo_code', 'JS-1')).toEqual({ value: 'JS-1' });
    expect(parseCell('notes', '   ')).toEqual({ value: null });
  });
  it('knows what a blank cell means for each field', () => {
    expect(blankMeaning('plan_amount')).toBe('inherit');
    expect(blankMeaning('email')).toBe('clear');
    expect(['paid_through', 'credit', 'status', 'display_name', 'aliases', 'server:Plex'].map(blankMeaning)).toEqual(['keep', 'keep', 'keep', 'keep', 'keep', 'keep']);
  });
  it('auto-maps exact names, synonyms and server columns, each field once', () => {
    expect(headerKey('E-Transfer Name ')).toBe('e_transfer_name');
    expect(autoMap(['Name', 'E-mail', 'Payer', 'Amount', 'Due date', 'Name', 'server:Demo Plex', 'Shoe size'], ['Demo Plex'])).toEqual([
      'display_name',
      'email',
      'etransfer_name',
      'plan_amount',
      'paid_through',
      null,
      'server:Demo Plex',
      null,
    ]);
  });
});

describe('ledger replay (Spec §6.5a), manual_set and void', () => {
  const entry = (id: number, at: string, set: { pt?: string; credit?: number }, kind: 'manual_set' | 'void' = 'manual_set', reverses: number | null = null) => ({
    id,
    kind,
    effectiveAt: at,
    reversesEntryId: reverses,
    setPaidThrough: set.pt ?? null,
    setCreditCents: set.credit ?? null,
  });
  it('applies absolute values in (effective_at, id) order and leaves unset parts unchanged', () => {
    const r = replayLedger([entry(2, '2026-02-01T00:00:00Z', { credit: 500 }), entry(1, '2026-01-01T00:00:00Z', { pt: '2026-03-01' })]);
    expect(r.final).toEqual({ paidThrough: '2026-03-01', creditCents: 500 });
    expect(r.outputs.get(1)).toMatchObject({ paidThroughBefore: null, paidThroughAfter: '2026-03-01', daysDelta: 0 });
    expect(r.outputs.get(2)).toMatchObject({ paidThroughBefore: '2026-03-01', paidThroughAfter: '2026-03-01', creditBeforeCents: 0, creditAfterCents: 500, creditDeltaCents: 500 });
  });
  it('a voided entry is as if it never happened', () => {
    const r = replayLedger([
      entry(1, '2026-01-01T00:00:00Z', { pt: '2026-03-01' }),
      entry(2, '2026-01-02T00:00:00Z', { pt: '2026-06-01', credit: 100 }),
      entry(3, '2026-01-03T00:00:00Z', {}, 'void', 2),
    ]);
    expect(r.final).toEqual({ paidThrough: '2026-03-01', creditCents: 0 });
    expect(r.outputs.get(2)).toMatchObject({ paidThroughBefore: '2026-03-01', paidThroughAfter: '2026-03-01' });
  });
  it('refuses kinds this version cannot replay instead of guessing', () => {
    expect(() => replayLedger([{ ...entry(1, '2026-01-01T00:00:00Z', {}), kind: 'payment' }])).toThrow(/cannot replay/);
  });
});
