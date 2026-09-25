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
  payment-run.py check                    the settle plan, printed. Writes nothing.
  payment-run.py settle [--apply]         mark Paid every open row a payee-
                                          corroborated bank payment covers.
                                          DRY BY DEFAULT.
  payment-run.py tasks [--apply] [--asof ISO]
                                          put Kevin's approved MARK FOR PAYMENT
                                          cards on the list, from the Friday
                                          before they are due. DRY BY DEFAULT.
  payment-run.py unlisted [--days N]      business-account transfers no row on
                                          the list accounts for. Writes nothing.
  payment-run.py daily                    tasks --apply, then settle --apply,
                                          then unlisted. The 06:30 job.
  payment-run.py done                     the Friday run's last step: the scan
                                          it read becomes the next run's start.
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
# The Friday scan's two stamps. `scan` writes PENDING with the end of the mail
# it read; `done`, the run's last step, promotes it to LAST_GOOD. The next scan
# reads from LAST_GOOD, so a Friday that never ran, died half way or was
# truncated is read again rather than lost. Until 25 Sep 2026 the scan only
# ever looked back seven days, and its one scheduled run (18 Sep) scanned the
# wrong week, so the week to 18 Sep was never read by the job at all.
SCAN_PENDING = STATE_DIR / "scan-pending.json"
SCAN_LAST_GOOD = STATE_DIR / "scan-last-good.json"
# How far a catch-up may reach. A month of missed Fridays is a broken job that
# needs a human, not a scan of every newsletter since spring.
MAX_CATCHUP_DAYS = 35

# Tasks fields, by id (js/config.js TASK_FIELDS). The approval marks themselves
# are checked by approval_evidence.py, the one check every send path uses.
TASK_F = {
    "name": "fldgFjGBw6bTKJFCD",
    "status": "fldx4qCw17UfrKpaN",
    "outcome": "fldrHBSr6qoUfaKuZ",
    "output": "fldzswp8fx6PqpLQ5",
    "notes": "fldR7apBzSp3oxFxz",
}
APPROVED_OUTCOMES = ("Approved as-is", "Approved with minor edits")

# The account Kevin pays suppliers and contractors from. Every contractor
# payment from 1 Aug to 24 Sep 2026 left from here. Named by the account's alias, never
# by payee, because the repo is public.
BUSINESS_PAYMENT_ACCOUNTS = ("TNT Mgt Zempler",)

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
    """(start, end) of the CURRENTLY OPEN payment-run week, London time.

    The end is the NEXT cutoff at or after `asof`: on a Friday before 21:00 the
    week still ends tonight, and the moment it passes 21:00 a new week opens.
    Kept as a pure function because the boundary is exactly the sort of thing
    that is wrong by a day for a month before anyone notices.

    This is for DISPLAY ONLY. Do not scan Gmail with it — see scan_range()."""
    now = (asof or datetime.now(LONDON)).astimezone(LONDON)
    days_ahead = (CUTOFF_WEEKDAY - now.weekday()) % 7
    end = (now + timedelta(days=days_ahead)).replace(
        hour=CUTOFF_HOUR, minute=0, second=0, microsecond=0)
    if end <= now:
        end += timedelta(days=7)
    return end - timedelta(days=7), end


def scan_range(asof=None, back_days=1, last_good=None):
    """(start, end) of the mail to READ. Deliberately NOT run_window().

    The job is scheduled for Friday 21:00, which is the cutoff itself. Asked for
    the "current" week at that instant, run_window() correctly answers with the
    week that is just STARTING — seven days of mail that has not arrived yet. The
    first live run did exactly that on 18 Sep 2026: "scanned 18 Sep 21:00 ->
    25 Sep 21:00, 2 emails listed, 0 new payables", finished rc=0, and wrote a
    tidy report. Nothing errored. Any invoice that had arrived during the week it
    was supposed to be reading would simply never have appeared.

    So the scan does not ask which week it is. It reads the last seven days plus
    an overlap, ending NOW, which covers the week that just closed however late
    or early the job fires, and survives the Mac having been asleep. Re-reading
    mail is free: every write upserts on Gmail Message ID.

    `last_good` is the end of the last scan a Friday run finished (see `done`).
    When it is older than the usual reach, the scan starts there instead, so a
    week the job missed is read by the next run rather than lost for ever.
    Capped at MAX_CATCHUP_DAYS."""
    end = (asof or datetime.now(LONDON)).astimezone(LONDON)
    overlap = timedelta(days=max(0, back_days))
    start = end - timedelta(days=7) - overlap
    if last_good is not None:
        start = min(start, last_good.astimezone(LONDON) - overlap)
    return max(start, end - timedelta(days=MAX_CATCHUP_DAYS)), end


