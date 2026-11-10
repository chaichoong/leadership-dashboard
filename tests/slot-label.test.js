// Which slot ran? The clock decides, not the agent (finding 20260829-daily-ops-396).
//
// WHY
// The two three-a-day runners told the agent "you are one of the 09:00 /
// 13:00 / 17:00 slots" and left it to work out which. Nothing in its context
// carries the launchd trigger time, so it guessed — and it guessed "13:00
// slot" on every run. All three rounds filed under the same heading, so a
// slot that never ran was indistinguishable in the log from one that did.
import { describe, it, expect } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/slot-label.py');
const TRIAGE = resolve(__dirname, '../scripts/inbound-triage-run.sh');
const TASKMGR = resolve(__dirname, '../scripts/task-manager-run.sh');

function at(hhmm) {
  return execFileSync('python3', [SCRIPT, '--at', hhmm], { encoding: 'utf8' }).trim();
}

describe('slot-label', () => {
  it('names each slot on the hour', () => {
    expect(at('09:00')).toBe('09:00');
    expect(at('13:00')).toBe('13:00');
    expect(at('17:00')).toBe('17:00');
  });

  it('a run started EARLY still belongs to its own slot', () => {
    // launchd routinely fires a minute or two before the stated time.
    expect(at('08:57')).toBe('09:00');
    expect(at('12:58')).toBe('13:00');
    expect(at('16:55')).toBe('17:00');
  });

  it('a run delayed by the queue still belongs to its own slot', () => {
    expect(at('09:40')).toBe('09:00');
    expect(at('13:55')).toBe('13:00');
    expect(at('17:50')).toBe('17:00');
  });

  it('09:00 and 17:00 are reachable at all — the bug was that they never were', () => {
    const seen = new Set(['08:57', '09:20', '13:10', '16:58', '17:30'].map(at));
    expect(seen.has('09:00'), 'the 09:00 slot can never be labelled').toBe(true);
    expect(seen.has('17:00'), 'the 17:00 slot can never be labelled').toBe(true);
  });

  it('a tie goes to the earlier slot, so the answer is never arbitrary', () => {
    expect(at('11:00')).toBe('09:00');   // 120 min from each
    expect(at('15:00')).toBe('13:00');
  });

  it('an out-of-hours catch-up run still gets a real label, never blank', () => {
    for (const t of ['02:00', '05:30', '23:59']) {
      expect(at(t), `no label at ${t}`).toMatch(/^(09|13|17):00$/);
    }
  });

  // ─── THE TRIGGER'S CLOCK, NOT THE LOCK'S (finding 20261029-phase-2-1120) ──
  //
  // A nearest-hour rule only survives a short wait. On 28 Oct 2026 the 13:20
  // task-manager slot waited 6,910s behind inbound-triage, acquired the lock at
  // 15:15:11, read the wall clock and called itself the 17:00 slot: it wrote
  // report-2026-10-28-17.md, the real 17:20 run found that name taken, and
  // runs.log read "09:00, 17:00, 17:00" with no midday round for a day on which
  // all three ran. job-queue.py now hands the trigger time down.
  describe('a long queue wait cannot rename the slot', () => {
    const withQueued = (iso) =>
      execFileSync('python3', [SCRIPT], {
        encoding: 'utf8',
        env: { ...process.env, JOB_QUEUE_QUEUED_AT: iso, TZ: 'Europe/London' },
      }).trim();

    it('the 28 Oct 13:20 slot that acquired at 15:15 is still the 13:00 slot', () => {
      // GMT in late October, so 13:20Z is 13:20 London.
      expect(withQueued('2026-10-28T13:20:00Z')).toBe('13:00');
    });

    it('a 09:20 trigger held until the afternoon is still the 09:00 slot', () => {
      expect(withQueued('2026-10-28T09:20:05Z')).toBe('09:00');
    });

    it('the stamp is read in London time, not as UTC through BST', () => {
      // 1 Jul is BST (+1): 12:20Z is 13:20 London, which is the 13:00 slot.
      // Reading it as UTC would answer 13:00 too, so use a case that differs:
      // 08:20Z in BST is 09:20 London (09:00 slot); as UTC it is 08:20, which
      // the nearest-hour rule also calls 09:00 — so test the real boundary.
      // 11:10Z in BST is 12:10 London -> 13:00; as UTC 11:10 -> 09:00.
      expect(withQueued('2026-07-01T11:10:00Z')).toBe('13:00');
    });

    it('an unreadable stamp falls back to the wall clock, never to blank', () => {
      for (const bad of ['nonsense', '2026-10-28 13:20', '']) {
        expect(withQueued(bad), `no label for ${JSON.stringify(bad)}`)
          .toMatch(/^(09|13|17):00$/);
      }
    });

    it('job-queue.py hands the trigger time down BEFORE it starts waiting', () => {
      // The whole mechanism: a stamp taken after acquire() would carry the
      // lock time and reproduce the bug exactly.
      const src = readFileSync(resolve(__dirname, '../scripts/job-queue.py'), 'utf8');
      const stamp = src.indexOf('JOB_QUEUE_QUEUED_AT');
      const acquire = src.indexOf('code = acquire(job, mode="wrapped"');
      expect(stamp, 'job-queue.py never exports the trigger time').toBeGreaterThan(-1);
      expect(stamp, 'the trigger time is stamped after the queue wait')
        .toBeLessThan(acquire);
    });
  });

  it('rejects a malformed --at rather than silently defaulting', () => {
    // THE CONTROL. A helper that answers "09:00" to anything is the bug again.
    let code = 0;
    try {
      execFileSync('python3', [SCRIPT, '--at', 'lunchtime'],
        { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) { code = e.status; }
    expect(code, 'garbage input produced a confident slot label').toBe(2);
  });
});

describe('the runners use it instead of asking the agent', () => {
  for (const [name, path] of [['inbound-triage', TRIAGE], ['task-manager', TASKMGR]]) {
    it(`${name} reads the clock and hands the label to the agent`, () => {
      const src = readFileSync(path, 'utf8');
      expect(src, 'the runner does not compute a slot label')
        .toMatch(/SLOT_LABEL="\$\(.*slot-label\.py/);
      expect(src, 'the prompt does not carry the label the wrapper read')
        .toMatch(/THIS RUN IS THE \$SLOT_LABEL SLOT/);
      expect(src, 'the agent is still being asked to pick a slot itself')
        .not.toMatch(/scheduled run \(one of the 09:00 \/ 13:00 \/ 17:00 slots\)/);
    });

    it(`${name} is still valid shell`, () => {
      expect(() => execSync(`bash -n ${JSON.stringify(path)}`)).not.toThrow();
    });
  }
});

describe('inbound-triage.py names its own slot from the trigger time', () => {
  // Finding 20261107-queue-fixer-1239: the runner shell was fixed to hand the
  // label down, but inbound-triage.py's own _slot_now() still called
  // mod.label(datetime.now()), so a slot that waited behind the lock labelled
  // its inbox card with the round it was RUNNING in, not the one it was
  // triggered for. Back-tested by putting datetime.now() back: this fails.
  const slotNow = (queuedAt) => execFileSync('python3', ['-c', [
    'import importlib.util',
    "spec = importlib.util.spec_from_file_location('od_triage', 'scripts/inbound-triage.py')",
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'print(mod._slot_now())',
  ].join('\n')], {
    encoding: 'utf8',
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, JOB_QUEUE_QUEUED_AT: queuedAt },
  }).trim();

  it('reads the queued stamp, not the wall clock', () => {
    // Each stamp is far from the others, so whatever hour the suite runs in,
    // at least two of these three disagree with the wall clock.
    const today = new Date().toISOString().slice(0, 10);
    expect(slotNow(`${today}T09:02:00Z`)).toBe('09:00');
    expect(slotNow(`${today}T13:02:00Z`)).toBe('13:00');
    expect(slotNow(`${today}T16:55:00Z`)).toBe('17:00');
  });

  it('falls back to the wall clock when the queue handed nothing down', () => {
    // THE CONTROL. A helper that answers from the env alone would throw or
    // return nothing here, and a slot started outside the queue must still
    // get a label.
    expect(slotNow('')).toMatch(/^(09|13|17):00$/);
  });

  it('never calls label() on the bare wall clock', () => {
    const src = readFileSync(resolve(__dirname, '../scripts/inbound-triage.py'), 'utf8');
    expect(src, '_slot_now() labels the wall clock again')
      .not.toMatch(/mod\.label\(datetime\.now\(\)\)/);
  });
});
