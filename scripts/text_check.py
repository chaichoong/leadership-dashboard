"""Did ClickSend text it? The alarm for a rent text sent by email (Kevin, 5 Oct 2026: "Do it now").

WHY THIS EXISTS
scripts/send-text.py hands an approved text to ClickSend as an email from info@agilelets.co.uk, and stamps
the card SENT once Gmail accepts it. If ClickSend then cannot text it (out of credit, a dead number, the
allowed-address setting removed), the only sign is an email back to info@, which nobody would read. No
ClickSend failure email had ever arrived when this was built, so its wording is unknown: ANY email from
ClickSend to info@ after a text (a tenant's reply, from <number>@sms.clicksend.com, excepted) and any Gmail
bounce naming sms.clicksend.com is treated as "ClickSend wrote back": the card and its tenancy say so, and
the rent check's line on Home says so, for CHECK_DAYS after the text.

CONTROL, because a blind read looks exactly like "nothing came back": every text the ledger says went
(older than SETTLE_MINUTES) must be visible in info@'s Sent folder as an email to sms.clicksend.com. If the
mailbox shows fewer, the check fails loudly and the rent check turns red; it never reports "no problems".
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_email_format import PROPERTY_SENDER  # noqa: E402  (the one definition of the address)

CHECK_DAYS = 3                      # how long after a text an email back still counts against it
SETTLE_MINUTES = 10                 # a text this new may not be indexed in Sent yet
INBOX = PROPERTY_SENDER              # info@agilelets.co.uk: the address every rent text is emailed from
OUR_NUMBER = "447984393339"         # the Agile Lets number ClickSend texts from: never a tenant's
LEDGER = os.path.expanduser("~/knowledge-os/logs/agent-dispatch/sent-text.jsonl")
CHECK_MARK = "TEXT CHECK:"
BACK_QUERY = "((from:clicksend.com -from:sms.clicksend.com) OR (from:mailer-daemon sms.clicksend.com)) newer_than:%dd"
SENT_QUERY = "in:sent to:sms.clicksend.com newer_than:%dd"
TASKS = "tblqB8b22hKBL4PF1"
TASK_NOTES = "fldR7apBzSp3oxFxz"
TASK_TENANCIES = "fldmne4RYJU22ICub"
TENANCIES = "tblN51a88qTDB6iMH"


def _ts(text):
    try:
        return datetime.strptime(str(text)[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def sent_rows(path, now, days=CHECK_DAYS):
    """The texts the ledger says went in the last `days`: {task, at, numberEnds}, one per task."""
    rows = {}
    try:
        with open(path) as fh:
            for line in fh:
                if not line.strip():
                    continue
                row = json.loads(line)
                at = _ts(row.get("ts"))
                if row.get("event") == "sent" and at and now - at <= timedelta(days=days):
                    rows[row.get("task")] = {"task": row.get("task"), "at": at, "numberEnds": str(row.get("numberEnds") or "")}
    except FileNotFoundError:
        return []
    return sorted(rows.values(), key=lambda r: r["at"])


def _when(msg):
    try:
        return datetime.fromtimestamp(int(msg.get("internalDate")) / 1000, tz=timezone.utc)
    except (TypeError, ValueError):
        return None


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
    """Pure. (flags, problem): each flag is {task, mail, subject, when, sure}. `sure` is False when the email
    back names no number, so every text sent before it in the window is flagged, said as "cannot tell which"."""
    settled = [r for r in rows if now - r["at"] >= timedelta(minutes=SETTLE_MINUTES)]
    if len(sent_mail) < len(settled):
        return [], (f"control failed: the ledger says {len(settled)} text(s) went in the last {CHECK_DAYS} days but "
                    f"{INBOX}'s Sent shows {len(sent_mail)}: the mailbox read is blind, so no text can be called fine")
    flags = []
    for msg in back:
        when = _when(msg)
        if when is None:
            continue
        before = [r for r in rows if r["at"] <= when <= r["at"] + timedelta(days=CHECK_DAYS)]
        # The mobiles the email names, our own sending number aside. Naming any: only those texts. Naming none:
        # every text before it, said as "cannot tell which".
        numbers = [d for d in _numbers(_words(msg)) if d[-10:] != OUR_NUMBER[-10:]]
        named = [r for r in before if r["numberEnds"] and any(r["numberEnds"] == d[-3:] for d in numbers)]
        for r in (named if numbers else before):
            flags.append({"task": r["task"], "mail": str(msg.get("id") or ""), "when": when,
                          "subject": str((msg.get("headers") or {}).get("subject") or "(no subject)")[:120],
                          "sure": bool(named)})
    return flags, ""


def _numbers(text):
    import re
    return re.findall(r"(?:\+?44|0)7\d{9}", text.replace(" ", ""))


def run(rc, now, writes, ledger=None, list_mail=None):
    """The rent check's text alarm. `rc` is rent-check (its api and its Notes helpers). Never raises."""
    out = {"checked": 0, "flagged": [], "noted": [], "failed": ""}
    try:
        rows = sent_rows(ledger or LEDGER, now)
        out["checked"] = len(rows)
        if not rows:
            return out
        list_mail = list_mail or default_list_mail      # looked up now, so a test's stand-in is used
        sent_mail, _ = list_mail(SENT_QUERY % (CHECK_DAYS + 1))
        back, truncated = list_mail(BACK_QUERY % (CHECK_DAYS + 1))
        flags, problem = assess(rows, back, sent_mail, now)
        if problem:
            out["failed"] = problem
            return out
        if truncated:
            out["failed"] = "the read of ClickSend's emails to info@ was cut short, so the check is incomplete"
        for f in flags:
            out["flagged"].append(f["task"])
            if writes and _note(rc, f):
                out["noted"].append(f["task"])
    except (Exception, SystemExit) as exc:            # noqa: BLE001 — the inbox reader exits on a worker error;
        out["failed"] = f"the text check could not run: {str(exc)[:200]}"   # the row is the monitor, said
    out["flagged"] = sorted(set(out["flagged"]))
    return out


