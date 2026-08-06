#!/usr/bin/env python3
"""Send an approved email on Kevin's behalf — the gate for the Gmail worker.

WHY THIS EXISTS
`POST /send-email` on the drive-upload worker is the TRANSPORT: it sends as
kevinbrittain@gmail.com via the Gmail API (see memory reference_gmail_send_worker).
It is gated only by a bearer key, so anything holding that key can send anything
to anyone. "Only call it for approved work" is a rule written in a memory file,
and a rule in prose is not a control.

This script is the CONTROL. It is how agents send email, and it refuses to send
unless Airtable shows Kevin approved the task, sending the approved words
verbatim. There is no --force, no --yes, and no way to pass a recipient or a
body on the command line. The ONLY source of the email is the Agent Output of an
approved Correspondence task. So:

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
plain text (so £ and en dashes survive). BCC is deliberately not supported: a
hidden recipient is not something Kevin can approve by reading.

AUTH
Bearer key at ~/.config/od/gmail_send_key — the one copy, never printed and
never passed as an argument (see the CLAUDE.md rule on secrets in the process
table). Airtable PAT at ~/.config/od/airtable_pat.

A 409 from the worker means the one-time Gmail consent has not been granted:
Kevin opens https://drive-upload.kevinbrittain.workers.dev/auth/gmail once and
clicks Allow. The refresh token stores itself in the worker's KV. No terminal
step, and nothing for him to copy or paste.

IDEMPOTENCY
Every send appends to ~/knowledge-os/logs/agent-dispatch/sent-email.jsonl.
A task already in there is refused. The intent row is written BEFORE the send,
so a crash between the worker accepting the message and the result landing can
never send Intus a second copy.

Usage:
  python3 scripts/send-email.py send TASKID [--dry-run]
  python3 scripts/send-email.py preview TASKID     # parse only, never sends
  python3 scripts/send-email.py health             # worker + consent check
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

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
SEND_KEY_PATH = os.path.expanduser("~/.config/od/gmail_send_key")

WORKER = "https://drive-upload.kevinbrittain.workers.dev"
SEND_URL = f"{WORKER}/send-email"
HEALTH_URL = f"{WORKER}/send-email/test"
CONSENT_URL = f"{WORKER}/auth/gmail"

EMAIL_RE = re.compile(r"^[^@\s,]+@[^@\s,]+\.[^@\s,]+$")


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def read_secret(path, what):
    if not os.path.exists(path):
        sys.exit(f"ERROR: no {what} at {path}")
    with open(path) as fh:
        return fh.read().strip()


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


def worker_call(url, payload=None):
    key = read_secret(SEND_KEY_PATH, "Gmail send key")
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data,
                                 method="POST" if payload else "GET")
    req.add_header("Authorization", f"Bearer {key}")
    # Cloudflare blocks the default Python-urllib agent with error 1010 before
    # the worker ever runs, which reads as a 403 and looks exactly like a bad
    # key. Send a real User-Agent or every call fails for the wrong reason.
    req.add_header("User-Agent", "od-agent-dispatch/1.0")
    if payload is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:400]
        if e.code == 409:
            sys.exit(
                "REFUSED: the worker has no Gmail consent yet.\n"
                f"         Kevin opens {CONSENT_URL} once and clicks Allow.\n"
                "         Nothing to copy or paste; the token stores itself."
            )
        if e.code == 403:
            if "1010" in detail:
                sys.exit("ERROR: Cloudflare blocked this client (error 1010) "
                         "before the worker ran. This is NOT a key problem.")
            sys.exit(f"ERROR: the worker rejected the key in {SEND_KEY_PATH}")
        sys.exit(f"ERROR: worker {e.code}: {detail}")
    except Exception as e:  # noqa: BLE001 — surface the real reason, loudly
        sys.exit(f"ERROR: worker call failed: {type(e).__name__}: {e}")


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


def cmd_health(args):
    print(json.dumps(worker_call(HEALTH_URL), indent=2))


def cmd_preview(args):
    mail = load_approved(args.task, require_approval=False)
    print(json.dumps({
        "task": args.task, "taskName": mail["taskName"],
        "approvalOutcome": mail["outcome"] or "(not yet approved)",
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

    # A dry run sends nothing, so requiring approval for it buys no safety and
    # costs the ability to prove the payload before the real send. The real
    # send below is still gated.
    mail = load_approved(args.task, require_approval=not args.dry_run)

    if args.dry_run:
        print(json.dumps({"dryRun": True, "task": args.task,
                          "approvalOutcome": mail["outcome"]
                          or "(not yet approved)",
                          "wouldSend": bool(mail["outcome"] in APPROVED),
                          "to": mail["to"], "cc": mail["cc"],
                          "subject": mail["subject"],
                          "bodyChars": len(mail["body"])}, indent=2))
        return

    payload = {"to": ", ".join(mail["to"]),
               "subject": mail["subject"],
               "text": mail["body"]}
    if mail["cc"]:
        payload["cc"] = ", ".join(mail["cc"])

    # Intent first. If this process dies after the worker accepts the message
    # but before the sent row lands, the next run still sees the task in the
    # ledger and refuses, rather than sending a second copy.
    ledger_append({"task": args.task, "ts": now_iso(), "event": "intent",
                   "to": mail["to"], "cc": mail["cc"],
                   "subject": mail["subject"]})

    result = worker_call(SEND_URL, payload)

    ledger_append({"task": args.task, "ts": now_iso(), "event": "sent",
                   "to": mail["to"], "cc": mail["cc"],
                   "subject": mail["subject"], "taskName": mail["taskName"],
                   "messageId": result.get("id"),
                   "threadId": result.get("threadId")})
    print(json.dumps({"sent": args.task, "to": mail["to"], "cc": mail["cc"],
                      "subject": mail["subject"],
                      "messageId": result.get("id")}))


def main():
    p = argparse.ArgumentParser(
        description=__doc__,
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

    h = sub.add_parser("health", help="worker reachability and Gmail consent")
    h.set_defaults(func=cmd_health)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
