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
  complete TASKID             after the approved action has been carried out.
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
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# The Correspondence contract and the tier-1 banner live in one place, shared
# with scripts/send-email.py. Two copies is how submit came to accept an output
# the send gate could not parse.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_email_format import (  # noqa: E402
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
CARRY_OUT_MARKER = "**Carrying this out will involve:**"
CARRY_OUT_RE = re.compile(r"\*{0,2}carrying this out will involve:?\*{0,2}", re.I)

# apvSummary shows no separate summary below this length: a short output is
# readable at a glance and repeating it twice helps nobody. Demanding a closing
# line there would refuse submits for no gain, so the mandate starts here.
SUMMARY_MIN_CHARS = 280

# What the approval box will show of the line. More than this and the line is
# not a closing line — it is the middle of the document.
SUMMARY_MAX_CHARS = 400

LONDON = ZoneInfo("Europe/London")
KEVIN_AIRTABLE_EMAIL = "kevin@runpreneur.org.uk"
# Kevin's own Team Members row. Not an agent, so a task pointed here drops out
# of the agent-linked population the queue works from — that is the point.
KEVIN_REC_ID = "recHEt2VPYothaqTd"

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
CAP_PER_RUN = 50

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


def query_tasks(formula, max_records=None, minimal=False):
    records, offset = [], None
    while True:
        params = [("pageSize", "100"), ("returnFieldsByFieldId", "true"),
                  ("filterByFormula", formula)]
        if max_records:
            params.append(("maxRecords", str(max_records)))
        if not minimal:
            params += [("fields[]", f) for f in AF.values()]
        else:
            params.append(("fields[]", AF["name"]))
        if offset:
            params.append(("offset", offset))
        body = _request("GET", f"/{TASKS}?{urllib.parse.urlencode(params)}")
        records += body.get("records", [])
        offset = body.get("offset")
        if not offset:
            return records


def patch_task(task_id, fields):
    return _request("PATCH", f"/{TASKS}/{task_id}",
                    {"fields": fields, "typecast": True})


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
    if len(tail) > SUMMARY_MAX_CHARS:
        return ("its '%s' line is not the CLOSING line — %d characters follow "
                "it and the approval box shows only the first %d"
                % (CARRY_OUT_MARKER, len(tail), SUMMARY_MAX_CHARS))
    return ""


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
        "agentName": AGENTS.get(agent_id, {}).get("name", ""),
        "localAgent": AGENTS.get(agent_id, {}).get("agent", ""),
        "agentRole": AGENTS.get(agent_id, {}).get("role", ""),
    }


def sort_key(t):
    return (t["status"] != "Overdue", t["dueDate"] or "9999",
            -float(t["urgencyScore"] or 0))


# ─── QUEUE ────────────────────────────────────────────────────────────

def cmd_queue(args):
    formula = "OR({Status}='Today',{Status}='Overdue')"
    open_tasks = [task_view(r) for r in query_tasks(formula)]

    # Control of the control: a formula typo or renamed field returns zero
    # rows and reads as "nothing to do" forever. 17 live agents carry real
    # task links, so an empty agent-task population means the READ is broken.
    agent_linked = [t for t in open_tasks
                    if any(i in AGENTS for i in t["teamMemberIds"])
                    or any(i in AGENTS for i in t["sentForApprovalByIds"])]
    handback_population = query_tasks("LEN({Approval Outcome}&'')>0",
                                      max_records=1, minimal=True)
    if not agent_linked and not handback_population:
        print("ERROR: control failed — zero tasks linked to any AI agent and "
              "zero tasks with an approval outcome. The read is broken, not "
              "the queue empty.", file=sys.stderr)
        sys.exit(1)

    tier1, skipped_tier2, unmapped, unclassified = [], [], [], []
    approved_hb, changes_hb, new_work, routing = [], [], [], []

    for t in agent_linked:
        # Tier 1 no longer drops out of the worklist. It is MARKED and worked,
        # and the mark rides all the way to the Slack post. Removing this line
        # so tier-1 work is prepared silently is the regression to fear.
        hit1 = tier_match(TIER1_PATTERNS, t["name"], t["description"], t["notes"])
        t["tier1"] = bool(hit1)
        t["matchedPattern"] = hit1 or ""
        if hit1:
            tier1.append(t)
        hit2 = tier_match(TIER2_PATTERNS, t["name"], t["description"], t["notes"])
        out2 = outbound_intent(t["name"], t["description"],
                               t["notes"]) if hit2 else ""
        if hit2 and out2:
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
                routing.append(t)
            elif tm in AGENTS:
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
        "agents": AGENTS,              # the roster the CEO routes against
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
            "routingNeeded": len(routing),
            "unclassified": len(unclassified),
            "tier1Open": len(tier1),
            "tier1InWorklist": len([t for t in worklist if t.get("tier1")]),
            "worklist": len(worklist),
        },
    }
    print(json.dumps(out, indent=2))


# ─── WRITES ───────────────────────────────────────────────────────────

def cmd_route(args):
    if args.to not in AGENTS:
        sys.exit(f"ERROR: {args.to} is not one of the 17 AI agent records")
    if args.to == CEO_REC_ID:
        sys.exit("ERROR: routing back to the CEO is not a route")
    patch_task(args.task, {AF["teamMember"]: [args.to]})
    print(json.dumps({"routed": args.task, "to": args.to,
                      "agent": AGENTS[args.to]["name"]}))


def cmd_escalate(args):
    # The tier-1 exit. A keyword skip only lasts one run: the task stays linked
    # to an agent and comes back round every time. This moves it off the agents
    # for good, without touching Status, due date or anything Kevin decides.
    patch_task(args.task, {
        AF["teamMember"]: [KEVIN_REC_ID],
        AF["assignee"]: {"email": KEVIN_AIRTABLE_EMAIL},
    })
    print(json.dumps({"escalated": args.task, "to": "Kevin Brittain"}))


def cmd_submit(args):
    if args.agent not in AGENTS:
        sys.exit(f"ERROR: {args.agent} is not one of the 17 AI agent records")
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
    patch_task(args.task, {
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
    })
    print(json.dumps({"submitted": args.task,
                      "agent": AGENTS[args.agent]["name"],
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
    flags += [("task PARKED as creditor correspondence — Mica's lane, no agent "
               "will work it", t) for t in report.get("skippedTier2", [])]
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
            if live["status"] != "Completed":
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

    if problems:
        for p in problems:
            print(f"ERROR: {p}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps({"ok": True,
                      "actionsVerified": len(ok_actions),
                      "worklistAtStart": counts.get("worklist", 0)}))


# ─── ENTRY ────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("queue")

    r = sub.add_parser("route")
    r.add_argument("task")
    r.add_argument("--to", required=True)

    e = sub.add_parser("escalate")
    e.add_argument("task")

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

    v = sub.add_parser("verify")
    v.add_argument("--report", required=True)

    args = p.parse_args()
    {"queue": cmd_queue, "route": cmd_route, "escalate": cmd_escalate,
     "submit": cmd_submit, "annotate": cmd_annotate, "intent": cmd_intent,
     "complete": cmd_complete, "verify": cmd_verify}[args.cmd](args)


if __name__ == "__main__":
    main()
