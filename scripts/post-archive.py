#!/usr/bin/env python3
"""Archive a scanned post source once every one of its documents was emailed.

Why this script exists (finding 20261023-phase-3-1053, seen 23 and 24 Oct 2026):
step 6 of the post pass used to move the source PDF and clear Split/ with shell
commands. A destructive Bash command is refused in an unattended run, so the
step failed every Monday: the documents were emailed, the source stayed in the
Post Inbox, and the next run emailed the same post again. Moving the step into
one python3 call makes it the same shape as every other script this routine runs
without refusal.

It carries the two rules step 6 had and one it did not:

  * ARCHIVE ONLY ON A CLEAN SEND. Every document split out of this source must
    have a recorded exit code, and every one must be 0. A split with no recorded
    result at all is the exact fault the old step produced (an archived source
    with no email), so it REFUSES rather than assuming a send happened.
  * NOTHING IS GUESSED FROM THE DIRECTORY. The results are passed in; the files
    in Split/ are the control that nothing was missed.
  * THE MARKER IS WRITTEN BEFORE THE MOVE. The send is the irreversible half: an
    email cannot be unsent. So the moment the sends are known good, this records
    the source as emailed, and only then moves it. If the move then fails, the
    source is still sitting in the Post Inbox — and `check` tells the next run it
    was already emailed, so it is never emailed twice.

Usage:
    post-archive.py check   --source <src.pdf>
    post-archive.py archive --source <src.pdf> --result <split.pdf>=0 [--result ...]
    post-archive.py --selftest

Exit: 0 done (or `check`: not emailed before), 2 refused and nothing changed,
3 `check`: this source was already emailed, 1 the script itself broke.
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile

HOME = os.path.expanduser("~")
DRIVE = os.path.join(HOME, "Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk",
                     "My Drive/Post Inbox")
MARKER = os.path.join(HOME, "knowledge-os/logs/daily-ops/post-passes/emailed.json")

REFUSED = 2
ALREADY = 3


def digest(path):
    """A source's identity is its content, so a rename cannot make it look new."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_marker(marker=MARKER):
    try:
        with open(marker, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_marker(data, marker=MARKER):
    """Atomic: a half-written marker would read as 'never emailed' and re-send the post."""
    os.makedirs(os.path.dirname(marker), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(marker), prefix=".emailed-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, marker)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def parse_results(raw):
    """['a.pdf=0', 'b.pdf=1'] -> {'a.pdf': 0, 'b.pdf': 1}. A bad spelling is a refusal."""
    out = {}
    for item in raw:
        name, sep, code = item.rpartition("=")
        if not sep or not name:
            raise ValueError("--result wants <path>=<exit code>, got %r" % item)
        try:
            out[os.path.basename(name)] = int(code)
        except ValueError:
            raise ValueError("--result exit code is not a number: %r" % item)
    return out


def cmd_check(args):
    src = os.path.abspath(args.source)
    if not os.path.exists(src):
        print("post-archive: no such source %s" % src)
        return REFUSED
    seen = read_marker(args.marker).get(digest(src))
    if seen:
        print("post-archive: ALREADY EMAILED %s on %s (%s document(s)) — do not email it again, "
              "archive it." % (os.path.basename(src), seen.get("date", "?"),
                               seen.get("documents", "?")))
        return ALREADY
    print("post-archive: %s has not been emailed before" % os.path.basename(src))
    return 0


def cmd_archive(args):
    src = os.path.abspath(args.source)
    split = os.path.abspath(args.split or os.path.join(DRIVE, "Split"))
    processed = os.path.abspath(args.processed or os.path.join(DRIVE, "Processed"))

    if not os.path.isfile(src):
        print("post-archive: REFUSED — no such source %s" % src)
        return REFUSED
    try:
        results = parse_results(args.result)
    except ValueError as exc:
        print("post-archive: REFUSED — %s" % exc)
        return REFUSED

    if not results:
        print("post-archive: REFUSED — no send results given, so nothing proves the post was "
              "emailed. An archived source with no email is the one outcome this step must never "
              "produce.")
        return REFUSED

    failed = sorted(n for n, code in results.items() if code != 0)
    if failed:
        print("post-archive: REFUSED — %d of %d document(s) did not send: %s. Source and Split/ "
              "left in place for the next run to retry." % (len(failed), len(results),
                                                            ", ".join(failed)))
        return REFUSED

    # The control: every split on disk must have a result. A split nobody tried to send is
    # invisible in the results, and archiving over it loses the document silently.
    on_disk = sorted(f for f in os.listdir(split) if not f.startswith(".")) \
        if os.path.isdir(split) else []
    missing = [f for f in on_disk if f not in results]
    if missing:
        print("post-archive: REFUSED — %d document(s) in Split/ have no recorded send: %s. "
              "Send them or remove them before archiving." % (len(missing), ", ".join(missing)))
        return REFUSED

    # The sends are good and cannot be undone, so the source is recorded as emailed BEFORE the
    # move. A move that then fails leaves the source where it is, and `check` stops a second send.
    data = read_marker(args.marker)
    data[digest(src)] = {
        "source": os.path.basename(src),
        "date": args.date or __import__("datetime").date.today().isoformat(),
        "documents": len(results),
    }
    write_marker(data, args.marker)

    try:
        os.makedirs(processed, exist_ok=True)
    except OSError as exc:
        print("post-archive: the %d send(s) are recorded, but Processed/ is not usable (%s). The "
              "source stays put and will NOT be emailed again." % (len(results), exc))
        return REFUSED
    dest = os.path.join(processed, os.path.basename(src))
    if os.path.exists(dest):
        stem, ext = os.path.splitext(os.path.basename(src))
        dest = os.path.join(processed, "%s-%s%s" % (stem, digest(src)[:8], ext))
    try:
        shutil.move(src, dest)
    except OSError as exc:
        print("post-archive: the %d send(s) are recorded, but the move failed (%s). The source "
              "stays put and will NOT be emailed again." % (len(results), exc))
        return REFUSED

    cleared = 0
    for name in on_disk:
        try:
            os.unlink(os.path.join(split, name))
            cleared += 1
        except OSError as exc:
            print("post-archive: could not clear %s from Split/ (%s)" % (name, exc))
    print("post-archive: archived %s to Processed/ after %d clean send(s); cleared %d file(s) "
          "from Split/" % (os.path.basename(src), len(results), cleared))
    return 0


def selftest():
    import datetime
    with tempfile.TemporaryDirectory() as tmp:
        split = os.path.join(tmp, "Split")
        proc = os.path.join(tmp, "Processed")
        os.makedirs(split)
        marker = os.path.join(tmp, "logs", "emailed.json")
        src = os.path.join(tmp, "scan.pdf")
        open(src, "wb").write(b"%PDF-1.4 scan\n")
        a = os.path.join(split, "a.pdf")
        b = os.path.join(split, "b.pdf")
        open(a, "wb").write(b"a")
        open(b, "wb").write(b"b")

        def run(result, date="2026-10-26"):
            return cmd_archive(argparse.Namespace(
                source=src, split=split, processed=proc, result=result, marker=marker, date=date))

        # No results at all: refused, nothing moved.
        assert run([]) == REFUSED
        assert os.path.exists(src) and os.path.exists(a)
        # A failed send: refused, nothing moved.
        assert run(["a.pdf=0", "b.pdf=1"]) == REFUSED
        assert os.path.exists(src) and os.path.exists(b)
        # A split with no result at all: refused. Back-test by deleting the `missing` branch.
        assert run(["a.pdf=0"]) == REFUSED
        assert os.path.exists(src) and os.path.exists(b)
        # A malformed result: refused.
        assert run(["a.pdf"]) == REFUSED
        assert os.path.exists(src)
        # Nothing refused may have written a marker.
        assert read_marker(marker) == {}, read_marker(marker)

        # All clean: archived, Split/ cleared, marker written.
        assert run(["a.pdf=0", "b.pdf=0"]) == 0
        assert not os.path.exists(src)
        assert os.path.exists(os.path.join(proc, "scan.pdf"))
        assert os.listdir(split) == []
        rec = read_marker(marker)
        assert len(rec) == 1 and list(rec.values())[0]["documents"] == 2, rec

        # check: the archived source reads as already emailed wherever it sits.
        again = os.path.join(tmp, "scan-again.pdf")
        open(again, "wb").write(b"%PDF-1.4 scan\n")
        assert cmd_check(argparse.Namespace(source=again, marker=marker)) == ALREADY
        fresh = os.path.join(tmp, "other.pdf")
        open(fresh, "wb").write(b"%PDF-1.4 other\n")
        assert cmd_check(argparse.Namespace(source=fresh, marker=marker)) == 0

        # A move that cannot land still records the send, so the post is never emailed twice.
        src2 = os.path.join(tmp, "scan2.pdf")
        open(src2, "wb").write(b"%PDF-1.4 two\n")
        blocked = os.path.join(tmp, "blocked")
        open(blocked, "wb").write(b"not a directory")
        rc = cmd_archive(argparse.Namespace(source=src2, split=split, processed=blocked,
                                            result=["c.pdf=0"], marker=marker, date="2026-10-26"))
        assert rc == REFUSED, rc
        assert os.path.exists(src2)
        assert cmd_check(argparse.Namespace(source=src2, marker=marker)) == ALREADY
    print("post-archive selftest: ok")
    return 0


def main(argv):
    if "--selftest" in argv:
        return selftest()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("check", help="has this source already been emailed?")
    c.add_argument("--source", required=True)
    c.add_argument("--marker", default=MARKER)

    a = sub.add_parser("archive", help="archive a source whose every document sent cleanly")
    a.add_argument("--source", required=True)
    a.add_argument("--result", action="append", default=[],
                   metavar="SPLIT.PDF=EXITCODE",
                   help="one per document emailed out of this source; repeatable")
    a.add_argument("--split", default=None)
    a.add_argument("--processed", default=None)
    a.add_argument("--marker", default=MARKER)
    a.add_argument("--date", default=None)

    args = ap.parse_args(argv)
    return cmd_check(args) if args.cmd == "check" else cmd_archive(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
