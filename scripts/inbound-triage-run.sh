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
# Each slot runs, in order: the Gmail inbox triage skill, the iMessage sweep
# skill, then the agent-dispatch skill (Kevin's ruling, 24 Aug 2026: dispatch
# runs in all three slots, so triaged work is prepared for approval in the
# SAME slot, not the next morning). Nothing here can send email directly —
# the triage Gmail credential is read/label-only, and dispatch output goes to
# the approval loop.
#
# PRIVACY: the first proof run dumped raw scan output (full email bodies)
# into monitoring/, which the nightly fixer commits to the PUBLIC repo. All
# working files now belong in $SCRATCH, the prompt says so, and the post-run
# sweep below quarantines any content-bearing file that still lands in
# monitoring/ and fails the run loudly.
set -u
CLAUDE="/Users/kevinbrittain/.local/bin/claude"
REPO="/Users/kevinbrittain/Projects/leadership-dashboard"
LOG_DIR="/Users/kevinbrittain/knowledge-os/logs/inbound-triage"
SCRATCH="$LOG_DIR/scratch"
LOG="$LOG_DIR/runs.log"
mkdir -p "$SCRATCH"

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
__START_LINE=$( { wc -l < "$LOG"; } 2>/dev/null || echo 0)
__MARKER="$SCRATCH/.run-start.$$"
touch "$__MARKER"
echo "===== inbound-triage run $(date) =====" >> "$LOG"

# Finding 20260827-phase-2-382: this slot's 09:00 run on 26 Aug started and
# vanished — a start header with no done line, indistinguishable from a run
# still going, and no job-status row either (the whole process tree died, so
# the death was a SIGKILL or a sleep-kill launchd never reported). Trap the
# catchable terminations (TERM from launchd/session teardown, HUP, INT) and
# any abnormal exit so those at least always write a done line. A SIGKILL
# remains untrappable by anything.
__POSTRUN_DONE=0
__on_exit() {
  __rc=$?
  if [ "$__POSTRUN_DONE" -eq 0 ]; then
    echo "===== done rc=$__rc (ABNORMAL: wrapper terminated before postrun) $(date) =====" >> "$LOG"
    echo "inbound-triage run DIED before completing (rc=$__rc) — see $LOG" >&2
  fi
}
trap __on_exit EXIT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 130' INT

cd "$REPO" || { echo "ERROR: repo not found at $REPO" >&2; exit 1; }

# PRE-READ the Messages database HERE, before claude starts. macOS attributes
# the Full Disk Access permission to this job's ROOT process (python3, which
# Kevin granted on 24 Aug 2026 — proven by a launchd probe), NOT to the claude
# binary — a chat.db read made from inside claude is denied, and the claude
# binary's path changes on every update so granting it would break silently.
# The skill consumes these dumps instead of reading chat.db itself. Failures
# land IN the dump files as error JSON, so the skill still reports them loudly.
/usr/bin/python3 "$REPO/scripts/imessage-sweep.py" scan > "$SCRATCH/imessage-scan.json" 2>&1 || true
/usr/bin/python3 "$REPO/scripts/imessage-sweep.py" sentdump --since-hours 200 > "$SCRATCH/imessage-sent.json" 2>&1 || true

"$CLAUDE" -p "You are the Inbound Comms Triage agent's scheduled run (one of the 09:00 / 13:00 / 17:00 slots). Do these three skills in order, each in full:
1. /Users/kevinbrittain/.claude/scheduled-tasks/inbound-email-triage/SKILL.md
2. /Users/kevinbrittain/.claude/scheduled-tasks/inbound-messages-sweep/SKILL.md — IMPORTANT: in this context chat.db reads are DENIED to you; the fresh pre-read dumps at $SCRATCH/imessage-scan.json and $SCRATCH/imessage-sent.json are your scan and sent-check data, per the skill's pre-dump rules.
3. /Users/kevinbrittain/.claude/scheduled-tasks/agent-dispatch/SKILL.md (Kevin's ruling, 24 Aug 2026: dispatch runs in every slot so the work triaged above reaches the approval queue in the same slot)
Rules for the whole run: this is real mail — when unsure between outcomes choose the agent-lane task; when unsure about archiving, do not archive; never send, reply, or delete anything yourself (dispatch prepares and submits through its own gated script only). Working and temp files go ONLY under $SCRATCH — NEVER under the repo, and never in monitoring/, because monitoring/ is committed to a public repository and scan output carries full email bodies. Counts-only reports in monitoring/ are fine. A broken read (Gmail or iMessage) is reported loudly, never treated as a quiet day. Do not take the queue lock (this run already holds it). Do not edit, commit, or push code; file anything needing a code change via scripts/findings.py. Complete each skill's closing steps in full (watermark, score, publish; dispatch's verify step). End with at most twenty lines of counts only — never message content, sender names, or record IDs." \
  --permission-mode acceptEdits \
  --allowedTools "Bash(python3:*)" "Bash(curl:*)" >> "$LOG" 2>&1
RC=$?

# Shared epilogue (finding 20260827-phase-2-381): privacy sweep, done line,
# and exit-code semantics live in ONE place now — scripts/slot-postrun.sh.
# It preserves the real rc, treats a quarantine as informational (still loud
# on stderr), and never quarantines the drift scanner's schema snapshots,
# which false-positived here on 25 Aug 2026 (they carry "Inbound Message
# Content" as a field NAME in the table structure, not as message content).
"$REPO/scripts/slot-postrun.sh" "inbound-triage" "$RC" "$LOG" "$__START_LINE" "$__MARKER" "$SCRATCH" \
  '"body" *:|"Inbound Message Content" *:' \
  '"error"|401|Unauthorized|OAuth access token has expired|BROKEN|Full Disk Access'
__FINAL=$?
__POSTRUN_DONE=1
exit "$__FINAL"
