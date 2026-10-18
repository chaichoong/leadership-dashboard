// A sent-back day waiting its turn must say so, because a queue wait and a
// stalled render used to read the same.
//
// Regression origin: finding 20261016-phase-3-935, 16 Oct 2026. The night renders
// ONE redo, whatever the slots (Kevin, 7 Oct 2026). Four days held parked
// receipts and day 2106 had waited six nights, while every report said "a clip of
// the day is still waiting to render" — true of a jam and of a queue, and read as
// the jam. The planner's own note said only "waits for another night", so nobody
// could tell whether the queue was draining.
//
// The cap itself is Kevin's ruling and is NOT changed here. What is fixed is that
// the wait is now visible: the place in the queue and the nights to go.
//
// These tests drive the real Python (render.redo_queue_place, render.resubmit_due
// and watch.plan) against a ledger built in memory.
//
// Updated 18 Oct 2026 (finding 20261018-phase-3-975): the queue is no longer ordered
// by DAY NUMBER but by how long each day has WAITED — the age of the receipt parked
// when Kevin sent the card back. Sorting on the number starved the queue: day 2100
// was sent back again on 14, 15, 16 and 17 Oct and, being the lower number, re-took
// the single redo slot every one of those nights while 2106 waited eight. So these
// tests now PARK THE RECEIPTS that decide the order, in a temp directory, rather
// than leaning on the day numbers and reading whatever sits in ~/.config/od.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const CE = resolve(__dirname, '../scripts/content-engine');

// Run a snippet inside the content-engine package so the real modules import.
function py(code) {
  return execFileSync('python3', ['-c', code], {
    encoding: 'utf8',
    cwd: CE,
    env: { ...process.env, PYTHONPATH: CE },
  }).trim();
}

// Three sent-back days, all reset to 'new', none with a failed pull, their receipts
// parked oldest-first in day order. 2100 has waited longest so it takes tonight's
// single slot; 2106 and 2112 wait. This is the exact shape of the incident.
const LEDGER = `{
  "a.insv": {"day": 2100, "episode": 2100, "role": "episode", "status": "new", "reset": "trial"},
  "b.insv": {"day": 2106, "episode": 2106, "role": "episode", "status": "new", "reset": "trial"},
  "c.insv": {"day": 2112, "episode": 2112, "role": "episode", "status": "new", "reset": "trial"},
  "d.insv": {"day": 2150, "episode": 2150, "role": "episode", "status": "new"}
}`;

// Receipts parked in a scratch directory, 2100 longest ago, so the order under test
// is the one this fixture states and never the live ~/.config/od contents.
const RECEIPTS = `
import os, tempfile, watch
watch.RESUBMIT_DIR = tempfile.mkdtemp(prefix="ce-receipts-")
for day, days_ago in ((2100, 8), (2106, 5), (2112, 2)):
    path = os.path.join(watch.RESUBMIT_DIR, "%d.md" % day)
    open(path, "w").write("receipt")
    when = 1760000000 - days_ago * 86400
    os.utime(path, (when, when))
`;

