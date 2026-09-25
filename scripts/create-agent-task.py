#!/usr/bin/env python3
"""create-agent-task.py — THE create-time duplicate gate for agent-raised tasks.

Kevin's rule (25 Aug 2026): one subject = one open task. Chasers, follow-ups
and new developments on a matter are folded into the existing task, never
raised as siblings. The AI Agents page DETECTS leaks after the fact (the
Duplicates lane, keyed by dupeTaskKey in os/agents/index.html); this script
is the PREVENTION half, sitting in front of every scripted task create.

Every skill that creates agent tasks (inbound-email-triage Step 4/4b,
inbound-messages-sweep Step 5) calls this instead of a bare curl POST:

    python3 scripts/create-agent-task.py create --fields-json '<json keyed by
        Airtable field ID, exactly the payload the skill already specifies>'

    An approved task whose job is to raise a new task of its own (one email per
    contractor) adds `--parent <approved task id>`: never folded into a sibling.

Behaviour:
  * No open task shares the subject  -> POST creates it (unchanged payload).
  * An open task shares the subject AND the sender agrees -> PATCH folds the
    new item into that task (description appended, status/due/priority
    refreshed, an audit comment left) and NOTHING is created.
  * The subject matches but the sender differs -> CREATE anyway. Folding two
    different counterparties' matters into one task is worse than a
    duplicate: a tier-1 creditor letter must never land inside another
    creditor's thread. The page's Duplicates lane flags the pair for Kevin.

The subject key is dupe_task_key(), a line-for-line port of dupeTaskKey in
os/agents/index.html; tests/agents-dupe-task-key.test.js runs BOTH on the
same corpus and fails if they ever disagree, so the detector and this
preventer can never classify the same title differently.

CONTROL (the silent-zero trap, CLAUDE.md Airtable conventions): the gate
reads the open board, which always carries hundreds of tasks. Zero rows
means the read broke, not an empty business, and a broken existence check
that gates a create is exactly how duplicates get minted. On zero rows or
any API error the script EXITS NON-ZERO and creates nothing; the calling
skill counts the item unhandled and reports the failure.

  * The task IS an auto-reply (its name carries an "Automatic reply:"
    subject, or the scan flagged every message on its thread) -> REFUSED,
    exit 3, nothing created or updated. A machine receipt of something we
    sent is never a matter; the reference it carries belongs on the open
    task or the creditor plan, not in Kevin's approval gate (2 Sep 2026).

Exit codes: 0 created/updated (JSON on stdout), 2 gate could not run
(broken read), 3 refused (auto-reply), 1 anything else.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta

BASE_ID = "appnqjDpqDniH3IRl"
TASKS = "tblqB8b22hKBL4PF1"

# Write-side field IDs, matching the triage create spec (the same map
# agent-dispatch.py's REVIEW_TASK_FIELDS mirrors).
F = {
    "name":         "fldgFjGBw6bTKJFCD",
    "status":       "fldx4qCw17UfrKpaN",
    "due":          "fld7XP8w8kbxfETV4",
    "hardDeadline": "fldZKzIxgyrQ8CG8a",
    "team":         "flduCtmQGpOA4eWaj",
    "priority":     "fldS21RwmwOqt71LI",
    "desc":         "fldRGhBQViKZKtkQ6",
    "inboundSender": "fldzf4xlbrQuktx0i",
    "inboundUrl":   "fldXf1p0vtHqOZcKl",
    "notes":        "fldR7apBzSp3oxFxz",
    # Same id as AF["sentForApprovalBy"] in agent-dispatch.py; the gate hides
    # an Approval row without it.
    "sentForApprovalBy": "fld30Yw8SWYVp049g",
    # Checkbox: Maintenance Ticket (js/config.js `maintenance`). A ticked task
    # is a repair, whatever its name says; the fold lane reads it first.
    "maintenance":  "fldSEUvVA98as1HW6",
    # Read only for --parent (25 Sep 2026): is the parent really approved?
    "approvalOutcome": "fldrHBSr6qoUfaKuZ",
    "approvedAt":   "fldr4Mvf2RzKvhZhi",
}

# Roy Lavin's Team Members row (same id as ROY_REC in task-manager.py and
# ROY_TEAM_MEMBER in inbound-triage.py). A task Roy holds is a repair job.
ROY_TEAM_MEMBER = "reclbdjfVev3bqNHS"

PRIORITY_RANK = {"Low": 0, "Medium": 1, "High": 2, "Urgent": 3}

# THE STATUSES A NEW TASK MAY CARRY (15 Sep 2026). Every surface reads Status:
# dispatch and loop-health key on Today/Overdue (plus due Upcoming), the gate
# on Approval, Kevin's board on the same three. The create used to POST
# whatever Status the agent passed with typecast on, so "Open" and
# "2026-09-10" became NEW select options silently and the tasks carrying them
# were on no surface at all (recOkNN9Ww0gGLUYT, recDlEl2CwfONU9VL,
# recHk3VZZ9d8utk7w, recaCaQJvw17iDhKm). Anything outside this set — or no
# Status at all — becomes Today, with a Notes line saying what was passed, and
# the create is sent with typecast OFF so a select field can never grow an
# option from a typo again. Overdue is derived by the board, never set on
# create. Guarded by the selftest and the open-task-status-is-a-board-status
# invariant in scripts/check-data-invariants.py.
NEW_TASK_STATUSES = ("Today", "Upcoming", "Approval")
STATUS_FIX_MARK = "— create-agent-task] Status "


def normalise_status(fields, stamp):
    """Force a board status onto a new task's fields, in place. Returns the
    note line written when the passed value was replaced, else None."""
    raw = _sel_name(fields.get(F["status"]))
    # Approval is a board status ONLY with a sender: the gate formula requires
    # Sent For Approval By, so an Approval row without one is exactly the
    # invisible card the approval-row-carries-its-sender invariant hunts.
    has_sender = bool([x for x in (fields.get(F["sentForApprovalBy"]) or []) if x])
    if raw in NEW_TASK_STATUSES and (raw != "Approval" or has_sender):
        fields[F["status"]] = raw
        return None
    passed = f"{raw!r}" if raw else "nothing"
    why = ("Approval with no Sent For Approval By is on no surface"
           if raw == "Approval" else
           f"not a board status (allowed: {', '.join(NEW_TASK_STATUSES)})")
    line = (f"[{stamp} {STATUS_FIX_MARK}{passed} was passed on create; {why}, so "
            "this task was set to Today rather than left invisible.")
    fields[F["status"]] = "Today"
    existing = str(fields.get(F["notes"]) or "").rstrip()
    fields[F["notes"]] = (existing + "\n\n" + line).strip()
    return line

# Personal-mailbox providers: a shared domain proves nothing about identity,
# so only an EXACT address match folds. A private (corporate) domain match
# is enough — creditors rotate individual senders behind one domain.
PUBLIC_MAIL_DOMAINS = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk",
    "live.com", "live.co.uk", "yahoo.com", "yahoo.co.uk", "icloud.com",
    "me.com", "mac.com", "aol.com", "btinternet.com", "sky.com", "proton.me",
    "protonmail.com",
}

# Statuses that mean the task is finished with; everything else is "open".
CLOSED_STATUSES = {"Completed", "Cancelled"}


# ─── AN AUTO-REPLY NEVER BECOMES A TASK (2 Sep 2026) ────────────────
#
# Between 28 Aug and 1 Sep 2026 Kevin was asked to approve FOUR tasks whose
# only content was a council's automatic receipt of an email he had already
# approved and sent (Burnley "Automatic reply: Liability Order…", three Fylde
# "Thank you for contacting… logged with reference CSV-…"). Each one had
# been created by the triage skill's stranded-mail rescue (a labelled thread
# with no OPEN task looks stranded once the real task completes), handed to
# a role agent, and came back as a "NO ACTION REQUIRED" briefing or a CLOSE
# PROPOSAL that still needed his tap. Kevin's ruling: these must never reach
# the approval gate.
#
# The machine signal is read here, in the gate every task create passes
# through, and shared with the triage scan (inbound-triage.py imports it) so
# the flag and the refusal can never disagree. Three signals, strongest
# first: RFC 3834 / Exchange headers, the "Automatic reply:" subject family,
# and an acknowledgement-shaped body (a receipt phrase, no question, no ask).
# The ONE header that is a signal on its own: "auto-replied" is the RFC 3834
# word for "a mailbox answered by itself". Nothing else is. "auto-generated"
# and Exchange's x-auto-response-suppress ride on bank alerts, e-signature
# requests, Stripe notices and spam too — mail that can carry a real ask —
# and on the live lane-12 corpus (2 Sep 2026) x-auto-response-suppress alone
# flagged a phishing mail and nothing useful. The worker still returns those
# headers; they are evidence for a human reading the digest, not a rule.
AUTO_REPLY_DEFINITIVE_HEADER = ("auto-submitted", "auto-replied")

# A bounce is auto-replied too (mailer-daemon sets it), but a bounce means
# something Kevin sent did NOT arrive — that is a task, never a receipt.
BOUNCE_SENDER_RE = re.compile(r"^(?:mailer-daemon|postmaster)@", re.I)
BOUNCE_SUBJECT_RE = re.compile(
    r"delivery status notification|undeliverable|mail delivery fail|"
    r"delivery failure|returned mail|delivery has failed", re.I)

# Anchored at the START on purpose: "RE: Automatic reply: …" is a human
# writing back inside the auto-reply's thread, and that is live conversation.
AUTO_REPLY_SUBJECT_RE = re.compile(
    r"^\s*(?:\[[^\]]{1,40}\]\s*)?"
    r"(?:automatic reply|automated (?:reply|response)|auto[- ]?(?:reply|response)"
    r"|autoreply|autoresponse|out of (?:the )?office|ooo\s*[:\-\u2013\u2014])\b",
    re.I,
)

# Receipt phrases as they actually arrive (Fylde, Burnley, SSE, UK Search,
# 28 Aug – 1 Sep 2026). The body test needs one of these in the UNQUOTED
# part AND no question AND no instruction phrase — a human who acknowledges
# and then asks for something is a task.
# RECEIPT language only — "we got what you sent". Generic machine markers
# ("do not reply to this email", "this is an automated message") are NOT
# here on purpose: a bank alert or a Stripe "action required" notice carries
# them too, and those can hold a real ask. Back-tested 2 Sep 2026 against
# the 100 most recent lane-12 messages: the 8 behind the four wrongly-gated
# tasks flag, nothing human does.
ACK_BODY_PHRASES = (
    "thank you for contacting", "thanks for contacting",
    "your email has been received", "your message has been received",
    "your request has been received", "your enquiry has been received",
    "we have received your", "has been logged with reference",
    "your request has been logged", "your email has reached",
    "we aim to respond", "we aim to reply", "we aim to send an initial reply",
    "will receive an initial response", "we will respond within",
    "has been forwarded to our", "we have forwarded your",
    "acknowledgement of receipt", "acknowledge receipt",
)
# An ask, or a position taken, means a person is talking — task it.
ACK_BODY_VETO_PHRASES = (
    "please provide", "please send", "please confirm", "please complete",
    "please sign", "please pay", "you must", "you need to", "you are required",
    "we require", "we need you to", "by return",
    "not accept", "do not agree", "disagree", "dispute", "reject", "refuse",
    "deny", "withdraw", "terminate", "breach", "proceedings", "court",
)
QUOTED_BODY_RE = re.compile(
    r"(?:^|\n)\s*(?:>|from:|-----original message-----|on .{5,120} wrote:)",
    re.I,
)


def unquoted_body(body):
    """The sender's own words: everything above the first quoted block."""
    text = str(body or "").replace("\r", "")
    m = QUOTED_BODY_RE.search(text)
    if m:
        text = text[:m.start()]
    return text


