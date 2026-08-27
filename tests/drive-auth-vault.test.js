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
function verdictFor({ api, vaultOk, vaultRaises = false }) {
  const py = `
import importlib.util, io, json, sys, contextlib
spec = importlib.util.spec_from_file_location('dac', ${JSON.stringify(CHECK)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

m.fetch = lambda: (200, '{}')
m.classify = lambda sc, b: (${JSON.stringify(api)}, 'stubbed api')
${vaultRaises
  ? "def _boom(): raise OSError(11, 'Resource deadlock avoided')\nm._drive_ready = _boom"
  : `m._drive_ready = lambda: (${vaultOk ? 'True' : 'False'}, 'cannot read founder-profile.md: [Errno 11] Resource deadlock avoided')`}
m.load_state = lambda: {}
m.save_state = lambda s: None

buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = m.run()
out = json.loads(buf.getvalue())
out['exit'] = code
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
