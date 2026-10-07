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
  clock [--dry-run]          the deterministic pre-pass: every wall past its clock,
                             and every Roy task with no movement for 7 days, gets
                             its one conversion (run by task-manager-run.sh before
                             the model step; writes clock.json and clock.md)
  selftest                   offline checks of the pure helpers
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = "appnqjDpqDniH3IRl"
TASKS_TABLE = "tblqB8b22hKBL4PF1"
ACTIVITY_TABLE = "tbl2ZTHBDBPo681UL"
AGENTS_TABLE = "tbl9msVjyQWslLOIZ"
DAILY_LOG_TABLE = "tbl6VQKVMnK0Q7hbJ"

AGENT_NAME = "Task Board Manager"
TASKMGR_REGISTER_ROW = "reczg8BygPFnJMQnh"   # AI Agents register
TASKMGR_TEAM_REC = "rec1hYELb4zS8pjjO"       # Team Members "AI Task Board Manager"
METRIC_SCORE_FIELD = "fldkGxrOlrfuLlH3J"
KEVIN_REC = "recHEt2VPYothaqTd"
KEVIN_EMAIL = "kevin@runpreneur.org.uk"
ROY_REC = "reclbdjfVev3bqNHS"
# A Content Engine episode card closes itself once the episode is out on every section (publish.py close-cards, 30
# Sep 2026). On 29 Sep the board read nine live episodes' open cards as "approved but unpublished", chased them, and
# put 2059 back in Kevin's queue to approve again. Matched on the name the engine gives the card
# (content-engine/approval.py task_name), never on who holds it: a route or an escalation re-links the holder, and
# the engine closes the card by its id whoever holds it. The engine's other cards (the monthly performance read, OD
# posts, one-off tasks) do NOT close themselves and stay ordinary board work (review, 30 Sep 2026).
# agent-dispatch.py carries the same prefix; tests/task-manager.test.js fails if they drift.
EPISODE_CARD_PREFIX = "CONTENT: Publish Episode "
FORM_CARD_MARKS = {"rec7aHLK1Q8fMLRXH": {"prefix": "RENT FORM: ", "note": "RENT FORM KEY: "}}
# Kevin's own claim cards (Cash Flow Voids lane C, 5 Oct 2026): the rent check works them in code too.
# Kept identical to KEVIN_CARDS in scripts/agent_email_format.py (tests/rent-cap.test.js).
KEVIN_CARD_MARKS = {"rec7aHLK1Q8fMLRXH": {"prefix": "RENT CLAIM", "note": "RENT CLAIM KEY: "}}


def episode_card(f):
    return str(f.get("Task Name") or "").startswith(EPISODE_CARD_PREFIX)


def form_card_task(f):
    """A robot form card (Cash Flow Voids lane B, 3 Oct 2026): the rent check withdraws, re-raises and
    finishes it in code, and only Kevin's turn in the robot window moves it. Kept identical to
    FORM_CARDS in scripts/agent_email_format.py (tests/task-manager.test.js). Kevin's own claim cards
    (lane C) are the rent check's lane in the same way."""
    name, notes = str(f.get("Task Name") or ""), str(f.get("Notes") or "")
    return any(name.startswith(m["prefix"]) or m["note"] in notes
               for m in list(FORM_CARD_MARKS.values()) + list(KEVIN_CARD_MARKS.values()))

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
OWN_LANE_CHECK_DAYS = 14   # an episode card still open this long is checked against the publishing record
# Statuses that make a task part of the live board. Blank-status legacy rows
# and Completed are out; Some Day (checkbox) is parked, not stuck.
OPEN_STATUSES = ("Today", "Upcoming", "Overdue", "Approval")

# Stamps agent-dispatch.py writes into Notes, read back here so a move the
# foreman already made is not made again next slot (15 Sep 2026). Before this
# an escalation re-linked Kevin and nothing else, so the task read as stuck
# every slot and was escalated again (recZMDlT4l2lcwMhB: seven times); a
# handover to Roy re-linked him and re-emailed the work every slot
# (rec72wof6bUtaEKqJ, rec4kMUqLpQ0NlHAC: 34 handovers each).
NOTE_STAMP_RE = re.compile(r"^\[(\d{1,2} \w{3} \d{4}) — [^\]]+\]\s*(.*)$", re.M)
ESCALATE_NOTE_MARK = "Escalated to Kevin"
DECIDED_NOTE_MARK = "Decision carried out"
# Written by `agent-dispatch.py decided --until` when Kevin's answer is to wait.
PARKED_NOTE_MARK = "Parked until"
# The marker agent-dispatch.py leaves on a Level A carry-out it completed
# WITHOUT Kevin (its HANDLED_MARK, ruling 7 Sep 2026). That path deliberately
# clears Sent For Approval By, so verify cannot demand a card on those closes.
HANDLED_NOTE_MARK = "HANDLED WITHOUT YOU"
HOLDER_RE = re.compile(r"\(holder ([^)]*)\)")
# A decision card's own recommendation (agent-dispatch.py escalate, 2 Oct 2026:
# every card carries a brief ending RECOMMENDED:). Kevin approving with an
# empty box means he took it, so the decided view carries it as the move. The
# section ends at a blank line or the next heading (SINCE YOU LAST ANSWERED,
# LINKS AND FILES, TRACK RECORD).
RECOMMENDED_RE = re.compile(
    r"^[ \t]*RECOMMENDED[ \t]*:[ \t]*(.+?)(?=\n[ \t]*\n|\n[ \t]*[A-Z][A-Z ]{3,}:|\Z)", re.M | re.S)
EARLIER_OUTPUT_MARK = "\n\nEarlier output:\n"


def card_recommended(agent_output):
    """The recommendation on a decision card, '' on a card from before the
    brief. Only the card is read, never an earlier draft kept under it."""
    m = RECOMMENDED_RE.search(str(agent_output or "").partition(EARLIER_OUTPUT_MARK)[0])
    return " ".join(m.group(1).split()) if m else ""
# The clock's own nudge to Roy (cmd_clock) counts as a touch, so the model's weekly chase is not
# due again the same week.
CLOCK_ROY_MARK = "CLOCK ROY:"
ROY_TOUCH_MARKS = ("Handed over to Roy Lavin", "Chase to Roy:", CLOCK_ROY_MARK)
ROY_CHASE_DAYS = 7

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


def newest_note_stamp(notes, *marks):
    """The newest dated Notes line carrying any of `marks`, as an aware
    datetime (London-stamped day read as UTC midnight — a day's precision is
    all a 7-day rule needs), or None."""
    best = None
    lowered = [mark.lower() for mark in marks]
    for m in NOTE_STAMP_RE.finditer(str(notes or "")):
        text = m.group(2).lower()
        if not any(mark in text for mark in lowered):
            continue
        try:
            dt = datetime.strptime(m.group(1), "%d %b %Y").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if best is None or dt > best:
            best = dt
    return best


def classify(f, activity_ids, now=None):
    """One task's bucket: parked | waitingOnKevin | escalated | withRoy |
    ownLane | stuck | moving. Returns (bucket, source, moved_dt) so the caller never
    recomputes."""
    now = now or datetime.now(timezone.utc)
    moved, src = last_movement(f, activity_ids, now)
    if f.get("Some Day"):
        return "parked", src, moved
    # Only a task the approval loop itself raised counts as Kevin's queue —
    # legacy rows parked at Status Approval since before the loop existed
    # (22 of them found 4 Aug 2026, 80+ by late Aug) are stuck work wearing
    # an Approval badge, and counting them as "with Kevin" hides them forever.
    # Checked FIRST: a live card is Kevin's whoever holds the task (a Roy-held
    # decision card is still his decision, not a chase).
    if (f.get("Status") == "Approval" and not f.get("Approval Outcome")
            and f.get("Sent For Approval By")):
        return "waitingOnKevin", src, moved
    # An episode card closes itself (see EPISODE_CARD_PREFIX). Ahead of Roy and the escalation window on purpose:
    # escalate now refuses these, so an escalated or decided one is a leftover whose answer changes nothing. Not a
    # legacy row at Approval with no sender: it is outside Kevin's queue, so no verdict ever comes and the engine
    # never closes it; that is stuck work (review, 30 Sep 2026).
    if episode_card(f) and not (f.get("Status") == "Approval" and not f.get("Sent For Approval By")):
        return "ownLane", src, moved
    # A robot form card waiting for Kevin's turn, or sent back: the rent check's lane, never the foreman's.
    if form_card_task(f):
        return "ownLane", src, moved
    # Roy holds it: never stuck, whatever the stamps say. His lane's only move
    # is a weekly chase (cmd_board says when one is due); re-handing it over
    # was the 34-handovers bug.
    if ROY_REC in (f.get("Team Member") or []):
        return "withRoy", src, moved
    # Escalated inside the window. With an outcome it is DECIDED: Kevin has
    # answered the card and the foreman makes the move he named. Without one
    # the card is still his; escalating again would be the seven-times bug.
    esc = newest_note_stamp(f.get("Notes"), ESCALATE_NOTE_MARK)
    done = newest_note_stamp(f.get("Notes"), DECIDED_NOTE_MARK)
    # A carried-out decision (route/handover after Kevin's answer) closes the
    # card; the task is ordinary work again from that stamp on.
    # HIS ANSWER DOES NOT EXPIRE (2 Oct 2026). An answer given more than seven
    # days after the card went up fell through to stuck, and the card was
    # raised again as "no recorded answer": two cards escalated on 15 Sep were
    # answered on 23 Sep and re-asked on 30 Sep. A live verdict on a DECIDE:
    # card is decided whatever the stamps say; the stamps carry a day and no
    # time, so a card carried out and asked again on one day reads as closed.
    answered = f.get("Approval Outcome") and str(f.get("Agent Output") or "").lstrip().upper().startswith("DECIDE:")
    if esc and (answered or not (done and done >= esc)):
        if (now - esc) < timedelta(days=STUCK_DAYS) or answered:
            if f.get("Approval Outcome"):
                return "decided", "escalateNote", esc
            return "escalated", "escalateNote", esc
    # PARKED ON HIS ANSWER (2 Oct 2026). `decided --until` records "leave it
    # until <date>" and parks the task at Upcoming with that Due Date. Before
    # the date it is not stuck: he said wait, and forcing a move on it three
    # times a day is the re-read his answer was meant to end. The live Due
    # Date decides, so a date he moves by hand is honoured; flip-due turns it
    # to Today on the day and it is ordinary board work again.
    if (f.get("Status") == "Upcoming" and str(f.get("Due Date") or "")[:10] > now.date().isoformat()
            and newest_note_stamp(f.get("Notes"), PARKED_NOTE_MARK)):
        return "parked", "decidedUntil", moved
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


