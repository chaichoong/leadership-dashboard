#!/bin/bash
# Install the launchd jobs for Kevin's 26 Aug 2026 daily-ops restructure.
#
# WHAT THIS INSTALLS
#   Three SCRIPT jobs   — mechanical work that used to be Claude phases
#   Four SLOT jobs      — role agents that used to be daily-ops phases
#
# Every one of them is a WRAPPED job: launchd calls job-queue.py run, which
# takes the lock and heartbeats. A job suspended by the Mac sleeping frees the
# lock in about five minutes. That is what makes these slots rather than the
# second Claude routine the one-routine rule forbids.
#
# RUN THIS ONLY AFTER THE PR HAS MERGED TO MAIN. The live skill files call
# scripts (drift-scan.py) that exist on the branch first; installing the jobs
# before the scripts land gives you seven jobs that fail every morning.
#
# Usage:
#   install-slot-jobs.sh --dry-run     print what would be written, touch nothing
#   install-slot-jobs.sh --install     write the plists and load them
#   install-slot-jobs.sh --uninstall   unload and remove them again
set -uo pipefail

REPO="/Users/kevinbrittain/Projects/leadership-dashboard"
LA="$HOME/Library/LaunchAgents"
LOGS="$HOME/knowledge-os/logs"
RUNJOB="$HOME/tools/run-job.sh"
QUEUE="$REPO/scripts/job-queue.py"
SLOT="$REPO/scripts/agent-slot-run.sh"
TASKS="$HOME/.claude/scheduled-tasks"

MODE="${1:---dry-run}"

# name|hour:minute[,hour:minute...]|command...
# The hours match scripts/job-schedule.json. Any day-of-week decision lives in
# the SKILL file, never here: `1-5` means Mon-Fri to a human and Sun-Thu to
# Cloudflare, and that ambiguity cost this platform every Friday for a week.
JOBS=(
  "drift-scan|6:20|/usr/bin/python3 $REPO/scripts/drift-scan.py"
  "data-invariants|6:40|/usr/bin/python3 $REPO/scripts/check-data-invariants.py"
  "drive-auth|6:50|/usr/bin/python3 $REPO/scripts/drive-auth-check.py"
  "ceo-agent|6:45|/bin/bash $SLOT ceo-agent $TASKS/ceo-agent/SKILL.md"
  # uc-check RETIRED 1 Sep 2026 by Kevin, Slack cleanup: whole UC process stopped.
  "prospecting|9:15|/bin/bash $SLOT prospecting $TASKS/prospecting/SKILL.md"
  "prod-sweep-weekly|11:00|/bin/bash $SLOT prod-sweep-weekly $TASKS/prod-sweep-weekly/SKILL.md"
)

plist_for() {
  local name="$1" times="$2"; shift 2
  local cmd=("$@")
  local intervals=""
  local IFS=,
  for t in $times; do
    intervals="$intervals		<dict><key>Hour</key><integer>${t%%:*}</integer><key>Minute</key><integer>$((10#${t##*:}))</integer></dict>
"
  done
  unset IFS
  local args=""
  for a in "${cmd[@]}"; do
    args="$args		<string>$a</string>
"
  done
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.kevinbrittain.$name</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/python3</string>
		<string>$QUEUE</string>
		<string>run</string>
		<string>$name</string>
		<string>--</string>
		<string>$RUNJOB</string>
		<string>$name</string>
$args	</array>
	<key>RunAtLoad</key>
	<false/>
	<key>StandardErrorPath</key>
	<string>$LOGS/$name/launchd.err.log</string>
	<key>StandardOutPath</key>
	<string>$LOGS/$name/launchd.out.log</string>
	<key>StartCalendarInterval</key>
	<array>
$intervals	</array>
</dict>
</plist>
PLIST
}

for spec in "${JOBS[@]}"; do
  IFS='|' read -r name times cmd <<< "$spec"
  label="com.kevinbrittain.$name"
  target="$LA/$label.plist"
  case "$MODE" in
    --dry-run)
      echo "=== $target ($times) ==="
      plist_for "$name" "$times" $cmd
      echo
      ;;
    --install)
      mkdir -p "$LOGS/$name"
      plist_for "$name" "$times" $cmd > "$target"
      launchctl unload "$target" 2>/dev/null
      if launchctl load "$target"; then
        echo "loaded  $label  ($times)"
      else
        echo "FAILED to load $label" >&2
        exit 1
      fi
      ;;
    --uninstall)
      launchctl unload "$target" 2>/dev/null
      rm -f "$target"
      echo "removed $label"
      ;;
    *)
      echo "usage: install-slot-jobs.sh --dry-run|--install|--uninstall" >&2
      exit 2
      ;;
  esac
done

if [ "$MODE" = "--install" ]; then
  echo
  echo "Now verify the guard still agrees with the register:"
  echo "  python3 $REPO/scripts/check-routines.py"
fi
