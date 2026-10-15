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
    expect(out[0].answer).toBe('The 13:00 sort did not run');
    expect(out[1].answer).toBe('The 13:00 sort failed');
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
    expect(out.answer).toBe('2 of 3 worked today');
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
    expect(out.grey).toBe('grey');                              // 1 known failure, the rest unread: can't tell
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
      .toEqual(['grey', 'red']);
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
gave = A.facts_gave_up(ev, [{"key": "late-job", "label": "Late job", "status": "Missed"}], NOW, {"feed-brain": {"label": "Brain feed"}})
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
ls = ${lines('["green", "green", "red"] + ["green"] * 11')}
for l, d in zip(ls, ["better", "better", "worse"] + [None] * 11):
    l["trend"] = {"direction": d}
up = A.overall_verdict(ls)
for l in ls[:2]: l["trend"] = {"direction": "same"}
print(json.dumps([up, A.overall_verdict(ls)]))`);
    expect(out[0]).toMatchObject({ colour: 'amber', text: 'Issues, but going the right way', better: 2, worse: 1 });
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
print(json.dumps({"days": len(h), "oldest": min(h), "today": h[day(0)], "trends": [l["trend"] for l in ls]}))`);
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

describe('the row', () => {
  // Every reader stubbed: the row must hold fourteen lines and the verdict, and a reader that
  // throws must turn its own line grey, never the whole row Failed and never a green.
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
           "history": lambda: ({}, None)}
${over}
row = A.verdict_row(NOW, ES(), [], lh_res, None, measures, readers)
p = json.loads(row["payload"]) if row.get("payload") else None
print(json.dumps({"status": row["status"], "detail": row["detail"], "key": row["key"],
                  "lines": p and [[l["key"], l["colour"]] for l in p["lines"]], "overall": p and p["overall"],
                  "bugs": p and next(l for l in p["lines"] if l["key"] == "bugs")["trend"]}))`;

  it('carries fourteen lines in Kevin\'s order, three groups and one verdict', () => {
    const out = py(stubs());
    expect(out.status).toBe('Worked');
    expect(out.key).toBe('ai-team-verdict');
    expect(out.lines.map(l => l[0])).toEqual(['emails', 'responses', 'moving', 'bottlenecks', 'carried', 'agents', 'jobs',
      'bugs', 'data', 'missed', 'ontop', 'queue', 'firsttime', 'allowance']);
    expect(out.lines.every(l => l[1] === 'green')).toBe(true);
    expect(out.overall).toMatchObject({ colour: 'green', text: 'Healthy', grey: 0 });
    expect(out.detail).toBe('Healthy. 14 green, 0 amber, 0 red.');
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
