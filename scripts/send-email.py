#!/usr/bin/env python3
"""Send an approved email on Kevin's behalf — the gate for the Gmail worker.

WHY THIS EXISTS
`POST /send-email` on the drive-upload worker is the TRANSPORT: it sends as
kevinbrittain@gmail.com via the Gmail API (see memory reference_gmail_send_worker).
It is gated only by a bearer key, so anything holding that key can send anything
to anyone. "Only call it for approved work" is a rule written in a memory file,
and a rule in prose is not a control.

This script is the CONTROL. It is how agents send email, and it refuses to send
unless Airtable shows Kevin approved the task in an approval surface (the
dashboard queue, the Tasks drawer or Slack), sending the approved words
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
    FROM: optional-sender@example.com
    SUBJECT: The subject line
    ---
    The body of the email, as many lines as needed.

FROM is optional and names which of Kevin's connected accounts sends. Kevin's
ruling, 6 Aug 2026: the default is kevinbrittain@gmail.com unless the task
says otherwise. The worker refuses a FROM that has not been connected via its
one-time /auth/gmail consent, listing which senders are available.

That default is right for a letter Kevin writes as himself and WRONG for copy
that speaks as Operations Director. Since 12 Aug 2026 `send` REFUSES an email
whose subject or body names the business while no FROM was chosen, and names
the sender to use — see business_identity_mismatch below. `preview` and
`--dry-run` report the same problem without refusing, so it is fixable at draft
time rather than at carry-out time.

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

TO-EACH (25 Sep 2026): a card whose headers carry `TO-EACH:` instead of `TO:` sends
the same approved words to each address as a SEPARATE email (a mail-out: one card,
thirty contacts, none sees the others). The ledger is kept per address, so a run that
stops half way resumes without a second copy to anyone. See send_each() below.

Usage:
  python3 scripts/send-email.py send TASKID [--dry-run]
  python3 scripts/send-email.py preview TASKID     # parse only, never sends
  python3 scripts/send-email.py health             # worker + consent check
  python3 scripts/send-email.py resolve-intent TASKID  # a send that died mid-way
"""

import importlib.util
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

# The Correspondence format lives in ONE place, shared with agent-dispatch.py's
# submit validation. Two copies of this parser is how a tier-1 banner came to be
# prepended by one script and rejected by the other.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from adobe_audit import audit_problem  # noqa: E402
from approval_evidence import approval_evidence_problem  # noqa: E402
from agent_email_format import (  # noqa: E402
    EmailFormatError,
    parse_output as parse_email_output,
    BUSINESS_SENDER,
    BUSINESS_BRAND_RE,
    PROPERTY_SENDER,
    PERSONAL_SENDER,
    rule_send_problem,
)

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
    # Read by `notify`: Roy has no login, so the email carries the work
    # itself rather than a link he cannot follow.
    "description":     "fldRGhBQViKZKtkQ6",
    "notes":           "fldR7apBzSp3oxFxz",
    # Read only by a rule send (17 Sep 2026): a redirect goes to this address alone.
    "inboundSender":   "fldzf4xlbrQuktx0i",
    # The two marks only a real approval leaves (finding 20260922-agent-dispatch-572).
    "sentForApprovalBy": "fld30Yw8SWYVp049g",
    "approvedAt":        "fldr4Mvf2RzKvhZhi",
}

APPROVED = ("Approved as-is", "Approved with minor edits")

# ─── SENDER IDENTITY ─────────────────────────────────────────────────
#
# Finding 20260812-ceo-huddle-094. The worker's default sender is Kevin's
# PERSONAL address (his ruling, 6 Aug 2026), which is right for a letter he
# writes as himself and wrong for anything that speaks as the business.
#
# On 12 Aug ten "Warm lane: re-engage <name>" tasks sat at Status=Approval with
# a TO and a SUBJECT and no FROM. Their copy says "You booked a call with
# Operations Director" and links to operationsdirector.co.uk. Approving one
# would have sent a business re-engagement from a gmail.com address to the
# highest-intent audience Kevin owns, and yesterday's 09:00 brief told him to
# send exactly that. Nothing in the send path noticed.
#
# So: if the words speak as the business and no FROM was chosen, refuse and name
# the sender to use. A refusal costs one line in the draft. The alternative is
# an unrecallable email to a warm prospect from the wrong identity.
# BUSINESS_SENDER and BUSINESS_BRAND_RE are IMPORTED above, not defined here.
# Until 4 Sep 2026 this file carried its own byte-identical copy of both,
# which is the drift the sender rule exists to prevent — and the test meant
# to catch it was asserting the CONTENTS of ALLOWED_SENDERS in the other
# file instead, so it never looked here. It went stale the moment a fourth
# sender was added on 3 Sep and still missed this copy.


def business_identity_mismatch(subject, body, sender):
    """Reason string when business copy would go out from the personal default.

    Empty string means there is nothing to complain about: either the copy does
    not speak as the business, or the draft already chose a sender explicitly.
    Choosing the personal address ON PURPOSE is allowed — write it as a FROM.
    """
    if sender:
        return ""
    hit = BUSINESS_BRAND_RE.search("%s\n%s" % (subject or "", body or ""))
    if not hit:
        return ""
    return (
        "the copy speaks as the business (matched %r) but no FROM was set, so "
        "this would send from the worker default kevinbrittain@gmail.com.\n"
        "         Add 'FROM: %s' to the Agent Output, or set the personal\n"
        "         address explicitly if that really is the intent."
        % (hit.group(0), BUSINESS_SENDER)
    )

STATE_DIR = os.path.expanduser("~/knowledge-os/logs/agent-dispatch")
SENT_LEDGER = os.path.join(STATE_DIR, "sent-email.jsonl")

PAT_PATH = os.path.expanduser("~/.config/od/airtable_pat")
SEND_KEY_PATH = os.path.expanduser("~/.config/od/gmail_send_key")

WORKER = "https://drive-upload.kevinbrittain.workers.dev"
SEND_URL = f"{WORKER}/send-email"
HEALTH_URL = f"{WORKER}/send-email/test"
CONSENT_URL = f"{WORKER}/auth/gmail"


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


# THE LEDGER HOLDS TWO KINDS OF EMAIL (finding 20260923-agent-dispatch-573,
# 25 Sep 2026). `notify` (the "a task is now yours" note to a colleague) and
# `send` (the approved email to the outside world) write to the same file under
# the same task id, and already_sent() matched on the id alone. So once a task
# had been handed to Roy, its real email was refused for ever as "already sent":
# the Manchester council EICR reply (recKho3l7jJKk9T0t) and the Sefton EICR
# booking (recPFxDmGX5pbonD2) were stuck that way for weeks. Each row now says
# its kind; an old row without one is a notify when its subject is a notify
# subject, which is how every notify row before this change was written.
SENDER_DEFAULT = PERSONAL_SENDER   # the one definition, in agent_email_format.py


def ledger_kind(row):
    kind = row.get("kind")
    if kind:
        return kind
    subject = str(row.get("subject") or "")
    return "notify" if subject.startswith((TEAM_NOTIFY_SUBJECT, ROY_NOTE_PREFIX)) else "send"


