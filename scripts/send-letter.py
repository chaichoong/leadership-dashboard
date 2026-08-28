#!/usr/bin/env python3
"""Post an approved letter on Kevin's behalf — the gate for the Pingen API.

WHY THIS EXISTS (28 Aug 2026)
Pingen's API sends real paper to real addresses and costs about GBP 2.50 a
letter. It is gated only by an OAuth client secret, so anything holding that
secret can post anything to anyone. "Only send approved letters" is a rule in a
memory file, and a rule in prose is not a control.

This script is the CONTROL, and it is the same shape as send-email.py: the ONLY
source of a letter is the Agent Output of an APPROVED Correspondence task. No
address on the command line, no body on the command line, no --force.

THE ADDRESS CHECK IS THE POINT
Pingen has NO address parameter. Verified against the SDK type definitions:
CreateLetter takes file_original_name, file_url, file_url_signature,
address_position, auto_send, delivery_product, print_mode, print_spectrum, and
nothing else. The recipient address is READ OFF THE PDF, out of the envelope
window area.

That is how six HMRC letters were lost. Sent Sept/Oct 2025, charged at GBP 2.47
each, all returned "Not at this address" 24 days later. Two of them had a stray
"To:" line sitting at the top of the parsed address, picked up from the wrong
part of the page. Another letter in the same account recorded its recipient as
"Reference: 623 C 8402124449 Re: BriEain Holdings Limited" — a reference line
read as an address, with "Britain" mangled by the text extraction. Nothing
errored. The failure surfaced three weeks later, on a screen nobody was
watching.

So the flow is deliberately two-phase, using the fact that create and send are
separate API calls:

  prepare  uploads the PDF with auto_send=false, then reads back THE ADDRESS
           PINGEN ACTUALLY PARSED and compares it to the address the approved
           task declared. Nothing is posted. A mismatch is a hard refusal.
  send     re-runs that comparison against the live record and only then calls
           the send endpoint. Requires a live Approved verdict in Airtable.

An agent cannot post a letter Kevin has not read, and neither an agent nor
Kevin can post one whose address Pingen has misread, because the second check
does not depend on anyone remembering to look.

AGENT OUTPUT FORMAT (a postal Correspondence task must use exactly this)

    POST:
    Corporation Tax
    HM Revenue and Customs
    BX9 1AX
    United Kingdom
    DOCUMENT: ~/knowledge-os/attachments/hmrc-corporation-tax.pdf
    DELIVERY: cheap
    ---
    Optional notes for Kevin. Never printed, never posted.

POST: is the intended recipient address, one line per line, exactly as it must
appear in the envelope window of the PDF. DOCUMENT: is the file to post and
must live under ~/knowledge-os/attachments. DELIVERY: is optional and defaults
to "cheap" (Royal Mail 2nd Class); "fast" is 1st Class. A letter task carries
POST: where an email task carries TO:, so the two formats cannot be confused
and send-email.py refuses a letter rather than emailing it.

AUTH
OAuth client credentials at ~/.config/od/pingen_client_id and
~/.config/od/pingen_client_secret, organisation at ~/.config/od/pingen_org_id.
Read from files, never printed and never passed as arguments (see the CLAUDE.md
rule on secrets in the process table).

USAGE
    python3 scripts/send-letter.py preview recXXXXXXXXXXXXXX
    python3 scripts/send-letter.py prepare recXXXXXXXXXXXXXX
    python3 scripts/send-letter.py send    recXXXXXXXXXXXXXX
    python3 scripts/send-letter.py health
    python3 scripts/send-letter.py selftest
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

BASE_ID = "appnqjDpqDniH3IRl"
TASKS = "tblqB8b22hKBL4PF1"

# Mirrors AF in scripts/agent-dispatch.py and send-email.py.
AF = {
    "name":            "fldgFjGBw6bTKJFCD",
    "status":          "fldx4qCw17UfrKpaN",
    "approvalOutcome": "fldrHBSr6qoUfaKuZ",
    "agentOutput":     "fldzswp8fx6PqpLQ5",
    "taskType":        "fldZ2moDV2041Sobc",
}

APPROVED = ("Approved as-is", "Approved with minor edits")

PAT_PATH = os.path.expanduser("~/.config/od/airtable_pat")
PG_ID_PATH = os.path.expanduser("~/.config/od/pingen_client_id")
PG_SECRET_PATH = os.path.expanduser("~/.config/od/pingen_client_secret")
PG_ORG_PATH = os.path.expanduser("~/.config/od/pingen_org_id")

IDENTITY = "https://identity.pingen.com/auth/access-tokens"
API = "https://api.pingen.com"

STATE_DIR = os.path.expanduser("~/knowledge-os/logs/agent-dispatch")
SENT_LEDGER = os.path.join(STATE_DIR, "sent-letter.jsonl")

DOC_DIR = os.path.realpath(os.path.expanduser(
    os.environ.get("SEND_LETTER_DOC_DIR") or "~/knowledge-os/attachments"))
DOC_MAX_BYTES = 20 * 1024 * 1024

# "cheap" is Royal Mail 2nd Class and is the Pingen default. "registered" is
# accepted by the API but is NOT confirmed available for UK destinations — the
# UK delivery options page lists 1st and 2nd class only. `prepare` prints the
# price Pingen quotes, which is where an unavailable product shows up.
DELIVERY_PRODUCTS = ("cheap", "fast", "bulk", "premium", "registered")

# Pingen grades every uploaded letter itself. Measured against the live API on
# 28 Aug 2026 by uploading the same address block at three heights:
#
#   57mm from the top  -> "action_required", address truncated to 3 of 4 lines
#   64mm from the top  -> "valid",           all 4 lines read correctly
#   71mm from the top  -> "action_required", all 4 lines read correctly
#
# The middle row is the point. At 71mm the address the script compares was
# PERFECT and Pingen still refused to treat the letter as sendable, so the
# address check on its own would have waved through a letter that cannot post.
# Both gates are needed: what Pingen READ must match, and what Pingen THINKS of
# the letter must be "valid".
#
# The 64mm figure is the address block's first baseline (y=660pt on A4, x=70pt
# ≈ 25mm from the left edge) and is the number to build PDF templates against.
PINGEN_OK_STATUS = "valid"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def read_secret(path, what):
    if not os.path.exists(path):
        sys.exit(f"ERROR: no {what} at {path}")
    with open(path) as fh:
        return fh.read().strip()


# ─── Airtable ────────────────────────────────────────────────────────────

def airtable(method, url, payload=None):
    pat = read_secret(PAT_PATH, "Airtable PAT")
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {pat}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        # Never echo request headers here: they carry the PAT.
        sys.exit(f"ERROR: Airtable {method} {e.code}: {e.read().decode()[:400]}")


def get_task(task_id):
    # returnFieldsByFieldId is NOT optional: AF is keyed by field ID. Without
    # it every lookup reads empty and the gate refuses for the wrong reason,
    # which looks like the gate working while it is in fact blind.
    return airtable("GET", f"https://api.airtable.com/v0/{BASE_ID}/{TASKS}/"
                           f"{task_id}?returnFieldsByFieldId=true")


def sel(v):
    return v.get("name", "") if isinstance(v, dict) else (v or "")


# ─── Pingen ──────────────────────────────────────────────────────────────

def pingen_token():
    """Client-credentials token. The secret goes in the POST body, never argv."""
    body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": read_secret(PG_ID_PATH, "Pingen client id"),
        "client_secret": read_secret(PG_SECRET_PATH, "Pingen client secret"),
    }).encode()
    req = urllib.request.Request(IDENTITY, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())["access_token"]
    except urllib.error.HTTPError as e:
        sys.exit(f"ERROR: Pingen auth {e.code}: {e.read().decode()[:300]}")


def pingen(method, path, token, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.api+json")
    if data:
        req.add_header("Content-Type", "application/vnd.api+json")
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"ERROR: Pingen {method} {path} {e.code}: "
                 f"{e.read().decode()[:400]}")


def org_id():
    return read_secret(PG_ORG_PATH, "Pingen organisation id")


# ─── The format ──────────────────────────────────────────────────────────

class LetterFormatError(Exception):
    pass


TIER1_BANNER = re.compile(r"^\s*(?:\*\*)?TIER\s*1\b.*?$\n+", re.I | re.M)


def parse_letter_output(output):
    """Approved Agent Output → {address, document, delivery, notes}.

    Strict on purpose. A malformed block is a refusal, never a guess, because
    guessing here means guessing where a piece of paper gets posted.
    """
    text = TIER1_BANNER.sub("", output or "", count=1).strip()
    if not text:
        raise LetterFormatError("has an empty Agent Output")

    head, _, notes = text.partition("\n---")
    lines = [ln.rstrip() for ln in head.splitlines()]

    if not lines or lines[0].strip().upper() != "POST:":
        raise LetterFormatError(
            "does not start with a 'POST:' line. A postal letter declares its "
            "recipient address under POST:; an email uses TO:")

    address, document, delivery = [], None, "cheap"
    for ln in lines[1:]:
        s = ln.strip()
        if s.upper().startswith("DOCUMENT:"):
            document = s.split(":", 1)[1].strip()
        elif s.upper().startswith("DELIVERY:"):
            delivery = s.split(":", 1)[1].strip().lower()
        elif s:
            if document is not None:
                raise LetterFormatError(
                    f"has an address line {s!r} AFTER the DOCUMENT: line. "
                    "The whole address must sit directly under POST:")
            address.append(s)

    if len(address) < 3:
        raise LetterFormatError(
            f"has only {len(address)} address line(s) under POST:. A postal "
            "address needs at least a name, a street or office, and a postcode")
    if not document:
        raise LetterFormatError("has no 'DOCUMENT:' line naming the PDF to post")
    if delivery not in DELIVERY_PRODUCTS:
        raise LetterFormatError(
            f"has DELIVERY: {delivery!r}, which is not one of "
            f"{', '.join(DELIVERY_PRODUCTS)}")

    return {"address": address, "document": document,
            "delivery": delivery, "notes": notes.strip()}


def normalise_address(value):
    """Comparable form of an address: upper case, punctuation and spacing gone.

    Deliberately NOT fuzzy. An extra line is a mismatch, because an extra line
    is exactly what went wrong: the parsed address on two of the lost HMRC
    letters carried a leading "To:" that nothing compared against anything.
    """
    if isinstance(value, str):
        lines = value.splitlines()
    else:
        lines = list(value or [])
    out = []
    for ln in lines:
        s = ln.upper()
        # "&" and "AND" are the same word in an address, and a PDF may carry
        # either. Fold them together BEFORE punctuation is stripped, or
        # "HM Revenue & Customs" reads as a mismatch against "HM Revenue and
        # Customs" and a perfectly good letter is refused. A gate that cries
        # wolf is the gate people learn to bypass.
        s = s.replace("&", " AND ")
        s = re.sub(r"[^A-Z0-9 ]", " ", s)
        s = re.sub(r"\s+", " ", s).strip()
        if s:
            out.append(s)
    return out


def address_mismatch(declared, parsed):
    """Empty string when the two agree, otherwise a printable explanation."""
    a, b = normalise_address(declared), normalise_address(parsed)
    if a == b:
        return ""
    width = max([len(x) for x in a] + [len(x) for x in b] + [8])
    rows = ["         %-*s | %s" % (width, "DECLARED", "PINGEN READ FROM THE PDF"),
            "         %-*s-+-%s" % (width, "-" * width, "-" * 24)]
    for i in range(max(len(a), len(b))):
        left = a[i] if i < len(a) else ""
        right = b[i] if i < len(b) else ""
        flag = "  " if left == right else " <"
        rows.append("         %-*s | %s%s" % (width, left, right, flag))
    return "\n".join(rows)


# ─── Loading ─────────────────────────────────────────────────────────────

def load_document(path, task_id):
    real = os.path.realpath(os.path.expanduser(path))
    if not real.startswith(DOC_DIR + os.sep):
        sys.exit(f"REFUSED: task {task_id} DOCUMENT is outside the attachments "
                 f"directory ({DOC_DIR}). Letters are only ever posted from "
                 "there — put the PDF in it and reference that path.")
    if os.path.splitext(real)[1].lower() != ".pdf":
        sys.exit(f"REFUSED: task {task_id} DOCUMENT must be a PDF. Pingen "
                 "prints PDFs; anything else is a silent failure.")
    if not os.path.isfile(real):
        sys.exit(f"ERROR: task {task_id} DOCUMENT does not exist: "
                 f"{os.path.basename(real)}. It must exist at send time.")
    size = os.path.getsize(real)
    if size > DOC_MAX_BYTES:
        sys.exit(f"REFUSED: task {task_id} DOCUMENT is {size} bytes — over the "
                 f"{DOC_MAX_BYTES} cap.")
    return real, size


def load_approved(task_id, require_approval=True):
    rec = get_task(task_id)
    f = rec.get("fields", {})
    name = f.get(AF["name"], "(Untitled)")
    outcome = sel(f.get(AF["approvalOutcome"]))
    status = sel(f.get(AF["status"]))
    ttype = sel(f.get(AF["taskType"]))
    output = f.get(AF["agentOutput"], "") or ""

    if require_approval and outcome not in APPROVED:
        sys.exit(
            f"REFUSED: task {task_id} ({name}) is not approved.\n"
            f"         Approval Outcome = {outcome or '(empty)'}, "
            f"Status = {status or '(empty)'}.\n"
            "         Nothing is posted until Kevin approves it in Airtable "
            "or Slack.")
    if require_approval and ttype != "Correspondence":
        sys.exit(f"REFUSED: task {task_id} is Task Type {ttype or '(empty)'}, "
                 "not Correspondence. This script only posts Correspondence.")

    try:
        parsed = parse_letter_output(output)
    except LetterFormatError as exc:
        sys.exit(f"ERROR: task {task_id} {exc}. "
                 "See the format in this script's docstring.")
    parsed.update({"taskName": name, "outcome": outcome})
    return parsed


# ─── Ledger ──────────────────────────────────────────────────────────────

def ledger_rows(task_id):
    rows = []
    try:
        with open(SENT_LEDGER) as fh:
            for line in fh:
                if line.strip():
                    row = json.loads(line)
                    if row.get("task") == task_id:
                        rows.append(row)
    except FileNotFoundError:
        pass
    return rows


def ledger_append(row):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(SENT_LEDGER, "a") as fh:
        fh.write(json.dumps(row) + "\n")


def last_prepared(task_id):
    for row in reversed(ledger_rows(task_id)):
        if row.get("cmd") == "prepare" and row.get("letter"):
            return row
    return None


def already_sent(task_id):
    for row in ledger_rows(task_id):
        if row.get("cmd") == "send":
            return row
    return None


# ─── Upload ──────────────────────────────────────────────────────────────

def upload_pdf(real_path, token):
    slot = pingen("GET", "/file-upload", token)["data"]["attributes"]
    with open(real_path, "rb") as fh:
        body = fh.read()
    req = urllib.request.Request(slot["url"], data=body, method="PUT")
    req.add_header("Content-Type", "application/pdf")
    try:
        urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        sys.exit(f"ERROR: PDF upload {e.code}: {e.read().decode()[:300]}")
    return slot["url"], slot["url_signature"]


# ─── Commands ────────────────────────────────────────────────────────────

def cmd_health(args):
    token = pingen_token()
    org = org_id()
    d = pingen("GET", f"/organisations/{org}/letters?page[limit]=1", token)
    print(json.dumps({
        "auth": "ok",
        "organisation": org,
        "letters_visible": d.get("meta", {}).get("total"),
        "attachments_dir": DOC_DIR,
        "attachments_dir_exists": os.path.isdir(DOC_DIR),
    }, indent=2))


def cmd_preview(args):
    letter = load_approved(args.task, require_approval=False)
    real, size = load_document(letter["document"], args.task)
    print(json.dumps({
        "task": args.task,
        "taskName": letter["taskName"],
        "approvalOutcome": letter["outcome"] or "(not approved yet)",
        "address": letter["address"],
        "document": os.path.basename(real),
        "documentBytes": size,
        "delivery": letter["delivery"],
        "notes": letter["notes"],
    }, indent=2))
    print("\nPreview only. Nothing uploaded, nothing posted.")


def cmd_prepare(args):
    letter = load_approved(args.task, require_approval=False)
    real, size = load_document(letter["document"], args.task)
    token, org = pingen_token(), org_id()

    url, sig = upload_pdf(real, token)
    created = pingen("POST", f"/organisations/{org}/letters", token, {
        "data": {"type": "letters", "attributes": {
            "file_original_name": os.path.basename(real),
            "file_url": url,
            "file_url_signature": sig,
            "address_position": "left",
            "auto_send": False,
        }}})
    letter_id = created["data"]["id"]

    # Read the record back rather than trusting the create response: the
    # parsed address is what the printer will actually put on the envelope.
    rec = pingen("GET", f"/organisations/{org}/letters/{letter_id}", token)
    attrs = rec["data"]["attributes"]
    parsed = attrs.get("address") or ""
    mismatch = address_mismatch(letter["address"], parsed)

    ledger_append({"at": now_iso(), "cmd": "prepare", "task": args.task,
                   "letter": letter_id, "document": os.path.basename(real),
                   "bytes": size, "declared": letter["address"],
                   "parsed": parsed, "matched": not mismatch,
                   "delivery": letter["delivery"]})

    print(f"Uploaded to Pingen as letter {letter_id}. NOT posted.")
    print(f"  document : {os.path.basename(real)} ({attrs.get('file_pages')} page(s))")
    print(f"  delivery : {letter['delivery']}")
    print(f"  price    : {attrs.get('price_currency') or '?'} "
          f"{attrs.get('price_value') or '?'}")
    print(f"  status   : {attrs.get('status')}")
    if mismatch:
        print("\nADDRESS MISMATCH — this letter will NOT be allowed to post:\n")
        print(mismatch)
        print("\n         Fix the address block in the PDF so it sits in the\n"
              "         envelope window (first baseline 64mm from the top,\n"
              "         25mm from the left), then run prepare again.")
        sys.exit(2)
    if attrs.get("status") != PINGEN_OK_STATUS:
        print(f"\nPINGEN REJECTED THE LAYOUT — status {attrs.get('status')!r}, "
              f"not {PINGEN_OK_STATUS!r}.")
        print("         The address text read correctly, so this is placement,\n"
              "         not wording: the block sits outside the envelope\n"
              "         window. Move it to 64mm from the top, 25mm from the\n"
              "         left, then run prepare again.")
        sys.exit(2)
    print("\nAddress check PASSED. Pingen read exactly the address the task "
          "declared, and grades the letter 'valid'.")


def cmd_send(args):
    prior = already_sent(args.task)
    if prior:
        sys.exit(f"REFUSED: task {args.task} was already posted at "
                 f"{prior.get('at')} as letter {prior.get('letter')}. "
                 "A letter cannot be unposted; refusing to post it twice.")

    prep = last_prepared(args.task)
    if not prep:
        sys.exit(f"REFUSED: task {args.task} has not been prepared. Run\n"
                 f"         python3 scripts/send-letter.py prepare {args.task}\n"
                 "         first, so the address Pingen read can be checked "
                 "before anything is printed.")

    letter = load_approved(args.task, require_approval=True)
    token, org = pingen_token(), org_id()
    letter_id = prep["letter"]

    # Re-read the live record. The prepare ledger row is a note about the past;
    # this is the state the printer will act on.
    rec = pingen("GET", f"/organisations/{org}/letters/{letter_id}", token)
    attrs = rec["data"]["attributes"]
    mismatch = address_mismatch(letter["address"], attrs.get("address") or "")
    if mismatch:
        print("REFUSED: the address Pingen read does not match the approved "
              "task.\n")
        print(mismatch)
        sys.exit(2)
    # Both gates again, against the LIVE record rather than the prepare ledger
    # row. A letter graded anything but "valid" cannot post even when the
    # address text is word-perfect — measured, see PINGEN_OK_STATUS.
    if attrs.get("status") != PINGEN_OK_STATUS:
        sys.exit(f"REFUSED: letter {letter_id} is at status "
                 f"{attrs.get('status')!r}, not {PINGEN_OK_STATUS!r}. Either it "
                 "has already been sent, or Pingen will not accept its layout. "
                 f"Run prepare again to see which.")

    pingen("PATCH", f"/organisations/{org}/letters/{letter_id}/send", token, {
        "data": {"id": letter_id, "type": "letters", "attributes": {
            "delivery_product": letter["delivery"],
            "print_mode": "simplex",
            "print_spectrum": "grayscale",
        }}})

    after = pingen("GET", f"/organisations/{org}/letters/{letter_id}", token)
    a2 = after["data"]["attributes"]
    ledger_append({"at": now_iso(), "cmd": "send", "task": args.task,
                   "letter": letter_id, "taskName": letter["taskName"],
                   "outcome": letter["outcome"], "address": letter["address"],
                   "delivery": letter["delivery"], "status": a2.get("status"),
                   "price": f"{a2.get('price_currency')} {a2.get('price_value')}"})
    print(f"Posted. Letter {letter_id} is now {a2.get('status')}.")
    print(f"  to     : {'; '.join(letter['address'])}")
    print(f"  cost   : {a2.get('price_currency')} {a2.get('price_value')}")
    print(f"  ledger : {SENT_LEDGER}")


def cmd_selftest(args):
    """Offline checks. Never touches Pingen, Airtable, or the network."""
    cases = []

    def check(name, fn):
        try:
            cases.append((name, bool(fn())))
        except Exception:
            cases.append((name, False))

    good = ("POST:\nCorporation Tax\nHM Revenue and Customs\nBX9 1AX\n"
            "United Kingdom\nDOCUMENT: ~/knowledge-os/attachments/a.pdf\n"
            "DELIVERY: fast\n---\nnotes here")
    check("parses a well-formed letter",
          lambda: parse_letter_output(good)["address"][0] == "Corporation Tax")
    check("reads DELIVERY",
          lambda: parse_letter_output(good)["delivery"] == "fast")
    check("defaults DELIVERY to cheap",
          lambda: parse_letter_output(good.replace("DELIVERY: fast\n", ""))
          ["delivery"] == "cheap")
    check("notes are not part of the address",
          lambda: "notes here" not in parse_letter_output(good)["address"])

    def refuses(text, why):
        try:
            parse_letter_output(text)
            return False
        except LetterFormatError:
            return True

    check("refuses an email TO: block",
          lambda: refuses(good.replace("POST:", "TO:"), "email"))
    check("refuses a missing DOCUMENT",
          lambda: refuses(good.replace(
              "DOCUMENT: ~/knowledge-os/attachments/a.pdf\n", ""), "no doc"))
    check("refuses a two-line address",
          lambda: refuses("POST:\nA\nB\nDOCUMENT: x.pdf", "too short"))
    check("refuses an unknown delivery product",
          lambda: refuses(good.replace("DELIVERY: fast", "DELIVERY: pigeon"),
                          "bad product"))
    check("refuses an address line after DOCUMENT",
          lambda: refuses(good.replace("DELIVERY: fast", "Stray Line"), "stray"))

    # The regression the whole script exists for.
    declared = ["Self Assessment", "HM Revenue and Customs", "BX9 1AS",
                "United Kingdom"]
    check("HMRC 'To:' defect is caught",
          lambda: bool(address_mismatch(
              declared, "To:\nSelf Assessment\nHM Revenue and Customs\n"
                        "BX9 1AS\nUnited Kingdom")))
    check("a clean address matches",
          lambda: not address_mismatch(
              declared, "Self Assessment\nHM Revenue and Customs\nBX9 1AS\n"
                        "United Kingdom"))
    check("case and spacing differences still match",
          lambda: not address_mismatch(
              declared, "SELF  ASSESSMENT\nHM Revenue & Customs\nBX9  1AS\n"
                        "United Kingdom"))
    check("a wrong postcode is caught",
          lambda: bool(address_mismatch(
              declared, "Self Assessment\nHM Revenue and Customs\nBX9 1AX\n"
                        "United Kingdom")))
    check("a reference line read as an address is caught",
          lambda: bool(address_mismatch(
              declared, "Reference: 623 C 8402124449 Re: BriEain Holdings "
                        "Limited")))

    for name, ok in cases:
        print(("PASS " if ok else "FAIL ") + name)
    failed = [n for n, ok in cases if not ok]
    if failed:
        sys.exit(f"selftest FAILED: {', '.join(failed)}")
    print(f"\n{len(cases)} checks passed.")


def main():
    p = argparse.ArgumentParser(
        description="Post an approved letter via Pingen.",
        epilog="There is no --force. The only source of a letter is an "
               "approved Correspondence task.")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, help_text in (
            ("preview", "parse and print an approved task, never uploads"),
            ("prepare", "upload without posting and check the parsed address"),
            ("send", "post a prepared, approved letter")):
        s = sub.add_parser(name, help=help_text)
        s.add_argument("task", help="Airtable task record id (recXXXXXXXXXXXXXX)")
    sub.add_parser("health", help="Pingen reachability and organisation check")
    sub.add_parser("selftest", help="offline parser checks, never posts")

    args = p.parse_args()
    if getattr(args, "task", None) and not re.fullmatch(r"rec[A-Za-z0-9]{14}",
                                                        args.task):
        sys.exit(f"ERROR: {args.task!r} is not an Airtable record id")
    {"preview": cmd_preview, "prepare": cmd_prepare, "send": cmd_send,
     "health": cmd_health, "selftest": cmd_selftest}[args.cmd](args)


if __name__ == "__main__":
    main()
