#!/bin/bash
# One runner for every role-agent slot.
#
# WHY THIS EXISTS (26 Aug 2026, Kevin's restructure)
# --------------------------------------------------
# Role-specific work has left the daily-ops sequence. On 26 Aug that sequence
# ran 06:05 to 12:49 — six hours forty-three — with the business actions that
# touch money and people sitting at the END of it, behind sweeps whose main
# output was a findings queue nothing could drain. A slot runs its own agent,
# on its own clock, in minutes.
#
# A SLOT IS NOT A SECOND CLAUDE ROUTINE. It is a wrapped shell job: launchd
# calls job-queue.py run, so it takes the lock and heartbeats, and a slot
# suspended by the Mac sleeping frees the lock in about five minutes. The
# failure this whole design exists to prevent — drift-monitor holding the lock
# for 4h54m while asleep on 8 Aug — cannot come back through this door.
#
# Each slot is named in APPROVED_SLOTS in scripts/check-routines.py, with the
# date Kevin ruled it in, and registered in scripts/job-schedule.json. The guard
# fails if those two lists disagree, because a slot missing from the register is
# invisible to the digest that notices a job has stopped.
#
# Usage:  agent-slot-run.sh <job-name> <skill-path> [extra prompt lines...]
set -u

JOB="${1:-}"
SKILL="${2:-}"
shift 2 || true
EXTRA="$*"

if [ -z "$JOB" ] || [ -z "$SKILL" ]; then
  echo "usage: agent-slot-run.sh <job-name> <skill-path> [extra prompt]" >&2
  exit 2
fi

CLAUDE="/Users/kevinbrittain/.local/bin/claude"
REPO="/Users/kevinbrittain/Projects/leadership-dashboard"
LOG_DIR="/Users/kevinbrittain/knowledge-os/logs/$JOB"
SCRATCH="$LOG_DIR/scratch"
LOG="$LOG_DIR/runs.log"
mkdir -p "$SCRATCH"
export AGENT_SLOT_SCRATCH="$SCRATCH"
export AGENT_SLOT_LOG_DIR="$LOG_DIR"

# A missing skill file must be a LOUD failure, not a polite no-op. Headless
# claude exits 0 after saying it cannot find the file, which run-job.sh would
# read as success while the slot silently did nothing every day.
if [ ! -f "$SKILL" ]; then
  echo "BROKEN: skill file missing at $SKILL (run scripts/sync-scheduled-tasks.py --push)" >&2
  exit 1
fi

# Without the exported OAuth token a headless `claude -p` dies with
# "OAuth access token has expired". Same discipline as the other slot runners:
# the token is READ FROM A FILE, never passed as an argument, because anything
# on the command line is readable by any process via ps and lands in session
# transcripts on disk.
if [ -f "/Users/kevinbrittain/.config/od/claude_oauth_token" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat /Users/kevinbrittain/.config/od/claude_oauth_token)"
else
  echo "ERROR: claude OAuth token missing at ~/.config/od/claude_oauth_token" >&2
  exit 1
fi

__START_LINE=$( { wc -l < "$LOG"; } 2>/dev/null || echo 0)
__MARKER="$SCRATCH/.run-start.$$"
touch "$__MARKER"
echo "===== $JOB slot run $(date) =====" >> "$LOG"

# Finding 20260827-phase-2-382: a slot that dies mid-run must still write a
# done line — the inbound-triage 09:00 slot on 26 Aug left a bare start
# header, indistinguishable from a run still going. Trap the catchable
# terminations (TERM, HUP, INT) and any abnormal exit. A SIGKILL is
# untrappable by anything.
__POSTRUN_DONE=0
__on_exit() {
  __rc=$?
  if [ "$__POSTRUN_DONE" -eq 0 ]; then
    echo "===== done rc=$__rc (ABNORMAL: wrapper terminated before postrun) $(date) =====" >> "$LOG"
    echo "$JOB slot run DIED before completing (rc=$__rc) — see $LOG" >&2
  fi
}
trap __on_exit EXIT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 130' INT

cd "$REPO" || { echo "ERROR: repo not found at $REPO" >&2; exit 1; }

"$CLAUDE" -p "You are the $JOB slot run. Do this skill in full: $SKILL

Rules for the whole run:
- You are ONE role agent's slot, not the daily-ops routine. Do only your own work.
- Do NOT take the queue lock — this run already holds it.
- READ-ONLY with respect to code: no edit, no git add, no commit, no push, no
  branch, no PR. Anything needing a code change goes to
  scripts/findings.py add. Note the queue is capped per routine now: a repeat
  of something already filed is folded in as a recurrence automatically, and a
  refusal past the cap tells you which of your own to close first.
- Never send, reply, pay, approve or delete on Kevin's behalf. Work reaches him
  through the approval gate, never straight out.
- Working and temp files go ONLY under \$AGENT_SLOT_SCRATCH ($SCRATCH). NEVER in
  the repo and never in monitoring/ — that is committed to a PUBLIC repository
  and this content carries tenant, creditor and legal detail. Counts-only
  reports in monitoring/ are fine.
- A broken read is reported loudly, never treated as an empty result. If a
  query returns zero, say whether zero is the truth or the query is broken.
- Report honestly what you actually did. Halting early is reported as halting,
  never as clean.
$EXTRA
End with at most fifteen lines: what you did, what you found, what you could not do." \
  --permission-mode acceptEdits \
  --allowedTools "Bash(python3:*)" "Bash(curl:*)" >> "$LOG" 2>&1
RC=$?

# Shared epilogue (finding 20260827-phase-2-381): privacy sweep, done line,
# and exit-code semantics live in ONE place now — scripts/slot-postrun.sh.
# It preserves the real rc, treats a quarantine as informational (still loud
# on stderr), and never quarantines the drift scanner's schema snapshots
# (schema-YYYY-MM-DD.json), which false-positived on 25 and 26 Aug 2026.
"$REPO/scripts/slot-postrun.sh" "$JOB slot" "$RC" "$LOG" "$__START_LINE" "$__MARKER" "$SCRATCH" \
  '"description" *:|"Inbound Message Content" *:|CREDITOR MATTER' \
  'HTTP Error 401|401 Unauthorized|Unauthorized|OAuth access token has expired|BROKEN|VERIFY FAIL'
__FINAL=$?
__POSTRUN_DONE=1
exit "$__FINAL"
