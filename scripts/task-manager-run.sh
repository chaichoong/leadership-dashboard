#!/bin/bash
# Task Manager agent — its own Go Signal (Kevin's ruling, 25 Aug 2026):
# 09:00, 13:00 and 17:00 local daily, launchd com.kevinbrittain.task-manager,
# wrapped by job-queue.py run. The job name "task-manager" is deliberately
# NOT the name of any skill folder (the skill folder is task-manager-board),
# so check-routines.py sees a registered shell job rather than a second
# Claude routine. The one-routine rule's fixed-slot exception follows the
# same explicit ruling pattern as inbound-triage, recorded in
# docs/daily-ops-routine.md — do not fold this back into daily-ops without
# Kevin's word.
#
# The inbound-triage slot job shares these hours; the queue lock stops the
# two running at once, but the order within the hour is whichever launchd
# starts first — the board pass tolerates either order (dispatch's in-flight
# tasks are subtracted in code via board --dispatch-queue).
#
# Each slot runs the board pass: read every open task, force ONE move on each
# stuck one, report what should have moved and did not. All task writes go
# through scripts/agent-dispatch.py (route/handover/escalate/submit/annotate/
# complete), so approval gating and the register pause lever hold. Nothing
# here can send email or Slack directly.
#
# PRIVACY: task names and descriptions carry tenant, creditor and legal
# detail. Working files go ONLY under $SCRATCH; monitoring/ is committed to a
# PUBLIC repo, so anything content-bearing THIS RUN writes there is
# quarantined and the run fails loudly. The sweep only looks at files newer
# than this run's start marker and never touches git-tracked files — the
# triage agent's version of this sweep quarantined 41 committed schema files
# on 25 Aug 2026 because it matched patterns across ALL of monitoring/.
set -u

# Tool policy is shared, never hand-rolled here — see scripts/agent-tools.sh
# for why the old two-tool cap made every agent look like it could only
# draft emails. Guarded by tests/agent-tools-parity.test.js.
. "$(dirname "$0")/agent-tools.sh"

CLAUDE="/Users/kevinbrittain/.local/bin/claude"
REPO="/Users/kevinbrittain/Projects/leadership-dashboard"
LOG_DIR="/Users/kevinbrittain/knowledge-os/logs/task-manager"
SCRATCH="$LOG_DIR/scratch"
LOG="$LOG_DIR/runs.log"
SKILL="/Users/kevinbrittain/.claude/scheduled-tasks/task-manager-board/SKILL.md"
mkdir -p "$SCRATCH"
# The skill's commands reference these paths; export so the headless agent's
# shell resolves them identically.
export TASK_MANAGER_SCRATCH="$SCRATCH"
export TASK_MANAGER_LOG_DIR="$LOG_DIR"
# When THIS run began, for task-manager.py verify: a board.json or gate.json
# older than this is a previous slot's read, and a report built on it is a
# report about a board nobody looked at (finding 20260902-task-manager-17-435:
# the 17:00 slot reported 259 open tasks off a hand-rolled read while
# board.json still carried the 13:00 slot's).
export TASK_MANAGER_RUN_START="$(date +%s)"
rm -f "$SCRATCH/verify-result.json"

# A missing skill file must be a loud failure, not a polite no-op: headless
# claude exits 0 after saying it cannot find the file, which run-job.sh would
# read as success while three board passes a day silently did nothing.
if [ ! -f "$SKILL" ]; then
  echo "BROKEN: skill file missing at $SKILL (run scripts/sync-scheduled-tasks.py --push)" >&2
  exit 1
fi

# Same token discipline as inbound-triage-run.sh: without the exported OAuth
# token a headless `claude -p` dies with "OAuth access token has expired".
if [ -f "/Users/kevinbrittain/.config/od/claude_oauth_token" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat /Users/kevinbrittain/.config/od/claude_oauth_token)"
else
  echo "ERROR: claude OAuth token missing at ~/.config/od/claude_oauth_token" >&2
  exit 1
fi

__START_LINE=$( { wc -l < "$LOG"; } 2>/dev/null || echo 0)
__MARKER="$SCRATCH/.run-start.$$"
touch "$__MARKER"
# WHICH SLOT IS THIS? Decided here, by the clock, once (finding
# 20260829-daily-ops-396). See scripts/slot-label.py — the agent used to guess,
# and it guessed "13:00 slot" every run.
SLOT_LABEL="$(/usr/bin/python3 "$REPO/scripts/slot-label.py" 2>/dev/null || echo unknown)"
echo "===== task-manager run [$SLOT_LABEL slot] $(date) =====" >> "$LOG"

