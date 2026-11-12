// Content Engine performance read (scripts/content-engine/performance.py): Kevin, 8 Sep 2026, "once a month, last
// 30 days... a performance read... three recommendations that become lessons". The Chen chain's measure step.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'scripts', 'content-engine');
const PERF = path.join(DIR, 'performance.py');

describe('content-engine performance read', () => {
  it('passes its own selftest (watch-page parsing, window, medians, weekly totals, the card, absence reporting)', () => {
    const out = execFileSync('python3', [PERF, 'selftest'], { encoding: 'utf8', timeout: 120000 });
    const last = out.trim().split('\n').pop();
    expect(JSON.parse(last).failed).toEqual([]);
  });

  it('reads public YouTube pages rather than yt-dlp per video (throttled after a few dozen calls on 8 Sep 2026)', () => {
    const p = readFileSync(PERF, 'utf8');
    expect(p).toContain('def fetch_watch(vid)');
    expect(p).toContain('def parse_watch_page(html)');
    expect(p).toContain('"--flat-playlist"'); // the listing is the only yt-dlp call, and it carries no counts
  });

  it('stores GoHighLevel totals weekly because the statistics API answers for seven days only, and sums the weeks in the window', () => {
    const p = readFileSync(PERF, 'utf8');
    expect(p).toContain('/social-media-posting/statistics?locationId=');
    expect(p).toContain('{"profileIds": [pid]}');
    expect(p).toContain('def weeks_in_window(snapshots, start, end)');
    expect(p).toContain('Fewer than four weeks stored');
  });

  it('writes views and likes onto the record fields that Engagements Total sums, matched by the YouTube link', () => {
    const p = readFileSync(PERF, 'utf8');
    expect(p).toContain('STAT_FIELDS = {"views": "👀 Views (YT)", "likes": "👍🏻 Likes (YT)"}');
    expect(p).toContain('FIND("%s", {YouTube Link})');
  });

  it('is one card through the same gate and submit as every other card, and approval turns the three recommendations into dated lessons', () => {
    const p = readFileSync(PERF, 'utf8');
    expect(p).toContain('approval.GATE, "create", "--force"');
    expect(p).toContain('approval.DISPATCH, "submit"');
    expect(p).toContain('d.append_lesson_to_file(AGENT_SLUG, line)');
    expect(p).toContain('d.mirror_lesson_to_register(REGISTER_ROW, line)');
    expect(p).toContain('if outcome in approval.APPROVED:');
  });

  it('is wired into the nightly run: verdict sync every night, snapshot on Mondays, the read on the 1st, none of them able to stop the lane', () => {
    const sh = readFileSync(path.join(ROOT, 'scripts', 'content-engine-run.sh'), 'utf8');
    expect(sh).toContain('performance.py sync || echo');
    expect(sh).toMatch(/date \+%u\)" = "1" \] && \{ python3 scripts\/content-engine\/performance\.py snapshot/);
    expect(sh).toMatch(/date \+%d\)" = "01" \] && \{ python3 scripts\/content-engine\/performance\.py run/);
  });
});

// The read's card closes itself once its lessons are written (finding 20261109-task-manager-1252). Two months
// running, sync() recorded the verdict, wrote the lessons and left the Tasks row at Today: September's needed a
// close card Kevin approved on 8 Oct, October's sat 7 days on the board. Drives the real sync() on fakes — no
// lesson file, no register row and no Airtable call is real.
describe('the performance read closes its own card', () => {
  function sync(stateJson, outcome, runResult = '(0, "{}")') {
    const py = `
import sys, json, io, contextlib, datetime as dt
sys.path.insert(0, ${JSON.stringify(DIR)})
import watch, approval, performance, render
watch._airtable = lambda *a, **k: {"fields": {approval.TF["outcome"]: ${outcome === null ? 'None' : JSON.stringify(outcome)},
                                              approval.TF["approvedAt"]: "2026-11-09T09:00:00Z",
                                              approval.TF["feedback"]: "not this month"}}
STATE = json.loads(${JSON.stringify(JSON.stringify(stateJson))})
performance.load_state = lambda: json.loads(json.dumps(STATE))
def _save(s): STATE.clear(); STATE.update(json.loads(json.dumps(s)))
performance.save_state = _save
lessons = []
class _D:
    def lesson_line(self, stamp, source, rec): return "[%s] %s: %s" % (stamp, source, rec)
    def append_lesson_to_file(self, slug, line): lessons.append((slug, line))
    def mirror_lesson_to_register(self, row, line): pass
performance._dispatch = lambda: _D()
calls = []
def run_(*a): calls.append(list(a)); return ${runResult}
out = io.StringIO()
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
    performance.sync(run=run_)
print(json.dumps({"state": STATE, "calls": calls, "out": out.getvalue(), "lessons": lessons}))
`;
    return JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8', timeout: 60000 }).trim());
  }
  const OPEN = { reads: { '2026-11-01': { task: 'recREADcard00001', recommendations: ['R1', 'R2', 'R3'] } } };

  it('approved: the lessons are written AND the card is completed with them as evidence', () => {
    const r = sync(OPEN, { name: 'Approved as-is' });
    expect(r.lessons.length).toBe(3);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].slice(0, 2)).toEqual(['complete', 'recREADcard00001']);
    expect(r.calls[0][3]).toContain('3 lesson(s) written');
    expect(r.state.reads['2026-11-01'].card_closed).toBeTruthy();
  });

  it('a refused close is said once, recorded, and the next run tries it again', () => {
    const first = sync(OPEN, { name: 'Approved as-is' }, '(1, "ERROR: refusing to complete: an open BLOCKER sits on it")');
    expect(first.state.reads['2026-11-01'].card_closed).toBeFalsy();
    expect(first.state.reads['2026-11-01'].card_close_refused).toContain('open BLOCKER');
    expect(first.out).toContain('ERROR: read 2026-11-01: card recREADcard00001 not closed');
    // Its verdict is set now, so it is no longer an "open read": the owed pass is what picks it up again.
    const again = sync(first.state, { name: 'Approved as-is' });
    expect(again.calls.map((c) => c[0])).toEqual(['complete']);
    expect(again.lessons.length).toBe(0);                 // the lessons are not written twice
    expect(again.state.reads['2026-11-01'].card_closed).toBeTruthy();
    expect(again.state.reads['2026-11-01'].card_close_refused).toBeUndefined();
  });

  it('a closed read is left alone, so nothing re-completes it every night', () => {
    const closed = { reads: { '2026-11-01': { task: 'recREADcard00001', verdict: 'approved', lessons_written: 3, card_closed: '2026-11-09T09:05:00' } } };
    const r = sync(closed, { name: 'Approved as-is' });
    expect(r.calls).toEqual([]);
    expect(r.out).toContain('no open reads');
  });

  it('rejected: his reason is kept and the card stays open, because complete refuses a non-approval', () => {
    const r = sync(OPEN, { name: 'Changes requested' });
    expect(r.calls).toEqual([]);
    expect(r.lessons).toEqual([]);
    expect(r.state.reads['2026-11-01'].feedback).toBe('not this month');
    expect(r.out).toContain('its card stays open');
  });

  it('still waiting: nothing is written and nothing is closed', () => {
    const r = sync(OPEN, null);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain('still waiting');
  });
});
