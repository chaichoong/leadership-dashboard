import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = resolve(ROOT, 'scripts/drive-auth-check.py');

// ─────────────────────────────────────────────────────────────────────────────
// 27 Aug 2026. drive-auth reported HEALTHY every morning from 24 to 27 Aug
// while feed-brain, compound-brain, publish-brain and knowledge-os-sort
// deferred and gave up every night. It was not wrong about what it measured —
// it asks the Google Drive API whether a folder reads back, and the API was
// fine. It never touched the LOCAL CloudStorage mount, which was refusing to
// open a file from a launchd context with [Errno 11] Resource deadlock avoided.
//
// The control that must never regress: a healthy API cannot produce a HEALTHY
// verdict while the mount is unreadable.
// ─────────────────────────────────────────────────────────────────────────────

// Drives run() with both halves stubbed, so the outcome is deterministic and
// does not depend on this machine's Drive being up or down while tests run.
// `okOnAttempt` drives the 29 Aug retry: the probe fails until that attempt,
// then reads. 0 means it never reads. Sleep is stubbed, so the ~10 minutes of
// real patience costs the suite nothing — and the stub COUNTS the sleeps, so a
// silent removal of the backoff shows up as attempts:1.
// `twinsVault` points the real twins half at a folder built for the case;
// without it the twins half is stubbed with `twins` as its verdict.
function verdictFor({ api, vaultOk, vaultRaises = false, okOnAttempt = null,
                      state = {}, fresh = 'HEALTHY', twins = 'HEALTHY', twinsVault = null }) {
  const probe = vaultRaises
    ? "def _boom(): raise OSError(11, 'Resource deadlock avoided')\nm._drive_ready = _boom"
    : okOnAttempt !== null
      ? `_n = [0]
def _probe():
    _n[0] += 1
    if ${okOnAttempt} and _n[0] >= ${okOnAttempt}:
        return True, 'readable'
    return False, 'cannot read founder-profile.md: [Errno 11] Resource deadlock avoided'
m._drive_ready = _probe`
      : `m._drive_ready = lambda: (${vaultOk ? 'True' : 'False'}, 'cannot read founder-profile.md: [Errno 11] Resource deadlock avoided')`;

  const py = `
import importlib.util, io, json, sys, contextlib
spec = importlib.util.spec_from_file_location('dac', ${JSON.stringify(CHECK)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

m.fetch = lambda: (200, '{}')
m.classify = lambda sc, b: (${JSON.stringify(api)}, 'stubbed api')
m.check_fresh = lambda: (${JSON.stringify(fresh)}, 'stubbed freshness')
${twinsVault
    ? `m.VAULT = ${JSON.stringify(twinsVault)}`
    : `m.check_twins = lambda: (${JSON.stringify(twins)}, 'stubbed twins', [])`}
${probe}
_slept = []
m._sleep = lambda s: _slept.append(s)
_saved = {}
m.load_state = lambda: json.loads(${JSON.stringify(JSON.stringify(state))})
def _save(s): _saved.update(s)
m.save_state = _save

buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = m.run()
out = json.loads(buf.getvalue())
out['exit'] = code
out['slept'] = _slept
out['saved_state'] = _saved
print(json.dumps(out))
`;
  return JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }));
}

