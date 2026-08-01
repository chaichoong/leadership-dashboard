#!/usr/bin/env python3
"""UC check notifier — decides which UC verification tasks Mica must be DM'd about.

Background
----------
The dashboard (js/arrears.js) creates one Airtable task per Universal Credit
tenancy, 7 days before the rent is due, named:

    UC verification: {tenant}, £{rent} due {date}

The original scheduled routine searched for the string "UC Payment Verification",
which only ever appears in the task DESCRIPTION, never in the name. It therefore
matched nothing and sent zero DMs between 12 Apr 2026 and 1 Aug 2026 while 20+
real tasks came and went. This script replaces that guesswork with a
deterministic query, and refuses to report "nothing to do" when the name pattern
has drifted (see CONTROL below).

Usage
-----
    python3 scripts/uc-check-notify.py due
        Prints JSON: every open UC task whose call is due, with the exact Slack
        message to send. Exits 2 if the control check fails.

    python3 scripts/uc-check-notify.py mark recXXXX [recYYYY ...]
        Records those tasks as notified so they are never sent twice.

CONTROL
-------
A filterByFormula with a drifted field or name pattern returns zero rows and
reads as a clean "nothing due" forever — that is exactly how the old routine
failed silently for months. So before reporting an empty result, this script
counts UC verification tasks of ANY status. If that count is zero the naming
convention has changed and the script FAILS loudly rather than passing quietly.
"""

import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

BASE_ID = 'appnqjDpqDniH3IRl'
TASKS_TABLE = 'tblqB8b22hKBL4PF1'
PAT_FILE = os.path.expanduser('~/.config/od/airtable_pat')
NOTIFIED_FILE = os.path.expanduser(
    '~/.claude/scheduled-tasks/uc-check-slack-notifier/notified.json'
)

# js/arrears.js builds every task name with this prefix.
NAME_PREFIX = 'UC verification'
# js/config.js UC_CONTACT.phone — keep in step with it.
UC_PHONE = '0800 328 5644'
# Anything this far past its due date is stale; the rent date has been and gone.
MAX_OVERDUE_DAYS = 30

DONE_STATUSES = {'Completed'}


def read_pat():
    with open(PAT_FILE) as f:
        return f.read().strip()


def airtable_get(pat, params):
    url = f'https://api.airtable.com/v0/{BASE_ID}/{TASKS_TABLE}?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {pat}'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def fetch_all(pat, formula, fields):
    """Page through every matching record. Airtable caps a page at 100."""
    records = []
    offset = None
    while True:
        params = [('filterByFormula', formula), ('pageSize', '100')]
        params += [('fields[]', f) for f in fields]
        if offset:
            params.append(('offset', offset))
        data = airtable_get(pat, params)
        records.extend(data.get('records', []))
        offset = data.get('offset')
        if not offset:
            return records


