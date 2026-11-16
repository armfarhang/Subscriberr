#!/usr/bin/env node
import path from 'node:path';
import { ConfigError, loadCliConfig, loadDotEnv } from './config.js';
import { createLogger } from './core/logger.js';
import { runSelfCheck } from './core/selfcheck.js';
import { systemClock } from './core/time.js';
import { DatabaseCorruptError } from './db/boot.js';
import { SchemaTooNewError } from './db/migrate.js';
import { serve } from './main.js';
import { checkDatabaseFile } from './modules/system/integrity.js';
import { RestoreError, restoreBackup } from './modules/system/restore.js';
import { verifyBackupFile } from './modules/system/verify.js';
import { APP_NAME, APP_VERSION } from './version.js';

// Entrypoint subcommands (Spec §6.9 layer 5, §15):
//   serve (default) | restore <file> | verify-backup <file> | integrity-check | selfcheck

const USAGE = `${APP_NAME} ${APP_VERSION}

Usage: subscriberr [command]

  serve                 Run the app (default)
  verify-backup <file>  Check a backup zip (unzip, checksum, integrity, row counts)
  restore <file>        Restore a backup into DATA_DIR. The app must be stopped.
  integrity-check       PRAGMA integrity_check + foreign_key_check on the live database
  selfcheck             Verify that native/third-party dependencies load in this environment
`;

// Everything this process creates (database, WAL, lock file, template packs, import staging) holds
// members' personal data or encrypted credentials: owner-only by default (files 0600, dirs 0700).
// No-op on Windows.
process.umask(0o077);

const out = (line: string) => process.stdout.write(`${line}\n`);
const fail = (line: string) => process.stderr.write(`${line}\n`);

async function main(argv: string[]): Promise<number> {
  const [command = 'serve', arg] = argv;

  switch (command) {
    case 'serve':
      await serve();
      return -1; // keep running

    case 'verify-backup': {
      if (!arg) {
        fail('Usage: verify-backup <file>');
        return 2;
      }
      const result = await verifyBackupFile(path.resolve(arg));
      if (!result.ok) {
        fail(`FAILED: ${result.error}`);
        return 1;
      }
      const m = result.manifest!;
      const rows = Object.values(m.rowCounts).reduce((a, b) => a + b, 0);
      out(`OK: ${path.basename(arg)} — ${m.kind} backup from ${m.createdAt}, app ${m.appVersion}, schema ${m.schemaVersion}, ${rows} rows`);
      return 0;
    }

    case 'restore': {
      if (!arg) {
        fail('Usage: restore <file>');
        return 2;
      }
      const cfg = loadCliConfig(process.env, loadDotEnv());
      const result = await restoreBackup({
        backupFile: path.resolve(arg),
        dataDir: cfg.dataDir,
        appVersion: APP_VERSION,
        timeZone: cfg.timezone,
        clock: systemClock,
        log: createLogger(cfg.logLevel),
      });
      out(`Restored ${path.basename(arg)} (${result.manifest.kind} backup from ${result.manifest.createdAt}) into ${cfg.dataDir}.`);
      if (result.migratedTo > result.manifest.schemaVersion) out(`Database migrated from schema ${result.manifest.schemaVersion} to ${result.migratedTo}.`);
      if (result.movedAside.length > 0) {
        out('Your previous data was kept at:');
        for (const p of result.movedAside) out(`  ${p}`);
      }
      out('');
      out('Next steps:');
      out('  1. Start the app.');
      out(`  2. In System, use "Rescan mailbox from date" from ${result.manifest.createdAt.slice(0, 10)} to re-import e-Transfers received since this backup.`);
      out('  Manual payments, voids, adjustments and member edits made after the backup cannot be recovered from Gmail.');
      return 0;
    }

    case 'integrity-check': {
      const cfg = loadCliConfig(process.env, loadDotEnv());
      const report = checkDatabaseFile(cfg.dbFile);
      if (!report.ok) {
        fail(`FAILED: ${cfg.dbFile}`);
        for (const p of report.problems) fail(`  ${p}`);
        return 1;
      }
      out(`OK: ${cfg.dbFile} (schema ${report.schemaVersion}, ${Object.keys(report.rowCounts).length} tables)`);
      return 0;
    }

    case 'selfcheck': {
      const results = await runSelfCheck();
      for (const r of results) out(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}: ${r.detail}`);
      return results.every((r) => r.ok) ? 0 : 1;
    }

    case 'help':
    case '--help':
    case '-h':
      out(USAGE);
      return 0;

    default:
      fail(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err: unknown) => {
    if (err instanceof ConfigError || err instanceof RestoreError || err instanceof SchemaTooNewError || err instanceof DatabaseCorruptError) {
      fail(err.message);
    } else {
      fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
    process.exit(1);
  },
);
