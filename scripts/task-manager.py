#!/usr/bin/env python3
"""Task Manager agent — deterministic half.

The Task Manager is the foreman of the task board: three slots a day it reads
every open task, decides which ones stopped moving, and forces ONE move on each
stuck one (finish / route / chase / close / escalate). This script is the part
with no judgement in it: the board read, the movement maths, the score, the
daily log, and the verify control. The judgement lives in the slot skill
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
  board [--dispatch-queue PATH]  read the board, print the JSON worklist
  note --task R --move M --reason S   append one decision to today's digest
  score --stuck N --open M --kevin K  write Metric Score to the register row
  publish                    upsert today's decisions to AI Agent Daily Log
  verify --report PATH       loud control over a slot run's report
  selftest                   offline checks of the pure helpers
"""

import argparse
import json
import os
import sys
import time
import urllib.error
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

# AI Agent Daily Log fields (same map as inbound-triage.py; drift-tested
# against it in tests/task-manager.test.js)
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
    ("finish",   "Finished in-house (through the approval gate)"),
    ("route",    "Routed to the right doer"),
    ("chase",    "Chase raised (routed with a nudge note)"),
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
    """One request with the failure modes this platform has actually hit:
    a 429/5xx gets ONE retry after a pause (a slot run makes 50+ calls on a
    base shared with daily-ops, so a transient throttle must not turn a
    healthy run into a failed one); an HTTP error surfaces Airtable's body,
    because "422 Unprocessable Entity" without the field name it names has
    cost hours of diagnosis before."""
    url = "https://api.airtable.com/v0/%s/%s" % (BASE, path)
    last_err = None
    for attempt in (1, 2):
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": "Bearer " + pat(),
                     "Content-Type": "application/json"},
            method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:300]
            except OSError:
                pass
            last_err = "HTTP %s on %s: %s" % (e.code, why, detail or e.reason)
            if e.code == 429 or e.code >= 500:
                if attempt == 1:
                    time.sleep(int(e.headers.get("Retry-After") or 20))
                    continue
            break
        except Exception as e:  # noqa: BLE001 — every failure here must be loud
            last_err = "%s: %s" % (type(e).__name__, e)
            if attempt == 1:
                time.sleep(5)
                continue
    fail("%s failed: %s" % (why, last_err))


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
    """One task's bucket: parked | waitingOnKevin | stuck | moving.
    Returns (bucket, source, moved_dt) so the caller never recomputes."""
    now = now or datetime.now(timezone.utc)
    moved, src = last_movement(f, activity_ids, now)
    if f.get("Some Day"):
        return "parked", src, moved
    # Only a task the approval loop itself raised counts as Kevin's queue —
    # legacy rows parked at Status Approval since before the loop existed
    # (22 of them found 4 Aug 2026, 80+ by late Aug) are stuck work wearing
    # an Approval badge, and counting them as "with Kevin" hides them forever.
    if (f.get("Status") == "Approval" and not f.get("Approval Outcome")
            and f.get("Sent For Approval By")):
        return "waitingOnKevin", src, moved
    if moved is None:
        # No stamp at all should be impossible (Created Time is automatic);
        # treat as stuck so it surfaces rather than hides.
        return "stuck", "no-stamp", None
    if (now - moved) >= timedelta(days=STUCK_DAYS):
        return "stuck", src, moved
    return "moving", src, moved


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
        text = text[:DECISIONS_CHAR_CAP] + (
            "\n\n[truncated at %d characters; the complete raw log is on the "
            "Mac at ~/knowledge-os/logs/task-manager/]" % DECISIONS_CHAR_CAP)
    return ", ".join(counts) or "no decisions", text


def in_flight_ids(queue_json):
    """Task ids dispatch already owns this slot: worklist + reserve."""
    ids = set()
    for key in ("worklist", "reserve"):
        for t in queue_json.get(key) or []:
            if isinstance(t, dict) and t.get("id"):
                ids.add(t["id"])
    return ids


