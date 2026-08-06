#!/usr/bin/env python3
"""The single queue of things the routines found but are no longer allowed to fix.

Every scheduled routine is read-only with respect to code. When one spots a
problem it appends a finding here and moves on. One fixer run later drains this
queue, in one worktree, behind one lock, into one pull request.

The file lives in ~/knowledge-os/logs, NOT in the repo. The repo is public, and
sweep output has already leaked tenant data into it once. Findings quote real
records, so they stay off GitHub.

Usage
    findings.py add --routine drift-monitor --title "..." --where js/config.js:42 \
                    --detail "..." --fix "..." [--severity high]
    findings.py list [--status open] [--routine X] [--json]
    findings.py claim <id> --by queue-fixer
    findings.py close <id> --outcome fixed|rejected|deferred --note "..."
    findings.py count [--status open]
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime

HOME = os.path.expanduser("~")
FINDINGS = os.environ.get(
    "FINDINGS_FILE", os.path.join(HOME, "knowledge-os/logs/findings-queue.jsonl")
)

SEVERITIES = ["critical", "high", "medium", "low"]
OPEN_STATES = ["open", "claimed"]


def iso():
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def ensure():
    os.makedirs(os.path.dirname(FINDINGS), exist_ok=True)


def read_all():
    ensure()
    if not os.path.exists(FINDINGS):
        return []
    out = []
    with open(FINDINGS) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def append(rec):
    ensure()
    with open(FINDINGS, "a") as f:
        f.write(json.dumps(rec) + "\n")


def current_state():
    """Fold the append-only log into the current state of each finding.

    Append-only rather than rewrite-in-place: two routines writing findings at
    the same moment must never truncate each other's work, and the history of
    what was found and when survives a bad fixer run.
    """
    state = {}
    for rec in read_all():
        fid = rec.get("id")
        if not fid:
            continue
        if rec.get("op") == "add":
            state[fid] = dict(rec, status="open")
        elif fid in state:
            if rec.get("op") == "claim":
                state[fid]["status"] = "claimed"
                state[fid]["claimed_by"] = rec.get("by")
            elif rec.get("op") == "close":
                state[fid]["status"] = rec.get("outcome", "closed")
                state[fid]["close_note"] = rec.get("note")
    return state


def next_id(routine):
    n = sum(1 for r in read_all() if r.get("op") == "add") + 1
    return "%s-%s-%03d" % (datetime.now().strftime("%Y%m%d"), routine[:24], n)


def cmd_add(a):
    fid = next_id(a.routine)
    append({
        "op": "add", "id": fid, "ts": iso(), "routine": a.routine,
        "severity": a.severity, "title": a.title, "where": a.where,
        "detail": a.detail, "proposed_fix": a.fix, "touches_code": a.touches_code,
    })
    print(fid)
    return 0


def cmd_list(a):
    state = current_state()
    rows = [r for r in state.values()
            if (a.status is None or r["status"] == a.status)
            and (a.routine is None or r["routine"] == a.routine)]
    rows.sort(key=lambda r: (SEVERITIES.index(r.get("severity", "low"))
                             if r.get("severity") in SEVERITIES else 9, r["ts"]))
    if a.json:
        print(json.dumps(rows, indent=2))
        return 0
    if not rows:
        print("No findings match.")
        return 0
    for r in rows:
        print("[%s] %-8s %-20s %s" % (r["id"], r.get("severity", "?"),
                                      r["routine"], r["title"]))
        if r.get("where"):
            print("         where: %s" % r["where"])
        if r.get("proposed_fix"):
            print("         fix:   %s" % r["proposed_fix"])
    return 0


def cmd_claim(a):
    state = current_state()
    if a.id not in state:
        print("ERROR: no finding %s" % a.id, file=sys.stderr)
        return 1
    # Only an unclaimed finding may be claimed. Allowing a re-claim would let two
    # fixer runs both believe they own the same repair and write it twice.
    if state[a.id]["status"] != "open":
        print("ERROR: %s is already %s" % (a.id, state[a.id]["status"]), file=sys.stderr)
        return 1
    append({"op": "claim", "id": a.id, "ts": iso(), "by": a.by})
    print("claimed %s" % a.id)
    return 0


def cmd_close(a):
    state = current_state()
    if a.id not in state:
        print("ERROR: no finding %s" % a.id, file=sys.stderr)
        return 1
    append({"op": "close", "id": a.id, "ts": iso(),
            "outcome": a.outcome, "note": a.note})
    print("closed %s as %s" % (a.id, a.outcome))
    return 0


def cmd_count(a):
    state = current_state()
    if a.status:
        print(sum(1 for r in state.values() if r["status"] == a.status))
    else:
        print(len(state))
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("add")
    sp.add_argument("--routine", required=True)
    sp.add_argument("--title", required=True)
    sp.add_argument("--where", default="")
    sp.add_argument("--detail", default="")
    sp.add_argument("--fix", default="")
    sp.add_argument("--severity", default="medium", choices=SEVERITIES)
    sp.add_argument("--touches-code", action="store_true",
                    help="set when fixing this means editing a repo file")
    sp.set_defaults(fn=cmd_add)

    sp = sub.add_parser("list")
    sp.add_argument("--status")
    sp.add_argument("--routine")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(fn=cmd_list)

    sp = sub.add_parser("claim")
    sp.add_argument("id")
    sp.add_argument("--by", required=True)
    sp.set_defaults(fn=cmd_claim)

    sp = sub.add_parser("close")
    sp.add_argument("id")
    sp.add_argument("--outcome", required=True,
                    choices=["fixed", "rejected", "deferred"])
    sp.add_argument("--note", default="")
    sp.set_defaults(fn=cmd_close)

    sp = sub.add_parser("count")
    sp.add_argument("--status")
    sp.set_defaults(fn=cmd_count)

    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
