// The reporter that stops a slept-through run reading as a failure.
//
// Back-tested against the real incident: overnight 10-11 Aug 2026 vitest
// reported "3 failed | 84 passed" on merged main and nothing was wrong with the
// code. The durations below are the actual ones from that run.

import { describe, it, expect } from 'vitest';
import {
  diagnose, banner, collectTasks, fullName,
  DURATION_CEILING_MS, SKEW_CEILING_MS,
} from './clock-skew-reporter.js';

/** Shape a vitest task tree the way the real reporter receives it. */
function file(name, tests) {
  const f = { name, type: 'suite', tasks: [] };
  f.tasks = tests.map(([suite, test, ms]) => {
    const s = { name: suite, type: 'suite', suite: f };
    return { name: test, type: 'test', suite: s, result: { duration: ms } };
  });
  return f;
}

const HEALTHY = [file('tests/job-queue.test.js', [
  ['serialisation under real concurrency', 'runs five simultaneous jobs strictly one at a time', 3373],
  ['a sleeping job cannot hold the lock', 'keeps the lease alive across a job that runs LONGER than its lease', 6071],
])];

describe('a normal run says nothing', () => {
  it('returns no verdict when every duration is sane and clocks agree', () => {
    expect(diagnose({ tasks: HEALTHY, wallElapsedMs: 31_040, monoElapsedMs: 31_035 })).toBeNull();
  });

  it('tolerates ordinary scheduling noise between the two clocks', () => {
    // A busy Mac drifts by a little. That must not cry wolf, or the banner gets
    // ignored on the night it matters.
    const v = diagnose({ tasks: HEALTHY, wallElapsedMs: 31_040, monoElapsedMs: 31_040 - (SKEW_CEILING_MS - 1) });
    expect(v).toBeNull();
  });

  it('does not fire on the slowest genuine test in this suite', () => {
    // ~6s. If this ever trips, the ceiling is set too low.
    expect(6071).toBeLessThan(DURATION_CEILING_MS);
  });
});

// ---------------------------------------------------------------------------
// BACK-TEST. The real numbers from the night this was missed.
// ---------------------------------------------------------------------------
describe('back-test: the 10-11 Aug overnight run', () => {
  const SLEPT = [file('tests/job-queue.test.js', [
    ['findings queue', 'round-trips add, list, claim and close', 35_838_329],
    ['morning digest', 'flags a job that was due but left no record', 238_089],
    ['morning digest', 'reports a skipped job as skipped, never as worked', 60_243],
    ['serialisation under real concurrency', 'gives up with EX_TEMPFAIL rather than running alongside a holder', 3603],
  ])];

  it('fires on the impossible duration', () => {
    const v = diagnose({ tasks: SLEPT, wallElapsedMs: 309_780, monoElapsedMs: 309_700 });
    expect(v).not.toBeNull();
  });

  it('names ALL THREE wrecked tests, not just the one that cleared the trigger', () => {
    // This is why trigger and listing are separate thresholds. Only the 9h57m
    // test passes the 5-minute trigger; 3m58s and 1m00s do not. A single high
    // ceiling would have fired the banner and then named a third of the damage,
    // leaving two failures looking like genuine regressions.
    const v = diagnose({ tasks: SLEPT, wallElapsedMs: 309_780, monoElapsedMs: 309_700 });
    expect(v.slow.map((t) => t.ms)).toEqual([35_838_329, 238_089, 60_243]);
    // ...and does not sweep in the healthy 3.6s test alongside them.
    expect(v.slow.map((t) => t.ms)).not.toContain(3603);
  });

  it('names the tests, worst first, so the report is actionable', () => {
    const v = diagnose({ tasks: SLEPT, wallElapsedMs: 309_780, monoElapsedMs: 309_700 });
    // The file prefix is kept so the line can be pasted straight back into
    // `vitest run -t`, and matches how vitest itself prints a FAIL.
    expect(v.slow[0].name)
      .toBe('tests/job-queue.test.js > findings queue > round-trips add, list, claim and close');
    const out = banner(v);
    expect(out).toMatch(/round-trips add, list, claim and close/);
    expect(out).toMatch(/10\.0h/);       // 9h57m, rendered in hours
    expect(out).toMatch(/3m58s/);        // not "238s" — no arithmetic required
    expect(out).toMatch(/1m00s/);
  });

  it('says INCONCLUSIVE, not failed — the whole point', () => {
    const out = banner(diagnose({ tasks: SLEPT, wallElapsedMs: 309_780, monoElapsedMs: 309_700 }));
    expect(out).toMatch(/INCONCLUSIVE/);
    expect(out).toMatch(/RE-RUN/);
  });

  it('warns off both wrong fixes by name', () => {
    // Raising the timeout hides a genuine hang; the skip flag hides everything.
    const out = banner(diagnose({ tasks: SLEPT, wallElapsedMs: 309_780, monoElapsedMs: 309_700 }));
    expect(out).toMatch(/testTimeout/);
    expect(out).toMatch(/SKIP_SYNC_TESTS/);
  });
});

// ---------------------------------------------------------------------------
// The second signal exists for the case the first one cannot see.
// ---------------------------------------------------------------------------
describe('a sleep BETWEEN tests, where no single duration looks odd', () => {
  it('is caught by wall-vs-monotonic skew alone', () => {
    // Every test fast, but ten hours passed. hrtime does not advance while
    // macOS sleeps; Date.now() does.
    const v = diagnose({ tasks: HEALTHY, wallElapsedMs: 36_000_000, monoElapsedMs: 31_000 });
    expect(v).not.toBeNull();
    expect(v.skewed).toBe(true);
    expect(v.slow).toEqual([]);
    expect(banner(v)).toMatch(/wall clock ran .* ahead of the monotonic/);
  });

  it('never reports negative skew as a jump', () => {
    // Monotonic slightly ahead is measurement order, not a time machine.
    const v = diagnose({ tasks: HEALTHY, wallElapsedMs: 31_000, monoElapsedMs: 31_050 });
    expect(v).toBeNull();
  });
});

describe('tree walking', () => {
  it('flattens nested suites and keeps the full path', () => {
    const tasks = collectTasks(HEALTHY);
    expect(tasks).toHaveLength(2);
    expect(fullName(tasks[0]))
      .toBe('tests/job-queue.test.js > serialisation under real concurrency > runs five simultaneous jobs strictly one at a time');
  });

  it('survives a task with no result rather than throwing mid-report', () => {
    const odd = [{ name: 'f', tasks: [{ name: 'skipped', type: 'test' }] }];
    expect(() => diagnose({ tasks: odd, wallElapsedMs: 10, monoElapsedMs: 10 })).not.toThrow();
  });

  it('survives an empty run', () => {
    expect(diagnose({ tasks: [], wallElapsedMs: 10, monoElapsedMs: 10 })).toBeNull();
  });
});

describe('the reporter is actually wired in', () => {
  it('is registered in vitest.config.js, or it never runs', () => {
    const cfg = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '../vitest.config.js'), 'utf8');
    expect(cfg).toMatch(/ClockSkewReporter/);
    expect(cfg).toMatch(/reporters/);
  });
});
