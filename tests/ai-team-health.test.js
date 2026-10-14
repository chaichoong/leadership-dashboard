import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// The ai-team-health Estate Status row (Kevin, 9 Oct 2026): the Leadership Dashboard's AI
// Team section reads it. The fixture is shaped from the live numbers read on 9 Oct 2026:
// 178 agent tasks open, 164 in and 119 done in 7 days; 207 defects open, 95 filed and 14
// fixed in 7 days; 43 of 105 fixes in 14 days were a fix of a fix (41%, baseline 32%).
// Every test drives the real functions in scripts/estate-status.py and scripts/loop-health.py.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function py(code) {
  const script = `
import importlib.util, json, sys, os, tempfile
from datetime import datetime, timedelta, timezone
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(resolve(ROOT, 'scripts'))}, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
es = load("es", "estate-status.py")
lh = load("lh", "loop-health.py")
NOW = datetime(2026, 10, 9, 16, 30, tzinfo=timezone.utc)
def iso(dt): return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
${code}
`;
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' }));
}

// agentWork is loop-health.py agent_work() (14 Oct 2026): 40 rows on the stalled list, of
// which 26 are stuck agent work. The stalled list's own length must never reach the card.
const LH_RES = `{"flow": {"agentOpen": 178, "agentCreated7d": 164, "agentDone7d": 119},
                 "stalled": [{"name": "t%d" % i} for i in range(40)],
                 "agentWork": {"live": 55, "approval": 18, "waitingReply": 41, "scheduled": 64, "open": 178,
                               "notMoving": 26, "held": 18, "heldCheck": None, "splitCheck": None}}`;
const MEASURES = `lambda now: ({"open": 207, "filed7d": 95, "fixed7d": 14},
                               es.rework_counts({"days": 14, "fixes": 105, "fix_of_fix": 43}),
                               "2026-10-09T16:23:52.000Z")`;

describe('the ai-team-health row', () => {
  it('carries the four numbers the dashboard shows (the 9 Oct worked example)', () => {
    const row = py(`print(json.dumps(es.ai_team_row(NOW, ${LH_RES}, None, measures=${MEASURES})))`);
    expect(row.status).toBe('Worked');
    expect(row.key).toBe('ai-team-health');
    const p = JSON.parse(row.payload);
    expect(p.work).toEqual({ open: 178, notMoving: 26, created7d: 164, done7d: 119,
      live: 55, approval: 18, waitingReply: 41, scheduled: 64, held: 18, heldCheck: null, splitCheck: null });
    expect(p.defects).toEqual({ open: 207, filed7d: 95, fixed7d: 14 });
    expect(p.rework).toEqual({ days: 14, fixes: 105, fixOfFix: 43, pct: 41, baselinePct: 32 });
    expect(row.detail).toMatch(/41% \(43 of 105 fixes\)/);
    expect(row.detail).toMatch(/^Agent work: 55 live, 18 waiting for approval, 41 waiting on a reply, 64 scheduled \(178 open\), 26 stuck, 164 in/);
  });

  it('is Failed, never the stalled list\'s length, when loop-health returned no agent work split', () => {
    const row = py(`
res = ${LH_RES}
del res["agentWork"]
print(json.dumps(es.ai_team_row(NOW, res, None, measures=${MEASURES})))`);
    expect(row.status).toBe('Failed');
    expect(row.detail).toMatch(/no agent work split/);
  });

  it('is Failed with the reason, never a zero, when agent work cannot be read', () => {
    const row = py(`print(json.dumps(es.ai_team_row(NOW, None, "control failed")))`);
    expect(row.status).toBe('Failed');
    expect(row.detail).toMatch(/control failed/);
    expect(row.payload).toBeUndefined();
  });

  it('is Failed when the defect queue or rework rate cannot be read', () => {
    const row = py(`
def boom(now): raise RuntimeError("rework-rate.py exited 1")
print(json.dumps(es.ai_team_row(NOW, ${LH_RES}, None, measures=boom)))`);
    expect(row.status).toBe('Failed');
    expect(row.detail).toMatch(/rework-rate.py exited 1/);
  });

  it('is Failed when loop-health returned no flow counts', () => {
    const row = py(`print(json.dumps(es.ai_team_row(NOW, {"stalled": []}, None, measures=${MEASURES})))`);
    expect(row.status).toBe('Failed');
  });
});

