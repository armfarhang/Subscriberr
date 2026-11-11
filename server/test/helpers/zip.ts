import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { ZipArchive } from 'archiver';

/** Writes a zip with the given entries (name → content). */
export function writeZip(file: string, entries: Record<string, string | Buffer>): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    out.on('close', () => resolve());
    out.on('error', reject);
    archive.on('error', reject);
    archive.pipe(out);
    for (const [name, content] of Object.entries(entries)) archive.append(content, { name });
    void archive.finalize();
  });
}

/**
 * Rewrites an entry name inside a zip in place (same byte length), in both the local header and
 * the central directory. Used to forge path-traversal names that zip tools refuse to create.
 */
export function forgeEntryName(file: string, from: string, to: string): void {
  if (from.length !== to.length) throw new Error('names must have the same length');
  const data = readFileSync(file);
  const needle = Buffer.from(from, 'latin1');
  let count = 0;
  for (let i = data.indexOf(needle); i !== -1; i = data.indexOf(needle, i + 1)) {
    data.write(to, i, 'latin1');
    count++;
  }
  if (count < 2) throw new Error(`expected the name in the local header and the central directory, found ${count}`);
  writeFileSync(file, data);
}
