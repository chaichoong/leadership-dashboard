#!/usr/bin/env python3
"""DWP and Universal Credit notices reach the tenancy record in code, not by an agent's judgement.

WHY THIS EXISTS (finding 20261118-agent-dispatch-1353)
Universal Credit and DWP mail to info@ was filed by the triage robot as "answered" or archived, and
the fact in it (a direct payment arrangement started, housing costs referred to a decision maker)
never reached the tenancy it was about. Whether it did depended on the agent's view of each message.
Now the scan reads the tenant and the decision off the FULL body (the one moment it exists) into the
scan cache, and every triage decision on that message (`note` and `act`, every action) calls
`record`, which:

  * finds the ONE live tenancy whose linked tenant has that name (surname first, the given name to
    break a tie or to refuse a contradiction) and posts ONE dated comment on it, through the same
    comments endpoint scripts/tenancy-record.py uses; or
  * when no name was read, or no live tenancy or several match, raises ONE task for the Accounts
    Receivable agent through scripts/create-agent-task.py: "RENT CHECK: DWP notice names <name or
    no tenant>, match it to a tenancy". Never a guess.

Idempotent on the Gmail message id through a small ledger, so a second decision on the same message
(act, then note) or a rescan never comments twice or raises a second task.

USAGE
  dwp_notice.py backfill --dry-run [--reread]   what a back-fill would do for every DWP message in
                                                the triage scan cache (reads only)
  dwp_notice.py backfill [--reread]             do it (comments and tasks, ledgered)
    --reread reads the full body from Gmail (read-only) for a message scanned before this step
    existed, whose cache entry has no "dwp" part. Without it such a message is listed, not guessed.

Ledger: ~/knowledge-os/logs/dwp-notice/ledger.jsonl (DWP_NOTICE_LEDGER overrides it). Private, never
the repo: it names tenancies and Gmail messages.
"""
import contextlib
import importlib.util
import io
import json
import os
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
LONDON = ZoneInfo("Europe/London")

# The Accounts Receivable agent's Team Members row (scripts/rent-check.py AGENT_TEAM_MEMBER).
AR_TEAM_MEMBER = "rec7aHLK1Q8fMLRXH"
TASK_PREFIX = "RENT CHECK: DWP notice names "
TASK_SUFFIX = ", match it to a tenancy"
KEY_MARK = "DWP NOTICE KEY: "
SUMMARY_MAX = 300
DONE_KINDS = ("comment", "task")


class RecordError(Exception):
    """The notice could not be put on the record. Said loudly by the caller, never swallowed."""


# ─── who sent it ─────────────────────────────────────────────────────
UC_SENDER = "donotreply@universal-credit.service.gov.uk"
DWP_DOMAIN_RE = re.compile(r"^(?:[a-z0-9-]+\.)*dwp\.gov\.uk$")


def bare_email(sender):
    """The address alone, lower case: 'Name <a@b>' or 'a@b'."""
    s = str(sender or "").strip()
    if "<" in s:
        s = s[s.rfind("<") + 1:].split(">")[0]
    return s.strip().strip(".").lower()


def is_dwp_notice(sender):
    """True for the Universal Credit no-reply address and any address at dwp.gov.uk or one of its
    subdomains. The domain must END there: dwp.gov.uk.example.com is someone else."""
    addr = bare_email(sender)
    if addr.count("@") != 1:
        return False
    local, domain = addr.split("@")
    if not local:
        return False
    return addr == UC_SENDER or bool(DWP_DOMAIN_RE.fullmatch(domain))


# ─── what it says ────────────────────────────────────────────────────
TITLES = {"mr", "mrs", "ms", "miss", "mx", "dr", "master"}
# Words that end a name: "direct rent payments for Jo Bloggs at 12 Example Road".
NAME_STOP = {"at", "of", "from", "to", "on", "in", "with", "has", "have", "had", "is", "was", "are", "were",
             "and", "who", "whose", "for", "will", "would", "can", "starting", "start", "started", "from",
             "effective", "until", "please", "regarding", "re", "about", "by", "as", "or", "but", "if", "we",
             "you", "they", "this", "that", "these", "the", "a", "an", "your", "our", "their", "his", "her"}
