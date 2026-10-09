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

THE DAILY PASS (Kevin, 7 Oct 2026). The compliance book held 20 lapsed
certificates and 40 required items with no record at all, and many of them had
no open task anywhere, so nothing was ever going to happen to them. Three
insurance policies renewed with no replacement quote. The rules for that are
pure functions below (missed_items, task_covers, insurance_actions,
premium_rises); `python3 scripts/certificate_watch.py daily [--apply]` is the
ONE place in this file that reads Airtable. It reads the book through
agent-dispatch.py (the same book the score, the Property Compliance page and
the tenant chain read), and raises its tasks only through
scripts/create-agent-task.py, the duplicate gate. Without --apply it writes
nothing. Tested by tests/compliance-watch.test.js.
"""

import json
import os
import re
import subprocess
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
    if FILING_TASK_MARK not in text:
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
    if FILING_TASK_MARK in text:
        return ("this task was raised because a compliance payment has no certificate in the "
                "book, and no certificate (with its document) is filed against it")
    return ("this task names a certificate and a file arrived on it, but no certificate "
            "(with its document) is filed against it")


# Stamped into the description of every filing task the engine raises for a paid
# compliance line. Such a task always owes its filing: its own wording ("file the
# certificate paid for on ...") names no document type, and without this it could
# close as "nothing to decide", leaving the payment raised for ever and held against
# the house (second review, 2 Oct 2026).
FILING_TASK_MARK = "filing raised automatically by agent-dispatch"

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


# ── NO MISSED ITEM WITHOUT A TASK (Kevin, 7 Oct 2026) ────────────────────────
#
# The book is agent-dispatch.py's compliance_pages(): one page per property with
# its `issues`, each {type, state, renewalDate?, unit?, unitName?}. Its state is
# item_state() there, which is what makes the 10 rows that read "Active" with a
# past renewal date count as expired: the DATE decides, and the Status field can
# only make an item worse ("Expired" stays expired), never better. Nothing in the
# estate writes "Expired" back to a row, so nothing here does either.

# The book's states that mean "no in-date certificate on file today".
MISSED_STATES = ("expired", "no date", "missing")
STATE_WORD = {"expired": "expired", "no date": "undated", "missing": "missing"}

# Machine keys this file writes into the Description of every task it raises.
# The exists-check reads them back (a task folded by the duplicate gate keeps the
# key in its Description, so the matter is never raised twice), and the
# insurance checkpoints use them as the record that a checkpoint already fired.
#
# Letters, digits, hyphens and spaces ONLY. Description is a rich text field: the
# API hands back an underscore as "\_" and an asterisk as "\*" (read across the
# open board on 7 Oct 2026: 287 escaped underscores, 13 asterisks, nothing else),
# so a key with either would never read back and every check below would miss.
# _task_view also removes markdown escapes before any key is matched. No type
# name is a prefix of another and record ids are a fixed length, so no key is a
# prefix of another key.
MISSED_KEY = "CERTWATCH-MISSED %s %s"            # property id, type
INSURANCE_KEY = "CERTWATCH-INSURANCE %s %s %s"   # property id, renewal date, checkpoint
PREMIUM_KEY = "CERTWATCH-PREMIUM %s"             # the new policy's book row id
KEY_PREFIX = "CERTWATCH-"
MARKDOWN_ESCAPE_RE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!|>~])")


def plain_text(text):
    """A rich text value as the words a person typed: markdown escapes removed."""
    return MARKDOWN_ESCAPE_RE.sub(r"\1", str(text or ""))

# A missed-item task that was CLOSED with the item still missing is not re-raised
# for this many days. Without it a task Kevin closed as "not ours" (28 Sep 2026:
# "managed by <the letting agent>, we don't need to worry about this, close it")
# comes back every morning. Every held-back item is still listed in the run's
# output, so it is late, never silent.
CLOSED_COOL_OFF_DAYS = 14

# Insurance (Kevin, 7 Oct 2026: three policies renewed with no replacement quote).
# Two checkpoints before the renewal date, then the renewal itself. The first
# falls on the same day as agent-dispatch.py's own 30-day renewal trigger, and its
# task carries the EXACT name that trigger gives its own (ENGINE_RENEWAL_NAME), so
# whichever runs first, the other finds it: the trigger's belt skips a name it
# finds among the COMPLIANCE: tasks of the last 60 days, and the watch's
# exists-check below finds the trigger's task.
INSURANCE_FIRST_CHECK_DAYS = 30
INSURANCE_SECOND_CHECK_DAYS = 14
ENGINE_RENEWAL_NAME = "COMPLIANCE: %s renewal due %s - %s"   # agent-dispatch.py ensure_renewal_tasks
# agent-dispatch.py ENGINE_RENEWAL_MARK, word for word: its verify step refuses to
# let a task carrying it close with no certificate filed. tests/compliance-watch
# .test.js reads the real constant and fails if the two ever differ.
ENGINE_RENEWAL_MARK = "renewal raised automatically by agent-dispatch"
# A renewal that passed this recently with nothing open is the 14-day window in
# which a renewed policy can usually still be cancelled without a charge.
RENEWAL_PASSED_DAYS = 14
PREMIUM_RISE_LIMIT = 0.10

# The step only Kevin can take, in the exact shape scripts/agent-dispatch.py
# kevin_only_step() reads (KEVIN_ONLY_LINE_RE, reason "purchase").
KEVIN_PURCHASE_LINE = ("KEVIN ONLY: purchase: buy the chosen replacement policy through "
                       "TopCashback in one unbroken session, paying by monthly instalments")
INSURANCE_RULE = (
    "Kevin's rules for every landlord insurance quote (25 and 30 Sep 2026): source it through "
    "TopCashback and never renew the existing policy; on every form choose EMAIL ONLY for contact "
    "and marketing, never telephone, calls, SMS or text; choose monthly instalments, never a single "
    "payment; never answer the declarations (criminal charges, bankruptcy, CCJs, voided or cancelled "
    "policies): stop on that page; the cashback is only paid when the quote is bought in the same "
    "browser session it was clicked through to, so a saved quote is not bought later.")

# Which words in a task NAME say it is about a certificate type. STRONG words
# count anywhere: they name the certificate itself, so a repair task cannot hit
# them by accident ("gas engineer's note", "kitchen electrics", "fire alarm still
# beeping" are repairs, not certificates). LANE words count only in a name that
# opens COMPLIANCE: or INSURANCE:, where a bare "gas" or "electrical" can only
# mean the certificate. The book's own type name counts there too, because the
# renewal engine writes it into every task it raises.
COVER_STRONG = {
    # "Gas safety" is the certificate; "a Gas Safe engineer" is who does any gas
    # job, a boiler repair included, so it is not.
    "GSC": r"\bGSC\b|(?<![A-Za-z])LGSR(?![A-Za-z])|\bCP\s?12\b|\bgas safety\b|"
           r"\bgas safe (?:cert\w*|record|check|inspection)|landlord gas|\bgas (?:cert\w*|check|inspection)",
    "EICR": r"(?<![A-Za-z])EICR(?![A-Za-z])|electrical (?:installation|inspection|safety|condition|"
            r"cert\w*|report|test\w*)|periodic inspection",
    "EPC": r"(?<![A-Za-z])EPC(?![A-Za-z])|energy performance",
    "Landlord Insurance": r"\binsur(?:ance|er|ers|ed)\b|landlord (?:buildings )?cover|property owners",
    "HMO Cert": r"\bHMO licen[cs]\w*|\b(?:selective|additional|mandatory) licen[cs]\w*|\bHMO cert\w*|"
                r"\blicen[cs]e application",
    "Fire Alarm Cert": r"fire alarm (?:cert\w*|inspection|test\w*|servic\w*)|"
                       r"fire (?:safety|risk) (?:cert\w*|assessment|inspection|report)|\bFRA\b|\bBS ?5839",
    "Emergency Lighting": r"emergency light\w* (?:cert\w*|test\w*|inspection|servic\w*)|\bBS ?5266",
    # Portable appliance test (7 Oct 2026). Never the bare letters outside a compliance
    # name: here "PAT" is also the Airtable access token. Capitals only: "Pat" is a name.
    "PAT": r"portable appliance|(?-i:\bPAT\b) (?:test\w*|cert\w*|report)",
}
COVER_LANE = {
    "GSC": r"\bgas\b",
    "EICR": r"\belectric\w*",
    "EPC": r"\benergy\b",
    "Landlord Insurance": r"\bpolicy\b|\bcover\b",
    "HMO Cert": r"\blicen[cs]\w*",
    "Fire Alarm Cert": r"\bfire alarm|\bfire safety|\bfire cert\w*",
    "Emergency Lighting": r"\bemergency light\w*",
    "PAT": r"(?-i:\bPAT\b)",
}
# The type's own name, as the lane matches it. Only PAT needs its own: its letters sit
# inside "path" and "patio", and in lower case it is a first name.
LANE_TYPE_NAME = {"PAT": r"(?-i:\bPAT\b)"}
_STRONG_RE = {t: re.compile(rx, re.I) for t, rx in COVER_STRONG.items()}
_LANE_RE = {t: re.compile(rx + "|" + LANE_TYPE_NAME.get(t, re.escape(t)), re.I) for t, rx in COVER_LANE.items()}
LANE_NAME_RE = re.compile(r"^\s*(?:PROPERTY\s+)?(?:COMPLIANCE|INSURANCE)\b", re.I)
# Insurance that is not the landlord buildings policy: a claim on it, rent
# guarantee cover, or someone's car. None of these is the house's insurance.
# A claim, not "no claims" or the claims history a quote form asks for.
NOT_LANDLORD_INSURANCE_RE = re.compile(
    r"\binsurance claims?\b(?!\s+history)|\bclaims?\s+(?:for|on|against|form|number|ref\w*)\b|"
    r"\bmake a claim\b|\bclaiming\b|"
    r"rent guarantee|"
    r"\b(?:car|van|vehicle|motor|life|travel|pet|health|medical|dental|phone|gadget)\s+insurance|"
    r"income protection", re.I)
# Q4 plan sentences: which type a sentence is about.
PLAN_TYPE_WORDS = (
    ("GSC", re.compile(r"\bgas\b|\bGSC\b", re.I)),
    ("EICR", re.compile(r"\belectric\w*|\bEICR\b", re.I)),
    ("EPC", re.compile(r"\bEPC\b|energy performance", re.I)),
    ("Landlord Insurance", re.compile(r"\binsur\w*", re.I)),
    ("HMO Cert", re.compile(r"\blicen[cs]\w*", re.I)),
    ("Fire Alarm Cert", re.compile(r"\bfire alarm", re.I)),
)
PREMIUM_RE = re.compile(r"\bpremium\b[^£\n]{0,30}£\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)", re.I)
# A monthly figure, said after the amount ("£34.50 pcm", "£51.80 a month",
# "/m", "p/m", "monthly", "per calendar month") or before "premium" ("monthly
# premium £x"). Anything else is read as the year's premium.
MONTHLY_AFTER_RE = re.compile(
    r"^\s*(?:pcm\b|p/?m\b|/\s*m(?:o|th|onth)?\b|monthly\b|mthly\b|"
    r"(?:a|an|per|each|every)\s+(?:calendar\s+)?(?:month|mth|mo)\b)", re.I)
MONTHLY_BEFORE_RE = re.compile(r"\bmonthly\s+$", re.I)


def type_named(name, cert_type):
    """True when a task NAME says it is about this certificate type."""
    name = str(name or "")
    if cert_type == "Landlord Insurance" and NOT_LANDLORD_INSURANCE_RE.search(name):
        return False
    if cert_type in _STRONG_RE and _STRONG_RE[cert_type].search(name):
        return True
    return bool(LANE_NAME_RE.search(name) and cert_type in _LANE_RE
                and _LANE_RE[cert_type].search(name))


def property_keys(properties):
    """{property id: [pattern]}: the ways a task can name each property.

    The short name ("6 Example Place"), and its house number with the street's
    first word ("6 Example", "57A Sample"), because tasks abbreviate the road. A
    name with no house number keys on its first word when that word is long
    enough to mean something ("Larchmont" for "Larchmont House"). A key that two
    properties share is dropped, or one house's task would cover the other. The
    edges are letter and digit boundaries, so "16 Example" never names "6 Example"."""
    cands = {}
    for p in properties or []:
        short = " ".join(str(p.get("short") or p.get("name") or "").split())
        if not short:
            continue
        words = short.split(" ")
        keys = {short.lower()}
        if re.search(r"\d", words[0]) and len(words) >= 2:
            keys.add(" ".join(words[:2]).lower())
        elif not re.search(r"\d", words[0]) and len(words[0]) >= 6:
            keys.add(words[0].lower())
        cands[p["id"]] = keys
    owners = {}
    for pid, keys in cands.items():
        for k in keys:
            owners.setdefault(k, set()).add(pid)
    return {pid: [re.compile(r"(?<![0-9A-Za-z])" + re.escape(k) + r"(?![0-9A-Za-z])", re.I)
                  for k in sorted(keys) if len(owners[k]) == 1]
            for pid, keys in cands.items()}


def names_property(text, patterns):
    """True when the text names the property (any of its keys)."""
    text = str(text or "")
    return any(rx.search(text) for rx in patterns or [])


def missed_items(pages):
    """(items, inactive): one item per active property and certificate type with
    no in-date certificate on file today. A block's apartments are one item per
    type, listing the apartments. `inactive` counts the pages left out because
    the property is not active, so the caller can say so rather than drop them."""
    items, inactive = [], 0
    for p in pages or []:
        if not p.get("active"):
            inactive += 1
            continue
        by_type = {}
        unit_pages = p.get("units") or {}
        # Every apartment's name in the block, missed or not: a task that names
        # ANY of them is about that apartment, not the whole block.
        all_units = [str((u or {}).get("name") or uid) for uid, u in unit_pages.items()]
        for i in p.get("issues") or []:
            if i.get("state") not in MISSED_STATES:
                continue
            slot = by_type.setdefault(i.get("type"), {"states": [], "units": [], "dates": [], "certs": {}})
            if i["state"] not in slot["states"]:
                slot["states"].append(i["state"])
            if i.get("unit"):
                label = str(i.get("unitName") or i["unit"])
                slot["units"].append(label)
                # The certificate the apartment holds (none when missing). A
                # certificate filed for the whole block is ONE certificate for every
                # apartment, and the renewal engine raises one task for it, named
                # after the first apartment only (agent-dispatch.py renewals_due).
                held = ((unit_pages.get(i["unit"]) or {}).get(i.get("type")) or {}).get("certificate")
                if held:
                    slot["certs"][label] = held
            if i.get("renewalDate"):
                slot["dates"].append(str(i["renewalDate"])[:10])
        for cert_type, slot in by_type.items():
            states = [s for s in MISSED_STATES if s in slot["states"]]
            items.append({
                "propertyId": p.get("id"),
                "property": str(p.get("short") or p.get("name") or p.get("id")),
                "manager": str(p.get("manager") or ""),
                "type": cert_type,
                "states": states,
                "label": "/".join(STATE_WORD[s] for s in states),
                "units": slot["units"],
                "allUnits": all_units,
                "unitCerts": slot["certs"],
                "renewalDate": min(slot["dates"]) if slot["dates"] else "",
            })
    return items, inactive


# A bucket task for the whole portfolio, or for every self-managed house, names
# no house ("File the insurance document and expiry date for every self-managed
# property with none on record"). Without this, the watch would raise one task
# per house beside it, and Kevin rejects duplicates on sight.
PORTFOLIO_NAME_RE = re.compile(
    r"\b(?:every|all|each)\s+(?:of\s+(?:our|the)\s+)?(?:self[- ]managed\s+)?propert(?:y|ies)\b|"
    r"\b(?:full|whole|entire)\s+portfolio\b", re.I)
SELF_MANAGED_NAME_RE = re.compile(r"\bself[- ]managed\b", re.I)
# The Agent/Landlord value that means we manage the house ourselves (js/config.js
# selfManagedAgent, scripts/tenant-leads.py SELF_MANAGED).
SELF_MANAGED = "Property Portfolio"


def task_covers(task, item, patterns, any_property=None):
    """True when an OPEN task already carries this missed item.

    task: {"name", "description", "propertyIds"}. item: a missed_items() item.
    patterns: property_keys(...)[item's property]. any_property: every property's
    patterns, to tell a task about one house from a bucket that names none.
    Any of these is enough:
      * its Description carries this item's key (a task this file raised, or one
        it was folded into);
      * its NAME names the certificate type, and the task is linked to the
        property, or its name names the property;
      * its NAME names the type and NO property, and its description names this
        one (the Q4 plan's bucket tasks list their houses in the description);
      * its NAME names the type and the whole portfolio ("every property"), or
        every self-managed property and this one is self-managed.
    A task whose name names the property but not the type covers nothing: a
    repair at the house is not its gas certificate. And the description of a
    task whose name names ANOTHER house never counts: a long-running task carries
    every house it was ever compared with in its folded updates."""
    name = str(task.get("name") or "")
    desc = str(task.get("description") or "")
    if MISSED_KEY % (item["propertyId"], item["type"]) in desc:
        return True
    if not type_named(name, item["type"]):
        return False
    if item["propertyId"] in (task.get("propertyIds") or []) or names_property(name, patterns):
        return True
    if task.get("propertyIds"):
        return False
    if any(names_property(name, pats) for pats in (any_property or {}).values()):
        return False
    if PORTFOLIO_NAME_RE.search(name):
        return (not SELF_MANAGED_NAME_RE.search(name)) or item.get("manager") == SELF_MANAGED
    return names_property(desc, patterns)


def cover_for(item, tasks, patterns, any_property=None):
    """The first open task that covers the item, or None."""
    for t in tasks or []:
        if task_covers(t, item, patterns, any_property):
            return t
    return None


# "Unit 8", "Flat 9", "Apt. 9", and the plural forms tasks use for several:
# "Flats 1-2", "Units 3 to 9", "Flats 2 and 3", "Apartments 1, 4 & 6".
UNIT_NO_RE = re.compile(
    r"\b(unit|flat|apt|apartment)(s?)\.?\s*(\d+[A-Za-z]?)"
    r"((?:\s*(?:-|–|to|,|and|&)\s*\d+[A-Za-z]?\b)*)", re.I)
UNIT_RANGE_MAX = 60


def unit_numbers(text):
    """{"8", "9"}: the apartment numbers a text names, ranges and lists expanded
    for the PLURAL form only ("Flats 3-9" is 3 to 9; "Flat 2 - 3 Birch Lane" is
    flat 2 of a house). A range wider than 60 is read as its two ends only."""
    out = set()
    for m in UNIT_NO_RE.finditer(str(text or "")):
        first, rest = m.group(3).lower(), (m.group(4) or "") if m.group(2) else ""
        out.add(first)
        prev = first
        for sep, num in re.findall(r"\s*(-|–|to|,|and|&)\s*(\d+[A-Za-z]?)", rest, re.I):
            num = num.lower()
            if sep.lower() in ("-", "–", "to") and prev.isdigit() and num.isdigit() \
                    and 0 < int(num) - int(prev) <= UNIT_RANGE_MAX:
                out.update(str(n) for n in range(int(prev), int(num) + 1))
            out.add(num)
            prev = num
    return out


def uncovered_units(item, tasks, patterns, any_property=None):
    """The apartments of a block item that no open task carries.

    The renewal engine raises one task PER APARTMENT ("... - Block (Unit 8 -
    Block)"), so a task that names an apartment carries that apartment only, and
    a task about the block that names none carries them all. A task THIS file
    raised carries exactly the apartments its description lists ("Apartments:
    ..."): it was raised for those, and a flat whose own task closed later is
    not in it. An apartment whose name carries no number cannot be matched by
    number and is left uncovered, so it is raised rather than lost."""
    covering = [t for t in tasks or [] if task_covers(t, item, patterns, any_property)]
    if not covering:
        return list(item["units"])
    key = MISSED_KEY % (item["propertyId"], item["type"])
    every = list(dict.fromkeys(list(item.get("allUnits") or []) + list(item["units"])))
    # A name can sit inside a longer one ("Penthouse" in "Penthouse 2", an
    # apartment called after the block inside the block's own name): those
    # longer names are what a match must not be part of.
    rivals = every + [str(item.get("property") or "")]
    numbers, lists, names_in_tasks = set(), [], []
    for t in covering:
        desc = str(t.get("description") or "")
        name = str(t.get("name") or "")
        if key in desc:
            listed = APARTMENTS_LINE_RE.search(desc)
            if not listed:
                return []
            numbers |= unit_numbers(listed.group(1))
            lists.append(APARTMENTS_SEPARATOR + listed.group(1) + APARTMENTS_SEPARATOR)
            continue
        names_one = unit_numbers(name) or any(_unit_named(u, name, rivals) for u in every)
        if not names_one:
            return []                      # about the block, naming no apartment
        numbers |= unit_numbers(name)
        names_in_tasks.append(name)

    def named(u):
        own = unit_numbers(u)
        # By number when the apartment has one ("Apartment 1" is not carried by
        # "Apartment 10"); else by its whole name: exactly, between separators, on
        # the watch's own list (a name holding "; " still matches, and "Garden
        # Flat" is not "Garden Flat Rear"), or in another task's name.
        if own:
            return bool(own & numbers)
        return (any((APARTMENTS_SEPARATOR + u + APARTMENTS_SEPARATOR) in t for t in lists)
                or any(_unit_named(u, t, rivals) for t in names_in_tasks))
    carried = {u for u in item["units"] if named(u)}
    # One certificate for several apartments (filed for the whole block): a task
    # for any of them is the task for that certificate, and so for all of them.
    certs = item.get("unitCerts") or {}
    shared = {certs[u] for u in carried if certs.get(u)}
    return [u for u in item["units"] if u not in carried and not (certs.get(u) and certs[u] in shared)]


def _spans(name, text):
    name = str(name or "").strip()
    if not name:
        return []
    return [m.span() for m in re.finditer(r"(?<![0-9A-Za-z])" + re.escape(name) + r"(?![0-9A-Za-z])",
                                          str(text or ""), re.I)]


def _unit_named(unit, text, rivals=()):
    """True when a text names this apartment by its whole name (letter and digit
    edges, so "Flat 1" is not found inside "Flat 10"), somewhere that is not
    just part of a longer rival name found there too ("Penthouse" inside
    "Penthouse 2", "Larchmont" inside "Larchmont House")."""
    unit = str(unit or "").strip()
    longer = [s for r in rivals or () if len(str(r or "").strip()) > len(unit)
              and unit.lower() in str(r).lower() for s in _spans(r, text)]
    return any(not any(a <= s and e <= b for a, b in longer) for s, e in _spans(unit, text))


# The list missed_task_fields writes, a block's apartments in full. Its own end
# mark and separator, because an apartment's name can hold ". " ("Apt. 1") or ", ".
APARTMENTS_SEPARATOR = "; "
APARTMENTS_LINE_RE = re.compile(r"Apartments: (.*?) \(end of list\)", re.S)


def closed_on(task):
    """The day a closed task closed. A cancelled task carries no Completion Date
    (0 of 23 cancelled in the 30 days to 7 Oct 2026 had one), so the record's
    last change (LMT) stands in for it; on 43 closed COMPLIANCE tasks LMT equalled
    the Completion Date every time. The day it was created is the last resort."""
    return _day(task.get("completed")) or _day(task.get("modified")) or _day(task.get("created"))


def units_listed(task, units):
    """The apartments of `units` that a watch task's own list names, or all of
    them when the task carries no list (it was raised for the whole item)."""
    listed = APARTMENTS_LINE_RE.search(str(task.get("description") or ""))
    if not listed:
        return list(units)
    text = APARTMENTS_SEPARATOR + listed.group(1) + APARTMENTS_SEPARATOR
    numbers = unit_numbers(listed.group(1))

    def on_list(u):
        own = unit_numbers(u)
        return bool(own & numbers) if own else (APARTMENTS_SEPARATOR + u + APARTMENTS_SEPARATOR) in text
    return [u for u in units if on_list(u)]


def recently_closed_all(item, keyed_tasks, today, days=CLOSED_COOL_OFF_DAYS):
    """Every task this file raised for this item that was CLOSED in the last
    `days` days, newest first."""
    today = _day(today)
    key = MISSED_KEY % (item["propertyId"], item["type"])
    out = []
    for t in keyed_tasks or []:
        if key in str(t.get("description") or "") and str(t.get("status") or "") in ("Completed", "Cancelled"):
            when = closed_on(t)
            if when and (today - when).days <= days:
                out.append((when, t))
    return [t for _, t in sorted(out, key=lambda x: x[0], reverse=True)]


def recently_closed(item, keyed_tasks, today, days=CLOSED_COOL_OFF_DAYS):
    """The task this file raised for this item and that was CLOSED in the last
    `days` days, or None. Closed = Completed or Cancelled; when = closed_on()."""
    today = _day(today)
    key = MISSED_KEY % (item["propertyId"], item["type"])
    best = None
    for t in keyed_tasks or []:
        if key not in str(t.get("description") or ""):
            continue
        if str(t.get("status") or "") not in ("Completed", "Cancelled"):
            continue
        when = closed_on(t)
        if when and (today - when).days <= days and (best is None or when > best[0]):
            best = (when, t)
    return best[1] if best else None


def plan_order(texts, properties):
    """{(property id, type): rank} from the quarter plan's month texts, in order.

    Each sentence that names a certificate type ranks the properties it names,
    in the order it names them ("Buy every gas certificate, lapsed ones first:
    6 Example Place, 23 Sample Street, ..."). The first mention wins."""
    patterns = property_keys(properties)
    rank, counters = {}, {}
    for text in texts or []:
        for sentence in re.split(r"(?<=[.!?;])\s+", str(text or "")):
            types = [t for t, rx in PLAN_TYPE_WORDS if rx.search(sentence)]
            if not types:
                continue
            hits = []
            for pid, pats in patterns.items():
                spots = [m.start() for rx in pats for m in rx.finditer(sentence)]
                if spots:
                    hits.append((min(spots), pid))
            for _, pid in sorted(hits):
                for t in types:
                    if (pid, t) not in rank:
                        rank[(pid, t)] = counters.get(t, 0)
                        counters[t] = counters.get(t, 0) + 1
    return rank


def order_key(item, rank):
    """The order of work (Kevin, 7 Oct 2026): lapsed first, then the quarter
    plan's list order, then soonest expiry.

    Lapsed = a certificate that was held and has run out ("expired"). Next come
    the items with no date to go on (never on file, or on file with no date),
    then anything still in date but due. Within each, the plan's order, then the
    earliest renewal date, then on a tie Kevin's 2 Sep 2026 order (insurance,
    gas safety, the rest), then the name, so the order never depends on how the
    book happened to be read."""
    states = item.get("states") or [item.get("state")]
    tier = 0 if "expired" in states else (1 if any(s in MISSED_STATES for s in states) else 2)
    r = rank.get((item.get("propertyId"), item.get("type")))
    return (tier, 0 if r is not None else 1, r if r is not None else 0,
            item.get("renewalDate") or "9999-99-99",
            TYPE_TIE_ORDER.get(item.get("type"), len(TYPE_TIE_ORDER)),
            item.get("property") or "", item.get("type") or "")


# Kevin's 2 Sep 2026 order, kept for a tie (the agent file, step 6): insurance,
# then gas safety, then everything else.
TYPE_TIE_ORDER = {"Landlord Insurance": 0, "GSC": 1}


def parse_premium(text):
    """The annual premium a book row's Notes record ("premium £416.60/yr",
    "premium of £51.80 a month", "monthly premium £34.50", "premium £34.50 pcm"),
    or None. A monthly figure is times twelve: read as a year's, a monthly
    premium would hide any rise."""
    text = str(text or "")
    m = PREMIUM_RE.search(text)
    if not m:
        return None
    try:
        amount = float(m.group(1).replace(",", ""))
    except ValueError:
        return None
    if MONTHLY_AFTER_RE.search(text[m.end():m.end() + 30]) or MONTHLY_BEFORE_RE.search(text[max(0, m.start() - 20):m.start()]):
        amount *= 12
    return round(amount, 2)


DATE_ISO_RE = re.compile(r"\b(20\d\d)-(\d\d)-(\d\d)\b")
# A month word is a whole word, the full name or its short form: "Mayfield 2026"
# is a place, not May.
MONTH_WORD = (r"(January|February|March|April|May|June|July|August|September|October|November|December|"
              r"Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\b")
DATE_TEXT_RE = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+" + MONTH_WORD + r"\.?,?\s+(20\d\d)\b", re.I)
DATE_UK_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})/(20\d\d|\d\d)\b")
MONTH_YEAR_RE = re.compile(r"(?<!\d)(?<!\d )\b" + MONTH_WORD + r"\.?,?\s+(20\d\d)\b", re.I)
# A month named on its own stands for the whole month: the 15th, give or take 20 days.
MONTH_TOLERANCE_DAYS = 20
MONTHS = {m: i for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug",
                                       "sep", "oct", "nov", "dec"), 1)}
