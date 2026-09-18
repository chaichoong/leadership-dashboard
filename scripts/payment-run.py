#!/usr/bin/env python3
"""Payment Run — the mechanics behind Kevin's Friday payment run.

WHY THIS EXISTS
Kevin pays his suppliers once a week, on a Friday evening. Until 18 Sep 2026
the list he worked from came from a Google Apps Script that synced the Gmail
label "3: to pay" into the Dashboard Invoices table. That pipeline depended on
Kevin hand-labelling every invoice email. He stopped labelling, so the feed
stopped: the label held ZERO messages and the newest row in the table was dated
10 Jul 2026 — seventy days stale, with no error anywhere, because a sync that
finds nothing to do looks exactly like a sync with nothing to do.

It had two more faults that only showed up in the stored data:

  * no dedupe. 50 of 144 Gmail message ids appeared TWICE, so every invoice was
    on the list twice and the 90 "unpaid" rows were really 49 payables;
  * it never read attachments. 14 of those 49 had no amount at all, because the
    invoice was a PDF with an empty covering email. A payment list that cannot
    tell you the amount is not a payment list.

This script replaces the ingest. It finds payment requests itself across BOTH
of Kevin's mailboxes, opens the PDFs, and refuses to show him anything a
transaction says is already paid. The JUDGEMENT — is this actually a payable,
and what are its payee, amount, reference and bank details — lives in the skill
(~/.claude/scheduled-tasks/payment-run/SKILL.md). This file is the mechanics:

  * talks to the drive-upload worker's /gmail/* endpoints, the only headless
    path into Gmail, holding the TRIAGE-ONLY key (read and label, never send);
  * bounds the week: last Friday 21:00 to this Friday 21:00, Europe/London.
    Kevin's cutoff, moved from 16:00 to 21:00 on 18 Sep 2026 because invoices
    often arrive late in the day;
  * pre-filters mechanically and CONSERVATIVELY, so the model only reads
    plausible payables. A broad keyword query returns ~201 matches in 8 days of
    which roughly 3 are real, so an unfiltered model pass is unaffordable; but
    a pre-filter that drops a real invoice is a missed payment, so every drop
    rule below requires the ABSENCE of a money signal, never the presence of a
    marketing one;
  * upserts on Gmail Message ID, which is what kills the duplicate bug at
    source — and keeps killing it, so the old Apps Script trigger can keep
    running harmlessly without anyone having to switch it off;
  * flags a payee whose bank details have CHANGED since the last invoice.
    Supplier payment-redirection fraud is the one way this list could cost real
    money, and a changed sort code must never slip past as an ordinary row.

PRIVACY: the repo is PUBLIC. Nothing here writes email content, amounts, or
bank details into the repo. Scan output goes to the run's scratch directory and
the Airtable base, never to monitoring/ or any committed file.

USAGE
  payment-run.py window [--asof ISO]      the run window as JSON. Friday 21:00
                                          to Friday 21:00, Europe/London.
  payment-run.py scan [--asof ISO] [--back-days N] [--max-attachments N]
                                          JSON: candidate payment emails in the
                                          window from both mailboxes, each with
                                          its body excerpt and the extracted
                                          text of any PDF attachment. Carries a
                                          `truncated` flag per account — a
                                          capped listing must never be reported
                                          as a complete week.
  payment-run.py check                    cross-reference every open row against
                                          Transactions; prints what is already
                                          paid and why, writes nothing.
  payment-run.py write --items FILE       upsert the model's classified items
                                          (JSON list) keyed on Gmail Message ID.
  payment-run.py cleanse [--apply]        one-off: delete exact duplicate rows,
                                          mark transaction-matched rows Paid,
                                          move pre-window survivors to Historic
                                          for the creditor agent. DRY BY DEFAULT.
  payment-run.py report [--asof ISO]      the human-readable payment run.
  payment-run.py selftest                 offline checks of the pure functions.

Nothing in this file sends email, pays anything, or deletes a Gmail message.
"""

import argparse
import base64
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

LONDON = ZoneInfo("Europe/London")

WORKER_URL = "https://drive-upload.kevinbrittain.workers.dev"
TRIAGE_KEY_FILE = Path.home() / ".config/od/gmail_triage_key"
AIRTABLE_PAT_FILE = Path.home() / ".config/od/airtable_pat"

# Both mailboxes. The Apps Script only ever saw the first, which is why every
# supplier invoice sent to the letting-agent address (Sam Eason, P&P Property
# Maintenance, Serco all have their own labels there) was invisible to the
# payment list.
ACCOUNTS = ("kevin@runpreneur.org.uk", "info@agilelets.co.uk")

BASE = "appnqjDpqDniH3IRl"
T_INVOICES = "tblkOTKIG2Tyiy9aM"     # Dashboard Invoices
T_TRANSACTIONS = "tbln0gzhCAorFc3zB"  # Transactions
T_TASKS = "tblqB8b22hKBL4PF1"        # Tasks (creditor agent MARK FOR PAYMENT lane)

STATE_DIR = Path.home() / "knowledge-os/logs/payment-run"

# Kevin's cutoff: Friday 21:00 Europe/London (moved from 16:00 on 18 Sep 2026 —
# "quite often things come in quite late"). Monday=0 ... Friday=4.
CUTOFF_WEEKDAY = 4
CUTOFF_HOUR = 21

# Gmail listing is capped at 25 messages per worker call (one Gmail fetch per
# message inside a 50-subrequest budget), so pages are followed up to this many
# times PER ACCOUNT. Twelve pages is 300 messages. A week of the NARROW query
# listed 273 and 83 on the two accounts, so this leaves real headroom; the
# earlier four-page cap truncated the main account's week without anyone
# noticing, which is exactly the failure this run exists to stop. Hitting the
# cap sets `truncated`, which the skill must report rather than quietly treat
# as a complete week.
MAX_PAGES = 12
# Attachments are the expensive part — one worker call and a full download each.
# The cap is per run across both accounts. A run that hits it says so.
MAX_ATTACHMENTS = 40
# Bytes. Above this a PDF is not downloaded: a 30MB scan of a letter is never
# the invoice, and it would spend the whole run's budget on one message.
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
# Seconds between listing pages and between attachment downloads. A weekly run
# is not in a hurry; Gmail's per-minute metric is the binding constraint.
PAGE_PACE_SECONDS = 2.0
ATTACHMENT_PACE_SECONDS = 1.0

MAX_ATTEMPTS = 4
BACKOFF_BASE_SECONDS = 2
_calls = {"n": 0, "attachments": 0}

# ── Gmail quota classification ───────────────────────────────────────────────
# A weekly run lists ~300 messages in a burst, so it WILL hit Gmail's
# per-minute metric — the first live run did, on its second account. The worker
# re-wraps Google's 403 inside a 500, so the status code alone says "transient,
# retry in two seconds", and every one of those retries is certain to fail
# because a per-minute metric refills on a minute boundary.
#
# This classification is the same one `scripts/inbound-triage.py` arrived at the
# hard way (finding 20260907-daily-ops-488). The two copies MUST stay in step:
# `tests/payment-run-quota-parity.test.js` fails if they ever disagree.
DAILY_QUOTA_MARKERS = ("per day", "daily limit", "dailylimitexceeded")
SHORT_WINDOW_MARKERS = ("per minute", "per second")
QUOTA_SENTENCE_MARKERS = ("quotaexceeded", "quota exceeded for quota metric")
RATE_LIMIT_MARKERS = ("ratelimitexceeded", "userratelimitexceeded", "backenderror",
                      "service unavailable", "internal error", "try again")
RETRY_STATUSES = (429, 500, 502, 503, 504)
# A per-minute metric refills on a minute boundary, so anything shorter is a
# retry certain to fail. Five seconds of headroom for clock skew.
SHORT_WINDOW_WAIT_SECONDS = 65
# One run must not become an hour of sleeping.
MAX_SLOWDOWN_SECONDS = 900
_slowdown = {"waited": 0}


