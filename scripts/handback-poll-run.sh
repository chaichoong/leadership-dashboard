#!/bin/bash
# Hand-back poller — every 30 minutes, launchd com.kevinbrittain.handback-poll,
# wrapped by job-queue.py run.
#
# WHY (Kevin's call, 26 Aug 2026, from the measurement in that session):
# once he approves a piece of agent work, the agent's own effort to carry it out
# is a median of FIVE MINUTES. What he actually waited was a median of 3.6 hours
# over 1-26 Aug, and 99% of that was queue time, not work. Dispatch only opened
# the hand-back queue inside daily-ops (07:00) and the three inbound-triage slots
# (09:00 / 13:00 / 17:00), so a tap on Slack at 09:05 sat until 13:00.
#
# THE JOB NAME IS NOT A SKILL FOLDER NAME, deliberately — same reason as
# inbound-triage. check-routines.py calls anything with a folder under
# ~/.claude/scheduled-tasks/ a Claude ROUTINE and fails the build if a second one
# runs. This is a registered SHELL job that happens to invoke Claude, which is
# the sanctioned route in project_daily_ops_one_routine's "adding new scheduled
# work" table. Never create ~/.claude/scheduled-tasks/handback-poll/.
#
# HAND-BACKS ONLY. New work, routing and escalation stay in the daily slots.
# Polling those every half hour would spend Kevin's tokens re-deciding questions
# nobody has answered since the last tick; a hand-back, by contrast, exists
# precisely because he just answered one.
#
# The expensive half only runs when there is work: the gate below is a single
# Airtable read, and on a quiet tick this script costs no Claude tokens at all.
set -uo pipefail

# Tool policy is shared, never hand-rolled here — see scripts/agent-tools.sh
# for why the old two-tool cap made every agent look like it could only
# draft emails. Guarded by tests/agent-tools-parity.test.js.
. "$(dirname "$0")/agent-tools.sh"


CLAUDE="/Users/kevinbrittain/.local/bin/claude"
REPO="/Users/kevinbrittain/Projects/leadership-dashboard"
LOG_DIR="/Users/kevinbrittain/knowledge-os/logs/handback-poll"
SCRATCH="$LOG_DIR/scratch"
LOG="$LOG_DIR/runs.log"
BEATS="$LOG_DIR/heartbeat.jsonl"
POLL="$REPO/scripts/handback-poll.py"
mkdir -p "$SCRATCH"

beat() {  # decision reason handbacks spawned
  /usr/bin/python3 "$POLL" beat --log "$BEATS" --decision "$1" --reason "$2" \
    --handbacks "$3" --spawned "$4" || true
}

cd "$REPO" || { echo "ERROR: repo not found at $REPO" >&2; exit 1; }

# --- free half: store the lessons Kevin asked to be remembered -------------
# Runs on EVERY tick, including the quiet ones that exit before Claude starts.
# It costs one Airtable read and no model tokens, which is why it sits above
# the gate rather than inside the expensive half: a "reject and remember" is
# most often the LAST thing Kevin does before closing the queue, so the tick
# that follows it is usually an idle one. Gating the write on there being
# hand-back work would have delayed every lesson until the next real run.
#
# Deterministic and idempotent. A failure here must be loud but must not stop
# the hand-backs Kevin is waiting on, so it is reported and the poll continues.
if ! /usr/bin/python3 "$REPO/scripts/agent-dispatch.py" lessons > "$SCRATCH/lessons.json" 2>"$SCRATCH/lessons.err"; then
  echo "WARNING: lesson write failed — Kevin's feedback is NOT yet in the agent files" >&2
  tail -c 500 "$SCRATCH/lessons.err" >&2
  tail -c 500 "$SCRATCH/lessons.json" >&2
fi

# --- cheap half: is anything actually handed back? -------------------------
# One read, through the SAME command the real run uses, so the gate and the run
# can never disagree about what is queued. cmd_queue has its own control and
# exits non-zero when the read is broken rather than returning an empty queue.
QJSON="$SCRATCH/queue.json"
if ! /usr/bin/python3 "$REPO/scripts/agent-dispatch.py" queue > "$QJSON" 2>"$SCRATCH/queue.err"; then
  echo "ERROR: agent-dispatch queue failed — the queue read is broken, not empty" >&2
  tail -c 500 "$SCRATCH/queue.err" >&2
  beat broken "queue read failed" 0 no
  exit 1
fi

GATE="$(/usr/bin/python3 "$POLL" gate --queue "$QJSON" 2>"$SCRATCH/gate.err")"
GRC=$?
DECISION=$(printf '%s' "$GATE" | /usr/bin/python3 -c 'import json,sys;print(json.load(sys.stdin).get("decision","broken"))' 2>/dev/null || echo broken)
REASON=$(printf '%s' "$GATE" | /usr/bin/python3 -c 'import json,sys;print(json.load(sys.stdin).get("reason",""))' 2>/dev/null || echo "gate output unreadable")
TOTAL=$(printf '%s' "$GATE" | /usr/bin/python3 -c 'import json,sys;print(json.load(sys.stdin).get("total",0))' 2>/dev/null || echo 0)

