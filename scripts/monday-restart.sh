#!/bin/bash
# Planned weekly restart of the Mac mini: Monday from 07:25 (Kevin, 22 Nov 2026).
#
# Why: the Mac froze on Sun 22 Nov 2026 after 49 days switched on. fseventsd, a
# macOS service, had grown to 14.4 GB of 24 GB, and only a restart frees that.
# A weekly restart caps how far any slow leak can grow. The hourly memory alarm
# in mac-guard.sh covers the days in between.
#
# Why Monday 07:25: FileVault is on, so after a restart the Mac waits for
# Kevin's password and NOTHING runs until he types it: no jobs, no agent doors,
# no Home Assistant. He is at the Mac by 08:00-08:30 on Mondays (his ruling,
# 22 Nov 2026). FileVault stays on.
#
# One script, two jobs, both started by launchd:
#   - Monday 07:25: check the rules below, wait for daily-ops to finish (it ran
#     07:04 to between 07:53 and 08:22 on the last four Mondays), then restart.
#   - At every login (RunAtLoad): if a restart this script asked for has just
#     happened, re-run the jobs whose time fell while the Mac waited for the
#     password. launchd never replays a StartCalendarInterval it missed, so
#     without this Monday's 07:30 rent check would be lost every week.
#
# SAFETY RULES. This script must never cost work:
#   1. Only Monday 07:20-08:45, and only after 2 days switched on.
#   2. Never while someone is using the Mac (keyboard or mouse in 10 minutes).
#   3. Never while a launchd file is broken. A restart is when launchd re-reads
#      them, and a broken one means that job silently never runs again. That is
#      how mac-guard and retry-deferred stopped on 22 Nov 2026.
#   4. Waits for daily-ops and any running job, render, test, merge or agent run
#      to finish (until 08:45), then skips the week rather than kill one.
#   5. Shuts Home Assistant down cleanly first, and turns it back on if the
#      restart does not happen.
#
# Usage:
#   ./scripts/monday-restart.sh            # what launchd runs
#   ./scripts/monday-restart.sh --dry-run  # say what it would do, change nothing

set -uo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

HERE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LOGDIR="$HOME/knowledge-os/logs"
STATE="${MONDAY_RESTART_STATE:-$LOGDIR/monday-restart.state}"
# run-job.sh only keeps a run's output when the run ends, and a restart ends it
# by killing it. This file is written line by line, so the evidence survives.
HISTORY="$LOGDIR/monday-restart.history.log"
AGENTS_DIR="$HOME/Library/LaunchAgents"
VBOX=/Applications/VirtualBox.app/Contents/MacOS/VBoxManage
VM_NAME="Home Assistant"
MIN_UPTIME=172800    # 2 days
MIN_IDLE=600         # 10 minutes with no keyboard or mouse
BUSY_DEADLINE=845    # stop waiting for busy work at 08:45
MAX_MARKER_AGE=1800  # a boot more than 30 minutes after the marker is not our restart
OVERDUE_UPTIME=1209600   # 14 days on: a skipped restart stops being quiet

say () {
  echo "$@"
  [ "$DRY_RUN" -eq 0 ] && echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$HISTORY" 2>/dev/null
  return 0
}

# decide DOW HHMM UPTIME_S IDLE_S BROKEN_PLIST BUSY
# Prints "RESTART", "WAIT <why>" or "SKIP <exit code> <why>". Unknown readings
# always skip: a restart nobody can justify is not worth the risk.
decide () {
  local dow="$1" hm="$2" up="$3" idle="$4" bad="$5" busy="$6"
  if ! [[ "$hm" =~ ^[0-9]{3,4}$ ]] || [ "$dow" != "1" ] \
     || [ "$((10#$hm))" -lt 720 ] || [ "$((10#$hm))" -gt "$BUSY_DEADLINE" ]; then
    echo "SKIP 0 outside the Monday 07:20-08:45 window"; return
  fi
  if ! [[ "$up" =~ ^[0-9]+$ ]]; then
    echo "SKIP 1 could not read how long the Mac has been on"; return
  fi
  if [ "$up" -lt "$MIN_UPTIME" ]; then
    echo "SKIP 0 the Mac was restarted $(( up / 3600 )) hours ago"; return
  fi
  if ! [[ "$idle" =~ ^[0-9]+$ ]]; then
    echo "SKIP 1 could not read when the Mac was last used"; return
  fi
  if [ "$idle" -lt "$MIN_IDLE" ]; then
    echo "SKIP 0 someone used the Mac $(( idle / 60 )) minutes ago"; return
  fi
  if [ -n "$bad" ]; then
    echo "SKIP 1 launchd file $bad is broken, and a restart would switch that job off for good"; return
  fi
  if [ -n "$busy" ]; then
    if [ "$((10#$hm))" -ge "$BUSY_DEADLINE" ]; then
      echo "SKIP 0 $busy is still running at 08:45, so this week is skipped rather than kill it"; return
    fi
    echo "WAIT $busy is running"; return
  fi
  echo "RESTART"
}