describe('the counts behind it', () => {
  it('defects: open is the backlog; filed and fixed count only the last 7 days', () => {
    const out = py(`
state = {
  "a": {"status": "open", "ts": iso(NOW - timedelta(days=1))},
  "b": {"status": "claimed", "ts": iso(NOW - timedelta(days=20))},
  "c": {"status": "fixed", "ts": iso(NOW - timedelta(days=3)), "landed_at": iso(NOW - timedelta(days=2))},
  "d": {"status": "fixed", "ts": iso(NOW - timedelta(days=30)), "landed_at": iso(NOW - timedelta(days=9))},
  "e": {"status": "rejected", "ts": iso(NOW - timedelta(days=2))},
  "f": {"status": "deferred", "ts": iso(NOW - timedelta(days=40))},
}
print(json.dumps(es.defect_counts(state, NOW)))`);
    expect(out).toEqual({ open: 2, filed7d: 3, fixed7d: 1 });
  });

  it('defects: a finding closed as fixed against a commit counts, by the close op\'s time', () => {
    // Review finding, 9 Oct 2026: counting landed_at alone missed 9 of 23 fixes that week.
    const out = py(`
state = {
  "g": {"status": "fixed", "ts": iso(NOW - timedelta(days=20))},
  "h": {"status": "fixed", "ts": iso(NOW - timedelta(days=20))},
}
ops = [
  {"op": "close", "id": "g", "outcome": "fixed", "ts": iso(NOW - timedelta(days=1))},
  {"op": "close", "id": "h", "outcome": "fixed", "ts": iso(NOW - timedelta(days=12))},
  {"op": "close", "id": "x", "outcome": "rejected", "ts": iso(NOW - timedelta(days=1))},
]
print(json.dumps(es.defect_counts(state, NOW, ops)))`);
    expect(out.fixed7d).toBe(1);
  });

  it('rework: zero fixes is no rate, not 0%', () => {
    expect(py(`print(json.dumps(es.rework_counts({"days": 14, "fixes": 0, "fix_of_fix": 0})))`).pct).toBeNull();
  });

  it('agent flow counts only agent tasks created inside 7 days', () => {
    const out = py(`
fields = [
  {"Team Member": ["recAGENT"], "Created Time": iso(NOW - timedelta(days=2))},
  {"Team Member": ["recAGENT"], "Created Time": iso(NOW - timedelta(days=8))},
  {"Team Member": ["recHUMAN"], "Created Time": iso(NOW - timedelta(days=1))},
  {"Team Member": ["recAGENT"]},
]
print(json.dumps(lh.agent_flow(fields, {"recAGENT"}, 178, 119, now=NOW)))`);
    expect(out).toEqual({ agentOpen: 178, agentCreated7d: 1, agentDone7d: 119 });
  });

  it('the hourly cache is used inside the hour and recomputed after it', () => {
    const out = py(`
calls = []
def measure(now):
    calls.append(now)
    return {"open": 1, "filed7d": 0, "fixed7d": 0}, {"days": 14, "fixes": 0, "fixOfFix": 0, "pct": None, "baselinePct": 32}
d = tempfile.mkdtemp(); cache = os.path.join(d, "c.json")
es._cached_measures(NOW, cache=cache, measure=measure)
es._cached_measures(NOW + timedelta(minutes=30), cache=cache, measure=measure)
es._cached_measures(NOW + timedelta(minutes=61), cache=cache, measure=measure)
print(json.dumps({"calls": len(calls)}))`);
    expect(out.calls).toBe(2);
  });
});

