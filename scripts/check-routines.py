#!/usr/bin/env python3
"""There must be exactly ONE enabled Claude routine, and it must be daily-ops.

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

So this asserts the invariant instead of trusting anyone to remember it. It reads
the SCHEDULER'S OWN STORE, not our config file, because a routine created through
the app never touches our config and a check against our config would happily
pass while three new routines fired every morning.

THE CONTROL
-----------
A store that cannot be found, or that holds zero tasks, FAILS. Those are exactly
the states that would otherwise read as "no extra routines, all clear" for ever.

Usage:  check-routines.py [--json]
Exit:   0 clean · 1 violation · 2 cannot verify (treat as a violation)
"""

import argparse
import glob
import json
import os
import sys

SESSIONS_GLOB = os.path.expanduser(
    "~/Library/Application Support/Claude/claude-code-sessions/"
    "*/*/scheduled-tasks.json"
)

# The one routine allowed to hold a schedule of its own.
THE_ROUTINE = "daily-ops"


def find_store():
    """The scheduled-tasks.json that actually holds the routines.

    Several sessions each keep a file and most are empty, so pick the one with
    the most tasks rather than the first one found. Returns (path, tasks).
    """
    best, best_tasks = None, []
    for path in sorted(glob.glob(SESSIONS_GLOB)):
        try:
            with open(path) as f:
                tasks = json.load(f).get("scheduledTasks", [])
        except (OSError, json.JSONDecodeError):
            continue
        # Track the first readable file even when it is empty, so "the store is
        # there and empty" stays distinguishable from "there is no store". They
        # both fail, but they send you to completely different places.
        if best is None or len(tasks) > len(best_tasks):
            best, best_tasks = path, tasks
    return best, best_tasks


def routine_name(task):
    """The routine's folder name, which is what humans call it."""
    fp = task.get("filePath") or ""
    if fp:
        return os.path.basename(os.path.dirname(fp))
    return task.get("id") or "(unnamed)"


def check():
    path, tasks = find_store()

    if path is None:
        return 2, {"ok": False, "reason": "no scheduled-tasks.json found",
                   "detail": "Looked under %s. Cannot verify, so treat as broken "
                             "rather than clean." % SESSIONS_GLOB}
    if not tasks:
        return 2, {"ok": False, "reason": "the scheduler store holds zero tasks",
                   "detail": "%s is empty. A genuinely empty store and a broken "
                             "read look identical, so this fails rather than "
                             "passing." % path}

    enabled = [routine_name(t) for t in tasks if t.get("enabled")]
    extras = sorted(n for n in enabled if n != THE_ROUTINE)

    result = {
        "store": path,
        "tasks_total": len(tasks),
        "enabled": sorted(enabled),
        "extras": extras,
        "the_routine_enabled": THE_ROUTINE in enabled,
    }

    if not result["the_routine_enabled"]:
        result["ok"] = False
        result["reason"] = "%s is NOT enabled — nothing runs at all" % THE_ROUTINE
        return 1, result

    if extras:
        result["ok"] = False
        result["reason"] = (
            "%d routine(s) scheduled outside %s: %s. They will overlap with it. "
            "Disable each one and fold its work in as a phase — daily work into "
            "the main sequence, anything weekly/monthly/quarterly into phase 6b "
            "behind a date check." % (len(extras), THE_ROUTINE, ", ".join(extras))
        )
        return 1, result

    result["ok"] = True
    result["reason"] = "exactly one enabled routine (%s)" % THE_ROUTINE
    return 0, result


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--json", action="store_true")
    a = p.parse_args()

    code, result = check()
    if a.json:
        print(json.dumps(result, indent=2))
    elif code == 0:
        print("OK: %s" % result["reason"])
        print("    %d tasks in the store, %d enabled" %
              (result["tasks_total"], len(result["enabled"])))
    else:
        print("ROUTINE STACKING: %s" % result["reason"], file=sys.stderr)
        if result.get("detail"):
            print("    %s" % result["detail"], file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
