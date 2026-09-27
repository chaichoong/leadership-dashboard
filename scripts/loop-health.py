#!/usr/bin/env python3
"""Approval-loop health — what should have moved and did not.

Kevin lost trust in the agent loop on 14 Aug 2026, and every failure behind
that was invisible to the surfaces that existed:

  - 10 amendments sat up to 9 days. Their Status was "Today", never "Approval",
    so no approvals list could ever have shown them.
  - 8 inbound messages were never drafted. They never reached approval at all.
  - WhatsApp was never read, so nothing was created to be missing.

A list of what ARRIVED cannot show any of that, and neither can a list of what
completed: silence looks identical to "nothing needed doing". Only "should have
moved and did not" catches it.

This is the same definition the Approvals tab uses (computeApprovalLoop in
os/tasks/index.html). Two copies of a rule is how a check ends up quietly
measuring something different from what it claims, so the thresholds are
asserted equal by tests/loop-health.test.js.

Usage:  python3 scripts/loop-health.py [--json]
Auth:   ~/.config/od/airtable_pat (never printed).
Exit:   0 always on a successful read — this reports, it does not gate.
        1 if the read itself failed or the control found no agent tasks, which
          would otherwise print "nothing is stuck" from a broken query.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

BASE_ID = "appnqjDpqDniH3IRl"
TASKS = "tblqB8b22hKBL4PF1"
TEAM = "tblco0p2OnlLQVAX7"

# MUST match STALL_* in os/tasks/index.html. Guarded by tests/loop-health.test.js.
STALL_AMEND_HOURS = 48   # amended, and the agent has not redone it
STALL_DRAFT_HOURS = 24   # an agent owns it, it is DUE, and nothing is drafted
STALL_DECIDE_DAYS = 5    # sat waiting on a human this long
STALL_DEADLINE_DAYS = 3  # a hard deadline this close (or past) with the task open

# The statuses agent-dispatch.py actually works from (its OPEN_STATUSES). An
# "Upcoming" task is scheduled, not late. Counting it as stalled made the first
# run report 156 items, 101 of them merely future-dated — and a list that long
# is noise, which is precisely what stops it being read.
STALL_DUE_STATUSES = ("Today", "Overdue")

CLOSED = ("Completed", "Cancelled")

# Every status any surface reads (15 Sep 2026). A task stored outside this
# set is on NO surface: not the queue, not the gate, not Kevin's board.
BOARD_STATUSES = ("Today", "Upcoming", "Overdue", "Approval", "Completed", "Cancelled")

# The lanes a stalled row is named with, so the Estate tab says WHY it is
# not moving rather than only that it is not (15 Sep 2026):
#   withKevin     a live card in his gate
#   deferred      knocked back to a date that has not arrived
#   signInNeeded  the agent stopped on a SIGN-IN NEEDED line only Kevin can clear
#   withRoy       Roy Lavin holds it (his lane, chased weekly)
#   invisible     on no surface: a non-board status, or Approval with no sender
#   withAgent     an agent holds it inside the dispatch window
LANES = ("withKevin", "deferred", "signInNeeded", "withRoy", "invisible", "withAgent")
SIGNIN_RE = re.compile(r"^\s*SIGN-IN NEEDED:\s*\S", re.I | re.M)
ROY_NAME = "Roy Lavin"


def in_dispatch_window(status, due_date, today, some_day=False):
    """The queue's window, for a record in hand: Today, Overdue, or Upcoming
    whose due date has arrived (never a Some Day task). Mirrors QUEUE_FORMULA
    in agent-dispatch.py and _inDispatchWindow in os/tasks/index.html
    (tests/loop-health.test.js runs both sides over the same fixtures).
    `today` is the London date; Airtable's own TODAY() is UTC."""
    if status in STALL_DUE_STATUSES:
        return True
    due = str(due_date or "")[:10]
    return status == "Upcoming" and bool(due) and not some_day and due <= today


