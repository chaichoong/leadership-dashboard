import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// The "Is the AI team healthy?" verdict (Kevin, 15 Oct 2026): fourteen of his questions, each a
// colour, a short answer, a number, a rule and a trend, judged on the Mac by
// scripts/ai_team_health.py into the Estate Status row ai-team-verdict. Every test drives the
// real functions. The rule each test pins is the one Kevin approved; the grey case ("Can't tell")
// is pinned for every line, because a source that cannot be read must never read as green.
// Names in the fixtures are invented: this repo is public.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');

function py(code) {
  const script = `
import importlib.util, json, sys, os, tempfile
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(SCRIPTS)}, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
A = load("ath", "ai_team_health.py")
L = ZoneInfo("Europe/London")
NOW = datetime(2026, 10, 15, 11, 0, tzinfo=timezone.utc)          # Thursday 12:00 London
def iso(dt): return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def ago(**kw): return iso(NOW - timedelta(**kw))
def col(l): return l["colour"]
${code}
`;
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' }));
}

const colours = (code) => py(`print(json.dumps([col(l) for l in (${code})]))`);

describe('the fourteen rules, each with its grey case', () => {
  it('1 Emails are getting cleared: green 0, amber 1-5, red over 5 or the last slot missed or failed', () => {
    const ok = `{"state": "ok", "name": "09:00", "date": "2026-10-15"}`;
    expect(colours(`[A.judge_emails({"left": n, "scannedAt": ago(hours=3), "slot": ${ok}}, NOW) for n in (0, 1, 5, 6)]`))
      .toEqual(['green', 'amber', 'amber', 'red']);
    const out = py(`print(json.dumps([A.judge_emails({"left": 0, "scannedAt": ago(hours=3), "slot": {"state": s, "name": "13:00", "date": "2026-10-15"}}, NOW) for s in ("missed", "failed")]))`);
    expect(out.map(l => l.colour)).toEqual(['red', 'red']);                 // a missed slot is red over a clear inbox
    expect(out[0].answer).toBe('The 13:00 inbox run did not start');
    expect(out[1].answer).toBe('The 13:00 inbox run failed');
    // Grey: unreadable, and a scan older than its cadence (18 hours: the longest gap is 17:00 to 09:00).
    expect(colours(`[A.judge_emails({"error": "the inbox sort has no state file"}, NOW),
                     A.judge_emails({"left": 0, "scannedAt": ago(hours=19), "slot": ${ok}}, NOW)]`)).toEqual(['grey', 'grey']);
    // A cut-off listing is a floor: never green on it.
    const floor = py(`print(json.dumps(A.judge_emails({"left": 0, "truncated": True, "scannedAt": ago(hours=1), "slot": ${ok}}, NOW)))`);
    expect(floor.colour).toBe('amber');
    expect(floor.answer).toBe('at least 0 emails over 2 days old');
  });

  it('1 the slot verdict and the old-mail count come from the triage script\'s own files, never its prose', () => {
    const out = py(`
tri = load("tri", "inbound-triage.py")
class ES:
    def load_schedule(self): return {"inbound-triage": {"cron": "0 9,13,17 * * *"}}
    def last_due(self, cron, now):
        return datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)   # the 13:00 London slot
d = tempfile.mkdtemp()
at = int((NOW - timedelta(hours=1)).timestamp() * 1000)
json.dump({"history_detail": {"2026-10-15": {"inbox_over_2_days": 2, "inbox_listing_truncated": False}},
           "last_scan_ok_ms": at, "last_scan_stale": {"ids": ["m1", "m2", "m3"], "at_ms": at}}, open(os.path.join(d, "state.json"), "w"))
open(os.path.join(d, "slot-results.jsonl"), "w").write(json.dumps({"ts": "2026-10-15T09:00:20+01:00", "date": "2026-10-15", "slot": "09:00", "lane": "email", "ok": True}) + "\\n")
# m1 moved out, m2 decided "leave" earlier and never moved, m3 never decided at all
open(os.path.join(d, "digest-2026-10-15.jsonl"), "w").write(json.dumps({"id": "m1", "do": "archive", "ts": "2026-10-15T11:30:00"}) + "\\n")
open(os.path.join(d, "digest-2026-10-12.jsonl"), "w").write(json.dumps({"id": "m2", "do": "leave", "ts": "2026-10-12T09:30:00"}) + "\\n")
missed = A.read_triage(NOW, tri, ES(), base=d)
print(json.dumps({"slot": missed["slot"], "left": [i["id"] for i in missed["items"]], "undecided": [i["id"] for i in missed["undecided"]],
                  "line": col(A.judge_emails(A.facts_emails(missed), NOW))}))`);
    expect(out.slot).toMatchObject({ name: '13:00', state: 'missed' });      // no record for 13:00 at all
    expect(out.line).toBe('red');
    expect(out.left).toEqual(['m2', 'm3']);
    expect(out.undecided).toEqual(['m3']);                                   // a "leave" is a decision; m3 never had one
  });

  it('2 Responses are getting written: green 0, amber 1-3, red over 3; only email tasks with no draft for over 1 working day', () => {
    expect(colours(`[A.judge_responses({"items": [A.item("x")] * n}) for n in (0, 1, 3, 4)]`))
      .toEqual(['green', 'amber', 'amber', 'red']);
    expect(colours(`[A.judge_responses({"error": "the task board read failed"})]`)).toEqual(['grey']);
    const ids = py(`
lh = load("lh", "loop-health.py"); D = lh.dispatcher()
AG = "recAGENTxxxxxxx01"
def t(i, **f):
    base = {"Task Name": i, "Status": "Today", "Due Date": "2026-10-15", "Team Member": [AG],
            "Inbound Communication Task": True, "Created Time": iso(datetime(2026, 10, 12, 9, 0, tzinfo=L))}
    base.update(f); return {"id": i, "fields": base}
tasks = [t("recWAITING"), t("recDRAFTED", **{"Agent Output": "Dear ..."}), t("recATAPPROVAL", Status="Approval"),
         t("recNOTINBOUND", **{"Inbound Communication Task": False}), t("recLATER", Status="Upcoming", **{"Due Date": "2026-11-05"}),
         t("recFRIDAY", **{"Created Time": iso(datetime(2026, 10, 9, 17, 0, tzinfo=L))}),
         t("recWALLED"), t("recROYS", **{"Team Member": ["recROYxxxxxxxxxx01"]})]
# Friday 17:00 to Monday 09:00 is under one working day: the weekend does not count.
mon = datetime(2026, 10, 12, 9, 0, tzinfo=L)
f = A.facts_responses(tasks, {AG}, lh, D, {"recWALLED"}, NOW)
print(json.dumps({"ids": [i["id"] for i in f["items"]], "weekend": round(A.working_days_between(datetime(2026, 10, 9, 17, 0, tzinfo=L), mon), 2)}))`);
    expect(ids.weekend).toBeLessThan(1);
    // recFRIDAY: Fri 17:00 to Thu 12:00 is 3.8 working days, so it waits too.
    expect(ids.ids.sort()).toEqual(['recFRIDAY', 'recWAITING']);
  });

  it('3 Everything\'s moving: green 10% or less, amber to 25%, red above; grey when the split or the walls cannot be read', () => {
    expect(colours(`[A.judge_moving({"stuck": [A.item("s")] * n, "live": 30}) for n in (3, 4, 7, 8)]`))
      .toEqual(['green', 'amber', 'amber', 'red']);
    expect(colours(`[A.judge_moving({"error": "live work could not be split out"}),
                     A.judge_moving({"stuck": [], "live": None})]`)).toEqual(['grey', 'grey']);
    const g = py(`print(json.dumps(A.facts_moving({"agentWork": {"live": None, "splitCheck": "agent-dispatch.py could not be loaded", "stuckIds": []}}, set(), {})))`);
    expect(g.error).toMatch(/could not be split out/);
  });

  it('3 and 4 never count one task twice: a walled task leaves "moving" and is judged only under "No bottlenecks"', () => {
    const out = py(`
lh = load("lh", "loop-health.py"); D = lh.dispatcher()
wall_line = "[13 Oct 2026 09:00 — agent] BLOCKER OPEN (TOOL robot setup): the fix is not merged [since 2026-10-11T09:00:00Z]"
tasks = [{"id": "recSWEPT", "fields": {"Notes": ""}},
         {"id": "recFRESHWALL", "fields": {"Notes": wall_line}},     # opened after the last sweep
         {"id": "recPLAIN", "fields": {"Notes": "[14 Oct 2026 — agent] drafted"}}]
blockers = {"readAt": iso(NOW), "openTasksRead": 1,
            "open": [{"task": "recSWEPT", "name": "swept", "kind": "TOOL", "days": 4.0}]}
walled = A.walled_ids(tasks, D, blockers)
res = {"agentWork": {"live": 10, "stuckIds": ["recSWEPT", "recFRESHWALL", "recPLAIN"], "heldCheck": None}}
m = A.facts_moving(res, walled, {"recPLAIN": "plain task"})
b = A.facts_bottlenecks(blockers, {"SIGN-IN": 1, "TOOL": 3, "KEVIN": 3}, NOW)
print(json.dumps({"walled": sorted(walled), "stuck": [i["id"] for i in m["stuck"]], "out": m["walledOut"],
                  "past": [i["id"] for i in b["past"]]}))`);
    expect(out.walled).toEqual(['recFRESHWALL', 'recSWEPT']);
    expect(out.stuck).toEqual(['recPLAIN']);
    expect(out.out).toBe(2);
    expect(out.past).toEqual(['recSWEPT']);
  });

  it('4 No bottlenecks: each wall against its own clock (sign-in 1 day, code fix and your step 3); SITE has none; undated is past', () => {
    const out = py(`
tm = load("tm", "task-manager.py")
w = lambda i, k, d: {"task": i, "name": i, "kind": k, "days": d}
blockers = {"readAt": iso(NOW - timedelta(hours=12)), "openTasksRead": 1, "open": [
    w("recSIGNINOLD", "SIGN-IN", 0.6), w("recSIGNINNEW", "SIGN-IN", 0.2), w("recTOOLYOUNG", "TOOL", 2.0),
    w("recKEVINOLD", "KEVIN", 3.1), w("recSITE", "SITE", 30), w("recUNDATED", "TOOL", None)]}
f = A.facts_bottlenecks(blockers, tm.CLOCK_DAYS, NOW)
print(json.dumps({"past": sorted(i["id"] for i in f["past"]), "total": f["total"], "clock": tm.CLOCK_DAYS}))`);
    // The sweep read the walls 12 hours ago: 0.6 days then is 1.1 days now.
    expect(out.past).toEqual(['recKEVINOLD', 'recSIGNINOLD', 'recUNDATED']);
    expect(out.total).toBe(6);
    expect(out.clock).toEqual({ 'SIGN-IN': 1, TOOL: 3, KEVIN: 3 });          // the task manager's own clock, not a copy
    expect(colours(`[A.judge_bottlenecks({"past": [A.item("w")] * n, "byKind": [], "total": n}, NOW) for n in (0, 1, 3, 4)]`))
      .toEqual(['green', 'amber', 'amber', 'red']);
    const stale = py(`
d = tempfile.mkdtemp(); p = os.path.join(d, "blockers.json")
json.dump({"openTasksRead": 1, "open": []}, open(p, "w")); os.utime(p, (NOW.timestamp() - 3 * 3600,) * 2)
print(json.dumps([A.read_blockers(NOW, p), A.read_blockers(NOW, os.path.join(d, "none.json"))]))`);
    expect(stale[0].error).toMatch(/has not run for 3 hours/);
    expect(stale[1].error).toMatch(/written no report/);
  });

  it('5 Approved work gets carried out: the dispatcher\'s own carry-outs older than 24 hours; a stale queue is grey', () => {
    const out = py(`
q = {"generatedAt": ago(minutes=20), "worklist": [
    {"id": "recOLD", "name": "old", "kind": "carry_out", "approvedAt": ago(hours=30)},
    {"id": "recNEW", "name": "new", "kind": "carry_out", "approvedAt": ago(hours=2)},
    {"id": "recWORK", "name": "work", "kind": "new"}]}
d = tempfile.mkdtemp(); p = os.path.join(d, "queue.json"); json.dump(q, open(p, "w"))
f = A.facts_carried(A.read_dispatch_queue(NOW, p), NOW)
json.dump(dict(q, generatedAt=ago(hours=3)), open(p, "w"))
print(json.dumps({"items": [i["id"] for i in f["items"]], "young": f["young"], "stale": A.read_dispatch_queue(NOW, p)}))`);
    expect(out.items).toEqual(['recOLD']);
    expect(out.young).toBe(1);
    expect(out.stale.error).toMatch(/it is written every 30 minutes/);
    expect(colours(`[A.judge_carried({"items": [A.item("x")] * n}) for n in (0, 1, 2, 3)] + [A.judge_carried({"error": "x"})]`))
      .toEqual(['green', 'amber', 'amber', 'red', 'grey']);
  });

  it('6 Every agent is working: an agent with a day of live work and no action in 24 hours is idle', () => {
    const out = py(`
lh = load("lh", "loop-health.py")
team = [{"id": "recAGENTBUSYxxx01", "fields": {"Name": "Busy agent", "Is AI Agent": True}},
        {"id": "recAGENTIDLExxx01", "fields": {"Name": "Idle agent", "Is AI Agent": True}},
        {"id": "recAGENTNOTExx01", "fields": {"Name": "Noting agent", "Is AI Agent": True}},
        {"id": "recAGENTNEWxxx01", "fields": {"Name": "New work agent", "Is AI Agent": True}}]
def t(i, agent, **f):
    base = {"Task Name": i, "Status": "Today", "Due Date": "2026-10-14", "Team Member": [agent], "Created Time": ago(days=3)}
    base.update(f); return {"id": i, "fields": base}
stamp = (NOW - timedelta(hours=2)).astimezone(L).strftime("%d %b %Y %H:%M")
tasks = [t("recB", "recAGENTBUSYxxx01"), t("recI", "recAGENTIDLExxx01"),
         t("recN", "recAGENTNOTExx01", Notes="[%s — agent] Chased the supplier again." % stamp),
         t("recNEW", "recAGENTNEWxxx01", **{"Created Time": ago(hours=3)}),
         t("recWALLED", "recAGENTIDLExxx01")]
reports = [(NOW - timedelta(hours=5), {"actions": [{"task": "recB", "kind": "carry_out", "ok": True}]})]
f = A.facts_agents(tasks, team, lh, {}, [], {"recWALLED"}, reports, NOW)
l = A.judge_agents(f)
print(json.dumps({"rows": [[a["name"], a["live"], a["acted"]] for a in f["agents"]], "answer": l["answer"], "colour": l["colour"]}))`);
    // The new-work agent has had its work under a day, so it is not held to it yet; the walled task is No bottlenecks'.
    expect(out.rows).toEqual([['Idle agent', 1, false], ['Busy agent', 1, true], ['Noting agent', 1, true]]);
    expect(out.answer).toBe('1 idle, 2 of 3 worked today');
    expect(out.colour).toBe('amber');
    expect(colours(`[A.judge_agents({"agents": [{"name": "a", "live": 1, "acted": i >= n} for i in range(5)]}) for n in (0, 1, 2)] + [A.judge_agents({"error": "x"})]`))
      .toEqual(['green', 'amber', 'red', 'grey']);
  });

  it('7 No job is broken: Failed rows by name, robots-blocked left to line 4, the other scripts\' rows read too', () => {
    const out = py(`
rows = [{"key": "job-a", "label": "Job A", "status": "Failed", "detail": "exit code 1"},
        {"key": "agent-blockers", "label": "Robots blocked", "status": "Failed"},
        {"key": "job-b", "label": "Job B", "status": "Worked"}]
stored = {"tenant-chain": {"status": "Failed", "label": "Tenant chain"}, "job-b": {"status": "Failed", "label": "stale copy"}}
f = A.facts_jobs(rows, stored, None)
print(json.dumps({"names": [i["name"] for i in f["failed"]],
                  "grey": col(A.judge_jobs(A.facts_jobs(rows, {}, "HTTP 429"))),
                  "redAnyway": col(A.judge_jobs(A.facts_jobs(rows * 3, {}, "HTTP 429")))}))`);
    expect(out.names).toEqual(['Job A', 'Tenant chain']);       // this pass's own row beats a stale stored copy
    expect(out.grey).toBe('amber');                             // 1 known failure, the rest unread: at least 1, partly read (review 2)
    expect(out.redAnyway).toBe('red');                          // 3 known failures are red whatever is unread
    expect(colours(`[A.judge_jobs({"failed": [A.item("j")] * n}) for n in (0, 1, 2, 3)]`))
      .toEqual(['green', 'amber', 'amber', 'red']);
  });

  it('8 No bugs or errors: red when more are open than a week ago; green when not and fixed keeps up; amber when filed beats fixed', () => {
    const j = (code, before, filed, fixed) => `A.judge_bugs({"code": ${code}, "codeWeekAgo": ${before}, "filed7d": ${filed}, "fixed7d": ${fixed}})`;
    expect(colours(`[${j(160, 150, 10, 20)}, ${j(140, 150, 10, 20)}, ${j(140, 150, 20, 10)}, ${j(150, 150, 5, 5)}]`))
      .toEqual(['red', 'green', 'amber', 'green']);
    expect(colours(`[A.judge_bugs({"code": 140, "codeWeekAgo": None, "weekAgoError": "log unreadable"}), A.judge_bugs({"error": "x"})]`))
      .toEqual(['grey', 'grey']);
    // The week-ago number is the real fold of the findings log cut 7 days back.
    const out = py(`
es = load("es", "estate-status.py")
fm = load("fm", "findings.py")
t = lambda d: iso(NOW - timedelta(days=d))
ops = [{"op": "add", "id": "f1", "ts": t(10), "touches_code": True},
       {"op": "add", "id": "f2", "ts": t(9), "touches_code": True},
       {"op": "add", "id": "f3", "ts": t(8), "touches_code": False},
       {"op": "land", "id": "f1", "ts": t(2)},
       {"op": "add", "id": "f4", "ts": t(1), "touches_code": True}]
fm.read_all = lambda: ops
print(json.dumps([es.defects_as_of(fm, ops, NOW - timedelta(days=7)), es.defects_as_of(fm, ops, NOW)]))`);
    expect(out[0]).toEqual({ open: 3, code: 2 });                // f1, f2 code, f3 not, f4 not yet filed
    expect(out[1]).toEqual({ open: 3, code: 2 });                // f1 fixed, f4 filed
  });

  it('9 The data is accurate: green pass, red broken with each check named, grey when not run in 26 hours', () => {
    const out = py(`
d = tempfile.mkdtemp(); p = os.path.join(d, "last.log")
open(p, "w").write("PASS   report-amount-populated\\n       asserts: x\\n\\nFAIL   ceo-brief-complete\\n       1 VIOLATION(S)\\n\\nERROR  kpi-library-coverage\\n\\nRESULT: INVARIANT BROKEN — do not deploy\\n")
os.utime(p, (NOW.timestamp() - 3600,) * 2)
broken = A.read_invariants(p)
open(p, "w").write("PASS   report-amount-populated\\n\\nRESULT: all invariants hold\\n"); os.utime(p, (NOW.timestamp() - 3600,) * 2)
ok = A.read_invariants(p)
os.utime(p, (NOW.timestamp() - 27 * 3600,) * 2)
old = A.read_invariants(p)
open(p, "w").write("PASS   x\\n"); os.utime(p, (NOW.timestamp() - 3600,) * 2)
noresult = A.read_invariants(p)
ls = [A.judge_data(x, NOW) for x in (broken, ok, old, noresult, A.read_invariants(os.path.join(d, "none")))]
print(json.dumps({"colours": [col(l) for l in ls], "names": [i["name"] for i in ls[0]["items"]], "answer": ls[0]["answer"]}))`);
    expect(out.colours).toEqual(['red', 'green', 'grey', 'grey', 'grey']);
    expect(out.names).toEqual(['ceo brief complete', 'kpi library coverage']);
    expect(out.answer).toBe('2 data checks found wrong data');
  });

  it('10 Nothing\'s getting missed: parks with no door, jobs that gave up or missed, old mail undecided; green 0, amber 1, red 2+', () => {
    expect(colours(`[A.judge_missed({"parks": [A.item("p")] * a, "gaveUp": [A.item("g")] * b, "undecided": []}) for a, b in ((0, 0), (1, 0), (1, 1))]`))
      .toEqual(['green', 'amber', 'red']);
    // A part that cannot be read: grey unless what was read is already red.
    expect(colours(`[A.judge_missed({"parks": [A.item("p")], "errors": ["the job queue log is missing"]}),
                     A.judge_missed({"parks": [A.item("p")] * 2, "errors": ["the job queue log is missing"]})]`))
      .toEqual(['amber', 'red']);   // a known miss shows in its colour, partly read (review 2)
    const out = py(`
lh = load("lh", "loop-health.py"); D = lh.dispatcher()
AG = "recAGENTxxxxxxx01"
def t(i, **f):
    base = {"Task Name": i, "Status": "Today", "Due Date": "2026-10-15", "Team Member": [AG]}
    base.update(f); return {"id": i, "fields": base}
tasks = [t("recSILENT"), t("recCARDED", Status="Approval"), t("recDOOR"), t("recLATERWORK"), t("recDONE", Status="Completed")]
rep1 = {"actions": [{"task": i, "kind": "new", "ok": False, "error": "no card: waiting on something"} for i in
                    ("recSILENT", "recCARDED", "recDOOR", "recLATERWORK", "recDONE")]}
rep2 = {"actions": [{"task": "recLATERWORK", "kind": "submit", "ok": True}]}
reports = [(NOW - timedelta(hours=6), rep1), (NOW - timedelta(hours=2), rep2)]
passes = lambda: {"recDOOR": {"began": ago(hours=3), "door": "an open task"}}
parks, err = A.facts_parks(reports, tasks, {AG}, lh, D, NOW, passes)
ev = [{"ts": ago(hours=3), "job": "feed-brain", "state": "queue-timeout"}, {"ts": ago(hours=4), "job": "feed-brain", "state": "queue-timeout"},
      {"ts": ago(hours=30), "job": "old-job", "state": "queue-timeout"}, {"ts": ago(hours=1), "job": "x", "state": "acquired"}]
gave, _late = A.facts_gave_up(ev, [{"key": "late-job", "label": "Late job", "status": "Missed"}], NOW, {"feed-brain": {"label": "Brain feed"}})
print(json.dumps({"parks": [i["id"] for i in parks], "err": err, "gave": [i["name"] for i in gave]}))`);
    expect(out.parks).toEqual(['recSILENT']);                  // a card, a door, a later outcome and a close all excuse
    expect(out.err).toBeNull();
    expect(out.gave).toEqual(['Brain feed', 'Late job']);      // one per job, inside 24 hours, by its board name
  });

  it('11 Agents are on top of their work: green done >= new, amber 80% or more, red below', () => {
    expect(colours(`[A.judge_ontop({"in": i, "done": d}) for i, d in ((100, 100), (100, 80), (100, 79), (0, 0))] + [A.judge_ontop({"error": "x"})]`))
      .toEqual(['green', 'amber', 'red', 'green', 'grey']);
  });

  it('12 Your queue is under control: counted from when a card last reached Kevin, never Last Updated', () => {
    const j = (n, days) => `A.judge_queue({"cards": [{"id": "r", "name": "c", "days": ${days}, "dated": True}] * ${n}})`;
    expect(colours(`[${j(10, 2)}, ${j(11, 1)}, ${j(5, 3)}, ${j(26, 1)}, ${j(3, 6)}, A.judge_queue({"error": "x"})]`))
      .toEqual(['green', 'amber', 'amber', 'red', 'red', 'grey']);
    const out = py(`
def t(i, notes="", **f):
    base = {"Task Name": i, "Status": "Approval", "Notes": notes, "Created Time": ago(days=20)}
    base.update(f); return {"id": i, "fields": base}
sub = lambda d, h: "[%s — agent-dispatch] SUBMITTED (round 1) as Admin with no new file" % (NOW - timedelta(days=d, hours=h)).astimezone(L).strftime("%d %b %Y %H:%M")
tasks = [t("recSUBMITTED", sub(9, 0) + "\\n" + sub(1, 12)),                       # the newest send counts
         t("recESCALATED", "[%s — agent-dispatch] Escalated to Kevin as a decision card (holder x): ask" % (NOW - timedelta(days=4)).astimezone(L).strftime("%d %b %Y")),
         t("recBACKFROMDEFER", sub(9, 0), **{"Deferred Until": "2026-10-14"}),     # back in the queue since the 14th
         t("recSTILLDEFERRED", sub(9, 0), **{"Deferred Until": "2026-10-20"}),
         t("recNOSTAMP"), t("recNOTQUEUE", sub(1, 0), Status="Today")]
f = A.facts_queue(tasks, NOW)
print(json.dumps({c["id"]: [round(c["days"], 1), c["dated"]] for c in f["cards"]} | {"undated": f["undated"]}))`);
    expect(out.recSUBMITTED).toEqual([1.5, true]);
    expect(out.recESCALATED[1]).toBe(true);
    expect(out.recESCALATED[0]).toBeGreaterThan(4);              // a date-only stamp counts from that day's start
    expect(out.recBACKFROMDEFER).toEqual([1.5, true]);           // 14 Oct 00:00 London to 15 Oct 12:00
    expect(out.recNOSTAMP).toEqual([20, false]);                 // from creation, and it says so
    expect(out.recSTILLDEFERRED).toBeUndefined();
    expect(out.recNOTQUEUE).toBeUndefined();
    expect(out.undated).toBe(1);
  });

  it('13 Drafts are right first time: green 85%+, amber 70-85%, red under 70%; grey on no verdicts or a read that missed some', () => {
    const j = (asIs, total) => `A.judge_firsttime({"asIs": ${asIs}, "total": ${total}})`;
    expect(colours(`[${j(85, 100)}, ${j(84, 100)}, ${j(70, 100)}, ${j(69, 100)}, ${j(0, 0)}]`))
      .toEqual(['green', 'amber', 'amber', 'red', 'grey']);
    const out = py(`
aar = load("aar", "agent-accuracy-report.py")
dec = lambda i, o, h: {"id": i, "fields": {"Approval Outcome": o, "Approved At": ago(hours=h), "Sent For Approval By": ["recAGENTxxxxxxx01"], "Task Name": i}}
decided = [dec("r1", "Approved as-is", 5), dec("r2", "Changes requested", 30), dec("rOLD", "Rejected", 24 * 15)]
board = [dec("r1", "Approved as-is", 5), dec("r2", "Changes requested", 30)]
good = A.facts_firsttime(decided, board, aar, NOW)
bad = A.facts_firsttime(decided[:1], board, aar, NOW)          # the 14-day read lost one the board shows
print(json.dumps({"good": good, "bad": bad}))`);
    expect(out.good).toMatchObject({ asIs: 1, changes: 1, rejected: 0, total: 2, control: 2 });   // the 15-day-old one is out
    expect(out.bad.error).toMatch(/missed 1 the task board shows \(r2\)/);
  });

  it('14 Enough allowance: red paused now, amber a pause this week, green none; grey when the guard cannot be read', () => {
    const out = py(`
class AL:
    def __init__(self, st): self.st = st
    def cmd_status(self, now=None):
        if self.st is None: raise RuntimeError("allowance.json unreadable")
        return self.st
now_paused = {"paused": True, "paused_until": ago(hours=-5), "seen_at": ago(hours=3)}
past = {"paused": False, "last_outage": {"seen_at": ago(days=2, hours=4), "paused_until": ago(days=2)}}
old = {"paused": False, "last_outage": {"seen_at": ago(days=30), "paused_until": ago(days=29)}}
row_hit = [{"key": "triage", "label": "Inbox sort", "detail": "The Claude allowance ran out (resets 19:00). The job did no work."}]
ls = [A.judge_allowance(A.facts_allowance(AL(s), r, NOW), NOW) for s, r in
      ((now_paused, []), (past, []), (old, []), (old, row_hit), (None, []))]
print(json.dumps([[col(l), l["number"]] for l in ls]))`);
    expect(out).toEqual([['red', 3], ['amber', 4], ['green', 0], ['amber', 0], ['grey', null]]);
  });
});