# A line or value carrying any of these is not a tenant's name.
NOT_NAME = {"housing", "costs", "cost", "universal", "credit", "direct", "payment", "payments", "rent", "rents",
            "arrears", "tenancy", "tenant", "tenants", "claim", "claimant", "landlord", "landlords",
            "application", "apply", "form", "request", "deduction", "deductions", "third", "party", "decision",
            "decisions", "arrangement", "account", "property", "flat", "unit", "road", "street", "place",
            "close", "avenue", "lane", "managed", "apa", "underpayment", "overpayment", "reference",
            "department", "dwp", "work", "pensions", "service", "centre", "jobcentre", "team", "notice",
            "letter", "statement", "approved", "returned", "agreed", "not", "number", "your", "ref"}
# A "Dear" or "Re:" line to us, not about a tenant.
ADDRESSEE = {"kevin", "brittain", "agile", "lets", "estates", "roy", "lavin", "sir", "madam", "landlord",
             "customer", "colleague", "colleagues", "all", "info", "owner", "manager", "agent", "partner",
             "provider", "housing", "whom"}
NAME_WORD_RE = re.compile(r"[^\W\d_]+(?:['’\-][^\W\d_]+)*")
WORD_RE = re.compile(r"[^\W\d_]+(?:['’\-][^\W\d_]+)*")
PAYMENT_REF_RE = re.compile(r"payment\s+reference\s*(?:number\s*)?[:\-]\s*(?P<name>[^\n\r]{1,80})", re.I)
DIRECT_FOR_RE = re.compile(r"direct\s+(?:rent\s+)?payments?\s+for\s+(?P<name>[^\n\r]{1,80})", re.I)
# The service centre's own emails: "Regarding housing costs request for <name>. This has been referred to our
# decision makers." (the shape of the 16 Nov 2026 email in the finding), "Underpayment for <name>".
FOR_NAME_RE = re.compile(r"\b(?:request|application|claim|underpayment|overpayment|deductions?|arrears)\s+for\s+"
                         r"(?P<name>[^\n\r]{1,80})", re.I)
DEAR_RE = re.compile(r"^[ \t]*dear[ \t]+(?P<name>[^\n\r]{1,80})", re.I | re.M)
RE_LINE_RE = re.compile(r"^[ \t]*re[ \t]*:[ \t]*(?P<name>[^\n\r]{1,80})", re.I | re.M)
DECISION_RE = re.compile(
    r"\b(?:approved|referred\s+to\s+(?:a\s+|the\s+|our\s+)?decision[\s-]*makers?|started|stopped|"
    r"not\s+(?:been\s+)?agreed|refused|returned|suspended|ended|cancelled)\b", re.I)
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+|\n+")


def _fold(s):
    """Lower case with accents taken off, so 'Zoë' and 'ZOE' are one name."""
    s = unicodedata.normalize("NFKD", str(s or ""))
    return "".join(c for c in s if not unicodedata.combining(c)).lower().replace("’", "'")


def name_tokens(name):
    """The words of a person's name, folded, titles dropped: 'Mr J. Bloggs' -> ['j', 'bloggs']."""
    return [w for w in WORD_RE.findall(_fold(name)) if w not in TITLES]


