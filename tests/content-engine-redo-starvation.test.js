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
//   2. a day that is still first after a night with its receipt parked reports STUCK, and
//      a position estimate the waiting has already outrun says so.
//
// Back-tested: restoring the `key=lambda d: (failed_at(d), d)` sort turns the first test
// red, and dropping the `waited` branches turns the last two red.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CE = resolve(__dirname, '../scripts/content-engine');

function py(code) {
  return execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(CE)})\n${code}`],
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

  it('flags a position estimate the waiting has already outrun', () => {
    const dir = receipts({ 2100: '2026-10-17T17:23:00Z', 2106: '2026-10-10T14:16:00Z' });
    const out = py(`import render, watch, os
${LEDGER}
del ledger["c.insv"]
ledger["b.insv"]["reset"] = "10 Oct"; ledger["a.insv"]["reset"] = "17 Oct"
watch.RESUBMIT_DIR = ${JSON.stringify(dir)}
watch.gap_days = lambda *a, **k: set(); watch.start_day = lambda *a, **k: 2054
watch.redo_order = lambda *a, **k: [2100, 2106]   # the old day-number order, to put 2106 second
print(render.resubmit_due(2106, ledger, os.path.getmtime(os.path.join(${JSON.stringify(dir)}, "2106.md")),
                          {"verdict": "changes"}, {}))`);
    expect(out).toContain('2 of 2');
    expect(out).toContain('NOT draining at one a night');
  });
});
