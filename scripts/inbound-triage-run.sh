#!/bin/bash
# Inbound Comms Triage agent — its own Go Signal (Kevin's ruling, 24 Aug 2026):
# 09:00, 13:00 and 17:00 local daily, launchd com.kevinbrittain.inbound-triage,
# wrapped by job-queue.py run. The job name "inbound-triage" is deliberately
# NOT the name of any skill folder, so check-routines.py sees a registered
# shell job rather than a second Claude routine. The one-routine rule's
# fixed-time exception was Kevin's explicit call, recorded in
# docs/daily-ops-routine.md — do not fold this back into daily-ops without
# his word.
#
# Runs BOTH of the agent's lanes headlessly: the Gmail inbox triage skill,
# then the iMessage sweep skill. Triage only — nothing is ever sent; every
# outward reply stays approval-gated downstream (and the Gmail credential the
# triage script holds cannot send by design).
set -u
CLAUDE="/Users/kevinbrittain/.local/bin/claude"
REPO="/Users/kevinbrittain/Projects/leadership-dashboard"
LOG_DIR="/Users/kevinbrittain/knowledge-os/logs/inbound-triage"
LOG="$LOG_DIR/runs.log"
mkdir -p "$LOG_DIR"

# Same token discipline as compound_brain.sh: without the exported OAuth token
# a headless `claude -p` dies with "OAuth access token has expired".
if [ -f "/Users/kevinbrittain/.config/od/claude_oauth_token" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat /Users/kevinbrittain/.config/od/claude_oauth_token)"
else
  echo "ERROR: claude OAuth token missing at ~/.config/od/claude_oauth_token" >&2
  exit 1
fi

# Everything below logs to $LOG; remember where this run starts so failures in
# the tail can be surfaced on stderr for the wrapper. An empty stdout reads as
# success to run-job.sh, which is how silent 401s once went unnoticed for a week.
__START_LINE=$(wc -l < "$LOG" 2>/dev/null || echo 0)
echo "===== inbound-triage run $(date) =====" >> "$LOG"
cd "$REPO" || { echo "ERROR: repo not found at $REPO" >&2; exit 1; }

"$CLAUDE" -p "Follow /Users/kevinbrittain/.claude/scheduled-tasks/inbound-email-triage/SKILL.md in full, then follow /Users/kevinbrittain/.claude/scheduled-tasks/inbound-messages-sweep/SKILL.md in full. You are the Inbound Comms Triage agent's scheduled run (one of the 09:00 / 13:00 / 17:00 slots). This is real mail: when unsure between outcomes choose the agent-lane task; when unsure about archiving, do not archive; never send, reply, or delete anything. Do not take the queue lock (this run already holds it). Do not edit, commit, or push code; file anything needing a code change via scripts/findings.py. Complete each skill's closing steps in full (watermark, score, publish). End with at most fifteen lines of counts only — never message content, sender names, or record IDs." \
  --permission-mode acceptEdits \
  --allowedTools "Bash(python3:*)" "Bash(curl:*)" >> "$LOG" 2>&1
RC=$?

__TAIL=$(tail -n +$((__START_LINE + 1)) "$LOG" 2>/dev/null)
__BAD=$(printf '%s\n' "$__TAIL" | grep -E '"error"|401|Unauthorized|OAuth access token has expired' || true)
echo "===== done rc=$RC $(date) =====" >> "$LOG"
if [ $RC -ne 0 ] || [ -n "$__BAD" ]; then
  printf '%s\n' "$__BAD" | head -5 >&2
  echo "inbound-triage run FAILED (rc=$RC) — see $LOG" >&2
  exit 1
fi
echo "inbound-triage run OK"