def classify_worker_error(code, body):
    """('retry'|'slowdown'|'quota'|'stop', why) for a non-200 from the worker.

    Pure, so the selftest covers every branch offline. The BODY is read before
    the status, because the worker re-wraps Google's 403 as a 500."""
    text = (body or "").lower()
    quota_shaped = any(m in text for m in QUOTA_SENTENCE_MARKERS)
    if any(m in text for m in DAILY_QUOTA_MARKERS):
        return "quota", "Gmail daily quota is exhausted"
    if quota_shaped and any(m in text for m in SHORT_WINDOW_MARKERS):
        return "slowdown", "Gmail short-window rate metric; it refills in about a minute"
    if quota_shaped:
        # Quota-shaped but the window is not named. Google's per-day cap is a
        # billion units, so the odds favour a short window — but this run cannot
        # prove it, so wait the minute rather than throwing the week away.
        return "slowdown", "Gmail quota error with no metric window named; waiting a minute"
    if code == 409:
        return "stop", "Gmail not connected on the worker"
    if any(m in text for m in RATE_LIMIT_MARKERS):
        return "retry", "Gmail rate limit or transient backend error"
    if code in RETRY_STATUSES:
        return "retry", "worker answered %s" % code
    return "stop", "worker answered %s" % code


# ══════════════════════════════════════════════════════════════════════════
# Secrets and transport
# ══════════════════════════════════════════════════════════════════════════

def read_secret(path, what):
    try:
        value = Path(path).read_text().strip()
    except OSError as exc:
        fail("cannot read the %s at %s: %s" % (what, path, exc))
    if not value:
        fail("the %s at %s is empty" % (what, path))
    return value


def fail(msg, kind="error"):
    print("PAYMENT RUN %s: %s" % (kind.upper(), msg), file=sys.stderr)
    sys.exit(1)


def backoff_seconds(attempt):
    return min(2 ** attempt, 30)


def worker_post(path, payload, account, sleep=time.sleep):
    key = read_secret(TRIAGE_KEY_FILE, "gmail triage key")
    payload = dict(payload)
    # Always name the mailbox. The worker's default account is the SENDER
    # default, which is a different mailbox entirely.
    payload["account"] = account
    req = urllib.request.Request(
        WORKER_URL + path,
        data=json.dumps(payload).encode(),
        # Cloudflare's browser integrity check rejects the default urllib user
        # agent with error 1010; any honest non-default UA satisfies it.
        headers={"Authorization": "Bearer " + key,
                 "Content-Type": "application/json",
                 "User-Agent": "od-payment-run/1.0"},
        method="POST",
    )
    _calls["n"] += 1
    body = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
                body = res.read().decode()
            break
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:400]
            action, why = classify_worker_error(exc.code, detail)
            if action == "quota":
                # The day is gone and no back-off cures it. Nothing has been
                # written, so next Friday's run picks this week up whole.
                fail("Gmail daily quota exhausted on %s (%s). Nothing was "
                     "written and no state moved. Detail: %s"
                     % (account, why, detail), kind="quota")
            if action == "slowdown":
                # NOT the day gone — a per-minute metric that refills on a
                # minute boundary. Waiting seconds guarantees another failure.
                if (attempt == MAX_ATTEMPTS
                        or _slowdown["waited"] + SHORT_WINDOW_WAIT_SECONDS > MAX_SLOWDOWN_SECONDS):
                    fail("Gmail rate metric still full after %ds of waiting on "
                         "%s (%s). Nothing written; the week is INCOMPLETE. "
                         "Detail: %s" % (_slowdown["waited"], account, why, detail),
                         kind="rate")
                _slowdown["waited"] += SHORT_WINDOW_WAIT_SECONDS
                sleep(SHORT_WINDOW_WAIT_SECONDS)
                continue
            if action == "stop":
                if exc.code == 409:
                    fail("Gmail not connected for %s on the worker (409). Kevin "
                         "grants once at %s/auth/gmail?account=%s. Detail: %s"
                         % (account, WORKER_URL, account, detail), kind="auth")
                fail("worker %s answered %d for %s: %s"
                     % (path, exc.code, account, detail))
            if attempt == MAX_ATTEMPTS:
                fail("worker %s still failing after %d attempts (%s): %s"
                     % (path, MAX_ATTEMPTS, why, detail))
            sleep(backoff_seconds(attempt))
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == MAX_ATTEMPTS:
                fail("worker %s unreachable after %d attempts: %s"
                     % (path, MAX_ATTEMPTS, exc))
            sleep(backoff_seconds(attempt))
    try:
        return json.loads(body)
    except (ValueError, TypeError):
        fail("worker %s returned non-JSON (%s...)" % (path, str(body)[:120]))


def airtable_request(method, path, payload=None, what="Airtable call"):
    pat = read_secret(AIRTABLE_PAT_FILE, "Airtable PAT")
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        "https://api.airtable.com/v0/" + path.lstrip("/"),
        data=data,
        headers={"Authorization": "Bearer " + pat,
                 "Content-Type": "application/json",
                 "User-Agent": "od-payment-run/1.0"},
        method=method,
    )
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:400]
            # 429 is Airtable's rate limit — back off rather than give up.
            if exc.code == 429 and attempt < MAX_ATTEMPTS:
                time.sleep(backoff_seconds(attempt))
                continue
            fail("%s failed (%d): %s" % (what, exc.code, detail))
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == MAX_ATTEMPTS:
                fail("%s unreachable: %s" % (what, exc))
            time.sleep(backoff_seconds(attempt))


def airtable_list(table, params=None, what=None):
    """Every record, following the offset. A hand-rolled read that forgets the
    offset token silently measures the first page and reports it as the whole
    table — this platform has shipped that bug before (the AI Reconciliation
    Accuracy card, 6 Aug 2026), so the pagination lives in one place."""
    what = what or ("list " + table)
    out, offset = [], None
    while True:
        query = dict(params or {})
        query["pageSize"] = "100"
        if offset:
            query["offset"] = offset
        data = airtable_request(
            "GET", "%s/%s?%s" % (BASE, table, urllib.parse.urlencode(query, doseq=True)),
            what=what)
        out.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            return out


def airtable_write(table, method, records, what):
    """Batched create/update, 10 at a time (Airtable's limit)."""
    done = []
    for i in range(0, len(records), 10):
        chunk = records[i:i + 10]
        data = airtable_request(method, "%s/%s" % (BASE, table),
                                {"records": chunk, "typecast": True}, what=what)
        done.extend(data.get("records", []))
        time.sleep(0.25)  # stay under Airtable's 5 requests/second
    return done


def airtable_delete(table, ids, what):
    done = []
    for i in range(0, len(ids), 10):
        chunk = ids[i:i + 10]
        query = urllib.parse.urlencode([("records[]", r) for r in chunk])
        data = airtable_request("DELETE", "%s/%s?%s" % (BASE, table, query), what=what)
        done.extend(data.get("records", []))
        time.sleep(0.25)
    return done


# ══════════════════════════════════════════════════════════════════════════
# The week
# ══════════════════════════════════════════════════════════════════════════

def run_window(asof=None):
    """(start, end) of the payment-run week, both timezone-aware London times.

    The end is the NEXT cutoff at or after `asof`: on a Friday before 21:00 the
    week still ends tonight, and the moment it passes 21:00 a new week opens.
    Kept as a pure function because the boundary is exactly the sort of thing
    that is wrong by a day for a month before anyone notices."""
    now = (asof or datetime.now(LONDON)).astimezone(LONDON)
    days_ahead = (CUTOFF_WEEKDAY - now.weekday()) % 7
    end = (now + timedelta(days=days_ahead)).replace(
        hour=CUTOFF_HOUR, minute=0, second=0, microsecond=0)
    if end <= now:
        end += timedelta(days=7)
    return end - timedelta(days=7), end


