import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// The ai-team-health Estate Status row (Kevin, 9 Oct 2026): the Leadership Dashboard's AI
// Team section reads it. The fixture is shaped from the live numbers read on 9 Oct 2026:
// 178 agent tasks open, 164 in and 119 done in 7 days; 207 defects open, 95 filed and 14
// fixed in 7 days; 43 of 105 fixes in 14 days were a fix of a fix (41%, baseline 32%).
// Every test drives the real functions in scripts/estate-status.py and scripts/loop-health.py.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `tz` runs Python under another process time zone (memory reference_time_of_day_test_proof:
// a TZ shift moves the local clock and leaves file times true). Every date here must come from
// Europe/London explicitly, so the answer may not change with it.
function py(code, tz) {
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
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c', script],
    { encoding: 'utf8', ...(tz ? { env: { ...process.env, TZ: tz } } : {}) }));
}

// agentWork is loop-health.py agent_work() (14 Oct 2026): 40 rows on the stalled list, of
// which 26 are stuck agent work. The stalled list's own length must never reach the card.
const LH_RES = `{"flow": {"agentOpen": 178, "agentCreated7d": 164, "agentDone7d": 119},
                 "stalled": [{"name": "t%d" % i} for i in range(40)],
                 "agentWork": {"live": 55, "approval": 18, "waitingReply": 41, "scheduled": 64, "other": 0,
                               "open": 178, "notMoving": 26, "replyOverdue": 2, "replyWindowDays": 14, "held": 18,
                               "heldCheck": None, "waitCheck": None, "splitCheck": None}}`;
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
      live: 55, approval: 18, waitingReply: 41, scheduled: 64, other: 0, replyOverdue: 2, replyWindowDays: 14,
      held: 18, heldCheck: null, waitCheck: null, splitCheck: null });
    expect(p.defects).toEqual({ open: 207, filed7d: 95, fixed7d: 14 });
    expect(p.rework).toEqual({ days: 14, fixes: 105, fixOfFix: 43, pct: 41, baselinePct: 32 });
    expect(row.detail).toMatch(/41% \(43 of 105 fixes\)/);
    expect(row.detail).toMatch(/^Agent work: 55 live, 18 waiting for approval, 41 waiting on a reply, 64 scheduled \(178 open\), 26 stuck, 2 of them waiting on a reply too long, 164 in/);
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
// the dispatcher holds under an open lead task on purpose. The independent review of PR #782 added
// the rest of this fixture: an open wall after a carry-out, a park after it, a wait past the
// dispatcher's 14-day reply window, a same-day approval after a carry-out (the Notes stamp holds the
// date only), an approval put off to a later date, a task on no board, and Upcoming with no date or
// Some Day. Built relative to the real clock so report() can be driven end to end. Every test runs
// the real loop-health.py functions, which read their rules from the real agent-dispatch.py; the
// carry-out test runs the real cmd_complete.
const FIX = `
from zoneinfo import ZoneInfo
LON = ZoneInfo("Europe/London")
N = datetime.now(timezone.utc)
D = lh.dispatcher()
def day(dt): return dt.astimezone(LON).date().isoformat()
def stamp(dt): return dt.astimezone(LON).strftime("%d %b %Y")
AGENT, ROY = "recAGENTxxxxxxx01", "recROYROWxxxxxx01"
OLD = iso(N - timedelta(days=3))
def task(rid, **f):
    base = {"Task Name": rid, "Status": "Today", "Team Member": [AGENT], "Created Time": OLD}
    base.update(f)
    return {"id": rid, "fields": base}
CARRIED = lambda when, what: "[%s — agent] %s %s. Left OPEN deliberately: the approval said so." % (stamp(when), D.CARRIED_OUT_MARK, what)
WALL = D.blocker_note(stamp(N - timedelta(hours=20)), "agent", D.BLOCKER_OPEN_MARK,
                      {"kind": "TOOL", "subject": "send-email attachment types"},
                      "cannot attach the PDF [since %s]" % iso(N - timedelta(hours=20)))
def approved(rid, at, notes, **f):
    return task(rid, **{"Approval Outcome": "Approved as-is", "Approved At": iso(at), "Agent Output": "x", "Notes": notes, **f})
TASKS = [
    # On the stalled list, and NOT stuck agent work:
    task("recROYTASKxxxxx01", **{"Team Member": [ROY], "Hard Deadline": True, "Due Date": day(N + timedelta(days=2))}),
    task("recHELDxxxxxxxx01", **{"Task Name": "COMPLIANCE: GSC expired - 1 Test Road"}),
    # Stuck agent work, one per rule:
    task("recDRAFTxxxxxxx01"),
    task("recAMENDxxxxxxx01", **{"Approval Outcome": "Changes requested", "Approved At": OLD, "Agent Output": "x"}),
    task("recDEADLINExxxx01", **{"Hard Deadline": True, "Due Date": day(N + timedelta(days=2)), "Agent Output": "x"}),
    # Carried out and kept open: waiting on a reply.
    approved("recWAITxxxxxxxx01", N - timedelta(days=3), "earlier notes\\n\\n" + CARRIED(N - timedelta(days=1), "chased the electrician")),
    # Its Notes only QUOTE another task's carry-out (a TRACK RECORD block), dated after its own
    # approval: it is still owed a carry-out, so live.
    approved("recQUOTEDxxxxxx01", N - timedelta(days=3), "TRACK RECORD\\n- %s — agent: CARRIED OUT (task left open): another task (https://airtable.com/x/tblqB8b22hKBL4PF1/recOTHERxxxxxx01)" % stamp(N - timedelta(days=1))),
    # Kevin approved again AFTER the carry-out: new approved work, so live.
    approved("recREAPPROVEDxx01", N - timedelta(hours=1), CARRIED(N - timedelta(days=2), "first send")),
    task("recAPPROVALxxxx01", **{"Status": "Approval", "Sent For Approval By": [AGENT], "Agent Output": "x"}),
    task("recLATERxxxxxxx01", **{"Status": "Upcoming", "Due Date": day(N + timedelta(days=200))}),
    task("recDUETODAYxxxx01", **{"Status": "Upcoming", "Due Date": day(N), "Agent Output": "x"}),
    task("recDONExxxxxxxx01", **{"Status": "Completed", "Completion Date": day(N - timedelta(days=1))}),
    # Review item 1: a wall opened after the carry-out, and a park after it. Both live.
    approved("recBLOCKEDxxxxx01", N - timedelta(days=3), CARRIED(N - timedelta(days=2), "sent the quote request") + "\\n\\n" + WALL),
    approved("recPARKEDxxxxxx01", N - timedelta(days=3), CARRIED(N - timedelta(days=2), "sent the booking")),
    # Review item 1: carried out 19 days ago and re-checked daily since. Live, and stuck.
    approved("recOLDWAITxxxxx01", N - timedelta(days=20), CARRIED(N - timedelta(days=19), "sent") + "\\n" + CARRIED(N - timedelta(days=1), "re-checked, no reply")),
    # Review item 2: carried out, then approved again the same day. The ledger says which came
    # first; the Notes stamp cannot. Live, and its twin carried out AFTER the approval is waiting.
    approved("recSAMEDAYxxxxx01", N - timedelta(minutes=30), CARRIED(N - timedelta(minutes=40), "sent")),
    approved("recSAMEDAYDONEx01", N - timedelta(minutes=40), CARRIED(N - timedelta(minutes=30), "sent")),
    # Review item 3: an approval Kevin put off to a later date is scheduled, not waiting on him.
    task("recDEFERREDxxxx01", **{"Status": "Approval", "Sent For Approval By": [AGENT], "Agent Output": "x",
                                "Deferred Until": day(N + timedelta(days=5))}),
    # Review item 6: a status no board reads is its own bucket, never live.
    task("recNOBOARDxxxxx01", **{"Status": "Waiting", "Agent Output": "x"}),
    # Upcoming with no date, and Some Day: scheduled, never live.
    task("recNODATExxxxxx01", **{"Status": "Upcoming"}),
    task("recSOMEDAYxxxxx01", **{"Status": "Upcoming", "Due Date": day(N), "Some Day": True, "Agent Output": "x"}),
]
LEDGER = {
    "recWAITxxxxxxxx01": [("intent", N - timedelta(days=1, minutes=5)), ("done", N - timedelta(days=1))],
    "recREAPPROVEDxx01": [("done", N - timedelta(days=2))],
    "recBLOCKEDxxxxx01": [("done", N - timedelta(days=2))],
    "recPARKEDxxxxxx01": [("done", N - timedelta(days=2)), ("parked", N - timedelta(days=1))],
    "recOLDWAITxxxxx01": [("done", N - timedelta(days=19))] + [("done", N - timedelta(days=k)) for k in range(18, 0, -1)],
    "recSAMEDAYxxxxx01": [("done", N - timedelta(minutes=40))],
    "recSAMEDAYDONEx01": [("done", N - timedelta(minutes=30))],
}
HELD = {"recHELDxxxxxxxx01"}
STALLED = lh.compute(TASKS, {AGENT}, now=N, roy_ids={ROY})["stalled"]
def work(**kw):
    args = dict(ledger=LEDGER, now=N)
    args.update(kw)
    return lh.agent_work(TASKS if "tasks" not in kw else args.pop("tasks"), {AGENT}, STALLED,
                         args.pop("held", HELD), args.pop("held_error", None), **args)
def bucket(rid, events="ledger"):
    t = next(t for t in TASKS if t["id"] == rid)
    return lh.work_bucket(t["fields"], N, LEDGER.get(rid, []) if events == "ledger" else events)[0]
`;

