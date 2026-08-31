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