def auto_reply_signal(headers, subject, body):
    """The reason this message is a machine reply, or None. Pure.

    Order: a bounce is never one; then the definitive header; the subject
    family; then a receipt phrase in the sender's own words — and the body
    disagrees the moment it asks a question, gives an instruction, or takes
    a position."""
    hdrs = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
    sender = hdrs.get("from", "")
    sender = sender[sender.rfind("<") + 1:].rstrip("> ").strip().lower()
    if BOUNCE_SENDER_RE.search(sender) or BOUNCE_SUBJECT_RE.search(str(subject or "")):
        return None
    dname, dvalue = AUTO_REPLY_DEFINITIVE_HEADER
    if hdrs.get(dname, "").strip().lower().startswith(dvalue):
        return "header %s: %s" % (dname, hdrs[dname].strip()[:40])
    if AUTO_REPLY_SUBJECT_RE.search(str(subject or "")):
        return "subject: %s" % str(subject).strip()[:50]
    own = unquoted_body(body)[:1200].lower()
    if "?" in own or any(v in own for v in ACK_BODY_VETO_PHRASES):
        return None
    for phrase in ACK_BODY_PHRASES:
        if phrase in own:
            return "body: %s" % phrase
    return None


# Task-name prefixes the skills add before the subject; the subject test
# must see past them.
TASK_NAME_PREFIX_RE = re.compile(
    r"^\s*(?:inbound(?:\s*\(follow-up\))?|maintenance|post)\s*:\s*", re.I)

THREAD_URL_RE = re.compile(r"#(?:all|inbox)/([0-9a-f]{8,})")


def scan_cache_path():
    """The triage scan cache (message id -> sender, subject, threadId,
    auto_reply), written by inbound-triage.py scan. Same env override so a
    test can point both scripts at one directory."""
    base = os.environ.get("INBOUND_TRIAGE_DIR") or os.path.join(
        os.path.expanduser("~"), "knowledge-os/logs/inbound-triage")
    return os.path.join(base, "scan-cache.json")


def load_scan_cache():
    try:
        with open(scan_cache_path()) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


# ─── THE LETTER'S OWN `Deadline:` LINE IS NOT A JUDGEMENT CALL ──────────
#
# 4 Sep 2026, finding 20260904-daily-ops-450. The post-manager routine OCRs
# every scanned letter, lifts the one date that matters out of its prose and
# emails it to Kevin on a line of its own:
#
#     Deadline: 2026-09-29          (or "Deadline: none")
#
# Nothing in the AGENT path ever read that line. follow-up.html has read it
# since 25 Aug 2026 (parseDeadlineLine), but inbound triage — the path that
# has created every post task since the labels started routing to agents on
# 24 Aug — left both Due Date and Hard Deadline entirely to the model's
# judgement. Measured on 4 Sep 2026: 448 tasks carry `POST:` in their name and
# SIX are marked Hard Deadline, and not one of the 448 has a `Deadline:` line
# anywhere in its description, because the description only ever held a
# truncated Gmail snippet that stops before the line. So the date never
# reached Airtable at all, and every downstream guard that keys on Hard
# Deadline — loop-health's "deadline" rule, the daily
# `hard-deadline-passed-still-open` invariant — has been looking at an empty
# field and reporting nothing wrong.
#
# The fix is deterministic on purpose. A stated date is read by regex out of
# the full email body at scan time and stamped here; the model is not asked.
# `hard_deadline_correction` below stays as the fallback for mail that carries
# no such line, and never overrides a parsed one.
DEADLINE_MARKER = "DEADLINE FROM THE LETTER: "

# The line survives quoting (`> Deadline: …`) and HTML-escaped quoting
# (`&gt; Deadline: …`), which is the shape it actually arrives in.
POST_DEADLINE_LINE_RE = re.compile(
    r"^[>\s]*(?:DEADLINE FROM THE LETTER|Deadline)\s*:\s*(\S+)",
    re.I | re.M)

# What the post-manager writes when the letter genuinely names no date.
DEADLINE_NO_DATE_WORDS = {"none", "n/a", "na", "nil", "unknown", "tbc", "-", ""}


def _iso_or_none(value):
    """A whole YYYY-MM-DD date, or None. Anchored at both ends: the
    post-manager is told to write exactly that, and half-reading something
    longer ("2026-09-29/2026-10-02") would invent a hard date, which is the
    one date the rest of the system refuses to move. A missing zero
    ("2026-9-5") is still unambiguous, so it is read rather than dropped —
    dropping a real deadline is the bug this whole path exists to fix."""
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", str(value or "").strip())
    return _mk(int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def parse_deadline_line(text):
    """The date stated on a `Deadline:` line, as YYYY-MM-DD, or None.

    Deterministic twin of parseDeadlineLine() in follow-up.html. Returns None
    for: no line, `Deadline: none`, an unparseable date, and — deliberately —
    two lines stating DIFFERENT dates, because we then do not know which one
    the letter meant. A past date is returned like any other: a response
    window that has already closed is exactly what Kevin must be shown."""
    body = str(text or "").replace("\r", "").replace("&gt;", ">")
    found = set()
    for m in POST_DEADLINE_LINE_RE.finditer(body):
        value = m.group(1).strip()
        if value.lower().strip(".,;") in DEADLINE_NO_DATE_WORDS:
            continue
        parsed = _iso_or_none(value)
        if parsed:
            found.add(parsed)
    return found.pop().isoformat() if len(found) == 1 else None


def deadline_from_letter(fields, cache):
    """(iso, where it was read) for the deadline this task's mail states.

    Two sources, in order of authority: the task's own name and description
    (a caller that pasted the letter through), then the triage scan cache,
    which parses the line out of the FULL Gmail body at scan time — the only
    moment the whole body exists. The description never holds it, because it
    carries a truncated snippet."""
    text = "%s\n%s" % (fields.get(F["name"], ""), fields.get(F["desc"], ""))
    iso = parse_deadline_line(text)
    if iso:
        return (iso, "the task's own text")
    threads = THREAD_URL_RE.findall(str(fields.get(F["inboundUrl"], "")))
    found = set()
    for tid in threads:
        for v in (cache or {}).values():
            if isinstance(v, dict) and v.get("threadId") == tid and v.get("deadline"):
                found.add(str(v["deadline"]))
    return (found.pop(), "the scanned email body") if len(found) == 1 else None


def apply_letter_deadline(fields, cache):
    """Stamp Due Date and Hard Deadline from the letter's stated deadline.

    Mutates `fields` and returns the explanation, or None when the mail states
    no date. Both writes happen together: a Due Date without the flag is a
    date the auto-rescheduler rolls away, and the flag without the date is a
    guard with nothing to check. The marker line is appended so the date is
    visible on the task itself, and so the live invariant can see it."""
    got = deadline_from_letter(fields, cache)
    if not got:
        return None
    iso, source = got
    fields[F["due"]] = iso
    fields[F["hardDeadline"]] = True
    desc = str(fields.get(F["desc"], "") or "")
    if DEADLINE_MARKER not in desc:
        fields[F["desc"]] = (desc.rstrip() + "\n\n" + DEADLINE_MARKER + iso).strip()
    return ("Due Date set to %s and Hard Deadline ticked from the `Deadline:` "
            "line in %s" % (iso, source))


# ─── A HARD DEADLINE IS THE DATE THE LETTER STATES ───────────────────────
#
# 4 Sep 2026, finding 20260904-daily-ops-phase2-447. The daily
# `hard-deadline-passed-still-open` invariant showed nine open tasks past their
# date, and two of them were not late at all:
#
#   "INBOUND: Simarc - pay ground rent GBP 6 by 29 Sep …"   Due Date 2026-09-01
#   "INBOUND: HMRC formal compliance check … respond by Sep 17"  Due Date 2026-09-01
#
# Both carried the day the MAIL ARRIVED, not the deadline the mail states — the
# deadline was sitting in the task's own name the whole time. Two costs, and the
# second is the worse one: Kevin is chased about work that is not yet due, and
# the invariant that exists to catch genuinely missed legal windows fills with
# false alarms until nobody reads it.
#
# The correction is deliberately timid. It only ever moves a due date LATER, and
# only when the text states one unambiguous date with a real deadline word in
# front of it. Two different dates in one message means we do not know which is
# the deadline, so nothing is touched — a wrong hard date is worse than a
# receipt date, because a hard date is what other code refuses to move.
MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun",
     "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}

# "by 29 Sep", "before 17 September 2026", "no later than 29/09/2026",
# "due by 2026-09-29", "deadline 17 Sep".
_LEAD = r"(?:by|before|due(?:\s+by)?|no\s+later\s+than|deadline(?:\s+of|\s+is)?|on\s+or\s+before|not\s+later\s+than)"
_MON = r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*"
DEADLINE_RES = (
    # by 29 Sep 2026 / by 29 September
    re.compile(_LEAD + r"\s+(\d{1,2})(?:st|nd|rd|th)?\s+" + _MON + r"\.?(?:\s+(\d{4}))?", re.I),
    # by Sep 17 2026 / by September 17th
    re.compile(_LEAD + r"\s+" + _MON + r"\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?", re.I),
    # by 2026-09-29
    re.compile(_LEAD + r"\s+(\d{4})-(\d{2})-(\d{2})", re.I),
    # by 29/09/2026 or 29/09/26 — UK order, which is what every letter here uses
    re.compile(_LEAD + r"\s+(\d{1,2})/(\d{1,2})/(\d{2,4})", re.I),
)


def _mk(year, month, day):
    try:
        return date(year, month, day)
    except ValueError:
        return None


# A bare "by 29 Sep" has to be given a year, and getting that wrong is how a
# timid correction turns into a wild one: anchored to the DUE date, "pay by
# 1 Sep" on a task due 20 Sep resolved to 1 September of the FOLLOWING YEAR.
# So the year is chosen around TODAY, allowing a recently-passed date (a letter
# quoting a deadline that has just gone by is ordinary) but not a distant one.
BACKDATE_GRACE_DAYS = 45
# And a hard deadline more than half a year past the day the item arrived is a
# misparse, not a deadline. Nothing in this domain — pay by, respond by, court
# date, licence renewal chase — lands that far out on a single letter.
MAX_DEADLINE_HORIZON_DAYS = 180


def stated_deadlines(text, today):
    """Every explicit deadline date the text states, as a sorted list.

    `today` anchors a bare month-and-day: the occurrence nearest to now, which
    may be up to BACKDATE_GRACE_DAYS in the past but is otherwise in the
    future."""
    text = str(text or "")
    found = set()
    floor = today - timedelta(days=BACKDATE_GRACE_DAYS)

    def resolve(month, day, year=None):
        if year:
            year = int(year)
            if year < 100:
                year += 2000
            return _mk(year, month, day)
        cands = [d for d in (_mk(y, month, day)
                             for y in (today.year - 1, today.year, today.year + 1))
                 if d and d >= floor]
        return min(cands) if cands else None

    for m in DEADLINE_RES[0].finditer(text):
        mon = MONTHS.get(m.group(2)[:3].lower())
        if mon:
            found.add(resolve(mon, int(m.group(1)), m.group(3)))
    for m in DEADLINE_RES[1].finditer(text):
        mon = MONTHS.get(m.group(1)[:3].lower())
        if mon:
            found.add(resolve(mon, int(m.group(2)), m.group(3)))
    for m in DEADLINE_RES[2].finditer(text):
        found.add(_mk(int(m.group(1)), int(m.group(2)), int(m.group(3))))
    for m in DEADLINE_RES[3].finditer(text):
        found.add(resolve(int(m.group(2)), int(m.group(1)), m.group(3)))
    return sorted(d for d in found if d)


def hard_deadline_correction(fields, today):
    """(iso_date, why) when a hard-deadline Due Date contradicts the date the
    task's own text states, else None.

    Fires only when ALL of these hold, because each one is a way to be wrong:
      * the task is marked Hard Deadline and carries a Due Date;
      * its name or description states EXACTLY ONE deadline date;
      * that date is LATER than the Due Date given.
    The last is the whole point: a due date earlier than the stated deadline is
    the receipt date. A stated date EARLIER than the due date is left alone —
    that is a date already dealt with, or a date we have misread, and pulling a
    deadline forward invents an obligation."""
    if not fields.get(F["hardDeadline"]):
        return None
    due = str(fields.get(F["due"]) or "")[:10]
    if not due:
        return None
    try:
        due_date = date.fromisoformat(due)
    except ValueError:
        return None
    text = "%s\n%s" % (fields.get(F["name"], ""), fields.get(F["desc"], ""))
    stated = stated_deadlines(text, today)
    if len(stated) != 1:
        return None
    if stated[0] <= due_date:
        return None
    if (stated[0] - due_date).days > MAX_DEADLINE_HORIZON_DAYS:
        return None
    return (stated[0].isoformat(),
            "Due Date was %s but the task states a deadline of %s; %s is the "
            "date the item arrived, not the date it is due"
            % (due, stated[0].isoformat(), due))


def auto_reply_refusal(fields, cache):
    """Why this create must be refused, or None. Two reads: the task name
    carries an auto-reply subject, or every scanned message on the thread(s)
    the task points at was flagged by the scan."""
    name = str(fields.get(F["name"], ""))
    while TASK_NAME_PREFIX_RE.search(name):      # "INBOUND (follow-up): INBOUND: …"
        name = TASK_NAME_PREFIX_RE.sub("", name, count=1)
    if AUTO_REPLY_SUBJECT_RE.search(name):
        return "task name is an auto-reply subject (%s)" % name.strip()[:60]
    threads = THREAD_URL_RE.findall(str(fields.get(F["inboundUrl"], "")))
    for tid in threads:
        on_thread = [v for v in cache.values()
                     if isinstance(v, dict) and v.get("threadId") == tid]
        if on_thread and all(v.get("auto_reply") for v in on_thread):
            return ("every scanned message on thread %s is an auto-reply (%s)"
                    % (tid, on_thread[0].get("auto_reply")))
    return None


# NEVER A CARD (Kevin, 17 Sep 2026, tranche 3 interview). Two classes are
# decided by text a machine can read, so they are refused here, at the gate
# every create passes, rather than left to each agent's judgement:
#   * a company that no longer trades (Two Chefs, Cafe @ Highgate, Social
#     Housing Holdings). Anything legal about them (the Official Receiver, a
#     court claim, a liquidator, a solicitor) is still created: a legal matter
#     is never refused on a name match, whichever company it concerns.
#   * a payment or payout failure under £25 (a £1.42 GoCardless payout).
#     Anything mentioning rent, arrears or a tenant is created: a failed rent
#     collection is the rent process, whatever the amount.
# Kevin's evidence: of 37 reasoned inbox rejections from 27 Aug to 17 Sep,
# four were Stripe or Revolut notices for dissolved companies and one a £1.42
# payout. Cold sales and account notices need judgement and stay in
# Knowledge/inbox-decision-protocol.md.
DISSOLVED_COMPANY_RE = re.compile(
    r"\btwo chefs\b|\bcafe\s*@?\s*highgate\b|\bcafehighgate\b|\bsocial housing holdings\b", re.I)
LEGAL_MATTER_RE = re.compile(
    r"official receiver|liquidator|insolvency service|\bcourt\b|\bclaim\b|solicitor|\blegal\b|"
    r"winding.up|disqualif|\bhmcts\b|tribunal|judg(?:e)?ment|bailiff|enforcement", re.I)
PAYMENT_WORD_RE = re.compile(
    r"\b(?:payment|payout|transfer|direct debit|collection)s?\b", re.I)
FAILED_WORD_RE = re.compile(r"\bfail(?:ed|s|ure)?\b", re.I)
RENT_WORD_RE = re.compile(r"\brent\b|arrears|tenan", re.I)
AMOUNT_RE = re.compile(r"(?:£|GBP\s?|\$|USD\s?|EUR\s?|€)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)"
                       r"|\b([0-9][0-9,]*\.[0-9]{2})\b", re.I)
SMALL_FAILURE_LIMIT = 25


def never_a_card_refusal(fields):
    """Why Kevin ruled this create never becomes a card, or None."""
    text = "%s %s" % (fields.get(F["name"], ""), str(fields.get(F["desc"], ""))[:2000])
    company = DISSOLVED_COMPANY_RE.search(text)
    if company and not LEGAL_MATTER_RE.search(text):
        return ("about %s, a company that no longer trades, with nothing legal in it "
                "(Kevin, 17 Sep 2026)" % company.group(0))
    if (PAYMENT_WORD_RE.search(text) and FAILED_WORD_RE.search(text)
            and not RENT_WORD_RE.search(text)):
        amounts = []
        for cur, bare in AMOUNT_RE.findall(text):
            try:
                amounts.append(float((cur or bare).replace(",", "")))
            except ValueError:
                continue
        if amounts and max(amounts) < SMALL_FAILURE_LIMIT:
            return ("a payment failure under GBP %d (%.2f) (Kevin, 17 Sep 2026)"
                    % (SMALL_FAILURE_LIMIT, max(amounts)))
    return None


# Words that describe ANY incident and so cannot identify one. Shared
# verbatim with DUPE_GENERIC in os/agents/index.html.
DUPE_GENERIC = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "been",
    "by",
    "for",
    "from",
    "in",
    "is",
    "it",
    "its",
    "of",
    "on",
    "or",
    "re",
    "that",
    "the",
    "this",
    "to",
    "was",
    "were",
    "with",
    "action",
    "again",
    "asap",
    "check",
    "consider",
    "deal",
    "fix",
    "handle",
    "investigate",
    "look",
    "needs",
    "please",
    "repeatedly",
    "resolve",
    "review",
    "sort",
    "urgent",
    "broken",
    "error",
    "errors",
    "exceed",
    "exceeded",
    "exceeding",
    "fail",
    "failed",
    "failing",
    "failure",
    "failures",
    "issue",
    "issues",
    "problem",
    "problems",
    "api",
    "app",
    "apps",
    "google",
    "script",
    "scripts",
    "service",
    "services",
    "ref",
    "reference",
    "usage",
}

