// @ts-check
const { defineConfig } = require('@playwright/test');

// Dedicated, unusual port so a stray dev/preview server (Kevin runs these) can't be
// mistaken for the app under test. DASHBOARD_URL overrides for testing the live site.
const PORT = 8799;
const LIVE_URL = process.env.DASHBOARD_URL || `http://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: './tests',
  // 60s (was 30s). Each test loads the full dashboard (~20 JS/CSS/font requests) and the
  // timeout also covers context teardown. Under parallel load teardown was tipping past 30s
  // ("Tearing down 'context' exceeded the test timeout"), so we give it headroom.
  timeout: 60_000,
  // retries:0 — this is an invariant gate. A test that only passes on retry is flaky and
  // must be seen, not silently masked as green. Flakiness here was load/timing, not app
  // correctness, and is fixed structurally (threaded server + capped workers below).
  retries: 0,
  // Cap workers. The bottleneck was the single-threaded dev server (now threaded, below) and
  // too many browser contexts tearing down at once. 4 keeps the suite fast while letting each
  // context start and tear down cleanly under load.
  workers: 4,
  use: {
    baseURL: LIVE_URL,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    // ThreadingHTTPServer, not `python3 -m http.server` (single-threaded). A single dashboard
    // load fires ~20 file requests; with parallel workers all hitting one serialized server
    // those requests queued, page loads stalled, network never settled, and teardown timed out.
    // Threading lets the server answer concurrent workers in parallel.
    command: `python3 -c "from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler; ThreadingHTTPServer(('', ${PORT}), SimpleHTTPRequestHandler).serve_forever()"`,
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