def clean_name(raw, capitalised=False):
    """The person's name at the start of `raw`, or ''. Reads name words until the first word that is
    not one (a digit, punctuation, a joining word); refuses anything that reads as a subject, an
    address or us. `capitalised` (Dear / Re: lines) needs every name word to start with a capital."""
    words = []
    for chunk in str(raw or "").split():
        word = chunk.rstrip(",;:)]!?")
        ends = word != chunk
        if word.endswith("."):
            word = word[:-1]
            ends = ends or len(word) != 1          # "J." is an initial; "Bloggs." ends the sentence
        if not NAME_WORD_RE.fullmatch(word) or _fold(word) in NAME_STOP:
            break                                  # "AB123456C", "Sir/Madam", "at", "12"
        words.append(word)
        if ends:
            break
        if len(words) > 5:
            return ""
    while words and _fold(words[0]).rstrip(".") in TITLES:
        words = words[1:]
    if not words or len(words) > 4:
        return ""
    folded = [_fold(w) for w in words]
    if any(f in NOT_NAME or f in ADDRESSEE for f in folded):
        return ""
    if capitalised and not all(w[0].isupper() for w in words):
        return ""
    if len(words) == 1 and len(words[0]) < 2:
        return ""
    return " ".join(words)


def surname_last(tokens):
    """The name's words with the surname last: "BLOGGS J" -> ['j', 'bloggs'] (a trailing initial is never
    the surname)."""
    if len(tokens) > 1 and len(tokens[-1]) == 1:
        return [tokens[-1]] + tokens[:-1]
    return list(tokens)


def tenant_name(subject, body):
    """The tenant a notice names, or ''. Read in order: 'Payment reference: <name>', 'direct rent payments
    for <name>', '<request | application | claim | underpayment ...> for <Name>', then a 'Re:' or 'Dear'
    line in the body that is not addressed to us. The first one found wins, except that a fuller name
    with the same surname (the Universal Credit notice gives 'Payment reference: <surname>' and then
    'direct rent payments for <full name>') is taken over it, because a first name can break a tie."""
    text = "%s\n%s" % (subject or "", body or "")
    found = []
    for rx, src, capitalised in ((PAYMENT_REF_RE, text, False), (DIRECT_FOR_RE, text, False),
                                 (FOR_NAME_RE, text, True), (RE_LINE_RE, str(body or ""), True),
                                 (DEAR_RE, str(body or ""), True)):
        for m in rx.finditer(src):
            name = clean_name(m.group("name"), capitalised=capitalised)
            if name:
                found.append(name)
                break
    if not found:
        return ""
    first = surname_last(name_tokens(found[0]))
    for name in found[1:]:
        fuller = surname_last(name_tokens(name))
        if len(fuller) > len(first) and fuller[-1] == first[-1]:
            return name
    return found[0]


def _squash(s):
    return " ".join(str(s or "").split())


def summary(subject, body):
    """The subject, then the first sentence that says what was decided, at most SUMMARY_MAX characters."""
    subj = _squash(subject)
    sentence = ""
    for part in SENTENCE_SPLIT_RE.split(str(body or "")):
        part = _squash(part)
        if part and DECISION_RE.search(part):
            sentence = part
            break
    out = subj
    if sentence and _fold(sentence) not in _fold(subj):
        out = "%s: %s" % (subj, sentence) if subj else sentence
    if len(out) > SUMMARY_MAX:
        out = out[:SUMMARY_MAX - 3].rstrip() + "..."
    return out


def cache_entry(subject, body):
    """The "dwp" part of a scan cache entry: what record() needs, read while the full body exists."""
    return {"tenant": tenant_name(subject, body), "summary": summary(subject, body)}


# ─── Airtable, through the modules that already own it ───────────────
_mods = {}


def _load(name, filename):
    if name not in _mods:
        spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _mods[name] = mod
    return _mods[name]


def _rc():
    """scripts/rent-check.py, imported the way scripts/tenancy-record.py imports it."""
    return _load("rent_check_for_dwp_notice", "rent-check.py")


def fetch_all(table, params=None):
    """Every row, paginated (rent-check.py's fetch_all). Swapped out by the tests."""
    return _rc().fetch_all(table, params)


