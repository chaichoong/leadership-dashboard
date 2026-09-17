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
        python3 scripts/agent-accuracy-report.py --weekly [--json] [--card]
        python3 scripts/agent-accuracy-report.py selftest
Exit:   0 always (this is a report, not a gate), except a --card that fails to
        create its card, or a failing selftest.
Auth:   ~/.config/od/airtable_pat (never printed).
"""

import collections
import datetime
import json
import os
import re
import subprocess
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
# "Stuck" for the huddle's workforce check: sent for approval and still
# undecided a day later. One number, one reader (finding 20260902-ceo-agent-432).
STUCK_HOURS = 24
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
# None of the seven fitted and Kevin typed his own sentence instead
# (4 Sep 2026). Stored explicitly so an unexplained rejection can never
# look identical to a reason that was never written at all.
UNCLASSIFIED_REASON = "Something else"
# The label written on the 63 rejections that were decided with no reason at
# all (Kevin's ruling, 17 Sep 2026: "label them, invent nothing"). It is an
# unknown exactly as a blank was, and must be counted as one: counting it as a
# reason would make 63 unexplained rejections vanish from the number that says
# how much of the score is unexplained. Kept identical in js/agent-accuracy.js
# (tests/agent-trust-review.test.js).
NO_REASON_LABEL = "No reason recorded"


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


def stuck_over(waiting, hours):
    """The subset of `waiting` sent for approval and undecided for `hours`.

    Age is read from Airtable's own `createdTime` on each record rather than
    from a filterByFormula date comparison. A bare `{Created}` comparison in a
    formula returns zero rows even when the records exist (CLAUDE.md, Airtable
    Conventions), and a zero that means "the query broke" is indistinguishable
    from a zero that means "nothing is stuck" — which is exactly how the 2 Sep
    CEO slot ended up reporting 0 and 77 for the same queue.
    """
    cutoff = (datetime.datetime.now(datetime.timezone.utc)
              - datetime.timedelta(hours=hours))
    out = []
    for r in waiting:
        if not r.get("fields", {}).get("Sent For Approval By"):
            continue
        raw = (r.get("createdTime") or "").replace("Z", "+00:00")
        try:
            created = datetime.datetime.fromisoformat(raw)
        except ValueError:
            # No readable stamp is NOT evidence of freshness. Count it, so an
            # unreadable record shows up rather than quietly shrinking the number.
            out.append(r)
            continue
        if created <= cutoff:
            out.append(r)
    return out


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
        # "Something else" is Kevin rejecting in his own words without saying
        # which KIND of no it is (4 Sep 2026). It counts here exactly as a
        # blank always did — an unknown, never a pass — or this number would
        # read zero the day the blanks stopped without anything improving.
        unclassified = sum(1 for d in judged
                           if d["outcome"] == "Rejected"
                           and (not d.get("reason")
                                or d.get("reason") in (UNCLASSIFIED_REASON,
                                                       NO_REASON_LABEL)))
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


# ─── THE WEEKLY TRUST REVIEW (15 Sep 2026 audit; built 17 Sep 2026) ────
#
# The same decisions, read as a trend rather than a snapshot, so Kevin gets ONE
# card a week at most, and only when a verdict has moved. No new agent: this is
# arithmetic over the approval log (Chen's Assignment Matrix), and nothing
# promotes or demotes itself. UP names a Level A candidate; DOWN names a
# category whose drafts are getting worse. Kevin clicks either way.
#
# UP is the bar above, measured over a rolling 30 days (GUARDRAILS "Migration
# by evidence"), with the 30 days of history the 28 Aug ruling requires.
# DOWN had no bar anywhere before this; Kevin approved these numbers at the
# 17 Sep build gate: under 70% on 10+ judged decisions, or 3+ rejections in
# the last 10.
WINDOW_DAYS = 30
WEEK_DAYS = 7
DOWN_RATE = 0.7
DOWN_MIN_SAMPLE = 10
DOWN_RECENT_REJECTIONS = 3
# Fewer than this in either week and a "direction" is noise, so none is given.
DIRECTION_MIN_SAMPLE = 3

# WHICH PART FAILED (Chen gap 3, Kevin 17 Sep 2026). A score nobody can
# attribute is a score nobody can act on. Kevin mapped the first four; the
# rest were approved as assumptions at the gate. "tools" never comes from a
# reason: it is the agent's own job failing to run (job-status.jsonl).
PART_OF_REASON = {
    "Already done elsewhere": "memory",
    "Duplicate": "memory",
    "Roy owns it": "orchestration",
    "Not worth my attention": "reasoning",
    "The work is wrong": "reasoning",
    "Parked for now": "timing",
    "No longer relevant": "timing",
}

# Minutes burned. job-status.jsonl logs JOBS, not agents. Three agents run as
# their own job, so their minutes are exact. Everyone dispatched shares the
# dispatch and hand-back jobs, so that pool is split by each agent's share of
# decisions that week and always printed as an estimate, never as a reading.
# Keys are Team Members record ids (agent-dispatch.py ROLE_AGENTS).
AGENT_JOBS = {
    "recCUfsTXzmVZynEI": ("inbound-triage",),                    # AI Inbox Triage
    "rec1hYELb4zS8pjjO": ("task-manager",),                      # AI Task Board Manager
    "recRcy1Edas6rGaaF": ("content-engine", "content-engine-publish",
                          "content-engine-redo"),                # AI Content Producer
    "reciHUAEcEkbctnZ6": ("ceo-agent",),                         # AI CEO (Dan Martell)
}
SHARED_JOBS = ("agent-dispatch", "handback-poll")
JOB_STATUS = os.path.expanduser("~/knowledge-os/logs/job-status.jsonl")

# The card. Sent by the AI CEO's Team Members row: the gate hides a card with
# no sender (APV_QUEUE_FORMULA requires Sent For Approval By).
CEO_REC_ID = "reciHUAEcEkbctnZ6"
TASK_FIELD = {
    "name": "fldgFjGBw6bTKJFCD",
    "description": "fldRGhBQViKZKtkQ6",
    "status": "fldx4qCw17UfrKpaN",
    "sentForApprovalBy": "fld30Yw8SWYVp049g",
    "agentOutput": "fldzswp8fx6PqpLQ5",
}
CREATE_TASK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "create-agent-task.py")


def parse_at(value):
    """An aware UTC datetime from an Airtable or job-log stamp, or None."""
    if not value:
        return None
    try:
        at = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=datetime.timezone.utc)
    return at


def between(d, start, end):
    at = parse_at(d.get("at"))
    return at is not None and start < at <= end


def approval_rate(judged):
    if not judged:
        return None
    return sum(1 for d in judged if d["outcome"] in ACCURATE) / len(judged)


def failing_part(reason):
    return PART_OF_REASON.get(reason or "", "unattributed")


def verdict_as_of(items, as_of):
    """UP / HOLD / DOWN for one agent and task type, using only what was known at as_of."""
    start = as_of - datetime.timedelta(days=WINDOW_DAYS)
    window = [d for d in items if between(d, start, as_of)]
    judged = sorted((d for d in window if not is_relevance_failure(d)),
                    key=lambda d: d["at"], reverse=True)
    history = [d for d in items if not is_relevance_failure(d)
               and parse_at(d.get("at")) and parse_at(d["at"]) <= as_of]
    rate = approval_rate(judged)
    recent = sum(1 for d in judged[:RECENT_N] if d["outcome"] == "Rejected")
    days = span_days(history)
    if (len(judged) >= MIN_SAMPLE and rate >= MIN_RATE and recent == 0
            and days >= MIN_DAYS):
        verdict = "UP"
    elif ((len(judged) >= DOWN_MIN_SAMPLE and rate < DOWN_RATE)
            or recent >= DOWN_RECENT_REJECTIONS):
        verdict = "DOWN"
    else:
        verdict = "HOLD"
    return {"verdict": verdict, "window": window, "judged": judged, "rate": rate,
            "recent_rejections": recent, "history_days": days}


def direction(items, now):
    """(points, label): this week's judged rate against the week before."""
    week = datetime.timedelta(days=WEEK_DAYS)
    this = [d for d in items if between(d, now - week, now) and not is_relevance_failure(d)]
    prev = [d for d in items if between(d, now - 2 * week, now - week)
            and not is_relevance_failure(d)]
    if len(this) < DIRECTION_MIN_SAMPLE or len(prev) < DIRECTION_MIN_SAMPLE:
        return None, "too few to compare"
    points = round((approval_rate(this) - approval_rate(prev)) * 100)
    if points == 0:
        return 0, "level"
    return points, (f"up {points} pts" if points > 0 else f"down {-points} pts")


