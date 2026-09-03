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
#   3. report        : one line for the morning digest.
# The render (R2) picks pulled clips up in its own step; this script never renders.
set -uo pipefail
REPO="/Users/kevinbrittain/Projects/leadership-dashboard"
LOG_DIR="/Users/kevinbrittain/knowledge-os/logs/content-engine"
mkdir -p "$LOG_DIR"
cd "$REPO" || exit 1
python3 scripts/content-engine/watch.py scan --create || exit 1
python3 scripts/content-engine/watch.py next || exit 1
python3 scripts/content-engine/watch.py report
