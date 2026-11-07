#!/usr/bin/env python3
"""Which of the three daily slots is this run? Decided by the CLOCK, once.

WHY THIS EXISTS (29 Aug 2026, finding 20260829-daily-ops-396)
--------------------------------------------------------------
The slot runners told the agent "you are one of the 09:00 / 13:00 / 17:00
slots" and left it to work out which. It could not — nothing in its context
carries the launchd trigger time — so it guessed, and it guessed "13:00 slot"
every single run. Three rounds a day all filed reports under the same
heading, which made the 09:00 and 17:00 rounds impossible to tell apart in
the log and hid a slot that had not run at all behind one that had.

A label the agent invents is not evidence. The wrapper reads the wall clock at
run start, and the agent echoes the value it was handed.

Nearest scheduled hour wins, ties to the earlier slot, so launchd firing at
08:57 or a queue wait to 09:20 both still read as the 09:00 slot.

AND THE CLOCK IS THE TRIGGER'S, NOT THE LOCK'S (finding 20261029-phase-2-1120)
------------------------------------------------------------------------------
A nearest-hour rule only survives a SHORT wait. On 28 Oct 2026 all three
task-manager slots fired on time and each waited behind inbound-triage: the
13:20 slot acquired the queue lock at 15:15:11, read the wall clock, and called
itself the 17:00 slot. It wrote report-2026-10-28-17.md; the real 17:20 run
found that name taken. runs.log then read "09:00, 17:00, 17:00" for the day, so
a reader counting slots saw a missed midday round that had in fact run, and two
runs claimed one slot in the report trail.

So the clock this reads is the moment the job was CALLED, which job-queue.py
hands down as JOB_QUEUE_QUEUED_AT before it starts waiting. The wall clock is
the fallback for a run started outside the queue, and a wait of any length can
no longer rename a slot.
"""

import argparse
import os
import sys
from datetime import datetime, timezone

SLOTS = (9, 13, 17)


def queued_at():
    """The trigger time the queue handed down, in local time, or None.

    Anything unreadable is None and the caller falls back to the wall clock: a
    label is better slightly wrong than absent, and a malformed stamp must not
    stop a slot running."""
    raw = (os.environ.get("JOB_QUEUE_QUEUED_AT") or "").strip()
    if not raw:
        return None
    try:
        # job-queue.py writes UTC with a trailing Z.
        stamp = datetime.strptime(raw, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None
    return stamp.astimezone()


def label(now):
    """The slot this moment belongs to, as 'HH:MM'."""
    mins = now.hour * 60 + now.minute
    best = min(SLOTS, key=lambda h: (abs(mins - h * 60), h))
    return "%02d:00" % best


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--at", help="HH:MM to judge instead of now (for tests)")
    a = p.parse_args(argv)
    if a.at:
        try:
            hh, mm = a.at.split(":")
            now = datetime.now().replace(hour=int(hh), minute=int(mm))
        except (ValueError, TypeError):
            print("ERROR: --at wants HH:MM, got %r" % a.at, file=sys.stderr)
            return 2
    else:
        # The trigger time first, the wall clock only when there is none.
        now = queued_at() or datetime.now()
    print(label(now))
    return 0


if __name__ == "__main__":
    sys.exit(main())
