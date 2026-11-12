// A day Kevin keeps sending back must not re-take the one nightly redo slot for ever.
//
// Regression origin: 18 Oct 2026 (finding 20261018-phase-3-975). The redo queue sorted
// sent-back days by DAY NUMBER. Day 2100 was sent back again on 14, 15, 16 and 17 Oct
// and, being the lower number, took the night's single redo slot on every one of those
// nights. Day 2106 — receipt parked since 10 Oct — never rendered, and the morning report
// told Kevin it was "first in the night's redo queue, so tonight" on eight consecutive
// mornings, because the estimate came from queue position and not from what the runs did.
//
// Two rules, both driven here against the real functions:
//   1. the queue is ordered by how long each day has WAITED (its parked receipt), not by
//      day number, so a re-sent-back day goes behind the days already waiting;
//   2. a day that is still first after a night with its receipt parked reports STUCK, and a day
//      further back that has waited LONGER than the day in front of it is being jumped, and says
//      so (reworded 30 Oct 2026: it used to judge the clock against the position, which flagged
//      every normal wait — finding 20261021-queue-fixer-1026).
//
// Back-tested: restoring the `key=lambda d: (failed_at(d), d)` sort turns the first test
// red, and dropping the `waited` branches turns the last two red.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CE = resolve(__dirname, '../scripts/content-engine');

// Every snippet starts with the night's redo-plan record pointed at an empty scratch path. render.resubmit_due
// reads watch.planned_redo_order(), which reads the LIVE record the night writes (~/.config/od), so once a real
// record inside 24 hours existed (20 Oct 2026) these tests read "7 of 7" off the live queue and failed on main.
const NO_LIVE_PLAN = `import os as _os, tempfile as _tf, watch as _watch
_watch.REDO_PLAN_FILE = _os.path.join(_tf.mkdtemp(prefix="ce-redo-plan-"), "none.json")`;

function py(code) {
  return execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(CE)})\n${NO_LIVE_PLAN}\n${code}`],
    { encoding: 'utf8', timeout: 30000 }).trim();
}

// Receipts parked on the days of the real incident.
function receipts(days) {
  const dir = mkdtempSync(join(tmpdir(), 'ce-resubmit-'));
  for (const [day, iso] of Object.entries(days)) {
    const f = join(dir, `${day}.md`);
    writeFileSync(f, 'receipt');
    const t = new Date(iso).getTime() / 1000;
    utimesSync(f, t, t);
  }
  return dir;
}

// 2100 sent back AGAIN on 17 Oct; 2106 waiting since 10 Oct; 2112 since 13 Oct.
const LEDGER = `ledger = {
  "a.insv": {"day": 2100, "episode": 2100, "status": "new", "reset": "17 Oct: sent back"},
  "b.insv": {"day": 2106, "episode": 2106, "status": "new", "reset": "10 Oct: sent back"},
  "c.insv": {"day": 2112, "episode": 2112, "status": "new", "reset": "13 Oct: sent back"},
}`;

describe('content engine redo queue', () => {
  it('takes the longest-waiting sent-back day, not the lowest day number', () => {
    const dir = receipts({ 2100: '2026-10-17T17:23:00Z', 2106: '2026-10-10T14:16:00Z', 2112: '2026-10-13T09:19:00Z' });
    const out = py(`import watch, json
${LEDGER}
print(json.dumps(watch.redo_order(ledger, root=${JSON.stringify(dir)})))`);
    // 2100 is the lowest number and would have won under the old sort.
    expect(JSON.parse(out)).toEqual([2106, 2112, 2100]);
  });

  // Finding 20261019-phase-3-987, fourth recurrence (4 Nov 2026). Day 2106 has a second long recording the engine
  // will not pick between, stamped on the clip exactly as the live ledger holds it. That clip sits at `failed`, and
  // both failure stamps are read off clips at `new`, so 2106 held the head of the queue from 10 Oct and 2113 waited
  // behind it while the night log said it was "about 1 night(s) away" every night.
  const NEEDS_RULING = '"d.insv": {"day": 2106, "episode": 2106, "status": "failed", "requeued": "not requeued: it needs a person"},';

  it('a day waiting on a ruling from Kevin does not hold the head of the queue', () => {
    const dir = receipts({ 2100: '2026-10-17T17:23:00Z', 2106: '2026-10-10T14:16:00Z', 2112: '2026-10-13T09:19:00Z' });
    const out = py(`import watch, json
