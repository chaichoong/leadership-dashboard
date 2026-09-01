// The queue must reclaim an expired lock on EXPIRY, not on the next
// contender's arrival (finding 20260809-drift-029).
//
// WHY
// break_stale_lock() was only ever called from inside acquire(). A crashed
// holder's lease could run out on a Friday night and the lock stayed held
// until something else asked for it — on a quiet weekend, two days — while
// `status` reported the queue as busy the whole time. A dead holder and a
// working one looked identical, which is the failure mode this whole file
// exists to prevent.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const QUEUE = resolve(__dirname, '../scripts/job-queue.py');
vi.setConfig({ testTimeout: 60000 });

const ROOT = mkdtempSync(join(tmpdir(), 'queuesweep-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let stateDir, schedulePath, n = 0;

beforeEach(() => {
  stateDir = join(ROOT, `s${n++}`);
  schedulePath = join(stateDir, 'schedule.json');
  execFileSync('mkdir', ['-p', stateDir]);
  writeFileSync(schedulePath, JSON.stringify({ alpha: {}, beta: {} }));
});

function q(args, env = {}) {
  const e = { ...process.env, JOB_QUEUE_DIR: stateDir,
              JOB_QUEUE_SCHEDULE: schedulePath, ...env };
  try {
    return { code: 0, out: execFileSync('python3', [QUEUE, ...args],
      { env: e, encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: (err.stdout || '') + (err.stderr || '') };
  }
}

// Age the holder's lease by rewriting it, rather than sleeping a real minute.
function expireLease() {
  const f = join(stateDir, 'lock', 'holder.json');
  const h = JSON.parse(readFileSync(f, 'utf8'));
  h.lease_until = Date.now() / 1000 - 120;
  writeFileSync(f, JSON.stringify(h));
}

describe('job-queue sweep', () => {
  it('an empty queue is quiet and exits 0', () => {
    const r = q(['sweep']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no lock held/i);
  });

  it('LEAVES a live holder alone — a working job is not debris', () => {
    expect(q(['acquire', 'alpha', '--lease', '90']).code).toBe(0);
    const r = q(['sweep']);
    expect(r.code, 'swept a job that was still working').toBe(0);
    expect(r.out).toMatch(/alpha still holds the queue/);
    expect(existsSync(join(stateDir, 'lock')), 'the live lock was destroyed').toBe(true);
  });

  it('reclaims an expired lease with no contender present', () => {
    // THE REGRESSION. Before the fix nothing broke this lock until another
    // job called acquire.
    expect(q(['acquire', 'alpha', '--lease', '90']).code).toBe(0);
    expireLease();
    const r = q(['sweep']);
    expect(r.code, 'a stale lock was reported as fine').toBe(1);
    expect(r.out).toMatch(/RECLAIMED the queue from alpha/);
    expect(r.out).toMatch(/lease expired/);
    expect(existsSync(join(stateDir, 'lock')), 'the stale lock survived the sweep').toBe(false);
  });

  it('a swept queue is immediately usable by the next job', () => {
    q(['acquire', 'alpha', '--lease', '90']);
    expireLease();
    q(['sweep']);
    expect(q(['acquire', 'beta', '--lease', '90', '--timeout', '0.05']).code,
      'the next job still could not get in after a sweep').toBe(0);
  });

  it('records the reclaim in the event log, so it is not a silent recovery', () => {
    q(['acquire', 'alpha', '--lease', '90']);
    expireLease();
    q(['sweep']);
    const events = readFileSync(join(stateDir, 'queue-events.jsonl'), 'utf8');
    expect(events, 'a broken lock left no trace').toMatch(/lock-broken/);
    expect(events).toMatch(/lease expired/);
  });

  it('sweeping twice is safe — the second call finds nothing', () => {
    q(['acquire', 'alpha', '--lease', '90']);
    expireLease();
    expect(q(['sweep']).code).toBe(1);
    const r = q(['sweep']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no lock held/i);
  });
});
