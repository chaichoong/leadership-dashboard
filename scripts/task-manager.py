#!/usr/bin/env python3
"""Task Manager agent — deterministic half.

The Task Manager is the foreman of the task board: three slots a day it reads
every open task, decides which ones stopped moving, and forces ONE move on each
stuck one (finish / chase / close / escalate). This script is the part with no
judgement in it: the board read, the movement maths, the score, the daily log,
and the verify control. The judgement lives in the slot skill
(~/.claude/scheduled-tasks/task-manager-board/SKILL.md), and every Airtable
WRITE to a task goes through scripts/agent-dispatch.py so there is exactly one
writing muscle (route / handover / escalate / submit / annotate / complete).

Movement is measured ONLY from stamps nothing re-writes on a schedule:
  - Task Activity rows (tbl2ZTHBDBPo681UL, web-app edits; At + TaskId)
  - Approved At (written only on a human decision)
  - Approval Slack TS (written once when the approval card posts)
  - Created Time (the floor — a task younger than the window is never stuck)
NEVER Due Date (the rescheduler re-stamps it daily) and NEVER Last Modified
Time (any automation touching any field re-stamps it). Both have burned this
platform before — see loop-health and its tests.

Commands:
  board                      read the board, print the JSON worklist
  note --task R --move M --reason S   append one decision to today's digest
  score --stuck N --open M --kevin K  write Metric Score to the register row
  publish                    upsert today's decisions to AI Agent Daily Log
  verify --report PATH       loud control over a slot run's report
  selftest                   offline checks of the pure helpers
"""

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BASE = "appnqjDpqDniH3IRl"
TASKS_TABLE = "tblqB8b22hKBL4PF1"
ACTIVITY_TABLE = "tbl2ZTHBDBPo681UL"
AGENTS_TABLE = "tbl9msVjyQWslLOIZ"
DAILY_LOG_TABLE = "tbl6VQKVMnK0Q7hbJ"

AGENT_NAME = "Task Manager"
TASKMGR_REGISTER_ROW = "reczg8BygPFnJMQnh"   # AI Agents register
TASKMGR_TEAM_REC = "rec1hYELb4zS8pjjO"       # Team Members "AI Task Manager"
METRIC_SCORE_FIELD = "fldkGxrOlrfuLlH3J"
KEVIN_REC = "recHEt2VPYothaqTd"
KEVIN_EMAIL = "kevin@runpreneur.org.uk"
ROY_REC = "reclbdjfVev3bqNHS"
ROY_EMAIL = "roy.lavin1978@gmail.com"

# AI Agent Daily Log fields (same map as inbound-triage.py)
ALOG = {
    "logDay":    "fldNLubsilKUL6fyd",
    "date":      "fldr9ktRlG8e93AMN",
    "agent":     "fld8OSVSzfXcDjDIl",
    "summary":   "fld0vrdlfSiZjR6wg",
    "decisions": "fldTwM2eJvNyUibi4",
}

STUCK_DAYS = 7
# Statuses that make a task part of the live board. Blank-status legacy rows
# and Completed are out; Some Day (checkbox) is parked, not stuck.
OPEN_STATUSES = ("Today", "Upcoming", "Overdue", "Approval")

DECISION_GROUPS = [
    ("finish",   "Finished or handed to the right doer"),
    ("chase",    "Chase raised (through the approval gate)"),
    ("close",    "Close proposed (Kevin confirms)"),
    ("escalate", "Escalated to Kevin: one clear ask"),
    ("roy",      "Passed to Roy (maintenance / property legwork)"),
    ("leave",    "Left alone on purpose (moving or genuinely waiting)"),
]
DECISIONS_CHAR_CAP = 90000


def fail(msg):
    print("TASK-MANAGER BROKEN: %s" % msg, file=sys.stderr)
    sys.exit(1)


def base_dir():
    return Path(os.environ.get("TASK_MANAGER_DIR")
                or (Path.home() / "knowledge-os/logs/task-manager"))


def pat():
    p = Path.home() / ".config/od/airtable_pat"
    if not p.exists():
        fail("Airtable PAT missing at %s" % p)
    return p.read_text().strip()


def airtable_request(method, path, body, why):
    url = "https://api.airtable.com/v0/%s/%s" % (BASE, path)
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + pat(),
                 "Content-Type": "application/json"},
        method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except Exception as e:  # noqa: BLE001 — every failure here must be loud
        fail("%s failed: %s" % (why, e))