def post_comment(tenancy_id, text):
    """One comment on a tenancy: the endpoint scripts/tenancy-record.py's post_comment uses."""
    rc = _rc()
    return rc.api("POST", f"{rc.T_TENANCIES}/{tenancy_id}/comments", {"text": text})


def create_task(fields):
    """One task through scripts/create-agent-task.py's cmd_create, in process so a tenant's name never
    sits on a command line. Returns (exit code, the gate's JSON).

    force=True skips only the word fold, and on purpose: the fold keys "names <one surname>" and
    "names <another>" alike (both `rent check|dwp notice`), so it would put a second tenant's notice
    inside the first one's task. One task per Gmail message is kept by the ledger instead."""
    gate = _load("od_catask_for_dwp_notice", "create-agent-task.py")
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = gate.cmd_create(fields, force=True)
    out = {}
    for line in reversed(buf.getvalue().splitlines()):
        try:
            out = json.loads(line)
            break
        except ValueError:
            continue
    return code, out


# ─── the ledger ──────────────────────────────────────────────────────
def ledger_path():
    return os.environ.get("DWP_NOTICE_LEDGER") or os.path.expanduser(
        "~/knowledge-os/logs/dwp-notice/ledger.jsonl")


def ledger_done(msg_id):
    """The ledger row that already put this message on the record, or None. A ledger that exists and
    cannot be read raises: without it a second comment cannot be ruled out."""
    p = ledger_path()
    if not os.path.exists(p):
        return None
    try:
        with open(p) as fh:
            lines = fh.read().splitlines()
    except OSError as exc:
        raise RecordError("NOT CHECKED: the DWP notice ledger %s cannot be read (%s), so a second "
                          "comment cannot be ruled out; nothing was written" % (p, exc))
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and row.get("id") == msg_id and row.get("kind") in DONE_KINDS:
            return row
    return None


def ledger_append(row):
    p = ledger_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a") as fh:
        fh.write(json.dumps(dict(row, at=datetime.now(LONDON).isoformat(timespec="seconds"))) + "\n")


# ─── matching ────────────────────────────────────────────────────────
def _given_agrees(want_given, have_given):
    """A notice's given name against a tenant's: equal, or one is the other's initial."""
    if not want_given or not have_given:
        return False
    if len(want_given) == 1 or len(have_given) == 1:
        return want_given[0] == have_given[0]
    return want_given == have_given


def read_live(today):
    """(live tenancies, tenant names by id). Paginated reads; a read that comes back near empty is a
    broken read, never "nobody", so it raises."""
    rc = _rc()
    tenancies = fetch_all(rc.T_TENANCIES, {"fields[]": [rc.TY["end"], rc.TY["tenantStatus"], rc.TY["tenants"]]})
    tenants = fetch_all(rc.T_TENANTS, {"fields[]": [rc.TN["name"]]})
    floors = dict(rc.FLOORS)
    for label, rows in (("tenancies", tenancies), ("tenants", tenants)):
        if len(rows or []) < floors[label]:
            raise RecordError("NOT CHECKED: the %s read returned %d rows (expected %d+); the read is broken, "
                              "not the business empty, so no tenancy was matched"
                              % (label, len(rows or []), floors[label]))
    live = [t for t in tenancies if rc.is_live(t.get("fields") or {}, today)]
    if len(live) < rc.LIVE_FLOOR:
        raise RecordError("NOT CHECKED: only %d live tenancies were read (expected %d+), so no tenancy was "
                          "matched" % (len(live), rc.LIVE_FLOOR))
    names = {t["id"]: str((t.get("fields") or {}).get(rc.TN["name"]) or "") for t in tenants}
    return live, names


