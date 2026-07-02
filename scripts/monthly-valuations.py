#!/usr/bin/env python3
"""Monthly property-valuation refresh.

Runs on the 1st of each month (GitHub Actions). For every property that already has
an Approved valuation baseline, it web-searches a fresh current market value via the
app's Claude proxy and writes a new "Pending Review" valuation to the Property
Valuations table. Both the Wealth tab and the Operations, Properties tab read the
latest APPROVED valuation, so nothing in net worth moves until Kevin approves the
new figures. Fully idempotent: a property already valued in the current month is
skipped, so re-running (or a retry) never duplicates.

No new secrets: reuses AIRTABLE_PAT (already stored for sync-transactions) and the
existing Claude proxy, which supports server-side web search when called with the
app Origin.

Env:
  AIRTABLE_PAT   Airtable personal access token (required)
  DRY_RUN=1      compute + log, write nothing
  LIMIT=N        value at most N properties (0 = all)
"""
import os, sys, json, time, re, datetime, urllib.request, urllib.error

AIRTABLE_PAT = os.environ.get('AIRTABLE_PAT', '').strip()
DRY_RUN = os.environ.get('DRY_RUN') == '1'
LIMIT = int(os.environ.get('LIMIT', '0') or '0')

BASE_ID = 'appnqjDpqDniH3IRl'
VAL_TABLE = 'tblZYsa0u1M17N7ZE'      # Property Valuations
PROP_TABLE = 'tbl6f0OkAmTC2jbuG'     # Properties
PROXY = 'https://claude-proxy.kevinbrittain.workers.dev'
# Server-side calls authenticate with the proxy's service token (set as a
# GitHub Actions secret), so the proxy injects the server-side Anthropic key.
# This replaces the old Origin/User-Agent spoofing workaround.
PROXY_SERVICE_TOKEN = os.environ.get('PROXY_SERVICE_TOKEN', '').strip()

# Property Valuations field IDs
F_TITLE = 'fldRBIx2kRFAVmH0k'
F_PROP = 'fldEEmN3R9fSsX9mr'         # link → Properties
F_VALUE = 'fldMecW8pkzlyY7Gp'
F_DATE = 'fldjuVUTvN7poUAgD'
F_SOURCE = 'fldu2CSv2DsCYDXmh'       # AI Estimate | Manual | ...
F_STATUS = 'fldQtbOpIQ2BR0yYz'       # Pending Review | Approved | ...
F_CONF = 'fldgFb0ICksUdb29u'         # High | Medium | Low
F_COMP = 'fldnldTHRVLBVrvOe'         # Comparables (notes)
PROP_ADDR = 'fldy2t735TV5e1DIL'      # Properties: full address


def _http(url, method='GET', headers=None, data=None, timeout=180):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=body)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, {'error': e.read().decode()[:500]}


def airtable_all(table, fields=None):
    """Fetch every record (paginated), keyed by field ID."""
    out, offset = [], None
    while True:
        url = f'https://api.airtable.com/v0/{BASE_ID}/{table}?pageSize=100&returnFieldsByFieldId=true'
        if fields:
            url += ''.join(f'&fields%5B%5D={f}' for f in fields)
        if offset:
            url += f'&offset={offset}'
        status, d = _http(url, headers={'Authorization': f'Bearer {AIRTABLE_PAT}'})
        if status != 200:
            raise RuntimeError(f'Airtable read {table} failed: {status} {d}')
        out += d.get('records', [])
        offset = d.get('offset')
        if not offset:
            return out
        time.sleep(0.25)


def link_id(v):
    if isinstance(v, list) and v:
        x = v[0]
        return x.get('id') if isinstance(x, dict) else x
    return None


def value_property(address, last_value, last_date):
    """Ask the proxy (Claude + web search) for a current market value. Returns
    (value:int|None, confidence:str, reasoning:str)."""
    prompt = (
        "You are valuing a UK residential property for a portfolio net-worth statement. "
        f"Address: {address}. Last recorded value: GBP {last_value:,} (as of {last_date}). "
        "Use web search to find recent sold prices, current listings and local house-price "
        "trends for this address or very close comparables, then give your best estimate of "
        "its CURRENT open-market value. Be realistic and conservative; do not inflate. "
        "Respond with EXACTLY three lines and nothing else:\n"
        "VALUE: <whole number in GBP, no commas, no currency symbol>\n"
        "CONFIDENCE: <High|Medium|Low>\n"
        "REASONING: <one sentence naming the main comparable or index you used>"
    )
    body = {
        'model': 'claude-sonnet-4-6',
        'max_tokens': 1024,
        'tools': [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': 5}],
        'messages': [{'role': 'user', 'content': prompt}],
    }
    status, d = _http(PROXY, method='POST', data=body, headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {PROXY_SERVICE_TOKEN}',
    })
    if status != 200:
        return None, 'Low', f'proxy error {status}'
    text = ''
    for block in d.get('content', []):
        if isinstance(block, dict) and block.get('type') == 'text':
            text += block.get('text', '')
    mval = re.search(r'VALUE:\s*£?\s*([\d,]+)', text, re.I)
    mconf = re.search(r'CONFIDENCE:\s*(High|Medium|Low)', text, re.I)
    mreason = re.search(r'REASONING:\s*(.+)', text, re.I)
    if not mval:
        return None, 'Low', (text[:200] or 'no VALUE line returned')
    value = int(mval.group(1).replace(',', ''))
    conf = mconf.group(1).capitalize() if mconf else 'Medium'
    reason = mreason.group(1).strip() if mreason else ''
    return value, conf, reason


