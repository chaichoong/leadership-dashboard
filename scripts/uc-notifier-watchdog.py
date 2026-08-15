#!/usr/bin/env python3
"""Watchdog for the uc-check-slack-notifier scheduled routine.

Why this exists (3 Aug 2026)
----------------------------
The routine's working folder was set to a Google Drive "Claude Cowork" path that
had since been deleted. It fired on time every morning, failed to open its
folder, and died before doing anything. No error reached anyone. That is the
second time this one routine has failed silently: the first was the free-text
name search that matched nothing from 12 Apr to 1 Aug 2026.

Both failures share a shape. The routine looked alive (it ran, it exited) while
doing no work at all. So this watchdog does not ask "did it run". It asks "is
there UC work that should have gone out and did not", which is true regardless
of HOW the routine broke — wrong folder, drifted query, app closed, permission
prompt, crash.

Since 8 Aug 2026 the UC check is phase 6.1 of the one daily-ops routine, and the
standalone uc-check-slack-notifier routine is retired. DISABLED IS NOW THE
CORRECT STATE. This watchdog used to "repair" a disabled routine back to
enabled; from 3 to 15 Aug that meant it re-armed the retired routine every
morning, and on 15 Aug the resurrected routine actually fired alongside
daily-ops — the exact second-routine overlap the one-routine design exists to
prevent (finding 20260814-daily-ops-141). The repair half is gone. VERIFY is
the whole job now:

  VERIFY — asks uc-check-notify.py what is outstanding. Anything still due
           at 09:00 means this morning's daily-ops phase 6.1 did not send it.
           True regardless of HOW it broke: phase skipped, run never fired,
           query drifted, app closed.

It also FAILS if it finds the retired routine ENABLED, because that means
something switched it back on and two routines will race tomorrow morning.

Silent when healthy. Kevin does not want a daily all-clear; the morning job
digest already proves this ran.

CONTROL
-------
A watchdog that cannot find what it is checking must fail, not pass. The check
that matters is the VERIFY: it FAILS if uc-check-notify.py cannot run, if the
task-name query has drifted, or if its own control (UC tasks existing at all)
comes back zero. The retired routine being absent from the app's task list is
NOT a fault any more — it is retired; only finding it enabled is.

Exit codes
----------
    0  healthy
    1  a problem Kevin needs to know about; details on stdout

Failure output starts with "ERROR:" and is shouted by tools/run-job.sh, which
wraps this. Do not call it directly from launchd or a failure goes unreported.
"""

import glob
import json
import os
import subprocess
import sys

REPO = '/Users/kevinbrittain/Projects/leadership-dashboard'
TASK_ID = 'uc-check-slack-notifier'
NOTIFY = os.path.join(REPO, 'scripts', 'uc-check-notify.py')
SESSIONS_GLOB = os.path.expanduser(
    '~/Library/Application Support/Claude/claude-code-sessions/'
    '*/*/scheduled-tasks.json'
)


def find_task_file():
    """Return the scheduled-tasks.json that actually holds our routine.

    Globbed rather than hardcoded: the session folder is a pair of UUIDs and a
    new one appears whenever the app rebuilds its session store. A hardcoded
    path would leave this watchdog looking at a file nobody writes any more,
    silently passing forever.
    """
    for path in sorted(glob.glob(SESSIONS_GLOB)):
        try:
            with open(path) as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        for task in data.get('scheduledTasks', []):
            if task.get('id') == TASK_ID:
                return path, data, task
    return None, None, None


def check_retired(task):
    """The standalone routine is retired; ENABLED is the fault now.

    Never writes. The old repair() silently flipped enabled back to True every
    morning — helpful when the routine was live, and a slow-motion sabotage
    once daily-ops absorbed it. A watchdog must never hold state the design has
    moved past; it reports, Kevin decides.
    """
    if task.get('enabled'):
        return ('the RETIRED standalone routine is switched ON. It will run '
                'alongside daily-ops phase 6.1 tomorrow morning — two routines, '
                'the exact overlap the one-routine design prevents. Turn it off '
                'in the Claude app, and if it comes back on again something is '
                're-enabling it.')
    return None


def check_outstanding():
    """Ask the notifier what is still due. Returns (problem_or_None, summary)."""
    try:
        proc = subprocess.run(
            [sys.executable, NOTIFY, 'due'],
            capture_output=True, text=True, timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 'could not run uc-check-notify.py (%s)' % exc, {}

    if proc.returncode == 2:
        return ('the UC task names in Airtable have drifted, so the notifier is '
                'blind: %s' % proc.stdout.strip()[:300], {})
    if proc.returncode != 0:
        return ('uc-check-notify.py failed with exit %d: %s'
                % (proc.returncode, (proc.stderr or proc.stdout).strip()[:300]), {})

    try:
        result = json.loads(proc.stdout)
    except ValueError:
        return 'uc-check-notify.py printed something that is not JSON', {}

    # Its own control. Zero UC tasks of any status means the query is blind,
    # not that the portfolio has none.
    if not result.get('control_total'):
        return 'control check failed: no UC verification tasks found at all', result

    if result.get('due_count'):
        names = ', '.join(t['tenant'] for t in result.get('due', []))
        return ('%d UC check(s) were still unsent an hour after the routine should '
                'have sent them: %s' % (result['due_count'], names), result)

    return None, result


def main():
    problems = []

    path, data, task = find_task_file()
    if task is None:
        # The retired routine vanishing from the app's task list is fine — it
        # is retired. Only its RE-APPEARANCE as enabled matters, and that is
        # checked below when it is present.
        pass
    else:
        enabled_fault = check_retired(task)
        if enabled_fault:
            problems.append(enabled_fault)

    outstanding, summary = check_outstanding()
    if outstanding:
        problems.append(outstanding)

    report = {
        'task_file': path,
        'due_count': summary.get('due_count'),
        'control_total': summary.get('control_total'),
        'already_notified': summary.get('already_notified'),
        'healthy': not problems,
    }
    print(json.dumps(report, indent=2))

    if not problems:
        return 0

    # Printed last so it survives in the 400-character tail run-job.sh sends.
    print()
    for line in problems:
        print('ERROR: UC notifier — %s' % line)
    return 1


if __name__ == '__main__':
    sys.exit(main())
