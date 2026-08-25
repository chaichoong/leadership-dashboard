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

__START_LINE=$(wc -l < "$LOG" 2>/dev/null || echo 0)
__MARKER="$SCRATCH/.run-start.$$"
touch "$__MARKER"
echo "===== task-manager run $(date) =====" >> "$LOG"
cd "$REPO" || { echo "ERROR: repo not found at $REPO" >&2; exit 1; }

"$CLAUDE" -p "You are the Task Manager agent's scheduled run (one of the 09:00 / 13:00 / 17:00 slots). Do this skill in full: $SKILL
Rules for the whole run: the BOARD PASS ALWAYS COMPLETES FIRST — never start doing work before every stuck task has its move decided. Every task write goes through scripts/agent-dispatch.py or scripts/task-manager.py — never a raw Airtable write to a task. Never route work to Mica or Ericamae (Kevin's ruling, 25 Aug 2026). Never send, reply, pay, or delete anything yourself. Working and temp files go ONLY under $SCRATCH — NEVER under the repo, and never in monitoring/ (public repository; task content includes tenant, creditor and legal detail; counts-only reports in monitoring/ are fine). A broken read is reported loudly, never treated as a quiet board. Do not take the queue lock (this run already holds it). Do not edit, commit, or push code; file anything needing a code change via scripts/findings.py. Complete the closing steps in full (score, publish, verify). End with at most twenty lines of counts only — never task content or record IDs." \
  --permission-mode acceptEdits \
  --allowedTools "Bash(python3:*)" "Bash(curl:*)" >> "$LOG" 2>&1
RC=$?

# Privacy sweep: quarantine any content-bearing file THIS RUN left in
# monitoring/ — files newer than the start marker, never git-tracked ones.
# Quarantining alone is not enough — the run FAILS so the leak-shaped
# behaviour gets fixed, not absorbed.
__LEAKED=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if git -C "$REPO" ls-files --error-unmatch "${f#"$REPO"/}" >/dev/null 2>&1; then
    continue
  fi
  if grep -qlE '"description":|Inbound Message Content|CREDITOR MATTER' "$f" 2>/dev/null; then
    mv "$f" "$SCRATCH/" && __LEAKED="$__LEAKED $f"
  fi
done < <(find "$REPO/monitoring" -type f -newer "$__MARKER" 2>/dev/null)
rm -f "$__MARKER"

__TAIL=$(tail -n +$((__START_LINE + 1)) "$LOG" 2>/dev/null)
__BAD=$(printf '%s\n' "$__TAIL" | grep -E 'HTTP Error 401|401 Unauthorized|Unauthorized|OAuth access token has expired|BROKEN|VERIFY FAIL' || true)
echo "===== done rc=$RC $(date) =====" >> "$LOG"
if [ -n "$__LEAKED" ]; then
  echo "PRIVACY: content-bearing files quarantined from monitoring/ to $SCRATCH:$__LEAKED" >&2
fi
if [ $RC -ne 0 ] || [ -n "$__BAD" ] || [ -n "$__LEAKED" ]; then
  printf '%s\n' "$__BAD" | head -5 >&2
  echo "task-manager run FAILED (rc=$RC) — see $LOG" >&2
  exit 1
fi
echo "task-manager run OK"
