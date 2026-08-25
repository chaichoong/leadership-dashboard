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
import json
import os
import re
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
)

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

# Field IDs — single source is js/config.js; drift-tested, never guess.
AF = {
    "name":              "fldgFjGBw6bTKJFCD",
    "description":       "fldRGhBQViKZKtkQ6",
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
}
ALL_AGENTS = {**AGENTS, **ROLE_AGENTS}

# Derived aliases — single source is ROLE_AGENTS above.
RESPONSE_REC_ID = "recJ8J8idWE8d97tH"          # Team Members row
CREDITOR_REC_ID = "recjh6mmaF8KJW8t3"          # Team Members row
TASKMGR_REC_ID = "rec1hYELb4zS8pjjO"           # Team Members row
RESPONSE_REGISTER_ROW = ROLE_AGENTS[RESPONSE_REC_ID]["registerRow"]
CREDITOR_REGISTER_ROW = ROLE_AGENTS[CREDITOR_REC_ID]["registerRow"]
TASKMGR_REGISTER_ROW = ROLE_AGENTS[TASKMGR_REC_ID]["registerRow"]

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
AUTO_ROUTES = (
    {"rec": CREDITOR_REC_ID,
     "fresh": lambda t: t["creditor"] and t["inboundTask"],
     "steal": lambda t, tm: t["creditor"] and (
         tm == RESPONSE_REC_ID or t["tier2Correspondence"])},
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
            "dispatchable": tm[0] in ROLE_AGENTS
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


def carry_out_problem(output):
    """Reason the approval box would have to guess this output's summary.

    Empty string means the output is fine. See CARRY_OUT_MARKER above.
    """
    text = (output or "").strip()
    if len(text) < SUMMARY_MIN_CHARS:
        return ""
    m = CARRY_OUT_RE.search(text)
    if not m:
        return "it has no '%s' line" % CARRY_OUT_MARKER
    tail = text[m.end():].strip()
    if not tail:
        return "its '%s' line says nothing" % CARRY_OUT_MARKER
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
        "feedback": f.get(AF["approvalFeedback"], ""),
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
    }


def sort_key(t):
    return (t["status"] != "Overdue", t["dueDate"] or "9999",
            -float(t["urgencyScore"] or 0))


# ─── QUEUE ────────────────────────────────────────────────────────────

def cmd_queue(args):
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
    approved_hb, changes_hb, new_work, routing = [], [], [], []
    creditor_ok = bool(role_roster.get(CREDITOR_REC_ID, {}).get("dispatchable"))
    creditor_count = 0

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
    print(json.dumps(out, indent=2))


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
    if not entry or not entry.get("dispatchable"):
        status = (entry or {}).get("status", "no register row")
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
        AF["notes"]: (existing + "\n\n" + note).strip(),
    })
    print(json.dumps({"handedOver": args.task, "to": args.to,
                      "name": who["name"], "reason": reason}))


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

    # A Correspondence submit is a promise that send-email.py can carry the
    # action out. Validate with the SAME parser the send gate uses, or the
    # promise is only discovered to be false days later, after Kevin has
    # approved it (finding 20260811-agent-dispatch-085, task recFdEICxHjYCzDkS).
    if args.type == "Correspondence":
        try:
            parse_email_output(output)
        except EmailFormatError as exc:
            sys.exit(
                f"ERROR: refusing to submit {args.task} as Correspondence — {exc}\n"
                "       Agent Output must be TO:/CC:/FROM:/SUBJECT: headers, a\n"
                "       `---` line, then the body. See scripts/send-email.py.\n"
                "       An approved email that cannot be sent is worse than a\n"
                "       refused draft: the refusal arrives after the decision."
            )

    # WHO approves. The task's Approver field decides (set by Inbound Comms at
    # creation: label 8 = Mica, label 12 = Kevin); empty means Kevin. Tier 1
    # ALWAYS diverts to Kevin whatever the field says — his private legal and
    # financial matters never route to the team. The banner check catches a
    # tier-1 connection the agent only discovered while working, and the
    # pattern re-check catches a dispatcher that forgot --tier1.
    approver_email = KEVIN_AIRTABLE_EMAIL
    is_tier1 = bool(args.tier1) or TIER1_BANNER in output
    if not is_tier1:
        t = get_task(args.task)
        tf = t.get("fields", {}) or {}
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
    print(json.dumps({"submitted": args.task,
                      "agent": ALL_AGENTS[args.agent]["name"],
                      "type": args.type, "tier1": is_tier1,
                      "approver": approver_email,
                      "chars": len(output)}))


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


