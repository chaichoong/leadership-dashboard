import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CE = resolve(ROOT, 'scripts/content-engine');

// 7 Oct 2026, Kevin: a sent-back episode is redone and put back to the FRONT of the queue, never at the cost of the
// new ones. From 7 Sep to 7 Oct nine send-backs took a median 55 h to reach YouTube, 44 h of it waiting for anyone to
// run redo-day, because no scheduled job ran it. Now the hourly sync queues it, the night renders it first, a redo
// whose clip the finder cannot find is blocked for the fixer lane, and an approved-with-edits card whose edit has a
// receipt gets `revise` so it can close.
//
// Everything here drives the real functions. The ledger, the approval state, the receipt folder, Airtable and
// agent-dispatch are all stubbed: a test must never touch the live engine. Every name and note is invented.
const J = (x) => `json.loads(${JSON.stringify(JSON.stringify(x))})`;

function py(body, state = {}) {
  const script = `
import sys, os, io, json, tempfile, contextlib, datetime as dt
sys.path.insert(0, ${JSON.stringify(CE)})
import render, content_report, watch, approval
saved = []
watch.save_ledger = lambda led: saved.append(json.loads(json.dumps(led)))
def _no_ledger(): raise AssertionError("the live ledger was read")
watch.load_ledger = _no_ledger
def _no_air(*a, **k): raise AssertionError("Airtable was called: %r" % (a[:2],))
watch._airtable = _no_air
STATE = ${J(state)}
approval.load_state = lambda: json.loads(json.dumps(STATE))
def _save(st): STATE.clear(); STATE.update(json.loads(json.dumps(st)))
approval.save_state = _save
root = tempfile.mkdtemp(); render.RESUBMIT_DIR = root
render.REDO_LFMD_FILE = os.path.join(root, "redo_lfmd"); render.HOLD_FILE = os.path.join(root, "hold")
calls, RUN = [], [(0, '{"blocked": "ok"}')]
def run(*a): calls.append(list(a)); return RUN[0]
reads = []
def live_ok(task): reads.append(task); return "Changes requested", STATE[[d for d, e in STATE.items() if e.get("task") == task][0]]["feedback"]
out, err = io.StringIO(), io.StringIO()
res = None; code = 0
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
    try:
${body.split('\n').map((l) => '        ' + l).join('\n')}
    except SystemExit as e:
        code = 1; err.write(str(e))
print(json.dumps({"res": res, "code": code, "out": out.getvalue(), "err": err.getvalue(), "saved": saved, "state": STATE,
                  "calls": calls, "reads": reads, "files": sorted(os.listdir(root))}, default=str))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

const NOTE = 'The learnings from my diary section is missing from this one, it starts near the end. You need to go back through it and put it in before this goes out.';
const BULLETS = '- Title is wrong.\n- The thumbnail shows the wrong place, it was the river path not the hill.\nThanks.';
const card = (extra = {}) => ({ task: 'recFAKEcard00001', verdict: 'changes', outcome: 'Changes requested', synced: '2026-10-07T08:30:00', feedback: NOTE, ...extra });
const LED = {
  'VID_FAKE_A.insv': { day: 2101, episode: 2101, role: 'episode', status: 'rendered', duration: 480.0, rendered: '2026-10-06T23:10:00' },
  'VID_FAKE_B.insv': { day: 2101, episode: 2101, role: 'teaser', status: 'rendered', duration: 40.0, rendered: '2026-10-06T23:20:00' },
  'VID_FAKE_C.insv': { day: 2102, episode: 2102, role: 'episode', status: 'rendered' },
};
const QUEUE = (ledger = LED, extra = '') => `res = render.queue_sent_back(ledger=${J(ledger)}, episodes={}, live=live_ok, run=run, running=False, last_night=dt.datetime(2000, 1, 1), now=dt.datetime(2026, 10, 7, 9, 15)${extra})`;

describe('night plan: the sent-back day renders first, never instead of a new one (watch.plan, 3 slots)', () => {
  const plan = (redos) => py(`
gb = 1024 ** 3
led = {"n%d" % d: {"day": d, "date": "2026-03-01", "seq": 1, "size": gb, "status": "new"} for d in (2110, 2111, 2112, 2113)}
for d in ${J(redos)}: led["r%d" % d] = {"day": d, "date": "2026-02-01", "seq": 1, "size": gb, "status": "new", "reset": "7 Oct 2026: sent back"}
days, notes = watch.plan(led, 3, gaps=set(), free=100 * gb, start=2054)
res = {"days": days, "notes": notes}`);

  it('no redo waiting: three new days', () => {
    expect(plan([]).res.days).toEqual([2110, 2111, 2112]);
  });

  it('one redo waiting: the redo FIRST, then two new days', () => {
    const r = plan([2101]).res;
    expect(r.days).toEqual([2101, 2110, 2111]);
    expect(r.notes.join('\n')).toContain('redo: day 2101 (sent back) renders first');
  });

  it('two redos waiting: one a night, the oldest first; the other takes the next night; still two new days', () => {
    const r = plan([2101, 2103]).res;
    expect(r.days).toEqual([2101, 2110, 2111]);
    expect(r.days.filter((d) => d >= 2110).length).toBe(2);
    expect(r.notes.join('\n')).toContain('redo: day 2103 (sent back) waits for another night: one redo a night');
  });

  it('one redo a night at any slot count: at four slots, one redo and three new days', () => {
    const r = py(`
gb = 1024 ** 3
led = {"n%d" % d: {"day": d, "date": "2026-03-01", "seq": 1, "size": gb, "status": "new"} for d in (2110, 2111, 2112, 2113)}
for d in (2101, 2103): led["r%d" % d] = {"day": d, "date": "2026-02-01", "seq": 1, "size": gb, "status": "new", "reset": "x"}
res = watch.plan(led, 4, gaps=set(), free=100 * gb, start=2054)[0]`);
    expect(r.res).toEqual([2101, 2110, 2111, 2112]);
  });

  it('nothing new waiting: a slot no new day fills goes to a waiting redo, since it costs no new episode', () => {
    const r = py(`
gb = 1024 ** 3
led = {"r%d" % d: {"day": d, "date": "2026-02-01", "seq": 1, "size": gb, "status": "new", "reset": "x"} for d in (2101, 2103)}
res = watch.plan(led, 3, gaps=set(), free=100 * gb, start=2054)[0]`);
    expect(r.res).toEqual([2101, 2103]);
  });

  it('the next night the second redo goes first', () => {
    const r = py(`
gb = 1024 ** 3
led = {"n%d" % d: {"day": d, "date": "2026-03-01", "seq": 1, "size": gb, "status": "new"} for d in (2112, 2113)}
led["r1"] = {"day": 2101, "date": "2026-02-01", "seq": 1, "size": gb, "status": "rendered", "reset": "x"}
led["r2"] = {"day": 2103, "date": "2026-02-03", "seq": 1, "size": gb, "status": "new", "reset": "x"}
res = watch.plan(led, 3, gaps=set(), free=100 * gb, start=2054)[0]`);
    expect(r.res).toEqual([2103, 2112, 2113]);
  });

  it('the copy and card steps take as many days as the plan holds, so the redo is never the one left without copy', () => {
    const sh = readFileSync(resolve(ROOT, 'scripts/content-engine-run.sh'), 'utf8');
    expect(sh).toContain('COPY_LIMIT=$(echo $DAYS | wc -w');
    expect(sh).toContain('approval.py run --pending --limit "$COPY_LIMIT"');
  });
});

describe('the hourly sync queues a sent-back card itself, within the hour', () => {
  it('queues the day: every clip back to new with a dated note, the receipt parked with one line per point', () => {
    const r = py(QUEUE(), { 2101: card() });
    expect(r.code).toBe(0);
    expect(r.res.queued).toEqual([2101]);
    const led = r.saved.at(-1);
    expect(led['VID_FAKE_A.insv'].status).toBe('new');
    expect(led['VID_FAKE_B.insv'].status).toBe('new');
    expect(led['VID_FAKE_A.insv'].reset).toMatch(/^7 Oct 2026: Kevin sent it back: The learnings from my diary/);
    expect(led['VID_FAKE_C.insv'].status).toBe('rendered');      // another day is never touched
    expect(r.files).toContain('2101.md');
    expect(r.state['2101'].redo_queued).toBe('2026-10-07T09:15:00');
    expect(r.reads).toEqual(['recFAKEcard00001']);              // the card was read live before anything was written
  });

  it('the receipt answers both points: the Learnings one from its words, the pronoun one "rebuilt to this note" (never refused)', () => {
    const r = py(QUEUE() + `\nres = open(os.path.join(root, "2101.md")).read()`, { 2101: card() });
    const lines = r.res.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^- The learnings from my diary section is missing.* → the episode is re-rendered at the front of the night's queue and its Learnings from my diary clip is found again/);
    expect(lines[1]).toMatch(/^- You need to go back through it and put it in before this goes out\. → rebuilt to this note: /);
  });

  it('bullets and short lines: every word of his note has a line, and the gate counts no more points than there are lines', () => {
    const r = py(`
res = {"receipt": render.sent_back_receipt(${J(BULLETS)}), "gate": len(render.feedback_points(${J(BULLETS)}))}
res["lines"] = len(render.receipt_lines(res["receipt"]))`);
    expect(r.res.receipt).toContain('Title is wrong.');
    expect(r.res.receipt).toContain('Thanks.');
    expect(r.res.receipt).not.toMatch(/^- - /m);                 // the bullet mark is not repeated
    expect(r.res.lines).toBeGreaterThanOrEqual(Math.max(1, r.res.gate));
    expect(r.res.receipt).toMatch(/→ rebuilt to this note: /);
  });

  it('a note with no sentence long enough to be a point still gets its one line', () => {
    const r = py(QUEUE(), { 2101: card({ feedback: 'Wrong title.' }) });
    expect(r.res.queued).toEqual([2101]);
  });

  it('idempotent: a second hourly run queues nothing twice, writes nothing and reads no card', () => {
    const r = py(QUEUE() + `
first = res; saved_n = len(saved); reads_n = len(reads)
` + QUEUE().replace(`ledger=${J(LED)}`, 'ledger=saved[-1]') + `
res = {"first": first, "second": res, "saves": [saved_n, len(saved)], "reads": [reads_n, len(reads)]}`, { 2101: card() });
    expect(r.res.first.queued).toEqual([2101]);
    expect(r.res.second.queued).toEqual([]);
    expect(r.res.second.waiting['2101']).toContain('a receipt waits');
    expect(r.res.saves[1]).toBe(r.res.saves[0]);
    expect(r.res.reads[1]).toBe(r.res.reads[0]);
    expect(r.files.filter((f) => f.startsWith('2101.md'))).toEqual(['2101.md']);
  });

  it('a day on the Learnings rebuild list is already in motion: not queued over it', () => {
    const r = py(`open(render.REDO_LFMD_FILE, "w").write("2101 @300.0-420.0 hand window\\n")\n` + QUEUE(), { 2101: card() });
    expect(r.res.queued).toEqual([]);
    expect(r.res.waiting['2101']).toContain('Learnings rebuild list');
    expect(r.saved).toEqual([]);
  });

  it('REVIEW blank feedback: not queued (nothing to answer), and the reason is recorded for the stuck pass', () => {
    const r = py(QUEUE(), { 2101: card({ feedback: '   ' }) });
    expect(r.res.queued).toEqual([]);
    expect(r.res.notQueued['2101']).toContain('no note');
    expect(r.state['2101'].redo_not_queued.for).toBe('2026-10-07T08:30:00');
    expect(r.saved).toEqual([]);
    expect(r.files).toEqual([]);
  });

  it('REVIEW a day already rendering while a render runs: waits, writes nothing, queued on the next run', () => {
    const led = { ...LED, 'VID_FAKE_A.insv': { ...LED['VID_FAKE_A.insv'], status: 'rendering' } };
    const busy = py(QUEUE(led).replace('running=False', 'running=True'), { 2101: card() });
    expect(busy.res.queued).toEqual([]);
    expect(busy.res.waiting['2101']).toContain('mid-render');
    expect(busy.saved).toEqual([]);
    expect(busy.reads).toEqual([]);
    const orphan = py(QUEUE(led), { 2101: card() });           // no render running: an orphan, reset and queued
    expect(orphan.res.queued).toEqual([2101]);
  });

  it('REVIEW a verdict older than the last render: still queued, so the card goes back with a receipt', () => {
    const led = { ...LED, 'VID_FAKE_A.insv': { ...LED['VID_FAKE_A.insv'], rendered: '2026-10-07T01:00:00' } };
    const r = py(QUEUE(led), { 2101: card({ synced: '2026-10-06T12:00:00' }) });
    expect(r.res.queued).toEqual([2101]);
    expect(r.files).toContain('2101.md');
  });

  it("REVIEW the engine's record is older than the card (resubmitted by hand): not queued, the stale verdict cleared for the sync", () => {
    const r = py(QUEUE().replace('live=live_ok', 'live=lambda t: ("", "")'), { 2101: card() });
    expect(r.res.queued).toEqual([]);
    expect(r.state['2101'].verdict).toBeUndefined();
    expect(r.state['2101'].task).toBe('recFAKEcard00001');
    expect(r.saved).toEqual([]);
  });

  it('a new note on the live card is read afresh by the next sync, never answered with the old one', () => {
    const r = py(QUEUE().replace('live=live_ok', 'live=lambda t: ("Changes requested", "A different note entirely, about the thumbnail colours.")'), { 2101: card() });
    expect(r.res.queued).toEqual([]);
    expect(r.state['2101'].verdict).toBeUndefined();
    expect(r.files).toEqual([]);
  });

  it('REVIEW a card whose day id cannot be parsed is skipped and said, and the others still run', () => {
    const r = py(QUEUE(), { 'not-a-day': card({ task: 'recFAKEcard00009' }), 2101: card() });
    expect(r.code).toBe(0);
    expect(r.out).toContain("'not-a-day' is not a day number");
    expect(r.res.queued).toEqual([2101]);
  });

  it('the card cannot be read: NOT CHECKED, not queued, recorded', () => {
    const r = py(QUEUE().replace('live=live_ok', 'live=lambda t: (_ for _ in ()).throw(OSError("timed out"))'), { 2101: card() });
    expect(r.res.notQueued['2101']).toContain('NOT CHECKED');
    expect(r.saved).toEqual([]);
  });

  it('a Learnings clip placed by hand is never thrown away by a full re-render', () => {
    const led = { ...LED, 'VID_FAKE_A.insv': { ...LED['VID_FAKE_A.insv'], lfmd_window: [300, 420], lfmd_window_by: 'operator' } };
    const r = py(QUEUE(led), { 2101: card() });
    expect(r.res.notQueued['2101']).toContain('placed by hand');
    expect(r.saved).toEqual([]);
  });

  it('REVIEW a day the night plan would never render (older than the takeover day, paused gap day): not queued, said at once', () => {
    const r = py(QUEUE(LED, ', reach=lambda led: {2102}'), { 2101: card() });
    expect(r.res.queued).toEqual([]);
    expect(r.res.notQueued['2101']).toContain('the night plan would never render recording day(s) 2101');
    expect(r.state['2101'].redo_not_queued.why).toContain('render.py redo --day 2101');
    expect(r.saved).toEqual([]);
    expect(r.reads).toEqual([]);
  });

  it('CONTROL: the default reach is the real night plan, so a day it can render is queued', () => {
    const r = py(QUEUE(LED, ', reach=lambda led: set(watch.plan(led, 10 ** 6, gaps=set(), free=10 ** 15, start=2054)[0])'), { 2101: card() });
    expect(r.res.queued).toEqual([2101]);
  });

  it('REVIEW one card that fails in an unexpected way never stops the next one', () => {
    const r = py(`
real_redo = render.redo_day
def flaky(day, *a, **k):
    if day == 2101: raise RuntimeError("disk full")
    return real_redo(day, *a, **k)
render.redo_day = flaky
` + QUEUE(), { 2101: card(), 2102: card({ task: 'recFAKEcard00003' }) });
    expect(r.code).toBe(0);
    expect(r.res.notQueued['2101']).toContain('disk full');
    expect(r.res.queued).toEqual([2102]);
  });

  it("REVIEW the show's name is not a Learnings point: a title note gets the re-render answer", () => {
    const r = py(`res = render.sent_back_receipt("The title should say Diary of a Runpreneur day 2101, not the name of the route.")`);
    expect(r.res).toMatch(/→ rebuilt to this note: /);
    expect(r.res).not.toContain('Learnings from my diary clip');
    const c = py(`res = render.sent_back_receipt("The learnings from my diary bit at the end is cut off too early.")`);
    expect(c.res).toContain('Learnings from my diary clip is found again');
  });

  it('REVIEW a note that is only a date stamp is no note: not queued, with that reason', () => {
    const r = py(QUEUE(), { 2101: card({ feedback: '[2026-10-07 08:29]\n' }) });
    expect(r.res.notQueued['2101']).toContain('no note');
    expect(r.saved).toEqual([]);
  });

  it('already on YouTube: not queued, said', () => {
    const r = py(QUEUE().replace('episodes={}', 'episodes={"2101": {"youtube_link": "https://youtu.be/fake"}}'), { 2101: card() });
    expect(r.res.notQueued['2101']).toContain('already on YouTube');
  });
});

describe('a redo whose clip the finder cannot find is blocked for the fixer lane, not left for a person', () => {
  it('no clip of the day in the ledger: a TOOL wall on clip-finder naming what it looked for, once', () => {
    const r = py(QUEUE({ 'VID_FAKE_C.insv': LED['VID_FAKE_C.insv'] }) + `
first = res; n = len(calls)
` + `res = render.queue_sent_back(ledger={"VID_FAKE_C.insv": {"day": 2102, "episode": 2102, "role": "episode", "status": "rendered"}}, episodes={}, live=live_ok, run=run, running=False, last_night=dt.datetime(2000, 1, 1), now=dt.datetime(2026, 10, 7, 10, 15))
res = {"first": first, "second": res, "callsAfterFirst": n}`, { 2101: card() });
    expect(r.code).toBe(0);
    expect(r.calls.length).toBe(1);
    const [cmd, task, ...rest] = r.calls[0];
    expect([cmd, task]).toEqual(['block', 'recFAKEcard00001']);
    expect(rest.slice(0, 4)).toEqual(['--kind', 'TOOL', '--subject', 'clip-finder']);
    expect(rest[5]).toContain('Looked in the render ledger for the clips of day 2101');
    expect(r.state['2101'].redo_blocked.for).toBe('2026-10-07T08:30:00');
    expect(r.res.second.waiting['2101']).toContain('blocked for the fixer lane');
    expect(r.res.callsAfterFirst).toBe(1);                       // the second hour does not write the wall again
    expect(r.files).toEqual([]);
  });

  const RESUBMIT = (lfmd, receiptPy) => `
led = {"VID_FAKE_A.insv": {"day": 2101, "episode": 2101, "role": "episode", "status": "rendered", "rendered": "2099-01-01T00:00:00", "lfmd_window": ${lfmd}},
       "VID_FAKE_B.insv": {"day": 2101, "episode": 2101, "role": "teaser", "status": "rendered", "rendered": "2099-01-01T00:10:00"}}
watch.load_ledger = lambda: led
open(os.path.join(root, "2101.md"), "w").write(${receiptPy})
approval.bundle = lambda day: {"Long Form Video": {"fields": {"YouTube Copy": "copy", "AI Last Run": "2099-01-01T02:00:00Z"}}}
refreshed = []
approval.refresh_card = lambda day, receipt=None: refreshed.append([day, open(receipt).read()])
render.dispatch_run = run
res = {"sent": render.resubmit_ready(), "refreshed": refreshed}
res["sentFile"] = open(os.path.join(root, "2101.md.sent")).read() if os.path.exists(os.path.join(root, "2101.md.sent")) else None`;
  const AUTO = `render.sent_back_receipt(${J(NOTE)})`;

  it("the re-render found no Learnings section: blocked, the receipt set aside, the card NOT sent back telling him it is fixed", () => {
    const r = py(RESUBMIT('None', AUTO), { 2101: card() });
    expect(r.code).toBe(0);
    expect(r.res.sent).toEqual([]);
    expect(r.res.refreshed).toEqual([]);
    expect(r.calls[0].slice(0, 6)).toEqual(['block', 'recFAKEcard00001', '--kind', 'TOOL', '--subject', 'clip-finder']);
    expect(r.calls[0][7]).toContain("looked through the episode's captions for the spoken 'learnings from my diary' line");
    expect(r.files.some((f) => f.startsWith('2101.md.blocked-'))).toBe(true);
    expect(r.files).not.toContain('2101.md');
    expect(r.state['2101'].redo_blocked.code).toBeTruthy();
  });

  it('CONTROL: the re-render found it, so the card goes back, its receipt saying where the clip now runs', () => {
    const r = py(RESUBMIT('[300.0, 420.0]', AUTO), { 2101: card({ redo_lfmd_before: { window: null } }) });
    expect(r.res.sent).toEqual([2101]);
    expect(r.calls).toEqual([]);
    expect(r.files).toContain('2101.md.sent');
    expect(r.res.refreshed[0][1]).toContain('its Learnings from my diary clip now runs from 5:00 to 7:00 (there was none before)');
    expect(r.res.sentFile).toBe(r.res.refreshed[0][1]);         // the record holds exactly what he was sent
  });

  it('REVIEW the re-render found the SAME section he sent back: the receipt says so, never "found again"', () => {
    const r = py(RESUBMIT('[300.0, 420.0]', AUTO), { 2101: card({ redo_lfmd_before: { window: [300.0, 420.0] } }) });
    expect(r.res.refreshed[0][1]).toContain('now runs from 5:00 to 7:00 (the same section as before)');
    expect(r.res.refreshed[0][1]).not.toContain('found again');
  });

  it('REVIEW a card walled earlier is unblocked with what the re-render saw before it goes back (submit refuses a walled card)', () => {
    const r = py(RESUBMIT('[300.0, 420.0]', AUTO), { 2101: card({ redo_blocked: { for: '2026-10-07T08:30:00', why: 'x', code: 'c' } }) });
    expect(r.calls.map((c) => c.slice(0, 3))).toEqual([['unblock', 'recFAKEcard00001', '--evidence']]);
    expect(r.calls[0][3]).toContain('found its Learnings section at 300.0 to 420.0 s');
    expect(r.res.sent).toEqual([2101]);
    expect(r.state['2101'].redo_blocked).toBeUndefined();
  });

  it('a wall that will not lift: the card is NOT sent, the receipt stays for the next night', () => {
    const r = py('RUN[0] = (1, "ERROR: HTTP 503")\n' + RESUBMIT('[300.0, 420.0]', AUTO), { 2101: card({ redo_blocked: { for: '2026-10-07T08:30:00', why: 'x', code: 'c' } }) });
    expect(r.res.sent).toEqual([]);
    expect(r.res.refreshed).toEqual([]);
    expect(r.files).toContain('2101.md');
    expect(r.out).toContain('still blocked, NOT sent back');
  });

  it("CONTROL: a person's own receipt is theirs; the check never blocks it", () => {
    const r = py(RESUBMIT('None', JSON.stringify('- The learnings clip is missing from this one, please. → hand-checked: there is no diary section in this recording\n')), { 2101: card() });
    expect(r.res.sent).toEqual([2101]);
    expect(r.calls).toEqual([]);
  });

  it('a blocked day waits for the finder to change, then the sync queues it again', () => {
    const blocked = { redo_blocked: { for: '2026-10-07T08:30:00', why: 'x', code: 'oldcode00001' } };
    const same = py(QUEUE(LED, ', code="oldcode00001"'), { 2101: card(blocked) });
    expect(same.res.queued).toEqual([]);
    expect(same.res.waiting['2101']).toContain('until the clip finder changes');
    const changed = py(QUEUE(LED, ', code="newcode00002"'), { 2101: card(blocked) });
    expect(changed.res.queued).toEqual([2101]);
    expect(changed.state['2101'].redo_blocked.code).toBe('oldcode00001');   // the wall stays on the card until it goes back
  });

  it('the fingerprint moves with the clip finder, not with any edit to render.py', () => {
    const r = py(`
import importlib.util, shutil
def code_of(edit):
    d = tempfile.mkdtemp(); p = os.path.join(d, "render.py"); src = open(render.__file__).read()
    open(p, "w").write(edit(src))
    spec = importlib.util.spec_from_file_location("render_copy", p); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m.finder_code()
res = {"same": code_of(lambda s: s), "outside": code_of(lambda s: s.replace("MIN_TRANSCRIPT_CHARS = 50", "MIN_TRANSCRIPT_CHARS = 51")),
       "inside": code_of(lambda s: s.replace("def lfmd_window(segments, min_len=20.0, max_len=180.0):", "def lfmd_window(segments, min_len=21.0, max_len=180.0):")),
       "now": render.finder_code()}`);
    expect(r.res.same).toBe(r.res.now);
    expect(r.res.outside).toBe(r.res.now);
    expect(r.res.inside).not.toBe(r.res.now);
  });

  it('REVIEW a hung dispatcher is a failed call, never an exception that ends the loop', () => {
    const r = py(`
import subprocess
def hang(*a, **k): raise subprocess.TimeoutExpired(cmd="agent-dispatch.py", timeout=300)
render.subprocess.run = hang
res = render.dispatch_run("block", "recFAKEcard00001")`);
    expect(r.code).toBe(0);
    expect(r.res[0]).toBe(1);
    expect(r.res[1]).toContain('agent-dispatch did not run');
  });

  it('the Learnings rebuild on a walled card lifts the wall with what it built, then sends the card back', () => {
    const r = py(`
tmp = tempfile.mkdtemp(); clip = os.path.join(tmp, 'c.insv'); open(clip, 'w').write('x')
led = {"c.insv": {"episode": 2101, "role": "episode", "status": "rendered", "local": clip, "date": "2026-02-02", "drive_id": "d"}}
watch.load_ledger = lambda: led
srt = os.path.join(tmp, 's.srt'); open(srt, 'w').write("1\\n00:00:00,000 --> 00:00:05,000\\nSo the learnings from my diary today are that\\n\\n2\\n00:00:30,000 --> 00:00:40,000\\nsee you tomorrow\\n")
render.transcribe = lambda c, w: ("text", srt)
render.render_masters = lambda *a, **k: {}
render.title_from_transcript = lambda t: "t"
render.build_outputs = lambda *a, **k: {"lfmd": "l", "lfmd_yt": "y", "lfmd_srt": "s"}
render.publish_to_drive = lambda *a, **k: ("f", {"lfmd": "L", "lfmd_yt": "Y", "lfmd_srt": "S"})
render.find_or_create_record = lambda *a, **k: ("rec1", "found")
watch._airtable = lambda *a, **k: {}
render.release_hold = lambda d: None
render.dispatch_run = run
refreshed = []
approval.refresh_card = lambda day, receipt=None: refreshed.append(open(receipt).read())
render.redo_lfmd(2101)
res = refreshed`, { 2101: card({ redo_blocked: { for: '2026-10-07T08:30:00', why: 'x', code: 'c' } }) });
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => c[0])).toEqual(['unblock']);
    expect(r.calls[0][3]).toContain('was rebuilt from 0.0 to 40.0 s (found by the detector)');
    expect(r.res.length).toBe(1);
    expect(r.res[0].trim().split('\n').length).toBe(2);
  });

  it('a block that cannot be written is said and recorded, never read as blocked', () => {
    const r = py('RUN[0] = (1, "ERROR: findings.py add failed")\n' + QUEUE({}), { 2101: card() });
    expect(r.out).toContain('NOT blocked for the fixer lane');
    expect(r.state['2101'].redo_blocked).toBeUndefined();
    expect(r.state['2101'].redo_not_queued.why).toContain('TOOL wall could not be written');
  });
});

describe("the Learnings rebuild answers every point, so a pronoun never leaves the card for a person", () => {
  it('two points, the second with no Learnings word: both answered, the second says nothing else changed', () => {
    const r = py(`res = render.lfmd_receipt(${J(NOTE)}, (327.56, 456.76))`);
    const lines = r.res.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('→ the Learnings from my diary clip is rebuilt from 5:27 to 7:36');
    expect(lines[1]).toMatch(/→ rebuilt to this note: the Learnings from my diary clip is rebuilt from 5:27 to 7:36; nothing else on the episode changed$/);
  });
});

describe('the stuck pass reports what the sync could not queue, at once', () => {
  const stuck = (a, now = '2026, 10, 7, 9, 45') => py(`res = content_report.stuck_sent_back(now=dt.datetime(${now}), approvals=${J(a)}, ledger=${J(LED)}, episodes={}, redo_days=set(), receipts={}, reachable=set(), last_night=dt.datetime(2026, 10, 7, 7, 0), running=False)`);

  it('not queued an hour ago: listed now with the sync\'s reason', () => {
    const r = stuck({ 2101: card({ redo_not_queued: { for: '2026-10-07T08:30:00', why: 'sent back with no note, so a re-render has nothing to answer' } }) });
    expect(r.res.map((x) => x.day)).toEqual([2101]);
    expect(r.res[0].why).toBe('the hourly sync could not queue it: sent back with no note, so a re-render has nothing to answer');
  });

  it('blocked for the fixer lane: listed with the wall', () => {
    const r = stuck({ 2101: card({ redo_blocked: { for: '2026-10-07T08:30:00', why: 'the finder found none', code: 'c' } }) });
    expect(r.res[0].why).toBe('blocked for the fixer lane (TOOL clip-finder): the finder found none');
  });

  it('REVIEW a key that is not a day is passed over; the pass still reports the rest', () => {
    const r = stuck({ 'not-a-day': card(), 2101: card({ redo_not_queued: { for: '2026-10-07T08:30:00', why: 'no note' } }) });
    expect(r.code).toBe(0);
    expect(r.res.map((x) => x.day)).toEqual([2101]);
  });

  it('CONTROL: a reason recorded for an older verdict does not count; under 24 hours it still waits', () => {
    const r = stuck({ 2101: card({ redo_not_queued: { for: '2026-10-01T08:00:00', why: 'old' } }) });
    expect(r.res).toEqual([]);
  });
});

describe('approved with edits: the edit is recorded once a receipt says it was made, so the card can close', () => {
  const APPROVED = { task: 'recFAKEcard00002', verdict: 'approved', outcome: 'Approved with minor edits', synced: '2026-10-05T12:16:00', feedback: 'All fine, but there should be a summary clip for this day as well. It may have been recorded the next morning.' };
  const OUTPUT = 'Publish Episode 2103 of the diary: the full episode to YouTube.\n\nWhere it goes if you approve: everywhere.\n\n**Carrying this out will involve:** publishing the episode and its clips.';
  const REVISE = (receipt, notes = '', pub = '{"2103": {"card_close_refused": {"since": "2026-10-06T13:16:44Z", "why": "WITH EDITS"}}}') => `
${receipt === null ? '' : `open(os.path.join(root, "2103.md"), "w").write(${JSON.stringify(receipt)})`}
written = []
def run_(*a):
    calls.append(list(a))
    if a[0] == "revise": written.append(open(a[3]).read())
    return RUN[0]
fields = {approval.TF["outcome"]: {"name": "Approved with minor edits"}, approval.TF["agentOutput"]: ${JSON.stringify(OUTPUT)}, approval.TF["notes"]: ${JSON.stringify(notes)}}
res = {"done": approval.revise_minor_edits(root=root, episodes=${pub}, read=lambda t: fields, run=run_, now=dt.datetime(2026, 10, 7, 9, 15)), "written": written}`;
  const RECEIPT = '- All fine, but there should be a summary clip for this day as well. → found: the next-morning clip is this day\'s summary; it went out with the episode\n- It may have been recorded the next morning. → it was, at 15:54 the next day\n';

  it('runs revise with the text he approved, the receipt lines added before the closing line, and closes the receipt', () => {
    const r = py(REVISE(RECEIPT), { 2103: APPROVED });
    expect(r.code).toBe(0);
    expect(r.res.done).toEqual([2103]);
    expect(r.calls[0].slice(0, 3)).toEqual(['revise', 'recFAKEcard00002', '--output-file']);
    const text = r.res.written[0];
    expect(text.startsWith('Publish Episode 2103 of the diary')).toBe(true);
    expect(text).toContain('Your edits, acted on (7 Oct 2026):\n- All fine, but there should be a summary clip');
    expect(text.trim().split('\n').at(-1)).toBe('**Carrying this out will involve:** publishing the episode and its clips.');
    expect(r.files).toEqual(['2103.md.sent']);
  });

  it('no receipt: nothing guessed, nothing run, the open card is said', () => {
    const r = py(REVISE(null), { 2103: APPROVED });
    expect(r.res.done).toEqual([]);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain('stays open until a receipt of what was done is written');
  });

  it('a receipt that misses one of his points is refused', () => {
    const r = py(REVISE(RECEIPT.split('\n')[0] + '\n'), { 2103: APPROVED });
    expect(r.calls).toEqual([]);
    expect(r.out).toContain('answers 1 point(s) but Kevin made 2');
  });

  it('already revised (the EDITS APPLIED mark is on the card): not run twice', () => {
    const r = py(REVISE(RECEIPT, '[06 Oct 2026 14:00 — agent] EDITS APPLIED: done'), { 2103: APPROVED });
    expect(r.calls).toEqual([]);
    expect(r.files).toEqual(['2103.md.sent']);
  });

  it('a refused revise is said, and the same receipt is not retried every hour', () => {
    const r = py('RUN[0] = (1, "ERROR: refusing to revise")\n' + REVISE(RECEIPT) + `
first = res
res = {"first": first, "second": approval.revise_minor_edits(root=root, episodes={"2103": {}}, read=lambda t: fields, run=run_)}`, { 2103: APPROVED });
    expect(r.calls.length).toBe(1);
    expect(r.state['2103'].revise_refused.why).toContain('refusing to revise');
    expect(r.files).toEqual(['2103.md']);
  });

  it('a card already closed, or approved as-is, is never touched', () => {
    const closed = py(REVISE(RECEIPT, '', '{"2103": {"card_closed": "2026-10-07T08:00:00Z"}}'), { 2103: APPROVED });
    expect(closed.calls).toEqual([]);
    const asIs = py(REVISE(RECEIPT), { 2103: { ...APPROVED, outcome: 'Approved as-is' } });
    expect(asIs.calls).toEqual([]);
  });
});

describe('wiring: the sync does both after reading the verdicts, and a failure there never ends the job', () => {
  it('approval.sync runs the queue and the edits record, and survives either raising', () => {
    const r = py(`
ran = []
def boom(): ran.append("queue"); raise RuntimeError("ledger unreadable")
render.queue_sent_back = boom
approval.revise_minor_edits = lambda: ran.append("edits")
approval.sync()
res = ran`, {});
    expect(r.code).toBe(0);
    expect(r.res).toEqual(['queue', 'edits']);
    expect(r.out).toContain('ERROR: approval sync: queue_sent_back did not finish this run (ledger unreadable)');
  });

  it('hourly, the sync runs before the card close, so a recorded edit closes its card the same hour', () => {
    const sh = readFileSync(resolve(ROOT, 'scripts/content-engine-publish.sh'), 'utf8');
    expect(sh.indexOf('approval.py sync')).toBeGreaterThan(-1);
    expect(sh.indexOf('approval.py sync')).toBeLessThan(sh.indexOf('publish.py close-cards'));
    expect(sh).not.toContain('render.py');                       // the hourly job still renders nothing
  });
});
