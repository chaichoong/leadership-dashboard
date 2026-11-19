#!/usr/bin/env python3
"""DWP and Universal Credit notices reach the tenancy record in code, not by an agent's judgement.

WHY THIS EXISTS (finding 20261118-agent-dispatch-1353)
Universal Credit and DWP mail to info@ was filed by the triage robot as "answered" or archived, and
the fact in it (a direct payment arrangement started, housing costs referred to a decision maker)
never reached the tenancy it was about. Whether it did depended on the agent's view of each message.
Now the scan reads the tenant and the decision off the FULL body (the one moment it exists) into the
scan cache, and every triage decision on that message (`note` and `act`, every action) calls
`record_from_triage`, which:

  * finds the ONE live tenancy whose linked tenant has that name (surname first, the given name to
    break a tie or to refuse a contradiction) and posts ONE dated comment on it, through the same
    comments endpoint scripts/tenancy-record.py uses; or
  * when no name was read, two people are named, a name could not be read cleanly, a former tenant
    shares the name, or no live tenancy or several match, raises ONE task for the Accounts
    Receivable agent through scripts/create-agent-task.py: "RENT CHECK: DWP notice names <name or
    no tenant>, match it to a tenancy". Never a guess.

ONE RECORD PER MESSAGE (review of 19 Nov 2026). The ledger is the fast answer; the source of truth is
the record itself: before a comment the tenancy's comments are read for "Gmail <message id>.", before
a task the board is read for "DWP NOTICE KEY: <message id>" (every task this raises carries that line),
and both are read again after a call that failed, because a call can fail after its write landed.

NOTHING FAILS QUIETLY. The message goes into the retry file BEFORE the attempt and leaves it only when
the record is made, so a failed or killed attempt stays queued. `retry` (and `backfill`) replays it.

USAGE
  dwp_notice.py retry [--dry-run]               replay every notice in the retry file
  dwp_notice.py clear <message id> --why "<what was fixed>"
                                                a task raised with fields that did not stick fails on
                                                every pass until a person fixes it and clears it here
  dwp_notice.py backfill --dry-run [--reread]   what a back-fill would do for every DWP message in the
                                                retry file and the triage scan cache (reads only)
  dwp_notice.py backfill [--reread]             do it (comments and tasks, ledgered)
    --reread reads the full body from Gmail (read-only) for a message scanned before this step
    existed, whose cache entry has no "dwp" part. Without it such a message is listed, not guessed.

Ledger: ~/knowledge-os/logs/dwp-notice/ledger.jsonl (DWP_NOTICE_LEDGER overrides it); retry file
retry.json beside it (DWP_NOTICE_RETRY overrides it); one lock file per message under locks/ beside it
(DWP_NOTICE_LOCKS overrides it). Private, never the repo: they name tenancies, tenants and Gmail messages.
"""
import contextlib
import fcntl
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
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
# Triage waits on this step, so it is kept short: no new write starts after TRIAGE_BUDGET seconds (the
# notice is queued for retry instead), each Airtable call gives up after AIRTABLE_TIMEOUT, and the task
# gate's track-record lookup after TRACK_RECORD_TIMEOUT (it is tried twice).
TRIAGE_BUDGET = 45
AIRTABLE_TIMEOUT = 20
TRACK_RECORD_TIMEOUT = 20
LOCK_WAIT = 15
MSG_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")


class RecordError(Exception):
    """The notice could not be put on the record. Said loudly by the caller, never swallowed."""


# ─── who sent it ─────────────────────────────────────────────────────
DWP_DOMAIN_RE = re.compile(r"^(?:[a-z0-9-]+\.)*(?:dwp\.gov\.uk|universal-credit\.service\.gov\.uk)$")


def bare_email(sender):
    """The address alone, lower case, from a raw From header: the LAST <...> when there is one, else the
    whole header ('Name <a@b>' or 'a@b'). A display name holding an address is never the address."""
    s = str(sender or "").strip()
    if "<" in s:
        s = s[s.rfind("<") + 1:].split(">")[0]
    return s.strip().strip(".").lower()


def is_dwp_notice(sender):
    """True for any address at dwp.gov.uk or universal-credit.service.gov.uk, or a subdomain of either.
    The domain must END there: dwp.gov.uk.example.com is someone else."""
    addr = bare_email(sender)
    if addr.count("@") != 1:
        return False
    local, domain = addr.split("@")
    return bool(local) and " " not in addr and bool(DWP_DOMAIN_RE.fullmatch(domain))


