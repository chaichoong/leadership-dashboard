#!/bin/bash
# Content Engine, the DAYTIME publisher (Kevin, 8 Sep 2026: an episode approved in the morning goes out the same
# day). Light API work only, no rendering, so it may run in working hours: Kevin's verdicts -> the record,
# GHL post statuses -> links, the next episode in order -> YouTube now, its clips -> the socials, blog and
# podcast later the same day. Hourly 07:15-20:15 as the wrapped job `content-engine-publish`.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
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
