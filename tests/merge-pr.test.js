// merge-pr.py: the one way an interactive session merges a PR.
//
// Regression origin: 29 Sep 2026. 405 of the 472 changes that reached main in
// the previous 30 days arrived by `gh pr merge --squash` from an interactive
// Claude session, and nothing tested that route (scripts/pre-push gates only a
// direct push to main; no GitHub workflow runs the tests). merge-pr.py runs the
// robot fixer's proven gate on the merge result, walks the pages the PR touches,
// and merges only when that is green. Two independent reviews (29 Sep 2026)
// found the false greens and false refusals each block below now pins.
//
// What must never happen, and is driven here:
//   * GREEN ON NOTHING: a walk that did not run, timed out, or cannot be read
//     counts as a pass. It must be "cannot judge" = refused.
//   * A WARN PASSES SILENTLY, or a FAIL hides behind a live WARN that shares
//     its reasons ("Loading..." on a panel that never renders).
//   * AN OLD FAILURE EXCUSES A NEW ONE: status alone, a capped error list, or a
//     second copy of one error all hid new errors. Reasons AND counts compared.
//   * A FLAKY TEST, A GATE THAT COMES AND GOES, A NEW PAGE OR A 404 WORDED
//     DIFFERENTLY refuses a good PR.
//   * A SKIPPED RETRY PASSES as green.
//   * THE TESTED TREE IS NOT THE MERGED TREE.
//   * A LEAK: the merge tree, a half-built worktree, the local server, test
//     workers and Playwright's detached web server survive a timeout or an
//     interrupt; or a sweep removes the queue fixer's own worktree.
//   * THE --delete-branch TRAP (3 and 4 Sep 2026): only the REMOTE branch goes.
//
// Nothing here contacts GitHub or the network: `gh` and `npx` are stubs first
// on PATH, "origin" is a bare repo on disk, the fixer module is a fake, and
// prod-walk.js / affected-pages.py are fakes inside a real merge tree served on
// 127.0.0.1.

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/merge-pr.py');
const scratch = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

// The yield after each test that stops the vitest worker RPC timing out lives in
// tests/setup-yield.js, loaded for every file by vitest.config.js.
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d; };

const LOAD = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("merge_pr", ${JSON.stringify(SCRIPT)})
mp = importlib.util.module_from_spec(spec); spec.loader.exec_module(mp)
`;

function py(code, input) {
  const r = spawnSync('python3', ['-c', LOAD + code], { input: input == null ? '' : JSON.stringify(input), encoding: 'utf8', timeout: 60000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

// ─── the pure decision ────────────────────────────────────────────────

function verdicts(cases) {
  return py(`
out = []
for c in json.load(sys.stdin):
    main_ids = set(c["mainIds"]) if c.get("mainIds") is not None else None
    ok, why = mp.verdict(c["gate"], c.get("walk"), c.get("live"), c.get("regate"), main_ids)
    f = mp.walk_findings(c.get("walk"), c.get("live"), c.get("regate"), main_ids) if c.get("walk") is not None else None
    out.append({"merge": ok, "why": why, "findings": f,
                "recheck": mp.recheck_ids(c.get("walk"), main_ids) if c.get("walk") else []})
