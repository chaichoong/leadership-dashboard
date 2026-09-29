// The morning digest must grade a lockless routine on its own end mark.
//
// Regression origin: 29 Sep 2026. daily-ops never takes the queue lock, so it
// writes `mark` events (a start mark, then an end mark) and never `acquired`.
// The stalled-days check already graded it on the end mark (19 Sep), but the
// "what ran in the last 26 hours" chain had no branch for marks, so every
// morning it printed "daily-ops — was due, no run recorded" on a routine that
// had run. That kept the digest's alarm on for good: it exited 1 on 7 of 7
// days, and an alarm that can never go green reads the same as a real outage.
//
// Back-test: DIGEST_SCRIPT=<the pre-fix morning-digest.py> npx vitest run this
// file — "a finished run reads as Worked" and "a start mark with no end mark"
// fail; the control still passes.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIGEST = process.env.DIGEST_SCRIPT || resolve(__dirname, '../scripts/morning-digest.py');
const ROOT = mkdtempSync(join(tmpdir(), 'digest-coop-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// A daily cron that last fired between two and three hours ago, whatever time
// the suite runs: inside the 26-hour window and past the 45-minute grace.
const due = new Date();
due.setMinutes(0, 0, 0);
due.setHours(due.getHours() - 2);
const SCHEDULE = {
  'daily-ops': { cron: `0 ${due.getHours()} * * *`, completedWhen: 'end-mark', queued: false },
};
const at = (mins) => new Date(due.getTime() + mins * 60000).toISOString();

let seq = 0;
let logDir;
let queueDir;
let schedulePath;

beforeEach(() => {
  seq += 1;
  logDir = join(ROOT, `logs-${seq}`);
  queueDir = join(logDir, 'queue');
  mkdirSync(queueDir, { recursive: true });
  schedulePath = join(ROOT, `schedule-${seq}.json`);
  writeFileSync(schedulePath, JSON.stringify(SCHEDULE));
});

function writeEvents(records) {
  writeFileSync(join(queueDir, 'queue-events.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
}

function runDigest() {
  const opts = {
    encoding: 'utf8',
    env: {
      ...process.env,
      JOB_LOG_DIR: logDir,
      JOB_QUEUE_DIR: queueDir,
      JOB_QUEUE_SCHEDULE: schedulePath,
      FINDINGS_FILE: join(logDir, 'no-findings.jsonl'),
    },
  };
  try {
    return { out: execFileSync('python3', [DIGEST, '--no-post'], opts), code: 0 };
  } catch (e) {
    return { out: e.stdout || '', code: e.status };
  }
}

describe('morning digest — a lockless routine graded on its end mark', () => {
  it('a finished run reads as Worked, and the digest can go green', () => {
    writeEvents([
      { ts: at(4), job: 'daily-ops', state: 'mark', note: '' },
      { ts: at(70), job: 'daily-ops', state: 'mark', note: 'end' },
    ]);
    const { out, code } = runDigest();
    expect(out).not.toContain('was due, no run recorded');
    expect(out).toMatch(/Worked: [^\n]*daily-ops/);
    expect(code).toBe(0);
  });

  it('a start mark with no end mark is a failure, not a missing run', () => {
    writeEvents([{ ts: at(4), job: 'daily-ops', state: 'mark', note: '' }]);
    const { out, code } = runDigest();
    expect(out).toContain('*daily-ops* — started but has left no end mark yet');
    expect(out).not.toContain('was due, no run recorded');
    expect(code).toBe(1);
  });

  it('no marks at all still reads as a missing run (control)', () => {
    writeEvents([]);
    const { out, code } = runDigest();
    expect(out).toContain('*daily-ops* — was due, no run recorded');
    expect(code).toBe(1);
  });
});
