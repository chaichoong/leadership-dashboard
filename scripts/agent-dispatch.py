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
  escalate TASKID             hand a task OFF the AI agents to Kevin. Team
                              Member and Assignee become Kevin, so the queue
                              stops seeing it as agent work. NOT the tier-1
                              exit any more — tier 1 is prepared and labelled
                              like anything else. This is for the rarer case
                              where no agent can usefully prepare anything.
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
from agent_email_format import (  # noqa: E402
    CARRY_OUT_MARKER,
    CARRY_OUT_RE,
    CARRY_OUT_TAIL_MAX,
    TIER1_BANNER,
    EmailFormatError,
    parse_output as parse_email_output,
    validate_submission as validate_email_submission,
    validate_submission_any as validate_any_submission,
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
    # Kevin's ruling, 25 Aug 2026: no NEW routing to Mica or Ericamae — their
    # entries stay ONLY so an explicit Kevin-ordered handover still lands on a
    # real row instead of failing into a typo'd address.
    "micaa.work@gmail.com":    {"rec": "rec4b5MDoaxEC7WRE", "name": "Mica Albovias"},
    "atentaerica@gmail.com":   {"rec": "recEvm9wgsEnoNVZh", "name": "Ericamae Atenta"},
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
}

TASK_TYPES = ("Drafting", "Research", "Analysis", "Build",
              "Audit", "Admin", "Correspondence")
APPROVED = ("Approved as-is", "Approved with minor edits")
OPEN_STATUSES = ("Today", "Overdue")

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
AGENTS = {
    "reciHUAEcEkbctnZ6": {"name": "AI CEO (Dan Martell)",                    "agent": "od-ceo",                "role": "ceo"},
    "rec27NaJB7JNLaBB0": {"name": "AI HR & People (Patrick Lencioni)",       "agent": "dept-hr",               "role": "head"},
    "recCzAdg2rO8bha9A": {"name": "AI Wealth (Robert Kiyosaki)",             "agent": "dept-wealth",           "role": "head"},
    "recFZ1ofn0OuoZNEr": {"name": "AI Strategy (Gary Keller)",               "agent": "dept-strategy",         "role": "head"},
    "recGvMnprGf1hr9Z1": {"name": "AI Finance (Greg Crabtree)",              "agent": "dept-finance",          "role": "head"},
    "recMKExCwu0ulMBMG": {"name": "AI Productivity (Chris Bailey)",          "agent": "dept-productivity",     "role": "head"},
    "recRStFWWEyHgOD6t": {"name": "AI Operations (Gino Wickman)",            "agent": "dept-operations",       "role": "head"},
    "recSvV7a47ze9i5X9": {"name": "AI Legal & Compliance (Keith Cunningham)","agent": "dept-legal-compliance", "role": "head"},
    "recYD7avVxouIkH5b": {"name": "AI Systemisation (Dave Jenyns)",          "agent": "dept-systemisation",    "role": "head"},
    "recZlgKJZn7xsBfoz": {"name": "AI Mindset (John F. DeMartini)",          "agent": "dept-mindset",          "role": "head"},
    "reciAJnPnFEbj5FhX": {"name": "AI Marketing (Alex Hormozi)",             "agent": "dept-marketing",        "role": "head"},
    "recpCz18pCLCUf3oJ": {"name": "AI Sales (Jordan Belfort)",               "agent": "dept-sales",            "role": "head"},
    "recFMVmHmqAOVPAeJ": {"name": "AI Worker — Writer",                      "agent": "worker-writer",         "role": "worker"},
    "recPVA1CgGyyGcBd9": {"name": "AI Worker — Auditor",                     "agent": "worker-auditor",        "role": "worker"},
    "recQkO6BA4w5zqwZ4": {"name": "AI Worker — Builder",                     "agent": "worker-builder",        "role": "worker"},
    "recbHvWqlQBbunF2F": {"name": "AI Worker — Researcher",                  "agent": "worker-researcher",     "role": "worker"},
    "recqmKBmq8ZGkxVH9": {"name": "AI Worker — Analyst",                     "agent": "worker-analyst",        "role": "worker"},
}
CEO_REC_ID = "reciHUAEcEkbctnZ6"
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
    "recJ8J8idWE8d97tH": {"name": "AI Inbound Comms Response",
                          "agent": "inbound-comms-response", "role": "worker",
                          "registerRow": "recHfhVDb6BfQYco5"},
    "recjh6mmaF8KJW8t3": {"name": "AI Creditor Management",
                          "agent": "creditor-management", "role": "worker",
                          "registerRow": "recDvxwDGcC3pFbPa"},
    "rec1hYELb4zS8pjjO": {"name": "AI Task Manager",
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
    "recCUfsTXzmVZynEI": {"name": "AI Inbound Comms Triage",
                          "agent": "inbound-comms-triage", "role": "worker",
                          "registerRow": "recYy33zkoa099uM2",
                          "dispatch": False},
    # Content Engine (build 2-3 Sep 2026): the Runpreneur 360 lane. Runs on its
    # own Go Signal (02:00 nightly, scripts/content-engine-run.sh) and raises
    # one approval card per finished episode through `submit`, so it must be
    # in this dict; `dispatch: False` because the CEO pass must never hand it
    # work — its work arrives as raw clips, not tasks. Lessons land in
    # ~/.claude/agents/content-engine.md and both of its Claude calls read them.
    "recRcy1Edas6rGaaF": {"name": "AI Content Engine",
                          "agent": "content-engine", "role": "worker",
                          "registerRow": "recNaC0N5KiTGBPNy",
                          "dispatch": False},
}
ALL_AGENTS = {**AGENTS, **ROLE_AGENTS}