if [ "$GRC" -eq 1 ]; then
  echo "ERROR: hand-back gate BROKEN — $REASON" >&2
  tail -c 500 "$SCRATCH/gate.err" >&2
  beat broken "$REASON" 0 no
  exit 1
fi
if [ "$GRC" -eq 3 ]; then
  # Idle or already busy. Both are healthy; the heartbeat is the proof the tick
  # happened, so a stopped poller cannot look like a quiet afternoon.
  beat "$DECISION" "$REASON" "$TOTAL" no
  echo "handback-poll: $DECISION — $REASON"
  exit 0
fi

# --- expensive half: wake the agents that owe Kevin an action ---------------
if [ -f "/Users/kevinbrittain/.config/od/claude_oauth_token" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat /Users/kevinbrittain/.config/od/claude_oauth_token)"
else
  echo "ERROR: claude OAuth token missing at ~/.config/od/claude_oauth_token" >&2
  beat broken "oauth token missing" "$TOTAL" no
  exit 1
fi

RUNDIR="$HOME/knowledge-os/logs/agent-dispatch/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUNDIR"
cp "$QJSON" "$RUNDIR/queue.json"

__START_LINE=$( { wc -l < "$LOG"; } 2>/dev/null || echo 0)
echo "===== handback-poll run $(date) — $REASON =====" >> "$LOG"

"$CLAUDE" -p "You are a HAND-BACK-ONLY run of the agent dispatch engine, triggered because Kevin has just decided something and an agent owes him the action. Follow /Users/kevinbrittain/.claude/scheduled-tasks/agent-dispatch/SKILL.md, with these differences, which override it:

RUNDIR is $RUNDIR and STEP 1 IS ALREADY DONE — $RUNDIR/queue.json was written moments ago by the same command. Do NOT re-run the queue subcommand and do NOT write queue2.json.

WORK ONLY THE HAND-BACKS. From the worklist, work every item whose kind is carry_out (Approval Outcome is an Approved kind) or redo (Approval Outcome is Changes requested). IGNORE new work entirely, do NO routing and NO escalation — those belong to the 09:00/13:00/17:00 slots and to daily-ops, and re-deciding them every thirty minutes would burn Kevin's tokens on questions nobody has answered since the last tick. If the only items left are new work, write the report and stop.

Everything else in the skill still applies in full and must not be weakened: the gate sits BEFORE the action; step 2's tier-1 labelling pass on every item you work, submitting tier-1 redos with --tier1; the carry_out intent/verify-first/complete discipline, including the never-automated list (payments, credentials, signatures, phone calls) which are parked and listed in parkedFlags, never retried; the MINOR-EDITS branch on every carry_out (an Approved with minor edits carrying a note means Kevin typed an edit: apply only that change, run the revise subcommand, and carry out the REVISED text — complete refuses otherwise); the mandatory closing 'Carrying this out will involve:' line under 400 characters on every redo; and step 4b's CEO review pass over non-tier-1 redos before they are submitted.

Step 5: write $RUNDIR/report.json exactly as the skill specifies, copying queueCounts, roleAgentsError and skippedTier2 VERBATIM from queue.json. Step 6's escalation DM applies as written. Step 7 (verify) is MANDATORY — run it and do not swallow its exit code. SKIP step 7b (score): the daily slots compute it and recomputing it forty-eight times a day is waste.

Do not take the queue lock — this run already holds it. Do not edit, commit or push code; file anything needing a code change via scripts/findings.py. Working and temp files go under $RUNDIR/TASKID/ only, never in monitoring/ and never anywhere else in the repo. Close with at most ten lines of counts only: no message content, no sender names, no record IDs." \
  --permission-mode acceptEdits \
  --allowedTools "${AGENT_ALLOWED_TOOLS[@]}" "Bash(osascript:*)" >> "$LOG" 2>&1
RC=$?

__TAIL=$(tail -n +$((__START_LINE + 1)) "$LOG" 2>/dev/null)
__BAD=$(printf '%s\n' "$__TAIL" | grep -E '"error"|HTTP Error 401|401 Unauthorized|Unauthorized|OAuth access token has expired|BROKEN' || true)
echo "===== done rc=$RC $(date) =====" >> "$LOG"

# A run that produced no report is a blind run, whatever it printed. verify
# refuses to grade a missing report, so check for it here too rather than
# letting an empty $RUNDIR read as a clean tick.
if [ ! -f "$RUNDIR/report.json" ]; then
  echo "ERROR: handback-poll produced no report.json in $RUNDIR — the run was blind" >&2
  beat work "$REASON" "$TOTAL" "failed-no-report"
  exit 1
fi

beat work "$REASON" "$TOTAL" yes
if [ $RC -ne 0 ] || [ -n "$__BAD" ]; then
  printf '%s\n' "$__BAD" | head -5 >&2
  __WHY=""
  [ $RC -ne 0 ] && __WHY="the command exited $RC"
  [ -n "$__BAD" ] && __WHY="${__WHY:+$__WHY; }error text in the log"
  echo "handback-poll run FAILED: $__WHY — see $LOG" >&2
  exit 1
fi
echo "handback-poll run OK — worked $TOTAL hand-back(s)"