def match_tenancies(name, live, tenant_names):
    """(the one tenancy it is about or '', the candidates, why). Surname first; a given name on the
    notice must agree with the tenant's: it breaks a tie, and refuses a single match it contradicts.
    Only a single SURE match is ever returned as the tenancy; everything else is candidates."""
    rc = _rc()
    want = surname_last(name_tokens(name))
    if not want:
        return "", [], "no tenant name was read from the notice"
    surname, given = want[-1], (want[0] if len(want) > 1 else "")
    by_surname = {}
    for t in live:
        for tid in (t.get("fields") or {}).get(rc.TY["tenants"]) or []:
            have = name_tokens(tenant_names.get(tid, ""))
            if have and have[-1] == surname:
                by_surname.setdefault(t["id"], []).append(have)
    found = sorted(by_surname)
    if not found:
        return "", [], "no live tenancy has a tenant with the surname %s" % surname.title()
    if not given:
        if len(found) == 1:
            return found[0], found, "one live tenancy has a tenant with that surname"
        return "", found, ("%d live tenancies have a tenant with that surname, and the notice gives no first "
                           "name to tell them apart" % len(found))
    agreeing = sorted(tid for tid, names in by_surname.items()
                      if any(len(n) > 1 and _given_agrees(given, n[0]) for n in names))
    if len(agreeing) == 1:
        return agreeing[0], agreeing, "one live tenancy has a tenant with that full name"
    if agreeing:
        return "", agreeing, "%d live tenancies have a tenant with that full name" % len(agreeing)
    return "", found, ("%d live %s a tenant with that surname, but no tenant there has the first name on the "
                       "notice" % (len(found), "tenancy has" if len(found) == 1 else "tenancies have"))


# ─── what to do, and doing it ────────────────────────────────────────
def _stamp(now=None):
    return (now or datetime.now(LONDON)).strftime("%d %b %Y %H:%M")


def _received(ctx):
    try:
        return datetime.fromtimestamp(int(ctx.get("internalDate")) / 1000, LONDON).strftime("%d %b %Y")
    except (TypeError, ValueError):
        return "a date the scan did not record"


def comment_text(msg_id, ctx, now=None):
    """'<dd Mon yyyy HH:MM>: DWP to info@ (<sender>), <subject>: <summary>. Gmail <message id>.'"""
    subject = _squash(ctx.get("subject")) or "(no subject)"
    said = _squash((ctx.get("dwp") or {}).get("summary"))
    if _fold(said).startswith(_fold(subject)):
        said = said[len(subject):].lstrip(" :")
    body = "%s: %s" % (subject, said) if said else subject
    return "%s: DWP to info@ (%s), %s. Gmail %s." % (_stamp(now), bare_email(ctx.get("sender")) or "unknown sender",
                                                    body.rstrip(". "), msg_id)


def task_fields(msg_id, ctx, name, why, candidates, today):
    dwp = ctx.get("dwp") or {}
    sender = bare_email(ctx.get("sender")) or "unknown sender"
    lines = [
        "A DWP or Universal Credit notice reached info@ on %s from %s." % (_received(ctx), sender),
        "Subject: %s" % (_squash(ctx.get("subject")) or "(no subject)"),
        "What it says: %s" % (_squash(dwp.get("summary")) or "(nothing read)"),
        "Name read from it: %s." % (name or "none"),
        "Why this is a task and not a tenancy comment: %s." % why,
    ]
    if candidates:
        lines.append("Live tenancies it could be: %s." % ", ".join(candidates))
    lines += [
        "",
        "Find the tenancy this notice is about (the Gmail message below, the tenant records, the open rent "
        "tasks). Link this task to that tenancy, then put the fact on its record: "
        "python3 scripts/tenancy-record.py comment <tenancy> --task <this task> --text \"<what DWP said>\". "
        "If it is about nobody we let to, say so and close this task.",
        "Gmail message id: %s" % msg_id,
    ]
    return {
        "fldgFjGBw6bTKJFCD": TASK_PREFIX + (name or "no tenant") + TASK_SUFFIX,   # Task Name
        "fldx4qCw17UfrKpaN": "Today",                                             # Status
        "fld7XP8w8kbxfETV4": today.isoformat(),                                   # Due Date
        "flduCtmQGpOA4eWaj": [AR_TEAM_MEMBER],                                    # Team Member
        "fldRGhBQViKZKtkQ6": "\n".join(lines),                                    # Description
        "fldzf4xlbrQuktx0i": sender,                                              # Inbound Sender
        "fldR7apBzSp3oxFxz": KEY_MARK + msg_id + "\n[%s — dwp_notice] Raised in code from the triage scan "
                             "(finding 20261118-agent-dispatch-1353), through create-agent-task.py with its word "
                             "fold off: the fold reads two tenants' DWP notices as one matter. One task per Gmail "
                             "message, kept by the dwp-notice ledger." % _stamp(),   # Notes
    }