# Derived aliases — single source is ROLE_AGENTS above.
RESPONSE_REC_ID = "recJ8J8idWE8d97tH"          # Team Members row
CREDITOR_REC_ID = "recjh6mmaF8KJW8t3"          # Team Members row
TASKMGR_REC_ID = "rec1hYELb4zS8pjjO"           # Team Members row
PROPERTY_REC_ID = "recwWvBju2ycB63i4"          # Team Members row
RESPONSE_REGISTER_ROW = ROLE_AGENTS[RESPONSE_REC_ID]["registerRow"]
CREDITOR_REGISTER_ROW = ROLE_AGENTS[CREDITOR_REC_ID]["registerRow"]
TASKMGR_REGISTER_ROW = ROLE_AGENTS[TASKMGR_REC_ID]["registerRow"]
PROPERTY_REGISTER_ROW = ROLE_AGENTS[PROPERTY_REC_ID]["registerRow"]

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
# ROLE_AGENTS above): it is the board foreman — its own 09:00/13:00/17:00
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
        return
    atts = (get_task(task_id).get("fields", {}) or {}).get(AF["attachments"]) or []
    keep = [{"id": a["id"]} for a in atts if a.get("filename") not in filenames]
    if len(keep) != len(atts):
        patch_task(task_id, {AF["attachments"]: keep})


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
    r"|\bKEVIN\s+ACTION\s*:\s*(?:please\s+)?(?:log|sign|call|phone|ring)\b",
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
SEND_LANGUAGE_RE = re.compile(
    r"\b(?:"
    r"send(?:s|ing)?\s+(?:the\s+|this\s+|an?\s+)?(?:email|e-mail|letter|reply|message)"
    r"|email(?:s|ing)?\s+(?:it|the|this|them|him|her)"
    r"|from\s+Kevin'?s\s+Gmail"
    r"|sent\s+(?:from|to)\s+[^\s@]+@[^\s@]+"
    r")\b", re.I)


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
    found = SEND_LANGUAGE_RE.search(closing)
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
        # Expanded here so a REDO gets the spoken instruction, not a bare URL.
        # No Loom link means no network call — this is a regex miss on almost
        # every task.
        "feedback": expand_looms(f.get(AF["approvalFeedback"], "")),
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

