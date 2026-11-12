# Subscriberr

Self-hosted web app that tracks and **enforces paid access to Plex and Jellyfin libraries** for a
small group of members who pay by **Interac e-Transfer**. It watches a Gmail inbox for e-Transfer
notices, matches each payment to a member, extends their paid-through date, grants/revokes library
access, and sends reminders and confirmations from the same Gmail account.

`Spec.md` is the single source of truth. `PROGRESS.md` tracks what is built so far, and
`docs/OWNER_CHECKLIST.md` lists what only the owner can verify with real accounts.

> **Status:** v1 is feature-complete (all ten milestones of the spec). It has been built and
> tested in demo mode only; the steps that need your real Google, Gmail, Plex and Jellyfin
> accounts are in `docs/OWNER_CHECKLIST.md`.

## What it does

- **Members:** a friendly display name, the name their e-Transfers arrive under (plus aliases),
  email, notes and a plan (amount / period / tolerance / grace; workspace defaults with
  per-member overrides). Search, filters, quick actions (record payment, send reminder, extend,
  pause) and bulk select → announcement. **Ctrl/⌘-K** jumps to any member.
- **Payments:** scans Gmail for Interac e-Transfer notices, checks they are genuine (Gmail's DKIM /
  DMARC verdict), matches them to a member (name, email, memo rules) and applies them. Anything
  doubtful waits in the **Review Queue**; transfers you still have to deposit wait in **Awaiting
  deposit**. Nothing is applied twice.
- **Billing:** a ledger of payments and corrections; the paid-through date, credit and status
  (active → grace → expired; paused, archived) are always replayable from it.
- **Emails:** thank-you, deficit, reminders and "access paused" emails, plus announcements, sent
  from your Gmail through a queue with a daily cap, in a template pack you can edit (live preview).
- **Plex and Jellyfin:** link each member to their existing account; a payment gives the
  libraries back, an expired or archived member loses them. The first sync is always a reviewed
  dry run, and admin accounts are never touched.
- **Safety:** nightly verified backups to a second disk, a nightly integrity + ledger check,
  CSV import with a side-by-side review and undo, CLI-only restore.

## Run it locally (demo mode — no real accounts needed)

Requires Node.js 22.

```bash
npm install
```

```bash
cp .env.example .env
```

Set `APP_SECRET` in `.env` to a long random value, then:

```bash
npm run dev
```

Open <http://localhost:5173> and click **Demo sign-in**. (`npm run build` followed by `npm start`
serves the built app from <http://localhost:3000> instead.)

Demo mode (`SEED_DEMO=true`, `DEV_FAKE_LOGIN=true`) uses a **fake Gmail** that serves the redacted
samples in `fixtures/etransfer/` and records outgoing mail instead of sending it, **fake Plex and
Jellyfin servers**, and a **fake Google sign-in**. No real service is contacted. Both switches are
refused unless `BASE_URL` is a localhost URL and `NODE_ENV` is not `production`.

In demo mode **Sign in with Google** opens a local fake consent page, so the whole OAuth flow
(state, PKCE, allowlist, first-run wizard) can be tried with any email address. Demo mode never
contacts real Google, even if Google credentials are set.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | shared (watch) + server (`tsx watch`, :3000) + web (Vite, :5173) |
| `npm run build` | Build shared, server and web |
| `npm start` | Run the built server (serves the built web app) |
| `npm test` | Vitest: unit + integration |
| `npm run e2e` | Build, then run the Playwright suite against the built app in demo mode |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript for all workspaces |

`npm run e2e` starts its own demo server on port 3210 with a temporary data folder (it never
reads your `.env`). On Windows it uses Microsoft Edge; elsewhere run
`npx playwright install chromium` once (or set `E2E_CHANNEL=chrome`).

## Configuration

All settings are environment variables; see `.env.example` for the full, commented list.

