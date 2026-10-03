#!/usr/bin/env python3
"""Lane B of the Cash Flow Voids chain (Kevin, 2 Oct 2026): a new tenant into payment, by rules.

WHY THIS IS RULES AND NOT THE AGENT
Every link here is an if/then with a date on it: has Roy answered, have seven days passed, has a
payment been matched. Nothing remembered day 7 or day 14 before, so the steps sat in a list a
Claude session followed by hand (.claude/skills/tenant-doc-generator/SKILL.md). The daily rent
check (scripts/rent-check.py) calls this after lane A, with the result it already worked out.

WHO IT IS FOR
A Universal Credit tenant whose tenancy is marked a cash flow void, began inside NEW_TENANT_DAYS,
and has never had a full rent matched. A void with no task that is older than that, has had its
rent and missed one, or was already a void on the slate date, is not started here.

THE CLOCK
  journal   Roy helps the tenant upload the agreement and the proof of residency to their
            Universal Credit journal, and replies when it is done. His "done" is day 0. With no
            "done" in JOURNAL_NO_REPLY_DAYS the clock moves on and the next step asks instead.
  costs     7 days on: Roy contacts Universal Credit and replies yes or no, "are the housing costs
            verified?". The tenant is asked for a screenshot at the same time (a trial draft).
            A no is asked again 7 days later, and so is silence. A reply that cannot be read is
            asked again at once.
  form      Roy's yes, on a tenancy not yet marked actioned: the direct rent payment form card is
            raised for Kevin (his ruling, 3 Oct 2026: "Robot fills, you pick reason";
            scripts/rent_form_plan.py builds the answers and the robot's plan from the records). He
            approves it, taps Your turn, chooses the reason, types the code and the bank numbers and
            sends. When he says in the Robot sign-in app that he finished, this file marks the card
            sent, comments on the tenancy and marks it CFV Actioned. A blank record raises no card
            and is said on the row. "The form has gone in" is otherwise read only from the tenancy
            being marked CFV Actioned (by hand, as before).
            No agent ever works the card (scripts/agent_email_format.py FORM_CARDS): this file reads
            Kevin's verdict on it. Request changes withdraws it (cancelled, with a WITHDRAWN line
            quoting him) and a new card is raised once an answer read from the records changes, or
            CHANGES_WAIT_DAYS later. Reject stops the form for that tenancy. A card that is approved
            but has no Your turn step or no plan on file, or never reached his queue, is withdrawn
            and raised again at once, so it can never sit as a "your turn" that is not. One whose Your
            turn step was closed without the app's words that he finished is said, never raised
            again: he may have sent it. A card whose arrears answer has expired (RENT FORM GOOD
            UNTIL) is raised again with a fresh count. A card for a tenancy that has moved on
            (paying, ended, marked otherwise) leaves his queue, and a card he sent always gets its
            comment, even after the clock has ended or the card was cancelled by hand.
  paid      Once the tenancy is marked actioned: Roy's first task is raised at the next run the
            bank data allows (see "the bank") and tells him to check with Universal Credit on or
            after the 14th day. Then he is asked every 14 days while no rent has arrived, and the
            tenant is asked too (a trial draft). On this step any reply from Roy counts as his
            check for that fortnight.
  the end   Either of two things (Kevin's map: "first payment matched"), at any step. Once a paid
            check exists, any rent payment matched to the tenancy dated on or after the day the
            first one was raised: the direct payment has started, and a shortfall is not this
            lane's. And at any step, the rent check reading the tenancy as paying with a payment
            matched. Roy's open tasks are closed and a RENT SETUP ENDED line is written on his
            newest task. From then on this file never touches the tenancy again.
            KNOWN LIMIT: late rent is lane A's only once the tenancy is marked In Payment (the
            dashboard's cash flow void page does that when it sees the payment). While it stays
            "CFV Actioned" a later miss is chased by neither lane, and the Home line says so.
  the gap   The rent check does not call a payment "paid" until its due day plus 2. So at any
            step, while a full rent has been matched in the last LANDED_WAIT_DAYS (and no earlier
            than 5 days before the last task was raised) and is not judged yet, nothing is raised.
  the bank  A `paid` check asks Roy why no rent has come. It is not raised while the bank data
            cannot say that it has not: a stale rent-account feed, or money-in on a rent account
            that could be this rent and is not matched yet. It waits, and the row says so.

WHAT IT NEVER DOES
It sends nothing to a tenant: the tenant drafts are the Cash Flow Voids agent's, which is a TRIAL
agent (scripts/agent_email_format.py). It drafts nothing to the DWP and sends nothing to it: the
form is sent by Kevin's own hand, and contacting the DWP is Roy's alone (Kevin, 2 Oct 2026). It
writes to a tenancy only after Kevin confirms he sent the form: one comment, and CFV to CFV
Actioned. It closes only tasks at Roy's own steps (journal, costs, paid), never one of his tasks at
Approval. It completes a form card only on Kevin's confirmation, and cancels one only to withdraw
it (above), never one he has said he sent.

STATE LIVES ON THE TASKS
Each task carries `RENT SETUP KEY: <tenancy id>:<step>:<n>` in its Notes (and its Description, so
a Notes field cut at the front cannot lose it), and is linked to that tenancy: a key for a tenancy
the task is not linked to is ignored and said. The furthest step with a task is where the tenancy
is, so a status somebody changes by hand never moves the clock back. A task raised by hand joins
the clock when that line is added to it. A hand-typed key that cannot be read, or sits on a task not
linked to its tenancy, is said on the row, and that tenancy is not started afresh while the task is
open, so no twin goes to Roy. The keyed read uses the field NAMES in its formula, so a renamed
field is an Airtable error and never an empty, passing read.

ROY'S ANSWERS
Read from his task's Notes in the two shapes they arrive in: his assistant's
(`[25 Sep 2026 14:00 Roy Lavin via his assistant, rec…] words`, scripts/roy-assistant.py) and his
Property Manager page's (`[2026-09-25 14:00 Roy Lavin] words`, workers/property-manager londonNow).
Both stamp London time.
The answer to a check is his newest line that reads as a yes or a no; a later line that is neither
(an afterthought) does not undo it. A line on an OLDER check's task counts only when it was written
after the newest task was raised, to the minute, so one reply is never read as the answer to the
question it caused. An answer closes the task whatever anyone ticked, except a "not yet" on the journal
step, which leaves the task his. A task ticked Completed (by anyone but this file, whatever was written on it before)
with no yes or no counts as done on the journal step, as "could not be read" (asked again at once)
on the housing costs step, and as checked that day on a paid step (asked again 14 days on).

ROY'S EMAILS
His tasks are created already his (Team Member and Assignee), then emailed with
scripts/send-email.py notify. Every run offers each open task this file raised (its name starts
NEW TENANT RENT:) for a tenancy still on the clock to notify again: a task whose email went is skipped by notify's own ledger, one whose email was
refused before it left is sent, and one whose send was cut off part way is never sent twice and is
said on the row instead. The way out for that one is the silence rule: with no reply the question
is asked again as a NEW task, which gets its own email. His tasks never carry the trial agent's id
or its marks: a trial task is mailed to nobody.
"""

import argparse
import calendar
import contextlib
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
LONDON = ZoneInfo("Europe/London")

SETUP_KEY_MARK = "RENT SETUP KEY: "
# A hand-typed mark is found however it is cased or spaced ("Rent setup key:rec…"): a mark that
# is missed is a key ignored in silence, and a twin to Roy.
SETUP_KEY_RE = re.compile(r"(?:RENT[^A-Za-z0-9]*)?SETUP[^A-Za-z0-9]*KEY[^A-Za-z0-9]*", re.I)
ENDED_MARK = "RENT SETUP ENDED: "
FIRST_CHECK_MARK = "RENT SETUP FIRST CHECK: "
CLOSED_BY_RULE = "— rent-check] Closed: "
ROY_PREFIX = "NEW TENANT RENT: "
# The direct rent payment form card (Kevin, 3 Oct 2026: "Robot fills, you pick reason"). Both marks
# are kept identical to FORM_CARDS in scripts/agent_email_format.py: that is what keeps the card away
# from every agent and lets it open the robot's window and nothing else.
FORM_PREFIX, FORM_KEY_MARK, FORM_SENT_MARK = "RENT FORM: ", "RENT FORM KEY: ", "RENT FORM SENT: "
FORM_COMMENTED_MARK = "RENT FORM COMMENTED: "   # the tenancy comment is written: never written twice
FORM_ACTIONED_MARK = "RENT FORM ACTIONED: "     # the tenancy was moved to CFV Actioned: never moved twice
FORM_WITHDRAWN_MARK = "RENT FORM WITHDRAWN: "   # cancelled by this file, not by hand: the clock goes on
FORM_ANSWERS_MARK = "RENT FORM ANSWERS: "       # the print of the card's answers (rent_form_plan.fingerprint)
FORM_GOOD_UNTIL_MARK = "RENT FORM GOOD UNTIL: "  # the robot's arrears answer holds until this day (rent_form_plan)
CHANGES_WORDS = "Kevin asked for changes: "
CHANGES_WAIT_DAYS = 7       # a card sent back for changes comes again once an answer changes, or this much later
SUBMIT_FAILED = "it could not be submitted to Kevin's queue"   # the withdrawal of a card the gates refused
SUBMIT_FAILS_STOP = 3       # cards refused at submit in a row: then it stops and says so
OUTCOME_FIELD = "fldrHBSr6qoUfaKuZ"         # Tasks: Approval Outcome (AF["approvalOutcome"] in scripts/agent-dispatch.py)
FEEDBACK_FIELD = "fldtI7SJI4gEohHD1"        # Tasks: Approval Feedback (AF["approvalFeedback"] in scripts/agent-dispatch.py)
SOME_DAY_FIELD = "fldmhkeRaDkiL3Ga4"        # Tasks: Some Day (scripts/task-hygiene-sweep.py): parked by Kevin, Status wiped
LANDLORD_PATH = os.path.expanduser("~/.config/od/direct-payment-landlord.json")
# A wall line in a task's Notes, kept identical to BLOCKER_LINE_RE in scripts/agent-dispatch.py.
_WALL_RE = re.compile(r"^\[[^\]\n]*\]\s*(?P<mark>BLOCKER OPEN|BLOCKER CLEARED)\s*"
                      r"\((?P<kind>SIGN-IN|SITE|TOOL|KEVIN) (?P<subject>[^)\n]+)\):\s*(?P<rest>[^\n]*)$", re.M)
# What the Robot sign-in app writes when Kevin says he finished his turn (scripts/robot-signin.applescript).
KEVIN_DONE = "Kevin finished his turn"
# The tenant draft is the trial agent's. Both marks are trial marks in scripts/agent_email_format.py
# TRIAL_TASK_MARKS, kept identical there (tests/cash-flow-voids-agent.test.js).
ASK_PREFIX, TRIAL_KEY_MARK = "RENT ASK: ", "RENT CHECK KEY: "
STEPS = ("journal", "costs", "form", "paid")
ROY_STEPS = ("journal", "costs", "paid")
NEW_TENANT_DAYS = 60        # a void with rent already matched is still "new" this long after it began
JOURNAL_NO_REPLY_DAYS = 10  # no word on the upload: the housing costs check asks instead
COSTS_WAIT_DAYS = 7         # Kevin's map: the day 7 check
COSTS_REPEAT_DAYS = 7       # a "no", or silence, is asked again a week later
PAID_WAIT_DAYS = 14         # Kevin's map: the day 14 check, then every 14 days until rent lands
EARLY_PAY_DAYS = 5          # kept identical to scripts/rent-check.py: a payment this early counts for a due day
TX_LOOKBACK_DAYS = 80       # kept identical to scripts/rent-check.py: matched payments older than this are not read
LANDED_WAIT_DAYS = 9        # a full rent matched this recently may not be judged yet (5 early + 2 tolerance + the feed)
SHORT_SLACK = 1.00          # kept identical to scripts/rent-check.py
WAITING_SHARE = 0.25        # kept identical to scripts/rent-check.py: unmatched money this share of the rent could be it
NO_UNIT = "(no unit linked)"  # the rent check's stand-in unit carries the surname: never put in a task name
UNIVERSAL_CREDIT = "Universal Credit"
CFV, CFV_ACTIONED = "CFV", "CFV Actioned"   # kept identical to scripts/rent-check.py
COMPLETION_FIELD = "fldFOi1SwEKuJRmdN"      # Tasks: Completion Date, a date and time (AF["completion"] in agent-dispatch.py)
TENANT_NAME_FIELD = "fldxBKW7QnujSDWqA"     # Tenants: Tenant Name
YES, NO, UNCLEAR = "yes", "no", "unclear"
# A task the rule may no longer close: finished, stopped, or waiting on Kevin.
LEAVE_ALONE = ("Completed", "Cancelled", "Approval")
ANSWERED = "Roy has answered, so this check is finished"
HANDOVER_REASON = ("standing handover: getting a new tenant's Universal Credit rent into payment is "
                   "Roy's to check with the tenant and the DWP (Kevin, 2 Oct 2026)")

