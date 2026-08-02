#!/usr/bin/env python3
"""Agent dispatch engine, deterministic half — stage 2 of the approval loop.

The scheduled task `agent-dispatch` (this Mac, like ceo-huddle) is the brain:
it dispatches the Claude Code agents in ~/.claude/agents/ to do the work.
This script is everything that must NOT vary run to run: which tasks are
eligible, the tier-1 exclusions, the cap, and the exact Airtable writes.

THE LOOP (do not redesign — memory project_agent_accuracy_and_approval):
  submit   = the gate. Status Approval, Assignee Kevin, due today. The agent
             has PREPARED work into Agent Output and sent, filed and executed
             NOTHING. The Slack worker (approvals.js) posts it within a minute.
  approved = Kevin's yes hands the task back (Status Today, Team Member = the
             agent). The engine then CARRIES OUT the approved action and only
             then calls `complete`. Approving is not completing.
  changes  = redo against the words in Approval Feedback, then `submit` again.

Field IDs mirror js/config.js TASK_FIELDS and scripts/slack-automation/
approvals.js AF. tests/constant-drift.test.js fails if they ever disagree.

Subcommands:
  queue                       read-only. JSON of eligible work, capped.
  route    TASKID --to RECID  CEO reassigns Team Member.
  submit   TASKID --agent RECID --type TYPE --output-file PATH
  annotate TASKID --note STR  append a dated agent note to the task's Notes.
  intent   TASKID             record BEFORE dispatching a carry-out, so a
                              crash mid-action can never re-execute it blind.
  complete TASKID             after the approved action has been carried out.
  verify   --report PATH      the control. Exits 1, loudly, if there was work
                              and the run did none, if any action failed, or
                              if a claimed write did not actually land.

Usage:  python3 scripts/agent-dispatch.py <subcommand> [args]
Auth:   ~/.config/od/airtable_pat (never printed).
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

LONDON = ZoneInfo("Europe/London")
KEVIN_AIRTABLE_EMAIL = "kevin@runpreneur.org.uk"

# Field IDs — single source is js/config.js; drift-tested, never guess.
AF = {
    "name":              "fldgFjGBw6bTKJFCD",
    "description":       "fldRGhBQViKZKtkQ6",
    "notes":             "fldR7apBzSp3oxFxz",
    "status":            "fldx4qCw17UfrKpaN",
    "assignee":          "fldELMncVJYPDRJNc",
    "dueDate":           "fld7XP8w8kbxfETV4",
    "completion":        "fldFOi1SwEKuJRmdN",
    "priority":          "fldS21RwmwOqt71LI",
    "urgencyScore":      "fldfA3gatzKbwCfUv",
    "teamMember":        "flduCtmQGpOA4eWaj",
    "sentForApprovalBy": "fld30Yw8SWYVp049g",
    "approvalOutcome":   "fldrHBSr6qoUfaKuZ",
    "approvalFeedback":  "fldtI7SJI4gEohHD1",
    "agentOutput":       "fldzswp8fx6PqpLQ5",
    "taskType":          "fldZ2moDV2041Sobc",
}

TASK_TYPES = ("Drafting", "Research", "Analysis", "Build",
              "Audit", "Admin", "Correspondence")
APPROVED = ("Approved as-is", "Approved with minor edits")
OPEN_STATUSES = ("Today", "Overdue")

# How many pieces of work one run may take on. Small on purpose: the approval
# queue has to stay reviewable from a phone. One line to change.
CAP_PER_RUN = 5

# The 17 AI agent Team Member records → the local Claude Code agent that does
# the work. Verified against the live Team Members table on 1 Aug 2026.
# role: ceo routes, head works its own tasks, worker works directly.
AGENTS = {
    "reciHUAEcEkbctnZ6": {"name": "AI CEO (Dan Martell)",                    "agent": "od-ceo",                "role": "ceo"},
    "rec27NaJB7JNLaBB0": {"name": "AI HR & People (Patrick Lencioni)",       "agent": "dept-hr",               "role": "head"},
    "recCzAdg2rO8bha9A": {"name": "AI Wealth (Robert Kiyosaki)",             "agent": "dept-wealth",           "role": "head"},
    "recFZ1ofn0OuoZNEr": {"name": "AI Strategy (Gary Keller)",               "agent": "dept-strategy",         "role": "head"},
    "recGvMnprGf1hr9Z1": {"name": "AI Finance (Greg Crabtree)",              "agent": "dept-finance",          "role": "head"},
    "recMKExCwu0ulMBMG": {"name": "AI Productivity (Chris Bailey)",          "agent": "dept-productivity",     "role": "head"},
    "recRStFWWEyHgOD6t": {"name": "AI Operations (Gino Wickman)",            "agent": "dept-operations",       "role": "head"},
    "recSvV7a47ze9i5X9": {"name": "AI Legal & Compliance (Keith Cunningham)","agent": "dept-legal-compliance", "role": "head"},
    "recYD7avVxouIkH5b": {"name": "AI Systemisation (Dave Jenyns)",          "agent": "dept-systemisation",    "role": "head"},
    "recZlgKJZn7xsBfoz": {"name": "AI Mindset (John F. DeMartini)",          "agent": "dept-mindset",          "role": "head"},
    "reciAJnPnFEbj5FhX": {"name": "AI Marketing (Alex Hormozi)",             "agent": "dept-marketing",        "role": "head"},
    "recpCz18pCLCUf3oJ": {"name": "AI Sales (Jordan Belfort)",               "agent": "dept-sales",            "role": "head"},
    "recFMVmHmqAOVPAeJ": {"name": "AI Worker — Writer",                      "agent": "worker-writer",         "role": "worker"},
    "recPVA1CgGyyGcBd9": {"name": "AI Worker — Auditor",                     "agent": "worker-auditor",        "role": "worker"},
    "recQkO6BA4w5zqwZ4": {"name": "AI Worker — Builder",                     "agent": "worker-builder",        "role": "worker"},
    "recbHvWqlQBbunF2F": {"name": "AI Worker — Researcher",                  "agent": "worker-researcher",     "role": "worker"},
    "recqmKBmq8ZGkxVH9": {"name": "AI Worker — Analyst",                     "agent": "worker-analyst",        "role": "worker"},
}
CEO_REC_ID = "reciHUAEcEkbctnZ6"

# Tier 1: Kevin ONLY, never an agent, whatever an accuracy score says.
# Same six patterns as approvals.js KEVIN_ONLY_PATTERNS — one mechanism.
TIER1_PATTERNS = [
    re.compile(p, re.I) for p in (
        r"restraint order", r"operation lily", r"criminal investigation",
        r"social housing holdings", r"ach investments", r"liquidat",
    )
]
# Tier 2: creditor correspondence is Mica's lane, never an agent's. Kept
# NARROW on purpose — a broad keyword list (e.g. "Companies House") would
# false-positive on legitimate agent research. Parked, not worked.
TIER2_PATTERNS = [
    re.compile(p, re.I) for p in (
        r"letter of claim", r"statutory demand", r"bounce ?back loan",
    )
]


def pat():
    with open(os.path.expanduser("~/.config/od/airtable_pat")) as fh:
        return fh.read().strip()


def _request(method, path, body=None):
    url = f"https://api.airtable.com/v0/{BASE_ID}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {pat()}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"Airtable {method} {path} → HTTP {e.code}: "
            f"{e.read().decode('utf-8', 'replace')[:300]}") from None


def query_tasks(formula, max_records=None, minimal=False):
    records, offset = [], None
    while True:
        params = [("pageSize", "100"), ("returnFieldsByFieldId", "true"),
                  ("filterByFormula", formula)]
        if max_records:
            params.append(("maxRecords", str(max_records)))
        if not minimal:
            params += [("fields[]", f) for f in AF.values()]
        else:
            params.append(("fields[]", AF["name"]))
        if offset:
            params.append(("offset", offset))
        body = _request("GET", f"/{TASKS}?{urllib.parse.urlencode(params)}")
        records += body.get("records", [])
        offset = body.get("offset")
        if not offset:
            return records


def patch_task(task_id, fields):
    return _request("PATCH", f"/{TASKS}/{task_id}",
                    {"fields": fields, "typecast": True})


def get_task(task_id):
    return _request(
        "GET", f"/{TASKS}/{task_id}?returnFieldsByFieldId=true")


def sel(v):
    return v.get("name", "") if isinstance(v, dict) else (v or "")


def links(v):
    if not isinstance(v, list):
        return []
    return [x.get("id") if isinstance(x, dict) else str(x) for x in v if x]


def today_london():
    return datetime.now(LONDON).strftime("%Y-%m-%d")


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


STATE_DIR = os.path.expanduser("~/knowledge-os/logs/agent-dispatch")
INTENT_LEDGER = os.path.join(STATE_DIR, "carryout-intent.jsonl")


def ledger_append(task_id, event):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(INTENT_LEDGER, "a") as fh:
        fh.write(json.dumps({"task": task_id, "ts": now_iso(),
                             "event": event}) + "\n")


def open_intents():
    """Task IDs with a carry-out intent never followed by a done marker —
    i.e. the action may already have happened without the task completing."""
    state = {}
    try:
        with open(INTENT_LEDGER) as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                state[rec.get("task")] = rec.get("event")
    except FileNotFoundError:
        pass
    return {t for t, e in state.items() if e == "intent"}


def tier_match(patterns, *texts):
    hay = " ".join(str(t or "") for t in texts)
    for p in patterns:
        if p.search(hay):
            return p.pattern
    return ""


def task_view(rec):
    f = rec.get("fields", {})
    agent_id = links(f.get(AF["sentForApprovalBy"]))[:1] or links(f.get(AF["teamMember"]))[:1]
    agent_id = agent_id[0] if agent_id else ""
    return {
        "id": rec["id"],
        "name": f.get(AF["name"], "(Untitled)"),
        "description": f.get(AF["description"], ""),
        "notes": f.get(AF["notes"], ""),
        "status": sel(f.get(AF["status"])),
        "dueDate": f.get(AF["dueDate"], ""),
        "priority": sel(f.get(AF["priority"])),
        "urgencyScore": f.get(AF["urgencyScore"]) or 0,
        "outcome": sel(f.get(AF["approvalOutcome"])),
        "feedback": f.get(AF["approvalFeedback"], ""),
        "agentOutput": f.get(AF["agentOutput"], ""),
        "taskType": sel(f.get(AF["taskType"])),
        "teamMemberIds": links(f.get(AF["teamMember"])),
        "sentForApprovalByIds": links(f.get(AF["sentForApprovalBy"])),
        "agentId": agent_id,
        "agentName": AGENTS.get(agent_id, {}).get("name", ""),
        "localAgent": AGENTS.get(agent_id, {}).get("agent", ""),
        "agentRole": AGENTS.get(agent_id, {}).get("role", ""),
    }


def sort_key(t):
    return (t["status"] != "Overdue", t["dueDate"] or "9999",
            -float(t["urgencyScore"] or 0))


# ─── QUEUE ────────────────────────────────────────────────────────────

def cmd_queue(args):
    formula = "OR({Status}='Today',{Status}='Overdue')"
    open_tasks = [task_view(r) for r in query_tasks(formula)]

    # Control of the control: a formula typo or renamed field returns zero
    # rows and reads as "nothing to do" forever. 17 live agents carry real
    # task links, so an empty agent-task population means the READ is broken.
    agent_linked = [t for t in open_tasks
                    if any(i in AGENTS for i in t["teamMemberIds"])
                    or any(i in AGENTS for i in t["sentForApprovalByIds"])]
    handback_population = query_tasks("LEN({Approval Outcome}&'')>0",
                                      max_records=1, minimal=True)
    if not agent_linked and not handback_population:
        print("ERROR: control failed — zero tasks linked to any AI agent and "
              "zero tasks with an approval outcome. The read is broken, not "
              "the queue empty.", file=sys.stderr)
        sys.exit(1)

    skipped_tier1, skipped_tier2, unmapped, unclassified = [], [], [], []
    approved_hb, changes_hb, new_work, routing = [], [], [], []

    for t in agent_linked:
        hit1 = tier_match(TIER1_PATTERNS, t["name"], t["description"], t["notes"])
        if hit1:
            skipped_tier1.append({**t, "matchedPattern": hit1})
            continue
        hit2 = tier_match(TIER2_PATTERNS, t["name"], t["description"], t["notes"])
        if hit2:
            skipped_tier2.append({**t, "matchedPattern": hit2})
            continue
        if not t["localAgent"]:
            unmapped.append(t)
            continue
        # agentId (Sent For Approval By, falling back to Team Member) decides
        # hand-backs: the drawer's decide path sets both, but an approved task
        # missing Sent For Approval By must still be carried out, not lost.
        if t["outcome"] in APPROVED and t["agentId"]:
            approved_hb.append(t)
        elif t["outcome"] == "Changes requested":
            changes_hb.append(t)
        elif not t["outcome"]:
            tm = t["teamMemberIds"][0] if t["teamMemberIds"] else ""
            if tm == CEO_REC_ID:
                routing.append(t)
            elif tm in AGENTS:
                new_work.append(t)
            else:
                # e.g. Team Member cleared while Sent For Approval By still
                # points at an agent. Surfaced, never silently dropped.
                unclassified.append(t)
        else:
            # Includes a Rejected task still sitting open — reject is meant to
            # close, so that state is an anomaly worth eyes, not silence.
            unclassified.append(t)

    for bucket in (approved_hb, changes_hb, new_work, routing):
        bucket.sort(key=sort_key)

    # Hand-backs first — approved work Kevin is waiting on beats new work.
    combined = approved_hb + changes_hb + new_work
    intents = open_intents()
    for t in combined:
        t["kind"] = ("carry_out" if t["outcome"] in APPROVED
                     else "redo" if t["outcome"] == "Changes requested"
                     else "new")
        # A previous run recorded intent to carry this out and never marked it
        # done: the action MAY already have happened. The dispatcher must make
        # the agent VERIFY (sent items, records) before executing anything.
        t["priorIntent"] = t["kind"] == "carry_out" and t["id"] in intents
    worklist = combined[:CAP_PER_RUN]
    # If the dispatcher's judgement pass removes a worklist item (a tier-1
    # smell the keywords missed), it backfills from here — never beyond the cap.
    reserve = combined[CAP_PER_RUN:CAP_PER_RUN * 2]

    out = {
        "generatedAt": now_iso(),
        "cap": CAP_PER_RUN,
        "worklist": worklist,
        "reserve": reserve,
        "routingNeeded": routing,      # CEO tasks; routing is free, work is not
        "skippedTier1": skipped_tier1,
        "skippedTier2": skipped_tier2,
        "unmappedAgent": unmapped,
        "unclassified": unclassified,  # states the buckets cannot place — eyes, not silence
        "agents": AGENTS,              # the roster the CEO routes against
        "counts": {
            "openTasksRead": len(open_tasks),
            "agentLinkedOpen": len(agent_linked),
            "approvedHandbacks": len(approved_hb),
            "changesRequested": len(changes_hb),
            "newWork": len(new_work),
            "routingNeeded": len(routing),
            "unclassified": len(unclassified),
            "worklist": len(worklist),
        },
    }
    print(json.dumps(out, indent=2))


# ─── WRITES ───────────────────────────────────────────────────────────

def cmd_route(args):
    if args.to not in AGENTS:
        sys.exit(f"ERROR: {args.to} is not one of the 17 AI agent records")
    if args.to == CEO_REC_ID:
        sys.exit("ERROR: routing back to the CEO is not a route")
    patch_task(args.task, {AF["teamMember"]: [args.to]})
    print(json.dumps({"routed": args.task, "to": args.to,
                      "agent": AGENTS[args.to]["name"]}))


def cmd_submit(args):
    if args.agent not in AGENTS:
        sys.exit(f"ERROR: {args.agent} is not one of the 17 AI agent records")
    if args.type not in TASK_TYPES:
        sys.exit(f"ERROR: Task Type must be one of {TASK_TYPES}")
    with open(args.output_file) as fh:
        output = fh.read().strip()
    if not output:
        # An empty Agent Output makes the Slack post say "nothing to judge".
        sys.exit("ERROR: refusing to submit an empty Agent Output")
    # The gate: prepared, proposed, and NOTHING sent, filed or executed.
    patch_task(args.task, {
        AF["agentOutput"]: output[:95000],
        AF["taskType"]: args.type,
        AF["status"]: "Approval",
        AF["sentForApprovalBy"]: [args.agent],
        AF["teamMember"]: [args.agent],
        AF["assignee"]: {"email": KEVIN_AIRTABLE_EMAIL},
        AF["dueDate"]: today_london(),
    })
    print(json.dumps({"submitted": args.task,
                      "agent": AGENTS[args.agent]["name"],
                      "type": args.type, "chars": len(output)}))


def cmd_annotate(args):
    # Approved carry-outs usually include "close with a note". Notes is
    # append-only here: never overwrite what a human wrote.
    t = get_task(args.task)
    existing = t.get("fields", {}).get(AF["notes"], "")
    stamp = datetime.now(LONDON).strftime("%d %b %Y")
    note = f"[{stamp} — agent] {args.note}"
    patch_task(args.task, {
        AF["notes"]: (existing + "\n\n" + note).strip(),
    })
    print(json.dumps({"annotated": args.task, "chars": len(note)}))


def cmd_intent(args):
    # Called BEFORE a carry-out is dispatched. If the run dies between the
    # action happening and `complete`, the next run sees the open intent and
    # verifies instead of executing the approved action a second time.
    ledger_append(args.task, "intent")
    print(json.dumps({"intentRecorded": args.task}))


def cmd_complete(args):
    t = task_view(get_task(args.task))
    if t["outcome"] not in APPROVED:
        sys.exit(f"ERROR: refusing to complete {args.task} — outcome is "
                 f"'{t['outcome'] or 'empty'}', not an approval. Only "
                 "approved, carried-out work completes.")
    patch_task(args.task, {
        AF["status"]: "Completed",
        AF["completion"]: now_iso(),
    })
    ledger_append(args.task, "done")
    print(json.dumps({"completed": args.task}))


# ─── VERIFY (the control run-job.sh wraps) ────────────────────────────

def cmd_verify(args):
    try:
        with open(args.report) as fh:
            report = json.load(fh)
    except Exception as e:
        print(f"ERROR: run report unreadable ({e}) — the run was blind",
              file=sys.stderr)
        sys.exit(1)

    problems = []
    counts = report.get("queueCounts", {})
    actions = report.get("actions", [])
    ok_actions = [a for a in actions if a.get("ok")]
    failed = [a for a in actions if not a.get("ok")]

    # A report with no real queue counts means the queue read itself died
    # (PAT missing, outage, renamed field). That must never verify green —
    # it is exactly the blind-run state this control exists to catch.
    if "worklist" not in counts or "openTasksRead" not in counts:
        problems.append("queueCounts is missing or empty — the queue read "
                        "failed and the run was blind")

    # The rule this control exists for: work existed and the run did none.
    if counts.get("worklist", 0) > 0 and not ok_actions:
        problems.append(
            f"{counts['worklist']} eligible tasks and ZERO completed actions")
    for a in failed:
        problems.append(f"action failed: {a.get('kind')} {a.get('task')} — "
                        f"{str(a.get('error'))[:120]}")

    # A tier-1 matter sitting on an agent is a fault, not a queue item. Same
    # for a parked task (approved, but carrying it out would need a payment,
    # credential or signature — never automated at any trust level).
    # Both alarm ONCE per task: a known flag re-alarming twice a day until
    # someone moves the task would train Kevin to ignore the alarm channel.
    state_path = os.path.join(STATE_DIR, "tier1-alerted.json")
    try:
        with open(state_path) as fh:
            alerted = set(json.load(fh))
    except Exception:
        alerted = set()
    flags = ([("TIER-1 task on an agent", t) for t in report.get("tier1Flags", [])]
             + [("approved task PARKED — its carry-out needs a never-automated "
                 "action", t) for t in report.get("parkedFlags", [])])
    for label, t in flags:
        if t.get("id") not in alerted:
            problems.append(f"{label}: {t.get('id')} "
                            f"'{str(t.get('name'))[:60]}'")
    if flags:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(state_path, "w") as fh:
            json.dump(sorted(alerted | {t.get("id") for _, t in flags}), fh)

    # Trust nothing the run claimed: re-read each touched task and check the
    # state actually landed.
    for a in ok_actions:
        try:
            live = task_view(get_task(a["task"]))
        except Exception as e:
            problems.append(f"could not re-read {a.get('task')}: {e}")
            continue
        kind = a.get("kind")
        if kind == "carry_out":
            if live["status"] != "Completed":
                problems.append(f"{a['task']} claimed carried out but Status "
                                f"is '{live['status']}', expected 'Completed'")
        elif kind in ("redo", "new"):
            # Normally still in Approval — but Kevin can decide within a
            # minute of the Slack post, which legitimately moves the task on.
            # The broken states are: still open with no outcome (the submit
            # never landed) or an empty Agent Output (nothing to judge).
            if live["status"] in OPEN_STATUSES and not live["outcome"]:
                problems.append(f"{a['task']} claimed {kind} but the submit "
                                f"never landed (Status '{live['status']}', "
                                "no outcome)")
            if not live["agentOutput"]:
                problems.append(f"{a['task']} submitted with empty Agent Output")
        elif kind == "route":
            to = a.get("to", "")
            if to and to not in live["teamMemberIds"]:
                problems.append(f"{a['task']} claimed routed to {to} but Team "
                                f"Member is {live['teamMemberIds']}")

    if problems:
        for p in problems:
            print(f"ERROR: {p}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps({"ok": True,
                      "actionsVerified": len(ok_actions),
                      "worklistAtStart": counts.get("worklist", 0)}))


# ─── ENTRY ────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("queue")

    r = sub.add_parser("route")
    r.add_argument("task")
    r.add_argument("--to", required=True)

    s = sub.add_parser("submit")
    s.add_argument("task")
    s.add_argument("--agent", required=True)
    s.add_argument("--type", required=True)
    s.add_argument("--output-file", required=True)

    an = sub.add_parser("annotate")
    an.add_argument("task")
    an.add_argument("--note", required=True)

    i = sub.add_parser("intent")
    i.add_argument("task")

    c = sub.add_parser("complete")
    c.add_argument("task")

    v = sub.add_parser("verify")
    v.add_argument("--report", required=True)

    args = p.parse_args()
    {"queue": cmd_queue, "route": cmd_route, "submit": cmd_submit,
     "annotate": cmd_annotate, "intent": cmd_intent,
     "complete": cmd_complete, "verify": cmd_verify}[args.cmd](args)


if __name__ == "__main__":
    main()
