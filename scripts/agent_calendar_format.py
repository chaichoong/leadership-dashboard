#!/usr/bin/env python3
"""The CALENDAR contract — shared by the submit gate and calendar-write.py.

One shape, defined once, for the same reason as agent_email_format.py: if the
submit gate and the carry-out script each had their own parser, submit would
eventually accept an output the carry-out refuses, and the refusal would land
AFTER Kevin's approval — the exact failure the email contract was written to
end (finding 20260811-agent-dispatch-085).

A calendar entry is Kevin's own diary. It never reaches a third party, which
is why it is allowed at all. Anything that would EMAIL someone — an invite, an
attendee, a guest — is Correspondence and goes through the email gate instead.
The forbidden-header list below enforces that at parse time.

AGENT OUTPUT FORMAT (a calendar task must use exactly this, Task Type Admin)

    CALENDAR:
    TITLE: Insurance renewal call with Aviva
    START: 2026-09-10 14:00
    END: 2026-09-10 14:30
    LOCATION: optional, plain text
    NOTES: optional, plain text carried into the event description
    ---
    Plain-English summary of what this entry is and why it exists.
    **Carrying this out will involve:** ...

MOVING OR REMOVING AN ENTRY THE ROBOT WROTE (Kevin, 18 Oct 2026). When an
appointment whose entry is already in the diary moves or is cancelled, the
card names the earlier diary task, and only an entry calendar-write.py's own
ledger shows it wrote can be touched:

    CALENDAR:
    REPLACES: recXXXXXXXXXXXXXX      <- the earlier diary task; its entry moves
    TITLE: ...                          to this title and time (one entry, never two)
    START: ...
    END: ...
    ---
    summary

    CALENDAR:
    CANCELS: recXXXXXXXXXXXXXX       <- the earlier diary task; its entry is removed
    ---                                 (no TITLE, START, END, LOCATION or NOTES)
    summary

Times are London wall-clock (Europe/London is stamped at create time, so BST
and GMT need no thought here). The parser checks shape only; the past-date
check lives in calendar-write.py, at create time, because a draft can sit in
the approval queue across midnight without becoming malformed.
"""

import json
import os
import re
from datetime import datetime

from agent_email_format import strip_carry_out_line, strip_tier1_banner


class CalendarFormatError(ValueError):
    pass


CAL_MARKER = "CALENDAR:"
TIME_FORMAT = "%Y-%m-%d %H:%M"
TIMEZONE = "Europe/London"

REQUIRED_HEADERS = ("TITLE", "START", "END")
OPTIONAL_HEADERS = ("LOCATION", "NOTES", "REPLACES")
# A cancellation carries the earlier task and the summary, nothing else.
CANCEL_HEADER = "CANCELS"
REC_ID_RE = re.compile(r"^rec[A-Za-z0-9]{14}$")

# Anything that would make the entry email a third party. Refused by NAME so
# the error explains itself; an unknown header is refused too, but these get
# the reason that matters.
FORBIDDEN_HEADERS = ("ATTENDEES", "ATTENDEE", "GUESTS", "GUEST", "INVITE",
                     "INVITEES", "TO", "CC", "EMAIL")

HEADER_RE = re.compile(r"^([A-Z]+):\s*(.*)$")

# Where calendar-write.py records each diary write, one row per task: "intent"
# before the worker call, "created" after it. Read by agent-dispatch.py
# `complete` too, so an approved diary card never closes with nothing written.
CALENDAR_LEDGER = os.path.expanduser(
    "~/knowledge-os/logs/agent-dispatch/calendar-created.jsonl")


def is_calendar(output):
    """True when this output claims the CALENDAR shape (banner tolerated)."""
    text = strip_tier1_banner(output or "").strip()
    first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    return first.upper() == CAL_MARKER


def _parse_time(value, header):
    try:
        return datetime.strptime(value, TIME_FORMAT)
    except ValueError:
        raise CalendarFormatError(
            f"{header} must be London wall-clock time in the form "
            f"YYYY-MM-DD HH:MM, got {value!r}")


