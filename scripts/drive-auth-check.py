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
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brain_vault  # noqa: E402  the one sync-twin rule, shared with the brain readers

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
    'Origin': 'https://app.operationsdirector.co.uk',
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
# So a BROKEN verdict now costs up to ~30 minutes of patience before it alarms.
#
# 30 AUG 2026, finding 20260830-exceptions-412 — WHY IT IS 30 AND NOT 10.
# The 5x150s window (~10 minutes) was a guess, and it was too short four
# mornings running: 27, 28, 29 and 30 Aug all alarmed BROKEN with
# alert_kevin=true, and on 30 Aug the SAME file read 200 bytes in 0.0s at
# 07:15 — the mount healed between 07:00 and 07:15, minutes after the probe
# had given up at 07:00. ceo-agent proved it from the other side the same
# morning: it hit the identical EDEADLK at 06:45, kept retrying under its
# 45-minute allowance, and acquired cleanly at 07:07:29. The job with the
# longer patience got through; the monitor with the shorter one declared an
# outage. An alert that fires every morning on a mount that self-heals is one
# Kevin learns to ignore, and the next real outage rides in behind it.
#
# So the window is now measured against the observed recovery (~25 minutes
# from the 06:50 start) rather than guessed: 13 attempts x 150s spans 30
# minutes. It costs NOTHING on a healthy morning — the probe returns on the
# first successful read — and it is still BOUNDED, which is the half that
# finding 397 exists to protect. A mount still dead after 30 minutes is a real
# outage and still alarms on the same single daily run, so widening the window
# introduces no blind spot: no verdict was muted and no alert was deferred to
# tomorrow.
#
# THE OPPOSITE MISTAKE IS THE WORSE ONE, and finding 397 filed it the same day:
# from 28 Aug 11:06Z to 29 Aug 09:30Z the mount was continuously unreadable and
# a single spot-check that happened to succeed must NEVER downgrade that to a
# flap. Patience is therefore bounded, and run() records how long the mount has
# been unreadable ACROSS runs, so a 22-hour outage cannot wear the face of a
# cold start.
VAULT_PROBE_ATTEMPTS = int(os.environ.get('DRIVE_VAULT_PROBE_ATTEMPTS', '13'))
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


# ── The FRESHNESS half (added 28 Sep 2026) ──────────────────────────────────
#
# A readable mount is not a current one. On 27 Sep 2026 the estate moved to the
# Mac mini, and Migration Assistant copied Google Drive's macOS File Provider
# records from the Air. Drive noticed on first start ("Cello database inode
# mismatch ... Recreating WorkingSet database") and carried on. From then on,
# edits to files the Mac already knew arrived, but NEW files never appeared:
# episodes 2072 and 2073 showed 1 of 10 files each in Finder while Drive's own
# database held all 10. Listing worked, downloads worked, and the vault half
# above said HEALTHY, because every one of those reads a file that already
# existed. Kevin found it the next morning, trying to review the videos.
#
# So this half lists the newest files on the Marketing shared drive (where the
# Content Engine uploads finished episodes, and where watch.py scans raw clips
# THROUGH the mount) and checks each one exists under the local mount. Files
# younger than FRESH_GRACE_MINUTES are skipped, so a normal sync delay is not an
# alarm. Google-native files (Docs, Sheets, shortcuts) are skipped, because the
# mount shows them under a different name. The fix for a stale mount is to
# disconnect and reconnect the account in Drive's settings; a Drive restart did
# not clear it on 28 Sep.
#
# CONTROL: a listing that cannot be fetched, or comes back empty, is UNKNOWN,
# never HEALTHY. Nothing to compare proves nothing.
SHARED_MOUNT = os.path.expanduser(
    '~/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/Shared drives/Marketing')
FRESH_SAMPLE = 25
FRESH_GRACE_MINUTES = 60
GOOGLE_NATIVE = 'application/vnd.google-apps'


def _drive_api():
    """The Content Engine's service-account client, imported so there is one copy."""
    import importlib.util
    spec = importlib.util.spec_from_file_location('drive_api', os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'content-engine', 'drive_api.py'))
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    return api


