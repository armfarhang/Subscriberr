import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';

// Guarded zip extraction shared by backups/restore (§6.9) and template packs (§9.1):
// rejects path traversal ("zip-slip") and oversized archives ("zip bombs").

export interface ZipLimits {
  maxEntries: number;
  /** Total uncompressed bytes across all entries. */
  maxTotalBytes: number;
  /** Uncompressed bytes of any single entry. */
  maxEntryBytes: number;
}

export class UnsafeZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeZipError';
  }
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // decodeStrings + validateEntrySizes are yauzl defaults; we keep them on and re-check below.
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => (err || !zip ? reject(err) : resolve(zip)));
  });
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err || !stream ? reject(err) : resolve(stream)));
  });
}

/** True when `name` is a plain relative path that stays inside the extraction root. */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').some((part) => part === '..');
}

/**
 * Extracts `zipFile` into `destDir` (which must exist). Returns the relative paths of the files
 * written. Throws UnsafeZipError without leaving partially-trusted content in use: callers must
 * extract into a scratch directory and discard it on failure.
 */
export async function extractZipSafely(zipFile: string, destDir: string, limits: ZipLimits): Promise<string[]> {
  const root = path.resolve(destDir);
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(zipFile);
  } catch (err) {
    throw new UnsafeZipError(`Not a readable zip file: ${err instanceof Error ? err.message : String(err)}`);
  }

  const written: string[] = [];
  let entries = 0;
  let totalBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', (err: Error) => reject(new UnsafeZipError(err.message)));
      zip.on('end', () => resolve());
      zip.on('entry', (entry: yauzl.Entry) => {
        (async () => {
          entries += 1;
          if (entries > limits.maxEntries) throw new UnsafeZipError(`Zip has more than ${limits.maxEntries} entries`);
          const name = entry.fileName;
          if (!isSafeEntryName(name)) throw new UnsafeZipError(`Unsafe path in zip: ${name}`);
          const target = path.resolve(root, name);
          if (target !== root && !target.startsWith(root + path.sep)) {
            throw new UnsafeZipError(`Path escapes the extraction directory: ${name}`);
          }
          if (name.endsWith('/')) {
            mkdirSync(target, { recursive: true });
            return;
          }
          if (entry.uncompressedSize > limits.maxEntryBytes) {
            throw new UnsafeZipError(`Zip entry too large: ${name}`);
          }
          if (totalBytes + entry.uncompressedSize > limits.maxTotalBytes) {
            throw new UnsafeZipError('Zip expands beyond the allowed total size');
          }
          mkdirSync(path.dirname(target), { recursive: true });
          let entryBytes = 0;
          // Count real bytes too: never trust the sizes declared in the zip headers.
          const meter = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              entryBytes += chunk.length;
              totalBytes += chunk.length;
              if (entryBytes > limits.maxEntryBytes || totalBytes > limits.maxTotalBytes) {
                cb(new UnsafeZipError('Zip expands beyond the allowed size'));
              } else {
                cb(null, chunk);
              }
            },
          });
          await pipeline(await openEntry(zip, entry), meter, createWriteStream(target, { mode: 0o600 }));
          written.push(name);
        })().then(
          () => zip.readEntry(),
          (err: unknown) => reject(err instanceof UnsafeZipError ? err : new UnsafeZipError(err instanceof Error ? err.message : String(err))),
        );
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return written;
}
