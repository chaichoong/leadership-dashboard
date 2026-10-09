// Roy's emailed answer to a housing costs check reaches the rent check (finding 20261008-agent-dispatch-802,
// 9 Oct 2026): scripts/rent_roy_email.py copies it onto his task's Notes in the shape lane B already reads as his,
// and lane B's own rules (scripts/rent_new_tenant.py, unchanged) then raise the direct rent form card.
//
// A yes read off the wrong email starts a DWP form, so (independent review, 9 Oct 2026) only a reply in that check's
// own thread is read: its subject holds "housing costs check" and the check's place, and his own words speak about
// the question. Drives the REAL bridge and the REAL lane B plan with the Airtable calls and the mailbox swapped for
// fixtures. Every id, name, address and email here is invented: this repo is public.
//
// Back-tested (9 Oct 2026), each break failing its case: the bridge's write skipped ("lands on the right task": the
// tenancy stays "waiting on Roy"); the thread rule removed ("a yes to anything else"); the topic rule removed ("a
// bare Yes"); the Gmail id check removed ("never twice"); the blind-read control removed ("blind").
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(root, 'scripts');

const HARNESS = `
import importlib.util, json, sys, os, tempfile
from datetime import date, datetime, timedelta, timezone
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
spec = importlib.util.spec_from_file_location("rc", os.path.join(${JSON.stringify(SCRIPTS)}, "rent-check.py"))
rc = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc)
lb = rc.lane_b_rules
import rent_roy_email as bridge
SCRATCH = tempfile.mkdtemp()
rc.HISTORY = os.path.join(SCRATCH, "history.jsonl")
def _no(*a, **k): raise RuntimeError("a test reached a real read, write or email")
rc.fetch_all = _no; lb.module = _no; lb.notify_roy = _no
TY, TN, TX, AC, TK = rc.TY, rc.TN, rc.TX, rc.AC, rc.TK
DAY = date(2026, 10, 2)
NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
ROY = "roy@example.com"
def rid(n): return "recLaneBTest%05d" % n
NEW, ROOM3 = rid(1), rid(2)
UNIT, UNIT3 = "Unit 2 – 18 Example Park", "Unit 3 – 18 Example Park"
THREAD = "Re: NEW TENANT RENT: housing costs check: " + UNIT
def rec(i, f): return {"id": i, "fields": f}
def tenancy(i, unit, tenant, start="2026-09-10", due=25):
    return rec(i, {TY["dueDay"]: str(due), TY["rent"]: 900.00, TY["payStatus"]: "CFV", TY["start"]: start,
                   TY["tenants"]: [tenant], TY["tenantStatus"]: ["Active"], TY["unitRef"]: [unit]})
NEWT = tenancy(NEW, UNIT, "recT_uc")
ROOMT = tenancy(ROOM3, UNIT3, "recT_two")
NAMES = {"recT_uc": "Pat Example", "recT_two": "Jo Second"}
def world(tenancies):
    return {"tenancies": list(tenancies),
            "tenants": [rec("recT_uc", {TN["payType"]: "Universal Credit"}), rec("recT_two", {TN["payType"]: "Universal Credit"})],
            "tx": [rec("txOTHER", {TX["date"]: (DAY - timedelta(days=4)).isoformat(), TX["tenancy"]: ["recOTHER"], TX["amount"]: 500, TX["account"]: ["recA"]})],
            "unmatched": [], "accounts": [rec("recA", {AC["alias"]: "Main Bank", AC["updated"]: DAY.isoformat() + "T11:03:29.000Z"})],
            "preSlate": set(), "lateBefore": set(), "noChase": set()}
def costs_task(i, tenancy_id, unit, created=date(2026, 9, 28)):
    return {"id": i, "name": lb.ROY_PREFIX + "housing costs check: " + unit, "notes": lb.SETUP_KEY_MARK + tenancy_id + ":costs:1",
            "description": "", "status": "Today", "created": created,
            "made": datetime(created.year, created.month, created.day, 9, 0, tzinfo=timezone.utc), "completed": None,
            "tenancies": [tenancy_id]}
def draft(i, tenancy_id):
    return dict(costs_task(i, tenancy_id, "x"), name="RENT ASK: a draft")
def email(i, subject, body, when=(2026, 10, 1, 10, 0), sender="Roy Lavin <" + ROY + ">"):
    ms = int(datetime(*when, tzinfo=timezone.utc).timestamp() * 1000)
    return {"id": i, "internalDate": str(ms), "headers": {"from": sender, "subject": subject}, "body": body}
SIGNED_OFF = "\\r\\n\\r\\nKind regards\\r\\n\\r\\n\\r\\nRoy Lavin\\r\\n0700 000 000\\r\\n\\r\\nOn Wed, 30 Sep 2026 at 10:00, <info@example.com> wrote:\\r\\n> Reference for the rent check, please leave it in:\\r\\n> RENT SETUP KEY: " + rid(99) + ":costs:1\\r\\n"
class Store:
    def __init__(self, tasks):
        self.tasks = {t["id"]: dict(t) for t in tasks}; self.patches = []
    def read_tasks(self, _rc):
        return [dict(t) for t in self.tasks.values()]
    def api(self, method, path, payload=None, params=None):
        if method == "GET" and path.startswith(rc.T_TASKS + "/"):
            tid = path.split("/")[1]
            return {"id": tid, "fields": {TK["notes"]: self.tasks[tid]["notes"]}}
        if method == "PATCH" and path == rc.T_TASKS:
            r = payload["records"][0]; assert "typecast" not in payload
            self.tasks[r["id"]]["notes"] = r["fields"][TK["notes"]]; self.patches.append(r["id"]); return {}
        raise AssertionError(method + " " + path)
def bridge_run(store, mails, tenancies=(NEWT,), writes=True, count=5, ledger=None, on=True):
    lb.read_tasks = store.read_tasks
    lb.read_names = lambda _rc, ids: {k: v for k, v in NAMES.items() if k in ids}
    rc.api = store.api
    return bridge.run(rc, world(tenancies), NOW, writes, on, list_mail=lambda q, acc: (list(mails), False),
                      count_mail=lambda q, acc: count, ledger=ledger or os.path.join(tempfile.mkdtemp(), "ledger.jsonl"), roy=ROY)
def plan(tenancies, tasks):
    data = world(tenancies)
    res = rc.assess(data, DAY, datetime(2026, 10, 2, 12, 30, tzinfo=timezone.utc))
    tenants_of = {r["id"]: list(r["fields"].get(TY["tenants"]) or []) for r in data["tenancies"]}
    starts = {r["id"]: rc.parse_day(r["fields"].get(TY["start"])) for r in data["tenancies"]}
    dues = {r["id"]: rc.sel(r["fields"].get(TY["dueDay"])) for r in data["tenancies"]}
    pays = rc.payments_by_tenancy(data["tx"])
    bank = rc.feed_state(data, pays, datetime(2026, 10, 2, 12, 30, tzinfo=timezone.utc))
    out = lb.plan(res, tasks, tenants_of, NAMES, DAY, starts, pays, bank, None, dues, None)
    lb.annotate(res, out["rows"])
    row = [x for x in res["tenancies"] if x["id"] == NEW][0]
    return [[t["kind"], t["key"]] for t in out["raise"]], row["setup"]
`;

