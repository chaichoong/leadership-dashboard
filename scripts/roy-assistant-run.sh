#!/bin/bash
# Roy's assistant — every 10 minutes, 07:00 to 20:50, launchd
# com.kevinbrittain.roy-assistant, wrapped by job-queue.py run.
#
# WHY (Kevin, 24 Sep 2026): Roy works by email in info@agilelets.co.uk and
# finds new systems slow to pick up, so his assistant lives in that inbox. He
# forwards a tenant's message from info@ to info@ with one line saying what he
# wants; scripts/roy-assistant.py turns it into a ROY: task and emails "Got it".
# This run then has the Inbox Response agent work those tasks at once: new
# work otherwise waits for the 07:00 run or the next triage slot, and a tenant
# waiting half a day is exactly what Roy would stop using this for.
#
# THE JOB NAME IS NOT A SKILL FOLDER NAME, deliberately (same reason as
# handback-poll): check-routines.py calls anything under
# ~/.claude/scheduled-tasks/ a Claude routine. Never create one for this job.
#
# The expensive half only runs when a Roy request is waiting. A quiet tick is
# two Gmail reads and one Airtable read and costs no model tokens, and it
# never creates a run folder under agent-dispatch/: handback-poll reads a
# folder there with no report.json as a dispatch run in flight.
#
# Test seams (tests/roy-assistant.test.js runs this script with stubs):
#   ROY_ASSISTANT_REPO      the repo whose scripts/ are called
#   ROY_ASSISTANT_LOG_DIR   runs.log and scratch
#   ROY_ASSISTANT_RUNS      parent of the per-run RUNDIR
#   ROY_ASSISTANT_CLAUDE    the claude binary
#   ROY_ASSISTANT_TOKEN     the OAuth token file
set -uo pipefail
. "$(dirname "$0")/agent-tools.sh"
CLAUDE="${ROY_ASSISTANT_CLAUDE:-/Users/kevinbrittain/.local/bin/claude}"
REPO="${ROY_ASSISTANT_REPO:-/Users/kevinbrittain/Projects/leadership-dashboard}"
LOG_DIR="${ROY_ASSISTANT_LOG_DIR:-/Users/kevinbrittain/knowledge-os/logs/roy-assistant}"
SCRATCH="$LOG_DIR/scratch"
LOG="$LOG_DIR/runs.log"
TOKEN_FILE="${ROY_ASSISTANT_TOKEN:-/Users/kevinbrittain/.config/od/claude_oauth_token}"
# Seven times a typical single-task run, and short enough that a stuck run
# never holds the queue lock through more than a few of its own ticks.
MAX_MINUTES="${ROY_ASSISTANT_MAX_MINUTES:-30}"
PY="$REPO/scripts/roy-assistant.py"
mkdir -p "$SCRATCH"
cd "$REPO" || { echo "ERROR: repo not found at $REPO" >&2; exit 1; }

# --- one tick at a time (24 Sep 2026) ----------------------------------------
# This job is LOCK-EXEMPT: the inbox triage slots hold the queue lock for a
# median of 34 minutes (90th percentile 83) three times a day, and Roy must not
# wait behind them. So it keeps its own lock: a tick that starts while the last
# one is still working leaves at once. mkdir is atomic; the holder's pid says
# whether a lock left behind is live, and a dead holder's lock is taken over,
# never waited on. A lock younger than a minute with no pid yet is a holder
# between its mkdir and its pid write, so it counts as live.
RUNLOCK="$LOG_DIR/run.lock"
if ! mkdir "$RUNLOCK" 2>/dev/null; then
  HOLDER=$(cat "$RUNLOCK/pid" 2>/dev/null || echo "")
  if [ -n "$HOLDER" ] && kill -0 "$HOLDER" 2>/dev/null; then
    echo "roy-assistant: the previous tick (pid $HOLDER) is still running; this one leaves"
    exit 0
  fi
  if [ -z "$HOLDER" ] && [ -n "$(find "$RUNLOCK" -maxdepth 0 -mmin -1 2>/dev/null)" ]; then
    echo "roy-assistant: another tick is just starting; this one leaves"
    exit 0
  fi
  rm -rf "$RUNLOCK"
  mkdir "$RUNLOCK" 2>/dev/null || { echo "roy-assistant: another tick took the run lock first; this one leaves"; exit 0; }