def duplicate_groups(views, verdict=None):
    """Open tasks sharing one thread AND one lane:
    [{thread, lane, keeper, closable, untouchable, folds, names}].

    - keeper: the oldest task overall — the one everything folds into.
    - closable: every other task NOT at Status Approval, PLUS an Approval
      twin the fold check reads as one matter with the keeper (Kevin, 15 Sep
      2026: two cards for one thread both stayed in his queue because an
      Approval twin was untouchable on principle). `submit` carries the
      twin's Agent Output onto the keeper's Notes before it closes, so
      Kevin sees ONE card holding everything.
    - untouchable: Approval twins the fold check refuses, and the keeper
      itself when it sits at Approval — report only, never propose on.
    - folds: [{id, why}] the reason each Approval twin was allowed to fold,
      for the skill to quote on the proposal.
    The fold check is create-agent-task.py's dupe_verdict in "fold" mode
    (same fold lane first, reply vs maintenance only since Kevin's ruling of
    15 Sep 2026, then a shared reference or enough shared non-address
    words); `verdict` is injectable for the selftest only.
    A reply task and a Roy maintenance task on the same thread are
    legitimately TWO tasks, so the lane is part of the key. A folded task can
    appear in more than one group. Callers pass only actionable views
    (never parked or dispatch-in-flight)."""
    verdict = verdict or (lambda a, b: _load_gate().dupe_verdict(a, b, mode="fold"))
    by = {}
    for v in views:
        # One lane read for every fold caller (the gate's fold_lane): the
        # Maintenance Ticket tick, Roy as holder, or a repair-style prefix.
        lane = ("maintenance"
                if _load_gate().fold_lane(v.get("name", ""), v.get("teamMember"),
                                          v.get("maintenanceTicket")) == "maintenance"
                else "reply")
        for k in thread_keys(v.get("inboundUrl")):
            by.setdefault((k, lane), []).append(v)
    out = []
    for (k, lane), vs in by.items():
        if len(vs) > 1:
            vs = sorted(vs, key=lambda v: v.get("createdTime") or "")
            keeper = vs[0]
            closable, untouchable, folds = [], [], []
            if keeper.get("status") == "Approval":
                untouchable.append(keeper["id"])
            for v in vs[1:]:
                if v.get("status") != "Approval":
                    closable.append(v["id"])
                    continue
                vd = verdict(v.get("name", ""), keeper.get("name", "")) or {}
                if vd.get("match"):
                    closable.append(v["id"])
                    folds.append({"id": v["id"], "why": vd.get("why", "")})
                else:
                    untouchable.append(v["id"])
            out.append({
                "thread": k, "lane": lane,
                "keeper": keeper["id"],
                "closable": closable,
                "untouchable": untouchable,
                "folds": folds,
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
    roy_touch = chase_due = None
    if bucket == "withRoy":
        # The weekly chase clock: the newest handover or chase note, with
        # Created Time as the floor. One chase per ROY_CHASE_DAYS, never more.
        roy_touch = (newest_note_stamp(f.get("Notes"), *ROY_TOUCH_MARKS)
                     or parse_iso(f.get("Created Time")))
        chase_due = (roy_touch is None
                     or (now - roy_touch) >= timedelta(days=ROY_CHASE_DAYS))
    view = {
        "id": rec["id"],
        "name": f.get("Task Name", ""),
        "status": f.get("Status"),
        "priority": f.get("Priority"),
        "dueDate": f.get("Due Date"),
        "taskType": f.get("Task Type"),
        "teamMember": team,
        "assigneeEmail": assignee,
        "hasAssignee": bool(f.get("Assignee")),
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
    wall = open_wall(f.get("Notes"))
    if wall:
        # The clock's, not the foreman's (7 Oct 2026): the pre-pass already made its move, and
        # `leave` on it fails verify. Read with agent-dispatch's own task_blocker.
        view["blocker"] = {"kind": wall["kind"], "subject": wall["subject"][:80],
                           "since": wall.get("since") or None}
    if bucket == "withRoy":
        view["royLastTouch"] = roy_touch.isoformat() if roy_touch else None
        view["chaseDue"] = bool(chase_due)
    if bucket == "decided":
        # Kevin's answer, verbatim: the move is whatever he said.
        view["approvalOutcome"] = f.get("Approval Outcome")
        view["approvalFeedback"] = f.get("Approval Feedback") or ""
        view["ask"] = (str(f.get("Agent Output") or "").strip().splitlines() or [""])[0]
        view["recommended"] = card_recommended(f.get("Agent Output"))
        # Who held it when it was escalated: the gate's approve path re-links
        # the task to the sender, so the board restores this holder unless
        # Kevin named another.
        holders = HOLDER_RE.findall(str(f.get("Notes") or ""))
        view["priorHolder"] = [h for h in (holders[-1] if holders else "").split(",")
                               if h and h != "none"]
    return bucket, is_kevin, view


_GATE_MOD = None


def _load_gate():
    """create-agent-task.py as a module — imported, never copied, so the
    auto-reply signal the lane check uses can never drift from the one the
    creation gate uses (same pattern as inbound-triage.py)."""
    global _GATE_MOD
    if _GATE_MOD is None:
        import importlib.util
        p = Path(__file__).resolve().parent / "create-agent-task.py"
        spec = importlib.util.spec_from_file_location("od_catask", p)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _GATE_MOD = mod
    return _GATE_MOD


_SCRIPT_MODS = {}


def _load_script(filename, modname):
    """Another estate script as a module, imported once, never copied (same pattern as
    _load_gate): the wall parser is agent-dispatch.py's task_blocker, and the Roy split is
    reroute-roy-admin.py's classify and new_fields, so neither can drift from its owner."""
    if filename not in _SCRIPT_MODS:
        import importlib.util
        p = Path(__file__).resolve().parent / filename
        spec = importlib.util.spec_from_file_location(modname, p)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _SCRIPT_MODS[filename] = mod
    return _SCRIPT_MODS[filename]


def _load_dispatch():
    return _load_script("agent-dispatch.py", "od_dispatch")


def open_wall(notes):
    """The task's open wall (agent-dispatch.py task_blocker), or None. The import only happens
    for a task whose Notes carry a blocker line at all."""
    if "BLOCKER OPEN" not in str(notes or ""):
        return None
    return _load_dispatch().task_blocker(notes)


def auto_reply_flag(f, cache=None, gate=None):
    """Why this lane item's source message is a machine acknowledgement, or
    None. Kevin's ask, 2 Sep 2026: the creation gate refuses NEW auto-reply
    tasks, but anything laned before it existed, or moved by hand, sits in
    his queue untouched. So the cleanse runs the SAME machine signal over
    the lane: the creation-time test (task name family, every scanned
    message on the thread flagged) plus the full signal over the stored
    message (sender, subject, receipt wording with no ask). A flag is a
    prompt for a one-line CLOSE PROPOSAL, never a silent removal, and a
    bounce never flags (the signal excludes it: a bounce IS a task)."""
    gate = gate or _load_gate()
    if cache is None:
        cache = gate.load_scan_cache()
    name = f.get("Task Name", "") or ""
    why = gate.auto_reply_refusal(
        {gate.F["name"]: name,
         gate.F["inboundUrl"]: f.get("Inbound Note URL Link", "") or ""},
        cache)
    if why:
        return why
    subject = name
    while gate.TASK_NAME_PREFIX_RE.search(subject):
        subject = gate.TASK_NAME_PREFIX_RE.sub("", subject, count=1)
    return gate.auto_reply_signal(
        {"from": f.get("Inbound Sender", "") or ""}, subject,
        f.get("Inbound Message Content", "") or "")


def lane_view(f, now=None, cache=None, gate=None):
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
        "inboundSender": f.get("Inbound Sender", "") or "",
        "autoReply": auto_reply_flag(f, cache, gate),
        "outputExcerpt": output[:600] + ("…" if len(output) > 600 else ""),
        # Never proposed for closing: approving a close proposal on an episode card reads as Kevin approving the
        # episode (content-engine approval.py sync takes the Approval Outcome as his verdict).
        "episodeCard": episode_card(f),
    }


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

TASK_FIELDS = [
    "Task Name", "Status", "Due Date", "Created Time", "Approved At",
    "Approval Slack TS", "Approval Outcome", "Team Member", "Assignee",
    "Sent For Approval By", "Some Day", "Maintenance Ticket", "Task Type",
    "Hard Deadline", "Inbound Note URL Link", "Priority",
    # Notes carries the dispatch stamps (escalate, handover, chase) the
    # classifier reads so a move is never repeated; Approval Feedback and
    # Agent Output carry Kevin's answer to a DECIDE: card (15 Sep 2026).
    "Notes", "Approval Feedback", "Agent Output",
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


def ownerless_views(buckets):
    """Open tasks with no Team Member and no Assignee, whatever their age (Kevin, 23 Sep 2026).
    The stuck rule waits seven days for no movement, so a task created with no owner sat unseen for
    a week: on 23 Sep a legal task due in October had been ownerless for five days.
    Only the actionable buckets: an Approval card has its raiser, a parked task is parked on
    purpose, and dispatch's in-flight work is dispatch's."""
    return [v for b in ("stuck", "moving") for v in buckets.get(b, [])
            if not v.get("teamMember") and not v.get("hasAssignee") and not v.get("assigneeEmail")]


def ownerless_problems(actions, scratch=None):
    """Every task on this slot's ownerless list must carry a recorded move (any move, `leave`
    included, because leaving it is a decision with a reason). Read from this slot's board.json,
    so the list checked is the list the foreman was shown."""
    scratch = scratch or os.environ.get("TASK_MANAGER_SCRATCH")
    if not scratch:
        return []
    try:
        board = json.loads((Path(scratch) / "board.json").read_text())
    except (OSError, ValueError):
        return []   # freshness_problems already reports a missing or unreadable board
    moved = {a.get("task") for a in actions if a.get("ok")}
    return ["ownerless task %s (%s) was given no owner and no move this slot"
            % (v.get("id"), (v.get("name") or "")[:60])
            for v in board.get("ownerless") or [] if v.get("id") not in moved]


def read_activity(now):
    """(rows, task ids) of Task Activity inside the stuck window: web-app edits are movement."""
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
    return activity, activity_ids


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
    activity, activity_ids = read_activity(now)

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
               "inFlight": [], "withRoy": [], "escalated": [], "decided": [], "ownLane": []}
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
    ownerless = ownerless_views(buckets)
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
            "withRoy": len(buckets["withRoy"]),
            "royChaseDue": sum(1 for v in buckets["withRoy"] if v.get("chaseDue")),
            "escalated": len(buckets["escalated"]),
            "decided": len(buckets["decided"]),
            "ownLane": len(buckets["ownLane"]),
            "duplicateGroups": len(dupes),
            "duplicateExtras": sum(len(g["closable"]) for g in dupes),
            "ownerless": len(ownerless),
        },
        # Open tasks nobody holds, ANY age: each gets one move THIS slot (Step 2a), and verify
        # fails the slot if one was left without a recorded move.
        "ownerless": ownerless,
        "stuck": buckets["stuck"],
        "duplicates": dupes,
        "waitingOnKevin": buckets["waitingOnKevin"],
        "inFlight": [v["id"] for v in buckets["inFlight"]],
        # Roy's lane: listed in full so the chase is decided off `chaseDue`,
        # never off a re-read; escalated: ids only (the card is with Kevin).
        "withRoy": buckets["withRoy"],
        "escalated": [v["id"] for v in buckets["escalated"]],
        # Answered DECIDE: cards, each with Kevin's verdict and feedback: the
        # foreman's move this slot is the one he named.
        "decided": buckets["decided"],
        "parked": [v["id"] for v in buckets["parked"]],
        # Episode cards the Content Engine closes itself once the episode is out: never a move for the board. The age
        # is the backstop: one still open after OWN_LANE_CHECK_DAYS is checked against the publishing record.
        "ownLane": [{"id": v["id"], "name": v["name"], "daysStill": v["daysStill"]} for v in buckets["ownLane"]],
        "ownLaneCheckDays": OWN_LANE_CHECK_DAYS,
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
    "Inbound Note URL Link", "Inbound Sender", "Inbound Message Content",
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
    gate = _load_gate()
    cache = gate.load_scan_cache()
    lane, other = [], []
    for r in recs:
        v = lane_view(dict(r["fields"], _id=r["id"]), now, cache, gate)
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
            # Lane items whose source message is a machine acknowledgement:
            # each one is a CLOSE PROPOSAL waiting to be written. Zero is
            # the healthy number; a non-zero count is reported, never hidden.
            "autoReplyFlagged": sum(1 for v in lane if v["autoReply"]),
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


# ---------------------------------------------------------------------------
# THE CLOCK (Kevin, 7 Oct 2026)
# ---------------------------------------------------------------------------
#
# Measured 23 Sep to 6 Oct 2026: 1,346 board moves, 1,020 of them "leave" (76%).
# 39 tasks sat on walls, 24 of them three days or more, and 24 of the 39 were
# never touched. The skill never said BLOCKER, this script had no wall logic,
# and escalate refuses a blocked task, so "leave" was the only move left.
# Kevin's rule: a wall past its clock is stuck, and the move is the conversion
# that clears it, never "leave". Clocks: SIGN-IN 1 day, TOOL 3, KEVIN 3, and a
# Roy hand-off 7 days with no movement. A wall's age is read from its own
# `[since]` stamp (the date on its BLOCKER OPEN line when it has none), never
# from note writes, so a sweep's or an agent's note never resets it.
#
# The clock runs in code before the model step (task-manager-run.sh). One move
# per task per slot; each move once per wall, keyed on a marker line in Notes
# that names the wall's opening; every write is built from a fresh read by
# field id and made only while the same wall still stands. It writes
# clock.json (verify reads it) and clock.md (the report's Clock section).
CLOCK_DAYS = {"SIGN-IN": 1, "TOOL": 3, "KEVIN": 3}
ROY_CLOCK_DAYS = 7
# Reminder emails to Roy per slot, oldest hand-off first. On 7 Oct 2026 a dry run found 38 of his
# 52 tasks past the clock; 30 emails in one burst to the inbox he reads is noise, and three slots a
# day clear such a backlog inside a day. Moves to an agent are not capped (they email nobody).
ROY_NOTIFY_CAP = 10
CLOCK_BY = "task-manager clock"
# The 09:00 brief lists a Hard Deadline task only when it is due within this many days or overdue
# (scripts/slack-automation/money-daily-worker.js DEADLINE_DAYS).
BRIEF_HORIZON_DAYS = 7
LONDON = ZoneInfo("Europe/London")
# Task field ids, js/config.js TASK_FIELDS. The clock's fresh read and its write use ids on both
# sides (CLAUDE.md: one key style for a read-modify-write).
TF = {
    "name": "fldgFjGBw6bTKJFCD", "status": "fldx4qCw17UfrKpaN", "notes": "fldR7apBzSp3oxFxz",
    "dueDate": "fld7XP8w8kbxfETV4", "hardDeadline": "fldZKzIxgyrQ8CG8a",
    "teamMember": "flduCtmQGpOA4eWaj",
}
CLOCK_FIELDS = [
    "Task Name", "Status", "Notes", "Approval Outcome", "Approved At", "Approval Slack TS",
    "Created Time", "Team Member", "Sent For Approval By", "Hard Deadline", "Some Day",
    "Agent Output", "Due Date", "Deferred Until", "Description",
]
LINE_STAMP_RE = re.compile(r"^\[(\d{1,2} \w{3} \d{4})(?: (\d{1,2}):(\d{2}))?")
# Roy's own words on a task: his Property Manager page signs "[YYYY-MM-DD HH:MM Roy Lavin]"
# (workers/property-manager/compute.mjs appendNote); his assistant signs
# "[DD Mon YYYY HH:MM Roy Lavin via his assistant, rec...]" (roy-assistant.py ROY_TASK_NOTE_TAG).
ROY_PAGE_NOTE_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2}) \d{1,2}:\d{2} Roy Lavin\]", re.M)
ROY_ASSISTANT_NOTE_RE = re.compile(r"^\[(\d{1,2} \w{3} \d{4})(?: \d{1,2}:\d{2})? Roy Lavin via his assistant", re.M)


