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
import time
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


# ── The LOCAL MOUNT half (added 27 Aug 2026) ────────────────────────────────
#
# This check reported HEALTHY every morning from 24 to 27 Aug 2026 while the
# brain was dead. It was not wrong about what it measured; it was measuring the
# wrong Drive. It asks the Google Drive API whether a folder reads back, and the
# API was fine. Every job that matters reads the LOCAL CloudStorage mount, and
# that mount was refusing to open a file from a launchd context with
# `[Errno 11] Resource deadlock avoided`.
#
# The cost: feed-brain, compound-brain and publish-brain deferred and gave up
# every night for four nights, knowledge-os-sort likewise, and the one check
# built to notice said HEALTHY throughout. Kevin found out by asking.
#
# The probe is IMPORTED from job-queue.py rather than reimplemented, because a
# second copy is how the health check and the thing it is meant to protect drift
# into disagreeing — and disagreeing silently is exactly this failure again.
VAULT = os.path.expanduser(
    '~/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/My Drive/00 AI Context')


def _drive_ready():
    """(ok, reason) for the local vault, using job-queue's own probe."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        'jq', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'job-queue.py'))
    jq = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(jq)
    return jq.drive_ready(VAULT)


# ── ONE FAILED READ IS NOT A VERDICT (29 Aug 2026) ──────────────────────────
#
# The probe opened one file once and turned the first
# `[Errno 11] Resource deadlock avoided` into a whole-day verdict. On 29 Aug at
# 06:50 it returned BROKEN; at 07:12 the SAME path read 200 bytes with no error.
# Google Drive File Stream is a FUSE mount that finishes waking some minutes
# after login, and EDEADLK is what it returns while it is STILL WAKING — "not
# ready yet", not "broken". Treating the first one as final cost compound-brain
# and feed-brain the whole of 28 Aug: held BLOCKED from 06:50 and marked MISSED
# at 11:06, an hour AFTER the mount had cleared at 10:06.
#
# So a BROKEN verdict now costs up to ~10 minutes of patience before it alarms.
#
# THE OPPOSITE MISTAKE IS THE WORSE ONE, and finding 397 filed it the same day:
# from 28 Aug 11:06Z to 29 Aug 09:30Z the mount was continuously unreadable and
# a single spot-check that happened to succeed must NEVER downgrade that to a
# flap. Patience is therefore bounded, and run() records how long the mount has
# been unreadable ACROSS runs, so a 22-hour outage cannot wear the face of a
# cold start.
VAULT_PROBE_ATTEMPTS = int(os.environ.get('DRIVE_VAULT_PROBE_ATTEMPTS', '5'))
VAULT_PROBE_GAP_SECONDS = float(os.environ.get('DRIVE_VAULT_PROBE_GAP', '150'))


def _sleep(seconds):
    """Named so a test can replace it; time.sleep cannot be stubbed in place."""
    time.sleep(seconds)


def check_vault():
    """Judge the local mount. Returns (verdict, reason, attempts).

    A probe that itself blows up is UNKNOWN, never HEALTHY: an unreadable
    control must not read as a pass. A probe that fails once and then succeeds
    is HEALTHY, and says so — a mount that was merely slow to wake is not an
    outage, and calling it one loses the brain jobs a day.
    """
    attempts = max(1, VAULT_PROBE_ATTEMPTS)
    why = 'the probe never ran'
    for attempt in range(1, attempts + 1):
        try:
            ok, why = _drive_ready()
        except Exception as e:                               # noqa: BLE001
            return (UNKNOWN,
                    f'could not probe the local vault ({type(e).__name__}: {e})',
                    attempt)
        if ok:
            if attempt == 1:
                return HEALTHY, 'local vault readable', attempt
            return (HEALTHY,
                    f'local vault readable, but only on attempt {attempt} of '
                    f'{attempts} — the mount was still waking, not broken',
                    attempt)
        if attempt < attempts:
            _sleep(VAULT_PROBE_GAP_SECONDS)
    waited = round(VAULT_PROBE_GAP_SECONDS * (attempts - 1) / 60)
    return BROKEN, (
        f'the local Drive mount is NOT readable after {attempts} attempts over '
        f'~{waited} minutes ({why}). Every job that reads the '
        f'brain vault will defer and give up: feed-brain, compound-brain, '
        f'publish-brain, knowledge-os-sort. The Drive API can be fine while this '
        f'is broken, and on 24-27 Aug 2026 it was.'), attempts


def fetch():
    req = urllib.request.Request(TEST_URL, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, resp.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:                                   # timeout, DNS, TLS
        return None, f'{type(e).__name__}: {e}'


def _iso_now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def _hours_since(stamp):
    """Hours between an ISO-Z stamp and now. A stamp we cannot parse reads as 0,
    never as a huge number: an unreadable clock must not invent an outage."""
    try:
        t = time.strptime(stamp, '%Y-%m-%dT%H:%M:%SZ')
    except (TypeError, ValueError):
        return 0.0
    import calendar
    return max(0.0, (time.time() - calendar.timegm(t)) / 3600.0)


def run():
    status_code, body = fetch()
    api_verdict, api_reason = classify(status_code, body)
    vault_verdict, vault_reason, vault_attempts = check_vault()

    state = load_state()
    gate_streak = state.get('consecutive_gate', 0)

    # HOW LONG, not just whether (finding 397, 29 Aug 2026). A single verdict
    # cannot tell a cold-start flap from a 22-hour outage, and on 28-29 Aug the
    # two were confused in both directions on the same day. The first run that
    # sees an unreadable mount stamps the clock; every later run reports the
    # elapsed hours until a HEALTHY read clears it.
    broken_since = state.get('vault_broken_since')
    if vault_verdict == HEALTHY:
        broken_since = None
        vault_broken_hours = 0.0
    else:
        broken_since = broken_since or _iso_now()
        vault_broken_hours = _hours_since(broken_since)
        if vault_broken_hours >= 2:
            vault_reason += (
                f' The mount has now been unreadable for {vault_broken_hours:.1f} '
                f'hours (since {broken_since}). This is an OUTAGE, not a cold start.')
    state['vault_broken_since'] = broken_since

    # WORST OF THE TWO WINS, and the reason NAMES the half that failed.
    # A score graded all-or-nothing across several things, with no record of
    # which one missed, cannot be acted on — the same lesson as the recon
    # accuracy card. So the verdict is the worse of the two and the reason
    # always says whether it was the API or the mount.
    RANK = {HEALTHY: 0, GATE: 1, UNKNOWN: 2, BROKEN: 3}
    if RANK[vault_verdict] > RANK[api_verdict]:
        verdict, reason = vault_verdict, 'local mount: ' + vault_reason
    else:
        verdict, reason = api_verdict, 'Drive API: ' + api_reason
        if vault_verdict != HEALTHY:
            reason += f' | local mount: {vault_reason}'

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
        'api_verdict': api_verdict,
        'vault_verdict': vault_verdict,
        'vault_reason': vault_reason,
        'vault_attempts': vault_attempts,
        'vault_broken_hours': round(vault_broken_hours, 2),
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
