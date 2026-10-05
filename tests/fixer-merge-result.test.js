// The gate must test the MERGE RESULT, never the checkout it is standing in.
//
// Regression origin: finding 20260830-queue-fixer-414, proven twice.
//
//   GREEN ON NOTHING — 1 Sep 2026. `fixer-merge.py merge --pr 196` reported
//   "1748 tests passed" and merged. PR #196 added three test files; the real
//   merge result runs 1777. The 29 tests written to prove those five fixes
//   were never executed by the gate that shipped them.
//
//   RED ON NOTHING — 31 Aug 2026. The same gate failed #196 twice: once
//   because the main checkout was a commit behind origin, once on a test that
//   only goes green AFTER the PR lands. Neither red was the branch, and a gate
//   that cries wolf is the shortest route to someone bypassing it.
//
// Both readings came from the same defect: run_gate() ran with cwd defaulting
// to REPO. The fix builds origin/main + the PR in a throwaway worktree and
// runs both suites there.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(ROOT, 'scripts/fixer-merge.py');
const SRC = readFileSync(GATE, 'utf8');

describe('the gate never runs the suites in the main checkout', () => {
  it('run_gate takes the tree to test as an argument', () => {
    // Back-test: the old signature was `def run_gate():` with sh() defaulting
    // to cwd=REPO. Restoring it fails here.
    expect(SRC).toMatch(/def run_gate\(cwd\)/);
  });

  it('both suites are invoked with that cwd, not the default', () => {
    const fn = SRC.slice(SRC.indexOf('def run_gate(cwd)'), SRC.indexOf('def decide('));
    const calls = fn.match(/sh\(\[[^\]]*\][^)]*\)/g) || [];
    expect(calls.length, 'expected a vitest call and a playwright call').toBe(2);
    for (const c of calls) {
      expect(c, `gate command runs in the wrong tree: ${c}`).toMatch(/cwd=cwd/);
    }
  });

  it('cmd_merge builds the merge result, gates it, and always tears it down', () => {
    const fn = SRC.slice(SRC.indexOf('def cmd_merge'));
    const buildAt = fn.indexOf('build_merge_result(args.pr)');
    const gateAt = fn.indexOf('run_gate(tree)');
    const mergeAt = fn.indexOf('gh", "pr", "merge');
    expect(buildAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(buildAt);
    expect(mergeAt).toBeGreaterThan(gateAt);
    // A leaked worktree per run would fill the disk and, worse, leave stale
    // trees that a later run could pick up.
    expect(fn).toMatch(/finally:\s*\n\s*destroy_merge_result\(tree\)/);
  });

  it('a PR that will not merge is a RED gate, never a pass', () => {
    // Cannot build the merge result = cannot judge it. On 1 Sep PR #163 was
    // genuinely conflicting; the honest answer is "left open", not "merged".
    const fn = SRC.slice(SRC.indexOf('def cmd_merge'));
    expect(fn).toMatch(/could not build the merge result/);
    const errAt = fn.indexOf('if err:');
    expect(errAt).toBeGreaterThan(-1);
    expect(errAt).toBeLessThan(fn.indexOf('gh", "pr", "merge'));
  });

  it('the gate reports which tree it tested, so a green cannot be anonymous', () => {
    expect(SRC).toMatch(/"testedTree": cwd/);
  });
});

describe('the gate may not merge changes to itself', () => {
  it('scripts/fixer-merge.py is a protected path', () => {
    // The one file where a bad change removes the check standing between every
    // other change and main — and it would be merged by the code being changed.
    const block = SRC.match(/PROTECTED = \(([\s\S]*?)\n\)/)[1];
    expect(block).toContain('scripts/fixer-merge.py');
  });
});

// ── Functional: it really does produce main + the PR, not one or the other ──
//
// A source-grep alone would pass on code that builds the worktree and then
// still tests REPO. This drives the real function against a real git repo.

