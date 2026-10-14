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
  it('lists a day whose receipt has been parked for four nights, with the nights counted', () => {
    // The live case: 2099 parked 9 Oct, every clip still at 'new' on a reachable day, so the
    // old "a clip waits and the planner will reach it" skip hid it for four days.
    const rows = stuck({ hoursAgo: 96, receiptHoursAgo: 96, status: 'new' });
    expect(rows.map((r) => r.day), 'a four-night parked receipt still read as motion').toEqual([2099]);
    expect(rows[0].why).toMatch(/a receipt has been parked 4 night\(s\) with nothing moving/);
  });

  it('a receipt parked past the ceiling outranks a reachable waiting clip', () => {
    // Keyed on the RECEIPT's age, so a fresh receipt is motion however old the send-back is.
    expect(stuck({ hoursAgo: 96, receiptHoursAgo: 2, status: 'new' }),
      'a receipt written two hours ago was treated as stalled').toEqual([]);
  });

  it('says how many sent-back days sit in front of it', () => {
    const rows = stuck({
      hoursAgo: 96, receiptHoursAgo: 96,
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
    expect(stuck({ hoursAgo: 30, receiptHoursAgo: 6, status: 'new' })).toEqual([]);
  });

  it('CONTROL: a day with no receipt keeps its existing reasons, the ceiling adds no skip', () => {
    // tests/content-engine-sent-back.test.js owns these paths. The ceiling must not
    // reach them: a reachable waiting clip is still the backlog, whatever the send-back age.
    expect(stuck({ hoursAgo: 96, status: 'new' }),
      'the ceiling leaked onto the clip path and overrode its reason').toEqual([]);
    const rendered = stuck({ hoursAgo: 96, status: 'rendered' });
    expect(rendered.length).toBe(1);
    expect(rendered[0].why).toMatch(/nothing in motion/);
  });
});
