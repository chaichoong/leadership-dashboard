import { defineConfig } from 'vitest/config';
import ClockSkewReporter from './tests/clock-skew-reporter.js';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    // 'default' keeps the normal output; the second one adds a banner when the
    // Mac slept mid-run, so a suspended run stops reading as a real failure.
    // See tests/clock-skew-reporter.js for the incident that caused it.
    reporters: ['default', new ClockSkewReporter()],
  },
});