${LEDGER}
ledger.update(json.loads('{${NEEDS_RULING.replace(/'/g, "")}}'.replace(",}", "}")))
print(json.dumps(watch.redo_order(ledger, root=${JSON.stringify(dir)})))`);
    // 2106 has waited longest and still goes last: a night cannot clear a clip only Kevin can rule on.
    expect(JSON.parse(out)).toEqual([2112, 2100, 2106]);
  });

  it('it goes behind an ordinary failure too, because that one can still clear itself', () => {
    const dir = receipts({ 2100: '2026-10-17T17:23:00Z', 2106: '2026-10-10T14:16:00Z', 2112: '2026-10-13T09:19:00Z' });
    const out = py(`import watch, json
${LEDGER}
ledger.update(json.loads('{${NEEDS_RULING.replace(/'/g, "")}}'.replace(",}", "}")))
ledger["c.insv"]["render_failed"] = "2026-10-18T02:00:00"
print(json.dumps(watch.redo_order(ledger, root=${JSON.stringify(dir)})))`);
    expect(JSON.parse(out)).toEqual([2100, 2112, 2106]);
  });

  it('CONTROL: a clip the engine WILL retry leaves the order alone', () => {
    const dir = receipts({ 2100: '2026-10-17T17:23:00Z', 2106: '2026-10-10T14:16:00Z', 2112: '2026-10-13T09:19:00Z' });
    const out = py(`import watch, json
${LEDGER}
ledger["d.insv"] = {"day": 2106, "episode": 2106, "status": "failed", "requeued": "requeued for tonight"}
print(json.dumps([watch.redo_order(ledger, root=${JSON.stringify(dir)}), watch.needs_a_ruling(2106, ledger)]))`);
    expect(JSON.parse(out)).toEqual([[2106, 2112, 2100], false]);
  });

  it('plan() takes the renderable day, so the queue behind the ruling drains', () => {
    const dir = receipts({ 2106: '2026-10-10T14:16:00Z', 2113: '2026-11-02T09:00:00Z' });
    const out = py(`import watch, json
ledger = {
  "b.insv": {"day": 2106, "episode": 2106, "status": "new", "reset": "10 Oct: sent back"},
  "d.insv": {"day": 2106, "episode": 2106, "status": "failed", "requeued": "not requeued: it needs a person"},
  "e.insv": {"day": 2113, "episode": 2113, "status": "new", "reset": "2 Nov: sent back"},
}
watch.RESUBMIT_DIR = ${JSON.stringify(dir)}
days, notes = watch.plan(ledger, 2, gaps=set(), free=10**13, start=2054)
print(json.dumps({"days": days, "note": [n for n in notes if "renders first" in n]}))`);
    const r = JSON.parse(out);
    expect(r.days[0]).toBe(2113);                 // before the fix this was 2106, every night, for 25 nights
    expect(r.note[0]).toContain('day 2113');
  });

  it('puts a redo day with no parked receipt behind the ones that are waiting', () => {
    const dir = receipts({ 2106: '2026-10-10T14:16:00Z' });
    const out = py(`import watch, json
${LEDGER}
print(json.dumps(watch.redo_order(ledger, root=${JSON.stringify(dir)})))`);
    expect(JSON.parse(out)[0]).toBe(2106);
  });

  it('plan() takes its redo from that same order', () => {
    const dir = receipts({ 2100: '2026-10-17T17:23:00Z', 2106: '2026-10-10T14:16:00Z', 2112: '2026-10-13T09:19:00Z' });
    const out = py(`import watch, json
${LEDGER}
ledger["n1.insv"] = {"day": 2121, "status": "new"}
ledger["n2.insv"] = {"day": 2122, "status": "new"}
watch.RESUBMIT_DIR = ${JSON.stringify(dir)}
days, notes = watch.plan(ledger, 2, gaps=set(), free=10**13, start=2054)
print(json.dumps({"days": days, "first_note": [n for n in notes if "renders first" in n]}))`);
    const r = JSON.parse(out);
    expect(r.days[0]).toBe(2106);
    expect(r.first_note[0]).toContain('day 2106');
  });

  it('counts the nights a receipt has been parked, not the hours', () => {
    const out = py(`import render, datetime as dt