# ─── reading Roy ─────────────────────────────────────────────────────
_ROY_HEAD = re.compile(r"^\[(?:(\d{1,2} \w{3} \d{4} \d{2}:\d{2}) Roy Lavin via his assistant, rec\w+"
                       r"|(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) Roy Lavin)\]\s?(.*)$")
# His assistant sometimes reports the reply ("Roy confirmed: done"). The lead-in is not the answer.
_LEAD_IN = re.compile(r"^\W*(roy( lavin)?\s+(has\s+)?(confirmed|confirms|says|said|replied|replies|wrote|answered)"
                      r"\s*(that\s+)?[:,\-]?\s*)+", re.I)
# "No problem" and "nothing outstanding" are not a no.
_IDIOM = re.compile(r"\b(no|not a) (problems?|worries|issues?|bother)\b|\bnothing (outstanding|else|further|more)\b", re.I)
_NO_FIRST = {"no", "nope", "not", "n", "nothing", "none", "never"}
_YES_WORDS = {"yes", "yep", "yeah", "y"}
# What counts as a yes depends on the question. "Done" answers "is it uploaded?" and says nothing
# about "are the housing costs verified?": every task email invites a "done" (send-email.py notify).
# "Confirmed" is not a yes to either: "they confirmed it is with a decision maker" is a no.
_YES_FIRST = {"journal": {"done", "uploaded", "sorted", "completed", "complete", "finished"},
              "costs": {"verified", "approved"}}
_POSITIVE = {"journal": re.compile(r"\b(yes|yep|yeah|done|uploaded|sorted|completed?|finished)\b", re.I),
             "costs": re.compile(r"\b(yes|yep|yeah|verified|approved)\b", re.I)}
_DONE_WORDS = r"(?:done|uploaded|verified|confirmed|approved|set up|in place|sorted|completed?|finished)"
# "not verified yet" is a no, and must not also read as "verified": taken out before the positive pass.
_NEGATED = re.compile(rf"(?:\bnot|n't|\bnever|\bno)\s+(?:(?:yet|been|being|fully|all)\s+){{0,3}}{_DONE_WORDS}\b", re.I)
_NEGATIVE = re.compile(r"\b(no|nope|not|never|nothing|cannot|unable|waiting|awaiting|pending|refused|declined|rejected"
                       r"|under review|on hold|in progress|but|however)\b"
                       r"|n't\b|\bstill (to|being|in)\b|\byet to\b", re.I)
# "I'll get it done tomorrow" is not done.
_FUTURE = re.compile(r"\b(will|won't|i'll|we'll|he'll|she'll|they'll|going to|to be|tomorrow|next week|this week"
                     r"|later|soon|shortly|should|would|hoping|hopefully|hope|expect\w*|needs?|still)\b", re.I)
# What may follow a bare "yes" and leave it a bare yes ("Yes thanks", "Yes, they are").
_BARE_YES_TAIL = re.compile(r"^\W*((thanks|thank you|cheers|all good|they are|they have|it is|it has|it's|they're)\W*)*$", re.I)
# "Yes, it is being verified", "Yes, almost verified", "Verified I think": a yes that hedges is not one.
_QUALIFIED = re.compile(r"\b(being|getting|almost|nearly|partly|partially|probably|apparently|i think|i believe"
                        r"|i reckon|seems?|looks like)\b", re.I)
_UNSURE_FIRST = re.compile(r"(not sure|no idea|unsure|do(es)?n't know|maybe|possibly)\b", re.I)
_UNSURE = re.compile(r"\b(not sure|unsure|do(es)?n't know|no idea|maybe|possibly|think so|unclear)\b|\?", re.I)


def roy_lines(notes):
    """[(when, words)] Roy wrote on a task, in the order they were written. Both shapes stamp
    London time. His words run to the next stamped line or mark line, so a reply of several lines
    is read whole."""
    out, cur = [], None
    for line in str(notes or "").splitlines():
        m = _ROY_HEAD.match(line)
        if m:
            try:
                when = (datetime.strptime(m.group(1), "%d %b %Y %H:%M") if m.group(1)
                        else datetime.strptime(m.group(2), "%Y-%m-%d %H:%M")).replace(tzinfo=LONDON)
            except ValueError:
                cur = None
                continue
            cur = [when, [m.group(3)]]
            out.append(cur)
        elif (line.startswith("[") or line.startswith((TRIAL_KEY_MARK, ENDED_MARK, FIRST_CHECK_MARK))
              or SETUP_KEY_RE.match(line)):
            cur = None
        elif cur is not None:
            cur[1].append(line)
    return [(when, "\n".join(w).strip()) for when, w in out]


def reading(words, step="costs"):
    """Roy's words as YES, NO or UNCLEAR for one step's question. The first word decides when it
    is a yes or a no (on the housing costs step a "yes" must stand alone or say verified or
    approved), unless a yes is taken back: a negative anywhere after it, or a promise or
    hedge ("will", "should", "tomorrow") in its own sentence, is two answers, so unclear. With no
    yes or no first: on the journal step a done-word with no negative or hedge is yes; on the
    housing costs step nothing is a yes (it must be said first), a plain negative is no; anything
    else is unclear. Nothing moves on a guess."""
    step = step if step in _YES_FIRST else "costs"
    text = _IDIOM.sub(" ", _LEAD_IN.sub("", str(words or "").replace("’", "'"))).strip(" \t\n,.;:-")
    if not text or _UNSURE_FIRST.match(text):
        return UNCLEAR
    # "Verified?" asks; it does not tell. Only the first sentence is weighed for this, so
    # "Yes, verified. Shall I do the form?" is still a yes.
    if re.split(r"(?<=[.!?])\s+", text, 1)[0].rstrip().endswith("?"):
        return UNCLEAR
    first = re.split(r"(?<=[.!?])\s+", text, 1)[0]
    rest, negated = _NEGATED.subn(" ", text)
    later = bool(_FUTURE.search(text))
    lead = re.match(r"[a-z']+", text.lower())
    lead = lead.group(0) if lead else ""
    if lead in _NO_FIRST:
        return NO
    if lead in _YES_WORDS or lead in _YES_FIRST[step]:
        # "Yes, I rang them and it is still pending" and "Yes will do" are not a yes: the sentence
        # that opens with it must not take it back. A later sentence may say anything.
        # A "not <done>" or a plain negative anywhere takes it back ("Yes, spoke to UC. Not verified
        # yet."). A promise only counts in the opening sentence, so "Yes, verified. I will do the
        # form tomorrow" stays a yes.
        mixed = (negated or _NEGATIVE.search(rest) or _FUTURE.search(first) or _UNSURE.search(first)
                 or _QUALIFIED.search(first))
        if mixed:
            return UNCLEAR
        # On the housing costs step "yes" must answer THE question: a bare "yes", or a yes that
        # says verified or approved. "Yes, spoke to UC this morning" and "Yes, it is with a
        # decision maker" report contact, not verification, and are asked again.
        if step == "costs" and lead in _YES_WORDS:
            tail = text[len(lead):]
            if not (_BARE_YES_TAIL.match(tail) or _POSITIVE["costs"].search(_NEGATED.sub(" ", tail))):
                return UNCLEAR
        return YES
    if _UNSURE.search(text):
        return UNCLEAR
    pos, neg = bool(_POSITIVE[step].search(rest)), bool(negated or later or _NEGATIVE.search(rest))
    if step == "costs":
        # "Should be verified by Friday" and "they verified the rent but the housing element is
        # under review" both carry the word. A yes here starts the form, so it must be said first:
        # the task tells Roy to. Anything else is a no when it is plainly negative (a hedge or a
        # promise is not), else it is unclear and asked again.
        return NO if (negated or _NEGATIVE.search(rest)) and not pos else UNCLEAR
    if pos != neg:
        return YES if pos else NO
    return UNCLEAR


# ─── the state on the tasks ──────────────────────────────────────────
def parse_key(line):
    """`<tenancy>:<step>:<n>` as (tenancy, step, n), or None."""
    m = re.fullmatch(r"(rec[A-Za-z0-9]{14}):([a-z]+):(\d+)", str(line or "").strip())
    if not m or m.group(2) not in STEPS:
        return None
    return m.group(1), m.group(2), int(m.group(3))


def key_lines(*texts):
    """([keys], [what could not be read]) from every line carrying the key mark, wherever on the
    line it sits. A hand-typed key is read forgivingly (a capital, a trailing full stop); one that
    still cannot be read is returned so it can be said: ignoring it in silence raises a twin."""
    good, bad = [], []
    for text in texts:
        for line in str(text or "").splitlines():
            found = SETUP_KEY_RE.search(line)
            if not found:
                continue
            raw = line[found.end():].strip()
            m = re.fullmatch(r"(rec[A-Za-z0-9]{14}):([A-Za-z]+):(\d+)", raw.rstrip(" .,;:`'\")"))
            key = parse_key(f"{m.group(1)}:{m.group(2).lower()}:{m.group(3)}") if m else None
            if key:
                if key not in good:
                    good.append(key)
            elif raw not in bad:
                bad.append(raw)
    return good, bad


def task_keys(*texts):
    return key_lines(*texts)[0]


def is_ask(task):
    """A tenant draft, by its name or by the trial key it carries: a renamed one is still one."""
    return (str(task.get("name") or "").startswith(ASK_PREFIX)
            or TRIAL_KEY_MARK in str(task.get("notes") or "") + str(task.get("description") or ""))


def group_tasks(tasks):
    """({tenancy: {step: [task, ...]}}, {(tenancy, step, n) with a tenant draft}, [problems],
    {tenancies not to start afresh}).
    Tasks are ordered by n, then by when they were made, then by id, so two tasks that share a key
    are always read the same way round. The tenant drafts never move the clock. A key naming a
    tenancy the task is not linked to, or one that cannot be read, is left out and said, and while
    the task is open the tenancy it points at is not started afresh: that would send Roy a twin
    of the task somebody tried to adopt."""
    out, asks, seen, drafts, problems, stuck = {}, set(), {}, {}, [], set()
    for t in tasks:
        linked = t.get("tenancies")
        good, bad = key_lines(t.get("notes"), t.get("description"))
        live = t.get("status") not in ("Completed", "Cancelled")    # open, at Approval included
        for raw in bad if live else ():
            problems.append(f"task {t['id']} has a key line that cannot be read ('{raw[:40]}'), so it is ignored")
            stuck.update(re.findall(r"rec[A-Za-z0-9]{14}", raw))
            stuck.update(linked or [])
        for tenancy, step, n in good:
            if linked is not None and tenancy not in linked:
                if live:
                    problems.append(f"task {t['id']} carries a key for a tenancy it is not linked to, so it is ignored")
                    # Both: the tenancy the key names, and the one the task is about (a slip in the id).
                    stuck.add(tenancy)
                    stuck.update(linked or [])
                continue
            if is_ask(t):
                asks.add((tenancy, step, n))
                if t.get("status") != "Cancelled":
                    drafts.setdefault((tenancy, step, n), []).append(t["id"])
                continue
            out.setdefault(tenancy, {}).setdefault(step, []).append(dict(t, n=n, step=step))
            if t.get("status") != "Cancelled":
                seen.setdefault((tenancy, step, n), []).append(t["id"])
    for steps in out.values():
        for rows in steps.values():
            rows.sort(key=lambda r: (r["n"], r["made"], r["id"]))
    problems += [f"two tasks carry the key {k[0]}:{k[1]}:{k[2]}" for k, ids in sorted(seen.items()) if len(ids) > 1]
    problems += [f"two tenant drafts carry the key {k[0]}:{k[1]}:{k[2]}" for k, ids in sorted(drafts.items()) if len(ids) > 1]
    return out, asks, problems, stuck