print(json.dumps(out))
`, cases);
}

const page = (id, status, extra = {}) => ({ id, status, consoleErrors: [], leaks: [], softLeaks: [], failedRequests: [], chars: 900, ...extra });
const walked = (pages, { exit = null, bootErrors = [], scope = 'some', extra = {} } = {}) => ({
  scope, requested: pages.map(p => p.id),
  exit: exit ?? (pages.some(p => p.status === 'FAIL') ? 1 : 0), timedOut: false,
  result: { ok: !pages.some(p => p.status === 'FAIL'), ran: true, pagesWalked: pages.length,
            counts: {}, writesBlocked: 0, bootErrors, pages, ...extra },
});
const liveRun = (pages, opts = {}) => {
  const w = walked(pages, opts);
  delete w.scope;
  return w;
};
const LOCAL = 'http://127.0.0.1:51234';
const LIVE = 'https://app.operationsdirector.co.uk';
const loading = (id, status = 'WARN') => page(id, status, { gate: 'still loading' });

describe('verdict: what the gate decides from what it saw', () => {
  const green = walked([page('pnl', 'PASS'), page('tasks', 'PASS')]);
  const cases = {
    'vitest or browser red': { gate: false, walk: null },
    'red even when the walk would be green': { gate: false, walk: green },
    'scope none: no walk needed': { gate: true, walk: { scope: 'none' } },
    'walk green': { gate: true, walk: green },
    'walk ran:false (never signed in)': { gate: true, walk: { scope: 'all', requested: [], exit: 3, timedOut: false,
      result: { ok: false, ran: false, reason: 'NOT SIGNED IN' } } },
    // ran:false decides on its own, whatever the exit code and page list say.
    'walk ran:false with exit 0 and pages listed': { gate: true,
      walk: { ...green, result: { ...green.result, ran: false, reason: 'stopped' } } },
    'walk timed out': { gate: true, walk: { ...green, timedOut: true, exit: null } },
    'walk output unreadable': { gate: true, walk: { ...green, result: null } },
    'walk exit 2': { gate: true, walk: { ...green, exit: 2 } },
    'walk exit 1 with no failing page (stopped early)': { gate: true, walk: walked([page('pnl', 'PASS')], { exit: 1 }) },
    'a page never reached': { gate: true, walk: walked([page('pnl', 'FAIL', { error: 'not reached: the 8-minute budget ran out first' })]) },
    'an asked-for page missing from the walk': { gate: true, walk: { ...walked([page('pnl', 'PASS')]), requested: ['pnl', 'tasks'] } },
    'a page the walk does not know, failing both sides': { gate: true,
      walk: walked([page('old-page', 'FAIL', { error: 'not in PAGE_REGISTRY' })]),
      live: liveRun([page('old-page', 'FAIL', { error: 'not in PAGE_REGISTRY' })]) },
    'affected-pages could not judge': { gate: true, walk: { scope: null, error: 'cannot tell which pages the PR touches' } },
    // ── reasons, not status ──
    'same error on both sites, told apart only by host, port, query and line:col': { gate: true,
      walk: walked([page('pnl', 'FAIL', { consoleErrors: [`TypeError: x is undefined @ ${LOCAL}/js/pnl.js?v=2.1:120:7`] }), page('tasks', 'PASS')]),
      live: liveRun([page('pnl', 'FAIL', { consoleErrors: [`TypeError: x is undefined @ ${LIVE}/js/pnl.js?v=2.0:118:3`] })]) },
    // Python's server and GitHub Pages word the same 404 differently.
    'the same 404, worded by two different servers': { gate: true,
      walk: walked([page('pnl', 'FAIL', { consoleErrors: [`Failed to load resource: the server responded with a status of 404 (File not found) @ ${LOCAL}/js/gone.js`] })]),
      live: liveRun([page('pnl', 'FAIL', { consoleErrors: [`Failed to load resource: the server responded with a status of 404 (Not Found) @ ${LIVE}/js/gone.js`] })]) },
    'a NEW error on a page that already fails live for another reason': { gate: true,
      walk: walked([page('pnl', 'FAIL', { consoleErrors: ['TypeError: x is undefined @ /js/pnl.js', 'ReferenceError: newThing is not defined @ /js/pnl.js'] })]),
      live: liveRun([page('pnl', 'FAIL', { consoleErrors: ['TypeError: x is undefined @ /js/pnl.js'] })]) },
    'page went blank, live fails only on a console error': { gate: true,
      walk: walked([page('pnl', 'FAIL', { chars: 3, consoleErrors: ['TypeError: x @ /js/pnl.js'] })]),
      live: liveRun([page('pnl', 'FAIL', { consoleErrors: ['TypeError: x @ /js/pnl.js'] })]) },
    // Review 2, item 1: a panel that never renders but still reads "Loading..."
    // shares live's WARN gate reason. A FAIL is never excused by a WARN live.
    'FAIL here (never rendered, still reads Loading...), WARN live on the same gate': { gate: true,
      walk: walked([loading('tasks', 'FAIL')]), live: liveRun([loading('tasks')]) },
    // Review 3, item 2: a hidden panel still has innerText, so only prod-walk's
    // `rendered` flag tells a panel that never showed from one that did.
    'never rendered here, live renders but fails on the same console error': { gate: true,
      walk: walked([page('pnl', 'FAIL', { rendered: false, consoleErrors: ['TypeError: x @ /js/pnl.js'] })]),
      live: liveRun([page('pnl', 'FAIL', { rendered: true, consoleErrors: ['TypeError: x @ /js/pnl.js'] })]) },
    // ── counts and truncation (review 2, item 2) ──
    'one more copy of an error live already has': { gate: true,
      walk: walked([page('pnl', 'FAIL', { consoleErrors: ['TypeError: x @ /js/pnl.js:1:1', 'TypeError: x @ /js/pnl.js:9:9'], consoleErrorCount: 2 })]),
      live: liveRun([page('pnl', 'FAIL', { consoleErrors: ['TypeError: x @ /js/pnl.js:1:1'], consoleErrorCount: 1 })]) },
    'more leaks here than live, same snippets': { gate: true,
      walk: walked([page('pnl', 'FAIL', { leaks: ['Total: £NaN'], leakCount: 3 })]),
      live: liveRun([page('pnl', 'FAIL', { leaks: ['Total: £NaN'], leakCount: 1 })]) },
    'an error list truncated here': { gate: true,
      walk: walked([page('pnl', 'FAIL', { consoleErrors: ['a'], truncated: true })]),
      live: liveRun([page('pnl', 'FAIL', { consoleErrors: ['a'] })]) },
    'an error list truncated live': { gate: true,
      walk: walked([page('pnl', 'FAIL', { consoleErrors: ['a'] })]),
      live: liveRun([page('pnl', 'FAIL', { consoleErrors: ['a'], truncated: true })]) },
    'more boot errors here than live, same text': { gate: true,
      walk: walked([page('pnl', 'PASS')], { bootErrors: ['pageerror: boom'], extra: { bootErrorCount: 4 } }),
      live: liveRun([page('pnl', 'PASS')], { bootErrors: ['pageerror: boom'], extra: { bootErrorCount: 1 } }) },
    'boot error list truncated': { gate: true,
      walk: walked([page('pnl', 'PASS')], { bootErrors: ['pageerror: boom'], extra: { bootTruncated: true } }),
      live: liveRun([page('pnl', 'PASS')], { bootErrors: ['pageerror: boom'] }) },
    // ── WARN pages ──
    'a page stuck on Loading in the merge result, PASS live': { gate: true,
      walk: walked([loading('tasks')]), live: liveRun([page('tasks', 'PASS')]) },
    'a page at its sign-in screen on both sites': { gate: true,
      walk: walked([page('agents', 'WARN', { gate: 'asks who is viewing' })]),
      live: liveRun([page('agents', 'WARN', { gate: 'asks who is viewing' })]) },
    'a new bare NaN (soft leak), PASS live': { gate: true,
      walk: walked([page('pnl', 'WARN', { softLeaks: ['Rent this month NaN total'] })]),
      live: liveRun([page('pnl', 'PASS')]) },
    'WARN only for a failed request, PASS live': { gate: true,
      walk: walked([page('pnl', 'WARN', { failedRequests: [`500 ${LOCAL}/api/x`] })]),
      live: liveRun([page('pnl', 'PASS')]) },
    // ── a gate that comes and goes (review 2, item 6) ──
    'only a gate is new, second local walk clears it': { gate: true,
      walk: walked([loading('tasks')]), live: liveRun([page('tasks', 'PASS')]),
      regate: walked([page('tasks', 'PASS')]) },
    'only a gate is new, second local walk still stuck': { gate: true,
      walk: walked([loading('tasks')]), live: liveRun([page('tasks', 'PASS')]),
      regate: walked([loading('tasks')]) },
    'only a gate is new, second local walk broke': { gate: true,
      walk: walked([loading('tasks')]), live: liveRun([page('tasks', 'PASS')]),
      regate: { requested: ['tasks'], exit: 3, timedOut: false, result: { ok: false, ran: false, reason: 'NOT SIGNED IN' } } },
    'a gate AND a console error are new: no second walk can excuse it': { gate: true,
      walk: walked([page('tasks', 'FAIL', { gate: 'still loading', consoleErrors: ['TypeError: y'] })]),
      live: liveRun([page('tasks', 'PASS')]),
      regate: walked([page('tasks', 'PASS')]) },
    // ── a page new in this PR (review 2, item 4) ──
    'a new page FAILS in the merge result': { gate: true, mainIds: ['pnl', 'tasks'],
      walk: walked([page('pnl', 'PASS'), page('brand-new', 'FAIL', { consoleErrors: ['TypeError: z'] })]) },
    'a new page WARNS in the merge result': { gate: true, mainIds: ['pnl', 'tasks'],
      walk: walked([page('pnl', 'PASS'), page('brand-new', 'WARN', { gate: 'asks who is viewing' })]) },
    'a new page WARNS and an old page FAILS the same as live': { gate: true, mainIds: ['pnl', 'tasks'],
      walk: walked([page('pnl', 'FAIL', { consoleErrors: ['TypeError: old'] }), page('brand-new', 'WARN', { gate: 'still loading' })]),
      live: liveRun([page('pnl', 'FAIL', { consoleErrors: ['TypeError: old'] })]) },
    'boot errors, and every walked page is new': { gate: true, mainIds: ['pnl', 'tasks'],
      walk: walked([page('brand-new', 'PASS')], { bootErrors: ['pageerror: boom'] }),
      live: liveRun([page('pnl', 'PASS')], { bootErrors: ['pageerror: boom'] }) },
    // ── boot errors ──
    'a new boot error, every page PASS': { gate: true,
      walk: walked([page('pnl', 'PASS'), page('tasks', 'PASS')], { bootErrors: [`pageerror: boom @ ${LOCAL}/js/shared.js:10:2`] }),
      live: liveRun([page('pnl', 'PASS')], { bootErrors: [] }) },
    'a boot error live has too': { gate: true,
      walk: walked([page('pnl', 'PASS')], { bootErrors: [`pageerror: boom @ ${LOCAL}/js/shared.js:10:2`] }),
      live: liveRun([page('pnl', 'PASS')], { bootErrors: [`pageerror: boom @ ${LIVE}/js/shared.js:11:2`] }) },
    // ── live re-check ──
    'FAIL, live recheck cannot run': { gate: true, walk: walked([page('pnl', 'FAIL', { error: 'x' })]),
      live: { requested: ['pnl'], exit: 2, timedOut: false, result: { ok: false, ran: false, reason: 'no usable token file' } } },
    'FAIL, live recheck never ran': { gate: true, walk: walked([page('pnl', 'FAIL', { error: 'x' })]), live: null },
  };
  const names = Object.keys(cases);
  const got = Object.fromEntries(verdicts(names.map(n => cases[n])).map((v, i) => [names[i], v]));

  it('red tests never merge', () => {
    expect(got['vitest or browser red'].merge).toBe(false);
    expect(got['vitest or browser red'].why).toMatch(/RED/);
    expect(got['red even when the walk would be green'].merge).toBe(false);
  });
  it('green tests with nothing to walk, or a clean walk, merge', () => {
    expect(got['scope none: no walk needed'].merge).toBe(true);
    expect(got['walk green'].merge).toBe(true);
    expect(got['walk green'].recheck).toEqual([]);
  });
  it('a walk that did not happen, or cannot be read, is "cannot judge", never a pass', () => {
    for (const n of ['walk ran:false (never signed in)', 'walk ran:false with exit 0 and pages listed', 'walk timed out',
                     'walk output unreadable', 'walk exit 2', 'walk exit 1 with no failing page (stopped early)',
                     'a page never reached', 'an asked-for page missing from the walk',
                     'a page the walk does not know, failing both sides', 'affected-pages could not judge',
                     'FAIL, live recheck cannot run', 'FAIL, live recheck never ran']) {
      expect(got[n].merge, n).toBe(false);
      expect(got[n].why, n).toMatch(/^cannot judge/);
    }
  });
  it('the same problem on both sites is main\'s, once host, port, query and line:col are stripped', () => {
    const v = got['same error on both sites, told apart only by host, port, query and line:col'];
    expect(v.merge).toBe(true);
    expect(v.findings.alreadyBrokenLive).toEqual(['pnl']);
  });
  it('the same 404 worded by two servers is the same reason', () => {
    const v = got['the same 404, worded by two different servers'];
    expect(v.merge, v.why).toBe(true);
    expect(v.findings.alreadyBrokenLive).toEqual(['pnl']);
  });
  it('a NEW reason on a page that already fails live blocks: status alone would excuse it', () => {
    const v = got['a NEW error on a page that already fails live for another reason'];
    expect(v.merge).toBe(false);
    expect(v.findings.newFailures).toEqual(['pnl']);
    expect(v.findings.newReasons.pnl).toEqual(['console errors: 2 here, 1 live',
                                               'console: ReferenceError: newThing is not defined @ /js/pnl.js']);
  });
  it('a panel gone blank is its own reason, not excused by an old console error', () => {
    expect(got['page went blank, live fails only on a console error'].merge).toBe(false);
    expect(got['page went blank, live fails only on a console error'].findings.newReasons.pnl).toEqual(['blank: under 40 characters']);
  });
  it('a panel prod-walk says never rendered is new, even when live fails on the same error', () => {
    const v = got['never rendered here, live renders but fails on the same console error'];
    expect(v.merge).toBe(false);
    expect(v.findings.newReasons.pnl).toEqual(['not rendered']);
  });
  it('a FAIL here against a WARN live is always new, even with the same gate reason', () => {
    const v = got['FAIL here (never rendered, still reads Loading...), WARN live on the same gate'];
    expect(v.merge).toBe(false);
    expect(v.findings.newReasons.tasks).toEqual(['status: FAIL here, WARN live']);
    // Not a gate-only difference, so no second walk could excuse it.
    expect(v.findings.gateOnly).toEqual([]);
  });
  it('one more DISTINCT error here than live blocks, even when both normalise to the same text', () => {
    expect(got['one more copy of an error live already has'].merge).toBe(false);
    expect(got['one more copy of an error live already has'].findings.newReasons.pnl).toEqual(['console errors: 2 here, 1 live']);
  });
  it('the same error repeated more often here than live does not block (29 Sep 2026)', () => {
    // prod-walk's own counts include repeats, and a page that polls repeats an
    // error a different number of times on each walk. Comparing those counts
    // refused healthy PRs; only distinct entries are compared.
    expect(got['more leaks here than live, same snippets'].merge).toBe(true);
    expect(got['more boot errors here than live, same text'].merge).toBe(true);
  });
  it('a list prod-walk cut short, on either side, cannot be compared', () => {
    for (const n of ['an error list truncated here', 'an error list truncated live', 'boot error list truncated']) {
      expect(got[n].merge, n).toBe(false);
      expect(got[n].why, n).toMatch(/^cannot judge: .*limit/);
    }
  });
  it('WARN pages are re-walked live: a new gate or a new bare NaN blocks', () => {
    const v = got['a page stuck on Loading in the merge result, PASS live'];
    expect(v.recheck).toEqual(['tasks']);
    expect(v.merge).toBe(false);
    expect(v.findings.newReasons.tasks).toEqual(['gate: still loading']);
    expect(v.findings.gateOnly).toEqual(['tasks']);
    expect(got['a new bare NaN (soft leak), PASS live'].merge).toBe(false);
  });
  it('a gate that clears on a second local walk does not block; one still there does', () => {
    expect(got['only a gate is new, second local walk clears it'].merge).toBe(true);
    expect(got['only a gate is new, second local walk still stuck'].merge).toBe(false);
    expect(got['only a gate is new, second local walk still stuck'].findings.newReasons.tasks).toEqual(['gate: still loading']);
    expect(got['only a gate is new, second local walk broke'].why).toMatch(/^cannot judge: the second local walk/);
    const mixed = got['a gate AND a console error are new: no second walk can excuse it'];
    expect(mixed.merge).toBe(false);
    expect(mixed.findings.gateOnly).toEqual([]);
  });
  it('a WARN that live shares is reported, never blocking', () => {
    const v = got['a page at its sign-in screen on both sites'];
    expect(v.merge).toBe(true);
    expect(v.findings.alreadyBrokenLive).toEqual(['agents']);
  });
  it('failed requests are reported, never blocking', () => {
    const v = got['WARN only for a failed request, PASS live'];
    expect(v.merge).toBe(true);
    expect(v.findings.requestFailures).toEqual([{ id: 'pnl', onlyInMergeResult: ['500 /api/x'] }]);
    expect(v.findings.alreadyBrokenLive).toEqual([]);
  });
  it('a page new in this PR stays out of the live re-walk and is judged alone', () => {
    const fail = got['a new page FAILS in the merge result'];
    expect(fail.merge).toBe(false);
    expect(fail.findings.newFailures).toEqual(['brand-new']);
    expect(fail.recheck).toEqual([]);
    const warn = got['a new page WARNS in the merge result'];
    expect(warn.merge).toBe(true);
    expect(warn.findings.newPagesWarn).toEqual(['brand-new']);
    expect(warn.why).toMatch(/new page\(s\) WARN, reported: brand-new/);
    const both = got['a new page WARNS and an old page FAILS the same as live'];
    expect(both.recheck).toEqual(['pnl']);
    expect(both.merge).toBe(true);
    // The boot comparison still needs a page main has, even if none was walked.
    expect(got['boot errors, and every walked page is new'].recheck).toEqual(['pnl']);
    expect(got['boot errors, and every walked page is new'].merge).toBe(true);
  });
  it('boot errors are judged: new blocks, shared with live does not', () => {
    const v = got['a new boot error, every page PASS'];
    expect(v.recheck).toEqual(['pnl']);
    expect(v.merge).toBe(false);
    expect(v.findings.newFailures).toEqual(['(boot)']);
    expect(got['a boot error live has too'].merge).toBe(true);
  });
});

describe('walk timeout sits after prod-walk\'s own hard stop', () => {
  it('so prod-walk prints its partial result before we kill it', () => {
    const walkSrc = readFileSync(join(ROOT, 'scripts/prod-walk.js'), 'utf8');
    const hardStopMs = Number(walkSrc.match(/const HARD_STOP_MS = (\d+)/)[1]);
    const ours = py('print(json.dumps(mp.WALK_TIMEOUT))');
    expect(ours * 1000).toBeGreaterThan(hardStopMs);
  });
});

describe('the local server proves it serves THIS tree', { timeout: 60_000 }, () => {
  it('a matching nonce passes; a wrong nonce or no nonce file is a mismatch', () => {
    const good = tmp('merge-pr-served-');
    const other = tmp('merge-pr-other-');
    const empty = tmp('merge-pr-empty-');
    writeFileSync(join(good, 'merge-gate-nonce.txt'), 'abc123\n');
    writeFileSync(join(other, 'merge-gate-nonce.txt'), 'somebody-else\n');
    const out = py(`