| Variable | Purpose |
|---|---|
| `BASE_URL` | Public URL users type (OAuth redirect, email links). |
| `TRUST_PROXY` | `true` behind Nginx Proxy Manager (one proxy hop), or the number of hops (e.g. `2` for Cloudflare proxy → NPM). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client (required outside demo mode). |
| `APP_SECRET` | **Required**, ≥ 32 characters. Encrypts stored tokens and keys. |
| `TZ` | Server timezone (default `America/Toronto`). |
| `PORT` | Default `3000`. |
| `DATA_DIR` | Default `/data`: database, custom template packs, logos, import staging. |
| `BACKUP_DIR` | Default `/backups`: verified backups. **Must be a different disk/share than `DATA_DIR`.** |
| `ADMIN_EMAILS` | Comma-separated emails that may always sign in. **Recommended:** when set, only these emails can claim a fresh install as Owner. |
| `PUID` / `PGID` | File ownership in the container (Unraid: `99` / `100`). |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`. |
| `DEV_FAKE_LOGIN`, `SEED_DEMO` | Local demo only. |

**Store `APP_SECRET` separately (password manager).** Backups do not contain it. If it is lost,
your data is intact but the encrypted Google token and media-server credentials become unreadable:
you re-link Google and re-enter the server credentials.

## Google sign-in

"Sign in with Google" is the only way in. One consent grants both sign-in and Gmail access
(read + label processed mail, send mail), so the Google account you sign in with is the mailbox
Subscriberr scans and sends from.

### Create the OAuth client (once)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the
   **Gmail API**.
2. **OAuth consent screen:** user type *External*; add `mediaservers.org` under **Authorized
   domains**; add the scopes `openid`, `email`, `profile`, `.../auth/gmail.modify` and
   `.../auth/gmail.send`.
3. **Publish the app ("In production").** In *Testing* mode Google expires refresh tokens after
   7 days, which disconnects Gmail every week. An unverified personal app is fine: you click
   through Google's "unverified app" warning once.
4. **Credentials → Create OAuth client ID → Web application**, with both redirect URIs:
   - `http://localhost:3000/auth/google/callback` (local development)
   - `https://subscriberr.mediaservers.org/auth/google/callback` (production)
5. Put the client id and secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

### Who can sign in

- The **first** account to sign in becomes the **Owner**. Set `ADMIN_EMAILS` before the first
  start so nobody else can claim a fresh install; the app logs a warning when it is empty.
- After that, only emails on the allowlist (Settings → *Allowed Google accounts*, or
  `ADMIN_EMAILS`) can sign in. Each gets their own isolated workspace (members, Gmail, servers,
  templates, settings); nobody can see another workspace.
- Removing someone from the allowlist signs them out immediately and blocks future sign-ins.
  Their workspace data is kept.
- Every workspace goes through a short first-run wizard (Google account, payment address and
  instructions, member defaults).

### Gmail connection

Refresh tokens are encrypted with `APP_SECRET` and never returned by the API. If Google revokes
the token (or you untick Gmail access on the consent screen), the workspace shows a
"Gmail is disconnected" banner and scanning/sending pause until you click **Reconnect Google**.
Settings → *Disconnect Google account* revokes Subscriberr's access at Google.

During `npm run dev` the Google flow returns to `http://localhost:3000/auth/google/callback` and
then back to the Vite page you started from.

## Docker

```bash
docker build -t subscriberr .
```

One container, SQLite inside it, two volumes:

- `/data` — the database (`subscriberr.db`) and `workspaces/` (custom templates, logos).
- `/backups` — nightly verified backups. **Map it to a different share or disk than `/data`.**
  The app warns loudly (dashboard + System page) if it is missing, read-only, or on the same
  filesystem as `/data`, because that is not redundancy.

`docker-compose.example.yml` shows a deployment that joins the Nginx Proxy Manager network. In
NPM, add a Proxy Host that forwards your hostname to `http://subscriberr:3000`, with *Block common
exploits*, an SSL certificate, *Force SSL* and *HTTP/2* enabled, and set `TRUST_PROXY=true` and
`BASE_URL` to the public HTTPS URL. Do not rely on NPM Access Lists for authentication.