# A house's insurance task with no date in its name stands for the renewal in hand
# only if it was raised in the run-up to it, not left open from a year before.
DATELESS_COVER_DAYS = 90


def dates_named(text):
    """[(date, tolerance in days)] for every date a text states: "2026-10-03",
    "3 Oct 2026", "03/10/2026" (UK order) to the day, "Oct 2026" to the month."""
    text = str(text or "")
    out = []

    def add(y, mo, d, tol):
        try:
            out.append((date(y, mo, d), tol))
        except ValueError:
            pass
    for y, mo, d in DATE_ISO_RE.findall(text):
        add(int(y), int(mo), int(d), 0)
    for d, mon, y in DATE_TEXT_RE.findall(text):
        add(int(y), MONTHS[mon[:3].lower()], int(d), 0)
    for d, mo, y in DATE_UK_RE.findall(text):
        add(int(y) + (2000 if len(y) == 2 else 0), int(mo), int(d), 0)
    for mon, y in MONTH_YEAR_RE.findall(text):
        add(int(y), MONTHS[mon[:3].lower()], 15, MONTH_TOLERANCE_DAYS)
    return out


def insurance_open_for(property_id, renewal, tasks, patterns):
    """The open task already getting a replacement quote for THIS renewal of this
    house's policy, or None. Stricter than the missed-item check, on purpose: a
    portfolio bucket ("file the insurance document for every property with none
    on record") is about houses with NO policy, not this one, and last year's
    task ("... before 3 Oct 2026") left open is about another renewal. So: a task
    carrying this renewal's key, or one whose name is about landlord insurance,
    is linked to or names this house, and either names a date within 14 days of
    this renewal (a month named, within the month) or, naming none, was raised
    in the 90 days before it."""
    renewal = _day(renewal)
    key = (INSURANCE_KEY % (property_id, renewal.isoformat(), "")).rstrip() + " "
    for t in tasks or []:
        if key in str(t.get("description") or ""):
            return t
        name = str(t.get("name") or "")
        if not type_named(name, "Landlord Insurance"):
            continue
        if property_id not in (t.get("propertyIds") or []) and not names_property(name, patterns):
            continue
        named = dates_named(name)
        if named:
            if not any(abs((d - renewal).days) <= max(14, tol) for d, tol in named):
                continue
        else:
            created = _day(t.get("created"))
            if not created or (renewal - created).days > DATELESS_COVER_DAYS:
                continue
        return t
    return None


