#!/bin/sh
# Container entrypoint: fixes ownership of the two volumes, drops root, runs the CLI.
#   subscriberr-entrypoint [serve | restore <file> | verify-backup <file> | integrity-check | selfcheck]
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
DATA_DIR="${DATA_DIR:-/data}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" "$BACKUP_DIR" 2>/dev/null || true
  # Top level only (fast, and never rewrites ownership of an existing backup tree).
  chown "$PUID:$PGID" "$DATA_DIR" "$BACKUP_DIR" 2>/dev/null || true
  chmod 0700 "$BACKUP_DIR" 2>/dev/null || true
  exec gosu "$PUID:$PGID" node /app/server/dist/cli.js "$@"
fi

exec node /app/server/dist/cli.js "$@"
