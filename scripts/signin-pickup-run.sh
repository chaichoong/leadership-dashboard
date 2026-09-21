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
# moment each window closes (and `signin-waiting` runs it for any site the
# robot was already signed into); signin-done hands the site's waiting tasks
# back to their robots AND appends one line per site to pending.jsonl. This
# run COPIES that file (a hand-back landing mid-run is kept for the next run)
# and works exactly those tasks, straight away, while the sessions are live.
# It used to run signin-done itself and was started after EVERY window; the
# robot profile can only be open in one place, so that run and the next
# sign-in window collided, and its shell held the app's pipe open.
#
# A FAILED RUN KEEPS ITS HAND-BACKS (15 Sep 2026). The file used to be taken
# over by rename before the run started, and nothing put it back. On 11 Sep
# the run died in eight seconds on "You've hit your limit" and the three
# tasks it held were lost from every surface: signin-done had set them to
# Today with the approval fields cleared, the pickup's own record of them was
# in a run directory nobody reads, and the 30-minute poll counted only
# approved/changes/deferred hand-backs. Now the lines are removed from
# pending.jsonl only after a clean run (rc=0, report written, no error text),
# the Claude allowance is checked before the run starts (scripts/allowance.py,
# same guard as handback-poll-run.sh), and every failure is one line in the
# log plus a non-zero exit, which job-queue.py records as outcome "failed" —
# the Estate status tab shows that as a Failed row (scripts/estate-status.py).
# The tasks themselves are also counted as signinReopened by `queue`, so the
# poll wakes for them whatever happened here.
#
# Usage: signin-pickup-run.sh [host ...]
#   With hosts (manual use): runs signin-done for each first, then picks up.
#
# Test seams (tests/signin-pickup.test.js runs this script with stubs):
#   SIGNIN_PICKUP_REPO      the repo whose scripts/ are called (stubs in tests)
#   SIGNIN_PICKUP_DIR       where pending.jsonl lives
#   SIGNIN_PICKUP_LOG_DIR   runs.log / runs.jsonl
#   SIGNIN_PICKUP_RUNS      parent of the per-run RUNDIR
#   SIGNIN_PICKUP_CLAUDE    the claude binary
#   SIGNIN_PICKUP_TOKEN     the OAuth token file
set -uo pipefail
. "$(dirname "$0")/agent-tools.sh"
CLAUDE="${SIGNIN_PICKUP_CLAUDE:-/Users/kevinbrittain/.local/bin/claude}"
REPO="${SIGNIN_PICKUP_REPO:-/Users/kevinbrittain/Projects/leadership-dashboard}"
LOG_DIR="${SIGNIN_PICKUP_LOG_DIR:-/Users/kevinbrittain/knowledge-os/logs/signin-pickup}"
LOG="$LOG_DIR/runs.log"
PENDING="${SIGNIN_PICKUP_DIR:-$LOG_DIR}/pending.jsonl"
TOKEN_FILE="${SIGNIN_PICKUP_TOKEN:-/Users/kevinbrittain/.config/od/claude_oauth_token}"
mkdir -p "$LOG_DIR"
cd "$REPO" || { echo "ERROR: repo not found at $REPO" >&2; exit 1; }

RUNDIR="${SIGNIN_PICKUP_RUNS:-$HOME/knowledge-os/logs/agent-dispatch}/$(date +%Y%m%d-%H%M%S)-signin"
mkdir -p "$RUNDIR"

# One line in the log and a non-zero exit: job-queue.py turns that into the
# "failed" outcome the Estate status tab reports. pending.jsonl is untouched
# (it was only copied), so the next pickup and the poll both still see the work.
fail() {
  echo "===== signin-pickup FAILED $(date): $1 — pending.jsonl kept; the 30-minute poll works the reopened tasks =====" >> "$LOG"
  echo "signin-pickup FAILED: $1 — see $LOG" >&2
  exit 1
}

for HOST in "$@"; do
  if ! /usr/bin/python3 "$REPO/scripts/agent-dispatch.py" signin-done --site "$HOST" > "$RUNDIR/signin-done-$HOST.json" 2>"$RUNDIR/signin-done.err"; then
    tail -c 400 "$RUNDIR/signin-done.err" >&2; fail "signin-done failed for $HOST"
  fi
done
if [ ! -s "$PENDING" ]; then
  echo "===== signin-pickup $(date) nothing pending =====" >> "$LOG"
  echo "signin-pickup: nothing was handed back since the last run" | tee -a "$LOG"; exit 0