def minutes_by_agent(job_rows, decisions, now):
    """(own minutes, estimated shared minutes, own-job failures, shared pool)."""
    start = now - datetime.timedelta(days=WEEK_DAYS)
    rows = [r for r in job_rows if between({"at": r.get("ts")}, start, now)]
    own = {aid: sum(r.get("seconds") or 0 for r in rows if r.get("job") in jobs) / 60
           for aid, jobs in AGENT_JOBS.items()}
    fails = {aid: sum(1 for r in rows if r.get("job") in jobs and r.get("ok") is False)
             for aid, jobs in AGENT_JOBS.items()}
    pool = sum(r.get("seconds") or 0 for r in rows if r.get("job") in SHARED_JOBS) / 60
    counts = collections.Counter(d["agent"] for d in decisions
                                 if d["agent"] not in AGENT_JOBS and between(d, start, now))
    total = sum(counts.values())
    shared = {aid: pool * n / total for aid, n in counts.items()} if total else {}
    return own, shared, fails, pool


def weekly_review(decisions, names, job_rows, now):
    buckets = {}
    for d in decisions:
        buckets.setdefault((d["agent"], d["type"]), []).append(d)
    minutes = minutes_by_agent(job_rows, decisions, now) if job_rows is not None else None
    agents, crossings = {}, []
    for (aid, task_type), items in sorted(buckets.items()):
        current = verdict_as_of(items, now)
        if not current["window"]:
            continue    # nothing decided in 30 days: nothing to review this week
        last_week = verdict_as_of(items, now - datetime.timedelta(days=WEEK_DAYS))["verdict"]
        rejections = [d for d in current["window"] if d["outcome"] == "Rejected"]
        trigger = collections.Counter(d.get("reason") or NO_REASON_LABEL
                                      for d in rejections).most_common(1)
        points, dir_label = direction(items, now)
        relevance = sum(1 for d in current["window"] if is_relevance_failure(d))
        row = {
            "task_type": task_type,
            "sample": len(current["judged"]),
            "rate": None if current["rate"] is None else round(current["rate"], 4),
            "history_days": current["history_days"],
            "recent_rejections": current["recent_rejections"],
            "direction_pts": points,
            "direction": dir_label,
            "relevance_share": round(relevance / len(current["window"]), 4),
            "top_trigger": trigger[0][0] if trigger else "",
            "top_trigger_count": trigger[0][1] if trigger else 0,
            "parts": dict(collections.Counter(failing_part(d.get("reason")) for d in rejections)),
            "verdict": current["verdict"],
            "verdict_last_week": last_week,
            "crossed": current["verdict"] in ("UP", "DOWN") and current["verdict"] != last_week,
        }
        agent = agents.setdefault(aid, {"agent": names.get(aid, aid), "agent_id": aid,
                                        "rows": []})
        agent["rows"].append(row)
        if row["crossed"]:
            crossings.append({"agent": agent["agent"], **row})
    for aid, agent in agents.items():
        if minutes is None:
            agent.update(minutes_7d=None, minutes_estimated=False, tool_failures_7d=None)
        elif aid in AGENT_JOBS:
            agent.update(minutes_7d=round(minutes[0][aid]), minutes_estimated=False,
                         tool_failures_7d=minutes[2][aid])
        else:
            agent.update(minutes_7d=round(minutes[1].get(aid, 0)), minutes_estimated=True,
                         tool_failures_7d=None)
    return {"as_of": now.isoformat(), "window_days": WINDOW_DAYS,
            "agents": sorted(agents.values(), key=lambda a: a["agent"]),
            "crossings": crossings,
            "shared_pool_minutes": None if minutes is None else round(minutes[3])}


