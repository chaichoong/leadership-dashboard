#!/usr/bin/env python3
"""Drive upload worker health check — with a control, so it cannot pass silently.

Background
----------
The Systemisation tab saves SOPs to Google Drive through the `drive-upload`
Cloudflare Worker. That breaks whenever the Google refresh token expires, and it
breaks quietly, so a daily check exists to catch it.

The check used to classify on the worker's own verdict: HEALTHY if the JSON said
`"status":"ok"` and `"auth":"valid"`. That verdict cannot be trusted. In
workers/drive-upload/worker.js the /test handler returns:

    const folderInfo = listRes.ok ? await listRes.json() : { error: ... };
    return jsonResponse({ status: 'ok', auth: 'valid', parentFolder: folderInfo });

`status: ok` and `auth: valid` are hardcoded on that path. They are emitted even
when the Drive API call FAILED — the failure is buried inside `parentFolder`.
An expired refresh token throws earlier and is caught, so that case is reported
honestly, but a revoked grant, a deleted or moved folder, a changed folder ID or
a scope problem all return a confident "ok" while Drive is unreachable.

So health is judged here on the only part of the response that cannot be faked:
whether the worker actually read the expected Drive folder back.

CONTROL
-------
Two ways this check could go silent while the thing it guards is broken:

1. The response no longer carries `parentFolder` at all (endpoint reshaped,
   different service answering, HTML error page). The old check would read that
   as "not one of my BROKEN signatures" and stay quiet. Now it is UNKNOWN, and
   UNKNOWN alerts Kevin — the check itself has gone blind.
2. The 403 origin gate. The check is meant to ignore that and retry with the
   right headers. If the worker's allow-list ever changes so the correct headers
   are ALSO refused, "ignore and retry" would swallow a real outage forever.
   Consecutive gate refusals are now counted, and the second one alerts.

Usage
-----
    python3 scripts/drive-auth-check.py            # run the live check
    python3 scripts/drive-auth-check.py selftest   # back-test the classifier
"""

import json
import os
import sys
import urllib.error
import urllib.request

TEST_URL = 'https://drive-upload.kevinbrittain.workers.dev/test'
STATE_FILE = os.path.expanduser(
    '~/.claude/scheduled-tasks/drive-auth-health-check/state.json'
)

# The worker's DRIVE_PARENT_FOLDER_ID, read back from Drive on 1 Aug 2026.
# Health means the worker fetched THIS folder, not merely that it said "ok".
EXPECTED_FOLDER_ID = '1215f_LfF0aAv0G6oPSbRTGKX6CtQoNvw'
EXPECTED_FOLDER_NAME = 'Operations Director SOPs'

# Without the Origin/Sec-Fetch trio the request never reaches the Google auth
# path; it stops at the worker's allow-listed-browser-Origin gate and 403s.
# User-Agent matters too: Cloudflare's edge blocks the default "Python-urllib"
# agent with a non-JSON 403 "error code: 1010" before the worker ever runs, which
# looks nothing like a Drive problem but would still stop the check working.
HEADERS = {
    'Origin': 'https://chaichoong.github.io',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'application/json',
}

MAX_CONSECUTIVE_GATE = 2

HEALTHY, BROKEN, GATE, UNKNOWN = 'HEALTHY', 'BROKEN', 'GATE', 'UNKNOWN'


def classify(status_code, body):
    """Judge one response. Returns (verdict, reason).

    Pure: no network, no state. `selftest` exercises every branch.
    """
    if status_code is None:
        return BROKEN, f'the request never completed: {body}'

    # Cloudflare's edge, not the worker. The request never reached our code, so
    # nothing at all is known about Drive. Never let this read as healthy.
    if 'error code: 1010' in body or 'Cloudflare' in body[:400]:
        return UNKNOWN, (
            f'Cloudflare blocked the request at the edge (HTTP {status_code}: '
            f'{body.strip()[:80]}). The worker never ran, so Drive health is unknown. '
            f'Usually means the check is sending an agent the edge rules refuse.'
        )

    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        if status_code == 403:
            return GATE, 'the origin gate refused the request (non-JSON 403)'
        return UNKNOWN, (
            f'HTTP {status_code} with a non-JSON body, so this check can no '
            f'longer tell a healthy worker from a broken one'
        )

    if not isinstance(data, dict):
        return UNKNOWN, 'the response was JSON but not an object'

    if status_code == 403 and 'origin not allowed' in str(data.get('error', '')):
        return GATE, 'the origin gate refused the request'

    if status_code >= 500 or data.get('status') == 'error':
        return BROKEN, f'the worker reported an error: {data.get("message") or data.get("error") or body[:200]}'

    # The control. Anything that is not recognisably the /test payload means the
    # check has lost the ability to judge, and must say so rather than pass.
    if 'parentFolder' not in data:
        return UNKNOWN, (
            'the response carried no parentFolder, so the /test contract has '
            'changed and this check can no longer prove Drive is reachable'
        )

    folder = data.get('parentFolder')
    if not isinstance(folder, dict) or not folder.get('id'):
        detail = (folder or {}).get('error') if isinstance(folder, dict) else folder
        return BROKEN, (
            f'the worker said "{data.get("status")}/{data.get("auth")}" but did NOT read the '
            f'Drive folder back: {str(detail)[:200]}'
        )

    if folder.get('id') != EXPECTED_FOLDER_ID:
        return BROKEN, (
            f'the worker read folder {folder.get("id")} ("{folder.get("name")}"), not the '
            f'expected {EXPECTED_FOLDER_ID} ("{EXPECTED_FOLDER_NAME}")'
        )

    return HEALTHY, f'Drive folder "{folder.get("name")}" read back successfully'


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=1)


