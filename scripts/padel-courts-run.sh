#!/bin/bash
# padel-courts-run.sh: what launchd (com.kevinbrittain.padel-courts, every 15 minutes 06:00 to
# 22:45) runs through ~/tools/run-job.sh. It starts scripts/padel-courts.mjs, the Mac mini's read
# of the two Matchi venues for the padel group page (27 Oct 2026).
#
# Why a runner and not the script path in the plist: the main checkout is often on another
# session's branch, where this script does not exist yet, so a plist pointing straight at it
# fails every 15 minutes. Same pattern as utilita-balance-run.sh: prefer the checkout with a
# refresh story, fall back to the runtime worktree (checked out on main, fast-forwarded before the
# content-engine jobs), and test for THIS script rather than for scripts/.
set -uo pipefail

REPO="/Users/kevinbrittain/Projects/leadership-dashboard"
[ -f "$REPO/scripts/padel-courts.mjs" ] || REPO="/Users/kevinbrittain/Projects/leadership-dashboard/.claude/worktrees/content-engine-runtime"

TARGET="$REPO/scripts/padel-courts.mjs"
if [ ! -f "$TARGET" ]; then
  echo "FAILED: padel-courts: no padel-courts.mjs in either checkout" >&2
  exit 1
fi

# launchd's PATH has no node. nvm's current install first, then the newest nvm node, then PATH.
NODE="/Users/kevinbrittain/.nvm/versions/node/v24.15.0/bin/node"
if [ ! -x "$NODE" ]; then
  NODE="$(ls -d /Users/kevinbrittain/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
[ -n "${NODE:-}" ] && [ -x "$NODE" ] || NODE="$(command -v node || true)"
if [ -z "${NODE:-}" ]; then
  echo "FAILED: padel-courts: no node found" >&2
  exit 1
fi

exec "$NODE" "$TARGET" run "$@"