def already_sent(task_id, kind="send"):
    """The ledger row that stops this task and kind being sent, or None.

    A `sent` row refuses FOR EVER, whatever follows it: two overlapping runs
    can leave `intent, intent, sent, failed`, and the `failed` belongs to the
    run that lost (second review, 25 Sep 2026). With no `sent`, the newest
    row decides: `intent` (a run died mid-send) and `uncertain` refuse until
    resolve-intent settles them from the Sent folder; `failed` (the worker
    refused before anything left) and `intent-cleared` free it. A missed
    email is recoverable; a second copy is not. A TO-EACH mail-out writes one
    row per address (it carries a `recipient`); those are judged address by
    address in send_each(), so a half-finished mail-out can resume."""
    last = sent = None
    try:
        with open(SENT_LEDGER) as fh:
            for line in fh:
                if not line.strip():
                    continue
                row = json.loads(line)
                if row.get("task") == task_id and not row.get("recipient") and ledger_kind(row) == kind:
                    last = row
                    if row.get("event") == "sent":
                        sent = row
    except FileNotFoundError:
        return None
    if sent:
        return sent
    if last and last.get("event") in ("failed", "intent-cleared"):
        return None
    return last


def mailout_progress(task_id):
    """(done, retry, uncertain) addresses for one TO-EACH task, lower-cased.

    The LAST event recorded for an address decides:
      sent       -> done
      failed     -> retry: the worker refused before anything left (see send_each)
      uncertain  -> done, never retried, and reported: it may have gone
      intent     -> done, never retried, and reported: the run died mid-send
    A missed email is recoverable; a second copy is not.
    """
    state = {}
    try:
        with open(SENT_LEDGER) as fh:
            for line in fh:
                if not line.strip():
                    continue
                row = json.loads(line)
                addr = (row.get("recipient") or "").lower()
                if row.get("task") != task_id or not addr:
                    continue
                state[addr] = row.get("event")
    except FileNotFoundError:
        pass
    done = {a for a, ev in state.items() if ev in ("intent", "sent", "uncertain")}
    retry = {a for a, ev in state.items() if ev == "failed"}
    uncertain = {a for a, ev in state.items() if ev in ("intent", "uncertain")}
    return done, retry, uncertain


def ledger_append(row):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(SENT_LEDGER, "a") as fh:
        fh.write(json.dumps(row) + "\n")


def parse_output(output, task_id):
    """Turn an approved Agent Output into headers plus body.

    Thin wrapper over the shared contract in scripts/agent_email_format.py, so
    the submit path and the send path can never disagree about what a valid
    Correspondence output is. A leading tier-1 banner is stripped there before
    header parsing: agent-dispatch.py prepends it, and it is a label for Kevin,
    not part of the email.

    Strict on purpose. A malformed block is a refusal, never a guess, because
    guessing here means guessing a recipient.
    """
    try:
        return parse_email_output(output)
    except EmailFormatError as exc:
        sys.exit(f"ERROR: task {task_id} {exc} "
                 "See the format in this script's docstring.")


# ─── WAS IT REALLY APPROVED? ─────────────────────────────────────────
# Finding 20260922-agent-dispatch-572: the Approval Outcome string alone is not an approval. The
# check, its history and its limit live in scripts/approval_evidence.py, shared with
# calendar-write.py. AF["sentForApprovalBy"] and AF["approvedAt"] above name the same two fields.


def load_approved(task_id, require_approval=True, rule=None):
    rec = get_task(task_id)
    f = rec.get("fields", {})
    if rule:
        # THE RULE SEND (Kevin, 17 Sep 2026). Not approved by Kevin, so the
        # email must pass the rule itself, re-checked HERE from the stored task
        # and its Notes stamps, never from what the caller claims.
        output = f.get(AF["agentOutput"], "") or ""
        if not output.strip():
            sys.exit(f"ERROR: task {task_id} has an empty Agent Output")
        parsed = parse_output(output, task_id)
        problem = rule_send_problem(rule, parsed, {
            "name": f.get(AF["name"], ""), "notes": f.get(AF["notes"], ""),
            "inboundSender": f.get(AF["inboundSender"], ""),
            "taskType": sel(f.get(AF["taskType"]))})
        if problem:
            sys.exit(f"REFUSED: task {task_id} does not qualify for the {rule!r} rule: "
                     f"{problem}. It needs Kevin's approval.")
        parsed.update({"taskName": f.get(AF["name"], "(Untitled)"),
                       "outcome": f"rule:{rule}"})
        return parsed
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
            "         Nothing is sent until Kevin approves it in the dashboard queue "
            "or Slack."
        )
    evidence = approval_evidence_problem(f, rec.get("createdTime", ""))
    if require_approval and evidence:
        sys.exit(
            f"REFUSED: task {task_id} ({name}) reads {outcome!r}, but {evidence}.\n"
            "         Only an approval Kevin gives in an approval surface (the dashboard\n"
            "         queue, the Tasks drawer or Slack) sends. A task\n"
            "         raised under an approved parent goes through the gate itself\n"
            "         (agent-dispatch.py submit) or qualifies for a rule send (--rule)."
        )
    if require_approval and ttype != "Correspondence":
        sys.exit(f"REFUSED: task {task_id} is Task Type {ttype or '(empty)'}, "
                 "not Correspondence. This script only sends Correspondence.")
    if not output.strip():
        sys.exit(f"ERROR: task {task_id} has an empty Agent Output")

    parsed = parse_output(output, task_id)
    parsed.update({"taskName": name, "outcome": outcome, "approvalProblem": evidence})
    return parsed


def cmd_health(args):
    print(json.dumps(worker_call(HEALTH_URL), indent=2))


def cmd_preview(args):
    mail = load_approved(args.task, require_approval=False)
    print(json.dumps({
        "task": args.task, "taskName": mail["taskName"],
        "approvalOutcome": mail["outcome"] or "(not yet approved)",
        "to": mail["to"], "cc": mail["cc"], "subject": mail["subject"],
        "toEach": mail.get("toEach") or None,
        "bodyChars": len(mail["body"]),
        # Surfaced here so it is fixable at draft time rather than discovered
        # by `send` after Kevin has already approved the words.
        "senderProblem": business_identity_mismatch(
            mail["subject"], mail["body"], mail["from"]) or None,
    }, indent=2))
    print("\n--- body ---\n" + mail["body"])


# ─── Attachments (25 Aug 2026, Creditor Management agent) ────────────
#
# ATTACH names one local file that goes out with the email. The guards live
# HERE, not in the format parser, because this is the process that reads the
# file from disk — and reading a file into an outbound email is exactly the
# move a prompt-injected header would try ("ATTACH: ~/.config/od/..."). So:
# the file must sit under ONE directory that exists for outbound attachments,
# resolved against symlinks; only document/image extensions; a hard size cap.
# Agents write their attachments (e.g. extracted PDF pages) into this
# directory at DRAFT time — run scratch dirs are cleaned between the draft
# and the carry-out, which can be days apart.
ATTACH_DIR = os.path.realpath(os.path.expanduser(
    os.environ.get("SEND_EMAIL_ATTACH_DIR")
    or "~/knowledge-os/attachments"))
