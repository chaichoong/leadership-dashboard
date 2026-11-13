#!/usr/bin/env python3
"""What a slot actually read and decided, as one clause appended to its "run OK" line.

Every other morning check states its population: the drift scan names the tables and fields it
scanned, the data checks name the broken one, the compliance line says "0 of 50". The inbox sort
said only "inbound-triage run OK", so a run that decided sixty messages and one that decided none
wrote the identical line, and daily-ops had to count the waiting mail itself with a separate Gmail
search before it could call the slot green (finding 20261111-daily-ops-1278).

A tally that cannot be read is said so in words. It is never a zero, because a zero gets acted on.
"""
import collections
import json
import os
import sys
from datetime import date

DIGEST = "~/knowledge-os/logs/inbound-triage/digest-%s.jsonl"


def digest_path(day=None):
    return os.path.expanduser(DIGEST % (day or date.today().isoformat()))


def tally(job, path=None, day=None):
    """The clause for this job, or "" for a job with no tally of its own."""
    if job != "inbound-triage":
        return ""
    path = path or digest_path(day)
    try:
        if not os.path.exists(path):
            return " — nothing decided today (no digest written)"
        with open(path) as fh:
            lines = [ln.strip() for ln in fh if ln.strip()]
    except OSError as exc:
        return " — tally unavailable (%s)" % exc.__class__.__name__
    if not lines:
        return " — nothing decided today (digest empty)"
    counts = collections.Counter()
    for ln in lines:
        try:
            counts[json.loads(ln).get("do") or "?"] += 1
        except ValueError:
            counts["unreadable"] += 1
    tasks = counts["task-created"]
    filed = sum(n for k, n in counts.items() if k.startswith("file-") or k.startswith("label"))
    unreadable = counts["unreadable"]
    out = (" — decided %d today: %d task%s, %d filed, %d archived, %d left for Kevin"
           % (len(lines), tasks, "" if tasks == 1 else "s", filed, counts["archive"], counts["leave"]))
    if unreadable:
        out += ", %d line%s unreadable" % (unreadable, "" if unreadable == 1 else "s")
    return out


def main(argv):
    if not argv:
        return 0
    try:
        print(tally(argv[0], path=argv[1] if len(argv) > 1 else None), end="")
    except Exception as exc:                                  # never fail a green slot over its own tally
        print(" — tally unavailable (%s)" % exc.__class__.__name__, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