def thread_keys(url_field):
    """Every Gmail thread id in an Inbound Note URL Link. The field can hold
    SEVERAL space-separated URLs after a subject-gate fold, in either form
    (#all/ current, #inbox/ legacy) — a folded task must still meet its twin
    on any of its threads. One OPEN task per thread and lane is the board's
    no-duplicates invariant (Kevin, 25 Aug 2026)."""
    keys = []
    for part in (url_field or "").split():
        for marker in ("#all/", "#inbox/"):
            i = part.find(marker)
            if i >= 0:
                tid = part[i + len(marker):].split("?")[0].split("&")[0].strip("/ ")
                if tid and tid not in keys:
                    keys.append(tid)
                break
    return keys


def duplicate_groups(views):
    """Open tasks sharing one thread AND one lane:
    [{thread, lane, keeper, closable, untouchable, names}].

    - keeper: the oldest task overall — the one everything folds into.
    - closable: every other task NOT at Status Approval (safe to
      close-propose).
    - untouchable: twins at Status Approval — a close proposal would
      overwrite the Agent Output already waiting on Kevin; report only.
    A reply task and a Roy maintenance task on the same thread are
    legitimately TWO tasks, so the lane is part of the key. A folded task can
    appear in more than one group. Callers pass only actionable views
    (never parked or dispatch-in-flight)."""
    by = {}
    for v in views:
        lane = ("maintenance"
                if (v.get("name", "").startswith("MAINTENANCE:")
                    or ROY_REC in (v.get("teamMember") or []))
                else "reply")
        for k in thread_keys(v.get("inboundUrl")):
            by.setdefault((k, lane), []).append(v)
    out = []
    for (k, lane), vs in by.items():
        if len(vs) > 1:
            vs = sorted(vs, key=lambda v: v.get("createdTime") or "")
            keeper = vs[0]
            out.append({
                "thread": k, "lane": lane,
                "keeper": keeper["id"],
                "closable": [v["id"] for v in vs[1:]
                             if v.get("status") != "Approval"],
                "untouchable": [v["id"] for v in vs
                                if v.get("status") == "Approval"],
                "names": [v["name"] for v in vs],
            })
    return sorted(out, key=lambda g: (g["thread"], g["lane"]))


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


def median_hours(values):
    """Median of a list of hour counts, or None on an empty lane."""
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    mid = len(vals) // 2
    if len(vals) % 2:
        return round(vals[mid], 1)
    return round((vals[mid - 1] + vals[mid]) / 2, 1)


def hours_waiting(f, now=None):
    """Hours since this task reached Kevin: Approval Slack TS (the moment the
    card was posted) with Created Time as the honest fallback. None when
    neither stamp exists. Shared by the board's waitingOnKevin views and the
    gate lane, so the two never disagree about the same task."""
    now = now or datetime.now(timezone.utc)
    sent = (parse_slack_ts(f.get("Approval Slack TS"))
            or parse_iso(f.get("Created Time")))
    return round((now - sent).total_seconds() / 3600, 1) if sent else None


