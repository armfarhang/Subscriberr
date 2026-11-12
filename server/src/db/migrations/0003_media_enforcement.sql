-- M9: media-server enforcement (Spec §10.2).
-- Per-server options (non-secret) and whether the first sync (always a dry run) was approved.
ALTER TABLE media_servers ADD COLUMN options TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options));
ALTER TABLE media_servers ADD COLUMN enforcement_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (enforcement_confirmed IN (0, 1));
-- Per-link work queue: a sync is pending (set by billing events), and retries with backoff.
ALTER TABLE member_server_accounts ADD COLUMN sync_pending INTEGER NOT NULL DEFAULT 0 CHECK (sync_pending IN (0, 1));
ALTER TABLE member_server_accounts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE member_server_accounts ADD COLUMN next_attempt_at TEXT;
CREATE INDEX member_server_accounts_pending_idx ON member_server_accounts (account_id, sync_pending);