describe('the verdict, the groups and the trend', () => {
  const lines = (spec) => `[A.line(d["key"], c, "a", 1) if c != "grey" else A.grey(d["key"], "x") for d, c in zip(A.LINES, ${spec})]`;

  it('green Healthy: no red and at most two amber, every line read', () => {
    const out = py(`print(json.dumps([A.overall_verdict(${lines('["amber"] * 2 + ["green"] * 12')}), A.overall_verdict(${lines('["amber"] * 3 + ["green"] * 11')})]))`);
    expect(out[0]).toMatchObject({ colour: 'green', text: 'Healthy' });
    expect(out[1]).toMatchObject({ colour: 'red', text: 'Needs attention: Emails are getting cleared' });   // 3 amber, nothing improving
  });

  it('a grey line is named and never counted as green', () => {
    const out = py(`print(json.dumps(A.overall_verdict(${lines('["grey", "green"] + ["green"] * 12')})))`);
    expect(out.colour).toBe('amber');
    expect(out.text).toBe("Healthy where it can be read · 1 line can't be read: Emails are getting cleared");
    expect(out.greyLines).toEqual(['emails']);
  });

  it('amber "Issues, but going the right way" needs more lines better than worse than a week ago; red names the worst line', () => {
    const out = py(`
ls = ${lines('["amber", "amber", "red"] + ["green"] * 11')}
for l, d in zip(ls, ["better", "better", "same"] + [None] * 11):
    l["trend"] = {"direction": d}
up = A.overall_verdict(ls)
for l in ls[:2]: l["trend"] = {"direction": "same"}
print(json.dumps([up, A.overall_verdict(ls)]))`);
    expect(out[0]).toMatchObject({ colour: 'amber', text: 'Issues, but going the right way', better: 2, worse: 0 });
    expect(out[1]).toMatchObject({ colour: 'red', text: "Needs attention: Everything's moving", worst: 'moving' });
  });

  it('three groups, each with its own colour and counts', () => {
    const out = py(`print(json.dumps(A.group_verdicts(${lines('["green"] * 5 + ["red", "grey"] + ["green"] * 3 + ["grey"] * 4')})))`);
    expect(out.map(g => [g.title, g.colour, g.text])).toEqual([
      ['Is work flowing?', 'green', 'All 5 green'],
      ['Is anything broken?', 'red', "1 red, 1 can't tell"],
      ['Can it keep going?', 'grey', "0 green, 4 can't tell"],
    ]);
  });

  it('history: one snapshot per London day (the newest wins), 30 days kept, the trend against 7 days back', () => {
    const out = py(`
day = lambda d: (NOW.astimezone(L).date() - timedelta(days=d)).isoformat()
hist = {day(d): {"emails": 10 + d, "ontop": 50} for d in range(1, 40)}
hist[day(0)] = {"emails": 99}                                   # an earlier pass today, overwritten
ls = [A.line("emails", "amber", "a", 4), A.line("ontop", "green", "a", 90), A.grey("data", "x")]
h = A.apply_history(ls, hist, NOW)
print(json.dumps({"days": len(h), "oldest": min(h), "today": {k: v for k, v in h[day(0)].items() if k != A.COLOUR_KEY}, "trends": [l["trend"] for l in ls]}))`);
    expect(out.days).toBe(30);
    expect(out.oldest).toBe('2026-09-16');
    expect(out.today).toEqual({ emails: 4, ontop: 90 });             // a grey line writes no number
    expect(out.trends[0]).toMatchObject({ vsDate: '2026-10-08', before: 17, after: 4, direction: 'better', fullWeek: true });
    expect(out.trends[1]).toMatchObject({ before: 50, after: 90, direction: 'better' });   // higher is better here
    expect(out.trends[2]).toMatchObject({ before: null, direction: null });
  });

  it('before a week of history the trend runs from the oldest day there is, and says so', () => {
    const out = py(`
ls = [A.line("emails", "amber", "a", 4)]
A.apply_history(ls, {"2026-10-13": {"emails": 2}}, NOW)
first = [A.line("emails", "amber", "a", 4)]
A.apply_history(first, {}, NOW)
print(json.dumps([ls[0]["trend"], first[0]["trend"]]))`);
    expect(out[0]).toMatchObject({ vsDate: '2026-10-13', before: 2, direction: 'worse', fullWeek: false });
    expect(out[1]).toMatchObject({ vsDate: null, before: null, direction: null, since: '2026-10-15' });
  });

  it('the local copy fills a day the row lost, and a fuller day beats a partial one', () => {
    const out = py(`print(json.dumps(A.merge_history({"2026-10-10": {"a": 1}}, {"2026-10-10": {"a": 1, "b": 2}, "2026-10-09": {"a": 5}, "bad": {}})))`);
    expect(out).toEqual({ '2026-10-10': { a: 1, b: 2 }, '2026-10-09': { a: 5 } });
  });
});