# ─── what it says ────────────────────────────────────────────────────
TITLES = {"mr", "mrs", "ms", "miss", "mx", "dr", "master"}
# Words that end a name: "direct rent payments for Jo Bloggs at 12 Example Road".
NAME_STOP = {"at", "of", "from", "to", "on", "in", "with", "has", "have", "had", "is", "was", "are", "were",
             "and", "who", "whose", "for", "will", "would", "can", "starting", "start", "started",
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
# A date is never a surname (review, 19 Nov 2026): "direct rent payments for March", "Payment reference: May".
MONTHS_DAYS = {"january", "february", "march", "april", "may", "june", "july", "august", "september",
               "october", "november", "december", "monday", "tuesday", "wednesday", "thursday", "friday",
               "saturday", "sunday"}
# A "Dear" or "Re:" line to us, not about a tenant.
ADDRESSEE = {"kevin", "brittain", "agile", "lets", "estates", "roy", "lavin", "sir", "madam", "landlord",
             "customer", "colleague", "colleagues", "all", "info", "owner", "manager", "agent", "partner",
             "provider", "housing", "whom", "officer", "letting", "lettings", "director", "company", "ltd",
             "limited"}
# Words that never make a run of capitals look like a person: "The Property", "Housing Costs", "December".
NOT_A_PERSON = NOT_NAME | NAME_STOP | MONTHS_DAYS | TITLES
NAME_WORD_RE = re.compile(r"[^\W\d_]+(?:['’\-][^\W\d_]+)*")
JOINS = ("and", "&")
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
    """The words of a person's name, folded, titles and joins dropped: 'Mr J. Bloggs' -> ['j', 'bloggs']."""
    return [w for w in NAME_WORD_RE.findall(_fold(name)) if w not in TITLES and w not in JOINS]


def surname_last(tokens):
    """The name's words with the surname last: "BLOGGS J" -> ['j', 'bloggs'] (a trailing initial is never
    the surname)."""
    if len(tokens) > 1 and len(tokens[-1]) == 1:
        return [tokens[-1]] + tokens[:-1]
    return list(tokens)


def _chunk_word(chunk):
    """(the word in a whitespace chunk, whether it ends the name). 'J.' is an initial; 'Bloggs.' ends."""
    word = chunk.rstrip(",;:)]!?")
    ends = word != chunk
    if word.endswith("."):
        word = word[:-1]
        ends = ends or len(word) != 1
    return word, ends


def clean_name(raw, capitalised=False):
    """The person's name at the start of `raw`, or ''. Reads name words until the first word that is
    not one (a digit, punctuation, a joining word); refuses anything that reads as a subject, an
    address, a date or us. `capitalised` (Dear / Re: lines) needs every name word to start with a capital."""
    words = []
    for chunk in str(raw or "").split():
        word, ends = _chunk_word(chunk)
        if not NAME_WORD_RE.fullmatch(word) or _fold(word) in NAME_STOP:
            break                                  # "AB123456C", "Sir/Madam", "at", "12"
        words.append(word)
        if ends:
            break
        if len(words) > 5:
            return ""
    while words and _fold(words[0]) in TITLES:
        words = words[1:]
    if not words or len(words) > 4:
        return ""
    folded = [_fold(w) for w in words]
    if any(f in NOT_NAME or f in ADDRESSEE for f in folded):
        return ""
    if surname_last(folded)[-1] in MONTHS_DAYS:
        return ""
    if capitalised and not all(w[0].isupper() for w in words):
        return ""
    if len(words) == 1 and len(words[0]) < 2:
        return ""
    return " ".join(words)


def _capital_word(chunk):
    word, _ = _chunk_word(chunk)
    return bool(NAME_WORD_RE.fullmatch(word)) and word[0].isupper()


def name_run(raw):
    """The run of capitalised words at the start of `raw`, as a reader would see a name: 'Will Alder',
    'Jo Alder and Sam Birch'. A capitalised joining word counts only first ('Will Alder'); 'and' or '&'
    between two capitalised words joins them. Compared with clean_name to catch a name it dropped."""
    chunks, words, i = str(raw or "").split(), [], 0
    while i < len(chunks) and len(words) < 8:
        chunk = chunks[i]
        nxt = chunks[i + 1] if i + 1 < len(chunks) else ""
        if chunk.lower() in JOINS and words and _capital_word(nxt):
            words.append(chunk.lower())
            i += 1
            continue
        word, ends = _chunk_word(chunk)
        if not (NAME_WORD_RE.fullmatch(word) and word[0].isupper()):
            break
        if _fold(word) in NAME_STOP and (words or not _capital_word(nxt)):
            break                                  # "Jo Alder From 1 May"; a lone "The"
        words.append(word)
        i += 1
        if ends:
            break
    return words


def _person_like(run):
    return any(_fold(w) not in NOT_A_PERSON and w not in JOINS for w in run)


def read_names(subject, body):
    """{"tenant", "names", "unsure"}: the one tenant the notice names, every name it carries, and why
    the robot cannot be sure (then "tenant" is ''). Read from 'Payment reference: <name>', 'direct rent
    payments for <name>', '<request | application | claim | underpayment ...> for <Name>', and 'Re:' or
    'Dear' lines in the body not addressed to us; EVERY match, not the first. Unsure when two different
    people are named, or a name-like run of capitals could not be read cleanly ('Will Alder', 'Jo March',
    'Jo Alder and Sam Birch'): the reader never falls back to part of a name. Otherwise the fullest name
    wins, so a first name on one line can break a tie the surname on another cannot."""
    text = "%s\n%s" % (subject or "", body or "")
    names, dropped = [], []
    for rx, src, capitalised, may_be_us in ((PAYMENT_REF_RE, text, False, False), (DIRECT_FOR_RE, text, False, False),
                                            (FOR_NAME_RE, text, True, False), (RE_LINE_RE, str(body or ""), True, True),
                                            (DEAR_RE, str(body or ""), True, True)):
        for m in rx.finditer(src):
            raw = m.group("name")
            run = name_run(raw)
            if may_be_us and any(_fold(w) in ADDRESSEE for w in run):
                people = [w for w in run if _fold(w) not in NOT_A_PERSON and w not in JOINS]
                if all(_fold(w) in ADDRESSEE for w in people):
                    continue                       # "Dear Kevin Brittain", "Dear Roy", "Dear Agile Lets Team"
                dropped.append(" ".join(run))      # "Re: Roy Alder": a name beside one of ours, unkeepable
                continue
            name = clean_name(raw, capitalised=capitalised)
            seen = name_tokens(" ".join(run))
            if _person_like(run) and (not name or seen != name_tokens(name)):
                dropped.append(" ".join(run))
            if name and name_tokens(name) not in [name_tokens(n) for n in names]:
                names.append(name)
    dropped = list(dict.fromkeys(dropped))
    out = {"tenant": "", "names": names + [d for d in dropped if d not in names], "unsure": ""}
    if dropped:
        out["unsure"] = ("the notice names %s, which the robot could not read as one tenant's name"
                         % " and ".join('"%s"' % d for d in dropped))
        return out
    if not names:
        return out
    people = [surname_last(name_tokens(n)) for n in names]
    if len({p[-1] for p in people}) > 1 or any(
            len(a) > 1 and len(b) > 1 and not _given_agrees(a[0], b[0]) for a in people for b in people):
        out["unsure"] = "the notice names more than one person (%s)" % ", ".join(names)
        return out
    out["tenant"] = max(names, key=lambda n: (len(name_tokens(n)), len(n)))
    return out


def tenant_name(subject, body):
    """The one tenant a notice names, or '' (none, or not sure which: see read_names)."""
    return read_names(subject, body)["tenant"]


def _squash(s):
    return " ".join(str(s or "").split())


CONDITIONAL_RE = re.compile(r"^[\W_]*if\b", re.I)


def decision_sentence(body):
    """The first sentence of the body that says what was decided, or ''. A sentence that begins "If" is
    boilerplate, never a decision ("If your payment has been suspended please call us.")."""
    for part in SENTENCE_SPLIT_RE.split(str(body or "")):
        part = _squash(part)
        if part and not CONDITIONAL_RE.match(part) and DECISION_RE.search(part):
            return part
    return ""


def auto_reply_skips(reason, decided, named=False):
    """True for a message the scan flagged as an automatic reply with no decision sentence in it. A decision is
    never skipped: "Thank you for contacting Universal Credit." can open a real decision (review rounds 2-3).
    A message flagged only by a receipt phrase in its body is skipped only when it also names nobody (review
    round 4: "We have received your request for <tenant>. Rent will now be paid to you directly..." states a
    fact in words the decision list does not hold). The Auto-Submitted header and an auto-reply subject skip
    whenever nothing is decided."""
    if not reason or decided:
        return False
    if str(reason).strip().lower().startswith("body") and named:
        return False
    return True


def summary(subject, body):
    """The subject, then the first sentence that says what was decided, at most SUMMARY_MAX characters."""
    subj = _squash(subject)
    sentence = decision_sentence(body)
    out = subj
    if sentence and _fold(sentence) not in _fold(subj):
        out = "%s: %s" % (subj, sentence) if subj else sentence
    if len(out) > SUMMARY_MAX:
        out = out[:SUMMARY_MAX - 3].rstrip() + "..."
    return out


def cache_entry(subject, body, sender=""):
    """The "dwp" part of a scan cache entry: what record() needs, read while the full body exists.
    `sender` is the raw From header; its address (bare_email) is kept as "from"."""
    reading = read_names(subject, body)
    entry = {"tenant": reading["tenant"], "summary": summary(subject, body), "decided": bool(decision_sentence(body))}
    if sender:
        entry["from"] = bare_email(sender)
    if reading["unsure"]:
        entry["unsure"] = reading["unsure"]
        entry["names"] = reading["names"]
    return entry


# ─── Airtable ────────────────────────────────────────────────────────
_mods = {}


def _load(name, filename):
    if name not in _mods:
        spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _mods[name] = mod
    return _mods[name]


def _rc():
    """scripts/rent-check.py, imported the way scripts/tenancy-record.py imports it: its table and field
    ids, is_live, the floors, the base and the token file."""
    return _load("rent_check_for_dwp_notice", "rent-check.py")


def _api(method, path, payload=None, params=None):
    """One Airtable call, the way rent-check.py's api makes it, with a short timeout because triage waits.
    A timeout is never retried. A 429 is retried once (Airtable refused it, nothing was written). A 5xx
    is retried once only for a GET: a POST answered 5xx may have landed, so it is never sent again here;
    the caller reads the record back instead (review round 2, 19 Nov 2026)."""
    rc = _rc()
    url = "https://api.airtable.com/v0/%s/%s" % (rc.BASE, path)
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    data = json.dumps(payload).encode() if payload is not None else None
    for attempt in (1, 2):
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "Bearer %s" % rc._pat(), "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=AIRTABLE_TIMEOUT) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if attempt == 1 and (e.code == 429 or (e.code >= 500 and method == "GET")):
                time.sleep(2)
                continue
            # Never echo headers: they carry the token.
            raise RuntimeError("Airtable %s %s %s: %s" % (method, path.split("?")[0], e.code, e.read().decode()[:300]))


def _get_all(table, params):
    """Every row, paginated like rent-check.py's fetch_all, and a reply with no `records` list is an error,
    never zero rows (CLAUDE.md, finding 20261104-phase-2-1187)."""
    out, offset = [], None
    while True:
        p = dict(params or {}, returnFieldsByFieldId="true", pageSize=100)
        if offset:
            p["offset"] = offset
        d = _api("GET", table, params=p)
        if not isinstance((d or {}).get("records"), list):
            raise RecordError("NOT CHECKED: the %s read came back with no records list" % table)
        out += d["records"]
        offset = d.get("offset")
        if not offset:
            return out


def fetch_all(table, params=None):
    """Every row of a table (the tenancy and tenant reads). Swapped out by the tests."""
    return _get_all(table, params)


def tenancy_comments(tenancy_id):
    """Every comment's text on a tenancy, paginated; a reply with no `comments` list is an error."""
    rc = _rc()
    texts, offset = [], None
    while True:
        params = {"pageSize": 100}
        if offset:
            params["offset"] = offset
        d = _api("GET", "%s/%s/comments" % (rc.T_TENANCIES, tenancy_id), params=params)
        if not isinstance((d or {}).get("comments"), list):
            raise RecordError("NOT CHECKED: the comments on tenancy %s came back with no comments list" % tenancy_id)
        texts += [str(c.get("text") or "") for c in d["comments"]]
        offset = d.get("offset")
        if not offset:
            return texts


def comment_posted(tenancy_id, msg_id):
    """True when the tenancy already carries this message's comment ('... Gmail <message id>.')."""
    mark = re.compile(r"\bGmail %s\.(?!\w)" % re.escape(msg_id))
    return any(mark.search(t) for t in tenancy_comments(tenancy_id))


def post_comment(tenancy_id, text):
    """One comment on a tenancy: the endpoint scripts/tenancy-record.py's post_comment uses."""
    return _api("POST", "%s/%s/comments" % (_rc().T_TENANCIES, tenancy_id), {"text": text})


def keyed_tasks(msg_id):
    """The ids of every task, any status, whose Notes carry this message's DWP NOTICE KEY line."""
    if not MSG_ID_RE.fullmatch(msg_id or ""):
        raise RecordError("%r is not a Gmail message id, so the board cannot be searched for it" % msg_id)
    rc = _rc()
    rows = _get_all(rc.T_TASKS, {"filterByFormula": "FIND('%s%s', {Notes}&'')" % (KEY_MARK, msg_id),
                                 "fields[]": [rc.TK["notes"]]})
    mark = re.compile(r"%s%s(?![\w-])" % (re.escape(KEY_MARK), re.escape(msg_id)))
    return [r["id"] for r in rows if mark.search(str((r.get("fields") or {}).get(rc.TK["notes"]) or ""))]


def create_task(fields):
    """One task through scripts/create-agent-task.py's cmd_create, in process so a tenant's name never
    sits on a command line. Returns (exit code, the gate's JSON).

    force=True skips only the word fold, and on purpose: the fold keys "names <one surname>" and
    "names <another>" alike (both `rent check|dwp notice`), so it would put a second tenant's notice
    inside the first one's task. One task per Gmail message is kept by the DWP NOTICE KEY line instead.
    The gate's track-record lookup is given TRACK_RECORD_TIMEOUT a try, not two minutes, because triage
    waits on it; a slow one says "not built" on the task and the agent can run it again."""
    gate = _load("od_catask_for_dwp_notice", "create-agent-task.py")
    if hasattr(gate, "track_record_for") and not getattr(gate, "_dwp_bounded", False):
        build = gate.track_record_for

        def bounded(fields, task_id=None, runner=None):
            return build(fields, task_id, runner=runner or (lambda c: subprocess.run(
                c, capture_output=True, text=True, timeout=TRACK_RECORD_TIMEOUT)))
        gate.track_record_for, gate._dwp_bounded = bounded, True
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


# ─── the ledger and the retry file ───────────────────────────────────
def ledger_path():
    return os.environ.get("DWP_NOTICE_LEDGER") or os.path.expanduser(
        "~/knowledge-os/logs/dwp-notice/ledger.jsonl")


def retry_path():
    return os.environ.get("DWP_NOTICE_RETRY") or os.path.join(os.path.dirname(ledger_path()), "retry.json")


def ledger_rows(msg_id):
    """Every ledger row for this message, oldest first. A ledger that exists and cannot be read raises
    RecordError (NOT CHECKED) and nothing is written: the attempt fails and waits in the retry file until
    the ledger can be read again."""
    p = ledger_path()
    if not os.path.exists(p):
        return []
    try:
        with open(p) as fh:
            lines = fh.read().splitlines()
    except OSError as exc:
        raise RecordError("NOT CHECKED: the DWP notice ledger %s cannot be read (%s)" % (p, exc))
    rows = []
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and row.get("id") == msg_id:
            rows.append(row)
    return rows


def ledger_done(msg_id):
    """The ledger row that already put this message on the record, or None. A task row that lists
    fields that did not stick carries "clearedWhy" once a person has cleared it (`clear`)."""
    rows = ledger_rows(msg_id)
    done = next((r for r in rows if r.get("kind") in DONE_KINDS), None)
    if done and done.get("fieldsNotWritten"):
        cleared = [r for r in rows if r.get("kind") == "cleared"]
        if cleared:
            done = dict(done, clearedWhy=cleared[-1].get("why", ""))
    return done


def ledger_append(row):
    p = ledger_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a") as fh:
        fh.write(json.dumps(dict(row, at=datetime.now(LONDON).isoformat(timespec="seconds"))) + "\n")


def _ledger_quietly(row, out):
    """Ledger the record; a ledger that cannot be written is said in the result, and costs nothing more:
    the next attempt finds the comment or the task itself."""
    try:
        ledger_append(row)
    except OSError as exc:
        out["ledgerProblem"] = "the ledger line could not be written (%s); the record itself is in place" % exc
    return out


@contextlib.contextmanager
def _retry_locked():
    """The retry file read and rewritten under an exclusive lock: triage and a retry run may overlap."""
    p = retry_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            data = {}
            if os.path.exists(p):
                try:
                    with open(p) as fh:
                        data = json.load(fh)
                except (OSError, ValueError) as exc:
                    raise RecordError("NOT CHECKED: the DWP notice retry file %s cannot be read (%s)" % (p, exc))
                if not isinstance(data, dict):
                    raise RecordError("NOT CHECKED: the DWP notice retry file %s is not a map of message ids" % p)
            box = {"data": data, "dirty": False}
            yield box
            if box["dirty"]:
                fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p), prefix=".retry-")
                with os.fdopen(fd, "w") as fh:
                    json.dump(box["data"], fh)
                os.replace(tmp, p)      # atomic: a reader never sees a half-written file
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def read_retry():
    with _retry_locked() as box:
        return dict(box["data"])


