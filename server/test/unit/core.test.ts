import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSecretBox, hashToken, randomToken } from '../../src/core/crypto.js';
import { createLogger } from '../../src/core/logger.js';
import { runSelfCheck } from '../../src/core/selfcheck.js';
import { FakeClock, nowIso, today } from '../../src/core/time.js';
import { TEST_SECRET } from '../helpers/env.js';

describe('crypto', () => {
  const box = createSecretBox(TEST_SECRET);

  it('round-trips and uses the v1:<keyId>:<base64> format with a fresh IV each time', () => {
    const a = box.encrypt('refresh-token-ü');
    const b = box.encrypt('refresh-token-ü');
    expect(a).toMatch(/^v1:k1:[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(box.decrypt(a)).toBe('refresh-token-ü');
    expect(a).not.toContain('refresh-token');
  });

  it('rejects tampering, the wrong secret and the wrong key id', () => {
    const payload = box.encrypt('secret');
    const blob = Buffer.from(payload.split(':')[2]!, 'base64');
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
    expect(() => box.decrypt(`v1:k1:${blob.toString('base64')}`)).toThrow();
    expect(() => createSecretBox(`${TEST_SECRET}x`).decrypt(payload)).toThrow();
    expect(() => createSecretBox(TEST_SECRET, 'k2').decrypt(payload)).toThrow(/key "k1"/);
    expect(() => box.decrypt('v0:k1:AAAA')).toThrow(/Unsupported/);
  });

  it('hashes tokens one-way', () => {
    const t = randomToken();
    expect(t.length).toBeGreaterThanOrEqual(43);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
  });
});

describe('logger and clock', () => {
  it('writes JSON lines at or above the level and serialises errors', () => {
    const lines: string[] = [];
    const log = createLogger('info', (l) => lines.push(l)).child({ module: 'x' });
    log.debug('hidden');
    log.error('boom', { err: new Error('bad') });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ level: 'error', msg: 'boom', module: 'x', err: { message: 'bad' } });
  });

  it('gives DB-format timestamps and the local calendar date', () => {
    const clock = new FakeClock('2026-07-01T03:30:00.900Z');
    expect(nowIso(clock)).toBe('2026-07-01T03:30:00Z');
    expect(today(clock, 'America/Toronto')).toBe('2026-06-30');
    clock.advanceDays(1);
    expect(today(clock, 'America/Toronto')).toBe('2026-07-01');
  });
});

describe('dependency spike (Spec §18 M1)', () => {
  it('better-sqlite3, googleapis, mailparser, juice, nodemailer and archiver/yauzl all work', async () => {
    const results = await runSelfCheck();
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.name)).toEqual(['better-sqlite3', 'googleapis', 'mailparser', 'juice', 'nodemailer (MailComposer)', 'archiver + yauzl']);
  });
});

describe('layout invariants (Spec §4.1)', () => {
  const src = fileURLToPath(new URL('../../src', import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
    });

  it('no raw DB handle outside core/ and db/', () => {
    const offenders = walk(src)
      .filter((f) => !/[\\/]src[\\/](core|db)[\\/]/.test(f))
      .filter((f) => {
        const code = readFileSync(f, 'utf8');
        return /from '[^']*db\/client(\.js)?'/.test(code) || /^import (?!type)[^;]*from 'better-sqlite3'/m.test(code);
      })
      .map((f) => path.relative(src, f));
    expect(offenders).toEqual([]);
  });

  it('the pure areas never reach for the filesystem, network or global clock', () => {
    // payments/interac, payments/matching and billing/engine are filled in by later milestones;
    // this guard is in place from day one so they start (and stay) pure.
    const pure = walk(src).filter((f) => /[\\/]payments[\\/](interac|matching)[\\/]|[\\/]billing[\\/]engine\.ts$/.test(f));
    const offenders = pure.filter((f) => /from 'node:(fs|net|http|https)'|new Date\(\)|Date\.now\(\)/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
