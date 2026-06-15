// @ts-check
const { defineConfig } = require('@playwright/test');

// Dedicated, unusual port so a stray dev/preview server (Kevin runs these) can't be
// mistaken for the app under test. DASHBOARD_URL overrides for testing the live site.
const PORT = 8799;
const LIVE_URL = process.env.DASHBOARD_URL || `http://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  // retries:0 — this is an invariant gate. A test that only passes on retry is flaky and
  // must be seen, not silently masked as green.
  retries: 0,
  use: {
    baseURL: LIVE_URL,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    command: `python3 -m http.server ${PORT}`,
    port: PORT,
    // false → Playwright always launches a fresh server bound to THIS repo. If the port is
    // occupied it fails loudly rather than testing whatever else is serving on it.
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