# Words that say WHEN, never WHICH (Kevin's ruling, 15 Sep 2026). The key
# keeps the first two distinctive words, so a card titled "CONTENT (OD): Fri
# 11 Sep, The offer: ..." keyed to `fri sep` and every card on the same
# weekday collided: 19 of the 22 Approval cards on 15 Sep 2026 paired on the
# weekday and month alone. Full and short forms, because the Content Engine
# writes "Fri 11 Sep" and a scan writes "Friday 11 September". Shared verbatim
# with DUPE_DATE_WORDS in os/agents/index.html; drift-tested.
DUPE_DATE_WORDS = {
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "mon", "tue", "tues", "wed", "weds", "thu", "thur", "thurs", "fri", "sat", "sun",
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
}


def dupe_task_key(name):
    """THE INCIDENT ANCHOR. Line-for-line port of dupeTaskKey in
    os/agents/index.html; drift-tested in tests/agents-dupe-task-key.test.js.

    Rewritten 27 Aug 2026. The old key was "every significant word, in order",
    which caught a task differing only by a reference number and nothing else.
    Measured against the live queue that day it caught ZERO of the real
    duplicates: ten open tasks covering three incidents read as ten distinct
    subjects, because an AI writes the same incident up in fresh words each
    time. The Duplicates lane reported clean while the approvals gate held the
    duplicates.

    Two parts. THE LANE: a leading "INBOUND:" / "MAINTENANCE:" prefix is split
    off and kept, because a maintenance task and an inbound reply task about
    one thread are deliberately separate. Left in the words it ate one of the
    two subject slots and merged "Meetings Intake" with "Meetings to Supabase".
    THE SUBJECT: drop reference-like tokens, drop the generic vocabulary, keep
    the first two survivors, sort them. Falls back to the old full key when
    nothing distinctive survives, since an empty key would collide everything.
    """
    raw = str(name or "")
    lane = ""
    m = re.match(r"^([A-Za-z][A-Za-z ]*(?:\([^)]*\))?)\s*:\s*", raw)
    if m:
        lane = re.sub(r"[^a-z0-9]+", " ", m.group(1).lower()).strip()
        raw = raw[m.end():]
    s = re.sub(r"[^a-z0-9\s]", " ", raw.lower())
    words = [
        w for w in re.split(r"\s+", s)
        if w
        and not re.fullmatch(r"\d+", w)
        and not re.fullmatch(r"(?=(?:[^\d]*\d){3,})[a-z\d]+", w)
    ]
    distinctive = [w for w in words
                   if w not in DUPE_GENERIC and w not in DUPE_DATE_WORDS]
    # AN ADDRESS SAYS WHERE, NOT WHICH (28 Aug 2026). Two slots is not many,
    # and when the address leads the title it takes both: "18 Siddows Avenue —
    # garden complaint" and "18 Siddows Avenue — rent arrears" both keyed to
    # `avenue siddows` and folded into one another. Kevin has ~27 properties
    # with many open tasks each, so this was live. Place words now go to the
    # BACK of the queue for a slot rather than being dropped, because a task
    # whose whole subject is an address still needs a key.
    places = _place_tokens(words)
    ranked = [w for w in distinctive if w not in places] + \
             [w for w in distinctive if w in places]
    subject = " ".join(sorted(ranked[:2])) if ranked else " ".join(words).strip()
    return (lane + "|" + subject) if lane else subject


# ─── THE SECOND PASS: SAME MATTER, DIFFERENT WORDS (28 Aug 2026) ────
#
# Kevin, working the queue that morning: "there's still a lot where I seem to
# see some duplication, something referencing the same issue but with slightly
# different information."
#
# He was right. Measured against the 55 tasks waiting: the key above grouped
# them into 43 cards and missed SEVEN real pairs, every one of them the same
# matter written two different ways —
#
#   "Sefton Council HMO licence fee 150 unpaid 23 Viola St Bootle"
#   "pay Sefton landlord licence fee 150 GBP for 23 Viola Street Bootle"
#
#   "SMS reply from +447700900747"          (INBOUND lane)
#   "SMS from 447700900747 - maintenance"   (MAINTENANCE lane)
#
# Three reasons the key alone could not catch them:
#
#   1. IT KEEPS ONLY THE FIRST TWO DISTINCTIVE WORDS, SORTED. "Sefton Council"
#      and "pay Sefton" therefore differ, because `council` and `pay` both
#      survive as distinctive and only two slots exist.
#   2. IT DELETES EVERY NUMBER. A phone number or a house number is the
#      STRONGEST identity signal there is — two tasks quoting 447700900747 are
#      the same thread, whatever words surround them — and the key strips them
#      as reference noise.
#   3. IT SPLITS ON THE LANE PREFIX. Deliberate, and right for FOLDING (a
#      maintenance job and a reply about one thread are separate pieces of
#      work). Wrong for SHOWING him, which is what he was asking about.
#
# So this does not replace the key. The key is a fast exact bucket and keeps
# every catch it already has; this is a second pass over what it missed. A
# match is either.
#
# STRICTNESS IS A PARAMETER, because the two callers do different things:
#   fold  — destructive, one task absorbs another. Same lane required.
#   group — display only, in the approvals queue. Lane ignored, because a
#           thread appearing in two lanes is exactly the duplication he sees.
#
# THE LANE MEANS REPLY-VS-MAINTENANCE, NOTHING ELSE (Kevin, 15 Sep 2026).
# Until then the fold lane was the raw name prefix, so "INBOUND (follow-up):"
# vs "INBOUND:" and "COMPLIANCE:" vs "CORRESPONDENCE:" read as different lanes
# and refused to fold: rec2nZRQ1Y4ZXj9mA (a COMPLIANCE twin of the
# CORRESPONDENCE keeper recODSge5r6SZ3IqQ, same contractor, same EICR, same
# house) sat in his queue as two cards. Those prefixes say which agent wrote
# the task up, not what kind of obligation it is. The 28 Aug lesson stands:
# a maintenance job absorbed into a reply task is a real obligation lost, so
# there are exactly two fold lanes: `maintenance` (a REPAIR: / MAINTENANCE:
# style prefix, the Maintenance Ticket tick, or Roy as the holder) and
# `reply` (everything else).

# Prefix words that put a task in the maintenance lane. Mirrored verbatim by
# DUPE_MAINTENANCE_LANE_WORDS in os/agents/index.html; drift-tested.
DUPE_MAINTENANCE_LANE_WORDS = {"maintenance", "repair", "repairs"}

