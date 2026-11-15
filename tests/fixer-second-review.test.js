// The second reviewer: every queue-fixer change is tried by a second agent before it merges.
//
// Kevin's ruling, 22 Oct 2026 (card recWxof2DATkOQfcb, build task recJALoVKTbimTq7f). Tests
// passing was not enough: the fix-of-a-fix rate was 23 of 65 (35%) against a 32% baseline, and on
// 15 Nov 2026 independent reviewers found 34 faults in changes that had shipped green. So before a
// fixer change merges, scripts/fixer-review.py (1) runs the PR's changed tests on the code from
// before the PR, and refuses a new test that already passes there, and (2) puts ONE read-only
// reviewer on the merge result, whose fixed-shape answer code checks field by field. Nothing that
// could not run, and nothing the reviewer fails, is ever a pass.
//
// Everything here drives the real script. The back-test runs real vitest against invented
// mini-repos (a bare "origin" with refs/pull/1/head, exactly what GitHub exposes). The reviewer's
// one boundary, the claude CLI, is a fake executable that prints canned output and logs how it was
// called; so is gh. Neither the real CLI, GitHub, Airtable nor the network is reachable from here:
// the fakes are on PATH and named in the environment before any test starts.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync,
  realpathSync, chmodSync, symlinkSync, appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/fixer-review.py');
const NODE_MODULES = realpathSync(join(ROOT, 'node_modules'));
const SLOW = 120_000;

// ── THE BOUNDARY, stubbed before anything else runs ─────────────────────────
const HARNESS = mkdtempSync(join(tmpdir(), 'fixer-review-harness-'));
const BIN = join(HARNESS, 'bin');
mkdirSync(BIN);
const TOKEN = 'invented-token-' + Date.now();
writeFileSync(join(HARNESS, 'token'), TOKEN + '\n');

writeFileSync(join(BIN, 'claude'), `#!/usr/bin/env python3
import json, os, sys, time
stdin = sys.stdin.read()
log = os.environ.get("FAKE_CLAUDE_LOG")
if log:
    with open(log, "a") as fh:
        fh.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "stdin": stdin,
                             "token": os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"), "pid": os.getpid()}) + "\\n")
spec = os.environ.get("FAKE_CLAUDE_SPEC")
if not spec:
    sys.stderr.write("fake claude: no FAKE_CLAUDE_SPEC\\n"); sys.exit(99)
s = json.load(open(spec))
time.sleep(s.get("sleep", 0))
sys.stdout.write(s.get("stdout", "")); sys.stderr.write(s.get("stderr", ""))
sys.exit(s.get("exit", 0))
`);
writeFileSync(join(BIN, 'gh'), `#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
log = os.environ.get("FAKE_GH_LOG")
if log:
    with open(log, "a") as fh:
        fh.write(json.dumps(a) + "\\n")
spec = os.environ.get("FAKE_GH_SPEC")
if not spec:
    sys.stderr.write("fake gh: no FAKE_GH_SPEC\\n"); sys.exit(1)
s = json.load(open(spec))
if a[:2] == ["pr", "view"]:
    counter = log + ".views"
    n = int(open(counter).read()) if os.path.exists(counter) else 0
    open(counter, "w").write(str(n + 1))
    heads = s["heads"]
    print(json.dumps({"body": s.get("body", ""), "headRefOid": heads[min(n, len(heads) - 1)]}))
    sys.exit(0)
sys.stderr.write("fake gh: unsupported %s\\n" % a); sys.exit(1)
`);
chmodSync(join(BIN, 'claude'), 0o755);
chmodSync(join(BIN, 'gh'), 0o755);

// What vitest tells its own workers must not reach the vitest the back-test starts.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !/^VITEST/.test(k) && k !== 'TEST' && k !== 'NODE_ENV'));
const BOUNDARY = {
  PATH: `${BIN}:${process.env.PATH}`,
  FIXER_REVIEW_CLAUDE: join(BIN, 'claude'),
  FIXER_REVIEW_TOKEN_FILE: join(HARNESS, 'token'),
  ALLOWANCE_STATE: join(HARNESS, 'allowance-never-the-estate.json'),
};

