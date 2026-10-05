#!/usr/bin/env python3
"""Send an approved text to a tenant from the Agile Lets number: the gate, as send-email.py is for email.

WHY THIS EXISTS (Cash Flow Voids cut-over build, 3 Oct 2026; Kevin approved the plan "Build as-is")
A late-rent card carries the email AND the text Kevin approves, as two lines above the email's headers:

    TEXT TO: 07700 900123
    TEXT: Hello Sam, your rent of £900 due 1 Oct has not reached us yet. ... Roy, Agile Lets

This script sends that text, verbatim, from the Agile Lets ClickSend number (+44 7984 393339, the
number tenants already text: read off ClickSend's own inbound emails of 13 Aug and 1 Oct 2026). It goes
by ClickSend's email-to-text: one email from info@agilelets.co.uk to <number>@sms.clicksend.com,
through the same Gmail worker send-email.py uses, so no new key exists (Kevin, 5 Oct 2026: "Email-to-text",
over GoHighLevel, whose agency holds no Agile Lets location, and over a ClickSend API key). ClickSend
texts only from an address on its allowed list, from the number set there for it: that one setting is
the route, and the switch below goes on only once a test text has arrived from that number.
There is no way to pass a number or a message on the command line: the ONLY source is the
Agent Output of an approved Correspondence task. It refuses, in this order:

  * while text sending is switched off: until ~/.config/od/text-sending-on exists (Kevin's switch,
    only at the cut-over), nothing is ever sent, whatever else is true;
  * a trial agent's card (TRIAL_AGENTS, scripts/agent_email_format.py): never sent, approved or not;
  * any card but a rent lane's own tenant card (text_card: RENT LATE / RENT ASK, or their key line);
  * a closed card (Completed or Cancelled), or one the trial settled (TRIAL CHECKED): at the cut-over,
    the cards Kevin approved during the trial are history, never a queue of texts;
  * a card Kevin has not approved AS-IS in an approval surface (scripts/approval_evidence.py): an edit he
    asked for cannot be checked against a text, so "Approved with minor edits" sends no text;
  * a card with no TEXT lines, or a text over 300 characters;
  * a number that is not a UK mobile, or is not the Contact Number of a tenant linked to the task;
  * a card already texted, or one whose send may have gone: the ledger on this Mac AND the SENT stamp on
    the task itself (a lost ledger or another Mac never sends twice).

`send TASKID --dry-run` checks everything but the switch and the approval and sends nothing. Nothing
prints a name or a full number.

AUTH: the Gmail worker key send-email.py reads (~/.config/od/gmail_send_key) and the Airtable PAT at
~/.config/od/airtable_pat: one copy each, never printed, never an argument.
"""

import argparse
import fcntl
import importlib.util
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from approval_evidence import approval_evidence_problem  # noqa: E402
from agent_email_format import (PROPERTY_SENDER, TASK_TENANCIES, TENANCIES_TABLE, TRIAL_STAMP,  # noqa: E402
                                EmailFormatError, parse_text, tenancies_to_note, tenancy_comment, text_card,
                                trial_problem)