def _note(rc, f):
    """One Notes line on the card and one comment on its tenancy, once per email back. True when written now."""
    rec = rc.api("GET", f"{TASKS}/{f['task']}", params={"returnFieldsByFieldId": "true"})
    fields = rec.get("fields") or {}
    notes = str(fields.get(TASK_NOTES) or "")
    if f["mail"] and f["mail"] in notes:
        return False
    stamp = datetime.now().strftime("%d %b %Y %H:%M")
    which = "" if f["sure"] else " It names no number, so every text sent before it is flagged; check which."
    line = (f"[{stamp} — text check] {CHECK_MARK} ClickSend wrote back to {INBOX} after this text "
            f"(\"{f['subject']}\", {f['when'].strftime('%d %b %H:%M')} UTC, mail {f['mail']}). The text may not "
            f"have arrived: look in ClickSend's SMS history.{which}")
    rc.api("PATCH", TASKS, {"records": [{"id": f["task"], "fields": {TASK_NOTES: (notes.rstrip() + "\n\n" + line).strip()[-90000:]}}]})
    for t in fields.get(TASK_TENANCIES) or []:
        rc.api("POST", f"{TENANCIES}/{t}/comments", {"text": f"{stamp}: {CHECK_MARK} the rent text on task {f['task']} may not "
                                                             "have arrived. ClickSend wrote back to info@; see the task."})
    return True


def brief(out):
    """The words Home shows first, or "" when there is nothing to say."""
    if out.get("failed"):
        return f"Text check FAILED: {out['failed']}."
    if out.get("flagged"):
        n = len(out["flagged"])
        return (f"Text check: ClickSend wrote back after {n} rent text{'s' if n != 1 else ''} "
                f"(task {', '.join(out['flagged'])}): it may not have arrived, look in ClickSend's SMS history.")
    return ""


def line(out):
    """The rent check row's line."""
    said = brief(out)
    if said:
        return said
    if not out.get("checked"):
        return f"Text check: no rent text sent in the last {CHECK_DAYS} days."
    return f"Text check: {out['checked']} rent text(s) in the last {CHECK_DAYS} days, nothing came back from ClickSend."
