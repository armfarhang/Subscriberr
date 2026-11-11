import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/client.js';
import { extractZipSafely } from './safe-zip.js';

// Milestone 1 spike (Spec §18): proves the native / heavyweight dependencies load and work in
// the target environment. Run with `node dist/cli.js selfcheck` (the Docker build does).
// Nothing here touches the network.

export interface SelfCheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function check(name: string, fn: () => Promise<string>): Promise<SelfCheckResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function runSelfCheck(): Promise<SelfCheckResult[]> {
  const results: SelfCheckResult[] = [];

  results.push(
    await check('better-sqlite3', async () => {
      const db = openDatabase(':memory:');
      try {
        db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, j TEXT CHECK (json_valid(j))) STRICT`);
        db.prepare('INSERT INTO t (j) VALUES (?)').run('{"a":1}');
        const row = db.prepare(`SELECT sqlite_version() AS v, json_extract(j, '$.a') AS a FROM t`).get() as { v: string; a: number };
        if (row.a !== 1) throw new Error('JSON1 not working');
        return `SQLite ${row.v} (STRICT + JSON1)`;
      } finally {
        db.close();
      }
    }),
  );

  results.push(
    await check('googleapis', async () => {
      const { google } = await import('googleapis');
      const client = new google.auth.OAuth2('client-id', 'client-secret', 'http://localhost:3000/auth/google/callback');
      const url = client.generateAuthUrl({ access_type: 'offline', scope: ['openid'] });
      if (!url.startsWith('https://accounts.google.com/')) throw new Error('unexpected auth URL');
      if (typeof google.gmail !== 'function') throw new Error('gmail API missing');
      return 'OAuth2 client + gmail API constructed (no network)';
    }),
  );

  results.push(
    await check('mailparser', async () => {
      const { simpleParser } = await import('mailparser');
      const raw = ['From: "PAYER ONE" <notify@payments.interac.ca>', 'Subject: =?UTF-8?Q?caf=C3=A9?=', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Amount: $10.00 =', '(CAD)', ''].join('\r\n');
      const mail = await simpleParser(raw);
      if (mail.subject !== 'café') throw new Error(`subject decoded as ${mail.subject}`);
      if (!mail.text?.includes('Amount: $10.00 (CAD)')) throw new Error('quoted-printable soft break not decoded');
      return 'parsed MIME headers + quoted-printable body';
    }),
  );

  results.push(
    await check('juice', async () => {
      const { default: juice } = await import('juice');
      const html = juice('<style>p{color:red}</style><p>x</p>');
      if (!/<p style="color: ?red;?">/.test(html)) throw new Error(`unexpected output: ${html}`);
      return 'inlined CSS';
    }),
  );

  results.push(
    await check('nodemailer (MailComposer)', async () => {
      const { default: MailComposer } = await import('nodemailer/lib/mail-composer/index.js');
      const message = await new MailComposer({ from: 'a@example.com', to: 'b@example.com', subject: 'hi', text: 't', html: '<b>t</b>' }).compile().build();
      if (!message.toString('utf8').includes('multipart/alternative')) throw new Error('expected multipart/alternative');
      return 'built multipart/alternative MIME';
    }),
  );

  results.push(
    await check('archiver + yauzl', async () => {
      const { ZipArchive } = await import('archiver');
      const dir = mkdtempSync(path.join(os.tmpdir(), 'subscriberr-selfcheck-'));
      try {
        const zipFile = path.join(dir, 'a.zip');
        await new Promise<void>((resolve, reject) => {
          const out = createWriteStream(zipFile);
          const archive = new ZipArchive({ zlib: { level: 6 } });
          out.on('close', () => resolve());
          archive.on('error', reject);
          archive.pipe(out);
          archive.append('hello', { name: 'nested/hello.txt' });
          void archive.finalize();
        });
        const out = path.join(dir, 'out');
        mkdirSync(out, { recursive: true });
        const files = await extractZipSafely(zipFile, out, { maxEntries: 10, maxTotalBytes: 1024, maxEntryBytes: 1024 });
        if (readFileSync(path.join(out, 'nested', 'hello.txt'), 'utf8') !== 'hello') throw new Error('round trip mismatch');
        return `zip round trip (${files.length} file)`;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  return results;
}
