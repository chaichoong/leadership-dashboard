#!/usr/bin/env python3
"""Keep the scheduled routines' instructions under version control.

WHY THIS EXISTS (8 Aug 2026)
----------------------------
The eighteen scheduled routines are driven entirely by `~/.claude/scheduled-tasks/
<name>/SKILL.md`. Those files decide what each routine reads, what it writes, what
it is forbidden to touch, and which Airtable tables it may change. They are the
most operationally dangerous text on this Mac, and they sat outside git: no diff,
no review, no history, no way to answer "when did this rule change and why".

Every other instruction layer in this project is reviewed. `.claude/skills/` is
tracked. CLAUDE.md is tracked. Fixes to routine behaviour were the one class of
change that shipped straight to production with nobody reading them — including
the fixes queue-fixer itself makes, which is the exact review step it exists to
provide.

WHY A COPY AND NOT A SYMLINK
----------------------------
Symlinking `~/.claude/scheduled-tasks/<name>` at the repo would be tidier and would
give one source of truth. It also stakes all eighteen routines on an unverified
assumption about whether the Claude app resolves symlinks when it enumerates
scheduled tasks. If it does not, every routine silently stops — the failure mode
this whole queue exists to prevent. So: the live directory stays real, the repo
holds a tracked mirror, and drift between them is a loud test failure rather than
something anyone has to remember.

If the symlink route is later proven safe on one throwaway task, this script and
its test can be deleted in favour of it.

WHAT IS AND IS NOT MIRRORED
---------------------------
Only `<name>/SKILL.md`. Runtime state that routines write for themselves
(`state.json`, `notified.json`) is deliberately excluded: it changes on every run,
it is not instruction, and tracking it would produce a permanently dirty tree.
"""

import argparse
import filecmp
import os
import shutil
import sys

LIVE = os.path.expanduser("~/.claude/scheduled-tasks")
REPO_REL = os.path.join(".claude", "scheduled-tasks")
FILENAME = "SKILL.md"


def repo_root():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(here)


def task_names(root):
    """Every routine that has a SKILL.md in either location."""
    names = set()
    for base in (LIVE, os.path.join(root, REPO_REL)):
        if not os.path.isdir(base):
            continue
        for name in os.listdir(base):
            if name.startswith("."):
                continue
            if os.path.isfile(os.path.join(base, name, FILENAME)):
                names.add(name)
    return sorted(names)


def compare(root):
    """Returns (only_live, only_repo, differing) — the three shapes drift takes."""
    only_live, only_repo, differing = [], [], []
    for name in task_names(root):
        live = os.path.join(LIVE, name, FILENAME)
        repo = os.path.join(root, REPO_REL, name, FILENAME)
        live_here, repo_here = os.path.isfile(live), os.path.isfile(repo)
        if live_here and not repo_here:
            only_live.append(name)
        elif repo_here and not live_here:
            only_repo.append(name)
        elif not filecmp.cmp(live, repo, shallow=False):
            differing.append(name)
    return only_live, only_repo, differing


def copy(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true",
                   help="report drift and exit 1 if there is any")
    g.add_argument("--pull", action="store_true",
                   help="live -> repo, so an edit made to a routine gets reviewed")
    g.add_argument("--push", action="store_true",
                   help="repo -> live, to restore the reviewed version")
    args = ap.parse_args()

    root = repo_root()

    if not os.path.isdir(LIVE):
        # Another machine, or CI. Nothing to compare against, and pretending
        # otherwise would fail the gate for a reason nobody can act on.
        print("No %s on this machine; nothing to sync." % LIVE)
        return 0

    only_live, only_repo, differing = compare(root)

    if args.check:
        if not (only_live or only_repo or differing):
            print("In sync: %d routine instruction files." % len(task_names(root)))
            return 0
        for name in only_live:
            print("UNTRACKED  %s — live only, never reviewed" % name)
        for name in only_repo:
            print("MISSING    %s — tracked but not installed" % name)
        for name in differing:
            print("DRIFTED    %s — live differs from the reviewed copy" % name)
        print("\nRun: python3 scripts/sync-scheduled-tasks.py --pull   (adopt the live "
              "version, then commit it so it gets reviewed)")
        print("  or: python3 scripts/sync-scheduled-tasks.py --push   (restore the "
              "reviewed version over the live one)")
        return 1

    moved = 0
    for name in task_names(root):
        live = os.path.join(LIVE, name, FILENAME)
        repo = os.path.join(root, REPO_REL, name, FILENAME)
        if args.pull and os.path.isfile(live):
            if not os.path.isfile(repo) or not filecmp.cmp(live, repo, shallow=False):
                copy(live, repo)
                print("PULLED %s" % name)
                moved += 1
        elif args.push and os.path.isfile(repo):
            if not os.path.isfile(live) or not filecmp.cmp(repo, live, shallow=False):
                copy(repo, live)
                print("PUSHED %s" % name)
                moved += 1

    print("%d file(s) synced." % moved)
    return 0


if __name__ == "__main__":
    sys.exit(main())
