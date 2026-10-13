// A sent-back content day that is "in motion" must stop reading as healthy.
//
// WHY (13 Oct 2026, finding 20261013-phase-3-850)
// stuck_sent_back skipped any day with a clip at 'new' on a day the night
// planner will reach, and any day whose parked receipt was not yet stale. The
// night drains roughly ONE sent-back day, so 2099 and 2100 (parked 9 Oct) and
// 2106 (10 Oct) sat with every clip at 'new' while the morning stuck report
// returned 2097 alone. Four days of waiting read as healthy — the exact
// failure a trust surface exists to prevent.
//
// Motion now ages out at `stale_hours`. These tests drive the real function.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const DIR = path.resolve(__dirname, '..', 'scripts', 'content-engine');

// `approvals` / `ledger` / `receipts` are passed in, so nothing reads the live
// engine state, and `running` is forced so the process table is never consulted.
function stuck({ hoursAgo, receiptHoursAgo = null, status = 'new', staleHours = 48, others = {} }) {
  const py = `
import datetime as dt, json, sys
sys.path.insert(0, ${JSON.stringify(DIR)})
import content_report as cr
now = dt.datetime(2026, 10, 13, 7, 0, 0)
sent = (now - dt.timedelta(hours=${hoursAgo})).isoformat()
approvals = {"2099": {"task": "recA", "verdict": "changes", "synced": sent, "feedback": "stabilisation is degraded"}}
approvals.update(json.loads(${JSON.stringify(JSON.stringify(others))}))
ledger = {"c1": {"day": 2099, "episode": 2099, "status": "${status}"}}
receipts = {}
${receiptHoursAgo === null ? '' : 'receipts[2099] = now - dt.timedelta(hours=' + receiptHoursAgo + ')'}
rows = cr.stuck_sent_back(now=now, hours=24, approvals=approvals, ledger=ledger, episodes={},
                          redo_days=set(), receipts=receipts, reachable={2099},
                          last_night=now - dt.timedelta(hours=4), running=False,
                          stale_hours=${staleHours})
print(json.dumps(rows))
`;
  return JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8', cwd: DIR }));
}

describe('content_report stuck_sent_back — motion ages out', () => {
  it('lists a day whose clips have not moved for four days, with the nights waited', () => {
    const rows = stuck({ hoursAgo: 96, status: 'new' });
    expect(rows.map((r) => r.day), 'a four-day wait still read as motion').toEqual([2099]);
    expect(rows[0].why).toMatch(/waiting 4 night\(s\) with nothing moving/);
    expect(rows[0].why).toMatch(/clips still at 'new'/);
  });

  it('lists a day whose receipt has been parked for four days', () => {
    const rows = stuck({ hoursAgo: 96, receiptHoursAgo: 96, status: 'new' });
    expect(rows.map((r) => r.day)).toEqual([2099]);
    expect(rows[0].why).toMatch(/a receipt is parked/);
  });

  it('says how many sent-back days sit in front of it', () => {
    const rows = stuck({
      hoursAgo: 96,
      others: {
        2095: { task: 'recB', verdict: 'changes', synced: '2026-10-07T07:00:00' },
        2096: { task: 'recC', verdict: 'changes', synced: '2026-10-08T07:00:00' },
        2112: { task: 'recD', verdict: 'changes', synced: '2026-10-13T06:00:00' },
      },
    });
    const mine = rows.find((r) => r.day === 2099);
    expect(mine.why, 'the queue depth in front of it was not reported')
      .toMatch(/\(2 sent-back day\(s\) in front of it\)/);
  });

  it('still treats a day queued last night as in motion', () => {
    expect(stuck({ hoursAgo: 30, status: 'new' })).toEqual([]);
  });

  it('a clip genuinely mid-render is still motion, however long it has waited', () => {
    expect(stuck({ hoursAgo: 96, status: 'rendered' }).length).toBe(1);
    // 'rendered' is not WAITING, so it falls through to the old reasons rather
    // than the aged-out one: the point is only that the ceiling did not invent
    // a new skip. A day actively rendering is excluded by `running`, tested by
    // the engine's own selftest.
  });
});