// Every reader stubbed, shared by the row tests and the review tests below.
const stubs = (over = '') => `
lh = load("lh", "loop-health.py")
class ES:
    def loop_health_module(self): return lh
AG = "recAGENTxxxxxxx01"
team = [{"id": AG, "fields": {"Name": "Agent", "Is AI Agent": True}}]
lh_res = {"_tasks": [], "_team": team, "_ledger": {}, "_heldIds": [], "flow": {"agentCreated7d": 10, "agentDone7d": 10},
          "agentWork": {"live": 10, "approval": 0, "waitingReply": 0, "scheduled": 0, "open": 10, "stuckIds": [], "heldCheck": None}}
measures = {"defects": {"code": 5, "codeWeekAgo": 6, "filed7d": 1, "fixed7d": 2}, "rework": {"pct": 30, "days": 14, "fixes": 10, "fixOfFix": 3, "baselinePct": 32}}
class TM: CLOCK_DAYS = {"SIGN-IN": 1, "TOOL": 3, "KEVIN": 3}
class AL:
    def cmd_status(self, now=None): return {"paused": False}
readers = {"lh": lh, "tm": TM, "tri": None, "aar": load("aar", "agent-accuracy-report.py"), "al": AL(),
           "blockers": lambda: {"readAt": iso(NOW), "openTasksRead": 1, "open": []},
           "queue": lambda: {"generatedAt": iso(NOW), "worklist": []},
           "reports": lambda: ([], []),
           "triage": lambda: {"left": 0, "truncated": False, "scannedAt": ago(hours=1), "scoredDay": "2026-10-15",
                              "slot": {"state": "ok", "name": "09:00", "date": "2026-10-15"}, "items": [], "undecided": []},
           "board": lambda: {}, "invariants": lambda: {"ranAt": ago(hours=4), "result": "pass", "broken": [], "checks": 3},
           "events": lambda: [], "passes": lambda: {}, "decided": lambda: [
               {"id": "r%d" % i, "fields": {"Approval Outcome": "Approved as-is", "Approved At": ago(hours=5), "Sent For Approval By": [AG], "Task Name": "t"}} for i in range(9)],
           "history": lambda: ({}, None), "finishes": lambda: [], "limitHits": lambda: ([], []),
           "schedule": lambda: {}}
${over}
row = A.verdict_row(NOW, ES(), [], lh_res, None, measures, readers)
p = json.loads(row["payload"]) if row.get("payload") else None
print(json.dumps({"status": row["status"], "detail": row["detail"], "key": row["key"],
                  "lines": p and [[l["key"], l["colour"]] for l in p["lines"]], "overall": p and p["overall"],
                  "bugs": p and next(l for l in p["lines"] if l["key"] == "bugs")["trend"]}))`;

