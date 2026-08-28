// The morning digest is read by Kevin on his phone. On 20 and 21 Aug 2026 it
// posted ten lines of "skipped, due 2026-08-19 22:40, 1380 min late, limit 300"
// two mornings running. Nobody read that as the outage it was, and Kevin called
// the channel gobbledygook. Two rules, both guarded here:
//
//   1. Skips are ONE line naming the jobs, never one line per job with the
//      queue's internal numbers in it.
//   2. Every job skipped and none ran is ONE alarm, not ten shrugs.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIGEST = resolve(__dirname, '../scripts/morning-digest.py');

const ROOT = mkdtempSync(join(tmpdir(), 'digest-plain-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
let logDir;
let queueDir;
let schedulePath;

// Three daily jobs that are always due in the 26-hour window.
const SCHEDULE = {
  'publish-brain': { cron: '20 23 * * *', maxLateMinutes: 300 },
  'feed-brain': { cron: '45 22 * * *', maxLateMinutes: 300 },
  'masterplan-sync': { cron: '0 7 * * *', maxLateMinutes: 240 },
};
const JOB_COUNT = Object.keys(SCHEDULE).length;

function hoursAgo(n) {
  return new Date(Date.now() - n * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeEvents(records) {
  writeFileSync(
    join(queueDir, 'queue-events.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  );
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
      // Grace off, or this file is a CLOCK-DEPENDENT test (fixed 27 Aug 2026).
      // The digest only counts a job once it is more than DIGEST_GRACE_MINUTES
      // (45) past due, which is correct: a job due ten minutes ago has not
      // failed, it just has not run yet. But the three fixture crons above are
      // fixed times of day, so whenever the wall clock sat inside one of their
      // grace windows that job was dropped from the digest entirely and the
      // assertions below counted two jobs instead of three. It failed for
      // roughly two hours out of every twenty-four — 22:45–00:05 and
      // 07:00–07:45 — and passed the rest, which is why it read as a mystery
      // rather than a flake. Grace has its own behaviour and its own place to
      // be tested; it is not what this file is about, so hold it at zero and
      // let all three jobs count at any hour.
      DIGEST_GRACE_MINUTES: '0',
    },
  };
  try {
    return { out: execFileSync('python3', [DIGEST, '--no-post'], opts), code: 0 };
  } catch (e) {
    return { out: e.stdout || '', code: e.status };
  }
}

/**
 * Every fixture job reached the digest. Asserted before the wording checks so
 * a dropped job says so plainly — the original failure surfaced as a confusing
 * "expected /2 skipped/" mismatch that named no missing job at all.
 */
/** The one "Scheduled jobs: ..." line — icon included, since the icon is the
 *  first thing read on a phone. */
function headlineOf(out) {
  return out.split('\n').find((l) => l.includes('Scheduled jobs:')) || '';
}

function expectAllJobsCounted(out) {
  const headline = headlineOf(out);
  // Every group the headline can carry — see build() in morning-digest.py.
  const total = [...headline.matchAll(/(\d+) (?:ran|failed|halted|skipped|queued out|no record)/g)]
    .reduce((n, m) => n + Number(m[1]), 0);
  expect(total, `digest counted ${total} of ${JOB_COUNT} jobs — headline was "${headline.trim()}"`)
    .toBe(JOB_COUNT);
}

beforeEach(() => {
  seq += 1;
  logDir = join(ROOT, `logs-${seq}`);
  queueDir = join(logDir, 'queue');
  mkdirSync(queueDir, { recursive: true });
  schedulePath = join(ROOT, `schedule-${seq}.json`);
  writeFileSync(schedulePath, JSON.stringify(SCHEDULE));
});

describe('morning digest — plain English', () => {
  it('collapses every skip into one line and keeps the queue numbers out of Slack', () => {
    writeEvents([
      { ts: hoursAgo(2), job: 'publish-brain', state: 'skipped-stale', reason: 'due 2026-08-19 23:20, 1380 min late, limit 300' },
      { ts: hoursAgo(2), job: 'feed-brain', state: 'skipped-stale', reason: 'due 2026-08-19 22:45, 1380 min late, limit 300' },
      { ts: hoursAgo(1), job: 'masterplan-sync', state: 'acquired' },
      { ts: hoursAgo(1), job: 'masterplan-sync', state: 'released', outcome: 'completed' },
    ]);

    const { out } = runDigest();

    expectAllJobsCounted(out);
    const skipLines = out.split('\n').filter((l) => l.includes('skipped'));
    // The headline counts them ("2 skipped") and one further line names them.
    expect(skipLines.length).toBeLessThanOrEqual(2);
    expect(out).toMatch(/2 skipped because the Mac woke too late.*feed-brain, publish-brain/);
    expect(out).not.toMatch(/min late/);
    expect(out).not.toMatch(/limit \d+/);
    // A skip is still never reported as worked.
    expect(out).toMatch(/Worked: masterplan-sync/);
    expect(out).not.toMatch(/Worked: .*publish-brain/);
  });

  it('back-test: all skipped and none ran is one loud alarm, not a list of shrugs', () => {
    writeEvents([
      { ts: hoursAgo(2), job: 'publish-brain', state: 'skipped-stale', reason: '1380 min late' },
      { ts: hoursAgo(2), job: 'feed-brain', state: 'skipped-stale', reason: '1380 min late' },
      { ts: hoursAgo(2), job: 'masterplan-sync', state: 'skipped-stale', reason: '1380 min late' },
    ]);

    const { out, code } = runDigest();

    expectAllJobsCounted(out);
    expect(out).toContain('Every job was skipped and none ran');
    expect(code).toBe(1);
    // The HEADLINE carries it too. Until 28 Aug 2026 this line read
    // ":white_check_mark: Scheduled jobs: 0 ran, 3 skipped." with the alarm
    // one line below, so the first thing Kevin saw on his phone for a morning
    // where nothing ran was a green tick.
    expect(headlineOf(out)).toContain(':rotating_light:');
    expect(headlineOf(out)).not.toContain(':white_check_mark:');
  });

  it('stays quiet about the all-skipped alarm when something actually ran', () => {
    writeEvents([
      { ts: hoursAgo(2), job: 'publish-brain', state: 'skipped-stale', reason: '1380 min late' },
      { ts: hoursAgo(2), job: 'feed-brain', state: 'skipped-stale', reason: '1380 min late' },
      { ts: hoursAgo(1), job: 'masterplan-sync', state: 'acquired' },
      { ts: hoursAgo(1), job: 'masterplan-sync', state: 'released', outcome: 'completed' },
    ]);

    const { out } = runDigest();

    expectAllJobsCounted(out);
    expect(out).not.toContain('Every job was skipped');
    // CONTROL for the red headline above. Skips on their own stay green: two
    // late jobs and one that worked is a normal morning, and a digest that
    // shouts every day is one nobody reads, which is the whole reason this
    // file exists.
    expect(headlineOf(out)).toContain(':white_check_mark:');
  });
});
