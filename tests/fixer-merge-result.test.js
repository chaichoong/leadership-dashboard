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
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
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

// A missing dependency is not a verdict on the change.
//
// 4 Sep 2026 (finding 20260904-queue-fixer-452): the gate went RED in a fresh
// worktree because node_modules resolved nothing. A false red on the gate is the
// shortest route to someone bypassing it, and bypassing it is how an unreviewed
// change to the approval loop reaches production.
describe('cannot run is not the same as red', () => {
  it('reports CANNOT RUN, not a failure, when neither suite resolves', () => {
    const box = mkdtempSync(join(tmpdir(), 'nodeps-'));
    const out = JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location('fm', ${JSON.stringify(GATE)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
ok, gate = m.run_gate(${JSON.stringify(box)})
print(json.dumps({"ok": ok, "gate": gate}))
`], { encoding: 'utf8' }).trim());
    rmSync(box, { recursive: true, force: true });
    expect(out.ok).toBeNull();                       // None, never False
    expect(out.gate.cannotRun).toMatch(/could not run/);
    expect(out.gate.cannotRun).toMatch(/NOT a red/);
    expect(out.gate.vitest).toBeUndefined();         // nothing was actually tested
  });

  it('a merge run distinguishes the two in what it prints, and merges on neither', () => {
    expect(SRC).toContain('if ok is None:');
    expect(SRC).toContain('the gate COULD NOT RUN');
    expect(SRC).toContain('the gate is RED');
  });

  it('deps_resolve walks up, so a node_modules holding only a cache does not count', () => {
    expect(SRC).toContain('def deps_resolve(cwd)');
    expect(SRC).toMatch(/os\.path\.join\(b, "vitest"\)/);
    expect(SRC).toMatch(/os\.path\.join\(b, "playwright"\)/);
  });

  it('a new worktree gets node_modules linked so the gate can run there at all', () => {
    const wt = readFileSync(join(ROOT, 'scripts/worktree.sh'), 'utf8');
    expect(wt).toContain('ln -s "$MAIN_ROOT/node_modules" "$path/node_modules"');
  });
});
