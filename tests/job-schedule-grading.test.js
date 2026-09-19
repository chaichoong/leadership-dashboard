// Grading a scheduled job on evidence it can actually produce.
//
// Findings 20260919-daily-ops-phase2-excepti-548, -549 and 20260919-daily-ops-551.
// On 19 Sep 2026 the morning digest opened with two red lines that were both
// wrong — "daily-ops: no completed run in 21 scheduled days" and
// "data-invariants: no completed run in 13 scheduled days" — while the one real
// four-night outage sat below them as five patient :hourglass: lines. Nothing
// was broken in either job. daily-ops never takes the lock, so it writes `mark`
// and never `released`; data-invariants exits 1 BY DESIGN when it finds a
// violation. The completion test could never go green for either, and a check
// that cannot go green is indistinguishable from a real outage.
//
// Three guards here:
//   1. the per-job completion rule, and the CONTROL that a rule a job can never
//      satisfy fails this suite rather than Kevin's morning;
//   2. the per-job queue give-up, so a job behind a four-hour video render is
//      not held to the same 120 minutes as everything else;
//   3. the two registration lists agreeing about payment-run.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });

const DIGEST = resolve(__dirname, '../scripts/morning-digest.py');
const QUEUE = resolve(__dirname, '../scripts/job-queue.py');
const SCHEDULE = resolve(__dirname, '../scripts/job-schedule.json');
const CHECK_ROUTINES = resolve(__dirname, '../scripts/check-routines.py');

const ROOT = mkdtempSync(join(tmpdir(), 'grading-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let logDir, queueDir, schedulePath;

// Local-time stamps, because the digest files a line by the LOCAL day the cron
// fired on. Writing UTC here would misfile every line either side of midnight
// and the fixture would drift with the reader's timezone.
function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  const utc = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return `${utc.getUTCFullYear()}-${p(utc.getUTCMonth() + 1)}-${p(utc.getUTCDate())}` +
         `T${p(utc.getUTCHours())}:${p(utc.getUTCMinutes())}:${p(utc.getUTCSeconds())}Z`;
}

function daysAgo(n, hour = 6) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 5, 0, 0);
  return d;
}

function event(rec) {
  appendFileSync(join(queueDir, 'queue-events.jsonl'), JSON.stringify(rec) + '\n');
}

function status(rec) {
  appendFileSync(join(logDir, 'job-status.jsonl'), JSON.stringify(rec) + '\n');
}

