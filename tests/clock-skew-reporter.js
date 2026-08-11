// A run the Mac slept through must NOT read as a failure.
//
// Overnight 10-11 Aug 2026 a run of tests/job-queue.test.js reported 3 failed /
// 84 passed on merged main. Nothing was wrong with the code. The Mac slept
// mid-run, and the three tests that broke are the ones that measure elapsed time
// — lock leases, staleness windows, queue timeouts. A suspended process blows
// every one of them.
//
// The evidence was sitting in the output and was read past twice:
//
//   findings queue > round-trips add, list, claim and close      35,838,329 ms
//   morning digest > flags a job that was due but left no record    238,089 ms
//   morning digest > reports a skipped job as skipped                60,243 ms
//
// 35,838,329 ms is nine hours fifty-seven minutes. That is not a slow test, it
// is a physically impossible one, and vitest still printed a plain FAILED. So a
// sleeping Mac and a genuine regression looked identical, which cost two wrong
// diagnoses in one session and is exactly the state that teaches people to
// re-run until green or reach for SKIP_SYNC_TESTS=1.
//
// This reporter does not decide whether the code is good. It decides whether the
// RUN IS TRUSTWORTHY, and says so loudly when it is not.
//
// Two independent signals, because neither is sufficient alone:
//
//   1. DURATION CEILING. Durations come from the wall clock, so a suspension
//      always inflates them. This fires even if the monotonic clock is not
//      trustworthy on some future host.
//   2. WALL VS MONOTONIC SKEW. performance.now() is monotonic and does not
//      advance while macOS is asleep; Date.now() does. A gap between the two is
//      direct proof of a suspension, and it catches a sleep that happened
//      BETWEEN tests, where no single duration looks odd. This one is the
//      belt-and-braces signal: if a future host's monotonic clock DOES advance
//      through sleep, skew reads zero and signal 1 still fires on its own.
//
// Deliberately NOT fixed by raising testTimeout: that would hide a genuine hang,
// which is a real bug this suite should keep catching.

import { performance } from 'node:perf_hooks';

// TWO thresholds, because triggering and listing want opposite biases. The
// back-test is what forced this apart: of the three tests wrecked on 10-11 Aug,
// only ONE (9h57m) cleared a five-minute bar. The other two came in at 3m58s and
// 1m00s, so a single high ceiling would have fired the banner and then named a
// third of the damage.
//
// TRIGGER is conservative. Nothing honest in this suite runs for five minutes,
// so crossing it is proof of a suspension rather than a slow morning. A banner
// that cries wolf is a banner people learn to scroll past.
export const DURATION_CEILING_MS = 5 * 60 * 1000;

// SUSPECT is generous, and only ever consulted once a suspension is already
// proven. The slowest genuine test here is about 6 seconds (the lease-lapse pair
// in job-queue.test.js), so 30s is five times anything real: past this, on a run
// we KNOW was suspended, the result cannot be trusted either way.
export const SUSPECT_MS = 30 * 1000;

// Below a minute, wall-vs-monotonic drift is ordinary scheduling noise.
export const SKEW_CEILING_MS = 60 * 1000;

/** Flatten vitest's nested file/suite/task tree into individual test cases. */
export function collectTasks(nodes, out = []) {
  for (const node of nodes ?? []) {
    if (node?.tasks?.length) collectTasks(node.tasks, out);
    else if (node?.type === 'test' || node?.result) out.push(node);
  }
  return out;
}

/** Full name of a task, including the suites it sits inside. */
export function fullName(task) {
  const parts = [];
  for (let n = task; n; n = n.suite) if (n.name) parts.unshift(n.name);
  return parts.join(' > ');
}

/**
 * The verdict, as a pure function so it can be tested without running vitest.
 * Returns null when the run looks trustworthy.
 */
export function diagnose({ tasks, wallElapsedMs, monoElapsedMs }) {
  const timed = collectTasks(tasks)
    .map((t) => ({ name: fullName(t), ms: t.result?.duration ?? 0 }))
    .sort((a, b) => b.ms - a.ms);

  const skewMs = Math.max(0, Math.round(wallElapsedMs - monoElapsedMs));
  const skewed = skewMs > SKEW_CEILING_MS;
  const impossible = timed.filter((t) => t.ms > DURATION_CEILING_MS);

  // Either signal proves the suspension. Neither is required to name the damage.
  if (!impossible.length && !skewed) return null;

  return { slow: timed.filter((t) => t.ms > SUSPECT_MS), skewMs, skewed };
}

/** Human duration. "238s" makes you do arithmetic; "4m0s" does not. */
export function human(ms) {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000);
    return `${m}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
  }
  return `${Math.round(ms / 1000)}s`;
}

export function banner(verdict) {
  const L = [];
  L.push('');
  L.push('='.repeat(72));
  L.push('  CLOCK JUMPED MID-RUN — TREAT THIS RESULT AS INCONCLUSIVE, NOT FAILED');
  L.push('='.repeat(72));
  if (verdict.skewed) {
    L.push(`  The wall clock ran ${human(verdict.skewMs)} ahead of the monotonic`);
    L.push('  clock. That is the Mac having been asleep, not slow tests.');
  }
  if (verdict.slow.length) {
    L.push(`  ${verdict.slow.length} test(s) ran far longer than anything honest here:`);
    for (const t of verdict.slow.slice(0, 10)) {
      L.push(`    ${human(t.ms).padStart(6)}  ${t.name}`);
    }
    if (verdict.slow.length > 10) {
      L.push(`    ... and ${verdict.slow.length - 10} more`);
    }
  }
  L.push('');
  L.push('  Any failure above may be an artefact of the suspension. The tests');
  L.push('  that break this way measure elapsed time: lock leases, staleness');
  L.push('  windows, queue timeouts.');
  L.push('');
  L.push('  RE-RUN THE SUITE ON A WOKEN MAC BEFORE BELIEVING ANY FAILURE.');
  L.push('  Do NOT raise testTimeout and do NOT set SKIP_SYNC_TESTS=1.');
  L.push('='.repeat(72));
  L.push('');
  return L.join('\n');
}

export default class ClockSkewReporter {
  onInit() {
    this.wall0 = Date.now();
    this.mono0 = performance.now();
  }

  onFinished(files) {
    // onInit is guaranteed by vitest, but never let the reporter itself be the
    // thing that breaks a test run.
    if (this.wall0 == null) return;
    const verdict = diagnose({
      tasks: files,
      wallElapsedMs: Date.now() - this.wall0,
      monoElapsedMs: performance.now() - this.mono0,
    });
    if (verdict) process.stderr.write(banner(verdict) + '\n');
  }
}
