import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// SCHEDULED, NOT STUCK (18 Nov 2026). The Operations Manager's register score read "101 stuck
// (target 0)". 44 of the 101 were tasks stored at Upcoming with their due date still ahead: month-end
// stepping stones from the strategy sessions, Kevin's standing holds and the Operations Director work
// parked to January. Nothing was wrong with any of them. The dispatcher takes such a task only on its
// date, loop-health and the AI team panel call it scheduled, and the clock in task-manager.py itself
// never touches it (parked_on_purpose). Only the board's classify() called it stuck, unless Kevin's
// own "Parked until" note was on it, so the foreman wrote `leave` on each one three times a day
// (44 of the 82 leaves in the 17:00 run) and the score could never fall.
//
// These tests drive the real task_view, classify, parked_on_purpose, ownerless_views and cmd_board.
// Every name, date and id below is invented.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TM = resolve(ROOT, 'scripts/task-manager.py');
const SKILL = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/task-manager-board/SKILL.md'), 'utf8');
const AGENT = 'recAGENTxxxxxxxx1';

function py(body) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, urllib.request
from datetime import datetime, timezone, timedelta
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(TM)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def rec(i, f): return {"id": i, "fields": dict({"Task Name": i, "Created Time": "2026-10-01T09:00:00.000Z",
                                                 "Status": "Upcoming", "Team Member": ["${AGENT}"]}, **f)}
${body}
`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json') } });
  return JSON.parse(out.trim().split('\n').pop());
}

// The live shapes of 18 Nov 2026 (invented names), each with the bucket it must land in.
const FIXTURES = `
now = datetime(2026, 11, 18, 19, 0, tzinfo=timezone.utc)
recs = {
  "stepStone":  rec("recSTEPSTONExxxx1", {"Task Name": "Gas checks, November: 1 Example Road", "Due Date": "2026-11-30"}),
  "january":    rec("recJANUARYxxxxxx1", {"Task Name": "Sales call to money", "Due Date": "2027-01-04", "Team Member": None,
                                          "Assignee": {"email": "someone@example.com"}}),
  "dueToday":   rec("recDUETODAYxxxxx1", {"Due Date": "2026-11-18"}),
  "overdue":    rec("recOVERDUExxxxxx1", {"Status": "Today", "Due Date": "2026-11-03"}),
  "noDate":     rec("recNODATExxxxxxx1", {}),
  "todayAhead": rec("recTODAYAHEADxxx1", {"Status": "Today", "Due Date": "2026-12-18"}),
  "legacyApv":  rec("recLEGACYAPVxxxx1", {"Status": "Approval", "Due Date": "2027-01-17"}),
  "someDay":    rec("recSOMEDAYxxxxxx1", {"Some Day": True}),
  "hisAnswer":  rec("recHISANSWERxxxx1", {"Due Date": "2026-12-01", "Notes":
                    "[02 Nov 2026 — agent-dispatch] Parked until 2026-12-01 on Kevin's answer; it comes back on the board that day."}),
}
`;

describe('a task stored at Upcoming with its date ahead is scheduled, never stuck', () => {
  it('each live shape lands in its bucket', () => {
    const r = py(`${FIXTURES}
print(json.dumps({k: m.task_view(v, set(), set(), now)[0] for k, v in recs.items()}))`);
    expect(r).toEqual({
      stepStone: 'scheduled',   // the worked example: a month-end stepping stone, 48 days old
      january: 'scheduled',     // the work parked to January
      dueToday: 'stuck',        // the date has come: ordinary board work again
      overdue: 'stuck',
      noDate: 'stuck',          // no date, no door: it must stay in front of the foreman
      todayAhead: 'stuck',      // only a STORED Upcoming is scheduled, as in dispatch's window
      legacyApv: 'stuck',       // a legacy Approval row is stuck work, whatever its date (4 Aug 2026)
      someDay: 'parked',
      hisAnswer: 'parked',      // Kevin's own answer keeps its own bucket
    });
  });

  it('the date is never a movement stamp: a scheduled task keeps its real last movement', () => {
    const r = py(`${FIXTURES}
b, _, v = m.task_view(recs["stepStone"], set(), set(), now)
print(json.dumps({"bucket": b, "lastMoved": v["lastMoved"][:10], "days": v["daysStill"]}))`);
    expect(r.bucket).toBe('scheduled');
    expect(r.lastMoved).toBe('2026-10-01');   // its Created Time, never its due date
    expect(r.days).toBeGreaterThan(48);
  });

  it("a task dispatch works in a lane of its own is dispatch's work, not scheduled", () => {
    const r = py(`${FIXTURES}
print(json.dumps([m.classify(dict(recs["stepStone"]["fields"], _id="x"), set(), now, lane=l)[0]
                  for l in (None, "", "newWork", "approvedHandbacks")]))`);
    expect(r).toEqual(['scheduled', 'scheduled', 'stuck', 'stuck']);
  });

  it("the day is London's: at 23:30 UTC in summer it is already tomorrow", () => {
    const r = py(`
now = datetime(2026, 8, 24, 23, 30, tzinfo=timezone.utc)   # 00:30 on 25 Aug in London
print(json.dumps([m.task_view(rec("recEDGE%dxxxxxxxxx" % i, {"Due Date": d, "Created Time": "2026-07-01T09:00:00.000Z"}), set(), set(), now)[0]
                  for i, d in enumerate(("2026-08-25", "2026-08-26"))]))`);
    expect(r).toEqual(['stuck', 'scheduled']);
  });

  it('the clock and the board give one answer on every shape (parked_on_purpose)', () => {
    const r = py(`${FIXTURES}
