import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// The real source the browser loads, not a copy — a threshold changed in the
// app and not here would otherwise pass silently.
const { computeAgentAccuracy, agentAutonomyRecommendations, THRESHOLD, countAgents } = require(resolve(ROOT, 'js/agent-accuracy.js'));

// Seeded decisions. `at` counts DOWN so index 0 is the newest, which is what
// the "last 10" window depends on.
// One decision every TWO DAYS, newest first. The spacing is load-bearing:
// since 28 Aug 2026 the bar also requires the sample to span 30 days (Kevin's
// ruling, after the first agent to clear it turned out to have done all 26 of
// its decisions inside three days). At one an hour these fixtures spanned less
// than a day and would fail the bar for a reason none of them is testing.
// The 30-day rule itself is covered by tests/autonomy-30-days.test.js.
const SEED_STEP_MS = 2 * 24 * 3600e3;
function seed(agentId, taskType, outcomes) {
  return outcomes.map((outcome, i) => ({
    agentId,
    taskType,
    outcome,
    at: new Date(Date.UTC(2026, 6, 31, 12, 0, 0) - i * SEED_STEP_MS).toISOString(),
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

describe('countAgents — one agent, one count, across two populations', () => {
  const wf = [{ id: 'wf1', state: 'live' }, { id: 'wf2', state: 'testing' }, { id: 'wf3', state: 'live' }];

  it('a register row linking a workflow is the SAME agent, not two', () => {
    // wf1 is linked from a Live register row — counting both was the dashboard
    // bug: the front-page headline exceeded the tab badge it links to.
    const reg = [{ status: 'Live', workflowIds: ['wf1'] }, { status: 'Building', workflowIds: [] }];
    const c = countAgents(wf, reg);
    expect(c.live).toBe(2);        // wf3 + the register row (wf1 folded into it)
    expect(c.testing).toBe(1);
    expect(c.wfOverlap).toBe(1);
  });

  it('with no register rows, matches the old workflow-only behaviour', () => {
    const c = countAgents(wf, []);
    expect(c.live).toBe(2);
    expect(c.testing).toBe(1);
    expect(c.wfOverlap).toBe(0);
  });

  it('degrades safely on empty and missing inputs', () => {
    expect(countAgents([], []).live).toBe(0);
    expect(countAgents(null, null).live).toBe(0);
  });
});

// ── THE QUALITY / RELEVANCE SPLIT (27 Aug 2026) ────────────────────────────
//
// Measured live that day across all 175 decisions Kevin had made: of his 58
// rejections, NOT ONE said the draft was wrong. Every one said the task should
// not have existed — already handled, Roy's, too trivial, duplicate, stale.
// Blended accuracy read 66.9%; on the drafts anyone had actually judged AS
// drafts it was 96.7%.
//
// The consequence was not cosmetic. Guardrail bands tighten AUTOMATICALLY on
// this number, so agents were being restricted for a failure upstream of them.
const { relevanceScore, isRelevanceFailure, RELEVANCE_REASONS, QUALITY_REASON } =
  require(resolve(ROOT, 'js/agent-accuracy.js'));

describe('a rejection is not automatically a mark against the writer', () => {
  // Two days apart, so a 22-item fixture spans 42 days and clears the 30-day
  // rule added 28 Aug 2026. Ordering is unchanged — i still increases with
  // time, so the last item is still the newest and lands in the recent-10.
  const dated = (i) => new Date(Date.UTC(2026, 5, 1) + i * 2 * 24 * 3600e3).toISOString();
  const rows = (items) => computeAgentAccuracy(
    items.map((x, i) => ({ agentId: 'recW', taskType: 'Correspondence', at: dated(i), ...x })),
    { recW: 'Writer' })[0];

  it('a relevance rejection leaves the draft-quality bucket entirely', () => {
    const r = rows([
      { outcome: 'Approved as-is' },
      { outcome: 'Rejected', reason: 'Roy owns it' },
    ]);
    // Not counted as accurate AND not counted in the total. Leaving it in the
    // denominator would still halve the rate, which is the bug.
    expect(r.total).toBe(1);
    expect(r.accurate).toBe(1);
    expect(r.rate).toBe(1);
    expect(r.relevanceFailures).toBe(1);
  });

  it('"The work is wrong" still counts, or nothing ever does', () => {
    const r = rows([
      { outcome: 'Approved as-is' },
      { outcome: 'Rejected', reason: QUALITY_REASON },
    ]);
    expect(r.total).toBe(2);
    expect(r.accurate).toBe(1);
    expect(r.rate).toBe(0.5);
    expect(r.relevanceFailures).toBe(0);
  });

  it('every relevance reason is treated the same way', () => {
    RELEVANCE_REASONS.forEach((reason) => {
      expect(isRelevanceFailure({ outcome: 'Rejected', reason }), reason).toBe(true);
    });
    expect(isRelevanceFailure({ outcome: 'Rejected', reason: QUALITY_REASON })).toBe(false);
    // An APPROVAL carrying a reason is not a rejection, whatever the reason says.
    expect(isRelevanceFailure({ outcome: 'Approved as-is', reason: 'Roy owns it' })).toBe(false);
  });

  it('a relevance rejection does not block the bar through the recent-10 clause', () => {
    // This is what was blocking Writer/Correspondence: 95% over 22 decisions,
    // held back for ever by ONE rejection that was a relevance failure.
    const items = Array(21).fill({ outcome: 'Approved as-is' })
      .concat([{ outcome: 'Rejected', reason: 'Already done elsewhere' }]);
    const r = rows(items);
    expect(r.recentRejections).toBe(0);
    expect(r.total).toBe(21);
    expect(r.ready, 'a task that should not have existed must not gate autonomy').toBe(true);
  });

  it('a QUALITY rejection still blocks the bar', () => {
    const items = Array(21).fill({ outcome: 'Approved as-is' })
      .concat([{ outcome: 'Rejected', reason: QUALITY_REASON }]);
    // Newest first: the quality rejection is dated last, so it lands in recent.
    expect(rows(items).ready).toBe(false);
  });

  it('history with no reason is counted the old way, and SAID so', () => {
    // Every decision before 27 Aug 2026 has no reason and nothing may guess one
    // on Kevin's behalf — he is the only one who can tell a rule from a one-off.
    // So the old behaviour stands, and the count makes that visible rather than
    // letting the score quietly look better than the evidence supports.
    const r = rows([{ outcome: 'Approved as-is' }, { outcome: 'Rejected' }]);
    expect(r.total).toBe(2);
    expect(r.rate).toBe(0.5);
    expect(r.unclassifiedRejections).toBe(1);
    expect(r.relevanceFailures).toBe(0);
  });
});

describe('relevance is its own score, owned by whatever created the task', () => {
  it('measures against classified decisions only', () => {
    const s = relevanceScore([
      { outcome: 'Approved as-is' },
      { outcome: 'Rejected', reason: 'Duplicate' },
      { outcome: 'Rejected' },                       // unknown, not a pass
    ]);
    expect(s.decisions).toBe(3);
    expect(s.classified).toBe(2);
    expect(s.relevanceFailures).toBe(1);
    expect(s.rate).toBe(0.5);
  });

  it('is 100% when nothing was rejected for existing', () => {
    expect(relevanceScore([{ outcome: 'Approved as-is' },
                           { outcome: 'Rejected', reason: QUALITY_REASON }]).rate).toBe(1);
  });

  it('does not divide by zero on an empty history', () => {
    expect(relevanceScore([]).rate).toBe(0);
    expect(relevanceScore(null).decisions).toBe(0);
  });
});