# Words that say what to DO about a matter rather than WHICH matter it is.
# "pay Sefton" and "Sefton Council" are one thing; the verb is not identity.
# Extends DUPE_GENERIC rather than replacing it — kept separate so the key's
# own behaviour, and its tests, are untouched.
DUPE_ACTION_WORDS = {
    "respond", "reply", "replies", "replying", "required", "require",
    "requires", "send", "sending", "sent", "provide", "pay", "paid", "paying",
    "call", "calling", "chase", "chasing", "contact", "unpaid", "outstanding",
    "overdue", "further", "recovery", "notice", "notification", "update",
    "updates", "incoming", "new", "important", "info", "information",
    # A FAULT STATE is not identity either (finding 20260924-agent-dispatch-602).
    # "bathroom extractor fan not working" folded into "bathroom light not
    # working - 25 Abercorn Court" on bathroom/not/working, and the fold
    # overwrote the live task. The object (fan, light, boiler) is the matter.
    "not", "no", "working", "stopped",
}

# A UK phone number in any of the shapes these tasks carry: +447700900747,
# 447700900747, 07700900747. The last nine digits are the same in all three,
# which is what makes them comparable.
DUPE_PHONE_RE = re.compile(r"\b(?:\+?44|0)?(\d{9,12})\b")

DUPE_MIN_SHARED = 2      # one shared word is a coincidence ("emails")
DUPE_MIN_RATIO = 0.5     # of the SHORTER task's distinctive words

# ─── AN ADDRESS SAYS WHERE, NOT WHICH ────────────────────────────────
#
# Caught by this file's own test before it shipped. "Gas safety certificate due
# 23 Viola Street Bootle" folded into "action overdue licensing tasks 23 Viola
# Street Bootle - EICR and Gas" on four shared words — three of which were the
# ADDRESS.
#
# That direction is genuinely dangerous here. Kevin has around 27 properties
# with many open tasks each, so counting address words as evidence would
# eventually fold a garden complaint into a rent arrears chase at the same
# house. The place is context; the matter is what differs.
#
# So place tokens still SHOW in the explanation (they are why a human recognises
# the pair) but never count toward the shared-word threshold.
DUPE_STREET_TYPES = {
    "street", "st", "road", "rd", "avenue", "ave", "lane", "close", "drive",
    "way", "court", "place", "crescent", "grove", "terrace", "gardens",
    "square", "walk", "hill", "park", "row", "view", "rise", "mews",
}


def _place_tokens(words):
    """Tokens naming WHERE: the street type, the name before it, the town
    after it. `23 Viola Street Bootle` -> viola, street, bootle."""
    place = set()
    for i, w in enumerate(words):
        if w not in DUPE_STREET_TYPES:
            continue
        place.add(w)
        if i:
            place.add(words[i - 1])
        if i + 1 < len(words):
            place.add(words[i + 1])
    return place


def _is_calendar_year(digits):
    """True for a plain four-digit year (1900-2099).

    Deliberately narrow: five digits or more is a reference no matter what it
    reads like, and 1899 or 2100 in a task name is not a date anybody is
    writing today.
    """
    return len(digits) == 4 and 1900 <= int(digits) <= 2099


# ─── A POSTCODE IS THE PUREST "WHERE" THERE IS ───────────────────────
#
# Finding 20260925-agent-dispatch-605. `_place_tokens` above recognises a
# place by its STREET TYPE and the words either side of it, so in
# "23 Viola Street Bootle L20 7DR" it correctly sets aside viola, street and
# bootle — and leaves `l20` and `7dr` counting as subject words, because
# nothing marks them as address. That was enough on its own:
#
#   "Send GSC quote requests - Bootle Gas Engineers and Able Group -
#    23 Viola Street Bootle L20 7DR"
#   "COMPLIANCE: Sefton Council HMO licence fee overdue -
#    23 Viola Street Bootle L20 7DR"
#
# shared exactly two telling words, `l20` and `7dr`, at a ratio of 0.5, so
# the fold went ahead and overwrote the licence-fee card's Description with
# gas-safety content WHILE IT SAT AT KEVIN'S APPROVAL GATE. A gas safety
# certificate and a council licence fee are not the same matter; the only
# thing they had in common was the house. This property alone carries around
# thirty tasks across unrelated subjects, so the same trap is live on every
# one of the ~27 properties.
#
# Same family as finding 602 (generic words `bathroom`/`not`/`working`) and
# 427 (the year `2026` read as a strong reference): a token that appears on
# everything cannot identify anything.
DUPE_POSTCODE_OUT_RE = re.compile(r"^[a-z]{1,2}\d[a-z\d]?$")
DUPE_POSTCODE_IN_RE = re.compile(r"^\d[a-z]{2}$")


def _postcode_tokens(name):
    """Both halves of any UK postcode in `name`, plus the word in front of it
    (the town, which a postcode does not always follow a street type).

    Matched as an ADJACENT PAIR (`l20` then `7dr`) on purpose. The outward
    half alone reads like plenty of harmless tokens — `b2`, `q3`, `s1` — and
    only the pair is unambiguously an address.
    """
    words = re.sub(r"[^a-z0-9\s]", " ", str(name or "").lower()).split()
    found = set()
    for i in range(len(words) - 1):
        if (DUPE_POSTCODE_OUT_RE.match(words[i])
                and DUPE_POSTCODE_IN_RE.match(words[i + 1])):
            found.add(words[i])
            found.add(words[i + 1])
            if i:
                found.add(words[i - 1])
    return found


def fold_on_address_only(name_a, name_b, shared):
    """True when the ONLY thing these two task names agree on is the address.

    Deliberately guards FOLDING, not grouping, and so lives here rather than
    inside `dupe_verdict`: the page's Duplicates lane SHOWING Kevin two tasks
    at one house is useful, and one of them silently eating the other is the
    incident. That is this file's own doctrine — "Grouping shows, folding
    destroys, and only the second needs to be careful" — and it keeps
    `dupe_verdict` byte-identical to the page's mirror, which the drift test
    in tests/agents-dupe-task-key.test.js exists to enforce.

    A phone number or a reference number is identity, not address, so a
    strong-id match is never blocked.
    """
    shared = list(shared or [])
    if any(str(s).startswith(("tel:", "num:")) for s in shared):
        return False
    noise = (dupe_signals(name_a)[3] | dupe_signals(name_b)[3]
             | _postcode_tokens(name_a) | _postcode_tokens(name_b))
    return len([w for w in shared if w not in noise]) < DUPE_MIN_SHARED


def dupe_signals(name):
    """(lane, strong_ids, distinctive_words, place_words): what identifies
    this matter. `lane` is "maintenance" or "reply", never the raw prefix:
    the prefix is split off so it cannot eat a subject word, but the only
    lane difference that may block a fold is repair-vs-reply (Kevin, 15 Sep
    2026).

    Mirrored verbatim by dupeSignals in os/agents/index.html; drift-tested in
    tests/agents-dupe-task-key.test.js.
    """
    raw = str(name or "")
    lane = "reply"
    m = re.match(r"^([A-Za-z][A-Za-z ]*(?:\([^)]*\))?)\s*:\s*", raw)
    if m:
        prefix = re.sub(r"[^a-z0-9]+", " ", m.group(1).lower()).strip()
        raw = raw[m.end():]
        if any(w in DUPE_MAINTENANCE_LANE_WORDS for w in prefix.split()):
            lane = "maintenance"
    strong = set()
    for digits in DUPE_PHONE_RE.findall(raw):
        strong.add("tel:" + digits[-9:])
    for digits in re.findall(r"\b\d{4,}\b", raw):
        # A phone number already claimed above must not also register as a
        # plain reference, or one number would count as two agreements.
        if "tel:" + digits[-9:] in strong:
            continue
        # A YEAR IS NOT A REFERENCE NUMBER. On 1 Sep 2026 an HMRC compliance
        # task folded into a Fylde council tax demand because both names
        # carried "2026", which the 4-digit rule read as a shared reference
        # and treated as proof on its own. Nearly every task name a scan
        # produces carries the current year, so this fired as a match against
        # anything. Years are excluded from the STRONG set only; the word
        # pass below still sees the rest of the name.
        if _is_calendar_year(digits):
            continue
        strong.add("num:" + digits)
    cleaned = re.sub(r"[^a-z0-9\s]", " ", raw.lower())
    words = [
        w for w in cleaned.split()
        if w
        and not re.fullmatch(r"\d+", w)
        and not re.fullmatch(r"(?=(?:[^\d]*\d){3,})[a-z\d]+", w)
        and w not in DUPE_GENERIC
        and w not in DUPE_ACTION_WORDS
        and w not in DUPE_DATE_WORDS
    ]
    # Kept as an ordered list too: a place is recognised by adjacency, and a
    # set has thrown that away.
    return lane, strong, set(words), _place_tokens(words)


def fold_lane(name, team=None, maintenance_ticket=False):
    """"maintenance" | "reply" for a task RECORD, for the fold callers that
    hold one (the creation gate, the Task Manager board, the dispatch close).

    The name lane alone is not enough: on the live board of 15 Sep 2026 all
    24 ticked Maintenance Tickets were unprefixed ("Clear and tidy garden",
    "Provision of a valid EICR") or "INBOUND:", so a name-only lane read every
    one of them as a reply task and let an agent-written COMPLIANCE task
    absorb Roy's job. The tick and Roy's Team Members row say repair whatever
    the name says; the name lane (dupe_signals) covers the rest.
    """
    if maintenance_ticket or ROY_TEAM_MEMBER in (team or []):
        return "maintenance"
    return dupe_signals(name)[0]


def dupe_verdict(name_a, name_b, mode="group"):
    """Are these the same matter? Returns {match, why, shared}.

    `why` is written for KEVIN, not for a log: it is shown on the group header
    so he can confirm the call himself rather than trusting it. That is what he
    asked for — "a little bit better confirmation of that".
    """
    lane_a, strong_a, words_a, place_a = dupe_signals(name_a)
    lane_b, strong_b, words_b, place_b = dupe_signals(name_b)

    # THE LANE CHECK COMES FIRST IN FOLD MODE, ahead of even a shared phone
    # number. Folding is destructive — one task absorbs the other — and a
    # maintenance job absorbed into a reply task is a real obligation lost.
    # "SMS reply from +447700900747" and "SMS from 447700900747 - maintenance
    # reply" ARE one thread, and Kevin should SEE them together; that does not
    # mean one may quietly eat the other. Grouping shows, folding destroys, and
    # only the second needs to be careful. The lane is reply-vs-maintenance
    # only (Kevin, 15 Sep 2026): two reply tasks under different agent prefixes
    # ("INBOUND (follow-up):" / "INBOUND:", "COMPLIANCE:" / "CORRESPONDENCE:")
    # are the same lane and fold when the rest of the verdict agrees.
    if mode == "fold" and lane_a != lane_b:
        return {"match": False, "why": "", "shared": []}

    both = sorted(strong_a & strong_b)
    if both:
        label = ", ".join(
            ("phone " + x[4:]) if x.startswith("tel:") else ("reference " + x[4:])
            for x in both)
        return {"match": True, "why": "same " + label, "shared": both}

    if not words_a or not words_b:
        return {"match": False, "why": "", "shared": []}
    shared = sorted(words_a & words_b)
    # The threshold is judged on what is left once the address is set aside.
    places = place_a | place_b
    telling = [w for w in shared if w not in places]
    if len(telling) < DUPE_MIN_SHARED:
        return {"match": False, "why": "", "shared": shared}
    ratio = len(shared) / min(len(words_a), len(words_b))
    if ratio < DUPE_MIN_RATIO:
        # Enough words in common to look related, not enough to be the same
        # matter: "Sefton licence fee" and "Viola Street EICR and Gas" share a
        # property and nothing else.
        return {"match": False, "why": "", "shared": shared}
    return {"match": True, "why": "both about " + ", ".join(telling)
            + (" (at " + ", ".join(w for w in shared if w in places) + ")"
               if any(w in places for w in shared) else ""),
            "shared": shared}


def _sel_name(v):
    return v.get("name", "") if isinstance(v, dict) else str(v or "")


def _bare_addr(s):
    """'Name <a@b.com>' -> 'a@b.com'; anything else lowercased/trimmed.
    Without this, the '>' rides into the domain ('b.com>'), which never
    matches PUBLIC_MAIL_DOMAINS and would let two different public-mailbox
    users fold on 'the same' domain."""
    s = str(s or "").strip().lower()
    m = re.search(r"<([^<>@\s]+@[^<>\s]+)>", s)
    return m.group(1) if m else s