# kern.boottime reads "{ sec = 1763814240, usec = 512000 } Sun Nov 22 12:24:00 2026".
# Anchor on "{ sec": a greedy ".*sec = " lands on usec and reads the boot as 1970.
boot_epoch () { sysctl -n kern.boottime 2>/dev/null | sed -nE 's/^\{ sec = ([0-9]+),.*/\1/p'; }
uptime_s () {
  local b; b=$(boot_epoch)
  [[ "$b" =~ ^[0-9]+$ ]] && echo $(( $(date +%s) - b ))
}
idle_s () { ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'; }
broken_plist () {
  local f
  for f in "$AGENTS_DIR"/com.kevinbrittain.*.plist; do
    [ -e "$f" ] || continue
    plutil -extract Label raw -o - "$f" >/dev/null 2>&1 || { basename "$f"; return; }
  done
}
busy_work () {
  local pat live rc
  # daily-ops runs inside the Claude app, so no process pattern sees it. Its end
  # mark does: rantoday exits 3 once today's run has finished. Anything else,
  # an error included, counts as still running.
  python3 "$HERE_DIR/job-queue.py" rantoday daily-ops >/dev/null 2>&1; rc=$?
  if [ "$rc" -ne 3 ]; then echo "daily-ops"; return; fi
  # Every scheduled job runs under run-job.sh, except this one's own wrapper.
  live=$(pgrep -fl "tools/run-job.sh " 2>/dev/null | grep -v "run-job.sh monday-restart" \
         | sed -nE 's/.*run-job\.sh ([^ ]+).*/\1/p' | head -1)
  if [ -n "$live" ]; then echo "$live"; return; fi
  for pat in "content-engine" "playwright test" "merge-pr.py" "\.local/bin/claude -p "; do
    if pgrep -f "$pat" >/dev/null 2>&1; then
      case "$pat" in *claude*) echo "an agent run" ;; *) echo "$pat" ;; esac
      return
    fi
  done
  # A session in the Claude app matches no process pattern, and one left working
  # unattended passes the idle rule. Its transcript shows it is alive.
  if [ -n "$(find "$HOME/.claude/projects" -name '*.jsonl' -mmin -10 -print -quit 2>/dev/null)" ]; then
    echo "a Claude session"
  fi
}
vm_state () { "$VBOX" showvminfo "$VM_NAME" --machinereadable 2>/dev/null | sed -n 's/^VMState="\(.*\)"/\1/p'; }

