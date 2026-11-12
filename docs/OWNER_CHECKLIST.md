# Owner checklist

Things that can only be verified with real accounts or on the real server. Everything else is
covered by automated tests against demo mode. Items are added as milestones land.

## After Milestone 1 (Foundation)

### Local demo
- [ ] `npm install`, copy `.env.example` to `.env`, set `APP_SECRET`, run `npm run dev`, open
      <http://localhost:5173>, click **Demo sign-in**. The dark shell, dashboard and System page load.
- [ ] System → **Back up now** creates a verified backup that appears in the list.

### Docker / Unraid
- [ ] Build the image (`docker build -t subscriberr .`) on the Unraid box or your build machine.
      The build runs `selfcheck`, which fails the build if a native dependency does not load.
- [ ] Map **two** volumes: `/data` → `/mnt/user/appdata/subscriberr` and `/backups` →
      `/mnt/user/backups/subscriberr` (a different share, ideally a different disk or the array,
      not the same cache SSD as appdata).
- [ ] After the first start, the System page shows **"Separate disk from data: Yes"**. If it
      shows "No — same filesystem", remap `/backups`.
- [ ] Files in both host paths are owned by `PUID:PGID` (`99:100` on Unraid). If the paths
      already contain files owned by another user, fix ownership once (`chown -R 99:100 <path>`);
      the container only adjusts the top-level folders.
- [ ] Generate a real `APP_SECRET` (≥ 32 characters) and **store a copy in your password
      manager**. Backups do not include it.

### Restore drill (do this once before you depend on the app)
- [ ] Let a nightly backup happen (or use **Back up now**).
- [ ] Stop the container.
- [ ] `docker run --rm -v <data>:/data -v <backups>:/backups subscriberr verify-backup /backups/<file>.zip` prints `OK`.
- [ ] `docker run --rm -v <data>:/data -v <backups>:/backups subscriberr restore /backups/<file>.zip`
      succeeds and lists the `*.before-restore-*` paths it kept.
- [ ] Start the container: the app boots and the data is the backup's data.
- [ ] Delete the `*.before-restore-*` copies in `/data` once you are satisfied.
- [ ] Confirm `/backups` is included in your off-box backup (Appdata Backup plugin or cloud sync).

## After Milestone 2 (Auth & workspaces)

Everything below was tested against a fake Google; only you can try it with the real one.

### Google OAuth client (README → "Google sign-in")
- [ ] Create the Google Cloud project, enable the **Gmail API**, configure the consent screen
      (External, authorized domain `mediaservers.org`, scopes `openid email profile gmail.modify gmail.send`).
- [ ] **Publish the consent screen ("In production").** Otherwise Gmail disconnects every 7 days.
- [ ] Create a *Web application* OAuth client with **both** redirect URIs:
      `http://localhost:3000/auth/google/callback` and `https://subscriberr.mediaservers.org/auth/google/callback`.
- [ ] Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and **`ADMIN_EMAILS=<your Gmail>`** before the first start.

### Nginx Proxy Manager
- [ ] Proxy host `subscriberr.mediaservers.org` → `http://subscriberr:3000`, Let's Encrypt
      certificate, *Force SSL*, *HTTP/2*, *Block common exploits*. Container on NPM's Docker network.
- [ ] `BASE_URL=https://subscriberr.mediaservers.org`, `TRUST_PROXY=true`.
- [ ] If the Cloudflare record is proxied (orange cloud): set `TRUST_PROXY=2` or make NPM pass
      the real client IP (it is used for sign-in rate limiting).

### First real sign-in (local first, then production)
- [ ] Locally, with `SEED_DEMO=false` and `DEV_FAKE_LOGIN=false`: **Sign in with Google**
      → Google's real consent screen (accept the "unverified app" warning) → you land in the
      first-run wizard as **Owner**, Gmail shows **Connected**.
- [ ] Untick Gmail access on the consent screen once: the app signs you in but shows
      "Gmail is disconnected"; *Reconnect Google* fixes it.
- [ ] Settings → *Disconnect Google account*: at <https://myaccount.google.com/permissions>
      Subscriberr's access is gone; *Reconnect Google* restores it.
- [ ] Add a second Google account to the allowlist, sign in with it in a private window: it gets
      its own empty workspace and wizard. Remove it again: that window is signed out on its next action.
- [ ] A Google account **not** on the allowlist sees "This Google account is not allowed to sign in".
- [ ] Production: repeat the first sign-in through `https://subscriberr.mediaservers.org`.

## After Milestone 3 (Members)
Nothing here needs a real account; these are quick sanity checks with your own data.
- [ ] Add a few real members (display name + the name exactly as it appears on their
      e-Transfers + email). Leave the plan fields empty unless someone pays a different amount.
- [ ] Change the plan amount in Settings → Member defaults: members showing *Workspace default*
      follow it, members marked *Custom* keep theirs.
- [ ] If two people send e-Transfers under the same name, give each a memo code and tell them to
      put it in the e-Transfer message. Both members should show the "shared name" warning until then.
- [ ] Look up an old e-Transfer from someone who sometimes pays from another account or name, and
      add that as an alias on the member.

## Later milestones (placeholders — detailed steps are added when each lands)
- [ ] **M5/M6:** first real Gmail scan; send a real e-Transfer and watch it flow end to end.
- [ ] **M7:** check the email template in Gmail (web + mobile), Apple Mail and Outlook.
- [ ] **M9:** verify Plex **empty-library revoke** behaviour and the Plex endpoints; verify
      Jellyfin policy changes.
