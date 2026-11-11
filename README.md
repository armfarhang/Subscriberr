# Subscriberr

Self-hosted web app that tracks and **enforces paid access to Plex and Jellyfin libraries** for a
small group of members who pay by **Interac e-Transfer**. It watches a Gmail inbox for e-Transfer
notices, matches each payment to a member, extends their paid-through date, grants/revokes library
access, and sends reminders and confirmations from the same Gmail account.

`Spec.md` is the single source of truth. `PROGRESS.md` tracks what is built so far, and
`docs/OWNER_CHECKLIST.md` lists what only the owner can verify with real accounts.

> **Status:** Milestone 1 (Foundation) is complete. Real Google sign-in, members, payments, email
> and media-server enforcement arrive in milestones 2–10.

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

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | shared (watch) + server (`tsx watch`, :3000) + web (Vite, :5173) |
| `npm run build` | Build shared, server and web |
| `npm start` | Run the built server (serves the built web app) |
| `npm test` | Vitest: unit + integration |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript for all workspaces |

## Configuration

All settings are environment variables; see `.env.example` for the full, commented list.

| Variable | Purpose |
|---|---|
| `BASE_URL` | Public URL users type (OAuth redirect, email links). |
| `TRUST_PROXY` | `true` behind Nginx Proxy Manager (honour `X-Forwarded-*`). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client (required outside demo mode). |
| `APP_SECRET` | **Required**, ≥ 32 characters. Encrypts stored tokens and keys. |
| `TZ` | Server timezone (default `America/Toronto`). |
| `PORT` | Default `3000`. |
| `DATA_DIR` | Default `/data`: database, custom template packs, logos, import staging. |
| `BACKUP_DIR` | Default `/backups`: verified backups. **Must be a different disk/share than `DATA_DIR`.** |
| `ADMIN_EMAILS` | Optional allowlist seed. |
| `PUID` / `PGID` | File ownership in the container (Unraid: `99` / `100`). |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`. |
| `DEV_FAKE_LOGIN`, `SEED_DEMO` | Local demo only. |

**Store `APP_SECRET` separately (password manager).** Backups do not contain it. If it is lost,
your data is intact but the encrypted Google token and media-server credentials become unreadable:
you re-link Google and re-enter the server credentials.

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

`GET /healthz` is unauthenticated and backs the image's `HEALTHCHECK`.

## Backups and restore

- **Nightly at 03:00** (server timezone) the app takes a consistent online snapshot and writes one
  zip to `/backups`: `subscriberr.db`, the `workspaces/` tree and a `manifest.json` (versions,
  row counts, sha256). File name: `subscriberr-YYYYMMDD-HHmmss-<kind>.zip`.
- **Every backup is verified immediately** (unzip, checksum, `PRAGMA integrity_check`, row
  counts). A backup that fails is flagged, kept for inspection and not counted.
- **Retention:** 2 daily, 4 weekly, 6 monthly. Safety snapshots are taken automatically before
  every database migration (and, later, before every CSV import); the newest 3 of each kind are
  kept. The newest verified backup is never deleted.
- **Back up now** is on the System page (Owner only).
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