def _sel(v):
    return v.get("name", "") if isinstance(v, dict) else str(v or "")


def london_today(now):
    return now.astimezone(LONDON).date()


def wall_opened_from_line(notes, d):
    """When the task's open wall was written, from the stamp on its BLOCKER OPEN line, or None.
    For a wall recorded before `[since]` existed."""
    last = None
    for m in d.BLOCKER_LINE_RE.finditer(str(notes or "")):
        last = m
    if not last or last.group("mark") != d.BLOCKER_OPEN_MARK:
        return None
    s = LINE_STAMP_RE.match(last.group(0))
    if not s:
        return None
    try:
        day = datetime.strptime(s.group(1), "%d %b %Y")
    except ValueError:
        return None
    return day.replace(hour=int(s.group(2) or 0), minute=int(s.group(3) or 0),
                       tzinfo=LONDON).astimezone(timezone.utc)


def wall_age(b, notes, now, d):
    """(days, key) for an open wall: from its `[since]`, else its line's stamp, else (None,
    "undated"). The key names the wall's opening, so a clock move is made once per wall."""
    since = parse_iso(b.get("since"))
    if since:
        return (now - since).total_seconds() / 86400, b["since"]
    opened = wall_opened_from_line(notes, d)
    if opened:
        return (now - opened).total_seconds() / 86400, "line " + opened.strftime("%Y-%m-%dT%H:%MZ")
    return None, "undated"