fi
echo $$ > "$RUNLOCK/pid"
trap 'rm -rf "$RUNLOCK"' EXIT

BROKEN=""
note_broken() { BROKEN="$BROKEN $1"; echo "===== roy-assistant $(date) $1 =====" >> "$LOG"; }

# --- free half: Roy's new requests become tasks, and he gets "Got it" --------
if ! /usr/bin/python3 "$PY" poll > "$SCRATCH/poll.json" 2>"$SCRATCH/poll.err"; then
  tail -c 600 "$SCRATCH/poll.err" >&2; tail -c 600 "$SCRATCH/poll.json" >&2
  note_broken "POLL FAILED"
fi
# --- free half: tell Roy what moved since the last tick ----------------------
tell() {
  if ! /usr/bin/python3 "$PY" tell > "$SCRATCH/tell.json" 2>"$SCRATCH/tell.err"; then
    tail -c 600 "$SCRATCH/tell.err" >&2; tail -c 600 "$SCRATCH/tell.json" >&2
    note_broken "TELL FAILED"
  fi
}
tell

# --- cheap half: is a Roy request waiting for an agent? ----------------------
WAITING=$(/usr/bin/python3 "$PY" waiting 2>"$SCRATCH/waiting.err") || {
  tail -c 400 "$SCRATCH/waiting.err" >&2; note_broken "WAITING READ FAILED"; WAITING=""; }
if [ -z "$WAITING" ]; then
  [ -n "$BROKEN" ] && { echo "roy-assistant FAILED:$BROKEN — see $LOG" >&2; exit 1; }
  echo "roy-assistant: nothing waiting"
  exit 0
fi

RUNDIR="${ROY_ASSISTANT_RUNS:-$HOME/knowledge-os/logs/agent-dispatch}/$(date +%Y%m%d-%H%M%S)-roy"
mkdir -p "$RUNDIR"
fail() {
  echo "===== roy-assistant FAILED $(date): $1 — the requests stay on the board for the next tick =====" >> "$LOG"
  echo "roy-assistant FAILED: $1 — see $LOG" >&2
  # A run folder with no report reads as a dispatch run in flight to
  # handback-poll for ten minutes; say it ended.
  [ -f "$RUNDIR/report.json" ] || printf '{"aborted": %s}\n' "$(printf '%s' "$1" | /usr/bin/python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" > "$RUNDIR/report.json"
  exit 1
}

# ROY_ASSISTANT_RUN=1: only this read puts Roy's new requests in the worklist;
# every other dispatch run lists them under royRequests and leaves them alone,
# so two runs never draft the same request (this job runs outside the lock).
if ! ROY_ASSISTANT_RUN=1 /usr/bin/python3 "$REPO/scripts/agent-dispatch.py" queue > "$RUNDIR/queue.json" 2>"$RUNDIR/queue.err"; then
  tail -c 400 "$RUNDIR/queue.err" >&2; fail "queue read failed"
fi
# Only what the queue itself would hand an agent now: a held or parked task
# is not worked here just because it is Roy's.
IDS=$(/usr/bin/python3 "$PY" pending "$RUNDIR/queue.json" 2>"$RUNDIR/pending.err") \
  || fail "queue.json unreadable ($(tr -d '\n' < "$RUNDIR/pending.err" | cut -c1-160))"
if [ -z "$IDS" ]; then
  echo "roy-assistant: $WAITING waiting, none of them in the queue's new work (held or parked)" | tee -a "$LOG"
  printf '{"skipped": "no Roy request in new work"}\n' > "$RUNDIR/report.json"
  [ -n "$BROKEN" ] && exit 1
  exit 0
fi
echo "===== roy-assistant $(date) tasks=[$IDS] =====" >> "$LOG"

# --- the allowance guard (same as handback-poll and signin-pickup) -----------
if ! __PAUSE=$(/usr/bin/python3 "$REPO/scripts/allowance.py" check --job roy-assistant); then
  echo "===== roy-assistant $(date) SKIPPED: the Claude allowance is out; Roy's requests wait for the reset =====" >> "$LOG"
  printf '{"skipped": "allowance"}\n' > "$RUNDIR/report.json"
  echo "roy-assistant: skip — the Claude allowance is out ($__PAUSE)"
  exit 0
