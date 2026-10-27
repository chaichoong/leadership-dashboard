// A live routine's instructions that are not mirrored in the repo must be
// refused in the session that made the drift, not in someone else's gate.
//
// Regression origin: finding 20261014-queue-fixer-868. `.claude/scheduled-tasks/`
// mirrors every live ~/.claude/scheduled-tasks/<name>/SKILL.md and
// tests/scheduled-tasks-tracked.test.js fails on drift. That test runs in the
// pre-push gate and in fixer-merge.py, so an unmirrored live edit turns EVERY
// open pull request's gate red — on a file that pull request never touched. The
// gate's JSON keeps only a 400-character tail (finding 867), so the red does not
// name the file and reads as a flake. It cost two gate runs on 14 Oct 2026, and
// on 16 Oct 2026 origin/main itself was red because the live
// ai-team-week-check-2026-10-22 routine was never mirrored.
//
// These tests drive the REAL guard and the REAL hook. The live directory is
// pointed at a scratch copy through SCHEDULED_TASKS_LIVE, which the sync script
// reads at call time for exactly this reason.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const GUARD = resolve(__dirname, '../scripts/scheduled-task-drift-guard.py');
const HOOK = resolve(__dirname, '../scripts/pre-commit');
const TRACKED = resolve(__dirname, '../.claude/scheduled-tasks');

let scratch;
let inSync;
let drifted;

// Run a script and return { code, out } whatever it exits with. A guard that
// blocks exits non-zero, so a throwing helper would hide the case under test.
function run(script, liveDir) {
  try {
    const out = execFileSync('python3', [script], {
      encoding: 'utf8',
      env: { ...process.env, SCHEDULED_TASKS_LIVE: liveDir },
      cwd: resolve(__dirname, '..'),
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'drift-guard-'));

  // In sync: an exact copy of the tracked mirror.
  inSync = join(scratch, 'in-sync');
  cpSync(TRACKED, inSync, { recursive: true });

  // Drifted: the same copy plus one live-only routine, which is the exact shape
  // of both real incidents.
  drifted = join(scratch, 'drifted');
  cpSync(TRACKED, drifted, { recursive: true });
  mkdirSync(join(drifted, 'never-reviewed-routine'), { recursive: true });
  writeFileSync(
    join(drifted, 'never-reviewed-routine', 'SKILL.md'),
    '---\nname: never-reviewed-routine\n---\nEdited live, never mirrored.\n'
  );
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('the scheduled-task drift guard', () => {
  it('is installed in the pre-commit hook', () => {
    expect(existsSync(GUARD)).toBe(true);
    expect(existsSync(HOOK)).toBe(true);
  });

  it('CONTROL: the copy it compares against is real, so a pass means something', () => {
    // An empty mirror compared with an empty live directory reads "in sync"
    // forever. That silent zero is the trap this codebase keeps hitting, so the
    // fixture itself is asserted to hold real routines.
    const routines = readdirSync(inSync).filter((n) =>
      existsSync(join(inSync, n, 'SKILL.md'))
    );
    expect(routines.length).toBeGreaterThanOrEqual(15);
    expect(routines).toContain('queue-fixer');
  });

  it('passes when every live routine is mirrored', () => {
    const { code } = run(GUARD, inSync);
    expect(code).toBe(0);
  });

  it('REFUSES an unmirrored live routine, and names it', () => {
    const { code, out } = run(GUARD, drifted);
    expect(code).toBe(1);
    expect(out).toMatch(/BLOCKED/);
    // Naming the routine is the whole point: the gate's tail does not.
    expect(out).toContain('never-reviewed-routine');
  });

  it('gives the one command that cures it', () => {
    const { out } = run(GUARD, drifted);
    expect(out).toMatch(/sync-scheduled-tasks\.py --pull/);
  });

  it('says why it matters, so the refusal is not read as noise', () => {
    const { out } = run(GUARD, drifted);
    expect(out).toMatch(/every open pull request's gate red/i);
  });

  it('passes when there is no live directory at all (another machine, CI)', () => {
    // A red gate nobody can act on teaches people to bypass the gate.
    const { code } = run(GUARD, join(scratch, 'does-not-exist'));
    expect(code).toBe(0);
  });

  it('the real pre-commit hook refuses the drift', () => {
    // End to end. The guard runs before the pageVer bump, so a blocked commit
    // leaves no side effect behind — which is why this can be driven for real.
    const { code, out } = run(HOOK, drifted);
    expect(code).not.toBe(0);
    expect(out).toContain('never-reviewed-routine');
  });

  it('the hook checks the tree being committed, not the checkout its link points into', () => {
    // 27 Oct 2026: .git/hooks/pre-commit resolves into the MAIN checkout. Another session held it on a
    // branch from before a merged routine change, so its guard compared the live routines with an old
    // mirror and refused every commit in every worktree. Here an "old checkout" holds the same three
    // scripts and a mirror one routine behind the live copy; committing from this tree must pass.
    const old = join(scratch, 'old-checkout');
    mkdirSync(join(old, 'scripts'), { recursive: true });
    for (const f of ['pre-commit', 'scheduled-task-drift-guard.py', 'sync-scheduled-tasks.py']) {
      cpSync(resolve(__dirname, '../scripts', f), join(old, 'scripts', f));
    }
    cpSync(TRACKED, join(old, '.claude', 'scheduled-tasks'), { recursive: true });
    writeFileSync(join(old, '.claude', 'scheduled-tasks', 'queue-fixer', 'SKILL.md'), 'an older reviewed copy\n');
    // CONTROL: that old checkout's own guard does refuse, so a pass below means the hook looked elsewhere.
    const own = run(join(old, 'scripts', 'scheduled-task-drift-guard.py'), inSync);
    expect(own.code).toBe(1);
    expect(own.out).toContain('queue-fixer');
    const { out } = run(join(old, 'scripts', 'pre-commit'), inSync);
    expect(out).not.toMatch(/BLOCKED: a scheduled routine/);
  });

  it('the real pre-commit hook does not refuse when in sync', () => {
    const { out } = run(HOOK, inSync);
    expect(out).not.toMatch(/BLOCKED: a scheduled routine/);
  });
});
