// Tests for the morning digest's "this job has quietly stopped working" alarm.
//
// Regression origin: 8 Aug 2026. task-hygiene-sweep did no work for four consecutive
// days and every morning's digest read as normal, because each single day had an
// innocent explanation the digest reported quietly:
//   6 Aug  acquired the lock, halted on Tasks schema drift, wrote "Did not run"
//   7 Aug  skipped-stale, 453 minutes late after the Mac woke
//   8 Aug  deferred-not-ready on a wake-up DNS drop, then skipped-stale, then
//          acquired and halted on the same schema drift again
//
// Two holes, both covered here:
//   1. `acquired` was read as success. Taking the lock is not doing the work.
//   2. Nothing counted the RUN of days. A skip is a shrug; four skips is an outage.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIGEST = resolve(__dirname, '../scripts/morning-digest.py');
const QUEUE = resolve(__dirname, '../scripts/job-queue.py');

const ROOT = mkdtempSync(join(tmpdir(), 'digest-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
let logDir;
let queueDir;
let schedulePath;

// A daily 02:30 job, matching task-hygiene-sweep's real cron.
const SCHEDULE = {
  'task-hygiene-sweep': { cron: '30 2 * * *', staleMinutes: 180 },
};

// The logs stamp UTC; the digest converts back to local days. Building from a local
// Date and stamping it as UTC is what makes a fixture land on the calendar day the
// test means, in whatever timezone the Mac is currently in.
function daysAgo(n, hour = 3) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function utcStamp(d) {
  return new Date(d.getTime()).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeEvents(records) {
  writeFileSync(
    join(queueDir, 'queue-events.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  );
}

// The digest exits 1 whenever anything needs attention, including today's run
// simply not having happened yet in a fixture. Return both so a test can assert on
// the text without the exit code deciding for it.
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

beforeEach(() => {
  seq += 1;
  logDir = join(ROOT, `logs-${seq}`);
  queueDir = join(logDir, 'queue');
  mkdirSync(queueDir, { recursive: true });
  schedulePath = join(ROOT, `schedule-${seq}.json`);
  writeFileSync(schedulePath, JSON.stringify(SCHEDULE));
});

describe('morning digest — stalled routine', () => {
  it('shouts when a daily job has not completed for three scheduled days', () => {
    // Last good completion four days ago, nothing since.
    writeEvents([
      { ts: utcStamp(daysAgo(4)), job: 'task-hygiene-sweep', state: 'acquired' },
      { ts: utcStamp(daysAgo(4)), job: 'task-hygiene-sweep', state: 'released', outcome: 'completed' },
      { ts: utcStamp(daysAgo(3)), job: 'task-hygiene-sweep', state: 'skipped-stale', reason: '453 min late' },
      { ts: utcStamp(daysAgo(2)), job: 'task-hygiene-sweep', state: 'skipped-stale', reason: '455 min late' },
      { ts: utcStamp(daysAgo(1)), job: 'task-hygiene-sweep', state: 'acquired' },
      { ts: utcStamp(daysAgo(1)), job: 'task-hygiene-sweep', state: 'released', outcome: 'halted', reason: 'Tasks schema drift' },
    ]);

    const { out, code } = runDigest();

    expect(out).toContain('no completed run in 3 scheduled days');
    expect(code).toBe(1); // exit 1 = needs attention, so launchd records a real failure
  });

  it('stays quiet while the job is completing normally', () => {
    writeEvents([
      { ts: utcStamp(daysAgo(3)), job: 'task-hygiene-sweep', state: 'released', outcome: 'completed' },
      { ts: utcStamp(daysAgo(2)), job: 'task-hygiene-sweep', state: 'released', outcome: 'completed' },
      { ts: utcStamp(daysAgo(1)), job: 'task-hygiene-sweep', state: 'released', outcome: 'completed' },
    ]);

    const { out } = runDigest();

    expect(out).not.toContain('no completed run');
  });

  it('back-test: a halted release used to count as "Worked"', () => {
    // Yesterday completed, so the run-of-days alarm stays silent and this test
    // isolates the second hole: today the job took the lock and did nothing.
    writeEvents([
      { ts: utcStamp(daysAgo(1)), job: 'task-hygiene-sweep', state: 'released', outcome: 'completed' },
      { ts: utcStamp(daysAgo(0, 8)), job: 'task-hygiene-sweep', state: 'acquired' },
      { ts: utcStamp(daysAgo(0, 8)), job: 'task-hygiene-sweep', state: 'released', outcome: 'halted', reason: 'Tasks schema drift' },
    ]);

    const { out } = runDigest();

    expect(out).toContain('took the lock but did not complete');
    expect(out).toContain('Tasks schema drift');
    expect(out).not.toContain('Worked: task-hygiene-sweep');
  });

  it('a release with no outcome still reads as completed, so old history is not retroactively alarming', () => {
    writeEvents([
      { ts: utcStamp(daysAgo(3)), job: 'task-hygiene-sweep', state: 'released', held_seconds: 12 },
      { ts: utcStamp(daysAgo(2)), job: 'task-hygiene-sweep', state: 'released', held_seconds: 12 },
      { ts: utcStamp(daysAgo(1)), job: 'task-hygiene-sweep', state: 'released', held_seconds: 12 },
    ]);

    const { out } = runDigest();

    expect(out).not.toContain('no completed run');
    expect(out).not.toContain('did no work');
  });
});

describe('job-queue release outcome', () => {
  it('records the outcome and reason on the released event', () => {
    const env = { ...process.env, JOB_QUEUE_DIR: queueDir, JOB_QUEUE_SCHEDULE: schedulePath };
    execFileSync('python3', [QUEUE, 'acquire', 'task-hygiene-sweep', '--no-stale-check', '--quiet'], { env });
    const out = execFileSync(
      'python3',
      [QUEUE, 'release', 'task-hygiene-sweep', '--outcome', 'halted', '--reason', 'Tasks schema drift'],
      { env, encoding: 'utf8' }
    );

    expect(out).toContain('halted');

    const lines = execFileSync('cat', [join(queueDir, 'queue-events.jsonl')], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const released = lines.filter((l) => l.state === 'released').pop();

    expect(released.outcome).toBe('halted');
    expect(released.reason).toBe('Tasks schema drift');
  });

  it('defaults to completed so every existing caller stays honest', () => {
    const env = { ...process.env, JOB_QUEUE_DIR: queueDir, JOB_QUEUE_SCHEDULE: schedulePath };
    execFileSync('python3', [QUEUE, 'acquire', 'task-hygiene-sweep', '--no-stale-check', '--quiet'], { env });
    execFileSync('python3', [QUEUE, 'release', 'task-hygiene-sweep', '--quiet'], { env });

    const lines = execFileSync('cat', [join(queueDir, 'queue-events.jsonl')], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const released = lines.filter((l) => l.state === 'released').pop();

    expect(released.outcome).toBe('completed');
  });
});
