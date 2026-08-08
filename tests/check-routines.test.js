// Exactly one enabled Claude routine, and it must be daily-ops.
//
// Fourteen separately-scheduled routines stampeded on wake and overwrote each
// other. Serialising them behind a lock then produced a worse failure: a routine
// suspended by the Mac sleeping keeps HOLDING the lock (drift-monitor held it
// 4h54m on 8 Aug 2026), so everything behind it was skipped for lateness and
// ceo-huddle never ran once.
//
// Folding them into daily-ops fixed that, and has exactly one failure mode:
// somebody adds a fifteenth routine weeks from now and the stacking restarts,
// quietly, because nothing errors. Hence this guard.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const GUARD = resolve(__dirname, '../scripts/check-routines.py');
const ROOT = mkdtempSync(join(tmpdir(), 'routineguard-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let storeDir;

function writeStore(tasks) {
  const deep = join(storeDir, 'sess', 'run');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, 'scheduled-tasks.json'),
    JSON.stringify({ scheduledTasks: tasks }));
}

function task(name, enabled) {
  return {
    id: `id-${name}`,
    enabled,
    cronExpression: '0 7 * * *',
    filePath: `/Users/x/.claude/scheduled-tasks/${name}/SKILL.md`,
  };
}

// Run the guard against a temp store by overriding its glob.
function guard() {
  const src = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('cr', ${JSON.stringify(GUARD)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.SESSIONS_GLOB = ${JSON.stringify(join(storeDir, '*', '*', 'scheduled-tasks.json'))}
code, res = m.check()
print(json.dumps({"code": code, "res": res}))
`;
  return JSON.parse(execFileSync('python3', ['-c', src], { encoding: 'utf8' }).trim());
}

beforeEach(() => { storeDir = mkdtempSync(join(ROOT, 'store-')); });

describe('one routine only', () => {
  it('passes with daily-ops alone enabled', () => {
    writeStore([task('daily-ops', true), task('drift-monitor', false),
                task('prod-e2e-sweep', false)]);
    const { code, res } = guard();
    expect(code).toBe(0);
    expect(res.ok).toBe(true);
    expect(res.extras).toEqual([]);
  });

  it('fails when a second routine is enabled, and names it', () => {
    writeStore([task('daily-ops', true), task('drift-monitor', true)]);
    const { code, res } = guard();
    expect(code).toBe(1);
    expect(res.extras).toEqual(['drift-monitor']);
    expect(res.reason).toMatch(/drift-monitor/);
  });

  it('names every extra, not just the first', () => {
    writeStore([task('daily-ops', true), task('drift-monitor', true),
                task('prod-e2e-sweep', true), task('ceo-huddle', true)]);
    const { code, res } = guard();
    expect(code).toBe(1);
    expect(res.extras).toEqual(['ceo-huddle', 'drift-monitor', 'prod-e2e-sweep']);
  });

  it('tells you what to do about it, not just that it is wrong', () => {
    writeStore([task('daily-ops', true), task('some-new-weekly-thing', true)]);
    const { res } = guard();
    // A new routine is usually someone solving a real problem the obvious way.
    // The message has to point at the right way, or it just gets re-enabled.
    expect(res.reason).toMatch(/phase/i);
    expect(res.reason).toMatch(/6b|weekly|monthly/i);
  });

  it('fails when daily-ops itself is switched off', () => {
    // Everything disabled is not "clean", it is nothing running at all.
    writeStore([task('daily-ops', false), task('drift-monitor', false)]);
    const { code, res } = guard();
    expect(code).toBe(1);
    expect(res.reason).toMatch(/NOT enabled/);
  });
});

// ---------------------------------------------------------------------------
// The control. These two states are how a guard silently stops guarding.
// ---------------------------------------------------------------------------
describe('cannot-verify is a failure, never a pass', () => {
  it('fails when no store can be found', () => {
    // storeDir exists but holds no scheduled-tasks.json.
    const { code, res } = guard();
    expect(code).toBe(2);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no scheduled-tasks.json/);
  });

  it('fails when the store is empty rather than reporting all clear', () => {
    writeStore([]);
    const { code, res } = guard();
    expect(code).toBe(2);
    expect(res.reason).toMatch(/zero tasks/);
  });

  it('ignores empty sibling stores and reads the populated one', () => {
    // Several sessions each keep a file and most are empty. Picking the first
    // found would read an empty one and report a clean, meaningless pass.
    mkdirSync(join(storeDir, 'aaa-empty', 'run'), { recursive: true });
    writeFileSync(join(storeDir, 'aaa-empty', 'run', 'scheduled-tasks.json'),
      JSON.stringify({ scheduledTasks: [] }));
    writeStore([task('daily-ops', true), task('drift-monitor', true)]);
    const { code, res } = guard();
    expect(code).toBe(1);
    expect(res.tasks_total).toBe(2);
  });
});

describe('the guard is actually wired in', () => {
  it('runs as phase 1 of the routine, so a stack is caught the next morning', () => {
    const routine = readFileSync(resolve(__dirname, '../docs/daily-ops-routine.md'), 'utf8');
    expect(routine).toContain('check-routines.py');
  });
});
