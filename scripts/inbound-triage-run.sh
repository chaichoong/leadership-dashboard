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
# WHICH SLOT IS THIS? Decided here, by the clock, once (finding
# 20260829-daily-ops-396). The agent used to be told "one of the 09:00 /
# 13:00 / 17:00 slots" and left to work it out; nothing in its context carries
# the trigger time, so it guessed "13:00 slot" every run and all three rounds
# filed under the same heading.
SLOT_LABEL="$(/usr/bin/python3 "$REPO/scripts/slot-label.py" 2>/dev/null || echo unknown)"
echo "===== inbound-triage run [$SLOT_LABEL slot] $(date) =====" >> "$LOG"

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

# GMAIL HEALTH PROBE (6 Sep 2026, finding 20260906-daily-ops-477). The three
# slots share ONE daily Gmail quota. On 3 and 5 Sep the quota ran out, the
# agent's scan died on a 403, zero email was triaged for three days, and every
# slot still left a normal queue event — so check-routines graded the day
# "3 of 3" and nothing anywhere said the email lane was dead.
#
# Two things change here. The probe is ONE `labels` call, the smallest the
# worker exposes, made BEFORE the agent starts: probing with a scan would spend
# the quota it is checking for. And the verdict is written to
# slot-results.jsonl as a machine-readable line per lane, which is what
# check-routines.py grades on now — the mere existence of a run marker no
# longer counts as a slot that worked.
#
# When the lane is broken the slot is NOT burned: the agent is told to skip
# skill 1 entirely (so it spends no quota and moves no watermark) and to run
# the iMessage and dispatch lanes, which are independent and still valuable.
GMAIL_HEALTH="$(/usr/bin/python3 "$REPO/scripts/inbound-triage.py" health 2>/dev/null)"
GMAIL_OK=$(printf '%s' "$GMAIL_HEALTH" | /usr/bin/python3 -c 'import json,sys
try: print("1" if json.loads(sys.stdin.read() or "{}").get("ok") else "0")
except Exception: print("0")')
GMAIL_KIND=$(printf '%s' "$GMAIL_HEALTH" | /usr/bin/python3 -c 'import json,sys
try: print(json.loads(sys.stdin.read() or "{}").get("kind") or "error")
except Exception: print("error")')

if [ "$GMAIL_OK" = "1" ]; then
  EMAIL_LANE_NOTE="Gmail answered the pre-flight probe — run skill 1 in full."
else
  EMAIL_LANE_NOTE="GMAIL IS BROKEN THIS SLOT ($GMAIL_KIND): SKIP skill 1 entirely. Do not scan, do not mark, do not publish an email digest, and do NOT move the watermark. Say 'email lane BROKEN ($GMAIL_KIND)' in your report and carry on with skills 2 and 3, which do not touch Gmail."
  echo "EMAIL LANE BROKEN ($GMAIL_KIND) — skill 1 skipped this slot: $GMAIL_HEALTH" >> "$LOG"
fi

# Record it BEFORE the agent runs, so a slot that dies mid-run still leaves the
# lane verdict behind. Exit 3 means this lane has now been broken for two slots
# running, which is not bad luck — the day is going the way 3-5 Sep did.
#
# BUT A PRE-FLIGHT VERDICT IS A FORECAST (finding 20260907-daily-ops-487). The
# probe is one `labels` call, small enough to pass on a day whose remaining
# quota cannot carry a full scan — which is exactly what happened on 6 Sep, when
# both slots wrote ok:true, the scan died on a 403 mid-run, and check-routines
# graded the lane clean off this very file. `slot-verify` below runs AFTER the
# agent and supersedes this line when no scan actually completed.
__SLOT_START_MS=$(/usr/bin/python3 -c 'import time; print(int(time.time()*1000))')
/usr/bin/python3 "$REPO/scripts/inbound-triage.py" slot-record \
  --slot "$SLOT_LABEL" --lane email \
  --status "$([ "$GMAIL_OK" = "1" ] && echo ok || echo broken)" \
  --reason "$GMAIL_KIND" >> "$LOG" 2>&1
if [ $? -eq 3 ]; then
  echo "ESCALATE: inbound-triage email lane BROKEN for 2+ consecutive slots ($GMAIL_KIND). No mail has been triaged since the last ok slot — see slot-results.jsonl." | tee -a "$LOG" >&2
fi

# THE HISTORY BOOK + OPEN MATTERS (1 Sep 2026, agent-gate EXTEND verdict —
# the approved chain map lives on the register row recYy33zkoa099uM2). Two
# pre-reads on the same contract as gmail-sent.json: produced HERE because a
# check the agent must remember to run is a check that gets skipped, and a
# failure lands IN the file as an error object the skill treats as
# UNCHECKED, never as absence. The history book is where each sender's mail
# has historically been filed BY HUMANS — the agent's own moves are excluded
# so it cannot learn its own guesses — rebuilt weekly (history-stale gates
# it) from end-state Gmail label membership into the Triage History Book
# table. The matters snapshot is every open agent task plus 14 days of
# completed ones, so a message on a known matter JOINS its task at the gate
# instead of becoming a sibling for Kevin to reject.
if /usr/bin/python3 "$REPO/scripts/inbound-triage.py" history-stale >> "$LOG" 2>&1; then
  /usr/bin/python3 "$REPO/scripts/inbound-triage.py" history-build >> "$LOG" 2>&1 || true
fi
/usr/bin/python3 "$REPO/scripts/inbound-triage.py" history-dump \
  > "$SCRATCH/history-book.json" 2>&1 || true
/usr/bin/python3 "$REPO/scripts/inbound-triage.py" matters \
  > "$SCRATCH/open-matters.json" 2>&1 || true

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
"$CLAUDE" -p "You are the Inbound Comms Triage agent's scheduled run. THIS RUN IS THE $SLOT_LABEL SLOT — that is the wall clock at run start, read for you. Head your report with exactly '$SLOT_LABEL slot' and never substitute a slot you worked out yourself.
0. FIRST read /Users/kevinbrittain/.claude/agents/inbound-comms-triage.md — that file is your standing instructions, including the '## Lessons from Kevin' section, which is where every rule he has asked you to remember lives. Apply every lesson in it to the decisions you make below. If a lesson conflicts with a skill step, say so in your report rather than guessing which wins.
EMAIL LANE STATUS FOR THIS SLOT: $EMAIL_LANE_NOTE
Then do these three skills in order, each in full:
1. /Users/kevinbrittain/.claude/scheduled-tasks/inbound-email-triage/SKILL.md — BEFORE creating a task for any email thread, check \$SCRATCH/gmail-sent.json: a thread counts as ANSWERED only when threadSends[thread id] exists AND its \"id\" is a DIFFERENT message from the one you are judging AND its \"ts\" is strictly greater than that message internalDate. A message never answers itself: scanned post is emailed from Kevin to Kevin, and reading that one message as its own answer produced ZERO post tasks for 17 days (finding 20260904-daily-ops-454). Self-addressed sends are already stripped from the file and counted in selfAddressedExcluded. If a thread is answered, file it, do not create a task. If that file carries an \"error\" key or \"truncated\": true, treat every thread as UNCHECKED and say so in your report; never read a failed check as \"nothing was answered\". Report how many you suppressed this way. Two more pre-reads on the same contract: \$SCRATCH/history-book.json is where each sender's mail has HISTORICALLY been filed by humans (the skill's Step 2 history-book rule — the skill's rules WIN over the book, and a disagreement goes in your --reason), and \$SCRATCH/open-matters.json is every open agent task plus 14 days of completed ones (the skill's Step 3b matter check — one matter, one task). An \"error\" key in either file means that check is UNCHECKED this run: say so and fall back to the rules and the per-thread dedupe alone. Report how many decisions the book steered and how many threads JOINED an existing matter.
2. /Users/kevinbrittain/.claude/scheduled-tasks/inbound-messages-sweep/SKILL.md — IMPORTANT: in this context chat.db reads are DENIED to you; the fresh pre-read dumps at $SCRATCH/imessage-scan.json and $SCRATCH/imessage-sent.json are your scan and sent-check data, per the skill's pre-dump rules.
3. /Users/kevinbrittain/.claude/scheduled-tasks/agent-dispatch/SKILL.md (Kevin's ruling, 24 Aug 2026: dispatch runs in every slot so the work triaged above reaches the approval queue in the same slot)
Rules for the whole run: this is real mail — when unsure between outcomes choose the agent-lane task; when unsure about archiving, do not archive; never send, reply, or delete anything yourself (dispatch prepares and submits through its own gated script only). Working and temp files go ONLY under $SCRATCH — NEVER under the repo, and never in monitoring/, because monitoring/ is committed to a public repository and scan output carries full email bodies. Counts-only reports in monitoring/ are fine. A broken read (Gmail or iMessage) is reported loudly, never treated as a quiet day. Do not take the queue lock (this run already holds it). Do not edit, commit, or push code; file anything needing a code change via scripts/findings.py. Complete each skill's closing steps in full (watermark, score, publish; dispatch's verify step). End with at most twenty lines of counts only — never message content, sender names, or record IDs." \
  --permission-mode acceptEdits \
  --allowedTools "${AGENT_ALLOWED_TOOLS[@]}" >> "$LOG" 2>&1
RC=$?

# THE OUTCOME, NOT THE FORECAST (finding 20260907-daily-ops-487). If the email
# lane was recorded ok before the agent started but no scan reached the end of
# cmd_scan since then, supersede the verdict with a broken one. Runs whatever
# the agent's exit code was — a slot that died mid-run is precisely the case
# the pre-flight line gets wrong. Exit 3 is the two-slots-broken escalation.
/usr/bin/python3 "$REPO/scripts/inbound-triage.py" slot-verify \
  --slot "$SLOT_LABEL" --lane email --since-ms "$__SLOT_START_MS" >> "$LOG" 2>&1
if [ $? -eq 3 ]; then
  echo "ESCALATE: inbound-triage email lane BROKEN for 2+ consecutive slots. No mail has been triaged since the last ok slot — see slot-results.jsonl." | tee -a "$LOG" >&2
fi

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
