// Exactly ONE Claude routine may actually RUN, and it must be daily-ops.
//
// Fourteen separately-scheduled routines stampeded on wake and overwrote each
// other. Serialising them behind a lock then produced a worse failure: a routine
// suspended by the Mac sleeping keeps HOLDING the lock (drift-monitor held it
// 4h54m on 8 Aug 2026), so everything behind it was skipped for lateness and
// ceo-huddle never ran once.
//
// This guard used to read the scheduler's scheduled-tasks.json. On 10 Aug 2026
// that file turned out to be one the app NO LONGER WRITES, so the guard was
// wrong in both directions: it cried stacking over an already-disabled routine
// (reddening the pre-push gate for main), and it would equally have reported all
// clear for a routine genuinely enabled tomorrow.
//
// It now reads what actually RAN, from the queue event log the jobs write
// themselves. The back-test at the bottom is the point of the whole file: feed
// it the real 10 Aug shape and the false alarm must NOT fire.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const GUARD = resolve(__dirname, '../scripts/check-routines.py');
const ROOT = mkdtempSync(join(tmpdir(), 'routineguard-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let box, routineDir, eventsPath, schedulePath;

/** A routine is a folder with a SKILL.md. That is what separates it from the
 *  shell jobs, which take the same lock legitimately many times a day. */
function writeRoutines(names) {
  for (const n of names) {
    mkdirSync(join(routineDir, n), { recursive: true });
    writeFileSync(join(routineDir, n, 'SKILL.md'), `# ${n}\n`);
  }
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 3600_000).toISOString().replace('Z', '') + 'Z';
}

/** state defaults to 'acquired' — the ordinary "this job got going" event. */
function writeEvents(rows) {
  mkdirSync(join(box, 'queue'), { recursive: true });
  writeFileSync(eventsPath, rows.map((r) => JSON.stringify({
    ts: r.ts ?? hoursAgo(2), job: r.job, state: r.state ?? 'acquired',
  })).join('\n') + '\n');
}

function guard(windowHours = 26) {
  // The module reads both paths from the environment at import, so the env
  // below is all the isolation needed — no monkey-patching of the real file.
  const src = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('cr', ${JSON.stringify(GUARD)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
code, res = m.check(${windowHours})
print(json.dumps({"code": code, "res": res}))
`;
  return JSON.parse(execFileSync('python3', ['-c', src], {
    encoding: 'utf8',
    env: {
      ...process.env,
      JOB_QUEUE_EVENTS: eventsPath,
      CLAUDE_ROUTINE_DIR: routineDir,
      JOB_SCHEDULE_FILE: schedulePath,
    },
  }).trim());
}

/** The job register. An approved slot MUST appear here too — an allowlist entry
 *  for a job nobody registered would be waved past the guard AND be invisible to
 *  the digest that notices a job has stopped. */
function writeSchedule(names) {
  writeFileSync(schedulePath, JSON.stringify(
    Object.fromEntries(names.map((n) => [n, { cron: '0 9 * * *', mode: 'wrapped' }])), null, 2));
}

beforeEach(() => {
  box = mkdtempSync(join(ROOT, 'box-'));
  routineDir = join(box, 'scheduled-tasks');
  eventsPath = join(box, 'queue', 'queue-events.jsonl');
  schedulePath = join(box, 'job-schedule.json');
  mkdirSync(routineDir, { recursive: true });
  // Default: every slot the guard allowlists is registered, so existing tests
  // exercise the stacking logic rather than the registration control.
  writeSchedule(['inbound-triage', 'task-manager', 'ceo-agent', 'prospecting',
                 'uc-check', 'prod-sweep-weekly']);
});

// 4 Sep 2026 (finding 20260905-exceptions-464): four role-agent slot runs never
// happened with the Mac awake, and nothing raised it. An absent run leaves no
// event, so only the SCHEDULE knows how many there should have been.
describe('slot attendance', () => {
  beforeEach(() => writeRoutines(['daily-ops']));

  it('counts what each approved slot should have run against what it did, without calling it stacking', () => {
    // inbound-triage fires 3x a day; only one run in the window.
    writeFileSync(schedulePath, JSON.stringify({
      'inbound-triage': { cron: '0 9,13,17 * * *', mode: 'wrapped' },
      'task-manager': { cron: '0 9,13,17 * * *', mode: 'wrapped' },
      'ceo-agent': { cron: '45 6 * * *', mode: 'wrapped' },
      prospecting: { cron: '15 9 * * *', mode: 'wrapped' },
      'prod-sweep-weekly': { cron: '0 11 * * *', mode: 'wrapped' },
    }, null, 2));
    writeEvents([{ job: 'daily-ops', state: 'mark' }, { job: 'inbound-triage' }]);
    const { code, res } = guard();
    expect(code).toBe(0);                       // nothing stacked, and a miss must not pretend it did
    expect(res.slot_attendance['inbound-triage'].ran).toBe(1);
    expect(res.slot_attendance['inbound-triage'].expected).toBeGreaterThanOrEqual(2);
    expect(res.slot_shortfalls).toContain('inbound-triage');
    expect(res.slot_shortfalls).toContain('prospecting');
    expect(res.missed_slot_runs).toMatch(/inbound-triage 1 of/);
  });

  it('reports no shortfall when every expected firing produced a run', () => {
    writeFileSync(schedulePath, JSON.stringify({
      'inbound-triage': { cron: '0 9,13,17 * * *', mode: 'wrapped' },
      'task-manager': { cron: '0 9,13,17 * * *', mode: 'wrapped' },
      'ceo-agent': { cron: '45 6 * * *', mode: 'wrapped' },
      prospecting: { cron: '15 9 * * *', mode: 'wrapped' },
      'prod-sweep-weekly': { cron: '0 11 * * *', mode: 'wrapped' },
    }, null, 2));
    const rows = [{ job: 'daily-ops', state: 'mark' }];
    for (const n of ['inbound-triage', 'task-manager', 'ceo-agent', 'prospecting', 'prod-sweep-weekly']) {
      for (let i = 0; i < 4; i += 1) rows.push({ job: n, ts: hoursAgo(3 + i) });
    }
    writeEvents(rows);
    const { code, res } = guard();
    expect(code).toBe(0);
    expect(res.slot_shortfalls).toEqual([]);
    expect(res.missed_slot_runs).toBeUndefined();
  });
});

describe('only daily-ops may actually run', () => {
  beforeEach(() => writeRoutines(
    ['daily-ops', 'drift-monitor', 'prod-e2e-sweep', 'ceo-huddle', 'uc-check-slack-notifier']));

  it('passes when only daily-ops left a mark', () => {
    writeEvents([{ job: 'daily-ops', state: 'mark' }]);
    const { code, res } = guard();
    expect(code).toBe(0);
    expect(res.ok).toBe(true);
    expect(res.extras).toEqual([]);
  });

  it('fails when a second routine actually ran, and names it', () => {
    writeEvents([
      { job: 'daily-ops', state: 'mark' },
      { job: 'drift-monitor', state: 'acquired' },
    ]);
    const { code, res } = guard();
    expect(code).toBe(1);
    expect(res.extras).toEqual(['drift-monitor']);
    expect(res.reason).toMatch(/drift-monitor/);
  });

  it('names every extra, not just the first', () => {
    writeEvents([
      { job: 'daily-ops', state: 'mark' },
      { job: 'drift-monitor' }, { job: 'prod-e2e-sweep' }, { job: 'ceo-huddle' },
    ]);
    const { code, res } = guard();
    expect(code).toBe(1);
    expect(res.extras).toEqual(['ceo-huddle', 'drift-monitor', 'prod-e2e-sweep']);
  });

  it('reports WHEN the extra ran, because "it stacked" is not actionable', () => {
    const when = hoursAgo(3);
    writeEvents([{ job: 'daily-ops', state: 'mark' }, { job: 'drift-monitor', ts: when }]);
    const { res } = guard();
    expect(res.when['drift-monitor']).toBe(when);
  });

  it('tells you what to do about it, not just that it is wrong', () => {
    writeRoutines(['some-new-weekly-thing']);
    writeEvents([{ job: 'daily-ops', state: 'mark' }, { job: 'some-new-weekly-thing' }]);
    const { res } = guard();
    // A new routine is usually someone solving a real problem the obvious way.
    // The message has to point at the right way, or it just gets re-enabled.
    expect(res.reason).toMatch(/phase/i);
    expect(res.reason).toMatch(/6b|weekly|monthly/i);
  });

  it('counts started and acquired too, not only mark', () => {
    writeEvents([{ job: 'daily-ops', state: 'mark' }, { job: 'ceo-huddle', state: 'started' }]);
    expect(guard().code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The whole reason this check exists: shell jobs use the same lock, all day.
// ---------------------------------------------------------------------------
describe('registered shell jobs are not routines', () => {
  it('passes while compound-brain, mac-guard and friends take the lock', () => {
    writeRoutines(['daily-ops', 'drift-monitor']);
    writeEvents([
      { job: 'daily-ops', state: 'mark' },
      { job: 'compound-brain' }, { job: 'knowledge-os-sort' }, { job: 'masterplan-sync' },
      { job: 'mac-guard' }, { job: 'uc-notifier-watchdog' }, { job: 'publish-brain' },
    ]);
    const { code, res } = guard();
    expect(code).toBe(0);
    expect(res.non_routine_jobs_that_ran).toContain('compound-brain');
    expect(res.extras).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The control. Each of these would otherwise read "no extra routines, all
// clear" for ever, which is exactly how the old guard stopped guarding.
// ---------------------------------------------------------------------------
describe('cannot-verify is a failure, never a pass', () => {
  it('fails when the event log is missing', () => {
    writeRoutines(['daily-ops']);
    const { code, res } = guard();
    expect(code).toBe(2);
    expect(res.reason).toMatch(/cannot read the queue event log/);
  });

  it('fails on an empty window rather than reporting all clear', () => {
    // The shell jobs run several times a day, so a silent window means the log
    // stopped, not that the Mac was quiet.
    writeRoutines(['daily-ops']);
    writeEvents([{ job: 'compound-brain', ts: hoursAgo(200) }]);
    const { code, res } = guard();
    expect(code).toBe(2);
    expect(res.reason).toMatch(/no queue events at all/);
  });

  it('fails when the routine folder is empty, since it would match nothing', () => {
    writeEvents([{ job: 'daily-ops', state: 'mark' }]);
    const { code, res } = guard();
    expect(code).toBe(2);
    expect(res.reason).toMatch(/no routines found/);
  });

  it('fails when daily-ops itself left no mark — nothing ran at all', () => {
    writeRoutines(['daily-ops']);
    writeEvents([{ job: 'compound-brain' }, { job: 'mac-guard' }]);
    const { code, res } = guard();
    expect(code).toBe(1);
    expect(res.reason).toMatch(/left no mark/);
  });

  it('survives a torn line without going blind', () => {
    writeRoutines(['daily-ops', 'drift-monitor']);
    mkdirSync(join(box, 'queue'), { recursive: true });
    writeFileSync(eventsPath,
      '{"ts": "' + hoursAgo(2) + '", "job": "daily-ops", "state": "mark"}\n' +
      '{"ts": "not json\n' +
      '{"ts": "' + hoursAgo(1) + '", "job": "drift-monitor", "state": "acquired"}\n');
    const { code, res } = guard();
    expect(code).toBe(1);
    expect(res.extras).toEqual(['drift-monitor']);
  });
});

// ---------------------------------------------------------------------------
// BACK-TEST. This is the bug the rewrite exists for. On 10 Aug 2026 the guard
// reported ROUTINE STACKING for uc-check-slack-notifier, which was already
// disabled and had last actually run on 8 Aug. That false alarm failed
// tests/job-queue.test.js:446 and reddened the pre-push gate for main.
// ---------------------------------------------------------------------------
describe('back-test: the 10 Aug false alarm', () => {
  it('does NOT fire for a routine that is idle however its config reads', () => {
    writeRoutines(['daily-ops', 'uc-check-slack-notifier']);
    writeEvents([
      { job: 'daily-ops', state: 'mark' },
      { job: 'compound-brain' }, { job: 'audiobook-backfill' }, { job: 'masterplan-sync' },
      // Its last real run, two days before the alarm. Outside the window.
      { job: 'uc-check-slack-notifier', ts: hoursAgo(50) },
    ]);
    const { code, res } = guard();
    expect(code).toBe(0);
    expect(res.extras).toEqual([]);
  });

  it('DOES fire the moment that same routine genuinely runs again', () => {
    // The mirror image, and the half the old config check had gone blind to.
    writeRoutines(['daily-ops', 'uc-check-slack-notifier']);
    writeEvents([
      { job: 'daily-ops', state: 'mark' },
      { job: 'uc-check-slack-notifier', ts: hoursAgo(1) },
    ]);
    const { code, res } = guard();
    expect(code).toBe(1);
    expect(res.extras).toEqual(['uc-check-slack-notifier']);
  });
});

describe('the guard is actually wired in', () => {
  it('runs as phase 1 of the routine, so a stack is caught the next morning', () => {
    const routine = readFileSync(resolve(__dirname, '../docs/daily-ops-routine.md'), 'utf8');
    expect(routine).toContain('check-routines.py');
  });

  it('daily-ops writes the mark the guard depends on', () => {
    // Without this line in phase 1 the guard fails every day with "nothing ran".
    const routine = readFileSync(resolve(__dirname, '../docs/daily-ops-routine.md'), 'utf8');
    expect(routine).toMatch(/job-queue\.py mark daily-ops/);
  });
});

// ─── APPROVED ROLE-AGENT SLOTS (Kevin's restructure, 26 Aug 2026) ─────
//
// Role-specific work now runs in fixed slots instead of inside a daily-ops
// sequence that reached 6h43 on 26 Aug. A slot is a WRAPPED shell job: it
// takes the lock and heartbeats, so a sleeping one frees the lock in minutes.
// That is the whole difference between a slot and the second Claude routine
// this guard exists to prevent.
//
// Until now a slot passed the guard by being named differently from its skill
// folder (`task-manager` vs `task-manager-board`). That convention was
// deliberate and documented, but it made the guard's verdict depend on a
// filename rather than on whether Kevin sanctioned the job. The first test
// below is the back-test for the trap that removes.
describe('approved role-agent slots run beside daily-ops', () => {
  it('does NOT fire when an approved slot shares its skill folder name', () => {
    // THE TRAP THIS REMOVES: before the allowlist, the only thing keeping
    // task-manager clean was that no folder was called `task-manager`. Rename
    // the folder to match the job — the obvious tidy-up — and the guard cried
    // stacking every morning over a job Kevin had explicitly sanctioned.
    writeRoutines(['daily-ops', 'task-manager', 'ceo-agent']);
    writeEvents([
      { job: 'daily-ops', state: 'mark' },
      { job: 'task-manager', state: 'acquired' },
      { job: 'ceo-agent', state: 'acquired' },
    ]);
    const { code, res } = guard();
    expect(code).toBe(0);
    expect(res.extras).toEqual([]);
    expect(res.approved_slots_that_ran).toEqual(['ceo-agent', 'task-manager']);
  });

  it('still fires for a routine that is NOT on the allowlist', () => {
    // The allowlist widens the door by exactly six named jobs and not one more.
    writeRoutines(['daily-ops', 'task-manager', 'drift-monitor']);
    writeEvents([
      { job: 'daily-ops', state: 'mark' },
      { job: 'task-manager', state: 'acquired' },
      { job: 'drift-monitor', state: 'acquired' },
    ]);
    const { code, res } = guard();
    expect(code).toBe(1);
    expect(res.extras).toEqual(['drift-monitor']);
  });

  it('names the slots that ran, so a clean run still shows its working', () => {
    writeRoutines(['daily-ops', 'uc-check']);
    writeEvents([
      { job: 'daily-ops', state: 'mark' },
      { job: 'uc-check', state: 'acquired' },
    ]);
    const { res } = guard();
    expect(res.reason).toMatch(/uc-check/);
  });

  it('CANNOT VERIFY when an allowlisted slot is missing from the register', () => {
    // A slot waved through here but absent from job-schedule.json is invisible
    // to the digest that notices a job has stopped. Silent on both surfaces is
    // exactly the shape of failure this whole design keeps hitting, so the
    // disagreement is exit 2, never a pass.
    writeRoutines(['daily-ops']);
    writeEvents([{ job: 'daily-ops', state: 'mark' }]);
    writeSchedule(['inbound-triage']);           // the other five are missing
    const { code, res } = guard();
    expect(code).toBe(2);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/missing from the job register/);
    expect(res.reason).toMatch(/ceo-agent/);
  });

  it('CANNOT VERIFY when the register itself is unreadable', () => {
    writeRoutines(['daily-ops']);
    writeEvents([{ job: 'daily-ops', state: 'mark' }]);
    rmSync(schedulePath, { force: true });
    const { code, res } = guard();
    expect(code).toBe(2);
    expect(res.reason).toMatch(/cannot read the job register/);
  });

  it('every allowlisted slot is registered in the REAL job-schedule.json', () => {
    // The control above, run against production rather than a fixture. This is
    // what fails the pre-push gate if somebody allowlists a job and forgets to
    // register it.
    const src = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('cr', ${JSON.stringify(GUARD)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({"slots": sorted(m.APPROVED_SLOTS), "registered": sorted(m.registered_jobs() or [])}))
`;
    const { slots, registered } = JSON.parse(
      execFileSync('python3', ['-c', src], { encoding: 'utf8' }).trim());
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(registered).toContain(s);
  });
});
