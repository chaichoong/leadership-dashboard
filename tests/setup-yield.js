// Yield to the event loop after every test, in every file (29 Sep 2026).
//
// Many tests drive a real script with execFileSync. A file of those back to back
// can run past 60 s without the vitest worker ever reading its I/O, and then
// the worker's own RPC to the main process times out:
//   Unhandled Error: [vitest-worker]: Timeout calling "onTaskUpdate"
// The run exits 1 with every test passing. On 29 Sep 2026 it failed six full
// runs in a row and the new merge gate refused itself five times. It was traced
// first to tests/merge-pr.test.js (the full suite without that file was clean,
// adding the yield there fixed it at load 36, and removing it brought the error
// back). At load 44 to 50 another file did the same, so the yield is global.
// setImmediate runs after the poll phase, so pending replies are read before the
// next test starts. The cost is one event-loop turn per test.
import { afterEach } from 'vitest';

afterEach(() => new Promise((resolve) => setImmediate(resolve)));
