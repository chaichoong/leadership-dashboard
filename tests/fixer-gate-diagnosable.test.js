// A red merge gate must name the failing FILE and TEST, not only that it failed.
//
// Regression origin: finding 20261014-queue-fixer-867, seen 3 times.
//
//   run_gate() recorded `(stdout or stderr)[-400:]` per half and nothing else.
//   Vitest's last 400 characters are the summary counts, so on 13 Oct 2026 the
//   gate went RED twice on PR #762 and the only way to learn WHICH test failed
//   was to rebuild the merge result by hand and run both suites again — twelve
//   minutes, for a flake. A refusal nobody can diagnose is the shortest route
//   to someone reaching for SKIP_SYNC_TESTS=1, which is the whole point of the
//   gate gone.
//
// These drive the real run_gate() with sh() stubbed, so they fail if the
// reporter wiring is removed — not a grep over the source.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = resolve(ROOT, 'scripts/fixer-merge.py');

// Runs run_gate() with sh() replaced by `stub`, a python function body given
// (args, cwd, env) that writes whatever reporter file it was pointed at.
function gate(stubBody) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, os, types
spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(GATE)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class R:
    def __init__(self, rc, so="", se=""):
        self.returncode, self.stdout, self.stderr = rc, so, se

def stub(args, cwd=None, timeout=1800, env=None):
${stubBody.split('\n').map((l) => '    ' + l).join('\n')}

m.sh = stub
ok, g = m.run_gate("/tmp/not-a-real-tree")
print(json.dumps({"ok": ok, "gate": g}))
`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

// What vitest --reporter=json actually writes for one failing assertion.
const VITEST_REPORT = `json.dump({
      "testResults": [
        {"name": "/t/tests/money.test.js", "status": "failed", "assertionResults": [
           {"status": "passed", "fullName": "money > adds up"},
           {"status": "failed", "fullName": "money > splits a transaction"}]},
        {"name": "/t/tests/ok.test.js", "status": "passed", "assertionResults": [
           {"status": "passed", "fullName": "ok > fine"}]}
      ]}, fh)`;

describe('a red vitest half names the failing file and test', () => {
  const r = gate(`
if "vitest" in args:
    path = [a.split("=", 1)[1] for a in args if a.startswith("--outputFile.json=")][0]
    with open(path, "w") as fh:
        ${VITEST_REPORT}
    return R(1, "x" * 900 + "Tests  1 failed | 1 passed")
return R(0, "")
`);

  it('refuses', () => {
    expect(r.ok).toBe(false);
    expect(r.gate.vitest.ok).toBe(false);
  });

  it('records the failing file and test name, which the tail does not carry', () => {
    expect(r.gate.vitest.failed).toEqual([
      { file: '/t/tests/money.test.js', test: 'money > splits a transaction' },
    ]);
    // Back-test: with the old 400-character tail alone, this is all there was.
    expect(r.gate.vitest.tail).not.toContain('money.test.js');
  });

  it('keeps the tail as well, so nothing that used to be there is lost', () => {
    expect(r.gate.vitest.tail).toContain('1 failed');
    expect(r.gate.vitest.tail.length).toBeLessThanOrEqual(400);
  });

  it('does not run the browser half once vitest is red', () => {
    expect(r.gate.browser).toBeUndefined();
  });
});

describe('a file that fails to COLLECT is named too', () => {
  it('an import error has no assertions, and used to read as a bare non-zero exit', () => {
    const r = gate(`
if "vitest" in args:
    path = [a.split("=", 1)[1] for a in args if a.startswith("--outputFile.json=")][0]
    with open(path, "w") as fh:
        json.dump({"testResults": [{"name": "/t/tests/broken.test.js",
                                    "status": "failed", "message": "Cannot find module",
                                    "assertionResults": []}]}, fh)
    return R(1, "Error")
return R(0, "")
`);
    expect(r.gate.vitest.failed).toEqual([
      { file: '/t/tests/broken.test.js', test: '(file failed to run)' },
    ]);
  });
});

describe('a red browser half names the failing spec', () => {
  const r = gate(`
if "vitest" in args:
    return R(0, "Tests  1777 passed")
path = (env or {})["PLAYWRIGHT_JSON_OUTPUT_NAME"]
with open(path, "w") as fh:
    json.dump({"suites": [{"file": "sync-invariants/tasks.spec.js", "specs": [
        {"title": "renders every task", "ok": True, "file": "sync-invariants/tasks.spec.js"},
        {"title": "patches with a typecast", "ok": False, "file": "sync-invariants/tasks.spec.js"}]}]}, fh)
return R(1, "y" * 900 + "1 failed")
`);

  it('runs the browser half only after vitest is green, and refuses', () => {
    expect(r.gate.vitest.ok).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.gate.browser.ok).toBe(false);
  });

  it('names the spec, which the playwright dot tail does not', () => {
    expect(r.gate.browser.failed).toEqual([
      { file: 'sync-invariants/tasks.spec.js', test: 'patches with a typecast' },
    ]);
    expect(r.gate.browser.tail).not.toContain('tasks.spec.js');
  });

  it('is pointed at its report by env, which sh() merges over the real environment', () => {
    // A bare env dict would strip PATH and npx would not resolve, so sh() must
    // merge. Proven by the stub above receiving a dict that carries only the
    // one key while the real sh() is the thing that merges it.
    const src = execFileSync('python3', ['-c', `
import inspect, importlib.util
spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(GATE)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(inspect.getsource(m.sh))`], { encoding: 'utf8' });
    expect(src).toContain('dict(os.environ)');
  });
});

describe('a reporter that wrote nothing still leaves a verdict', () => {
  it('an unreadable report is an empty list, never an exception', () => {
    const r = gate(`
if "vitest" in args:
    return R(1, "crashed before writing a report")
return R(0, "")
`);
    expect(r.gate.vitest.ok).toBe(false);
    expect(r.gate.vitest.failed).toEqual([]);
    expect(r.gate.vitest.tail).toContain('crashed');
  });

  it('a green run records an empty failed list, not a missing key', () => {
    const r = gate(`
if "vitest" in args:
    return R(0, "Tests  1777 passed")
path = (env or {})["PLAYWRIGHT_JSON_OUTPUT_NAME"]
with open(path, "w") as fh:
    json.dump({"suites": [{"file": "a.spec.js", "specs": [{"title": "t", "ok": True}]}]}, fh)
return R(0, "4 passed")
`);
    expect(r.ok).toBe(true);
    expect(r.gate.vitest.failed).toEqual([]);
    expect(r.gate.browser.failed).toEqual([]);
  });
});