def query_all(table, formula, fields, why):
    """Paginated read — a hand-rolled single-page fetch is how the recon
    accuracy card silently measured 100 of 259 rows. Always follow offset."""
    records, offset = [], None
    while True:
        params = [("pageSize", "100"), ("filterByFormula", formula)]
        params += [("fields[]", f) for f in fields]
        if offset:
            params.append(("offset", offset))
        out = airtable_request(
            "GET", "%s?%s" % (table, urllib.parse.urlencode(params)), None, why)
        records += out.get("records", [])
        offset = out.get("offset")
        if not offset:
            return records


# ---------------------------------------------------------------------------
# Pure helpers (covered by selftest)
# ---------------------------------------------------------------------------

def parse_iso(ts):
    """Airtable ISO timestamp → aware datetime, or None."""
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_slack_ts(ts):
    """Slack message ts ("1723456789.123456") → aware datetime, or None."""
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def last_movement(f, activity_ids, now=None):
    """The honest 'when did this task last move' for one task's fields.
    Returns (dt, source). Task Activity presence counts as movement NOW —
    the set holds only tasks with a row inside the window."""
    now = now or datetime.now(timezone.utc)
    if f.get("_id") in activity_ids:
        return now, "activity"
    candidates = [
        (parse_iso(f.get("Approved At")), "approvedAt"),
        (parse_slack_ts(f.get("Approval Slack TS")), "slackTs"),
        (parse_iso(f.get("Created Time")), "created"),
    ]
    best, src = None, "none"
    for dt, name in candidates:
        if dt and (best is None or dt > best):
            best, src = dt, name
    return best, src


def classify(f, activity_ids, now=None):
    """One task's bucket: parked | waitingOnKevin | stuck | moving."""
    now = now or datetime.now(timezone.utc)
    if f.get("Some Day"):
        return "parked", None
    # Only a task the approval loop itself raised counts as Kevin's queue —
    # legacy rows parked at Status Approval since before the loop existed
    # (22 of them found 4 Aug 2026, 80+ by late Aug) are stuck work wearing
    # an Approval badge, and counting them as "with Kevin" hides them forever.
    if (f.get("Status") == "Approval" and not f.get("Approval Outcome")
            and f.get("Sent For Approval By")):
        return "waitingOnKevin", None
    moved, src = last_movement(f, activity_ids, now)
    if moved is None:
        # No stamp at all should be impossible (Created Time is automatic);
        # treat as stuck so it surfaces rather than hides.
        return "stuck", "no-stamp"
    if (now - moved) >= timedelta(days=STUCK_DAYS):
        return "stuck", src
    return "moving", src


def metric_text(stuck, open_total, kevin):
    return "%d stuck (target 0); %d open; %d with Kevin" % (stuck, open_total, kevin)


def trim_history(history, keep_days=30, today=None):
    d = today or date.today()
    cutoff = (d - timedelta(days=keep_days)).isoformat()
    return {k: v for k, v in history.items() if k >= cutoff}


def format_daily_log(rows):
    """(summary_line, decisions_text). Unknown move kinds are appended, never
    dropped — a new action type must not vanish from the log."""
    by = {}
    for r in rows:
        by.setdefault(r.get("move", "?"), []).append(r)
    known = [k for k, _ in DECISION_GROUPS]
    ordered = list(DECISION_GROUPS) + [(k, k) for k in by if k not in known]
    counts, blocks = [], []
    for key, label in ordered:
        items = by.get(key, [])
        if not items:
            continue
        counts.append("%d %s" % (len(items), key))
        lines = ["== %s (%d) ==" % (label, len(items))]
        for r in items:
            t = (r.get("ts") or "")[11:16]
            lines.append("%s  %s" % (t, (r.get("name") or r.get("task") or "?").strip()))
            if r.get("reason"):
                lines.append("       why: %s" % r["reason"])
        blocks.append("\n".join(lines))
    text = "\n\n".join(blocks)
    if len(text) > DECISIONS_CHAR_CAP:
        text = text[:DECISIONS_CHAR_CAP] + "\n\n[truncated]"
    return ", ".join(counts) or "no decisions", text


# ---------------------------------------------------------------------------
# State + digest
# ---------------------------------------------------------------------------

