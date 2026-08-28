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

import datetime
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
# Kevin's ruling, 28 Aug 2026. The day the first agent ever cleared this bar,
# all 26 of its decisions had happened in THREE days. Volume is not consistency:
# a busy Tuesday manufactures a sample in an afternoon, and elapsed time is the
# one thing that cannot be manufactured. Kept identical to THRESHOLD.minDays in
# js/agent-accuracy.js — drift-tested.
MIN_DAYS = 30

ACCURATE = ("Approved as-is", "Approved with minor edits")

# ─── A REJECTION IS NOT ALWAYS A MARK AGAINST THE WRITER ─────────────
#
# Kept identical to RELEVANCE_REASONS in js/agent-accuracy.js, which is what
# the browser scores with. tests/constant-drift.test.js fails if they diverge —
# the huddle telling Kevin an agent is at 96% while the dashboard says 66% is
# exactly the kind of split this file exists to prevent.
#
# Measured 27 Aug 2026 across all 175 decisions: of 58 rejections, NOT ONE said
# the draft was wrong. Every one said the task should not have existed. A
# rejection carrying one of these leaves the draft-quality bucket entirely.
RELEVANCE_REASONS = (
    "Already done elsewhere",
    "Roy owns it",
    "Not worth my attention",
    "Duplicate",
    "Parked for now",
    "No longer relevant",
)
QUALITY_REASON = "The work is wrong"


def is_relevance_failure(d):
    return d["outcome"] == "Rejected" and d.get("reason", "") in RELEVANCE_REASONS


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


def span_days(items):
    """Whole days between the oldest and newest DATED decision.

    Undated entries are ignored rather than counted as today: treating a blank
    date as now would let a single dated decision look like a 30-day span.
    """
    days = sorted(d["at"][:10] for d in items if d.get("at"))
    if len(days) < 2:
        return 0
    a = datetime.date.fromisoformat(days[0])
    b = datetime.date.fromisoformat(days[-1])
    return (b - a).days


def score(decisions, names):
    buckets = {}
    for d in decisions:
        buckets.setdefault((d["agent"], d["type"]), []).append(d)

    rows = []
    for (agent_id, task_type), items in buckets.items():
        # Newest first; undated entries sort last so they cannot pass as recent.
        items.sort(key=lambda d: d["at"] or "", reverse=True)
        # Split before counting. A relevance failure never touches this agent's
        # rate, its sample, or its recent run — including the "no rejections in
        # the last 10" clause, which one of them could otherwise use to block
        # the bar for ever. That was blocking Writer/Correspondence at 95%.
        relevance = [d for d in items if is_relevance_failure(d)]
        judged = [d for d in items if not is_relevance_failure(d)]
        total = len(judged)
        accurate = sum(1 for d in judged if d["outcome"] in ACCURATE)
        rejected = sum(1 for d in judged if d["outcome"] == "Rejected")
        recent_rejections = sum(1 for d in judged[:RECENT_N] if d["outcome"] == "Rejected")
        rate = accurate / total if total else 0.0
        # Measured across the JUDGED decisions: the question is how long this
        # agent has done THIS WORK to this standard, and a task rejected as
        # irrelevant is not evidence either way.
        days = span_days(judged)
        # Every decision before 27 Aug 2026 carries no reason, and nothing may
        # guess one on Kevin's behalf. They stay in the total; this says how
        # much of the score is therefore unexplained.
        unclassified = sum(1 for d in judged
                           if d["outcome"] == "Rejected" and not d.get("reason"))
        rows.append({
            "agent": names.get(agent_id, agent_id),
            "task_type": task_type,
            "total": total,
            "accurate": accurate,
            "rejected": rejected,
            "rate": round(rate, 4),
            "recent_rejections": recent_rejections,
            "relevance_failures": len(relevance),
            "unclassified_rejections": unclassified,
            "span_days": days,
            "days_to_go": max(0, MIN_DAYS - days),
            "ready": (total >= MIN_SAMPLE and rate >= MIN_RATE
                      and recent_rejections == 0 and days >= MIN_DAYS),
        })
    rows.sort(key=lambda r: (r["agent"], r["task_type"]))
    return rows


def main():
    token = pat()
    # LEN(field & '') rather than != '' — a blank Airtable field is not reliably
    # unequal to an empty string, and that trap has emptied a whole query here.
    decided = query(token, TASKS, "LEN({Approval Outcome} & '') > 0",
                    ["Approval Outcome", "Approved At", "Task Type", "Sent For Approval By",
                     "Team Member", "Verdict Reason"])
    # HONOUR THE KNOCK-BACK (28 Aug 2026). Kevin can defer an approval to a
    # date instead of deciding it, and five surfaces were built to respect that.
    # This was a SIXTH nobody counted, because it reports a number rather than
    # rendering a queue — so the huddle read "60 waiting" while his actual queue
    # was 56 and four of them were parked to September at his own request.
    #
    # A knock-back that some surfaces honour and others do not reads as "the
    # feature was never built" rather than as a bug. Same boundary as
    # APV_QUEUE_FORMULA in os/agents/index.html: the date itself is IN, and a
    # blank date must always show — that is nearly every task in the base, and
    # getting it wrong empties the count rather than losing one item.
    waiting = query(token, TASKS,
                    "AND({Status} = 'Approval', "
                    "NOT(IS_AFTER({Deferred Until}, TODAY())))",
                    ["Task Name"])
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
            "reason": select_name(f.get("Verdict Reason")),
        })

    rows = score(decisions, names)
    recommendations = [
        f"{r['agent']} has cleared the bar on {r['task_type']}: {round(r['rate'] * 100)}% over "
        f"{r['total']} approvals across {r['span_days']} days, "
        f"no rejections in the last {min(r['total'], RECENT_N)}. "
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
    # Why the number may not have moved yet. A score you cannot explain is a
    # score nobody acts on, and this one changed shape on 27 Aug 2026: every
    # decision before then carries no reason and is still counted the old way.
    relevance_total = sum(r["relevance_failures"] for r in rows)
    unclassified_total = sum(r["unclassified_rejections"] for r in rows)
    print(f"Not the agent's fault       : {relevance_total} "
          f"(task should not have existed — excluded from draft quality)")
    if unclassified_total:
        print(f"Rejections with no reason   : {unclassified_total} "
              f"— still counted against the agent, because only Kevin can say why")
    print()
    if not rows:
        print("No approval decisions recorded yet — nothing to score.")
    for r in rows:
        # Name the ONE thing still missing, in the order that decides it. A row
        # that just says "not ready" tells Kevin nothing about whether to wait a
        # week or fix the agent, and those need opposite responses.
        if r["ready"]:
            flag = "READY (recommend)"
        elif r["recent_rejections"]:
            flag = f"{r['recent_rejections']} rejected in last {RECENT_N}"
        elif r["total"] < MIN_SAMPLE:
            flag = f"{r['total']}/{MIN_SAMPLE} to the bar"
        elif r["days_to_go"]:
            # Passes on volume and rate; only time is short. This is the state
            # Creditor Management was in on 28 Aug 2026 — 100% over 26, all of
            # it inside three days.
            flag = (f"holding {round(r['rate'] * 100)}% — {r['days_to_go']}d more "
                    f"(only {r['span_days']}d of history)")
        else:
            flag = f"{round(r['rate'] * 100)}% — under {round(MIN_RATE * 100)}%"
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
