import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
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
function verdictFor({ api, vaultOk, vaultRaises = false, okOnAttempt = null,
                      state = {} }) {
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