const cleanup = [HARNESS];
afterAll(() => { for (const p of cleanup) rmSync(p, { recursive: true, force: true }); });

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function writeTree(dir, files) {
  for (const [p, body] of Object.entries(files)) {
    if (body === null) { rmSync(join(dir, p), { force: true }); continue; }
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
}

// An invented repo: an "old" commit on main, a "fix" commit as PR #1, and a checkout to review in.
function miniRepo({ base, fix, nodeModules = true }) {
  const root = mkdtempSync(join(tmpdir(), 'fixer-review-repo-'));
  cleanup.push(root);
  const origin = join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  const work = join(root, 'work');
  git(root, 'clone', '--quiet', origin, work);
  git(work, 'config', 'user.email', 'review@test');
  git(work, 'config', 'user.name', 'review');
  writeTree(work, base);
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'old');
  git(work, 'push', '--quiet', 'origin', 'main');
  git(work, 'checkout', '--quiet', '-b', 'fix');
  writeTree(work, fix);
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'the fix');
  git(work, 'push', '--quiet', 'origin', 'fix:refs/pull/1/head');
  const main = join(root, 'main');
  git(root, 'clone', '--quiet', origin, main);
  if (nodeModules) symlinkSync(NODE_MODULES, join(main, 'node_modules'));
  return { root, main, work, origin, head: git(work, 'rev-parse', 'HEAD') };
}

// A new commit on the PR, pushed as its new head.
function pushNewHead(repo, files) {
  writeTree(repo.work, files);
  git(repo.work, 'add', '-A');
  git(repo.work, 'commit', '--quiet', '-m', 'another commit');
  git(repo.work, 'push', '--quiet', '--force', 'origin', 'fix:refs/pull/1/head');
  repo.head = git(repo.work, 'rev-parse', 'HEAD');
  return repo.head;
}

const LIB_OLD = 'export const add = (a, b) => a - b;\n';
const LIB_FIX = 'export const add = (a, b) => a + b;\n';
const TEST = (name, body, lib = '../lib.js') =>
  `import { it, expect } from 'vitest';\nimport { add } from '${lib}';\nit('${name}', () => { ${body} });\n`;
const FAILS_ON_OLD = TEST('adds', 'expect(add(2, 2)).toBe(4);');      // 2-2 = 0 on the old code
const PASSES_ON_OLD = TEST('adds zero', 'expect(add(2, 0)).toBe(2);'); // true before and after

const F1 = '20261115-invented-1';
const F2 = '20261115-invented-2';