# THE THREE-SCENARIO TEST IS RECORDED, NOT REMEMBERED (Kevin, 17 Sep 2026).
# GUARDRAILS has required it since 25 Aug, but no register row recorded one and
# nothing checked. The register's Scenario Test field holds one dated line per
# scenario; the weekly review names every Live or Built agent without all three
# passing, so a gap is read out rather than forgotten.
REGISTER = "tbl9msVjyQWslLOIZ"
SCENARIO_LABELS = ("EXPECTED", "EDGE", "FAILURE")


def scenario_state(text):
    """'pass' when all three scenarios are on record and passed, else 'fail' or 'missing'."""
    found = {}
    for line in str(text or "").splitlines():
        head = line.strip().split(" ", 1)[0].upper()
        if head in SCENARIO_LABELS and head not in found:
            found[head] = line.strip().upper()
    if len(found) < len(SCENARIO_LABELS):
        return "missing"
    if any(re.search(r"\bFAIL\b", line) for line in found.values()):
        return "fail"
    return "pass" if all(re.search(r"\bPASS\b", line) for line in found.values()) else "missing"


def scenario_gaps(register_rows):
    """(missing names, failing names) among Live or Built register rows."""
    missing, failing = [], []
    for r in register_rows:
        f = r.get("fields", {})
        if select_name(f.get("Status")) not in ("Live", "Built"):
            continue
        state = scenario_state(f.get("Scenario Test"))
        if state == "missing":
            missing.append(f.get("Name", r.get("id", "")))
        elif state == "fail":
            failing.append(f.get("Name", r.get("id", "")))
    return sorted(missing), sorted(failing)