def parse_calendar(output):
    """The parsed event dict, or CalendarFormatError. Never guesses a field."""
    text = strip_tier1_banner(output or "").strip()
    if not text:
        raise CalendarFormatError("empty output")

    lines = text.splitlines()
    # Find the marker and the --- separator.
    body_at = None
    for i, ln in enumerate(lines):
        if ln.strip() == "---":
            body_at = i
            break
    if body_at is None:
        raise CalendarFormatError(
            "missing the `---` line between the headers and the summary")

    head = [ln for ln in lines[:body_at] if ln.strip()]
    if not head or head[0].strip().upper() != CAL_MARKER:
        raise CalendarFormatError("first line must be exactly `CALENDAR:`")

    fields = {}
    for ln in head[1:]:
        m = HEADER_RE.match(ln.strip())
        if not m:
            raise CalendarFormatError(
                f"header line is not KEY: value: {ln.strip()!r}")
        key, value = m.group(1), m.group(2).strip()
        if key in FORBIDDEN_HEADERS:
            raise CalendarFormatError(
                f"{key} is not allowed: a calendar entry never emails a third "
                "party. Anything inviting someone is Correspondence and goes "
                "through the email gate")
        if key not in REQUIRED_HEADERS + OPTIONAL_HEADERS + (CANCEL_HEADER,):
            raise CalendarFormatError(f"unknown header {key}")
        if key in fields:
            raise CalendarFormatError(f"duplicate header {key}")
        if not value:
            raise CalendarFormatError(f"{key} is empty")
        fields[key] = value

    for key in ("REPLACES", CANCEL_HEADER):
        if key in fields and not REC_ID_RE.match(fields[key]):
            raise CalendarFormatError(
                f"{key} must be the earlier diary task's record id (rec + 14 "
                f"characters), got {fields[key]!r}")

    summary = strip_carry_out_line("\n".join(lines[body_at + 1:])).strip()
    if not summary:
        raise CalendarFormatError(
            "the summary below `---` is required: approving a title is not "
            "consent to the entry, the same rule as SIGN and POST")

    if CANCEL_HEADER in fields:
        extra = sorted(k for k in fields if k != CANCEL_HEADER)
        if extra:
            raise CalendarFormatError(
                f"a CANCELS block removes an entry and carries nothing else, got "
                f"{', '.join(extra)}")
        return {"cancels": fields[CANCEL_HEADER], "summary": summary}

    for key in REQUIRED_HEADERS:
        if key not in fields:
            raise CalendarFormatError(f"missing required header {key}")

    start = _parse_time(fields["START"], "START")
    end = _parse_time(fields["END"], "END")
    if end <= start:
        raise CalendarFormatError(
            f"END ({fields['END']}) must be after START ({fields['START']})")

    return {
        "title": fields["TITLE"],
        "start": start.strftime("%Y-%m-%dT%H:%M:00"),
        "end": end.strftime("%Y-%m-%dT%H:%M:00"),
        "timeZone": TIMEZONE,
        "location": fields.get("LOCATION", ""),
        "notes": fields.get("NOTES", ""),
        "summary": summary,
        "replaces": fields.get("REPLACES", ""),
    }


def calendar_submit_problem(output, task_type):
    """Reason the submit gate should refuse this output, or empty string.

    Mirrors send_promise_problem's contract: quiet on anything that is not a
    CALENDAR output, loud BEFORE Kevin approves on anything that is and that
    calendar-write.py would refuse afterwards.
    """
    if not is_calendar(output):
        return ""
    if task_type != "Admin":
        return ("a CALENDAR output must be submitted with --type Admin so the "
                "carry-out routes to scripts/calendar-write.py, got Task Type "
                f"{task_type or '(empty)'}")
    try:
        parse_calendar(output)
    except CalendarFormatError as exc:
        return f"its CALENDAR block is malformed: {exc}"
    return ""


def ledger_rows(ledger=None):
    """Every readable row of calendar-write.py's ledger. A damaged line is skipped:
    it proves nothing was written, so it never counts as a write."""
    path = ledger or CALENDAR_LEDGER
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict):
                rows.append(row)
    return rows


# The ledger events that mean the diary was changed for that task.
WRITTEN_EVENTS = ("created", "moved", "deleted")


def diary_written(task_id, ledger=None):
    """True when calendar-write.py's ledger shows it wrote this task's change to the
    diary: an entry created, an entry moved, or an entry removed."""
    return any(r.get("task") == task_id and r.get("event") in WRITTEN_EVENTS
               for r in ledger_rows(ledger))


def written_entry(task_id, ledger=None):
    """(event id, problem): the diary entry the robot wrote for this task, followed
    through any later move, or ("", why not). Only the robot's own ledger counts: an
    entry Kevin or Gmail made is never touched."""
    rows = ledger_rows(ledger)
    ids = [r.get("id") for r in rows
           if r.get("task") == task_id and r.get("event") in ("created", "moved") and r.get("id")]
    if not ids:
        return "", (f"the ledger has no diary entry written for {task_id}, so there is "
                    "nothing of the robot's to move or remove")
    event_id = ids[-1]
    if any(r.get("event") == "deleted" and r.get("id") == event_id for r in rows):
        return "", f"the entry written for {task_id} has already been removed"
    return event_id, ""


def calendar_ref_problem(output, ledger=None):
    """Why a REPLACES or CANCELS block may not be submitted, or "". Quiet on any other
    output. Loud BEFORE Kevin approves, so the refusal never lands after his yes."""
    if not is_calendar(output):
        return ""
    try:
        event = parse_calendar(output)
    except CalendarFormatError:
        return ""          # calendar_submit_problem reports the shape
    ref = event.get("cancels") or event.get("replaces")
    if not ref:
        return ""
    return written_entry(ref, ledger)[1]
