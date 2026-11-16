// AGENT RENT LATE, one task per letting agent per due date (Kevin, 13 Nov 2026, on "AGENT RENT LATE: Unit 1 – 22 Newton
// Street, rent due 10 Nov": "StayCay late rent should be one email covering every unpaid StayCay property, not one email
// per property"). Lesson line 402 of the Cash Flow Voids agent file, made a code check on 16 Nov 2026.
//
// These drive the REAL scripts/rent-check.py: assess() judges fixture tenancies shaped as Airtable returns them, then
// agent_late_plan() and agent_late() plan and "write" through a fake api, and the real read_agent_late() reads those
// writes back. Every name, address, unit and amount is invented: this repo is public.
//
// Back-test: RENT_CHECK_SCRIPT=<a copy of origin/main's rent-check.py> runs this same file against the code before the
// change, and every case here fails there (per-unit tasks), on behaviour, not on a signature: the two shims below pass
// the tenants table only to code that takes it, and read a plan item's key and tenancy either way.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(root, 'scripts');
const SCRIPT = process.env.RENT_CHECK_SCRIPT || path.join(SCRIPTS, 'rent-check.py');

const HARNESS = `
import importlib.util, inspect, json, sys, os, tempfile, urllib.request
from datetime import date, datetime, timedelta, timezone
# No test may reach the network, by any road: blocked before the script is even loaded.
def _no_network(*a, **k):
    raise AssertionError("a rent-check batch test reached the network")
urllib.request.urlopen = _no_network
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
spec = importlib.util.spec_from_file_location("rc", ${JSON.stringify(SCRIPT)})
rc = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc)
rc.HISTORY = os.path.join(tempfile.mkdtemp(), "history.jsonl")
rc.PRE_SLATE_PATH = os.path.join(tempfile.mkdtemp(), "pre-slate.json")
def _no_airtable(method, path, *a, **k):
    raise AssertionError("a rent-check batch test reached Airtable: %s %s" % (method, path))
rc.api = _no_airtable
def _no_fetch(table, params=None):
    raise AssertionError("a rent-check batch test read Airtable: %s" % table)
rc.fetch_all = _no_fetch
def _no_roy(*a, **k):
    raise AssertionError("a rent-check batch test emailed Roy")
rc.lane_b_rules.notify_roy = _no_roy
class FakeAd:
    ROY_EMAIL = "roy@example.test"
    HUMANS = {"roy@example.test": {"rec": "recROYROW0000001"}}
    AF = {"assignee": "fldASSIGNEE000001"}
rc.lane_b_rules.module = lambda key: FakeAd

TY, TN, TX, AC, TK = rc.TY, rc.TN, rc.TX, rc.AC, rc.TK
DAY = date(2026, 11, 16)
NAME = "fldxBKW7QnujSDWqA"      # Tenants: Tenant Name. On an agent-managed tenancy the tenant IS the letting agent.
def rec(i, f): return {"id": i, "fields": f}
TENANTS = [rec("recT_uc", {TN["payType"]: "Universal Credit", NAME: "Sam Example"}),
           rec("recT_bay", {TN["payType"]: "Agent-Managed", NAME: "Baywater Lets"}),
           rec("recT_oak", {TN["payType"]: "Agent-Managed", NAME: "Oakfield Homes"})]
def tenancy(i, due, rent, tenant, unit, status="In Payment", start="2025-04-10"):
    return rec(i, {TY["dueDay"]: str(due), TY["rent"]: rent, TY["payStatus"]: status, TY["start"]: start,
                   TY["tenants"]: [tenant], TY["tenantStatus"]: ["Active"], TY["unitRef"]: [unit]})
def paid(tid, day, amount, account="recA_main"):
    return rec("tx_" + tid + day, {TX["date"]: day, TX["tenancy"]: [tid], TX["amount"]: amount, TX["account"]: [account]})
def feed(i, stamp): return rec(i, {AC["alias"]: "Bank " + i, AC["updated"]: stamp})
def run(ts, tx, day=DAY, accounts=None):
    noon = day.isoformat() + "T11:03:29.000Z"
    data = {"tenancies": list(ts), "tenants": list(TENANTS),
            # A matched payment on a tenancy outside the test keeps the main account a known rent account.
            "tx": [paid("recOTHER", (day - timedelta(days=4)).isoformat(), 500)] + list(tx), "unmatched": [],
            "accounts": accounts or [feed("recA_main", noon)],
            "preSlate": set(), "lateBefore": set(), "noChase": set(), "noChaseTenancies": set()}
    return rc.assess(data, day, datetime(day.year, day.month, day.day, 12, 30, tzinfo=timezone.utc))

# Three Baywater units and one Oakfield unit, all due on the 10th and last paid 10 Oct: 6 days late on 16 Nov. One more
# Baywater unit has paid, and a Universal Credit tenant is late too (lane A's, never the letting agent's).
BAY = [tenancy("recBay1", 10, 650, "recT_bay", "Flat 1 – 4 Sample Lane"),
       tenancy("recBay2", 10, 600, "recT_bay", "Flat 2 – 4 Sample Lane"),
       tenancy("recBay3", 10, 700, "recT_bay", "Unit 1 – 9 Model Street")]
OAK = [tenancy("recOak1", 10, 550, "recT_oak", "Room 3 – 12 Test Row")]
OTHERS = [tenancy("recBayPaid", 10, 500, "recT_bay", "Flat 3 – 4 Sample Lane"),
          tenancy("recUC1", 10, 450, "recT_uc", "Room 1 – 7 Fixture Close")]
TX10 = [paid(t["id"], "2026-10-10", t["fields"][TY["rent"]]) for t in BAY + OAK + OTHERS] + [paid("recBayPaid", "2026-11-10", 500)]

def PLAN(res, ts, existing, day=DAY, tenants=TENANTS):
    args = [res, ts, existing, day]
    if tenants is not None and "tenants" in inspect.signature(rc.agent_late_plan).parameters:
        args.append(tenants)
    return rc.agent_late_plan(*args)
def LATE(res, ts, day, writes=True, on=True, tenants=TENANTS):
    args = [res, ts, day, writes, on]
    if "tenants" in inspect.signature(rc.agent_late).parameters:
        args.append(tenants)
    return rc.agent_late(*args)
def keys(p): return p["keys"] if "keys" in p else [p["key"]]
def tcys(p): return p["tenancies"] if "tenancies" in p else [p["tenancy"]]

# A fake Tasks table: the real agent_late() writes into it, the real read_agent_late() reads it back.
STORE = []
def fake_api(method, path, payload=None, params=None):
    if method != "POST" or path != rc.T_TASKS:
        raise AssertionError("unexpected Airtable call: %s %s" % (method, path))
    rid = "recNEWTASK%06d" % (len(STORE) + 1)
    STORE.append({"id": rid, "createdTime": "2026-11-16T07:30:00.000Z", "fields": dict(payload["records"][0]["fields"])})
    return {"records": [{"id": rid}]}
def fake_fetch(table, params=None):
    if table != rc.T_TASKS:
        raise AssertionError("unexpected Airtable read: %s" % table)
    return [dict(r) for r in STORE]
def use_store():
    rc.api, rc.fetch_all = fake_api, fake_fetch
    rc.read_agent_late = REAL_READ
REAL_READ = rc.read_agent_late
`;

