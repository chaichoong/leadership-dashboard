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
import importlib.util
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

# A property certificate task stamped HELD UNDER an open lead is being worked, in one job, BY that
# lead: agent-dispatch.py groups a certificate type plus a postcode district, the earliest-due task
# leads, and every sibling gets this note. 13 Oct 2026 (finding 20261013-phase-5-851): 17 of the 40
# NOT MOVING rows were these siblings, every one reading "the agent has drafted nothing" — true of
# the row, false of the work. The list is ordered by how much each item needs someone, so 17
# invented rows pushed the two that genuinely needed Kevin (a certificate decision that alone gates
# four certificates, and an insurance purchase at his approval gate) down a 40-line list.
# Matches agent-dispatch.py's own HELD_UNDER_RE. A hold only counts while the lead is still OPEN, so
# a sibling whose lead has closed goes back to being stalled rather than hiding for ever.
HELD_UNDER_RE = re.compile(r"HELD UNDER (rec[A-Za-z0-9]{14})")
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
RULE_ORDER = {"invisible": 0, "deadline": 1, "amend": 2, "draft": 3, "decide": 4,
              # Python only (14 Oct 2026): added by report(), not compute(), so the
              # Approvals tab's mirror of compute() is untouched (reply_overdue_rows).
              "reply": 5}
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

    # The open leads, read before the loop: a HELD UNDER note only suppresses the draft rule while
    # the lead it names is still open.
    open_ids = {r.get("id") for r in tasks
                if (r.get("fields") or {}).get("Status") not in CLOSED
                and not (r.get("fields") or {}).get("Completion Date")}

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
        held = HELD_UNDER_RE.search(str(f.get("Notes") or ""))
        held_by_open_lead = bool(held and held.group(1) in open_ids)
        if (owned and not f.get("Agent Output") and not held_by_open_lead
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
        team_agents = {r["id"] for r in team if (r.get("fields") or {}).get("Is AI Agent")}
        # The open agent tasks counted a second way, by Airtable's own formula,
        # before and after the main read (agent_work compares them; review of
        # PR #782). Bracketing tells a real disagreement from the board moving
        # while it was read.
        open_before = open_agent_ids(team_agents)
        # Open tasks, plus completions inside the Done window. Reading the whole
        # table meant 74 sequential pages and 1m45s of wall clock every morning
        # in daily-ops phase 9, to look at ~300 relevant rows out of 7,400.
        #
        # The window is deliberately a superset (8 days, from UTC midnight) and
        # is narrowed to 168h in compute(), so a timezone edge cannot silently
        # clip a completion out of the report.
        # Notes since 14 Oct 2026: the Agent Work card reads the keep-open
        # carry-out line and any open blocker there (reply_wait). About 2.6 MB
        # of the ~4.5 MB read.
        tasks = fetch(TASKS, ["Task Name", "Status", "Team Member", "Approval Outcome",
                              "Approved At", "Agent Output", "Completion Date",
                              "Created Time", "Approval Slack TS", "Assignee",
                              "Due Date", "Hard Deadline", "Sent For Approval By",
                              "Deferred Until", "Some Day", "Notes"],
                      formula=('OR({Status}!="Completed",'
                               "IS_AFTER({Completion Date},DATEADD(TODAY(),-8,'days')))"))
        open_after = open_agent_ids(team_agents)
    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as exc:
        raise RuntimeError(f"could not read Airtable — {exc}")

    agent_ids = team_agents
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
    res["flow"] = agent_flow(fields, agent_ids, linked, len(res["done"]))
    now = datetime.now(timezone.utc)
    # A reply waited on too long is not moving, so it goes on the list a person
    # reads, under its own rule, and the card counts it from there (review of
    # PR #782: four stuck tasks were on no list). Needs agent-dispatch.py, which
    # owns the rules; if it cannot load, agent_work says so and nothing is added.
    ledger = ledger_err = None
    ledger_skipped = 0
    added = []
    try:
        dispatcher()
        rules_loaded = True
    except Exception:  # noqa: BLE001 — not swallowed: agent_work loads it again and names the failure (splitCheck)
        rules_loaded = False
    if rules_loaded:
        ledger, ledger_err, ledger_skipped = carryout_ledger()
        added = reply_overdue_rows(tasks, now, ledger, roy_ids, {s["id"] for s in res["stalled"]})
    if added:
        res["stalled"] = sorted(res["stalled"] + added,
                                key=lambda s: (RULE_ORDER.get(s["rule"], 9), -s["days"]))
    res["lanes"] = {lane: sum(1 for s in res["stalled"] if s["lane"] == lane) for lane in LANES}
    held_ids, held_err = dispatch_held_ids(now)
    try:
        res["agentWork"] = agent_work(tasks, agent_ids, res["stalled"], held_ids, held_err, now=now,
                                      ledger=ledger, ledger_error=ledger_err, ledger_skipped=ledger_skipped,
                                      open_check=(open_before, open_after))
    except SplitCheckFailed as exc:
        # Only the card's split is withdrawn: it shows the plain open count, amber, with
        # this reason. The stalled list above and every other number still stand.
        aw = exc.partial
        aw.update(dict.fromkeys(WORK_BUCKETS))
        aw["splitCheck"] = str(exc)
        res["agentWork"] = aw
    return res


def agent_flow(fields, agent_ids, open_linked, done_7d, now=None):
    """In versus out for the AI team card on the Leadership Dashboard (Kevin, 9 Oct 2026):
    agent tasks created in the last 7 days against agent tasks done in the same 7 days.
    The read above covers every task created in the window (open, or completed inside
    8 days), so the count is whole, not a sample."""
    now = now or datetime.now(timezone.utc)
    created = 0
    for f in fields:
        if not any(x in agent_ids for x in (f.get("Team Member") or [])):
            continue
        h = hours_since(f.get("Created Time"), now)
        if h is not None and h <= 7 * 24:
            created += 1
    return {"agentOpen": open_linked, "agentCreated7d": created, "agentDone7d": done_7d}


# ─── the Agent Work card, split (Kevin, 14 Oct 2026) ──────────────────
# The card read "190 open, 46 not moving" and Kevin took it as "nothing is
# working". A live recount that afternoon: of 185 open agent tasks, 64 were
# scheduled for later (some to June 2027), 18 were with him at Approval, and
# about 40 had been carried out and were only waiting on an outside reply.
# And 19 of the 46 "not moving" were not stuck agent work at all: a task Roy
# holds, which the deadline rule counted, and compliance tasks the dispatcher
# holds on purpose under an open lead task. So the card leads with LIVE work,
# and counts as stuck only agent tasks the dispatcher is not holding on purpose.
# The stalled list gains one rule, "reply" (report() adds it; the Approvals
# tab's mirror of compute() is unchanged), so every task the card counts as
# stuck is on the Estate tab's list.
#
# `other` is a task on no board at all (lane_for's "invisible"): never folded
# into live, where it would look like work an agent is doing.
WORK_BUCKETS = ("live", "approval", "waitingReply", "scheduled", "other")

# The dispatcher's own list of tasks it holds on purpose under an open lead
# task (agent-dispatch.py queue, key heldUnderLead): property siblings grouped
# under one lead, a sibling submitted under a lead that is still open, and the
# twin of a request Roy is handling. Read from the queue the half-hourly
# hand-back poll writes (scripts/handback-poll-run.sh, atomically), never
# recomputed here: three rules and the worklist cap decide it, and a second
# copy would drift.
DISPATCH_QUEUE = os.path.expanduser("~/knowledge-os/logs/handback-poll/scratch/queue.json")
DISPATCH_QUEUE_MAX_MIN = 120   # written every 30 minutes; older than this, the poll has stopped

# How long a carried-out task may wait on an outside reply before it counts as
# stuck (review of PR #782). Loop-health's own number, not the dispatcher's
# REPLY_WINDOW_DAYS, which is the rent check's window for matching a reply to
# a card and happens to be 14 too. Two weeks: a reply, a certificate or a
# visit that has not come by then needs chasing or a new plan, and a list of
# what to chase is the point of Stuck.
REPLY_STUCK_DAYS = 14
HERE = os.path.dirname(os.path.abspath(__file__))
_DISPATCH = {}


def dispatcher():
    """agent-dispatch.py, loaded once. The rules that decide whether a task is
    waiting (the carry-out mark, the approved outcomes, the open blocker and the
    carry-out ledger) are read from it, never copied."""
    if "m" not in _DISPATCH:
        spec = importlib.util.spec_from_file_location("agent_dispatch_for_loop_health",
                                                      os.path.join(HERE, "agent-dispatch.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _DISPATCH["m"] = mod
    return _DISPATCH["m"]


def _aware(value):
    """An ISO time as an aware datetime, or None. A time with no zone is None:
    it cannot be ordered against anything else here."""
    try:
        t = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else None


def carried_out_days(notes):
    """London dates of the task's OWN keep-open carry-out lines, oldest first.

    What `complete --keep-open` writes (agent-dispatch.py cmd_complete):
    "[14 Oct 2026 — agent] CARRIED OUT (task left open): ...". Only the
    bracketed line counts. A TRACK RECORD block quotes OTHER tasks' carry-outs
    as "- 09 Oct 2026 — agent: CARRIED OUT ...", and at 17:05 on 14 Oct 2026,
    12 open agent tasks carried only those. tests/ai-team-health.test.js runs
    the real cmd_complete and reads its note back through this."""
    mark = re.escape(dispatcher().CARRIED_OUT_MARK)
    out = []
    for raw in re.findall(r"\[(\d{1,2} [A-Z][a-z]{2} \d{4}) — agent\] " + mark, str(notes or "")):
        try:
            out.append(datetime.strptime(raw, "%d %b %Y").date())
        except ValueError:
            continue
    return sorted(out)


def carryout_ledger(path=None):
    """({task id: [(event, aware time)] oldest first}, None, lines skipped) from
    the dispatcher's carry-out ledger, or (None, why not, 0). `complete
    --keep-open` logs "done" there with a full time; `block` logs "parked", a
    cleared wall "unblocked", a run about to act "intent". The Notes stamp holds
    the date only, so the ledger is what tells a same-day approval from the
    carry-out it followed.

    One bad line is skipped and counted, never fatal (review of PR #782): a stray
    byte is replaced, not raised, and a line that is not a whole record with a
    zoned time is left out."""
    path = path or dispatcher().INTENT_LEDGER
    out, skipped = {}, 0
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    skipped += 1
                    continue
                when = _aware(rec.get("ts")) if isinstance(rec, dict) else None
                if not (when and rec.get("task") and rec.get("event")):
                    skipped += 1
                    continue
                out.setdefault(rec["task"], []).append((rec["event"], when))
    except FileNotFoundError:
        return None, "no carry-out ledger at %s" % path, 0
    except (OSError, ValueError) as exc:
        return None, "the carry-out ledger could not be read: %s" % str(exc)[:120], 0
    for events in out.values():
        events.sort(key=lambda e: e[1])
    return out, None, skipped


def reply_wait(f, now, events=None):
    """For an approved task in the dispatch window: "waiting" when Kevin's
    approved action was carried out and the task kept open on purpose, so it
    waits on someone outside (a reply, a certificate, a visit); "overdue" when
    that wait is longer than REPLY_STUCK_DAYS, which makes it live AND stuck;
    "" for anything else, which is live.

    Not waiting (review of PR #782, 14 Oct 2026):
      - an open blocker (task_blocker): it waits on a wall, not a reply. The
        live case: carried out 7 Oct, a code-fix wall open since 9 Oct;
      - the ledger's newest event for the task is not "done" (a park, an
        unblock, a run's intent): there is work owed;
      - no carry-out after the newest approval. With the ledger, full times
        are compared, as the dispatcher's idle_handback does. `events` None
        means the ledger could not be read: then only the Notes dates exist,
        and an approval on the same London day as the carry-out is NOT waiting.
    The age runs from the first carry-out after the approval, not the newest:
    a daily re-check writes a fresh line and must not restart the clock."""
    return _reply_wait(f, now, events)[0]


def _reply_wait(f, now, events):
    """(reply_wait's answer, when the wait began as a London date or None)."""
    d = dispatcher()
    if f.get("Approval Outcome") not in d.APPROVED:
        return "", None
    notes = str(f.get("Notes") or "")
    days = carried_out_days(notes)
    if not days or d.task_blocker(notes):
        return "", None
    approved = _aware(f.get("Approved At"))
    if f.get("Approved At") and approved is None:
        return "", None    # cannot tell which came first: shown as live, never hidden
    if events is not None:
        if not events or events[-1][0] != "done":
            return "", None
        after = [when for event, when in events if event == "done" and (approved is None or when >= approved)]
        if not after:
            return "", None
        began = after[0].astimezone(LONDON).date()
        waited = (now - after[0]).total_seconds() / 86400.0
    else:
        approved_day = approved.astimezone(LONDON).date() if approved else None
        after = [day for day in days if approved_day is None or day > approved_day]
        if not after:
            return "", None
        began = after[0]
        waited = (now.astimezone(LONDON).date() - began).days
    return ("overdue" if waited > REPLY_STUCK_DAYS else "waiting"), began


def work_bucket(f, now, events=None):
    """(bucket, wait) for an OPEN agent task: bucket is one of WORK_BUCKETS and
    wait is reply_wait's answer ("" outside the dispatch window). The Approval
    lanes are lane_for's own: a card knocked back to a later date is scheduled,
    a task on no board is other."""
    today = now.astimezone(LONDON).date().isoformat()
    status = f.get("Status") or ""
    lane = lane_for(f, (), today)
    if lane == "invisible":
        return "other", ""
    if status == "Approval":
        return ("scheduled" if lane == "deferred" else "approval"), ""
    if not in_dispatch_window(status, f.get("Due Date"), today, bool(f.get("Some Day"))):
        return ("scheduled" if status == "Upcoming" else "other"), ""
    wait = reply_wait(f, now, events)
    return ("waitingReply" if wait == "waiting" else "live"), wait


def reply_overdue_rows(tasks, now, ledger, roy_ids=(), already=()):
    """Stalled rows, rule "reply", for every open task in the dispatch window
    whose carried-out wait is past REPLY_STUCK_DAYS. report() adds them to the
    stalled list, so the Estate tab shows each task the card counts as stuck
    (review of PR #782: four were on no list). `already` holds ids another rule
    has listed: a task appears once. Not in compute(): the Approvals tab mirrors
    compute() rule for rule, and the ledger this reads is on the Mac only."""
    today = now.astimezone(LONDON).date().isoformat()
    rows = []
    for r in tasks:
        f = r.get("fields") or {}
        status = f.get("Status") or ""
        if r["id"] in already or status in CLOSED or f.get("Completion Date") or status == "Approval":
            continue
        if not in_dispatch_window(status, f.get("Due Date"), today, bool(f.get("Some Day"))):
            continue
        wait, began = _reply_wait(f, now, None if ledger is None else ledger.get(r["id"], []))
        if wait != "overdue":
            continue
        days = (now.astimezone(LONDON).date() - began).days
        rows.append({"id": r["id"], "name": f.get("Task Name") or "(untitled)", "rule": "reply", "days": days,
                     "why": "Waiting on a reply for more than %d days: carried out %s and no answer has closed it"
                            % (REPLY_STUCK_DAYS, began.strftime("%d %b %Y").lstrip("0")),
                     "lane": lane_for(f, set(roy_ids), today)})
    return rows


def open_agent_ids(agent_ids, fetcher=None):
    """Open tasks owned by an AI agent, counted by Airtable's own formula: the
    second way of counting `open` (review of PR #782). It matches the agent's
    record id through the Tasks lookup of Team Members' "Record ID (Used for
    Automation)" (CLAUDE.md: match ids through a lookup of RECORD_ID(), never
    ARRAYJOIN over a link, which gives names). On 14 Oct 2026 every Team Members
    row's field equalled its record id, and this counted 192 against the
    Python filter's 192. A record id is 17 letters and digits, so FIND cannot
    match one inside another."""
    fetcher = fetcher or fetch
    if not agent_ids:
        return set()
    look = "{Record ID (Used for Automation) (from Team Members)}"
    formula = ("AND({Status}!='Completed',{Status}!='Cancelled',{Completion Date}=BLANK(),OR("
               + ",".join("FIND('%s',ARRAYJOIN(%s)&'')" % (a, look) for a in sorted(agent_ids)) + "))")
    return {r["id"] for r in fetcher(TASKS, ["Status"], formula=formula)}


def dispatch_held_ids(now, path=None, max_min=DISPATCH_QUEUE_MAX_MIN):
    """(set of task ids, None) from the dispatcher's newest queue, or (None, why not).
    A missing, half-written, unreadable or stale queue is NOT CHECKED, never an
    empty list, and never a crash."""
    path = path or DISPATCH_QUEUE
    try:
        with open(path, encoding="utf-8") as fh:
            q = json.load(fh)
    except FileNotFoundError:
        return None, "no dispatch queue at %s" % path
    except (OSError, ValueError) as exc:
        return None, "the dispatch queue could not be read: %s" % str(exc)[:120]
    held = q.get("heldUnderLead") if isinstance(q, dict) else None
    if not isinstance(held, list):
        return None, "the dispatch queue carries no heldUnderLead list"
    made = _aware(q.get("generatedAt"))
    if made is None:
        return None, "the dispatch queue carries no readable generatedAt with a time zone"
    age = (now - made).total_seconds() / 60.0
    if age > max_min:
        return None, "the dispatch queue is %d minutes old (the hand-back poll writes it every 30)" % age
    return {t.get("id") for t in held if isinstance(t, dict) and t.get("id")}, None


def agent_work(tasks, agent_ids, stalled, held_ids, held_error=None, now=None,
               ledger=None, ledger_error=None, ledger_skipped=0, open_check=None):
    """The Agent Work card's numbers. `open` splits into WORK_BUCKETS, which add up
    to it. `notMoving` counts the rows of `stalled` that are open agent tasks and
    not held under a lead, so every task it counts is on the list a person reads;
    `replyOverdue` is how many of those are the "reply" rule. With no held list
    (`held_ids` None) it counts held tasks too and `heldCheck` says why. `ledger`
    is carryout_ledger()'s map; left out, it is read here. When it cannot be read,
    `waitCheck` says so and the stricter date-only rule decides.

    Two controls on `open` (review of PR #782), each raising SplitCheckFailed:
      - the buckets must add up to it;
      - `open_check` is (before, after): the open agent task ids Airtable's own
        formula found just before and just after the main read
        (open_agent_ids). When the two agree the board held still, and they must
        then equal this split's own set. When they differ the board moved during
        the read, so nothing is compared and `openCheck` says so.
    report() catches SplitCheckFailed and withdraws only the split (`splitCheck`
    carries the reason); the stalled list and every other number still stand.

    Control on the waiting rule: it fires on the PRESENCE of a carry-out line, so
    a changed stamp would quietly move every waiting task into live. When some
    task read carries the mark but no task carries a readable own line, the
    split is withdrawn (`splitCheck` says why) and the card shows the plain open
    count. So is it when agent-dispatch.py, which owns the rules, cannot load."""
    now = now or datetime.now(timezone.utc)
    split_error = None
    try:
        mark = dispatcher().CARRIED_OUT_MARK
    except Exception as exc:  # noqa: BLE001 — the card must say WHY it has no split
        mark, split_error = None, "agent-dispatch.py could not be loaded: %s" % str(exc)[:160]
    if mark and ledger is None and ledger_error is None:
        ledger, ledger_error, ledger_skipped = carryout_ledger()
    counts = dict.fromkeys(WORK_BUCKETS, 0)
    owned_open = set()
    marked = readable = 0
    for r in tasks:
        f = r.get("fields") or {}
        if (f.get("Status") or "") in CLOSED or f.get("Completion Date"):
            continue
        if not any(x in agent_ids for x in (f.get("Team Member") or [])):
            continue
        owned_open.add(r["id"])
        if not mark:
            continue
        notes = str(f.get("Notes") or "")
        if mark in notes:
            marked += 1
            readable += bool(carried_out_days(notes))
        counts[work_bucket(f, now, None if ledger is None else ledger.get(r["id"], []))[0]] += 1
    open_note, failed = None, None
    if mark and sum(counts.values()) != len(owned_open):
        failed = ("agent work split placed %d of %d open agent tasks in a bucket"
                  % (sum(counts.values()), len(owned_open)))
    if open_check is not None:
        before, after = (set(x) for x in open_check)
        if before != after:
            open_note = ("the board changed while it was read (%d task(s) opened or closed), so the "
                         "open count was not checked against Airtable this time" % len(before ^ after))
        elif before != owned_open and not failed:
            failed = ("open agent tasks: this split counted %d, Airtable's own filter counted %d "
                      "(only here: %s; only in Airtable: %s)" % (
                          len(owned_open), len(before), ", ".join(sorted(owned_open - before)[:5]) or "none",
                          ", ".join(sorted(before - owned_open)[:5]) or "none"))
    held = owned_open & set(held_ids or ())
    stuck = [s for s in stalled if s.get("id") in owned_open and s.get("id") not in held]
    out = dict(counts, open=len(owned_open), notMoving=len(stuck),
               replyOverdue=sum(1 for s in stuck if s.get("rule") == "reply"),
               replyWindowDays=REPLY_STUCK_DAYS, held=None if held_ids is None else len(held),
               heldCheck=held_error, waitCheck=ledger_error if mark else None,
               ledgerSkipped=ledger_skipped if mark else 0, openCheck=open_note, splitCheck=split_error)
    if mark and marked and not readable:
        split_error = ("%d task(s) carry '%s' and none carries a readable dated line, so "
                       "carried-out work cannot be told from live work" % (marked, mark))
    if split_error:
        out.update(dict.fromkeys(WORK_BUCKETS))
        out["splitCheck"] = split_error
    if failed:
        raise SplitCheckFailed(failed, out)
    return out


class SplitCheckFailed(RuntimeError):
    """A control on the Agent Work split failed. It carries every other number the
    card needs, so report() withdraws only the split (final review of PR #782): a
    task closed and reopened between the two Airtable counts must not take down the
    Estate tab's not-moving list or the daily loop-health run with it."""

    def __init__(self, message, partial):
        super().__init__(message)
        self.partial = partial

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
    aw = res["agentWork"]
    print(f"  Agent work  : {aw['open']} open = live {aw['live']}, approval {aw['approval']}, "
          f"waiting on a reply {aw['waitingReply']}, scheduled {aw['scheduled']}, other {aw['other']}; "
          f"stuck {aw['notMoving']} ({aw['replyOverdue']} waited on a reply too long), "
          f"held under a lead {aw['held']}")
    if aw["ledgerSkipped"]:
        print(f"  CANNOT CHECK: {aw['ledgerSkipped']} line(s) of the carry-out ledger were unreadable and skipped")
    for why in (aw["heldCheck"], aw["waitCheck"], aw["openCheck"], aw["splitCheck"]):
        if why:
            print(f"  CANNOT CHECK: {why}")
    print(f"  NOT MOVING  : {len(res['stalled'])}  "
          + ", ".join(f"{k} {v}" for k, v in res["lanes"].items() if v))
    for s in res["stalled"]:
        print(f"    - [{s['lane']}] {s['name'][:64]}\n        {s['why']}")


if __name__ == "__main__":
    main()