function digest(extraEnv = {}) {
  const e = {
    ...process.env,
    JOB_LOG_DIR: logDir,
    JOB_QUEUE_DIR: queueDir,
    JOB_QUEUE_SCHEDULE: schedulePath,
    FINDINGS_FILE: join(logDir, 'findings-queue.jsonl'),
    DIGEST_GRACE_MINUTES: '0',
    ...extraEnv,
  };
  try {
    return { code: 0, out: execFileSync('python3', [DIGEST, '--no-post'], { env: e, encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: (err.stdout || '') + (err.stderr || '') };
  }
}

beforeEach(() => {
  logDir = mkdtempSync(join(ROOT, 'logs-'));
  queueDir = join(logDir, 'queue');
  mkdirSync(queueDir, { recursive: true });
  schedulePath = join(logDir, 'schedule.json');
});

// ---------------------------------------------------------------------------
// 1. THE COMPLETION RULE
// ---------------------------------------------------------------------------
describe('per-job completion rule (finding 549)', () => {
  // Weeks of mornings on which the job ran fine, writing only the events it
  // actually writes. Under the default rule that reads as a multi-week outage.
  // 23 days rather than a handful: consecutive_misses() refuses to count a run of misses it
  // cannot see the far end of — it returns 0 the moment it walks off the
  // beginning of the log — so a short fixture proves nothing either way.
  const HISTORY_DAYS = 23;

  function goodDaysOfMarks(job) {
    for (let n = 1; n <= HISTORY_DAYS; n++) {
      event({ ts: localStamp(daysAgo(n, 6)), job, state: 'mark', note: '' });
      event({ ts: localStamp(daysAgo(n, 7)), job, state: 'mark', note: 'end: 5 phases ran' });
    }
    event({ ts: localStamp(daysAgo(0, 6)), job, state: 'mark', note: '' });
  }

  it('reports a mark-only job as a multi-week outage under the DEFAULT rule', () => {
    // The back-test. This is exactly what Kevin read on 19 Sep 2026, and it is
    // what this file exists to stop coming back. If this case ever stops
    // failing, the rule below is no longer doing anything.
    writeFileSync(schedulePath, JSON.stringify({
      'marks-only': { cron: '0 6 * * *', maxLateMinutes: 600, mode: 'cooperative' },
    }));
    goodDaysOfMarks('marks-only');
    expect(digest().out).toMatch(/marks-only\* — no completed run in \d+ scheduled days/);
  });

  it('grades a mark-only job on its own end mark when completedWhen is end-mark', () => {
    writeFileSync(schedulePath, JSON.stringify({
      'marks-only': {
        cron: '0 6 * * *', maxLateMinutes: 600, mode: 'cooperative',
        completedWhen: 'end-mark',
      },
    }));
    goodDaysOfMarks('marks-only');
    expect(digest().out).not.toMatch(/marks-only\* — no completed run/);
  });

  it('still alarms under end-mark when only the START mark is ever written', () => {
    // The rule must not become "it exists, therefore it is fine". A run that
    // begins and dies before its last phase is the 17 Aug 2026 incident, and it
    // has to stay loud.
    writeFileSync(schedulePath, JSON.stringify({
      'marks-only': {
        cron: '0 6 * * *', maxLateMinutes: 600, mode: 'cooperative',
        completedWhen: 'end-mark',
      },
    }));
    for (let n = 0; n <= 23; n++) {
      event({ ts: localStamp(daysAgo(n, 6)), job: 'marks-only', state: 'mark', note: '' });
    }
    expect(digest().out).toMatch(/marks-only\* — no completed run in \d+ scheduled days/);
  });

  it('treats a by-design non-zero exit as ran, not as a missing run', () => {
    // data-invariants: exit 1 MEANS it found a violation. The violation gets its
    // own line; counting it here as well was double counting.
    writeFileSync(schedulePath, JSON.stringify({
      'finds-things': {
        cron: '0 6 * * *', maxLateMinutes: 600, mode: 'wrapped',
        completedWhen: 'ran',
      },
    }));
    for (let n = 0; n <= 23; n++) {
      event({ ts: localStamp(daysAgo(n, 6)), job: 'finds-things', state: 'ran-unlocked' });
      status({ ts: localStamp(daysAgo(n, 6)), job: 'finds-things', ok: false, reason: 'exit code 1' });
    }
    const out = digest().out;
    expect(out).not.toMatch(/finds-things\* — no completed run/);
    // and the violation is still reported, separately
    expect(out).toMatch(/finds-things\* — exit code 1/);
  });

  it('under "ran", a job that only ever queued and timed out is still an outage', () => {
    // The control on the control. "ran" must not mean "appeared in the log".
    writeFileSync(schedulePath, JSON.stringify({
      'finds-things': {
        cron: '0 6 * * *', maxLateMinutes: 600, mode: 'wrapped',
        completedWhen: 'ran',
      },
    }));
    for (let n = 0; n <= 23; n++) {
      event({ ts: localStamp(daysAgo(n, 6)), job: 'finds-things', state: 'queued', behind: 'hog' });
      event({ ts: localStamp(daysAgo(n, 6)), job: 'finds-things', state: 'queue-timeout', behind: 'hog' });
    }
    expect(digest().out).toMatch(/finds-things\* — no completed run in \d+ scheduled days/);
  });

  it('falls back to the default rule on a typo rather than switching the check off', () => {
    writeFileSync(schedulePath, JSON.stringify({
      'marks-only': {
        cron: '0 6 * * *', maxLateMinutes: 600, mode: 'cooperative',
        completedWhen: 'endmark',
      },
    }));
    goodDaysOfMarks('marks-only');
    expect(digest().out).toMatch(/marks-only\* — no completed run in \d+ scheduled days/);
  });
});

// ---------------------------------------------------------------------------
// 2. THE CONTROL: every live job's rule must be one it can satisfy
// ---------------------------------------------------------------------------
describe('completion rules are reachable for every live job (the control)', () => {
  // This is the guard the finding asked for: "a job whose event shape can never
  // satisfy the completion test should FAIL the digest's own selftest rather
  // than be reported as a 21-day outage". It runs against the REAL schedule and
  // the REAL queue log, because the bug was a disagreement between the two.
  it('every enabled scheduled job with history can satisfy its own rule', () => {
    const py = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("md", ${JSON.stringify(DIGEST)})
md = importlib.util.module_from_spec(spec); spec.loader.exec_module(md)
schedule = json.load(open(${JSON.stringify(SCHEDULE)}))
events = md.read_jsonl_all(md.EVENTS)
statuses = md.read_jsonl_all(md.STATUS)
bad = []
for job, cfg in schedule.items():
    if job.startswith("_") or not isinstance(cfg, dict) or not cfg.get("cron"):
        continue
    if cfg.get("enabled") is False:
        continue
    je = [e for e in events if e.get("job") == job]
    js = [s for s in statuses if s.get("job") == job]
    if not je and not js:
        continue                      # no history at all is not evidence of a bad rule
    rule = md.completion_rule(cfg)
    if not md.completion_rule_reachable(rule, je, js):
        bad.append("%s (rule %s)" % (job, rule))
print(json.dumps(bad))
`;
    const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim();
    const unreachable = JSON.parse(out.split('\n').pop());
    expect(unreachable).toEqual([]);
  });

  it('names a job whose rule its own events can never satisfy', () => {
    // Back-test of the control itself: hand it a job graded on `released` that
    // only ever writes `mark`, and it must say so.
    const py = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("md", ${JSON.stringify(DIGEST)})
md = importlib.util.module_from_spec(spec); spec.loader.exec_module(md)
marks = [{"job": "x", "state": "mark", "note": ""}]
print(json.dumps([
    md.completion_rule_reachable("released", marks, []),
    md.completion_rule_reachable("end-mark", marks, []),
    md.completion_rule_reachable("end-mark", [{"job": "x", "state": "mark", "note": "end: done"}], []),
]))
`;
    const r = JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim().split('\n').pop());
    expect(r).toEqual([false, false, true]);
  });
});

// ---------------------------------------------------------------------------
// 3. A REPEATED QUEUE-TIMEOUT IS AN OUTAGE, NOT A BUSY NIGHT
// ---------------------------------------------------------------------------
describe('consecutive queue-timeouts escalate (finding 549)', () => {
  it('keeps a single timeout patient', () => {
    writeFileSync(schedulePath, JSON.stringify({
      'starved': { cron: '0 6 * * *', maxLateMinutes: 600, mode: 'wrapped' },
    }));
    event({ ts: localStamp(daysAgo(0, 6)), job: 'starved', state: 'queued', behind: 'hog' });
    event({ ts: localStamp(daysAgo(0, 6)), job: 'starved', state: 'queue-timeout', behind: 'hog' });
    const out = digest().out;
    expect(out).toMatch(/:hourglass: \*starved\* — gave up waiting behind hog/);
    expect(out).not.toMatch(/scheduled run running/);
  });

  it('turns a second consecutive timeout red and says which run it is', () => {
    writeFileSync(schedulePath, JSON.stringify({
      'starved': { cron: '0 6 * * *', maxLateMinutes: 600, mode: 'wrapped' },
    }));
    for (let n = 0; n <= 3; n++) {
      event({ ts: localStamp(daysAgo(n, 6)), job: 'starved', state: 'queued', behind: 'hog' });
      event({ ts: localStamp(daysAgo(n, 6)), job: 'starved', state: 'queue-timeout', behind: 'hog' });
    }
    const out = digest().out;
    expect(out).toMatch(/:no_entry: \*starved\* — gave up waiting behind hog for the 4th scheduled run running/);
  });
});

// ---------------------------------------------------------------------------
// 4. THE QUEUE GIVE-UP IS PER JOB (finding 548)
// ---------------------------------------------------------------------------
describe('queueTimeoutMinutes (finding 548)', () => {
  function queue(args, extraEnv = {}) {
    const e = {
      ...process.env,
      JOB_QUEUE_DIR: queueDir,
      JOB_QUEUE_SCHEDULE: schedulePath,
      JOB_QUEUE_POLL: '0.05',
      ...extraEnv,
    };
    try {
      return { code: 0, out: execFileSync('python3', [QUEUE, ...args], { env: e, encoding: 'utf8', timeout: 60000 }) };
    } catch (err) {
      return { code: err.status, out: (err.stdout || '') + (err.stderr || '') };
    }
  }

  it('reads the wait from the job schedule and says the number it used', () => {
    // A tiny timeout proves the value was READ, not that waiting works: the
    // refusal line has to carry the per-job number, otherwise a schedule key
    // that is silently ignored looks identical to one that is honoured.
    writeFileSync(schedulePath, JSON.stringify({
      hog: { cron: '* * * * *', maxLateMinutes: 600, mode: 'wrapped' },
      patient: { cron: '* * * * *', maxLateMinutes: 600, mode: 'wrapped', queueTimeoutMinutes: 0.02 },
      impatient: { cron: '* * * * *', maxLateMinutes: 600, mode: 'wrapped' },
    }));
    expect(queue(['acquire', 'hog', '--no-stale-check']).code).toBe(0);
    const r = queue(['acquire', 'patient', '--no-stale-check', '--quiet']);
    expect(r.code).toBe(75);
    const events = readFileSync(join(queueDir, 'queue-events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
      .filter((e) => e.job === 'patient' && e.state === 'queue-timeout');
    expect(events).toHaveLength(1);
    // 0.02 min = 1.2s. The default 120 would still be waiting.
    expect(events[0].waited_seconds).toBeLessThan(30);
  });

  it('an explicit --timeout still wins over the schedule', () => {
    writeFileSync(schedulePath, JSON.stringify({
      hog: { cron: '* * * * *', maxLateMinutes: 600, mode: 'wrapped' },
      patient: { cron: '* * * * *', maxLateMinutes: 600, mode: 'wrapped', queueTimeoutMinutes: 600 },
    }));
    expect(queue(['acquire', 'hog', '--no-stale-check']).code).toBe(0);
    const r = queue(['acquire', 'patient', '--no-stale-check', '--timeout', '0.02', '--quiet']);
    expect(r.code).toBe(75);
  });

  it('the five jobs starved behind the nightly render wait longer than it holds', () => {
    // Measured from queue-events.jsonl: content-engine held the lock 265, 343
    // and 253 minutes on 16, 17 and 18 Sep 2026, and these five gave up at
    // exactly 120 every night. Their wait must clear the worst observed hold.
    const schedule = JSON.parse(readFileSync(SCHEDULE, 'utf8'));
    for (const job of ['apple-notes-bridge', 'feed-brain', 'compound-brain',
                       'publish-brain', 'audiobook-backfill']) {
      expect(schedule[job].queueTimeoutMinutes).toBeGreaterThan(343);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. THE TWO REGISTRATION LISTS AGREE (finding 551)
// ---------------------------------------------------------------------------
describe('approved slots are registered in both lists (finding 551)', () => {
  it('payment-run is an approved slot and is in the job register', () => {
    const schedule = JSON.parse(readFileSync(SCHEDULE, 'utf8'));
    expect(schedule['payment-run']).toBeTruthy();
    expect(schedule['payment-run'].cron).toBe('0 21 * * 5');
    const src = readFileSync(CHECK_ROUTINES, 'utf8');
    expect(src).toMatch(/"payment-run":\s*"/);
  });

  it('no approved slot is missing from the job register', () => {
    // The generic version. check-routines.py already refuses to grade when the
    // two lists disagree; this makes the disagreement fail the suite instead of
    // a Saturday morning.
    const py = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("cr", ${JSON.stringify(CHECK_ROUTINES)})
cr = importlib.util.module_from_spec(spec); spec.loader.exec_module(cr)
schedule = json.load(open(${JSON.stringify(SCHEDULE)}))
print(json.dumps(sorted(n for n in cr.APPROVED_SLOTS if n not in schedule)))
`;
    const missing = JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim().split('\n').pop());
    expect(missing).toEqual([]);
  });
});
