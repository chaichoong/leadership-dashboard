#!/bin/bash
# Sign-in pickup — started by the Robot sign-in app once Kevin has quit the LAST
# sign-in window, wrapped by job-queue.py run so it holds the lock like every
# other job.
#
# WHY (Kevin, 4 Sep 2026): a task that met a signed-out site sat in his queue
# as "SIGN-IN NEEDED" until he signed in, approved, and the 30-minute poller
# came round; for GOV.UK sites the session had often lapsed again by then.
#
# HOW (8 Sep 2026): the app runs `agent-dispatch.py signin-done` itself the
# moment each window closes; signin-done hands the site's waiting tasks back
# to their robots AND appends one line per site to pending.jsonl. This run
# takes that file over (rename, so a hand-back landing mid-run is kept for the
# next run) and works exactly those tasks, straight away, while the sessions
# are live. It used to run signin-done itself and was started after EVERY
# window; the robot profile can only be open in one place, so that run and the
# next sign-in window collided, and its shell held the app's pipe open.
#
# Usage: signin-pickup-run.sh [host ...]
#   With hosts (manual use): runs signin-done for each first, then picks up.
set -uo pipefail
. "$(dirname "$0")/agent-tools.sh"
CLAUDE="/Users/kevinbrittain/.local/bin/claude"
REPO="${SIGNIN_PICKUP_REPO:-/Users/kevinbrittain/Projects/leadership-dashboard}"
LOG_DIR="/Users/kevinbrittain/knowledge-os/logs/signin-pickup"
LOG="$LOG_DIR/runs.log"
PENDING="${SIGNIN_PICKUP_DIR:-$LOG_DIR}/pending.jsonl"
mkdir -p "$LOG_DIR"
cd "$REPO" || { echo "ERROR: repo not found at $REPO" >&2; exit 1; }

RUNDIR="$HOME/knowledge-os/logs/agent-dispatch/$(date +%Y%m%d-%H%M%S)-signin"
mkdir -p "$RUNDIR"
for HOST in "$@"; do
  if ! /usr/bin/python3 "$REPO/scripts/agent-dispatch.py" signin-done --site "$HOST" > "$RUNDIR/signin-done-$HOST.json" 2>"$RUNDIR/signin-done.err"; then
    echo "ERROR: signin-done failed for $HOST" >&2; tail -c 400 "$RUNDIR/signin-done.err" >&2; exit 1
  fi
done
if [ ! -s "$PENDING" ]; then
  echo "===== signin-pickup $(date) nothing pending =====" >> "$LOG"
  echo "signin-pickup: nothing was handed back since the last run" | tee -a "$LOG"; exit 0
fi
mv "$PENDING" "$RUNDIR/pending.jsonl"
IDS=$(/usr/bin/python3 -c 'import json,sys
ids=[]
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    for t in json.loads(line).get("tasks",[]):
        if t not in ids: ids.append(t)
print(" ".join(ids))' "$RUNDIR/pending.jsonl")
LABEL=$(/usr/bin/python3 -c 'import json,sys
labels=[]
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    l=json.loads(line).get("label","")
    if l and l not in labels: labels.append(l)
print(", ".join(labels))' "$RUNDIR/pending.jsonl")
echo "===== signin-pickup $(date) sites=$LABEL tasks=[$IDS] =====" >> "$LOG"
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
"$CLAUDE" -p "You are a SIGN-IN PICKUP run of the agent dispatch engine. Kevin has just signed the robot browser into these sites: $LABEL. These tasks were waiting on exactly those sign-ins: $IDS. Follow /Users/kevinbrittain/.claude/scheduled-tasks/agent-dispatch/SKILL.md.

RUNDIR is $RUNDIR and STEP 1 IS ALREADY DONE — $RUNDIR/queue.json was written moments ago. Do NOT re-run the queue subcommand.

WORK ONLY THESE TASK IDS: $IDS. Ignore every other item in the worklist. For each one, read its Notes: the last line says SIGNED IN and tells the agent to carry on from where it stopped. The session is live NOW and may lapse within the hour, so do the browser steps first. FIRST COMMAND for each site: node scripts/agent-browser.js session --site <host> (it walks the sign-in door and prints signedIn true/false with the landing URL; never judge a sign-in page yourself: the WebFiling entry always shows a Sign in page before the walk). If signedIn is true, go straight on with node scripts/agent-browser.js read/prepare (screenshots attached), then submit the finished work through agent-dispatch.py submit as the skill specifies. Never run agent-browser.js login: that window is Kevin's step only. Never type a password, code or card detail. Work them in the order given: short-session sites (GOV.UK, HMRC) come first because their sessions lapse within the hour. If a site is STILL signed out when you look, say so in the output with the single line SIGN-IN NEEDED: <site> (<login url>) and stop.

Everything else in the skill applies in full: the gate sits BEFORE the action; tier-1 labelling and --tier1 on tier-1 work; the carry-out closing line; step 5's report.json in $RUNDIR; step 7 (verify) is mandatory. Do not take the queue lock — this run already holds it. Do not edit, commit or push code; file anything needing a code change via scripts/findings.py. Working files go under $RUNDIR/TASKID/ only. End with at most ten lines of counts." \
  --permission-mode acceptEdits \
  --allowedTools "${AGENT_ALLOWED_TOOLS[@]}" "Bash(osascript:*)" >> "$LOG" 2>&1
RC=$?
__TAIL=$(tail -n +$((__START_LINE + 1)) "$LOG" 2>/dev/null)
__BAD=$(printf '%s\n' "$__TAIL" | grep -E '"error"|HTTP Error 401|401 Unauthorized|Unauthorized|OAuth access token has expired|BROKEN' || true)
echo "===== done rc=$RC $(date) =====" >> "$LOG"
printf '{"at":"%s","sites":"%s","tasks":"%s","rc":%s,"errors":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LABEL" "$IDS" "$RC" "$([ -n "$__BAD" ] && echo true || echo false)" >> "$LOG_DIR/runs.jsonl"
if [ ! -f "$RUNDIR/report.json" ]; then echo "ERROR: signin-pickup produced no report.json in $RUNDIR" >&2; exit 1; fi
if [ $RC -ne 0 ] || [ -n "$__BAD" ]; then printf '%s\n' "$__BAD" | head -5 >&2; echo "signin-pickup FAILED (rc=$RC, error text=$([ -n "$__BAD" ] && echo yes || echo no)) — see $LOG" >&2; exit 1; fi
echo "signin-pickup OK — worked: $IDS"
