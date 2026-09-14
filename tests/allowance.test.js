import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = resolve(ROOT, 'scripts/allowance.py');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// From 13:00 Fri 11 Sep 2026 to 19:00 Sun 13 Sep the Claude allowance was out.
// Every headless run started, printed "You've hit your limit · resets Sep 13 at
// 7pm (Europe/London)" and died; nine triage slots, nine board passes and 106
// hand-back polls were lost, and nothing re-ran them at the reset. The guard
// pauses the estate until the reset the message names, records the slots it
// skipped, and re-starts each once when the allowance is back.
describe('allowance.py', () => {
  it('passes its own selftest (three message shapes, latest reset wins, skip while paused, replay once in order, never itself)', () => {
    const out = JSON.parse(execFileSync('python3', [GUARD, 'selftest'], { encoding: 'utf8' }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(16);
  });

  it('every Claude runner checks before the call and marks after it', () => {
    // the two slots the weekend outage lost most of have their OWN runners (review, 14 Sep 2026)
    for (const f of ['scripts/agent-slot-run.sh', 'scripts/handback-poll-run.sh', 'scripts/task-manager-run.sh', 'scripts/inbound-triage-run.sh']) {
      const src = read(f);
      const check = src.indexOf('allowance.py" check --job');
      const claude = src.indexOf('"$CLAUDE" -p');
      const mark = src.indexOf('allowance.py" mark --job');
      expect(check, `${f} checks the allowance`).toBeGreaterThan(-1);
      expect(check, `${f} checks BEFORE the Claude call`).toBeLessThan(claude);
      expect(mark, `${f} marks AFTER the Claude call`).toBeGreaterThan(claude);
    }
    // a paused slot is not a broken job: exit 0, and the runner's own done line is written
    expect(read('scripts/agent-slot-run.sh')).toMatch(/PAUSED: the Claude allowance is out; queued to re-run at reset/);
    expect(read('scripts/handback-poll-run.sh')).toMatch(/beat skip "the Claude allowance is out; paused"/);
  });

  it('the Estate status board carries the allowance as its own row and runs the replay', () => {
    const src = read('scripts/estate-status.py');
    expect(src).toMatch(/def allowance_row\(now\)/);
    expect(src).toMatch(/al\.cmd_replay\(now=now\)/);
    expect(src).toMatch(/rows\.append\(allowance_row\(now\)\)/);
    const page = read('os/agents/index.html');
    expect(page).toMatch(/gf\(r,'key'\) === 'allowance'/);
    expect(page).toMatch(/Agents paused\./);
  });
});