// ── The Agent Work card's split (Kevin, 14 Oct 2026) ─────────────────────────
// The card read "190 open, 46 not moving" and Kevin took it as "nothing is working". The live
// recount: 64 scheduled for later, 18 with him at Approval, about 40 carried out and waiting on a
// reply; and of the 46, one was a Roy task the deadline rule counted and 18 were compliance tasks
// the dispatcher holds under an open lead task on purpose. The fixture holds one of each, built
// relative to the real clock so report() can be driven end to end. Every test runs the real
// loop-health.py functions; the carry-out test runs the real agent-dispatch.py cmd_complete.
const FIX = `
from zoneinfo import ZoneInfo
LON = ZoneInfo("Europe/London")
N = datetime.now(timezone.utc)
def day(dt): return dt.astimezone(LON).date().isoformat()
def stamp(dt): return dt.astimezone(LON).strftime("%d %b %Y")
AGENT, ROY = "recAGENTxxxxxxx01", "recROYROWxxxxxx01"
OLD = iso(N - timedelta(days=3))
def task(rid, **f):
    base = {"Task Name": rid, "Status": "Today", "Team Member": [AGENT], "Created Time": OLD}
    base.update(f)
    return {"id": rid, "fields": base}
CARRIED = lambda when, what: "[%s — agent] CARRIED OUT (task left open): %s. Left OPEN deliberately: the approval said so." % (stamp(when), what)
TASKS = [
    # On the stalled list, and NOT stuck agent work:
    task("recROYTASKxxxxx01", **{"Team Member": [ROY], "Hard Deadline": True, "Due Date": day(N + timedelta(days=2))}),
    task("recHELDxxxxxxxx01", **{"Task Name": "COMPLIANCE: GSC expired - 1 Test Road"}),
    # Stuck agent work, one per rule:
    task("recDRAFTxxxxxxx01"),
    task("recAMENDxxxxxxx01", **{"Approval Outcome": "Changes requested", "Approved At": OLD, "Agent Output": "x"}),
    task("recDEADLINExxxx01", **{"Hard Deadline": True, "Due Date": day(N + timedelta(days=2)), "Agent Output": "x"}),
    # Carried out and kept open: waiting on a reply.
    task("recWAITxxxxxxxx01", **{"Approval Outcome": "Approved as-is", "Approved At": OLD, "Agent Output": "x",
                                "Notes": "earlier notes\\n\\n" + CARRIED(N - timedelta(days=1), "chased the electrician")}),
    # Its Notes only QUOTE another task's carry-out (a TRACK RECORD block), dated after its own
    # approval: it is still owed a carry-out, so live.
    task("recQUOTEDxxxxxx01", **{"Approval Outcome": "Approved as-is", "Approved At": OLD, "Agent Output": "x",
                                "Notes": "TRACK RECORD\\n- %s — agent: CARRIED OUT (task left open): another task (https://airtable.com/x/tblqB8b22hKBL4PF1/recOTHERxxxxxx01)" % stamp(N - timedelta(days=1))}),
    # Kevin approved again AFTER the carry-out: new approved work, so live.
    task("recREAPPROVEDxx01", **{"Approval Outcome": "Approved as-is", "Approved At": iso(N - timedelta(hours=1)), "Agent Output": "x",
                                "Notes": CARRIED(N - timedelta(days=2), "first send")}),
    task("recAPPROVALxxxx01", **{"Status": "Approval", "Sent For Approval By": [AGENT], "Agent Output": "x"}),
    task("recLATERxxxxxxx01", **{"Status": "Upcoming", "Due Date": day(N + timedelta(days=200))}),
    task("recDUETODAYxxxx01", **{"Status": "Upcoming", "Due Date": day(N), "Agent Output": "x"}),
    task("recDONExxxxxxxx01", **{"Status": "Completed", "Completion Date": day(N - timedelta(days=1))}),
]
HELD = {"recHELDxxxxxxxx01"}
STALLED = lh.compute(TASKS, {AGENT}, now=N, roy_ids={ROY})["stalled"]
`;