def insurance_actions(pages, open_tasks, keyed_tasks, patterns, today):
    """The insurance tasks to raise today, as dicts with kind "quote" or "passed".

    For the latest landlord insurance policy on each active property's page:
      * renewal 15 to 30 days away, and 0 to 14 days away: two checkpoints. If no
        open task is getting a quote for this renewal (insurance_open_for) and
        this checkpoint has not fired before (a task carrying its key exists,
        open or closed), raise the replacement-quote task;
      * renewal passed in the last 14 days with no open task: raise the alarm
        that it renewed with no replacement quote (Hard Deadline, so the 09:00
        brief shows it).
    `patterns` is property_keys(...). A policy with no renewal date is the
    missed-item pass's job ("undated")."""
    today = _day(today)
    fired = "\n".join(str(t.get("description") or "") for t in keyed_tasks or [])
    acts = []
    for p in pages or []:
        if not p.get("active"):
            continue
        held = (p.get("holds") or {}).get("Landlord Insurance")
        renewal = _day((held or {}).get("renewalDate"))
        if not renewal:
            continue
        d = (renewal - today).days
        if INSURANCE_SECOND_CHECK_DAYS < d <= INSURANCE_FIRST_CHECK_DAYS:
            kind, checkpoint = "quote", "30"
        elif 0 <= d <= INSURANCE_SECOND_CHECK_DAYS:
            kind, checkpoint = "quote", "14"
        elif -RENEWAL_PASSED_DAYS <= d < 0:
            kind, checkpoint = "passed", "passed"
        else:
            continue
        if insurance_open_for(p.get("id"), renewal, open_tasks, patterns.get(p.get("id"))):
            continue
        key = INSURANCE_KEY % (p.get("id"), renewal.isoformat(), checkpoint)
        if key in fired:
            continue
        acts.append({"kind": kind, "checkpoint": checkpoint, "key": key,
                     "propertyId": p.get("id"),
                     "property": str(p.get("short") or p.get("name") or p.get("id")),
                     "manager": str(p.get("manager") or ""),
                     "renewalDate": renewal.isoformat(), "days": d,
                     "certificate": (held or {}).get("certificate", "")})
    return acts


