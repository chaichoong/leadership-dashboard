// Tests for the routine-report collector.
//
// Regression origin: 8 Aug 2026. The scheduled routines went read-only on 6 Aug and
// now write their report into the MAIN checkout's monitoring/ and stop. queue-fixer,
// the single writer, works in a git worktree. `git add -A` in a worktree cannot see
// another working tree, so every report written after 6 Aug was silently never
// committed — the last e2e sweep in git history was 2026-08-06 and nothing errored.
//
// These tests build real git repos with a real `git worktree`, because the bug IS
// the relationship between two working trees. Mocking git would stub out the exact
// layer that broke.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const COLLECT = resolve(__dirname, '../scripts/collect-routine-reports.py');

const ROOT = mkdtempSync(join(tmpdir(), 'collect-reports-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
let main;
let worktree;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function collect(cwd, args = []) {
  return execFileSync('python3', [COLLECT, ...args], { cwd, encoding: 'utf8' });
}

beforeEach(() => {
  main = join(ROOT, `main-${seq++}`);
  mkdirSync(main, { recursive: true });
  git(['init', '-q', '-b', 'main'], main);
  git(['config', 'user.email', 'test@example.com'], main);
  git(['config', 'user.name', 'Test'], main);

  mkdirSync(join(main, 'monitoring'), { recursive: true });
  // The real ignore rules: sweep working files carry tenant names and rent figures,
  // and this repo is public.
  writeFileSync(
    join(main, 'monitoring/.gitignore'),
    'task-sweep-worklist-*.json\ntask-sweep-detail-*.md\ndrift-2*.md\n'
  );
  git(['add', '-A'], main);
  git(['commit', '-q', '-m', 'init'], main);

  worktree = join(ROOT, `wt-${seq}`);
  git(['worktree', 'add', '-q', '-b', `fix/x-${seq}`, worktree], main);
});

describe('collect-routine-reports', () => {
  it('collects a report written in the main checkout while running in a worktree', () => {
    writeFileSync(join(main, 'monitoring/task-sweep-2026-08-08.md'), '# sweep\n');

    const out = collect(worktree);

    expect(out).toContain('COLLECTED monitoring/task-sweep-2026-08-08.md');
    expect(existsSync(join(worktree, 'monitoring/task-sweep-2026-08-08.md'))).toBe(true);
  });

  it('back-test: without collection the worktree commits nothing, which is the bug', () => {
    writeFileSync(join(main, 'monitoring/task-sweep-2026-08-08.md'), '# sweep\n');

    // Exactly what queue-fixer used to do: add everything it can see, from the worktree.
    git(['add', '-A'], worktree);
    const staged = git(['diff', '--cached', '--name-only'], worktree);

    expect(staged.trim()).toBe('');
  });

  it('NEVER collects a gitignored working file, even though it sits in monitoring/', () => {
    writeFileSync(join(main, 'monitoring/task-sweep-2026-08-08.md'), '# sweep\n');
    // Carries inbound email bodies, tenant names, rent figures, phone numbers.
    writeFileSync(
      join(main, 'monitoring/task-sweep-worklist-2026-08-08.json'),
      '{"tenant":"real name","rent":950}'
    );
    writeFileSync(join(main, 'monitoring/task-sweep-detail-2026-08-08.md'), 'names and sums');
    writeFileSync(join(main, 'monitoring/drift-2026-08-08.md'), 'drift');

    const out = collect(worktree);

    expect(out).toContain('COLLECTED monitoring/task-sweep-2026-08-08.md');
    expect(out).not.toContain('worklist');
    expect(existsSync(join(worktree, 'monitoring/task-sweep-worklist-2026-08-08.json'))).toBe(false);
    expect(existsSync(join(worktree, 'monitoring/task-sweep-detail-2026-08-08.md'))).toBe(false);
    expect(existsSync(join(worktree, 'monitoring/drift-2026-08-08.md'))).toBe(false);
  });

  it('collects a modification to an already-tracked report', () => {
    const rel = 'monitoring/ceo-brief-cron-findings.md';
    writeFileSync(join(main, rel), 'first run\n');
    git(['add', '-A'], main);
    git(['commit', '-q', '-m', 'add findings'], main);
    writeFileSync(join(main, rel), 'first run\nsecond run\n');

    const out = collect(worktree);

    expect(out).toContain(`COLLECTED ${rel}`);
  });

  it('--check reports without copying', () => {
    writeFileSync(join(main, 'monitoring/task-sweep-2026-08-08.md'), '# sweep\n');

    const out = collect(worktree, ['--check']);

    expect(out).toContain('WOULD COLLECT monitoring/task-sweep-2026-08-08.md');
    expect(existsSync(join(worktree, 'monitoring/task-sweep-2026-08-08.md'))).toBe(false);
  });

  it('is a no-op in the main checkout rather than copying a file onto itself', () => {
    writeFileSync(join(main, 'monitoring/task-sweep-2026-08-08.md'), '# sweep\n');

    const out = collect(main);

    expect(out).toContain('Nothing to collect');
  });

  it('says so plainly when there is nothing waiting', () => {
    expect(collect(worktree)).toContain('No uncommitted reports');
  });
});