def invisible_reason(f):
    """Why no surface can show this open task, or '' when one can. Mirrors
    _invisibleReason in os/tasks/index.html."""
    status = f.get("Status") or ""
    if status not in BOARD_STATUSES:
        return (f"Status '{status}' is not a board status: no queue, gate or board reads it"
                if status else "No Status at all: no queue, gate or board reads it")
    if status == "Approval" and not (f.get("Sent For Approval By") or []):
        return "At Approval with no sender, so the gate cannot show it"
    return ""


def lane_for(f, roy_ids, today):
    """Which lane a stalled task sits in — see LANES."""
    status = f.get("Status") or ""
    if invisible_reason(f):
        return "invisible"
    if status == "Approval":
        deferred = str(f.get("Deferred Until") or "")[:10]
        return "deferred" if deferred and deferred > today else "withKevin"
    if any(x in roy_ids for x in (f.get("Team Member") or [])):
        return "withRoy"
    if SIGNIN_RE.search(str(f.get("Agent Output") or "")):
        return "signInNeeded"
    return "withAgent"

KEVIN_AIRTABLE_EMAIL = "kevin@runpreneur.org.uk"

# Same order as the tab: by how much it needs someone, not raw age. The draft
# rule carries no day count, so sorting the whole list by age would sink every
# "an agent has drafted nothing" item below every dated one — and that is the
# rule that catches work never being started at all.
RULE_ORDER = {"invisible": 0, "deadline": 1, "amend": 2, "draft": 3, "decide": 4}
LONDON = ZoneInfo("Europe/London")

# The UC verification lane routinely holds open tasks past their date (its
# dates are enforced by the dedicated UC watchdog, not this report). On the
# day the deadline rule was written it would have contributed 24 of 30 hits —
# a flood that buries the six real ones, which is exactly how lists stop
# being read. Excluded by name prefix, here and in the invariant.
DEADLINE_EXCLUDE_PREFIX = "UC verification:"


def pat():
    with open(os.path.expanduser("~/.config/od/airtable_pat")) as fh:
        return fh.read().strip()


def fetch(table, fields=None, formula=None):
    """Paginated read. A hand-rolled Airtable read that ignores the offset
    token silently measures only the first page — the exact bug that made the
    recon-accuracy card report 66/100 against a true 167/259 for a month."""
    token, out, offset = pat(), [], None
    while True:
        q = {"pageSize": "100"}
        if formula:
            q["filterByFormula"] = formula
        if offset:
            q["offset"] = offset
        url = f"https://api.airtable.com/v0/{BASE_ID}/{table}?" + urllib.parse.urlencode(q)
        if fields:
            url += "".join("&fields%5B%5D=" + urllib.parse.quote(f) for f in fields)
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req) as resp:
            data = json.load(resp)
        out += data.get("records", [])
        offset = data.get("offset")
        if not offset:
            return out


def hours_since(value, now):
    if not value:
        return None
    raw = str(value)
    try:
        # Airtable returns date-only for Date fields and ISO-Z for dateTime.
        dt = (datetime.strptime(raw, "%Y-%m-%d").replace(tzinfo=timezone.utc)
              if len(raw) == 10 else
              datetime.fromisoformat(raw.replace("Z", "+00:00")))
    except ValueError:
        return None
    return (now - dt).total_seconds() / 3600.0


def days_until(value, now):
    """Date-only field → whole days from now's UTC date (negative = past)."""
    if not value:
        return None
    try:
        d = datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None
    return (d - now.date()).days


