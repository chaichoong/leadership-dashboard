// `findings.py count` must report the BACKLOG, not the archive.
//
// WHY (29 Aug 2026, finding 20260829-queue-fixer-401)
// The bare `count` returned every finding ever filed. On 29 Aug that was 402
// against a real backlog of 213, and the routines that quoted "the findings
// count" in Kevin's report quoted the lifetime total — nearly double the work
// actually outstanding. A closed finding is history; it is not owed. A number
// that cannot be acted on still gets acted on, which is the whole problem.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FINDINGS = resolve(__dirname, '../scripts/findings.py');
const ROOT = mkdtempSync(join(tmpdir(), 'findings-count-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let file;
let n = 0;

function run(...args) {
  return execFileSync('python3', [FINDINGS, ...args], {
    env: { ...process.env, FINDINGS_FILE: file,
           FINDINGS_OVERFLOW_FILE: join(ROOT, 'overflow.jsonl') },
    encoding: 'utf8',
  }).trim();
}

// One finding per routine, because the per-routine cap would otherwise refuse
// the later ones and the arithmetic under test would be the cap's, not count's.
function add(routine) {
  const out = run('add', '--routine', routine, '--title', `t-${routine}`,
                  '--severity', 'medium');
  return out.match(/\[?([0-9]{8}-[a-z0-9-]+-[0-9]+)\]?/)[1];
}

beforeEach(() => { file = join(ROOT, `q${n++}.jsonl`); });

describe('findings.py count', () => {
  it('counts what is still owed, not what was ever filed', () => {
    const a = add('r-a'); add('r-b');
    run('close', a, '--outcome', 'fixed', '--note', 'done', '--evidence', 'test fixture');

    expect(run('count'), 'a closed finding was still being counted as backlog')
      .toBe('1');
    expect(run('count', '--status', 'all'),
      'the lifetime total is still reachable by name').toBe('2');
  });

  it('a claimed finding is still owed — it is being worked, not finished', () => {
    const a = add('r-a');
    run('claim', a, '--by', 'queue-fixer');
    expect(run('count'), 'work in progress vanished from the backlog').toBe('1');
  });

  it('a PENDING fix in an unmerged PR is still owed', () => {
    // 26 Aug 2026: four fixer PRs sat unmerged while 40 findings citing them
    // read as fixed. `pending` exists so that cannot happen again, and the
    // backlog must not lose it either.
    const a = add('r-a');
    run('claim', a, '--by', 'queue-fixer');
    run('close', a, '--outcome', 'pending', '--pr', '999', '--note', 'in a PR');
    expect(run('count'), 'an unmerged fix stopped counting as outstanding').toBe('1');
    run('land', '--pr', '999');
    expect(run('count'), 'a landed fix still counted as outstanding').toBe('0');
  });

  it('rejected and deferred leave the backlog', () => {
    const a = add('r-a'); const b = add('r-b'); add('r-c');
    run('close', a, '--outcome', 'rejected', '--note', 'not real');
    run('close', b, '--outcome', 'deferred', '--note', 'later');
    expect(run('count')).toBe('1');
    expect(run('count', '--status', 'all')).toBe('3');
  });

  // ── THE CONTROL ──────────────────────────────────────────────────
  // A count that always returns the same number is the bug, not the fix.
  it('BACKLOG and TOTAL are genuinely different numbers, and labelled', () => {
    const a = add('r-a'); add('r-b'); add('r-c');
    run('close', a, '--outcome', 'fixed', '--note', 'done', '--evidence', 'test fixture');
    const out = run('count', '--breakdown');
    expect(out).toMatch(/^BACKLOG\s+2$/m);
    expect(out).toMatch(/^TOTAL\s+3$/m);
    expect(out).toMatch(/^fixed\s+1$/m);
  });

  it('an empty queue counts zero, not an error', () => {
    expect(run('count')).toBe('0');
    expect(run('count', '--status', 'all')).toBe('0');
  });
});