ATTACH_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg"}
ATTACH_MAX_BYTES = 5 * 1024 * 1024
ATTACH_MIME = {".pdf": "application/pdf", ".png": "image/png",
               ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


# The hand-off stamp names the file: "SIGNED COPY BACK: <agreement> came back
# signed. Signed PDF: <path>". Only THAT file is the signed one; a restraint
# order attached to the same task later is not (review, 8 Sep 2026).
SIGNED_STAMP_RE = re.compile(r"^\[(\d{1,2} \w{3} \d{4})(?: \d{2}:\d{2})?[^\]]*\]\s*SIGNED COPY BACK:[^\n]*?Signed PDF:\s*(\S+)", re.M)


def signed_via_adobe(task_id, real, notes=None):
    """False when never signed through Adobe; else the signing date string
    ('dd Mon yyyy') or None when unknown. Mirrors send-letter.py."""
    if notes is None:
        try:
            notes = (get_task(task_id).get("fields", {}) or {}).get(AF["notes"]) or ""
        except SystemExit:
            notes = ""
    base = os.path.basename(real)
    for day, pdf in SIGNED_STAMP_RE.findall(str(notes or "")):
        if os.path.basename(pdf.strip()) == base:
            return day
    if base.startswith("signed_"):
        return None
    return False


def load_attachment(attach, task_id):
    """Path from the approved ATTACH header → worker payload dict, or refuse."""
    import base64
    real = os.path.realpath(os.path.expanduser(attach))
    if not (real.startswith(ATTACH_DIR + os.sep)):
        sys.exit(f"REFUSED: task {task_id} ATTACH is outside the attachments "
                 f"directory ({ATTACH_DIR}). Files are only ever sent from "
                 "there — put the file in it and reference that path.")
    name = os.path.basename(real)
    ext = os.path.splitext(name)[1].lower()
    if name.startswith(".") or ext not in ATTACH_EXTENSIONS:
        sys.exit(f"REFUSED: task {task_id} ATTACH type {ext or '(none)'} is "
                 f"not allowed. Allowed: {', '.join(sorted(ATTACH_EXTENSIONS))}.")
    if not os.path.isfile(real):
        sys.exit(f"ERROR: task {task_id} ATTACH file does not exist: {name}. "
                 "It must exist at send time — agents write attachments to "
                 "the attachments directory at draft time, never a scratch dir.")
    size = os.path.getsize(real)
    if size > ATTACH_MAX_BYTES:
        sys.exit(f"REFUSED: task {task_id} ATTACH is {size} bytes — over the "
                 f"{ATTACH_MAX_BYTES} cap.")
    # Kevin's rule (8 Sep 2026): a signed document goes out with Adobe's
    # audit report at the back, from 9 Sep 2026 (see scripts/adobe_audit.py).
    if ext == ".pdf":
        signed_on = signed_via_adobe(task_id, real)
        if signed_on is not False:
            problem = audit_problem(real, signed_on)
            if problem:
                sys.exit(f"REFUSED: task {task_id} — {problem}")
    with open(real, "rb") as fh:
        data = fh.read()
    return {"filename": name, "mimeType": ATTACH_MIME[ext],
            "dataB64": base64.b64encode(data).decode(), "bytes": size}


def send_lock(task_id, wait=True):
    """An exclusive lock for one task's send, held from the ledger check to
    the last ledger row. Two runs sending the same task at once could both
    pass the check and leave `intent, intent, uncertain, failed`, which frees
    a task one of them may have sent (third review, 25 Sep 2026). Per task, so
    unrelated sends never wait on each other."""
    import fcntl
    lock_dir = os.path.join(STATE_DIR, "send-locks")
    os.makedirs(lock_dir, exist_ok=True)
    fh = open(os.path.join(lock_dir, f"{task_id}.lock"), "a")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        return None
    return fh


def cmd_send(args):
    lock = send_lock(args.task) if not getattr(args, "dry_run", False) else None
    try:
        return _cmd_send(args)
    finally:
        if lock:
            lock.close()


def _cmd_send(args):
    prior = already_sent(args.task)
    if prior and prior.get("event") in ("intent", "uncertain"):
        # A run died between "about to send" and "sent": it may or may not
        # have gone. Never guessed: resolve-intent reads the Sent folder.
        sys.exit(f"REFUSED: task {args.task} has an unfinished send from {prior.get('ts')} "
                 f"to {', '.join(prior.get('to', []))}: it may or may not have gone.\n"
                 f"       Check the Sent folder first:\n"
                 f"         python3 scripts/send-email.py resolve-intent {args.task}\n"
                 "       It records `sent` if the email is there (never sent twice) or clears the\n"
                 "       row if it is not, and then this send can run.")
    if prior:
        sys.exit(f"REFUSED: task {args.task} was already sent at "
                 f"{prior.get('ts')} to {', '.join(prior.get('to', []))}. "
                 "Refusing to send it twice.")

    # A dry run sends nothing, so requiring approval for it buys no safety and
    # costs the ability to prove the payload before the real send. The real
    # send below is still gated.
    rule = getattr(args, "rule", None)
    mail = load_approved(args.task, require_approval=not args.dry_run, rule=rule)
    sender_problem = business_identity_mismatch(
        mail["subject"], mail["body"], mail["from"])

    if mail.get("toEach"):
        return send_each(args, mail, sender_problem)

    # The attachment guards run for the dry run too: proving the payload is
    # the dry run's whole point, and a missing or out-of-bounds file is
    # exactly what it exists to catch before the real send.
    attachment = load_attachment(mail["attach"], args.task) if mail.get("attach") else None

    if args.dry_run:
        print(json.dumps({"dryRun": True, "task": args.task,
                          "approvalOutcome": mail["outcome"]
                          or "(not yet approved)",
                          "wouldSend": bool(mail["outcome"] in APPROVED)
                          and not mail.get("approvalProblem")
                          and not sender_problem,
                          "approvalProblem": mail.get("approvalProblem") or None,
                          "from": mail["from"] or "(worker default: kevinbrittain@gmail.com)",
                          "senderProblem": sender_problem or None,
                          "to": mail["to"], "cc": mail["cc"],
                          "subject": mail["subject"],
                          "attachment": ({"filename": attachment["filename"],
                                          "bytes": attachment["bytes"]}
                                         if attachment else None),
                          "bodyChars": len(mail["body"])}, indent=2))
        return

    if sender_problem:
        sys.exit(f"REFUSED: task {args.task} ({mail['taskName']}) — "
                 f"{sender_problem}")

    payload = {"to": ", ".join(mail["to"]),
               "subject": mail["subject"],
               "text": mail["body"]}
    if mail["cc"]:
        payload["cc"] = ", ".join(mail["cc"])
    if mail["from"]:
        payload["from"] = mail["from"]
    if attachment:
        payload["attachment"] = {k: attachment[k]
                                 for k in ("filename", "mimeType", "dataB64")}

    # Intent first. If this process dies after the worker accepts the message
    # but before the sent row lands, the next run still sees the task in the
    # ledger and refuses, rather than sending a second copy.
    ledger_append({"task": args.task, "ts": now_iso(), "event": "intent", "kind": "send",
                   "from": mail["from"] or PERSONAL_SENDER,
                   "to": mail["to"], "cc": mail["cc"],
                   "subject": mail["subject"]})

    try:
        result = worker_call(SEND_URL, payload)
    except SystemExit as exc:
        # worker_call exits on any failure. Say which, in the ledger, as the
        # mail-out does: a refusal before anything left is `failed` and may be
        # retried; anything else is `uncertain` and never is. Without this row
        # the intent stood alone and the task could never be sent again
        # (rec9IufIUW7DpxHZy, 23 Sep 2026).
        error = str(exc)[:300]
        ledger_append({"task": args.task, "ts": now_iso(), "kind": "send",
                       "event": "failed" if NOT_SENT_RE.search(error) else "uncertain",
                       "error": error})
        raise

    ledger_append({"task": args.task, "ts": now_iso(), "event": "sent", "kind": "send",
                   "from": mail["from"] or "(default)",
                   "to": mail["to"], "cc": mail["cc"],
                   "subject": mail["subject"], "taskName": mail["taskName"],
                   "messageId": result.get("id"),
                   "threadId": result.get("threadId")})
    # The dated trail (Kevin, 8 Sep 2026): a send that only lives in a local
    # ledger is invisible on the next card, and a payment-plan draft followed
    # a restraint-order letter nobody could see had gone. One stamped line.
    try:
        stamp = datetime.now().strftime("%d %b %Y %H:%M")
        att = f" with {attachment['filename']}" if attachment else ""
        line = (f"[{stamp} — send-email] SENT: email to {', '.join(mail['to'])} "
                f"\"{mail['subject']}\"{att} (message {result.get('id') or '?'})")
        live = get_task(args.task).get("fields", {}) or {}
        notes = (str(live.get(AF["notes"]) or "").rstrip() + "\n\n" + line).strip()[-90000:]
        api("PATCH", f"https://api.airtable.com/v0/{BASE_ID}/{TASKS}/{args.task}",
            {"fields": {AF["notes"]: notes}})
    except (SystemExit, Exception) as e:                     # noqa: BLE001
        print(f"WARNING: sent, but the SENT stamp could not be written: {e}", file=sys.stderr)
    print(json.dumps({"sent": args.task, "to": mail["to"], "cc": mail["cc"],
                      "subject": mail["subject"],
                      "messageId": result.get("id")}))


# ─── A MAIL-OUT: ONE CARD, ONE SEPARATE EMAIL PER ADDRESS (25 Sep 2026) ─
#
# The tenant-finding chain tells thirty council and charity contacts when a room
# opens. As thirty cards that is thirty approvals for one decision, and Kevin's
# queue is where work already waits; as one TO line it shows every contact to
# every other. So the approved card carries TO-EACH and this sends the SAME
# approved words to each address on its own. The ledger is written per address,
# before each send, so a run that dies half way resumes where it stopped and no
# address is ever sent a second copy.
MAILOUT_PAUSE_SECONDS = 1.0

# A refusal that proves nothing left: no Gmail consent (409), a rejected key or a
# Cloudflare block (403), a malformed request or a rate limit (400/404/422/429), Gmail
# refusing the message or a failed token refresh (a worker 500 that says so), or no
# network at all. Anything else (a bare 500, a timeout, a reset) may have happened AFTER
# Gmail accepted the message, so that address is never sent again: it is UNCERTAIN.
NOT_SENT_RE = re.compile(
    r"no Gmail consent|rejected the key|error 1010|worker (400|404|422|429)\b|"
    # The worker answers 500 with these words when Gmail refused the message or the
    # token could not be refreshed: in both cases nothing left (review, 25 Sep 2026).
    r"worker 500: .*(Gmail send failed|token|refresh)|"
    r"nodename nor servname|Name or service not known|Connection refused|"
    r"Network is unreachable|Temporary failure in name resolution", re.I)


def send_each(args, mail, sender_problem):
    done, retry, _ = mailout_progress(args.task)
    todo = [a for a in mail["toEach"] if a.lower() not in done or a.lower() in retry]
    if args.dry_run:
        print(json.dumps({"dryRun": True, "task": args.task, "mailOut": True,
                          "approvalOutcome": mail["outcome"] or "(not yet approved)",
                          "wouldSend": bool(mail["outcome"] in APPROVED)
                          and not mail.get("approvalProblem") and not sender_problem,
                          "approvalProblem": mail.get("approvalProblem") or None,
                          "from": mail["from"] or "(worker default: kevinbrittain@gmail.com)",
                          "senderProblem": sender_problem or None,
                          "subject": mail["subject"], "addresses": len(mail["toEach"]),
                          "alreadySent": sorted(a for a in mail["toEach"] if a.lower() in done
                                                and a.lower() not in retry),
                          "wouldSendTo": todo, "bodyChars": len(mail["body"])}, indent=2))
        return
    if sender_problem:
        sys.exit(f"REFUSED: task {args.task} ({mail['taskName']}) — {sender_problem}")
    if not todo:
        sys.exit(f"REFUSED: task {args.task} mail-out already went to all "
                 f"{len(mail['toEach'])} addresses. Refusing to send it twice.")
    sent, error = [], ""
    for i, addr in enumerate(todo):
        if i:
            time.sleep(MAILOUT_PAUSE_SECONDS)
        ledger_append({"task": args.task, "recipient": addr, "ts": now_iso(),
                       "event": "intent", "subject": mail["subject"]})
        payload = {"to": addr, "subject": mail["subject"], "text": mail["body"]}
        if mail["from"]:
            payload["from"] = mail["from"]
        try:
            result = worker_call(SEND_URL, payload)
        except SystemExit as exc:
            # worker_call exits on any failure. Stop the run either way: the next
            # address would meet the same worker.
            error = str(exc)[:300]
            event = "failed" if NOT_SENT_RE.search(error) else "uncertain"
            ledger_append({"task": args.task, "recipient": addr, "ts": now_iso(),
                           "event": event, "error": error})
            break
        ledger_append({"task": args.task, "recipient": addr, "ts": now_iso(),
                       "event": "sent", "from": mail["from"] or "(default)",
                       "subject": mail["subject"], "taskName": mail["taskName"],
                       # The thread lets the tenant chain match a STOP sent from a colleague's
                       # address back to the address we emailed (25 Sep 2026).
                       "messageId": result.get("id"), "threadId": result.get("threadId")})
        sent.append(addr)
    now_done, now_retry, now_unsure = mailout_progress(args.task)
    wanted = {a.lower() for a in mail["toEach"]}
    finished = (wanted <= now_done) and not (wanted & now_retry)
    unsure = sorted(wanted & now_unsure)
    try:
        stamp = datetime.now().strftime("%d %b %Y %H:%M")
        # SENT only when every address is done: the tenant chain settles a card (and the
        # monitor calls it sent) on this word alone, so a half-finished run must not use it.
        word = "SENT" if finished else "PARTIAL"
        line = (f"[{stamp} — send-email] {word}: mail-out \"{mail['subject']}\" to "
                f"{len(sent)} address(es) this run, each separately "
                f"({len(wanted & now_done - now_retry)} of {len(wanted)} done)"
                + (f". UNCERTAIN (may or may not have arrived, never resent): {', '.join(unsure)}" if unsure else "")
                + (f". STOPPED: {error}" if error else "."))
        live = get_task(args.task).get("fields", {}) or {}
        notes = (str(live.get(AF["notes"]) or "").rstrip() + "\n\n" + line).strip()[-90000:]
        api("PATCH", f"https://api.airtable.com/v0/{BASE_ID}/{TASKS}/{args.task}",
            {"fields": {AF["notes"]: notes}})
    except (SystemExit, Exception) as e:                     # noqa: BLE001
        print(f"WARNING: sent, but the SENT stamp could not be written: {e}", file=sys.stderr)
    print(json.dumps({"sent": args.task, "mailOut": True, "sentThisRun": sent,
                      "finished": finished, "uncertain": unsure or None,
                      "addresses": len(mail["toEach"]),
                      "subject": mail["subject"], "error": error or None}))
    if error or not finished:
        sys.exit(1)


# ─── TELLING A TEAM MEMBER THEY NOW OWN SOMETHING (28 Aug 2026) ─────
#
# `agent-dispatch.py handover` has reassigned tasks since 25 Aug 2026 and has
# NEVER told the new owner. 47 tasks were sitting linked to Roy Lavin the day
# this was found, and not one email had gone to him. A comment in the code said
# the handover "DMs the new owner"; nothing in the code did.
#
# It did not matter much while every handover was Kevin typing one by hand. It
# matters completely now the property lane routes automatically: work would
# leave Kevin's queue, land on a name, and be seen by nobody. That is worse
# than clogging his queue — he would believe it was handled.
#
# Kevin's requirement, 28 Aug 2026, in his own words: "as long as he's got the
# information by our email as well, that's the most important thing." Roy is
# not on Operations Director yet and email is all he has.
#
# WHY THIS IS NOT `send`. That path carries an approval gate because it puts
# words in front of a creditor, a council or a prospect. This one tells a
# colleague what he now owns. Different act, different guard:
#
#   * The recipient MUST be one of the known team addresses. Not an allowlist
#     of domains — the literal set of people, read from agent-dispatch.py so
#     there is ONE roster and adding a person cannot be done here by accident.
#   * TIER-1 CONTENT IS REFUSED outright, even to a team member. The private
#     legal matter does not travel because the recipient is trusted.
#   * It never invents a recipient from the task. `--to` is checked against the
#     roster and nothing else is read.
TEAM_NOTIFY_SUBJECT = "Operations Director: a task is now yours"


def team_roster():
    """The HUMANS dict from agent-dispatch.py — the ONE roster.

    Imported rather than copied: a second list of who may be emailed is how an
    address gets added in one file and trusted in the other.
    """
    ad = dispatch_module()
    return ad.HUMANS, ad.TIER1_PATTERNS, ad.tier_match


_DISPATCH = {}


def dispatch_module():
    """agent-dispatch.py, loaded once: the roster and the Roy-request rule live there."""
    if "ad" not in _DISPATCH:
        spec = importlib.util.spec_from_file_location(
            "ad", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "agent-dispatch.py"))
        ad = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ad)
        _DISPATCH["ad"] = ad
    return _DISPATCH["ad"]


