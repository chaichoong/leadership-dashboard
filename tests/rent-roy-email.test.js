// Roy's emailed answer to a housing costs check reaches the rent check (finding 20261008-agent-dispatch-802,
// 9 Oct 2026): scripts/rent_roy_email.py copies it onto his task's Notes in the shape lane B already reads as his,
// and lane B's own rules (scripts/rent_new_tenant.py, unchanged) then raise the direct rent form card.
//
// Drives the REAL bridge and the REAL lane B plan with the Airtable calls and the mailbox swapped for fixtures.
// Every id, name, address and email here is invented: this repo is public.
//
// Back-tested (9 Oct 2026): with the bridge not run (the case below) the tenancy stays "waiting on Roy"; with
// match() taking any house hit the "two rooms" case writes onto both; without the Gmail id mark the "never twice"
// case writes twice; without the blind-read control the "blind" case reads as nothing to do.
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
NEW, ROOM2 = rid(1), rid(2)
def rec(i, f): return {"id": i, "fields": f}
def tenancy(i, unit, tenant, start="2026-09-10", due=25):
    return rec(i, {TY["dueDay"]: str(due), TY["rent"]: 900.00, TY["payStatus"]: "CFV", TY["start"]: start,
                   TY["tenants"]: [tenant], TY["tenantStatus"]: ["Active"], TY["unitRef"]: [unit]})
NEWT = tenancy(NEW, "Unit 9 – 1 Example Road", "recT_uc")
ROOMT = tenancy(ROOM2, "Unit 2 – 1 Example Road", "recT_two")
NAMES = {"recT_uc": "Sam Sample", "recT_two": "Jo Second"}
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