describe('the sent-back redo queue says where a day sits', () => {
  it('places each sent-back day in the queue, oldest first', () => {
    const out = py(`
import json, render, watch
${RECEIPTS}
led = json.loads('''${LEDGER}''')
print(json.dumps({str(d): render.redo_queue_place(d, led) for d in (2100, 2106, 2112)}))
`);
    const place = JSON.parse(out);
    expect(place['2100']).toEqual([1, 3]);
    expect(place['2106']).toEqual([2, 3]);
    expect(place['2112']).toEqual([3, 3]);
  });

  it('a day that was never sent back is not in the queue', () => {
    // Control. If every waiting day read as a redo, the place would be noise and
    // a reader would learn to ignore it.
    const out = py(`
import json, render, watch
${RECEIPTS}
led = json.loads('''${LEDGER}''')
print(json.dumps(render.redo_queue_place(2150, led)))
`);
    expect(JSON.parse(out)[0]).toBe(null);
  });

  it('a day behind the cap says how many nights, not "still waiting to render"', () => {
    const out = py(`
import json, render, watch
${RECEIPTS}
led = json.loads('''${LEDGER}''')
card = {"verdict": "changes"}
print(render.resubmit_due(2106, led, 0, card, {}))
`);
    expect(out).toMatch(/2 of 3 sent-back days/);
    expect(out).toMatch(/about 1 more night/);
    expect(out).toMatch(/one redo a night/);
    // The old wording is what hid the cause for six nights.
    expect(out).not.toMatch(/^a clip of the day is still waiting to render$/);
  });

  it('the day at the front says it renders tonight — on the night it was sent back', () => {
    const out = py(`
import json, time, render, watch
${RECEIPTS}
led = json.loads('''${LEDGER}''')
print(render.resubmit_due(2100, led, time.time(), {"verdict": "changes"}, {}))
`);
    expect(out).toMatch(/first in the night's redo queue/);
    expect(out).toMatch(/tonight/);
  });

  it('the day at the front says STUCK once a night has passed without it rendering', () => {
    // 18 Oct 2026, finding 20261018-phase-3-975: 2106 read "first in the night's redo
    // queue, so tonight" on eight consecutive mornings. A day that was first last night
    // and still has not rendered is not waiting, it is stuck, and the report must say so.
    const out = py(`
import json, time, render, watch
${RECEIPTS}
led = json.loads('''${LEDGER}''')
print(render.resubmit_due(2100, led, time.time() - 8 * 86400, {"verdict": "changes"}, {}))
`);
    expect(out).toMatch(/STILL has not rendered after 8 night/);
    expect(out).toMatch(/stuck, not waiting/);
    expect(out).not.toMatch(/so tonight/);
  });

  it('a waiting day that is not a redo keeps the plain reason', () => {
    const out = py(`
import json, render, watch
${RECEIPTS}
led = json.loads('''${LEDGER}''')
print(render.resubmit_due(2150, led, 0, {"verdict": "changes"}, {}))
`);
    expect(out).toBe('a clip of the day is still waiting to render');
  });

  it("the night plan's own note names the place and the nights", () => {
    const out = py(`
import json, watch
${RECEIPTS}
led = json.loads('''${LEDGER}''')
watch.gap_days = lambda *a, **k: set(); watch.start_day = lambda *a, **k: 2000
days, notes = watch.plan(led, 1, gaps=set(), free=100 * 10**9, start=2000)
print(json.dumps({"days": days, "waits": [n for n in notes if "waits for another night" in n]}))
`);
    const { days, waits } = JSON.parse(out);
    // One redo a night: 2100 renders first, the other two wait. The cap is
    // unchanged by this fix, and that is deliberate — it is Kevin's ruling.
    expect(days[0]).toBe(2100);
    expect(waits.length).toBe(2);
    expect(waits.join(' ')).toMatch(/day 2106 .*2 of 3 in the redo queue, about 1 night/);
    expect(waits.join(' ')).toMatch(/day 2112 .*3 of 3 in the redo queue, about 2 night/);
  });

  it('a day whose pull keeps failing goes behind, and its place says so', () => {
    // Kevin, 2 Oct 2026: with one redo a night, an older day whose footage will
    // not come down would otherwise hold a younger redo for ever.
    const out = py(`
import json, render, watch
${RECEIPTS}
led = json.loads('''${LEDGER}''')
led["a.insv"]["pull_failed"] = "2026-10-16T02:00:00"
print(json.dumps({str(d): render.redo_queue_place(d, led) for d in (2100, 2106)}))
`);
    const place = JSON.parse(out);
    expect(place['2106']).toEqual([1, 3]);
    expect(place['2100']).toEqual([3, 3]);
  });
});
