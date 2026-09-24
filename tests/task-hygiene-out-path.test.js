import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, join } from 'path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

// Finding 20260923-task-manager-585. audit's work-list and apply's undo log both
// defaulted to monitoring/ inside this PUBLIC repo. On 23 Sep the 09:00 slot ran
// the documented commands with no --out and wrote a 372KB work-list of task names
// and descriptions there. The only thing standing between that and a commit was
// one exact gitignore pattern, which is not a control.
//
// These drive work_path() directly rather than grepping the source, and the
// back-test is the last case: restore the old behaviour (fall back to a path
// under the repo) and "refuses with no scratch and no --out" fails.

const SCRIPT = resolve(__dirname, '../scripts/task-hygiene-sweep.py');
const REPO = resolve(__dirname, '..');

function workPath(env, explicit) {
  const out = execFileSync('python3', ['-c', `
import json, importlib.util
spec = importlib.util.spec_from_file_location("sweep", ${JSON.stringify(SCRIPT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
env = json.loads(${JSON.stringify(JSON.stringify(env))})
explicit = json.loads(${JSON.stringify(JSON.stringify(explicit))})
try:
    print(json.dumps({"path": mod.work_path(explicit, "wl.json", env=env)}))
except SystemExit as e:
    print(json.dumps({"error": str(e)}))
`], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('task-hygiene-sweep working-file paths (finding 585)', () => {
  it('defaults to the slot scratch when TASK_MANAGER_SCRATCH is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hygiene-scratch-'));
    const r = workPath({ TASK_MANAGER_SCRATCH: dir }, null);
    expect(r.path).toBe(join(dir, 'wl.json'));
  });

  it('falls back to AGENT_SLOT_SCRATCH for slots that export that name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hygiene-slot-'));
    const r = workPath({ AGENT_SLOT_SCRATCH: dir }, null);
    expect(r.path).toBe(join(dir, 'wl.json'));
  });

  it('an explicit --out always wins over the scratch default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hygiene-explicit-'));
    const chosen = join(dir, 'somewhere-else.json');
    const r = workPath({ TASK_MANAGER_SCRATCH: '/tmp/ignored-by-explicit' }, chosen);
    expect(r.path).toBe(chosen);
  });

  it('never resolves a default path inside the repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hygiene-norepo-'));
    const r = workPath({ TASK_MANAGER_SCRATCH: dir }, null);
    expect(r.path.startsWith(REPO)).toBe(false);
    expect(r.path).not.toContain('monitoring');
  });

  // THE BACK-TEST. The old code was `args.out or os.path.join(MONITORING, ...)`,
  // which silently produced a repo path here. This case is the one that fails if
  // anyone reinstates a fallback.
  it('refuses with no scratch and no --out rather than picking a public path', () => {
    const r = workPath({}, null);
    expect(r.path).toBeUndefined();
    expect(r.error).toMatch(/no scratch directory set/);
    expect(r.error).toMatch(/PUBLIC/);
  });

  it('previous_worklist still reads a run left behind in monitoring/', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'hygiene-prev-'));
    const legacy = mkdtempSync(join(tmpdir(), 'hygiene-legacy-'));
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'task-sweep-worklist-2026-09-20.json'),
      JSON.stringify({ openTasks: 11, compliancePct: 50 }));
    const out = execFileSync('python3', ['-c', `
import json, importlib.util, os
spec = importlib.util.spec_from_file_location("sweep", ${JSON.stringify(SCRIPT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
os.environ["TASK_MANAGER_SCRATCH"] = ${JSON.stringify(scratch)}
mod.MONITORING = ${JSON.stringify(legacy)}
print(json.dumps(mod.previous_worklist("2026-09-24")))
`], { encoding: 'utf8' });
    const prev = JSON.parse(out.trim().split('\n').pop());
    expect(prev._date).toBe('2026-09-20');
    expect(prev.openTasks).toBe(11);
  });

  it('prefers the newest run wherever it was written', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'hygiene-new-'));
    const legacy = mkdtempSync(join(tmpdir(), 'hygiene-old-'));
    writeFileSync(join(legacy, 'task-sweep-worklist-2026-09-20.json'),
      JSON.stringify({ openTasks: 11 }));
    writeFileSync(join(scratch, 'task-sweep-worklist-2026-09-23.json'),
      JSON.stringify({ openTasks: 22 }));
    const out = execFileSync('python3', ['-c', `
import json, importlib.util, os
spec = importlib.util.spec_from_file_location("sweep", ${JSON.stringify(SCRIPT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
os.environ["TASK_MANAGER_SCRATCH"] = ${JSON.stringify(scratch)}
mod.MONITORING = ${JSON.stringify(legacy)}
print(json.dumps(mod.previous_worklist("2026-09-24")))
`], { encoding: 'utf8' });
    const prev = JSON.parse(out.trim().split('\n').pop());
    expect(prev._date).toBe('2026-09-23');
    expect(prev.openTasks).toBe(22);
  });
});
