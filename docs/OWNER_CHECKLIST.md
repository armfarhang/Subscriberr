# Owner checklist

Things that can only be verified with real accounts or on the real server. Everything else is
covered by automated tests (unit, integration and a Playwright e2e suite) against demo mode.

**Suggested order:** M1 Docker/Unraid → M2 Google client + first sign-in → M3/M4 your members →
M5 a real e-Transfer → M6 opening balances → M7 test emails → M9 one test member on each server
→ M10 → the end-to-end "go-live" check at the bottom.

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

## After Milestone 4 (CSV import / export)
- [ ] Export your members and open the file in **Excel** and in **Google Sheets**: accents
      (é, ü…) display correctly, and a note starting with `=` shows as text, not a formula.
- [ ] If you keep members in an old spreadsheet, import it: Import / export → choose the file →
      check the column matching → review every flagged row (the side-by-side view) → Import.
      Save the column matching as a preset if you will import that sheet again.
- [ ] Save the file from Excel as "CSV (Comma delimited)" (Windows encoding) and as "CSV UTF-8"
      and import both: names with accents must come through the same.
- [ ] After an import, open one updated member: the timeline shows "Balance set … (CSV import #n)".
      Then try **Undo this import** once on a test import, within 24 hours.
- [ ] Check the safety backup appears under System → Backups as `pre_import`.

## After Milestone 5 (Gmail ingestion)
Needs real Google sign-in (Milestone 2 checklist) with `SEED_DEMO=false`.
- [ ] Payments → **Scan now**. The first scan reads the last 30 days (Settings → Gmail scanning).
      Each e-Transfer notice appears once, with "Verified by Gmail (DKIM pass, DMARC pass)".
- [ ] In Gmail, those messages carry the labels **Subscriberr/Processed** (and
      **Subscriberr/NeedsReview** for the ones waiting for you). Nothing is deleted or archived.
- [ ] Press Scan now again: nothing new is added (idempotent). Then System → **Rescan mailbox from
      date** with an older date: the dry run lists only notices the app had not seen.
- [ ] If e-Transfers arrive at another address, set it to auto-forward to this Gmail and check a
      forwarded notice still shows "Verified by Gmail".
- [ ] Send yourself a test e-Transfer from a second bank account (any amount): it appears within
      ~5 minutes and matches the member whose e-Transfer name equals your bank's sender name.
- [ ] A bank's own alert email (e.g. "Interac e-Transfer sent") never shows up as a payment.
- [ ] Look at a **current** "sent you money" (not auto-deposit) notice if you ever get one: the
      fixtures only include a 2017 layout. If it shows up in Review with "Unrecognized", send a
      redacted copy so the parser can learn it.

## Milestones 6–9 (billing, emails, announcements, media servers)
- [ ] **M6 (billing):** after a real e-Transfer is matched, the member's due date moves forward by the
      right number of periods (Member → Balance → History shows the entry). Pay a little early: the new
      period stacks on the old due date. Send less than the plan amount: nothing extends, it is held as
      credit, and the next payment tops it up.
- [ ] **M6:** for an existing member, use Balance → **Set balance** to enter their current paid-through
      date once (opening balance), instead of waiting for their next payment.
- [ ] **M6:** System page → "Integrity + ledger check" shows OK the morning after (it runs at 03:30).
- [ ] **M7:** Templates → **Send test to me** for each kind (thank-you, deficit, reminder, access paused,
      announcement). Check them in **Gmail web**, the **Gmail app** (iOS/Android), **Apple Mail** and
      **Outlook**, in light and dark mode. Report anything broken (layout, colours, images).
