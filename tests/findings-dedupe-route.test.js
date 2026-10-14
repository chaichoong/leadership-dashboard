// One problem is one line on the Defects card, a matter no code can fix goes to a task, and the
// cap never throws a finding away unread (Kevin, 14 Oct 2026: "merge duplicates, move the non-code
// items to tasks, stop the overflow log").
//
// Measured that day on the live queue: 235 open, of which about a fifth were the same problem filed
// again (one insurer's sign-in window three times, the findings cap four times); 62 flagged as needing no code
// at all, which the code fixer can never close; and 89 from AI agents who all file under ONE routine
// name, so with a cap of 15 per routine every medium they filed went to an overflow log no number
// counted (245 lines). Every test drives the real scripts/findings.py (CLI, or its functions with the
// Airtable read replaced) and the real defect_counts in scripts/estate-status.py, on a scratch queue.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const FINDINGS = resolve(ROOT, 'scripts/findings.py');
const BOX = mkdtempSync(join(tmpdir(), 'findings-dedupe-'));
afterAll(() => rmSync(BOX, { recursive: true, force: true }));

let store; let overflow; let n = 0;
beforeEach(() => {
  store = join(BOX, `q${n}.jsonl`);
  overflow = join(BOX, `o${n}.jsonl`);
  n += 1;
});

