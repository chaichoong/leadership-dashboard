#!/bin/bash
# Inbound Comms Triage agent — its own Go Signal (Kevin's ruling, 24 Aug 2026):
# 09:00, 13:00 and 17:00 local daily, launchd com.kevinbrittain.inbound-triage,
# wrapped by job-queue.py run. The job name "inbound-triage" is deliberately
# NOT the name of any skill folder, so check-routines.py sees a registered
# shell job rather than a second Claude routine. The one-routine rule's
# fixed-time exception was Kevin's explicit call, recorded in
# docs/daily-ops-routine.md — do not fold this back into daily-ops without
# his word.
#
# Each slot runs, in order: the Gmail inbox triage skill, the iMessage sweep
# skill, then the agent-dispatch skill (Kevin's ruling, 24 Aug 2026: dispatch
# runs in all three slots, so triaged work is prepared for approval in the
# SAME slot, not the next morning). Nothing here can send email directly —
# the triage Gmail credential is read/label-only, and dispatch output goes to
# the approval loop.
#
# PRIVACY: the first proof run dumped raw scan output (full email bodies)
# into monitoring/, which the nightly fixer commits to the PUBLIC repo. All
# working files now belong in $SCRATCH, the prompt says so, and the post-run
# sweep below quarantines any content-bearing file that still lands in
# monitoring/ and fails the run loudly.
set -u

# Tool policy is shared, never hand-rolled here — see scripts/agent-tools.sh
# for why the old two-tool cap made every agent look like it could only
# draft emails. Guarded by tests/agent-tools-parity.test.js.
. "$(dirname "$0")/agent-tools.sh"

CLAUDE="/Users/kevinbrittain/.local/bin/claude"
REPO="/Users/kevinbrittain/Projects/leadership-dashboard"
LOG_DIR="/Users/kevinbrittain/knowledge-os/logs/inbound-triage"
SCRATCH="$LOG_DIR/scratch"
LOG="$LOG_DIR/runs.log"
mkdir -p "$SCRATCH"

# Same token discipline as compound_brain.sh: without the exported OAuth token
# a headless `claude -p` dies with "OAuth access token has expired".
if [ -f "/Users/kevinbrittain/.config/od/claude_oauth_token" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat /Users/kevinbrittain/.config/od/claude_oauth_token)"
else
  echo "ERROR: claude OAuth token missing at ~/.config/od/claude_oauth_token" >&2
  exit 1
fi

# Everything below logs to $LOG; remember where this run starts so failures in
# the tail can be surfaced on stderr for the wrapper. An empty stdout reads as
# success to run-job.sh, which is how silent 401s once went unnoticed for a week.
__START_LINE=$( { wc -l < "$LOG"; } 2>/dev/null || echo 0)
__MARKER="$SCRATCH/.run-start.$$"
touch "$__MARKER"
echo "===== inbound-triage run $(date) =====" >> "$LOG"

# Finding 20260827-phase-2-382: this slot's 09:00 run on 26 Aug started and
# vanished — a start header with no done line, indistinguishable from a run
# still going, and no job-status row either (the whole process tree died, so
# the death was a SIGKILL or a sleep-kill launchd never reported). Trap the
# catchable terminations (TERM from launchd/session teardown, HUP, INT) and
# any abnormal exit so those at least always write a done line. A SIGKILL
# remains untrappable by anything.
__POSTRUN_DONE=0
__on_exit() {
  __rc=$?
  if [ "$__POSTRUN_DONE" -eq 0 ]; then
    echo "===== done rc=$__rc (ABNORMAL: wrapper terminated before postrun) $(date) =====" >> "$LOG"
    echo "inbound-triage run DIED before completing (rc=$__rc) — see $LOG" >&2
  fi
}
trap __on_exit EXIT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 130' INT
cd "$REPO" || { echo "ERROR: repo not found at $REPO" >&2; exit 1; }

# PRE-READ the Messages database HERE, before claude starts. macOS attributes
# the Full Disk Access permission to this job's ROOT process (python3, which
# Kevin granted on 24 Aug 2026 — proven by a launchd probe), NOT to the claude
# binary — a chat.db read made from inside claude is denied, and the claude
# binary's path changes on every update so granting it would break silently.
# The skill consumes these dumps instead of reading chat.db itself. Failures
# land IN the dump files as error JSON, so the skill still reports them loudly.
/usr/bin/python3 "$REPO/scripts/imessage-sweep.py" scan > "$SCRATCH/imessage-scan.json" 2>&1 || true
/usr/bin/python3 "$REPO/scripts/imessage-sweep.py" sentdump --since-hours 200 > "$SCRATCH/imessage-sent.json" 2>&1 || true

# THE GMAIL SENT-CHECK (27 Aug 2026). 41% of everything Kevin rejects is
# "already dealt with elsewhere" — he or Roy answered the thread and the agent
# drafted a reply anyway, because nothing in the pipeline had ever looked at
# what had been SENT. The iMessage lane has had this since it was built; this
# is the same check for Gmail, pre-read here rather than left for the agent to
# remember, because a check the agent must remember to run is a check that gets
# skipped. `|| true` deliberately: a failure lands IN the file as an error
# object with the control message, and the skill reports it loudly instead of
# treating "no sends found" as "nothing answered".
/usr/bin/python3 "$REPO/scripts/inbound-triage.py" sentcheck --days 7 > "$SCRATCH/gmail-sent.json" 2>&1 || true

