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
  form      Roy's yes: the direct rent payment form is due. Nothing here raises the form: this
            file only says so on the Rent line. The form having gone in is read from ONE thing:
            the tenancy being marked "CFV Actioned" (whatever Roy last said about the housing
            costs). A task keyed `form` is the form route's card, for a later change; here it only
            reads "form in progress", whatever its status.
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
agent (scripts/agent_email_format.py). It drafts nothing to the DWP: contacting the DWP is Roy's
alone (Kevin, 2 Oct 2026). It changes no tenancy, tenant or payment status. It closes only tasks
at Roy's own steps (journal, costs, paid), never a form card and never a task at Approval.

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

import importlib.util
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
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


def position(steps, day, status=""):
    """Where one tenancy is, from its keyed tasks. Pure.

    Returns {"stage", "note", "short", "raise": (step, n) or None, "first", "close": task or None,
    "why", "last", "askFrom"}. `raise` is the next task to create today. `close` is the newest
    task when it is finished and still open. `short` is the few words the Home line carries.
    The furthest step with a task decides, so an adopted `paid` task skips the earlier ones."""
    def out(stage, note, short, raise_=None, close=None, why=ANSWERED, last=None, first=False, ask_from=None):
        return {"stage": stage, "note": note, "short": short, "raise": raise_, "close": close, "why": why,
                "last": last, "first": first, "askFrom": ask_from}

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
    if last["status"] == "Cancelled":
        # Somebody stopped this by hand. Raising it again tomorrow would undo their decision.
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
        # A form card is the form route's own, raised by a later change. Whatever its status (a
        # rejected card is Completed too), this file reads "the form has gone in" only from the
        # tenancy being marked actioned, and never closes or reads the card.
        if actioned:
            return out("form", "form sent (the tenancy is marked actioned), so the first check on the direct "
                               "payment is next", "form sent, awaiting rent", ("paid", 1), last=last, first=True)
        return out("form", "the direct rent payment form is being done", "form in progress", last=last)
    if step == "costs":
        if said == YES:
            quoted = " ".join(str(said_words or "").split())[:90]
            return out("costs", f"housing costs verified ({said_on.strftime('%-d %b')}, Roy: \"{quoted}\"), the direct "
                                "rent payment form is due",
                       "form due", None, spare, last=last)
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


