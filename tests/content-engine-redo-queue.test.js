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
// Every snippet starts with the night's redo-plan record pointed at an empty scratch path, so a test reads the
// record only when it writes one (PLAN_RECORD below). Without it render read the LIVE record in ~/.config/od, and
// once a real one inside 24 hours existed (20 Oct 2026) five of these tests failed on main.
const NO_LIVE_PLAN = `import os as _os, tempfile as _tf, watch as _watch
_watch.REDO_PLAN_FILE = _os.path.join(_tf.mkdtemp(prefix="ce-redo-plan-"), "none.json")
`;

function py(code) {
  return execFileSync('python3', ['-c', NO_LIVE_PLAN + code], {
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
  // ---- finding 20261020-phase-3-1004: one function was not one ANSWER ----
  //
  // plan() reads the queue at 02:00; the resubmit report reads it again hours later,
  // after the night's redo has rendered and LEFT the queue. On 20 Oct 2026 day 2113
  // was "2 of 6" in the plan's own note and "1 of 5 ... stuck, not waiting" in the
  // resubmit report of the same run. It was neither stuck nor first: it had waited
  // its turn and the queue HAD drained one that night. The night now records the
  // order it used and the report reads that record.

  // The plan's record, written as the night wrote it, in a scratch file.
  const PLAN_RECORD = `
import os, tempfile, watch
watch.REDO_PLAN_FILE = os.path.join(tempfile.mkdtemp(prefix="ce-redo-plan-"), "redo_plan.json")
watch.save_redo_plan([2100, 2106, 2112])
watch.gap_days = lambda *a, **k: set(); watch.start_day = lambda *a, **k: 2000
`;

  // 2100 took tonight's single slot and drained: it is rendered, so a live sort no
  // longer sees it in the queue at all.
  const DRAINED = `
led["a.insv"]["status"] = "rendered"; led["a.insv"].pop("reset", None)
`;

  it("keeps the night's own places after tonight's redo has drained", () => {
    const out = py(`
import json, render, watch
${RECEIPTS}
${PLAN_RECORD}
led = json.loads('''${LEDGER}''')
${DRAINED}
print(json.dumps({str(d): render.redo_queue_place(d, led) for d in (2106, 2112)}))
`);
    const place = JSON.parse(out);
    expect(place['2106']).toEqual([2, 3]);
    expect(place['2112']).toEqual([3, 3]);
  });

  it('the day behind tonight’s drained redo is waiting, not stuck', () => {
    const out = py(`
import json, time, render, watch
${RECEIPTS}
${PLAN_RECORD}
led = json.loads('''${LEDGER}''')
${DRAINED}
print(render.resubmit_due(2106, led, time.time() - 5 * 86400, {"verdict": "changes"}, {}))
`);
    expect(out).toMatch(/2 of 3 sent-back days/);
    expect(out).not.toMatch(/stuck, not waiting/);
  });

  it('BACK-TEST: with no recorded plan the same night reads it as stuck', () => {
    // The bug itself, reproduced by removing the only thing that fixes it. If this
    // ever stops saying "stuck", the two tests above have stopped proving anything.
    const out = py(`
import json, time, render, watch
${RECEIPTS}
watch.REDO_PLAN_FILE = "/nonexistent/redo_plan.json"
watch.gap_days = lambda *a, **k: set(); watch.start_day = lambda *a, **k: 2000
led = json.loads('''${LEDGER}''')
${DRAINED}
print(json.dumps({
  "place": render.redo_queue_place(2106, led),
  "why": render.resubmit_due(2106, led, time.time() - 5 * 86400, {"verdict": "changes"}, {}),
}))
`);
    const { place, why } = JSON.parse(out);
    expect(place).toEqual([1, 2]);
    expect(why).toMatch(/stuck, not waiting/);
  });

  it('a day sent back AFTER the plan ran goes to the back of the queue', () => {
    // It is not in the record, so it must still get a place rather than falling out
    // of the report altogether.
    const out = py(`
import json, os, render, watch
${RECEIPTS}
${PLAN_RECORD}
open(os.path.join(watch.RESUBMIT_DIR, "2150.md"), "w").write("receipt")
led = json.loads('''${LEDGER}''')
led["d.insv"]["reset"] = "sent back after the plan"
print(json.dumps(render.redo_queue_place(2150, led)))
`);
    expect(JSON.parse(out)).toEqual([4, 4]);
  });

  it('a stale record from a previous night is ignored', () => {
    const out = py(`
import datetime as dt, json, os, tempfile, render, watch
${RECEIPTS}
watch.REDO_PLAN_FILE = os.path.join(tempfile.mkdtemp(prefix="ce-redo-plan-"), "redo_plan.json")
watch.save_redo_plan([2112, 2106, 2100], now=dt.datetime.now() - dt.timedelta(days=4))
watch.gap_days = lambda *a, **k: set(); watch.start_day = lambda *a, **k: 2000
led = json.loads('''${LEDGER}''')
print(json.dumps({str(d): render.redo_queue_place(d, led) for d in (2100, 2112)}))
`);
    const place = JSON.parse(out);
    // Back to the live sort: oldest receipt first, so 2100 leads.
    expect(place['2100']).toEqual([1, 3]);
    expect(place['2112']).toEqual([3, 3]);
  });
});

// A clip the engine has refused and will not retry must say so, and say how long.
//
// Regression origin: finding 20261020-phase-3-1005, 20 Oct 2026. Day 2106 has two
// long recordings. The second is refused by the episode role as a duplicate and
// marked "not requeued: it needs a person" — and no person was told. The card sat
// 233 hours while every morning read "a clip of the day failed to render; it goes
// back once that is put right", which is a sentence about a render that is coming.
//
// The RULE for two long recordings on one day is Kevin's to make and is NOT decided
// here. What is fixed is that the stall is legible and dated instead of timeless.
describe('a refused clip that needs a person says so, and says for how long', () => {
  const LED_2106 = `{
    "ep.insv":    {"day": 2106, "episode": 2106, "role": "episode", "status": "rendered", "rendered": "2026-10-18T23:26:24"},
    "teaser.insv":{"day": 2106, "episode": 2106, "role": "teaser",  "status": "rendered", "rendered": "2026-10-18T23:39:18"},
    "dup.insv":   {"day": 2106, "episode": 2106, "role": "episode", "status": "failed",
                   "error": "a second long recording for episode 2106 (ep.insv is already its episode) and not a part of it: not rendered, so it cannot replace that episode",
                   "requeued": "not requeued: it needs a person"}
  }`;

  it('names the clip, the reason, the ruling it needs and the nights parked', () => {
    const out = py(`
import json, time, render
led = json.loads('''${LED_2106}''')
print(render.resubmit_due(2106, led, time.time() - 10 * 86400, {"verdict": "changes"}, {}))
`);
    expect(out).toMatch(/dup\.insv failed to render/);
    expect(out).toMatch(/second long recording for episode 2106/);
    expect(out).toMatch(/will NOT retry it/);
    expect(out).toMatch(/needs a ruling from Kevin/);
    expect(out).toMatch(/parked 10 night\(s\)/);
    // The timeless sentence is the bug.
    expect(out).not.toMatch(/it goes back once that is put right/);
  });

  it('a clip that WILL be retried keeps the plain wording', () => {
    // Control. If every failure read as "needs a ruling", the line would be noise
    // and an ordinary retry would be escalated to Kevin for nothing.
    const out = py(`
import json, time, render
led = json.loads('''${LED_2106}''')
del led["dup.insv"]["requeued"]
print(render.resubmit_due(2106, led, time.time() - 10 * 86400, {"verdict": "changes"}, {}))
`);
    expect(out).toMatch(/the card goes back once that is put right/);
    expect(out).not.toMatch(/needs a ruling from Kevin/);
  });

  it('with no failed clip at all the day moves on to the copy checks', () => {
    const out = py(`
import json, time, render
led = json.loads('''${LED_2106}''')
del led["dup.insv"]
print(render.resubmit_due(2106, led, 1760000000, {"verdict": "changes"}, {}))
`);
    expect(out).toMatch(/copy/);
    expect(out).not.toMatch(/failed to render/);
  });
});
