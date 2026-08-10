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

let box, routineDir, eventsPath;

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
    env: { ...process.env, JOB_QUEUE_EVENTS: eventsPath, CLAUDE_ROUTINE_DIR: routineDir },
  }).trim());
}

beforeEach(() => {
  box = mkdtempSync(join(ROOT, 'box-'));
  routineDir = join(box, 'scheduled-tasks');
  eventsPath = join(box, 'queue', 'queue-events.jsonl');
  mkdirSync(routineDir, { recursive: true });
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