def replies(rows):
    """Roy's lines that answer the newest task of a step, oldest first: every line on that task,
    and a line on an older task written after the newest was raised."""
    last = rows[-1]
    lines = [ln for t in rows[:-1] for ln in roy_lines(t.get("notes")) if ln[0] > last["made"]]
    lines += roy_lines(last.get("notes"))
    return sorted(lines, key=lambda ln: ln[0])


def answered(rows, step, words=False):
    """(reading, day) of Roy's answer to the newest task of a step, or (None, None) when he has
    written nothing that counts. His newest line that reads yes or no is the answer; with lines
    but no yes or no among them it is UNCLEAR, dated by the newest. With words=True the words of
    that line come third, so whoever acts on the answer can read what he actually said."""
    lines = replies(rows)
    if not lines:
        return (None, None, None) if words else (None, None)
    for when, said_words in reversed(lines):
        said = reading(said_words, step)
        if said in (YES, NO):
            day = when.astimezone(LONDON).date()
            return (said, day, said_words) if words else (said, day)
    day = lines[-1][0].astimezone(LONDON).date()
    return (UNCLEAR, day, lines[-1][1]) if words else (UNCLEAR, day)


def kevin_sent(notes):
    """True when the newest wall line on a card is a KEVIN wall cleared because Kevin said, in the
    Robot sign-in app, that he finished his turn. A wall cleared as superseded is not."""
    walls = list(_WALL_RE.finditer(str(notes or "")))
    if not walls:
        return False
    last = walls[-1]
    return last.group("mark") == "BLOCKER CLEARED" and last.group("kind") == "KEVIN" and KEVIN_DONE in last.group("rest")


def open_kevin_wall(notes):
    """True when the newest wall line on a card is an open KEVIN wall: his Your turn step is live."""
    walls = list(_WALL_RE.finditer(str(notes or "")))
    return bool(walls) and walls[-1].group("mark") == "BLOCKER OPEN" and walls[-1].group("kind") == "KEVIN"


def withdrawal(notes):
    """{"day", "why"} of the newest WITHDRAWN line this file wrote on a form card, or None."""
    for line in reversed(str(notes or "").splitlines()):
        line = line.strip()
        if line.startswith(FORM_WITHDRAWN_MARK):
            rest = line[len(FORM_WITHDRAWN_MARK):]
            try:
                return {"day": datetime.strptime(rest[:10], "%Y-%m-%d").date(), "why": rest[10:].strip()}
            except ValueError:
                return None
    return None


def good_until(notes):
    """The last day a form card's arrears answer holds, or None when the robot did not answer it."""
    for line in reversed(str(notes or "").splitlines()):
        if line.strip().startswith(FORM_GOOD_UNTIL_MARK):
            try:
                return datetime.strptime(line.strip()[len(FORM_GOOD_UNTIL_MARK):][:10], "%Y-%m-%d").date()
            except ValueError:
                return None
    return None


def wall_closed_not_by_kevin(notes):
    """True when the newest wall line is a cleared KEVIN wall that does not carry the app's words that
    Kevin finished his turn. He may have sent the form: it is never raised again on a guess."""
    walls = list(_WALL_RE.finditer(str(notes or "")))
    return (bool(walls) and walls[-1].group("mark") == "BLOCKER CLEARED" and walls[-1].group("kind") == "KEVIN"
            and KEVIN_DONE not in walls[-1].group("rest"))


def card_print(notes):
    """The print of a form card's answers, or ""."""
    for line in reversed(str(notes or "").splitlines()):
        if line.strip().startswith(FORM_ANSWERS_MARK):
            return line.strip()[len(FORM_ANSWERS_MARK):].strip()
    return ""


def is_form_card(task):
    """A form card by either of its marks (kept identical to agent_email_format.form_card)."""
    return (str(task.get("name") or "").startswith(FORM_PREFIX)
            or FORM_KEY_MARK in str(task.get("notes") or "") + str(task.get("description") or ""))


def months_unpaid(start, due_day, rent, pays, day):
    """What the records say a tenant owes since the tenancy began: {"months", "owed", "falls",
    "paid"}, where `falls` is how many monthly due days have come round. None when they cannot
    say: no start, due day or rent, or a start older than the matched payments the rent check
    reads. The direct rent form asks whether the tenant has missed two months or more."""
    if not start or not rent or rent <= 0:
        return None
    try:
        due_day = int(due_day or 0)
    except (TypeError, ValueError):
        return None
    if not 1 <= due_day <= 31 or start - timedelta(days=EARLY_PAY_DAYS) < day - timedelta(days=TX_LOOKBACK_DAYS):
        return None
    falls, year, month = 0, start.year, start.month
    while True:
        due = date(year, month, min(due_day, calendar.monthrange(year, month)[1]))
        if due > day:
            break
        falls += due >= start
        year, month = (year, month + 1) if month < 12 else (year + 1, 1)
    paid = sum(p["amount"] for p in pays or [] if p["day"] >= start - timedelta(days=EARLY_PAY_DAYS))
    owed = max(0.0, falls * rent - paid)
    # `next` is the next due day: the count holds until then, and a card answered on it holds no longer.
    return {"months": round(owed / rent, 2), "owed": round(owed, 2), "falls": falls, "paid": round(paid, 2),
            "asAt": day.isoformat(), "next": due.isoformat()}


def days(n):
    return f"{n} day{'' if n == 1 else 's'}"


def first_check(task):
    """The day a first `paid` task told Roy to check from, or None for an ordinary one."""
    for line in str(task.get("notes") or "").splitlines():
        if line.strip().startswith(FIRST_CHECK_MARK):
            try:
                return datetime.strptime(line.strip()[len(FIRST_CHECK_MARK):][:10], "%Y-%m-%d").date()
            except ValueError:
                return None
    return None


def asked_before(steps, day):
    """Kevin's newest request for changes on this tenancy's form cards, quoted on any later card (with no
    wait: print None), or None. His words are never lost because a card went for another reason."""
    for t in reversed(steps.get("form") or []):
        w = withdrawal(t.get("notes")) if t["status"] == "Cancelled" else None
        if w and w["why"].startswith(CHANGES_WORDS):
            return {"on": w["day"], "feedback": w["why"][len(CHANGES_WORDS):].strip().strip('"'), "print": None}
    return None


def costs_yes(steps):
    """(Roy's words, the day) of his yes to the housing costs check, or None."""
    rows = steps.get("costs")
    if not rows:
        return None
    said, said_on, said_words = answered(rows, "costs", words=True)
    return (said_words, said_on) if said == YES else None


