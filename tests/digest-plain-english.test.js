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

describe('morning digest — plain English', () => {
  it('collapses every skip into one line and keeps the queue numbers out of Slack', () => {
    writeEvents([
      { ts: hoursAgo(2), job: 'publish-brain', state: 'skipped-stale', reason: 'due 2026-08-19 23:20, 1380 min late, limit 300' },
      { ts: hoursAgo(2), job: 'feed-brain', state: 'skipped-stale', reason: 'due 2026-08-19 22:45, 1380 min late, limit 300' },
      { ts: hoursAgo(1), job: 'masterplan-sync', state: 'acquired' },
      { ts: hoursAgo(1), job: 'masterplan-sync', state: 'released', outcome: 'completed' },
    ]);

    const { out } = runDigest();

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

    expect(out).toContain('Every job was skipped and none ran');
    expect(code).toBe(1);
  });

  it('stays quiet about the all-skipped alarm when something actually ran', () => {
    writeEvents([
      { ts: hoursAgo(2), job: 'publish-brain', state: 'skipped-stale', reason: '1380 min late' },
      { ts: hoursAgo(2), job: 'feed-brain', state: 'skipped-stale', reason: '1380 min late' },
      { ts: hoursAgo(1), job: 'masterplan-sync', state: 'acquired' },
      { ts: hoursAgo(1), job: 'masterplan-sync', state: 'released', outcome: 'completed' },
    ]);

    const { out } = runDigest();

    expect(out).not.toContain('Every job was skipped');
  });
});
