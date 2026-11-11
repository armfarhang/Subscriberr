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

## Later milestones (placeholders — detailed steps are added when each lands)
- [ ] **M2:** create the Google OAuth client, set the consent screen to *In production*, register
      both redirect URIs, first real sign-in, NPM proxy host + certificate, `TRUST_PROXY`.
- [ ] **M5/M6:** first real Gmail scan; send a real e-Transfer and watch it flow end to end.
- [ ] **M7:** check the email template in Gmail (web + mobile), Apple Mail and Outlook.
- [ ] **M9:** verify Plex **empty-library revoke** behaviour and the Plex endpoints; verify
      Jellyfin policy changes.