// One run's world: its state folder, its findings ledger, its fakes' specs and logs.
function scenario(repo, { findings = [F1], notes = {}, gh, claude, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-review-scn-'));
  cleanup.push(dir);
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  const ledger = join(dir, 'findings.jsonl');
  for (const id of findings) {
    appendFileSync(ledger, JSON.stringify({ op: 'add', id, ts: '2026-11-15T07:00:00Z', routine: 'invented',
      severity: 'high', title: 'An invented fault ' + id, where: 'lib.js', fix: 'make add add' }) + '\n');
    appendFileSync(ledger, JSON.stringify({ op: 'close', id, ts: '2026-11-15T07:30:00Z', outcome: 'pending',
      pr: 1, note: notes[id] || 'fixed lib.js' }) + '\n');
  }
  const s = {
    dir, tmp, ledger,
    state: join(dir, 'state'),
    claudeSpec: join(dir, 'claude.json'), claudeLog: join(dir, 'claude.log'),
    ghSpec: join(dir, 'gh.json'), ghLog: join(dir, 'gh.log'),
  };
  writeFileSync(s.ghSpec, JSON.stringify(gh || { body: `Fixes ${findings.join(', ')}.`, heads: [repo.head] }));
  if (claude) writeFileSync(s.claudeSpec, JSON.stringify(claude));
  s.env = {
    ...CLEAN_ENV, ...BOUNDARY,
    FIXER_REVIEW_REPO: repo.main, FIXER_REVIEW_DIR: s.state, FINDINGS_FILE: ledger, TMPDIR: tmp,
    FAKE_CLAUDE_SPEC: s.claudeSpec, FAKE_CLAUDE_LOG: s.claudeLog,
    FAKE_GH_SPEC: s.ghSpec, FAKE_GH_LOG: s.ghLog, ...env,
  };
  s.setClaude = (spec) => writeFileSync(s.claudeSpec, JSON.stringify(spec));
  s.claudeCalls = () => existsSync(s.claudeLog)
    ? readFileSync(s.claudeLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  s.ghCalls = () => existsSync(s.ghLog)
    ? readFileSync(s.ghLog, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  return s;
}

function cli(s, ...args) {
  const r = spawnSync('python3', [SCRIPT, ...args], { env: s.env, encoding: 'utf8', timeout: SLOW });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* the table, not JSON: the test reads r.out */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

function py(s, code) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("fr", ${JSON.stringify(SCRIPT)})
fr = importlib.util.module_from_spec(spec); spec.loader.exec_module(fr)
${code}
`], { env: s.env, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

// Every throwaway tree is gone, whatever happened: no git worktree left and no temp folder.
function expectClean(repo, s) {
  const trees = git(repo.main, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree '));
  expect(trees, 'a throwaway worktree was left registered').toHaveLength(1);
  expect(readdirSync(s.tmp).filter(n => n.startsWith('fixer-')), 'a throwaway tree was left on disk').toEqual([]);
}

const wrap = (result, extra = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, ...extra });
const answer = (head, findings, verdict = 'pass') => wrap(JSON.stringify({ head, findings, verdict }));
const ok = (id, over = {}) => ({ id, test_fails_without_fix: 'yes', cause: 'pass', elsewhere: 'pass',
  why: 'The test fails on the old code and the cause is fixed.', where_else: [], ...over });

// ── PART A: THE BACK-TEST, real vitest on the code from before the PR ───────

describe('the back-test runs the changed tests on the code from before the fix', () => {
  it('a new test that fails on the old code passes the back-test', () => {
    const repo = miniRepo({ base: { 'lib.js': LIB_OLD }, fix: { 'lib.js': LIB_FIX, 'tests/add.test.js': FAILS_ON_OLD } });
    const s = scenario(repo);
    const r = cli(s, 'backtest', '--pr', '1', '--json');
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.json.files).toEqual([{ file: 'tests/add.test.js', kind: 'new', tests: 1, failedOnBase: 1,
      status: 'failed', verdict: 'fails-without-fix' }]);
    expect(r.json.refuse).toBe(false);
    expect(r.json.codeFiles).toEqual([{ file: 'lib.js', kind: 'changed', selftest: false }]);
    expect(r.json.head).toBe(repo.head);
    expectClean(repo, s);
  }, SLOW);

  it('a new test that cannot even load on the old code counts as failing there (the PR 912 shape)', () => {
    // py-undefined-names in PR 912 listed a script the old code lacked, so it failed as a file.
    const repo = miniRepo({ base: { 'lib.js': LIB_OLD }, fix: {
      'lib.js': LIB_FIX, 'newlib.js': 'export const twice = (a) => a * 2;\n',
      'tests/twice.test.js': "import { it, expect } from 'vitest';\nimport { twice } from '../newlib.js';\nit('doubles', () => { expect(twice(2)).toBe(4); });\n",
    } });
    const s = scenario(repo);
    const r = cli(s, 'backtest', '--pr', '1', '--json');
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.json.files[0]).toMatchObject({ file: 'tests/twice.test.js', kind: 'new', tests: 0,
      status: 'failed-to-load', verdict: 'fails-without-fix' });
    expectClean(repo, s);
  }, SLOW);

  it('a NEW test that already passes on the old code is refused', () => {
    const repo = miniRepo({ base: { 'lib.js': LIB_OLD }, fix: { 'lib.js': LIB_FIX, 'tests/zero.test.js': PASSES_ON_OLD } });
    const s = scenario(repo);
    const r = cli(s, 'backtest', '--pr', '1', '--json');
    expect(r.code, r.out + r.err).toBe(3);
    expect(r.json.files[0]).toMatchObject({ file: 'tests/zero.test.js', kind: 'new', tests: 1, failedOnBase: 0,
      verdict: 'new-file-passes-without-fix' });
    expect(r.json.refuse).toBe(true);
    expectClean(repo, s);
  }, SLOW);

  it('a CHANGED test that passes on the old code is flagged for the reviewer, not refused', () => {
    const repo = miniRepo({
      base: { 'lib.js': LIB_OLD, 'tests/keep.test.js': TEST('one', 'expect(1).toBe(1);') },
      fix: { 'lib.js': LIB_FIX, 'tests/keep.test.js': TEST('one', 'expect(2).toBe(2);') },
    });
    const s = scenario(repo);
    const r = cli(s, 'backtest', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toMatch(/tests\/keep\.test\.js\s+changed\s+1\s+0\s+changed-file-passes-without-fix/);
    expect(r.out).toMatch(/RESULT: FLAGGED for the reviewer/);
    expectClean(repo, s);
  }, SLOW);

  it('a test file vitest never runs on the old code is refused, never read as a pass', () => {
    const repo = miniRepo({
      base: {
        'lib.js': LIB_OLD,
        'vitest.config.mjs': "export default { test: { include: ['tests/**/*.test.js'], exclude: ['tests/excluded/**', '**/node_modules/**'] } };\n",
      },
      fix: {
        'lib.js': LIB_FIX, 'tests/add.test.js': FAILS_ON_OLD,
        'tests/excluded/x.test.js': TEST('adds', 'expect(add(2, 2)).toBe(4);', '../../lib.js'),
      },
    });
    const s = scenario(repo);
    const r = cli(s, 'backtest', '--pr', '1', '--json');
    expect(r.code, r.out + r.err).toBe(3);
    const byFile = Object.fromEntries(r.json.files.map(f => [f.file, f]));
    expect(byFile['tests/add.test.js'].verdict).toBe('fails-without-fix');
    expect(byFile['tests/excluded/x.test.js']).toMatchObject({ status: 'not-run', verdict: 'could-not-run' });
    expect(r.json.refuse).toBe(true);
    expectClean(repo, s);
  }, SLOW);

  it('when vitest cannot start at all, the back-test says it could not run (exit 1), never a pass', () => {
    const repo = miniRepo({ base: { 'lib.js': LIB_OLD }, fix: { 'lib.js': LIB_FIX, 'tests/add.test.js': FAILS_ON_OLD },
      nodeModules: false });
    const s = scenario(repo);
    const r = cli(s, 'backtest', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.out).toMatch(/COULD NOT RUN: the back-test could not run: .*node_modules does not exist/);
    expect(r.out).not.toMatch(/RESULT: PASS/);
    expectClean(repo, s);
  }, SLOW);
});

// ── PART B: THE REVIEWER, through the fake CLI at its one boundary ──────────

// A PR that changes code and no test, so the back-test has nothing to run and the reviewer decides.
const codeOnly = () => miniRepo({ base: { 'lib.js': LIB_OLD }, fix: { 'lib.js': LIB_FIX } });
const notNeeded = (id, over = {}) => ok(id, { test_fails_without_fix: 'not-needed',
  why: 'A one-character arithmetic fix the gate covers.', ...over });

describe('the reviewer is launched read-only and its answer is checked field by field', () => {
  it('a clean pass: one fresh reviewer with read-only tools, the token in its environment only', () => {
    const repo = miniRepo({ base: { 'lib.js': LIB_OLD }, fix: { 'lib.js': LIB_FIX, 'tests/add.test.js': FAILS_ON_OLD } });
    const s = scenario(repo);
    s.setClaude({ stdout: answer(repo.head, [ok(F1)]) });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.json).toMatchObject({ pass: true, head: repo.head, round: 1, refusedBy: null, sendBack: [] });

    const calls = s.claudeCalls();
    expect(calls).toHaveLength(1);
    const argv = calls[0].argv;
    const after = (flag) => argv[argv.indexOf(flag) + 1];
    expect(argv[0]).toBe('-p');
    expect(after('--tools')).toBe('Read,Grep,Glob');
    expect(after('--allowedTools')).toBe('Read,Grep,Glob');
    expect(after('--permission-mode')).toBe('dontAsk');
    expect(argv).toContain('--restricted');
    expect(argv).toContain('--strict-mcp-config');
    expect(after('--mcp-config')).toBe('{"mcpServers":{}}');
    expect(argv).not.toContain('--model');
    for (const tool of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'NotebookEdit']) {
      expect(argv.join(' '), `the reviewer was handed ${tool}`).not.toMatch(new RegExp(`\\b${tool}\\b`));
    }
    // The token travels in the environment, never on the command line ps can read.
    expect(calls[0].token).toBe(TOKEN);
    expect(argv.join(' ')).not.toContain(TOKEN);
    // It reads the merge result, in a throwaway tree that is gone afterwards.
    expect(realpathSync(dirname(calls[0].cwd))).toBe(realpathSync(s.tmp));
    expect(existsSync(calls[0].cwd)).toBe(false);
    // It was given the measured back-test, the finding and the diff.
    expect(calls[0].stdin).toMatch(/tests\/add\.test\.js\s+new\s+1\s+1\s+fails-without-fix/);
    expect(calls[0].stdin).toContain(F1);
    expect(calls[0].stdin).toContain('a + b');
    expectClean(repo, s);
  }, SLOW);

  it('a "fail" on cause sends that finding back', () => {
    const repo = codeOnly();
    const s = scenario(repo, { claude: { stdout: answer(repo.head, [notNeeded(F1, { cause: 'fail',
      why: 'It special-cases the one input the finding saw.' })], 'send-back') } });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(3);
    expect(r.json).toMatchObject({ pass: false, refusedBy: 'reviewer' });
    expect(r.json.sendBack).toHaveLength(1);
    expect(r.json.sendBack[0].id).toBe(F1);
    expect(r.json.sendBack[0].why).toMatch(/symptom, not the cause.*special-cases/);
  }, SLOW);

  it('verdict "pass" beside a failing check is NOT a pass', () => {
    const repo = codeOnly();
    const s = scenario(repo, { claude: { stdout: answer(repo.head, [notNeeded(F1, { elsewhere: 'fail',
      where_else: ['lib2.js:1'] })], 'pass') } });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(3);
    expect(r.json).toMatchObject({ pass: false, refusedBy: 'reviewer' });
    expect(r.json.sendBack[0]).toMatchObject({ id: F1 });
    expect(r.json.sendBack[0].why).toMatch(/elsewhere: lib2\.js:1/);
  }, SLOW);

  it('a "no" that no flagged test explains is sent back', () => {
    const repo = codeOnly();
    const s = scenario(repo, { claude: { stdout: answer(repo.head, [ok(F1, { test_fails_without_fix: 'no',
      why: 'There is no test for this.' })]) } });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(3);
    expect(r.json.sendBack[0].why).toMatch(/no test fails without the fix, and no flagged test explains why/);
  }, SLOW);

  it('a "yes" when the back-test ran no test that fails is sent back (the reviewer cannot invent a test)', () => {
    const repo = codeOnly();
    const s = scenario(repo, { claude: { stdout: answer(repo.head, [ok(F1)]) } });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(3);
    expect(r.json.sendBack[0].why).toMatch(/says a test fails without the fix, but the back-test ran none that does/);
  }, SLOW);

  it('a "no" the flagged test explains is accepted (the PR 912 shape: the test itself was the bug)', () => {
    const repo = miniRepo({
      base: { 'lib.js': LIB_OLD, 'tests/keep.test.js': TEST('one', 'expect(1).toBe(1);') },
      fix: { 'lib.js': LIB_FIX, 'tests/keep.test.js': TEST('one', 'expect(2).toBe(2);') },
    });
    const s = scenario(repo, { claude: { stdout: 'placeholder' } });
    s.setClaude({ stdout: answer(repo.head, [ok(F1, { test_fails_without_fix: 'no',
      why: 'keep.test.js was changed to repair the test itself, so it passes on the old code by design.' })]) });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.json.pass).toBe(true);
  }, SLOW);

  it('an answer that leaves out a finding the ledger records on the PR is not a pass', () => {
    const repo = codeOnly();
    const s = scenario(repo, { findings: [F1, F2], claude: { stdout: answer(repo.head, [notNeeded(F1)]) } });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.json).toMatchObject({ pass: false, refusedBy: 'cannot-run' });
    expect(r.json.why).toMatch(new RegExp(`reviewer could not run: it left out finding\\(s\\) ${F2}`));
  }, SLOW);

  it('an answer for a stale head is not a pass', () => {
    const repo = codeOnly();
    const s = scenario(repo, { claude: { stdout: answer('0'.repeat(40), [notNeeded(F1)]) } });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.json.why).toMatch(/it answered for head '0{40}', not the head it reviewed/);
  }, SLOW);

  it('a PR that moves while the reviewer reads it is not a pass', () => {
    const repo = codeOnly();
    const s = scenario(repo, { gh: { body: 'Fixes it.', heads: [repo.head, 'f'.repeat(40)] } });
    s.setClaude({ stdout: answer(repo.head, [notNeeded(F1)]) });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.json.why).toMatch(/the PR moved during the review/);
  }, SLOW);

  it('prose instead of JSON is not a pass', () => {
    const repo = codeOnly();
    const s = scenario(repo, { claude: { stdout: wrap('Looks good to me, ship it.') } });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.json.why).toMatch(/reviewer could not run: its answer was not one JSON object/);
  }, SLOW);

  it('a non-zero exit is not a pass, even with a passing answer on stdout', () => {
    const repo = codeOnly();
    const s = scenario(repo, { claude: { exit: 1, stdout: 'x', stderr: 'API Error: 429 rate_limit_error' } });
    s.setClaude({ exit: 1, stdout: answer(repo.head, [notNeeded(F1)]), stderr: 'API Error: 429 rate_limit_error' });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.json.why).toMatch(/reviewer could not run: exit 1 \(rate limit\)/);
  }, SLOW);

  it('the allowance line is not a pass, even with a passing answer and exit 0', () => {
    const repo = codeOnly();
    const s = scenario(repo);
    s.setClaude({ stdout: answer(repo.head, [notNeeded(F1)]),
      stderr: "You've hit your weekly limit · resets 7pm (Europe/London)\n" });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.json.why).toMatch(/reviewer could not run: the Claude allowance is out: You've hit your weekly limit/);
  }, SLOW);

  it('a reviewer that runs past its cap is stopped and is not a pass', () => {
    const repo = codeOnly();
    const s = scenario(repo, { env: { FIXER_REVIEW_TIMEOUT: '2' } });
    s.setClaude({ sleep: 60, stdout: answer(repo.head, [notNeeded(F1)]) });
    const t0 = Date.now();
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.json.why).toMatch(/reviewer could not run: timed out after 2 seconds, and was stopped/);
    expect(Date.now() - t0).toBeLessThan(40_000);
    const pid = s.claudeCalls()[0].pid;
    expect(() => process.kill(pid, 0), 'the timed-out reviewer is still running').toThrow();
    expectClean(repo, s);
  }, SLOW);

  it('no token, or no CLI, means it could not run, and nothing is launched', () => {
    const repo = codeOnly();
    const s = scenario(repo, { env: { FIXER_REVIEW_TOKEN_FILE: join(HARNESS, 'no-such-token') } });
    s.setClaude({ stdout: answer(repo.head, [notNeeded(F1)]) });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code).toBe(1);
    expect(r.json.why).toMatch(/reviewer could not run: no OAuth token at/);
    const s2 = scenario(repo, { env: { FIXER_REVIEW_CLAUDE: join(HARNESS, 'no-such-claude') } });
    const r2 = cli(s2, 'run', '--pr', '1');
    expect(r2.json.why).toMatch(/reviewer could not run: the claude CLI is missing at/);
    expect(s.claudeCalls().length + s2.claudeCalls().length).toBe(0);
  }, SLOW);
});

// ── PART C: THE RECORD, THE ROUNDS AND passed() ─────────────────────────────

describe('review() records each verdict and passed() answers only for the exact head', () => {
  it('a refused back-test skips the reviewer and sends back the finding that owns the test', () => {
    const repo = miniRepo({ base: { 'lib.js': LIB_OLD }, fix: { 'lib.js': LIB_FIX, 'tests/zero.test.js': PASSES_ON_OLD } });
    const s = scenario(repo, { findings: [F1, F2], notes: { [F1]: 'fixed lib.js, guarded by tests/zero.test.js' } });
    s.setClaude({ stdout: answer(repo.head, [ok(F1), ok(F2)]) });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code, r.out + r.err).toBe(3);
    expect(r.json).toMatchObject({ pass: false, refusedBy: 'back-test', round: 1 });
    expect(r.json.sendBack).toEqual([{ id: F1, why: expect.stringMatching(/zero\.test\.js is a new test file that passes on the code before the fix/) }]);
    expect(s.claudeCalls(), 'the reviewer was paid for after the back-test refused').toHaveLength(0);
    expectClean(repo, s);
  }, SLOW);

  it('a pass for an older head is not a pass for the new head', () => {
    const repo = codeOnly();
    const s = scenario(repo);
    const first = repo.head;
    s.setClaude({ stdout: answer(first, [notNeeded(F1)]) });
    expect(cli(s, 'run', '--pr', '1').json.pass).toBe(true);
    const second = pushNewHead(repo, { 'lib.js': LIB_FIX + '// and a second commit\n' });
    expect(py(s, `print(json.dumps([fr.passed(1, ${JSON.stringify(first)}), fr.passed(1, ${JSON.stringify(second)})]))`))
      .toEqual([true, false]);
    // Reviewing the new head is a new round; a send-back on it leaves NO head passed.
    writeFileSync(s.ghSpec, JSON.stringify({ body: 'Fixes it.', heads: [second] }));
    rmSync(s.ghLog + '.views', { force: true });
    s.setClaude({ stdout: answer(second, [notNeeded(F1, { cause: 'fail' })], 'send-back') });
    const r = cli(s, 'run', '--pr', '1');
    expect(r.json).toMatchObject({ round: 2, pass: false, head: second });
    expect(py(s, `print(json.dumps([fr.passed(1, ${JSON.stringify(first)}), fr.passed(1, ${JSON.stringify(second)})]))`))
      .toEqual([false, false]);
    const st = cli(s, 'status', '--pr', '1').json;
    expect(st).toMatchObject({ passedHead: null, roundsToday: 2 });
  }, SLOW);

  it('a third round the same day is refused without launching anything', () => {
    const repo = codeOnly();
    const s = scenario(repo);
    s.setClaude({ stdout: answer(repo.head, [notNeeded(F1, { cause: 'fail' })], 'send-back') });
    expect(cli(s, 'run', '--pr', '1').json).toMatchObject({ round: 1, refusedBy: 'reviewer' });
    expect(cli(s, 'run', '--pr', '1').json).toMatchObject({ round: 2, refusedBy: 'reviewer' });
    const ghBefore = s.ghCalls();
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ round: 3, pass: false, refusedBy: 'rounds',
      why: 'two rounds used: take the failing findings out and reopen them' });
    expect(s.claudeCalls(), 'a third reviewer was launched').toHaveLength(2);
    expect(s.ghCalls(), 'the third round still asked GitHub').toBe(ghBefore);
    expectClean(repo, s);
  }, SLOW);

  it('the final round runs once round 2\'s findings are off the PR, and a fourth never does', () => {
    const repo = codeOnly();
    const s = scenario(repo, { findings: [F1, F2] });
    const sendBackF1 = (head) => answer(head, [notNeeded(F1, { cause: 'fail' }), notNeeded(F2)], 'send-back');
    s.setClaude({ stdout: sendBackF1(repo.head) });
    cli(s, 'run', '--pr', '1');
    cli(s, 'run', '--pr', '1');
    // Reopening F1 without taking its change out (the head has not moved) is not the final round.
    appendFileSync(s.ledger, JSON.stringify({ op: 'reopen', id: F1, ts: '2026-11-15T08:00:00Z', note: 'sent back twice' }) + '\n');
    expect(cli(s, 'run', '--pr', '1').json).toMatchObject({ round: 3, refusedBy: 'rounds' });
    expect(s.claudeCalls()).toHaveLength(2);
    // The fixer takes F1's change out and pushes: the head moves and F1 has left the ledger.
    const h3 = pushNewHead(repo, { 'lib.js': LIB_FIX + '// F1 taken out\n' });
    writeFileSync(s.ghSpec, JSON.stringify({ body: 'Fixes F2.', heads: [h3] }));
    rmSync(s.ghLog + '.views', { force: true });
    s.setClaude({ stdout: answer(h3, [notNeeded(F2)]) });
    const r3 = cli(s, 'run', '--pr', '1');
    expect(r3.json).toMatchObject({ round: 3, pass: true, head: h3 });
    expect(py(s, `print(json.dumps(fr.passed(1, ${JSON.stringify(h3)})))`)).toBe(true);
    const h4 = pushNewHead(repo, { 'lib.js': LIB_FIX + '// one more\n' });
    writeFileSync(s.ghSpec, JSON.stringify({ body: 'Fixes F2.', heads: [h4] }));
    rmSync(s.ghLog + '.views', { force: true });
    s.setClaude({ stdout: answer(h4, [notNeeded(F2)]) });
    const r4 = cli(s, 'run', '--pr', '1');
    expect(r4.json).toMatchObject({ round: 4, refusedBy: 'rounds' });
    expect(s.claudeCalls()).toHaveLength(3);
  }, SLOW);

  it('an unreadable state file is never an empty history: no pass, no review, nothing overwritten', () => {
    const repo = codeOnly();
    const s = scenario(repo);
    s.setClaude({ stdout: answer(repo.head, [notNeeded(F1)]) });
    mkdirSync(s.state, { recursive: true });
    writeFileSync(join(s.state, 'reviews.json'), '{"records": [ half a file');
    const r = cli(s, 'run', '--pr', '1');
    expect(r.code).toBe(1);
    expect(r.json.why).toMatch(/the review state .* cannot be read/);
    expect(s.claudeCalls()).toHaveLength(0);
    expect(readFileSync(join(s.state, 'reviews.json'), 'utf8')).toBe('{"records": [ half a file');
    expect(py(s, `print(json.dumps(fr.passed(1, ${JSON.stringify(repo.head)})))`)).toBe(false);
  }, SLOW);

  it('the state write is atomic: a write that fails leaves the old file whole and no temp file', () => {
    const repo = codeOnly();
    const s = scenario(repo);
    const r = py(s, `
rec = {"pr": 1, "head": "a" * 40, "date": fr.london_today(), "pass": True, "counted": True}
fr.write_record(rec)
before = open(fr.STATE_FILE).read()
real = fr.os.replace
def boom(src, dst):
    raise OSError("disk full")
fr.os.replace = boom
try:
    fr.write_record(dict(rec, head="b" * 40))
    raised = False
except OSError:
    raised = True
fr.os.replace = real
print(json.dumps({"raised": raised, "same": open(fr.STATE_FILE).read() == before,
                  "left": sorted(n for n in os.listdir(fr.STATE_DIR) if n.endswith(".tmp")),
                  "passedA": fr.passed(1, "a" * 40), "passedB": fr.passed(1, "b" * 40)}))
`);
    expect(r).toEqual({ raised: true, same: true, left: [], passedA: true, passedB: false });
  }, SLOW);
});