def cmd_notify(args):
    humans, tier1_patterns, tier_match = team_roster()
    to = (args.to or "").strip().lower()
    who = humans.get(to)
    if not who:
        sys.exit(f"REFUSED: {args.to} is not a team member. This command mails "
                 f"colleagues about work, never third parties.\n"
                 f"       Allowed: {', '.join(sorted(humans))}")

    rec = get_task(args.task)
    f = rec.get("fields", {})
    name = f.get(AF["name"], "") or "(untitled task)"
    desc = (f.get(AF["description"], "") or "").strip()
    notes = (f.get(AF["notes"], "") or "").strip()
    output = (f.get(AF["agentOutput"], "") or "").strip()

    hit = tier_match(tier1_patterns, name, desc, notes)
    if hit:
        sys.exit(f"REFUSED: {args.task} matches tier-1 ({hit!r}). Kevin's "
                 "private legal and financial matter is never emailed onward, "
                 "not even to the team.")

    # ROY WORKS IN info@ (Kevin, 24 Sep 2026). His task emails went to his
    # personal Gmail and promised "reply and it will be logged"; nothing read
    # the replies, and 46 of his tasks sat untouched. Now they go to info@ as
    # one of his assistant's notes, and a reply to one is a request that
    # roy-assistant.py turns into an update on this task (task-update).
    roy_addr = next((e for e, h in humans.items() if h.get("name") == "Roy Lavin"), "")
    to_roy = bool(roy_addr) and to == roy_addr
    # The point of the email is that Roy can ACT without the app. So it carries
    # the work, not a link to it: he has no login to follow.
    parts = [f"{who['name']},", "",
             "This has been passed to you in Operations Director. "
             "You do not need to log in — everything is below.", "",
             f"TASK: {name}"]
    if desc:
        parts += ["", "WHAT IT IS", desc]
    if output:
        parts += ["", "WHAT WE FOUND", output]
    if args.reason:
        parts += ["", f"WHY IT IS YOURS: {args.reason}"]
    if to_roy:
        parts += ["", "Reply to this email with what you have done, or \"done\" when it "
                  "is finished. Your assistant records it on the task.", "",
                  f"Ref: {args.task}", "Kevin"]
        deliver = {"to": ROY_INBOX, "from": ROY_INBOX,
                   "subject": f"{ROY_NOTE_PREFIX} a task is yours - {name}"[:150]}
    else:
        parts += ["", "Reply to this email with what you have done and it will be "
                  "logged against the task.", "", "Kevin"]
        deliver = {"to": to, "subject": f"{TEAM_NOTIFY_SUBJECT}: {name}"}
    body = "\n".join(parts)

    if args.dry_run:
        print(json.dumps({"dryRun": True, "to": to, "name": who["name"],
                          "deliveredTo": deliver["to"], "subject": deliver["subject"],
                          "bodyChars": len(body), "tier1": False}, indent=2))
        return

    # Same ledger as `send`, so one task cannot be notified twice by two runs.
    prior = already_sent(args.task, "notify")
    if prior and prior.get("event") != "notify-superseded":
        print(json.dumps({"skipped": args.task,
                          "why": "already emailed at %s" % prior.get("ts")}))
        return

    ledger_append({"task": args.task, "ts": now_iso(), "event": "intent", "kind": "notify",
                   "to": [deliver["to"]], "cc": [], "subject": deliver["subject"]})
    result = worker_call(SEND_URL, {**deliver, "text": body})
    ledger_append({"task": args.task, "ts": now_iso(), "event": "sent", "kind": "notify",
                   "from": deliver.get("from", "(default)"), "to": [deliver["to"]], "cc": [],
                   "subject": deliver["subject"], "taskName": name,
                   "messageId": result.get("id")})
    print(json.dumps({"notified": args.task, "to": deliver["to"], "name": who["name"],
                      "messageId": result.get("id")}))