def premium_rises(rows, keyed_tasks, today, limit=PREMIUM_RISE_LIMIT):
    """(rises, not_checked): policies in force whose premium rose more than
    `limit` on the one before it, and how many policies in force could not be
    checked because a premium is not recorded on both rows.

    rows: landlord insurance book rows, {"id", "propertyIds", "renewalDate", "notes"}.
    A rise fires once per new row (its key on a task, open or closed)."""
    today = _day(today)
    fired = "\n".join(str(t.get("description") or "") for t in keyed_tasks or [])
    by_prop = {}
    for r in rows or []:
        for pid in r.get("propertyIds") or []:
            by_prop.setdefault(pid, []).append(r)
    rises, not_checked = [], 0
    for pid, mine in by_prop.items():
        dated = sorted((r for r in mine if _day(r.get("renewalDate"))),
                       key=lambda r: _day(r["renewalDate"]))
        if not dated or _day(dated[-1]["renewalDate"]) < today:
            continue
        new = dated[-1]
        old = dated[-2] if len(dated) > 1 else None
        new_p = parse_premium(new.get("notes"))
        old_p = parse_premium(old.get("notes")) if old else None
        if new_p is None or old_p is None or old_p <= 0:
            not_checked += 1
            continue
        if new_p > old_p * (1 + limit) and (PREMIUM_KEY % new["id"]) not in fired:
            rises.append({"propertyId": pid, "row": new["id"], "old": old_p, "new": new_p,
                          "rise": round((new_p - old_p) / old_p * 100, 1),
                          "renewalDate": _day(new["renewalDate"]).isoformat(),
                          "key": PREMIUM_KEY % new["id"]})
    return rises, not_checked


