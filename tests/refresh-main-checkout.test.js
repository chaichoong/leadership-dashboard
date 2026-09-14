// daily-ops ran its guards from a main checkout 33 commits behind origin/main
// (finding 20260914-daily-ops-528). refresh-main-checkout.py moves it forward
// before phase 1, and must never lose work doing so. Each case builds a real
// scratch repo with an "origin" so git itself decides, not a mock.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/refresh-main-checkout.py');
const ROOT = mkdtempSync(join(tmpdir(), 'refreshmain-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function setup() {
  const dir = join(ROOT, `case${n++}`);
  const origin = `${dir}-origin.git`;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, dir]);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) git(dir, 'config', k, v);
  writeFileSync(join(dir, 'a.txt'), '1\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'one'); git(dir, 'push', '-q', 'origin', 'HEAD:main');
  git(dir, 'fetch', '-q', 'origin');
  git(dir, 'checkout', '-qb', 'chore/main-checkout', 'origin/main');
  return dir;
}

function advanceOrigin(dir, file = 'b.txt') {
  const other = `${dir}-other`;
  execFileSync('git', ['clone', '-q', `${dir}-origin.git`, other]);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) git(other, 'config', k, v);
  writeFileSync(join(other, file), 'new\n');
  git(other, 'add', '.'); git(other, 'commit', '-qm', 'upstream'); git(other, 'push', '-q', 'origin', 'HEAD:main');
}

const run = (dir, ...extra) => spawnSync('python3', [SCRIPT, '--repo', dir, ...extra], { encoding: 'utf8' });

describe('refresh-main-checkout', () => {
  it('reports CURRENT when nothing is behind', () => {
    const r = run(setup());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/CURRENT/);
  });

  it('moves a stale checkout forward and keeps unrelated uncommitted edits', () => {
    const dir = setup();
    advanceOrigin(dir);
    writeFileSync(join(dir, 'a.txt'), 'someone else is editing\n');
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/REFRESHED.*1 commits/);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'origin/main'));
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('someone else is editing\n');
  });

  it('--check reports stale and moves nothing', () => {
    const dir = setup();
    advanceOrigin(dir);
    const before = git(dir, 'rev-parse', 'HEAD');
    const r = run(dir, '--check');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/STALE/);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('refuses when the branch holds commits not on origin/main', () => {
    const dir = setup();
    writeFileSync(join(dir, 'mine.txt'), 'local work\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'local only');
    advanceOrigin(dir);
    git(dir, 'fetch', '-q', 'origin');
    const before = git(dir, 'rev-parse', 'HEAD');
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/REFUSED.*1 commit/);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('refuses rather than overwrite an uncommitted edit to a file upstream changed', () => {
    const dir = setup();
    advanceOrigin(dir, 'a.txt');
    writeFileSync(join(dir, 'a.txt'), 'uncommitted\n');
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/REFUSED/);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('uncommitted\n');
  });
});
