import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = resolve(ROOT, 'scripts/create-agent-task.py');

// A NEW ITEM THAT REPEATS A MATTER JUST CLOSED SAYS SO (inbound-comms-triage lesson of 2 Sep 2026:
// "Before creating a task, check open and recently completed tasks for the same matter"). Until 16 Nov 2026
// the create gate read only OPEN tasks. It now creates as before and stamps one SEEN BEFORE line naming the
// closed twin, its outcome and Kevin's reason; nothing on the closed task is touched (review of PR 959
// deleted the first build, which reopened the closed task). These drive the real cmd_create with Airtable
// replaced by an in-memory board: every network door raises, and names, senders and references are invented.

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
    touched_done = [c[:2] for c in CALLS if c[0] in ("PATCH", "POST") and any(d["id"] in c[1] for d in DONE)]
    return {"rc": rc, "out": out, "patch": patches[0] if patches else None, "created": len(posts),
            "notes": (posts[0][2]["fields"].get(F["notes"], "") if posts else ""), "touchedDone": touched_done,
            "completedRead": any(c[0] == "GET" and "LAST_MODIFIED_TIME" in c[1] for c in CALLS)}
`;

function py(snippet) {
  const out = execFileSync('python3', ['-c', PRE + snippet], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('a repeat of a matter closed in the last 14 days is created with a SEEN BEFORE line, and the closed task is left alone', () => {
  it('a twin Kevin REJECTED: a new task, the line says how it was closed and to close this one the same way, the old task untouched', () => {
    const r = py(`
N = "INBOUND: Fixture Council overdue licensing tasks, 9 Sample Street (1 Apr)"
done("recClosedTaskAaaa", N, "licensing@fixture-council.test",
     extra={F["approvalOutcome"]: {"name": "Rejected"}, F["verdictReason"]: {"name": "Not worth my attention"}})
before = json.dumps(LIVE["recClosedTaskAaaa"], sort_keys=True)
res = create(N, "licensing@fixture-council.test")
print(json.dumps({"rc": res["rc"], "out": res["out"], "created": res["created"], "notes": res["notes"], "patch": res["patch"],
                  "touched": res["touchedDone"], "same": json.dumps(LIVE["recClosedTaskAaaa"], sort_keys=True) == before}))`);
    expect(r.rc).toBe(0);
    expect(r.out).toMatchObject({ action: 'created', taskId: 'recNewTaskAaaaaa1', seenBefore: 'recClosedTaskAaaa' });
    expect(r.created).toBe(1);
    expect(r.notes).toMatch(/create-agent-task\] SEEN BEFORE: recClosedTaskAaaa closed \d{4}-\d{2}-\d{2}, outcome Rejected, reason Not worth my attention \(the same subject, word for word, from the same sender\)/);
    expect(r.notes).toMatch(/Kevin turned this matter down then \(Not worth my attention\)\. Close this one the same way, naming recClosedTaskAaaa, and do not bring it back to him/);
    expect([r.patch, r.touched, r.same]).toEqual([null, [], true]);   // no reopen, no field cleared, no verdict moved
  });

  it('a twin Kevin approved gets the line too, with no instruction to close; a relevance reason alone counts as turned down', () => {
    const r = py(`
done("recApprovedAaaaaa", "INBOUND: Fixture Agent sends the monthly statement", "office@fixture-agent.test",
     extra={F["approvalOutcome"]: {"name": "Approved as-is"}})
ok = create("INBOUND: Fixture Agent sends the monthly statement", "office@fixture-agent.test")
DONE.clear()
done("recRelevanceAaaaa", "INBOUND: Fixture Gym asks us to renew", "hello@fixture-gym.test",
     extra={F["verdictReason"]: {"name": "Duplicate"}})
rel = create("INBOUND: Fixture Gym asks us to renew", "hello@fixture-gym.test")
print(json.dumps({"ok": [ok["out"]["action"], ok["out"].get("seenBefore"), ok["notes"], ok["patch"]],
                  "rel": rel["notes"]}))`);
    expect(r.ok[0]).toBe('created');
    expect(r.ok[1]).toBe('recApprovedAaaaaa');
    expect(r.ok[2]).toMatch(/SEEN BEFORE: recApprovedAaaaaa closed .*, outcome Approved as-is, reason none/);
    expect(r.ok[2]).not.toMatch(/turned this matter down/);
    expect(r.ok[3]).toBeNull();
    expect(r.rel).toMatch(/outcome none, reason Duplicate .*Kevin turned this matter down then \(Duplicate\)/);
  });

  it('a shared reference number on the same subject is a twin; a house number alone is not', () => {
    const r = py(`
done("recPolicyTaskAaaa", "FIXED COST: Fixture Insure L01/0742989 renewed despite stop request", "renewals@fixture-insure.test")
ref = create("FIXED COST: Fixture Insure L01/0742989 says renewed 1 Nov despite stop request", "renewals@fixture-insure.test")
DONE.clear()
done("recHouseTaskAaaaa", "INBOUND: Fixture Council asks 1406 Example Road licence fee", "licensing@fixture-council.test")
house = create("INBOUND: Fixture Council asks 1406 Example Road waste collection day", "licensing@fixture-council.test")
print(json.dumps({"ref": [ref["out"]["action"], ref["notes"]], "house": [house["out"]["action"], house["out"].get("seenBefore"), house["notes"]]}))`);
    expect(r.ref[0]).toBe('created');
    expect(r.ref[1]).toMatch(/SEEN BEFORE: recPolicyTaskAaaa .*the same subject and reference \(0742989\) from the same sender/);
    expect(r.house).toEqual(['created', null, '']);
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

  it('a read that fails creates and says NOT CHECKED; a dry run writes nothing and still names the twin', () => {
    const r = py(`
S = "licensing@fixture-council.test"
N = "INBOUND: Fixture Council overdue licensing tasks, 9 Sample Street (1 Apr)"
done("recClosedTaskAaaa", N, S)
READ_FAILS.append(1)
failed = create(N, S)
READ_FAILS.clear()
dry = create(N, S, dry=True)
print(json.dumps({"failed": [failed["out"]["action"], failed["created"], failed["out"].get("note", ""), failed["notes"]],
                  "dry": [dry["out"]["action"], dry["out"].get("seenBefore"), dry["patch"], dry["created"]]}))`);
    expect(r.failed[0]).toBe('created');
    expect(r.failed[1]).toBe(1);
    expect(r.failed[2]).toMatch(/NOT CHECKED: the tasks completed in the last 14 days could not be read \(Airtable GET -> HTTP 503\)/);
    expect(r.failed[3]).not.toMatch(/SEEN BEFORE/);
    expect(r.dry).toEqual(['created', 'recClosedTaskAaaa', null, 0]);
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
