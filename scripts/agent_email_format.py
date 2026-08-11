#!/usr/bin/env python3
"""The one definition of what a Correspondence Agent Output looks like.

WHY THIS EXISTS
Two scripts had to agree on this format and did not.

  * scripts/agent-dispatch.py accepted ANY text as a `--type Correspondence`
    submission. Task recFdEICxHjYCzDkS went in as a long analysis document with
    the email buried in prose. Kevin approved it, the loop believed the action
    was ready, and `send-email.py preview` failed days later at carry-out time
    with "header line is not KEY: value". An approved action that cannot be
    carried out is worse than a refused one, because the refusal arrives after
    the decision.
  * scripts/agent-dispatch.py also prepends TIER1_BANNER to tier-1 output. The
    banner starts ":rotating_light: TIER 1. ..." so `partition(':')` read it as
    a header with an empty key, and send-email.py refused every tier-1
    Correspondence task it was handed. The two controls contradicted each other
    by construction.

So the parser lives here, once, and the banner constant lives here, once. The
submit path validates with the very function the send path will later use, and
both strip the banner the same way.

FORMAT

    TO: someone@example.com, other@example.com
    CC: optional@example.com
    FROM: optional-sender@example.com
    SUBJECT: The subject line
    ---
    The body of the email, as many lines as needed.

A tier-1 banner may sit above the headers. It is stripped before parsing and
never reaches the email.

Errors raise EmailFormatError. Callers decide whether that is a sys.exit (the
send path) or a refused submit (the dispatch path). Strict on purpose: a
malformed block is a refusal, never a guess, because guessing here means
guessing a recipient.
"""

import re

EMAIL_RE = re.compile(r"^[^@\s,]+@[^@\s,]+\.[^@\s,]+$")

ALLOWED_HEADERS = {"TO", "CC", "SUBJECT", "FROM"}

# Prepended by agent-dispatch.py `submit --tier1`. Defined here so the writer
# and the parser can never drift: the string that gets added is the string that
# gets stripped.
TIER1_BANNER = (
    ":rotating_light: TIER 1. This touches your private legal and financial "
    "matter. An AI agent prepared it. Nothing has been sent, filed, paid or "
    "changed anywhere. Read it before you approve."
)


class EmailFormatError(Exception):
    """An Agent Output that does not meet the Correspondence contract."""


def strip_tier1_banner(output):
    """Remove a leading tier-1 banner and the blank line that follows it.

    Only a LEADING banner is removed. A banner quoted inside the body is body
    text and stays: this function decides what the email is, not what it says.
    """
    text = output.lstrip()
    if text.startswith(TIER1_BANNER):
        text = text[len(TIER1_BANNER):]
    return text.lstrip("\n").lstrip()


def parse_addresses(raw, field):
    out = []
    for part in re.split(r"[,;]", raw):
        addr = part.strip()
        if not addr:
            continue
        if not EMAIL_RE.match(addr):
            raise EmailFormatError(
                f"{field} contains something that is not an email address: {addr!r}"
            )
        out.append(addr)
    return out


def parse_output(output):
    """Turn a Correspondence Agent Output into headers plus body.

    Raises EmailFormatError on anything that would not send cleanly.
    """
    text = strip_tier1_banner(output or "")
    if not text.strip():
        raise EmailFormatError("Agent Output is empty")
    if "---" not in text:
        raise EmailFormatError(
            "Agent Output has no `---` line separating headers from body"
        )
    head, _, body = text.partition("---")
    headers = {}
    for line in head.strip().splitlines():
        if not line.strip():
            continue
        key, sep, val = line.partition(":")
        if not sep:
            raise EmailFormatError(
                f"header line is not `KEY: value`: {line.strip()!r}"
            )
        headers[key.strip().upper()] = val.strip()

    unknown = set(headers) - ALLOWED_HEADERS
    if unknown:
        # BCC lands here deliberately: a recipient Kevin cannot see in the
        # approval is a recipient he did not approve.
        raise EmailFormatError(
            f"unsupported header(s): {', '.join(sorted(unknown))}. "
            "Only TO, CC, FROM and SUBJECT."
        )

    to = parse_addresses(headers.get("TO", ""), "TO")
    cc = parse_addresses(headers.get("CC", ""), "CC")
    senders = parse_addresses(headers.get("FROM", ""), "FROM")
    if len(senders) > 1:
        raise EmailFormatError("more than one FROM address")
    sender = senders[0] if senders else None
    subject = headers.get("SUBJECT", "").strip()
    body = body.strip()

    if not to:
        raise EmailFormatError("no TO recipient")
    if not subject:
        raise EmailFormatError("no SUBJECT")
    if not body:
        raise EmailFormatError("empty body")
    return {"to": to, "cc": cc, "from": sender, "subject": subject,
            "body": body}
