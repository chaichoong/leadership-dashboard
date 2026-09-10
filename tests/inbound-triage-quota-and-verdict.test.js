// TWO WAYS THE INBOUND LANE WENT QUIETLY DEAD FOR TWO DAYS (8-10 Sep 2026).
//
// Findings 20260910-daily-ops-513 and 20260910-daily-ops-514. Both were found
// in the same runs.log, both looked like a healthy day from every surface Kevin
// reads, and neither raised anything anywhere.
//
//   513 — THE REBUILD THAT COULD NEVER SUCCEED AND NEVER STOPPED TRYING.
//         The history book is a WEEKLY artefact. Its rebuild is the most
//         expensive Gmail read in the file (up to 20 pages per lane, ten
//         lanes). When it dies on the per-minute quota it writes nothing, so
//         `history_built_ms` never moves, so the next slot sees "stale" and
//         spends the whole 600s slowdown budget failing it again. 9 Sep 2026:
//         all three slots logged {"stale": true, "built_ms": 1788263430621}
//         (built 1 Sep) followed by "GMAIL RATE METRIC STILL FULL after 585s".
//         Ten minutes of the SERIAL queue lock, three times a day, to achieve
//         nothing — and behind it task-manager and prospecting exited 75.
//
//   514 — THE FORECAST THAT BECAME THE RECORD. The email lane verdict is
//         written optimistically before the agent starts and superseded
//         afterwards by slot-verify. On 9 Sep the 13:00 slot recorded ok:true,
//         hit the quota, and was TERMinated at 14:46 ("ABNORMAL: wrapper
//         terminated before postrun"). slot-verify never ran. slot-results.jsonl
//         therefore says the email lane worked at 09:00, 13:00 AND 17:00 on
//         9 Sep, consecutive_broken stayed at 0, and the two-slots-broken
//         escalation could not fire.
//
// The trap half is tested by EXECUTING the runner's own trap block, extracted
// from the real file rather than copied, so the test cannot drift from it.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TRIAGE = resolve(__dirname, '../scripts/inbound-triage.py');
const RUNNER = resolve(__dirname, '../scripts/inbound-triage-run.sh');
const ROOT = mkdtempSync(join(tmpdir(), 'triage-quota-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const runnerSrc = readFileSync(RUNNER, 'utf8');

function py(args, env = {}) {
  try {
    return { code: 0, out: execFileSync('python3', [TRIAGE, ...args], {
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

// ─── 513 ────────────────────────────────────────────────────────────────

describe('a history rebuild that failed on quota does not retry next slot', () => {
  const SEP1 = 1788263430621;   // the built_ms every 9 Sep slot actually logged

  it('a stale book with no prior failure asks to be rebuilt (exit 0)', () => {
    const d = box('stale-clean');
    writeFileSync(join(d, 'state.json'), JSON.stringify({ history_built_ms: SEP1 }));
    const r = py(['history-stale'], { INBOUND_TRIAGE_DIR: d });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).stale).toBe(true);
  });

  it('9 Sep back-test: after a failed rebuild the next slot refuses (exit 1)', () => {
    const d = box('stale-cooling');
    writeFileSync(join(d, 'state.json'), JSON.stringify({
      history_built_ms: SEP1,
      history_build_failed_ms: Date.now() - 60_000,   // the 09:00 slot's death
    }));
    const r = py(['history-stale'], { INBOUND_TRIAGE_DIR: d });
    // Exit 1 is what the runner's `if history-stale; then history-build; fi`
    // reads as "do not rebuild". Before the fix this was exit 0 three times a
    // day, every day, for as long as the quota stayed tight.
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out);
    expect(j.cooldown).toBe(true);
    // Still STALE. A cooldown must never be reported as a fresh book.
    expect(j.stale).toBe(true);
    expect(j.retry_in_seconds).toBeGreaterThan(0);
    expect(j.reason).toMatch(/quota/i);
  });

  it('the cooldown expires, so a tight hour never costs a whole week', () => {
    const d = box('stale-expired');
    writeFileSync(join(d, 'state.json'), JSON.stringify({
      history_built_ms: SEP1,
      history_build_failed_ms: Date.now() - 36 * 3600 * 1000,
    }));
    expect(py(['history-stale'], { INBOUND_TRIAGE_DIR: d }).code).toBe(0);
  });

  it('a fresh book never asks for a rebuild, cooldown or not', () => {
    const d = box('fresh');
    writeFileSync(join(d, 'state.json'), JSON.stringify({
      history_built_ms: Date.now(), history_build_failed_ms: Date.now() - 1000,
    }));
    const r = py(['history-stale'], { INBOUND_TRIAGE_DIR: d });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).cooldown).toBeUndefined();
  });

  it('the failure is recorded by the build itself, not by the caller', () => {
    // The whole mechanism rests on cmd_history_build remembering its own
    // death; a wrapper that only the shell sets would be lost on a SIGKILL.
    const src = readFileSync(TRIAGE, 'utf8');
    expect(src).toMatch(/def cmd_history_build\(pages\):[\s\S]*?except BaseException:[\s\S]*?history_build_failed_ms/);
    // And a success must clear it.
    expect(src).toMatch(/state\.pop\("history_build_failed_ms", None\)/);
  });

  it("the python selftest (which replays 9 Sep) passes", () => {
    expect(py(['selftest']).out).toMatch(/selftest OK/);
  });
});

// ─── 514 ────────────────────────────────────────────────────────────────

// Pull the runner's trap block out of the real file so this exercises the
// shipped code path, not a copy of it that can rot.
function trapBlock() {
  const start = runnerSrc.indexOf('__POSTRUN_DONE=0');
  const endMark = "trap 'exit 130' INT";
  const end = runnerSrc.indexOf(endMark);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return runnerSrc.slice(start, end + endMark.length);
}

// A stand-in for scripts/inbound-triage.py that records every slot-verify.
function fakeRepo(dir, exitCode = 0) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'inbound-triage.py'),
    'import sys, pathlib\n' +
    `pathlib.Path(${JSON.stringify(join(dir, 'calls.log'))}).open('a').write(' '.join(sys.argv[1:]) + '\\n')\n` +
    `sys.exit(${exitCode})\n`);
}

