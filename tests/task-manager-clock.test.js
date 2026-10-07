// The Task Board Manager's clock (Kevin, 7 Oct 2026): "a wall past its clock is stuck, and the
// move is the conversion that clears it, never leave". Measured 23 Sep to 6 Oct 2026: 1,346 board
// moves, 1,020 of them "leave"; 39 tasks on walls, 24 of them three days or more and 24 never
// touched; the skill never said BLOCKER and task-manager.py had no wall logic.
//
// These drive the REAL run_clock (scripts/task-manager.py) with agent-dispatch.py's real
// task_blocker and reroute-roy-admin.py's real classify and new_fields. Only the network is
// replaced: clock_get / clock_patch read and write an in-memory task store, and clock_run records
// the findings.py and send-email.py calls. Each rule is back-tested by breaking it (see the PR).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TM = JSON.stringify(path.join(root, 'scripts/task-manager.py'));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const NOW = '2026-10-07T09:20:00+00:00';
const ROY = 'reclbdjfVev3bqNHS';
const AGENT = 'recAGENT000000001';
const TF = { name: 'fldgFjGBw6bTKJFCD', status: 'fldx4qCw17UfrKpaN', notes: 'fldR7apBzSp3oxFxz',
  due: 'fld7XP8w8kbxfETV4', hard: 'fldZKzIxgyrQ8CG8a', team: 'flduCtmQGpOA4eWaj', assignee: 'fldELMncVJYPDRJNc',
  maintenance: 'fldSEUvVA98as1HW6' };

// A wall line exactly as agent-dispatch.py block writes it.
const wall = (kind, subject, since, extra = '') =>
  `[01 Oct 2026 12:00 — agent] BLOCKER OPEN (${kind} ${subject}): the robot met it.${extra} Fix: something.${since ? ` [since ${since}]` : ''}`;
const daysAgo = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString().replace(/\.\d{3}Z$/, '.000Z');

// rec: {id, fields (name-keyed, the clock's bulk read)}; live: field-id-keyed (the fresh read).
function task(id, f) {
  return { id, fields: { 'Task Name': f.name || id, 'Status': f.status || 'Today', 'Notes': f.notes || '',
    'Created Time': f.created || daysAgo(30), ...(f.extra || {}) } };
}
function liveOf(t) {
  const f = t.fields;
  return { [TF.name]: f['Task Name'], [TF.status]: f['Status'], [TF.notes]: f['Notes'],
    [TF.due]: f['Due Date'] || null, [TF.hard]: f['Hard Deadline'] || false, [TF.team]: f['Team Member'] || [],
    [TF.maintenance]: f['Maintenance Ticket'] || false };
}