def position(steps, day, status="", plans=None):
    """Where one tenancy is, from its keyed tasks. Pure.

    Returns {"stage", "note", "short", "raise": (step, n) or None, "first", "close": task or None,
    "why", "last", "askFrom", "finish", "roy", "withdraw", "prior"}. `raise` is the next task to
    create today. `close` is the newest task when it is finished and still open. `short` is the
    few words the Home line carries. `withdraw` is why the newest form card is to be withdrawn, and
    `prior` Kevin's request for changes the next card answers. `plans` holds the ids of the cards
    with a robot plan on file (None: not checked). The furthest step with a task decides, so an
    adopted `paid` task skips the earlier ones."""
    def out(stage, note, short, raise_=None, close=None, why=ANSWERED, last=None, first=False, ask_from=None,
            finish=False, roy=None, withdraw=None, prior=None):
        return {"stage": stage, "note": note, "short": short, "raise": raise_, "close": close, "why": why,
                "last": last, "first": first, "askFrom": ask_from, "finish": finish, "roy": roy,
                "withdraw": withdraw, "prior": prior}

    actioned = status == CFV_ACTIONED
    step = next((s for s in reversed(STEPS) if steps.get(s)), None)
    if step is None:
        if actioned:
            # Marked actioned with no task on record: the form went in by hand.
            return out("", "marked actioned with no task on record, so the first check on the direct payment is next",
                       "form sent, awaiting rent", ("paid", 1), first=True)
        return out("", "new, the journal upload is next", "journal upload next", ("journal", 1))
    rows = steps[step]
    last = rows[-1]
    if last["status"] == "Cancelled" and not (step == "form" and (withdrawal(last.get("notes"))
                                                                  or kevin_sent(last.get("notes")) or actioned)):
        # Somebody stopped this by hand. Raising it again tomorrow would undo their decision. A form
        # card this file withdrew carries its WITHDRAWN line: that one is raised again. A card Kevin
        # has said he sent is finished whoever cancelled it: the form has gone to the DWP. And a card
        # cancelled on a tenancy marked CFV Actioned is the form done by hand: the payment checks follow.
        return out(step, "stopped: its last task was cancelled by hand", "stopped by hand")
    said, said_on, said_words = answered(rows, step, words=True)
    # Closed by this file with no answer on it is not Roy's doing, and never his "done".
    ticked = last["status"] == "Completed" and not (said is None and CLOSED_BY_RULE in str(last.get("notes") or ""))
    age = (day - last["created"]).days
    asked = f"Roy asked {last['created'].strftime('%-d %b')}, {days(age)} ago, no reply yet"
    spare = None if last["status"] in LEAVE_ALONE else last        # finished, and still open
    quiet = "no reply, so asked again"
    if step in ("journal", "costs") and actioned:
        # The form has gone in, however Roy's last word on this step read (the verification can
        # come from the tenant's screenshot). There is no form date, so the first check is raised
        # today and tells Roy to make it 14 days on.
        return out(step, "form sent (the tenancy is marked actioned), so the first check on the direct payment is next",
                   "form sent, awaiting rent", ("paid", 1), spare, "the form has gone in, so this check is finished",
                   last, first=True)
    if step == "paid":
        start = first_check(last) or last["created"]
        if said is None and not ticked:
            if (day - start).days >= PAID_WAIT_DAYS:
                return out("paid", f"form sent, waiting for the first payment ({asked}, asked again)",
                           "form sent, Roy asked again", ("paid", last["n"] + 1), spare, quiet, last)
            return out("paid", f"form sent, waiting for the first payment ({asked})", "form sent, awaiting rent",
                       last=last, ask_from=start)
        # Any reply is his check for the fortnight, readable or not: date it from the newest.
        heard = replies(rows)
        since = (heard[-1][0].astimezone(LONDON).date() if heard else None) or last.get("completed") or last["created"]
        due = (day - since).days >= PAID_WAIT_DAYS
        return out("paid", f"form sent, waiting for the first payment (Roy last checked {since.strftime('%-d %b')})",
                   "form sent, awaiting rent", ("paid", last["n"] + 1) if due else None, spare, last=last)
    if step == "form":
        # The form card (rent_form_plan.py). "The form has gone in" is read from the tenancy being
        # marked actioned, or from Kevin saying in the Robot sign-in app that he finished his turn
        # on this card; never from the card's status or outcome (a rejected card is Completed too).
        notes = str(last.get("notes") or "")
        kevin, commented = kevin_sent(notes), FORM_COMMENTED_MARK in notes
        live = last["status"] not in ("Completed", "Cancelled")
        if actioned:
            return out("form", "form sent (the tenancy is marked actioned), so the first check on the direct "
                               "payment is next", "form sent, awaiting rent", ("paid", 1), last=last, first=True,
                       finish=kevin and not commented,
                       withdraw="the tenancy is marked CFV Actioned, so the form went in another way"
                       if live and not kevin else None)
        if kevin and FORM_ACTIONED_MARK in notes:
            # The rent check marked it CFV Actioned once; somebody has set it back since. Theirs to decide.
            return out("form", "form sent by Kevin, and the tenancy was marked CFV Actioned, but it reads CFV again; "
                               "it is left as it is", "form sent, set back by hand", last=last)
        if kevin:
            return out("form", "form sent by Kevin; the tenancy is being marked CFV Actioned", "form sent", last=last,
                       finish=True)
        roy, n = costs_yes(steps), last["n"] + 1
        gone = withdrawal(notes) if last["status"] == "Cancelled" else None
        outcome = str(last.get("outcome") or "")
        if outcome.startswith("Rejected"):
            return out("form", "Kevin sent the form card back, so no form is being sent; marking the tenancy CFV "
                               "Actioned by hand starts the payment checks if it goes in another way",
                       "form sent back", last=last)
        # Withdrawn by this file: raised again from the day it was withdrawn (Kevin's wait counts from then).
        if gone:
            if gone["why"].startswith(CHANGES_WORDS):
                said = gone["why"][len(CHANGES_WORDS):].strip().strip('"')
                until = gone["day"] + timedelta(days=CHANGES_WAIT_DAYS)
                return out("form", f"Kevin asked for changes to the form card on {gone['day'].strftime('%-d %b')} "
                                   f"(\"{said[:80]}\"): it is raised again once an answer changes, or on "
                                   f"{until.strftime('%-d %b')}", "form card changes", ("form", n), last=last, roy=roy,
                           prior={"on": gone["day"], "feedback": said, "print": card_print(notes)})
            if gone["why"].startswith(SUBMIT_FAILED):
                refused = 0
                for t in reversed(steps.get("form") or []):
                    w = withdrawal(t.get("notes")) if t["status"] == "Cancelled" else None
                    if not (w and w["why"].startswith(SUBMIT_FAILED)):
                        break
                    refused += 1
                if refused >= SUBMIT_FAILS_STOP:
                    return out("form", f"the form card was refused at submit {refused} times in a row ({gone['why'][:120]}), "
                                       "so it is not raised again until the cause is fixed", "form card to check", last=last)
                if day <= gone["day"]:
                    return out("form", f"the form card could not be submitted ({gone['why'][:90]}); it is raised again "
                                       "tomorrow", "form card raised again tomorrow", last=last)
            return out("form", f"the form card was withdrawn ({gone['why'][:90]}), so it is raised again",
                       "form card raised again", ("form", n), last=last, roy=roy, prior=asked_before(steps, day))
        if last["status"] == "Completed":
            return out("form", "the form card was closed without Kevin saying he sent the form, so nothing more is "
                               "raised; marking the tenancy CFV Actioned by hand starts the payment checks if it went in",
                       "form card closed", last=last)
        if last.get("someDay"):
            # Kevin parked it with the Some Day tick (which blanks its Status): his park stands.
            return out("form", "Kevin parked the form card for some day, so it is left as it is", "form card parked",
                       last=last)
        if outcome == "Changes requested":
            said = " ".join(str(last.get("feedback") or "").split())[:300]
            return out("form", f"Kevin asked for changes to the form card (\"{said[:80]}\"), so it is withdrawn and "
                               "raised again once an answer changes", "form card changes", ("form", n), last=last,
                       roy=roy, withdraw=f'{CHANGES_WORDS}"{said}"',
                       prior={"on": day, "feedback": said, "print": card_print(notes)})
        until = good_until(notes)
        if live and until and day > until and outcome.startswith("Approved"):
            # The robot's "has not missed two months" was counted before a rent fell due. The plan the
            # window would run says so too (agent-browser.js refuses it): a fresh count, a fresh card.
            # Only once approved: a card still waiting on Kevin (in his queue, deferred or parked) is his,
            # and if he approves it late, this raises the fresh one then.
            return out("form", f"the form card's arrears answer was good until {until.strftime('%-d %b')}, so it is raised "
                               "again with a fresh count", "form card raised again", ("form", n), last=last, roy=roy, prior=asked_before(steps, day),
                       withdraw=f"its arrears answer was counted before the rent due after {until.strftime('%-d %b %Y')}")
        if outcome.startswith("Approved"):
            if open_kevin_wall(notes) and (plans is None or last["id"] in plans):
                return out("form", "your turn: tap Your turn on the AI Agents page and the robot fills the form",
                           "your turn", last=last)
            if wall_closed_not_by_kevin(notes):
                # His Your turn step was closed, but not with the app's words that he finished. He may have
                # sent it: a second card could send the government form twice. Said, never guessed.
                return out("form", "the form card's Your turn step was closed without the app's word that Kevin sent the "
                                   "form; if it went in, marking the tenancy CFV Actioned starts the payment checks",
                           "form card to check", last=last)
            # Without an open KEVIN wall and a plan on file the Your turn button never shows: a
            # "your turn" here would be a dead end nobody could see.
            return out("form", "the form card is approved but its Your turn step is closed or its plan is missing, and "
                               "Kevin has not said he sent the form, so it is raised again", "form card raised again",
                       ("form", n), last=last, roy=roy, prior=asked_before(steps, day),
                       withdraw="approved, but its Your turn step was closed or its plan was missing, and Kevin had "
                                "not said he sent the form")
        if not outcome and last["status"] == "Approval":
            return out("form", "the direct rent payment form card is in Kevin's queue", "form card with Kevin", last=last)
        if not outcome and open_kevin_wall(notes):
            # Submitted (its Your turn step opened at submit), then moved out of his queue by him: parked.
            return out("form", f"Kevin moved the form card out of his queue (it reads {last['status'] or 'blank'}), so it "
                               "is left as it is", "form card parked", last=last)
        if not outcome:
            # Created, but its submit and its cancel both failed (no Your turn step ever opened): nobody would
            # ever see it.
            return out("form", "the form card never reached Kevin's queue, so it is raised again",
                       "form card raised again", ("form", n), last=last, roy=roy, prior=asked_before(steps, day),
                       withdraw="it never reached Kevin's queue")
        return out("form", f"the form card's outcome '{outcome[:40]}' is not one the rent check knows, so it is left "
                           "as it is", "form card to check", last=last)
    if step == "costs":
        if said == YES:
            quoted = " ".join(str(said_words or "").split())[:90]
            # Not actioned (the actioned case is above): the form card is raised for Kevin.
            return out("costs", f"housing costs verified ({said_on.strftime('%-d %b')}, Roy: \"{quoted}\"), the direct "
                                "rent payment form is due", "form due", ("form", 1), spare, last=last,
                       roy=(said_words, said_on))
        if said is None and not ticked:
            if age >= COSTS_REPEAT_DAYS:
                return out("costs", f"waiting on Roy: are the housing costs verified ({asked}, asked again)",
                           "Roy asked again", ("costs", last["n"] + 1), spare, quiet, last)
            return out("costs", f"waiting on Roy: are the housing costs verified ({asked})", "waiting on Roy",
                       last=last, ask_from=last["created"])
        since = said_on or last.get("completed") or last["created"]
        if said == NO:
            due = (day - since).days >= COSTS_REPEAT_DAYS
            return out("costs", f"housing costs not verified yet ({since.strftime('%-d %b')})", "housing costs not verified",
                       ("costs", last["n"] + 1) if due else None, spare, last=last)
        # Unreadable, or ticked done with no yes or no: asked again at once. Nobody else is told,
        # so waiting helps no one.
        return out("costs", f"Roy's reply could not be read as yes or no ({since.strftime('%-d %b')}), asked again",
                   "Roy asked again", ("costs", last["n"] + 1), spare, last=last)
    # journal: a yes is day 0 on the day he said it; ticked done is day 0 on the day it was ticked,
    # never the day of an earlier "not yet".
    if said == YES or ticked:
        since = said_on if said == YES else (last.get("completed") or said_on or last["created"])
        due = (day - since).days >= COSTS_WAIT_DAYS
        return out("journal", f"documents on the Universal Credit journal {since.strftime('%-d %b')}, housing costs "
                              f"check due {COSTS_WAIT_DAYS} days after", "journal done, check due",
                   ("costs", 1) if due else None, spare, last=last)
    if age >= JOURNAL_NO_REPLY_DAYS:
        return out("journal", f"no word from Roy that the documents are on the journal in {days(age)}, so the "
                              "housing costs check asks instead", "Roy asked again", ("costs", 1), spare,
                   "not confirmed in time, so the housing costs check asks instead", last)
    if said in (NO, UNCLEAR):
        return out("journal", f"waiting on Roy: the journal upload (he replied {said_on.strftime('%-d %b')}, not done yet)",
                   "waiting on Roy", last=last)
    return out("journal", f"waiting on Roy: the journal upload ({asked})", "waiting on Roy", last=last)


# ─── the words on each task ──────────────────────────────────────────
def place_name(unit):
    """The unit as a task name may carry it. A tenancy with no unit linked is shown by the rent
    check under the tenant's surname, which never goes in a name or in what a run reports."""
    return "a tenancy with no unit linked" if NO_UNIT in str(unit) else unit


def bank_hold(bank, since, rent):
    """True when the bank data cannot support "no rent has come": a rent account's feed is stale,
    or money-in on a rent account dated since `since` that could be the rent is still unmatched
    (the rent check's own test for "cannot tell", scripts/rent-check.py judge)."""
    if bank.get("blocked"):
        return True
    return any(w["day"] >= since and w["amount"] >= WAITING_SHARE * rent for w in bank.get("waiting") or [])


def landed(payments, since, rent, day):
    """True when a full rent has been matched since `since` and inside the last LANDED_WAIT_DAYS:
    money the rent check may not have judged yet."""
    floor = max(since, day - timedelta(days=LANDED_WAIT_DAYS))
    return rent > 0 and sum(p["amount"] for p in payments if p["day"] >= floor) >= rent - SHORT_SLACK


def roy_task(row, step, n, day, first=False):
    """One of Roy's tasks. The name carries the unit and never the tenant's name: it is what a
    run reports, and the email subject is cut at 150 characters."""
    who = row.get("tenant") or "the tenant"
    unit = place = place_name(row["unit"])
    again = "" if n == 1 else f" {n}"
    key = f"{row['id']}:{step}:{n}"
    notes, due = SETUP_KEY_MARK + key, day
    if step == "journal":
        name = f"{ROY_PREFIX}journal upload: {place}"
        ask = [f"{who} is a new tenant at {unit} and their rent is not set up yet.",
               "Please help them upload the signed tenancy agreement and the proof of residency to their "
               "Universal Credit journal.",
               "", "Reply to this email with \"done\" on the day it is uploaded. That day starts the 7 day wait "
               "before the housing costs check."]
    elif step == "costs":
        name = f"{ROY_PREFIX}housing costs check{again}: {place}"
        ask = [f"{who} at {unit}: the tenancy documents should be on the Universal Credit journal by now.",
               "Please contact Universal Credit and find out whether the housing costs are verified.",
               "", "Start your reply with yes or no. \"Done\" on its own cannot be read here. A yes tells Kevin the "
               "direct rent application is due. A no is asked again in 7 days."]
    elif first:
        due = day + timedelta(days=PAID_WAIT_DAYS)
        notes += "\n" + FIRST_CHECK_MARK + due.isoformat()
        name = f"{ROY_PREFIX}direct rent check: {place}"
        ask = [f"{who} at {unit}: the direct rent application has gone to the DWP.",
               f"On or after {due.strftime('%-d %b %Y')}, please contact Universal Credit and find out whether it is "
               "set up, and the date of the first payment if they give it.",
               "", "Start your reply with yes or no, then what they told you. It is asked again every 14 days "
               "until the rent arrives."]
    else:
        name = f"{ROY_PREFIX}direct rent check{again}: {place}"
        # The rule ends the clock at any rent matched on or after this date, so the sentence is
        # true whenever this task is raised. It is not "since the form went in": no form date is held.
        since = row.get("since")
        ask = [f"{who} at {unit}: the direct rent application has gone to the DWP, and no rent has been matched "
               f"to this tenancy since {since.strftime('%-d %b %Y')}." if since else
               f"{who} at {unit}: the direct rent application has gone to the DWP.",
               "Please contact Universal Credit and find out whether it is set up, and the date of the first "
               "payment if they give it.",
               "", "Start your reply with yes or no, then what they told you. It is asked again every 14 days "
               "until the rent arrives."]
    return {"kind": "roy", "key": key, "tenancy": row["id"], "tenants": row.get("tenants") or [], "name": name,
            "label": f"Roy, {step} check {n}: {place}", "due": due,
            "description": "\n".join([f"Raised by the daily rent check on {day.strftime('%-d %b %Y')}.", ""] + ask
                                     + ["", "Reference for the rent check, please leave it in:", SETUP_KEY_MARK + key]),
            "notes": notes}


