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

# Tool policy is shared, never hand-rolled here — see scripts/agent-tools.sh
# for why the old two-tool cap made every agent look like it could only
# draft emails. Guarded by tests/agent-tools-parity.test.js.
. "$(dirname "$0")/agent-tools.sh"


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
  --allowedTools "${AGENT_ALLOWED_TOOLS[@]}" >> "$LOG" 2>&1
RC=$?

# Privacy sweep: quarantine any content-bearing file THIS RUN left in
# monitoring/. Only files newer than the start marker, and never a git-tracked
# one — the triage agent's version of this sweep quarantined 41 committed
# schema files on 25 Aug 2026 by matching across all of monitoring/.
# Quarantining alone is not enough: the run FAILS, so the leak-shaped behaviour
# gets fixed rather than absorbed.
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
  echo "$JOB slot run FAILED (rc=$RC) — see $LOG" >&2
  exit 1
fi
echo "$JOB slot run OK"
