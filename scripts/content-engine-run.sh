#!/bin/bash
# Content Engine, Runpreneur 360 lane, nightly Go Signal (R1 folder watch + the pull for R2).
# launchd com.kevinbrittain.content-engine at 02:00, wrapped by job-queue.py run so it never
# overlaps another job. No Claude in this step: it is deterministic (Chen's assignment matrix),
# so it is listed in js/automations-data.js, not on the AI Agents register.
#
# What one run does:
#   1. scan --create : every new clip in the raw Drive folder (newest batch onwards) gets a
#                      ledger entry; every new shooting day gets ONE "Episode N Full Episode"
#                      record at New Upload with the Drive link of its first clip.
#   2. next          : pulls the oldest waiting clip to the local work folder, one per run,
#                      never more than two waiting locally (disk is ~60 GB, clips 0.3-5 GB,
#                      Drive streams cold files at ~1 GB per 15 min).
#   3. render run    : ONE pulled clip through transcript -> episode number check -> 16:9 and
#                      9:16 renders -> captions and banners -> edited Drive folder -> record
#                      links (R2, R3, R5). About 10 minutes for a 40 s clip. Never publishes.
#   4. platform_copy : platform copy for episodes whose transcript is in and whose copy is not
#                      (R7 + R8; the Content Machine's own prompts, headless Claude, rules check).
#   5. approval sync : Kevin's verdicts on open cards -> the episode record (Approved for Publishing,
#                      or his words into Feedback). Never publishes.
#   6. approval run  : one approval card per finished episode (video + thumbnail + copy all in),
#                      through the duplicate gate and agent-dispatch submit, so the 08:00 digest
#                      counts it and Kevin decides on the AI Agents page (R9).
#   7. publish sync  : GHL post statuses -> published links on the record; the YouTube link unlocks
#                      the socials; every post out -> "Published".
#   8. publish run   : approved episodes only (R10): night one the full episode to YouTube (06:00),
#                      the night after YouTube publishes the Summary (09:00) and Learnings (17:00)
#                      clips to every connected social channel, all through GoHighLevel. Holds with a
#                      digest line until a YouTube account is connected in GHL.
#   9. OD lane       : Operations Director brand profile (od_lane.py): mine, sync, draft, cards, publish, points.
#  10. report        : one line each for the morning digest.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"   # the checkout this script lives in, so a worktree run uses its own code
LOG_DIR="/Users/kevinbrittain/knowledge-os/logs/content-engine"
mkdir -p "$LOG_DIR"
cd "$REPO" || exit 1
# Node for the browser lane: launchd's PATH has none (finding 20260911-daily-ops-phase-2-523,
# same fix as content-engine-publish.sh).
if ! command -v node >/dev/null 2>&1; then
  __NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -t. -k1,1V -k2,2n -k3,3n | tail -1)"
  [ -n "$__NODE_BIN" ] && [ -x "$__NODE_BIN/node" ] && export PATH="$__NODE_BIN:$PATH"
fi
command -v node >/dev/null 2>&1 || echo "ERROR: node not found on PATH or under ~/.nvm; every browser-lane step will fail this run" >&2
# The runtime checkout is a worktree kept on main (the main checkout is often on a session's branch):
# take the latest merged code before every run, never anything uncommitted.
#
# THE UPDATE MUST NEVER SKIP SILENTLY (finding 20260909-queue-fixer-504).
# The old gate refused to pull whenever `git status --porcelain` printed
# ANYTHING. The engine writes `runpreneur-map/data/progress.json` as it runs, so
# that file is permanently modified in the runtime worktree — which meant the
# self-update had been switched off by the engine's own working file, silently,
# for as long as that file had been dirty. Measured 9 Sep 2026: the worktree read
# `main...origin/main [behind 5]` while every queue fix of that day, including the
# diskGB precondition written FOR this job, sat unreachable on origin.
#
# So: no blanket dirty-tree veto. `--ff-only` already refuses to clobber a local
# change it would have to overwrite, which is the protection that was actually
# wanted. And whichever way it goes, the run SAYS so — a checkout running stale
# code is the failure this whole queue exists to catch, and it must not be quiet.
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

# WORKING-HOURS GUARD (Kevin, 4 Sep 2026)
# -----------------------------------------------------------------------------
# A render saturates every core for hours: on 4 Sep two of them ran together from
# 11:35 and the Mac went to load 47 with 0.2 GB free while Kevin was working. The
# 02:00 slot is not the problem. The problem is every path that can start a run
# LATE: retry-deferred re-fires an opted-in job hourly inside maxLateMinutes, and
# a session can launch this script by hand (one did, at 10:30, straight past the
# queue). Capping the lateness window alone would fix only the first path, so the
# refusal lives HERE, where every path passes through.
#
# Blocks 07:00-21:59 local. Set CE_ALLOW_DAYTIME=1 to override for a deliberate test.
HOUR=$(date +%-H)
if [ "${CE_ALLOW_DAYTIME:-0}" != "1" ] && [ "$HOUR" -ge 7 ] && [ "$HOUR" -lt 22 ]; then
  echo "SKIPPED: working hours ($(date +%H:%M)). Renders run 22:00-07:00 only."
  echo "         Next scheduled slot 02:00. Override with CE_ALLOW_DAYTIME=1."
  exit 0
