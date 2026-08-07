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
});
