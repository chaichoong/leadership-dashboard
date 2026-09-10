// THE ENGINE'S OWN WORKING FILE HAD SWITCHED OFF ITS OWN UPDATES.
//
// Finding 20260909-queue-fixer-504. content-engine runs from
// .claude/worktrees/content-engine-runtime, not the main checkout, and
// content-engine-run.sh fast-forwards that worktree onto origin/main before
// every run — but only when `git status --porcelain` printed NOTHING.
//
// The engine writes runpreneur-map/data/progress.json as it runs. So that file
// is permanently modified in the runtime worktree, the gate was permanently
// shut, and the update had not run for as long as anyone could tell. Measured
// on 9 Sep 2026: `main...origin/main [behind 5]`, with the diskGB precondition
// written FOR this very job among the five commits it could not see. Nothing
// errored. The skip printed nothing at all, which is the part that made it
// survive — a job silently pinned to stale code means every future queue fix
// misses it.
//
// Tested against REAL git repositories, because the bug is entirely in how git
// answers, and the block is extracted verbatim from the shipped script.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RUNNER = resolve(__dirname, '../scripts/content-engine-run.sh');
const src = readFileSync(RUNNER, 'utf8');
const ROOT = mkdtempSync(join(tmpdir(), 'ce-runtime-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function block() {
  const a = src.indexOf('# --- runtime-update-block');
  const b = src.indexOf('# --- end runtime-update-block ---');
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: {
    ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  } });

// An upstream with two commits, and a clone parked on the first.
function scenario(name, { dirtyFile = null, dirtyContent = '{"a":999}\n',
                          aheadCommits = 1, branch = 'main' } = {}) {
  const dir = join(ROOT, name);
  const up = join(dir, 'upstream');
  const work = join(dir, 'work');
  mkdirSync(up, { recursive: true });
  git(up, 'init', '-q', '-b', 'main');
  writeFileSync(join(up, 'code.txt'), 'v1\n');
  writeFileSync(join(up, 'progress.json'), '{"a":1}\n');
  git(up, 'add', '-A'); git(up, 'commit', '-qm', 'v1');
  git(dir, 'clone', '-q', up, 'work');
  for (let i = 0; i < aheadCommits; i++) {
    writeFileSync(join(up, 'code.txt'), `v${i + 2}\n`);
    git(up, 'add', '-A'); git(up, 'commit', '-qm', `v${i + 2}`);
  }
  if (branch !== 'main') git(work, 'checkout', '-q', '-b', branch);
  // The engine's own runtime file, dirty exactly as it is in production.
  if (dirtyFile) writeFileSync(join(work, dirtyFile), dirtyContent);
  const sh = join(dir, 'run.sh');
  writeFileSync(sh, `set -uo pipefail\nREPO=${JSON.stringify(work)}\n${block()}\n`);
  // ONE run, both streams. Running it twice would fast-forward on the first
  // pass and then truthfully report "up to date" on the second, which would
  // make this test pass for the wrong reason.
  const out = execFileSync('bash', ['-c', `bash ${JSON.stringify(sh)} 2>&1`],
    { encoding: 'utf8' });
  return { out, head: () => git(work, 'log', '-1', '--pretty=%s').trim() };
}

describe('the content-engine runtime checkout updates itself, loudly', () => {
  it('9 Sep back-test: a dirty progress.json no longer blocks the update', () => {
    const r = scenario('dirty', { dirtyFile: 'progress.json', aheadCommits: 5 });
    // This is the assertion that fails on the old code: the blanket porcelain
    // gate saw progress.json and skipped the pull without a word.
    expect(r.head()).toBe('v6');
    expect(r.out).toMatch(/fast-forwarded/);
  });

  it('an up-to-date checkout says so rather than saying nothing', () => {
    const r = scenario('current', { aheadCommits: 0 });
    expect(r.out).toMatch(/up to date with origin\/main/);
  });

  it('a checkout that cannot fast-forward is LOUD about running stale code', () => {
    // A local edit to the very file the pull would overwrite: --ff-only refuses,
    // which is the protection that was actually wanted — but the run must say so.
    const r = scenario('conflict', { dirtyFile: 'code.txt', aheadCommits: 2 });
    expect(r.head()).toBe('v1');
    expect(r.out).toMatch(/BEHIND origin\/main and could not fast-forward/);
    expect(r.out).toMatch(/executing STALE code/);
  });

  // 10 Sep 2026, the case that had actually pinned the runtime worktree: the
  // engine regenerated progress.json to EXACTLY the figures a committed [auto]
  // commit on origin already carried, so --ff-only refused over a file whose
  // local content was worth nothing.
  it('a generated file identical to origin is restored, and the pull retried', () => {
    const r = scenario('identical-generated', {
      dirtyFile: 'code.txt', dirtyContent: 'v3\n', aheadCommits: 2,
    });
    expect(r.head()).toBe('v3');
    expect(r.out).toMatch(/after restoring 1 generated file\(s\) already identical to origin/);
  });

  it('a file with REAL local content is never discarded to force a pull', () => {
    const r = scenario('real-local', {
      dirtyFile: 'code.txt', dirtyContent: 'something a human wrote\n', aheadCommits: 2,
    });
    expect(r.head()).toBe('v1');
    expect(r.out).toMatch(/executing STALE code/);
    expect(readFileSync(join(ROOT, 'real-local', 'work', 'code.txt'), 'utf8'))
      .toBe('something a human wrote\n');
  });

  it('a checkout parked off main is reported, never updated silently', () => {
    const r = scenario('offmain', { branch: 'wip' });
    expect(r.out).toMatch(/NOT ON main \(wip\)/);
  });

  it('the blanket dirty-tree veto is gone from the shipped script', () => {
    expect(block()).not.toMatch(/-z "\$\(git -C "\$REPO" status --porcelain/);
    // status --porcelain survives only as the explanation printed on a refusal.
    expect(block()).toMatch(/executing STALE code[\s\S]*status --porcelain/);
  });
});
