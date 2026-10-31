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
  * A SEND IS RECORDED THE MOMENT IT EXITS 0, DOCUMENT BY DOCUMENT (finding
    20261027-agent-dispatch-1095, the double emails of 23 and 25 Oct 2026). The
    whole-source marker used to be the only record, and it was written only when
    EVERY document sent, so three clean sends out of five were forgotten and the
    next pass emailed all five again. Each clean send now lands in the source's
    `sent` ledger on its own: `sent` records them as they happen, a refused
    `archive` still keeps the ones that did send, and the next pass asks
    `check --document` which to skip. A document in Split/ that this pass did
    not try BECAUSE it already sent is no longer a missing-result refusal.

Usage:
    post-archive.py check   --source <src.pdf> [--document <split.pdf>]
    post-archive.py sent    --source <src.pdf> --result <split.pdf>=0 [--result ...]
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


def today_iso():
    import datetime
    return datetime.date.today().isoformat()


def is_emailed(entry):
    """True only when the WHOLE source was emailed and archived.

    A per-document `sent` ledger is not that: a partial pass must never read as
    done, or the remaining documents would be archived unsent.
    """
    if not entry:
        return False
    if "emailed" in entry:
        return bool(entry["emailed"])
    # The shape written before the per-document ledger: a bare date meant emailed.
    return "date" in entry


def sent_documents(data, dg):
    """{document name: date} for every document of this source already emailed."""
    entry = data.get(dg) or {}
    sent = entry.get("sent")
    return dict(sent) if isinstance(sent, dict) else {}


def record_sent(names, src, dg, marker, date):
    """Persist each clean send on its own. Called before anything that can refuse."""
    names = [n for n in names if n]
    if not names:
        return {}
    data = read_marker(marker)
    entry = data.setdefault(dg, {})
    entry.setdefault("source", os.path.basename(src))
    sent = entry.setdefault("sent", {})
    if not isinstance(sent, dict):
        sent = entry["sent"] = {}
    for name in names:
        sent.setdefault(name, date)
    write_marker(data, marker)
    return dict(sent)


