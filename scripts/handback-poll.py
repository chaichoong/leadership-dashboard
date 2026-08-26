#!/usr/bin/env python3
"""Decide whether this 30-minute tick should wake an agent, and prove it ran.

WHY THIS EXISTS (26 Aug 2026, Kevin's call)
-------------------------------------------
Measured over 1-26 Aug 2026: once Kevin approves a piece of agent work, the
agent's OWN effort to carry it out is a median of five minutes. The elapsed time
he actually experienced was a median of 3.6 hours, and 99% of that was not work.
It was waiting for the next scheduled dispatch run to open the queue.

Nothing watched the hand-back queue. `agent-dispatch` ran inside `daily-ops` at
07:00 and in the three `inbound-triage` slots, so a tap on Slack at 09:05 sat
until 13:00. This closes that gap: check every thirty minutes, and wake an agent
only when there is genuinely something handed back.

WHY A GATE RATHER THAN JUST RUNNING IT
--------------------------------------
Forty-eight Claude runs a day to discover nothing changed would be absurd. The
expensive half (the headless `claude -p`) fires only when this gate says WORK.
The cheap half is a single Airtable read through the same
`agent-dispatch.py queue` the real run uses, so the gate and the run can never
disagree about what is queued.

THE CONTROLS (see feedback_a_running_job_is_not_a_working_job)
--------------------------------------------------------------
A poller that answers "nothing to do" is indistinguishable from a poller that
has quietly broken, and it would stay silent for ever. So four states FAIL loudly
instead of reading as a quiet queue:

1. The queue JSON is missing or unparseable.
2. Its `counts` object is missing or empty — the queue read itself died.
3. Any of the three hand-back count keys is ABSENT. This is the sharpest one:
   `counts.get("approvedHandbacks", 0)` returns 0 for a renamed key exactly as
   it does for an empty queue, so the poller would sleep for ever and nothing
   would error. The keys must be PRESENT, not merely falsy.
4. The queue reports open agent work but reports zero of every hand-back key
   AND zero new work — a shape the live queue does not produce.

Exit codes: 0 = WORK (spawn the agent) · 3 = SKIP (idle, or a run is already
in flight) · 1 = BROKEN (run-job.sh alarms Kevin).
"""

import argparse
import json
import os
import sys
import time

# The three queue keys that mean "Kevin has decided and an agent owes him an
# action". Named here rather than inlined so the drift test can assert that
# agent-dispatch.py still emits every one of them.
HANDBACK_KEYS = ("approvedHandbacks", "changesRequested", "deferredRedos")

# Keys that must exist for the counts object to be a real queue read at all.
# Mirrors cmd_verify's own blind-run check in agent-dispatch.py.
SHAPE_KEYS = ("worklist", "openTasksRead")

DISPATCH_LOGS = os.path.expanduser("~/knowledge-os/logs/agent-dispatch")

# A dispatch run that is genuinely working writes agent output continuously. A
# run that crashed leaves its directory behind for ever. So "in flight" is
# decided on FRESHNESS, not on the mere absence of a report: a directory whose
# newest file has not moved in this many minutes is dead, not busy.
INFLIGHT_MINUTES = 10


class Broken(Exception):
    """The read failed. Never the same thing as an empty queue."""


def load_counts(path):
    try:
        with open(path) as fh:
            queue = json.load(fh)
    except FileNotFoundError:
        raise Broken(f"queue JSON not found at {path} — the queue read never ran")
    except (OSError, ValueError) as exc:
        raise Broken(f"queue JSON at {path} is unreadable ({exc})")

    counts = queue.get("counts")
    if not isinstance(counts, dict) or not counts:
        raise Broken("queue JSON carries no counts object — the queue read "
                     "failed and this tick was blind")

    missing = [k for k in SHAPE_KEYS + HANDBACK_KEYS if k not in counts]
    if missing:
        raise Broken(
            "queue counts are missing " + ", ".join(missing) +
            " — a renamed count key reads as zero for ever, so this fails "
            "rather than reporting a quiet queue")
    return queue, counts


