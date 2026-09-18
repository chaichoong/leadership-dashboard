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

# THE MAIN CHECKOUT FIRST, and this order matters (fixed 18 Sep 2026).
#
# It was the other way round, on the reasoning that the runtime worktree holds
# `main` while the main checkout sits on whatever branch a session left behind.
# That is wrong twice over:
#
#   1. The main checkout is the MAINTAINED one. scripts/refresh-main-checkout.py
#      exists to bring it to origin/main before daily-ops, written for exactly
#      this bug: "a merged fix never reached the routine that is meant to prove
#      it" (finding 20260914-daily-ops-528). Every other launchd job in the
#      estate points here too.
#   2. The runtime worktree cannot be relied on to be current. It is
#      fast-forwarded before the content-engine jobs, and its OWN jobs leave
#      tracked files modified there — on 18 Sep 2026 a modified
#      runpreneur-map/data/progress.json blocked the fast-forward, so that
#      worktree sat two commits behind while holding a perfectly readable copy
#      of this script. A stale copy that exists is worse than none, because the
#      existence test passes and the old code runs.
#
# So: prefer the checkout with a refresh story, fall back to the other, and
# test for THIS SCRIPT rather than for scripts/ (which exists at any commit).
REPO="/Users/kevinbrittain/Projects/leadership-dashboard"
[ -f "$REPO/scripts/utilita-balance.py" ] || REPO="/Users/kevinbrittain/Projects/leadership-dashboard/.claude/worktrees/content-engine-runtime"

TARGET="$REPO/scripts/utilita-balance.py"
if [ ! -f "$TARGET" ]; then
  echo "utilita-balance: no utilita-balance.py in either checkout" >&2
  exit 1
fi

exec /usr/bin/python3 "$TARGET" run "$@"