# Re-run every job whose time fell between the restart and now. The job's own
# queue then applies its maxLateMinutes, so a job that is no longer worth doing
# is skipped there, by the same rule as any other late run.
catch_up () {
  local since="$1" login
  # Judge "held up" at the moment of login, before the wait. A job that fires
  # during the wait ran by itself, and counting it here would run it twice.
  login=$(date +%s)
  [ "$DRY_RUN" -eq 0 ] && sleep 60   # let launchd finish loading every job first
  python3 - "$HERE_DIR" "$since" "$login" "$DRY_RUN" <<'PY'
import importlib.util, os, plistlib, subprocess, sys
from datetime import datetime

here, since, login, dry = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4] == "1"

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(here, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

jq = load("job_queue", "job-queue.py")
rd = load("retry_deferred", "retry-deferred.py")
schedule, labels = jq.load_schedule(), rd.launchd_labels()
start, now, uid = datetime.fromtimestamp(since), datetime.fromtimestamp(login), os.getuid()

# A job with RunAtLoad already started by itself at login. Kicking it again runs it twice.
started_at_login = set()
agents = os.path.expanduser("~/Library/LaunchAgents")
for name in os.listdir(agents):
    try:
        with open(os.path.join(agents, name), "rb") as fh:
            pl = plistlib.load(fh)
        if pl.get("RunAtLoad"):
            started_at_login.add(pl.get("Label"))
    except Exception as e:
        print("  UNREADABLE  %s: %s" % (name, e))

ran = failed = 0
for job, cfg in sorted(schedule.items()):
    if job.startswith("_") or job == "monday-restart" or not isinstance(cfg, dict):
        continue
    if cfg.get("enabled") is False or not cfg.get("cron") or cfg.get("mode") == "cooperative":
        continue
    due = jq.last_scheduled(cfg["cron"], ref=now)
    if due is None or not (start <= due <= now):
        continue
    label = labels.get(job)
    if not label:
        print("  NO JOB      %s was due at %s but has no launchd job" % (job, due.strftime("%H:%M")))
        failed += 1
        continue
    if label in started_at_login:
        continue
    if dry:
        print("  WOULD RUN   %s (was due at %s)" % (job, due.strftime("%H:%M")))
        continue
    r = subprocess.run(["launchctl", "kickstart", "gui/%d/%s" % (uid, label)],
                       capture_output=True, text=True)
    if r.returncode == 0:
        print("  RAN         %s (was due at %s)" % (job, due.strftime("%H:%M")))
        ran += 1
    else:
        print("  FAILED      %s: %s" % (job, (r.stderr or r.stdout).strip()))
        failed += 1
print("catch-up done: %d re-run, %d could not be" % (ran, failed))
sys.exit(1 if failed else 0)
PY
}

# Put a restart only Kevin can do on his phone (mac-nudge.py). A failed nudge is
# logged and never stops the script, which may be midway through a restart.
nudge () {
  [ "$DRY_RUN" -eq 1 ] && return 0
  local out rc
  out=$(python3 "$HERE_DIR/mac-nudge.py" "$@" 2>&1); rc=$?
  if [ "$rc" -ne 0 ]; then
    say "  NUDGE FAILED ($rc) $out"
  elif [ -n "$out" ]; then
    say "  NUDGE       $out"
  fi
  return 0
}

# Say why this week is skipped, and stop. A restart skipped for two weeks running
# turns red, because a quiet skip is how a leak gets its time back.
skip_week () {
  local code="$1" why="$2" up
  up=$(uptime_s)
  if [ "$code" -eq 0 ] && [[ "$why" != outside* ]] && [ "${up:-0}" -ge "$OVERDUE_UPTIME" ]; then
    code=1
    why="$why. The Mac has been on for $(( up / 86400 )) days and is overdue a restart"
  fi
  [ "$code" -eq 1 ] && nudge raise restart "$why"
  say "SKIPPED: $why"
  [ "$DRY_RUN" -eq 1 ] && exit 0
  exit "$code"
}

vm_back_on () {
  [ "$1" -eq 1 ] && "$VBOX" startvm "$VM_NAME" --type headless >/dev/null 2>&1
  return 0
}

do_restart () {
  local vm_was_on=0 still idle waited=0
  if [ -x "$VBOX" ] && [ "$(vm_state)" = "running" ]; then
    vm_was_on=1
    say "  VM          asking Home Assistant to shut down"
    "$VBOX" controlvm "$VM_NAME" acpipowerbutton >/dev/null 2>&1
    for _ in $(seq 1 36); do
      [ "$(vm_state)" = "poweroff" ] && break
      sleep 5
    done
    if [ "$(vm_state)" != "poweroff" ]; then
      say "  VM          no clean shutdown in 3 minutes, saving its state instead"
      "$VBOX" controlvm "$VM_NAME" savestate >/dev/null 2>&1
    fi
    say "  VM          Home Assistant is $(vm_state)"
  fi
  # The VM can take 3 minutes, and a job may have started meanwhile.
  # Kevin may also have sat down, so read both again on every pass.
  while :; do
    idle=$(idle_s)
    if ! [[ "$idle" =~ ^[0-9]+$ ]] || [ "$idle" -lt "$MIN_IDLE" ]; then
      vm_back_on "$vm_was_on"
      skip_week 0 "someone started using the Mac. Home Assistant is back on"
    fi
    still=$(busy_work)
    [ -z "$still" ] && break
    if [ "$waited" -ge 180 ]; then
      vm_back_on "$vm_was_on"
      skip_week 0 "$still started during the shutdown and is still running. Home Assistant is back on"
    fi
    sleep 15
    waited=$(( waited + 15 ))
  done
  # The marker goes down last. Anything due after this moment is re-run at login,
  # and anything before it has already finished.
  date +%s > "$STATE"
  say "  RESTART     asking macOS to restart now"
  if ! /usr/bin/osascript -e 'tell application "System Events" to restart' >/dev/null 2>&1; then
    rm -f "$STATE"
    vm_back_on "$vm_was_on"
    say "RESTART FAILED: macOS refused the restart command. Home Assistant is back on."
    nudge raise restart "macOS refused this week's restart command. Restart the Mac when you sit down."
    exit 1
  fi
  # A restart stops this script within minutes, and the slowest seen took 8.8
  # (22 Nov 2026). Wait 15 before calling it blocked. Until then the marker stays,
  # so a slow shutdown still catches up, and the VM stays off, so a shutdown in
  # progress cannot kill it mid-write. The marker goes before Kevin is told to
  # restart, or his restart would re-run jobs that already ran.
  sleep 900
  rm -f "$STATE"
  vm_back_on "$vm_was_on"
  say "RESTART BLOCKED: the Mac did not restart, probably because an app asked to save something. Home Assistant is $(vm_state). Restart the Mac when you sit down."
  nudge raise restart "This week's restart did not happen, probably because an app asked to save something. Restart the Mac when you sit down."
  exit 1
}

