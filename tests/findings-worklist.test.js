// The fixer works what blocks work first (13 Nov 2026).
//
// WHY
// The daily fixer read `findings.py list --status open` and took findings worst
// severity first. That list said nothing about which findings hold a robot's
// task behind a TOOL wall. Measured 13 Nov 2026: 65 tasks waited on 55
// findings, and the fixer had claimed 2 of them. `worklist` reads the blocked-
// task sweep's report and puts those findings first, most tasks blocked first.
//
// Every test here DRIVES the real command against a fixture queue and a fixture
// sweep report in a temp dir. Ids, titles and tasks are invented.
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/findings.py');
let dir, store, blockersPath;

const stamp = (hoursAgo) =>
  new Date(Date.now() - hoursAgo * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');

function run(args, env = {}) {
  try {
    return { code: 0, out: execFileSync('python3', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, FINDINGS_FILE: store, FINDINGS_OVERFLOW_FILE: join(dir, 'ofl.jsonl'),
             FINDINGS_BLOCKERS_FILE: blockersPath, ...env },
    }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}
const worklist = (...a) => run(['worklist', ...a]);
const json = (...a) => JSON.parse(worklist('--json', ...a).out);

function seed(records) {
  writeFileSync(store, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}
function blockers(walls, extra = {}) {
  writeFileSync(blockersPath, JSON.stringify({
    readAt: stamp(0.1), openTasksRead: 1, open: walls, ...extra,
  }));
}

const add = (id, severity = 'medium', hoursAgo = 100, extra = {}) => ({
  op: 'add', id, ts: stamp(hoursAgo), routine: 'sweep-x', severity,
  title: `invented problem ${id}`, where: `scripts/example-${id}.py`, detail: 'd',
  proposed_fix: `fix line for ${id}`, touches_code: true, ...extra,
});
const wall = (task, finding, days, more = {}) => ({
  task, name: `invented task ${task}`, kind: 'TOOL', finding, findingStatus: 'open',
  days, toolState: 'unclaimed', tool: `no fixer has taken it in ${Math.floor(days)} days`, ...more,
});

// The ids in printed order, each section on its own.
function sections(out) {
  const lines = out.split('\n');
  const at = (re) => lines.findIndex(l => re.test(l));
  const rest = at(/^THE REST:/);
  const nq = at(/^BLOCKED BUT NOT IN THE QUEUE:/);
  const ids = (from, to) => lines.slice(from, to < 0 ? undefined : to)
    .map(l => (l.match(/^\[([\w-]+)\]/) || [])[1]).filter(Boolean);
  return {
    blocking: ids(0, rest), rest: ids(rest, nq),
    notInQueue: nq < 0 ? [] : lines.slice(nq + 1).filter(l => /^  \S/.test(l)).map(l => l.trim().split(/\s+/)[0]),
  };
}

describe('findings worklist: what blocks work comes first', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'findings-worklist-'));
    store = join(dir, 'q.jsonl');
    blockersPath = join(dir, 'blockers.json');
  });

  it('ranks blocking findings by tasks blocked, then by the oldest wall, above any severity', () => {
    seed([add('f-sev', 'critical'), add('f-three', 'low'), add('f-old', 'low'), add('f-new', 'medium')]);
    blockers([
      wall('recT1', 'f-three', 1), wall('recT2', 'f-three', 2), wall('recT3', 'f-three', 3),
      wall('recT2', 'f-three', 2),                     // a second wall on one task is one task
      wall('recT4', 'f-new', 2), wall('recT5', 'f-old', 10),
      { task: 'recK', kind: 'KEVIN', finding: 'f-sev', days: 50 },  // only TOOL walls count
    ]);
    const s = sections(worklist().out);
    expect(s.blocking).toEqual(['f-three', 'f-old', 'f-new']);
    expect(s.rest).toEqual(['f-sev']);
    const j = json();
    expect(j.blocking.map(b => [b.finding, b.tasksBlocked, b.oldestWallDays]))
      .toEqual([['f-three', 3, 3], ['f-old', 1, 10], ['f-new', 1, 2]]);
  });

  it('counts a wall on a merged repeat toward the finding that survives it', () => {
    seed([add('f-surv'), add('f-rep'), add('f-other'),
          { op: 'dupe', id: 'f-rep', of: 'f-surv', ts: stamp(50), note: 'same problem' }]);
    blockers([wall('recA', 'f-surv', 1), wall('recB', 'f-rep', 4), wall('recC', 'f-other', 9),
              wall('recD', 'f-other', 1)]);
    const j = json();
    const surv = j.blocking.find(b => b.finding === 'f-surv');
    expect(surv.tasksBlocked).toBe(2);
    expect(surv.oldestWallDays).toBe(4);
    expect(surv.wallFindings).toEqual(['f-rep']);
    expect(j.blocking.map(b => b.finding)).not.toContain('f-rep');
    // tie on two tasks: the older wall (9 days) goes first
    expect(j.blocking.map(b => b.finding)).toEqual(['f-other', 'f-surv']);
    expect(worklist().out).toMatch(/walls name merged repeat\(s\): f-rep/);
  });

  it('puts a wall on a finding the fixer cannot take in BLOCKED BUT NOT IN THE QUEUE, never drops it', () => {
    seed([add('f-open'), add('f-fixed'), add('f-pend'), add('f-def'), add('f-busy'),
          { op: 'close', id: 'f-fixed', ts: stamp(5), outcome: 'fixed', note: 'n' },
          { op: 'close', id: 'f-pend', ts: stamp(5), outcome: 'pending', pr: '41', note: 'n' },
          { op: 'close', id: 'f-def', ts: stamp(5), outcome: 'deferred', note: 'n' },
          { op: 'claim', id: 'f-busy', ts: stamp(1), by: 'queue-fixer' }]);
    blockers([wall('r1', 'f-open', 1), wall('r2', 'f-fixed', 2), wall('r3', 'f-pend', 3),
              wall('r4', 'f-def', 4), wall('r5', 'f-gone', 5), wall('r6', 'f-busy', 6)]);
    const out = worklist().out;
    const s = sections(out);
    expect(s.blocking).toEqual(['f-open']);
    expect(s.notInQueue.sort()).toEqual(['f-busy', 'f-def', 'f-fixed', 'f-gone', 'f-pend']);
    expect(out).toMatch(/f-pend\s+pending \(PR #41\)/);
    expect(out).toMatch(/f-gone\s+unknown id/);
    expect(out).toMatch(/f-busy\s+claimed \(being worked\)/);
    const st = Object.fromEntries(json().notInQueue.map(n => [n.finding, n.status]));
    expect(st['f-fixed']).toBe('fixed');
    expect(st['f-def']).toBe('deferred');
  });

  it('treats a stale claim as work, and says to reopen it first', () => {
    seed([add('f-dead'), { op: 'claim', id: 'f-dead', ts: stamp(30), by: 'queue-fixer' }]);
    blockers([wall('r1', 'f-dead', 2)]);
    const out = worklist().out;
    expect(sections(out).blocking).toEqual(['f-dead']);
    expect(out).toMatch(/STALE CLAIM by queue-fixer/);
  });

  it('flags a blocking finding that needs no code as NOT CODE, and a protected one as PROTECTED', () => {
    seed([add('f-nc', 'high', 100, { touches_code: false }), add('f-prot')]);
    blockers([wall('r1', 'f-nc', 1),
              wall('r2', 'f-prot', 2, { toolState: 'no-fixer', tool: 'no fixer can reach it (protected file: scripts/example.py)' })]);
    const out = worklist().out;
    const nc = out.slice(out.indexOf('[f-nc]'));
    expect(nc.split('\n').slice(0, 4).join('\n')).toMatch(/NOT CODE/);
    expect(out).toMatch(/sweep says: no fixer can reach it \(protected file: scripts\/example\.py\)/);
    expect(out).toMatch(/PROTECTED: fix it in the protected PR/);
    expect(json().blocking.find(b => b.finding === 'f-nc').touchesCode).toBe(false);
  });

  it('never cuts a blocking finding with --limit, and says how many of the rest were left out', () => {
    seed([add('b1'), add('b2'), add('b3'), add('r1', 'high'), add('r2', 'low')]);
    blockers([wall('t1', 'b1', 1), wall('t2', 'b2', 1), wall('t3', 'b3', 1)]);
    const out = worklist('--limit', '1').out;
    const s = sections(out);
    expect(s.blocking.sort()).toEqual(['b1', 'b2', 'b3']);
    expect(s.rest).toEqual([]);
    expect(out).toMatch(/THE REST: 2 other open finding\(s\), severity then age, 2 left out by --limit 1/);
    const s2 = sections(worklist('--limit', '4').out);
    expect(s2.rest).toEqual(['r1']);
  });

  for (const [name, setup, why] of [
    ['missing', () => {}, /written no report/],
    ['stale', () => { blockers([]); const t = (Date.now() - 3 * 3600e3) / 1000; utimesSync(blockersPath, t, t); },
      /not written for \d+ minutes/],
    ['unreadable', () => writeFileSync(blockersPath, '{ half a file'), /could not be read/],
    ['blind to the board', () => blockers([], { openTasksRead: 0 }), /could not read the task board/],
  ]) {
    it(`says BLOCKING: NOT CHECKED when the sweep report is ${name}, then the rest by severity`, () => {
      seed([add('lo', 'low', 200), add('cr', 'critical', 10), add('hi', 'high', 50)]);
      setup();
      const out = worklist().out;
      const first = out.split('\n')[0];
      expect(first).toMatch(/^BLOCKING: NOT CHECKED \(/);
      expect(first).toMatch(why);
      expect(sections(out).rest).toEqual(['cr', 'hi', 'lo']);
      const j = json();
      expect(j.blockingChecked).toBe(false);
      expect(j.notChecked).toMatch(why);
      expect(j.blocking).toEqual([]);
    });
  }

  it('takes the report path from --blockers as well as the environment', () => {
    seed([add('f1')]);
    const other = join(dir, 'other.json');
    writeFileSync(other, JSON.stringify({ readAt: stamp(0), openTasksRead: 1, open: [wall('t', 'f1', 1)] }));
    expect(sections(worklist('--blockers', other).out).blocking).toEqual(['f1']);
  });

  it('gives a --json shape a caller can rely on, and writes nothing', () => {
    seed([add('f1', 'high'), add('f2')]);
    blockers([wall('t1', 'f1', 2.5)]);
    const before = readFileSync(store, 'utf8');
    const j = json();
    expect(Object.keys(j).sort()).toEqual(['blockersFile', 'blockersReadAt', 'blocking', 'blockingChecked',
      'limit', 'notChecked', 'notInQueue', 'rest', 'restOmitted', 'restTotal']);
    expect(j.blockingChecked).toBe(true);
    expect(j.notChecked).toBe(null);
    expect(j.blockersFile).toBe(blockersPath);
    const b = j.blocking[0];
    expect(b).toMatchObject({ finding: 'f1', severity: 'high', tasksBlocked: 1, tasks: ['t1'],
      oldestWallDays: 2.5, staleClaim: false, touchesCode: true });
    expect(b.record.proposed_fix).toBe('fix line for f1');
    expect(b.sweepSays[0].toolState).toBe('unclaimed');
    expect(j.rest.map(r => r.id)).toEqual(['f2']);
    expect(readFileSync(store, 'utf8')).toBe(before);
  });

  it('leaves `list` exactly as it was', () => {
    seed([add('a', 'low'), add('b', 'critical')]);
    blockers([wall('t', 'a', 1)]);
    const out = run(['list', '--status', 'open']).out;
    expect((out.match(/^\[([\w-]+)\]/gm) || [])).toEqual(['[b]', '[a]']);
    expect(out).not.toMatch(/BLOCKING/);
  });
});