def task_view(rec, activity_ids, dispatch_ids, now):
    """One board record → (bucket, view). Pulled out of cmd_board so the view
    shape is testable without a live read. The 1 Sep 2026 13:00 report showed
    every waiting-on-Kevin item as 0 hours because the view carried no
    hoursWaiting at all and the skill assumed it did."""
    f = dict(rec["fields"], _id=rec["id"])
    assignee = (f.get("Assignee") or {}).get("email", "")
    team = f.get("Team Member") or []
    is_kevin = assignee == KEVIN_EMAIL or KEVIN_REC in team
    bucket, src, moved = classify(f, activity_ids, now)
    # A stuck task dispatch already holds this slot is not the foreman's
    # to touch — set-subtract in code, never by eyeballing two JSON files.
    if bucket == "stuck" and rec["id"] in dispatch_ids:
        bucket = "inFlight"
    view = {
        "id": rec["id"],
        "name": f.get("Task Name", ""),
        "status": f.get("Status"),
        "priority": f.get("Priority"),
        "dueDate": f.get("Due Date"),
        "taskType": f.get("Task Type"),
        "teamMember": team,
        "assigneeEmail": assignee,
        "sentForApprovalBy": f.get("Sent For Approval By") or [],
        "maintenanceTicket": bool(f.get("Maintenance Ticket")),
        "hardDeadline": bool(f.get("Hard Deadline")),
        "kevinOwned": is_kevin,
        "inboundUrl": f.get("Inbound Note URL Link"),
        "createdTime": f.get("Created Time"),
        "lastMoved": moved.isoformat() if moved else None,
        "daysStill": (round((now - moved).total_seconds() / 86400, 1)
                      if moved else None),
        "hoursWaiting": hours_waiting(f, now),
        "movementSource": src,
    }
    return bucket, is_kevin, view


def lane_view(f, now=None):
    """One approvals-lane row → the view the cleanse and priority review judge.

    Age anchors on Approval Slack TS (the moment the card reached Kevin) with
    Created Time as the honest fallback — never the approval decision stamp,
    and never the due or last-modified stamps (both re-stamped by
    automations). The Agent Output is excerpted, not dumped: 600 characters is
    enough to judge stale/overtaken/duplicate without hauling every full
    draft through the run, and the tier-1 banner sits at the top when present."""
    now = now or datetime.now(timezone.utc)
    output = (f.get("Agent Output") or "").strip()
    return {
        "id": f.get("_id"),
        "name": f.get("Task Name", ""),
        "submittedBy": f.get("Sent For Approval By") or [],
        "approverEmail": (f.get("Approver") or {}).get("email", ""),
        "priority": f.get("Priority"),
        "hoursWaiting": hours_waiting(f, now),
        "createdTime": f.get("Created Time"),
        "inboundUrl": f.get("Inbound Note URL Link"),
        "outputExcerpt": output[:600] + ("…" if len(output) > 600 else ""),
    }


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

TASK_FIELDS = [
    "Task Name", "Status", "Due Date", "Created Time", "Approved At",
    "Approval Slack TS", "Approval Outcome", "Team Member", "Assignee",
    "Sent For Approval By", "Some Day", "Maintenance Ticket", "Task Type",
    "Hard Deadline", "Inbound Note URL Link", "Priority",
]
# Field-name drift control: each of these appears on at least one record of
# any real board. If one vanishes from the WHOLE read, the name has drifted
# and every downstream judgement would silently degrade. (Sparse checkboxes —
# Some Day, Maintenance Ticket, Hard Deadline — are excluded: Airtable omits
# false checkboxes, so absence is normal for them.)
CONTROL_FIELDS = [
    "Task Name", "Status", "Created Time", "Team Member", "Assignee",
    "Due Date",
]
# The approval-lane stamps are TRANSIENT: a clean board (nothing waiting,
# every hand-back carried out) legitimately holds none of them, so requiring
# each one per-read false-positives the whole slot — the agent's own first
# live run filed exactly this (finding 20260825-task-manager-board-365).
# Their rename detection keys on the population instead: a board with a real
# Approval queue but NOT ONE of these fields anywhere is a drifted read. A
# single-field rename is still caught loudly at write time (dispatch 422s).
APPROVAL_STAMP_FIELDS = [
    "Approval Slack TS", "Sent For Approval By", "Approved At",
    "Approval Outcome",
]