def inflight_run(logs_dir=DISPATCH_LOGS, minutes=INFLIGHT_MINUTES, now=None):
    """Name of a dispatch run that is actively writing right now, or None.

    Two runs working the same hand-back would carry the approved action out
    twice. The intent ledger makes that recoverable; not starting is better.
    """
    now = now if now is not None else time.time()
    try:
        entries = os.listdir(logs_dir)
    except OSError:
        return None  # no log directory yet is not a fault on a first run
    for name in sorted(entries, reverse=True):
        run = os.path.join(logs_dir, name)
        if not os.path.isdir(run):
            continue
        if os.path.exists(os.path.join(run, "report.json")):
            continue  # finished, whatever its verdict
        newest = 0.0
        for root, _dirs, files in os.walk(run):
            for f in files:
                try:
                    newest = max(newest, os.path.getmtime(os.path.join(root, f)))
                except OSError:
                    continue
        if newest and (now - newest) < minutes * 60:
            return name
    return None


def decide(queue_path, logs_dir=DISPATCH_LOGS, minutes=INFLIGHT_MINUTES,
           now=None):
    queue, counts = load_counts(queue_path)

    handbacks = {k: int(counts.get(k) or 0) for k in HANDBACK_KEYS}
    total = sum(handbacks.values())

    # Control 4. The live queue always shows SOMETHING when agents hold open
    # tasks: work waiting on Kevin, work waiting on an agent, or new work. All
    # four at zero while agents carry open tasks is a filter that has stopped
    # matching, not a clear desk.
    if (total == 0 and not int(counts.get("newWork") or 0)
            and int(counts.get("agentLinkedOpen") or 0) > 0
            and int(counts.get("worklist") or 0) > 0):
        raise Broken(
            f"{counts['worklist']} tasks in the worklist but every hand-back "
            "and new-work count is zero — the classifier is broken, not the "
            "queue empty")

    busy = inflight_run(logs_dir, minutes, now)
    if busy:
        return dict(decision="skip", reason=f"dispatch run {busy} is in flight",
                    handbacks=handbacks, total=total, counts=counts)
    if total == 0:
        return dict(decision="idle", reason="no hand-backs waiting",
                    handbacks=handbacks, total=total, counts=counts)
    return dict(decision="work",
                reason=f"{total} hand-back(s) waiting on an agent",
                handbacks=handbacks, total=total, counts=counts)


def cmd_gate(args):
    try:
        out = decide(args.queue, args.dispatch_logs, args.inflight_minutes)
    except Broken as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        print(json.dumps(dict(decision="broken", reason=str(exc))))
        return 1
    slim = {k: v for k, v in out.items() if k != "counts"}
    slim["worklist"] = int(out["counts"].get("worklist") or 0)
    print(json.dumps(slim))
    return 0 if out["decision"] == "work" else 3


def cmd_beat(args):
    """One line per tick, working or not.

    The heartbeat is the only evidence that a tick which found nothing actually
    happened. Without it, a poller stopped by a bad plist and a genuinely quiet
    afternoon look identical for ever.
    """
    line = dict(ts=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                decision=args.decision, reason=args.reason,
                handbacks=args.handbacks, spawned=args.spawned)
    os.makedirs(os.path.dirname(args.log), exist_ok=True)
    with open(args.log, "a") as fh:
        fh.write(json.dumps(line) + "\n")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("gate", help="decide whether to wake an agent")
    g.add_argument("--queue", required=True)
    g.add_argument("--dispatch-logs", default=DISPATCH_LOGS)
    g.add_argument("--inflight-minutes", type=int, default=INFLIGHT_MINUTES)

    b = sub.add_parser("beat", help="append one heartbeat line")
    b.add_argument("--log", required=True)
    b.add_argument("--decision", required=True)
    b.add_argument("--reason", default="")
    b.add_argument("--handbacks", type=int, default=0)
    b.add_argument("--spawned", default="no")

    args = p.parse_args(argv)
    return {"gate": cmd_gate, "beat": cmd_beat}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