def senders_agree(incoming, existing):
    """True when the two items are safely the SAME counterparty.
    Missing on both sides counts as agreement (agent-generated tasks carry
    no sender). Missing on one side only does NOT: fold nothing you cannot
    attribute."""
    a = _bare_addr(incoming)
    b = _bare_addr(existing)
    if not a and not b:
        return True
    if not a or not b:
        return False
    if a == b:
        return True
    if "@" in a and "@" in b:
        da, db = a.rsplit("@", 1)[1], b.rsplit("@", 1)[1]
        return da == db and da not in PUBLIC_MAIL_DOMAINS
    return False


def decide(incoming_fields, open_rows):
    """The pure gate: given the create payload and the open board, say what
    to do. Returns {"action": "create"} or
    {"action": "update", "taskId", "matchedName"} or
    {"action": "create", "note": "..."} when a key match was deliberately
    not folded. No network in here — this is what the tests exercise."""
    key = dupe_task_key(incoming_fields.get(F["name"], ""))
    if not key:
        return {"action": "create", "key": key}
    incoming_sender = incoming_fields.get(F["inboundSender"], "")

    incoming_name = incoming_fields.get(F["name"], "")
    incoming_lane = fold_lane(incoming_name, incoming_fields.get(F["team"]),
                              bool(incoming_fields.get(F["maintenance"])))
    matches, why_matched = [], {}
    for row in open_rows:
        f = row.get("fields", {})
        if _sel_name(f.get(F["status"])) in CLOSED_STATUSES:
            continue
        other = f.get(F["name"], "")
        # A REPAIR TICKET AND A REPLY TASK ARE TWO OBLIGATIONS (28 Aug 2026,
        # restated 15 Sep 2026). Read off the RECORD, ahead of both passes:
        # the exact key cannot see the Maintenance Ticket tick or Roy, and an
        # unprefixed ticket keys and words like any other task.
        if fold_lane(other, f.get(F["team"]), bool(f.get(F["maintenance"]))) != incoming_lane:
            continue
        # TWO PASSES, and a match is either. The key is the fast exact bucket
        # and keeps every catch it already had; the verdict is the second pass
        # over what it missed — seven real pairs on the live queue of 28 Aug
        # 2026, each the same matter written two different ways.
        # AN ADDRESS IS NOT A SUBJECT, AND A FOLD IS DESTRUCTIVE (25 Sep 2026,
        # finding 605). Applied to BOTH passes, because either can come to rest
        # on the address alone: the key's own subject slots fall back to place
        # words when nothing else survives, and the verdict's threshold counted
        # postcode halves as telling words. Skipping the match leaves the pair
        # to the page's Duplicates lane, where Kevin sees both and decides.
        if dupe_task_key(other) == key:
            if fold_on_address_only(incoming_name, other, key.split("|")[-1].split()):
                continue
            why_matched[row["id"]] = "same subject"
            matches.append(row)
            continue
        verdict = dupe_verdict(incoming_name, other, mode="fold")
        if verdict["match"]:
            if fold_on_address_only(incoming_name, other, verdict["shared"]):
                continue
            why_matched[row["id"]] = verdict["why"]
            matches.append(row)

    if not matches:
        return {"action": "create", "key": key}

    matches.sort(key=lambda r: r.get("createdTime", ""))
    for row in matches:
        if senders_agree(incoming_sender, row.get("fields", {}).get(F["inboundSender"], "")):
            return {
                "action": "update",
                "key": key,
                "taskId": row["id"],
                "matchedName": row.get("fields", {}).get(F["name"], ""),
                # WHY it folded, in Kevin's words rather than a key. A fold he
                # cannot audit is a fold he has to take on trust.
                "matchedWhy": why_matched.get(row["id"], "same subject"),
            }
    return {
        "action": "create",
        "key": key,
        "note": ("subject matches %d open task(s) from a different sender; "
                 "not folding across counterparties. The page's Duplicates "
                 "lane flags the pair for Kevin." % len(matches)),
    }


def build_update(existing_fields, incoming_fields, today_iso):
    """The pure patch builder for a fold.

    - Description gains a dated update block (total capped well under
      Airtable's long-text limit; oldest history trims first).
    - FOLD TRACE: the incoming item's dedupe key (thread URL / imessage
      guid) is APPENDED to Inbound Note URL Link. Every dedupe that guards
      this pipeline — the skills' Step 3/5 FIND query and the Inbound Comms
      page's own check — matches that field by substring, so without this
      a folded thread reads as unhandled for ever and the stranded sweep
      refolds it three times a day. Space-separated on purpose: FIND still
      matches each URL, and the page's thread grouping reads the FIRST one,
      which stays the original thread.
    - Status: never moves a task OUT of Kevin's Approval queue. (The PATCH
      itself bumps Last Modified Time, so the Slack stale-approval guard
      makes Kevin re-read before approving — that is intended: new material
      on a matter he is about to sign off MUST force a re-read.)
    - Due date and Hard Deadline honour the hard-deadline contract: a hard
      deadline is a real-world date (court date, pay-by) that soft chaser
      dues must never drag around. A soft due only moves a soft due; a hard
      incoming date beats a soft existing one; two hard dates keep the
      earlier.
    - Priority only ever moves UP."""
    patch = {}
    add_desc = str(incoming_fields.get(F["desc"], "") or "").strip()[:6000]
    new_url = str(incoming_fields.get(F["inboundUrl"]) or "").strip()
    block = "\n\nUPDATE %s: new item folded in by the duplicate gate (one subject = one open task)." % today_iso
    if new_url:
        block += "\nSource: %s" % new_url
    if add_desc:
        block += "\n" + add_desc
    full = (str(existing_fields.get(F["desc"], "") or "").rstrip() + block).strip()
    if len(full) > 80000:
        full = "[earlier history trimmed by the duplicate gate]\n" + full[-80000:]
    patch[F["desc"]] = full

    old_url = str(existing_fields.get(F["inboundUrl"]) or "").strip()
    if new_url and new_url not in old_url:
        patch[F["inboundUrl"]] = (old_url + " " + new_url).strip()

    existing_status = _sel_name(existing_fields.get(F["status"]))
    if existing_status != "Approval":
        # Same allowed set as a create: the fold path PATCHes with typecast
        # on, so an unvalidated value here would mint the phantom option the
        # create path now refuses.
        wanted = _sel_name(incoming_fields.get(F["status"]))
        has_sender = bool([x for x in (incoming_fields.get(F["sentForApprovalBy"]) or []) if x])
        patch[F["status"]] = (wanted if wanted in NEW_TASK_STATUSES
                              and (wanted != "Approval" or has_sender) else "Today")

    ex_due = str(existing_fields.get(F["due"]) or "")[:10]
    in_due = str(incoming_fields.get(F["due"]) or "")[:10]
    ex_hard = bool(existing_fields.get(F["hardDeadline"]))
    in_hard = bool(incoming_fields.get(F["hardDeadline"]))
    if in_hard and in_due:
        if not ex_hard:
            patch[F["due"]] = in_due
            patch[F["hardDeadline"]] = True
        elif not ex_due or in_due < ex_due:
            patch[F["due"]] = in_due
    elif not ex_hard and existing_status != "Approval":
        dues = [d for d in (ex_due, in_due) if d]
        if dues:
            patch[F["due"]] = min(dues)

    old_p = PRIORITY_RANK.get(_sel_name(existing_fields.get(F["priority"])), -1)
    new_p = PRIORITY_RANK.get(_sel_name(incoming_fields.get(F["priority"])), -1)
    if new_p > old_p:
        patch[F["priority"]] = _sel_name(incoming_fields.get(F["priority"]))
    return patch


# ── Airtable transport (network only below this line) ────────────────────

def pat():
    path = os.path.expanduser("~/.config/od/airtable_pat")
    with open(path) as fh:
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
            f"Airtable {method} {path} -> HTTP {e.code}: "
            f"{e.read().decode('utf-8', 'replace')[:300]}") from None


def fetch_open_tasks():
    """Every open task, paginated (the one lesson of the recon accuracy
    card: a hand-rolled read that skips the offset token scores one page).
    Server-side filter on Status only; the key match runs client-side, so a
    display-name rename cannot silently empty the gate."""
    records, offset = [], None
    while True:
        params = [("pageSize", "100"), ("returnFieldsByFieldId", "true"),
                  ("filterByFormula", "AND({Status}!='Completed', {Status}!='Cancelled')")]
        for fid in (F["name"], F["status"], F["due"], F["priority"],
                    F["team"], F["inboundSender"], F["maintenance"]):
            params.append(("fields[]", fid))
        if offset:
            params.append(("offset", offset))
        qs = urllib.parse.urlencode(params)
        data = _request("GET", f"/{TASKS}?{qs}")
        records.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            return records


def post_comment(task_id, text):
    try:
        _request("POST", f"/{TASKS}/{task_id}/comments", {"text": text[:4000]})
    except Exception as e:  # best-effort trail, same as the page's comment
        print(f"comment failed (non-fatal): {e}", file=sys.stderr)


# A CHILD OF AN APPROVED TASK (finding 20260924-agent-dispatch-590, 25 Sep 2026).
# recPFxDmGX5pbonD2 (23 Viola Street EICR) was approved to raise one quote-request
# email per contractor as tasks of their own, each with its own card. The fold
# gate matched the new task to its open sibling on "quote request eicr" and
# folded it in, so the emails could never be raised. `--parent <approved task>`
# creates the child as its own task: the parent must be open and carry the marks
# only a real approval leaves (Sent For Approval By and Approved At), the
# refusals still run, only the fold is skipped, and the child goes to the gate
# itself, because a child of an approved parent is not approved.
APPROVED_OUTCOMES = ("Approved as-is", "Approved with minor edits")


def parent_problem(parent_id):
    """Why PARENT cannot vouch for a new child task, or ''."""
    try:
        pf = (_request("GET", f"/{TASKS}/{parent_id}?returnFieldsByFieldId=true") or {}).get("fields", {}) or {}
    except RuntimeError as exc:
        return f"the parent {parent_id} could not be read ({str(exc)[:120]})"
    sel_ = lambda v: v.get("name", "") if isinstance(v, dict) else (v or "")
    if sel_(pf.get(F["status"])) == "Completed":
        return f"the parent {parent_id} is Completed"
    if sel_(pf.get(F["approvalOutcome"])) not in APPROVED_OUTCOMES:
        return f"the parent {parent_id} is not approved (outcome {sel_(pf.get(F['approvalOutcome'])) or 'empty'!r})"
    if not pf.get(F["sentForApprovalBy"]) or not pf.get(F["approvedAt"]):
        return f"the parent {parent_id} carries no real approval (no gate or no Approved At)"
    return ""


