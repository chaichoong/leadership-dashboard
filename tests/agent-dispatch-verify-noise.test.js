import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// 27 Sep 2026: agent-dispatch raised twelve failure alerts in one afternoon.
// Seven were "N eligible tasks and ZERO completed actions" from the half-hourly
// hand-back poll, which is TOLD to ignore new work while its worklist counts new
// work too, or which met a wall already on record. Five were draft reports the
// agent verified through the alarm wrapper, fixed, and verified again a minute
// later. An alarm channel that cries wolf twelve times a day gets ignored.
//
// The review then found five ways the first fix silenced real faults (a resting
// wall or an old parked flag hiding untouched work, a week-old wall excusing a new
// failure, a fake failure excusing a run, a first-met wall excused) and one it
// invited (deleting a failure to pass the self-check). Each has a test here.
//
// These drive the real cmd_verify with only the live reads stubbed: the task
// record, the ledger and the lesson check. Times are relative to now, written as
// {h:N} (N hours ago), so the tests hold on any day.
const J = (x) => `json.loads(${JSON.stringify(JSON.stringify(x))})`;

function verify({ report, queue = null, handbackOnly = false, tasks = {}, ledger = {}, dryRun = false, preAlerted = null, selfcheck = null, owedIds = null }) {
  const script = `
import importlib.util, json, os, re, sys, io, tempfile, types, contextlib
from datetime import datetime, timedelta, timezone
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = datetime.now(timezone.utc)
def ago(txt):
    return re.sub(r"\\{h:([0-9.]+)\\}", lambda g: (NOW - timedelta(hours=float(g.group(1)))).strftime("%Y-%m-%dT%H:%M:%S.000Z"), txt)
tmp = tempfile.mkdtemp()
m.STATE_DIR = tmp
rundir = os.path.join(tmp, 'run'); os.makedirs(rundir)
open(os.path.join(rundir, 'report.json'), 'w').write(ago(json.dumps(${J(report)})))
queue = ${J(queue)}
if queue is not None: open(os.path.join(rundir, 'queue.json'), 'w').write(ago(json.dumps(queue)))
if ${handbackOnly ? 'True' : 'False'}: open(os.path.join(rundir, m.HANDBACK_ONLY_MARK), 'w').close()
owed = ${J(owedIds)}
if owed is not None: open(os.path.join(rundir, m.OWED_IDS_MARK), 'w').write('\\n'.join(owed) + '\\n')
pre = ${J(preAlerted)}
if pre is not None: json.dump(pre, open(os.path.join(tmp, 'tier1-alerted.json'), 'w'))
sc = ${J(selfcheck)}
if sc is not None: json.dump(sc, open(os.path.join(rundir, m.SELFCHECK_FILE), 'w'))
tasks = ${J(tasks)}
def fake_get_task(tid):
    t = tasks.get(tid)
    if t is None: raise RuntimeError('no such task')
    return {"id": tid, "fields": {m.AF["notes"]: ago(t.get("notes", "")), m.AF["status"]: t.get("status", "Today")}}
m.get_task = fake_get_task
led = {k: (v[0], ago(v[1])) for k, v in ${J(ledger)}.items()}
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
seen = os.path.exists(os.path.join(rundir, m.SELFCHECK_FILE)) and json.load(open(os.path.join(rundir, m.SELFCHECK_FILE)))
print(json.dumps({"code": code, "out": out.getvalue(), "err": err.getvalue(), "alerted": alerted, "seen": seen}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

const COUNTS = (worklist) => ({ worklist, openTasksRead: 127 });
const WALL = (sinceH) => `[{h:1} — agent-dispatch] BLOCKER OPEN (TOOL Meta Business Suite new-case filing): no new-case entry point [since {h:${sinceH}}] [finding 20260925-agent-dispatch-621]`;
const Q = (...items) => ({ worklist: items.map(([id, kind]) => ({ id, kind })) });
const onWall = { task: 'recWALL', kind: 'carry_out', ok: false, error: 'still blocked: TOOL wall (finding 20260925-agent-dispatch-621, still open)' };

describe('owed work is checked task by task, from the queue the run was handed', () => {
  it('a hand-back poll with only new work, nothing done: green (14:33, 15:02, 16:33 on 27 Sep)', () => {
    const r = verify({ report: { startedAt: '{h:0.2}', queueCounts: COUNTS(2), actions: [] }, queue: Q(['recNEW1', 'new'], ['recNEW2', 'new']), handbackOnly: true });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
  });

  it('CONTROL: a hand-back it owed and never touched fails, by name', () => {
    const r = verify({ report: { queueCounts: COUNTS(3), actions: [] }, queue: Q(['recA', 'carry_out'], ['recNEW1', 'new'], ['recNEW2', 'new']), handbackOnly: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain('1 eligible tasks and ZERO attempted: recA');
  });

  it('a sign-in reopened item is owed even when its kind is new', () => {
    const r = verify({ report: { queueCounts: COUNTS(1), actions: [] }, queue: { worklist: [{ id: 'recS', kind: 'new', signinReopened: true }] }, handbackOnly: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain('ZERO attempted: recS');
  });

  it("the agent's own claim to be hand-back-only excuses nothing: only the runner's marker counts", () => {
    const r = verify({ report: { queueCounts: COUNTS(2), actions: [], handBackOnlyRun: true, newWorkIgnored: [{ task: 'recNEW1' }, { task: 'recNEW2' }] }, queue: Q(['recNEW1', 'new'], ['recNEW2', 'new']) });
    expect(r.code).toBe(1);
    expect(r.err).toContain('2 eligible tasks and ZERO attempted');
  });

  it('a hand-back run with no queue.json fails loudly rather than guessing', () => {
    const r = verify({ report: { queueCounts: COUNTS(1), actions: [] }, handbackOnly: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain('has no queue.json');
  });

  it("a run told to work only named tasks (roy-assistant, signin-pickup) owes exactly those, from the runner's owed-ids file", () => {
    const r = verify({ report: { queueCounts: COUNTS(3), actions: [{ task: 'recR', kind: 'new', ok: true }] }, queue: Q(['recR', 'new'], ['recX', 'carry_out'], ['recY', 'carry_out']), owedIds: ['recR'], tasks: { recR: { notes: '' } } });
    expect(r.err).not.toContain('ZERO');
  });

  it('review 28 Sep: an emptied owed-ids file is an error, never "owes nothing"', () => {
    const r = verify({ report: { queueCounts: COUNTS(2), actions: [] }, queue: Q(['recR', 'new'], ['recX', 'carry_out']), owedIds: [] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('owed-ids is empty');
  });

  it("CONTROL: a named task the run never touched still alarms, by name", () => {
    const r = verify({ report: { queueCounts: COUNTS(3), actions: [] }, queue: Q(['recR', 'new'], ['recX', 'carry_out']), owedIds: ['recR'] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('1 eligible tasks and ZERO attempted: recR');
  });

  it('review 1: a task resting on its wall does not hide another it never touched', () => {
    const r = verify({
      report: { startedAt: '{h:0.2}', queueCounts: COUNTS(2), actions: [onWall] },
      queue: Q(['recWALL', 'carry_out'], ['recA', 'carry_out']), handbackOnly: true,
      tasks: { recWALL: { notes: WALL(50) } }, ledger: { recWALL: ['parked', '{h:1}'] },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('1 eligible tasks and ZERO attempted: recA');
  });

  it('review 2: an already-alerted parked flag does not hide another task it never touched', () => {
    const r = verify({ report: { startedAt: '{h:0.2}', queueCounts: COUNTS(2), actions: [], parkedFlags: [{ id: 'recPAY', name: 'invoice' }] }, queue: Q(['recPAY', 'carry_out'], ['recA', 'carry_out']), preAlerted: ['recPAY'], tasks: { recPAY: { notes: WALL(50) } } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('1 eligible tasks and ZERO attempted: recA');
  });

  it('review: an id alerted long ago and not listed as parked again this run is still owed', () => {
    const r = verify({ report: { queueCounts: COUNTS(1), actions: [] }, queue: Q(['recOLD', 'carry_out']), preAlerted: ['recOLD'] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('ZERO attempted: recOLD');
  });

  it('a parked task alerted before and listed again this run is excused (it needs Kevin, not the agent)', () => {
    const r = verify({ report: { startedAt: '{h:0.2}', queueCounts: COUNTS(1), actions: [], parkedFlags: [{ id: 'recOLD', name: 'invoice' }] }, queue: Q(['recOLD', 'carry_out']), preAlerted: ['recOLD'], tasks: { recOLD: { notes: WALL(50) } } });
    expect(r.code).toBe(0);
  });

  it('review 28 Sep: a wall this run put back on a task Kevin had just cleared is not an old alert', () => {
    const r = verify({ report: { startedAt: '{h:0.5}', queueCounts: COUNTS(1), actions: [], parkedFlags: [{ id: 'recOLD', name: 'invoice' }] }, queue: Q(['recOLD', 'carry_out']), preAlerted: ['recOLD'], tasks: { recOLD: { notes: WALL(0.1) } } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('ZERO attempted: recOLD');
  });

  it('review: an old alert re-listed after Kevin cleared its wall (he paid) is owed again', () => {
    const r = verify({ report: { queueCounts: COUNTS(1), actions: [], parkedFlags: [{ id: 'recOLD', name: 'invoice' }] }, queue: Q(['recOLD', 'carry_out']), preAlerted: ['recOLD'], tasks: { recOLD: { notes: '' } } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('ZERO attempted: recOLD');
  });

  it('review 4: an action on a task outside the worklist excuses nothing', () => {
    const r = verify({ report: { queueCounts: COUNTS(2), actions: [{ task: 'recIDLE', kind: 'carry_out', ok: false, error: 'x' }] }, queue: Q(['recA', 'carry_out'], ['recB', 'new']), tasks: { recIDLE: { notes: '' } } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('2 eligible tasks and ZERO attempted');
  });

  it('a run that did some of its work and left the rest for the next tick is not silent (per task alarmed on 33 of 34 real runs)', () => {
    const r = verify({ report: { queueCounts: COUNTS(2), actions: [{ task: 'recA', kind: 'redo', ok: true }] }, queue: Q(['recA', 'redo'], ['recB', 'carry_out']), tasks: { recA: { notes: '' } } });
    expect(r.err).not.toContain('ZERO');
  });

  it('a run whose only owed task failed on a fresh fault is one alarm line, not two', () => {
    const r = verify({ report: { queueCounts: COUNTS(1), actions: [{ task: 'recX', kind: 'carry_out', ok: false, error: 'agent hung' }] }, queue: Q(['recX', 'carry_out']), tasks: { recX: { notes: '' } } });
    expect(r.err.match(/^ERROR:/gm).length).toBe(1);
    expect(r.err).toContain('action failed: carry_out recX');
  });
});

describe('a failure on a wall already on record rests on it; nothing else does', () => {
  const base = { report: { startedAt: '{h:0.2}', queueCounts: COUNTS(1), actions: [onWall] }, queue: Q(['recWALL', 'carry_out']), handbackOnly: true };

  it('wall recorded before the run, parked within the day: green and listed (the Meta dispute task, 19:00)', () => {
    const r = verify({ ...base, tasks: { recWALL: { notes: WALL(50) } }, ledger: { recWALL: ['parked', '{h:1}'] } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).restedOnWall).toEqual(['recWALL']);
    expect(r.err).toContain('INFO: recWALL met its recorded wall again');
  });

  it('review 3: a wall parked a week ago never excuses today\'s failure', () => {
    const r = verify({ ...base, tasks: { recWALL: { notes: WALL(170) } }, ledger: { recWALL: ['parked', '{h:168}'] } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('action failed: carry_out recWALL');
  });

  it('review 5: a wall met for the first time in this run still alarms once', () => {
    const r = verify({ ...base, tasks: { recWALL: { notes: WALL(0.1) } }, ledger: { recWALL: ['parked', '{h:0.1}'] } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('action failed: carry_out recWALL');
  });

  it("review: the run's start comes from the queue's own stamp, not the agent's startedAt (half are an hour late)", () => {
    const r = verify({
      report: { startedAt: '{h:0}', queueCounts: COUNTS(1), actions: [onWall] },
      queue: { generatedAt: '{h:1}', worklist: [{ id: 'recWALL', kind: 'carry_out' }] }, handbackOnly: true,
      tasks: { recWALL: { notes: WALL(0.5) } }, ledger: { recWALL: ['parked', '{h:0.5}'] },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('action failed: carry_out recWALL');
  });

  it('CONTROL: a failed action with no wall on record alarms', () => {
    const r = verify({ ...base, report: { ...base.report, actions: [{ ...onWall, error: 'agent hung' }] }, tasks: { recWALL: { notes: '' } }, ledger: { recWALL: ['intent', '{h:0.1}'] } });
    expect(r.code).toBe(1);
  });

  it('CONTROL: an open wall the ledger does not show as parked alarms', () => {
    const r = verify({ ...base, tasks: { recWALL: { notes: WALL(50) } }, ledger: { recWALL: ['intent', '{h:0.1}'] } });
    expect(r.code).toBe(1);
  });

  it('CONTROL: a task that cannot be re-read is never excused', () => {
    const r = verify({ ...base, ledger: { recWALL: ['parked', '{h:1}'] } });
    expect(r.code).toBe(1);
  });
});

describe('--dry-run is the self-check: same checks, no alarm spent, and nothing may be deleted after it', () => {
  const parked = { id: 'recPAY', name: 'INBOUND: invoice due 29/09' };

  it('a new parked task fails the dry run but is NOT marked as alerted, and the self-check remembers it', () => {
    const r = verify({ report: { queueCounts: COUNTS(1), actions: [], parkedFlags: [parked] }, queue: Q(['recPAY', 'carry_out']), dryRun: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain('approved task PARKED');
    expect(r.alerted).toBe(false);
    expect(r.seen).toEqual(['recPAY']);
  });

  it('CONTROL: the real control alarms once and records it', () => {
    const r = verify({ report: { queueCounts: COUNTS(1), actions: [], parkedFlags: [parked] }, queue: Q(['recPAY', 'carry_out']) });
    expect(r.code).toBe(1);
    expect(r.alerted).toEqual(['recPAY']);
  });

  it('review 6: a failure the self-check saw and the final report dropped alarms', () => {
    const r = verify({ report: { queueCounts: COUNTS(0), actions: [] }, queue: Q(), selfcheck: ['recX', 'recPAY'] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('removed from the report after the self-check saw them failed or parked: recPAY, recX');
  });

  it('a failure the self-check saw and the agent then fixed (now an ok action) is fine', () => {
    const r = verify({ report: { queueCounts: COUNTS(1), actions: [{ task: 'recX', kind: 'redo', ok: true }] }, queue: Q(['recX', 'redo']), selfcheck: ['recX'], tasks: { recX: { notes: '' } } });
    expect(r.err).not.toContain('removed from the report');
  });
});

describe('the prompts say it', () => {
  const skill = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/agent-dispatch/SKILL.md'), 'utf8');
  const step = skill.slice(skill.indexOf('7. CONTROL'), skill.indexOf('7b. SCORE'));

  it('the skill runs the self-check first and the wrapped control exactly once, last', () => {
    expect(step.indexOf('verify --dry-run')).toBeGreaterThan(-1);
    expect(step.indexOf('verify --dry-run')).toBeLessThan(step.indexOf('run-job.sh agent-dispatch'));
    expect(step).toContain('exactly ONCE');
  });

  it('the skill forbids deleting an action or a parked flag to pass', () => {
    expect(step).toContain('NEVER delete an action or a parked flag');
  });

  it('the named-task runners write owed-ids before the agent starts', () => {
    for (const f of ['scripts/roy-assistant-run.sh', 'scripts/signin-pickup-run.sh']) {
      const sh = readFileSync(resolve(ROOT, f), 'utf8');
      expect(sh.indexOf('> "$RUNDIR/owed-ids"'), f).toBeGreaterThan(-1);
      expect(sh.indexOf('> "$RUNDIR/owed-ids"'), f).toBeLessThan(sh.indexOf('"$CLAUDE" -p'));
    }
  });

  it('the hand-back runner writes the marker into its run folder, after the queue', () => {
    const sh = readFileSync(resolve(ROOT, 'scripts/handback-poll-run.sh'), 'utf8');
    expect(sh.indexOf(': > "$RUNDIR/handback-only"')).toBeGreaterThan(sh.indexOf('cp "$QJSON" "$RUNDIR/queue.json"'));
  });
});