function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('rent-check: AGENT RENT LATE is one task per letting agent per due date (16 Nov 2026)', () => {
  it('a letting agent with three unpaid units gets ONE task listing every unit, amount and due date; the sender wording is unchanged', () => {
    const r = py(`
ts = BAY + OAK + OTHERS
plan = PLAN(run(ts, TX10), ts, {})
bay = [p for p in plan if "recBay1" in tcys(p)]
print(json.dumps({"n": len(plan), "bayTasks": len(bay), "tenancies": tcys(bay[0]), "keys": keys(bay[0]), "name": bay[0]["name"],
                  "desc": bay[0]["description"], "everywhere": sorted(t for p in plan for t in tcys(p))}))`);
    // Baywater and Oakfield: two tasks, not four.
    expect(r.n).toBe(2);
    expect(r.bayTasks).toBe(1);
    expect(r.tenancies).toEqual(['recBay1', 'recBay2', 'recBay3']);
    expect(r.keys).toEqual(['recBay1:2026-11-10', 'recBay2:2026-11-10', 'recBay3:2026-11-10']);
    expect(r.name).toBe('AGENT RENT LATE: Baywater Lets, rent due 10 Nov (3 units)');
    expect(r.desc).toContain('The letting agent, Baywater Lets, collects the rent for these 3 units');
    expect(r.desc).toContain('- Flat 1 – 4 Sample Lane: £650.00 owed (1 month at £650.00, the oldest due 10 Nov 2026), 6 days late today.');
    expect(r.desc).toContain('- Flat 2 – 4 Sample Lane: £600.00 owed');
    expect(r.desc).toContain('- Unit 1 – 9 Model Street: £700.00 owed');
    expect(r.desc).toContain('Total owed: £1,950.00.');
    expect(r.desc).toContain('Draft ONE email to the letting agent covering every unit above');
    // Who it is sent from waits on Kevin's decision card: this sentence is word for word what it was.
    expect(r.desc).toContain('It goes from kevinbrittain@gmail.com, signed Kevin Brittain (Kevin, 5 Oct 2026: the letting agent '
      + 'knows him as the landlord), to their accounts contact, in the thread of the last emails about this place where there '
      + 'is one (agent-dispatch.py history). Nothing goes to the tenant.');
    expect(r.desc).toContain('RENT AGENT KEY: recBay1:2026-11-10\nRENT AGENT KEY: recBay2:2026-11-10\nRENT AGENT KEY: recBay3:2026-11-10');
    // The paid unit and the Universal Credit tenant are in no letting-agent task.
    expect(r.everywhere).toEqual(['recBay1', 'recBay2', 'recBay3', 'recOak1']);
  });

  it('two letting agents are never merged, and no unpaid unit is dropped, with or without the tenants table', () => {
    const r = py(`
ts = BAY + OAK + OTHERS
res = run(ts, TX10)
late = sorted(row["id"] for row in res["tenancies"] if row["lane"] == "late" and row["type"] == rc.AGENT_MANAGED)
agent_of = {t["id"]: t["fields"][TY["tenants"]][0] for t in ts}
def shape(plan):
    return {"n": len(plan), "agents": [sorted({agent_of[t] for t in tcys(p)}) for p in plan],
            "units": sorted(t for p in plan for t in tcys(p)), "names": sorted(p["name"] for p in plan)}
print(json.dumps({"late": late, "with": shape(PLAN(res, ts, {})), "without": shape(PLAN(res, ts, {}, tenants=None))}))`);
    expect(r.late).toEqual(['recBay1', 'recBay2', 'recBay3', 'recOak1']);
    for (const s of [r.with, r.without]) {
      expect(s.n).toBe(2);
      // Each task holds one letting agent's units only, and every late unit is in exactly one task.
      expect(s.agents).toEqual([['recT_bay'], ['recT_oak']]);
      expect(s.units).toEqual(r.late);
    }
    expect(r.with.names).toEqual(['AGENT RENT LATE: Baywater Lets, rent due 10 Nov (3 units)',
                                  'AGENT RENT LATE: Oakfield Homes, rent due 10 Nov (1 unit)']);
  });

  it('one letting agent with two due dates gets one task per due date', () => {
    const r = py(`
ts = [BAY[0], tenancy("recBay4", 25, 500, "recT_bay", "Flat 4 – 4 Sample Lane"),
      tenancy("recBay5", 25, 520, "recT_bay", "Flat 5 – 4 Sample Lane")]
tx = [paid("recBay1", "2026-10-10", 650), paid("recBay4", "2026-09-25", 500), paid("recBay5", "2026-09-25", 520)]
plan = PLAN(run(ts, tx), ts, {})
print(json.dumps(sorted([p["name"], tcys(p)] for p in plan)))`);
    expect(r).toEqual([
      ['AGENT RENT LATE: Baywater Lets, rent due 10 Nov (1 unit)', ['recBay1']],
      ['AGENT RENT LATE: Baywater Lets, rent due 25 Oct (2 units)', ['recBay4', 'recBay5']],
    ]);
  });

  it('the amount owed counts every month fallen due since the oldest unpaid one; nothing matched in 80 days says "at least"', () => {
    const r = py(`
ts = [tenancy("recBay6", 10, 650, "recT_bay", "Flat 6 – 4 Sample Lane"), tenancy("recBay7", 10, 650, "recT_bay", "Flat 7 – 4 Sample Lane")]
plan = PLAN(run(ts, [paid("recBay6", "2026-09-10", 650)]), ts, {})
print(json.dumps("\\n".join(p["description"] for p in plan)))`);
    expect(r).toContain('- Flat 6 – 4 Sample Lane: £1,300.00 owed (2 months at £650.00, the oldest due 10 Oct 2026), 37 days late today.');
    expect(r).toContain('- Flat 7 – 4 Sample Lane: at least £1,950.00 owed (3 months at £650.00, the oldest due 10 Sep 2026), '
      + 'no payment matched in the last 80 days.');
    expect(r).toContain('Total owed: at least £1,950.00.');
  });

  it('the real write and the real read agree on every unit key: a re-run the same day or the next raises nothing', () => {
    const r = py(`
use_store()
ts = BAY + OAK + OTHERS
first = LATE(run(ts, TX10), ts, DAY)
posts = [dict(s["fields"]) for s in STORE]
again = LATE(run(ts, TX10), ts, DAY)
nextday = LATE(run(ts, TX10, day=DAY + timedelta(days=1)), ts, DAY + timedelta(days=1))
bay = [p for p in posts if "recBay1" in p[TK["tenancies"]]][0]
print(json.dumps({"raised": first["raised"], "failed": [first["failed"], again["failed"], nextday["failed"]], "posts": len(posts),
                  "notes": bay[TK["notes"]], "tenancies": bay[TK["tenancies"]], "tenants": bay[TK["tenants"]],
                  "owner": bay[TK["teamMember"]], "again": again["raised"], "nextday": nextday["raised"], "stored": len(STORE)}))`);
    expect(r.failed).toEqual(['', '', '']);
    expect(r.posts).toBe(2);
    expect(r.raised).toEqual(['AGENT RENT LATE: Baywater Lets, rent due 10 Nov (3 units)', 'AGENT RENT LATE: Oakfield Homes, rent due 10 Nov (1 unit)']);
    expect(r.notes).toBe('RENT AGENT KEY: recBay1:2026-11-10\nRENT AGENT KEY: recBay2:2026-11-10\nRENT AGENT KEY: recBay3:2026-11-10');
    // Every tenancy is linked, so the send door comments on each one.
    expect(r.tenancies).toEqual(['recBay1', 'recBay2', 'recBay3']);
    expect(r.tenants).toEqual(['recT_bay']);
    expect(r.owner).toEqual(['rec7aHLK1Q8fMLRXH']);
    expect(r.again).toEqual([]);
    expect(r.nextday).toEqual([]);
    expect(r.stored).toBe(2);
  });

  it('a unit that turns late after its agent task exists gets its own task, named as more and pointing at the first; the first units are never raised again', () => {
    const r = py(`
use_store()
ts = BAY
tx = [paid("recBay1", "2026-10-10", 650), paid("recBay2", "2026-10-10", 600), paid("recBay3", "2026-10-10", 700, account="recA_two")]
# Day 1: the second account's feed is three days old, so Unit 1 – 9 Model Street is "cannot tell", not late.
day1 = run(ts, tx, accounts=[feed("recA_main", "2026-11-16T11:03:29.000Z"), feed("recA_two", "2026-11-13T11:00:00.000Z")])
grey = day1["lanes"]["recBay3"]
one = LATE(day1, ts, DAY)
# Day 2: the feed is fresh and it is late too.
D2 = DAY + timedelta(days=1)
day2 = run(ts, tx, day=D2, accounts=[feed("recA_main", "2026-11-17T11:03:29.000Z"), feed("recA_two", "2026-11-17T11:00:00.000Z")])
two = LATE(day2, ts, D2)
later = STORE[-1]["fields"]
print(json.dumps({"grey": grey, "one": one["raised"], "two": two["raised"], "failed": [one["failed"], two["failed"]],
                  "tenancies": later[TK["tenancies"]], "notes": later[TK["notes"]], "desc": later[TK["description"]], "stored": len(STORE)}))`);
    expect(r.grey).toBe('unknown');
    expect(r.failed).toEqual(['', '']);
    expect(r.one).toEqual(['AGENT RENT LATE: Baywater Lets, rent due 10 Nov (2 units)']);
    expect(r.two).toEqual(['AGENT RENT LATE: Baywater Lets, rent due 10 Nov (1 more unit)']);
    expect(r.tenancies).toEqual(['recBay3']);
    expect(r.notes).toBe('RENT AGENT KEY: recBay3:2026-11-10');
    expect(r.desc).toContain('An earlier task for this letting agent and this due date exists (recNEWTASK000001). This unit turned late after it');
    expect(r.stored).toBe(2);
  });

  it('per-unit tasks still open when this ships are honoured: their units are in no new task, and the rest are told apart', () => {
    const r = py(`
ts = BAY
existing = {"recBay1:2026-11-10": {"id": "recOLDUNIT0000001", "status": "Approval", "sent": None},
            "recBay2:2026-11-10": {"id": "recOLDUNIT0000002", "status": "Completed", "sent": DAY - timedelta(days=1)}}
plan = PLAN(run(ts, TX10), ts, existing)
print(json.dumps([[p["name"], tcys(p), keys(p), p["description"]] for p in plan]))`);
    expect(r).toHaveLength(1);
    expect(r[0][0]).toBe('AGENT RENT LATE: Baywater Lets, rent due 10 Nov (1 more unit)');
    expect(r[0][1]).toEqual(['recBay3']);
    expect(r[0][2]).toEqual(['recBay3:2026-11-10']);
    expect(r[0][3]).toContain('An earlier task for this letting agent and this due date exists (recOLDUNIT0000001, recOLDUNIT0000002).');
  });

  it('the second email and the Roy call are batched too, a unit paid since drops out, and a batched Roy task is emailed to Roy once', () => {
    const r = py(`
ts = BAY
B1 = {"id": "recBATCHFIRST001", "status": "Completed", "sent": DAY - timedelta(days=3)}
firsts = {f"{t['id']}:2026-11-10": dict(B1) for t in BAY}
# Flat 2 has paid since the first email: it is in no second email.
second = PLAN(run(ts, TX10 + [paid("recBay2", "2026-11-12", 600)]), ts, firsts)
B1old, B2 = dict(B1, sent=DAY - timedelta(days=8)), {"id": "recBATCHSECOND01", "status": "Completed", "sent": DAY - timedelta(days=4)}
both = {}
for t in BAY:
    both[f"{t['id']}:2026-11-10"], both[f"{t['id']}:2026-11-10:2"] = dict(B1old), dict(B2)
roy = PLAN(run(ts, TX10), ts, both)
# The Roy task is open: every one of its :roy keys points at it, and Roy's email is offered once.
mailed = []
rc.lane_b_rules.notify_roy = lambda tid, to: mailed.append(tid) or {"notified": tid}
def _nothing_raised(*a, **k):
    raise AssertionError("nothing should be raised while every unit already holds its Roy key")
rc.api = _nothing_raised
openroy = dict(both, **{f"{t['id']}:2026-11-10:roy": {"id": "recBATCHROY00001", "status": "Today", "sent": None} for t in BAY})
rc.read_agent_late = lambda: dict(openroy)
out = LATE(run(ts, TX10), ts, DAY)
print(json.dumps({"second": [[p["step"], p["name"], tcys(p), keys(p)] for p in second], "secondDesc": second[0]["description"] if second else "",
                  "roy": [[p["step"], p["name"], tcys(p)] for p in roy], "royDesc": roy[0]["description"] if roy else "",
                  "mailed": mailed, "raised": out["raised"], "failed": out["failed"]}))`);
    expect(r.second).toEqual([['2', 'AGENT RENT LATE: Baywater Lets, rent due 10 Nov (2 units, second email)',
      ['recBay1', 'recBay3'], ['recBay1:2026-11-10:2', 'recBay3:2026-11-10:2']]]);
    expect(r.secondDesc).toContain('The email to the letting agent went on 13 Nov and the rent has still not arrived.');
    // Who it is sent from waits on Kevin's decision card: this sentence is word for word what it was.
    expect(r.secondDesc).toContain('Draft a second, firmer email in the same thread, from kevinbrittain@gmail.com, signed Kevin '
      + 'Brittain, asking for the payment date in writing. Nothing goes to the tenant.');
    expect(r.roy).toEqual([['roy', 'AGENT RENT LATE: Baywater Lets, rent due 10 Nov (3 units): phone the letting agent',
      ['recBay1', 'recBay2', 'recBay3']]]);
    expect(r.royDesc).toContain('Two emails to the letting agent (8 Nov and 12 Nov)');
    expect(r.mailed).toEqual(['recBATCHROY00001']);
    expect(r.raised).toEqual([]);
    expect(r.failed).toBe('');
  });
});
