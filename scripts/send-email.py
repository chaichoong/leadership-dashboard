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

Usage:
  python3 scripts/send-email.py send TASKID [--dry-run]
  python3 scripts/send-email.py preview TASKID     # parse only, never sends
  python3 scripts/send-email.py health             # worker + consent check
"""

import importlib.util
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

# The Correspondence format lives in ONE place, shared with agent-dispatch.py's
# submit validation. Two copies of this parser is how a tier-1 banner came to be
# prepended by one script and rejected by the other.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_email_format import (  # noqa: E402
    EmailFormatError,
    parse_output as parse_email_output,
    BUSINESS_SENDER,
    BUSINESS_BRAND_RE,
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
    with open(real, "rb") as fh:
        data = fh.read()
    return {"filename": name, "mimeType": ATTACH_MIME[ext],
            "dataB64": base64.b64encode(data).decode(), "bytes": size}


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
    sender_problem = business_identity_mismatch(
        mail["subject"], mail["body"], mail["from"])

    # The attachment guards run for the dry run too: proving the payload is
    # the dry run's whole point, and a missing or out-of-bounds file is
    # exactly what it exists to catch before the real send.
    attachment = load_attachment(mail["attach"], args.task) if mail.get("attach") else None

    if args.dry_run:
        print(json.dumps({"dryRun": True, "task": args.task,
                          "approvalOutcome": mail["outcome"]
                          or "(not yet approved)",
                          "wouldSend": bool(mail["outcome"] in APPROVED)
                          and not sender_problem,
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
    ledger_append({"task": args.task, "ts": now_iso(), "event": "intent",
                   "to": mail["to"], "cc": mail["cc"],
                   "subject": mail["subject"]})

    result = worker_call(SEND_URL, payload)

    ledger_append({"task": args.task, "ts": now_iso(), "event": "sent",
                   "from": mail["from"] or "(default)",
                   "to": mail["to"], "cc": mail["cc"],
                   "subject": mail["subject"], "taskName": mail["taskName"],
                   "messageId": result.get("id"),
                   "threadId": result.get("threadId")})
    print(json.dumps({"sent": args.task, "to": mail["to"], "cc": mail["cc"],
                      "subject": mail["subject"],
                      "messageId": result.get("id")}))


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
    spec = importlib.util.spec_from_file_location(
        "ad", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "agent-dispatch.py"))
    ad = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ad)
    return ad.HUMANS, ad.TIER1_PATTERNS, ad.tier_match


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
    parts += ["", "Reply to this email with what you have done and it will be "
              "logged against the task.", "", "Kevin"]
    body = "\n".join(parts)

    if args.dry_run:
        print(json.dumps({"dryRun": True, "to": to, "name": who["name"],
                          "subject": f"{TEAM_NOTIFY_SUBJECT}: {name}",
                          "bodyChars": len(body), "tier1": False}, indent=2))
        return

    # Same ledger as `send`, so one task cannot be notified twice by two runs.
    prior = already_sent(args.task)
    if prior and prior.get("event") != "notify-superseded":
        print(json.dumps({"skipped": args.task,
                          "why": "already emailed at %s" % prior.get("ts")}))
        return

    ledger_append({"task": args.task, "ts": now_iso(), "event": "intent",
                   "to": [to], "cc": [], "subject": TEAM_NOTIFY_SUBJECT})
    result = worker_call(SEND_URL, {"to": to,
                                    "subject": f"{TEAM_NOTIFY_SUBJECT}: {name}",
                                    "text": body})
    ledger_append({"task": args.task, "ts": now_iso(), "event": "sent",
                   "from": "(default)", "to": [to], "cc": [],
                   "subject": TEAM_NOTIFY_SUBJECT, "taskName": name,
                   "messageId": result.get("id")})
    print(json.dumps({"notified": args.task, "to": to, "name": who["name"],
                      "messageId": result.get("id")}))


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

    n = sub.add_parser("notify",
                       help="tell a TEAM MEMBER a task is now theirs (never a third party)")
    n.add_argument("task")
    n.add_argument("--to", required=True, help="team email address")
    n.add_argument("--reason", default="", help="why it is theirs")
    n.add_argument("--dry-run", action="store_true")
    n.set_defaults(func=cmd_notify)

    v = sub.add_parser("preview", help="parse and print, never sends")
    v.add_argument("task")
    v.set_defaults(func=cmd_preview)

    t = sub.add_parser("selftest", help="offline parser checks, never sends")
    t.set_defaults(func=cmd_selftest)

    h = sub.add_parser("health", help="worker reachability and Gmail consent")
    h.set_defaults(func=cmd_health)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
