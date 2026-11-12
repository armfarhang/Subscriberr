import { csvHeaderKey } from '@subscriberr/shared';

// CSV codec (Spec §12): encoding and delimiter detection, an RFC 4180 parser and a serializer
// with the formula-injection guard. Pure: bytes/strings in, data out.

export type CsvEncoding = 'utf-8' | 'utf-16le' | 'windows-1252';
export type CsvDelimiter = ',' | ';' | '\t';

export interface DecodedText {
  text: string;
  encoding: CsvEncoding;
}

/** UTF-8 (with or without BOM), UTF-16LE with BOM (Excel "Unicode text"), else Windows-1252. */
export function decodeCsvBytes(bytes: Uint8Array): DecodedText {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(body), encoding: 'windows-1252' };
  }
}

/** Picks the delimiter that splits the header line (outside quotes) into the most columns. */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && (ch === ',' || ch === ';' || ch === '\t')) counts[ch]++;
  }
  const best = (Object.entries(counts) as Array<[CsvDelimiter, number]>).sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : ',';
}

export class CsvParseError extends Error {}

/**
 * RFC 4180 parser: quoted fields may contain delimiters, quotes ("" → ") and line breaks;
 * CRLF, LF and CR line endings. Fully blank lines are dropped. Throws on an unterminated quote.
 */
export function parseCsv(text: string, delimiter: CsvDelimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let atFieldStart = true;
  const endField = () => {
    row.push(field);
    field = '';
    atFieldStart = true;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (ch === delimiter) endField();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += ch;
      atFieldStart = false;
    }
  }
  if (quoted) throw new CsvParseError('The file ends inside a quoted field (a " is not closed).');
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/** Cells starting with these are prefixed with ' so spreadsheets never run them as formulas (§12.1). */
const FORMULA_START = /^[=+\-@\t\r]/;

export function guardCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function quoteCell(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const BOM = String.fromCharCode(0xfeff);

/** UTF-8 with BOM, comma-delimited, CRLF, RFC 4180 quoting, formula guard on every cell. */
export function serializeCsv(rows: string[][]): string {
  return `${BOM}${rows.map((r) => r.map((c) => quoteCell(guardCell(c))).join(',')).join('\r\n')}\r\n`;
}

/**
 * Reverses the export guard on import: a leading ' before a formula character is removed, so a
 * file exported by this app round-trips unchanged.
 */
export function unguardCell(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

/** Header text → comparable key (shared with the web app, which applies mapping presets). */
export const headerKey = csvHeaderKey;