def read_state():
    p = base_dir() / "state.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except (ValueError, OSError) as e:
        fail("state file unreadable at %s: %s" % (p, e))


def write_state(state):
    d = base_dir()
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "state.json.tmp"
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True))
    tmp.rename(d / "state.json")


def digest_path():
    return base_dir() / ("digest-%s.jsonl" % date.today().isoformat())


def digest_append(entry):
    d = base_dir()
    d.mkdir(parents=True, exist_ok=True)
    entry = dict(entry, ts=datetime.now().isoformat(timespec="seconds"))
    with open(digest_path(), "a") as fh:
        fh.write(json.dumps(entry) + "\n")


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

TASK_FIELDS = [
    "Task Name", "Status", "Due Date", "Created Time", "Approved At",
    "Approval Slack TS", "Approval Outcome", "Team Member", "Assignee",
    "Sent For Approval By", "Some Day", "Maintenance Ticket", "Task Type",
    "Hard Deadline", "Contractor",
]


def cmd_board():
    formula = "OR(%s)" % ",".join("{Status}='%s'" % s for s in OPEN_STATUSES)
    recs = query_all(TASKS_TABLE, formula, TASK_FIELDS, "board read")
    if not recs:
        fail("board read returned ZERO open tasks — with ~200+ live tasks that "
             "is a broken read, not an empty board")
    # Field-name drift control: Created Time is stamped by Airtable itself on
    # every record, so a single missing value means the read is lying.
    missing = [r["id"] for r in recs if not r["fields"].get("Created Time")]
    if missing:
        fail("Created Time missing on %d records (e.g. %s) — field names have "
             "drifted, do not trust this read" % (len(missing), missing[0]))

    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=STUCK_DAYS)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    activity = query_all(
        ACTIVITY_TABLE,
        "IS_AFTER({At}, DATETIME_PARSE('%s'))" % cutoff,
        ["TaskId", "At"], "activity read")
    activity_ids = {a["fields"].get("TaskId") for a in activity
                    if a["fields"].get("TaskId")}

    buckets = {"stuck": [], "waitingOnKevin": [], "parked": [], "moving": []}
    by_status, kevin_count = {}, 0
    for r in recs:
        f = dict(r["fields"], _id=r["id"])
        by_status[f.get("Status", "?")] = by_status.get(f.get("Status", "?"), 0) + 1
        assignee = (f.get("Assignee") or {}).get("email", "")
        team = f.get("Team Member") or []
        is_kevin = assignee == KEVIN_EMAIL or KEVIN_REC in team
        if is_kevin:
            kevin_count += 1
        bucket, src = classify(f, activity_ids, now)
        moved, _ = last_movement(f, activity_ids, now)
        view = {
            "id": r["id"],
            "name": f.get("Task Name", ""),
            "status": f.get("Status"),
            "dueDate": f.get("Due Date"),
            "taskType": f.get("Task Type"),
            "teamMember": team,
            "assigneeEmail": assignee,
            "sentForApprovalBy": f.get("Sent For Approval By") or [],
            "maintenanceTicket": bool(f.get("Maintenance Ticket")),
            "hardDeadline": bool(f.get("Hard Deadline")),
            "kevinOwned": is_kevin,
            "lastMoved": moved.isoformat() if moved else None,
            "daysStill": round((now - moved).days, 1) if moved else None,
            "movementSource": src,
        }
        buckets[bucket].append(view)

    for k in buckets:
        buckets[k].sort(key=lambda v: (v["lastMoved"] or ""))
    out = {
        "generatedAt": now.isoformat(),
        "stuckDays": STUCK_DAYS,
        "counts": {
            "openTasksRead": len(recs),
            "activityRowsRead": len(activity),
            "byStatus": by_status,
            "kevinOwned": kevin_count,
            "stuck": len(buckets["stuck"]),
            "waitingOnKevin": len(buckets["waitingOnKevin"]),
            "parked": len(buckets["parked"]),
            "moving": len(buckets["moving"]),
        },
        "stuck": buckets["stuck"],
        "waitingOnKevin": buckets["waitingOnKevin"],
        "parked": [v["id"] for v in buckets["parked"]],
    }
    print(json.dumps(out, indent=1))


def cmd_note(task, move, reason, name=""):
    digest_append({"task": task, "move": move, "reason": reason, "name": name})
    print(json.dumps({"noted": task, "move": move}))


