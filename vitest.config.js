import { defineConfig } from 'vitest/config';
import ClockSkewReporter from './tests/clock-skew-reporter.js';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    // 'default' keeps the normal output; the second one adds a banner when the
    // Mac slept mid-run, so a suspended run stops reading as a real failure.
    // See tests/clock-skew-reporter.js for the incident that caused it.
    reporters: ['default', new ClockSkewReporter()],
    // 30 s, not vitest's 5 s default (29 Sep 2026). Many tests start a Python or
    // git process, and on this Mac under load (load average 20 to 27 that day)
    // the Content Engine publish selftest alone took 4.9 s. Two tests timed out
    // at 5 s and the merge gate refused a PR that did not touch them. A hung test
    // still fails, in 30 s instead of 5.
    testTimeout: 30_000,
  },
});
