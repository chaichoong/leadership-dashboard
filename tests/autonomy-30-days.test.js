import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { computeAgentAccuracy, agentAutonomyRecommendations, THRESHOLD, spanDays } = require(resolve(ROOT, 'js/agent-accuracy.js'));
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
// A fixed "now" at the end of the fixtures, so the 90-day rule (Kevin, 16 Nov 2026) reads them the same way on
// every run. `barToday` is the bar as it stands at that moment; `ready` also needs it held for 90 days.
const NOW = Date.UTC(2026, 7, 28, 12);
const DAY0 = Date.UTC(2026, 7, 28);
const rows = (items) => computeAgentAccuracy(items, { a: 'Creditor' }, NOW)[0];
const good = (at) => ({ agentId: 'a', taskType: 'Correspondence', outcome: 'Approved as-is', at });

/** n perfect decisions spread evenly across `days` days ending 28 Aug 2026. */
function spread(n, days) {
  const end = Date.UTC(2026, 7, 28);
  return Array.from({ length: n }, (_, i) =>
    good(new Date(end - Math.round((i * days * 86400000) / Math.max(1, n - 1))).toISOString()));
}

describe('a burst cannot buy autonomy', () => {
  it('26 perfect decisions in 3 days is NOT on the bar — the live case', () => {
    const r = rows([...Array(26)].map((_, i) => good(day(26 + (i % 3)))));
    expect(r.total).toBe(26);
    expect(r.rate).toBe(1);
    expect(r.spanDays).toBe(2);
    expect(r.barToday, 'a three-day burst must not clear the bar').toBe(false);
    expect(r.ready).toBe(false);
    expect(r.daysToGo).toBe(28);
  });

  it('the same volume and rate across 40 days is on the bar today', () => {
    const r = rows(spread(26, 40));
    expect(r.total).toBe(26);
    expect(r.rate).toBe(1);
    expect(r.spanDays).toBeGreaterThanOrEqual(THRESHOLD.minDays);
    expect(r.barToday).toBe(true);
  });

  it('exactly 30 days clears the 30-day part; 29 does not', () => {
    expect(rows(spread(26, 30)).barToday).toBe(true);
    expect(rows(spread(26, 29)).barToday).toBe(false);
  });

  it('time alone is not enough either — the other three still apply', () => {
    // Long history, too few decisions.
    expect(rows(spread(19, 60)).barToday).toBe(false);
    // Long history, plenty of decisions, but a recent rejection.
    const withReject = spread(25, 60).concat([
      { agentId: 'a', taskType: 'Correspondence', outcome: 'Rejected',
        reason: 'The work is wrong', at: day(28) }]);
    expect(rows(withReject).barToday).toBe(false);
    expect(rows(withReject).ready).toBe(false);
  });
});

// ── 90 DAYS IN A ROW (Kevin, 16 Nov 2026, decision card recinoFWz6fQ6JVVB, ruling 5) ─────────────────────
//
// His note of 19 Oct 2026 on a TRUST REVIEW card: the bar on a rolling basis "for a full quarter" before a
// robot moves up. Ruled for every robot and for category migration. The bar must have held at the end of
// every one of the last 90 days, read from the same decision history as it stood on each day.
/** One perfect decision a day for `n` days, the newest the day before NOW. */
const daily = (n) => Array.from({ length: n }, (_, i) => good(new Date(NOW - (i + 1) * 86400000).toISOString()));