def cmd_score(stuck, open_total, kevin):
    state = read_state()
    history = state.get("history", {})
    today = date.today().isoformat()
    history[today] = int(stuck)
    state["history"] = trim_history(history)
    write_state(state)
    text = metric_text(int(stuck), int(open_total), int(kevin))
    airtable_request(
        "PATCH", "%s/%s" % (AGENTS_TABLE, TASKMGR_REGISTER_ROW),
        {"fields": {METRIC_SCORE_FIELD: text}}, "metric score write")
    print(json.dumps({"metric_score": text, "written_to_register": True}))


def cmd_publish():
    today = date.today().isoformat()
    src = digest_path()
    if not src.exists():
        fail("no digest for today at %s — nothing ran, nothing to publish" % src)
    rows = [json.loads(l) for l in src.read_text().splitlines() if l.strip()]
    if not rows:
        fail("today's digest is empty — refusing to publish a blank day")
    summary, decisions = format_daily_log(rows)
    log_day = "%s - %s" % (AGENT_NAME, today)
    fields = {
        ALOG["logDay"]: log_day,
        ALOG["date"]: today,
        ALOG["agent"]: [TASKMGR_REGISTER_ROW],
        ALOG["summary"]: summary,
        ALOG["decisions"]: decisions,
    }
    found = airtable_request(
        "GET", "%s?filterByFormula=%s&maxRecords=2" % (
            DAILY_LOG_TABLE,
            urllib.parse.quote("{Log Day}='%s'" % log_day.replace("'", "\\'"))),
        None, "daily log lookup")
    recs = found.get("records", [])
    if recs:
        airtable_request("PATCH", "%s/%s" % (DAILY_LOG_TABLE, recs[0]["id"]),
                         {"fields": fields, "typecast": True}, "daily log update")
        action = "updated"
    else:
        airtable_request("POST", DAILY_LOG_TABLE,
                         {"records": [{"fields": fields}], "typecast": True},
                         "daily log create")
        action = "created"
    print(json.dumps({"published": action, "log_day": log_day,
                      "decisions": len(rows), "summary": summary}))


def cmd_verify(report_path):
    """Loud control over one slot run. A run that read nothing, claimed writes
    that did not land, or skipped its score is a FAILED run, whatever it says."""
    problems = []
    try:
        report = json.loads(Path(report_path).read_text())
    except (OSError, ValueError) as e:
        fail("report unreadable (%s) — the run was blind" % e)

    board = report.get("board") or {}
    if not isinstance(board.get("openTasksRead"), int) or board["openTasksRead"] <= 0:
        problems.append("report carries no positive openTasksRead — board never read")
    stuck = board.get("stuck")
    actions = report.get("actions") or []
    ok_actions = [a for a in actions if a.get("ok")]
    if isinstance(stuck, int) and stuck > 0 and not actions:
        problems.append("%d stuck tasks but zero actions recorded" % stuck)
    for a in actions:
        if not a.get("ok"):
            problems.append("failed action on %s: %s" % (a.get("task"), a.get("error")))

    # Spot-verify claimed writes against the live table (up to 12).
    checked = 0
    for a in ok_actions:
        if checked >= 12:
            break
        move, task_id = a.get("move"), a.get("task")
        if not task_id or move not in ("route", "roy", "escalate", "close", "chase", "finish"):
            continue
        rec = airtable_request("GET", "%s/%s" % (TASKS_TABLE, task_id), None,
                               "verify read %s" % task_id)
        f = rec.get("fields", {})
        team = f.get("Team Member") or []
        checked += 1
        if move == "roy" and ROY_REC not in team:
            problems.append("claimed pass-to-Roy on %s but Roy is not on it" % task_id)
        elif move == "escalate" and KEVIN_REC not in team:
            problems.append("claimed escalate on %s but Kevin is not on it" % task_id)
        elif move == "route" and a.get("to") and a["to"] not in team:
            problems.append("claimed route of %s to %s but the link is absent"
                            % (task_id, a["to"]))
        elif move in ("close", "chase") and f.get("Status") not in ("Approval", "Completed"):
            problems.append("claimed %s on %s but status is %s (never reached "
                            "the gate)" % (move, task_id, f.get("Status")))

    if not report.get("scoreWritten"):
        problems.append("score not written — the register reading silently froze")
    state = read_state()
    if date.today().isoformat() not in state.get("history", {}):
        problems.append("no score history entry for today — score claim is false")

    if problems:
        for p in problems:
            print("TASK-MANAGER VERIFY FAIL: %s" % p, file=sys.stderr)
        sys.exit(1)
    print(json.dumps({"verified": True, "actionsChecked": checked,
                      "actions": len(actions)}))


