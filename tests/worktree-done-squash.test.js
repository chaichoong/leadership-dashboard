// Regression test for scripts/worktree.sh `done` — finding 20261012-phase-4-839.
//
// ORIGIN: every fixer PR merges through scripts/merge-pr.py, which SQUASHES.
// A squash puts a NEW commit on origin/main, so the branch tip is never an
// ancestor of it, and `done`'s only landing test was
// `git merge-base --is-ancestor`. It therefore refused every workspace whose
// work had fully landed. The operator either forced it or walked away: 10
// workspaces had piled up by 12 Oct 2026, three on a detached HEAD, and
// content-engine has already run from a stale checkout once
// (20260909-queue-fixer-504).
//
// Git merges by change, not by snapshot, so `done` now asks whether the
// branch still carries any change origin/main does not. These tests drive the
// real script in a throwaway repo — never the real one (lesson
// feedback_git_bare_true_means_tests_wrote_to_real_repo).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const SCRIPT = resolve(__dirname, '..', 'scripts/worktree.sh');

let base, origin, repo;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw r.error;
  return r;
}

function runDone(topic, ...extra) {
  return spawnSync('bash', [SCRIPT, 'done', topic, ...extra], { cwd: repo, encoding: 'utf8' });
}

// Build a scratch origin + clone, with a topic workspace at the path
// worktree.sh expects, and return the workspace path.
function makeWorkspace(topic, branch) {
  const wt = join(repo, '.claude/worktrees', topic);
  mkdirSync(join(repo, '.claude/worktrees'), { recursive: true });
  git(repo, 'fetch', '-q', 'origin', 'main');
  git(repo, 'worktree', 'add', '-q', '--no-track', wt, '-b', branch, 'origin/main');
  return wt;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'wt-done-'));
  origin = join(base, 'origin.git');
  repo = join(base, 'clone');

  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { encoding: 'utf8' });
  // Seed main through a temporary clone so origin has a commit to branch from.
  const seed = join(base, 'seed');
  spawnSync('git', ['clone', '-q', origin, seed], { encoding: 'utf8' });
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'Test');
  writeFileSync(join(seed, 'README.md'), 'base\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'push', '-q', 'origin', 'main');

  spawnSync('git', ['clone', '-q', origin, repo], { encoding: 'utf8' });
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  // Guard the guard: if any of this leaked into the real repo the test is
  // worse than useless, so assert the scratch repo is not the real one.
  expect(repo.startsWith(tmpdir())).toBe(true);
  expect(repo.startsWith(homedir() + '/Projects')).toBe(false);
});

afterEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* scratch dir */ }
});

describe('worktree.sh done — landing is decided by change, not by ancestry', () => {
  it('removes a workspace whose work landed as a SQUASH merge, with no --force', () => {
    const wt = makeWorkspace('squashed', 'fix/squashed');
    writeFileSync(join(wt, 'feature.txt'), 'the fix\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'the fix');
    git(wt, 'push', '-q', '-u', 'origin', 'fix/squashed');

    // What merge-pr.py does: squash the branch onto main as ONE new commit.
    const land = join(base, 'land');
    spawnSync('git', ['clone', '-q', origin, land], { encoding: 'utf8' });
    git(land, 'config', 'user.email', 'test@example.com');
    git(land, 'config', 'user.name', 'Test');
    git(land, 'merge', '--squash', 'origin/fix/squashed');
    git(land, 'commit', '-qm', 'fix: the fix (#1)');
    git(land, 'push', '-q', 'origin', 'main');

    // Precondition: ancestry says NOT merged. That is the bug.
    expect(git(repo, 'fetch', '-q', 'origin', 'main').status).toBe(0);
    expect(
      spawnSync('git', ['merge-base', '--is-ancestor', 'fix/squashed', 'origin/main'],
        { cwd: repo, encoding: 'utf8' }).status,
    ).not.toBe(0);

    const r = runDone('squashed');
    expect(r.stderr + r.stdout).not.toMatch(/not merged into origin\/main/);
    expect(r.status).toBe(0);
    expect(existsSync(wt)).toBe(false);
  });

  it('still refuses a branch holding a real commit that never landed', () => {
    const wt = makeWorkspace('unlanded', 'fix/unlanded');
    writeFileSync(join(wt, 'wip.txt'), 'work that exists only here\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'wip');
    git(wt, 'push', '-q', '-u', 'origin', 'fix/unlanded');

    const r = runDone('unlanded');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not merged into origin\/main/);
    expect(existsSync(wt)).toBe(true);
  });

  it('still refuses a workspace with uncommitted files', () => {
    const wt = makeWorkspace('dirty', 'fix/dirty');
    writeFileSync(join(wt, 'untracked.txt'), 'unsaved\n');

    const r = runDone('dirty');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/uncommitted file/);
    expect(existsSync(wt)).toBe(true);
  });

  it('removes a workspace that never committed anything', () => {
    const wt = makeWorkspace('empty', 'fix/empty');
    const r = runDone('empty');
    expect(r.status).toBe(0);
    expect(existsSync(wt)).toBe(false);
  });
});