describe("Roy's email to info@ answers his housing costs check", () => {
  it('a "Yes, housing costs are verified" email lands on the right task and lane B raises the RENT FORM card', () => {
    const r = py(`
store = Store([costs_task("recROYTASK000003", NEW, "Unit 9 – 1 Example Road"), draft("recASKTASK000001", NEW)])
before = plan([NEWT], store.read_tasks(None))
out = bridge_run(store, [email("1a0000000000aaa1", "Sam Sample housing costs", "Yes, housing costs are verified." + SIGNED_OFF)])
after = plan([NEWT], store.read_tasks(None))
print(json.dumps({"before": before, "out": out, "after": after, "notes": store.tasks["recROYTASK000003"]["notes"],
                  "line": bridge.line(out)}))`);
    // The back-test: the same mailbox with the bridge not run leaves the tenancy waiting on Roy.
    expect(r.before).toEqual([[], 'waiting on Roy: are the housing costs verified (Roy asked 28 Sep, 4 days ago, no reply yet)']);
    expect(r.out.failed).toBe('');
    expect(r.out.written).toHaveLength(1);
    expect(r.notes).toBe('RENT SETUP KEY: recLaneBTest00001:costs:1\n\n[2026-10-01 11:00 Roy Lavin] Yes, housing costs are verified.\n'
      + '[ROY EMAIL 1a0000000000aaa1, read by the rent check] the line above is Roy\'s email to info@agilelets.co.uk of 1 Oct 2026 11:00, subject "Sam Sample housing costs"');
    expect(r.after).toEqual([[['form', 'recLaneBTest00001:form:1']],
      'housing costs verified (1 Oct, Roy: "Yes, housing costs are verified."), the direct rent payment form is due']);
    expect(r.line).toMatch(/^Roy's emails: written on his housing costs task: Unit 9 – 1 Example Road \(task recROYTASK000003\): Roy's email of 1 Oct 11:00, read as yes/);
  });

  it('a "not verified yet" email reads as a no, and is matched by the house in its subject', () => {
    const r = py(`
store = Store([costs_task("recROYTASK000003", NEW, "Unit 9 – 1 Example Road"), draft("recASKTASK000001", NEW)])
out = bridge_run(store, [email("1a0000000000aaa2", "Re: NEW TENANT RENT: housing costs check: Unit 9 – 1 Example Road",
                               "Not verified yet, they said another week." + SIGNED_OFF)])
print(json.dumps({"out": out, "after": plan([NEWT], store.read_tasks(None))}))`);
    expect(r.out.written).toHaveLength(1);
    expect(r.after).toEqual([[], 'housing costs not verified yet (1 Oct)']);
  });

  it('never twice: a second run, or the same email in the ledger, writes nothing', () => {
    const r = py(`
store = Store([costs_task("recROYTASK000003", NEW, "Unit 9 – 1 Example Road")])
mail = email("1a0000000000aaa1", "Sam Sample", "Yes, verified." + SIGNED_OFF)
led = os.path.join(tempfile.mkdtemp(), "ledger.jsonl")
one = bridge_run(store, [mail], ledger=led)
two = bridge_run(store, [mail], ledger=led)
fresh = Store([costs_task("recROYTASK000003", NEW, "Unit 9 – 1 Example Road")])
three = bridge_run(fresh, [mail], ledger=led)                # the Notes lost the mark; the ledger still has it
print(json.dumps({"patches": store.patches, "two": two, "three": three, "freshPatches": fresh.patches, "line": bridge.line(two)}))`);
    expect(r.patches).toEqual(['recROYTASK000003']);
    expect(r.two.already).toBe(1);
    expect(r.two.written).toEqual([]);
    expect(r.three.already).toBe(1);
    expect(r.freshPatches).toEqual([]);
    expect(r.line).toMatch(/none a new answer to one \(1 already written\)\.$/);
  });

  it('an email naming two checks writes nothing and says so; the tenant named beside a shared house picks one', () => {
    const r = py(`
tasks = [costs_task("recROYTASK000003", NEW, "Unit 9 – 1 Example Road"), costs_task("recROYTASK000004", ROOM2, "Unit 2 – 1 Example Road")]
store = Store(tasks)
both = bridge_run(store, [email("1a0000000000aaa3", "1 Example Road", "Yes, verified for both rooms.")], tenancies=(NEWT, ROOMT))
store2 = Store(tasks)
named = bridge_run(store2, [email("1a0000000000aaa4", "Sam Sample, 1 Example Road", "Yes, verified.")], tenancies=(NEWT, ROOMT))
print(json.dumps({"both": both, "patches": store.patches, "named": named["written"], "patches2": store2.patches,
                  "line": bridge.line(both), "brief": bridge.brief(both)}))`);
    expect(r.patches).toEqual([]);
    expect(r.both.ambiguous[0]).toMatch(/"1 Example Road" names 2 housing costs checks \(Unit 9 – 1 Example Road; Unit 2 – 1 Example Road\), so nothing was written/);
    expect(r.line).toMatch(/^Roy's emails: NOT written: /);
    expect(r.brief).toBe("Roy's emails: 1 named more than one housing costs check and were not read.");
    expect(r.patches2).toEqual(['recROYTASK000003']);
  });

  it('only an answer is written: an email that only names the tenant, one older than the task, or another house is not', () => {
    const r = py(`
store = Store([costs_task("recROYTASK000003", NEW, "Unit 9 – 1 Example Road")])
out = bridge_run(store, [
    email("1a0000000000aaa5", "Sam Sample - keys", "Gave him the spare keys today." + SIGNED_OFF),
    email("1a0000000000aaa6", "Sam Sample", "Yes, verified.", when=(2026, 9, 27, 10, 0)),
    email("1a0000000000aaa7", "11 Example Road", "Yes, verified."),
    email("1a0000000000aaa8", "Sam Sample", "Yes, verified.", sender="Someone Else <someone@example.com>"),
    email("1a0000000000aaa9", "Sam Sample - Journal Details", "" + SIGNED_OFF)])
print(json.dumps({"out": out, "patches": store.patches}))`);
    expect(r.patches).toEqual([]);
    expect(r.out.skipped).toHaveLength(2);
    expect(r.out.skipped[0]).toMatch(/"Sam Sample - keys" names Unit 9 – 1 Example Road but does not answer the housing costs check/);
    expect(r.out.skipped[1]).toMatch(/"Sam Sample - Journal Details"/);
    expect(r.out.written).toEqual([]);
  });

  it("his words: his own text above the quote and his signature, on one line, never a key line; the subject when the body has none", () => {
    const r = py(`
w = lambda body, subject="Sam Sample": list(bridge.his_words(email("1a0000000000aab1", subject, body), lb))
print(json.dumps([w("Yes, verified." + SIGNED_OFF), w("" + SIGNED_OFF, "Re: Sam Sample - Journal Details"),
                  w("Thanks\\r\\n\\r\\nHousing costs verified now.\\r\\nThanks\\r\\nRoy"),
                  w("Yes verified. RENT SETUP KEY: " + rid(99) + ":costs:1 and more"), len(w("Yes " + "x" * 600)[0])]))`);
    expect(r).toEqual([['Yes, verified.', false], ['Sam Sample - Journal Details', true],
                       ['Thanks Housing costs verified now.', false], ['Yes verified.', false], 400]);
  });

  it('a dry run writes nothing and says what it would write; a blind mailbox read fails loudly; switched off reads nothing', () => {
    const r = py(`
store = Store([costs_task("recROYTASK000003", NEW, "Unit 9 – 1 Example Road")])
dry = bridge_run(store, [email("1a0000000000aaa1", "Sam Sample", "Yes, verified.")], writes=False)
blind = bridge_run(store, [], count=0)
quiet = bridge_run(store, [], count=3)
off = bridge_run(store, [email("1a0000000000aaa1", "Sam Sample", "Yes, verified.")], on=False)
print(json.dumps({"dry": dry, "patches": store.patches, "blind": blind, "quiet": quiet, "off": bridge.line(off),
                  "blindBrief": bridge.brief(blind)}))`);
    expect(r.patches).toEqual([]);
    expect(r.dry.planned[0]).toMatch(/^Unit 9 – 1 Example Road \(task recROYTASK000003\): Roy's email of 1 Oct 11:00, read as yes: "Yes, verified."/);
    expect(r.blind.failed).toMatch(/^control failed: no email at all reached info@agilelets.co.uk in \d+ days/);
    expect(r.blindBrief).toBe("Roy's email check FAILED: see the rent check row.");
    expect(r.quiet.failed).toBe('');
    expect(r.off).toBe("Roy's emails: not read, the Cash Flow Voids agent is switched off or unread.");
  });

  it('no open housing costs check reads no mailbox; Notes that read blank are a STOP, never a write', () => {
    const r = py(`
closed = dict(costs_task("recROYTASK000003", NEW, "Unit 9 – 1 Example Road"), status="Completed")
none = bridge_run(Store([closed]), [email("1a0000000000aaa1", "Sam Sample", "Yes, verified.")], count=0)
store = Store([costs_task("recROYTASK000003", NEW, "Unit 9 – 1 Example Road")])
lb.read_tasks = store.read_tasks
real = store.api
def blank(method, path, payload=None, params=None):
    if method == "GET": return {"id": "recROYTASK000003", "fields": {}}
    return real(method, path, payload, params)
store.api = blank
stop = bridge_run(store, [email("1a0000000000aaa1", "Sam Sample", "Yes, verified.")])
print(json.dumps({"none": bridge.line(none), "stop": stop["failed"], "patches": store.patches}))`);
    expect(r.none).toBe("Roy's emails: no housing costs check is open.");
    expect(r.stop).toMatch(/^STOP: task recROYTASK000003's Notes read blank/);
    expect(r.patches).toEqual([]);
  });
});