res = {}
for name, d in json.load(sys.stdin).items():
    port = mp.free_port()
    p = mp.launch_server(d, port)
    try:
        res[name] = mp.wait_served(p, port, "abc123")
    finally:
        mp.stop_group(p)
print(json.dumps(res))
`, { good, other, empty });
    expect(out.good).toBe(null);
    expect(out.other).toMatch(/nonce mismatch/);
    expect(out.empty).toMatch(/HTTP 404/);
  });
});

// ─── stubs: gh, npx, and a real git "origin" on disk ──────────────────

// npx stands in for vitest, the first Playwright run and the --last-failed
// retry. Like the real Playwright, the retry only knows which tests failed if
// .last-run.json sits in test-results/run-<PLAYWRIGHT_PORT>/.
const NPX_STUB = `#!/usr/bin/env python3
import json, os, signal, subprocess, sys, time
D = os.path.dirname(os.path.abspath(__file__))
cfg = json.load(open(os.path.join(D, "suites.json")))
args = sys.argv[1:]
kind = "vitest" if args[:1] == ["vitest"] else ("retry" if "--last-failed" in args else "browser")
def note(line):
    with open(os.path.join(D, "npx-events.log"), "a") as fh:
        fh.write(line + "\\n")
with open(os.path.join(D, "npx-calls.log"), "a") as fh:
    fh.write(json.dumps({"kind": kind, "args": args, "cwd": os.getcwd(),
                         "port": os.environ.get("PLAYWRIGHT_PORT"), "pid": os.getpid()}) + "\\n")