def newest_on_google(api=None, now=None):
    """Paths, relative to the shared drive root, of the newest non-native files
    uploaded before the grace window. Each file's path is built by walking its parents.

    createdTime, never modifiedTime: an uploaded camera clip keeps the camera's
    own date as modifiedTime (a clip shot on 6 Sep and uploaded on 11 Sep reads
    as modified on the 6th), so ordering on it pushes fresh raw uploads out of
    the sample, and a clip uploaded minutes ago with an old date would skip the
    grace window and alarm before Drive had time to pull it."""
    api = api or _drive_api()
    now = time.time() if now is None else now
    cutoff = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(now - FRESH_GRACE_MINUTES * 60))
    root = api.drive_id()
    files = api.request('GET', api.API + '/files?' + urllib.parse.urlencode({
        'q': f"trashed = false and createdTime < '{cutoff}' "
             f"and not mimeType contains '{GOOGLE_NATIVE}'",
        'corpora': 'drive', 'driveId': root, 'includeItemsFromAllDrives': 'true',
        'supportsAllDrives': 'true', 'orderBy': 'createdTime desc',
        'pageSize': FRESH_SAMPLE, 'fields': 'files(id,name,parents)'})).get('files', [])
    folders = {}                                  # folder id -> (name, parent id), fetched once

    def folder(fid):
        if fid not in folders:
            r = api.request('GET', api.API + '/files/' + fid + '?' + urllib.parse.urlencode(
                {'supportsAllDrives': 'true', 'fields': 'name,parents'}))
            folders[fid] = (r['name'], (r.get('parents') or [None])[0])
        return folders[fid]

    out = []
    for f in files:
        parts, parent = [f['name']], (f.get('parents') or [None])[0]
        for _ in range(30):
            if parent in (None, root):
                break
            name, parent = folder(parent)
            parts.append(name)
        if any('/' in p for p in parts):
            continue                              # the mount shows "/" as ":"; not worth a false alarm
        out.append('/'.join(reversed(parts)))
    return out


def check_fresh():
    """Judge whether the local mount is CURRENT. Returns (verdict, reason)."""
    try:
        paths = newest_on_google()
    except Exception as e:                                   # noqa: BLE001
        return UNKNOWN, (f'could not list the newest files on Google '
                         f'({type(e).__name__}: {str(e)[:160]}), so freshness is unproved')
    if not paths:
        return UNKNOWN, 'Google returned no files to compare, so freshness is unproved'
    # Only "no such file" means missing. Any other error (the EDEADLK a waking
    # mount returns, a permission refusal) says the mount could not answer, and
    # calling that "stale" would prescribe the wrong fix.
    missing, errors = [], []
    for p in paths:
        try:
            os.stat(os.path.join(SHARED_MOUNT, p))
        except FileNotFoundError:
            missing.append(p)
        except OSError as e:
            errors.append(f'{p} ({type(e).__name__}: {e})')
    if errors and not missing:
        return UNKNOWN, f'the mount could not answer for {errors[0]}, so freshness is unproved'
    if missing:
        return BROKEN, (
            f'{len(missing)} of the {len(paths)} newest files on Google are missing from '
            f"this Mac's Drive folder (first: {missing[0]}). The mount reads but is stale: "
            f'new uploads are not arriving, so new episodes cannot be opened and the '
            f'Content Engine cannot see new raw clips. Fix: disconnect and reconnect '
            f"kevin@runpreneur.org.uk in Google Drive's settings.")
    return HEALTHY, f"the {len(paths)} newest files on Google are all in this Mac's Drive folder"


# ── The TWINS half (added 29 Sep 2026) ──────────────────────────────────────
#
# After the host move, Google Drive rebuilt its local database on the Mac mini
# (27 Sep 12:03 UTC) and macOS renamed one of each same-name cloud pair to
# "<name> 2.md": 89 files in the live vault, found by hand on 29 Sep and moved
# to Archive/2026-09-29 sync duplicates/. Every brain reader globs the vault, so
# a twin is indexed as a note, counted as a second ruling, and handed to the
# nightly compound to merge or link. The readers now skip twins, and this half is
# the alarm if they come back: it reports the count on every run, and any twin
# fails the run and names the files.
#
# The rule itself lives once, in brain_vault.py, shared with the readers.
#
# CONTROL: a walk that could not list a folder, or saw no notes at all, is
# UNKNOWN, never HEALTHY. A count of 0 off a walk that saw nothing proves nothing.
#
# The walk lists every vault folder with Drive's download policy on, and a Drive
# that stalls after the mount probe passed would hold it for ever. So, like
# job-queue's probe, it runs on a daemon thread, and a walk that has not
# finished in TWINS_WALK_SECONDS is UNKNOWN. On 29 Sep it took under a second.
TWINS_NAMED = 10


def _walk_seconds():
    try:
        v = float(os.environ.get('DRIVE_TWINS_WALK_SECONDS', '300'))
    except ValueError:
        return 300.0
    return v if 0 < v < 3600 else 300.0    # nan, inf, zero or negative: the default


