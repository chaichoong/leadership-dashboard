// The nightly master-plan sync must never touch the shared checkout.
//
// It used to run `git pull --rebase --autostash origin main` there. That
// stashes and reapplies whatever a Claude session is mid-way through (the
// 16 Jul 2026 incident), moves HEAD in a checkout somebody else is using, and
// aborts outright when the checkout holds untracked files that also exist
// upstream — the state a squash-merged PR leaves behind:
//
//   error: The following untracked working tree files would be overwritten by
//   checkout: scripts/mac-guard.sh, scripts/mac-status.sh, tests/mac-guard.test.js
//
// That is why the job failed every night from 4 Aug 2026. It now does its git
// work in a private detached worktree at origin/main.
//
// Source-level assertions, because the bug is in WHICH DIRECTORY a command
// runs in. Running the real sync in a test would push to main.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../scripts/sync-master-plan.py'), 'utf8');

// The body of cmd_sync plus the helper it delegates to.
const syncBody = SRC.slice(SRC.indexOf('def cmd_sync('));

describe('master-plan sync isolation', () => {
  it('finds the sync path (control — guards against a vacuous pass)', () => {
    expect(SRC).toContain('def cmd_sync(');
    expect(SRC).toContain('class PlanWorktree');
    expect(syncBody.length).toBeGreaterThan(200);
  });

  it('never pulls, rebases or autostashes anywhere', () => {
    // --autostash is the one that eats another session's uncommitted work.
    expect(SRC).not.toMatch(/["']--autostash["']/);
    expect(SRC).not.toMatch(/git\(\s*["']pull["']/);
    expect(SRC).not.toMatch(/git\(\s*["']rebase["']/);
  });

  it('never checks out or resets the shared checkout', () => {
    expect(SRC).not.toMatch(/git\(\s*["']checkout["']/);
    expect(SRC).not.toMatch(/git\(\s*["']reset["']/);
    expect(SRC).not.toMatch(/git\(\s*["']stash["']/);
  });

  // Balanced-paren extraction. A naive [^)]* stops at the first ')', which for
  // this file lands inside `"; ".join(parts)` and silently truncates the call
  // before its cwd argument — the test would pass or fail for the wrong reason.
  function gitCalls(src, verb) {
    const out = [];
    const re = new RegExp(`git\\(\\s*["']${verb}["']`, 'g');
    let m;
    while ((m = re.exec(src))) {
      let depth = 0;
      for (let i = src.indexOf('(', m.index); i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') {
          depth--;
          if (depth === 0) { out.push(src.slice(m.index, i + 1)); break; }
        }
      }
    }
    return out;
  }

  it('commits and pushes only from the private worktree', () => {
    for (const verb of ['add', 'commit', 'push']) {
      const calls = gitCalls(syncBody, verb);
      expect(calls.length, `no git ${verb} found in the sync path`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call, `git ${verb} runs in the shared checkout: ${call}`).toContain('cwd=wt');
      }
    }
  });

  it('names both ends of the push, because the worktree HEAD is detached', () => {
    // A bare `git push origin main` from a detached HEAD pushes the wrong ref
    // or nothing at all.
    expect(syncBody).toContain('HEAD:main');
  });

  it('always removes its worktree, even when the sync throws', () => {
    // The cleanup lives in __exit__, so a raised exception still tidies up.
    // Slice to the next module-level def, not to a named one: cmd_map sits
    // ABOVE this in the file, so slicing to it silently yielded an empty
    // string and the assertion tested nothing.
    const start = SRC.indexOf('def __exit__');
    expect(start).toBeGreaterThan(-1);
    const rest = SRC.slice(start + 1);
    const next = rest.search(/\n(?:def |class )/);
    const exit = next === -1 ? rest : rest.slice(0, next);
    expect(exit).toContain('worktree');
    expect(exit).toContain('remove');
    expect(exit).toContain('prune');
    expect(exit).toContain('rmtree');
  });

  it('still refuses to sync over a human mid-edit on the plan', () => {
    expect(syncBody).toContain('ABORT: MASTER-PLAN.md has uncommitted local edits');
  });

  it('prunes stale worktrees on ENTRY, not only on exit', () => {
    // The whole point is that it runs on the next run rather than depending on
    // this one surviving to reach __exit__. Cleanup wired only into __exit__ is
    // the bug, so assert the call site as well as the behaviour.
    const start = SRC.indexOf('def __enter__');
    expect(start).toBeGreaterThan(-1);
    const rest = SRC.slice(start + 1);
    const next = rest.search(/\n    (?:def |@)/);
    const enter = next === -1 ? rest : rest.slice(0, next);
    expect(enter).toContain('prune_stale()');
  });
});

// ── Stale worktrees left by a KILLED run ────────────────────────────────────
//
// __exit__ tidies up only when the process survives to run it. The Mac sleeping
// mid-run kills it, and every abandoned masterplan-sync-* worktree then stays
// registered for ever, so `git worktree list` fills with dead entries and a
// genuinely stuck run becomes impossible to spot.
//
// Cleaning up at the START is what fixes it: it runs on the NEXT run rather than
// depending on this one surviving. Behavioural, against a real throwaway repo —
// a source-text assertion would pass on a prune that removes nothing.
describe('master-plan sync prunes stale worktrees on entry', () => {
  const py = (repo) => `
import importlib.util, os, subprocess, sys
spec = importlib.util.spec_from_file_location("smp", ${JSON.stringify(resolve(__dirname, '../scripts/sync-master-plan.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.REPO = ${JSON.stringify(repo)}
m.PlanWorktree.prune_stale()
out = subprocess.run(["git","-C",${JSON.stringify(repo)},"worktree","list","--porcelain"],
                     capture_output=True, text=True).stdout
print("REMAINING:" + str(out.count("masterplan-sync-")))
`;

  it('removes an abandoned masterplan-sync-* worktree and leaves others alone', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const run = promisify(execFile);

    const repo = mkdtempSync(join(tmpdir(), 'smp-repo-'));
    const sh = (...args) => run('git', ['-C', repo, ...args]);
    await sh('init', '-q', '-b', 'main');
    await sh('config', 'user.email', 't@t');
    await sh('config', 'user.name', 't');
    writeFileSync(join(repo, 'f.txt'), 'x');
    await sh('add', '.');
    await sh('commit', '-qm', 'init');

    // One abandoned temp worktree, and one real workspace that must survive.
    const stale = join(tmpdir(), `masterplan-sync-${Date.now()}`);
    const keeper = join(tmpdir(), `keep-me-${Date.now()}`);
    await sh('worktree', 'add', '--detach', stale, 'HEAD');
    await sh('worktree', 'add', '--detach', keeper, 'HEAD');

    const before = (await sh('worktree', 'list', '--porcelain')).stdout;
    expect(before).toContain('masterplan-sync-');
    expect(before).toContain('keep-me-');

    const { stdout } = await run('python3', ['-c', py(repo)], { encoding: 'utf8', timeout: 30000 });
    expect(stdout).toContain('REMAINING:0');

    const after = (await sh('worktree', 'list', '--porcelain')).stdout;
    expect(after).toContain('keep-me-'); // never touches a workspace it did not create

    rmSync(repo, { recursive: true, force: true });
    rmSync(stale, { recursive: true, force: true });
    await sh('worktree', 'remove', '--force', keeper).catch(() => {});
    rmSync(keeper, { recursive: true, force: true });
  }, 60000);
});