def clock_marker(kind, key):
    return "CLOCK (%s wall since %s)" % (kind, key)


def in_kevin_lane(f, d):
    """True when the task sits in Kevin's approval queue: a card waiting on his verdict, or an
    approved card back in front of him as Your step (agent-dispatch.py, PR 720)."""
    if _sel(f.get("Status")) != "Approval" or not (f.get("Sent For Approval By") or []):
        return False
    outcome = _sel(f.get("Approval Outcome"))
    if not outcome:
        return True
    return outcome in d.APPROVED and d.your_step_split(f.get("Agent Output"))[0] is not None


def wall_decision(row, f, now, d, findings_error=""):
    """What the clock does about one open wall. Pure: reads the blocker row and the task."""
    kind = row.get("kind")
    out = {"task": row.get("task"), "name": str(f.get("Task Name") or row.get("name") or "")[:90],
           "kind": kind, "subject": str(row.get("subject") or "")[:80], "clock": CLOCK_DAYS.get(kind),
           "past": False, "action": None, "why": ""}
    notes = str(f.get("Notes") or "")
    b = d.task_blocker(notes)
    if not b or b["kind"] != kind or not str(row.get("subject") or "").startswith(b["subject"]):
        out["why"] = "the wall changed between the blocker read and the task read; the next slot judges it"
        return out
    days, key = wall_age(b, notes, now, d)
    out["days"] = round(days, 1) if days is not None else None
    if out["clock"] is None:
        out["why"] = "a %s wall has no clock: Kevin's Add a new site clears it" % kind
        return out
    if days is not None and days < out["clock"]:
        return out
    # Past the clock. A wall nothing can date is treated as past it, never as fresh.
    out["past"] = True
    if days is None:
        out["undated"] = True
    out["marker"] = clock_marker(kind, key)
    marked = out["marker"] in notes
    if kind == "TOOL":
        fid = row.get("finding") or b.get("finding") or ""
        status = row.get("findingStatus") or ""
        out["finding"] = fid
        if not fid:
            out["why"] = ("no finding is named on the wall, so there is nothing to raise: the agent must "
                          "record the wall again with its finding")
        elif findings_error:
            out["why"] = "the findings queue could not be read: %s" % findings_error[:160]
        elif status != "open":
            out["why"] = "finding %s is %s, not unclaimed: %s" % (
                fid, status or "not in the queue", str(row.get("tool") or "")[:160] or "nothing more said")
        else:
            out["action"], out["annotate"] = "escalate", not marked
        return out
    if kind == "KEVIN" and not in_kevin_lane(f, d):
        if _sel(f.get("Approval Outcome")) in d.APPROVED:
            out["why"] = ("approved but not yet in his queue as Your step: agent-dispatch.py has no one-task "
                          "conversion, so the half-hourly blocker sweep moves it there")
        else:
            out["why"] = ("not approved and not in his queue: a KEVIN wall on unapproved work has no door; the "
                          "agent must submit the step as a KEVIN ONLY card")
        return out
    today = london_today(now)
    due = str(f.get("Due Date") or "")[:10]
    if parked_on_purpose(f, now):
        out["why"] = "parked on purpose (Some Day, a standing hold or Kevin's own date, %s): never ticked" % (
            due or "no date")
    elif f.get("Hard Deadline"):
        horizon = (today + timedelta(days=BRIEF_HORIZON_DAYS)).isoformat()
        if due and due <= horizon:
            out["why"], out["already"] = "already carries Hard Deadline, due %s, so it is on the brief" % due, True
        else:
            # A real deadline someone else ticked: its date is the letter's, never the clock's to move.
            out["why"] = "carries Hard Deadline %s, so the brief cannot show it yet; its date is left as set" % (
                "due " + due if due else "with no due date")
    elif marked:
        out["why"] = "Hard Deadline was ticked once for this wall and taken off since: left as it was set"
    elif str(f.get("Deferred Until") or "")[:10] > today.isoformat():
        out["why"] = "knocked back until %s; the brief shows it from then" % str(f.get("Deferred Until"))[:10]
    else:
        out["action"] = "tick"
    return out


def parked_on_purpose(f, now):
    """Some Day, or Upcoming with a date still ahead: a standing hold (standing_holds.py parks to the
    review date), Kevin's own `decided --until`, or a date someone moved forward by hand. The clock
    never ticks, moves or chases such a task: a tick's due date would unpark it."""
    return bool(f.get("Some Day")) or (_sel(f.get("Status")) == "Upcoming"
                                       and str(f.get("Due Date") or "")[:10] > london_today(now).isoformat())


