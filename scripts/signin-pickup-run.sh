#!/bin/bash
# Sign-in pickup — started by the Robot sign-in app the moment Kevin quits a
# sign-in window, wrapped by job-queue.py run so it holds the lock like every
# other job.
#
# WHY (Kevin, 4 Sep 2026): a task that met a signed-out site sat in his queue
# as "SIGN-IN NEEDED" until he signed in, approved, and the 30-minute poller
# came round; for GOV.UK sites the session had often lapsed again by then.
# Now: signin-done hands the site's waiting tasks back to their robots, and
# this run works ONLY those tasks, straight away.
#
# Usage: signin-pickup-run.sh <allowlist host>     e.g. app.pingen.com
set -uo pipefail
. "$(dirname "$0")/agent-tools.sh"
CLAUDE="/Users/kevinbrittain/.local/bin/claude"
REPO="/Users/kevinbrittain/Projects/leadership-dashboard"
LOG_DIR="/Users/kevinbrittain/knowledge-os/logs/signin-pickup"
LOG="$LOG_DIR/runs.log"
HOST="${1:-}"
[ -n "$HOST" ] || { echo "usage: signin-pickup-run.sh <host>" >&2; exit 2; }
mkdir -p "$LOG_DIR"
cd "$REPO" || { echo "ERROR: repo not found at $REPO" >&2; exit 1; }

RUNDIR="$HOME/knowledge-os/logs/agent-dispatch/$(date +%Y%m%d-%H%M%S)-signin"
mkdir -p "$RUNDIR"
if ! /usr/bin/python3 "$REPO/scripts/agent-dispatch.py" signin-done --site "$HOST" > "$RUNDIR/signin-done.json" 2>"$RUNDIR/signin-done.err"; then
  echo "ERROR: signin-done failed for $HOST" >&2; tail -c 400 "$RUNDIR/signin-done.err" >&2; exit 1
fi
IDS=$(/usr/bin/python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(" ".join(t["task"] for t in d.get("handedBack",[])))' "$RUNDIR/signin-done.json")
LABEL=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("label",""))' "$RUNDIR/signin-done.json")
echo "===== signin-pickup $(date) site=$HOST label=$LABEL tasks=[$IDS] =====" >> "$LOG"
if [ -z "$IDS" ]; then echo "signin-pickup: nothing was waiting on $LABEL" | tee -a "$LOG"; exit 0; fi

if ! /usr/bin/python3 "$REPO/scripts/agent-dispatch.py" queue > "$RUNDIR/queue.json" 2>"$RUNDIR/queue.err"; then
  echo "ERROR: queue read failed — the handed-back tasks are on the board for the next slot" >&2; exit 1
fi
if [ -f "/Users/kevinbrittain/.config/od/claude_oauth_token" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat /Users/kevinbrittain/.config/od/claude_oauth_token)"
else
  echo "ERROR: claude OAuth token missing; tasks are on the board for the next slot" >&2; exit 1
fi
__START_LINE=$( { wc -l < "$LOG"; } 2>/dev/null || echo 0)
"$CLAUDE" -p "You are a SIGN-IN PICKUP run of the agent dispatch engine. Kevin has just signed the robot browser into $LABEL, and these tasks were waiting on exactly that: $IDS. Follow /Users/kevinbrittain/.claude/scheduled-tasks/agent-dispatch/SKILL.md.

RUNDIR is $RUNDIR and STEP 1 IS ALREADY DONE — $RUNDIR/queue.json was written moments ago. Do NOT re-run the queue subcommand.

WORK ONLY THESE TASK IDS: $IDS. Ignore every other item in the worklist. For each one, read its Notes: the last line says SIGNED IN and tells the agent to carry on from where it stopped. The session is live NOW and may lapse within the hour, so do the browser steps first (node scripts/agent-browser.js read/prepare, screenshots attached), then submit the finished work through agent-dispatch.py submit as the skill specifies. Never type a password, code or card detail. If the site is STILL signed out when you look, say so in the output with the single line SIGN-IN NEEDED: $LABEL and the login URL, and stop.

Everything else in the skill applies in full: the gate sits BEFORE the action; tier-1 labelling and --tier1 on tier-1 work; the carry-out closing line; step 5's report.json in $RUNDIR; step 7 (verify) is mandatory. Do not take the queue lock — this run already holds it. Do not edit, commit or push code; file anything needing a code change via scripts/findings.py. Working files go under $RUNDIR/TASKID/ only. End with at most ten lines of counts." \
  --permission-mode acceptEdits \
  --allowedTools "${AGENT_ALLOWED_TOOLS[@]}" "Bash(osascript:*)" >> "$LOG" 2>&1
RC=$?
echo "===== done rc=$RC $(date) =====" >> "$LOG"
if [ ! -f "$RUNDIR/report.json" ]; then echo "ERROR: signin-pickup produced no report.json in $RUNDIR" >&2; exit 1; fi
[ $RC -eq 0 ] && echo "signin-pickup OK — worked: $IDS" || { echo "signin-pickup FAILED rc=$RC — see $LOG" >&2; exit 1; }
