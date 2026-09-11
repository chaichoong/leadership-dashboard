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
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

  // Finding 20260910-queue-fixer-516. On 8-10 Sep 2026 the collector took
  // everything git called untracked, so an agent's dispatch queue dump (859
  // email addresses), a folder of per-task drafts and two *-tmp.json files were
  // candidates for a PUBLIC repo, with only regex masking in the way.
  it('REFUSES agent working files, collecting only report-shaped names', () => {
    writeFileSync(join(main, 'monitoring/daily-ops-2026-09-10.md'), '# ops\n');
    writeFileSync(join(main, 'monitoring/queue-1300-tmp.json'), '{"a":1}\n');
    writeFileSync(join(main, 'monitoring/dispatch-report-1300.json'), '{"a":1}\n');
    writeFileSync(join(main, 'monitoring/recMTcV6AEYbqx7L2.md'), 'draft\n');
    writeFileSync(join(main, 'monitoring/ep2195_revised.md'), 'draft\n');
    mkdirSync(join(main, 'monitoring/dispatch-0900-20260909'), { recursive: true });
    writeFileSync(join(main, 'monitoring/dispatch-0900-20260909/queue.json'), '{"a":1}\n');

    const out = collect(worktree);

    expect(out).toContain('COLLECTED monitoring/daily-ops-2026-09-10.md');
    for (const rel of ['monitoring/queue-1300-tmp.json', 'monitoring/dispatch-report-1300.json',
      'monitoring/recMTcV6AEYbqx7L2.md', 'monitoring/ep2195_revised.md',
      'monitoring/dispatch-0900-20260909/queue.json']) {
      expect(out).toContain(`REFUSED (not a report shape; agent working files never enter a public repo): ${rel}`);
      expect(existsSync(join(worktree, rel)), `${rel} reached the worktree`).toBe(false);
    }
    expect(out).toMatch(/REFUSED 5 file\(s\)/);
  });

  it('still collects every report shape that is in git history', () => {
    const names = ['task-sweep-2026-08-09b.md', 'daily-ops-2026-08-10.17slot.md',
      'inbound-triage-09slot-2026-08-24.json', 'e2e-sweep-2026-08-06.md',
      'drift-exceptions-2026-08-20.json', 'ceo-brief-cron-findings.md'];
    for (const n of names) writeFileSync(join(main, 'monitoring', n), '# r\n');

    const out = collect(worktree);

    for (const n of names) expect(out).toContain(`COLLECTED monitoring/${n}`);
    expect(out).not.toContain('REFUSED');
  });

  it('APPENDS to a report the worktree already holds, never overwrites it', () => {
    const rel = 'monitoring/daily-ops-2026-09-10.md';
    // The worktree's copy is from origin/main and can be newer than the main
    // checkout's, which is often a stale session branch.
    writeFileSync(join(worktree, rel), 'phase 5 from origin\n');
    writeFileSync(join(main, rel), 'phase 1 from this morning\n');

    const out = collect(worktree);

    expect(out).toContain(`APPENDED ${rel}`);
    const text = readFileSync(join(worktree, rel), 'utf8');
    expect(text).toContain('phase 5 from origin');
    expect(text).toContain('phase 1 from this morning');
  });

  it('writes nothing when the worktree already holds that report', () => {
    const rel = 'monitoring/daily-ops-2026-09-10.md';
    writeFileSync(join(worktree, rel), 'same\n');
    writeFileSync(join(main, rel), 'same\n');

    expect(collect(worktree)).toContain(`ALREADY HERE ${rel}`);
    expect(readFileSync(join(worktree, rel), 'utf8')).toBe('same\n');
  });
});