function fnd(args, env = {}) {
  const r = spawnSync('python3', [FINDINGS, ...args], {
    env: { ...process.env, FINDINGS_FILE: store, FINDINGS_OVERFLOW_FILE: overflow, FINDINGS_AGENT: '', ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr, both: `${r.stdout}${r.stderr}` };
}

function add(title, where = '', { severity = 'medium', routine = 'agent-dispatch', code = true, agent, detail = '', fix = '' } = {}) {
  const args = ['add', '--routine', routine, '--title', title, '--where', where, '--severity', severity,
    '--detail', detail, '--fix', fix];
  if (code) args.push('--touches-code');
  if (agent !== undefined) args.push('--agent', agent);
  const r = fnd(args);
  return { ...r, id: r.out.trim() };
}

const listOpen = () => JSON.parse(fnd(['list', '--status', 'open', '--json']).out);
const state = () => JSON.parse(fnd(['list', '--json']).out);
const byId = (id) => state().find((r) => r.id === id);
const count = () => Number(fnd(['count']).out.trim());

// Python with the real module loaded against this test's scratch files; TASKS replaces the Airtable
// read so a "task" status is under the test's control (None = no such task).
function py(code, tasks = {}) {
  const script = `
import importlib.util, json, os, sys
os.environ["FINDINGS_FILE"] = ${JSON.stringify(store)}
os.environ["FINDINGS_OVERFLOW_FILE"] = ${JSON.stringify(overflow)}
spec = importlib.util.spec_from_file_location("fm", ${JSON.stringify(FINDINGS)})
fm = importlib.util.module_from_spec(spec); spec.loader.exec_module(fm)
TASKS = json.loads(${JSON.stringify(JSON.stringify(tasks))})
def fake(rec_id):
    if rec_id == "recBROKENREADxxxx": raise OSError("Airtable did not answer")
    return TASKS.get(rec_id)
fm.task_status = fake
${code}
`;
  const r = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (r.status !== 0 && !/SystemExit/.test(r.stderr)) throw new Error(r.stderr);
  return { out: r.stdout, err: r.stderr };
}

describe('a repeat is merged into the finding that survives it', () => {
  it('leaves every backlog count, keeps its words on the survivor, and writes one ledger line', () => {
    const a = add('Your turn carry-on stops on the insurer form, page 3', 'the robot\'s own setup', { severity: 'medium' });
    const b = add('Insurer window stuck: carry-on clicks a disabled Find address button', 'scripts/agent-browser.js carryOnPages',
      { severity: 'high', detail: 'the planner fill never blurs the box', fix: 'press Tab after a fill' });
    expect(count()).toBe(2);
    const r = fnd(['dupe', b.id, '--of', a.id, '--note', 'one window, one problem']);
    expect(r.code, r.err).toBe(0);
    expect(count()).toBe(1);
    expect(listOpen().map((x) => x.id)).toEqual([a.id]);
    const s = byId(a.id);
    expect(s.duplicates).toEqual([b.id]);
    expect(s.severity).toBe('high');                     // ratchets up, never down
    expect(s.seen).toBe(2);
    const ev = s.recurrences.find((x) => x.from === b.id);
    expect(ev.note).toMatch(/the planner fill never blurs the box/);
    expect(ev.note).toMatch(/scripts\/agent-browser\.js carryOnPages/);
    expect(ev.fix).toBe('press Tab after a fill');
    expect(byId(b.id).status).toBe('duplicate');
    const ledger = readFileSync(store, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger.filter((l) => l.op === 'dupe')).toEqual([expect.objectContaining({ id: b.id, of: a.id, note: 'one window, one problem' })]);
    expect(fnd(['list', '--status', 'open']).out).toMatch(/repeats merged in: .*-002/);
  });

  it('undupe takes it back: the repeat is open again and the survivor loses its words', () => {
    const a = add('first');
    const b = add('second report of the same thing');
    fnd(['dupe', b.id, '--of', a.id]);
    expect(fnd(['undupe', b.id, '--note', 'they were two problems']).code).toBe(0);
    expect(count()).toBe(2);
    expect(byId(b.id).status).toBe('open');
    expect(byId(a.id).duplicates).toBeUndefined();
    expect(byId(a.id).recurrences).toBeUndefined();
    expect(fnd(['undupe', b.id, '--note', 'again']).code).toBe(2);   // nothing left to take back
  });

  it('a repeat takes its survivor\'s final state, so a robot wall on the repeat wakes when the fix lands', () => {
    // agent-dispatch.py clears a TOOL wall only when ITS finding reads "fixed".
    const a = add('cap refuses agent findings', 'scripts/findings.py');
    const b = add('Agent blocked: findings queue cap', 'the robot\'s own setup', { severity: 'high' });
    fnd(['dupe', b.id, '--of', a.id]);
    fnd(['close', a.id, '--outcome', 'pending', '--pr', '900', '--note', 'fix in PR 900']);
    expect(byId(b.id).status).toBe('duplicate');           // pending is still owed: not open, not fixed
    expect(fnd(['land', '--pr', '900']).code).toBe(0);
    expect(byId(a.id).status).toBe('fixed');
    expect(byId(b.id).status).toBe('fixed');
    // ...and it is ONE fix, not two.
    expect(fnd(['count', '--breakdown']).out).toMatch(/^fixed\s+1$/m);
    expect(fnd(['count', '--breakdown']).out).toMatch(/^duplicate\s+1$/m);

    const c = add('another thing');
    const d = add('another thing, reworded');
    fnd(['dupe', d.id, '--of', c.id]);
    fnd(['close', c.id, '--outcome', 'rejected', '--note', 'could not reproduce']);
    expect(byId(d.id).status).toBe('rejected');
  });

  it('refuses two different code files, a closed survivor, a loop, itself and a merged repeat', () => {
    const a = add('gate folds unrelated matters', 'scripts/create-agent-task.py');
    const b = add('gate folds unrelated matters', 'scripts/agent-dispatch.py', { routine: 'other' });
    let r = fnd(['dupe', b.id, '--of', a.id]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Different files are different problems/);
    expect(fnd(['dupe', b.id, '--of', a.id, '--force']).code).toBe(0);   // a reader who read both may

    const c = add('c'); const d = add('d');
    expect(fnd(['dupe', c.id, '--of', c.id]).code).toBe(2);
    fnd(['dupe', d.id, '--of', c.id]);
    expect(fnd(['dupe', c.id, '--of', d.id]).err).toMatch(/loop/);
    expect(fnd(['dupe', d.id, '--of', a.id]).err).toMatch(/Only an open finding/);   // already merged

    const e = add('e'); const g = add('g');
    fnd(['close', e.id, '--outcome', 'rejected', '--note', 'not real']);
    expect(fnd(['dupe', g.id, '--of', e.id]).err).toMatch(/reopen that one/);
  });

  it('a new filing in a merged repeat\'s words lands on the survivor, not a third id', () => {
    const a = add('send-email.py notify refuses on a stale tier-1 word');
    const b = add('Agent blocked: send-email.py notify', '', { routine: 'task-manager-board' });
    fnd(['dupe', b.id, '--of', a.id]);
    const again = add('Agent blocked: send-email.py notify', '', { routine: 'task-manager-board' });
    expect(again.id).toBe(a.id);
    expect(again.err).toMatch(/RECURRENCE of/);
    expect(count()).toBe(1);
  });

  it('escalating a repeat raises its survivor (a wall\'s clock names the repeat)', () => {
    const a = add('one problem', '', { severity: 'low' });
    const b = add('the same problem', '', { severity: 'low' });
    fnd(['dupe', b.id, '--of', a.id]);
    const r = fnd(['escalate', b.id, '--severity', 'critical', '--why', 'robot blocked 4 days']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toEqual(expect.objectContaining({ id: a.id, severity: 'critical', changed: true }));
    expect(byId(a.id).severity).toBe('critical');
  });
});

describe('a matter no code fix can close goes to a task', () => {
  it('a not-code finding closes against the open task that carries it, and leaves the backlog', () => {
    const f = add('A house IS insured: the policy is not on the compliance book', '', { code: false });
    const out = py(`sys.exit(fm.main(["close", ${JSON.stringify(f.id)}, "--outcome", "tasked", "--task", "recTASKOPENxxxxxx", "--note", "the insurance task carries the policy"]))`,
      { recTASKOPENxxxxxx: 'Today' });
    expect(out.out).toMatch(/closed .* as tasked/);
    expect(count()).toBe(0);
    const s = byId(f.id);
    expect(s.status).toBe('tasked');
    expect(s.task).toBe('recTASKOPENxxxxxx');
  });

  it('refuses a Completed task, an id that is not a task, an unreadable board, and no id at all', () => {
    const f = add('a council tax matter', '', { code: false });
    const close = (task) => py(`
try:
    rc = fm.main(["close", ${JSON.stringify(f.id)}, "--outcome", "tasked", "--note", "x"] + (["--task", ${JSON.stringify(task)}] if ${JSON.stringify(task)} else []))
except SystemExit as e:
    rc = e.code
print("RC", rc)`, { recDONEDONEDONExx: 'Completed', recOPENOPENOPENxx: 'Today' });
    expect(close('recDONEDONEDONExx').err).toMatch(/is Completed/);
    expect(close('recNOTATASKATALLx').err).toMatch(/is not in the Tasks table/);
    expect(close('recBROKENREADxxxx').err).toMatch(/NOT CHECKED/);
    expect(close('').err).toMatch(/needs --task <rec id>/);
    expect(close('recDONEDONEDONExx').out).toMatch(/RC 2/);
    expect(count()).toBe(1);                              // nothing closed on any refusal
  });

  it('a deferral with a date comes back open by itself on that date', () => {
    const f = add('cold email delivery cannot be proved', 'js/prospecting.js');
    fnd(['close', f.id, '--outcome', 'deferred', '--until', '2027-01-04', '--note', 'Operations Director parked to January']);
    expect(fnd(['count'], { FINDINGS_TODAY: '2027-01-03' }).out.trim()).toBe('0');
    expect(fnd(['count'], { FINDINGS_TODAY: '2027-01-04' }).out.trim()).toBe('1');
    expect(fnd(['close', f.id, '--outcome', 'rejected', '--until', '2027-01-04', '--note', 'x']).err)
      .toMatch(/only goes with --outcome deferred/);
  });

  it('retag corrects the filer\'s guess, which is what the card splits on', () => {
    const f = add('merge gate keeps a 400-character tail', 'scripts/fixer-merge.py', { code: false });
    expect(byId(f.id).touches_code).toBe(false);
    expect(fnd(['retag', f.id, '--code']).err).toMatch(/needs --note/);
    expect(fnd(['retag', f.id, '--code', '--note', 'names a repo file']).code).toBe(0);
    expect(byId(f.id).touches_code).toBe(true);
  });
});

describe('the cap counts each filer, and never throws a finding away unread', () => {
  it('one agent at its cap does not gag another agent filing under the same routine', () => {
    for (let i = 0; i < 15; i += 1) add(`property admin noise ${i}`, `p${i}.js`, { agent: 'Property Administration' });
    const over = add('one too many', 'z.js', { agent: 'property-administration' });   // the same agent, spelt differently
    expect(over.code).toBe(2);
    expect(over.err).toMatch(/REFUSED: agent-dispatch \/ property-administration already has 15/);
    expect(add('a creditor fault', 'c.js', { agent: 'Creditor Management' }).code).toBe(0);
    expect(add('an unnamed filing', 'u.js').code).toBe(0);                              // the unnamed pool is its own
    const viaEnv = fnd(['add', '--routine', 'agent-dispatch', '--title', 'by env', '--severity', 'low'],
      { FINDINGS_AGENT: 'Cash Flow Voids' });
    expect(viaEnv.code).toBe(0);
    expect(byId(viaEnv.out.trim()).agent).toBe('Cash Flow Voids');
  });

  it('an unnamed filer at the cap is told to name itself, and the refusal carries a reference', () => {
    for (let i = 0; i < 15; i += 1) add(`noise ${i}`, `f${i}.js`);
    const over = add('refused one', 'z.js');
    expect(over.code).toBe(2);
    expect(over.err).toMatch(/--agent "<your name>"/);
    expect(over.err).toMatch(/as ofl-[0-9a-f]{10}/);
    expect(over.err).toMatch(/refused and unread/);
  });

  it('a refusal is counted until someone sorts it: promote files it, dismiss needs a reason', () => {
    for (let i = 0; i < 15; i += 1) add(`noise ${i}`, `f${i}.js`);
    const r1 = add('a real bug the cap refused', 'k.js');
    const r2 = add('a note nobody needs', 'm.js');
    const ref1 = r1.err.match(/ofl-[0-9a-f]{10}/)[0];
    const ref2 = r2.err.match(/ofl-[0-9a-f]{10}/)[0];
    expect(fnd(['count', '--breakdown']).out).toMatch(/^REFUSED\s+2$/m);
    expect(fnd(['overflow', 'promote', ref1]).code).toBe(0);
    expect(listOpen().some((x) => x.title === 'a real bug the cap refused')).toBe(true);
    expect(fnd(['overflow', 'dismiss', ref2]).err).toMatch(/needs --note/);
    expect(fnd(['overflow', 'dismiss', ref2, '--note', 'one-off, gone']).code).toBe(0);
    expect(fnd(['count', '--breakdown']).out).toMatch(/^REFUSED\s+0$/m);
    expect(fnd(['overflow', 'promote', ref1]).err).toMatch(/already sorted/);
  });

  it('sort folds a refusal that repeats an open finding into it, and leaves a new one unread', () => {
    for (let i = 0; i < 15; i += 1) add(`noise ${i}`, `f${i}.js`);
    // The same agent re-filing "noise 3" at medium is a recurrence, never refused; a refused row
    // written before the dedupe could see its match (or by an older script) is what sort is for.
    writeFileSync(overflow, `${[
      { op: 'overflow', ts: '2026-10-01T00:00:00Z', routine: 'agent-dispatch', severity: 'medium', title: 'noise 3', where: 'f3.js', detail: 'seen again', proposed_fix: 'do it' },
      { op: 'overflow', ts: '2026-10-02T00:00:00Z', routine: 'agent-dispatch', severity: 'low', title: 'brand new problem', where: 'q.js' },
    ].map((r) => JSON.stringify(r)).join('\n')}\n`);
    const dry = JSON.parse(fnd(['overflow', 'sort']).out);
    expect(dry).toEqual({ unread: 2, recurrence: 1, repeatsClosed: 0, new: 1, applied: false });
    expect(fnd(['count', '--breakdown']).out).toMatch(/^REFUSED\s+2$/m);     // a dry run reads nothing
    const done = JSON.parse(fnd(['overflow', 'sort', '--apply']).out);
    expect(done.applied).toBe(true);
    expect(fnd(['count', '--breakdown']).out).toMatch(/^REFUSED\s+1$/m);
    const target = listOpen().find((x) => x.title === 'noise 3');
    expect(target.seen).toBe(2);
    expect(target.recurrences[0].note).toMatch(/From the overflow log/);
  });
});

describe('the Defects card counts what the queue is', () => {
  it('defect_counts: each problem once, code and not code, repeats left out of filed and fixed, refusals counted', () => {
    const out = py(`
from datetime import datetime, timedelta, timezone
spec2 = importlib.util.spec_from_file_location("es", ${JSON.stringify(resolve(ROOT, 'scripts/estate-status.py'))})
es = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(es)
NOW = datetime(2026, 10, 14, 18, 0, tzinfo=timezone.utc)
iso = lambda dt: dt.strftime("%Y-%m-%dT%H:%M:%SZ")
d1 = iso(NOW - timedelta(days=1))
state = {
  "a": {"status": "open", "touches_code": True, "ts": d1},
  "b": {"status": "duplicate", "duplicate_root": "a", "touches_code": True, "ts": d1},
  "c": {"status": "open", "touches_code": False, "ts": d1},
  "d": {"status": "pending", "touches_code": True, "ts": iso(NOW - timedelta(days=20))},
  "e": {"status": "fixed", "ts": d1, "landed_at": d1},
  "f": {"status": "fixed", "duplicate_root": "e", "ts": d1},
  "g": {"status": "tasked", "ts": iso(NOW - timedelta(days=20)), "closed_at": d1},
}
overflow = [{"ts": d1, "read": None}, {"ts": iso(NOW - timedelta(days=30)), "read": None},
            {"ts": d1, "read": {"outcome": "dismissed"}}]
print(json.dumps(es.defect_counts(state, NOW, (), overflow)))
print(json.dumps(es.defect_counts(state, NOW)))`);
    const [withOverflow, without] = out.out.trim().split('\n').map((l) => JSON.parse(l));
    expect(withOverflow).toEqual({ open: 3, code: 2, notCode: 1, filed7d: 3, fixed7d: 1, repeats: 2,
      toTasks7d: 1, refusedUnread: 2, refused7d: 2 });
    expect(without.refusedUnread).toBeUndefined();          // never a zero for a log nobody read
  });

  it('a cache written before the new shape is not served after the change ships', () => {
    const out = py(`
import tempfile
from datetime import datetime, timezone
spec2 = importlib.util.spec_from_file_location("es", ${JSON.stringify(resolve(ROOT, 'scripts/estate-status.py'))})
es = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(es)
NOW = datetime(2026, 10, 14, 18, 0, tzinfo=timezone.utc)
cache = os.path.join(tempfile.mkdtemp(), "c.json")
json.dump({"computedAt": "2026-10-14T17:50:00.000Z", "defects": {"open": 235, "filed7d": 94, "fixed7d": 46},
           "rework": {"days": 14}}, open(cache, "w"))
calls = []
def measure(now):
    calls.append(1)
    return {"open": 167, "code": 129, "notCode": 38, "filed7d": 86, "fixed7d": 46}, {"days": 14}
d, _, _ = es._cached_measures(NOW, cache=cache, measure=measure)
d2, _, _ = es._cached_measures(NOW, cache=cache, measure=measure)
print(json.dumps({"open": d["open"], "again": d2["open"], "calls": len(calls)}))`);
    expect(JSON.parse(out.out)).toEqual({ open: 167, again: 167, calls: 1 });
  });
});