# Write-side Task field ids (js/config.js TASK_FIELDS; the same ids
# scripts/create-agent-task.py F and agent-dispatch.py REVIEW_TASK_FIELDS use).
TF = {"name": "fldgFjGBw6bTKJFCD", "status": "fldx4qCw17UfrKpaN", "due": "fld7XP8w8kbxfETV4",
      "team": "flduCtmQGpOA4eWaj", "priority": "fldS21RwmwOqt71LI", "desc": "fldRGhBQViKZKtkQ6",
      "hardDeadline": "fldZKzIxgyrQ8CG8a", "properties": "fldZKFvEpJ6NZeFKz",
      "estimate": "fld10VzzbiNNgRmIi",
      # LMT: last modified time over ALL fields (read only, base schema 7 Oct 2026).
      "modified": "flddJA23cJRX5cs1K"}
PROPERTY_ADMIN_REC = "recwWvBju2ycB63i4"   # Team Members: AI Property Administration
ORDER_RULE = ("Order of work (Kevin, 7 Oct 2026): lapsed first, then the quarter plan's list "
              "order, then soonest expiry.")


def missed_task_fields(item, position, total, top, today):
    """The create payload for one missed item (field ids, for create-agent-task.py)."""
    where = item["property"]
    name = ("COMPLIANCE: %s %s - %s" % (item["type"], item["label"], where))[:100]
    # Every apartment, never a cut list: uncovered_units reads this line back,
    # and an apartment left off it would be raised again the next morning.
    units = (" Apartments: %s (end of list)." % APARTMENTS_SEPARATOR.join(item["units"])) if item["units"] else ""
    since = (" Latest renewal date on file: %s." % item["renewalDate"]) if item["renewalDate"] else ""
    desc = (
        "PROPERTY COMPLIANCE, raised by the daily certificate watch "
        "(scripts/certificate_watch.py) because no open task carried it. "
        "The compliance book holds no in-date %s for %s (%s).%s%s Managed by: %s.\n\n"
        "%s This is number %d of %d items with no task today. Today's first five: %s.\n\n"
        "Search everything first (the book, the brain, both Drives, Gmail, Evernote, and "
        "agent-dispatch.py certificate-gaps for a paid visit): if the certificate exists, file it "
        "with agent-dispatch.py certificate and close this. Otherwise work your lane: a letting "
        "agent's property is a chase to the agent; our own is three quotes, then you BOOK the "
        "cheapest by email (your file, step 4). Do not close this until the certificate is filed. "
        "If it genuinely is not ours to hold, close it with complete --no-certificate \"<why>\": it "
        "is not raised again for %d days.\n\n%s"
        % (item["type"], where, item["label"], units, since, item["manager"] or "us",
           ORDER_RULE, position, total, top, CLOSED_COOL_OFF_DAYS,
           MISSED_KEY % (item["propertyId"], item["type"])))
    return {TF["name"]: name, TF["status"]: "Today", TF["due"]: today,
            TF["team"]: [PROPERTY_ADMIN_REC], TF["priority"]: "High",
            TF["estimate"]: "45 min", TF["desc"]: desc,
            TF["properties"]: [item["propertyId"]]}


