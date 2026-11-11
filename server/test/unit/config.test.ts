import { describe, expect, it } from 'vitest';
import { ConfigError, loadCliConfig, loadConfig } from '../../src/config.js';
import { TEST_SECRET } from '../helpers/env.js';

const base = { APP_SECRET: TEST_SECRET, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', DATA_DIR: '/tmp/d', BACKUP_DIR: '/tmp/b' };

describe('config', () => {
  it('applies the documented defaults', () => {
    const c = loadConfig(base, '/');
    expect(c.port).toBe(3000);
    expect(c.timezone).toBe('America/Toronto');
    expect(c.baseUrl).toBe('http://localhost:3000');
    expect(c.secureCookies).toBe(false);
    expect(c.devFakeLogin).toBe(false);
    expect(c.seedDemo).toBe(false);
    expect(c.logLevel).toBe('info');
  });

  it('fails fast without APP_SECRET or with a short one', () => {
    expect(() => loadConfig({ ...base, APP_SECRET: undefined }, '/')).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, APP_SECRET: 'short' }, '/')).toThrow(/at least 32/);
  });

  it('requires Google credentials unless fake login is on', () => {
    expect(() => loadConfig({ ...base, GOOGLE_CLIENT_ID: '' }, '/')).toThrow(/GOOGLE_CLIENT_ID/);
    expect(loadConfig({ ...base, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', DEV_FAKE_LOGIN: 'true' }, '/').devFakeLogin).toBe(true);
  });

  it('refuses DEV_FAKE_LOGIN and SEED_DEMO off localhost or in production', () => {
    expect(() => loadConfig({ ...base, DEV_FAKE_LOGIN: 'true', BASE_URL: 'https://subscriberr.mediaservers.org' }, '/')).toThrow(/DEV_FAKE_LOGIN/);
    expect(() => loadConfig({ ...base, DEV_FAKE_LOGIN: 'true', NODE_ENV: 'production' }, '/')).toThrow(/DEV_FAKE_LOGIN/);
    expect(() => loadConfig({ ...base, SEED_DEMO: 'true', BASE_URL: 'https://example.org' }, '/')).toThrow(/SEED_DEMO/);
    expect(() => loadConfig({ ...base, SEED_DEMO: 'true', NODE_ENV: 'production' }, '/')).toThrow(/SEED_DEMO/);
    // A look-alike host is not localhost.
    expect(() => loadConfig({ ...base, DEV_FAKE_LOGIN: 'true', BASE_URL: 'http://localhost.evil.example' }, '/')).toThrow(/DEV_FAKE_LOGIN/);
  });

  it('uses secure cookies for an https BASE_URL and strips the trailing slash', () => {
    const c = loadConfig({ ...base, BASE_URL: 'https://subscriberr.mediaservers.org/', TRUST_PROXY: 'true' }, '/');
    expect(c.baseUrl).toBe('https://subscriberr.mediaservers.org');
    expect(c.secureCookies).toBe(true);
    expect(c.trustProxy).toBe(true);
  });

  it('rejects an invalid timezone, port, and BACKUP_DIR equal to DATA_DIR', () => {
    expect(() => loadConfig({ ...base, TZ: 'Mars/Olympus' }, '/')).toThrow(/timezone/);
    expect(() => loadConfig({ ...base, PORT: '99999' }, '/')).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, BACKUP_DIR: '/tmp/d' }, '/')).toThrow(/different location/);
  });

  it('parses ADMIN_EMAILS', () => {
    expect(loadConfig({ ...base, ADMIN_EMAILS: ' A@Example.com, b@example.com ,' }, '/').adminEmails).toEqual(['a@example.com', 'b@example.com']);
  });

  it('recovery commands need no secrets', () => {
    const c = loadCliConfig({ DATA_DIR: '/tmp/d' }, '/');
    expect(c.dbFile.replace(/\\/g, '/')).toMatch(/\/tmp\/d\/subscriberr\.db$/);
    expect(c.timezone).toBe('America/Toronto');
  });
});