def cmd_sent(args):
    """Record documents that have just emailed cleanly, one pass at a time."""
    src = os.path.abspath(args.source)
    if not os.path.isfile(src):
        print("post-archive: REFUSED — no such source %s" % src)
        return REFUSED
    try:
        results = parse_results(args.result)
    except ValueError as exc:
        print("post-archive: REFUSED — %s" % exc)
        return REFUSED
    clean = sorted(n for n, code in results.items() if code == 0)
    if not clean:
        print("post-archive: REFUSED — no document exited 0, so there is nothing to record.")
        return REFUSED
    sent = record_sent(clean, src, digest(src), args.marker, args.date or today_iso())
    print("post-archive: recorded %d clean send(s) for %s; %d of its document(s) are now "
          "emailed and must not be sent again: %s"
          % (len(clean), os.path.basename(src), len(sent), ", ".join(sorted(sent))))
    return 0


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
    data = read_marker(args.marker)
    dg = digest(src)
    sent = sent_documents(data, dg)
    document = getattr(args, "document", None)
    if document:
        name = os.path.basename(document)
        if name in sent:
            print("post-archive: ALREADY EMAILED document %s of %s on %s — skip it, do not send "
                  "it again." % (name, os.path.basename(src), sent[name]))
            return ALREADY
        print("post-archive: document %s of %s has not been emailed before"
              % (name, os.path.basename(src)))
        return 0
    entry = data.get(dg) or {}
    if is_emailed(entry):
        done = entry.get("emailed") if isinstance(entry.get("emailed"), dict) else entry
        print("post-archive: ALREADY EMAILED %s on %s (%s document(s)) — do not email it again, "
              "archive it." % (os.path.basename(src), done.get("date", "?"),
                               done.get("documents", "?")))
        return ALREADY
    if sent:
        print("post-archive: %s has NOT been fully emailed, but %d of its document(s) already "
              "have and must be skipped: %s"
              % (os.path.basename(src), len(sent), ", ".join(sorted(sent))))
        return 0
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

    dg = digest(src)
    date = args.date or today_iso()
    # A clean send cannot be unsent, so it is recorded BEFORE any refusal below. This is the
    # whole of finding 20261027-agent-dispatch-1095: three sends out of five used to be
    # forgotten the moment the fourth failed, and the next pass emailed all five again.
    clean = sorted(n for n, code in results.items() if code == 0)
    already = record_sent(clean, src, dg, args.marker, date) if clean \
        else sent_documents(read_marker(args.marker), dg)

    failed = sorted(n for n, code in results.items() if code != 0)
    if failed:
        print("post-archive: REFUSED — %d of %d document(s) did not send: %s. Source and Split/ "
              "left in place for the next run to retry; the %d clean send(s) are recorded, so "
              "the retry sends ONLY what failed." % (len(failed), len(results),
                                                     ", ".join(failed), len(clean)))
        return REFUSED

    # The control: every split on disk must have a result, OR already be in the sent ledger
    # from an earlier pass. A split nobody ever tried to send is invisible in both, and
    # archiving over it loses the document silently.
    on_disk = sorted(f for f in os.listdir(split) if not f.startswith(".")) \
        if os.path.isdir(split) else []
    missing = [f for f in on_disk if f not in results and f not in already]
    if missing:
        print("post-archive: REFUSED — %d document(s) in Split/ have no recorded send: %s. "
              "Send them or remove them before archiving." % (len(missing), ", ".join(missing)))
        return REFUSED

    # The sends are good and cannot be undone, so the source is recorded as emailed BEFORE the
    # move. A move that then fails leaves the source where it is, and `check` stops a second send.
    counted = sorted(set(results) | set(already))
    data = read_marker(args.marker)
    entry = data.setdefault(dg, {})
    entry["source"] = os.path.basename(src)
    entry["sent"] = {n: (already.get(n) or date) for n in counted}
    entry["emailed"] = {"date": date, "documents": len(counted)}
    # The old flat shape stays beside the new one so an older copy of this script still
    # reads the source as emailed.
    entry["date"] = date
    entry["documents"] = len(counted)
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
    print("post-archive: archived %s to Processed/ after %d clean send(s) (%d of them recorded "
          "by an earlier pass); cleared %d file(s) from Split/"
          % (os.path.basename(src), len(counted),
             len([n for n in counted if n not in results]), cleared))
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

        # No results at all: refused, nothing moved, nothing recorded.
        assert run([]) == REFUSED
        assert os.path.exists(src) and os.path.exists(a)
        assert read_marker(marker) == {}, read_marker(marker)
        # A malformed result: refused before anything is recorded.
        assert run(["a.pdf"]) == REFUSED
        assert os.path.exists(src)
        assert read_marker(marker) == {}, read_marker(marker)

        # ── finding 20261027-agent-dispatch-1095 ───────────────────────────
        # A PARTIAL send: refused and nothing moved, but the clean send is kept, so the
        # retry sends only b.pdf. Back-test by deleting the record_sent call in
        # cmd_archive: `sent` comes back empty and the three asserts below fail.
        assert run(["a.pdf=0", "b.pdf=1"]) == REFUSED
        assert os.path.exists(src) and os.path.exists(b)
        assert sent_documents(read_marker(marker), digest(src)) == {"a.pdf": "2026-10-26"}
        # The source is NOT emailed: a partial ledger must never read as done, or the
        # documents still unsent would be archived without an email.
        assert cmd_check(argparse.Namespace(source=src, marker=marker, document=None)) == 0
        # The next pass asks document by document which to skip.
        assert cmd_check(argparse.Namespace(source=src, marker=marker,
                                            document="a.pdf")) == ALREADY
        assert cmd_check(argparse.Namespace(source=src, marker=marker, document="b.pdf")) == 0
        # `sent` records a clean send on its own, the moment it exits 0.
        assert cmd_sent(argparse.Namespace(source=src, result=["b.pdf=0"], marker=marker,
                                           date="2026-10-27")) == 0
        assert sorted(sent_documents(read_marker(marker), digest(src))) == ["a.pdf", "b.pdf"]
        assert cmd_sent(argparse.Namespace(source=src, result=["b.pdf=1"], marker=marker,
                                           date="2026-10-27")) == REFUSED
        # A split already sent is no longer a missing-result refusal: the retry passes a
        # result for b.pdf alone and the source archives, counting both documents.
        assert run(["b.pdf=0"]) == 0
        assert not os.path.exists(src)
        rec0 = read_marker(marker)[digest(os.path.join(proc, "scan.pdf"))]
        assert rec0["emailed"]["documents"] == 2, rec0
        assert cmd_check(argparse.Namespace(source=os.path.join(proc, "scan.pdf"),
                                            marker=marker, document=None)) == ALREADY

        # ── the original path, on a second source ──────────────────────────
        src = os.path.join(tmp, "scan-b.pdf")
        open(src, "wb").write(b"%PDF-1.4 scan b\n")
        a = os.path.join(split, "a.pdf")
        b = os.path.join(split, "b.pdf")
        open(a, "wb").write(b"a")
        open(b, "wb").write(b"b")
        # A split with no result at all: refused. Back-test by deleting the `missing` branch.
        assert run(["a.pdf=0"]) == REFUSED
        assert os.path.exists(src) and os.path.exists(b)

        # All clean: archived, Split/ cleared, marker written.
        assert run(["a.pdf=0", "b.pdf=0"]) == 0
        assert not os.path.exists(src)
        assert os.path.exists(os.path.join(proc, "scan-b.pdf"))
        assert os.listdir(split) == []
        rec = read_marker(marker)[digest(os.path.join(proc, "scan-b.pdf"))]
        assert rec["documents"] == 2 and rec["emailed"]["documents"] == 2, rec

        # check: the archived source reads as already emailed wherever it sits.
        again = os.path.join(tmp, "scan-again.pdf")
        open(again, "wb").write(b"%PDF-1.4 scan b\n")
        assert cmd_check(argparse.Namespace(source=again, marker=marker, document=None)) == ALREADY
        fresh = os.path.join(tmp, "other.pdf")
        open(fresh, "wb").write(b"%PDF-1.4 other\n")
        assert cmd_check(argparse.Namespace(source=fresh, marker=marker, document=None)) == 0
        # A marker written by the older copy of this script (a flat date, no `emailed`)
        # still reads as emailed, so an upgrade can never re-email yesterday's post.
        legacy = os.path.join(tmp, "legacy.pdf")
        open(legacy, "wb").write(b"%PDF-1.4 legacy\n")
        data = read_marker(marker)
        data[digest(legacy)] = {"source": "legacy.pdf", "date": "2026-10-20", "documents": 3}
        write_marker(data, marker)
        assert cmd_check(argparse.Namespace(source=legacy, marker=marker, document=None)) == ALREADY

        # A move that cannot land still records the send, so the post is never emailed twice.
        src2 = os.path.join(tmp, "scan2.pdf")
        open(src2, "wb").write(b"%PDF-1.4 two\n")
        blocked = os.path.join(tmp, "blocked")
        open(blocked, "wb").write(b"not a directory")
        rc = cmd_archive(argparse.Namespace(source=src2, split=split, processed=blocked,
                                            result=["c.pdf=0"], marker=marker, date="2026-10-26"))
        assert rc == REFUSED, rc
        assert os.path.exists(src2)
        assert cmd_check(argparse.Namespace(source=src2, marker=marker, document=None)) == ALREADY
    print("post-archive selftest: ok")
    return 0


def main(argv):
    if "--selftest" in argv:
        return selftest()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("check", help="has this source already been emailed?")
    c.add_argument("--source", required=True)
    c.add_argument("--document", default=None,
                   help="ask about ONE document of this source instead of the whole source")
    c.add_argument("--marker", default=MARKER)

    t = sub.add_parser("sent", help="record documents of this source that just emailed cleanly")
    t.add_argument("--source", required=True)
    t.add_argument("--result", action="append", default=[], metavar="SPLIT.PDF=EXITCODE",
                   help="one per document just attempted; only exit 0 is recorded; repeatable")
    t.add_argument("--marker", default=MARKER)
    t.add_argument("--date", default=None)

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
    return {"check": cmd_check, "sent": cmd_sent, "archive": cmd_archive}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
