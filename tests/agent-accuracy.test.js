import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// The real source the browser loads, not a copy — a threshold changed in the
// app and not here would otherwise pass silently.
const { computeAgentAccuracy, agentAutonomyRecommendations, THRESHOLD } = require(resolve(ROOT, 'js/agent-accuracy.js'));

// Seeded decisions. `at` counts DOWN so index 0 is the newest, which is what
// the "last 10" window depends on.
function seed(agentId, taskType, outcomes) {
  return outcomes.map((outcome, i) => ({
    agentId,
    taskType,
    outcome,
    at: new Date(Date.UTC(2026, 6, 31, 12, 0, 0) - i * 3600e3).toISOString(),
  }));
}
const APPROVE = 'Approved as-is';
const MINOR = 'Approved with minor edits';
const CHANGES = 'Changes requested';
const REJECT = 'Rejected';
const NAMES = { recWriter: 'AI Worker — Writer', recAnalyst: 'AI Worker — Analyst' };

describe('agent accuracy — the threshold that recommends autonomy', () => {
  it('scores per agent PER TASK TYPE, never blended', () => {
    // Same agent: strong at drafting, weak at analysis. A blended score would
    // read ~60% and hide both facts — which is the whole reason for the split.
    const history = [
      ...seed('recWriter', 'Drafting', Array(10).fill(APPROVE)),
      ...seed('recWriter', 'Analysis', Array(10).fill(REJECT)),
    ];
    const rows = computeAgentAccuracy(history, NAMES);
    expect(rows).toHaveLength(2);
    const drafting = rows.find(r => r.taskType === 'Drafting');
    const analysis = rows.find(r => r.taskType === 'Analysis');
    expect(drafting.rate).toBe(1);
    expect(analysis.rate).toBe(0);
    expect(drafting.agentName).toBe('AI Worker — Writer');
  });

  it('counts approved-with-minor-edits as accurate, changes-requested as not', () => {
    const rows = computeAgentAccuracy(seed('recWriter', 'Drafting', [APPROVE, MINOR, CHANGES, REJECT]), NAMES);
    expect(rows[0].accurate).toBe(2);
    expect(rows[0].total).toBe(4);
    expect(rows[0].rate).toBe(0.5);
    expect(rows[0].rejected).toBe(1);
  });

  it('needs BOTH the sample AND the rate — 100% over 19 is not enough', () => {
    const rows = computeAgentAccuracy(seed('recWriter', 'Drafting', Array(19).fill(APPROVE)), NAMES);
    expect(rows[0].total).toBe(19);
    expect(rows[0].rate).toBe(1);
    expect(rows[0].ready, '19 decisions is below the sample floor').toBe(false);

    const at20 = computeAgentAccuracy(seed('recWriter', 'Drafting', Array(20).fill(APPROVE)), NAMES);
    expect(at20[0].ready, '20 clean decisions clears the bar').toBe(true);
  });

  it('a big sample below 90% does not clear the bar', () => {
    // 30 decisions, 26 accurate = 86.7%.
    const outcomes = Array(26).fill(APPROVE).concat(Array(4).fill(CHANGES));
    const rows = computeAgentAccuracy(seed('recWriter', 'Drafting', outcomes), NAMES);
    expect(rows[0].total).toBe(30);
    expect(rows[0].rate).toBeLessThan(THRESHOLD.minRate);
    expect(rows[0].ready).toBe(false);
  });

  it('one rejection in the last 10 blocks it, however good the lifetime rate', () => {
    // 49 approvals and a single rejection — 98% lifetime, but the rejection is
    // the most recent decision. Recency is what the last-10 rule is for.
    const outcomes = [REJECT].concat(Array(49).fill(APPROVE));
    const rows = computeAgentAccuracy(seed('recWriter', 'Drafting', outcomes), NAMES);
    expect(rows[0].total).toBe(50);
    expect(rows[0].rate).toBeGreaterThan(THRESHOLD.minRate);
    expect(rows[0].recentRejections).toBe(1);
    expect(rows[0].ready, 'a fresh rejection must block autonomy').toBe(false);

    // Push the same rejection back beyond the last 10 and it clears.
    const older = Array(49).fill(APPROVE).concat([REJECT]);
    const rows2 = computeAgentAccuracy(seed('recWriter', 'Drafting', older), NAMES);
    expect(rows2[0].recentRejections).toBe(0);
    expect(rows2[0].ready).toBe(true);
  });

  it('recommends, and says out loud that it is Kevin\'s call', () => {
    const history = [
      ...seed('recWriter', 'Drafting', Array(22).fill(APPROVE)),
      ...seed('recAnalyst', 'Analysis', Array(5).fill(APPROVE)),
    ];
    const recs = agentAutonomyRecommendations(computeAgentAccuracy(history, NAMES));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toContain('AI Worker — Writer');
    expect(recs[0]).toContain('Drafting');
    expect(recs[0]).toContain('22 approvals');
    expect(recs[0]).toMatch(/your call/i);
  });

  it('untyped decisions land in Unclassified rather than vanishing', () => {
    const rows = computeAgentAccuracy([{ agentId: 'recWriter', outcome: APPROVE, at: '', taskType: '' }], NAMES);
    expect(rows[0].taskType).toBe('Unclassified');
    expect(rows[0].total).toBe(1);
  });

  it('ignores rows with no agent or no outcome instead of inventing a bucket', () => {
    const rows = computeAgentAccuracy([
      { agentId: '', taskType: 'Drafting', outcome: APPROVE, at: '' },
      { agentId: 'recWriter', taskType: 'Drafting', outcome: '', at: '' },
    ], NAMES);
    expect(rows).toHaveLength(0);
  });

  it('falls back to the record ID when no display name is known', () => {
    const rows = computeAgentAccuracy(seed('recUnknown', 'Build', [APPROVE]), NAMES);
    expect(rows[0].agentName).toBe('recUnknown');
  });
});