def cmd_board(dispatch_queue_path=None):
    formula = "OR(%s)" % ",".join("{Status}='%s'" % s for s in OPEN_STATUSES)
    recs = query_all(TASKS_TABLE, formula, TASK_FIELDS, "board read")
    if not recs:
        fail("board read returned ZERO open tasks — with ~200+ live tasks that "
             "is a broken read, not an empty board")
    seen_fields = set()
    approval_rows = 0
    for r in recs:
        seen_fields.update(r["fields"].keys())
        if r["fields"].get("Status") == "Approval":
            approval_rows += 1
    drifted = [f for f in CONTROL_FIELDS if f not in seen_fields]
    if drifted:
        fail("field(s) %s absent from every one of %d records — field names "
             "have drifted, do not trust this read" % (drifted, len(recs)))
    if approval_rows >= 5 and not any(f in seen_fields for f in APPROVAL_STAMP_FIELDS):
        fail("%d Approval-status rows but none of %s appears on any record — "
             "the approval stamp field names have drifted"
             % (approval_rows, APPROVAL_STAMP_FIELDS))

    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=STUCK_DAYS)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    activity = query_all(
        ACTIVITY_TABLE,
        "IS_AFTER({At}, DATETIME_PARSE('%s'))" % cutoff,
        ["TaskId"], "activity read")
    activity_ids = {a["fields"].get("TaskId") for a in activity
                    if a["fields"].get("TaskId")}
    if activity and not activity_ids:
        fail("%d Task Activity rows in the window but ZERO carry TaskId — the "
             "activity writer has drifted; every web-app edit would read as "
             "no-movement" % len(activity))

    dispatch_ids = set()
    if dispatch_queue_path:
        try:
            dispatch_ids = in_flight_ids(
                json.loads(Path(dispatch_queue_path).read_text()))
        except (OSError, ValueError) as e:
            # The board is independent of dispatch; a missing queue file must
            # not kill the pass, but it must be visible in the output.
            print("WARNING: dispatch queue unreadable (%s) — inFlight "
                  "detection disabled this slot" % e, file=sys.stderr)

    buckets = {"stuck": [], "waitingOnKevin": [], "parked": [], "moving": [],
               "inFlight": []}
    by_status, kevin_count = {}, 0
    for r in recs:
        status = r["fields"].get("Status", "?")
        by_status[status] = by_status.get(status, 0) + 1
        bucket, is_kevin, view = task_view(r, activity_ids, dispatch_ids, now)
        if is_kevin:
            kevin_count += 1
        buckets[bucket].append(view)

    for k in buckets:
        buckets[k].sort(key=lambda v: (v["lastMoved"] or ""))
    # Duplicates are judged over ACTIONABLE views only: parked (Some Day)
    # twins are deliberately dormant, and dispatch's in-flight tasks are not
    # the foreman's to touch this slot. waitingOnKevin views join so an
    # Approval twin can surface as untouchable.
    dupes = duplicate_groups(
        buckets["stuck"] + buckets["moving"] + buckets["waitingOnKevin"])
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
            "inFlight": len(buckets["inFlight"]),
            "duplicateGroups": len(dupes),
            "duplicateExtras": sum(len(g["closable"]) for g in dupes),
        },
        "stuck": buckets["stuck"],
        "duplicates": dupes,
        "waitingOnKevin": buckets["waitingOnKevin"],
        "inFlight": [v["id"] for v in buckets["inFlight"]],
        "parked": [v["id"] for v in buckets["parked"]],
    }
    print(json.dumps(out, indent=1))


# The gate lane read serving Step 2b (approval-gate cleanse, Kevin's approved
# extension of 1 Sep 2026) and Step 3b (priority review). Same population as
# Kevin's queue on the AI Agents page: Status Approval AND loop-raised (Sent
# For Approval By set). Legacy Approval rows without that stamp are STUCK
# work (4 Aug 2026 lesson) and never match the formula, so the cleanse can
# never sweep them — that guarantee lives HERE, not in the skill's judgement.
GATE_FORMULA = "AND({Status}='Approval', LEN({Sent For Approval By}&'')>0)"
GATE_FIELDS = [
    "Task Name", "Status", "Created Time", "Approval Slack TS",
    "Sent For Approval By", "Approver", "Priority", "Agent Output",
    "Inbound Note URL Link",
]


