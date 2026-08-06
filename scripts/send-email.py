#!/usr/bin/env python3
"""Send an approved email on Kevin's behalf — the missing carry-out.

WHY THIS EXISTS
The agent dispatch engine (scripts/agent-dispatch.py) could prepare
Correspondence and put it in front of Kevin, but nothing in the platform could
actually SEND it. Every "email X" task therefore died as a Gmail draft that
Kevin had to open and press send on himself. That is the handoff the whole
approval loop exists to remove.

THE GATE IS IN THIS CODE, NOT IN A COMMENT
This script refuses to send unless Airtable says Kevin approved the task, and
it sends the approved words verbatim. There is no --force, no --yes and no way
to pass a recipient or a body on the command line. The only source of the
email is the Agent Output field of an approved task. That means:

  * an agent cannot send anything Kevin has not read;
  * if Kevin edits the copy in Airtable before approving, the edited copy is
    what goes out, because the field is read at send time, not at draft time;
  * a bug or a bad prompt cannot invent a recipient.

Approving IS sending, for a Correspondence task. That is the point.

AGENT OUTPUT FORMAT (a Correspondence task must use exactly this)

    TO: someone@example.com, other@example.com
    CC: optional@example.com
    SUBJECT: The subject line
    ---
    The body of the email, as many lines as needed.

Everything above the `---` is headers, everything below is the body, sent as
plain text UTF-8 (so £ and en dashes survive). BCC is deliberately not
supported: a hidden recipient is not something Kevin can approve by reading.

AUTH
Gmail SMTP over TLS with an app password at ~/.config/od/gmail_app_password
(never printed, never passed as an argument — see the CLAUDE.md rule on
secrets in the process table). The sending account defaults to
kevinbrittain@gmail.com and can be overridden by ~/.config/od/gmail_account.

An app password needs 2-Step Verification on the Google account. It is the
only part of this that Kevin has to do himself, once:
https://myaccount.google.com/apppasswords

IDEMPOTENCY
Every send appends to ~/knowledge-os/logs/agent-dispatch/sent-email.jsonl.
A task that already appears there is refused. A crash between the SMTP send
and the ledger write is the one case that could double-send, so the ledger is
written from a pre-send intent marker first, exactly like the carry-out ledger.

Usage:
  python3 scripts/send-email.py send TASKID [--dry-run]
  python3 scripts/send-email.py preview TASKID     # parse only, never sends
"""

import argparse
import json
import os
import re
import smtplib
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.message import EmailMessage

BASE_ID = "appnqjDpqDniH3IRl"
TASKS = "tblqB8b22hKBL4PF1"

# Mirrors AF in scripts/agent-dispatch.py. tests/constant-drift.test.js fails
# if these ever disagree with js/config.js TASK_FIELDS.
AF = {
    "name":            "fldgFjGBw6bTKJFCD",
    "status":          "fldx4qCw17UfrKpaN",
    "approvalOutcome": "fldrHBSr6qoUfaKuZ",
    "agentOutput":     "fldzswp8fx6PqpLQ5",
    "taskType":        "fldZ2moDV2041Sobc",
}

APPROVED = ("Approved as-is", "Approved with minor edits")

STATE_DIR = os.path.expanduser("~/knowledge-os/logs/agent-dispatch")
SENT_LEDGER = os.path.join(STATE_DIR, "sent-email.jsonl")

PAT_PATH = os.path.expanduser("~/.config/od/airtable_pat")
APP_PW_PATH = os.path.expanduser("~/.config/od/gmail_app_password")
ACCOUNT_PATH = os.path.expanduser("~/.config/od/gmail_account")
DEFAULT_ACCOUNT = "kevinbrittain@gmail.com"

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587

EMAIL_RE = re.compile(r"^[^@\s,]+@[^@\s,]+\.[^@\s,]+$")


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def read_secret(path, what):
    if not os.path.exists(path):
        sys.exit(
            f"ERROR: no {what} at {path}.\n"
            "       Kevin creates this once at "
            "https://myaccount.google.com/apppasswords\n"
            "       then: printf '%s' '<the 16 characters>' > "
            f"{path} && chmod 600 {path}"
        )
    with open(path) as fh:
        # Gmail shows app passwords in four blocks of four. Spaces are display
        # only; sending them verbatim fails auth with a misleading error.
        return fh.read().strip().replace(" ", "")