def read_job_rows(path=JOB_STATUS):
    """Every readable line of the job log, or None when the log cannot be read.

    None is not zero: a missing log prints "unknown" rather than 0 minutes.
    """
    try:
        with open(path) as fh:
            lines = fh.readlines()
    except OSError:
        return None
    rows = []
    for line in lines:
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue
    return rows


def is_monday_london(now):
    try:
        from zoneinfo import ZoneInfo
        return now.astimezone(ZoneInfo("Europe/London")).weekday() == 0
    except Exception:                                    # noqa: BLE001
        # No tz database: decide in UTC rather than guess, and say so.
        print("WARNING: Europe/London zone unavailable, deciding Monday in UTC",
              file=sys.stderr)
        return now.weekday() == 0


def trust_card(crossings, now):
    """(task name, agent output) for the one weekly card, or None when nothing crossed."""
    if not crossings:
        return None
    lines = [f"DECIDE: {len(crossings)} trust bar{'s' if len(crossings) != 1 else ''} "
             "crossed this week. Nothing has been changed: you make every move."]
    for c in crossings:
        pct = round((c["rate"] or 0) * 100)
        if c["verdict"] == "UP":
            lines.append(
                f"- UP: {c['agent']} on {c['task_type']}: {pct}% over {c['sample']} decisions "
                f"in 30 days, {c['history_days']} days of history, no rejection in the last "
                f"{min(c['sample'], RECENT_N)} (was {c['verdict_last_week']}). "
                "Your call: move this category to Level A?")
        else:
            why = (f", top reason {c['top_trigger']} x{c['top_trigger_count']} "
                   f"({failing_part(c['top_trigger'])})") if c["top_trigger"] else ""
            lines.append(
                f"- DOWN: {c['agent']} on {c['task_type']}: {pct}% over {c['sample']} decisions "
                f"in 30 days, {c['recent_rejections']} rejected in the last {RECENT_N}{why} "
                f"(was {c['verdict_last_week']}). Your call: step it back, or fix the source?")
    name = f"TRUST REVIEW: {now.date().isoformat()}, {len(crossings)} bar{'s' if len(crossings) != 1 else ''} crossed"
    return name, "\n".join(lines)


def create_card(name, output):
    fields = {
        TASK_FIELD["name"]: name,
        TASK_FIELD["description"]: "Weekly trust review from scripts/agent-accuracy-report.py "
                                   "(--weekly --card). A recommendation only.",
        TASK_FIELD["status"]: "Approval",
        TASK_FIELD["sentForApprovalBy"]: [CEO_REC_ID],
        TASK_FIELD["agentOutput"]: output,
    }
    # Through the create gate, never a bare POST: a re-run on the same Monday
    # folds into the open card instead of minting a second one.
    done = subprocess.run([sys.executable, CREATE_TASK, "create", "--fields-json",
                           json.dumps(fields)], capture_output=True, text=True, timeout=120)
    return done.returncode, (done.stdout or done.stderr).strip()