def cmd_window(args):
    start, end = run_window(parse_asof(args.asof))
    print(json.dumps({
        "start": start.isoformat(),
        "end": end.isoformat(),
        "label": "Week to %s" % end.strftime("%a %-d %b %Y, %-I%p").replace("PM", "pm").replace("AM", "am"),
    }, indent=2))


def parse_asof(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        fail("--asof must be an ISO datetime, got %r" % value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=LONDON)


# ══════════════════════════════════════════════════════════════════════════
# Money signals and the conservative pre-filter
# ══════════════════════════════════════════════════════════════════════════

# £1,234.56 / £90 / GBP 1234.56 / 1,234.56 GBP. Deliberately does NOT match a
# bare number: "call me on 90" is not ninety pounds.
MONEY_RE = re.compile(
    r"(?:£|\bGBP\s*)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)"
    r"|(\d{1,3}(?:,\d{3})*\.\d{2})\s*(?:GBP|pounds)\b",
    re.I)

PAYMENT_WORDS = (
    "invoice", "amount due", "amount payable", "payment due", "remittance",
    "balance due", "outstanding balance", "please pay", "payable", "statement",
    "bill", "fee", "subscription renewal", "renewal", "account number",
    "sort code", "bacs", "overdue", "arrears", "final notice", "quotation",
)

# A bounce is not an invoice. The old pipeline recorded a Mail Delivery
# Subsystem failure notice as a £78.82 payable, because the bounced message's
# own text came back inside it.
BOUNCE_SENDERS = ("mailer-daemon", "postmaster@")
BOUNCE_SUBJECTS = ("delivery status notification", "undeliverable",
                   "returned mail", "mail delivery failed", "delivery has failed")

# Money coming IN, or money already gone, is never something to pay on Friday.
# This is a DIRECTION check, not a guess about marketing, which is why it is
# safe to apply mechanically: 35 of the 184 candidates in the week to 18 Sep
# 2026 were Square's "has sent you £x" card takings, and a payment list that
# includes your own income is worse than no list.
#
# Deliberately narrow. "Payment failed", "payment overdue" and "payment
# reminder" must all survive — those say something is STILL owed — so no
# pattern here matches the bare word "payment".
INBOUND_MONEY_RE = re.compile(
    r"has sent you|sent you £|you'?ve been paid|payment received|"
    r"we'?ve received your payment|we have received your payment|"
    r"thank you for your payment|thanks for your payment|"
    r"your payment .{0,20}(?:was|has been) (?:successful|received|processed)|"
    r"successful payment|payment confirmation|receipt for your payment|"
    r"refund (?:of|issued|processed)|has been refunded",
    re.I)


SUBJECT_PREFIX_RE = re.compile(r"^\s*(?:re|fw|fwd|aw|tr)\s*:\s*", re.I)


def sender_email(from_header):
    """The bare address out of a From header. `Roy Lavin <roy@x.com>` → roy@x.com."""
    match = re.search(r"<([^>]+)>", from_header or "")
    raw = match.group(1) if match else (from_header or "")
    return raw.strip().strip('"').lower()


def normalise_subject(subject):
    text = subject or ""
    while True:
        stripped = SUBJECT_PREFIX_RE.sub("", text)
        if stripped == text:
            break
        text = stripped
    return re.sub(r"\s+", " ", text).strip().lower()


def duplicate_key(headers):
    """Sender plus de-prefixed subject: the same invoice seen twice.

    Kevin's suppliers reach him at BOTH mailboxes — Roy's "Fwd: LGSR 55Elmdon"
    lands at kevin@runpreneur.org.uk AND info@agilelets.co.uk as two different
    Gmail messages carrying one £90 invoice. The Message-ID upsert key cannot
    see that, so without this the payment list shows every such invoice twice,
    which is the fault the old pipeline had and the reason Kevin asked for this.

    This key GROUPS; it never folds on its own. The scan reports the group and
    the skill writes one row naming every message in it, so a grouping Kevin
    disagrees with is visible rather than a payable silently destroyed — the
    same rule the approval gate's duplicate handling arrived at on 28 Aug 2026."""
    return "%s|%s" % (sender_email(headers.get("from")),
                      normalise_subject(headers.get("subject")))


def find_amounts(text):
    """Every £ amount in the text, largest first, as floats."""
    out = []
    for match in MONEY_RE.finditer(text or ""):
        raw = match.group(1) or match.group(2) or ""
        try:
            out.append(float(raw.replace(",", "")))
        except ValueError:
            continue
    return sorted(set(out), reverse=True)


def is_bounce(headers, subject):
    sender = (headers.get("from") or "").lower()
    subj = (subject or "").lower()
    if any(marker in sender for marker in BOUNCE_SENDERS):
        return True
    return any(marker in subj for marker in BOUNCE_SUBJECTS)


def prefilter(message):
    """(keep: bool, reason: str) — the CONSERVATIVE mechanical cut.

    The asymmetry matters and is the whole design of this function. A false
    keep costs a few hundred tokens when the model reads it and says no. A
    false drop is an invoice Kevin never pays and a supplier who chases him.
    So nothing is dropped for LOOKING like marketing; a message is only ever
    dropped for having NO money signal at all. Kevin's own utility bills and
    domain renewals carry List-Unsubscribe headers, which is exactly why that
    header can never be a drop reason on its own."""
    headers = message.get("headers") or {}
    subject = headers.get("subject") or ""
    body = message.get("body") or ""
    attachments = message.get("attachments") or []

    if is_bounce(headers, subject):
        return False, "bounce or delivery-status notice"

    # The direction check runs on the SUBJECT only. A real invoice's body can
    # easily carry "thank you for your payment" as boilerplate about a previous
    # one; its subject will not.
    if INBOUND_MONEY_RE.search(subject):
        return False, "money in, or already settled"

    haystack = (subject + "\n" + body).lower()
    has_money = bool(find_amounts(subject + "\n" + body))
    has_word = any(word in haystack for word in PAYMENT_WORDS)
    # A PDF or spreadsheet attachment is a money signal in its own right: the
    # commonest real invoice in this inbox is a PDF with an empty covering
    # email, which has neither an amount nor a keyword in its body.
    has_doc = any(
        (a.get("filename") or "").lower().endswith((".pdf", ".csv", ".xlsx", ".xls"))
        for a in attachments)

    if not (has_money or has_word or has_doc):
        return False, "no amount, no payment wording, no document attached"

    # An automatic reply with no money in it is a machine receipt, never a
    # payable. With money in it, it goes to the model — a "thank you for your
    # payment of £x" receipt is a useful signal that something is already paid.
    auto = any(headers.get(h) for h in
               ("auto-submitted", "x-autoreply", "x-autorespond"))
    if auto and not has_money and not has_doc:
        return False, "automatic reply with no amount"

    if not has_money and not has_doc and has_word:
        # Wording alone, no figure and nothing attached. Newsletters about
        # "invoice software" land here. Keep it only if the wording is one of
        # the strong ones — those name an obligation rather than a topic.
        strong = ("amount due", "amount payable", "payment due", "balance due",
                  "outstanding balance", "please pay", "overdue", "arrears",
                  "final notice", "remittance", "sort code")
        if not any(word in haystack for word in strong):
            return False, "payment wording only, no amount and nothing attached"

    return True, "candidate"


# ══════════════════════════════════════════════════════════════════════════
# Attachments
# ══════════════════════════════════════════════════════════════════════════

def extract_pdf_text(raw, max_pages=5):
    try:
        import pypdf
    except ImportError:
        return "", "pypdf not installed"
    try:
        reader = pypdf.PdfReader(io.BytesIO(raw))
        pages = reader.pages[:max_pages]
        text = "\n".join((p.extract_text() or "") for p in pages)
        return text.strip(), None
    except Exception as exc:                      # noqa: BLE001 — any malformed PDF
        return "", "pdf read failed: %s" % exc


def fetch_attachment_text(message, account, budget):
    """Extracted text of the message's document attachments, within budget.

    Returns (list of {filename, chars, text, error}, budget_hit: bool). Only
    PDFs are read: a .jpeg of a gas certificate carries no machine-readable
    amount, and downloading it would spend the run's budget for nothing."""
    out, budget_hit = [], False
    for att in (message.get("attachments") or []):
        name = (att.get("filename") or "")
        if not name.lower().endswith(".pdf"):
            continue
        if att.get("size", 0) > MAX_ATTACHMENT_BYTES:
            out.append({"filename": name, "chars": 0, "text": "",
                        "error": "skipped: %d bytes is too large to be an invoice"
                                 % att.get("size", 0)})
            continue
        if _calls["attachments"] >= budget:
            budget_hit = True
            out.append({"filename": name, "chars": 0, "text": "",
                        "error": "skipped: run attachment budget spent"})
            continue
        _calls["attachments"] += 1
        if _calls["attachments"] > 1:
            time.sleep(ATTACHMENT_PACE_SECONDS)
        got = worker_post("/gmail/attachment",
                          {"messageId": message["id"],
                           "attachmentId": att["attachmentId"]}, account)
        data = got.get("data") or ""
        raw = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
        text, error = extract_pdf_text(raw)
        out.append({"filename": name, "chars": len(text), "text": text[:6000],
                    "error": error})
    return out, budget_hit


# ══════════════════════════════════════════════════════════════════════════
# scan
# ══════════════════════════════════════════════════════════════════════════

# Gmail-side narrowing. Listing the whole week unfiltered returned 300 messages
# on the main account and STILL reported more pages, so the run was silently
# reading a partial week. This clause cut the listing to 273 and 83 without
# truncating.
#
# Back-tested on the week to 18 Sep 2026 against the unfiltered listing: the 46
# candidates it removes are Skyscanner, LinkedIn, Tesco, Patisserie Valerie,
# Just Eat, Rightmove and Square's card-takings notices. Not one real payable
# was lost. Re-run that comparison before changing this clause — a term deleted
# here is an invoice nobody ever sees, and it fails silently.
#
# `has:attachment` is the load-bearing term: the commonest real invoice in this
# inbox is a PDF with an empty covering email that matches no keyword at all.
NARROW_TERMS = (
    '(has:attachment OR invoice OR invoices OR payment OR payable OR bill '
    'OR billing OR "amount due" OR "sort code" OR remittance OR overdue '
    'OR arrears OR fee OR fees OR statement OR renewal OR subscription '
    'OR receipt OR quote OR quotation OR charge)'
)


def gmail_query(start, end, back_days):
    """Gmail's after:/before: take epoch seconds, which is exact. The `newer_than`
    form is day-granular and would silently widen the window."""
    lower = start - timedelta(days=back_days or 0)
    return "after:%d before:%d -in:chats %s" % (
        int(lower.timestamp()), int(end.timestamp()), NARROW_TERMS)


def list_account(account, query):
    """Follow nextPageToken up to MAX_PAGES. (messages, truncated).

    `truncated=True` means Gmail had MORE than this run fetched: the caller
    must report an incomplete week rather than present it as the whole one.

    The pause between pages is not politeness. Each page is 25 Gmail message
    fetches, and a full run is ~300 across two mailboxes; without pacing the
    burst exhausts the per-minute metric partway through, which is how the
    first live run died."""
    messages, token = [], None
    for page in range(MAX_PAGES):
        payload = {"q": query, "maxResults": 25}
        if token:
            payload["pageToken"] = token
        data = worker_post("/gmail/list", payload, account)
        messages.extend(data.get("messages", []))
        token = data.get("nextPageToken")
        if not token:
            return messages, False
        if page < MAX_PAGES - 1:
            time.sleep(PAGE_PACE_SECONDS)
    return messages, True


def cmd_scan(args):
    start, end = run_window(parse_asof(args.asof))
    query = gmail_query(start, end, args.back_days)
    budget = args.max_attachments
    accounts_out, kept_total, seen_total = [], 0, 0

    for account in ACCOUNTS:
        messages, truncated = list_account(account, query)
        seen_total += len(messages)
        kept, dropped = [], []
        for msg in messages:
            keep, reason = prefilter(msg)
            headers = msg.get("headers") or {}
            summary = {
                "id": msg["id"],
                "threadId": msg.get("threadId"),
                "account": account,
                "date": headers.get("date", ""),
                "internalDate": msg.get("internalDate"),
                "from": headers.get("from", ""),
                "subject": headers.get("subject", ""),
                "gmailUrl": "https://mail.google.com/mail/u/0/#all/%s" % msg["id"],
                "duplicateKey": duplicate_key(headers),
            }
            if not keep:
                dropped.append(dict(summary, reason=reason))
                continue
            attachments, budget_hit = fetch_attachment_text(msg, account, budget)
            if budget_hit:
                truncated = True
            summary.update({
                "body": (msg.get("body") or "")[:4000],
                "amountsInBody": find_amounts(
                    (headers.get("subject") or "") + "\n" + (msg.get("body") or "")),
                "attachments": attachments,
                "attachmentNames": [a.get("filename") for a in (msg.get("attachments") or [])],
            })
            kept.append(summary)
        kept_total += len(kept)
        accounts_out.append({
            "account": account,
            "listed": len(messages),
            "candidates": len(kept),
            "truncated": truncated,
            "messages": kept,
            "droppedSummary": summarise_drops(dropped),
        })

    # Group the same invoice seen in both mailboxes (or twice in one thread).
    # Reported as its own section so the skill writes ONE row per matter and
    # can see, rather than guess, what was grouped with what.
    groups = {}
    for account in accounts_out:
        for msg in account["messages"]:
            groups.setdefault(msg["duplicateKey"], []).append(msg)
    duplicate_groups = [
        {"key": key,
         "messages": [{"id": m["id"], "account": m["account"], "date": m["date"],
                       "subject": m["subject"]} for m in sorted(
                           members, key=lambda x: x.get("internalDate") or 0, reverse=True)]}
        for key, members in groups.items() if len(members) > 1
    ]

    print(json.dumps({
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "query": query,
        "listed": seen_total,
        "candidates": kept_total,
        "distinctMatters": len(groups),
        "attachmentsRead": _calls["attachments"],
        "duplicateGroups": duplicate_groups,
        "accounts": accounts_out,
    }, indent=2))


def summarise_drops(dropped):
    """Counts per reason, plus the senders dropped — never the bodies. The
    repo is public and the digest has to stay content-free, but a drop nobody
    can audit is a drop nobody can correct."""
    counts = {}
    for item in dropped:
        counts[item["reason"]] = counts.get(item["reason"], 0) + 1
    return {"total": len(dropped), "byReason": counts,
            "senders": sorted({d["from"][:60] for d in dropped})[:40]}


# ══════════════════════════════════════════════════════════════════════════
# check — nothing already paid reaches the list
# ══════════════════════════════════════════════════════════════════════════

def load_open_invoices():
    return [r for r in airtable_list(T_INVOICES, what="Dashboard Invoices")
            if status_of(r) in ("Unpaid", "")]


def status_of(record):
    value = record.get("fields", {}).get("Status")
    if isinstance(value, dict):
        return value.get("name", "")
    return value or ""


def load_outflows(since):
    """Money OUT since `since`. The control is printed by the caller: a
    filterByFormula with a wrong field name returns 200 OK and an empty list,
    which is indistinguishable from a genuinely quiet bank account."""
    formula = "AND(IS_AFTER({**Date}, '%s'), {**GBP} < 0)" % since
    return airtable_list(T_TRANSACTIONS,
                         {"filterByFormula": formula,
                          "fields[]": ["*Name", "**Date", "**GBP", "*Vendor"]},
                         what="Transactions outflows")


def payee_tokens(name):
    """Words from a payee worth matching a bank memo against. Four characters
    and up, so "ltd", "the" and initials never corroborate anything on their
    own, and an email address contributes nothing useful."""
    if not name or "@" in str(name):
        return set()
    stop = {"limited", "ltd", "the", "and", "group", "services", "service",
            "company", "council", "energy", "water", "invoice", "payment"}
    words = re.findall(r"[a-z]{4,}", str(name).lower())
    return {w for w in words if w not in stop}


def match_transaction(invoice, by_amount):
    """The transaction that paid this invoice, or None.

    Returns (tx, confidence) where confidence is "confirmed" or "probable".

    Deliberately strict on the two hard facts: the amount matches to the penny
    AND the payment is dated on or after the invoice email. A looser rule turns
    any coincidental £90 into a payment and hides a bill Kevin still owes.

    Amount and date alone are still not enough to HIDE a payable, though. The
    £180 to Shaun Lingham matched on 18 Sep 2026 because the bank memo really
    did read "Shaun Lingham 55 Elmdon" — but nothing in that test looked at the
    payee, so an unrelated £180 on the right day would have hidden the invoice
    just as confidently. So the payee must corroborate: a shared word between
    the payee and the bank memo makes it `confirmed` and the row is hidden;
    without one it is `probable` and the row STAYS on the list carrying a note.
    Kevin dismissing a paid row costs seconds; a supplier never being paid
    costs a relationship."""
    fields = invoice.get("fields", {})
    amount = fields.get("Amount")
    if amount is None:
        return None
    email_date = (fields.get("Email Date") or "")[:10]
    tokens = payee_tokens(fields.get("Payee"))
    candidates = by_amount.get(round(abs(float(amount)), 2), [])
    best = None
    for tx in candidates:
        tx_fields = tx.get("fields", {})
        tx_date = (tx_fields.get("**Date") or "")[:10]
        if not (email_date and tx_date and tx_date >= email_date):
            continue
        memo = " ".join(str(tx_fields.get(k) or "")
                        for k in ("*Name", "*Vendor")).lower()
        if tokens and any(token in memo for token in tokens):
            return tx, "confirmed"
        best = best or (tx, "probable")
    return best


def index_by_amount(transactions):
    index = {}
    for tx in transactions:
        gbp = tx.get("fields", {}).get("**GBP")
        if gbp is None:
            continue
        index.setdefault(round(abs(float(gbp)), 2), []).append(tx)
    return index


def cmd_check(args):
    invoices = load_open_invoices()
    transactions = load_outflows(args.since)
    print("Open invoice rows: %d" % len(invoices))
    print("Outflow transactions since %s: %d   (CONTROL — a zero here means the "
          "query is broken, not that nothing was paid)" % (args.since, len(transactions)))
    if not transactions:
        fail("the outflow control matched nothing. Refusing to report every "
             "invoice as unpaid off a query that returned an empty list.")
    by_amount = index_by_amount(transactions)
    paid, probable, still_owed, no_amount = [], [], [], []
    for inv in invoices:
        if inv["fields"].get("Amount") is None:
            no_amount.append(inv)
            continue
        hit = match_transaction(inv, by_amount)
        if hit and hit[1] == "confirmed":
            paid.append((inv, hit[0]))
        elif hit:
            probable.append((inv, hit[0]))
        else:
            still_owed.append((inv, None))

    def line(inv, tx):
        f = inv["fields"]
        return "  £%9.2f | %s | %-28s | %s (%s) %s" % (
            float(f["Amount"]), (f.get("Email Date") or "")[:10],
            str(f.get("Payee"))[:28], tx["id"],
            (tx["fields"].get("**Date") or "")[:10],
            str(tx["fields"].get("*Name") or "")[:34])

    print("\nALREADY PAID, payee corroborated — hidden from the payment run (%d):" % len(paid))
    for inv, tx in paid:
        print(line(inv, tx))
    print("\nPROBABLE match on amount and date but the payee does NOT corroborate "
          "(%d) — these STAY on the list with a note:" % len(probable))
    for inv, tx in probable:
        print(line(inv, tx))
    owed_total = sum(float(i["fields"]["Amount"]) for i, _ in still_owed)
    print("\nSTILL OWED (%d): £%.2f" % (len(still_owed), owed_total))
    print("NO AMOUNT RECORDED — attachment never read (%d)" % len(no_amount))
    return {"paid": paid, "probable": probable,
            "stillOwed": still_owed, "noAmount": no_amount}


# ══════════════════════════════════════════════════════════════════════════
# write — upsert on Gmail Message ID
# ══════════════════════════════════════════════════════════════════════════

FIELD_MSG_ID = "Gmail Message ID"

WRITABLE = {
    "payee": "Payee",
    "description": "Description",
    "amount": "Amount",
    "emailDate": "Email Date",
    "dueDate": "Due Date",
    "reference": "Reference",
    "payToDetails": "Pay To Details",
    "gmailUrl": "Gmail URL",
    "threadId": "Gmail Thread ID",
    "status": "Status",
    "source": "Source",
    "runDate": "Run Date",
    "notes": "Notes",
    "hasAttachment": "Has Attachment",
    "hasPdf": "Has PDF",
    "bankDetailsChanged": "Bank Details Changed",
}


def index_by_message_id(records):
    """{messageId: [records]} across the whole table. The upsert key, and the
    reason the duplicate bug cannot come back: a second row for a message id
    that already exists is an UPDATE, never an insert."""
    index = {}
    for rec in records:
        mid = rec.get("fields", {}).get(FIELD_MSG_ID)
        if mid:
            index.setdefault(mid, []).append(rec)
    return index


def bank_details_changed(payee, details, existing_by_payee):
    """True when this payee has been paid before on DIFFERENT bank details.

    Supplier payment-redirection fraud works precisely because a changed sort
    code on a familiar invoice looks like an ordinary row. Comparison is on
    digits only, so reformatting ("20-00-00" to "200000") is not a change."""
    if not details or not payee:
        return False
    digits = re.sub(r"\D", "", details)
    if len(digits) < 8:          # nothing that could be a sort code + account
        return False
    for previous in existing_by_payee.get(payee.strip().lower(), []):
        prior = re.sub(r"\D", "", previous or "")
        if len(prior) >= 8 and prior != digits:
            return True
    return False


def cmd_write(args):
    items = json.loads(Path(args.items).read_text())
    if not isinstance(items, list):
        fail("--items must be a JSON list of classified payables")
    existing = airtable_list(T_INVOICES, what="Dashboard Invoices")
    by_msg = index_by_message_id(existing)
    by_payee = {}
    for rec in existing:
        fields = rec.get("fields", {})
        payee = str(fields.get("Payee") or "").strip().lower()
        if payee:
            by_payee.setdefault(payee, []).append(fields.get("Pay To Details"))

    run_date = (parse_asof(args.run_date) or datetime.now(LONDON)).date().isoformat()
    creates, updates, flagged = [], [], []
    for item in items:
        mid = item.get("messageId")
        if not mid:
            fail("every item needs a messageId — that is the upsert key")
        fields = {FIELD_MSG_ID: mid, WRITABLE["runDate"]: run_date}
        for key, column in WRITABLE.items():
            if key in ("runDate",) or key not in item:
                continue
            fields[column] = item[key]
        if bank_details_changed(item.get("payee"), item.get("payToDetails"), by_payee):
            fields[WRITABLE["bankDetailsChanged"]] = True
            flagged.append(item.get("payee"))
        if mid in by_msg:
            # Upsert. Where a message id already has SEVERAL rows (the legacy
            # duplicate bug), the first is updated and the rest are left for
            # `cleanse` to remove — this command never deletes.
            updates.append({"id": by_msg[mid][0]["id"], "fields": fields})
        else:
            creates.append({"fields": fields})

    if creates:
        airtable_write(T_INVOICES, "POST", creates, "create payment-run rows")
    if updates:
        airtable_write(T_INVOICES, "PATCH", updates, "update payment-run rows")
    print(json.dumps({"created": len(creates), "updated": len(updates),
                      "runDate": run_date,
                      "bankDetailsChanged": flagged}, indent=2))


# ══════════════════════════════════════════════════════════════════════════
# cleanse — the one-off tidy of the legacy rows
# ══════════════════════════════════════════════════════════════════════════

def plan_cleanse(records, by_amount, window_start):
    """(duplicates, mark_paid, to_historic) — pure, so the dry run and the
    apply run cannot disagree about what is about to happen."""
    # Dedupe the WHOLE table, not just the open rows. The first version of this
    # deduped only Unpaid rows and left nine duplicated message ids sitting
    # among the Paid ones — invisible on the payment list, but still the same
    # fault, and still there the next time anyone counts. A duplicate row is a
    # duplicate row whatever its status.
    duplicates, kept_rows = [], []
    for _mid, rows in index_by_message_id(records).items():
        if len(rows) > 1:
            # Keep the best-populated row: a settled status first (it carries
            # the Paid Date and the matched transaction), then an Amount, then
            # whichever row simply holds more.
            rows = sorted(rows, key=lambda r: (
                status_of(r) not in ("Paid", "Historic"),
                r["fields"].get("Amount") is None,
                -len(r["fields"])))
            duplicates.extend(rows[1:])
        kept_rows.append(rows[0])
    # Rows with no message id at all cannot be deduped; they still get checked.
    kept_rows.extend([r for r in records if not r["fields"].get(FIELD_MSG_ID)])
    survivors = [r for r in kept_rows if status_of(r) in ("Unpaid", "")]

    mark_paid, to_historic = [], []
    for rec in survivors:
        hit = match_transaction(rec, by_amount)
        # Only a payee-corroborated match closes a row. A "probable" one leaves
        # it open — it will show on the list carrying its note, which is the
        # safe direction to be wrong in.
        if hit and hit[1] == "confirmed":
            mark_paid.append((rec, hit[0]))
            continue
        email_date = (rec["fields"].get("Email Date") or "")[:10]
        if email_date and email_date < window_start:
            to_historic.append(rec)
    return duplicates, mark_paid, to_historic


def cmd_cleanse(args):
    records = airtable_list(T_INVOICES, what="Dashboard Invoices")
    transactions = load_outflows(args.since)
    if not transactions:
        fail("the outflow control matched nothing — refusing to cleanse off an "
             "empty transactions query.")
    by_amount = index_by_amount(transactions)
    start, _end = run_window(parse_asof(args.asof))
    duplicates, mark_paid, to_historic = plan_cleanse(
        records, by_amount, start.date().isoformat())

    print("CLEANSE PLAN  (%s)" % ("APPLYING" if args.apply else "DRY RUN — nothing written"))
    print("  table rows: %d" % len(records))
    print("  outflow transactions since %s: %d   (CONTROL, must be > 0)"
          % (args.since, len(transactions)))
    print("\n1. DELETE %d duplicate rows (same Gmail Message ID, keeping the "
          "better-populated one)" % len(duplicates))
    for rec in duplicates[:10]:
        f = rec["fields"]
        print("     %s | %-26s | %s" % (rec["id"], str(f.get("Payee"))[:26],
                                        str(f.get("Description"))[:34]))
    if len(duplicates) > 10:
        print("     ... and %d more" % (len(duplicates) - 10))
    print("\n2. MARK PAID %d rows a transaction already covers" % len(mark_paid))
    for rec, tx in mark_paid:
        f = rec["fields"]
        print("     £%9.2f | %-26s | paid by %s" % (
            float(f.get("Amount") or 0), str(f.get("Payee"))[:26], tx["id"]))
    print("\n3. REPORT ONLY — %d open rows predate the current week. NOTHING is "
          "moved by this command.\n   Whether one of these is old creditor debt "
          "(Utilita, HMRC, council tax: the creditor\n   agent's lane) or a "
          "genuine supplier invoice still owed (a contractor, a\n   membership, "
          "a trade-waste bill: Kevin's 'Still owed' list) is a judgement,\n   "
          "and a date cannot make it. The first version of this command moved\n"
          "   all 46 by date and buried £5,800 of real supplier invoices among "
          "the\n   creditor debt. Classify them, then move only the creditor "
          "ones with:\n     payment-run.py historic --ids rec1,rec2,...")
    for rec in to_historic:
        f = rec["fields"]
        amount = f.get("Amount")
        print("     %s | %s | %-28s | %s" % (
            ("£%9.2f" % float(amount)) if amount is not None else "  no amount",
            (f.get("Email Date") or "")[:10], str(f.get("Payee"))[:28],
            str(f.get("Description"))[:34]))

    if not args.apply:
        print("\nNothing was written. Re-run with --apply to carry this out.")
        return

    # Airtable has no undo and this Mac has no backup, so every row this is
    # about to delete or change is written out first, in full, with its record
    # id. Restoring is then a create from the file rather than an apology.
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    backup = STATE_DIR / ("cleanse-backup-%s.json"
                          % datetime.now(LONDON).strftime("%Y%m%d-%H%M%S"))
    backup.write_text(json.dumps({
        "takenAt": datetime.now(LONDON).isoformat(),
        "deleting": duplicates,
        "markingPaid": [rec for rec, _tx in mark_paid],
        "movingToHistoric": to_historic,
    }, indent=2))
    print("\nBackup of every affected row: %s" % backup)

    if duplicates:
        airtable_delete(T_INVOICES, [r["id"] for r in duplicates], "delete duplicate rows")
    if mark_paid:
        airtable_write(T_INVOICES, "PATCH", [
            {"id": rec["id"], "fields": {
                "Status": "Paid",
                "Paid Date": (tx["fields"].get("**Date") or "")[:10] or None,
                "Matched Transaction": [tx["id"]],
                "Notes": append_note(rec, "Marked paid by the payment-run cleanse: "
                                          "transaction %s matches to the penny." % tx["id"]),
            }} for rec, tx in mark_paid], "mark cleanse-matched rows paid")
    print("\nApplied: %d deleted, %d marked paid. %d pre-window rows were "
          "REPORTED and left untouched." % (len(duplicates), len(mark_paid), len(to_historic)))


def cmd_historic(args):
    """Move named rows to (or out of) the creditor agent's lane.

    Takes explicit record ids because the classification is a judgement the
    skill makes, never something a date decides — see the cleanse's step 3."""
    ids = [i.strip() for i in args.ids.split(",") if i.strip()]
    if not ids:
        fail("--ids needs at least one record id")
    status = "Unpaid" if args.restore else "Historic"
    note = (args.reason or ("Restored to the payment run: a genuine supplier "
                            "invoice still owed, not old creditor debt."
                            if args.restore else
                            "Moved to the creditor agent's lane: old creditor "
                            "debt, handled under the standing creditor script, "
                            "never on the Friday payment run."))
    records = [r for r in airtable_list(T_INVOICES, what="Dashboard Invoices")
               if r["id"] in ids]
    missing = set(ids) - {r["id"] for r in records}
    if missing:
        fail("these record ids are not in Dashboard Invoices: %s" % ", ".join(sorted(missing)))
    airtable_write(T_INVOICES, "PATCH", [
        {"id": rec["id"], "fields": {"Status": status,
                                     "Notes": append_note(rec, note)}}
        for rec in records], "set status %s" % status)
    for rec in records:
        f = rec["fields"]
        print("  %s -> %s | %s | %s" % (rec["id"], status, str(f.get("Payee"))[:28],
                                        str(f.get("Description"))[:44]))
    print("%d rows set to %s." % (len(records), status))


def append_note(record, line):
    stamp = datetime.now(LONDON).strftime("%-d %b %Y")
    existing = record.get("fields", {}).get("Notes") or ""
    entry = "[%s — payment-run] %s" % (stamp, line)
    return (existing + "\n" + entry).strip() if existing else entry


# ══════════════════════════════════════════════════════════════════════════
# report
# ══════════════════════════════════════════════════════════════════════════

def cmd_report(args):
    start, end = run_window(parse_asof(args.asof))
    records = airtable_list(T_INVOICES, what="Dashboard Invoices")
    open_rows = [r for r in records if status_of(r) == "Unpaid"]
    window_start = start.date().isoformat()
    this_week = [r for r in open_rows
                 if (r["fields"].get("Email Date") or "")[:10] >= window_start]
    still_owed = [r for r in open_rows if r not in this_week]

    def block(title, rows):
        total = sum(float(r["fields"].get("Amount") or 0) for r in rows)
        print("\n{} — {} items, £{:,.2f}".format(title, len(rows), total))
        for rec in sorted(rows, key=lambda r: -float(r["fields"].get("Amount") or 0)):
            f = rec["fields"]
            amount = f.get("Amount")
            flag = "  ⚠ BANK DETAILS CHANGED" if f.get("Bank Details Changed") else ""
            print("  %s | %-28s | ref %-16s | %s%s" % (
                ("£%9.2f" % float(amount)) if amount is not None else "  NO AMOUNT",
                str(f.get("Payee"))[:28], str(f.get("Reference") or "-")[:16],
                str(f.get("Description"))[:36], flag))

    print("PAYMENT RUN — week to %s" % end.strftime("%a %-d %b %Y, 9pm"))
    block("THIS WEEK", this_week)
    block("STILL OWED (carried forward)", still_owed)
    stamps = [r["fields"].get("Run Date") for r in records if r["fields"].get("Run Date")]
    print("\nLast run stamp on any row: %s" % (max(stamps) if stamps else "NONE"))


# ══════════════════════════════════════════════════════════════════════════
# selftest — offline, no network
# ══════════════════════════════════════════════════════════════════════════

def cmd_selftest(_args):
    failures = []

    def check(name, got, want):
        if got != want:
            failures.append("%s: got %r, want %r" % (name, got, want))

    # The window boundary. Friday 18 Sep 2026 at 20:59 is still last week's run.
    start, end = run_window(datetime(2026, 9, 18, 20, 59, tzinfo=LONDON))
    check("window ends Fri 18 Sep 21:00", end.isoformat(), "2026-09-18T21:00:00+01:00")
    check("window starts Fri 11 Sep 21:00", start.isoformat(), "2026-09-11T21:00:00+01:00")
    # One minute later a new week has opened.
    start2, end2 = run_window(datetime(2026, 9, 18, 21, 1, tzinfo=LONDON))
    check("after the cutoff the week rolls", end2.isoformat(), "2026-09-25T21:00:00+01:00")
    check("and its start is the old end", start2.isoformat(), end.isoformat())
    # Mid-week sits inside the week that ends on the coming Friday.
    _s3, e3 = run_window(datetime(2026, 9, 15, 9, 0, tzinfo=LONDON))
    check("Tuesday belongs to Friday's run", e3.isoformat(), "2026-09-18T21:00:00+01:00")
    # The clocks change on 25 Oct 2026; the cutoff stays 21:00 LOCAL.
    _s4, e4 = run_window(datetime(2026, 10, 28, 9, 0, tzinfo=LONDON))
    check("cutoff stays 21:00 local after the clocks change",
          e4.strftime("%Y-%m-%d %H:%M %Z"), "2026-10-30 21:00 GMT")

    # Money.
    check("finds a formatted amount", find_amounts("Total due £1,234.56 today"), [1234.56])
    check("finds GBP form", find_amounts("Amount: GBP 90.00"), [90.0])
    check("ignores a bare number", find_amounts("call me on 90"), [])
    check("largest first", find_amounts("£90 and £1,000.00"), [1000.0, 90.0])

    # The pre-filter's asymmetry: keep anything with a money signal.
    keep, _ = prefilter({"headers": {"subject": "Newsletter"}, "body": "read about invoices",
                         "attachments": []})
    check("wording alone is dropped", keep, False)
    keep, _ = prefilter({"headers": {"subject": "Your bill"}, "body": "Amount due £42.00",
                         "attachments": []})
    check("an amount is always kept", keep, True)
    keep, _ = prefilter({"headers": {"subject": "Invoice", "list-unsubscribe": "<x>"},
                         "body": "Please pay £10.00", "attachments": []})
    check("List-Unsubscribe alone never drops a real bill", keep, True)
    keep, _ = prefilter({"headers": {"subject": "sent you a document"}, "body": "",
                         "attachments": [{"filename": "Invoice-01.pdf"}]})
    check("an empty email with a PDF is kept", keep, True)
    keep, reason = prefilter({"headers": {"from": "Mail Delivery Subsystem <mailer-daemon@x>",
                                          "subject": "Delivery Status Notification (Failure)"},
                              "body": "original message said £78.82", "attachments": []})
    check("a bounce is never an invoice", (keep, reason),
          (False, "bounce or delivery-status notice"))
    keep, _ = prefilter({"headers": {"subject": "Automatic reply", "auto-submitted": "auto-replied"},
                         "body": "I am out of the office", "attachments": []})
    check("an auto-reply with no money is dropped", keep, False)

    # Direction. Money in is not a payable, but "payment failed" and "payment
    # reminder" say something is STILL owed and must survive.
    keep, reason = prefilter({"headers": {"subject": "Square has sent you £133.61"},
                              "body": "", "attachments": []})
    check("card takings are money IN", (keep, reason), (False, "money in, or already settled"))
    keep, _ = prefilter({"headers": {"subject": "Successful payment for Youth Instalments"},
                         "body": "£40.00", "attachments": []})
    check("a payment receipt is dropped", keep, False)
    keep, _ = prefilter({"headers": {"subject": "1 Payment failed"},
                         "body": "£120.00 could not be collected", "attachments": []})
    check("a FAILED payment still needs Kevin", keep, True)
    keep, _ = prefilter({"headers": {"subject": "Payment reminder - Council Tax"},
                         "body": "Amount due £190.86", "attachments": []})
    check("a payment reminder survives", keep, True)
    keep, _ = prefilter({"headers": {"subject": "Invoice 0004_09_2026"},
                         "body": "Thank you for your payment last month. Now due £90.00",
                         "attachments": []})
    check("receipt boilerplate in the BODY never drops an invoice", keep, True)

    # The Gmail query must keep the two terms that carry it.
    query = gmail_query(datetime(2026, 9, 11, 21, tzinfo=LONDON),
                        datetime(2026, 9, 18, 21, tzinfo=LONDON), 0)
    # The epochs are asserted literally on purpose. A hand-written epoch that
    # is a year out still LOOKS like a valid Gmail query and returns a full,
    # plausible week of mail — it cost a wrong back-test on 18 Sep 2026 before
    # this assertion caught it.
    # The cross-mailbox duplicate. These two REAL messages are one £90 invoice
    # from the live week to 18 Sep 2026, forwarded by Roy to both mailboxes.
    left = {"from": "Roy Lavin <roy.lavin1978@gmail.com>", "subject": "Fwd: LGSR 55Elmdon"}
    right = {"from": "Roy Lavin <roy.lavin1978@gmail.com>", "subject": "LGSR 55Elmdon"}
    check("the same invoice in both mailboxes shares a key",
          duplicate_key(left), duplicate_key(right))
    check("a reply prefix is stripped too",
          duplicate_key({"from": "a@b.c", "subject": "Re: Invoice - David Clements"}),
          duplicate_key({"from": "a@b.c", "subject": "Invoice - David Clements"}))
    check("stacked prefixes are stripped",
          normalise_subject("Re: Fwd: RE: Invoice 12"), "invoice 12")
    check("a DIFFERENT sender is a different matter",
          duplicate_key({"from": "x@y.z", "subject": "Invoice"})
          != duplicate_key({"from": "a@b.c", "subject": "Invoice"}), True)
    check("a different subject is a different matter",
          duplicate_key({"from": "a@b.c", "subject": "Invoice 12"})
          != duplicate_key({"from": "a@b.c", "subject": "Invoice 13"}), True)
    check("the bare address comes out of a display-name header",
          sender_email("Roy Lavin <roy.lavin1978@gmail.com>"), "roy.lavin1978@gmail.com")
    check("and a bare address survives", sender_email("a@b.c"), "a@b.c")

    # Quota classification. The live failure this covers: Google's 403 for the
    # PER-MINUTE metric, re-wrapped by the worker as a 500. Read as a plain 500
    # it retries in two seconds and fails four times; read correctly it waits a
    # minute and the run continues.
    minute_403 = ('{"error":"Gmail list failed: {\\"error\\": {\\"code\\": 403, '
                  '\\"message\\": \\"Quota exceeded for quota metric \'Total Query Cost\' '
                  'and limit \'Units per minute per user\' of service gmail.googleapis.com\\"}}"}')
    check("a per-minute metric wrapped in a 500 is a SLOWDOWN",
          classify_worker_error(500, minute_403)[0], "slowdown")
    check("a per-day quota is the day gone",
          classify_worker_error(403, "Quota exceeded for quota metric 'Queries per day'")[0],
          "quota")
    check("quota-shaped with no window named waits rather than quits",
          classify_worker_error(500, "quotaExceeded")[0], "slowdown")
    check("a plain 503 is an ordinary retry",
          classify_worker_error(503, "service unavailable")[0], "retry")
    check("409 stops and names the fix", classify_worker_error(409, "not connected")[0], "stop")
    check("an auth failure stops", classify_worker_error(401, "Forbidden")[0], "stop")

    check("the window start is 11 Sep 2026 21:00 BST", "after:1789156800" in query, True)
    check("the window end is 18 Sep 2026 21:00 BST", "before:1789761600" in query, True)
    check("and keeps has:attachment", "has:attachment" in query, True)

    # The upsert key is what killed the duplicate bug — prove it collapses.
    dupes = index_by_message_id([
        {"id": "rec1", "fields": {FIELD_MSG_ID: "m1", "Amount": 10}},
        {"id": "rec2", "fields": {FIELD_MSG_ID: "m1"}},
        {"id": "rec3", "fields": {FIELD_MSG_ID: "m2"}},
    ])
    check("two rows collapse to one key", sorted(dupes), ["m1", "m2"])
    check("and the key keeps both rows", len(dupes["m1"]), 2)

    # The cleanse dedupes EVERY status, not just the open rows. Deduping only
    # the open ones left nine duplicated ids among the Paid rows on 18 Sep 2026.
    table = [
        {"id": "recPaidA", "fields": {FIELD_MSG_ID: "mp", "Status": "Paid",
                                      "Amount": 10, "Paid Date": "2026-01-01"}},
        {"id": "recPaidB", "fields": {FIELD_MSG_ID: "mp", "Status": "Unpaid"}},
        {"id": "recOpenA", "fields": {FIELD_MSG_ID: "mo", "Status": "Unpaid",
                                      "Amount": 5, "Email Date": "2020-01-01"}},
        {"id": "recOpenB", "fields": {FIELD_MSG_ID: "mo", "Status": "Unpaid"}},
    ]
    dup, paid_rows, pre_window = plan_cleanse(table, {}, "2026-09-11")
    check("duplicates are found among PAID rows too",
          sorted(r["id"] for r in dup), ["recOpenB", "recPaidB"])
    check("and the settled row is the one kept",
          "recPaidA" not in [r["id"] for r in dup], True)
    check("nothing matched, so nothing is marked paid", paid_rows, [])
    check("the surviving pre-window open row is REPORTED, not moved",
          [r["id"] for r in pre_window], ["recOpenA"])

    # Bank-details change detection.
    prior = {"acme ltd": ["Sort 20-00-00 Acct 12345678"]}
    check("same details, reformatted, is not a change",
          bank_details_changed("Acme Ltd", "Sort 200000 Account 12345678", prior), False)
    check("a different account number IS a change",
          bank_details_changed("Acme Ltd", "Sort 20-00-00 Acct 87654321", prior), True)
    check("a payee with no history is not a change",
          bank_details_changed("New Co", "Sort 20-00-00 Acct 87654321", prior), False)

    # A strict match must not treat a coincidental amount as payment. These use
    # the real shape of the 18 Sep 2026 case: a £180 invoice from Shaun Lingham
    # against a bank line reading "Shaun Lingham 55 Elmdon".
    by_amount = {180.0: [{"id": "txA", "fields": {"**Date": "2026-09-15",
                                                 "*Name": "Shaun Lingham 55 Elmdon"}}]}
    check("a payment BEFORE the invoice is not a match",
          match_transaction({"fields": {"Amount": 180, "Email Date": "2026-09-20",
                                        "Payee": "Shaun Lingham"}}, by_amount), None)
    check("payee corroborated = confirmed",
          match_transaction({"fields": {"Amount": 180, "Email Date": "2026-09-14",
                                        "Payee": "Shaun Lingham"}}, by_amount),
          (by_amount[180.0][0], "confirmed"))
    check("same amount, same date, DIFFERENT payee is only probable",
          match_transaction({"fields": {"Amount": 180, "Email Date": "2026-09-14",
                                        "Payee": "Acme Roofing"}}, by_amount)[1],
          "probable")
    check("no amount can never match",
          match_transaction({"fields": {"Email Date": "2026-08-01"}}, by_amount), None)
    check("a short word never corroborates on its own", payee_tokens("A B Ltd"), set())
    check("an email address is not a payee name",
          payee_tokens("kevinbrittain@gmail.com"), set())
    check("real words survive", payee_tokens("Priority Response Group LTD"),
          {"priority", "response"})

    if failures:
        for line in failures:
            print("FAIL " + line)
        sys.exit(1)
    print("payment-run selftest: all checks pass")


# ══════════════════════════════════════════════════════════════════════════

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("window"); p.add_argument("--asof"); p.set_defaults(fn=cmd_window)

    p = sub.add_parser("scan")
    p.add_argument("--asof")
    p.add_argument("--back-days", type=int, default=0,
                   help="re-read this many days behind the window start")
    p.add_argument("--max-attachments", type=int, default=MAX_ATTACHMENTS)
    p.set_defaults(fn=cmd_scan)

    p = sub.add_parser("check")
    p.add_argument("--since", default="2026-01-01")
    p.set_defaults(fn=cmd_check)

    p = sub.add_parser("write")
    p.add_argument("--items", required=True)
    p.add_argument("--run-date")
    p.set_defaults(fn=cmd_write)

    p = sub.add_parser("cleanse")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--asof")
    p.add_argument("--since", default="2026-01-01")
    p.set_defaults(fn=cmd_cleanse)

    p = sub.add_parser("historic")
    p.add_argument("--ids", required=True, help="comma-separated record ids")
    p.add_argument("--restore", action="store_true",
                   help="set them back to Unpaid instead (a supplier invoice, not creditor debt)")
    p.add_argument("--reason")
    p.set_defaults(fn=cmd_historic)

    p = sub.add_parser("report"); p.add_argument("--asof"); p.set_defaults(fn=cmd_report)
    p = sub.add_parser("selftest"); p.set_defaults(fn=cmd_selftest)

    args = parser.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