def cmd_gate(task=None):
    if task:
        # Full single-item read for building a cleanse proposal: dispatch
        # submit REPLACES Agent Output wholesale, so the proposal file must
        # carry the original submission below it — which needs the FULL
        # text, not the lane listing's 600-char excerpt.
        rec = airtable_request("GET", "%s/%s" % (TASKS_TABLE, task), None,
                              "gate single read")
        f = dict(rec.get("fields", {}), _id=rec["id"])
        view = lane_view(f)
        view["outputFull"] = (f.get("Agent Output") or "").strip()
        print(json.dumps(view, indent=1))
        return
    recs = query_all(TASKS_TABLE, GATE_FORMULA, GATE_FIELDS, "gate lane read")
    # Zero-read control: lane=0 while many rows sit at Status Approval means
    # the formula's stamp field has drifted, because a typo'd field name
    # returns 200 OK and an empty list. A handful of legacy rows alongside an
    # empty lane is normal; five or more stamped-era rows with NO lane match
    # is a broken read, not a clean gate.
    status_only = query_all(TASKS_TABLE, "{Status}='Approval'",
                            ["Task Name"], "gate control read")
    if not recs and len(status_only) >= 5:
        fail("gate lane read matched ZERO rows while %d tasks sit at Status "
             "Approval — the formula's field names have drifted, do not "
             "trust this read" % len(status_only))
    now = datetime.now(timezone.utc)
    lane, other = [], []
    for r in recs:
        v = lane_view(dict(r["fields"], _id=r["id"]), now)
        # Empty Approver = Kevin (same rule dispatch applies at submit time);
        # a submission awaiting someone else is not his to cleanse or rank.
        if not v["approverEmail"] or v["approverEmail"] == KEVIN_EMAIL:
            lane.append(v)
        else:
            other.append(v)
    lane.sort(key=lambda v: -(v["hoursWaiting"] or 0))  # oldest first
    out = {
        "generatedAt": now.isoformat(),
        "counts": {
            "laneRead": len(recs),
            "kevinLane": len(lane),
            "otherApprovers": len(other),
            "legacyApprovalRows": len(status_only) - len(recs),
        },
        "medianAgeHours": median_hours([v["hoursWaiting"] for v in lane]),
        "lane": lane,
        "otherApprovers": other,
    }
    print(json.dumps(out, indent=1))


def cmd_note(task, move, reason, name=""):
    digest_append({"task": task, "move": move, "reason": reason, "name": name})
    print(json.dumps({"noted": task, "move": move}))


# The Step 3b approval-queue review's ONE write. Kevin's queue on the AI
# Agents page sorts tier-1 first, then this field, then longest waiting —
# so the board's 9am/1pm/5pm judgement reaches him through it. Options are
# the LIVE single-select names; 'Project' is a workstream marker the board
# never writes, and there is deliberately NO typecast: a typo'd option must
# 422 loudly, never mint a phantom select option on a shared field.
PRIORITY_FIELD = "fldS21RwmwOqt71LI"
PRIORITY_OPTIONS = ("Urgent", "High", "Not Urgent")


