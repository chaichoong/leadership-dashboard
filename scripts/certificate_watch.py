#!/usr/bin/env python3
"""certificate_watch.py — the rules that stop a certificate being paid for and
never filed, or bought twice. Pure functions: no network, no files.

WHY THIS EXISTS (Kevin, 2 Oct 2026). Two certificates had been done and paid for
but were missing from the compliance book:

  * a gas safety record arrived by email on 16 Sep, on a task named for its
    INVOICE. The agent checked the payment three times, wrote "no certificate
    filed" in its own output, and closed the task. The filing gate only looked
    at engine-raised renewal tasks.
  * an electrical report arrived on 24 Aug and Inbox Triage filed the email
    under a label with no task, by a rule written before the Property
    Administration agent existed. The book later got a row with a 753-byte
    placeholder instead of the report, and a placeholder counted as a document.

The book showed "missing" for 18 days after a paid visit and nothing in the code
would have stopped a second purchase. Kevin: "We cannot miss these things
because it's going to result in duplication of payments, so we need to ensure
this is watertight."

Four rules, each used by one caller:

  1. names_certificate()         scripts/inbound-triage.py refuses to file
                                 certificate mail with no task.
  2. certificate_owed()          agent-dispatch.py `complete` refuses to close a
                                 task that received a certificate until it is
                                 filed, whatever the task is called.
  3. paid_without_certificate()  the daily score step raises a filing task for
                                 any compliance payment with no document filed.
  4. purchase_block()            agent-dispatch.py `submit` refuses a quote or a
                                 booking when the certificate is already held or
                                 already paid for.

plus is_placeholder(): a stand-in file is not a document.

Everything here takes plain dicts so tests/certificate-watch.test.js can drive
the real functions through `python3 scripts/certificate_watch.py selftest` and a
JSON `run` command.
"""

import json
import re
import sys
from datetime import date, datetime, timedelta

# A real certificate scan or PDF is tens of kilobytes at the very least. The four
# stand-ins found on 2 Oct 2026 were 722 to 753 bytes and named ...PLACEHOLDER.pdf.
PLACEHOLDER_MAX_BYTES = 2048
PLACEHOLDER_NAME_RE = re.compile(r"placeholder|dummy|to[-_ ]?follow|tbc", re.I)

# Words that mean "a compliance document is in this email or on this task".
# Deliberately the DOCUMENT words, not "gas" or "electrical" on their own: a quote
# request or a repair report mentions gas without carrying a certificate. And never
# the bare word "certificate": an SSL certificate, a certificate of posting and a
# death certificate are not compliance documents, and every false hit costs an
# agent a refused close.
CERT_DOC_RE = re.compile(
    # Letter boundaries, not \b: "EICR_Ref12903492" is how the 24 Aug report was named.
    r"(?<![A-Za-z])LGSR(?![A-Za-z])|\bCP\s?12\b|gas safe(?:ty)? (?:record|certificate|cert)\b|landlord gas\b|"
    r"(?<![A-Za-z])EICR(?![A-Za-z])|electrical installation condition|electrical (?:safety )?(?:certificate|report)|"
    r"(?<![A-Za-z])EPC(?![A-Za-z])|energy performance certificate|fire (?:alarm|risk|safety) (?:certificate|assessment|report)|"
    r"emergency lighting certificate|\bHMO licen[cs]e\b|"
    r"(?:policy|insurance) (?:schedule|certificate|documents?)|certificate of insurance|"
    r"gas safety (?:check|inspection)|CERTIFICATE ATTACHED",
    re.I)

# The words Inbox Triage writes at the top of a task whose email carried a
# certificate (Step 4c). Its twin, "CERTIFICATE MENTIONED, NO ATTACHMENT", must
# never read as a file having arrived.
ARRIVED_MARK_RE = re.compile(r"CERTIFICATE ATTACHED")
INBOUND_FILE_RE = re.compile(r"knowledge-os/attachments/inbound")