spec = cfg.get(kind) or {}
port = os.environ.get("PLAYWRIGHT_PORT")
if spec.get("hang"):
    if spec.get("grandchild"):
        g = subprocess.Popen(["sleep", "60"])              # same process group
        open(os.path.join(D, "grandchild.pid"), "w").write(str(g.pid))
    if spec.get("detachedServer"):
        s = subprocess.Popen([sys.executable, "-m", "http.server", port, "--bind", "127.0.0.1"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)       # like Playwright's webServer
        open(os.path.join(D, "server.pid"), "w").write(str(s.pid))
    if spec.get("ignoreInt"):
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    else:
        def on_int(*_):
            note("INT " + kind)
            sys.exit(130)
        signal.signal(signal.SIGINT, on_int)
    if spec.get("interruptParent"):
        os.kill(os.getppid(), signal.SIGTERM)
    time.sleep(60)
    sys.exit(1)
if kind == "vitest" and spec.get("first") and not os.path.exists(os.path.join(D, "vitest-first-done")):
    open(os.path.join(D, "vitest-first-done"), "w").close()
    print(spec["first"]["out"])
    sys.exit(spec["first"]["exit"])
if kind == "browser" and spec.get("failed") is not None:
    d = os.path.join(os.getcwd(), "test-results", "run-" + port)
    os.makedirs(d, exist_ok=True)
    json.dump({"status": spec.get("status", "failed"), "failedTests": spec["failed"]}, open(os.path.join(d, ".last-run.json"), "w"))
if kind == "retry":
    seed = os.path.join(os.getcwd(), "test-results", "run-" + port, ".last-run.json")
    if not os.path.exists(seed):
        print("no last-run file: would run the WHOLE suite", file=sys.stderr)
        sys.exit(1)
    json.dump(spec["report"], open(os.environ["PLAYWRIGHT_JSON_OUTPUT_FILE"], "w"))
print(spec.get("out", kind + " output"))
sys.exit(spec.get("exit", 0))
`;

function stubs(view, { mergeConfirms = true, mergeExit = 0, suites = {} } = {}) {
  const dir = tmp('merge-pr-bin-');
  writeFileSync(join(dir, 'view.json'), JSON.stringify(view));
  writeFileSync(join(dir, 'suites.json'), JSON.stringify(suites));
  if (!mergeConfirms) writeFileSync(join(dir, 'never-merges'), '');
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/bash
D="$(cd "$(dirname "$0")" && pwd)"
printf '%s\\n' "$*" >> "$D/calls.log"
if [ "$1 $2" = "pr view" ]; then
  case "$*" in
    *state,mergedAt*) if [ -f "$D/merged" ]; then echo '{"state":"MERGED","mergedAt":"2026-09-29T00:00:00Z"}'; else echo '{"state":"OPEN","mergedAt":null}'; fi ;;
    *) cat "$D/view.json" ;;
  esac
  exit 0
fi
if [ "$1 $2" = "pr merge" ]; then [ -f "$D/never-merges" ] || touch "$D/merged"; echo merged; exit ${mergeExit}; fi
if [ "$1" = "api" ]; then echo '{}'; exit 0; fi
echo "gh stub: unexpected call: $*" >&2
exit 9
`);
  chmodSync(gh, 0o755);
  writeFileSync(join(dir, 'npx'), NPX_STUB);
  chmodSync(join(dir, 'npx'), 0o755);
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  return {
    dir, calls: () => read('calls.log'), events: () => read('npx-events.log'), read,
    npx: () => read('npx-calls.log').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)),
  };
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// origin/main + a PR branch, a clone for the script's REPO, and the merge tree
// built the way build_merge_result builds it: origin/main, then the PR merged.
// main's js/config.js registers pnl and tasks, so any other page is new.
function gitFixture({ ff = false, pullRef = false } = {}) {
  const root = tmp('merge-pr-git-');
  const origin = join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  const work = join(root, 'work');
  git(root, 'clone', '--quiet', origin, work);
  git(work, 'config', 'user.email', 'gate@test'); git(work, 'config', 'user.name', 'gate');
  mkdirSync(join(work, 'js')); mkdirSync(join(work, 'docs'));
  writeFileSync(join(work, 'js/pnl.js'), 'v1\n');
  writeFileSync(join(work, 'js/config.js'), "const PAGE_REGISTRY = [\n  { id: 'pnl' },\n  { id: 'tasks' },\n];\n");
  writeFileSync(join(work, 'docs/a.md'), 'a\n');
  git(work, 'add', '-A'); git(work, 'commit', '--quiet', '-m', 'base'); git(work, 'push', '--quiet', 'origin', 'main');
  git(work, 'checkout', '--quiet', '-b', 'feature/x');
  writeFileSync(join(work, 'js/pnl.js'), 'v2 from the PR\n');
  git(work, 'add', '-A'); git(work, 'commit', '--quiet', '-m', 'the PR'); git(work, 'push', '--quiet', 'origin', 'feature/x');
  const head = git(work, 'rev-parse', 'HEAD');
  // GitHub's refs/pull/5/head, as the gate reads it before building.
  if (pullRef) git(work, 'push', '--quiet', 'origin', 'feature/x:refs/pull/5/head');
  git(work, 'checkout', '--quiet', 'main');
  if (!ff) {
    writeFileSync(join(work, 'docs/before.md'), 'main moved before the gate\n');
    git(work, 'add', '-A'); git(work, 'commit', '--quiet', '-m', 'main moves'); git(work, 'push', '--quiet', 'origin', 'main');
  }
  const base = git(work, 'rev-parse', 'main');
  const repo = join(root, 'repo');
  git(root, 'clone', '--quiet', origin, repo);
  git(repo, 'config', 'user.email', 'gate@test'); git(repo, 'config', 'user.name', 'gate');
  git(repo, 'fetch', '--quiet', 'origin', 'feature/x:refs/fixer/pr-5');
  const tree = join(root, 'tree');
  git(repo, 'worktree', 'add', '--quiet', '--detach', tree, 'origin/main');
  git(tree, 'merge', '--quiet', '--no-edit', 'refs/fixer/pr-5');
  const moveMain = (file) => {
    git(work, 'pull', '--quiet', 'origin', 'main');
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), 'main moved during the gate\n');
    git(work, 'add', '-A'); git(work, 'commit', '--quiet', '-m', 'during the gate'); git(work, 'push', '--quiet', 'origin', 'main');
  };
  return { root, repo, tree, base, head, moveMain };
}

