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
import { execFileSync, spawnSync } from 'node:child_process';
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

// Finding 20261026-queue-fixer-1088. --check only says the copies DIFFER, and the guard
// blocked both directions alike. A reviewed copy edited AHEAD of live is a routine's
// instructions going for review before they go live, which is the right order; blocking it
// left --push as the only cure, and that rewrites a running routine with an unmerged change.
// On 26 Oct 2026 the fixer got through only by running --pull in the main checkout as well.
//
// These drive the REAL guard against a REAL git index in a scratch repo. core.bare is
// asserted, because a bare scratch repo once sent a test's writes into this very checkout.
describe('which way the drift runs', () => {
  let repo;
  let live;

  // spawnSync, not execFileSync: the exempted path exits 0 and says why on STDERR,
  // which execFileSync's return value drops.
  function guardIn(cwd) {
    const r = spawnSync('python3', [join(cwd, 'scripts', 'scheduled-task-drift-guard.py')], {
      encoding: 'utf8', cwd, env: { ...process.env, SCHEDULED_TASKS_LIVE: live },
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'drift-direction-'));
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    for (const f of ['scheduled-task-drift-guard.py', 'sync-scheduled-tasks.py']) {
      cpSync(resolve(__dirname, '../scripts', f), join(repo, 'scripts', f));
    }
    cpSync(TRACKED, join(repo, '.claude', 'scheduled-tasks'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base', '--no-verify'], { cwd: repo });
    // The live copy is an exact mirror of that committed state.
    live = join(repo, 'live');
    cpSync(join(repo, '.claude', 'scheduled-tasks'), live, { recursive: true });
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('CONTROL: the scratch repo is a real working tree, not bare', () => {
    expect(execFileSync('git', ['config', '--get', 'core.bare'], { cwd: repo, encoding: 'utf8' }).trim())
      .toBe('false');
    expect(guardIn(repo).code).toBe(0);   // and it starts in sync
  });

  it('lets through a reviewed copy that this commit is changing, and names the --push it owes', () => {
    const f = join(repo, '.claude', 'scheduled-tasks', 'queue-fixer', 'SKILL.md');
    writeFileSync(f, '---\nname: queue-fixer\n---\nA reviewed improvement, not yet live.\n');
    // CONTROL: unstaged, the direction is unknown, so it still blocks.
    const unstaged = guardIn(repo);
    expect(unstaged.code).toBe(1);
    expect(unstaged.out).toMatch(/BLOCKED/);
    execFileSync('git', ['add', '.claude/scheduled-tasks/queue-fixer/SKILL.md'], { cwd: repo });
    const staged = guardIn(repo);
    expect(staged.code).toBe(0);
    expect(staged.out).toContain('queue-fixer');
    expect(staged.out).toMatch(/sync-scheduled-tasks\.py --push/);
    // The exemption moves the refusal off the commit; it does not excuse the push. The gate
    // (tests/scheduled-tasks-tracked.test.js) runs where nothing is staged, so it still wants
    // the two copies in sync, and the message has to say so or it reads as "no push needed".
    expect(staged.out).toMatch(/GATE needs it too/);
    execFileSync('git', ['checkout', '--', '.'], { cwd: repo });
    execFileSync('git', ['reset', '-q'], { cwd: repo });
  });

  it('still REFUSES an unmirrored live routine, whatever is staged', () => {
    // The incident the guard exists for must survive the exemption. Here one routine's
    // reviewed copy is staged AND a different routine was edited live only.
    const f = join(repo, '.claude', 'scheduled-tasks', 'queue-fixer', 'SKILL.md');
    writeFileSync(f, '---\nname: queue-fixer\n---\nA reviewed improvement.\n');
    execFileSync('git', ['add', '.claude/scheduled-tasks/queue-fixer/SKILL.md'], { cwd: repo });
    mkdirSync(join(live, 'never-reviewed-routine'), { recursive: true });
    writeFileSync(join(live, 'never-reviewed-routine', 'SKILL.md'), 'Edited live, never mirrored.\n');
    const r = guardIn(repo);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/BLOCKED/);
    expect(r.out).toContain('never-reviewed-routine');
    rmSync(join(live, 'never-reviewed-routine'), { recursive: true, force: true });
    execFileSync('git', ['checkout', '--', '.'], { cwd: repo });
    execFileSync('git', ['reset', '-q'], { cwd: repo });
  });

  it('BACK-TEST: with the staged-mirror check removed, the reviewed change is refused', () => {
    // Break the only thing that fixes it. If this stops blocking, the test above has
    // stopped proving anything.
    const broken = join(repo, 'broken');
    mkdirSync(join(broken, 'scripts'), { recursive: true });
    cpSync(join(repo, 'scripts', 'sync-scheduled-tasks.py'), join(broken, 'scripts', 'sync-scheduled-tasks.py'));
    const src = execFileSync('cat', [join(repo, 'scripts', 'scheduled-task-drift-guard.py')], { encoding: 'utf8' });
    expect(src).toContain('staged = staged_mirror_routines()');
    writeFileSync(join(broken, 'scripts', 'scheduled-task-drift-guard.py'),
      src.replace('staged = staged_mirror_routines()', 'staged = None'));
    cpSync(join(repo, '.claude'), join(broken, '.claude'), { recursive: true });
    const f = join(broken, '.claude', 'scheduled-tasks', 'queue-fixer', 'SKILL.md');
    writeFileSync(f, '---\nname: queue-fixer\n---\nA reviewed improvement.\n');
    const r = guardIn(broken);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/BLOCKED/);
  });
});
