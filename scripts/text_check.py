"""Did ClickSend text it? The alarm for a rent text sent by email (Kevin, 5 Oct 2026: "Do it now").

WHY THIS EXISTS
scripts/send-text.py hands an approved text to ClickSend as an email from info@agilelets.co.uk, and stamps
the card SENT once Gmail accepts it. If ClickSend then cannot text it (out of credit, a dead number, the
allowed-address setting removed), the only sign is an email back to info@, which nobody would read. No
ClickSend failure email had ever arrived when this was built, so its wording and sender are unknown: ANY
email from ClickSend to info@ after a text, and any Gmail bounce naming sms.clicksend.com, is treated as
"ClickSend wrote back". A tenant's own text, which ClickSend emails as "SMS reply from ..." or "Incoming SMS
from ...", is the one exception. The card and its tenancy say so once, and the rent check's line on Home
says so, for CHECK_DAYS after the text. When the email does not name exactly one of our texts, every text
before it is flagged, said as "cannot tell which": a false alarm costs a look, a silent miss costs the rent.

CONTROL, because a blind read looks exactly like "nothing came back": every text the ledger says went
(older than SETTLE_MINUTES) must be in info@'s Sent folder BY ITS GMAIL ID (the id send-text logs is the id
info@'s mailbox shows: checked 5 Oct 2026 on the test text). One missing and the check fails loudly and the
rent check turns red; it never reports "no problems".
"""

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_email_format import PROPERTY_SENDER, tenancies_to_note  # noqa: E402  (the one definition of each)

CHECK_DAYS = 3                      # how long after a text an email back still counts against it
SETTLE_MINUTES = 10                 # a text this new may not be indexed in Sent yet
GRACE_MINUTES = 10                  # the sent row is written after the worker answers: an early bounce still counts
INBOX = PROPERTY_SENDER              # info@agilelets.co.uk: the address every rent text is emailed from
OUR_NUMBER = "447984393339"         # the Agile Lets number ClickSend texts from: never a tenant's
LEDGER = os.path.expanduser("~/knowledge-os/logs/agent-dispatch/sent-text.jsonl")
CHECK_MARK = "TEXT CHECK:"
BACK_QUERY = "(from:clicksend.com OR (from:mailer-daemon sms.clicksend.com)) newer_than:%dd"
SENT_QUERY = "in:sent to:sms.clicksend.com newer_than:%dd"
TENANT_TEXT = re.compile(r"^\s*(SMS reply from|Incoming SMS from)\s", re.I)   # ClickSend's subject for a tenant's text
MOBILE = re.compile(r"(?<!\d)(?:\+?44|0)7\d{9}(?!\d)")
TASKS = "tblqB8b22hKBL4PF1"
TK = {"name": "fldgFjGBw6bTKJFCD", "notes": "fldR7apBzSp3oxFxz", "tenancies": "fldmne4RYJU22ICub",
      "sentBy": "fld30Yw8SWYVp049g", "teamMember": "flduCtmQGpOA4eWaj", "output": "fldzswp8fx6PqpLQ5"}
TENANCIES = "tblN51a88qTDB6iMH"


