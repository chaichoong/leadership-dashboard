"""Roy's emailed answer to a housing costs check reaches the rent check (finding 20261008-agent-dispatch-802). Part of
the rent check.

WHY THIS EXISTS
Kevin, 8 Oct 2026: about a week after a new tenant's documents go on their Universal Credit journal, Roy rings
Universal Credit and EMAILS info@ to say the housing costs are verified, and that email is what starts the direct rent
form. Lane B (scripts/rent_new_tenant.py) reads Roy's answers only from his task's Notes, in the two shapes his
assistant and his Property Manager page write. Since 6 Oct his requests door is paused and he emails info@ from his own
Gmail, so nothing put his words on the task: his yes was never read, no form card was raised, and the tenancy sat on
"waiting on Roy" for ever. This copies his email onto the task, by rules, in a shape the reader already takes as his.
The reader is not changed.

WHAT IT DOES, each rent check, before lane B reads its tasks
  1. The open housing costs checks: for each tenancy whose furthest lane B step is the housing costs check, its newest
     costs task while it is open.
  2. Reads info@agilelets.co.uk for emails FROM Roy (agent-dispatch.py ROY_EMAIL) since the oldest of those tasks was
     raised, through the Gmail worker the proof of residency step uses. A read cut short fails. No email from Roy is
     checked against a read of every email to info@ in the same window: none at all means the read is blind, and the
     run fails loudly.
  3. An email answers a task only when it arrived AFTER that task was raised (the reader's own rule: one reply is never
     the answer to the question it caused) and its subject or own words name the task's tenant (the first name with
     another of their names beside it, never one name alone) or its unit or house (whole words: "1 Example Road" is not
     "11 Example Road"). One task: his words go on it. Several: nothing is written and the row says so, unless exactly
     one is named by its tenant or unit and the rest only by the house they share (two rooms in one house).
  4. His words: the email's own text above any quoted text and above his sign-off, on one line, at most WORDS_MAX
     characters (the subject when the body has none). Written only when lane B's own reader reads them as a yes or a no
     to "are the housing costs verified?", or his own text speaks about the housing costs, verification, Universal
     Credit or the DWP. Any other email that names the tenant (keys, repairs, an invoice) is said on the row and never
     written: the reader would take it as a reply it "could not read" and ask Roy again at once.
  5. Appends to the task's Notes his Property Manager page's shape, `[YYYY-MM-DD HH:MM Roy Lavin] <words>` (the
     email's London time), and under it `[ROY EMAIL <Gmail id>, read by the rent check] ...`, which ends his words for
     the reader and keys the write: an email whose id is on any lane B task, or in LEDGER, is never written again. The
     task is read fresh first; Notes that read blank are a STOP (a lane B task always carries its key there).

WHAT IT NEVER DOES
Sends nothing and decides nothing (lane B's reader does). Writes nothing on a dry run, or while the Cash Flow Voids
agent is switched off or unread.

KNOWN LIMITS (said, not hidden): an email sent before a costs task exists, or between a "no" and the next ask (the
answered task closes and the next one comes 7 days later), answers no open task, so it is not read; the next ask
reaches Roy by email and his reply to it is.
"""
import json
import os
import re
import unicodedata
from datetime import datetime, timezone

import rent_proof_of_residency as por
import rent_signed_check as rsc

INBOX = por.INBOX                    # info@agilelets.co.uk
LEDGER = os.path.expanduser("~/knowledge-os/logs/rent-check/roy-email.jsonl")
WORDS_MAX = 400
NOTES_MAX = 95000                    # Airtable long text holds 100,000 characters: never trimmed, said instead
MARK = "ROY EMAIL "
MARK_RE = re.compile(r"\[ROY EMAIL ([0-9A-Za-z]+), read by the rent check\]")
CLOSED = ("Completed", "Cancelled")
# His sign-off, on a line of its own, ends his words: a signature line wherever it is ("Kind regards", "Roy Lavin",
# "Sent from my iPhone"), a thank-you only once he has said something ("Thanks" may open a reply).
SIGNATURE_RE = re.compile(r"^\s*(?:kind regards|best regards|warm regards|regards|best wishes|roy|roy lavin"
                          r"|sent from my .*|--)\s*[,.!]*\s*$", re.I)
