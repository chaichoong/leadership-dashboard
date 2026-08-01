#!/usr/bin/env python3
"""Create the UC verification tasks on a schedule, not only when a browser is open.

Background
----------
`syncUCRecurringTasks` in js/arrears.js creates one task per Universal Credit
tenancy, 7 days before the rent falls due. It runs inside `loadDashboard`, so it
only fires when somebody actually opens the dashboard. That is usually often
enough, but it means the 7-day clock depends on a human opening a browser tab. A
quiet fortnight and the task simply never exists, and a notifier with nothing to
find stays quiet — the same silent-failure shape as the two bugs before it.

This script does the same job from the daily routine, so the tasks exist whether
or not anyone logs in. The browser path is deliberately left in place: it catches
a new UC tenancy within seconds, and the two cannot duplicate each other because
they build identical names and the dedupe below is the same rule. The risk that
buys is logic drift between two implementations, so rather than compare the
implementations this script checks for drift BY ITS SYMPTOM: two open tasks for
one tenancy in one rent month. See CONTROL.

Mirrors js/arrears.js exactly:
  eligible  = tenant pay type contains "universal credit"
              AND tenancy payment status in In Payment / CFV Actioned
              AND tenancy not ended, tenant status Active
              AND Due Day of Month set
  next due  = next occurrence of that day strictly after today (clamped to month)
  task due  = next due minus 7 days
  name      = "UC verification: {tenant}, £{rent} due {D Month YYYY}"

Usage
-----
    python3 scripts/uc-task-sync.py            # create/refresh, prints JSON
    python3 scripts/uc-task-sync.py --dry-run  # decide and report, write nothing

CONTROL
-------
Three ways this could quietly do nothing while UC checks go unbooked:

1. Zero eligible tenancies. The portfolio always has UC tenancies on payment, so
   an empty candidate set means a field name, status value or pay-type label has
   drifted, not that the work is done. FAILS loudly.
2. Zero tenancies read at all. Same reasoning, caught earlier and more bluntly.
3. Duplicate open tasks for one tenancy in one rent month. That is what drift
   between this script and js/arrears.js would look like from the outside.
   Reported as a hard finding, not tidied away.
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

BASE_ID = 'appnqjDpqDniH3IRl'
TASKS_TABLE = 'tblqB8b22hKBL4PF1'
TENANCIES_TABLE = 'tblN51a88qTDB6iMH'
TENANTS_TABLE = 'tblX4elTuu01gwBYh'
UNITS_TABLE = 'tblM3mZCR5kiEdWMj'          # js/config.js TABLES.rentalUnits
PAT_FILE = os.path.expanduser('~/.config/od/airtable_pat')

# Tenancies
F_TEN_RENT = 'fldDMyfZLFMeONPq8'
F_TEN_DUE_DAY = 'fldhy2U0CQmM2oS4P'
F_TEN_PAY_STATUS = 'fldxU3dPUnbK0SCDq'
F_TEN_STATUS = 'fldgWAyha1Uij1SZP'
F_TEN_END_DATE = 'fldwHhhKAq4f1nY9e'
F_TEN_LINKED_TENANT = 'fld1i5bDoHL3B6rUf'
F_TEN_UNIT = 'fld7cjLLEHKAx49OK'
F_TEN_UNIT_REF = 'fldql2nyQlPfkPP4p'
F_TEN_PROPERTY = 'fldxfIa0W1nqCbLo2'

# Tenants
F_TENANT_NAME = 'fldxBKW7QnujSDWqA'
F_TENANT_PAY_TYPE = 'fldZbrk8Xw5Dcwxhi'

# Rental Units
F_UNIT_PROPERTY = 'fldUJNRGgzgyAwwjt'

# Tasks — must match ucCreateTask in js/arrears.js field for field.
F_TASK_NAME = 'fldgFjGBw6bTKJFCD'
F_TASK_ASSIGNEE = 'fldELMncVJYPDRJNc'
F_TASK_DESC = 'fldRGhBQViKZKtkQ6'
F_TASK_TIME_EST = 'fld10VzzbiNNgRmIi'
F_TASK_DUE = 'fld7XP8w8kbxfETV4'
F_TASK_STATUS = 'fldx4qCw17UfrKpaN'
F_TASK_PRIORITY = 'fldS21RwmwOqt71LI'
F_TASK_HARD_DEADLINE = 'fldZKzIxgyrQ8CG8a'
F_TASK_COLLABORATORS = 'fldcq3t6uAPgWSOP8'
F_TASK_TENANCIES = 'fldmne4RYJU22ICub'
F_TASK_BUSINESS = 'fldLu1Y4GzyWcDoxr'
F_TASK_TENANTS = 'fld6ZcfEogJmeQj2c'
F_TASK_UNITS = 'fldEW648YtTZ6j01n'
F_TASK_PROPERTIES = 'fldZKFvEpJ6NZeFKz'

REAL_ESTATE_BUSINESS = 'recoGcXRXCniyJsTz'
ASSIGNEE_EMAIL = 'micaa.work@gmail.com'
COLLABORATORS = [{'email': 'kevin@runpreneur.org.uk'}, {'email': 'atentaerica@gmail.com'}]
PRIORITY = 'Urgent'
NEW_STATUS = 'Upcoming'
TIME_ESTIMATE = '15 min'
HARD_DEADLINE = True

ELIGIBLE_PAY_STATUSES = {'In Payment', 'CFV Actioned'}
UC_PHONE = '0800 328 5644'
LEAD_DAYS = 7

MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
          'August', 'September', 'October', 'November', 'December']


def read_pat():
    with open(PAT_FILE) as f:
        return f.read().strip()


def api(pat, method, path, payload=None):
    url = f'https://api.airtable.com/v0/{BASE_ID}/{path}'
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': f'Bearer {pat}',
        'Content-Type': 'application/json',
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def fetch_all(pat, table, fields=None, formula=None, by_field_id=False):
    """Page through a table.

    `by_field_id` decides what the keys in `fields` are. This script reads
    tenancies/tenants/units by field ID (matching the F constants in
    js/config.js) and the Tasks table by field name. Mixing the two silently
    returns None for every read — it is in CLAUDE.md's anti-pattern list, and it
    is what the CONTROL caught on the first dry run of this script.
    """
    records, offset = [], None
    while True:
        params = [('pageSize', '100')]
        if by_field_id:
            params.append(('returnFieldsByFieldId', 'true'))
        if formula:
            params.append(('filterByFormula', formula))
        for f in (fields or []):
            params.append(('fields[]', f))
        if offset:
            params.append(('offset', offset))
        data = api(pat, 'GET', f'{table}?' + urllib.parse.urlencode(params))
        records.extend(data.get('records', []))
        offset = data.get('offset')
        if not offset:
            return records


def name_of(field_value):
    """Airtable single-selects arrive as a string or {name: ...}."""
    if isinstance(field_value, dict):
        return field_value.get('name', '')
    return field_value or ''


def first_link_id(value):
    if not isinstance(value, list) or not value:
        return ''
    v = value[0]
    return v.get('id') if isinstance(v, dict) else v


def _day_in_month(year, month, day):
    """`day` clamped to the length of that month, so 31 works in February."""
    import calendar
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def next_rent_due(due_day, today):
    """Mirror ucCalcNextDueDate: next occurrence of due_day strictly after today."""
    if not due_day or due_day < 1 or due_day > 31:
        return None
    d = _day_in_month(today.year, today.month, due_day)
    if d <= today:
        year = today.year + (1 if today.month == 12 else 0)
        month = 1 if today.month == 12 else today.month + 1
        d = _day_in_month(year, month, due_day)
    return d


def fmt_uk(d):
    return f'{d.day} {MONTHS[d.month - 1]} {d.year}'


def task_name(tenant, rent, rent_due):
    return f'UC verification: {tenant}, £{rent:.2f} due {fmt_uk(rent_due)}'


def task_description(tenant, rent, rent_due, unit, prop):
    lines = [
        'UC Payment Verification (7 days before due)', '',
        f'Tenant: {tenant}',
        f'Expected rent: £{rent:.2f}',
        f'Rent due date: {fmt_uk(rent_due)}',
    ]
    if unit:
        lines.append(f'Unit: {unit}')
    if prop:
        lines.append(f'Property: {prop}')
    lines += [
        '', f'UC Office: {UC_PHONE}', '',
        'Confirm with UC:',
        '1. The payment is scheduled',
        '2. It is being processed',
        '3. It will be paid to the landlord', '',
        'If delayed, suspended, or reduced: escalate to Kevin immediately.',
    ]
    return '\n'.join(lines)


def rent_due_from_name(name):
    import re
    m = re.search(r'\bdue\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s*$', name or '')
    if not m or m.group(2) not in MONTHS:
        return None
    return date(int(m.group(3)), MONTHS.index(m.group(2)) + 1, int(m.group(1)))


def build_candidates(pat, today, notes):
    tenancies = fetch_all(pat, TENANCIES_TABLE, by_field_id=True)
    if not tenancies:
        notes.append('CONTROL FAILED: the Tenancies table returned no rows at all.')
        return None, tenancies

    tenants = {t['id']: t for t in fetch_all(pat, TENANTS_TABLE, by_field_id=True)}
    units = {u['id']: u for u in fetch_all(pat, UNITS_TABLE, by_field_id=True)}

    candidates = []
    for ten in tenancies:
        f = ten.get('fields', {})

        tenant_id = first_link_id(f.get(F_TEN_LINKED_TENANT))
        tenant = tenants.get(tenant_id)
        if not tenant:
            continue
        pay_type = name_of(tenant['fields'].get(F_TENANT_PAY_TYPE)).lower()
        if 'universal credit' not in pay_type:
            continue

        if name_of(f.get(F_TEN_PAY_STATUS)) not in ELIGIBLE_PAY_STATUSES:
            continue

        end = f.get(F_TEN_END_DATE)
        if end and datetime.strptime(str(end)[:10], '%Y-%m-%d').date() < today:
            continue

        status = f.get(F_TEN_STATUS)
        statuses = status if isinstance(status, list) else [status]
        if not any(str(s).strip().lower() == 'active' for s in statuses if s):
            continue

        try:
            due_day = int(name_of(f.get(F_TEN_DUE_DAY)) or 0)
        except (TypeError, ValueError):
            due_day = 0
        if not due_day:
            continue

        rent_due = next_rent_due(due_day, today)
        if not rent_due:
            continue

        unit_id = first_link_id(f.get(F_TEN_UNIT))
        unit_rec = units.get(unit_id)
        prop_id = first_link_id(unit_rec['fields'].get(F_UNIT_PROPERTY)) if unit_rec else ''
        unit_ref = f.get(F_TEN_UNIT_REF)
        prop_ref = f.get(F_TEN_PROPERTY)

        candidates.append({
            'tenancy_id': ten['id'],
            'tenant_id': tenant_id,
            'unit_id': unit_id,
            'property_id': prop_id,
            'tenant_name': tenant['fields'].get(F_TENANT_NAME) or 'Unknown',
            'rent': float(f.get(F_TEN_RENT) or 0),
            'rent_due': rent_due,
            'task_due': rent_due - timedelta(days=LEAD_DAYS),
            'unit_name': unit_ref[0] if isinstance(unit_ref, list) and unit_ref else (unit_ref or ''),
            'property_name': prop_ref[0] if isinstance(prop_ref, list) and prop_ref else (prop_ref or ''),
        })

    return candidates, tenancies


def task_fields(c):
    fields = {
        F_TASK_NAME: task_name(c['tenant_name'], c['rent'], c['rent_due']),
        F_TASK_ASSIGNEE: {'email': ASSIGNEE_EMAIL},
        F_TASK_DESC: task_description(c['tenant_name'], c['rent'], c['rent_due'],
                                      c['unit_name'], c['property_name']),
        F_TASK_TIME_EST: TIME_ESTIMATE,
        F_TASK_DUE: c['task_due'].isoformat(),
        F_TASK_STATUS: NEW_STATUS,
        F_TASK_PRIORITY: PRIORITY,
        F_TASK_HARD_DEADLINE: HARD_DEADLINE,
        F_TASK_COLLABORATORS: COLLABORATORS,
        F_TASK_TENANCIES: [c['tenancy_id']],
        F_TASK_BUSINESS: [REAL_ESTATE_BUSINESS],
    }
    if c['tenant_id']:
        fields[F_TASK_TENANTS] = [c['tenant_id']]
    if c['unit_id']:
        fields[F_TASK_UNITS] = [c['unit_id']]
    if c['property_id']:
        fields[F_TASK_PROPERTIES] = [c['property_id']]
    return fields


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='decide and report, write nothing')
    args = ap.parse_args()

    pat = read_pat()
    today = date.today()
    notes, created, updated, skipped = [], [], [], 0

    candidates, tenancies = build_candidates(pat, today, notes)
    if candidates is None:
        print(json.dumps({'ok': False, 'notes': notes}, indent=2))
        return 2

    # CONTROL 1: the portfolio always has UC tenancies on payment. An empty set
    # means a field or label drifted, not that there is nothing to do.
    if not candidates:
        notes.append(
            f'CONTROL FAILED: read {len(tenancies)} tenancies but not one qualified as a '
            f'UC check. Either the pay-type label, the payment statuses '
            f'{sorted(ELIGIBLE_PAY_STATUSES)} or a field ID has changed. Refusing to '
            f'report "nothing to do".'
        )
        print(json.dumps({'ok': False, 'notes': notes}, indent=2))
        return 2

    existing = fetch_all(
        pat, TASKS_TABLE,
        fields=['Task Name', 'Status', 'Tenancies', 'Due Date'],
        formula="FIND('UC verification', {Task Name}) = 1",
    )

    def open_tasks_for(tenancy_id):
        out = []
        for t in existing:
            tf = t.get('fields', {})
            if name_of(tf.get('Status')) == 'Completed':
                continue
            links = tf.get('Tenancies') or []
            if tenancy_id in [l.get('id') if isinstance(l, dict) else l for l in links]:
                out.append(t)
        return out

    for c in candidates:
        want = task_name(c['tenant_name'], c['rent'], c['rent_due'])

        # Same rent period already covered, including one Mica has completed.
        if any((t.get('fields', {}).get('Task Name') or '') == want for t in existing):
            skipped += 1
            continue

        # An open task for this tenancy in this rent month under an out-of-date
        # name: the rent day or amount moved. Re-point it, never duplicate it.
        supersedable = None
        for t in open_tasks_for(c['tenancy_id']):
            had = rent_due_from_name(t.get('fields', {}).get('Task Name') or '')
            if had and (had.year, had.month) == (c['rent_due'].year, c['rent_due'].month):
                supersedable = t
                break

        if args.dry_run:
            (updated if supersedable else created).append(want)
            continue

        try:
            if supersedable:
                fields = task_fields(c)
                del fields[F_TASK_STATUS]      # Mica's working status is hers
                api(pat, 'PATCH', f'{TASKS_TABLE}/{supersedable["id"]}',
                    {'fields': fields, 'typecast': True})
                supersedable['fields']['Task Name'] = want
                updated.append(want)
            else:
                new = api(pat, 'POST', TASKS_TABLE,
                          {'fields': task_fields(c), 'typecast': True})
                existing.append({'id': new['id'], 'fields': {
                    'Task Name': want, 'Status': NEW_STATUS,
                    'Tenancies': [c['tenancy_id']]}})
                created.append(want)
            time.sleep(0.25)                   # stay under Airtable's rate limit
        except Exception as e:
            notes.append(f'FAILED for {c["tenant_name"]}: {e}')

    # CONTROL 3: drift between this script and js/arrears.js would show up as two
    # open tasks for one tenancy in one rent month. Report, never tidy away.
    seen, dupes = {}, {}
    for t in existing:
        tf = t.get('fields', {})
        if name_of(tf.get('Status')) == 'Completed':
            continue
        rd = rent_due_from_name(tf.get('Task Name') or '')
        tid = first_link_id(tf.get('Tenancies'))
        if not rd or not tid:
            continue
        key = f'{tid}:{rd.year}-{rd.month:02d}'
        seen.setdefault(key, []).append(t['id'])
    for key, ids in seen.items():
        if len(ids) > 1:
            dupes[key] = ids
    if dupes:
        notes.append(
            f'DUPLICATES: {len(dupes)} tenancy/month pair(s) hold more than one open UC '
            f'task. That is what drift between this script and js/arrears.js looks like.'
        )

    print(json.dumps({
        'ok': not dupes and not any(n.startswith('FAILED') for n in notes),
        'dry_run': args.dry_run,
        'run_date': today.isoformat(),
        'tenancies_read': len(tenancies),
        'uc_candidates': len(candidates),
        'created': created,
        'updated': updated,
        'already_correct': skipped,
        'duplicates': dupes,
        'notes': notes,
    }, indent=2, ensure_ascii=False))

    return 0 if not dupes else 1


if __name__ == '__main__':
    sys.exit(main())
