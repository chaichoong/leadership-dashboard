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
# take the latest merged code before every run. The same block as content-engine-run.sh: until 15 Sep 2026 this job
# refused to update whenever `git status` printed anything, and runpreneur-map/data/progress.json is always modified
# in the runtime worktree, so the hourly publisher ran whatever the night had pulled (14 commits behind at 15:50).
# --- runtime-update-block (extracted verbatim by tests/content-engine-runtime-update.test.js) ---
if [ "$(git -C "$REPO" branch --show-current 2>/dev/null)" = "main" ]; then
  git -C "$REPO" fetch -q origin main 2>/dev/null || true
  BEHIND=$(git -C "$REPO" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
  if [ "${BEHIND:-0}" -gt 0 ]; then
    if git -C "$REPO" pull -q --ff-only origin main 2>/dev/null; then
      echo "runtime: fast-forwarded $BEHIND commit(s) onto origin/main"
    else
      # THE ONE CASE THAT IS SAFE TO CLEAR, AND THE ONE THAT KEEPS HAPPENING.
      # The blocker is almost always a generated file the engine rewrote to
      # EXACTLY what origin already holds — on 10 Sep 2026 that was
      # runpreneur-map/data/progress.json, regenerated locally to the same
      # figures a committed [auto] commit already carried. Discarding a working
      # copy that is byte-identical to origin's version loses nothing at all, so
      # restore only those paths and try once more. Anything with real local
      # content is left alone and the run says so.
      RESTORED=0
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        if git -C "$REPO" show "origin/main:$f" 2>/dev/null | cmp -s - "$REPO/$f"; then
          git -C "$REPO" checkout -- "$f" 2>/dev/null && RESTORED=$((RESTORED + 1))
        fi
      done <<EOF
$(git -C "$REPO" diff --name-only 2>/dev/null)
EOF
      if [ "$RESTORED" -gt 0 ] && git -C "$REPO" pull -q --ff-only origin main 2>/dev/null; then
        echo "runtime: fast-forwarded $BEHIND commit(s) after restoring $RESTORED generated file(s) already identical to origin"
      else
        echo "RUNTIME CHECKOUT IS $BEHIND COMMIT(S) BEHIND origin/main and could not fast-forward — this run is executing STALE code:" >&2
        git -C "$REPO" status --porcelain 2>/dev/null | head -5 >&2
      fi
    fi
  else
    echo "runtime: up to date with origin/main"
  fi
else
  echo "RUNTIME CHECKOUT IS NOT ON main ($(git -C "$REPO" branch --show-current 2>/dev/null)) — running whatever is here, unupdated" >&2
fi
# --- end runtime-update-block ---
# Strava and the How far I've run numbers, every hour (15 Sep 2026). They lived only in the nightly render job, so the
# four nights the disk rule skipped it (9-12 Sep) renamed no run until the 13th. A run is renamed within the hour of
# reaching Strava; the map is redrawn only when a new run was folded, so main gets one map commit a day, not fourteen.
# It runs FIRST: the publishing steps below stop the run on a failure, and that must never cost a rename.
python3 scripts/content-engine/runpreneur_sync.py run --then-map || echo "runpreneur sync: skipped this run (see above)"
python3 scripts/content-engine/approval.py sync || exit 1
python3 scripts/content-engine/publish.py sync || exit 1
python3 scripts/content-engine/publish.py run --limit 3 || exit 1
python3 scripts/content-engine/approval.py report
python3 scripts/content-engine/publish.py report
python3 scripts/content-engine/runpreneur_sync.py report