def insurance_task_fields(act, today):
    """The create payload for an insurance action. Both carry the Hard Deadline
    tick: that tick is how a task reaches the 09:00 brief's deadline list
    (scripts/slack-automation/money-daily-worker.js selectDeadlines), whoever
    holds it."""
    where = act["property"]
    if act["kind"] == "quote":
        if act["checkpoint"] == "30":
            # The renewal trigger's own name, so neither raises a second task.
            name = (ENGINE_RENEWAL_NAME % ("Landlord Insurance", act["renewalDate"], where))[:100]
        else:
            name = ("INSURANCE: replacement quote via TopCashback before %s - %s"
                    % (act["renewalDate"], where))[:100]
        due = act["renewalDate"]
        # The 30-day task stands in for agent-dispatch's own renewal task (it took
        # that task's name), so it carries that task's mark too: verify then refuses
        # to let it close with no policy filed, exactly as it would the engine's.
        engine = ("PROPERTY COMPLIANCE, %s's 30-day rule, raised first by the daily certificate "
                  "watch under the same name. " % ENGINE_RENEWAL_MARK) if act["checkpoint"] == "30" else ""
        desc = (engine +
            "PROPERTY INSURANCE, raised by the daily certificate watch (scripts/certificate_watch.py), "
            "checkpoint %s days: the landlord insurance at %s renews on %s (%d days) and no open task "
            "was getting a replacement quote. Three policies renewed in September 2026 with no "
            "replacement quote; this is the step that stops that.\n\n"
            "Get three replacement quotes through TopCashback by NET cost (premium minus cashback), "
            "fill each form to the last page without submitting, and put the recommendation card to "
            "Kevin before the renewal date.\n\n%s\n\n"
            "Kevin buys. End your output with this line, exactly in this shape, naming the insurer:\n%s\n\n"
            "When the new schedule arrives, file it with agent-dispatch.py certificate and put the "
            "annual premium in --note as \"premium £<amount>/yr\", so a rise at the next renewal is "
            "caught.\n\n%s"
            % (act["checkpoint"], where, act["renewalDate"], act["days"], INSURANCE_RULE,
               KEVIN_PURCHASE_LINE, act["key"]))
    else:
        name = ("INSURANCE: %s renewed on %s with no replacement quote open" % (where, act["renewalDate"]))[:100]
        due = today
        desc = (
            "PROPERTY INSURANCE, raised by the daily certificate watch (scripts/certificate_watch.py): "
            "the landlord insurance at %s was due to renew on %s and, when that date passed, no open "
            "task was getting a replacement quote and no new policy is filed, so it has probably "
            "renewed on its own. (If a quote task was worked and Kevin chose to keep the policy, file "
            "the renewed schedule and close this.) A renewed policy can usually still be cancelled "
            "without charge in the first 14 days.\n\n"
            "Find the renewal (Gmail, the insurer's email, the bank) and file the new schedule with "
            "agent-dispatch.py certificate, with \"premium £<amount>/yr\" in --note. Then get three "
            "replacement quotes through TopCashback and put the cancel-and-replace recommendation "
            "card to Kevin with both premiums.\n\n%s\n\n"
            "Kevin buys. End your output with this line, exactly in this shape, naming the insurer:\n%s\n\n%s"
            % (where, act["renewalDate"], INSURANCE_RULE, KEVIN_PURCHASE_LINE, act["key"]))
    return {TF["name"]: name, TF["status"]: "Today", TF["due"]: due,
            TF["team"]: [PROPERTY_ADMIN_REC], TF["priority"]: "High",
            TF["estimate"]: "1 hr", TF["hardDeadline"]: True, TF["desc"]: desc,
            TF["properties"]: [act["propertyId"]]}


def premium_task_fields(rise, where, today):
    """The create payload for a premium that rose more than the limit."""
    name = ("INSURANCE: premium up %s%% at renewal - %s" % (rise["rise"], where))[:100]
    desc = (
        "PROPERTY INSURANCE, raised by the daily certificate watch (scripts/certificate_watch.py): "
        "the landlord insurance at %s now costs £%.2f a year against £%.2f on the policy before it "
        "(up %s%%, over the %d%% line). The figures are the premiums recorded in the Notes of the two "
        "book rows. Get three replacement quotes through TopCashback and put the cancel-and-replace "
        "recommendation card to Kevin.\n\n%s\n\n"
        "Kevin buys. End your output with this line, exactly in this shape, naming the insurer:\n%s\n\n%s"
        % (where, rise["new"], rise["old"], rise["rise"], int(PREMIUM_RISE_LIMIT * 100),
           INSURANCE_RULE, KEVIN_PURCHASE_LINE, rise["key"]))
    return {TF["name"]: name, TF["status"]: "Today", TF["due"]: today,
            TF["team"]: [PROPERTY_ADMIN_REC], TF["priority"]: "High",
            TF["estimate"]: "1 hr", TF["hardDeadline"]: True, TF["desc"]: desc,
            TF["properties"]: [rise["propertyId"]]}


def watch_summary(found, raised, still, held_back, insurance_raised, premium_unchecked, paused=False,
                  dry_run=False):
    """The run's last line. The job's Estate Status row prints the last thing a
    failing job said, cut to its LAST 220 characters (estate-status.py
    plain_tail), so the line is kept within that, with the count of items with no
    task first and the least important parts dropped first."""
    line = ("COMPLIANCE: %d required item%s had no open task; %d %s, %d still without one"
            % (found, "" if found == 1 else "s", raised,
               "would be raised (dry run)" if dry_run else "raised", still))
    parts = []
    if paused:
        parts.append(" (agent paused, none raised)")
    if held_back:
        parts.append("; %d held back after a recent close" % held_back)
    parts.append("; insurance: %d %s" % (insurance_raised, "would be raised" if dry_run else "raised"))
    if premium_unchecked:
        parts.append("; premium not recorded on %d" % premium_unchecked)
    for part in parts:
        if len(line) + len(part) + 1 <= SUMMARY_MAX:
            line += part
    return line + "."


SUMMARY_MAX = 220   # scripts/estate-status.py plain_tail(limit=220)


# ── THE DAILY RUN: the one part of this file that reads Airtable ─────────────
#
#   python3 scripts/certificate_watch.py daily            read, judge, print; writes nothing
#   python3 scripts/certificate_watch.py daily --apply    the same, and raises the tasks
#
# Every task goes through scripts/create-agent-task.py (the duplicate gate); a dry
# run asks the gate with --dry-run, so the list shows what the gate would do. It
# exits 1 when it found any required item with no task (the job's Estate Status
# row then prints the count, which is the point), and when a read or a create
# failed. Scheduled as the wrapped job `compliance-watch` (scripts/job-schedule.json).

HERE = os.path.dirname(os.path.abspath(__file__))
OPEN_TASKS_FLOOR = 50          # 225 open tasks on 7 Oct 2026; fewer than this is a broken read
OS_TABLE = "tblEBvFw8DonwxzGh"  # Objective and Strategy: one row per business per quarter
OS_FIELDS = {"business": "fldzd28sBEghgt0mN", "quarter": "fldQl2h3gCxYacE1k", "year": "fldARVrVpuCWxufQO"}
# Quarterly Project N, and its three month fields (the field names are "Q1. Month 1" ...
# "Q3: Month 3": Q here is the PROJECT number, not the quarter). Ids from the base schema.
QP_FIELDS = {
    1: ("fldMRcqBdI6sixquu", ("fldA66Xm4zVoClUva", "fldP91H4XWknwmlzo", "fldglTQ9Ljyba0IqK")),
    2: ("fldzTGq0bsvSIch4v", ("fldBcYzfU8zheE00j", "fldr6WW4Xubhe2Vtm", "fldqD4uHoPFIfR7Yi")),
    3: ("fldWEzLxBkIptAqhq", ("fldayHcCRQlG3mLxe", "fldp1YRY0eGzVJQqU", "fldZ87UWBj2NYU9Jl")),
}
COMPLIANCE_PROJECT_RE = re.compile(r"complian|certific", re.I)
_AD = {}


def _dispatch():
    """scripts/agent-dispatch.py, loaded once: the book, the reads and the pause lever."""
    if "m" not in _AD:
        import importlib.util
        spec = importlib.util.spec_from_file_location("agent_dispatch_for_watch",
                                                      os.path.join(HERE, "agent-dispatch.py"))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        _AD["m"] = m
    return _AD["m"]