def print_weekly(review):
    print(f"Weekly trust review, {WINDOW_DAYS}-day window to {review['as_of'][:10]}")
    print("=" * 60)
    print(f"UP   = {MIN_SAMPLE}+ judged, {round(MIN_RATE * 100)}%+, no rejection in the last "
          f"{RECENT_N}, {MIN_DAYS}+ days of history")
    print(f"DOWN = under {round(DOWN_RATE * 100)}% on {DOWN_MIN_SAMPLE}+ judged, or "
          f"{DOWN_RECENT_REJECTIONS}+ rejections in the last {RECENT_N}")
    if review["shared_pool_minutes"] is None:
        print("Minutes: job log unreadable, shown as unknown")
    print()
    if not review["agents"]:
        print("No decisions in the window. Nothing to review.")
    for a in review["agents"]:
        if a["minutes_7d"] is None:
            mins = "unknown"
        elif a["minutes_estimated"]:
            mins = f"~{a['minutes_7d']} (shared jobs, split by decisions)"
        else:
            mins = str(a["minutes_7d"])
        tools = "" if a["tool_failures_7d"] is None else f"   tools: {a['tool_failures_7d']} failed runs"
        print(f"{a['agent']}   minutes last 7 days: {mins}{tools}")
        for r in a["rows"]:
            rate = "n/a" if r["rate"] is None else f"{round(r['rate'] * 100)}%"
            trig = (f"{r['top_trigger']} x{r['top_trigger_count']}" if r["top_trigger"] else "none")
            parts = ", ".join(f"{k} {v}" for k, v in sorted(r["parts"].items())) or "none"
            moved = f" (was {r['verdict_last_week']})" if r["crossed"] else ""
            print(f"  {r['task_type']:<16} {r['verdict']:<4}{moved}  {rate} of {r['sample']}  "
                  f"{r['history_days']}d  {r['direction']}  relevance {round(r['relevance_share'] * 100)}%  "
                  f"top: {trig}  parts: {parts}")
    print()


