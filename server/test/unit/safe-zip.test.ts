import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractZipSafely, isSafeEntryName, UnsafeZipError } from '../../src/core/safe-zip.js';
import { tempDir } from '../helpers/env.js';
import { forgeEntryName, writeZip } from '../helpers/zip.js';

const LIMITS = { maxEntries: 100, maxTotalBytes: 1024 * 1024, maxEntryBytes: 1024 * 1024 };

function setup() {
  const root = tempDir();
  const out = path.join(root, 'out');
  mkdirSync(out);
  return { root, out, zip: path.join(root, 'test.zip') };
}

describe('safe zip extraction', () => {
  it('extracts nested files', async () => {
    const { out, zip } = setup();
    await writeZip(zip, { 'a.txt': 'A', 'dir/sub/b.txt': 'B' });
    const files = await extractZipSafely(zip, out, LIMITS);
    expect(files.sort()).toEqual(['a.txt', 'dir/sub/b.txt']);
    expect(readFileSync(path.join(out, 'dir', 'sub', 'b.txt'), 'utf8')).toBe('B');
  });

  it('rejects path traversal (zip-slip) and writes nothing outside the target', async () => {
    const { root, out, zip } = setup();
    await writeZip(zip, { 'ok.txt': 'fine', 'xx/evil.txt': 'pwned' });
    forgeEntryName(zip, 'xx/evil.txt', '../evil.txt');
    await expect(extractZipSafely(zip, out, LIMITS)).rejects.toBeInstanceOf(UnsafeZipError);
    expect(existsSync(path.join(root, 'evil.txt'))).toBe(false);
    expect(readdirSync(root).sort()).toEqual(['out', 'test.zip']);
  });

  it('rejects absolute and backslash names', () => {
    for (const bad of ['/etc/passwd', 'C:/x', 'C:\\x', 'a\\..\\b', '../x', 'a/../../x', '', 'a\0b']) expect(isSafeEntryName(bad)).toBe(false);
    for (const ok of ['a.txt', 'workspaces/1/templates/x/layout.html', 'a..b/c']) expect(isSafeEntryName(ok)).toBe(true);
  });

  it('rejects zip bombs by total size, entry size and entry count', async () => {
    const { out, zip } = setup();
    await writeZip(zip, { 'zeros.bin': Buffer.alloc(4 * 1024 * 1024) }); // compresses to a few KB
    await expect(extractZipSafely(zip, out, LIMITS)).rejects.toThrow(/too large|allowed/);

    const many: Record<string, string> = {};
    for (let i = 0; i < 20; i++) many[`f${i}.txt`] = 'x';
    await writeZip(zip, many);
    await expect(extractZipSafely(zip, out, { ...LIMITS, maxEntries: 10 })).rejects.toThrow(/more than 10 entries/);

    await writeZip(zip, { 'a.bin': Buffer.alloc(600), 'b.bin': Buffer.alloc(600) });
    await expect(extractZipSafely(zip, out, { maxEntries: 10, maxTotalBytes: 1000, maxEntryBytes: 1000 })).rejects.toThrow(/total size/);
  });

  it('rejects files that are not zips', async () => {
    const { out, zip } = setup();
    writeFileSync(zip, 'definitely not a zip');
    await expect(extractZipSafely(zip, out, LIMITS)).rejects.toBeInstanceOf(UnsafeZipError);
  });
});