def _task_view(ad, rec):
    f = rec.get("fields", {}) or {}
    status = f.get(ad.AF["status"])
    return {"id": rec.get("id", ""), "name": str(f.get(ad.AF["name"]) or ""),
            # Rich text: "\_" back to "_", so a key or a house name reads as written.
            "description": plain_text(f.get(ad.AF["description"])),
            "status": status.get("name", "") if isinstance(status, dict) else str(status or ""),
            "propertyIds": ad.links(f.get(TF["properties"])),
            "created": str(rec.get("createdTime") or "")[:10],
            "completed": str(f.get(ad.AF["completion"]) or "")[:10],
            "modified": str(f.get(TF["modified"]) or "")[:10]}


def plan_texts(ad, today):
    """(texts, why_not): the month texts of this quarter's compliance project in the
    Real Estate plan, or ([], the reason it could not be read)."""
    year, month = int(today[:4]), int(today[5:7])
    quarter = "Q%d" % ((month - 1) // 3 + 1)
    fields = list(OS_FIELDS.values()) + [f for qp in QP_FIELDS.values() for f in (qp[0],) + qp[1]]
    rows = ad.query_records(OS_TABLE, formula="AND({Quarter}='%s', {Year}='%d', {Business Name}='Real Estate')"
                            % (quarter, year), fields=fields)
    if len(rows) != 1:
        return [], "%d Real Estate plan rows for %s %d (expected 1)" % (len(rows), quarter, year)
    f = rows[0].get("fields", {}) or {}
    for n, (name_fid, months) in QP_FIELDS.items():
        if COMPLIANCE_PROJECT_RE.search(str(f.get(name_fid) or "")):
            return [str(f.get(m) or "") for m in months], ""
    return [], "no quarterly project in the %s %d plan is about compliance" % (quarter, year)


def _gate(fields, flags):
    cmd = [sys.executable, os.path.join(HERE, "create-agent-task.py"), "create",
           "--fields-json", json.dumps(fields)] + list(flags)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, {"action": "error", "why": str(exc)[:200]}
    lines = [ln for ln in r.stdout.splitlines() if ln.strip().startswith("{")]
    try:
        out = json.loads(lines[-1]) if lines else {}
    except ValueError:
        out = {}
    if r.returncode != 0:
        out = dict(out, action=out.get("action") or "error", exit=r.returncode,
                   why=(out.get("reason") or r.stderr.strip()[-300:] or "no output"))
    return r.returncode == 0, out


def gate_create(fields, apply):
    """(ok, result) from scripts/create-agent-task.py. ok is False on a refusal,
    a broken gate or an incomplete create; result carries the gate's own words.

    The gate is asked first with --dry-run. It folds a new task into an open one
    whose two key words match, and for these tasks that is always the wrong
    task: the exists-check above has already read every open task by property
    and type and found none. On 7 Oct 2026 it would have folded the block's
    missing insurance into another house's insurance task (a building name with
    no house number has no address for the gate to compare), the block's expired
    EICR into an EPC quote, and one house's insurance into a task about deleting
    an electrical row. The key would then sit in the wrong task and read as
    covered for ever. So a fold verdict is refused, and the task is created on
    its own (--force), with the gate's suggested match reported."""
    ok, out = _gate(fields, ["--dry-run"])
    if not ok:
        return ok, out
    suggested = out.get("matchedName", "") if out.get("action") == "updated" else ""
    extra = {"gateWouldFold": suggested} if suggested else {}
    if not apply:
        return True, dict({"action": "created", "taskId": "(dry run)", "dryRun": True}, **extra)
    # The real create is always forced: the dry run above already ran the gate's
    # refusals, and a fold decided between the two calls (the board moved) would
    # put this item's key in another task for good.
    ok, out = _gate(fields, ["--force"])
    return ok, dict(out, **extra)


def judge_missed(items, open_tasks, keyed, patterns, today):
    """(covered, held_back, found): which missed items an open task carries, which
    were closed too recently to raise again, and which have NO task. Pure."""
    covered, held_back, found = [], [], []
    for item in items:
        pats = patterns.get(item["propertyId"])
        if item["units"]:
            # A block: each apartment needs a task that carries it.
            left = uncovered_units(item, open_tasks, pats, patterns)
            if not left:
                covered.append({"item": "%s %s" % (item["property"], item["type"]), "task": "per apartment"})
                continue
            if len(left) < len(item["units"]):
                item = dict(item, units=left)
        else:
            cover = cover_for(item, open_tasks, pats, patterns)
            if cover:
                covered.append({"item": "%s %s" % (item["property"], item["type"]), "task": cover["id"]})
                continue
        if not item["units"]:
            closed = recently_closed(item, keyed, today)
            if closed:
                held_back.append({"property": item["property"], "type": item["type"], "closedTask": closed["id"],
                                  "comesBack": (closed_on(closed)
                                                + timedelta(days=CLOSED_COOL_OFF_DAYS + 1)).isoformat()})
                continue
        else:
            # A block: only the apartments a recently closed watch task was raised
            # for are held back (every such task, not just the latest); an
            # apartment none of them named is raised now, not hidden.
            held = []
            for closed in recently_closed_all(item, keyed, today):
                listed = [u for u in units_listed(closed, item["units"]) if u not in held]
                if listed:
                    held += listed
                    held_back.append({"property": item["property"], "type": item["type"],
                                      "closedTask": closed["id"], "units": listed,
                                      "comesBack": (closed_on(closed)
                                                    + timedelta(days=CLOSED_COOL_OFF_DAYS + 1)).isoformat()})
            rest = [u for u in item["units"] if u not in held]
            if not rest:
                continue
            item = dict(item, units=rest)
        found.append(item)
    return covered, held_back, found


def read_book(ad):
    """Everything the pass judges, read once, with its controls. Raises
    RuntimeError naming the broken read: a broken read must never print
    "nothing missed", and a broken exists-check mints duplicates."""
    props = ad.fetch_properties()
    certs = ad.fetch_certificates()
    # 26 properties and 95 certificate rows on 7 Oct 2026.
    if not props or not certs:
        raise RuntimeError("control failed: the compliance book read %d properties and %d certificate "
                           "rows (26 and 95 on 7 Oct 2026)" % (len(props), len(certs)))
    pages = ad.compliance_book_pages()
    open_rows = ad.query_records(ad.TASKS, "AND({Status}!='Completed', {Status}!='Cancelled')",
                                 fields=[ad.AF["name"], ad.AF["description"], ad.AF["status"],
                                         TF["properties"]])
    if len(open_rows) < OPEN_TASKS_FLOOR:
        raise RuntimeError("control failed: the open-task read returned %d rows (225 on 7 Oct 2026); "
                           "the exists-check cannot run" % len(open_rows))
    keyed_rows = ad.query_records(ad.TASKS, "FIND('%s', {Description})" % KEY_PREFIX,
                                  fields=[ad.AF["name"], ad.AF["description"], ad.AF["status"],
                                          ad.AF["completion"], TF["modified"]])
    open_tasks = [_task_view(ad, r) for r in open_rows]
    keyed = [_task_view(ad, r) for r in keyed_rows]
    # CONTROL for the keyed read, whose zero is legitimate on the first day: every
    # OPEN task carrying a key must be in it. A broken keyed formula would lose the
    # record of every fired checkpoint and every recent close, and the watch would
    # raise them all again the next morning.
    lost = {t["id"] for t in open_tasks if KEY_PREFIX in t["description"]} - {t["id"] for t in keyed}
    if lost:
        raise RuntimeError("control failed: %d open tasks carry a watch key but the keyed read did not "
                           "return them; the record of what already fired cannot be trusted" % len(lost))
    return {"props": props, "certs": certs, "pages": pages, "open": open_tasks, "keyed": keyed,
            "patterns": property_keys(props)}


def cmd_daily(apply):
    ad = _dispatch()
    today = ad.today_london()
    try:
        book = read_book(ad)
    except RuntimeError as exc:
        print("ERROR: %s. Nothing was raised." % exc)
        return 1
    props, certs, pages = book["props"], book["certs"], book["pages"]
    ins_rows = ad.query_records(ad.CERTIFICATES_TABLE, "{Type}='Landlord Insurance'",
                                fields=[ad.CERT_FIELDS[k] for k in ("type", "property", "renewal", "notes")])
    held_insurance = sum(1 for p in pages if (p.get("holds") or {}).get("Landlord Insurance"))
    if held_insurance and not ins_rows:
        print("ERROR: control failed: the book holds %d landlord insurance policies but the insurance "
              "read returned none. Nothing raised." % held_insurance)
        return 1
    try:
        texts, plan_why = plan_texts(ad, today)
    except Exception as exc:                          # noqa: BLE001 — reported, never swallowed
        texts, plan_why = [], "the plan read failed: %s" % str(exc)[:160]
    paused = ad.property_agent_paused()

    open_tasks, keyed, patterns = book["open"], book["keyed"], book["patterns"]
    names = {p["id"]: p.get("short") or p.get("name") or p["id"] for p in props}
    rank = plan_order(texts, props)
    failures, raised_ins = [], []

    def raise_task(fields, what):
        """One create through the gate. Paused: nothing is raised, and the row says so."""
        if paused:
            return {"what": what, "name": fields[TF["name"]], "ok": False,
                    "gate": "not raised: the Property Administration agent is paused"}
        ok, out = gate_create(fields, apply)
        row = {"what": what, "name": fields[TF["name"]], "ok": ok, "gate": out.get("action"),
               "taskId": out.get("taskId", ""), "dryRun": not apply}
        if out.get("gateWouldFold"):
            row["gateWouldHaveFoldedInto"] = out["gateWouldFold"][:90]
        if out.get("action") == "updated":
            # The dry run said create and the real call folded: the board moved
            # between the two. Loud, because the key now sits in that task.
            ok = row["ok"] = False
            out["why"] = ("the gate folded this into %r after its dry run said create; check that "
                          "task carries this item" % str(out.get("matchedName") or "")[:90])
        if not ok:
            row["why"] = str(out.get("why") or "")[:300]
            failures.append(row)
            return row
        # The task now exists (or would): later checks in this run must see it.
        open_tasks.append({"id": row["taskId"], "name": fields[TF["name"]],
                           "description": fields[TF["desc"]], "status": "Today",
                           "propertyIds": fields.get(TF["properties"]) or []})
        return row

    # 1. Insurance first: a task raised here also covers the house's insurance
    #    item in the missed-item pass below, so the matter is raised once.
    for act in insurance_actions(pages, open_tasks, keyed, patterns, today):
        raised_ins.append(dict(raise_task(insurance_task_fields(act, today), "insurance " + act["kind"]),
                               property=act["property"], renewalDate=act["renewalDate"]))
    ins_views = [{"id": r.get("id"), "propertyIds": ad.links((r.get("fields") or {}).get(ad.CERT_FIELDS["property"])),
                  "renewalDate": str((r.get("fields") or {}).get(ad.CERT_FIELDS["renewal"]) or "")[:10],
                  "notes": str((r.get("fields") or {}).get(ad.CERT_FIELDS["notes"]) or "")} for r in ins_rows]
    rises, premium_unchecked = premium_rises(ins_views, keyed, today)
    for rise in rises:
        where = names.get(rise["propertyId"], rise["propertyId"])
        raised_ins.append(dict(raise_task(premium_task_fields(rise, where, today), "premium rise"),
                               property=where, rise=rise["rise"]))

    # 2. Every required item with no in-date certificate and no open task.
    items, inactive = missed_items(pages)
    covered, held_back, found = judge_missed(items, open_tasks, keyed, patterns, today)
    found.sort(key=lambda it: order_key(it, rank))
    top = "; ".join("%s %s" % (it["property"], it["type"]) for it in found[:5])
    raised = []
    for n, item in enumerate(found, 1):
        row = raise_task(missed_task_fields(item, n, len(found), top, today), "missed")
        raised.append(dict(row, order=n, property=item["property"], propertyId=item["propertyId"],
                           type=item["type"], state=item["label"], units=len(item["units"])))

    ok_raised = [r for r in raised if r["ok"]]
    print(json.dumps({
        "today": today, "apply": apply, "agentPaused": paused,
        "booked": {"properties": len(props), "certificateRows": len(certs), "openTasks": len(open_tasks),
                   "inactivePropertiesNotChecked": inactive},
        "planOrder": {"ranked": len(rank), "notChecked": plan_why or None},
        "missedItems": len(items), "covered": len(covered), "heldBackAfterClose": held_back,
        "missedWithNoTask": len(found), "missed": raised,
        "insurance": raised_ins, "premiumNotChecked": premium_unchecked,
        "failures": failures}, indent=1))
    still = len(found) - (len(ok_raised) if apply else 0)
    print(watch_summary(len(found), len(ok_raised), still, len(held_back),
                        len([r for r in raised_ins if r["ok"]]), premium_unchecked, paused,
                        dry_run=not apply))
    # Non-zero whenever a required item had no task this morning, even once it is
    # raised: that a task had gone missing is the thing worth seeing on the board.
    return 1 if (found or failures or any(not r["ok"] for r in raised_ins)) else 0


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
    engine = {"name": "COMPLIANCE: file the certificate paid for on 2026-09-21 - house",
              "description": "PROPERTY COMPLIANCE — %s. A compliance payment left the bank." % FILING_TASK_MARK,
              "attachments": [], "notes": ""}
    check("an engine filing task always owes its filing", certificate_owed(engine, []) != "")
    check("an engine filing task is settled by its certificate", certificate_owed(engine, [{"hasFile": True}]) == "")
    check("an engine filing task is settled by a declared reason",
          certificate_owed(dict(engine, notes="%s it was a repair" % NO_CERTIFICATE_MARK), []) == "")
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


def _covers_with_keys(task, item, properties):
    """task_covers with the property keys built from a property list (JSON door)."""
    keys = property_keys(properties)
    return task_covers(task, item, keys.get(item["propertyId"]), keys)


def _insurance_with_keys(pages, open_tasks, keyed_tasks, properties, today):
    return insurance_actions(pages, open_tasks, keyed_tasks, property_keys(properties), today)


def _plan_order_list(texts, properties):
    return sorted([pid, t, r] for (pid, t), r in plan_order(texts, properties).items())


def main(argv):
    if argv[:1] == ["selftest"]:
        return selftest()
    if argv[:1] == ["daily"]:
        extra = [a for a in argv[1:] if a != "--apply"]
        if extra:
            sys.exit("usage: certificate_watch.py daily [--apply]")
        sys.exit(cmd_daily("--apply" in argv[1:]))
    if argv[:1] == ["run"] and len(argv) == 2:
        # {"fn": "...", "args": {...}} on the command line, the result as JSON on
        # stdout. Lets the JS test suite drive the real functions.
        call = json.loads(argv[1])
        fn = {"is_placeholder": is_placeholder, "has_real_file": has_real_file,
              "names_certificate": names_certificate, "certificate_owed": certificate_owed,
              "paid_without_certificate": paid_without_certificate,
              "purchase_block": purchase_block, "cert_types_named": cert_types_named,
              "type_named": type_named, "missed_items": missed_items,
              "task_covers": _covers_with_keys, "recently_closed": recently_closed,
              "plan_order": _plan_order_list, "order_key": order_key,
              "parse_premium": parse_premium, "insurance_actions": _insurance_with_keys,
              "premium_rises": premium_rises, "missed_task_fields": missed_task_fields,
              "insurance_task_fields": insurance_task_fields,
              "watch_summary": watch_summary}.get(call.get("fn"))
        if not fn:
            sys.exit("unknown function %r" % call.get("fn"))
        print(json.dumps(fn(**call.get("args", {}))))
        return None
    sys.exit("usage: certificate_watch.py selftest | daily [--apply] | run '<json>'")


if __name__ == "__main__":
    main(sys.argv[1:])
