// PER-CASE TEST BUDGETS, AND WHY THEY ARE NOT IN vitest.config.js
// (finding 20261121-queue-fixer-1405)
//
// A vitest case that shells out to a content-engine script's own `selftest` pays that script's wall
// time. The scripts that build real media with ffmpeg take seconds at rest and tens of seconds under
// the load a merge gate creates. Measured on the Mac mini on 21 Nov 2026: qa.py took 5.6s alone and
// 25.9s beside a full gate, and approval.py's case reached 33s against vitest.config.js's 30s
// default. The budget held at rest and broke under exactly the load a merge gate creates, so on
// 21 Nov it turned the gate red on PRs 986, 987 and 1005 and left the whole fixer queue off main for
// a morning.
//
// The budget is raised PER CASE and never as vitest.config.js's `testTimeout`: a long global default
// would hide a genuinely hung test everywhere else. It lives here, in one source module, rather than
// as ten copies of a magic number, so every case that pays for ffmpeg says the same thing and
// tests/content-engine-selftest-budget.test.js can check that they all do.
//
// The deeper cause is real media encoding inside a parallel suite. Cutting that is its own job.
export const SELFTEST_BUDGET_MS = 120000;