SIGNOFF_RE = re.compile(r"^\s*(?:many thanks|thanks|thank you|cheers|best)\s*[,.!]*\s*$", re.I)
SUBJECT_LEAD_RE = re.compile(r"^\s*(?:(?:re|fwd?|fw)\s*:\s*)+", re.I)
# What the housing costs question is about. Never "journal": his "<tenant> - Journal Details" emails are not an answer.
ABOUT_RE = re.compile(r"\bhousing\s+(?:costs?|element)\b|\bverif\w*|\buniversal\s+credit\b|\bUC\b|\bDWP\b", re.I)
_GATE = []


def _gate():
    """scripts/create-agent-task.py, for unquoted_body: the sender's own words, the triage gate's own reading."""
    if not _GATE:
        import importlib.util
        here = os.path.dirname(os.path.abspath(__file__))
        spec = importlib.util.spec_from_file_location("od_catask_for_roy_email", os.path.join(here, "create-agent-task.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _GATE.append(mod)
    return _GATE[0]


def norm(text):
    return unicodedata.normalize("NFKC", str(text or "")).replace("\r", "")


def own_text(body):
    """The email's own text: above any quoted block (create-agent-task.py unquoted_body) and above his sign-off."""
    lines = _gate().unquoted_body(norm(body)).splitlines()
    seen_words = False
    for i, ln in enumerate(lines):
        if SIGNATURE_RE.match(ln) or (seen_words and SIGNOFF_RE.match(ln)):
            lines = lines[:i]
            break
        seen_words = seen_words or bool(ln.strip())
    return "\n".join(lines).strip()


def his_words(msg, lb):
    """(his words on one line, taken from the subject?). Never carrying a key line another reader would take."""
    text = " ".join(own_text(msg.get("body")).split())
    from_subject = not text
    if from_subject:
        text = " ".join(SUBJECT_LEAD_RE.sub("", por.subject(msg)).split())
    cut = lb.SETUP_KEY_RE.search(text)
    if cut:
        text = text[:cut.start()].rstrip()
    text = text.split("Reference for the rent check", 1)[0].rstrip()
    return text[:WORDS_MAX].rstrip(), from_subject


def name_words(name):
    return [w for w in re.findall(r"[a-z]+", norm(name).lower()) if len(w) >= 2]


def names_tenant(text, name):
    """The tenant's first name with another of their names beside it ("Sam Sample", "Sam Sample's"). One name alone
    is nobody."""
    w = name_words(name)
    if len(w) < 2:
        return False
    rest = "|".join(re.escape(x) for x in w[1:])
    return re.search(rf"(?<![a-z]){re.escape(w[0])}\s+(?:{rest})(?![a-z])", norm(text).lower()) is not None


def split_unit(unit):
    """("Unit 3", "55 Example Place") from the rent check's unit name; (None, None) for its no-unit stand-in."""
    unit = str(unit or "")
    if not unit or "no unit linked" in unit:
        return None, None
    parts = re.split(r"\s+[–—-]\s+", unit, maxsplit=1)
    return (parts[0].strip(), parts[1].strip()) if len(parts) == 2 else (None, unit.strip())


def open_checks(rc, data):
    """[{task, tenancy, made, place, unitPart, house, tenants}] for each open housing costs check, and the set of
    Gmail ids already written on any lane B task."""
    lb = rc.lane_b_rules
    tasks = lb.read_tasks(rc)
    written = {m for t in tasks for m in MARK_RE.findall(str(t.get("notes") or ""))}
    steps, _asks, _problems, _stuck = lb.group_tasks(tasks)
    by_id = {r["id"]: r.get("fields") or {} for r in data["tenancies"]}
    out = []
    for tenancy, st in steps.items():
        far = next((s for s in reversed(lb.STEPS) if st.get(s)), None)
        if far != "costs":
            continue
        last = st["costs"][-1]
        if last["status"] in CLOSED or tenancy not in by_id:
            continue
        f = by_id[tenancy]
        unit = rc.first(f.get(rc.TY["unitRef"])) or ""
        part, house = split_unit(unit)
        out.append({"task": last["id"], "tenancy": tenancy, "made": last["made"], "place": lb.place_name(str(unit)),
                    "unitPart": part, "house": house, "tenants": list(f.get(rc.TY["tenants"]) or [])})
    return out, written


def match(checks, text, names):
    """The checks an email names. Several, unless exactly one is named by its tenant or unit and the others only by
    the house they share with it."""
    hits = []
    for c in checks:
        exact = (any(names_tenant(text, names.get(t, "")) for t in c["tenants"])
                 or bool(c["unitPart"] and c["house"] and rsc.same_house(c["unitPart"], text)
                         and rsc.same_house(c["house"], text)))
        house = bool(c["house"]) and rsc.same_house(c["house"], text)
        if exact or house:
            hits.append((c, exact))
    if len(hits) <= 1:
        return [c for c, _ in hits]
    exact = [c for c, e in hits if e]
    if len(exact) == 1 and all(rsc.house_key(c["house"]) == rsc.house_key(exact[0]["house"]) for c, e in hits if not e):
        return exact
    return [c for c, _ in hits]


def read_ledger(path):
    out = set()
    try:
        with open(path) as fh:
            for ln in fh:
                try:
                    row = json.loads(ln) if ln.strip() else None
                except ValueError:
                    continue
                if isinstance(row, dict) and row.get("mail"):
                    out.add(str(row["mail"]))
    except FileNotFoundError:
        pass
    return out


def ledger_append(path, row):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as fh:
        fh.write(json.dumps(row) + "\n")


def lines_for(msg, words):
    at = por.arrived(msg).astimezone(por.LONDON)
    subject = " ".join(por.subject(msg).split())[:80].replace("]", ")")
    return (f"[{at.strftime('%Y-%m-%d %H:%M')} Roy Lavin] {words}\n"
            f"[{MARK}{msg.get('id')}, read by the rent check] the line above is Roy's email to {INBOX} of "
            f"{at.strftime('%-d %b %Y %H:%M')}, subject \"{subject}\"")


def write_on_task(rc, task_id, mail, text):
    """Append his lines to the task's Notes and prove they landed. False when the email is on it already."""
    rec = rc.api("GET", f"{rc.T_TASKS}/{task_id}", params={"returnFieldsByFieldId": "true"})
    notes = str((rec.get("fields") or {}).get(rc.TK["notes"]) or "")
    if not notes.strip():
        raise RuntimeError(f"STOP: task {task_id}'s Notes read blank, so Roy's email was not written on it")
    if mail in MARK_RE.findall(notes):
        return False
    new = notes.rstrip() + "\n\n" + text
    if len(new) > NOTES_MAX:
        raise RuntimeError(f"task {task_id}'s Notes are too long to add Roy's email to ({len(new)} characters)")
    rc.api("PATCH", rc.T_TASKS, {"records": [{"id": task_id, "fields": {rc.TK["notes"]: new}}]})
    back = rc.api("GET", f"{rc.T_TASKS}/{task_id}", params={"returnFieldsByFieldId": "true"})
    if mail not in MARK_RE.findall(str((back.get("fields") or {}).get(rc.TK["notes"]) or "")):
        raise RuntimeError(f"Roy's email {mail} does not read back on task {task_id}: the write did not land")
    return True


def default_count_mail(q, account):
    """How many emails a mailbox read finds on its first page (the blind-read control)."""
    por._triage()._last_fail.clear()
    msgs, _cut = por._triage().worker_list(q=q, max_pages=1, account=account)
    return len(msgs)


def run(rc, data, now, writes, on, list_mail=None, count_mail=None, ledger=None, roy=None):
    """The bridge, once per rent check, before lane B. Never raises: a failure is said on the row and in the exit
    code."""
    out = {"on": bool(on), "checks": 0, "read": 0, "written": [], "planned": [], "ambiguous": [], "skipped": [],
           "already": 0, "failed": ""}
    if not on:
        return out
    list_mail = list_mail or por.default_list_mail
    count_mail = count_mail or default_count_mail
    ledger = ledger or LEDGER
    try:
        lb = rc.lane_b_rules
        checks, written = open_checks(rc, data)
        out["checks"] = len(checks)
        if not checks:
            return out
        roy = (roy or lb.module("ad").ROY_EMAIL).lower()
        since = min(c["made"] for c in checks)
        days = max(1, (now - since).days + 2)
        mails, cut = list_mail(f"from:{roy} newer_than:{days}d", INBOX)
        if cut:
            raise RuntimeError(f"the read of Roy's emails to {INBOX} was cut short")
        if not mails and not count_mail(f"newer_than:{days}d", INBOX):
            raise RuntimeError(f"control failed: no email at all reached {INBOX} in {days} days, so the mailbox read is "
                               "blind, not empty")
        written |= read_ledger(ledger)
        names = lb.read_names(rc, {t for c in checks for t in c["tenants"]})
        mine = [m for m in mails if roy in str((m.get("headers") or {}).get("from") or "").lower() and por.arrived(m)]
        mine = [m for m in mine if por.arrived(m) >= since]
        out["read"] = len(mine)
        for msg in sorted(mine, key=por.arrived):
            mail, at = str(msg.get("id") or ""), por.arrived(msg)
            if mail in written:
                out["already"] += 1
                continue
            text = por.subject(msg) + "\n" + own_text(msg.get("body"))
            hits = match([c for c in checks if at > c["made"]], text, names)
            if not hits:
                continue
            when = at.astimezone(por.LONDON).strftime("%-d %b %H:%M")
            subject = " ".join(por.subject(msg).split())[:80]
            if len(hits) > 1:
                out["ambiguous"].append(f"{when} \"{subject}\" names {len(hits)} housing costs checks "
                                        f"({'; '.join(c['place'] for c in hits)}), so nothing was written")
                continue
            c = hits[0]
            words, from_subject = his_words(msg, lb)
            verdict = lb.reading(words, "costs") if words else lb.UNCLEAR
            if verdict not in (lb.YES, lb.NO) and (from_subject or not ABOUT_RE.search(words)):
                out["skipped"].append(f"{when} \"{subject}\" names {c['place']} but does not answer the housing costs "
                                      "check, so it was not written")
                continue
            said = f"{c['place']} (task {c['task']}): Roy's email of {when}, read as {verdict}: \"{words[:80]}\""
            if not writes:
                out["planned"].append(said)
                continue
            if write_on_task(rc, c["task"], mail, lines_for(msg, words)):
                ledger_append(ledger, {"mail": mail, "task": c["task"], "tenancy": c["tenancy"], "verdict": verdict,
                                       "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
                out["written"].append(said)
            else:
                out["already"] += 1
            written.add(mail)
    except (Exception, SystemExit) as exc:                    # noqa: BLE001 — the row is the monitor
        out["failed"] = por.reason(exc)[:300]
    return out


def brief(out):
    """Home's words, or "": only what stops an answer reaching the clock."""
    if out.get("failed"):
        return "Roy's email check FAILED: see the rent check row."
    if out.get("ambiguous"):
        return f"Roy's emails: {len(out['ambiguous'])} named more than one housing costs check and were not read."
    return ""


def line(out):
    if not out.get("on"):
        return "Roy's emails: not read, the Cash Flow Voids agent is switched off or unread."
    bits = []
    if out.get("written"):
        bits.append("written on his housing costs task: " + "; ".join(out["written"]))
    if out.get("planned"):
        bits.append("a real run would write: " + "; ".join(out["planned"]))
    if out.get("ambiguous"):
        bits.append("NOT written: " + "; ".join(out["ambiguous"]))
    if out.get("skipped"):
        bits.append("not an answer: " + "; ".join(out["skipped"]))
    if out.get("failed"):
        bits.append(f"FAILED: {out['failed']}")
    if not bits:
        if not out.get("checks"):
            return "Roy's emails: no housing costs check is open."
        done = f" ({out['already']} already written)" if out.get("already") else ""
        return (f"Roy's emails: {out.get('read', 0)} to {INBOX} since the oldest open housing costs check was raised, "
                f"none a new answer to one{done}.")
    return "Roy's emails: " + ". ".join(bits) + "."
