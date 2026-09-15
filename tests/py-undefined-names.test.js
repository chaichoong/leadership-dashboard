import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = resolve(ROOT, 'tests/helpers/py_undefined_names.py');

// 13-14 Sep 2026: PR #399 deleted the INTRO_LOCAL constant from
// scripts/content-engine/render.py and left its four uses in intro_clip().
// Python raises NameError only when that function RUNS, so every long-episode
// render died one clip at a time ("render FAILED for 2057 Full.insv: name
// 'INTRO_LOCAL' is not defined") while the module imported cleanly, its
// selftest stayed green, and the publisher held three approved episodes
// behind the day that could not render. Two days of publishing lost, no alarm.
//
// This is the static half of that lesson: a name a module reads and never
// binds anywhere is a bug in waiting, whatever the tests happen to call.
// Back-tested against the #399 version of render.py, which reports
// ["INTRO_LOCAL"]; the repaired file reports [].
const ESTATE_SCRIPTS = [
  'scripts/content-engine/render.py',
  'scripts/content-engine/publish.py',
  'scripts/content-engine/watch.py',
  'scripts/content-engine/approval.py',
  'scripts/content-engine/content_report.py',
  'scripts/content-engine/runpreneur_sync.py',
  'scripts/agent-dispatch.py',
  'scripts/handback-poll.py',
  'scripts/session-keepalive.py',
  'scripts/create-agent-task.py',
  'scripts/job-queue.py',
  'scripts/estate-status.py',
  'scripts/loop-health.py',
];

describe('estate scripts read no name they never bind', () => {
  const out = JSON.parse(execFileSync('python3', [CHECK, ...ESTATE_SCRIPTS], { cwd: ROOT, encoding: 'utf8' }));
  for (const f of ESTATE_SCRIPTS) {
    it(`${f} binds every name it reads`, () => {
      expect(out[f], `${f} reads these names but never defines them`).toEqual([]);
    });
  }

  it('control: the checker sees a deleted constant (the #399 shape)', () => {
    const d = mkdtempSync(join(tmpdir(), 'undef-'));
    const p = join(d, 'broken.py');
    writeFileSync(p, 'import os\ndef f():\n    return os.path.join(INTRO_LOCAL, "x")\n');
    const r = JSON.parse(execFileSync('python3', [CHECK, p], { encoding: 'utf8' }));
    expect(r[p]).toEqual(['INTRO_LOCAL']);
  });
});