# ─── NOTES TO ROY ABOUT HIS OWN REQUESTS (Roy's assistant, 24 Sep 2026) ──
#
# Roy forwards a message from info@agilelets.co.uk to itself and
# scripts/roy-assistant.py tells him, by email to that same inbox, what became
# of it: got it, the answer, with Kevin, sent, not sent. Those words are built
# by roy-assistant.py, so this path takes a body — and is safe to, because it
# can only ever reach OUR OWN mailboxes:
#
#   * the recipient is info@agilelets.co.uk, or Roy's roster address for the
#     one "forward from info@ please" nudge — nothing else, whatever is asked;
#   * the task must be a Roy request (ROY: name + the roy-assistant stamp);
#   * tier-1 content never travels: a tier-1 request gets the fixed private
#     line and nothing from the task;
#   * one note per (task, kind), in its OWN ledger, because the sent ledger is
#     keyed by task alone and `send` would refuse the approved reply after it.
# The subject always opens ROY_NOTE_PREFIX, which is how roy-assistant.py
# knows its own mail in info@'s Sent folder and never takes it for a request.
ROY_INBOX = PROPERTY_SENDER
ROY_NOTE_PREFIX = "Assistant:"
ROY_NOTE_KINDS = ("got-it", "answer", "with-kevin", "sent", "not-sent", "closed",
                  "private", "nudge")