fi
if [ -f "$TOKEN_FILE" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_FILE")"
else
  fail "claude OAuth token missing at $TOKEN_FILE"
fi

__START_LINE=$( { wc -l < "$LOG"; } 2>/dev/null || echo 0)
"$CLAUDE" -p "You are a ROY'S ASSISTANT run of the agent dispatch engine. Roy Lavin, head of property, forwarded these requests to his assistant from info@agilelets.co.uk minutes ago: $IDS. Follow /Users/kevinbrittain/.claude/scheduled-tasks/agent-dispatch/SKILL.md.

RUNDIR is $RUNDIR and STEP 1 IS ALREADY DONE — $RUNDIR/queue.json was written moments ago. Do NOT re-run the queue subcommand.

WORK ONLY THESE TASK IDS: $IDS. Ignore every other item in the worklist, and do NO routing or escalation. Each is a ROY: task owned by Inbox Response; dispatch it to that local agent, whose file has a section 'Roy's requests' saying exactly how to work one: a question is answered to Roy with ROY ANSWER:, work logged for him is ROY DONE: naming every record id, and every email to a tenant, contractor or letting agent is Correspondence FROM info@agilelets.co.uk signed Roy Lavin, Agile Lets, which goes to Kevin's queue like any other card. Roy approves nothing. Do NOT send anything to Roy yourself: roy-assistant.py emails him the outcome after this run.

Everything else in the skill applies in full: the gate sits BEFORE the action; tier-1 labelling and --tier1 on tier-1 work; the carry-out closing line; step 4b's CEO review pass on non-tier-1 drafts; step 5's report.json in $RUNDIR; step 7 (verify) is mandatory. Do not take the queue lock — this run is lock-exempt and must never queue for it; Roy's new requests are listed in the worklist of THIS queue read only, so no other run drafts them. Do not edit, commit or push code; file anything needing a code change via scripts/findings.py. Working files go under $RUNDIR/TASKID/ only. End with at most ten lines of counts: no message content, no names, no record ids." \
  --add-dir "$RUNDIR" \
  --settings "$AGENT_SETTINGS_FILE" \
  --permission-mode acceptEdits \
  --allowedTools "${AGENT_ALLOWED_TOOLS[@]}" >> "$LOG" 2>&1 &
__CLAUDE_PID=$!
(
  sleep $((MAX_MINUTES * 60))
  if kill -0 "$__CLAUDE_PID" 2>/dev/null; then
    echo "===== roy-assistant OVERRAN ${MAX_MINUTES}m, stopping it =====" >> "$LOG"
    kill -TERM "$__CLAUDE_PID" 2>/dev/null
    sleep 20
    kill -KILL "$__CLAUDE_PID" 2>/dev/null
  fi
) >/dev/null 2>&1 &
__WATCHDOG_PID=$!
wait "$__CLAUDE_PID"
RC=$?
# Stop the timer AND its sleep: an orphaned sleep holding this script's output
# kept the caller waiting 30 minutes after a finished run (found by the test).
pkill -P "$__WATCHDOG_PID" 2>/dev/null
kill "$__WATCHDOG_PID" 2>/dev/null
/usr/bin/python3 "$REPO/scripts/allowance.py" mark --job roy-assistant --log "$LOG" --since-line "$__START_LINE" >/dev/null 2>&1 || true
__TAIL=$(tail -n +$((__START_LINE + 1)) "$LOG" 2>/dev/null)
__BAD=$(printf '%s\n' "$__TAIL" | grep -E '"error"|HTTP Error 401|401 Unauthorized|Unauthorized|OAuth access token has expired|BROKEN' || true)
echo "===== done rc=$RC $(date) =====" >> "$LOG"

# The outcome of this run reaches Roy now, not in ten minutes.
tell

if [ ! -f "$RUNDIR/report.json" ]; then fail "no report.json in $RUNDIR (rc=$RC)"; fi
if [ $RC -ne 0 ] || [ -n "$__BAD" ]; then
  printf '%s\n' "$__BAD" | head -5 >&2
  fail "rc=$RC, error text=$([ -n "$__BAD" ] && echo yes || echo no)"
fi
[ -n "$BROKEN" ] && { echo "roy-assistant FAILED:$BROKEN — see $LOG" >&2; exit 1; }
echo "roy-assistant OK — worked: $IDS"
