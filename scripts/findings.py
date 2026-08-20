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
    findings.py reopen --stale [--lease-hours 12] [--dry-run]
    findings.py reopen <id>
    findings.py count [--status open]

A claim is a LEASE, not a transfer of ownership. A fixer run that claims findings
and then dies used to keep them for ever: `list --status open` cannot see a
claimed finding and nothing ever handed it back. Nine high-severity findings sat
invisible for six days that way after a run died on 2026-08-14 (finding
20260820-daily-ops-254). `reopen --stale` is what collects the expired leases.
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta

HOME = os.path.expanduser("~")
FINDINGS = os.environ.get(
    "FINDINGS_FILE", os.path.join(HOME, "knowledge-os/logs/findings-queue.jsonl")
)

SEVERITIES = ["critical", "high", "medium", "low"]
OPEN_STATES = ["open", "claimed"]

# How long a claim holds a finding before `reopen --stale` takes it back. A fixer
# run is capped at ten findings and finishes inside an hour; twelve hours means a
# lease only ever expires because the run died.
DEFAULT_LEASE_HOURS = 12


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
                state[fid]["claimed_at"] = rec.get("ts")
            elif rec.get("op") == "reopen":
                # The lease expired. Hand the finding back to the queue and drop
                # the dead run's ownership, so `claim` accepts it again.
                state[fid]["status"] = "open"
                state[fid]["claimed_by"] = None
                state[fid]["claimed_at"] = None
                state[fid]["reopened_at"] = rec.get("ts")
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


def parse_ts(value):
    """Parse a queue timestamp. Returns None when it is missing or unreadable."""
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, TypeError):
        return None


def stale_claims(state, lease_hours=DEFAULT_LEASE_HOURS, now=None):
    """Findings still claimed after their lease ran out, oldest claim first.

    A claim with no readable timestamp counts as stale. Every real claim writes
    one, so an unreadable value means a corrupt write, and leaving it out would
    put the finding back in the invisible state this command exists to end.
    """
    now = now or datetime.utcnow()
    cutoff = now - timedelta(hours=lease_hours)
    rows = []
    for rec in state.values():
        if rec.get("status") != "claimed":
            continue
        ts = parse_ts(rec.get("claimed_at"))
        if ts is not None and ts > cutoff:
            continue
        rows.append(rec)
    rows.sort(key=lambda r: r.get("claimed_at") or "")
    return rows


def cmd_reopen(a):
    state = current_state()
    if a.id:
        rec = state.get(a.id)
        if rec is None:
            print("ERROR: no finding %s" % a.id, file=sys.stderr)
            return 1
        if rec["status"] != "claimed":
            print("ERROR: %s is %s, not claimed" % (a.id, rec["status"]),
                  file=sys.stderr)
            return 1
        rows = [rec]
        reason = "manual"
    elif a.stale:
        rows = stale_claims(state, a.lease_hours)
        reason = "stale claim (lease %dh expired)" % a.lease_hours
    else:
        print("ERROR: pass a finding id or --stale", file=sys.stderr)
        return 2

    for rec in rows:
        if not a.dry_run:
            append({"op": "reopen", "id": rec["id"], "ts": iso(),
                    "reason": reason, "was_claimed_by": rec.get("claimed_by"),
                    "was_claimed_at": rec.get("claimed_at")})
        print("%s%s claimed by %s at %s (%s)" % (
            "would reopen " if a.dry_run else "reopened ", rec["id"],
            rec.get("claimed_by") or "?", rec.get("claimed_at") or "?",
            rec.get("severity", "?")))
    # Always print the count, including zero: phase 1 reports this number, and
    # findings coming BACK means a run died, which is worth saying out loud.
    print("reopened %d" % len(rows))
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

    sp = sub.add_parser("reopen")
    sp.add_argument("id", nargs="?", help="reopen one claimed finding")
    sp.add_argument("--stale", action="store_true",
                    help="reopen every claim whose lease has expired")
    sp.add_argument("--lease-hours", type=int, default=DEFAULT_LEASE_HOURS)
    sp.add_argument("--dry-run", action="store_true",
                    help="report what would be reopened without writing")
    sp.set_defaults(fn=cmd_reopen)

    sp = sub.add_parser("count")
    sp.add_argument("--status")
    sp.set_defaults(fn=cmd_count)

    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