# Which book types a certificate word maps to. Used to decide whether "a gas
# quote" is blocked by a gas record that is already held.
TYPE_WORDS = (
    ("GSC", re.compile(r"\bGSC\b|\bLGSR\b|\bCP\s?12\b|gas safe|landlord gas|\bgas\b", re.I)),
    ("EICR", re.compile(r"\bEICR\b|electrical", re.I)),
    ("EPC", re.compile(r"\bEPC\b|energy performance", re.I)),
    ("Landlord Insurance", re.compile(r"insurance", re.I)),
)

# A payment counts as answered by a certificate row created from this many days
# BEFORE the payment (the certificate usually arrives with the invoice, and the
# invoice is paid a week or two later) up to today.
FILED_BEFORE_PAYMENT_DAYS = 45
# How far back the daily check looks. Long enough to catch a payment made while
# the agent was paused, short enough that last year's visit is not re-raised.
PAYMENT_LOOKBACK_DAYS = 120
# A quote or booking is refused while the held certificate has more than this
# long to run. Inside it, a renewal is the right thing to be buying.
HELD_MIN_DAYS_LEFT = 60


def _day(value):
    """A date from 'YYYY-MM-DD...' or a date, or None."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return datetime.strptime(str(value or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def is_placeholder(attachment):
    """True when an Airtable attachment is a stand-in, not a document."""
    name = str((attachment or {}).get("filename") or "")
    size = (attachment or {}).get("size")
    if PLACEHOLDER_NAME_RE.search(name):
        return True
    return isinstance(size, (int, float)) and size < PLACEHOLDER_MAX_BYTES


def has_real_file(attachments):
    """True when at least one attachment is a real document."""
    return any(not is_placeholder(a) for a in (attachments or []))


def names_certificate(text):
    """True when the text says a compliance document is present."""
    return bool(CERT_DOC_RE.search(str(text or "")))


def cert_types_named(text):
    """The book types a piece of text is about, in a fixed order."""
    return [label for label, rx in TYPE_WORDS if rx.search(str(text or ""))]


def certificate_owed(task, linked_certificates):
    """Why a task may not close yet, or "".

    task: {"name", "description", "attachments": [..], "notes"}
    linked_certificates: the book rows already linked to this task, each
    {"hasFile": bool}.

    A task owes a filing when it NAMES a certificate document and a file ARRIVED
    on it. "Arrived" is one of three hard signals, never the word "attached" in
    free text (a reply that says "your policy documents are attached", or a
    tenant pack that SENDS an EPC, would otherwise be refused):
      * triage's own marker, CERTIFICATE ATTACHED;
      * a saved inbound attachment path in the description or notes;
      * a file on the task AND the certificate named in the task's NAME (the
        16 Sep shape: "process LGSR invoice" with the scan attached).
    It is settled by a linked book row holding a real file, or by a declared
    reason (see NO_CERTIFICATE_MARK), which is written to the task so the
    decision is on record rather than silent.
    """
    text = "%s\n%s" % (task.get("name") or "", task.get("description") or "")
    if not names_certificate(text):
        return ""
    everything = "%s\n%s" % (text, task.get("notes") or "")
    arrived = (bool(ARRIVED_MARK_RE.search(text))
               or bool(INBOUND_FILE_RE.search(everything))
               or (bool(task.get("attachments")) and names_certificate(task.get("name"))))
    if not arrived:
        return ""
    if any(c.get("hasFile") for c in (linked_certificates or [])):
        return ""
    if NO_CERTIFICATE_MARK in str(task.get("notes") or ""):
        return ""
    return ("this task names a certificate and a file arrived on it, but no certificate "
            "(with its document) is filed against it")


# Written into a task's Notes by `complete --no-certificate "<reason>"`.
NO_CERTIFICATE_MARK = "NO CERTIFICATE TO FILE:"


def paid_without_certificate(payments, certificates, today,
                             lookback_days=PAYMENT_LOOKBACK_DAYS,
                             before_days=FILED_BEFORE_PAYMENT_DAYS, resolved_ids=()):
    """(unfiled, unplaced): compliance payments with no certificate filed.

    payments:     [{"id", "date", "amount", "name", "propertyIds": [..], "costIds": [..]}]
                  money out is a NEGATIVE amount, as the bank records it.
    certificates: [{"propertyIds": [..], "hasFile": bool, "created": "YYYY-MM-DD"}]

    unfiled  = a one-off payment for a known property, with no book row holding a
               real file for that property created since `before_days` before it.
    unplaced = a one-off payment with no property on it, so it cannot be checked.
               Listed, never dropped: a check that silently skips what it cannot
               place reads as "all filed".

    A payment linked to a cost record is a recurring fixed cost (a licence paid by
    instalment), not a visit that produces a certificate, and is left out.

    resolved_ids: transactions an agent has already answered on the record (the
    filing task closed with "no certificate to file: it was a repair"). Without
    this a resolved payment would block every purchase for that house for months.

    When the bank text names a certificate type ("EICR", "gas"), only that type
    answers it: an EPC does not answer a gas visit. When it names none, any
    certificate for the property does.
    """
    today = _day(today)
    since = today - timedelta(days=lookback_days)
    unfiled, unplaced = [], []
    resolved = set(resolved_ids or ())
    for p in payments or []:
        paid = _day(p.get("date"))
        if not paid or paid < since or paid > today or p.get("id") in resolved:
            continue
        if (p.get("amount") or 0) >= 0 or p.get("costIds"):
            continue
        props = p.get("propertyIds") or []
        if not props:
            unplaced.append(p)
            continue
        earliest = paid - timedelta(days=before_days)
        wanted = cert_types_named(p.get("name"))
        filed = any(
            c.get("hasFile") and set(c.get("propertyIds") or []) & set(props)
            and (_day(c.get("created")) or date.min) >= earliest
            and (not wanted or c.get("type") in wanted)
            for c in certificates or [])
        if not filed:
            unfiled.append(p)
    return unfiled, unplaced


def purchase_block(property_id, cert_type, certificates, unfiled_payments, today,
                   min_days_left=HELD_MIN_DAYS_LEFT):
    """Why a quote or booking for this certificate must not go out, or "".

    Two reasons, either is enough:
      * the book already holds this certificate for the property, with a real
        file, in date for more than `min_days_left` days;
      * a compliance payment for the property is sitting with no certificate
        filed, so the visit may already have happened. File that first.
    """
    today = _day(today)
    rows = [c for c in certificates or []
            if property_id in (c.get("propertyIds") or []) and c.get("type") == cert_type]
    # A block holds this certificate PER APARTMENT: one flat's in-date report says
    # nothing about the flat next door, so "already held" is never judged there.
    # (Review, 2 Oct 2026: nine unit-level reports, eight due, one in date, and
    # every renewal in the block would have been refused.)
    if rows and not any(c.get("unitIds") for c in rows):
        dated = [c for c in rows if _day(c.get("renewalDate"))]
        newest = max(dated, key=lambda c: _day(c["renewalDate"])) if dated else None
        if newest and newest.get("hasFile") \
                and (_day(newest["renewalDate"]) - today).days > min_days_left \
                and str(newest.get("status") or "").strip().lower() != "expired":
            return ("the book already holds this certificate, in date to %s. "
                    "Nothing needs buying." % _day(newest["renewalDate"]).isoformat())
    for p in unfiled_payments or []:
        if property_id in (p.get("propertyIds") or []):
            return ("a compliance payment for this property (%s, £%.2f, %s) has no "
                    "certificate filed against it. The visit may already have been done: "
                    "find and file that certificate before asking for a quote or a booking."
                    % (str(p.get("date"))[:10], abs(p.get("amount") or 0), str(p.get("name") or "")[:60]))
    return ""


# ── selftest and a JSON door for the vitest suite ────────────────────────────

def selftest():
    T = date(2026, 10, 2)
    checks = []

    def check(label, ok):
        checks.append((label, bool(ok)))

    check("a 753-byte file is a placeholder", is_placeholder({"filename": "x.pdf", "size": 753}))
    check("a PLACEHOLDER name is a placeholder at any size",
          is_placeholder({"filename": "42-HMO-Cert-PLACEHOLDER.pdf", "size": 900000}))
    check("a real scan is not a placeholder", not is_placeholder({"filename": "gsc.jpeg", "size": 184000}))
    check("a row with only a placeholder has no real file",
          not has_real_file([{"filename": "a-PLACEHOLDER.pdf", "size": 731}]))

    check("LGSR names a certificate", names_certificate("Fwd: LGSR for the house"))
    check("EICR reference names a certificate", names_certificate("Road - EICR_Ref12903492 2"))
    check("a gas quote request does not name a certificate", not names_certificate("Quote for a gas boiler repair"))
    check("a certificate of posting is not a compliance document", not names_certificate("Certificate of posting attached"))
    check("an insurance schedule names a certificate", names_certificate("Your policy schedule is attached"))

    invoice_task = {"name": "INBOUND: process LGSR invoice", "description": "Gas safety record attached.",
                    "attachments": [{"filename": "house.jpeg", "size": 200000}], "notes": ""}
    check("the 16 Sep shape: an invoice task that received a certificate owes a filing",
          certificate_owed(invoice_task, []) != "")
    check("a linked row with a real file settles it", certificate_owed(invoice_task, [{"hasFile": True}]) == "")
    check("a linked row with only a placeholder does not", certificate_owed(invoice_task, [{"hasFile": False}]) != "")
    check("a declared reason settles it",
          certificate_owed(dict(invoice_task, notes="x\n%s it is a quote, not a certificate" % NO_CERTIFICATE_MARK), []) == "")
    check("a task with no file arrived owes nothing",
          certificate_owed({"name": "Chase the EICR", "description": "Ask Roy for dates.", "attachments": []}, []) == "")
    check("the triage marker alone is enough",
          certificate_owed({"name": "INBOUND: pay invoice 1042 - heating engineer",
                            "description": "CERTIFICATE ATTACHED. Invoice for the annual gas safety check.",
                            "attachments": []}, []) != "")
    check("CERTIFICATE MENTIONED, NO ATTACHMENT owes nothing",
          certificate_owed({"name": "COMPLIANCE: file certificate - EICR - house",
                            "description": "CERTIFICATE MENTIONED, NO ATTACHMENT. Roy says the EICR was done.",
                            "attachments": []}, []) == "")
    check("a reply that says documents are attached owes nothing",
          certificate_owed({"name": "INBOUND: reply to the car insurer",
                            "description": "Your policy documents are attached.",
                            "attachments": [{"filename": "reply.pdf"}]}, []) == "")
    check("a tenant pack that SENDS an EPC owes nothing",
          certificate_owed({"name": "New tenant pack for the house",
                            "description": "Send the EPC and gas safety certificate attached.",
                            "attachments": [{"filename": "epc.pdf"}]}, []) == "")
    check("a saved inbound file on a certificate task owes a filing",
          certificate_owed({"name": "INBOUND: Roy forwarded paperwork", "description": "EICR report.",
                            "notes": "saved to ~/knowledge-os/attachments/inbound/abc/report.pdf",
                            "attachments": []}, []) != "")
    check("a task that names no certificate owes nothing",
          certificate_owed({"name": "Boiler repair", "description": "Photo attached.",
                            "attachments": [{"filename": "p.jpg", "size": 90000}]}, []) == "")

    pay = lambda **kw: dict({"id": "tx", "date": "2026-09-21", "amount": -90.0, "name": "Gas visit",  # noqa: E731
                             "propertyIds": ["pA"], "costIds": []}, **kw)
    cert = lambda **kw: dict({"propertyIds": ["pA"], "type": "GSC", "hasFile": True,  # noqa: E731
                              "created": "2026-09-16", "renewalDate": "2027-09-14", "status": "Active"}, **kw)
    unfiled, unplaced = paid_without_certificate([pay()], [], T)
    check("the 21 Sep shape: paid, nothing filed", len(unfiled) == 1 and not unplaced)
    check("a certificate filed around the payment answers it",
          paid_without_certificate([pay()], [cert()], T) == ([], []))
    check("a placeholder row does not answer it",
          len(paid_without_certificate([pay()], [cert(hasFile=False)], T)[0]) == 1)
    check("last year's certificate does not answer this year's payment",
          len(paid_without_certificate([pay()], [cert(created="2025-09-10")], T)[0]) == 1)
    check("another property's certificate does not answer it",
          len(paid_without_certificate([pay()], [cert(propertyIds=["pB"])], T)[0]) == 1)
    check("a recurring cost-linked payment is left out",
          paid_without_certificate([pay(costIds=["c1"])], [], T) == ([], []))
    check("a payment with no property is listed, not dropped",
          len(paid_without_certificate([pay(propertyIds=[])], [], T)[1]) == 1)
    check("a payment older than the lookback is not re-raised",
          paid_without_certificate([pay(date="2026-01-09")], [], T) == ([], []))
    check("money in is not a payment", paid_without_certificate([pay(amount=90.0)], [], T) == ([], []))
    check("a payment already answered on the record is not raised or held against the house",
          paid_without_certificate([pay()], [], T, resolved_ids=["tx"]) == ([], []))
    check("an EPC does not answer a payment whose bank text says gas",
          len(paid_without_certificate([pay(name="Gas safety visit")], [cert(type="EPC")], T)[0]) == 1)
    check("a gas record answers a payment whose bank text says gas",
          paid_without_certificate([pay(name="Gas safety visit")], [cert()], T) == ([], []))

    check("a held, in-date certificate blocks a quote", purchase_block("pA", "GSC", [cert()], [], T) != "")
    check("a certificate inside its renewal window does not block",
          purchase_block("pA", "GSC", [cert(renewalDate="2026-10-20")], [], T) == "")
    check("a placeholder row does not block", purchase_block("pA", "GSC", [cert(hasFile=False)], [], T) == "")
    check("another type does not block", purchase_block("pA", "EICR", [cert()], [], T) == "")
    check("a block's per-apartment reports never read as already held",
          purchase_block("pA", "EICR", [cert(type="EICR", unitIds=["u1"]),
                                        cert(type="EICR", unitIds=["u2"], renewalDate="2026-10-10")], [], T) == "")
    check("an older in-date row does not block when the newest row has lapsed",
          purchase_block("pA", "GSC", [cert(renewalDate="2027-01-01", status="Expired"),
                                       cert(renewalDate="2026-06-01")], [], T) == "")
    check("an unfiled payment for the property blocks", purchase_block("pA", "EICR", [], [pay()], T) != "")
    check("an unfiled payment for another property does not",
          purchase_block("pB", "EICR", [], [pay()], T) == "")

    failed = [label for label, ok in checks if not ok]
    for label, ok in checks:
        print("%s %s" % ("ok  " if ok else "FAIL", label))
    if failed:
        sys.exit("certificate_watch selftest: %d of %d FAILED" % (len(failed), len(checks)))
    print("certificate_watch selftest: %d checks passed" % len(checks))


def main(argv):
    if argv[:1] == ["selftest"]:
        return selftest()
    if argv[:1] == ["run"] and len(argv) == 2:
        # {"fn": "...", "args": {...}} on the command line, the result as JSON on
        # stdout. Lets the JS test suite drive the real functions.
        call = json.loads(argv[1])
        fn = {"is_placeholder": is_placeholder, "has_real_file": has_real_file,
              "names_certificate": names_certificate, "certificate_owed": certificate_owed,
              "paid_without_certificate": paid_without_certificate,
              "purchase_block": purchase_block, "cert_types_named": cert_types_named}.get(call.get("fn"))
        if not fn:
            sys.exit("unknown function %r" % call.get("fn"))
        print(json.dumps(fn(**call.get("args", {}))))
        return None
    sys.exit("usage: certificate_watch.py selftest | run '<json>'")


if __name__ == "__main__":
    main(sys.argv[1:])
