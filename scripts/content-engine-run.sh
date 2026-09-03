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
#   9. report        : one line each for the morning digest.
set -uo pipefail
REPO="/Users/kevinbrittain/Projects/leadership-dashboard"
LOG_DIR="/Users/kevinbrittain/knowledge-os/logs/content-engine"
mkdir -p "$LOG_DIR"
cd "$REPO" || exit 1
python3 scripts/content-engine/watch.py scan --create || exit 1
python3 scripts/content-engine/watch.py next || exit 1
python3 scripts/content-engine/render.py run --limit 1 || exit 1
python3 scripts/content-engine/platform_copy.py run --pending --limit 2 || exit 1
python3 scripts/content-engine/approval.py sync || exit 1
python3 scripts/content-engine/approval.py run --pending --limit 2 || exit 1
python3 scripts/content-engine/publish.py sync || exit 1
python3 scripts/content-engine/publish.py run --limit 2 || exit 1
# 8b. runpreneur sync: latest Strava run -> running total, Stripe donations -> total raised, the four
#     numbers onto the website's custom values, the run renamed on Strava (SOP 62 / the app's Runpreneur
#     Sync page). Holds harmlessly on Strava's quota (the app is on a -1 tier until Kevin upgrades it).
python3 scripts/content-engine/runpreneur_sync.py run || echo "runpreneur sync: skipped this run (see above)"
python3 scripts/content-engine/watch.py report
python3 scripts/content-engine/approval.py report
python3 scripts/content-engine/publish.py report
python3 scripts/content-engine/runpreneur_sync.py report
