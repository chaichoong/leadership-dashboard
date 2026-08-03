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

It runs at 09:00, an hour after the routine, and does two things:

  1. REPAIR  — puts the routine's working folder back if it has drifted again.
  2. VERIFY  — asks uc-check-notify.py what is outstanding. Anything still due
               at 09:00 means the 08:00 run did not send it.

Silent when healthy. Kevin does not want a daily all-clear; the 09:30 job digest
already proves this ran.

CONTROL
-------
A watchdog that cannot find what it is checking must fail, not pass. Reporting
"nothing wrong" because a path moved is the exact failure it exists to catch. So
it FAILS if it cannot find the app's task list, if the routine is not in it, or
if uc-check-notify.py's own control (UC tasks existing at all) comes back zero.

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


def repair(path, data, task):
    """Put the working folder and permission mode back. Returns what changed.

    This only rewrites the file on disk. If the Claude app is running it holds
    its own copy in memory and may write over this, which is why VERIFY below
    is the real safety net and this is only the convenience half.
    """
    fixes = []
    cwd = task.get('cwd')
    if cwd != REPO or not os.path.isdir(cwd or ''):
        task['cwd'] = REPO
        fixes.append('working folder was %r' % (cwd,))
    mode = task.get('permissionMode')
    if mode != 'bypassPermissions':
        task['permissionMode'] = 'bypassPermissions'
        task['approvedPermissions'] = [{'toolName': 'Bash'}, {'toolName': 'Read'}]
        fixes.append('permission mode was %r' % (mode,))
    if not task.get('enabled'):
        task['enabled'] = True
        fixes.append('routine was disabled')

    if fixes:
        tmp = path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    return fixes


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
        # Cannot verify the routine's config at all. Say so rather than pass.
        problems.append(
            'could not find the %s routine in the Claude app task list '
            '(looked in %s)' % (TASK_ID, SESSIONS_GLOB)
        )
        fixes = []
    else:
        fixes = repair(path, data, task)

    # A repair is itself a fault report, never a silent tidy-up. If something
    # keeps resetting this routine, quietly fixing it every morning would hide
    # the cause for months — which is precisely how the last two failures ran.
    if fixes:
        problems.append(
            'its settings had been changed again and I put them back (%s)'
            % '; '.join(fixes)
        )

    outstanding, summary = check_outstanding()
    if outstanding:
        problems.append(outstanding)

    report = {
        'task_file': path,
        'repaired': fixes,
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
    if fixes:
        print('Repaired on disk: %s. Restart the Claude app to be certain it '
              'takes effect.' % '; '.join(fixes))
    return 1


if __name__ == '__main__':
    sys.exit(main())
