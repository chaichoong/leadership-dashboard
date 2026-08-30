#!/bin/bash
# Shared epilogue for every role-agent slot wrapper (task-manager-run.sh,
# inbound-triage-run.sh, agent-slot-run.sh). One copy, because on 26 Aug 2026
# three diverging copies of this block turned a SUCCESSFUL 17:00 board pass
# into "task-manager run FAILED (rc=0)" (finding 20260827-phase-2-381): the
# privacy sweep quarantined monitoring/schema-2026-08-26.json (the drift
# scanner's Airtable schema snapshot, whose field DESCRIPTIONS matched the
# '"description":' leak pattern) and the failure branch then reported the run
# as failed even though the agent's own exit code was 0.
#
# The contract now:
#   - The run's REAL exit code is preserved. rc!=0 fails with that rc.
#   - Auth or broken markers in the log tail fail the run (exit 1) even on
#     rc=0, because a headless claude exits 0 after printing a 401.
#   - A privacy quarantine alone is INFORMATIONAL: the file is moved to
#     scratch and reported loudly on stderr (which lands in the job-status
#     tail), but a successful run is still reported as successful. The old
#     hard-fail did not teach anyone anything; it mislabelled good runs.
#   - Drift's schema snapshots (monitoring/schema-YYYY-MM-DD.json) are never
#     quarantined: they carry field NAMES and DESCRIPTIONS from the table
#     structure, not message content. They false-positived on 25 Aug 2026
#     (41 committed files, saved only by the git-tracked exemption) and again
#     on 26 Aug (that day's file, untracked until the nightly fixer commits
#     it, so the git-tracked exemption could not save it).
#   - Git-tracked files are never quarantined (as before): moving one re-arms
#     the failure for the next slot after a git restore.
#
# Usage:
#   slot-postrun.sh <job> <rc> <log> <start_line> <marker> <scratch> \
#                   <leak_ere> <bad_ere>
# SLOT_POSTRUN_REPO overrides the repo root (used by tests/slot-postrun.test.js).
set -u
JOB="${1:?job}"
RC="${2:?rc}"
LOG="${3:?log}"
START_LINE="${4:?start_line}"
MARKER="${5:?marker}"
SCRATCH="${6:?scratch}"
LEAK_ERE="${7:?leak_ere}"
BAD_ERE="${8:?bad_ere}"
REPO="${SLOT_POSTRUN_REPO:-/Users/kevinbrittain/Projects/leadership-dashboard}"

# Privacy sweep: quarantine content-bearing files THIS RUN left in
# monitoring/ (files newer than the start marker only), never git-tracked
# files, never the drift scanner's schema snapshots.
LEAKED=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$(basename "$f")" in
    schema-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json) continue ;;
  esac
  if git -C "$REPO" ls-files --error-unmatch "${f#"$REPO"/}" >/dev/null 2>&1; then
    continue
  fi
  if grep -qlE "$LEAK_ERE" "$f" 2>/dev/null; then
    mv "$f" "$SCRATCH/" && LEAKED="$LEAKED $f"
  fi
done < <(find "$REPO/monitoring" -type f -newer "$MARKER" 2>/dev/null)
rm -f "$MARKER"

TAIL_TEXT=$(tail -n +$((START_LINE + 1)) "$LOG" 2>/dev/null)
BAD=$(printf '%s\n' "$TAIL_TEXT" | grep -E "$BAD_ERE" || true)
echo "===== done rc=$RC $(date) =====" >> "$LOG"

if [ -n "$LEAKED" ]; then
  echo "PRIVACY: content-bearing files quarantined from monitoring/ to $SCRATCH:$LEAKED" >&2
fi

if [ "$RC" -ne 0 ]; then
  printf '%s\n' "$BAD" | head -5 >&2
  echo "$JOB run FAILED (rc=$RC) — see $LOG" >&2
  exit "$RC"
fi
if [ -n "$BAD" ]; then
  printf '%s\n' "$BAD" | head -5 >&2
  echo "$JOB run FAILED (rc=0 but the log tail carries failure markers) — see $LOG" >&2
  exit 1
fi
if [ -n "$LEAKED" ]; then
  echo "$JOB run OK (with privacy quarantine — a file-writing behaviour needs fixing, see stderr)"
  exit 0
fi
echo "$JOB run OK"
