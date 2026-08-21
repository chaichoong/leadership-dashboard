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
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE_ID = "appnqjDpqDniH3IRl"
TASKS = "tblqB8b22hKBL4PF1"
TEAM = "tblco0p2OnlLQVAX7"

# MUST match STALL_* in os/tasks/index.html. Guarded by tests/loop-health.test.js.
STALL_AMEND_HOURS = 48   # amended, and the agent has not redone it
STALL_DRAFT_HOURS = 24   # an agent owns it, it is DUE, and nothing is drafted
STALL_DECIDE_DAYS = 5    # sat waiting on a human this long

# The statuses agent-dispatch.py actually works from (its OPEN_STATUSES). An
# "Upcoming" task is scheduled, not late. Counting it as stalled made the first
# run report 156 items, 101 of them merely future-dated — and a list that long
# is noise, which is precisely what stops it being read.
STALL_DUE_STATUSES = ("Today", "Overdue")

CLOSED = ("Completed", "Cancelled")

KEVIN_AIRTABLE_EMAIL = "kevin@runpreneur.org.uk"

# Same order as the tab: by how much it needs someone, not raw age. The draft
# rule carries no day count, so sorting the whole list by age would sink every
# "an agent has drafted nothing" item below every dated one — and that is the
# rule that catches work never being started at all.
RULE_ORDER = {"amend": 0, "draft": 1, "decide": 2}


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


def compute(tasks, agent_ids, now=None):
    now = now or datetime.now(timezone.utc)
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
        if owned and not f.get("Agent Output") and status in STALL_DUE_STATUSES:
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
    return {"needsYou": needs_you, "done": done, "stalled": stalled}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

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
                              "Created Time", "Approval Slack TS", "Assignee"],
                      formula=('OR({Status}!="Completed",'
                               "IS_AFTER({Completion Date},DATEADD(TODAY(),-8,'days')))"))
    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as exc:
        print(f"ERROR: could not read Airtable — {exc}", file=sys.stderr)
        sys.exit(1)

    agent_ids = {r["id"] for r in team if (r.get("fields") or {}).get("Is AI Agent")}

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
        # Rule 3's only anchor. If the Slack poster stops stamping it, rule 3
        # reports zero for ever, which is exactly the vacuity it was built to fix.
        "waiting approvals carrying an Approval Slack TS":
            sum(1 for f in fields
                if f.get("Status") == "Approval" and f.get("Approval Slack TS")),
        # Rule 2 fires on the ABSENCE of Agent Output. If the field stopped being
        # written, every agent task would look undrafted and the list becomes
        # noise rather than signal — the opposite failure, equally useless.
        "tasks carrying Agent Output":
            sum(1 for f in fields if f.get("Agent Output")),
    }
    if not agent_ids:
        controls["AI agent records"] = 0
    failed = [k for k, v in controls.items() if not v]
    if failed:
        for k, v in controls.items():
            print(f"  control: {k} = {v}", file=sys.stderr)
        print(f"ERROR: control failed — {', '.join(failed)} is zero. Refusing to report "
              "an all-clear from a query that found nothing.", file=sys.stderr)
        sys.exit(1)
    linked = controls["open tasks linked to an AI agent"]

    res = compute(tasks, agent_ids)
    res["control"] = {"agents": len(agent_ids), "agentLinkedTasks": linked,
                      "tasksRead": len(tasks)}

    if args.json:
        print(json.dumps(res, indent=2))
        return

    print(f"Approval loop — {len(tasks)} tasks read, {linked} agent-linked")
    print(f"  Needs Kevin : {len(res['needsYou'])}")
    print(f"  Done (7d)   : {len(res['done'])}")
    print(f"  NOT MOVING  : {len(res['stalled'])}")
    for s in res["stalled"]:
        print(f"    - {s['name'][:64]}\n        {s['why']}")


if __name__ == "__main__":
    main()