describe('the bar must hold for 90 days in a row', () => {
  it('on the bar today but held for under 90 days is NOT ready', () => {
    const r = rows(spread(26, 40));
    expect(r.barToday).toBe(true);
    expect(r.heldDays).toBeGreaterThan(0);
    expect(r.heldDays).toBeLessThan(THRESHOLD.holdDays);
    expect(r.ready, 'the 30-day bar alone no longer recommends a robot').toBe(false);
  });

  it('held at the end of every one of the last 90 days IS ready', () => {
    const r = rows(daily(125));
    expect(r.heldDays).toBe(THRESHOLD.holdDays);
    expect(r.ready).toBe(true);
  });

  it('one day short is not ready', () => {
    // The bar first holds once the sample spans 30 days; 118 daily decisions reach that 89 day-ends back
    // (119 reach it 90 back, and are ready).
    const r = rows(daily(118));
    expect(rows(daily(119)).ready).toBe(true);
    expect(r.barToday).toBe(true);
    expect(r.heldDays).toBe(THRESHOLD.holdDays - 1);
    expect(r.ready).toBe(false);
  });

  it('a rejection inside the 90 days breaks the run, though the bar holds today', () => {
    const items = daily(200).map((d, i) => (i === 44
      ? { ...d, outcome: 'Rejected', reason: 'The work is wrong' } : d));
    const r = rows(items);
    expect(r.barToday).toBe(true);
    expect(r.heldDays).toBeLessThan(45);
    expect(r.ready).toBe(false);
  });

  it('only decisions made by each day count for that day: a later burst cannot reach back', () => {
    // 30 days of history and 20 decisions exist today, but 25 of them landed in the last week.
    const items = daily(40).filter((_, i) => i < 3 || i > 33).concat(
      Array.from({ length: 25 }, (_, i) => good(new Date(NOW - (i % 6 + 1) * 86400000 - i * 60000).toISOString())));
    const r = rows(items);
    expect(r.barToday).toBe(true);
    expect(r.heldDays).toBeLessThan(10);
    expect(r.ready).toBe(false);
  });

  it('the page and the huddle give the same answer on the same decisions, at the day boundary too', () => {
    // Review of this PR: the page counted whole 24-hour periods and the huddle calendar dates, so a first decision
    // at 22:00 UTC made one say ready and the other not. Both count UTC calendar days now.
    const sets = {
      // The first decision at 10:00, every later one at 01:00: a whole-24-hour count reads one day short here.
      boundary: [good(new Date(DAY0 - 119 * 86400000 + 10 * 3600000).toISOString())].concat(
        Array.from({ length: 118 }, (_, i) => good(new Date(DAY0 - (i + 1) * 86400000 + 1 * 3600000).toISOString()))),
      evening: Array.from({ length: 119 }, (_, i) => good(new Date(NOW - (i + 1) * 86400000 + 9 * 3600000).toISOString())),
      rejected: daily(150).map((d, i) => (i === 60 ? { ...d, outcome: 'Rejected', reason: 'The work is wrong' } : d)),
      short: daily(100),
    };
    const py = execFileSync('python3', ['-c', `
import importlib.util, json, sys, datetime
spec = importlib.util.spec_from_file_location('r', ${JSON.stringify(resolve(ROOT, 'scripts/agent-accuracy-report.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
now = datetime.datetime.fromtimestamp(${NOW} / 1000, datetime.timezone.utc)
sets = json.loads(sys.argv[1])
out = {}
for k, items in sets.items():
    row = m.score([{"agent": "a", "type": "C", "outcome": d["outcome"], "at": d["at"], "reason": d.get("reason", "")} for d in items], {}, now)[0]
    out[k] = [row["held_days"], row["ready"], row["span_days"]]
print(json.dumps(out))`, JSON.stringify(sets)], { encoding: 'utf8' });
    const fromPy = JSON.parse(py.trim());
    for (const [k, items] of Object.entries(sets)) {
      const r = rows(items);
      expect([k, r.heldDays, r.ready, r.spanDays]).toEqual([k, ...fromPy[k]]);
    }
    expect(fromPy.boundary.slice(0, 2)).toEqual([90, true]);     // the case the 24-hour count got wrong
  });

  it('the recommendation says so', () => {
    const rec = agentAutonomyRecommendations(computeAgentAccuracy(daily(125), { a: 'Creditor' }, NOW));
    expect(rec).toHaveLength(1);
    expect(rec[0]).toContain('held on every one of the last 90 days');
    expect(agentAutonomyRecommendations(computeAgentAccuracy(spread(26, 40), { a: 'Creditor' }, NOW))).toEqual([]);
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

  it('HOLD_DAYS matches THRESHOLD.holdDays, and both bars need it (Kevin, 16 Nov 2026)', () => {
    const m = PY.match(/^HOLD_DAYS\s*=\s*(\d+)/m);
    expect(m, 'agent-accuracy-report.py has no HOLD_DAYS').toBeTruthy();
    expect(Number(m[1])).toBe(THRESHOLD.holdDays);
    expect(THRESHOLD.holdDays).toBe(90);
    // The snapshot score and the weekly trust review both gate on it.
    expect(PY).toMatch(/held >= HOLD_DAYS\),/);
    expect(PY).toMatch(/if holds and held >= HOLD_DAYS:/);
  });

  it('the Python selftest proves the 90-day rule on the weekly review and the snapshot', () => {
    const out = JSON.parse(execFileSync('python3', [resolve(ROOT, 'scripts/agent-accuracy-report.py'), 'selftest'],
      { encoding: 'utf8' }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(37);
  });

  it('a row short only on TIME says so, rather than just "not ready"', () => {
    // Waiting a week and fixing the agent need opposite responses, so the row
    // has to name which one this is.
    expect(PY).toMatch(/only \{r\['span_days'\]\}d of history/);
  });
});