function clock({ walls = [], tasks = [], live = {}, runs = {}, apply = true, findingsError = '' }) {
  const input = { walls: { openTasksRead: 1, open: walls, findingsError }, recs: tasks,
    live: Object.fromEntries(tasks.map((t) => [t.id, { ...liveOf(t), ...(live[t.id] || {}) }])),
    runs, apply, now: NOW };
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
from datetime import datetime
spec = importlib.util.spec_from_file_location("tm", ${TM})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = json.loads(sys.stdin.read())
store, patches, calls = a["live"], [], []
def get(tid):
    return dict(store[tid])
def patch(tid, fields):
    patches.append({"task": tid, "fields": fields}); store[tid].update(fields)
def run(cmd):
    calls.append(cmd[2:])
    tool = cmd[1].rsplit("/", 1)[-1]
    rc, out = a["runs"].get(tool, [0, "{}"])
    return rc, out, "" if rc == 0 else out
m.clock_get, m.clock_patch, m.clock_run = get, patch, run
d = m._load_dispatch()
res = m.run_clock(a["walls"], a["recs"], datetime.fromisoformat(a["now"]), set(), d, apply=a["apply"])
print("---JSON---"); print(json.dumps({"res": res, "patches": patches, "calls": calls, "md": m.clock_markdown(res)}))
`], { input: JSON.stringify(input), encoding: 'utf8' });
  return JSON.parse(out.split('---JSON---')[1]);
}
const dec = (r, id) => r.res.decisions.find((x) => x.task === id);

const yourStep = (id, since, extra = {}) => task(id, {
  name: 'INSURANCE: cover via TopCashback', status: 'Approval', notes: wall('KEVIN', 'purchase', since),
  extra: { 'Sent For Approval By': [AGENT], 'Team Member': [AGENT], 'Approval Outcome': 'Approved as-is',
    'Agent Output': "YOUR STEP: 1. Buy the cover.\n\n----- The agent's work, as you approved it -----\n\nThe draft.", ...extra } });
const kevinRow = (id, subject = 'purchase') => ({ task: id, kind: 'KEVIN', subject });

describe('KEVIN walls: past 3 days, the card in his lane gets the Hard Deadline tick, once', () => {
  it('ticks Hard Deadline, sets a blank due date to the far edge of the brief\'s week and writes the marker, in one write', () => {
    const r = clock({ walls: [kevinRow('recK1')], tasks: [yourStep('recK1', daysAgo(4))] });
    expect(r.patches).toHaveLength(1);
    const f = r.patches[0].fields;
    expect(f[TF.hard]).toBe(true);
    expect(f[TF.due]).toBe('2026-10-14');
    expect(f[TF.notes]).toMatch(/CLOCK \(KEVIN wall since .*\): past its 3-day clock/);
    expect(dec(r, 'recK1').done).toMatch(/Hard Deadline ticked/);
  });
  it('a task moved last slot is not moved again (the marker and the tick are on it)', () => {
    const first = clock({ walls: [kevinRow('recK1')], tasks: [yourStep('recK1', daysAgo(4))] });
    const notes = first.patches[0].fields[TF.notes];
    const again = clock({ walls: [kevinRow('recK1')],
      tasks: [yourStep('recK1', daysAgo(4), {})].map((t) => ({ ...t, fields: { ...t.fields, Notes: notes, 'Hard Deadline': true,
        'Due Date': first.patches[0].fields[TF.due] } })) });
    expect(again.patches).toHaveLength(0);
    expect(dec(again, 'recK1').already).toBe(true);
  });
  it('a tick Kevin took off by hand is never put back for the same wall', () => {
    const first = clock({ walls: [kevinRow('recK1')], tasks: [yourStep('recK1', daysAgo(4))] });
    const notes = first.patches[0].fields[TF.notes];
    const again = clock({ walls: [kevinRow('recK1')],
      tasks: [yourStep('recK1', daysAgo(4))].map((t) => ({ ...t, fields: { ...t.fields, Notes: notes } })) });
    expect(again.patches).toHaveLength(0);
    expect(dec(again, 'recK1').why).toMatch(/taken off since/);
  });
  it('inside the clock: nothing', () => {
    const r = clock({ walls: [kevinRow('recK2')], tasks: [yourStep('recK2', daysAgo(2))] });
    expect(r.patches).toHaveLength(0);
    expect(dec(r, 'recK2').past).toBe(false);
  });
  it('a card still waiting on his verdict is in his lane too', () => {
    const t = yourStep('recK3', daysAgo(5), { 'Approval Outcome': null, 'Agent Output': 'The draft.' });
    const r = clock({ walls: [kevinRow('recK3')], tasks: [t] });
    expect(r.patches).toHaveLength(1);
  });
  it('approved but not yet a Your step card: no write, and the report says the sweep moves it', () => {
    const t = yourStep('recK4', daysAgo(5), { Status: 'Today', 'Agent Output': 'The draft.' });
    const r = clock({ walls: [kevinRow('recK4')], tasks: [t] });
    expect(r.patches).toHaveLength(0);
    expect(dec(r, 'recK4').why).toMatch(/no one-task conversion/);
    expect(r.md).toMatch(/KEVIN walls \(3-day clock\): 1 judged, 1 past the clock: 0 done, 0 already done, 1 not done/);
  });
  it('not approved and not in his lane: no write, and the report says it has no door', () => {
    const t = yourStep('recK5', daysAgo(5), { Status: 'Today', 'Approval Outcome': null, 'Agent Output': '' });
    const r = clock({ walls: [kevinRow('recK5')], tasks: [t] });
    expect(r.patches).toHaveLength(0);
    expect(dec(r, 'recK5').why).toMatch(/no door/);
  });
  it('a far due date is brought inside the brief\'s week; a near one is left alone', () => {
    const far = yourStep('recK6', daysAgo(4), { 'Due Date': '2026-12-01' });
    const near = yourStep('recK7', daysAgo(4), { 'Due Date': '2026-10-09' });
    const r = clock({ walls: [kevinRow('recK6'), kevinRow('recK7')], tasks: [far, near],
      live: { recK6: { [TF.due]: '2026-12-01' }, recK7: { [TF.due]: '2026-10-09' } } });
    const by = Object.fromEntries(r.patches.map((p) => [p.task, p.fields]));
    expect(by.recK6[TF.due]).toBe('2026-10-14');
    expect(by.recK7[TF.due]).toBeUndefined();
  });
  it('a soft date already past or today goes to the week\'s edge, behind real deadlines, never "due today"', () => {
    const past = yourStep('recK8', daysAgo(4), { 'Due Date': '2026-09-30' });
    const r = clock({ walls: [kevinRow('recK8')], tasks: [past], live: { recK8: { [TF.due]: '2026-09-30' } } });
    expect(r.patches[0].fields[TF.due]).toBe('2026-10-14');
    expect(r.patches[0].fields[TF.notes]).toMatch(/Hard Deadline is ticked \(due 2026-10-14\)/);
  });
  it('a real deadline someone else ticked, too far out for the brief, is reported, never counted done or re-dated', () => {
    const t = yourStep('recK9', daysAgo(4), { 'Hard Deadline': true, 'Due Date': '2026-12-01' });
    const r = clock({ walls: [kevinRow('recK9')], tasks: [t] });
    expect(r.patches).toHaveLength(0);
    expect(dec(r, 'recK9').already).toBeUndefined();
    expect(dec(r, 'recK9').why).toMatch(/brief cannot show it yet/);
  });
  it('a task parked on purpose is never ticked: Some Day, or Upcoming with its date ahead (a hold, his own date)', () => {
    const someDay = yourStep('recP1', daysAgo(5), { 'Some Day': true });
    const held = yourStep('recP2', daysAgo(5), { Status: 'Upcoming', 'Due Date': '2026-11-01' });
    const r = clock({ walls: [kevinRow('recP1'), { task: 'recP2', kind: 'KEVIN', subject: 'purchase' }], tasks: [someDay, held] });
    expect(r.patches).toHaveLength(0);
    expect(dec(r, 'recP1').why).toMatch(/parked on purpose/);
  });
});

describe('the clock takes its own tick off when the wall clears', () => {
  const ticked = (id, f = {}) => {
    const first = clock({ walls: [kevinRow(id)], tasks: [yourStep(id, daysAgo(4))] });
    const p = first.patches[0].fields;
    const cleared = '\n\n[07 Oct 2026 08:00 — Kevin] BLOCKER CLEARED (KEVIN purchase): done. Carry on.';
    return task(id, { name: 'INSURANCE: cover', status: 'Today', notes: p[TF.notes] + (f.open ? '' : cleared),
      extra: { 'Team Member': [AGENT], 'Hard Deadline': true, 'Due Date': f.due || p[TF.due] } });
  };
  it('wall cleared, date as the clock set it: the tick comes off with a note', () => {
    const t = ticked('recU1');
    const r = clock({ tasks: [t] });
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0].fields[TF.hard]).toBe(false);
    expect(r.patches[0].fields[TF.notes]).toMatch(/CLOCK UNTICK \(CLOCK \(KEVIN wall since .*\)\): the wall cleared/);
    expect(r.md).toMatch(/Clock ticks taken off/);
  });
  it('the wall still stands: the tick stays', () => {
    const t = ticked('recU2', { open: true });
    expect(clock({ walls: [kevinRow('recU2')], tasks: [t] }).patches).toHaveLength(0);
  });
  it('someone moved the date (a real deadline now): the tick is theirs and stays', () => {
    const t = ticked('recU3', { due: '2026-10-20' });
    expect(clock({ tasks: [t] }).patches).toHaveLength(0);
  });
  it('the next slot after the untick: nothing more', () => {
    const t = ticked('recU4');
    const first = clock({ tasks: [t] });
    const after = { ...t, fields: { ...t.fields, Notes: first.patches[0].fields[TF.notes], 'Hard Deadline': true } };
    expect(clock({ tasks: [after] }).patches).toHaveLength(0);
  });
});

describe('a wall with no [since] is still dated, never silently fresh', () => {
  it('dates it from its own BLOCKER OPEN line (01 Oct 12:00 London: 6 days)', () => {
    const r = clock({ walls: [kevinRow('recS1')], tasks: [yourStep('recS1', '')] });
    expect(dec(r, 'recS1').days).toBeGreaterThan(5.5);
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0].fields[TF.notes]).toMatch(/CLOCK \(KEVIN wall since line 2026-10-01T11:00Z\)/);
  });
  it('a line with no readable stamp is treated as past its clock, and says undated', () => {
    const t = yourStep('recS2', '');
    t.fields.Notes = t.fields.Notes.replace('[01 Oct 2026 12:00 — agent]', '[sometime — agent]');
    const r = clock({ walls: [kevinRow('recS2')], tasks: [t] });
    expect(dec(r, 'recS2').undated).toBe(true);
    expect(r.patches).toHaveLength(1);
    expect(r.md).toMatch(/undated/);
  });
});

describe('a wall that changes under the clock is left for the next slot', () => {
  it('the fresh read shows a newer wall: no write', () => {
    const t = yourStep('recM1', daysAgo(4));
    const r = clock({ walls: [kevinRow('recM1')], tasks: [t],
      live: { recM1: { [TF.notes]: wall('KEVIN', 'purchase', daysAgo(0.1)) } } });
    expect(r.patches).toHaveLength(0);
    expect(dec(r, 'recM1').why).toMatch(/wall changed/);
  });
  it('the blocker read and the task read disagree on the kind: no write', () => {
    const r = clock({ walls: [{ task: 'recM2', kind: 'TOOL', subject: 'node' }], tasks: [yourStep('recM2', daysAgo(4))] });
    expect(r.patches).toHaveLength(0);
    expect(r.calls).toHaveLength(0);
  });
});

describe('SIGN-IN walls: past 1 day, Hard Deadline once', () => {
  const signin = (id, since) => task(id, { name: 'Pay the council tax online', notes: wall('SIGN-IN', 'example.gov.uk', since),
    extra: { 'Team Member': [AGENT] } });
  it('ticks after a day and a half', () => {
    const r = clock({ walls: [{ task: 'recG1', kind: 'SIGN-IN', subject: 'example.gov.uk' }], tasks: [signin('recG1', daysAgo(1.5))] });
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0].fields[TF.hard]).toBe(true);
  });
  it('not inside the day', () => {
    const r = clock({ walls: [{ task: 'recG2', kind: 'SIGN-IN', subject: 'example.gov.uk' }], tasks: [signin('recG2', daysAgo(0.5))] });
    expect(r.patches).toHaveLength(0);
  });
  it('a SITE wall has no clock and is never moved', () => {
    const t = task('recG3', { notes: wall('SITE', 'example.com', daysAgo(9)) });
    const r = clock({ walls: [{ task: 'recG3', kind: 'SITE', subject: 'example.com' }], tasks: [t] });
    expect(r.patches).toHaveLength(0);
    expect(dec(r, 'recG3').why).toMatch(/no clock/);
  });
});

describe('TOOL walls: past 3 days with the finding unclaimed, the finding goes critical', () => {
  const tool = (id, since) => task(id, { name: 'Fix the uploader', notes: wall('TOOL', 'uploader', since, ' [finding 20261001-agent-dispatch-700]'),
    extra: { 'Team Member': [AGENT] } });
  const row = (id, findingStatus) => ({ task: id, kind: 'TOOL', subject: 'uploader', finding: '20261001-agent-dispatch-700', findingStatus, tool: 'no fixer has taken it in 4 days' });
  it('raises the finding to critical and notes it on the task once', () => {
    const r = clock({ walls: [row('recT1', 'open')], tasks: [tool('recT1', daysAgo(4))],
      runs: { 'findings.py': [0, '{"id": "20261001-agent-dispatch-700", "severity": "critical", "changed": true}'] } });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].slice(0, 4)).toEqual(['escalate', '20261001-agent-dispatch-700', '--severity', 'critical']);
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0].fields[TF.notes]).toMatch(/raised to critical/);
    expect(r.patches[0].fields[TF.hard]).toBeUndefined();
  });
  it('the next slot: already critical and noted, so nothing is written', () => {
    const first = clock({ walls: [row('recT1', 'open')], tasks: [tool('recT1', daysAgo(4))],
      runs: { 'findings.py': [0, '{"changed": true}'] } });
    const t = tool('recT1', daysAgo(4));
    t.fields.Notes = first.patches[0].fields[TF.notes];
    const again = clock({ walls: [row('recT1', 'open')], tasks: [t], runs: { 'findings.py': [0, '{"changed": false}'] } });
    expect(again.patches).toHaveLength(0);
    expect(dec(again, 'recT1').already).toBe(true);
  });
  it('a claimed finding is the fixer\'s: no call, and the report says so', () => {
    const r = clock({ walls: [row('recT2', 'claimed')], tasks: [tool('recT2', daysAgo(5))] });
    expect(r.calls).toHaveLength(0);
    expect(dec(r, 'recT2').why).toMatch(/claimed/);
  });
  it('a wall with no finding cannot be raised, and says why', () => {
    const t = task('recT3', { notes: wall('TOOL', 'uploader', daysAgo(5)) });
    const r = clock({ walls: [{ task: 'recT3', kind: 'TOOL', subject: 'uploader', finding: '', findingStatus: '' }], tasks: [t] });
    expect(r.calls).toHaveLength(0);
    expect(dec(r, 'recT3').why).toMatch(/no finding is named/);
  });
  it('a findings queue that could not be read is said, never read as "not in the queue"', () => {
    const r = clock({ walls: [row('recT4', '')], tasks: [tool('recT4', daysAgo(5))], findingsError: 'disk gone' });
    expect(dec(r, 'recT4').why).toMatch(/could not be read: disk gone/);
  });
  it('a failed escalate is a failed move, in clock.json and the report', () => {
    const r = clock({ walls: [row('recT5', 'open')], tasks: [tool('recT5', daysAgo(4))], runs: { 'findings.py': [1, 'Traceback: boom'] } });
    expect(dec(r, 'recT5').failed).toMatch(/exited 1/);
    expect(r.res.summary.TOOL.failed).toBe(1);
  });
});

describe('Roy hand-offs: 7 days with no movement', () => {
  const roy = (id, name, f = {}) => task(id, { name, notes: f.notes || '[20 Sep 2026 — agent-dispatch] Handed over to Roy Lavin (roy.lavin1978@gmail.com): x',
    created: f.created, extra: { 'Team Member': [ROY], ...(f.extra || {}) } });
  const ok = [0, '{"notified": "x", "to": "info@agilelets.co.uk"}'];

  it('admin moves to its agent with reroute-roy-admin.py\'s own write, and is read back', () => {
    const r = clock({ tasks: [roy('recR1', 'Chase the council about the licence renewal')] });
    expect(r.patches).toHaveLength(1);
    const f = r.patches[0].fields;
    expect(f[TF.team]).not.toContain(ROY);
    expect(f[TF.notes]).toMatch(/Admin moved to the agent under the 5 Oct 2026 ruling/);
    expect(dec(r, 'recR1').done).toMatch(/moved to Property Administration/);
    expect(r.calls).toHaveLength(0);
  });
  it('a physical step gets one reminder (notify, again after 7 days) and the marker', () => {
    const r = clock({ tasks: [roy('recR2', 'Visit 6 Example Road to photograph the meter')], runs: { 'send-email.py': ok } });
    expect(r.calls).toHaveLength(1);
    const c = r.calls[0];
    expect(c.slice(0, 2)).toEqual(['notify', 'recR2']);
    expect(c).toContain('--again-after-days');
    expect(c[c.indexOf('--to') + 1]).toBe('roy.lavin1978@gmail.com');
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0].fields[TF.notes]).toMatch(/CLOCK ROY: emailed Roy a reminder/);
  });
  it('reminded inside the week: no second email', () => {
    const t = roy('recR3', 'Visit 6 Example Road to photograph the meter', {
      notes: '[20 Sep 2026 — agent-dispatch] Handed over to Roy Lavin (x): y\n\n[05 Oct 2026 — task-manager clock] CLOCK ROY: emailed Roy a reminder' });
    const r = clock({ tasks: [t], runs: { 'send-email.py': ok } });
    expect(r.calls).toHaveLength(0);
    expect(dec(r, 'recR3').why).toMatch(/reminded on 05 Oct/);
  });
  it('a notify the ledger skips is not done, and no marker is written', () => {
    const r = clock({ tasks: [roy('recR4', 'Visit 6 Example Road to photograph the meter')],
      runs: { 'send-email.py': [0, '{"skipped": "recR4", "why": "already emailed at 2026-10-02"}'] } });
    expect(r.patches).toHaveLength(0);
    expect(dec(r, 'recR4').why).toMatch(/not emailed: already emailed/);
  });
  it('Roy wrote on it this week (his page): not past the clock', () => {
    const t = roy('recR5', 'Visit 6 Example Road', { notes: '[20 Sep 2026 — agent-dispatch] Handed over to Roy Lavin (x): y\n[2026-10-05 14:03 Roy Lavin] booked for Friday' });
    const r = clock({ tasks: [t] });
    expect(dec(r, 'recR5').past).toBe(false);
  });
  it('Notes but no movement stamp at all: Created Time is the floor, so an old task is past', () => {
    const t = roy('recR6', 'Visit 6 Example Road', { notes: 'free text, no stamp', created: daysAgo(12) });
    const r = clock({ tasks: [t], runs: { 'send-email.py': ok } });
    expect(dec(r, 'recR6').past).toBe(true);
    expect(dec(r, 'recR6').days).toBe(12);
  });
  it('no stamp of any kind: past the clock, undated, never hidden', () => {
    const t = roy('recR7', 'Visit 6 Example Road', { notes: 'free text' });
    delete t.fields['Created Time'];
    const r = clock({ tasks: [t], runs: { 'send-email.py': ok } });
    expect(dec(r, 'recR7').undated).toBe(true);
    expect(r.calls).toHaveLength(1);
  });
  it('a Roy task on a wall is the wall\'s: one move per task per slot', () => {
    const t = roy('recR8', 'Visit 6 Example Road', { notes: wall('SIGN-IN', 'example.gov.uk', daysAgo(2)) });
    const r = clock({ walls: [{ task: 'recR8', kind: 'SIGN-IN', subject: 'example.gov.uk' }], tasks: [t], runs: { 'send-email.py': ok } });
    expect(r.res.decisions.filter((x) => x.task === 'recR8').map((x) => x.kind)).toEqual(['SIGN-IN']);
    expect(r.calls).toHaveLength(0);
  });
  it('at most three reminders a slot, oldest first', () => {
    const many = Array.from({ length: 12 }, (_, i) => roy(`recRC${String(i).padStart(2, '0')}`, 'Visit 6 Example Road',
      { notes: 'x', created: daysAgo(8 + i) }));
    const r = clock({ tasks: many, runs: { 'send-email.py': ok } });
    expect(r.calls.map((c) => c[1])).toEqual(['recRC11', 'recRC10', 'recRC09']);
    const capped = r.res.decisions.filter((x) => /cap of 3 reminders/.test(x.why || '')).map((x) => x.task);
    expect(capped).toEqual(['recRC08', 'recRC07', 'recRC06', 'recRC05', 'recRC04', 'recRC03', 'recRC02', 'recRC01', 'recRC00']);
  });
  it('his emailed reply, folded into the task by the create gate, is movement: no reminder after it', () => {
    const t = roy('recRF', 'Visit 6 Example Road to photograph the meter', {
      extra: { Description: 'Visit.\n\nUPDATE 2026-10-05: new item folded in by the duplicate gate (one subject = one open task).\nRoy: booked Friday.' } });
    const r = clock({ tasks: [t], runs: { 'send-email.py': ok } });
    expect(dec(r, 'recRF').past).toBe(false);
    expect(r.calls).toHaveLength(0);
  });
  it('a repair-lane name the reroute script says to check first is never moved unattended: Roy gets the reminder', () => {
    const r = clock({ tasks: [roy('recRL', 'MAINTENANCE: paperwork for Example Road')], runs: { 'send-email.py': ok } });
    expect(r.calls).toHaveLength(1);
    expect(r.patches.every((p) => !(TF.team in p.fields))).toBe(true);
  });
  it('a parked Roy task (dated forward, or Some Day) is never chased or moved', () => {
    const fwd = roy('recRP', 'Visit 6 Example Road', { extra: { Status: 'Upcoming', 'Due Date': '2026-11-01' } });
    const sd = roy('recRS', 'Chase the council about the licence renewal', { extra: { 'Some Day': true } });
    const r = clock({ tasks: [fwd, sd], runs: { 'send-email.py': ok } });
    expect(r.res.royHeld).toBe(0);
    expect(r.patches).toHaveLength(0);
  });
  it('refused or skipped reminders use no place in the cap', () => {
    const many = Array.from({ length: 12 }, (_, i) => roy(`recRK${String(i).padStart(2, '0')}`, 'Visit 6 Example Road',
      { notes: 'x', created: daysAgo(8 + i) }));
    const r = clock({ tasks: many, runs: { 'send-email.py': [0, '{"skipped": "x", "why": "already emailed"}'] } });
    expect(r.calls).toHaveLength(12);
  });
  it('reminded inside the week reads as already done, not as not done', () => {
    const t = roy('recRA', 'Visit 6 Example Road', {
      notes: '[20 Sep 2026 — agent-dispatch] Handed over to Roy Lavin (x): y\n\n[05 Oct 2026 — task-manager clock] CLOCK ROY: emailed Roy a reminder' });
    expect(clock({ tasks: [t] }).res.summary.ROY).toMatchObject({ already: 1, notDone: 0 });
  });
  it('a dry run writes nothing and calls nothing', () => {
    const r = clock({ tasks: [roy('recR9', 'Visit 6 Example Road')], apply: false });
    expect(r.patches).toHaveLength(0);
    expect(r.calls).toHaveLength(0);
    expect(dec(r, 'recR9').done).toMatch(/dry run/);
  });
});

describe('findings.py escalate (real, against a temp queue)', () => {
  const FP = path.join(root, 'scripts/findings.py');
  function fq(...args) {
    const env = { ...process.env, FINDINGS_FILE: path.join(dir, 'q.jsonl'), FINDINGS_OVERFLOW_FILE: path.join(dir, 'o.jsonl') };
    try {
      return { code: 0, out: execFileSync('python3', [FP, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'findings-esc-'));
  it('raises an open finding, is idempotent, ratchets only up, and refuses a closed one', () => {
    const id = fq('add', '--routine', 'agent-dispatch', '--title', 'uploader broken', '--where', 'scripts/x.py').out.trim().split('\n')[0];
    const up = fq('escalate', id, '--severity', 'critical', '--why', 'blocked 4 days', '--by', 'task-manager');
    expect(up.code).toBe(0);
    expect(JSON.parse(up.out)).toMatchObject({ severity: 'critical', was: 'medium', changed: true });
    expect(JSON.parse(fq('escalate', id, '--severity', 'critical', '--why', 'again').out)).toMatchObject({ changed: false });
    expect(JSON.parse(fq('escalate', id, '--severity', 'high', '--why', 'lower').out)).toMatchObject({ severity: 'critical', changed: false });
    const listed = JSON.parse(fq('list', '--json').out).find((r) => r.id === id);
    expect(listed.severity).toBe('critical');
    expect(listed.escalated_why).toBe('blocked 4 days');
    fq('close', id, '--outcome', 'deferred', '--note', 'x');
    expect(fq('escalate', id, '--severity', 'critical', '--why', 'x').code).toBe(2);
    expect(fq('escalate', 'nope-000', '--severity', 'critical', '--why', 'x').code).toBe(1);
  });
});

describe('verify: the clock ran this slot, none of its moves failed, and leave is not a move on a blocked task', () => {
  function verify({ clockJson, board, actions, staleClock = false }) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-clock-verify-'));
    const start = Math.floor(Date.now() / 1000) - 60;
    fs.writeFileSync(path.join(scratch, 'board.json'), JSON.stringify(board || {}));
    if (clockJson) {
      const p = path.join(scratch, 'clock.json');
      fs.writeFileSync(p, JSON.stringify(clockJson));
      if (staleClock) fs.utimesSync(p, new Date((start - 3600) * 1000), new Date((start - 3600) * 1000));
    }
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("tm", ${TM})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.clock_problems(json.loads(sys.argv[1]), scratch=sys.argv[2], run_start=sys.argv[3])))
`, JSON.stringify(actions || []), scratch, String(start)], { encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop());
  }
  const board = { stuck: [{ id: 'recB1', blocker: { kind: 'KEVIN' } }, { id: 'recB2' }], decided: [{ id: 'recB3' }] };
  const clockJson = { decisions: [{ task: 'recB3', kind: 'KEVIN' }, { task: 'recB4', kind: 'TOOL' }, { task: 'recB5', kind: 'ROY' }] };

  it('passes a fresh clock and ordinary moves', () => {
    expect(verify({ clockJson, board, actions: [{ task: 'recB2', move: 'leave', ok: true }, { task: 'recB5', move: 'leave', ok: true }] })).toEqual([]);
  });
  it('fails leave on a blocked stuck view or a walled task in clock.json', () => {
    const p = verify({ clockJson, board, actions: [{ task: 'recB1', move: 'leave' }, { task: 'recB4', move: 'leave' }] });
    expect(p).toHaveLength(2);
    expect(p[0]).toMatch(/leave is not a move on a blocked task/);
  });
  it('a decided card (Kevin said wait) may be recorded leave', () => {
    expect(verify({ clockJson, board, actions: [{ task: 'recB3', move: 'leave' }] })).toEqual([]);
  });
  it('a board whose stuck tasks all stand on walls owes no action; one ordinary stuck task still does', () => {
    function run(stuck) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-walled-'));
      fs.writeFileSync(path.join(scratch, 'board.json'), JSON.stringify({ counts: { openTasksRead: 5 }, stuck }));
      fs.writeFileSync(path.join(scratch, 'gate.json'), '{"lane": []}');
      fs.writeFileSync(path.join(scratch, 'clock.json'), '{"decisions": []}');
      const report = path.join(scratch, 'report.json');
      fs.writeFileSync(report, JSON.stringify({ board: { openTasksRead: 5, stuck: stuck.length }, actions: [], scoreWritten: true }));
      const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, datetime
spec = importlib.util.spec_from_file_location("tm", ${TM})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.read_state = lambda: {"history": {datetime.date.today().isoformat(): 1}}
try:
    m.cmd_verify(sys.argv[1]); code = 0
except SystemExit as e:
    code = e.code
print(json.dumps({"code": code, "verdict": json.load(open(sys.argv[2]))}))
`, report, path.join(scratch, 'verify-result.json')], { encoding: 'utf8',
        env: { ...process.env, TASK_MANAGER_SCRATCH: scratch, TASK_MANAGER_RUN_START: String(Math.floor(Date.now() / 1000) - 60) } });
      return JSON.parse(out.trim().split('\n').pop());
    }
    expect(run([{ id: 'recW1', blocker: { kind: 'KEVIN' } }]).code).toBe(0);
    const plain = run([{ id: 'recW1', blocker: { kind: 'KEVIN' } }, { id: 'recW2' }]);
    expect(plain.code).toBe(1);
    expect(plain.verdict.problems.join(' ')).toMatch(/zero actions/);
  });
  it('fails a missing or stale clock.json, and a failed clock move', () => {
    expect(verify({ board, actions: [] }).join(' ')).toMatch(/clock pre-pass did not run/);
    expect(verify({ clockJson, board, actions: [], staleClock: true }).join(' ')).toMatch(/PREVIOUS slot/);
    expect(verify({ clockJson: { decisions: [{ task: 'recX', kind: 'TOOL', failed: 'boom' }] }, board, actions: [] }).join(' '))
      .toMatch(/clock move on recX \(TOOL\) failed: boom/);
  });
});

describe('the board marks a blocked task, and the wiring runs the clock first', () => {
  it('a stuck view with an open wall carries `blocker`', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location("tm", ${TM})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
now = datetime(2026, 10, 7, 9, 0, tzinfo=timezone.utc)
rec = {"id": "recW", "fields": {"Task Name": "x", "Status": "Today", "Created Time": "2026-09-01T00:00:00.000Z",
       "Notes": ${JSON.stringify(wall('TOOL', 'uploader', '2026-10-01T10:00:00.000Z'))}}}
b, _, v = m.task_view(rec, set(), set(), now)
plain = m.task_view({"id": "recP", "fields": {"Task Name": "y", "Status": "Today", "Created Time": "2026-09-01T00:00:00.000Z"}}, set(), set(), now)[2]
print(json.dumps({"bucket": b, "blocker": v.get("blocker"), "plain": plain.get("blocker")}))
`], { encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').pop());
    expect(r.bucket).toBe('stuck');
    expect(r.blocker).toEqual({ kind: 'TOOL', subject: 'uploader', since: '2026-10-01T10:00:00.000Z' });
    expect(r.plain).toBeNull();
  });
  it('the runner runs the clock before the allowance guard and fails the run loudly on a clock failure', () => {
    const runner = read('scripts/task-manager-run.sh');
    const clockAt = runner.indexOf('task-manager.py" clock');
    expect(clockAt).toBeGreaterThan(runner.indexOf('standing_holds.py'));
    expect(clockAt).toBeLessThan(runner.indexOf('allowance.py" check'));
    expect(runner).toMatch(/TASK-MANAGER BROKEN: the clock pre-pass failed/);
  });
  it('the skill says leave is not a move on a blocked task, and puts the Clock section in the report', () => {
    const skill = read('.claude/scheduled-tasks/task-manager-board/SKILL.md');
    expect(skill).toMatch(/## Step 1a — The clock/);
    expect(skill).toMatch(/[Ll]eave is not a move on a blocked task/);
    expect(skill).toMatch(/\*\*Clock:\*\* paste `\$TASK_MANAGER_SCRATCH\/clock\.md`/);
    expect(skill).toMatch(/SIGN-IN, 1 day/);
  });
});
