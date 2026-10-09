// merge-pr.py: one gate at a time, and a red gate names its failing tests (9 Oct 2026).
//
// That evening, gates from different sessions ran together and knocked each other's
// real-browser tests past their time limits: 12 refusals, most of them load, not code.
// And the result kept 400 characters of output, so a red gate never said WHICH test
// failed; telling a load flake from a real failure meant re-running the whole suite in a
// throwaway tree by hand. Both are driven here against the real functions.

import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts/merge-pr.py');
const LOAD = `
import importlib.util, json, sys, time, os
spec = importlib.util.spec_from_file_location("mp", ${JSON.stringify(SCRIPT)})
mp = importlib.util.module_from_spec(spec); spec.loader.exec_module(mp)
`;
const py = (code, env = {}) => {
  const r = spawnSync('python3', ['-c', LOAD + code], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};

describe('a red gate names its failing tests', () => {
  it('reads vitest FAIL lines (with colour codes) and Playwright failure headers, once each', () => {
    // Shaped from the 9 Oct 2026 output: the same failure appears in the list AND the summary.
    const text = [
      '\u001b[31m   × Kevin\'s window is his until he closes it > the wait ends when he closes the window, and not before 30014ms\u001b[39m',
      ' \u001b[41m FAIL \u001b[49m tests/agent-browser-handover.test.js > Kevin\'s window is his until he closes it > the wait ends when he closes the window, and not before',
      ' FAIL  tests/agent-browser-handover.test.js > Kevin\'s window is his until he closes it > the wait ends when he closes the window, and not before',
      ' FAIL  tests/content-engine-spotify-waits.test.js > Spotify upload waits read the page, not the copy > a status word inside the description never holds a wait; the real status word does',
      ' Test Files  2 failed | 286 passed (288)',
      '  1) [chromium] › tests/sync-invariants/ai-team-health.spec.js:63:3 › AI Team section › shows the four health numbers ──────',
    ].join('\n');
    const out = py(`print(json.dumps(mp.failed_tests(${JSON.stringify(text)})))`);
    expect(out).toEqual([
      "tests/agent-browser-handover.test.js > Kevin's window is his until he closes it > the wait ends when he closes the window, and not before",
      'tests/content-engine-spotify-waits.test.js > Spotify upload waits read the page, not the copy > a status word inside the description never holds a wait; the real status word does',
      'tests/sync-invariants/ai-team-health.spec.js:63:3 › AI Team section › shows the four health numbers',
    ]);
  });

  it('a green run, or output with no failure lines, names nothing', () => {
    expect(py(`print(json.dumps(mp.failed_tests(" Test Files  292 passed (292)")))`)).toEqual([]);
  });
});

describe('one gate at a time on this Mac', () => {
  const lockFile = () => join(mkdtempSync(join(tmpdir(), 'gate-lock-')), 'merge-gate.lock');

  it('a second gate waits for the first, says who holds it, and gives up after its limit', async () => {
    const path = lockFile();
    const holder = spawn('python3', ['-c', LOAD + `
print(mp.acquire_gate_lock(744, path=${JSON.stringify(path)}), flush=True)
time.sleep(4)`], { env: process.env });
    await new Promise((ok) => holder.stdout.once('data', ok));      // the holder has the lock
    const t0 = Date.now();
    const out = py(`print(json.dumps(mp.acquire_gate_lock(750, path=${JSON.stringify(path)}, wait_max=1, poll=0.2)))`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);            // it waited, not refused at once
    expect(out).toMatch(/another merge gate \(PR #744 since \d\d:\d\d UTC\) held this Mac/);
    await new Promise((ok) => holder.on('exit', ok));
    expect(py(`print(json.dumps(mp.acquire_gate_lock(750, path=${JSON.stringify(path)}, wait_max=1, poll=0.2)))`)).toBeNull();
  });

  it('a gate that dies frees the lock at once, so it never holds the next one up', async () => {
    const path = lockFile();
    const holder = spawn('python3', ['-c', LOAD + `
print(mp.acquire_gate_lock(1, path=${JSON.stringify(path)}), flush=True)
time.sleep(60)`], { env: process.env });
    await new Promise((ok) => holder.stdout.once('data', ok));
    holder.kill('SIGKILL');
    await new Promise((ok) => holder.on('exit', ok));
    expect(py(`print(json.dumps(mp.acquire_gate_lock(2, path=${JSON.stringify(path)}, wait_max=1, poll=0.2)))`)).toBeNull();
  });

  it('a gate nested inside a test run takes no lock unless the test names one', () => {
    const home = mkdtempSync(join(tmpdir(), 'gate-home-'));
    const out = py(`print(json.dumps(mp.acquire_gate_lock(9)))`, { VITEST: 'true', MERGE_GATE_LOCK: '', HOME: home });
    expect(out).toBeNull();
    expect(existsSync(join(home, 'knowledge-os', 'logs', 'merge-gate.lock'))).toBe(false);
  });
});
