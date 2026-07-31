#!/usr/bin/env python3
"""Agent accuracy, scored per agent PER TASK TYPE, for the CEO huddle.

Reads every task that carries an approval outcome and reports which agents have
cleared the autonomy bar. Crossing the bar is a RECOMMENDATION to Kevin and
nothing else: this script changes no data and promotes nobody. The owner moves
the gears; accuracy only advises.

THE BAR (all three, not any of them):
  - at least 20 decisions of that task type by that agent
  - 90% or better accurate (approved as-is + approved with minor edits)
  - zero rejections in the last 10

These three numbers are duplicated in js/agent-accuracy.js, which is what the
browser uses. tests/constant-drift.test.js fails if the two ever disagree — a
threshold that drifts between the huddle and the dashboard would have Kevin
told an agent is ready while the app says it is not.

Usage:  python3 scripts/agent-accuracy-report.py [--json]
Exit:   0 always (this is a report, not a gate).
Auth:   ~/.config/od/airtable_pat (never printed).
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE_ID = "appnqjDpqDniH3IRl"
TASKS = "tblqB8b22hKBL4PF1"
TEAM = "tblco0p2OnlLQVAX7"

MIN_SAMPLE = 20
MIN_RATE = 0.9
RECENT_N = 10

ACCURATE = ("Approved as-is", "Approved with minor edits")


def pat():
    path = os.path.expanduser("~/.config/od/airtable_pat")
    with open(path) as fh:
        return fh.read().strip()


def query(token, table, formula=None, fields=None):
    records, offset = [], None
    while True:
        params = [("pageSize", "100")]
        if formula:
            params.append(("filterByFormula", formula))
        for f in fields or []:
            params.append(("fields[]", f))
        if offset:
            params.append(("offset", offset))
        url = f"https://api.airtable.com/v0/{BASE_ID}/{table}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = json.load(resp)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}") from None
        records += body.get("records", [])
        offset = body.get("offset")
        if not offset:
            return records


def first_link(value):
    if isinstance(value, list) and value:
        item = value[0]
        return item.get("id") if isinstance(item, dict) else str(item)
    return ""


def select_name(value):
    if isinstance(value, dict):
        return value.get("name", "")
    return value or ""


def score(decisions, names):
    buckets = {}
    for d in decisions:
        buckets.setdefault((d["agent"], d["type"]), []).append(d)

    rows = []
    for (agent_id, task_type), items in buckets.items():
        # Newest first; undated entries sort last so they cannot pass as recent.
        items.sort(key=lambda d: d["at"] or "", reverse=True)
        total = len(items)
        accurate = sum(1 for d in items if d["outcome"] in ACCURATE)
        rejected = sum(1 for d in items if d["outcome"] == "Rejected")
        recent_rejections = sum(1 for d in items[:RECENT_N] if d["outcome"] == "Rejected")
        rate = accurate / total if total else 0.0
        rows.append({
            "agent": names.get(agent_id, agent_id),
            "task_type": task_type,
            "total": total,
            "accurate": accurate,
            "rejected": rejected,
            "rate": round(rate, 4),
            "recent_rejections": recent_rejections,
            "ready": total >= MIN_SAMPLE and rate >= MIN_RATE and recent_rejections == 0,
        })
    rows.sort(key=lambda r: (r["agent"], r["task_type"]))
    return rows


def main():
    token = pat()
    # LEN(field & '') rather than != '' — a blank Airtable field is not reliably
    # unequal to an empty string, and that trap has emptied a whole query here.
    decided = query(token, TASKS, "LEN({Approval Outcome} & '') > 0",
                    ["Approval Outcome", "Approved At", "Task Type", "Sent For Approval By", "Team Member"])
    waiting = query(token, TASKS, "{Status} = 'Approval'", ["Task Name"])
    team = query(token, TEAM, None, ["Name"])
    names = {r["id"]: r["fields"].get("Name", r["id"]) for r in team}

    decisions = []
    for r in decided:
        f = r["fields"]
        agent = first_link(f.get("Sent For Approval By")) or first_link(f.get("Team Member"))
        outcome = select_name(f.get("Approval Outcome"))
        if not agent or not outcome:
            continue
        decisions.append({
            "agent": agent,
            "type": select_name(f.get("Task Type")) or "Unclassified",
            "outcome": outcome,
            "at": f.get("Approved At") or "",
        })

    rows = score(decisions, names)
    recommendations = [
        f"{r['agent']} has cleared the bar on {r['task_type']}: {round(r['rate'] * 100)}% over "
        f"{r['total']} approvals, no rejections in the last {min(r['total'], RECENT_N)}. "
        f"Your call whether it runs that task type without the gate."
        for r in rows if r["ready"]
    ]

    payload = {
        "waiting_for_kevin": len(waiting),
        "decisions_recorded": len(decisions),
        "rows": rows,
        "recommendations": recommendations,
    }

    if "--json" in sys.argv:
        print(json.dumps(payload, indent=2))
        return 0

    print("Agent accuracy — per agent, per task type")
    print("=" * 60)
    print(f"Waiting for Kevin right now : {len(waiting)}")
    print(f"Decisions recorded          : {len(decisions)}")
    print()
    if not rows:
        print("No approval decisions recorded yet — nothing to score.")
    for r in rows:
        flag = "READY (recommend)" if r["ready"] else (
            f"{r['recent_rejections']} rejected in last {RECENT_N}" if r["recent_rejections"]
            else f"{r['total']}/{MIN_SAMPLE} to the bar")
        print(f"  {r['agent']:<34} {r['task_type']:<16} "
              f"{round(r['rate'] * 100):>3}%  {r['accurate']}/{r['total']}   {flag}")
    print()
    if recommendations:
        print("RECOMMENDATIONS FOR KEVIN — nothing has been changed:")
        for line in recommendations:
            print(f"  - {line}")
    else:
        print("No agent has cleared the bar. Nothing to recommend.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