ROY_NOTE_LEDGER = os.path.join(STATE_DIR, "roy-notes.jsonl")
ROY_PRIVATE_SUBJECT = ROY_NOTE_PREFIX + " with Kevin"
ROY_PRIVATE_BODY = ("Roy,\n\nKevin is dealing with this one himself. Nothing more is "
                    "needed from you.\n\nRoy's assistant")


def roy_note_sent(task_id, kind):
    try:
        with open(ROY_NOTE_LEDGER) as fh:
            for line in fh:
                row = json.loads(line) if line.strip() else {}
                if (row.get("event") == "sent" and row.get("task") == task_id
                        and row.get("kind") == kind):
                    return row
    except FileNotFoundError:
        return None
    return None


def send_roy_note(task_id, kind, subject, body, to=ROY_INBOX, dry_run=False):
    """Send one note to Roy about his own request. Returns a result dict; a
    refusal raises SystemExit with the reason, like every gate here."""
    humans, tier1_patterns, tier_match = team_roster()
    roy_addr = next((e for e, h in humans.items() if h.get("name") == "Roy Lavin"), "")
    to = (to or "").strip().lower()
    if to not in {ROY_INBOX, roy_addr}:
        sys.exit(f"REFUSED: a note to Roy goes to {ROY_INBOX} (or his own address for "
                 f"the nudge), never {to or '(nobody)'}.")
    if kind not in ROY_NOTE_KINDS:
        sys.exit(f"REFUSED: unknown note kind {kind!r}")
    if kind == "nudge":
        if to != roy_addr:
            sys.exit("REFUSED: the nudge goes to Roy's own address only.")
    else:
        rec = get_task(task_id)
        f = rec.get("fields", {}) or {}
        name = f.get(AF["name"], "") or ""
        notes = f.get(AF["notes"], "") or ""
        if not dispatch_module().is_roy_request(name, notes):
            sys.exit(f"REFUSED: {task_id} is not a request Roy sent through info@.")
        hit = tier_match(tier1_patterns, name, f.get(AF["description"], "") or "", notes)
        if hit and kind != "private":
            sys.exit(f"REFUSED: {task_id} matches tier-1 ({hit!r}); only the fixed "
                     "private line may go to Roy.")
    if kind == "private":
        subject, body = ROY_PRIVATE_SUBJECT, ROY_PRIVATE_BODY
    subject = (subject or "").replace("\n", " ").strip()
    if not subject.startswith(ROY_NOTE_PREFIX):
        sys.exit(f"REFUSED: a note to Roy opens its subject with {ROY_NOTE_PREFIX!r}, so "
                 "roy-assistant.py never mistakes it for a new request.")
    if not (body or "").strip():
        sys.exit("REFUSED: empty note")
    key = task_id or "nudge"
    prior = roy_note_sent(key, kind)
    if prior:
        return {"skipped": key, "kind": kind, "why": f"already sent at {prior.get('ts')}"}
    if dry_run:
        return {"dryRun": True, "task": key, "kind": kind, "to": to, "subject": subject,
                "bodyChars": len(body)}
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(ROY_NOTE_LEDGER, "a") as fh:
        fh.write(json.dumps({"task": key, "kind": kind, "ts": now_iso(),
                             "event": "intent", "to": to}) + "\n")
    result = worker_call(SEND_URL, {"to": to, "from": ROY_INBOX,
                                    "subject": subject, "text": body})
    with open(ROY_NOTE_LEDGER, "a") as fh:
        fh.write(json.dumps({"task": key, "kind": kind, "ts": now_iso(), "event": "sent",
                             "to": to, "messageId": result.get("id")}) + "\n")
    return {"noted": key, "kind": kind, "to": to, "messageId": result.get("id")}


def cmd_roy_note(args):
    body = sys.stdin.read()
    print(json.dumps(send_roy_note(args.task, args.kind, args.subject, body,
                                   to=args.to or ROY_INBOX, dry_run=args.dry_run)))