def plan(msg_id, ctx, today=None, now=None):
    """What record() would do, reading only. One of:
    {"do": "skip", "why"}, {"do": "already", "row"}, {"do": "comment", "tenancy", "text", "why"},
    {"do": "task", "fields", "why"}. Raises RecordError when a read it needs fails."""
    ctx = ctx or {}
    if not is_dwp_notice(ctx.get("sender")):
        return {"do": "skip", "why": "not from a DWP or Universal Credit address"}
    dwp = ctx.get("dwp")
    if not isinstance(dwp, dict):
        return {"do": "skip", "why": "no DWP reading in the scan cache for this message"}
    done = ledger_done(msg_id)
    if done:
        return {"do": "already", "row": done}
    today = today or datetime.now(LONDON).date()
    name = clean_name(dwp.get("tenant") or "")
    if not name:
        return {"do": "task", "why": "no tenant name was read from the notice",
                "fields": task_fields(msg_id, ctx, "", "no tenant name was read from the notice", [], today)}
    live, tenant_names = read_live(today)
    tenancy, candidates, why = match_tenancies(name, live, tenant_names)
    if tenancy:
        return {"do": "comment", "tenancy": tenancy, "text": comment_text(msg_id, ctx, now), "why": why}
    return {"do": "task", "why": why, "fields": task_fields(msg_id, ctx, name, why, candidates, today)}


def record(msg_id, ctx, today=None, now=None):
    """Put one DWP notice on the record: ONE comment on the one matching live tenancy, else ONE task.
    Returns what was done; raises RecordError when it could not be done."""
    p = plan(msg_id, ctx, today, now)
    if p["do"] in ("skip", "already"):
        return {"done": p["do"], "why": p.get("why", ""),
                **({"ledger": p["row"]} if p["do"] == "already" else {})}
    if p["do"] == "comment":
        try:
            got = post_comment(p["tenancy"], p["text"])
        except Exception as exc:  # noqa: BLE001 — said to the caller, who exits non-zero
            raise RecordError("the comment on tenancy %s failed: %s" % (p["tenancy"], str(exc)[:200]))
        row = {"id": msg_id, "kind": "comment", "tenancy": p["tenancy"], "comment": (got or {}).get("id", "")}
        try:
            ledger_append(row)
        except OSError as exc:
            raise RecordError("the comment WAS posted on tenancy %s but the ledger write failed (%s): do not "
                              "re-run this message without checking the tenancy's comments"
                              % (p["tenancy"], exc))
        return {"done": "commented", "tenancy": p["tenancy"], "why": p["why"]}
    try:
        code, out = create_task(p["fields"])
    except Exception as exc:  # noqa: BLE001 — said to the caller, who exits non-zero
        raise RecordError("the RENT CHECK task could not be raised: %s" % str(exc)[:200])
    task_id = str((out or {}).get("taskId") or "")
    if code in (0, 4) and task_id.startswith("rec"):
        row = {"id": msg_id, "kind": "task", "task": task_id, "why": p["why"]}
        try:
            ledger_append(row)
        except OSError as exc:
            raise RecordError("task %s WAS raised but the ledger write failed (%s): do not re-run this message "
                              "without checking the board" % (task_id, exc))
        if code == 4:
            raise RecordError("task %s was raised but some fields did not stick (%s)"
                              % (task_id, ", ".join((out or {}).get("fieldsNotWritten") or []) or "see the gate"))
        return {"done": "task", "task": task_id, "why": p["why"]}
    raise RecordError("the task gate did not raise the RENT CHECK task (exit %s: %s)"
                      % (code, _squash(json.dumps(out))[:200]))