def form_task(row, day, roy, n=1, prior=None, arrears=None):
    """The direct rent payment form card. Its words and the robot's plan are built from the
    records when it is raised (raise_form), not here: this is the plan's item. `prior` is Kevin's
    request for changes on the card before it, `arrears` what months_unpaid counted."""
    place = place_name(row["unit"])
    key = f"{row['id']}:form:{n}"
    words, said_on = roy or ("", None)
    return {"kind": "form", "key": key, "tenancy": row["id"], "tenants": row.get("tenants") or [],
            "name": f"{FORM_PREFIX}direct rent payment form: {place}", "label": f"form card {n}: {place}", "due": day,
            "place": place, "tenant": row.get("tenant") or "the tenant", "prior": prior, "arrears": arrears,
            "royWords": words, "royDay": said_on.strftime("%-d %b %Y") if said_on else "",
            "notes": FORM_KEY_MARK + key + "\n" + SETUP_KEY_MARK + key}


def ask_task(row, step, n, day):
    """The tenant's side of the same check (Kevin, 2 Oct 2026: the tenant and Roy at the same
    time). A trial draft: the agent writes it, Kevin checks it, nothing is sent."""
    who = row.get("tenant") or "the tenant"
    unit = place_name(row["unit"])
    what = ("their housing costs are verified" if step == "costs" else "their rent is set to be paid direct to the landlord")
    key = f"{row['id']}:{step}:{n}"
    return {"kind": "ask", "key": key, "tenancy": row["id"], "tenants": row.get("tenants") or [],
            "name": f"{ASK_PREFIX}{step} check {n}: {place_name(unit)}",
            "label": f"tenant draft, {step} check {n}: {place_name(unit)}", "due": day,
            "description": "\n".join([
                f"New tenant check raised by the daily rent check on {day.strftime('%-d %b %Y')}.",
                "TRIAL: you draft, Kevin checks, nothing is sent to the tenant.",
                "",
                f"Tenancy: {unit} (tenancy record {row['id']})",
                f"Tenant: {who}",
                f"Rent: £{row['rent']:,.2f} a month",
                # "payment" keeps this task out of Roy's lane, which is sorted by the task's words
                # (scripts/agent-dispatch.py ROY_EXCLUDE_RE): a unit name alone can read as a repair.
                "Rent payment: not in payment yet.",
                f"Where it is: {row['note']}",
                "",
                f"Draft ONE email asking {who} to open their Universal Credit journal and send a screenshot "
                f"showing whether {what}. Roy is asking Universal Credit the same question.",
                "Follow the RENT ASK section of your agent file.",
                "",
                TRIAL_KEY_MARK + key + ":ask",
                SETUP_KEY_MARK + key,
            ]),
            "notes": TRIAL_KEY_MARK + key + ":ask\n" + SETUP_KEY_MARK + key}


def plan(res, tasks, tenants_of, names, day, starts=None, paid=None, bank=None, plans=None, dues=None):
    """Today's lane B moves. Pure: no reads, no writes.

    `res` is the rent check's result. `tasks` are the keyed tasks ({id, name, notes, description,
    status, created, made, completed, tenancies}). `tenants_of` maps a tenancy to its tenant ids,
    `names` a tenant id to a name, `starts` a tenancy to the day it began, and `paid` maps a
    tenancy to its matched rent payments ([{day, amount}], rent-check.py payments_by_tenancy).
    `bank` is what the bank data can support today ({"blocked": [why], "waiting": [{day, amount}]},
    rent-check.py feed_state). `plans` holds the ids of the form cards with a robot plan on file, and
    `dues` maps a tenancy to its rent due day (the form asks about arrears).
    Returns {"rows": {tenancy: {note, short}}, "raise": [task], "close": [{id, why, complete, end,
    tenancy}], "withdraw": [{id, why, tenancy}], "finish": [{id, tenancy}], "problems": [text]}."""
    starts, paid, bank, dues = starts or {}, dict(paid or {}), bank or {}, dues or {}
    grouped, asks, problems, stuck = group_tasks(tasks)
    status_of = {r["id"]: r.get("status") or "" for r in res["tenancies"]}
    lanes = res.get("lanes") or {}
    ended = {tenancy for tenancy, steps in grouped.items()
             if any(ENDED_MARK in str(t.get("notes") or "") for rows in steps.values() for t in rows)}
    rows_out, raise_out, close_out, finish_out, withdraw_out = {}, [], [], [], []
    seen = set()
    stopped = {tenancy for tenancy, steps in grouped.items()
               if position(steps, day, status_of.get(tenancy) or "")["short"] == "stopped by hand"}

    def close(task, why, tenancy):
        if task["status"] not in LEAVE_ALONE and task["id"] not in {c["id"] for c in close_out}:
            close_out.append({"id": task["id"], "name": task["name"], "why": why, "complete": True, "end": False,
                              "tenancy": tenancy})

    def want_ask(tenancy, step, n):
        return (tenancy, step, n) not in asks

    def withdraw(task, why, tenancy):
        if task["id"] not in {w["id"] for w in withdraw_out}:
            withdraw_out.append({"id": task["id"], "tenancy": tenancy, "why": why,
                                 "label": f"form card withdrawn: {task['id']}"})

    def finish(task, tenancy):
        if task["id"] not in {f["id"] for f in finish_out}:
            finish_out.append({"id": task["id"], "tenancy": tenancy, "label": f"form sent: {task['id']}"})

    def keep_straight(tenancy, steps, status):
        """Nothing is raised for this tenancy today, but a sent card gets its comment and an out-of-date,
        sent-back or stranded card leaves Kevin's queue."""
        finish_sent(tenancy, steps)
        if steps.get("form"):
            pos = position(steps, day, status or "", plans)
            if pos["stage"] == "form" and pos["withdraw"]:
                withdraw(pos["last"], pos["withdraw"], tenancy)

    def finish_sent(tenancy, steps):
        """Only the cards Kevin sent and that still lack their comment: his word is never lost."""
        for t in steps.get("form") or []:
            if kevin_sent(t.get("notes")) and FORM_COMMENTED_MARK not in str(t.get("notes") or ""):
                finish(t, tenancy)

    def settle_cards(tenancy, steps, keep, why):
        """Every form card but `keep`: one Kevin has said he sent is finished (its comment), and one
        still open is withdrawn. A card is never left in his queue for a tenancy that has moved on."""
        for t in steps.get("form") or []:
            if keep is not None and t["id"] == keep["id"]:
                continue
            if kevin_sent(t.get("notes")):
                if FORM_COMMENTED_MARK not in str(t.get("notes") or ""):
                    finish(t, tenancy)
            elif t["status"] not in ("Completed", "Cancelled"):
                withdraw(t, why, tenancy)

    def end_clock(tenancy, steps, why):
        """Close Roy's open tasks, settle every form card and put the end line on the newest keyed task."""
        for step in ROY_STEPS:
            for t in steps.get(step) or []:
                close(t, why, tenancy)
        settle_cards(tenancy, steps, None, why)
        every = [t for step in ROY_STEPS for t in steps.get(step) or []] or [t for rows in steps.values() for t in rows]
        newest = max(every, key=lambda t: (STEPS.index(t["step"]), t["n"], t["made"], t["id"]))
        hit = next((c for c in close_out if c["id"] == newest["id"]), None)
        if hit:
            hit["end"] = True
        else:
            close_out.append({"id": newest["id"], "name": newest["name"], "why": "", "complete": False,
                              "end": True, "tenancy": tenancy})

    for r in res["tenancies"]:
        steps = grouped.get(r["id"]) or {}
        if r["id"] in ended:
            continue                                  # rent landed once: lane A's from then on
        # Only while the tenancy is still marked a cash flow void. In Payment and late is lane A's.
        void = r.get("status") in (CFV, CFV_ACTIONED)
        began = starts.get(r["id"])
        young = bool(began) and (day - began).days <= NEW_TENANT_DAYS
        # New: no rent matched yet, or a void that began recently (a part payment does not make
        # a tenant old). An existing void is never started here.
        pays = paid.get(r["id"]) or []
        rent = r.get("rent") or 0
        # A void that has had a full rent and then missed one is a late payer, not a new tenant.
        had_rent = rent > 0 and sum(p["amount"] for p in pays) >= rent - SHORT_SLACK
        new = void and not steps and young and not had_rent and r["lane"] in ("new", "late")
        if r.get("noChase") and (new or (void and steps)):
            seen.add(r["id"])
            keep_straight(r["id"], steps, r.get("status"))
            continue                                  # the rent check has already said so on the row
        if (new or (void and steps)) and r["id"] in stuck:
            # A task for this tenancy carries a key that cannot be used. Anything raised now could
            # be a twin of that task (a fresh journal, or the next check beside a hand one), so
            # nothing is, at any step, until the key is fixed. The key is said in the problems.
            rows_out[r["id"]] = {"note": "a task carries a key for this tenancy that cannot be used, so nothing is raised "
                                         "until it is fixed", "short": "key to fix"}
            seen.add(r["id"])
            keep_straight(r["id"], steps, r.get("status"))
            continue
        if new and not r.get("type") and not r.get("noChase"):
            problems.append(f"{place_name(r['unit'])} is a new cash flow void whose tenant has no rent payment type, "
                            "so its clock cannot start")
        fresh = new and r.get("type") == UNIVERSAL_CREDIT
        adopted = void and r["lane"] in ("new", "existing", "late") and bool(steps)
        if not (fresh or adopted):
            continue
        seen.add(r["id"])
        tenant_ids = list(tenants_of.get(r["id"]) or [])
        pos = position(steps, day, r.get("status") or "", plans)
        if r["id"] in stopped:
            rows_out[r["id"]] = {"note": pos["note"], "short": pos["short"]}
            continue                                  # stopped by hand: nothing of the tenancy's is touched
        # The form cards first, before anything below can hold the tenancy back: a card Kevin sent is
        # finished, and one that is no longer wanted leaves his queue, whatever the bank data says.
        if pos["finish"]:
            finish(pos["last"], r["id"])
        if pos["withdraw"]:
            withdraw(pos["last"], pos["withdraw"], r["id"])
        settle_cards(r["id"], steps, pos["last"], "a newer step has taken over from this form card")
        if pos["short"] == "form card to check":
            problems.append(f"{place_name(r['unit'])}: {pos['note']}")
        # Once the form is in, any rent matched since is the direct payment starting: the clock
        # ends there (Kevin's map: "first payment matched"). A shortfall is not this lane's.
        # "In" means a paid check exists and was not cancelled. A form card never counts, whatever
        # its status: money matched while the form was being done is not the DWP's.
        form_in = [t for t in steps.get("paid") or [] if t["status"] != "Cancelled"]
        form_since = min(t["created"] for t in form_in) if form_in else None
        if form_in and any(p["day"] >= form_since for p in pays):
            end_clock(r["id"], steps, "a rent payment has been matched, so the direct payment has started")
            rows_out[r["id"]] = {"note": "a rent payment has been matched since the form went in: the direct payment has started",
                                 "short": "first rent matched"}
            continue
        since = (pos["last"]["created"] if pos["last"] else (began or day)) - timedelta(days=EARLY_PAY_DAYS)
        if landed(pays, since, rent, day):
            # Matched, not yet judged (the rent check waits for the due day plus 2). Nothing is
            # raised or closed on money that may be the rent.
            rows_out[r["id"]] = {"note": "a full rent payment is matched, waiting for the rent check to judge it",
                                 "short": "rent matched, being checked"}
            continue
        if pos["raise"] and pos["raise"][0] == "paid" and bank_hold(bank, since, rent):
            # Roy is about to be asked why no rent has come. Not while the bank data cannot say
            # that it has not: a stale feed, or money on the rent account still to be matched.
            rows_out[r["id"]] = {"note": pos["note"].replace(", asked again", "")
                                         + "; the next check waits until the bank data is matched and fresh",
                                 "short": "waiting on bank data"}
            continue
        rows_out[r["id"]] = {"note": pos["note"], "short": pos["short"]}
        row = dict(r, tenants=tenant_ids, note=pos["note"], since=form_since,
                   tenant=next((names[t] for t in tenant_ids if names.get(t)), ""))
        # The tenant is asked except on an existing void (one on the slate list), which is left alone.
        asking = r["lane"] != "existing"
        if pos["raise"] and pos["raise"][0] == "form":
            raise_out.append(form_task(row, day, pos["roy"], pos["raise"][1], pos["prior"],
                                       months_unpaid(began, dues.get(r["id"]), rent, pays, day)))
        elif pos["raise"]:
            step, n = pos["raise"]
            raise_out.append(roy_task(row, step, n, day, pos["first"]))
            # A first check tells Roy to look in 14 days: the tenant is asked then, not today.
            if asking and step in ("costs", "paid") and not pos["first"] and want_ask(r["id"], step, n):
                raise_out.append(ask_task(row, step, n, day))
        elif (asking and pos["last"] and pos["stage"] in ("costs", "paid") and pos["askFrom"] and day >= pos["askFrom"]
              and pos["last"]["status"] not in LEAVE_ALONE and want_ask(r["id"], pos["stage"], pos["last"]["n"])):
            # Roy's task is live and has no tenant draft (its create failed, or it was not due yet).
            raise_out.append(ask_task(row, pos["stage"], pos["last"]["n"], day))
        if pos["close"]:
            close(pos["close"], pos["why"], r["id"])
        # Any older task at one of Roy's steps still open is finished business. Not when the clock
        # was stopped by hand: then nothing of the tenancy's is touched.
        for step in ROY_STEPS if pos["last"] else ():
            for t in steps.get(step) or []:
                if t["id"] != pos["last"]["id"]:
                    close(t, "a later check has taken over from this one", r["id"])
    for tenancy, steps in grouped.items():
        if tenancy in ended:
            # A card Kevin sent still gets its comment after the clock has ended (its finish may have
            # failed in the run that wrote the end line), and nothing else of the tenancy's is touched.
            finish_sent(tenancy, steps)
            continue
        if tenancy in seen or tenancy in stopped:
            continue
        lane = lanes.get(tenancy)
        status = status_of.get(tenancy)
        # The tenancy has moved on: it is paying, it is not live today, or somebody has marked it
        # something other than a cash flow void. A card Kevin sent gets its comment; one still open
        # leaves his queue, so no form is sent for a tenancy that no longer needs one. "Cannot tell" on
        # a tenancy still marked CFV is not moving on: its card waits.
        moved = (" is not a live tenancy today" if lane is None else " reads as paying" if lane in ("fine", "short")
                 else f" is marked {status or 'with no payment status'}" if status not in (None, CFV) else "")
        if lane in ("fine", "short") and paid.get(tenancy):
            # Cannot tell is not "paid", and neither is In Payment with nothing matched.
            end_clock(tenancy, steps, "rent has reached the bank, nothing more to do")
            continue
        if moved:
            settle_cards(tenancy, steps, None, "the tenancy" + moved + ", so no form is needed")
        else:
            # Still a cash flow void the rent check cannot judge today: nothing is raised, but its form
            # card is still kept straight (an out-of-date or sent-back card leaves his queue).
            keep_straight(tenancy, steps, status)
        leaving = {w["id"] for w in withdraw_out}
        live = [t for rows in steps.values() for t in rows if t["status"] not in LEAVE_ALONE and t["id"] not in leaving]
        count = f"{len(live)} open task{' carries' if len(live) == 1 else 's carry'} a key for {tenancy}"
        if not live or lane == "unknown":
            continue                                  # nothing open to say anything about; cannot tell is not news
        elif lane in ("fine", "short"):
            problems.append(f"{count}, which reads as paying with no rent matched to it yet; left as they are")
        elif lane is None:
            # A tenancy that has ended, one not started yet, or a mistyped key. Said, never acted on.
            problems.append(f"{count}, which is not a live tenancy today; left as they are")
        elif status_of.get(tenancy) not in (CFV, CFV_ACTIONED):
            problems.append(f"{count}, which is no longer marked a cash flow void; left as they are")
    return {"rows": rows_out, "raise": raise_out, "close": close_out, "problems": problems, "stopped": stopped,
            "finish": finish_out, "withdraw": withdraw_out}