def cmd_selftest(args):
    """Offline checks of the parser — the part a bug would turn into a wrong
    recipient. No network, no Airtable, safe anywhere."""
    cases = []

    def refuses(name, output):
        try:
            parse_output(output, "selftest")
        except SystemExit:
            cases.append((name, True))
        else:
            cases.append((name, False))

    good = parse_output(
        "TO: a@b.com, c@d.com\nCC: e@f.com\nSUBJECT: Hi £100\n---\nBody line.",
        "selftest")
    cases.append(("parses TO list", good["to"] == ["a@b.com", "c@d.com"]))
    cases.append(("parses CC", good["cc"] == ["e@f.com"]))
    cases.append(("keeps £ in subject", good["subject"] == "Hi £100"))
    cases.append(("body extracted", good["body"] == "Body line."))
    refuses("refuses missing ---", "TO: a@b.com\nSUBJECT: x\nbody")
    # Rule sends (17 Sep 2026): each condition that must keep an email on a card.
    from agent_email_format import REDIRECT_BODY, RULE_STAMP
    red_task = {"inboundSender": "Jane Cole <jane@example.com>",
                "notes": RULE_STAMP + ": redirect", "taskType": "Correspondence"}
    red = {"to": ["jane@example.com"], "cc": [], "from": "kevinbrittain@gmail.com",
           "subject": "Re: tap", "body": REDIRECT_BODY, "attach": None}
    cases.append(("rule: redirect qualifies", rule_send_problem("redirect", red, red_task) == ""))
    cases.append(("rule: redirect needs the submit stamp",
                  rule_send_problem("redirect", red, {**red_task, "notes": ""}) != ""))
    cases.append(("rule: redirect only to the inbound sender",
                  rule_send_problem("redirect", {**red, "to": ["other@example.com"]}, red_task) != ""))
    cases.append(("rule: redirect body is fixed",
                  rule_send_problem("redirect", {**red, "body": REDIRECT_BODY + " Also pay us."}, red_task) != ""))
    cases.append(("rule: redirect never from info@",
                  rule_send_problem("redirect", {**red, "from": "info@agilelets.co.uk"}, red_task) != ""))
    q_task = {"name": "COMPLIANCE: EICR renewal due 2026-10-14 - 5 Dalham Place",
              "notes": "COVERAGE CHECKED: CB9\n" + RULE_STAMP + ": quote-request",
              "taskType": "Correspondence"}
    q = {"to": ["jobs@spark.example"], "cc": [], "from": "info@agilelets.co.uk",
         "subject": "EICR quote request - 5 Dalham Place, CB9 0AL",
         "body": "Hello,\n\nCould you quote for an EICR at 5 Dalham Place?\n\nKind regards,\nRoy Lavin\nAgile Lets",
         "attach": None}
    cases.append(("rule: quote request qualifies", rule_send_problem("quote-request", q, q_task) == ""))
    cases.append(("rule: quote needs the coverage check",
                  rule_send_problem("quote-request", q, {**q_task, "notes": RULE_STAMP + ": quote-request"}) != ""))
    cases.append(("rule: quote never with an attachment",
                  rule_send_problem("quote-request", {**q, "attach": "/tmp/x.pdf"}, q_task) != ""))
    cases.append(("rule: quote to at most three",
                  rule_send_problem("quote-request", {**q, "to": ["a@x.com", "b@x.com", "c@x.com", "d@x.com"]}, q_task) != ""))
    cases.append(("rule: quote commits to nothing",
                  rule_send_problem("quote-request", {**q, "body": q["body"] + "\nPlease book it in."}, q_task) != ""))
    cases.append(("rule: quote signed Roy Lavin",
                  rule_send_problem("quote-request", {**q, "body": "Could you quote?\nKevin"}, q_task) != ""))
    cases.append(("rule: quote never to our own address",
                  rule_send_problem("quote-request", {**q, "to": ["kevin@runpreneur.org.uk"]}, q_task) != ""))
    cases.append(("rule: unknown rule refused", rule_send_problem("anything", q, q_task) != ""))
    refuses("refuses BCC", "TO: a@b.com\nBCC: x@y.com\nSUBJECT: x\n---\nb")
    refuses("refuses bad address", "TO: not-an-email\nSUBJECT: x\n---\nb")
    refuses("refuses no TO", "SUBJECT: x\n---\nb")
    refuses("refuses empty body", "TO: a@b.com\nSUBJECT: x\n---\n")
    withfrom = parse_output(
        "TO: a@b.com\nFROM: me@mine.com\nSUBJECT: x\n---\nb", "selftest")
    cases.append(("parses FROM", withfrom["from"] == "me@mine.com"))
    cases.append(("FROM defaults to None", good["from"] is None))
    refuses("refuses bad FROM", "TO: a@b.com\nFROM: nonsense\nSUBJECT: x\n---\nb")
    refuses("refuses two FROMs",
            "TO: a@b.com\nFROM: a@a.com, b@b.com\nSUBJECT: x\n---\nb")

    # A tier-1 task carries agent-dispatch.py's banner above the headers. Before
    # 11 Aug 2026 that banner was read as a header with an empty key, so every
    # tier-1 Correspondence task failed here AFTER Kevin had approved it.
    from agent_email_format import TIER1_BANNER
    plain = "TO: a@b.com\nSUBJECT: x\n---\nBody line."
    tier1 = parse_output(TIER1_BANNER + "\n\n" + plain, "selftest")
    cases.append(("tier-1 banner stripped", tier1 == parse_output(plain, "selftest")))
    cases.append(("banner not left in body", TIER1_BANNER not in tier1["body"]))

    # The mandatory closing line agent-dispatch.py requires on every submit is a
    # note to Kevin about the action, not a sentence in the letter. Until 19 Aug
    # 2026 it was not stripped, so the only route to sending five approved
    # creditor and Companies House emails would have posted
    # '**Carrying this out will involve:** sending the email above ...' to the
    # recipient (finding 20260819-agent-dispatch-237).
    from agent_email_format import CARRY_OUT_MARKER
    closed = parse_output(
        plain + "\n\n" + CARRY_OUT_MARKER
        + " sending the email above to Companies House from Kevin's Gmail.",
        "selftest")
    cases.append(("closing carry-out line stripped",
                  "arrying this out" not in closed["body"]))
    cases.append(("body otherwise unchanged by the strip",
                  closed["body"] == parse_output(plain, "selftest")["body"]))
    fenced = parse_output(
        plain + "\n\n---\n\n" + CARRY_OUT_MARKER + " sending it.", "selftest")
    cases.append(("rule fencing the note goes with it",
                  fenced["body"] == parse_output(plain, "selftest")["body"]))
    mid = parse_output(
        "TO: a@b.com\nSUBJECT: x\n---\nCarrying this out will involve: "
        + ("word " * 120) + "\n\nRegards", "selftest")
    cases.append(("a mid-body mention is left alone",
                  "arrying this out" in mid["body"]))
    refuses("refuses a body that is only the closing line",
            "TO: a@b.com\nSUBJECT: x\n---\n" + CARRY_OUT_MARKER + " sending it.")

    # Sender identity (finding 20260812-ceo-huddle-094). The warm-lane copy is
    # the real text that would have gone out from a personal gmail address.
    warm = ("Hi Jack,\n\nYou booked a call with Operations Director a while "
            "back. https://operationsdirector.co.uk/book")
    cases.append(("business copy with no FROM is refused",
                  bool(business_identity_mismatch("the call you booked", warm, None))))
    cases.append(("business copy WITH a FROM is allowed",
                  not business_identity_mismatch("the call you booked", warm,
                                                 BUSINESS_SENDER)))
    cases.append(("personal copy with no FROM is allowed",
                  not business_identity_mismatch(
                      "Re: 32 Elmdon Place",
                      "Thanks for your letter of 4 August. I confirm the "
                      "payment plan.", None)))
    cases.append(("the refusal names the sender to use",
                  BUSINESS_SENDER in business_identity_mismatch(
                      "x", warm, None)))

    # Attachments (25 Aug 2026). The parser accepts the header shape; the
    # file guards are what stop an injected "ATTACH: ~/.config/od/<secret>"
    # riding an approved email out — so those are exercised against real
    # files in a throwaway attachments dir, not asserted from source.
    withattach = parse_output(
        "TO: a@b.com\nSUBJECT: x\nATTACH: /tmp/x/file.pdf\n---\nb", "selftest")
    cases.append(("parses ATTACH", withattach["attach"] == "/tmp/x/file.pdf"))
    cases.append(("ATTACH defaults to None", good.get("attach") is None))
    refuses("refuses two ATTACH files",
            "TO: a@b.com\nSUBJECT: x\nATTACH: a.pdf, b.pdf\n---\nb")

    import tempfile
    global ATTACH_DIR
    real_dir = ATTACH_DIR
    with tempfile.TemporaryDirectory() as tmp:
        ATTACH_DIR = os.path.realpath(tmp)
        try:
            inside = os.path.join(ATTACH_DIR, "pages.pdf")
            with open(inside, "wb") as fh:
                fh.write(b"%PDF-1.4 test")
            loaded = load_attachment(inside, "selftest")
            cases.append(("loads a file from the attachments dir",
                          loaded["filename"] == "pages.pdf"
                          and loaded["mimeType"] == "application/pdf"
                          and loaded["bytes"] == 13))

            def guard_refuses(name, path):
                try:
                    load_attachment(path, "selftest")
                except SystemExit:
                    cases.append((name, True))
                else:
                    cases.append((name, False))

            guard_refuses("refuses a path outside the attachments dir",
                          os.path.expanduser("~/.config/od/airtable_pat"))
            # A symlink INSIDE the dir pointing outside must not smuggle the
            # target through the prefix check — realpath resolves it first.
            link = os.path.join(ATTACH_DIR, "sneaky.pdf")
            os.symlink("/etc/hosts", link)
            guard_refuses("refuses a symlink escaping the dir", link)
            bad_ext = os.path.join(ATTACH_DIR, "notes.txt")
            open(bad_ext, "w").write("x")
            guard_refuses("refuses a disallowed extension", bad_ext)
            guard_refuses("refuses a missing file",
                          os.path.join(ATTACH_DIR, "ghost.pdf"))
            big = os.path.join(ATTACH_DIR, "big.pdf")
            with open(big, "wb") as fh:
                fh.seek(ATTACH_MAX_BYTES)
                fh.write(b"x")
            guard_refuses("refuses an oversize file", big)
        finally:
            ATTACH_DIR = real_dir

    failed = [n for n, ok in cases if not ok]
    for n, ok in cases:
        print(("PASS " if ok else "FAIL ") + n)
    if failed:
        sys.exit(f"selftest FAILED: {', '.join(failed)}")
    print(f"selftest OK ({len(cases)} checks)")