describe('drive-auth judges the local mount, not just the API', () => {
  it('BACK-TEST: a healthy API with an unreadable mount is NOT healthy', () => {
    // Before this change the answer here was HEALTHY, four mornings running,
    // while the brain was dead. This single assertion is the whole fix.
    const r = verdictFor({ api: 'HEALTHY', vaultOk: false });
    expect(r.verdict).toBe('BROKEN');
    expect(r.alert_kevin).toBe(true);
    expect(r.exit).not.toBe(0);
  });

  it('names WHICH half failed, so the verdict can be acted on', () => {
    const r = verdictFor({ api: 'HEALTHY', vaultOk: false });
    expect(r.reason).toMatch(/local mount/i);
    expect(r.reason).toMatch(/Resource deadlock avoided/);
    expect(r.vault_verdict).toBe('BROKEN');
    expect(r.api_verdict).toBe('HEALTHY');
  });

  it('names the jobs that will die, so the consequence is not left as a guess', () => {
    const r = verdictFor({ api: 'HEALTHY', vaultOk: false });
    for (const job of ['feed-brain', 'compound-brain', 'publish-brain', 'knowledge-os-sort']) {
      expect(r.reason + r.vault_reason, job).toContain(job);
    }
  });

  it('CONTROL: both halves healthy still passes, or the test above proves nothing', () => {
    const r = verdictFor({ api: 'HEALTHY', vaultOk: true });
    expect(r.verdict).toBe('HEALTHY');
    expect(r.alert_kevin).toBe(false);
    expect(r.exit).toBe(0);
  });

  it('a broken API still wins when the mount is fine', () => {
    const r = verdictFor({ api: 'BROKEN', vaultOk: true });
    expect(r.verdict).toBe('BROKEN');
    expect(r.reason).toMatch(/Drive API/);
  });

  it('reports BOTH when the API is degraded AND the mount is down', () => {
    const r = verdictFor({ api: 'UNKNOWN', vaultOk: false });
    // The mount is the worse of the two, so it leads; the API state is not lost.
    expect(r.verdict).toBe('BROKEN');
    expect(r.api_verdict).toBe('UNKNOWN');
    expect(r.vault_verdict).toBe('BROKEN');
  });

  it('a probe that throws is UNKNOWN, never HEALTHY', () => {
    // An unreadable control must not read as a pass — the silent-zero rule.
    const r = verdictFor({ api: 'HEALTHY', vaultRaises: true });
    expect(r.vault_verdict).toBe('UNKNOWN');
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.alert_kevin).toBe(true);
  });

  it('shares job-queue\'s probe rather than reimplementing it', () => {
    // Two copies of the readiness rule is how the health check and the thing it
    // protects drift into disagreeing, silently.
    const src = readFileSync(CHECK, 'utf8');
    expect(src).toMatch(/job-queue\.py/);
    expect(src).toMatch(/jq\.drive_ready\(/);
    expect(src, 'must not carry its own copy of the probe')
      .not.toMatch(/def drive_ready\(/);
  });

  it('the existing API classifier is untouched (9 cases still pass)', () => {
    const out = execFileSync('python3', [CHECK, 'selftest'], { encoding: 'utf8' });
    expect(out).toMatch(/9\/9 classifier cases pass/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 29 Aug 2026, findings 394 and 397 — the SAME symptom filed twice, in opposite
// directions, on the same morning.
//
// 394: at 06:50 the probe said BROKEN ('[Errno 11] Resource deadlock avoided');
// at 07:12 the SAME file read 200 bytes. Google Drive File Stream is a FUSE
// mount that finishes waking minutes after login, and EDEADLK is what it says
// while it is still waking. One failed read became a whole-day verdict, and on
// 28 Aug that cost compound-brain and feed-brain the day: BLOCKED from 06:50,
// marked MISSED at 11:06, an hour AFTER the mount cleared at 10:06.
//
// 397: from 28 Aug 11:06Z to 29 Aug 09:30Z the mount was continuously
// unreadable. A spot-check that happens to succeed must never downgrade that to
// a flap. So patience is bounded AND the outage is timed across runs.
// ─────────────────────────────────────────────────────────────────────────────
describe('a cold mount is not a broken mount, and an outage is not a flap', () => {
  it('BACK-TEST: a mount that reads on the second attempt is HEALTHY, not BROKEN', () => {
    // Before this change the first EDEADLK was the verdict and this was BROKEN,
    // which is exactly what lost 28 Aug.
    const r = verdictFor({ api: 'HEALTHY', okOnAttempt: 2 });
    expect(r.vault_verdict).toBe('HEALTHY');
    expect(r.verdict).toBe('HEALTHY');
    expect(r.alert_kevin).toBe(false);
    expect(r.exit).toBe(0);
  });

  it('says it had to wait, so a slow mount is visible rather than invisible', () => {
    const r = verdictFor({ api: 'HEALTHY', okOnAttempt: 3 });
    expect(r.vault_attempts).toBe(3);
    expect(r.vault_reason).toMatch(/attempt 3 of 13/);
    expect(r.vault_reason).toMatch(/still waking/i);
  });

  it('actually backs off between attempts instead of spinning', () => {
    const r = verdictFor({ api: 'HEALTHY', okOnAttempt: 4 });
    expect(r.slept).toHaveLength(3);           // 3 gaps between 4 attempts
    for (const s of r.slept) expect(s).toBeGreaterThan(0);
  });

  it('a mount that never reads is STILL BROKEN — patience is bounded', () => {
    // The opposite mistake, and the worse one. 397 is a 22-hour outage.
    const r = verdictFor({ api: 'HEALTHY', okOnAttempt: 0 });
    expect(r.vault_verdict).toBe('BROKEN');
    expect(r.vault_attempts).toBe(13);
    expect(r.vault_reason).toMatch(/after 13 attempts/);
    expect(r.alert_kevin).toBe(true);
  });

  // 30 Aug 2026, finding 20260830-exceptions-412. The window was 5x150s
  // (~10 minutes) and alarmed BROKEN four mornings running while the mount
  // healed on its own minutes later — on 30 Aug the same file read fine at
  // 07:15 after the probe gave up at 07:00, and ceo-agent acquired cleanly at
  // 07:07:29 under its 45-minute allowance. The window must cover the OBSERVED
  // recovery, not a guess.
  it('waits out the mount\'s own recovery: the window spans at least 25 minutes', () => {
    const r = verdictFor({ api: 'HEALTHY', okOnAttempt: 0 });
    const waitedSeconds = r.slept.reduce((a, b) => a + b, 0);
    expect(waitedSeconds).toBeGreaterThanOrEqual(25 * 60);
    // BACK-TEST: the old 5x150s window totalled 600s and fails this assertion.
    expect(waitedSeconds).toBeGreaterThan(600);
  });

  it('BACK-TEST: a mount that heals at the 25-minute mark is HEALTHY, not BROKEN', () => {
    // Attempt 11 sits at 25 minutes in (10 gaps x 150s). Under the old
    // 5-attempt window the probe had already returned BROKEN and alerted.
    const r = verdictFor({ api: 'HEALTHY', okOnAttempt: 11 });
    expect(r.vault_verdict).toBe('HEALTHY');
    expect(r.alert_kevin).toBe(false);
    expect(r.exit).toBe(0);
  });

  it('patience stays BOUNDED — widening the window did not remove the ceiling', () => {
    // Finding 397's half of the contract. A 22-hour outage must not wear the
    // face of a cold start just because the probe now waits longer.
    const r = verdictFor({ api: 'HEALTHY', okOnAttempt: 0 });
    expect(r.slept.length).toBeLessThan(60);
    expect(r.vault_verdict).toBe('BROKEN');
    expect(r.alert_kevin).toBe(true);
  });

  it('times the outage across runs, so 22 hours cannot read as a cold start', () => {
    const since = new Date(Date.now() - 22 * 3600 * 1000)
      .toISOString().replace(/\.\d+Z$/, 'Z');
    const r = verdictFor({ api: 'HEALTHY', vaultOk: false,
                           state: { vault_broken_since: since } });
    expect(r.vault_broken_hours).toBeGreaterThan(21);
    expect(r.reason).toMatch(/OUTAGE, not a cold start/);
  });

  it('stamps the clock on the FIRST broken run and clears it on a good one', () => {
    const first = verdictFor({ api: 'HEALTHY', vaultOk: false });
    expect(first.saved_state.vault_broken_since).toBeTruthy();
    // Under two hours it is not yet called an outage — that is the flap window.
    expect(first.reason).not.toMatch(/OUTAGE/);

    const cleared = verdictFor({ api: 'HEALTHY', vaultOk: true,
                                 state: { vault_broken_since: '2026-08-28T11:06:00Z' } });
    expect(cleared.saved_state.vault_broken_since).toBeNull();
    expect(cleared.vault_broken_hours).toBe(0);
  });

  it('an unparseable stamp reports 0 hours, never an invented outage', () => {
    const r = verdictFor({ api: 'HEALTHY', vaultOk: false,
                           state: { vault_broken_since: 'not a date' } });
    expect(r.vault_broken_hours).toBe(0);
    expect(r.vault_verdict).toBe('BROKEN');   // still broken, just not timed
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 28 Sep 2026. The estate moved to the Mac mini on 27 Sep and Migration
// Assistant copied Google Drive's macOS records from the Air. The mount READ
// fine, downloads worked and the vault half said HEALTHY, but new uploads never
// appeared: episodes 2072 and 2073 showed 1 of 10 files each while Google held
// all 10. Kevin found it trying to review the videos.
//
// The control that must never regress: a readable mount that is missing files
// Google holds is NOT healthy.
// ─────────────────────────────────────────────────────────────────────────────

// Runs a snippet with the real module loaded. SHARED_MOUNT points at a temp
// folder built for the case, and newest_on_google is stubbed with Google's side,
// so check_fresh itself runs for real against real files.
function withModule(body) {
  const py = `
import importlib.util, json, os, tempfile
spec = importlib.util.spec_from_file_location('dac', ${JSON.stringify(CHECK)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def mount(present):
    root = tempfile.mkdtemp()
    for p in present:
        os.makedirs(os.path.join(root, os.path.dirname(p)), exist_ok=True)
        open(os.path.join(root, p), 'w').close()
    return root
${body}
`;
  return JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }));
}

const EP = 'Runpreneur/Runpreneur Edited Video/2001-2100/2072/';
const ON_GOOGLE_2072 = ['Ep2072_transcript.txt', 'Ep2072_Summary.mp4', 'Episode_2072_Thumbnail.png',
  'Ep2072_LFMD_YT.srt', 'Ep2072_LFMD_YT.mp4', 'Ep2072_LFMD.mp4', 'Episode_2072_Full_Episode_YT.srt',
  'Episode_2072_Full_Episode_YT.mp4', 'Ep2072_Podcast.mp3', 'Episode_2072_Full_Episode.mp4'].map(n => EP + n);

describe('drive-auth judges whether the mount is CURRENT, not just readable', () => {
  it('BACK-TEST: the 28 Sep shape (Google has 10, the Mac shows the thumbnail) is BROKEN', () => {
    const r = withModule(`
m.SHARED_MOUNT = mount([${JSON.stringify(EP + 'Episode_2072_Thumbnail.png')}])
m.newest_on_google = lambda: ${JSON.stringify(ON_GOOGLE_2072)}
print(json.dumps(m.check_fresh()))`);
    expect(r[0]).toBe('BROKEN');
    expect(r[1]).toMatch(/9 of the 10 newest files/);
    expect(r[1]).toMatch(/2072\/Ep2072_transcript\.txt/);
    expect(r[1]).toMatch(/disconnect and reconnect/);
  });

  it('CONTROL: every file on Google present on the Mac is HEALTHY, or the back-test proves nothing', () => {
    const r = withModule(`
m.SHARED_MOUNT = mount(${JSON.stringify(ON_GOOGLE_2072)})
m.newest_on_google = lambda: ${JSON.stringify(ON_GOOGLE_2072)}
print(json.dumps(m.check_fresh()))`);
    expect(r[0]).toBe('HEALTHY');
    expect(r[1]).toMatch(/the 10 newest files/);
  });

  it('an empty listing is UNKNOWN, never HEALTHY: nothing to compare proves nothing', () => {
    const r = withModule(`
m.SHARED_MOUNT = mount([])
m.newest_on_google = lambda: []
print(json.dumps(m.check_fresh()))`);
    expect(r[0]).toBe('UNKNOWN');
  });

  it('a listing that throws (no key, no network) is UNKNOWN, never HEALTHY', () => {
    const r = withModule(`
def _boom(): raise RuntimeError('drive GET -> 403: forbidden')
m.newest_on_google = _boom
print(json.dumps(m.check_fresh()))`);
    expect(r[0]).toBe('UNKNOWN');
    expect(r[1]).toMatch(/403/);
  });

  it('a stale mount turns a healthy API and a readable vault into BROKEN, and says why', () => {
    const r = verdictFor({ api: 'HEALTHY', vaultOk: true, fresh: 'BROKEN' });
    expect(r.verdict).toBe('BROKEN');
    expect(r.reason).toMatch(/^mount freshness:/);
    expect(r.fresh_verdict).toBe('BROKEN');
    expect(r.alert_kevin).toBe(true);
    expect(r.exit).not.toBe(0);
  });

  it('an unproved freshness still alerts, so the check cannot go quietly blind', () => {
    const r = verdictFor({ api: 'HEALTHY', vaultOk: true, fresh: 'UNKNOWN' });
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.alert_kevin).toBe(true);
  });

  it('builds each path from Google\'s parents, fetches each folder once, and asks for the right files', () => {
    // A fake client standing in for the Content Engine's drive_api: one shared
    // drive root, a two-level folder chain, and a name with "/" that the mount
    // would show as ":".
    const r = withModule(`
import urllib.parse
calls = []
class Api:
    API = 'https://x/drive/v3'
    def drive_id(self): return 'ROOT'
    def request(self, method, url):
        calls.append(url)
        if '/files?' in url:
            return {'files': [
                {'id': 'a', 'name': 'Ep2073_LFMD.mp4', 'parents': ['F2073']},
                {'id': 'b', 'name': 'Ep2073_Summary.mp4', 'parents': ['F2073']},
                {'id': 'c', 'name': 'top.txt', 'parents': ['ROOT']},
                {'id': 'd', 'name': 'a/b.mp4', 'parents': ['F2073']}]}
        fid = url.split('/files/')[1].split('?')[0]
        return {'F2073': {'name': '2073', 'parents': ['FRANGE']},
                'FRANGE': {'name': '2001-2100', 'parents': ['ROOT']}}[fid]
paths = m.newest_on_google(api=Api(), now=1790000000)
q = urllib.parse.parse_qs(calls[0].split('?', 1)[1])
print(json.dumps({'paths': paths, 'q': q['q'][0], 'order': q['orderBy'][0],
                  'size': q['pageSize'][0], 'folder_calls': len(calls) - 1}))`);
    expect(r.paths).toEqual(['2001-2100/2073/Ep2073_LFMD.mp4', '2001-2100/2073/Ep2073_Summary.mp4', 'top.txt']);
    expect(r.folder_calls).toBe(2);                      // F2073 and FRANGE, once each
    // Upload time, not the file's own date: a camera clip keeps the date it was
    // shot, so ordering on modifiedTime pushed fresh raw uploads out of the sample.
    expect(r.order).toBe('createdTime desc');
    expect(r.size).toBe('25');
    expect(r.q).toMatch(/trashed = false/);
    expect(r.q).toMatch(/not mimeType contains 'application\/vnd\.google-apps'/);
    // The grace window: 1790000000 minus 60 minutes, so a file still syncing is not an alarm.
    expect(r.q).toMatch(/createdTime < '2026-09-21T13:13:20'/);
    expect(r.q).not.toMatch(/modifiedTime/);
  });

  it('a mount that errors (not "no such file") is UNKNOWN, never a stale verdict', () => {
    // A waking mount returns EDEADLK and a refused one EPERM. Neither says the
    // file is missing, and "reconnect the account" would be the wrong fix.
    const r = withModule(`
m.SHARED_MOUNT = mount(['Runpreneur'])       # a FILE where a folder should be: stat raises NotADirectoryError
m.newest_on_google = lambda: ['Runpreneur/Runpreneur Edited Video/x.mp4']
print(json.dumps(m.check_fresh()))`);
    expect(r[0]).toBe('UNKNOWN');
    expect(r[1]).toMatch(/could not answer/);
  });

  it('freshness is not judged on an unreadable mount, so the vault outage leads', () => {
    const r = verdictFor({ api: 'HEALTHY', vaultOk: false, fresh: 'BROKEN' });
    expect(r.fresh_verdict).toBe('UNKNOWN');
    expect(r.fresh_reason).toMatch(/not judged/);
    expect(r.verdict).toBe('BROKEN');
    expect(r.reason).toMatch(/^local mount:/);
    expect(r.reason).not.toMatch(/reconnect/);
  });

  it('BACK-TEST: the origin-gate streak still escalates when another half is failing', () => {
    // Counted on the merged verdict, a freshness UNKNOWN reset the streak to 0,
    // so a gate refusing every day could never reach its second-run alarm.
    const r = verdictFor({ api: 'GATE', vaultOk: true, fresh: 'UNKNOWN',
                           state: { consecutive_gate: 1 } });
    expect(r.saved_state.consecutive_gate).toBe(2);
    expect(r.verdict).toBe('BROKEN');
    expect(r.reason).toMatch(/origin gate has refused 2 runs in a row/);
  });

  it('CONTROL: a single gate refusal with everything else healthy stays GATE, not BROKEN', () => {
    const r = verdictFor({ api: 'GATE', vaultOk: true });
    expect(r.saved_state.consecutive_gate).toBe(1);
    expect(r.verdict).toBe('GATE');
  });

  it('a file truly missing still reads as BROKEN when another path also errors', () => {
    // A stale mount that is also slow on one file must still name the reconnect fix.
    const r = withModule(`
m.SHARED_MOUNT = mount(['Runpreneur'])
m.newest_on_google = lambda: ['Runpreneur/x.mp4', 'Other/missing.mp4']
print(json.dumps(m.check_fresh()))`);
    expect(r[0]).toBe('BROKEN');
    expect(r[1]).toMatch(/1 of the 2 newest files/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 29 Sep 2026. After the host move, Google Drive rebuilt its local database on
// the Mac mini and macOS renamed one of each same-name pair to "<name> 2.md":
// 89 twins in the live brain vault, found by hand and moved to
// Archive/2026-09-29 sync duplicates/. The brain readers now skip twins; this
// half is the alarm if Drive makes them again.
//
// The control that must never regress: a twin in the live vault fails the run
// and is named, a real note whose name ends in a number is not a twin, and a
// walk that saw nothing is never a clean count.
// ─────────────────────────────────────────────────────────────────────────────
const TWIN_ROOT = mkdtempSync(join(tmpdir(), 'drive-twins-'));
afterAll(() => rmSync(TWIN_ROOT, { recursive: true, force: true }));
let twinBox = 0;
const LEGIT = 'Decisions/2026-08-24 No caps on agent work, and the triage lane runs at 9, 1 and 5.md';

function vault(files) {
  const root = join(TWIN_ROOT, String(++twinBox));
  mkdirSync(root, { recursive: true });
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), '# note\n');
  }
  return root;
}

// Everything the live vault can hold that is NOT a twin: a digit-ending note with
// no sibling, and twins that were already moved to Archive/.
const CLEAN = ['Home.md', 'Knowledge/Note.md', LEGIT,
  'Archive/2026-09-29 sync duplicates/Home 2.md',
  'Archive/2026-09-29 sync duplicates/Knowledge/Note 2.md'];

function twinsIn(root) {
  return withModule(`
m.VAULT = ${JSON.stringify(root)}
print(json.dumps(m.check_twins()))`);
}

describe('drive-auth counts Drive sync twins in the live brain vault', () => {
  it('BACK-TEST: a twin beside its original fails the run and is named', () => {
    const r = verdictFor({ api: 'HEALTHY', vaultOk: true,
                           twinsVault: vault([...CLEAN, 'Knowledge/Note 2.md']) });
    expect(r.twins_verdict).toBe('BROKEN');
    expect(r.verdict).toBe('BROKEN');
    expect(r.reason).toMatch(/^sync twins: 1 Google Drive sync twin/);
    expect(r.twins).toEqual(['Knowledge/Note 2.md']);
    expect(r.twins_count).toBe(1);
    expect(r.alert_kevin).toBe(true);
    expect(r.exit).not.toBe(0);
  });

  it('CONTROL: a clean vault passes and still reports the count, or the back-test proves nothing', () => {
    const r = verdictFor({ api: 'HEALTHY', vaultOk: true, twinsVault: vault(CLEAN) });
    expect(r.twins_verdict).toBe('HEALTHY');
    expect(r.twins_count).toBe(0);
    // Archive/ is left out, so the two archived twins are not counted as notes either.
    expect(r.twins_reason).toBe('0 sync twins among 3 notes in the live vault (Archive/ left out)');
    expect(r.verdict).toBe('HEALTHY');
    expect(r.exit).toBe(0);
  });

  it('a real note whose name ends in a number is not a twin', () => {
    const [verdict, , twins] = twinsIn(vault([LEGIT, 'Knowledge/Top 10.md']));
    expect(verdict).toBe('HEALTHY');
    expect(twins).toEqual([]);
  });

  it('twins in any folder are counted, including a twin of a twin, and the fix is named', () => {
    const [verdict, reason, twins] = twinsIn(vault([
      'Home.md', 'Home 2.md', 'Home 2 2.md', 'Decisions/Rule.md', 'Decisions/Rule 3.md']));
    expect(verdict).toBe('BROKEN');
    expect(twins).toEqual(['Decisions/Rule 3.md', 'Home 2 2.md', 'Home 2.md']);
    expect(reason).toMatch(/Never delete one/);
    expect(reason).toMatch(/Archive\/2026-09-29 sync duplicates\/MOVED\.txt/);
  });

  it('names at most ten twins in the reason but lists and counts all of them', () => {
    const files = ['Note.md'];
    for (let i = 2; i <= 14; i++) files.push(`Note ${i}.md`);
    const [verdict, reason, twins] = twinsIn(vault(files));
    expect(verdict).toBe('BROKEN');
    expect(twins).toHaveLength(13);
    expect(reason).toMatch(/^13 Google Drive sync twin/);
    expect(reason).toMatch(/and 3 more/);
  });

  it('CONTROL: a walk that saw no notes is UNKNOWN, never a clean 0', () => {
    const r = verdictFor({ api: 'HEALTHY', vaultOk: true, twinsVault: vault([]) });
    expect(r.twins_verdict).toBe('UNKNOWN');
    expect(r.twins_count).toBeNull();
    expect(r.alert_kevin).toBe(true);
  });

  it('CONTROL: a folder the walk cannot list is UNKNOWN, never a clean 0', () => {
    // os.walk drops a listing error silently unless it is handed onerror.
    const root = vault(['Home.md', 'Knowledge/Note.md']);
    chmodSync(join(root, 'Knowledge'), 0o000);
    try {
      const [verdict, reason, twins] = twinsIn(root);
      expect(verdict).toBe('UNKNOWN');
      expect(reason).toMatch(/could not list 1 vault folder/);
      expect(twins).toBeNull();
    } finally {
      chmodSync(join(root, 'Knowledge'), 0o755);
    }
  });

  it('BACK-TEST: a note ending in a year beside its namesake is not a twin', () => {
    // macOS numbers copies from 2; "Tax return 2026.md" is a note, not copy 2026.
    const [verdict, , twins] = twinsIn(vault(['Knowledge/Tax return.md', 'Knowledge/Tax return 2026.md',
      'Knowledge/Top.md', 'Knowledge/Top 100.md']));
    expect(verdict).toBe('HEALTHY');
    expect(twins).toEqual([]);
  });

  it('a duplicated FOLDER beside its original is named once, not walked', () => {
    // The readers skip twin files only, so a "Knowledge 2/" must reach a person.
    // The twin file inside it proves the folder is not walked, and "Meetings 2024/"
    // beside "Meetings/" proves a year ending is not a copy number for folders either.
    const r = withModule(`
print(json.dumps(m.brain_vault.find_twins(${JSON.stringify(vault(['Knowledge/Note.md',
      'Knowledge 2/Note.md', 'Knowledge 2/Note 2.md', 'Meetings/Call.md', 'Meetings 2024/Call.md']))})[:2]))`);
    expect(r[0]).toEqual(['Knowledge 2/']);
    expect(r[1]).toBe(3);                         // Knowledge/Note, Meetings/Call, Meetings 2024/Call
  });

  it('prunes Archive/ when the vault arrives as a Path, not a string', () => {
    const root = vault(CLEAN);
    const r = withModule(`
import pathlib
print(json.dumps(m.brain_vault.find_twins(pathlib.Path(${JSON.stringify(root)}))[:2]))`);
    expect(r).toEqual([[], 3]);
  });

  it('a walk that stalls is UNKNOWN within its time limit, never a hang or a clean 0', () => {
    const r = withModule(`
import time
m.TWINS_WALK_SECONDS = 0.2
m.brain_vault.find_twins = lambda v: time.sleep(5)
t0 = time.time()
v, reason, twins = m.check_twins()
print(json.dumps([v, reason, twins, time.time() - t0 < 3]))`);
    expect(r[0]).toBe('UNKNOWN');
    expect(r[1]).toMatch(/did not finish within 0\.2 s/);
    expect(r[2]).toBeNull();
    expect(r[3]).toBe(true);
  });

  it('a mis-set walk limit falls back to the default rather than crash or alarm every day', () => {
    for (const bad of ['abc', '0', '-5', 'nan', 'inf']) {
      const out = execFileSync('python3', ['-c', `
import importlib.util
spec = importlib.util.spec_from_file_location('dac', ${JSON.stringify(CHECK)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m.TWINS_WALK_SECONDS)`], { encoding: 'utf8',
        env: { ...process.env, DRIVE_TWINS_WALK_SECONDS: bad, PYTHONDONTWRITEBYTECODE: '1' } });
      expect(out.trim(), bad).toBe('300.0');
    }
  });

  it('twins are not judged on an unreadable mount, so the vault outage leads', () => {
    const r = verdictFor({ api: 'HEALTHY', vaultOk: false, twins: 'BROKEN' });
    expect(r.twins_verdict).toBe('UNKNOWN');
    expect(r.twins_reason).toMatch(/not judged/);
    expect(r.twins_count).toBeNull();
    expect(r.reason).toMatch(/^local mount:/);
  });
});