def selftest():
    now = datetime.datetime(2026, 9, 17, 12, 0, tzinfo=datetime.timezone.utc)

    def dec(agent, days_ago, outcome="Approved as-is", reason="", ttype="Correspondence"):
        at = (now - datetime.timedelta(days=days_ago)).isoformat().replace("+00:00", "Z")
        return {"agent": agent, "type": ttype, "outcome": outcome, "at": at, "reason": reason}

    checks = []

    def check(label, ok):
        checks.append((label, bool(ok)))

    # UP: 22 approvals in 22 days plus one 40 days back. A week ago only 15 sat
    # in the window, so the verdict moved HOLD -> UP: one crossing.
    up = [dec("recUP", d) for d in range(1, 23)] + [dec("recUP", 40)]
    r = weekly_review(up, {"recUP": "Up Agent"}, [], now)
    row = r["agents"][0]["rows"][0]
    check("UP verdict", row["verdict"] == "UP")
    check("UP was HOLD a week ago", row["verdict_last_week"] == "HOLD")
    check("UP crossed", row["crossed"] and len(r["crossings"]) == 1)
    check("UP history days", row["history_days"] == 39)

    # DOWN: 6 approved, 4 rejected as wrong work in 10 days.
    down = ([dec("recDN", d) for d in (1, 2, 3, 4, 5, 6)]
            + [dec("recDN", d, "Rejected", "The work is wrong") for d in (7, 8, 9, 10)])
    row = weekly_review(down, {}, [], now)["agents"][0]["rows"][0]
    check("DOWN verdict", row["verdict"] == "DOWN")
    check("DOWN top trigger", (row["top_trigger"], row["top_trigger_count"]) == ("The work is wrong", 4))
    check("DOWN parts", row["parts"] == {"reasoning": 4})

    # A relevance rejection is not the writer's fault: out of the rate, into the share.
    rel = [dec("recRL", d) for d in range(1, 21)] + [dec("recRL", d, "Rejected", "Duplicate") for d in (2, 3, 4, 5, 6)]
    row = weekly_review(rel, {}, [], now)["agents"][0]["rows"][0]
    check("relevance out of sample", row["sample"] == 20 and row["rate"] == 1.0)
    check("relevance share", row["relevance_share"] == 0.2)
    check("relevance part is memory", row["parts"] == {"memory": 5})

    # The 17 Sep label counts as unexplained in the daily score, as a blank did.
    s = score([dec("recNR", 1, "Rejected", NO_REASON_LABEL), dec("recNR", 2, "Rejected", "")], {})
    check("no-reason label is unclassified", s[0]["unclassified_rejections"] == 2)
    check("no-reason label is unattributed", failing_part(NO_REASON_LABEL) == "unattributed"
          and failing_part("") == "unattributed")

    # Direction: this week 4/4, the week before 4/5 -> up 20 points; too few -> none.
    dirs = [dec("recDR", d) for d in (1, 2, 3, 4)] + [dec("recDR", d) for d in (8, 9, 10, 11)] \
        + [dec("recDR", 12, "Rejected", "The work is wrong")]
    check("direction up 20", direction(dirs, now) == (20, "up 20 pts"))
    check("direction too few", direction(dirs[:2], now)[0] is None)

    # Minutes: own job exact, shared pool split by decisions, failures counted.
    stamp = (now - datetime.timedelta(days=1)).isoformat().replace("+00:00", "Z")
    old = (now - datetime.timedelta(days=9)).isoformat().replace("+00:00", "Z")
    jobs = [{"ts": stamp, "job": "inbound-triage", "seconds": 600, "ok": True},
            {"ts": stamp, "job": "inbound-triage", "seconds": 60, "ok": False},
            {"ts": stamp, "job": "agent-dispatch", "seconds": 1200, "ok": True},
            {"ts": old, "job": "agent-dispatch", "seconds": 9999, "ok": True}]
    mixed = [dec("recX", 1), dec("recX", 2), dec("recX", 3), dec("recY", 1),
             dec("recCUfsTXzmVZynEI", 1)]
    own, shared, fails, pool = minutes_by_agent(jobs, mixed, now)
    check("own minutes exact", own["recCUfsTXzmVZynEI"] == 11)
    check("own failures", fails["recCUfsTXzmVZynEI"] == 1)
    check("pool excludes old runs", pool == 20)
    check("shared split by decisions", (shared["recX"], shared["recY"]) == (15, 5))
    r = weekly_review(mixed, {}, None, now)
    check("unreadable log is unknown, not zero", all(a["minutes_7d"] is None for a in r["agents"]))

    # The card: none without a crossing; a DECIDE card with no dash-joined prose.
    check("no card without crossing", trust_card([], now) is None)
    name, output = trust_card(weekly_review(up, {"recUP": "Up Agent"}, [], now)["crossings"], now)
    check("card name", name.startswith("TRUST REVIEW: 2026-09-17, 1 bar crossed"))
    check("card is a decision", output.startswith("DECIDE: 1 trust bar crossed"))
    check("card names the agent", "UP: Up Agent on Correspondence" in output)
    check("card has no em dash", "—" not in name + output)

    # The day is decided in London time: Monday 21 Sep 2026 00:30 BST is still Sunday in UTC.
    check("Monday in London", is_monday_london(datetime.datetime(2026, 9, 20, 23, 30, tzinfo=datetime.timezone.utc)))
    check("Thursday is not Monday", not is_monday_london(now))

    # The three-scenario record: all three PASS, one FAIL, or anything missing.
    ok3 = ("EXPECTED (17 Sep 2026): a -> b. PASS\nEDGE (17 Sep 2026): c -> d. PASS\n"
           "FAILURE (17 Sep 2026): e -> f. PASS\nMethod: read-only run")
    fail3 = ok3.replace("EDGE (17 Sep 2026): c -> d. PASS", "EDGE (17 Sep 2026): c -> d. FAIL: no rule")
    check("scenario all pass", scenario_state(ok3) == "pass")
    check("scenario one fail", scenario_state(fail3) == "fail")
    check("scenario missing line", scenario_state("EXPECTED (17 Sep 2026): a -> b. PASS") == "missing")
    check("scenario blank", scenario_state("") == "missing")
    reg = [{"fields": {"Name": "A", "Status": "Live", "Scenario Test": ok3}},
           {"fields": {"Name": "B", "Status": "Built", "Scenario Test": fail3}},
           {"fields": {"Name": "C", "Status": "Live"}},
           {"fields": {"Name": "D", "Status": "Retired"}}]
    check("scenario gaps by status", scenario_gaps(reg) == (["C"], ["B"]))

    failed = [label for label, ok in checks if not ok]
    print(json.dumps({"ok": not failed, "checks": len(checks), "failed": failed}))
    return 0 if not failed else 1


