import { describe, expect, it } from 'vitest';
import { loadConfig, weakSecretReason } from '../../src/config.js';
import { createSecretBox } from '../../src/core/crypto.js';
import { createLogger, redact } from '../../src/core/logger.js';
import { safeReturnTo } from '../../src/modules/auth/oauth-state.js';
import { svgProblems, templateSafetyProblems } from '../../src/modules/email/sanitize.js';
import { createMediaProviderFactory } from '../../src/modules/media/factory.js';
import { BlockedAddressError, blockedIpReason, guardedFetch, mediaUrlProblem } from '../../src/modules/media/net-guard.js';
import { TEST_SECRET } from '../helpers/env.js';

// Regression tests for the security hardening pass (PATCH.md).

describe('media-server SSRF guard', () => {
  it('refuses link-local, unspecified and (by default) loopback addresses, in every spelling', () => {
    for (const ip of ['169.254.169.254', '169.254.0.1', '0.0.0.0', '127.0.0.1', '127.9.9.9', '::', '::1', '0:0:0:0:0:0:0:1', 'fe80::1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:127.0.0.1']) {
      expect(blockedIpReason(ip), ip).not.toBeNull();
    }
    // Media servers live on the LAN: private ranges stay reachable.
    for (const ip of ['192.168.1.20', '10.0.0.5', '172.17.0.3', '100.64.1.1', '8.8.8.8', 'fd00::5', '2001:db8::1']) {
      expect(blockedIpReason(ip), ip).toBeNull();
    }
    expect(blockedIpReason('127.0.0.1', { allowLoopback: true })).toBeNull();
    expect(blockedIpReason('::1', { allowLoopback: true })).toBeNull();
    expect(blockedIpReason('169.254.169.254', { allowLoopback: true })).not.toBeNull();
  });

  it('checks the URL itself: scheme, embedded credentials, loopback names, IP literals', () => {
    expect(mediaUrlProblem('http://192.168.1.20:8096')).toBeNull();
    expect(mediaUrlProblem('https://jellyfin.example.com/base')).toBeNull();
    const bad = [
      'file:///etc/passwd',
      'gopher://x/',
      'http://user:pw@jf.local',
      'http://169.254.169.254/latest/meta-data',
      'http://[fe80::1]/',
      'http://localhost:3000',
      'http://app.localhost/',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
      'http://0.0.0.0/',
      'http://2852039166/', // decimal spelling of 169.254.169.254
      'not a url',
    ];
    for (const url of bad) expect(mediaUrlProblem(url), url).not.toBeNull();
    expect(mediaUrlProblem('http://localhost:8096', { allowLoopback: true })).toBeNull();
  });

  it('never follows redirects and re-checks the address a host name resolves to', async () => {
    const seen: Array<{ url: string; redirect: unknown }> = [];
    const redirecting = (async (input: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(input), redirect: init.redirect });
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
    }) as typeof fetch;
    await expect(guardedFetch(redirecting, { resolve: null })('http://jf.local/System/Info')).rejects.toThrow(/redirect/);
    expect(seen).toEqual([{ url: 'http://jf.local/System/Info', redirect: 'manual' }]);

    const ok = (async () => new Response('{}')) as typeof fetch;
    await expect(guardedFetch(ok, { resolve: async () => ['169.254.169.254'] })('http://rebind.example/')).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(guardedFetch(ok, { resolve: async () => ['192.168.1.9'] })('http://jf.lan/')).resolves.toBeInstanceOf(Response);
    await expect(guardedFetch(ok, { resolve: null })('http://169.254.169.254/')).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it('the provider factory refuses a stored server that points at a blocked address', () => {
    const creds = () => ({ token: 'secret-token-123' });
    const prod = createMediaProviderFactory({ seedDemo: false, isProduction: true }, { credentialsFor: creds });
    expect(() => prod({ id: 1, type: 'jellyfin', baseUrl: 'http://169.254.169.254' })).toThrow(/cannot be used/);
    expect(() => prod({ id: 1, type: 'jellyfin', baseUrl: 'http://127.0.0.1:3000' })).toThrow(/cannot be used/);
    expect(() => prod({ id: 1, type: 'jellyfin', baseUrl: 'http://192.168.1.20:8096' })).not.toThrow();
    const dev = createMediaProviderFactory({ seedDemo: false, isProduction: false }, { credentialsFor: creds });
    expect(() => dev({ id: 1, type: 'jellyfin', baseUrl: 'http://127.0.0.1:8096' })).not.toThrow();
  });
});

