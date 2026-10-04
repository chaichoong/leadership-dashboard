#!/usr/bin/env python3
"""Send an approved text to a tenant from the Agile Lets number: the gate, as send-email.py is for email.

WHY THIS EXISTS (Cash Flow Voids cut-over build, 3 Oct 2026; Kevin approved the plan "Build as-is")
A late-rent card carries the email AND the text Kevin approves, as two lines above the email's headers:

    TEXT TO: 07700 900123
    TEXT: Hello Sam, your rent of £900 due 1 Oct has not reached us yet. ... Roy, Agile Lets

This script sends that text, verbatim, through GoHighLevel (the Agile Lets location the SMS bridge
reads). There is no way to pass a number or a message on the command line: the ONLY source is the
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
    the task itself (a lost ledger or another Mac never sends twice);
  * a GoHighLevel contact whose own phone is not the approved number;
  * no Agile Lets sending number on file (~/.config/od/agile_lets_sms_number): the text never goes from
    whatever number GoHighLevel would pick by default.

`send TASKID --dry-run` checks everything but the switch and the approval, finds the tenant's contact
in GoHighLevel (read only) and sends nothing. `lookup --tenant TENANTID` finds one tenant's contact,
read only, to prove the route. Nothing prints a name or a full number.

AUTH: ~/.config/od/ghl_api_key and ~/.config/od/ghl_location_id (one copy each, never printed, never
an argument); the Airtable PAT at ~/.config/od/airtable_pat.
"""

import argparse
import fcntl
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from approval_evidence import approval_evidence_problem  # noqa: E402
from agent_email_format import TRIAL_STAMP, EmailFormatError, parse_text, text_card, trial_problem  # noqa: E402

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
PAT_PATH, GHL_KEY_PATH, GHL_LOCATION_PATH = (os.path.join(CONFIG, f) for f in ("airtable_pat", "ghl_api_key", "ghl_location_id"))
# The Agile Lets number every text goes from, named, never left to the location's default (review, 4 Oct
# 2026): a cut-over prerequisite, read from the location's own numbers and written here then.
FROM_NUMBER_PATH = os.path.join(CONFIG, "agile_lets_sms_number")
STATE_DIR = os.path.expanduser("~/knowledge-os/logs/agent-dispatch")
LEDGER = os.path.join(STATE_DIR, "sent-text.jsonl")
GHL = "https://services.leadconnectorhq.com"
UK_MOBILE = re.compile(r"^\+447\d{9}$")


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


def ghl(method, path, payload=None):
    req = urllib.request.Request(f"{GHL}{path}", method=method,
                                 data=json.dumps(payload).encode() if payload is not None else None)
    req.add_header("Authorization", f"Bearer {read_secret(GHL_KEY_PATH, 'GoHighLevel key')}")
    req.add_header("Version", "2021-07-28")
    req.add_header("Accept", "application/json")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "od-send-text/1.0")
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        sys.exit(f"ERROR: GoHighLevel {e.code}: {e.read().decode()[:300]}")


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


def find_contact(number):
    """The GoHighLevel contact id for a number in the Agile Lets location, or "" (read only). A contact
    whose own phone is not that number is refused: the text goes to the contact's phone."""
    location = read_secret(GHL_LOCATION_PATH, "GoHighLevel location id")
    found = ghl("GET", "/contacts/search/duplicate?" + urllib.parse.urlencode({"locationId": location, "number": number}))
    contact = (found or {}).get("contact") or {}
    if contact and uk_mobile(contact.get("phone")) != number:
        sys.exit("REFUSED: the GoHighLevel contact found for the number holds a different phone; nothing sent.")
    return str(contact.get("id") or "")


