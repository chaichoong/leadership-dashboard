import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// ── THE WEEKLY TRUST REVIEW (17 Sep 2026) ─────────────────────────────────
//
// scripts/agent-accuracy-report.py --weekly turns the approval log into one
// verdict per agent and task type (UP / HOLD / DOWN), says which part failed,
// and makes at most one Monday card when a verdict moves. The arithmetic is
// proved by the script's own selftest, which runs on fixed decisions and never
// touches Airtable.
//
// The same day, 63 rejections decided with no reason were labelled
// "No reason recorded" rather than left blank. Both the huddle's script and the
// browser must still count that label as UNEXPLAINED, or 63 unknowns vanish
// from the one number that says how much of a score nobody can explain.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const SCRIPT = resolve(ROOT, 'scripts/agent-accuracy-report.py');
const PY = readFileSync(SCRIPT, 'utf8');
const { computeAgentAccuracy, NO_REASON_LABEL } = require(resolve(ROOT, 'js/agent-accuracy.js'));
const SKILL = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/ceo-huddle/SKILL.md'), 'utf8');

describe('weekly trust review', () => {
  it('passes the script selftest (verdicts, crossings, parts, minutes, card, London Monday)', () => {
    const out = JSON.parse(execFileSync('python3', [SCRIPT, 'selftest'], { encoding: 'utf8' }));
    expect(out.failed).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.checks).toBeGreaterThanOrEqual(26);
  });

  it('the no-reason label is identical in the script and the browser', () => {
    const m = PY.match(/^NO_REASON_LABEL = "([^"]+)"/m);
    expect(m, 'agent-accuracy-report.py has no NO_REASON_LABEL').toBeTruthy();
    expect(NO_REASON_LABEL).toBe(m[1]);
    expect(NO_REASON_LABEL).toBe('No reason recorded');
  });

  it('the browser counts the label as an unexplained rejection, as it does a blank', () => {
    const at = (d) => new Date(Date.UTC(2026, 8, d)).toISOString();
    const rows = computeAgentAccuracy([
      { agentId: 'recA', taskType: 'Correspondence', outcome: 'Rejected', at: at(1), reason: NO_REASON_LABEL },
      { agentId: 'recA', taskType: 'Correspondence', outcome: 'Rejected', at: at(2), reason: '' },
      { agentId: 'recA', taskType: 'Correspondence', outcome: 'Approved as-is', at: at(3), reason: '' },
    ], { recA: 'Agent A' });
    expect(rows[0].unclassifiedRejections).toBe(2);
  });

  it('the huddle runs the weekly mode and is told never to make the card itself', () => {
    expect(SKILL).toContain('agent-accuracy-report.py --weekly --card');
    expect(SKILL).toMatch(/Never create a trust card yourself/);
  });
});
