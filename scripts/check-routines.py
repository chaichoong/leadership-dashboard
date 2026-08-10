#!/usr/bin/env python3
"""Exactly ONE Claude routine may actually run, and it must be daily-ops.

WHY
---
Fourteen separately-scheduled routines shared one Mac. They stampeded on wake and
overwrote each other; serialising them behind a lock then produced a worse
failure, because a routine suspended by the Mac sleeping keeps HOLDING the lock
(drift-monitor held it 4h54m on 8 Aug 2026). Everything behind it was skipped for
lateness and `ceo-huddle` never ran once.

The fix was to fold every routine into `daily-ops`, which runs them in sequence.
That fix has one failure mode: somebody adds a fifteenth routine six weeks from
now and the stacking starts again, quietly, because nothing errors.

WHY THIS IS NOW A BEHAVIOURAL CHECK, NOT A CONFIG CHECK
-------------------------------------------------------
Until 10 Aug 2026 this read the scheduler's own `scheduled-tasks.json`. That
turned out to be a file the app NO LONGER WRITES. Proved by calling the
scheduler API twice, once to disable a routine and once to change its
description: both reported success and the file's mtime never moved, and its
`description` fields sit empty while the scheduler reports full ones.

So the guard was wrong in both directions at once. It reported ROUTINE STACKING
for `uc-check-slack-notifier`, which was already disabled and had not fired since
8 Aug — a false alarm that reddened the pre-push gate for `main`. And the mirror
image was worse: a routine genuinely enabled tomorrow would not appear in that
file either, so the guard would have reported all clear for ever.

Config that nothing writes cannot fail loudly. So stop asking what is SCHEDULED
and look at what actually RAN. A routine that runs takes the queue lock and
leaves a line in `queue-events.jsonl`. That evidence is written by the thing
being measured, at the moment it happens, and it cannot go stale.

It also measures the thing that actually hurts. A second routine sitting enabled
but never firing harms nobody; two routines writing at once is the whole injury.

THE CONTROL
-----------
Three states would otherwise read as "no extra routines, all clear" for ever, so
each one FAILS instead:

1. The event log is missing or unreadable.
2. The window holds ZERO events of any kind. The registered shell jobs run
   several times a day, so an empty day means the log stopped, not that the Mac
   was quiet.
3. `daily-ops` itself left no mark in the window — nothing ran at all, which is
   the same alarm the old check raised when daily-ops was switched off.

KNOWN LIMIT, stated rather than hidden: this sees a routine that takes the queue
lock. A routine re-enabled and then edited to skip the lock would run unseen.
That is a narrower hole than the one it replaces, and phase 1 of daily-ops is
where a new routine's own instructions would be read anyway.

Usage:  check-routines.py [--json] [--window-hours N]
Exit:   0 clean · 1 violation · 2 cannot verify (treat as a violation)
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta

HOME = os.path.expanduser("~")

# Written by job-queue.py every time any job takes or releases the lock.
EVENTS = os.environ.get(
    "JOB_QUEUE_EVENTS",
    os.path.join(HOME, "knowledge-os/logs/queue/queue-events.jsonl"),
)

# A directory here with a SKILL.md in it IS a Claude routine. This is what
# separates a routine from the registered shell jobs, which take the same lock
# perfectly legitimately several times a day and must never trip the alarm.
ROUTINE_DIR = os.environ.get(
    "CLAUDE_ROUTINE_DIR", os.path.join(HOME, ".claude/scheduled-tasks")
)

# The one routine allowed to run.
THE_ROUTINE = "daily-ops"

# A full day plus the slack for a late wake. daily-ops itself runs an hour or two.
DEFAULT_WINDOW_HOURS = 26

# States that mean a job genuinely got going. `mark` is what daily-ops writes in
# phase 1, because it deliberately does NOT take the lock (holding it for two
# hours would block every short shell job behind it).
RAN_STATES = ("acquired", "started", "mark")


def known_routines():
    """Every routine name the Mac knows about, from the folders on disk."""
    try:
        names = os.listdir(ROUTINE_DIR)
    except OSError:
        return None
    return {n for n in names
            if os.path.isfile(os.path.join(ROUTINE_DIR, n, "SKILL.md"))}


def read_events(window_hours):
    """Events inside the window. Returns (all_in_window, error) — an unreadable
    log is an error, never an empty list, because they mean opposite things."""
    cutoff = (datetime.utcnow() - timedelta(hours=window_hours)).strftime(
        "%Y-%m-%dT%H:%M:%S")
    rows = []
    try:
        with open(EVENTS) as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue          # one torn line must not blind the check
                if rec.get("ts", "") >= cutoff:
                    rows.append(rec)
    except OSError as e:
        return None, "cannot read the queue event log: %s" % e
    return rows, None


def check(window_hours=DEFAULT_WINDOW_HOURS):
    routines = known_routines()
    if routines is None:
        return 2, {"ok": False,
                   "reason": "cannot list the routine folder",
                   "detail": "%s is unreadable, so a routine cannot be told from "
                             "a shell job. Cannot verify, so treat as broken "
                             "rather than clean." % ROUTINE_DIR}
    if not routines:
        return 2, {"ok": False,
                   "reason": "no routines found on disk",
                   "detail": "%s holds no folder with a SKILL.md. An empty list "
                             "would match nothing and pass for ever." % ROUTINE_DIR}

    rows, err = read_events(window_hours)
    if err:
        return 2, {"ok": False, "reason": err,
                   "detail": "%s is the evidence this check is built on. Without "
                             "it there is no verdict." % EVENTS}
    if not rows:
        return 2, {"ok": False,
                   "reason": "no queue events at all in the last %dh" % window_hours,
                   "detail": "The registered shell jobs run several times a day, so "
                             "an empty window means the log stopped, not that the "
                             "Mac was quiet. Cannot verify, so treat as broken."}

    ran = {}
    for rec in rows:
        if rec.get("state") in RAN_STATES:
            ran.setdefault(rec.get("job"), []).append(rec.get("ts"))

    ran_routines = sorted(n for n in ran if n in routines)
    extras = sorted(n for n in ran_routines if n != THE_ROUTINE)

    result = {
        "events_log": EVENTS,
        "window_hours": window_hours,
        "events_in_window": len(rows),
        "routines_known": len(routines),
        "routines_that_ran": ran_routines,
        "extras": extras,
        "the_routine_ran": THE_ROUTINE in ran,
        "non_routine_jobs_that_ran": sorted(n for n in ran if n not in routines),
    }

    if extras:
        result["ok"] = False
        result["when"] = {n: ran[n][-1] for n in extras}
        result["reason"] = (
            "%d routine(s) actually RAN outside %s in the last %dh: %s. They "
            "overlap with it and write beside it. Disable each one and fold its "
            "work in as a phase — daily work into the main sequence, anything "
            "weekly/monthly/quarterly into phase 6b behind a date check."
            % (len(extras), THE_ROUTINE, window_hours, ", ".join(extras))
        )
        return 1, result

    if not result["the_routine_ran"]:
        result["ok"] = False
        result["reason"] = (
            "%s left no mark in the last %dh — nothing ran at all. It writes one "
            "in phase 1, so either it did not start or phase 1 failed before "
            "reaching the mark." % (THE_ROUTINE, window_hours)
        )
        return 1, result

    result["ok"] = True
    result["reason"] = ("only %s ran in the last %dh (%d queue events seen)"
                        % (THE_ROUTINE, window_hours, len(rows)))
    return 0, result


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--json", action="store_true")
    p.add_argument("--window-hours", type=int, default=DEFAULT_WINDOW_HOURS)
    a = p.parse_args()

    code, result = check(a.window_hours)
    if a.json:
        print(json.dumps(result, indent=2))
    elif code == 0:
        print("OK: %s" % result["reason"])
        print("    %d routines known, %d other job(s) also used the queue"
              % (result["routines_known"], len(result["non_routine_jobs_that_ran"])))
    else:
        print("ROUTINE STACKING: %s" % result["reason"], file=sys.stderr)
        if result.get("detail"):
            print("    %s" % result["detail"], file=sys.stderr)
        if result.get("when"):
            for name, ts in sorted(result["when"].items()):
                print("    %s last ran %s" % (name, ts), file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
