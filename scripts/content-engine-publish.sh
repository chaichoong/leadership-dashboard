#!/bin/bash
# Content Engine, the DAYTIME publisher (Kevin, 8 Sep 2026: an episode approved in the morning goes out the same
# day). Light API work only, no rendering, so it may run in working hours: Kevin's verdicts -> the record,
# GHL post statuses -> links, the next episode in order -> YouTube now, its clips -> the socials, blog and
# podcast later the same day. Hourly 07:15-20:15 as the wrapped job `content-engine-publish`.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
# NODE FOR THE BROWSER LANE (finding 20260911-daily-ops-phase-2-523). launchd starts this job with
# PATH=/usr/bin:/bin:/usr/sbin:/sbin and node lives under nvm, so every `node` call (Spotify, the
# Facebook share, the OD pictures) died with FileNotFoundError on all 8 runs of 10 Sep 2026. Put the
# newest nvm node on PATH, and say so loudly here if there is none, not in a Python traceback later.
if ! command -v node >/dev/null 2>&1; then
  __NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -t. -k1,1V -k2,2n -k3,3n | tail -1)"
  [ -n "$__NODE_BIN" ] && [ -x "$__NODE_BIN/node" ] && export PATH="$__NODE_BIN:$PATH"
fi
command -v node >/dev/null 2>&1 || echo "ERROR: node not found on PATH or under ~/.nvm; every browser-lane step will fail this run" >&2
# The runtime checkout is a worktree kept on main (the main checkout is often on a session's branch):
# take the latest merged code before every run, never anything uncommitted.
if [ "$(git -C "$REPO" branch --show-current 2>/dev/null)" = "main" ] && [ -z "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]; then
  git -C "$REPO" pull -q --ff-only origin main 2>/dev/null || echo "runtime: could not fast-forward main, running what is here"
fi
python3 scripts/content-engine/approval.py sync || exit 1
python3 scripts/content-engine/publish.py sync || exit 1
python3 scripts/content-engine/publish.py run --limit 3 || exit 1
python3 scripts/content-engine/approval.py report
python3 scripts/content-engine/publish.py report