fi
python3 scripts/content-engine/watch.py scan --create || exit 1
# Episodes a night (Kevin, 8 Sep 2026): three during the catch-up from day 2054, one once we are a month behind.
EPISODES="${CE_EPISODES_PER_NIGHT:-$(cat "$HOME/.config/od/content_engine_episodes_per_night" 2>/dev/null || echo 1)}"
# Kevin's night order (8 Sep 2026): slot 1 continues the run from where Ericamae stopped; the other slots take
# the oldest days missing from YouTube (the gap list, ~/.config/od/content_engine_gap_days), or the next
# continuity days when no gap day fits on the disk. Each slot is a whole DAY: every clip of that day is pulled
# and rendered before the next slot starts, so the episode, its summary and its Learnings clip all exist together.
DAYS="$(python3 scripts/content-engine/watch.py plan --slots "$EPISODES")" || DAYS=""
[ -z "$DAYS" ] && echo "plan: nothing waiting to render"
for day in $DAYS; do
  echo "== day $day"
  for i in 1 2 3 4 5 6; do
    python3 scripts/content-engine/watch.py next --day "$day" || break    # exit 3: the day is done; anything else: the pull was refused, move on
    python3 scripts/content-engine/render.py run --limit 1 || exit 1
  done
done
python3 scripts/content-engine/platform_copy.py run --pending --limit 2 || exit 1
python3 scripts/content-engine/approval.py sync || exit 1
# 5b. Performance read (Kevin, 8 Sep 2026: once a month, last 30 days, three recommendations that become lessons).
#     Every night: his verdict on an open read -> lessons. Mondays: GoHighLevel's 7-day platform totals stored
#     (the API answers for seven days only). The 1st: the month's read as ONE card. Never stops the lane.
python3 scripts/content-engine/performance.py sync || echo "performance sync: skipped this run (see above)"
[ "$(date +%u)" = "1" ] && { python3 scripts/content-engine/performance.py snapshot || echo "performance snapshot: skipped (see above)"; }
[ "$(date +%d)" = "01" ] && { python3 scripts/content-engine/performance.py run || echo "performance read: skipped (see above)"; }
python3 scripts/content-engine/approval.py run --pending --limit 2 || exit 1
python3 scripts/content-engine/publish.py sync || exit 1
python3 scripts/content-engine/publish.py run --limit 2 || exit 1
# 8b. runpreneur sync: latest Strava run -> running total, Stripe donations -> total raised, the four
#     numbers onto the website's custom values, the run renamed on Strava (SOP 62 / the app's Runpreneur
#     Sync page). Holds harmlessly on Strava's quota (the app is on a -1 tier until Kevin upgrades it).
python3 scripts/content-engine/runpreneur_sync.py run || echo "runpreneur sync: skipped this run (see above)"
# 9. Operations Director lane (od_lane.py, Kevin-approved plan 3 Sep 2026): mine tonight's new transcripts into the
#    bank of OD moments; read Kevin's verdicts on OD cards (one redo on "Changes requested"); fill the coming week's
#    five weekday shapes and the Friday newsletter if they are not drafted yet (idempotent); one card per piece;
#    approved posts to GoHighLevel on the OD brand (drafts in test mode); approved editions to the browser lane;
#    Sunday/Monday: the ten-topic recording brief for Kevin's runs (v2, 4 Sep 2026). Every step falls through with a line, so the OD lane can never stop the Runpreneur lane.
python3 scripts/content-engine/od_lane.py mine --limit 6 || echo "od mine: failed this run (see above)"
python3 scripts/content-engine/od_lane.py sync || echo "od sync: failed this run (see above)"
python3 scripts/content-engine/od_lane.py draft || echo "od draft: failed this run (see above)"
python3 scripts/content-engine/od_lane.py cards || echo "od cards: failed this run (see above)"
python3 scripts/content-engine/od_lane.py publish-sync || echo "od publish sync: failed this run (see above)"
python3 scripts/content-engine/od_lane.py publish || echo "od publish: failed this run (see above)"
python3 scripts/content-engine/od_lane.py newsletter-publish || echo "od newsletter publish: failed this run (see above)"
case "$(TZ=Europe/London date +%u)" in 7|1) python3 scripts/content-engine/od_lane.py topics || echo "od topics: failed this run (see above)";; esac
python3 scripts/content-engine/runpreneur_map.py run || echo "map: not updated tonight (see above)"
python3 scripts/content-engine/watch.py report
python3 scripts/content-engine/approval.py report
python3 scripts/content-engine/publish.py report
python3 scripts/content-engine/runpreneur_sync.py report
python3 scripts/content-engine/od_lane.py report