const OPEN = {
  // Deliberately NOT the tree's head: the head merged must be the head TESTED.
  state: 'OPEN', isDraft: false, headRefOid: 'f'.repeat(40), title: 'Fix: a thing',
  baseRefName: 'main', headRefName: 'feature/x', isCrossRepository: false,
  headRepository: { name: 'leadership-dashboard', nameWithOwner: 'chaichoong/leadership-dashboard' },
};

const gateLog = (home) => readFileSync(join(home, 'knowledge-os/logs/merge-gate.log'), 'utf8').trim().split('\n');

function cli(args, bin, home) {
  const r = spawnSync('python3', [SCRIPT, ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin.dir}:${process.env.PATH}`, HOME: home }, timeout: 30000,
  });
  return { code: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

describe('merge-pr.py CLI', { timeout: 60_000 }, () => {
  it('bad arguments exit 2 with one JSON why', () => {
    const bin = stubs(OPEN);
    const home = tmp('merge-pr-home-');
    for (const args of [[], ['--pr', 'abc'], ['--pr', '0'], ['--pr', '-3'], ['--nonsense']]) {
      const r = cli(args, bin, home);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.json.merged).toBe(false);
      expect(r.json.why).toMatch(/bad arguments/);
    }
    expect(bin.calls()).toBe('');   // never reached GitHub
    expect(gateLog(home).every(l => l.split('\t')[3] === 'BROKE')).toBe(true);
  });

  it('a PR that is not OPEN is refused (exit 1) and nothing is merged or fetched', () => {
    const bin = stubs({ ...OPEN, state: 'CLOSED', headRefOid: 'abc1234def' + '0'.repeat(30) });
    const home = tmp('merge-pr-home-');
    const r = cli(['--pr', '5'], bin, home);
    expect(r.code).toBe(1);
    expect(r.json.merged).toBe(false);
    expect(r.json.why).toMatch(/CLOSED, not OPEN/);
    const calls = bin.calls().trim().split('\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^pr view 5 --json /);
    const line = gateLog(home).pop().split('\t');
    expect(line[1]).toBe('5');
    expect(line[2]).toBe('abc1234d');
    expect(line[3]).toBe('REFUSED');
  });

  it('a draft is refused unless it is a dry run', () => {
    const bin = stubs({ ...OPEN, isDraft: true });
    const r = cli(['--pr', '5'], bin, tmp('merge-pr-home-'));
    expect(r.code).toBe(1);
    expect(r.json.why).toMatch(/draft/);
    expect(bin.calls()).not.toMatch(/pr merge/);
  });

  it('a PR that targets another branch is refused', () => {
    const bin = stubs({ ...OPEN, baseRefName: 'release' });
    const r = cli(['--pr', '5'], bin, tmp('merge-pr-home-'));
    expect(r.code).toBe(1);
    expect(r.json.why).toMatch(/targets release, not main/);
  });
});

// ─── the whole run: fake fixer, real git, fake walk ───────────────────

// The second and later local walks read walk-local-2.json when it exists.
const FAKE_WALK = `
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const base = a[a.indexOf('--base') + 1];
const only = a.includes('--only') ? a[a.indexOf('--only') + 1] : '';
const root = path.resolve(__dirname, '..');
const which = base.startsWith('http://127.0.0.1:') ? 'local' : 'live';
const log = path.join(root, 'walk-calls.log');
const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(l => l.includes('"local"')).length : 0;
const second = path.join(root, 'walk-local-2.json');
const file = which === 'local' && before > 0 && fs.existsSync(second) ? second : path.join(root, 'walk-' + which + '.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
(async () => {
  let served = '';
  // Proves the local walk is pointed at a server that serves THIS tree.
  if (which === 'local') served = (await (await fetch(base + 'served-marker.txt')).text()).trim();
  fs.appendFileSync(log, JSON.stringify({ which, base, only, served }) + '\\n');
  process.stdout.write(JSON.stringify(cfg.out) + '\\n', () => process.exit(cfg.exit));
})();
`;

// affected-pages.py stand-in: the CLI answer from affected.json, and the same
// parse_registry() the real one exposes, which merge-pr.py imports.
const FAKE_AFFECTED = `
import json, os, re, sys
def parse_registry(src):
    return [{"id": i} for i in re.findall(r"id: '([^']+)'", src)]
if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cfg = json.load(open(os.path.join(root, "affected.json")))
    open(os.path.join(root, "affected-stdin.txt"), "w").write(sys.stdin.read())
    print(json.dumps(cfg["out"]))
    sys.exit(cfg.get("exit", 0))
`;

const DRIVER = `
import io, contextlib, os, shutil, subprocess, tempfile
cfg = json.loads(os.environ["FAKE_CFG"])
destroyed = []
server_pids = []

def git(*args, cwd=None):
    return subprocess.run(["git", *args], cwd=cwd or cfg["repo"], capture_output=True, text=True)

def fixer_worktree(pr):
    path = os.path.join(cfg["scratch"], "fixer-merge-%d-xyz" % pr)
    git("worktree", "add", "--detach", path, "origin/main")
    return path

class FakeFixer:
    def protected_hits(self, files):
        return [{"file": f, "rule": f} for f in files if f == "js/config.js"]
    def build_merge_result(self, pr):
        if cfg.get("build") == "interrupted":
            fixer_worktree(pr)             # registered, then the run dies before returning it
            raise KeyboardInterrupt()
        if cfg.get("build") == "refused-while-fixer-builds":
            fixer_worktree(pr)             # the queue fixer building the same PR meanwhile
            return None, "PR does not merge cleanly onto origin/main"
        return cfg["tree"], None
    def destroy_merge_result(self, path):
        destroyed.append(path)
        if cfg.get("build"):
            git("worktree", "remove", "--force", path)
            shutil.rmtree(path, ignore_errors=True)
            git("worktree", "prune")

mp._FM = FakeFixer()
mp.REPO = cfg["repo"]
for k, v in (cfg.get("patch") or {}).items():
    setattr(mp, k, v)
if cfg.get("suitesCrash"):
    def crash(tree):
        raise RuntimeError("the suite runner crashed")
    mp.run_suites = crash
if cfg.get("interruptServerPoll"):
    real_launch = mp.launch_server
    def launch(tree, port):
        p = real_launch(tree, port)
        server_pids.append(p.pid)
        return p
    def poll(p, port, nonce):
        raise KeyboardInterrupt()
    mp.launch_server, mp.wait_served = launch, poll
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = mp.main(cfg["argv"])
alive = []
for pid in server_pids:
    try:
        os.kill(pid, 0)
        alive.append(pid)
        os.killpg(pid, 9)
    except OSError:
        pass
print(json.dumps({"code": code, "result": json.loads(buf.getvalue()), "destroyed": destroyed, "serverAlive": alive}))
`;

// A pid read from a file the stub may never have written. Only a positive
// integer is a process: process.kill(0, ...) signals this test run's WHOLE
// process group, which is how a failing case once killed vitest itself.
const realPid = (pid) => (/^\d+$/.test(String(pid).trim()) && Number(pid) > 0 ? Number(pid) : null);
function pidAlive(pid) {
  const n = realPid(pid);
  if (!n) return false;
  try { process.kill(n, 0); return true; } catch (e) { return false; }
}
function killIfAlive(pid) {
  const n = realPid(pid);
  if (!n) return;
  try { process.kill(n, 'SIGKILL'); } catch (e) { /* already gone */ }
}

function flow({ view = OPEN, suites = {}, affected = { out: { scope: 'some', pages: ['pnl', 'tasks'], files: [] }, exit: 0 },
                local = null, local2 = null, live = null, argv = ['--pr', '5'], mergeConfirms = true, mergeExit = 0,
                ff = false, moveMain = null, build = null, suitesCrash = false, interruptServerPoll = false,
                patch = null, pullRef = false, headIsReal = false } = {}) {
  const bin = stubs(view, { mergeConfirms, mergeExit, suites });
  const home = tmp('merge-pr-home-');
  const g = gitFixture({ ff, pullRef });
  if (headIsReal) writeFileSync(join(bin.dir, 'view.json'), JSON.stringify({ ...view, headRefOid: g.head }));
  const tree = g.tree;
  mkdirSync(join(tree, 'scripts'), { recursive: true });
  writeFileSync(join(tree, 'scripts/prod-walk.js'), FAKE_WALK);
  writeFileSync(join(tree, 'scripts/affected-pages.py'), FAKE_AFFECTED);
  writeFileSync(join(tree, 'served-marker.txt'), 'merge-result-tree\n');
  writeFileSync(join(tree, 'affected.json'), JSON.stringify(affected));
  if (local) writeFileSync(join(tree, 'walk-local.json'), JSON.stringify(local));
  if (local2) writeFileSync(join(tree, 'walk-local-2.json'), JSON.stringify(local2));
  if (live) writeFileSync(join(tree, 'walk-live.json'), JSON.stringify(live));
  if (moveMain) g.moveMain(moveMain);           // main moves AFTER the tree was built
  const cfg = { tree, repo: g.repo, scratch: g.root, argv, build, suitesCrash, interruptServerPoll, patch };
  const r = spawnSync('python3', ['-c', LOAD + DRIVER], {
    encoding: 'utf8', timeout: 90000,
    env: { ...process.env, PATH: `${bin.dir}:${process.env.PATH}`, HOME: home, FAKE_CFG: JSON.stringify(cfg), MERGE_PR_REF_WAIT: '0' },
  });
  expect(r.status, r.stderr).toBe(0);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  const walkLog = join(tree, 'walk-calls.log');
  return {
    ...out, stderr: r.stderr, gh: bin.calls(), npx: bin.npx(), events: bin.events(), bin,
    log: gateLog(home).pop().split('\t'), g,
    walks: existsSync(walkLog) ? readFileSync(walkLog, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [],
    affectedStdin: existsSync(join(tree, 'affected-stdin.txt')) ? readFileSync(join(tree, 'affected-stdin.txt'), 'utf8') : null,
  };
}

const walkOut = (pages, extra = {}) => ({
  out: { ok: !pages.some(p => p.status === 'FAIL'), ran: true, pagesWalked: pages.length,
         counts: { PASS: pages.filter(p => p.status === 'PASS').length, WARN: pages.filter(p => p.status === 'WARN').length,
                   FAIL: pages.filter(p => p.status === 'FAIL').length },
         writesBlocked: 2, bootErrors: [], pages: pages.map(p => page(p.id, p.status, p)), ...extra },
  exit: pages.some(p => p.status === 'FAIL') ? 1 : 0,
});
const NONE = { out: { scope: 'none', pages: [], files: [] } };
const expected = (id, title) => ({ id, title, ok: true, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] });

// Each case starts git, Python, a web server and node. Vitest's default 5 s per
// test is too tight when the Mac is busy (load average 8 to 10 on 29 Sep 2026).
describe('merge-pr.py end to end (fakes, real git, no network)', { timeout: 60_000 }, () => {
  it('runs vitest, then Playwright, both IN the merge tree, each once', () => {
    const r = flow({ affected: NONE });
    expect(r.code).toBe(0);
    const tree = realpathSync(r.g.tree);
    expect(r.npx.map(c => [c.kind, c.args.join(' '), realpathSync(c.cwd)])).toEqual([
      ['vitest', 'vitest run --allowOnly=false', tree],
      ['browser', 'playwright test tests/sync-invariants/ --forbid-only --reporter=dot', tree],
    ]);
    expect(r.npx[1].port).toMatch(/^\d+$/);   // pinned, so its .last-run.json is known
  });

  // 29 Sep 2026: at load average 20 to 48, three of five full vitest runs passed
  // every test and still exited 1 on vitest's own worker RPC timeout.
  const summary = (err) => [
    ' Test Files  233 passed (233)', '      Tests  3842 passed (3842)', '     Errors  1 error', '',
    '⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯', '', 'Vitest caught 1 unhandled error during the test run.', '',
    '⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯', err, ' ❯ Object.onTimeoutError rpc.js:53:10',
    // A test prints error-looking lines on purpose; they must not count.
    'RuntimeError: no agent file at /tmp/x/no-such-agent.md',
  ].join('\n');

  it('vitest passing every test but losing its own worker RPC: re-run once, reported, then merged', () => {
    const r = flow({ affected: NONE, suites: { vitest: {
      first: { exit: 1, out: summary('Error: [vitest-worker]: Timeout calling "onTaskUpdate"') }, exit: 0 } } });
    expect(r.code).toBe(0);
    expect(r.result.merged).toBe(true);
    expect(r.result.vitest.ok).toBe(true);
    expect(r.result.vitest.runnerFlakeRetried).toBe(true);
    expect(r.npx.map(c => c.kind)).toEqual(['vitest', 'vitest', 'browser']);
  });

  it('an unhandled error from test code is never re-run away', () => {
    const r = flow({ affected: NONE, suites: { vitest: {
      first: { exit: 1, out: summary('TypeError: Cannot read properties of undefined (reading x)') }, exit: 0 } } });
    expect(r.code).toBe(1);
    expect(r.result.vitest.ok).toBe(false);
    expect(r.npx.map(c => c.kind)).toEqual(['vitest']);
    expect(r.gh).not.toMatch(/pr merge/);
  });

  it('refuses before building when GitHub\'s PR ref has not caught up with the PR head (29 Sep 2026)', () => {
    // The gate once built the previous head seconds after a push, ran green for
    // five minutes, and GitHub refused the merge. Now it stops before building.
    const r = flow({ affected: NONE, pullRef: true });            // ref = the real head, gh says 'fff...'
    expect(r.code).toBe(1);
    expect(r.result.why).toMatch(/^cannot judge: GitHub's refs\/pull\/5\/head is [0-9a-f]{12}, not the PR head f{12}/);
    expect(r.npx).toEqual([]);
    expect(r.gh).not.toMatch(/pr merge/);
  });

  it('builds as normal when the PR ref matches the head gh reports', () => {
    const r = flow({ affected: NONE, pullRef: true, headIsReal: true });
    expect(r.code).toBe(0);
    expect(r.result.merged).toBe(true);
  });

  it('vitest red: refused, no Playwright, no retry, no walk, no merge, tree removed', () => {
    const r = flow({ suites: { vitest: { exit: 1 } } });
    expect(r.code).toBe(1);
    expect(r.result.vitest.ok).toBe(false);
    expect(r.result.browser.ok).toBe(null);
    expect(r.npx.map(c => c.kind)).toEqual(['vitest']);
    expect(r.walks).toEqual([]);
    expect(r.gh).not.toMatch(/pr merge/);
    expect(r.destroyed).toEqual([r.g.tree]);
    expect(r.log[3]).toBe('REFUSED');
  });

  it('reads base, head and files from the tree; merges the TESTED head; deletes only the remote branch', () => {
    const r = flow({ affected: NONE });
    expect(r.code).toBe(0);
    expect(r.result.merged).toBe(true);
    expect(r.result.base).toBe(r.g.base);
    expect(r.result.head).toBe(r.g.head);
    expect(r.result.headAtView).toBe('f'.repeat(40));
    // The PR changes js/pnl.js only; docs/before.md came from main, not the PR.
    expect(r.affectedStdin).toBe('js/pnl.js\n');
    expect(r.gh).toMatch(new RegExp(`^pr merge 5 --squash --match-head-commit ${r.g.head}$`, 'm'));
    expect(r.gh).not.toMatch(/--delete-branch/);
    expect(r.gh).toMatch(/^api -X DELETE repos\/chaichoong\/leadership-dashboard\/git\/refs\/heads\/feature\/x$/m);
    expect(r.result.branchDeleted).toBe(true);
    expect(r.result.mainMovedBy).toBe(null);
    expect(r.destroyed).toEqual([r.g.tree]);
    expect(r.log[3]).toBe('MERGED');
  });

  it('a PR that fast-forwards main (no merge commit) still yields base and head', () => {
    const r = flow({ affected: NONE, ff: true });
    expect(r.code).toBe(0);
    expect(r.result.base).toBe(r.g.base);
    expect(r.result.head).toBe(r.g.head);
    expect(r.gh).toMatch(new RegExp(`--match-head-commit ${r.g.head}$`, 'm'));
  });

  it('main moved during the gate onto a file the PR changes: refused, run it again', () => {
    const r = flow({ affected: NONE, moveMain: 'js/pnl.js' });
    expect(r.code).toBe(1);
    expect(r.result.why).toMatch(/main changed the same files during the gate, run it again: js\/pnl\.js/);
    expect(r.gh).not.toMatch(/pr merge/);
  });

  it('main moved during the gate onto other files only: merged, and said so', () => {
    const r = flow({ affected: NONE, moveMain: 'docs/elsewhere.md' });
    expect(r.code).toBe(0);
    expect(r.result.merged).toBe(true);
    expect(r.result.mainMovedBy).toBe('1 commits, other files only, not re-tested');
  });

  it('a new failure on a page that already fails live for another reason: refused', () => {
    const r = flow({
      local: walkOut([{ id: 'pnl', status: 'FAIL', consoleErrors: ['TypeError: old', 'ReferenceError: new'] }, { id: 'tasks', status: 'PASS' }]),
      live: walkOut([{ id: 'pnl', status: 'FAIL', consoleErrors: ['TypeError: old'] }]),
    });
    expect(r.code).toBe(1);
    expect(r.result.walk.newFailures).toEqual(['pnl']);
    expect(r.result.walk.newReasons.pnl).toEqual(['console errors: 2 here, 1 live', 'console: ReferenceError: new']);
    expect(r.gh).not.toMatch(/pr merge/);
  });

  it('the same failure live: merged, reported; only FAIL/WARN pages are re-walked live', () => {
    const r = flow({
      local: walkOut([{ id: 'pnl', status: 'FAIL', consoleErrors: ['TypeError: old @ http://127.0.0.1:5555/js/pnl.js:1:2'] },
                      { id: 'tasks', status: 'WARN', gate: 'asks who is viewing' }]),
      live: walkOut([{ id: 'pnl', status: 'FAIL', consoleErrors: ['TypeError: old @ https://app.operationsdirector.co.uk/js/pnl.js:9:9'] },
                     { id: 'tasks', status: 'WARN', gate: 'asks who is viewing' }]),
    });
    expect(r.code).toBe(0);
    expect(r.result.merged).toBe(true);
    expect(r.result.walk.alreadyBrokenLive).toEqual(['pnl', 'tasks']);
    expect(r.result.walk.writesBlocked).toBe(2);
    expect(r.result.walk.mainRegistryRead).toBe(true);
    expect(r.walks).toHaveLength(2);
    expect(r.walks[0]).toMatchObject({ which: 'local', only: 'pnl,tasks', served: 'merge-result-tree' });
    expect(r.walks[0].base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(r.walks[1]).toMatchObject({ which: 'live', base: 'https://app.operationsdirector.co.uk/', only: 'pnl,tasks' });
  });

  it('a page stuck on Loading only in the merge result, still stuck on a second local walk: refused', () => {
    const r = flow({
      local: walkOut([{ id: 'pnl', status: 'PASS' }, { id: 'tasks', status: 'WARN', gate: 'still loading' }]),
      local2: walkOut([{ id: 'tasks', status: 'WARN', gate: 'still loading' }]),
      live: walkOut([{ id: 'tasks', status: 'PASS' }]),
    });
    expect(r.code).toBe(1);
    expect(r.result.walk.newFailures).toEqual(['tasks']);
    expect(r.walks.map(w => [w.which, w.only])).toEqual([['local', 'pnl,tasks'], ['live', 'tasks'], ['local', 'tasks']]);
    expect(r.walks[2].served).toBe('merge-result-tree');   // the same server, still up
  });

  it('a Loading gate that clears on the second local walk: merged', () => {
    const r = flow({
      local: walkOut([{ id: 'pnl', status: 'PASS' }, { id: 'tasks', status: 'WARN', gate: 'still loading' }]),
      local2: walkOut([{ id: 'tasks', status: 'PASS' }]),
      live: walkOut([{ id: 'tasks', status: 'PASS' }]),
    });
    expect(r.code).toBe(0);
    expect(r.result.walk.gateOnlyRewalked).toEqual(['tasks']);
    expect(r.result.walk.newFailures).toEqual([]);
  });

  it('a page new in this PR is never sent to the live site: FAIL refused, WARN merged and reported', () => {
    const fail = flow({
      affected: { out: { scope: 'some', pages: ['pnl', 'brand-new'], files: [] } },
      local: walkOut([{ id: 'pnl', status: 'PASS' }, { id: 'brand-new', status: 'FAIL', consoleErrors: ['TypeError: z'] }]),
    });
    expect(fail.code).toBe(1);
    expect(fail.result.walk.newFailures).toEqual(['brand-new']);
    expect(fail.walks.map(w => w.which)).toEqual(['local']);
    const warn = flow({
      affected: { out: { scope: 'some', pages: ['tasks', 'brand-new'], files: [] } },
      local: walkOut([{ id: 'tasks', status: 'WARN', gate: 'asks who is viewing' }, { id: 'brand-new', status: 'WARN', gate: 'still loading' }]),
      live: walkOut([{ id: 'tasks', status: 'WARN', gate: 'asks who is viewing' }]),
    });
    expect(warn.code).toBe(0);
    expect(warn.result.walk.newPagesWarn).toEqual(['brand-new']);
    expect(warn.walks[1]).toMatchObject({ which: 'live', only: 'tasks' });
  });

  it('only boot errors to compare: the live re-walk boots on one walked page', () => {
    const r = flow({
      local: walkOut([{ id: 'pnl', status: 'PASS' }, { id: 'tasks', status: 'PASS' }], { bootErrors: ['pageerror: boom'] }),
      live: walkOut([{ id: 'pnl', status: 'PASS' }], { bootErrors: [] }),
    });
    expect(r.code).toBe(1);
    expect(r.result.walk.newFailures).toEqual(['(boot)']);
    expect(r.walks[1]).toMatchObject({ which: 'live', only: 'pnl' });
  });

  it('the walk did not happen (ran:false, exit 3): refused, no live walk', () => {
    const r = flow({ local: { out: { ok: false, ran: false, reason: 'NOT SIGNED IN' }, exit: 3 } });
    expect(r.code).toBe(1);
    expect(r.result.why).toMatch(/^cannot judge/);
    expect(r.walks.map(w => w.which)).toEqual(['local']);
  });

  it('affected-pages cannot read its map (exit 2): refused, nothing walked', () => {
    const r = flow({ affected: { out: {}, exit: 2 } });
    expect(r.code).toBe(1);
    expect(r.result.why).toMatch(/cannot judge.*exit 2/);
    expect(r.walks).toEqual([]);
  });

  it('flaky browser tests: only the failed ones re-run once, green counts, names reported and logged', () => {
    const r = flow({
      affected: NONE,
      suites: {
        browser: { exit: 1, failed: ['id-a', 'id-b'] },
        retry: { exit: 0, report: { suites: [{ title: 'tasks.spec.js', specs: [], suites: [
          { title: 'Tasks page', specs: [expected('id-a', 'saves'), expected('id-b', 'filters')] }] }] } },
      },
    });
    expect(r.code).toBe(0);
    expect(r.result.merged).toBe(true);
    expect(r.result.browser.ok).toBe(false);
    expect(r.result.browser.okAfterRetry).toBe(true);
    expect(r.result.browser.flakyRetried).toEqual(['tasks.spec.js › Tasks page › saves', 'tasks.spec.js › Tasks page › filters']);
    const retries = r.npx.filter(c => c.kind === 'retry');
    expect(retries).toHaveLength(1);                          // one retry, never two
    expect(retries[0].args.join(' ')).toBe('playwright test tests/sync-invariants/ --last-failed --forbid-only --reporter=dot,json');
    expect(retries[0].port).not.toBe(r.npx[1].port);          // its own run folder, seeded
    expect(r.log[3]).toBe('MERGED');
    expect(r.log[5]).toBe('tasks.spec.js › Tasks page › saves; tasks.spec.js › Tasks page › filters');
  });

  it('a first browser run that was cut short is never retried into a green (review 3, item 1)', () => {
    // Playwright writes .last-run.json even after an interrupt, listing only the
    // tests that failed before the cut. Retrying that list would merge a suite
    // that mostly never ran.
    const r = flow({
      affected: NONE,
      suites: { browser: { exit: 1, failed: ['id-a'], status: 'interrupted' },
                retry: { exit: 0, report: { suites: [] } } },
    });
    expect(r.code).toBe(1);
    expect(r.result.browser.okAfterRetry).toBe(false);
    expect(r.result.browser.retry.why).toMatch(/ended 'interrupted', not 'failed'/);
    expect(r.npx.filter(c => c.kind === 'retry')).toHaveLength(0);
    expect(r.gh).not.toMatch(/pr merge/);
  });

  it('red again on the retry: refused', () => {
    const r = flow({
      affected: NONE,
      suites: {
        browser: { exit: 1, failed: ['id-a'] },
        retry: { exit: 1, report: { suites: [{ title: 'tasks.spec.js', specs: [
          { id: 'id-a', ok: false, title: 'saves', tests: [{ status: 'unexpected' }] }] }] } },
      },
    });
    expect(r.code).toBe(1);
    expect(r.result.browser.okAfterRetry).toBe(false);
    expect(r.result.browser.retry.stillFailing).toEqual(['tasks.spec.js › saves']);
    expect(r.gh).not.toMatch(/pr merge/);
  });

  it('a retry that SKIPS instead of passing is refused (spec.ok is true for a skip)', () => {
    const r = flow({
      affected: NONE,
      suites: {
        browser: { exit: 1, failed: ['id-a'] },
        retry: { exit: 0, report: { suites: [{ title: 'tasks.spec.js', specs: [
          { id: 'id-a', ok: true, title: 'saves', tests: [{ status: 'skipped', results: [{ status: 'skipped' }] }] }] }] } },
      },
    });
    expect(r.code).toBe(1);
    expect(r.result.browser.retry.why).toBe('retry skipped instead of passing');
    expect(r.result.browser.retry.skipped).toEqual(['tasks.spec.js › saves']);
  });

  it('a browser failure with no failed test recorded is not retried', () => {
    const r = flow({ affected: NONE, suites: { browser: { exit: 1, failed: [] } } });
    expect(r.code).toBe(1);
    expect(r.result.browser.retry.why).toMatch(/nothing to retry/);
    expect(r.npx.filter(c => c.kind === 'retry')).toEqual([]);
  });

  it('a retry that runs too long gets SIGINT first, so Playwright can stop its own web server', () => {
    const r = flow({
      affected: NONE, patch: { RETRY_TIMEOUT: 2, PLAYWRIGHT_GRACE: 3 },
      suites: { browser: { exit: 1, failed: ['id-a'] }, retry: { hang: true } },
    });
    expect(r.code).toBe(1);
    expect(r.result.browser.retry.why).toMatch(/ran past/);
    expect(r.events).toMatch(/^INT retry$/m);
  });

  it('a retry that ignores SIGINT is killed, and the detached web server on its port is swept', () => {
    const r = flow({
      affected: NONE, patch: { RETRY_TIMEOUT: 2, PLAYWRIGHT_GRACE: 1 },
      suites: { browser: { exit: 1, failed: ['id-a'] }, retry: { hang: true, ignoreInt: true, detachedServer: true } },
    });
    const server = r.bin.read('server.pid');
    const leaked = pidAlive(server);
    killIfAlive(server);
    expect(r.code).toBe(1);
    expect(server).toMatch(/^\d+$/);
    expect(leaked, 'the detached web server outlived the gate').toBe(false);
  });

  it('an interrupt during vitest stops its whole process group, grandchildren included', () => {
    const r = flow({ patch: { PLAYWRIGHT_GRACE: 3 }, suites: { vitest: { hang: true, interruptParent: true, grandchild: true } } });
    const grandchild = r.bin.read('grandchild.pid');
    const leaked = pidAlive(grandchild);
    killIfAlive(grandchild);
    expect(r.code).toBe(2);
    expect(r.result.why).toMatch(/the gate itself broke: KeyboardInterrupt/);
    expect(r.events).toMatch(/^INT vitest$/m);                // SIGINT first
    expect(leaked, 'a test worker outlived the gate').toBe(false);
    expect(r.destroyed).toEqual([r.g.tree]);
    expect(r.log[3]).toBe('BROKE');
  });

  it('dry run green: exit 0, nothing merged, logged DRYRUN-GREEN', () => {
    const r = flow({ argv: ['--pr', '5', '--dry-run'], local: walkOut([{ id: 'pnl', status: 'PASS' }, { id: 'tasks', status: 'PASS' }]) });
    expect(r.code).toBe(0);
    expect(r.result.merged).toBe(false);
    expect(r.result.why).toMatch(/^DRY RUN/);
    expect(r.gh).not.toMatch(/pr merge|api -X/);
    expect(r.log[3]).toBe('DRYRUN-GREEN');
  });

  it('gh exits non-zero but GitHub says MERGED (a worktree holds main): reported as merged', () => {
    const r = flow({ affected: NONE, mergeExit: 1 });
    expect(r.code).toBe(0);
    expect(r.result.merged).toBe(true);
  });

  it('green, but GitHub does not confirm the merge: exit 1, never reported as merged', () => {
    const r = flow({ affected: NONE, mergeConfirms: false });
    expect(r.code).toBe(1);
    expect(r.result.merged).toBe(false);
    expect(r.gh).not.toMatch(/api -X DELETE/);
  });

  it('a crash in the suite runner still removes the merge tree (exit 2, BROKE)', () => {
    const r = flow({ suitesCrash: true });
    expect(r.code).toBe(2);
    expect(r.result.why).toMatch(/the gate itself broke: RuntimeError/);
    expect(r.destroyed).toEqual([r.g.tree]);
    expect(r.log[3]).toBe('BROKE');
  });

  it('an interrupt DURING the build removes the worktree the build registered', () => {
    const r = flow({ argv: ['--pr', '987654'], build: 'interrupted' });
    expect(r.code).toBe(2);
    expect(r.destroyed).toHaveLength(1);
    expect(r.destroyed[0]).toMatch(/fixer-merge-987654-/);
    expect(git(r.g.repo, 'worktree', 'list')).not.toMatch(/fixer-merge-987654-/);
  });

  it('an ordinary refusal never sweeps: the queue fixer may be building the same PR', () => {
    const r = flow({ argv: ['--pr', '987655'], build: 'refused-while-fixer-builds' });
    expect(r.code).toBe(1);
    expect(r.result.why).toMatch(/could not build the merge result/);
    expect(r.destroyed).toEqual([]);
    expect(git(r.g.repo, 'worktree', 'list')).toMatch(/fixer-merge-987655-xyz/);
  });

  it('an interrupt while waiting for the local server still stops the server', () => {
    const r = flow({ interruptServerPoll: true });
    expect(r.code).toBe(2);
    expect(r.serverAlive).toEqual([]);
  });
});
