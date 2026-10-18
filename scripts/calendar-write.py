#!/usr/bin/env python3
"""Create an approved calendar entry in Kevin's diary — the gate for the worker.

WHY THIS EXISTS
`POST /calendar/create` on the drive-upload worker is the TRANSPORT: it writes
an event to Kevin's Google Calendar. It is gated only by a bearer key, so
anything holding that key could write anything to his diary. This script is
the CONTROL, the same split as scripts/send-email.py: it refuses to create
unless Airtable shows Kevin approved the task, and the ONLY source of the
event is the Agent Output of that approved task. There is no --force and no
way to pass a title or a time on the command line. So:

  * an agent cannot put anything in the diary Kevin has not read;
  * if Kevin edits the block in Airtable before approving, the edited block
    is what lands, because the field is read at create time;
  * a bug or a bad prompt cannot invent an appointment.

MOVING AND REMOVING (Kevin, 18 Oct 2026): a block with `REPLACES: <earlier diary
task>` moves the entry this script wrote for that task to the new time; a block with
`CANCELS: <earlier diary task>` removes it. The entry is found in this script's own
ledger, never by searching the diary, so only an entry the robot wrote, on Kevin's
approval, can ever be moved or removed, and again only on his approval.

The output shape (CALENDAR:/TITLE:/START:/END:, `---`, summary) is defined
once, in scripts/agent_calendar_format.py, shared with the submit gate in
agent-dispatch.py — the same one-parser rule as the email contract. Events
carry NO attendees at any layer: a diary entry never emails a third party.

USAGE
  python3 scripts/calendar-write.py create TASKID   # the only writing command
  python3 scripts/calendar-write.py test            # worker + consent health
  python3 scripts/calendar-write.py selftest        # offline contract checks

DOUBLE-CREATE PROTECTION
Same ledger discipline as send-email.py: one row per task in
~/knowledge-os/logs/agent-dispatch/calendar-created.jsonl, written BEFORE the
worker call. A task already in the ledger is refused — a crash between intent
and create is resolved by a human reading the ledger, never by re-running and
hoping.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from approval_evidence import SENT_FOR_APPROVAL_BY, approval_evidence_problem  # noqa: E402
from agent_email_format import trial_problem  # noqa: E402
from agent_calendar_format import (  # noqa: E402
    CALENDAR_LEDGER,
    TIMEZONE,
    CalendarFormatError,
    entry_creator,
    ledger_rows as _ledger_rows,
    parse_calendar,
    written_entry,
)

BASE_ID = "appnqjDpqDniH3IRl"
TASKS = "tblqB8b22hKBL4PF1"

AF = {
    "name":            "fldgFjGBw6bTKJFCD",
    "status":          "fldx4qCw17UfrKpaN",
    "approvalOutcome": "fldrHBSr6qoUfaKuZ",
    "agentOutput":     "fldzswp8fx6PqpLQ5",
    "taskType":        "fldZ2moDV2041Sobc",
    "notes":           "fldR7apBzSp3oxFxz",
}
APPROVED = ("Approved as-is", "Approved with minor edits")
TEAM_MEMBER = "flduCtmQGpOA4eWaj"      # Tasks: Team Member (read by the trial refusal)

LEDGER = CALENDAR_LEDGER
STATE_DIR = os.path.dirname(LEDGER)

PAT_PATH = os.path.expanduser("~/.config/od/airtable_pat")
SEND_KEY_PATH = os.path.expanduser("~/.config/od/gmail_send_key")

# Which Google account's diary the entry lands in. Kevin's ruling, 1 Sep 2026:
# his main calendar lives on the WORKSPACE account, kevin@runpreneur.org.uk —
# kevinbrittain@gmail.com is the personal free account. This deliberately
# DIFFERS from the email default (gmail, per GUARDRAILS): the two defaults
# answer different questions ("who is writing" vs "whose diary is it").
CALENDAR_ACCOUNT = "kevin@runpreneur.org.uk"

WORKER = "https://drive-upload.kevinbrittain.workers.dev"
CREATE_URL = f"{WORKER}/calendar/create"
# Move or remove an entry this script wrote (Kevin, 18 Oct 2026): REPLACES / CANCELS blocks.
UPDATE_URL = f"{WORKER}/calendar/update"
DELETE_URL = f"{WORKER}/calendar/delete"
HEALTH_URL = f"{WORKER}/calendar/test?account={CALENDAR_ACCOUNT}"
CONSENT_URL = f"{WORKER}/auth/gmail?account={CALENDAR_ACCOUNT}"

# How far in the past START may sit at create time. A draft can wait in the
# approval queue for a while, so a small grace beats a refusal Kevin cannot
# understand; beyond it the entry is almost certainly a stale or mis-parsed
# date and a human should look.
PAST_GRACE = timedelta(hours=1)


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
        # Never echo the request headers: they carry the PAT.
        sys.exit(f"ERROR: Airtable {method} {e.code}: {e.read().decode()[:400]}")


def get_task(task_id):
    # returnFieldsByFieldId is NOT optional: AF is keyed by field ID (see the
    # known anti-pattern in CLAUDE.md — without it every lookup reads empty
    # and the approval gate refuses blind).
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
    req.add_header("Content-Type", "application/json")
    # Cloudflare bans Python's default user agent outright (error 1010) —
    # the same trap send-email.py and inbound-triage.py already carry.
    req.add_header("User-Agent", "od-calendar-write/1.0")
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:400]
        if e.code == 409:
            sys.exit(f"REFUSED by worker (not connected): {body}\n"
                     f"         Kevin opens {CONSENT_URL} once and clicks "
                     "Allow — the consent now includes the calendar scope.")
        sys.exit(f"ERROR: worker {e.code}: {body}")


def ledger_rows():
    return _ledger_rows(LEDGER)


def ledger_append(row):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(LEDGER, "a") as fh:
        fh.write(json.dumps(row) + "\n")


def past_problem(event, now_london=None):
    """Reason the event is too far in the past to create, or empty string."""
    now_london = now_london or datetime.now(ZoneInfo(TIMEZONE)).replace(
        tzinfo=None)
    start = datetime.strptime(event["start"], "%Y-%m-%dT%H:%M:00")
    if start < now_london - PAST_GRACE:
        return (f"START {event['start']} is more than {PAST_GRACE} in the "
                f"past (London time is {now_london:%Y-%m-%d %H:%M}). A stale "
                "or mis-parsed date, not a diary entry — redo the draft")
    return ""


def cmd_create(args):
    task_id = args.task
    rec = get_task(task_id)
    f = rec.get("fields", {})
    name = f.get(AF["name"], "(Untitled)")
    # A trial task writes nothing to the diary (2 Oct 2026): the same rule as send-email.py.
    trial = trial_problem(list(f.get(SENT_FOR_APPROVAL_BY) or []) + list(f.get(TEAM_MEMBER) or []),
                          name, f.get(AF["notes"], ""))
    if trial:
        sys.exit(f"REFUSED: task {task_id} is a trial task and no diary entry is made for it: {trial}.")
    outcome = sel(f.get(AF["approvalOutcome"]))
    ttype = sel(f.get(AF["taskType"]))
    output = f.get(AF["agentOutput"], "") or ""

    # Kevin's yes is the only way in (Kevin, 18 Oct 2026). From 7 Sep to 18 Oct a
    # diary entry was written at submit with no card (Level A, the --handled flag);
    # that path is gone, so a task carrying the old HANDLED marker is refused here
    # like any other unapproved task.
    if outcome not in APPROVED:
        sys.exit(
            f"REFUSED: task {task_id} ({name}) is not approved.\n"
            f"         Approval Outcome = {outcome or '(empty)'}.\n"
            "         Nothing reaches the diary until Kevin approves the card.")
    # The approval string alone is not an approval (finding 20260922-agent-dispatch-572, extended
    # here 24 Sep 2026): a Kevin-approved entry must carry the marks a real approval leaves.
    evidence = approval_evidence_problem(f, rec.get("createdTime", ""))
    if evidence:
        sys.exit(
            f"REFUSED: task {task_id} ({name}) reads {outcome!r}, but {evidence}.\n"
            "         Only an approval Kevin gives in an approval surface (the dashboard\n"
            "         queue, the Tasks drawer or Slack) reaches the diary.")
    if ttype != "Admin":
        sys.exit(f"REFUSED: task {task_id} is Task Type {ttype or '(empty)'}, "
                 "not Admin. Calendar entries submit as Admin.")
    if not output.strip():
        sys.exit(f"ERROR: task {task_id} has an empty Agent Output")

    try:
        event = parse_calendar(output)
    except CalendarFormatError as exc:
        sys.exit(f"ERROR: task {task_id} {exc}. "
                 "See the format in scripts/agent_calendar_format.py.")

    # REPLACES / CANCELS (Kevin, 18 Oct 2026): the entry to move or remove is found in this
    # script's own ledger, never by searching the diary, so an entry Kevin or Gmail made is
    # never touched. Checked before anything is written.
    ref = event.get("cancels") or event.get("replaces") or ""
    event_id = ""
    if ref:
        if ref == task_id:
            sys.exit(f"REFUSED: task {task_id} names itself as the entry to change.")
        event_id, problem = written_entry(ref, LEDGER)
        if problem:
            sys.exit(f"REFUSED: task {task_id} — {problem}.")
        created_by = entry_creator(event_id, LEDGER)
        if not created_by:
            sys.exit(f"REFUSED: task {task_id} — the ledger has no created row for entry {event_id}, "
                     "so the robot cannot prove it made it.")

    if not event.get("cancels"):
        stale = past_problem(event)
        if stale:
            sys.exit(f"REFUSED: task {task_id} — {stale}")

    # Read RAW, never through the lenient reader (18 Oct 2026, review): a half-written or
    # run-together line naming this task must still refuse, or a crashed write runs twice.
    if os.path.exists(LEDGER):
        with open(LEDGER) as fh:
            seen = [ln.strip() for ln in fh if task_id in ln]
        if seen:
            sys.exit(
                f"REFUSED: task {task_id} is already in the ledger ({seen[-1][:160]}). "
                "A second write would duplicate or repeat the change; if the first "
                "attempt crashed, check the calendar and the ledger by hand.")

    if event.get("cancels"):
        ledger_append({"task": task_id, "ts": now_iso(), "event": "intent",
                       "action": "delete", "id": event_id, "from": ref})
        result = worker_call(DELETE_URL, {"account": CALENDAR_ACCOUNT, "eventId": event_id,
                                          "createdBy": created_by})
        ledger_append({"task": task_id, "ts": now_iso(), "event": "deleted",
                       "id": event_id, "from": ref})
        print(json.dumps({"task": task_id, "taskName": name, "removed": event_id,
                          "from": ref, **result}, indent=2))
        return
    if event_id:
        ledger_append({"task": task_id, "ts": now_iso(), "event": "intent", "action": "move",
                       "id": event_id, "from": ref, "title": event["title"],
                       "start": event["start"]})
        result = worker_call(UPDATE_URL, {
            "account": CALENDAR_ACCOUNT,
            "eventId": event_id,
            "createdBy": created_by,
            "title": event["title"],
            "start": event["start"],
            "end": event["end"],
            "timeZone": event["timeZone"],
            "location": event["location"] or None,
        })
        ledger_append({"task": task_id, "ts": now_iso(), "event": "moved", "id": event_id,
                       "from": ref, "htmlLink": result.get("htmlLink", "")})
        print(json.dumps({"task": task_id, "taskName": name, "moved": event_id,
                          "from": ref, **result}, indent=2))
        return

    ledger_append({"task": task_id, "ts": now_iso(), "event": "intent",
                   "title": event["title"], "start": event["start"]})

    result = worker_call(CREATE_URL, {
        "account": CALENDAR_ACCOUNT,
        "task": task_id,          # the worker stamps the entry with it (odTask)
        "title": event["title"],
        "start": event["start"],
        "end": event["end"],
        "timeZone": event["timeZone"],
        "location": event["location"] or None,
        "description": event["notes"] or event["summary"],
    })

    ledger_append({"task": task_id, "ts": now_iso(), "event": "created",
                   "id": result.get("id", ""),
                   "htmlLink": result.get("htmlLink", "")})
    print(json.dumps({"task": task_id, "taskName": name, **result}, indent=2))


def cmd_test(args):
    print(json.dumps(worker_call(HEALTH_URL), indent=2))


def cmd_selftest(args):
    failures = []

    def check(label, ok):
        print(("  ok " if ok else "FAIL ") + label)
        if not ok:
            failures.append(label)

    def refuses(label, output):
        try:
            parse_calendar(output)
            check(label, False)
        except CalendarFormatError:
            check(label, True)

    good = ("CALENDAR:\nTITLE: Aviva renewal call\n"
            "START: 2099-09-10 14:00\nEND: 2099-09-10 14:30\n"
            "LOCATION: Zoom\n---\nRenewal call for the HMO policy.\n"
            "**Carrying this out will involve:** the entry lands in the diary.")
    try:
        ev = parse_calendar(good)
        check("parses the documented shape", ev["title"] == "Aviva renewal call"
              and ev["start"] == "2099-09-10T14:00:00"
              and ev["timeZone"] == TIMEZONE
              and "diary" not in ev["summary"])
    except CalendarFormatError as exc:
        check(f"parses the documented shape ({exc})", False)

    refuses("refuses missing END",
            "CALENDAR:\nTITLE: x\nSTART: 2099-09-10 14:00\n---\nsummary")
    refuses("refuses END before START",
            "CALENDAR:\nTITLE: x\nSTART: 2099-09-10 14:00\n"
            "END: 2099-09-10 13:00\n---\nsummary")
    refuses("refuses attendees",
            "CALENDAR:\nTITLE: x\nSTART: 2099-09-10 14:00\n"
            "END: 2099-09-10 15:00\nATTENDEES: a@b.com\n---\nsummary")
    refuses("refuses a missing summary",
            "CALENDAR:\nTITLE: x\nSTART: 2099-09-10 14:00\n"
            "END: 2099-09-10 15:00\n---\n")
    refuses("refuses a bad time format",
            "CALENDAR:\nTITLE: x\nSTART: tomorrow 2pm\n"
            "END: 2099-09-10 15:00\n---\nsummary")

    ev = parse_calendar(good)
    check("refuses a past START",
          past_problem(ev, now_london=datetime(2099, 9, 11, 9, 0)) != "")
    check("allows a future START",
          past_problem(ev, now_london=datetime(2099, 9, 10, 13, 0)) == "")
    check("grace covers a queue wait",
          past_problem(ev, now_london=datetime(2099, 9, 10, 14, 30)) == "")

    if failures:
        sys.exit(f"SELFTEST FAILED: {len(failures)} check(s)")
    print("selftest passed")


def main(argv):
    import argparse
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create", help="create the approved entry for a task")
    c.add_argument("task")
    c.set_defaults(fn=cmd_create)
    t = sub.add_parser("test", help="worker + consent health")
    t.set_defaults(fn=cmd_test)
    s = sub.add_parser("selftest", help="offline contract checks")
    s.set_defaults(fn=cmd_selftest)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main(sys.argv[1:])
