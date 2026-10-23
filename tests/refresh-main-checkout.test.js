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
  // finding 20261019-phase-4-994: the fix phase commits a monitoring report from a
  // worktree and the original stays untracked here. Once the path is on origin/main,
  // reset --keep refuses — correctly, since it cannot know the bytes match — and no
  // scheduled run has a way out of it. An exact duplicate is cleared; a changed one
  // is not.
  it('clears an untracked file byte-identical to the one origin/main adds, then refreshes', () => {
    const dir = setup();
    advanceOrigin(dir, 'e2e-sweep.md');                     // origin/main gains the path, with 'new\n'
    writeFileSync(join(dir, 'e2e-sweep.md'), 'new\n');       // the untracked twin, same bytes
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/CLEARED 1 untracked file\(s\).*e2e-sweep\.md/);
    expect(r.stdout).toMatch(/REFRESHED/);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'origin/main'));
    // The committed version is what is on disk, so nothing was lost.
    expect(readFileSync(join(dir, 'e2e-sweep.md'), 'utf8')).toBe('new\n');
  });

  it('BACK-TEST: an untracked file that DIFFERS is left alone and the refresh still refuses', () => {
    // The control. If this ever passes, the clearing step has stopped checking the
    // contents and is deleting work.
    const dir = setup();
    advanceOrigin(dir, 'e2e-sweep.md');
    writeFileSync(join(dir, 'e2e-sweep.md'), 'MINE, not yet committed\n');
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/REFUSED/);
    expect(r.stdout).not.toMatch(/CLEARED/);
    expect(readFileSync(join(dir, 'e2e-sweep.md'), 'utf8')).toBe('MINE, not yet committed\n');
    expect(git(dir, 'rev-parse', 'HEAD')).not.toBe(git(dir, 'rev-parse', 'origin/main'));
  });

  it('--check names the duplicates and deletes nothing', () => {
    const dir = setup();
    advanceOrigin(dir, 'e2e-sweep.md');
    writeFileSync(join(dir, 'e2e-sweep.md'), 'new\n');
    const r = run(dir, '--check');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/byte-identical to origin\/main and would be cleared: e2e-sweep\.md/);
    expect(readFileSync(join(dir, 'e2e-sweep.md'), 'utf8')).toBe('new\n');
  });
});

// A TRACKED FILE MIRRORED TO ORIGIN/MAIN'S EXACT BYTES (finding
// 20261020-queue-fixer-1009, fixed 23 Oct 2026). The scheduled-task drift guard
// needs a repo-side SKILL.md change mirrored into the main checkout, so on
// 20 Oct 2026 `reset --keep` refused with "not uptodate" and the checkout sat 3
// behind until a person cleared it by hand. Back-tested by deleting the
// duplicate_tracked call, which fails the first and last case here.
describe('a tracked file edited to exactly what origin/main holds', () => {
  /** Advance origin by MODIFYING a file that already exists here. */
  function advanceOriginEditing(dir, file, body) {
    const other = `${dir}-other-${file}`;
    execFileSync('git', ['clone', '-q', `${dir}-origin.git`, other]);
    for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) git(other, 'config', k, v);
    writeFileSync(join(other, file), body);
    git(other, 'add', '.'); git(other, 'commit', '-qm', 'upstream edit'); git(other, 'push', '-q', 'origin', 'HEAD:main');
  }

  it('is restored, and the checkout moves forward instead of refusing', () => {
    const dir = setup();
    advanceOriginEditing(dir, 'a.txt', 'mirrored\n');
    writeFileSync(join(dir, 'a.txt'), 'mirrored\n');   // the same bytes, by hand, before the commit
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/RESTORED 1 tracked file\(s\).*a\.txt/);
    expect(r.stdout).toMatch(/REFRESHED/);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'origin/main'));
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('mirrored\n');
  });

  it('one byte of difference is left alone and the refusal stands', () => {
    const dir = setup();
    advanceOriginEditing(dir, 'a.txt', 'mirrored\n');
    writeFileSync(join(dir, 'a.txt'), 'mirrored but not quite\n');
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/REFUSED/);
    expect(r.stdout).not.toMatch(/RESTORED/);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('mirrored but not quite\n');
  });

  it('a STAGED change is never discarded, even when the working tree matches', () => {
    const dir = setup();
    advanceOriginEditing(dir, 'a.txt', 'mirrored\n');
    writeFileSync(join(dir, 'a.txt'), 'someone staged this\n');
    git(dir, 'add', 'a.txt');
    writeFileSync(join(dir, 'a.txt'), 'mirrored\n');
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/RESTORED/);
    expect(git(dir, 'show', ':a.txt')).toBe('someone staged this');
  });

  it('--check names it and restores nothing', () => {
    const dir = setup();
    advanceOriginEditing(dir, 'a.txt', 'mirrored\n');
    writeFileSync(join(dir, 'a.txt'), 'mirrored\n');
    const r = run(dir, '--check');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/edited to origin\/main's exact bytes and would be restored: a\.txt/);
    expect(git(dir, 'rev-parse', 'HEAD')).not.toBe(git(dir, 'rev-parse', 'origin/main'));
  });
});