TWINS_WALK_SECONDS = _walk_seconds()


def _find_twins_timed():
    import threading
    box = {}

    def walk():
        try:
            box['result'] = brain_vault.find_twins(VAULT)
        except BaseException as e:  # handed back to the caller below, never lost
            box['error'] = e
    t = threading.Thread(target=walk, daemon=True)
    t.start()
    t.join(TWINS_WALK_SECONDS)
    if t.is_alive():
        raise TimeoutError(f'the vault walk did not finish within {TWINS_WALK_SECONDS:g} s')
    if 'error' in box:
        raise box['error']
    return box['result']


def check_twins():
    """Count Drive sync twins in the live vault. Returns (verdict, reason, twins),
    twins being None when the count is unproved."""
    try:
        twins, scanned, errors = _find_twins_timed()
    except Exception as e:                                   # noqa: BLE001
        return UNKNOWN, f'could not count sync twins ({type(e).__name__}: {e})', None
    if errors:
        return UNKNOWN, (f'could not list {len(errors)} vault folder(s) (first: {errors[0]}), '
                         f'so the sync-twin count is unproved'), None
    if not scanned:
        return UNKNOWN, 'the walk saw no notes in the vault, so a twin count of 0 proves nothing', None
    if twins:
        named = ', '.join(twins[:TWINS_NAMED])
        more = f' and {len(twins) - TWINS_NAMED} more' if len(twins) > TWINS_NAMED else ''
        return BROKEN, (
            f'{len(twins)} Google Drive sync twin(s) in the live vault: {named}{more}. '
            f'Drive has renamed copies of notes again. The brain readers skip them, but '
            f'each one must be compared with its original and moved, path kept, into '
            f'Archive/<date> sync duplicates/ with a MOVED.txt line. Never delete one. '
            f'Precedent: Archive/2026-09-29 sync duplicates/MOVED.txt.'), twins
    return HEALTHY, f'0 sync twins among {scanned} notes in the live vault (Archive/ left out)', twins


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
    # Freshness is only judged on a mount that reads: an unreadable one would
    # show every file as "missing", and the vault half already names that outage.
    if vault_verdict == HEALTHY:
        fresh_verdict, fresh_reason = check_fresh()
        twins_verdict, twins_reason, twins = check_twins()
    else:
        fresh_verdict, fresh_reason = UNKNOWN, 'not judged: the mount itself is not readable'
        twins_verdict, twins_reason, twins = UNKNOWN, 'not judged: the mount itself is not readable', None

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

    # WORST OF THE FOUR WINS, and the reason NAMES the half that failed.
    # A score graded all-or-nothing across several things, with no record of
    # which one missed, cannot be acted on — the same lesson as the recon
    # accuracy card. So the verdict is the worst of the four and the reason
    # always says whether it was the API, the mount, the mount's freshness or
    # sync twins in the vault. A tie goes to the earlier half, so the API still
    # leads when it is as bad.
    RANK = {HEALTHY: 0, GATE: 1, UNKNOWN: 2, BROKEN: 3}
    halves = [('Drive API', api_verdict, api_reason),
              ('local mount', vault_verdict, vault_reason),
              ('mount freshness', fresh_verdict, fresh_reason),
              ('sync twins', twins_verdict, twins_reason)]
    lead = max(halves, key=lambda h: RANK[h[1]])
    verdict, reason = lead[1], f'{lead[0]}: {lead[2]}'
    for half in halves:
        if half is not lead and half[1] != HEALTHY:
            reason += f' | {half[0]}: {half[2]}'

    # Counted on the API half itself, not the merged verdict: another half
    # failing on alternate days would otherwise reset the streak for ever.
    if api_verdict == GATE:
        gate_streak += 1
        if gate_streak >= MAX_CONSECUTIVE_GATE:
            # "Ignore and retry" has stopped being a retry and become a silence.
            gate_reason = (
                f'the origin gate has refused {gate_streak} runs in a row. That is no '
                f'longer a missing-header retry, it is the worker refusing this check '
                f'outright, and Drive health is now unknown.'
            )
            reason = gate_reason if verdict == GATE else f'{reason} | {gate_reason}'
            verdict = BROKEN
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
        'fresh_verdict': fresh_verdict,
        'fresh_reason': fresh_reason,
        'twins_verdict': twins_verdict,
        'twins_reason': twins_reason,
        # Reported every run; null means the count was not proved, never 0.
        'twins_count': None if twins is None else len(twins),
        'twins': twins,
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
