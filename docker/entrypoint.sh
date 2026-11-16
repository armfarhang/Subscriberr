#!/bin/sh
# Container entrypoint: fixes ownership of the two volumes, drops root, runs the CLI.
#   subscriberr-entrypoint [serve | restore <file> | verify-backup <file> | integrity-check | selfcheck]
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
DATA_DIR="${DATA_DIR:-/data}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"

# Files the app creates are owner-only (they hold personal data and encrypted credentials).
umask 077

if [ "$(id -u)" = "0" ]; then
  # PUID/PGID end up in a privilege drop: accept plain numbers only, and never root.
  case "$PUID" in ''|*[!0-9]*) echo "PUID must be a number (got '$PUID')" >&2; exit 64 ;; esac
  case "$PGID" in ''|*[!0-9]*) echo "PGID must be a number (got '$PGID')" >&2; exit 64 ;; esac
  if [ "$PUID" -eq 0 ]; then
    echo "PUID=0 would run Subscriberr as root. Use an unprivileged user (Unraid: 99)." >&2
    exit 64
  fi

  mkdir -p "$DATA_DIR" "$BACKUP_DIR" 2>/dev/null || true
  # Top level only (fast, and never rewrites ownership of an existing backup tree).
  chown "$PUID:$PGID" "$DATA_DIR" "$BACKUP_DIR" 2>/dev/null || true
  # Both volumes are private to the app user: other accounts on the host cannot list or read them.
  chmod 0700 "$DATA_DIR" "$BACKUP_DIR" 2>/dev/null || true
  # Databases created by older versions were world-readable.
  for f in "$DATA_DIR"/subscriberr.db "$DATA_DIR"/subscriberr.db-wal "$DATA_DIR"/subscriberr.db-shm; do
    [ -f "$f" ] && chmod 0600 "$f" 2>/dev/null || true
  done
  exec gosu "$PUID:$PGID" node /app/server/dist/cli.js "$@"
fi

exec node /app/server/dist/cli.js "$@"