function runHarness(name, tail, exitCode = 0) {
  const d = box(name);
  fakeRepo(d, exitCode);
  const script = join(d, 'harness.sh');
  writeFileSync(script, [
    'set -u',
    `REPO=${JSON.stringify(d)}`,
    `LOG=${JSON.stringify(join(d, 'runs.log'))}`,
    'SLOT_LABEL="13:00"',
    trapBlock(),
    '__SLOT_START_MS=1788959885000',
    tail,
  ].join('\n'));
  let code = 0;
  try {
    execFileSync('bash', [script], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; }
  const calls = existsSync(join(d, 'calls.log'))
    ? readFileSync(join(d, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean) : [];
  const log = existsSync(join(d, 'runs.log')) ? readFileSync(join(d, 'runs.log'), 'utf8') : '';
  return { code, calls, log };
}

describe('the email-lane verdict is corrected even when the wrapper is killed', () => {
  it('9 Sep 13:00 back-test: a TERM before postrun still runs slot-verify', () => {
    // Exactly the shape of the run that died at 14:46 on 9 Sep 2026.
    const r = runHarness('term', 'kill -TERM $$\nsleep 5\n');
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]).toMatch(/^slot-verify --slot 13:00 --lane email --since-ms 1788959885000 --agent-rc \d+$/);
    expect(r.log).toMatch(/ABNORMAL: wrapper terminated before postrun/);
  });

  it('a normal run verifies exactly once, never twice', () => {
    const r = runHarness('normal', 'RC=0\n__verify_slot "$RC"\n__POSTRUN_DONE=1\nexit 0\n');
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]).toMatch(/--agent-rc 0$/);
    expect(r.log).not.toMatch(/ABNORMAL/);
  });

  // Finding 20260908-daily-ops-494 — the other half of the same lie.
  it("the agent's exit code reaches slot-verify, not just the scan stamp", () => {
    const r = runHarness('rc', 'RC=1\n__verify_slot "$RC"\n__POSTRUN_DONE=1\nexit 0\n');
    expect(r.calls[0]).toMatch(/--agent-rc 1$/);
  });

  it('a killed wrapper reports a non-zero rc, never a silent 0', () => {
    const r = runHarness('term-rc', 'kill -TERM $$\nsleep 5\n');
    expect(r.calls[0]).toMatch(/--agent-rc (?!0$)\d+$/);
  });

  it('the two-slots-broken escalation still reaches stderr from the trap', () => {
    const r = runHarness('escalate', 'kill -TERM $$\nsleep 5\n', 3);
    expect(r.calls.length).toBe(1);
    expect(r.log).toMatch(/ESCALATE: inbound-triage email lane BROKEN for 2\+ consecutive slots/);
  });

  it('a death before the slot was even recorded verifies nothing', () => {
    // __SLOT_START_MS unset: there is no optimistic row to supersede, and
    // slot-verify without a since-ms would be worse than silence.
    const d = box('early-death');
    fakeRepo(d);
    const script = join(d, 'harness.sh');
    writeFileSync(script, [
      'set -u', `REPO=${JSON.stringify(d)}`,
      `LOG=${JSON.stringify(join(d, 'runs.log'))}`, 'SLOT_LABEL="13:00"',
      trapBlock(), 'kill -TERM $$', 'sleep 5',
    ].join('\n'));
    try { execFileSync('bash', [script], { stdio: 'pipe' }); } catch { /* expected */ }
    expect(existsSync(join(d, 'calls.log'))).toBe(false);
  });

  it('slot-verify is invoked from exactly one place in the runner', () => {
    // Two call sites is how the inline one and the trap one drift apart.
    const sites = runnerSrc.match(/inbound-triage\.py" slot-verify/g) || [];
    expect(sites.length).toBe(1);
    expect(runnerSrc).toMatch(/__on_exit\(\) \{[\s\S]*?__verify_slot/);
  });
});