describe('the Agent Work split (14 Oct 2026)', () => {
  it('Not moving counts only stuck AGENT tasks, never a non-agent task or one held under a lead', () => {
    const out = py(`${FIX}
aw = lh.agent_work(TASKS, {AGENT}, STALLED, HELD, None, now=N)
print(json.dumps({"stalled": sorted(s["id"] for s in STALLED), "aw": aw}))`);
    // The fixture really fires the rules: both excluded tasks ARE on the stalled list.
    expect(out.stalled).toEqual(['recAMENDxxxxxxx01', 'recDEADLINExxxx01', 'recDRAFTxxxxxxx01',
      'recHELDxxxxxxxx01', 'recROYTASKxxxxx01']);
    expect(out.aw.notMoving).toBe(3);
    expect(out.aw.held).toBe(1);
    expect(out.aw.heldCheck).toBeNull();
  });

  it('splits open agent work four ways that add up to the total', () => {
    const out = py(`${FIX}
aw = lh.agent_work(TASKS, {AGENT}, STALLED, HELD, None, now=N)
today = day(N)
buckets = {t["id"]: lh.work_bucket(t["fields"], today) for t in TASKS if t["fields"]["Status"] != "Completed"}
print(json.dumps({"aw": aw, "buckets": buckets}))`);
    expect(out.aw).toMatchObject({ live: 7, approval: 1, waitingReply: 1, scheduled: 1, open: 10, splitCheck: null });
    expect(out.aw.live + out.aw.approval + out.aw.waitingReply + out.aw.scheduled).toBe(out.aw.open);
    expect(out.buckets.recWAITxxxxxxxx01).toBe('waitingReply');
    expect(out.buckets.recQUOTEDxxxxxx01, 'a quoted carry-out is not this task\'s').toBe('live');
    expect(out.buckets.recREAPPROVEDxx01, 'approved after the carry-out is new work').toBe('live');
    expect(out.buckets.recDUETODAYxxxx01, 'Upcoming and due today is live').toBe('live');
    expect(out.buckets.recLATERxxxxxxx01).toBe('scheduled');
    expect(out.buckets.recAPPROVALxxxx01).toBe('approval');
  });

  it('with no held list it counts held tasks as stuck and says it could not check, never a quiet number', () => {
    const out = py(`${FIX}
d = tempfile.mkdtemp()
missing = lh.dispatch_held_ids(N, path=os.path.join(d, "queue.json"))
with open(os.path.join(d, "nokey.json"), "w") as fh: json.dump({"generatedAt": iso(N)}, fh)
with open(os.path.join(d, "stale.json"), "w") as fh: json.dump({"generatedAt": iso(N - timedelta(hours=3)), "heldUnderLead": []}, fh)
with open(os.path.join(d, "fresh.json"), "w") as fh: json.dump({"generatedAt": iso(N - timedelta(minutes=20)), "heldUnderLead": [{"id": "recHELDxxxxxxxx01", "groupLead": "recLEADxxxxxxxx01"}]}, fh)
aw = lh.agent_work(TASKS, {AGENT}, STALLED, missing[0], missing[1], now=N)
print(json.dumps({"missing": [missing[0], missing[1]], "nokey": lh.dispatch_held_ids(N, path=os.path.join(d, "nokey.json"))[1],
                  "stale": lh.dispatch_held_ids(N, path=os.path.join(d, "stale.json"))[1],
                  "fresh": sorted(lh.dispatch_held_ids(N, path=os.path.join(d, "fresh.json"))[0]), "aw": aw}))`);
    expect(out.missing[0]).toBeNull();
    expect(out.missing[1]).toMatch(/no dispatch queue/);
    expect(out.nokey).toMatch(/no heldUnderLead list/);
    expect(out.stale).toMatch(/180 minutes old/);
    expect(out.fresh).toEqual(['recHELDxxxxxxxx01']);
    expect(out.aw.notMoving).toBe(4);           // the held task is in, and...
    expect(out.aw.held).toBeNull();
    expect(out.aw.heldCheck).toMatch(/no dispatch queue/);   // ...the payload says why
  });

  it('withdraws the split when carry-out lines exist but none can be read (the control)', () => {
    const out = py(`${FIX}
quoted_only = [t for t in TASKS if t["id"] not in ("recWAITxxxxxxxx01", "recREAPPROVEDxx01")]
aw = lh.agent_work(quoted_only, {AGENT}, STALLED, HELD, None, now=N)
print(json.dumps(aw))`);
    expect(out.live).toBeNull();
    expect(out.waitingReply).toBeNull();
    expect(out.splitCheck).toMatch(/none carries a readable dated line/);
    expect(out.open).toBe(8);
  });

  it('report() carries the split, built from one read, with open matching the control', () => {
    const out = py(`${FIX}
d = tempfile.mkdtemp(); q = os.path.join(d, "queue.json")
with open(q, "w") as fh: json.dump({"generatedAt": iso(N), "heldUnderLead": [{"id": "recHELDxxxxxxxx01"}]}, fh)
lh.DISPATCH_QUEUE = q
team = [{"id": AGENT, "fields": {"Name": "AI Worker", "Is AI Agent": True}}, {"id": ROY, "fields": {"Name": "Roy Lavin"}}]
lh.fetch = lambda table, fields=None, formula=None: team if table == lh.TEAM else TASKS
res = lh.report()
row = es.ai_team_row(N, res, None, measures=${MEASURES})
print(json.dumps({"aw": res["agentWork"], "stalled": len(res["stalled"]), "work": json.loads(row["payload"])["work"]}))`);
    expect(out.stalled).toBe(5);
    expect(out.aw).toMatchObject({ open: 10, live: 7, notMoving: 3, held: 1 });
    expect(out.work).toMatchObject({ open: 10, live: 7, approval: 1, waitingReply: 1, scheduled: 1, notMoving: 3 });
  });

  it('reads the carry-out line the real `complete --keep-open` writes, for every approval kind', () => {
    const out = py(`
import io, contextlib
d = load("d", "agent-dispatch.py")
seen = []
class A:
    def __init__(self, **kw): self.__dict__.update(kw)
for outcome in d.APPROVED:
    W = []
    d.get_task = lambda i, o=outcome: {"id": i, "fields": {d.AF["notes"]: "older notes", d.AF["status"]: "Today",
                                                          d.AF["approvalOutcome"]: o, d.AF["teamMember"]: ["recAGENTxxxxxxx01"]}}
    d.patch_task = lambda i, f, W=W: W.append(f)
    d.ledger_append = lambda t, e: None
    with contextlib.redirect_stdout(io.StringIO()):
        d.cmd_complete(A(task="recWAITxxxxxxxx01", keep_open=True, note="chased the electrician", no_certificate="", evidence=""))
    notes = W[-1][d.AF["notes"]]
    fields = {"Status": "Today", "Approval Outcome": outcome, "Approved At": iso(datetime.now(timezone.utc)), "Notes": notes}
    seen.append(lh.waiting_on_reply(fields))
print(json.dumps({"seen": seen, "kinds": len(d.APPROVED), "mark": d.CARRIED_OUT_MARK == lh.CARRIED_OUT_MARK}))`);
    expect(out.kinds).toBeGreaterThan(0);
    expect(out.seen).toEqual(Array(out.kinds).fill(true));
    expect(out.mark).toBe(true);
  });
});