fi
# A COPY, never a move: the live file is only trimmed after a clean run. Taken
# under the lock signin-done appends with, so the copy never holds half a line.
/usr/bin/python3 -c 'import fcntl, shutil, sys
with open(sys.argv[1]) as fh:
    fcntl.flock(fh, fcntl.LOCK_SH)
    shutil.copyfile(sys.argv[1], sys.argv[2])
    fcntl.flock(fh, fcntl.LOCK_UN)' "$PENDING" "$RUNDIR/pending.jsonl" || fail "could not copy $PENDING"
IDS=$(/usr/bin/python3 -c 'import json,sys
ids=[]
for n, line in enumerate(open(sys.argv[1]), 1):
    line=line.strip()
    if not line: continue
    try: rec=json.loads(line)
    except ValueError: sys.exit("line %d of pending.jsonl is not JSON: %r" % (n, line[:80]))
    for t in rec.get("tasks",[]):
        if t not in ids: ids.append(t)
print(" ".join(ids))' "$RUNDIR/pending.jsonl" 2>"$RUNDIR/pending.err") || fail "pending.jsonl is unreadable ($(tr -d '\n' < "$RUNDIR/pending.err" | cut -c1-160)); nothing trimmed — delete that line by hand"
LABEL=$(/usr/bin/python3 -c 'import json,sys
labels=[]
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    l=json.loads(line).get("label","")
    if l and l not in labels: labels.append(l)
print(", ".join(labels))' "$RUNDIR/pending.jsonl") || fail "pending.jsonl is unreadable (a line is not JSON); nothing trimmed"
echo "===== signin-pickup $(date) sites=$LABEL tasks=[$IDS] =====" >> "$LOG"

# Remove the lines this run took (and only those) from the live file. Called
# on a clean run, and when nothing in the copy is still waiting. Rewritten IN
# PLACE under the same lock signin-done takes to append: never renamed or
# unlinked, because a signin-done already waiting on the lock holds the old
# inode and would append its hand-back to a file nobody reads (review, 15 Sep
# 2026). An empty file is "nothing pending" (the -s test above).
trim_pending() {
  /usr/bin/python3 - "$PENDING" "$RUNDIR/pending.jsonl" <<'PY'
import fcntl, sys
live, taken = sys.argv[1], sys.argv[2]
try:
    done = {l.strip() for l in open(taken) if l.strip()}
    with open(live, "r+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        keep = [l if l.endswith("\n") else l + "\n" for l in fh if l.strip() and l.strip() not in done]
        fh.seek(0)
        fh.truncate()
        fh.writelines(keep)
        fh.flush()
        fcntl.flock(fh, fcntl.LOCK_UN)
except FileNotFoundError:
    sys.exit(0)
PY
}

if [ -z "$IDS" ]; then echo "signin-pickup: nothing was waiting on $LABEL" | tee -a "$LOG"; trim_pending; exit 0; fi

if ! /usr/bin/python3 "$REPO/scripts/agent-dispatch.py" queue > "$RUNDIR/queue.json" 2>"$RUNDIR/queue.err"; then
  tail -c 400 "$RUNDIR/queue.err" >&2; fail "queue read failed — the handed-back tasks are on the board for the next slot"
fi
# Only the tasks STILL waiting since the sign-in are worked: a line left
# behind by a paused or failed run may name tasks the poll has worked since,
# and a robot told to "work these ids" would work them again. `queue` flags
# them signinReopened (newest note is SIGNED IN, nothing since).
# A queue.json WITHOUT the key is a broken read, never an empty list: a
# missing key that read as "nothing waiting" would trim the hand-backs away.
IDS=$(/usr/bin/python3 -c 'import json,sys
q=json.load(open(sys.argv[1]))
if "signinReopened" not in q: sys.exit(2)
still=set(q["signinReopened"] or [])
print(" ".join(i for i in sys.argv[2].split() if i in still))' "$RUNDIR/queue.json" "$IDS") || fail "queue.json carries no signinReopened key — the queue read is from an engine without it, not an empty list"
if [ -z "$IDS" ]; then
  echo "signin-pickup: none of the handed-back tasks still waits on the sign-in (already worked, or re-parked since); nothing to pick up" | tee -a "$LOG"
  trim_pending; exit 0
fi

# --- the allowance guard (Kevin, 14 Sep 2026; here since 15 Sep) ------------
# While the Claude allowance is out, waking an agent only burns the start-up
# cost and dies — which is exactly how the three tasks of 11 Sep were lost.
# A paused pickup exits 0 with the file intact; the poll works the tasks
# after the reset (they stay signinReopened).
if ! __PAUSE=$(/usr/bin/python3 "$REPO/scripts/allowance.py" check --job signin-pickup); then
  echo "===== signin-pickup $(date) SKIPPED: the Claude allowance is out; pending kept, the 30-minute poll works the reopened tasks after the reset =====" >> "$LOG"
  echo "signin-pickup: skip — the Claude allowance is out ($__PAUSE); the handed-back tasks stay pending and the 30-minute poll works them after the reset"
  exit 0
fi

if [ -f "$TOKEN_FILE" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_FILE")"
else
  fail "claude OAuth token missing at $TOKEN_FILE; tasks are on the board for the next slot"
fi
__START_LINE=$( { wc -l < "$LOG"; } 2>/dev/null || echo 0)
"$CLAUDE" -p "You are a SIGN-IN PICKUP run of the agent dispatch engine. Kevin has just signed the robot browser into these sites: $LABEL. These tasks were waiting on exactly those sign-ins: $IDS. Follow /Users/kevinbrittain/.claude/scheduled-tasks/agent-dispatch/SKILL.md.

RUNDIR is $RUNDIR and STEP 1 IS ALREADY DONE — $RUNDIR/queue.json was written moments ago. Do NOT re-run the queue subcommand.

WORK ONLY THESE TASK IDS: $IDS. Ignore every other item in the worklist. For each one, read its Notes: the last line says SIGNED IN and tells the agent to carry on from where it stopped. The session is live NOW and may lapse within the hour, so do the browser steps first. FIRST COMMAND for each site: node scripts/agent-browser.js session --site <host> (it walks the sign-in door and prints signedIn true/false with the landing URL; never judge a sign-in page yourself: the WebFiling entry always shows a Sign in page before the walk). If signedIn is true, go straight on with node scripts/agent-browser.js read/prepare (screenshots attached), then submit the finished work through agent-dispatch.py submit as the skill specifies. Never run agent-browser.js login: that window is Kevin's step only. Never type a password, code or card detail. Work them in the order given: short-session sites (GOV.UK, HMRC) come first because their sessions lapse within the hour. If a site is STILL signed out when you look, say so in the output with the single line SIGN-IN NEEDED: <site> (<login url>) and stop.

Everything else in the skill applies in full: the gate sits BEFORE the action; tier-1 labelling and --tier1 on tier-1 work; the carry-out closing line; step 5's report.json in $RUNDIR; step 7 (verify) is mandatory. Do not take the queue lock — this run already holds it. Do not edit, commit or push code; file anything needing a code change via scripts/findings.py. Working files go under $RUNDIR/TASKID/ only. End with at most ten lines of counts." \
  --settings "$AGENT_SETTINGS_FILE" \
  --permission-mode acceptEdits \
  --allowedTools "${AGENT_ALLOWED_TOOLS[@]}" "Bash(osascript:*)" >> "$LOG" 2>&1
RC=$?
/usr/bin/python3 "$REPO/scripts/allowance.py" mark --job signin-pickup --log "$LOG" --since-line "$__START_LINE" >/dev/null 2>&1 || true
__TAIL=$(tail -n +$((__START_LINE + 1)) "$LOG" 2>/dev/null)
__BAD=$(printf '%s\n' "$__TAIL" | grep -E '"error"|HTTP Error 401|401 Unauthorized|Unauthorized|OAuth access token has expired|BROKEN' || true)
echo "===== done rc=$RC $(date) =====" >> "$LOG"
printf '{"at":"%s","sites":"%s","tasks":"%s","rc":%s,"errors":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LABEL" "$IDS" "$RC" "$([ -n "$__BAD" ] && echo true || echo false)" >> "$LOG_DIR/runs.jsonl"
if [ ! -f "$RUNDIR/report.json" ]; then fail "no report.json in $RUNDIR (rc=$RC)"; fi
if [ $RC -ne 0 ] || [ -n "$__BAD" ]; then
  printf '%s\n' "$__BAD" | head -5 >&2
  fail "rc=$RC, error text=$([ -n "$__BAD" ] && echo yes || echo no)"
fi
trim_pending
echo "signin-pickup OK — worked: $IDS"