def annotate(res, rows):
    """Put each lane B tenancy's stage on its row: the whole of it in the note, and the few words
    the Home line has room for in `stage`."""
    for r in res["tenancies"]:
        if r["id"] in rows:
            r["note"] = f"{r['note']}; {rows[r['id']]['note']}"
            r["setup"] = rows[r["id"]]["note"]
            r["stage"] = rows[r["id"]]["short"]


# ─── reads and writes (the rent check passes its own Airtable helpers in) ──
_MODS = {}


def module(key):
    """agent-dispatch.py (Roy's address and row, the Assignee field), loaded once."""
    files = {"ad": "agent-dispatch.py"}
    if key not in _MODS:
        spec = importlib.util.spec_from_file_location("rnt_" + key, os.path.join(HERE, files[key]))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        _MODS[key] = m
    return _MODS[key]


def notify_roy(task_id, to):
    """Email one of Roy's tasks to him through send-email.py notify, as agent-dispatch.py's own
    handover does. Returns what notify printed: {"notified": ...} or {"skipped": ..., "event": ...}.
    Safe to repeat: notify's ledger skips a task whose email went, or may have."""
    try:
        done = subprocess.run([sys.executable, os.path.join(HERE, "send-email.py"), "notify", task_id,
                               "--to", to, "--reason", HANDOVER_REASON],
                              check=True, capture_output=True, text=True, timeout=90)
    except subprocess.CalledProcessError as exc:
        said = (exc.stdout or exc.stderr or "").strip().splitlines()
        raise RuntimeError(said[-1][:200] if said else f"exit {exc.returncode}")
    lines = [ln for ln in (done.stdout or "").splitlines() if ln.strip().startswith("{")]
    try:
        return json.loads(lines[-1]) if lines else {}
    except ValueError:
        return {}


def cut_off(result):
    """True when notify skipped a task because an earlier send was cut off part way: it may never
    have left, and it is never sent twice."""
    return bool(result.get("skipped")) and result.get("event") in ("intent", "uncertain")


def read_tasks(rc):
    """Every task that carries a lane B key, whatever its status: the Completed ones are the clock."""
    out = []
    fields = [rc.TK[k] for k in ("name", "status", "notes", "description", "tenancies")] + [COMPLETION_FIELD, OUTCOME_FIELD,
                                                                                          FEEDBACK_FIELD, SOME_DAY_FIELD]
    # The same spellings SETUP_KEY_RE reads (any case, any spacing or none, a pasted non-breaking
    # space), so a hand-typed key is always fetched; key_lines() then reads it or says it cannot.
    formula = ("OR(REGEX_MATCH(UPPER({Notes}), 'SETUP[^A-Z0-9]*KEY'), "
               "REGEX_MATCH(UPPER({Description}), 'SETUP[^A-Z0-9]*KEY'))")
    for rec in rc.fetch_all(rc.T_TASKS, {"fields[]": fields, "filterByFormula": formula}):
        f = rec.get("fields") or {}
        made = rc.parse_stamp(rec.get("createdTime")) or datetime.now(timezone.utc)
        done = rc.parse_stamp(f.get(COMPLETION_FIELD)) if f.get(COMPLETION_FIELD) else None
        out.append({"id": rec["id"], "name": str(f.get(rc.TK["name"]) or ""), "notes": str(f.get(rc.TK["notes"]) or ""),
                    "description": str(f.get(rc.TK["description"]) or ""), "status": rc.sel(f.get(rc.TK["status"])),
                    "tenancies": list(f.get(rc.TK["tenancies"]) or []), "outcome": rc.sel(f.get(OUTCOME_FIELD)),
                    "feedback": str(f.get(FEEDBACK_FIELD) or ""), "someDay": bool(f.get(SOME_DAY_FIELD)),
                    "made": made, "created": made.astimezone(LONDON).date(),
                    "completed": (done.astimezone(LONDON).date() if done and done.tzinfo
                                  else rc.parse_day(f.get(COMPLETION_FIELD)) if f.get(COMPLETION_FIELD) else None)})
    return out


def read_names(rc, tenant_ids):
    if not tenant_ids:
        return {}
    formula = "OR(" + ",".join(f"RECORD_ID()='{t}'" for t in sorted(tenant_ids)) + ")"
    return {r["id"]: str((r.get("fields") or {}).get(TENANT_NAME_FIELD) or "")
            for r in rc.fetch_all(rc.T_TENANTS, {"fields[]": [TENANT_NAME_FIELD], "filterByFormula": formula})}


class NotReady(Exception):
    """A form card cannot be raised yet because a record is blank: said on the row, not a failed run."""


def call_in_process(fn, *a, **k):
    """Run another script's command in this process (as scripts/tenant-leads.py does). Returns its
    last JSON line; raises on a refusal."""
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            rc_ = fn(*a, **k)
    except SystemExit as exc:
        if exc.code not in (0, None):
            raise RuntimeError(f"{exc.code if not isinstance(exc.code, int) else 'exit ' + str(exc.code)} "
                               f"{buf.getvalue()[-300:]}".strip())
        rc_ = 0
    if isinstance(rc_, int) and rc_ != 0:
        raise RuntimeError(f"exit {rc_}: {buf.getvalue()[-300:]}")
    lines = [ln for ln in buf.getvalue().splitlines() if ln.strip().startswith("{")]
    return json.loads(lines[-1]) if lines else {}


def _one(rc, table, rec_id, fields):
    got = rc.api("GET", table, params={"filterByFormula": f"RECORD_ID()='{rec_id}'", "pageSize": 1,
                                       "returnFieldsByFieldId": "true", "fields[]": fields}).get("records") or []
    if len(got) != 1:
        raise RuntimeError(f"{rec_id} could not be read from {table}")
    return got[0].get("fields") or {}


def read_form_records(rc, tenancy_id):
    """The tenancy, its tenant and its property, as the form needs them."""
    ty = _one(rc, rc.T_TENANCIES, tenancy_id, [rc.TY["rent"], "fld5O24mC8vOezjXK", rc.TY["tenants"], "fld7cjLLEHKAx49OK"])
    tenant_id = (ty.get(rc.TY["tenants"]) or [""])[0]
    unit_id = (ty.get("fld7cjLLEHKAx49OK") or [""])[0]
    tn = _one(rc, rc.T_TENANTS, tenant_id, [TENANT_NAME_FIELD, "fldv7FKsqXYswyCFE"]) if tenant_id else {}
    unit = _one(rc, "tblM3mZCR5kiEdWMj", unit_id, ["fldUJNRGgzgyAwwjt"]) if unit_id else {}
    prop_id = (unit.get("fldUJNRGgzgyAwwjt") or [""])[0]
    pr = _one(rc, "tbl6f0OkAmTC2jbuG", prop_id, ["fldy2t735TV5e1DIL", "fld6ebSQgD7eRsobd", "fldYLRz2GgVojKaq9"]) if prop_id else {}
    return {"tenancy": {"id": tenancy_id, "rent": ty.get(rc.TY["rent"]), "frequency": rc.sel(ty.get("fld5O24mC8vOezjXK"))},
            "tenant": {"id": tenant_id or "(none linked)", "name": tn.get(TENANT_NAME_FIELD), "dob": tn.get("fldv7FKsqXYswyCFE")},
            "property": {"id": prop_id or "(none linked)", "address": pr.get("fldy2t735TV5e1DIL"),
                         "postcode": pr.get("fld6ebSQgD7eRsobd"), "area": pr.get("fldYLRz2GgVojKaq9")}}