def queue_retry(msg_id, ctx, error):
    """Put (or keep) a message in the retry file, with what went wrong."""
    now = datetime.now(LONDON).isoformat(timespec="seconds")
    with _retry_locked() as box:
        entry = box["data"].get(msg_id) or {"ctx": ctx, "first": now, "attempts": 0}
        entry.update(ctx=ctx or entry.get("ctx"), error=error, last=now, attempts=int(entry.get("attempts") or 0) + 1)
        box["data"][msg_id] = entry
        box["dirty"] = True


def clear_retry(msg_id):
    with _retry_locked() as box:
        if msg_id in box["data"]:
            del box["data"][msg_id]
            box["dirty"] = True


# ─── matching ────────────────────────────────────────────────────────
def _given_agrees(want_given, have_given):
    """A notice's given name against a tenant's: equal, or one is the other's initial."""
    if not want_given or not have_given:
        return False
    if len(want_given) == 1 or len(have_given) == 1:
        return want_given[0] == have_given[0]
    return want_given == have_given


def read_tenancies(today):
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
    A tenant on no live tenancy (a former tenant, an ended tenancy) who fits the notice as well as the
    live one does makes it unsure: the notice may be about them. Only a single SURE match is returned."""
    rc = _rc()
    want = surname_last(name_tokens(name))
    if not want:
        return "", [], "no tenant name was read from the notice"
    surname, given = want[-1], (want[0] if len(want) > 1 else "")

    def fits(have):
        if not have or have[-1] != surname:
            return False
        return not given or (len(have) > 1 and _given_agrees(given, have[0]))

    on_live, by_surname = set(), {}
    for t in live:
        for tid in (t.get("fields") or {}).get(rc.TY["tenants"]) or []:
            on_live.add(tid)
            have = name_tokens(tenant_names.get(tid, ""))
            if have and have[-1] == surname:
                by_surname.setdefault(t["id"], []).append(have)
    found = sorted(by_surname)
    if not found:
        return "", [], "no live tenancy has a tenant with the surname %s" % surname.title()
    agreeing = sorted(tid for tid, names in by_surname.items() if any(fits(n) for n in names))
    if not agreeing:
        return "", found, ("%d live %s a tenant with that surname, but no tenant there has the first name on the "
                           "notice" % (len(found), "tenancy has" if len(found) == 1 else "tenancies have"))
    if len(agreeing) > 1:
        return "", agreeing, ("%d live tenancies have a tenant with that %s%s"
                              % (len(agreeing), "full name" if given else "surname",
                                 "" if given else ", and the notice gives no first name to tell them apart"))
    former = sorted(tid for tid, n in tenant_names.items() if tid not in on_live and fits(name_tokens(n)))
    if former:
        return "", agreeing, ("one live tenancy has a tenant with that %s, but %d tenant%s on no live tenancy (a "
                              "former tenant) %s it too, and the notice may be about them"
                              % ("full name" if given else "surname", len(former), "" if len(former) == 1 else "s",
                                 "fits" if len(former) == 1 else "fit"))
    return agreeing[0], agreeing, "one live tenancy has a tenant with that %s" % ("full name" if given else "surname")


# ─── what to do, and doing it ────────────────────────────────────────
def _stamp(now=None):
    return (now or datetime.now(LONDON)).strftime("%d %b %Y %H:%M")


def _received(ctx):
    try:
        return datetime.fromtimestamp(int(ctx.get("internalDate")) / 1000, LONDON).strftime("%d %b %Y")
    except (TypeError, ValueError):
        return "a date the scan did not record"


def _sender(ctx):
    """The sender's real address: the scan's own read of the raw From header when it has one."""
    return bare_email(((ctx or {}).get("dwp") or {}).get("from") or (ctx or {}).get("sender"))


def comment_text(msg_id, ctx, now=None):
    """'<dd Mon yyyy HH:MM>: DWP to info@ (<sender>), <subject>: <summary>. Gmail <message id>.'"""
    subject = _squash(ctx.get("subject")) or "(no subject)"
    said = _squash((ctx.get("dwp") or {}).get("summary"))
    if _fold(said).startswith(_fold(subject)):
        said = said[len(subject):].lstrip(" :")
    body = "%s: %s" % (subject, said) if said else subject
    return "%s: DWP to info@ (%s), %s. Gmail %s." % (_stamp(now), _sender(ctx) or "unknown sender",
                                                    body.rstrip(". "), msg_id)


def task_fields(msg_id, ctx, name, why, candidates, today):
    dwp = ctx.get("dwp") or {}
    sender = _sender(ctx) or "unknown sender"
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
                             "message, kept by the DWP NOTICE KEY line above." % _stamp(),   # Notes
    }


def plan(msg_id, ctx, today=None, now=None):
    """What record() would do, reading only. One of:
    {"do": "skip", "why"}, {"do": "already", "row"}, {"do": "comment", "tenancy", "text", "why"},
    {"do": "task", "fields", "why"}. Raises RecordError when a read it needs fails."""
    ctx = ctx or {}
    dwp = ctx.get("dwp")
    if not is_dwp_notice(_sender(ctx)) or not is_dwp_notice(ctx.get("sender")):
        return {"do": "skip", "why": "not from a DWP or Universal Credit address"}
    if auto_reply_skips(ctx.get("auto_reply"), (dwp or {}).get("decided") if isinstance(dwp, dict) else False,
                        named=bool(isinstance(dwp, dict) and (dwp.get("tenant") or dwp.get("names")))):
        return {"do": "skip", "why": "an automatic reply with nothing decided in it (%s)" % ctx.get("auto_reply")}
    if not isinstance(dwp, dict):
        return {"do": "skip", "why": "no DWP reading in the scan cache for this message"}
    done = ledger_done(msg_id)
    if done and done.get("fieldsNotWritten") and not done.get("clearedWhy"):
        return {"do": "incomplete", "row": done,
                "why": ("task %s was raised but some fields did not stick (%s): fix them on the task, then run "
                        "`python3 scripts/dwp_notice.py clear %s --why \"<what was fixed>\"`"
                        % (done.get("task"), done.get("fieldsNotWritten"), msg_id))}
    if done:
        return {"do": "already", "row": done}
    today = today or datetime.now(LONDON).date()
    if dwp.get("unsure"):
        label = " or ".join(dwp.get("names") or []) or "no tenant"
        return {"do": "task", "why": dwp["unsure"], "fields": task_fields(msg_id, ctx, label, dwp["unsure"], [], today)}
    name = clean_name(dwp.get("tenant") or "")
    if not name:
        return {"do": "task", "why": "no tenant name was read from the notice",
                "fields": task_fields(msg_id, ctx, "", "no tenant name was read from the notice", [], today)}
    live, tenant_names = read_tenancies(today)
    tenancy, candidates, why = match_tenancies(name, live, tenant_names)
    if tenancy:
        return {"do": "comment", "tenancy": tenancy, "text": comment_text(msg_id, ctx, now), "why": why}
    return {"do": "task", "why": why, "fields": task_fields(msg_id, ctx, name, why, candidates, today)}


def _in_time(deadline, before):
    if deadline is not None and time.monotonic() > deadline:
        raise RecordError("out of time before %s (triage waits on this step, so it stops at %ds)"
                          % (before, TRIAGE_BUDGET))


def _found_after(check, what):
    """Read the record again after a failed call: (what the read found, '') or (None, why it could not)."""
    try:
        return check(), ""
    except Exception as exc:  # noqa: BLE001 — named in the error the caller raises
        return None, "; reading the %s again to see whether it landed also failed (%s)" % (what, str(exc)[:160])


def locks_dir():
    return os.environ.get("DWP_NOTICE_LOCKS") or os.path.join(os.path.dirname(ledger_path()), "locks")


@contextlib.contextmanager
def message_lock(msg_id):
    """One run at a time per message (review round 2): triage and a scheduled `retry` may meet on the same
    message, and both could read "not on the record" before either wrote. Waits up to LOCK_WAIT seconds,
    then fails: the other run is making the record, and this one stays queued for retry."""
    if not MSG_ID_RE.fullmatch(msg_id or ""):
        raise RecordError("%r is not a Gmail message id" % msg_id)
    try:
        os.makedirs(locks_dir(), exist_ok=True)
        fh = open(os.path.join(locks_dir(), msg_id + ".lock"), "a")
    except OSError as exc:
        raise RecordError("NOT CHECKED: the lock for message %s could not be taken (%s), so nothing was written"
                          % (msg_id, exc))
    with fh:
        waited = 0.0
        while True:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if waited >= LOCK_WAIT:
                    raise RecordError("another run is recording message %s right now (waited %ds), so this one "
                                      "wrote nothing" % (msg_id, LOCK_WAIT))
                time.sleep(0.5)
                waited += 0.5
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def record(msg_id, ctx, today=None, now=None, budget=None):
    """Put one DWP notice on the record: ONE comment on the one matching live tenancy, else ONE task.
    Returns what was done; raises RecordError when it could not be done. Never twice: one run per message
    at a time (message_lock), and the record itself is read before each write and after one that failed."""
    deadline = time.monotonic() + budget if budget else None
    with message_lock(msg_id):
        return _record(msg_id, ctx, today, now, deadline)


def _record(msg_id, ctx, today, now, deadline):
    p = plan(msg_id, ctx, today, now)
    if p["do"] == "incomplete":
        # Still a failure on every pass (review round 3): the warning is never worn away by a replay or a
        # second triage decision; only `clear`, after a person fixed the task, ends it.
        raise RecordError(p["why"])
    if p["do"] in ("skip", "already"):
        return {"done": p["do"], "why": p.get("why", ""),
                **({"ledger": p["row"]} if p["do"] == "already" else {})}
    if p["do"] == "comment":
        tenancy = p["tenancy"]
        row = {"id": msg_id, "kind": "comment", "tenancy": tenancy}
        _in_time(deadline, "reading the tenancy's comments")
        if comment_posted(tenancy, msg_id):
            return _ledger_quietly(dict(row, found=True), {"done": "commented", "tenancy": tenancy, "why": p["why"],
                                                           "note": "the comment was already on the tenancy"})
        _in_time(deadline, "posting the comment")
        try:
            got = post_comment(tenancy, p["text"])
        except Exception as exc:  # noqa: BLE001 — read back, then said to the caller
            landed, extra = _found_after(lambda: comment_posted(tenancy, msg_id), "tenancy's comments")
            if landed:
                return _ledger_quietly(dict(row, found=True), {"done": "commented", "tenancy": tenancy, "why": p["why"],
                                                               "note": "the post reported an error but it landed"})
            raise RecordError("the comment on tenancy %s failed: %s%s" % (tenancy, str(exc)[:200], extra))
        return _ledger_quietly(dict(row, comment=(got or {}).get("id", "")),
                               {"done": "commented", "tenancy": tenancy, "why": p["why"]})
    _in_time(deadline, "searching the board for this message's task")
    existing = keyed_tasks(msg_id)
    if existing:
        return _ledger_quietly({"id": msg_id, "kind": "task", "task": existing[0], "found": True},
                               {"done": "task", "task": existing[0], "why": p["why"],
                                "note": "a task carrying this message's key was already on the board"})
    _in_time(deadline, "raising the task")
    problem = ""
    try:
        code, out = create_task(p["fields"])
    except Exception as exc:  # noqa: BLE001 — read back, then said to the caller
        code, out, problem = None, {}, str(exc)[:200]
    task_id = str((out or {}).get("taskId") or "")
    if not task_id.startswith("rec"):
        found, extra = _found_after(lambda: keyed_tasks(msg_id), "board")
        if found:
            return _ledger_quietly({"id": msg_id, "kind": "task", "task": found[0], "found": True},
                                   {"done": "task", "task": found[0], "why": p["why"],
                                    "note": "the gate reported an error but the task landed"})
        raise RecordError("the task gate did not raise the RENT CHECK task (%s)%s"
                          % (problem or "exit %s: %s" % (code, _squash(json.dumps(out))[:200]), extra))
    missing = ", ".join((out or {}).get("fieldsNotWritten") or []) or "the gate did not say which"
    row = {"id": msg_id, "kind": "task", "task": task_id, "why": p["why"]}
    if code == 4:
        row["fieldsNotWritten"] = missing
    result = _ledger_quietly(row, {"done": "task", "task": task_id, "why": p["why"]})
    if code == 4:
        # Created, but incomplete (exit 4): a failure, said and queued like any other (review round 2). The
        # ledger line is written first, so no replay ever raises a second task; it lists the missing fields.
        raise RecordError("task %s was raised but some fields did not stick (%s): fix them on the task, then run "
                          "`python3 scripts/dwp_notice.py clear %s --why \"<what was fixed>\"`"
                          % (task_id, missing, msg_id))
    return result


def clear(msg_id, why):
    """A person fixed the fields that did not stick on a message's task: say so in the ledger, with what was
    fixed, and take the message out of the retry file. Refused for a message with nothing to clear."""
    why = _squash(why)
    if len(why) < 10:
        raise RecordError("clear needs --why \"<what was fixed on the task>\", in a sentence")
    with message_lock(msg_id):
        done = ledger_done(msg_id)
        if not done or not done.get("fieldsNotWritten"):
            raise RecordError("message %s has no task with fields that did not stick, so there is nothing to clear"
                              % msg_id)
        if done.get("clearedWhy"):
            return {"cleared": msg_id, "task": done.get("task"), "already": done["clearedWhy"]}
        try:
            ledger_append({"id": msg_id, "kind": "cleared", "task": done.get("task"), "why": why})
        except OSError as exc:
            raise RecordError("the ledger could not be written (%s), so nothing was cleared" % exc)
        clear_retry(msg_id)
    return {"cleared": msg_id, "task": done.get("task"), "fields": done.get("fieldsNotWritten"), "why": why}


def record_from_triage(msg_id, ctx, today=None, now=None):
    """What every triage act and note calls. The message goes in the retry file FIRST, so an attempt that
    fails, times out or is killed leaves it queued; it comes out only once the record is made."""
    queued_problem = ""
    try:
        queue_retry(msg_id, ctx, "attempt started from triage")
    except Exception as exc:  # noqa: BLE001 — said with the result or the error
        queued_problem = "the retry file could not be written (%s)" % str(exc)[:160]
    try:
        out = record(msg_id, ctx, today, now, budget=TRIAGE_BUDGET)
    except Exception as exc:  # noqa: BLE001 — said to the caller, who exits non-zero
        why = str(exc) or exc.__class__.__name__
        try:
            queue_retry(msg_id, ctx, why[:400])
        except Exception as qexc:  # noqa: BLE001
            queued_problem = queued_problem or "the retry file could not be written (%s)" % str(qexc)[:160]
        if queued_problem:
            raise RecordError("%s; and %s, so it is NOT queued: run `python3 scripts/dwp_notice.py backfill` once "
                              "the cause is fixed" % (why, queued_problem))
        raise RecordError("%s. Queued for `python3 scripts/dwp_notice.py retry`." % why)
    try:
        clear_retry(msg_id)
    except Exception as exc:  # noqa: BLE001
        out["retryProblem"] = ("the record is made but it could not be taken out of the retry file (%s); a retry "
                               "will find it on the record and do nothing" % str(exc)[:160])
    if queued_problem and "retryProblem" not in out:
        out["retryProblem"] = queued_problem
    return out


# ─── retry and back-fill ─────────────────────────────────────────────
def _replay(msg_id, ctx, dry_run, today):
    """One message, planned (dry run) or recorded; a recorded one leaves the retry file, a failed one stays."""
    if dry_run:
        p = plan(msg_id, ctx, today)
        return {"do": p["do"], "why": p.get("why", ""), "tenancy": p.get("tenancy", ""),
                "task": (p.get("fields") or {}).get("fldgFjGBw6bTKJFCD", "")}
    try:
        out = record(msg_id, ctx, today)
    except Exception as exc:  # noqa: BLE001 — kept in the retry file and listed
        queue_retry(msg_id, ctx, (str(exc) or exc.__class__.__name__)[:400])
        raise RecordError(str(exc) or exc.__class__.__name__)
    clear_retry(msg_id)
    return out


def retry(dry_run=False, today=None):
    """Replay every message in the retry file."""
    rows = []
    for msg_id, entry in sorted(read_retry().items(), key=lambda kv: str((kv[1] or {}).get("first") or "")):
        ctx = (entry or {}).get("ctx") or {}
        row = {"id": msg_id, "sender": _sender(ctx), "subject": ctx.get("subject", ""),
               "attempts": (entry or {}).get("attempts"), "lastError": (entry or {}).get("error", "")}
        try:
            rows.append(dict(row, **_replay(msg_id, ctx, dry_run, today)))
        except RecordError as exc:
            rows.append(dict(row, do="error", why=str(exc)))
    return {"dryRun": dry_run, "queued": len(rows), "rows": rows}


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
    headers = got.get("headers") or {}
    unquote = _load("od_catask_for_dwp_notice", "create-agent-task.py").unquoted_body
    return cache_entry(headers.get("subject", ""), unquote(got.get("body") or ""), headers.get("from", ""))


def backfill(dry_run=True, reread=False, today=None):
    """Every message in the retry file, then every DWP message in the triage scan cache not in it."""
    queued = read_retry()
    rows = retry(dry_run, today)["rows"] if queued else []
    cache = read_scan_cache()
    for msg_id, ctx in sorted(cache.items(), key=lambda kv: (kv[1] or {}).get("internalDate") or 0):
        if msg_id in queued or not isinstance(ctx, dict) or not is_dwp_notice(_sender(ctx)):
            continue
        row = {"id": msg_id, "sender": _sender(ctx), "subject": ctx.get("subject", "")}
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
            rows.append(dict(row, **_replay(msg_id, ctx, dry_run, today)))
        except RecordError as exc:
            rows.append(dict(row, do="error", why=str(exc)))
    return {"dryRun": dry_run, "dwpMessages": len(rows), "rows": rows}


def main(argv):
    if not argv or argv[0] not in ("backfill", "retry", "clear"):
        print(__doc__)
        return 1
    if argv[0] == "clear":
        why = argv[argv.index("--why") + 1] if "--why" in argv[:-1] else ""
        if len(argv) < 2 or argv[1].startswith("--"):
            print("usage: dwp_notice.py clear <message id> --why \"<what was fixed>\"", file=sys.stderr)
            return 1
        try:
            print(json.dumps(clear(argv[1], why)))
        except RecordError as exc:
            print(json.dumps({"error": str(exc)}))
            return 2
        return 0
    flags = set(argv[1:])
    allowed = {"--dry-run", "--reread"} if argv[0] == "backfill" else {"--dry-run"}
    unknown = flags - allowed
    if unknown:
        print("unknown flag(s): %s" % " ".join(sorted(unknown)), file=sys.stderr)
        return 1
    try:
        if argv[0] == "retry":
            out = retry(dry_run="--dry-run" in flags)
        else:
            out = backfill(dry_run="--dry-run" in flags, reread="--reread" in flags)
    except RecordError as exc:
        print(json.dumps({"error": str(exc)}))
        return 2
    print(json.dumps(out, indent=1))
    return 1 if any(r.get("do") == "error" for r in out["rows"]) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