- [ ] **M7:** Emails → set your **From name** (e.g. your server's name). Send a test and confirm the sender
      shows as "Name <your Gmail>" and that replies come to your Gmail.
- [ ] **M7:** the test emails appear in Gmail's **Sent** folder (they are real messages from your account).
- [ ] **M7:** optionally turn on **Dry run** for the first day after go-live: the Emails page lists what would
      have been sent (thank-yous, reminders) without sending anything. Turn it off when it looks right.
- [ ] **M7:** customise: duplicate the default pack, add your logo (Files → Add image) and reference it as
      `<img src="assets/logo.png">`, set colours in Theme, then **Use for all emails**.
- [ ] **M8:** send a small announcement to yourself first (audience "Hand-picked members", pick a member
      whose email is yours), check it in your inbox, then send the real one. Each member gets their own
      copy (no shared To/CC). A large announcement continues the next day(s) on its own; the Emails page
      shows how much of the daily limit is used.
- [ ] **M9 Jellyfin:** Jellyfin Dashboard → API Keys → create one for Subscriberr. Servers → Add server
      (address like `http://<unraid-ip>:8096`) → **Test connection** shows the server name and version.
      Users and libraries appear; administrators are marked "Admin (never changed)".
- [ ] **M9 Plex:** find your Plex token (Plex Web → any item → ⋯ → Get Info → View XML → `X-Plex-Token=`
      in the address). Add the server (`http://<unraid-ip>:32400`) → **Test connection** (it learns the
      machine id). Check that friends who **accepted** your share are listed as users, that open
      invitations show as "Invitation pending", and that libraries are listed.
- [ ] **M9:** choose the **default libraries** of each server, then link each member to their account
      (member page → Media servers → Link).
- [ ] **M9 test member first:** link a test account (a second Plex / Jellyfin user you own), turn on
      **Enforce access**, press **Preview changes (dry run)** and read the plan carefully. Only then
      **Apply**. Every later change happens automatically.
- [ ] **M9 Plex empty-library revoke (important, unverified):** with the test account expired, apply the
      plan: in Plex Web → Settings → Manage Library Access the test user should still be listed as a
      friend/share but with **no libraries**. If Plex refuses (Servers page shows "Plex refused the
      library change"), report it: the app does not remove the share on its own.
- [ ] **M9:** record a payment for the test member → within a minute the libraries come back (same set).
      Archive the member → access is removed. Pause → nothing changes.
- [ ] **M9 Jellyfin:** after a revoke, the user's Policy shows "Enable access to all libraries" off and no
      library ticked. Optionally test "Also disable the user" and "Stop their streams" on the test account.
- [ ] **M9:** your own admin/owner account never changes (it is never even offered for linking).

## After Milestone 10 (Polish)
- [ ] **Unraid template:** build the image on the box (`docker build -t subscriberr .`), copy
      `deploy/unraid/subscriberr.xml` to `/boot/config/plugins/dockerMan/templates-user/my-subscriberr.xml`,
      add the container from it. Check both paths, the masked `APP_SECRET` / client secret, and that
      **Network** is the network your NPM container uses (template default `npm_default`).
- [ ] **Dashboard** after a few days of real use: the counts match the Members filters, "Payments this
      month" matches your bank for the month, and the Health card shows Gmail connected and a recent scan.
- [ ] **System → Jobs:** after a night, *Nightly backup*, *Integrity + ledger check* and *Daily run* show
      **OK** with a recent "last run". Try **Run now** on *Gmail scan*.
- [ ] **System → Download** a backup once: read the privacy warning, save it somewhere private, open
      the zip (it contains `subscriberr.db`, `workspaces/`, `manifest.json`), then delete that copy.
- [ ] **Members list quick actions** on a test member: *Send reminder* (arrives in their inbox in your
      template), *Extend…* (moves the paid-through date, shown in Balance → History), *Pause* / *Reactivate*.
- [ ] Select two members (yourself and a test address) → **Announcement to selected** → send.

## Go-live check (Spec §18 "Definition of done")
- [ ] Behind NPM on Unraid, sign in with Google at your https address.
- [ ] Add a member linked to a Plex or Jellyfin account, with a plan.
- [ ] Send a real e-Transfer to the mailbox: within ~5 minutes it is detected, shown as verified,
      matched, applied, the due date moves, library access is granted and the thank-you email arrives
      in your customised template.
- [ ] Send less than the plan amount: a deficit email arrives and nothing is extended.
- [ ] Let a test member's grace period run out: their library access is removed the next day.
- [ ] Export the members CSV, edit it, re-import it through the side-by-side review, then **Undo** it.
