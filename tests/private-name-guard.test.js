// Guards the private-name commit guard (21 Sep 2026).
//
// WHAT THIS EXISTS FOR
// This repo is PUBLIC. On 21 Sep 2026 the main checkout held 258 loose private
// working files (HMRC page builders, arrears workings, letter drafts, ledger
// dumps) after .gitignore had been widened four times since 31 Jul and still
// matched none of them: ignore patterns guess at names, and sessions keep
// inventing new ones. scripts/private-name-guard.py reads what is actually
// staged and refuses any ADDED line naming someone on the private roster.
//
// These tests make real commits in a throwaway repo with the real hook
// installed (a symlink to scripts/pre-commit, exactly as .git/hooks/pre-commit
// is in the live checkout), so they fail if the guard stops blocking OR if the
// hook stops calling it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Fictional names only: this test file is committed to a PUBLIC repo.
const ROSTER = '# test roster\nJane Testwood\nMartin\n';

let dir, repo, env;

function git(...args) {
  return execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(message) {
  return spawnSync('git', ['commit', '-q', '-m', message], { cwd: repo, env, encoding: 'utf8' });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'private-guard-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  writeFileSync(join(dir, 'roster.txt'), ROSTER);
  env = {
    ...process.env,
    OD_REDACT_NAMES: join(dir, 'roster.txt'),
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    // The hook also refuses a live routine SKILL.md that is not mirrored in the
    // repo (scripts/scheduled-task-drift-guard.py, 16 Oct 2026). That is nothing
    // to do with the name guard, and leaving it switched on would make these
    // tests fail whenever some other session edited a live routine — the exact
    // unrelated red this codebase keeps learning not to ship. Pointing the live
    // directory at a path that does not exist is the guard's own documented
    // "another machine, CI" case, where it passes without checking.
    SCHEDULED_TASKS_LIVE: join(dir, 'no-live-scheduled-tasks'),
  };
  for (const k of ['GITHUB_BEFORE_SHA', 'CHANGED_FILES', 'GITHUB_ACTIONS']) delete env[k];
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Guard Test');
  symlinkSync(join(ROOT, 'scripts/pre-commit'), join(repo, '.git/hooks/pre-commit'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('private-name guard, through the real pre-commit hook', () => {
  it('refuses a new file that names someone on the roster, and names the file and line', () => {
    writeFileSync(join(repo, 'notes.md'), 'line one\narrears for Jane Testwood\n');
    git('add', 'notes.md');
    const r = commit('add notes');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Commit refused');
    expect(r.stderr).toContain('notes.md:2');
    // The refusal must not echo the name it is protecting.
    expect(r.stderr).not.toMatch(/Testwood/i);
    expect(() => git('rev-parse', 'HEAD')).toThrow(); // nothing was committed
  });

  it('lets a clean new file through', () => {
    writeFileSync(join(repo, 'notes.md'), 'nothing private here\n');
    git('add', 'notes.md');
    const r = commit('add clean notes');
    expect(r.status).toBe(0);
    expect(git('log', '--oneline')).toContain('add clean notes');
  });

  it('matches a name split across whitespace and in any case', () => {
    writeFileSync(join(repo, 'a.txt'), 'JANE    testwood owes rent\n');
    git('add', 'a.txt');
    expect(commit('split name').status).not.toBe(0);
  });

  it('ignores single-word roster entries, like report_scrub does', () => {
    writeFileSync(join(repo, 'a.txt'), 'Martin said the boiler works\n');
    git('add', 'a.txt');
    expect(commit('single word').status).toBe(0);
  });

  it('does not block an unrelated edit to a file that already mentions someone', () => {
    writeFileSync(join(repo, 'old.md'), 'Jane Testwood\nfirst\n');
    // Seed the history without the hook, as if the file predates the guard.
    git('add', 'old.md');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'seed');
    writeFileSync(join(repo, 'old.md'), 'Jane Testwood\nsecond\n');
    git('add', 'old.md');
    expect(commit('edit other line').status).toBe(0);
  });

  it('catches an added line whose own text starts with "++ "', () => {
    // In a -U0 diff that line reads "+++ ...", the same prefix as a file header.
    writeFileSync(join(repo, 'a.txt'), 'first\n++ Jane Testwood\n');
    git('add', 'a.txt');
    const r = commit('plus plus');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('a.txt:2');
  });

  it('warns loudly and lets the commit through when the roster is missing', () => {
    env.OD_REDACT_NAMES = join(dir, 'no-such-roster.txt');
    writeFileSync(join(repo, 'a.txt'), 'Jane Testwood\n');
    git('add', 'a.txt');
    const r = commit('no roster');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('NOT checked');
  });
  // finding 20261019-agent-dispatch-996. PR #501 took the live HMRC compliance check
  // reference out of this PUBLIC repo on 21 Sep 2026. By 19 Oct it was back on
  // origin/main in six files, because nothing refused it. The guard now refuses the
  // SHAPE, so the real value never has to be written down to be caught — including
  // here, in a file that is itself public. CFS-1234567 below is invented.
  it('refuses an added line carrying a reference of the private shape', () => {
    writeFileSync(join(repo, 'a.txt'), 'first\nHMRC CFS-1234567 response due\n');
    git('add', 'a.txt');
    const r = commit('reference');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('private reference number');
    expect(r.stderr).toContain('a.txt:2');
    expect(() => git('rev-parse', 'HEAD')).toThrow();
  });

  it('lets the invented all-zero placeholder through', () => {
    // Control. If the placeholder were refused too, every example and fixture
    // would have to drop the shape altogether and the tests would lose their point.
    writeFileSync(join(repo, 'a.txt'), 'HMRC CFS-0000000 response due\n');
    git('add', 'a.txt');
    expect(commit('placeholder').status).toBe(0);
  });

  it('refuses the shape even with no roster to check names against', () => {
    // The name guard passes with a warning when the roster is gone. This one needs
    // no roster, so it must still bite.
    env.OD_REDACT_NAMES = join(dir, 'no-such-roster.txt');
    writeFileSync(join(repo, 'a.txt'), 'CFS 7654321 chased\n');
    git('add', 'a.txt');
    const r = commit('no roster, real shape');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('private reference number');
  });

  it('does not fire on other reference shapes that are not private', () => {
    // Control. A guard that refuses every letters-then-digits reference would be
    // turned off within a week.
    writeFileSync(join(repo, 'a.txt'), 'UC47 form, v12 1234567, UTR 0123456789\n');
    git('add', 'a.txt');
    expect(commit('other refs').status).toBe(0);
  });
});
