#!/usr/bin/env python3
"""Agent dispatch engine, deterministic half — stage 2 of the approval loop.

The scheduled task `agent-dispatch` (this Mac, like ceo-huddle) is the brain:
it dispatches the Claude Code agents in ~/.claude/agents/ to do the work.
This script is everything that must NOT vary run to run: which tasks are
eligible, the tier-1 labelling, the cap, and the exact Airtable writes.

THE LOOP (do not redesign — memory project_agent_accuracy_and_approval):
  submit   = the gate. Status Approval, Assignee Kevin, due today. The agent
             has PREPARED work into Agent Output and sent, filed and executed
             NOTHING. The Slack worker (approvals.js) posts it within a minute.
  approved = Kevin's yes hands the task back (Status Today, Team Member = the
             agent). The engine then CARRIES OUT the approved action and only
             then calls `complete`. Approving is not completing.
  changes  = redo against the words in Approval Feedback, then `submit` again.

Field IDs mirror js/config.js TASK_FIELDS and scripts/slack-automation/
approvals.js AF. tests/constant-drift.test.js fails if they ever disagree.

Subcommands:
  queue                       read-only. JSON of eligible work, capped.
  route    TASKID --to RECID  CEO reassigns Team Member.
  escalate TASKID --reason ASK --brief-file PATH --plain-task S --plain-approve S
                              put a decision card in Kevin's gate: the ask,
                              the brief he decides from, and the history,
                              links and files the code adds (2 Oct 2026; a
                              bare one-line ask is refused). NOT the tier-1
                              exit any more — tier 1 is prepared and labelled
                              like anything else. This is for the rarer case
                              where no agent can usefully prepare anything.
  decided  TASKID [--until YYYY-MM-DD]
                              close an ANSWERED decision card whose answer is
                              to wait; --until parks it until that date.
  submit   TASKID --agent RECID --type TYPE --output-file PATH [--tier1]
                              --tier1 stamps the banner on the Agent Output so
                              the label travels with the work, not in a log.
  annotate TASKID --note STR  append a dated agent note to the task's Notes.
  intent   TASKID             record BEFORE dispatching a carry-out, so a
                              crash mid-action can never re-execute it blind.
  complete TASKID [--keep-open [--note STR]]
                              after the approved action has been carried out.
                              --keep-open records the carry-out in Notes and
                              leaves Status alone, for an approval whose text
                              says the task must stay open (a standing
                              obligation, a chase, a thing due again). The run
                              report must set "keepOpen": true on that action so
                              verify checks the Notes record, not Completed.
  verify   --report PATH      the control. Exits 1, loudly, if there was work
                              and the run did none, if any action failed, or
                              if a claimed write did not actually land.

Usage:  python3 scripts/agent-dispatch.py <subcommand> [args]
Auth:   ~/.config/od/airtable_pat (never printed).
"""

import argparse
import base64
import json
import mimetypes
import os
import re
import subprocess
import io
import contextlib
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# The Correspondence contract and the tier-1 banner live in one place, shared
# with scripts/send-email.py. Two copies is how submit came to accept an output
# the send gate could not parse.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# Standing holds (24 Sep 2026): Kevin's rulings that stay true only until an
# event, written once for the whole team. The queue never hands one to an agent.
import standing_holds  # noqa: E402
# Whether a site keeps the robot signed in, and whether Kevin's own try got it in (8 Oct 2026).
import signin_hold  # noqa: E402
import certificate_watch  # noqa: E402
# The MERGE card (7 Oct 2026): a protected-path fix reaches Kevin as one card,
# merged by scripts/merge-approved.py. The queue never hands one to an agent.
import merge_card  # noqa: E402
from agent_email_format import (  # noqa: E402
    CARRY_OUT_MARKER,
    CARRY_OUT_RE,
    CARRY_OUT_TAIL_MAX,
    TIER1_BANNER,
    EmailFormatError,
    parse_output as parse_email_output,
    RULE_OWN_ADDRESSES,
    parse_text,
    strip_track_record,
    validate_submission as validate_email_submission,
    validate_submission_any as validate_any_submission,
    PERSONAL_SENDER,
    REDIRECT_BODY,
    RULE_STAMP,
    rule_send_problem,
    TRIAL_ACTING_SHAPE_RE,
    TRIAL_STAMP,
    TRIAL_AGENTS,
    TRIAL_ENDED,
    parse_plan,
    sender_key,
    strip_trial_marks,
    form_card,
    trial_problem,
)
# The CALENDAR contract lives in one place too, shared with
# scripts/calendar-write.py — same one-parser rule, same reason.
from agent_calendar_format import calendar_submit_problem  # noqa: E402

BASE_ID = "appnqjDpqDniH3IRl"
TASKS = "tblqB8b22hKBL4PF1"

# ─── THE MANDATORY CLOSING LINE ──────────────────────────────────────
#
# Kevin's approval box — the task drawer and #agent-approvals — leads with one
# line saying what the agent wants to do. apvSummary() derives it, preferring
# the agent's own closing "Carrying this out will involve:" line and falling
# back to TO/SUBJECT, then to the first meaningful line. Both fallbacks are
# guesses, and on an oddly-shaped report they are noise.
#
# On 11 Aug 2026 only 9 of 46 waiting tasks carried the line, so most summaries
# were guessed. Kevin instructed that it be mandated (finding
# 20260811-kevin-session-093). Mandated here, not just in the prompt, for the
# same reason TIER1_BANNER is applied here: a rule that lives only in prose is
# not a control.
#
# CARRY_OUT_RE is the regex the two renderers already parse with. One pattern,
# so what is REQUIRED and what is READ can never drift apart —
# tests/approval-summary.test.js holds the renderers to the same shape.
#
# Both constants are IMPORTED from agent_email_format (see the import block
# above), not defined here. On 18 Aug 2026 the line this file demands was being
# emailed to recipients because the send path had no idea it existed
# (20260818-agent-dispatch-204). Same rule as TIER1_BANNER: the string that
# gets added lives in the same module as the code that strips it.

# apvSummary shows no separate summary below this length: a short output is
# readable at a glance and repeating it twice helps nobody. Demanding a closing
# line there would refuse submits for no gain, so the mandate starts here.
SUMMARY_MIN_CHARS = 280

LONDON = ZoneInfo("Europe/London")
KEVIN_AIRTABLE_EMAIL = "kevin@runpreneur.org.uk"
# Kevin's own Team Members row. Not an agent, so a task pointed here drops out
# of the agent-linked population the queue works from — that is the point.
KEVIN_REC_ID = "recHEt2VPYothaqTd"

# The humans a task may be handed to, and nobody else.
#
# 20260819-agent-dispatch-238: `route` only accepts the 17 agent records and
# `escalate` only ever points at Kevin, so an APPROVED action of the form
# "reassign this to Mica" had no command that could carry it out. The task went
# back round the queue every run with the approval standing and nothing moving.
#
# An allow-list rather than a free --to, because this command reassigns work
# using an email address: an unchecked one silently points a real task at a
# person who does not exist, and Airtable accepts it. Read live from Team
# Members tblco0p2OnlLQVAX7 on 19 Aug 2026, not inferred.
HUMANS = {
    "kevin@runpreneur.org.uk": {"rec": KEVIN_REC_ID, "name": "Kevin Brittain"},
    # Kevin's ruling, 25 Aug 2026: no NEW routing to Mica — her entry stays ONLY
    # so an explicit Kevin-ordered handover still lands on a real row instead of
    # failing into a typo'd address. Ericamae left on 17 Sep 2026 (Team Members
    # recEvm9wgsEnoNVZh: Active=false, Status=Offboarded), so her entry is gone
    # and a handover to her address is refused like any non-team address.
    "micaa.work@gmail.com":    {"rec": "rec4b5MDoaxEC7WRE", "name": "Mica Albovias"},
    # Roy Lavin, Head of Property since 25 Aug 2026 (team member, not a
    # contractor). Maintenance handovers to him carry Kevin's STANDING
    # approval; other passes go through the gate first.
    "roy.lavin1978@gmail.com": {"rec": "reclbdjfVev3bqNHS", "name": "Roy Lavin"},
}
# Named once so the property lane and HUMANS can never disagree about which
# address is his.
ROY_EMAIL = "roy.lavin1978@gmail.com"

# Field IDs — single source is js/config.js; drift-tested, never guess.
AF = {
    "name":              "fldgFjGBw6bTKJFCD",
    "description":       "fldRGhBQViKZKtkQ6",
    "attachments":       "fldEbs9cscRr8elcw",
    "notes":             "fldR7apBzSp3oxFxz",
    "status":            "fldx4qCw17UfrKpaN",
    "assignee":          "fldELMncVJYPDRJNc",
    "dueDate":           "fld7XP8w8kbxfETV4",
    "completion":        "fldFOi1SwEKuJRmdN",
    "priority":          "fldS21RwmwOqt71LI",
    "urgencyScore":      "fldfA3gatzKbwCfUv",
    "teamMember":        "flduCtmQGpOA4eWaj",
    "maintenanceTicket": "fldSEUvVA98as1HW6",   # checkbox: a repair, whatever the name
    "sentForApprovalBy": "fld30Yw8SWYVp049g",
    "approver":          "fldLLAG5HQPEFEfE5",
    "approvalOutcome":   "fldrHBSr6qoUfaKuZ",
    "approvalFeedback":  "fldtI7SJI4gEohHD1",
    "approvedAt":        "fldr4Mvf2RzKvhZhi",
    "agentOutput":       "fldzswp8fx6PqpLQ5",
    "taskType":          "fldZ2moDV2041Sobc",
    # Inbound-communication fields, written by the triage/sweep task creators
    # (ids verified against the inbound-messages-sweep skill, 24 Aug 2026).
    "inboundTask":       "fldueazD67F7fUGee",
    "inboundSourceType": "fldiXSzcMol6Tdwij",
    "inboundSender":     "fldzf4xlbrQuktx0i",
    "inboundContent":    "fldiSNijdCy5GXuzL",
    # THE LEARNING LOOP (Kevin's ruling, 26 Aug 2026). Before these existed,
    # feedback was single-use: it reached the agent for that one task and was
    # then wiped by the next submit. Zero of 54 redos between 24 and 26 Aug
    # left a trace, and 47 of 60 pieces of feedback were rejections, which
    # never reach an agent at all because rejecting CLOSES the task and the
    # queue only reads Today/Overdue.
    #   rememberThis    — Kevin ticked "Reject and remember": his reason
    #                     becomes a standing lesson. HE classifies, so nothing
    #                     has to guess which feedback is a one-off.
    #   lessonWrittenAt — idempotency stamp set by `lessons` once the line is
    #                     in the agent's file. Never written by hand.
    #   feedbackHistory — append-only archive, because submit clears
    #                     approvalFeedback and the history was unrecoverable.
    "rememberThis":      "fldZurhdHutYIDKVx",
    #   verdictReason   — WHY he decided as he did (27 Aug 2026). All 58
    #   rejections he had ever made were classified that day and NOT ONE was
    #   about the draft: every one was about the task existing. So the reason
    #   decides two things a free-text box never could — which agent the
    #   lesson belongs to, and whether the verdict counts against draft
    #   quality at all. Only "The work is wrong" does.
    "verdictReason":     "fldF9Bs4N5mttQvtl",
    "lessonWrittenAt":   "fldFfzXOME9Rh8SyM",
    "feedbackHistory":   "fldOzsq68lhfprKJu",
    # Knock-back date (28 Aug 2026): the queue and the digest hide a task while
    # this is after today. Sign-in waits are parked on it until the morning.
    "deferredUntil":     "fldJ9IHS1yxwYzYSN",
    # THE PLAIN SUMMARY (Kevin, 22 Sep 2026): two lines a 13-year-old
    # understands, written by the agent at submit, shown first on his card.
    "plainSummary":      "fld3PrM8AJcnWHemG",
}

TASK_TYPES = ("Drafting", "Research", "Analysis", "Build",
              "Audit", "Admin", "Correspondence")
APPROVED = ("Approved as-is", "Approved with minor edits")
OPEN_STATUSES = ("Today", "Overdue")

# THE DISPATCH WINDOW (15 Sep 2026). Nothing deployed in Airtable ever flips
# an Upcoming task to Today when its due date arrives ("When Due Date is
# updated, adjust the Status" exists and is undeployed), so an Upcoming task
# whose date has passed sat outside every read that keys on Today/Overdue:
# 95 of the 129 Upcoming tasks on 15 Sep 2026 were due and invisible to
# dispatch, to loop-health and to the Task Manager's stuck list at once. The
# window is therefore Today, Overdue, OR Upcoming with a due date on or
# before today — decided on the DATE FIELD (IS_SAME/IS_BEFORE), never a bare
# string compare, which Airtable answers with zero rows and no error.
# scripts/task-hygiene-sweep.py flip-due moves those tasks to Today each
# slot; this clause is the belt for the run between a date arriving and the
# flip. in_dispatch_window() is the same rule for a record already read.
# Airtable's TODAY() in a filter is UTC, so for one hour of a BST night a
# task due tomorrow London-time is outside this clause and inside the
# Python mirror; the slots run 07:00-17:20, and flip-due is the belt.
# A blank date is never due, and a Some Day task is parked, not late.
DUE_UPCOMING_CLAUSE = ("AND({Status}='Upcoming',{Due Date},NOT({Some Day}),"
                       "OR(IS_SAME({Due Date},TODAY(),'day'),IS_BEFORE({Due Date},TODAY())))")
QUEUE_FORMULA = "OR({Status}='Today',{Status}='Overdue'," + DUE_UPCOMING_CLAUSE + ")"


def in_dispatch_window(status, due_date, today=None, some_day=False):
    """Is a task with this stored Status and Due Date one the queue works?
    Mirrors QUEUE_FORMULA for a record already in hand (guarded by
    tests/agent-dispatch-escalate.test.js)."""
    if status in OPEN_STATUSES:
        return True
    due = str(due_date or "")[:10]
    return (status == "Upcoming" and bool(due) and not some_day
            and due <= (today or today_london()))


def is_decide_card(agent_output):
    """A decision card (cmd_escalate): Agent Output opens with DECIDE:. Kevin's
    answer to one is for the Task Manager's board, never a carry-out."""
    return str(agent_output or "").lstrip().upper().startswith("DECIDE:")

# How many pieces of work one run may take on.
#
# A CEILING, NOT A TARGET. If eight tasks are eligible, eight run. A high cap
# costs nothing on a quiet day, which is why it should be set to clear the
# backlog rather than to feel safe.
#
# This was 5, sized so the approval queue stayed reviewable from a phone. Kevin
# overruled that on 14 Aug 2026: the queue's real home is the Tasks & Projects
# page, Slack is the on-the-go bonus, and he would rather be bombarded than have
# work sit unprocessed. Raised again the same day, to 50, once measurement
# showed 37 tasks eligible and a cap of 25 leaving 12 of them to wait a day for
# no reason. The goal is 90% of the work done by agents; a cap below the size of
# the queue is just a slower version of the starvation this already caused.
#
# Dispatch also runs ONCE a day now (daily-ops phase 6.3) where it used to run
# twice, at 07:30 and 14:30. That halving is why throughput felt slower than
# before. 50 once a day is 5x the old 5-twice-a-day, not a restoration of it.
#
# Raise it further if the eligible count ever approaches it. The real limits are
# how long the run takes and Airtable's rate limit, neither of which is near.
#
# 24 Aug 2026, Kevin's ruling during the Inbound Comms Triage build: REMOVE the
# cap entirely. None = uncapped: every eligible piece of work runs every run,
# hand-backs first (Kevin is waiting on them), then new work, then deferred.
# The 14 Aug history above is why this is safe: the cap was already a ceiling,
# not a pace, and every queue it created was pure starvation.
CAP_PER_RUN = None

# Of those slots, how many are HELD BACK for new work that no agent has touched.
#
# Why this exists: the cap applies to the whole worklist and hand-backs sort to
# the head of it. On 14 Aug all 5 slots went to carrying out already-approved
# work, so the 8 inbound messages picked up the day before were never drafted —
# empty Agent Output, never sent for approval — and NOTHING new reached the
# approval queue between 12 and 14 Aug. It is self-sustaining: while there are
# CAP_PER_RUN hand-backs waiting, new work is never reached, so no new approvals
# are produced, so the only thing left to do next run is more hand-backs.
#
# A floor breaks that loop. Unused slots are given back to hand-backs, so this
# costs nothing on a run with little new work.
NEW_WORK_FLOOR = 10

# The 17 AI agent Team Member records → the local Claude Code agent that does
# the work. Verified against the live Team Members table on 1 Aug 2026.
# role: ceo routes, head works its own tasks, worker works directly.
#
# Board trimmed 9 Oct 2026 (Kevin; brain Decisions/2026-10-09): four heads and
# four workers stay. Systemisation folded into Operations and Wealth into
# Finance; HR, Mindset and Productivity retired; Marketing, Sales and the
# Writer parked until the January Operations Director decision. Their Team
# Member rows are switched off but kept here, pointed at a live agent, so a
# task still linked to one is worked or routed by the CEO and never dispatched
# to an agent file that no longer exists.
AGENTS = {
    "reciHUAEcEkbctnZ6": {"name": "AI CEO (Dan Martell)",                    "agent": "od-ceo",                "role": "ceo"},
    "rec27NaJB7JNLaBB0": {"name": "AI HR & People (Patrick Lencioni)",       "agent": "od-ceo",                "role": "ceo"},     # retired 9 Oct 2026
    "recCzAdg2rO8bha9A": {"name": "AI Wealth (Robert Kiyosaki)",             "agent": "dept-finance",          "role": "head"},    # folded into Finance 9 Oct 2026
    "recFZ1ofn0OuoZNEr": {"name": "AI Strategy (Gary Keller)",               "agent": "dept-strategy",         "role": "head"},
    "recGvMnprGf1hr9Z1": {"name": "AI Finance (Greg Crabtree)",              "agent": "dept-finance",          "role": "head"},
    "recMKExCwu0ulMBMG": {"name": "AI Productivity (Chris Bailey)",          "agent": "od-ceo",                "role": "ceo"},     # retired 9 Oct 2026
    "recRStFWWEyHgOD6t": {"name": "AI Operations (Gino Wickman)",            "agent": "dept-operations",       "role": "head"},
    "recSvV7a47ze9i5X9": {"name": "AI Legal & Compliance (Keith Cunningham)","agent": "dept-legal-compliance", "role": "head"},
    "recYD7avVxouIkH5b": {"name": "AI Systemisation (Dave Jenyns)",          "agent": "dept-operations",       "role": "head"},    # folded into Operations 9 Oct 2026
    "recZlgKJZn7xsBfoz": {"name": "AI Mindset (John F. DeMartini)",          "agent": "od-ceo",                "role": "ceo"},     # retired 9 Oct 2026
    "reciAJnPnFEbj5FhX": {"name": "AI Marketing (Alex Hormozi)",             "agent": "od-ceo",                "role": "ceo"},     # parked to Jan 2027
    "recpCz18pCLCUf3oJ": {"name": "AI Sales (Jordan Belfort)",               "agent": "od-ceo",                "role": "ceo"},     # parked to Jan 2027
    "recFMVmHmqAOVPAeJ": {"name": "AI Worker — Writer",                      "agent": "od-ceo",                "role": "ceo"},     # parked to Jan 2027
    "recPVA1CgGyyGcBd9": {"name": "AI Worker — Auditor",                     "agent": "worker-auditor",        "role": "worker"},
    "recQkO6BA4w5zqwZ4": {"name": "AI Worker — Builder",                     "agent": "worker-builder",        "role": "worker"},
    "recbHvWqlQBbunF2F": {"name": "AI Worker — Researcher",                  "agent": "worker-researcher",     "role": "worker"},
    "recqmKBmq8ZGkxVH9": {"name": "AI Worker — Analyst",                     "agent": "worker-analyst",        "role": "worker"},
}
CEO_REC_ID = "reciHUAEcEkbctnZ6"
# The rows that left the board on 9 Oct 2026 → where their work goes now.
# `route` refuses them, so the CEO can never hand a task to a switched-off seat.
OFF_BOARD = {
    "rec27NaJB7JNLaBB0": "Retired. The AI CEO covers the workforce.",
    "recCzAdg2rO8bha9A": "Folded into Finance: route to recGvMnprGf1hr9Z1.",
    "recMKExCwu0ulMBMG": "Retired. The AI CEO covers how work reaches Kevin.",
    "recYD7avVxouIkH5b": "Folded into Operations: route to recRStFWWEyHgOD6t.",
    "recZlgKJZn7xsBfoz": "Retired. The AI CEO covers overwhelm and protected assets.",
    "reciAJnPnFEbj5FhX": "Parked until the January Operations Director decision.",
    "recpCz18pCLCUf3oJ": "Parked until the January Operations Director decision.",
    "recFMVmHmqAOVPAeJ": "Parked until January. Drafted replies go to Inbox Response.",
}
REASSIGN_MAX = 2          # bounces before a task becomes Kevin's decision

# Role-specific agents from the AI Agents register (tbl9msVjyQWslLOIZ) that
# have completed their own build session and can be DISPATCHED like the 17
# above. An entry here is a promise the agent's whole touch-set exists —
# a build session adding one must update ALL of:
#   1. this dict (one entry, its registerRow included)
#   2. ~/.claude/agents/<agent>.md (the local agent definition)
#   3. AI_AGENT_TEAM_MEMBER_RECS in follow-up.html AND follow-up-supabase.html
#      (content-equality drift-tested in follow-up-label12-agent-routing)
#   4. the register row itself: all seven stages, Built/Live status
#   5. AUTO_ROUTES below, if the agent has a deterministic lane
# Dispatchability is enforced at runtime against the LIVE register status
# (require_role_agent_live) — this dict alone never grants work.
#
# registerRow lives HERE, in the same entry as the rec id, because agent
# identity split across parallel constants blocks is exactly the drift
# constant-drift.test.js exists for (25 Aug 2026 review). The *_REC_ID /
# *_REGISTER_ROW names below are derived aliases, kept so the many existing
# readers (and their tests) stay true — never redefine them by hand.
ROLE_AGENTS = {
    "recJ8J8idWE8d97tH": {"name": "AI Inbox Response",
                          "agent": "inbound-comms-response", "role": "worker",
                          "registerRow": "recHfhVDb6BfQYco5"},
    "recjh6mmaF8KJW8t3": {"name": "AI Supplier and Creditor Manager",
                          "agent": "creditor-management", "role": "worker",
                          "registerRow": "recDvxwDGcC3pFbPa"},
    "rec1hYELb4zS8pjjO": {"name": "AI Task Board Manager",
                          "agent": "task-manager", "role": "worker",
                          "registerRow": "reczg8BygPFnJMQnh"},
    # Property Administration (build session 2 Sep 2026; was Property
    # Compliance, with Property Maintenance merged in at the agent gate).
    # Owns certificates, licences, landlord insurance and inspections across
    # the portfolio; repairs stay Roy's same-hour lane (Kevin's ruling).
    "recwWvBju2ycB63i4": {"name": "AI Property Administration",
                          "agent": "property-administration", "role": "worker",
                          "registerRow": "recZBW9tjcx9WJw4q"},
    # LESSONS ONLY — never dispatched. Added 27 Aug 2026.
    #
    # Inbound Comms Triage makes roughly forty create-or-not decisions a day,
    # more consequential judgement than any other agent makes, and until now it
    # was the ONE agent in the estate that could not receive a lesson: it had a
    # register row and a Team Members row but no entry here and no definition
    # file, so `lessons` had nowhere to land a rule and its Learning Log was
    # permanently empty.
    #
    # The consequence, measured across all 58 rejections: "only show me tasks
    # like this if it's a major issue" landed on the agent that DRAFTED the
    # reply, which never chose the task and cannot stop the next one being
    # created. Kevin taught the wrong agent every time.
    #
    # `dispatch: False` is why this entry is safe. It runs its own Go Signal
    # (09:00/13:00/17:00 via inbound-triage-run.sh) and must never be handed
    # work by the CEO pass — being in this dict would otherwise make it
    # dispatchable the moment its register row reads Live, which it does.
    "recCUfsTXzmVZynEI": {"name": "AI Inbox Triage",
                          "agent": "inbound-comms-triage", "role": "worker",
                          "registerRow": "recYy33zkoa099uM2",
                          "dispatch": False},
    # Content Engine (build 2-3 Sep 2026): the Runpreneur 360 lane. Runs on its
    # own Go Signal (02:00 nightly, scripts/content-engine-run.sh) and raises
    # one approval card per finished episode through `submit`, so it must be
    # in this dict; `dispatch: False` because the CEO pass must never hand it
    # work — its work arrives as raw clips, not tasks. Lessons land in
    # ~/.claude/agents/content-engine.md and both of its Claude calls read them.
    "recRcy1Edas6rGaaF": {"name": "AI Content Producer",
                          "agent": "content-engine", "role": "worker",
                          "registerRow": "recNaC0N5KiTGBPNy",
                          "dispatch": False},
    # Cash Flow Voids, lane A (build 2 Oct 2026; chain map approved by Kevin the
    # same day, on the register row). scripts/rent-check.py raises one RENT LATE
    # task per late tenancy per stage and this agent drafts the email to the
    # tenant. It is a TRIAL agent (TRIAL_AGENTS in agent_email_format.py): its
    # cards reach Kevin's queue like any other and nothing it raises is sent.
    "rec7aHLK1Q8fMLRXH": {"name": "AI Cash Flow Voids",
                          "agent": "cash-flow-voids", "role": "worker",
                          "registerRow": "reclaAzGLA4utssxx"},
}
ALL_AGENTS = {**AGENTS, **ROLE_AGENTS}

# Derived aliases — single source is ROLE_AGENTS above.
RESPONSE_REC_ID = "recJ8J8idWE8d97tH"          # Team Members row
CREDITOR_REC_ID = "recjh6mmaF8KJW8t3"          # Team Members row
TASKMGR_REC_ID = "rec1hYELb4zS8pjjO"           # Team Members row
PROPERTY_REC_ID = "recwWvBju2ycB63i4"          # Team Members row
RENT_REC_ID = "rec7aHLK1Q8fMLRXH"              # Team Members row (Cash Flow Voids)
RESPONSE_REGISTER_ROW = ROLE_AGENTS[RESPONSE_REC_ID]["registerRow"]
CREDITOR_REGISTER_ROW = ROLE_AGENTS[CREDITOR_REC_ID]["registerRow"]
TASKMGR_REGISTER_ROW = ROLE_AGENTS[TASKMGR_REC_ID]["registerRow"]
PROPERTY_REGISTER_ROW = ROLE_AGENTS[PROPERTY_REC_ID]["registerRow"]
RENT_REGISTER_ROW = ROLE_AGENTS[RENT_REC_ID]["registerRow"]

# ─── Deterministic routing lanes (ordered, first match wins) ─────────
#
# Kevin's rulings: inbound reply tasks go to the Response agent (24 Aug 2026)
# and creditor/payment-chasing inbound goes to the Creditor Management agent
# (25 Aug 2026) — no CEO judgement per routine item. Creditor sits FIRST
# because a creditor email is an inbound task too, and the specialist owns it.
#
# "fresh" decides a CEO-lane task that no agent owns yet. "steal" decides
# whether a task already sitting with agent `tm` moves to this lane's
# specialist — deliberately narrower, so the CEO's explicit routing decisions
# are not silently overridden (a dept head ANALYSING a payment-plan question
# keeps its task). The dispatchable gate (Kevin's register pause lever) is
# applied uniformly in the helpers below, never per entry.
#
# The creditor "fresh" lane is INBOUND-ONLY: the floor patterns are too loose
# for arbitrary CEO-lane text ("set up a payment plan for the client
# onboarding fee" is not a debt matter — review finding, 25 Aug 2026).
# Non-inbound creditor work reaches the specialist via the CEO judgement pass.
# Its "steal" covers the generalist Response agent and formerly-parked
# creditor correspondence (t["tier2Correspondence"]) only.
#
# The property lane (2 Sep 2026) sits between them: a compliance matter —
# certificate, licence, landlord insurance, inspection — goes to the Property
# Administration agent whether or not it arrived by email, because its
# engine-raised renewal tasks are not inbound and must still land there. It
# is NOT inbound-only like the creditor lane because property_match is
# name-only with a legal veto, the same discipline that makes the Roy lane
# safe. Creditor stays first: a premium-finance default notice is money owed,
# and the specialist for that owns it. Repairs never enter this lane — they
# keep Roy's same-hour handover (Kevin's ruling, 2 Sep 2026).
AUTO_ROUTES = (
    # A TENANT'S REPLY TO THE RENT CHASE (Kevin, 4 Oct 2026, "Build as-is"; widened 5 Oct 2026): an inbound message
    # from anyone a rent card wrote to (open, or SENT in the last REPLY_WINDOW_DAYS; RENT LATE, PLAN, CAP, DETAILS,
    # and the letting agent of an AGENT RENT LATE card) goes to the Cash Flow Voids agent, which drafts the answer
    # and any payment plan. OFF until the agent's trial has ended: rent_reply_senders() reads nothing while
    # it is on trial, so no tenant's message waits on a draft that cannot be sent; Inbox Response answers
    # him meanwhile. First, because the sender is a known tenant mid-chase; Roy's repair lane diverts
    # before AUTO_ROUTES, so a repair from the same tenant still goes to Roy.
    {"rec": RENT_REC_ID,
     "fresh": lambda t: bool(t.get("rentReply")) and t["inboundTask"],
     "steal": lambda t, tm: bool(t.get("rentReply")) and tm == RESPONSE_REC_ID},
    {"rec": CREDITOR_REC_ID,
     "fresh": lambda t: t["creditor"] and t["inboundTask"],
     "steal": lambda t, tm: t["creditor"] and (
         tm == RESPONSE_REC_ID or t["tier2Correspondence"])},
    # Fresh: an inbound task, or one named for the lane (triage and the
    # engine both write the COMPLIANCE: prefix). Other CEO-lane text goes
    # through the CEO's judgement, the same discipline as the creditor lane.
    # Steal: off the generalist Response agent or any strategic agent — the
    # Roy lane used to divert these whoever held them, and the specialist
    # must not be narrower than the lane it replaced.
    {"rec": PROPERTY_REC_ID,
     "fresh": lambda t: bool(t.get("property")) and (
         t["inboundTask"] or str(t.get("name", "")).startswith(COMPLIANCE_TASK_PREFIX)),
     "steal": lambda t, tm: bool(t.get("property")) and (
         tm == RESPONSE_REC_ID or tm in AGENTS)},
    {"rec": RESPONSE_REC_ID,
     "fresh": lambda t: t["inboundTask"],
     "steal": None},
)


# The tenants a reply could come from: those with an open RENT LATE or RENT PLAN task, and those whose
# payment plan is agreed and still running (the plan card is his own reply, with no tenant linked:
# its PLAN FOR line names the tenancy).
# RENT CAP (lane C, 5 Oct 2026): a capped tenant answering the benefit-cap email is the lane's too.
# Since 5 Oct 2026 (Kevin: "Do it now"): also RENT DETAILS (the form reminders) and AGENT RENT LATE (the letting agent's
# email), and a card SENT in the last REPLY_WINDOW_DAYS as well as an open one: a card closes the moment its email
# goes, so "open only" missed the replies it was for. The formula is the superset (modified in the window); the
# SENT stamp decides (rent_reply_senders).
REPLY_WINDOW_DAYS = 14
RENT_REPLY_PREFIXES = ("RENT LATE: ", "RENT PLAN: ", "RENT CAP: ", "RENT DETAILS: ", "AGENT RENT LATE: ")
RENT_REPLY_FORMULA = ("AND(OR(" + ", ".join(f"LEFT({{Task Name}}, {len(p)})='{p}'" for p in RENT_REPLY_PREFIXES) + "), "
                      "OR(AND(NOT({Status}='Completed'), NOT({Status}='Cancelled')), "
                      f"IS_AFTER(LAST_MODIFIED_TIME(), DATEADD(TODAY(), -{REPLY_WINDOW_DAYS}, 'days'))))")
REPLY_SENT_RE = re.compile(r"\[(\d{2} \w{3} \d{4}) \d{2}:\d{2} — send-email\] SENT:")
RUNNING_PLAN_FORMULA = ("AND(FIND('PLAN FOR: rec', {Agent Output}&''), LEN({Approval Outcome}&'')>0, "
                        "FIND('— send-email] SENT: email to', {Notes}&''), NOT(FIND('RENT PLAN MISSED: ', {Notes}&'')), "
                        "NOT(FIND('RENT PLAN KEPT: ', {Notes}&'')), NOT(FIND('RENT PLAN SUPERSEDED: ', {Notes}&'')))")
TASK_TENANTS = "fld6ZcfEogJmeQj2c"        # Tasks: Tenants link (scripts/rent-check.py TK["tenants"])
TENANTS_TABLE = "tblX4elTuu01gwBYh"
TENANCIES_TABLE, TENANCY_TENANTS = "tblN51a88qTDB6iMH", "fld1i5bDoHL3B6rUf"
TENANT_EMAIL, TENANT_PHONE = "fldybEduFY3DWWTfT", "fldraHUkWfqo4olLF"


def rent_reply_senders(today=None):
    """The emails and mobiles a reply to the rent lane could come from, as sender_key spells them: the tenants on an
    open rent card or one SENT in the last REPLY_WINDOW_DAYS, and, for a letting agent's card (AGENT RENT LATE), the
    address it went to, never the tenant, who was not written to. Empty, reading nothing, while the Cash Flow Voids
    agent is on trial or its trial has not ended."""
    if RENT_REC_ID in TRIAL_AGENTS or RENT_REC_ID not in TRIAL_ENDED:
        return set()
    today = today or datetime.now().date()
    tenant_ids, keys = set(), set()
    for rec in query_records(TASKS, RENT_REPLY_FORMULA, [AF["name"], AF["status"], AF["notes"], AF["agentOutput"],
                                                         TASK_TENANTS]):
        f = rec.get("fields") or {}
        status = f.get(AF["status"])
        status = status.get("name", "") if isinstance(status, dict) else (status or "")
        if status in ("Completed", "Cancelled"):
            m = REPLY_SENT_RE.search(str(f.get(AF["notes"]) or ""))
            sent = datetime.strptime(m.group(1), "%d %b %Y").date() if m else None
            if not sent or (today - sent).days > REPLY_WINDOW_DAYS:
                continue                              # closed with nothing sent, or sent too long ago
        if str(f.get(AF["name"]) or "").startswith("AGENT RENT LATE: "):
            try:
                to = parse_email_output(f.get(AF["agentOutput"]) or "").get("to") or []
            except (EmailFormatError, SystemExit):
                # A body the parser now refuses (notes for Kevin inside it, 8 Oct 2026) still names its
                # recipient on the TO line, and the letting agent's reply must still find this card.
                head = (str(f.get(AF["agentOutput"]) or "").split("\n---", 1) + [""])[0]
                line = re.search(r"^[ \t]*TO:[ \t]*(.+)$", head, re.M)
                to = [a.strip() for a in re.split(r"[,;]", line.group(1))] if line else []
            # Our own addresses are never a letting agent's: one in a TO line must not send our own mail to the lane.
            own = {sender_key(a) for a in RULE_OWN_ADDRESSES}
            keys |= {k for k in (sender_key(x) for x in to if x) if k and k not in own}
            continue
        tenant_ids |= set(links(f.get(TASK_TENANTS)))
    # A running plan: its card names the tenancy, whose tenants are read from the tenancy itself.
    tenancies = set()
    for rec in query_records(TASKS, RUNNING_PLAN_FORMULA, [AF["agentOutput"]]):
        try:
            plan = parse_plan((rec.get("fields") or {}).get(AF["agentOutput"]) or "")
        except EmailFormatError:
            plan = None
        if plan:
            tenancies.add(plan["tenancy"])
    if tenancies:
        formula = "OR(" + ",".join(f"RECORD_ID()='{t}'" for t in sorted(tenancies)) + ")"
        for rec in query_records(TENANCIES_TABLE, formula, [TENANCY_TENANTS]):
            tenant_ids |= set(links((rec.get("fields") or {}).get(TENANCY_TENANTS)))
    if not tenant_ids:
        return keys
    ids = sorted(tenant_ids)
    for i in range(0, len(ids), 50):
        formula = "OR(" + ",".join(f"RECORD_ID()='{t}'" for t in ids[i:i + 50] if re.fullmatch(r"rec\w+", t)) + ")"
        for rec in query_records(TENANTS_TABLE, formula, [TENANT_EMAIL, TENANT_PHONE]):
            f = rec.get("fields") or {}
            for v in (f.get(TENANT_EMAIL), f.get(TENANT_PHONE)):
                if v:
                    keys.add(sender_key(v))
    return keys


def auto_route_fresh(t, role_roster):
    """First dispatchable lane matching an unowned CEO-lane task, or None."""
    for lane in AUTO_ROUTES:
        if lane["fresh"](t) and role_roster.get(
                lane["rec"], {}).get("dispatchable"):
            return lane["rec"]
    return None


def auto_route_steal(t, tm, role_roster):
    """A lane's specialist this agent-owned task must MOVE to, or None."""
    for lane in AUTO_ROUTES:
        if tm == lane["rec"] or lane["steal"] is None:
            continue
        if lane["steal"](t, tm) and role_roster.get(
                lane["rec"], {}).get("dispatchable"):
            return lane["rec"]
    return None

# Task Manager context (build session 25 Aug 2026; identities live in
# ROLE_AGENTS above): it is the board foreman — its own 09:20/13:20/17:20
# slot job decides WHAT moves and drives THIS script's per-task commands, so
# there is exactly one writing muscle. Its approved hand-backs (close
# proposals, passes to Roy) are carried out by the normal dispatch runs like
# any other role agent's.

# Fixed-cost metric source (Kevin's metric two, 25 Aug 2026). The active rule
# MIRRORS isCostActive in js/shared.js — the single rule the Leadership
# Dashboard's Monthly Costs card uses — so the register and the dashboard can
# never disagree about the month's fixed-cost total.
COSTS_TABLE = "tblx5kvhzNEI5TFlS"
COST_FIELDS = {
    "expected":  "fld9JibXkMpTeMcxw",   # Expected Cost — monthly-equivalent £
    "inactive":  "fldQJPGLFMbwVelsW",   # Inactive checkbox
    "payStatus": "fldXZNI96v8HgjuSh",   # legacy Payment Status singleSelect
}
AGENTS_TABLE = "tbl9msVjyQWslLOIZ"
REGISTER_METRIC_SCORE = "fldkGxrOlrfuLlH3J"    # Metric Score (current reading)
REGISTER_FIELDS = {  # read for the CEO's routing roster
    "name":        "fldhtLvryVEzeGbl8",
    "goal":        "fldz8O9KihauZ46Cd",
    "status":      "fld71vXWqcxhdljac",
    "teamMember":  "fldEtzFGbNe4te9xL",
    # Kevin's ruling, 24 Aug 2026: his feedback becomes part of the agent's
    # working instructions. The roster carries each role agent's Learning Log
    # so the dispatcher injects the lessons into every dispatch prompt —
    # a lesson that waits for the next build session is not self-learning.
    "learningLog": "fldBdnKB1U4jZM0Jj",
}

# Tier 1: Kevin's private legal and financial matter. Agents PREPARE these and
# they go to him for approval like anything else — his call, 6 Aug 2026. They
# are not skipped any more, because the guardrail that matters sits before the
# action, not before the reading: nothing is sent, filed, paid or executed
# until he approves it, and the never-automated list (payments, credentials,
# signatures, phone calls) still applies afterwards.
#
# What the classification is FOR now: labelling. A tier-1 task carries a banner
# into its Agent Output and a red banner onto the Slack post, so he always
# knows what he is looking at before he taps. Keep the mechanism. When agents
# go autonomous, this is the line that still stops at him.
#
# MUST stay identical to KEVIN_ONLY_PATTERNS in scripts/slack-automation/
# approvals.js. Both are LABELS for the same thing and neither is routing: this
# list stamps the banner on the Agent Output, that one stamps the red banner on
# the Slack card, and each covers the other's blind spot (the worker cannot see
# a connection an agent found mid-work; the engine cannot fire on a task no
# agent touched). tests/constant-drift.test.js fails if they diverge — change
# both together or not at all.
#
# Over-labelling costs Kevin three seconds of reading; under-labelling costs him
# a surprise. So the list errs wide, per SKILL.md step 2's "when unsure, treat
# it AS tier 1".
#
# Widened 7 Aug 2026: SKILL.md step 2 enumerates the tier-1 categories the
# dispatcher must label, and six of them had no pattern at all — enforcement and
# bailiff notices, debt settlement offers, financial-disclosure forms, solicitor
# and litigation correspondence. The script silently matched none of them and
# the whole burden fell on the dispatcher's own judgement pass. The test in
# tests/agent-dispatch-tier1.test.js reads the categories out of SKILL.md and
# fails if the two ever drift apart again.
#
# Bare "financial statement" is deliberately NOT here even though it appears in
# SKILL.md's prose: Kevin's accountants produce company "financial statements"
# every year and matching it would stamp the legal-matter banner on routine
# accounting. The debt-disclosure form is caught by its full name and by the
# "income and expenditure" wording those forms actually use.
TIER1_PATTERNS = [
    re.compile(p, re.I) for p in (
        # THE EXPLICIT LABEL COMES FIRST. If a human or an agent has already
        # written "tier 1" on the record, that is the strongest signal there is
        # and it beat every subject keyword below — yet until 15 Aug 2026 it
        # matched NOTHING. Task descriptions carrying the literal words
        # "TIER 1 MATTER" came back tier1: false, so the banner reached Kevin
        # only because the dispatcher's judgement pass caught them by hand: 16
        # of 16 tier-1 items in that day's recovery run were labelled by
        # judgement, zero by this filter. A self-declaration that the machine
        # ignores is worse than no declaration, because everyone downstream
        # assumes it was honoured.
        # \b after the digit or "tier 15 pricing model" reads as tier 1. The
        # asymmetry is deliberate everywhere else: a false positive routes
        # something to Kevin with extra caution, a false negative sends a
        # private legal matter to Mica, so this errs toward matching.
        r"tier[\s\-_]*1\b", r"tier[\s\-_]*one\b",
        r"restraint order", r"operation lily", r"criminal investigation",
        r"social housing holdings", r"ach investments", r"liquidat",
        # Enforcement — the vocabulary a bailiff/HCEO notice actually uses.
        r"notice of enforcement", r"enforcement agent", r"bailiff",
        r"writ of control", r"taking control of goods",
        # Debt settlement and financial disclosure.
        r"standard financial statement", r"income and expenditure",
        r"settlement offer", r"full and final",
        # Creditor correspondence vocabulary (25 Aug 2026): these were tier-2
        # only, so once the tier-2 park opened into the creditor lane a
        # "reply to the statutory demand" task could reach approval without
        # the banner. Creditor work is always tier-1 by ruling.
        r"statutory demand", r"letter of claim", r"bounce ?back loan",
        # Legal correspondence, including law-firm senders and invoices.
        r"solicitor", r"litigation",
    )
]
# Tier 2: creditor CORRESPONDENCE is Mica's lane, never an agent's. Kept
# NARROW on purpose — a broad keyword list (e.g. "Companies House") would
# false-positive on legitimate agent research. Parked, not worked.
#
# The subject alone is not enough. Matching on subject only, an Urgent
# READ-ONLY task ("verify the current position on the statutory demand") was
# parked for ever: nothing works a parked task, and skippedTier2 raised no
# alarm, so it sat in the report silently. The lane is defined by the ACTION,
# not the topic — writing to a creditor is Mica's, reading the file is not.
#
# So a task is parked only when BOTH hold: a tier-2 subject AND an outbound
# intent. Miss the intent and the task flows on to be worked normally, still
# carrying its tier-1 banner if the subject earned one.
TIER2_PATTERNS = [
    re.compile(p, re.I) for p in (
        r"letter of claim", r"statutory demand", r"bounce ?back loan",
    )
]

# Outbound intent: the task asks somebody to be contacted, answered or dealt
# with. Deliberately about the verb, so "reply to the statutory demand" parks
# and "read the statutory demand and tell me where we stand" does not.
TIER2_OUTBOUND_PATTERNS = [
    re.compile(p, re.I) for p in (
        r"\brepl(y|ies|ying)\b", r"\brespond(ing)?\b", r"\bresponse\b",
        r"\bwrite (to|back)\b", r"\bdraft (a |an |the )?(letter|email|reply|response)",
        r"\bsend\b", r"\bcall\b", r"\bphone\b", r"\bring\b",
        r"\bcontact\b", r"\bchase\b", r"\bnegotiat", r"\bsettl(e|es|ing)\b",
        r"\bagree (a |an |the )?(payment|plan|terms|settlement)",
        r"\backnowledge\b", r"\bdispute\b", r"\bfile (a |an |the )",
        r"\bsubmit\b",
    )
]

# A PROHIBITION IS NOT AN INTENT (finding 20260812-agent-dispatch-111).
#
# The patterns above are bare word matches. On 12 Aug 2026 recSvXxaEz57i7YQK
# ("Verify the 5 obligations behind the closed POST letters", Urgent, due that
# day) was parked as creditor correspondence because its own description reads
# "Do NOT contact anyone. Read-only evidence only." The words FORBIDDING the
# outbound action are what triggered the park. A parked task is worked by
# nobody, so an HMO licence revocation on an occupied property, an HMRC balance
# and a Letter of Claim went unverified — and verify alarms about a park once
# ever, so after that day it was silent.
#
# Two defences, because either alone is thin:
#   * strip negated verb clauses before matching, so "do not contact" carries
#     no more intent than the absence of the word;
#   * an explicit read-only instruction settles it outright, whatever verbs
#     appear elsewhere in the text.
NEGATED_OUTBOUND_RE = re.compile(
    r"\b(?:do\s+not|don'?t|never|no|without|rather\s+than|instead\s+of)\s+"
    r"(?:\w+\s+){0,2}?"
    r"(?:repl(?:y|ies|ying)|respond(?:ing)?|response|writ(?:e|ing)|send(?:ing)?|"
    r"call(?:ing)?|phone|ring|contact(?:ing)?|chase|negotiat\w*|settl\w*|"
    r"acknowledge|dispute|file|submit)\b",
    re.I,
)

# Deliberately narrow: unambiguous INSTRUCTIONS to take no action, not merely
# informational wording. "For information only" was considered and dropped —
# it appears inside genuine outbound tasks as a note about an attachment.
READ_ONLY_RE = re.compile(
    r"read[\s-]?only|take no action|\bno action\b|report back only|"
    r"do not act\b|evidence only|no outbound",
    re.I,
)

# ─── ROY'S LANE (28 Aug 2026) ───────────────────────────────────────
#
# "Roy is dealing with this directly" was typed SEVEN separate times across the
# 58 rejections Kevin had ever made — 12%, the third largest group. Every one
# cost him a read, a decision and a couple of minutes, on work that was never
# his in the first place.
#
# Roy Lavin has been Head of Property since 25 Aug 2026 and `handover` has
# existed since then, carrying his standing approval for maintenance. Nothing
# ever routed to him. The capability was built and never wired, so every
# property matter still walked past him and stopped at Kevin.
#
# WHAT THIS LANE IS: the physical building. Certificates, inspections, repairs,
# contractors. Things Roy can act on by going to a property or ringing a trade.
ROY_PATTERNS = [
    re.compile(p, re.I) for p in (
        # Compliance certificates
        r"\beicr\b", r"electrical\s+(?:safety|installation|cert)",
        r"gas\s+safety", r"\bcp12\b", r"\bepc\b", r"energy\s+performance",
        r"legionella", r"\bpat\s+test", r"fire\s+(?:safety|risk|alarm|door)",
        r"emergency\s+lighting", r"smoke\s+alarm", r"carbon\s+monoxide",
        # Inspections and the licensing REGIME (not its fee — see the veto)
        r"(?:property|council|hmo|housing)\s+inspection",
        r"inspection\s+(?:report|notice|visit)", r"improvement\s+notice",
        r"hmo\s+licen[cs]", r"selective\s+licen[cs]", r"housing\s+standards",
        # The building itself
        r"\brepair", r"\bboiler\b", r"\bleak\b", r"\bdamp\b", r"\bmould\b",
        r"\bheating\b", r"\bplumb", r"\broof\b", r"\bguttering\b",
        r"\bcontractor\b", r"\bhandyman\b",
        r"\bvoid\b", r"\bgarden",
        # The fabric of the building. Added after a live pass missed "urgent
        # kitchen ceiling and rat infestation" — a category-1 hazard with no
        # matching word in the first cut.
        r"\bceiling\b", r"\binfestation\b", r"\bvermin\b", r"\bpest\b",
        r"\brats?\b", r"\bmice\b", r"\bdrain", r"\bsewer",
        r"\bwindow\b", r"\bflooring\b", r"\bcarpet\b",
    )
]
# DELIBERATELY NOT A PATTERN: a bare `maintenance`. Every task in the
# MAINTENANCE: lane carries the word in its name, so it matched the whole lane
# — including "Yale Smart Lock battery low at Brittain Home front door" (Kevin's
# own house) and "57a West Street - William H Brown letter" (an estate agent,
# so a letting or sale matter, not a repair). The lane prefix says where a task
# CAME FROM, never what it is.

# Kevin's own home is not part of the portfolio and never Roy's. Family-named
# DIY ("Fit hand rails for Paul's shower access") lives on the same board.
ROY_HOME_RE = re.compile(r"brittain\s+home|\bmy\s+(?:house|home)\b", re.I)

# THE VETO, and it is the whole safety of this lane.
#
# Modelled on CREDITOR_EXCLUDE_RE and for the same reason: the patterns above
# are blind to what the message is actually ASKING FOR. "Pay the overdue HMO
# licence fee" matches `hmo licen`, and it is a payment decision, not a job for
# the head of property. So does an enforcement notice about a fire risk — the
# risk is Roy's, the enforcement is Kevin's.
#
# Money, law and the live legal matter VETO the match outright. A vetoed
# property task is not lost: it falls through to the normal lane and reaches
# Kevin exactly as it does today. The asymmetry is deliberate — over-vetoing
# costs Kevin a decision he is already making, under-vetoing sends a solicitor's
# letter to a contractor.
#
# Kevin's own rejections show the cost of getting this right rather than wide:
# he DID want "pay overdue HMO licence fee ... forward the existing email to
# roy" to reach Roy. It is vetoed here anyway, because the same words on an
# enforcement letter must not be. He can still forward it in one click.
ROY_EXCLUDE_RE = re.compile(
    r"\bfee\b|\binvoice|\bpayment|\bpay\b|\barrears|\bdebt\b|"
    r"council\s+tax|\bhmrc\b|companies\s+house|solicitor|\bcourt\b|"
    r"enforcement|bailiff|liability\s+order|restraint\s+order|"
    r"statutory\s+demand|\blegal\b|insurance|mortgage|\bsell\b|refinanc",
    re.I,
)


def roy_match(name, description="", notes=""):
    """Why this is Roy's, or "".

    MATCHES ON THE NAME ONLY, and vetoes on everything. That asymmetry is the
    point: the name is what the task IS, while the description is context that
    routinely mentions a property or a repair in passing — matching on it sent
    a PROSPECTING task to the head of property in testing. A veto anywhere is
    still a veto, because the thing that makes a task not-Roy's (a payment, a
    solicitor, the live legal matter) is exactly the thing that turns up in the
    body rather than the subject.

    Missing one costs Kevin a decision he is already making. Getting one wrong
    sends his private legal correspondence to a contractor.
    """
    return lane_match(ROY_PATTERNS, ROY_EXCLUDE_RE, name, description, notes)


def lane_match(patterns, exclude_re, name, description="", notes=""):
    """The one lane discipline: MATCH ON THE NAME, VETO ON EVERYTHING, and
    Kevin's own home is never the portfolio. Shared by the Roy and property
    lanes so the next lane cannot copy the body and drift."""
    everything = " ".join(str(t or "") for t in (name, description, notes))
    if exclude_re.search(everything) or ROY_HOME_RE.search(everything):
        return ""
    return tier_match(patterns, name)


# ─── THE PROPERTY ADMINISTRATION LANE (build session, 2 Sep 2026) ────
#
# WHAT THIS LANE IS: the paperwork of the portfolio. Certificates, licences,
# landlord insurance, inspection notices, and their renewals. Kevin's agent
# gate on 2 Sep 2026 measured why it needed a home of its own: 17 of 26
# properties had no insurance on record, 19 certificate records had expired,
# and NOTHING alerted — the Roy lane's veto throws out every task that mentions
# insurance, a fee or a licence payment, which is exactly this work, so it all
# walked past Roy and stopped at Kevin.
#
# Same discipline as the Roy lane: MATCH ON THE NAME, VETO ON EVERYTHING. The
# veto here is the law and the live legal matter plus creditor vocabulary
# (money owed is the Creditor Management agent's, contractor invoices
# included). Money words that ARE this lane — a licence fee, an insurance
# premium — are deliberately not vetoed: the approval gate sits before every
# payment regardless, and Kevin pays; the agent only prepares.
#
# Repairs are absent on purpose. A leak reaches Roy the same hour through the
# Roy lane; this agent follows up open repairs later, it never delays them.
PROPERTY_PATTERNS = [
    re.compile(p, re.I) for p in (
        # Certificates and their renewals — always the NAMED item, never a
        # bare "certificate" or "compliance" (an SSL certificate and a GDPR
        # review matched those in the review pass and were routed here)
        r"\beicr\b", r"electrical\s+(?:safety|installation|cert)",
        r"gas\s+safe", r"\bcp12\b", r"\bepc\b", r"energy\s+performance",
        r"legionella", r"\bpat\s+test", r"fire\s+(?:safety|risk|alarm)\s+cert",
        r"fire\s+(?:alarm|risk)\b", r"emergency\s+lighting", r"smoke\s+alarm",
        r"carbon\s+monoxide", r"(?:safety|gas|electrical)\s+certificat",
        r"property\s+compliance",
        # Licensing, fee included — the licence lane is this agent's
        r"hmo\s+licen[cs]", r"selective\s+licen[cs]", r"landlord\s+licen[cs]",
        r"(?:property|council|hmo|housing)\s+inspection",
        r"inspection\s+(?:report|notice|visit)", r"improvement\s+notice",
        r"housing\s+standards",
        # Landlord insurance, always via TopCashback (Kevin's ruling)
        r"landlord(?:s'?|s)?\s+insurance", r"buildings?\s+insurance",
        r"property\s+insurance", r"topcashback",
    )
]
PROPERTY_EXCLUDE_RE = re.compile(
    # The law and the live legal matter — Kevin's, never an agent's
    r"solicitor|\bcourt\b|enforcement|bailiff|liability\s+order|"
    r"restraint\s+order|statutory\s+demand|\blegal\b|\bhmrc\b|"
    r"companies\s+house|council\s+tax|mortgage|\bsell\b|refinanc|"
    # Creditor vocabulary — money OWED is the Creditor Management lane
    r"\binvoice|chas(?:e|ing)\s+(?:a\s|the\s)?payment|payment\s+chas|"
    r"\bdebt\b|\barrears|final\s+(?:notice|demand)|letter\s+(?:before|of)\s+"
    r"(?:action|claim)|default\s+notice|premium\s+finance",
    re.I,
)


def property_match(name, description="", notes=""):
    """Why this is the Property Administration agent's, or ""."""
    return lane_match(PROPERTY_PATTERNS, PROPERTY_EXCLUDE_RE, name, description, notes)


# ─── SYSTEM ALERTS ARE NOT APPROVALS (27 Aug 2026) ──────────────────
#
# Measured that day: 13 of the 60 tasks sitting at Status Approval were
# automation failure emails — Google Apps Script, Cloudflare KV, Airtable
# automations. Every failure notification had become its own task, its own
# draft and its own approval, and approving "investigate the meetings script"
# does nothing at all: agents are read-only on code, and the meetings pipeline
# had been dead since 15 July regardless.
#
# The approval gate answers one question: MAY I DO THIS THING to a person, a
# creditor, a council or a bank. A broken cron is not that question. It is work,
# and work belongs on the board.
#
# So an alert task is CLASSIFIED and left OPEN rather than submitted. Nothing is
# hidden and nothing is closed: it stays on the board where the Task Manager
# agent already counts it, and the run report carries the count so the absence
# is reportable. That is deliberately the same shape as skippedTier2 — a lane
# that is diverted and named, never a lane that is silently dropped.
#
# MATCH ON THE SENDER, not the subject. A monitoring system always mails from
# the same address, whereas an AI writes the same incident up in fresh words
# every time — the exact reason the old duplicate key caught none of these. The
# name patterns below are a SECOND label for an alert forwarded by hand or
# raised by an agent that noticed the failure itself, and each covers the
# other's blind spot. Deliberately absent: Stripe and Supabase account mail,
# which reads like monitoring and is genuinely actionable (verification
# deadlines, a paused project), so it keeps its trip to Kevin.
SYSTEM_ALERT_SENDERS = (
    "apps-scripts-notifications@google.com",
    "noreply@airtable.com",
    "noreply@notify.cloudflare.com",
)
SYSTEM_ALERT_PATTERNS = [
    re.compile(r"apps script", re.I),
    re.compile(r"cloudflare (kv|worker)", re.I),
    re.compile(r"airtable automation", re.I),
    re.compile(r"gmail quota", re.I),
]


# Pounds, euros and any decimal sum. A bare dollar amount ("$50") is left out
# on purpose: USD sums are rare here and a missed one only falls back to the
# tier-1 and creditor vetoes. "$9.98" is caught by the decimal branch.
ALERT_MONEY_RE = re.compile(r"(?:£|\bGBP\b|\bEUR\b|€)\s*[0-9]|[0-9]+\.[0-9]{2}\b|\+\s*VAT\b", re.I)


def alert_veto(t):
    """Why a task that LOOKS like a machine alert must still be worked, or ''.
    The lane exists for Apps Script, Cloudflare and Airtable failure mails. A
    task that touches money, a creditor or the private matter is never one of
    those, whatever words its notes picked up along the way."""
    if t.get("tier1"):
        return "tier 1"
    if t.get("creditor"):
        return "creditor lane"
    if ALERT_MONEY_RE.search(str(t.get("name") or "") + " " + str(t.get("description") or "")[:600]):
        return "names a sum of money"
    return ""


def system_alert_match(sender, *texts):
    """Why this is a machine telling us something broke, or ""."""
    addr = str(sender or "").lower()
    for known in SYSTEM_ALERT_SENDERS:
        if known in addr:
            return known
    return tier_match(SYSTEM_ALERT_PATTERNS, *texts)


# Creditor lane: money Kevin or his businesses OWE. The routing floor for the
# Creditor Management agent (build session 25 Aug 2026; Kevin approved routing
# creditor and payment-chasing work to the specialist, including the formerly
# tier-2-parked correspondence). Same floor-not-ceiling contract as
# TIER1_PATTERNS: the dispatcher's judgement pass routes what these miss.
CREDITOR_PATTERNS = [
    re.compile(p, re.I) for p in (
        r"creditor",  # includes the triage skill's CREDITOR MATTER marker
        r"chas(?:e|ing)\s+(?:a\s|the\s)?payment", r"payment\s+chas",
        r"final\s+(?:notice|demand)", r"letter\s+before\s+action",
        r"letter\s+of\s+claim", r"statutory\s+demand", r"bounce\s?back\s+loan",
        r"debt\s+(?:collect|recovery)", r"collection\s+agency",
        r"payment\s+(?:plan|arrangement)", r"instalment\s+plan",
        r"overdue\s+(?:invoice|payment|account|balance)",
        r"outstanding\s+(?:invoice|balance|payment|amount)",
    )
]
# The patterns above are DIRECTION-BLIND: "chase the payment", "payment
# plan" and "final notice" appear just as readily in money owed TO Kevin —
# tenant rent chasing, client invoicing, UC verification — which is never
# this agent's lane (review finding, 25 Aug 2026: "chase the payment from
# the client for the July invoice" matched). Receivable vocabulary vetoes
# the match outright. A vetoed true-creditor task still gets worked — it
# falls to the CEO lane, whose judgement pass knows the creditor lane — so
# the veto errs on the safe side of the asymmetry.
CREDITOR_EXCLUDE_RE = re.compile(
    r"tenant|tenanc|\brent\b|arrears|universal credit|\buc\b|client",
    re.I,
)


def creditor_match(*texts):
    joined = " ".join(t or "" for t in texts)
    if CREDITOR_EXCLUDE_RE.search(joined):
        return False
    return bool(tier_match(CREDITOR_PATTERNS, *texts))


def outbound_intent(*texts):
    """The outbound verb that puts a tier-2 task in Mica's lane, or ''.

    The lane is defined by the ACTION. Writing to a creditor is Mica's; reading
    the file is not — and being told NOT to write is a read.
    """
    hay = " ".join(str(t or "") for t in texts)
    if READ_ONLY_RE.search(hay):
        return ""
    return tier_match(TIER2_OUTBOUND_PATTERNS, NEGATED_OUTBOUND_RE.sub(" ", hay))

# "Changes requested" where Kevin's feedback is actually "not yet".
#
# A hand-back sorts to the HEAD of the worklist, ahead of new work, because
# hand-backs are what he is waiting on. But a redo whose feedback says "leave
# this until next month" is not something he is waiting on — and with no
# deferred state anywhere it came back to the front of the queue on EVERY run,
# burning one of the five cap slots each time and pushing real work past the cap.
# The agent redoes it, he asks for the delay again, and it repeats twice a day.
#
# The proper fix is a Deferred Until date on Tasks so the queue can exclude it
# until the date passes; that needs a schema change and is filed separately.
# Until then these are DEMOTED to the back of the combined list, so they fall
# into reserve whenever there is other work and are only picked up on a quiet
# run. Demoted, never dropped — and counted in the queue JSON so a task sitting
# here for weeks is visible rather than silently parked.
def select_worklist(handbacks, new_work, deferred, cap=None, floor=None):
    """Choose this run's worklist so neither lane can starve the other.

    handbacks  approved carry-outs and redos, in priority order. What Kevin is
               waiting on, so they take precedence.
    new_work   tasks no agent has touched yet. Left alone, these NEVER run on a
               busy day, and then nothing new ever reaches the approval queue.
    deferred   redos whose feedback said "not yet". Quiet-run work only.

    Rules, in order:
      1. Hold back up to `floor` slots for new work, but only as many as there
         actually IS new work. A quiet day costs the hand-backs nothing.
      2. Fill the rest with hand-backs.
      3. Give any slot the other lane did not use straight back.
      4. Deferred items pick up whatever is left, which on a busy run is nothing.

    Returns at most `cap` items.
    """
    cap = CAP_PER_RUN if cap is None else cap
    floor = NEW_WORK_FLOOR if floor is None else floor
    if cap is None:
        # UNCAPPED (Kevin, 24 Aug 2026): everything eligible runs. The floor
        # only exists to share a scarce cap, so it is moot here; the lane
        # order still holds because hand-backs are what Kevin waits on.
        seen, chosen = set(), []
        for t in list(handbacks) + list(new_work) + list(deferred):
            if t["id"] not in seen:
                seen.add(t["id"])
                chosen.append(t)
        return chosen
    if cap <= 0:
        return []

    held_for_new = min(floor, len(new_work), cap)
    chosen = list(handbacks[:max(0, cap - held_for_new)])
    chosen += new_work[:cap - len(chosen)]
    # New work did not use its whole allowance — hand it back rather than idle.
    if len(chosen) < cap:
        already = {t["id"] for t in chosen}
        chosen += [t for t in handbacks if t["id"] not in already][:cap - len(chosen)]
    if len(chosen) < cap:
        chosen += deferred[:cap - len(chosen)]
    return chosen


DELAY_PATTERNS = [
    re.compile(p, re.I) for p in (
        r"\bdelay(ed|ing)?\b", r"\bdefer(red|ring)?\b", r"\bpostpone",
        r"\bhold off\b", r"\bon hold\b", r"\bpark (this|it)\b",
        r"\bnot (yet|now)\b", r"\bleave (this|it) (until|for|till)\b",
        r"\bcome back to (this|it)\b", r"\brevisit\b",
        r"\bwait until\b", r"\bnext (week|month|quarter)\b",
    )
]


def is_delay_feedback(text):
    """Does this Approval Feedback ask for the work to wait rather than change?

    Only ever applied to the feedback on a Changes-requested hand-back, which is
    Kevin's own instruction to the agent — not to a task name or description,
    where "delayed delivery" would false-positive constantly.
    """
    hay = str(text or "")
    return any(p.search(hay) for p in DELAY_PATTERNS)


# Stamped on top of a tier-1 task's Agent Output by `submit --tier1`, so the
# label travels WITH the work into Airtable and Slack instead of living only in
# a run log. verify re-reads the live field and fails if it is missing: that is
# the control that stops tier-1 work being prepared silently. Two ways a task
# earns it — the keyword match, or the dispatcher finding the connection while
# working (today's Utilita bill had no keyword in its name at all).
#
# The string itself is imported from scripts/agent_email_format.py, because
# send-email.py has to strip exactly what this prepends. When the two were
# separate strings, the banner made every tier-1 Correspondence task unsendable
# through the only sanctioned path (finding 20260811-agent-dispatch-084).


def pat():
    with open(os.path.expanduser("~/.config/od/airtable_pat")) as fh:
        return fh.read().strip()


def _request(method, path, body=None):
    url = f"https://api.airtable.com/v0/{BASE_ID}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {pat()}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"Airtable {method} {path} → HTTP {e.code}: "
            f"{e.read().decode('utf-8', 'replace')[:300]}") from None


def query_records(table, formula=None, fields=None, max_records=None):
    """The one paginated Airtable read. Every list read in this file goes
    through here — a second hand-rolled offset loop is how the recon accuracy
    card came to score only its first page (CLAUDE.md anti-patterns)."""
    records, offset = [], None
    while True:
        params = [("pageSize", "100"), ("returnFieldsByFieldId", "true")]
        if formula:
            params.append(("filterByFormula", formula))
        if max_records:
            params.append(("maxRecords", str(max_records)))
        for f in (fields or []):
            params.append(("fields[]", f))
        if offset:
            params.append(("offset", offset))
        body = _request("GET", f"/{table}?{urllib.parse.urlencode(params)}")
        records += body.get("records", [])
        offset = body.get("offset")
        if not offset:
            return records


def query_tasks(formula, max_records=None, minimal=False):
    fields = [AF["name"]] if minimal else list(AF.values())
    return query_records(TASKS, formula, fields, max_records)


ATTACH_MAX_BYTES = 5 * 1024 * 1024   # Airtable's cap, on the raw file


def upload_attachment(task_id, path):
    """Put a local file on a task's Attachments field, so Kevin can open it
    from the approval card before deciding. Same shape the AI Agents page
    uses and tests/airtable-upload-shape.test.js pins: base64 JSON to the
    RECORD path (multipart returns 400, a table id in the path returns 404 —
    both probed live 26 Aug 2026). Exits rather than leaving a half-attached
    approval."""
    return upload_file(task_id, AF["attachments"], path)


def upload_file(record_id, field_id, path):
    """The one attachment upload, for any record in the base. Split out of
    upload_attachment on 2 Sep 2026 so the certificate write path attaches
    the document to the Property Certificates row through the SAME code —
    a second copy of the upload shape is how the two would drift apart."""
    if not os.path.isfile(path):
        sys.exit(f"ERROR: no such file to attach: {path}")
    size = os.path.getsize(path)
    if size == 0:
        sys.exit(f"ERROR: refusing to attach an empty file: {path}")
    if size > ATTACH_MAX_BYTES:
        sys.exit(f"ERROR: {path} is {size / 1048576:.1f}MB — Airtable's limit "
                 "is 5MB an attachment. Attach a smaller file, or put it in "
                 "Drive and give Kevin the link in the Agent Output.")
    with open(path, "rb") as fh:
        blob = base64.b64encode(fh.read()).decode()
    url = (f"https://content.airtable.com/v0/{BASE_ID}/{record_id}/"
           f"{field_id}/uploadAttachment")
    req = urllib.request.Request(url, method="POST", data=json.dumps({
        "contentType": mimetypes.guess_type(path)[0] or "application/octet-stream",
        "filename": os.path.basename(path),
        "file": blob,
    }).encode(), headers={"Authorization": f"Bearer {pat()}",
                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(f"ERROR: Airtable refused the attachment {path} -> HTTP "
                 f"{e.code}: {e.read().decode('utf-8', 'replace')[:200]}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        # A timeout is the awkward one: Airtable may have stored the file
        # anyway, so the retry has to be safe. supersede_attachments below is
        # what makes it safe — same filename replaces, never accumulates.
        sys.exit(f"ERROR: could not reach Airtable to attach {path}: {e}")
    return os.path.basename(path)


def supersede_attachments(task_id, filenames):
    """Drop any attachment already on the task whose filename matches one we
    are about to upload, keeping everything else.

    The Attachments field is a SHARED bucket: the inbound importer puts the
    sender's own email attachments there (follow-up.html writes the same
    field id), and Kevin's feedback files land there too. So an agent
    re-attaching letter-of-authority.pdf after a redo must replace ITS OWN
    previous version and leave the creditor's notice.pdf alone — clearing the
    field wholesale would destroy evidence Kevin needs. Without this a redo
    leaves two identically-named links on the approval card and no way to
    tell which one is current."""
    if not filenames:
        return []
    atts = (get_task(task_id).get("fields", {}) or {}).get(AF["attachments"]) or []
    keep = [{"id": a["id"]} for a in atts if a.get("filename") not in filenames]
    dropped = [a.get("filename") for a in atts if a.get("filename") in filenames]
    if len(keep) != len(atts):
        patch_task(task_id, {AF["attachments"]: keep})
    return dropped


def patch_task(task_id, fields):
    return _request("PATCH", f"/{TASKS}/{task_id}",
                    {"fields": fields, "typecast": True})


def fetch_role_roster():
    """The role-agent workforce from the AI Agents register, keyed by Team
    Members record id so the router speaks the same ids as task links.

    A failed read must not kill the queue (routing to the 17 still works),
    but it must be VISIBLE: the caller puts the error in the queue JSON, the
    skill copies it into report.json, and cmd_verify fails the run on it."""
    roster = {}
    for rec in query_records(AGENTS_TABLE,
                             fields=list(REGISTER_FIELDS.values())):
        f = rec.get("fields", {})
        tm = links(f.get(REGISTER_FIELDS["teamMember"]))
        if not tm:
            continue
        status = sel(f.get(REGISTER_FIELDS["status"]))
        roster[tm[0]] = {
            "name": f.get(REGISTER_FIELDS["name"], ""),
            "goal": f.get(REGISTER_FIELDS["goal"], ""),
            "status": status,
            # An entry with dispatch=False can receive LESSONS but never WORK.
            # Its own scheduled job is its Go Signal; the CEO pass must not
            # hand it tasks on top.
            "dispatchable": tm[0] in ROLE_AGENTS
                            and ROLE_AGENTS[tm[0]].get("dispatch", True)
                            and status in ("Built", "Live"),
            "learningLog": f.get(REGISTER_FIELDS["learningLog"], ""),
        }
    return roster


def get_task(task_id):
    return _request(
        "GET", f"/{TASKS}/{task_id}?returnFieldsByFieldId=true")


def sel(v):
    return v.get("name", "") if isinstance(v, dict) else (v or "")


def links(v):
    if not isinstance(v, list):
        return []
    return [x.get("id") if isinstance(x, dict) else str(x) for x in v if x]


def tomorrow_london():
    return (datetime.now(LONDON) + timedelta(days=1)).strftime("%Y-%m-%d")


def today_london():
    return datetime.now(LONDON).strftime("%Y-%m-%d")


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


STATE_DIR = os.path.expanduser("~/knowledge-os/logs/agent-dispatch")
INTENT_LEDGER = os.path.join(STATE_DIR, "carryout-intent.jsonl")


# The machine-readable half of a keep-open carry-out. Written into Notes by
# `complete --keep-open`, re-read from the LIVE record by verify. A sentence a
# human could paraphrase would not survive as a control; this string is checked
# verbatim, so changing it here changes both halves at once.
CARRIED_OUT_MARK = "CARRIED OUT (task left open):"

# "Approve with minor edits" USED to be a scoring label and nothing more: both
# approve kinds told the agent to carry out its original text "deviating in
# nothing", so a note saying "change the date to Friday" was passed along and
# then ignored. Kevin found this on 26 Aug 2026 and it is the wrong way round —
# he types an edit expecting it to be made.
#
# Now the edit is APPLIED before the action, and `complete` refuses a
# minor-edits task that never applied one. This marker in Notes is the
# machine-readable half, read back from the LIVE record rather than trusted
# from the run, exactly like CARRIED_OUT_MARK above.
EDITS_APPLIED_MARK = "EDITS APPLIED:"


def ledger_append(task_id, event):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(INTENT_LEDGER, "a") as fh:
        fh.write(json.dumps({"task": task_id, "ts": now_iso(),
                             "event": event}) + "\n")


IDLE_HOURS = 24
PARKED_NOTE_RE = re.compile(r"^\s*(?:PARKED|BLOCKED)\b", re.I)


def ledger_last_events():
    """task id -> (event, ts) for the newest ledger line per task."""
    state = {}
    try:
        with open(INTENT_LEDGER) as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(rec, dict):
                    continue
                state[rec.get("task")] = (rec.get("event"), rec.get("ts") or "")
    except FileNotFoundError:
        pass
    return state


def idle_handback(t, last, now=None):
    """Why an APPROVED hand-back is resting rather than waiting on an agent, or ''.

    `last` is the newest ledger (event, ts) for the task. Two events rest it:
    "done" written by `complete --keep-open` (the approved action happened and
    the task stays open by Kevin's own words) and "parked" written by `annotate`
    when the agent's note opens PARKED or BLOCKED (a sign-in only Kevin can do).
    Rest lasts IDLE_HOURS from that event, and ends early the moment Kevin's
    verdict moves: an Approved At newer than the event means he approved again,
    so the task is worked. A plain "done" on a task still Approved with no
    keep-open mark in its Notes is NOT rested — that is an incomplete close and
    the run must look at it. A verdict on a Your step card is not one that moves
    (your_step_reapproved)."""
    if t.get("outcome") not in APPROVED:
        return ""
    step_wait = your_step_reapproved(t)
    if step_wait:
        return step_wait
    if not last:
        return ""
    event, ts = last
    if event not in ("done", "parked") or not ts:
        return ""
    if event == "done" and CARRIED_OUT_MARK not in str(t.get("notes") or ""):
        return ""
    approved_at = str(t.get("approvedAt") or "")
    if approved_at and approved_at > ts:
        return ""
    # A PARKED TASK ON AN OPEN WALL RESTS UNTIL THE WALL CLEARS (Kevin, 7 Oct 2026). The day's
    # rest used to end on its own, so the poll handed the task back, the agent met the same wall
    # and parked it again: 235 parks and 264 dispatch actions on 39 blocked tasks in 14 days,
    # and no progress. Every clear writes `unblocked` (wake_blocked), which ends this at once.
    b = task_blocker(t.get("notes")) if event == "parked" else None
    if b and b["kind"] != "KEVIN":
        return f"parked on {b['kind']} {b['subject']} at {ts[:16]}; rests until the wall clears or Kevin's verdict changes"
    # A KEVIN wall keeps the day's clock here: one the sweep can put in Kevin's lane leaves the
    # queue within half an hour (Status Approval), and one it cannot (a decision card, a task with
    # no agent) would otherwise rest for ever with no door (review, 7 Oct 2026).
    try:
        when = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return ""
    now = now or datetime.now(timezone.utc)
    if now - when >= timedelta(hours=IDLE_HOURS):
        return ""
    left = int((timedelta(hours=IDLE_HOURS) - (now - when)).total_seconds() // 3600)
    what = ("carried out and kept open" if event == "done"
            else "parked on a sign-in only Kevin can do")
    return "%s at %s; rests %dh more, or until Kevin's verdict changes" % (what, ts[:16], left)


def blocked_rest(t, last, now=None):
    """Why an UNAPPROVED task with an open wall is resting, or ''. It rests from
    the `parked` event `block` writes until the wall clears (the clear writes
    `unblocked`, so `last` is no longer parked) or Kevin's verdict moves. No
    clock (7 Oct 2026): a day's rest that ended by itself re-dispatched the task
    to meet the same wall, every day, for twelve days."""
    if t.get("outcome") in APPROVED or not last or last[0] != "parked" or not last[1]:
        return ""
    b = task_blocker(t.get("notes"))
    if not b:
        return ""
    if str(t.get("approvedAt") or "") > last[1]:
        return ""
    if b["kind"] == "KEVIN":
        # Nothing clears a KEVIN wall on unapproved work (block refuses a new one since 7 Oct
        # 2026), so one left from before keeps the day's clock: the agent then submits a card.
        try:
            when = datetime.fromisoformat(last[1].replace("Z", "+00:00"))
        except ValueError:
            return ""
        if (now or datetime.now(timezone.utc)) - when >= timedelta(hours=IDLE_HOURS):
            return ""
    return (f"blocked on {b['kind']} {b['subject']} since {last[1][:16]}; rests until the wall clears "
            "or Kevin's verdict changes")


def open_intents():
    """Task IDs with a carry-out intent never followed by a done marker —
    i.e. the action may already have happened without the task completing."""
    state = {}
    try:
        with open(INTENT_LEDGER) as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(rec, dict) or rec.get("event") in ("parked", "unblocked"):
                    # A wall recorded or cleared (14 and 25 Sep 2026) says nothing about
                    # whether the action ran; skipping it keeps an earlier intent open, so
                    # the woken carry-out still checks what already happened (review).
                    continue
                state[rec.get("task")] = rec.get("event")
    except FileNotFoundError:
        pass
    return {t for t, e in state.items() if e == "intent"}


# Machine detail that means nothing to Kevin: a script path, a filename with
# an extension, an Airtable record/field/table id, or an API/CLI word. Matched
# only inside the CLOSING line, never the body — the body is allowed to be
# technical, that is where an agent shows its working.
JARGON_RE = re.compile(
    r"(\bscripts?/[\w./-]+"
    r"|(?<![@\w.])[\w-]+\.(?:py|js|sh|mjs|json)\b"
    r"|\b(?:rec|fld|tbl|usr|app)[A-Za-z0-9]{14}\b"
    r"|\bfilterByFormula\b|\bcurl\b)")


# Kevin's ruling, 4 Sep 2026, measured on 233 decisions over 14 days: 29 of
# 40 "Analysis" outputs were rejected, and every rejection said the task should
# not have reached him. A report whose closing line says nothing happens on
# approval is information, not a decision: it is FILED on the task and the
# task closes. He reads it if he wants to, and his queue holds only things
# that act.
#
# THE SHAPE OF THE RULE (two reviews on the day it was built): the agent
# DECLARES it, the code does not infer it. A closing line is informational
# only when it OPENS with a bare "Nothing" / "No action" / "None" and no
# further clause follows — no semicolon, dash, colon, "then", "until", "but".
# Two verb-list versions were tried and both broke: "No payment is made; I
# email the creditor" and "None; the accountant will lodge the return" read
# as nothing-to-do. Anything not in the declared form goes to the gate, which
# is exactly what happened before, so a miss costs Kevin one tap, never a
# lost action. GUARDRAILS.md tells agents the form.
NO_ACTION_LEAD_RE = re.compile(
    r"^\W*(?:nothing|none|n/?a|no\s+(?:further\s+)?action(?:\s+(?:is\s+)?(?:needed|required))?)\b",
    re.I,
)
# WHITELIST, not blacklist (third review, same day): after the opening word
# only a fixed set of informational phrases may follow. Every blacklist tried
# was written around ("as the eviction proceeds", "because the payment leaves
# the account on Friday"). A closed form cannot be: one extra word and the
# line is not declared, so the task goes to Kevin as it always did.
INFO_PHRASE_RE = re.compile(
    r"^(?:[\s.,!:;()-]*(?:(?:this|it|the\s+(?:report|briefing|summary|above))\s+is\s+)?"
    r"(?:for\s+(?:your\s+)?information(?:\s+only)?|information\s+only|reference\s+only|"
    r"a\s+(?:briefing|report|summary|status\s+update)|"
    r"no\s+decision\s+(?:is\s+)?(?:needed|required)(?:\s+here)?|"
    r"nothing\s+(?:is\s+)?(?:needed|required)|no\s+action\s+(?:is\s+)?(?:needed|required)|"
    r"(?:is\s+)?needed|(?:is\s+)?required|from\s+(?:me|you|Kevin)|"
    r"to\s+(?:do|approve|decide|carry\s+out)|(?:at\s+)?this\s+stage|for\s+now|here|today))*"
    r"[\s.,!:;()-]*$",
    re.I,
)
NO_ACTION_HEAD_RE = re.compile(r"^\W*(?:NO ACTION (?:REQUIRED|NEEDED)|BRIEFING|FOR INFORMATION)\b", re.I)
NO_ACTION_TAIL_MAX = 120


def carry_out_tail(output):
    """The words after the LAST closing-line marker, or '' when there is none."""
    matches = list(CARRY_OUT_RE.finditer(output or ""))
    return (output or "")[matches[-1].end():].strip() if matches else ""


def no_action_declared(tail):
    """True only for the declared form: opens with Nothing/None/No action and
    what follows, if anything, is drawn from INFO_PHRASE_RE alone."""
    tail = (tail or "").strip()
    m = NO_ACTION_LEAD_RE.match(tail)
    if not m or len(tail) > NO_ACTION_TAIL_MAX:
        return False
    return bool(INFO_PHRASE_RE.match(tail[m.end():]))


def informational_only(output, task_type, tier1=False):
    """True when this submission would ask Kevin to approve nothing.

    Never for Correspondence: an email whose closing line says "nothing" is a
    broken email, and the send-format check downstream is the right refusal.
    Never for tier 1: the banner promises he reads it before anything, and a
    private legal or financial matter is his to see even when nothing moves.
    A closing line is always required: the heading alone declares nothing,
    and short outputs skip the closing-line check upstream.
    """
    if task_type == "Correspondence" or tier1 or TIER1_BANNER in (output or ""):
        return False
    tail = carry_out_tail((output or "").strip())
    if not tail:
        return False
    return no_action_declared(tail)


# ─── THE COVERAGE CHECK on quote requests (Kevin, 7 Sep 2026) ───────────
#
# "We're not emailing somebody a property address that's not within their
# location, because that just looks clueless from our perspective. Double and
# treble check the geographic location of the contractor." Also: three quotes
# per job, and one request may cover several properties ONLY when the
# contractor covers every one of them.
#
# So a quote-related email on a property task carries a coverage file:
#
#   PROPERTY: 6 Chedburgh Place, Haverhill, CB9 0AB
#   PROPERTY: 13 Chedburgh Place, Haverhill, CB9 0AB
#   CONTRACTOR: AC1 Electrical Services covers CB9, CB8, IP33 (source: https://...)
#
# `submit` refuses without it, refuses a contractor line with no source, refuses
# any property whose postcode district is not in what the contractor says it
# covers, and refuses an email body that names a postcode the file did not
# declare. What passed is stamped into Notes and the card shows it.
COVERAGE_MARK = "COVERAGE CHECKED"
COVERAGE_PROPERTY_RE = re.compile(r"^\s*PROPERTY:\s*(?P<addr>.+?)\s*$", re.I | re.M)
COVERAGE_CONTRACTOR_RE = re.compile(
    r"^\s*CONTRACTOR:\s*(?P<name>.+?)\s+covers\s+(?P<areas>.+?)\s*\((?:source|from):\s*(?P<src>https?://\S+)\)\s*$",
    re.I | re.M)
UK_POSTCODE_RE = re.compile(r"\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b", re.I)
QUOTE_WORDS_RE = re.compile(
    r"\bquot|certificat|\bEICR\b|gas safety|\bGSC\b|\bEPC\b|fire alarm|emergency lighting|"
    r"\binspection\b|\bboiler\b|\belectrician|\bplumb|\bengineer", re.I)
PROPERTY_LANE_RE = re.compile(r"^\s*(COMPLIANCE|CORRESPONDENCE|MAINTENANCE)\s*:", re.I)


def postcode_district(text):
    m = UK_POSTCODE_RE.search(str(text or ""))
    return m.group(1).upper() if m else ""


def coverage_parse(text):
    props = [m.group("addr").strip() for m in COVERAGE_PROPERTY_RE.finditer(text or "")]
    contractors = []
    for m in COVERAGE_CONTRACTOR_RE.finditer(text or ""):
        areas = [a.strip().upper() for a in re.split(r"[,;/]|\band\b", m.group("areas"), flags=re.I) if a.strip()]
        contractors.append({"name": m.group("name").strip(), "areas": areas, "source": m.group("src")})
    return props, contractors


def area_covers(areas, address):
    """True when the contractor's stated areas include this property."""
    district = postcode_district(address)
    letters = re.match(r"[A-Z]+", district).group(0) if district else ""
    addr_up = str(address or "").upper()
    for a in areas:
        if a in ("NATIONWIDE", "NATIONAL", "UK-WIDE", "UK WIDE"):
            return True
        if district and a == district:
            return True
        if letters and a == letters:
            return True            # an area code: "CB" covers CB9
        if len(a) >= 4 and not re.match(r"^[A-Z]{1,2}\d", a) and a in addr_up:
            return True            # a town named in the address
    return False


# A quote REFERENCE is a label, not a request for a trade quote: "Quote Ref:
# 931520229" on an insurer's renewal (25 Sep 2026, PIB) tripped this check.
QUOTE_REF_RE = re.compile(r"\bquot(?:e|ation)\s*(?:ref(?:erence)?|no|number|#)\.?\s*[:#]?\s*[\w/-]+", re.I)


def quote_scope(output):
    """The words the quote test reads: the email itself (subject and body),
    never the briefing above its headers or the TRACK RECORD (history
    addressed to Kevin), and with quote REFERENCES taken out. The PIB reply
    to an insurer was refused because its track record quoted her subject
    ("[Quote Ref: 931520229]") and its briefing compared insurance quotes;
    neither is a request to a tradesperson."""
    text = strip_track_record(output or "")
    start = re.search(r"^\s*(?:TO|TO-EACH):", text, re.M | re.I)
    email = text[start.start():] if start else text
    try:
        mail = parse_email_output(email)
        email = f"{mail.get('subject', '')}\n{mail.get('body', '')}"
    except EmailFormatError:
        pass
    return QUOTE_REF_RE.sub(" ", email)


def coverage_problem(coverage_text, output, task_name, task_type):
    """Why a quote-related email may not go, or '' when every property is covered."""
    if task_type != "Correspondence" or not PROPERTY_LANE_RE.match(task_name or ""):
        return ""
    if not QUOTE_WORDS_RE.search(quote_scope(output)):
        return ""
    props, contractors = coverage_parse(coverage_text)
    if not props or not contractors:
        return ("a quote-related email on a property task needs a coverage file "
                "(--coverage): `PROPERTY: <address with postcode>` per property and "
                "`CONTRACTOR: <name> covers <districts, towns or nationwide> (source: <url>)`. "
                "Kevin's rule, 7 Sep 2026: never write to a tradesperson about an address "
                "outside their area")
    for pr in props:
        if not postcode_district(pr):
            return f"PROPERTY line has no postcode: {pr!r}"
    for c in contractors:
        for pr in props:
            if not area_covers(c["areas"], pr):
                return (f"{c['name']} covers {', '.join(c['areas'])} but {pr!r} is "
                        f"{postcode_district(pr)}: outside their area, so this email must "
                        "not name that property. Find a tradesperson who covers it, or drop "
                        "the property from this request")
    # Every postcode the email itself names must be a declared property.
    body = (output or "").split("\n---", 1)[-1]
    declared = {postcode_district(pr) for pr in props}
    for m in UK_POSTCODE_RE.finditer(body):
        if m.group(1).upper() not in declared:
            return (f"the email names postcode {m.group(0)} but no PROPERTY line declares "
                    "it: every address in the email is checked, or none is")
    return ""


def coverage_stamp(coverage_text, stamp):
    props, contractors = coverage_parse(coverage_text)
    who = "; ".join(f"{c['name']} covers {', '.join(c['areas'])} ({c['source']})" for c in contractors)
    where = ", ".join(f"{postcode_district(pr)} ({pr.split(',')[0].strip()})" for pr in props)
    return f"[{stamp} — agent-dispatch] {COVERAGE_MARK}: {where} within {who}."


# ─── THE REDO RECEIPT (Kevin, 7 Sep 2026) ─────────────────────────────
#
# Measured that day: of 132 tasks Kevin gave feedback on since 27 Aug, 30 went
# round two or more times for real (13 of them three or more). His words: "I've
# requested changes and given feedback but those changes haven't been
# understood." An agent could resubmit anything after a Changes requested and
# nothing checked it had read his words at all — the EICR quote came back twice
# with the bedroom count still wrong.
#
# So a redo now carries a RECEIPT: one line per point he made, each saying what
# changed (or why it could not). `submit` refuses a redo without one, refuses
# a receipt with fewer lines than his points, and refuses a redo whose text is
# identical to the one he sent back. The receipt goes into Notes, and his card
# leads with it, so he sees at a glance whether he was understood before he
# reads a word of the draft.
RECEIPT_MARK = "FEEDBACK ANSWERED"
RECEIPT_LINE_RE = re.compile(r"^\s*[-*]\s*(?P<point>.+?)\s*(?:→|->)\s*(?P<change>.+?)\s*$")
RECEIPT_MIN_WORDS = 6      # a sentence shorter than this is not a point on its own
RECEIPT_MAX_POINTS = 6


def feedback_points(feedback):
    """Kevin's feedback split into the points a receipt must answer."""
    text = re.sub(r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*", "", str(feedback or ""), flags=re.M)
    parts = re.split(r"(?<=[.!?])\s+|\n+", text)
    points = [p.strip() for p in parts if len(p.split()) >= RECEIPT_MIN_WORDS]
    return points[:RECEIPT_MAX_POINTS]


def receipt_lines(receipt):
    out = []
    for line in str(receipt or "").splitlines():
        m = RECEIPT_LINE_RE.match(line)
        if m and m.group("point").strip() and m.group("change").strip():
            out.append((m.group("point").strip(), m.group("change").strip()))
    return out


def od_picture_problem(task_name, output):
    """A CONTENT (OD) post card must carry its picture as a permanent link (Kevin, 9 Sep 2026: cards arrived with no link he could open,
    after another process re-submitted them with its own file). THIN cards and newsletter cards carry no picture and pass."""
    name = str(task_name or "")
    if not name.startswith("CONTENT (OD):") or "Newsletter:" in name: return ""
    text = str(output or "")
    if text.lstrip().upper().startswith("THIN SLOT"): return ""
    # A CLOSE PROPOSAL is ABOUT the card, not the post on it, so demanding the
    # post's picture is asking for a picture that is the reason the card is being
    # closed. recZdwbWGIFjMEyG6 (a stale OD post) made task-manager retry the same
    # refused submit in its 13:00 and 17:00 slots for six days running — two of the
    # three board passes a day ended VERIFY FAIL and the card never left the board
    # (findings 20260917-task-manager-board-541, 20260918-task-manager-board-547,
    # 20260919-task-manager-board-553/554, 20260920-daily-ops-556).
    # Kevin approves removing a dead card; he is not being shown a post. The alert
    # lane below this already carries exactly the same exemption for exactly the
    # same reason, and this gate was written without it.
    if text.lstrip().upper().startswith("CLOSE PROPOSAL:"): return ""
    if re.search(r"https://assets\.cdn\.filesafe\.space/\S+\.(png|jpg|jpeg)", text, re.I): return ""
    return ("an Operations Director post card must carry its picture as a permanent link (assets.cdn.filesafe.space ...png) so Kevin can open "
            "it; re-run the lane's `cards` step rather than re-submitting the text alone")


def receipt_problem(receipt, feedback, old_output, new_output):
    """Why this redo may not be submitted, or '' when the receipt holds."""
    lines = receipt_lines(receipt)
    points = feedback_points(feedback)
    if not lines:
        return ("no receipt: a redo must carry one line per point Kevin made, "
                "in the form `- <his point> → <what changed, or cannot: why>`")
    if len(lines) < len(points):
        return (f"the receipt answers {len(lines)} point(s) but Kevin made "
                f"{len(points)}: every point gets a line, including the ones you "
                "could not do (`→ cannot: <why>`)")
    if " ".join(str(new_output or "").split()) == " ".join(str(old_output or "").split()):
        return "nothing changed: the new text is identical to the one Kevin sent back"
    return ""


def receipt_block(receipt, round_no, stamp):
    lines = receipt_lines(receipt)
    body = "\n".join(f"- {pt} → {ch}" for pt, ch in lines)
    return f"[{stamp} — agent-dispatch] {RECEIPT_MARK} (round {round_no}):\n{body}"


# Only the receipt blocks THIS task wrote set its round (21 Sep 2026). Notes
# also carries TRACK RECORD lines copied from the task history, in the form
# "- 15 Sep 2026 10:11 — agent-dispatch: FEEDBACK ANSWERED (round 7): (link)",
# many of them from other tasks. Counting the bare mark counted every one: on
# 21 Sep 63 of 109 tasks were misnumbered, 46 of them with no receipt of their
# own, and rec0D35XfxR2QgvIX's first receipt went out as round 7.
RECEIPT_HEADER_RE = re.compile(
    r"^\[\d{1,2} \w{3} \d{4}(?: \d{2}:\d{2})?\s*[—–-]\s*agent-dispatch\] "
    + RECEIPT_MARK + r" \(round \d+\):(?P<rest>[^\n]*)$", re.M)


def receipt_round(notes, task_id):
    """The round a new receipt carries: this task's own receipt blocks, plus one.
    A header naming a different record id was copied in, so it never counts."""
    own = 0
    for m in RECEIPT_HEADER_RE.finditer(str(notes or "")):
        if set(re.findall(r"\brec[A-Za-z0-9]{14}\b", m.group("rest"))) - {task_id}:
            continue
        own += 1
    return own + 1


def feedback_archived(history, text):
    """True when this feedback text is already in the archive, stamps ignored.

    Three surfaces write Feedback History at decision time and submit archived
    Approval Feedback again with a fresh stamp: 84 of 262 blocks (32%) were
    exact duplicates on 7 Sep 2026, which made the history unreadable to the
    agent redoing the work and to anyone counting rounds.
    """
    want = " ".join(str(text or "").split())
    if not want:
        return True
    blocks = re.split(r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s*", str(history or ""), flags=re.M)
    return any(" ".join(b.split()) == want for b in blocks)


# ─── THE REPORT GATE (Kevin, 7 Sep 2026) ──────────────────────────────
#
# 61% of reports reaching the gate between 20 Aug and 7 Sep were rejected, and
# every one for a question the agent could have answered: already handled,
# Roy's, a machine, an open task, not worth his time. Reports on inbound items
# were arriving at 10 a day. So a report on an INBOUND task now opens with one
# line that shows the five questions were asked, and names the trigger that
# makes it Kevin's:
#
#   CHECKED: handled=no; roy=no; machine=no; open-task=no; trigger=deadline
#
# A `yes` on any of the first four means it is not a report (it is a close, a
# handover or a board item) and is refused. `trigger=none` means nothing needs
# deciding and the report FILES itself, exactly like the Nothing line. No line
# at all is refused: the agent looks, or the card does not exist.
CHECKED_RE = re.compile(r"^\s*CHECKED:\s*(?P<body>[^\n]+)$", re.I | re.M)
CHECK_KEYS = ("handled", "roy", "machine", "open-task", "trigger")
CHECK_TRIGGERS = ("money", "data-request", "legal", "deadline", "obligation",
                  "unknown-sender", "kevin-asked", "none")
REPORT_TYPES = ("Analysis", "Research", "Admin", "Drafting", "Audit", "Build")
CHECK_EXEMPT_RE = re.compile(
    r"^\s*(CLOSE PROPOSAL:|PASS TO ROY:|CALENDAR:|MARK FOR PAYMENT|DOCUMENT:|POST:)", re.I)


def checked_parse(output):
    m = CHECKED_RE.search(output or "")
    if not m:
        return None
    out = {}
    for part in re.split(r"[;|,]\s*", m.group("body")):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip().lower()] = v.strip().lower()
    return out


def checked_problem(output, task_type, inbound):
    """Why a report on an inbound item may not be submitted, or ''."""
    if not inbound or task_type not in REPORT_TYPES:
        return ""
    out = (output or "").strip()
    if CHECK_EXEMPT_RE.match(out) or SIGNIN_NEEDED_RE.search(out):
        return ""
    c = checked_parse(out)
    if c is None:
        return ("a report on an inbound item must open with the five questions "
                "answered: `CHECKED: handled=no; roy=no; machine=no; open-task=no; "
                "trigger=<money|data-request|legal|deadline|obligation|unknown-sender"
                "|kevin-asked|none>`. trigger=none files it; a yes on any of the "
                "first four means it is a close, a handover or a board item, not a report")
    missing = [k for k in CHECK_KEYS if k not in c]
    if missing:
        return f"the CHECKED line is missing {', '.join(missing)}"
    for k in CHECK_KEYS[:4]:
        if c[k] == "yes":
            what = {"handled": "already handled: propose the close with the Completed task cited",
                    "roy": "Roy's: PASS TO ROY",
                    "machine": "a machine reporting a breakage: leave it on the board (annotate)",
                    "open-task": "an open task already holds it: annotate that task, then propose the close"}[k]
            return f"CHECKED says {k}=yes, so this is not a report; it is {what}"
    trig = c["trigger"]
    if not (trig in CHECK_TRIGGERS or trig.startswith("other:")):
        return (f"trigger={trig!r} is not one of {', '.join(CHECK_TRIGGERS)} "
                "(or other:<why>)")
    return ""


def checked_trigger(output):
    c = checked_parse(output)
    return c.get("trigger") if c else None


# ─── AUTONOMY LEVELS (Kevin's ruling, 7 Sep 2026; Chen Book 4, ch 5) ─────
#
# Measured before the change: 260 decisions in 586 active minutes since
# 20 Aug 2026, 135 seconds each, and not one rejection was a bad draft. 42 of
# 42 close proposals were the Task Manager asking Kevin to rubber-stamp a fold
# or an already-handled close (39 approved as-is), and 61% of reports were
# rejected because nothing in them needed deciding. He was the noise filter.
#
# So a submission now sits at one of three LEVELS, decided per CATEGORY of
# decision from the output's shape — and, the part that makes it safe, the
# evidence is VERIFIED here before anything is carried out. A close proposal
# naming a keeper that does not exist, is newer, or is this very task is not a
# duplicate fold; it is a card, exactly as before. Nothing here trusts the
# agent's word.
#
# The word "tier" is deliberately NOT used: TIER1_PATTERNS already means the
# private legal matter, and Chen's "Tier 1" means the opposite (fully
# delegated). Levels A / B / C avoid the collision. Anything the tier-1 matter
# touches is Level C whatever its shape.
AUTONOMY_ACT = "A"       # the agent acts; Kevin sees it on "Handled without you"
AUTONOMY_APPROVE = "B"   # drafted, Kevin approves
AUTONOMY_KEVIN = "C"     # Kevin only

# The money rule (Kevin, 7 Sep 2026), lowered from £50/£250 while the card
# balances are paid down. Declared on the output as `SPEND: £80`, or
# `SPEND: £80/month` for anything recurring. Under `log` the agent acts and
# logs it; up to `inform` it acts and the 08:00 message names it; above, a
# card; recurring, always Kevin. GUARDRAILS.md and the role-agent files quote
# these two numbers, and tests/constant-drift.test.js keeps them in step.
DECISION_MONEY = {"log": 25, "inform": 100}
SPEND_LINE_RE = re.compile(
    r"^\s*SPEND:\s*£?\s*(?P<amount>[0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*"
    r"(?P<recurring>(?:/|per\s+|a\s+|each\s+|every\s+)?"
    r"(?:month|week|year|quarter|annum|recurring|monthly|weekly|annually|yearly)\b)?",
    re.I | re.M)

# The Notes marker every Level A carry-out leaves. The AI Agents page's
# "Handled without you" lane and the 08:00 message both key on it.
HANDLED_MARK = "HANDLED WITHOUT YOU"

# Widened 15 Sep 2026: "CLOSE PROPOSAL: duplicate — a newer version of the
# same reply (recXXX, submitted 7 Sep)" is the same claim as "duplicate of
# recXXX" and used to fall through to close: judgement (a card). The keeper is
# the first record id on the line; every verification below still runs on it.
CLOSE_DUPLICATE_RE = re.compile(
    r"^\s*CLOSE PROPOSAL:\s*duplicate\b[^\n]*?(rec[A-Za-z0-9]{14})\b", re.I)
CLOSE_HANDLED_RE = re.compile(
    r"^\s*CLOSE PROPOSAL:\s*(?:already (?:handled|done|dealt with)|done already|handled)\b"
    r"[^\n]*?\b(rec[A-Za-z0-9]{14})\b", re.I)
PASS_TO_ROY_RE = re.compile(r"^\s*PASS TO ROY:", re.I)

# ─── ROY'S ASSISTANT (Kevin, 24 Sep 2026) ───────────────────────────────
# Roy forwards a message from info@agilelets.co.uk to itself with one line
# saying what he wants. scripts/roy-assistant.py reads it out of info@'s Sent
# folder, makes one "ROY:" task for Inbox Response and stamps ROY_REQUEST_MARK
# on its Notes. BOTH are required: the prefix alone is a name anyone can type,
# the stamp is written only after the message was read from the Sent folder.
# A Roy request is work FOR Roy, so it never goes back to him through the Roy
# lane, and every email to a tenant, contractor or agent is still a card in
# Kevin's one queue. Two shapes are Level A because nobody outside sees them:
# an answer to Roy (ROY ANSWER:) and a record of work logged for him (ROY
# DONE:), each emailed by roy-assistant.py to info@ only.
ROY_REQUEST_PREFIX = "ROY:"
ROY_REQUEST_MARK = "ROY REQUEST"
ROY_REQUEST_STAMP_RE = re.compile(r"— roy-assistant\] " + ROY_REQUEST_MARK + r"\b")
ROY_ANSWER_RE = re.compile(r"^\s*ROY ANSWER:", re.I)
ROY_DONE_RE = re.compile(r"^\s*ROY DONE:", re.I)
# The one Tenants field the assistant may write (roy-assistant.py tenant-note),
# and the stamp each line carries so ROY DONE can prove the line is its own.
TENANT_NOTES_FIELD = "fldfwxEf7I3XQDVtR"
ROY_TENANT_NOTE_TAG = "Roy's assistant, "


def is_roy_request(name, notes):
    """True for a task roy-assistant.py made from a message Roy sent."""
    return (str(name or "").startswith(ROY_REQUEST_PREFIX)
            and bool(ROY_REQUEST_STAMP_RE.search(str(notes or ""))))


# When Roy forwards a tenant's message, the same message has usually reached
# the board already through Inbox Triage (info@ mail is copied to the triage
# inbox). roy-assistant.py marks that open task with this line, and the queue
# holds it while Roy's request is open: one tenant, one card.
ROY_HANDLING_MARK = "ROY IS HANDLING THIS"
ROY_HANDLING_RE = re.compile(r"— roy-assistant\] " + ROY_HANDLING_MARK + r": (rec[A-Za-z0-9]{14})\b")


def roy_handling_lead(notes):
    """The Roy request holding this task (the newest mark), or ''."""
    found = ROY_HANDLING_RE.findall(str(notes or ""))
    return found[-1] if found else ""


def roy_done_problem(body, task_rec, fetch):
    """Why a ROY DONE: output cannot be trusted without a card, or ''.

    Every record it cites must be work done FOR this request: a task created
    after the request, a task whose Notes name the request, or a tenant whose
    Notes carry a line roy-assistant.py tenant-note wrote for it. A GET by
    record id ignores the table, so the record's own fields say which it is.
    """
    task_id = task_rec.get("id", "")
    created = task_rec.get("createdTime") or ""
    cited = [r for r in dict.fromkeys(re.findall(r"\brec[A-Za-z0-9]{14}\b", body or ""))
             if r != task_id]
    if not cited:
        return "ROY DONE names no record it created or changed"
    for rid in cited:
        try:
            rec = fetch(rid) or {}
        except Exception as exc:                          # noqa: BLE001
            return f"cited record {rid} could not be read ({str(exc)[:80]})"
        f = rec.get("fields", {}) or {}
        if not f:
            return f"cited record {rid} does not exist"
        if AF["name"] in f:
            if created and (rec.get("createdTime") or "") >= created:
                continue
            if task_id and task_id in str(f.get(AF["notes"]) or ""):
                continue
            return (f"cited task {rid} is older than this request and its Notes do not "
                    f"name {task_id}, so it is not work done for Roy")
        if f"{ROY_TENANT_NOTE_TAG}{task_id}]" in str(f.get(TENANT_NOTES_FIELD) or ""):
            continue
        return (f"cited record {rid} is neither a task made for this request nor a "
                "tenant note roy-assistant.py wrote for it")
    return ""

# No-card caps per statutory certificate booked through Roy (Kevin's tranche 3
# interview, 17 Sep 2026). A named exception to the £100 money rule for these
# four certificates only; the brain file Knowledge/property-compliance-
# requirements.md carries the ruling. certificate_type() reads the one type a
# task name is about (defined with the dispatch-time grouping).
CERT_SPEND_CAPS = {"GSC": 100, "EPC": 100, "EICR": 200, "FIRE": 200}


def certificate_booking_cap(name, output):
    """The no-card cap for a PASS TO ROY certificate booking, or 0."""
    if not PASS_TO_ROY_RE.match(output or ""):
        return 0
    if not str(name or "").startswith(COMPLIANCE_TASK_PREFIX):
        return 0
    return CERT_SPEND_CAPS.get(certificate_type(name), 0)


# ─── THE THREE NARROW LEVEL A SHAPES OF 17 SEP 2026 ─────────────────────
# Kevin's tranche 3 rulings, approved at the build gate the same day. Each is
# verified here; anything off-shape stays a card exactly as before.
REDIRECT_RE = re.compile(r"^\s*REDIRECT TO INFO@", re.I)
REDIRECT_LANE_RE = re.compile(r"\btenan(?:t|cy)\b|\blandlord\b|letting agent|\bagile lets\b", re.I)
TASK_PREFIX_STRIP_RE = re.compile(
    r"^\s*(?:(?:INBOUND|POST|CORRESPONDENCE|MAINTENANCE|COMPLIANCE)(?:\s*\([^)]*\))?\s*:\s*)+", re.I)
PLAN_INSTALMENT_RE = re.compile(r"^\s*CLOSE PROPOSAL:\s*plan instalment\b", re.I)
INSTALMENT_WORDS_RE = re.compile(
    r"direct debit|collected|instal+ment|payment (?:received|taken|collected)", re.I)
INSTALMENT_WARNING_RE = re.compile(
    r"miss|fail|arrear|default|increase|court|bailiff|final notice|overdue|"
    r"returned|bounced|cancel|reject|unpaid|enforcement", re.I)


def redirect_email(tf):
    """The fixed redirect email for an inbound task, or None without a sender address."""
    sender = re.search(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", str(tf.get(AF["inboundSender"]) or ""))
    if not sender:
        return None
    subject = TASK_PREFIX_STRIP_RE.sub("", str(tf.get(AF["name"]) or "")).strip()[:120]
    return (f"TO: {sender.group(0)}\nFROM: {PERSONAL_SENDER}\nSUBJECT: Re: {subject}\n---\n"
            f"{REDIRECT_BODY}")


def plan_instalment_evidence(name, desc, plans):
    """(why, plan): a Plan agreed page matching this creditor and collected amount, or (why, None)."""
    text = f"{name} {desc}"
    if INSTALMENT_WARNING_RE.search(text):
        return "a warning word is in the task, so it is not a routine instalment", None
    if not INSTALMENT_WORDS_RE.search(text):
        return "the task does not say a payment was collected", None
    amounts = set()
    for a in re.findall(r"(?:£|GBP\s?)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)", text, re.I):
        try:
            amounts.add(round(float(a.replace(",", "")), 2))
        except ValueError:
            continue
    for p in plans or []:
        creditor = str(p.get("creditor") or "").strip()
        if not creditor or creditor.lower() not in text.lower():
            continue
        if p.get("status") != "Plan agreed" or p.get("monthlyAmount") in (None, ""):
            continue
        if round(float(p["monthlyAmount"]), 2) in amounts:
            return (f"record book: {creditor} is Plan agreed at £{float(p['monthlyAmount']):,.2f}, "
                    "the amount collected"), p
    return "no Plan agreed page matches this creditor and amount", None


def spend_declared(output):
    """(amount, recurring) from a SPEND: line, or (None, False) when absent."""
    m = SPEND_LINE_RE.search(output or "")
    if not m:
        return None, False
    try:
        amount = float(m.group("amount").replace(",", ""))
    except ValueError:
        return None, False
    return amount, bool(m.group("recurring"))


def money_level(amount, recurring=False):
    """'log' | 'inform' | 'card' | 'kevin' for a declared commitment."""
    if amount is None:
        return "log"          # nothing declared, nothing to gate on
    if recurring:
        return "kevin"        # a subscription compounds; always his
    if amount < DECISION_MONEY["log"]:
        return "log"
    if amount <= DECISION_MONEY["inform"]:
        return "inform"
    return "card"


# The fold check shared with the creation gate and the Task Manager board:
# create-agent-task.py's dupe_verdict in "fold" mode (same fold lane first,
# reply vs maintenance only since Kevin's ruling of 15 Sep 2026, then a
# shared reference or enough shared non-address words). Imported, never
# copied, so the three callers can never drift apart.
_CAT_MOD = None


def _gate():
    global _CAT_MOD
    if _CAT_MOD is None:
        import importlib.util
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "create-agent-task.py")
        spec = importlib.util.spec_from_file_location("od_catask", p)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _CAT_MOD = mod
    return _CAT_MOD


def dupe_fold_verdict(name_a, name_b):
    """{match, why, shared}: may these two task names fold into one?"""
    return _gate().dupe_verdict(name_a, name_b, mode="fold")


def dupe_fold_lane(fields):
    """'maintenance' | 'reply' for a task record: the gate's fold_lane over
    the name, the Team Member links and the Maintenance Ticket tick."""
    return _gate().fold_lane(str(fields.get(AF["name"]) or ""),
                             links(fields.get(AF["teamMember"])),
                             bool(fields.get(AF["maintenanceTicket"])))


CLOSED_KEEPER_STATUSES = ("Completed", "Cancelled")


def decision_level(output, task_type, task_rec, fetch=None, agent_banner=None,
                   plans_fetch=None):
    """Which level this submission sits at, with the evidence VERIFIED.

    Returns a dict: level (A/B/C), category, carry ('close' | 'calendar' |
    'roy' | ''), evidence (what was checked, for the Notes stamp), why (for
    a card), money ('log' | 'inform' | 'card' | 'kevin'), amount, recurring.
    A duplicate fold also returns keeper (the record id verified) and
    tierChecked=True, which tells submit this category ran its own tier check.
    `fetch` is injectable so the tests never touch Airtable. `agent_banner`
    is whether the AGENT wrote the tier-1 banner: submit prepends the same
    banner itself whenever the Notes match a tier-1 pattern, so on the
    submit path the banner on `output` is not evidence; submit passes what
    it saw before the prepend. None (any other caller) reads the output.

    THE TIER CHECK FOR A CLOSE READS THE NAME AND DESCRIPTION, NEVER THE
    NOTES (Kevin, 15 Sep 2026). The Notes hold every agent's run log, and a
    log that once said "tier 1" or "restraint order" made every later
    duplicate close on that task a Level C card: rec5cIuxkG3CfSijF (a Pingen
    credits twin, correct wording, keeper older and open) reached Kevin for
    exactly that. Same fault class as the 14 Sep alert-lane bug. A tier-1
    signal on the twin ITSELF (its name, its description, or the banner the
    agent wrote) still allows the fold, but only when the keeper is open —
    the keeper is then the card Kevin sees — and the carry-out puts the
    twin's Agent Output on the keeper's Notes first, so nothing on the
    folded card is lost. Anything else tier-1 stays Level C.
    """
    fetch = fetch or get_task
    out = (output or "").strip()
    tf = task_rec.get("fields", {}) or {}
    task_id = task_rec.get("id", "")
    name = tf.get(AF["name"], "") or ""
    desc = tf.get(AF["description"], "") or ""
    notes = tf.get(AF["notes"], "") or ""
    amount, recurring = spend_declared(out)
    money = money_level(amount, recurring)
    # A statutory certificate booked through Roy has its own no-card cap
    # (Kevin, 17 Sep 2026): gas safety and EPC £100, EICR and fire safety
    # £200. One-off only: recurring stays Kevin's at any amount.
    cert_cap = certificate_booking_cap(name, out)
    if money == "card" and cert_cap and amount is not None and amount <= cert_cap:
        money = "inform"
    base = {"category": "other", "carry": "", "evidence": "", "money": money,
            "amount": amount, "recurring": recurring, "why": "",
            "certificateCap": cert_cap or None}

    def card(category, why):
        return {**base, "level": AUTONOMY_APPROVE, "category": category, "why": why}

    def act(category, carry, evidence, **extra):
        return {**base, "level": AUTONOMY_ACT, "category": category,
                "carry": carry, "evidence": evidence, **extra}

    def kevin_only(why):
        return {**base, "level": AUTONOMY_KEVIN, "category": "tier-1 matter", "why": why}

    # submit prepends the banner before this runs, so the close shapes are
    # matched on the body underneath it, and whether the banner is the
    # agent's own word comes from submit, not from the text.
    banner = TIER1_BANNER in out
    if agent_banner is not None:
        banner = bool(agent_banner)
    body = out
    if body.startswith(TIER1_BANNER):
        body = body[len(TIER1_BANNER):].strip()
    dup = CLOSE_DUPLICATE_RE.match(body)
    handled = CLOSE_HANDLED_RE.match(body)
    instalment = PLAN_INSTALMENT_RE.match(body)

    # The private matter never moves at Level A, whatever the shape — except
    # the two verifiable closes, whose tier check is the twin's own name,
    # description or banner (see the docstring), never its Notes.
    if dup or handled or instalment:
        tier_signal = tier_match(TIER1_PATTERNS, name, desc) or ("banner" if banner else "")
    else:
        hit = tier_match(TIER1_PATTERNS, name, desc, notes)
        if hit or TIER1_BANNER in out:
            return kevin_only(f"tier-1 matter ({hit or 'banner'}): Kevin only")
        tier_signal = ""
    if money == "kevin":
        return card("spend", f"SPEND £{amount:,.2f} recurring: a recurring "
                             "commitment is always Kevin's, whatever the amount")
    if money == "card":
        return card("spend", f"SPEND £{amount:,.2f} is over the money rule "
                             f"(£{DECISION_MONEY['inform']}): a card with the figure")

    if dup:
        keeper_id = dup.group(1)
        if keeper_id == task_id:
            return card("close: duplicate", "the keeper cited is this very task")
        try:
            keeper = fetch(keeper_id) or {}
        except Exception as exc:                          # noqa: BLE001
            return card("close: duplicate",
                        f"keeper {keeper_id} could not be read ({str(exc)[:80]})")
        kf = keeper.get("fields", {}) or {}
        if not kf:
            return card("close: duplicate", f"keeper {keeper_id} does not exist")
        kstatus = sel(kf.get(AF["status"])) or "?"
        if kstatus == "Cancelled":
            return card("close: duplicate", f"keeper {keeper_id} is Cancelled")
        keeper_open = kstatus not in CLOSED_KEEPER_STATUSES
        this_created = task_rec.get("createdTime") or ""
        keeper_created = keeper.get("createdTime") or ""
        kname_full = str(kf.get(AF["name"]) or "")
        kname = kname_full[:60]
        # A REPAIR TICKET AND A REPLY TASK ARE TWO OBLIGATIONS (28 Aug 2026,
        # restated 15 Sep 2026), whichever is older. Read off both RECORDS
        # (tick, Roy, then the name), because an unprefixed ticket reads as
        # a reply task by name alone.
        this_lane, keeper_lane = dupe_fold_lane(tf), dupe_fold_lane(kf)
        if this_lane != keeper_lane:
            return card("close: duplicate",
                        f"this is a {this_lane} task and keeper {keeper_id} is a "
                        f"{keeper_lane} task: a repair ticket and a reply task are two "
                        "obligations, never one, so folding may not cross that lane")
        # A DIFFERENT TENANT, HOUSE OR LINKED RECORD (28 Sep 2026), whichever
        # is older: the create gate refuses this fold (#621), so an agent's
        # close may not make it either. Same checks, imported from the gate.
        clash = _gate().links_disagree(tf, kf) or _gate().identity_conflict(name, kname_full)
        if clash:
            return card("close: duplicate",
                        f"keeper {keeper_id} is about a different tenant, house or record "
                        f"({clash}): two tenants or two houses are two matters, never one")
        kept = "kept the older task"
        if this_created and keeper_created and keeper_created > this_created:
            # Either creation order folds when BOTH are open and the fold
            # check reads the two names as one matter (Kevin, 15 Sep 2026:
            # rec2nZRQ1Y4ZXj9mA, the newer twin was the better draft). The
            # fold check is the guard: without it a newer keeper was a card.
            if not keeper_open:
                return card("close: duplicate",
                            f"keeper {keeper_id} is NEWER than this task and {kstatus}; "
                            "only an open newer task may keep")
            verdict = dupe_fold_verdict(name, kname_full)
            if not verdict.get("match"):
                return card("close: duplicate",
                            f"keeper {keeper_id} is NEWER than this task and the fold "
                            "check does not read the two names as one matter (same "
                            "lane, reply vs maintenance, then a shared reference or "
                            "enough shared non-address words); the older task keeps "
                            "and the newer one folds")
            kept = f"kept the NEWER task ({verdict.get('why') or 'fold check matched'})"
        evidence = (f"folded into keeper {keeper_id} \"{kname}\" ({kstatus}, "
                    f"created {keeper_created[:10] or '?'}); {kept}")
        if tier_signal:
            if not keeper_open:
                return kevin_only(f"tier-1 matter ({tier_signal}) and the keeper "
                                  f"{keeper_id} is {kstatus}, so no card would carry "
                                  "this twin's output: Kevin only")
            evidence += (f"; tier-1 twin ({tier_signal}): its Agent Output is carried "
                         "onto the keeper's Notes, the open task Kevin will see")
        return act("close: duplicate", "close", evidence,
                   keeper=keeper_id, tierChecked=True)

    if handled:
        if tier_signal:
            return kevin_only(f"tier-1 matter ({tier_signal}): Kevin only")
        cited = handled.group(1)
        if cited == task_id:
            return card("close: already handled", "the task cited is this very task")
        try:
            done = fetch(cited) or {}
        except Exception as exc:                          # noqa: BLE001
            return card("close: already handled",
                        f"cited task {cited} could not be read ({str(exc)[:80]})")
        df = done.get("fields", {}) or {}
        if not df:
            return card("close: already handled", f"cited task {cited} does not exist")
        dstatus = sel(df.get(AF["status"])) or "?"
        if dstatus != "Completed":
            return card("close: already handled",
                        f"cited task {cited} is {dstatus}, not Completed")
        dname = str(df.get(AF["name"]) or "")[:60]
        return act("close: already handled", "close",
                   f"already handled by Completed task {cited} \"{dname}\"",
                   tierChecked=True)

    if instalment:
        try:
            plans = (plans_fetch or fetch_plans)()
        except Exception as exc:                          # noqa: BLE001
            return card("close: plan instalment",
                        f"the record book could not be read ({str(exc)[:80]})")
        why, plan = plan_instalment_evidence(name, desc, plans)
        if not plan:
            return card("close: plan instalment", why)
        return act("close: plan instalment", "close", why, tierChecked=True)

    if body.upper().startswith("CLOSE PROPOSAL:"):
        return card("close: judgement",
                    "no verifiable evidence cited: a duplicate names its keeper "
                    "(CLOSE PROPOSAL: duplicate of recXXX), an already-handled close "
                    "names the Completed task (CLOSE PROPOSAL: already handled — see recXXX)")

    if REDIRECT_RE.match(body):
        if tier_signal or tier_match(TIER1_PATTERNS, name, desc, notes):
            return card("redirect reply", "tier 1 is never redirected")
        if not tf.get(AF["inboundTask"]):
            return card("redirect reply", "only an inbound task is redirected")
        if not (property_match(name, desc, notes) or roy_match(name, desc, notes)
                or REDIRECT_LANE_RE.search(name)):
            return card("redirect reply", "the task is not property mail")
        email = redirect_email(tf)
        if not email:
            return card("redirect reply", "the task has no inbound sender address")
        problem = rule_send_problem("redirect", parse_email_output(email),
                                    {"name": name, "notes": notes,
                                     "inboundSender": tf.get(AF["inboundSender"]),
                                     "taskType": "Correspondence"}, require_stamp=False)
        if problem:
            return card("redirect reply", problem)
        return act("redirect reply", "send-rule",
                   "property mail at Kevin's Gmail, fixed redirect to info@agilelets.co.uk "
                   "(Kevin, 17 Sep 2026)", rule="redirect", email=email)

    if (task_type == "Correspondence" and str(name).startswith(COMPLIANCE_TASK_PREFIX)
            and certificate_type(name) in CERT_SPEND_CAPS):
        try:
            mail = parse_email_output(out)
        except EmailFormatError:
            mail = None
        if mail and "quote" in (mail.get("subject") or "").lower():
            problem = rule_send_problem("quote-request", mail,
                                        {"name": name, "notes": notes,
                                         "taskType": "Correspondence"}, require_stamp=False)
            if not problem:
                return act("quote request", "send-rule",
                           f"{certificate_type(name)} quote request, coverage checked, from "
                           "info@ signed Roy Lavin (Kevin, 17 Sep 2026)", rule="quote-request")

    roy_answer, roy_done = ROY_ANSWER_RE.match(body), ROY_DONE_RE.match(body)
    if roy_answer or roy_done:
        cat = "roy answer" if roy_answer else "roy work logged"
        if not is_roy_request(name, notes):
            return card(cat, "only a request Roy sent from info@ (a ROY: task carrying the "
                             "roy-assistant stamp) is answered to Roy without a card")
        if task_type == "Correspondence":
            return card(cat, "an answer to Roy is not an email to anyone else: submit it "
                             "as Research or Admin")
        if roy_done:
            problem = roy_done_problem(body, task_rec, fetch)
            if problem:
                return card(cat, problem)
            return act(cat, "close", "work logged for Roy's request, every cited record "
                                     "verified; roy-assistant.py emails the receipt to info@ only")
        return act(cat, "close", "an answer for Roy's own request; roy-assistant.py emails it "
                                 "to info@agilelets.co.uk only, nobody outside sees it")

    if PASS_TO_ROY_RE.match(out):
        why = roy_match(name, desc, notes)
        if not why and cert_cap:
            # roy_match knows repairs and EICR but not gas safety, EPC or fire
            # certificates; Kevin's 17 Sep ruling puts all four bookings with
            # Roy. The same veto still applies to the whole text.
            everything = " ".join(str(t or "") for t in (name, desc, notes))
            if not (ROY_EXCLUDE_RE.search(everything) or ROY_HOME_RE.search(everything)):
                why = f"statutory {certificate_type(name)} booking (Kevin, 17 Sep 2026)"
        if not why:
            return card("pass to Roy",
                        "the task NAME does not match the property lane, or a veto "
                        "word is present (money, law, insurance, mortgage, sale, "
                        "Kevin's own home)")
        return act("pass to Roy", "roy", f"name matched {why!r}, nothing vetoed; "
                                        "Roy's standing approval")

    if task_type == "Admin" and out.upper().startswith("CALENDAR:") \
            and not calendar_submit_problem(out, task_type):
        return act("calendar entry", "calendar",
                   "a diary entry, no attendees; calendar-write.py refuses a past time")

    return card("other", "a card by default")


# How much of a folded twin's Agent Output rides onto the keeper. The fold
# overwrites the twin's own Agent Output with the close proposal, so this
# copy is the only one left of a draft Kevin never saw. Notes cap at 90,000.
FOLD_CARRY_MAX = 20000


def carry_output_to_keeper(twin_id, twin_fields, keeper_id, stamp):
    """Put the twin's stored Agent Output (or, failing that, its description)
    on the keeper's Notes BEFORE the twin closes. Returns the block written.
    A failure here raises, so the twin stays open with no marker: nothing is
    folded until its unique lines are safe on the keeper."""
    stored = str(twin_fields.get(AF["agentOutput"]) or "").strip()
    desc = str(twin_fields.get(AF["description"]) or "").strip()
    twin_name = str(twin_fields.get(AF["name"]) or "")[:80]
    # Without the trial key line: the keeper is another matter and must not become a trial task.
    carried = strip_trial_marks(stored or desc).strip()
    label = "Its Agent Output" if stored else ("Its description" if desc else "It had no output")
    if len(carried) > FOLD_CARRY_MAX:
        carried = carried[:FOLD_CARRY_MAX] + "\n[… cut at %d characters]" % FOLD_CARRY_MAX
    block = (f"[{stamp} — agent-dispatch] FOLDED {twin_id} \"{twin_name}\" into this task "
             f"at Level A. {label}, carried here so nothing on the folded card is lost:"
             + ("\n" + carried if carried else ""))
    keeper = get_task(keeper_id)
    existing = str((keeper.get("fields", {}) or {}).get(AF["notes"]) or "").rstrip()
    if f"FOLDED {twin_id} " in existing:
        # A retry after the twin's own close failed: the block is already
        # there, and a second copy would only pad the keeper's Notes.
        return ""
    patch_task(keeper_id, {AF["notes"]: (existing + "\n\n" + block).strip()[-90000:]})
    return block


def handle_without_kevin(args, output, task_rec, level, attached):
    """Carry a Level A submission out at submit and leave the marker.

    The marker is the safety: the page's "Handled without you" lane and the
    08:00 message both read it, and a close reverses from that lane. A
    carry-out that cannot leave its marker is refused, not assumed.
    """
    tf = task_rec.get("fields", {}) or {}
    stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
    inform = level["money"] == "inform"
    note = (f"[{stamp} — agent-dispatch] {HANDLED_MARK} ({level['category']}): "
            f"{level['evidence']}. Level A, Kevin's ruling 7 Sep 2026."
            + (f" SPEND £{level['amount']:,.2f}: named in the 08:00 message."
               if inform else "")
            + " Reverse it within 24 hours from Check these → Handled without you.")
    existing = str(tf.get(AF["notes"]) or "").rstrip()
    fields = {
        AF["agentOutput"]: output[:95000],
        AF["taskType"]: args.type,
        AF["teamMember"]: [args.agent],
        AF["sentForApprovalBy"]: [],
        AF["approvalOutcome"]: None,
        AF["approvalFeedback"]: None,
        AF["approvedAt"]: None,
        AF["notes"]: (existing + "\n\n" + note).strip()[-90000:],
        **plain_summary_fields(args),
    }
    carry = level["carry"]
    status = None
    if carry == "close":
        keeper_id = level.get("keeper")
        if keeper_id:
            # The twin's unique lines go onto the keeper FIRST; the close
            # below overwrites the twin's Agent Output with the proposal.
            carry_output_to_keeper(args.task, tf, keeper_id, stamp)
            fields[AF["notes"]] = (existing + "\n\n" + note + " Its Agent Output was "
                                   f"carried onto keeper {keeper_id}'s Notes.").strip()[-90000:]
        fields.update({AF["status"]: "Completed", AF["completion"]: now_iso(),
                       AF["assignee"]: None})
        patch_task(args.task, fields)
        status = "Completed"
    elif carry == "roy":
        patch_task(args.task, fields)
        cmd_handover(argparse.Namespace(
            task=args.task, to=ROY_EMAIL,
            reason=f"PASS TO ROY at Level A: {level['evidence']}"))
        status = sel((get_task(args.task).get("fields", {}) or {}).get(AF["status"]))
    elif carry == "calendar":
        patch_task(args.task, fields)       # the marker first: calendar-write checks it
        proc = subprocess.run(
            [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                          "calendar-write.py"),
             "create", args.task, "--handled"],
            capture_output=True, text=True)
        if proc.returncode != 0:
            # The diary write failed, so there IS a decision now: fall back to
            # the card rather than pretend. Kevin sees why on the task.
            err = (proc.stderr or proc.stdout or "").strip()[-300:]
            patch_task(args.task, {
                AF["status"]: "Approval",
                AF["sentForApprovalBy"]: [args.agent],
                AF["assignee"]: {"email": KEVIN_AIRTABLE_EMAIL},
                AF["dueDate"]: today_london(),
                AF["notes"]: (existing + "\n\n" + note + "\n\n"
                              f"[{stamp} — agent-dispatch] The diary write FAILED, so this "
                              f"went to the queue instead: {err}").strip()[-90000:],
            })
            print(json.dumps({"submitted": args.task, "handled": False,
                              "fellBackToCard": True, "level": AUTONOMY_APPROVE,
                              "error": err}))
            return 0
        patch_task(args.task, {AF["status"]: "Completed", AF["completion"]: now_iso()})
        status = "Completed"
    elif carry == "send-rule":
        # A sent email cannot be reversed: the named exception to Level A's
        # 24-hour reverse (Kevin, 17 Sep 2026). send-email.py re-checks the
        # stored task against the same rule and refuses anything else, in which
        # case the task falls back to a card, exactly like a failed diary write.
        rule = level["rule"]
        if level.get("email"):
            fields[AF["agentOutput"]] = level["email"]
        fields[AF["taskType"]] = "Correspondence"
        fields[AF["notes"]] = (fields[AF["notes"]] + f" {RULE_STAMP}: {rule}.")[-90000:]
        patch_task(args.task, fields)
        proc = subprocess.run(
            [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                          "send-email.py"),
             "send", args.task, "--rule", rule],
            capture_output=True, text=True)
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "").strip()[-300:]
            patch_task(args.task, {
                AF["status"]: "Approval",
                AF["sentForApprovalBy"]: [args.agent],
                AF["assignee"]: {"email": KEVIN_AIRTABLE_EMAIL},
                AF["dueDate"]: today_london(),
                AF["notes"]: (fields[AF["notes"]] + "\n\n"
                              f"[{stamp} — agent-dispatch] The rule send was REFUSED, so this "
                              f"went to the queue instead: {err}").strip()[-90000:],
            })
            print(json.dumps({"submitted": args.task, "handled": False,
                              "fellBackToCard": True, "level": AUTONOMY_APPROVE,
                              "error": err}))
            return 0
        if rule == "quote-request":
            # The renewal is not done when the quotes are asked for: it rests
            # a week (the letting-agent chase window) and flips back to Today.
            due = (datetime.now(LONDON).date() + timedelta(days=7)).isoformat()
            patch_task(args.task, {AF["status"]: "Upcoming", AF["dueDate"]: due})
            status = "Upcoming"
        else:
            patch_task(args.task, {AF["status"]: "Completed", AF["completion"]: now_iso()})
            status = "Completed"
    else:
        sys.exit(f"ERROR: Level A category {level['category']!r} has no carry-out")

    check = get_task(args.task).get("fields", {}) or {}
    if HANDLED_MARK not in str(check.get(AF["notes"]) or ""):
        sys.exit(f"ERROR: Level A carry-out of {args.task} left NO marker in Notes — "
                 "the action may have happened with nothing to show Kevin. "
                 "Reopen the task by hand and check.")
    ledger_append(args.task, "handled")
    print(json.dumps({"submitted": args.task, "handled": True, "level": AUTONOMY_ACT,
                      "category": level["category"], "carry": carry,
                      "evidence": level["evidence"], "inform": inform,
                      "attached": len(attached), "status": status}))
    return 0


# Kevin's ruling, 4 Sep 2026 (fix 2 of the approval-gate work): an output that
# tells him to log in somewhere and do the job himself is not prepared work,
# it is a to-do list with his name on it. Measured over 14 days, 37 outputs
# did exactly that ("Log into the HL account", "Kevin must log into pingen.com
# and click Send"). The two sanctioned routes: do it in the agent browser
# (allowlisted site, Kevin's session in the profile), or hand back the ONE
# line the Robot sign-in app understands — "SIGN-IN NEEDED: <site>" — which
# costs him a tap, not a task. Phone calls are never his step (ADHD rule).
# Two patterns, applied by Task Type (second review, 4 Sep 2026): a letter or
# email BODY legitimately tells its recipient "you must log in to the portal to
# pay", so on Correspondence only the explicit-Kevin forms count; "you" means
# Kevin only in the report types, where the agent is talking to him.
HANDBACK_KEVIN_RE = re.compile(
    r"\bKevin\s+(?:must|need(?:s)?\s+to|should|will\s+(?:need|have)\s+to|ha(?:s|ve)\s+to|to)\s+"
    r"(?:manually\s+)?(?:log\s*in(?:to)?|sign\s*in(?:to)?|login|call|phone|ring)\b"
    r"|\bneeds\s+Kevin\s+to\s+(?:manually\s+)?(?:log|sign)\s*in(?:to)?\b"
    r"|\bKevin\s*[,:\-–—]+\s*(?:please\s+)?(?:manually\s+)?(?:log|sign)\s*in(?:to)?\b"
    r"|\b(?:next\s+step|action|to[- ]do)\s+for\s+Kevin\s*[:\-–—]\s*(?:please\s+)?(?:log|sign)\s*in(?:to)?\b"
    r"|\bKEVIN\s+ACTION\s*:\s*(?:please\s+)?(?:log|sign|call|phone|ring)\b"
    # The carry-out line's own grammar (8 Sep 2026, five live cards): "Kevin
    # logging into Google AdSense and completing tax information", "Kevin
    # signing into TopCashback, clicking ... and buying", "Kevin calling EE on
    # 150". Gerunds slipped past every form above.
    # Review, same day: "signing in wet ink", "calling it off" and "calling the
    # meeting to order" must pass, so a sign-in needs a site preposition and a
    # phone verb needs a named party or a number after it.
    r"|\bKevin\s+(?:manually\s+)?(?:logging\s+in(?:to)?|signing\s+into|signing\s+in\s+(?:to|at|on))\b"
    r"|\bKevin\s+(?:calling|phoning|ringing)\s+(?=(?-i:[A-Z0-9]))",
    re.I,
)
HANDBACK_YOU_RE = re.compile(
    r"\byou(?:'ll|\s+will)?\s+(?:must|need(?:s)?\s+to|should|ha(?:s|ve)\s+to)\s+"
    r"(?:manually\s+)?(?:log\s*in(?:to)?|sign\s*in(?:to)?|login|call|phone|ring)\b"
    r"|\byou'?ll\s+need\s+to\s+(?:manually\s+)?(?:log|sign)\s*in(?:to)?\b"
    r"|^\s*(?:Kevin\s*[,:\-–—]*\s*)?(?:please\s+)?(?:manually\s+)?(?:log|sign)\s*in(?:to)?\s+(?:to\s+)?"
    r"(?:your|the)\s+[\w.' -]{2,40}?\s+(?:account|portal|dashboard|app|website|site)\b",
    re.I | re.M,
)
SIGNIN_NEEDED_RE = re.compile(r"^\s*SIGN-IN NEEDED:\s*\S", re.I | re.M)

# THE WORK HAND-OFF (Kevin, 25 Sep 2026). The 4 Sep rule above refuses a
# LOGIN handed to Kevin. It never saw the work itself being handed over, and
# that is how the Swinton policy renewed: the closing line of recc2fdXwsHLMAKU3
# read "Kevin visiting TopCashback.co.uk ... and completing an online quote",
# he approved, there was nothing for an agent to carry out, and the task closed
# with no quote. Two more that month: "so someone can get three price quotes"
# (6 Chedburgh Place, no policy on record) and "You'd still need to get the
# Everywhen insurance quote yourself". Read on the CLOSING LINE only, because
# that is the promise his approval buys.
#
# Back-tested on the 765 outputs written 26 Aug to 25 Sep 2026: 48 closing lines
# matched the first draft and Kevin had rejected 18 of those himself. Three
# shapes were false alarms and are excluded: "for you to open and check" (a
# draft left for review, the Content Engine's test cards), "Kevin needs to
# decide" (a decision IS his), and a bare "yourself" ("you already pay this
# yourself").
#
# A step that really is Kevin's is DECLARED, never implied, with one line the
# code can read, and that line opens a KEVIN blocker, so the task cannot close
# until the agent sees proof the step happened:
#
#     KEVIN ONLY: <payment|purchase|signature|credential|identity|physical>: <the step>
WORK_HANDOFF_RE = re.compile(
    r"\b(?:you|kevin)(?:'d|\s+would|\s+will)?\s+(?:still\s+|also\s+|then\s+)?(?:need|needs|have|has)\s+to\s+"
    r"(?!decide\b|choose\b|pick\b|approve\b|say\b|tell\b|confirm\s+(?:which|whether)\b)"
    r"|\b(?:do|pay|get|sign|book|call|arrange|file|submit|obtain|complete|buy|renew|cancel|chase|source|research|sort)\b"
    r"[^.\n]{0,40}\byourself\b"
    r"|\bkevin\s+(?:manually\s+)?(?:visiting|going|logging|getting|obtaining|completing|buying|paying|signing|filing"
    r"|sourcing|researching|chasing|booking|cancelling|renewing|setting\s+up)\b"
    r"|\bkevin\s+(?:must|should|will\s+need|can\s+then|then)\b"
    r"|\b(?:someone|somebody)\s+(?:can|could|to|will|should|must|needs?)\b"
    r"|\bfor\s+(?:kevin|you)\s+to\s+(?:visit|get|obtain|complete|sign|pay|buy|call|phone|chase|book|log|arrange"
    r"|research|contact|source|file|renew|cancel)\b",
    re.I)
KEVIN_ONLY_LINE_RE = re.compile(
    r"^\s*\**KEVIN ONLY:\**\s*(?P<reason>[A-Za-z]+)\s*[:\-–]\s*(?P<step>\S[^\n]*)$", re.M)


# What each KEVIN ONLY reason lets the closing line hand him. A declared step
# covers ITS OWN verb and nothing else: "KEVIN ONLY: purchase" lets the line say
# he buys the policy, never that he gets the quote (review, 25 Sep 2026: the
# first version let any valid line switch the whole check off). "visit" is on
# no list, because "Kevin visiting TopCashback" is the Swinton failure itself.
KEVIN_REASON_WORDS = {
    "payment": r"pay|pays|paying|paid|payment|direct\s+debit|DD|standing\s+order|transfer|settle",
    "purchase": r"buy|buys|buying|purchase|purchasing|pay|pays|paying",
    "signature": r"sign|signs|signing|signature|countersign",
    "credential": r"log\s*in|logging|sign\s*in|signing\s+in|password|passcode|card|consent|re-?consent|authori[sz]e",
    "identity": r"verify|verifies|verifying|verification|identity|ID|passport",
    "physical": r"attend|collect|deliver|meet|hand\s+over",   # posting a letter is agent work (Pingen)
}


def work_handoff_problem(output, kevin_step=None):
    """The closing-line words that hand the job to Kevin or 'someone'; ''.
    With a valid declared KEVIN ONLY step, a hand-off whose phrase or next two
    words name that step's own verb is allowed; any other hand-off in the same
    line, and any "someone", is still refused."""
    tail = carry_out_tail((output or "").strip())
    words = None
    if kevin_step and not kevin_step.get("invalid"):
        words = re.compile(r"\b(?:%s)\b" % KEVIN_REASON_WORDS[kevin_step["reason"]], re.I)
    for m in WORK_HANDOFF_RE.finditer(tail):
        # "you already pay this card's minimum yourself" describes, it does
        # not hand over (the one false alarm left in the 765-output back-test).
        if re.search(r"\balready\b", tail[max(0, m.start() - 20): m.end()], re.I):
            continue
        if words and not re.match(r"some(?:one|body)", m.group(0), re.I):
            # The phrase itself or its next two words ("Kevin then pays", "for
            # Kevin to sign"), never a verb further on: "someone can get three
            # quotes for Kevin to look at and buy" is still the quotes handed
            # over (second review). "someone" is never Kevin's declared step.
            after = re.match(r"\s*(\S+(?:\s+\S+)?)", tail[m.end():])
            if words.search(m.group(0) + " " + (after.group(1) if after else "")):
                continue
        return tail[max(0, m.start() - 50): m.end() + 60].strip()
    return ""


def kevin_only_step(output):
    """The declared KEVIN ONLY step as {reason, step[, invalid]}, or None."""
    m = KEVIN_ONLY_LINE_RE.search(output or "")
    if not m:
        return None
    step = {"reason": m.group("reason").lower(), "step": " ".join(m.group("step").split())[:300]}
    if step["reason"] not in KEVIN_ONLY_REASONS:
        step["invalid"] = True
    return step


def handback_problem(output, task_type=""):
    """Reason this output hands Kevin a job instead of doing it; '' if none.

    On Correspondence the text after the headers is the message to its
    recipient, so only the forms that name Kevin count there.
    """
    text = (output or "")
    m = HANDBACK_KEVIN_RE.search(text)
    if not m and task_type != "Correspondence":
        m = HANDBACK_YOU_RE.search(text)
    if not m:
        return ""
    end_ = text.find("\n", m.end())
    line = text[text.rfind("\n", 0, m.start()) + 1: end_ if end_ != -1 else len(text)]
    return line.strip()[:160]


# THE PLAIN SUMMARY (Kevin, 22 Sep 2026): "too much information, difficult to
# decipher". Every card opens with what the task is and what approving does,
# each in one short sentence a thirteen-year-old understands. The agent writes
# both at submit (--plain-task, --plain-approve); the card shows them first.
PLAIN_MIN, PLAIN_MAX = 15, 200
PLAIN_MARKUP_RE = re.compile(r"[*`|]|\[[^\]]*\]\(|^#")


def plain_summary_problem(task_line, approve_line):
    """Reason the two plain lines cannot go on Kevin's card; empty if fine."""
    for flag, line in (("--plain-task", task_line), ("--plain-approve", approve_line)):
        text = str(line or "").strip()
        if not text:
            return f"{flag} is empty"
        if "\n" in text or "\r" in text:
            return f"{flag} must be one line"
        if len(text) < PLAIN_MIN:
            return f"{flag} is too short to explain anything ({len(text)} characters)"
        if len(text) > PLAIN_MAX:
            return (f"{flag} is {len(text)} characters; keep it under {PLAIN_MAX}. "
                    "One short sentence, not a report")
        jargon = JARGON_RE.search(text)
        if jargon:
            return (f"{flag} contains '{jargon.group(0)}'. That is machine detail. "
                    "Say it the way you would to a thirteen-year-old")
        if PLAIN_MARKUP_RE.search(text):
            return f"{flag} contains formatting (*, `, |, a leading # or a link). Plain words only"
    return ""


def plain_summary_text(task_line, approve_line):
    return f"TASK: {task_line.strip()}\nIF YOU APPROVE: {approve_line.strip()}"


def plain_summary_fields(args):
    """The Plain Summary write for every patch a submit makes. Every path,
    not only the card: a Level A action that falls back to a card, or a task
    filed now and reopened later, must never show a previous round's lines.
    Empty for an internal caller that never had the flags."""
    t, a = getattr(args, "plain_task", None), getattr(args, "plain_approve", None)
    if t is None or a is None:
        return {}
    return {AF["plainSummary"]: plain_summary_text(t, a)}


def carry_out_problem(output, strict=True):
    """Reason the approval box would have to guess this output's summary.

    Empty string means the output is fine. See CARRY_OUT_MARKER above.
    """
    text = (output or "").strip()
    if len(text) < SUMMARY_MIN_CHARS:
        return ""
    matches = list(CARRY_OUT_RE.finditer(text))
    if not matches:
        return "it has no '%s' line" % CARRY_OUT_MARKER
    tail = text[matches[-1].end():].strip()
    if not tail:
        return "its '%s' line says nothing" % CARRY_OUT_MARKER
    jargon = JARGON_RE.search(tail) if strict else None
    if jargon:
        return ("its '%s' line contains '%s' — that is machine detail, not "
                "plain English. Kevin reads this line to decide WHETHER the "
                "action happens, not how it is done. Write it so a "
                "thirteen-year-old understands: say 'sending the email to "
                "Fylde Council', never 'via scripts/send-email.py' or a "
                "record id" % (CARRY_OUT_MARKER, jargon.group(0)))
    if len(tail) > CARRY_OUT_TAIL_MAX:
        return ("its '%s' line is not the CLOSING line — keep what follows it "
                "under %d characters; yours is %d. The approval box shows only "
                "the first %d, so anything past that is invisible to Kevin"
                % (CARRY_OUT_MARKER, CARRY_OUT_TAIL_MAX, len(tail),
                   CARRY_OUT_TAIL_MAX))
    return ""


# ─── AN OUTPUT THAT PROMISES A SEND MUST BE Correspondence ───────────
#
# 18 Aug 2026, finding 20260818-agent-dispatch-203. Tasks went in as
# `--type Drafting` with a closing line saying the email would be sent from
# Kevin's Gmail. Kevin read that line, approved it, and send-email.py then
# refused the carry-out: "This script only sends Correspondence."
#
# The contract is free to fix at DRAFT time and expensive at carry-out time,
# because by then Kevin has already made a decision on a promise the machine
# cannot keep. So it is checked here, at submit, where the fix costs one retry.
#
# Deliberately matched on the CLOSING line only, not the whole document: an
# analysis that discusses emailing somebody is not a promise to send one.
#
# Widened 25 Sep 2026 (finding 20260923-agent-dispatch-586). Three approved
# cards typed Admin or Analysis promised an email this pattern did not read,
# so each was approved and then could never be sent: "sending the
# ACKNOWLEDGEMENT reply" (a word between the article and the noun, the PIB
# renewal), "then it goes to the council" (Siddows Avenue) and "the response
# being sent by email" (LCS). Back-tested on the 765 closing lines of 26 Aug to
# 25 Sep 2026: 5 matches before, 20 after, 14 of them cards Kevin rejected and
# the approved ones exactly the stuck three plus one. What stays out, tested on
# the same data: a send only denied or described ("no response will be sent",
# "without sending any reply", "before being sent", "whether Roy sends", "which
# sends" another task's email) and a message that is not email (iMessage, SMS).
SEND_LANGUAGE_RE = re.compile(
    r"\b(?:"
    r"send(?:s|ing)?\s+(?:the\s+|this\s+|an?\s+|one\s+|that\s+)?(?:[\w'-]+\s+){0,2}?"
    r"(?:email|e-mail|letter|reply|response|message)s?"
    r"|email(?:s|ing)?\s+(?:it|the|this|them|him|her)"
    r"|from\s+Kevin'?s\s+Gmail"
    r"|sent\s+(?:from|to)\s+[^\s@]+@[^\s@]+"
    r"|(?:it|the\s+(?:email|reply|letter|response|message))\s+(?:then\s+)?goes\s+(?:out\s+)?to"
    # the passive only with an email noun: "the invoice will be sent by the
    # supplier" is not our send (second review, 25 Sep 2026)
    r"|(?:email|e-mail|reply|letter|response|message)s?\s+(?:is\s+|will\s+be\s+|being\s+|gets?\s+|then\s+)?sent\b"
    r")", re.I)
# Words that deny or describe a send rather than promise one. NOT "before" or
# "or": "checking the balance before sending the reply" and "updating the
# record or sending the reply" are promises, and the second review found the
# first version letting both through. ("before being sent", a gate being
# described, no longer matches at all: the passive needs an email noun.)
NOT_A_SEND_BEFORE_RE = re.compile(r"\b(?:no|not|nothing|never|without|whether|which)\b[^.;]{0,30}$", re.I)
NOT_EMAIL_RE = re.compile(r"\b(?:iMessage|SMS|text\s+message|WhatsApp|osascript)\b", re.I)
CLAUSE_SPLIT_RE = re.compile(r"[.;,]|\band\b|\bthen\b", re.I)


def send_language_hit(closing):
    """The first words of a closing line that promise an EMAIL send, or None.
    A message that is not email is judged in its own clause only: "a text
    message to Roy and sending the email to the council" still promises an
    email (second review)."""
    closing = closing or ""
    for m in SEND_LANGUAGE_RE.finditer(closing):
        before = closing[max(0, m.start() - 40): m.start()]
        if NOT_A_SEND_BEFORE_RE.search(before):
            continue
        # "this chase task closes WHEN that email is sent": a condition on
        # someone else's send, not a promise of ours (the passive form only).
        if m.group(0).lower().endswith("sent") and re.search(r"\b(?:when|once|until|after)\b[^.;]{0,20}$", before, re.I):
            continue
        starts = [0] + [x.end() for x in CLAUSE_SPLIT_RE.finditer(closing) if x.end() <= m.start()]
        ends = [x.start() for x in CLAUSE_SPLIT_RE.finditer(closing) if x.start() >= m.end()] + [len(closing)]
        if NOT_EMAIL_RE.search(closing[max(starts): min(ends)]):
            continue
        return m
    return None


def send_promise_problem(output, task_type):
    """Reason this output promises a send its Task Type cannot deliver.

    Empty string means fine. Only the closing line is read, and only when the
    type is not Correspondence — the type that send-email.py will accept.
    """
    if task_type == "Correspondence":
        return ""
    text = (output or "").strip()
    m = None
    for hit in CARRY_OUT_RE.finditer(text):
        m = hit
    if m is None:
        return ""
    closing = text[m.end():].strip()
    if not closing or len(closing) > CARRY_OUT_TAIL_MAX:
        return ""
    found = send_language_hit(closing)
    if not found:
        return ""
    return ("its closing line promises to send something (%r) but the Task Type "
            "is %s, and scripts/send-email.py only sends Correspondence"
            % (found.group(0), task_type or "(empty)"))


def tier_match(patterns, *texts):
    hay = " ".join(str(t or "") for t in texts)
    for p in patterns:
        if p.search(hay):
            return p.pattern
    return ""


EPISODE_CARD_PREFIX = "CONTENT: Publish Episode "   # content-engine/approval.py task_name; see cmd_escalate


def own_go_signal(agent_id):
    """True for a role agent that runs on its own schedule (`dispatch: False`): its approved and sent-back cards are
    handled by its own job, never carried out by a dispatched run."""
    return bool(agent_id) and agent_id in ROLE_AGENTS and not ROLE_AGENTS[agent_id].get("dispatch", True)


def note_with_verdict(history, approved_at):
    """True when Kevin typed words with his newest verdict. Both pages archive a note into Feedback
    History as "[YYYY-MM-DD HH:MM] <note>", stamped from the same clock reading as Approved At, so
    the newest block carries that minute only when the verdict came with words."""
    stamp = str(approved_at or "")[:16].replace("T", " ")
    stamps = re.findall(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]", str(history or ""), re.M)
    return len(stamp) == 16 and bool(stamps) and stamps[-1] == stamp


def task_view(rec):
    f = rec.get("fields", {})
    agent_id = links(f.get(AF["sentForApprovalBy"]))[:1] or links(f.get(AF["teamMember"]))[:1]
    agent_id = agent_id[0] if agent_id else ""
    return {
        "id": rec["id"],
        "name": f.get(AF["name"], "(Untitled)"),
        "description": f.get(AF["description"], ""),
        "notes": f.get(AF["notes"], ""),
        "status": sel(f.get(AF["status"])),
        "dueDate": f.get(AF["dueDate"], ""),
        "priority": sel(f.get(AF["priority"])),
        "urgencyScore": f.get(AF["urgencyScore"]) or 0,
        "outcome": sel(f.get(AF["approvalOutcome"])),
        "approvedAt": f.get(AF["approvedAt"], ""),
        # Expanded here so a REDO gets the spoken instruction, not a bare URL.
        # No Loom link means no network call — this is a regex miss on almost
        # every task.
        "feedback": expand_looms(f.get(AF["approvalFeedback"], "")),
        "noteWithVerdict": note_with_verdict(f.get(AF["feedbackHistory"]), f.get(AF["approvedAt"])),
        # The date of his newest "I can't do this step" (standing_holds.approved_after_start).
        "cantAt": standing_holds.latest_cant(f.get(AF["feedbackHistory"])),
        "agentOutput": f.get(AF["agentOutput"], ""),
        "taskType": sel(f.get(AF["taskType"])),
        "teamMemberIds": links(f.get(AF["teamMember"])),
        "sentForApprovalByIds": links(f.get(AF["sentForApprovalBy"])),
        "approverEmail": (f.get(AF["approver"]) or {}).get("email", ""),
        "agentId": agent_id,
        "agentName": ALL_AGENTS.get(agent_id, {}).get("name", ""),
        "localAgent": ALL_AGENTS.get(agent_id, {}).get("agent", ""),
        "agentRole": ALL_AGENTS.get(agent_id, {}).get("role", ""),
        "inboundTask": bool(f.get(AF["inboundTask"])),
        "inboundSourceType": sel(f.get(AF["inboundSourceType"])),
        "inboundSender": f.get(AF["inboundSender"], ""),
        "attachments": [
            {"filename": a.get("filename", ""), "url": a.get("url", "")}
            for a in (f.get(AF["attachments"]) or [])
        ],
    }


def sort_key(t):
    return (t["status"] != "Overdue", t["dueDate"] or "9999",
            -float(t["urgencyScore"] or 0))


# ─── QUEUE ────────────────────────────────────────────────────────────

def load_standing_holds():
    """(holds, error). An unreadable holds file must not stop the queue: the
    30-minute `standing_holds.py run` parks held tasks on the board itself, so
    this read is the belt for the gap between a task arriving and that run.
    The error rides in the queue JSON, never silently."""
    try:
        return standing_holds.load_holds(), ""
    except Exception as exc:  # noqa: BLE001 — any failure is the same story
        return [], str(exc)[:200]


def build_queue(args=None):
    """Classify the open board. Returns the queue dict, prints nothing.

    Split out of cmd_queue on 28 Aug 2026 so `handover-property` classifies
    with the SAME code the run reads. Two classifiers would be two answers to
    "is this Roy's", and the one that writes must be the one Kevin saw.
    """
    open_tasks = [task_view(r) for r in query_tasks(QUEUE_FORMULA)]

    # The register roster is context for the CEO's routing judgement. A blip
    # here must not silently starve role agents run after run, so the error
    # rides in the queue JSON where the report (and Kevin's page) can see it.
    role_roster, role_roster_error = {}, ""
    try:
        role_roster = fetch_role_roster()
        if not role_roster:
            role_roster_error = ("register read returned zero role agents — "
                                 "the read is broken, not the register empty")
    except Exception as exc:  # noqa: BLE001 — any failure is the same story
        role_roster_error = str(exc)[:300]
    if role_roster_error:
        print(f"WARNING: role-agent roster unavailable: {role_roster_error}",
              file=sys.stderr)

    # Control of the control: a formula typo or renamed field returns zero
    # rows and reads as "nothing to do" forever. 17 live agents carry real
    # task links, so an empty agent-task population means the READ is broken.
    agent_linked = [t for t in open_tasks
                    if any(i in ALL_AGENTS for i in t["teamMemberIds"])
                    or any(i in ALL_AGENTS for i in t["sentForApprovalByIds"])]
    handback_population = query_tasks("LEN({Approval Outcome}&'')>0",
                                      max_records=1, minimal=True)
    # Tasks Kevin signed the robot in for (signin-done's SIGNED IN stamp is the
    # newest thing in their Notes). Marked before the lanes so every copy
    # carries the flag; counted below from the WORKLIST only, so a reopened
    # task a lane diverts (alert, Roy, unmapped) cannot wake the poll for
    # work the poll would then not find (review, 15 Sep 2026).
    mark_signin_reopened(agent_linked)
    if not agent_linked and not handback_population:
        print("ERROR: control failed — zero tasks linked to any AI agent and "
              "zero tasks with an approval outcome. The read is broken, not "
              "the queue empty.", file=sys.stderr)
        sys.exit(1)

    tier1, skipped_tier2, unmapped, unclassified = [], [], [], []
    system_alerts = []
    roy_lane = []
    # Roy's NEW requests are worked by his own job alone (24 Sep 2026). It runs
    # outside the queue lock so he is not kept waiting behind a 34-minute triage
    # slot, which means another dispatch run could otherwise draft the same
    # request at the same time. Only a queue read made for roy-assistant-run.sh
    # (ROY_ASSISTANT_RUN=1) puts them in the worklist; every other run lists
    # them under royRequests, counted, never worked and never dropped.
    roy_requests = []
    roy_run = os.environ.get("ROY_ASSISTANT_RUN") == "1"
    approved_hb, changes_hb, new_work, routing = [], [], [], []
    decided = []
    own_signal = []
    trial_checked, form_cards = [], []
    merge_cards = []
    creditor_ok = bool(role_roster.get(CREDITOR_REC_ID, {}).get("dispatchable"))
    creditor_count = 0
    # Tenants mid-chase, for the rent reply lane. A failed read leaves the lane empty and says so: the
    # message then goes to Inbox Response as before, never nowhere.
    rent_senders, rent_senders_error = set(), ""
    try:
        rent_senders = rent_reply_senders()
    except Exception as exc:  # noqa: BLE001 — said in the queue JSON and on stderr
        rent_senders_error = str(exc)[:300]
        print(f"WARNING: rent reply senders unavailable: {rent_senders_error}", file=sys.stderr)
    # The property lane needs BOTH the register lever and a readable book:
    # a task marked for the agent while the book cannot be read would be
    # withheld from Roy and from dispatch alike, with nobody holding it
    # (review finding, 2 Sep 2026). So the book is read FIRST, and a failed
    # read drops the lane for this run exactly as a paused row does — the
    # tasks fall to the Roy lane or the CEO pass as they did before the
    # agent existed — while the error rides in the queue JSON for verify.
    property_ok = bool(role_roster.get(PROPERTY_REC_ID, {}).get("dispatchable"))
    compliance_book, compliance_book_error = [], ""
    if property_ok:
        try:
            compliance_book = compliance_book_pages()
        except Exception as e:                            # noqa: BLE001
            compliance_book_error = str(e)[:200]
            property_ok = False
    property_count = 0
    held_under = []
    standing, standing_error = load_standing_holds()
    if standing_error:
        print(f"WARNING: standing holds unreadable: {standing_error}", file=sys.stderr)
    standing_held = []
    open_leads = open_lead_ids({held_lead_id(t) for t in agent_linked if held_lead_id(t)})
    open_roy_leads = open_lead_ids({roy_handling_lead(t["notes"]) for t in agent_linked
                                    if roy_handling_lead(t["notes"])})

    for t in agent_linked:
        # A STANDING HOLD WINS FIRST (Kevin, 24 Sep 2026). He ruled that nothing
        # on the matter moves until an event (a named person's reply); on
        # 23 Sep the Task Board Manager raised eight cards he had already ruled
        # on, because the ruling lived in two other agents' files. A hold is
        # read here for every agent, and an approval he gave AFTER the hold
        # began is his newer word, so hold_for never holds it. Listed, never
        # dropped: the task waits on the board with the reason on it.
        hold = standing_holds.hold_for(t, standing)
        if hold:
            standing_held.append({**t, "holdId": hold["id"],
                                  "holdTitle": hold.get("title", "")})
            continue
        # A ROBOT FORM CARD IS NEVER AN AGENT'S WORK (3 Oct 2026). The rent check raises it, reads
        # Kevin's verdict and finishes it in code; approving it opens the robot's window and
        # nothing else. Pulled out here, before every lane, whatever its outcome or none: a
        # changed, rejected or stranded card handed to an agent would be redone or "carried out"
        # by a run that has no business with it (independent review, 3 Oct 2026). Listed under
        # formCards, never hidden.
        if form_card(t["name"], t["notes"]):
            form_cards.append(t)
            continue
        # A MERGE CARD IS NEVER AN AGENT'S WORK (7 Oct 2026). Approving one runs merge-pr.py in
        # scripts/merge-approved.py, deterministic and with no model. Handed to the Builder as a
        # carry-out, a Claude run would try the merge itself; as a redo, it would rewrite a card it
        # cannot change. Pulled out before every lane, whatever its outcome. Listed, never hidden.
        if merge_card.is_merge_card(t["name"]):
            merge_cards.append(t)
            continue
        # ROY IS HANDLING THIS (24 Sep 2026): Roy forwarded this same matter to
        # his assistant. While his request is open this twin waits, listed
        # under heldUnderLead with the request as its lead, so Kevin never gets
        # two cards for one tenant. An approval Kevin already gave still runs.
        roy_lead = roy_handling_lead(t["notes"])
        if roy_lead and roy_lead != t["id"] and roy_lead in open_roy_leads \
                and t["outcome"] not in APPROVED:
            held_under.append({**t, "groupLead": roy_lead, "heldFor": "Roy's request"})
            continue
        # Tier 1 no longer drops out of the worklist. It is MARKED and worked,
        # and the mark rides all the way to the Slack post. Removing this line
        # so tier-1 work is prepared silently is the regression to fear.
        hit1 = tier_match(TIER1_PATTERNS, t["name"], t["description"], t["notes"])
        t["tier1"] = bool(hit1)
        t["matchedPattern"] = hit1 or ""
        if hit1:
            tier1.append(t)
        # A message the rent agent sent back with `reassign` (not about rent: keys, papers, a repair) is the CEO's
        # to place, never the rent lane's again: otherwise the lane would take it straight back (review, 5 Oct 2026).
        t["rentReply"] = bool(t["inboundTask"] and rent_senders and sender_key(t["inboundSender"]) in rent_senders
                              and not REASSIGN_LINE_RE.search(str(t.get("notes") or "")))
        t["creditor"] = creditor_match(t["name"], t["description"], t["notes"])
        creditor_count += t["creditor"]
        # Creditor work is ALWAYS tier-1 (Kevin's triage ruling, 24 Aug 2026)
        # — but "statutory demand" and "letter of claim" are tier-2 vocabulary
        # the tier-1 keyword list missed, so an unparked correspondence task
        # would have reached Kevin unbannered (review finding, 25 Aug 2026).
        if t["creditor"] and not t["tier1"]:
            t["tier1"] = True
            t["matchedPattern"] = t["matchedPattern"] or "creditor lane"
            tier1.append(t)
        hit2 = tier_match(TIER2_PATTERNS, t["name"], t["description"], t["notes"])
        out2 = outbound_intent(t["name"], t["description"],
                               t["notes"]) if hit2 else ""
        # Stored on the task because the AUTO_ROUTES steal predicates read it
        # after this loop iteration's locals are gone.
        t["tier2Correspondence"] = bool(hit2 and out2)
        if hit2 and out2 and not creditor_ok:
            # The old Mica lane survives ONLY as the fallback: while the
            # Creditor Management agent's register row is not Built/Live
            # (Kevin's pause lever), creditor correspondence parks exactly as
            # it did before 25 Aug 2026 rather than flowing to a generalist.
            skipped_tier2.append({**t, "matchedPattern": hit2,
                                  "outboundPattern": out2})
            continue
        # A machine reporting a breakage is work for the board, never a
        # question for Kevin. Checked AFTER tier 1 and tier 2 on purpose: those
        # classifications are about what the work TOUCHES and must win, and a
        # monitoring alert never trips them anyway.
        # THE SENDER AND THE NAME ONLY (14 Sep 2026). Until today this read
        # the Description and the Notes too. Notes carry every agent's run
        # log, and those logs say "Gmail quota" and "Apps Script" whenever a
        # scan hit a limit — so eleven real matters (a solicitor's letter, a
        # four-figure rent payment to verify, an adviser's £50+VAT fee, two compliance
        # renewals, a domain renewal, an EICR quote) were parked here for up to
        # 19 days and no agent ever saw them. A monitoring alert names itself
        # in its subject line and comes from a machine address; that is enough.
        # Money, a creditor marker or the tier-1 banner is never an alert.
        hit_alert = system_alert_match(t.get("inboundSender"), t["name"])
        if hit_alert and alert_veto(t):
            hit_alert = ""
        if hit_alert and t["outcome"] not in APPROVED:
            system_alerts.append({**t, "alertSource": hit_alert})
            continue
        # ROY'S LANE. Checked AFTER tier 1, the creditor lane and the alert
        # lane, all of which must win: the veto in roy_match already keeps
        # money and law out, and this ordering is the second line of the same
        # defence. An APPROVED task is never diverted — Kevin has already said
        # yes to that exact work and it must be carried out, not handed on.
        # THE PROPERTY LANE (2 Sep 2026). Compliance matters go to the
        # Property Administration agent through AUTO_ROUTES below, so they
        # are marked here and NOT diverted to Roy. While the agent's register
        # row is not Built/Live (Kevin's pause lever) the mark is dropped and
        # the task falls through to the Roy lane exactly as before this
        # build — the same fallback shape as the creditor tier-2 park.
        # ROY'S OWN REQUESTS (24 Sep 2026) stay with the agent he asked. A
        # "log a repair for the boiler" request matches the Roy lane's repair
        # words, and diverting it would hand Roy's request straight back to
        # him; the property steal would move it to an agent that has no
        # answer-to-Roy shapes. Tier 1 and the creditor lane still win.
        roy_request = is_roy_request(t["name"], t["notes"])
        t["property"] = ("" if (t["tier1"] or t["creditor"] or not property_ok) else
                         property_match(t["name"], t["description"], t["notes"]))
        if roy_request:
            t["property"] = ""
        # A CEO-lane task the fresh lane cannot place (neither inbound nor
        # COMPLIANCE-named) keeps its old home — the Roy lane — rather than
        # being taken from Roy and routed nowhere (review finding, 2 Sep 2026).
        owner = t["teamMemberIds"][0] if t["teamMemberIds"] else ""
        if (t["property"] and owner == CEO_REC_ID and not t["inboundTask"]
                and not str(t["name"]).startswith(COMPLIANCE_TASK_PREFIX)):
            t["property"] = ""
        property_count += bool(t["property"])
        hit_roy = ("" if (t["tier1"] or t["creditor"] or t["outcome"] in APPROVED
                          or t["property"])
                   else roy_match(t["name"], t["description"], t["notes"]))
        if roy_request:
            hit_roy = ""
        if hit_roy:
            roy_lane.append({**t, "royReason": hit_roy})
            continue
        if roy_request and not t["outcome"] and not roy_run:
            roy_requests.append(t)
            continue
        if not t["localAgent"]:
            unmapped.append(t)
            continue
        # agentId (Sent For Approval By, falling back to Team Member) decides
        # hand-backs: the drawer's decide path sets both, but an approved task
        # missing Sent For Approval By must still be carried out, not lost.
        # A DECIDED CARD (15 Sep 2026). Kevin's answer to a DECIDE: card is a
        # ruling on what should happen, not an approval of a draft. Carrying
        # it out as a hand-back would spawn an agent to "execute" a question;
        # the Task Manager's board reads its `decided` bucket and makes the
        # move Kevin named (its verdict is in the task's Approval Feedback).
        if t["outcome"] and is_decide_card(t["agentOutput"]):
            decided.append(t)
            continue
        # AN AGENT ON ITS OWN GO SIGNAL CARRIES OUT ITS OWN CARDS (16 Sep 2026). The Content Engine raises a card per
        # episode and its hourly job publishes what Kevin approves. On 16 Sep the hand-back poll also took both
        # approved episode cards as carry-outs: a headless Claude run drove publish.py by hand, its command time
        # limit killed each YouTube upload part way, the next attempt adopted the half-uploaded videos with no publish
        # time, and 2058's Short was left stuck processing on the channel. Listed under ownGoSignal, never hidden.
        if t["outcome"] and own_go_signal(t["agentId"]):
            own_signal.append(t)
            continue
        # A TRIAL AGENT'S APPROVED CARD IS CHECKED, NEVER CARRIED OUT (2 Oct 2026). Handing it to a carry-out run
        # would have an agent try a send that send-email.py refuses, every 30 minutes, for ever. `trial-settle`
        # closes it in code with Kevin's verdict on the task. Listed under trialChecked, never hidden.
        if t["outcome"] in APPROVED and trial_problem(t["sentForApprovalByIds"] + t["teamMemberIds"], t["name"], t["notes"],
                                                      t["approvedAt"]):
            trial_checked.append(t)
            continue
        if t["outcome"] in APPROVED and t["agentId"]:
            approved_hb.append(t)
        elif t["outcome"] == "Changes requested":
            changes_hb.append(t)
        elif not t["outcome"] and held_lead_id(t) in open_leads:
            held_under.append({**t, "groupLead": held_lead_id(t)})
            continue
        elif not t["outcome"]:
            tm = t["teamMemberIds"][0] if t["teamMemberIds"] else ""
            if tm == CEO_REC_ID:
                # Deterministic lanes skip the CEO's judgement pass entirely
                # (AUTO_ROUTES — Kevin's rulings, 24 and 25 Aug 2026): the
                # dispatcher routes them straight to the role agent with
                # `route TASKID --to <autoTarget>` — no od-ceo dispatch.
                # Gated on the LIVE register inside auto_route_fresh: if the
                # lane's row is not Built/Live (Kevin's pause lever) or the
                # roster read failed, the task stays in the CEO lane and
                # routes to a strategic agent like any other — work keeps
                # flowing, the lever stays honoured, and cmd_route re-checks
                # regardless.
                target = auto_route_fresh(t, role_roster)
                if target:
                    t["autoTarget"] = target
                routing.append(t)
            elif tm in ALL_AGENTS:
                # A task sitting with the WRONG agent moves to its lane's
                # specialist — the deliberately narrow steal predicates in
                # AUTO_ROUTES decide, so the CEO's explicit routing choices
                # are not silently overridden.
                target = auto_route_steal(t, tm, role_roster)
                if target:
                    t["autoTarget"] = target
                    routing.append(t)
                else:
                    new_work.append(t)
            else:
                # e.g. Team Member cleared while Sent For Approval By still
                # points at an agent. Surfaced, never silently dropped.
                unclassified.append(t)
        else:
            # Includes a Rejected task still sitting open — reject is meant to
            # close, so that state is an anomaly worth eyes, not silence.
            unclassified.append(t)

    for bucket in (approved_hb, changes_hb, new_work, routing):
        bucket.sort(key=sort_key)

    # A redo whose feedback asks for a DELAY is not work Kevin is waiting on, so
    # it loses its hand-back priority and goes to the back — see DELAY_PATTERNS.
    deferred_hb = [t for t in changes_hb if is_delay_feedback(t["feedback"])]
    if deferred_hb:
        deferred_ids = {t["id"] for t in deferred_hb}
        changes_hb = [t for t in changes_hb if t["id"] not in deferred_ids]

    # Hand-backs first — approved work Kevin is waiting on beats new work.
    # NOTE this ordering is the REPORTING order and the reserve order. It is no
    # longer what decides the worklist: see select_worklist, which holds slots
    # back for new work so hand-backs cannot starve it.
    # A hand-back that was CARRIED OUT and kept open, or PARKED on a sign-in
    # only Kevin can do, is not waiting on an agent. Until 14 Sep 2026 it sat
    # in approved_hb regardless, so the 30-minute poll woke a full Claude run
    # for the same five tasks 48 times a day: two EICR quote chases were
    # "carried out" every half hour (one task's Notes reached 46,000
    # characters) and three login-gated tasks were re-parked every half hour.
    # That poll used more of the weekly allowance than the Content Engine and
    # triage together, and the allowance ran out at Friday lunchtime. An idle
    # hand-back is looked at once a day, is listed (never hidden) under
    # idleHandbacks with its reason, and wakes at once if Kevin's verdict
    # changes (a new Approved At or a Changes requested).
    ledger = ledger_last_events()
    idle_hb = []
    for t in list(approved_hb):
        why = idle_handback(t, ledger.get(t["id"]))
        if why:
            t["idleReason"] = why
            idle_hb.append(t)
    # A wall on work he has NOT approved (a redo or new work) rests the same
    # day: before the blocker loop the agent's submit took it off the list;
    # now it stays on Today and would be dispatched again every slot to meet
    # the same wall (review, 25 Sep 2026).
    for t in list(changes_hb) + list(new_work) + list(deferred_hb):
        why = blocked_rest(t, ledger.get(t["id"]))
        if why and t in idle_hb:
            continue
        if why:
            t["idleReason"] = why
            idle_hb.append(t)
    if idle_hb:
        idle_ids = {t["id"] for t in idle_hb}
        approved_hb = [t for t in approved_hb if t["id"] not in idle_ids]
        changes_hb = [t for t in changes_hb if t["id"] not in idle_ids]
        new_work = [t for t in new_work if t["id"] not in idle_ids]
        deferred_hb = [t for t in deferred_hb if t["id"] not in idle_ids]

    combined = approved_hb + changes_hb + new_work + deferred_hb
    intents = open_intents()
    for t in combined:
        t["kind"] = ("carry_out" if t["outcome"] in APPROVED
                     else "redo" if t["outcome"] == "Changes requested"
                     else "new")
        # A previous run recorded intent to carry this out and never marked it
        # done: the action MAY already have happened. The dispatcher must make
        # the agent VERIFY (sent items, records) before executing anything.
        t["priorIntent"] = t["kind"] == "carry_out" and t["id"] in intents
    worklist = select_worklist(approved_hb + changes_hb, new_work, deferred_hb)
    worklist, grouped_now = group_property_work(
        worklist, compliance_book, datetime.now(LONDON).date())
    held_under += grouped_now
    signin_reopened = [t["id"] for t in worklist if t.get("signinReopened")]
    # If the dispatcher's judgement pass removes a worklist item (a tier-1
    # smell the keywords missed), it backfills from here — never beyond the cap.
    chosen = {t["id"] for t in worklist}
    reserve = [t for t in combined if t["id"] not in chosen][:CAP_PER_RUN]

    # The creditor record book rides with the queue (approved chain link 2,
    # 1 Sep 2026): history is READ before a word is drafted, and the drafting
    # agent can only read what this hands it. A failed read carries the error
    # instead — the skill then refuses to draft creditor responses blind, and
    # verify's record-book gate would fail the run regardless (no agent can
    # update a book it cannot reach).
    creditor_ledger, creditor_ledger_error = [], ""
    if creditor_count or any(CREDITOR_REC_ID in (t.get("teamMemberIds") or [])
                             for t in worklist):
        try:
            creditor_ledger = [plan_digest(p) for p in fetch_plans()]
        except Exception as e:                            # noqa: BLE001
            creditor_ledger_error = str(e)[:200]

    # The compliance book rides with the queue the same way (approved chain
    # link 2, 2 Sep 2026): what every property holds, what it must hold, and
    # what is missing or lapsed — read BEFORE the agent creates anything, so
    # a renewal that already exists is never bought twice. A failed read
    # carries the error; the skill then refuses to dispatch property work
    # blind rather than letting the agent guess at the portfolio.
    if not (property_count or any(PROPERTY_REC_ID in (t.get("teamMemberIds") or [])
                                  for t in worklist)):
        compliance_book = []      # read for the lane gate above; not needed by the skill this run

    out = {
        "generatedAt": now_iso(),
        "cap": CAP_PER_RUN,
        "worklist": worklist,
        "reserve": reserve,
        "routingNeeded": routing,      # CEO tasks; routing is free, work is not
        # Worked like anything else, but every one of these must be submitted
        # with --tier1 so the banner reaches Kevin. Not a skip list.
        "tier1Tasks": tier1,
        "skippedTier2": skipped_tier2,
        # The record book, one compact page per creditor matter. The skill
        # hands the matching page (or "no page yet") to every creditor
        # dispatch so the agent never repeats a step already taken.
        "creditorLedger": creditor_ledger,
        "creditorLedgerError": creditor_ledger_error,
        # The compliance book, one page per property: manager, what it must
        # hold, what it holds and when each item runs out. The skill hands the
        # matching page to every property dispatch.
        "complianceBook": compliance_book,
        "complianceBookError": compliance_book_error,
        # Named, counted, and left open on the board. Never dropped: an alert
        # that vanishes is worse than one that clogs the gate.
        "systemAlerts": system_alerts,
        # Approved hand-backs resting until tomorrow: carried out and kept open,
        # or parked on a sign-in. Listed with the reason, never dropped.
        "idleHandbacks": idle_hb,
        "ownGoSignal": own_signal,
        "trialChecked": trial_checked,
        "formCards": form_cards,
        # MERGE cards (7 Oct 2026): merged by scripts/merge-approved.py, never by an agent.
        "mergeCards": merge_cards,
        # Tasks a sign-in just reopened (ids): the pickup run and the 30-minute
        # poll work these first, whichever lane classified them.
        "signinReopened": signin_reopened,
        # Property work for Roy. Diverted and NAMED, never dropped — and not
        # acted on here: cmd_queue is a read. `handover-property` does the
        # writing, so one command owns the change.
        "royLane": roy_lane,
        # Roy's new requests, for roy-assistant-run.sh only (see roy_run above).
        "royRequests": roy_requests,
        # Property siblings held under a lead: grouped this run, or submitted
        # under a lead that is still open. Listed with groupLead, never dropped.
        "heldUnderLead": held_under,
        # Tasks a standing hold covers (scripts/standing_holds.py): waiting on
        # the event Kevin named. Parked on the board by the 30-minute run.
        "heldByStandingHold": standing_held,
        "standingHoldsError": standing_error,
        "decided": decided,            # answered DECIDE: cards; the Task Manager's move, never a carry-out
        "unmappedAgent": unmapped,
        "unclassified": unclassified,  # states the buckets cannot place — eyes, not silence
        "agents": ALL_AGENTS,          # the roster the CEO routes against
        # The full role-agent workforce from the live register, so the CEO
        # routes with knowledge of every role agent and what it does. Only
        # dispatchable ones (a ROLE_AGENTS entry + register Built/Live) may
        # receive work; the rest are listed so the CEO knows they exist and
        # never routes to them yet.
        "roleAgents": role_roster,
        "roleAgentsError": role_roster_error,
        "rentReplyError": rent_senders_error,
        "counts": {
            "openTasksRead": len(open_tasks),
            "agentLinkedOpen": len(agent_linked),
            "approvedHandbacks": len(approved_hb),
            "idleHandbacks": len(idle_hb),
            "ownGoSignal": len(own_signal),
            "trialChecked": len(trial_checked),
            "formCards": len(form_cards),
            "mergeCards": len(merge_cards),
            "changesRequested": len(changes_hb),
            # Redos Kevin asked to delay. Demoted behind new work rather than
            # dropped, and counted here so one sitting for weeks stays visible.
            "deferredRedos": len(deferred_hb),
            # Reopened by a sign-in and not yet worked: a hand-back the poll
            # must wake for (15 Sep 2026; before this the poll never saw them).
            "signinReopened": len(signin_reopened),
            "newWork": len(new_work),
            # A tier-2 park removes a task from every other bucket via
            # `continue`, so newWork read 0 while an agent-linked, no-outcome,
            # Urgent task sat open (finding 20260812-agent-dispatch-111). A
            # count makes the park visible in the same object that reports the
            # emptiness it causes.
            "tier2Parked": len(skipped_tier2),
            "systemAlerts": len(system_alerts),
            "royLane": len(roy_lane),
            "royRequests": len(roy_requests),
            "heldUnderLead": len(held_under),
            "heldByStandingHold": len(standing_held),
            "propertyGroups": len([t for t in worklist if t.get("siblings")]),
            "decided": len(decided),
            # Creditor-lane keyword matches across the whole agent-linked
            # read, hand-backs included (routing floor, not judgement). Zero
            # with the register row Built/Live and creditor mail known to be
            # arriving = the patterns or the triage marker broke.
            "creditorMatters": creditor_count,
            "routingNeeded": len(routing),
            "unclassified": len(unclassified),
            "tier1Open": len(tier1),
            "tier1InWorklist": len([t for t in worklist if t.get("tier1")]),
            "worklist": len(worklist),
        },
    }
    return out


def cmd_queue(args):
    print(json.dumps(build_queue(), indent=2))


# ─── WRITES ───────────────────────────────────────────────────────────

def require_role_agent_live(rec_id, verb):
    """The register row is Kevin's pause lever for a role agent — flipping its
    Status off Built/Live must actually stop work reaching it. Strategic
    agents (the 17) have no register row and always pass. Fails CLOSED on an
    unreadable register: the caller then routes to a strategic agent instead,
    so mail still flows while the lever stays honoured."""
    if rec_id not in ROLE_AGENTS:
        return
    try:
        roster = fetch_role_roster()
    except Exception as exc:  # noqa: BLE001
        sys.exit(f"ERROR: cannot {verb} to role agent "
                 f"{ROLE_AGENTS[rec_id]['name']} — the register is "
                 f"unreadable ({str(exc)[:160]}); use a strategic agent "
                 "this run and let verify surface the roster failure")
    entry = roster.get(rec_id)
    status = (entry or {}).get("status", "no register row")
    # `dispatch: False` means the CEO pass never hands this agent WORK. It does
    # not mean the agent cannot hand in its OWN work: the Content Engine runs on
    # its own Go Signal and raises an approval card per episode through
    # `submit` (3 Sep 2026). For a submit the lever is the register status
    # alone — Built or Live — exactly as it is for a dispatchable agent.
    if verb == "submit" and entry and status in ("Built", "Live"):
        return
    if not entry or not entry.get("dispatchable"):
        sys.exit(f"ERROR: role agent {ROLE_AGENTS[rec_id]['name']} is not "
                 f"dispatchable (register status: {status}) — Kevin's "
                 "register controls this; route to a strategic agent instead")


DECIDED_NOTE_MARK = "Decision carried out"


def decision_carry_out_fields(tf, stamp):
    """The fields that close an ANSWERED decision card when the foreman makes
    the move Kevin named (route or handover). Without this the card kept its
    outcome and its DECIDE: line, so build_queue filed it as `decided` on
    every run, the board routed it again every slot, and after seven days
    it was escalated again with the same question (review finding, 15 Sep
    2026). Returns {} when the task is not an answered card."""
    if not (is_decide_card(tf.get(AF["agentOutput"])) and sel(tf.get(AF["approvalOutcome"]))):
        return {}
    outcome = sel(tf.get(AF["approvalOutcome"]))
    feedback = str(tf.get(AF["approvalFeedback"]) or "").strip()
    verdict = outcome + (f" — {feedback}" if feedback else "")
    prior = str(tf.get(AF["agentOutput"]) or "").strip()
    return {
        AF["approvalOutcome"]: None,
        AF["approvedAt"]: None,
        AF["sentForApprovalBy"]: [],
        AF["agentOutput"]: (f"DECIDED (Kevin, {stamp}): {verdict}\n\n" + prior)[:95000],
        "_note": f"[{stamp} — agent-dispatch] {DECIDED_NOTE_MARK}: {verdict}",
    }


def cmd_route(args):
    if args.to not in ALL_AGENTS:
        sys.exit(f"ERROR: {args.to} is not a dispatchable AI agent record "
                 "(one of the 17 strategic agents or a built role agent)")
    if args.to == CEO_REC_ID:
        sys.exit("ERROR: routing back to the CEO is not a route")
    if args.to in OFF_BOARD:
        sys.exit(f"ERROR: {ALL_AGENTS[args.to]['name']} left the board on 9 Oct 2026. "
                 f"{OFF_BOARD[args.to]}")
    require_role_agent_live(args.to, "route")
    fields = {AF["teamMember"]: [args.to]}
    tf = (get_task(args.task).get("fields", {}) or {})
    stamp = datetime.now(LONDON).strftime("%d %b %Y")
    decided = decision_carry_out_fields(tf, stamp)
    if decided:
        note = decided.pop("_note")
        existing = str(tf.get(AF["notes"]) or "").rstrip()
        decided[AF["notes"]] = (existing + "\n\n" + note).strip()[-90000:]
        fields.update(decided)
    patch_task(args.task, fields)
    print(json.dumps({"routed": args.task, "to": args.to,
                      "agent": ALL_AGENTS[args.to]["name"],
                      "decisionCarriedOut": bool(decided)}))


REASSIGN_MARK = "REASSIGNED TO CEO"
REASSIGN_LINE_RE = re.compile(r"^\[[^\]]+\] " + REASSIGN_MARK, re.M)


def reassign_bounces(notes):
    """How many times this task has ALREADY been sent back to the CEO.

    Counts only the stamped lines this command writes. A bare substring count
    also matched the marker appearing inside an agent's own --reason text, so
    one honest bounce could read as two and lock the task out of the loop."""
    return len(REASSIGN_LINE_RE.findall(str(notes or "")))


def cmd_reassign(args):
    """Hand a task back to the AI CEO to be given to a different agent.

    `route` deliberately refuses the CEO, and still does: routing is the CEO
    handing work DOWN, so letting it point back up made a loop with nothing
    to stop it. Reassignment is the opposite direction and needs its own
    door — with a reason, and a limit. The CEO reads the reason in Notes and
    picks someone else; after REASSIGN_MAX bounces the task goes to Kevin
    instead, because a job nobody can place is a decision, not a routing
    problem."""
    task = get_task(args.task)
    tf = task.get("fields", {}) or {}
    held = held_card_problem(tf)
    if held:
        # A reassign clears the outcome and the sender: on a Your step card it wipes his approval,
        # and a MERGE card would sit at Today where no surface shows it (review, 7 Oct 2026).
        sys.exit(f"ERROR: refusing to reassign {args.task}: {held}.")
    notes = str(tf.get(AF["notes"]) or "")
    bounces = reassign_bounces(notes)
    if bounces >= REASSIGN_MAX:
        sys.exit(
            f"ERROR: {args.task} has already gone back to the CEO "
            f"{bounces} times. Escalate it to Kevin instead:\n"
            f"         python3 scripts/agent-dispatch.py escalate {args.task} --reason ... --brief-file ...\n"
            "       (run it bare to see the brief it needs). A task nobody can place "
            "is a decision for him, not another lap of the routing loop.")
    stamp = datetime.now(LONDON).strftime("%Y-%m-%d %H:%M")
    # One line, whatever the reason contains: a newline in free text would
    # otherwise fake a second stamped line for the counter above.
    reason = " ".join(str(args.reason).split())
    by = " ".join(str(args.by or "the dispatcher").split())
    line = f"[{stamp}] {REASSIGN_MARK} by {by}: {reason}"
    fields = {
        AF["teamMember"]: [CEO_REC_ID],
        AF["notes"]: (notes.rstrip() + "\n" + line).strip()[-90000:],
        # Back into the queue the CEO actually reads. Its own approval state
        # is cleared: the next agent must be judged on ITS work, not inherit
        # a verdict on somebody else's.
        AF["status"]: "Today",
        AF["dueDate"]: datetime.now(LONDON).strftime("%Y-%m-%d"),
        AF["approvalOutcome"]: None,
        AF["approvalFeedback"]: None,
        AF["approvedAt"]: None,
        AF["sentForApprovalBy"]: [],
        # Agent-owned again: a blank Assignee is the convention, and leaving
        # Kevin on it puts a task he no longer owns back on his own list.
        AF["assignee"]: None,
    }
    # ARCHIVE BEFORE THE WIPE — the same rule cmd_submit follows. Kevin's
    # words are why the next agent should do anything differently; clearing
    # them here would send the work onward with the reason erased, and would
    # leave a ticked "remember this" lesson with no text to learn from.
    prior = str(tf.get(AF["approvalFeedback"]) or "").strip()
    if prior:
        hist = str(tf.get(AF["feedbackHistory"]) or "")
        block = f"[{stamp}] {prior}"
        if not feedback_archived(hist, prior):
            fields[AF["feedbackHistory"]] = (hist.rstrip() + "\n\n" + block).strip()
    patch_task(args.task, fields)
    print(json.dumps({"reassigned": args.task, "to": "AI CEO (Dan Martell)",
                      "reason": args.reason, "priorBounces": bounces}))


# An escalation is a DECISION CARD (Kevin, 15 Sep 2026). Until then `escalate`
# re-linked the task to Kevin and touched nothing else: no Approval status, no
# Sent For Approval By, so the gate formula (os/agents/index.html), the Slack
# digest and the agent-linked dispatch filter all dropped it at once. Nothing
# showed it anywhere, the Task Manager found it "stuck" again next slot and
# escalated it again: recZMDlT4l2lcwMhB was escalated seven times and
# rec4cpT9R5Ld538C2 ran 33 times. The card is what Kevin actually sees, so the
# escalation IS a card: Status Approval, sent by the Task Manager's own Team
# Members row, opening with one ask line. Team Member is left alone — the
# escalation is a question about the work, not a change of who holds it.
DECIDE_PREFIX = "DECIDE:"
DECIDE_LINE_RE = re.compile(r"^\s*DECIDE:\s*\S", re.I | re.M)


def escalate_ask(reason):
    """One ask line, starting DECIDE:, from the escalate reason. The reason's
    first non-blank line is the ask; an existing DECIDE: prefix is kept, never
    doubled. '' when the reason holds no ask (cmd_escalate refuses that)."""
    first = next((ln.strip() for ln in str(reason or "").splitlines() if ln.strip()), "")
    if first.upper().startswith(DECIDE_PREFIX):
        first = first[len(DECIDE_PREFIX):].strip()
    return f"{DECIDE_PREFIX} {first}" if first else ""


# THE DECISION BRIEF (Kevin, 2 Oct 2026). A decision card was one DECIDE: line
# and nothing else: the plain lines were cleared, the TRACK RECORD gate sat
# only in cmd_submit, and no figure was ever asked for. Three sat in his queue
# at 250 to 285 characters while every other agent's card carried 1,000 to
# 23,000 with its history, and he had already sent two back ("I don't
# understand what you're asking here", "nothing in this task which gives me
# information"). One asked him to "confirm which cards and amounts to
# authorise" and named no amount. So a card is refused without a brief the
# agent writes (what this is, what has happened, the options, the one it
# recommends) and the two plain lines every other card opens with, and the
# code adds what must never depend on an agent remembering: the dated record
# of past dealings, the original email and the files already on the task. The
# first line is still DECIDE: <ask>, which the board, the page and
# is_decide_card all read.
BRIEF_MIN_CHARS = (("WHAT THIS IS", 40), ("WHAT HAS HAPPENED", 60), ("OPTIONS", 30), ("RECOMMENDED", 20))
BRIEF_HEADING_RE = re.compile(
    r"^[ \t]*(WHAT THIS IS|WHAT HAS HAPPENED|OPTIONS|RECOMMENDED|SINCE YOU LAST ANSWERED)[ \t]*:[ \t]*", re.M)
BRIEF_OPTION_RE = re.compile(r"^[ \t]*(?:[A-Z][.)]|\d{1,2}[.)]|[-*])[ \t]+\S", re.M)
# A question about money with no figure in it is the card he sent back. The
# way out names where the figure was looked for, so "unknown" is a finding.
MONEY_ASK_RE = re.compile(
    r"£|\b(?:pay|pays|paying|paid|payments?|amounts?|arrears|debts?|owed|owing|invoices?|refunds?|costs?|quotes?|fees?|price"
    r"|(?-i:bills?))\b", re.I)   # lower-case only: a gas bill is money, Bill Turner is a person
MONEY_FIGURE_RE = re.compile(r"[£$€]\s?\d|\bGBP\s?\d|\b\d[\d,.]*\s?(?:pounds|GBP)\b", re.I)
# The recommendation as the board reads it (RECOMMENDED_RE in task-manager.py;
# tests/agent-dispatch-escalate.test.js fails if the two drift): the first
# paragraph only, so the gate measures what an
# approval with an empty box will be taken to mean.
RECOMMENDED_RE = re.compile(
    r"^[ \t]*RECOMMENDED[ \t]*:[ \t]*(.+?)(?=\n[ \t]*\n|\n[ \t]*[A-Z][A-Z ]{3,}:|\Z)", re.M | re.S)
# Lines the page or another command reads as something else: a sign-in wait,
# an email to send, what approving does, the reason a card is Kevin's, or one
# of the blocks this command writes itself. In a brief they would be misread.
# TO, SUBJECT, the sign-in line and the carry-out words are matched in any
# case because their readers are; the rest only in capitals, so "Checked: the
# statement" and "Decide: by 5 Oct" stay ordinary sentences (review).
BRIEF_RESERVED_RE = re.compile(
    r"^[ \t>*_]*(?:(?i:SIGN-IN NEEDED|TO|SUBJECT)|CHECKED|DECIDE|TRACK RECORD|LINKS AND FILES"
    r"|WHAT YOU HAVE ALREADY SAID|CLOSE PROPOSAL|PASS TO ROY|KEVIN ONLY)[ \t]*:|(?i:carrying this out will involve)", re.M)
AMOUNT_UNKNOWN_RE = re.compile(r"^[ \t]*AMOUNT NOT KNOWN:[ \t]*\S.{20,}", re.I | re.M)
# ASKING TWICE IS THE FAILURE (found building this, 2 Oct 2026). Two of the
# three thin cards re-asked a question Kevin had answered a week before: on 23
# Sep he wrote what to do with one and why the other was early, both answers
# sat in Feedback History, and on 30 Sep each went back to him as "prior
# escalation had no recorded answer". So his own dated words go on every card,
# straight under the ask, and a task he has already answered is refused unless
# the brief says what has changed since.
SAID_STAMP_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2})[ T]\d{2}:\d{2}[^\]]*\][ \t]*", re.M)
KNOCK_BACK_RE = re.compile(r"^Knocked back to \d{4}-\d{2}-\d{2}\b", re.I)
SINCE_HEADING = "SINCE YOU LAST ANSWERED"
SINCE_MIN_CHARS = 20
# The task's own email link. Not in AF: every AF id is asked for on every
# queue read. Same id as TF.inboundUrl on the page and F["inboundUrl"] in
# create-agent-task.py (tests/agent-dispatch-escalate.test.js fails on drift).
INBOUND_URL_FIELD = "fldXf1p0vtHqOZcKl"
EARLIER_OUTPUT_MARK = "\n\nEarlier output:\n"
BRIEF_FORMAT_HELP = (
    "       A decision card needs a brief Kevin can decide from (2 Oct 2026). Write a file:\n"
    "         WHAT THIS IS: <what the task is, in plain words>\n"
    "         WHAT HAS HAPPENED: <the facts, dates and figures so far, and what is still unknown>\n"
    "         OPTIONS:\n"
    "         A. <first choice and what it leads to>\n"
    "         B. <second choice and what it leads to>\n"
    "         RECOMMENDED: <the option you would take and why>\n"
    "         SINCE YOU LAST ANSWERED: <only when he has answered before: what has changed>\n"
    "       then run\n"
    "         python3 scripts/agent-dispatch.py escalate TASKID --reason \"<the one ask>\" --brief-file <path> \\\n"
    "           --plain-task \"<what the task is, one short sentence>\" \\\n"
    "           --plain-approve \"<what happens if he approves with no note: the recommended option>\" \\\n"
    "           [--email <contact>] [--ref <reference or name>] [--property <address>]\n"
    "       The history, the email link and the files on the task are added for you. If the facts are\n"
    "       not on the task, it is not ready for Kevin: route it to the agent who can find them.")


def brief_sections(text):
    """{heading: body} for the four brief headings, first occurrence of each."""
    text = str(text or "")
    marks = list(BRIEF_HEADING_RE.finditer(text))
    out = {}
    for i, m in enumerate(marks):
        body = text[m.end():marks[i + 1].start() if i + 1 < len(marks) else len(text)]
        out.setdefault(m.group(1), body.strip())
    return out


def kevin_said(tf):
    """Kevin's own dated words on this task, oldest first: every Feedback
    History entry, plus an Approval Feedback not archived there yet."""
    hist = str(tf.get(AF["feedbackHistory"]) or "")
    marks = list(SAID_STAMP_RE.finditer(hist))
    out = []
    for i, m in enumerate(marks):
        text = " ".join(hist[m.end():marks[i + 1].start() if i + 1 < len(marks) else len(hist)].split())
        if text:
            out.append({"day": m.group(1), "text": text})
    live = " ".join(str(tf.get(AF["approvalFeedback"]) or "").split())
    if live and not any(live == e["text"] for e in out):
        out.append({"day": "", "text": live})
    return out


def kevin_said_lines(said):
    lines = []
    for e in said:
        try:
            day = datetime.strptime(e["day"], "%Y-%m-%d").strftime("%d %b %Y")
        except ValueError:
            day = "latest"
        lines.append(f"- {day}: {e['text'][:600]}")
    return lines


def has_decision_brief(agent_output):
    """Was this card built with a brief? A card from before 2 Oct 2026 was not,
    and is rebuilt rather than reported as already escalated. Only the card
    itself is read, never an earlier draft kept under it."""
    parts = brief_sections(str(agent_output or "").partition(EARLIER_OUTPUT_MARK)[0])
    return all(heading in parts for heading, _least in BRIEF_MIN_CHARS)


def decision_brief_problem(brief, ask, name, said=()):
    """Why this brief cannot go on Kevin's card; '' when it can."""
    parts = brief_sections(brief)
    answers = [e for e in said if not KNOCK_BACK_RE.match(e["text"])]
    if answers and len(parts.get(SINCE_HEADING, "")) < SINCE_MIN_CHARS:
        return ("Kevin has already answered on this task, and the brief does not say what has changed:\n         "
                + "\n         ".join(kevin_said_lines(answers)) + "\n"
                "       If his answer covers it, carry that out (route, handover, close, or leave until the date "
                "he gave) and do not ask again. If something has changed, add a section "
                f"'{SINCE_HEADING}: <what changed and why it needs him again>'")
    reserved = BRIEF_RESERVED_RE.search(str(brief))
    if reserved:
        return (f"the brief has a line the card reads as something else ('{reserved.group(0).strip()[:40]}'). "
                "Say it in plain words inside one of the four sections")
    rec = RECOMMENDED_RE.search(str(brief))
    for heading, least in BRIEF_MIN_CHARS:
        if heading not in parts:
            return f"the brief has no '{heading}:' section"
        # RECOMMENDED is measured as the board reads it: its first paragraph.
        body = " ".join(rec.group(1).split()) if heading == "RECOMMENDED" and rec else parts[heading]
        if len(body) < least:
            return (f"its '{heading}:' section is {len(body)} characters, too short to "
                    f"decide from (at least {least}" + ("; the option and why go in its first paragraph)"
                                                         if heading == "RECOMMENDED" else ")"))
    if len(BRIEF_OPTION_RE.findall(parts["OPTIONS"])) < 2:
        return ("its OPTIONS section lists fewer than two choices. One per line, starting A. B. "
                "(or 1. 2. or a dash). One choice is not a decision")
    if (MONEY_ASK_RE.search(f"{ask} {name}") and not MONEY_FIGURE_RE.search(str(brief))
            and not AMOUNT_UNKNOWN_RE.search(str(brief))):
        return ("the ask is about money and the brief gives no figure. State each amount with a £ sign, "
                "or add a line 'AMOUNT NOT KNOWN: <where you looked and why it is not there>'")
    return ""


def earlier_work(prior_output):
    """The earlier draft worth keeping under a new card, quoted line by line.
    Never an earlier DECIDE: ask (a rebuilt card would carry its own thin
    question twice). Quoted because the page and the sign-in commands read
    the whole output: an old draft's TO: and SUBJECT: became the ask line, its
    SIGN-IN NEEDED line turned Approve into "Sign in now", and the LAST
    carry-out line in the output is what the page says approving does."""
    text = str(prior_output or "").strip()
    while is_decide_card(text):
        text = text.partition(EARLIER_OUTPUT_MARK)[2].strip()
    text = re.sub(r"\*{0,2}carrying this out will involve:?\*{0,2}", "The earlier draft would have involved:",
                  text, flags=re.I)
    return "\n".join("> " + line for line in text.splitlines()) if text else ""


def decision_links(task_id, tf):
    """The LINKS AND FILES block: the email this task came from, every file on
    it by name (the card's story opens each one; an Airtable file link dies
    within hours, so it is never written into the text) and the task itself."""
    lines, seen = [], set()
    for u in str(tf.get(INBOUND_URL_FIELD) or "").split():
        if re.match(r"https?://", u, re.I) and u not in seen:
            seen.add(u)
            lines.append(f"- The original email: {u}")
    for a in (tf.get(AF["attachments"]) or []):
        fname = str(a.get("filename") or "").strip()
        if fname:
            lines.append(f"- File on this task: {fname} (opens from the story so far, below)")
    lines.append(f"- This task in Airtable: https://airtable.com/{BASE_ID}/{TASKS}/{task_id}")
    return "LINKS AND FILES:\n" + "\n".join(lines)


def decision_track_record(task_id, tf, emails=(), refs=(), properties=(), gmail=True):
    """The TRACK RECORD block for a decision card: the same search the create
    gate runs (the sender, and every reference in the name and description)
    plus whatever the agent names. A failed search says so on the card."""
    sender = re.search(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", str(tf.get(AF["inboundSender"]) or ""))
    text = f"{tf.get(AF['name']) or ''} {str(tf.get(AF['description']) or '')[:2000]}"
    try:
        result = history(emails=list(emails or []) + ([sender.group(0)] if sender else []),
                         refs=list(refs or []) + reference_tokens(text),
                         properties=list(properties or []), exclude_task=task_id, gmail=gmail)
        return history_text(result)
    except SystemExit as e:
        return f"{TRACK_RECORD_MARK} not built ({str(e)[:120]})"
    except Exception as e:                                   # noqa: BLE001
        return f"{TRACK_RECORD_MARK} not built ({str(e)[:120]})"


def cmd_escalate(args):
    """Submit the task to Kevin's gate as a decision card with its brief.
    Idempotent: a task already at Approval carrying a briefed DECIDE: card is
    reported, not rewritten. A card from before the brief is rebuilt once."""
    t = get_task(args.task)
    tf = t.get("fields", {}) or {}
    held = held_card_problem(tf)
    if held:
        sys.exit(f"REFUSED: {args.task} is not a decision for Kevin: {held}.")
    status = sel(tf.get(AF["status"]))
    prior_output = str(tf.get(AF["agentOutput"]) or "")
    on_gate = status == "Approval" and is_decide_card(prior_output)
    # AN ANSWERED CARD IS NEVER REWRITTEN, whatever its status: the page moves
    # the task to Today the moment Kevin decides, and the rewrite clears his
    # verdict. Refused loudly, because the caller's next move is his answer.
    outcome = sel(tf.get(AF["approvalOutcome"]))
    if is_decide_card(prior_output) and outcome:
        feedback = " ".join(str(tf.get(AF["approvalFeedback"]) or "").split())
        rec = RECOMMENDED_RE.search(prior_output.partition(EARLIER_OUTPUT_MARK)[0])
        answer = (f'"{feedback[:400]}"' if feedback else
                  (f"no note, so he took the card's recommendation: {' '.join(rec.group(1).split())[:300]}"
                   if rec else "no note, and the card named no recommendation"))
        sys.exit(f"REFUSED: Kevin has ANSWERED the decision card on {args.task} ({outcome}: {answer}). Carry out "
                 "his answer first: route, handover, complete (nothing needs doing), or, when it is to wait,\n"
                 f"         python3 scripts/agent-dispatch.py decided {args.task} [--until YYYY-MM-DD]\n"
                 "       Never ask the same thing again. A NEW question after that needs a "
                 f"'{SINCE_HEADING}:' section in its brief.")
    if on_gate and has_decision_brief(prior_output):
        print(json.dumps({"alreadyEscalated": args.task, "status": status,
                          "ask": prior_output.strip().splitlines()[0][:200]}))
        return
    # A BLOCKED TASK IS NOT A DECISION (25 Sep 2026). The Agile Estates filing
    # (recGImsRxDQ1UYBti) had a SIGN-IN wall open; the Task Manager saw it not
    # moving and escalated it as "DECIDE: blocked by a code defect", which put a
    # stale question in Kevin's queue, wiped the redo Kevin had asked for, and
    # took the task off the list the sign-in would wake. The wall already routes
    # the ask to whoever clears it and wakes the task when it is cleared.
    wall = task_blocker(tf.get(AF["notes"]))
    if wall:
        sys.exit(f"REFUSED: {args.task} is blocked ({wall['kind']} {wall['subject']}), so it is not a "
                 f"decision for Kevin. Its fix is already routed: {blocker_fix_text(wall)} It wakes by "
                 "itself when that is done. Leave it.")
    # AN EPISODE CARD IS NOT ESCALATED (30 Sep 2026). On 29 Sep the Task Manager escalated Content Engine episode 2059
    # as "approved but unpublished" when it had been live on every channel since 17 Sep; the card was only open because
    # nothing closed it. The engine now closes it once every section is out (publish.py close-cards) and reports what
    # is not ("content sections not done"). Matched on the card's name, whoever holds it (task-manager.py carries the
    # same EPISODE_CARD_PREFIX; tests/task-manager.test.js fails if they drift).
    if str(tf.get(AF["name"]) or "").startswith(EPISODE_CARD_PREFIX):
        sys.exit(f"REFUSED: {args.task} is a Content Engine episode card. It closes itself once the episode is out on "
                 "every section, so it is not a decision for Kevin. `python3 scripts/content-engine/publish.py published "
                 "--day N` shows what went out. Leave it.")
    ask = escalate_ask(getattr(args, "reason", ""))
    brief_path = getattr(args, "brief_file", None)
    if not brief_path:
        sys.exit(f"REFUSED: {args.task} was escalated with one line and no brief.\n" + BRIEF_FORMAT_HELP)
    if not ask:
        sys.exit(f"REFUSED: {args.task} has no ask. --reason is the one thing Kevin must decide.\n" + BRIEF_FORMAT_HELP)
    try:
        with open(brief_path, encoding="utf-8") as fh:
            brief = fh.read().strip()
    except (OSError, UnicodeDecodeError) as e:
        sys.exit(f"REFUSED: the brief file for {args.task} could not be read ({str(e)[:160]}).\n" + BRIEF_FORMAT_HELP)
    said = kevin_said(tf)
    problem = (decision_brief_problem(brief, ask, tf.get(AF["name"]) or "", said)
               or plain_summary_problem(getattr(args, "plain_task", None), getattr(args, "plain_approve", None)))
    if problem:
        sys.exit(f"REFUSED: {args.task} is not ready for Kevin: {problem}.\n" + BRIEF_FORMAT_HELP)
    record = decision_track_record(args.task, tf, emails=getattr(args, "email", None),
                                   refs=getattr(args, "ref", None), properties=getattr(args, "property", None),
                                   gmail=not getattr(args, "no_gmail", False))
    stamp = datetime.now(LONDON).strftime("%d %b %Y")
    existing = str(tf.get(AF["notes"]) or "").rstrip()
    # The holder at escalation is recorded on the stamp: the gate's approve
    # path re-links the task to the sender (the Task Manager), so the board
    # needs it to restore the prior holder when Kevin's answer names nobody.
    holder = ",".join(links(tf.get(AF["teamMember"]))) or "none"
    if on_gate:
        # A rebuild is the same question to the same person, so the holder the
        # first escalation recorded still stands. It is stamped as an
        # escalation all the same: the board dates its seven days, and files
        # his answer as decided, from the newest such stamp.
        holders = re.findall(r"Escalated to Kevin as a decision card \(holder ([^)]*)\)", existing)
        holder = holders[-1] if holders else holder
    note = (f"[{stamp} — agent-dispatch] Escalated to Kevin as a decision card "
            f"(holder {holder}){', rebuilt with a full brief' if on_gate else ''}: {ask}")
    blocks = [ask]
    # 8. A decision on his private matter says so, as every other card on it does
    # (cmd_submit --tier1). Name and description only, never the Notes agents
    # write on. Under the ask: the first line must stay DECIDE:.
    if getattr(args, "tier1", False) or tier_match(TIER1_PATTERNS, tf.get(AF["name"]), tf.get(AF["description"])):
        blocks.append(TIER1_BANNER)
    if said:
        blocks.append("WHAT YOU HAVE ALREADY SAID:\n" + "\n".join(kevin_said_lines(said)))
    output = "\n\n".join(blocks + [brief, decision_links(args.task, tf), record])
    earlier = earlier_work(prior_output)
    if earlier:
        # The earlier draft stays under the card: Kevin decides with it in view.
        output += EARLIER_OUTPUT_MARK + earlier
    # ARCHIVE BEFORE THE WIPE, the rule cmd_submit follows. A note left on the
    # field would be read as his answer to THIS card when he approves with an
    # empty box, so the board would never reach the card's recommendation.
    archive = {}
    prior_feedback = str(tf.get(AF["approvalFeedback"]) or "").strip()
    if prior_feedback:
        hist = str(tf.get(AF["feedbackHistory"]) or "")
        if not feedback_archived(hist, prior_feedback):
            archive[AF["feedbackHistory"]] = (
                hist.rstrip() + f"\n\n[{datetime.now(LONDON).strftime('%Y-%m-%d %H:%M')}] {prior_feedback}").strip()
    patch_task(args.task, {
        **archive,
        AF["approvalFeedback"]: None,
        AF["status"]: "Approval",
        # The Task Manager's Team Members row — read live from Team Members
        # tblco0p2OnlLQVAX7 on 15 Sep 2026 ("AI Task Board Manager"), and the
        # same id ROLE_AGENTS carries. The gate needs a sender or it hides the
        # row (APV_QUEUE_FORMULA requires Sent For Approval By).
        AF["sentForApprovalBy"]: [TASKMGR_REC_ID],
        # No Assignee write: the card is the surface, blank Assignee means an
        # agent owns it, and setting it fires the assignment Slack DM.
        AF["agentOutput"]: output[:95000],
        # A standing verdict from an earlier round would read as already
        # decided; the card is a fresh question.
        AF["approvalOutcome"]: None,
        AF["approvedAt"]: None,
        # The card's own two lines, never an earlier submit's: those describe
        # a different proposal (review, 22 Sep 2026).
        AF["plainSummary"]: plain_summary_text(args.plain_task, args.plain_approve),
        AF["notes"]: (existing + "\n\n" + note).strip()[-90000:],
    })
    print(json.dumps({"escalated": args.task, "to": "Kevin Brittain", "card": True,
                      "ask": ask, "sentForApprovalBy": TASKMGR_REC_ID, "rebuilt": on_gate,
                      "trackRecord": record.splitlines()[0][:200]}))


def cmd_decided(args):
    """Close an ANSWERED decision card whose answer is to wait.

    `route` and `handover` close a card when Kevin's answer moves the work.
    Nothing closed it when his answer was "leave it until the 5th" or "raise a
    reminder in November" (2 Oct 2026): the verdict stayed on the task, the
    board had no move that recorded it, and after seven days the task was
    raised again as "no recorded answer". This records the answer as carried
    out, puts the task back with whoever held it when it was escalated (the
    gate's approve re-linked it to the Task Manager), and with --until parks
    it until the date he gave. Without --until the card closes and the task
    stays live for its holder: that is for a card that must be asked again
    properly, never for "nothing needs doing", which is a `complete`."""
    tf = (get_task(args.task).get("fields", {}) or {})
    stamp = datetime.now(LONDON).strftime("%d %b %Y")
    fields = decision_carry_out_fields(tf, stamp)
    if not fields:
        sys.exit(f"REFUSED: {args.task} is not an answered decision card (a DECIDE: card with Kevin's verdict "
                 "on it), so there is no answer to record.")
    if sel(tf.get(AF["status"])) == "Completed":
        sys.exit(f"REFUSED: {args.task} is Completed (a rejected card closes its task). Parking it would "
                 "reopen work Kevin closed.")
    note = fields.pop("_note")
    until = (getattr(args, "until", None) or "").strip()
    if until:
        try:
            due = datetime.strptime(until, "%Y-%m-%d").strftime("%Y-%m-%d")
        except ValueError:
            sys.exit(f"REFUSED: --until {until} is not a date. Use YYYY-MM-DD.")
        if due <= today_london():
            sys.exit(f"REFUSED: --until {until} is not in the future. Leave --until off to close the card "
                     "with nothing to wait for.")
        fields[AF["status"]] = "Upcoming"
        fields[AF["dueDate"]] = due
        # Its own stamped line: his feedback can run over several lines, and
        # the board reads a stamp's first line (PARKED_NOTE_MARK in
        # task-manager.py files the task as parked, not stuck, until the date).
        note += f"\n\n[{stamp} — agent-dispatch] Parked until {due} on Kevin's answer; it comes back on the board that day."
    existing = str(tf.get(AF["notes"]) or "").rstrip()
    holders = re.findall(r"Escalated to Kevin as a decision card \(holder ([^)]*)\)", existing)
    # An agent or a person on the team (a card Roy held goes back to Roy), never the Task Manager itself.
    people = {h["rec"] for h in HUMANS.values()}
    back_to = [h for h in (holders[-1] if holders else "").split(",")
               if (h in ALL_AGENTS or h in people) and h != TASKMGR_REC_ID]
    if back_to:
        fields[AF["teamMember"]] = back_to
    fields[AF["notes"]] = (existing + "\n\n" + note).strip()[-90000:]
    patch_task(args.task, fields)
    print(json.dumps({"decisionCarriedOut": args.task, "until": until or None,
                      "holder": back_to or "unchanged"}))


def cmd_handover(args):
    """Hand an approved task to a named human on the team.

    The exit `route` and `escalate` did not cover. `route` takes agent records
    only; `escalate` always means Kevin. An approved "reassign this to Mica"
    therefore had nothing that could carry it out, so the task kept its standing
    approval and came back round every run (20260819-agent-dispatch-238).

    Status stays where it is — deliberately. The work is not done, it has just
    changed hands, and marking it Completed would hide it from the person who
    now owns it.
    """
    who = HUMANS.get((args.to or "").strip().lower())
    if not who:
        sys.exit(
            f"ERROR: {args.to} is not a team member this command may hand work "
            f"to. Allowed: {', '.join(sorted(HUMANS))}.\n"
            "       An unchecked address points a real task at nobody and "
            "Airtable accepts it without complaint."
        )
    stamp = datetime.now(LONDON).strftime("%d %b %Y")
    reason = (args.reason or "").strip() or "approved reassignment"
    t = get_task(args.task)
    # A handover emails the task and its draft to a colleague. A trial task goes to nobody (2 Oct 2026).
    _tf = t.get("fields", {}) or {}
    trial = trial_problem(links(_tf.get(AF["sentForApprovalBy"])) + links(_tf.get(AF["teamMember"])),
                          _tf.get(AF["name"], ""), _tf.get(AF["notes"], ""))
    if trial:
        sys.exit(f"ERROR: refusing to hand over {args.task}: {trial}.")
    held = held_card_problem(_tf)
    if held:
        sys.exit(f"ERROR: refusing to hand over {args.task}: {held}.")
    # Tier-1 gate (25 Aug 2026, Task Manager build review): a handover to
    # anyone but Kevin moves the task OUT of the agent queue and DMs the new
    # owner, so tier-1 content (creditor, legal, courts, HMRC, the live legal
    # matter) may only leave through it after Kevin has approved that exact
    # reassignment. Roy's standing approval covers maintenance, and genuine
    # maintenance never trips these patterns — prose rules in a skill are not
    # a gate, this is.
    tf = t.get("fields", {})
    # IDEMPOTENT (15 Sep 2026). Handing a task to someone who already holds it
    # re-linked them, appended another note and emailed them the work again.
    # The Task Manager counted Roy-held tickets as stuck every slot, so
    # rec72wof6bUtaEKqJ and rec4kMUqLpQ0NlHAC each collected 34 handovers and
    # nine more tickets 28 to 31. Already held means nothing to write and
    # nothing to send; the caller is told so and can record the move as a
    # chase instead.
    if who["rec"] in links(tf.get(AF["teamMember"])):
        # The half-taken shape (20260823-agent-dispatch-324): held by the
        # person but Sent For Approval By still names an agent, so the task
        # is still in the agent-linked population. Clear ONLY that, no note,
        # no email — the person already has the work.
        lingering = links(tf.get(AF["sentForApprovalBy"]))
        if lingering:
            patch_task(args.task, {AF["sentForApprovalBy"]: [],
                                   AF["approvalOutcome"]: None,
                                   AF["approvedAt"]: None})
        print(json.dumps({"alreadyHeld": True, "task": args.task,
                          "to": args.to, "name": who["name"],
                          "clearedAgentLink": bool(lingering)}))
        return
    if who["rec"] != KEVIN_REC_ID:
        outcome = tf.get(AF["approvalOutcome"], "")
        texts = [tf.get(AF["name"], ""), tf.get(AF["description"], ""),
                 tf.get(AF["notes"], "") or ""]
        hit = tier_match(TIER1_PATTERNS, *texts)
        if hit and outcome not in APPROVED:
            sys.exit(
                f"ERROR: refusing handover of {args.task} to {who['name']} — "
                f"tier-1 content (matched {hit!r}) with no approved outcome. "
                "Tier-1 work is prepared for Kevin and reassigned only after "
                "his explicit yes (submit it for approval instead)."
            )
    existing = tf.get(AF["notes"], "") or ""
    note = (f"[{stamp} — agent-dispatch] Handed over to {who['name']} "
            f"({args.to}): {reason}")
    # An answered decision card handed on IS the decision being carried out:
    # close the card too, or it is filed as `decided` on every later run.
    decided = decision_carry_out_fields(tf, stamp)
    if decided:
        note = decided.pop("_note") + "\n\n" + note
    patch_task(args.task, {
        **decided,
        # The agent link goes. Leaving it would keep the task in the queue's
        # agent-linked population and it would be worked again tomorrow.
        AF["teamMember"]: [who["rec"]],
        AF["assignee"]: {"email": args.to},
        # BOTH links, or the handover does not take (20260823-agent-dispatch-324).
        # cmd_queue's agent_linked filter reads Team Member OR Sent For Approval
        # By, so clearing only the first left the task in the agent population:
        # it came back round every run for ever, with a human's name on it and
        # an agent working it anyway.
        AF["sentForApprovalBy"]: [],
        # And the standing verdict goes with it. An Approved outcome left behind
        # means that if the task is ever routed back to an agent, the loop reads
        # it as an approved carry-out and executes an action Kevin approved for
        # somebody else's version of the work. The handover is recorded in Notes,
        # which is where the audit trail belongs.
        AF["approvalOutcome"]: None,
        AF["approvedAt"]: None,
        AF["notes"]: (existing + "\n\n" + note).strip(),
    })
    # TELL THEM. Until 28 Aug 2026 this command reassigned the task and
    # notified nobody: 47 tasks sat linked to Roy Lavin and not one email had
    # ever gone to him. A comment here even claimed it "DMs the new owner"; no
    # code did. That was survivable while every handover was Kevin typing one
    # by hand, and is not survivable now the property lane routes automatically
    # — work would leave his queue, land on a name and be seen by nobody, which
    # is worse than clogging the queue because he would believe it was handled.
    #
    # Roy is not on Operations Director yet, so the email carries the WORK, not
    # a link to it. Kevin's requirement, in his words: "as long as he's got the
    # information by our email as well, that's the most important thing."
    #
    # Kevin himself is never emailed — he reads the board.
    # A send failure does NOT roll back the reassignment: the task genuinely
    # moved, and a half-undone handover is worse than one that is loud about
    # not having been announced. It is reported instead.
    notified, notify_error = False, ""
    if who["rec"] != KEVIN_REC_ID:
        try:
            subprocess.run(
                [sys.executable,
                 os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "send-email.py"),
                 "notify", args.task, "--to", args.to, "--reason", reason],
                check=True, capture_output=True, text=True, timeout=90)
            notified = True
        except subprocess.CalledProcessError as exc:
            notify_error = (exc.stdout or exc.stderr or "").strip().splitlines()[-1][:200] \
                if (exc.stdout or exc.stderr) else f"exit {exc.returncode}"
        except Exception as exc:                               # noqa: BLE001
            notify_error = str(exc)[:200]
    print(json.dumps({"handedOver": args.task, "to": args.to,
                      "name": who["name"], "reason": reason,
                      "emailed": notified,
                      # Loud on purpose. An unannounced handover is the failure
                      # this whole change exists to stop.
                      "NOT EMAILED": notify_error or None}))


# The builder agent owns broken infrastructure once it leaves Kevin's queue.
# Named here so the sweep and the report cannot disagree about who holds it.
BUILDER_REC_ID = "recQkO6BA4w5zqwZ4"          # AI Worker — Builder


def cmd_clear_alerts(args):
    """Take machine-breakage tasks OUT of Kevin's approval queue.

    THE GAP THIS CLOSES. The alert lane shipped 27 Aug 2026 and classifies in
    `build_queue`, which reads Today/Overdue only. It stopped NEW alerts
    reaching the gate — verified: zero created since — and did NOTHING about
    the ones already sitting at Approval. Kevin cleared his queue on 29 Aug and
    15 of the 17 left were exactly this class, every one predating the fix.
    Fixing the tap and leaving the bath full is not fixing it.

    NOTHING IS CLOSED. Each task moves to Today and to the builder agent, which
    is where "a system is broken" belongs: it is work, not a decision for
    Kevin. He can still see every one of them on the board and in the
    "Kept off your queue" lane. A destructive sweep of his approvals would need
    his explicit yes; this one is a reassignment and is reversible by hand.

    A finding is filed for anything not already in the queue, so the task moving
    off his plate cannot be the last anyone hears of it.
    """
    live = query_tasks(
        "AND({Status}='Approval', NOT(IS_AFTER({Deferred Until}, TODAY())))")
    moved, skipped = [], []
    for rec in live:
        t = task_view(rec)
        # Sender and NAME only, with the money/creditor/tier-1 veto — the
        # same rule as build_queue (14 Sep 2026). This sweep WRITES three
        # times a day; reading Notes here would re-park at the gate the very
        # tasks the queue fix released.
        hit = system_alert_match(t.get("inboundSender"), t["name"])
        if not hit:
            continue
        # A MERGE card or a Your step card is Kevin's by construction, whatever its name says:
        # "fix: send-email.py waits out the Gmail quota" is a merge he decides, and moving it would
        # blank his approval (review, 7 Oct 2026).
        held = held_card_problem((rec.get("fields") or {}))
        if held:
            skipped.append({"task": t["id"], "name": t["name"], "why": held})
            continue
        # Tier 1, a creditor matter or a sum of money never moves, whatever it
        # looks like. Named in the output so the sweep still says what it left.
        veto = alert_veto({**t, "tier1": bool(tier_match(TIER1_PATTERNS, t["name"], t["description"], t["notes"])),
                           "creditor": creditor_match(t["name"], t["description"], t["notes"])})
        if veto:
            skipped.append({"task": t["id"], "name": t["name"],
                            "why": "%s — left with Kevin on purpose" % veto})
            continue
        entry = {"task": t["id"], "name": t["name"], "matched": hit}
        if args.dry_run:
            moved.append({**entry, "dryRun": True})
            continue
        stamp = datetime.now(LONDON).strftime("%d %b %Y")
        note = (f"[{stamp} — agent-dispatch] Moved off the approval queue: a "
                f"machine reporting a breakage (matched {hit!r}) is work, not "
                f"a decision. Owned by the builder agent; filed as a finding.")
        existing = (rec.get("fields", {}) or {}).get(AF["notes"], "") or ""
        patch_task(t["id"], {
            AF["status"]: "Today",
            AF["teamMember"]: [BUILDER_REC_ID],
            AF["sentForApprovalBy"]: [],
            # No verdict is left behind. An Approved outcome on a task that
            # changed hands would later read as an approved carry-out.
            AF["approvalOutcome"]: None,
            AF["approvedAt"]: None,
            AF["notes"]: (existing + "\n\n" + note).strip(),
        })
        moved.append(entry)
    print(json.dumps({"cleared": len(moved), "items": moved,
                      "leftWithKevin": skipped}, indent=2))
    return 0


def cmd_handover_property(args):
    """Hand every task in Roy's lane to Roy, in one deterministic pass.

    WHY THIS IS A COMMAND AND NOT A SKILL STEP. `handover` has existed since
    25 Aug 2026 with Roy's standing approval on it, and in three days nothing
    routed a single task to him — because the instruction to do it lived in
    prose. Kevin then typed "Roy is dealing with this" seven times. The same
    lesson as the learning loop: a rule nothing enforces is a rule that gets
    skipped. See scripts/inbound-triage-run.sh, which calls this.

    Reuses cmd_handover per task, so the tier-1 gate, the both-links write and
    the cleared-verdict rule are the SAME code the manual path uses. A second
    implementation here is how the two would drift apart.
    """
    queue = build_queue()
    lane = queue.get("royLane") or []
    done, failed = [], []
    for t in lane:
        entry = {"task": t["id"], "name": t["name"], "why": t.get("royReason", "")}
        if args.dry_run:
            done.append({**entry, "dryRun": True})
            continue
        try:
            cmd_handover(argparse.Namespace(
                task=t["id"], to=ROY_EMAIL,
                reason=f"property matter ({t.get('royReason','')}) — Roy is "
                       "Head of Property and this is his standing lane"))
            done.append(entry)
        except SystemExit as exc:
            # cmd_handover REFUSES tier-1 content with a sys.exit. That is the
            # gate doing its job, not an error to swallow: it is reported so a
            # pattern that keeps tripping it gets fixed rather than retried
            # silently every run.
            failed.append({**entry, "refused": str(exc)})
        except Exception as exc:                               # noqa: BLE001
            failed.append({**entry, "error": str(exc)})
    print(json.dumps({"royLane": len(lane), "handedOver": done,
                      "refused": failed}, indent=2))
    return 1 if failed else 0


def cmd_attach(args):
    dropped = supersede_attachments(args.task, {os.path.basename(p) for p in args.file}) or []
    names = [upload_attachment(args.task, p) for p in args.file]
    purpose = (getattr(args, "purpose", "") or "").strip() or "attached for the approval"
    notes = (get_task(args.task).get("fields", {}) or {}).get(AF["notes"])
    stamps = [superseded_stamp(n) for n in dropped] + [attached_stamp(n, purpose) for n in names]
    patch_task(args.task, {AF["notes"]: append_notes(notes, *stamps)})
    print(json.dumps({"task": args.task, "attached": names, "superseded": dropped}))


# ─── ONE JOB PER CERTIFICATE TYPE AND DISTRICT (Kevin, 17 Sep 2026) ────
#
# The unit of work was one Airtable task at every layer, so three EICR
# renewals in Haverhill (13 and 6 Chedburgh Place, 5 Dalham Place, all CB9)
# became three agent runs, three sets of quote emails to the same electricians
# and three cards. Kevin's ruling in the tranche 3 interview: one piece of
# property work is a certificate type plus a postcode district, for everything
# due inside 60 days. Grouping happens here, at dispatch time; every
# certificate keeps its own task, so nothing is merged and nothing is closed on
# a guess. The earliest-due task LEADS and carries the sibling list; the rest
# are HELD, listed and counted, never dropped. `submit LEAD --siblings` stamps
# each sibling "HELD UNDER recLEAD", and a held task waits while that lead is
# open, then rejoins the board to be closed against its own certificate.
PROPERTY_GROUP_DAYS = 60
HELD_UNDER_RE = re.compile(r"HELD UNDER (rec[A-Za-z0-9]{14})")
CERT_TYPE_PATTERNS = (
    ("EICR", re.compile(r"\bEICR\b|electrical installation", re.I)),
    ("GSC", re.compile(r"\bGSC\b|gas safe|\bCP12\b", re.I)),
    ("EPC", re.compile(r"\bEPC\b|energy performance", re.I)),
    ("EMERGENCY LIGHTING", re.compile(r"emergency lighting", re.I)),
    ("FIRE", re.compile(r"fire (?:alarm|safety|risk)", re.I)),
    ("LICENCE", re.compile(r"\bHMO\b|licen[cs]e", re.I)),
    ("INSURANCE", re.compile(r"insurance", re.I)),
)


def certificate_type(name):
    """The one certificate a task name is about, or "" when none or several."""
    hits = [label for label, rx in CERT_TYPE_PATTERNS if rx.search(str(name or ""))]
    return hits[0] if len(hits) == 1 else ""


def task_district(t, book):
    """Postcode district of the property a task is about, or "" if unclear.

    The property named in the task name wins (via the compliance book), because
    a description can quote a contractor's own postcode first. Two properties in
    different districts in one name is ambiguous, so nothing is grouped.
    """
    name = str(t.get("name") or "")
    found = set()
    for page in book or []:
        short = str(page.get("short") or "").strip()
        if short and re.search(r"(?<![0-9A-Za-z])" + re.escape(short), name, re.I):
            district = postcode_district(page.get("postcode") or page.get("name"))
            if district:
                found.add(district)
    if len(found) == 1:
        return found.pop()
    if found:
        return ""
    return postcode_district(name) or postcode_district(t.get("description"))


def property_group_key(t, book, today):
    """"EICR CB9" for groupable property work, "" for everything else."""
    if t.get("kind") != "new" or t.get("tier1") or t.get("creditor"):
        return ""
    if not str(t.get("name") or "").startswith(COMPLIANCE_TASK_PREFIX):
        return ""
    holders = [t.get("agentId"), t.get("autoTarget")] + list(t.get("teamMemberIds") or [])
    if PROPERTY_REC_ID not in holders:
        return ""
    try:
        due = datetime.strptime(str(t.get("dueDate") or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return ""
    if due > today + timedelta(days=PROPERTY_GROUP_DAYS):
        return ""
    ctype, district = certificate_type(t.get("name")), task_district(t, book)
    return f"{ctype} {district}" if ctype and district else ""


def group_property_work(worklist, book, today):
    """(worklist, held): one lead per certificate type and district, siblings named on it."""
    groups = {}
    for t in worklist:
        key = property_group_key(t, book, today)
        if key:
            groups.setdefault(key, []).append(t)
    held_ids = set()
    for key, members in groups.items():
        if len(members) < 2:
            continue
        members.sort(key=lambda m: (str(m.get("dueDate") or ""), m["id"]))
        lead, rest = members[0], members[1:]
        lead["groupKey"] = key
        lead["siblings"] = [{"id": m["id"], "name": m["name"], "dueDate": m.get("dueDate")}
                            for m in rest]
        for m in rest:
            m["groupKey"], m["groupLead"] = key, lead["id"]
            held_ids.add(m["id"])
    return ([t for t in worklist if t["id"] not in held_ids],
            [t for t in worklist if t["id"] in held_ids])


def held_lead_id(t):
    """The lead a task was submitted under (the newest stamp), or ""."""
    ids = HELD_UNDER_RE.findall(str(t.get("notes") or ""))
    return ids[-1] if ids and ids[-1] != t.get("id") else ""


def open_lead_ids(lead_ids, fetch=None):
    """The subset of lead ids still open. The queue's own read cannot answer
    this: QUEUE_FORMULA leaves out Approval, which is exactly where a submitted
    lead sits. A failed read returns every id, so siblings stay held and
    listed rather than being dispatched a second time."""
    if not lead_ids:
        return set()
    fetch = fetch or query_tasks
    formula = "OR(" + ",".join(f"RECORD_ID()='{i}'" for i in sorted(lead_ids)) + ")"
    try:
        rows = [task_view(r) for r in fetch(formula)]
    except Exception as exc:                              # noqa: BLE001
        print(f"WARNING: lead status read failed, holding siblings: {str(exc)[:120]}",
              file=sys.stderr)
        return set(lead_ids)
    return {r["id"] for r in rows if r.get("status") not in ("Completed", "Cancelled")}


def sibling_problem(lead, sib, book, coverage_text=""):
    """Why `sib` may not be submitted under `lead`, or "" when it may."""
    if sib.get("id") == lead.get("id"):
        return f"{sib.get('id')} is the lead itself"
    if not sib.get("name"):
        return f"{sib.get('id')} could not be read"
    if sib.get("status") in ("Completed", "Cancelled"):
        return f"{sib['id']} is already {sib['status']}"
    if not str(sib["name"]).startswith(COMPLIANCE_TASK_PREFIX):
        return f"{sib['id']} is not a COMPLIANCE task"
    lead_key = (certificate_type(lead.get("name")), task_district(lead, book))
    sib_key = (certificate_type(sib.get("name")), task_district(sib, book))
    if not all(lead_key) or lead_key != sib_key:
        def say(k):
            return " ".join(k) if all(k) else "no readable type and district"
        return f"{sib['id']} is {say(sib_key)}, the lead is {say(lead_key)}"
    if coverage_text:
        covered = {postcode_district(a) for a in coverage_parse(coverage_text)[0]}
        if task_district(sib, book) not in covered:
            return (f"{sib['id']} is in {task_district(sib, book)}, which no PROPERTY "
                    "line in the coverage file declares")
    return ""


def cmd_submit_group(args):
    """`submit`, with --siblings: a property group submitted once on its lead."""
    siblings = [i.strip() for i in (getattr(args, "siblings", None) or "").split(",") if i.strip()]
    if not siblings:
        return cmd_submit(args)
    lead = task_view(get_task(args.task))
    book = compliance_book_pages()
    coverage_text = ""
    if getattr(args, "coverage", None):
        with open(args.coverage) as fh:
            coverage_text = fh.read()
    # Every sibling is checked BEFORE anything is written: a refused sibling
    # stops the whole submit, lead included.
    sib_views = [task_view(get_task(i)) for i in siblings]
    problems = [p for p in (sibling_problem(lead, v, book, coverage_text) for v in sib_views) if p]
    if problems:
        sys.exit(f"ERROR: refusing to submit {args.task} with siblings: " + "; ".join(problems))
    key = f"{certificate_type(lead['name'])} {task_district(lead, book)}"
    # The card names every task it covers, on the line above the carry-out
    # line (which must stay last), so no shape the level check reads moves.
    with open(args.output_file) as fh:
        lines = fh.read().rstrip().split("\n")
    covers = (f"COVERS {len(siblings) + 1} TASKS ({key}): {lead['name']}; "
              + "; ".join(v["name"] for v in sib_views))
    grouped_file = args.output_file + ".group"
    with open(grouped_file, "w") as fh:
        fh.write("\n".join(lines[:-1] + [covers, lines[-1]]) + "\n")
    args.output_file = grouped_file
    rc = cmd_submit(args)
    stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
    for v in sib_views:
        existing = str(v.get("notes") or "").rstrip()
        note = (f"[{stamp} - agent-dispatch] HELD UNDER {args.task} ({key}): worked in one job "
                "and submitted once with the lead. This task waits while the lead is open, "
                "then is closed against its own certificate.")
        patch_task(v["id"], {AF["notes"]: (existing + "\n\n" + note).strip()[-90000:]})
    print(json.dumps({"siblingsHeld": siblings, "lead": args.task, "group": key}))
    return rc


def cmd_submit(args):
    if args.agent not in ALL_AGENTS:
        sys.exit(f"ERROR: {args.agent} is not a dispatchable AI agent record "
                 "(one of the 17 strategic agents or a built role agent)")
    require_role_agent_live(args.agent, "submit")
    if args.type not in TASK_TYPES:
        sys.exit(f"ERROR: Task Type must be one of {TASK_TYPES}")
    with open(args.output_file) as fh:
        output = fh.read().strip()
    if not output:
        # An empty Agent Output makes the Slack post say "nothing to judge".
        sys.exit("ERROR: refusing to submit an empty Agent Output")
    # A TRIAL AGENT SUBMITS DRAFTS, NOTHING THAT ACTS (2 Oct 2026). Every shape below is carried
    # out by something other than send-email.py (Roy's handover email, the diary, the payment
    # list, Adobe, the post), so the send refusal alone would not hold it.
    trial = trial_problem([args.agent])
    if trial and TRIAL_ACTING_SHAPE_RE.search(output):
        sys.exit(f"ERROR: refusing to submit {args.task}: {trial}.\n"
                 "       A trial agent's card is a draft for Kevin to check: an email (TO / FROM /\n"
                 "       SUBJECT) or a plain report. PASS TO ROY, CALENDAR, MARK FOR PAYMENT,\n"
                 "       DOCUMENT and POST shapes act on approval and are not open to it.")
    # Read before EITHER prepend: --tier1 is set by the dispatch queue from a
    # Notes match too, so only a banner the agent wrote into its own file
    # counts as the agent's word for decision_level's close categories.
    agent_banner = TIER1_BANNER in output
    if args.tier1 and TIER1_BANNER not in output:
        output = TIER1_BANNER + "\n\n" + output

    # Kevin's mandate. Checked AFTER the banner so a tier-1 submit is judged on
    # the text that will actually be stored, and refused rather than patched:
    # a fabricated closing line would be the very guesswork this removes.
    # The plain summary is checked FIRST among the content gates: it is the
    # first thing Kevin reads, and it costs the agent one retry to fix. None
    # means an internal caller that never had the flags (argparse requires
    # them on the command line, which is the only way an agent submits).
    plain_task = getattr(args, "plain_task", None)
    plain_approve = getattr(args, "plain_approve", None)
    if plain_task is not None or plain_approve is not None:
        problem = plain_summary_problem(plain_task, plain_approve)
        if problem:
            sys.exit(
                f"ERROR: refusing to submit {args.task} — {problem}.\n"
                "       Kevin's card opens with these two lines (22 Sep 2026):\n"
                "         --plain-task    \"What the task is, in one short sentence\"\n"
                "         --plain-approve \"What happens the moment he taps Approve\"\n"
                "       Write both so a thirteen-year-old understands them. Example:\n"
                "         --plain-task \"A company keeps emailing to say it wants to buy Runpreneur.\"\n"
                "         --plain-approve \"The agent sends one short no-thanks reply and stops answering.\"")

    problem = carry_out_problem(output)
    if problem:
        sys.exit(
            f"ERROR: refusing to submit {args.task} — {problem}.\n"
            f"       End the Agent Output with, as the LAST line:\n"
            f"         {CARRY_OUT_MARKER} <what happens the moment Kevin approves>\n"
            "       Kevin's approval box leads with that line. Without it the\n"
            "       summary is guessed from the first line of the report, which\n"
            "       is exactly what he asked to stop (11 Aug 2026)."
        )

    # A hand-back is refused before anything else is judged: an output that
    # tells Kevin to do the job is not a submission (his ruling, 4 Sep 2026).
    handed = handback_problem(output, args.type)
    if handed and not SIGNIN_NEEDED_RE.search(output):
        sys.exit(
            f"ERROR: refusing to submit {args.task} — it hands Kevin a job instead of "
            f"doing it: {handed!r}.\n"
            "       Kevin's ruling (4 Sep 2026): the gate is a sign-off, not a to-do "
            "list. Either\n"
            "         (a) do it in the agent browser (node scripts/agent-browser.js "
            "read/prepare on an allowlisted site), or\n"
            "         (b) if the site needs his session, put ONE line in the output:\n"
            "               SIGN-IN NEEDED: <site name> (<login url>)\n"
            "             and stop. That line is a tap for him (Robot sign-in app), "
            "not a task. Never a phone call.")

    # The work itself handed to Kevin or "someone" (25 Sep 2026, see
    # WORK_HANDOFF_RE). Refused unless the step is DECLARED as his.
    kevin_step = kevin_only_step(output)
    if kevin_step and kevin_step.get("invalid"):
        sys.exit(
            f"ERROR: refusing to submit {args.task}: its KEVIN ONLY line names "
            f"{kevin_step['reason']!r}. Only these are Kevin's alone: "
            f"{', '.join(KEVIN_ONLY_REASONS)}. Anything else an agent does, or blocks on.")
    if kevin_step and kevin_plan_missing(args.task, "", kevin_step["step"]):
        # The submit path opens the same KEVIN wall `block` does, so it needs the same plan
        # (review, 7 Oct 2026). A plan file written before the submit counts (rent_new_tenant does).
        sys.exit(KEVIN_ONLY_PLAN_REFUSAL.format(task=args.task, reason=kevin_step["reason"],
                                                plan=os.path.join(HANDOVER_DIR, args.task + ".json")))
    handoff = work_handoff_problem(output, kevin_step)
    if handoff and not SIGNIN_NEEDED_RE.search(output):
        sys.exit(
            f"ERROR: refusing to submit {args.task}: its closing line hands the job to Kevin "
            f"or 'someone': {handoff!r}.\n"
            + ("       A KEVIN ONLY line covers only its own step "
               f"({kevin_step['reason']}); this part is still handed over.\n" if kevin_step else "") +
            "       Nothing an agent can do goes back to him as a to-do (Kevin, 25 Sep 2026:\n"
            "       the Swinton policy renewed that way). Do ONE of these:\n"
            "         (a) do the work (the browser, the research, the quote) and submit the result;\n"
            "         (b) if a wall stops you, record it and stop:\n"
            f"               python3 scripts/agent-dispatch.py block {args.task} --kind "
            "SIGN-IN|SITE|TOOL --subject <what> --why \"<what you saw>\"\n"
            "             it is routed to whoever fixes it and the task wakes when it is fixed;\n"
            "         (c) if the one remaining step is Kevin's by rule, declare it on its own line:\n"
            "               KEVIN ONLY: <payment|purchase|signature|credential|identity|physical>: "
            "<the step>\n"
            "             and the task stays open until you see proof it happened.")

    # A SIGN-IN NEEDED line is a tap on the Robot sign-in app, so it must name
    # a site that app can open. On 8 Sep 2026 two tasks said "SIGN-IN NEEDED:
    # Namecheap"; Namecheap is not on the robot's list, the app had nothing to
    # open, and the card promised "the robot finishes this within minutes" for
    # work no robot could do. Refused here, with what to write instead.
    line_sites = load_login_sites() if parse_signin_line(output) else {}
    problem = signin_line_problem(output, line_sites)
    if problem:
        sys.exit(f"ERROR: refusing to submit {args.task} — {problem}")
    line = parse_signin_line(output)
    line_host = signin_site_for(line["site"], line["url"], line_sites) if line else ""
    tried = kevin_tried_reason("SIGN-IN", line_host, line_sites, kevin_tried_since()) if line_host else ""
    if tried:
        sys.exit(f"ERROR: refusing to submit {args.task} — its SIGN-IN NEEDED line names {line['site']!r}, "
                 f"but {tried}. " + KEVIN_TRIED_ROUTE)
    # THE SESSION CHECK (15 Sep 2026): the line is only accepted when the robot
    # really is signed out. recmtmvJTP1MRXLZE wrote SIGN-IN NEEDED: Facebook on
    # 14 Sep while the browser ledger showed the Facebook session live every
    # hour, so Kevin was asked to open a window for a site that needed none.
    # The walk is code (agent-browser.js session); a walk that cannot run
    # marks the line unverified instead of refusing it, so the app can tell.
    problem, output = signin_verify_line(output, line_sites)
    if problem:
        sys.exit(f"ERROR: refusing to submit {args.task} — {problem}")

    # THE REPORT GATE (Kevin, 7 Sep 2026): a report on an inbound item shows
    # the five questions were asked and names its trigger, or it is refused.
    # Read early so a report with nothing to decide can file itself below.
    tf_early = (get_task(args.task).get("fields", {}) or {})
    held = held_card_problem(tf_early)
    if held:
        sys.exit(f"ERROR: refusing to submit {args.task}: {held}.")
    is_inbound = bool(tf_early.get(AF["inboundTask"]))
    # THE TASK IS ON TRIAL TOO (2 Oct 2026): a trial lane's task submitted under another agent's id
    # is held to the same rule as the trial agent's own submit, checked above. So is a task the trial
    # agent holds as Team Member when it is submitted (review, 4 Oct 2026). Submit then writes the
    # submitting agent into both fields, so an email draft on such a task becomes that agent's card.
    trial = trial or trial_problem(links(tf_early.get(AF["teamMember"])),
                                   tf_early.get(AF["name"], ""), tf_early.get(AF["notes"], ""))
    if trial and TRIAL_ACTING_SHAPE_RE.search(output):
        sys.exit(f"ERROR: refusing to submit {args.task}: {trial}.\n"
                 "       This task belongs to a lane on trial, whoever submits it: only a draft email\n"
                 "       or a plain report may go to Kevin's queue for it.")

    # THE WITHDRAWN GATE (25 Sep 2026). A person can cancel a task while an agent is still working
    # on it: the tenant chain withdrew a mail-out card whose change needed code, but the hand-back
    # poll's run had already read it, and 50 minutes later its submit put the card back in Kevin's
    # queue with the contacts he had excluded. A task closed as Cancelled is never revived by a submit.
    if sel(tf_early.get(AF["status"])) == "Cancelled":
        sys.exit(f"ERROR: refusing to submit {args.task}: it was cancelled while you worked on it.\n"
                 "       Someone withdrew it on purpose. Read the newest line of its Notes and stop;\n"
                 "       do not resubmit or reopen it.")

    # THE WALL GATE (25 Sep 2026, review). A submit while a SIGN-IN, SITE or
    # TOOL wall stands would bury it: the card would supersede the wall the
    # agent had just recorded, so Kevin is never asked to fix it and nothing
    # wakes the task. Clear it with evidence first (the site is reachable now,
    # or the work went round it). A KEVIN wall is different: a new card is how
    # the step he owes comes back to him, so it may be resubmitted, never filed.
    cur_wall = task_blocker(tf_early.get(AF["notes"]))
    if cur_wall and cur_wall["kind"] != "KEVIN":
        sys.exit(
            f"ERROR: refusing to submit {args.task}: it is blocked ({cur_wall['kind']} "
            f"{cur_wall['subject']}: {cur_wall['why'][:140]}).\n"
            f"       Fix: {blocker_fix_text(cur_wall)} The task wakes by itself when it is fixed.\n"
            "       If the wall is gone, or your work no longer needs what was behind it, say what\n"
            "       you saw first:\n"
            f"         python3 scripts/agent-dispatch.py unblock {args.task} --evidence \"<what you saw>\"")

    # THE BOUGHT-TWICE GATE (Kevin, 2 Oct 2026). A quote request or a booking
    # for a certificate the book already holds, or that a paid bank line says
    # was already done, is refused before it can reach a contractor. It reads
    # the task already fetched above, and only touches Airtable again when the
    # output IS a purchase step on a COMPLIANCE task. A check that cannot run
    # warns and lets the card through: Kevin still sees it, and the daily
    # paid-but-not-filed check is the backstop.
    try:
        try:
            _subject = (parse_email_output(output) or {}).get("subject") or ""
        except EmailFormatError:
            _subject = ""
        bought = certificate_purchase_problem(tf_early.get(AF["name"], "") or "", output, _subject,
                                              tf_early.get(AF["description"], "") or "")
    except (SystemExit, Exception) as exc:                # noqa: BLE001
        bought = ""
        print(f"WARNING: bought-twice check could not run for {args.task}: {str(exc)[:160]}",
              file=sys.stderr)
    if bought:
        sys.exit(
            f"ERROR: refusing to submit {args.task}: {bought}\n"
            "       Check with: python3 scripts/agent-dispatch.py certificate-gaps "
            "--property <rec> --type <type>")

    # THE FILE GATE (Kevin, 8 Sep 2026): the document the action uses is on
    # the card, from this round, or the submit is refused.
    attach_names = {os.path.basename(p) for p in (getattr(args, "attach", None) or [])}
    problem = document_action_problem(output, args.type, tf_early.get(AF["notes"]), attach_names)
    if problem:
        sys.exit(f"ERROR: refusing to submit {args.task} — {problem}")

    # THE PICTURE GATE (Kevin, 9 Sep 2026): an Operations Director post card without an openable picture link is refused.
    odp = od_picture_problem(tf_early.get(AF["name"], "") or "", output)
    if odp:
        sys.exit(f"ERROR: refusing to submit {args.task} — {odp}")

    # THE TRACK RECORD GATE (Kevin, 8 Sep 2026): a reply, a creditor item or
    # an inbound matter states what has already passed with this contact.
    creditor = ALL_AGENTS.get(args.agent, {}).get("agent") == "creditor-management"
    problem = track_record_problem(output, args.type == "Correspondence" or creditor or is_inbound)
    if problem:
        sys.exit(f"ERROR: refusing to submit {args.task} — {problem}")
    checked = checked_problem(output, args.type, is_inbound)
    if checked:
        sys.exit(f"ERROR: refusing to submit {args.task} — {checked}.\n"
                 "       61% of reports reaching Kevin between 20 Aug and 7 Sep 2026 "
                 "were rejected for one of the five questions. Look first; if nothing "
                 "needs deciding, write trigger=none and it files itself.")

    # THE COVERAGE CHECK (Kevin, 7 Sep 2026): a quote-related email on a
    # property task names only addresses the tradesperson covers.
    coverage_text = ""
    cpath = getattr(args, "coverage", None)
    if cpath:
        with open(cpath) as fh:
            coverage_text = fh.read()
    cov = coverage_problem(coverage_text, output, tf_early.get(AF["name"], "") or "", args.type)
    if cov:
        sys.exit(f"ERROR: refusing to submit {args.task} — {cov}.")

    # Does the closing line promise a send this Task Type cannot deliver?
    # Refused here, not discovered at carry-out after Kevin has approved it.
    promise = send_promise_problem(output, args.type)
    if promise:
        sys.exit(
            f"ERROR: refusing to submit {args.task} — {promise}.\n"
            "       Either resubmit with --type Correspondence and the Agent\n"
            "       Output in TO:/SUBJECT:/---/body form, or reword the closing\n"
            "       line so it describes what Kevin's approval actually does.\n"
            "       An approved action that cannot be carried out is worse than\n"
            "       a refused one: the refusal arrives after the decision."
        )

    # Read once for the gate below; the approver decision further down reuses
    # its own read, because a decision landing between two fetches of the same
    # task is exactly how the two can disagree.
    tf_probe = (get_task(args.task).get("fields", {}) or {})

    # SECOND LABEL, same two-sided contract as tier 1. The queue diverts alert
    # tasks before an agent ever works them; this catches the other blind spot
    # — a task the queue did not classify (no sender recorded, an unfamiliar
    # monitoring address) that an agent has now read and written up as a
    # breakage. Neither side can see what the other sees, so both stay.
    # Sender and NAME only, same veto as build_queue (14 Sep 2026): an agent's
    # own run log in Notes ("Gmail quota") must not turn its submission into a
    # refused "machine alert".
    _pn, _pd, _pnotes = (tf_probe.get(AF["name"], "") or "", tf_probe.get(AF["description"], "") or "",
                         tf_probe.get(AF["notes"], "") or "")
    alert_hit = system_alert_match(tf_probe.get(AF["inboundSender"], ""), _pn)
    if alert_hit and alert_veto({"name": _pn, "description": _pd,
                                 "tier1": bool(tier_match(TIER1_PATTERNS, _pn, _pd, _pnotes)),
                                 "creditor": creditor_match(_pn, _pd, _pnotes)}):
        alert_hit = ""
    # A CLOSE PROPOSAL is the one submission that is ABOUT the task rather
    # than about the breakage: the Task Manager folding a duplicate alert
    # thread into its keeper, or closing a dead one. Refusing it left
    # recPqpTwyBCWs3mPs (an Apps Script alert raised twice by triage) blocked
    # for three consecutive slots on 1-2 Sep 2026 — the duplicate rule said
    # close it, this gate said never submit it, and the board carried the
    # twin for ever. Nothing about the breakage reaches Kevin through a close:
    # he approves removing a duplicate, not investigating a script.
    is_close_proposal = output.lstrip().upper().startswith("CLOSE PROPOSAL:")
    if alert_hit and args.type != "Correspondence" and not is_close_proposal:
        sys.exit(
            f"ERROR: refusing to submit {args.task} for approval — this is a "
            f"machine reporting a breakage (matched {alert_hit!r}), not a "
            "decision for Kevin.\n"
            "       Approving 'investigate the failing script' changes nothing: "
            "agents are read-only on code.\n"
            "       Leave it OPEN on the board with your findings in Notes "
            "(`annotate`). The run report counts it and the\n"
            "       morning digest names the system, so it is visible without "
            "costing him an approval."
        )

    # A Correspondence submit is a promise that send-email.py can carry the
    # action out. Validate with the SAME parser the send gate uses, or the
    # promise is only discovered to be false days later, after Kevin has
    # approved it (finding 20260811-agent-dispatch-085, task recFdEICxHjYCzDkS).
    if args.type == "Correspondence":
        # validate_submission is the STRICT layer: the send path's parser plus
        # the two defaults Kevin was correcting by hand (sender identity and a
        # sign-off with no contact block). It runs only here, never on the send
        # path, so a draft he already approved is still carried out.
        try:
            validate_any_submission(output)
        except EmailFormatError as exc:
            sys.exit(
                f"ERROR: refusing to submit {args.task} as Correspondence — {exc}\n"
                "       Correspondence is one of THREE shapes, all defined in\n"
                "       scripts/agent_email_format.py:\n"
                "         email  TO:/CC:/FROM:/SUBJECT:, `---`, body\n"
                "         post   POST: + address lines, DOCUMENT:, `---`, summary\n"
                "         sign   DOCUMENT:, SIGNERS:, `---`, what it commits Kevin to\n"
                "       An approved action that cannot be carried out is worse\n"
                "       than a refused draft: the refusal arrives after the\n"
                "       decision."
            )

    # A CALENDAR output is the same promise about calendar-write.py. Validated
    # with the SAME parser that script uses, for the same reason as above —
    # and quiet on any output that is not claiming the CALENDAR shape.
    cal_problem = calendar_submit_problem(output, args.type)
    if cal_problem:
        sys.exit(
            f"ERROR: refusing to submit {args.task} — {cal_problem}.\n"
            "       The CALENDAR shape is defined in\n"
            "       scripts/agent_calendar_format.py:\n"
            "         CALENDAR: / TITLE: / START: / END: (YYYY-MM-DD HH:MM,\n"
            "         London), optional LOCATION:/NOTES:, `---`, then a plain\n"
            "         summary. Submit with --type Admin. No attendees ever.\n"
            "       An approved entry that cannot be created is worse than a\n"
            "       refused draft: the refusal arrives after the decision."
        )

    # WHO approves. The task's Approver field decides (set by Inbound Comms at
    # creation: label 8 = Mica, label 12 = Kevin); empty means Kevin. Tier 1
    # ALWAYS diverts to Kevin whatever the field says — his private legal and
    # financial matters never route to the team. The banner check catches a
    # tier-1 connection the agent only discovered while working, and the
    # pattern re-check catches a dispatcher that forgot --tier1.
    # Read once and reuse: the approver decision and the feedback archive below
    # both need the stored record, and two fetches of the same task can
    # disagree if a decision lands between them.
    trec = get_task(args.task)
    tf = (trec.get("fields", {}) or {})
    approver_email = KEVIN_AIRTABLE_EMAIL
    is_tier1 = bool(args.tier1) or TIER1_BANNER in output
    if not is_tier1:
        if tier_match(TIER1_PATTERNS, tf.get(AF["name"]),
                      tf.get(AF["description"]), tf.get(AF["notes"])):
            is_tier1 = True
        else:
            approver_email = (tf.get(AF["approver"]) or {}).get(
                "email") or KEVIN_AIRTABLE_EMAIL
    # A tier-1 detected here (banner or pattern) must carry the banner too —
    # the label travels with the work, however it was spotted.
    if is_tier1 and TIER1_BANNER not in output:
        output = TIER1_BANNER + "\n\n" + output

    # The gate: prepared, proposed, and NOTHING sent, filed or executed.
    #
    # Clearing the approval fields is part of the gate, not tidiness. Before
    # 11 Aug 2026 submit left a previous verdict standing, so a task resubmitted
    # with brand new words still read 'Approved as-is' — send-email.py and the
    # queue classifier both gate on that field alone, and would have carried out
    # text Kevin never saw. The mirror image broke the redo path: a stale
    # 'Changes requested' re-queued the same task as a redo on every run.
    # ARCHIVE BEFORE THE WIPE. Clearing Approval Feedback below is correct for
    # the gate, but it also destroyed the record: 54 redos ran between 24 and
    # 26 Aug 2026 and only 8 still carried the words that caused them, so the
    # feedback could not be reviewed, counted or learned from after the fact.
    # Append-only, and it costs one field.
    prior = str(tf.get(AF["approvalFeedback"]) or "").strip()
    archived = None
    if prior:
        hist = str(tf.get(AF["feedbackHistory"]) or "")
        stamp = datetime.now(LONDON).strftime("%Y-%m-%d %H:%M")
        block = f"[{stamp}] {prior}"
        # Stamps ignored: the decision surface already archived these words.
        if not feedback_archived(hist, prior):
            archived = (hist.rstrip() + "\n\n" + block).strip()

    # THE REDO RECEIPT (Kevin, 7 Sep 2026). A resubmission after Changes
    # requested must answer his points one by one, and must differ from the
    # text he sent back. The receipt lands in Notes; his card leads with it.
    stored_outcome = sel(tf.get(AF["approvalOutcome"]))
    stored_output = str(tf.get(AF["agentOutput"]) or "")
    if stored_outcome == "Changes requested" and prior:
        receipt_text = ""
        rpath = getattr(args, "receipt", None)
        if rpath:
            with open(rpath) as fh:
                receipt_text = fh.read()
        problem = receipt_problem(receipt_text, prior, stored_output, output)
        if problem:
            sys.exit(
                f"ERROR: refusing to resubmit {args.task} — {problem}.\n"
                "       Kevin's words were:\n"
                + "".join(f"         · {pt}\n" for pt in feedback_points(prior))
                + "       Write one line per point to a file and pass it with --receipt:\n"
                "         - <his point> → <what changed>\n"
                "         - <his point> → cannot: <why>\n"
                "       His card shows these lines first, so he sees he was understood "
                "before he reads the draft (30 of 132 feedback tasks went round twice, "
                "7 Sep 2026).")
        round_no = receipt_round(tf.get(AF["notes"]), args.task)
        rb = receipt_block(receipt_text, round_no,
                           datetime.now(LONDON).strftime("%d %b %Y %H:%M"))
        # Written into the local copy so every write path below (filed,
        # handled, card) carries it as part of "existing" Notes.
        tf[AF["notes"]] = (str(tf.get(AF["notes"]) or "").rstrip() + "\n\n" + rb).strip()
        tf["_receiptAdded"] = True
    if coverage_text and coverage_parse(coverage_text)[0]:
        cs = coverage_stamp(coverage_text, datetime.now(LONDON).strftime("%d %b %Y %H:%M"))
        tf[AF["notes"]] = (str(tf.get(AF["notes"]) or "").rstrip() + "\n\n" + cs).strip()
        tf["_receiptAdded"] = True   # the same "write Notes on the card path" switch

    # The files go up FIRST. If one is refused the run stops here with the
    # task still unsubmitted — better than an approval card promising a
    # letter that never arrived.
    # getattr, not args.attach: cmd_submit is called with hand-built args in
    # seventeen tests and any internal caller, none of which know about a flag
    # added later. A new optional flag must never make an existing caller crash.
    to_attach = list(getattr(args, "attach", None) or [])
    # `or []`: internal callers and tests stub supersede_attachments to None.
    dropped = supersede_attachments(args.task, {os.path.basename(p) for p in to_attach}) or []
    uploaded = [upload_attachment(args.task, path) for path in to_attach]
    # The trail: which file came with which round, and that a submit happened.
    round_no = submitted_round(tf.get(AF["notes"]))
    # The stamp names EVERY file of the round, including one put on with a
    # separate `attach` before this submit; the card reads the round from it.
    round_files = uploaded + sorted(files_this_round(tf.get(AF["notes"])) - set(uploaded))
    stamps = ([superseded_stamp(n) for n in dropped]
              + [attached_stamp(n, f"with this submission (round {round_no})") for n in uploaded]
              + [submitted_stamp(round_no, args.type, round_files)])
    tf[AF["notes"]] = append_notes(tf.get(AF["notes"]), *stamps)
    tf["_receiptAdded"] = True

    files_itself = informational_only(output, args.type, tier1=bool(getattr(args, "tier1", False)))
    if not files_itself and is_inbound and args.type in REPORT_TYPES \
            and checked_trigger(output) == "none" and not is_tier1:
        files_itself = True
    if kevin_step or cur_wall:
        # A step Kevin still owes is not information, and not a close.
        files_itself = False
    # A task that received a certificate is not "nothing to decide" until the
    # certificate is in the book (2 Oct 2026): the 16 Sep invoice task reported
    # "payment verified" and closed itself with the gas record unfiled. It goes
    # to the queue as a card instead, where the unfiled certificate is visible.
    cert_owed = task_fields_owe_certificate(args.task, tf)
    if cert_owed:
        files_itself = False
    if files_itself:
        stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
        note = (f"[{stamp} — agent-dispatch] FILED, not queued: "
                + ("the CHECKED line says trigger=none, so nothing needs deciding "
                   "(the report gate, 7 Sep 2026). "
                   if checked_trigger(output) == "none" and not informational_only(output, args.type)
                   else "the closing line says nothing happens on approval, so there is "
                        "no decision here (Kevin's ruling, 4 Sep 2026). ")
                + "The report is in Agent Output.")
        filed = {
            AF["agentOutput"]: output[:95000],
            AF["taskType"]: args.type,
            AF["status"]: "Completed",
            AF["completion"]: now_iso(),
            AF["teamMember"]: [args.agent],
            AF["sentForApprovalBy"]: [],
            AF["assignee"]: None,
            AF["approvalOutcome"]: None,
            AF["approvalFeedback"]: None,
            AF["approvedAt"]: None,
            AF["notes"]: (str(tf.get(AF["notes"]) or "").rstrip() + "\n\n" + note).strip()[-90000:],
            **plain_summary_fields(args),
        }
        # Attachments were uploaded above, once; never again here.
        patch_task(args.task, filed)
        print(json.dumps({"submitted": args.task, "filed": True, "status": "Completed",
                          "type": args.type, "attached": len(to_attach),
                          "why": "informational output: nothing to approve"}))
        return 0

    # ─── LEVEL A: the agent acts (Kevin's ruling, 7 Sep 2026) ────────────
    # Decided from the output's shape with the evidence verified; a tier-1
    # matter (banner or pattern, checked above) never takes this branch.
    level = decision_level(output, args.type, trec, agent_banner=agent_banner)
    # tierChecked: the two verifiable closes ran their own tier check inside
    # decision_level (name, description, banner — never the Notes, which hold
    # every agent's run log), so is_tier1 from the Notes must not re-veto them.
    if cert_owed and level["level"] == AUTONOMY_ACT and level.get("carry") != "roy" \
            and level.get("rule") != "quote-request":
        # Level A would end this task Completed (a close, a diary entry, a fixed
        # redirect) with the certificate unfiled. It goes to the queue as a card.
        level = dict(level, level=AUTONOMY_APPROVE,
                     why="a certificate arrived on this task and is not filed yet")
    if level["level"] == AUTONOMY_ACT and (not is_tier1 or level.get("tierChecked")) and not (kevin_step or cur_wall):
        return handle_without_kevin(args, output, trec, level, to_attach)
    if level["level"] == AUTONOMY_APPROVE and level["category"] not in ("other",):
        # Say WHY a shaped output still became a card, so a Task Manager that
        # cited a bad keeper learns it from the run, not from Kevin's tap.
        print(json.dumps({"task": args.task, "level": AUTONOMY_APPROVE,
                          "category": level["category"], "why": level["why"]}),
              file=sys.stderr)

    # Kevin's ruling, 4 Sep 2026: a sign-in wait must not reach him piecemeal
    # through the day. It is parked until tomorrow's 08:00 message, which lists
    # every site in one go, and the card then carries the one-tap link.
    signin_wait = bool(SIGNIN_NEEDED_RE.search(output))

    fields = {
        AF["agentOutput"]: output[:95000],
        AF["taskType"]: args.type,
        AF["status"]: "Approval",
        AF["sentForApprovalBy"]: [args.agent],
        AF["teamMember"]: [args.agent],
        AF["assignee"]: {"email": approver_email},
        AF["dueDate"]: today_london(),
        AF["approvalOutcome"]: None,
        AF["approvalFeedback"]: None,
        AF["approvedAt"]: None,
        # Submitting reopens the task, so the completion stamp goes too. A task
        # completed once and later resubmitted kept its old stamp and stayed in
        # every throughput and Completed Month figure as finished work.
        AF["completion"]: None,
    }
    fields.update(plain_summary_fields(args))
    if signin_wait:
        fields[AF["deferredUntil"]] = tomorrow_london()
    if archived:
        fields[AF["feedbackHistory"]] = archived
    if tf.get("_receiptAdded"):
        fields[AF["notes"]] = str(tf.get(AF["notes"]) or "")[-90000:]
    walled = submit_wall_notes(tf.get(AF["notes"]), kevin_step)
    if walled is not None:
        fields[AF["notes"]] = walled
    # RESET THE REMEMBER CYCLE, BUT ONLY ONCE THE LESSON IS SAFE. An agent can
    # redo and resubmit inside the 30-minute lesson poll, so clearing the flag
    # unconditionally would drop exactly the lessons from the fastest redos.
    # Cleared together with the stamp so a later "remember" on this same task
    # is not mistaken for one already stored.
    if str(tf.get(AF["lessonWrittenAt"]) or "").strip():
        fields[AF["rememberThis"]] = False
        fields[AF["lessonWrittenAt"]] = None
    # Tier 1 moves the APPROVER field too, not just the assignee. The Slack
    # router reads Approver to decide whose channel the card lands in, so
    # leaving it on Mica while the engine had already decided "Kevin only" put
    # the two halves in disagreement — and the half that picks the channel was
    # the one still saying Mica. Write the decision into the field the router
    # reads. Never the reverse: a non-tier-1 submit leaves Approver alone,
    # because Inbound Comms set it at creation and this is not that decision.
    if is_tier1:
        fields[AF["approver"]] = {"email": KEVIN_AIRTABLE_EMAIL}
    patch_task(args.task, fields)

    # READ THE RECORD BACK (finding 20260823-queue-fixer-329).
    #
    # SKILL.md step 4 has told the dispatcher since 19 Aug that submit "reads
    # the record back and exits non-zero if the Agent Output is empty or the
    # Status did not move". It did not. Its only get_task was the approver
    # lookup BEFORE the patch, so a submit was recorded green on the strength of
    # a 200 — which is exactly how a finished tier-1 deliverable with a five-day
    # court deadline came to sit on disk with an empty Agent Output while
    # nothing alarmed.
    #
    # A PATCH returning 200 says the request was ACCEPTED. It does not say the
    # field holds what you sent: a truncated write, a field-permission change or
    # an automation firing on the same record all return 200 and leave the task
    # unsubmitted. The dispatcher acts on the exit code, so the exit code has to
    # mean something.
    check = get_task(args.task).get("fields", {}) or {}
    stored = (check.get(AF["agentOutput"]) or "").strip()
    status = check.get(AF["status"])
    if not stored:
        sys.exit(
            f"ERROR: submit of {args.task} did not stick — Agent Output is EMPTY "
            "after the write.\n"
            "       The PATCH returned 200 and the field is blank, so the work "
            "has NOT reached Kevin.\n"
            "       Do not record this task as submitted. Retry the submit."
        )
    if status != "Approval":
        sys.exit(
            f"ERROR: submit of {args.task} did not stick — Status is "
            f"{status!r}, not 'Approval'.\n"
            "       The task is not in the approval queue and Kevin will never "
            "see it. Retry the submit."
        )

    print(json.dumps({"submitted": args.task,
                      "agent": ALL_AGENTS[args.agent]["name"],
                      "type": args.type, "tier1": is_tier1,
                      "approver": approver_email,
                      "chars": len(output),
                      # Proof, not assertion: what the record HOLDS, read back
                      # after the write.
                      "verified": {"storedChars": len(stored), "status": status}}))


def cmd_annotate(args):
    # Approved carry-outs usually include "close with a note". Notes is
    # append-only here: never overwrite what a human wrote.
    # A note that opens PARKED or BLOCKED used to rest the task for a day and
    # nothing else: no kind, no owner, no wake. 6 Chedburgh Place was parked
    # nine times that way while its house had no insurance (25 Sep 2026). A
    # wall is now a `block` with a kind, which routes the fix and wakes the
    # task when it lands. The free-text form is refused so it cannot come back.
    if BLOCKER_OPEN_MARK in (args.note or "") or BLOCKER_CLEARED_MARK in (args.note or ""):
        # Only block, unblock (with evidence) and the sweep write these lines; a
        # hand-written CLEARED line would let a task close with nothing proved.
        sys.exit(f"ERROR: refusing a note on {args.task} that writes a blocker line. Use\n"
                 f"         python3 scripts/agent-dispatch.py block|unblock {args.task} ...")
    if PARKED_NOTE_RE.match(args.note or ""):
        sys.exit(
            f"ERROR: refusing a PARKED/BLOCKED note on {args.task}. A wall is recorded with\n"
            "       its kind, so the fix is routed and the task wakes when it lands:\n"
            f"         python3 scripts/agent-dispatch.py block {args.task} --kind <KIND> "
            "--subject <what> --why \"<what you saw>\"\n"
            "       SIGN-IN  a site on the robot's list is signed out   (--subject <host>)\n"
            "       SITE     the robot's list cannot reach the site     (--subject <host>)\n"
            "       TOOL     the robot's own setup is broken            (--subject <short name>)\n"
            f"       KEVIN    only Kevin may: {', '.join(KEVIN_ONLY_REASONS)}  (--subject <that word>)")
    t = get_task(args.task)
    existing = t.get("fields", {}).get(AF["notes"], "")
    stamp = datetime.now(LONDON).strftime("%d %b %Y")
    note = f"[{stamp} — agent] {args.note}"
    patch_task(args.task, {
        AF["notes"]: (existing + "\n\n" + note).strip(),
    })
    print(json.dumps({"annotated": args.task, "chars": len(note), "parked": False}))


# ─── MOVING A DUE DATE ON KEVIN'S WORD (9 Oct 2026) ──────────────────
#
# "Give him a week's grace and then chase this up again next week" (Kevin, 8 Oct
# 2026, 34 Connaught Road) had nowhere to go: no subcommand moved a due date, so
# the agent filed a finding, the finding went to the overflow log, and the task
# sat at Today with the wrong date. The same wall stood on "bring this back in
# January" and "move it to Monday 2 November" cards (finding 20261002-727 and the
# 8 Oct overflow line). A task comes to the table when it needs to, not before or
# after, only if the date Kevin gave is the date on the task.
#
# A due date moves only on Kevin's word: --quote must be his own words, verbatim,
# from his feedback on that task, and a date more than DUE_FAR_DAYS out needs his
# words to name a month or a date (independent review, 9 Oct 2026: any old note of
# his must not let an agent push its own work out by months). An agent never
# pushes its own work out. Never to a past date, never on a closed task, never on
# a card waiting at Approval (his queue) or a task a robot holds In Progress.
DUE_MOVED_MARK = "DUE MOVED"
DUE_FAR_DAYS = 31
# Review round 2 (9 Oct 2026): a quote from ANY old round, a stamp inside the quote, the word "may" or "3-4" let a
# far date through. So: his NEWEST note only, stamps stripped, and the month or date he names must be the new one's.
FEEDBACK_STAMP = re.compile(r"\[\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?\]")
_MONTH_NUM = {m: i + 1 for i, m in enumerate(("january", "february", "march", "april", "may", "june", "july", "august",
                                              "september", "october", "november", "december"))}
_MONTH_NUM.update({k[:3]: v for k, v in list(_MONTH_NUM.items()) if k != "may"})
_MONTH_NUM["sept"] = 9
_MONTH_WORD = re.compile(r"\b(" + "|".join(sorted((k for k in _MONTH_NUM if k != "may"), key=len, reverse=True)) + r")\b", re.I)


def _norm_words(text):
    return " ".join(str(text or "").split()).lower()


def kevins_newest_note(fields):
    """His newest words on the task: the live Approval Feedback, else the last stamped block of Feedback History."""
    live = str(fields.get(AF["approvalFeedback"]) or "").strip()
    if live:
        return live
    blocks = FEEDBACK_STAMP.split(str(fields.get(AF["feedbackHistory"]) or ""))
    return blocks[-1].strip() if blocks else ""


def quote_names_date(quote, new_due):
    """True when his words name the new date's month, or the new date itself (dd/mm[/yy], or YYYY-MM-DD)."""
    if new_due.isoformat() in quote:
        return True
    for d, m in re.findall(r"\b(\d{1,2})/(\d{1,2})(?:/\d{2,4})?\b", quote):
        if (int(d), int(m)) == (new_due.day, new_due.month):
            return True
    return any(_MONTH_NUM[w.lower()] == new_due.month for w in _MONTH_WORD.findall(quote))


def due_move_problem(fields, new_due, today, quote):
    """'' when the due date may move to new_due on these words of Kevin's, else why not."""
    status = sel(fields.get(AF["status"]))
    if status in ("Completed", "Cancelled"):
        return f"the task is {status}"
    if status == "Approval":
        return "the task is waiting at Approval in Kevin's queue; his knock-back sets that date"
    if status == "In Progress":
        return "a robot holds the task In Progress; its own lane moves it"
    if new_due < today:
        return f"{new_due.isoformat()} is in the past"
    q = _norm_words(FEEDBACK_STAMP.sub(" ", quote or ""))
    if len(q) < 12 or q not in _norm_words(kevins_newest_note(fields)):
        return ("--quote is not Kevin's own words in his NEWEST note on this task (Approval Feedback, else the last "
                "entry of Feedback History), word for word; an agent never moves its own work")
    if (new_due - today).days > DUE_FAR_DAYS and not quote_names_date(FEEDBACK_STAMP.sub(" ", quote), new_due):
        return (f"{new_due.isoformat()} is more than {DUE_FAR_DAYS} days out and Kevin's quoted words do not name its "
                "month or date: quote the words that say when")
    return ""


def cmd_due(args):
    try:
        new_due = datetime.strptime(args.date, "%Y-%m-%d").date()
    except ValueError:
        sys.exit(f"ERROR: {args.date!r} is not a date (YYYY-MM-DD)")
    why = " ".join(str(args.why or "").split())
    if len(why) < 10:
        sys.exit("ERROR: --why needs Kevin's words or the reason, in a sentence")
    t = get_task(args.task)
    fields = t.get("fields", {}) or {}
    today = datetime.now(LONDON).date()
    problem = due_move_problem(fields, new_due, today, args.quote)
    if problem:
        print(json.dumps({"refused": args.task, "why": problem}))
        return 2
    old = fields.get(AF["dueDate"]) or "blank"
    status = "Upcoming" if new_due > today else "Today"
    stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
    quoted = " ".join(str(args.quote).split())
    note = (f"[{stamp} — agent-dispatch] {DUE_MOVED_MARK} from {old} to {new_due.isoformat()}: {why} "
            f"(Kevin: \"{quoted}\")")
    patch_task(args.task, {
        AF["dueDate"]: new_due.isoformat(),
        AF["status"]: status,
        AF["notes"]: (str(fields.get(AF["notes"]) or "") + "\n\n" + note).strip(),
    })
    check = get_task(args.task).get("fields", {}) or {}
    if str(check.get(AF["dueDate"]) or "") != new_due.isoformat():
        sys.exit(f"ERROR: {args.task} reads due {check.get(AF['dueDate'])!r} after writing {new_due.isoformat()}")
    print(json.dumps({"due": args.task, "from": old, "to": new_due.isoformat(), "status": status}))
    return 0


# ─── THE LEARNING LOOP ────────────────────────────────────────────────
#
# Kevin's question, 26 Aug 2026: "how do I know the feedback is being taken by
# the agent and that it is learning from it?" The honest answer at the time was
# that it was not. Feedback reached the agent for that ONE task and was then
# wiped by the next submit; rejections never reached an agent at all. The rule
# saying to record a lesson lived in a skill document, so skipping it was free
# and silent, and 54 redos in three days produced zero stored lessons.
#
# So the write is HERE, in code, and cmd_verify fails a run that leaves one
# unwritten. Two properties matter more than sophistication:
#
#   1. THE FILE IS THE DELIVERY MECHANISM. ~/.claude/agents/<agent>.md IS the
#      agent's system prompt — every one of the 20 agents has one. A lesson in
#      that file is read on the agent's next run whether or not anything
#      remembers to inject it. The register Learning Log is MIRRORED for the
#      app to display, never relied on for delivery.
#   2. KEVIN CLASSIFIES, NOTHING GUESSES. A lesson is stored only when he
#      ticked "Reject and remember" (or the same box on another verdict), so
#      "no action, Roy handles this" becomes a rule and "wrong invoice number"
#      stays a one-off. This is what keeps the logs from filling with noise.
AGENT_DIR = os.path.expanduser("~/.claude/agents")
LESSONS_HEADING = "## Lessons from Kevin"
LESSONS_PREAMBLE = (
    "Standing rules from Kevin's approval decisions. Each line is a verdict he\n"
    "asked to be remembered. Apply every one before drafting anything; if a\n"
    "lesson conflicts with the task you have been given, say so rather than\n"
    "guessing. Appended by `scripts/agent-dispatch.py lessons` — never edit a\n"
    "line to change its meaning, and never delete one without Kevin's say-so."
)
# Past this many lines the log is more prompt than instruction and wants a
# distil pass in a build session. A soft signal in the JSON, never a silent
# truncation: dropping Kevin's rulings to stay tidy is the one failure this
# whole mechanism exists to prevent.
LESSON_SOFT_CAP = 30
# Three missed 30-minute polls. Anything older is a broken writer, not a lag.
LESSON_GRACE_MIN = 90


def lesson_line(date, task_name, feedback):
    """One dated line, Kevin's words kept intact.

    Deliberately NOT summarised by a model here. A model pass can improve the
    wording later, but the raw sentence is the thing that must survive: the
    generalise-first design is what produced nothing at all for three days."""
    name = " ".join(str(task_name or "untitled task").split())[:70]
    words = " ".join(str(feedback or "").split())[:400]
    return f"- {date}: {name} — {words}"


def _lessons_section_bounds(text):
    """Where the lessons live, so a line is appended INSIDE the section even
    when later sections follow it. Appending at end-of-file looked right until
    someone added a section below, which silently orphaned every new lesson.
    A generated block's opening marker ends the section too (7 Oct 2026): the
    binding rules block opens with a marker line BEFORE its own "## " heading,
    so 18 lessons landed inside it that day, the block read as stale in 5 of 24
    agents, the test gate went red, and the next push would have deleted them."""
    start = text.find(LESSONS_HEADING)
    if start == -1:
        return None
    body = start + len(LESSONS_HEADING)
    nxt = re.search(r"^(?:## |<!-- )", text[body:], re.M)
    return (start, body + nxt.start() if nxt else len(text))


def append_lesson_to_file(agent_slug, line):
    """Append one lesson to the agent's definition file. Idempotent on the
    exact line, so a re-run after a crash cannot duplicate it."""
    path = os.path.join(AGENT_DIR, f"{agent_slug}.md")
    if not os.path.exists(path):
        raise RuntimeError(f"no agent file at {path}")
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    if line in text:
        return {"path": path, "written": False, "reason": "already present"}
    bounds = _lessons_section_bounds(text)
    if bounds is None:
        new = (text.rstrip("\n") + "\n\n" + LESSONS_HEADING + "\n\n"
               + LESSONS_PREAMBLE + "\n\n" + line + "\n")
    else:
        _, end = bounds
        section = text[:end].rstrip("\n")
        new = section + "\n" + line + "\n" + text[end:]
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(new)
    os.replace(tmp, path)          # atomic: a crash never truncates the prompt
    with open(path, encoding="utf-8") as fh:
        landed = fh.read()
    if line not in landed:         # claimed writes get checked, always
        raise RuntimeError(f"lesson did not land in {path}")
    bounds = _lessons_section_bounds(landed)
    count = len([l for l in landed[bounds[0]:bounds[1]].splitlines()
                 if l.startswith("- ")]) if bounds else 0
    return {"path": path, "written": True, "lessonCount": count}


def mirror_lesson_to_register(register_row, line):
    """Role agents also show their log in the app. Append, never overwrite."""
    rec = _request("GET", f"/{AGENTS_TABLE}/{register_row}"
                          "?returnFieldsByFieldId=true")
    existing = rec.get("fields", {}).get(REGISTER_FIELDS["learningLog"], "")
    if line in existing:
        return False
    _request("PATCH", f"/{AGENTS_TABLE}/{register_row}", {"fields": {
        REGISTER_FIELDS["learningLog"]: (existing.rstrip() + "\n" + line).strip(),
    }})
    return True


# ─── A LOOM IS FEEDBACK TOO (28 Aug 2026) ───────────────────────────
#
# Kevin asked whether he could attach a Loom to his approval feedback and have
# the agent actually understand it. He can now: paste the share link into the
# feedback box and the transcript is fetched and handed to the agent with his
# typed words.
#
# Loom exposes an auto-generated transcript through a PUBLIC GraphQL endpoint —
# no auth, no cookies, no allowlist entry needed, so this works from a headless
# run where his Chrome connector cannot be reached. The fetcher already existed
# for the transcript-to-brain skill; it was BROKEN (Loom removed the `id` field
# and the query failed validation for every video) and was fixed in the same
# change.
#
# THE RULE THAT MATTERS: a Loom that cannot be read is said out loud, never
# swallowed. If the fetch fails and the feedback silently carries on as the
# typed words alone, Kevin believes his video was taken into account when it
# never was — and he would have no way to tell. That is worse than not offering
# the feature. So a failure is written INTO the feedback the agent reads, and
# the agent is told to say so rather than guess what the video said.
LOOM_URL_RE = re.compile(
    r"https?://(?:www\.)?loom\.com/(?:share|embed)/([0-9a-f]{32})", re.I)
LOOM_FETCHER = os.path.expanduser(
    "~/.claude/skills/transcript-to-brain/scripts/fetch_loom_transcript.py")
# A five-minute Loom is roughly 750 words. The agent gets the whole thing for
# the task in hand; only the STANDING lesson is capped, further down.
LOOM_FETCH_TIMEOUT = 45


def fetch_loom_transcript(url):
    """(transcript, error). Exactly one of the two is non-empty."""
    if not os.path.exists(LOOM_FETCHER):
        return "", f"the Loom fetcher is missing at {LOOM_FETCHER}"
    try:
        res = subprocess.run([sys.executable, LOOM_FETCHER, url],
                             capture_output=True, text=True,
                             timeout=LOOM_FETCH_TIMEOUT)
    except subprocess.TimeoutExpired:
        return "", f"Loom did not answer within {LOOM_FETCH_TIMEOUT}s"
    except Exception as exc:                                   # noqa: BLE001
        return "", f"could not run the Loom fetcher: {exc}"
    out = (res.stdout or "").strip()
    if res.returncode != 0 or not out:
        why = (res.stderr or out or "no transcript returned").strip()
        return "", why.splitlines()[0][:200]
    return out, ""


def expand_looms(text):
    """Kevin's words with any Loom link replaced by its transcript.

    Unchanged when there is no Loom link — no network call, no cost on the
    99% of feedback that is typed.
    """
    raw = str(text or "")
    urls = []
    for m in LOOM_URL_RE.finditer(raw):
        if m.group(0) not in urls:
            urls.append(m.group(0))
    if not urls:
        return raw
    parts = [raw]
    for url in urls:
        transcript, err = fetch_loom_transcript(url)
        if transcript:
            parts.append(
                f"\n\n--- WHAT KEVIN SAID IN THE LOOM ({url}) ---\n"
                f"This is an automatic transcript of the video he attached. Treat it\n"
                f"as his instruction, exactly like typed feedback.\n\n{transcript}")
        else:
            # Loud, and in the agent's own input. Never silent.
            parts.append(
                f"\n\n--- LOOM COULD NOT BE READ ({url}) ---\n"
                f"Reason: {err}\n"
                f"Do NOT guess what the video said. Do the part of the task his typed\n"
                f"words cover, and say plainly in your output that the video could not\n"
                f"be read and what you still need from him.")
    return "".join(parts)


def lesson_source_text(f):
    """Kevin's words. Approval Feedback is cleared on every resubmit, so a
    redo's feedback can be gone before the writer next runs — Feedback History
    is the durable copy the three decision surfaces also write."""
    live = str(f.get(AF["approvalFeedback"]) or "").strip()
    if live:
        return live
    hist = str(f.get(AF["feedbackHistory"]) or "").strip()
    return hist.split("\n\n")[-1].strip() if hist else ""


# ─── WHICH AGENT A LESSON BELONGS TO (27 Aug 2026) ──────────────────
#
# Until now every lesson went to whoever DRAFTED the work. Measured across all
# 58 rejections Kevin had ever made, that was wrong 58 times out of 58: not one
# was about the draft. "Only show me tasks like this if it's a major issue"
# landed on the Response agent, which never chose to be given the task and
# cannot stop the next one being created. He was teaching the wrong agent.
#
# The rule is simple once the reason is recorded: a lesson about whether the
# work should have been DONE belongs to whoever decided it was worth doing; a
# lesson about how it was WRITTEN belongs to whoever wrote it.
#
# For an inbound task the commissioner is always Inbound Comms Triage. For
# anything else the raising agent IS the commissioner, so nothing changes — and
# that fallback is deliberate rather than lazy: routing a non-inbound relevance
# lesson to triage would teach it about work it never saw.
RELEVANCE_REASONS = (
    "Already done elsewhere",
    "Roy owns it",
    "Not worth my attention",
    "Duplicate",
    "Parked for now",
    "No longer relevant",
)
QUALITY_REASON = "The work is wrong"
TRIAGE_REC_ID = "recCUfsTXzmVZynEI"

# Prefixes triage itself stamps on the tasks it raises. Checked alongside the
# Inbound Task checkbox because the two disagree on the live board: some rows
# carry the prefix with the box unticked.
INBOUND_NAME_RE = re.compile(r"^\s*(INBOUND|MAINTENANCE)\b", re.I)


def lesson_destination(fields, raiser_id):
    """(rec_id, why) — which agent this lesson is FOR.

    Returns the raiser unchanged unless Kevin's reason says the task should not
    have existed AND the task came in through triage.
    """
    reason = sel(fields.get(AF["verdictReason"]))
    if reason not in RELEVANCE_REASONS:
        # No reason recorded, or "The work is wrong". Both mean the drafting
        # agent. An unrecorded reason is NOT guessed at: routing on a guess is
        # how a rule ends up in a file nobody meant to change.
        return raiser_id, ""
    inbound = bool(fields.get(AF["inboundTask"])) or bool(
        INBOUND_NAME_RE.match(str(fields.get(AF["name"]) or "")))
    if not inbound:
        return raiser_id, ""
    return TRIAGE_REC_ID, reason


def pending_lessons():
    """Decided tasks Kevin asked to be remembered that have no lesson yet."""
    return query_tasks(
        "AND({Remember This}, LEN({Lesson Written At}&'')=0)")


def cmd_lessons(args):
    # THE CONTROL. The formula matches on field NAMES, so a rename returns
    # 200 OK with zero rows and this reads as "nothing to do" for ever — the
    # exact silent-zero failure CLAUDE.md was written about. An empty pending
    # list is only trustworthy if the field can still be seen at all, which is
    # what `remembered` proves once a single lesson has ever been stored.
    remembered = query_tasks("{Remember This}", minimal=True)
    stamped = query_tasks("LEN({Lesson Written At}&'')>0", minimal=True)
    if not remembered and stamped:
        raise RuntimeError(
            "CONTROL FAILED: no task matches {Remember This} yet "
            f"{len(stamped)} carry a Lesson Written At stamp. The field has "
            "been renamed or the formula no longer sees it — every lesson "
            "Kevin stores from now on would be silently dropped.")

    written, problems, not_agents = [], [], []
    for rec in pending_lessons():
        f = rec.get("fields", {})
        task_id = rec["id"]
        name = f.get(AF["name"], "")
        # A robot form card is the rent check's rules, drafted by no agent: Kevin's words stay on the
        # card (his request for changes is quoted on the next one) and never become an agent's rule.
        # Stamped as handled, so it is never pending and never an overdue lesson for verify.
        if form_card(name, f.get(AF["notes"])):
            try:
                patch_task(task_id, {AF["lessonWrittenAt"]: now_iso()})
                not_agents.append(task_id)
            except Exception as e:                    # noqa: BLE001
                problems.append({"task": task_id, "name": name, "error": str(e)})
            continue
        words = lesson_source_text(f)
        if not words:
            problems.append({"task": task_id, "name": name,
                             "error": "Remember ticked but no feedback text"})
            continue
        agent_recs = (links(f.get(AF["sentForApprovalBy"]))
                      or links(f.get(AF["teamMember"])))
        raiser = agent_recs[0] if agent_recs else None
        # Route by WHY, not by who happened to hold the pen.
        target, rerouted = lesson_destination(f, raiser)
        entry = ALL_AGENTS.get(target) if target else None
        if not entry:
            # Never silently dropped: a lesson with nowhere to land is the
            # failure, so it stays pending and shows up in the run report.
            problems.append({"task": task_id, "name": name,
                             "error": "no known agent on the task"})
            continue
        decided = str(f.get(AF["approvedAt"]) or "")[:10] or today_london()
        line = lesson_line(decided, name, words)
        try:
            res = append_lesson_to_file(entry["agent"], line)
            mirrored = False
            if entry.get("registerRow"):
                mirrored = mirror_lesson_to_register(entry["registerRow"], line)
            # Stamp LAST. If anything above threw, the task stays pending and
            # the next run retries — appends are idempotent on the exact line.
            patch_task(task_id, {AF["lessonWrittenAt"]: now_iso()})
            written.append({"task": task_id, "agent": entry["agent"],
                            # Say when a lesson went somewhere other than the
                            # obvious place, so a mis-route is visible in the
                            # report rather than only in a file nobody reads.
                            "reroutedFrom": (ALL_AGENTS.get(raiser, {}).get("agent", raiser)
                                             if rerouted else ""),
                            "reroutedBecause": rerouted,
                            "line": line, "mirrored": mirrored,
                            "lessonCount": res.get("lessonCount"),
                            "crowded": (res.get("lessonCount") or 0)
                                       > LESSON_SOFT_CAP})
        except Exception as e:                        # noqa: BLE001
            problems.append({"task": task_id, "name": name, "error": str(e)})

    out = {"written": written, "problems": problems, "formCards": not_agents,
           "pendingAfter": len(problems),
           "rememberedTotal": len(remembered)}
    print(json.dumps(out, indent=2))
    return 1 if problems else 0


def overdue_lessons(now_utc=None):
    """Pending lessons old enough to mean the writer is broken rather than
    merely behind. Read by cmd_verify — a learning loop nobody checks is the
    one that quietly stopped."""
    now_utc = now_utc or datetime.now(timezone.utc)
    late = []
    for rec in pending_lessons():
        f = rec.get("fields", {})
        at, _ = _parse_at(str(f.get(AF["approvedAt"]) or ""))
        if at and (now_utc - at) > timedelta(minutes=LESSON_GRACE_MIN):
            late.append({"task": rec["id"], "name": f.get(AF["name"], ""),
                         "decidedAt": f.get(AF["approvedAt"])})
    return late


def cmd_intent(args):
    # Called BEFORE a carry-out is dispatched. If the run dies between the
    # action happening and `complete`, the next run sees the open intent and
    # verifies instead of executing the approved action a second time.
    ledger_append(args.task, "intent")
    print(json.dumps({"intentRecorded": args.task}))


def cmd_outcome(args):
    """Read one task's live approval state. The browser lane's gate.

    scripts/agent-browser.js calls this before it is allowed to press submit on
    a web form. It goes through THIS script, like every other Airtable read, so
    the browser gate and the approval loop can never drift apart about what
    "Approved" means — a second hand-rolled read of the same field is exactly
    how the recon accuracy card came to measure the first 100 rows for a month.

    Prints JSON and exits 0 whatever the verdict; the CALLER decides. An
    unreadable task raises, because a failed read must never be mistaken for
    "not approved yet" and quietly stall a form Kevin already approved.
    """
    t = task_view(get_task(args.task))
    # A trial task is never "approved" as far as the browser's submit gate goes (2 Oct 2026).
    # Nor is a robot form card, on trial or not (3 Oct 2026): `commit` presses submit, and the
    # form is Kevin's to send. Its one door is `window`, which only `handover` reads: the robot
    # fills the form in a window he finishes. Read from agent_email_format.FORM_CARDS.
    holders = [t["agentId"]] + t["teamMemberIds"]
    trial = trial_problem(t["sentForApprovalByIds"] + holders, t["name"], t["notes"], t["approvedAt"])
    card = form_card(t["name"], t["notes"])
    print(json.dumps({
        "id": t["id"],
        "name": t["name"],
        "status": t["status"],
        "outcome": t["outcome"],
        "approved": t["outcome"] in APPROVED and not trial and not card,
        "trial": trial,
        "formCard": card,
        "window": (t["outcome"] in APPROVED and t["status"] not in ("Completed", "Cancelled")
                   and form_card(t["name"], t["notes"], holders=holders)),
        # Kevin's step is open: the window command opens only then (a closed step is never run again).
        "turn": bool((task_blocker(t["notes"]) or {}).get("kind") == "KEVIN")
                and not form_turn_unanswered(t["id"], t["name"], t["notes"]),
        "feedback": t["feedback"],
    }))


def cmd_revise(args):
    """Apply Kevin's minor edits to the approved text BEFORE it is carried out.

    Only for 'Approved with minor edits'. The gate's whole promise is that
    nothing goes out that Kevin has not seen, so this is deliberately narrow:
    the agent may make ONLY the change he described, and the text he originally
    approved is archived on the record so what actually went out can always be
    compared with what he read."""
    t = task_view(get_task(args.task))
    if t["outcome"] != "Approved with minor edits":
        sys.exit(f"ERROR: refusing to revise {args.task} — outcome is "
                 f"'{t['outcome'] or 'empty'}'. Only 'Approved with minor "
                 "edits' applies an edit. An 'Approved as-is' task goes out "
                 "VERBATIM; if it needs changing, it needed Request changes.")
    if not str(t["feedback"] or "").strip():
        sys.exit(f"ERROR: refusing to revise {args.task} — there is no "
                 "Approval Feedback, so there is no edit to apply. Carry out "
                 "the approved text unchanged.")
    with open(args.output_file) as fh:
        revised = fh.read().strip()
    if not revised:
        sys.exit("ERROR: refusing to store an empty revision")
    original = str(t["agentOutput"] or "").strip()
    if revised == original:
        # An unchanged "revision" means the edit was not applied. Letting it
        # pass would tick the box while sending the text Kevin asked to change,
        # which is the bug this command exists to end.
        sys.exit(f"ERROR: refusing to revise {args.task} — the text is "
                 "identical to what was approved, so the edit was not applied. "
                 f"Kevin asked for: {str(t['feedback'])[:200]}")

    # The revised text still has to satisfy every rule the original did: it is
    # what will actually be sent, and it has not been through submit's checks.
    # strict=False: this text was already approved by Kevin. A plain-English
    # rule added later must not strand his approved edit (review, 26 Aug 2026).
    problem = carry_out_problem(revised, strict=False)
    if problem:
        sys.exit(f"ERROR: refusing to revise {args.task} — {problem}. Keep the "
                 f"closing '{CARRY_OUT_MARKER}' line on the edited version.")
    promise = send_promise_problem(revised, t["taskType"])
    if promise:
        sys.exit(f"ERROR: refusing to revise {args.task} — {promise}")
    if t["taskType"] == "Correspondence":
        try:
            parse_text(revised)                        # the TEXT lines too: an edit must not move them into the email
            parse_email_output(revised)
        except EmailFormatError as exc:
            sys.exit(f"ERROR: refusing to revise {args.task} — the edited "
                     f"Correspondence no longer parses: {exc}")
    if TIER1_BANNER in original and TIER1_BANNER not in revised:
        sys.exit(f"ERROR: refusing to revise {args.task} — the edit dropped "
                 "the tier-1 banner. The label travels with the work.")

    stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
    mark = (f"[{stamp} — agent] {EDITS_APPLIED_MARK} "
            f"{' '.join(str(t['feedback']).split())[:300]}\n\n"
            "--- TEXT KEVIN APPROVED, BEFORE THE EDIT ---\n"
            f"{original[:20000]}")
    patch_task(args.task, {
        AF["agentOutput"]: revised[:95000],
        AF["notes"]: ((t["notes"] or "") + "\n\n" + mark).strip(),
    })
    print(json.dumps({"revised": args.task, "chars": len(revised),
                      "wasChars": len(original)}))


# ─── RETYPE (finding 20260925-agent-dispatch-606) ─────────────────────
#
# The PIB renewal acknowledgement (recxYYOXZ2oxMMcyB) was approved on 23 Sep
# 2026 with a finished email in it, but the task was typed Admin. send-email.py
# sends only a Correspondence task, and nothing could change the type of an
# approved task, so three hand-back runs in a row hit the same wall and the
# reply never went, with the renewal due 3 Oct. The queue-fixer deferred the
# finding as protected, and nobody was told.
#
# `retype` changes the LABEL only. The text Kevin approved, his verdict and
# its time are never touched. On an approved task the only move allowed is
# INTO Correspondence, and only when the approved text already parses with
# the send path's own parser, so the email that goes out is exactly the one
# he read. Anything else goes back to him as a redo.
RETYPED_MARK = "RETYPED:"


def cmd_retype(args):
    if args.type not in TASK_TYPES:
        sys.exit(f"ERROR: {args.type!r} is not a Task Type. Use one of: {', '.join(TASK_TYPES)}")
    t = task_view(get_task(args.task))
    was = t["taskType"]
    if was == args.type:
        sys.exit(f"ERROR: {args.task} is already typed {was}; nothing to change.")
    if t["outcome"] in APPROVED:
        if args.type != "Correspondence":
            sys.exit(
                f"ERROR: refusing to retype approved task {args.task} to {args.type}. "
                "An approved task may only be retyped INTO Correspondence, so the send "
                "path can carry out the email Kevin already read. Anything else is a "
                "change of substance: send it back to him as a redo.")
        try:
            parse_text(t["agentOutput"] or "")
            parse_email_output(t["agentOutput"] or "")
        except EmailFormatError as exc:
            sys.exit(
                f"ERROR: refusing to retype {args.task} to Correspondence: the text "
                f"Kevin approved does not parse as an email ({exc}). Retyping would "
                "not make it sendable; it needs a redo.")
    reason = " ".join(str(args.reason or "").split())
    if not reason:
        sys.exit("ERROR: --reason is required: say why the type was wrong.")
    stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
    note = (f"[{stamp} — agent-dispatch] {RETYPED_MARK} {was or '(blank)'} → {args.type}. "
            f"{reason[:300]} The approved text and Kevin's verdict are unchanged.")
    patch_task(args.task, {
        AF["taskType"]: args.type,
        AF["notes"]: ((t["notes"] or "") + "\n\n" + note).strip(),
    })
    back = task_view(get_task(args.task))
    if back["taskType"] != args.type:
        sys.exit(f"ERROR: wrote Task Type {args.type} to {args.task} but it reads back "
                 f"{back['taskType']!r}.")
    print(json.dumps({"retyped": args.task, "from": was, "to": back["taskType"],
                      "outcome": back["outcome"], "approvedAt": back["approvedAt"]}))


SIGNATURE_WATCH_LEDGER = os.environ.get(
    "SIGNATURE_WATCH_LEDGER",
    os.path.expanduser("~/knowledge-os/logs/signature-watch/watch.jsonl"))


def sign_output_needs_watch(agent_output):
    """True when the approved output is a SIGN carry-out — a document going
    out for signature. The SIGN shape (agent_email_format.py) carries a
    SIGNERS: header line before the --- divider; nothing else does."""
    head = (agent_output or "").split("---", 1)[0]
    return any(line.strip().upper().startswith("SIGNERS:")
               for line in head.splitlines())


def signature_watch_registered(task_id):
    """Read the watcher's OWN ledger, never the run's claims. A register row
    for this task means the signed-copy return leg is armed."""
    try:
        with open(SIGNATURE_WATCH_LEDGER) as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("cmd") == "register" and row.get("task") == task_id:
                    return True
    except OSError:
        pass
    return False


SIGNED_MARK = "SIGNED COPY BACK:"


def signed_handoff_note(stamp, agreement, pdf, then):
    """The line that turns a signed document into the agent's next job. The
    marker is what makes the hand-off idempotent: a second poll that sees
    the same signed row finds the marker and does nothing."""
    step = {"post": "post it to the recipient the approved letter names "
                    "(POST output, send-letter.py after approval)",
            "email": "email it to the recipient the approved letter names "
                     "(Correspondence output with ATTACH, send-email.py after approval)"
            }.get(then, f"carry out the '{then}' step the approval named")
    return (f"[{stamp} — signature-watch] {SIGNED_MARK} {agreement} came back "
            f"signed. Signed PDF: {pdf}\nNEXT (gate 2): {step}. Prepare it and "
            f"submit for Kevin's approval; the signed PDF must be the attachment.")


AUTHORITY_SIGNED = "fldHPe9YQ6GmlrKBt"     # Tenants: Authority Signed (checkbox; workers/property-manager/fields.mjs)
# A tenant's letter of authority is named this way in Adobe (the Cash Flow Voids agent file says so). A
# document that only mentions an authority ("Local Authority ...") never ticks anything.
AUTHORITY_RE = re.compile(r"^\s*letters? of (?:authority|authori[sz]ation)\b", re.I)
SIGNERS_LINE_RE = re.compile(r"^\s*SIGNERS:\s*(.+)$", re.I | re.M)
# The signers, kept in Notes by the hand-off: by the next poll the agent has usually replaced the card's text
# with its report, so a retried tick reads them here (second review, 5 Oct 2026).
AUTHORITY_SIGNERS_MARK = "AUTHORITY SIGNERS:"
AUTHORITY_SIGNERS_RE = re.compile(r"^\s*AUTHORITY SIGNERS:\s*(.+)$", re.M)
EMAIL_IN_RE = re.compile(r"[^@\s,<>;]+@[^@\s,<>;]+\.[^@\s,<>;]+")


def authority_signers(task_fields):
    """The signers' emails, lower case: from the card's SIGNERS line, and from the hand-off's own Notes line."""
    lines = [m.group(1) for m in SIGNERS_LINE_RE.finditer(str(task_fields.get(AF["agentOutput"]) or ""))]
    lines += [m.group(1) for m in AUTHORITY_SIGNERS_RE.finditer(str(task_fields.get(AF["notes"]) or ""))]
    return {e.lower().strip(".") for line in lines for e in EMAIL_IN_RE.findall(line)}


def tick_authority(task_fields, agreement):
    """Tick Authority Signed on each tenant the task links who SIGNED the document, when it is a tenant's letter of
    authority (its Adobe agreement name opens "Letter of authority"). A signer is matched by email: the card's
    SIGNERS line against the tenant's record, so a joint tenant who did not sign is never ticked. Returns
    (tenant ids ticked now, why nothing was ticked or ""); one already ticked is left alone. A read that misses
    a tenant raises."""
    if not AUTHORITY_RE.search(str(agreement or "")):
        return [], ""
    ids = [t for t in links(task_fields.get(TASK_TENANTS)) if re.fullmatch(r"rec[A-Za-z0-9]{14}", t)]
    if not ids:
        return [], "the task links no tenant"
    signers = authority_signers(task_fields)
    if not signers:
        return [], "the task's card names no SIGNERS"
    formula = "OR(" + ",".join(f"RECORD_ID()='{t}'" for t in ids) + ")"
    rows = {r["id"]: r.get("fields") or {} for r in query_records(TENANTS_TABLE, formula, [AUTHORITY_SIGNED, TENANT_EMAIL])}
    if set(rows) != set(ids):
        raise RuntimeError(f"tenants {sorted(set(ids) - set(rows))} could not be read, so Authority Signed was not ticked")
    # One of our own addresses on a tenant record is a placeholder, never the tenant's signature; and an email two
    # linked tenants share cannot say which of them signed (review, 5 Oct 2026): neither ticks anyone.
    email = {t: str(rows[t].get(TENANT_EMAIL) or "").strip().lower() for t in ids}
    shared = {e for e in email.values() if e and list(email.values()).count(e) > 1}
    signed = [t for t in ids if email[t] in signers and email[t] not in OWN_ADDRESSES and email[t] not in shared]
    if not signed:
        why = ("the signer's email is shared by more than one linked tenant, so who signed is not known"
               if signers & shared else "no tenant the task links signed it (matched by email)")
        return [], why
    todo = [t for t in signed if not rows[t].get(AUTHORITY_SIGNED)]
    for i in range(0, len(todo), 10):                 # Airtable writes ten records at a time
        _request("PATCH", f"/{TENANTS_TABLE}", {"records": [{"id": t, "fields": {AUTHORITY_SIGNED: True}} for t in todo[i:i + 10]],
                                                "typecast": False})
    return todo, ""


def cmd_signed(args):
    """Gate 2 begins here. Called by signature-watch.js the moment a
    registered document comes back signed (4 Sep 2026: three letters of
    authority sat signed in ~/knowledge-os/attachments for a day because
    the watcher wrote 'next: submit gate 2' to a log and nothing read it;
    the tasks had been Completed at gate 1, so no agent could ever see
    them). Reopens the task for the agent that raised it, with the PDF
    path and the next step in Notes, and clears the gate-1 verdict so the
    gate-2 submission is judged on its own."""
    rec = get_task(args.task)
    tf = rec.get("fields", {}) or {}
    notes = str(tf.get(AF["notes"]) or "")
    # A LETTER OF AUTHORITY ticks Authority Signed on the tenants who signed it (Cash Flow Voids lane C, 5 Oct
    # 2026): the benefit-cap claim card waits on that tick. It never holds up the hand-off: a failed tick is said
    # and exits 1, so signature-watch offers the row again and the next poll ticks it ("already handed off").
    tick = {"authorityTicked": [], "authorityNote": "", "authorityError": ""}
    try:
        tick["authorityTicked"], tick["authorityNote"] = tick_authority(tf, args.agreement)
    except Exception as exc:                          # noqa: BLE001 — said in the JSON and the exit code
        tick["authorityError"] = f"Authority Signed could not be ticked: {str(exc)[:200]}"
    if SIGNED_MARK in notes and args.agreement in notes:
        print(json.dumps({"task": args.task, "reopened": False, **tick,
                          "reason": "already handed off"}))
        return 1 if tick["authorityError"] else 0
    if not os.path.exists(args.pdf):
        sys.exit(f"ERROR: signed PDF not found at {args.pdf}; refusing to "
                 "hand off a document that is not on disk.")
    team = links(tf.get(AF["teamMember"])) or links(tf.get(AF["sentForApprovalBy"]))
    if not team:
        sys.exit(f"ERROR: {args.task} has no agent on it; a signed document "
                 "with nobody to carry it is exactly the miss this exists to stop.")
    stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
    note = signed_handoff_note(stamp, args.agreement, args.pdf, args.then)
    signers = authority_signers(tf) if AUTHORITY_RE.search(str(args.agreement or "")) else set()
    if signers:
        note += f"\n{AUTHORITY_SIGNERS_MARK} {', '.join(sorted(signers))}"
    patch_task(args.task, {
        AF["status"]: "Today",
        AF["dueDate"]: today_london(),
        AF["teamMember"]: team,
        AF["assignee"]: None,
        AF["sentForApprovalBy"]: [],
        AF["approvalOutcome"]: None,
        AF["approvalFeedback"]: None,
        AF["approvedAt"]: None,
        AF["notes"]: (notes.rstrip() + "\n\n" + note).strip()[-90000:],
    })
    print(json.dumps({"task": args.task, "reopened": True, **tick,
                      "agent": ALL_AGENTS.get(team[0], {}).get("agent", team[0]),
                      "then": args.then, "pdf": args.pdf}))
    return 1 if tick["authorityError"] else 0


# ── The dated trail (Kevin, 8 Sep 2026) ─────────────────────────────────────
# Kevin's ask: "I need to see the latest attachment before I approve, and a
# date-ordered record of what has actually happened, including whether the
# letter has already gone." Airtable stores no date on an attachment and the
# card showed only the newest Agent Output, so a task could come back "done"
# still wearing last week's file, and a payment-plan draft could follow a
# restraint-order letter nobody had recorded. Every event now lands in Notes
# as one stamped line the AI Agents page parses into "What has happened so
# far": files attached and superseded, every submit, every send, and the
# TRACK RECORD of past dealings with the same contact or reference.
ATTACHED_MARK = "ATTACHED:"
SUPERSEDED_MARK = "SUPERSEDED:"
SUBMITTED_MARK = "SUBMITTED"
SENT_MARK = "SENT:"
TRACK_RECORD_MARK = "TRACK RECORD:"
NOTE_STAMP_RE = re.compile(r"^\[(?P<day>\d{1,2} \w{3} \d{4})(?: (?P<time>\d{2}:\d{2}))?\s*[—–-]\s*(?P<who>[^\]]+)\]\s*(?P<text>.*)$", re.M)
TRACK_RECORD_LINE_RE = re.compile(r"^\s*[-*]\s*(?P<day>\d{1,2} \w{3} \d{4}|\d{4}-\d{2}-\d{2})\b", re.M)
TRACK_RECORD_NONE_RE = re.compile(r"^\s*TRACK RECORD:\s*none found\b.*\(searched[^)]*\)", re.I | re.M)
# A PROMISE to send something, not a mention of the sender's file: "with the
# LOA attached", "attaching the statement", "enclosing the form". "No
# attachment is needed" and "the attachment they sent" are not promises
# (review, 8 Sep 2026).
ATTACH_PROMISE_RE = re.compile(
    r"\b(?:attaching|enclosing)\b|\bwith\b[^.;\n]{0,80}\b(?:attached|enclosed)\b|\b(?:attached|enclosed)\b[^.;\n]{0,40}\b(?:letter|pdf|form|statement|document|copy|file|invoice|report)\b",
    re.I)
ATTACH_NEGATION_RE = re.compile(r"\b(?:no|not|without|never)\b[^.;\n]{0,20}\b(?:attach|enclos)", re.I)
OWN_ADDRESSES = {"kevinbrittain@gmail.com", "kevin@runpreneur.org.uk", "kevin@operationsdirector.co.uk",
                 "info@agilelets.co.uk", KEVIN_AIRTABLE_EMAIL.lower()}


def note_stamp():
    return datetime.now(LONDON).strftime("%d %b %Y %H:%M")


def note_line(who, text):
    return f"[{note_stamp()} — {who}] {text}"


def append_notes(existing, *lines):
    lines = [l for l in lines if l]
    if not lines:
        return str(existing or "")
    return (str(existing or "").rstrip() + "\n\n" + "\n".join(lines)).strip()[-90000:]


def attached_stamp(filename, purpose, who="agent"):
    return note_line(who, f"{ATTACHED_MARK} {filename} — {purpose}")


def superseded_stamp(filename):
    return note_line("agent-dispatch", f"{SUPERSEDED_MARK} {filename} replaced by a newer copy with the same name")


def submitted_round(notes):
    return len(re.findall(r"\] " + SUBMITTED_MARK + r" \(round \d+\)", str(notes or ""))) + 1


def submitted_stamp(round_no, task_type, files):
    tail = (" with " + ", ".join(files)) if files else " with no new file"
    return note_line("agent-dispatch", f"{SUBMITTED_MARK} (round {round_no}) as {task_type}{tail}")


def files_this_round(notes):
    """Filenames ATTACHED since the last SUBMITTED stamp (this round's files)."""
    text = str(notes or "")
    last = -1
    for m in re.finditer(r"\] " + SUBMITTED_MARK + r" \(round \d+\)", text):
        last = m.end()
    names = set()
    for m in NOTE_STAMP_RE.finditer(text):
        if m.start() < last:
            continue
        t = m.group("text")
        if t.startswith(ATTACHED_MARK):
            names.add(t[len(ATTACHED_MARK):].split(" — ")[0].strip())
    return names


def carry_out_line(output):
    m = re.search(r"\*{0,2}carrying this out will involve:?\*{0,2}\s*([^\n]+)", str(output or ""), re.I)
    return m.group(1).strip() if m else ""


def document_action_problem(output, task_type, notes, attached_now):
    """Why this submission promises a file Kevin cannot see; '' when fine.

    Two shapes. A Correspondence output with an ATTACH header sends that
    file, so the same filename must be on the task from THIS round. Any
    output whose carry-out line says the work goes with something attached
    or enclosed needs a file attached this round. Earlier rounds do not
    count: that is the "old attachment still on the card" Kevin described.
    """
    fresh = set(attached_now or set()) | files_this_round(notes)
    m = re.search(r"^ATTACH:\s*(.+?)\s*$", str(output or ""), re.M)
    if m:
        name = os.path.basename(m.group(1).strip())
        if name not in fresh:
            return (f"the email's ATTACH header names {name!r} but that file is not on the task "
                    f"from this round (on the task this round: {sorted(fresh) or 'nothing'}). "
                    "Kevin approves the file he can open: pass --attach with the same file "
                    "in the same submit, so the card carries the copy that will be sent.")
    line = carry_out_line(output)
    if line and ATTACH_PROMISE_RE.search(line) and not ATTACH_NEGATION_RE.search(line) and not fresh:
        return ("its carry-out line promises something attached or enclosed, but no file was "
                "attached in this round. Kevin's rule (8 Sep 2026): when the action involves a "
                "document, the exact document goes on the gate with the same submit "
                "(--attach PATH), never a copy from an earlier round.")
    return ""


def track_record_problem(output, required):
    """Why the output lacks the dated record of past dealings; '' when fine."""
    if not required:
        return ""
    text = str(output or "")
    if TRACK_RECORD_NONE_RE.search(text):
        return ""
    i = text.find(TRACK_RECORD_MARK)
    if i == -1:
        return ("it carries no TRACK RECORD. Kevin's ruling (8 Sep 2026): a reply, a creditor "
                "item or any inbound matter states what has already passed with this contact, "
                "reference or property, in date order, before he is asked to decide. Build it with\n"
                "         python3 scripts/agent-dispatch.py history --task <id> --email <addr> "
                "--ref <reference> --text\n"
                "       and paste the block into the output (a 'TRACK RECORD: none found "
                "(searched ...)' line counts).")
    after = text[i:]
    if not TRACK_RECORD_LINE_RE.search(after):
        return ("its TRACK RECORD block has no dated lines. Each line starts with a date "
                "(dd Mon yyyy) and says what was sent, received or agreed; use "
                "'TRACK RECORD: none found (searched ...)' when the search was empty.")
    return ""


# ── history: the dated record of everything with a contact or reference ──
# The five-or-more check stops at the first boundary five or more characters
# in, never the last: read to the end of the run at every boundary,
# "a-" * 30000 took 3.1 seconds (28 Sep 2026). It is a yes/no check, so the
# answer is the same.
REF_TOKEN_RE = re.compile(r"\b(?=[A-Z0-9-]{5,}?\b)(?:[A-Z]*\d[A-Z0-9-]*)\b")
# A timestamp is a date: "2026-01-22T16:27:36Z" reads as 2026-01-22T16 (60
# live tokens on 28 Sep 2026, mostly Evernote "Recorded:" stamps), and a
# calendar invite writes 20260122T162736Z. Eight bare digits stay: that is an
# account number as often as a date.
ISO_DATE_RE = re.compile(r"^(?:\d{4}-\d{2}-\d{2}(?:[Tt]\d{2,6}[Zz]?)?|\d{8}[Tt]\d{4,6}[Zz]?)$")
# A command or code word is not a reference (28 Sep 2026). A task whose
# description said "Run: python3 ~/.claude/skills/model-check/calibrate.py 14"
# searched for PYTHON3, found 682 lines of unrelated history (EICR checks
# among them) and wrote the newest 40, 12,454 characters, into its Notes.
# Letters then one digit is not a reference: across the 8,135 live tasks it
# gave 17 tokens, every one noise (PYTHON3, WORDSECTION1 from Outlook HTML,
# DMARC1, the name part of an email address, run-together text like TAPS3),
# while real references carry two or more digits (shapes like UCD123, PUD45,
# AB12345). A booking code can have that shape (PNR XKQJT4), so one straight
# after a reference label stays. Only a label that means a reference on its
# own counts bare; an everyday word (case, order, account) needs No, Number,
# Ref, Code or # after it, or "in case python3" is searched again (review).
# The named code words come with the widths they come in, so INT123 or
# X1234567 stays a reference, and no label rescues them; the last is a model
# id's tail (4-5-20251001 from claude-haiku-4-5-20251001).
ONE_DIGIT_WORD_RE = re.compile(r"[A-Z]+\d")
CODE_WORD_RE = re.compile(
    r"SHA(?:224|256|384|512)|SHA3-(?:224|256|384|512)|BASE(?:32|58|64|85)|UTF(?:16|32)(?:BE|LE)?"
    r"|(?:U?INT|FLOAT)(?:16|32|64|128)|(?:WIN|ARM|AMD|AARCH)(?:32|64)|WIN1[01]|X86-64|CP125\d"
    r"|(?:PYTHON|NODE|IOS|IPADOS|MACOS|WATCHOS|ANDROID|WINDOWS)\d{2}|INSTA360"
    r"|(?:PYTHON|HTML|OAUTH|DMARC|DKIM|WORDSECTION)\d"
    r"|\d{1,2}-\d{1,2}-20\d{6}|IMAGE\d{3}")
REF_LABEL_RE = re.compile(
    r"(?:\b(?:REF|REFERENCE|BOOKING|PNR|CONFIRMATION)\b(?:[ \t]*(?:NO|NUMBER|CODE|REF|REFERENCE)\b)?"
    r"|\b(?:POLICY|CLAIM|ACCOUNT|CASE|INVOICE|ORDER|TRACKING)(?:[ \t]*(?:NO|NUMBER|CODE|REF|REFERENCE)\b|[ \t]*#))"
    r"[ \t:#.()-]*(?:\r?\n[ \t]*)?\Z")
# Pasted email carries machine text that is never a reference (28 Sep 2026,
# measured on the 8,135 live tasks). Outlook names each inline picture
# "[cid:image001.png@01AB2345.6789CDEF]": the content id gave 72 tokens and the
# file name 67 (IMAGE\d{3} above). A style colour ("background: #1a2b3c",
# link="#467886") gave 69. It goes only where a style property is followed by
# CSS values, never prose: "Background: tenant says invoice #12345678" and
# "Order #GM123456" are real (review). A price run into a word (Subtotal80.00,
# GBP12.34, GBP160, 12500GBP) or a number beside a currency sign or code is an
# amount, not a reference (146 tasks changed, 171 tokens dropped, none a
# reference).
INLINE_IMAGE_RE = re.compile(
    r"(?i)(?:\bcid:|\bimage\d{3}\.(?:png|jpe?g|gif|bmp)@)[^\s\]>)\"']+|\bOutlook-[0-9a-z]+\.(?:png|jpe?g|gif)\b")
_CSS_VALUE = (r"(?:-?[\d.]+(?:px|pt|em|rem|%)|0|\d+deg|solid|dashed|dotted|double|groove|ridge|inset|outset"
              r"|none|transparent|!important|to[ \t]+(?:left|right|top|bottom)|rgba?\([^)\n]{0,40}\))")
# One line only, no run of blanks two quantifiers can split, and no property
# name longer than 40 letters: a 20,000-space value took 28 seconds (review).
STYLE_COLOUR_RE = re.compile(
    r"(?i)(?:\b(?:[a-z-]{0,40}colou?r|background[a-z-]{0,40}|border[a-z-]{0,40}|outline[a-z-]{0,40}|fill|stroke"
    r"|[a-z-]{0,40}shadow)[ \t]*[:=]|\b[av]?link[ \t]*=|(?<![\w-])--[a-z0-9-]{1,40}[ \t]*:)"
    r"[ \t]*(?:[\"'][ \t]*)?(?:(?:linear|radial)-gradient\([ \t]*)?(?:" + _CSS_VALUE + r"[ \t,]+)*#[0-9a-f]{3,8}\b"
    r"(?:[ \t,]*(?:" + _CSS_VALUE + r"[ \t,]+)*#[0-9a-f]{3,8}\b)*")
AMOUNT_WORD_RE = re.compile(r"(?:GBP|EUR|USD)\d+|\d+(?:GBP|EUR|USD)")
AMOUNT_TAIL_RE = re.compile(r"\.\d{2}(?![\d.])")
CURRENCY_BEFORE_RE = re.compile(r"(?:[£€$]|\b(?:GBP|EUR|USD))[ \t]?\Z")
# "Order 123456 GBP 49.99": the amount follows the code, so 123456 is the
# order (review).
CURRENCY_AFTER_RE = re.compile(r"[ \t]?(?:GBP|EUR|USD)\b(?![\s,:]*[£€$]?\d)")
# A link is an address, not a reference (25 Sep 2026). An Airtable form link
# in a tenant-chain task gave the refs APPNQJDPQDNIH3IRL, the base id in
# nearly every task and email that links to Airtable, and SHRTUDF8S04KP5XGT;
# the search matched hundreds of unrelated tasks and threads and wrote ~72,000
# characters into two tasks' Notes, a tier-1 line among them. Links go before
# the tokens are read, and an Airtable id (app/tbl/rec/viw/shr/fld + 14) is
# never a reference even bare: every TRACK RECORD line links its task, so a
# record id matches every record that ever cited it. Both match on the text
# as written, before it is upper-cased: a scheme-less link needs a lowercase
# host (so "Acc.No/12345678" stays a reference) and an id a lowercase prefix
# (so RECEIPT1234567890 does too).
# A long dotted or hyphened run ("a." * 10000) took 1.2 seconds (28 Sep
# 2026): the scheme-less link was retried at every word boundary inside it,
# each try reading to the end of the run. Once a run fails as a link from its
# first boundary it fails from every later one (a link found from a later
# boundary would stretch back to the first), so the third branch reads the
# rest of the run in one step and gives it back
# unchanged. It stops short of a www. or http(s):// inside the run so the
# first branch is still tried there. The text out is the same as before.
_NOT_A_LINK_START = r"(?!(?i:www\.|https?://))[a-z0-9-]"
REF_URL_RE = re.compile(
    r"(?i:https?://|www\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}/\S*"
    r"|(?P<run>\b(?:" + _NOT_A_LINK_START + r")+(?:\.(?:" + _NOT_A_LINK_START + r")+)*)")
AIRTABLE_ID_RE = re.compile(r"\b(?:app|tbl|rec|viw|shr|fld)[A-Za-z0-9]{14}\b")
# A link wrapped across lines cuts an id in two ("…/shrTuDF8s" then
# "04Kp5XGT"), and the second half would search every record holding the
# link. When an Airtable link ends in an id cut short and the next line starts
# with a word of exactly the missing length, the two are one id and are
# rejoined before the link is stripped (Kevin, 25 Sep 2026). Airtable links
# only: "…/receipts" then "INV123456" elsewhere is a reference (review).
WRAPPED_ID_RE = re.compile(
    r"((?i:(?:https?://)?(?:www\.)?airtable\.com/)\S*?\b(?:app|tbl|rec|viw|shr|fld)([A-Za-z0-9]{0,13}))"
    r"[ \t]*\r?\n[ \t]*([A-Za-z0-9]{1,14})(?![A-Za-z0-9])")
# A file name is not a reference (Kevin, 28 Sep 2026). A UC47 chase's TRACK
# RECORD said "searched tasks + Gmail for ref UC47-ANSWERS": the token came
# from its working-file line, `~/Projects/kevin-hq/property/2026-09-28 uc47
# <tenant>/uc47-answers.md`, and the search pulled in another tenant's UC47
# history. Four shapes, all gone before the tokens are read: a path to a file,
# whose folders may hold spaces (dated working folders do: "2026-09-21
# chedburgh gas safety/"); any other path, starting ~/ or ./ or / with at least
# two parts; a file name, bare or with a relative folder ("uc47-answers.md",
# "notes/uc47-answers.md"), because an attachment's name is not the matter's
# reference either (Kevin, 29 Sep 2026: 3 tokens across 8,139 tasks, all
# file-name fragments); and a file name with spaces in quotes. A path starts
# after a space or at the start, never after a letter, so "and/or" and
# "Acc.No/12345678" stay text, and "(/AB12345)" is one part, not a path.
# A folder or file name with spaces is short, has no dot or ~ before its last
# word, and, unless it starts with a date, is written in capitals ("My Drive",
# "Mobile Documents", "Case AB12345 notes.md"), so ordinary words never read as
# a folder running on to the next path ("~/Downloads for claim AB12345 see
# notes/x.md" keeps AB12345, review). The limit: a file name with spaces loose
# in a sentence, unquoted and outside a path, cannot be told apart from the
# words around it, so it stays.
_FILE_EXT = (r"(?:md|markdown|txt|py|js|mjs|cjs|ts|json|jsonl|csv|tsv|html?|css|sh|zsh|toml|ya?ml|ini|cfg"
             r"|log|pdf|docx?|xlsx?|xlsm|pptx?|odt|ods|rtf|pages|numbers|key|png|jpe?g|gif|heic|webp|svg"
             r"|tiff?|bmp|mov|mp4|m4a|mp3|wav|zip|eml|msg|ics|vcf|plist|sql|xml)")
# A file type is written all lower case or all capitals ("pdf", "PDF"), never
# as a word starting a sentence after a missing space: "claim AB12345.Log in"
# keeps its reference (review). Case-sensitive inside the case-blind pattern.
_FILE_EXT = "(?-i:" + _FILE_EXT + "|" + _FILE_EXT.upper() + ")"
_PATH_CH = r"[\w.~@+()-]"
# A folder with spaces: a dated one ("2026-09-21 chedburgh gas safety") runs to
# six words, any other to three, each starting with a capital or a digit ("My
# Drive", "00 AI Context"). The two shapes never overlap (a digit starts one,
# never the other), or the reader backtracks exponentially on "1 a/1 a/..."
# (review). _CAP_WORD is case-sensitive inside a case-blind pattern.
_CAP_WORD = r"(?:(?-i:[A-Z0-9])[\w@+()-]*|[-_])"
_FOLDER_WORDS = (r"(?:\d[\w@+()-]*(?:[ \t][\w@+()-]+){1,5}"
                 r"|(?!\d)(?-i:[A-Z])[\w@+()-]*(?:[ \t]" + _CAP_WORD + r"){1,2})")
# The last part of a path may hold spaces the same way: up to three capital
# words, then the file ("Case AB12345 notes.md").
_FILE_WORDS = r"(?:" + _CAP_WORD + r"[ \t]){0,3}"
FILE_PATH_RE = re.compile(
    r"(?<![\w.~/-])(?:~|\.{1,2})?/(?:" + _PATH_CH + r"+/|" + _FOLDER_WORDS + r"/)*"
    + _FILE_WORDS + r"[\w~@+()-]" + _PATH_CH + r"*\." + _FILE_EXT + r"\b"
    # A quoted file name opens after a space, a bracket or the start, never on
    # the apostrophe in "Kevin's", and holds no quote of any kind (review).
    r"|(?<![^\s(\[])[\"'\u201c\u2018][^\"'\u201c\u201d\u2018\u2019\n]{1,120}?\." + _FILE_EXT + r"[\"'\u201d\u2019]"
    r"|(?<![\w.~/-])(?:(?:~|\.{1,2})/" + _PATH_CH + r"+(?:/" + _PATH_CH + r"*)*"
    r"|/" + _PATH_CH + r"+(?:/" + _PATH_CH + r"*)+)"
    r"|(?<![\w.~@+()/-])[\w~@+()-]" + _PATH_CH + r"*(?:/" + _PATH_CH + r"+)*\." + _FILE_EXT + r"\b",
    re.I)
# A pasted TRACK RECORD header lists what was already searched, every ref in
# capitals, so an id copied from one no longer looks like an id. Its terms
# are never read again. A header starts its line, after an optional stamp.
TRACK_RECORD_HEADER_RE = re.compile(r"^[ \t]*(?:\[[^\]\n]*\][ \t]*)?TRACK RECORD:[^\n]*", re.M)
HISTORY_MAX_REFS = 8
HISTORY_MAX_LINES = 40


def reference_tokens(text):
    """Reference-like tokens in free text: five or more characters carrying a
    digit, never a plain date, each once (review, 8 Sep 2026: one letter
    yielded 18 tokens, seven of them the same number, and dates matched
    thirteen unrelated tasks). Never from a link, never an Airtable id (25 Sep
    2026). A phone number stays: on the SMS lane it is the only thing naming
    the contact. Never a command or code word such as PYTHON3 or SHA256 (28
    Sep 2026). Never from a file path (28 Sep 2026)."""
    text = TRACK_RECORD_HEADER_RE.sub(" ", str(text or ""))
    text = WRAPPED_ID_RE.sub(lambda m: m.group(1) + m.group(3) if len(m.group(2)) + len(m.group(3)) == 14 else m.group(0), text)
    text = AIRTABLE_ID_RE.sub(" ", REF_URL_RE.sub(lambda m: m.group("run") or " ", text))
    text = STYLE_COLOUR_RE.sub(" ", INLINE_IMAGE_RE.sub(" ", text))
    # After the inline pictures: "image001.png@01AB2345.6789CDEF" read as a
    # file name would leave its content id behind as a token.
    text = FILE_PATH_RE.sub(" ", text)
    # A link wrapped across lines leaves a piece of an id behind (DNIH3IRL
    # from appnqjDpq / DniH3IRl), and the search matches on substrings, so
    # that piece finds every record the base id is in (review, 25 Sep 2026).
    ours = f"{BASE_ID} {TASKS}".upper()
    upper = text.upper()
    out = []
    for mt in REF_TOKEN_RE.finditer(upper):
        t = mt.group(0)
        if t.isalpha() or ISO_DATE_RE.match(t) or t in ours or t in out:
            continue
        if CODE_WORD_RE.fullmatch(t) or AMOUNT_WORD_RE.fullmatch(t):
            continue
        if re.fullmatch(r"[A-Z]*\d+", t) and AMOUNT_TAIL_RE.match(upper, mt.end()):
            continue
        if re.fullmatch(r"[\d-]+", t) and CURRENCY_BEFORE_RE.search(upper, max(0, mt.start() - 5), mt.start()):
            continue
        if t.isdigit() and CURRENCY_AFTER_RE.match(upper, mt.end()):
            continue
        if ONE_DIGIT_WORD_RE.fullmatch(t) and not REF_LABEL_RE.search(upper, max(0, mt.start() - 40), mt.start()):
            continue
        out.append(t)
        # Only the first eight are kept, so stop there: checking each new
        # token against a list that kept growing took 1.3 seconds on 20,000
        # of them (28 Sep 2026).
        if len(out) == HISTORY_MAX_REFS:
            break
    return out[:HISTORY_MAX_REFS]


def history_terms(emails=(), refs=(), properties=()):
    terms = []
    for e in emails:
        e = (e or "").strip().lower()
        # Kevin's own address is on forwarded post and every SMS lane task:
        # searching it would be the whole mailbox (85 of 563 inbound tasks).
        if e and e not in OWN_ADDRESSES and ("email", e) not in terms:
            terms.append(("email", e))
    for r in refs:
        r = (r or "").strip()
        if len(r) >= 3 and not ISO_DATE_RE.match(r) and not AIRTABLE_ID_RE.fullmatch(r) and ("ref", r) not in terms:
            terms.append(("ref", r))
    for p in properties:
        p = (p or "").strip()
        if len(p) >= 4 and ("property", p) not in terms:
            terms.append(("property", p))
    return terms


def _airtable_quote(v):
    return "'" + str(v).replace("\\", "\\\\").replace("'", "\\'") + "'"


def history_formula(terms):
    fields = ["Task Name", "Description", "Notes", "Agent Output", "Feedback History", "Inbound Sender"]
    parts = []
    for _kind, term in terms:
        q = _airtable_quote(term.lower())
        parts.append("OR(" + ",".join(f"FIND({q}, LOWER({{{f}}}&''))" for f in fields) + ")")
    return "OR(" + ",".join(parts) + ")" if parts else ""


def history_entries_from_task(rec, exclude_id=None):
    """The dated events one task contributes: its creation, every Notes stamp,
    every feedback stamp, its completion. Dates are ISO for sorting."""
    f = rec.get("fields", {}) or {}
    if exclude_id and rec.get("id") == exclude_id:
        return []
    name = str(f.get(AF["name"]) or "").strip()[:90]
    status = sel(f.get(AF["status"]))
    out = []
    created = str(rec.get("createdTime") or "")[:10]
    link = f"https://airtable.com/{BASE_ID}/{TASKS}/{rec.get('id')}"
    if created:
        out.append({"date": created, "source": "task", "text": f"task opened: {name} ({status})", "task": rec.get("id"), "link": link})
    for m in NOTE_STAMP_RE.finditer(str(f.get(AF["notes"]) or "")):
        iso = _stamp_to_iso(m.group("day"), m.group("time"))
        text = m.group("text").strip()
        if not text or text.startswith(TRACK_RECORD_MARK):
            continue
        out.append({"date": iso, "source": m.group("who").strip(), "text": text[:220], "task": rec.get("id"), "link": link})
    for m in re.finditer(r"^\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})[^\]]*\]\s*(.+)$", str(f.get(AF["feedbackHistory"]) or ""), re.M):
        out.append({"date": f"{m.group(1)} {m.group(2)}", "source": "Kevin", "text": m.group(3).strip()[:220], "task": rec.get("id"), "link": link})
    # Files on that task, with their links: a document the estate already has
    # (a restraint order, a signed LOA) is fetched from here and re-attached,
    # never asked of Kevin (8 Sep 2026: an agent could not find the restraint
    # order PDF and asked him to attach it, while it sat on another task).
    # This link is signed and dies within hours: it is for the agent's own
    # run (the JSON output). history_text never prints it.
    for a in (f.get(AF["attachments"]) or []):
        fname = str(a.get("filename") or "").strip()
        if not fname:
            continue
        kb = int(a.get("size") or 0) // 1024
        out.append({"date": created or comp_or_blank(f), "source": "file",
                    "text": f"file on that task: {fname}" + (f" ({kb} KB)" if kb else "") + f" — from \"{name}\"",
                    "task": rec.get("id"), "link": str(a.get("url") or "")})
    comp = str(f.get(AF["completion"]) or "")[:10]
    if comp and status == "Completed":
        line = carry_out_line(f.get(AF["agentOutput"]))
        out.append({"date": comp, "source": "task", "text": f"completed: {name}" + (f" — {line[:160]}" if line else ""), "task": rec.get("id"), "link": link})
    return out


def comp_or_blank(f):
    return str(f.get(AF["completion"]) or "")[:10]


def _stamp_to_iso(day, time_):
    try:
        d = datetime.strptime(day, "%d %b %Y").strftime("%Y-%m-%d")
    except ValueError:
        return day
    return d + (" " + time_ if time_ else "")


def history_gmail(terms, days):
    """Dated email events for the terms through the triage worker's Gmail
    listing. Returns (entries, note); the note says what was NOT searched."""
    import importlib.util
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "inbound-triage.py")
    try:
        spec = importlib.util.spec_from_file_location("inbound_triage", path)
        it = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(it)
        # Its fail() prints a JSON error line to stdout before exiting; here
        # that line would become the first line of the record (review).
        it._fail_quiet["on"] = True
    except Exception as e:                                   # noqa: BLE001
        return [], f"Gmail not searched ({str(e)[:80]})"
    q_parts = []
    for kind, term in terms:
        if kind == "email":
            q_parts.append(f"(from:{term} OR to:{term})")
        else:
            q_parts.append('"' + term.replace('"', "") + '"')
    if not q_parts:
        return [], "Gmail not searched (no terms)"
    q = "(" + " OR ".join(q_parts) + f") newer_than:{max(1, int(days))}d"
    try:
        msgs, truncated = it.worker_list(q=q, max_pages=3)
    except SystemExit as e:
        why = (getattr(it, "_last_fail", {}) or {}).get("message") or str(e)
        return [], f"Gmail not searched ({str(why)[:80]})"
    except Exception as e:                                   # noqa: BLE001
        return [], f"Gmail not searched ({str(e)[:80]})"
    out = []
    for m in msgs:
        h = m.get("headers") or {}
        ts = int(m.get("internalDate") or 0) / 1000
        date = datetime.fromtimestamp(ts, LONDON).strftime("%Y-%m-%d %H:%M") if ts else ""
        sender = str(h.get("from") or "")[:80]
        out.append({"date": date, "source": "email", "text": f"{sender}: {str(h.get('subject') or '')[:120]}", "id": m.get("id"),
                    "link": f"https://mail.google.com/mail/u/0/#all/{m.get('id')}" if m.get("id") else ""})
    note = "Gmail listing truncated (more than shown)" if truncated else ""
    return out, note


def history(emails=(), refs=(), properties=(), days=730, exclude_task=None, gmail=True):
    terms = history_terms(emails, refs, properties)
    searched = ["tasks"] + (["Gmail"] if gmail else [])
    entries, notes = [], []
    formula = history_formula(terms)
    if formula:
        for rec in query_tasks(formula, max_records=60):
            entries.extend(history_entries_from_task(rec, exclude_id=exclude_task))
        if gmail:
            g, note = history_gmail(terms, days)
            entries.extend(g)
            if note:
                notes.append(note)
    entries.sort(key=lambda e: e.get("date") or "")
    return {"terms": [f"{k} {v}" for k, v in terms], "searched": searched, "entries": entries, "notes": notes, "at": now_iso()}


def history_text(result):
    """The block an agent pastes into its output."""
    terms = ", ".join(result.get("terms") or []) or "nothing"
    searched = " + ".join(result.get("searched") or ["tasks"])
    entries = result.get("entries") or []
    notes = list(result.get("notes") or [])
    # A term that matches everything must never write tens of thousands of
    # characters into a task (25 Sep 2026). The newest lines are kept, and the
    # header says how many were left out, so the cut is visible on the card.
    if len(entries) > HISTORY_MAX_LINES:
        notes.append(f"showing the newest {HISTORY_MAX_LINES} of {len(entries)} lines")
        entries = entries[-HISTORY_MAX_LINES:]
    tail = ("; " + "; ".join(notes)) if notes else ""
    if not entries:
        return f"{TRACK_RECORD_MARK} none found (searched {searched} for {terms}{tail})"
    lines = [f"{TRACK_RECORD_MARK} (searched {searched} for {terms}{tail})"]
    for e in entries:
        day = e.get("date") or "undated"
        try:
            day = datetime.strptime(day[:10], "%Y-%m-%d").strftime("%d %b %Y") + (day[10:] if len(day) > 10 else "")
        except ValueError:
            pass
        # The link rides at the end in brackets: the card turns it into an
        # "Open" button, and the raw text still reads (Kevin, 8 Sep 2026:
        # "a clickable link so it opens, so I can see the full audit trail").
        # A file's own link is signed and dies within hours, while this text
        # waits on a card for days (2 Oct 2026: five dead file links on
        # three cards). The text names the task that holds the file, which the
        # card re-reads for a live link; the JSON keeps the file link for an
        # agent to download within its run.
        link = e.get("link")
        if e.get("source") == "file":
            link = f"https://airtable.com/{BASE_ID}/{TASKS}/{e['task']}" if e.get("task") else ""
        tail = f" ({link})" if link else ""
        lines.append(f"- {day} — {e.get('source', '')}: {e.get('text', '')}{tail}")
    return "\n".join(lines)


def cmd_history(args):
    refs = list(args.ref or [])
    for text in (args.from_text or []):
        refs.extend(reference_tokens(text))
    result = history(emails=args.email or [], refs=refs, properties=args.property or [],
                     days=args.days, exclude_task=args.task, gmail=not args.no_gmail)
    if args.text:
        print(history_text(result))
    else:
        print(json.dumps(result, indent=2))
    return 0


# ── Sign-ins: the list Kevin sees and the pickup after he signs in ──────────
# Kevin's ruling, 4 Sep 2026 ("crack on with the build"): a task blocked on a
# site sign-in is not a decision, it is a wait. The robot leaves ONE line,
# "SIGN-IN NEEDED: <site> (<url>)", and stops. `signin-waiting` groups those
# tasks by site for the morning message and the queue page; `signin-done`
# runs the moment he quits the sign-in window and hands every task waiting
# on that site straight back to its robot, so the work finishes while his
# session is live (an hour, for GOV.UK) instead of at the next slot.
# The site label may itself hold brackets ("Pingen (letters)"), so the site is
# everything up to an optional trailing "(https://…)" group.
SIGNIN_LINE_RE = re.compile(r"^\s*SIGN-IN NEEDED:\s*(?P<rest>.+?)\s*$", re.I | re.M)
SIGNIN_URL_RE = re.compile(r"https?://[^\s)>\]]+", re.I)
SIGNIN_DONE_MARK = "SIGNED IN:"
KEEPALIVE_MARK = "KEEPALIVE CHECK:"
SIGNIN_PICKUP_DIR = os.environ.get("SIGNIN_PICKUP_DIR") or os.path.expanduser("~/knowledge-os/logs/signin-pickup")
# A submit checks the session before it accepts a SIGN-IN NEEDED line (15 Sep
# 2026). When the check itself cannot run (robot profile busy, walk timed out)
# the line is kept and marked, as a dash aside so the parsers that split the
# site off at " — " (this file, the queue page) still read the site, and the
# digest's own parser strips it (scripts/slack-automation/approvals.js):
#   SIGN-IN NEEDED: Pingen (https://app.pingen.com/) — (unverified: profile busy)
SIGNIN_UNVERIFIED_MARK = "(unverified"
SIGNIN_UNVERIFIED_RE = re.compile(r"\s*(?:[—–-]\s*)?\(unverified(?::[^)]*)?\)\s*$", re.I)
SIGNIN_WALK_TIMEOUT = 300                # seconds: the walk's own worst case is ~125 s (door 48 s, two clicks 56 s each, One Login settle 20 s);
                                         # a site the robot signs itself back in to (Amazon, 2 Oct 2026) walks twice around a
                                         # 20-second plain window, worst case ~270 s. A timeout reads "unverified", never signed out.
SIGNIN_LEDGER_FRESH_MINUTES = 30         # a verdict newer than this is reused, not re-walked
BOT_CHECK_FRESH_MINUTES = 24 * 60        # a bot check seen today still stands (block refuses SIGN-IN)
BROWSER_LEDGER = (os.environ.get("AGENT_BROWSER_LEDGER")
                  or os.path.expanduser("~/knowledge-os/logs/agent-browser/runs.jsonl"))


def parse_signin_line(text):
    """The site and login URL a SIGN-IN NEEDED line names, or None.

    Agents do not keep to the form. On 8 Sep 2026 four live tasks read
    "SIGN-IN NEEDED: pingen.com (https://www.pingen.com/en/login) — to send the
    letter ..." and the strict "<site> (<url>)$" pattern took the whole sentence
    as the site and found no URL, so the Robot sign-in app never opened them.
    The URL is now taken from anywhere on the line and the site is the text
    before it, with a trailing "(one-hour window)" style aside removed.
    """
    m = SIGNIN_LINE_RE.search(str(text or ""))
    if not m:
        return None
    rest = m.group("rest").strip()
    verified = not SIGNIN_UNVERIFIED_RE.search(rest)
    rest = SIGNIN_UNVERIFIED_RE.sub("", rest).strip()
    u = SIGNIN_URL_RE.search(rest)
    url = u.group(0).rstrip(".,;:") if u else ""
    site = rest[:u.start()] if u else rest
    site = re.split(r"\s+[—–-]\s+", site, maxsplit=1)[0]
    site = site.rstrip(" (:-—–").strip()
    if not u:
        # "GOV.UK One Login (one-hour window)" — an aside, not part of the name.
        # A label like "Pingen (letters)" survives because it is matched on
        # the part before the bracket too.
        site = re.sub(r"\s*\((?!https?://)[^)]*\)\s*$", "", site).strip() or site
    return {"site": site, "url": url, "verified": verified}


GMAIL_SIGNIN_RE = re.compile(r"\bg[- ]?mail\b|mail\.google\.com|\bgoogle mail\b", re.I)

SIGNIN_SHARED_DOMAINS = {"google.com", "google.co.uk", "microsoft.com", "live.com", "office.com",
                         "apple.com", "amazon.com", "amazon.co.uk", "facebook.com", "meta.com"}


def signin_domain(host):
    """The registrable domain of a host: app.pingen.com -> pingen.com,
    www.topcashback.co.uk -> topcashback.co.uk."""
    parts = [p for p in str(host or "").lower().split(".") if p]
    if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in {"co", "gov", "org", "ac", "net", "ltd", "plc", "me", "sch", "nhs"}:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:]) if len(parts) >= 2 else ".".join(parts)


def node_bin():
    """launchd and AppleScript's `do shell script` have no nvm on PATH; the
    runners export AGENT_NODE_BIN (agent-tools.sh), and the nvm glob is the
    same second resort that file uses."""
    import glob, shutil
    node = (os.environ.get("AGENT_NODE_BIN") or shutil.which("node")
            or (sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/node"))) or [None])[-1])
    if not node:
        raise RuntimeError("node not found: no AGENT_NODE_BIN, not on PATH, no nvm install")
    return node


AGENT_BROWSER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent-browser.js")


def load_login_sites():
    """The allowlist as agent-browser.js sees it (builtins + sites.json),
    read through the script itself so the two never drift."""
    r = subprocess.run([node_bin(), AGENT_BROWSER, "sites"], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("agent-browser.js sites failed: " + (r.stderr or "")[:200])
    return json.loads(r.stdout)


def refresh_inconclusive(rec):
    """A `session` line whose own refresh could not run, or whose second read
    failed (agent-browser.js selfRefresh, Amazon, 2 Oct 2026). It says nothing
    settled about the login: walking again runs the refresh, so it is never
    reused as a verdict. The same test as session-keepalive.py session_state
    and signin_hold.py _read."""
    r = str((rec or {}).get("selfRefresh") or "")
    return r.startswith("not run") or "second read failed" in r


def ledger_session_verdict(host, max_age_minutes=SIGNIN_LEDGER_FRESH_MINUTES, path=None, now=None,
                           profile="default"):
    """The newest `session` verdict agent-browser.js logged for HOST, if it is
    under max_age_minutes old; else None. The ledger is append-only, one JSON
    line per browser command ({"at", "cmd": "session", "site", "signedIn",
    "url"}), so the last matching line is the newest."""
    newest = None
    try:
        with open(path or BROWSER_LEDGER) as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if (isinstance(rec, dict) and rec.get("cmd") == "session" and rec.get("site") == host
                        and (rec.get("profile") or "default") == profile):
                    newest = rec
    except OSError:
        return None
    if not newest or not newest.get("at") or refresh_inconclusive(newest):
        return None
    try:
        at = datetime.fromisoformat(str(newest["at"]).replace("Z", "+00:00"))
    except ValueError:
        return None
    now = now or datetime.now(timezone.utc)
    if now - at > timedelta(minutes=max_age_minutes):
        return None
    return {"signedIn": bool(newest.get("signedIn")), "botCheck": bool(newest.get("botCheck")),
            "url": str(newest.get("url") or ""), "at": str(newest["at"]), "source": "ledger"}


def ledger_signed_out(host, path=None, profile="default"):
    """The newest `session` verdict for HOST when it says signed out (no bot
    check) and no `login` on the same profile has run since; else None.

    A signed-out session cannot sign itself back in: only Kevin's sign-in
    window (`agent-browser.js login`) can, so until one runs the verdict holds
    at any age, and walking the door again only makes Kevin wait. Any login on
    the profile counts, not only this host's, because GOV.UK One Login is one
    sign-in across services. A signed-IN verdict is never reused here: that
    session may have lapsed (29 Sep 2026: Kevin pressed Sign in on WebFiling,
    last seen signed out eight hours earlier, and waited 48 s for the walk)."""
    newest, login_since = None, False
    try:
        with open(path or BROWSER_LEDGER) as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(rec, dict) or (rec.get("profile") or "default") != profile:
                    continue
                if rec.get("cmd") == "session" and rec.get("site") == host:
                    newest, login_since = rec, False
                elif rec.get("cmd") == "login" and newest is not None:
                    login_since = True
    except OSError:
        return None
    if not newest or login_since or newest.get("signedIn") or newest.get("botCheck") or not newest.get("at"):
        return None
    # The robot's own refresh could not run: a fresh walk runs it, and may need no sign-in at all.
    if refresh_inconclusive(newest):
        return None
    # Only a verdict that landed on a sign-in page (review, 29 Sep 2026): a walk
    # that met an error page or a slow load also reads "signed out", and trusted
    # at any age it would stand until Kevin's next sign-in. Anything else walks.
    # The walk records signinPage (a password box counts: BW Legal and Adobe show
    # one on an ordinary address); a line from before that field is read off its URL.
    page = newest.get("signinPage")
    if not (page is True or (page is None and signin_page_url(str(newest.get("url") or "")))):
        return None
    return {"signedIn": False, "botCheck": False, "url": str(newest.get("url") or ""),
            "at": str(newest["at"]), "source": "ledger"}


# The sign-in pages a walk lands on when the robot is signed out: a door path, or
# GOV.UK One Login itself. Mirrors sessionVerdict's door test in agent-browser.js,
# plus "logon" (TopCashback's door is /logon/).
SIGNIN_DOOR_URL_RE = re.compile(r"oauthSignIn|seclogin|/(?:log-?in|log-?on|sign-?in|signin|auth)(?:/|\?|$)", re.I)


def signin_page_url(url):
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return bool(SIGNIN_DOOR_URL_RE.search(url or "")) or host == "account.gov.uk" or host.endswith(".account.gov.uk")


def ledger_bot_check(hosts, max_age_minutes=BOT_CHECK_FRESH_MINUTES, path=None, now=None, profile="default"):
    """The newest browser look at any of HOSTS (a `session` line by its site or
    landing, or a `read` line by the page's host), if it showed the robot a bot
    check and is under max_age_minutes old; else None. The newest look decides:
    a later clean read of the same site means the check has gone. Agents meet
    the wall in their own reads as often as in a session walk (25 Sep 2026)."""
    want = {str(h or "").lower() for h in hosts if h}
    # A read on www.loom.com is a look at the entry loom.com: subdomains count, parents never.
    def matches(h):
        return bool(h) and any(h == w or h.endswith("." + w) for w in want)
    newest = None
    try:
        with open(path or BROWSER_LEDGER) as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(rec, dict) or rec.get("cmd") not in ("session", "read"):
                    continue
                if (rec.get("profile") or "default") != profile:
                    continue
                try:
                    url_host = (urllib.parse.urlsplit(str(rec.get("url") or "")).hostname or "").lower()
                except ValueError:
                    url_host = ""
                if matches(url_host) or matches(str(rec.get("site") or "").lower()):
                    newest = rec
    except OSError:
        return None
    if not newest or not newest.get("botCheck") or not newest.get("at"):
        return None
    try:
        at = datetime.fromisoformat(str(newest["at"]).replace("Z", "+00:00"))
    except ValueError:
        return None
    if (now or datetime.now(timezone.utc)) - at > timedelta(minutes=max_age_minutes):
        return None
    return {"at": str(newest["at"]), "url": str(newest.get("url") or ""), "cmd": newest.get("cmd")}


BOT_CHECK_ROUTE = ("A sign-in does not remove it and the robot never clicks one, so this is not a "
                   "SIGN-IN wall. If the step needs Kevin's own browser or a key only he can make "
                   "(an API key with the right permission), block it as KEVIN:\n"
                   "         python3 scripts/agent-dispatch.py block TASK --kind KEVIN --subject credential "
                   "--why \"<site> stops the robot with a bot check; <the exact step, or the key it needs>\"\n"
                   "       Block as TOOL only when code in this repo can build another route.")


def session_walk(host, timeout=SIGNIN_WALK_TIMEOUT, profile=None, url=None):
    """Walk HOST's sign-in door now (`agent-browser.js session --site HOST`).
    {"signedIn", "url", "at", "source": "walk"}, or {"error": why} when the
    walk could not run — never a guess."""
    try:
        node = node_bin()
    except RuntimeError as exc:
        return {"error": str(exc)}
    try:
        cmd = [node, AGENT_BROWSER, "session", "--site", host]
        if profile:
            cmd += ["--profile", profile]
        if url:
            cmd += ["--url", url]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"error": f"session walk timed out after {timeout}s (robot profile busy, or the site is slow)"}
    if r.returncode != 0:
        return {"error": (r.stderr or r.stdout or "session walk failed").strip()[-300:]}
    try:
        d = json.loads(r.stdout)
    except ValueError:
        return {"error": "session walk printed no JSON"}
    # Signed out only because the robot's own refresh could not run (Amazon,
    # 2 Oct 2026): not a verdict. The app marks it unverified; the submit gate
    # sends the agent back to read again rather than hand Kevin a sign-in.
    if not d.get("signedIn") and refresh_inconclusive(d):
        return {"error": "the robot's own refresh did not finish (" + str(d.get("selfRefresh"))[:150] + ")",
                "refreshNotRun": True}
    return {"signedIn": bool(d.get("signedIn")), "botCheck": bool(d.get("botCheck")),
            "url": str(d.get("url") or ""), "at": now_iso(), "source": "walk"}


def session_check(host, use_ledger=False, max_age_minutes=SIGNIN_LEDGER_FRESH_MINUTES,
                  trust_signed_out=False):
    """Is the robot signed in to HOST? A ledger verdict under max_age_minutes
    old is reused when use_ledger is set (the keep-alive and the pickup run
    walk every site anyway; walking again would fight them for the one robot
    profile); with trust_signed_out, a signed-out verdict with no sign-in
    since is reused at any age (ledger_signed_out) unless a bot check has been
    seen since; otherwise the door is walked now. SIGNIN_SKIP_WALK=1 (tests,
    and any read that must never open a browser) returns {"skipped": True}.

    trust_signed_out is for the Robot sign-in app's check only. The submit
    gate keeps walking: the newest line there is usually the agent's own walk
    of a moment ago, and the gate exists to catch a wrong one (review, 29 Sep
    2026)."""
    if os.environ.get("SIGNIN_SKIP_WALK"):
        return {"skipped": True}
    if use_ledger:
        v = ledger_session_verdict(host, max_age_minutes)
        if v:
            return v
    if trust_signed_out and not ledger_bot_check([host]):
        v = ledger_signed_out(host)
        if v:
            return v
    return session_walk(host)


def mark_signin_unverified(output, why=""):
    """Append the unverified aside to the SIGN-IN NEEDED line (first one)."""
    why = re.sub(r"\s+", " ", re.sub(r"[()\n]+", " ", str(why or ""))).strip()[:80]
    tail = " — (unverified" + (": " + why if why else "") + ")"
    m = SIGNIN_LINE_RE.search(output)
    if not m:
        return output
    # Inserted at the end of the site text, so the line break after it (and
    # the blank line before the closing line) is untouched.
    return output[:m.end("rest")] + tail + output[m.end("rest"):]


def signin_verify_line(output, sites=None, check=None):
    """(problem, output) for the SIGN-IN NEEDED line's live session state.

    problem is set when the site IS signed in — the agent wrote the line
    without looking, and the submit is refused with what to do instead.
    When the walk cannot run the line is kept and marked unverified (the
    app checks again before it opens a window). A line already marked, a
    line with no site the robot can open (signin_line_problem owns that
    refusal), or a walk skipped by SIGNIN_SKIP_WALK passes untouched."""
    m = parse_signin_line(output)
    if not m or not m["verified"]:
        return "", output
    sites = sites if sites is not None else load_login_sites()
    host = signin_site_for(m["site"], m["url"], sites)
    if not host or not sites.get(host, {}).get("login"):
        return "", output
    v = (check or session_check)(host)
    if v.get("skipped"):
        return "", output
    if v.get("refreshNotRun"):
        return (f"its SIGN-IN NEEDED line names {m['site']!r}, but {host} is a site the robot signs itself "
                f"back in to, and its refresh did not finish just now ({v['error'][:120]}). Nothing needs "
                f"Kevin: run `node scripts/agent-browser.js session --site {host}` again, which refreshes it, "
                "then do the work. If it still cannot finish, record the wall instead of a sign-in: "
                f"`python3 scripts/agent-dispatch.py block TASKID --kind SIGN-IN --subject {host} --why \"own refresh did not finish\"`. "
                "It clears itself when the next check signs the robot back in.", output)
    if v.get("error"):
        print(f"NOTE: sign-in line for {host} kept unverified — {v['error'][:160]}", file=sys.stderr)
        return "", mark_signin_unverified(output, v["error"])
    if v.get("botCheck"):
        # Kevin would be asked for a sign-in that cannot help (review, 25 Sep 2026).
        return (f"its SIGN-IN NEEDED line names {m['site']!r}, but {host} stops the robot with a bot "
                f"check (\"verify you are human\", seen at {str(v.get('at') or '')[:16]}). "
                + BOT_CHECK_ROUTE), output
    if not v.get("signedIn"):
        return "", output
    label = sites[host].get("label") or host
    landed = v.get("url") or "the site"
    return (f"its SIGN-IN NEEDED line names {m['site']!r}, but the robot IS signed in to "
            f"{label} (the session walk landed on {landed} at {str(v.get('at') or '')[:16]}).\n"
            "       Kevin is only asked for a sign-in the robot needs. Carry on with the work in "
            "this run:\n"
            f"         node scripts/agent-browser.js read/prepare on {host} (screenshots attached), "
            "then submit the finished work.\n"
            "       Write SIGN-IN NEEDED only when\n"
            f"         node scripts/agent-browser.js session --site {host}\n"
            "       prints signedIn false. Never judge a sign-in page by eye: the WebFiling "
            "door always shows one."), output


def signin_reopened_reason(t, now=None):
    """Why an open task is a hand-back Kevin's sign-in just created, or ''.

    signin-done sets the task to Today and appends the SIGNED IN stamp; the
    agent's next submit or annotate writes a newer stamp. So a task whose
    NEWEST Notes stamp is still SIGNED IN, with no approval outcome and Status
    Today/Overdue, has not been touched since the sign-in. On 11 Sep 2026 the
    pickup run died in eight seconds on the allowance limit and the three
    tasks it held sat in exactly this state for four days: the 30-minute poll
    counted only approved/changes/deferred hand-backs, so it never woke for
    them. A stamp older than IDLE_HOURS drops out (the session has lapsed by
    then; the daily slots take the task as ordinary new work), so a run that
    never touches one cannot wake the poll every half hour for ever."""
    if t.get("status") not in ("Today", "Overdue"):
        return ""
    last = None
    for m in NOTE_STAMP_RE.finditer(str(t.get("notes") or "")):
        last = m
    if not last:
        return ""
    text = last.group("text").lstrip()
    # A SIGN-IN wall the sign-in cleared (25 Sep 2026) is the same moment: the
    # session is live NOW, so the pickup run must work it, approved or not (an
    # approved carry-out keeps its verdict through the wake).
    via_wall = (text.startswith(f"{BLOCKER_CLEARED_MARK} (SIGN-IN ")
                and last.group("who").strip() == "Robot sign-in")
    if not (text.startswith(SIGNIN_DONE_MARK) or via_wall):
        return ""
    # A redo Kevin asked for is worked too (25 Sep 2026): the 6 Chedburgh quote,
    # "Changes requested", was skipped by the 15:00 pickup while TopCashback was
    # live and waited for the next half-hourly poll.
    if t.get("outcome") and not (via_wall and t.get("outcome") in APPROVED + ("Changes requested",)):
        return ""
    try:
        when = datetime.strptime(last.group("day") + " " + (last.group("time") or "00:00"),
                                 "%d %b %Y %H:%M").replace(tzinfo=LONDON)
    except ValueError:
        return ""
    now = now or datetime.now(timezone.utc)
    if now - when >= timedelta(hours=IDLE_HOURS):
        return ""
    # Anchored on our own wording, so a label that itself holds a dotted
    # bracket can never be taken for the host.
    site = re.search(r"\(([a-z0-9.-]+\.[a-z]{2,})\)\. The session is live now", last.group("text"))
    return (f"Kevin signed the robot in at {last.group('day')} {last.group('time') or ''}".rstrip()
            + (f" to {site.group(1)}" if site else "")
            + "; nothing has touched the task since — carry on from the SIGNED IN note"
            + (f" (session --site {site.group(1)} first)" if site else ""))


def mark_signin_reopened(tasks, now=None):
    """Flag every task a sign-in reopened (t["signinReopened"] = why) and
    return their ids in order. Pure apart from the flag."""
    ids = []
    for t in tasks:
        why = signin_reopened_reason(t, now)
        if why:
            t["signinReopened"] = why
            if t["id"] not in ids:
                ids.append(t["id"])
    return ids


def signin_line_problem(output, sites=None):
    """Why a SIGN-IN NEEDED line could not be acted on; '' when fine or absent."""
    m = parse_signin_line(output)
    if not m:
        return ""
    # Gmail is never a sign-in for Kevin (17 Sep 2026). The agents read the
    # mailbox headlessly through the triage worker, so "SIGN-IN NEEDED: Gmail"
    # parks work that was never blocked: three tasks sat waiting on it (a lead
    # reply, a council tax summary, a repair quote) while the same messages
    # were one search away.
    if GMAIL_SIGNIN_RE.search(m["site"] or "") or GMAIL_SIGNIN_RE.search(m["url"] or ""):
        return ("its SIGN-IN NEEDED line names Gmail, which is never a sign-in Kevin is asked for.\n"
                "       You can read the mailbox yourself: python3 scripts/inbound-triage.py search "
                "--q '<gmail query>' [--account info@agilelets.co.uk]. Read the message, then write "
                "the decision with what it actually says.")
    sites = sites if sites is not None else load_login_sites()
    host = signin_site_for(m["site"], m["url"], sites)
    entry = sites.get(host or "", {})
    if host and entry.get("login") and (entry.get("loginUrl") or m["url"]):
        return ""
    can = ", ".join(sorted(str(v.get("label") or h) for h, v in sites.items() if v.get("login") and v.get("loginUrl")))
    return (f"its SIGN-IN NEEDED line names {m['site']!r}, which is not a site the robot can "
            f"sign into (its list: {can}).\n"
            "       A sign-in line is a tap for Kevin on the Robot sign-in app; for a site off "
            "that list there is nothing to tap. Record the wall instead, so he is asked to add "
            "the site and the task wakes the moment it is on the list (25 Sep 2026: 'The robot "
            "has no access' lines were a dead end, Namecheap and BW Legal four times each):\n"
            "         python3 scripts/agent-dispatch.py block TASKID --kind SITE --subject "
            f"<the site's host> --why \"<what you need there>\"\n"
            "       Never tell him to log in and do it himself.")


def signin_door_host(host, sites):
    """The site whose door actually opens for HOST. One Login has no page of
    its own: its entries carry WebFiling's loginUrl, so a queue naming both
    "GOV.UK One Login" and "Companies House WebFiling" opened the same door
    twice (review, 8 Sep 2026). Fold onto the host that owns the door."""
    entry = sites.get(host) or {}
    url = entry.get("loginUrl") or ""
    try:
        door = (urllib.parse.urlparse(url).hostname or "").lower()
    except Exception:                                   # noqa: BLE001
        door = ""
    if door and door != host and sites.get(door, {}).get("login"):
        return door
    return host


def signin_site_for(line_site, line_url, sites):
    """Which allowlist host a SIGN-IN NEEDED line means. URL host first
    (exact or suffix), then the label, case-insensitive. None when unknown."""
    host = ""
    if line_url:
        try:
            host = urllib.parse.urlparse(line_url).hostname or ""
        except Exception:                                   # noqa: BLE001
            host = ""
    host = host.lower()
    # Longest match wins: "ewf.companieshouse.gov.uk" belongs to its own entry,
    # not to the "gov.uk" family that also happens to allow it.
    best = None
    for h in sites:
        if host and (host == h or host.endswith("." + h)) and (best is None or len(h) > len(best)):
            best = h
    if best:
        return signin_door_host(best, sites)
    # Same registrable domain: "www.pingen.com/en/login" is Pingen even though
    # the robot's entry is app.pingen.com. Only a site that can be signed into
    # counts here; a login: false entry (gov.uk) must not swallow a stranger.
    # Never on a shared platform domain: one google.com hosts Gmail, Drive and
    # AI Studio as separate sign-ins. On 17 Sep 2026 a Bromcom school portal
    # line pointing at a Gmail search was filed under "Google AI Studio", with
    # three unrelated tasks folded in after it.
    if host and signin_domain(host) not in SIGNIN_SHARED_DOMAINS:
        dom = signin_domain(host)
        for h, v in sites.items():
            if v.get("login") and signin_domain(h) == dom:
                return signin_door_host(h, sites)
    want = (line_site or "").strip().lower()
    # By label, sites the robot can sign into first: "Companies House" must
    # land on WebFiling (login: true, has a login page), not on the public
    # register entry that merely shares the name (found 8 Sep 2026).
    ordered = sorted(sites.items(), key=lambda kv: (not kv[1].get("login"), not kv[1].get("loginUrl")))
    for h, v in ordered:
        lab = str(v.get("label") or "").lower()
        if want and (want == lab or want in lab or lab.split(" (")[0] == want):
            return signin_door_host(h, sites)
    for h, _v in ordered:
        if want and want.replace(" ", "") in h.replace(".", ""):
            return signin_door_host(h, sites)
    return None


def signin_waiting(sites=None):
    """Every approval-queue task blocked on a sign-in, grouped by site."""
    sites = sites if sites is not None else load_login_sites()
    # FIND is case-sensitive; the line is written by an agent, so match on UPPER.
    recs = query_tasks("AND({Status}='Approval', FIND('SIGN-IN NEEDED', UPPER({Agent Output})))")
    groups = {}
    for rec in recs:
        f = rec.get("fields", {}) or {}
        # A Your step card is approved work waiting on Kevin's own step: a SIGN-IN NEEDED line in
        # the work below its step is history, and signin_done would wipe his approval (7 Oct 2026).
        if your_step_split(f.get(AF["agentOutput"]))[0] is not None:
            continue
        m = parse_signin_line(f.get(AF["agentOutput"]))
        if not m:
            continue
        host = signin_site_for(m["site"], m["url"], sites) or "unknown"
        entry = sites.get(host, {})
        # A site the robot cannot sign into gets its own group per name, so two
        # strangers (Namecheap, Xero) are never folded under the first one's label.
        key = host if host != "unknown" else "unknown:" + m["site"].lower()
        g = groups.setdefault(key, {"host": host, "label": entry.get("label") or m["site"],
                                    "loginUrl": entry.get("loginUrl") or m["url"] or "",
                                    "shortSession": bool(entry.get("shortSession")), "tasks": []})
        g["tasks"].append({"id": rec["id"], "name": f.get(AF["name"], ""),
                           "agent": ALL_AGENTS.get((links(f.get(AF["teamMember"])) or [None])[0], {}).get("agent", ""),
                           # False when the submit could not walk the door
                           # (profile busy): the app checks before it opens.
                           "verified": m["verified"]})
    # A SIGN-IN wall recorded with `block` (25 Sep 2026) waits on the same tap,
    # at any status: an approved carry-out that met a signed-out site is not in
    # the approval queue, and was never listed for Kevin before.
    blocked = query_tasks(
        f"AND(NOT({{Status}}='Completed'), FIND('{BLOCKER_OPEN_MARK} (SIGN-IN', {{Notes}}))")
    for rec in blocked:
        f = rec.get("fields", {}) or {}
        b = task_blocker(f.get(AF["notes"]))
        if not b or b["kind"] != "SIGN-IN":
            continue
        # The door host, as signin-done resolves it, or the tap never matches
        # (One Login's entries open WebFiling's door; review, 25 Sep 2026).
        host = signin_door_host(b["subject"], sites) if b["subject"] in sites else (
            signin_site_for("", "https://" + b["subject"] + "/", sites) or "unknown")
        entry = sites.get(host, {})
        key = host if host != "unknown" else "unknown:" + b["subject"]
        g = groups.setdefault(key, {"host": host, "label": entry.get("label") or b["subject"],
                                    "loginUrl": entry.get("loginUrl") or "",
                                    "shortSession": bool(entry.get("shortSession")), "tasks": []})
        if any(x["id"] == rec["id"] for x in g["tasks"]):
            continue
        g["tasks"].append({"id": rec["id"], "name": f.get(AF["name"], ""),
                           "agent": ALL_AGENTS.get((links(f.get(AF["teamMember"])) or [None])[0], {}).get("agent", ""),
                           "verified": True, "blocker": True})
    # Short-session sites first (a GOV.UK session lasts an hour, so it is signed
    # into last-but-worked first), then the site with the most waiting.
    return sorted(groups.values(), key=lambda g: (not g["shortSession"], -len(g["tasks"]), g["label"]))


def cmd_signin_waiting(args):
    """The sites with a task waiting on a sign-in, CHECKED: a site the robot is
    already signed into is handed straight back (the signin-done logic) and
    reported under alreadyLive, so the Robot sign-in app never opens a window
    for it (15 Sep 2026: Kevin was opening Facebook and Pingen windows for
    sessions the ledger showed live every hour). One walk per distinct site,
    reusing a ledger verdict under 30 minutes old; a walk that cannot run
    leaves the site listed with sessionCheck.state "unverified", never hidden.
    --no-walk (or SIGNIN_SKIP_WALK=1) is the plain listing, for callers that
    only need to know what is waiting (the keep-alive, tests). --dry-run walks
    and reports but hands nothing back (proof without a write). --site HOST
    checks that one site only (the app's per-site link); the rest are listed
    unchecked."""
    sites = load_login_sites()
    walk = not getattr(args, "no_walk", False) and not os.environ.get("SIGNIN_SKIP_WALK")
    dry = bool(getattr(args, "dry_run", False))
    only = (getattr(args, "site", "") or "").strip().lower()
    waiting, already_live, bot_checked = [], [], []
    groups = signin_waiting(sites)
    for g in groups:
        if not walk or g["host"] == "unknown" or not g["loginUrl"] or (only and g["host"] != only):
            waiting.append(g)
            continue
        v = session_check(g["host"], use_ledger=not g["shortSession"], trust_signed_out=True)
        if v.get("skipped"):
            waiting.append(g)
            continue
        if v.get("error"):
            g["sessionCheck"] = {"state": "unverified", "why": v["error"][:200]}
            waiting.append(g)
            continue
        if v.get("botCheck"):
            # The site stops the robot with "verify you are human" (Cloudflare,
            # 25 Sep 2026). A window would not help and a hand-back would only
            # send the agent into the same wall, so it is neither waiting nor
            # live: the app tells Kevin, and the task keeps its blocker.
            g["sessionCheck"] = {"state": "bot-check", "source": v["source"], "at": v["at"], "landedOn": v["url"][:160]}
            bot_checked.append(g)
            continue
        if not v.get("signedIn"):
            g["sessionCheck"] = {"state": "signed-out", "source": v["source"], "at": v["at"], "landedOn": v["url"][:160]}
            waiting.append(g)
            continue
        done = {"handedBack": []} if dry else signin_done(g["host"], sites, groups)
        already_live.append({"host": g["host"], "label": g["label"], "source": v["source"], "at": v["at"],
                             "landedOn": v["url"][:160], "handedBack": done["handedBack"],
                             "wouldHandBack": [t["id"] for t in g["tasks"]] if dry else None})
    print(json.dumps({"sites": waiting, "alreadyLive": already_live, "botCheck": bot_checked,
                      "dryRun": dry, "at": now_iso()}, indent=2))
    return 0


def cmd_signin_site(args):
    """Print the allowlist host a name or URL means, or 'unknown' (exit 1)."""
    host = signin_site_for(args.site, args.url, load_login_sites())
    print(host or "unknown")
    return 0 if host else 1


def cmd_signin_done(args):
    """Kevin quit the sign-in window for HOST: hand its waiting tasks back."""
    sites = load_login_sites()
    host = signin_site_for("", "https://" + args.site + "/", sites) or signin_site_for(args.site, "", sites)
    if not host:
        sys.exit(f"ERROR: {args.site!r} is not a login site on the allowlist")
    out = signin_done(host, sites)
    # A SITE wall his window answered clears now, not at the next half-hourly sweep. Never fatal:
    # the sweep still judges every wall, so a failed read here only means the card waits for it.
    try:
        woke = wake_site_walls_answered(sites)
    except Exception as exc:  # noqa: BLE001 — said on the output, never read as "nothing answered"
        out["siteWallsError"] = str(exc)[:200]
        woke = []
    # Its own key: the app counts handedBack as this site's tasks, and these are walls on other addresses.
    out["siteWallsCleared"] = [{"task": w["task"], "name": w["name"], "siteWall": w["subject"]} for w in woke]
    print(json.dumps(out, indent=2))


def signin_done(host, sites, groups=None):
    """The session on HOST is live (Kevin signed in, or the check found it
    so): hand every task waiting on it back to its robot and leave the ids in
    pending.jsonl for the pickup run. Returns the summary cmd_signin_done
    prints; cmd_signin_waiting calls it for a site that needed no window,
    passing the groups it already read."""
    stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
    handed = []
    for g in (groups if groups is not None else signin_waiting(sites)):
        if g["host"] != host:
            continue
        for t in g["tasks"]:
            rec = get_task(t["id"])
            f = rec.get("fields", {}) or {}
            team = links(f.get(AF["teamMember"])) or links(f.get(AF["sentForApprovalBy"]))
            b = task_blocker(f.get(AF["notes"]))
            if t.get("blocker"):
                # A `block`ed task keeps Kevin's verdict: the sign-in clears the
                # wall and the agent finishes what he approved. One cleared since
                # the list was read is left alone, never put through the reset
                # below, which would wipe his approval (review, 25 Sep 2026).
                if b and b["kind"] == "SIGN-IN":
                    woke = wake_blocked(t["id"], b, f"Kevin signed in to {g['label']} ({host}). The "
                                        "session is live now", by="Robot sign-in")
                    if woke:
                        handed.append({"task": t["id"], "agent": t["agent"], "name": woke["name"], "blocker": True})
                continue
            if KEEPALIVE_MARK in str(f.get(AF["notes"]) or ""):
                # Raised by the keep-alive because the session had lapsed; the
                # sign-in IS the whole job, so it closes here.
                patch_task(t["id"], {
                    AF["status"]: "Completed",
                    AF["completion"]: now_iso(),
                    AF["deferredUntil"]: None,
                    # Not agent work that skipped its approval: clear the
                    # submitter link so the daily "completed without approval"
                    # invariant does not count it (review, 4 Sep 2026).
                    AF["sentForApprovalBy"]: [],
                    AF["notes"]: (str(f.get(AF["notes"]) or "").rstrip() +
                                  f"\n\n[{stamp} — Robot sign-in] Kevin signed in to {g['label']}; "
                                  "the robot's session is back. Nothing else to do.").strip()[-90000:],
                })
                handed.append({"task": t["id"], "agent": t["agent"], "name": t["name"][:80], "closed": True})
                continue
            note = (f"[{stamp} — Robot sign-in] {SIGNIN_DONE_MARK} Kevin signed in to "
                    f"{g['label']} ({host}). The session is live now: carry on from where you stopped "
                    f"and submit the finished work. Do not write SIGN-IN NEEDED again unless "
                    f"the site is signed out when you look.")
            patch_task(t["id"], {
                AF["status"]: "Today",
                AF["dueDate"]: today_london(),
                AF["teamMember"]: team,
                AF["assignee"]: None,
                AF["sentForApprovalBy"]: [],
                AF["approvalOutcome"]: None,
                AF["approvalFeedback"]: None,
                AF["approvedAt"]: None,
                AF["deferredUntil"]: None,
                AF["notes"]: (str(f.get(AF["notes"]) or "").rstrip() + "\n\n" + note).strip()[-90000:],
            })
            handed.append({"task": t["id"], "agent": t["agent"], "name": t["name"][:80]})
    # The pickup run copies this file once Kevin has quit the last window (and
    # trims the lines it worked after a clean run), so one run works every
    # site he signed into.
    reopened = [h["task"] for h in handed if not h.get("closed")]
    if reopened:
        import fcntl
        os.makedirs(SIGNIN_PICKUP_DIR, exist_ok=True)
        # Locked: the pickup run trims this file (read, filter, replace) under
        # the same lock, so a line landing mid-trim is never dropped.
        with open(os.path.join(SIGNIN_PICKUP_DIR, "pending.jsonl"), "a") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            fh.write(json.dumps({"at": now_iso(), "host": host, "label": sites[host].get("label"),
                                 "tasks": reopened}) + "\n")
            fh.flush()
            fcntl.flock(fh, fcntl.LOCK_UN)
    return {"site": host, "label": sites[host].get("label"), "handedBack": handed}


def task_owes_certificate(task_id, task):
    """Why a task may not close yet, or "". `task` carries name, description,
    notes and attachments (a task_view, or the same four keys). The compliance
    book is read only when the task could owe a filing at all, so an ordinary
    close costs nothing; an unreadable book reads as owed, never as clear."""
    if not certificate_watch.certificate_owed(task, []):
        return ""
    try:
        linked = [c for c in fetch_certificates(refresh=True) if task_id in c["taskIds"]]
    except Exception as exc:                              # noqa: BLE001
        return ("this task names a certificate and a file arrived on it, and the compliance "
                f"book could not be read to check it was filed ({str(exc)[:120]})")
    return certificate_watch.certificate_owed(task, linked)


def task_fields_owe_certificate(task_id, tf):
    """task_owes_certificate for a raw Airtable fields dict."""
    return task_owes_certificate(task_id, {
        "name": tf.get(AF["name"]), "description": tf.get(AF["description"]),
        "notes": tf.get(AF["notes"]), "attachments": tf.get(AF["attachments"]) or []})


def cmd_complete(args):
    t = task_view(get_task(args.task))
    if t["outcome"] not in APPROVED:
        sys.exit(f"ERROR: refusing to complete {args.task} — outcome is "
                 f"'{t['outcome'] or 'empty'}', not an approval. Only "
                 "approved, carried-out work completes.")

    # A MERGE card closes only on its merge (7 Oct 2026): merge-approved.py completes it with the
    # merge commit. Closed any other way, the PR would sit open with its TOOL walls for ever.
    merge_pr = merge_card.pr_number(t["name"])
    if merge_pr is not None and not re.search(r"\bPR #%d merged as [0-9a-f]{7,40}\b" % merge_pr,
                                              str(getattr(args, "evidence", "") or "")):
        sys.exit(f"ERROR: refusing to complete {args.task}: it is the MERGE card for PR #{merge_pr}, and it "
                 "closes only when that PR has merged (scripts/merge-approved.py does it, with the merge "
                 "commit as evidence).")

    # THE SIGNATURE-WATCH GATE (1 Sep 2026). A SIGN carry-out is not done when
    # the request is sent; it is done when the signed copy can find its way
    # back. On 28 Aug 2026 four letters of authority were "sent", completed,
    # and never watched — they sat as Adobe drafts for four days and the
    # watcher's ledger read "nothing registered and unsigned" the whole time.
    # Refusing HERE is the point: an unwatched agreement is invisible for ever.
    if sign_output_needs_watch(t["agentOutput"]) and \
            not signature_watch_registered(args.task):
        sys.exit(
            f"ERROR: refusing to complete {args.task} — this is a SIGN "
            "carry-out and no signature watch is registered for it.\n"
            "       Arm the return leg first:\n"
            f"         node scripts/signature-watch.js register --task "
            f"{args.task} --agreement \"<Adobe agreement name>\" "
            "--then post|email\n"
            "       then complete. A signature request nobody is watching "
            "is the 28 Aug 2026 four-drafts failure again.")

    # THE MINOR-EDITS GATE (Kevin's ruling, 26 Aug 2026). If he asked for an
    # edit, it must have been applied before the action. Refusing HERE rather
    # than flagging it in verify afterwards is the point: verify runs after the
    # email has gone, and an unedited email cannot be unsent.
    if (t["outcome"] == "Approved with minor edits"
            and str(t["feedback"] or "").strip()
            and EDITS_APPLIED_MARK not in (t["notes"] or "")):
        sys.exit(
            f"ERROR: refusing to complete {args.task} — Kevin approved it "
            "WITH EDITS and no edit was applied.\n"
            f"       He asked for: {' '.join(str(t['feedback']).split())[:200]}\n"
            "       Apply it to the Agent Output, then run:\n"
            f"         python3 scripts/agent-dispatch.py revise {args.task} "
            "--output-file <file>\n"
            "       and carry out the REVISED text. Completing without it "
            "sends the version he asked to change.")

    # Carrying the action out and CLOSING the task are two different things.
    #
    # Until 13 Aug 2026 they were one. `complete` was the only success state, so
    # an agent that had done exactly what Kevin approved had no way to say "done,
    # but this stays open" — and two tasks whose approved text said DO NOT CLOSE
    # were marked Completed anyway, with an apologetic note attached. The
    # obligation was real and ongoing; the reminder for it was destroyed.
    #
    # --keep-open is that second state. It records the carry-out where Kevin can
    # see it and leaves Status and Completion Date untouched, so the task stays
    # in the queue it is meant to stay in. The agent decides from the approved
    # text, which is the only place the instruction ever appears.
    #
    # Notes carries the marker rather than a new Airtable field: Notes already
    # holds the agent's audit trail (see cmd_annotate) and needs no schema
    # change, so this cannot be blocked on a base edit. CARRIED_OUT_MARK is the
    # machine-readable half — verify re-reads the LIVE record for it, never
    # trusting what the run claimed.
    if args.keep_open and (getattr(args, "no_certificate", "") or "").strip():
        sys.exit(f"ERROR: refusing to complete {args.task}: --no-certificate closes a task, "
                 "and --keep-open leaves it open. Use one. The reason would be dropped.")
    if args.keep_open:
        stamp = datetime.now(LONDON).strftime("%d %b %Y")
        detail = (args.note or "the approved action").strip()
        mark = (f"[{stamp} — agent] {CARRIED_OUT_MARK} {detail}. "
                "Left OPEN deliberately: the approval said so.")
        existing = t["notes"] or ""
        patch_task(args.task, {AF["notes"]: (existing + "\n\n" + mark).strip()})
        ledger_append(args.task, "done")
        print(json.dumps({"carriedOut": args.task, "keptOpen": True,
                          "status": t["status"]}))
        return

    # THE CERTIFICATE-OWED GATE (Kevin, 2 Oct 2026). A gas safety record came
    # in on 16 Sep on a task named for its INVOICE. The agent checked the
    # payment three times, wrote "no certificate filed" in its own output, and
    # closed the task; the filing gate in verify only covers engine-raised
    # renewals. The book read "missing" for 18 days after a paid visit. Any
    # task that names a certificate and received a file now closes only when
    # the certificate is filed, or the agent says on the record what the file
    # actually is. Refused HERE because verify runs after the close.
    no_cert = (getattr(args, "no_certificate", "") or "").strip()
    no_cert_note = ""
    if no_cert:
        stamp = datetime.now(LONDON).strftime("%d %b %Y")
        no_cert_note = (f"[{stamp} — agent] {certificate_watch.NO_CERTIFICATE_MARK} "
                        f"{no_cert}")
    else:
        owed = task_owes_certificate(args.task, t)
        if owed:
            sys.exit(
                f"ERROR: refusing to complete {args.task}: {owed}.\n"
                "       A paid visit with no certificate in the book gets bought twice.\n"
                "       File it first:\n"
                f"         python3 scripts/agent-dispatch.py certificate {args.task} "
                "--property <rec> --type <type> --renewal YYYY-MM-DD --file <path>\n"
                "       (save the email's attachment with scripts/inbound-triage.py "
                "attachments --q ...).\n"
                "       If the file that arrived is NOT a certificate, say what it is:\n"
                f"         python3 scripts/agent-dispatch.py complete {args.task} "
                "--no-certificate \"<it is a quote / an invoice only / a photo>\"")

    # THE BLOCKER GATE (Kevin, 25 Sep 2026). A task whose agent hit a wall is
    # not done because the wall was reported. Only the fix, or proof that the
    # step Kevin owed has happened, clears it. See THE BLOCKER LOOP below.
    b = task_blocker(t["notes"])
    if b:
        # An agent that tries to close an approved task on a KEVIN wall has done its part:
        # only his step is left, so the card goes back to his lane now (7 Oct 2026), and the
        # task rests until he says it is done.
        surfaced = surface_your_step(args.task, b, t) if b["kind"] == "KEVIN" else {}
        if surfaced:
            ledger_append(args.task, "parked")
        sys.exit(
            f"ERROR: refusing to complete {args.task}: it is blocked "
            f"({b['kind']} {b['subject']}: {b['why'][:160]}).\n"
            f"       Fix: {blocker_fix_text(b)}\n"
            + ("       It is back in Kevin's approval queue as Your step.\n" if surfaced else "")
            + "       The task wakes by itself when the cause is fixed. If the job is\n"
            "       in fact done, prove it first:\n"
            f"         python3 scripts/agent-dispatch.py unblock {args.task} "
            "--evidence \"<what you saw that proves it>\"")

    # Written with the close, never before it: a refused close leaves no mark.
    evidence = " ".join(str(getattr(args, "evidence", "") or "").split())
    if evidence:
        stamp = datetime.now(LONDON).strftime("%d %b %Y")
        no_cert_note = (no_cert_note + "\n\n" if no_cert_note else "") + \
            f"[{stamp} — agent] DONE, evidence: {evidence[:600]}"
    declared = ({AF["notes"]: ((t["notes"] or "") + "\n\n" + no_cert_note).strip()[-90000:]}
                if no_cert_note else {})

    patch_task(args.task, {
        AF["status"]: "Completed",
        AF["completion"]: now_iso(),
        **declared,
    })
    ledger_append(args.task, "done")
    print(json.dumps({"completed": args.task}))


# ─── TRIAL CARDS ARE SETTLED IN CODE (2 Oct 2026) ─────────────────────
#
# A trial agent's card is the parallel run GUARDRAILS asks for: Kevin's verdict
# is the whole result and nothing is sent. So an approved one needs no agent and
# no carry-out, only its mark. This runs in the half-hourly poll, after `lessons`
# (so a note Kevin ticked Remember on is stored first), and closes every approved
# trial card with the verdict in Notes. A rejected card is closed by the queue
# page already; a sent-back one goes round the redo loop like any other card.
# A robot form card is never settled here: the rent check reads its verdict and
# finishes it once Kevin has sent the form (agent_email_format.FORM_CARDS).
def trial_approved_tasks():
    rows = query_tasks("AND(LEN({Approval Outcome}&'')>0, NOT({Status}='Completed'), NOT({Status}='Cancelled'))")
    out = []
    for rec in rows:
        t = task_view(rec)
        # The queue's own order (review, 4 Oct 2026): Kevin's answer to a DECIDE: card goes to the Task
        # Manager, and an agent on its own go signal carries out its own cards, before any trial check.
        if is_decide_card(t["agentOutput"]) or own_go_signal(t["agentId"]):
            continue
        if t["outcome"] in APPROVED and trial_problem(t["sentForApprovalByIds"] + t["teamMemberIds"], t["name"], t["notes"],
                                                      t["approvedAt"]) \
                and not form_card(t["name"], t["notes"]):
            out.append(t)
    return out


def cmd_trial_settle(args):
    settled = []
    for t in trial_approved_tasks():
        stamp = note_line("trial-settle", f"{TRIAL_STAMP}: Kevin's verdict was '{t['outcome']}'. Nothing was sent: "
                                          f"{trial_problem(t['sentForApprovalByIds'] + t['teamMemberIds'], t['name'], t['notes'], t['approvedAt'])}.")
        patch_task(t["id"], {AF["status"]: "Completed", AF["completion"]: now_iso(),
                             AF["notes"]: append_notes(t["notes"], stamp)})
        ledger_append(t["id"], "done")
        settled.append({"task": t["id"], "name": t["name"], "outcome": t["outcome"]})
    print(json.dumps({"trialSettled": settled}))


# ─── THE BLOCKER LOOP (Kevin, 25 Sep 2026) ────────────────────────────
#
# "Currently, an AI agent tries to do something, hits a blockage, and then it
# sits there or gets forgotten." What was measured that day:
#
#   * 6 Chedburgh Place landlord insurance (recPYIC5nn7v2bh8e) was PARKED nine
#     times between 15 and 25 Sep 2026. The wall moved three times: TopCashback
#     signed out, then not on the robot's site list, then node missing from
#     PATH. A PARKED note only rested the task for a day. Nobody was asked to
#     fix walls two and three, and the house had no policy on record.
#   * The agents' fix requests ("add Namecheap", "node unavailable", "no way
#     to retype an approved task") were medium findings over a full queue, so
#     they went to an overflow log nothing reads, or the fixer deferred them as
#     protected "for Kevin" and nothing told him (42 since 1 Sep).
#   * A fix never woke the task. Only a sign-in did.
#   * An agent that could not do the work wrote the work into its closing line
#     as Kevin's ("Kevin visiting TopCashback ... completing an online
#     quote"). He approved, nothing was carried out, the task closed on 13 Sep,
#     and the Swinton policy renewed (recc2fdXwsHLMAKU3).
#
# So a wall is now a record with a KIND, and each kind has an owner and a
# wake condition:
#
#   SIGN-IN  a site on the robot's list is signed out. Kevin signs in with the
#            Robot sign-in app; signin_done wakes the task.
#   SITE     the robot's list cannot reach the site (not on it, or on it with
#            no sign-in page). Kevin adds it with "Add a new site"; the sweep
#            sees it on the list and wakes the task.
#   TOOL     the robot's own setup is broken (a script refuses, a command is
#            missing). Filed as a HIGH finding, which the cap never refuses;
#            the sweep wakes the task when the finding closes fixed.
#   KEVIN    a step only Kevin may take (payment, purchase, signature,
#            credential, identity, physical). The task stays open until the
#            agent sees proof it happened and runs `unblock --evidence`.
#
# The record lives in the task's own Notes as a marker line, so Airtable is
# the one source of truth, the card shows it, and no local file can drift from
# it. The newest marker wins: BLOCKER OPEN until a later BLOCKER CLEARED.
# `complete` refuses while one is open, `submit` refuses a closing line that
# hands the job to Kevin unless it declares a KEVIN step, and `blockers
# --check` fails on any wall older than BLOCKER_STALE_DAYS or any task closed
# while blocked, which is how a trust surface reports what did NOT happen.
BLOCK_KINDS = ("SIGN-IN", "SITE", "TOOL", "KEVIN")
KEVIN_ONLY_REASONS = ("payment", "purchase", "signature", "credential", "identity", "physical")
# Kevin's turn (30 Sep 2026): a KEVIN wall whose website step has a handover
# plan here is done from the AI Agents page's "Your turn" button (the robot
# fills everything, then hands him the window). Private: plans carry his details.
HANDOVER_DIR = os.environ.get("AGENT_HANDOVER_DIR") or os.path.expanduser("~/knowledge-os/handover")
TURN_TASK_RE = re.compile(r"^rec[A-Za-z0-9]{14}$")


ROBOT_LOG = os.environ.get("AGENT_BROWSER_LEDGER") or os.path.expanduser("~/knowledge-os/logs/agent-browser/runs.jsonl")
TURN_NOT_FINISHED = "Your turn window closed without Kevin finishing"   # the Robot sign-in app's "Not yet" note


def form_turn_unanswered(task_id, name="", notes=""):
    """True for a robot form card whose window has closed more times than the Robot sign-in app recorded
    Kevin saying he had not finished: his answer never arrived (the app failed, or was quit with the
    question up). He may have sent the government form, so neither the button nor the window offers it
    again (scripts/rent_new_tenant.py may_have_sent closes the step once his answer has had time).
    A log that cannot be read counts as unanswered: the window is refused, never offered blind."""
    if not form_card(name, notes):
        return False
    opens = closes = 0
    try:
        with open(ROBOT_LOG, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict) and row.get("task") == task_id:
                    opens += row.get("cmd") == "handover-open"
                    closes += row.get("cmd") == "handover"
    except FileNotFoundError:
        return False
    except OSError:
        return True
    # Every window that OPENED counts, closed or not: one that crashed after he sent the form never logs
    # its close, and the app never asks him.
    return max(opens, closes) > str(notes or "").count(TURN_NOT_FINISHED)


def handover_plan_problem(task_id):
    """Why the Your turn window would refuse this task's plan, or '' (no plan, it passes, or the check
    could not run, in which case the window still checks it).

    A PLAN IS CHECKED BEFORE ITS BUTTON SHOWS (Kevin, 8 Oct 2026). The plan's shape was checked only
    when Kevin pressed Your turn, so a hand-written plan missing a step's "until" put a button on his
    card that opened nothing but "BROWSER REFUSED: step 6 (kevin) needs say and one of untilUrl...".
    The check is agent-browser.js's own assertHandoverPlan, run through node, so the two never drift."""
    path = os.path.join(HANDOVER_DIR, (task_id or "") + ".json")
    if not TURN_TASK_RE.match(task_id or "") or not os.path.isfile(path):
        return ""
    js = ("const ab=require(process.argv[1]);const fs=require('fs');"
          "try{ab.assertHandoverPlan(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));console.log('PLAN OK')}"
          "catch(e){console.log('PLAN REFUSED '+String((e&&e.message)||e).replace(/\\s+/g,' '))}")
    try:
        r = subprocess.run([node_bin(), "-e", js, AGENT_BROWSER, path], capture_output=True, text=True, timeout=60)
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as e:
        print(f"WARNING: the Your turn plan for {task_id} could not be checked: {e}", file=sys.stderr)
        return ""
    lines = (r.stdout or "").strip().splitlines()
    last = lines[-1] if lines else ""
    if last.startswith("PLAN REFUSED "):
        return last[len("PLAN REFUSED "):].replace("BROWSER REFUSED: ", "").strip()
    if last != "PLAN OK":
        print(f"WARNING: the Your turn plan check for {task_id} said nothing usable: {(r.stderr or '')[-200:]}",
              file=sys.stderr)
    return ""


PLAN_REPAIR_STATE = "plan-repairs.json"
# No "repair" or "maintenance" word: the create gate's fold lanes read those, and a PLAN REPAIR: task
# folded into an open maintenance job, or into the card itself, so none was made (review, 8 Oct 2026).
PLAN_REPAIR_PREFIX = "YOUR TURN PLAN REFUSED: "
PLAN_REPAIR_AGAIN_DAYS = 3


def plan_repair_task(t, problem, now=None):
    """Raise ONE task for the card's agent to rewrite a Your turn plan the window refuses. Created
    straight (force: the duplicate fold would put it into an unrelated task); this function is its own
    duplicate check: never while one is open, once per version of the plan file, and again after
    PLAN_REPAIR_AGAIN_DAYS if a repair closed and the plan is still refused (the lane's clock).
    Returns what was done, or {} when nothing was."""
    path = os.path.join(HANDOVER_DIR, t["id"] + ".json")
    try:
        version = str(int(os.path.getmtime(path)))
    except OSError:
        return {}
    now = now or datetime.now(timezone.utc)
    state_path = os.path.join(STATE_DIR, PLAN_REPAIR_STATE)
    try:
        with open(state_path) as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        state = {}
    if not isinstance(state, dict):
        state = {}
    seen = state.get(t["id"]) if isinstance(state.get(t["id"]), dict) else {}
    name = (PLAN_REPAIR_PREFIX + str(t.get("name") or t["id"]))[:120]
    open_now = query_tasks(f"AND({{Task Name}}={_airtable_quote(name)},NOT({{Status}}='Completed'),"
                           "NOT({Status}='Cancelled'))", max_records=1, minimal=True)
    if open_now:
        return {}
    raised = _utc(seen.get("at") or "")
    if seen.get("version") == version and raised and now - raised < timedelta(days=PLAN_REPAIR_AGAIN_DAYS):
        return {}
    # The card's own agent; a person (Roy) or nobody linked sends it to the AI CEO, never to a human.
    agent = t.get("agentId") if t.get("agentId") in ALL_AGENTS else CEO_REC_ID
    fields = {
        AF["name"]: name,
        AF["description"]: (
            f"The Your turn plan for {t['id']} ({path}) is refused by the window, so Kevin's Your turn button "
            f"is hidden until it passes:\n\n{problem[:600]}\n\nRewrite the plan so "
            f"`node scripts/agent-browser.js handover --task {t['id']} --dry-run --shot <file>` runs clean, then "
            "close this task with that result as evidence. The card itself stays in Kevin's lane as Your step: "
            "do not submit, move or rewrite it."),
        AF["status"]: "Today",
        AF["dueDate"]: today_london(),
        AF["teamMember"]: [agent],
    }
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = _gate().cmd_create(fields, force=True)
    try:
        said = json.loads(out.getvalue().strip().splitlines()[-1])
    except (ValueError, IndexError):
        said = {}
    if said.get("action") != "created" or not said.get("taskId"):
        raise RuntimeError(f"the repair task for {t['id']} was not created (exit {code}, {said or 'no answer'})")
    # Exit 4 (made, with a later step incomplete) is still a task made: its clock is recorded (review round 2).
    state[t["id"]] = {"version": version, "at": now.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "repair": said.get("taskId")}
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = state_path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh)
    os.replace(tmp, state_path)
    return {"task": t["id"], "repair": said.get("taskId"), "action": "created"}


def handover_ready(task_id, b, outcome="", task=None):
    """True when Kevin has APPROVED the card and its KEVIN wall has a handover plan
    on file. The wall opens at submit, before he has seen the card, so a plan alone
    is not a turn (review, 30 Sep 2026): the button would open a window the
    handover then refuses as unapproved."""
    if not (b.get("kind") == "KEVIN" and str(outcome or "").startswith("Approved")
            and bool(TURN_TASK_RE.match(task_id or ""))
            and os.path.isfile(os.path.join(HANDOVER_DIR, task_id + ".json"))):
        return False
    if task and form_turn_unanswered(task_id, task.get("name"), task.get("notes")):
        return False
    # A plan whose answers hold only until a day (the DWP form's arrears answer, scripts/rent_form_plan.py)
    # shows no button after it: agent-browser.js would refuse it, and the rent check raises a fresh card.
    try:
        with open(os.path.join(HANDOVER_DIR, task_id + ".json")) as fh:
            until = str((json.load(fh) or {}).get("validUntil") or "")
    except (OSError, ValueError, AttributeError):
        return True                                  # the window itself checks the plan, and says why
    return not until or today_london() <= until
BLOCKER_OPEN_MARK = "BLOCKER OPEN"
BLOCKER_CLEARED_MARK = "BLOCKER CLEARED"
BLOCKER_STALE_DAYS = 3
BLOCKER_LINE_RE = re.compile(
    r"^\[[^\]\n]*\]\s*(?P<mark>BLOCKER OPEN|BLOCKER CLEARED)\s*"
    r"\((?P<kind>SIGN-IN|SITE|TOOL|KEVIN) (?P<subject>[^)\n]+)\):\s*(?P<rest>[^\n]*)$", re.M)
BLOCKER_SINCE_RE = re.compile(r"\[since (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]")
BLOCKER_FINDING_RE = re.compile(r"\[finding (\d{8}-[\w-]+-\d{3,})\]")
BLOCKER_PROFILE_RE = re.compile(r"\[profile ([a-z0-9][a-z0-9-]*)\]", re.I)


def task_blocker(notes):
    """The task's open blocker, or None. Newest marker wins."""
    last = None
    for m in BLOCKER_LINE_RE.finditer(str(notes or "")):
        last = m
    if not last or last.group("mark") != BLOCKER_OPEN_MARK:
        return None
    rest = last.group("rest")
    since = BLOCKER_SINCE_RE.search(rest)
    finding = BLOCKER_FINDING_RE.search(rest)
    profile = BLOCKER_PROFILE_RE.search(rest)
    why = BLOCKER_SINCE_RE.sub("", BLOCKER_FINDING_RE.sub("", BLOCKER_PROFILE_RE.sub("", rest)))
    why = why.split(" Fix: ")[0].strip()
    return {"kind": last.group("kind"), "subject": last.group("subject").strip(),
            "why": why, "since": since.group(1) if since else "",
            "finding": finding.group(1) if finding else "",
            "profile": profile.group(1) if profile else ""}


def blocker_fix_text(b):
    kind, subject = b["kind"], b["subject"]
    if kind == "SIGN-IN":
        who = f" ({b['profile']})" if b.get("profile") else ""
        return f"Kevin signs in to {subject}{who} with the Robot sign-in app."
    if kind == "SITE":
        return (f"Kevin adds {subject} to the robot's list with \"Add a new site\" "
                "in the Robot sign-in app.")
    if kind == "TOOL":
        ref = f" (finding {b['finding']})" if b.get("finding") else ""
        # Kevin, 7 Oct 2026: a protected-file fix is no longer a dead end. The fixer opens
        # the PR and a MERGE card comes to him (scripts/merge_card.py).
        return (f"the robot's setup is repaired{ref}; for a protected file, the fixer opens "
                "the PR and a MERGE card comes to Kevin.")
    return (f"Kevin does the {subject} step; the task stays open until the agent "
            "sees proof it happened.")


def blocker_host(subject):
    """A SIGN-IN or SITE subject as a lowercase host: a URL or a bare host."""
    s = str(subject or "").strip()
    try:
        host = urllib.parse.urlparse(s if "://" in s else "https://" + s).hostname or ""
    except ValueError:
        host = ""
    return host.lower() if "." in host else ""


def site_reachable(host, sites):
    """The allowlist entry that lets the robot sign in to HOST, or ''. Its own
    entry or the nearest parent, and it must hold a login with a sign-in page:
    TopCashback sat on the list from 7 Sep with no page, so no session check
    or sign-in window could ever open it."""
    best = ""
    for h in sites:
        if (host == h or host.endswith("." + h)) and len(h) > len(best):
            best = h
    if not best:
        best = signin_site_for("", "https://" + host + "/", sites) or ""
    v = sites.get(best) or {}
    # A site whose sign-ins live on separate profiles (Utilita's flats) has no
    # top-level page by design, and "Add a new site" treats it as covered, so
    # it is reachable: its wall is a SIGN-IN, never a SITE that cannot clear.
    return best if v.get("login") and (v.get("loginUrl") or v.get("profiles")) else ""


def file_tool_finding(task_id, subject, why):
    """File (or fold into) a HIGH finding for a TOOL wall; its id, or ''.
    High, because the cap sends anything lower to an overflow log no job
    reads, which is where "node unavailable" sat for four days."""
    r = subprocess.run(
        [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "findings.py"),
         "add", "--routine", "agent-dispatch", "--severity", "high", "--touches-code",
         "--title", f"Agent blocked: {subject}"[:160],
         "--where", "the robot's own setup (blocks agent work)",
         "--detail", f"{why} First seen on task {task_id}.",
         "--fix", ("Repair it so the agent can finish. Closing this finding as fixed "
                   "wakes every task blocked on it (agent-dispatch.py blockers --sweep).")],
        capture_output=True, text=True)
    fid = (r.stdout or "").strip().splitlines()[:1]
    return fid[0] if r.returncode == 0 and fid and BLOCKER_FINDING_RE.match(f"[finding {fid[0]}]") else ""


def finding_states():
    """finding id -> status, read through findings.py so the two agree."""
    import findings as _findings  # noqa: E402 — scripts/ is on sys.path above
    return {k: v.get("status", "") for k, v in _findings.current_state().items()}


def profile_door(host, profile, sites):
    """The sign-in page of HOST's named profile, or ''."""
    for p in (sites.get(host) or {}).get("profiles") or []:
        if isinstance(p, dict) and p.get("profile") == profile:
            return p.get("loginUrl") or ""
    return ""


def blocker_clear_reason(b, sites, fstates, walk=None):
    """Why this wall is gone, or '' while it stands. SIGN-IN clears in
    signin_done (the sign-in IS the event); KEVIN clears only on the agent's
    evidence (`unblock`), never on a guess."""
    if b["kind"] == "SITE":
        host = blocker_host(b["subject"])
        entry = site_reachable(host, sites) if host else ""
        return (f"{host} is on the robot's list now, with its sign-in page ({sites[entry].get('loginUrl')})"
                if entry else "")
    if b["kind"] == "SIGN-IN" and b.get("since"):
        # Signed in some other way (the keep-alive, a sign-in for another task):
        # a session check newer than the wall that found it live.
        profile = b.get("profile") or "default"
        v = ledger_session_verdict(b["subject"], max_age_minutes=IDLE_HOURS * 60, profile=profile)
        if v and v["signedIn"] and v["at"] > b["since"]:
            who = f" ({profile})" if b.get("profile") else ""
            return f"the robot's session on {b['subject']}{who} was live at {v['at'][:16]}"
        # A site kept on per-profile sign-ins (Utilita's flats) never hands a task
        # back from the sign-in app, and nothing else checks those sessions, so
        # the sweep walks that profile's door itself (25 Sep 2026: such a wall
        # could otherwise never clear). The walk writes its own ledger line.
        if walk and b.get("profile"):
            door = profile_door(b["subject"], b["profile"], sites)
            w = walk(b["subject"], profile=b["profile"], url=door or None) if door else {}
            if w.get("signedIn"):
                return f"the robot's session on {b['subject']} ({b['profile']}) is live"
    if b["kind"] == "TOOL" and b.get("finding"):
        status = fstates.get(b["finding"], "")
        if status == "fixed":
            return f"the fix landed (finding {b['finding']})"
        if status == "rejected":
            return (f"the fixer found nothing broken (finding {b['finding']}); try again, "
                    "and if it fails the same way block it again with what you saw")
    return ""


# HIS TRY IS ASKED FOR ONCE (Kevin, 8 Oct 2026: "every time I add it or every time I try and sign in,
# it doesn't disappear. It just keeps asking"). Swinton's wall had three of his windows close on 7 and 8
# Oct, and each time the robot's next check still landed on the login page; Virgin Media's had one. A
# SIGN-IN or SITE wall his own try did not clear goes back to its agent with what happened, and the same
# wall is refused for KEVIN_TRIED_DAYS: asking him again cannot get the robot in. The agent uses another
# route, or brings him one KEVIN ONLY card with a Your turn plan, so he takes the step inside the robot's
# own window. A SITE wall counts only a window on its exact address: one on a parent or a different
# address (tiktok.com for www.tiktok.com) was the old blank "Add a new site", and the panel's button now
# carries the wall's address instead.
KEVIN_TRIED_DAYS = 7
KEVIN_TRIED_ROUTE = ("Asking Kevin again cannot get the robot in. Use another route; or, if only he can do it, "
                     "write a Your turn plan (GUARDRAILS \"Kevin's turn\") so he signs in inside the robot's own "
                     "window and takes the step there. If he has APPROVED this task, record that with `block "
                     "TASKID --kind KEVIN --subject credential` (the plan, or --steps): it comes back to him as a "
                     "Your step card and keeps his approval; a submit would wipe it. If he has not, submit the card "
                     "with the closing line KEVIN ONLY: credential: <the step>.")


def wall_hosts(host, entry, sites):
    """The addresses a wall on HOST can be signed in at: the host, its entry on the list, and the
    entry's sign-in page."""
    hosts = {host, entry}
    try:
        hosts.add((urllib.parse.urlparse((sites.get(entry) or {}).get("loginUrl") or "").hostname or "").lower())
    except ValueError:
        pass
    return {h for h in hosts if h}


def kevin_tried_reason(kind, host, sites, since, profile="default", events=None):
    """Why Kevin's own try on this SIGN-IN or SITE wall's site did not get the robot in, or ''."""
    if not host or not since:
        return ""
    entry = site_reachable(host, sites)
    events = signin_hold.load_events(BROWSER_LEDGER) if events is None else events
    if kind == "SIGN-IN":
        f = signin_hold.kevin_signin_failed(events, wall_hosts(host, entry, sites), since, profile)
        return (f"Kevin's sign-in window on {f[2]} closed at {f[0][:16]} and the robot's next check still "
                f"landed on the sign-in page ({f[1][:16]})") if f else ""
    if kind == "SITE" and not entry:
        a = signin_hold.kevin_login_after(events, {host}, since, profile)
        near = None if a else kevin_wall_answer_nearby(events, host, since, profile)
        if near:
            return (f"Kevin answered the wall on {near[2]} by signing in at {near[1]} (his window closed at "
                    f"{near[0][:16]}), and {host} is the same site: use {near[1]}")
        if a and a[1] != host:
            # He answered this wall on another address (AXA's quote site for axa.co.uk): that is the site.
            return (f"Kevin answered this wall by signing in at {a[1]} (his window closed at {a[0][:16]}), "
                    f"so the site for this job is {a[1]}, not {host}: use {a[1]}")
        return (f"Kevin's sign-in window on {host} closed at {a[0][:16]}, and {host} is still not a "
                "sign-in site on the robot's list") if a else ""
    return ""


def kevin_tried_wall_reason(b, sites, events, now=None):
    """kevin_tried_reason for wall B, with the sweep's reason line, or ''. Looks back from the wall's
    opening or KEVIN_TRIED_DAYS, whichever is earlier: the loop Kevin met re-opens the wall AFTER his
    try (the pickup reads signed out, the agent blocks again), so a try counted only after the wall's
    own opening is never seen. Shared by the sweep and signin-done, so the two never disagree."""
    look = kevin_tried_since(now)
    if b.get("since") and _utc(b["since"]) and _utc(b["since"]) < _utc(look):
        look = b["since"]
    tried = kevin_tried_reason(b["kind"], blocker_host(b["subject"]), sites, look,
                               b.get("profile") or "default", events)
    return f"{tried}. {KEVIN_TRIED_ROUTE}" if tried else ""


def wake_site_walls_answered(sites, events=None, now=None):
    """SITE walls Kevin's sign-in window has just answered, woken now (Kevin, 9 Oct 2026: "When I sign
    into a site, it just stays there"). On 9 Oct his AXA window closed at 10:58 UTC and the axa.co.uk
    wall stood until the 11:00 sweep; a sweep run that overruns the next tick (the 11:30 one was still
    going at 12:02) holds such a card an hour. The same judgement as the sweep (blocker_clear_reason,
    then his try), on the
    default profile only, never a session walk: signin-done runs while the app shows him a progress box."""
    recs = query_tasks(f"AND(NOT({{Status}}='Completed'), FIND('{BLOCKER_OPEN_MARK} (SITE', {{Notes}}))")
    events = signin_hold.load_events(BROWSER_LEDGER) if events is None else events
    woke = []
    for rec in recs:
        t = task_view(rec)
        b = task_blocker(t["notes"])
        if not b or b["kind"] != "SITE" or (b.get("profile") or "default") != "default":
            continue
        if has_step_mark((rec.get("fields") or {}).get(AF["approvalFeedback"]) or ""):
            # He has answered the card ("I can't do this"): the sweep sends it back, as it always has.
            continue
        reason = blocker_clear_reason(b, sites, {}) or kevin_tried_wall_reason(b, sites, events, now)
        if not reason:
            continue
        w = wake_blocked(t["id"], b, reason, by="Robot sign-in")
        if w:
            woke.append(w)
    return woke


def kevin_wall_answer_nearby(events, host, since, profile="default"):
    """(at, signed-in host, wall) of his newest window opened for a SITE wall on HOST with or without
    its leading "www." (axa.co.uk for www.axa.co.uk), or None. After "use landlordaxainsurance.com" for
    axa.co.uk, an agent could still raise one on www.axa.co.uk (review, 8 Oct 2026). Nothing wider: by
    registrable domain every *.service.gov.uk host is one site, and as parent and child an answer for
    gov.uk would cover every council and every GOV.UK service (two review rounds)."""
    since_at = _utc(since)
    best = None
    for e in events or []:
        if not isinstance(e, dict) or e.get("cmd") != "login" or (e.get("profile") or "default") != profile:
            continue
        wall = str(e.get("forWall") or "").lower()
        if not wall or wall == host or not (host == "www." + wall or wall == "www." + host):
            continue
        at = _utc(e.get("at"))
        if not at or (since_at and at <= since_at):
            continue
        if best is None or at > best[0]:
            best = (at, str(e.get("at")), str(e.get("host") or "").lower(), wall)
    return best[1:] if best else None


def kevin_tried_since(now=None):
    return ((now or datetime.now(timezone.utc)) - timedelta(days=KEVIN_TRIED_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")


def blocker_note(stamp, by, mark, b, tail):
    return f"[{stamp} — {by}] {mark} ({b['kind']} {b['subject']}): {tail}"


# ─── KEVIN'S STEP IS A CARD IN HIS LANE (Kevin, 7 Oct 2026) ───────────
#
# Measured 25 Sep to 7 Oct: 13 tasks sat on KEVIN walls (a purchase, a
# signature, a credential, an identity check, a payment) and none was in front
# of him. The card left his Approval lane the moment he approved it (Status
# back to Today), the 08:00 message carried a count with no names, and the
# Your turn button existed for 2 of the 13. Two insurance tasks sat from 1 Oct
# with no proof anything happened.
#
# So a KEVIN wall on a task he has approved puts the task back in his lane as
# "Your step": Status Approval with his verdict KEPT, a YOUR STEP block on top of
# the Agent Output (the original kept below a divider), and any knock-back date
# cleared, so every approval surface shows it. The page shows the step, the
# Your turn button when a plan exists, and a "Done, here is the proof" box, and
# NO approve or reject: it is already approved. The box writes his proof into
# Approval Feedback under KEVIN_DONE_MARK (the page cannot run this script); the
# half-hourly sweep reads it, clears the wall, takes the marker out and hands
# the task back to its agent, which checks the receipt and finishes the job.
YOUR_STEP_MARK = "YOUR STEP:"
YOUR_STEP_DIVIDER = "----- The agent's work, as you approved it -----"
# The page writes exactly this line (os/agents/index.html APV_STEP_DONE_MARK).
KEVIN_DONE_MARK = "KEVIN STEP DONE"
KEVIN_DONE_RE = re.compile(r"^KEVIN STEP DONE \[(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\]:[ \t]*(.*)$", re.M)
# "I can't do this" on the same card (Kevin, 8 Oct 2026): os/agents/index.html APV_STEP_CANT_MARK.
# His reason sends the task back to its agent as Changes requested (send_back_blocked).
KEVIN_CANT_MARK = "KEVIN STEP CANT"
KEVIN_CANT_RE = re.compile(r"^KEVIN STEP CANT \[(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\]:[ \t]*(.*)$", re.M)
# Numbered written steps: "1. ..." or "1) ..." somewhere in the text.
STEPS_NUMBERED_RE = re.compile(r"(?:^|\s)1[.)]\s+\S")
CREDENTIAL_SEARCH_REMINDER = (
    "REMINDER: a credential or identity wall is the last resort. Search for it first: the brain "
    "(grep -ril '<what>' ~/knowledge-os, and the Drive vault '00 AI Context' with its Home.md index) "
    "and Gmail (python3 scripts/inbound-triage.py search --q '<what>', and --account "
    "kevinbrittain@gmail.com). Log the search in the task Notes with annotate, then block only if "
    "it found nothing. Companies House personal codes, for one, are in Gmail.")


KEVIN_PLAN_REFUSAL = ("ERROR: a KEVIN wall needs a plan: write {plan} (a website step, GUARDRAILS \"Kevin's "
                      "turn\") or pass --steps \"1. ... 2. ...\" (a step with no website).")
KEVIN_ONLY_PLAN_REFUSAL = ("ERROR: refusing to submit {task}: its KEVIN ONLY step has no plan. Write {plan} (a "
                           "website step) or number the steps on the line itself: KEVIN ONLY: {reason}: 1. <first "
                           "thing he does> 2. <next>.")


def kevin_plan_missing(task_id, steps="", text=""):
    """True when a KEVIN step has none of: a Your turn plan file, --steps, or numbered steps in
    TEXT (the wall's own words, or the KEVIN ONLY step). Kevin must be told what to do, not that
    something exists (7 Oct 2026: 11 of 13 KEVIN walls named a step and no way to take it)."""
    return (not str(steps or "").strip() and not STEPS_NUMBERED_RE.search(str(text or ""))
            and handover_plan(task_id) is None)


def your_step_split(output):
    """(step, original) when Agent Output carries Kevin's YOUR STEP block, else (None, output)."""
    s = str(output or "")
    lead = s.lstrip()
    if not lead.startswith(YOUR_STEP_MARK) or YOUR_STEP_DIVIDER not in lead:
        return None, s
    head, rest = lead.split(YOUR_STEP_DIVIDER, 1)
    # Exactly the two newlines your_step_output writes, so the round trip gives back the
    # original byte for byte (review, 7 Oct 2026).
    return head[len(YOUR_STEP_MARK):].strip(), (rest[2:] if rest.startswith("\n\n") else rest.lstrip("\n"))


# Never inside a step: each would read as part of the approved card (tenancy-record.py review, 9 Oct 2026).
STEP_FORBIDDEN = (YOUR_STEP_DIVIDER, YOUR_STEP_MARK, "RECORD CHANGE:")


def your_step_output(step, output):
    """The Agent Output with STEP on top and the original below the divider. Idempotent: an
    output that already carries a block is re-wrapped, never wrapped twice. A step line carrying
    a mark that belongs to the approved card is dropped, so it can never become part of it."""
    step = "\n".join(ln for ln in str(step or "").splitlines() if not any(mk in ln for mk in STEP_FORBIDDEN))
    _, original = your_step_split(output)
    return f"{YOUR_STEP_MARK} {str(step or '').strip()}\n\n{YOUR_STEP_DIVIDER}\n\n{original}"


def handover_plan(task_id):
    """The task's Your turn plan as a dict, or None (no plan, a bad id, an unreadable file)."""
    if not TURN_TASK_RE.match(task_id or ""):
        return None
    try:
        with open(os.path.join(HANDOVER_DIR, task_id + ".json")) as fh:
            plan = json.load(fh)
    except (OSError, ValueError):
        return None
    return plan if isinstance(plan, dict) else None


# The sentence the page reads as "Your turn is ready" until the sweep has looked at the card
# (os/agents/index.html APV_TURN_READY_RE). Written only when the plan passes the window's own check.
YOUR_TURN_SENTENCE = ("Press Your turn on the AI Agents page, on your Mac: the robot fills in "
                      "everything up to your step and hands you the window.")


def kevin_step_text(task_id, b, steps="", check_plan=False):
    """What Kevin does, in words: the written steps, else the plan's own account of his step,
    else the wall's why (a KEVIN ONLY line's step). CHECK_PLAN (the paths that put the card in his
    queue): the Your turn sentence is written only when the plan passes agent-browser.js's own check,
    so the card's button can show at once, before the half-hourly sweep has looked (8 Oct 2026: the
    Swinton card arrived at 15:51 and its button waited for the 16:01 sweep)."""
    if str(steps or "").strip():
        return str(steps).strip()
    plan = handover_plan(task_id)
    if plan is not None:
        said = " ".join(str(plan.get("why") or plan.get("label") or b.get("why") or "").split())
        if check_plan and handover_plan_problem(task_id):
            return (f"{said} The robot's plan for your window is being fixed; the Your turn button "
                    "appears once it passes.").strip()
        return f"{said} {YOUR_TURN_SENTENCE}".strip()
    return str(b.get("why") or b.get("subject") or "").strip()


def in_your_step(t):
    """True when the task already sits in Kevin's lane as Your step."""
    return t.get("status") == "Approval" and your_step_split(t.get("agentOutput"))[0] is not None


def your_step_reapproved(t):
    """Why an approved task that has left Kevin's lane still waits on his own step, or ''.

    A VERDICT ON A YOUR STEP CARD IS NOT NEW WORK (Kevin, 7 Oct 2026). The page refuses one, but a
    tab opened before the Your step cards shipped showed them with an Approve button: ten cards
    were approved two to four times that day, every approval woke a hand-back run (16 carry-out
    slots) that met the same KEVIN wall, and the sweep put each card back 30 to 60 minutes later.
    The YOUR STEP block is written only once the agent's part is done and is taken off only when
    the wall clears (wake_blocked), so a task that carries it on an open KEVIN wall still waits on
    him, whatever its Status or Approved At say. A verdict that came with words he typed then
    ("paid, ref X") is new: its agent reads them, as it always did (review, 7 Oct 2026)."""
    if t.get("outcome") not in APPROVED or t.get("status") in ("Approval", "Completed") \
            or your_step_split(t.get("agentOutput"))[0] is None or t.get("noteWithVerdict"):
        return ""
    b = task_blocker(t.get("notes"))
    if not b or b["kind"] != "KEVIN":
        return ""
    return (f"waiting on Kevin's own step ({b['subject']}): approved already, so a second approval "
            "changes nothing; the sweep puts it back in his lane as Your step")


def your_step_fields(t, step):
    """The fields that put an APPROVED task back in Kevin's lane as Your step, or {} when it is
    not his to see that way (not approved, closed, or a decision card, whose DECIDE: line the
    board reads and a YOUR STEP block above it would hide)."""
    if t.get("outcome") not in APPROVED or t.get("status") == "Completed" \
            or is_decide_card(your_step_split(t.get("agentOutput"))[1]):
        return {}
    # The queue shows only a task with Sent For Approval By (APV_QUEUE_FORMULA). With no agent
    # to name, Status Approval would hide the task from the queue AND from dispatch: leave it.
    if not t.get("sentForApprovalByIds") and not t.get("teamMemberIds"):
        return {}
    fields = {AF["status"]: "Approval", AF["deferredUntil"]: None,
              AF["agentOutput"]: your_step_output(step, t.get("agentOutput"))}
    if not t.get("sentForApprovalByIds"):
        fields[AF["sentForApprovalBy"]] = t["teamMemberIds"][:1]
    return fields


def kevin_done_said(feedback, since=""):
    """(evidence, stamp) of Kevin's "Done, here is the proof" in Approval Feedback, or None.
    The newest marker counts, and only one written after the wall opened: a marker left from an
    earlier wall must never clear a new one. A wall with no `since` takes any marker."""
    return _kevin_step_said(KEVIN_DONE_RE, feedback, since)


def kevin_cant_said(feedback, since=""):
    """(reason, stamp) of Kevin's "I can't do this" in Approval Feedback, or None. Same rules as
    kevin_done_said: the newest line, written after the wall opened, with words."""
    return _kevin_step_said(KEVIN_CANT_RE, feedback, since)


def _kevin_step_said(regex, feedback, since):
    last = None
    for m in regex.finditer(str(feedback or "")):
        last = m
    if not last:
        return None
    evidence = " ".join(last.group(2).split())
    if not evidence:
        return None
    if since:
        said, opened = _utc(last.group(1)), _utc(since)
        # Read as times, never compared as text: "…00Z" sorts after "…00.000Z" (review).
        if said is None or opened is None or said < opened:
            return None
    return evidence, last.group(1)


# THE UNDO WINDOW (Kevin, 9 Oct 2026: "there needs to be an undo button on the page so we can go back
# and rectify it rather than submit incorrect information"). His 12:59 "the robot quit halfway" landed
# on 82 Devon Street 21 seconds after the Everywhen window closed. The page keeps Undo on a done or
# can't line for two minutes (APV_STEP_UNDO_MS); the sweep leaves the line alone until it is older than
# this, so an Undo can never lose a race with a send-back. A minute over the page's window, for drift
# between the clock of the Mac he answered on and this one.
STEP_SETTLE_SECONDS = 180


def step_line_settling(feedback, now=None):
    """True while Kevin's newest KEVIN STEP DONE or CANT line is younger than STEP_SETTLE_SECONDS.
    A stamp more than ten minutes ahead of this clock is not held: a wrong clock must never hold a
    card back for hours."""
    now = now or datetime.now(timezone.utc)
    newest = None
    for regex in (KEVIN_DONE_RE, KEVIN_CANT_RE):
        for m in regex.finditer(str(feedback or "")):
            at = _utc(m.group(1))
            if at and (newest is None or at > newest):
                newest = at
    if newest is None:
        return False
    age = (now - newest).total_seconds()
    return -600 < age < STEP_SETTLE_SECONDS


def has_step_mark(feedback):
    """True when Approval Feedback holds a KEVIN STEP DONE or KEVIN STEP CANT line."""
    raw = str(feedback or "")
    return KEVIN_DONE_MARK + " [" in raw or KEVIN_CANT_MARK + " [" in raw


def without_done_marks(feedback):
    """Approval Feedback with every KEVIN STEP DONE and KEVIN STEP CANT line taken out, or None
    when nothing is left."""
    kept = [ln for ln in str(feedback or "").split("\n")
            if not ln.startswith((KEVIN_DONE_MARK + " [", KEVIN_CANT_MARK + " ["))]
    out = "\n".join(kept).strip()
    return out or None


def wake_blocked(task_id, b, reason, by="agent-dispatch", done_stamp=""):
    """Clear the wall and hand the task back to its agent, keeping Kevin's
    verdict. The ledger's `unblocked` event ends the idle rest at once, so an
    approved carry-out is picked up by the next half-hourly poll; a task not
    yet approved goes back on today's list for the next dispatch slot. A task
    waiting in Kevin's lane as Your step leaves it: Status back to Today and the
    Agent Output back as he approved it. Clearing any wall also takes his
    KEVIN STEP DONE lines out of Approval Feedback, in the same write, so one
    "done" can never clear a later wall."""
    rec = get_task(task_id)
    t = task_view(rec)
    cur = task_blocker(t["notes"])
    if cur and not same_wall(cur, b):
        # A newer wall opened after the caller read the task (the sweep reads in bulk, then writes
        # minutes later). A CLEARED line now would clear THAT wall, which nothing has fixed: leave
        # it for the next sweep to judge on its own (review, 7 Oct 2026).
        return None
    if done_stamp:
        # Woken on his "done": it must still stand on this fresh read. He may have pressed Undo after
        # the sweep's bulk read, and a sweep can take minutes to reach his task (review, 9 Oct 2026).
        fresh = (rec.get("fields") or {}).get(AF["approvalFeedback"]) or ""
        said = kevin_done_said(fresh, b.get("since", ""))
        if not said or said[1] != done_stamp or step_line_settling(fresh):
            return None
    stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
    note = blocker_note(stamp, by, BLOCKER_CLEARED_MARK, b,
                        f"{reason}. Carry on from where you stopped and finish the job. "
                        "Do not close it until the job itself is done.")
    fields = {AF["notes"]: ((t["notes"] or "").rstrip() + "\n\n" + note).strip()[-90000:]}
    step, original = your_step_split(t["agentOutput"])
    if step is not None:
        fields[AF["agentOutput"]] = original
    if (t["outcome"] not in APPROVED and t["status"] not in ("Approval", "Completed")) \
            or (step is not None and t["status"] == "Approval"):
        fields[AF["status"]] = "Today"
        fields[AF["dueDate"]] = today_london()
        fields[AF["deferredUntil"]] = None
    raw_feedback = (rec.get("fields") or {}).get(AF["approvalFeedback"]) or ""
    if has_step_mark(raw_feedback):
        # Whatever cleared the wall: a done line left behind would be read by the next
        # carry-out as Kevin's edit note (review, 7 Oct 2026).
        fields[AF["approvalFeedback"]] = without_done_marks(raw_feedback)
    patch_task(task_id, fields)
    ledger_append(task_id, "unblocked")
    return {"task": task_id, "name": t["name"][:80], "kind": b["kind"],
            "subject": b["subject"], "reason": reason}


KEVIN_CANT_NOTE = "Kevin cannot take this step:"


def kevin_said_cant(notes, kind, subject, profile=""):
    """His reason, when he has said "I can't do this" to this very SIGN-IN or SITE wall on this task
    (same site, same flat), else ''. The agent may not raise it again (review, 8 Oct 2026): unapproved
    work carries no verdict to read, so the refusal is what keeps the card he turned down from coming
    straight back. Never a KEVIN wall: its subject is only a category (identity, payment), and his
    reason there can mean "later" (the UC47 card, 8 Oct 2026). Only a line written on THIS task counts:
    the dated line itself, never one quoted from another task's history (third review round)."""
    if kind not in ("SIGN-IN", "SITE"):
        return ""
    pat = re.compile(r"^\[[^\]\n]* — Kevin\] BLOCKER CLEARED \(" + re.escape(f"{kind} {subject}") + r"\): "
                     + re.escape(KEVIN_CANT_NOTE) + r" (.*?)\. Sent back to you[^\n]*$", re.I | re.M)
    tag = f"[profile {profile}]" if profile else "[profile "
    for m in reversed(list(pat.finditer(str(notes or "")))):
        if (tag in m.group(0)) == bool(profile):
            return m.group(1)
    return ""


def send_back_blocked(task_id, b):
    """"I CAN'T DO THIS" (Kevin, 8 Oct 2026). A Your step card had two exits, done or a
    knock-back, so a step he could not take (a portal that opens on a login he has no
    account for) waited on him for ever. His reason now sends the task back to its agent as
    Changes requested: the wall is cleared, the Agent Output goes back as he approved it, his
    reason becomes the feedback, and Status goes to Today, so the redo lane picks it up. The
    agent must find a way that does not need the step, or one he can take, and resubmit; the
    redo receipt makes it answer his reason. Earlier feedback is already in Feedback History
    (the page archives every note). Approved At is the stamp on his line.

    Decided on a FRESH read, never the sweep's bulk one: a done line he wrote since from another
    tab is newer and wins (review, 8 Oct 2026). The task's Your turn plan is retired (renamed, kept
    beside it) so a later wall cannot bring back the button for the step he said he cannot take.
    None, with nothing written, when the wall moved or his newest line is not a can't."""
    rec = get_task(task_id)
    t = task_view(rec)
    cur = task_blocker(t["notes"])
    if cur and not same_wall(cur, b):
        return None
    feedback = (rec.get("fields") or {}).get(AF["approvalFeedback"]) or ""
    cant = kevin_cant_said(feedback, b.get("since", ""))
    done = kevin_done_said(feedback, b.get("since", ""))
    if not cant or (done and (_utc(done[1]) or datetime.min.replace(tzinfo=timezone.utc))
                    >= (_utc(cant[1]) or datetime.min.replace(tzinfo=timezone.utc))):
        return None
    if step_line_settling(feedback):
        # Inside his Undo window on this fresh read: the next sweep takes it.
        return None
    # Never cut: the page's Feedback History line holds his whole reason, and a cut copy reads as new
    # words to cmd_submit's archive, which then stamps a second can't line on the resubmit's date.
    why, said_at = cant[0], cant[1]
    retired = ""
    plan = os.path.join(HANDOVER_DIR, task_id + ".json")
    # Only his own step's plan: a sign-in card's "I can't" says nothing about the plan for a later
    # payment step on the same task (review, 8 Oct 2026).
    if b["kind"] == "KEVIN" and TURN_TASK_RE.match(task_id or "") and os.path.isfile(plan):
        retired = plan + ".cant-" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
        try:
            os.replace(plan, retired)
        except OSError as e:
            print(f"WARNING: the Your turn plan for {task_id} could not be retired: {e}", file=sys.stderr)
            retired = ""
    stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
    note = blocker_note(stamp, "Kevin", BLOCKER_CLEARED_MARK, b,
                        f"{KEVIN_CANT_NOTE} {why.rstrip('.!? ')}. "
                        + ("Sent back to you as Changes requested. " if t["outcome"] in APPROVED else "Sent back to you. ")
                        + "This wall is not fixed: find a way that does not need this step from him, or a step "
                        "he can take, then submit for approval answering his reason. Do not raise the same wall "
                        "on this task again: block refuses it."
                        + (f" The old Your turn plan is retired to {retired}." if retired else "")
                        + (f" [profile {b['profile']}]" if b.get("profile") else ""))
    fields = {AF["notes"]: ((t["notes"] or "").rstrip() + "\n\n" + note).strip()[-90000:],
              AF["approvalFeedback"]: f"I can't do this step: {why}",
              AF["status"]: "Today", AF["dueDate"]: today_london(), AF["deferredUntil"]: None}
    if t["outcome"] in APPROVED:
        fields[AF["approvalOutcome"]] = "Changes requested"
        fields[AF["approvedAt"]] = said_at
    elif t["outcome"] == "Changes requested":
        # A redo that met a sign-in: his earlier points still stand beside this one.
        earlier = without_done_marks(feedback)
        fields[AF["approvalFeedback"]] = ((earlier + "\n") if earlier else "") + f"I can't do this step: {why}"
    # Unapproved work keeps no verdict: the agent never submitted it, so it is not marked down for it.
    step, original = your_step_split(t["agentOutput"])
    if step is not None:
        fields[AF["agentOutput"]] = original
    patch_task(task_id, fields)
    ledger_append(task_id, "unblocked")
    return {"task": task_id, "name": t["name"][:80], "kind": b["kind"],
            "subject": b["subject"], "reason": why[:400], "planRetired": bool(retired)}


def same_wall(a, b):
    """True when two blocker dicts are the same wall: kind, subject, profile and opening time."""
    return all((a or {}).get(k, "") == (b or {}).get(k, "") for k in ("kind", "subject", "profile", "since"))


def surface_your_step(task_id, b, t=None, steps=""):
    """Put an approved task with an open KEVIN wall in Kevin's lane as Your step. Returns what
    was written ({} when nothing was: not approved, closed, a decision card, already there, or the
    wall moved since B was read). T, when given, must be a fresh read: the write is built from it."""
    t = t or task_view(get_task(task_id))
    if in_your_step(t) or not same_wall(task_blocker(t["notes"]), b):
        return {}
    fields = your_step_fields(t, kevin_step_text(task_id, b, steps, check_plan=True))
    if fields:
        patch_task(task_id, fields)
    return fields


# ─── A ROBOT'S SIGN-IN IS A CARD (Kevin, 8 Oct 2026) ───────────────────
# "We seem to have bits everywhere: some sign-ins at the top, some sign-ins on cards, some cards
# that need sign-ins but don't have the buttons ... even if a task is blocked and it needs a
# sign-in, I think we add that as a task as well, rather than having them at the top. I can just
# work through the approval cards as standard." A SIGN-IN or SITE wall now puts its task in his
# queue as a card, the way a KEVIN wall does (Your step), whatever its verdict: the step block
# names the site, the page draws Sign in or + Add this site from it, and the Robot sign-ins panel
# keeps only the list of sites. The sign-in clears the wall through signin_done -> wake_blocked,
# which takes the step block off and sends the task back to Today with any verdict kept.
ROBOT_STEP_RE = re.compile(r"^ROBOT (SIGN-IN|SITE): ([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?: \(([A-Za-z0-9][A-Za-z0-9-]*)\))?\. ")
PLAIN_HOST_RE = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)+$")
# A robot card is made only from work in hand: what the dispatcher works (in_dispatch_window: Today,
# Overdue, or Upcoming due today) or a task marked To do / In progress. A task parked (Upcoming not
# yet due, a standing hold's park), on Some Day (blank) or Cancelled is not being worked, and a card
# would undo the park (two review rounds, 8 Oct 2026).
ROBOT_STEP_FROM = ("To do", "In Progress")      # the board's own spellings (review, 8 Oct 2026)


def robot_step_worked(t):
    return t.get("status") in ROBOT_STEP_FROM or in_dispatch_window(t.get("status"), t.get("dueDate"))


def robot_step_host(b):
    """The wall's host as plain ASCII (an internationalised name in its xn-- form), or '' when it
    is not a plain host name: the page reads the host off the card, so anything else would give a
    button that opens the wrong thing (review, 8 Oct 2026)."""
    host = blocker_host(b.get("subject")) or ""
    try:
        host = host.encode("idna").decode("ascii").lower()
    except UnicodeError:
        return ""
    return host if PLAIN_HOST_RE.match(host) else ""


def robot_step(t):
    """(kind, host, profile) of the robot sign-in step a task's card carries, or None."""
    step = your_step_split(t.get("agentOutput"))[0]
    m = ROBOT_STEP_RE.match(step or "")
    return (m.group(1).upper(), m.group(2).lower(), m.group(3) or "") if m else None


def robot_step_text(b, sites=None):
    """The step block for a SIGN-IN or SITE wall. Its first sentence is the machine-readable part
    (os/agents/index.html APV_ROBOT_STEP_RE): ROBOT SIGN-IN: <host> [(<profile>)]. / ROBOT SITE: <host>."""
    host = robot_step_host(b)
    if b["kind"] == "SITE":
        return (f"ROBOT SITE: {host}. A robot is blocked until {host} is on its list. Press + Add this "
                "site, sign in in the window that opens, then quit it (Cmd+Q): the robot picks the task "
                "up by itself. If you cannot (no account, no password), say why and press I can't do this.")
    entry = site_reachable(host, sites or {}) if sites else ""
    label = ((sites or {}).get(entry) or {}).get("label") or host
    prof = f" ({b['profile']})" if b.get("profile") else ""
    return (f"ROBOT SIGN-IN: {host}{prof}. A robot is blocked until it is signed in to {label}. Press Sign "
            "in, sign in yourself in the window that opens, then quit it (Cmd+Q): the robot picks the task "
            "up by itself. If you cannot (no account, no password), say why and press I can't do this.")


def robot_step_refusal(t, b):
    """Why a SIGN-IN or SITE wall on this task cannot become its card, or ''. `block` refuses the
    wall then, so every new one has a door (no wall without a door, 7 Oct 2026)."""
    if not robot_step_host(b):
        return f"{b['subject']!r} is not a plain host name, so no card could carry its button"
    if is_decide_card(your_step_split(t.get("agentOutput"))[1]):
        return "it is a decision card waiting on Kevin's answer"
    if t.get("status") == "Approval" and not in_your_step(t):
        return "it is a card waiting on Kevin's verdict; finish after his decision"
    if t.get("status") != "Approval" and not robot_step_worked(t):
        return f"it is {t.get('status') or 'on Some Day'}, so it is not being worked"
    if not t.get("sentForApprovalByIds") and not t.get("teamMemberIds"):
        return "no agent is named on it, so its card would have no owner"
    if t.get("approverEmail") and str(t["approverEmail"]).lower() != KEVIN_AIRTABLE_EMAIL:
        return "its approver is not Kevin, so the card would go to someone else's lane"
    return ""


def robot_step_fields(t, b, sites=None):
    """The fields that put a task blocked on a SIGN-IN or SITE wall in Kevin's queue as a card, or {}
    (it cannot be one: robot_step_refusal; or its card already names this wall). A card for an
    older wall (a second wall in the same run, or a Your step card that met a sign-in) is rewritten."""
    if robot_step_refusal(t, b):
        return {}
    want = (b["kind"], robot_step_host(b), b.get("profile") or "")
    if in_your_step(t) and robot_step(t) == want:
        return {}
    # A site the robot signs itself back in to (selfRefresh, Amazon) clears its own wall at the next
    # check: asking Kevin would be asking for nothing (review, 8 Oct 2026).
    if b["kind"] == "SIGN-IN" and ((sites or {}).get(site_reachable(want[1], sites or {})) or {}).get("selfRefresh"):
        # An older card for another wall would stand meanwhile, its button waking nothing: it leaves
        # the queue with the agent's work as it was (third review round).
        if in_your_step(t):
            return {AF["agentOutput"]: your_step_split(t.get("agentOutput"))[1], AF["status"]: "Today",
                    AF["dueDate"]: today_london(), AF["deferredUntil"]: None}
        return {}
    fields = {AF["status"]: "Approval", AF["deferredUntil"]: None,
              AF["agentOutput"]: your_step_output(robot_step_text(b, sites), t.get("agentOutput"))}
    if not t.get("sentForApprovalByIds"):
        fields[AF["sentForApprovalBy"]] = t["teamMemberIds"][:1]
    return fields


def robot_step_unwrap_fields(t):
    """A robot card whose wall is now something else (a TOOL wall met in the same run): the card
    leaves Kevin's queue with the agent's work as it was."""
    if robot_step(t) is None:
        return {}
    return {AF["agentOutput"]: your_step_split(t.get("agentOutput"))[1], AF["status"]: "Today",
            AF["dueDate"]: today_london(), AF["deferredUntil"]: None}


def surface_robot_step(task_id, b, t=None, sites=None):
    """Put a task with an open SIGN-IN or SITE wall in Kevin's queue as a card. Returns what was
    written ({} when nothing was). T, when given, must be a fresh read."""
    t = t or task_view(get_task(task_id))
    if not same_wall(task_blocker(t["notes"]), b):
        return {}
    fields = robot_step_fields(t, b, sites)
    if fields:
        patch_task(task_id, fields)
    return fields


def held_card_problem(fields):
    """Why an agent may not rewrite, re-escalate or hand over this task, or ''. A MERGE card is
    written by fixer-merge.py and carried out by merge-approved.py on Kevin's verdict: a submit
    that turned it into a DECIDE: or CLOSE PROPOSAL card under the same name would let his "yes"
    to that merge a protected PR (review, 7 Oct 2026). A Your step card is approved and waits on
    his own step: a submit would wipe his approval and a handover would mail the step to Roy."""
    fields = fields or {}
    if merge_card.is_merge_card(fields.get(AF["name"])):
        return ("it is a MERGE card: only fixer-merge.py writes it, and only merge-approved.py "
                "carries it out on Kevin's verdict")
    t = {"status": sel(fields.get(AF["status"])), "outcome": sel(fields.get(AF["approvalOutcome"])),
         "agentOutput": fields.get(AF["agentOutput"])}
    if t["outcome"] in APPROVED and in_your_step(t):
        return ("it is in Kevin's approval queue as Your step: approved, and waiting on his own step. "
                "It comes back to its agent when he says it is done")
    if in_your_step(t) and robot_step(t):
        return ("it is in Kevin's approval queue as a robot sign-in card: his sign-in hands it back to its "
                "agent by itself")
    return ""


def submit_wall_notes(notes, kevin_step, now=None):
    """The Notes a card submit should store for its walls, or None to leave
    them. A new submission is new work: the wall the old draft met is
    CLEARED as superseded (else complete refuses for ever and the 08:00 line
    keeps asking Kevin; review, 25 Sep 2026), and a declared KEVIN ONLY step
    opens its own KEVIN wall unless that exact wall is already open."""
    cur = task_blocker(notes)
    same = bool(kevin_step and cur and cur["kind"] == "KEVIN" and cur["subject"] == kevin_step["reason"])
    if same or (not cur and not kevin_step):
        return None
    stamp = (now or datetime.now(LONDON)).strftime("%d %b %Y %H:%M")
    out = str(notes or "").rstrip()
    if cur:
        out += "\n\n" + blocker_note(stamp, "agent-dispatch", BLOCKER_CLEARED_MARK, cur,
                                     "superseded: a new submission replaced the work that met this wall.")
    if kevin_step:
        kb = {"kind": "KEVIN", "subject": kevin_step["reason"], "why": kevin_step["step"], "finding": ""}
        out += "\n\n" + blocker_note(stamp, "agent-dispatch", BLOCKER_OPEN_MARK, kb,
                                     f"{kevin_step['step']} Fix: {blocker_fix_text(kb)} [since {now_iso()}]")
    return out.strip()[-90000:]


def cmd_block(args):
    kind = args.kind.upper()
    subject = " ".join(str(args.subject or "").split()).replace(")", "")
    why = " ".join(str(args.why or "").split())
    if not subject or not why:
        sys.exit("ERROR: --subject and --why are both required: what is blocked, and what you saw.")
    t = task_view(get_task(args.task))
    if merge_card.is_merge_card(t["name"]):
        sys.exit(f"ERROR: {args.task} is a MERGE card: only fixer-merge.py and merge-approved.py act on it, "
                 "and a wall on it would bury the card Kevin approves.")
    if t["status"] == "Completed":
        sys.exit(f"ERROR: {args.task} is Completed. A closed task cannot be blocked; if the job "
                 "was never done, say so in the run report so it is reopened.")
    sites = {}
    if kind in ("SIGN-IN", "SITE"):
        host = blocker_host(subject)
        if not host:
            sys.exit(f"ERROR: --subject for {kind} must be the site's address (a host or URL), "
                     f"not {subject!r}.")
        sites = load_login_sites()
        entry = site_reachable(host, sites)
        if kind == "SIGN-IN" and not entry:
            sys.exit(f"ERROR: {host} is not a site the robot can sign in to (not on its list, or "
                     "on it with no sign-in page). That is a SITE wall:\n"
                     f"         python3 scripts/agent-dispatch.py block {args.task} --kind SITE "
                     f"--subject {host} --why \"...\"")
        if kind == "SITE" and entry:
            sys.exit(f"ERROR: {host} IS on the robot's list with a sign-in page ({entry}). "
                     "If it is signed out, that is a SIGN-IN wall; check with "
                     f"`node scripts/agent-browser.js session --site {entry}` first.")
        subject = signin_door_host(entry, sites) if kind == "SIGN-IN" else (robot_step_host({"subject": host}) or host)
        # The address the wall is SAVED under, which is what the sweep checks (review, 8 Oct 2026):
        # oauth.virginmediao2.co.uk is saved as virginmedia.com, and checking the typed address let a
        # wall the sweep sends back be raised again every half hour.
        tried = kevin_tried_reason(kind, subject, sites, kevin_tried_since(),
                                   getattr(args, "profile", None) or "default")
        if tried:
            sys.exit(f"ERROR: refusing a {kind} wall on {subject}: {tried}. " + KEVIN_TRIED_ROUTE)
        names = [p.get("profile") for p in (sites.get(entry) or {}).get("profiles") or [] if isinstance(p, dict)]
        if kind == "SIGN-IN" and names and getattr(args, "profile", None) not in names:
            sys.exit(f"ERROR: {entry} keeps one sign-in per profile. Name which one: "
                     f"--profile {' | '.join(names)}")
        if getattr(args, "profile", None) and not (kind == "SIGN-IN" and names):
            sys.exit(f"ERROR: --profile is only for a SIGN-IN wall on a site with profiles; {host} has none.")
        # Every new SIGN-IN or SITE wall is a card in Kevin's queue (8 Oct 2026); one that could not be
        # is refused, never left with no door.
        no_card = robot_step_refusal(t, {"kind": kind, "subject": subject})
        if no_card:
            sys.exit(f"ERROR: refusing a {kind} wall on {args.task}: {no_card}.")
        if kind == "SIGN-IN":
            # A bot check is not a sign-out (25 Sep 2026: Cloudflare's "verify
            # you are human" was filed as SIGN-IN, Kevin's sign-in could not
            # clear it, and the task went round the loop again).
            prof = getattr(args, "profile", None) or "default"
            seen = ledger_bot_check([subject, entry, host], profile=prof)
            if seen:
                sys.exit(f"ERROR: {entry} showed the robot a bot check (\"verify you are human\", "
                         f"{seen['cmd']} at {seen['at']}). " + BOT_CHECK_ROUTE.replace("TASK", args.task))
    if kind == "KEVIN" and subject.lower() not in KEVIN_ONLY_REASONS:
        sys.exit(f"ERROR: a KEVIN wall is one of: {', '.join(KEVIN_ONLY_REASONS)}. "
                 f"{subject!r} is not: work that an agent could do stays the agent's, "
                 "and a wall the robot cannot pass is SIGN-IN, SITE or TOOL.")
    if kind == "KEVIN":
        subject = subject.lower()
    steps = "\n".join(" ".join(ln.split()) for ln in str(getattr(args, "steps", None) or "").splitlines()
                      if ln.strip())
    if steps and kind != "KEVIN":
        sys.exit("ERROR: --steps is only for a KEVIN wall: the written steps of a step only Kevin can take.")
    if steps and not STEPS_NUMBERED_RE.search(steps):
        sys.exit("ERROR: --steps must be numbered written steps (\"1. ... 2. ...\"), what Kevin does in order.")
    # Steps sit ON TOP of an approved card. A typed divider, YOUR STEP: or RECORD CHANGE: line in them would read as
    # part of what Kevin approved once the wall clears (tenancy-record.py review, 9 Oct 2026).
    if steps and any(mark in steps for mark in STEP_FORBIDDEN):
        sys.exit("ERROR: --steps may not carry the Your step divider, 'YOUR STEP:' or 'RECORD CHANGE:': write only "
                 "what Kevin does.")
    if kind == "KEVIN" and t["outcome"] not in APPROVED:
        # A KEVIN wall on work Kevin has not approved has no door (review, 7 Oct 2026): the task
        # rests until the wall clears, the page offers "Done" only on approved work, and nothing
        # else clears a KEVIN wall. His step reaches him as a card instead, which is also how
        # he approves the work before it.
        sys.exit(f"ERROR: {args.task} is not approved, so a KEVIN wall would leave it with no way "
                 "back. Finish everything before his step and submit the card with the closing line "
                 "KEVIN ONLY: <payment|purchase|signature|credential|identity|physical>: <the step>; "
                 "submit records the wall and his approval brings the step to his queue.")
    if kind == "KEVIN" and subject in ("credential", "identity"):
        print(CREDENTIAL_SEARCH_REMINDER, file=sys.stderr)
    said = kevin_said_cant(t["notes"], kind, subject, getattr(args, "profile", None) or "")
    if said:
        sys.exit(f"ERROR: refusing a {kind} wall on {subject}: Kevin said he cannot do this step on this task "
                 f"({said}). Find another way, or ask him a decision with escalate.")
    b = {"kind": kind, "subject": subject, "why": why, "finding": ""}
    current = task_blocker(t["notes"])
    if (current and current["kind"] == kind and current["subject"] == subject
            and current.get("profile", "") == (getattr(args, "profile", None) or "")):
        # Same wall, seen again: rest again, never a second line (the 46,000-
        # character Notes of 11 Sep came from exactly this repetition). A KEVIN
        # wall seen again on an approved task is the agent saying its part is done
        # and only his step is left: the card goes back to his lane (7 Oct 2026).
        # It needs its plan too, unless the wall already carries numbered steps.
        if kind == "KEVIN" and kevin_plan_missing(args.task, steps, current.get("why", "")):
            sys.exit(KEVIN_PLAN_REFUSAL.format(plan=os.path.join(HANDOVER_DIR, args.task + ".json")))
        surfaced = (surface_your_step(args.task, current, t, steps) if kind == "KEVIN"
                    else surface_robot_step(args.task, current, t, sites) if kind in ("SIGN-IN", "SITE") else {})
        ledger_append(args.task, "parked")
        print(json.dumps({"blocked": args.task, "already": True, **current,
                          **({"yourStep": True} if surfaced else {})}))
        return
    # A KEVIN WALL IS A CARD WITH A PLAN (Kevin, 7 Oct 2026). 11 of 13 KEVIN walls had
    # no Your turn plan and no written steps: Kevin was told a step existed, never what
    # it was. A new wall needs the plan file (a website step) or --steps (a step with no
    # website: a cheque, a signature on paper).
    if kind == "KEVIN" and kevin_plan_missing(args.task, steps):
        sys.exit(KEVIN_PLAN_REFUSAL.format(plan=os.path.join(HANDOVER_DIR, args.task + ".json")))
    if steps:
        # Kept in the wall's own line, so the sweep can show them when the card is approved later.
        why = f"{why} Steps: {' '.join(steps.split())}"[:900]
        b["why"] = why
    if kind == "TOOL" and args.finding:
        # A mistyped id would never clear, and the row would say it is being
        # fixed (review, 25 Sep 2026). It must be one findings.py knows.
        if not BLOCKER_FINDING_RE.match(f"[finding {args.finding}]") or args.finding not in finding_states():
            sys.exit(f"ERROR: --finding {args.finding!r} is not a finding in the queue "
                     "(python3 scripts/findings.py list). Leave it off and one is filed.")
    if kind == "TOOL":
        b["finding"] = args.finding or file_tool_finding(args.task, subject, why)
        if not b["finding"]:
            sys.exit("ERROR: could not file the TOOL finding (findings.py add failed). Nothing "
                     "was written; run it again, or pass --finding <id> if one exists.")
    stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
    if getattr(args, "profile", None):
        b["profile"] = args.profile
    tail = f"{why[:900 if kind == 'KEVIN' else 400]} Fix: {blocker_fix_text(b)} [since {now_iso()}]"
    if b.get("profile"):
        tail += f" [profile {b['profile']}]"
    if b["finding"]:
        tail += f" [finding {b['finding']}]"
    note = blocker_note(stamp, "agent", BLOCKER_OPEN_MARK, b, tail)
    fields = {AF["notes"]: ((t["notes"] or "").rstrip() + "\n\n" + note).strip()[-90000:]}
    # On a task Kevin has approved, the same write puts it back in his lane as Your step.
    surfaced = (your_step_fields(t, kevin_step_text(args.task, b, steps, check_plan=True)) if kind == "KEVIN"
                else robot_step_fields(t, b, sites) if kind in ("SIGN-IN", "SITE") else robot_step_unwrap_fields(t))
    patch_task(args.task, {**fields, **surfaced})
    ledger_append(args.task, "parked")
    back = task_blocker(task_view(get_task(args.task))["notes"])
    if not back or back["kind"] != kind:
        sys.exit(f"ERROR: wrote the blocker to {args.task} but it does not read back.")
    print(json.dumps({"blocked": args.task, **back, "fix": blocker_fix_text(back),
                      **({"yourStep": True} if surfaced else {})}))


def cmd_unblock(args):
    evidence = " ".join(str(args.evidence or "").split())
    if len(evidence) < 15:
        sys.exit("ERROR: --evidence must say what you SAW that proves the job can go on or is "
                 "done (the email, the record, the page), not that you believe it.")
    t = task_view(get_task(args.task))
    b = task_blocker(t["notes"]) or unrecorded_turn(t["notes"])
    if not b:
        sys.exit(f"ERROR: {args.task} has no open blocker.")
    woke = wake_blocked(args.task, b, f"evidence: {evidence[:400]}", by="agent")
    if not woke:
        sys.exit(f"ERROR: {args.task}'s wall changed while this ran. Read the task again and retry.")
    print(json.dumps({"unblocked": woke}))


# The words the rent check closes a form card's Your turn step with when the app never recorded whether
# Kevin sent the form (scripts/rent_new_tenant.py UNRECORDED). Kept identical there.
UNRECORDED_TURN = "the app never recorded whether Kevin sent the form"


def unrecorded_turn(notes):
    """The KEVIN step the rent check closed because his answer never arrived, or None. His late answer
    through the Robot sign-in app is still recorded against it: losing it could ask him to send the
    government form twice."""
    last = None
    for m in BLOCKER_LINE_RE.finditer(str(notes or "")):
        last = m
    if not last or last.group("mark") != BLOCKER_CLEARED_MARK or last.group("kind") != "KEVIN" \
            or UNRECORDED_TURN not in last.group("rest"):
        return None
    return {"kind": "KEVIN", "subject": last.group("subject").strip(), "why": "", "since": "", "finding": "", "profile": ""}


def kevin_step_owed(t, b, last):
    """True when an APPROVED task's KEVIN wall now waits on Kevin alone, so the sweep puts the
    card in his lane: the wall opened after his approval, or an agent has been on the task since
    (it parked on the wall, or carried out and kept it open), so its own part is done. A wall
    opened at submit on a card he has only just approved waits for the agent's carry-out first:
    the agent's `block` or `complete` then moves it itself."""
    if t.get("outcome") not in APPROVED or t.get("status") == "Completed" or in_your_step(t):
        return False
    if your_step_reapproved(t):
        return True    # approved again from an out-of-date tab: nothing new for the agent to do
    approved_at = str(t.get("approvedAt") or "")
    if b.get("since") and b["since"] > approved_at:
        return True
    event, ts = last or ("", "")
    return event in ("parked", "done") and bool(ts) and ts > approved_at


def finding_details():
    """finding id -> its full record (title, where, detail, pr), read through findings.py."""
    import findings as _findings  # noqa: E402 — scripts/ is on sys.path above
    return _findings.current_state()


def card_for_wall(b, detail, cards):
    """The MERGE card that carries this TOOL wall's fix, or None: a card listing the finding,
    or the card for the PR the finding is pending on. An open card wins over a closed one."""
    fid, pr = b.get("finding") or "", str((detail or {}).get("pr") or "")
    hits = [c for c in cards if (fid and fid in c.get("findings", [])) or (pr and str(c.get("pr")) == pr)]
    hits.sort(key=lambda c: (c.get("status") != "Completed", c.get("pr") or 0))
    return hits[-1] if hits else None


def tool_wall_state(b, status, detail, cards, days, findings_error="", cards_error=""):
    """(code, words) for a TOOL wall: who can clear it, in Kevin's words (7 Oct 2026). The row
    used to say "waiting on the daily robot fix" for 19 walls no fixer could reach."""
    card = card_for_wall(b, detail, cards)
    if card:
        pr = card["pr"]
        if card.get("status") == "Completed" and card.get("outcome") == "Rejected":
            return "merge-rejected", f"you rejected the merge card for PR #{pr}, so the PR is left open"
        if card.get("status") == "Completed":
            # Merged, yet this wall's finding did not land (a wall clears only when it does).
            return "merge-closed", (f"the merge card for PR #{pr} is closed but finding {b.get('finding') or '?'} "
                                    f"is still {status or 'not in the queue'}, so nothing will clear this wall")
        if card.get("outcome") in merge_card.APPROVED:
            return "merge-approved", f"you approved the merge card for PR #{pr}; the robot is merging it"
        return "merge-card", f"waiting on a merge card (PR #{pr})"
    if not b.get("finding"):
        return "no-finding", "no finding was filed, so nothing will clear this wall"
    if findings_error:
        return "unknown", "the findings queue could not be read: " + findings_error[:120]
    if not status:
        return "no-finding", f"finding {b['finding']} is not in the queue, so nothing will clear this wall"
    if status == "pending":
        return "pending", f"waiting on PR #{(detail or {}).get('pr') or '?'} to merge"
    if status == "claimed":
        return "claimed", "the fixer is working on it"
    if status == "deferred" or (status == "open" and (days is None or days >= BLOCKER_STALE_DAYS)):
        if cards_error:
            return "unknown", "the merge cards could not be read: " + cards_error[:120]
        d = detail or {}
        try:
            path = merge_card.protected_named(" ".join(str(d.get(k) or "") for k in ("title", "where", "detail", "fix"))
                                              + " " + str(b.get("why") or ""))
        except Exception as exc:  # noqa: BLE001 — the row says it could not tell, never guesses
            return "unknown", "the protected-file list could not be read: %s" % str(exc)[:80]
        if path:
            return "no-fixer", f"no fixer can reach it (protected file: {path})"
        if status == "deferred":
            # Deferred is final: the fixer closed it and never comes back (review, 7 Oct 2026).
            note = " ".join(str((detail or {}).get("close_note") or "").split())[:160]
            return "deferred", ("the fixer deferred it" + (f" ({note})" if note else "")
                                + ", so nothing will clear this wall")
        # No protected file named: an ordinary finding the fixer has not reached. Said as that,
        # never as "no fixer can reach it", which would be a guess (review, 7 Oct 2026).
        age = (f" in {int(days)} day{'' if int(days) == 1 else 's'}" if days is not None else "")
        return "unclaimed", f"no fixer has taken it{age}"
    return "fixer", "waiting on the daily robot fix"


def blockers_scan(sweep=False, now=None):
    """Every open wall, what clears it, and what went wrong. With sweep=True,
    walls whose cause is gone are cleared and their tasks woken."""
    now = now or datetime.now(timezone.utc)
    # When the board was read: a card written after this was not seen by this sweep (the page's
    # Your turn test compares against it, never the file's finish time; review, 8 Oct 2026).
    read_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    control = query_tasks("NOT({Status}='Completed')", max_records=1, minimal=True)
    recs = query_tasks(f"AND(NOT({{Status}}='Completed'), FIND('{BLOCKER_OPEN_MARK}', {{Notes}}))")
    closed = query_tasks(
        f"AND({{Status}}='Completed', FIND('{BLOCKER_OPEN_MARK}', {{Notes}}), "
        # Kevin's Reject closes a card by HIS decision; only a close nobody
        # decided is the loss this reports (review, 25 Sep 2026).
        "NOT({Approval Outcome}='Rejected'), "
        "IS_AFTER({Completion Date}, DATEADD(TODAY(), -14, 'days')))")
    sites, sites_error = {}, ""
    try:
        sites = load_login_sites()
    except Exception as exc:  # noqa: BLE001 — reported, never read as "no walls clear"
        sites_error = str(exc)[:200]
    fstates, findings_error = {}, ""
    try:
        fstates = finding_states()
    except Exception as exc:  # noqa: BLE001
        findings_error = str(exc)[:200]
    # Read only when a TOOL wall or a KEVIN wall needs them, and never fatal: a failed read is
    # said on the row ("could not read"), never read as "nothing there".
    lazy = {}

    def once(key, fn):
        if key not in lazy:
            try:
                lazy[key] = (fn(), "")
            except Exception as exc:  # noqa: BLE001 — carried into the JSON
                lazy[key] = (None, str(exc)[:200])
        return lazy[key]

    open_walls, woken, stale, surfaced, done_refused, plan_repairs, sent_back = [], [], [], [], [], [], []
    settling = []   # his done or can't lines still inside the page's Undo window
    for rec in recs:
        t = task_view(rec)
        b = task_blocker(t["notes"])
        if not b:
            continue
        reason = (blocker_clear_reason(b, sites, fstates, walk=session_walk if sweep else None)
                  if not (sites_error and b["kind"] == "SITE") else "")
        if not reason and b["kind"] in ("SIGN-IN", "SITE") and not sites_error:
            events, _ = once("events", lambda: signin_hold.load_events(BROWSER_LEDGER))
            if events is not None:
                reason = kevin_tried_wall_reason(b, sites, events, now)
        raw_feedback = (rec.get("fields") or {}).get(AF["approvalFeedback"]) or ""
        done = kevin_done_said(raw_feedback, b.get("since", "")) if b["kind"] == "KEVIN" else None
        cant = (kevin_cant_said(raw_feedback, b.get("since", ""))
                if b["kind"] in ("KEVIN", "SIGN-IN", "SITE") else None)
        if done and cant:
            # Two tabs can write both: the newer line is what he meant.
            if (_utc(cant[1]) or now) > (_utc(done[1]) or now):
                done = None
            else:
                cant = None
        # A line inside his Undo window is his to take back: nothing here acts on it, or wipes it, yet.
        settling_now = sweep and step_line_settling(raw_feedback)
        if settling_now:
            # Nothing acts on the task this sweep: a wake for another reason (his own sign-in window) would
            # take his can't line out, and before 9 Oct his can't won. The next sweep decides.
            settling.append({"task": t["id"], "name": t["name"][:80]})
            done = cant = None
            reason = ""
        if cant and sweep:
            sent = send_back_blocked(t["id"], b)
            if sent:
                sent_back.append(sent)
                continue
        if done and not reason:
            # Kevin's "Done, here is the proof" on the page (7 Oct 2026). The agent still checks
            # the receipt before it closes the task (GUARDRAILS "Kevin's turn").
            reason = f"Kevin says the step is done: {done[0][:400]}"
        if reason and sweep:
            woke = wake_blocked(t["id"], b, reason, by="Kevin" if done else "agent-dispatch",
                                done_stamp=done[1] if done and reason.startswith("Kevin says the step is done") else "")
            if woke:
                woken.append(woke)
                continue
        if sweep and not settling_now and not done and not cant and has_step_mark(raw_feedback):
            # A done or can't line the sweep cannot take (written before this wall opened, or
            # with no words) comes out, with a note, so the page offers the box again rather than
            # showing "you said it is done" for ever (review, 7 Oct 2026). Judged again on a
            # FRESH read: a line Kevin wrote since the bulk read is his, never wiped.
            frec = get_task(t["id"])
            ft = task_view(frec)
            fresh_feedback = (frec.get("fields") or {}).get(AF["approvalFeedback"]) or ""
            fb = task_blocker(ft["notes"])
            if same_wall(fb, b) and has_step_mark(fresh_feedback) \
                    and not kevin_done_said(fresh_feedback, b.get("since", "")) \
                    and not kevin_cant_said(fresh_feedback, b.get("since", "")):
                stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
                patch_task(t["id"], {
                    AF["approvalFeedback"]: without_done_marks(fresh_feedback),
                    AF["notes"]: ((ft["notes"] or "").rstrip() + "\n\n" + f"[{stamp} — agent-dispatch] "
                                  "Kevin's done line was not used: it was written before this wall opened, or "
                                  "it gave no proof. The Done box is back on his card.").strip()[-90000:]})
                done_refused.append({"task": t["id"], "name": t["name"][:80]})
        if sweep and b["kind"] in ("SIGN-IN", "SITE") and not reason and not (sites_error and b["kind"] == "SITE") \
                and not (in_your_step(t) and robot_step(t) == (b["kind"], robot_step_host(b), b.get("profile") or "")) \
                and not robot_step_refusal(t, b):
            # A wall from before 8 Oct 2026, or one recorded some other way, becomes its card here. A task
            # a standing hold covers stays parked (review, 8 Oct 2026).
            pair, _ = once("holds", load_standing_holds)
            holds, holds_error = pair if pair else ([], "not read")
            held = holds_error or standing_holds.hold_for(t, holds)
            wrote = {} if held else surface_robot_step(t["id"], b, sites=sites)
            if wrote:
                t = dict(t, status="Approval", agentOutput=wrote.get(AF["agentOutput"], t["agentOutput"]))
                surfaced.append({"task": t["id"], "name": t["name"][:80], "subject": b["subject"]})
        if sweep and b["kind"] == "KEVIN" and t["outcome"] in APPROVED and not in_your_step(t):
            ledger, _ = once("ledger", ledger_last_events)
            pair, _ = once("holds", load_standing_holds)
            holds, holds_error = pair if pair else ([], "not read")
            if holds_error:
                lazy["holds"] = (pair, holds_error)       # said in readErrors; nothing surfaced blind
            # A task a standing hold covers is parked by standing_holds.py; surfacing it would
            # undo the park every half hour (review, 7 Oct 2026).
            held = (not holds_error) and standing_holds.hold_for(t, holds)
            if not holds_error and not held and kevin_step_owed(t, b, (ledger or {}).get(t["id"])):
                # Written from a fresh read, never the bulk one (review, 7 Oct 2026).
                wrote = surface_your_step(t["id"], b)
                if wrote:
                    t = dict(t, status="Approval", agentOutput=wrote.get(AF["agentOutput"], t["agentOutput"]))
                    surfaced.append({"task": t["id"], "name": t["name"][:80], "subject": b["subject"]})
        try:
            since = datetime.fromisoformat(b["since"].replace("Z", "+00:00")) if b["since"] else None
        except ValueError:
            since = None
        days = round((now - since).total_seconds() / 86400, 1) if since else None
        row = {"task": t["id"], "name": t["name"][:90], "agent": t["agentName"],
               "kind": b["kind"],
               "subject": b["subject"] + (f" ({b['profile']})" if b.get("profile") else ""),
               "why": b["why"][:200],
               "fix": blocker_fix_text(b), "finding": b["finding"],
               "findingStatus": fstates.get(b["finding"], "") if b["finding"] else "",
               "days": days, "clearsNow": bool(reason)}
        if b["kind"] == "KEVIN":
            # What Kevin does, for the page and the 08:00 line (7 Oct 2026): the YOUR STEP block
            # once the card is in his lane, else the plan's or the wall's own words.
            shown = your_step_split(t["agentOutput"])[0]
            row["step"] = (shown if shown is not None else kevin_step_text(t["id"], b))[:600]
            row["yourStep"] = in_your_step(t)
            if done:
                row["doneSaid"] = done[0][:200]
            if cant:
                row["cantSaid"] = cant[0][:200]
        if handover_ready(t["id"], b, t.get("outcome"), t):
            problem = handover_plan_problem(t["id"])
            if problem:
                # No button that opens nothing: the step stays on his card as text, and the plan goes
                # back to its agent to repair (8 Oct 2026).
                row["planProblem"] = problem[:300]
                if sweep:
                    try:
                        repaired = plan_repair_task(t, problem, now)
                    except Exception as e:                       # noqa: BLE001 — one card, never the sweep
                        repaired = {"task": t["id"], "error": str(e)[:200]}
                        print(f"WARNING: {repaired['error']}", file=sys.stderr)
                    if repaired:
                        plan_repairs.append(repaired)
            else:
                row["turn"] = True
                row["fix"] = ("Kevin clicks Your turn on the AI Agents page (on his Mac): the robot fills "
                              "everything in and hands him the window for his step.")
        if b["kind"] == "TOOL":
            cards, cards_error = once("cards", lambda: merge_card.list_cards(read=query_tasks))
            details, details_error = once("details", finding_details)
            code, text = tool_wall_state(b, row["findingStatus"], (details or {}).get(b["finding"]) or {},
                                         cards or [], days,
                                         findings_error or details_error, cards_error)
            row["toolState"], row["tool"] = code, text
            card = card_for_wall(b, (details or {}).get(b["finding"]) or {}, cards or [])
            if card:
                row["mergeCard"] = {"pr": card["pr"], "task": card["id"], "status": card["status"],
                                    "outcome": card["outcome"]}
        open_walls.append(row)
        if days is None or days >= BLOCKER_STALE_DAYS:
            stale.append(row)
    closed_blocked = []
    for rec in closed:
        t = task_view(rec)
        b = task_blocker(t["notes"])
        if b:
            closed_blocked.append({"task": t["id"], "name": t["name"][:90], "kind": b["kind"],
                                   "subject": b["subject"], "why": b["why"][:200]})
    return {"readAt": read_at, "openTasksRead": len(control), "open": open_walls, "woken": woken,
            "stale": stale, "closedWhileBlocked": closed_blocked,
            "surfaced": surfaced, "doneRefused": done_refused, "planRepairs": plan_repairs,
            "sentBack": sent_back,
            "settling": settling,
            "sitesError": sites_error, "findingsError": findings_error,
            # The lazy reads that failed, by name (ledger, cards, details). Never fatal, never silent.
            "readErrors": {k: v[1] for k, v in lazy.items() if v[1]}}


def cmd_blockers(args):
    r = blockers_scan(sweep=args.sweep)
    print(json.dumps(r, indent=2))
    if not args.check:
        return 0
    problems = []
    # The control: a read that reaches no open task at all is blind, and a
    # blind read reports "no walls" for ever.
    if not r["openTasksRead"]:
        problems.append("CONTROL FAILED: the task read returned no open tasks at all")
    if r["sitesError"]:
        problems.append("the robot's site list could not be read: " + r["sitesError"])
    if r["findingsError"]:
        problems.append("the findings queue could not be read: " + r["findingsError"])
    for name, err in (r.get("readErrors") or {}).items():
        problems.append(f"the {name} read failed: {err}")
    for s in r["stale"]:
        problems.append(f"{s['task']} blocked {s['days']} days on {s['kind']} {s['subject']}: {s['fix']}")
    for c in r["closedWhileBlocked"]:
        problems.append(f"{c['task']} was CLOSED while blocked on {c['kind']} {c['subject']}")
    for p in problems:
        print("BLOCKER CHECK: " + p, file=sys.stderr)
    return 1 if problems else 0


# ─── VERIFY (the control run-job.sh wraps) ────────────────────────────

# The hand-back poll's runner drops this file in its run folder. A hand-back-only
# run is told to IGNORE new work, so the new items in its own queue are not work
# it owed. Written by the runner, never by the agent, so a run cannot excuse
# itself (27 Sep 2026).
HANDBACK_ONLY_MARK = "handback-only"
# A run told to WORK ONLY named tasks (roy-assistant, signin-pickup) writes them here, one per line, so verify owes
# exactly those and not the whole worklist it was handed (review, 27 Sep 2026). Written by the runner, never the agent.
OWED_IDS_MARK = "owed-ids"
# What the agent's self-check saw failed or parked. The control alarms on any of
# them missing from the final report: a failure is a result, never a draft error
# to delete (review, 27 Sep 2026).
SELFCHECK_FILE = "selfcheck.json"


def _utc(ts):
    try:
        t = datetime.fromisoformat(str(ts or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def owed_ids(queue, handback_only=False):
    """The worklist ids a run owed: all of them, or in a hand-back-only run all
    but plain new work (a sign-in reopened item is owed whatever its kind)."""
    return [w.get("id") for w in (queue.get("worklist") or [])
            if w.get("id") and (not handback_only or w.get("kind") != "new"
                                or w.get("signinReopened"))]


def silent_run_problem(report, queue=None, handback_only=False, rested=(), known_parked=(), owed=None, alerted_before=None):
    """The rule verify exists for, or '': work existed and the run did none.

    27 Sep 2026: seven "ZERO completed actions" alerts in one afternoon, every one
    a hand-back poll that rightly left new work for the slots (its worklist counts
    new work too) or tried a carry-out that met its wall. Counted from the
    queue.json the run was handed, never from what the run says it ignored.

    A task resting on its wall (`rested`), or parked, already alerted, listed
    again in this run's parkedFlags and still carrying an open wall in its live
    Notes (`known_parked`; the alert list is never pruned, so an id in it alone
    excuses nothing), is not owed, and neither ever counts as the run's work.
    A parked flag counts as work only when it is new (not in `alerted_before`): only
    a completed action, a failure that alarms, or a new parked flag on an owed
    task does, and an action on a task outside the worklist counts for nothing
    (review, 27 Sep 2026). A run that did some of its work and left the rest for
    the next tick is not silent: counting per task alarmed on 33 of 34 real runs.
    With no queue.json the old rule stands."""
    if isinstance(queue, dict) or owed is not None:
        actions = report.get("actions") or []
        parked = {p.get("id") for p in (report.get("parkedFlags") or [])}
        excused = set(rested) | (parked & set(known_parked))
        owed = [i for i in (owed if owed is not None else owed_ids(queue, handback_only)) if i not in excused]
        # a parked flag is the run's work only when it is NEW: re-listing one alerted before is not doing anything
        old = set(known_parked) if alerted_before is None else set(alerted_before)
        real = ({a.get("task") for a in actions if a.get("ok")}
                | {a.get("task") for a in actions if not a.get("ok") and a.get("task") not in excused}
                | (parked - excused - old))
        if owed and not (real & set(owed)):
            return (f"{len(owed)} eligible tasks and ZERO attempted: "
                    f"{', '.join(owed[:8])}")
        return ""
    counts = report.get("queueCounts") or {}
    try:
        eligible = int(counts.get("worklist", 0) or 0)
    except (TypeError, ValueError):
        eligible = 0
    if eligible > 0 and not any(a.get("ok") for a in (report.get("actions") or [])):
        return f"{eligible} eligible tasks and ZERO completed actions"
    return ""


def rested_on_wall(live, last_event, started_at, now=None):
    """True when a failed action met a wall the blocker loop already owns (the
    Estate "Robots blocked" row, the fix routed to its owner), so alarming again
    each time the task wakes to re-check it only trains Kevin to ignore the alarm
    channel (27 Sep 2026: the Meta dispute task). Both must hold (review, 27 Sep
    2026): the open BLOCKER was on record BEFORE this run started, so a wall met
    for the first time still alarms once; and the task rests on it NOW (parked
    within IDLE_HOURS), so a week-old wall never excuses today's unrelated
    failure."""
    b = task_blocker(live.get("notes"))
    if not b or not last_event or last_event[0] != "parked":
        return False
    since, parked, start = _utc(b.get("since")), _utc(last_event[1]), _utc(started_at)
    if not (since and parked and start):
        return False
    now = now or datetime.now(timezone.utc)
    return since < start and now - parked < timedelta(hours=IDLE_HOURS)


def cmd_verify(args):
    try:
        with open(args.report) as fh:
            report = json.load(fh)
    except Exception as e:
        print(f"ERROR: run report unreadable ({e}) — the run was blind",
              file=sys.stderr)
        sys.exit(1)
    # --dry-run is the agent's own self-check during a run: the same checks, no
    # alarm state written (only what it saw, for the control), and nothing wraps it, so a draft report that the agent then
    # corrects never reaches the alarm channel. The runner's wrapped call on the
    # final report is the one that counts (27 Sep 2026: five of twelve alerts were
    # drafts the agent fixed a minute later).
    dry_run = bool(getattr(args, "dry_run", False))
    rundir = os.path.dirname(os.path.abspath(args.report))
    handback_only = os.path.exists(os.path.join(rundir, HANDBACK_ONLY_MARK))
    queue = None
    try:
        with open(os.path.join(rundir, "queue.json")) as fh:
            queue = json.load(fh)
    except FileNotFoundError:
        queue = None      # the counts rule below stands in; a hand-back run may not lack it
    except Exception as e:                                # noqa: BLE001
        print(f"ERROR: the run's queue.json is unreadable ({e}) — its owed work "
              "cannot be counted", file=sys.stderr)
        sys.exit(1)
    if handback_only and queue is None:
        print("ERROR: hand-back run has no queue.json — its owed work cannot be "
              "counted", file=sys.stderr)
        sys.exit(1)

    problems = []
    counts = report.get("queueCounts", {})
    actions = report.get("actions", [])
    ok_actions = [a for a in actions if a.get("ok")]
    failed = [a for a in actions if not a.get("ok")]

    # A report with no real queue counts means the queue read itself died
    # (PAT missing, outage, renamed field). That must never verify green —
    # it is exactly the blind-run state this control exists to catch.
    if "worklist" not in counts or "openTasksRead" not in counts:
        problems.append("queueCounts is missing or empty — the queue read "
                        "failed and the run was blind")

    # When the run began, from the queue the script stamped, never the report's
    # startedAt: the agent writes that, and half of them carry London time with a
    # "Z" on the end, an hour late (review, 27 Sep 2026).
    started_at = (queue or {}).get("generatedAt") or report.get("startedAt")
    rested = []
    ledger = ledger_last_events() if failed else {}
    for a in failed:
        try:
            live = task_view(get_task(a.get("task")))
        except Exception:                                 # noqa: BLE001
            live = None       # unreadable: it cannot be excused, so it alarms below
        if live and rested_on_wall(live, ledger.get(a.get("task")), started_at):
            rested.append(a.get("task"))
            print(f"INFO: {a.get('task')} met its recorded wall again and rests "
                  f"on it — {str(a.get('error'))[:120]}", file=sys.stderr)
            continue
        problems.append(f"action failed: {a.get('kind')} {a.get('task')} — "
                        f"{str(a.get('error'))[:120]}")

    # The rule this control exists for: work existed and the run did none. Read
    # after the walls, because a task resting on one is not owed; and against the
    # parked tasks already alerted before this run, which are not owed either.
    try:
        with open(os.path.join(STATE_DIR, "tier1-alerted.json")) as fh:
            alerted_before = set(json.load(fh))
    except Exception:                                     # noqa: BLE001
        alerted_before = set()    # none known: every parked flag counts as new work
    # An old alert excuses a re-listed parked task only while its wall is still open
    # in the live Notes: once Kevin clears it (he paid), the task is owed again
    # (review, 27 Sep 2026). Every open parked task on 28 Sep carried a wall.
    # The wall must also predate the run, as rested_on_wall demands: a wall this run
    # put back on a task Kevin had just cleared is not an old alert (review, 28 Sep 2026).
    known_parked = set()
    run_start = _utc(started_at)
    for pid in {p.get("id") for p in (report.get("parkedFlags") or [])} & alerted_before:
        try:
            b = task_blocker(task_view(get_task(pid)).get("notes"))
        except Exception:                                 # noqa: BLE001
            b = None      # unreadable: not excused, so it is owed and alarms if untouched
        since = _utc(b.get("since")) if b else None
        if b and since and run_start and since < run_start:
            known_parked.add(pid)
    owed_override = None
    try:
        with open(os.path.join(rundir, OWED_IDS_MARK)) as fh:
            owed_override = [i for i in re.split(r"[\s,]+", fh.read()) if i]
    except FileNotFoundError:
        pass
    if owed_override == []:
        # the runners write it only with ids in hand; an empty one was emptied, never "owes nothing" (review, 28 Sep 2026)
        problems.append("owed-ids is empty — the run's owed tasks cannot be counted")
    silent = silent_run_problem(report, queue, handback_only, rested, known_parked, owed_override, alerted_before)
    if silent:
        problems.append(silent)

    # The self-check records what it saw failed or parked; the control alarms on
    # any of it missing from the final report. Deleting a failure is the one
    # "fix" a dry run could otherwise teach (review, 27 Sep 2026).
    seen_path = os.path.join(rundir, SELFCHECK_FILE)
    final_ids = ({a.get("task") for a in actions}
                 | {p.get("id") for p in (report.get("parkedFlags") or [])})
    try:
        with open(seen_path) as fh:
            seen = set(json.load(fh))
    except FileNotFoundError:
        seen = set()
    except Exception as e:                                # noqa: BLE001
        problems.append(f"self-check record unreadable ({e}) — cannot tell "
                        "whether a failure was removed from the report")
        seen = set()
    if dry_run:
        now_seen = seen | {a.get("task") for a in failed} | {
            p.get("id") for p in (report.get("parkedFlags") or [])}
        tmp = seen_path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(sorted(i for i in now_seen if i), fh)
        os.replace(tmp, seen_path)
    else:
        vanished = sorted(i for i in seen - final_ids if i)
        if vanished:
            problems.append(
                "removed from the report after the self-check saw them failed "
                f"or parked: {', '.join(vanished)} — a failure or a parked task "
                "is a result, never a draft error to delete")

    # A register roster the queue could not read must never stay a stderr
    # whisper: role agents silently stop receiving routed work and lessons.
    # The skill copies queue.json's roleAgentsError into the report; a
    # non-empty value fails the run so the alarm channel carries it.
    if report.get("roleAgentsError"):
        problems.append("role-agent register read failed: "
                        f"{str(report['roleAgentsError'])[:160]}")

    # THE LEARNING GATE (Kevin's ruling, 26 Aug 2026). Read from the LIVE
    # table, never from what the run claimed, and checked on every run whether
    # or not this run touched the task — a lesson Kevin asked for that nobody
    # stored is a broken promise regardless of who was meant to store it.
    #
    # This exists because the previous version of the rule was prose in a skill
    # file with nothing checking it, and produced zero stored lessons from 54
    # redos. Anything under the grace window is simply waiting for the next
    # 30-minute poll and is not a problem.
    try:
        late = overdue_lessons()
    except Exception as e:                            # noqa: BLE001
        problems.append(f"lesson check failed to run: {str(e)[:160]}")
        late = []
    for l in late:
        problems.append(
            f"lesson NOT stored: {l['task']} \"{str(l['name'])[:60]}\" — Kevin "
            f"ticked remember at {str(l['decidedAt'])[:16]} and the agent still "
            "cannot see it. Run: python3 scripts/agent-dispatch.py lessons")

    # The CEO review pass is mandatory for non-tier-1 prepared work (Kevin's
    # ruling, 24 Aug 2026). A run that submitted such work with no ceoReview
    # object either skipped the pass or hid its outcome — both are failures.
    # A reviewer that broke mid-run reports {"error": ...}, which passes here
    # (visible, not blocking Kevin's queue).
    non_t1_submits = [a for a in ok_actions
                      if a.get("kind") in ("redo", "new")
                      and not a.get("tier1")]
    ceo = report.get("ceoReview")
    try:  # the report is LLM-written; "3" must count as 3, junk as 0
        ceo_reviewed = int(ceo.get("reviewed", 0)) if isinstance(ceo, dict) \
            else 0
    except (TypeError, ValueError):
        ceo_reviewed = 0
    if non_t1_submits and not (isinstance(ceo, dict)
                               and (ceo_reviewed > 0
                                    or ceo.get("error"))):
        problems.append(
            f"{len(non_t1_submits)} non-tier-1 submissions but no CEO review "
            "recorded — the review pass was skipped or its outcome hidden")

    # Alerts are diverted, not dropped, so the run must SAY how many. A lane
    # that removes work from Kevin's queue and reports nothing is indis-
    # tinguishable from a lane that lost it.
    # Roy's lane is work that LEFT Kevin's queue. Counted for the same reason
    # the alert lane is: a lane that removes work and reports nothing cannot be
    # told apart from a lane that lost it.
    roy = report.get("royLane") or []
    alerts = report.get("systemAlerts") or []
    alert_summary = {}
    for a in alerts:
        src = a.get("alertSource", "?")
        alert_summary[src] = alert_summary.get(src, 0) + 1

    # A tier-1 task on an agent is no longer a fault — Kevin's call, 6 Aug 2026.
    # Agents prepare it and it reaches him through the same gate as everything
    # else. So the alarm here is not "an agent touched it", it is "an agent
    # touched it and he could not TELL". That check lives with the re-read
    # below, against the live Agent Output.
    #
    # A parked task still alarms: approved, but carrying it out would need a
    # payment, credential, signature or phone call, which nothing automates at
    # any trust level. It alarms ONCE per task, because a known flag
    # re-alarming twice a day would train him to ignore the alarm channel.
    state_path = os.path.join(STATE_DIR, "tier1-alerted.json")
    try:
        with open(state_path) as fh:
            alerted = set(json.load(fh))
    except Exception:
        alerted = set()
    flags = [("approved task PARKED — its carry-out needs a never-automated "
              "action", t) for t in report.get("parkedFlags", [])]
    # A tier-2 park means NOBODY works the task: the agent skips it and no
    # human is told. It sat in the report and nothing read the report. Alarm
    # once per task, the same way parkedFlags does, so a task parked by mistake
    # surfaces on the first run instead of never.
    flags += [("task PARKED as creditor correspondence — the Creditor "
               "Management agent is not dispatchable (register row not "
               "Built/Live, or the register read failed), so no agent will "
               "work it", t) for t in report.get("skippedTier2", [])]
    for label, t in flags:
        if t.get("id") not in alerted:
            problems.append(f"{label}: {t.get('id')} "
                            f"'{str(t.get('name'))[:60]}'")
    if flags and not dry_run:       # a self-check must not spend the once-per-task alarm
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(state_path, "w") as fh:
            json.dump(sorted(alerted | {t.get("id") for _, t in flags}), fh)

    # Trust nothing the run claimed: re-read each touched task and check the
    # state actually landed.
    creditor_submits = []
    compliance_closes = []
    for a in ok_actions:
        try:
            live = task_view(get_task(a["task"]))
        except Exception as e:
            problems.append(f"could not re-read {a.get('task')}: {e}")
            continue
        kind = a.get("kind")
        # Collected for the record-book gate below. The engine-raised cost
        # reviews are cost work with no creditor matter, so the name prefix
        # exempts them — everything else the creditor agent submits is a
        # matter with a page.
        if (kind in ("redo", "new")
                and CREDITOR_REC_ID in live["teamMemberIds"]
                and not str(live["name"]).startswith(REVIEW_TASK_PREFIX)):
            creditor_submits.append((a["task"], str(live["name"])[:60]))
        # Collected for the compliance-book gate below: a renewal the
        # Property Administration agent carried out and CLOSED must have
        # filed its certificate, or been handed to a person.
        if (kind == "carry_out" and not a.get("keepOpen")
                and PROPERTY_REC_ID in (live["teamMemberIds"]
                                        + live["sentForApprovalByIds"])
                and (ENGINE_RENEWAL_MARK in str(live["description"] or "")
                     or ENGINE_FILING_MARK in str(live["description"] or ""))
                # A filing task the agent closed by saying, on the record, what
                # the payment was really for is closed correctly.
                and not (ENGINE_FILING_MARK in str(live["description"] or "")
                         and certificate_watch.NO_CERTIFICATE_MARK in str(live["notes"] or ""))):
            compliance_closes.append((a["task"], str(live["name"])[:60]))
        if kind == "carry_out":
            # Two legitimate end states, and each is verified against the field
            # that actually proves it. A keep-open carry-out that checked Status
            # would alarm every time, and one that checked nothing would let a
            # claimed action through with no evidence at all.
            if a.get("keepOpen"):
                if CARRIED_OUT_MARK not in (live["notes"] or ""):
                    problems.append(
                        f"{a['task']} claimed carried out and kept open, but "
                        "its Notes carry no carry-out record — nothing proves "
                        "the action happened")
                elif live["status"] == "Completed":
                    problems.append(
                        f"{a['task']} was meant to stay open and is Completed")
            elif live["status"] != "Completed":
                problems.append(f"{a['task']} claimed carried out but Status "
                                f"is '{live['status']}', expected 'Completed'")
        elif kind in ("redo", "new"):
            # Normally still in Approval — but Kevin can decide within a
            # minute of the Slack post, which legitimately moves the task on.
            # The broken states are: still open with no outcome (the submit
            # never landed) or an empty Agent Output (nothing to judge).
            if in_dispatch_window(live["status"], live["dueDate"]) and not live["outcome"]:
                problems.append(f"{a['task']} claimed {kind} but the submit "
                                f"never landed (Status '{live['status']}', "
                                "no outcome)")
            if not live["agentOutput"]:
                problems.append(f"{a['task']} submitted with empty Agent Output")
            # The tier-1 control. Preparing this work is allowed; preparing it
            # UNLABELLED is not, because then it reads to Kevin like ordinary
            # admin. Checked against the live field, not against what the run
            # claimed it wrote.
            elif a.get("tier1") and TIER1_BANNER not in live["agentOutput"]:
                problems.append(
                    f"{a['task']} is tier 1 but its Agent Output carries no "
                    "tier-1 banner. It would read to Kevin as ordinary work.")
        elif kind == "route":
            to = a.get("to", "")
            if to and to not in live["teamMemberIds"]:
                problems.append(f"{a['task']} claimed routed to {to} but Team "
                                f"Member is {live['teamMemberIds']}")
        elif kind == "handover":
            # A handover verifies against the HUMAN it named, so handed-over
            # work reads green instead of alarming as an unfinished carry-out
            # (20260819-agent-dispatch-238).
            to = (a.get("to", "") or "").strip().lower()
            who = HUMANS.get(to)
            if not who:
                problems.append(f"{a['task']} claimed handover to '{to}', "
                                "which is not a team member")
            elif who["rec"] not in live["teamMemberIds"]:
                problems.append(f"{a['task']} claimed handed over to "
                                f"{who['name']} but Team Member is "
                                f"{live['teamMemberIds']}")
            elif live["status"] == "Completed":
                problems.append(f"{a['task']} was handed to {who['name']} but "
                                "marked Completed — the work is not done, it "
                                "changed hands")

    # THE RECORD-BOOK GATE (approved chain link 9, Kevin's revamp, 1 Sep
    # 2026). Read from the LIVE table, never from what the run claimed. This
    # exists because the previous version of the rule was prose in the agent
    # file with no write path and nothing checking it, and produced 29 of 30
    # pages stuck at "Awaiting response" with zero outcomes recorded — the
    # same lesson as the learning gate above. A book the engine cannot reach
    # fails the run too: a creditor draft written blind is exactly what the
    # read-back step exists to prevent.
    if creditor_submits:
        try:
            plans = fetch_plans()
            by_task = {tid: p for p in plans for tid in p["taskIds"]}
            for tid, name in creditor_submits:
                page = by_task.get(tid)
                if page is None:
                    problems.append(
                        f"creditor task {tid} '{name}' submitted with NO "
                        "record-book update — every matter updates its "
                        "Creditor Plans page (python3 scripts/"
                        f"agent-dispatch.py ledger {tid} --creditor ... "
                        "--status ... --next-step ...)")
                elif not (page["nextStep"] or "").strip():
                    problems.append(
                        f"creditor task {tid} '{name}' record-book page "
                        f"({page['id']}) has an empty Next Step — every "
                        "outcome states where the matter goes next")
        except Exception as e:                            # noqa: BLE001
            problems.append(
                "record book unreachable while creditor work was submitted "
                f"— the run drafted blind and cannot verify: {str(e)[:160]}")

    # THE COMPLIANCE-BOOK GATE (approved chain link 5, 2 Sep 2026). A
    # COMPLIANCE renewal task the agent closed must show a certificate row
    # linked to it — the filed document with its renewal date — read from the
    # LIVE table. Without this the agent could report "renewed" and the book
    # would still say expired, which is the silent failure the whole agent
    # exists to end.
    if report.get("complianceBookError"):
        problems.append("compliance book read failed: "
                        f"{str(report['complianceBookError'])[:160]}")
    if compliance_closes:
        try:
            # A linked row with no document is a claim, not a certificate.
            linked = {tid for c in fetch_certificates(refresh=True)
                      if c["hasFile"] for tid in c["taskIds"]}
            for tid, name in compliance_closes:
                if tid not in linked:
                    problems.append(
                        f"compliance task {tid} '{name}' was closed with NO "
                        "certificate (with its document) linked — a renewal "
                        "ends with python3 scripts/agent-dispatch.py "
                        f"certificate {tid} --property ... --type ... "
                        "--renewal ... --file ..., or stays open "
                        "(complete --keep-open) while a person holds the "
                        "next step")
        except Exception as e:                            # noqa: BLE001
            problems.append(
                "compliance book unreachable while a renewal was closed — "
                f"cannot verify the certificate was filed: {str(e)[:160]}")

    if problems:
        for p in problems:
            print(f"ERROR: {p}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps({"ok": True,
                      "actionsVerified": len(ok_actions),
                      # Diverted, not dropped. A lane that takes work out of
                      # Kevin's queue and reports nothing cannot be told apart
                      # from a lane that lost it.
                      "systemAlertsHeldBack": len(alerts),
                      "handedToRoy": len(roy),
                      "systemAlertsBySource": alert_summary,
                      "worklistAtStart": counts.get("worklist", 0),
                      # Failed on a wall already on record: listed, never hidden.
                      "restedOnWall": rested,
                      "dryRun": dry_run}))


# ─── ENTRY ────────────────────────────────────────────────────────────

# ─── SCORE — the Inbound Comms Response agent's goal metric ───────────
#
# "All inbound answered within 24 hours", measured from TASK CREATION to
# Completed (Kevin's ruling, 24 Aug 2026: the triage agent's own metric covers
# message-arrival → task, so this one measures only what the Response agent
# controls). Runs at the end of every dispatch run and PATCHes the register
# row's Metric Score, gated on change so quiet days add no Airtable traffic.

RESPONSE_SCORE_STATE = os.path.join(STATE_DIR, "response-score.json")


def _parse_at(ts):
    """ISO timestamp (Zulu or naive) → AWARE datetime, or a date-only marker.

    Returns (datetime|None, is_date_only). Completion Date is written as full
    Zulu ISO by every known writer, but a naive-with-time string (a future
    writer stamping local ISO) must not crash the score maths — it is treated
    as UTC, never returned naive. Bare dates can only be judged to day
    precision, never hour."""
    if not ts or not isinstance(ts, str):
        return None, False
    try:
        if len(ts) == 10:
            return datetime.strptime(ts, "%Y-%m-%d").replace(
                tzinfo=timezone.utc), True
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt, False
    except ValueError:
        return None, False


def response_score_reading(records, now_utc):
    """Pure maths for the 24h reading — no I/O, seeded by selftest.

    Judgeable = completed, or open for more than 24h (a task created two
    hours ago and still open is not yet a success or a failure). A completed
    task with no parseable completion stamp counts as answered but NOT within
    24h, and is reported in `unstamped` so the miss is attributable."""
    window_start = now_utc - timedelta(days=7)
    within = answered = open_now = open_past24 = unstamped = 0
    judgeable = 0
    for rec in records:
        created, _ = _parse_at(rec.get("createdTime", ""))
        if created is None:
            continue
        f = rec.get("fields", {})
        status = sel(f.get(AF["status"]))
        if status == "Cancelled":
            # A cancelled task is one nobody wants answered (spam, junk,
            # withdrawn). Neither an answer nor a miss — the query already
            # excludes these; this guard keeps the maths honest if it stops.
            continue
        if status == "Completed":
            if created < window_start:
                continue  # window stats measure the last 7 days only
            answered += 1
            judgeable += 1
            done_at, date_only = _parse_at(f.get(AF["completion"], ""))
            if done_at is None:
                unstamped += 1
            elif date_only:
                if (done_at.date() - created.date()).days <= 1:
                    within += 1
            elif done_at - created <= timedelta(hours=24):
                within += 1
        else:
            open_now += 1  # every open inbound task counts, however old
            if now_utc - created > timedelta(hours=24):
                open_past24 += 1
                if created >= window_start:
                    judgeable += 1
    stats = {"within24": within, "answered": answered, "open": open_now,
             "openPast24": open_past24, "judgeable": judgeable,
             "unstamped": unstamped}
    if judgeable == 0 and open_now == 0:
        return "no inbound in the last 7 days; 0 open", stats
    pct = round(100 * within / judgeable) if judgeable else 100
    reading = (f"{pct}% within 24h ({within}/{judgeable}, 7 days); "
               f"{open_now} open, {open_past24} past 24h")
    return reading, stats


def cmd_score(args):
    if args.selftest:
        for selftest in SCORE_SELFTESTS:
            selftest()
        return
    # Each agent's step runs and reports independently: a broken creditor
    # read must not stop the response score being written, and vice versa. A
    # failure still exits non-zero at the end, so the job alarm sees it.
    failures = []
    for label, fn in SCORE_STEPS:
        try:
            fn()
        except SystemExit as exc:
            failures.append(f"{label}: {exc}")
        except Exception as exc:  # noqa: BLE001 — surfaced, never swallowed
            failures.append(f"{label}: {exc}")
    if failures:
        sys.exit("ERROR: score failed — " + "; ".join(failures))


def response_score():
    records = query_tasks(
        "AND({Inbound Communication Task}, {Status}!='Cancelled', "
        "OR(IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -7, 'days')), "
        "{Status}!='Completed'))")

    # Control ON ZERO: an empty main read is ambiguous — a genuinely quiet
    # week and a typo'd field name look identical. The all-time population is
    # known non-empty (hundreds of rows since Aug 2026), so only when the main
    # query returns nothing do we spend the extra round-trip to tell the two
    # apart, and a broken read fails loudly rather than publishing a score.
    if not records and not query_tasks("{Inbound Communication Task}",
                                       max_records=1, minimal=True):
        sys.exit("ERROR: control failed — zero inbound tasks exist all-time. "
                 "The read is broken, not the queue empty. No score written.")
    reading, stats = response_score_reading(
        records, datetime.now(timezone.utc))

    write_register_reading("response", RESPONSE_REGISTER_ROW,
                           RESPONSE_SCORE_STATE, reading, stats)


def load_score_state(state_path):
    try:
        with open(state_path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(state_path, obj):
    """The write half of load_score_state: one shape for every state file."""
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    with open(state_path, "w") as fh:
        json.dump(obj, fh)


def raise_engine_task(name, team_rec_id, estimate, desc, due=None,
                      priority="High"):
    """The ONE shape of an engine-raised task: Today, due today, Kevin the
    approver, High. Five call sites used to carry their own copy of this
    payload (review finding, 2 Sep 2026)."""
    return _request("POST", f"/{TASKS}", {"typecast": True, "fields": {
        REVIEW_TASK_FIELDS["name"]: name,
        REVIEW_TASK_FIELDS["status"]: "Today",
        REVIEW_TASK_FIELDS["due"]: due or today_london(),
        REVIEW_TASK_FIELDS["team"]: [team_rec_id],
        REVIEW_TASK_FIELDS["approver"]: {"id": KEVIN_APPROVER_USR},
        REVIEW_TASK_FIELDS["priority"]: priority,
        REVIEW_TASK_FIELDS["estimate"]: estimate,
        REVIEW_TASK_FIELDS["desc"]: desc,
    }})


# Display names for the daily-log key, per score label. The log row is what
# the AI Agents page's "Daily logs" check reads: without it an agent's runs
# are invisible and the page can only report a wiring gap (found 26 Aug 2026
# — four Built/Live agents had never logged once).
SCORE_AGENT_NAMES = {"response": "Inbox Response",
                     "creditor": "Supplier and Creditor Manager",
                     "property": "Property Administration"}


def write_register_reading(label, register_row, state_path, reading, stats,
                           state_extra=None):
    """The one change-gated register write every role agent's score uses.
    Fifteen agents are seeded in the register; each build session adds a
    reading function, never another copy of this write."""
    # Daily log first, and BEFORE the change gate: the row proves the agent
    # RAN today even when its reading has not moved. A failed log write must
    # not cost the score write — the page's silence alarm is the backstop
    # for a broken log, so warn and carry on.
    try:
        import agent_daily_log
        agent_daily_log.publish(
            register_row, SCORE_AGENT_NAMES.get(label, label),
            reading, "\n".join(f"{k}: {v}" for k, v in sorted(stats.items())))
    except Exception as exc:  # noqa: BLE001 — surfaced, never swallowed
        print(f"WARNING: daily log publish failed for {label}: {exc}",
              file=sys.stderr)

    prev = load_score_state(state_path).get("reading", "")
    if reading == prev:
        print(json.dumps({"agent": label, "reading": reading,
                          "written": False, "reason": "unchanged", **stats}))
        return
    _request("PATCH", f"/{AGENTS_TABLE}/{register_row}",
             {"fields": {REGISTER_METRIC_SCORE: reading}})
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    with open(state_path, "w") as fh:
        json.dump({"reading": reading, "writtenAt": now_iso(),
                   **(state_extra or {})}, fh)
    print(json.dumps({"agent": label, "reading": reading,
                      "written": True, **stats}))


def response_score_selftest():
    now = datetime(2026, 8, 25, 12, 0, tzinfo=timezone.utc)

    def rec(created, status, completion=None):
        fields = {AF["status"]: {"name": status}}
        if completion is not None:
            fields[AF["completion"]] = completion
        return {"createdTime": created, "fields": fields}

    reading, s = response_score_reading([
        rec("2026-08-24T09:00:00.000Z", "Completed",
            "2026-08-24T12:00:00.000Z"),   # 3h → within
        rec("2026-08-22T09:00:00.000Z", "Completed",
            "2026-08-23T20:00:00.000Z"),   # 35h → answered, not within
        rec("2026-08-23T09:00:00.000Z", "Completed", "2026-08-23"),
        # date-only same day → within
        rec("2026-08-20T09:00:00.000Z", "Completed", "2026-08-23"),
        # date-only +3 days → not within
        rec("2026-08-21T09:00:00.000Z", "Completed"),  # unstamped → miss
        rec("2026-08-25T10:30:00.000Z", "Today"),      # 1.5h open → not judged
        rec("2026-08-23T09:00:00.000Z", "Overdue"),    # 51h open → past-24 miss
        rec("2026-08-10T09:00:00.000Z", "Completed",
            "2026-08-10T10:00:00.000Z"),   # outside window → ignored
        rec("2026-08-01T09:00:00.000Z", "Approval"),   # old + open → counted open
    ], now)
    expect = {"within24": 2, "answered": 5, "open": 3, "openPast24": 2,
              "judgeable": 6, "unstamped": 1}
    assert s == expect, f"selftest stats mismatch: {s} != {expect}"
    assert reading == "33% within 24h (2/6, 7 days); 3 open, 2 past 24h", reading

    reading2, s2 = response_score_reading([], now)
    assert reading2 == "no inbound in the last 7 days; 0 open", reading2
    assert s2["judgeable"] == 0 and s2["open"] == 0

    # A still-open task inside 24h must not create a false 100%-with-zero read
    reading3, _ = response_score_reading(
        [rec("2026-08-25T11:00:00.000Z", "Today")], now)
    assert reading3 == "100% within 24h (0/0, 7 days); 1 open, 0 past 24h", \
        reading3

    # Cancelled = nobody wants it answered: neither an answer nor a miss,
    # however old (review finding, 24 Aug 2026 — junk inbound must not drag
    # the score down for ever).
    _, s4 = response_score_reading(
        [rec("2026-08-20T09:00:00.000Z", "Cancelled")], now)
    assert s4 == {"within24": 0, "answered": 0, "open": 0, "openPast24": 0,
                  "judgeable": 0, "unstamped": 0}, s4

    # A naive-with-time completion stamp must be treated as UTC, never crash
    # the run with an aware-vs-naive TypeError (review finding, 24 Aug 2026).
    _, s5 = response_score_reading(
        [rec("2026-08-24T09:00:00.000Z", "Completed", "2026-08-24T11:00:00")],
        now)
    assert s5["within24"] == 1 and s5["answered"] == 1, s5
    print("selftest-score: all checks passed")


CREDITOR_SCORE_STATE = os.path.join(STATE_DIR, "creditor-score.json")


def creditor_coverage(records):
    """Metric one (Kevin's definition, 25 Aug 2026): every creditor inbound
    is answered or has a prepared response. Prepared INCLUDES everything
    sitting in Kevin's approval queue — a bottleneck at approval is his lane,
    and must never read as the agent falling behind."""
    population = prepared = with_kevin = 0
    for t in records:
        f = t.get("fields", {})
        linked = set(links(f.get(AF["teamMember"]))) | set(
            links(f.get(AF["sentForApprovalBy"])))
        if CREDITOR_REC_ID not in linked:
            continue
        status = sel(f.get(AF["status"]))
        if status == "Cancelled":
            continue
        population += 1
        if f.get(AF["sentForApprovalBy"]) or status in ("Approval",
                                                        "Completed"):
            prepared += 1
        if status == "Approval":
            with_kevin += 1
    if not population:
        frag = "creditor inbound: none in the last 7 days"
    else:
        frag = f"creditor inbound: {prepared}/{population} prepared"
        if with_kevin:
            frag += f", {with_kevin} with Kevin"
    return frag, {"creditorTasks": population, "prepared": prepared,
                  "withKevin": with_kevin}


def fixed_costs_reading(cost_records, prev, today_label):
    """Metric two (Kevin's definition, 25 Aug 2026): the month's fixed-cost
    total and its movement since the reading last changed. Active rule
    mirrors isCostActive in js/shared.js exactly (see COSTS_TABLE comment)."""
    total, active = 0.0, 0
    for r in cost_records:
        f = r.get("fields", {})
        if f.get(COST_FIELDS["inactive"]):
            continue
        if sel(f.get(COST_FIELDS["payStatus"])) not in ("In Payment",
                                                        "Overdue"):
            continue
        active += 1
        total += float(f.get(COST_FIELDS["expected"]) or 0)
    total = round(total, 2)
    prev_total = prev.get("monthly")
    changed_at = prev.get("monthlyChangedAt") or today_label
    if prev_total is None:
        move = "(first reading)"
    elif total > prev_total:
        move = f"(up £{total - prev_total:,.2f} since {changed_at})"
        changed_at = today_label
    elif total < prev_total:
        move = f"(down £{prev_total - total:,.2f} since {changed_at})"
        changed_at = today_label
    else:
        move = f"(steady since {changed_at})"
    return (f"fixed costs £{total:,.2f}/mo {move}",
            {"activeCosts": active, "monthlyFixedCosts": total},
            {"monthly": total, "monthlyChangedAt": changed_at})


def creditor_score():
    # The wide read (non-cancelled tasks, open or created in the window) is a
    # known non-empty population, so an empty result is a broken read — the
    # creditor SUBSET being empty is fine (the agent is new).
    tasks = query_tasks(
        "AND({Status}!='Cancelled', "
        "OR(IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -7, 'days')), "
        "{Status}!='Completed'))")
    if not tasks:
        sys.exit("ERROR: control failed — the open/recent task read returned "
                 "zero rows. The read is broken, not the queue empty. No "
                 "creditor score written.")
    cov_frag, cov_stats = creditor_coverage(tasks)
    costs = query_records(COSTS_TABLE, fields=list(COST_FIELDS.values()))
    prev = load_score_state(CREDITOR_SCORE_STATE)
    today_label = datetime.now(LONDON).strftime("%-d %b")
    cost_frag, cost_stats, extra = fixed_costs_reading(costs, prev,
                                                       today_label)
    if not cost_stats["activeCosts"]:
        sys.exit("ERROR: control failed — zero ACTIVE costs read from the "
                 "Costs table (90 existed on 25 Aug 2026). The read or the "
                 "active rule is broken. No creditor score written.")
    # Metric three (revamp, 1 Sep 2026): the record-book postures. The
    # dispatch skill promised this reading since 25 Aug; the code now keeps
    # the promise.
    plans = fetch_plans()
    if not plans:
        sys.exit("ERROR: control failed — zero pages read from the Creditor "
                 "Plans record book (30 existed on 1 Sep 2026). The read is "
                 "broken, not the book empty. No creditor score written.")
    ledger_frag, ledger_stats = ledger_postures(plans)
    write_register_reading("creditor", CREDITOR_REGISTER_ROW,
                           CREDITOR_SCORE_STATE,
                           cov_frag + "; " + cost_frag + "; " + ledger_frag,
                           {**cov_stats, **cost_stats, **ledger_stats}, extra)


CREDITOR_REVIEW_STATE = os.path.join(STATE_DIR, "creditor-review.json")
REVIEW_TASK_NAME = "Fixed cost review: find savings (weekly)"
REVIEW_TASK_FIELDS = {   # write-side ids, matching the triage create spec
    "name":     "fldgFjGBw6bTKJFCD",
    "status":   "fldx4qCw17UfrKpaN",
    "due":      "fld7XP8w8kbxfETV4",
    "team":     "flduCtmQGpOA4eWaj",
    "approver": "fldLLAG5HQPEFEfE5",
    "priority": "fldS21RwmwOqt71LI",
    "estimate": "fld10VzzbiNNgRmIi",
    "desc":     "fldRGhBQViKZKtkQ6",
}
KEVIN_APPROVER_USR = "usrKkopUJSGsBhWMD"


def ensure_weekly_review():
    """The Creditor Management agent's weekly fixed-cost review task, raised
    by the engine every Monday (Kevin's ruling, 25 Aug 2026).

    Raised HERE, in code, London time — never via the Airtable Recurring
    field: nothing deployed in Airtable flips a future-dated Upcoming task
    into the Today/Overdue window ("When Due Date is updated, adjust the
    Status" exists but is undeployed; since 15 Sep 2026 QUEUE_FORMULA and
    the slot runner's flip-due cover that gap in code), and an API
    completion would not roll the cadence forward. The engine runs several times daily, so the
    Monday 07:00 run creates it and the 09:00 slot works it."""
    now = datetime.now(LONDON)
    if now.weekday() != 0:      # Monday only, decided in code, London time
        return
    week = now.strftime("%G-W%V")
    state = load_score_state(CREDITOR_REVIEW_STATE)
    if state.get("week") == week:
        return
    # Belt for a lost state file: an existing open/recent copy means a task
    # was already raised. A BROKEN read here would return zero and mint a
    # duplicate, so this is the belt only — the state file above is the
    # authoritative guard, and a duplicate is a visible task, not silent
    # corruption.
    existing = query_tasks(
        "AND({Task Name}='" + REVIEW_TASK_NAME + "', "
        "IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -6, 'days')))",
        max_records=1, minimal=True)
    if not existing:
        raise_engine_task(
            REVIEW_TASK_NAME, CREDITOR_REC_ID, "30 min",
            due=now.strftime("%Y-%m-%d"),
            desc=(
                "Weekly fixed-cost review (raised automatically each Monday "
                "by agent-dispatch). Follow the ordered review steps in the "
                "Creditor Management agent's register row: read active "
                "costs, flag rises above 10% or £10/mo, duplicates, and "
                "costs with no matching transaction in 90 days; every "
                "saving of £5/mo or more becomes its own recommendation "
                "with the monthly saving quantified. Prepare-only — no "
                "record changes without Kevin's approval."))
    save_state(CREDITOR_REVIEW_STATE, {"week": week, "raisedAt": now_iso(),
                                       "existing": bool(existing)})
    print(json.dumps({"agent": "creditor", "weeklyReview": week,
                      "created": not existing}))


# ─── THE CREDITOR RECORD BOOK (revamp, Kevin-approved chain, 1 Sep 2026) ──
#
# One page per creditor matter in the Creditor Plans table. The approved
# chain's three enforced links live here: link 2 (the queue hands the book to
# the drafting agent so history is READ before a word is written), link 9
# (every creditor submit updates its page — verify fails the run otherwise),
# link 10 (a daily date check raises chase tasks, only where the agent judged
# something is owed BACK to us and wrote a date; a freeze request never gets
# a date, so this check can never chase one). Before 1 Sep 2026 the book was
# written-only in prose with no write path in this file: 29 of 30 pages sat
# at "Awaiting response" with zero outcomes recorded.

CREDITOR_PLANS = "tbljyVlkq1BXzny2G"
PLAN_FIELDS = {
    "creditor":    "fldRmcVPa2OxHP0Ed",
    "status":      "fldoNpdLRrT2gBFxQ",
    "amount":      "fldn7xH0KuleraGVA",
    "entity":      "fldfizzBcgQyK6EBm",
    "lane":        "fld6Lu7KpXZTCnGaV",
    "agreed":      "fldOd2BbJC5z2xv6s",
    "lastContact": "fldayQPedcPHFVVQO",
    "notes":       "fldkLJxtPOpSYHuCT",
    "tasks":       "fldZHxI4Pim6AbO8l",
    "nextStep":    "fldKlaHlN00o9mogx",
    "nextDate":    "fldrkrv4MNIyJEymH",
}
PLAN_STATUSES = ("Awaiting response", "Frozen", "Plan agreed", "Disputed",
                 "Escalated to Kevin", "Closed - dissolved business",
                 "Settled")
PLAN_LANES = ("Debt correspondence", "Live utility", "Contractor", "Other")
PLAN_CLOSED_STATUSES = ("Settled", "Closed - dissolved business")
# Both engine-raised review tasks are COST work, not creditor matters, so the
# record-book gate skips them by this prefix (weekly and monthly names share it
# on purpose — a rename that breaks the prefix re-arms the gate loudly, the
# safe failure direction).
REVIEW_TASK_PREFIX = "Fixed cost"


def plan_view(rec):
    f = rec.get("fields", {})
    return {
        "id": rec.get("id"),
        "createdTime": rec.get("createdTime", ""),
        "creditor": f.get(PLAN_FIELDS["creditor"], ""),
        "status": sel(f.get(PLAN_FIELDS["status"])),
        "monthlyAmount": f.get(PLAN_FIELDS["amount"]),
        "entity": f.get(PLAN_FIELDS["entity"], ""),
        "lane": sel(f.get(PLAN_FIELDS["lane"])),
        "lastContact": f.get(PLAN_FIELDS["lastContact"], ""),
        "nextStep": f.get(PLAN_FIELDS["nextStep"], ""),
        "nextStepDate": f.get(PLAN_FIELDS["nextDate"], ""),
        "taskIds": links(f.get(PLAN_FIELDS["tasks"])),
        "notes": f.get(PLAN_FIELDS["notes"], ""),
    }


def fetch_plans():
    return [plan_view(r) for r in query_records(CREDITOR_PLANS)]


def plan_digest(p):
    """The compact page the queue JSON carries: enough for the drafting agent
    to see where the matter stands and what has already been said, without
    hauling the full notes history into every run."""
    tail = [l for l in (p["notes"] or "").splitlines() if l.strip()][-3:]
    return {**{k: p[k] for k in ("id", "creditor", "status", "monthlyAmount",
                                 "lastContact", "nextStep", "nextStepDate")},
            "recentNotes": tail}


def find_plan(plans, task_id, creditor):
    """Which page is this matter's page. A page already linked to the task
    wins outright; otherwise exact case-insensitive creditor name. Oldest
    page wins when twins exist, so a duplicate created by mistake can never
    hijack the original's history — and the caller warns about the twins."""
    linked = [p for p in plans if task_id and task_id in p["taskIds"]]
    if linked:
        return sorted(linked, key=lambda p: p["createdTime"])[0], []
    name = (creditor or "").strip().lower()
    named = sorted([p for p in plans
                    if (p["creditor"] or "").strip().lower() == name],
                   key=lambda p: p["createdTime"])
    if not named:
        return None, []
    return named[0], named[1:]


def ledger_postures(plans):
    """Register metric three (Kevin's definition, 1 Sep 2026): how many
    matters are frozen, how many are on agreed plans and what those plans
    commit per month, and how many still await a response. A blank Monthly
    Amount on an agreed plan counts £0 — never skipped (the blank-field
    lesson in CLAUDE.md)."""
    frozen = sum(1 for p in plans if p["status"] == "Frozen")
    on_plan = [p for p in plans if p["status"] == "Plan agreed"]
    committed = round(sum(float(p["monthlyAmount"] or 0) for p in on_plan), 2)
    awaiting = sum(1 for p in plans if p["status"] == "Awaiting response")
    frag = (f"ledger: {frozen} frozen, {len(on_plan)} on plans "
            f"£{committed:,.2f}/mo, {awaiting} awaiting")
    return frag, {"frozen": frozen, "onPlans": len(on_plan),
                  "plansMonthly": committed, "awaiting": awaiting}


def chase_due(plans, today):
    """Pure: which pages are owed a chase today. Only pages where the agent
    judged something is owed BACK to us and wrote a Next Step Date qualify —
    ISO strings compare lexicographically, so <= is a real date comparison."""
    return [p for p in plans
            if p["nextStepDate"] and p["nextStepDate"] <= today
            and (p["nextStep"] or "").strip()
            and p["status"] not in PLAN_CLOSED_STATUSES]


def is_first_monday(now):
    return now.weekday() == 0 and now.day <= 7


def cmd_ledger(args):
    """The ONE write path to the record book. Finds the matter's page (task
    link first, then name; oldest twin wins), creates it when none exists,
    stamps Last Contact, links the task, and appends the dated note. verify
    fails any creditor submit whose task never passed through here."""
    if args.next_date and args.next_date != "none":
        try:
            datetime.strptime(args.next_date, "%Y-%m-%d")
        except ValueError:
            sys.exit("ERROR: --next-date must be YYYY-MM-DD (or 'none' to "
                     "clear it)")
    plans = fetch_plans()
    row, twins = find_plan(plans, args.task, args.creditor)
    for t in twins:
        print(f"WARNING: duplicate page for '{args.creditor}' ({t['id']}) — "
              f"updating the oldest ({row['id']}); fold the twin by hand",
              file=sys.stderr)

    next_step = args.next_step if args.next_step is not None else \
        (row["nextStep"] if row else "")
    if args.next_date and args.next_date != "none" and not next_step.strip():
        sys.exit("ERROR: --next-date without a Next Step is an alarm with no "
                 "message — say what the chase is for")

    fields = {PLAN_FIELDS["lastContact"]: today_london()}
    if args.status:
        fields[PLAN_FIELDS["status"]] = args.status
    if args.next_step is not None:
        fields[PLAN_FIELDS["nextStep"]] = args.next_step
    if args.next_date == "none":
        fields[PLAN_FIELDS["nextDate"]] = None
    elif args.next_date:
        fields[PLAN_FIELDS["nextDate"]] = args.next_date
    if args.amount is not None:
        fields[PLAN_FIELDS["amount"]] = float(args.amount)
    if args.entity:
        fields[PLAN_FIELDS["entity"]] = args.entity
    if args.lane:
        fields[PLAN_FIELDS["lane"]] = args.lane
    if args.note:
        prior = row["notes"] if row else ""
        line = f"{today_london()}: {args.note}"
        fields[PLAN_FIELDS["notes"]] = (prior + "\n" + line) if prior else line

    if row:
        fields[PLAN_FIELDS["tasks"]] = sorted(set(row["taskIds"])
                                              | {args.task})
        result = _request("PATCH", f"/{CREDITOR_PLANS}/{row['id']}",
                          {"fields": fields, "typecast": True})
    else:
        fields[PLAN_FIELDS["creditor"]] = args.creditor.strip()
        fields[PLAN_FIELDS["tasks"]] = [args.task]
        fields.setdefault(PLAN_FIELDS["status"], "Awaiting response")
        result = _request("POST", f"/{CREDITOR_PLANS}",
                          {"fields": fields, "typecast": True})
    # Echo from a LIVE re-read, never from the write response: POST/PATCH
    # responses key fields by NAME while plan_view reads by field id, so the
    # response echoed blanks (caught by the build session's live write test,
    # 1 Sep 2026) — and an echo of what actually landed beats an echo of what
    # was sent anyway.
    live = plan_view(_request(
        "GET", f"/{CREDITOR_PLANS}/{result['id']}?returnFieldsByFieldId=true"))
    print(json.dumps({"row": live["id"], "created": row is None,
                      "creditor": live["creditor"], "status": live["status"],
                      "nextStep": live["nextStep"],
                      "nextStepDate": live["nextStepDate"]}))


MONTHLY_REVIEW_STATE = os.path.join(STATE_DIR, "creditor-deepdive.json")
MONTHLY_REVIEW_NAME = ("Fixed cost deep dive: subscriptions and plans "
                       "(monthly)")


def ensure_monthly_review():
    """The monthly deep cost dive (Kevin's cadence call, 1 Sep 2026): first
    Monday of the month, decided IN CODE in London time — never a cron
    day-of-week field and never the Airtable Recurring field, for the same
    reasons as ensure_weekly_review above."""
    now = datetime.now(LONDON)
    if not is_first_monday(now):
        return
    month = now.strftime("%Y-%m")
    state = load_score_state(MONTHLY_REVIEW_STATE)
    if state.get("month") == month:
        return
    # Belt for a lost state file, same shape as the weekly review's.
    existing = query_tasks(
        "AND({Task Name}='" + MONTHLY_REVIEW_NAME + "', "
        "IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -20, 'days')))",
        max_records=1, minimal=True)
    if not existing:
        raise_engine_task(
            MONTHLY_REVIEW_NAME, CREDITOR_REC_ID, "1 hour",
            due=now.strftime("%Y-%m-%d"),
            desc=(
                "Monthly deep cost dive (raised automatically on the first "
                "Monday by agent-dispatch). Go beyond the weekly quick "
                "check: for EVERY active cost, question whether it is still "
                "used (recent Transactions are the evidence), whether the "
                "plan level fits, and whether a cheaper tier or a "
                "cancellation exists — research the supplier where needed. "
                "Rank candidates by monthly saving; every saving of £5/mo "
                "or more becomes its own recommendation with the £/month "
                "quantified. Never recommend cutting insurance, compliance "
                "or maintenance-capability cover — flag those as Kevin's "
                "judgement call with the trade-off stated. Prepare-only — "
                "no record changes without Kevin's approval."))
    save_state(MONTHLY_REVIEW_STATE, {"month": month, "raisedAt": now_iso(),
                                      "existing": bool(existing)})
    print(json.dumps({"agent": "creditor", "monthlyReview": month,
                      "created": not existing}))


CHASE_STATE = os.path.join(STATE_DIR, "creditor-chase.json")


def ensure_chase_tasks():
    """Link 10 of the approved chain: the daily date check. Raises one chase
    task per due page per Next Step Date — the state file makes a date fire
    once, and the recent-task belt holds if the state file is lost. The
    judgment about WHETHER to chase already happened at write time (only a
    matter owed something back to us carries a date), so this stays a pure
    if/then."""
    plans = fetch_plans()
    due = chase_due(plans, today_london())
    if not due:
        return
    state = load_score_state(CHASE_STATE)
    # One name-only read outside the loop; creditor names can carry quotes,
    # so the belt compares in Python rather than interpolating a formula.
    recent = {t.get("fields", {}).get(AF["name"], "")
              for t in query_tasks(
                  "IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -14, 'days'))",
                  minimal=True)}
    created = []
    for p in due:
        if state.get(p["id"]) == p["nextStepDate"]:
            continue
        name = f"Chase: {p['creditor']} - {p['nextStep']}"[:100]
        if name not in recent:
            raise_engine_task(
                name, CREDITOR_REC_ID, "20 min",
                "CREDITOR MATTER — chase raised automatically from the "
                f"creditor record book. The next step for "
                f"{p['creditor']} was due {p['nextStepDate']}: "
                f"{p['nextStep']}. Read the record-book page before "
                "drafting, and update it after (agent-dispatch.py "
                "ledger).")
            created.append({"creditor": p["creditor"],
                            "dueDate": p["nextStepDate"]})
        state[p["id"]] = p["nextStepDate"]
    save_state(CHASE_STATE, state)
    print(json.dumps({"agent": "creditor", "chasesDue": len(due),
                      "chasesCreated": created}))


def creditor_score_selftest():
    def task(status, team=None, sent=None):
        fields = {AF["status"]: {"name": status}}
        if team:
            fields[AF["teamMember"]] = list(team)
        if sent:
            fields[AF["sentForApprovalBy"]] = list(sent)
        return {"fields": fields}

    CRED = CREDITOR_REC_ID
    frag, s = creditor_coverage([
        task("Approval", team=[CRED]),              # prepared, with Kevin
        task("Today", team=[CRED]),                 # unprepared, open
        task("Completed", sent=[CRED]),             # prepared and answered
        task("Today", team=[CRED], sent=[CRED]),    # submitted redo → prepared
        task("Today", team=["recSomeoneElse123"]),  # not the creditor agent's
        task("Cancelled", team=[CRED]),             # nobody wants it → out
    ])
    assert s == {"creditorTasks": 4, "prepared": 3, "withKevin": 1}, s
    assert frag == "creditor inbound: 3/4 prepared, 1 with Kevin", frag

    frag2, s2 = creditor_coverage([task("Today", team=["recX"])])
    assert frag2 == "creditor inbound: none in the last 7 days", frag2
    assert s2 == {"creditorTasks": 0, "prepared": 0, "withKevin": 0}, s2

    def cost(expected=None, inactive=False, status="In Payment"):
        f = {COST_FIELDS["payStatus"]: {"name": status}}
        if inactive:
            f[COST_FIELDS["inactive"]] = True
        if expected is not None:
            f[COST_FIELDS["expected"]] = expected
        return {"fields": f}

    frag3, s3, extra3 = fixed_costs_reading([
        cost(100.50), cost(50, status="Overdue"),
        cost(999, inactive=True),        # inactive box → excluded
        cost(999, status="Paused"),      # not In Payment/Overdue → excluded
        cost(),                          # blank Expected → £0, still counted
    ], {}, "25 Aug")
    assert s3 == {"activeCosts": 3, "monthlyFixedCosts": 150.5}, s3
    assert frag3 == "fixed costs £150.50/mo (first reading)", frag3
    assert extra3 == {"monthly": 150.5, "monthlyChangedAt": "25 Aug"}, extra3

    frag4, _, extra4 = fixed_costs_reading(
        [cost(140.50)], {"monthly": 150.5, "monthlyChangedAt": "18 Aug"},
        "25 Aug")
    assert frag4 == "fixed costs £140.50/mo (down £10.00 since 18 Aug)", frag4
    assert extra4["monthlyChangedAt"] == "25 Aug", extra4

    frag5, _, extra5 = fixed_costs_reading(
        [cost(140.50)], {"monthly": 140.5, "monthlyChangedAt": "20 Aug"},
        "25 Aug")
    assert frag5 == "fixed costs £140.50/mo (steady since 20 Aug)", frag5
    assert extra5["monthlyChangedAt"] == "20 Aug", extra5
    print("selftest-creditor-score: all checks passed")


def creditor_ledger_selftest():
    def page(**over):
        base = {"id": "recP", "createdTime": "2026-09-01T00:00:00.000Z",
                "creditor": "HMRC", "status": "Awaiting response",
                "monthlyAmount": None, "entity": "", "lane": "",
                "lastContact": "", "nextStep": "", "nextStepDate": "",
                "taskIds": [], "notes": ""}
        return {**base, **over}

    # Postures: blank Monthly Amount on an agreed plan counts £0, never skips.
    frag, s = ledger_postures([
        page(status="Frozen"), page(status="Frozen"),
        page(status="Plan agreed", monthlyAmount=25.5),
        page(status="Plan agreed"),                      # blank amount → £0
        page(status="Awaiting response"),
        page(status="Settled"),
    ])
    assert s == {"frozen": 2, "onPlans": 2, "plansMonthly": 25.5,
                 "awaiting": 1}, s
    assert frag == "ledger: 2 frozen, 2 on plans £25.50/mo, 1 awaiting", frag

    # find_plan: a task link beats a name match; names are case-insensitive;
    # the OLDEST twin wins and the others are named.
    old = page(id="recOld", createdTime="2026-08-01T00:00:00.000Z",
               creditor="Fylde Council")
    new = page(id="recNew", createdTime="2026-08-20T00:00:00.000Z",
               creditor="FYLDE COUNCIL")
    linked = page(id="recLinked", creditor="Someone Else",
                  taskIds=["recTask1"])
    hit, twins = find_plan([old, new, linked], "recTask1", "fylde council")
    assert hit["id"] == "recLinked" and twins == [], (hit, twins)
    hit, twins = find_plan([new, old], "", "fylde council")
    assert hit["id"] == "recOld", hit
    assert [t["id"] for t in twins] == ["recNew"], twins
    hit, twins = find_plan([old], "", "Utilita")
    assert hit is None and twins == [], (hit, twins)

    # chase_due: fires on the day and after, never early, never on a closed
    # matter, never without a step, never without a date — a freeze request
    # carries no date, so it can never appear here.
    due = chase_due([
        page(id="a", nextStep="Chase LOA return", nextStepDate="2026-09-01"),
        page(id="b", nextStep="Chase refund", nextStepDate="2026-08-30"),
        page(id="c", nextStep="Too early", nextStepDate="2026-09-02"),
        page(id="d", nextStep="", nextStepDate="2026-09-01"),
        page(id="e", nextStep="Closed matter", nextStepDate="2026-09-01",
             status="Settled"),
        page(id="f", nextStep="No date set"),
    ], "2026-09-01")
    assert [p["id"] for p in due] == ["a", "b"], due

    # First-Monday gate, decided in code: Sept 2026 starts on a Tuesday, so
    # the first Monday is the 7th; the 14th is a Monday but not the first;
    # 1 Jun 2026 is a day-1 Monday.
    assert is_first_monday(datetime(2026, 9, 7)) is True
    assert is_first_monday(datetime(2026, 9, 14)) is False
    assert is_first_monday(datetime(2026, 9, 1)) is False
    assert is_first_monday(datetime(2026, 6, 1)) is True
    print("selftest-creditor-ledger: all checks passed")


# ─── THE COMPLIANCE BOOK (Property Administration, Kevin-approved chain,
#     2 Sep 2026; rebuilt the same day after the independent review) ────
#
# One page per property: who manages it, what it must hold, what it holds and
# when each item runs out. Three of the approved chain's links live here:
# link 2 (the queue hands the book to the agent so the portfolio is READ
# before anything is created — the gate's first rule was "never add a renewal
# that already exists"), link 5 (the ONE write path for a filed certificate,
# `certificate`, which refuses an incomplete write and links an existing row
# rather than refusing it), and link 7 (the register reading: outstanding
# issues, first live reading 2 Sep 2026).
#
# Triggers (a) and (c) of the map are the two engine-raised tasks below —
# renewal-due 30 days ahead, and the quarterly review on the first Monday of
# the quarter, decided in code in London time, never via the Airtable
# Recurring field (the same reason ensure_weekly_review gives). Both honour
# Kevin's register pause lever: a paused agent gets no tasks minted for it.
#
# UNITS (review finding, 2 Sep 2026). A block holds its electrical and gas
# certificates PER APARTMENT — Duckworth Building had nine unit-level EICRs,
# eight of them expired, and a property-keyed book read the block as in date
# on the strength of the one live certificate. So unit-linked certificates
# attach to their unit, and the reading counts each apartment's obligation
# on its own, the way compliance.html has always drawn the block.

PROPERTIES_TABLE = "tbl6f0OkAmTC2jbuG"
CERTIFICATES_TABLE = "tbl35rf9qtmq0P87r"
PROPERTY_FIELDS = {
    "name":       "fldy2t735TV5e1DIL",   # Property (full address)
    "short":      "fldqMbR329TNY974G",   # Property Name (Short), formula
    "kind":       "fldOySSrZBYkOLLTX",   # Single Let / HMO / Block
    "manager":    "fldEUrWVhSp3NY8Hh",   # Agent/Landlord (free text)
    "managerEmail": "fldwPGfGVHFf1d2dA",
    "postcode":   "fld6ebSQgD7eRsobd",
    "required":   "flduFyaQBD4duhR3l",   # Certificates Required (multi)
    "active":     "fldBUeSJQZZSnFrFW",   # Active? (from Business), lookup
    "units":      "fldLoWcv40Ag5sHRF",   # Units (link to Rental Units)
}
CERT_FIELDS = {
    "type":        "fld00ZuxT8uKagM0b",
    "property":    "fldXdDStBL7xrytgT",
    "unit":        "fldAa2aZINAPgmR79",
    "status":      "fldcSmrEQxoqpEQYF",
    "renewal":     "fldhZw8IrmgLt1hLY",
    "attachments": "fld8dwyOKs4AA0L9v",
    "notes":       "fldzNfi71BXP1E3pj",
    "tasks":       "fldnVZs4DKbcR3Ze9",
}
# The dated, renewable items. "Lock Code" and "Other" exist on the table but
# are not compliance items and never count toward the reading.
CERT_TYPES = ("GSC", "EICR", "EPC", "Fire Alarm Cert", "Emergency Lighting",
              "HMO Cert", "Landlord Insurance")
# In a Block these are held per apartment; everything else is the building's.
# A certificate filed for the whole block with NO unit link covers every
# apartment (compliance.html spreads it the same way).
UNIT_LEVEL_TYPES = ("EICR", "GSC", "EPC")
UNITS_TABLE = "tblM3mZCR5kiEdWMj"
UNIT_NAME_FIELD = "fldr8sliyu8h2jw9t"    # Rental Unit (primary, formula)
# What every property must hold, before its own Certificates Required field
# and its own history add to it (the rules are written out for Kevin in the
# brain: Knowledge/property-compliance-requirements.md). Landlord insurance,
# an EICR and an EPC are universal for a let; gas safety comes from the field
# or from history, because not every property has gas; HMOs need a licence
# and a fire alarm certificate; a block needs the fire alarm and emergency
# lighting for its common parts. HISTORY COUNTS: a property that has ever held
# a certificate type is taken to need it (someone paid for a GSC because
# there is gas), so an expired held item is always an issue and the metric's
# definition — expired, missing or undated REQUIRED items — is exactly what
# the code counts.
REQUIRED_ALL = ("Landlord Insurance", "EICR", "EPC")
REQUIRED_BY_KIND = {
    "HMO": ("HMO Cert", "Fire Alarm Cert"),
    "Block": ("Fire Alarm Cert", "Emergency Lighting"),
}
# The field's own spelling of one option, and a non-item that lives in it.
REQUIRED_FIELD_ALIASES = {"Landlord Insurace": "Landlord Insurance"}
REQUIRED_FIELD_IGNORE = ("Completed",)
RENEWAL_WINDOW_DAYS = 30
RENEWAL_LAPSE_GRACE_DAYS = 7
PROPERTY_SCORE_STATE = os.path.join(STATE_DIR, "property-score.json")
RENEWAL_STATE = os.path.join(STATE_DIR, "property-renewals.json")
QUARTERLY_REVIEW_STATE = os.path.join(STATE_DIR, "property-review.json")
QUARTERLY_REVIEW_NAME = "Property compliance review: full portfolio (quarterly)"
COMPLIANCE_TASK_PREFIX = "COMPLIANCE:"
# Stamped into every engine-raised renewal's Description. verify's
# certificate gate keys on THIS, never on the name prefix: triage is told to
# name inbound compliance mail with the same prefix, and an inspection reply
# has no certificate to file.
ENGINE_RENEWAL_MARK = "renewal raised automatically by agent-dispatch"
# The same contract for a filing the engine raises because a certificate was
# PAID FOR and never filed (2 Oct 2026): it closes only with the document.
ENGINE_FILING_MARK = certificate_watch.FILING_TASK_MARK


def property_view(rec):
    f = rec.get("fields", {})
    kind = sel(f.get(PROPERTY_FIELDS["kind"])).strip()
    field_req = []
    for v in (f.get(PROPERTY_FIELDS["required"]) or []):
        v = sel(v).strip()
        v = REQUIRED_FIELD_ALIASES.get(v, v)
        if v and v not in REQUIRED_FIELD_IGNORE:
            field_req.append(v)
    required = list(REQUIRED_ALL) + list(REQUIRED_BY_KIND.get(kind, ()))
    for v in field_req:
        if v not in required:
            required.append(v)
    active = f.get(PROPERTY_FIELDS["active"])
    # Same fallback as compliance.html: the short name, else the full name.
    # The task-name cap does any truncating, so the belt can still match.
    return {
        "id": rec.get("id"),
        "name": f.get(PROPERTY_FIELDS["name"], ""),
        "short": f.get(PROPERTY_FIELDS["short"], "") or f.get(PROPERTY_FIELDS["name"], ""),
        "kind": kind,
        "manager": (f.get(PROPERTY_FIELDS["manager"]) or "").strip(),
        "managerEmail": f.get(PROPERTY_FIELDS["managerEmail"], ""),
        "postcode": f.get(PROPERTY_FIELDS["postcode"], ""),
        "required": required,
        "units": links(f.get(PROPERTY_FIELDS["units"])),
        "active": bool(active[0]) if isinstance(active, list) and active else bool(active),
    }


def cert_view(rec):
    f = rec.get("fields", {})
    return {
        "id": rec.get("id"),
        "type": sel(f.get(CERT_FIELDS["type"])),
        "propertyIds": links(f.get(CERT_FIELDS["property"])),
        "unitIds": links(f.get(CERT_FIELDS["unit"])),
        "status": sel(f.get(CERT_FIELDS["status"])),
        "renewalDate": (f.get(CERT_FIELDS["renewal"]) or "")[:10],
        # A stand-in file is not a document (2 Oct 2026: four rows held a
        # 700-byte ...PLACEHOLDER.pdf and read as filed).
        "hasFile": certificate_watch.has_real_file(f.get(CERT_FIELDS["attachments"])),
        "taskIds": links(f.get(CERT_FIELDS["tasks"])),
        "created": str(rec.get("createdTime") or "")[:10],
    }


# One read per process. `score` runs the reading, the renewal trigger and the
# quarterly trigger in a row; each needs the same two tables, and the data
# cannot change between them inside one run.
_BOOK_CACHE = {}


def fetch_properties(refresh=False):
    if refresh or "properties" not in _BOOK_CACHE:
        _BOOK_CACHE["properties"] = [property_view(r) for r in query_records(
            PROPERTIES_TABLE, fields=list(PROPERTY_FIELDS.values()))]
    return _BOOK_CACHE["properties"]


def fetch_certificates(refresh=False):
    if refresh or "certificates" not in _BOOK_CACHE:
        _BOOK_CACHE["certificates"] = [cert_view(r) for r in query_records(
            CERTIFICATES_TABLE, fields=list(CERT_FIELDS.values()))]
    return _BOOK_CACHE["certificates"]


def fetch_unit_names(refresh=False):
    """{unitId: 'Unit 8 – Duckworth Building'} — a task or a book page that
    names an apartment by its record id is one nobody can act on."""
    if refresh or "units" not in _BOOK_CACHE:
        _BOOK_CACHE["units"] = {
            r["id"]: (r.get("fields", {}).get(UNIT_NAME_FIELD) or r["id"])
            for r in query_records(UNITS_TABLE, fields=[UNIT_NAME_FIELD])}
    return _BOOK_CACHE["units"]


def days_until(date_str, today):
    """Days from today to an ISO date; None when the date is blank."""
    if not date_str:
        return None
    return (datetime.strptime(date_str[:10], "%Y-%m-%d").date()
            - datetime.strptime(today, "%Y-%m-%d").date()).days


def item_state(days, status=""):
    """compliance.html's certStatus: a row marked Expired IS expired, whatever
    its date says; otherwise the date decides."""
    if status == "Expired" or (days is not None and days < 0):
        return "expired"
    if days is None:
        return "no date"
    if days <= RENEWAL_WINDOW_DAYS:
        return "due"
    return "in date"


def cert_lapsed(c, today):
    d = days_until(c["renewalDate"], today)
    return c["status"] == "Expired" or (d is not None and d < 0)


def newer_cert(a, b, today):
    """compliance.html's isNewer, ported: a live certificate beats a lapsed
    one, then the later renewal date, then a dated one beats an undated one."""
    if a is None:
        return b
    la, lb = cert_lapsed(a, today), cert_lapsed(b, today)
    if la != lb:
        return b if la else a
    da, db = a["renewalDate"] or "", b["renewalDate"] or ""
    if da != db:
        return b if db > da else a
    return a


def _item(c, today):
    d = days_until(c["renewalDate"], today)
    return {"certificate": c["id"], "renewalDate": c["renewalDate"],
            "days": d, "state": item_state(d, c["status"]), "hasFile": c["hasFile"]}


def compliance_pages(properties, certificates, today, unit_names=None):
    """Pure: the book. One page per property: the LATEST certificate of each
    type at property level (`holds`), the latest per apartment for the
    unit-level types in a Block (`units`, block pages only), and the `issues`
    the reading counts. A block-wide certificate with no unit link covers
    every apartment. Inactive properties keep a page (a stray certificate
    can still be filed against them) but never count toward the reading."""
    unit_names = unit_names or {}
    prop_level, unit_level, block_wide, held_types = {}, {}, {}, {}
    for c in certificates:
        if c["type"] not in CERT_TYPES:
            continue
        for pid in c["propertyIds"]:
            held_types.setdefault(pid, set()).add(c["type"])
            for uid in c["unitIds"]:
                slot = unit_level.setdefault(pid, {}).setdefault(uid, {})
                slot[c["type"]] = newer_cert(slot.get(c["type"]), c, today)
            if not c["unitIds"]:
                slot = block_wide.setdefault(pid, {})
                slot[c["type"]] = newer_cert(slot.get(c["type"]), c, today)
            slot = prop_level.setdefault(pid, {})
            slot[c["type"]] = newer_cert(slot.get(c["type"]), c, today)
    pages = []
    for p in sorted(properties, key=lambda x: x["name"]):
        required = list(p["required"])
        for t in sorted(held_types.get(p["id"], ())):
            if t not in required:
                required.append(t)
        is_block = p["kind"] == "Block"
        per_unit = [t for t in UNIT_LEVEL_TYPES if is_block and t in required]
        held = prop_level.get(p["id"], {})
        holds, issues = {}, []
        for t in CERT_TYPES:
            if t in per_unit:
                continue
            c = held.get(t)
            if c is None:
                if t in required:
                    issues.append({"type": t, "state": "missing"})
                continue
            it = _item(c, today)
            holds[t] = it
            if it["state"] in ("expired", "due", "no date"):
                issues.append({"type": t, **{k: it[k] for k in ("state", "renewalDate", "days")}})
        units = {}
        for uid in (p["units"] if is_block else []):
            u_held = unit_level.get(p["id"], {}).get(uid, {})
            wide = block_wide.get(p["id"], {})
            label = unit_names.get(uid, uid)
            units[uid] = {"name": label}
            for t in per_unit:
                # The apartment's own certificate, else the block-wide one
                # (a whole-building EICR or communal-boiler GSC), else missing.
                c = newer_cert(u_held.get(t), wide[t], today) if t in wide else u_held.get(t)
                if c is None:
                    issues.append({"type": t, "state": "missing", "unit": uid,
                                   "unitName": label})
                    continue
                it = _item(c, today)
                units[uid][t] = it
                if it["state"] in ("expired", "due", "no date"):
                    issues.append({"type": t, "unit": uid, "unitName": label,
                                   **{k: it[k] for k in ("state", "renewalDate", "days")}})
        pages.append({**p, "required": required, "holds": holds,
                      "units": units, "issues": issues})
    return pages


def compliance_book_pages(refresh=False):
    return compliance_pages(fetch_properties(refresh), fetch_certificates(refresh),
                            today_london(), fetch_unit_names(refresh))


def compliance_reading(pages):
    """Register metric (Kevin's definition, 2 Sep 2026): outstanding
    compliance issues — an expired, missing or undated required item, per
    property per type, per apartment for a block's unit-level items — plus
    what is due inside the 30-day window."""
    expired = missing = undated = due = 0
    for p in pages:
        if not p["active"]:
            continue
        for i in p["issues"]:
            if i["state"] == "expired":
                expired += 1
            elif i["state"] == "missing":
                missing += 1
            elif i["state"] == "no date":
                undated += 1
            elif i["state"] == "due":
                due += 1
    outstanding = expired + missing + undated
    frag = (f"{outstanding} outstanding ({expired} expired, {missing} missing, "
            f"{undated} undated); {due} due in {RENEWAL_WINDOW_DAYS} days")
    return frag, {"outstanding": outstanding, "expired": expired,
                  "missing": missing, "undated": undated, "dueSoon": due}


def property_score():
    props = fetch_properties()
    certs = fetch_certificates()
    # Controls: both populations are known non-empty (26 properties and 83
    # certificates on 2 Sep 2026). An empty read is a broken read, and a
    # broken read must never publish "0 outstanding".
    if not props:
        sys.exit("ERROR: control failed — zero properties read (26 existed on "
                 "2 Sep 2026). The read is broken. No property score written.")
    if not certs:
        sys.exit("ERROR: control failed — zero certificate rows read (83 "
                 "existed on 2 Sep 2026). The read is broken. No property "
                 "score written.")
    frag, stats = compliance_reading(compliance_pages(props, certs,
                                                      today_london()))
    write_register_reading("property", PROPERTY_REGISTER_ROW,
                           PROPERTY_SCORE_STATE, frag, stats)


def renewals_due(pages, today):
    """Pure: which held items need a renewal task raised — inside the 30-day
    window, or lapsed within the last week (a lapse the window missed while
    the agent was paused). Every held item counts, because history counts as
    a requirement. Missing items are the review's job, not this trigger's:
    a trigger cannot renew what was never held."""
    due = []
    for p in pages:
        if not p["active"]:
            continue
        slots = [(None, None, t, it) for t, it in p["holds"].items()]
        for uid, items in p["units"].items():
            slots += [(uid, items.get("name", uid), t, it)
                      for t, it in items.items() if t != "name"]
        seen = set()
        for uid, uname, t, it in slots:
            d = it["days"]
            if d is None or not (-RENEWAL_LAPSE_GRACE_DAYS <= d <= RENEWAL_WINDOW_DAYS):
                continue
            # A block-wide certificate covering nine apartments is ONE
            # renewal, not nine: key on the certificate.
            if it["certificate"] in seen:
                continue
            seen.add(it["certificate"])
            due.append({"propertyId": p["id"], "property": p["short"],
                        "unit": uid, "unitName": uname, "type": t,
                        "renewalDate": it["renewalDate"],
                        "days": d, "certificate": it["certificate"],
                        "manager": p["manager"]})
    return due


def property_agent_paused():
    """The register pause lever, read live: True unless the row is
    Built/Live. An engine that mints tasks for a paused agent bypasses the
    one control Kevin has over it (review finding, 2 Sep 2026)."""
    roster = fetch_role_roster()
    return not roster.get(PROPERTY_REC_ID, {}).get("dispatchable")


def ensure_renewal_tasks():
    """Trigger (a) of the approved map: a certificate's renewal date lands
    within 30 days, so a task lands on the agent's board. One task per
    certificate per renewal date — the state file makes a date fire once and
    the prefix-filtered recent-task belt holds if the state file is lost."""
    if property_agent_paused():
        print(json.dumps({"agent": "property", "paused": True,
                          "renewalTasksCreated": []}))
        return
    pages = compliance_book_pages()
    due = renewals_due(pages, today_london())
    if not due:
        return
    state = load_score_state(RENEWAL_STATE)
    fresh = [r for r in due if not state.get(f"{r['certificate']}:{r['renewalDate']}")]
    if not fresh:
        return
    recent = {t.get("fields", {}).get(AF["name"], "")
              for t in query_tasks(
                  "AND(IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -60, 'days')), "
                  f"LEFT({{Task Name}}, {len(COMPLIANCE_TASK_PREFIX)})="
                  f"'{COMPLIANCE_TASK_PREFIX}')",
                  minimal=True)}
    created = []
    for r in fresh:
        where = r["property"] + (f" ({r['unitName']})" if r["unit"] else "")
        name = (f"{COMPLIANCE_TASK_PREFIX} {r['type']} renewal due "
                f"{r['renewalDate']} - {where}")[:100]
        if name not in recent:
            raise_engine_task(
                name, PROPERTY_REC_ID, "45 min",
                f"PROPERTY COMPLIANCE — {ENGINE_RENEWAL_MARK}. The "
                f"{r['type']} at {where} runs out on {r['renewalDate']} "
                f"({r['days']} days). Managed by: {r['manager'] or 'us'}. "
                "Search everything first (the compliance book, the brain, "
                "both Drives, Gmail, Evernote): if a newer certificate or "
                "policy already exists, file it with agent-dispatch.py "
                "certificate (it links an existing row too) and close this. "
                "Otherwise work the lane on your register row (letting agent "
                "chase, three quotes to Roy, or TopCashback insurance) and "
                "file the result the same way.")
            created.append({"type": r["type"], "property": r["property"],
                            "unit": r["unit"], "renewalDate": r["renewalDate"]})
        state[f"{r['certificate']}:{r['renewalDate']}"] = today_london()
    save_state(RENEWAL_STATE, state)
    print(json.dumps({"agent": "property", "renewalsDue": len(due),
                      "renewalTasksCreated": created}))


# PAID FOR BUT NEVER FILED (Kevin, 2 Oct 2026). The renewal trigger above only
# sees certificates the book already holds. A visit that was booked, done and
# paid for leaves a bank line and, if nobody files the document, nothing else:
# the book says "missing" and the next run buys it again. This reads the paid
# compliance lines straight from the bank and raises a filing task for each one
# with no certificate filed around it. Rules: scripts/certificate_watch.py.
TRANSACTIONS_TABLE = "tbln0gzhCAorFc3zB"
TX_FIELDS = {"date": "fldoyQ6Rr9cHp3bgQ", "amount": "fldot7iisZeL3WrdR",
             "name": "fldsbuAJCTsXHug4C", "costs": "fldGkpkVqSeiGvUGL",
             "property": "fldvp44VfF8uTTthp"}
COMPLIANCE_SUBCATEGORY = "COGS Property Compliance"
# Book type for each task-name certificate label (certificate_type()).
BOOK_TYPE_FOR = {"GSC": "GSC", "EICR": "EICR", "EPC": "EPC",
                 "INSURANCE": "Landlord Insurance"}


def fetch_compliance_payments():
    """Paid compliance lines from the bank, newest lookback window only.

    The sub-category is matched by its display name through ARRAYJOIN, which is
    what ARRAYJOIN over a link returns. A renamed sub-category would return zero
    and read as "nothing paid", so the caller checks an all-time control."""
    days = certificate_watch.PAYMENT_LOOKBACK_DAYS + 1
    rows = query_records(
        TRANSACTIONS_TABLE,
        formula=("AND(FIND('" + COMPLIANCE_SUBCATEGORY + "', ARRAYJOIN({Chart of Accounts - "
                 "Sub Category})), IS_AFTER({**Date}, DATEADD(TODAY(), -" + str(days) + ", 'days')))"),
        fields=list(TX_FIELDS.values()))
    out = []
    for r in rows:
        f = r.get("fields", {}) or {}
        out.append({"id": r.get("id"), "date": str(f.get(TX_FIELDS["date"]) or "")[:10],
                    "amount": float(f.get(TX_FIELDS["amount"]) or 0),
                    "name": str(f.get(TX_FIELDS["name"]) or ""),
                    "costIds": links(f.get(TX_FIELDS["costs"])),
                    "propertyIds": links(f.get(TX_FIELDS["property"]))})
    return out


FILING_TX_RE = re.compile(r"\(transaction (rec[A-Za-z0-9]{14})\)")


def filing_tasks_by_transaction():
    """{transaction id: "resolved" | "raised"} from the filing tasks themselves.

    Airtable is the record, not a state file: a file lost in a host move would
    re-raise every payment, and a payment an agent answered on the record ("it
    was a repair") would block that house's purchases for months. A task is
    "resolved" when it carries the no-certificate mark, OR a certificate row
    with a real file is linked to it. The link is what answers the payment:
    judged by date and type alone, a certificate attached to an older row, or
    one whose type the bank text does not name, would leave the payment
    "unfiled" after a correct close and block the house for months. Any other
    filing task for the transaction, open or closed, means it was raised."""
    rows = query_records(
        TASKS, formula="FIND('" + ENGINE_FILING_MARK + "', {Description})",
        fields=[AF["description"], AF["notes"]])
    filed_tasks = {tid for c in fetch_certificates() if c["hasFile"] for tid in c["taskIds"]}
    out = {}
    for r in rows:
        f = r.get("fields", {}) or {}
        m = FILING_TX_RE.search(str(f.get(AF["description"]) or ""))
        if not m:
            continue
        resolved = (certificate_watch.NO_CERTIFICATE_MARK in str(f.get(AF["notes"]) or "")
                    or r.get("id") in filed_tasks)
        if resolved or m.group(1) not in out:
            out[m.group(1)] = "resolved" if resolved else "raised"
    return out


def paid_certificate_gaps(filing_tasks=None):
    """(unfiled, unplaced, payments_read): see certificate_watch.paid_without_certificate."""
    payments = fetch_compliance_payments()
    if not payments and not query_records(
            TRANSACTIONS_TABLE, max_records=1, fields=[TX_FIELDS["date"]],
            formula="FIND('" + COMPLIANCE_SUBCATEGORY + "', ARRAYJOIN({Chart of Accounts - Sub Category}))"):
        sys.exit("ERROR: control failed: no transaction has ever carried the sub-category "
                 f"'{COMPLIANCE_SUBCATEGORY}'. It was renamed or the read is broken; the "
                 "paid-but-not-filed check cannot run.")
    certs = fetch_certificates()
    if not certs:
        sys.exit("ERROR: control failed: the compliance book read returned no "
                 "certificates, so every payment would read as unfiled.")
    if filing_tasks is None:
        filing_tasks = filing_tasks_by_transaction()
    unfiled, unplaced = certificate_watch.paid_without_certificate(
        payments, certs, today_london(),
        resolved_ids=[tx for tx, state in filing_tasks.items() if state == "resolved"])
    return unfiled, unplaced, len(payments)


def ensure_paid_certificates_filed():
    """One filing task per compliance payment with no certificate in the book.
    A payment fires once (its filing task is the record), and a payment with no
    property on it gets a task too: a check that skips what it cannot place
    reads as all clear."""
    if property_agent_paused():
        print(json.dumps({"agent": "property", "paused": True, "paidFilingTasksCreated": []}))
        return
    already = filing_tasks_by_transaction()
    unfiled, unplaced, read = paid_certificate_gaps(already)
    names = {p["id"]: p["short"] for p in fetch_properties()}
    created = []
    for p, placed in [(x, True) for x in unfiled] + [(x, False) for x in unplaced]:
        if p["id"] in already:
            continue
        where = ", ".join(names.get(i, i) for i in p["propertyIds"]) if placed else "property not recorded"
        name = (f"{COMPLIANCE_TASK_PREFIX} file the certificate paid for on "
                f"{p['date']} - {where}")[:100]
        raise_engine_task(
            name, PROPERTY_REC_ID, "30 min",
            f"PROPERTY COMPLIANCE — {ENGINE_FILING_MARK}. A compliance payment left the "
            f"bank on {p['date']}: £{abs(p['amount']):,.2f}, \"{p['name'][:120]}\" "
            f"(transaction {p['id']}), property: {where}. The compliance book holds no "
            "certificate with a real document filed for that property around that date. "
            "A paid visit with nothing filed gets bought a second time. "
            + ("Find the certificate (the engineer's or Roy's email and its attachment, "
               "the invoice email, both Drives) and file it with agent-dispatch.py "
               "certificate. If the payment was not for a certificate, close with "
               "complete --no-certificate \"<what it was for>\"."
               if placed else
               "The payment has no property on it, so it cannot be checked. Work out which "
               "property it was for from the bank text and the invoice, then file the "
               "certificate with agent-dispatch.py certificate, or close with complete "
               "--no-certificate \"<what it was for>\"."))
        created.append({"transaction": p["id"], "date": p["date"], "property": where})
        already[p["id"]] = "raised"
    print(json.dumps({"agent": "property", "compliancePaymentsRead": read,
                      "paidWithNoCertificate": len(unfiled), "paymentsWithNoProperty": len(unplaced),
                      "paidFilingTasksCreated": created}))


def task_property_id(name, properties):
    """The one property a task name is about, or "" when none or several."""
    hits = [p["id"] for p in properties or []
            if str(p.get("short") or "").strip()
            and re.search(r"(?<![0-9A-Za-z])" + re.escape(str(p["short"]).strip()), str(name or ""), re.I)]
    return hits[0] if len(hits) == 1 else ""


def certificate_purchase_problem(name, output, mail_subject="", description=""):
    """Why a COMPLIANCE quote request or booking must not go out, or "".

    Only judged when the output IS a purchase step: a PASS TO ROY booking, or an
    email whose subject asks for a quote. Anything it cannot place (no single
    property in the name) is let through: the daily paid-but-not-filed check is
    the backstop, and refusing unrelated work would teach agents to rename tasks."""
    if not str(name or "").startswith(COMPLIANCE_TASK_PREFIX):
        return ""
    # The engine's own filing task exists BECAUSE of an unfiled payment: asking Roy
    # or the engineer for the copy is the job, not a second purchase.
    if ENGINE_FILING_MARK in str(description or ""):
        return ""
    # search with MULTILINE, not match: a tier-1 banner is prepended above it.
    booking = re.search(r"^\s*PASS TO ROY:", output or "", re.I | re.M)
    if not (booking or "quote" in str(mail_subject or "").lower()):
        return ""
    prop = task_property_id(name, fetch_properties())
    if not prop:
        return ""
    unfiled, _unplaced, _read = paid_certificate_gaps()
    return certificate_watch.purchase_block(
        prop, BOOK_TYPE_FOR.get(certificate_type(name), ""), fetch_certificates(),
        unfiled, today_london())


def cmd_certificate_gaps(args):
    """Read-only: what has been paid for and not filed, and whether a purchase
    for one property and type is blocked. The agent runs this BEFORE sourcing a
    quote. Exit 3 when --property/--type is blocked."""
    unfiled, unplaced, read = paid_certificate_gaps()
    names = {p["id"]: p["short"] for p in fetch_properties()}
    show = lambda p: {"transaction": p["id"], "date": p["date"], "amount": p["amount"],  # noqa: E731
                      "name": p["name"][:80],
                      "property": [names.get(i, i) for i in p["propertyIds"]]}
    out = {"compliancePaymentsRead": read, "paidWithNoCertificate": [show(p) for p in unfiled],
           "paymentsWithNoProperty": [show(p) for p in unplaced]}
    blocked = ""
    if args.property:
        if args.property not in names:
            sys.exit(f"ERROR: {args.property} is not a Properties record")
        blocked = certificate_watch.purchase_block(
            args.property, args.type or "", fetch_certificates(), unfiled, today_london())
        out["purchaseBlocked"] = blocked or False
    print(json.dumps(out, indent=1))
    if blocked:
        sys.exit(3)


# ONE WEEKLY CHASE FOR ROY'S STALE REPAIRS (Kevin, 17 Sep 2026). The Property
# Administration file has promised since 2 Sep to follow up any repair task of
# Roy's with no movement in 7 days, but nothing ever raised that follow-up: it
# happened only if a run happened to look (found by the 17 Sep handoff map).
# One task a week, listing every stale repair, so Roy gets one chase and Kevin's
# queue never gets one card per repair. Linked records are matched through the
# record-id LOOKUP, never ARRAYJOIN of the link itself (CLAUDE.md).
ROY_REC_ID = HUMANS["roy.lavin1978@gmail.com"]["rec"]
ROY_STALE_DAYS = 7
ROY_FOLLOWUP_STATE = os.path.join(STATE_DIR, "roy-followups.json")
ROY_FOLLOWUP_NAME = "MAINTENANCE: weekly follow-up with Roy on repairs unmoved for 7 days"
ROY_OPEN_FORMULA = ("AND(FIND('" + ROY_REC_ID + "', ARRAYJOIN({Record ID (Used for Automation) "
                    "(from Team Members)})), {Status}!='Completed', {Status}!='Cancelled')")


def stale_roy_repairs(rows):
    """Repairs among Roy's open tasks: a Maintenance Ticket tick or a MAINTENANCE: name."""
    out = []
    for r in rows:
        f = r.get("fields", {}) or {}
        name = str(f.get(AF["name"]) or "")
        if f.get(AF["maintenanceTicket"]) or name.upper().startswith("MAINTENANCE:"):
            if name != ROY_FOLLOWUP_NAME:
                out.append({"id": r.get("id", ""), "name": name[:90]})
    return out


def roy_followup_week(now):
    year, week, _ = now.isocalendar()
    return f"{year}-W{week:02d}"


def ensure_roy_followups(dry_run=False, fetch=None, now=None, state_path=None):
    """Raise at most one follow-up task a week for Roy's stale repairs."""
    fetch = fetch or query_tasks
    now = now or datetime.now(LONDON)
    state_path = state_path or ROY_FOLLOWUP_STATE
    week = roy_followup_week(now)
    state = load_score_state(state_path)
    if state.get("week") == week and not dry_run:
        return {"week": week, "created": False, "reason": "already raised this week"}
    if property_agent_paused() and not dry_run:
        return {"week": week, "created": False, "reason": "property agent paused"}
    open_rows = fetch(ROY_OPEN_FORMULA)
    if not open_rows:
        # CONTROL: Roy has held dozens of open tasks since 25 Aug 2026. Zero
        # means the lookup broke, not that every repair is done.
        print("ERROR: roy-followups control failed: zero open tasks read for Roy; "
              "the lookup field or formula is broken", file=sys.stderr)
        return {"week": week, "created": False, "reason": "control failed", "controlFailed": True}
    stale = stale_roy_repairs(fetch(
        ROY_OPEN_FORMULA[:-1] + f", IS_BEFORE(LAST_MODIFIED_TIME(), "
        f"DATEADD(NOW(), -{ROY_STALE_DAYS}, 'days')))"))
    result = {"week": week, "royOpen": len(open_rows), "stale": stale, "created": False}
    if not stale or dry_run:
        return result
    desc = ("PROPERTY FOLLOW-UP (raised automatically, once a week). These repair tasks "
            f"held by Roy have not moved in {ROY_STALE_DAYS} days. Send Roy ONE chase "
            "covering all of them (his standing approval covers maintenance), ask for "
            "the booking date or the reason each is stuck, and note his answer on each "
            "task. Nothing here is a card for Kevin unless money or law is involved.\n"
            + "\n".join(f"- {t['id']}: {t['name']}" for t in stale))
    raise_engine_task(ROY_FOLLOWUP_NAME, PROPERTY_REC_ID, "20 min", desc[:95000],
                      priority="Medium")
    save_state(state_path, {"week": week, "raisedAt": now_iso(), "stale": len(stale)})
    result["created"] = True
    print(json.dumps({"agent": "property", "royFollowup": result}))
    return result


def cmd_roy_followups(args):
    print(json.dumps(ensure_roy_followups(dry_run=args.dry_run), indent=2))


def is_quarter_first_monday(now):
    """First Monday of January, April, July or October — the first week of
    each calendar quarter, London time."""
    return is_first_monday(now) and now.month in (1, 4, 7, 10)


def quarter_label(now):
    return f"{now.year}-Q{(now.month - 1) // 3 + 1}"


def ensure_quarterly_review():
    """Trigger (c) of the approved map: the full portfolio review, quarterly.
    The FIRST review was raised by the build session on 2 Sep 2026 under
    this exact name, with the state file stamped for 2026-Q4 so the engine's
    first own review is January 2027, not five weeks after the first. The
    state file is the authoritative guard; the exact-name read is the belt
    for a lost state file, and a broken belt mints a visible task, never
    silent corruption."""
    now = datetime.now(LONDON)
    if not is_quarter_first_monday(now):
        return
    quarter = quarter_label(now)
    state = load_score_state(QUARTERLY_REVIEW_STATE)
    if state.get("quarter") == quarter:
        return
    if property_agent_paused():
        print(json.dumps({"agent": "property", "quarterlyReview": quarter,
                          "paused": True, "created": False}))
        return
    existing = query_tasks(
        "AND({Task Name}='" + QUARTERLY_REVIEW_NAME + "', "
        "IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -60, 'days')))",
        max_records=1, minimal=True)
    if not existing:
        raise_engine_task(
            QUARTERLY_REVIEW_NAME, PROPERTY_REC_ID, "2 hours",
            "PROPERTY COMPLIANCE — quarterly full review (raised "
            "automatically on the first Monday of the quarter). Walk every "
            "property in the compliance book: confirm what it must hold, "
            "find every certificate, licence and policy that exists "
            "anywhere (Airtable, brain, both Drives, Gmail, Evernote, "
            "Loom), file what is found, and prepare ONE plan of what is "
            "missing in Kevin's priority order: insurance, gas safety, "
            "then the rest. Also chase any repair task with Roy that has "
            "not moved in 7 days. One submission, not one per issue.")
    save_state(QUARTERLY_REVIEW_STATE, {"quarter": quarter, "raisedAt": now_iso(),
                                        "existing": bool(existing)})
    print(json.dumps({"agent": "property", "quarterlyReview": quarter,
                      "created": not existing}))


def find_certificate_twin(certs, property_id, cert_type, renewal, unit_id):
    """The row this filing already has, if any: same property, type, renewal
    date AND unit (a block's apartments legitimately share a date)."""
    for c in certs:
        if (property_id in c["propertyIds"] and c["type"] == cert_type
                and c["renewalDate"] == renewal
                and (c["unitIds"][:1] or [None])[0] == unit_id):
            return c
    return None


def cmd_certificate(args):
    """Link 5 of the approved map, and the ONE write path to the Property
    Certificates table. A filed certificate needs the property, the type,
    the renewal date and the document, or it is refused: a dated row with no
    file is a claim, and a file with no date never alerts. When the row
    already exists (Kevin, a letting agent or compliance.html filed it) the
    task is LINKED to it and the file attached if it has none — so "it
    already exists, file it and close" is a clean path, never a refusal.
    verify fails any engine-raised renewal the agent closes without passing
    through here."""
    if args.type not in CERT_TYPES:
        sys.exit(f"ERROR: --type must be one of {', '.join(CERT_TYPES)}")
    try:
        datetime.strptime(args.renewal, "%Y-%m-%d")
    except ValueError:
        sys.exit("ERROR: --renewal must be YYYY-MM-DD — the date the "
                 "certificate or policy runs out")
    if not os.path.isfile(args.file):
        sys.exit(f"ERROR: no such document to file: {args.file}")
    if certificate_watch.is_placeholder({"filename": os.path.basename(args.file),
                                         "size": os.path.getsize(args.file)}):
        sys.exit(f"ERROR: {args.file} is a placeholder, not a document (named as one, or "
                 f"under {certificate_watch.PLACEHOLDER_MAX_BYTES} bytes). File the real "
                 "certificate, or leave the task open until it arrives.")
    # Every link is checked before anything is written: with typecast on,
    # Airtable resolves an unmatched string against the linked table's
    # primary field and MINTS a record for it, so a task name in place of a
    # task id would create a phantom task and link the certificate to that.
    try:
        get_task(args.task)
    except Exception as exc:                                # noqa: BLE001
        sys.exit(f"ERROR: {args.task} is not a Tasks record ({str(exc)[:80]}) "
                 "— pass the task's rec id, never its name")
    props = {p["id"]: p for p in fetch_properties()}
    if args.property not in props:
        sys.exit(f"ERROR: {args.property} is not a Properties record — a "
                 "certificate filed against the wrong record is invisible")
    if args.unit and args.unit not in props[args.property]["units"]:
        sys.exit(f"ERROR: {args.unit} is not a unit of "
                 f"{props[args.property]['short']} (units: "
                 f"{', '.join(props[args.property]['units']) or 'none'})")
    twin = find_certificate_twin(fetch_certificates(), args.property,
                                 args.type, args.renewal, args.unit)
    if twin:
        # The file goes on BEFORE the task is linked: a link on a row with no
        # document would let verify read the close as filed. Notes append,
        # never replace — the row may carry a policy number Kevin typed.
        filename = None
        if not twin["hasFile"]:
            filename = upload_file(twin["id"], CERT_FIELDS["attachments"],
                                   args.file)
        fields = {CERT_FIELDS["tasks"]: sorted(set(twin["taskIds"]) | {args.task})}
        if args.note:
            prior = _request("GET", f"/{CERTIFICATES_TABLE}/{twin['id']}"
                             "?returnFieldsByFieldId=true").get(
                "fields", {}).get(CERT_FIELDS["notes"], "")
            line = f"{today_london()}: {args.note}"
            fields[CERT_FIELDS["notes"]] = (prior + "\n" + line) if prior else line
        _request("PATCH", f"/{CERTIFICATES_TABLE}/{twin['id']}",
                 {"fields": fields, "typecast": True})
        row_id = twin["id"]
    else:
        fields = {
            CERT_FIELDS["type"]: args.type,
            CERT_FIELDS["property"]: [args.property],
            CERT_FIELDS["status"]: "Active",
            CERT_FIELDS["renewal"]: args.renewal,
            CERT_FIELDS["tasks"]: [args.task],
        }
        if args.unit:
            fields[CERT_FIELDS["unit"]] = [args.unit]
        if args.note:
            fields[CERT_FIELDS["notes"]] = f"{today_london()}: {args.note}"
        created = _request("POST", f"/{CERTIFICATES_TABLE}",
                           {"fields": fields, "typecast": True})
        row_id = created["id"]
        # The file goes on AFTER the row exists (the upload needs a record
        # id), and a refused upload deletes the row again: a dated row with
        # no document must never survive a failed run. If even the delete
        # fails, the orphan is NAMED so it is cleaned up, never discovered.
        try:
            filename = upload_file(row_id, CERT_FIELDS["attachments"], args.file)
        except SystemExit:
            try:
                _request("DELETE", f"/{CERTIFICATES_TABLE}/{row_id}")
            except Exception as exc:                        # noqa: BLE001
                print(f"ERROR: upload failed AND the rollback delete failed "
                      f"({str(exc)[:120]}) — certificate row {row_id} exists "
                      "with NO document; delete it or attach the file by "
                      "re-running this command (it links the existing row)",
                      file=sys.stderr)
            raise
    live = cert_view(_request(
        "GET", f"/{CERTIFICATES_TABLE}/{row_id}?returnFieldsByFieldId=true"))
    print(json.dumps({"row": live["id"], "created": twin is None,
                      "type": live["type"],
                      "property": props[args.property]["short"],
                      "unit": args.unit or None,
                      "renewalDate": live["renewalDate"],
                      "file": filename, "hasFile": live["hasFile"],
                      "taskLinked": args.task in live["taskIds"]}))


def property_selftest():
    today = "2026-09-02"
    P = lambda **kw: {"managerEmail": "", "postcode": "", "manager": "",  # noqa: E731
                      "units": [], "active": True, **kw}
    C = lambda **kw: {"unitIds": [], "status": "Active", "hasFile": True,  # noqa: E731
                      "taskIds": [], **kw}
    props = [
        P(id="pA", name="A", short="A", kind="HMO",
          required=["Landlord Insurance", "EICR", "EPC", "HMO Cert", "Fire Alarm Cert", "GSC"]),
        P(id="pB", name="B", short="B", kind="Single Let ", manager="Agent",
          required=["Landlord Insurance", "EICR", "EPC"]),
        P(id="pC", name="C", short="C", kind="Single Let ",
          required=["Landlord Insurance", "EICR", "EPC"], active=False),
        P(id="pD", name="D", short="D", kind="Block", units=["u1", "u2", "u3"],
          required=["Landlord Insurance", "EICR", "EPC", "Fire Alarm Cert", "Emergency Lighting"]),
        # E, a block with one block-wide EICR and no unit links: every
        # apartment is covered by it, and it is ONE renewal
        P(id="pE", name="E", short="E", kind="Block", units=["e1", "e2"],
          required=["EICR"]),
    ]
    certs = [
        # A: old GSC then a newer one — latest wins and it is due in 20 days
        C(id="c1", type="GSC", propertyIds=["pA"], status="Expired", renewalDate="2025-01-01"),
        C(id="c2", type="GSC", propertyIds=["pA"], renewalDate="2026-09-22"),
        # A: EICR expired, insurance undated, EPC/HMO cert/fire alarm missing
        C(id="c3", type="EICR", propertyIds=["pA"], renewalDate="2026-03-01"),
        C(id="c4", type="Landlord Insurance", propertyIds=["pA"], renewalDate="", hasFile=False),
        # B: everything in date; a Lock Code row must be ignored; a held
        # Fire Alarm cert (not in B's list) that has lapsed IS an issue —
        # history counts as a requirement
        C(id="c5", type="EICR", propertyIds=["pB"], renewalDate="2030-01-01"),
        C(id="c6", type="Landlord Insurance", propertyIds=["pB"], renewalDate="2027-06-01"),
        C(id="c6b", type="EPC", propertyIds=["pB"], renewalDate="2031-01-01"),
        C(id="c7", type="Lock Code", propertyIds=["pB"], status="", renewalDate="", hasFile=False),
        C(id="c8", type="Fire Alarm Cert", propertyIds=["pB"], renewalDate="2026-01-01"),
        # C is inactive: its missing items never count
        # D, a block: EICR per apartment — u1 live, u2 expired, u3 nothing;
        # a live earlier-dated EICR beats a lapsed later-dated one (isNewer)
        C(id="d1", type="EICR", propertyIds=["pD"], unitIds=["u1"], renewalDate="2027-03-08"),
        C(id="d2", type="EICR", propertyIds=["pD"], unitIds=["u2"], status="Expired", renewalDate="2026-03-08"),
        C(id="d2b", type="EICR", propertyIds=["pD"], unitIds=["u2"], renewalDate="2026-12-01"),
        C(id="d3", type="Landlord Insurance", propertyIds=["pD"], renewalDate="2027-01-01"),
        # D: a block-wide EPC covers u1..u3; a Status-Expired undated row IS expired
        C(id="d4", type="EPC", propertyIds=["pD"], renewalDate="2030-01-01"),
        C(id="d5", type="Fire Alarm Cert", propertyIds=["pD"], status="Expired", renewalDate=""),
        C(id="e0", type="EICR", propertyIds=["pE"], renewalDate="2026-09-15"),
    ]
    pages = compliance_pages(props, certs, today, {"u1": "Unit 1 – D", "e1": "Unit 1 – E"})
    frag, s = compliance_reading(pages)
    a = next(p for p in pages if p["id"] == "pA")
    assert a["holds"]["GSC"]["certificate"] == "c2", "latest certificate must win"
    assert {i["type"] for i in a["issues"] if i["state"] == "missing"} == {"EPC", "HMO Cert", "Fire Alarm Cert"}
    b = next(p for p in pages if p["id"] == "pB")
    assert "Fire Alarm Cert" in b["required"], "a held type becomes required"
    assert [i["type"] for i in b["issues"]] == ["Fire Alarm Cert"], b["issues"]
    assert "units" not in b or b["units"] == {}, "only a block carries per-unit slots"
    d = next(p for p in pages if p["id"] == "pD")
    assert "EICR" not in d["holds"] and "EPC" not in d["holds"], "a block's EICR and EPC are per apartment"
    assert d["units"]["u1"]["name"] == "Unit 1 – D" and d["units"]["u2"]["name"] == "u2"
    assert d["units"]["u1"]["EICR"]["state"] == "in date"
    assert d["units"]["u2"]["EICR"]["certificate"] == "d2b", "live beats lapsed"
    assert d["units"]["u2"]["EICR"]["state"] == "in date"
    assert all(d["units"][u]["EPC"]["certificate"] == "d4" for u in ("u1", "u2", "u3")), "a block-wide certificate covers every apartment"
    assert d["holds"]["Fire Alarm Cert"]["state"] == "expired", "Status Expired is expired even undated"
    d_issues = sorted((i["type"], i.get("unit"), i["state"]) for i in d["issues"])
    assert d_issues == [("EICR", "u3", "missing"), ("Emergency Lighting", None, "missing"),
                        ("Fire Alarm Cert", None, "expired")], d_issues
    e = next(p for p in pages if p["id"] == "pE")
    assert all(e["units"][u]["EICR"]["certificate"] == "e0" for u in ("e1", "e2"))
    # A: 1 expired (EICR) + 3 missing + 1 undated (insurance); B: 1 expired;
    # D: 2 missing + 1 expired; C: nothing (inactive); E: nothing outstanding.
    # Due: A's GSC and E's block-wide EICR (once, not per apartment).
    assert s == {"outstanding": 9, "expired": 3, "missing": 5, "undated": 1,
                 "dueSoon": 3}, s
    assert frag == "9 outstanding (3 expired, 5 missing, 1 undated); 3 due in 30 days", frag
    due = renewals_due(pages, today)
    assert [(r["type"], r["unit"], r["unitName"], r["days"]) for r in due] == [
        ("GSC", None, None, 20), ("EICR", "e1", "Unit 1 – E", 13)], due
    # A lapse inside the grace window still fires; older lapses do not.
    lapsed = compliance_pages(
        [props[1]], [C(id="x", type="EICR", propertyIds=["pB"], renewalDate="2026-08-30"),
                     C(id="y", type="EPC", propertyIds=["pB"], renewalDate="2026-08-01")], today)
    assert [(r["type"], r["days"]) for r in renewals_due(lapsed, today)] == [("EICR", -3)]
    # The twin finder respects the unit.
    assert find_certificate_twin(certs, "pD", "EICR", "2027-03-08", "u1")["id"] == "d1"
    assert find_certificate_twin(certs, "pD", "EICR", "2027-03-08", "u2") is None
    assert find_certificate_twin(certs, "pD", "EICR", "2027-03-08", None) is None
    # The property matcher: name-only, legal and creditor vetoes, no bare words.
    assert property_match("Landlord insurance renewal - 23 Viola Street")
    assert property_match("Sefton HMO licence fee overdue 23 Viola Street")
    assert property_match("EICR certificate outstanding - 1406 Oldham Road")
    assert not property_match("Renew SSL certificate for runpreneur.org.uk")
    assert not property_match("GDPR compliance review for OD onboarding")
    assert not property_match("Professional indemnity insurance quote for OD")
    assert not property_match("Close Brothers Premium Finance default notice on insurance")
    assert not property_match("Boiler leak at 5 Dalham Place"), "repairs stay Roy's"
    assert not property_match("Gas safety certificate", "solicitor letter attached")
    assert not property_match("Insurance for Brittain Home")
    assert is_quarter_first_monday(datetime(2026, 10, 5)) is True
    assert is_quarter_first_monday(datetime(2026, 9, 7)) is False
    assert is_quarter_first_monday(datetime(2027, 1, 4)) is True
    assert quarter_label(datetime(2026, 10, 5)) == "2026-Q4"
    print("selftest-property: all checks passed")


# One row per per-agent housekeeping step the score command runs. A new role
# agent's build session adds its reading function and ONE entry here — never
# another copy of the loop or the change-gated register write (that is
# write_register_reading). Selftests ride in the parallel tuple so
# `score --selftest` can never silently skip a new agent's maths.
SCORE_STEPS = (
    ("response", response_score),
    ("creditor", creditor_score),
    ("weekly-review", ensure_weekly_review),
    ("monthly-review", ensure_monthly_review),
    ("chase", ensure_chase_tasks),
    ("property", property_score),
    ("renewals", ensure_renewal_tasks),
    ("paid-filings", ensure_paid_certificates_filed),
    ("roy-followups", ensure_roy_followups),
    ("quarterly-review", ensure_quarterly_review),
)
SCORE_SELFTESTS = (response_score_selftest, creditor_score_selftest,
                   creditor_ledger_selftest, property_selftest)


# ─── RECONCILE: work that finished on disk but never reached Airtable ──
#
# Finding 20260824-agent-dispatch-336. `agent-dispatch.py reconcile` has been
# mandated as the FIRST action of every dispatch run since 19 Aug 2026, after a
# tier-1 deliverable with a five-day court deadline went invisible. The
# subparser list was queue, route, escalate, handover, submit, annotate, intent,
# complete, verify — so running it exited 2 with "invalid choice: reconcile",
# the run logged the error and carried on, and the control the whole skill leans
# on had NEVER ONCE RUN. Raised on 23 and again on 24 Aug; neither fix reached
# main.
#
# The gap it catches: a run that died between an agent writing RUNDIR/TASKID.md
# and the submit call. The work exists and is finished, the Airtable record
# still has an empty Agent Output, so it appears on no surface Kevin looks at
# and nothing alarms — because nothing recorded the action.


def run_dirs(limit=3):
    """The most recent run directories, newest last. Names sort chronologically."""
    if not os.path.isdir(STATE_DIR):
        return []
    dirs = sorted(d for d in os.listdir(STATE_DIR)
                  if os.path.isdir(os.path.join(STATE_DIR, d)))
    return [os.path.join(STATE_DIR, d) for d in dirs[-limit:]]


def deliverables_on_disk(limit=3):
    """{taskId: path} for every finished deliverable in the recent run dirs.

    A finished deliverable is RUNDIR/TASKID.md — one level UP from the agent's
    own working directory, which is RUNDIR/TASKID/. Anything inside the working
    directory is scratch and is deliberately not looked at.
    """
    found = {}
    for d in run_dirs(limit):
        for name in sorted(os.listdir(d)):
            if not name.endswith(".md"):
                continue
            task_id = name[:-3]
            if not task_id.startswith("rec"):
                continue
            path = os.path.join(d, name)
            if os.path.isfile(path) and os.path.getsize(path) > 0:
                found[task_id] = path          # newest run wins
    return found


def cmd_reconcile(args):
    """Name every finished deliverable on disk that never reached Airtable.

    Exits 1 when there are orphans, so a dispatcher that ignores the output
    still cannot proceed past one.
    """
    disk = deliverables_on_disk(args.runs)
    orphans, checked, errors = [], 0, []
    for task_id, path in sorted(disk.items()):
        try:
            rec = get_task(task_id)
        except Exception as exc:      # noqa: BLE001 — a deleted task must not stop the sweep
            errors.append({"task": task_id, "error": str(exc)})
            continue
        checked += 1
        fields = rec.get("fields", {}) or {}
        if (fields.get(AF["agentOutput"]) or "").strip():
            continue
        orphans.append({
            "task": task_id,
            "name": fields.get(AF["name"]),
            "status": fields.get(AF["status"]),
            "deliverable": path,
            "bytes": os.path.getsize(path),
        })

    # THE CONTROL. "No orphans" and "found no deliverables to look at" print the
    # same reassuring line, and only one of them is good news. If the run
    # directories hold nothing, say so and exit non-zero: a reconcile that
    # inspected nothing has not proved anything.
    out = {
        "runDirs": [os.path.basename(d) for d in run_dirs(args.runs)],
        "deliverablesFound": len(disk),
        "recordsChecked": checked,
        "orphans": orphans,
        "errors": errors,
    }
    print(json.dumps(out, indent=1))
    if not disk:
        print("WARNING: no deliverables found in the last %d run directories — "
              "nothing was verified. This is not the same as 'no orphans'."
              % args.runs, file=sys.stderr)
        return 1
    if orphans:
        print("ERROR: %d finished deliverable(s) never reached Airtable. Submit "
              "each one BEFORE working anything new." % len(orphans),
              file=sys.stderr)
        return 1
    if errors:
        print("ERROR: %d task(s) could not be read; treat as unreconciled."
              % len(errors), file=sys.stderr)
        return 1
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("queue")

    sc = sub.add_parser("score",
                        help="compute the Inbound Comms Response 24h metric, "
                             "the Creditor Management ledger reading and the "
                             "Property Administration outstanding-issues "
                             "reading, write each to its register Metric "
                             "Score, and raise the engine's own tasks")
    sc.add_argument("--selftest", action="store_true",
                    help="run the offline maths checks, no Airtable access")

    ra = sub.add_parser("reassign",
                        help="hand a task back to the AI CEO to be given to a "
                             "different agent")
    ra.add_argument("task")
    ra.add_argument("--reason", required=True,
                    help="why this agent is the wrong home for it, in one line")
    ra.add_argument("--by", default="", help="who is sending it back")

    r = sub.add_parser("route")
    r.add_argument("task")
    r.add_argument("--to", required=True)

    e = sub.add_parser("escalate",
                       help="put a decision card in Kevin's gate (Status Approval, "
                            "sent by the Task Manager: a DECIDE: ask line, the brief, "
                            "the history, links and files)")
    e.add_argument("task")
    e.add_argument("--reason", default="",
                   help="the one thing Kevin must decide; becomes the DECIDE: line")
    e.add_argument("--brief-file", metavar="PATH",
                   help="the brief Kevin decides from: WHAT THIS IS / WHAT HAS HAPPENED / "
                        "OPTIONS / RECOMMENDED sections; refused without it (2 Oct 2026)")
    e.add_argument("--plain-task", metavar="SENTENCE",
                   help="what the task is, one short plain sentence; first line of the card")
    e.add_argument("--plain-approve", metavar="SENTENCE",
                   help="what happens if Kevin approves with no note (the recommended option), "
                        "one short plain sentence; second line of the card")
    e.add_argument("--email", action="append", metavar="ADDRESS",
                   help="a contact whose past tasks and emails belong in the card's history")
    e.add_argument("--ref", action="append", metavar="TEXT",
                   help="a reference, account or name to search the history for")
    e.add_argument("--property", action="append", metavar="ADDRESS",
                   help="a property whose past tasks belong in the card's history")
    e.add_argument("--no-gmail", action="store_true", help="history from tasks only")
    e.add_argument("--tier1", action="store_true",
                   help="the decision touches Kevin's private matter: stamps the banner under the ask "
                        "(added by itself when the task's name or description says so)")

    dd = sub.add_parser("decided",
                        help="close an ANSWERED decision card whose answer is to wait until a date "
                             "(or, with no date, a thin card that must be asked again properly)")
    dd.add_argument("task")
    dd.add_argument("--until", metavar="YYYY-MM-DD",
                    help="park the task until this date; it comes back on the board that day")

    h = sub.add_parser("handover",
                       help="hand an approved task to a named human team member")
    h.add_argument("task")
    h.add_argument("--to", required=True,
                   help="team email; one of " + ", ".join(sorted(HUMANS)))
    h.add_argument("--reason", default="")

    rf = sub.add_parser("roy-followups",
                        help="one weekly follow-up task for Roy's repairs unmoved for 7 days")
    rf.add_argument("--dry-run", action="store_true", help="list the stale repairs, create nothing")

    s = sub.add_parser("submit")
    s.add_argument("task")
    s.add_argument("--agent", required=True)
    s.add_argument("--type", required=True)
    s.add_argument("--output-file", required=True)
    s.add_argument("--plain-task", required=True, metavar="SENTENCE",
                   help="what the task is, one short sentence a thirteen-year-old "
                        "understands; first line of Kevin's card (22 Sep 2026)")
    s.add_argument("--plain-approve", required=True, metavar="SENTENCE",
                   help="what happens the moment Kevin approves, one short plain "
                        "sentence; second line of his card (22 Sep 2026)")
    s.add_argument("--siblings", metavar="recA,recB",
                   help="property work only: the sibling ids the queue grouped under this "
                        "lead (same certificate type and postcode district); refused "
                        "before any write if one does not belong (17 Sep 2026)")
    s.add_argument("--coverage", metavar="PATH",
                   help="quote emails on property tasks: PROPERTY: and CONTRACTOR: ... "
                        "covers ... (source: url) lines; refused without it (7 Sep 2026)")
    s.add_argument("--receipt", metavar="PATH",
                   help="redo only: one line per point Kevin made, "
                        "`- <point> → <what changed>`; refused without it after "
                        "Changes requested (7 Sep 2026)")
    s.add_argument("--attach", action="append", metavar="PATH",
                   help="attach a file to this approval so Kevin can open it "
                        "before deciding (repeat for several): a prepared "
                        "letter, a filled form, a spreadsheet")
    s.add_argument("--tier1", action="store_true",
                   help="task touches the private legal/financial matter: "
                        "stamp the tier-1 banner on top of the Agent Output")

    ca = sub.add_parser("clear-alerts",
                        help="move machine-breakage tasks out of the approval "
                             "queue and onto the board (closes nothing)")
    ca.add_argument("--dry-run", action="store_true")

    hp = sub.add_parser("handover-property",
                        help="hand every property task in Roy's lane to Roy")
    hp.add_argument("--dry-run", action="store_true",
                    help="list what WOULD be handed over and change nothing")

    at = sub.add_parser("attach",
                        help="attach a file to a task already waiting for "
                             "approval")
    at.add_argument("task")
    at.add_argument("--file", required=True, action="append", metavar="PATH")
    at.add_argument("--purpose", default="", help="what the file is for, stamped in Notes with the date")
    hi = sub.add_parser("history",
                        help="the dated record of everything with a contact, reference or "
                             "property: past tasks and Gmail, oldest first (the TRACK RECORD)")
    hi.add_argument("--task", default=None, help="the task being worked (left out of the results)")
    hi.add_argument("--email", action="append", help="contact email (repeatable)")
    hi.add_argument("--ref", action="append", help="reference, policy or account number (repeatable)")
    hi.add_argument("--property", action="append", help="property name or first line (repeatable)")
    hi.add_argument("--from-text", action="append", dest="from_text", metavar="TEXT",
                    help="pull reference-like tokens out of this text (a subject, a letter)")
    hi.add_argument("--days", type=int, default=730)
    hi.add_argument("--no-gmail", action="store_true")
    hi.add_argument("--text", action="store_true", help="print the TRACK RECORD block to paste")

    du = sub.add_parser("due",
                        help="move a task's due date on Kevin's word (Upcoming until then)")
    du.add_argument("task")
    du.add_argument("date", help="YYYY-MM-DD, today or later")
    du.add_argument("--why", required=True, help="the reason, in a sentence")
    du.add_argument("--quote", required=True, help="Kevin's own words from his feedback on the task, verbatim")

    an = sub.add_parser("annotate")
    an.add_argument("task")
    an.add_argument("--note", required=True)

    oc = sub.add_parser("outcome",
                        help="print one task's live approval state as JSON "
                             "(the browser lane's submit gate)")
    oc.add_argument("task")
    i = sub.add_parser("intent")
    i.add_argument("task")

    c = sub.add_parser("complete")
    c.add_argument("task")
    # The approved text is the only place "do not close this" ever appears, so
    # the agent that read it is the one that has to say so here.
    c.add_argument("--keep-open", action="store_true",
                   help="record the carry-out but leave Status untouched")
    c.add_argument("--note", default="",
                   help="what was carried out (goes into Notes with --keep-open)")
    c.add_argument("--no-certificate", default="", metavar="REASON",
                   help="the file that arrived on this task is not a certificate "
                        "(say what it is); recorded in Notes")
    c.add_argument("--evidence", default="",
                   help="what proves the job is done (a merge commit, a receipt); written to Notes "
                        "with the close")

    v = sub.add_parser("verify")
    v.add_argument("--report", required=True)
    v.add_argument("--dry-run", action="store_true",
                   help="the agent's own self-check: same checks, no alarm state written, "
                        "never wrapped; the runner's wrapped call is the control")

    rc = sub.add_parser("reconcile",
                        help="name finished deliverables on disk whose Airtable "
                             "record still has an empty Agent Output")
    rc.add_argument("--runs", type=int, default=3,
                    help="how many recent run directories to inspect")

    rv = sub.add_parser("revise",
                        help="apply Kevin's minor edits to the approved text "
                             "before it is carried out")
    rv.add_argument("task")
    rv.add_argument("--output-file", required=True)

    bk = sub.add_parser("block",
                        help="record the wall an agent hit, with its kind, so the fix is "
                             "routed and the task wakes when it lands")
    bk.add_argument("task")
    bk.add_argument("--kind", required=True, type=str.upper, choices=BLOCK_KINDS)
    bk.add_argument("--subject", required=True,
                    help="SIGN-IN/SITE: the site's host; TOOL: a short name for what is "
                         "broken; KEVIN: " + "|".join(KEVIN_ONLY_REASONS))
    bk.add_argument("--why", required=True, help="what you saw, in one or two sentences")
    bk.add_argument("--finding", help="TOOL only: an existing finding id instead of filing one")
    bk.add_argument("--profile", help="SIGN-IN on a site with one sign-in per profile (Utilita's flats): which one")
    bk.add_argument("--steps", help="KEVIN only, for a step with no website (a cheque, a signature on paper): "
                                    "the numbered written steps he takes, \"1. ... 2. ...\". A website step "
                                    "needs its Your turn plan file instead")

    ub = sub.add_parser("unblock",
                        help="clear a wall with the evidence that the job can go on or is done")
    ub.add_argument("task")
    ub.add_argument("--evidence", required=True)

    bl = sub.add_parser("blockers",
                        help="every open wall; --sweep wakes the tasks whose cause is fixed; "
                             "--check fails on a wall older than 3 days or a task closed while blocked")
    bl.add_argument("--sweep", action="store_true")
    bl.add_argument("--check", action="store_true")

    rt = sub.add_parser("retype",
                        help="correct a task's Task Type; an approved task may only go "
                             "INTO Correspondence, and only when its approved text "
                             "already parses as an email")
    rt.add_argument("task")
    rt.add_argument("--type", required=True)
    rt.add_argument("--reason", required=True)

    sub.add_parser("trial-settle",
                   help="close every approved card of a trial agent as checked: "
                        "Kevin's verdict goes in Notes and nothing is sent")

    sub.add_parser("lessons",
                   help="write every lesson Kevin asked to be remembered into "
                        "the agent files. Deterministic, idempotent, safe to "
                        "run as often as you like")

    lg = sub.add_parser("ledger",
                        help="update (or create) a creditor matter's page in "
                             "the Creditor Plans record book — the ONE write "
                             "path; verify fails any creditor submit whose "
                             "task never passed through it")
    lg.add_argument("task")
    lg.add_argument("--creditor", required=True,
                    help="creditor name as it appears; matching is "
                         "case-insensitive and a page already linked to the "
                         "task wins over a name match")
    lg.add_argument("--status", choices=PLAN_STATUSES)
    lg.add_argument("--next-step",
                    help="where the matter goes next — required on every "
                         "outcome")
    lg.add_argument("--next-date",
                    help="YYYY-MM-DD, ONLY when something is owed back to us "
                         "(a signature, a confirmation, a refund); 'none' "
                         "clears it. A freeze request never gets a date")
    lg.add_argument("--note",
                    help="one line of what was said or done, appended dated "
                         "to the page's history")
    lg.add_argument("--amount", type=float, help="agreed monthly amount")
    lg.add_argument("--entity", help="which entity owes it")
    lg.add_argument("--lane", choices=PLAN_LANES)

    sw = sub.add_parser("signin-waiting",
                        help="tasks blocked on a site sign-in, grouped by site, each site's "
                             "session checked first; a site already signed in is handed "
                             "back on the spot and listed under alreadyLive")
    sw.add_argument("--no-walk", action="store_true",
                    help="list only: never open the robot browser (the keep-alive, tests)")
    sw.add_argument("--dry-run", action="store_true",
                    help="walk and report, but hand nothing back")
    sw.add_argument("--site", default="",
                    help="check this allowlist host only; list the rest unchecked")
    sd = sub.add_parser("signin-done",
                        help="Kevin quit the sign-in window: hand every task "
                             "waiting on that site straight back to its robot")
    sd.add_argument("--site", required=True, help="allowlist host, e.g. app.pingen.com")
    ss = sub.add_parser("signin-site",
                        help="which allowlist host a site name or URL means "
                             "(the Robot sign-in app resolves a card's link with it)")
    ss.add_argument("--url", default="", help="a login URL, e.g. https://www.pingen.com/en/login")
    ss.add_argument("--site", default="", help="a site name, e.g. Companies House")

    sg = sub.add_parser("signed",
                        help="gate 2: a registered document came back signed "
                             "— reopen its task for the raising agent with "
                             "the signed PDF and the next step")
    sg.add_argument("task")
    sg.add_argument("--agreement", required=True)
    sg.add_argument("--pdf", required=True, help="the signed PDF on disk")
    sg.add_argument("--then", required=True, help="post | email")

    cg = sub.add_parser("certificate-gaps",
                        help="read-only: compliance payments with no certificate "
                             "filed; with --property/--type, whether buying is blocked")
    cg.add_argument("--property", default="", help="Properties record id")
    cg.add_argument("--type", default="", help="book type: GSC, EICR, EPC, Landlord Insurance")

    ct = sub.add_parser("certificate",
                        help="file a certificate, licence or insurance policy "
                             "on the Property Certificates table — the ONE "
                             "write path; refuses without property, type, "
                             "renewal date AND the document")
    ct.add_argument("task", help="the task this filing closes")
    ct.add_argument("--property", required=True,
                    help="Properties record id (rec...)")
    ct.add_argument("--type", required=True,
                    help="one of " + ", ".join(CERT_TYPES))
    ct.add_argument("--renewal", required=True,
                    help="YYYY-MM-DD the certificate or policy runs out")
    ct.add_argument("--file", required=True,
                    help="the document itself (PDF/JPG/PNG, under 5MB)")
    ct.add_argument("--unit", help="Rental Unit record id, for a unit-level "
                                   "certificate in a block")
    ct.add_argument("--note", help="one line: who issued it, policy number")

    args = p.parse_args()
    # RETURN the handler's exit code. It used to be discarded, so a command that
    # signalled failure by returning 1 still exited 0 and every caller read it
    # as success. Nothing looked wrong because the handlers that refuse do it by
    # calling sys.exit() — but `reconcile` and `lessons` report by RETURNING, so
    # discarding the result here would make both checks ornamental.
    return {"queue": cmd_queue, "route": cmd_route, "escalate": cmd_escalate, "decided": cmd_decided,
            "handover": cmd_handover, "submit": cmd_submit_group, "roy-followups": cmd_roy_followups,
            "annotate": cmd_annotate, "due": cmd_due, "intent": cmd_intent,
            "complete": cmd_complete, "verify": cmd_verify,
            "score": cmd_score, "reconcile": cmd_reconcile,
            "lessons": cmd_lessons, "trial-settle": cmd_trial_settle, "revise": cmd_revise, "retype": cmd_retype,
            "block": cmd_block, "unblock": cmd_unblock, "blockers": cmd_blockers,
            "attach": cmd_attach, "outcome": cmd_outcome,
            "reassign": cmd_reassign, "ledger": cmd_ledger,
            "signed": cmd_signed, "signin-waiting": cmd_signin_waiting, "signin-done": cmd_signin_done, "signin-site": cmd_signin_site, "history": cmd_history, "certificate": cmd_certificate, "certificate-gaps": cmd_certificate_gaps,
            "handover-property": cmd_handover_property,
            "clear-alerts": cmd_clear_alerts}[args.cmd](args) or 0


if __name__ == "__main__":
    sys.exit(main())
