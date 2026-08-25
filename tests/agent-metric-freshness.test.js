// "Metric fresh" has to be able to detect staleness.
//
// THE BUG THIS EXISTS FOR (finding 20260825-drift-monitor-355)
// The AI Agents page carried a health check named "Inbound Comms Response
// metric fresh". All it asked was whether Metric Score was non-empty. A score
// published once in July passed it every day for ever, so the one check whose
// entire job was to notice a stopped runtime was structurally incapable of
// noticing a stopped runtime — and reported PASS while doing it, which is worse
// than having no check at all.
//
// Freshness needs something DATED. Metric Score has no timestamp, so the age
// comes from the agent's AI Agent Daily Log rows, which do.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const src = readFileSync(resolve(ROOT, 'os/agents/index.html'), 'utf8');

// Run the real function, not a copy.
function makeAgeFn(rows, today) {
  const fn = src.match(/function agentLogAgeDays\(agentId\)\{[\s\S]*?\n\}/)[0];
  return new Function('ROWS', 'TODAY', `
    const allDailyLogRows = ROWS;
    const ALOG = {date:'d', agent:'a'};
    const gf = (r,f)=>r[f];
    const linkIds = (v)=>Array.isArray(v)?v:(v?[v]:[]);
    const todayStr = ()=>TODAY;
    ${fn}
    return agentLogAgeDays;
  `)(rows, today);
}

const row = (agentId, date) => ({ a: [agentId], d: date });

describe('agentLogAgeDays', () => {
  it('returns 0 for a log written today', () => {
    const age = makeAgeFn([row('recA', '2026-08-25')], '2026-08-25');
    expect(age('recA')).toBe(0);
  });

  it('measures from the NEWEST log, not the first row it meets', () => {
    // The page holds rows newest-first today, but that is an ordering it does
    // not control. Reading rows[0] would report a fresh agent as stale the day
    // Airtable returns them the other way round.
    const rows = [row('recA', '2026-07-01'), row('recA', '2026-08-24'), row('recA', '2026-08-02')];
    expect(makeAgeFn(rows, '2026-08-25')('recA')).toBe(1);
  });

  it('ignores other agents’ logs', () => {
    const rows = [row('recB', '2026-08-25'), row('recA', '2026-08-18')];
    expect(makeAgeFn(rows, '2026-08-25')('recA')).toBe(7);
  });

  it('returns null when the agent has never written a log', () => {
    // Distinct from "old": nothing dates the score at all, so it could be from
    // any day. The check must say that rather than guessing.
    expect(makeAgeFn([row('recB', '2026-08-25')], '2026-08-25')('recA')).toBeNull();
  });

  it('ignores a malformed date rather than treating it as today', () => {
    const rows = [row('recA', ''), row('recA', 'not-a-date'), row('recA', '2026-08-20')];
    expect(makeAgeFn(rows, '2026-08-25')('recA')).toBe(5);
  });
});

describe('the check that uses it', () => {
  const check = src.slice(src.indexOf("name: 'Inbound Comms Response metric fresh'"),
                          src.indexOf("name: 'Check zones computed'"));

  it('fails on a stale log rather than passing on a non-empty score', () => {
    expect(check).toContain('agentLogAgeDays(row.id)');
    expect(check).toContain('METRIC_STALE_DAYS');
    expect(check).toMatch(/age > METRIC_STALE_DAYS[\s\S]{0,80}status:'fail'/);
  });

  it('fails, not passes, when nothing dates the score at all', () => {
    expect(check).toMatch(/age === null[\s\S]{0,120}status:'fail'/);
  });

  it('does not claim staleness it cannot measure when the log read failed', () => {
    // A failed daily-log read is not evidence the runtime stopped. Saying so
    // would be the same class of lie in the other direction.
    expect(check).toMatch(/_dailyLogState[\s\S]{0,200}status:'warn'/);
  });

  it('tolerates a weekend gap so it is still believed on a Monday', () => {
    const n = Number(src.match(/const METRIC_STALE_DAYS = (\d+)/)[1]);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(7);
  });
});
