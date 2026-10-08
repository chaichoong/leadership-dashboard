// The local pageVer bump must not put js/config.js in a branch's diff.
//
// WHY (8 Oct 2026, finding 20261005-daily-ops-748)
// js/config.js is on fixer-merge.py's protected list, so the gate refuses to
// auto-merge any PR touching it. The pre-commit hook bumped pageVer in that
// file on every commit that touched a mapped page file, so the fix phase could
// not merge its own front-end work. Proved on PR 690: protected:[js/config.js]
// mayAutoMerge:false, and protected:[] once config.js matched origin/main.
// auto-bump-pagever.yml does the same bump on every push to main, so a branch
// never needed the local copy.
//
// The guard drives the real script inside a throwaway git repo. It never
// touches this repo: every git call runs with cwd inside the temp directory
// and with GIT_DIR / GIT_WORK_TREE cleared, after a shared core.bare=true in
// a parent config once made tests write into the real repo (2 Oct 2026).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/pre-commit-action.py');
const ROOT = mkdtempSync(join(tmpdir(), 'pagever-bump-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const CLEAN_ENV = { ...process.env };
delete CLEAN_ENV.GIT_DIR;
delete CLEAN_ENV.GIT_WORK_TREE;
delete CLEAN_ENV.GITHUB_ACTIONS;
delete CLEAN_ENV.GITHUB_BEFORE_SHA;
delete CLEAN_ENV.CHANGED_FILES;

let repo;
let n = 0;

function git(...args) {
  return execFileSync('git', args, { cwd: repo, env: CLEAN_ENV, encoding: 'utf8' });
}

// The real registry entry shape, so the script's regex is the thing under test.
const CONFIG = `const PAGE_REGISTRY = [
  { id: 'compliance', file: 'compliance.html', pageVer: '1.4', sopVer: '1.0' },
];
`;

beforeEach(() => {
  repo = join(ROOT, `r${n++}`);
  mkdirSync(join(repo, 'js'), { recursive: true });
  git('init', '--initial-branch=main', '--quiet');
  git('config', 'core.bare', 'false');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'js/config.js'), CONFIG);
  writeFileSync(join(repo, 'compliance.html'), '<p>one</p>');
  git('add', '-A');
  git('commit', '-m', 'base', '--quiet', '--no-verify');
});

function stageAndRun() {
  writeFileSync(join(repo, 'compliance.html'), '<p>two</p>');
  git('add', 'compliance.html');
  const out = execFileSync('python3', [SCRIPT], { cwd: repo, env: CLEAN_ENV, encoding: 'utf8' });
  return { out, config: readFileSync(join(repo, 'js/config.js'), 'utf8') };
}

describe('pre-commit pageVer bump', () => {
  it('leaves js/config.js alone on a branch, so the gate can merge the PR', () => {
    git('switch', '--quiet', '-c', 'fix/some-topic');
    const { out, config } = stageAndRun();
    expect(config, 'the branch commit still carries a protected-file change')
      .toContain("pageVer: '1.4'");
    expect(out).toMatch(/not main/);
    expect(git('diff', '--cached', '--name-only'), 'config.js is staged on a branch')
      .not.toContain('js/config.js');
  });

  it('still bumps on main, where the workflow is not the one pushing', () => {
    const { config } = stageAndRun();
    expect(config, 'the cache-bust version stopped moving on main')
      .toContain("pageVer: '1.5'");
    expect(git('diff', '--cached', '--name-only')).toContain('js/config.js');
  });

  it('still bumps in CI, whatever branch the runner is standing on', () => {
    git('switch', '--quiet', '-c', 'fix/ci-topic');
    writeFileSync(join(repo, 'compliance.html'), '<p>three</p>');
    git('add', 'compliance.html');
    execFileSync('python3', [SCRIPT], {
      cwd: repo, encoding: 'utf8',
      env: { ...CLEAN_ENV, GITHUB_ACTIONS: 'true', CHANGED_FILES: 'compliance.html' },
    });
    expect(readFileSync(join(repo, 'js/config.js'), 'utf8'),
      'the workflow stopped bumping').toContain("pageVer: '1.5'");
  });
});
