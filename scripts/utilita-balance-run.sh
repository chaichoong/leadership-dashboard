#!/bin/bash
# Duckworth Utilita watcher — hourly, launchd com.kevinbrittain.utilita-balance,
# wrapped by job-queue.py run.
#
# WHY HOURLY FOR A DAILY MESSAGE (measured 18 Sep 2026):
# Utilita issues no remember-me cookie. Its session cookie lasts ONE HOUR and
# every visit restarts the hour, so the READ is what keeps the login alive. A
# single 07:15 run would find itself signed out most mornings and send Kevin to
# the Robot sign-in app daily, which defeats the point of automating it. So the
# job reads hourly and utilita-balance.py decides when to SEND: once a day, with
# one extra message only on a morning it genuinely could not read a meter.
#
# NO SKILL FOLDER. Same rule as handback-poll: check-routines.py treats anything
# with a folder under ~/.claude/scheduled-tasks/ as a Claude ROUTINE and fails
# the build if a second one exists. This is a registered SHELL job and costs no
# Claude tokens at all — it is a page read and a Slack post.
set -uo pipefail

REPO="/Users/kevinbrittain/Projects/leadership-dashboard/.claude/worktrees/content-engine-runtime"
# The runtime worktree holds `main` and is fast-forwarded before the nightly
# jobs, so a scheduled job reads shipped code rather than whatever branch a
# session left the main checkout on.
#
# The fallback tests for THIS SCRIPT, not for scripts/. Testing the directory
# was wrong and would have failed silently: scripts/ exists in that worktree
# whatever commit it sits on, so on any day the worktree had not been
# fast-forwarded past this feature the test would pass and python would then
# die on a missing file. The fallback exists precisely for that day.
[ -f "$REPO/scripts/utilita-balance.py" ] || REPO="/Users/kevinbrittain/Projects/leadership-dashboard"

TARGET="$REPO/scripts/utilita-balance.py"
if [ ! -f "$TARGET" ]; then
  echo "utilita-balance: no utilita-balance.py in either checkout" >&2
  exit 1
fi

exec /usr/bin/python3 "$TARGET" run "$@"