def main():
    if sys.argv[1:2] == ["selftest"]:
        return selftest()
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
                    ["Task Name", "Sent For Approval By"])
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

    if "--weekly" in sys.argv:
        now = datetime.datetime.now(datetime.timezone.utc)
        review = weekly_review(decisions, names, read_job_rows(), now)
        missing, failing = scenario_gaps(query(token, REGISTER, None,
                                               ["Name", "Status", "Scenario Test"]))
        review["scenario_test_missing"], review["scenario_test_failing"] = missing, failing
        if "--json" in sys.argv:
            print(json.dumps(review, indent=2))
        else:
            print_weekly(review)
            print(f"Three-scenario test: {len(failing)} Live or Built agent(s) with a FAIL on record"
                  + (f" ({', '.join(failing)})" if failing else "")
                  + f"; {len(missing)} with no complete test"
                  + (f" ({', '.join(missing)})" if missing else "") + ".")
        if "--card" in sys.argv:
            card = trust_card(review["crossings"], now)
            if card is None:
                print("No bar crossed this week: no card.")
            elif not is_monday_london(now):
                print("Not Monday in London: no card made. On a Monday it would send:")
                print(f"  {card[0]}")
                print("  " + card[1].replace("\n", "\n  "))
            else:
                code, out = create_card(*card)
                print(f"Card: {out}" if code == 0 else f"CARD FAILED (exit {code}): {out}")
                return 0 if code == 0 else 1
        return 0

    rows = score(decisions, names)
    recommendations = [
        f"{r['agent']} has cleared the bar on {r['task_type']}: {round(r['rate'] * 100)}% over "
        f"{r['total']} approvals across {r['span_days']} days, "
        f"no rejections in the last {min(r['total'], RECENT_N)}. "
        f"Your call whether it runs that task type without the gate."
        for r in rows if r["ready"]
    ]

    # ONE READER FOR THIS NUMBER (16 Sep 2026, finding 20260902-ceo-agent-432).
    # The 2 Sep 06:45 CEO slot could not reconcile its own approval queue: a
    # hand-rolled curl said 0 while this script said 77, and the run reported
    # both. The huddle's "stuck approvals" line was the only part of the queue
    # this script did not already answer, so the agent improvised a query — and
    # an improvised Airtable query is the silent-zero trap by default (a date
    # compared without DATESTR, or FIND(recXXX, ARRAYJOIN({Link})) against a
    # link field, both return 200 OK and an empty list).
    #
    # Age comes from the record's own `createdTime`, which Airtable returns on
    # every record, so there is no date formula to get wrong. The subset is
    # taken from the SAME population as waiting_for_kevin, so the two can never
    # disagree, and both are printed together: a zero stuck against a non-zero
    # queue is a real answer, a zero stuck against a zero queue is the case
    # that needs explaining rather than reporting.
    stuck = stuck_over(waiting, STUCK_HOURS)
    payload = {
        "waiting_for_kevin": len(waiting),
        "stuck_hours": STUCK_HOURS,
        "stuck_over_hours": len(stuck),
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
    # Always printed, including the zeros. The control the huddle used to be
    # told to run by hand is this pairing: stuck can only be zero-of-N, never
    # zero-of-nothing-we-failed-to-read.
    print(f"Of those, stuck over {STUCK_HOURS}h     : {len(stuck)} "
          f"(sent for approval, undecided since)")
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