const workspaces = [];
afterAll(() => {
  for (const w of workspaces) rmSync(w, { recursive: true, force: true });
});

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('build_merge_result materialises base + PR', () => {
  it('the tree carries the branch change AND a base commit made after it', () => {
    const origin = mkdtempSync(join(tmpdir(), 'fm-origin-'));
    const clone = mkdtempSync(join(tmpdir(), 'fm-clone-'));
    workspaces.push(origin, clone);

    // An "origin" with main and a feature branch, where main moved on AFTER
    // the branch was cut. That is the 31 Aug situation exactly.
    git(origin, 'init', '--quiet', '--bare', '--initial-branch=main');
    const work = mkdtempSync(join(tmpdir(), 'fm-work-'));
    workspaces.push(work);
    git(work, 'init', '--quiet', '--initial-branch=main');
    git(work, 'config', 'user.email', 'gate@test');
    git(work, 'config', 'user.name', 'gate');
    writeFileSync(join(work, 'base.txt'), 'v1\n');
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'base');
    git(work, 'checkout', '--quiet', '-b', 'feature');
    writeFileSync(join(work, 'from-the-pr.txt'), 'the fix\n');
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'the PR');
    git(work, 'checkout', '--quiet', 'main');
    writeFileSync(join(work, 'moved-after.txt'), 'main moved on\n');
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'main moves on');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '--quiet', 'origin', 'main', 'feature');

    // GitHub exposes a PR as refs/pull/N/head on the remote. Create that for
    // real so build_merge_result's own fetch is exercised, not re-implemented.
    const featureSha = git(work, 'rev-parse', 'feature').trim();
    git(origin, 'update-ref', 'refs/pull/1/head', featureSha);

    git(clone, 'clone', '--quiet', origin, clone);

    const script = `
import importlib.util, os, json
spec = importlib.util.spec_from_file_location("fm", ${JSON.stringify(GATE)})
fm = importlib.util.module_from_spec(spec); spec.loader.exec_module(fm)
fm.REPO = ${JSON.stringify(clone)}
path, err = fm.build_merge_result(1)
try:
    print(json.dumps({
        "err": err,
        "pr_file": bool(path) and os.path.exists(os.path.join(path, "from-the-pr.txt")),
        "base_moved_file": bool(path) and os.path.exists(os.path.join(path, "moved-after.txt")),
        "path": path,
    }))
finally:
    fm.destroy_merge_result(path)
`;
    const out = JSON.parse(
      execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim()
    );

    // Testing main alone misses the first; testing the PR head alone misses
    // the second. Only the merge result has both.
    expect(out.err, 'build_merge_result refused to build the tree').toBe(null);
    expect(out.pr_file, 'the PR change is absent — this is the main checkout').toBe(true);
    expect(out.base_moved_file, 'newer main is absent — this is the bare PR head').toBe(true);
    expect(existsSync(out.path), 'the throwaway worktree was left behind').toBe(false);
  });
});

// A workspace that cannot run the gate is what teaches people to bypass it
// (finding 20260904-queue-fixer-452). The workspace half: worktree.sh links
// node_modules into each workspace it makes. The gate's own half is below.
describe('every worktree can run the gate', () => {
  it('a new worktree gets node_modules linked from the main checkout', () => {
    const wt = readFileSync(join(ROOT, 'scripts/worktree.sh'), 'utf8');
    expect(wt).toContain('ln -s "$MAIN_ROOT/node_modules" "$path/node_modules"');
  });
});

// ── The merge tree's node_modules: the MAIN checkout's, and only a real one ──
//
// Regression origin: 5 Oct 2026, PR #709. merge-pr.py was started from a
// session worktree the desktop app made (not worktree.sh), which had no
// node_modules. build_merge_result linked the tree to <invoking
// checkout>/node_modules without checking it existed, so the link dangled,
// npx fetched a throwaway vitest, vitest.config.js could not resolve
// 'vitest/config', and vitest died before one test ran. The gate said RED.
// These drive the real build_merge_result and cmd_merge against real git.