BASE_ID, TASKS, TENANTS = "appnqjDpqDniH3IRl", "tblqB8b22hKBL4PF1", "tblX4elTuu01gwBYh"
AF = {  # kept identical to scripts/send-email.py AF (tests/send-text.test.js)
    "name": "fldgFjGBw6bTKJFCD", "status": "fldx4qCw17UfrKpaN", "approvalOutcome": "fldrHBSr6qoUfaKuZ",
    "agentOutput": "fldzswp8fx6PqpLQ5", "taskType": "fldZ2moDV2041Sobc", "notes": "fldR7apBzSp3oxFxz",
    "sentForApprovalBy": "fld30Yw8SWYVp049g", "approvedAt": "fldr4Mvf2RzKvhZhi", "teamMember": "flduCtmQGpOA4eWaj",
    "tenants": "fld6ZcfEogJmeQj2c",
}
TENANT_PHONE = "fldraHUkWfqo4olLF"          # Tenants: Contact Number
APPROVED_AS_IS = "Approved as-is"
SENT_STAMP = "— send-text] SENT:"
CONFIG = os.path.expanduser("~/.config/od")
SWITCH = os.path.join(CONFIG, "text-sending-on")
PAT_PATH = os.path.join(CONFIG, "airtable_pat")
STATE_DIR = os.path.expanduser("~/knowledge-os/logs/agent-dispatch")
LEDGER = os.path.join(STATE_DIR, "sent-text.jsonl")
UK_MOBILE = re.compile(r"^\+447\d{9}$")
# ClickSend's email-to-text: an email from an allowed address to <number in 44 form>@sms.clicksend.com is
# texted from the number ClickSend sets for that address (Messaging Settings > Email SMS, set 5 Oct 2026).
# ClickSend texts the email's BODY only (its "Select Message Content" setting, changed from "subject and body"
# with Kevin's yes on 5 Oct 2026), so the text is exactly the words Kevin approved. The subject is never
# texted; the Gmail worker refuses a blank one.
CLICKSEND_DOMAIN = "sms.clicksend.com"
TEXT_FROM = PROPERTY_SENDER                  # info@agilelets.co.uk: on ClickSend's allowed list
AGILE_LETS_NUMBER = "+447984393339"          # ClickSend's number for it: the one tenants already text
TEXT_SUBJECT = "Agile Lets"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def read_secret(path, what):
    if not os.path.exists(path):
        sys.exit(f"ERROR: no {what} at {path}")
    with open(path) as fh:
        return fh.read().strip()


