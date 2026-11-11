-- Subscriberr schema v1 (Spec §6). Hand-authored: drizzle-kit cannot emit STRICT tables,
-- triggers or partial indexes. Forward-only; never edit after release — add 0002_*.sql instead.
--
-- Conventions (§6.0): money = integer cents; instants = UTC ISO-8601 TEXT; calendar dates =
-- YYYY-MM-DD TEXT; every table STRICT; enums/booleans/JSON guarded by CHECK; workspace-scoped
-- tables carry account_id + UNIQUE (account_id, id) and children use composite foreign keys.

------------------------------------------------------------------------------------------------
-- Platform
------------------------------------------------------------------------------------------------

CREATE TABLE meta (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE accounts (
  id                INTEGER PRIMARY KEY,
  google_sub        TEXT NOT NULL UNIQUE,
  email             TEXT NOT NULL UNIQUE,
  role              TEXT NOT NULL CHECK (role IN ('owner', 'operator')),
  gmail_status      TEXT NOT NULL DEFAULT 'disconnected'
                    CHECK (gmail_status IN ('connected', 'disconnected', 'error')),
  refresh_token_enc TEXT,
  scopes            TEXT,
  timezone          TEXT NOT NULL DEFAULT 'America/Toronto',
  created_at        TEXT NOT NULL
) STRICT;

CREATE TABLE allowed_accounts (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  email      TEXT NOT NULL UNIQUE,
  added_by   TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id           TEXT NOT NULL PRIMARY KEY, -- sha256 of the cookie value, never the value itself
  account_id   INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT,
  ip           TEXT
) STRICT;
CREATE INDEX sessions_account_idx ON sessions (account_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE settings (
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  PRIMARY KEY (account_id, key)
) STRICT;

CREATE TABLE job_runs (
  id          INTEGER PRIMARY KEY,
  job         TEXT NOT NULL,
  account_id  INTEGER REFERENCES accounts (id) ON DELETE CASCADE, -- NULL for global jobs
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
  error       TEXT,
  stats       TEXT CHECK (stats IS NULL OR json_valid(stats))
) STRICT;
CREATE INDEX job_runs_job_idx ON job_runs (job, started_at);

CREATE TABLE backup_runs (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('nightly', 'manual', 'pre_migration', 'pre_import')),
  tier           TEXT NOT NULL CHECK (tier IN ('daily', 'weekly', 'monthly', 'safety')),
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  file           TEXT,
  bytes          INTEGER,
  sha256         TEXT,
  schema_version INTEGER,
  verified       INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  verified_at    TEXT,
  pruned_at      TEXT, -- set when the retention pruner removed the file (row kept as history)
  error          TEXT
) STRICT;
CREATE INDEX backup_runs_started_idx ON backup_runs (started_at);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL, -- 'admin:<email>' | 'system'
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  details    TEXT CHECK (details IS NULL OR json_valid(details))
) STRICT;
CREATE INDEX audit_log_entity_idx ON audit_log (account_id, entity, entity_id, at);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

------------------------------------------------------------------------------------------------
-- Import (declared before members because members.import_batch_id references it)
------------------------------------------------------------------------------------------------

CREATE TABLE import_batches (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'staged'
               CHECK (status IN ('staged', 'committed', 'undone', 'abandoned')),
  mapping      TEXT CHECK (mapping IS NULL OR json_valid(mapping)),
  created_at   TEXT NOT NULL,
  committed_at TEXT,
  undone_at    TEXT,
  UNIQUE (account_id, id)
) STRICT;

------------------------------------------------------------------------------------------------
-- People
------------------------------------------------------------------------------------------------