def load_card(task_id, dry_run):
    """(task fields, number, message) of a card that passes every gate but the switch, or exits."""
    rec = airtable("GET", f"{TASKS}/{task_id}?returnFieldsByFieldId=true")
    f = rec.get("fields") or {}
    notes = str(f.get(AF["notes"]) or "")
    trial = trial_problem(list(f.get(AF["sentForApprovalBy"]) or []) + list(f.get(AF["teamMember"]) or []),
                          f.get(AF["name"], ""), notes, f.get(AF["approvedAt"]) or "")
    if trial and not dry_run:
        sys.exit(f"REFUSED: task {task_id} is a trial card and is never texted: {trial}.")
    if not text_card(f.get(AF["name"], ""), notes, f.get(AF["agentOutput"], "")):
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
    from_number = ""
    if os.path.exists(FROM_NUMBER_PATH):
        with open(FROM_NUMBER_PATH) as fh:
            from_number = uk_mobile(fh.read())
    if not from_number and not args.dry_run:
        sys.exit(f"REFUSED: no Agile Lets sending number is on file ({FROM_NUMBER_PATH}), so nothing is sent.")
    f, number, message, trial, outcome = load_card(args.task, args.dry_run)
    contact = find_contact(number)
    if args.dry_run:
        print(json.dumps({"dryRun": True, "task": args.task, "switchedOn": on, "trial": trial or None,
                          "fromNumberSet": bool(from_number),
                          "approvalOutcome": outcome or "(not yet approved)", "contactFound": bool(contact),
                          "numberEnds": number[-3:], "chars": len(message)}, indent=2))
        return 0
    if not contact:
        location = read_secret(GHL_LOCATION_PATH, "GoHighLevel location id")
        made = ghl("POST", "/contacts/upsert", {"locationId": location, "phone": number})
        made = (made or {}).get("contact") or {}
        if uk_mobile(made.get("phone")) != number:
            sys.exit(f"ERROR: task {args.task}: the GoHighLevel contact made for the number holds a different phone; "
                     "nothing sent.")
        contact = str(made.get("id") or "")
        if not contact:
            sys.exit(f"ERROR: task {args.task}: GoHighLevel did not return a contact for the number; nothing sent.")
    ledger_append({"task": args.task, "ts": now_iso(), "event": "intent", "numberEnds": number[-3:], "chars": len(message)})
    try:
        sent = ghl("POST", "/conversations/messages", {"type": "SMS", "contactId": contact, "message": message,
                                                       "fromNumber": from_number})
    except SystemExit as exc:
        # A refusal GoHighLevel answers with (4xx) left nothing; anything else may have gone.
        error = str(exc)[:300]
        ledger_append({"task": args.task, "ts": now_iso(), "event": "failed" if re.match(r"ERROR: GoHighLevel 4\d\d:", error)
                       else "uncertain", "error": error})
        raise
    ledger_append({"task": args.task, "ts": now_iso(), "event": "sent", "numberEnds": number[-3:],
                   "messageId": str((sent or {}).get("messageId") or (sent or {}).get("id") or "")})
    stamp = datetime.now().strftime("%d %b %Y %H:%M")
    try:
        live = (airtable("GET", f"{TASKS}/{args.task}?returnFieldsByFieldId=true").get("fields") or {})
        notes = (str(live.get(AF["notes"]) or "").rstrip() + "\n\n"
                 + f"[{stamp} — send-text] SENT: text to the number ending {number[-3:]} ({len(message)} characters)").strip()
        airtable("PATCH", f"{TASKS}/{args.task}", {"fields": {AF["notes"]: notes[-90000:]}})
    except SystemExit as exc:
        print(f"WARNING: sent, but the SENT stamp could not be written: {exc}", file=sys.stderr)
    print(json.dumps({"sent": args.task, "numberEnds": number[-3:]}))
    return 0


def cmd_lookup(args):
    rec = airtable("GET", f"{TENANTS}/{args.tenant}?returnFieldsByFieldId=true")
    number = uk_mobile((rec.get("fields") or {}).get(TENANT_PHONE))
    if not number:
        print(json.dumps({"tenant": args.tenant, "mobile": False}))
        return 0
    contact = find_contact(number)
    print(json.dumps({"tenant": args.tenant, "mobile": True, "numberEnds": number[-3:], "contactFound": bool(contact)}))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("send")
    s.add_argument("task")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(fn=cmd_send)
    lk = sub.add_parser("lookup")
    lk.add_argument("--tenant", required=True)
    lk.set_defaults(fn=cmd_lookup)
    a = ap.parse_args(argv)
    if not re.fullmatch(r"rec[A-Za-z0-9]{14}", getattr(a, "task", None) or getattr(a, "tenant", "") or ""):
        sys.exit("ERROR: an Airtable record id is needed")
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
