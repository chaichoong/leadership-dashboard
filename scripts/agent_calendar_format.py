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

Times are London wall-clock (Europe/London is stamped at create time, so BST
and GMT need no thought here). The parser checks shape only; the past-date
check lives in calendar-write.py, at create time, because a draft can sit in
the approval queue across midnight without becoming malformed.
"""

import re
from datetime import datetime

from agent_email_format import strip_carry_out_line, strip_tier1_banner


class CalendarFormatError(ValueError):
    pass


CAL_MARKER = "CALENDAR:"
TIME_FORMAT = "%Y-%m-%d %H:%M"
TIMEZONE = "Europe/London"

REQUIRED_HEADERS = ("TITLE", "START", "END")
OPTIONAL_HEADERS = ("LOCATION", "NOTES")

# Anything that would make the entry email a third party. Refused by NAME so
# the error explains itself; an unknown header is refused too, but these get
# the reason that matters.
FORBIDDEN_HEADERS = ("ATTENDEES", "ATTENDEE", "GUESTS", "GUEST", "INVITE",
                     "INVITEES", "TO", "CC", "EMAIL")

HEADER_RE = re.compile(r"^([A-Z]+):\s*(.*)$")


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
        if key not in REQUIRED_HEADERS + OPTIONAL_HEADERS:
            raise CalendarFormatError(f"unknown header {key}")
        if key in fields:
            raise CalendarFormatError(f"duplicate header {key}")
        if not value:
            raise CalendarFormatError(f"{key} is empty")
        fields[key] = value

    for key in REQUIRED_HEADERS:
        if key not in fields:
            raise CalendarFormatError(f"missing required header {key}")

    start = _parse_time(fields["START"], "START")
    end = _parse_time(fields["END"], "END")
    if end <= start:
        raise CalendarFormatError(
            f"END ({fields['END']}) must be after START ({fields['START']})")

    summary = strip_carry_out_line("\n".join(lines[body_at + 1:])).strip()
    if not summary:
        raise CalendarFormatError(
            "the summary below `---` is required: approving a title is not "
            "consent to the entry, the same rule as SIGN and POST")

    return {
        "title": fields["TITLE"],
        "start": start.strftime("%Y-%m-%dT%H:%M:00"),
        "end": end.strftime("%Y-%m-%dT%H:%M:00"),
        "timeZone": TIMEZONE,
        "location": fields.get("LOCATION", ""),
        "notes": fields.get("NOTES", ""),
        "summary": summary,
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