describe('the Agent Work split (14 Oct 2026)', () => {
  it('Not moving counts only stuck AGENT tasks, never a non-agent task or one held under a lead', () => {
    const out = py(`${FIX}
print(json.dumps({"stalled": sorted(s["id"] for s in STALLED), "aw": work()}))`);
    // The fixture really fires the rules: both excluded tasks ARE on the stalled list.
    expect(out.stalled).toEqual(['recAMENDxxxxxxx01', 'recDEADLINExxxx01', 'recDRAFTxxxxxxx01',
      'recHELDxxxxxxxx01', 'recNOBOARDxxxxx01', 'recROYTASKxxxxx01']);
    // DRAFT, AMEND, DEADLINE, NOBOARD from the stalled list, and OLDWAIT past the reply window.
    expect(out.aw.notMoving).toBe(5);
    expect(out.aw.replyOverdue).toBe(1);
    expect(out.aw.held).toBe(1);
    expect(out.aw.heldCheck).toBeNull();
  });

  it('splits open agent work into buckets that add up to the total, and nothing unknown is live', () => {
    const out = py(`${FIX}
print(json.dumps(work()))`);
    expect(out).toMatchObject({ live: 11, approval: 1, waitingReply: 2, scheduled: 4, other: 1, open: 19,
      replyWindowDays: 14, splitCheck: null, waitCheck: null });
    expect(out.live + out.approval + out.waitingReply + out.scheduled + out.other).toBe(out.open);
  });

  it('places every kind of task where the review said it belongs', () => {
    const out = py(`${FIX}
ids = [t["id"] for t in TASKS if t["fields"]["Status"] != "Completed" and AGENT in t["fields"]["Team Member"]]
print(json.dumps({i: bucket(i) for i in ids}))`);
    expect(out).toMatchObject({
      recWAITxxxxxxxx01: 'waitingReply',
      recSAMEDAYDONEx01: 'waitingReply',
      recQUOTEDxxxxxx01: 'live',        // a quoted carry-out is not this task's
      recREAPPROVEDxx01: 'live',        // approved after the carry-out is new work
      recBLOCKEDxxxxx01: 'live',        // 1: an open wall is not a reply
      recPARKEDxxxxxx01: 'live',        // 1: parked after the carry-out
      recOLDWAITxxxxx01: 'live',        // 1: past the reply window
      recSAMEDAYxxxxx01: 'live',        // 2: approved 10 minutes after the carry-out, same day
      recDEFERREDxxxx01: 'scheduled',   // 3: put off to a later date
      recAPPROVALxxxx01: 'approval',
      recNOBOARDxxxxx01: 'other',       // 6: never live
      recNODATExxxxxx01: 'scheduled',
      recSOMEDAYxxxxx01: 'scheduled',
      recLATERxxxxxxx01: 'scheduled',
      recDUETODAYxxxx01: 'live',
    });
  });

  it('with no ledger, a same-day approval is never waiting, and the card says the ledger was not read', () => {
    const out = py(`${FIX}
d = tempfile.mkdtemp()
ledger, why = lh.carryout_ledger(os.path.join(d, "none.jsonl"))
aw = work(ledger=None, ledger_error=why)
print(json.dumps({"why": why, "aw": aw, "sameDayDone": bucket("recSAMEDAYDONEx01", None),
                  "wait": bucket("recWAITxxxxxxxx01", None), "blocked": bucket("recBLOCKEDxxxxx01", None)}))`);
    expect(out.why).toMatch(/no carry-out ledger/);
    expect(out.aw.waitCheck).toMatch(/no carry-out ledger/);
    expect(out.sameDayDone).toBe('live');   // carried out after the approval, but the date cannot say so
    expect(out.wait).toBe('waitingReply');  // carried out on a later day than the approval
    expect(out.blocked).toBe('live');
  });

  it('reads the real ledger file: full times, bad lines and times with no zone skipped', () => {
    const out = py(`${FIX}
d = tempfile.mkdtemp(); p = os.path.join(d, "carryout-intent.jsonl")
with open(p, "w") as fh:
    fh.write(json.dumps({"task": "recSAMEDAYDONEx01", "ts": "2026-10-14T16:39:05.000Z", "event": "done"}) + "\\n")
    fh.write("not json\\n")
    fh.write(json.dumps({"task": "recSAMEDAYDONEx01", "ts": "2026-10-14T16:00:00", "event": "parked"}) + "\\n")
    fh.write(json.dumps({"task": "recSAMEDAYDONEx01", "ts": "2026-10-14T16:10:00.000Z", "event": "intent"}) + "\\n")
ledger, why = lh.carryout_ledger(p)
print(json.dumps({"why": why, "events": [[e, w.isoformat()] for e, w in ledger["recSAMEDAYDONEx01"]]}))`);
    expect(out.why).toBeNull();
    expect(out.events).toEqual([['intent', '2026-10-14T16:10:00+00:00'], ['done', '2026-10-14T16:39:05+00:00']]);
  });

  it('with no held list it counts held tasks as stuck and says it could not check, never a quiet number', () => {
    const out = py(`${FIX}
d = tempfile.mkdtemp()
missing = lh.dispatch_held_ids(N, path=os.path.join(d, "queue.json"))
with open(os.path.join(d, "nokey.json"), "w") as fh: json.dump({"generatedAt": iso(N)}, fh)
with open(os.path.join(d, "stale.json"), "w") as fh: json.dump({"generatedAt": iso(N - timedelta(hours=3)), "heldUnderLead": []}, fh)
with open(os.path.join(d, "fresh.json"), "w") as fh: json.dump({"generatedAt": iso(N - timedelta(minutes=20)), "heldUnderLead": [{"id": "recHELDxxxxxxxx01", "groupLead": "recLEADxxxxxxxx01"}]}, fh)
aw = work(held=missing[0], held_error=missing[1])
print(json.dumps({"missing": [missing[0], missing[1]], "nokey": lh.dispatch_held_ids(N, path=os.path.join(d, "nokey.json"))[1],
                  "stale": lh.dispatch_held_ids(N, path=os.path.join(d, "stale.json"))[1],
                  "fresh": sorted(lh.dispatch_held_ids(N, path=os.path.join(d, "fresh.json"))[0]), "aw": aw}))`);
    expect(out.missing[0]).toBeNull();
    expect(out.missing[1]).toMatch(/no dispatch queue/);
    expect(out.nokey).toMatch(/no heldUnderLead list/);
    expect(out.stale).toMatch(/180 minutes old/);
    expect(out.fresh).toEqual(['recHELDxxxxxxxx01']);
    expect(out.aw.notMoving).toBe(6);           // the held task is in, and...
    expect(out.aw.held).toBeNull();
    expect(out.aw.heldCheck).toMatch(/no dispatch queue/);   // ...the payload says why
  });

  it('a queue caught half-written, empty, or with a zone-less time is unreadable, never a crash (review item 4)', () => {
    const out = py(`${FIX}
d = tempfile.mkdtemp()
cases = {"empty": "", "half": '{"generatedAt": "2026-10-14T16:02:33.000Z", "heldUnder',
         "naive": json.dumps({"generatedAt": "2026-10-14T16:02:33", "heldUnderLead": []}),
         "junk": json.dumps({"generatedAt": "yesterday", "heldUnderLead": []})}
out = {}
for k, body in cases.items():
    p = os.path.join(d, k + ".json")
    with open(p, "w") as fh: fh.write(body)
    ids, why = lh.dispatch_held_ids(N, path=p)
    out[k] = [ids, why]
print(json.dumps(out))`);
    for (const k of ['empty', 'half']) {
      expect(out[k][0], k).toBeNull();
      expect(out[k][1], k).toMatch(/could not be read/);
    }
    for (const k of ['naive', 'junk']) {
      expect(out[k][0], k).toBeNull();
      expect(out[k][1], k).toMatch(/no readable generatedAt/);
    }
  });

  it('the hand-back poll replaces the queue in one step, so a reader never sees half of it (review item 4)', () => {
    // Runs the runner's OWN queue block, cut from scripts/handback-poll-run.sh, with a stand-in
    // agent-dispatch.py that writes half the JSON, waits, then writes the rest. A reader polls
    // the file the whole time through the real dispatch_held_ids.
    const sh = readFileSync(resolve(ROOT, 'scripts/handback-poll-run.sh'), 'utf8');
    const start = sh.indexOf('QJSON="$SCRATCH/queue.json"');
    const end = sh.indexOf('\n', sh.indexOf('fi\n', start) + 3);
    expect(start, 'the queue block is gone from the runner').toBeGreaterThan(-1);
    const block = sh.slice(start, end);
    const out = py(`${FIX}
import subprocess, time
d = tempfile.mkdtemp(); repo = os.path.join(d, "repo"); os.makedirs(os.path.join(repo, "scripts"))
scratch = os.path.join(d, "scratch"); os.makedirs(scratch)
with open(os.path.join(repo, "scripts", "agent-dispatch.py"), "w") as fh:
    fh.write("import sys, time, json\\nbody = json.dumps({'generatedAt': %r, 'heldUnderLead': [{'id': 'recNEWxxxxxxxxx01'}]})\\n"
             "sys.stdout.write(body[:20]); sys.stdout.flush(); time.sleep(1.5); sys.stdout.write(body[20:])\\n" % iso(N))
with open(os.path.join(scratch, "queue.json"), "w") as fh:
    json.dump({"generatedAt": iso(N - timedelta(minutes=30)), "heldUnderLead": [{"id": "recOLDxxxxxxxxx01"}]}, fh)
script = "beat() { :; }\\nREPO=%s\\nSCRATCH=%s\\n" % (repo, scratch) + ${JSON.stringify(block)}
proc = subprocess.Popen(["/bin/bash", "-c", script])
seen = set()
while proc.poll() is None:
    ids, why = lh.dispatch_held_ids(N, path=os.path.join(scratch, "queue.json"))
    seen.add("unreadable" if ids is None else ",".join(sorted(ids)))
    time.sleep(0.05)
final, _ = lh.dispatch_held_ids(N, path=os.path.join(scratch, "queue.json"))
print(json.dumps({"rc": proc.returncode, "seen": sorted(seen), "final": sorted(final or []),
                  "tmpLeft": os.path.exists(os.path.join(scratch, "queue.json.tmp"))}))`);
    expect(out.rc).toBe(0);
    expect(out.seen).not.toContain('unreadable');
    expect(out.seen).toContain('recOLDxxxxxxxxx01');
    expect(out.final).toEqual(['recNEWxxxxxxxxx01']);
    expect(out.tmpLeft).toBe(false);
  });

  it('withdraws the split when carry-out lines exist but none can be read (the control)', () => {
    const out = py(`${FIX}
keep = ("recQUOTEDxxxxxx01", "recDRAFTxxxxxxx01", "recAPPROVALxxxx01", "recLATERxxxxxxx01")
print(json.dumps(work(tasks=[t for t in TASKS if t["id"] in keep])))`);
    expect(out.live).toBeNull();
    expect(out.waitingReply).toBeNull();
    expect(out.other).toBeNull();
    expect(out.splitCheck).toMatch(/none carries a readable dated line/);
    expect(out.open).toBe(4);
  });

  it('buckets that do not add up to the separately counted control fail the report (review item 6)', () => {
    const out = py(`${FIX}
try:
    work(expected_open=18)
    print(json.dumps({"raised": None}))
except RuntimeError as exc:
    print(json.dumps({"raised": str(exc)}))`);
    expect(out.raised).toMatch(/counted 19 open agent tasks, the control counted 18/);
  });

  it('report() carries the split, built from one read and the dispatcher\'s ledger', () => {
    const out = py(`${FIX}
d = tempfile.mkdtemp(); q = os.path.join(d, "queue.json"); led = os.path.join(d, "carryout-intent.jsonl")
with open(q, "w") as fh: json.dump({"generatedAt": iso(N), "heldUnderLead": [{"id": "recHELDxxxxxxxx01"}]}, fh)
with open(led, "w") as fh:
    for rid, events in LEDGER.items():
        for e, when in events:
            fh.write(json.dumps({"task": rid, "ts": iso(when), "event": e}) + "\\n")
lh.DISPATCH_QUEUE = q
D.INTENT_LEDGER = led
team = [{"id": AGENT, "fields": {"Name": "AI Worker", "Is AI Agent": True}}, {"id": ROY, "fields": {"Name": "Roy Lavin"}}]
lh.fetch = lambda table, fields=None, formula=None: team if table == lh.TEAM else TASKS
res = lh.report()
row = es.ai_team_row(N, res, None, measures=${MEASURES})
print(json.dumps({"aw": res["agentWork"], "stalled": len(res["stalled"]), "work": json.loads(row["payload"])["work"]}))`);
    expect(out.stalled).toBe(6);
    expect(out.aw).toMatchObject({ open: 19, live: 11, waitingReply: 2, notMoving: 5, held: 1, waitCheck: null });
    expect(out.work).toMatchObject({ open: 19, live: 11, approval: 1, waitingReply: 2, scheduled: 4, other: 1,
      notMoving: 5, replyOverdue: 1, replyWindowDays: 14 });
  });

  it('the London midnight edge: the answer is London\'s, whatever the process time zone', () => {
    // 23:30 UTC on 13 Oct is 00:30 on 14 Oct in London (BST). An Upcoming task due 14 Oct is due
    // NOW; a carry-out stamped "14 Oct" and an approval at 23:15 UTC are the same London day.
    const code = `
N = datetime(2026, 10, 13, 23, 30, tzinfo=timezone.utc)
D = lh.dispatcher()
line = "[14 Oct 2026 — agent] %s sent." % D.CARRIED_OUT_MARK
due = {"Status": "Upcoming", "Due Date": "2026-10-14", "Agent Output": "x"}
appr = {"Status": "Today", "Approval Outcome": "Approved as-is", "Approved At": "2026-10-13T23:15:00.000Z", "Notes": line}
print(json.dumps({"due": lh.work_bucket(due, N)[0],
                  "dateOnly": lh.work_bucket(appr, N, None)[0],
                  "ledger": lh.work_bucket(appr, N, [("done", datetime(2026, 10, 13, 23, 20, tzinfo=timezone.utc))])[0],
                  "tomorrow": lh.work_bucket(dict(due, **{"Due Date": "2026-10-15"}), N)[0]}))`;
    const want = { due: 'live', dateOnly: 'live', ledger: 'waitingReply', tomorrow: 'scheduled' };
    for (const tz of [undefined, 'Etc/GMT-14', 'Etc/GMT+12', 'UTC']) {
      expect(py(code, tz), tz || 'local').toEqual(want);
    }
  });

  it('reads the carry-out line and ledger event the real `complete --keep-open` writes, for every approval kind', () => {
    const out = py(`
import io, contextlib
d = lh.dispatcher()
seen = []
class A:
    def __init__(self, **kw): self.__dict__.update(kw)
for outcome in d.APPROVED:
    W, L = [], []
    approved_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    d.get_task = lambda i, o=outcome: {"id": i, "fields": {d.AF["notes"]: "older notes", d.AF["status"]: "Today",
                                                          d.AF["approvalOutcome"]: o, d.AF["teamMember"]: ["recAGENTxxxxxxx01"]}}
    d.patch_task = lambda i, f, W=W: W.append(f)
    d.ledger_append = lambda t, e, L=L: L.append((e, datetime.now(timezone.utc)))
    with contextlib.redirect_stdout(io.StringIO()):
        d.cmd_complete(A(task="recWAITxxxxxxxx01", keep_open=True, note="chased the electrician", no_certificate="", evidence=""))
    notes = W[-1][d.AF["notes"]]
    fields = {"Status": "Today", "Approval Outcome": outcome, "Approved At": iso(approved_at), "Notes": notes}
    seen.append([lh.reply_wait(fields, datetime.now(timezone.utc), L), [e for e, _ in L]])
print(json.dumps({"seen": seen, "kinds": len(d.APPROVED)}))`);
    expect(out.kinds).toBeGreaterThan(0);
    expect(out.seen).toEqual(Array(out.kinds).fill(['waiting', ['done']]));
  });
});
