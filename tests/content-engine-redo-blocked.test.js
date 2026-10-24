// A day walled for the fixer lane must not hold the head of the night's redo queue.
//
// Regression origin: 24 Oct 2026 (finding 20261024-phase-3-1059). The night does ONE redo,
// longest-waiting receipt first. Day 2121 was chosen, re-transcribed, found no diary line and
// was blocked for the fixer lane (TOOL clip-finder) by render.block_sent_back. A block stamps
// neither `pull_failed` nor `render_failed`, the day's clips stay at `new`, and that path leaves
// its receipt parked — so 2121 stayed first in the queue, every later night picked the same day,
// failed the same way and re-blocked. 2122 (117 h), 2112 (94 h) and 2113 (69 h) could not drain
// behind it until the clip finder's own code changed. Same shape as finding 20261019-phase-3-982,
// where a render failure held the head, fixed the same way: the day steps aside, it is not dropped.
//
// Driven against the real watch.redo_order and watch.blocked_days.
//
// Back-tested: removing the `stamps.append(blocked.get(d) or "")` line in redo_order turns the
// second and third tests red (2121 keeps the head), and the first test stays green either way —
// it is the control that proves the fixture really does put 2121 at the head without a block.

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

// The four days of the incident, with 2121's receipt parked LONGEST — which is what put it at the head.
const WAITS = { 2121: '2026-10-18T06:00:00Z', 2122: '2026-10-19T12:00:00Z', 2112: '2026-10-20T11:00:00Z', 2113: '2026-10-21T12:00:00Z' };

function receipts() {
  const dir = mkdtempSync(join(tmpdir(), 'ce-redo-blocked-'));
  for (const [day, iso] of Object.entries(WAITS)) {
    const f = join(dir, `${day}.md`);
    writeFileSync(f, 'receipt');
    const t = new Date(iso).getTime() / 1000;
    utimesSync(f, t, t);
  }
  return dir;
}

// Every day sent back and waiting: status new with a `reset` note, no failure stamps.
const LEDGER = JSON.stringify(Object.fromEntries(
  Object.keys(WAITS).map((d) => [`clip${d}`, { day: Number(d), episode: Number(d), status: 'new', reset: '2026-10-18T06:00:00' }]),
));

function order(blockedPy, root) {
  return py(`import json, watch
ledger = json.loads(${JSON.stringify(LEDGER)})
print(json.dumps(watch.redo_order(ledger, root=${JSON.stringify(root)}, blocked=${blockedPy})))`);
}

describe('the night\'s redo queue and a fixer-lane wall', () => {
  it('control: with nothing blocked, the longest-waiting day (2121) is first', () => {
    expect(JSON.parse(order('{}', receipts()))).toEqual([2121, 2122, 2112, 2113]);
  });

  it('a blocked day steps aside so the days behind it drain', () => {
    const got = JSON.parse(order('{2121: "2026-10-24T03:21:00"}', receipts()));
    expect(got[0]).toBe(2122);                       // the night can now render the next day
    expect(got[got.length - 1]).toBe(2121);          // behind the days that can still render
    expect(got).toHaveLength(4);                     // stepped aside, never dropped from the queue
  });

  it('lifting the wall puts the day back at the head it earned by waiting', () => {
    expect(JSON.parse(order('{}', receipts()))[0]).toBe(2121);
  });

  it('blocked_days reads approval.py\'s state, and an unreadable file blocks nothing', () => {
    const box = mkdtempSync(join(tmpdir(), 'ce-approvals-'));
    const good = join(box, 'approvals.json');
    writeFileSync(good, JSON.stringify({
      2121: { task: 'rec1', redo_blocked: { at: '2026-10-24T03:21:00', why: 'no diary line', code: 'abc123' } },
      2122: { task: 'rec2' },
    }));
    expect(JSON.parse(py(`import json, watch; print(json.dumps(watch.blocked_days(${JSON.stringify(good)})))`)))
      .toEqual({ 2121: '2026-10-24T03:21:00' });

    const half = join(box, 'half.json');
    writeFileSync(half, '{"2121": {"redo_blocked": {"at":');   // a half-written file is "nothing blocked", never a crash
    expect(JSON.parse(py(`import json, watch; print(json.dumps(watch.blocked_days(${JSON.stringify(half)})))`))).toEqual({});
    expect(JSON.parse(py(`import json, watch; print(json.dumps(watch.blocked_days(${JSON.stringify(join(box, 'gone.json'))})))`))).toEqual({});
  });
});
