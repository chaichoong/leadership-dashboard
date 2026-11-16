import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = resolve(ROOT, 'scripts/create-agent-task.py');

// A NEW ITEM THAT REPEATS A MATTER JUST CLOSED JOINS IT (inbound-comms-triage lesson of 2 Sep 2026:
// "Before creating a task, check open and recently completed tasks for the same matter. Join the existing
// one. Never raise a second"). Until 16 Nov 2026 the create gate read only OPEN tasks. These drive the
// real cmd_create with Airtable replaced by an in-memory board: every network door raises, and names,
// senders and references are invented.

const PRE = `
import importlib.util, json, sys, io, contextlib, socket, urllib.request, urllib.parse
from datetime import date, timedelta
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
socket.socket.connect = boom
socket.create_connection = boom
spec = importlib.util.spec_from_file_location("cat", ${JSON.stringify(GATE)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
F = m.F
m.load_scan_cache = lambda: {}
m.write_track_record = lambda *a, **k: None
def ago(n): return (date.today() - timedelta(days=n)).isoformat() + "T10:00:00.000Z"
OPEN = [{"id": "recOpenUnrelated1", "createdTime": ago(2),
         "fields": {F["name"]: "INBOUND: a quite different matter about a boiler", F["status"]: {"name": "Today"}}}]
DONE, LIVE, CALLS = [], {}, []
def done(rid, name, sender, days=3, extra=None):
    f = {F["name"]: name, F["status"]: {"name": "Completed"}, F["completion"]: ago(days), F["inboundSender"]: sender}
    f.update(extra or {})
    DONE.append({"id": rid, "createdTime": ago(days + 1), "fields": f})
    LIVE[rid] = json.loads(json.dumps(f))
READ_FAILS = []
def req(method, path, body=None):
    q = urllib.parse.unquote(path)
    CALLS.append([method, q, body])
    if method == "GET" and "LAST_MODIFIED_TIME({Status})" in q:
        if READ_FAILS: raise RuntimeError("Airtable GET -> HTTP 503")
        return {"records": json.loads(json.dumps(DONE))}
    if method == "GET" and "filterByFormula" in q:
        return {"records": json.loads(json.dumps(OPEN))}
    if method == "GET":
        rid = q.split("?")[0].rsplit("/", 1)[1]
        return {"id": rid, "fields": json.loads(json.dumps(LIVE.get(rid, {})))}
    if method == "POST" and q.endswith("/comments"):
        return {}
    if method == "POST":
        LIVE["recNewTaskAaaaaa1"] = dict(body["fields"])
        return {"id": "recNewTaskAaaaaa1"}
    if method == "PATCH":
        return {}
    raise RuntimeError("unexpected " + method)
m._request = req
def create(name, sender, due="", dry=False, extra=None):
    CALLS.clear()
    fields = {F["name"]: name, F["status"]: "Today", F["desc"]: "The new email, word for word."}
    if sender: fields[F["inboundSender"]] = sender
    if due: fields[F["due"]] = due
    fields.update(extra or {})
    buf, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err):
        rc = m.cmd_create(fields, dry_run=dry)
    out = json.loads(buf.getvalue().strip().splitlines()[-1])
    patches = [c[2]["fields"] for c in CALLS if c[0] == "PATCH"]
    posts = [c for c in CALLS if c[0] == "POST" and not c[1].split("?")[0].endswith("/comments")]
    return {"rc": rc, "out": out, "patch": patches[0] if patches else None, "created": len(posts),
            "completedRead": any(c[0] == "GET" and "LAST_MODIFIED_TIME" in c[1] for c in CALLS)}
`;