def roy_note_stamp(notes):
    """The newest day Roy himself wrote on the task (his page or his assistant), or None."""
    best = None
    for m in ROY_PAGE_NOTE_RE.finditer(str(notes or "")):
        try:
            dt = datetime.strptime(m.group(1), "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        best = dt if best is None or dt > best else best
    for m in ROY_ASSISTANT_NOTE_RE.finditer(str(notes or "")):
        try:
            dt = datetime.strptime(m.group(1), "%d %b %Y").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        best = dt if best is None or dt > best else best
    return best


def roy_last_movement(f, task_id, activity_ids, now):
    """When a Roy-held task last moved: the board's own stamps (a web-app edit, an approval, the
    card, Created Time as the floor), the handover to him, or a note in his own words. Our chases
    and the clock's nudges are not movement. None only when the task carries no stamp at all."""
    moved, _ = last_movement(dict(f, _id=task_id), activity_ids, now)
    notes = f.get("Notes")
    cands = [c for c in (moved, newest_note_stamp(notes, "Handed over to Roy Lavin"), roy_note_stamp(notes),
                         fold_stamp(f.get("Description"))) if c]
    return max(cands) if cands else None


# What the create gate writes when new mail on the matter is folded into the task
# (create-agent-task.py build_update). Since 6 Oct 2026 Roy answers by email and triage folds his
# reply in this way, so a fold is movement: a reminder must never follow his reply.
FOLD_RE = re.compile(r"^UPDATE (\d{4}-\d{2}-\d{2}): new item folded in", re.M)


def fold_stamp(description):
    days = [m.group(1) for m in FOLD_RE.finditer(str(description or ""))]
    try:
        return datetime.strptime(max(days), "%Y-%m-%d").replace(tzinfo=timezone.utc) if days else None
    except ValueError:
        return None


def roy_decision(rec, activity_ids, now):
    f = rec["fields"]
    out = {"task": rec["id"], "name": str(f.get("Task Name") or "")[:90], "kind": "ROY", "subject": "Roy Lavin",
           "clock": ROY_CLOCK_DAYS, "past": False, "action": None, "why": ""}
    moved = roy_last_movement(f, rec["id"], activity_ids, now)
    days = (now - moved).total_seconds() / 86400 if moved else None
    out["days"] = round(days, 1) if days is not None else None
    if days is not None and days < ROY_CLOCK_DAYS:
        return out
    out["past"], out["action"] = True, "roy"
    if moved is None:
        out["undated"] = True
    return out


def roy_eligible(rec, walled, now):
    """A task Roy holds that the Roy clock may judge: open, not parked or dated forward, not Kevin's
    card, and not standing on a wall (the wall's own clock owns it)."""
    f = rec["fields"]
    return (ROY_REC in (f.get("Team Member") or []) and rec["id"] not in walled and not parked_on_purpose(f, now)
            and _sel(f.get("Status")) in OPEN_STATUSES and _sel(f.get("Status")) != "Approval")


# ── the clock's I/O, replaced by fakes in tests/task-manager-clock.test.js ──

def clock_get(task_id):
    rec = airtable_request("GET", "%s/%s?returnFieldsByFieldId=true" % (TASKS_TABLE, task_id), None,
                           "clock read of one task")
    return rec.get("fields") or {}


def clock_patch(task_id, fields):
    airtable_request("PATCH", "%s/%s" % (TASKS_TABLE, task_id), {"fields": fields, "typecast": False},
                     "clock write")


def clock_run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    return r.returncode, r.stdout or "", r.stderr or ""


def _last_json(text):
    for line in reversed(str(text or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                return {}
    return {}


def _note_line(now, text):
    return "[%s — %s] %s" % (now.astimezone(LONDON).strftime("%d %b %Y"), CLOCK_BY, text)


def _same_wall_live(dec, live, now, d):
    """The task's wall as it stands NOW, or None when it is gone or is no longer the wall the
    decision was made on (a write would then be about a wall nobody judged)."""
    notes = str(live.get(TF["notes"]) or "")
    b = d.task_blocker(notes)
    if not b or b["kind"] != dec["kind"] or clock_marker(b["kind"], wall_age(b, notes, now, d)[1]) != dec["marker"]:
        return None
    return notes


def apply_tick(dec, now, d):
    live = clock_get(dec["task"])
    notes = _same_wall_live(dec, live, now, d)
    if notes is None:
        return {"why": "the wall changed since the read; the next slot judges it"}
    if live.get(TF["hardDeadline"]):
        return {"why": "already carries Hard Deadline", "already": True}
    if dec["marker"] in notes:
        return {"why": "Hard Deadline was ticked once for this wall and taken off since: left as it was set"}
    today = london_today(now)
    horizon = (today + timedelta(days=BRIEF_HORIZON_DAYS)).isoformat()
    due = str(live.get(TF["dueDate"]) or "")[:10]
    # The brief lists a Hard Deadline only when it is due inside its week (or overdue). The task's
    # date was a soft one (nothing had ticked it), so it is set to the far edge of that week: on the
    # brief, sorted behind every real deadline due sooner (review, 7 Oct 2026: a tick due today
    # pushed a court date six days out below the brief's five), and clear of the
    # hard-deadline-passed invariant for a week. A soft date already inside the week is kept.
    new_due = due if (due and today.isoformat() < due <= horizon) else horizon
    line = _note_line(now, "%s: past its %d-day clock, so Hard Deadline is ticked (due %s) and it is on Kevin's "
                           "09:00 brief. It comes off when this wall clears." % (dec["marker"], dec["clock"], new_due))
    fields = {TF["hardDeadline"]: True, TF["notes"]: (notes.rstrip() + "\n\n" + line).strip()[-90000:]}
    if new_due != due:
        fields[TF["dueDate"]] = new_due
    clock_patch(dec["task"], fields)
    return {"done": "Hard Deadline ticked, due %s" % new_due}


# The tick line apply_tick writes, read back to take the tick off once its wall has cleared.
TICK_LINE_RE = re.compile(r"(CLOCK \((?:KEVIN|SIGN-IN) wall since [^)]+\)): past its \d+-day clock, so Hard "
                          r"Deadline is ticked \(due (\d{4}-\d{2}-\d{2})\)")
UNTICK_MARK = "CLOCK UNTICK"


def untick_decision(rec, now, d):
    """The clock's own Hard Deadline tick on a task whose wall has since cleared, or None. Only a
    tick the clock wrote, still standing, with the due date it set unchanged (a date someone moved,
    or a tick someone put back by hand, is theirs). Otherwise the tick would stand for ever: nothing
    in agent-dispatch.py takes it off when the wall clears."""
    f = rec.get("fields") or {}
    notes = str(f.get("Notes") or "")
    if not f.get("Hard Deadline"):
        return None
    ticks = list(TICK_LINE_RE.finditer(notes))
    if not ticks or notes.rfind(UNTICK_MARK) > ticks[-1].start():
        return None
    marker, set_due = ticks[-1].group(1), ticks[-1].group(2)
    if str(f.get("Due Date") or "")[:10] != set_due:
        return None
    b = d.task_blocker(notes)
    if b and clock_marker(b["kind"], wall_age(b, notes, now, d)[1]) == marker:
        return None                                             # the same wall still stands
    return {"task": rec["id"], "name": str(f.get("Task Name") or "")[:90], "kind": "UNTICK",
            "subject": marker, "clock": None, "past": True, "action": "untick", "why": "",
            "marker": marker, "setDue": set_due}


def apply_untick(dec, now, d):
    live = clock_get(dec["task"])
    fresh = untick_decision({"id": dec["task"], "fields": {
        "Notes": live.get(TF["notes"]), "Hard Deadline": live.get(TF["hardDeadline"]),
        "Due Date": live.get(TF["dueDate"]), "Task Name": live.get(TF["name"])}}, now, d)
    if not fresh or fresh["marker"] != dec["marker"]:
        return {"why": "changed since the read; the next slot judges it"}
    notes = str(live.get(TF["notes"]) or "")
    line = _note_line(now, "%s (%s): the wall cleared, so the clock's Hard Deadline tick is taken off."
                      % (UNTICK_MARK, dec["marker"]))
    clock_patch(dec["task"], {TF["hardDeadline"]: False,
                              TF["notes"]: (notes.rstrip() + "\n\n" + line).strip()[-90000:]})
    return {"done": "the wall cleared, so the clock's Hard Deadline tick is off"}


def apply_escalate(dec, now, d):
    fid = dec["finding"]
    why = "%s blocked %s days on TOOL %s; the robot cannot go on until it is fixed" % (
        dec["task"], dec.get("days") if dec.get("days") is not None else "an unknown number of", dec["subject"])
    rc, out, err = clock_run([sys.executable, str(Path(__file__).resolve().parent / "findings.py"), "escalate",
                              fid, "--severity", "critical", "--why", why, "--by", "task-manager"])
    if rc == 2:
        return {"why": "findings.py refused: %s" % (err or out).strip()[-200:]}
    if rc != 0:
        raise RuntimeError("findings.py escalate exited %d: %s" % (rc, (err or out).strip()[-200:]))
    changed = bool(_last_json(out).get("changed"))
    noted = False
    if dec.get("annotate"):
        live = clock_get(dec["task"])
        notes = _same_wall_live(dec, live, now, d)
        if notes is not None and dec["marker"] not in notes:
            line = _note_line(now, "%s: past its %d-day clock, so finding %s is raised to critical and the fixer "
                                   "takes it first." % (dec["marker"], dec["clock"], fid))
            clock_patch(dec["task"], {TF["notes"]: (notes.rstrip() + "\n\n" + line).strip()[-90000:]})
            noted = True
    if not changed and not noted:
        return {"why": "already done: finding %s is critical and the task carries the note" % fid, "already": True}
    return {"done": ("finding %s raised to critical" % fid if changed else "finding %s was already critical" % fid)
                    + ("; noted on the task" if noted else "")}


def _spend(budget):
    if budget is not None:
        budget["royNotify"] = budget.get("royNotify", 0) - 1


def apply_roy(dec, now, d, rr, budget=None):
    live = clock_get(dec["task"])
    if ROY_REC not in (live.get(TF["teamMember"]) or []):
        return {"why": "no longer held by Roy"}
    verdict, why = rr.classify({"id": dec["task"], "fields": live}, rr.chain_names())
    notes = str(live.get(TF["notes"]) or "")
    # Only plain admin moves unattended. A repair-lane name with no repair word is one
    # reroute-roy-admin.py lists for a person to check first (review, 7 Oct 2026): it stays Roy's
    # and gets the reminder, never a guess at an agent that cannot book a repair.
    if verdict == "move" and why == "admin":
        if dec.get("listedNotes") and not notes.strip():
            # CLAUDE.md: a field about to be appended to that reads blank is a STOP.
            return {"why": "Notes read blank on the fresh read but not on the board read; not written"}
        stamp = now.astimezone(LONDON).strftime("%d %b %Y")
        clock_patch(dec["task"], rr.new_fields(live, stamp))
        back = clock_get(dec["task"])
        team = back.get(TF["teamMember"]) or []
        agent = rr.target_agent(live.get(TF["name"]))
        if ROY_REC in team or agent not in team:
            raise RuntimeError("moved %s but the read back shows team %s" % (dec["task"], team))
        return {"done": "moved to %s (%s)" % (rr.AGENT_NAMES.get(agent, agent), why)}
    if why.startswith("in Approval"):
        return {"why": why}
    last = newest_note_stamp(notes, CLOCK_ROY_MARK)
    if last and (now - last) < timedelta(days=ROY_CLOCK_DAYS):
        return {"why": "Roy was reminded on %s; the next reminder is due 7 days after" % last.strftime("%d %b"),
                "already": True}
    if budget is not None and budget.get("royNotify", 0) <= 0:
        return {"why": "over this slot's cap of %d reminders to Roy; the next slot sends it" % ROY_NOTIFY_CAP}
    days = dec.get("days")
    reason = ("REMINDER: this has been with you %s with no update. Reply with what is happening, or "
              "\"done\" when it is finished." % ("%d days" % int(days) if days is not None else "a while"))
    rc, out, err = clock_run([sys.executable, str(Path(__file__).resolve().parent / "send-email.py"), "notify",
                              dec["task"], "--to", d.ROY_EMAIL, "--reason", reason,
                              "--again-after-days", str(ROY_CLOCK_DAYS)])
    res = _last_json(out)
    if rc != 0:
        msg = (err or out).strip()[-200:]
        if "REFUSED" in msg:
            return {"why": "not emailed: %s" % msg}
        _spend(budget)                                  # it may have gone: it counts against the cap
        raise RuntimeError("send-email.py notify exited %d: %s" % (rc, msg))
    if res.get("skipped"):
        # A refusal or a ledger skip sent nothing, so it uses no place in the cap (review, 7 Oct 2026).
        return {"why": "not emailed: %s" % res.get("why")}
    _spend(budget)
    if not res.get("notified"):
        raise RuntimeError("send-email.py notify said neither notified nor skipped: %s" % out.strip()[-200:])
    fresh = clock_get(dec["task"])
    fnotes = str(fresh.get(TF["notes"]) or "")
    if notes.strip() and not fnotes.strip():
        return {"done": "emailed Roy a reminder (%s); the note was not written: Notes read blank" % why}
    line = _note_line(now, "%s emailed Roy a reminder: %s with no movement (%s)." % (
        CLOCK_ROY_MARK, "%s days" % dec.get("days") if dec.get("days") is not None else "no stamp", why))
    clock_patch(dec["task"], {TF["notes"]: (fnotes.rstrip() + "\n\n" + line).strip()[-90000:]})
    return {"done": "emailed Roy a reminder (%s)" % why}


def run_clock(walls, recs, now, activity_ids, d, apply=True, rr_loader=None):
    """Decide every wall and every Roy hand-off, then make the moves. Returns the clock result."""
    by_id = {r["id"]: r.get("fields") or {} for r in recs}
    findings_error = str(walls.get("findingsError") or "")
    decisions = []
    for row in walls.get("open") or []:
        f = by_id.get(row.get("task"))
        if f is None:
            decisions.append({"task": row.get("task"), "name": str(row.get("name") or "")[:90],
                              "kind": row.get("kind"), "subject": str(row.get("subject") or "")[:80],
                              "clock": CLOCK_DAYS.get(row.get("kind")), "past": False, "action": None,
                              "why": "not in the clock's task read (closed since the blocker read)"})
            continue
        decisions.append(wall_decision(row, f, now, d, findings_error))
    walled = {r["id"] for r in recs if open_wall((r.get("fields") or {}).get("Notes"))}
    walled |= {row.get("task") for row in walls.get("open") or []}
    roy_held = [r for r in recs if roy_eligible(r, walled, now)]
    roy_decs = []
    for r in roy_held:
        dec = roy_decision(r, activity_ids, now)
        dec["listedNotes"] = bool(str(r["fields"].get("Notes") or "").strip())
        roy_decs.append(dec)
    # Oldest first (an undated task counts as oldest), so the reminder cap takes the longest waits.
    roy_decs.sort(key=lambda x: -(x["days"] if x.get("days") is not None else float("inf")))
    decisions += roy_decs
    # The clock's own ticks whose walls have cleared come off (one move per task: a task already
    # moved above this slot is skipped below).
    decisions += [u for u in (untick_decision(r, now, d) for r in recs) if u]
    rr = None
    moved = set()
    budget = {"royNotify": ROY_NOTIFY_CAP}
    for dec in decisions:
        if not dec.get("action"):
            continue
        if dec["task"] in moved:
            dec["why"], dec["action"] = "one move per task per slot: already moved this slot", None
            continue
        if not apply:
            dec["done"] = "dry run: would %s" % dec["action"]
            continue
        try:
            if dec["action"] == "tick":
                res = apply_tick(dec, now, d)
            elif dec["action"] == "untick":
                res = apply_untick(dec, now, d)
            elif dec["action"] == "escalate":
                res = apply_escalate(dec, now, d)
            else:
                if rr is None:
                    rr = (rr_loader or (lambda: _load_script("reroute-roy-admin.py", "od_reroute")))()
                res = apply_roy(dec, now, d, rr, budget)
        except (Exception, SystemExit) as exc:  # noqa: BLE001 — every failure is in clock.json and fails verify
            dec["failed"] = ("%s: %s" % (type(exc).__name__, exc))[:300]
            continue
        dec.update(res)
        if res.get("done"):
            moved.add(dec["task"])
    return {"at": now.isoformat(), "walls": len(walls.get("open") or []), "tasksRead": len(recs),
            "royHeld": len(roy_held), "decisions": decisions, "summary": clock_summary(decisions)}


def clock_summary(decisions):
    out = {}
    for dec in decisions:
        k = out.setdefault(dec["kind"], {"walls": 0, "pastClock": 0, "done": 0, "already": 0,
                                         "notDone": 0, "failed": 0})
        k["walls"] += 1
        if not dec.get("past"):
            continue
        k["pastClock"] += 1
        if dec.get("failed"):
            k["failed"] += 1
        elif dec.get("done"):
            k["done"] += 1
        elif dec.get("already"):
            k["already"] += 1
        else:
            k["notDone"] += 1
    return out


CLOCK_LABELS = (("KEVIN", "KEVIN walls (3-day clock)"), ("TOOL", "TOOL walls (3-day clock)"),
                ("SIGN-IN", "SIGN-IN walls (1-day clock)"), ("SITE", "SITE walls (no clock)"),
                ("ROY", "Roy hand-offs (7 days with no movement)"),
                ("UNTICK", "Clock ticks taken off (their wall cleared)"))


def clock_markdown(result):
    """The report's Clock section: per kind, how many were past the clock, what was done, what
    could not be done and why. Private: written to scratch, pasted into report-<date>-<HH>.md."""
    lines = ["## Clock", "",
             "%s open walls (agent-dispatch.py blockers) over %s open tasks read; %d tasks held by Roy "
             "judged. A wall past its clock gets its conversion in code before this pass; `leave` is "
             "never a move on a blocked task." % (result.get("walls"), result.get("tasksRead"),
                                                 result.get("royHeld") or 0), ""]
    decs = result.get("decisions") or []
    for kind, label in CLOCK_LABELS:
        s = (result.get("summary") or {}).get(kind)
        if not s:
            lines.append("- %s: none." % label)
            continue
        lines.append("- %s: %d judged, %d past the clock: %d done, %d already done, %d not done, %d failed."
                     % (label, s["walls"], s["pastClock"], s["done"], s["already"], s["notDone"], s["failed"]))
        for dec in decs:
            if dec["kind"] != kind or not dec.get("past"):
                continue
            what = (("FAILED: " + dec["failed"]) if dec.get("failed") else
                    dec.get("done") or ("not done: " + (dec.get("why") or "no reason recorded")))
            lines.append("  - %s (%s, %s days%s): %s" % (
                dec["name"][:70], dec["task"], dec.get("days") if dec.get("days") is not None else "?",
                ", undated" if dec.get("undated") else "", what))
    return "\n".join(lines) + "\n"


def blockers_read():
    """agent-dispatch.py blockers (read-only, no --sweep): every open wall, paginated by its own reader."""
    rc, out, err = clock_run([sys.executable, str(Path(__file__).resolve().parent / "agent-dispatch.py"),
                              "blockers"])
    if rc != 0:
        fail("agent-dispatch.py blockers exited %d: %s" % (rc, (err or out).strip()[-300:]))
    try:
        walls = json.loads(out)
    except ValueError as e:
        fail("agent-dispatch.py blockers printed no JSON (%s)" % e)
    if not walls.get("openTasksRead"):
        fail("the blocker read reached no open task at all: a blind read, not a quiet board")
    return walls


def cmd_clock(dry_run=False):
    now = datetime.now(timezone.utc)
    d = _load_dispatch()
    walls = blockers_read()
    recs = query_all(TASKS_TABLE, "NOT({Status}='Completed')", CLOCK_FIELDS, "clock read")
    if not recs:
        fail("the clock's task read returned ZERO open tasks: a broken read, not an empty board")
    _, activity_ids = read_activity(now)
    result = run_clock(walls, recs, now, activity_ids, d, apply=not dry_run)
    result["dryRun"] = bool(dry_run)
    scratch = os.environ.get("TASK_MANAGER_SCRATCH")
    if scratch:
        Path(scratch).mkdir(parents=True, exist_ok=True)
        for name, text in (("clock.json", json.dumps(result, indent=1)), ("clock.md", clock_markdown(result))):
            tmp = Path(scratch) / (name + ".tmp")
            tmp.write_text(text)
            os.replace(tmp, Path(scratch) / name)
    failed = sum(s["failed"] for s in result["summary"].values())
    # Counts only: this line lands in the run log.
    print(json.dumps({"clock": result["summary"], "failed": failed, "dryRun": bool(dry_run)}))
    if failed:
        sys.exit(1)


def clock_problems(actions, scratch=None, run_start=None):
    """verify's half of the clock: this slot's clock.json exists and is fresh, none of its moves
    failed, and no blocked task was recorded `leave` (Kevin, 7 Oct 2026: a wall past its clock is
    stuck, and leave is not a move on it)."""
    scratch = scratch or os.environ.get("TASK_MANAGER_SCRATCH")
    run_start = run_start if run_start is not None else os.environ.get("TASK_MANAGER_RUN_START")
    if not scratch:
        return []
    out = []
    blocked, answered = set(), set()
    try:
        board = json.loads((Path(scratch) / "board.json").read_text())
        blocked = {v.get("id") for k in ("stuck", "ownerless") for v in board.get(k) or []
                   if isinstance(v, dict) and v.get("blocker")}
        # Kevin's own "wait" on a decision card is recorded as leave (decided --until), and an
        # episode card's finding is recorded as leave: both are his or the engine's, never a skip.
        answered = {v.get("id") if isinstance(v, dict) else v
                    for k in ("decided", "ownLane") for v in board.get(k) or []}
    except (OSError, ValueError):
        pass   # freshness_problems reports a missing or unreadable board
    p = Path(scratch) / "clock.json"
    if run_start:
        try:
            clock = json.loads(p.read_text())
            if p.stat().st_mtime < float(run_start):
                out.append("clock.json is from a PREVIOUS slot: the clock pre-pass did not run this slot")
            for dec in clock.get("decisions") or []:
                if dec.get("failed"):
                    out.append("clock move on %s (%s) failed: %s" % (dec.get("task"), dec.get("kind"), dec["failed"]))
            blocked |= {dec.get("task") for dec in clock.get("decisions") or [] if dec.get("kind") != "ROY"}
        except (OSError, ValueError) as e:
            out.append("clock.json missing or unreadable (%s): the clock pre-pass did not run this slot"
                       % type(e).__name__)
    for a in actions:
        if a.get("move") == "leave" and a.get("task") in blocked - answered:
            out.append("leave recorded on blocked task %s: leave is not a move on a blocked task, the clock "
                       "owns it" % a.get("task"))
    return out


def walled_stuck(scratch=None):
    """How many of this slot's stuck views stand on a wall (board.json), 0 when it cannot be read."""
    scratch = scratch or os.environ.get("TASK_MANAGER_SCRATCH")
    try:
        board = json.loads((Path(scratch) / "board.json").read_text()) if scratch else {}
    except (OSError, ValueError):
        return 0
    return sum(1 for v in board.get("stuck") or [] if isinstance(v, dict) and v.get("blocker"))


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
    # A stuck task on a wall is the clock's, not the foreman's: a board whose stuck tasks all stand
    # on walls owes no action (review, 7 Oct 2026).
    if isinstance(stuck, int) and stuck - walled_stuck() > 0 and not actions:
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
                             ["Team Member", "Status", "Sent For Approval By",
                              "Agent Output", "Notes"],
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
        elif move == "escalate":
            # An escalation is a decision card (15 Sep 2026): Approval, sent
            # by the Task Manager, with a DECIDE: ask. Kevin may already have
            # answered it, which legitimately moves the status on.
            if TASKMGR_TEAM_REC not in (f.get("Sent For Approval By") or []):
                problems.append("claimed escalate on %s but Sent For Approval By is "
                                "not the Task Manager (no card reached Kevin)" % a["task"])
            elif "DECIDE:" not in str(f.get("Agent Output") or ""):
                problems.append("claimed escalate on %s but Agent Output carries no "
                                "DECIDE: ask" % a["task"])
            elif not card_recommended(f.get("Agent Output")):
                # A refused escalate recorded ok: true leaves the old thin
                # card, or none, behind (2 Oct 2026: no brief, no card).
                problems.append("claimed escalate on %s but the card carries no brief "
                                "(no RECOMMENDED: section): the escalate was refused" % a["task"])
        elif move in ("route", "chase") and a.get("to") not in team:
            problems.append("claimed %s of %s to %s but the link is absent"
                            % (move, a["task"], a.get("to")))
        elif move in GATE_MOVES:
            # TWO LEGITIMATE CLOSE PATHS, TWO DIFFERENT CHECKS (finding
            # 20260929-task-manager-board-663). A normal card goes to Kevin, so
            # Sent For Approval By holds the Task Manager. A Level A carry-out
            # is completed WITHOUT Kevin by agent-dispatch.py, which sets
            # Completed, CLEARS Sent For Approval By by design, and stamps the
            # HANDLED WITHOUT YOU marker into Notes. Demanding the card on both
            # made verify reject a correct, evidence-cited close and fail the
            # whole slot.
            if f.get("Status") not in ("Approval", "Completed"):
                problems.append("claimed %s on %s but status is %s (never "
                                "reached the gate)" % (move, a["task"], f.get("Status")))
            elif TASKMGR_TEAM_REC in (f.get("Sent For Approval By") or []):
                pass                                  # the card reached Kevin
            elif (f.get("Status") == "Completed"
                  and not (f.get("Sent For Approval By") or [])
                  and HANDLED_NOTE_MARK in str(f.get("Notes") or "")):
                pass                                  # Level A auto-carry-out
            else:
                problems.append(
                    "claimed %s on %s but neither path is proven: Sent For "
                    "Approval By is not the Task Manager and there is no "
                    "completed %s carry-out in Notes"
                    % (move, a["task"], HANDLED_NOTE_MARK))

    if not report.get("scoreWritten"):
        problems.append("score not written — the register reading silently froze")
    state = read_state()
    if date.today().isoformat() not in state.get("history", {}):
        problems.append("no score history entry for today — score claim is false")

    problems.extend(freshness_problems(board))
    problems.extend(ownerless_problems(actions))
    problems.extend(clock_problems(actions))

    verdict = {
        "verified": not problems,
        "problems": problems,
        "actionsChecked": checked,
        "actions": len(actions),
        "at": datetime.now(timezone.utc).isoformat(),
    }
    write_verdict(verdict)
    if problems:
        for p in problems:
            print("TASK-MANAGER VERIFY FAIL: %s" % p, file=sys.stderr)
        sys.exit(1)
    print(json.dumps({"verified": True, "actionsChecked": checked,
                      "actions": len(actions)}))


def freshness_problems(report_board, scratch=None, run_start=None):
    """The slot's own reads must be THIS slot's. Finding
    20260902-task-manager-17-435: the 17:00 pass reported 259 open tasks from
    a hand-rolled read while scratch/board.json still held the 13:00 slot's
    315, and said "gate.json not in scratch" while it sat there from 13:07.
    A report built on a board nobody re-read is a report about nothing. When
    the runner exports the run start, board.json and gate.json must be newer
    than it, and the report's open count must be the board's."""
    scratch = scratch or os.environ.get("TASK_MANAGER_SCRATCH")
    run_start = run_start if run_start is not None else os.environ.get("TASK_MANAGER_RUN_START")
    if not scratch or not run_start:
        return []
    try:
        start = float(run_start)
    except ValueError:
        return ["TASK_MANAGER_RUN_START is not an epoch: %r" % run_start]
    out = []
    for name in ("board.json", "gate.json"):
        p = Path(scratch) / name
        if not p.exists():
            out.append("%s missing from scratch — this slot never ran the %s read"
                       % (name, name.split(".")[0]))
            continue
        if p.stat().st_mtime < start:
            out.append("%s is from a PREVIOUS slot (older than this run's start) — "
                       "the board was never re-read this slot" % name)
            continue
        if name == "board.json":
            try:
                counts = (json.loads(p.read_text()).get("counts") or {})
            except (OSError, ValueError) as e:
                out.append("board.json unreadable: %s" % e)
                continue
            if counts.get("openTasksRead") != report_board.get("openTasksRead"):
                out.append("report says %s open tasks but board.json read %s — the "
                           "report was not built from this slot's board read"
                           % (report_board.get("openTasksRead"), counts.get("openTasksRead")))
    return out


def write_verdict(verdict):
    """verify-result.json in scratch: the machine-readable verdict the runner
    gates on. Written on pass AND fail, before any exit."""
    scratch = os.environ.get("TASK_MANAGER_SCRATCH")
    if not scratch:
        return
    try:
        Path(scratch).mkdir(parents=True, exist_ok=True)
        (Path(scratch) / "verify-result.json").write_text(json.dumps(verdict, indent=1))
    except OSError as e:
        print("TASK-MANAGER VERIFY FAIL: could not write verdict file: %s" % e,
              file=sys.stderr)


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
    # an approved Content Engine episode card open for two weeks is the engine's, never stuck (29 Sep 2026: nine live
    # episodes read as "approved but unpublished"); the same card still waiting on Kevin stays his
    ep = {"_id": "reczGy1PY7qryXw9b", "Created Time": old, "Status": "Today", "Task Type": "Drafting",
          "Task Name": "CONTENT: Publish Episode 2060 of Diary of a Runpreneur - LOVE YOUR PROBLEMS / GROW FASTER",
          "Approval Outcome": "Approved as-is", "Team Member": ["recRcy1Edas6rGaaF"], "Sent For Approval By": ["recRcy1Edas6rGaaF"]}
    assert classify(ep, set(), now)[0] == "ownLane", classify(ep, set(), now)
    assert classify(dict(ep, Status="Approval", **{"Approval Outcome": None}), set(), now)[0] == "waitingOnKevin"
    assert classify(dict(ep, **{"Team Member": ["recAgent1"]}), set(), now)[0] == "ownLane", "a re-routed episode card still closes itself"
    assert classify(dict(ep, **{"Team Member": [ROY_REC]}), set(), now)[0] == "ownLane", "whoever holds it"
    esc_ep = dict(ep, Notes="[22 Aug 2026 — agent-dispatch] Escalated to Kevin as a decision card (holder recRcy1Edas6rGaaF): DECIDE: x")
    esc_ep["Created Time"] = (now - timedelta(days=30)).isoformat()
    assert classify(esc_ep, set(), now)[0] == "ownLane", "an escalated or answered episode card is still the engine's"
    old_card = {"Task Name": "RENT FORM: direct rent payment form: Unit 9", "Status": "Today", "Approval Outcome": "Approved as-is",
                "Notes": "RENT FORM KEY: recX:form:1", "Created Time": old}
    assert classify(old_card, set(), now)[0] == "ownLane", "an approved form card waits for Kevin's turn, never stuck"
    assert classify(dict(old_card, **{"Task Name": "Renamed"}), set(), now)[0] == "ownLane", "either mark"
    assert classify(dict(old_card, **{"Status": "Approval", "Approval Outcome": None, "Sent For Approval By": ["rec7aHLK1Q8fMLRXH"]}),
                    set(), now)[0] == "waitingOnKevin", "a live card in his queue is his"
    legacy = dict(ep, Status="Approval", **{"Approval Outcome": None, "Sent For Approval By": None})
    assert classify(legacy, set(), now)[0] == "stuck", "an episode card outside Kevin's queue gets no verdict and never closes: stuck"
    perf = dict(ep, **{"Task Name": "CONTENT: Performance read for 9 August to 7 September"})
    assert classify(perf, set(), now)[0] == "stuck", "the engine's other cards do not close themselves: still board work"
    assert lane_view(dict(ep, _id="recE"), now)["episodeCard"] is True
    assert lane_view(dict(perf, _id="recP"), now)["episodeCard"] is False
    # Roy holds it → withRoy, never stuck, however old the stamps (the
    # 34-handovers bug); chaseDue only once a week from the last touch
    roy_old = {"_id": "recR1", "Created Time": old, "Team Member": [ROY_REC],
               "Notes": "[10 Aug 2026 — agent-dispatch] Handed over to Roy Lavin (roy): leak"}
    b, _, _ = classify(roy_old, set(), now)
    assert b == "withRoy", b
    bucket, _, view = task_view({"id": "recR1", "fields": roy_old}, set(), set(), now)
    assert bucket == "withRoy" and view["chaseDue"] is True, view
    roy_fresh = dict(roy_old, _id="recR2",
                     Notes=roy_old["Notes"] + "\n\n[23 Aug 2026 — agent] chase to roy: any news on the leak?")
    bucket, _, view = task_view({"id": "recR2", "fields": roy_fresh}, set(), set(), now)
    assert bucket == "withRoy" and view["chaseDue"] is False, view
    assert view["royLastTouch"].startswith("2026-08-23"), view
    # escalated inside the window → its own bucket, not stuck (the seven-times bug)
    esc = {"_id": "recE1", "Created Time": old, "Status": "Today",
           "Notes": "[20 Aug 2026 — agent-dispatch] Escalated to Kevin as a decision card: DECIDE: sell or keep?"}
    b, src, _ = classify(esc, set(), now)
    assert b == "escalated" and src == "escalateNote", (b, src)
    # …but a live card at Approval is Kevin's queue, and an old escalation is stuck again
    esc_card = dict(esc, _id="recE2", Status="Approval", **{"Sent For Approval By": ["rec1hYELb4zS8pjjO"]})
    assert classify(esc_card, set(), now)[0] == "waitingOnKevin"
    esc_old = dict(esc, _id="recE3", Notes=esc["Notes"].replace("20 Aug", "01 Aug"))
    assert classify(esc_old, set(), now)[0] == "stuck"
    # Kevin answered the card → decided, carrying his words for the foreman
    esc_done = dict(esc, _id="recE4", **{"Approval Outcome": "Approved as-is",
                                        "Approval Feedback": "Sell it.",
                                        "Agent Output": "DECIDE: sell or keep?",
                                        "Notes": esc["Notes"].replace("decision card:", "decision card (holder recAgentX):")})
    bucket, _, view = task_view({"id": "recE4", "fields": esc_done}, set(), set(), now)
    assert bucket == "decided" and view["approvalFeedback"] == "Sell it.", (bucket, view)
    assert view["ask"] == "DECIDE: sell or keep?" and view["priorHolder"] == ["recAgentX"], view
    assert view["recommended"] == "", view   # a card from before the brief names no move
    briefed = dict(esc_done, **{"Approval Feedback": "", "Agent Output": (
        "DECIDE: sell or keep?\n\nWHAT THIS IS:\nA house.\n\nOPTIONS:\nA. Sell\nB. Keep\n\n"
        "RECOMMENDED: B, keep it:\nthe rent covers the mortgage.\n\nLINKS AND FILES:\n- x\n\n"
        "Earlier output:\nRECOMMENDED: an old draft's line")})
    _, _, view = task_view({"id": "recE4", "fields": briefed}, set(), set(), now)
    assert view["recommended"] == "B, keep it: the rent covers the mortgage.", view
    assert card_recommended("RECOMMENDED: B, keep it.\nSINCE YOU LAST ANSWERED: the buyer withdrew.") == "B, keep it."
    # a thin card names no move, even when an earlier draft under it used the word
    assert card_recommended("DECIDE: x\n\nEarlier output:\nRECOMMENDED: an old draft's line") == ""
    # his answer does not expire: answered eight days after the card went up, it is still decided
    late = dict(esc_done, _id="recE6", Notes=esc_done["Notes"].replace("20 Aug", "01 Aug"))
    assert classify(late, set(), now)[0] == "decided", classify(late, set(), now)
    # carried out and asked again on the same day, then answered: still decided (the stamps have no time)
    same_day = dict(late, Notes=late["Notes"] + "\n\n[01 Aug 2026 — agent-dispatch] Decision carried out: x")
    assert classify(same_day, set(), now)[0] == "decided", classify(same_day, set(), now)
    # parked on his answer: not stuck before the date, ordinary work again once the date arrives
    held = dict(late, _id="recE7", Status="Upcoming", **{"Approval Outcome": None, "Due Date": "2026-12-01",
                "Agent Output": "DECIDED (Kevin, 02 Aug 2026): Approved as-is — Leave it.\n\nDECIDE: sell or keep?"},
                Notes=late["Notes"] + "\n\n[02 Aug 2026 — agent-dispatch] Decision carried out: Approved as-is — Leave it.\nsecond line"
                                      "\n\n[02 Aug 2026 — agent-dispatch] Parked until 2026-12-01 on Kevin's answer; it comes back on the board that day.")
    assert classify(held, set(), now) [:2] == ("parked", "decidedUntil"), classify(held, set(), now)
    assert classify(dict(held, **{"Due Date": now.date().isoformat()}), set(), now)[0] == "stuck"   # the date has come
    assert classify(dict(held, Status="Today"), set(), now)[0] == "stuck"                            # flip-due moved it
    assert classify(dict(held, Notes=late["Notes"]), set(), now)[0] != "parked"                      # future-dated, but not on his answer
    # ...but an old escalation nobody answered is stuck again, and a carried-out one is ordinary work
    assert classify(dict(late, **{"Approval Outcome": None}), set(), now)[0] == "stuck"
    carried_late = dict(late, **{"Approval Outcome": None, "Agent Output": "DECIDED (Kevin, 02 Aug 2026): Approved as-is\n\nDECIDE: sell or keep?"},
                        Notes=late["Notes"] + "\n\n[02 Aug 2026 — agent-dispatch] Decision carried out: x")
    assert classify(carried_late, set(), now)[0] == "stuck", classify(carried_late, set(), now)
    # once the decision is carried out (a newer stamp), the card is closed:
    # the task is ordinary work again, not decided and not escalated
    carried = dict(esc_done, _id="recE5", **{"Approval Outcome": None,
                   "Notes": esc_done["Notes"] + "\n\n[22 Aug 2026 — agent-dispatch] Decision carried out: Approved as-is — Sell it."})
    assert classify(carried, set(), now)[0] == "stuck", classify(carried, set(), now)
    # a Roy-held LIVE card is Kevin's decision, not a chase
    roy_card = dict(roy_old, _id="recR3", Status="Approval",
                    **{"Sent For Approval By": ["rec1hYELb4zS8pjjO"]})
    assert classify(roy_card, set(), now)[0] == "waitingOnKevin"
    assert newest_note_stamp("no stamps here", ESCALATE_NOTE_MARK) is None
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
    assert gs[0]["folds"] == [], gs
    assert sum(len(g["closable"]) for g in gs) == 0
    # an Approval twin FOLDS when the fold check reads it as one matter with
    # the keeper (15 Sep 2026): same lane, enough shared non-address words.
    # The keeper at Approval stays untouchable; the twin becomes closable
    # with its reason quoted. The real dupe_verdict runs here, not a stub.
    gs = duplicate_groups([
        {"id": "k1", "name": "INBOUND: pay Sefton landlord licence fee 150 GBP for 23 Viola Street Bootle",
         "inboundUrl": "https://mail.google.com/mail/u/0/#all/TH5", "createdTime": "2026-08-01T10:00:00.000Z", "status": "Approval"},
        {"id": "k2", "name": "INBOUND: Sefton Council HMO licence fee invoice - 23 Viola St",
         "inboundUrl": "https://mail.google.com/mail/u/0/#all/TH5", "createdTime": "2026-08-03T10:00:00.000Z", "status": "Approval"},
    ])
    assert gs[0]["keeper"] == "k1" and gs[0]["closable"] == ["k2"], gs
    assert gs[0]["untouchable"] == ["k1"] and gs[0]["folds"][0]["id"] == "k2", gs
    assert "licence" in gs[0]["folds"][0]["why"], gs
    # ... and stays untouchable when the names share only an address: a
    # garden complaint and a rent chase at one house are two matters.
    gs = duplicate_groups([
        {"id": "u1", "name": "INBOUND: rent arrears chase 23 Viola Street Bootle",
         "inboundUrl": "https://mail.google.com/mail/u/0/#all/TH6", "createdTime": "2026-08-01T10:00:00.000Z", "status": "Today"},
        {"id": "u2", "name": "INBOUND: garden fence complaint 23 Viola Street Bootle",
         "inboundUrl": "https://mail.google.com/mail/u/0/#all/TH6", "createdTime": "2026-08-03T10:00:00.000Z", "status": "Approval"},
    ])
    assert gs[0]["closable"] == [] and gs[0]["untouchable"] == ["u2"] and gs[0]["folds"] == [], gs
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
    ck = sub.add_parser("clock")
    ck.add_argument("--dry-run", action="store_true",
                    help="decide every wall and Roy hand-off, write nothing to Airtable or the findings queue")
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
    elif a.cmd == "clock":
        cmd_clock(a.dry_run)
    elif a.cmd == "selftest":
        cmd_selftest()


if __name__ == "__main__":
    main()
