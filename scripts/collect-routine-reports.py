#!/usr/bin/env python3
"""Bring the read-only routines' reports into the worktree so they get committed.

WHY THIS EXISTS (8 Aug 2026)
----------------------------
Since 6 Aug the scheduled routines are read-only with respect to code: they write
their report under `monitoring/` and stop. `queue-fixer` is the single writer and
commits everything in one PR.

Except queue-fixer works in a fresh git worktree (STEP 3 of its SKILL.md), and the
routines run in the MAIN checkout. `git add -A` inside a worktree cannot see a file
sitting in another working tree, so every report written after the routines went
read-only was simply never committed. The last e2e sweep in git history is
2026-08-06; task-sweep-2026-08-08.md sat untracked in the main checkout with nothing
that would ever pick it up. Nothing errored. The daily audit trail just stopped, and
the routines each reported success because writing the file WAS their whole job.

WHAT IT DOES
------------
Run it from the worktree before `git add`. It asks the MAIN checkout which files
under `monitoring/` are untracked-but-not-ignored or modified, and copies exactly
those across.

WHY IT ASKS GIT RATHER THAN LISTING THE DIRECTORY
-------------------------------------------------
`monitoring/.gitignore` exists because this repo is PUBLIC and the sweep working
files carry inbound email bodies, tenant names, rent figures and phone numbers.
`git ls-files --others --exclude-standard` returns untracked files the ignore rules
would NOT exclude, so an ignored working file can never be swept in by accident. A
plain `os.listdir()` copy would have shipped tenant data to a public repo the first
time it ran. The copy is re-checked against `git check-ignore` on the way in, so the
guard holds even if the two checkouts disagree about the ignore rules.

AND WHY THAT WAS NOT ENOUGH (12 Aug 2026 — finding 20260812-daily-ops-115)
--------------------------------------------------------------------------
The ignore rules only decide WHICH files travel. They say nothing about what is
INSIDE the ones that are meant to travel. `monitoring/task-sweep-2026-08-11.md`
is a report we want committed, and it carried a tenant's mobile number twice,
because an INBOUND SMS task is titled with the sender's number. It is public
now. The same number turned up again on 12 Aug and was masked by hand, which is
not a control — it lasts exactly as long as somebody is watching a 07:00
unattended job.

So every collected file is scrubbed on the way in (scripts/report_scrub.py) and
the scrubber's own selftest runs FIRST: a broken or deleted pattern stops the
collection instead of quietly reporting a clean sweep.
"""

import argparse
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from report_scrub import scrub, selftest as scrub_selftest  # noqa: E402

REPORT_DIR = "monitoring"

# Only text reports are scrubbed and, by the ignore rules, only text reports
# should ever be collected. A binary or unknown type arriving here is not
# something to guess at, so it is refused rather than copied unread.
SCRUBBABLE = (".md", ".txt", ".json")


def run(args, cwd):
    """Run git and return stdout lines. Raises on failure so a broken repo is loud."""
    out = subprocess.run(
        args, cwd=cwd, capture_output=True, text=True, check=True
    ).stdout
    return [line for line in out.splitlines() if line.strip()]


def repo_root(path):
    return run(["git", "rev-parse", "--show-toplevel"], cwd=path)[0]


def main_checkout(path):
    """The main working tree is the parent of the shared .git directory.

    From inside a worktree, --git-common-dir points at the main checkout's .git;
    from the main checkout it points at its own. Comparing the two is how we tell
    whether there is anything to collect at all.
    """
    common = run(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=path
    )[0]
    return os.path.dirname(common.rstrip(os.sep))


def pending_reports(checkout):
    """Report files in `checkout` that git would commit: untracked-not-ignored, or modified.

    --exclude-standard is the whole safety story here. Without it this returns the
    task-sweep worklist JSONs, which carry tenant names and rent figures.
    """
    untracked = run(
        ["git", "ls-files", "--others", "--exclude-standard", "--", REPORT_DIR],
        cwd=checkout,
    )
    modified = run(["git", "diff", "--name-only", "--", REPORT_DIR], cwd=checkout)
    return sorted(set(untracked) | set(modified))


def is_ignored(path, cwd):
    """check-ignore exits 0 when the path IS ignored, 1 when it is not."""
    return (
        subprocess.run(
            ["git", "check-ignore", "-q", "--", path],
            cwd=cwd,
            capture_output=True,
        ).returncode
        == 0
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--check",
        action="store_true",
        help="list what would be collected and copy nothing",
    )
    args = ap.parse_args()

    # The control on the control. A scrubber whose patterns stopped matching
    # reports "0 items masked" for ever and reads exactly like a clean day.
    problems = scrub_selftest()
    if problems:
        print("ERROR: report_scrub selftest FAILED — refusing to collect "
              "anything into a public repo:", file=sys.stderr)
        for p in problems:
            print("  %s" % p, file=sys.stderr)
        return 1

    here = repo_root(os.getcwd())
    source = main_checkout(here)

    if os.path.realpath(source) == os.path.realpath(here):
        print("Running in the main checkout; reports are already here. Nothing to collect.")
        return 0

    files = pending_reports(source)
    if not files:
        print("No uncommitted reports in %s/%s" % (source, REPORT_DIR))
        return 0

    for rel in files:
        # Defence in depth: never step outside monitoring/, never take an ignored file.
        if not rel.startswith(REPORT_DIR + "/"):
            print("SKIP (outside %s): %s" % (REPORT_DIR, rel))
            continue
        if is_ignored(rel, here):
            print("SKIP (ignored in this worktree): %s" % rel)
            continue

        src = os.path.join(source, rel)
        dst = os.path.join(here, rel)
        if not os.path.isfile(src):
            print("SKIP (deleted since listing): %s" % rel)
            continue

        if os.path.splitext(rel)[1].lower() not in SCRUBBABLE:
            print("SKIP (not a text report, cannot be scrubbed): %s" % rel)
            continue

        with open(src, encoding="utf-8") as fh:
            original = fh.read()
        cleaned, hits = scrub(original)

        if args.check:
            print("WOULD COLLECT %s%s"
                  % (rel, _hit_summary(hits)))
            continue

        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "w", encoding="utf-8") as fh:
            fh.write(cleaned)
        shutil.copystat(src, dst)
        print("COLLECTED %s%s" % (rel, _hit_summary(hits)))

    return 0


def _hit_summary(hits):
    if not hits:
        return ""
    kinds = {}
    for kind, _ in hits:
        kinds[kind] = kinds.get(kind, 0) + 1
    # The masked VALUES are deliberately not printed: this output goes into the
    # daily-ops report, which is itself committed.
    return "  [masked %s]" % ", ".join(
        "%d %s" % (n, k) for k, n in sorted(kinds.items())
    )


if __name__ == "__main__":
    sys.exit(main())
