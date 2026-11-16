import { existsSync } from 'node:fs';
import path from 'node:path';
import { isValidTimeZone } from '@subscriberr/shared';
import { z } from 'zod';

const flag = z
  .string()
  .optional()
  .transform((v) => ['true', '1', 'yes'].includes((v ?? '').trim().toLowerCase()));

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  BASE_URL: z.url().default('http://localhost:3000'),
  TRUST_PROXY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  APP_SECRET: z.string({ error: 'APP_SECRET is required' }).min(32, 'APP_SECRET must be at least 32 characters'),
  TZ: z.string().default('America/Toronto'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATA_DIR: z.string().default('/data'),
  BACKUP_DIR: z.string().default('/backups'),
  ADMIN_EMAILS: z.string().default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DEV_FAKE_LOGIN: flag,
  SEED_DEMO: flag,
});

export interface Config {
  nodeEnv: string;
  isProduction: boolean;
  baseUrl: string;
  secureCookies: boolean;
  /** True when behind a reverse proxy (NPM). */
  trustProxy: boolean;
  /** Number of trusted proxy hops in X-Forwarded-For (TRUST_PROXY=true → 1). */
  trustProxyHops: number;
  /** The only OAuth redirect URI the app uses: BASE_URL + /auth/google/callback. */
  googleRedirectUri: string;
  googleClientId: string;
  googleClientSecret: string;
  appSecret: string;
  timezone: string;
  port: number;
  dataDir: string;
  backupDir: string;
  dbFile: string;
  workspacesDir: string;
  adminEmails: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  devFakeLogin: boolean;
  seedDemo: boolean;
}

export class ConfigError extends Error {}

/** TRUST_PROXY: false/empty → 0 hops, true → 1 hop (NPM), or an explicit hop count. null = invalid. */
export function parseTrustProxy(value: string | undefined): number | null {
  const v = (value ?? '').trim().toLowerCase();
  if (['', 'false', '0', 'no'].includes(v)) return 0;
  if (['true', 'yes'].includes(v)) return 1;
  if (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 10) return Number(v);
  return null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalhostUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return LOCAL_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** Values copied from documentation; anyone who has read the repository knows them. */
const PLACEHOLDER_SECRETS = /change-?me|changeme|your[-_ ]?secret|example|placeholder|replace[-_ ]?me/i;

/** Why an APP_SECRET must not protect a real deployment, or null when it looks random enough. */
export function weakSecretReason(secret: string): string | null {
  if (PLACEHOLDER_SECRETS.test(secret)) return 'it is a placeholder value from the documentation';
  if (new Set(secret).size < 12) return 'it has too little variety (fewer than 12 different characters)';
  return null;
}

/**
 * Parses and validates the environment. Throws ConfigError (fail fast) on any problem.
 * `baseDir` is what relative DATA_DIR / BACKUP_DIR values are resolved against.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, baseDir: string = process.cwd()): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const problems: string[] = [];

  const trustProxyHops = parseTrustProxy(e.TRUST_PROXY);
  if (trustProxyHops === null) problems.push('TRUST_PROXY must be true, false or a number of proxy hops (1-10)');
  if (!isValidTimeZone(e.TZ)) problems.push(`TZ "${e.TZ}" is not a valid IANA timezone`);

  // Demo switches replace real Google/Gmail/media servers with fakes, so they must never be
  // honoured on a real deployment (Spec §15; SEED_DEMO gets the same guard as DEV_FAKE_LOGIN).
  const demoAllowed = !isProduction && isLocalhostUrl(e.BASE_URL);
  if (e.DEV_FAKE_LOGIN && !demoAllowed) {
    problems.push('DEV_FAKE_LOGIN is only allowed when BASE_URL is a localhost URL and NODE_ENV is not "production"');
  }
  if (e.SEED_DEMO && !demoAllowed) {
    problems.push('SEED_DEMO is only allowed when BASE_URL is a localhost URL and NODE_ENV is not "production"');
  }
  // APP_SECRET encrypts the stored Google / media-server credentials and the OAuth state cookie.
  // A guessable value makes that encryption worthless, so a real deployment refuses to start.
  const weak = weakSecretReason(e.APP_SECRET);
  if (weak && !demoAllowed) {
    problems.push(`APP_SECRET is not safe to use: ${weak}. Generate one: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`);
  }
  if (!e.DEV_FAKE_LOGIN && (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET)) {
    problems.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required (unless DEV_FAKE_LOGIN is enabled for local demo mode)');
  }

  const dataDir = path.resolve(baseDir, e.DATA_DIR);
  const backupDir = path.resolve(baseDir, e.BACKUP_DIR);
  if (dataDir === backupDir) problems.push('BACKUP_DIR must be a different location than DATA_DIR');

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  const baseUrl = e.BASE_URL.replace(/\/+$/, '');
  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    baseUrl,
    secureCookies: baseUrl.startsWith('https://'),
    trustProxy: (trustProxyHops ?? 0) > 0,
    trustProxyHops: trustProxyHops ?? 0,
    googleRedirectUri: `${baseUrl}/auth/google/callback`,
    googleClientId: e.GOOGLE_CLIENT_ID,
    googleClientSecret: e.GOOGLE_CLIENT_SECRET,
    appSecret: e.APP_SECRET,
    timezone: e.TZ,
    port: e.PORT,
    dataDir,
    backupDir,
    dbFile: path.join(dataDir, 'subscriberr.db'),
    workspacesDir: path.join(dataDir, 'workspaces'),
    adminEmails: e.ADMIN_EMAILS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    logLevel: e.LOG_LEVEL,
    devFakeLogin: e.DEV_FAKE_LOGIN,
    seedDemo: e.SEED_DEMO,
  };
}

export interface CliConfig {
  dataDir: string;
  backupDir: string;
  dbFile: string;
  timezone: string;
  logLevel: Config['logLevel'];
}

/**
 * Minimal configuration for the recovery subcommands (restore / verify-backup /
 * integrity-check). They must work even when APP_SECRET or the Google settings are unavailable.
 */
export function loadCliConfig(env: NodeJS.ProcessEnv = process.env, baseDir: string = process.cwd()): CliConfig {
  const timezone = env.TZ && isValidTimeZone(env.TZ) ? env.TZ : 'America/Toronto';
  const dataDir = path.resolve(baseDir, env.DATA_DIR || '/data');
  const level = envSchema.shape.LOG_LEVEL.safeParse(env.LOG_LEVEL);
  return {
    dataDir,
    backupDir: path.resolve(baseDir, env.BACKUP_DIR || '/backups'),
    dbFile: path.join(dataDir, 'subscriberr.db'),
    timezone,
    logLevel: level.success ? level.data : 'info',
  };
}

/**
 * Loads a `.env` file from the current directory or one of its parents (dev convenience; in
 * Docker the variables come from the container environment). Returns the directory it was
 * found in, which is also the base for relative DATA_DIR / BACKUP_DIR values.
 */
export function loadDotEnv(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 3; i++) {
    const file = path.join(dir, '.env');
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}