def cmd_selftest():
    import tempfile
    now = datetime(2026, 8, 25, 12, 0, tzinfo=timezone.utc)
    old = "2026-08-01T09:00:00.000Z"
    fresh = "2026-08-24T09:00:00.000Z"
    # movement: activity beats stamps
    dt, src = last_movement({"_id": "recX", "Created Time": old}, {"recX"}, now)
    assert src == "activity"
    # stale created only → stuck
    b, _ = classify({"_id": "recY", "Created Time": old}, set(), now)
    assert b == "stuck", b
    # fresh approval stamp → moving
    b, _ = classify({"_id": "recZ", "Created Time": old, "Approved At": fresh}, set(), now)
    assert b == "moving", b
    # slack ts counts as a stamp
    ts = str((now - timedelta(days=2)).timestamp())
    b, _ = classify({"_id": "recS", "Created Time": old, "Approval Slack TS": ts}, set(), now)
    assert b == "moving", b
    # approval waiting beats stuck — but ONLY for loop-raised tasks
    b, _ = classify({"_id": "recA", "Created Time": old, "Status": "Approval",
                     "Sent For Approval By": ["recAgent1"]}, set(), now)
    assert b == "waitingOnKevin", b
    # legacy Approval row (no Sent For Approval By) is stuck, not Kevin's queue
    b, _ = classify({"_id": "recL", "Created Time": old, "Status": "Approval"}, set(), now)
    assert b == "stuck", b
    # decided approval (outcome set) is NOT waiting — falls through to movement
    b, _ = classify({"_id": "recB", "Created Time": old, "Status": "Approval",
                     "Approval Outcome": "Approved as-is"}, set(), now)
    assert b == "stuck", b
    # some day parks
    b, _ = classify({"_id": "recP", "Created Time": old, "Some Day": True}, set(), now)
    assert b == "parked", b
    assert metric_text(3, 210, 12) == "3 stuck (target 0); 210 open; 12 with Kevin"
    s, t = format_daily_log([
        {"move": "finish", "name": "A", "reason": "small admin", "ts": "2026-08-25T09:10:00"},
        {"move": "newkind", "name": "B", "ts": "2026-08-25T09:11:00"}])
    assert "1 finish" in s and "newkind" in s and "A" in t and "B" in t
    h = trim_history({"2026-07-01": 5, "2026-08-20": 2}, today=date(2026, 8, 25))
    assert "2026-07-01" not in h and "2026-08-20" in h
    with tempfile.TemporaryDirectory() as td:
        os.environ["TASK_MANAGER_DIR"] = td
        digest_append({"task": "recT", "move": "leave", "reason": "moving"})
        rows = [json.loads(l) for l in digest_path().read_text().splitlines()]
        assert rows[0]["move"] == "leave"
        write_state({"history": {"2026-08-25": 1}})
        assert read_state()["history"]["2026-08-25"] == 1
        del os.environ["TASK_MANAGER_DIR"]
    print("selftest OK")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("board")
    n = sub.add_parser("note")
    n.add_argument("--task", required=True)
    n.add_argument("--move", required=True,
                   choices=[k for k, _ in DECISION_GROUPS])
    n.add_argument("--reason", required=True)
    n.add_argument("--name", default="")
    s = sub.add_parser("score")
    s.add_argument("--stuck", required=True, type=int)
    s.add_argument("--open", required=True, type=int, dest="open_total")
    s.add_argument("--kevin", required=True, type=int)
    sub.add_parser("publish")
    v = sub.add_parser("verify")
    v.add_argument("--report", required=True)
    sub.add_parser("selftest")
    a = ap.parse_args()
    if a.cmd == "board":
        cmd_board()
    elif a.cmd == "note":
        cmd_note(a.task, a.move, a.reason, a.name)
    elif a.cmd == "score":
        cmd_score(a.stuck, a.open_total, a.kevin)
    elif a.cmd == "publish":
        cmd_publish()
    elif a.cmd == "verify":
        cmd_verify(a.report)
    elif a.cmd == "selftest":
        cmd_selftest()


if __name__ == "__main__":
    main()