def load_notified():
    try:
        with open(NOTIFIED_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_notified(ids):
    os.makedirs(os.path.dirname(NOTIFIED_FILE), exist_ok=True)
    with open(NOTIFIED_FILE, 'w') as f:
        json.dump(ids, f)


def fmt_uk(d):
    return f'{d.day} {d.strftime("%B %Y")}'


# "UC verification: Mark Peters, £836.52 due 6 August 2026"
NAME_RE = re.compile(r'^UC verification:\s*(?P<tenant>.+?),\s*£(?P<rent>[\d,.]+)\s+due\s+(?P<rent_due>.+?)\s*$')


def parse_name(name):
    """Pull tenant, rent and rent-due date back out of the task name.

    Returns (tenant, rent, rent_due_date_or_None). Falls back to the raw name
    rather than dropping a task if js/arrears.js ever changes its format.
    """
    m = NAME_RE.match(name)
    if not m:
        return name, None, None
    rent_due = None
    try:
        rent_due = datetime.strptime(m.group('rent_due'), '%d %B %Y').date()
    except ValueError:
        pass
    return m.group('tenant'), m.group('rent'), rent_due


def build_message(due_tasks, today):
    """One DM per run, listing everything due. Never one ping per task."""
    lines = [
        f'🔔 *Universal Credit checks due ({len(due_tasks)})*',
        '',
        'Please ring Universal Credit for each of these and confirm the rent is '
        'in place and will be paid to us as the landlord.',
        '',
    ]
    for i, t in enumerate(due_tasks, 1):
        rent = f'£{t["rent"]}' if t['rent'] else 'rent'
        rent_due = f'rent due {fmt_uk(t["rent_due_date"])}' if t['rent_due_date'] else 'rent due date unknown'
        late = (today - datetime.strptime(t['due'], '%Y-%m-%d').date()).days
        chase = 'check due today' if late <= 0 else f'check was due {late} day{"s" if late != 1 else ""} ago'
        lines.append(f'{i}. *{t["tenant"]}* — {rent}, {rent_due} ({chase})')
        lines.append(f'   https://airtable.com/{BASE_ID}/{TASKS_TABLE}/{t["id"]}')
    lines += [
        '',
        f'*UC office:* {UC_PHONE}',
        '',
        'On every call, confirm all three:',
        '1. The payment is scheduled',
        '2. It is being processed',
        '3. It is being paid to the landlord',
        '',
        'If any one is delayed, suspended or reduced, tell Kevin straight away.',
    ]
    return '\n'.join(lines)


def cmd_due():
    pat = read_pat()
    today = date.today()
    floor = today - timedelta(days=MAX_OVERDUE_DAYS)

    # CONTROL: every UC verification task, any status, any date.
    control = fetch_all(
        pat,
        f"FIND('{NAME_PREFIX}', {{Task Name}}) = 1",
        ['Task Name'],
    )
    if not control:
        print(
            f'CONTROL FAILED: no task in {TASKS_TABLE} starts with '
            f'"{NAME_PREFIX}". Either the naming convention in js/arrears.js '
            f'changed or the query is broken. Not reporting "nothing due" — '
            f'that is how this routine failed silently before.',
            file=sys.stderr,
        )
        return 2

    open_tasks = fetch_all(
        pat,
        f"AND(FIND('{NAME_PREFIX}', {{Task Name}}) = 1, {{Status}} != 'Completed')",
        ['Task Name', 'Due Date', 'Status'],
    )

    notified = set(load_notified())
    due = []
    skipped_stale = 0
    skipped_rent_passed = 0

    for rec in open_tasks:
        rid = rec['id']
        f = rec.get('fields', {})
        name = f.get('Task Name', '')
        due_raw = f.get('Due Date')
        if not due_raw or rid in notified:
            continue
        if f.get('Status') in DONE_STATUSES:
            continue
        due_date = datetime.strptime(due_raw, '%Y-%m-%d').date()
        if due_date > today:
            continue          # the call is not due yet
        if due_date < floor:
            skipped_stale += 1
            continue          # far past its window; chasing it now helps nobody
        tenant, rent, rent_due_date = parse_name(name)
        if rent_due_date and rent_due_date < today:
            # The whole point is to ring BEFORE the rent falls due. Once that
            # date has gone the pre-emptive call has no value, and pinging Mica
            # about it is noise.
            skipped_rent_passed += 1
            continue
        due.append({
            'id': rid,
            'name': name,
            'tenant': tenant,
            'rent': rent,
            'rent_due_date': rent_due_date,
            'due': due_raw,
            'status': f.get('Status'),
        })

    due.sort(key=lambda t: (t['rent_due_date'] or date.max, t['due']))

    # A tenant appearing twice means js/arrears.js created a duplicate task.
    # Surface it rather than silently deduping — it is a real data bug.
    seen = {}
    for t in due:
        seen.setdefault(t['tenant'], []).append(t['id'])
    duplicates = {k: v for k, v in seen.items() if len(v) > 1}

    out = {
        'run_date': today.isoformat(),
        'control_total': len(control),
        'open_total': len(open_tasks),
        'already_notified': len(notified),
        'skipped_stale': skipped_stale,
        'skipped_rent_passed': skipped_rent_passed,
        'duplicate_tenants': duplicates,
        'due_count': len(due),
        'due_ids': [t['id'] for t in due],
        'due': [
            {**t, 'rent_due_date': t['rent_due_date'].isoformat() if t['rent_due_date'] else None}
            for t in due
        ],
        'message': build_message(due, today) if due else None,
    }
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


def cmd_mark(ids):
    if not ids:
        print('mark needs at least one record id', file=sys.stderr)
        return 1
    notified = load_notified()
    for rid in ids:
        if rid not in notified:
            notified.append(rid)
    save_notified(notified)
    print(f'Recorded {len(ids)} notified task(s); {len(notified)} total.')
    return 0


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ('due', 'mark'):
        print(__doc__, file=sys.stderr)
        return 1
    if sys.argv[1] == 'due':
        return cmd_due()
    return cmd_mark(sys.argv[2:])


if __name__ == '__main__':
    sys.exit(main())