CREATE TABLE members (
  id                 INTEGER PRIMARY KEY,
  account_id         INTEGER NOT NULL REFERENCES accounts (id),
  display_name       TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  etransfer_name     TEXT,
  payment_memo_code  TEXT,
  email              TEXT,
  notes              TEXT,
  plan_amount_cents  INTEGER CHECK (plan_amount_cents IS NULL OR plan_amount_cents > 0), -- NULL = inherit
  plan_period_days   INTEGER CHECK (plan_period_days IS NULL OR plan_period_days > 0),   -- NULL = inherit
  currency           TEXT NOT NULL DEFAULT 'CAD',
  tolerance_cents    INTEGER CHECK (tolerance_cents IS NULL OR tolerance_cents >= 0),    -- NULL = inherit
  grace_days         INTEGER CHECK (grace_days IS NULL OR grace_days >= 0),              -- NULL = inherit
  -- Caches derived from ledger_entries (§6.5a). Written only by the billing module.
  last_payment_at    TEXT,
  paid_through       TEXT,
  credit_cents       INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  status             TEXT NOT NULL DEFAULT 'expired'
                     CHECK (status IN ('active', 'grace', 'expired', 'paused', 'archived')),
  reminders_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (reminders_enabled IN (0, 1)),
  emails_enabled     INTEGER NOT NULL DEFAULT 1 CHECK (emails_enabled IN (0, 1)),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  import_batch_id    INTEGER,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, import_batch_id) REFERENCES import_batches (account_id, id)
) STRICT;
CREATE INDEX members_status_idx ON members (account_id, status);
CREATE INDEX members_paid_through_idx ON members (account_id, paid_through);
CREATE UNIQUE INDEX members_memo_code_uq ON members (account_id, payment_memo_code)
  WHERE payment_memo_code IS NOT NULL;

