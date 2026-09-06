// A SLOT THAT FIRED IS NOT A SLOT THAT WORKED.
//
// Finding 20260906-daily-ops-477. On 5 Sep 2026 the inbound-triage 13:00 and
// 17:00 slots both fired, both scanned ZERO emails because the shared daily
// Gmail quota was gone (HTTP 403), and both left a normal `acquired` event in
// the queue log. check-routines.py graded the day "inbound-triage 3 of 3" off
// those events, and no email had been triaged since 3 Sep. Nothing anywhere
// said the email lane was dead — the only record was the word BROKEN inside a
// paragraph of the agent's prose report, which nothing parses.
//
// Two halves are tested here:
//   1. inbound-triage.py writes a machine-readable verdict per lane per slot,
//      and escalates (exit 3) once a lane has been broken two slots running.
//   2. check-routines.py grades on THAT, and a missing results file reads as
//      UNCHECKED rather than as clean.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TRIAGE = resolve(__dirname, '../scripts/inbound-triage.py');
const GUARD = resolve(__dirname, '../scripts/check-routines.py');
const ROOT = mkdtempSync(join(tmpdir(), 'lane-result-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function run(script, args, env = {}) {
  try {
    return { code: 0, out: execFileSync('python3', [script, ...args], {
      encoding: 'utf8', env: { ...process.env, ...env },
    }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function box(name) {
  const d = join(ROOT, name);
  mkdirSync(d, { recursive: true });
  return d;
}

function record(dir, slot, status, reason = '') {
  return run(TRIAGE, ['slot-record', '--slot', slot, '--lane', 'email',
    '--status', status, '--reason', reason], { INBOUND_TRIAGE_DIR: dir });
}

describe('inbound-triage per-slot lane result', () => {
  it('BACK-TEST 5 Sep 2026: the two quota slots both grade as failed', () => {
    const d = box('sep5');
    expect(record(d, '09:00', 'ok').code).toBe(0);
    // 13:00 and 17:00 — both fired, both scanned nothing.
    expect(record(d, '13:00', 'broken', 'quota').code).toBe(0);
    expect(record(d, '17:00', 'broken', 'quota').code).toBe(3); // ESCALATE

    const rows = readFileSync(join(d, 'slot-results.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.ok === false)).toHaveLength(2);
    // The verdict is a field, not a word inside a sentence.
    expect(rows[2]).toMatchObject({ lane: 'email', ok: false, reason: 'quota' });
  });

  it('one good slot clears the escalation run', () => {
    const d = box('recovers');
    record(d, '09:00', 'broken', 'quota');
    expect(record(d, '13:00', 'broken', 'quota').code).toBe(3);
    expect(record(d, '17:00', 'ok').code).toBe(0);
    expect(record(d, '09:00', 'broken', 'quota').code).toBe(0); // run restarted
  });

  it('the health probe is the SMALLEST worker call, never a scan', () => {
    // Probing with a scan would spend the quota the probe exists to check for.
    const src = readFileSync(TRIAGE, 'utf8');
    const health = src.slice(src.indexOf('def cmd_health'), src.indexOf('def cmd_search'));
    expect(health).toMatch(/worker_labels\(\)/);
    expect(health).not.toMatch(/worker_list\(/);
  });

  it('a quota failure carries a machine-readable kind, not just prose', () => {
    const src = readFileSync(TRIAGE, 'utf8');
    expect(src).toMatch(/kind="quota"/);
    expect(src).toMatch(/kind="auth"/);
  });
});

describe('check-routines grades the lane, not the run marker', () => {
  const routineDir = box('routines');
  mkdirSync(join(routineDir, 'daily-ops'), { recursive: true });
  writeFileSync(join(routineDir, 'daily-ops', 'SKILL.md'), '# daily-ops\n');

  function guard(laneDir) {
    const events = join(ROOT, 'events.jsonl');
    const now = new Date();
    const rows = [];
    for (const h of [1, 5, 9]) {
      const ts = new Date(now - h * 3600_000).toISOString().replace('Z', '') + 'Z';
      rows.push({ ts, job: 'inbound-triage', state: 'acquired' });
    }
    rows.push({ ts: new Date(now - 2 * 3600_000).toISOString().replace('Z', '') + 'Z',
      job: 'daily-ops', state: 'mark' });
    writeFileSync(events, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return run(GUARD, ['--json'], {
      JOB_QUEUE_EVENTS: events,
      CLAUDE_ROUTINE_DIR: routineDir,
      INBOUND_TRIAGE_DIR: laneDir,
    });
  }

  it('three fired slots with a broken email lane are NOT reported as three good slots', () => {
    const d = box('graded');
    record(d, '09:00', 'ok');
    record(d, '13:00', 'broken', 'quota');
    record(d, '17:00', 'broken', 'quota');

    const r = guard(d);
    const res = JSON.parse(r.out);
    const lane = res.lane_health['inbound-triage'].email;
    expect(lane).toMatchObject({ slots: 3, ok: 1, broken: 2 });
    expect(lane.consecutive_broken).toBeGreaterThanOrEqual(2);
    expect(res.broken_lanes.join(' ')).toMatch(/email lane: 1 of 3 slots worked/);
    expect(res.broken_lanes.join(' ')).toMatch(/ESCALATE/);
  });

  it('a clean day reports no broken lane at all', () => {
    const d = box('clean');
    record(d, '09:00', 'ok');
    record(d, '13:00', 'ok');
    record(d, '17:00', 'ok');
    const res = JSON.parse(guard(d).out);
    expect(res.broken_lanes).toEqual([]);
  });

  it('CONTROL: a missing results file is UNCHECKED, never clean', () => {
    // The failure this whole finding is about was silence reading as success.
    const res = JSON.parse(guard(box('empty')).out);
    expect(res.broken_lanes.join(' ')).toMatch(/UNCHECKED, not clean/);
  });

  it('the selftest that back-tests 5 Sep still passes in full', () => {
    const r = run(TRIAGE, ['selftest'], { INBOUND_TRIAGE_DIR: box('selftest') });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/selftest OK/);
  });
});

// FINDING 20260904-daily-ops-451, the other half of the same silence: a slot
// whose email triage was BROKEN still exited 0, so run-job.sh recorded a
// success and job-failures.log stayed empty. The wrapper now writes an
// EMAIL LANE BROKEN line into runs.log before the agent starts, and the shared
// epilogue turns any failure marker in the tail into a non-zero exit. Tested
// through slot-postrun.sh itself rather than by reading the wrapper's source,
// because the coupling that matters is the marker matching the BAD pattern the
// wrapper actually passes.
describe('a broken email lane makes the slot exit non-zero (finding 451)', () => {
  const POSTRUN = resolve(__dirname, '../scripts/slot-postrun.sh');

  // The exact pattern inbound-triage-run.sh hands slot-postrun.sh.
  const BAD_ERE = readFileSync(resolve(__dirname, '../scripts/inbound-triage-run.sh'), 'utf8')
    .split('\n').filter((l) => l.includes('OAuth access token has expired')).pop()
    .replace(/^\s*'|'\s*$/g, '');

  function postrun(tail, rc = 0) {
    const d = box('postrun-' + Math.random().toString(36).slice(2));
    execFileSync('git', ['-C', d, 'init', '-q']);
    mkdirSync(join(d, 'monitoring'), { recursive: true });
    const scratch = join(d, 'scratch');
    mkdirSync(scratch, { recursive: true });
    const log = join(d, 'runs.log');
    writeFileSync(log, '===== run start =====\n' + tail);
    const marker = join(d, '.marker');
    writeFileSync(marker, '');
    try {
      execFileSync('bash', [POSTRUN, 'inbound-triage', String(rc), log, '1',
        marker, scratch, '"body" *:', BAD_ERE],
      { encoding: 'utf8', env: { ...process.env, SLOT_POSTRUN_REPO: d } });
      return 0;
    } catch (e) {
      return e.status;
    }
  }

  it('the wrapper writes a line the shared epilogue treats as a failure', () => {
    // The literal line inbound-triage-run.sh writes when the probe says broken.
    expect(postrun('EMAIL LANE BROKEN (quota) — skill 1 skipped this slot\n'))
      .not.toBe(0);
  });

  it('CONTROL: a clean tail still exits 0, so this is not a blanket failure', () => {
    expect(postrun('Email: 14 scanned / 3 tasked / 9 archived\n')).toBe(0);
  });
});