def cmd_priority(task, value):
    airtable_request("PATCH", "%s/%s" % (TASKS_TABLE, task),
                     {"fields": {PRIORITY_FIELD: value}}, "priority write")
    digest_append({"task": task, "move": "priority", "to": value})
    print(json.dumps({"task": task, "priority": value}))


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
    # One atomic upsert on the primary key. The find-then-create shape has a
    # race between the three daily slots AND a silent-zero trap (a renamed
    # Log Day field would read as "not found" and create a duplicate every
    # slot); performUpsert 422s loudly on a bad merge field instead.
    out = airtable_request(
        "PATCH", DAILY_LOG_TABLE,
        {"performUpsert": {"fieldsToMergeOn": [ALOG["logDay"]]},
         "records": [{"fields": {
             ALOG["logDay"]: log_day,
             ALOG["date"]: today,
             ALOG["agent"]: [TASKMGR_REGISTER_ROW],
             ALOG["summary"]: summary,
             ALOG["decisions"]: decisions,
         }}],
         "typecast": True}, "daily log upsert")
    created = out.get("createdRecords") or []
    print(json.dumps({"published": "created" if created else "updated",
                      "log_day": log_day, "decisions": len(rows),
                      "summary": summary}))


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
    if isinstance(stuck, int) and stuck > 0 and not actions:
        problems.append("%d stuck tasks but zero actions recorded" % stuck)
    for a in actions:
        if not a.get("ok"):
            problems.append("failed action on %s: %s" % (a.get("task"), a.get("error")))

    # Spot-verify claimed writes against the live table: one batched read,
    # then a REAL assertion per move kind. An entry only counts as checked
    # when something was actually asserted — a no-op check that eats the
    # budget is how a false green gets made.
    GATE_MOVES = ("close", "finish")          # submitted through the gate
    LINK_MOVES = ("route", "chase", "roy", "escalate")  # re-linked a person/agent
    checkable = []
    for a in actions:
        if not a.get("ok") or not a.get("task"):
            continue
        move = a.get("move")
        if move in GATE_MOVES:
            checkable.append(a)
        elif move in LINK_MOVES and (move in ("roy", "escalate") or a.get("to")):
            checkable.append(a)
        if len(checkable) >= 12:
            break
    live = {}
    if checkable:
        formula = "OR(%s)" % ",".join(
            "RECORD_ID()='%s'" % a["task"] for a in checkable)
        for rec in query_all(TASKS_TABLE, formula,
                             ["Team Member", "Status", "Sent For Approval By"],
                             "verify read"):
            live[rec["id"]] = rec.get("fields", {})
    checked = 0
    for a in checkable:
        f = live.get(a["task"])
        if f is None:
            problems.append("claimed %s on %s but the task cannot be read back"
                            % (a.get("move"), a["task"]))
            continue
        move, team = a.get("move"), f.get("Team Member") or []
        checked += 1
        if move == "roy" and ROY_REC not in team:
            problems.append("claimed pass-to-Roy on %s but Roy is not on it" % a["task"])
        elif move == "escalate" and KEVIN_REC not in team:
            problems.append("claimed escalate on %s but Kevin is not on it" % a["task"])
        elif move in ("route", "chase") and a.get("to") not in team:
            problems.append("claimed %s of %s to %s but the link is absent"
                            % (move, a["task"], a.get("to")))
        elif move in GATE_MOVES:
            if f.get("Status") not in ("Approval", "Completed"):
                problems.append("claimed %s on %s but status is %s (never "
                                "reached the gate)" % (move, a["task"], f.get("Status")))
            elif TASKMGR_TEAM_REC not in (f.get("Sent For Approval By") or []):
                problems.append("claimed %s on %s but Sent For Approval By is "
                                "not the Task Manager" % (move, a["task"]))

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
    # stale created only → stuck, and moved is returned alongside
    b, _, moved = classify({"_id": "recY", "Created Time": old}, set(), now)
    assert b == "stuck" and moved is not None, b
    # fresh approval stamp → moving
    b, _, _ = classify({"_id": "recZ", "Created Time": old, "Approved At": fresh}, set(), now)
    assert b == "moving", b
    # slack ts counts as a stamp
    ts = str((now - timedelta(days=2)).timestamp())
    b, _, _ = classify({"_id": "recS", "Created Time": old, "Approval Slack TS": ts}, set(), now)
    assert b == "moving", b
    # approval waiting beats stuck — but ONLY for loop-raised tasks
    b, _, _ = classify({"_id": "recA", "Created Time": old, "Status": "Approval",
                        "Sent For Approval By": ["recAgent1"]}, set(), now)
    assert b == "waitingOnKevin", b
    # legacy Approval row (no Sent For Approval By) is stuck, not Kevin's queue
    b, _, _ = classify({"_id": "recL", "Created Time": old, "Status": "Approval"}, set(), now)
    assert b == "stuck", b
    # decided approval (outcome set) falls through to movement
    b, _, _ = classify({"_id": "recB", "Created Time": old, "Status": "Approval",
                        "Approval Outcome": "Approved as-is",
                        "Sent For Approval By": ["recAgent1"]}, set(), now)
    assert b == "stuck", b
    # some day parks
    b, _, _ = classify({"_id": "recP", "Created Time": old, "Some Day": True}, set(), now)
    assert b == "parked", b
    assert metric_text(3, 210, 12) == "3 stuck (target 0); 210 open; 12 with Kevin"
    # route is a first-class move in the digest taxonomy
    assert "route" in [k for k, _ in DECISION_GROUPS]
    s, t = format_daily_log([
        {"move": "finish", "name": "A", "reason": "small admin", "ts": "2026-08-25T09:10:00"},
        {"move": "route", "name": "R", "ts": "2026-08-25T09:12:00"},
        {"move": "newkind", "name": "B", "ts": "2026-08-25T09:11:00"}])
    assert "1 finish" in s and "1 route" in s and "newkind" in s and "A" in t
    h = trim_history({"2026-07-01": 5, "2026-08-20": 2}, today=date(2026, 8, 25))
    assert "2026-07-01" not in h and "2026-08-20" in h
    assert in_flight_ids({"worklist": [{"id": "recW"}], "reserve": [{"id": "recR"}],
                          "other": [{"id": "recO"}]}) == {"recW", "recR"}
    # thread dedupe: both URL forms and folded multi-URL fields resolve
    assert thread_keys("https://mail.google.com/mail/u/0/#all/187abc") == ["187abc"]
    assert thread_keys("https://mail.google.com/mail/u/0/#inbox/187abc") == ["187abc"]
    assert thread_keys("https://mail.google.com/mail/u/0/#all/T1 https://mail.google.com/mail/u/0/#all/T2") == ["T1", "T2"]
    assert thread_keys("") == [] and thread_keys(None) == []
    gs = duplicate_groups([
        {"id": "t2", "name": "B", "inboundUrl": "https://mail.google.com/mail/u/0/#inbox/TH1", "createdTime": "2026-08-20T10:00:00.000Z"},
        {"id": "t1", "name": "A", "inboundUrl": "https://mail.google.com/mail/u/0/#all/TH1", "createdTime": "2026-08-01T10:00:00.000Z"},
        {"id": "t3", "name": "C", "inboundUrl": "https://mail.google.com/mail/u/0/#all/TH2", "createdTime": "2026-08-02T10:00:00.000Z"},
    ])
    assert len(gs) == 1 and gs[0]["keeper"] == "t1" and gs[0]["closable"] == ["t2"], gs
    # a folded task meets its twin on the second URL too
    gs = duplicate_groups([
        {"id": "f1", "name": "folded", "inboundUrl": "https://mail.google.com/mail/u/0/#all/OLD https://mail.google.com/mail/u/0/#all/NEW", "createdTime": "2026-08-01T10:00:00.000Z"},
        {"id": "f2", "name": "twin", "inboundUrl": "https://mail.google.com/mail/u/0/#all/NEW", "createdTime": "2026-08-02T10:00:00.000Z"},
    ])
    assert len(gs) == 1 and gs[0]["thread"] == "NEW" and gs[0]["closable"] == ["f2"], gs
    # a Roy maintenance task on the same thread is NOT a duplicate of the
    # reply task; an Approval twin is untouchable; extras never negative
    gs = duplicate_groups([
        {"id": "r1", "name": "INBOUND: leak reply", "inboundUrl": "https://mail.google.com/mail/u/0/#all/TH3", "createdTime": "2026-08-01T10:00:00.000Z"},
        {"id": "m1", "name": "MAINTENANCE: fix leak", "inboundUrl": "https://mail.google.com/mail/u/0/#all/TH3", "createdTime": "2026-08-02T10:00:00.000Z", "teamMember": ["reclbdjfVev3bqNHS"]},
    ])
    assert gs == [], gs
    gs = duplicate_groups([
        {"id": "a1", "name": "X", "inboundUrl": "https://mail.google.com/mail/u/0/#all/TH4", "createdTime": "2026-08-01T10:00:00.000Z", "status": "Approval"},
        {"id": "a2", "name": "X again", "inboundUrl": "https://mail.google.com/mail/u/0/#all/TH4", "createdTime": "2026-08-03T10:00:00.000Z", "status": "Approval"},
    ])
    assert gs[0]["closable"] == [] and len(gs[0]["untouchable"]) == 2, gs
    assert sum(len(g["closable"]) for g in gs) == 0
    with tempfile.TemporaryDirectory() as td:
        os.environ["TASK_MANAGER_DIR"] = td
        digest_append({"task": "recT", "move": "leave", "reason": "moving"})
        rows = [json.loads(l) for l in digest_path().read_text().splitlines()]
        assert rows[0]["move"] == "leave"
        write_state({"history": {"2026-08-25": 1}})
        assert read_state()["history"]["2026-08-25"] == 1
        del os.environ["TASK_MANAGER_DIR"]
    # gate lane maths (Step 2b cleanse + Step 3b priority review share it)
    assert median_hours([]) is None
    assert median_hours([5.0]) == 5.0
    assert median_hours([1.0, 3.0, 100.0]) == 3.0
    assert median_hours([1.0, 2.0, 3.0, 4.0]) == 2.5
    lv = lane_view({"_id": "recG", "Task Name": "G", "Created Time": old,
                    "Agent Output": "x" * 700,
                    "Approver": {"email": "someone@else.com"}}, now)
    assert lv["hoursWaiting"] and lv["hoursWaiting"] > 24 * 20, lv
    assert len(lv["outputExcerpt"]) == 601, lv
    assert lv["approverEmail"] == "someone@else.com", lv
    ts2 = str((now - timedelta(hours=2)).timestamp())
    lv = lane_view({"_id": "recG2", "Created Time": old,
                    "Approval Slack TS": ts2}, now)
    assert lv["hoursWaiting"] == 2.0, lv  # slack ts beats created time
    # the lane can NEVER include a legacy Approval row: the formula itself
    # requires the stamp, mirroring the classify rule tested above
    assert "Sent For Approval By" in GATE_FORMULA
    print("selftest OK")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("board")
    b.add_argument("--dispatch-queue", default=None,
                   help="path to agent-dispatch queue JSON; its worklist and "
                        "reserve tasks are marked inFlight, not stuck")
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
    p = sub.add_parser("priority")
    p.add_argument("task")
    p.add_argument("--set", required=True, dest="value", choices=list(PRIORITY_OPTIONS))
    g = sub.add_parser("gate")
    g.add_argument("task", nargs="?", default=None,
                   help="one task id → full lane view incl. complete Agent "
                        "Output (for building a cleanse proposal)")
    sub.add_parser("publish")
    v = sub.add_parser("verify")
    v.add_argument("--report", required=True)
    sub.add_parser("selftest")
    a = ap.parse_args()
    if a.cmd == "board":
        cmd_board(a.dispatch_queue)
    elif a.cmd == "gate":
        cmd_gate(a.task)
    elif a.cmd == "note":
        cmd_note(a.task, a.move, a.reason, a.name)
    elif a.cmd == "priority":
        cmd_priority(a.task, a.value)
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