# Finding 20260827-phase-2-382: the inbound-triage 09:00 slot on 26 Aug died
# leaving a start header and no done line, indistinguishable from a run still
# going. Same shape applies here, so every wrapper now traps catchable
# terminations (TERM from launchd/session teardown, HUP, INT) and writes a
# done line before dying. A SIGKILL is untrappable by anything; that death
# still shows as a start header with an ABNORMAL line missing, but every
# catchable one is now logged.
__POSTRUN_DONE=0
__on_exit() {
  __rc=$?
  if [ "$__POSTRUN_DONE" -eq 0 ]; then
    echo "===== done rc=$__rc (ABNORMAL: wrapper terminated before postrun) $(date) =====" >> "$LOG"
    echo "task-manager run DIED before completing (rc=$__rc) — see $LOG" >&2
  fi
}
trap __on_exit EXIT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 130' INT
cd "$REPO" || { echo "ERROR: repo not found at $REPO" >&2; exit 1; }

"$CLAUDE" -p "You are the Task Manager agent's scheduled run. THIS RUN IS THE $SLOT_LABEL SLOT — that is the wall clock at run start, read for you. Head your report with exactly '$SLOT_LABEL slot' and never substitute a slot you worked out yourself. Do this skill in full: $SKILL
Rules for the whole run: your working directory for every file you write is $SCRATCH (absolute path) — helper scripts, proposal texts, briefings, JSON, everything; the repo is PUBLIC and the after-run sweep quarantines anything you leave in it. Record IDs come ONLY from board.json, gate.json or dispatch-queue.json — copy them programmatically, never retype one (a retyped id with one wrong letter escalated nothing on 2 Sep 2026 and read as a permissions error). The BOARD PASS ALWAYS COMPLETES FIRST — never start doing work before every stuck task has its move decided. Every task write goes through scripts/agent-dispatch.py or scripts/task-manager.py — never a raw Airtable write to a task. Never route work to Mica or Ericamae (Kevin's ruling, 25 Aug 2026). Never send, reply, pay, or delete anything yourself. Working and temp files go ONLY under $SCRATCH — NEVER under the repo, and never in monitoring/ (public repository; task content includes tenant, creditor and legal detail; counts-only reports in monitoring/ are fine). A broken read is reported loudly, never treated as a quiet board. Do not take the queue lock (this run already holds it). Do not edit, commit, or push code; file anything needing a code change via scripts/findings.py. Complete the closing steps in full (score, publish, verify). End with at most twenty lines of counts only — never task content or record IDs." \
  --permission-mode acceptEdits \
  --allowedTools "${AGENT_ALLOWED_TOOLS[@]}" >> "$LOG" 2>&1
RC=$?

# The verify verdict is a FILE, not a sentence (finding
# 20260902-task-manager-17-435). `claude -p` prints only the agent's closing
# text, so the log tail carried "VERIFY: FAILED" in the agent's own words
# and the failure-marker pattern ("VERIFY FAIL") never matched; the run was
# reported OK with a failed self-check inside it. task-manager.py verify now
# writes $SCRATCH/verify-result.json on every run, pass or fail. A verdict
# that is missing (verify never ran) or false is written into the log tail
# in the marker form, so the shared epilogue fails the run with its reason.
__VERDICT="$SCRATCH/verify-result.json"
if [ ! -f "$__VERDICT" ] || [ ! "$__VERDICT" -nt "$__MARKER" ]; then
  echo "TASK-MANAGER VERIFY FAIL: verify never ran this slot (no fresh $__VERDICT)" >> "$LOG"
elif ! /usr/bin/python3 -c "import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get('verified') is True else 1)" "$__VERDICT" 2>/dev/null; then
  echo "TASK-MANAGER VERIFY FAIL: $(/usr/bin/python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('; '.join(d.get('problems') or ['verdict false']))" "$__VERDICT" 2>/dev/null | cut -c1-400)" >> "$LOG"
fi

# Shared epilogue (finding 20260827-phase-2-381): privacy sweep, done line,
# and exit-code semantics live in ONE place now — scripts/slot-postrun.sh.
# The old inline copy of this block hard-failed a SUCCESSFUL run when the
# sweep quarantined the drift scanner's schema snapshot, reporting
# "FAILED (rc=0)". The helper preserves the real rc, treats a quarantine as
# informational, and never quarantines schema-YYYY-MM-DD.json.
"$REPO/scripts/slot-postrun.sh" "task-manager" "$RC" "$LOG" "$__START_LINE" "$__MARKER" "$SCRATCH" \
  '"description" *:|"Inbound Message Content" *:|CREDITOR MATTER' \
  'HTTP Error 401|401 Unauthorized|Unauthorized|OAuth access token has expired|BROKEN|VERIFY FAIL'
__FINAL=$?
__POSTRUN_DONE=1
exit "$__FINAL"