describe('the row', () => {
  // Every reader stubbed: the row must hold fourteen lines and the verdict, and a reader that
  // throws must turn its own line grey, never the whole row Failed and never a green.

  it('carries fourteen lines in Kevin\'s order, three groups and one verdict', () => {
    const out = py(stubs());
    expect(out.status).toBe('Worked');
    expect(out.key).toBe('ai-team-verdict');
    expect(out.lines.map(l => l[0])).toEqual(['emails', 'responses', 'moving', 'bottlenecks', 'carried', 'agents', 'jobs',
      'bugs', 'data', 'missed', 'ontop', 'queue', 'firsttime', 'allowance']);
    expect(out.lines.every(l => l[1] === 'green')).toBe(true);
    expect(out.overall).toMatchObject({ colour: 'green', text: 'Healthy', grey: 0 });
    // The row's detail is the simpler view's answer and number (15 Oct 2026).
    expect(out.detail).toBe('Working well: 0 things need a fix.');
    // No bugs or errors shows a real week's trend on day one, from the queue's own log.
    expect(out.bugs).toMatchObject({ vsDate: '2026-10-08', before: 6, after: 5, direction: 'better' });
  });

  it('a source that throws turns only its own line grey, and the verdict names it', () => {
    const out = py(stubs(`readers["board"] = lambda: (_ for _ in ()).throw(RuntimeError("HTTP 503"))
readers["decided"] = lambda: (_ for _ in ()).throw(RuntimeError("HTTP 429"))`));
    expect(out.status).toBe('Worked');
    expect(out.lines.filter(l => l[1] === 'grey').map(l => l[0])).toEqual(['jobs', 'firsttime']);
    expect(out.overall.colour).toBe('amber');
    expect(out.overall.text).toMatch(/2 lines can't be read: No job is broken, Drafts are right first time$/);
  });

  it('a failed board read greys every line built on it, never a green zero', () => {
    const out = py(stubs().replace('row = A.verdict_row(NOW, ES(), [], lh_res, None, measures, readers)',
      'row = A.verdict_row(NOW, ES(), [], None, "could not read Airtable", measures, readers)'));
    const grey = out.lines.filter(l => l[1] === 'grey').map(l => l[0]);
    expect(grey).toEqual(['responses', 'moving', 'agents', 'missed', 'ontop', 'queue', 'firsttime']);
    expect(out.overall.colour).not.toBe('green');
  });
});

describe('loop-health hands the stuck ids on', () => {
  it('agent_work lists the id of every stuck task it counts, so a wall can be taken out by id', () => {
    const out = py(`
lh = load("lh", "loop-health.py")
AG = "recAGENTxxxxxxx01"
tasks = [{"id": i, "fields": {"Task Name": i, "Status": "Today", "Due Date": "2026-10-14", "Team Member": [AG]}} for i in ("recS1", "recS2", "recFINE")]
stalled = [{"id": "recS1", "rule": "draft"}, {"id": "recS2", "rule": "amend"}, {"id": "recNOTAGENT", "rule": "draft"}]
aw = lh.agent_work(tasks, {AG}, stalled, [], now=NOW, ledger={})
print(json.dumps({"ids": aw["stuckIds"], "n": aw["notMoving"]}))`);
    expect(out).toEqual({ ids: ['recS1', 'recS2'], n: 2 });
  });
});

// ─── The independent review of PR #790 (15 Oct 2026) ─────────────────
// The bar: no line or verdict may read better than the truth. Each test below failed on the
// code as first pushed and passes on the fix.
describe('review of PR #790: nothing reads better than the truth', () => {
  it('1 a build that fails clears the payload, so the page can never show the last good verdict as new', () => {
    const out = py(stubs(`readers["blockers"] = lambda: (_ for _ in ()).throw(RuntimeError("disk full"))
es = load("es", "estate-status.py")`).replace('print(json.dumps({"status"', 'f = es.to_fields(row, NOW)\nprint(json.dumps({"payloadField": f.get(es.ES["payload"], "absent"), "status"'));
    expect(out.status).toBe('Failed');
    expect(out.detail).toMatch(/could not be built: RuntimeError: disk full/);
    expect(out.payloadField).toBe('');                        // written, and empty: the old verdict is gone
  });

  it('2 the verdict: more than 2 grey lines is "Can\'t tell"; better and worse count only on red and amber lines; a red line getting worse is red', () => {
    const v = (spec, dirs) => `(lambda ls: ([l.__setitem__("trend", {"direction": d}) for l, d in zip(ls, ${dirs})], A.overall_verdict(ls))[1])(
        [A.line(d["key"], c, "a", 1) if c != "grey" else A.grey(d["key"], "x") for d, c in zip(A.LINES, ${spec})])`;
    const out = py(`print(json.dumps([
      ${v('["grey"] * 14', '[None] * 14')},
      ${v('["grey"] * 3 + ["green"] * 11', '[None] * 14')},
      ${v('["red"] * 5 + ["green"] * 6 + ["amber"] * 3', '["worse"] * 5 + ["better"] * 6 + ["same"] * 3')},
      ${v('["red", "amber", "amber"] + ["green"] * 11', '["better", "worse", "worse"] + ["better"] * 11')},
      ${v('["red", "amber", "amber"] + ["green"] * 11', '["better", "better", "same"] + [None] * 11')},
      ${v('["green", "red"] + ["grey"] * 3 + ["green"] * 9', '[None] * 14')}]))`);
    expect(out[0].colour).toBe('grey');
    expect(out[0].text).toMatch(/^Can't tell: 14 lines can't be read/);
    expect(out[1].colour).toBe('grey');
    expect(out[1].text).toMatch(/^Can't tell: 3 lines can't be read/);
    expect(out[2]).toMatchObject({ colour: 'red', text: 'Needs attention: Emails are getting cleared' });   // greens improving never cover it
    expect(out[3]).toMatchObject({ colour: 'red', better: 1, worse: 2 });                                   // only red and amber lines count
    expect(out[4]).toMatchObject({ colour: 'amber', text: 'Issues, but going the right way' });
    expect(out[5]).toMatchObject({ colour: 'red', text: expect.stringMatching(/^Needs attention: Responses are getting written · 3 lines can't be read/) });
  });

  it('3 a Blocked job counts as broken (an expired sign-in, no network, killed for running too long); only Claude-limit pauses are left to line 14', () => {
    const out = py(`
rows = [{"key": "a", "label": "Job A", "status": "Blocked", "detail": "A sign-in has expired. Kevin needs to sign the robot in again."},
        {"key": "b", "label": "Job B", "status": "Blocked", "detail": "The Claude allowance ran out (resets 19:00). The job did no work."},
        {"key": "allowance", "label": "Claude allowance", "status": "Blocked", "detail": "The Claude allowance ran out (seen Sun 13:00)."},
        {"key": "c", "label": "Job C", "status": "Failed", "detail": "exit code 1"}]
l = A.judge_jobs(A.facts_jobs(rows, {}, None))
print(json.dumps({"names": [i["name"] for i in l["items"]], "answer": l["answer"], "extra": l["extra"]}))`);
    expect(out.names).toEqual(['Job A', 'Job C']);
    expect(out.answer).toBe('2 jobs failed or were blocked');
    expect(JSON.stringify(out.extra)).not.toMatch(/see No bottlenecks/);
  });

  it('4 a Claude-limit stop the guard missed is read from the jobs\' own run logs (the 3-4 Oct shape)', () => {
    const out = py(`
d = tempfile.mkdtemp()
for job, (start, done) in {"inbound-triage": ("Sun Oct  4 13:00:03", "Sun Oct  4 13:00:30"), "task-manager": ("Sun Oct  4 17:20:05", "Sun Oct  4 17:20:18")}.items():
    os.makedirs(os.path.join(d, job))
    open(os.path.join(d, job, "runs.log"), "w").write(
        "===== %s run [13:00 slot] %s BST 2026 =====\\n"
        "You've hit your weekly limit · resets 7pm (Europe/London)\\n"
        "===== done rc=1 %s BST 2026 =====\\n"
        "===== %s run later =====\\nA summary that quotes it: the slot said You've hit your weekly limit\\n" % (job, start, done, job))
al = load("al", "allowance.py")
class AL:
    def cmd_status(self, now=None): return {"paused": False, "last_outage": {"seen_at": "2026-09-15T10:30:53Z", "paused_until": "2026-09-15T10:40:00Z"}}
    LIMIT_RE = al.LIMIT_RE
    def parse_reset(self, text, now): return al.parse_reset(text, now)
res = []
for when in (datetime(2026, 10, 4, 18, 0, tzinfo=L), datetime(2026, 10, 6, 10, 0, tzinfo=L), datetime(2026, 10, 15, 12, 0, tzinfo=L)):
    hits, bad = A.read_limit_hits(when.astimezone(timezone.utc), al, d)
    l = A.judge_allowance(A.facts_allowance(AL(), [], when.astimezone(timezone.utc), hits), when.astimezone(timezone.utc))
    res.append([col(l), l["number"], len(hits)])
print(json.dumps(res))`);
    expect(out[0]).toEqual(['red', 5, 2]);       // 4 Oct 18:00: stopped since 13:00, back at 19:00
    expect(out[1]).toEqual(['amber', 6, 2]);     // 6 Oct: a 6-hour stop this week, running again
    expect(out[2]).toEqual(['green', 0, 0]);     // 15 Oct: older than a week
  });

  it('5 "a week ago" is each finding\'s status then, judged by today\'s merges and today\'s code tag', () => {
    const out = py(`
es = load("es", "estate-status.py")
fm = load("fm", "findings.py")
t = lambda d: iso(NOW - timedelta(days=d))
ops = [{"op": "add", "id": "f1", "ts": t(10), "touches_code": True},
       {"op": "add", "id": "f2", "ts": t(9), "touches_code": True},
       {"op": "add", "id": "f3", "ts": t(8), "touches_code": True},
       {"op": "dupe", "id": "f1", "of": "f2", "ts": t(2)},                   # merged as a repeat since
       {"op": "retag", "id": "f3", "touches_code": False, "ts": t(1)},       # found not to need code since
       {"op": "add", "id": "f4", "ts": t(1), "touches_code": True}]
fm.read_all = lambda: ops
print(json.dumps(es.defects_as_of(fm, ops, NOW - timedelta(days=7))))`);
    expect(out).toEqual({ open: 2, code: 1 });   // f1 is a repeat by today's rules; f3 is not code by today's tag
  });

  it('7 history keeps the last real number for each line each day; a grey, missed or part-read line stores nothing', () => {
    const out = py(`
day = NOW.astimezone(L).date().isoformat()
missed = A.judge_emails({"slot": {"state": "missed", "name": "13:00", "date": day}, "left": 3}, NOW)
part = A.judge_jobs(A.facts_jobs([{"key": k, "label": k, "status": "Failed"} for k in "abcd"], {}, "HTTP 503"))
ls = [missed, A.grey("data", "x"), A.line("queue", "green", "a", 4), part]
h = A.apply_history(ls, {day: {"emails": 2, "data": 5, "queue": 9, "jobs": 1}}, NOW)
print(json.dumps({"today": {k: v for k, v in h[day].items() if k != A.COLOUR_KEY}, "emailsNumber": missed["number"], "partTrend": part["trend"]}))`);
    expect(out.emailsNumber).toBeNull();                                  // never yesterday's count under a missed slot
    expect(out.today).toEqual({ emails: 2, data: 5, queue: 4, jobs: 1 }); // earlier real numbers kept; queue updated
    expect(out.partTrend.direction).toBeNull();                           // a floor has no direction
  });

  it('8 a slot whose record said ok but whose run never finished is red once it is past its run time', () => {
    const out = py(`
tri = load("tri", "inbound-triage.py")
class ES:
    def load_schedule(self): return {"inbound-triage": {"cron": "0 9,13,17 * * *", "maxRuntimeMinutes": 150}}
    def last_due(self, cron, now): return datetime(2026, 10, 15, 8, 0, tzinfo=timezone.utc)   # the 09:00 slot
def run(log, now):
    d = tempfile.mkdtemp()
    at = int((datetime(2026, 10, 15, 8, 10, tzinfo=timezone.utc)).timestamp() * 1000)
    json.dump({"history_detail": {"2026-10-15": {"inbox_over_2_days": 0}}, "last_scan_ok_ms": at,
               "last_scan_stale": {"ids": [], "at_ms": at}}, open(os.path.join(d, "state.json"), "w"))
    open(os.path.join(d, "slot-results.jsonl"), "w").write(json.dumps({"ts": "2026-10-15T09:00:20+01:00", "date": "2026-10-15", "slot": "09:00", "lane": "email", "ok": True}) + "\\n")
    open(os.path.join(d, "runs.log"), "w").write(log)
    l = A.judge_emails(A.facts_emails(A.read_triage(now, tri, ES(), base=d)), now)
    return [col(l), l["answer"]]
head = "===== done rc=0 Wed Oct 14 18:12:08 BST 2026 =====\\n===== inbound-triage run [09:00 slot] Thu Oct 15 09:00:00 BST 2026 =====\\n"
late = datetime(2026, 10, 15, 11, 50, tzinfo=timezone.utc)      # 12:50 London: past 09:00 + 150 + 15 minutes
early = datetime(2026, 10, 15, 9, 0, tzinfo=timezone.utc)       # 10:00 London: still inside its run time
print(json.dumps([run(head, late), run(head, early),
                  run(head + "===== done rc=0 Thu Oct 15 09:47:56 BST 2026 =====\\n", late),
                  run(head + "===== done rc=1 Thu Oct 15 09:47:56 BST 2026 =====\\n", late)]))`);
    expect(out[0]).toEqual(['red', 'The 09:00 inbox run did not finish']);
    expect(out[1][0]).toBe('green');
    expect(out[2]).toEqual(['green', 'Inbox clear']);
    expect(out[3]).toEqual(['red', 'The 09:00 inbox run ended with an error']);
  });

  it('9 a job that gave up but ran cleanly before its next due time ran late, not missed; one that skipped a whole cycle counts', () => {
    const out = py(`
# The backlog job runs through job-queue.py alone: its clean finish is only in the queue's own log,
# as on 15 Oct 2026 (gave up at 00:01, 02:01 and 04:01, then "finished", exit 0, at 05:03).
ev = [{"ts": ago(hours=h), "job": "backlog", "state": "queue-timeout"} for h in (12, 10, 8)] + [
      {"ts": ago(hours=7), "job": "backlog", "state": "finished", "exit": 0},
      {"ts": ago(hours=7), "job": "nightly", "state": "queue-timeout"},
      {"ts": ago(hours=6), "job": "brainfeed", "state": "queue-timeout"},
      {"ts": ago(hours=2), "job": "brainfeed", "state": "finished", "exit": 1}]
finishes = [{"ts": ago(hours=5), "job": "nightly", "ok": True}, {"ts": ago(hours=1), "job": "brainfeed", "ok": False}]
schedule = {"nightly": {"cron": "40 22 * * *"}, "brainfeed": {"cron": "45 22 * * *"}}
nd = lambda cron, t: iso(t + timedelta(hours=10))
gave, late = A.facts_gave_up(ev, [], NOW, {}, finishes, schedule, nd)
print(json.dumps({"gave": [[i["name"], i["note"]] for i in gave], "late": [i["name"] for i in late]}))`);
    // gave up, and every run since failed; its next due time is still ahead, so it says "has not run since"
    expect(out.gave).toEqual([['brainfeed', expect.stringMatching(/^gave up waiting at .+, and has not run cleanly since$/)]]);
    expect(out.late.sort()).toEqual(['backlog', 'nightly']);
  });

  it('lower: line 8 says "code problems"; lines 6 and 11 show the number their trend arrow compares', () => {
    const out = py(`
b = A.judge_bugs({"code": 167, "codeWeekAgo": 127, "open": 171, "filed7d": 10, "fixed7d": 5})
a = A.judge_agents({"agents": [{"name": "x", "live": 1, "acted": i > 1} for i in range(10)]})
o = A.judge_ontop({"in": 153, "done": 147})
print(json.dumps([b["answer"], dict(b["extra"])["All open problems"], a["answer"], a["number"], o["answer"], o["number"]]))`);
    expect(out[0]).toBe('167 code problems open, up from 127');
    expect(out[1]).toBe('171');
    expect(out[2]).toBe('2 idle, 8 of 10 worked today');
    expect(out[3]).toBe(2);
    expect(out[4]).toBe('96% done: 147 done, 153 new');
    expect(out[5]).toBe(96);
  });
});

// ─── The second review of PR #790 (15 Oct 2026) ──────────────────────
// Each test failed on the code as it stood after round 1 and passes on the fix.
describe('review of PR #790, round 2', () => {
  const board = (spec, dirs) => `(lambda ls: ([l.__setitem__("trend", {"direction": d}) for l, d in zip(ls, ${dirs})], ls)[1])(
      [A.line(d["key"], c, "a", 1) if c != "grey" else A.grey(d["key"], "x") for d, c in zip(A.LINES, ${spec})])`;

  it('1 "Can\'t tell" only when the lines it CAN read would be green; otherwise the red and amber rules, with the grey lines named', () => {
    const out = py(`print(json.dumps([
      A.overall_verdict(${board('["grey"] * 3 + ["amber"] * 5 + ["green"] * 6', '[None] * 3 + ["worse"] * 5 + [None] * 6')}),
      A.overall_verdict(${board('["green"] * 3 + ["amber"] * 5 + ["green"] * 6', '[None] * 3 + ["worse"] * 5 + [None] * 6')}),
      A.overall_verdict(${board('["grey"] * 3 + ["amber"] * 2 + ["green"] * 9', '[None] * 14')})]))`);
    expect(out[0].colour).toBe('red');
    expect(out[0].text).toMatch(/^Needs attention: No bottlenecks · 3 lines can't be read: /);
    expect(out[1]).toMatchObject({ colour: 'red', text: 'Needs attention: No bottlenecks' });     // same board, no greys
    expect(out[2].colour).toBe('grey');                                                              // readable lines are fine: can't tell
  });

  it('2 a line that read red earlier today and cannot be read now is never "Healthy": last known red, can\'t read now', () => {
    const out = py(`
day = NOW.astimezone(L).date().isoformat()
first = [A.line(d["key"], "red" if d["key"] == "jobs" else "green", "a", 1) for d in A.LINES]
p1 = A.build_payload(first, {}, NOW - timedelta(hours=2))                     # 11:00 London: jobs read red
later = [A.grey("jobs", "the board could not be read") if d["key"] == "jobs" else A.line(d["key"], "green", "a", 1) for d in A.LINES]
p2 = A.build_payload(later, p1["history"], NOW)
jobs = next(l for l in p2["lines"] if l["key"] == "jobs")
print(json.dumps({"stored": p1["history"][day]["_c"]["jobs"], "overall": p2["overall"], "answer": jobs["answer"],
                  "kept": p2["history"][day]["_c"]["jobs"], "group": next(g for g in p2["groups"] if g["key"] == "broken")}))`);
    expect(out.stored).toEqual(['red', '10:00']);
    expect(out.kept).toEqual(['red', '10:00']);                    // a grey run keeps the day's last real colour
    expect(out.answer).toBe("Can't tell: the board could not be read · Last known: red (10:00); can't read now");
    expect(out.overall.colour).toBe('red');
    expect(out.overall.text).toMatch(/^Needs attention: No job is broken \(last known red at 10:00; can't read now\)/);
    expect(out.group.colour).toBe('red');
  });

  it('3 lines 7 and 10 show what they DO know, in its colour, marked as partly read; grey only when nothing is known', () => {
    const out = py(`
j1 = A.judge_jobs(A.facts_jobs([{"key": "a", "label": "Job A", "status": "Failed"}], {}, "HTTP 503"))
j0 = A.judge_jobs(A.facts_jobs([], {}, "HTTP 503"))
m1 = A.judge_missed({"parks": [A.item("p")], "errors": ["the job queue log is missing"]})
m0 = A.judge_missed({"errors": ["the job queue log is missing"]})
print(json.dumps([[col(l), l["answer"], l.get("partial", False)] for l in (j1, j0, m1, m0)]))`);
    expect(out[0]).toEqual(['amber', 'At least 1 job failed or was blocked (partly read)', true]);
    expect(out[1][0]).toBe('grey');
    expect(out[2]).toEqual(['amber', 'At least 1 thing missed (partly read)', true]);
    expect(out[3][0]).toBe('grey');
  });

  it('4 a finding open a week ago and since merged into a newer report counts once, as its survivor', () => {
    const out = py(`
es = load("es", "estate-status.py")
fm = load("fm", "findings.py")
t = lambda d: iso(NOW - timedelta(days=d))
ops = [{"op": "add", "id": "f1", "ts": t(10), "touches_code": True},
       {"op": "add", "id": "f2", "ts": t(9), "touches_code": True},
       {"op": "add", "id": "f5", "ts": t(2), "touches_code": True},
       {"op": "dupe", "id": "f1", "of": "f5", "ts": t(1)},      # f1 was open a week ago; f5 now carries it
       {"op": "dupe", "id": "f2", "of": "f5", "ts": t(1)}]      # so was f2: the same problem, counted once
fm.read_all = lambda: ops
print(json.dumps([es.defects_as_of(fm, ops, NOW - timedelta(days=7)), es.defects_as_of(fm, ops, NOW)]))`);
    expect(out[0]).toEqual({ open: 1, code: 1 });   // f1 and f2 were open then: one problem, now f5
    expect(out[1]).toEqual({ open: 1, code: 1 });   // f5 today
  });
});

// ─── The third review of PR #790 (15 Oct 2026) ───────────────────────
describe('review of PR #790, round 3', () => {
  it('a line red at 23:50 and grey at 00:10 (London) is still last known red, labelled with its day; never "Healthy"', () => {
    const out = py(`
before = datetime(2026, 10, 14, 23, 50, tzinfo=L)            # Wednesday 23:50 London
after = datetime(2026, 10, 15, 0, 10, tzinfo=L)              # Thursday 00:10 London: a new day
first = [A.line(d["key"], "red" if d["key"] == "jobs" else "green", "a", 1) for d in A.LINES]
p1 = A.build_payload(first, {}, before.astimezone(timezone.utc))
later = [A.grey("jobs", "the board could not be read") if d["key"] == "jobs" else A.line(d["key"], "green", "a", 1) for d in A.LINES]
p2 = A.build_payload(later, p1["history"], after.astimezone(timezone.utc))
jobs = next(l for l in p2["lines"] if l["key"] == "jobs")
# A green reading earlier on the new day wins over the older red: the newest reading counts.
greener = [A.line(d["key"], "green", "a", 1) for d in A.LINES]
p3 = A.build_payload(greener, p1["history"], datetime(2026, 10, 15, 0, 5, tzinfo=L).astimezone(timezone.utc))
p4 = A.build_payload([A.grey("jobs", "x") if d["key"] == "jobs" else A.line(d["key"], "green", "a", 1) for d in A.LINES],
                     p3["history"], after.astimezone(timezone.utc))
print(json.dumps({"answer": jobs["answer"], "overall": p2["overall"], "afterGreen": p4["overall"]["colour"]}))`);
    expect(out.answer).toBe("Can't tell: the board could not be read · Last known: red (Wed 23:50); can't read now");
    expect(out.overall.colour).toBe('red');
    expect(out.overall.text).toMatch(/^Needs attention: No job is broken \(last known red at Wed 23:50; can't read now\)/);
    expect(out.afterGreen).toBe('amber');                    // its newest reading was green: "Healthy where it can be read"
  });
});

// ─── The simpler view (Kevin, 15 Oct 2026: "too cluttered and confusing") ──
// One number ("Things needing a fix"), weekly bars, three lights and one answer. Each test drives
// the real functions. Names and ids are invented: this repo is public.
describe('the simpler view: one number, weekly bars, three lights, one answer', () => {
  // A board where every counting line has something, and the backlog and the rates are bad too.
  const board = `
ok = {"state": "ok", "name": "09:00", "date": "2026-10-15"}
def board(bugs=167, ontop=(100, 10), first=(10, 1)):
    return [
        A.judge_emails({"left": 3, "scannedAt": ago(hours=1), "slot": ok}, NOW),                     # 3
        A.judge_responses({"items": [A.item("r1", "recR1"), A.item("r2", "recR2")]}),               # 2
        A.judge_moving({"stuck": [A.item("s", "recS%d" % i) for i in range(4)], "live": 40}),       # 4 (a 10% share)
        A.judge_bottlenecks({"past": [A.item("b", "recB1")], "total": 3}, NOW),                    # 1
        A.judge_carried({"items": [A.item("c", "recC1")]}),                                        # 1
        A.judge_agents({"agents": [{"id": "recAG1", "name": "Agent", "live": 2, "acted": False}]}), # 1
        A.judge_jobs({"failed": [A.item("Job A")]}),                                               # 1
        A.judge_bugs({"code": bugs, "codeWeekAgo": 120, "filed7d": 9, "fixed7d": 1}),              # never counted
        A.judge_data({"ranAt": ago(hours=2), "result": "broken", "broken": ["check one", "check two"]}, NOW),  # 2
        A.judge_missed({"parks": [A.item("p", "recP1")]}),                                         # 1
        A.judge_ontop({"in": ontop[0], "done": ontop[1]}),                                         # a rate: never counted
        A.judge_queue({"cards": [{"id": "recQ1", "name": "q", "days": 3.0, "dated": True},
                                 {"id": "recQ2", "name": "q2", "days": 0.5, "dated": True}]}),       # 1: only the card over 2 days
        A.judge_firsttime({"total": first[0], "asIs": first[1]}),                                  # a rate: never counted
        A.judge_allowance({"hours7d": 26.0, "pausedNow": False, "items": []}, NOW)]                # 1: a pause is one thing
`;

  it('the number sums the eleven counting lines; the code-problem backlog and the two rates never add to it', () => {
    const out = py(`${board}
a, b = A.headline(board()), A.headline(board(bugs=999, ontop=(100, 100), first=(10, 10)))
print(json.dumps({"a": a, "b": b["number"], "parts": {p["key"]: p["count"] for p in a["parts"]}}))`);
    expect(out.a).toMatchObject({ number: 18, atLeast: false, shared: 0, unread: [] });
    expect(out.b).toBe(18);                                       // the backlog and the rates moved; the number did not
    expect(out.parts).toEqual({ emails: 3, responses: 2, moving: 4, bottlenecks: 1, carried: 1, agents: 1, jobs: 1,
      data: 2, missed: 1, queue: 1, allowance: 1 });
    expect(Object.keys(out.parts)).not.toContain('bugs');
  });

  it('one task, job or email two lines both count is counted once; a list longer than its count is never used to take one off', () => {
    const out = py(`
T = "recSAMETASK0001"
ok = {"state": "ok", "name": "09:00", "date": "2026-10-15"}
ls = [A.judge_emails({"left": 2, "scannedAt": ago(hours=1), "slot": ok, "items": [A.item("m", "mailA"), A.item("m", "mailB")]}, NOW),
      A.judge_responses({"items": [A.item("t", T)]}),
      A.judge_moving({"stuck": [A.item("t", T), A.item("u", "recOTHER")], "live": 50}),
      A.judge_carried({"items": [A.item("t", T)]}),
      A.judge_jobs({"failed": [A.item("Nightly sync")]}),
      A.judge_missed({"parks": [A.item("t", T)], "gaveUp": [A.item("Nightly sync", "", "gave up")], "undecided": [A.item("m", "mailA")]}),
      A.judge_queue({"cards": [{"id": T, "name": "t", "days": 4.0, "dated": True}]})]
h = A.headline(ls)
# The inbox list is longer than the count it came with (a newer scan not yet scored): no id is taken off.
long = [A.judge_emails({"left": 1, "scannedAt": ago(hours=1), "slot": ok, "items": [A.item("m", "mailA"), A.item("m", "mailB")]}, NOW),
        A.judge_missed({"undecided": [A.item("m", "mailA")]})]
print(json.dumps({"h": h, "long": A.headline(long)["number"]}))`);
    // 2 + 1 + 2 + 1 + 1 + 3 + 1 = 11 counted; the task on five lines, the job on two and the email on two are one each.
    expect(out.h.number).toBe(5);
    expect(out.h.shared).toBe(6);
    expect(out.h.sharedByKind).toEqual({ task: 4, job: 1, mail: 1 });
    expect(out.long).toBe(2);                                     // never lower than the truth
  });

  it('a counting line that cannot be read makes it "at least N" and is named; a grey rate or backlog does not', () => {
    const out = py(`${board}
ls = board(); ls[8] = A.grey("data", "the data check has not run since Tue 13 Oct 06:42")
grey_count = A.headline(ls)
ls = board(); ls[6] = A.judge_jobs(A.facts_jobs([{"key": "a", "label": "Job A", "status": "Failed"}], {}, "HTTP 503"))
part = A.headline(ls)
ls = board(); ls[7] = A.grey("bugs", "x"); ls[10] = A.grey("ontop", "x"); ls[12] = A.grey("firsttime", "x")
rates = A.headline(ls)
none = A.headline([A.grey(d["key"], "x") for d in A.LINES])
print(json.dumps({"grey": grey_count, "part": part, "rates": rates, "none": none["number"]}))`);
    expect(out.grey).toMatchObject({ number: 16, atLeast: true });
    expect(out.grey.unread).toEqual([{ key: 'data', question: 'The data is accurate', why: 'the data check has not run since Tue 13 Oct 06:42' }]);
    expect(out.part).toMatchObject({ number: 18, atLeast: true });
    expect(out.part.unread).toEqual([{ key: 'jobs', question: 'No job is broken', why: 'read only in part' }]);
    expect(out.rates).toMatchObject({ number: 18, atLeast: false, unread: [] });
    expect(out.none).toBeNull();                                  // nothing read: not known, never a zero
  });

  it('three lights: each the worst of its lines, titled for its colour, naming at most two things', () => {
    const out = py(`${board}
ls = board()
ls[0:5] = [A.line(d["key"], "green", "a", 0) for d in A.LINES[0:5]]
ls[11:14] = [A.grey(d["key"], "x") for d in A.LINES[11:14]]
ls[10] = A.grey("ontop", "x")
lights = A.build_lights(ls, A.group_verdicts(ls))
print(json.dumps([[x["key"], x["colour"], x["title"], x["text"]] for x in lights]))`);
    expect(out[0]).toEqual(['flow', 'green', 'Work is flowing', '']);
    // Red before amber (1 job failing is amber); within red, a counted problem before the backlog.
    expect(out[1]).toEqual(['broken', 'red', 'Something is broken', '2 data checks wrong, code problems up 47 +3 more']);
    expect(out[2]).toEqual(['keep', 'grey', 'Can it keep going?', "can't read agent workload, can't read your queue +2 more"]);
  });

  const L = (flow, broken, keep) => `[{"key": "flow", "colour": "${flow}", "title": "Work is held up", "text": "x"},
     {"key": "broken", "colour": "${broken}", "title": "Something is broken", "text": "3 jobs failing"},
     {"key": "keep", "colour": "${keep}", "title": "It can keep going", "text": ""}]`;
  const green = `[A.line(d["key"], "green", "a", 0) for d in A.LINES]`;
  const v = (n, lw, lights, prev = '{}', lines = green, at = 'False', lwAt = 'False') =>
    `A.team_verdict({"number": ${n}, "atLeast": ${at}}, ${lw === null ? 'None' : `{"number": ${lw}, "atLeast": ${lwAt}}`}, ${lights}, ${prev}, ${lines})`;

  it('the answer: Working well, Getting better, Not getting better, Getting worse, Can\'t tell', () => {
    const out = py(`print(json.dumps([
      ${v(4, 9, L('green', 'amber', 'green'))},
      ${v(4, null, L('green', 'green', 'green'))},
      ${v(6, 9, L('amber', 'amber', 'green'), '{"flow": "amber", "broken": "amber", "keep": "green"}')},
      ${v(12, 9, L('green', 'green', 'green'))},
      ${v(9, 9, L('amber', 'green', 'green'))},
      ${v(6, 9, L('amber', 'green', 'green'), '{"flow": "green", "broken": "green", "keep": "green"}')},
      ${v(46, null, L('red', 'red', 'amber'))},
      ${v(40, 50, L('amber', 'amber', 'green'), '{}', green, 'True')},
      ${v(60, 50, L('amber', 'amber', 'green'), '{}', green, 'True')},
      ${v(55, 50, L('amber', 'amber', 'green'), '{}', green, 'False', 'True')},
      ${v(45, 50, L('amber', 'amber', 'green'), '{}', green, 'False', 'True')},
      ${v(3, 9, L('green', 'green', 'green'), '{}', '[A.grey(d["key"], "x") if i < 3 else A.line(d["key"], "green", "a", 0) for i, d in enumerate(A.LINES)]')}]))`);
    const at = (i) => [out[i].colour, out[i].text];
    expect(at(0)).toEqual(['green', 'Working well']);             // no red light, 5 or fewer, all read
    expect(at(1)).toEqual(['green', 'Working well']);             // needs no last week
    expect(at(2)).toEqual(['amber', 'Getting better']);
    expect(out[2].reason).toBe('6 things to fix, down from 9 last week');
    expect(at(3)).toEqual(['red', 'Getting worse']);
    expect(out[3].reason).toBe('12 things to fix, up from 9 last week');
    expect(at(4)).toEqual(['amber', 'Not getting better']);       // the same number
    expect(at(5)).toEqual(['amber', 'Not getting better']);       // fewer, but a light went from green to amber
    expect(out[5].reason).toBe('6 things to fix, down from 9, but Work is held up went amber');
    expect(at(6)).toEqual(['grey', "Can't tell"]);                // the first week: nothing to compare with
    expect(out[6].reason).toBe('No number from last week to compare with yet. Still red: Work is held up, Something is broken');
    expect(at(7)).toEqual(['grey', "Can't tell"]);                // "at least 40" might be more than 50
    expect(at(8)).toEqual(['red', 'Getting worse']);              // "at least 60" is more than 50 whatever it hides
    expect(at(9)).toEqual(['grey', "Can't tell"]);                // last week was "at least 50": 55 may be fewer
    expect(at(10)).toEqual(['amber', 'Getting better']);          // 45 is fewer than at least 50
    expect(at(11)).toEqual(['grey', "Can't tell"]);               // more than 2 checks can't be read
  });

  it('a red light is never hidden behind a falling number: went red this week is "Getting worse"; red both weeks is named', () => {
    const out = py(`print(json.dumps([
      ${v(5, 9, L('green', 'red', 'green'), '{"flow": "green", "broken": "green", "keep": "green"}')},
      ${v(5, 9, L('green', 'red', 'green'), '{"flow": "green", "broken": "red", "keep": "green"}')}]))`);
    expect([out[0].colour, out[0].text]).toEqual(['red', 'Getting worse']);
    expect(out[0].reason).toBe('Something is broken went red this week');
    expect(out[0].why).toBe('Something is broken went red this week. Red: Something is broken, new this week (3 jobs failing)');
    expect(out[0].turnedRed).toEqual(['broken']);
    // Red last week too: the number fell, so the answer may say better, but the red light is named in it.
    expect([out[1].colour, out[1].text]).toEqual(['amber', 'Getting better']);
    expect(out[1].reason).toBe('5 things to fix, down from 9 last week. Still red: Something is broken');
    expect(out[1].redLights).toEqual(['broken']);
  });

  it('weekly bars: one per London week, the week\'s last daily number; Monday 00:30 London is the new week', () => {
    const out = py(`
# Monday 12 Oct 00:30 London is 23:30 UTC on Sunday 11 Oct: a UTC reading would put it in last week.
mon = datetime(2026, 10, 11, 23, 30, tzinfo=timezone.utc)
hist = {"2026-10-08": {A.HEAD_KEY: [30, False], A.LIGHTS_KEY: {"broken": "red"}},
        "2026-10-11": {A.HEAD_KEY: [25, False], A.LIGHTS_KEY: {"flow": "green", "broken": "amber", "keep": "green"}}}
weeks, since = A.weekly_series(hist, mon, {"number": 20, "atLeast": False})
ls = [A.line(d["key"], "green", "a", 0, count=(2 if d["key"] == "moving" else 0) if d["key"] in A.HEADLINE_LINES else None) for d in A.LINES]
p = A.build_payload(ls, hist, mon)
print(json.dumps({"weeks": weeks, "since": since, "lastWeek": p["lastWeek"], "verdict": p["verdict"]["text"],
                  "today": p["history"]["2026-10-12"][A.HEAD_KEY], "sunday": A.london_day(mon - timedelta(hours=1))}))`);
    expect(out.weeks).toEqual([
      { start: '2026-10-05', end: '2026-10-11', day: '2026-10-11', number: 25, atLeast: false, current: false },   // Sunday's, not Thursday's
      { start: '2026-10-12', end: '2026-10-18', day: '2026-10-12', number: 20, atLeast: false, current: true }]);
    expect(out.since).toBe('2026-10-08');
    expect(out.lastWeek).toMatchObject({ number: 25, day: '2026-10-11' });
    expect(out.today).toEqual([2, false]);                        // kept under the London day, Monday
    expect(out.sunday).toBe('2026-10-11');
    expect(out.verdict).toBe('Working well');                     // 2 things, no red light
  });

  it('eight weeks shown at most; the day\'s number outlives the 30-day history; a part-read pass never lowers the day', () => {
    const out = py(`
day = lambda d: (NOW.astimezone(L).date() - timedelta(days=d)).isoformat()
hist = {day(d): {A.HEAD_KEY: [100 - d, False], "emails": 1} for d in range(1, 80)}
ls = [A.line("emails", "green", "a", 0)]
h = A.apply_history(ls, hist, NOW, {"number": 5, "atLeast": False}, [])
weeks, since = A.weekly_series(h, NOW, {"number": 5, "atLeast": False})
d1 = A.apply_history([A.line("emails", "green", "a", 0)], {}, NOW, {"number": 40, "atLeast": False}, [])
d2 = A.apply_history([A.line("emails", "green", "a", 0)], d1, NOW, {"number": 30, "atLeast": True}, [])
d3 = A.apply_history([A.line("emails", "green", "a", 0)], d2, NOW, {"number": 35, "atLeast": False}, [])
f1 = A.apply_history([A.line("emails", "green", "a", 0)], {}, NOW, {"number": 30, "atLeast": True}, [])
f2 = A.apply_history([A.line("emails", "green", "a", 0)], f1, NOW, {"number": 33, "atLeast": True}, [])
t = day(0)
print(json.dumps({"oldest": min(h), "days": len(h), "slim": h[day(40)], "full": sorted(h[day(10)]), "weeks": len(weeks),
                  "first": weeks[0]["start"], "last": weeks[-1], "trendSince": ls[0]["trend"]["since"],
                  "kept": [d2[t][A.HEAD_KEY], d3[t][A.HEAD_KEY], f2[t][A.HEAD_KEY]]}))`);
    expect(out.oldest).toBe('2026-08-14');                        // 62 days back: eight weeks of bars fit
    expect(out.days).toBe(63);
    expect(out.slim).toEqual({ _h: [60, false] });                 // past 30 days: only the number is kept
    expect(out.full).toContain('emails');
    expect(out.weeks).toBe(8);
    expect(out.first).toBe('2026-08-24');                          // the Monday seven weeks before this one
    expect(out.last).toMatchObject({ start: '2026-10-12', number: 5, current: true });
    expect(out.trendSince).toBe('2026-09-16');                     // a line's trend still starts inside its 30 days
    expect(out.kept).toEqual([[40, false], [35, false], [33, true]]);
  });

  it('the row carries the answer, the number, the bars and the lights, and never the ids it used to count', () => {
    const out = py(stubs().replace('print(json.dumps({"status"', 'print(json.dumps({"v": p["verdict"], "h": p["headline"], "weeks": p["weeks"], "lights": p["lights"], "keys": any("_keys" in l for l in p["lines"]), "version": p["version"], "status"'));
    expect(out.version).toBe(2);
    expect(out.v).toMatchObject({ colour: 'green', text: 'Working well' });
    expect(out.h).toMatchObject({ number: 0, atLeast: false });
    expect(out.weeks).toHaveLength(1);
    expect(out.lights.map(x => [x.title, x.colour])).toEqual([
      ['Work is flowing', 'green'], ['Nothing is broken', 'green'], ['It can keep going', 'green']]);
    expect(out.keys).toBe(false);
  });
});

// ─── The independent review of PR #795 (15 Oct 2026) ─────────────────
// Each test failed on the code as first pushed and passes on the fix.
describe('review of PR #795: the simpler view never reads better than the truth', () => {
  const L = (flow, broken, keep) => `[{"key": "flow", "colour": "${flow}", "title": "Work is held up", "text": "x"},
     {"key": "broken", "colour": "${broken}", "title": "Something is broken", "text": "3 jobs failing"},
     {"key": "keep", "colour": "${keep}", "title": "It can keep going", "text": ""}]`;
  const green = `[A.line(d["key"], "green", "a", 0) for d in A.LINES]`;

  it('1 "Working well" needs no light worse than last week: 2 things with Work is flowing gone amber is "Not getting better"', () => {
    const out = py(`print(json.dumps([
      A.team_verdict({"number": 2, "atLeast": False}, {"number": 9}, ${L('amber', 'green', 'green')}, {"flow": "green", "broken": "green", "keep": "green"}, ${green}),
      A.team_verdict({"number": 2, "atLeast": False}, {"number": 9}, ${L('amber', 'green', 'green')}, {"flow": "amber", "broken": "green", "keep": "green"}, ${green})]))`);
    expect([out[0].colour, out[0].text]).toEqual(['amber', 'Not getting better']);
    expect(out[0].reason).toBe('2 things to fix, down from 9, but Work is held up went amber');
    expect([out[1].colour, out[1].text]).toEqual(['green', 'Working well']);   // amber both weeks: nothing got worse
  });

  it('2 a later "at least" above the day\'s full count replaces it, marked "at least", for that day\'s bar and next week\'s "last week"', () => {
    const out = py(`
ten = datetime(2026, 10, 15, 10, 0, tzinfo=L).astimezone(timezone.utc)
late = datetime(2026, 10, 15, 23, 50, tzinfo=L).astimezone(timezone.utc)
d1 = A.apply_history([A.line("emails", "green", "a", 0)], {}, ten, {"number": 5, "atLeast": False}, [])
d2 = A.apply_history([A.line("emails", "green", "a", 0)], d1, late, {"number": 40, "atLeast": True}, [])
d3 = A.apply_history([A.line("emails", "green", "a", 0)], d1, late, {"number": 4, "atLeast": True}, [])
week, _ = A.weekly_series(d2, late, None)
nxt = datetime(2026, 10, 22, 12, 0, tzinfo=L).astimezone(timezone.utc)
weeks, _ = A.weekly_series(d2, nxt, {"number": 45, "atLeast": False})
v = A.team_verdict({"number": 45, "atLeast": False}, weeks[-2], ${L('amber', 'amber', 'green')}, {}, ${green})
print(json.dumps({"day": d2["2026-10-15"][A.HEAD_KEY], "lower": d3["2026-10-15"][A.HEAD_KEY], "bar": week[-1],
                  "lastWeek": weeks[-2], "v": [v["colour"], v["text"], v["reason"]]}))`);
    expect(out.day).toEqual([40, true]);
    expect(out.lower).toEqual([5, false]);                        // a floor below the full count still never lowers the day
    expect(out.bar).toMatchObject({ number: 40, atLeast: true });
    expect(out.lastWeek).toMatchObject({ start: '2026-10-12', number: 40, atLeast: true });
    expect(out.v).toEqual(['grey', "Can't tell", "Last week's number was only partly read (at least 40)"]);
  });

  it('3 a red light that was grey or not on record last week counts as gone red: never "Getting better" over it', () => {
    const out = py(`print(json.dumps([
      A.team_verdict({"number": 5, "atLeast": False}, {"number": 9}, ${L('green', 'red', 'green')}, {"flow": "green", "broken": "grey", "keep": "green"}, ${green}),
      A.team_verdict({"number": 5, "atLeast": False}, {"number": 9}, ${L('green', 'red', 'green')}, {}, ${green}),
      A.team_verdict({"number": 5, "atLeast": False}, {"number": 9}, ${L('green', 'red', 'green')}, None, ${green}),
      A.team_verdict({"number": 5, "atLeast": False}, None, ${L('green', 'red', 'green')}, None, ${green})]))`);
    for (const v of out.slice(0, 3)) {
      expect([v.colour, v.text]).toEqual(['red', 'Getting worse']);
      expect(v.reason).toBe('Something is broken is red and was not on record as red last week');
      expect(v.turnedRed).toEqual(['broken']);
    }
    // The first week has no last week at all: nothing is said to have gone red, and it never says better.
    expect([out[3].colour, out[3].text]).toEqual(['grey', "Can't tell"]);
  });

  it('4 every open blocked task counts in the number, so a stuck task that gets blocked inside its limit never makes it fall', () => {
    const out = py(`
lh = load("lh", "loop-health.py"); D = lh.dispatcher()
CLOCK = {"SIGN-IN": 1, "TOOL": 3, "KEVIN": 3}
names = {"recX": "task X", "recY": "task Y"}
# Before: X and Y are stuck, nothing is blocked.
before = [A.judge_moving(A.facts_moving({"agentWork": {"live": 20, "stuckIds": ["recX", "recY"], "heldCheck": None}}, set(), names)),
          A.judge_bottlenecks(A.facts_bottlenecks({"readAt": iso(NOW), "openTasksRead": 1, "open": []}, CLOCK, NOW), NOW)]
# After: X is blocked half a day ago (inside its 3-day limit): it leaves "moving" and is not past its clock.
sweep = {"readAt": iso(NOW), "openTasksRead": 1, "open": [{"task": "recX", "name": "task X", "kind": "TOOL", "days": 0.5},
                                                          {"task": "recX", "name": "task X", "kind": "KEVIN", "days": 0.4}]}
after = [A.judge_moving(A.facts_moving({"agentWork": {"live": 20, "stuckIds": ["recX", "recY"], "heldCheck": None}}, {"recX"}, names)),
         A.judge_bottlenecks(A.facts_bottlenecks(sweep, CLOCK, NOW), NOW)]
b = after[1]
print(json.dumps({"before": A.headline(before)["number"], "after": A.headline(after)["number"], "shared": A.headline(after)["shared"],
                  "line": [b["colour"], b["number"], b["count"], b["answer"]]}))`);
    expect(out.before).toBe(2);
    expect(out.after).toBe(2);                                    // nothing was fixed, so the number did not fall
    expect(out.shared).toBe(0);                                   // "moving" took X out: counted once, under the block
    expect(out.line).toEqual(['green', 0, 1, 'No blocked task past its limit']);   // its own colour rule is unchanged; two walls, one task
  });

  it('4 a wall opened since the last sweep, on an open task, is counted too; one on a closed task is not', () => {
    const wall = '[15 Oct 2026 10:00 — agent] BLOCKER OPEN (TOOL robot setup): the fix is not merged [since 2026-10-15T09:00:00Z]';
    const out = py(stubs(`lh_res["_tasks"] = [{"id": "recFRESHWALL", "fields": {"Task Name": "fresh", "Status": "Today", "Notes": ${JSON.stringify(wall)}}},
                    {"id": "recCLOSEDWALL", "fields": {"Task Name": "closed", "Status": "Completed", "Completion Date": "2026-10-14", "Notes": ${JSON.stringify(wall)}}}]`)
      .replace('print(json.dumps({"status"', 'b = next(l for l in p["lines"] if l["key"] == "bottlenecks")\nprint(json.dumps({"h": p["headline"]["number"], "b": [b["colour"], b["count"]], "status"'));
    expect(out.h).toBe(1);
    expect(out.b).toEqual(['green', 1]);
  });
});
