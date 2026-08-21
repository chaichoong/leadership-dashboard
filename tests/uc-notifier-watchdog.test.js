// Guards scripts/uc-notifier-watchdog.py against the failure it caused.
//
// THE BUG (found 14 Aug 2026, bit on 15 Aug — finding 20260814-daily-ops-141)
// The watchdog was written on 3 Aug, when uc-check-slack-notifier was a live
// standalone routine and "disabled" meant broken. On 8 Aug that routine was
// absorbed into daily-ops as phase 6.1 and disabled became the CORRECT state —
// but the watchdog kept "repairing" it back to enabled every morning at 09:00.
// On 15 Aug the resurrected routine actually fired (06:04Z, its own session
// transcript) alongside the daily-ops design, on the same morning the real
// daily-ops run silently produced nothing. The one-routine design exists to
// prevent exactly that overlap, and the machine's own watchdog was defeating it.
//
// The fix inverts the check: the watchdog now never writes, and reports
// ENABLED as the fault. These tests run the real functions and fail if either
// direction regresses.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const SCRIPT = resolve(ROOT, 'scripts/uc-notifier-watchdog.py');
const src = readFileSync(SCRIPT, 'utf8');

// Import the real module and exercise check_retired on a fixture task dict.
function checkRetired(task) {
  const py = `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("wd", ${JSON.stringify(SCRIPT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
task = json.loads(sys.argv[1])
before = json.dumps(task, sort_keys=True)
result = mod.check_retired(task)
after = json.dumps(task, sort_keys=True)
print(json.dumps({"result": result, "mutated": before != after}))
`;
  return JSON.parse(execFileSync('python3', ['-c', py, JSON.stringify(task)],
    { encoding: 'utf8' }));
}

describe('uc-notifier-watchdog', () => {
  it('treats a DISABLED retired routine as healthy, not as something to repair', () => {
    const { result, mutated } = checkRetired({ id: 'uc-check-slack-notifier', enabled: false });
    expect(result).toBeNull();
    expect(mutated).toBe(false);
  });

  it('reports an ENABLED retired routine as the fault', () => {
    const { result } = checkRetired({ id: 'uc-check-slack-notifier', enabled: true });
    expect(result).toContain('RETIRED');
    expect(result).toContain('daily-ops');
  });

  it('never mutates the task, whatever state it finds', () => {
    for (const enabled of [true, false, undefined]) {
      expect(checkRetired({ id: 'x', enabled }).mutated).toBe(false);
    }
  });

  it('has no code path that writes the scheduler file or enables anything', () => {
    // The old repair() wrote task['enabled'] = True and json.dump'd the file.
    // If either pattern reappears, the resurrection bug is back.
    expect(src).not.toMatch(/\[\s*['"]enabled['"]\s*\]\s*=\s*True/);
    expect(src).not.toMatch(/def repair\(/);
    expect(src).not.toMatch(/json\.dump\(/);
    expect(src).not.toMatch(/os\.replace\(/);
  });

  it('still runs the VERIFY half — the part with real value', () => {
    // check_outstanding is what catches UC work that should have gone and did
    // not, however the sender broke. Removing it would turn the watchdog into
    // a no-op that exits 0 for ever.
    expect(src).toMatch(/def check_outstanding\(/);
    expect(src).toMatch(/control_total/);
    expect(src).toMatch(/due_count/);
  });
});