def _ts(text):
    try:
        return datetime.strptime(str(text)[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def sent_rows(path, now, days=CHECK_DAYS):
    """The texts the ledger says went in the last `days`: ([{task, at, numberEnds, messageId}], torn lines).
    One per task. A line that is not JSON is skipped and counted: a torn line is not a text."""
    rows, torn = {}, 0
    try:
        with open(path) as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    torn += 1
                    continue
                at = _ts(row.get("ts"))
                if row.get("event") == "sent" and at and now - at <= timedelta(days=days):
                    rows[row.get("task")] = {"task": row.get("task"), "at": at, "numberEnds": str(row.get("numberEnds") or ""),
                                             "messageId": str(row.get("messageId") or "")}
    except FileNotFoundError:
        return [], 0
    return sorted(rows.values(), key=lambda r: r["at"]), torn


def _when(msg, now):
    """When the email arrived. An email with no readable date is treated as arriving now: it still counts."""
    try:
        return datetime.fromtimestamp(int(msg.get("internalDate")) / 1000, tz=timezone.utc)
    except (TypeError, ValueError):
        return now


def _words(msg):
    h = msg.get("headers") or {}
    return " ".join(str(x or "") for x in (h.get("from"), h.get("subject"), msg.get("snippet"), msg.get("body")))


def default_list_mail(q):
    """info@'s mailbox through the Gmail worker inbound triage already uses: (messages, truncated)."""
    import importlib.util
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("inbound_triage_for_text_check", os.path.join(here, "inbound-triage.py"))
    tri = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tri)
    return tri.worker_list(q=q, max_pages=3, account=INBOX)


def assess(rows, back, sent_mail, now):
    """Pure. (flags, problem): each flag is {task, mail, subject, when, sure}."""
    in_sent = {str(m.get("id") or "") for m in sent_mail}
    settled = [r for r in rows if now - r["at"] >= timedelta(minutes=SETTLE_MINUTES)]
    missing = [r["task"] for r in settled if not r["messageId"] or r["messageId"] not in in_sent]
    if missing:
        return [], (f"control failed: {len(missing)} of {len(settled)} logged text(s) are not in {INBOX}'s Sent by "
                    f"their mail id (task {', '.join(missing)}): the mailbox read is blind, so no text can be called fine")
    flags = []
    for msg in back:
        subject = str((msg.get("headers") or {}).get("subject") or "")
        if TENANT_TEXT.match(subject):
            continue                                  # a tenant's own text, which inbound triage handles
        when = _when(msg, now)
        before = [r for r in rows if r["at"] - timedelta(minutes=GRACE_MINUTES) <= when]
        numbers = [d for d in MOBILE.findall(_words(msg).replace(" ", "")) if d[-10:] != OUR_NUMBER[-10:]]
        named = [r for r in before if r["numberEnds"] and any(r["numberEnds"] == d[-3:] for d in numbers)]
        sure = len(named) == 1                        # two texts sharing the named ending: those two, unsure
        for r in (named or before):
            flags.append({"task": r["task"], "mail": str(msg.get("id") or ""), "when": when,
                          "subject": (subject or "(no subject)")[:120], "sure": sure})
    return flags, ""


def run(rc, now, writes, ledger=None, list_mail=None):
    """The rent check's text alarm. `rc` is rent-check (its api). Never raises."""
    out = {"checked": 0, "flagged": [], "noted": [], "failed": ""}
    try:
        rows, torn = sent_rows(ledger or LEDGER, now)
        out["checked"] = len(rows)
        if torn:
            out["failed"] = f"{torn} line(s) of the text ledger could not be read"
        if not rows:
            return out
        list_mail = list_mail or default_list_mail      # looked up now, so a test's stand-in is used
        sent_mail, _ = list_mail(SENT_QUERY % (CHECK_DAYS + 1))
        back, truncated = list_mail(BACK_QUERY % (CHECK_DAYS + 1))
        flags, problem = assess(rows, back, sent_mail, now)
        if problem:
            out["failed"] = "; ".join(x for x in (out["failed"], problem) if x)
            return out
        if truncated:
            out["failed"] = "; ".join(x for x in (out["failed"], "the read of ClickSend's emails to info@ was cut short, "
                                                                   "so the check is incomplete") if x)
        for f in flags:
            out["flagged"].append(f["task"])
            if writes:
                said = _note(rc, f)
                if said == "noted":
                    out["noted"].append(f["task"])
                elif said:
                    out["failed"] = "; ".join(x for x in (out["failed"], said) if x)
    except (Exception, SystemExit) as exc:            # noqa: BLE001 — the inbox reader exits on a worker error;
        out["failed"] = f"the text check could not run: {str(exc)[:200]}"   # the row is the monitor, said
    out["flagged"] = sorted(set(out["flagged"]))
    return out


def _note(rc, f):
    """One Notes line on the card and one comment on its tenancy, once per email back. "noted" when written now,
    "" when already said, else the reason nothing was written. Field ids on BOTH sides of the read-modify-write,
    and a card whose Notes read blank is a STOP (a texted card always carries its key and SENT stamp): on
    28 Sep 2026 a name-keyed read used by id read blank and a PATCH wiped three Descriptions."""
    rec = rc.api("GET", f"{TASKS}/{f['task']}", params={"returnFieldsByFieldId": "true"})
    fields = rec.get("fields") or {}
    notes = str(fields.get(TK["notes"]) or "")
    if not notes.strip():
        return f"STOP: task {f['task']}'s Notes read blank, so the text-check note was not written"
    if f["mail"] and f["mail"] in notes:
        return ""
    stamp = datetime.now().strftime("%d %b %Y %H:%M")
    which = "" if f["sure"] else " It does not name exactly one of our texts, so every text sent before it is flagged; check which."
    line = (f"[{stamp} — text check] {CHECK_MARK} ClickSend wrote back to {INBOX} after this text "
            f"(\"{f['subject']}\", {f['when'].strftime('%d %b %H:%M')} UTC, mail {f['mail']}). The text may not "
            f"have arrived: look in ClickSend's SMS history.{which}")
    rc.api("PATCH", TASKS, {"records": [{"id": f["task"], "fields": {TK["notes"]: (notes.rstrip() + "\n\n" + line).strip()[-90000:]}}]})
    # The tenancy the send noted: the card's link, or the PLAN FOR tenancy a plan card names.
    ids = tenancies_to_note(fields.get(TK["name"]), notes, list(fields.get(TK["sentBy"]) or []) + list(fields.get(TK["teamMember"]) or []),
                            fields.get(TK["tenancies"]), fields.get(TK["output"])) or []
    for t in ids:
        rc.api("POST", f"{TENANCIES}/{t}/comments", {"text": f"{stamp}: {CHECK_MARK} the rent text on task {f['task']} may not "
                                                             "have arrived. ClickSend wrote back to info@; see the task."})
    return "noted"


def brief(out):
    """The words Home shows first, or "" when there is nothing to say. Short: Home prints 700 characters."""
    if out.get("flagged"):
        n = len(out["flagged"])
        return (f"Text check: ClickSend wrote back after {n} rent text{'s' if n != 1 else ''} "
                f"(task {', '.join(out['flagged'])}): it may not have arrived, look in ClickSend's SMS history.")
    if out.get("failed"):
        return "Text check FAILED: see the rent check row."
    return ""


def line(out):
    """The rent check row's line: the whole story."""
    bits = []
    if out.get("flagged"):
        bits.append(brief(out))
    if out.get("failed"):
        bits.append(f"Text check FAILED: {out['failed']}.")
    if bits:
        return " ".join(bits)
    if not out.get("checked"):
        return f"Text check: no rent text sent in the last {CHECK_DAYS} days."
    return f"Text check: {out['checked']} rent text(s) in the last {CHECK_DAYS} days, nothing came back from ClickSend."
