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


def validate_submission(output):
    """Strict checks the SUBMIT gate applies. Raises EmailFormatError.

    Returns the parsed email so the caller does not parse twice. Never called
    on the send path — see the note above.
    """
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
        raise EmailFormatError(
            "%s Sign off as `Kevin Brittain`, or `Kevin Brittain` on its own "
            "line above `on behalf of <company>` when writing for an entity. "
            "No address, no phone number, no contact block." % bad)
    return parsed


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
    text = strip_tier1_banner(output or "")
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


def parse_any(output):
    """Parse whichever of the three shapes this is. Always carries `kind`."""
    kind = detect_kind(output)
    if kind == "post":
        return parse_post_output(output)
    if kind == "sign":
        return parse_sign_output(output)
    parsed = parse_output(output)
    parsed["kind"] = "email"
    return parsed


def validate_submission_any(output):
    """The SUBMIT gate for all three shapes. Raises EmailFormatError.

    Email keeps its strict extra rules (a FROM identity, no contact details
    under the sign-off) because those came from counting Kevin's own
    corrections. A postal letter and a signature request have no sender
    identity to get wrong, so their strict layer IS their parser.
    """
    kind = detect_kind(output)
    if kind == "post":
        return parse_post_output(output)
    if kind == "sign":
        return parse_sign_output(output)
    return validate_submission(output)
