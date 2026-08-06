#!/bin/bash
# Reap the processes that outlive the session that started them.
#
# Why this exists (6 Aug 2026): Claude Code preview servers are parented to the
# Claude desktop app, not to the session that asked for them. When the session
# ends the server keeps running, holding a port, forever. Playwright browser
# workers survive the same way if a run is interrupted. Neither is large on its
# own; both accumulate across a multi-day uptime.
#
# SAFETY RULES, in order of importance. This script must never cost work:
#   1. It NEVER touches a Claude Code session, a launchd job, or a GUI app.
#   2. It NEVER kills a test browser while a test run exists.
#   3. It NEVER kills a preview server that something is connected to.
#   4. Anything younger than the grace period is left alone, always.
# A leftover surviving one extra cycle is free. Killing live work is not.
#
# Usage:
#   ./scripts/mac-guard.sh            # reap
#   ./scripts/mac-guard.sh --dry-run  # report only, change nothing

set -uo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# Grace periods in seconds. Generous on purpose.
BROWSER_GRACE=600    # 10 min: a test suite run takes ~2 min
# 4 hours, not 30 minutes. A live session's preview server sits idle with no
# connection whenever the browser tab is closed but the session is still going,
# and sessions here routinely run 1-2 hours. At 30 min the guard picked a
# genuinely live server as a kill target in testing. Four hours plus "nothing
# connected" is the point where abandonment stops being a guess.
SERVER_GRACE=14400

KILLED=0
SKIPPED=0

say () { echo "$@"; }

# Age of a process in seconds.
#
# macOS ps has NO `etimes` field (that is GNU/Linux). Asking for it makes ps
# print its keyword list instead of a number, which sails through `-lt` as a
# non-integer and lands on the kill branch. Caught in dry run on 6 Aug 2026,
# one step from killing a live session's preview server. Parse `etime` instead,
# which comes as [[D-]HH:]MM:SS, and return empty on anything unrecognised so
# every caller treats "unknown age" as "leave it alone".
age_seconds () {
  local raw
  raw=$(ps -o etime= -p "$1" 2>/dev/null | tr -d ' ')
  [ -z "$raw" ] && return 1
  echo "$raw" | awk -F'[-:]' '
    { if (NF==4) print $1*86400 + $2*3600 + $3*60 + $4;
      else if (NF==3) print $1*3600 + $2*60 + $3;
      else if (NF==2) print $1*60 + $2;
      else exit 1 }' | grep -E '^[0-9]+$'
}
act () {
  local pid="$1" what="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "  WOULD KILL  $what (pid $pid)"
  else
    if kill "$pid" 2>/dev/null; then
      say "  KILLED      $what (pid $pid)"
      KILLED=$((KILLED + 1))
    else
      say "  GONE        $what (pid $pid) exited on its own"
    fi
  fi
}

say "mac-guard $(date '+%Y-%m-%d %H:%M:%S')${DRY_RUN:+ }$([ "$DRY_RUN" -eq 1 ] && echo '(dry run)')"

# ---------------------------------------------------------------------------
# 1. Orphaned Playwright browser workers
# ---------------------------------------------------------------------------
# Rule 2: if any test run exists at all, every browser is presumed live. This is
# deliberately blunt. A concurrent session's run must not be sabotaged.
if pgrep -f "playwright test" >/dev/null 2>&1; then
  N=$(pgrep -f chrome-headless-shell 2>/dev/null | wc -l | tr -d ' ')
  say "  SKIP        $N test browser(s): a test run is in progress"
  SKIPPED=$((SKIPPED + N))
else
  while read -r pid; do
    [ -z "$pid" ] && continue
    AGE=$(age_seconds "$pid") || AGE=""
    if [ -z "$AGE" ]; then
      say "  SKIP        test browser pid $pid: age unknown, leaving alone"
      SKIPPED=$((SKIPPED + 1)); continue
    fi
    if [ "$AGE" -lt "$BROWSER_GRACE" ]; then
      say "  SKIP        test browser ${AGE}s old, under the ${BROWSER_GRACE}s grace period"
      SKIPPED=$((SKIPPED + 1))
    else
      act "$pid" "orphaned test browser, ${AGE}s old, no test run"
    fi
  done < <(pgrep -f chrome-headless-shell 2>/dev/null)
fi

# ---------------------------------------------------------------------------
# 2. Abandoned preview servers
# ---------------------------------------------------------------------------
# A live preview has a browser attached, so an ESTABLISHED connection on the
# port is the liveness test. No connection plus old enough means abandoned.
while read -r pid port; do
  [ -z "$pid" ] && continue

  # Rule 1: only reap servers owned by the Claude desktop app. A dev server the
  # user started by hand has a different parent and is none of our business.
  # NB: not PPID — bash reserves that name and assigning to it is a fatal error.
  OWNER_PID=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  PARENT=$(ps -o args= -p "${OWNER_PID:-0}" 2>/dev/null || true)
  case "$PARENT" in
    *Claude.app*) ;;
    *) say "  SKIP        port $port: not started by Claude, leaving alone"
       SKIPPED=$((SKIPPED + 1)); continue ;;
  esac

  AGE=$(age_seconds "$pid") || AGE=""
  if [ -z "$AGE" ]; then
    say "  SKIP        preview server port $port: age unknown, leaving alone"
    SKIPPED=$((SKIPPED + 1)); continue
  fi
  if [ "$AGE" -lt "$SERVER_GRACE" ]; then
    say "  SKIP        preview server port $port, ${AGE}s old, under grace period"
    SKIPPED=$((SKIPPED + 1)); continue
  fi

  CONNS=$(lsof -nP -iTCP:"$port" -sTCP:ESTABLISHED 2>/dev/null | grep -c . || true)
  if [ "${CONNS:-0}" -gt 0 ]; then
    say "  SKIP        preview server port $port: $CONNS live connection(s)"
    SKIPPED=$((SKIPPED + 1)); continue
  fi

  act "$pid" "abandoned preview server on port $port, ${AGE}s old"
  [ -n "${OWNER_PID:-}" ] && [ "$DRY_RUN" -eq 0 ] && kill "$OWNER_PID" 2>/dev/null
done < <(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null \
         | awk '/[Pp]ython/ {split($9,a,":"); print $2, a[length(a)]}' | sort -u)

# ---------------------------------------------------------------------------
# 3. Advisory only. Sessions are the user's work; the guard never closes them.
# ---------------------------------------------------------------------------
SESSIONS=$(( $(pgrep -f "claude-code/.*claude.app" 2>/dev/null | wc -l | tr -d ' ') / 2 ))
if [ "$SESSIONS" -gt 3 ]; then
  say "  ADVISORY    $SESSIONS Claude Code sessions open. Not touching them, but"
  say "              this is the main cause of memory pressure on a 16 GB Mac."
fi

say "mac-guard done: $KILLED reaped, $SKIPPED left alone"
exit 0