def read_stamp(path):
    """The datetime a scan stamp holds, or None. A stamp that cannot be read is
    treated as absent: the scan then falls back to its usual reach, which is
    the pre-25 Sep behaviour, never to reading nothing."""
    try:
        data = json.loads(Path(path).read_text())
        return datetime.fromisoformat(data["end"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def write_stamp(path, payload):
    """Atomic: a temp file renamed over the real one. A stamp rewritten in place
    is empty for an instant, and a scan starting in that instant would read no
    stamp at all (the lock-file lesson in .claude/rules/python-scripts.md)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2))
    os.replace(tmp, path)


def week_buckets(asof=None):
    """The two boundaries that split the list into three sections.

    Kevin's ruling, 18 Sep 2026, made the moment the cutoff passed while he
    still had the week's invoices unpaid: what he was about to pay dropped
    straight from "This week" into "Still owed" alongside February's debts. A
    single boundary cannot hold "the list I am paying tonight" and "the old
    stuff I keep meaning to deal with" apart, so there are two.

      thisWeekStart  the cutoff just passed — mail since then
      lastWeekStart  the cutoff before that — the week he is actually paying
      anything older  Still owed
    """
    this_start, _end = run_window(asof)
    return this_start, this_start - timedelta(days=7)


def cmd_window(args):
    asof = parse_asof(args.asof)
    start, end = run_window(asof)
    this_start, last_start = week_buckets(asof)
    scan_start, scan_end = scan_range(asof, args.back_days)
    print(json.dumps({
        "start": start.isoformat(),
        "end": end.isoformat(),
        "label": "Week to %s" % end.strftime("%a %-d %b %Y, %-I%p").replace("PM", "pm").replace("AM", "am"),
        "buckets": {
            "thisWeekStart": this_start.isoformat(),
            "lastWeekStart": last_start.isoformat(),
        },
        "scanRange": {"start": scan_start.isoformat(), "end": scan_end.isoformat()},
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


def pages_for(days):
    """The page cap for a scan of `days`: MAX_PAGES per seven days. A catch-up
    over a missed week reads two weeks of mail, and a fixed cap sized for one
    would truncate exactly the run that exists to recover it."""
    return max(MAX_PAGES, min(MAX_PAGES * 5, -(-int(days * MAX_PAGES) // 7)))


def list_account(account, query, max_pages=MAX_PAGES):
    """Follow nextPageToken up to max_pages. (messages, truncated).

    `truncated=True` means Gmail had MORE than this run fetched: the caller
    must report an incomplete week rather than present it as the whole one.

    The pause between pages is not politeness. Each page is 25 Gmail message
    fetches, and a full run is ~300 across two mailboxes; without pacing the
    burst exhausts the per-minute metric partway through, which is how the
    first live run died."""
    messages, token = [], None
    for page in range(max_pages):
        payload = {"q": query, "maxResults": 25}
        if token:
            payload["pageToken"] = token
        data = worker_post("/gmail/list", payload, account)
        messages.extend(data.get("messages", []))
        token = data.get("nextPageToken")
        if not token:
            return messages, False
        if page < max_pages - 1:
            time.sleep(PAGE_PACE_SECONDS)
    return messages, True


def card_for_message(message_id, amounts, cards):
    """The approved payment card this email already is, or None.

    A card names its source email in its TRACK RECORD (a Gmail URL ending in the
    message id). That record also lists the sender's EARLIER emails, so an id
    alone could tie this week's second invoice to last month's card and hide
    it. The card's amount must also appear in this email before it counts."""
    for card in cards:
        if card.get("amount") is None or ("#all/%s" % message_id) not in card.get("text", ""):
            continue
        if any(abs(a - card["amount"]) < 0.005 for a in amounts):
            return card["taskId"]
    return None


def cmd_scan(args):
    # The mail to read, NOT the display week. See scan_range() for why those are
    # two different questions and what it cost to learn that.
    start, end = scan_range(parse_asof(args.asof), args.back_days,
                            None if args.asof else read_stamp(SCAN_LAST_GOOD))
    query = gmail_query(start, end, 0)
    days = (end - start).total_seconds() / 86400
    max_pages = pages_for(days)
    # --max-attachments is a per-WEEK budget; a catch-up over two weeks gets two.
    budget = max(args.max_attachments, -(-int(args.max_attachments * days) // 7))
    # Approved payment cards, so an email that already is one is marked and the
    # skill leaves it to the card lane (listed on the Friday before it is due).
    cards = [c for c in approved_payment_cards() if c.get("card")]
    card_refs = [dict(c["card"], taskId=c["id"], text=c["text"]) for c in cards]
    accounts_out, kept_total, seen_total = [], 0, 0

    for account in ACCOUNTS:
        messages, truncated = list_account(account, query, max_pages)
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
            amounts = find_amounts(
                (headers.get("subject") or "") + "\n" + (msg.get("body") or ""))
            summary.update({
                "body": (msg.get("body") or "")[:4000],
                "amountsInBody": amounts,
                "attachments": attachments,
                "attachmentNames": [a.get("filename") for a in (msg.get("attachments") or [])],
            })
            card = card_for_message(msg["id"], amounts + [
                a for att in attachments for a in find_amounts(att.get("text"))], card_refs)
            if card:
                summary["paymentCard"] = card
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

    complete = not any(a["truncated"] for a in accounts_out)
    if not args.asof:
        # Only a live scan stamps. A back-test with --asof reads history and
        # must never move where the next Friday starts.
        write_stamp(SCAN_PENDING, {"end": end.isoformat(), "start": start.isoformat(),
                                   "complete": complete})

    print(json.dumps({
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "catchUp": days > 8.5,
        "complete": complete,
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


OUTFLOW_FIELDS = ["*Name", "**Date", "**GBP", "*Vendor", "Split Override Amount",
                  "Account Alias (from **Account)"]


def load_outflows(since):
    """Money OUT since `since`. The control is printed by the caller: a
    filterByFormula with a wrong field name returns 200 OK and an empty list,
    which is indistinguishable from a genuinely quiet bank account."""
    formula = "AND(IS_AFTER({**Date}, '%s'), {**GBP} < 0)" % since
    return airtable_list(T_TRANSACTIONS,
                         {"filterByFormula": formula, "fields[]": OUTFLOW_FIELDS},
                         what="Transactions outflows")


# Words that name a KIND of payee, not a payee. "Oakfield Properties" must be
# told apart from every other properties company by "oakfield", and a council
# or a city is never evidence on its own.
PAYEE_STOP = {"limited", "ltd", "the", "and", "group", "services", "service",
              "company", "council", "energy", "water", "invoice", "payment",
              "properties", "property", "city", "county", "borough", "district",
              "management", "maintenance", "solutions", "holdings", "partnership",
              "trading", "contractors", "lettings", "estates", "homes", "building"}


def payee_tokens(name):
    """Words from a payee worth matching a bank memo against. Four characters
    and up, so "ltd", "the" and initials never corroborate anything on their
    own, and an email address contributes nothing useful."""
    if not name or "@" in str(name):
        return set()
    words = re.findall(r"[a-z]{4,}", str(name).lower())
    return {w for w in words if w not in PAYEE_STOP}


def memo_text(tx):
    f = tx.get("fields", {})
    return " ".join(str(f.get(k) or "") for k in ("*Name", "*Vendor")).lower()


def memo_words(tx):
    """Whole words (and numbers of two digits or more) on the bank line."""
    return set(re.findall(r"[a-z]{4,}|\d{2,}", memo_text(tx)))


def memo_names_payee(tokens, tx):
    """True when a payee word is a WORD on the bank line. Whole words, not
    substrings: "city" sits inside "electricity", and a substring test closed
    a council's bill on an electricity direct debit (review, 25 Sep 2026). A
    shared start of five letters or more still counts, because banks cut
    names short ("OAKFIELD ROOFI") and invoices add an s ("Brightwells")."""
    words = memo_words(tx)
    for t in tokens:
        for w in words:
            short, long_ = sorted((t, w), key=len)
            if t == w or (len(short) >= 5 and len(short) >= 0.7 * len(long_)
                          and long_.startswith(short)):
                return True
    return False


def tx_amount(tx):
    """What a transaction pays, as matched against a bill. A split parent's
    **GBP is the whole bank amount; its Split Override Amount is its own part,
    and each part pays its own bill."""
    f = tx.get("fields", {})
    value = f.get("Split Override Amount")
    if value is None:
        value = f.get("**GBP")
    return None if value is None else round(abs(float(value)), 2)


def tx_date(tx):
    return (tx.get("fields", {}).get("**Date") or "")[:10]


def match_transaction(invoice, by_amount, exclude=()):
    """The transaction that paid this invoice, or None.

    `exclude` holds transactions another row already claims. One bank payment
    settles ONE invoice: two open £180 invoices from one contractor must not
    both close on a single £180 transfer, or the one still owed disappears.
    Candidates are tried oldest first, so an invoice takes the first payment
    made after it arrived.

    Returns (tx, confidence) where confidence is "confirmed" or "probable".

    Deliberately strict on the two hard facts: the amount matches to the penny
    AND the payment is dated on or after the invoice email. A looser rule turns
    any coincidental £90 into a payment and hides a bill Kevin still owes.

    Amount and date alone are still not enough to HIDE a payable, though. The
    £180 to Shaun Lingham matched on 18 Sep 2026 because the bank memo really
    did read "Shaun Lingham 55 Elmdon" — but nothing in that test looked at the
    payee, so an unrelated £180 on the right day would have hidden the invoice
    just as confidently. So the payee must corroborate: a payee word that is a
    word on the bank line makes it `confirmed` and the row is hidden; without
    one it is `probable` and the row STAYS on the list carrying a note.
    Kevin dismissing a paid row costs seconds; a supplier never being paid
    costs a relationship."""
    fields = invoice.get("fields", {})
    amount = fields.get("Amount")
    if amount is None:
        return None
    email_date = (fields.get("Email Date") or "")[:10]
    tokens = payee_tokens(fields.get("Payee"))
    candidates = sorted(by_amount.get(round(abs(float(amount)), 2), []), key=tx_date)
    best = None
    for tx in candidates:
        if tx.get("id") in exclude:
            continue
        if not (email_date and tx_date(tx) and tx_date(tx) >= email_date):
            continue
        if tokens and memo_names_payee(tokens, tx):
            return tx, "confirmed"
        best = best or (tx, "probable")
    return best


def index_by_amount(transactions):
    index = {}
    for tx in transactions:
        amount = tx_amount(tx)
        if amount is not None:
            index.setdefault(amount, []).append(tx)
    return index


def claimed_transactions(records):
    """Every transaction id already linked to a row, whatever its status."""
    out = set()
    for rec in records:
        out.update(rec.get("fields", {}).get("Matched Transaction") or [])
    return out


def days_between(a, b):
    return abs((datetime.fromisoformat(a) - datetime.fromisoformat(b)).days)


def plus_days(day, n):
    return (datetime.fromisoformat(day) + timedelta(days=n)).date().isoformat()


def plan_links(records, by_amount, since, exclude=(), named=True, skip_rows=()):
    """(row, tx) for rows marked Paid by hand, with no transaction recorded.

    The page's Mark Paid sets Status and Paid Date but links nothing, so the
    payment behind it looks unclaimed and the absence check would report it as
    money that left without a bill. Nothing about the row's status changes.

    Kevin has already said this row is paid, so the bar is lower than for
    closing an open row: a payment of the amount, on or after the bill and no
    later than three days after he marked it paid (the bank books a transfer a
    day or two after it is sent).

    Two passes, run either side of the settle (see plan_all). named=True links
    only a payment whose bank line names the row's payee. named=False takes the
    rest, only within three days of the Paid Date, and never a payment whose
    bank line names the payee of a bill still OPEN on the list: that payment is
    evidence the open bill was paid, and taking it would leave the open bill
    listed and paid twice (second review, 25 Sep 2026)."""
    used = claimed_transactions(records) | set(exclude)
    open_tokens = [payee_tokens(r["fields"].get("Payee")) for r in records if settleable(r)]
    out = []
    for rec in sorted(records, key=lambda r: (r["fields"].get("Email Date") or "", r["id"])):
        f = rec["fields"]
        paid_on = (f.get("Paid Date") or "")[:10]
        email_date = (f.get("Email Date") or "")[:10]
        if (rec["id"] in skip_rows or status_of(rec) != "Paid" or f.get("Matched Transaction")
                or f.get("Amount") is None or not paid_on or paid_on < since):
            continue
        tokens = payee_tokens(f.get("Payee"))
        for tx in sorted(by_amount.get(round(abs(float(f["Amount"])), 2), []), key=tx_date):
            d = tx_date(tx)
            if tx["id"] in used or not d or d < email_date or d > plus_days(paid_on, 3):
                continue
            names_this = bool(tokens) and memo_names_payee(tokens, tx)
            if named and names_this:
                break
            if (not named and not names_this and days_between(d, paid_on) <= 3
                    and not any(tk and memo_names_payee(tk, tx) for tk in open_tokens)):
                break
        else:
            continue
        used.add(tx["id"])
        out.append((rec, tx))
    return out


def row_words(fields):
    """The words that tell one bill from another of the same size and payee:
    the property and the reference."""
    text = " ".join(str(fields.get(k) or "") for k in ("Description", "Reference"))
    return set(re.findall(r"[a-z]{4,}|\d{2,}", text.lower()))


def settleable(rec):
    """An open row the bank match may close. Not one where Kevin rejected the
    page's suggested payment: he has said the obvious match is wrong."""
    return status_of(rec) in ("Unpaid", "") and not rec["fields"].get("AI Match Rejected")


def plan_settle(records, by_amount, also_used=()):
    """(paid, probable) across every open row. Pure, so the dry run and the
    daily job cannot disagree about what is about to happen.

    WHY THIS WRITES NOW (25 Sep 2026). Until then `check` found the payments and
    only PRINTED them, into a log file nobody reads, so a paid row stayed on the
    list until Kevin clicked Mark Paid himself. A £90 gas certificate paid on
    21 Sep, the bank line naming the engineer's company, was still listed as
    owed four days later while its task sat open asking Kevin to check his bank.

    Each PAYMENT picks its bill, oldest payment first. Among the open rows it
    could pay (amount to the penny, on or after the bill, the payee named on
    the bank line), it takes the one whose property or reference the bank line
    also names, then the oldest. Two £90 bills from one engineer for two houses
    must not swap: the row the bank line names is the one paid, or Kevin pays
    the other twice. A payment claimed once is never claimed again.

    Only a payee-corroborated match closes a row; a `probable` one leaves it
    open with a note (Kevin's rule, 18 Sep 2026: an amount and a date alone
    marked 5 of 9 rows paid wrongly)."""
    used = claimed_transactions(records) | set(also_used)
    open_rows = sorted((r for r in records if settleable(r)),
                       key=lambda r: (r["fields"].get("Email Date") or "", r["id"]))
    order = {r["id"]: i for i, r in enumerate(open_rows)}
    txs = sorted({tx["id"]: tx for group in by_amount.values() for tx in group}.values(),
                 key=lambda tx: (tx_date(tx), tx["id"]))
    paid, closed = [], set()
    for tx in txs:
        if tx["id"] in used:
            continue
        amount = tx_amount(tx)
        eligible = []
        for rec in open_rows:
            f = rec["fields"]
            if rec["id"] in closed or f.get("Amount") is None:
                continue
            if round(abs(float(f["Amount"])), 2) != amount:
                continue
            email_date = (f.get("Email Date") or "")[:10]
            if not email_date or tx_date(tx) < email_date:
                continue
            tokens = payee_tokens(f.get("Payee"))
            if tokens and memo_names_payee(tokens, tx):
                eligible.append(rec)
        if not eligible:
            continue
        named = memo_words(tx)
        best = max(eligible, key=lambda r: (len(row_words(r["fields"]) & named), -order[r["id"]]))
        paid.append((best, tx))
        closed.add(best["id"])
        used.add(tx["id"])
    probable = []
    for rec in open_rows:
        if rec["id"] in closed or not payee_tokens(rec["fields"].get("Payee")):
            # With no payee words to compare (a legacy row whose payee is an
            # email address) every same-sized payment is "possible", and a note
            # naming a stranger's payment invites a wrong Mark Paid.
            continue
        hit = match_transaction(rec, by_amount, exclude=used)
        if hit and hit[1] == "probable":
            probable.append((rec, hit[0]))
    return paid, probable


def tx_line(tx):
    f = tx.get("fields", {})
    return "%s on %s, £%.2f" % (str(f.get("*Name") or "a payment").strip()[:60],
                                tx_date(tx), tx_amount(tx) or 0)


def settle_updates(paid, probable):
    """The PATCHes that carry out a settle plan. A probable match writes its
    note once (keyed on the transaction id), not every morning."""
    updates = []
    for rec, tx in paid:
        updates.append({"id": rec["id"], "fields": {
            "Status": "Paid",
            "Paid Date": tx_date(tx) or None,
            "Matched Transaction": [tx["id"]],
            "Notes": append_note(rec, "Marked paid by the bank match: %s. The bank "
                                      "line names the payee. (%s)" % (tx_line(tx), tx["id"])),
        }})
    for rec, tx in probable:
        if tx["id"] in (rec["fields"].get("Notes") or ""):
            continue
        updates.append({"id": rec["id"], "fields": {
            "Notes": append_note(rec, "Possible payment: %s. The bank line does not "
                                      "name the payee, so this stays on the list. If "
                                      "it is this bill, press Mark Paid. (%s)"
                                      % (tx_line(tx), tx["id"])),
        }})
    return updates


def default_since(days=180):
    return (datetime.now(LONDON) - timedelta(days=days)).date().isoformat()


def load_controlled_outflows(since):
    transactions = load_outflows(since)
    print("Outflow transactions since %s: %d   (CONTROL: a zero here means the "
          "query is broken, not that nothing was paid)" % (since, len(transactions)))
    if not transactions:
        fail("the outflow control matched nothing. Refusing to report every "
             "invoice as unpaid off a query that returned an empty list.")
    return transactions


def plan_all(records, by_amount, link_since):
    """Named links, then settle, then unnamed links. A row Kevin marked paid by
    hand claims a payment that NAMES its payee before an open twin of the same
    size can, so the bill still owed stays on the list; and a payment that
    names nobody on the list is only linked to a hand-paid row after every open
    bill has had its chance at the payments that name it."""
    named = plan_links(records, by_amount, link_since)
    taken = {tx["id"] for _r, tx in named}
    paid, probable = plan_settle(records, by_amount, taken)
    taken |= {tx["id"] for _r, tx in paid}
    unnamed = plan_links(records, by_amount, link_since, exclude=taken, named=False,
                         skip_rows={r["id"] for r, _tx in named})
    return named + unnamed, paid, probable


def run_settle(records, transactions, apply):
    links, paid, probable = plan_all(records, index_by_amount(transactions), default_since(30))

    def line(inv, tx):
        f = inv["fields"]
        return "  £%9.2f | %s | %-28s | %s (%s) %s" % (
            float(f["Amount"]), (f.get("Email Date") or "")[:10],
            str(f.get("Payee"))[:28], tx["id"], tx_date(tx),
            str(tx["fields"].get("*Name") or "")[:34])

    print("\nPAID, payee corroborated — %s (%d):"
          % ("marked Paid now" if apply else "would be marked Paid", len(paid)))
    for inv, tx in paid:
        print(line(inv, tx))
    print("\nPROBABLE match on amount and date but the payee does NOT corroborate "
          "(%d) — these STAY on the list with a note:" % len(probable))
    for inv, tx in probable:
        print(line(inv, tx))
    print("\nMARKED PAID BY HAND, payment now linked (%d)" % len(links))
    for rec, tx in links:
        print("  %s | %s" % (str(rec["fields"].get("Payee"))[:28], tx_line(tx)))
    closed = {inv["id"] for inv, _ in paid}
    still_open = [r for r in records if status_of(r) in ("Unpaid", "") and r["id"] not in closed]
    no_amount = [r for r in still_open if r["fields"].get("Amount") is None]
    owed = sum(float(r["fields"]["Amount"]) for r in still_open
               if r["fields"].get("Amount") is not None)
    print("\nSTILL OWED (%d): £%.2f, of which %d have no amount read"
          % (len(still_open), owed, len(no_amount)))
    updates = settle_updates(paid, probable) + [
        {"id": rec["id"], "fields": {"Matched Transaction": [tx["id"]]}} for rec, tx in links]
    if apply and updates:
        airtable_write(T_INVOICES, "PATCH", updates, "settle paid rows")
    elif updates:
        print("\nDRY RUN: %d rows would change. Re-run with --apply." % len(updates))
    return paid, probable


def cmd_check(args):
    """The settle plan, printed. Kept so the old command still answers."""
    records = airtable_list(T_INVOICES, what="Dashboard Invoices")
    print("Open invoice rows: %d" % sum(1 for r in records if status_of(r) in ("Unpaid", "")))
    return run_settle(records, load_controlled_outflows(args.since or default_since()), False)


def cmd_settle(args):
    records = airtable_list(T_INVOICES, what="Dashboard Invoices")
    print("Open invoice rows: %d" % sum(1 for r in records if status_of(r) in ("Unpaid", "")))
    return run_settle(records, load_controlled_outflows(args.since or default_since()), args.apply)


# ══════════════════════════════════════════════════════════════════════════
# unlisted — money that left without ever being on the list
# ══════════════════════════════════════════════════════════════════════════

# A line on the business account that is NOT a payment Kevin chose to make: a
# card purchase ("Fin:"), a direct debit ("DD:"), the bank's own fee, the loan
# repayment, and the second half of a split (the parent line carries the real
# bank amount, the child is a bookkeeping copy).
NOT_A_TRANSFER_RE = re.compile(
    r"^\s*(?:Fin:|DD:|Electronic Payment Fee)|\(Split (?!1 of)\d+ of \d+\)", re.I)
# Standing collections that arrive without a "DD:" prefix (a lender, say) are
# named in a private file, never here: the repo is public.
PRIVATE_CONFIG = Path.home() / ".config/od/payment-run.json"
_not_transfers = []


def private_not_transfers():
    """Lower-case name fragments of standing collections, from PRIVATE_CONFIG
    {"notTransfers": [...]}. A missing file means none: the absence report then
    over-reports rather than hiding anything."""
    if not _not_transfers:
        try:
            data = json.loads(PRIVATE_CONFIG.read_text())
            _not_transfers.extend(str(x).lower() for x in data.get("notTransfers", []) if x)
        except (OSError, ValueError, AttributeError):
            pass
        _not_transfers.append("\0")   # read once, even when empty
    return [x for x in _not_transfers if x != "\0"]
SPLIT_SUFFIX_RE = re.compile(r"\s*\(Split \d+ of \d+\)\s*$", re.I)


def is_business_transfer(tx):
    """True for a payment Kevin sent by hand from the business account."""
    f = tx.get("fields", {})
    accounts = f.get("Account Alias (from **Account)") or []
    if not any(a in BUSINESS_PAYMENT_ACCOUNTS for a in accounts):
        return False
    gbp = f.get("**GBP")
    if gbp is None or float(gbp) >= 0:
        return False
    name = str(f.get("*Name") or "").strip()
    return (bool(name) and not NOT_A_TRANSFER_RE.search(name)
            and not any(x in name.lower() for x in private_not_transfers()))


def split_group(tx):
    """One bank payment, however many bookkeeping parts it was split into, or
    None for a payment that was never split: two separate same-day payments to
    one contractor are two payments, and one being listed says nothing about
    the other (second review, 25 Sep 2026)."""
    name = str(tx.get("fields", {}).get("*Name") or "")
    if not SPLIT_SUFFIX_RE.search(name):
        return None
    return tx_date(tx), SPLIT_SUFFIX_RE.sub("", name)


def unlisted_transfers(transactions, records):
    """Business-account transfers that no row on the list accounts for.

    The absence report (Kevin, 25 Sep 2026). From 1 Aug to 24 Sep 2026 more
    than thirty payments left this account to contractors whose requests never
    came by email, so no scan could see them and the list never held them. A
    list of what IS on the list cannot show what is missing from it; this can.
    Kevin's ruling the same day: every payment request comes to info@ by email,
    so a line here means a request arrived some other way.

    A payment counts as listed when a row claims it OR the settle and link
    plans WOULD claim it, computed here in memory. The data check that uses
    this is not queued behind the 06:30 job, so on a morning the job runs late
    it must not report payments the job is about to settle. A split payment is
    listed when any of its parts is."""
    by_amount = index_by_amount(transactions)
    links, paid, _probable = plan_all(records, by_amount, "")
    claimed = (claimed_transactions(records) | {tx["id"] for _r, tx in links}
               | {tx["id"] for _r, tx in paid})
    groups = {split_group(tx) for tx in transactions if tx["id"] in claimed} - {None}
    return [tx for tx in transactions if is_business_transfer(tx)
            and tx["id"] not in claimed and split_group(tx) not in groups]


def load_window_outflows(start, end):
    """Outflows dated start <= date < end, with the account each left from."""
    formula = ("AND(NOT(IS_BEFORE({**Date}, '%s')), IS_BEFORE({**Date}, '%s'), {**GBP} < 0)"
               % (start, end))
    return airtable_list(T_TRANSACTIONS,
                         {"filterByFormula": formula, "fields[]": OUTFLOW_FIELDS},
                         what="Transactions window")


def unlisted_window(today, days):
    """[start, end) for the absence check: the `days` before yesterday. The
    bank feed lands a day or two late, so the newest two days are left for the
    next morning."""
    end = today - timedelta(days=1)
    return (end - timedelta(days=days)).isoformat(), end.isoformat()


def cmd_unlisted(args, records=None):
    today = datetime.now(LONDON).date()
    start, end = unlisted_window(today, args.days)
    records = records if records is not None else airtable_list(T_INVOICES, what="Dashboard Invoices")
    window = load_window_outflows(start, end)
    business = [tx for tx in window
                if any(a in BUSINESS_PAYMENT_ACCOUNTS
                       for a in tx["fields"].get("Account Alias (from **Account)") or [])]
    print("\nBusiness-account outflows %s to %s: %d   (CONTROL: zero means the "
          "feed or the query is broken)" % (start, end, len(business)))
    missing = unlisted_transfers(window, records)
    print("PAID BUT NEVER ON THE LIST (%d):" % len(missing))
    for tx in sorted(missing, key=tx_date):
        print("  %s  (%s)" % (tx_line(tx), tx["id"]))
    if missing:
        print("  Each of these was paid without a row on the Payment Run. Kevin's "
              "rule (25 Sep 2026): every request comes to info@agilelets.co.uk by email.")
    return missing, len(business)


# ══════════════════════════════════════════════════════════════════════════
# tasks — Kevin's approved MARK FOR PAYMENT cards
# ══════════════════════════════════════════════════════════════════════════

# The heading may be bold, a heading, quoted, a bullet or numbered.
MFP_LINE_RE = re.compile(r"^[ \t>*_#\-•]*(?:\d+[.)][ \t]*)?[*_]*MARK FOR PAYMENT\b",
                         re.I | re.M)


def card_field(text, label):
    """The value after `LABEL:` on its own line, markdown emphasis stripped."""
    match = re.search(r"^[ \t>*_\-•]*%s[ \t*_]*:[ \t*_]*(.+?)[ \t*_]*$" % re.escape(label),
                      text or "", re.I | re.M)
    return match.group(1).strip() if match else ""


MONTHS = {m: i for i, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}


def parse_due(text):
    """An ISO date out of '2026-10-24', '24 Oct 2026', '24 October 2026' or
    '24/10/2026'. None when there is no date to read, never a guess."""
    text = (text or "").strip()
    m = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", text)
    try:
        if m:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3))).date().isoformat()
        m = re.search(r"\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})\b", text)
        if m and m.group(2).lower() in MONTHS:
            return datetime(int(m.group(3)), MONTHS[m.group(2).lower()],
                            int(m.group(1))).date().isoformat()
        m = re.search(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", text)
        if m:
            return datetime(int(m.group(3)), int(m.group(2)), int(m.group(1))).date().isoformat()
    except ValueError:
        return None
    return None


def parse_payment_card(output):
    """The payable a MARK FOR PAYMENT card describes, or None if it is not one.

    The card lives in the task's Agent Output (the 18 Sep skill looked in Notes,
    and no code read either). Every field is read from the heading DOWN: an
    arrears summary above the card can carry its own AMOUNT line, and that
    figure is not the one to pay. The FIRST amount on the AMOUNT line is:
    '£2.22 (£1.11 ground rent + £1.11 arrears)' is £2.22."""
    head = MFP_LINE_RE.search(output or "")
    if not head:
        return None
    card = output[head.start():]
    # No agent prompt defines the card's shape, so cards arrive free-form too:
    # one reads "MARK FOR PAYMENT — £330.00 total (...)" with no AMOUNT line.
    # A figure on the heading line is the card's own and wins over any AMOUNT
    # line further down, which may belong to a quoted letter. Read from the END
    # of the match: the heading line itself, whatever came before it.
    heading = output[head.end():].split("\n", 1)[0]
    first = MONEY_RE.search(heading) or MONEY_RE.search(card_field(card, "AMOUNT"))
    amount = None
    if first:
        amount = float((first.group(1) or first.group(2)).replace(",", ""))
    return {
        "payee": card_field(card, "PAYEE"),
        "amount": amount,
        "reference": card_field(card, "REFERENCE"),
        "dueDate": parse_due(card_field(card, "DUE DATE")),
        "payToDetails": card_field(card, "PAY TO"),
        "description": card_field(card, "DESCRIPTION"),
        "notes": card_field(card, "NOTES"),
    }


def listing_date(due_iso):
    """The Friday strictly before the due date: when Kevin wants it on the list.
    Kevin, 25 Sep 2026, on a ground rent card: "put it on the Friday before the
    payment due for a payment run". A bill due on a Friday goes on the Friday
    before that, so it is paid in time rather than on the day."""
    due = datetime.fromisoformat(due_iso).date()
    return due - timedelta(days=((due.weekday() - CUTOFF_WEEKDAY) % 7) or 7)


def card_email_date(today):
    """The Email Date a card row carries: the day it came onto the list, except
    on a Friday, when it is the Thursday. The list's sections split on the
    Friday cutoff and a row dated the cutoff DAY counts as the newer week, so a
    card listed on a Friday and dated Friday would sit under "This week" (next
    Friday's run) the moment the 9pm cutoff passed, and a bill due on the
    Saturday would be paid a week late (review, 25 Sep 2026)."""
    return today - timedelta(days=1) if today.weekday() == CUTOFF_WEEKDAY else today


def norm_ref(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def same_amount(fields, card):
    amount = fields.get("Amount")
    return (amount is not None and card.get("amount") is not None
            and abs(abs(float(amount)) - card["amount"]) < 0.005)


def card_twin(c, records):
    """(row, how) for the row on the list that already IS this card's bill, or
    (None, None).

    how = "strong": the card names the row's own email (its Gmail id is in the
    card's track record, the row is within 14 days of the card) and the amounts
    agree, or the row already records the card. "reference": the same amount and the same reference on both.
    "weak": the same amount and payee around the card's date, nothing more.
    A weak twin is never folded in silently (review, 25 Sep 2026): a second bill
    of one size from one contractor looks exactly like it. The card is listed
    and the row's description says what to check."""
    card, text = c["card"], c.get("text", "")
    candidates = [r for r in records if status_of(r) in ("Unpaid", "Paid", "")]
    for r in candidates:
        mid = r["fields"].get(FIELD_MSG_ID) or ""
        if c["id"] in (r["fields"].get("Notes") or ""):
            return r, "strong"
        day = (r["fields"].get("Email Date") or "")[:10]
        # The track record also lists the sender's EARLIER emails, so the id
        # alone could be last month's bill of the same size (second review).
        # The card's own email is days old, not weeks.
        if (mid and ("#all/%s" % mid) in text and day and days_between(day, c["created"]) <= 14
                and (card.get("amount") is None or same_amount(r["fields"], card))):
            return r, "strong"
    for r in candidates:
        ref_row, ref_card = norm_ref(r["fields"].get("Reference")), norm_ref(card.get("reference"))
        if ref_row and ref_card and ref_row == ref_card and same_amount(r["fields"], card):
            return r, "reference"
    for r in candidates:
        day = (r["fields"].get("Email Date") or "")[:10]
        if (same_amount(r["fields"], card) and day and days_between(day, c["created"]) <= 30
                and payee_tokens(r["fields"].get("Payee")) & payee_tokens(card.get("payee"))):
            return r, "weak"
    return None, None


def approved_payment_cards():
    """Every task carrying a MARK FOR PAYMENT card that Kevin really approved.

    Real means the approval_evidence marks, the check every send path uses: an
    agent that typed "Approved" into the field itself must never be able to put
    money on Kevin's list. Cancelled tasks are out. Completed ones stay in: an
    approved card is still owed after its task closes."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from approval_evidence import approval_evidence_problem
    formula = ("AND(FIND('MARK FOR PAYMENT', UPPER({Agent Output}&'')), "
               "OR({Approval Outcome}='Approved as-is', "
               "{Approval Outcome}='Approved with minor edits'), "
               "NOT({Status}='Cancelled'))")
    rows = airtable_list(T_TASKS, [("filterByFormula", formula),
                                   ("returnFieldsByFieldId", "true")],
                         what="approved payment cards")
    out = []
    for row in rows:
        f = row.get("fields", {})
        problem = approval_evidence_problem(f, row.get("createdTime", ""))
        out.append({
            "id": row["id"],
            "name": f.get(TASK_F["name"]) or "",
            "created": (row.get("createdTime") or "")[:10],
            "card": None if problem else parse_payment_card(f.get(TASK_F["output"])),
            "refused": problem,
            "text": (f.get(TASK_F["output"]) or "") + "\n" + (f.get(TASK_F["notes"]) or ""),
        })
    return out


def plan_tasks(cards, records, by_amount, today):
    """What each approved card needs. Pure, so the dry run and the job agree.

    Returns a list of (action, card, detail):
      create       add it to the list
      check        add it, and its description names a possible twin (a weak match)
      check_paid   add it, and its description names a payment since the card
                   that may already be this bill
      link         an open row already is this bill (strong or reference twin)
      paid         a Paid row already is this bill
      wait         not yet the Friday before it is due
      listed       its own row exists
      refused      no real approval
      unreadable   no MARK FOR PAYMENT heading could be read"""
    by_key = {r["fields"].get(FIELD_MSG_ID): r for r in records}
    used = claimed_transactions(records)
    plan = []
    for c in cards:
        card = c.get("card")
        if c.get("refused"):
            plan.append(("refused", c, c["refused"]))
            continue
        if not card:
            plan.append(("unreadable", c, "no MARK FOR PAYMENT heading could be read"))
            continue
        # A card with no PAYEE line is named after its task. A card with no
        # amount anywhere still goes on the list, amount blank, pointing at the
        # task: a row Kevin dismisses in two seconds beats an approved bill that
        # silently never appears (the skill's own rule since 18 Sep 2026).
        card["payee"] = card.get("payee") or re.split(r"\s+[-–—]\s+", c["name"])[0].strip()
        key = "task:%s" % c["id"]
        if key in by_key:
            plan.append(("listed", c, by_key[key]["id"]))
            continue
        twin, how = card_twin(c, records)
        if twin is not None and how in ("strong", "reference"):
            plan.append(("paid" if status_of(twin) == "Paid" else "link", c, twin))
            continue
        if card.get("dueDate") and today < listing_date(card["dueDate"]):
            plan.append(("wait", c, listing_date(card["dueDate"]).isoformat()))
            continue
        lf = listing_date(card["dueDate"]) if card.get("dueDate") else None
        # Dated for the run it belongs to. A Mac asleep on the Friday lists it
        # on the Saturday, and dated Saturday it would sit in NEXT Friday's
        # section; dated the Thursday before its Friday it is in the run to pay.
        c["emailDate"] = ((lf - timedelta(days=1)) if lf and 0 <= (today - lf).days <= 3
                          else card_email_date(today)).isoformat()
        # A payment since the card, naming the payee, MAY be this bill, or may
        # be another job for the same firm. Never decided here (second review,
        # 25 Sep 2026): the card is listed and its description says to check.
        probe = {"fields": {"Amount": card.get("amount"), "Email Date": c["created"],
                            "Payee": card.get("payee")}}
        hit = match_transaction(probe, by_amount, exclude=used) if card.get("amount") else None
        if hit and hit[1] == "confirmed":
            plan.append(("check_paid", c, hit[0]))
            continue
        plan.append(("check", c, twin) if twin is not None else ("create", c, None))
    return plan


def task_row_fields(c, today, twin=None, maybe_paid=None):
    """A new list row for a card, always Unpaid. Run Date is left alone: it is
    the Friday scan's own proof of life. A CHECK: description is the only way
    a doubt reaches Kevin, because the page shows the description and not the
    notes."""
    card = c["card"]
    description = card.get("description") or c["name"]
    if twin is not None:
        f = twin["fields"]
        description = "CHECK: this may be the same bill as the £%.2f %s row dated %s. %s" % (
            float(f.get("Amount") or 0), f.get("Payee") or "", (f.get("Email Date") or "")[:10],
            description)
    if maybe_paid is not None:
        description = "CHECK: may already be paid (%s). %s" % (tx_line(maybe_paid), description)
    fields = {
        FIELD_MSG_ID: "task:%s" % c["id"],
        "Payee": card.get("payee") or c["name"],
        "Description": description,
        "Email Date": c.get("emailDate") or card_email_date(today).isoformat(),
        "Status": "Unpaid",
        "Source": "Payment card",
        "Notes": ("[%s — payment-run] From Kevin's approved payment card, task %s "
                  "(https://airtable.com/%s/%s/%s).%s" % (
                      today.strftime("%-d %b %Y"), c["id"], BASE, T_TASKS, c["id"],
                      (" " + card["notes"]) if card.get("notes") else "")),
    }
    if card.get("amount") is not None:
        fields["Amount"] = card["amount"]
    else:
        fields["Notes"] += " Amount not stated on the card: open the task."
    for key, column in (("reference", "Reference"), ("dueDate", "Due Date"),
                        ("payToDetails", "Pay To Details")):
        if card.get(key):
            fields[column] = card[key]
    return fields


def run_tasks(records, transactions, apply, today):
    """Returns the plan. A refused card is a card an agent approved itself; the
    daily job goes red on it rather than leaving the fact in a log."""
    cards = approved_payment_cards()
    plan = plan_tasks(cards, records, index_by_amount(transactions), today)
    print("\nAPPROVED PAYMENT CARDS: %d" % len(cards))
    creates, updates = [], []
    for action, c, detail in plan:
        card = c.get("card") or {}
        label = "%s | %s | £%s" % (c["id"], str(card.get("payee") or c["name"])[:34],
                                   card.get("amount"))
        if action in ("create", "check", "check_paid"):
            print("  %-20s %s | due %s" % ({"create": "ADD to the list",
                                             "check": "ADD, POSSIBLE TWIN",
                                             "check_paid": "ADD, MAY BE PAID"}[action],
                                            label, card.get("dueDate") or "-"))
            creates.append({"fields": task_row_fields(
                c, today, twin=detail if action == "check" else None,
                maybe_paid=detail if action == "check_paid" else None)})
        elif action == "link":
            print("  ALREADY LISTED       %s | as row %s (the same bill)" % (label, detail["id"]))
            if c["id"] not in (detail["fields"].get("Notes") or ""):
                fields = {"Notes": append_note(detail, "Also Kevin's approved payment card, "
                                                       "task %s." % c["id"])}
                if card.get("dueDate") and not detail["fields"].get("Due Date"):
                    fields["Due Date"] = card["dueDate"]
                updates.append({"id": detail["id"], "fields": fields})
        elif action == "paid":
            print("  ALREADY PAID         %s | row %s" % (label, detail["id"]))
        elif action == "wait":
            print("  WAITING until %s %s" % (detail, label))
        elif action == "listed":
            print("  on the list          %s | row %s" % (label, detail))
        else:
            print("  %-20s %s | %s" % (action.upper(), label, detail))
    if apply:
        if creates:
            airtable_write(T_INVOICES, "POST", creates, "add payment-card rows")
        if updates:
            airtable_write(T_INVOICES, "PATCH", updates, "link payment cards")
    elif creates or updates:
        print("DRY RUN: %d to add, %d to link. Re-run with --apply." % (len(creates), len(updates)))
    return plan


def cmd_tasks(args):
    today = (parse_asof(args.asof) or datetime.now(LONDON)).date()
    records = airtable_list(T_INVOICES, what="Dashboard Invoices")
    return run_tasks(records, load_controlled_outflows(default_since()), args.apply, today)


def cmd_daily(args):
    """The 06:30 job. Settle first, so every payment already on the list is
    claimed before a card asks whether the bank shows it paid; then the cards;
    then settle again for what the cards just added; then the absence report.
    Pure script, no model, so it costs no Claude allowance (Kevin declined a
    daily Claude run on cost, 18 Sep 2026). Exits 1 when a card was refused:
    an agent approving its own payment must turn the job red, not sit in a log."""
    today = datetime.now(LONDON).date()
    transactions = load_controlled_outflows(default_since())
    run_settle(airtable_list(T_INVOICES, what="Dashboard Invoices"), transactions, True)
    plan = run_tasks(airtable_list(T_INVOICES, what="Dashboard Invoices"), transactions, True, today)
    run_settle(airtable_list(T_INVOICES, what="Dashboard Invoices"), transactions, True)
    args.days = 7
    cmd_unlisted(args, airtable_list(T_INVOICES, what="Dashboard Invoices"))
    refused = [c["id"] for action, c, _d in plan if action == "refused"]
    if refused:
        fail("%d payment card(s) carry no real approval and were NOT listed: %s. "
             "An agent marked them approved itself; find out how." % (len(refused), ", ".join(refused)))
    print("\npayment-run daily: done")


def cmd_done(_args):
    """The Friday run's last step. The scan it read becomes where the next
    Friday starts, but only if that scan was complete: a truncated week is
    read again next time rather than stamped as done."""
    try:
        pending = json.loads(SCAN_PENDING.read_text())
    except (OSError, ValueError):
        fail("no scan stamp at %s: run `scan` first. Nothing moved." % SCAN_PENDING)
    if not pending.get("complete"):
        fail("the scan ending %s was truncated, so this week is NOT done. The "
             "next run starts from the last complete one." % pending.get("end"))
    write_stamp(SCAN_LAST_GOOD, pending)
    print("Next Friday's scan starts from %s." % pending["end"])


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

def bucket_rows(open_rows, this_start, last_start):
    """Split into (this week, last week, still owed).

    Email Date is a DATE, so a boundary DAY cannot be split by the 21:00 cutoff.
    An invoice dated the day the cutoff fell counts as the NEWER bucket, which
    keeps it higher up the list rather than ageing it out early — the wrong
    direction here is the one that hides something Kevin still has to pay."""
    this_iso = this_start.date().isoformat()
    last_iso = last_start.date().isoformat()
    this_week, last_week, still_owed = [], [], []
    for rec in open_rows:
        day = (rec["fields"].get("Email Date") or "")[:10]
        if day >= this_iso:
            this_week.append(rec)
        elif day >= last_iso:
            last_week.append(rec)
        else:
            still_owed.append(rec)
    return this_week, last_week, still_owed


def cmd_report(args):
    asof = parse_asof(args.asof)
    _start, end = run_window(asof)
    this_start, last_start = week_buckets(asof)
    records = airtable_list(T_INVOICES, what="Dashboard Invoices")
    open_rows = [r for r in records if status_of(r) == "Unpaid"]
    this_week, last_week, still_owed = bucket_rows(open_rows, this_start, last_start)

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
    block("THIS WEEK (since %s)" % this_start.strftime("%a %-d %b, 9pm"), this_week)
    block("LAST WEEK (%s to %s) — this is tonight's payment run"
          % (last_start.strftime("%-d %b"), this_start.strftime("%-d %b")), last_week)
    block("STILL OWED (older, carried forward)", still_owed)
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

    # THE 18 SEP 2026 BUG. The job is scheduled for 21:00, the cutoff itself.
    # Asked which week it is at that instant, run_window() answers with the one
    # just STARTING — and the first live run duly scanned seven days of mail
    # that had not arrived yet, found nothing, and exited 0. The scan range must
    # look BACKWARDS from now, whatever the clock says.
    for at in ("2026-09-18T20:59:00", "2026-09-18T21:00:00",
               "2026-09-18T21:00:30", "2026-09-18T21:05:00",
               "2026-09-18T23:30:00"):
        s, e = scan_range(datetime.fromisoformat(at).replace(tzinfo=LONDON), back_days=1)
        check("scan at %s ends now, not in the future" % at, e.isoformat()[:16], at[:16])
        check("scan at %s reaches back past the closed week" % at,
              s < datetime(2026, 9, 11, 21, tzinfo=LONDON), True)
    # And it must never read the future.
    s, e = scan_range(datetime(2026, 9, 18, 21, 0, tzinfo=LONDON))
    check("the scan never reads forward of now", e <= datetime(2026, 9, 18, 21, 0, tzinfo=LONDON), True)

    # Three buckets. At 21:05 Friday, the week Kevin is paying is LAST week.
    friday_evening = datetime(2026, 9, 18, 21, 5, tzinfo=LONDON)
    this_start, last_start = week_buckets(friday_evening)
    check("this week starts at tonight's cutoff", this_start.isoformat(), "2026-09-18T21:00:00+01:00")
    check("last week starts a week before that", last_start.isoformat(), "2026-09-11T21:00:00+01:00")
    rows = [
        {"id": "new", "fields": {"Email Date": "2026-09-19"}},   # after the cutoff
        {"id": "pay", "fields": {"Email Date": "2026-09-16"}},   # the week just closed
        {"id": "old", "fields": {"Email Date": "2026-02-03"}},   # February
        {"id": "edge", "fields": {"Email Date": "2026-09-11"}},  # the boundary DAY
    ]
    a, b, c = bucket_rows(rows, this_start, last_start)
    check("mail after the cutoff is This week", [r["id"] for r in a], ["new"])
    check("the week just closed is Last week — NOT Still owed",
          sorted(r["id"] for r in b), ["edge", "pay"])
    check("February is Still owed", [r["id"] for r in c], ["old"])
    # Before the cutoff on the same Friday nothing has rolled yet: the week
    # Kevin is about to pay is still This week, and Last week (4-11 Sep) is
    # empty because no row falls there. Six minutes later everything shifts
    # down one — which is precisely what he saw and asked to be fixed.
    t2, l2 = week_buckets(datetime(2026, 9, 18, 20, 59, tzinfo=LONDON))
    check("before 9pm This week still starts at the PREVIOUS cutoff",
          t2.isoformat(), "2026-09-11T21:00:00+01:00")
    a2, b2, c2 = bucket_rows(rows, t2, l2)
    check("before 9pm the week being paid is still This week",
          sorted(r["id"] for r in a2), ["edge", "new", "pay"])
    check("and Last week is empty, not holding this week's work", b2, [])
    check("February is Still owed either side of the cutoff",
          [r["id"] for r in c2], ["old"])

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

    # ── 25 Sep 2026 audit: the four ways the list went wrong ──────────────
    # Invented names and fake bank details throughout: the repo is public.
    D = lambda s: datetime.fromisoformat(s).date()
    txn = lambda i, day, gbp, name, **extra: {"id": i, "fields": dict(
        {"**Date": day, "**GBP": gbp, "*Name": name}, **extra)}
    bill = lambda i, day, amount, payee, **extra: {"id": i, "fields": dict(
        {"Status": "Unpaid", "Amount": amount, "Email Date": day, "Payee": payee}, **extra)}

    # 1. A paid row never left the list. The shape of the real case: a £90 gas
    #    certificate emailed on the 16th, paid on the 21st, the bank line naming
    #    the engineer's company.
    gas = bill("recGas", "2026-09-16", 90, "Brightwater Gas Ltd", Description="LGSR, 5 Mill Lane")
    gas_tx = txn("txGas", "2026-09-21", -90, "Brightwater Gas Ltd 5 Mill Lane")
    paid, probable = plan_settle([gas], index_by_amount([gas_tx]))
    check("a corroborated payment settles its row",
          [(r["id"], t["id"]) for r, t in paid], [("recGas", "txGas")])
    ups = settle_updates(paid, probable)
    check("settling writes Paid, the date and the transaction",
          (ups[0]["fields"]["Status"], ups[0]["fields"]["Paid Date"],
           ups[0]["fields"]["Matched Transaction"]), ("Paid", "2026-09-21", ["txGas"]))
    paid2, _ = plan_settle([dict(gas, id="recA"), dict(gas, id="recB")], index_by_amount([gas_tx]))
    check("one bank payment settles one bill, not two", len(paid2), 1)
    claimed = [bill("recOld", "2026-09-01", 90, "Brightwater Gas Ltd", Status="Paid",
                    **{"Matched Transaction": ["txGas"]}), gas]
    check("a payment already claimed is never reused",
          plan_settle(claimed, index_by_amount([gas_tx]))[0], [])
    # Two £90 bills from one engineer for two houses: the bank line names the
    # second house, so the second bill is the one paid, not the oldest.
    house_a = bill("recHouseA", "2026-09-10", 90, "Brightwater Gas Ltd", Description="LGSR, 22 Oak Road")
    house_b = bill("recHouseB", "2026-09-16", 90, "Brightwater Gas Ltd", Description="LGSR, 5 Mill Lane")
    check("the bill whose property the bank line names is the one settled",
          [r["id"] for r, _t in plan_settle([house_a, house_b], index_by_amount([gas_tx]))[0]],
          ["recHouseB"])
    check("with nothing to tell them apart, the oldest is settled",
          [r["id"] for r, _t in plan_settle(
              [house_a, house_b],
              index_by_amount([txn("txBare", "2026-09-21", -90, "Brightwater Gas Ltd")]))[0]],
          ["recHouseA"])
    stranger = txn("txX", "2026-09-21", -90, "Oakfield Roofing")
    paid4, prob4 = plan_settle([gas], index_by_amount([stranger]))
    check("an uncorroborated match does not settle", (len(paid4), len(prob4)), (0, 1))
    noted = dict(gas, fields=dict(gas["fields"], Notes="... (txX)"))
    check("a probable note is written once", settle_updates([], [(noted, stranger)]), [])
    check("Historic rows are never settled",
          plan_settle([dict(gas, fields=dict(gas["fields"], Status="Historic"))],
                      index_by_amount([gas_tx])), ([], []))
    check("a row whose suggested match Kevin rejected is never settled",
          plan_settle([dict(gas, fields=dict(gas["fields"], **{"AI Match Rejected": True}))],
                      index_by_amount([gas_tx])), ([], []))
    check("no payee words to compare means no 'possible payment' note",
          plan_settle([bill("recS", "2026-06-12", 90, "licensing@council.gov.uk")],
                      index_by_amount([stranger])), ([], []))
    # Whole words: "city" is inside "electricity", and that closed a council's
    # bill on an electricity direct debit in review.
    council = bill("recCity", "2026-09-01", 150, "Coventry City Council")
    check("a payee word inside another word is not the payee",
          plan_settle([council], index_by_amount(
              [txn("txDD", "2026-09-05", -150, "DD:OCTOPUS ELECTRICITY")]))[0], [])
    check("a bank line that cuts the name short still names the payee",
          len(plan_settle([bill("recGl", "2026-09-01", 60, "Brightwells Glazing")],
                          index_by_amount([txn("txGl", "2026-09-02", -60, "BRIGHTWELL GLAZ")]))[0]), 1)
    check("generic words never corroborate", payee_tokens("Oakfield Properties Limited"), {"oakfield"})
    check("a short shared start is not the payee",
          len(plan_settle([bill("recBw", "2026-09-01", 60, "Brightwater Gas Ltd")],
                          index_by_amount([txn("txBs", "2026-09-02", -60, "BRIGHT SPARK ELEC")]))[0]), 0)
    # A split payment: the parent line keeps the whole bank amount, and its
    # Split Override Amount is its own part. Each part pays its own bill.
    parent = txn("txP", "2026-09-05", -512, "Oakfield Roofing 3 Ash Road 9 Elm Road (Split 1 of 2)",
                 **{"Split Override Amount": -256})
    child = txn("txC", "2026-09-05", -256, "Oakfield Roofing 3 Ash Road 9 Elm Road (Split 2 of 2)")
    two = [bill("recR1", "2026-09-01", 256, "Oakfield Roofing", Description="3 Ash Road"),
           bill("recR2", "2026-09-01", 256, "Oakfield Roofing", Description="9 Elm Road")]
    check("both halves of a split payment settle their own bills",
          len(plan_settle(two, index_by_amount([parent, child]))[0]), 2)
    # A row marked Paid by hand gets its payment linked, and claims it FIRST:
    # the open twin of the same size stays owed.
    hand_paid = bill("recHand", "2026-09-16", 90, "Brightwater Gas Ltd", Status="Paid",
                     **{"Paid Date": "2026-09-22"})
    links, paid5, _p = plan_all([hand_paid, gas], index_by_amount([gas_tx]), "2026-09-01")
    check("a hand-paid row is linked to its payment, and its open twin is not settled by it",
          ([(r["id"], t["id"]) for r, t in links], paid5), ([("recHand", "txGas")], []))
    check("a hand-paid row is not linked to a payment booked 4+ days after it was marked paid",
          plan_links([dict(hand_paid, fields=dict(hand_paid["fields"], **{"Paid Date": "2026-09-17"}))],
                     index_by_amount([gas_tx]), "2026-09-01"), [])
    check("nor, without the payee named, to one far from the day it was marked paid",
          plan_links([dict(hand_paid, fields=dict(hand_paid["fields"], **{"Paid Date": "2026-09-30"}))],
                     index_by_amount([stranger]), "2026-09-01"), [])
    acme_paid = bill("recAcme", "2026-09-10", 90, "Acme Roofing", Status="Paid", **{"Paid Date": "2026-09-21"})
    links6, paid6, _p6 = plan_all([acme_paid, gas], index_by_amount([gas_tx]), "2026-09-01")
    check("a hand-paid row never takes a payment that names an open bill's payee",
          ([r["id"] for r, _t in links6], [r["id"] for r, _t in paid6]), ([], ["recGas"]))
    check("an old hand-paid row is left alone",
          plan_links([hand_paid], index_by_amount([gas_tx]), "2026-09-23"), [])

    # 2. Approved MARK FOR PAYMENT cards never reached the list.
    card_text = ("MARK FOR PAYMENT: Oakfield ground rent, 4 Park Row\n\n"
                 "PAYEE: Oakfield Ground Rents Limited\n"
                 "AMOUNT: £2.22 (£1.11 ground rent + £1.11 arrears)\n"
                 "REFERENCE: GR-4471\nDUE DATE: 2026-10-24\n"
                 "PAY TO: Example Bank, sort code 00-00-00, account 00000000\n"
                 "DESCRIPTION: Half-yearly ground rent\n")
    card = parse_payment_card(card_text)
    check("the card's payee, FIRST amount, reference and due date are read",
          (card["payee"], card["amount"], card["reference"], card["dueDate"]),
          ("Oakfield Ground Rents Limited", 2.22, "GR-4471", "2026-10-24"))
    check("fields above the card's heading are not the card's",
          parse_payment_card("Arrears summary\nAMOUNT: £3,000.00\n\nMARK FOR PAYMENT\n"
                             "PAYEE: Oakfield Roofing\nAMOUNT: £100.00")["amount"], 100.0)
    check("bold markdown labels still read",
          parse_payment_card("**MARK FOR PAYMENT**\n**PAYEE:** Acme Ltd\n**AMOUNT:** £45.00")
          ["amount"], 45.0)
    check("a bullet or numbered heading is a heading",
          [bool(parse_payment_card(h + "MARK FOR PAYMENT\nAMOUNT: £1")) for h in ("- ", "1. ", "## ")],
          [True, True, True])
    check("a TIER banner above the card is fine",
          parse_payment_card(":rotating_light: TIER 1.\n\nMARK FOR PAYMENT: x\nPAYEE: A\nAMOUNT: £1")
          ["payee"], "A")
    check("a task that is not a card is not a card", parse_payment_card("Decision brief"), None)
    check("due dates in words", parse_due("24 October 2026"), "2026-10-24")
    check("due dates with slashes", parse_due("29/09/2026"), "2026-09-29")
    check("no date is None, never a guess", parse_due("by the end of the month"), None)
    check("a Saturday bill lists the Friday before",
          listing_date("2026-10-24").isoformat(), "2026-10-23")
    check("a Friday bill lists a week early, not on the day",
          listing_date("2026-10-30").isoformat(), "2026-10-23")
    # A card listed on a Friday is dated the Thursday, so after the 9pm cutoff
    # it sits in "Last week — the run to pay", not in next Friday's section.
    t_start, l_start = week_buckets(datetime(2026, 10, 23, 21, 5, tzinfo=LONDON))
    listed = {"id": "c", "fields": {"Email Date": card_email_date(D("2026-10-23")).isoformat()}}
    check("a card listed on a Friday is in the run to pay after the cutoff",
          [r["id"] for r in bucket_rows([listed], t_start, l_start)[1]], ["c"])
    check("a card listed midweek keeps its own day",
          card_email_date(D("2026-10-20")).isoformat(), "2026-10-20")
    task = {"id": "recCard", "name": "Oakfield ground rent", "created": "2026-09-25",
            "card": card, "refused": "", "text": card_text}
    act = lambda plan: [(a, d if isinstance(d, (str, type(None))) else d.get("id"))
                        for a, _c, d in plan]
    check("before its Friday the card waits",
          act(plan_tasks([task], [], {}, D("2026-09-26"))), [("wait", "2026-10-23")])
    check("on its Friday the card goes on the list",
          act(plan_tasks([task], [], {}, D("2026-10-23"))), [("create", None)])
    fields = task_row_fields(task, D("2026-10-23"))
    check("its row names the card and never stamps Run Date",
          ("Run Date" in fields, fields[FIELD_MSG_ID]), (False, "task:recCard"))
    # The email came on Monday and triage made the card on Tuesday: the card's
    # track record names that email, so they are one bill, not two.
    email_row = bill("recMail", "2026-09-21", 2.22, "Oakfield Ground Rents Ltd",
                     **{FIELD_MSG_ID: "18a0f00dcafe0001"})
    tuesday = dict(task, created="2026-09-22", text=card_text + "\n- email: #all/18a0f00dcafe0001")
    check("an email the card itself names is linked, even from the day before",
          act(plan_tasks([tuesday], [email_row], {}, D("2026-10-23"))), [("link", "recMail")])
    check("and if that row is paid, the card is never added again",
          act(plan_tasks([tuesday], [dict(email_row, fields=dict(email_row["fields"], Status="Paid"))],
                         {}, D("2026-10-23"))), [("paid", "recMail")])
    check("the same reference and amount is the same bill",
          act(plan_tasks([task], [bill("recRef", "2026-09-01", 2.22, "Other name",
                                       Reference="GR 4471")], {}, D("2026-10-23"))),
          [("link", "recRef")])
    # Same payee, same size, nothing else: could be a second bill. Listed, with
    # the description saying what to check, never folded in silently.
    weak = act(plan_tasks([task], [bill("recWeak", "2026-09-24", 2.22, "Oakfield Ground Rents Ltd")],
                          {}, D("2026-10-23")))
    check("a same-payee same-size row is only a possible twin, and the card is still listed",
          weak, [("check", "recWeak")])
    check("and its description says what to check",
          task_row_fields(task, D("2026-10-23"),
                          twin=bill("recWeak", "2026-09-24", 2.22, "Oakfield")).get("Description", "")
          .startswith("CHECK:"), True)
    check("an Estimate row is never a twin",
          act(plan_tasks([task], [bill("recEst", "2026-09-24", 2.22, "Oakfield Ground Rents Ltd",
                                       Status="Estimate", Reference="GR-4471")], {}, D("2026-10-23"))),
          [("create", None)])
    early = txn("txEarly", "2026-10-01", -2.22, "Oakfield Ground Rents GR4471")
    check("a card with a possible earlier payment is still listed, never assumed paid",
          act(plan_tasks([task], [], index_by_amount([early]), D("2026-10-23"))),
          [("check_paid", "txEarly")])
    mp = task_row_fields(task, D("2026-10-23"), maybe_paid=early)
    check("and it is listed Unpaid with the payment named in its description",
          (mp["Status"], mp["Description"].startswith("CHECK: may already be paid")), ("Unpaid", True))
    sat = plan_tasks([task], [], {}, D("2026-10-24"))[0][1]
    check("a card listed late on the Saturday is dated for the Friday run it missed",
          task_row_fields(sat, D("2026-10-24"))["Email Date"], "2026-10-22")
    check("an old id in the card's track record is not this card's bill",
          act(plan_tasks([dict(task, text=card_text + "\n- email: #all/18a0f00dcafe0009")],
                         [bill("recLast", "2026-08-20", 2.22, "Oakfield Ground Rents Ltd", Status="Paid",
                               **{FIELD_MSG_ID: "18a0f00dcafe0009"})], {}, D("2026-10-23"))),
          [("create", None)])
    check("a heading's own amount wins over an AMOUNT line lower down",
          parse_payment_card("MARK FOR PAYMENT — £330.00\n\n> quoted letter\n> AMOUNT: £3,000.00")
          ["amount"], 330.0)
    check("a card already on the list is left alone",
          act(plan_tasks([task], [{"id": "recRow", "fields": {FIELD_MSG_ID: "task:recCard"}}],
                         {}, D("2026-10-23"))), [("listed", "recRow")])
    check("a card without a real approval is refused",
          plan_tasks([dict(task, refused="no approval was ever recorded")], [], {},
                     D("2026-10-23"))[0][0], "refused")
    check("the scan marks the email a card already is",
          card_for_message("18a0f00dcafe0001", [2.22, 1.11],
                           [dict(card, taskId="recCard", text="#all/18a0f00dcafe0001")]), "recCard")
    check("but not a different bill from the same sender",
          card_for_message("18a0f00dcafe0001", [45.0],
                           [dict(card, taskId="recCard", text="#all/18a0f00dcafe0001")]), None)
    # The free-form shape a real approved card used: no PAYEE or AMOUNT line,
    # the figure on the heading. It had never reached the list.
    freeform = parse_payment_card("Six reminders since April.\n\nMARK FOR PAYMENT — £330.00 "
                                  "total (two invoices)\n\nKevin's feedback: ...")
    check("a free-form card's amount comes from its heading", freeform["amount"], 330.0)
    ff_task = {"id": "recFF", "name": "Oakfield Alarms Ltd - 2 Ash Court", "created": "2026-02-18",
               "card": freeform, "refused": "", "text": ""}
    ff_plan = plan_tasks([ff_task], [], {}, D("2026-09-25"))
    check("a free-form card with no due date goes on the list now, named after its task",
          (ff_plan[0][0], ff_plan[0][1]["card"]["payee"]), ("create", "Oakfield Alarms Ltd"))
    blank = parse_payment_card("MARK FOR PAYMENT\nSee the attached statement.")
    b_task = {"id": "recB", "name": "Council tax", "created": "2026-09-01", "card": blank,
              "refused": "", "text": ""}
    b_fields = task_row_fields(plan_tasks([b_task], [], {}, D("2026-09-25"))[0][1], D("2026-09-25"))
    check("a card with no amount still goes on the list, amount blank, pointing at its task",
          ("Amount" in b_fields, "open the task" in b_fields["Notes"]), (False, True))

    # 3. Money that left without ever being on the list.
    zem = lambda i, name, gbp=-80, **extra: {"id": i, "fields": dict({
        "Account Alias (from **Account)": ["TNT Mgt Zempler"], "**GBP": gbp, "*Name": name,
        "**Date": "2026-09-20"}, **extra)}
    txs = [zem("t1", "Oakfield Roofing 3 Ash Road"), zem("t2", "Fin: AMZNMktplace*TA1"),
           zem("t3", "DD:LOAN CO 1234"), zem("t4", "Electronic Payment Fee 17/08"),
           zem("t5", "Oakfield Roofing 9 Elm (Split 2 of 2)"),
           zem("t6", "Oakfield Roofing 9 Elm (Split 1 of 2)"),
           zem("t7", "Brightwater Gas Ltd 5 Mill Lane", -90),
           {"id": "t8", "fields": {"Account Alias (from **Account)": ["Santander"],
                                   "**GBP": -45, "*Name": "BILL PAYMENT TO X", "**Date": "2026-09-20"}},
           zem("t9", "Refund in", 50)]
    check("hand-made business transfers no row claims are reported",
          sorted(t["id"] for t in unlisted_transfers(
              txs, [{"id": "r1", "fields": {"Matched Transaction": ["t7"]}}])), ["t1", "t6"])
    check("a payment an open row is about to settle is not reported",
          sorted(t["id"] for t in unlisted_transfers(
              txs, [bill("rOpen", "2026-09-16", 90, "Brightwater Gas Ltd")])), ["t1", "t6"])
    check("a split payment is listed when any of its parts is",
          sorted(t["id"] for t in unlisted_transfers(
              txs, [{"id": "r2", "fields": {"Matched Transaction": ["t5", "t7"]}}])), ["t1"])
    same_day = [zem("s1", "Oakfield Roofing 3 Ash Road", -80), zem("s2", "Oakfield Roofing 3 Ash Road", -100)]
    check("two same-day payments are two payments, not one split",
          [t["id"] for t in unlisted_transfers(same_day, [{"id": "r", "fields": {"Matched Transaction": ["s1"]}}])],
          ["s2"])
    check("the absence window leaves the newest day for the feed",
          unlisted_window(D("2026-09-25"), 7), ("2026-09-17", "2026-09-24"))

    # 4. A missed Friday was lost for good: the scan never looked back further
    #    than seven days, and its one scheduled run read the wrong week.
    now = datetime(2026, 9, 25, 21, 0, tzinfo=LONDON)
    s, _e = scan_range(now, 1, datetime(2026, 9, 11, 21, 0, tzinfo=LONDON))
    check("after a missed Friday the scan starts from the last good run",
          s.isoformat(), "2026-09-10T21:00:00+01:00")
    s, _e = scan_range(now, 1, datetime(2026, 9, 18, 21, 0, tzinfo=LONDON))
    check("after a normal week it reads its usual reach",
          s.isoformat(), "2026-09-17T21:00:00+01:00")
    s, _e = scan_range(now, 1, datetime(2026, 1, 1, tzinfo=LONDON))
    check("a catch-up never reaches past the cap", (now - s).days, MAX_CATCHUP_DAYS)
    check("a two-week catch-up gets two weeks of pages", pages_for(15), 26)
    check("one week keeps the old page cap", pages_for(8), MAX_PAGES + 2)
    check("the page cap has a ceiling", pages_for(365), MAX_PAGES * 5)

    if failures:
        for line in failures:
            print("FAIL " + line)
        sys.exit(1)
    print("payment-run selftest: all checks pass")


# ══════════════════════════════════════════════════════════════════════════

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("window")
    p.add_argument("--asof")
    p.add_argument("--back-days", type=int, default=1)
    p.set_defaults(fn=cmd_window)

    p = sub.add_parser("scan")
    p.add_argument("--asof")
    # One day of overlap, as the skill has always said. The default was 0, so
    # the scan read exactly seven days and a run firing a minute early left a
    # minute of mail between two Fridays that neither read.
    p.add_argument("--back-days", type=int, default=1,
                   help="re-read this many days behind the window start")
    p.add_argument("--max-attachments", type=int, default=MAX_ATTACHMENTS,
                   help="attachment budget per seven days scanned")
    p.set_defaults(fn=cmd_scan)

    p = sub.add_parser("check")
    p.add_argument("--since")
    p.set_defaults(fn=cmd_check)

    p = sub.add_parser("settle")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--since")
    p.set_defaults(fn=cmd_settle)

    p = sub.add_parser("tasks")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--asof", help="judge 'the Friday before it is due' as of this date")
    p.set_defaults(fn=cmd_tasks)

    p = sub.add_parser("unlisted")
    p.add_argument("--days", type=int, default=7)
    p.set_defaults(fn=cmd_unlisted)

    p = sub.add_parser("daily"); p.set_defaults(fn=cmd_daily)
    p = sub.add_parser("done"); p.set_defaults(fn=cmd_done)

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
