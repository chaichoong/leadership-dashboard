// 20260823-agent-dispatch-323.
//
// SKILL.md has ordered `agent-dispatch.py reconcile` as MANDATORY step 1 since
// the 19 Aug 2026 incident, and the subcommand did not exist. argparse refused
// it with "invalid choice", the run logged the error and carried on, and the
// check that was added to catch an invisible tier-1 deliverable with a
// five-day court deadline had never once run.
//
// THE FAILURE IT CATCHES: an agent finishes, writes RUNDIR/TASKID.md, and the
// run dies before `submit`. The work exists on disk and the Airtable record
// still has an empty Agent Output, so it appears in NO surface Kevin looks at
// and nothing alarms — an unfinished action leaves no trace of itself.
//
// The real cmd_reconcile runs against a temporary run directory with get_task
// swapped for a stub, so no Airtable call happens.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

const FULL = 'x'.repeat(400);   // a finished deliverable

// runs: {dirName: {taskId: fileBody}}   tasks: {taskId: {output, status, ...}}
function reconcile({ runs, tasks, runsArg = 3, noStateDir = false }) {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-'));
  try {
    const stateDir = join(root, 'agent-dispatch');
    if (!noStateDir) {
      mkdirSync(stateDir);
      for (const [dir, files] of Object.entries(runs || {})) {
        mkdirSync(join(stateDir, dir));
        for (const [name, body] of Object.entries(files)) {
          writeFileSync(join(stateDir, dir, name), body);
        }
      }
    }
    const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.STATE_DIR = ${JSON.stringify(join(root, 'agent-dispatch'))}
TASKS = json.loads(${JSON.stringify(JSON.stringify(tasks || {}))})
def fake_get(tid):
    t = TASKS.get(tid)
    if t is None:
        raise RuntimeError("Airtable GET /%s -> HTTP 404" % tid)
    return {"id": tid, "fields": {
        m.AF["name"]: t.get("name", "A task"),
        m.AF["status"]: t.get("status", "Today"),
        m.AF["agentOutput"]: t.get("output", ""),
        m.AF["sentForApprovalBy"]: [{"id": a} for a in t.get("sentBy", [])],
        m.AF["approvalOutcome"]: t.get("outcome", ""),
    }}
m.get_task = fake_get
class A: pass
a = A(); a.runs = ${runsArg}
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = m.cmd_reconcile(a)
out = buf.getvalue().strip()
print('@@@' + json.dumps({"rc": rc, "out": json.loads(out) if out else None}))
`;
    const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(raw.slice(raw.indexOf('@@@') + 3));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('agent-dispatch reconcile', () => {
  it('names a finished deliverable whose task has an empty Agent Output', () => {
    // The 19 Aug shape exactly.
    const r = reconcile({
      runs: { '20260819-074500': { 'recAAAAAAAAAAAAAA.md': FULL } },
      tasks: { recAAAAAAAAAAAAAA: { output: '', status: 'Today' } },
    });
    expect(r.rc, 'an orphaned deliverable exited 0, so the run would carry on past it').toBe(1);
    expect(r.out.orphans).toHaveLength(1);
    expect(r.out.orphans[0].task).toBe('recAAAAAAAAAAAAAA');
    expect(r.out.orphans[0].why).toMatch(/Agent Output is empty/);
  });

  it('names a task that reached Airtable but never left the pre-submit state', () => {
    const r = reconcile({
      runs: { '20260819-074500': { 'recBBBBBBBBBBBBBB.md': FULL } },
      tasks: { recBBBBBBBBBBBBBB: { output: 'earlier text', status: 'Overdue' } },
    });
    expect(r.rc).toBe(1);
    expect(r.out.orphans[0].why).toMatch(/never sent for approval/);
  });

  it('exits 0 on a task that was properly submitted', () => {
    const r = reconcile({
      runs: { '20260819-074500': { 'recCCCCCCCCCCCCCC.md': FULL } },
      tasks: { recCCCCCCCCCCCCCC: { output: FULL, status: 'Approval', sentBy: ['recQkO6BA4w5zqwZ4'] } },
    });
    expect(r.rc, r.out && JSON.stringify(r.out.orphans)).toBe(0);
    expect(r.out.reconciled).toBe(1);
  });

  it('exits 0 on a carried-out task that has been completed', () => {
    const r = reconcile({
      runs: { '20260819-074500': { 'recDDDDDDDDDDDDDD.md': FULL } },
      tasks: { recDDDDDDDDDDDDDD: { output: '', status: 'Completed' } },
    });
    expect(r.rc).toBe(0);
  });

  it('reads only the last N run directories, newest deliverable winning', () => {
    const r = reconcile({
      runs: {
        '20260817-070000': { 'recOLDOLDOLDOLDO.md': FULL },
        '20260821-070000': { 'recEEEEEEEEEEEEEE.md': FULL },
        '20260822-070000': { 'recEEEEEEEEEEEEEE.md': FULL },
        '20260823-070000': { 'recFFFFFFFFFFFFFF.md': FULL },
      },
      tasks: {
        recOLDOLDOLDOLDO: { output: '', status: 'Today' },
        recEEEEEEEEEEEEEE: { output: FULL, status: 'Approval', sentBy: ['recQkO6BA4w5zqwZ4'] },
        recFFFFFFFFFFFFFF: { output: FULL, status: 'Approval', sentBy: ['recQkO6BA4w5zqwZ4'] },
      },
    });
    expect(r.out.runsChecked).toEqual(['20260821-070000', '20260822-070000', '20260823-070000']);
    expect(r.out.deliverablesChecked, 'the same task in two runs was counted twice').toBe(2);
    expect(r.rc, 'a run older than the window was still read').toBe(0);
  });

  it('does not treat an agent that produced nothing as an orphan to submit', () => {
    // "Hung, produced nothing" is a different failure, already reported. Putting
    // an empty file through Kevin's gate would be noise.
    const r = reconcile({
      runs: { '20260823-070000': { 'recGGGGGGGGGGGGGG.md': 'x' } },
      tasks: { recGGGGGGGGGGGGGG: { output: '', status: 'Today' } },
    });
    expect(r.rc).toBe(0);
    expect(r.out.emptyDeliverables).toHaveLength(1);
  });

  it('names a deleted task without failing the run over it', () => {
    const r = reconcile({
      runs: { '20260823-070000': { 'recHHHHHHHHHHHHHH.md': FULL } },
      tasks: {},
    });
    expect(r.rc).toBe(0);
    expect(r.out.unreadable).toHaveLength(1);
  });

  it('ignores per-task working directories and anything not named for a task', () => {
    const r = reconcile({
      runs: { '20260823-070000': { 'queue.json': '{}', 'report.json': '{}', 'notes.md': FULL } },
      tasks: {},
    });
    expect(r.out.deliverablesChecked).toBe(0);
    expect(r.rc).toBe(0);
  });

  it('exits 2, not 0, when it cannot see the run directories at all', () => {
    // A silent zero here would read as "nothing to reconcile" for ever, which
    // is the same class of bug as the check being missing.
    const r = reconcile({ noStateDir: true });
    expect(r.rc).toBe(2);
  });

  it('is wired into the parser and the dispatch table, and passes its exit code on', () => {
    const help = execFileSync('python3', [DISPATCH, '--help'], { encoding: 'utf8' });
    expect(help, 'SKILL.md step 1 calls a subcommand that does not exist').toContain('reconcile');
    const src = execFileSync('cat', [DISPATCH], { encoding: 'utf8' });
    expect(src).toMatch(/"reconcile":\s*cmd_reconcile/);
    // main() discarding the return value would make reconcile exit 0 whatever
    // it found — the failure it exists to prevent.
    expect(src).toMatch(/sys\.exit\(rc or 0\)/);
  });
});