# RESOLVE AN UNFINISHED SEND (25 Sep 2026; the Dave Dangelo decline,
# rec9IufIUW7DpxHZy, sat blocked two days on an intent row with nothing after
# it). The answer is in the SENDING mailbox's Sent folder, read through the same
# worker the triage search uses. Found: record `sent`, so it is never sent twice.
# Not found: record `intent-cleared`, and the send may run. A mailbox the worker
# cannot read, or a Sent folder that shows nothing at all in 30 days, is a blind
# read and resolves nothing.
def sent_folder_search(q, account):
    spec = importlib.util.spec_from_file_location(
        "inbound_triage", os.path.join(os.path.dirname(os.path.abspath(__file__)), "inbound-triage.py"))
    tri = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tri)
    msgs, _ = tri.worker_list(q=q, max_pages=1, account=account)
    return msgs


# A send-as alias has no mailbox of its own: its sent mail sits in the Sent
# folder of the account it belongs to (checked 25 Sep 2026: 6 messages from
# the alias in 60 days, in kevin@runpreneur.org.uk's Sent).
SENT_FOLDER_OF = {BUSINESS_SENDER: "kevin@runpreneur.org.uk"}


def cmd_resolve_intent(args):
    # A send in flight holds the lock, and its email is not in Sent yet:
    # clearing its intent now could free a send that is about to land
    # (fourth review, 25 Sep 2026). Refuse while it runs.
    lock = send_lock(args.task, wait=False)
    if lock is None:
        sys.exit(f"REFUSED: a send of {args.task} is running now. Try again when it has finished.")
    try:
        return _resolve_intent(args)
    finally:
        lock.close()


def _resolve_intent(args):
    state = already_sent(args.task)
    if not state or state.get("event") not in ("intent", "uncertain"):
        sys.exit(f"REFUSED: {args.task} has no unfinished send to resolve "
                 f"(newest send row: {(state or {}).get('event') or 'none'}).")
    # The recipient, mailbox and subject are on the INTENT row; an `uncertain`
    # row after it records only the error.
    last = state
    try:
        with open(SENT_LEDGER) as fh:
            for line in fh:
                row = json.loads(line) if line.strip() else {}
                if (row.get("task") == args.task and not row.get("recipient")
                        and ledger_kind(row) == "send" and row.get("event") == "intent"):
                    last = row
    except FileNotFoundError:
        pass
    to = [a for a in (last.get("to") or []) if a]
    if not to:
        sys.exit(f"REFUSED: the unfinished send on {args.task} names no recipient, so the "
                 "Sent folder cannot be checked. Kevin decides this one.")
    # WHICH MAILBOX: from the ledger row, written at send time since 25 Sep 2026.
    # An older row is read from the task, and a task that cannot be read is a
    # refusal, never a guess: searching the wrong Sent folder finds nothing and
    # would clear a send that went (second review, 25 Sep 2026).
    sender = (last.get("from") or "").strip().lower()
    if not sender or sender == "(default)":
        try:
            fields = (get_task(args.task).get("fields", {}) or {})
        except SystemExit as exc:
            sys.exit(f"REFUSED: could not read {args.task} to learn which mailbox sent it "
                     f"({str(exc)[:120]}). Nothing was changed.")
        mail = parse_output(fields.get(AF["agentOutput"], "") or "", args.task)
        sender = (mail.get("from") or PERSONAL_SENDER).strip().lower()
    account = SENT_FOLDER_OF.get(sender, sender)
    try:
        since = (datetime.fromisoformat(str(last.get("ts")).replace("Z", "+00:00"))
                 - timedelta(days=1)).strftime("%Y/%m/%d")
    except ValueError:
        sys.exit(f"REFUSED: the unfinished send on {args.task} has no readable time.")
    control = sent_folder_search("in:sent newer_than:30d", account)
    if not control:
        sys.exit(f"REFUSED: {account}'s Sent folder shows nothing in 30 days, so this read is "
                 "blind. Nothing was changed.")
    # The subject as well as the recipient: a contractor who had several of our
    # emails that week must not make this one look sent (second review).
    subject = re.sub(r"^(?:(?:re|fwd?|fw)\s*:\s*)+", "", str(last.get("subject") or ""), flags=re.I)
    subject = re.sub(r'["()]', " ", subject).strip()
    if len(subject) > 80:
        # Whole words only: a subject cut mid-word matches nothing, and a miss
        # here would clear a send that went (third review: 44 of 153 real
        # subjects are longer than 80 characters).
        subject = subject[:80].rsplit(" ", 1)[0]
    query = f"in:sent to:{to[0]} after:{since}" + (f' subject:"{subject}"' if subject else "")
    hits = sent_folder_search(query, account)
    if hits:
        ledger_append({"task": args.task, "ts": now_iso(), "event": "sent", "kind": "send",
                       "to": to, "recovered": True, "messageId": hits[0].get("id"),
                       "note": f"found in {account} Sent by resolve-intent"})
        print(json.dumps({"resolved": args.task, "went": True, "account": account,
                          "found": len(hits), "to": to[0]}))
        return
    if subject and sent_folder_search(f"in:sent to:{to[0]} after:{since}", account):
        # Mail to them since then, none with this subject: the subject search
        # may simply have missed. Never clear on a maybe.
        sys.exit(f"REFUSED: {account} sent mail to {to[0]} since {since}, but none matched the "
                 f"subject {subject!r}. It may have gone under another subject, so nothing was "
                 "changed. Kevin decides this one.")
    ledger_append({"task": args.task, "ts": now_iso(), "event": "intent-cleared", "kind": "send",
                   "to": to, "why": f"nothing matching {query!r} in {account} Sent"})
    print(json.dumps({"resolved": args.task, "went": False, "account": account, "to": to[0],
                      "since": since, "controlSeen": len(control)}))


def main():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("send", help="send an approved Correspondence task")
    s.add_argument("task")
    s.add_argument("--rule", choices=("redirect", "quote-request"),
                   help="send with no card under Kevin's 17 Sep 2026 rule; the task "
                        "is re-checked here and refused unless it qualifies")
    s.add_argument("--dry-run", action="store_true",
                   help="parse, validate and report, but do not send")
    s.set_defaults(func=cmd_send)

    n = sub.add_parser("notify",
                       help="tell a TEAM MEMBER a task is now theirs (never a third party)")
    n.add_argument("task")
    n.add_argument("--to", required=True, help="team email address")
    n.add_argument("--reason", default="", help="why it is theirs")
    n.add_argument("--dry-run", action="store_true")
    n.set_defaults(func=cmd_notify)

    r = sub.add_parser("roy-note",
                       help="tell Roy, at info@, what became of his own request "
                            "(body on STDIN; never a third party)")
    r.add_argument("task", nargs="?", default="")
    r.add_argument("--kind", required=True, choices=ROY_NOTE_KINDS)
    r.add_argument("--subject", default="")
    r.add_argument("--to", default="")
    r.add_argument("--dry-run", action="store_true")
    r.set_defaults(func=cmd_roy_note)

    v = sub.add_parser("preview", help="parse and print, never sends")
    v.add_argument("task")
    v.set_defaults(func=cmd_preview)

    t = sub.add_parser("selftest", help="offline parser checks, never sends")
    t.set_defaults(func=cmd_selftest)

    h = sub.add_parser("health", help="worker reachability and Gmail consent")
    h.set_defaults(func=cmd_health)

    ri = sub.add_parser("resolve-intent",
                        help="settle a send that died mid-way, from the sending mailbox's Sent folder")
    ri.add_argument("task")
    ri.set_defaults(func=cmd_resolve_intent)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
