import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// 27 Sep 2026: agent-dispatch raised twelve failure alerts in one afternoon and
// none was a fault. Seven were "N eligible tasks and ZERO completed actions" from
// the half-hourly hand-back poll, which is TOLD to ignore new work while its
// worklist counts new work too, or which met a wall already on record. Five were
// draft reports the agent verified through the alarm wrapper, fixed, and verified
// again a minute later. An alarm channel that cries wolf twelve times a day gets
// ignored, which is worse than no alarm.
//
// These drive the real cmd_verify with only the live reads stubbed: the task
// record, the ledger and the lesson check.
// Python reads each value through json.loads, so JSON null/true/false arrive intact.
const J = (x) => `json.loads(${JSON.stringify(JSON.stringify(x))})`;

function verify({ report, queue = null, handbackOnly = false, tasks = {}, ledger = {}, dryRun = false, preAlerted = null }) {
  const script = `
import importlib.util, json, os, sys, io, tempfile, types, contextlib
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
tmp = tempfile.mkdtemp()
m.STATE_DIR = tmp
rundir = os.path.join(tmp, 'run'); os.makedirs(rundir)
json.dump(${J(report)}, open(os.path.join(rundir, 'report.json'), 'w'))
queue = ${J(queue)}
if queue is not None: json.dump(queue, open(os.path.join(rundir, 'queue.json'), 'w'))
if ${handbackOnly ? 'True' : 'False'}: open(os.path.join(rundir, m.HANDBACK_ONLY_MARK), 'w').close()
pre = ${J(preAlerted)}
if pre is not None: json.dump(pre, open(os.path.join(tmp, 'tier1-alerted.json'), 'w'))
tasks = ${J(tasks)}
def fake_get_task(tid):
    t = tasks.get(tid)
    if t is None: raise RuntimeError('no such task')
    return {"id": tid, "fields": {m.AF["notes"]: t.get("notes", ""), m.AF["status"]: t.get("status", "Today")}}
m.get_task = fake_get_task
led = {k: tuple(v) for k, v in ${J(ledger)}.items()}
m.ledger_last_events = lambda: led
m.overdue_lessons = lambda: []
out, err = io.StringIO(), io.StringIO()
code = 0
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
    try:
        m.cmd_verify(types.SimpleNamespace(report=os.path.join(rundir, 'report.json'), dry_run=${dryRun ? 'True' : 'False'}))
    except SystemExit as e:
        code = e.code or 0
alerted = os.path.exists(os.path.join(tmp, 'tier1-alerted.json')) and json.load(open(os.path.join(tmp, 'tier1-alerted.json')))
print(json.dumps({"code": code, "out": out.getvalue(), "err": err.getvalue(), "alerted": alerted}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

const COUNTS = (worklist) => ({ worklist, openTasksRead: 127 });
const WALL = '[2026-09-27T18:07:31Z — agent-dispatch] BLOCKER OPEN (TOOL Meta Business Suite new-case filing): no new-case entry point [since 2026-09-25T16:21:06.000Z] [finding 20260925-agent-dispatch-621]';
const HANDBACK_QUEUE = {
  worklist: [
    { id: 'recWALL', kind: 'carry_out' },
    { id: 'recNEW1', kind: 'new' },
    { id: 'recNEW2', kind: 'new' },
  ],
};

describe('a hand-back poll that leaves new work alone is not a silent run', () => {
  it('only new work in the queue, nothing done: green (14:33, 15:02, 16:33 on 27 Sep)', () => {
    const r = verify({
      report: { queueCounts: COUNTS(2), actions: [] },
      queue: { worklist: [{ id: 'recNEW1', kind: 'new' }, { id: 'recNEW2', kind: 'new' }] },
      handbackOnly: true,
    });
    expect(r.err).not.toContain('ZERO');
    expect(r.code).toBe(0);
  });

  it('CONTROL: a hand-back it owed and did not touch still fails', () => {
    const r = verify({ report: { queueCounts: COUNTS(3), actions: [] }, queue: HANDBACK_QUEUE, handbackOnly: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain('1 eligible tasks and ZERO actions attempted');
  });

  it('a sign-in reopened item counts as owed even when its kind is new', () => {
    const r = verify({
      report: { queueCounts: COUNTS(1), actions: [] },
      queue: { worklist: [{ id: 'recS', kind: 'new', signinReopened: true }] },
      handbackOnly: true,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('ZERO actions attempted');
  });

  it("the agent's own claim to be hand-back-only excuses nothing: only the runner's marker counts", () => {
    const r = verify({
      report: { queueCounts: COUNTS(2), actions: [], handBackOnlyRun: true, newWorkIgnored: [{ task: 'recNEW1' }, { task: 'recNEW2' }] },
      queue: HANDBACK_QUEUE,
      handbackOnly: false,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('2 eligible tasks and ZERO actions attempted');
  });

  it('a hand-back run whose queue.json is missing fails loudly rather than guessing', () => {
    const r = verify({ report: { queueCounts: COUNTS(1), actions: [] }, queue: null, handbackOnly: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain("queue.json unreadable");
  });
});

describe('a carry-out that meets a wall already on record rests on it', () => {
  const failedOnWall = { task: 'recWALL', kind: 'carry_out', ok: false, error: 'still blocked: TOOL wall (finding 20260925-agent-dispatch-621, still open)' };

  it('open BLOCKER in the live Notes + parked in the ledger: green, and listed (the Meta dispute task, 19:00)', () => {
    const r = verify({
      report: { queueCounts: COUNTS(3), actions: [failedOnWall] },
      queue: HANDBACK_QUEUE,
      handbackOnly: true,
      tasks: { recWALL: { notes: WALL } },
      ledger: { recWALL: ['parked', '2026-09-27T18:07:31.000Z'] },
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).restedOnWall).toEqual(['recWALL']);
    expect(r.err).toContain('INFO: recWALL met its recorded wall again');
  });

  it('CONTROL: a failed action with no wall on record still alarms', () => {
    const r = verify({
      report: { queueCounts: COUNTS(1), actions: [{ ...failedOnWall, task: 'recX', error: 'agent hung' }] },
      tasks: { recX: { notes: '' } },
      ledger: { recX: ['intent', '2026-09-27T18:02:32.000Z'] },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('action failed: carry_out recX');
  });

  it('CONTROL: an open wall the ledger does not show as parked still alarms', () => {
    const r = verify({
      report: { queueCounts: COUNTS(1), actions: [failedOnWall] },
      tasks: { recWALL: { notes: WALL } },
      ledger: { recWALL: ['intent', '2026-09-27T18:02:32.000Z'] },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('action failed: carry_out recWALL');
  });

  it('CONTROL: a task that cannot be re-read is never excused', () => {
    const r = verify({
      report: { queueCounts: COUNTS(1), actions: [{ ...failedOnWall, task: 'recGONE' }] },
      ledger: { recGONE: ['parked', '2026-09-27T18:07:31.000Z'] },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('action failed: carry_out recGONE');
  });

  it('a run whose only action failed on a fresh fault is one alarm line, not two', () => {
    const r = verify({
      report: { queueCounts: COUNTS(1), actions: [{ ...failedOnWall, task: 'recX', error: 'agent hung' }] },
      tasks: { recX: { notes: '' } },
    });
    expect(r.err).not.toContain('ZERO');
    expect(r.err.match(/^ERROR:/gm).length).toBe(1);
  });
});

describe('--dry-run is the self-check: same checks, nothing spent', () => {
  const parked = { id: 'recPAY', name: 'INBOUND: invoice due 29/09' };

  it('a new parked task fails the dry run but is NOT marked as alerted', () => {
    const r = verify({ report: { queueCounts: COUNTS(1), actions: [], parkedFlags: [parked] }, dryRun: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain('approved task PARKED');
    expect(r.alerted).toBe(false);
  });

  it('CONTROL: the real control alarms once and records it', () => {
    const r = verify({ report: { queueCounts: COUNTS(1), actions: [], parkedFlags: [parked] } });
    expect(r.code).toBe(1);
    expect(r.alerted).toEqual(['recPAY']);
  });

  it('after a dry run the real control still alarms the parked task (the self-check spent nothing)', () => {
    const r = verify({ report: { queueCounts: COUNTS(1), actions: [], parkedFlags: [parked] }, preAlerted: [] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('recPAY');
  });
});

describe('the prompts say it', () => {
  it('the skill runs the self-check first and the wrapped control exactly once, last', () => {
    const skill = execFileSync('cat', [resolve(ROOT, '.claude/scheduled-tasks/agent-dispatch/SKILL.md')], { encoding: 'utf8' });
    const step = skill.slice(skill.indexOf('7. CONTROL'), skill.indexOf('7b. SCORE'));
    expect(step.indexOf('verify --dry-run')).toBeGreaterThan(-1);
    expect(step.indexOf('verify --dry-run')).toBeLessThan(step.indexOf('run-job.sh agent-dispatch'));
    expect(step).toContain('exactly ONCE');
  });

  it("the hand-back runner writes the marker into its run folder, after the queue", () => {
    const sh = execFileSync('cat', [resolve(ROOT, 'scripts/handback-poll-run.sh')], { encoding: 'utf8' });
    expect(sh.indexOf(': > "$RUNDIR/handback-only"')).toBeGreaterThan(sh.indexOf('cp "$QJSON" "$RUNDIR/queue.json"'));
  });
});