def cmd_create(fields, force=False, dry_run=False, parent=None):
    if F["name"] not in fields or not str(fields[F["name"]]).strip():
        print("fields JSON must carry the Task Name field " + F["name"], file=sys.stderr)
        return 1
    if parent:
        why = parent_problem(parent)
        if why:
            print(json.dumps({"action": "refused", "reason": f"--parent refused: {why}", "dryRun": dry_run}))
            return 3
        fields = dict(fields)
        fields[F["desc"]] = (f"CHILD OF {parent} (an approved task whose job is to raise this one; "
                             "it goes to the gate itself).\n\n" + str(fields.get(F["desc"]) or "")).strip()

    cache = load_scan_cache()

    # The letter's own `Deadline:` line decides the date, in code. Both this
    # and the correction below run BEFORE the board read, because the fold
    # path in build_update compares due dates and would otherwise keep the
    # wrong one as "the earlier hard date".
    stamped = apply_letter_deadline(fields, cache)
    if stamped:
        print("HARD DEADLINE STAMPED: %s" % stamped, file=sys.stderr)
    else:
        # Fallback for mail that states no `Deadline:` line: correct a hard
        # deadline the model set to the receipt date. Never runs over a
        # parsed date — a stated deadline is not a judgement call.
        corrected = hard_deadline_correction(fields, date.today())
        if corrected:
            fields[F["due"]] = corrected[0]
            print("DUE DATE CORRECTED: %s" % corrected[1], file=sys.stderr)

    fixed = normalise_status(fields, date.today().strftime("%d %b %Y"))
    if fixed:
        print("STATUS CORRECTED: %s" % fixed, file=sys.stderr)

    verdict = {"action": "create", "key": dupe_task_key(fields.get(F["name"], ""))}
    if not force:
        # Refuse BEFORE the board read: an auto-reply is not a matter, so the
        # duplicate question never arises. --force is the human override and
        # is logged by the caller's own reason.
        why = auto_reply_refusal(fields, cache) or never_a_card_refusal(fields)
        if why:
            print(json.dumps({"action": "refused", "reason": why,
                              "key": verdict["key"], "dryRun": dry_run}))
            return 3
    if not force and not parent:
        rows = fetch_open_tasks()
        if not rows:
            # CONTROL: the board carries hundreds of open tasks at all times.
            print("GATE COULD NOT RUN: open-tasks read returned zero rows "
                  "(expected hundreds) — check the Status field name. "
                  "Nothing was created; count this item unhandled.", file=sys.stderr)
            return 2
        verdict = decide(fields, rows)

    if verdict["action"] == "update":
        task_id = verdict["taskId"]
        live = _request("GET", f"/{TASKS}/{task_id}?returnFieldsByFieldId=true")
        patch = build_update(live.get("fields", {}), fields, date.today().isoformat())
        if not dry_run:
            _request("PATCH", f"/{TASKS}/{task_id}",
                     {"typecast": True, "fields": patch})
            post_comment(task_id,
                         "Duplicate gate: folded a new item into this task instead of "
                         "creating a sibling (one subject = one open task). "
                         "New item: " + str(fields.get(F["name"], "")))
            write_track_record(task_id, fields)
        print(json.dumps({"action": "updated", "taskId": task_id,
                          "matchedName": verdict.get("matchedName", ""),
                          "key": verdict.get("key", ""), "dryRun": dry_run}))
        return 0

    if not dry_run:
        # typecast OFF, deliberately: with it on, a select value nobody has
        # ever seen becomes a new option instead of an error, and the task it
        # rides on is on no surface. Link fields take record ids and select
        # fields take existing option names; a miss is a loud 422 here, never
        # a quiet new option.
        try:
            created = _request("POST", f"/{TASKS}", {"typecast": False, "fields": fields})
        except RuntimeError as exc:
            if "422" not in str(exc):
                raise
            # A 422 with typecast off is a value Airtable will not take as-is
            # (a collaborator passed by email is the known case). Status is
            # already validated above, so the retry can no longer mint a
            # Status option; it is logged so a caller passing a bad select
            # value is seen rather than silently coerced.
            print("TYPECAST FALLBACK: the create was refused with typecast off "
                  f"({str(exc)[:200]}); retrying with typecast on, Status already "
                  "validated", file=sys.stderr)
            created = _request("POST", f"/{TASKS}", {"typecast": True, "fields": fields})
        task_id = created.get("id", "")
        write_track_record(task_id, fields)
    else:
        task_id = "(dry run)"
    out = {"action": "created", "taskId": task_id, "key": verdict.get("key", ""),
           "dryRun": dry_run, "status": fields.get(F["status"])}
    if fixed:
        out["statusCorrected"] = fixed
    if verdict.get("note"):
        out["note"] = verdict["note"]
    print(json.dumps(out))
    return 0


def track_record_for(fields, task_id=None, runner=None):
    """The TRACK RECORD block for a new task: every past task and email with
    the same sender, and any reference-like token in the name or description.
    Kevin's decision (8 Sep 2026): retrieval is a tool the triage step runs
    at creation, so every downstream agent inherits the same record. Returns
    the block text; a failure returns a line that SAYS it failed, so absence
    is visible on the card rather than silent."""
    import subprocess
    sender = str(fields.get(F["inboundSender"]) or "").strip().lower()
    text = " ".join(str(fields.get(k) or "") for k in (F["name"], F["desc"]))
    cmd = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent-dispatch.py"),
           "history", "--text", "--from-text", text[:2000]]
    if task_id and task_id != "(dry run)":
        cmd += ["--task", task_id]
    if sender and "@" in sender:
        cmd += ["--email", sender]
    run = runner or (lambda c: subprocess.run(c, capture_output=True, text=True, timeout=120))
    try:
        r = run(cmd)
    except Exception as e:                                   # noqa: BLE001
        return f"TRACK RECORD: not built ({str(e)[:120]})"
    if getattr(r, "returncode", 1) != 0 or not (r.stdout or "").strip():
        return "TRACK RECORD: not built (" + ((r.stderr or "").strip().splitlines() or ["history failed"])[-1][:160] + ")"
    return r.stdout.strip()


TRACK_BLOCK_RE = re.compile(
    r"^\[[^\]\n]*— create-agent-task\] TRACK RECORD:[^\n]*\n?"
    r"(?:[ \t]*[-*][ \t]+(?:\d{1,2} \w{3,4} \d{4}|\d{4}-\d{2}-\d{2})[^\n]*\n?)*", re.M)


def merge_track_record(notes, block, stamp):
    """One TRACK RECORD block per task: the newest replaces the one this gate
    wrote before (a subject that re-arrives five times must not stack five),
    and the length cap cuts on a line, never mid-stamp (review, 8 Sep 2026)."""
    kept = TRACK_BLOCK_RE.sub("", str(notes or "")).rstrip()
    merged = (kept + f"\n\n[{stamp} — create-agent-task] " + block).strip()
    if len(merged) > 90000:
        merged = merged[-90000:]
        cut = merged.find("\n")
        merged = merged[cut + 1:] if cut != -1 else merged
    return merged


def write_track_record(task_id, fields):
    """Put the TRACK RECORD on the task's Notes, dated, so the card and
    every agent see it. Never raises: a task with no record beats no task."""
    try:
        block = track_record_for(fields, task_id)
        live = _request("GET", f"/{TASKS}/{task_id}?returnFieldsByFieldId=true").get("fields", {}) or {}
        notes = merge_track_record(live.get(F["notes"]), block, date.today().strftime("%d %b %Y"))
        _request("PATCH", f"/{TASKS}/{task_id}", {"typecast": True, "fields": {F["notes"]: notes}})
        print("TRACK RECORD written: %s" % block.splitlines()[0][:120], file=sys.stderr)
    except Exception as e:                                   # noqa: BLE001
        print("TRACK RECORD not written: %s" % str(e)[:200], file=sys.stderr)


def cmd_check(name):
    rows = fetch_open_tasks()
    if not rows:
        print("GATE COULD NOT RUN: open-tasks read returned zero rows", file=sys.stderr)
        return 2
    print(json.dumps(decide({F["name"]: name}, rows)))
    return 0


