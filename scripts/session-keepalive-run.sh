#!/bin/bash
# Daily session keep-alive (06:40, launchd com.kevinbrittain.session-keepalive,
# wrapped by job-queue.py run). Visits every login site the robot can hold a
# session on so the cookie stays fresh, and raises ONE parked task per site
# that has signed out, for the 08:00 message. See scripts/session-keepalive.py.
set -uo pipefail
. "$(dirname "$0")/agent-tools.sh"
REPO="/Users/kevinbrittain/Projects/leadership-dashboard"
cd "$REPO" || { echo "ERROR: repo not found" >&2; exit 1; }
exec /usr/bin/python3 "$REPO/scripts/session-keepalive.py" run