describe('APP_SECRET strength', () => {
  const real = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', DATA_DIR: '/tmp/d', BACKUP_DIR: '/tmp/b', BASE_URL: 'https://subscriberr.mediaservers.org', NODE_ENV: 'production' };

  it('a real deployment refuses the documented placeholder and low-variety secrets', () => {
    expect(() => loadConfig({ ...real, APP_SECRET: 'change-me-change-me-change-me-change-me' }, '/')).toThrow(/APP_SECRET is not safe/);
    expect(() => loadConfig({ ...real, APP_SECRET: 'a'.repeat(40) }, '/')).toThrow(/APP_SECRET is not safe/);
    expect(() => loadConfig({ ...real, APP_SECRET: 'abcabcabcabcabcabcabcabcabcabcabcabcabc' }, '/')).toThrow(/APP_SECRET is not safe/);
    expect(loadConfig({ ...real, APP_SECRET: TEST_SECRET }, '/').appSecret).toBe(TEST_SECRET);
    expect(weakSecretReason('k3J9xQ2mZ7pL0vB8nR4tW6yH1cF5dG3sA9eU2iO7')).toBeNull();
  });

  it('local demo mode still starts with the .env.example value', () => {
    const c = loadConfig({ APP_SECRET: 'change-me-change-me-change-me-change-me', DEV_FAKE_LOGIN: 'true', SEED_DEMO: 'true', DATA_DIR: '/tmp/d', BACKUP_DIR: '/tmp/b' }, '/');
    expect(c.seedDemo).toBe(true);
  });
});

describe('redirect target validation', () => {
  const dev = { baseUrl: 'http://localhost:3000', isProduction: false };
  const prod = { baseUrl: 'https://subscriberr.mediaservers.org', isProduction: true };

  it('rejects control characters that browsers strip from URLs', () => {
    for (const bad of ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/ok\u0000', '/' + 'a'.repeat(3000)]) {
      expect(safeReturnTo(bad, prod), JSON.stringify(bad.slice(0, 20))).toBe('/');
      expect(safeReturnTo(bad, dev), JSON.stringify(bad.slice(0, 20))).toBe('/');
    }
  });

  it('allows the Vite dev server only when the app itself runs on localhost', () => {
    expect(safeReturnTo('http://localhost:5173/', dev)).toBe('http://localhost:5173/');
    // A real URL started without NODE_ENV=production must not redirect to arbitrary local ports.
    expect(safeReturnTo('http://localhost:5173/', { baseUrl: 'https://subscriberr.mediaservers.org', isProduction: false })).toBe('/');
  });
});

describe('template sanitizer bypasses', () => {
  const HANDLER = 'Event-handler attributes (onclick=…) are not allowed';

  it('catches event handlers without leading whitespace and obfuscated script URLs', () => {
    expect(templateSafetyProblems('<img/onerror=alert(1) src=x>')).toContain(HANDLER);
    expect(templateSafetyProblems('<a href="x"onclick="y()">x</a>')).toContain(HANDLER);
    expect(svgProblems('<svg/onload=alert(1)>')).toContain(HANDLER);
    expect(templateSafetyProblems('<a href="java\tscript:alert(1)">x</a>')).toContain('javascript: URLs are not allowed');
    expect(templateSafetyProblems('<a href="javascript&colon;alert(1)">x</a>')).toContain('javascript: URLs are not allowed');
    expect(templateSafetyProblems('<a href="java&#115;cript:alert(1)">x</a>')).toContain('Encoded characters in a link address are not allowed');
    expect(templateSafetyProblems('<a href="vbscript:x">x</a>')).toContain('vbscript: URLs are not allowed');
    expect(templateSafetyProblems('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')).toContain('data:text/html URLs are not allowed');
    expect(templateSafetyProblems('<base href="https://evil.example/">')).toContain('<base> is not allowed');
  });

  it('still accepts ordinary template markup', () => {
    expect(templateSafetyProblems('<p style="color:#333">Hi {{display_name}}, one option = two.</p><a href="https://example.com/?a=1&amp;b=2">pay</a><img src="assets/logo.png" width="120">')).toEqual([]);
    expect(templateSafetyProblems('<meta name="viewport" content="width=device-width">')).toEqual([]);
  });
});

describe('log redaction', () => {
  it('drops secret-looking fields and masks token-shaped text', () => {
    const lines: string[] = [];
    const log = createLogger('debug', (l) => lines.push(l));
    log.warn('refresh failed for Bearer abcdefghijklmnop123', {
      refreshToken: '1//0abcdefghijklmnop',
      nested: { apiKey: 'jellyfin-key-12345', ok: true, url: 'http://jf.local/Users?api_key=supersecret123&x=1' },
      err: new Error('GET https://plex.tv/api?X-Plex-Token=plex-secret-99 failed'),
      accountId: 7,
    });
    const line = lines[0]!;
    for (const secret of ['abcdefghijklmnop123', '1//0abcdefghijklmnop', 'jellyfin-key-12345', 'supersecret123', 'plex-secret-99']) expect(line, secret).not.toContain(secret);
    expect(JSON.parse(line)).toMatchObject({ accountId: 7, refreshToken: '[redacted]', nested: { apiKey: '[redacted]', ok: true } });
    expect(redact({ tokens: 3, hasCredentials: true })).toEqual({ tokens: 3, hasCredentials: true });
  });
});

describe('encrypted columns', () => {
  it('rejects a ciphertext whose authentication tag was tampered with, or the wrong key', () => {
    const box = createSecretBox(TEST_SECRET);
    const enc = box.encrypt('refresh-token');
    expect(box.decrypt(enc)).toBe('refresh-token');
    const blob = Buffer.from(enc.split(':')[2]!, 'base64');
    blob[14]! ^= 0xff; // inside the tag
    expect(() => box.decrypt('v1:k1:' + blob.toString('base64'))).toThrow();
    expect(() => createSecretBox('another-secret-another-secret-another-0123456789').decrypt(enc)).toThrow();
  });
});