# ROY'S LANE (28 Aug 2026). "Roy is dealing with this directly" was typed SEVEN
# times across Kevin's 58 rejections — 12%, on work that was never his. Roy has
# been Head of Property since 25 Aug and `handover` has carried his standing
# approval for maintenance ever since; nothing ever routed to him, because the
# instruction to do it lived in prose. It is a command now, and it runs BEFORE
# the dispatch skill so a property task is passed on rather than drafted for
# Kevin first. `|| true`: a refusal is reported in its JSON, and one refused
# handover must not stop the rest of the slot.
/usr/bin/python3 "$REPO/scripts/agent-dispatch.py" handover-property \
  > "$SCRATCH/roy-handovers.json" 2>&1 || true

# CLEAR THE ALERT BACKLOG (29 Aug 2026). The alert lane classifies in
# build_queue, which reads Today/Overdue — so it stopped NEW breakage tasks
# reaching the gate and did nothing about those already sitting at Approval.
# Kevin cleared his queue on 29 Aug and 15 of the 17 left were this class,
# every one predating the fix. Runs every slot rather than once, because a task
# can still arrive at Approval by a path the queue never classified, and a
# one-off cleanup would leave the same gap open behind it. Closes nothing.
/usr/bin/python3 "$REPO/scripts/agent-dispatch.py" clear-alerts \
  > "$SCRATCH/cleared-alerts.json" 2>&1 || true

# THE LESSONS FILE IS READ FIRST, AND THAT IS LOAD-BEARING (27 Aug 2026).
#
# This runner invokes `claude -p` against SKILL.md files. It does NOT load
# ~/.claude/agents/, which is where `agent-dispatch.py lessons` writes every
# standing rule Kevin asks an agent to remember. So without step 0 below, a
# lesson routed to this agent would land in a file nothing ever opens — which
# is precisely the failure the learning loop was built to fix (54 redos, zero
# stored lessons, because the rule was prose nobody enforced).
#
# Do not remove step 0 to shorten the prompt. tests/triage-learns.test.js
# fails if this path stops being named here.
"$CLAUDE" -p "You are the Inbound Comms Triage agent's scheduled run (one of the 09:00 / 13:00 / 17:00 slots).
0. FIRST read /Users/kevinbrittain/.claude/agents/inbound-comms-triage.md — that file is your standing instructions, including the '## Lessons from Kevin' section, which is where every rule he has asked you to remember lives. Apply every lesson in it to the decisions you make below. If a lesson conflicts with a skill step, say so in your report rather than guessing which wins.
Then do these three skills in order, each in full:
1. /Users/kevinbrittain/.claude/scheduled-tasks/inbound-email-triage/SKILL.md — BEFORE creating a task for any email thread, check \$SCRATCH/gmail-sent.json: if that thread id already has a send NEWER than the incoming message, it has been answered — file it, do not create a task. If that file carries an \"error\" key or \"truncated\": true, treat every thread as UNCHECKED and say so in your report; never read a failed check as \"nothing was answered\". Report how many you suppressed this way.
2. /Users/kevinbrittain/.claude/scheduled-tasks/inbound-messages-sweep/SKILL.md — IMPORTANT: in this context chat.db reads are DENIED to you; the fresh pre-read dumps at $SCRATCH/imessage-scan.json and $SCRATCH/imessage-sent.json are your scan and sent-check data, per the skill's pre-dump rules.
3. /Users/kevinbrittain/.claude/scheduled-tasks/agent-dispatch/SKILL.md (Kevin's ruling, 24 Aug 2026: dispatch runs in every slot so the work triaged above reaches the approval queue in the same slot)
Rules for the whole run: this is real mail — when unsure between outcomes choose the agent-lane task; when unsure about archiving, do not archive; never send, reply, or delete anything yourself (dispatch prepares and submits through its own gated script only). Working and temp files go ONLY under $SCRATCH — NEVER under the repo, and never in monitoring/, because monitoring/ is committed to a public repository and scan output carries full email bodies. Counts-only reports in monitoring/ are fine. A broken read (Gmail or iMessage) is reported loudly, never treated as a quiet day. Do not take the queue lock (this run already holds it). Do not edit, commit, or push code; file anything needing a code change via scripts/findings.py. Complete each skill's closing steps in full (watermark, score, publish; dispatch's verify step). End with at most twenty lines of counts only — never message content, sender names, or record IDs." \
  --permission-mode acceptEdits \
  --allowedTools "${AGENT_ALLOWED_TOOLS[@]}" >> "$LOG" 2>&1
RC=$?

# Shared epilogue (finding 20260827-phase-2-381): privacy sweep, done line,
# and exit-code semantics live in ONE place now — scripts/slot-postrun.sh.
# It preserves the real rc, treats a quarantine as informational (still loud
# on stderr), and never quarantines the drift scanner's schema snapshots,
# which false-positived here on 25 Aug 2026 (they carry "Inbound Message
# Content" as a field NAME in the table structure, not as message content).
"$REPO/scripts/slot-postrun.sh" "inbound-triage" "$RC" "$LOG" "$__START_LINE" "$__MARKER" "$SCRATCH" \
  '"body" *:|"Inbound Message Content" *:' \
  '"error"|HTTP Error 401|401 Unauthorized|Unauthorized|OAuth access token has expired|BROKEN|Full Disk Access'
__FINAL=$?
__POSTRUN_DONE=1
exit "$__FINAL"
