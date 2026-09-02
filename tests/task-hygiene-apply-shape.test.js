import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Finding 20260902-task-manager-09-434. The Task Manager's 09:00 slot fed the
// audit's WORKLIST (key 'tasks': gaps to decide) to `apply`, which wanted a
// DECISIONS file (key 'decisions': values to write), and doc['decisions'] died
// with a bare KeyError. The finding proposed accepting 'tasks' as a fallback,
// which would be worse: those rows carry no field or value, so the step would
// report success over zero writes. The fix is a one-line refusal that says how
// to author the decisions file, raised BEFORE any token read or schema call.

const SCRIPT = resolve(__dirname, '../scripts/task-hygiene-sweep.py');
const DIR = mkdtempSync(join(tmpdir(), 'hygiene-apply-'));

function apply(doc) {
  const path = join(DIR, `in-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(doc));
  const out = execFileSync('python3', ['-c', `
import json, sys, importlib.util, types
spec = importlib.util.spec_from_file_location("sweep", ${JSON.stringify(SCRIPT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
# Any network step proves the shape check did not run first.
def boom(*a, **k): raise RuntimeError("NETWORK REACHED")
mod.pat = boom
mod.load_schema = boom
args = types.SimpleNamespace(decisions=${JSON.stringify(path)}, tier="auto", dry_run=True)
try:
    mod.cmd_apply(args)
    print(json.dumps({"exit": 0, "msg": ""}))
except SystemExit as e:
    print(json.dumps({"exit": e.code if isinstance(e.code, int) else 2, "msg": str(e)}))
except RuntimeError as e:
    print(json.dumps({"exit": -1, "msg": str(e)}))
`], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('task-hygiene-sweep apply refuses the audit worklist with instructions', () => {
  it('a worklist-shaped file is refused in one message, before any network call', () => {
    const r = apply({ generatedAt: 'x', gapCounts: { project: 3 }, tasks: [
      { recordId: 'recAAAAAAAAAAAAAA', name: 'T', gaps: ['timeEstimate'], context: {} },
    ] });
    expect(r.exit).not.toBe(0);
    expect(r.msg).toMatch(/AUDIT WORKLIST/);
    expect(r.msg).toMatch(/"decisions"/);
    expect(r.msg).toMatch(/timeEstimate/);
    expect(r.msg).not.toMatch(/NETWORK REACHED/);
  });

  it('a decisions-shaped file passes the shape check and proceeds to the (stubbed) network', () => {
    const r = apply({ decisions: [
      { recordId: 'recAAAAAAAAAAAAAA', field: 'timeEstimate', value: '30 min', reason: 'r' },
    ] });
    // -1 == the stub was reached: the shape check let a real file through.
    expect(r.exit).toBe(-1);
    expect(r.msg).toMatch(/NETWORK REACHED/);
  });

  it('a file with neither shape is refused, never treated as empty-and-fine', () => {
    const r = apply({ hello: 'world' });
    expect(r.exit).not.toBe(0);
    expect(r.msg).toMatch(/neither/);
  });
});