The OAuth redirect URI, secure cookies and email links always come from `BASE_URL`, never from
request headers. With `TRUST_PROXY` the client IP (rate limiting, session list) is the address
the proxy appended to `X-Forwarded-For`. Whether the hostname is reached over LAN, Tailscale or a
Cloudflare record changes nothing in the app. If Cloudflare's proxy (orange cloud) is also in
front of NPM, either configure NPM to pass Cloudflare's real client IP or set `TRUST_PROXY=2`.
Open the app through its public `https://` URL: secure cookies are not sent over plain `http://`
on the LAN port.

`GET /healthz` is unauthenticated and backs the image's `HEALTHCHECK`.

### Unraid

`deploy/unraid/subscriberr.xml` is a Docker template with both volumes and every variable:

1. On the Unraid box, in a clone of this repository: `docker build -t subscriberr .`
2. Copy the template to `/boot/config/plugins/dockerMan/templates-user/my-subscriberr.xml`.
3. Docker → **Add Container** → Template **subscriberr**. Set `APP_SECRET`, the Google client
   id / secret and `ADMIN_EMAILS`; keep **Network** = your NPM network (default `npm_default`).
4. Check the two paths: **Data** `/mnt/user/appdata/subscriberr` and **Backups**
   `/mnt/user/backups/subscriberr`, on a different disk/share than appdata.
5. Add the NPM proxy host (above), open the `https://` address and sign in with Google.

## Using it day to day

- **Dashboard:** who is active, due within a week, in grace or expired; payments this month;
  the Review Queue; Gmail, last scan and email-queue health; backup health.
- **System** (Owner): backups (Back up now, Download with a privacy warning), the integrity
  check, jobs with **Run now**, recent errors and the log tail, and *Rescan mailbox from date*.
- **Settings:** *Payments*, *Member defaults*, *Gmail scanning*, *Allowed Google accounts*,
  *Backup retention*, *Google account*. **Emails → Email settings:** From name, daily cap, dry run,
  reminder days.

## Backups and restore

- **Nightly at 03:00** (server timezone) the app takes a consistent online snapshot and writes one
  zip to `/backups`: `subscriberr.db`, the `workspaces/` tree and a `manifest.json` (versions,
  row counts, sha256). File name: `subscriberr-YYYYMMDD-HHmmss-<kind>.zip`.
- **Every backup is verified immediately** (unzip, checksum, `PRAGMA integrity_check`, row
  counts). A backup that fails is flagged, kept for inspection and not counted.
- **Retention:** 2 daily, 4 weekly, 6 monthly. Safety snapshots are taken automatically before
  every database migration and every CSV import; the newest 3 of each kind are
  kept. The newest verified backup is never deleted.
- **Back up now** and **Download** are on the System page (Owner only). The download shows a
  privacy warning first: the zip is unencrypted and contains every workspace.
- Backups contain member names, emails and notes and are **not encrypted**. Include `/backups` in
  your off-box backup.

### Restore (command line only)

There is deliberately no restore button in the web UI. To restore:

1. **Stop the app** (stop the container).
2. Run the image once with both volumes and the `restore` command:

   ```bash
   docker run --rm -v /mnt/user/appdata/subscriberr:/data -v /mnt/user/backups/subscriberr:/backups subscriberr restore /backups/subscriberr-20261111-030000-nightly.zip
   ```

3. Start the app again.

`restore` refuses to run while the app is running, verifies the backup first, moves the current
`subscriberr.db` and `workspaces/` aside as `*.before-restore-<timestamp>` (nothing is deleted),
extracts the backup, migrates it if it is older than the app, and runs an integrity check.

Other subcommands of the image:

```bash
docker run --rm -v /mnt/user/backups/subscriberr:/backups subscriberr verify-backup /backups/<file>.zip
```

```bash
docker run --rm -v /mnt/user/appdata/subscriberr:/data subscriberr integrity-check
```

If the database is corrupt at startup the app refuses to start, prints the integrity error and
points here. It never deletes or recreates the database on its own.

## Repository layout

npm workspaces: `shared/` (Zod contracts, enums, money/date helpers), `server/` (Hono API,
SQLite, jobs) and `web/` (React + Vite + Tailwind). See Spec §4.1 for the full map.