def api(method, url, payload=None):
    pat = read_secret(PAT_PATH, "Airtable PAT")
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {pat}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        # Never echo the request headers here: they carry the PAT.
        sys.exit(f"ERROR: Airtable {method} {e.code}: {e.read().decode()[:400]}")


def get_task(task_id):
    # returnFieldsByFieldId is NOT optional: AF is keyed by field ID, and
    # without it Airtable returns field NAMES. Every AF lookup then reads
    # empty, the approval check sees "(empty)" and refuses for the wrong
    # reason — a refusal that looks like the gate working while it is in
    # fact blind. See the known anti-pattern in CLAUDE.md.
    return api("GET", f"https://api.airtable.com/v0/{BASE_ID}/{TASKS}/"
                      f"{task_id}?returnFieldsByFieldId=true")


def sel(v):
    return v.get("name", "") if isinstance(v, dict) else (v or "")


def already_sent(task_id):
    try:
        with open(SENT_LEDGER) as fh:
            for line in fh:
                if not line.strip():
                    continue
                row = json.loads(line)
                if row.get("task") == task_id:
                    return row
    except FileNotFoundError:
        return None
    return None


def ledger_append(row):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(SENT_LEDGER, "a") as fh:
        fh.write(json.dumps(row) + "\n")


def parse_addresses(raw, field):
    out = []
    for part in re.split(r"[,;]", raw):
        addr = part.strip()
        if not addr:
            continue
        if not EMAIL_RE.match(addr):
            sys.exit(f"ERROR: {field} contains something that is not an email "
                     f"address: {addr!r}")
        out.append(addr)
    return out


def parse_output(output, task_id):
    """Turn an approved Agent Output into headers plus body.

    Strict on purpose. A malformed block is a refusal, never a guess, because
    guessing here means guessing a recipient.
    """
    if "---" not in output:
        sys.exit(f"ERROR: task {task_id} Agent Output has no `---` line "
                 "separating headers from body. See the format in this "
                 "script's docstring.")
    head, _, body = output.partition("---")
    headers = {}
    for line in head.strip().splitlines():
        if not line.strip():
            continue
        key, sep, val = line.partition(":")
        if not sep:
            sys.exit(f"ERROR: task {task_id} header line is not `KEY: value`: "
                     f"{line.strip()!r}")
        headers[key.strip().upper()] = val.strip()

    unknown = set(headers) - {"TO", "CC", "SUBJECT"}
    if unknown:
        # BCC lands here deliberately: a recipient Kevin cannot see in the
        # approval is a recipient he did not approve.
        sys.exit(f"ERROR: task {task_id} has unsupported header(s): "
                 f"{', '.join(sorted(unknown))}. Only TO, CC and SUBJECT.")

    to = parse_addresses(headers.get("TO", ""), "TO")
    cc = parse_addresses(headers.get("CC", ""), "CC")
    subject = headers.get("SUBJECT", "").strip()
    body = body.strip()

    if not to:
        sys.exit(f"ERROR: task {task_id} has no TO recipient")
    if not subject:
        sys.exit(f"ERROR: task {task_id} has no SUBJECT")
    if not body:
        sys.exit(f"ERROR: task {task_id} has an empty body")
    return {"to": to, "cc": cc, "subject": subject, "body": body}


