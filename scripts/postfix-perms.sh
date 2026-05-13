#!/usr/bin/env bash
# Apply ownership/permissions so the Postfix delivery/transport user can run mailfwd.
# Run on the mail host as root after: npm ci (or npm install) in MAILFWD_DIR.
#
# Environment (optional):
#   MAILFWD_DIR   Repo root (default: parent of this script)
#   POSTFIX_GROUP Group name shared with the unprivileged Postfix user (default: postfix)
#   OWNER         Optional "user:group" for chown (e.g. root:postfix). If unset, only chmod/chgrp group is applied.
#
# Your main.cf / master.cf pipe user must match: that user needs
#   - execute on every directory from / down to MAILFWD_DIR
#   - read+execute on post-rest-fwd.js if invoked as ./post-rest-fwd.js, or read if invoked as node /path/post-rest-fwd.js
#   - read on all files under node_modules/ that Node loads

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${MAILFWD_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
POSTFIX_GROUP="${POSTFIX_GROUP:-postfix}"

if ! getent group "$POSTFIX_GROUP" >/dev/null 2>&1; then
  echo "Group '$POSTFIX_GROUP' not found. Install Postfix or set POSTFIX_GROUP to the pipe user's primary group." >&2
  exit 1
fi

if [[ ! -f "$INSTALL_DIR/post-rest-fwd.js" ]]; then
  echo "Missing $INSTALL_DIR/post-rest-fwd.js (MAILFWD_DIR=$INSTALL_DIR)" >&2
  exit 1
fi

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Run as root (e.g. sudo $0)." >&2
  exit 1
fi

if [[ -n "${OWNER:-}" ]]; then
  chown -R "$OWNER" "$INSTALL_DIR"
else
  chgrp -R "$POSTFIX_GROUP" "$INSTALL_DIR"
fi

# Owner full; group read + traverse; no world access
chmod -R u+rwX,g+rX,o-rwx "$INSTALL_DIR"
# Shebang / direct execution
chmod u=rwx,g=rx,o= "$INSTALL_DIR/post-rest-fwd.js"

echo "OK: $INSTALL_DIR readable/executable by group $POSTFIX_GROUP (ensure main.cf pipe user is in that group or matches OWNER)."