CREATE TABLE member_aliases (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  member_id  INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('name', 'email')),
  value      TEXT NOT NULL, -- normalized: case-folded, diacritics stripped, whitespace collapsed
  source     TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'learned', 'import')),
  created_at TEXT NOT NULL,
  UNIQUE (account_id, kind, value),
  FOREIGN KEY (account_id, member_id) REFERENCES members (account_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX member_aliases_value_idx ON member_aliases (account_id, value);
CREATE INDEX member_aliases_member_idx ON member_aliases (account_id, member_id);

CREATE TABLE matching_rules (
  id               INTEGER PRIMARY KEY,
  account_id       INTEGER NOT NULL,
  member_id        INTEGER NOT NULL,
  label            TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  priority         INTEGER NOT NULL DEFAULT 100,
  managed          INTEGER NOT NULL DEFAULT 0 CHECK (managed IN (0, 1)), -- generated from payment_memo_code
  sender_name      TEXT,
  sender_email     TEXT,
  memo_mode        TEXT CHECK (memo_mode IS NULL OR memo_mode IN ('contains', 'equals', 'regex')),
  memo_value       TEXT,
  amount_min_cents INTEGER,
  amount_max_cents INTEGER,
  action           TEXT NOT NULL DEFAULT 'assign' CHECK (action IN ('assign', 'review')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (account_id, id),
  CHECK ((memo_mode IS NULL) = (memo_value IS NULL)),
  FOREIGN KEY (account_id, member_id) REFERENCES members (account_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX matching_rules_priority_idx ON matching_rules (account_id, enabled, priority);

------------------------------------------------------------------------------------------------
-- Media
------------------------------------------------------------------------------------------------

CREATE TABLE media_servers (
  id                  INTEGER PRIMARY KEY,
  account_id          INTEGER NOT NULL REFERENCES accounts (id),
  type                TEXT NOT NULL CHECK (type IN ('plex', 'jellyfin')),
  name                TEXT NOT NULL,
  base_url            TEXT NOT NULL,
  credentials_enc     TEXT,
  enforcement_enabled INTEGER NOT NULL DEFAULT 0 CHECK (enforcement_enabled IN (0, 1)),
  default_library_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(default_library_ids)),
  enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_checked_at     TEXT,
  last_status         TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (account_id, id),
  UNIQUE (account_id, name)
) STRICT;

CREATE TABLE member_server_accounts (
  id                        INTEGER PRIMARY KEY,
  account_id                INTEGER NOT NULL,
  member_id                 INTEGER NOT NULL,
  server_id                 INTEGER NOT NULL,
  external_user_id          TEXT NOT NULL,
  external_username         TEXT,
  external_email            TEXT,
  library_ids_override      TEXT CHECK (library_ids_override IS NULL OR json_valid(library_ids_override)),
  last_granted_library_ids  TEXT CHECK (last_granted_library_ids IS NULL OR json_valid(last_granted_library_ids)),
  access_state              TEXT NOT NULL DEFAULT 'unknown'
                            CHECK (access_state IN ('granted', 'revoked', 'unknown', 'error')),
  last_synced_at            TEXT,
  last_error                TEXT,
  UNIQUE (member_id, server_id),
  UNIQUE (account_id, server_id, external_user_id),
  FOREIGN KEY (account_id, member_id) REFERENCES members (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, server_id) REFERENCES media_servers (account_id, id) ON DELETE CASCADE
) STRICT;

------------------------------------------------------------------------------------------------
-- Money
------------------------------------------------------------------------------------------------

CREATE TABLE gmail_scan_state (
  account_id      INTEGER NOT NULL PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  last_history_id TEXT,
  last_scan_at    TEXT,
  last_success_at TEXT,
  last_error      TEXT
) STRICT;

CREATE TABLE payments (
  id                INTEGER PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES accounts (id),
  member_id         INTEGER, -- NULL until matched
  amount_cents      INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0), -- NULL when unparseable
  currency          TEXT NOT NULL DEFAULT 'CAD',
  received_at       TEXT NOT NULL,
  sender_name       TEXT,
  sender_email      TEXT,
  interac_reference TEXT,
  gmail_message_id  TEXT,
  gmail_thread_id   TEXT,
  memo              TEXT, -- auto-deposit only (§7.2); never stored for awaiting-deposit transfers
  message_type      TEXT NOT NULL CHECK (message_type IN ('autodeposit', 'awaiting_deposit', 'manual')),
  expires_on        TEXT,
  status            TEXT NOT NULL CHECK (status IN (
                      'matched', 'unmatched', 'needs_review', 'underpaid', 'overpaid', 'pending_deposit',
                      'expired', 'duplicate', 'rejected', 'manual', 'voided')),
  matched_by        TEXT CHECK (matched_by IS NULL OR matched_by IN ('name', 'email', 'rule', 'manual')),
  matched_rule_id   INTEGER,
  review_reason     TEXT,
  resolved_by       TEXT,
  resolved_at       TEXT,
  void_reason       TEXT,
  source            TEXT NOT NULL CHECK (source IN ('gmail', 'manual')),
  raw_snapshot      TEXT CHECK (raw_snapshot IS NULL OR json_valid(raw_snapshot)),
  created_at        TEXT NOT NULL,
  UNIQUE (account_id, id),
  UNIQUE (account_id, gmail_message_id),
  CHECK (message_type = 'awaiting_deposit' OR expires_on IS NULL),
  CHECK (message_type <> 'awaiting_deposit' OR memo IS NULL),
  FOREIGN KEY (account_id, member_id) REFERENCES members (account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, matched_rule_id) REFERENCES matching_rules (account_id, id)
) STRICT;
CREATE INDEX payments_status_idx ON payments (account_id, status);
CREATE INDEX payments_member_idx ON payments (account_id, member_id, received_at);
-- Idempotency (§7.6): one live row per Interac reference; later copies are stored as 'duplicate'.
CREATE UNIQUE INDEX payments_reference_uq ON payments (account_id, interac_reference)
  WHERE status <> 'duplicate';

-- Payments are never deleted (§6.5).
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
BEGIN
  SELECT RAISE(ABORT, 'payments are never deleted');
END;

-- Deleting a rule keeps the payments it matched; only the pointer is cleared.
CREATE TRIGGER matching_rules_detach_payments BEFORE DELETE ON matching_rules
BEGIN
  UPDATE payments SET matched_rule_id = NULL
   WHERE account_id = OLD.account_id AND matched_rule_id = OLD.id;
END;

CREATE TABLE ledger_entries (
  -- identity (immutable)
  id                         INTEGER PRIMARY KEY,
  account_id                 INTEGER NOT NULL,
  member_id                  INTEGER NOT NULL,
  created_at                 TEXT NOT NULL,
  created_by                 TEXT NOT NULL, -- 'admin:<email>' | 'system'
  note                       TEXT,
  -- inputs (immutable)
  kind                       TEXT NOT NULL CHECK (kind IN ('payment', 'manual_set', 'manual_adjust', 'void')),
  payment_id                 INTEGER,
  reverses_entry_id          INTEGER,
  effective_at               TEXT NOT NULL, -- ordering key
  amount_cents               INTEGER NOT NULL DEFAULT 0,
  plan_amount_snapshot_cents INTEGER,
  period_days_snapshot       INTEGER,
  tolerance_snapshot_cents   INTEGER,
  set_paid_through           TEXT,
  set_credit_cents           INTEGER CHECK (set_credit_cents IS NULL OR set_credit_cents >= 0),
  adjust_days                INTEGER,
  adjust_credit_cents        INTEGER,
  -- outputs (rewritten only by the replay routine)
  periods_applied            INTEGER NOT NULL DEFAULT 0,
  days_delta                 INTEGER NOT NULL DEFAULT 0,
  credit_delta_cents         INTEGER NOT NULL DEFAULT 0,
  forgiven_cents             INTEGER NOT NULL DEFAULT 0,
  paid_through_before        TEXT,
  paid_through_after         TEXT,
  credit_before_cents        INTEGER NOT NULL DEFAULT 0,
  credit_after_cents         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account_id, id),
  CHECK ((kind = 'void') = (reverses_entry_id IS NOT NULL)),
  FOREIGN KEY (account_id, member_id) REFERENCES members (account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, payment_id) REFERENCES payments (account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, reverses_entry_id) REFERENCES ledger_entries (account_id, id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ledger_member_idx ON ledger_entries (account_id, member_id, effective_at);
CREATE INDEX ledger_payment_idx ON ledger_entries (account_id, payment_id);
-- An entry can be reversed at most once.
CREATE UNIQUE INDEX ledger_reverses_uq ON ledger_entries (account_id, reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;

CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;
CREATE TRIGGER ledger_entries_inputs_immutable
BEFORE UPDATE OF
  id, account_id, member_id, created_at, created_by, note,
  kind, payment_id, reverses_entry_id, effective_at, amount_cents,
  plan_amount_snapshot_cents, period_days_snapshot, tolerance_snapshot_cents,
  set_paid_through, set_credit_cents, adjust_days, adjust_credit_cents
ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries identity and input columns are immutable');
END;

------------------------------------------------------------------------------------------------
-- Email
------------------------------------------------------------------------------------------------

CREATE TABLE announcements (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  audience   TEXT NOT NULL CHECK (json_valid(audience)),
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'cancelled')),
  created_at TEXT NOT NULL,
  UNIQUE (account_id, id)
) STRICT;

CREATE TABLE email_queue (
  id               INTEGER PRIMARY KEY,
  account_id       INTEGER NOT NULL REFERENCES accounts (id),
  kind             TEXT NOT NULL CHECK (kind IN ('reminder', 'thanks', 'deficit', 'expired', 'announcement', 'test')),
  member_id        INTEGER,
  to_address       TEXT NOT NULL,
  subject          TEXT NOT NULL,
  html             TEXT NOT NULL,
  text             TEXT NOT NULL,
  priority         INTEGER NOT NULL DEFAULT 100,
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  not_before       TEXT,
  sent_at          TEXT,
  gmail_message_id TEXT,
  error            TEXT,
  dedupe_key       TEXT,
  announcement_id  INTEGER,
  template_pack    TEXT,
  template_version TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (account_id, id),
  UNIQUE (account_id, dedupe_key),
  FOREIGN KEY (account_id, member_id) REFERENCES members (account_id, id),
  FOREIGN KEY (account_id, announcement_id) REFERENCES announcements (account_id, id)
) STRICT;
CREATE INDEX email_queue_drain_idx ON email_queue (status, not_before);
CREATE INDEX email_queue_sent_idx ON email_queue (account_id, sent_at);

------------------------------------------------------------------------------------------------
-- Import staging
------------------------------------------------------------------------------------------------

CREATE TABLE import_rows (
  id                INTEGER PRIMARY KEY,
  account_id        INTEGER NOT NULL,
  batch_id          INTEGER NOT NULL,
  row_number        INTEGER NOT NULL,
  raw               TEXT NOT NULL CHECK (json_valid(raw)),
  matched_member_id INTEGER,
  action            TEXT NOT NULL DEFAULT 'skip' CHECK (action IN ('create', 'update', 'skip')),
  edits             TEXT CHECK (edits IS NULL OR json_valid(edits)),
  errors            TEXT CHECK (errors IS NULL OR json_valid(errors)),
  UNIQUE (batch_id, row_number),
  FOREIGN KEY (account_id, batch_id) REFERENCES import_batches (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, matched_member_id) REFERENCES members (account_id, id)
) STRICT;

CREATE TABLE import_before_images (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  batch_id   INTEGER NOT NULL,
  member_id  INTEGER NOT NULL,
  row        TEXT NOT NULL CHECK (json_valid(row)),
  UNIQUE (batch_id, member_id),
  FOREIGN KEY (account_id, batch_id) REFERENCES import_batches (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, member_id) REFERENCES members (account_id, id) ON DELETE CASCADE
) STRICT;

-- "Delete member with no history" (§6.0 rule 5): payments and ledger entries block the delete
-- (ON DELETE RESTRICT); soft references are detached so they do not.
CREATE TRIGGER members_detach_soft_refs BEFORE DELETE ON members
BEGIN
  UPDATE email_queue SET member_id = NULL
   WHERE account_id = OLD.account_id AND member_id = OLD.id;
  UPDATE import_rows SET matched_member_id = NULL
   WHERE account_id = OLD.account_id AND matched_member_id = OLD.id;
END;
