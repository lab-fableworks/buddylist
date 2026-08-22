#!/bin/sh
# Fly (and most volume providers) mount the volume owned by root, which overrides any
# ownership set at build time. Fix it at boot, then drop to the unprivileged app user.
set -e

STORAGE_DIR="${STORAGE_DIR:-/data/storage}"
PGLITE_DIR="${PGLITE_DIR:-/data/pglite}"

mkdir -p "$STORAGE_DIR" "$PGLITE_DIR"
# Non-recursive is enough: files created inside by the app user are already owned correctly.
chown node:node /data "$STORAGE_DIR" "$PGLITE_DIR" 2>/dev/null || true

if command -v setpriv >/dev/null 2>&1; then
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

# setpriv missing: don't fail to boot, but make the downgrade visible rather than silent.
echo "docker-entrypoint: setpriv unavailable, running as root" >&2
exec "$@"
