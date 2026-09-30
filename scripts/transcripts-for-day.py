#!/usr/bin/env python3
"""Which session transcripts actually hold lines from a given day.

WHY THIS EXISTS (finding 20260924-ceo-memory-sweep-591). The nightly memory
sweep picked transcripts by FILE MTIME. Mtime answers "when was this file last
touched", which is not "what day is the conversation in it", and the two come
apart in both directions:

  * On the 24 Sep run for 23 Sep, three of the files mtime selected held
    content from 15, 21-22 and 22 Sep. They were caught by hand.
  * A session live on 23 Sep and resumed on 24 Sep has a 24 Sep mtime, so it
    fell outside the window entirely and would never have been read.

So selection reads the LINE timestamps inside each transcript. A file counts
when it holds at least one line dated on the target day, and the count of those
lines is reported so a file with one stray line is visible as such.

Usage:
    transcripts-for-day.py [YYYY-MM-DD] [--dir D]... [--json] [--min-lines N]
    transcripts-for-day.py selftest

With no date it uses YESTERDAY in local time, which is the day the sweep
distils. Default directories are every Claude Code project transcript folder.
Exit 0 with matches, 1 with none (a genuinely quiet day), 2 on a bad argument.
Prints paths and counts only, never transcript content: these files quote live
records.
"""

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

PROJECTS = Path.home() / ".claude" / "projects"


def local_day(ts):
    """The LOCAL calendar day of an ISO timestamp, or None if unreadable.

    Local, not UTC: the sweep's day is Kevin's day. In British Summer Time a
    line at 23:30 local is 22:30Z on the same date, but one at 00:30 local is
    23:30Z on the date BEFORE — reading the Z date would file it a day early.
    """
    if not isinstance(ts, str) or not ts:
        return None
    try:
        t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return t.astimezone().date()


def day_line_count(path, want):
    """How many lines in this transcript are dated `want` (a date)."""
    n = 0
    try:
        with open(path, "r", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line or line[0] != "{":
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(rec, dict):
                    continue
                if local_day(rec.get("timestamp")) == want:
                    n += 1
    except OSError:
        return 0
    return n


def transcripts_for_day(want, dirs):
    """[{path, lines, mtimeDay}] for every transcript holding a `want` line.

    `mtimeDay` is reported so the gap that caused this script is visible: a
    row where it differs from the target day is one the old mtime selection
    got wrong, in one direction or the other.
    """
    out = []
    for d in dirs:
        d = Path(d)
        if not d.is_dir():
            continue
        for p in sorted(d.rglob("*.jsonl")):
            n = day_line_count(p, want)
            if n:
                try:
                    md = datetime.fromtimestamp(p.stat().st_mtime).date().isoformat()
                except OSError:
                    md = None
                out.append({"path": str(p), "lines": n, "mtimeDay": md})
    out.sort(key=lambda r: (-r["lines"], r["path"]))
    return out


def selftest():
    """Proves the two gaps, without touching anything real."""
    import tempfile

    fails = []
    want = date(2026, 9, 23)
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)

        def write(name, days, mtime_day=None):
            p = d / name
            p.write_text("".join(
                json.dumps({"type": "x", "timestamp": "%sT12:00:00.000Z" % day}) + "\n"
                for day in days))
            if mtime_day:
                t = datetime.fromisoformat(mtime_day + "T12:00:00").timestamp()
                os.utime(p, (t, t))
            return p

        # THE FIRST GAP: touched on the target day, but its content is older.
        write("stale.jsonl", ["2026-09-15", "2026-09-22"], mtime_day="2026-09-24")
        # THE SECOND GAP: holds the target day, but was resumed the day after,
        # so mtime put it outside the window.
        write("resumed.jsonl", ["2026-09-23", "2026-09-24"], mtime_day="2026-09-24")
        # An ordinary match, and a file of the target day only.
        write("ontheday.jsonl", ["2026-09-23", "2026-09-23", "2026-09-23"],
              mtime_day="2026-09-23")
        # Junk lines must be skipped, not crash the scan.
        (d / "junk.jsonl").write_text("not json\n{\"timestamp\": \"nonsense\"}\n[]\n\n")

        got = {Path(r["path"]).name: r["lines"] for r in transcripts_for_day(want, [d])}
        if "stale.jsonl" in got:
            fails.append("a file whose CONTENT predates the day was selected")
        if got.get("resumed.jsonl") != 1:
            fails.append("a session resumed the next day was missed (mtime gap): %r" % got)
        if got.get("ontheday.jsonl") != 3:
            fails.append("line counts are wrong: %r" % got)
        if "junk.jsonl" in got:
            fails.append("unparseable lines were counted")
        if len(got) != 2:
            fails.append("expected exactly 2 transcripts, got %r" % got)
        # A day nothing touched is empty, not everything.
        if transcripts_for_day(date(2026, 1, 1), [d]):
            fails.append("a day with no lines returned matches")
        # A directory that is not there is survivable, not fatal.
        if transcripts_for_day(want, [d / "nope"]):
            fails.append("a missing directory returned matches")

    print("SELFTEST FAILED:\n  " + "\n  ".join(fails) if fails
          else "selftest ok: content timestamps decide, mtime does not")
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("day", nargs="?", default=None,
                    help="YYYY-MM-DD, or 'selftest'. Default: yesterday, local.")
    ap.add_argument("--dir", action="append", default=[],
                    help="transcript directory (repeatable)")
    ap.add_argument("--min-lines", type=int, default=1,
                    help="ignore a transcript with fewer than this many lines on the day")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if a.day == "selftest":
        return selftest()

    if a.day:
        try:
            want = date.fromisoformat(a.day)
        except ValueError:
            print("REFUSED: %r is not YYYY-MM-DD" % a.day, file=sys.stderr)
            return 2
    else:
        want = date.today() - timedelta(days=1)

    dirs = a.dir or [PROJECTS]
    rows = [r for r in transcripts_for_day(want, dirs) if r["lines"] >= a.min_lines]
    if a.json:
        print(json.dumps({"day": want.isoformat(), "transcripts": rows,
                          "count": len(rows)}, indent=2))
    else:
        print("%s: %d transcript(s) hold lines from that day" % (want.isoformat(), len(rows)))
        for r in rows:
            flag = "" if r["mtimeDay"] == want.isoformat() else \
                   "   (mtime says %s — mtime selection would have got this wrong)" % r["mtimeDay"]
            print("  %5d lines  %s%s" % (r["lines"], r["path"], flag))
    return 0 if rows else 1


if __name__ == "__main__":
    sys.exit(main())