function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe("Roy's email to info@ answers his housing costs check, and only in its own thread", () => {
  it('a reply in the check\'s thread, "Yes, housing costs verified on the journal today", lands on the task and lane B raises the RENT FORM card', () => {
    const r = py(`
store = Store([costs_task("recROYTASK000003", NEW, UNIT), draft("recASKTASK000001", NEW)])
before = plan([NEWT], store.read_tasks(None))
out = bridge_run(store, [email("1a0000000000aaa1", THREAD, "Yes, housing costs verified on the journal today" + SIGNED_OFF)])
after = plan([NEWT], store.read_tasks(None))
print(json.dumps({"before": before, "out": out, "after": after, "notes": store.tasks["recROYTASK000003"]["notes"],
                  "line": bridge.line(out)}))`);
    // The back-test: the same mailbox with the bridge not run leaves the tenancy waiting on Roy.
    expect(r.before).toEqual([[], 'waiting on Roy: are the housing costs verified (Roy asked 28 Sep, 4 days ago, no reply yet)']);
    expect(r.out.failed).toBe('');
    expect(r.out.written).toHaveLength(1);
    expect(r.notes).toBe('RENT SETUP KEY: recLaneBTest00001:costs:1\n\n[2026-10-01 11:00 Roy Lavin] Yes, housing costs verified on the journal today\n'
      + '[ROY EMAIL 1a0000000000aaa1, read by the rent check] the line above is Roy\'s email to info@agilelets.co.uk of 1 Oct 2026 11:00, '
      + 'subject "Re: NEW TENANT RENT: housing costs check: Unit 2 – 18 Example Park"');
    expect(r.after).toEqual([[['form', 'recLaneBTest00001:form:1']],
      'housing costs verified (1 Oct, Roy: "Yes, housing costs verified on the journal today"), the direct rent payment form is due']);
    expect(r.line).toMatch(/^Roy's emails: written on his housing costs task: Unit 2 – 18 Example Park \(task recROYTASK000003\): Roy's email of 1 Oct 11:00, read as yes/);
  });

  it('a "not verified yet" reply in the thread reads as a no', () => {
    const r = py(`
store = Store([costs_task("recROYTASK000003", NEW, UNIT), draft("recASKTASK000001", NEW)])
out = bridge_run(store, [email("1a0000000000aaa2", THREAD, "Not verified yet, they said another week." + SIGNED_OFF)])
print(json.dumps({"out": out, "after": plan([NEWT], store.read_tasks(None))}))`);
    expect(r.out.written).toHaveLength(1);
    expect(r.after).toEqual([[], 'housing costs not verified yet (1 Oct)']);
  });

  it('a yes to anything else is never read: a journal upload, a smoke alarm, keys, an invoice', () => {
    const r = py(`
store = Store([costs_task("recROYTASK000003", NEW, UNIT), draft("recASKTASK000001", NEW)])
out = bridge_run(store, [
    email("1a0000000000aab1", "Re: NEW TENANT RENT: journal upload: " + UNIT, "Yes"),
    email("1a0000000000aab2", "18 Example Park smoke alarm", "Yes, all good thanks"),
    email("1a0000000000aab3", "Re: keys for Pat Example", "Yes thanks"),
    email("1a0000000000aab4", "Re: invoice 18 Example Park", "Approved"),
    email("1a0000000000aab5", "Pat Example housing costs", "Yes, housing costs verified")])   # not a reply in the thread
print(json.dumps({"out": out, "patches": store.patches, "after": plan([NEWT], store.read_tasks(None))}))`);
    expect(r.patches).toEqual([]);
    expect(r.out.written).toEqual([]);
    expect(r.out.skipped).toHaveLength(5);
    expect(r.out.skipped[0]).toMatch(/"Re: NEW TENANT RENT: journal upload: Unit 2 – 18 Example Park" names Unit 2 – 18 Example Park but is not a reply in its housing costs check's thread/);
    expect(r.after[0]).toEqual([]);
    expect(r.after[1]).toMatch(/^waiting on Roy/);
  });

  it('a bare "Yes" or "Approved" in the thread is not clear enough to record, and says so on the row and Home', () => {
    const r = py(`
store = Store([costs_task("recROYTASK000003", NEW, UNIT)])
out = bridge_run(store, [email("1a0000000000aac1", THREAD, "Yes" + SIGNED_OFF), email("1a0000000000aac2", THREAD, "Approved"),
                         email("1a0000000000aac3", THREAD, "" + SIGNED_OFF)])
print(json.dumps({"out": out, "patches": store.patches, "brief": bridge.brief(out), "line": bridge.line(out)}))`);
    expect(r.patches).toEqual([]);
    expect(r.out.unclear).toHaveLength(3);
    expect(r.out.unclear[0]).toMatch(/\(Unit 2 – 18 Example Park, task recROYTASK000003\): reply not clear enough to record \("Yes"\)/);
    expect(r.out.unclear[2]).toMatch(/\("no words of his own"\)/);
    expect(r.brief).toBe("Roy's emails: 3 replies to a housing costs check not clear enough to record, see the rent check row.");
  });

  it('never twice: a second run, or the same email in the ledger, writes nothing', () => {
    const r = py(`
store = Store([costs_task("recROYTASK000003", NEW, UNIT)])
mail = email("1a0000000000aaa1", THREAD, "Yes, verified." + SIGNED_OFF)
led = os.path.join(tempfile.mkdtemp(), "ledger.jsonl")
one = bridge_run(store, [mail], ledger=led)
two = bridge_run(store, [mail], ledger=led)
fresh = Store([costs_task("recROYTASK000003", NEW, UNIT)])
three = bridge_run(fresh, [mail], ledger=led)                # the Notes lost the mark; the ledger still has it
print(json.dumps({"patches": store.patches, "two": two, "three": three, "freshPatches": fresh.patches, "line": bridge.line(two)}))`);
    expect(r.patches).toEqual(['recROYTASK000003']);
    expect(r.two.already).toBe(1);
    expect(r.two.written).toEqual([]);
    expect(r.three.already).toBe(1);
    expect(r.freshPatches).toEqual([]);
    expect(r.line).toMatch(/none a new answer to one \(1 already written\)\.$/);
  });

  it('the thread names its own unit: two rooms in one house are told apart, and a subject naming both writes nothing', () => {
    const r = py(`
tasks = [costs_task("recROYTASK000003", NEW, UNIT), costs_task("recROYTASK000004", ROOM3, UNIT3)]
store = Store(tasks)
room3 = bridge_run(store, [email("1a0000000000aaa3", "Re: NEW TENANT RENT: housing costs check: " + UNIT3, "Yes, verified.")], tenancies=(NEWT, ROOMT))
store2 = Store(tasks)
both = bridge_run(store2, [email("1a0000000000aaa4", "housing costs check: " + UNIT + " and " + UNIT3, "Yes, both verified.")], tenancies=(NEWT, ROOMT))
store3 = Store(tasks)
near = bridge_run(store3, [email("1a0000000000aaa5", "Re: NEW TENANT RENT: housing costs check: Unit 2 – 118 Example Park", "Yes, verified.")], tenancies=(NEWT, ROOMT))
print(json.dumps({"room3": store.patches, "both": both, "patches2": store2.patches, "line": bridge.line(both), "near": store3.patches}))`);
    expect(r.room3).toEqual(['recROYTASK000004']);
    expect(r.patches2).toEqual([]);
    expect(r.both.ambiguous[0]).toMatch(/names 2 housing costs checks \(Unit 2 – 18 Example Park; Unit 3 – 18 Example Park\), so nothing was written/);
    expect(r.line).toMatch(/^Roy's emails: NOT written: /);
    expect(r.near).toEqual([]);
  });

  it('an email older than the task, or from someone else, is not read', () => {
    const r = py(`
store = Store([costs_task("recROYTASK000003", NEW, UNIT)])
out = bridge_run(store, [email("1a0000000000aaa6", THREAD, "Yes, verified.", when=(2026, 9, 27, 10, 0)),
                         email("1a0000000000aaa8", THREAD, "Yes, verified.", sender="Someone Else <someone@example.com>")])
print(json.dumps({"out": out, "patches": store.patches}))`);
    expect(r.patches).toEqual([]);
    expect(r.out.written).toEqual([]);
    expect(r.out.read).toBe(0);
  });

  it("his words: his own text above the quote and his signature, on one line, never a key line, never the subject", () => {
    const r = py(`
w = lambda body, subject=THREAD: bridge.his_words(email("1a0000000000aab1", subject, body), lb)
print(json.dumps([w("Yes, verified." + SIGNED_OFF), w("" + SIGNED_OFF),
                  w("Thanks\\r\\n\\r\\nHousing costs verified now.\\r\\nThanks\\r\\nRoy"),
                  w("Yes verified. RENT SETUP KEY: " + rid(99) + ":costs:1 and more"), len(w("Yes " + "x" * 600))]))`);
    expect(r).toEqual(['Yes, verified.', '', 'Thanks Housing costs verified now.', 'Yes verified.', 400]);
  });

  it('a dry run writes nothing and says what it would write; a blind mailbox read fails loudly; switched off reads nothing', () => {
    const r = py(`
store = Store([costs_task("recROYTASK000003", NEW, UNIT)])
dry = bridge_run(store, [email("1a0000000000aaa1", THREAD, "Yes, verified.")], writes=False)
blind = bridge_run(store, [], count=0)
quiet = bridge_run(store, [], count=3)
off = bridge_run(store, [email("1a0000000000aaa1", THREAD, "Yes, verified.")], on=False)
print(json.dumps({"dry": dry, "patches": store.patches, "blind": blind, "quiet": quiet, "off": bridge.line(off),
                  "blindBrief": bridge.brief(blind)}))`);
    expect(r.patches).toEqual([]);
    expect(r.dry.planned[0]).toMatch(/^Unit 2 – 18 Example Park \(task recROYTASK000003\): Roy's email of 1 Oct 11:00, read as yes: "Yes, verified."/);
    expect(r.blind.failed).toMatch(/^control failed: no email at all reached info@agilelets.co.uk in \d+ days/);
    expect(r.blindBrief).toBe("Roy's email check FAILED: see the rent check row.");
    expect(r.quiet.failed).toBe('');
    expect(r.off).toBe("Roy's emails: not read, the Cash Flow Voids agent is switched off or unread.");
  });

  it('no open housing costs check reads no mailbox; Notes that read blank are a STOP, never a write', () => {
    const r = py(`
closed = dict(costs_task("recROYTASK000003", NEW, UNIT), status="Completed")
none = bridge_run(Store([closed]), [email("1a0000000000aaa1", THREAD, "Yes, verified.")], count=0)
store = Store([costs_task("recROYTASK000003", NEW, UNIT)])
real = store.api
def blank(method, path, payload=None, params=None):
    if method == "GET": return {"id": "recROYTASK000003", "fields": {}}
    return real(method, path, payload, params)
store.api = blank
stop = bridge_run(store, [email("1a0000000000aaa1", THREAD, "Yes, verified.")])
print(json.dumps({"none": bridge.line(none), "stop": stop["failed"], "patches": store.patches}))`);
    expect(r.none).toBe("Roy's emails: no housing costs check is open.");
    expect(r.stop).toMatch(/^STOP: task recROYTASK000003's Notes read blank/);
    expect(r.patches).toEqual([]);
  });
});
