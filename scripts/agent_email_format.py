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

TO-EACH (Kevin, 25 Sep 2026, the tenant-finding chain) replaces TO for a
mail-out: the SAME approved words go to each address as a SEPARATE email, so
one card covers thirty council and charity contacts without any of them seeing
the others. BCC stays refused: every address Kevin approves is written on the
card. TO-EACH takes no CC and no ATTACH, holds at most TO_EACH_MAX addresses,
and refuses a repeated address rather than guessing which copy was meant.

    TO-EACH: housing@council.gov.uk, moveon@charity.org.uk
    FROM: info@agilelets.co.uk
    SUBJECT: Rooms for single adults aged 35+ on Universal Credit
    ---
    The body, identical for every recipient.

ATTACH names ONE local file (added 25 Aug 2026 for the Creditor Management
agent's restraint-order pages). The parser checks shape only; the send path
enforces the real guards — the file must live under the attachments
directory, carry an allowed extension, exist, and fit the size cap — because
an approved output can be carried out days after it was written, and because
a path outside the allowlist is how an injected header would try to mail a
secret out.

A tier-1 banner may sit above the headers, and the mandatory "Carrying this
out will involve:" closing line may sit below the body. Both are written for
Kevin's approval box. Both are stripped here and never reach the email. So is
the TRACK RECORD block (Kevin, 8 Sep 2026): the dated record of past dealings
with the contact that `submit` requires on every Correspondence item. Put it
ABOVE the headers, after the banner; it is for Kevin and the card, never for
the recipient, and it is stripped wherever it sits.

Errors raise EmailFormatError. Callers decide whether that is a sys.exit (the
send path) or a refused submit (the dispatch path). Strict on purpose: a
malformed block is a refusal, never a guess, because guessing here means
guessing a recipient.
"""

import html
import re
from datetime import datetime, timezone

EMAIL_RE = re.compile(r"^[^@\s,]+@[^@\s,]+\.[^@\s,]+$")

ALLOWED_HEADERS = {"TO", "TO-EACH", "CC", "SUBJECT", "FROM", "ATTACH"}
# A TEXT TO SEND WITH THE EMAIL (Cash Flow Voids cut-over build, 3 Oct 2026). Two lines above the email's
# headers, so Kevin approves the text's exact words on the same card. They are the TEXT's, never the
# email's: parse_output skips them, and scripts/send-text.py is the only reader (parse_text). One line of
# message, at most TEXT_MAX characters.
TEXT_HEADERS = {"TEXT TO", "TEXT"}
TEXT_MAX = 300
# A PAYMENT PLAN (Cash Flow Voids step 3b, Kevin approved "Build as-is" on 4 Oct 2026). One line per promise
# above the headers, beside the TEXT lines: "PLAN: 2026-10-10 £100.00", and one line naming the tenancy the
# agent read: "PLAN FOR: rec…" (a tenant's reply arrives as its own task, with no tenancy link). Kevin approves
# the dates and amounts on the card; once the email has gone, scripts/rent_plans.py checks each promise against
# the bank. Never part of the email: parse_output skips them, parse_plan is the only reader.
PLAN_HEADER = "PLAN"
PLAN_FOR_HEADER = "PLAN FOR"
PLAN_MAX = 12
PLAN_LINE_RE = re.compile(r"^PLAN: (\d{4}-\d{2}-\d{2}) £(\d{1,5}(?:\.\d{2})?)$")
PLAN_FOR_RE = re.compile(r"^PLAN FOR: (rec[A-Za-z0-9]{14})$")

# A mail-out card lists every address; past this many the card stops being
# something Kevin can read before approving, so the sender splits the list.
TO_EACH_MAX = 50
# More than this many on one visible TO line is a mail-out in disguise (validate_submission).
TO_MAX_VISIBLE = 10

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


# The header line plus ONLY the dated bullets under it. A body bullet
# ("- please pay by Friday") and the `---` separator survive (review, 8 Sep
# 2026: the first version ate both).
TRACK_RECORD_RE = re.compile(
    r"^[ \t]*TRACK RECORD:[^\n]*\n?(?:[ \t]*[-*][ \t]+(?:\d{1,2} \w{3,4} \d{4}|\d{4}-\d{2}-\d{2})[^\n]*\n?|[ \t]*\n(?=[ \t]*[-*][ \t]+(?:\d{1,2} \w{3,4} \d{4}|\d{4}-\d{2}-\d{2})))*", re.M)


def strip_track_record(text):
    """Remove every TRACK RECORD block: the header line and the dated
    bullet lines under it, wherever it sits. It is addressed to Kevin."""
    return TRACK_RECORD_RE.sub("", text or "")


# A TRACK RECORD header, also when decorated (**TRACK RECORD:**, a [stamp] before it, a quote mark).
TRACK_RECORD_LINE_RE = re.compile(r"^[ \t>*_#]*(?:\[[^\]\n]*\][ \t]*)?TRACK RECORD:", re.M)
# The report gate's own line (agent-dispatch.py CHECKED_RE / CHECK_KEYS): "CHECKED: handled=no; roy=no;
# ...", keys in any order. Written for Kevin's card, never the recipient's, wherever an agent put it.
CHECKED_LINE_RE = re.compile(r"^[ \t>*_]*CHECKED:(?=[^\n]*\bhandled[ \t]*=)[^\n]*(?:\n|$)", re.M | re.I)
SEPARATOR_LINE_RE = re.compile(r"^[ \t]*---[ \t]*$", re.M)
# What may never be left inside an email once the blocks above are out (7 Oct 2026). Every measured
# notes heading ("AGENT NOTES (not for sending)", "... NOTES (... not for sending)", "AGENT NOTE (not
# part of the email)", "(for Kevin's review only)"), a tier-1 banner, and a second separator.
# A second separator: a line of only -, * (three or more), or a marker such as ---EMAIL--- / --- NOTES ---.
# "-----Original Message-----", "---------- Forwarded message ---------" and Outlook's line of
# underscores are real email and stay (review round 2, 8 Oct 2026).
SECOND_SEPARATOR_RE = re.compile(r"^[ \t]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:=[ \t]*){3,}"
                                 r"|-{3,}[ \t]*(?!ORIGINAL MESSAGE|FORWARDED MESSAGE)[A-Z][A-Z &]*[ \t]*-{3,})[ \t]*$", re.M)
# A notes heading. No email to anyone says "not for sending" or "not part of the email", so those are
# refused wherever they sit. "For Kevin('s review) only" counts in brackets; "AGENT NOTE(S)" and
# "NOTE(S) FOR KEVIN" count at a line start followed by "(" or ":". A sign-off "(for Kevin Brittain)"
# and "Agent notes from the inspection are attached." are the email's own (review round 3, 8 Oct 2026).
KEVIN_ONLY_RE = re.compile(r"not for sending|not part of the email"
                           r"|\([^)\n]*\bfor kevin(?:'s review(?: only)?| only)\b[^)\n]*\)"
                           r"|^[ \t>*_#]*(?:AGENT NOTES?|NOTES? FOR KEVIN(?:'S REVIEW)?(?: ONLY)?)\b[^\n:(]{0,40}[:(]", re.M | re.I)
UNDERSCORE_LINE_RE = re.compile(r"^[ \t]*_{3,}[ \t]*$", re.M)
TIER1_LEFT_RE = re.compile(r"^[ \t>*_#]*(?::rotating_light:|\U0001F6A8)?[ \t*_]*TIER[ -]?1\b", re.M)   # capitals only
# The DECLARED step of Kevin's (agent-dispatch.py KEVIN_ONLY_LINE_RE). It is written for the approval
# card, and it names what only he does: a payee, an amount and a reference, a signature, a credential.
# On 3 Nov 2026 an approved message carried one after the signature: the send path strips the
# Carrying-this-out line but nothing read this, so a tenant would have received Kevin's bank steps
# (finding 20261103-agent-dispatch-1180). Capitals at a line start, like TIER1_LEFT_RE and for the same
# reason: "kevin only wanted the short version" is the email's own words, and this pattern carries no
# re.I so it cannot reach them.
KEVIN_ONLY_STEP_RE = re.compile(r"^[ \t>*_#]*\**KEVIN ONLY:", re.M)
# The DECLARED spend (agent-dispatch.py SPEND_LINE_RE). It is the money rule's own line,
# written for the approval card so the gate can read the amount; it says what WE will pay
# and is never addressed to the recipient. On 19 Oct 2026 an approved email to a letting
# agent would have ended, under Roy's signature, with "SPEND: up to £1,188 ... taken from
# the rent by Intus": the send path strips the Carrying-this-out line but nothing read this
# (finding 20261019-agent-dispatch-979).
# READ IT THE WAY THE MONEY GATE READS IT (second review, 17 Nov 2026). The first draft
# matched capitals and a tight colon only, copying KEVIN_ONLY_STEP_RE. But the gate that
# acts on this line is not case-sensitive and does not need the colon tight:
# agent-dispatch.py SPEND_AMOUNT_RE carries re.I and allows "SPEND : £80", and
# SPEND_LINE_RE carries re.I too. So "Spend: £1,188" was still a declaration to the gate
# and still went to the recipient. A refusal narrower than the gate that reads it is no
# refusal at all. The word must open the line (only quote and emphasis marks before it),
# so the email's own "We spend: nothing until you confirm" is untouched, and no amount is
# required: the real leak read "SPEND: up to £1,188 …", where no figure follows the colon.
SPEND_STEP_RE = re.compile(r"^[ \t>*_#]*\**SPEND[ \t]*:", re.M | re.I)


def clean_email_body(body):
    """The email body with what is Kevin's taken out, or EmailFormatError when that cannot be done
    without guessing.

    WHAT IS KEVIN'S NEVER GOES TO THE RECIPIENT (7 Oct 2026, finding 20261007-agent-dispatch-780).
    Only the TRACK RECORD header and its DATED bullets were stripped. Replaying every email ever sent
    found outside recipients had received internal notes (case summaries, negotiating positions,
    compliance notes, a personal detail): written under a second "---" after the signature, as an
    "AGENT NOTE (not part of the email)" paragraph, as a TRACK RECORD block under the signature with
    its undated lines, and as the report gate's CHECKED line. Two safe removals, and a refusal for the
    rest, because a guess here either leaks a note or cuts an email short:
      - the report gate's CHECKED line, wherever it sits;
      - a TRACK RECORD of dated lines only, at the very end of the body (the dated strip always took it);
      - any other TRACK RECORD in the body is refused, at the top as anywhere else: its notes cannot be
        told from the email, so it goes ABOVE the headers (8 Oct 2026: no open card had one at the top)."""
    body = CHECKED_LINE_RE.sub("", body or "")
    m = TRACK_RECORD_LINE_RE.search(body)
    if m:
        # Below the email's words, a block of dated lines with nothing after it is the shape the dated
        # strip always removed cleanly: it still goes. Anything else after it cannot be told from the
        # email, so it is refused (a cut sent a stub of what Kevin approved; review, 8 Oct 2026).
        if strip_carry_out_line(strip_track_record(body[m.start():])).strip():
            raise EmailFormatError("a TRACK RECORD sits inside the email, with more than dated lines after it: "
                                   "it is written for Kevin, so it goes ABOVE the headers")
        body = body[:m.start()]
    return body


# Who may send a text at all (review, 4 Oct 2026): only the rent lanes' own tenant cards, known by
# their name or their key line (TRIAL_TASK_MARKS below). Any other card's TEXT lines are never sent.
# RENT CAP (lane C, 5 Oct 2026): the benefit-cap email to a tenant is the lane's own tenant card too.
TEXT_CARD_MARKS = {"prefix": ("RENT LATE: ", "RENT ASK: ", "RENT PLAN: ", "RENT CAP: ", "RENT DETAILS: "), "note": "RENT CHECK KEY: "}


def parse_plan(output):
    """{"tenancy": rec…, "promises": [(date, amount)] in date order} from the PLAN FOR and PLAN lines above an
    email's headers, or None when the card carries no plan. Raises EmailFormatError on a line not in the exact
    form, a date that is not a real day, an amount of nothing or over £10,000, two promises on one day, more
    than PLAN_MAX promises, promises with no PLAN FOR line (or a PLAN FOR with no promises, or two of them),
    or a PLAN or PLAN FOR line below the headers (it would go out in the email)."""
    lines = strip_track_record(strip_tier1_banner(output or "")).splitlines()
    cut = next((i for i, line in enumerate(lines) if line.strip() == "---"), None)
    head, body = (lines[:cut], lines[cut + 1:]) if cut is not None else ([], lines)
    found, owners = [], []
    for line in head:
        key, sep, _ = line.partition(":")
        if sep and key.strip().upper() in (PLAN_HEADER, PLAN_FOR_HEADER) and not line.strip().startswith(("PLAN:", "PLAN FOR:")):
            raise EmailFormatError(f'write the plan\'s lines exactly as "PLAN FOR:" and "PLAN:", in capitals, not {key.lstrip() + ":"!r}')
        if sep and key.strip().upper() == PLAN_FOR_HEADER:
            m = PLAN_FOR_RE.match(line.strip())
            if not m:
                raise EmailFormatError(f'the plan\'s tenancy is written exactly as "PLAN FOR: rec…", the tenancy record id, not {line.strip()[:40]!r}')
            owners.append(m.group(1))
            continue
        if not sep or key.strip().upper() != PLAN_HEADER:
            continue
        m = PLAN_LINE_RE.match(line.strip())
        if not m:
            raise EmailFormatError(f'a plan line is written exactly as "PLAN: 2026-10-10 £100.00", not {line.strip()[:40]!r}')
        try:
            day = datetime.strptime(m.group(1), "%Y-%m-%d").date().isoformat()
        except ValueError:
            raise EmailFormatError(f"the plan date {m.group(1)} is not a real day")
        amount = float(m.group(2))
        if amount <= 0 or amount > 10000:
            raise EmailFormatError(f"a promise of £{m.group(2)} is not one the rent check can track")
        found.append((day, amount))
    for line in body:
        # The block's own spelling only: an email that says "Plan: £25 a month" in passing is untouched.
        if line.strip().startswith(("PLAN:", "PLAN FOR:")):
            raise EmailFormatError("a PLAN line sits below the email's headers, so it would go out in the email; "
                                   "the PLAN lines go above them")
    if not found and not owners:
        return None
    if len(owners) != 1 or not found:
        raise EmailFormatError("a plan needs one PLAN FOR line naming the tenancy and at least one PLAN line")
    if len(found) > PLAN_MAX:
        raise EmailFormatError(f"the plan has {len(found)} promises; the most is {PLAN_MAX}")
    if len({d for d, _ in found}) != len(found):
        raise EmailFormatError("the plan has two promises on one day: put them in one line")
    return {"tenancy": owners[0], "promises": sorted(found)}


def text_card(name="", notes="", output="", holders=()):
    """True for a card scripts/send-text.py may text from: a rent lane's own tenant card, by its name or
    its key line, or a reply card that carries a payment plan held by the rent lane's own agent (a tenant's
    reply has neither mark)."""
    if str(name or "").startswith(TEXT_CARD_MARKS["prefix"]) or TEXT_CARD_MARKS["note"] in str(notes or ""):
        return True
    if not any(h in TRIAL_TASK_MARKS for h in holders or ()):
        return False
    try:
        return bool(parse_plan(output))
    except EmailFormatError:
        return False


def sender_key(s):
    """One spelling for a person: an email in lower case, a UK number as +44…, anything else as typed.
    Shared by the reply routing (agent-dispatch.py) and the plan check (rent_plans.py)."""
    s = str(s or "").strip()
    m = re.search(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", s)
    if m:
        return m.group(0).lower()
    digits = re.sub(r"\D", "", s)
    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("440") and len(digits) == 13:     # +44 (0)7700 900123
        digits = "44" + digits[3:]
    if digits.startswith("44") and len(digits) == 12:
        return "+" + digits
    if digits.startswith("0") and len(digits) == 11:
        return "+44" + digits[1:]
    return s.lower()


def parse_text(output):
    """(number, message) of the TEXT TO and TEXT lines above an email's headers, or None when the card
    carries no text. Raises EmailFormatError on a half block, a second one, a message over TEXT_MAX,
    TEXT lines below the headers (they would go out in the email), or a "---" in the message (the email
    parser would cut the headers there)."""
    lines = strip_track_record(strip_tier1_banner(output or "")).splitlines()
    # The headers end at the first line that is exactly "---", so a "---" inside the TEXT line is seen.
    cut = next((i for i, line in enumerate(lines) if line.strip() == "---"), None)
    head, body = (lines[:cut], lines[cut + 1:]) if cut is not None else ([], lines)
    # The email parser ends the headers at the first "---" ANYWHERE: a header holding one would cut the
    # email there and push the lines after it, the text included, into the body (review, 4 Oct 2026).
    for line in head:
        if "---" in line:
            raise EmailFormatError(f'a header line contains "---", which would cut the email\'s headers there: {line.strip()[:60]!r}')
    found = {}
    for line in head:
        key, sep, val = line.partition(":")
        name = key.strip().upper()
        if sep and name in TEXT_HEADERS:
            # One spelling, in capitals (review, 4 Oct 2026): the check below the headers looks for exactly
            # this, so a "Text to:" accepted here could be moved into the email by an edit and not be seen.
            if not line.strip().startswith(name + ":"):
                raise EmailFormatError(f'write the text\'s lines exactly as "TEXT TO:" and "TEXT:", in capitals, '
                                       f'not {key.lstrip() + ":"!r}')
            if name in found:
                raise EmailFormatError(f"the card has more than one {name} line")
            found[name] = val.strip()
    for line in body:
        # The block's own spelling, and a "text to:" line in any case (it carries the number). An email
        # that says "Text: ..." in passing is untouched.
        key, sep, _ = line.partition(":")
        if line.strip().startswith(("TEXT TO:", "TEXT:")) or (sep and key.strip().upper() == "TEXT TO"):
            raise EmailFormatError("a TEXT line sits below the email's headers, so it would go out in the email; "
                                   "the TEXT TO and TEXT lines go above them")
    parse_plan(output)                                 # the plan lines are checked at every door the text is
    if not found:
        return None
    if not found.get("TEXT TO") or not found.get("TEXT"):
        raise EmailFormatError("a text needs both a TEXT TO line and a TEXT line")
    if len(found["TEXT"]) > TEXT_MAX:
        raise EmailFormatError(f"the TEXT is {len(found['TEXT'])} characters; the most is {TEXT_MAX}")
    return found["TEXT TO"], found["TEXT"]


def parse_output(output):
    """Turn a Correspondence Agent Output into headers plus body.

    Raises EmailFormatError on anything that would not send cleanly.
    """
    raw = strip_tier1_banner(str(output or "").replace("\r\n", "\n").replace("\r", "\n"))
    sep = SEPARATOR_LINE_RE.search(raw)
    cut = (sep.start(), sep.end()) if sep else ((raw.find("---"), raw.find("---") + 3) if "---" in raw else None)
    if cut:
        # The body is cleaned of what is Kevin's BEFORE the dated-line strip can take a TRACK RECORD
        # header and leave its other lines behind (finding 20261007-agent-dispatch-780). Found by the
        # line that is exactly "---", so a "---" inside a line above it never moves the split; with no
        # such line, at the same "---" the split below uses, so the cleaning always runs (review round 2).
        raw = raw[:cut[0]] + "---" + clean_email_body(raw[cut[1]:])
    text = strip_track_record(raw)
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
        if key.strip().upper() in TEXT_HEADERS or key.strip().upper() in (PLAN_HEADER, PLAN_FOR_HEADER):
            continue                                   # the text's and the plan's lines: never part of the email
        headers[key.strip().upper()] = val.strip()

    unknown = set(headers) - ALLOWED_HEADERS
    if unknown:
        # BCC lands here deliberately: a recipient Kevin cannot see in the
        # approval is a recipient he did not approve.
        raise EmailFormatError(
            f"unsupported header(s): {', '.join(sorted(unknown))}. "
            "Only TO, TO-EACH, CC, FROM, SUBJECT and ATTACH."
        )

    to = parse_addresses(headers.get("TO", ""), "TO")
    cc = parse_addresses(headers.get("CC", ""), "CC")
    to_each = parse_addresses(headers.get("TO-EACH", ""), "TO-EACH")
    if to_each:
        if to:
            raise EmailFormatError("TO and TO-EACH together: a mail-out uses "
                                   "TO-EACH alone")
        if cc:
            raise EmailFormatError("CC is not allowed with TO-EACH: it would copy "
                                   "every separate email to the same address")
        if headers.get("ATTACH", "").strip():
            raise EmailFormatError("ATTACH is not allowed with TO-EACH")
        if len(to_each) > TO_EACH_MAX:
            raise EmailFormatError(
                f"TO-EACH holds {len(to_each)} addresses; the most one card may "
                f"carry is {TO_EACH_MAX}")
        seen = set()
        for addr in to_each:
            if addr.lower() in seen:
                raise EmailFormatError(f"TO-EACH names {addr} twice")
            seen.add(addr.lower())
    senders = parse_addresses(headers.get("FROM", ""), "FROM")
    if len(senders) > 1:
        raise EmailFormatError("more than one FROM address")
    sender = senders[0] if senders else None
    # The inbound subject is read HTML-escaped and copied straight into the SUBJECT line, so a reply
    # to "Apartment 7 & 8 Duckworth Building" went out as "Re: Apartment 7 &amp; 8 Duckworth Building"
    # (16 Oct 2026, finding 20261016-agent-dispatch-931). A subject is plain text: unescape it here,
    # once, where every sending path passes. An entity the agent genuinely meant to type is vanishingly
    # rare in a subject line, and an escaped one reaching the recipient is not rare at all.
    subject = html.unescape(headers.get("SUBJECT", "")).strip()
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
    # WHAT IS LEFT MUST BE ONE EMAIL (7 Oct 2026, finding 20261007-agent-dispatch-780). Notes for Kevin
    # under a second separator, a notes heading or a tier-1 banner went out in sent emails. Which side
    # is the email cannot be known, so it is refused, never guessed: anything for Kevin goes ABOVE the
    # headers.
    if SECOND_SEPARATOR_RE.search(body):
        raise EmailFormatError("the email has a second separator line (---, *** or ===), so text written for "
                               "Kevin may sit inside it: write the email once, and put any notes for Kevin ABOVE the headers")
    # A line of underscores is Outlook's quote divider only when the quoted "From:" follows it; any other
    # one is a separator with notes under it (8 Oct 2026).
    for m in UNDERSCORE_LINE_RE.finditer(body):
        after = body[m.end():].lstrip("\n")
        if not re.match(r"[ \t>*]*From:", after):
            raise EmailFormatError("the email has a line of underscores with no quoted message under it, so text "
                                   "written for Kevin may sit below it: put any notes for Kevin ABOVE the headers")
    if TIER1_LEFT_RE.search(body):
        raise EmailFormatError("a tier-1 banner sits inside the email: banners and notes for Kevin go "
                               "ABOVE the headers")
    if TRACK_RECORD_LINE_RE.search(body) or CHECKED_LINE_RE.search(body):
        raise EmailFormatError("a TRACK RECORD or CHECKED line is still inside the email: it is written for Kevin, "
                               "so it goes ABOVE the headers")
    kevin_only = KEVIN_ONLY_RE.search(body.replace("\u2019", "'"))
    if kevin_only:
        raise EmailFormatError(f"the email holds a note written for Kevin ({kevin_only.group(0).strip()!r}): "
                               "notes for Kevin go ABOVE the headers, never in the email")
    if KEVIN_ONLY_STEP_RE.search(body):
        raise EmailFormatError("a KEVIN ONLY line sits inside the email: it names the step only Kevin does "
                               "(a payee, an amount and a reference, a signature, a credential) and the recipient "
                               "must never read it. Put it with the closing line, under "
                               "'Carrying this out will involve:', which the send path takes off")
    if SPEND_STEP_RE.search(body):
        raise EmailFormatError("a SPEND line sits inside the email: it declares our money for the approval "
                               "card and the recipient must never read it. Put it with the closing line, "
                               "under 'Carrying this out will involve:', which the send path takes off "
                               "(above the headers it is refused as an unknown header)")

    if not to and not to_each:
        raise EmailFormatError("no TO recipient")
    if not subject:
        raise EmailFormatError("no SUBJECT")
    if not body:
        raise EmailFormatError("empty body")
    return {"to": to, "cc": cc, "from": sender, "subject": subject,
            "body": body, "attach": attach, "toEach": to_each}


# ─── SENDER IDENTITY AND SIGN-OFF: THE TWO MISSING DEFAULTS ──────────
#
# Measured 27 Aug 2026 across every approval decision Kevin had ever made:
# 22 were "Approved with minor edits", and 14 of those 22 (64%) were him
# correcting one of two things by hand, one task at a time.
#
#   11x  "Send from kevinbrittain@gmail.com"
#    3x  "Just sign my name, no address or contact details"
#
# Neither rule was written down anywhere. FROM was optional in the format
# above, and nothing said anything at all about a sign-off, so every agent
# guessed and Kevin corrected the guess at roughly two minutes a go. That is
# not an accuracy problem and no amount of agent improvement would have fixed
# it: it is a default nobody had ever stated.
#
# So it is stated here, once, and enforced at SUBMIT rather than requested in
# prose. A rule in prose is the rule that gets skipped — the same lesson as
# the learning loop, which produced zero stored lessons in the three days it
# was a paragraph in a skill file.
#
# WHY SUBMIT AND NOT SEND. parse_output() above stays permissive on purpose.
# It runs on the send path too, days after Kevin approved, and an approved
# action that cannot be carried out is worse than a refused one — the whole
# reason this module exists. So the strict layer is a SEPARATE function that
# only the submit gate calls: a bad draft is refused before Kevin ever reads
# it, and work he already approved still goes out.

PERSONAL_SENDER = "kevinbrittain@gmail.com"
BUSINESS_SENDER = "kevin@operationsdirector.co.uk"
RUNPRENEUR_SENDER = "kevin@runpreneur.org.uk"
# Kevin's ruling, 3 Sep 2026: all property maintenance and compliance
# correspondence (gas certificates, EICRs, HMO licences, repairs) goes from
# info@agilelets.co.uk, which is a Send As alias within his Gmail account.
PROPERTY_SENDER = "info@agilelets.co.uk"


# ─── RULE SENDS: the only emails that go out with no card (Kevin, 17 Sep 2026) ──
#
# Kevin's tranche 3 rulings made two email shapes card-free: a redirect reply
# telling property senders to use info@agilelets.co.uk, and a quote request to
# tradespeople for a statutory certificate. An agent sending without Kevin's tap
# is the one thing the send gate existed to stop, so the exception is exactly
# these two shapes, checked by ONE function that submit (to decide Level A) and
# send-email.py (to re-check at send time, from the stored task) both call.
# A sent email cannot be reversed in 24 hours like other Level A actions; that
# is the named exception recorded in GUARDRAILS.md and Decisions/ on 17 Sep 2026.
# Those two are an AGENT's emails. One rules-only robot also emails outside the
# business with no card, and no model writes a word of it: the rent check sends
# a new tenant their signed proof of residency, with a copy to Roy (Kevin, 28 Sep
# and 8 Oct 2026; scripts/rent_proof_of_residency.py, fixed body, recipients only
# from Adobe's own emails).
RULE_STAMP = "AUTO-SEND BY RULE"
# Kept identical to COVERAGE_MARK in agent-dispatch.py (tests/level-a-rule-sends.test.js).
RULE_COVERAGE_MARK = "COVERAGE CHECKED"
# Written in code, never by a model: nothing new is said to anyone.
REDIRECT_BODY = ("Thank you for your email.\n\n"
                 "Please send anything about the property, repairs, compliance or the "
                 "tenancy to info@agilelets.co.uk, where the team will pick it up.\n\n"
                 "Kind regards,\nKevin Brittain")
RULE_OWN_ADDRESSES = {PERSONAL_SENDER, PROPERTY_SENDER, "kevin@runpreneur.org.uk",
                      "kevin@operationsdirector.co.uk", "roy.lavin1978@gmail.com"}
RULE_NO_COMMIT_RE = re.compile(
    r"\b(we accept|agree to pay|go ahead|please book|confirm (?:the )?booking|"
    r"deposit|bank details|pay (?:you|the invoice))\b", re.I)
RULE_ADDR_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")

# ─── ONE COMPANY, ONE EMAIL (Kevin, 16 Nov 2026, decision card recinoFWz6fQ6JVVB, ruling 6) ───
#
# "Two separate emails, one per company, otherwise it can be unprofessional" (his note of 29 Oct 2026).
# A company is known by its email domain. A free-mail address (a sole trader on gmail.com) is its own
# company, because two plumbers on gmail.com are two firms; a text gateway address is one phone.
FREE_MAIL_DOMAINS = frozenset((
    "gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "outlook.com", "outlook.co.uk", "live.com",
    "live.co.uk", "msn.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "icloud.com", "me.com", "mac.com",
    "aol.com", "aol.co.uk", "btinternet.com", "btopenworld.com", "sky.com", "virginmedia.com", "ntlworld.com",
    "blueyonder.co.uk", "talktalk.net", "tiscali.co.uk", "protonmail.com", "proton.me", "mail.com", "gmx.com",
    "gmx.co.uk", "zoho.com", "btconnect.com", "virgin.net", "talk21.com", "lineone.net", "freeserve.co.uk",
    "o2.co.uk", "plus.net", "plusnet.com", "orange.net", "fsmail.net", "rocketmail.com", "hotmail.fr", "live.ie"))
# ClickSend email-to-text (Kevin, 5 Oct 2026): an address here is a text to one phone, never an email.
TEXT_GATEWAY_DOMAINS = frozenset(("sms.clicksend.com",))
# A second-level label that is part of the suffix: office@mail.fixture.co.uk and jobs@fixture.co.uk are one firm.
SUFFIX_LABELS = frozenset(("co", "org", "gov", "ac", "ltd", "plc", "me", "net", "nhs", "police", "sch", "com"))


def address_domain(addr):
    return str(addr or "").strip().lower().rpartition("@")[2]


def organisation_domain(dom):
    """The domain a firm registered, with any subdomain taken off (mail.fixture.co.uk -> fixture.co.uk)."""
    labels = [x for x in str(dom or "").lower().split(".") if x]
    if len(labels) >= 3 and labels[-2] in SUFFIX_LABELS and len(labels[-1]) == 2:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def company_key(addr):
    """Which company an address belongs to: its organisation's domain, or the whole address on a free-mail domain
    or a text gateway, where one domain is many people."""
    a = str(addr or "").strip().lower()
    dom = address_domain(a)
    return a if (dom in FREE_MAIL_DOMAINS or dom in TEXT_GATEWAY_DOMAINS) else organisation_domain(dom)


def rule_send_problem(rule, mail, task, require_stamp=True):
    """Why this email may NOT go out under `rule` with no card, or "" when it may.

    `mail` is a parse_output() dict; `task` carries name, notes, inboundSender
    and taskType. Every failing condition keeps the email on a card.
    """
    notes = str(task.get("notes") or "")
    if require_stamp and f"{RULE_STAMP}: {rule}" not in notes:
        return "the task carries no rule stamp from submit"
    if str(task.get("taskType") or "Correspondence") != "Correspondence":
        return "only a Correspondence task is sent by rule"
    if mail.get("attach"):
        return "an attachment is never sent by rule"
    if mail.get("toEach"):
        return "a TO-EACH mail-out is never sent by rule"
    if mail.get("cc"):
        return "CC is never sent by rule"
    to = [a.strip().lower() for a in (mail.get("to") or [])]
    sender = (mail.get("from") or "").strip().lower()
    body = mail.get("body") or ""
    if rule == "redirect":
        inbound = RULE_ADDR_RE.search(str(task.get("inboundSender") or ""))
        if not inbound:
            return "the task has no inbound sender address"
        if to != [inbound.group(0).lower()]:
            return "a redirect goes only to the task's own inbound sender"
        if to[0] in RULE_OWN_ADDRESSES:
            return "one of our own addresses is never redirected"
        if sender != PERSONAL_SENDER:
            return "a redirect goes from kevinbrittain@gmail.com"
        if body.strip() != REDIRECT_BODY:
            return "the redirect body is not the fixed text"
        return ""
    if rule == "quote-request":
        if not str(task.get("name") or "").startswith("COMPLIANCE:"):
            return "a quote request belongs to a COMPLIANCE task"
        if sender != PROPERTY_SENDER:
            return "a quote request goes from info@agilelets.co.uk"
        if "roy lavin" not in body.lower():
            return "a quote request is signed Roy Lavin"
        if "quote" not in (mail.get("subject") or "").lower():
            return "the subject does not say quote"
        if not 1 <= len(to) <= 3:
            return "a quote request goes to one company, at most three of its addresses"
        if any(a in RULE_OWN_ADDRESSES for a in to):
            return "one of our own addresses is a recipient"
        # Kevin, 16 Nov 2026 (decision card recinoFWz6fQ6JVVB, ruling 6): one company per email, never two
        # firms on one. Several companies are several separate emails.
        if len({company_key(a) for a in to}) > 1:
            return "a quote request goes to one company per email, never two firms on one (Kevin, 16 Nov 2026)"
        if RULE_COVERAGE_MARK not in notes:
            return "the coverage check has not passed on this task"
        if re.search(r"^\s*SPEND:", body, re.M):
            return "a quote request commits no money"
        hit = RULE_NO_COMMIT_RE.search(body)
        if hit:
            return "a quote request commits to nothing (%r)" % hit.group(0)
        return ""
    return "unknown rule %r" % rule

# ─── TRIAL AGENTS: Kevin checks the drafts, nothing reaches anyone (2 Oct 2026) ──
#
# GUARDRAILS has said since 25 Aug 2026 that a new agent replacing a live process
# runs in parallel first, "with the new outputs going to a validation queue, never
# to the real recipient". Until now that was words: an approved card from any
# dispatchable agent was sent. An agent listed here raises cards exactly like the
# others, Kevin's verdict and notes teach it exactly like the others, and NOTHING
# it raises can be sent: send-email.py refuses at the one door every send passes
# through, and the dispatch queue closes an approved card as checked instead of
# handing it to a carry-out run. Ending a trial is MOVING the entry to TRIAL_ENDED
# below, in a PR Kevin approves: the cut-over is a decision, never a side effect.
TRIAL_AGENTS = {
    # Empty: no agent is on trial. The Cash Flow Voids agent's trial ended on 5 Oct 2026 (TRIAL_ENDED below).
}
TRIAL_STAMP = "TRIAL CHECKED"
# THE TASK IS ON TRIAL TOO, WHOEVER HOLDS IT (independent review, 2 Oct 2026). A trial lane's task
# that is re-routed, reassigned or resubmitted under another agent's id would otherwise become an
# ordinary card that sends on approval. So a task carrying the lane's own marks stays on trial for
# as long as its agent is listed above. KEEP THE ENTRY AFTER THE CUT-OVER: TRIAL_ENDED reads these
# marks to hold back a card approved during the trial (review, 4 Oct 2026). Either mark is enough: a name can be edited and a Notes
# line can be lost. Kept identical to TASK_PREFIX and KEY_MARK in scripts/rent-check.py, and to
# ASK_PREFIX in scripts/rent_new_tenant.py (lane B's tenant drafts carry the same key mark)
# (tests/cash-flow-voids-agent.test.js, tests/rent-new-tenant.test.js).
TRIAL_TASK_MARKS = {
    # RENT PLAN (4 Oct 2026): a payment plan card is the lane's own tenant card too. So is RENT CAP
    # (lane C, 5 Oct 2026): the email asking a capped tenant for his details (scripts/rent_cap.py). So is RENT DETAILS
    # (5 Oct 2026): a reminder to fill in the details form (scripts/rent_form_chase.py). Never "RENT FORM: ":
    # that prefix is the robot's direct rent payment form card (ROBOT FORM CARD below), which opens its window.
    "rec7aHLK1Q8fMLRXH": {"prefix": ("RENT LATE: ", "RENT ASK: ", "RENT PLAN: ", "RENT CAP: ", "RENT DETAILS: "), "note": "RENT CHECK KEY: "},
}
# A ROBOT FORM CARD (Cash Flow Voids lane B, 3 Oct 2026; Kevin's ruling "Robot fills, you pick
# reason"). The rent check raises the direct rent payment form card. Approving it opens ONE door:
# the robot's window (agent-browser.js `handover`, through agent-dispatch.py `outcome`), where the
# robot fills the form and Kevin checks every answer and sends it himself. Every other door stays
# shut for it, on trial or not: `outcome` never reads it as approved, so the robot's `commit`
# (which presses submit) refuses it, and the queue never hands it to an agent, whatever its
# outcome; the rent check works it in code. That holds after the trial ends too: this list is
# separate from TRIAL_AGENTS on purpose (independent review, 3 Oct 2026).
# EITHER mark makes a task a form card, so a renamed card or a lost Notes line still keeps the
# doors shut. The window opens only with BOTH marks and the lane's own agent holding the card.
# Kept identical to FORM_PREFIX and FORM_KEY_MARK in scripts/rent_new_tenant.py.
FORM_CARDS = {
    "rec7aHLK1Q8fMLRXH": {"prefix": "RENT FORM: ", "note": "RENT FORM KEY: "},
}


# A CARD KEVIN WORKS HIMSELF (Cash Flow Voids lane C, 5 Oct 2026; Kevin's ruling on 4 Oct 2026 "Yes, runs
# for real"). The rent check raises the council housing payment claim card (RENT CLAIM) and the card asking
# for the council's answer (RENT CLAIM DECISION). Kevin fills in the council's form himself and records its
# answer. Every door is shut for them exactly as for a robot form card: never an agent's work, never sent,
# never settled as a trial check, never a lesson, never scored as a draft. But no robot window ever opens
# for them: form_card() with `holders` never names one. "RENT CLAIM" covers both names. Kept identical to
# CLAIM_PREFIX and CLAIM_KEY_MARK in scripts/rent_cap.py, KEVIN_CARD_MARKS in scripts/task-manager.py and
# js/agent-accuracy.js (tests/rent-cap.test.js).
KEVIN_CARDS = {
    "rec7aHLK1Q8fMLRXH": {"prefix": "RENT CLAIM", "note": "RENT CLAIM KEY: "},
}


def form_card(name="", notes="", holders=None):
    """True for a robot form card, or a card Kevin works himself (KEVIN_CARDS): every door but the
    window is shut for both. With `holders` (the task's agent ids), only a robot form card carrying
    BOTH marks and held by the lane's own agent: the test for opening the robot's window."""
    if holders is None and any(str(name or "").startswith(m["prefix"]) or m["note"] in str(notes or "")
                               for m in KEVIN_CARDS.values()):
        return True
    for agent_id, marks in FORM_CARDS.items():
        has = (str(name or "").startswith(marks["prefix"]), marks["note"] in str(notes or ""))
        if holders is None and any(has):
            return True
        if holders is not None and all(has) and agent_id in holders:
            return True
    return False


# The output shapes that act without send-email.py: Roy's handover email, the diary, the Friday
# payment list, signing and the post. The lead-in is what scripts/payment-run.py also accepts, so
# a bold, quoted, bulleted or numbered heading cannot slip through.
TRIAL_ACTING_SHAPE_RE = re.compile(
    r"^[ \t>*_#\-•]*(?:\d+[.)][ \t]*)?[*_]*"
    r"(PASS TO ROY:|CALENDAR:|MARK FOR PAYMENT|DOCUMENT:|POST:|SIGNERS:|SIGN\s+AS\s+KEVIN\s*:)", re.I | re.M)


def strip_trial_marks(text):
    """`text` without any line that carries a trial lane's key mark. A trial task's words are
    sometimes copied onto ANOTHER task's Notes (a duplicate folded into its keeper): the copy must
    not turn the keeper into a trial task, or its own approved reply would never be sent."""
    marks = [m["note"] for m in TRIAL_TASK_MARKS.values()]
    return "\n".join(line for line in str(text or "").splitlines() if not any(m in line for m in marks))


# A TRIAL THAT HAS ENDED (independent review, 4 Oct 2026). Ending a trial is moving the agent's entry
# from TRIAL_AGENTS to here, with the moment it ended in UTC, e.g. "2026-11-24T09:00:00Z". Deleting the
# entry alone would turn every card Kevin approved during the trial, but the half-hourly settle had not
# yet closed, into an email and a text the moment the PR merged. A card approved before the end was a
# check, not a send, and stays one: the queue holds it back, `trial-settle` closes it as checked, and
# the send doors refuse it. A card approved after the end is an ordinary card. A trial lane's marks
# left in neither list fail tests/cash-flow-voids-agent.test.js, so the move cannot be half done.
# The diary and the post pass no approval time on purpose: a trial card can never carry those shapes
# (TRIAL_ACTING_SHAPE_RE refuses them at submit), and a Level A diary entry has no approval to date.
TRIAL_ENDED = {
    # Cash Flow Voids (register row reclaAzGLA4utssxx). Kevin, 5 Oct 2026: "Let's take it off trial ... As long as
    # the guardrails are in place with the approval cards, I can check things as we go." Every card still waits for
    # his approval; a card he approved before this moment was a check and is never sent.
    "rec7aHLK1Q8fMLRXH": "2026-10-05T11:44:00Z",
}


def _utc(value):
    """An Airtable time as an aware UTC datetime, or None when blank or unreadable."""
    try:
        t = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def trial_problem(agent_ids, name="", notes="", approved_at=None):
    """Why this task may NOT be carried out, or "": it was raised by a trial agent, or it is a
    trial lane's own task whoever holds it now. A caller acting on an approval passes the task's
    Approved At: a card of an ENDED trial approved before the end, or with no readable approval
    time, is still a trial card."""
    def marked(marks):
        return str(name or "").startswith(marks["prefix"]) or marks["note"] in str(notes or "")
    for agent_id in agent_ids or []:
        if agent_id in TRIAL_AGENTS:
            return TRIAL_AGENTS[agent_id]
    for agent_id, marks in TRIAL_TASK_MARKS.items():
        if agent_id in TRIAL_AGENTS and marked(marks):
            return TRIAL_AGENTS[agent_id]
    if approved_at is None:
        return ""
    ended = [a for a in agent_ids or [] if a in TRIAL_ENDED]
    ended += [a for a, marks in TRIAL_TASK_MARKS.items() if a in TRIAL_ENDED and marked(marks)]
    when = _utc(approved_at)
    for agent_id in ended:
        end = _utc(TRIAL_ENDED[agent_id])
        if when is None or end is None:
            return (f"it carries no readable approval time, so it cannot be shown to have been approved after the "
                    f"trial run ended ({TRIAL_ENDED[agent_id]})")
        if when < end:
            return (f"it was approved during the trial run, which ended {TRIAL_ENDED[agent_id]}, so Kevin's "
                    "verdict was a check and nothing it raised then is sent")
    return ""


# THE TENANCY SHOWS EVERY ACTION (Kevin, 5 Oct 2026, on the Connaught Road card: "ensure the tenancy record is
# updated with all the actions"). A rent lane's tenant card that was sent leaves one dated comment on each tenancy
# it names, written by the send door itself (scripts/send-email.py, scripts/send-text.py), never left to an agent
# to remember. The send has already happened when the comment is written, so a failure is said, never undone.
TASK_TENANCIES = "fldmne4RYJU22ICub"      # Tasks: Tenancies link (scripts/rent-check.py TK["tenancies"])
TENANCIES_TABLE = "tblN51a88qTDB6iMH"


def tenancies_to_note(name="", notes="", holders=(), linked=None, output=""):
    """The tenancy ids a sent card's comment goes on: None when the card is not a rent lane's tenant card (by its
    lane marks, which outlive a trial, or held by a rent lane agent); else the tenancies it links, or the one its
    PLAN FOR line names when it links none; [] when it names no tenancy at all."""
    lane = any(agent_id in (holders or ()) or str(name or "").startswith(marks["prefix"])
               or marks["note"] in str(notes or "") for agent_id, marks in TRIAL_TASK_MARKS.items())
    if not lane:
        return None
    ids = [t for t in (linked or []) if re.fullmatch(r"rec[A-Za-z0-9]{14}", str(t))]
    if ids:
        return ids
    try:
        plan = parse_plan(output)
    except EmailFormatError:
        plan = None
    return [plan["tenancy"]] if plan else []


def tenancy_comment(when, what, task_id):
    """The one comment a send leaves on a tenancy."""
    return f"{when}: Agile Lets {what} (rent task {task_id})."


# Kevin's ruling, 27 Aug 2026, in his own words on task recV3nCmp3ivQeXTN:
# "Send from kevinbrittain@gmail.com. Never send from kevin@runpreneur.org.uk
# unless it's to do with Runpreneur. Revert to sending from
# kevinbrittain@gmail.com as standard."
ALLOWED_SENDERS = (PERSONAL_SENDER, BUSINESS_SENDER, RUNPRENEUR_SENDER, PROPERTY_SENDER)

BUSINESS_BRAND_RE = re.compile(
    r"operationsdirector\.co\.uk|\bOperations Director\b", re.I)
RUNPRENEUR_BRAND_RE = re.compile(r"\bRunpreneur\b|runpreneur\.org", re.I)

# Sign-off phrases, longest first so "Many thanks" wins over "thanks".
SIGNOFF_RE = re.compile(
    r"^\s*(yours sincerely|yours faithfully|kind regards|best wishes|"
    r"many thanks|best regards|with thanks|regards|sincerely|thanks)\b[,.]?\s*$",
    re.I | re.M)

# What may never appear BELOW the sign-off. Each is a contact detail Kevin has
# asked three separate times to have removed, and each is unambiguous in a
# closing block: a postcode in the body is a property reference, a postcode in
# the signature is his home address.
UK_PHONE_RE = re.compile(r"(?:\+44|\b0)\s?\d[\d\s().-]{7,}\d")
UK_POSTCODE_RE = re.compile(
    r"\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b", re.I)
ANY_EMAIL_RE = re.compile(r"[^@\s,<>]+@[^@\s,<>]+\.[^@\s,<>]+")
# A closing block runs to the end of the body, but cap the search so a quoted
# email thread pasted under the signature is not read as Kevin's own contact
# block. Six non-empty lines is a generous signature and a short quote.
SIGNOFF_TAIL_LINES = 6


def closing_block(body):
    """The lines a reader would call the signature, or [] if there is none.

    Everything AFTER the last sign-off phrase. Falls back to the last few
    non-empty lines when the draft has no recognisable sign-off, because a
    contact block pasted with no "Kind regards" above it is still a contact
    block.
    """
    text = body or ""
    last = None
    for m in SIGNOFF_RE.finditer(text):
        last = m
    tail = text[last.end():] if last else text
    lines = [ln.strip() for ln in tail.splitlines() if ln.strip()]
    if last is None:
        lines = lines[-SIGNOFF_TAIL_LINES:]
    return lines[:SIGNOFF_TAIL_LINES]


def signoff_problem(body):
    """Reason string when the sign-off carries contact details, else ""."""
    for line in closing_block(body):
        if UK_PHONE_RE.search(line):
            return ("the sign-off carries a phone number (%r). Kevin signs "
                    "with his name only." % line)
        if UK_POSTCODE_RE.search(line):
            return ("the sign-off carries an address (%r). Kevin signs with "
                    "his name only." % line)
        if ANY_EMAIL_RE.search(line):
            return ("the sign-off carries an email address (%r). Kevin signs "
                    "with his name only." % line)
    return ""


# ─── WHAT KEVIN HAS RULED OUT OF ANYTHING SENT (16 Nov 2026) ─────────
#
# Four lessons that agents kept breaking, moved from prose into refusals (the 13 Nov 2026 estate
# review: a rule code can enforce is a refusal in code, never a line in a prompt):
#   - no placeholders (creditor-management lessons of 27 and 28 Aug 2026: "No placeholders, ever.
#     Find the reference number, address and amount before the card reaches Kevin." A letter of
#     authority went to his queue carrying "[Kevin's home address - confirm before approving]");
#   - no em dash (4 Sep 2026: "Take out the em dash"; his house style bans it everywhere);
#   - mail signed Roy Lavin is written AS Roy (22 Oct 2026: "the email is signed off by Roy, so you
#     can't write it as if Roy is in the third person");
#   - a tenant mail-out never shows its recipients each other (30 Sep 2026: "It's critical that these
#     emails are put in the BCC section so that they can't see each other's email addresses").
# Submit only, like the rest of validate_submission: an email Kevin already approved still goes out.
#
# Each reads only the SENDER'S OWN WORDS: the body above the first quoted message. A reply that
# quotes the other side's email carries their dashes, brackets and names, which are theirs to write.
QUOTED_START_RE = re.compile(
    r"^[ \t]*(?:On .{3,200}wrote:[ \t]*$|-{2,}[ \t]*(?:Original|Forwarded) [Mm]essage|From: .+|>|_{3,}[ \t]*$)",
    re.M)
# A "From:" line starts a quoted message only when it reads like a mail header: it carries an address
# ("From: Sam <sam@example.com>") or the header block goes on below it ("Sent:", "Date:", "To:",
# "Subject:", "Cc:"). A details line such as "From: 1 December 2026" is the sender's own words, and so is
# a ">" that is a comparison ("> 50 rooms", "> £500"). Read as a quote, either cut the body early and
# everything below it went unread (review of PR 951, F6).
QUOTED_HEADER_NEXT_RE = re.compile(r"^[ \t>*]*(?:Sent|Date|To|Subject|Cc):", re.I)


def _is_quote_start(text, m):
    line = m.group(0).strip()
    if line.startswith("From:"):
        if "@" in line or "<" in line:
            return True
        after = [ln for ln in text[m.end():].splitlines() if ln.strip()]
        return bool(after) and bool(QUOTED_HEADER_NEXT_RE.match(after[0]))
    if line.startswith(">"):
        rest = text[m.end():m.end() + 40].split("\n", 1)[0]
        return not re.match(r"[ \t]*[\d£$=]", rest)
    return True


def own_words(body):
    """The body above the first quoted message (a "On ... wrote:" line, an Original or Forwarded
    message marker, a quoted "From:" header, a "> " quoted line or Outlook's line of underscores)."""
    text = body or ""
    for m in QUOTED_START_RE.finditer(text):
        if _is_quote_start(text, m):
            return text[:m.start()]
    return text


# A square-bracket token that is not a link's text ("[the form](https://...)"), or an angle-bracket
# token that is not an email address or a web link ("<name@example.com>", "<https://...>"). A real
# email has no use for either: every one measured is a value the agent never found, or a note for
# Kevin ("[ EMAIL TO THE COUNCIL - this is what will be sent ]") sitting inside what is sent.
PLACEHOLDER_SQUARE_RE = re.compile(r"\[[^\[\]\n]*[A-Za-z£$][^\[\]\n]*\](?!\()")
# Angle brackets hugging their words, as a template's are ("<home address>"): "< 100 and > 50" is a sum.
PLACEHOLDER_ANGLE_RE = re.compile(r"<(?![^<>\n]*(?:@|://|mailto:|www\.))(?=\S)[^<>\n]*[A-Za-z][^<>\n]*(?<=\S)>")
# Capitals only, whole words: "XXX" and longer, "TBC", "TBA", "INSERT". "Xxx" in a name, "tbc" in a
# web address and "insert" in a sentence ("insert the key") are the email's own words. A masked card
# number ("XXXX-1234", "XXXX 1234") is a number already found, not a gap.
PLACEHOLDER_MARK_RE = re.compile(r"(?<![A-Za-z0-9])(?:X{3,}(?![ \t-]?\d)|TBC|TBA|INSERT)(?![A-Za-z0-9])")
# Three more template shapes the review found passing (F5): "{amount}", "(insert address)", "£X".
PLACEHOLDER_CURLY_RE = re.compile(r"\{\{?[ \t]*[A-Za-z_][^{}\n]{0,60}\}\}?")
PLACEHOLDER_INSERT_RE = re.compile(r"\((?:insert|INSERT|Insert)\b[^()\n]{0,80}\)")
PLACEHOLDER_POUND_RE = re.compile(r"£[ \t]?[Xx]+(?:[.,][Xx]+)?(?![A-Za-z0-9])")
# What a square bracket holds that is not a gap: "[sic]" (the writer's own quotation mark), one word
# carrying a digit (a reference already found: "[AB-123456]", "[HMO/2026/0042]") and a link or address
# Outlook writes in brackets ("[mailto:sam@example.com]", "[https://...]").
SQUARE_NOT_A_GAP_RE = re.compile(r"\[(?:sic|SIC|Sic)\]|\[[^\s\[\]]*\d[^\s\[\]]*\]|\[[^\[\]\n]*(?:@|://|mailto:)[^\[\]\n]*\]")
URL_RE = re.compile(r"(?:https?://|www\.)\S+", re.I)
BARE_DOMAIN_ANGLE_RE = re.compile(r"<[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:/\S*)?>")
EM_DASH = "—"
# The same dash written another way: the HTML entity copied from a web page, its number, and the
# horizontal bar (U+2015), which reads as an em dash to everyone who receives it.
EM_DASH_LIKE_RE = re.compile("—|―|&mdash;|&#8212;|&#x2014;", re.I)
REPLY_SUBJECT_RE = re.compile(r"^\s*(?:re|fwd?)\s*:", re.I)

# Each placeholder shape with the way through its refusal names (every refusal names one: a check
# that refuses correct work with no way past is worse than the gap it closes).
_PLACEHOLDER_SHAPES = (
    (PLACEHOLDER_SQUARE_RE, "if it is real text, write it without square brackets, or as a link: [text](https://...)"),
    (PLACEHOLDER_ANGLE_RE, "if it is real text, write it without angle brackets"),
    (PLACEHOLDER_MARK_RE, "if the date or detail really is still to be agreed, say so in words (\"to be confirmed by "
                          "the council\"); a masked card number is written **** 1234"),
    (PLACEHOLDER_CURLY_RE, "if it is real text, write it without curly brackets"),
    (PLACEHOLDER_INSERT_RE, "write the value itself in place of the bracket"),
    (PLACEHOLDER_POUND_RE, "write the amount in figures"),
)


def _not_a_gap(text, m):
    """True when a placeholder-shaped match is the email's own text, never a gap."""
    s, e = m.span()
    if any(u.start() <= s < u.end() for u in URL_RE.finditer(text)):
        return True                                    # "?filter[status]=open" inside a web link
    token = m.group(0)
    if token.startswith("[") and SQUARE_NOT_A_GAP_RE.fullmatch(token):
        return True
    if token.startswith("<") and BARE_DOMAIN_ANGLE_RE.fullmatch(token):
        return True                                    # "<agilelets.co.uk>"
    return False


def placeholder_problem(text, where="the email"):
    """Why `text` still carries a placeholder, or ""."""
    text = text or ""
    for rx, way in _PLACEHOLDER_SHAPES:
        for m in rx.finditer(text):
            if _not_a_gap(text, m):
                continue
            return ("%s still carries a placeholder (%r). Kevin's ruling, 27 Aug 2026: no placeholders, "
                    "ever. If it is a value you have not found, find it (the reference number, address or "
                    "amount) before the card reaches him, or say plainly in the card above the headers what "
                    "could not be found; %s." % (where, m.group(0)[:80], way))
    return ""


def em_dash_problem(text, where="the email"):
    """Why `text` carries an em dash, or ""."""
    m = EM_DASH_LIKE_RE.search(text or "")
    if not m:
        return ""
    i = m.start()
    near = " ".join(text[max(0, i - 30):i + 30].split())
    return ("%s carries an em dash (near %r). Kevin's house style bans the em dash in anything that "
            "goes out (4 Sep 2026): use a comma, a full stop or a hyphen." % (where, near))


ROY_SIGNATURE_RE = re.compile(r"^Roy Lavin\b")
# Signed with his first name alone (review of PR 951, F4): "Roy" on its own line, or "Thanks, Roy".
ROY_SHORT_SIGNATURE_RE = re.compile(
    r"^(?:(?:yours sincerely|yours faithfully|kind regards|best wishes|many thanks|best regards|with thanks|"
    r"regards|thanks|thank you|cheers|best)[,.]?[ \t]+)?Roy[.,!]?$", re.I)
# The name of someone else, or a street: "Roy Example" (a surname that is not Lavin), "12 Roy Road".
ROY_NAMED_RE = re.compile(
    r"\bRoy\b(?!['’]?s?[ \t]+(?:Road|Street|Avenue|Close|Lane|Drive|Way|Court|Place|Terrace|Crescent|Gardens|Grove)\b)"
    r"(?![ \t]+(?!Lavin\b)[A-Z][a-z]+(?:[ \t]|[,.;:)]|$))")
# Roy saying who he is, in the first person, is not Roy in the third person ("Hi Anthony, Roy here.").
ROY_SELF_RE = re.compile(r"\b(?:Roy(?: Lavin)? here|this is Roy(?: Lavin)?|I am Roy(?: Lavin)?|I'm Roy(?: Lavin)?"
                         r"|my name is Roy(?: Lavin)?)\b", re.I)
# A details line ("- Managing agent: Roy Lavin, Agile Lets, c/o ...") states a fact a council or insurer asked
# for; it does not speak of Roy in the third person. Found in the back-test, in a reply to a council officer.
# Only the NAME is set aside, and only in such a line's value: "Note: Roy will meet you" and "Roy will call
# you to confirm: please..." still speak of him (review of PR 951, F4).
ROY_FIELD_LINE_RE = re.compile(
    r"^([ \t]*(?:[-*•][ \t]*)?[A-Za-z][A-Za-z'&/()-]*(?:[ \t]+[A-Za-z][A-Za-z'&/()-]*){0,4}[ \t]*:[ \t]+)([^\n]*)$", re.M)
ROY_AS_VALUE_RE = re.compile(r"\bRoy(?: Lavin)?(?=[ \t]*(?:$|[,;()/-]|\b(?:on|at|via|of|and|or|for)\b))")
# Words in quotation marks are someone else's ('You wrote that "Roy said Monday works"').
QUOTED_WORDS_RE = re.compile(r"\"[^\"\n]{1,200}\"|“[^”\n]{1,200}”")


def _roy_names_out_of_details(text):
    def one(m):
        key, value = m.group(1), m.group(2)
        if "roy" in key.lower():
            return m.group(0)
        return key + ROY_AS_VALUE_RE.sub("", value)
    return ROY_FIELD_LINE_RE.sub(one, text)


def roy_third_person_problem(body):
    """Why a body signed by Roy names Roy above its sign-off, or ""."""
    words = own_words(body)
    lines = words.splitlines()
    tail = closing_block(words)
    sig, signed = None, ""
    for i in range(len(lines) - 1, -1, -1):
        line = lines[i].strip()
        if ROY_SIGNATURE_RE.match(line):
            sig, signed = i, "Roy Lavin"
            break
        if ROY_SHORT_SIGNATURE_RE.match(line) and line in tail:
            sig, signed = i, "Roy"
            break
    if sig is None or (signed == "Roy Lavin" and not any(ROY_SIGNATURE_RE.match(ln) for ln in tail)):
        return ""
    above = "\n".join(lines[:sig])
    last = None
    for m in SIGNOFF_RE.finditer(above):
        last = m
    if last is not None:
        above = above[:last.start()]
    # The quote is cut from the SAME text the match was found in: cut from the text before the details
    # lines came out, a details line above the sentence shifted it onto words with no Roy in them
    # (review of PR 951, 16 Nov 2026).
    read = QUOTED_WORDS_RE.sub(" ", ROY_SELF_RE.sub(" ", _roy_names_out_of_details(above.replace("’", "'"))))
    m = ROY_NAMED_RE.search(read)
    if not m:
        return ""
    return ("this email is signed %s but names Roy above the sign-off (%r). Kevin's ruling, "
            "22 Oct 2026: mail signed by Roy is written as Roy, in the first person (\"I will\", "
            "\"my mobile\", \"I am copied in\"), never \"Roy will\" or \"Roy has asked\". If this Roy is "
            "someone else, give their surname; a details line naming him (\"Managing agent: Roy Lavin\") "
            "is not read." % (signed, " ".join(read[max(0, m.start() - 30):m.end() + 30].split())))


# The tenant-finding chain's email cards (scripts/tenant-leads.py PREFIXES): each goes to many people
# who must never see each other. TO-EACH sends the same words to each address separately.
MAILOUT_TASK_PREFIXES = ("TENANT MAILOUT: ", "TENANT REFERRAL: ", "TENANT KEEPWARM: ", "TENANT PAST APPLICANTS: ")


def mailout_recipients_problem(task_name, parsed):
    """Why a tenant mail-out would show one recipient another's address, or ""."""
    name = str(task_name or "").strip()
    if not name.upper().startswith(tuple(p.strip().upper() for p in MAILOUT_TASK_PREFIXES)):
        return ""
    shown = len(parsed.get("to") or []) + len(parsed.get("cc") or [])
    if shown > 1:
        return ("this is a tenant mail-out and its TO and CC lines carry %d addresses, so each person "
                "would see the others. Kevin, 30 Sep 2026: they must never see each other's addresses. "
                "Use `TO-EACH:` (the same words go to each address as a separate email); BCC is refused "
                "because every address goes on the card." % shown)
    return ""


# ─── KEVIN'S SIX RULINGS, THE SENDER AND QUOTE PARTS (16 Nov 2026, decision card recinoFWz6fQ6JVVB) ───
#
# Ruling 1: every email to a letting agent goes FROM info@agilelets.co.uk signed "Roy Lavin" then
# "Agile Lets", Cash Flow Voids' AGENT RENT LATE email and its answer to the agent's reply included. The
# 5 Oct 2026 rule (from Kevin's Gmail, signed Kevin) is retired. GUARDRAILS has said since 17 Sep 2026
# that all property mail from info@ is signed Roy Lavin, Agile Lets; the stored cards show the robots
# still signed it "Kevin Brittain, on behalf of Agile Lets", "Kevin" or "Agile Lets Team".
# Ruling 6: a quote request is one email per company, never two firms on one email.
# Submit only, like the rest of validate_submission: an email Kevin already approved still goes out.
AGENT_RENT_LATE_PREFIX = "AGENT RENT LATE: "     # kept identical to AGENT_LATE_PREFIX in scripts/rent-check.py
ROY_NAME_LINE_RE = re.compile(r"^Roy Lavin\b")
AGILE_LETS_LINE_RE = re.compile(r"^Agile Lets\b")
# A signer other than Roy on info@: Kevin by name, or the other company's name, on a line of its own. "On
# behalf of the owner" under Roy's name is not a signer, and neither is "on behalf of Agile Estates".
WRONG_PROPERTY_SIGNOFF_RE = re.compile(
    r"^(?:Kevin(?:\s+Brittain)?|Agile Estates(?:\s+Ltd|\s+Limited)?)[.,!]?$", re.I)
SIX_RULINGS = "Kevin, 16 Nov 2026, decision card recinoFWz6fQ6JVVB"


def every_recipient(parsed):
    return [a.strip().lower() for a in (parsed.get("to") or []) + (parsed.get("cc") or []) + (parsed.get("toEach") or [])
            if a and a.strip()]


def outside_recipients(parsed, texts=True):
    """The recipients who are not us: never one of our own addresses, and, with texts=False, never a text
    gateway address (a text to a phone carries no email sign-off)."""
    return [a for a in every_recipient(parsed) if a not in RULE_OWN_ADDRESSES
            and (texts or address_domain(a) not in TEXT_GATEWAY_DOMAINS)]


def property_signoff_problem(parsed):
    """Why an email FROM info@ to someone outside is not signed Roy Lavin then Agile Lets, or ""."""
    if (parsed.get("from") or "").strip().lower() != PROPERTY_SENDER:
        return ""
    # A note to Roy or to Kevin, a reply to a tenant's text through the bridge (TO info@ itself) and a text
    # by ClickSend are not property mail to someone outside, and none carries the email sign-off.
    if not outside_recipients(parsed, texts=False):
        return ""
    body = parsed.get("body") or ""
    # The sender's own words above any quoted message, where a top-posted reply signs; and the body with the
    # quoted lines (">") and their "On ... wrote:" line taken out, where an inline reply signs below the quote
    # (review of this PR, finding 1). A wrong signer is read in the sender's own words only: a quoted thread
    # below a top-posted reply carries other people's sign-offs, and Kevin's own earlier ones.
    tail = closing_block(own_words(body))
    dequoted = "\n".join(ln for ln in body.splitlines()
                         if not ln.lstrip().startswith(">") and not re.match(r"^[ \t]*On .{3,200}wrote:[ \t]*$", ln))
    tails = (tail, closing_block(dequoted))
    wrong = next((ln for ln in tail if WRONG_PROPERTY_SIGNOFF_RE.match(ln)), None)
    signed_roy = any(ROY_NAME_LINE_RE.match(line) and i + 1 < len(t) and AGILE_LETS_LINE_RE.match(t[i + 1])
                     for t in tails for i, line in enumerate(t))
    if signed_roy and wrong is None:
        return ""
    if wrong is not None:
        return ("this email goes from info@agilelets.co.uk but is signed %r. Mail from info@ is Roy's: sign it "
                "`Roy Lavin` with `Agile Lets` on the next line (%s; GUARDRAILS since 17 Sep 2026). If it is Kevin's "
                "own matter (a creditor, HMRC, a solicitor, a bank, a tier-1 matter), send it from %s instead"
                % (wrong, SIX_RULINGS, PERSONAL_SENDER))
    return ("this email goes from info@agilelets.co.uk, so it ends with the sign-off `Roy Lavin` and `Agile Lets` on "
            "the next line (%s; GUARDRAILS since 17 Sep 2026). Its last lines read %r. Write it as Roy, in the first "
            "person, and sign it that way" % (SIX_RULINGS, " / ".join(tail[-3:]) or "(nothing)"))


def agent_rent_late_sender_problem(task_name, parsed):
    """Why an AGENT RENT LATE email is not going from info@, or "". Its sign-off is property_signoff_problem's."""
    if not str(task_name or "").startswith(AGENT_RENT_LATE_PREFIX):
        return ""
    # A note to Roy or Kevin on the task is not the email to the letting agent (review of this PR).
    if (parsed.get("from") or "").strip().lower() == PROPERTY_SENDER or not outside_recipients(parsed):
        return ""
    return ("an AGENT RENT LATE email goes to the letting agent FROM %s, signed `Roy Lavin` then `Agile Lets` (%s, "
            "replacing the 5 Oct 2026 rule that sent it from Kevin's Gmail). Use `FROM: %s`: it is a new email from "
            "info@, because the old threads sit in Kevin's Gmail, so quote their subject in it"
            % (PROPERTY_SENDER, SIX_RULINGS, PROPERTY_SENDER))


# A quote REFERENCE is a label, not a request ("Quote Ref: 931520229" on an insurer's renewal). Kept the
# same shape as QUOTE_REF_RE in scripts/agent-dispatch.py.
QUOTE_LABEL_RE = re.compile(r"\bquot(?:e|ation)\s*(?:ref(?:erence)?|no|number|#)\.?\s*[:#]?\s*[\w/-]+", re.I)
QUOTE_ASK_SUBJECT_RE = re.compile(r"\b(?:quote|quotes|quotation|quotations)\b|\bprice for\b", re.I)
# Asking for a PRICE, never "quote" as in cite: "please quote the clause in our management agreement" went to a
# managing agent and its sister branch on 13 Nov 2026 and is not a quote request (back-test, 18 Nov 2026).
QUOTE_ASK_BODY_RE = re.compile(
    r"\b(?:please|could you|can you|would you|kindly|grateful if you could)\b[^.\n?]{0,40}?"
    r"\b(?:provide|send|give|let (?:us|me) have|supply|forward|prepare|share)\b(?:\s+(?:us|me))?(?:\s+with)?"
    r"\s+(?:(?:a|an|your)\s+)?(?:(?:written|fixed|free|best|competitive|firm)\s+)?(?:price|quote|quotation|estimate)\b"
    r"|\bquote\s+(?:us|me)\b|\b(?:price|quote|quotation|estimate)\s+for\s+(?:the|a|an|this|these|our|carrying|doing)\b"
    r"|\bquote request\b|\bhow much (?:would|will|do|does|is|are) (?:it|you|this|that|the job)\b", re.I)


def quote_asked(parsed):
    """The words that make this email ask for a quote, or "": a subject that is not a reply, and the sender's
    own words. A reply keeps the other side's subject ("Re: Quote for boiler repair"), so it is read by its
    own words only (review of this PR: accepting a quote, copying the tenant, is not a request to two firms)."""
    subject = "" if REPLY_SUBJECT_RE.match(parsed.get("subject") or "") else (parsed.get("subject") or "")
    hit = QUOTE_ASK_SUBJECT_RE.search(QUOTE_LABEL_RE.sub(" ", subject))
    if hit:
        return "the subject says %r" % hit.group(0)
    hit = QUOTE_ASK_BODY_RE.search(QUOTE_LABEL_RE.sub(" ", own_words(parsed.get("body") or "")))
    return ("the email asks %r" % " ".join(hit.group(0).split())) if hit else ""


def multi_company_quote_problem(parsed):
    """Why a quote request would put two or more companies on one email, or "". TO-EACH is the way through."""
    shown = [a for a in (parsed.get("to") or []) + (parsed.get("cc") or [])
             if a.strip().lower() not in RULE_OWN_ADDRESSES]
    companies = sorted({company_key(a) for a in shown})
    if len(companies) < 2:
        return ""
    asked = quote_asked(parsed)
    if not asked:
        return ""
    return ("this email asks for a quote (%s) and its TO and CC lines reach %d companies (%s). Kevin's ruling (%s): "
            "one email per company, always, never two firms on one email. Use `TO-EACH:` in place of TO and CC (the "
            "same words go to each address as a separate email, so write words that fit every firm, with no one "
            "firm's name in the greeting), or submit one card per company"
            % (asked, len(companies), ", ".join(companies), SIX_RULINGS))


# Where `inbound-triage.py attachments` saves what other people sent (GUARDRAILS "Email attachments"). A
# document there is someone else's words as received: an insurer's "[approx.]", a solicitor's "[sic]". The
# agent cannot edit it, so it is not read, as the quoted reply under an email is not read (review of PR 951,
# F7: 15 of 16 bracket hits in 482 local PDFs were in that folder, every one the sender's own text).
INBOUND_ATTACHMENTS = "~/knowledge-os/attachments/inbound"
AS_RECEIVED_WAY = ("If this is someone else's document, unchanged, use the copy `python3 scripts/inbound-triage.py "
                   "attachments` saved under %s: a document as received is not read" % INBOUND_ATTACHMENTS)
# The tenancy pack's own title and footer lines (scripts/make-tenancy-pack.js) carry an em dash the agent
# cannot change, so a posted pack document is read for placeholders only (review of PR 951, F7).
PACK_FOOTER_MARKS = (" — proof of residency — Agile Lets Limited", " — authority to act — ",
                     " — not valid until signed by ")


def as_received(document):
    """True when the file sits in the inbound attachments folder: someone else's document, as received."""
    import os
    path = os.path.realpath(os.path.expanduser(str(document or "")))
    root = os.path.realpath(os.path.expanduser(INBOUND_ATTACHMENTS))
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def letter_text(document):
    """The text of a PDF this card will post, or None when there is no such file to read here (the
    submit gate's own file check refuses a missing file). Raises EmailFormatError when the file is
    there but cannot be read: a letter nobody could check is not a letter that passed."""
    import os
    path = os.path.expanduser(str(document or ""))
    if not path.lower().endswith(".pdf") or not os.path.isfile(path):
        return None
    try:
        import pypdf
        return "\n".join((page.extract_text() or "") for page in pypdf.PdfReader(path).pages)
    except Exception as exc:  # any read failure becomes a refusal that names it, never a pass
        raise EmailFormatError("could not read the text of %s to check it for placeholders and em dashes "
                               "(%s: %s). If it is ours, make the PDF again; %s."
                               % (os.path.basename(path), type(exc).__name__, str(exc)[:120],
                                  AS_RECEIVED_WAY[0].lower() + AS_RECEIVED_WAY[1:]))


def expected_sender(subject, body):
    """Which identity this copy must go out as.

    Business first: a Runpreneur mention inside an Operations Director email
    is a topic, whereas OD branding inside a Runpreneur email would be the
    business speaking, and the business identity is the one with a prospect on
    the other end of it.
    """
    text = "%s\n%s" % (subject or "", body or "")
    if BUSINESS_BRAND_RE.search(text):
        return BUSINESS_SENDER
    if RUNPRENEUR_BRAND_RE.search(text):
        return RUNPRENEUR_SENDER
    return PERSONAL_SENDER


def validate_submission(output, task_name=None):
    """Strict checks the SUBMIT gate applies. Raises EmailFormatError.

    Returns the parsed email so the caller does not parse twice. Never called
    on the send path — see the note above. `task_name` lets the mail-out check
    know a tenant mail-out; without it that one check cannot run.
    """
    parse_text(output)                                 # a bad text is refused before Kevin sees the card, by name
    parsed = parse_output(output)
    sender = parsed["from"]
    if not sender:
        want = expected_sender(parsed["subject"], parsed["body"])
        raise EmailFormatError(
            "no FROM address. Kevin corrected this by hand 11 times in one "
            "month, so it is now required, not assumed. This copy should go "
            "out as %s — add `FROM: %s` to the headers." % (want, want))
    if sender.lower() not in ALLOWED_SENDERS:
        raise EmailFormatError(
            "FROM is %s, which is not one of Kevin's sending identities (%s)"
            % (sender, ", ".join(ALLOWED_SENDERS)))
    # DIRECTIONAL, not symmetric. A blanket "FROM must equal expected_sender"
    # reads well and blocks legitimate work: an email that happens to mention
    # Operations Director in passing would be forced onto the business address
    # with no way to say otherwise, and there would be no override at all.
    #
    # So each identity is checked for the mistake that identity actually makes:
    #
    #   personal   -> refused when the copy SPEAKS AS a brand. This is finding
    #                 20260812-ceo-huddle-094: ten warm-lane emails saying "you
    #                 booked a call with Operations Director" about to go to
    #                 Kevin's highest-intent audience from a gmail address.
    #   a brand    -> refused when the copy carries NO signal for that brand.
    #                 This is Kevin's 27 Aug complaint: creditor and council
    #                 letters drafted to send from kevin@runpreneur.org.uk for
    #                 no reason at all.
    #
    # Copy that genuinely mentions both keeps whichever the agent chose, and
    # Kevin sees the sender on the approval card before he decides. That is the
    # override: visible, not silent.
    text = "%s\n%s" % (parsed["subject"] or "", parsed["body"] or "")
    if sender.lower() == PERSONAL_SENDER:
        for brand_re, addr, label in (
                (BUSINESS_BRAND_RE, BUSINESS_SENDER, "the business"),
                (RUNPRENEUR_BRAND_RE, RUNPRENEUR_SENDER, "Runpreneur")):
            hit = brand_re.search(text)
            if hit:
                raise EmailFormatError(
                    "this copy speaks as %s (matched %r) but sends from the "
                    "personal address. Use `FROM: %s`, or take the brand out "
                    "of the copy." % (label, hit.group(0), addr))
    elif sender.lower() == BUSINESS_SENDER and not BUSINESS_BRAND_RE.search(text):
        raise EmailFormatError(
            "FROM is the Operations Director address but nothing in the copy "
            "speaks as the business. The standing default is %s."
            % PERSONAL_SENDER)
    elif sender.lower() == RUNPRENEUR_SENDER and not RUNPRENEUR_BRAND_RE.search(text):
        raise EmailFormatError(
            "FROM is the Runpreneur address but this has nothing to do with "
            "Runpreneur. Kevin's ruling, 27 Aug 2026: never send from %s "
            "unless it is a Runpreneur matter; %s is the standard."
            % (RUNPRENEUR_SENDER, PERSONAL_SENDER))
    bad = signoff_problem(parsed["body"])
    if bad:
        if sender.lower() == PROPERTY_SENDER:
            raise EmailFormatError(
                "%s Mail from info@ is signed `Roy Lavin` with `Agile Lets` on the next line, and nothing "
                "under it: no address, no phone number, no contact block." % bad)
        raise EmailFormatError(
            "%s Sign off as `Kevin Brittain`, or `Kevin Brittain` on its own "
            "line above `on behalf of <company>` when writing for an entity. "
            "No address, no phone number, no contact block." % bad)
    bad = sms_reply_problem(parsed)
    if bad:
        raise EmailFormatError(bad)
    words = own_words(parsed["body"])
    # A subject the agent wrote is read the same way. A reply or forward keeps the other side's subject so
    # it threads, and every subject hit in the first back-test was theirs ("Re: ... [SMS]", "[EXTERNAL]",
    # "[Quote Ref: 931520229]"), so a subject starting Re:, Fw: or Fwd: is not read (review of PR 951).
    own_subject = "" if REPLY_SUBJECT_RE.match(parsed["subject"] or "") else (parsed["subject"] or "")
    bad = (placeholder_problem(words) or em_dash_problem(words)
           or placeholder_problem(own_subject, "the subject") or em_dash_problem(own_subject, "the subject")
           or roy_third_person_problem(parsed["body"])
           or mailout_recipients_problem(task_name, parsed)
           # Kevin's six rulings (16 Nov 2026): the AGENT RENT LATE sender, Roy's sign-off on info@, and one
           # company per quote request.
           or agent_rent_late_sender_problem(task_name, parsed)
           or property_signoff_problem(parsed)
           or multi_company_quote_problem(parsed))
    if bad:
        raise EmailFormatError(bad)
    # A mail-out redrafted as one long TO line shows every contact to every other
    # (review of the tenant-finding chain, 25 Sep 2026). Refused at submit, where the
    # fix is one word, rather than discovered by thirty people.
    if len(parsed["to"]) > TO_MAX_VISIBLE:
        raise EmailFormatError(
            "TO carries %d addresses, so every recipient would see all the others. "
            "Use `TO-EACH:` instead: the same words go to each address separately."
            % len(parsed["to"]))
    return parsed


# ─── A REPLY TO A TENANT'S TEXT (Roy's assistant, 24 Sep 2026) ──────────
#
# Tenant texts arrive at info@ as emails from the SMS bridge, and a "Re:"
# message in info@'s SENT folder that carries the conversation marker is
# texted back to the tenant: the words ABOVE the first quoted line
# (workers/sms-email-bridge/worker.js, parseEmailReply). So an approved email
# TO info@agilelets.co.uk is how an agent answers a text. Any other email to
# info@ would land in our own inbox and read on the card as if it had reached
# someone, so it is refused here, before Kevin ever sees it.
SMS_BRIDGE_MARK_RE = re.compile(r"(?:GHL Conversation:|SMS_BRIDGE_ID:)\s*[A-Za-z0-9_-]{6,}")
# Kept identical to QUOTE_START_RE in the bridge (tests/roy-assistant.test.js).
SMS_QUOTE_START_RE = re.compile(r"^(On .+wrote:|-{2,}\s*Original Message|From: .+|>)", re.M)
SMS_MAX_CHARS = 1000


def sms_reply_problem(parsed):
    """Why an email addressed to info@ would not reach the tenant as a text, or ""."""
    to = [a.lower() for a in parsed.get("to") or []]
    if PROPERTY_SENDER not in to:
        return ""
    why = ("an email to %s is only ever a reply to a tenant's text, which the SMS "
           "bridge texts back: " % PROPERTY_SENDER)
    if to != [PROPERTY_SENDER] or parsed.get("cc"):
        return why + "it must go to that address alone, with no CC"
    if (parsed.get("from") or "").lower() != PROPERTY_SENDER:
        return why + "it must go FROM %s, the only Sent folder the bridge reads" % PROPERTY_SENDER
    subject = parsed.get("subject") or ""
    if not re.match(r"^re:", subject, re.I) or "[sms]" not in subject.lower():
        return why + "the subject must be `Re: ` plus the text email's own subject, [SMS] included"
    if parsed.get("attach"):
        return why + "a text cannot carry an attachment"
    body = parsed.get("body") or ""
    if not SMS_BRIDGE_MARK_RE.search(body):
        return why + "the body must quote the text email's SMS_BRIDGE_ID line, or the bridge cannot tell who to text"
    quote = SMS_QUOTE_START_RE.search(body)
    text = body[:quote.start()].strip() if quote else ""
    if not text:
        return why + "the words for the tenant go ABOVE a quoted line starting `> `; nothing is above it"
    if len(text) > SMS_MAX_CHARS:
        return why + "a text is at most %d characters; this one is %d" % (SMS_MAX_CHARS, len(text))
    return ""


# ─── THE OTHER TWO SHAPES: POST AND SIGN ─────────────────────────────
#
# Kevin's workflow, in his words on 28 Aug 2026:
#
#   "They would create the PDF and show me it for approval. They would then
#    send it off to be signed by the relevant people. Once it comes back, they
#    would then show me that document with the email correspondence ready to
#    go, and I would then confirm it. They would then send it off."
#
# That is TWO gates on one piece of work, and the second one is a different
# shape from the first. Correspondence used to mean email and nothing else, so
# the submit gate refused a postal letter outright:
#
#   REFUSED: header line is not `KEY: value`: 'Corporation Tax'
#
# An agent literally could not put a letter in front of Kevin. Three shapes now
# exist, and they live HERE, in the one module, for the reason this file was
# written in the first place: two scripts that had to agree on a format did not,
# and an approved action that cannot be carried out is worse than a refused one.
#
#   SIGN   gate 1 — "here is the document, may it go for signature?"
#   POST   gate 2 — "here is the signed letter, may I post it?"
#   EMAIL  gate 2 — "here is the signed letter, may I email it?"  (unchanged)
#
# The body is REQUIRED on all three. Kevin's own ruling on the approval surface
# is that it must say what the thing IS, not just name a file: approving
# "AST_Smith.pdf" is not consent to its contents.

POST_HEADERS = {"POST", "DOCUMENT", "DELIVERY"}
SIGN_HEADERS = {"DOCUMENT", "SIGNERS", "SUBJECT"}

# Matches send-letter.py's Pingen products. "registered" is accepted by the API
# but is NOT confirmed available for UK destinations.
DELIVERY_PRODUCTS = ("cheap", "fast", "bulk", "premium", "registered")


def _head_and_body(output):
    text = strip_track_record(strip_tier1_banner(output or ""))
    if not text.strip():
        raise EmailFormatError("Agent Output is empty")
    if "---" not in text:
        raise EmailFormatError(
            "Agent Output has no `---` line separating headers from body")
    head, _, body = text.partition("---")
    return head, strip_carry_out_line(body)


def detect_kind(output):
    """Which of the three shapes this output is. Never raises on shape alone."""
    try:
        head, _ = _head_and_body(output)
    except EmailFormatError:
        return "email"          # let the email parser produce the real message
    lines = [ln.strip() for ln in head.splitlines() if ln.strip()]
    if lines and " ".join(lines[0].partition(":")[0].split()).upper() == SIGN_AS_KEVIN:
        return "signkevin"
    if lines and lines[0].rstrip().upper().rstrip(":") == "POST":
        return "post"
    keys = {ln.partition(":")[0].strip().upper() for ln in lines if ":" in ln}
    if "SIGNERS" in keys:
        return "sign"
    return "email"


def _one_file(value, header):
    path = (value or "").strip()
    if not path:
        raise EmailFormatError(f"{header} names no file")
    if "," in path or ";" in path:
        raise EmailFormatError(
            f"{header} names more than one file — exactly one is supported. "
            "Every extra file is another thing approved without being opened.")
    if "\n" in path or "\r" in path:
        raise EmailFormatError(f"{header} contains a line break")
    return path


def postcode_line_problem(address):
    """Reason string when the UK postcode does not sit alone on its own line, else "".

    Pingen reads the recipient off the PAGE, through the envelope window, and rejects a block whose
    postcode shares a line with the town: the approved TMW letter of 15 Oct 2026 failed inspection
    with address_zip_invalid on a last line of "Northampton NN3 6NW", while the same run's
    "LS78 1LB" on its own line passed (finding 20261015-agent-dispatch-906). The check belongs here,
    before Kevin approves: found after approval, the fix costs a second approval.

    Only UK blocks are judged. A block whose last line is a country other than the United Kingdom is
    left alone, because no other country's postcode rule is encoded here.
    """
    lines = [ln.strip() for ln in address if ln.strip()]
    if not lines:
        return ""
    last = lines[-1]
    if last.lower().strip(".") in ("united kingdom", "uk", "great britain", "england",
                                   "scotland", "wales", "northern ireland"):
        lines = lines[:-1]
        if not lines:
            return ""
        last = lines[-1]
    elif not any(UK_POSTCODE_RE.search(ln) for ln in lines):
        return ""      # not a UK address as far as this file can tell
    hits = [ln for ln in lines if UK_POSTCODE_RE.search(ln)]
    if not hits:
        return ("the address block has no UK postcode. Pingen reads the recipient off the page and "
                "refuses a block it cannot read a postcode from.")
    if not UK_POSTCODE_RE.fullmatch(last.strip()):
        return ("the postcode must sit ALONE on the last line of the address (or the line above "
                "\"United Kingdom\"), and %r does not. Pingen rejected exactly this with "
                "address_zip_invalid on 15 Oct 2026: write the town and the postcode on two lines."
                % last)
    return ""


def parse_post_output(output):
    """A postal letter: an address block, the PDF to post, and a summary.

        POST:
        Corporation Tax
        HM Revenue and Customs
        BX9 1AX
        United Kingdom
        DOCUMENT: ~/knowledge-os/attachments/hmrc.pdf
        DELIVERY: cheap
        ---
        Plain English: what this letter says and why.

    The address lines are deliberately NOT `KEY: value` — an address is not a
    header. They run from the POST: line to the first real header.
    """
    head, body = _head_and_body(output)
    lines = [ln.rstrip() for ln in head.splitlines()]
    started = False
    address, headers = [], {}
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if not started:
            if line.rstrip().upper().rstrip(":") != "POST":
                raise EmailFormatError(
                    "a postal letter must start with a `POST:` line")
            started = True
            continue
        # Catch a bare "To:" BEFORE the header branch. It parses as an empty
        # TO header and would otherwise be refused as merely "unsupported",
        # losing the lesson: two of the six HMRC letters returned "Not at this
        # address" in 2025 carried exactly this line at the top of the block
        # that Pingen reads off the page.
        if re.fullmatch(r"to:?", line, re.I):
            raise EmailFormatError(
                'the address block contains a bare "To:" line. That exact '
                "defect put six HMRC letters in the returned pile — the block "
                "must hold ONLY the address.")
        key, sep, val = line.partition(":")
        if sep and key.strip().upper() in POST_HEADERS | {"CC", "TO", "FROM", "SUBJECT", "ATTACH"}:
            headers[key.strip().upper()] = val.strip()
            continue
        if headers:
            raise EmailFormatError(
                f"address line {line!r} appears AFTER a header. The whole "
                "address must sit directly under POST:")
        address.append(line)

    unknown = set(headers) - POST_HEADERS
    if unknown:
        raise EmailFormatError(
            f"unsupported header(s) for a postal letter: {', '.join(sorted(unknown))}. "
            "Only DOCUMENT and DELIVERY.")

    # Pingen reads the recipient off the PAGE, out of the envelope window, so
    # this block is not metadata — it is what send-letter.py compares against
    # what Pingen actually read. Six HMRC letters came back "Not at this
    # address" in 2025, two of them with a stray "To:" leading the address.
    if any(re.fullmatch(r"to:?", ln, re.I) for ln in address):
        raise EmailFormatError(
            'the address block contains a bare "To:" line. That exact defect '
            "put six HMRC letters in the returned pile — the block must hold "
            "ONLY the address.")
    if len(address) < 3:
        raise EmailFormatError(
            f"only {len(address)} address line(s) under POST:. A postal address "
            "needs at least a name, a street or office, and a postcode.")
    bad = postcode_line_problem(address)
    if bad:
        raise EmailFormatError(bad)

    document = _one_file(headers.get("DOCUMENT"), "DOCUMENT")
    delivery = (headers.get("DELIVERY") or "cheap").strip().lower()
    if delivery not in DELIVERY_PRODUCTS:
        raise EmailFormatError(
            f"DELIVERY is {delivery!r}, not one of {', '.join(DELIVERY_PRODUCTS)}")
    if not body:
        raise EmailFormatError(
            "no summary below the `---`. Approving a posted letter means "
            "approving what it SAYS, so say it in plain English.")
    return {"kind": "post", "address": address, "document": document,
            "delivery": delivery, "body": body}


def parse_sign_output(output):
    """Gate 1: a document going out for signature.

        DOCUMENT: ~/knowledge-os/attachments/loa_hmrc.pdf
        SIGNERS: kevinbrittain@gmail.com, adviser@example.com
        SUBJECT: Letter of authority                      (optional)
        ---
        Plain English: what this document is and what signing it commits you to.
    """
    head, body = _head_and_body(output)
    headers = {}
    for raw in head.splitlines():
        line = raw.strip()
        if not line:
            continue
        key, sep, val = line.partition(":")
        if not sep:
            raise EmailFormatError(f"header line is not `KEY: value`: {line!r}")
        headers[key.strip().upper()] = val.strip()
    unknown = set(headers) - SIGN_HEADERS
    if unknown:
        raise EmailFormatError(
            f"unsupported header(s) for a signature request: "
            f"{', '.join(sorted(unknown))}. Only DOCUMENT, SIGNERS and SUBJECT.")
    document = _one_file(headers.get("DOCUMENT"), "DOCUMENT")
    signers = parse_addresses(headers.get("SIGNERS", ""), "SIGNERS")
    if not signers:
        raise EmailFormatError("no SIGNERS — name who has to sign it")
    if not body:
        raise EmailFormatError(
            "no explanation below the `---`. Approving a filename is not "
            "consent to a document's contents; say what it is and what "
            "signing it commits Kevin to.")
    return {"kind": "sign", "document": document, "signers": signers,
            "subject": headers.get("SUBJECT", "").strip(), "body": body}


# ─── THE FOURTH SHAPE: SIGN AS KEVIN (Kevin, 16 Oct 2026) ────────────
#
#   "with signing things, the initial request is to come to me, but if I say
#    so, I can give you approval to sign on my behalf ... a legal signature:
#    if I'm happy, I'm going to approve you to do it, then you can do that as
#    well."
#
#   SIGN AS KEVIN   "someone has asked you to sign this; may the robot sign it
#                    for you?"  Approve = the authority for this ONE document.
#
#       SIGN AS KEVIN: AST_Riel_Jackson_18_Northfield_Park
#       AGREEMENT ID: CBJCHBCAABAA...
#       SIGNER: info@agilelets.co.uk
#       DOCUMENT: ~/knowledge-os/attachments/unsigned_recXXX_AST_Riel.pdf
#       ---
#       Plain English: what it is, who sent it, what signing commits you to.
#
# `agent-browser.js sign --dry-run` reads the name and Adobe's own id off the
# agreement and downloads the unsigned copy, so nothing here is typed from
# memory. `agent-browser.js sign` signs only the agreement whose id the
# APPROVED card names, and only through a door it holds:
#   info@agilelets.co.uk  the robot's own Adobe session, "Waiting for you". The
#                         account's saved signature is Kevin's (Kevin, 28 Sep
#                         2026); a box signed as Roy Lavin is never this shape.
#   kevinbrittain@gmail.com  a link Adobe emailed him (adobe_sign_link.py finds
#                         it), opened with no Adobe session, signed with his
#                         typed name. AGREEMENT ID is then "tsid-<fingerprint>".
# Other companies' signing sites and paper have no door, so they stay Kevin's
# Your step (KEVIN ONLY: signature).

SIGN_AS_KEVIN = "SIGN AS KEVIN"
SIGN_AS_KEVIN_HEADERS = {SIGN_AS_KEVIN, "AGREEMENT ID", "SIGNER", "DOCUMENT"}
# kevinbrittain@gmail.com: a link Adobe emails him (16 Oct 2026), signed with his typed name after his approval
# (scripts/adobe_sign_link.py finds it: Adobe's own sender, to him, on Adobe's signing host).
SIGN_AS_KEVIN_SIGNERS = ("info@agilelets.co.uk", "kevinbrittain@gmail.com")
# Adobe's agreement id as the robot reads it: letters, digits and the URL-safe
# punctuation Adobe uses, never a space or a line break.
AGREEMENT_ID_RE = re.compile(r"^[A-Za-z0-9_\-:.]{12,200}$")


def _first_header(output):
    """The first header's key, upper case with its spacing squashed, so "Sign as  Kevin :" is the
    same card as "SIGN AS KEVIN:" everywhere it is checked (second review, 16 Oct 2026)."""
    try:
        head, _ = _head_and_body(output)
    except EmailFormatError:
        return ""
    for ln in head.splitlines():
        if ln.strip():
            return " ".join(ln.strip().partition(":")[0].split()).upper()
    return ""


def parse_sign_as_kevin_output(output):
    """Kevin's signature, to be applied by the robot once he approves this card."""
    head, body = _head_and_body(output)
    headers, order = {}, []
    for raw in head.splitlines():
        line = raw.strip()
        if not line:
            continue
        key, sep, val = line.partition(":")
        if not sep:
            raise EmailFormatError(f"header line is not `KEY: value`: {line!r}")
        key = " ".join(key.split()).upper()
        if key in headers:
            raise EmailFormatError(f"{key} appears twice: one card signs one document")
        headers[key] = val.strip()
        order.append(key)
    if not order or order[0] != SIGN_AS_KEVIN:
        raise EmailFormatError(f"a signature for Kevin starts with a `{SIGN_AS_KEVIN}:` line")
    unknown = set(headers) - SIGN_AS_KEVIN_HEADERS
    if unknown:
        raise EmailFormatError(
            f"unsupported header(s) for a signature for Kevin: {', '.join(sorted(unknown))}. "
            f"Only {SIGN_AS_KEVIN}, AGREEMENT ID, SIGNER and DOCUMENT.")
    agreement = headers[SIGN_AS_KEVIN]
    if not agreement or len(agreement) > 200:
        raise EmailFormatError(
            f"{SIGN_AS_KEVIN} must name the agreement exactly as Adobe shows it (1 to 200 characters)")
    agreement_id = headers.get("AGREEMENT ID", "")
    if not AGREEMENT_ID_RE.match(agreement_id):
        raise EmailFormatError(
            "no readable AGREEMENT ID. Run `node scripts/agent-browser.js sign --task <id> "
            "--agreement \"<name>\" --dry-run` and copy the block it prints: the robot signs only "
            "the agreement whose id Kevin approved.")
    signers = parse_addresses(headers.get("SIGNER", ""), "SIGNER")
    if len(signers) != 1:
        raise EmailFormatError("SIGNER names exactly one address: the Adobe account whose box this is")
    signer = signers[0].lower()
    if signer not in SIGN_AS_KEVIN_SIGNERS:
        raise EmailFormatError(
            f"the robot cannot sign for {signer}: its signing doors are "
            f"{', '.join(SIGN_AS_KEVIN_SIGNERS)} (Adobe only). Anything else stays "
            "Kevin's own step: `KEVIN ONLY: signature: <the step>`.")
    document = _one_file(headers.get("DOCUMENT"), "DOCUMENT")
    if not document.lower().endswith(".pdf"):
        raise EmailFormatError("DOCUMENT is the unsigned copy Kevin reads, a .pdf")
    if not body:
        raise EmailFormatError(
            "no explanation below the `---`. Approving a filename is not consent to a "
            "document's contents; say what it is, who sent it and what signing commits Kevin to.")
    return {"kind": "signkevin", "agreement": agreement, "agreementId": agreement_id,
            "signer": signer, "document": document, "body": body}


def sign_as_kevin(output):
    """The parsed card when this output is the SIGN AS KEVIN shape, else None. Raises on a card
    that claims the shape but breaks it."""
    if _first_header(output) != SIGN_AS_KEVIN:
        return None
    return parse_sign_as_kevin_output(output)


def parse_any(output):
    """Parse whichever of the four shapes this is. Always carries `kind`."""
    kind = detect_kind(output)
    if kind == "signkevin":
        return parse_sign_as_kevin_output(output)
    if kind == "post":
        return parse_post_output(output)
    if kind == "sign":
        return parse_sign_output(output)
    parsed = parse_output(output)
    parsed["kind"] = "email"
    return parsed


def validate_submission_any(output, task_name=None):
    """The SUBMIT gate for all three shapes. Raises EmailFormatError.

    Email keeps its strict extra rules (a FROM identity, no contact details
    under the sign-off) because those came from counting Kevin's own
    corrections. A postal letter and a signature request have no sender
    identity to get wrong, so their strict layer is their parser plus the
    document's own text (16 Nov 2026): a letter we post carries no placeholder
    and no em dash, and a document going out for signature carries no
    placeholder. The summary under a POST or SIGN card is for Kevin and is not
    read. An em dash is not refused in a document for signature: the tenancy
    pack's code-made title lines carry one, and the agent cannot change them.
    A PDF attached to an email is read like a document for signature (review
    of PR 951, F3: the letter of authority that taught the rule passed when
    emailed). A document in the inbound folder is someone else's, as received,
    and is not read (AS_RECEIVED_WAY names that way through every refusal).
    """
    kind = detect_kind(output)
    if kind == "signkevin":
        return parse_sign_as_kevin_output(output)
    if kind == "post":
        parsed = parse_post_output(output)
        text = None if as_received(parsed["document"]) else letter_text(parsed["document"])
        if text is not None:
            bad = placeholder_problem(text, "the letter")
            if not bad and not any(mark in text for mark in PACK_FOOTER_MARKS):
                bad = em_dash_problem(text, "the letter")
            if bad:
                raise EmailFormatError("%s %s." % (bad, AS_RECEIVED_WAY))
        return parsed
    if kind == "sign":
        parsed = parse_sign_output(output)
        text = None if as_received(parsed["document"]) else letter_text(parsed["document"])
        bad = placeholder_problem(text, "the document") if text is not None else ""
        if bad:
            raise EmailFormatError("%s %s." % (bad, AS_RECEIVED_WAY))
        return parsed
    parsed = validate_submission(output, task_name=task_name)
    attach = parsed.get("attach")
    text = None if (not attach or as_received(attach)) else letter_text(attach)
    bad = placeholder_problem(text, "the attached document") if text is not None else ""
    if bad:
        raise EmailFormatError("%s %s." % (bad, AS_RECEIVED_WAY))
    return parsed
