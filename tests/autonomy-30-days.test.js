import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { computeAgentAccuracy, THRESHOLD, spanDays } = require(resolve(ROOT, 'js/agent-accuracy.js'));
const PY = readFileSync(resolve(ROOT, 'scripts/agent-accuracy-report.py'), 'utf8');

// ── VOLUME IS NOT CONSISTENCY (Kevin's ruling, 28 Aug 2026) ────────────────
//
// On 28 Aug 2026 the first agent in the estate's history cleared the autonomy
// bar: AI Creditor Management, Correspondence, 92% over 24 approvals with no
// rejections in the last ten. The report recommended granting it.
//
// Then the sample was checked. All 26 of its decisions had happened in THREE
// DAYS — 3 on the 26th, 14 on the 27th, 9 on the 28th. A busy Tuesday had
// manufactured a track record in an afternoon.
//
// Kevin's rule: the standard has to hold over a rolling 30 days. Elapsed time
// is the one thing a burst cannot fake.

const day = (n) => `2026-08-${String(n).padStart(2, '0')}T09:00:00.000Z`;
const rows = (items) => computeAgentAccuracy(items, { a: 'Creditor' })[0];
const good = (at) => ({ agentId: 'a', taskType: 'Correspondence', outcome: 'Approved as-is', at });

/** n perfect decisions spread evenly across `days` days ending 28 Aug 2026. */
function spread(n, days) {
  const end = Date.UTC(2026, 7, 28);
  return Array.from({ length: n }, (_, i) =>
    good(new Date(end - Math.round((i * days * 86400000) / Math.max(1, n - 1))).toISOString()));
}

describe('a burst cannot buy autonomy', () => {
  it('26 perfect decisions in 3 days is NOT ready — the live case', () => {
    const r = rows([...Array(26)].map((_, i) => good(day(26 + (i % 3)))));
    expect(r.total).toBe(26);
    expect(r.rate).toBe(1);
    expect(r.spanDays).toBe(2);
    expect(r.ready, 'a three-day burst must not clear the bar').toBe(false);
    expect(r.daysToGo).toBe(28);
  });

  it('the same volume and rate across 40 days IS ready', () => {
    const r = rows(spread(26, 40));
    expect(r.total).toBe(26);
    expect(r.rate).toBe(1);
    expect(r.spanDays).toBeGreaterThanOrEqual(THRESHOLD.minDays);
    expect(r.ready).toBe(true);
  });

  it('exactly 30 days clears it; 29 does not', () => {
    expect(rows(spread(26, 30)).ready).toBe(true);
    expect(rows(spread(26, 29)).ready).toBe(false);
  });

  it('time alone is not enough either — the other three still apply', () => {
    // Long history, too few decisions.
    expect(rows(spread(19, 60)).ready).toBe(false);
    // Long history, plenty of decisions, but a recent rejection.
    const withReject = spread(25, 60).concat([
      { agentId: 'a', taskType: 'Correspondence', outcome: 'Rejected',
        reason: 'The work is wrong', at: day(28) }]);
    expect(rows(withReject).ready).toBe(false);
  });
});

describe('spanDays cannot be fooled', () => {
  it('an undated decision is ignored, never counted as today', () => {
    // Treating a blank date as now would let ONE dated decision from a month
    // ago look like a 30-day span.
    expect(spanDays([{ at: '2026-07-01T00:00:00Z' }, { at: '' }])).toBe(0);
    expect(spanDays([{ at: '2026-07-01T00:00:00Z' }, {}])).toBe(0);
  });

  it('a single decision spans nothing', () => {
    expect(spanDays([{ at: day(28) }])).toBe(0);
    expect(spanDays([])).toBe(0);
  });

  it('unparseable dates do not throw or inflate the span', () => {
    expect(spanDays([{ at: 'not a date' }, { at: day(28) }])).toBe(0);
  });
});

describe('the huddle and the app agree about the new rule', () => {
  it('MIN_DAYS matches THRESHOLD.minDays', () => {
    const m = PY.match(/^MIN_DAYS\s*=\s*(\d+)/m);
    expect(m, 'agent-accuracy-report.py has no MIN_DAYS').toBeTruthy();
    expect(Number(m[1])).toBe(THRESHOLD.minDays);
  });

  it('the Python bar actually uses it', () => {
    expect(PY).toMatch(/days >= MIN_DAYS/);
  });

  it('a row short only on TIME says so, rather than just "not ready"', () => {
    // Waiting a week and fixing the agent need opposite responses, so the row
    // has to name which one this is.
    expect(PY).toMatch(/only \{r\['span_days'\]\}d of history/);
  });
});
