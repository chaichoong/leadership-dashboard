// @ts-check
const { defineConfig } = require('@playwright/test');
const { execFileSync } = require('child_process');

// The port is chosen fresh on every run, because a FIXED port made concurrent sessions
// impossible. With `const PORT = 8799`, the second session to reach the pre-push gate hit
// "http://localhost:8799 is already used" — a red that looks like a code failure but is only
// the other session's test server. That red is dangerous: the documented next move is
// SKIP_SYNC_TESTS=1, so a port clash quietly talks people into pushing past the gate. It also
// bred workarounds; there is an allowlisted command in .claude/settings.local.json that seds
// this line to 8811 and runs against a temp config.
//
// Asking the OS for a free port (listen on 0) also keeps the original property: nothing else
// is on it, so a stray dev or preview server can never be mistaken for the app under test.
//
// Set PLAYWRIGHT_PORT to pin it when you need a predictable URL to attach a debugger to.
function freePort() {
    try {
        const out = execFileSync(process.execPath, ['-e',
            "const s=require('net').createServer();" +
            "s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});",
        ], { timeout: 5000 }).toString().trim();
        const port = Number(out);
        return Number.isInteger(port) && port > 0 ? port : null;
    } catch {
        return null;   // spawning blocked — fall back to the old fixed port
    }
}

// This file is evaluated MORE THAN ONCE per run: once in the main process that starts the
// web server, and again inside every worker process. So the chosen port has to be pinned into
// the environment, which workers inherit. Picking a fresh port on each evaluation instead
// gives each worker a different baseURL from the one server that is actually listening, and
// all 86 tests fail with ERR_CONNECTION_REFUSED. Confirmed the hard way on 1 Aug 2026.
//
// Small race by construction: the probe closes the socket before Playwright binds it. The
// window is milliseconds and the OS does not hand the same ephemeral port straight back, so
// it is far safer than a fixed port that clashes every single time.
function resolvePort() {
    const pinned = Number(process.env.PLAYWRIGHT_PORT);
    if (Number.isInteger(pinned) && pinned > 0) return pinned;
    const port = freePort() || 8799;
    process.env.PLAYWRIGHT_PORT = String(port);   // workers inherit this
    return port;
}

// Workers are capped per RUN, but nothing capped them across CONCURRENT runs, and this
// checkout regularly has several sessions in it. On 6 Aug 2026 that showed up as a machine
// nobody could use: six sessions open, 16-20 headless browsers alive at once, 25.5 GB of
// demand squashed into 16 GB of RAM, 9.2 GB of swap and a load average of 105 on 8 cores.
// Four workers is right for one run and ruinous for three.
//
// So: count the other runs and divide. Degrade, never block. A lock would be the obvious
// alternative and is the wrong tool here — the pre-push gate would sit waiting on a lock held
// by a session that has since been killed, and the documented escape from a stuck gate is
// SKIP_SYNC_TESTS=1. A slower run is recoverable; teaching people to skip the gate is not.
//
// Pinned into the environment for the same reason as PORT above: this file is evaluated once
// in the main process and again in every worker, and an unpinned count would differ between
// them.
function resolveWorkers() {
    const pinned = Number(process.env.PLAYWRIGHT_WORKERS);
    if (Number.isInteger(pinned) && pinned > 0) return pinned;

    const MAX = 4;
    let others = 0;
    try {
        // pgrep matches this process too, so discount self. Anything unexpected means we
        // cannot prove we are alone, and the safe assumption is that we are not.
        const out = execFileSync('pgrep', ['-f', 'playwright test'], { timeout: 5000 })
            .toString().trim();
        const pids = out ? out.split('\n').map(Number).filter(Number.isInteger) : [];
        others = Math.max(0, pids.filter((p) => p !== process.pid).length);
    } catch (err) {
        // pgrep exits 1 with no output when nothing matches. That is "no other runs",
        // not a failure. Any other error and we stay conservative.
        others = err && err.status === 1 ? 0 : 1;
    }

    const workers = Math.max(1, Math.floor(MAX / (others + 1)));
    if (others > 0) {
        console.log(`[playwright] ${others} other test run(s) active — using ${workers} worker(s) instead of ${MAX}`);
    }
    process.env.PLAYWRIGHT_WORKERS = String(workers);   // workers inherit this
    return workers;
}

const PORT = resolvePort();
const WORKERS = resolveWorkers();
const LIVE_URL = process.env.DASHBOARD_URL || `http://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: './tests',
  // Artefacts go under a per-run directory, for the same reason the port is per-run. Playwright
  // WIPES outputDir when a run starts, so with the shared default two sessions in one checkout
  // delete each other's screenshots and traces mid-run. That bit on 1 Aug 2026: a genuine flake
  // left a trace, and a second run wiped it before it could be opened — the one artefact the
  // `trace: 'retain-on-failure'` change above exists to produce. Keyed on PORT because that is
  // already unique per run. Everything under test-results/ is gitignored.
  outputDir: `test-results/run-${PORT}`,
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
  // context start and tear down cleanly under load — and resolveWorkers() above divides that
  // down further when another session is already running the suite.
  workers: WORKERS,
  use: {
    baseURL: LIVE_URL,
    screenshot: 'only-on-failure',
    // 'retain-on-failure', NOT 'on-first-retry'. Those two settings and retries:0 above
    // cancel each other out: 'on-first-retry' only records when a test is retried, and
    // nothing is ever retried, so no trace was ever written. Verified 2026-07-31 by
    // failing a test on purpose — the run left a screenshot and an error-context.md and
    // no trace.zip at all.
    //
    // That mattered on 31 Jul: task-drawer-comments.spec.js dropped a test three times
    // under a full-suite run, a different test each time, and every one of those runs was
    // unexplainable afterwards. It has since passed six full runs, including at load
    // average 13.5 and back-to-back with another run, so it cannot be reproduced on
    // demand — which is exactly the case a trace exists for. Next red run leaves one.
    trace: 'retain-on-failure',
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
