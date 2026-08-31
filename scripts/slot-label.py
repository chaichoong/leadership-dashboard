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
"""

import argparse
import sys
from datetime import datetime

SLOTS = (9, 13, 17)


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
        now = datetime.now()
    print(label(now))
    return 0


if __name__ == "__main__":
    sys.exit(main())
