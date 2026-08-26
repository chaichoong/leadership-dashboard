import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISHER = resolve(ROOT, 'scripts/agent_daily_log.py');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// The AI Agent Daily Log publisher (26 Aug 2026): before it existed, four
// Built/Live agents had never written a log row, so the AI Agents page's
// "Daily logs" check could only report a permanent wiring gap. These tests
// guard the publisher itself AND the wiring — a publisher nobody calls
// prevents nothing.

describe('agent_daily_log.py', () => {
  it('passes its own selftest', () => {
    const out = JSON.parse(execFileSync('python3', [PUBLISHER, 'selftest'], { encoding: 'utf8' }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(7);
  });

  it('field ids match the AI Agents page ALOG block (drift guard)', () => {
    // The page's Daily logs check reads the same table by these ids; a drift
    // means the publisher writes rows the page cannot see, which recreates
    // the exact invisibility this module exists to end.
    const page = read('os/agents/index.html');
    const block = page.match(/const ALOG = \{([\s\S]*?)\};/);
    expect(block, 'ALOG block in os/agents/index.html (control)').not.toBeNull();
    const py = read('scripts/agent_daily_log.py');
    const pyBlock = py.match(/ALOG = \{([\s\S]*?)\}/);
    expect(pyBlock, 'ALOG block in agent_daily_log.py (control)').not.toBeNull();
    for (const key of ['logDay', 'date', 'agent', 'summary', 'decisions']) {
      const pageId = block[1].match(new RegExp(`${key}:\\s*'(fld[A-Za-z0-9]+)'`));
      const pyId = pyBlock[1].match(new RegExp(`"${key}":\\s*"(fld[A-Za-z0-9]+)"`));
      expect(pageId, `${key} on the page`).not.toBeNull();
      expect(pyId, `${key} in the publisher`).not.toBeNull();
      expect(pyId[1]).toBe(pageId[1]);
    }
  });
});

describe('the four silent runtimes are actually wired', () => {
  it('agent-dispatch publishes a daily log inside write_register_reading, before the change gate', () => {
    // The log must record "ran today" even when the score reading has not
    // moved — so the publish sits above the unchanged-early-return.
    const dispatch = read('scripts/agent-dispatch.py');
    const fn = dispatch.match(/def write_register_reading\([\s\S]*?\n\n\ndef /);
    expect(fn, 'write_register_reading in agent-dispatch.py (control)').not.toBeNull();
    const body = fn[0];
    const publishAt = body.indexOf('agent_daily_log.publish');
    const gateAt = body.indexOf('load_score_state(state_path).get("reading"');
    expect(publishAt, 'publish call present').toBeGreaterThan(-1);
    expect(gateAt, 'change gate present (control)').toBeGreaterThan(-1);
    expect(publishAt).toBeLessThan(gateAt);
    // Both scored role agents get a display name for the Log Day key.
    expect(dispatch).toMatch(/"response": "Inbound Comms Response"/);
    expect(dispatch).toMatch(/"creditor": "Creditor Management"/);
  });

  const SKILL_PINS = [
    ['.claude/scheduled-tasks/prospect-daily-run/SKILL.md', 'recbQr4hq0hkVVVNE', 'Prospecting'],
    ['.claude/scheduled-tasks/daily-transaction-reconciler/SKILL.md', 'recyrN5YCQFssAniE', 'Reconciliation'],
  ];
  for (const [rel, row, name] of SKILL_PINS) {
    it(`${rel} publishes for ${name} with its register row`, () => {
      const text = read(rel);
      expect(text).toContain('scripts/agent_daily_log.py publish');
      expect(text).toContain(row);
      expect(text).toContain(`--name "${name}"`);
    });
  }
});