def main():
    if not AIRTABLE_PAT:
        print('AIRTABLE_PAT not set', file=sys.stderr)
        sys.exit(1)
    now = datetime.date.today()
    month_label = now.strftime('%b %Y')   # e.g. "Aug 2026"
    month_key = now.strftime('%Y-%m')
    iso_today = now.strftime('%Y-%m-%d')
    print(f'Monthly valuations for {month_label} (dry_run={DRY_RUN}, limit={LIMIT or "all"})')

    vals = airtable_all(VAL_TABLE, fields=[F_PROP, F_VALUE, F_DATE, F_SOURCE, F_STATUS, F_TITLE])
    props = airtable_all(PROP_TABLE, fields=[PROP_ADDR])
    addr_by_id = {r['id']: r['fields'].get(PROP_ADDR, '') for r in props}

    # Latest Approved valuation per property, and which properties already have a
    # valuation dated in the current month (so a re-run never duplicates).
    latest, valued_this_month = {}, set()
    for r in vals:
        f = r['fields']
        pid = link_id(f.get(F_PROP))
        if not pid:
            continue  # skip valuations with no property link (e.g. 17 Newington, manual)
        d = f.get(F_DATE, '')
        if d.startswith(month_key):
            valued_this_month.add(pid)
        if f.get(F_STATUS) != 'Approved':
            continue
        cur = latest.get(pid)
        if not cur or d > cur['date']:
            title = f.get(F_TITLE, '')
            short = title.split('·')[0].strip() if '·' in title else title.strip()
            latest[pid] = {'date': d, 'value': int(f.get(F_VALUE) or 0), 'short': short}

    targets = [pid for pid in latest if pid not in valued_this_month and addr_by_id.get(pid)]
    if LIMIT:
        targets = targets[:LIMIT]
    print(f'{len(latest)} properties with an Approved baseline; '
          f'{len(valued_this_month)} already valued this month; {len(targets)} to value now.')

    created, skipped = 0, 0
    for pid in targets:
        base = latest[pid]
        address = addr_by_id[pid]
        value, conf, reason = value_property(address, base['value'], base['date'])
        if not value or value <= 0:
            print(f'  SKIP {address}: no usable value ({reason[:80]})')
            skipped += 1
            continue
        # Guard against wild swings: still record, but force Low confidence so it
        # stands out for review. Kevin approves everything, so nothing lands blind.
        ratio = value / base['value'] if base['value'] else 1
        if ratio > 3 or ratio < 0.33:
            conf = 'Low'
            reason = f'LARGE SWING vs last £{base["value"]:,} — check. ' + reason
        rec = {'fields': {
            F_TITLE: f'{base["short"]} · {month_label}',
            F_PROP: [pid],
            F_VALUE: value,
            F_DATE: iso_today,
            F_SOURCE: 'AI Estimate',
            F_STATUS: 'Pending Review',
            F_CONF: conf,
            F_COMP: reason[:1000],
        }}
        arrow = '=' if value == base['value'] else ('up' if value > base['value'] else 'down')
        print(f'  {address}: £{base["value"]:,} -> £{value:,} ({arrow}, {conf})')
        if DRY_RUN:
            created += 1
            continue
        status, d = _http(
            f'https://api.airtable.com/v0/{BASE_ID}/{VAL_TABLE}',
            method='POST', headers={'Authorization': f'Bearer {AIRTABLE_PAT}', 'Content-Type': 'application/json'},
            data={'records': [rec], 'typecast': True})
        if status != 200:
            print(f'    write failed: {status} {d}', file=sys.stderr)
            skipped += 1
        else:
            created += 1
        time.sleep(0.4)  # stay under Airtable's rate limit

    print(f'Done. {created} pending valuations {"(dry run)" if DRY_RUN else "created"}, {skipped} skipped.')


if __name__ == '__main__':
    main()