def load_approved(task_id, require_approval=True):
    rec = get_task(task_id)
    f = rec.get("fields", {})
    name = f.get(AF["name"], "(Untitled)")
    outcome = sel(f.get(AF["approvalOutcome"]))
    status = sel(f.get(AF["status"]))
    ttype = sel(f.get(AF["taskType"]))
    output = f.get(AF["agentOutput"], "") or ""

    if require_approval and outcome not in APPROVED:
        sys.exit(
            f"REFUSED: task {task_id} ({name}) is not approved.\n"
            f"         Approval Outcome = {outcome or '(empty)'}, "
            f"Status = {status or '(empty)'}.\n"
            "         Nothing is sent until Kevin approves it in Airtable "
            "or Slack."
        )
    if require_approval and ttype != "Correspondence":
        sys.exit(f"REFUSED: task {task_id} is Task Type {ttype or '(empty)'}, "
                 "not Correspondence. This script only sends Correspondence.")
    if not output.strip():
        sys.exit(f"ERROR: task {task_id} has an empty Agent Output")

    parsed = parse_output(output, task_id)
    parsed.update({"taskName": name, "outcome": outcome})
    return parsed


def build_message(mail, account):
    msg = EmailMessage()
    msg["From"] = account
    msg["To"] = ", ".join(mail["to"])
    if mail["cc"]:
        msg["Cc"] = mail["cc"] and ", ".join(mail["cc"])
    msg["Subject"] = mail["subject"]
    msg.set_content(mail["body"], charset="utf-8")
    return msg


def cmd_preview(args):
    mail = load_approved(args.task, require_approval=False)
    print(json.dumps({
        "task": args.task, "taskName": mail["taskName"],
        "approvalOutcome": mail["outcome"],
        "to": mail["to"], "cc": mail["cc"], "subject": mail["subject"],
        "bodyChars": len(mail["body"]),
    }, indent=2))
    print("\n--- body ---\n" + mail["body"])


def cmd_send(args):
    prior = already_sent(args.task)
    if prior:
        sys.exit(f"REFUSED: task {args.task} was already sent at "
                 f"{prior.get('ts')} to {', '.join(prior.get('to', []))}. "
                 "Refusing to send it twice.")

    mail = load_approved(args.task)
    account = DEFAULT_ACCOUNT
    if os.path.exists(ACCOUNT_PATH):
        with open(ACCOUNT_PATH) as fh:
            account = fh.read().strip() or DEFAULT_ACCOUNT

    msg = build_message(mail, account)
    recipients = mail["to"] + mail["cc"]

    if args.dry_run:
        print(json.dumps({"dryRun": True, "task": args.task,
                          "from": account, "to": mail["to"], "cc": mail["cc"],
                          "subject": mail["subject"],
                          "bodyChars": len(mail["body"])}, indent=2))
        return

    password = read_secret(APP_PW_PATH, "Gmail app password")

    # Intent first. If the process dies after SMTP accepts the message but
    # before the sent row lands, the next run still sees this task in the
    # ledger and refuses, rather than sending Intus a second copy.
    ledger_append({"task": args.task, "ts": now_iso(), "event": "intent",
                   "to": mail["to"], "cc": mail["cc"],
                   "subject": mail["subject"]})

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as s:
            s.starttls()
            s.login(account, password)
            s.send_message(msg, from_addr=account, to_addrs=recipients)
    except smtplib.SMTPAuthenticationError:
        sys.exit("ERROR: Gmail rejected the app password. Check that 2-Step "
                 "Verification is on and the password in "
                 f"{APP_PW_PATH} is current.")
    except Exception as e:  # noqa: BLE001 — surface the real reason, loudly
        sys.exit(f"ERROR: SMTP send failed: {type(e).__name__}: {e}")

    ledger_append({"task": args.task, "ts": now_iso(), "event": "sent",
                   "from": account, "to": mail["to"], "cc": mail["cc"],
                   "subject": mail["subject"],
                   "taskName": mail["taskName"]})
    print(json.dumps({"sent": args.task, "to": mail["to"], "cc": mail["cc"],
                      "subject": mail["subject"]}))


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("send", help="send an approved Correspondence task")
    s.add_argument("task")
    s.add_argument("--dry-run", action="store_true",
                   help="parse, validate and report, but do not send")
    s.set_defaults(func=cmd_send)

    v = sub.add_parser("preview", help="parse and print, never sends")
    v.add_argument("task")
    v.set_defaults(func=cmd_preview)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
