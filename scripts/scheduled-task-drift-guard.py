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

Exit 0 when in sync, when there is no live directory (another machine, CI), or
when the check itself cannot run. Exit 1, naming the routine and the command,
when there is drift.
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
SYNC = os.path.join(HERE, "sync-scheduled-tasks.py")


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
