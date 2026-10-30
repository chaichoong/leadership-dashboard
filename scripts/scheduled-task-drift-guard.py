#!/usr/bin/env python3
"""Refuse a commit while a live routine's SKILL.md is not mirrored in the repo.

WHY THIS EXISTS (finding 20261014-queue-fixer-868, fixed 16 Oct 2026)
---------------------------------------------------------------------
`.claude/scheduled-tasks/` holds a tracked mirror of every live
`~/.claude/scheduled-tasks/<name>/SKILL.md`, and `tests/scheduled-tasks-tracked.test.js`
fails on any drift. That test runs in the pre-push gate and in `fixer-merge.py`.

So the moment ANY session edits a live SKILL.md without running
`sync-scheduled-tasks.py --pull`, EVERY open pull request's gate goes red — on a
file that pull request never touched. The gate's JSON keeps only a 400-character
tail (finding 867), so the red does not name the file and reads as a flake.

Measured 14 Oct 2026: that cost two full gate runs (PR 763 and PR 766) and about
20 minutes. Reproduced again on 16 Oct 2026: the live `ai-team-week-check-2026-10-22`
routine was added on 15 Oct and never mirrored, so origin/main itself was red and
no branch could get round it.

The drift is cheap to fix and expensive to find. This guard moves the refusal to
the session that MADE it, where the one command that cures it is obvious, instead
of leaving it for whoever pushes next.

WHICH WAY THE DRIFT RUNS (finding 20261026-queue-fixer-1088, fixed 30 Oct 2026)
--------------------------------------------------------------------------------
`--check` only says the two copies DIFFER. It cannot say which side moved, and
until 30 Oct 2026 this guard blocked both directions the same way. Only one of
them is the incident above:

* **Live moved, the mirror is stale.** Unreviewed, and it reds every open pull
  request. Block it.
* **The mirror moved, live is stale.** That is a routine's instructions being
  improved and sent for review BEFORE they go live, which is the right order.
  Blocking it forced the only cure that existed — `--push` — which rewrites a
  running routine with a change nobody has merged yet. On 26 Oct 2026 the fixer
  could get through only by running `--pull` in the main checkout too, leaving a
  modified file in a checkout the brief said not to disturb.

So a routine whose REVIEWED copy is staged in this very commit is let through,
with the `--push` it owes after the merge printed as a reminder. THE LIMIT: if
BOTH copies were edited, the staged mirror lets the live edit through this one
commit. It is caught on the next one, because by then the mirror is committed
rather than staged and the drift reads as live-ahead again.

Exit 0 when in sync, when the only drift is a reviewed copy staged here, when
there is no live directory (another machine, CI), or when the check itself cannot
run. Exit 1, naming the routine and the command, when there is drift.
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
SYNC = os.path.join(HERE, "sync-scheduled-tasks.py")
MIRROR = (".claude", "scheduled-tasks")
FILENAME = "SKILL.md"


# sync-scheduled-tasks.py --check reports three statuses, and they do NOT all run
# the same way. Reading only DRIFTED let an UNTRACKED live routine through the
# exemption below the first time this was written, which its own test caught.
EXEMPTABLE = ("DRIFTED", "MISSING")   # the reviewed copy can be the one that moved
ALWAYS_BLOCK = ("UNTRACKED",)         # live only, never reviewed: the original incident


def reported(out):
    """(status, routine) for every line sync-scheduled-tasks.py --check reported."""
    rows = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] in EXEMPTABLE + ALWAYS_BLOCK:
            rows.append((parts[0], parts[1]))
    return rows


def staged_mirror_routines():
    """Routines whose REVIEWED copy this very commit is changing.

    None means the index could not be read, and an unknown direction blocks:
    the safe side is the behaviour this guard already had.
    """
    try:
        r = subprocess.run(["git", "diff", "--cached", "--name-only"],
                           capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    names = set()
    for line in (r.stdout or "").splitlines():
        parts = line.strip().split("/")
        if (len(parts) == 4 and (parts[0], parts[1]) == MIRROR
                and parts[3] == FILENAME):
            names.add(parts[2])
    return names


def main():
    if not os.path.isfile(SYNC):
        # A missing sibling means a broken install. Say so loudly; never block a
        # commit for it, and never pass silently, which is how the 6 Aug 2026
        # symlink bug hid for weeks.
        print("WARNING  %s not found, so routine instructions are NOT checked "
              "for drift." % SYNC, file=sys.stderr)
        return 0

    try:
        r = subprocess.run([sys.executable, SYNC, "--check"],
                           capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        print("WARNING  could not check routine instructions for drift: %s" % e,
              file=sys.stderr)
        return 0

    if r.returncode == 0:
        return 0

    out = (r.stdout or "") + (r.stderr or "")

    # Which way does it run? A routine whose reviewed copy is staged here is a
    # change going FOR review, not one dodging it.
    rows = reported(out)
    staged = staged_mirror_routines()
    if rows and staged is not None:
        exempt = [r for r in rows if r[0] in EXEMPTABLE and r[1] in staged]
        if len(exempt) == len(rows):
            for _status, name in sorted(set(exempt)):
                print("OK  %s — the reviewed copy is changing in this commit, so "
                      "the live copy is the stale one." % name, file=sys.stderr)
            print("    Run `python3 scripts/sync-scheduled-tasks.py --push` once this "
                  "has MERGED, so the live routine matches what was reviewed.",
                  file=sys.stderr)
            return 0

    print("", file=sys.stderr)
    print("BLOCKED: a scheduled routine's instructions are not under review.",
          file=sys.stderr)
    print("", file=sys.stderr)
    # Pass the script's own report through unchanged. It already names every
    # routine and both commands, and re-wording it here would let the two drift.
    for line in out.splitlines():
        if line.strip():
            print("  " + line, file=sys.stderr)
    print("", file=sys.stderr)
    print("  Left unmirrored, this turns EVERY open pull request's gate red on a "
          "file it never touched.", file=sys.stderr)
    print("  Fix it here, in this commit, rather than leaving it for whoever "
          "pushes next.", file=sys.stderr)
    print("", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
