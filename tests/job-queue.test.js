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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, chmodSync, appendFileSync } from 'node:fs';
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
    // Time-independent on purpose. The old version branched on the clock and
    // assumed "before 05:00" meant fresh — but before 02:00 the last firing was
    // YESTERDAY, so it failed for two hours every night. A test that is red
    // between midnight and 02:00 is how a gate loses its authority.
    //
    // Fixed window instead: a 02:00 job asked about at 09:00 the same day is
    // seven hours late against a 180 minute limit.
    const late = py(`m.staleness('nightly-sweep', m.load_schedule(),
                       ref=datetime.datetime(2026, 8, 6, 9, 0))[0]`);
    expect(late).toBe(true);
    const onTime = py(`m.staleness('nightly-sweep', m.load_schedule(),
                       ref=datetime.datetime(2026, 8, 6, 3, 0))[0]`);
    expect(onTime).toBe(false);
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
// "Has it already run today?"
//
// Regression origin: 19 Aug 2026. daily-ops stamped its end mark at 14:12:19Z
// and a second FULL run started at 14:22:56Z — ten minutes later — because
// nothing ever asked the question (finding 20260819-daily-ops-252). Phase 9
// deletes the progress file on purpose so tomorrow starts clean, so the only
// durable evidence is the queue log's mark events.
// ---------------------------------------------------------------------------
describe('rantoday', () => {
  function withEvents(events) {
    writeFileSync(join(stateDir, 'queue-events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  const mark = (ts, note = '', job = 'daily-ops') => ({ ts, job, state: 'mark', note });

  it('refuses a second run once today has an end mark — the 19 Aug case exactly', () => {
    withEvents([
      mark('2026-08-19T11:14:49.535Z'),
      mark('2026-08-19T14:12:19.316Z', 'end'),
    ]);
    const blocked = run(['rantoday', 'daily-ops', '--now', '2026-08-19T14:22:56Z']);
    expect(blocked.code).toBe(3);
    expect(blocked.stdout).toMatch(/ALREADY RAN TODAY/);

    // One minute before that end mark the same day was still open.
    expect(run(['rantoday', 'daily-ops', '--now', '2026-08-19T14:12:00Z']).code).toBe(0);
  });

  it('a start with no end stays resumable, because a dead run must not lock out the day', () => {
    withEvents([mark('2026-08-20T06:06:35.274Z')]);
    expect(run(['rantoday', 'daily-ops', '--now', '2026-08-20T09:00:00Z']).code).toBe(0);
  });

  it("yesterday's end mark does not close today", () => {
    withEvents([mark('2026-08-19T14:12:19.316Z', 'end')]);
    expect(run(['rantoday', 'daily-ops', '--now', '2026-08-20T06:00:00Z']).code).toBe(0);
  });

  it('counts the London day, not the UTC day', () => {
    // 23:30 UTC in BST is 00:30 the NEXT London day, so it closes the 20th, not the 19th.
    withEvents([mark('2026-08-19T23:30:00.000Z', 'end')]);
    expect(run(['rantoday', 'daily-ops', '--now', '2026-08-20T07:00:00Z']).code).toBe(3);
    expect(run(['rantoday', 'daily-ops', '--now', '2026-08-19T23:45:00Z']).code).toBe(3);
  });

  it("another job's end mark never blocks this one", () => {
    withEvents([mark('2026-08-20T06:00:00.000Z', 'end', 'prod-sweep')]);
    expect(run(['rantoday', 'daily-ops', '--now', '2026-08-20T09:00:00Z']).code).toBe(0);
  });

  it('an empty history is a safe start, not an error', () => {
    expect(run(['rantoday', 'daily-ops', '--now', '2026-08-20T09:00:00Z']).code).toBe(0);
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

    // 'fixed' needs evidence since 28 Aug 2026 (findings 262 / 266): a bare
    // note is exactly how 201, 203, 204 and 237 were closed as fixed on days
    // the files they named had zero commits. See
    // tests/findings-close-evidence.test.js.
    expect(fin(['close', id, '--outcome', 'fixed', '--note', 'PR #99']).code).not.toBe(0);
    expect(fin(['count', '--status', 'fixed']).stdout.trim()).toBe('0');

    expect(fin(['close', id, '--outcome', 'fixed', '--note', 'PR #99',
      '--evidence', 'verified by hand against the live board']).code).toBe(0);
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

  // A claim is a 12-hour LEASE. Before `reopen` existed, a fixer run that died
  // mid-run kept its findings for ever: `list --status open` cannot see a claimed
  // finding, so nine high-severity ones sat invisible from 14 to 20 Aug 2026
  // while every routine reported success (finding 20260820-daily-ops-254).
  function backdateClaim(id, hoursAgo) {
    const ts = new Date(Date.now() - hoursAgo * 3600 * 1000)
      .toISOString().replace(/\.\d+Z$/, 'Z');
    appendFileSync(findingsFile,
      JSON.stringify({ op: 'claim', id, ts, by: 'dead-run' }) + '\n');
  }

  it('reopen --stale hands back an expired claim and leaves a live one alone', () => {
    const dead = fin(['add', '--routine', 'drift', '--title', 'stale one',
      '--severity', 'high']).stdout.trim();
    const live = fin(['add', '--routine', 'drift', '--title', 'live one',
      '--severity', 'high']).stdout.trim();
    backdateClaim(dead, 20);
    fin(['claim', live, '--by', 'queue-fixer']);
    expect(fin(['count', '--status', 'claimed']).stdout.trim()).toBe('2');

    const out = fin(['reopen', '--stale']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('reopened 1');
    expect(out.stdout).toContain(dead);
    expect(out.stdout).not.toContain('live one');

    expect(fin(['count', '--status', 'claimed']).stdout.trim()).toBe('1');
    // The whole point: it is visible to the fixer again.
    expect(fin(['list', '--status', 'open']).stdout).toContain('stale one');
  });

  it('a reopened finding can be claimed again', () => {
    const id = fin(['add', '--routine', 'drift', '--title', 'retry me']).stdout.trim();
    backdateClaim(id, 20);
    expect(fin(['claim', id, '--by', 'b']).code).not.toBe(0);
    fin(['reopen', '--stale']);
    expect(fin(['claim', id, '--by', 'b']).code).toBe(0);
  });

  it('--dry-run reports without writing, so the count can be back-tested safely', () => {
    const id = fin(['add', '--routine', 'drift', '--title', 'dry']).stdout.trim();
    backdateClaim(id, 20);
    expect(fin(['reopen', '--stale', '--dry-run']).stdout).toContain('reopened 1');
    expect(fin(['count', '--status', 'claimed']).stdout.trim()).toBe('1');
    expect(fin(['reopen', '--stale']).stdout).toContain('reopened 1');
    expect(fin(['count', '--status', 'claimed']).stdout.trim()).toBe('0');
    expect(id).toBeTruthy();
  });

  it('reopen --stale exits 0 and says nothing was reopened when nothing is stale', () => {
    fin(['add', '--routine', 'drift', '--title', 'fresh']);
    const out = fin(['reopen', '--stale']);
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe('reopened 0 finding(s)');
  });

  it('reopen <id> refuses a finding that is not claimed', () => {
    const id = fin(['add', '--routine', 'drift', '--title', 'open one']).stdout.trim();
    expect(fin(['reopen', id]).code).not.toBe(0);
    fin(['claim', id, '--by', 'x']);
    expect(fin(['reopen', id]).code).toBe(0);
    expect(fin(['list', '--status', 'open']).stdout).toContain('open one');
  });

  it('sorts open findings by severity so the fixer works the worst first', () => {
    fin(['add', '--routine', 'a', '--title', 'low one', '--severity', 'low']);
    fin(['add', '--routine', 'b', '--title', 'critical one', '--severity', 'critical']);
    const out = fin(['list', '--status', 'open']).stdout;
    expect(out.indexOf('critical one')).toBeLessThan(out.indexOf('low one'));
  });

  // ── The claim lease (20260819-daily-ops-217) ──────────────────────────────
  //
  // A claim used to be permanent, so a fixer run that died after claiming took
  // its findings with it: invisible to `list --status open`, never picked up
  // again. Nine findings sat that way for 124.9 hours. daily-ops phase 1 had
  // been calling `findings.py reopen --stale` since 14 Aug against a subcommand
  // that did not exist — argparse printed 'invalid choice' and the run carried
  // on, so the repair looked done for five days.
  describe('stale claims come back to the queue', () => {
    // Back-dates the claim op in the log, which is what a dead run leaves.
    function ageClaim(id, hours) {
      const lines = readFileSync(findingsFile, 'utf8').trim().split('\n').map(JSON.parse);
      const when = new Date(Date.now() - hours * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
      for (const r of lines) if (r.op === 'claim' && r.id === id) r.ts = when;
      writeFileSync(findingsFile, lines.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }

    it('the reopen subcommand exists at all', () => {
      // The whole failure was argparse rejecting it while the run continued.
      expect(fin(['reopen', '--stale']).stdout).not.toMatch(/invalid choice/);
    });

    it('reopens a claim older than the 12-hour lease and leaves a fresh one alone', () => {
      const stale = fin(['add', '--routine', 'a', '--title', 'abandoned']).stdout.trim();
      const fresh = fin(['add', '--routine', 'b', '--title', 'in progress']).stdout.trim();
      fin(['claim', stale, '--by', 'queue-fixer']);
      fin(['claim', fresh, '--by', 'queue-fixer']);
      ageClaim(stale, 125);
      ageClaim(fresh, 1);

      const out = fin(['reopen', '--stale']).stdout;
      expect(out).toContain(`reopened ${stale}`);
      expect(out).not.toContain(`reopened ${fresh}`);
      // Printed every run, zero included, so a dead fixer is visible.
      expect(out).toMatch(/reopened 1 finding\(s\)/);

      expect(fin(['list', '--status', 'open']).stdout).toContain('abandoned');
      expect(fin(['list', '--status', 'claimed']).stdout).toContain('in progress');
    });

    it('a reopened finding can be claimed again', () => {
      const id = fin(['add', '--routine', 'a', '--title', 'again']).stdout.trim();
      fin(['claim', id, '--by', 'dead-run']);
      ageClaim(id, 99);
      fin(['reopen', '--stale']);
      expect(fin(['claim', id, '--by', 'next-run']).code).toBe(0);
    });

    it('reopens an explicit id whatever its age, for a run known to be dead', () => {
      const id = fin(['add', '--routine', 'a', '--title', 'known dead']).stdout.trim();
      fin(['claim', id, '--by', 'dead-run']);
      expect(fin(['reopen', id]).code).toBe(0);
      expect(fin(['list', '--status', 'open']).stdout).toContain('known dead');
    });

    it('refuses an id that is not claimed, and refuses id plus --stale', () => {
      const id = fin(['add', '--routine', 'a', '--title', 'untouched']).stdout.trim();
      expect(fin(['reopen', id]).code).not.toBe(0);
      fin(['claim', id, '--by', 'x']);
      expect(fin(['reopen', id, '--stale']).code).not.toBe(0);
      expect(fin(['reopen']).code).not.toBe(0);
    });

    it('an undateable claim is reopened and said so, never held for ever', () => {
      // parse_ts returning now() on a bad stamp would make a stale claim look
      // fresh permanently — the exact failure the lease exists to end.
      const id = fin(['add', '--routine', 'a', '--title', 'bad stamp']).stdout.trim();
      fin(['claim', id, '--by', 'x']);
      const lines = readFileSync(findingsFile, 'utf8').trim().split('\n').map(JSON.parse);
      for (const r of lines) if (r.op === 'claim' && r.id === id) r.ts = 'not a date';
      writeFileSync(findingsFile, lines.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const out = fin(['reopen', '--stale']).stdout;
      expect(out).toContain('no readable timestamp');
      expect(out).toContain(`reopened ${id}`);
    });
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
    let sawOrphan = false;

    // ONE snapshot of the directory, never two separate existence checks.
    //
    // This watcher used to ask existsSync(lockDir) and then existsSync(holder).
    // Release renames the whole lock directory away in a single atomic step, so
    // a release landing between those two syscalls answers "the directory is
    // there" and then "the holder is not" — which is indistinguishable from a
    // half-made lock, while nothing was ever half-made. It failed approximately
    // one run in six under load and passed alone, so it read as a mystery
    // rather than a flake. Caught 28 Aug 2026 by instrumenting the watcher: at
    // the moment it flagged, the lock was already gone (stillThere:false,
    // readdir ENOENT), and a single-snapshot check saw nothing all run.
    //
    // readdirSync answers both questions at once. ENOENT means the lock is not
    // there, which is not an orphan; a listing means it really is there, and
    // only then does a missing holder.json mean what this test is looking for.
    const orphaned = () => {
      try { return !readdirSync(lockDir).includes('holder.json'); }
      catch { return false; }
    };

    const watcher = setInterval(() => { if (orphaned()) sawOrphan = true; }, 1);

    await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((j) =>
      runAsync(['run', j, '--no-stale-check', '--timeout', '2', '--',
        'python3', '-c', 'import time; time.sleep(0.2)'])));

    clearInterval(watcher);
    expect(sawOrphan).toBe(false);

    // CONTROL. A watcher that can no longer SEE a half-made lock would pass
    // this test for ever by detecting nothing at all, which is the failure mode
    // that makes a green suite worthless. Build the exact shape the original
    // bug produced — the directory present, the holder missing — and require
    // the check to catch it.
    mkdirSync(lockDir, { recursive: true });
    expect(orphaned(), 'the orphan check stopped detecting a real half-made lock').toBe(true);
    rmSync(lockDir, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// Some jobs run outside the queue on purpose (the digest, the process reaper).
// They must still be watched: a job left out of the schedule entirely is a job
// nobody notices has stopped.
// ---------------------------------------------------------------------------
describe('the real job-schedule.json', () => {
  const REAL = JSON.parse(readFileSync(resolve(__dirname, '../scripts/job-schedule.json'), 'utf8'));
  const jobs = Object.entries(REAL).filter(([k]) => !k.startsWith('_'));

  it('gives every job a parseable cron and a lateness limit', () => {
    for (const [name, cfg] of jobs) {
      expect(cfg.cron, `${name} has no cron`).toBeTruthy();
      expect(cfg.cron.split(' ')).toHaveLength(5);
      expect(typeof cfg.maxLateMinutes, `${name} has no maxLateMinutes`).toBe('number');
    }
  });

  it('resolves a last-scheduled time for every cron', () => {
    const crons = jobs.map(([, c]) => c.cron);
    const resolved = py(`[m.last_scheduled(c) is not None for c in ${JSON.stringify(crons)}]`);
    expect(resolved.every(Boolean)).toBe(true);
  });

  it('watches the jobs that deliberately bypass the queue', () => {
    // Both exist to report on or clean up after everything else, so they run
    // unqueued. Being unqueued must not mean being unwatched.
    const unqueued = jobs.filter(([, c]) => c.queued === false).map(([n]) => n);
    expect(unqueued).toContain('job-digest');
    expect(unqueued).toContain('mac-guard');
  });

  it('gives obligations more slack than sweeps', () => {
    // A nightly sweep landing mid-morning is noise. A Universal Credit check
    // Mica needs is worth sending late.
    expect(REAL['drift-monitor'].maxLateMinutes)
      .toBeLessThan(REAL['uc-check-slack-notifier'].maxLateMinutes);
    expect(REAL['monthly-rent-due-date'].maxLateMinutes).toBeGreaterThanOrEqual(1440);
  });
});

// ---------------------------------------------------------------------------
// last_scheduled originally stepped back a minute at a time over 96 hours, so
// it returned None for anything rarer than every four days. That made the
// staleness guard inert for the monthly rent job and the quarterly review, and
// hid both from the digest, which only watches jobs it can date.
// ---------------------------------------------------------------------------
describe('last_scheduled reaches back far enough', () => {
  it('dates a monthly cron from mid-month', () => {
    expect(py(`m.last_scheduled('0 6 1 * *', datetime.datetime(2026, 8, 20, 9, 0)).isoformat()`))
      .toBe('2026-08-01T06:00:00');
  });

  it('dates a quarterly cron from months later', () => {
    expect(py(`m.last_scheduled('7 9 1 1,4,7,10 *', datetime.datetime(2026, 9, 30, 9, 0)).isoformat()`))
      .toBe('2026-07-01T09:07:00');
  });

  it('crosses a year boundary', () => {
    expect(py(`m.last_scheduled('7 9 1 1,4,7,10 *', datetime.datetime(2026, 2, 3, 0, 0)).isoformat()`))
      .toBe('2026-01-01T09:07:00');
  });

  it('picks the latest occurrence on the day, not the earliest', () => {
    // Twice-daily dispatch at 07:30 and 14:30, asked at 20:00.
    expect(py(`m.last_scheduled('30 7,14 * * *', datetime.datetime(2026, 8, 6, 20, 0)).isoformat()`))
      .toBe('2026-08-06T14:30:00');
    // ...and the morning one when asked at noon.
    expect(py(`m.last_scheduled('30 7,14 * * *', datetime.datetime(2026, 8, 6, 12, 0)).isoformat()`))
      .toBe('2026-08-06T07:30:00');
  });

  it('rolls back to the previous day before the first firing', () => {
    expect(py(`m.last_scheduled('0 2 * * *', datetime.datetime(2026, 8, 6, 1, 0)).isoformat()`))
      .toBe('2026-08-05T02:00:00');
  });

  it('still honours day-of-week when walking days', () => {
    // Sunday, looking back at a Mon-Fri job: must land on Friday, not Saturday.
    expect(py(`m.last_scheduled('0 5 * * 1-5', datetime.datetime(2026, 8, 9, 9, 0)).isoformat()`))
      .toBe('2026-08-07T05:00:00');
  });
});

// ---------------------------------------------------------------------------
// Readiness. Five of the seven jobs that failed every morning were not broken:
// they fired the instant the Mac woke, before the network and Google Drive were
// up. Waiting fixes them. But waiting on a condition that never clears would
// turn a loud daily failure into a job that silently never runs, so the two
// cases have to be told apart.
// ---------------------------------------------------------------------------
describe('readiness preconditions', () => {
  const VAULT = () => join(stateDir, 'vault');

  function pyq(expr) {
    const src = `
import importlib.util, json, os, errno
spec = importlib.util.spec_from_file_location('jq', ${JSON.stringify(QUEUE)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(${expr}))
`;
    return JSON.parse(execFileSync('python3', ['-c', src], { encoding: 'utf8', env: env() }).trim());
  }

  it('reports an unresolvable host as not ready', () => {
    const [ok] = pyq(`list(m.network_ready('no-such-host.invalid', 443, 2))`);
    expect(ok).toBe(false);
  });

  it('treats a missing or empty Drive folder as not ready', () => {
    expect(pyq(`m.drive_ready(${JSON.stringify(join(stateDir, 'nope'))})[0]`)).toBe(false);
    mkdirSync(VAULT(), { recursive: true });
    expect(pyq(`m.drive_ready(${JSON.stringify(VAULT())})[0]`)).toBe(false);
  });

  it('treats a populated readable folder as ready', () => {
    mkdirSync(VAULT(), { recursive: true });
    writeFileSync(join(VAULT(), 'note.md'), 'hello');
    expect(pyq(`m.drive_ready(${JSON.stringify(VAULT())})[0]`)).toBe(true);
  });

  it('treats Errno 11 "Resource deadlock avoided" as NOT ready', () => {
    // The exact error Google Drive raises when mounted but not serving. It is
    // what took out publish-brain and compound-brain.
    mkdirSync(VAULT(), { recursive: true });
    writeFileSync(join(VAULT(), 'note.md'), 'hello');
    const src = `
import importlib.util, json, builtins, errno
spec = importlib.util.spec_from_file_location('jq', ${JSON.stringify(QUEUE)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
real = builtins.open
def boom(path, *a, **k):
    if str(path).endswith('note.md'):
        raise OSError(errno.EDEADLK, 'Resource deadlock avoided')
    return real(path, *a, **k)
builtins.open = boom
print(json.dumps(list(m.drive_ready(${JSON.stringify(VAULT())}))))
`;
    const [ok, why] = JSON.parse(execFileSync('python3', ['-c', src], { encoding: 'utf8', env: env() }).trim());
    expect(ok).toBe(false);
    expect(why).toMatch(/deadlock/i);
  });

  it('does NOT defer on a permission error, which waiting never fixes', () => {
    // A process without the macOS privacy grant for CloudStorage gets EPERM no
    // matter how long it waits. Deferring would turn a loud failure silent.
    mkdirSync(VAULT(), { recursive: true });
    const f = join(VAULT(), 'locked.md');
    writeFileSync(f, 'x');
    chmodSync(f, 0o000);
    const [ok, why] = pyq(`list(m.drive_ready(${JSON.stringify(VAULT())}))`);
    chmodSync(f, 0o644);
    expect(ok).toBe(true);
    expect(why).toMatch(/cannot probe/i);
  });

  it('rejects an unknown precondition rather than ignoring it', () => {
    expect(pyq(`list(m.preconditions_met({'needs': ['telepathy']}))`)[0]).toBe(false);
  });

  it('defers with exit 69 and never takes the lock when not ready', () => {
    writeFileSync(schedulePath, JSON.stringify({
      'needs-net': {
        cron: '* * * * *', maxLateMinutes: 600,
        needs: [{ drive: join(stateDir, 'missing-vault') }],
      },
    }));
    const r = run(['acquire', 'needs-net', '--ready-wait', '0']);
    expect(r.code).toBe(69);
    expect(run(['status']).stdout).toMatch(/FREE/);
    const ev = events().at(-1);
    expect(ev.state).toBe('deferred-not-ready');
    expect(events().some((e) => e.state === 'acquired')).toBe(false);
  });

  it('runs normally when the job declares no preconditions', () => {
    expect(run(['acquire', 'plain-job', '--no-stale-check']).code).toBe(0);
    run(['release', 'plain-job']);
  });
});

// ---------------------------------------------------------------------------
// A precondition checked before the queue wait is evidence about THEN.
//
// Preconditions are deliberately checked BEFORE the lock, so a job waiting for
// the network does not hold the queue shut. The gap that leaves: the wait is
// unbounded, and on this Mac the thing that CAUSES a long wait is sleep, which
// is also the thing that kills the network.
//
// 27 Aug 2026: handback-poll queued at 08:30 with the network up, waited 43
// minutes while the Mac slept, took the lock the instant it woke, and died on
// DNS ("nodename nor servname provided"). job-status.jsonl carries the same
// shape for compound-brain (x2), publish-brain, masterplan-sync and
// daily-ops-guard. Each one is a false alarm, and a false alarm repeated is how
// an alarm channel stops being read.
// ---------------------------------------------------------------------------
describe('a precondition can lapse during the queue wait', () => {
  const VAULT = () => join(stateDir, 'lapsing-vault');

  /** Schedule with one blocker and one job whose readiness we can revoke. */
  function scheduleWithVault() {
    writeFileSync(schedulePath, JSON.stringify({
      blocker: { cron: '* * * * *', maxLateMinutes: 600, mode: 'wrapped' },
      waiter: {
        cron: '* * * * *', maxLateMinutes: 600, mode: 'wrapped',
        needs: [{ drive: VAULT() }],
      },
    }));
    mkdirSync(VAULT(), { recursive: true });
    writeFileSync(join(VAULT(), 'note.md'), 'ready at queue time');
  }

  /** Re-check after 1s of waiting, and give the machine 0 min to recover. */
  const FAST = { JOB_QUEUE_RECHECK_AFTER: '1', JOB_QUEUE_POST_LOCK_WAIT: '0' };

  it('DEFERS instead of failing when readiness lapsed while it queued', async () => {
    scheduleWithVault();
    expect(run(['acquire', 'blocker', '--no-stale-check']).code).toBe(0);

    const waiter = runAsync(['acquire', 'waiter', '--no-stale-check'], { env: FAST });
    await new Promise((r) => setTimeout(r, 1500));

    // The machine changes under it, exactly as sleep does to the network.
    rmSync(VAULT(), { recursive: true, force: true });
    run(['release', 'blocker']);

    const r = await waiter;
    expect(r.code).toBe(69);                       // EX_NOTREADY, not a traceback
    expect(events().some((e) => e.state === 'deferred-stale-precondition')).toBe(true);
  });

  it('does not leave the queue shut behind it', async () => {
    scheduleWithVault();
    expect(run(['acquire', 'blocker', '--no-stale-check']).code).toBe(0);
    const waiter = runAsync(['acquire', 'waiter', '--no-stale-check'], { env: FAST });
    await new Promise((r) => setTimeout(r, 1500));
    rmSync(VAULT(), { recursive: true, force: true });
    run(['release', 'blocker']);
    await waiter;

    // Deferring happens AFTER the lock is taken, so a missing release would
    // hold the queue until the lease lapsed.
    expect(run(['status']).stdout).toMatch(/FREE/);
  });

  it('BACK-TEST: without the re-check it acquires on a machine that is not ready', async () => {
    // Same scenario, re-check pushed out of reach. This is the old behaviour,
    // and it is what handed the job a dead network to run against.
    scheduleWithVault();
    expect(run(['acquire', 'blocker', '--no-stale-check']).code).toBe(0);
    const waiter = runAsync(['acquire', 'waiter', '--no-stale-check'],
      { env: { JOB_QUEUE_RECHECK_AFTER: '99999', JOB_QUEUE_POST_LOCK_WAIT: '0' } });
    await new Promise((r) => setTimeout(r, 1500));
    rmSync(VAULT(), { recursive: true, force: true });
    run(['release', 'blocker']);

    const r = await waiter;
    expect(r.code).toBe(0);
    expect(events().some((e) => e.state === 'acquired' && e.job === 'waiter')).toBe(true);
    run(['release', 'waiter']);
  });

  it('proceeds when readiness survived the wait', async () => {
    // The re-check must not turn a healthy long wait into a deferral.
    scheduleWithVault();
    expect(run(['acquire', 'blocker', '--no-stale-check']).code).toBe(0);
    const waiter = runAsync(['acquire', 'waiter', '--no-stale-check'], { env: FAST });
    await new Promise((r) => setTimeout(r, 1500));
    run(['release', 'blocker']);            // vault left in place

    const r = await waiter;
    expect(r.code).toBe(0);
    run(['release', 'waiter']);
  });

  it('leaves a job with no preconditions alone, however long it waited', async () => {
    writeFileSync(schedulePath, JSON.stringify({
      blocker: { cron: '* * * * *', maxLateMinutes: 600, mode: 'wrapped' },
      waiter: { cron: '* * * * *', maxLateMinutes: 600, mode: 'wrapped' },
    }));
    expect(run(['acquire', 'blocker', '--no-stale-check']).code).toBe(0);
    const waiter = runAsync(['acquire', 'waiter', '--no-stale-check'], { env: FAST });
    await new Promise((r) => setTimeout(r, 1500));
    run(['release', 'blocker']);

    expect((await waiter).code).toBe(0);
    expect(events().some((e) => e.state === 'deferred-stale-precondition')).toBe(false);
    run(['release', 'waiter']);
  });

  it('does not re-probe after a short wait', () => {
    // The common case must keep its behaviour and its latency. Threshold left
    // at the 60s default: this job takes the lock immediately.
    scheduleWithVault();
    const r = run(['acquire', 'waiter', '--no-stale-check']);
    expect(r.code).toBe(0);
    expect(events().some((e) => e.state === 'waiting-for-ready')).toBe(false);
    run(['release', 'waiter']);
  });
});

// ---------------------------------------------------------------------------
// Queue capacity. A job that waits less time than a routine takes to run does
// not get serialised, it gets dropped.
// ---------------------------------------------------------------------------
describe('waiting longer than the work takes', () => {
  it('waits at least two hours by default', () => {
    // Observed 7 Aug 2026: queue-fixer held the lock 30+ minutes on its first
    // run and three jobs behind it gave up without ever running.
    const src = readFileSync(QUEUE, 'utf8');
    const m = src.match(/^DEFAULT_TIMEOUT_MIN\s*=\s*(\d+)/m);
    expect(m, 'DEFAULT_TIMEOUT_MIN not found').toBeTruthy();
    expect(Number(m[1])).toBeGreaterThanOrEqual(120);
  });

  it('still waits longer than the default lease, so a holder cannot outlast the queue', () => {
    const src = readFileSync(QUEUE, 'utf8');
    const timeout = Number(src.match(/^DEFAULT_TIMEOUT_MIN\s*=\s*(\d+)/m)[1]);
    const lease = Number(src.match(/^DEFAULT_LEASE_MIN\s*=\s*(\d+)/m)[1]);
    // If the wait were shorter than the lease, a single stuck holder would
    // time out everything behind it before its own lock even expired.
    expect(timeout).toBeGreaterThan(lease);
  });

  it('records a timeout as a timeout, never as a success', () => {
    expect(run(['acquire', 'holder', '--no-stale-check', '--lease', '10']).code).toBe(0);
    const r = run(['acquire', 'loser', '--no-stale-check', '--timeout', '0.02']);
    expect(r.code).toBe(75);
    const ev = events().filter((e) => e.job === 'loser');
    expect(ev.some((e) => e.state === 'queue-timeout')).toBe(true);
    expect(ev.some((e) => e.state === 'acquired')).toBe(false);
    run(['release', 'holder']);
  });
});

// ---------------------------------------------------------------------------
// The Mac sleeping mid-job is the failure that broke the queue. A suspended
// process is still ALIVE, so kill -0 passes and the lock stays held for the
// whole lease. drift-monitor held it 4h54m asleep on 8 Aug 2026 and everything
// behind it was skipped for lateness. The fix is a heartbeat, which a suspended
// process cannot fake.
// ---------------------------------------------------------------------------
describe('a sleeping job cannot hold the lock', () => {
  const src = () => readFileSync(QUEUE, 'utf8');

  it('gives wrapped jobs a short lease, not the long cooperative one', () => {
    const wrapped = Number(src().match(/^WRAPPED_LEASE_MIN\s*=\s*(\d+)/m)[1]);
    const coop = Number(src().match(/^DEFAULT_LEASE_MIN\s*=\s*(\d+)/m)[1]);
    expect(wrapped).toBeLessThan(coop);
    expect(wrapped).toBeLessThanOrEqual(10);
  });

  it('beats more often than the lease expires, or the lock drops mid-run', () => {
    // The interval is env-overridable for tests, so read the DEFAULT out of the
    // fallback rather than the literal.
    const m = src().match(/^HEARTBEAT_SECONDS\s*=.*?"(\d+(?:\.\d+)?)"\s*\)/m)
           || src().match(/^HEARTBEAT_SECONDS\s*=\s*(\d+)/m);
    expect(m, 'HEARTBEAT_SECONDS default not found').toBeTruthy();
    const beat = Number(m[1]);
    const lease = Number(src().match(/^WRAPPED_LEASE_MIN\s*=\s*(\d+)/m)[1]) * 60;
    // Needs real headroom: one missed beat must not free a live job's lock.
    expect(beat * 2).toBeLessThan(lease);
  });

  it('keeps the lease alive across a job that runs LONGER than its lease', async () => {
    // The job must outlive the lease or this proves nothing. 3s lease, 6s job,
    // beating every 0.5s: without the heartbeat the lease lapses at 3s and a
    // waiting job steals the lock mid-run.
    const slow = runAsync(['run', 'slow', '--no-stale-check', '--lease', '0.05',
      '--', 'python3', '-c', 'import time; time.sleep(6)'],
      { env: { JOB_QUEUE_HEARTBEAT: '0.5' } });
    await new Promise((r) => setTimeout(r, 4000));   // past the un-beaten expiry
    const stolen = run(['acquire', 'thief', '--no-stale-check', '--timeout', '0.02']);
    expect(stolen.code, 'the lease lapsed mid-run — heartbeat is not working').toBe(75);
    expect((await slow).code).toBe(0);
    expect(events().some((e) => e.state === 'lock-broken' && e.job === 'slow')).toBe(false);
  });

  it('lets the lease lapse when the heartbeat stops, which is what sleep does', async () => {
    // Same setup, heartbeat disabled: the lock MUST become stealable. This is
    // the back-test — without it the case above could pass for the wrong reason.
    const slow = runAsync(['run', 'frozen', '--no-stale-check', '--lease', '0.05',
      '--', 'python3', '-c', 'import time; time.sleep(6)'],
      { env: { JOB_QUEUE_HEARTBEAT: '600' } });
    await new Promise((r) => setTimeout(r, 4000));
    const stolen = run(['acquire', 'nextday', '--no-stale-check', '--timeout', '0.05']);
    expect(stolen.code, 'a dead holder still blocked the queue').toBe(0);
    run(['release', 'nextday']);
    await slow;
  });

  it('stops beating when the job ends, so the lock does not linger', () => {
    run(['run', 'quick', '--no-stale-check', '--', 'python3', '-c', 'pass']);
    expect(run(['status']).stdout).toMatch(/FREE/);
  });

  // -------------------------------------------------------------------------
  // Losing the lease was ADVISORY, which is the same as not having one.
  //
  // Finding 20260809-drift-028: the heartbeat thread noticed the lock was gone
  // and simply returned. The job carried on to completion, writing alongside
  // whoever now held the queue, and `heartbeat` reported the loss as exit 64 —
  // a usage error, indistinguishable from a typo in the arguments. Nothing
  // failed, nothing alarmed, and two writers is precisely what the queue exists
  // to prevent.
  // -------------------------------------------------------------------------

  it('kills a wrapped job whose lock was broken mid-run', async () => {
    const marker = join(stateDir, 'completed.txt');
    const body = `import time; time.sleep(8); open(${JSON.stringify(marker)}, 'w').write('done')`;
    const job = runAsync(['run', 'evicted', '--no-stale-check', '--lease', '5',
      '--', 'python3', '-c', body], { env: { JOB_QUEUE_HEARTBEAT: '0.3' } });

    // Somebody else takes the lock out from under it. Writing the holder file
    // directly is what a broken lock looks like from this process's side.
    await new Promise((r) => setTimeout(r, 1200));
    writeFileSync(join(stateDir, 'lock', 'holder.json'), JSON.stringify({
      job: 'thief', mode: 'wrapped', acquired_at: Date.now() / 1000,
      lease_until: Date.now() / 1000 + 3600,
    }));

    const r = await job;
    expect(r.code, 'a job that lost its lock still reported success').toBe(70);
    expect(existsSync(marker), 'the evicted job ran to completion anyway').toBe(false);
    expect(events().some((e) => e.state === 'lease-lost' && e.job === 'evicted'),
      'losing the lock was never recorded').toBe(true);
  });

  it('heartbeat reports a lost lock with its own exit code, not a usage error', () => {
    run(['acquire', 'holder-a', '--no-stale-check', '--lease', '30']);
    // 70, never 64: a caller that reads 64 as "I passed bad arguments" carries on.
    expect(run(['heartbeat', 'holder-b']).code).toBe(70);
    expect(run(['release', 'holder-a']).code).toBe(0);
  });

  it('assert-held passes while held and fails once the lock has gone', () => {
    run(['acquire', 'phased', '--no-stale-check', '--lease', '30']);
    expect(run(['assert-held', 'phased']).code).toBe(0);
    run(['release', 'phased']);
    const r = run(['assert-held', 'phased']);
    expect(r.code).toBe(70);
    expect(r.stdout).toMatch(/LOST LOCK/);
  });

  it('assert-held fails on an expired lease even while the lock still sits there', () => {
    // The lease is the promise. A holder that outlived it must not be told it is
    // fine merely because nothing has come along to reclaim the lock yet.
    run(['acquire', 'overrun', '--no-stale-check', '--lease', '30']);
    const holderFile = join(stateDir, 'lock', 'holder.json');
    const h = JSON.parse(readFileSync(holderFile, 'utf8'));
    h.lease_until = Date.now() / 1000 - 60;
    writeFileSync(holderFile, JSON.stringify(h));
    expect(run(['assert-held', 'overrun']).code).toBe(70);
    run(['release', 'overrun']);
  });
});

// ---------------------------------------------------------------------------
// One routine, not fourteen.
// ---------------------------------------------------------------------------
describe('the consolidated schedule', () => {
  const REAL = JSON.parse(readFileSync(resolve(__dirname, '../scripts/job-schedule.json'), 'utf8'));

  it('has daily-ops, unqueued and never skipped for lateness', () => {
    const d = REAL['daily-ops'];
    expect(d, 'daily-ops missing from the schedule').toBeTruthy();
    // It IS the daily run. Skipping it means nothing happens at all.
    expect(d.maxLateMinutes).toBeGreaterThanOrEqual(1440);
    // It runs for an hour or more; holding the lock would block the shell jobs.
    expect(d.queued).toBe(false);
  });

  it('leaves exactly one Claude routine enabled', () => {
    const claude = Object.entries(REAL)
      .filter(([k, v]) => !k.startsWith('_') && v.mode === 'cooperative' && v.enabled !== false)
      .map(([k]) => k);
    expect(claude).toEqual(['daily-ops']);
  });

  it('keeps the absorbed routines listed, so the digest does not cry wolf', () => {
    // A job deleted from this file is a job nobody notices has stopped. They
    // stay listed with enabled:false instead.
    for (const j of ['drift-monitor', 'prod-e2e-sweep', 'ceo-huddle', 'queue-fixer']) {
      expect(REAL[j], `${j} dropped from the schedule`).toBeTruthy();
      expect(REAL[j].enabled).toBe(false);
    }
  });

  it('still queues the short shell jobs', () => {
    const wrapped = Object.entries(REAL)
      .filter(([k, v]) => !k.startsWith('_') && v.mode === 'wrapped' && v.queued !== false);
    expect(wrapped.length).toBeGreaterThan(5);
  });
});
