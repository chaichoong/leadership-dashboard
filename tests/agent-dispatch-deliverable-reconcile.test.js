import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// 20260819-agent-dispatch-244.
//
// An agent finished a tier-1 deliverable to disk. The run ended before the
// submit landed, so the task sat open with an empty Agent Output and a
// five-day court deadline was invisible in every surface Kevin looks at.
// Nothing alarmed, because nothing had RECORDED the action — and a report
// cannot catch a missing report line.
//
// Two controls answer that. `submit` reads the record back and refuses to
// report success on a write that did not land. `reconcile` reads the DISK:
// a RUNDIR/TASKID.md whose record carries no Agent Output is work that was
// done and never reached Kevin.

const TASK = 'recWMNb1C7kaRlRAi';   // the real task from the finding
let logdir;

beforeAll(() => {
  logdir = mkdtempSync(join(tmpdir(), 'dispatch-log-'));
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-093000';
  mkdirSync(join(logdir, stamp));
  writeFileSync(join(logdir, stamp, `${TASK}.md`),
    'Prepared response to the liability order hearing.\n\nCarrying this out will involve: filing the response.');
  // Not a task id, so it must be ignored rather than looked up.
  writeFileSync(join(logdir, stamp, 'report.json'), '{}');
  writeFileSync(join(logdir, stamp, 'notes.md'), 'scratch');
});

afterAll(() => rmSync(logdir, { recursive: true, force: true }));

// Runs the real cmd_reconcile with get_task swapped for a recorder, so no
// Airtable call happens and the assertions are against real script behaviour.
function reconcile({ agentOutput }) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
looked_up = []
def fake_get(tid):
    looked_up.append(tid)
    return {"id": tid, "fields": {
        m.AF["name"]: "Council tax liability order hearing",
        m.AF["status"]: {"name": "Today"},
        m.AF["agentOutput"]: ${JSON.stringify(agentOutput)},
    }}
m.get_task = fake_get
class A: pass
a = A(); a.logdir = ${JSON.stringify('LOGDIR')}; a.days = 3
code = 0
try:
    m.cmd_reconcile(a)
except SystemExit as e:
    code = e.code or 0
print('@@@' + json.dumps({"exit": code, "lookedUp": looked_up}))
`.replace('"LOGDIR"', JSON.stringify(logdir));
  let stdout = '';
  try {
    stdout = execFileSync('python3', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    stdout = String(e.stdout || '');
  }
  const body = stdout.slice(0, stdout.indexOf('@@@'));
  const meta = JSON.parse(stdout.slice(stdout.indexOf('@@@') + 3));
  return { ...meta, report: JSON.parse(body) };
}

describe('agent-dispatch reconcile — a deliverable that never reached Airtable', () => {

  it('fails loudly, naming the record, when the record carries no Agent Output', () => {
    const r = reconcile({ agentOutput: '' });
    expect(r.exit, 'an orphaned deliverable read as a pass').toBe(1);
    expect(r.report.ok).toBe(false);
    expect(r.report.orphans).toHaveLength(1);
    expect(r.report.orphans[0].task).toBe(TASK);
    expect(r.report.orphans[0].chars).toBeGreaterThan(0);
  });

  it('the count of deliverables on disk is reported next to the count carrying output', () => {
    const r = reconcile({ agentOutput: '' });
    expect(r.report.deliverablesOnDisk).toBe(1);
    expect(r.report.recordsCarryingOutput).toBe(0);
  });

  it('is quiet once the work has reached Airtable', () => {
    const r = reconcile({ agentOutput: 'the prepared response, 900 characters of it' });
    expect(r.exit).toBe(0);
    expect(r.report.ok).toBe(true);
    expect(r.report.orphans).toHaveLength(0);
    expect(r.report.recordsCarryingOutput).toBe(1);
  });

  it('only looks up files named for a task record, not scratch or report files', () => {
    const r = reconcile({ agentOutput: '' });
    expect(r.lookedUp).toEqual([TASK]);
  });

  it('an unreadable record fails the run rather than reading as no orphan', () => {
    // A broken read returning "no output" and a genuine orphan are different
    // problems; neither may pass silently.
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
def boom(tid): raise RuntimeError('403 from Airtable')
m.get_task = boom
class A: pass
a = A(); a.logdir = ${JSON.stringify(logdir)}; a.days = 3
code = 0
try:
    m.cmd_reconcile(a)
except SystemExit as e:
    code = e.code or 0
print('@@@' + json.dumps({"exit": code}))
`;
    let out = '';
    try { out = execFileSync('python3', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { out = String(e.stdout || ''); }
    const report = JSON.parse(out.slice(0, out.indexOf('@@@')));
    expect(JSON.parse(out.slice(out.indexOf('@@@') + 3)).exit).toBe(1);
    expect(report.unreadable).toHaveLength(1);
  });

  it('the subcommand is wired into the parser', () => {
    const help = execFileSync('python3', [DISPATCH, '--help'], { encoding: 'utf8' });
    expect(help).toContain('reconcile');
  });
});

describe('agent-dispatch submit — the write is read back, not assumed', () => {
  function submit({ liveOutput, liveStatus }) {
    const outFile = join(logdir, 'submit-payload.md');
    writeFileSync(outFile,
      'A full analysis of the position, long enough to need a summary line and then some, '.repeat(4) +
      '\n\nCarrying this out will involve: nothing beyond Kevin reading it.');
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
agent = next(iter(m.AGENTS))
m.patch_task = lambda tid, fields: {}
m.get_task = lambda tid: {"id": tid, "fields": {
    m.AF["name"]: "Prepare the analysis",
    m.AF["status"]: {"name": ${JSON.stringify(liveStatus)}},
    m.AF["agentOutput"]: ${JSON.stringify(liveOutput)},
}}
class A: pass
a = A(); a.task = ${JSON.stringify(TASK)}; a.agent = agent; a.type = 'Analysis'
a.output_file = ${JSON.stringify(outFile)}; a.tier1 = False
err = ''
try:
    m.cmd_submit(a)
except SystemExit as e:
    err = str(e)
print('@@@' + json.dumps({"error": err}))
`;
    const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
    return JSON.parse(out.slice(out.indexOf('@@@') + 3));
  }

  it('refuses to report success when the record comes back empty', () => {
    const r = submit({ liveOutput: '', liveStatus: 'Today' });
    expect(r.error, 'a submit that never landed reported green').not.toBe('');
    expect(r.error).toContain('did not land');
    expect(r.error).toContain(TASK);
  });

  it('refuses when the status did not move to Approval', () => {
    const r = submit({ liveOutput: 'the work', liveStatus: 'Today' });
    expect(r.error).toContain('did not land');
  });

  it('passes when both the output and the status landed', () => {
    const r = submit({ liveOutput: 'the work', liveStatus: 'Approval' });
    expect(r.error, r.error).toBe('');
  });
});