def read_landlord(path=None):
    """The landlord's details for the form, from the private file on the Mac (no bank numbers)."""
    try:
        with open(path or LANDLORD_PATH) as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        raise NotReady(f"the private landlord file could not be read ({str(exc)[:80]})")


def _plan_path(ad, task_id):
    return os.path.join(ad.HANDOVER_DIR, task_id + ".json")


def drop_plan(ad, task_id):
    """Remove a form card's robot plan (it holds the tenant's details), the copy the Robot sign-in app
    files under done/ when Kevin finishes, and the window's screenshots under shots/ (they show the
    same answers): once the card is finished or withdrawn there is no window to open."""
    path = _plan_path(ad, task_id)
    if os.path.exists(path):
        os.unlink(path)
    for folder, ext in (("done", ".json"), ("shots", ".png")):
        where = os.path.join(ad.HANDOVER_DIR, folder)
        for name in (os.listdir(where) if os.path.isdir(where) else []):
            if name.startswith(task_id + "-") and name.endswith(ext):
                os.unlink(os.path.join(where, name))


def raise_form(rc, item, day):
    """Raise the form card: build the answers and the robot's plan from the records, create the
    card under the Cash Flow Voids agent, put the plan where the Your turn button finds it, and
    submit the card to Kevin's queue with its KEVIN ONLY step. A blank record raises nothing, and
    neither does a card Kevin asked to change whose answers have not changed (until
    CHANGES_WAIT_DAYS have passed). A refused submit withdraws the card, so the next run raises
    it again; if even that write fails, the next run finds it outside his queue and does the same."""
    import rent_form_plan                          # here, so lane B runs without it until a form is due
    ad = module("ad")
    rec = read_form_records(rc, item["tenancy"])
    built = rent_form_plan.build(rec["tenancy"], rec["tenant"], rec["property"], read_landlord(), place=item["place"],
                                 arrears=item.get("arrears"))
    if built["missing"]:
        raise NotReady(f"form card for {item['place']} not raised yet, blank: " + "; ".join(built["missing"]))
    mark = rent_form_plan.fingerprint(built["answers"])
    prior = item.get("prior")
    if prior and prior.get("print") == mark and day < prior["on"] + timedelta(days=CHANGES_WAIT_DAYS):
        raise NotReady(f"form card for {item['place']} not raised again yet: Kevin asked for changes on "
                       f"{prior['on'].strftime('%-d %b')} and no answer read from the records has changed; it is raised "
                       f"again once one does, or on {(prior['on'] + timedelta(days=CHANGES_WAIT_DAYS)).strftime('%-d %b')}")
    notes = item["notes"] + "\n" + FORM_ANSWERS_MARK + mark
    if built["plan"].get("validUntil"):
        notes += "\n" + FORM_GOOD_UNTIL_MARK + built["plan"]["validUntil"]
    fields = {rc.TK["name"]: item["name"], rc.TK["status"]: "Today", rc.TK["due"]: day.isoformat(),
              rc.TK["description"]: (f"The DWP direct rent payment form for {item['tenant']} at {item['place']}, raised by "
                                     f"the daily rent check on {day.strftime('%-d %b %Y')} after Roy said the housing "
                                     "costs are verified. The card's own words list every answer and its record.\n\n"
                                     "Reference for the rent check, please leave it in:\n" + item["notes"]),
              rc.TK["notes"]: notes, rc.TK["tenancies"]: [item["tenancy"]],
              rc.TK["teamMember"]: [rc.AGENT_TEAM_MEMBER]}
    if item["tenants"]:
        fields[rc.TK["tenants"]] = item["tenants"]
    tid = rc.api("POST", rc.T_TASKS, {"records": [{"fields": fields}]})["records"][0]["id"]
    plan_path = _plan_path(ad, tid)
    try:
        os.makedirs(ad.HANDOVER_DIR, exist_ok=True)
        tmp = plan_path + ".tmp"
        with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh:
            json.dump(built["plan"], fh, indent=2)
        os.replace(tmp, plan_path)
        text = rent_form_plan.card_text(built["answers"], item["tenant"], item["place"], item["royWords"], item["royDay"],
                                        prior and {"on": prior["on"].strftime("%-d %b %Y"), "feedback": prior.get("feedback")})
        # The card's words name the tenant: the file is the owner's alone, and gone once submitted.
        out_path = os.path.join(ad.HANDOVER_DIR, tid + ".card.md")
        with os.fdopen(os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh:
            fh.write(text)
        try:
            call_in_process(ad.cmd_submit, argparse.Namespace(
                task=tid, agent=rc.AGENT_TEAM_MEMBER, type="Admin", output_file=out_path,
                plain_task=f"The DWP direct rent payment form for {item['tenant']}, filled from the records and waiting for you.",
                plain_approve="Approving gives you the Your turn button: the robot fills the form, you choose the reason and send.",
                tier1=False, siblings=None, coverage=None, receipt=None, attach=None))
        finally:
            os.unlink(out_path)
    except Exception as exc:
        if os.path.exists(plan_path):
            os.unlink(plan_path)
        try:
            # Read back and appended to, never overwritten: a wall the submit opened is cleared with it.
            withdraw_form(rc, {"id": tid, "tenancy": item["tenancy"],
                               "why": f"{SUBMIT_FAILED}: {' '.join(str(exc).split())[:300]}"}, day)
            gone = "withdrawn, the next run raises it again"
        except Exception:                                 # noqa: BLE001 — said in the error below
            gone = "and could not be withdrawn; the next run withdraws it and raises it again"
        raise RuntimeError(f"{item['label']} could not be submitted ({tid} {gone}): {str(exc)[:200]}")
    return tid


def withdraw_form(rc, item, day):
    """Withdraw a form card: cancel it with a WITHDRAWN line saying why (so the clock raises the next
    card, where a cancel by hand would stop it), clear its Your turn wall in the same write (an open
    wall on a cancelled card would ask Kevin for a step that no longer exists) and remove its plan.
    Never a card Kevin has said he sent. True when something was written."""
    ad = module("ad")
    card = _one(rc, rc.T_TASKS, item["id"], [rc.TK["notes"], rc.TK["description"], rc.TK["status"]])
    notes = str(card.get(rc.TK["notes"]) or "")
    if not notes.strip() or FORM_KEY_MARK not in notes + str(card.get(rc.TK["description"]) or ""):
        raise RuntimeError(f"{item['id']} read back with blank Notes or no form key; nothing written")
    if kevin_sent(notes):
        raise RuntimeError(f"{item['id']} carries Kevin's word that he sent the form, so it is not withdrawn")
    status = rc.sel(card.get(rc.TK["status"]))
    if status == "Cancelled" and withdrawal(notes):
        drop_plan(ad, item["id"])
        return False
    lines = []
    wall = ad.task_blocker(notes)
    if wall:
        stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
        lines.append(ad.blocker_note(stamp, "rent-check", ad.BLOCKER_CLEARED_MARK, wall,
                                     f"withdrawn: {item['why'][:200]}"))
    lines.append(FORM_WITHDRAWN_MARK + day.isoformat() + " " + " ".join(str(item["why"]).split())[:400])
    rc.api("PATCH", rc.T_TASKS, {"records": [{"id": item["id"], "fields": {
        rc.TK["status"]: "Cancelled", rc.TK["notes"]: (notes.rstrip() + "\n\n" + "\n".join(lines))[-90000:]}}]})
    drop_plan(ad, item["id"])
    return True


def clear_wall(rc, task_id, day):
    """A closed form card (cancelled or closed by hand, or rejected) whose Your turn step is still open:
    the step is cleared and nothing else changes. agent-dispatch.py blockers_scan reads every task that
    is not Completed, so an open step on a cancelled card would ask Kevin for a turn that no longer
    exists, red after three days, for ever. True when something was written."""
    ad = module("ad")
    card = _one(rc, rc.T_TASKS, task_id, [rc.TK["notes"], rc.TK["description"], rc.TK["status"]])
    notes = str(card.get(rc.TK["notes"]) or "")
    if not notes.strip() or FORM_KEY_MARK not in notes + str(card.get(rc.TK["description"]) or ""):
        raise RuntimeError(f"{task_id} read back with blank Notes or no form key; nothing written")
    if rc.sel(card.get(rc.TK["status"])) not in ("Completed", "Cancelled") or not open_kevin_wall(notes):
        return False
    stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")
    line = ad.blocker_note(stamp, "rent-check", ad.BLOCKER_CLEARED_MARK, ad.task_blocker(notes),
                           f"the card was closed on {day.strftime('%-d %b %Y')}, so this step is no longer Kevin's")
    rc.api("PATCH", rc.T_TASKS, {"records": [{"id": task_id, "fields": {
        rc.TK["notes"]: (notes.rstrip() + "\n\n" + line)[-90000:]}}]})
    return True


def finish_form(rc, item, day):
    """Kevin said he sent the form. In this order, each step once: mark the card sent and complete
    it; comment on the tenancy and mark the card COMMENTED; then, if the tenancy is still a cash
    flow void, mark it CFV Actioned. The comment comes before the status, so a failed status change
    is retried without a second comment, and a tenancy someone else has moved on still gets the
    record. Returns the tenancy's status afterwards. The only tenancy writes lane B ever makes, and
    only on Kevin's own confirmation."""
    card = _one(rc, rc.T_TASKS, item["id"], [rc.TK["notes"], rc.TK["description"], rc.TK["status"]])
    notes = str(card.get(rc.TK["notes"]) or "")
    if not notes.strip() or FORM_KEY_MARK not in notes + str(card.get(rc.TK["description"]) or ""):
        raise RuntimeError(f"{item['id']} read back with blank Notes or no form key; nothing written")
    if not kevin_sent(notes):
        raise RuntimeError(f"{item['id']} does not carry Kevin's word that he sent the form; nothing written")
    drop_plan(module("ad"), item["id"])
    if FORM_SENT_MARK not in notes:
        notes = (notes.rstrip() + "\n\n" + f"{FORM_SENT_MARK}Kevin confirmed in the Robot sign-in app that he sent the "
                 f"form (seen {day.strftime('%-d %b %Y')}).")[-90000:]
        fields = {rc.TK["notes"]: notes}
        if rc.sel(card.get(rc.TK["status"])) != "Cancelled":      # a card he cancelled by hand stays cancelled
            fields.update({rc.TK["status"]: "Completed",
                           COMPLETION_FIELD: datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")})
        rc.api("PATCH", rc.T_TASKS, {"records": [{"id": item["id"], "fields": fields}]})
    ty = _one(rc, rc.T_TENANCIES, item["tenancy"], [rc.TY["payStatus"]])
    status = rc.sel(ty.get(rc.TY["payStatus"]))
    if FORM_COMMENTED_MARK not in notes:
        then = {CFV: "Marked CFV Actioned by the daily rent check on his confirmation. Roy is asked to check the "
                     "payment 14 days on.",
                CFV_ACTIONED: "The tenancy was already marked CFV Actioned. Roy is asked to check the payment 14 days on."
                }.get(status, f"The tenancy reads '{status or 'blank'}', so the rent check left its status as it is.")
        rc.api("POST", f"{rc.T_TENANCIES}/{item['tenancy']}/comments", {
            "text": (f"Direct rent payment form sent to the DWP by Kevin ({day.strftime('%-d %b %Y')}, form card "
                     f"{item['id']}). {then}")})
        notes = (notes.rstrip() + "\n" + f"{FORM_COMMENTED_MARK}tenancy {item['tenancy']}, "
                 f"{day.strftime('%-d %b %Y')}")[-90000:]
        rc.api("PATCH", rc.T_TASKS, {"records": [{"id": item["id"], "fields": {rc.TK["notes"]: notes}}]})
    if status == CFV and FORM_ACTIONED_MARK not in notes:
        rc.api("PATCH", rc.T_TENANCIES, {"records": [{"id": item["tenancy"], "fields": {rc.TY["payStatus"]: CFV_ACTIONED}}]})
        status = CFV_ACTIONED
    if status == CFV_ACTIONED and FORM_ACTIONED_MARK not in notes:
        # Marked once: if somebody later sets the tenancy back to CFV, that is theirs and stays.
        notes = (notes.rstrip() + "\n" + f"{FORM_ACTIONED_MARK}tenancy {item['tenancy']}, {day.strftime('%-d %b %Y')}")[-90000:]
        rc.api("PATCH", rc.T_TASKS, {"records": [{"id": item["id"], "fields": {rc.TK["notes"]: notes}}]})
    return status


def raise_one(rc, item, day):
    """One direct create (the inbox task gate folds by words and cannot tell one check from the
    next). Roy's task is created already his, so it is never ownerless for an agent to pick up,
    then emailed. If the email fails the task stays: the next run offers it to notify again."""
    if item["kind"] == "form":
        return raise_form(rc, item, day)
    fields = {rc.TK["name"]: item["name"], rc.TK["status"]: "Today", rc.TK["due"]: (item.get("due") or day).isoformat(),
              rc.TK["description"]: item["description"], rc.TK["notes"]: item["notes"],
              rc.TK["tenancies"]: [item["tenancy"]]}
    if item["tenants"]:
        fields[rc.TK["tenants"]] = item["tenants"]
    ad = None
    if item["kind"] == "ask":
        fields[rc.TK["teamMember"]] = [rc.AGENT_TEAM_MEMBER]
    else:
        ad = module("ad")                              # before the create: a failed load writes nothing
        fields[rc.TK["teamMember"]] = [ad.HUMANS[ad.ROY_EMAIL]["rec"]]
        fields[ad.AF["assignee"]] = {"email": ad.ROY_EMAIL}
    tid = rc.api("POST", rc.T_TASKS, {"records": [{"fields": fields}]})["records"][0]["id"]
    if ad:
        try:
            notify_roy(tid, ad.ROY_EMAIL)
        except Exception as exc:
            raise RuntimeError(f"{item['label']} was created ({tid}) but its email to Roy failed; the next run offers "
                               f"it again: {str(exc)[:160]}")
    return tid


def finish_one(rc, item, day):
    """Close a task, write the end line on it, or both; True when something was written. Read back first, by id through the table
    list: a Notes field that reads back without the key line it was found by is a broken read,
    and nothing is written over it. A task that is finished, stopped or waiting on Kevin keeps its
    status."""
    rec = rc.api("GET", rc.T_TASKS, params={"filterByFormula": f"RECORD_ID()='{item['id']}'", "pageSize": 1,
                                            "returnFieldsByFieldId": "true",
                                            "fields[]": [rc.TK["notes"], rc.TK["description"], rc.TK["status"]]})["records"]
    if len(rec) != 1:
        raise RuntimeError(f"{item['id']} could not be read back")
    f = rec[0].get("fields") or {}
    notes = str(f.get(rc.TK["notes"]) or "")
    # Every task this file acts on has words in its Notes (its key line, Roy's replies). Blank is a
    # broken read even when the key is also in the Description: appending to it would wipe them.
    if not notes.strip() or not SETUP_KEY_RE.search(notes + "\n" + str(f.get(rc.TK["description"]) or "")):
        raise RuntimeError(f"{item['id']} read back with blank Notes or no key line; nothing written")
    lines, fields = [], {}
    if item["complete"] and rc.sel(f.get(rc.TK["status"])) not in LEAVE_ALONE:
        lines.append(f"[{day.strftime('%d %b %Y')} {CLOSED_BY_RULE}{item['why']}.")
        fields.update({rc.TK["status"]: "Completed",
                       COMPLETION_FIELD: datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")})
    if item["end"] and ENDED_MARK not in notes:
        lines.append(f"{ENDED_MARK}rent reached the bank, seen {day.strftime('%-d %b %Y')}. The new-tenant clock is "
                     "finished for this tenancy. Late rent is chased again once it is marked In Payment.")
    if not lines:
        return False
    fields[rc.TK["notes"]] = (notes.rstrip() + "\n\n" + "\n".join(lines)).strip()[-90000:]
    rc.api("PATCH", rc.T_TASKS, {"records": [{"id": item["id"], "fields": fields}]})
    return True


def lane_b(rc, res, data, day, writes, on):
    """Plan and (on a real run) make today's lane B moves, and put each stage on its row. Never
    stops the rent check: a failure is said on the row and in the exit code, and one failed write
    does not stop the others. `on` is the Cash Flow Voids register switch the rent check already
    read: False raises nothing, None means it could not be read."""
    out = {"on": on, "raised": [], "planned": [], "closed": [], "problems": [], "failed": ""}
    fails = []
    try:
        tasks = read_tasks(rc)
        tenants_of = {r["id"]: list((r.get("fields") or {}).get(rc.TY["tenants"]) or []) for r in data["tenancies"]}
        starts = {r["id"]: rc.parse_day((r.get("fields") or {}).get(rc.TY["start"])) for r in data["tenancies"]}
        dues = {r["id"]: rc.sel((r.get("fields") or {}).get(rc.TY["dueDay"])) for r in data["tenancies"]}
        wanted = {t for r in res["tenancies"] for t in tenants_of.get(r["id"], [])}
        pays = rc.payments_by_tenancy(data["tx"])
        ad = module("ad")
        # The form cards whose robot plan is on file: an approved card without one has no Your turn button.
        held_plans = ({f[:-5] for f in os.listdir(ad.HANDOVER_DIR) if f.endswith(".json")}
                      if os.path.isdir(ad.HANDOVER_DIR) else set())
        todo = plan(res, tasks, tenants_of, read_names(rc, wanted), day, starts, pays,
                    rc.feed_state(data, pays, datetime.now(timezone.utc)), held_plans, dues)
        annotate(res, todo["rows"])
        out["problems"] = list(todo["problems"])
        if not on:
            return out
        out["planned"] = ([w["label"] for w in todo["withdraw"]] + [t["label"] for t in todo["raise"]]
                          + [("end: " if c["end"] and not c["complete"] else "close: ") + c["id"] for c in todo["close"]]
                          + [f["label"] for f in todo["finish"]])
        if not writes:
            return out
        # Roy's open tasks are offered to notify every run: one whose email was refused gets it now.
        # Only for a tenancy still on the clock: never one that has ended (or ends in this run), one on
        # the do-not-chase list, or a task this run is about to close.
        active = set(todo["rows"]) - todo["stopped"]
        closing = {c["id"] for c in todo["close"]}      # a clock that ends now closes every open task of Roy's
        unsent = [t for t in tasks if t["name"].startswith(ROY_PREFIX) and t["status"] not in LEAVE_ALONE
                  and t["id"] not in closing
                  and any(k[0] in active for k in task_keys(t["notes"], t["description"]))]
        if unsent:
            for t in unsent:
                try:
                    if cut_off(notify_roy(t["id"], ad.ROY_EMAIL)):
                        out["problems"].append(f"the email of task {t['id']} to Roy was cut off part way and may not "
                                               "have gone; it is not sent twice, and the question is asked again as a "
                                               "new task if he does not reply")
                except Exception as exc:              # noqa: BLE001 — collected, said on the row
                    # notify checks the task's words before its ledger, so a task already emailed can be
                    # refused later for a word Roy added. That is a note, not a failed run.
                    if "REFUSED" in str(exc):
                        out["problems"].append(f"task {t['id']} was refused by the email gate: {str(exc)[:120]}")
                    else:
                        fails.append(f"{t['id']} could not be emailed to Roy: {str(exc)[:120]}")
        held = set()
        # Withdrawn first: a card that cannot be withdrawn is not raised again beside it.
        for item in todo["withdraw"]:
            try:
                if withdraw_form(rc, item, day):
                    out["closed"].append(item["id"])
            except Exception as exc:                  # noqa: BLE001
                held.add(item["tenancy"])
                fails.append(f"form card {item['id']} could not be withdrawn: {str(exc)[:200]}")
        # Kevin's sent forms next, before any end line: a tenancy whose finish fails is held this run.
        for item in todo["finish"]:
            try:
                status = finish_form(rc, item, day)
                out["closed"].append(item["id"])
                if status != CFV_ACTIONED:
                    out["problems"].append(f"form card {item['id']} is sent but the tenancy reads '{status or 'blank'}', "
                                           "so its status was left as it is")
            except Exception as exc:                  # noqa: BLE001
                held.add(item["tenancy"])
                fails.append(str(exc)[:240])
        for item in todo["raise"]:
            if item["tenancy"] in held:
                continue                              # Roy's task was not raised: no tenant draft without it
            try:
                raise_one(rc, item, day)
                out["raised"].append(item["label"])
            except NotReady as exc:
                held.add(item["tenancy"])
                out["problems"].append(str(exc)[:240])
            except Exception as exc:                  # noqa: BLE001
                held.add(item["tenancy"])
                fails.append(str(exc)[:240])
        # Plain closes first, the end line last: a tenancy one of whose closes failed is not ended,
        # or its open task would be stranded behind an end line for good.
        for item in sorted(todo["close"], key=lambda c: c["end"]):
            if item["tenancy"] in held:
                continue                              # its next task was not raised, or a close failed
            try:
                if finish_one(rc, item, day):
                    out["closed"].append(item["id"])
            except Exception as exc:                  # noqa: BLE001
                held.add(item["tenancy"])
                fails.append(str(exc)[:240])
        # A finished, withdrawn or rejected card's plan holds the tenant's details and opens nothing, and a
        # card closed by hand must not keep asking Kevin for his turn.
        for t in tasks:
            if is_form_card(t) and (t["status"] in ("Completed", "Cancelled") or str(t.get("outcome") or "").startswith("Rejected")):
                try:
                    drop_plan(ad, t["id"])
                except OSError as exc:
                    fails.append(f"the robot plan of form card {t['id']} could not be removed: {str(exc)[:120]}")
            if is_form_card(t) and t["status"] in ("Completed", "Cancelled") and open_kevin_wall(t.get("notes")):
                try:
                    clear_wall(rc, t["id"], day)
                except Exception as exc:              # noqa: BLE001
                    fails.append(f"the Your turn step of closed form card {t['id']} could not be cleared: {str(exc)[:120]}")
    except Exception as exc:                          # noqa: BLE001 — said on the row, never swallowed
        fails.append(str(exc)[:300])
    out["failed"] = "; ".join(fails)[:600]
    return out


def lane_b_line(setup):
    check = (" Check: " + "; ".join(setup["problems"]) + ".") if setup.get("problems") else ""
    if setup["failed"]:
        return f"New-tenant tasks FAILED: {setup['failed']}{check}"
    if setup["on"] is None:
        return f"New-tenant tasks: not run, the Cash Flow Voids agent's switch could not be read.{check}"
    if not setup["on"]:
        return f"New-tenant tasks: none raised, the Cash Flow Voids agent is switched off.{check}"
    done = ["raised: " + "; ".join(setup["raised"])] if setup["raised"] else []
    done += ["closed or ended: " + "; ".join(setup["closed"])] if setup["closed"] else []
    if done:
        return "New-tenant tasks " + ". ".join(done) + "." + check
    if setup["planned"]:
        return "New-tenant tasks a real run would make: " + "; ".join(setup["planned"]) + "." + check
    return "New-tenant tasks: none needed today." + check