parked = dt.datetime(2026, 10, 10, 14, 16).timestamp()
print(render.nights_parked(parked, now=dt.datetime(2026, 10, 11, 9, 0)),
      render.nights_parked(parked, now=dt.datetime(2026, 10, 18, 9, 0)),
      render.nights_parked(dt.datetime(2026, 10, 18, 2, 0).timestamp(), now=dt.datetime(2026, 10, 18, 9, 0)))`);
    expect(out).toBe('1 8 0');
  });

  it('calls a day stuck, not "tonight", once it has been first for a night', () => {
    const dir = receipts({ 2106: '2026-10-10T14:16:00Z' });
    const out = py(`import render, watch, os
${LEDGER}
del ledger["a.insv"]; del ledger["c.insv"]
watch.RESUBMIT_DIR = ${JSON.stringify(dir)}
watch.gap_days = lambda *a, **k: set(); watch.start_day = lambda *a, **k: 2054
print(render.resubmit_due(2106, ledger, os.path.getmtime(os.path.join(${JSON.stringify(dir)}, "2106.md")),
                          {"verdict": "changes"}, {}))`);
    expect(out).toContain('STILL has not rendered');
    expect(out).toContain('stuck, not waiting');
    expect(out).not.toContain('so tonight');
  });

  // Reworded 30 Oct 2026 (finding 20261021-queue-fixer-1026, recurrence). The warning used to fire
  // whenever the nights parked exceeded `place - 1`, which measures something else entirely: a day
  // that correctly waited its turn behind two days that both drained read as a jam, every normal
  // wait. It now fires on the ORDER, which is the real invariant — the queue is longest-waiting
  // first, so a day further back that has waited LONGER is being jumped. That is this very case,
  // and the case below is the one that used to cry wolf.
  it('flags a day being jumped: it has waited longer than the day in front of it', () => {
    const dir = receipts({ 2100: '2026-10-17T17:23:00Z', 2106: '2026-10-10T14:16:00Z' });
    const out = py(`import render, watch, os
${LEDGER}
del ledger["c.insv"]
ledger["b.insv"]["reset"] = "10 Oct"; ledger["a.insv"]["reset"] = "17 Oct"
watch.RESUBMIT_DIR = ${JSON.stringify(dir)}
render.RESUBMIT_DIR = ${JSON.stringify(dir)}
watch.gap_days = lambda *a, **k: set(); watch.start_day = lambda *a, **k: 2054
watch.redo_order = lambda *a, **k: [2100, 2106]   # the old day-number order, to put 2106 second
print(render.resubmit_due(2106, ledger, os.path.getmtime(os.path.join(${JSON.stringify(dir)}, "2106.md")),
                          {"verdict": "changes"}, {}))`);
    expect(out).toContain('2 of 2');
    expect(out).toContain('NOT draining longest-waiting first');
    expect(out).toContain('being jumped');
    expect(out).toContain('cannot be trusted');
    expect(out).toContain('day 2100 in front of it');
  });

  it('CONTROL: a day waiting its turn in a correctly ordered queue is not flagged', () => {
    // The case that cried wolf. Same two days, same places, but the queue is in the RIGHT order:
    // the day in front has waited longest, so this day is simply waiting. Before 30 Oct 2026 this
    // read "NOT draining at one a night and this estimate cannot be trusted" every morning.
    const dir = receipts({ 2100: '2026-10-10T14:16:00Z', 2106: '2026-10-17T17:23:00Z' });
    const out = py(`import render, watch, os
${LEDGER}
del ledger["c.insv"]
ledger["a.insv"]["reset"] = "10 Oct"; ledger["b.insv"]["reset"] = "17 Oct"
watch.RESUBMIT_DIR = ${JSON.stringify(dir)}
render.RESUBMIT_DIR = ${JSON.stringify(dir)}
watch.gap_days = lambda *a, **k: set(); watch.start_day = lambda *a, **k: 2054
watch.redo_order = lambda *a, **k: [2100, 2106]
print(render.resubmit_due(2106, ledger, os.path.getmtime(os.path.join(${JSON.stringify(dir)}, "2106.md")),
                          {"verdict": "changes"}, {}))`);
    expect(out).toContain('2 of 2');
    expect(out).toContain('in the right order');
    expect(out).not.toContain('NOT draining');
    expect(out).not.toContain('being jumped');
    expect(out).not.toContain('cannot be trusted');
  });
});