def cmd_intent(args):
    # Called BEFORE a carry-out is dispatched. If the run dies between the
    # action happening and `complete`, the next run sees the open intent and
    # verifies instead of executing the approved action a second time.
    ledger_append(args.task, "intent")
    print(json.dumps({"intentRecorded": args.task}))


def cmd_complete(args):
    t = task_view(get_task(args.task))
    if t["outcome"] not in APPROVED:
        sys.exit(f"ERROR: refusing to complete {args.task} — outcome is "
                 f"'{t['outcome'] or 'empty'}', not an approval. Only "
                 "approved, carried-out work completes.")

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
    for a in ok_actions:
        try:
            live = task_view(get_task(a["task"]))
        except Exception as e:
            problems.append(f"could not re-read {a.get('task')}: {e}")
            continue
        kind = a.get("kind")
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

    if problems:
        for p in problems:
            print(f"ERROR: {p}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps({"ok": True,
                      "actionsVerified": len(ok_actions),
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


def write_register_reading(label, register_row, state_path, reading, stats,
                           state_extra=None):
    """The one change-gated register write every role agent's score uses.
    Fifteen agents are seeded in the register; each build session adds a
    reading function, never another copy of this write."""
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
    write_register_reading("creditor", CREDITOR_REGISTER_ROW,
                           CREDITOR_SCORE_STATE,
                           cov_frag + "; " + cost_frag,
                           {**cov_stats, **cost_stats}, extra)


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
        _request("POST", f"/{TASKS}", {"typecast": True, "fields": {
            REVIEW_TASK_FIELDS["name"]: REVIEW_TASK_NAME,
            REVIEW_TASK_FIELDS["status"]: "Today",
            REVIEW_TASK_FIELDS["due"]: now.strftime("%Y-%m-%d"),
            REVIEW_TASK_FIELDS["team"]: [CREDITOR_REC_ID],
            REVIEW_TASK_FIELDS["approver"]: {"id": KEVIN_APPROVER_USR},
            REVIEW_TASK_FIELDS["priority"]: "High",
            REVIEW_TASK_FIELDS["estimate"]: "30 min",
            REVIEW_TASK_FIELDS["desc"]: (
                "Weekly fixed-cost review (raised automatically each Monday "
                "by agent-dispatch). Follow the ordered review steps in the "
                "Creditor Management agent's register row: read active "
                "costs, flag rises above 10% or £10/mo, duplicates, and "
                "costs with no matching transaction in 90 days; every "
                "saving of £5/mo or more becomes its own recommendation "
                "with the monthly saving quantified. Prepare-only — no "
                "record changes without Kevin's approval."),
        }})
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(CREDITOR_REVIEW_STATE, "w") as fh:
        json.dump({"week": week, "raisedAt": now_iso(),
                   "existing": bool(existing)}, fh)
    print(json.dumps({"agent": "creditor", "weeklyReview": week,
                      "created": not existing}))


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


# One row per per-agent housekeeping step the score command runs. A new role
# agent's build session adds its reading function and ONE entry here — never
# another copy of the loop or the change-gated register write (that is
# write_register_reading). Selftests ride in the parallel tuple so
# `score --selftest` can never silently skip a new agent's maths.
SCORE_STEPS = (
    ("response", response_score),
    ("creditor", creditor_score),
    ("weekly-review", ensure_weekly_review),
)
SCORE_SELFTESTS = (response_score_selftest, creditor_score_selftest)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("queue")

    sc = sub.add_parser("score",
                        help="compute the Inbound Comms Response 24h metric "
                             "and the Creditor Management ledger reading, "
                             "and write each to its register Metric Score")
    sc.add_argument("--selftest", action="store_true",
                    help="run the offline maths checks, no Airtable access")

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
    s.add_argument("--tier1", action="store_true",
                   help="task touches the private legal/financial matter: "
                        "stamp the tier-1 banner on top of the Agent Output")

    an = sub.add_parser("annotate")
    an.add_argument("task")
    an.add_argument("--note", required=True)

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

    args = p.parse_args()
    {"queue": cmd_queue, "route": cmd_route, "escalate": cmd_escalate,
     "handover": cmd_handover, "submit": cmd_submit, "annotate": cmd_annotate,
     "intent": cmd_intent, "complete": cmd_complete,
     "verify": cmd_verify, "score": cmd_score}[args.cmd](args)


if __name__ == "__main__":
    main()