print(json.dumps({k: [m.parked_on_purpose(v["fields"], now), m.task_view(v, set(), set(), now)[0] in ("scheduled", "parked")]
                  for k, v in recs.items()}))`);
    for (const [k, [clock, board]] of Object.entries(r)) expect(board, k).toBe(clock);
  });
});

describe('scheduled work is still seen', () => {
  it('a scheduled task nobody holds is ownerless (Kevin, 23 Sep 2026: an ownerless task due in October)', () => {
    const r = py(`${FIXTURES}
recs["orphan"] = rec("recORPHANxxxxxxx1", {"Due Date": "2026-12-18", "Team Member": None})
buckets = {}
for v in recs.values():
    b, _, view = m.task_view(v, set(), set(), now)
    buckets.setdefault(b, []).append(view)
print(json.dumps({"bucket": [b for b, vs in buckets.items() if any(x["id"] == "recORPHANxxxxxxx1" for x in vs)],
                  "ownerless": [v["id"] for v in m.ownerless_views(buckets)]}))`);
    expect(r.bucket).toEqual(['scheduled']);
    expect(r.ownerless).toEqual(['recORPHANxxxxxxx1']);
  });

  it('a scheduled task nobody works can be handed to Roy when it is his lane (royAllowed)', () => {
    // Review of this change: royLane was read only for stuck, moving and held views, so a hand-over
    // to Roy never counted as placing a scheduled task held by an agent no robot works.
    const r = py(`${FIXTURES}
BK = "recBOOKKEEPERxxx1"
v = rec("recROYSCHEDxxxxx1", {"Task Name": "MAINTENANCE: fence repair at 1 Example Road", "Due Date": "2026-11-30",
                              "Team Member": [BK], "Maintenance Ticket": True})
b, _, view = m.task_view(v, set(), set(), now)
ow = m.ownerless_views({b: [view]}, {BK: "AI Bookkeeper"}, roster={BK: {"name": "Bookkeeper", "status": "Live", "dispatchable": False}})
print(json.dumps({"bucket": b, "ownerless": [(x["id"], x.get("royAllowed")) for x in ow]}))`);
    expect(r.bucket).toBe('scheduled');
    expect(r.ownerless).toEqual([['recROYSCHEDxxxxx1', true]]);
  });

  it("cmd_board's own output: stuck leaves them out, scheduled lists each with its date, soonest first", () => {
    const r = py(`
import io, contextlib
today = datetime.now(timezone.utc).date()
ahead = lambda d: (today + timedelta(days=d)).isoformat()
THREAD = "https://mail.google.com/mail/u/0/#all/18c0ffee00000001"
def fake_query_all(table, formula, fields, why, **kw):
    if why != "board read":
        return []
    base = {"Assignee": None, "Due Date": None}
    # The review's order: the scheduled twin is the OLDER task, so it would be the keeper.
    return [rec("recLATERxxxxxxxx1", dict(base, **{"Due Date": ahead(40)})),
            rec("recSOONERxxxxxxx1", dict(base, **{"Due Date": ahead(5), "Inbound Note URL Link": THREAD,
                                                    "Task Name": "INBOUND: Example Lettings asks for the gas certificate",
                                                    "Created Time": "2026-09-01T09:00:00.000Z"})),
            rec("recDUETWINxxxxxx1", dict(base, **{"Status": "Today", "Due Date": ahead(-9), "Inbound Note URL Link": THREAD,
                                                    "Task Name": "INBOUND: Example Lettings asks for the gas certificate"})),
            rec("recNODATExxxxxxx1", base)]
m.query_all = fake_query_all
m.read_ai_agents = lambda: ({}, "")
m.read_role_roster = lambda: (None, "not read in this test")
m.read_activity = lambda *a, **k: ([], set())
m.read_dispatch_lanes = lambda *a, **k: (None, "not read in this test")
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m.cmd_board()
b = json.loads(buf.getvalue())
print(json.dumps({"counts": {k: b["counts"][k] for k in ("stuck", "scheduled", "openTasksRead")},
                  "stuck": sorted(v["id"] for v in b["stuck"]),
                  "scheduled": [(v["id"], v["dueDate"] == ahead(5) or v["dueDate"] == ahead(40)) for v in b["scheduled"]],
                  "dupes": [sorted([g["keeper"]] + list(g["closable"])) for g in b["duplicates"]]}))`);
    expect(r.counts).toEqual({ stuck: 2, scheduled: 2, openTasksRead: 4 });
    expect(r.stuck).toEqual(['recDUETWINxxxxxx1', 'recNODATExxxxxxx1']);
    expect(r.scheduled).toEqual([['recSOONERxxxxxxx1', true], ['recLATERxxxxxxxx1', true]]);
    // Due work is never folded into a task that is not due yet (review of this change): the older
    // scheduled twin would be the keeper, and the due one would leave every worked list with it.
    // The scheduled twin joins the duplicate check on its date, as a parked twin does.
    expect(r.dupes).toEqual([]);
  });

  it('the skill tells the foreman scheduled work is never a move and is reported as a count', () => {
    expect(SKILL).toMatch(/`scheduled`/);
    expect(SKILL).toMatch(/counts\.scheduled/);
  });
});
