// Tests for the scheduled-job queue.
//
// The bug this guards against lives in shell scheduling and file locking, not in
// application state, so these tests shell out and run real concurrent processes.
// A mocked lock would prove nothing: the failure mode is two processes both
// believing they hold it.
//
// Regression origin: 6 Aug 2026, ten routines fired between 08:07 and 08:33 after
// the Mac woke, produced nine commits in twenty-eight minutes and left the working
// tree dirty across four unrelated features.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const QUEUE = resolve(__dirname, '../scripts/job-queue.py');
const FINDINGS = resolve(__dirname, '../scripts/findings.py');

// Every assertion here starts real processes, and a loaded machine stretches a
// 300ms case past 1.7s. The 5s default flaked on exactly the kind of busy
// morning this feature exists to fix, and a flaky pre-push gate is what teaches
// people to bypass it.
vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });

const ROOT = mkdtempSync(join(tmpdir(), 'jobqueue-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let stateDir;
let schedulePath;

// Fixed reference dates. 2026-08-06 is a Thursday, so:
//   07th Fri, 08th Sat, 09th Sun, 10th Mon.

function env(extra = {}) {
  return {
    ...process.env,
    JOB_QUEUE_DIR: stateDir,
    JOB_QUEUE_SCHEDULE: schedulePath,
    JOB_QUEUE_POLL: '0.05',
    ...extra,
  };
}

function run(args, opts = {}) {
  try {
    const stdout = execFileSync('python3', [QUEUE, ...args], {
      env: env(opts.env), encoding: 'utf8', timeout: 60000,
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: (e.stdout || '') + (e.stderr || '') };
  }
}

function runAsync(args, opts = {}) {
  return new Promise((res) => {
    execFile('python3', [QUEUE, ...args], { env: env(opts.env), timeout: 60000 },
      (err, stdout, stderr) => res({ code: err ? err.code ?? err.status ?? 1 : 0, stdout, stderr }));
  });
}

function events() {
  const f = join(stateDir, 'queue-events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Evaluate a helper from job-queue.py directly, for the pure scheduling logic.
function py(expr) {
  const src = `
import importlib.util, datetime, json
spec = importlib.util.spec_from_file_location('jq', ${JSON.stringify(QUEUE)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(${expr}))
`;
  return JSON.parse(execFileSync('python3', ['-c', src], { encoding: 'utf8', env: env() }).trim());
}

beforeEach(() => {
  stateDir = mkdtempSync(join(ROOT, 'state-'));
  schedulePath = join(stateDir, 'schedule.json');
  writeFileSync(schedulePath, JSON.stringify({
    'nightly-sweep': { cron: '0 2 * * *', maxLateMinutes: 180, mode: 'cooperative' },
    'forgiving-job': { cron: '0 2 * * *', maxLateMinutes: 1440, mode: 'cooperative' },
    'every-minute': { cron: '* * * * *', maxLateMinutes: 60, mode: 'wrapped' },
    'unconfigured-cron': { maxLateMinutes: 60 },
  }));
});

// ---------------------------------------------------------------------------
// Day-of-week. This project lost a week of Friday CEO briefs to a scheduler
// that counted Sunday as 1. Standard cron counts Sunday as 0.
// ---------------------------------------------------------------------------
describe('cron day-of-week', () => {
  it('treats 1-5 as Monday to Friday, not Sunday to Thursday', () => {
    expect(py(`m.cron_matches('0 5 * * 1-5', datetime.datetime(2026, 8, 7, 5, 0))`)).toBe(true);   // Friday
    expect(py(`m.cron_matches('0 5 * * 1-5', datetime.datetime(2026, 8, 9, 5, 0))`)).toBe(false);  // Sunday
  });

  it('accepts both 0 and 7 for Sunday', () => {
    expect(py(`m.cron_matches('0 5 * * 0', datetime.datetime(2026, 8, 9, 5, 0))`)).toBe(true);
    expect(py(`m.cron_matches('0 5 * * 7', datetime.datetime(2026, 8, 9, 5, 0))`)).toBe(true);
    expect(py(`m.cron_matches('0 5 * * 0', datetime.datetime(2026, 8, 10, 5, 0))`)).toBe(false);
  });

  it('matches the weekly post run on Monday only', () => {
    expect(py(`m.cron_matches('30 8 * * 1', datetime.datetime(2026, 8, 10, 8, 30))`)).toBe(true);
    expect(py(`m.cron_matches('30 8 * * 1', datetime.datetime(2026, 8, 9, 8, 30))`)).toBe(false);
  });

  it('ORs day-of-month with day-of-week when both are restricted, as cron does', () => {
    // 1st of the month OR a Monday.
    expect(py(`m.cron_matches('0 6 1 * 1', datetime.datetime(2026, 9, 1, 6, 0))`)).toBe(true);
    expect(py(`m.cron_matches('0 6 1 * 1', datetime.datetime(2026, 8, 10, 6, 0))`)).toBe(true);
    expect(py(`m.cron_matches('0 6 1 * 1', datetime.datetime(2026, 8, 11, 6, 0))`)).toBe(false);
  });

  it('handles lists and steps', () => {
    // Batched into one interpreter start: each py() call is a fresh python3.
    expect(py(`[
      m.cron_matches('30 7,14 * * *', datetime.datetime(2026, 8, 6, 14, 30)),
      m.cron_matches('30 7,14 * * *', datetime.datetime(2026, 8, 6, 9, 30)),
      m.cron_matches('*/15 * * * *', datetime.datetime(2026, 8, 6, 9, 45)),
      m.cron_matches('*/15 * * * *', datetime.datetime(2026, 8, 6, 9, 46))
    ]`)).toEqual([true, false, true, false]);
  }, 20000);

  it('finds the last scheduled occurrence, skipping non-matching days', () => {
    // Sunday 09:00 looking back at a Mon-Fri 05:00 job lands on Friday.
    const got = py(`m.last_scheduled('0 5 * * 1-5', datetime.datetime(2026, 8, 9, 9, 0)).isoformat()`);
    expect(got).toBe('2026-08-07T05:00:00');
  });
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------
describe('staleness cut-off', () => {
  it('skips a nightly sweep that would run in the morning', () => {
    const r = run(['acquire', 'nightly-sweep'], {});
    // 02:00 job with a 180 minute limit. Stale unless the clock is before 05:00.
    const hour = new Date().getHours();
    if (hour >= 5) {
      expect(r.code).toBe(3);
      expect(r.stdout).toMatch(/SKIPPED/);
      expect(events().at(-1).state).toBe('skipped-stale');
    } else {
      expect(r.code).toBe(0);
    }
    run(['release', 'nightly-sweep']);
  });

  it('does not skip a job whose limit is generous', () => {
    const r = run(['acquire', 'forgiving-job']);
    expect(r.code).toBe(0);
    run(['release', 'forgiving-job']);
  });

  it('never skips a job that is missing from the config', () => {
    // A job absent from the schedule is a config bug. Silently dropping it
    // would reproduce the disappearing-evidence problem this replaces.
    const r = run(['acquire', 'job-nobody-configured']);
    expect(r.code).toBe(0);
    run(['release', 'job-nobody-configured']);
  });

  it('honours --no-stale-check', () => {
    const r = run(['acquire', 'nightly-sweep', '--no-stale-check']);
    expect(r.code).toBe(0);
    run(['release', 'nightly-sweep']);
  });

  it('records a skip as skipped, never as a success', () => {
    // maxLateMinutes 0 rather than the 02:00 job, so this cannot pass or fail
    // depending on what time the suite happens to run.
    writeFileSync(schedulePath, JSON.stringify({
      'always-stale': { cron: '0 2 * * *', maxLateMinutes: 0, mode: 'cooperative' },
    }));
    expect(run(['acquire', 'always-stale']).code).toBe(3);
    const states = events().map((e) => e.state);
    expect(states).not.toContain('acquired');
    expect(events().every((e) => e.ok !== true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The core promise: one at a time.
// ---------------------------------------------------------------------------
describe('serialisation under real concurrency', () => {
  it('runs five simultaneous jobs strictly one at a time', async () => {
    const jobs = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    const results = await Promise.all(jobs.map((j) =>
      runAsync(['run', j, '--no-stale-check', '--timeout', '2', '--',
        'python3', '-c', 'import time; time.sleep(0.6)'])));

    expect(results.every((r) => r.code === 0)).toBe(true);

    // Reconstruct each job's held interval and assert no two overlap.
    const held = [];
    const openAt = {};
    for (const e of events()) {
      if (e.state === 'acquired') openAt[e.job] = e.ts;
      if (e.state === 'released' && openAt[e.job]) {
        held.push({ job: e.job, from: openAt[e.job], to: e.ts });
        delete openAt[e.job];
      }
    }
    expect(held).toHaveLength(5);

    const acquiredOrder = events().filter((e) => e.state === 'acquired').map((e) => e.job);
    expect(new Set(acquiredOrder).size).toBe(5);

    // Between any acquired and its release, no other job may be acquired.
    const seq = events().filter((e) => ['acquired', 'released'].includes(e.state));
    let holder = null;
    for (const e of seq) {
      if (e.state === 'acquired') {
        expect(holder).toBeNull();
        holder = e.job;
      } else {
        expect(holder).toBe(e.job);
        holder = null;
      }
    }
    expect(holder).toBeNull();
  }, 60000);

  it('reports a queue depth, proving jobs actually waited', async () => {
    const jobs = ['one', 'two', 'three'];
    await Promise.all(jobs.map((j) =>
      runAsync(['run', j, '--no-stale-check', '--timeout', '2', '--',
        'python3', '-c', 'import time; time.sleep(0.5)'])));
    const queued = events().filter((e) => e.state === 'queued');
    expect(queued.length).toBeGreaterThan(0);
  }, 60000);

  it('gives up with EX_TEMPFAIL rather than running alongside a holder', async () => {
    // Take the lock cooperatively and leave it held.
    expect(run(['acquire', 'holder', '--no-stale-check', '--lease', '10']).code).toBe(0);
    const r = await runAsync(['acquire', 'latecomer', '--no-stale-check', '--timeout', '0.02']);
    expect(r.code).toBe(75);
    expect(events().some((e) => e.state === 'queue-timeout' && e.job === 'latecomer')).toBe(true);
    expect(events().some((e) => e.state === 'acquired' && e.job === 'latecomer')).toBe(false);
    run(['release', 'holder']);
  }, 60000);
});

// ---------------------------------------------------------------------------
// A crashed routine must not block tomorrow.
// ---------------------------------------------------------------------------
describe('stale lock recovery', () => {
  it('breaks a lock whose lease has expired', () => {
    // A cooperative holder exits immediately by design, so only the lease can
    // free it. A zero lease is an already-dead holder.
    expect(run(['acquire', 'crashed', '--no-stale-check', '--lease', '0']).code).toBe(0);
    const r = run(['acquire', 'next-day', '--no-stale-check', '--timeout', '1']);
    expect(r.code).toBe(0);
    expect(events().some((e) => e.state === 'lock-broken')).toBe(true);
    run(['release', 'next-day']);
  });

  it('does NOT break a cooperative lock on PID liveness alone', () => {
    // The shell that ran acquire is already gone. Freeing on that basis would
    // release the lock the instant it was taken, which is the whole bug.
    expect(run(['acquire', 'live-session', '--no-stale-check', '--lease', '30']).code).toBe(0);
    const r = run(['acquire', 'intruder', '--no-stale-check', '--timeout', '0.02']);
    expect(r.code).toBe(75);
    run(['release', 'live-session']);
  });

  it('refuses to let one job release another job lock', () => {
    run(['acquire', 'owner', '--no-stale-check', '--lease', '30']);
    const r = run(['release', 'someone-else']);
    expect(r.code).toBe(64);
    expect(run(['status']).stdout).toMatch(/HELD by owner/);
    run(['release', 'owner']);
  });

  it('extends a lease on heartbeat', () => {
    run(['acquire', 'long-runner', '--no-stale-check', '--lease', '0.001']);
    expect(run(['heartbeat', 'long-runner', '--lease', '30']).code).toBe(0);
    const r = run(['acquire', 'other', '--no-stale-check', '--timeout', '0.02']);
    expect(r.code).toBe(75);
    run(['release', 'long-runner']);
  });

  it('always releases the lock when a wrapped job fails', () => {
    const r = run(['run', 'failing', '--no-stale-check', '--',
      'python3', '-c', 'import sys; sys.exit(9)']);
    expect(r.code).toBe(9);
    expect(run(['status']).stdout).toMatch(/FREE/);
  });
});

// ---------------------------------------------------------------------------
// The control. A queue that ran nothing must be loud, not quiet.
// ---------------------------------------------------------------------------
describe('the queue log is evidence', () => {
  it('writes an event for every outcome, so silence means broken', () => {
    run(['acquire', 'evidence', '--no-stale-check']);
    run(['release', 'evidence']);
    const states = events().map((e) => e.state);
    expect(states).toContain('acquired');
    expect(states).toContain('released');
  });

  it('records held duration on release', () => {
    run(['acquire', 'timed', '--no-stale-check']);
    run(['release', 'timed']);
    const rel = events().find((e) => e.state === 'released');
    expect(typeof rel.held_seconds).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Findings queue
// ---------------------------------------------------------------------------
describe('findings queue', () => {
  let findingsFile;
  function fin(args) {
    try {
      return {
        code: 0,
        stdout: execFileSync('python3', [FINDINGS, ...args], {
          env: { ...process.env, FINDINGS_FILE: findingsFile }, encoding: 'utf8',
        }),
      };
    } catch (e) {
      return { code: e.status, stdout: (e.stdout || '') + (e.stderr || '') };
    }
  }

  beforeEach(() => { findingsFile = join(stateDir, 'findings.jsonl'); });

  it('round-trips add, list, claim and close', () => {
    const id = fin(['add', '--routine', 'drift-monitor', '--title', 'Dead field ref',
      '--where', 'js/config.js:42', '--fix', 'remove it', '--severity', 'high',
      '--touches-code']).stdout.trim();
    expect(id).toMatch(/drift-monitor-001$/);

    expect(fin(['count', '--status', 'open']).stdout.trim()).toBe('1');
    expect(fin(['claim', id, '--by', 'queue-fixer']).code).toBe(0);
    expect(fin(['count', '--status', 'open']).stdout.trim()).toBe('0');
    expect(fin(['count', '--status', 'claimed']).stdout.trim()).toBe('1');

    expect(fin(['close', id, '--outcome', 'fixed', '--note', 'PR #99']).code).toBe(0);
    expect(fin(['count', '--status', 'fixed']).stdout.trim()).toBe('1');
  });

  it('refuses to claim a finding twice, so two fixers cannot both take it', () => {
    const id = fin(['add', '--routine', 'sweep', '--title', 'x']).stdout.trim();
    expect(fin(['claim', id, '--by', 'a']).code).toBe(0);
    expect(fin(['claim', id, '--by', 'b']).code).not.toBe(0);
  });

  it('survives concurrent appends without losing a finding', () => {
    // Append-only exists so two routines writing at once cannot truncate each
    // other. Proven by writing from several processes at the same moment.
    const procs = Array.from({ length: 8 }, (_, i) =>
      new Promise((res) => execFile('python3',
        [FINDINGS, 'add', '--routine', `r${i}`, '--title', `finding ${i}`],
        { env: { ...process.env, FINDINGS_FILE: findingsFile } }, () => res())));
    return Promise.all(procs).then(() => {
      expect(fin(['count']).stdout.trim()).toBe('8');
    });
  }, 30000);

  it('sorts open findings by severity so the fixer works the worst first', () => {
    fin(['add', '--routine', 'a', '--title', 'low one', '--severity', 'low']);
    fin(['add', '--routine', 'b', '--title', 'critical one', '--severity', 'critical']);
    const out = fin(['list', '--status', 'open']).stdout;
    expect(out.indexOf('critical one')).toBeLessThan(out.indexOf('low one'));
  });
});

// ---------------------------------------------------------------------------
// The morning digest. The risk this whole feature introduces is a queue that
// quietly stops running everything, so the digest must treat silence as an
// alarm rather than as a clean sweep.
// ---------------------------------------------------------------------------
describe('morning digest', () => {
  const DIGEST = resolve(__dirname, '../scripts/morning-digest.py');
  let logDir;

  function digest(extraEnv = {}) {
    const e = {
      ...process.env,
      JOB_LOG_DIR: logDir,
      JOB_QUEUE_DIR: stateDir,
      JOB_QUEUE_SCHEDULE: schedulePath,
      FINDINGS_FILE: join(logDir, 'findings-queue.jsonl'),
      // Off by default here: most fixtures use a per-minute cron, which the
      // real 45 minute grace window would exclude entirely.
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
    // A job due every minute is always inside the 26 hour window.
    writeFileSync(schedulePath, JSON.stringify({
      'always-due': { cron: '* * * * *', maxLateMinutes: 60, mode: 'wrapped' },
    }));
  });

  it('treats an empty queue log as an alarm, not as all clear', () => {
    const r = digest();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/recorded nothing/i);
    expect(r.out).not.toMatch(/white_check_mark/);
  });

  it('flags a job that was due but left no record', () => {
    run(['acquire', 'unrelated', '--no-stale-check']);
    run(['release', 'unrelated']);
    const r = digest();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/always-due.*no run recorded/);
  });

  it('reports a skipped job as skipped, never as worked', () => {
    writeFileSync(schedulePath, JSON.stringify({
      'always-due': { cron: '0 2 * * *', maxLateMinutes: 0, mode: 'cooperative' },
    }));
    expect(run(['acquire', 'always-due']).code).toBe(3);
    const r = digest();
    expect(r.out).toMatch(/skipped/);
    expect(r.out).not.toMatch(/Worked: .*always-due/);
  });

  it('counts a job that acquired the lock as having run', () => {
    expect(run(['acquire', 'always-due', '--no-stale-check']).code).toBe(0);
    run(['release', 'always-due']);
    const r = digest();
    expect(r.out).toMatch(/Worked: .*always-due/);
    expect(r.code).toBe(0);
  });

  it('surfaces open high-severity findings and raises the alarm', () => {
    run(['acquire', 'always-due', '--no-stale-check']);
    run(['release', 'always-due']);
    execFileSync('python3', [FINDINGS, 'add', '--routine', 'drift-monitor',
      '--title', 'Dead field reference', '--severity', 'critical'],
      { env: { ...process.env, FINDINGS_FILE: join(logDir, 'findings-queue.jsonl') } });
    const r = digest();
    expect(r.out).toMatch(/Findings waiting for the fixer: 1/);
    expect(r.out).toMatch(/Dead field reference/);
    expect(r.code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The lock is built complete and renamed into place. An earlier version made
// the directory first and wrote the holder file second, which left a window
// where every waiter read "held by nobody" and the ownerless-lock rule could
// then block the queue for two minutes. Caught in a live five-job run.
// ---------------------------------------------------------------------------
describe('lock is never observed half-made', () => {
  it('always has a readable holder the moment it exists', async () => {
    const lockDir = join(stateDir, 'lock');
    const holder = join(lockDir, 'holder.json');
    let sawOrphan = false;

    const watcher = setInterval(() => {
      if (existsSync(lockDir) && !existsSync(holder)) sawOrphan = true;
    }, 1);

    await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((j) =>
      runAsync(['run', j, '--no-stale-check', '--timeout', '2', '--',
        'python3', '-c', 'import time; time.sleep(0.2)'])));

    clearInterval(watcher);
    expect(sawOrphan).toBe(false);
  });

  it('leaves no staging or dropped directories behind', () => {
    run(['acquire', 'tidy', '--no-stale-check']);
    run(['release', 'tidy']);
    const leftovers = readdirSync(stateDir).filter((n) => n.startsWith('.'));
    expect(leftovers).toEqual([]);
    expect(run(['status']).stdout).toMatch(/FREE/);
  });
});

// ---------------------------------------------------------------------------
// Digest edge cases that would otherwise make it cry wolf daily.
// ---------------------------------------------------------------------------
describe('digest noise control', () => {
  const DIGEST = resolve(__dirname, '../scripts/morning-digest.py');
  let logDir;

  function digest(extraEnv = {}) {
    const e = {
      ...process.env, JOB_LOG_DIR: logDir, JOB_QUEUE_DIR: stateDir,
      JOB_QUEUE_SCHEDULE: schedulePath,
      FINDINGS_FILE: join(logDir, 'findings-queue.jsonl'),
      // Off by default here: most fixtures use a per-minute cron, which the
      // real 45 minute grace window would exclude entirely.
      DIGEST_GRACE_MINUTES: '0',
      ...extraEnv,
    };
    try {
      return { code: 0, out: execFileSync('python3', [DIGEST, '--no-post'], { env: e, encoding: 'utf8' }) };
    } catch (err) {
      return { code: err.status, out: (err.stdout || '') + (err.stderr || '') };
    }
  }

  beforeEach(() => { logDir = mkdtempSync(join(ROOT, 'logs2-')); });

  it('ignores a job switched off in the scheduler', () => {
    writeFileSync(schedulePath, JSON.stringify({
      'paused-task': { cron: '* * * * *', maxLateMinutes: 60, enabled: false },
      'live-task': { cron: '* * * * *', maxLateMinutes: 60 },
    }));
    run(['acquire', 'live-task', '--no-stale-check']);
    run(['release', 'live-task']);
    const r = digest();
    expect(r.out).not.toMatch(/paused-task/);
    expect(r.out).toMatch(/live-task/);
  });

  it('does not flag a job that was only just due and may still be queued', () => {
    // Due every minute, so its last occurrence is inside the grace period.
    writeFileSync(schedulePath, JSON.stringify({
      'just-due': { cron: '* * * * *', maxLateMinutes: 600 },
      'long-ago': { cron: '0 2 * * *', maxLateMinutes: 600 },
    }));
    run(['acquire', 'other', '--no-stale-check']);
    run(['release', 'other']);
    const r = digest({ DIGEST_GRACE_MINUTES: '45' });
    expect(r.out).not.toMatch(/just-due/);
    expect(r.out).toMatch(/long-ago/);   // outside the grace window, still flagged
  });
});