def build_queue(args=None):
    """Classify the open board. Returns the queue dict, prints nothing.

    Split out of cmd_queue on 28 Aug 2026 so `handover-property` classifies
    with the SAME code the run reads. Two classifiers would be two answers to
    "is this Roy's", and the one that writes must be the one Kevin saw.
    """
    formula = "OR({Status}='Today',{Status}='Overdue')"
    open_tasks = [task_view(r) for r in query_tasks(formula)]

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
    if not agent_linked and not handback_population:
        print("ERROR: control failed — zero tasks linked to any AI agent and "
              "zero tasks with an approval outcome. The read is broken, not "
              "the queue empty.", file=sys.stderr)
        sys.exit(1)

    tier1, skipped_tier2, unmapped, unclassified = [], [], [], []
    system_alerts = []
    roy_lane = []
    approved_hb, changes_hb, new_work, routing = [], [], [], []
    creditor_ok = bool(role_roster.get(CREDITOR_REC_ID, {}).get("dispatchable"))
    creditor_count = 0
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

    for t in agent_linked:
        # Tier 1 no longer drops out of the worklist. It is MARKED and worked,
        # and the mark rides all the way to the Slack post. Removing this line
        # so tier-1 work is prepared silently is the regression to fear.
        hit1 = tier_match(TIER1_PATTERNS, t["name"], t["description"], t["notes"])
        t["tier1"] = bool(hit1)
        t["matchedPattern"] = hit1 or ""
        if hit1:
            tier1.append(t)
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
        hit_alert = system_alert_match(
            t.get("inboundSender"), t["name"], t["description"], t["notes"])
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
        t["property"] = ("" if (t["tier1"] or t["creditor"] or not property_ok) else
                         property_match(t["name"], t["description"], t["notes"]))
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
        if hit_roy:
            roy_lane.append({**t, "royReason": hit_roy})
            continue
        if not t["localAgent"]:
            unmapped.append(t)
            continue
        # agentId (Sent For Approval By, falling back to Team Member) decides
        # hand-backs: the drawer's decide path sets both, but an approved task
        # missing Sent For Approval By must still be carried out, not lost.
        if t["outcome"] in APPROVED and t["agentId"]:
            approved_hb.append(t)
        elif t["outcome"] == "Changes requested":
            changes_hb.append(t)
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
        # Property work for Roy. Diverted and NAMED, never dropped — and not
        # acted on here: cmd_queue is a read. `handover-property` does the
        # writing, so one command owns the change.
        "royLane": roy_lane,
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
        "counts": {
            "openTasksRead": len(open_tasks),
            "agentLinkedOpen": len(agent_linked),
            "approvedHandbacks": len(approved_hb),
            "changesRequested": len(changes_hb),
            # Redos Kevin asked to delay. Demoted behind new work rather than
            # dropped, and counted here so one sitting for weeks stays visible.
            "deferredRedos": len(deferred_hb),
            "newWork": len(new_work),
            # A tier-2 park removes a task from every other bucket via
            # `continue`, so newWork read 0 while an agent-linked, no-outcome,
            # Urgent task sat open (finding 20260812-agent-dispatch-111). A
            # count makes the park visible in the same object that reports the
            # emptiness it causes.
            "tier2Parked": len(skipped_tier2),
            "systemAlerts": len(system_alerts),
            "royLane": len(roy_lane),
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


def cmd_route(args):
    if args.to not in ALL_AGENTS:
        sys.exit(f"ERROR: {args.to} is not a dispatchable AI agent record "
                 "(one of the 17 strategic agents or a built role agent)")
    if args.to == CEO_REC_ID:
        sys.exit("ERROR: routing back to the CEO is not a route")
    require_role_agent_live(args.to, "route")
    patch_task(args.task, {AF["teamMember"]: [args.to]})
    print(json.dumps({"routed": args.task, "to": args.to,
                      "agent": ALL_AGENTS[args.to]["name"]}))


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
    notes = str(tf.get(AF["notes"]) or "")
    bounces = reassign_bounces(notes)
    if bounces >= REASSIGN_MAX:
        sys.exit(
            f"ERROR: {args.task} has already gone back to the CEO "
            f"{bounces} times. Escalate it to Kevin instead:\n"
            f"         python3 scripts/agent-dispatch.py escalate {args.task}\n"
            "       A task nobody can place is a decision for him, not "
            "another lap of the routing loop.")
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
        if block not in hist:
            fields[AF["feedbackHistory"]] = (hist.rstrip() + "\n\n" + block).strip()
    patch_task(args.task, fields)
    print(json.dumps({"reassigned": args.task, "to": "AI CEO (Dan Martell)",
                      "reason": args.reason, "priorBounces": bounces}))


def cmd_escalate(args):
    # The tier-1 exit. A keyword skip only lasts one run: the task stays linked
    # to an agent and comes back round every time. This moves it off the agents
    # for good, without touching Status, due date or anything Kevin decides.
    patch_task(args.task, {
        AF["teamMember"]: [KEVIN_REC_ID],
        AF["assignee"]: {"email": KEVIN_AIRTABLE_EMAIL},
    })
    print(json.dumps({"escalated": args.task, "to": "Kevin Brittain"}))


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
    # Tier-1 gate (25 Aug 2026, Task Manager build review): a handover to
    # anyone but Kevin moves the task OUT of the agent queue and DMs the new
    # owner, so tier-1 content (creditor, legal, courts, HMRC, the live legal
    # matter) may only leave through it after Kevin has approved that exact
    # reassignment. Roy's standing approval covers maintenance, and genuine
    # maintenance never trips these patterns — prose rules in a skill are not
    # a gate, this is.
    tf = t.get("fields", {})
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
    patch_task(args.task, {
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
        hit = system_alert_match(t.get("inboundSender"), t["name"],
                                 t["description"], t["notes"])
        if not hit:
            continue
        # Tier 1 never moves silently, whatever it looks like. A monitoring
        # address is not a reason to skip the gate that protects the legal
        # matter.
        if tier_match(TIER1_PATTERNS, t["name"], t["description"], t["notes"]):
            skipped.append({"task": t["id"], "name": t["name"],
                            "why": "tier 1 — left with Kevin on purpose"})
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
    supersede_attachments(args.task, {os.path.basename(p) for p in args.file})
    names = [upload_attachment(args.task, p) for p in args.file]
    print(json.dumps({"task": args.task, "attached": names}))


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
    if args.tier1 and TIER1_BANNER not in output:
        output = TIER1_BANNER + "\n\n" + output

    # Kevin's mandate. Checked AFTER the banner so a tier-1 submit is judged on
    # the text that will actually be stored, and refused rather than patched:
    # a fabricated closing line would be the very guesswork this removes.
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
    alert_hit = system_alert_match(
        tf_probe.get(AF["inboundSender"], ""),
        tf_probe.get(AF["name"], ""), tf_probe.get(AF["description"], "") or "",
        tf_probe.get(AF["notes"], "") or "")
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
    tf = (get_task(args.task).get("fields", {}) or {})
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
        if block not in hist:
            archived = (hist.rstrip() + "\n\n" + block).strip()

    # The files go up FIRST. If one is refused the run stops here with the
    # task still unsubmitted — better than an approval card promising a
    # letter that never arrived.
    # getattr, not args.attach: cmd_submit is called with hand-built args in
    # seventeen tests and any internal caller, none of which know about a flag
    # added later. A new optional flag must never make an existing caller crash.
    to_attach = list(getattr(args, "attach", None) or [])
    supersede_attachments(args.task, {os.path.basename(p) for p in to_attach})
    for path in to_attach:
        upload_attachment(args.task, path)

    if informational_only(output, args.type, tier1=bool(getattr(args, "tier1", False))):
        stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
        note = (f"[{stamp} — agent-dispatch] FILED, not queued: the closing line "
                f"says nothing happens on approval, so there is no decision here "
                f"(Kevin's ruling, 4 Sep 2026). The report is in Agent Output.")
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
        }
        # Attachments were uploaded above, once; never again here.
        patch_task(args.task, filed)
        print(json.dumps({"submitted": args.task, "filed": True, "status": "Completed",
                          "type": args.type, "attached": len(to_attach),
                          "why": "informational output: nothing to approve"}))
        return 0

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
    if signin_wait:
        fields[AF["deferredUntil"]] = tomorrow_london()
    if archived:
        fields[AF["feedbackHistory"]] = archived
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
    t = get_task(args.task)
    existing = t.get("fields", {}).get(AF["notes"], "")
    stamp = datetime.now(LONDON).strftime("%d %b %Y")
    note = f"[{stamp} — agent] {args.note}"
    patch_task(args.task, {
        AF["notes"]: (existing + "\n\n" + note).strip(),
    })
    print(json.dumps({"annotated": args.task, "chars": len(note)}))


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
    someone added a section below, which silently orphaned every new lesson."""
    start = text.find(LESSONS_HEADING)
    if start == -1:
        return None
    body = start + len(LESSONS_HEADING)
    nxt = re.search(r"^## ", text[body:], re.M)
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

    written, problems = [], []
    for rec in pending_lessons():
        f = rec.get("fields", {})
        task_id = rec["id"]
        name = f.get(AF["name"], "")
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

    out = {"written": written, "problems": problems,
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
    print(json.dumps({
        "id": t["id"],
        "name": t["name"],
        "status": t["status"],
        "outcome": t["outcome"],
        "approved": t["outcome"] in APPROVED,
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
    if SIGNED_MARK in notes and args.agreement in notes:
        print(json.dumps({"task": args.task, "reopened": False,
                          "reason": "already handed off"}))
        return 0
    if not os.path.exists(args.pdf):
        sys.exit(f"ERROR: signed PDF not found at {args.pdf}; refusing to "
                 "hand off a document that is not on disk.")
    team = links(tf.get(AF["teamMember"])) or links(tf.get(AF["sentForApprovalBy"]))
    if not team:
        sys.exit(f"ERROR: {args.task} has no agent on it; a signed document "
                 "with nobody to carry it is exactly the miss this exists to stop.")
    stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
    note = signed_handoff_note(stamp, args.agreement, args.pdf, args.then)
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
    print(json.dumps({"task": args.task, "reopened": True,
                      "agent": ALL_AGENTS.get(team[0], {}).get("agent", team[0]),
                      "then": args.then, "pdf": args.pdf}))
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
SIGNIN_LINE_RE = re.compile(r"^\s*SIGN-IN NEEDED:\s*(?P<site>.+?)\s*(?:\((?P<url>https?://[^\s)]+)\))?\s*$", re.I | re.M)
SIGNIN_DONE_MARK = "SIGNED IN:"
KEEPALIVE_MARK = "KEEPALIVE CHECK:"


def load_login_sites():
    """The allowlist as agent-browser.js sees it (builtins + sites.json),
    read through the script itself so the two never drift."""
    import subprocess, glob, shutil
    # launchd and AppleScript's `do shell script` have no nvm on PATH; the
    # runners export AGENT_NODE_BIN (agent-tools.sh), and the nvm glob is the
    # same second resort that file uses.
    node = (os.environ.get("AGENT_NODE_BIN") or shutil.which("node")
            or (sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/node"))) or [None])[-1])
    if not node:
        raise RuntimeError("node not found: no AGENT_NODE_BIN, not on PATH, no nvm install")
    r = subprocess.run([node, os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent-browser.js"), "sites"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("agent-browser.js sites failed: " + (r.stderr or "")[:200])
    return json.loads(r.stdout)


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
        return best
    want = (line_site or "").strip().lower()
    for h, v in sites.items():
        lab = str(v.get("label") or "").lower()
        if want and (want == lab or want in lab or lab.split(" (")[0] == want):
            return h
    for h in sites:
        if want and want.replace(" ", "") in h.replace(".", ""):
            return h
    return None


def signin_waiting(sites=None):
    """Every approval-queue task blocked on a sign-in, grouped by site."""
    sites = sites if sites is not None else load_login_sites()
    # FIND is case-sensitive; the line is written by an agent, so match on UPPER.
    recs = query_tasks("AND({Status}='Approval', FIND('SIGN-IN NEEDED', UPPER({Agent Output})))")
    groups = {}
    for rec in recs:
        f = rec.get("fields", {}) or {}
        m = SIGNIN_LINE_RE.search(str(f.get(AF["agentOutput"]) or ""))
        if not m:
            continue
        host = signin_site_for(m.group("site"), m.group("url"), sites) or "unknown"
        entry = sites.get(host, {})
        g = groups.setdefault(host, {"host": host, "label": entry.get("label") or m.group("site").strip(),
                                     "loginUrl": entry.get("loginUrl") or m.group("url") or "", "tasks": []})
        g["tasks"].append({"id": rec["id"], "name": f.get(AF["name"], ""),
                           "agent": ALL_AGENTS.get((links(f.get(AF["teamMember"])) or [None])[0], {}).get("agent", "")})
    return sorted(groups.values(), key=lambda g: (-len(g["tasks"]), g["label"]))


def cmd_signin_waiting(args):
    print(json.dumps({"sites": signin_waiting(), "at": now_iso()}, indent=2))
    return 0


def cmd_signin_done(args):
    """Kevin quit the sign-in window for HOST: hand its waiting tasks back."""
    sites = load_login_sites()
    host = signin_site_for("", "https://" + args.site + "/", sites) or signin_site_for(args.site, "", sites)
    if not host:
        sys.exit(f"ERROR: {args.site!r} is not a login site on the allowlist")
    stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
    handed = []
    for g in signin_waiting(sites):
        if g["host"] != host:
            continue
        for t in g["tasks"]:
            rec = get_task(t["id"])
            f = rec.get("fields", {}) or {}
            team = links(f.get(AF["teamMember"])) or links(f.get(AF["sentForApprovalBy"]))
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
                    f"{g['label']}. The session is live now: carry on from where you stopped "
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
    print(json.dumps({"site": host, "label": sites[host].get("label"), "handedBack": handed}, indent=2))
    return 0


def cmd_complete(args):
    t = task_view(get_task(args.task))
    if t["outcome"] not in APPROVED:
        sys.exit(f"ERROR: refusing to complete {args.task} — outcome is "
                 f"'{t['outcome'] or 'empty'}', not an approval. Only "
                 "approved, carried-out work completes.")

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

    patch_task(args.task, {
        AF["status"]: "Completed",
        AF["completion"]: now_iso(),
    })
    ledger_append(args.task, "done")
    print(json.dumps({"completed": args.task}))


# ─── VERIFY (the control run-job.sh wraps) ────────────────────────────

def cmd_verify(args):
    try:
        with open(args.report) as fh:
            report = json.load(fh)
    except Exception as e:
        print(f"ERROR: run report unreadable ({e}) — the run was blind",
              file=sys.stderr)
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

    # The rule this control exists for: work existed and the run did none.
    if counts.get("worklist", 0) > 0 and not ok_actions:
        problems.append(
            f"{counts['worklist']} eligible tasks and ZERO completed actions")
    for a in failed:
        problems.append(f"action failed: {a.get('kind')} {a.get('task')} — "
                        f"{str(a.get('error'))[:120]}")

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
    if flags:
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
                and ENGINE_RENEWAL_MARK in str(live["description"] or "")):
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
            if live["status"] in OPEN_STATUSES and not live["outcome"]:
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
                      "worklistAtStart": counts.get("worklist", 0)}))


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
SCORE_AGENT_NAMES = {"response": "Inbound Comms Response",
                     "creditor": "Creditor Management",
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
    field: nothing deployed flips a future-dated Upcoming task into the
    Today/Overdue window the queue reads ("When Due Date is updated, adjust
    the Status" exists but is undeployed), and an API completion would not
    roll the cadence forward. The engine runs several times daily, so the
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
        "hasFile": bool(f.get(CERT_FIELDS["attachments"])),
        "taskIds": links(f.get(CERT_FIELDS["tasks"])),
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

    e = sub.add_parser("escalate")
    e.add_argument("task")

    h = sub.add_parser("handover",
                       help="hand an approved task to a named human team member")
    h.add_argument("task")
    h.add_argument("--to", required=True,
                   help="team email; one of " + ", ".join(sorted(HUMANS)))
    h.add_argument("--reason", default="")

    s = sub.add_parser("submit")
    s.add_argument("task")
    s.add_argument("--agent", required=True)
    s.add_argument("--type", required=True)
    s.add_argument("--output-file", required=True)
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

    v = sub.add_parser("verify")
    v.add_argument("--report", required=True)

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
                        help="tasks blocked on a site sign-in, grouped by site "
                             "(the morning list and the queue page strip)")
    sd = sub.add_parser("signin-done",
                        help="Kevin quit the sign-in window: hand every task "
                             "waiting on that site straight back to its robot")
    sd.add_argument("--site", required=True, help="allowlist host, e.g. app.pingen.com")

    sg = sub.add_parser("signed",
                        help="gate 2: a registered document came back signed "
                             "— reopen its task for the raising agent with "
                             "the signed PDF and the next step")
    sg.add_argument("task")
    sg.add_argument("--agreement", required=True)
    sg.add_argument("--pdf", required=True, help="the signed PDF on disk")
    sg.add_argument("--then", required=True, help="post | email")

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
    return {"queue": cmd_queue, "route": cmd_route, "escalate": cmd_escalate,
            "handover": cmd_handover, "submit": cmd_submit,
            "annotate": cmd_annotate, "intent": cmd_intent,
            "complete": cmd_complete, "verify": cmd_verify,
            "score": cmd_score, "reconcile": cmd_reconcile,
            "lessons": cmd_lessons, "revise": cmd_revise,
            "attach": cmd_attach, "outcome": cmd_outcome,
            "reassign": cmd_reassign, "ledger": cmd_ledger,
            "signed": cmd_signed, "signin-waiting": cmd_signin_waiting, "signin-done": cmd_signin_done, "certificate": cmd_certificate,
            "handover-property": cmd_handover_property,
            "clear-alerts": cmd_clear_alerts}[args.cmd](args) or 0


if __name__ == "__main__":
    sys.exit(main())