def airtable(method, path, payload=None):
    req = urllib.request.Request(f"https://api.airtable.com/v0/{BASE_ID}/{path}", method=method,
                                 data=json.dumps(payload).encode() if payload is not None else None)
    req.add_header("Authorization", f"Bearer {read_secret(PAT_PATH, 'Airtable PAT')}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"ERROR: Airtable {method} {e.code}: {e.read().decode()[:300]}")


def send_email_module():
    """scripts/send-email.py, for its Gmail worker call and its reading of a refusal: one road to the worker."""
    spec = importlib.util.spec_from_file_location("send_email", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                                             "send-email.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def clicksend_address(number):
    """The email-to-text address for a +447 mobile: its digits in 44 form, at ClickSend's domain."""
    return f"{number.lstrip('+')}@{CLICKSEND_DOMAIN}"


def uk_mobile(raw):
    """A UK mobile in +447 form, or "" when it is not one."""
    digits = re.sub(r"[^\d+]", "", str(raw or ""))
    if digits.startswith("00"):
        digits = "+" + digits[2:]
    if digits.startswith("07"):
        digits = "+44" + digits[1:]
    elif digits.startswith("447"):
        digits = "+" + digits
    return digits if UK_MOBILE.match(digits) else ""


def tenant_numbers(task_fields):
    """The UK mobiles of the tenants linked to the task, read from their records."""
    out = set()
    for tid in task_fields.get(AF["tenants"]) or []:
        rec = airtable("GET", f"{TENANTS}/{tid}?returnFieldsByFieldId=true")
        n = uk_mobile((rec.get("fields") or {}).get(TENANT_PHONE))
        if n:
            out.add(n)
    return out


def already_sent(task_id):
    """The ledger row that stops this task being texted, or None. A `sent` row refuses for ever; with none,
    the newest row decides: `intent` (a run died mid-send) and `uncertain` refuse (it may have gone);
    `failed` (refused before anything left) frees it. A missed text is recoverable; a second one is not."""
    last = sent = None
    try:
        with open(LEDGER) as fh:
            for line in fh:
                if not line.strip():
                    continue
                row = json.loads(line)
                if row.get("task") == task_id:
                    last = row
                    sent = row if row.get("event") == "sent" else sent
    except FileNotFoundError:
        return None
    if sent:
        return sent
    return None if last and last.get("event") == "failed" else last


def ledger_append(row):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(LEDGER, "a") as fh:
        fh.write(json.dumps(row) + "\n")


def load_card(task_id, dry_run):
    """(task fields, number, message) of a card that passes every gate but the switch, or exits."""
    rec = airtable("GET", f"{TASKS}/{task_id}?returnFieldsByFieldId=true")
    f = rec.get("fields") or {}
    notes = str(f.get(AF["notes"]) or "")
    trial = trial_problem(list(f.get(AF["sentForApprovalBy"]) or []) + list(f.get(AF["teamMember"]) or []),
                          f.get(AF["name"], ""), notes, f.get(AF["approvedAt"]) or "")
    if trial and not dry_run:
        sys.exit(f"REFUSED: task {task_id} is a trial card and is never texted: {trial}.")
    if not text_card(f.get(AF["name"], ""), notes, f.get(AF["agentOutput"], ""),
                     list(f.get(AF["sentForApprovalBy"]) or []) + list(f.get(AF["teamMember"]) or [])):
        sys.exit(f"REFUSED: task {task_id} is not a rent lane's tenant card, and only those are texted.")
    if SENT_STAMP in notes:
        sys.exit(f"REFUSED: task {task_id} carries a SENT stamp from send-text: it was texted. Never sent twice.")
    status = f.get(AF["status"]) or ""
    status = status.get("name", "") if isinstance(status, dict) else status
    if status in ("Completed", "Cancelled") or TRIAL_STAMP in notes:
        sys.exit(f"REFUSED: task {task_id} is closed or was settled on the trial ({status or 'no status'}); "
                 "it is history, never texted.")
    outcome = (f.get(AF["approvalOutcome"]) or {}).get("name") if isinstance(f.get(AF["approvalOutcome"]), dict) \
        else (f.get(AF["approvalOutcome"]) or "")
    if not dry_run:
        if outcome != APPROVED_AS_IS:
            sys.exit(f"REFUSED: task {task_id} is not approved as-is (Approval Outcome: {outcome or 'empty'}): "
                     "a text is sent only as Kevin read it.")
        evidence = approval_evidence_problem(f, rec.get("createdTime", ""))
        if evidence:
            sys.exit(f"REFUSED: task {task_id} reads {outcome!r}, but {evidence}.")
    ttype = f.get(AF["taskType"]) or ""
    ttype = ttype.get("name", "") if isinstance(ttype, dict) else ttype
    if ttype != "Correspondence":
        sys.exit(f"REFUSED: task {task_id} is Task Type {ttype or '(empty)'}, not Correspondence.")
    try:
        found = parse_text(f.get(AF["agentOutput"]) or "")
    except EmailFormatError as exc:
        sys.exit(f"REFUSED: task {task_id}: {exc}.")
    if not found:
        sys.exit(f"REFUSED: task {task_id} carries no TEXT TO and TEXT lines, so there is no text to send.")
    number, message = uk_mobile(found[0]), found[1]
    if not number:
        sys.exit(f"REFUSED: task {task_id}: the TEXT TO number is not a UK mobile.")
    if number not in tenant_numbers(f):
        sys.exit(f"REFUSED: task {task_id}: the TEXT TO number is not the Contact Number of a tenant linked to the task.")
    return f, number, message, trial, outcome


def cmd_send(args):
    os.makedirs(os.path.join(STATE_DIR, "send-locks"), exist_ok=True)
    with open(os.path.join(STATE_DIR, "send-locks", f"text-{args.task}.lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _cmd_send(args)


def _cmd_send(args):
    prior = already_sent(args.task)
    if prior:
        sys.exit(f"REFUSED: task {args.task} was already texted, or its text may have gone ({prior.get('event')} at "
                 f"{prior.get('ts')}). Never sent twice.")
    on = os.path.exists(SWITCH)
    if not on and not args.dry_run:
        sys.exit("REFUSED: text sending is switched off. It is switched on only at the cut-over, by Kevin's decision "
                 f"({SWITCH}).")
    f, number, message, trial, outcome = load_card(args.task, args.dry_run)
    if args.dry_run:
        print(json.dumps({"dryRun": True, "task": args.task, "switchedOn": on, "trial": trial or None,
                          "approvalOutcome": outcome or "(not yet approved)", "route": f"{TEXT_FROM} by ClickSend email-to-text",
                          "numberEnds": number[-3:], "chars": len(message)}, indent=2))
        return 0
    se = send_email_module()
    ledger_append({"task": args.task, "ts": now_iso(), "event": "intent", "numberEnds": number[-3:], "chars": len(message)})
    try:
        sent = se.worker_call(se.SEND_URL, {"to": clicksend_address(number), "from": TEXT_FROM,
                                            "subject": TEXT_SUBJECT, "text": message})
    except SystemExit as exc:
        # The worker's refusal before anything left (send-email.py's own reading) may be retried; anything
        # else may have gone, and is never sent twice.
        error = str(exc)[:300]
        ledger_append({"task": args.task, "ts": now_iso(), "event": "failed" if se.NOT_SENT_RE.search(error)
                       else "uncertain", "error": error})
        raise
    ledger_append({"task": args.task, "ts": now_iso(), "event": "sent", "numberEnds": number[-3:],
                   "messageId": str((sent or {}).get("id") or "")})
    stamp = datetime.now().strftime("%d %b %Y %H:%M")
    try:
        live = (airtable("GET", f"{TASKS}/{args.task}?returnFieldsByFieldId=true").get("fields") or {})
        notes = (str(live.get(AF["notes"]) or "").rstrip() + "\n\n"
                 + f"[{stamp} — send-text] SENT: text to the number ending {number[-3:]} ({len(message)} characters), "
                 f"emailed to ClickSend (message {(sent or {}).get('id') or '?'}) to go from the number it sets for "
                 f"{TEXT_FROM} ({AGILE_LETS_NUMBER}); ClickSend's SMS history is the delivery record").strip()
        airtable("PATCH", f"{TASKS}/{args.task}", {"fields": {AF["notes"]: notes[-90000:]}})
    except (SystemExit, Exception) as exc:                   # noqa: BLE001 — the text went; said, never undone
        print(f"WARNING: sent, but the SENT stamp could not be written: {exc}", file=sys.stderr)
    # The tenancy shows every action (Kevin, 5 Oct 2026). The text went: a failure here is said, never undone.
    noted, problem = [], ""
    try:
        f = airtable("GET", f"{TASKS}/{args.task}?returnFieldsByFieldId=true").get("fields") or {}
        ids = tenancies_to_note(f.get(AF["name"]), f.get(AF["notes"]),
                                list(f.get(AF["sentForApprovalBy"]) or []) + list(f.get(AF["teamMember"]) or []),
                                f.get(TASK_TENANCIES), f.get(AF["agentOutput"]))
        if ids == []:
            problem = "the card names no tenancy, so no tenancy comment was written"
        for t in ids or []:
            airtable("POST", f"{TENANCIES_TABLE}/{t}/comments",
                     {"text": tenancy_comment(stamp, f"texted the tenant on the number ending {number[-3:]}", args.task)})
            noted.append(t)
    except (SystemExit, Exception) as exc:                   # noqa: BLE001
        problem = f"the tenancy comment could not be written: {str(exc)[:200]}"
    if problem:
        print(f"WARNING: sent, but {problem}", file=sys.stderr)
    print(json.dumps({"sent": args.task, "numberEnds": number[-3:], "tenancyNoted": noted,
                      "tenancyNoteProblem": problem or None}))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("send")
    s.add_argument("task")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(fn=cmd_send)
    a = ap.parse_args(argv)
    if not re.fullmatch(r"rec[A-Za-z0-9]{14}", a.task or ""):
        sys.exit("ERROR: an Airtable record id is needed")
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
