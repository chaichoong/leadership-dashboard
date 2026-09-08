#!/usr/bin/env python3
"""Start a command fully detached from whoever called this, then exit at once.

WHY (8 Sep 2026): the Robot sign-in app started the pickup run with
AppleScript's `do shell script "... > /dev/null 2>&1 &"`. That form is the
documented way to background a job, and it still hung the app for the whole
run. `do shell script` reads the shell's output until every copy of its pipe
is closed, and the shell it spawns carries the pipe on TWO extra descriptors
(6 and 8, seen with lsof) that a `> /dev/null 2>&1` redirect never touches.
Every process under the background job inherited them, so the app's "next
site" step waited on a headless Claude run that takes many minutes. Kevin
signed in to the first site, and nothing happened.

This launcher fixes that at the process level, where it belongs: the child
gets /dev/null for its three standard streams, every other inherited
descriptor closed (subprocess's default close_fds), and its own session so a
signal aimed at the caller never reaches it. The caller can return the moment
this script exits, which is immediately.

Usage:  detach.py [--cwd DIR] -- <command> [args...]
        detach.py selftest
"""
import os
import subprocess
import sys


def detach(cmd, cwd=None):
    """Start cmd detached. Returns the child's pid."""
    proc = subprocess.Popen(
        cmd,
        cwd=cwd or None,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        start_new_session=True,
    )
    return proc.pid


def selftest():
    """The child must NOT hold a descriptor the caller inherited.

    Recreates the bug in miniature: hand this script a spare pipe end the way
    `do shell script` handed the shell its fds 6 and 8, start a child that
    lives longer than the caller, and prove the pipe closes as soon as the
    launcher exits rather than when the child does.
    """
    import select
    r, w = os.pipe()
    child = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "--", "sleep", "3"],
        pass_fds=(w,),
        stdout=subprocess.PIPE,
    )
    os.close(w)
    child.wait()
    ready, _, _ = select.select([r], [], [], 2.0)
    if not ready:
        os.close(r)
        return "FAIL: the detached child still holds the caller's pipe (a caller waiting on it would hang)"
    data = os.read(r, 1)
    os.close(r)
    if data:
        return "FAIL: unexpected data on the inherited pipe"
    pid = int(child.stdout.read().decode().strip() or 0)
    if pid <= 0:
        return "FAIL: no child pid printed"
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return "FAIL: the detached child was not running after the launcher exited"
    return "selftest OK: the launcher exits at once and the child holds no inherited descriptor"


def main(argv):
    if len(argv) >= 2 and argv[1] == "selftest":
        msg = selftest()
        print(msg)
        return 0 if msg.startswith("selftest OK") else 1
    cwd = None
    args = argv[1:]
    if args and args[0] == "--cwd":
        if len(args) < 2:
            sys.exit("usage: detach.py [--cwd DIR] -- <command> [args...]")
        cwd = args[1]
        args = args[2:]
    if not args or args[0] != "--" or len(args) < 2:
        sys.exit("usage: detach.py [--cwd DIR] -- <command> [args...]")
    print(detach(args[1:], cwd))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
