import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve as serveHttp } from '@hono/node-server';
import { toUtcIso } from '@subscriberr/shared';
import { createApp } from './app.js';
import { loadConfig, loadDotEnv } from './config.js';
import { createSecretBox } from './core/crypto.js';
import { createLogger } from './core/logger.js';
import { nowIso, systemClock } from './core/time.js';
import { createSystemContext } from './core/workspace-context.js';
import { bootDatabase } from './db/boot.js';
import { seedDemo } from './db/seed-demo.js';
import { countAccounts } from './modules/auth/accounts.js';
import { registerAuthJobs } from './modules/auth/jobs.js';
import { createGoogleProviderForConfig } from './modules/auth/provider-factory.js';
import { registerCsvJobs } from './modules/csv/jobs.js';
import { Scheduler } from './modules/jobs/scheduler.js';
import { createMediaProviderFactory } from './modules/media/factory.js';
import { registerMediaJobs } from './modules/media/jobs.js';
import { credentialsResolver } from './modules/media/servers.js';
import { createGmailClientFactory } from './modules/gmail/factory.js';
import { registerPaymentJobs } from './modules/payments/jobs.js';
import { registerDailyJob } from './modules/jobs/daily.js';
import { createServices } from './wiring.js';
import { alertOwnerOfIntegrityProblems } from './modules/email/automated.js';
import { registerEmailJobs } from './modules/email/jobs.js';
import { DEFAULT_BUILTIN_DIR } from './modules/email/packs.js';
import { ensureBackupDir } from './modules/system/backup-destination.js';
import { type BackupEnv, type BackupOutcome, createBackup, getBackupRetention, recordBackupRun } from './modules/system/backup.js';
import { registerSystemJobs } from './modules/system/jobs.js';
import { acquireRunLock } from './modules/system/lock.js';
import { pruneBackups } from './modules/system/prune.js';
import { runBackupDestinationCheck } from './modules/system/status.js';
import { APP_NAME, APP_VERSION } from './version.js';

const WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

/** Boot order (Spec §4.1): config → pre-migration backup → migrate → app → scheduler → listen. */
export async function serve(): Promise<void> {
  const baseDir = loadDotEnv();
  const config = loadConfig(process.env, baseDir);
  const log = createLogger(config.logLevel);
  const clock = systemClock;

  mkdirSync(config.workspacesDir, { recursive: true });
  const lock = await acquireRunLock(config.dataDir);

  const backupBase = {
    dbFile: config.dbFile,
    workspacesDir: config.workspacesDir,
    dataDir: config.dataDir,
    backupDir: config.backupDir,
    appVersion: APP_VERSION,
    timeZone: config.timezone,
    clock,
    log,
  };

  let preMigration: BackupOutcome | null = null;
  let boot;
  try {
    boot = await bootDatabase({
      dbFile: config.dbFile,
      appVersion: APP_VERSION,
      nowIso: nowIso(clock),
      async beforeMigrate(db, info) {
        log.info('taking pre-migration backup', info);
        preMigration = await createBackup({ ...backupBase, ctx: { sqlite: db } }, 'pre_migration');
        if (!preMigration.verified) {
          // Safest reading of §6.0 rule 8: never migrate without a verified safety snapshot.
          throw new Error(`Pre-migration backup failed, refusing to migrate: ${preMigration.error}`);
        }
      },
    });
  } catch (err) {
    lock.release();
    throw err;
  }

  const ctx = createSystemContext(boot.db);
  const backupEnv: BackupEnv = { ...backupBase, ctx };
  if (boot.migration.applied.length > 0) {
    log.info('database migrated', { from: boot.migration.from, to: boot.migration.to, applied: boot.migration.applied });
  }
  if (preMigration) {
    recordBackupRun(ctx, preMigration);
    pruneBackups(ctx, { backupDir: config.backupDir, retention: getBackupRetention(ctx), timeZone: config.timezone, now: clock.now(), nowIso: toUtcIso(clock.now()) });
  }

  if (config.seedDemo) {
    const seeded = seedDemo(boot.db, clock.now(), config.timezone);
    if (seeded.seeded) log.info('demo workspace seeded', { accountId: seeded.accountId });
    log.warn('DEMO MODE: fake Gmail, fake Plex/Jellyfin and fake sign-in are active. No real service is contacted.');
  }

  ensureBackupDir(config.backupDir);
  const destination = runBackupDestinationCheck(config.backupDir, config.dataDir);
  if (!destination.ok) log.warn('backup destination problem', { problems: destination.problems });

  const secretBox = createSecretBox(config.appSecret);
  const google = await createGoogleProviderForConfig(config, clock);
  if (google?.kind === 'fake') log.warn('Google sign-in uses the local FAKE Google provider (demo mode).');
  if (!google) log.warn('Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  if (countAccounts(ctx) === 0 && config.adminEmails.length === 0 && !config.seedDemo) {
    log.warn('No owner yet and ADMIN_EMAILS is empty: the FIRST Google account to sign in becomes the owner. Set ADMIN_EMAILS to restrict it.');
  }

  const scheduler = new Scheduler(ctx, clock, log);
  registerSystemJobs(scheduler, backupEnv, (problems) => alertOwnerOfIntegrityProblems(ctx, clock, problems));
  registerAuthJobs(scheduler, { ctx, clock, secretBox, google, log }, config.timezone);
  registerCsvJobs(scheduler, ctx, clock, config.timezone);
  const gmail = createGmailClientFactory(config, { ctx, secretBox });
  const packs = { builtinDir: DEFAULT_BUILTIN_DIR, workspacesDir: backupEnv.workspacesDir };
  const media = createMediaProviderFactory(config, { credentialsFor: credentialsResolver(ctx, secretBox) });
  const services = createServices({ clock, log, packs, ctx, media, autoSync: true });
  const onPaymentStored = services.onPaymentStored;
  registerPaymentJobs(scheduler, ctx, { clock, log, gmail, onStored: onPaymentStored }, config.timezone);
  registerDailyJob(scheduler, ctx, clock, log, services.dailySteps, config.timezone);
  registerEmailJobs(scheduler, ctx, { clock, log, gmail }, config.timezone);
  registerMediaJobs(scheduler, ctx, { clock, log, media }, config.timezone);
  scheduler.start();

  const app = createApp({ config, ctx, clock, log, secretBox, google, backupEnv, scheduler, media, gmail, onPaymentStored, billingEvents: services.billingEvents, packs, webDir: WEB_DIR });
  const server = serveHttp({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    log.info(`${APP_NAME} ${APP_VERSION} listening`, { port: info.port, baseUrl: config.baseUrl, dataDir: config.dataDir, backupDir: config.backupDir });
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    scheduler.stop();
    const finish = () => {
      try {
        boot.db.close();
      } finally {
        lock.release();
      }
      process.exit(0);
    };
    server.close(finish);
    setTimeout(finish, 5000).unref(); // do not hang on keep-alive connections
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
