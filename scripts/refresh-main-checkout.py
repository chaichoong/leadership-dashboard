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
  4. clear any untracked file that origin/main is about to add and whose
     contents already hash identically to the version being added (finding
     20261019-phase-4-994). Nothing can be lost: the bytes are on origin/main.
     One byte of difference and the file is left, and step 5 refuses.
  5. git reset --keep origin/main. --keep refuses rather than overwrite a
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


def duplicate_untracked(repo, ref="origin/main"):
    """Untracked files that `ref` is about to add and whose contents are ALREADY byte-identical to what it adds.

    Why (finding 20261019-phase-4-994): the fix phase copies a monitoring report into its worktree and commits it,
    and the original stays untracked here. The moment that path lands on origin/main, `reset --keep` refuses — and it
    is right to, because it cannot know the two files are the same. On 19 Oct 2026 both were sha 963457ba and this
    checkout sat 3 behind with no route out of it: a bare reset and a plain rm both want a person, and this script
    refuses by design, so the 14 Sep incident (33 behind, every guard a day old) was forming again.

    An EXACT duplicate is the one case where clearing it can lose nothing, because the bytes are already on
    origin/main. One byte of difference and the file is left alone and the refusal stands."""
    untracked = {l for l in git(repo, "ls-files", "--others", "--exclude-standard").stdout.splitlines() if l}
    adding = {l for l in git(repo, "diff", "--name-only", "--diff-filter=A", "HEAD", ref).stdout.splitlines() if l}
    same = []
    for path in sorted(untracked & adding):
        theirs = git(repo, "rev-parse", "%s:%s" % (ref, path))
        mine = git(repo, "hash-object", "--", os.path.join(repo, path))
        if theirs.returncode or mine.returncode: continue
        if theirs.stdout.strip() and theirs.stdout.strip() == mine.stdout.strip():
            same.append(path)
    return same


def duplicate_tracked(repo, ref="origin/main"):
    """TRACKED files edited here whose working-tree bytes are ALREADY exactly what `ref` holds.

    Why (finding 20261020-queue-fixer-1009): the scheduled-task drift guard makes this routine,
    not rare. A repo-side change to a routine SKILL.md needs the same mirror edit in the main
    checkout to satisfy the guard before a commit, so on 20 Oct 2026
    `.claude/scheduled-tasks/daily-ops/SKILL.md` was edited here to exactly the bytes landing on
    origin/main. `reset --keep` then refused with "Entry ... not uptodate. Cannot merge." and the
    checkout sat 3 behind; it was cleared by hand, which no scheduled run would do.

    Restoring such a file loses nothing: the bytes the edit produced are the bytes `ref` is about
    to install. One byte of difference and the file is left alone and the refusal stands.

    A path with a STAGED change is never touched, whatever its working tree holds: the index may
    hold a third version, and discarding that is a loss this routine must not take."""
    changed = {l for l in git(repo, "diff", "--name-only", "HEAD").stdout.splitlines() if l}
    staged = {l for l in git(repo, "diff", "--name-only", "--cached", "HEAD").stdout.splitlines() if l}
    same = []
    for path in sorted(changed - staged):
        theirs = git(repo, "rev-parse", "%s:%s" % (ref, path))
        mine = git(repo, "hash-object", "--", os.path.join(repo, path))
        if theirs.returncode or mine.returncode: continue
        if theirs.stdout.strip() and theirs.stdout.strip() == mine.stdout.strip():
            same.append(path)
    return same


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
        dupes = duplicate_untracked(a.repo)
        extra = (f"; {len(dupes)} untracked file(s) are byte-identical to origin/main and would be cleared: "
                 + ", ".join(dupes)) if dupes else ""
        mirrored = duplicate_tracked(a.repo)
        extra += (f"; {len(mirrored)} tracked file(s) are edited to origin/main's exact bytes and would be "
                  "restored: " + ", ".join(mirrored)) if mirrored else ""
        print(f"STALE: {branch or 'detached HEAD'} is {behind} commits behind origin/main (--check, not moved){extra}")
        return 1

    dupes = duplicate_untracked(a.repo)
    if dupes:
        for path in dupes:
            os.remove(os.path.join(a.repo, path))
        print("CLEARED %d untracked file(s) already byte-identical to origin/main: %s"
              % (len(dupes), ", ".join(dupes)))

    mirrored = duplicate_tracked(a.repo)
    if mirrored:
        c = git(a.repo, "checkout", "--", *mirrored)
        if c.returncode != 0:
            print(f"REFUSED: {behind} behind, and the mirrored edit could not be restored: "
                  f"{c.stderr.strip()[:300]}")
            return 1
        print("RESTORED %d tracked file(s) already edited to origin/main's exact bytes: %s"
              % (len(mirrored), ", ".join(mirrored)))

    r = git(a.repo, "reset", "--keep", "origin/main")
    if r.returncode != 0:
        print(f"REFUSED: {behind} behind, and git reset --keep would overwrite uncommitted "
              f"edits: {r.stderr.strip()[:300]}")
        return 1
    print(f"REFRESHED: {branch or 'detached HEAD'} moved forward {behind} commits to origin/main")
    return 0


if __name__ == "__main__":
    sys.exit(main())