# ─── back-fill ───────────────────────────────────────────────────────
def scan_cache_path():
    return Path(os.environ.get("INBOUND_TRIAGE_DIR") or (Path.home() / "knowledge-os/logs/inbound-triage")) \
        / "scan-cache.json"


def read_scan_cache():
    p = scan_cache_path()
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError) as exc:
        raise RecordError("NOT CHECKED: the triage scan cache %s cannot be read (%s)" % (p, exc))
    if not isinstance(data, dict):
        raise RecordError("NOT CHECKED: the triage scan cache %s is not a map of message ids" % p)
    return data


def reread_entry(msg_id):
    """The "dwp" part for a message scanned before this step existed, from its full body in Gmail
    (read-only, the triage worker's /gmail/get)."""
    triage = _load("od_triage_for_dwp_notice", "inbound-triage.py")
    triage._fail_quiet["on"] = True      # its fail() prints JSON to stdout, which is this command's
    got = triage.worker_post("/gmail/get", {"id": msg_id})
    subject = (got.get("headers") or {}).get("subject", "")
    unquote = _load("od_catask_for_dwp_notice", "create-agent-task.py").unquoted_body
    return cache_entry(subject, unquote(got.get("body") or ""))


def backfill(dry_run=True, reread=False, today=None):
    cache = read_scan_cache()
    rows = []
    for msg_id, ctx in sorted(cache.items(), key=lambda kv: (kv[1] or {}).get("internalDate") or 0):
        if not isinstance(ctx, dict) or not is_dwp_notice(ctx.get("sender")):
            continue
        row = {"id": msg_id, "sender": bare_email(ctx.get("sender")), "subject": ctx.get("subject", "")}
        if not isinstance(ctx.get("dwp"), dict):
            if not reread:
                rows.append(dict(row, do="not read", why="scanned before this step existed, so no body is cached; "
                                                          "add --reread to read it from Gmail"))
                continue
            try:
                ctx = dict(ctx, dwp=reread_entry(msg_id))
            except (Exception, SystemExit) as exc:  # noqa: BLE001 — the triage worker exits on a broken read
                rows.append(dict(row, do="error", why="NOT CHECKED: the body could not be read from Gmail (%s)"
                                 % str(exc)[:160]))
                continue
        try:
            if dry_run:
                p = plan(msg_id, ctx, today)
                rows.append(dict(row, do=p["do"], why=p.get("why", ""), tenancy=p.get("tenancy", ""),
                                 task=(p.get("fields") or {}).get("fldgFjGBw6bTKJFCD", "")))
            else:
                rows.append(dict(row, **record(msg_id, ctx, today)))
        except RecordError as exc:
            rows.append(dict(row, do="error", why=str(exc)))
    return {"dryRun": dry_run, "dwpMessages": len(rows), "rows": rows}


def main(argv):
    if not argv or argv[0] != "backfill":
        print(__doc__)
        return 1
    flags = set(argv[1:])
    unknown = flags - {"--dry-run", "--reread"}
    if unknown:
        print("unknown flag(s): %s" % " ".join(sorted(unknown)), file=sys.stderr)
        return 1
    try:
        out = backfill(dry_run="--dry-run" in flags, reread="--reread" in flags)
    except RecordError as exc:
        print(json.dumps({"error": str(exc)}))
        return 2
    print(json.dumps(out, indent=1))
    return 1 if any(r.get("do") == "error" for r in out["rows"]) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
