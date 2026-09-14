#!/usr/bin/env python3
"""Bring the main checkout up to origin/main before daily-ops runs its scripts.

Why (finding 20260914-daily-ops-528): daily-ops runs phases 1-3 from the main
checkout, which sits on a working branch (chore/main-checkout) because `main`
itself is held by the content-engine-runtime worktree. Nothing moved that
branch forward, so on 14 Sep 2026 it was 33 commits behind origin/main: every
guard daily-ops ran was yesterday's code, and a merged fix never reached the
routine that is meant to prove it.

What it does, in order, and it never loses work:
  1. git fetch origin
  2. if HEAD is already at or ahead of origin/main with nothing behind: CURRENT
  3. if the branch is `main`, or holds commits that are not on origin/main
     (git cherry lines starting "+"): REFUSED, nothing touched
  4. git reset --keep origin/main. --keep refuses rather than overwrite a
     modified file, so another session's uncommitted edits survive; a refusal
     is reported, never forced.

Usage:
    refresh-main-checkout.py            # refresh, or refuse and say why
    refresh-main-checkout.py --check    # report only, change nothing
    refresh-main-checkout.py --repo DIR # act on another checkout (tests)

Exit: 0 current or refreshed, 1 refused (report it; the scripts that follow
run on stale code), 2 could not tell (fetch or git failed).
"""

import argparse
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, timeout=300)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--repo", default=REPO)
    ap.add_argument("--no-fetch", action="store_true", help="tests only")
    a = ap.parse_args(argv)

    if not a.no_fetch:
        f = git(a.repo, "fetch", "origin", "--quiet")
        if f.returncode != 0:
            print(f"CANNOT TELL: git fetch failed: {f.stderr.strip()[:200]}")
            return 2

    branch = git(a.repo, "branch", "--show-current").stdout.strip()
    behind_r = git(a.repo, "rev-list", "--count", "HEAD..origin/main")
    if behind_r.returncode != 0:
        print(f"CANNOT TELL: {behind_r.stderr.strip()[:200]}")
        return 2
    behind = int(behind_r.stdout.strip() or 0)
    if behind == 0:
        print(f"CURRENT: {branch or 'detached HEAD'} is at origin/main")
        return 0

    if branch == "main":
        print(f"REFUSED: the main checkout is on `main`, {behind} behind; "
              "main belongs to the content-engine-runtime worktree")
        return 1

    unique = [l for l in git(a.repo, "cherry", "origin/main", "HEAD").stdout.splitlines()
              if l.startswith("+")]
    if unique:
        print(f"REFUSED: {branch or 'detached HEAD'} is {behind} behind origin/main but holds "
              f"{len(unique)} commit(s) not on origin/main; move them to a branch first")
        return 1

    if a.check:
        print(f"STALE: {branch or 'detached HEAD'} is {behind} commits behind origin/main (--check, not moved)")
        return 1

    r = git(a.repo, "reset", "--keep", "origin/main")
    if r.returncode != 0:
        print(f"REFUSED: {behind} behind, and git reset --keep would overwrite uncommitted "
              f"edits: {r.stderr.strip()[:300]}")
        return 1
    print(f"REFRESHED: {branch or 'detached HEAD'} moved forward {behind} commits to origin/main")
    return 0


if __name__ == "__main__":
    sys.exit(main())