// origin (bare, with refs/pull/1/head), a main checkout cloned from it, and a
// linked session worktree of that checkout with NO node_modules, as on 5 Oct.
function sessionFixture(mainNodeModules) {
  const root = mkdtempSync(join(tmpdir(), 'fm-nm-'));
  workspaces.push(root);
  const origin = join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  const work = join(root, 'work');
  git(root, 'clone', '--quiet', origin, work);
  git(work, 'config', 'user.email', 'gate@test');
  git(work, 'config', 'user.name', 'gate');
  writeFileSync(join(work, 'base.txt'), 'v1\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'base');
  git(work, 'push', '--quiet', 'origin', 'main');
  git(work, 'checkout', '--quiet', '-b', 'feature');
  writeFileSync(join(work, 'from-the-pr.txt'), 'the fix\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'the PR');
  git(work, 'push', '--quiet', 'origin', 'feature:refs/pull/1/head');

  const main = join(root, 'main');
  git(root, 'clone', '--quiet', origin, main);
  git(main, 'config', 'user.email', 'gate@test');
  git(main, 'config', 'user.name', 'gate');
  const nm = join(main, 'node_modules');
  mkdirSync(nm);
  writeFileSync(join(nm, '.package-lock.json'), '{}\n');
  if (mainNodeModules === 'usable') {
    for (const p of ['vitest', '@playwright/test']) {
      mkdirSync(join(nm, p), { recursive: true });
      writeFileSync(join(nm, p, 'package.json'), JSON.stringify({ name: p }));
    }
  }
  const session = join(root, 'session');
  git(main, 'worktree', 'add', '--quiet', '--detach', session, 'origin/main');
  return { main, session };
}

const buildFrom = (session) => {
  const script = `
import importlib.util, os, json
spec = importlib.util.spec_from_file_location("fm", ${JSON.stringify(GATE)})
fm = importlib.util.module_from_spec(spec); spec.loader.exec_module(fm)
fm.REPO = ${JSON.stringify(session)}
path, err = fm.build_merge_result(1)
out = {"err": err, "path": path}
try:
    link = os.path.join(path, "node_modules") if path else None
    out["isLink"] = bool(link) and os.path.islink(link)
    out["resolves"] = bool(link) and os.path.exists(link)
    out["linksTo"] = os.path.realpath(link) if out["isLink"] else None
    check = getattr(fm, "tests_cannot_run", None)
    out["cannot"] = check(path) if path and check else "no tree or no tests_cannot_run"
finally:
    fm.destroy_merge_result(path)
print(json.dumps(out))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
};

describe('the merge tree links a node_modules that can run the suites', () => {
  it('run from a worktree with no node_modules, the tree links the MAIN checkout\'s, which holds vitest', () => {
    const { main, session } = sessionFixture('usable');
    const out = buildFrom(session);
    expect(out.err).toBe(null);
    // Back-test: the old code linked <session>/node_modules, which does not
    // exist, so the link dangled exactly as it did for PR #709.
    expect(out.resolves, `node_modules in the merge tree dangles (-> ${out.linksTo})`).toBe(true);
    expect(out.linksTo).toBe(realpathSync(join(main, 'node_modules')));
    expect(out.cannot).toBe(null);
    // Tearing the tree down removes the link, never the real node_modules.
    expect(existsSync(join(main, 'node_modules', 'vitest', 'package.json'))).toBe(true);
    expect(existsSync(out.path)).toBe(false);
  });

  it('when no checkout holds vitest, the tree gets no link and the gate is told why', () => {
    const { session } = sessionFixture('empty');
    const out = buildFrom(session);
    expect(out.err).toBe(null);
    expect(out.isLink).toBe(false);
    // Where it looked, main checkout first, in words a person can act on.
    expect(out.cannot).toMatch(/node_modules does not exist \(no usable node_modules: /);
    expect(out.cannot).toMatch(/\/main\/node_modules has no vitest and no @playwright\/test; .*\/session\/node_modules does not exist\)$/);
  });
});

describe('the fixer\'s gate says "tests could not run", never RED, when no test ran', () => {
  it('cmd_merge refuses before any suite starts and merges nothing', () => {
    const tree = mkdtempSync(join(tmpdir(), 'fm-tree-'));
    const repo = mkdtempSync(join(tmpdir(), 'fm-repo-'));   // not git, no node_modules
    workspaces.push(tree, repo);
    const script = `
import importlib.util, io, contextlib, argparse, json, subprocess
spec = importlib.util.spec_from_file_location("fm", ${JSON.stringify(GATE)})
fm = importlib.util.module_from_spec(spec); spec.loader.exec_module(fm)
fm.REPO = ${JSON.stringify(repo)}
gate_calls, sh_calls, destroyed = [], [], []
fm.decide = lambda pr: {"pr": pr, "files": 1, "protected": [], "mayAutoMerge": True}
fm.build_merge_result = lambda pr: (${JSON.stringify(tree)}, None)
fm.destroy_merge_result = lambda p: destroyed.append(p)
def run_gate(cwd):
    gate_calls.append(cwd)
    return True, {"testedTree": cwd}
fm.run_gate = run_gate
real_sh = fm.sh
def sh(args, cwd=None, timeout=1800):
    if args[0] != "gh":
        return real_sh(args, cwd, timeout)
    sh_calls.append(args)
    return subprocess.CompletedProcess(args, 0, '{"state": "OPEN"}', "")
fm.sh = sh
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = fm.cmd_merge(argparse.Namespace(pr=7))
print(json.dumps({"code": code, "out": json.loads(buf.getvalue()), "gate": gate_calls,
                  "sh": sh_calls, "destroyed": destroyed}))
`;
    const r = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
    expect(r.gate, 'a suite was started in a tree that cannot run it').toEqual([]);
    expect(r.sh.some(a => a.join(' ').startsWith('gh pr merge'))).toBe(false);
    expect(r.out.merged).toBe(false);
    expect(r.out.why).toMatch(/^tests could not run: .*node_modules does not exist/);
    expect(r.out.why).not.toMatch(/RED/);
    expect(r.out.gate.testsRan).toBe(false);
    expect(r.destroyed).toEqual([tree]);
  });
});