def compute(tasks, agent_ids, now=None, roy_ids=()):
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(LONDON).date().isoformat()
    needs_you, done, stalled = [], [], []

    for r in tasks:
        f = r.get("fields", {}) or {}
        name = f.get("Task Name") or "(untitled)"
        status = f.get("Status") or ""
        completion = f.get("Completion Date")
        owned = any(x in agent_ids for x in (f.get("Team Member") or []))
        is_open = status not in CLOSED and not completion

        # Assigned to Kevin, or to nobody. The tab filters the same way against
        # the logged-in user; without this the DM says 29 while the page Mica is
        # looking at says nothing is waiting on her.
        if status == "Approval":
            who = (f.get("Assignee") or {}).get("email", "").lower()
            if not who or who == KEVIN_AIRTABLE_EMAIL:
                needs_you.append({"id": r["id"], "name": name})

        if owned and completion:
            h = hours_since(completion, now)
            if h is not None and h <= 7 * 24:
                done.append({"id": r["id"], "name": name, "completedAt": completion})

        if not is_open:
            continue

        # -1. On NO surface (15 Sep 2026). A status outside the set every
        #    reader keys on, or an Approval row with no sender: the queue,
        #    the gate and the board all skip it, so nothing else here would
        #    ever fire for it. The lane is the reason.
        hidden = invisible_reason(f)
        if hidden:
            stalled.append({"id": r["id"], "name": name, "rule": "invisible",
                            "days": 0, "why": hidden})
            continue

        # 0. A hard deadline — a real-world date lifted from the letter itself
        #    (a court date, a pay-by, a filing window) — inside the warning
        #    window or already past, with the task still open. Fires whatever
        #    the status, INCLUDING Approval: a deadline does not pause while
        #    the draft waits for a decision. This is the rule the whole
        #    deadline chain exists for (dated response windows closed unread,
        #    3 Jul – 24 Aug 2026).
        if (f.get("Hard Deadline") and f.get("Due Date")
                and not str(name).startswith(DEADLINE_EXCLUDE_PREFIX)):
            left = days_until(f.get("Due Date"), now)
            if left is not None and left <= STALL_DEADLINE_DAYS:
                due = str(f.get("Due Date"))[:10]
                why = (f"Hard deadline {due} passed {-left} days ago and it is still open"
                       if left < 0 else
                       f"Hard deadline {due} is TODAY" if left == 0 else
                       f"Hard deadline {due} is {left} days away")
                stalled.append({"id": r["id"], "name": name, "rule": "deadline",
                                "days": max(0, -left), "why": why})
                continue

        # 1. Kevin asked for changes and nothing came back.
        if f.get("Approval Outcome") == "Changes requested" and status != "Approval":
            h = hours_since(f.get("Approved At"), now)
            if h is not None and h > STALL_AMEND_HOURS:
                stalled.append({"id": r["id"], "name": name, "rule": "amend",
                                "days": int(h // 24),
                                "why": f"You asked for changes {int(h // 24)} days ago and it has not come back"})
                continue

        # 2. An agent owns it, it is DUE, and it has produced nothing. No day
        #    count: these are usually old tasks routed to an agent recently, so
        #    "has had this 499 days" would measure the wrong thing and be false.
        if (owned and not f.get("Agent Output")
                and in_dispatch_window(status, f.get("Due Date"), today, bool(f.get("Some Day")))):
            h = hours_since(f.get("Created Time"), now)
            if h is not None and h > STALL_DRAFT_HOURS:
                stalled.append({"id": r["id"], "name": name, "rule": "draft", "days": 0,
                                "why": ("Overdue, and the agent has drafted nothing"
                                        if status == "Overdue" else
                                        "Due, and the agent has drafted nothing")})
                continue

        # 3. Sat waiting on a human for too long. Anchored to the Slack post
        #    time, the only true "sent for approval" stamp on the record. Due
        #    Date looks like one and is not: the rescheduler moves it to today,
        #    so 28 of 29 waiting approvals read as due today however long they
        #    had sat, and this rule silently never fired.
        if status == "Approval" and f.get("Approval Slack TS"):
            try:
                secs = float(str(f["Approval Slack TS"]).split(".")[0])
            except ValueError:
                secs = None
            if secs:
                h = (now - datetime.fromtimestamp(secs, timezone.utc)).total_seconds() / 3600.0
                if h > STALL_DECIDE_DAYS * 24:
                    stalled.append({"id": r["id"], "name": name, "rule": "decide",
                                    "days": int(h // 24),
                                    "why": f"Waiting on your decision for {int(h // 24)} days"})

    done.sort(key=lambda d: d["completedAt"], reverse=True)
    stalled.sort(key=lambda s: (RULE_ORDER.get(s["rule"], 9), -s["days"]))
    by_id = {r["id"]: (r.get("fields") or {}) for r in tasks}
    for s in stalled:
        s["lane"] = lane_for(by_id.get(s["id"], {}), set(roy_ids), today)
    return {"needsYou": needs_you, "done": done, "stalled": stalled}


def report():
    """The whole read-and-compute pass, with its controls, as one dict.
    Shared with scripts/estate-status.py (14 Sep 2026), which writes the
    stalled list onto the Estate Status table for the AI Agents page. Raises
    on a broken read or a failed control; never returns an all-clear from a
    query that found nothing."""
    try:
        team = fetch(TEAM, ["Name", "Is AI Agent"])
        # Open tasks, plus completions inside the Done window. Reading the whole
        # table meant 74 sequential pages and 1m45s of wall clock every morning
        # in daily-ops phase 9, to look at ~300 relevant rows out of 7,400.
        #
        # The window is deliberately a superset (8 days, from UTC midnight) and
        # is narrowed to 168h in compute(), so a timezone edge cannot silently
        # clip a completion out of the report.
        tasks = fetch(TASKS, ["Task Name", "Status", "Team Member", "Approval Outcome",
                              "Approved At", "Agent Output", "Completion Date",
                              "Created Time", "Approval Slack TS", "Assignee",
                              "Due Date", "Hard Deadline", "Sent For Approval By",
                              "Deferred Until", "Some Day"],
                      formula=('OR({Status}!="Completed",'
                               "IS_AFTER({Completion Date},DATEADD(TODAY(),-8,'days')))"))
    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as exc:
        raise RuntimeError(f"could not read Airtable — {exc}")

    agent_ids = {r["id"] for r in team if (r.get("fields") or {}).get("Is AI Agent")}
    # Roy's row by name, from the same Team Members read — never a typed id.
    roy_ids = {r["id"] for r in team if (r.get("fields") or {}).get("Name") == ROY_NAME}

    # CONTROLS. Every rule here fires on the ABSENCE of something, so a field
    # that silently stops being populated turns this report into a permanent
    # all-clear. Each control asserts the population a rule reads is non-empty.
    #
    # An unknown field name returns 422 and is caught above, loudly. What these
    # catch is the quieter failure: a real field nobody writes to any more.
    fields = [(r.get("fields") or {}) for r in tasks]
    open_tasks = [f for f in fields
                  if (f.get("Status") or "") not in CLOSED and not f.get("Completion Date")]
    controls = {
        # Counted over OPEN tasks only. The old version counted all 7,400 rows,
        # 7,099 of them Completed, so it passed on history alone even if every
        # open agent task had vanished.
        "open tasks linked to an AI agent":
            sum(1 for f in open_tasks
                if any(x in agent_ids for x in (f.get("Team Member") or []))),
        # Rule 3's population: what is sitting at Kevin's gate right now.
        #
        # This control used to count "waiting approvals carrying an Approval
        # Slack TS". That stamp died when per-task approval cards to Kevin were
        # retired on 1 Sep 2026 (the Slack notification contract), and on
        # 24 Sep 2026 ZERO tasks in the whole table carried it — so the control
        # was zero, and this script, the only surface in daily-ops that reports
        # what SHOULD have moved and did not, exited 1 every morning and
        # reported nothing at all (finding 20260924-report-596).
        #
        # A control must match the population the bug would corrupt, not the
        # mechanism that happens to be nearest it. Every one of the 28 tasks at
        # Approval on 24 Sep carries Sent For Approval By, because the gate
        # itself writes it, so that is the population.
        "waiting approvals sent for approval":
            sum(1 for f in fields
                if f.get("Status") == "Approval" and f.get("Sent For Approval By")),
        # Rule 2 fires on the ABSENCE of Agent Output. If the field stopped being
        # written, every agent task would look undrafted and the list becomes
        # noise rather than signal — the opposite failure, equally useless.
        "tasks carrying Agent Output":
            sum(1 for f in fields if f.get("Agent Output")),
        # Rule 0's population. Triage stamps the flag from the letter's
        # Deadline line; if that stops, the deadline rule reports all-clear
        # for ever — the pre-25-Aug failure this chain was built to end.
        "tasks carrying Hard Deadline":
            sum(1 for f in fields if f.get("Hard Deadline")),
    }
    if not agent_ids:
        controls["AI agent records"] = 0
    # The withRoy lane keys on his row by name; a renamed row would silently
    # turn every Roy-held task into withAgent, so it is a control.
    controls["Roy Lavin's Team Members row"] = len(roy_ids)
    failed = [k for k, v in controls.items() if not v]
    if failed:
        detail = ", ".join(f"{k} = {v}" for k, v in controls.items())
        raise RuntimeError(f"control failed — {', '.join(failed)} is zero. Refusing to report "
                           f"an all-clear from a query that found nothing. ({detail})")
    linked = controls["open tasks linked to an AI agent"]

    res = compute(tasks, agent_ids, roy_ids=roy_ids)
    # A TRUST SURFACE MUST REPORT WHAT IT CANNOT SEE. Swapping the control
    # above lets the other four rules report again, and on its own that would
    # be worse than the crash: rule 3 would read "nothing waiting too long"
    # while its anchor stays dead, and a silent zero from a rule that cannot
    # fire is the exact failure this file was built to end. So the absence is
    # named, counted, and carried in the result every consumer already reads.
    waiting = sum(1 for f in fields if f.get("Status") == "Approval")
    anchored = sum(1 for f in fields
                   if f.get("Status") == "Approval" and f.get("Approval Slack TS"))
    res["degraded"] = []
    if waiting and not anchored:
        res["degraded"].append(
            "decide rule BLIND: %d task(s) sit at your approval gate and none "
            "carries an Approval Slack TS, the only 'sent for approval' time on "
            "the record. How long each has waited cannot be measured, so "
            "'waiting on your decision' reports nothing until the approval path "
            "stamps a time again (finding 20260924-report-596)." % waiting)
    res["control"] = {"agents": len(agent_ids), "agentLinkedTasks": linked,
                      "tasksRead": len(tasks), "royRows": len(roy_ids),
                      "waitingApprovals": waiting, "decideAnchored": anchored}
    res["lanes"] = {lane: sum(1 for s in res["stalled"] if s["lane"] == lane) for lane in LANES}
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    try:
        res = report()
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
    tasks_read = res["control"]["tasksRead"]; linked = res["control"]["agentLinkedTasks"]

    if args.json:
        print(json.dumps(res, indent=2))
        return

    print(f"Approval loop — {tasks_read} tasks read, {linked} agent-linked")
    for line in res.get("degraded", []):
        print(f"  CANNOT CHECK: {line}")
    print(f"  Needs Kevin : {len(res['needsYou'])}")
    print(f"  Done (7d)   : {len(res['done'])}")
    print(f"  NOT MOVING  : {len(res['stalled'])}  "
          + ", ".join(f"{k} {v}" for k, v in res["lanes"].items() if v))
    for s in res["stalled"]:
        print(f"    - [{s['lane']}] {s['name'][:64]}\n        {s['why']}")


if __name__ == "__main__":
    main()
