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
    ATTACH: /path/under/the/attachments/dir/file.pdf   (optional, exactly one)
    ---
    The body of the email, as many lines as needed.

ATTACH names ONE local file (added 25 Aug 2026 for the Creditor Management
agent's restraint-order pages). The parser checks shape only; the send path
enforces the real guards — the file must live under the attachments
directory, carry an allowed extension, exist, and fit the size cap — because
an approved output can be carried out days after it was written, and because
a path outside the allowlist is how an injected header would try to mail a
secret out.

A tier-1 banner may sit above the headers, and the mandatory "Carrying this
out will involve:" closing line may sit below the body. Both are written for
Kevin's approval box. Both are stripped here and never reach the email.

Errors raise EmailFormatError. Callers decide whether that is a sys.exit (the
send path) or a refused submit (the dispatch path). Strict on purpose: a
malformed block is a refusal, never a guess, because guessing here means
guessing a recipient.
"""

import re

EMAIL_RE = re.compile(r"^[^@\s,]+@[^@\s,]+\.[^@\s,]+$")

ALLOWED_HEADERS = {"TO", "CC", "SUBJECT", "FROM", "ATTACH"}

# Prepended by agent-dispatch.py `submit --tier1`. Defined here so the writer
# and the parser can never drift: the string that gets added is the string that
# gets stripped.
TIER1_BANNER = (
    ":rotating_light: TIER 1. This touches your private legal and financial "
    "matter. An AI agent prepared it. Nothing has been sent, filed, paid or "
    "changed anywhere. Read it before you approve."
)


# ─── THE MANDATORY CLOSING LINE ──────────────────────────────────────
#
# agent-dispatch.py REQUIRES every long Agent Output to close with this line,
# so Kevin's approval box can lead with what the agent wants to do rather than
# guessing. It is a label for KEVIN. It is not part of the email.
#
# It lives here, next to TIER1_BANNER, for exactly the same reason: on
# 18 Aug 2026 (finding 20260818-agent-dispatch-204) the line was mandated at
# submit time and then sent to the RECIPIENT, because the writer added it in
# one file and nothing stripped it in the other. The string that gets demanded
# is now the string that gets stripped.
#
# Do NOT solve this by exempting Correspondence from the closing line: the
# approval box needs the summary.
CARRY_OUT_MARKER = "**Carrying this out will involve:**"
CARRY_OUT_RE = re.compile(r"\*{0,2}carrying this out will involve:?\*{0,2}", re.I)

# What agent-dispatch.py's gate accepts as a CLOSING line: no more than this
# many characters may follow the marker. Reused here so the body-strip removes
# only what the gate would have called a closing line, and a marker quoted in
# the middle of a long email stays put as body text.
CARRY_OUT_TAIL_MAX = 400


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


def strip_carry_out_line(body):
    """Remove the trailing "Carrying this out will involve:" line from a body.

    The marker is a note to Kevin from the approval box, never something a
    council, a solicitor or a prospect should read. Only the LAST occurrence is
    removed, and only when it genuinely closes the text: if more than
    CARRY_OUT_TAIL_MAX characters follow it, the marker is mid-document and the
    text belongs to the email, so it stays. That is the same definition of
    "closing line" agent-dispatch.py's submit gate enforces.
    """
    text = body or ""
    last = None
    for m in CARRY_OUT_RE.finditer(text):
        last = m
    if last is None:
        return text.strip()
    if len(text[last.end():].strip()) > CARRY_OUT_TAIL_MAX:
        return text.strip()
    # rstrip twice around the punctuation strip so a "---" or "**" divider left
    # sitting above the marker goes with it, and .strip() at the end because
    # this call replaced the plain body.strip() the parser used to do.
    return text[:last.start()].rstrip().rstrip("*-— \t").strip()


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
    attach = headers.get("ATTACH", "").strip() or None
    if attach and ("," in attach or ";" in attach):
        # One file per email, deliberately: every extra attachment is another
        # thing Kevin approved without opening. Widen only on his say-so.
        raise EmailFormatError("ATTACH names more than one file — exactly one "
                               "attachment is supported")
    if attach and ("\n" in attach or "\r" in attach):
        raise EmailFormatError("ATTACH contains a line break")
    # The approval-box marker is stripped in the SAME place as the tier-1
    # banner: both are addressed to Kevin, neither is addressed to the
    # recipient. Stripped before the empty-body check, so an output that is
    # nothing BUT the marker is refused rather than sent as a blank email.
    body = strip_carry_out_line(body)

    if not to:
        raise EmailFormatError("no TO recipient")
    if not subject:
        raise EmailFormatError("no SUBJECT")
    if not body:
        raise EmailFormatError("empty body")
    return {"to": to, "cc": cc, "from": sender, "subject": subject,
            "body": body, "attach": attach}