def selftest():
    checks = []

    def check(label, cond):
        checks.append((label, bool(cond)))

    k = dupe_task_key
    check("references collide", k("Chase Acme invoice #2") == k("Chase Acme invoice #3"))
    check("brand digits kept", "v12" in k("Renew v12 licence"))
    check("pure digits dropped", "4471902" not in k("Pay ref 4471902"))
    check("empty name empty key", k("") == "" and k("#12345") == "")
    # Weekday and month words never count toward the key (Kevin, 15 Sep 2026).
    # Two Content Engine cards on the same weekday are two matters; two cards
    # a week apart with the same subject are still one matter by the verdict.
    fri = "CONTENT (OD): Fri 11 Sep, The offer: Five signs your business runs on you"
    fri2 = "CONTENT (OD): Fri 11 Sep, Newsletter: The map: how AI agents take 90% of your daily work"
    check("two cards on one weekday key apart", k(fri) != k(fri2))
    check("a weekday or month word is never a key slot",
          not ({"fri", "sep"} & set(k(fri).split("|")[-1].split()))
          and k("Monday 7 September rent statement") == k("Friday 11 October rent statement"))
    check("a date-only name still keys by its words, not to empty",
          k("CONTENT (OD): Fri 11 Sep") != "" and k("Fri 11 Sep") != k("Mon 14 Sep"))
    v = dupe_verdict("CONTENT (OD): Fri 11 Sep, The offer: Five signs your business runs on you",
                     "CONTENT (OD): Fri 18 Sep, The offer: Five signs your business runs on you",
                     mode="group")
    check("same subject a week apart still groups on its words",
          v["match"] and "fri" not in v["why"] and "sep" not in v["why"] and "signs" in v["why"])
    check("a shared weekday and month is not a shared subject",
          not dupe_verdict("CONTENT (OD): Fri 11 Sep, Newsletter: Six steps to turn your SOP into an agent",
                           "CONTENT (OD): Fri 18 Sep, The offer: Five signs your business runs on you",
                           mode="group")["match"])
    # Back-test (the reviewer's find): with DUPE_DATE_WORDS emptied this pair
    # matched on "both about fri, sep", the date being the ONLY words shared.
    check("two short cards sharing only a weekday and month never match",
          not dupe_verdict("CONTENT (OD): Fri 11 Sep, Newsletter",
                           "CONTENT (OD): Fri 11 Sep, The offer", mode="group")["match"])

    def row(rid, name, status="Today", sender="", created="2026-08-01T00:00:00.000Z",
            team=None, ticket=False):
        fields = {F["name"]: name, F["status"]: {"name": status}, F["inboundSender"]: sender}
        if team:
            fields[F["team"]] = team
        if ticket:
            fields[F["maintenance"]] = True
        return {"id": rid, "createdTime": created, "fields": fields}

    incoming = {F["name"]: "INBOUND: Outstanding invoices",
                F["inboundSender"]: "billing@acmecollections.co.uk",
                F["status"]: "Today", F["desc"]: "Second chaser.",
                F["priority"]: "Urgent", F["due"]: "2026-08-25"}

    same = row("rec1", "INBOUND: Outstanding invoices #2", sender="legal@acmecollections.co.uk")
    other = row("rec2", "INBOUND: Outstanding invoices", sender="accounts@othercorp.com")
    closed = row("rec3", "INBOUND: Outstanding invoices", status="Completed",
                 sender="billing@acmecollections.co.uk")

    check("same private domain folds", decide(incoming, [same])["action"] == "update")
    d = decide(incoming, [other])
    check("different sender creates with a note", d["action"] == "create" and "note" in d)
    check("closed tasks never match", decide(incoming, [closed])["action"] == "create")
    check("no sender vs sender does not fold",
          decide({F["name"]: "INBOUND: Outstanding invoices"}, [same])["action"] == "create")
    check("no sender both sides folds",
          decide({F["name"]: "Weekly cost review"},
                 [row("rec4", "Weekly cost review")])["action"] == "update")
    gmail_a = {F["name"]: "INBOUND: school fees", F["inboundSender"]: "a@gmail.com"}
    gmail_b = row("rec5", "INBOUND: school fees", sender="b@gmail.com")
    check("public domain never folds on domain alone",
          decide(gmail_a, [gmail_b])["action"] == "create")
    oldest = [row("recB", "Chase Acme invoice #9", sender="x@acme.com",
                  created="2026-08-20T00:00:00.000Z"),
              row("recA", "Chase Acme invoice #8", sender="x@acme.com",
                  created="2026-08-10T00:00:00.000Z")]
    check("oldest open task is the canonical fold target",
          decide({F["name"]: "Chase Acme invoice #10",
                  F["inboundSender"]: "y@acme.com"}, oldest)["taskId"] == "recA")

    existing = {F["desc"]: "Original ask.", F["status"]: {"name": "This Week"},
                F["due"]: "2026-08-28", F["priority"]: {"name": "High"}}
    p = build_update(existing, incoming, "2026-08-25")
    check("description appends, keeps original",
          p[F["desc"]].startswith("Original ask.") and "Second chaser." in p[F["desc"]])
    check("status refreshes to Today", p[F["status"]] == "Today")
    check("earliest due wins", p[F["due"]] == "2026-08-25")
    check("priority only moves up", p[F["priority"]] == "Urgent")
    approval = {F["desc"]: "With Kevin.", F["status"]: {"name": "Approval"},
                F["due"]: "2026-08-28", F["priority"]: {"name": "Urgent"}}
    p2 = build_update(approval, incoming, "2026-08-25")
    check("a task at Approval keeps its status and soft due",
          F["status"] not in p2 and F["due"] not in p2)
    check("priority never downgrades", F["priority"] not in p2)

    # The fold lane means reply-vs-maintenance only (Kevin, 15 Sep 2026).
    # The two live shapes that refused to fold on their raw prefixes:
    # rec2nZRQ1Y4ZXj9mA (COMPLIANCE) against keeper recODSge5r6SZ3IqQ
    # (CORRESPONDENCE), and the "INBOUND (follow-up):" / "INBOUND:" pairs.
    fold = lambda a, b: dupe_verdict(a, b, mode="fold")["match"]
    check("COMPLIANCE vs CORRESPONDENCE is one lane and folds",
          fold("COMPLIANCE: EICR quote follow-up - AC1 Electrical Services - 6 Chedburgh Place",
               "CORRESPONDENCE: Reply to AC1 Electrical - EICR bedroom count - 6 Chedburgh Place"))
    check("INBOUND (follow-up) vs INBOUND is one lane and folds",
          fold("INBOUND: 1406 Oldham Road electrical safety cert outstanding - Hester Ray chasing",
               "INBOUND (follow-up): 1406 Oldham Road EICR cert - send to Manchester Council"))
    check("a repair ticket never folds into a reply task (28 Aug lesson stands)",
          not fold("INBOUND: SMS reply from +447700900747", "REPAIR: SMS from 447700900747 - leaking tap")
          and not fold("INBOUND: SMS reply from +447700900747",
                       "MAINTENANCE: SMS from 447700900747 - maintenance reply"))
    check("two repair tickets are one lane (control for the lane test)",
          fold("REPAIR: SMS from 447700900747 - leaking tap", "MAINTENANCE: SMS reply from +447700900747"))
    check("grouping still crosses the repair lane",
          dupe_verdict("INBOUND: SMS reply from +447700900747",
                       "REPAIR: SMS from 447700900747 - leaking tap", mode="group")["match"])
    check("the fold lane is never the raw prefix",
          dupe_signals("COMPLIANCE: x")[0] == "reply" and dupe_signals("no prefix")[0] == "reply"
          and dupe_signals("REPAIR: x")[0] == "maintenance")
    # The RECORD says repair when the name does not: on the live board every
    # ticked Maintenance Ticket is unprefixed or "INBOUND:". Found by the
    # reviewer of the 15 Sep 2026 change, live shape recrKDP4gTq7OpCtt.
    roy_job = row("recRoy", "Provision of a valid EICR", team=[ROY_TEAM_MEMBER])
    ticked = row("recTick", "INBOUND: Inspection Report - 25 Abercorn Court", ticket=True)
    plain = row("recPlain", "Provision of a valid EICR")
    agent_task = {F["name"]: "COMPLIANCE: Provision of a valid EICR - 18 Siddows Avenue Clitheroe"}
    check("fold_lane reads the tick and Roy ahead of the name",
          fold_lane("Clear and tidy garden", [ROY_TEAM_MEMBER]) == "maintenance"
          and fold_lane("INBOUND: x", None, True) == "maintenance"
          and fold_lane("Clear and tidy garden") == "reply")
    check("an agent task never folds into Roy's unprefixed job",
          decide(agent_task, [roy_job])["action"] == "create")
    check("a reply task never folds into a ticked INBOUND ticket, even on the exact key",
          decide({F["name"]: "INBOUND: Inspection Report - 25 Abercorn Court"}, [ticked])["action"] == "create")
    check("a ticked incoming never folds into a reply task",
          decide({F["name"]: "Provision of a valid EICR", F["maintenance"]: True}, [plain])["action"] == "create")
    check("two repair records fold (control: the lane read is not a blanket refusal)",
          decide({F["name"]: "Provision of a valid EICR", F["maintenance"]: True},
                 [roy_job])["action"] == "update")
    check("the same words with no tick and no Roy still fold (control)",
          decide(agent_task, [plain])["action"] == "update")

    check("bracketed sender folds with its bare form",
          senders_agree("Alice Smith <billing@acme.com>", "billing@acme.com"))
    check("two different public-mailbox users never fold, bracketed or not",
          not senders_agree("Alice <alice@gmail.com>", "Bob <bob@gmail.com>"))

    inc_url = dict(incoming)
    inc_url[F["inboundUrl"]] = "https://mail.google.com/mail/u/0/#all/THREAD2"
    ex_url = {F["desc"]: "x", F["status"]: {"name": "Today"},
              F["inboundUrl"]: "https://mail.google.com/mail/u/0/#all/THREAD1"}
    pu = build_update(ex_url, inc_url, "2026-08-25")
    check("fold trace: new thread URL appended to the dedupe field",
          pu[F["inboundUrl"]].endswith("#all/THREAD2") and "#all/THREAD1" in pu[F["inboundUrl"]])
    ex_same = dict(ex_url)
    ex_same[F["inboundUrl"]] = inc_url[F["inboundUrl"]]
    check("fold trace: an already-recorded URL is not appended twice",
          F["inboundUrl"] not in build_update(ex_same, inc_url, "2026-08-25"))

    hard_ex = {F["desc"]: "court", F["status"]: {"name": "Today"},
               F["due"]: "2026-09-10", F["hardDeadline"]: True}
    soft_in = {F["name"]: "chaser", F["desc"]: "chase", F["status"]: "Today",
               F["due"]: "2026-08-25"}
    check("a soft chaser never drags a hard deadline's date",
          F["due"] not in build_update(hard_ex, soft_in, "2026-08-25"))
    hard_in = dict(soft_in)
    hard_in[F["hardDeadline"]] = True
    hard_in[F["due"]] = "2026-09-01"
    soft_ex = {F["desc"]: "x", F["status"]: {"name": "Today"}, F["due"]: "2026-09-15"}
    ph = build_update(soft_ex, hard_in, "2026-08-25")
    check("a hard incoming date beats a soft due and carries the flag",
          ph[F["due"]] == "2026-09-01" and ph[F["hardDeadline"]] is True)
    both = build_update(hard_ex, hard_in, "2026-08-25")
    check("two hard dates keep the earlier", both[F["due"]] == "2026-09-01")
    apv_hard = {F["desc"]: "x", F["status"]: {"name": "Approval"}, F["due"]: "2026-09-15"}
    pa = build_update(apv_hard, hard_in, "2026-08-25")
    check("a hard deadline updates due even at Approval, without moving status",
          pa[F["due"]] == "2026-09-01" and F["status"] not in pa)

    # ── auto-replies never become tasks (2 Sep 2026) ──
    sig = auto_reply_signal
    check("RFC 3834 header wins", sig({"Auto-Submitted": "auto-replied"}, "Re: hi", "") and
          sig({"Auto-Submitted": "auto-replied"}, "Re: hi", "").startswith("header"))
    check("Auto-Submitted: no is not a signal", sig({"auto-submitted": "no"}, "Re: hi", "") is None)
    check("Exchange suppress header on a subject-family reply still flags by subject",
          str(sig({"X-Auto-Response-Suppress": "All"}, "Automatic reply: x", "")).startswith("subject"))
    check("Automatic reply subject (Burnley shape)",
          sig({}, "Automatic reply: Liability Order — 22 Newton Street", "") is not None)
    check("bracketed tag before the prefix",
          sig({}, "[EXTERNAL] Automatic reply: Account IST", "") is not None)
    check("out of office subject", sig({}, "Out of Office", "") is not None)
    check("a human reply inside the auto-reply thread is NOT one",
          sig({}, "RE: Automatic reply: Liability Order", "Hi Kevin, can you resend?") is None)
    fylde = ("Thank you for contacting Fylde Borough Council.\n\nYour request has been "
             "logged with reference CSV-2026-1000. Please quote this reference in any "
             "future correspondence.\n\nYou will receive an initial response within two "
             "working days.")
    check("Fylde receipt body flags", sig({}, "RE: Council Tax Account 20000360", fylde) is not None)
    check("forwarded-to-department body flags",
          sig({}, "RE: Follow-up", "Good Morning,\n\nThank you for your email.\n\nWe have "
              "forwarded your email to our Revenues department for their attention.") is not None)
    check("an acknowledgement with a question is a human",
          sig({}, "RE: x", "Thank you for contacting us. Could you send the order copy?") is None)
    check("an acknowledgement with an instruction is a human",
          sig({}, "RE: x", "Thank you for contacting us. Please provide proof of ID.") is None)
    check("receipt phrase only inside the quoted original does not count",
          sig({}, "RE: x", "We reviewed this and disagree.\n\nFrom: Council\nThank you for "
              "contacting us. Your request has been logged with reference 1.") is None)
    check("plain human mail is not flagged", sig({}, "Rent query", "Hi, the boiler is broken.") is None)
    check("auto-replied header is definitive even with an ask in the body",
          str(sig({"Auto-Submitted": "auto-replied"}, "Re: x", "Please pay £100 by Friday")).startswith("header"))
    check("auto-generated header does NOT override an ask (Stripe/Adobe shape)",
          sig({"auto-submitted": "auto-generated"}, "Action required", "Please complete verification by 9 Oct.") is None)
    check("Exchange suppress header alone is NOT a signal (flagged phishing on the live corpus)",
          sig({"X-Auto-Response-Suppress": "OOF, AutoReply", "list-unsubscribe": "<x>"}, "Visit on August 31",
              "<table><tr><td>Home</td></tr></table>") is None)
    check("a bounce is a task, never a receipt, even with auto-replied set",
          sig({"auto-submitted": "auto-replied", "from": "Mail Delivery Subsystem <mailer-daemon@googlemail.com>"},
              "Delivery Status Notification (Failure)", "Final-Recipient: rfc822; x@y.com\nAction: failed") is None)
    check("an 'Undeliverable' subject is a bounce whoever sent it",
          sig({"auto-submitted": "auto-replied"}, "Undeliverable: Liability Order", "") is None)
    check("a position taken is a human (notice to quit)",
          sig({}, "RE: notice", "We have received your notice to quit. Our client does not accept it.") is None)
    check("a person promising to respond is a human",
          sig({}, "RE: plumber", "Hi Kevin, I will respond within the week once I have spoken to the plumber.") is None)
    check("'Ooo la la' is not out of office", sig({}, "Ooo la la bathroom quote", "") is None)
    check("long external-sender tag before the prefix",
          sig({}, "[EXTERNAL SENDER WARNING] Automatic reply: x", "") is not None)
    check("stacked lane prefixes are all stripped",
          auto_reply_refusal({F["name"]: "INBOUND (follow-up): INBOUND: Automatic reply: x"}, {}) is not None)
    check("gate refuses an auto-reply task name",
          auto_reply_refusal({F["name"]: "INBOUND: Automatic reply: Liability Order"}, {})
          .startswith("task name"))
    check("gate refuses a follow-up-prefixed auto-reply name",
          auto_reply_refusal({F["name"]: "INBOUND (follow-up): Out of office: Jo Bloggs"}, {}))
    cache = {"m1": {"threadId": "1a047d45bad0d05a", "auto_reply": "subject: Automatic reply"},
             "m2": {"threadId": "1a0496b9df667238", "auto_reply": "body: has been logged with reference"},
             "m3": {"threadId": "1a0496b9df667238", "auto_reply": None}}
    fylde_task = {F["name"]: "INBOUND: RE: Council Tax Account 20000360",
                  F["inboundUrl"]: "https://mail.google.com/mail/u/0/#all/1a047d45bad0d05a"}
    check("gate refuses a task whose thread is all auto-replies",
          auto_reply_refusal(fylde_task, cache) and "thread 1a047d45bad0d05a" in
          auto_reply_refusal(fylde_task, cache))
    mixed = dict(fylde_task, **{F["inboundUrl"]: "https://mail.google.com/mail/u/0/#all/1a0496b9df667238"})
    check("a thread with one human message still creates", auto_reply_refusal(mixed, cache) is None)
    unknown = dict(fylde_task, **{F["inboundUrl"]: "https://mail.google.com/mail/u/0/#inbox/deadbeef00"})
    check("an unscanned thread is not assumed to be an auto-reply", auto_reply_refusal(unknown, cache) is None)
    check("a normal task name passes", auto_reply_refusal({F["name"]: "INBOUND: reply to Swinton"}, cache) is None)
    # Never a card (Kevin, 17 Sep 2026): real task names off the rejection log.
    nac = lambda name, desc="": never_a_card_refusal({F["name"]: name, F["desc"]: desc})
    check("a Stripe notice for liquidated Two Chefs is refused",
          nac("INBOUND: Stripe action required - verify Two Chefs Cambridge business") is not None)
    check("a Revolut notice for Social Housing Holdings is refused",
          nac("INBOUND: Revolut failed transfer 13764.44 - Social Housing Holdings (liquidation)") is not None)
    check("the Official Receiver writing about Social Housing Holdings is created",
          nac("INBOUND: POST: Official Receiver - Social Housing Holdings Ltd") is None)
    check("a court claim naming the cafe is created",
          nac("Cafe @ Highgate - HM Courts and Tribunals Service Civil Claims") is None)
    check("a GBP 1.42 payout failure is refused",
          nac("INBOUND: GoCardless payout of 1.42 failed, resend or investigate") is not None)
    check("a failed rent collection is created whatever the amount",
          nac("INBOUND: GoCardless Lex Dorey payment failed rent arrears", "Amount 1.42") is None)
    check("a GBP 250 payment failure is created",
          nac("INBOUND: Barclaycard payment of £250.00 failed") is None)
    check("a failure with no amount is created",
          nac("INBOUND: NatWest payment failed - check account") is None)
    check("an ordinary task passes", nac("INBOUND: Sefton Council licence fee £150") is None)

    # ── Hard deadline vs receipt date (finding …-447) ───────────────────
    # The two live tasks that exposed it, verbatim off the board on 4 Sep 2026.
    T = date(2026, 9, 4)

    def corr(name, due, hard=True, desc=""):
        f = {F["name"]: name, F["due"]: due, F["desc"]: desc}
        if hard:
            f[F["hardDeadline"]] = True
        got = hard_deadline_correction(f, T)
        return got[0] if got else None

    check("Simarc: the stated 29 Sep beats the receipt date",
          corr("INBOUND: Simarc - pay ground rent GBP 6 by 29 Sep, 23 Viola Street Bootle",
               "2026-09-01") == "2026-09-29")
    check("HMRC: 'respond by Sep 17' is read month-first too",
          corr("INBOUND: HMRC formal compliance check Self Assessment - respond by Sep 17",
               "2026-09-01") == "2026-09-17")
    check("a UK-order slash date is read day-first",
          corr("INBOUND: pay by 29/09/2026", "2026-09-01") == "2026-09-29")
    check("an ISO date in the body is read",
          corr("INBOUND: hearing", "2026-09-01", desc="attend by 2026-10-02") == "2026-10-02")
    check("TWO stated dates are ambiguous, so nothing is touched",
          corr("INBOUND: by 5 Sep and by 29 Sep", "2026-09-01") is None)
    check("no stated date changes nothing",
          corr("INBOUND: tenant rang about the boiler", "2026-09-01") is None)
    check("a SOFT due date is never rewritten",
          corr("INBOUND: pay by 29 Sep", "2026-09-01", hard=False) is None)
    # The three ways a timid correction turns into a wild one.
    check("a stated date EARLIER than the due date is left alone",
          corr("INBOUND: pay by 1 Sep", "2026-09-20") is None)
    check("a just-passed date resolves to THIS year, not the next",
          stated_deadlines("pay by 1 Sep", T) == [date(2026, 9, 1)])
    check("a task created before it still gets the correction",
          corr("INBOUND: pay by 1 Sep", "2026-08-25") == "2026-09-01")
    check("a deadline beyond the horizon is a misparse, not a deadline",
          corr("INBOUND: renewal by 29 Sep 2027", "2026-09-01") is None)
    check("a genuine year rollover still resolves",
          corr("INBOUND: court by 3 Jan", "2026-12-20") == "2027-01-03")
    check("no due date means nothing to correct",
          corr("INBOUND: pay by 29 Sep", "") is None)

    # ── The letter's stated `Deadline:` line (finding …-450) ────────────
    # The exact shape the post-manager emails, and the exact shape it arrives
    # in once Gmail has quoted it.
    POST_MAIL = ("This document was scanned from physical post on 16 August 2026.\n\n"
                 "Sender: Companies House\n"
                 "Summary: ACTION TO STRIKE OFF SOCIAL HOUSING ESTATES LIMITED\n"
                 "Recommended action: file the outstanding accounts\n"
                 "Urgency: high\n"
                 "Deadline: 2026-09-29\n\n"
                 "The PDF is attached.")
    check("a real date is read off the Deadline line",
          parse_deadline_line(POST_MAIL) == "2026-09-29")
    check("the line survives Gmail quoting and HTML escaping",
          parse_deadline_line("&gt; Urgency: high\n&gt; Deadline: 2026-09-29\n") == "2026-09-29")
    check("'Deadline: none' is not a date",
          parse_deadline_line(POST_MAIL.replace("2026-09-29", "none")) is None)
    check("no Deadline line at all reads as no date",
          parse_deadline_line("Sender: Fylde Council\nUrgency: low\n") is None)
    check("a malformed date is refused rather than guessed",
          parse_deadline_line("Deadline: 2026-13-45\n") is None and
          parse_deadline_line("Deadline: 29 Sept\n") is None)
    check("half a date range is never read as the deadline",
          parse_deadline_line("Deadline: 2026-09-29/2026-10-02\n") is None)
    check("a missing zero is still an unambiguous date",
          parse_deadline_line("Deadline: 2026-9-5\n") == "2026-09-05")
    check("a date already passed is still returned — a closed window is the alarm",
          parse_deadline_line("Deadline: 2026-08-01\n") == "2026-08-01")
    check("two lines stating DIFFERENT dates are ambiguous, so neither is used",
          parse_deadline_line("Deadline: 2026-09-29\nDeadline: 2026-10-02\n") is None)
    check("the same date stated twice is not ambiguous",
          parse_deadline_line("Deadline: 2026-09-29\n"
                              "DEADLINE FROM THE LETTER: 2026-09-29") == "2026-09-29")

    # The stamp itself: Due Date and Hard Deadline move together, or the
    # guards downstream have nothing to read.
    post_fields = {F["name"]: "INBOUND: POST: Companies House - ActionToStrikeOff",
                   F["desc"]: "Review and action inbound email.",
                   F["due"]: "2026-09-05",
                   F["inboundUrl"]: "https://mail.google.com/mail/u/0/#all/1a01446d57c3f497"}
    scan = {"m1": {"threadId": "1a01446d57c3f497", "deadline": "2026-09-29"}}
    f = dict(post_fields)
    why = apply_letter_deadline(f, scan)
    check("the scanned body's deadline becomes Due Date AND Hard Deadline",
          why and f[F["due"]] == "2026-09-29" and f[F["hardDeadline"]] is True)
    check("the date is written onto the task where a human can see it",
          DEADLINE_MARKER + "2026-09-29" in f[F["desc"]])
    check("stamping twice does not duplicate the marker",
          apply_letter_deadline(f, scan) and f[F["desc"]].count(DEADLINE_MARKER) == 1)
    f2 = dict(post_fields, **{F["desc"]: "body says\nDeadline: 2026-10-02"})
    apply_letter_deadline(f2, scan)
    check("the task's own text outranks the cache",
          f2[F["due"]] == "2026-10-02")
    f3 = dict(post_fields)
    check("mail with no stated deadline is left entirely alone",
          apply_letter_deadline(f3, {"m1": {"threadId": "1a01446d57c3f497",
                                            "deadline": None}}) is None and
          f3[F["due"]] == "2026-09-05" and F["hardDeadline"] not in f3)
    f4 = dict(post_fields)
    check("an unscanned thread stamps nothing",
          apply_letter_deadline(f4, {}) is None and F["hardDeadline"] not in f4)
    # The whole point: a parsed date is never a judgement call, so the
    # receipt-date correction must not get to run over it.
    f5 = dict(post_fields, **{F["name"]: "INBOUND: POST: pay by 29 Sep",
                              F["hardDeadline"]: True})
    apply_letter_deadline(f5, scan)
    check("a parsed deadline survives the correction path",
          hard_deadline_correction(f5, T) is None and f5[F["due"]] == "2026-09-29")

    # Status on create (15 Sep 2026): only a board status leaves this script.
    for passed, want in (("Open", "Today"), ("2026-09-10", "Today"), (None, "Today"),
                         ("Completed", "Today"), ("Overdue", "Today"),
                         ("Today", "Today"), ("Upcoming", "Upcoming"), ("Approval", "Today")):
        f6 = {F["name"]: "X", F["notes"]: "kept"}
        if passed is not None:
            f6[F["status"]] = passed
        line = normalise_status(f6, "15 Sep 2026")
        corrected = want == "Today" and passed != "Today"
        check(f"status {passed!r} -> {want}", f6[F["status"]] == want)
        check(f"status {passed!r} note line only when corrected",
              (line is not None) == corrected and
              (STATUS_FIX_MARK in f6[F["notes"]]) == corrected and
              f6[F["notes"]].startswith("kept"))
    f8 = {F["name"]: "X", F["status"]: "Approval", F["sentForApprovalBy"]: ["recAgent"]}
    check("Approval WITH a sender is a real card and stays",
          normalise_status(f8, "15 Sep 2026") is None and f8[F["status"]] == "Approval")
    f7 = {F["name"]: "X", F["status"]: {"name": "Open"}}
    check("a select object is read like a name",
          normalise_status(f7, "15 Sep 2026") and f7[F["status"]] == "Today"
          and "'Open'" in f7[F["notes"]])
    # The fold path validates the same way (it PATCHes with typecast on).
    patch = build_update({F["desc"]: "a", F["status"]: {"name": "Today"}},
                         {F["desc"]: "b", F["status"]: "Open"}, "2026-09-15")
    check("fold path never writes a non-board status", patch[F["status"]] == "Today")
    patch = build_update({F["desc"]: "a", F["status"]: {"name": "Today"}},
                         {F["desc"]: "b", F["status"]: "Approval"}, "2026-09-15")
    check("fold path never writes a sender-less Approval", patch[F["status"]] == "Today")
    # And the create itself goes out with typecast OFF, carrying the corrected
    # status: the whole point, so it is asserted on the request that leaves.
    sent = []
    g = globals()
    saved = (g["_request"], g["load_scan_cache"], g["write_track_record"])
    try:
        g["_request"] = lambda m, p, body=None: (sent.append((m, p, body)) or {"id": "recNEW"})
        g["load_scan_cache"] = lambda: {}
        g["write_track_record"] = lambda tid, fields: None
        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            rc = cmd_create({F["name"]: "INBOUND: selftest", F["status"]: "Open",
                             F["due"]: "2026-09-20"}, force=True)
        posted = [b for m, p, b in sent if m == "POST"]
        check("create POSTs once with typecast off",
              rc == 0 and len(posted) == 1 and posted[0]["typecast"] is False)
        check("create POSTs the corrected status, never the passed one",
              posted and posted[0]["fields"][F["status"]] == "Today"
              and STATUS_FIX_MARK in posted[0]["fields"][F["notes"]])
        check("the caller is told the status was corrected",
              json.loads(buf.getvalue().strip().splitlines()[-1]).get("statusCorrected"))
    finally:
        g["_request"], g["load_scan_cache"], g["write_track_record"] = saved

    failed = [label for label, ok in checks if not ok]
    print(json.dumps({"checks": len(checks), "failed": failed}))
    return 1 if failed else 0


def main(argv):
    if not argv:
        print(__doc__)
        return 1
    cmd = argv[0]
    if cmd == "selftest":
        return selftest()
    if cmd == "check":
        if len(argv) < 3 or argv[1] != "--name":
            print("usage: check --name '<task name>'", file=sys.stderr)
            return 1
        return cmd_check(argv[2])
    if cmd == "create":
        fields, force, dry, parent = None, False, False, None
        i = 1
        while i < len(argv):
            if argv[i] == "--fields-json":
                fields = json.loads(argv[i + 1]); i += 2
            elif argv[i] == "--parent":
                parent = argv[i + 1]; i += 2
            elif argv[i] == "--force":
                force = True; i += 1
            elif argv[i] == "--dry-run":
                dry = True; i += 1
            else:
                print(f"unknown flag {argv[i]}", file=sys.stderr); return 1
        if fields is None:
            print("create needs --fields-json", file=sys.stderr)
            return 1
        return cmd_create(fields, force=force, dry_run=dry, parent=parent)
    print(f"unknown command {cmd}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