def plan(res, tasks, tenants_of, names, day, starts=None, paid=None, bank=None):
    """Today's lane B moves. Pure: no reads, no writes.

    `res` is the rent check's result. `tasks` are the keyed tasks ({id, name, notes, description,
    status, created, made, completed, tenancies}). `tenants_of` maps a tenancy to its tenant ids,
    `names` a tenant id to a name, `starts` a tenancy to the day it began, and `paid` maps a
    tenancy to its matched rent payments ([{day, amount}], rent-check.py payments_by_tenancy).
    `bank` is what the bank data can support today ({"blocked": [why], "waiting": [{day, amount}]},
    rent-check.py feed_state). Returns {"rows": {tenancy: {note, short}}, "raise":
    [task], "close": [{id, why, complete, end, tenancy}], "problems": [text]}."""
    starts, paid, bank = starts or {}, dict(paid or {}), bank or {}
    grouped, asks, problems, stuck = group_tasks(tasks)
    status_of = {r["id"]: r.get("status") or "" for r in res["tenancies"]}
    lanes = res.get("lanes") or {}
    ended = {tenancy for tenancy, steps in grouped.items()
             if any(ENDED_MARK in str(t.get("notes") or "") for rows in steps.values() for t in rows)}
    rows_out, raise_out, close_out = {}, [], []
    seen = set()
    stopped = {tenancy for tenancy, steps in grouped.items() if position(steps, day)["short"] == "stopped by hand"}

    def close(task, why, tenancy):
        if task["status"] not in LEAVE_ALONE and task["id"] not in {c["id"] for c in close_out}:
            close_out.append({"id": task["id"], "name": task["name"], "why": why, "complete": True, "end": False,
                              "tenancy": tenancy})

    def want_ask(tenancy, step, n):
        return (tenancy, step, n) not in asks

    def end_clock(tenancy, steps, why):
        """Close Roy's open tasks and put the end line on the newest keyed task."""
        for step in ROY_STEPS:
            for t in steps.get(step) or []:
                close(t, why, tenancy)
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
            continue                                  # the rent check has already said so on the row
        if (new or (void and steps)) and r["id"] in stuck:
            # A task for this tenancy carries a key that cannot be used. Anything raised now could
            # be a twin of that task (a fresh journal, or the next check beside a hand one), so
            # nothing is, at any step, until the key is fixed. The key is said in the problems.
            rows_out[r["id"]] = {"note": "a task carries a key for this tenancy that cannot be used, so nothing is raised "
                                         "until it is fixed", "short": "key to fix"}
            seen.add(r["id"])
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
        pos = position(steps, day, r.get("status") or "")
        if r["id"] in stopped:
            rows_out[r["id"]] = {"note": pos["note"], "short": pos["short"]}
            continue                                  # stopped by hand: nothing of the tenancy's is touched
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
        if pos["raise"]:
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
        if tenancy in seen or tenancy in ended or tenancy in stopped:
            continue
        lane = lanes.get(tenancy)
        every = [t for rows in steps.values() for t in rows]
        live = [t for t in every if t["status"] not in LEAVE_ALONE]
        count = f"{len(live)} open task{' carries' if len(live) == 1 else 's carry'} a key for {tenancy}"
        if lane in ("fine", "short") and paid.get(tenancy):
            # Cannot tell is not "paid", and neither is In Payment with nothing matched.
            end_clock(tenancy, steps, "rent has reached the bank, nothing more to do")
        elif not live or lane == "unknown":
            continue                                  # nothing open to say anything about; cannot tell is not news
        elif lane in ("fine", "short"):
            problems.append(f"{count}, which reads as paying with no rent matched to it yet; left as they are")
        elif lane is None:
            # A tenancy that has ended, one not started yet, or a mistyped key. Said, never acted on.
            problems.append(f"{count}, which is not a live tenancy today; left as they are")
        elif status_of.get(tenancy) not in (CFV, CFV_ACTIONED):
            problems.append(f"{count}, which is no longer marked a cash flow void; left as they are")
    return {"rows": rows_out, "raise": raise_out, "close": close_out, "problems": problems, "stopped": stopped}


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
    fields = [rc.TK[k] for k in ("name", "status", "notes", "description", "tenancies")] + [COMPLETION_FIELD]
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
                    "tenancies": list(f.get(rc.TK["tenancies"]) or []),
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


def raise_one(rc, item, day):
    """One direct create (the inbox task gate folds by words and cannot tell one check from the
    next). Roy's task is created already his, so it is never ownerless for an agent to pick up,
    then emailed. If the email fails the task stays: the next run offers it to notify again."""
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
        wanted = {t for r in res["tenancies"] for t in tenants_of.get(r["id"], [])}
        pays = rc.payments_by_tenancy(data["tx"])
        todo = plan(res, tasks, tenants_of, read_names(rc, wanted), day, starts, pays,
                    rc.feed_state(data, pays, datetime.now(timezone.utc)))
        annotate(res, todo["rows"])
        out["problems"] = list(todo["problems"])
        if not on:
            return out
        out["planned"] = ([t["label"] for t in todo["raise"]]
                          + [("end: " if c["end"] and not c["complete"] else "close: ") + c["id"] for c in todo["close"]])
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
            ad = module("ad")
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
        for item in todo["raise"]:
            if item["tenancy"] in held:
                continue                              # Roy's task was not raised: no tenant draft without it
            try:
                raise_one(rc, item, day)
                out["raised"].append(item["label"])
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