def fetch():
    req = urllib.request.Request(TEST_URL, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, resp.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:                                   # timeout, DNS, TLS
        return None, f'{type(e).__name__}: {e}'


def run():
    status_code, body = fetch()
    verdict, reason = classify(status_code, body)

    state = load_state()
    gate_streak = state.get('consecutive_gate', 0)

    if verdict == GATE:
        gate_streak += 1
        if gate_streak >= MAX_CONSECUTIVE_GATE:
            # "Ignore and retry" has stopped being a retry and become a silence.
            verdict = BROKEN
            reason = (
                f'the origin gate has refused {gate_streak} runs in a row. That is no '
                f'longer a missing-header retry, it is the worker refusing this check '
                f'outright, and Drive health is now unknown.'
            )
    else:
        gate_streak = 0

    state['consecutive_gate'] = gate_streak
    state['last_verdict'] = verdict
    state['last_reason'] = reason
    state['last_http_status'] = status_code
    save_state(state)

    print(json.dumps({
        'verdict': verdict,
        'reason': reason,
        'http_status': status_code,
        'alert_kevin': verdict in (BROKEN, UNKNOWN),
        'consecutive_gate': gate_streak,
        'raw': body[:600],
    }, indent=2))

    return 0 if verdict == HEALTHY else 1


CASES = [
    ('genuinely healthy', 200,
     json.dumps({'status': 'ok', 'auth': 'valid',
                 'parentFolder': {'id': EXPECTED_FOLDER_ID, 'name': EXPECTED_FOLDER_NAME,
                                  'mimeType': 'application/vnd.google-apps.folder'}}),
     HEALTHY),
    # The case the old check got wrong, and the reason this script exists.
    ('worker says ok/valid but Drive call failed', 200,
     json.dumps({'status': 'ok', 'auth': 'valid',
                 'parentFolder': {'error': '{"error":{"code":404,"message":"File not found"}}'}}),
     BROKEN),
    ('folder id changed under us', 200,
     json.dumps({'status': 'ok', 'auth': 'valid',
                 'parentFolder': {'id': 'someOtherFolder', 'name': 'Someone elses folder'}}),
     BROKEN),
    ('expired refresh token', 500,
     json.dumps({'status': 'error', 'message': 'invalid_grant'}), BROKEN),
    ('origin gate 403', 403,
     json.dumps({'error': 'Forbidden: origin not allowed and no valid service token'}), GATE),
    ('endpoint reshaped, no parentFolder', 200,
     json.dumps({'status': 'ok', 'auth': 'valid'}), UNKNOWN),
    ('HTML error page instead of JSON', 200, '<html><body>502 Bad Gateway</body></html>', UNKNOWN),
    # Hit for real on 1 Aug 2026: the edge refuses Python-urllib before the
    # worker runs, so a "403" here says nothing about Drive.
    ('Cloudflare edge block', 403, 'error code: 1010\n', UNKNOWN),
    ('network failure', None, 'TimeoutError: timed out', BROKEN),
]


def selftest():
    failures = 0
    for name, code, body, expected in CASES:
        got, reason = classify(code, body)
        ok = got == expected
        if not ok:
            failures += 1
        print(f'{"PASS" if ok else "FAIL"}  {name}: expected {expected}, got {got}')
        if not ok:
            print(f'        reason was: {reason}')
    print(f'\n{len(CASES) - failures}/{len(CASES)} classifier cases pass.')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(selftest() if len(sys.argv) > 1 and sys.argv[1] == 'selftest' else run())
