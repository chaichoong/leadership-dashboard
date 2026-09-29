// Guards the commit-MESSAGE half of the private-name guard (29 Sep 2026).
//
// WHAT THIS EXISTS FOR
// This repo is PUBLIC. scripts/pre-commit refuses a staged line naming someone
// on the private roster, but it never reads the commit message, and on 29 Sep
// 2026 published commit messages were found naming tenants and property
// addresses. scripts/commit-msg now runs
// `private-name-guard.py --message-file` on every commit message.
//
// These tests make real commits in a throwaway repo with the real hook
// installed as a symlink (exactly as .git/hooks/commit-msg is installed), so
// they fail if the guard stops refusing OR if the hook stops calling it.
// Fictional names only: this file is committed to a PUBLIC repo.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(ROOT, 'scripts/private-name-guard.py');
const HOOK = join(ROOT, 'scripts/commit-msg');
// "Kevin Brittain" is on the list to prove his own name stays allowed.
const ROSTER = '# test roster\nJane Testwood\nMartin\nKevin Brittain\n';

let dir, repo, env;

function git(...args) {
  return execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(...args) {
  return spawnSync('git', ['commit', '-q', ...args], { cwd: repo, env, encoding: 'utf8' });
}

function stage(file, text) {
  writeFileSync(join(repo, file), text);
  git('add', file);
}

const commits = () => { try { return git('rev-list', '--count', 'HEAD').trim(); } catch (e) { return '0'; } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'private-guard-msg-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  writeFileSync(join(dir, 'roster.txt'), ROSTER);
  env = {
    ...process.env,
    OD_REDACT_NAMES: join(dir, 'roster.txt'),
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const k of ['GIT_EDITOR', 'VISUAL', 'EDITOR']) delete env[k];
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Guard Test');
  symlinkSync(HOOK, join(repo, '.git/hooks/commit-msg'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('commit-msg hook: the message is checked, not just the staged lines', () => {
  it('refuses a message that names someone on the roster, says which line, never repeats the name', () => {
    stage('a.txt', 'nothing private here\n');
    const r = commit('-m', 'Fix rent\n\nChased Jane Testwood for August.');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('commit MESSAGE names a person on the private roster (line 3)');
    expect(r.stderr).not.toMatch(/testwood/i);
    expect(commits()).toBe('0');
  });

  it('lets a clean message through', () => {
    stage('a.txt', 'nothing private here\n');
    const r = commit('-m', 'Fix: the rent card');
    expect(r.status, r.stderr).toBe(0);
    expect(git('log', '--format=%s')).toContain('Fix: the rent card');
  });

  it('matches in any case and across a line wrap, and names the line the name starts on', () => {
    stage('a.txt', 'x\n');
    const r = commit('-m', 'Arrears\n\nEmailed JANE\ntestwood twice.');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('(line 3)');
  });

  it('lists every line that names someone', () => {
    stage('a.txt', 'x\n');
    const r = commit('-m', 'Jane Testwood\n\nsecond mention: jane testwood');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('(lines 1, 3)');
  });

  it('KNOWN LIMIT, pinned: a first name alone is not caught (full names only, by design)', () => {
    stage('a.txt', 'x\n');
    const r = commit('-m', 'Jane paid, Martin fixed the boiler');
    expect(r.status, r.stderr).toBe(0);
  });

  it("Kevin's own name stays allowed even when the roster lists it", () => {
    stage('a.txt', 'x\n');
    expect(commit('-m', 'Kevin Brittain approved this').status).toBe(0);
  });

  it('also refuses an amend and a merge commit that name someone', () => {
    stage('a.txt', 'x\n');
    expect(commit('-m', 'base').status).toBe(0);
    expect(commit('--amend', '-m', 'base for Jane Testwood').status).not.toBe(0);
    git('checkout', '-q', '-b', 'side');
    stage('b.txt', 'y\n');
    expect(commit('-m', 'side').status).toBe(0);
    git('checkout', '-q', 'main');
    const m = spawnSync('git', ['merge', '--no-ff', '-m', 'Merge Jane Testwood work', 'side'], { cwd: repo, env, encoding: 'utf8' });
    expect(m.status).not.toBe(0);
    expect(m.stderr).toContain('commit MESSAGE names a person');
    expect(git('log', '-1', '--format=%s', 'main').trim()).toBe('base');
  });

  describe('git commit -v: the diff under the scissors line is not the message', () => {
    // An editor that puts MSG above whatever git wrote into the file.
    const editor = () => {
      const p = join(dir, 'editor.sh');
      writeFileSync(p, '#!/bin/sh\n{ printf \'%s\\n\' "$MSG"; cat "$1"; } > "$1.new" && mv "$1.new" "$1"\n');
      chmodSync(p, 0o755);
      return p;
    };

    it('a commit that REMOVES a name is not refused for quoting it in the diff', () => {
      stage('notes.md', 'Jane Testwood\nkeep\n');
      git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'seed');
      stage('notes.md', 'keep\n');
      const r = spawnSync('git', ['commit', '-q', '-v'], {
        cwd: repo, encoding: 'utf8', env: { ...env, GIT_EDITOR: editor(), MSG: 'Scrub a private name' },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(git('log', '-1', '--format=%s').trim()).toBe('Scrub a private name');
    });

    it('a name ABOVE the scissors line is still refused', () => {
      stage('notes.md', 'keep\n');
      const r = spawnSync('git', ['commit', '-q', '-v'], {
        cwd: repo, encoding: 'utf8', env: { ...env, GIT_EDITOR: editor(), MSG: 'Rent for Jane Testwood' },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('(line 1)');
    });
  });

  it('with no roster it warns loudly and lets the commit through, like the staged-diff check', () => {
    env.OD_REDACT_NAMES = join(dir, 'no-such-roster.txt');
    stage('a.txt', 'x\n');
    const r = commit('-m', 'Rent for Jane Testwood');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('commit message was NOT checked');
  });
});

describe('private-name-guard.py --message-file, called directly', () => {
  const run = (args) => spawnSync('python3', [GUARD, ...args], { env, encoding: 'utf8' });

  it('exit 1 on a hit, 0 when clean', () => {
    const f = join(dir, 'MSG');
    writeFileSync(f, 'Fix\n\nfor Jane Testwood\n');
    expect(run(['--message-file', f]).status).toBe(1);
    writeFileSync(f, 'Fix\n\nfor nobody\n');
    expect(run(['--message-file', f]).status).toBe(0);
  });

  it('a message file it cannot read is an error (exit 2), never a quiet pass', () => {
    const r = run(['--message-file', join(dir, 'missing')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot read the commit message');
  });

  it('the hook refuses when git passes it no message file at all', () => {
    const r = spawnSync('python3', [HOOK], { env, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing rather than letting an unchecked message through');
  });
});
