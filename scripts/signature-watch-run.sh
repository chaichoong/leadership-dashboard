#!/bin/bash
# signature-watch-run.sh — the scheduled poll for documents coming back signed.
#
# WHY A WRAPPER AND NOT node IN THE PLIST
# Node lives under nvm at a VERSION-SPECIFIC path
# (~/.nvm/versions/node/v24.15.0/bin/node) and launchd does not source a shell,
# so it has no nvm on PATH. Hardcoding the version into a plist means the job
# dies silently the next time node is upgraded — and a watcher that stops
# watching is exactly the failure this whole piece exists to prevent.
# Resolved the same way scripts/agent-tools.sh resolves it, for the same reason.
set -uo pipefail

REPO="/Users/kevinbrittain/Projects/leadership-dashboard"
NODE="$(command -v node || ls -1d /Users/kevinbrittain/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)"

if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "ERROR: node not found. The signature watch cannot run, so a signed document" >&2
  echo "       would sit unnoticed. This is a failure, not a quiet no-op." >&2
  exit 1
fi

cd "$REPO" || { echo "ERROR: repo not found at $REPO" >&2; exit 1; }
exec "$NODE" "$REPO/scripts/signature-watch.js" poll