function py(snippet) {
  const out = execFileSync('python3', ['-c', PRE + snippet], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('a repeat of a matter closed in the last 14 days joins it instead of starting a second task', () => {
  it('the same subject from the same sender reopens the closed task, folds the item in and keeps Kevin\'s old verdict out of reach', () => {
    const r = py(`
done("recClosedTaskAaaa", "INBOUND: Fixture Council overdue licensing tasks, 9 Sample Street (1 Apr)",
     "licensing@fixture-council.test", extra={F["approvalOutcome"]: {"name": "Approved as-is"},
     F["approvedAt"]: ago(4), F["approvalFeedback"]: "Fine, send it.", F["feedbackHistory"]: "[2026-11-01 09:00] older note",
     F["notes"]: "earlier trail", F["desc"]: "The first reminder.", F["due"]: ago(5)[:10], F["hardDeadline"]: True})
res = create("INBOUND: Fixture Council overdue licensing tasks, 9 Sample Street (1 Apr)", "licensing@fixture-council.test",
             due=(date.today() + timedelta(days=2)).isoformat())
p = res["patch"]
print(json.dumps({"rc": res["rc"], "out": res["out"], "created": res["created"],
                  "status": p[F["status"]], "outcome": p.get(F["approvalOutcome"], "kept"), "approvedAt": p.get(F["approvedAt"], "kept"),
                  "feedback": p.get(F["approvalFeedback"], "kept"), "history": p.get(F["feedbackHistory"], ""),
                  "notes": p.get(F["notes"], ""), "desc": p.get(F["desc"], ""), "due": p.get(F["due"]), "hard": p.get(F["hardDeadline"]),
                  "dueWanted": (date.today() + timedelta(days=2)).isoformat()}))`);
    expect(r.rc).toBe(0);
    expect(r.out).toMatchObject({ action: 'updated', reopened: true, taskId: 'recClosedTaskAaaa' });
    expect(r.out.matchedWhy).toBe('the same subject, word for word, from the same sender');
    expect(r.created).toBe(0);                                    // nothing new is raised
    expect(r.status).toBe('Today');                               // reopened, so the item is worked
    expect([r.outcome, r.approvedAt, r.feedback]).toEqual([null, null, '']);   // the old approval is never carried out again
    expect(r.history).toMatch(/older note[\s\S]*Kept when the duplicate gate reopened this task for a new item: earlier verdict Approved as-is at .*: Fine, send it\./);
    expect(r.notes).toMatch(/earlier trail[\s\S]*create-agent-task\] REOPENED: a new item from the same sender repeats this task/);
    expect(r.desc).toMatch(/The first reminder\.[\s\S]*UPDATE \d{4}-\d{2}-\d{2}: new item folded in by the duplicate gate[\s\S]*The new email, word for word\./);
    expect(r.due).toBe(r.dueWanted);                              // the new item's date, never the closed task's past one
    expect(r.hard).toBe(false);
  });

  it('a shared reference number on the same subject joins; a house number alone does not', () => {
    const r = py(`
done("recPolicyTaskAaaa", "FIXED COST: Fixture Insure L01/0742989 renewed despite stop request", "renewals@fixture-insure.test")
ref = create("FIXED COST: Fixture Insure L01/0742989 says renewed 1 Nov despite stop request", "renewals@fixture-insure.test")
DONE.clear()
done("recHouseTaskAaaaa", "INBOUND: Fixture Council asks 1406 Example Road licence fee", "licensing@fixture-council.test")
house = create("INBOUND: Fixture Council asks 1406 Example Road waste collection day", "licensing@fixture-council.test")
print(json.dumps({"ref": [ref["out"]["action"], ref["out"].get("matchedWhy", "")], "house": [house["out"]["action"], house["created"]]}))`);
    expect(r.ref[0]).toBe('updated');
    expect(r.ref[1]).toMatch(/the same subject and reference \(0742989\) from the same sender/);
    expect(r.house).toEqual(['created', 1]);
  });

  it('a follow-up, another sender, other words, a diary task, another flat and an old close are each created as before', () => {
    const r = py(`
S = "office@fixture-agent.test"
done("recDoneOneAaaaaaa", "INBOUND: Fixture Agent asks us to refund 37 GBP to a tenant", S)
done("recDoneTwoAaaaaaa", "CALENDAR: U12 football, Fixture Town v Example Rovers", "fixtures@fixture-league.test")
done("recDoneThreeAaaaa", "INBOUND: Fixture Council tax adjustment Flat 1 Example House", "tax@fixture-council.test")
done("recDoneOldAaaaaaa", "INBOUND: Fixture Gas annual service reminder", "service@fixture-gas.test", days=20)
out = {
  "followUp": create("INBOUND (follow-up): Fixture Agent asks us to refund 37 GBP to a tenant", S),
  "sender": create("INBOUND: Fixture Agent asks us to refund 37 GBP to a tenant", "someone@other-agent.test"),
  "words": create("INBOUND: Fixture Agent asks us to find a waste carrier quote", S),
  "diary": create("CALENDAR: U12 football, Fixture Town v Example Rovers", "fixtures@fixture-league.test"),
  "flat": create("INBOUND: Fixture Council tax adjustment Flat 3 Example House", "tax@fixture-council.test"),
  "old": create("INBOUND: Fixture Gas annual service reminder", "service@fixture-gas.test"),
  "noSender": create("INBOUND: Fixture Agent asks us to refund 37 GBP to a tenant", ""),
}
print(json.dumps({k: [v["out"]["action"], v["created"], v["completedRead"]] for k, v in out.items()}))`);
    expect(r.followUp).toEqual(['created', 1, false]);            // the triage skill names a new message on a closed thread so
    expect(r.sender).toEqual(['created', 1, true]);
    expect(r.words).toEqual(['created', 1, true]);
    expect(r.diary).toEqual(['created', 1, true]);
    expect(r.flat).toEqual(['created', 1, true]);
    expect(r.old).toEqual(['created', 1, true]);
    expect(r.noSender).toEqual(['created', 1, false]);            // agent work, not inbound mail: never read
  });

  it('a read that fails creates and says NOT CHECKED; a task someone reopened meanwhile is not touched; a dry run writes nothing', () => {
    const r = py(`
S = "licensing@fixture-council.test"
N = "INBOUND: Fixture Council overdue licensing tasks, 9 Sample Street (1 Apr)"
done("recClosedTaskAaaa", N, S)
READ_FAILS.append(1)
failed = create(N, S)
READ_FAILS.clear()
LIVE["recClosedTaskAaaa"][F["status"]] = {"name": "Today"}       # reopened by someone else since the listing
moved = create(N, S)
LIVE["recClosedTaskAaaa"][F["status"]] = {"name": "Completed"}
dry = create(N, S, dry=True)
print(json.dumps({"failed": [failed["out"]["action"], failed["created"], failed["out"].get("note", "")],
                  "moved": [moved["out"]["action"], moved["created"], moved["patch"], moved["out"].get("note", "")],
                  "dry": [dry["out"]["action"], dry["out"].get("reopened"), dry["patch"], dry["created"]]}))`);
    expect(r.failed[0]).toBe('created');
    expect(r.failed[1]).toBe(1);
    expect(r.failed[2]).toMatch(/NOT CHECKED: the tasks completed in the last 14 days could not be read \(Airtable GET -> HTTP 503\)/);
    expect(r.moved.slice(0, 3)).toEqual(['created', 1, null]);
    expect(r.moved[3]).toMatch(/repeats recClosedTaskAaaa, which is no longer Completed, so nothing was reopened/);
    expect(r.dry).toEqual(['updated', true, null, 0]);
  });

  it('completed_twin reads only Completed rows inside the window, newest first, and never a row with no sender', () => {
    const r = py(`
S = "office@fixture-agent.test"
N = "INBOUND: Fixture Agent sends the monthly statement"
rows = [
  {"id": "recOlderAaaaaaaaa", "fields": {F["name"]: N, F["status"]: {"name": "Completed"}, F["completion"]: ago(9), F["inboundSender"]: S}},
  {"id": "recNewerAaaaaaaaa", "fields": {F["name"]: N, F["status"]: {"name": "Completed"}, F["completion"]: ago(2), F["inboundSender"]: S}},
  {"id": "recCancelledAaaaa", "fields": {F["name"]: N, F["status"]: {"name": "Cancelled"}, F["completion"]: ago(1), F["inboundSender"]: S}},
]
incoming = {F["name"]: N, F["inboundSender"]: S}
first = m.completed_twin(incoming, rows)
nosender = m.completed_twin(incoming, [dict(rows[1], fields=dict(rows[1]["fields"], **{F["inboundSender"]: ""}))])
outside = m.completed_twin(incoming, [dict(rows[1], fields=dict(rows[1]["fields"], **{F["completion"]: ago(15)}))])
print(json.dumps({"first": first["row"]["id"], "nosender": nosender, "outside": outside}))`);
    expect(r).toEqual({ first: 'recNewerAaaaaaaaa', nosender: null, outside: null });
  });
});