say "monday-restart $(date '+%Y-%m-%d %H:%M:%S')$([ "$DRY_RUN" -eq 1 ] && echo ' (dry run)')"

# Login after a restart this script asked for: catch up, then stop.
if [ -f "$STATE" ]; then
  RTS=$(cat "$STATE" 2>/dev/null)
  BOOT=$(boot_epoch)
  if [[ "$RTS" =~ ^[0-9]+$ ]] && [[ "$BOOT" =~ ^[0-9]+$ ]] \
     && [ "$BOOT" -gt "$RTS" ] && [ $(( BOOT - RTS )) -lt "$MAX_MARKER_AGE" ]; then
    say "  RESTARTED   at $(date -r "$BOOT" '+%a %H:%M'), re-running the jobs it held up"
    OUT=$(catch_up "$RTS"); RC=$?
    while IFS= read -r line; do [ -n "$line" ] && say "$line"; done <<< "$OUT"
    [ "$DRY_RUN" -eq 0 ] && rm -f "$STATE"
    exit "$RC"
  fi
  [ "$DRY_RUN" -eq 0 ] && rm -f "$STATE"   # a restart that never happened, or an old marker
fi

# --dry-run may pretend to be another day and time, to show Monday's verdict.
DOW_NOW=$(date +%u); HM_NOW=$(date +%H%M)
if [ "$DRY_RUN" -eq 1 ]; then
  DOW_NOW=${MONDAY_RESTART_DOW:-$DOW_NOW}; HM_NOW=${MONDAY_RESTART_HM:-$HM_NOW}
fi

while :; do
  UP=$(uptime_s); IDLE=$(idle_s); BAD=$(broken_plist); BUSY=$(busy_work)
  say "  READINGS    on for $(( ${UP:-0} / 3600 ))h, last used ${IDLE:-?}s ago, broken launchd file: ${BAD:-none}, busy: ${BUSY:-nothing}"
  VERDICT=$(decide "$DOW_NOW" "$HM_NOW" "$UP" "$IDLE" "$BAD" "$BUSY")
  case "$VERDICT" in
    RESTART) break ;;
    WAIT*)
      say "  WAIT        ${VERDICT#WAIT }, checking again in a minute"
      [ "$DRY_RUN" -eq 1 ] && exit 0
      sleep 60
      DOW_NOW=$(date +%u); HM_NOW=$(date +%H%M)
      # A pass takes just over a minute, and a stalled Mac can lose hours. Past the
      # deadline, or on another day, this week is over: never restart mid-morning.
      if [ "$DOW_NOW" != "1" ] || [ "$((10#$HM_NOW))" -gt "$BUSY_DEADLINE" ]; then
        skip_week 0 "$BUSY is still running at 08:45, so this week is skipped rather than kill it"
      fi ;;
    *)
      skip_week "$(echo "$VERDICT" | cut -d' ' -f2)" "$(echo "$VERDICT" | cut -d' ' -f3-)" ;;
  esac
done

if [ "$DRY_RUN" -eq 1 ]; then
  say "WOULD RESTART now: shut Home Assistant down cleanly, then restart macOS"
  exit 0
fi
do_restart
