// Lane B of the Cash Flow Voids chain (Kevin, 2 Oct 2026): scripts/rent_new_tenant.py, the rules
// that walk a new Universal Credit tenant into payment, and the "do not chase" list in
// scripts/rent-check.py.
//
// These drive the REAL rules with fixture records shaped as Airtable returns them. The first block
// is the four worked examples Kevin approved at the build gate. Every id, name, address, rent,
// date and amount in this file is invented: this repo is public.
//
// Back-tested (2 Oct 2026) by breaking the rule under test and watching its case fail. The list
// of breaks and the case each one fails is at the foot of this file.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(root, 'scripts');

const HARNESS = `
import importlib.util, json, sys, os, io, contextlib, tempfile, argparse, re
from datetime import date, datetime, timedelta, timezone
def load_mod(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(SCRIPTS)}, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
rc = load_mod("rc", "rent-check.py")
lb = rc.lane_b_rules
SCRATCH = tempfile.mkdtemp()
rc.HISTORY = os.path.join(SCRATCH, "history.jsonl")
rc.PRE_SLATE_PATH = os.path.join(SCRATCH, "pre-slate.json")
rc.read_task_state = lambda: {"on": True, "status": "Built", "keys": {}}
# No test may reach Airtable or email Roy: every read and write is replaced per test.
def _no(*a, **k): raise RuntimeError("a test reached a real read, write or email")
rc.api = _no; rc.fetch_all = _no; lb.module = _no; lb.notify_roy = _no
TY, TN, TX, AC, TK = rc.TY, rc.TN, rc.TX, rc.AC, rc.TK
DAY = date(2026, 10, 2)
def rid(n): return "recLaneBTest%05d" % n
NEW, OLD1, OLD2, PAYER = rid(1), rid(2), rid(3), rid(4)
def rec(i, f): return {"id": i, "fields": f}
def tenancy(i, due, rent, status="In Payment", start="2025-04-06", tenant="recT_uc", unit=None, **extra):
    f = {TY["dueDay"]: str(due), TY["rent"]: rent, TY["payStatus"]: status, TY["start"]: start,
         TY["tenants"]: [tenant], TY["tenantStatus"]: ["Active"], TY["unitRef"]: [unit or ("Unit " + i)]}
    f.update(extra)
    return rec(i, f)
def paid(tid, day, amount, account="recA_main"):
    return rec("tx_" + tid + day, {TX["date"]: day, TX["tenancy"]: [tid], TX["amount"]: amount, TX["account"]: [account]})
def waiting(day, amount, account="recA_main"):
    return rec("txU" + day, {TX["date"]: day, TX["amount"]: amount, TX["account"]: [account]})
def world(tenancies, tx, day=DAY, pre=(), noChase=(), unmatched=(), feed=None):
    return {"tenancies": list(tenancies),
            "tenants": [rec("recT_uc", {TN["payType"]: "Universal Credit"}), rec("recT_work", {TN["payType"]: "Working"}),
                        rec("recT_agent", {TN["payType"]: "Agent-Managed"}), rec("recT_quiet", {TN["payType"]: "Working"}),
                        rec("recT_quietuc", {TN["payType"]: "Universal Credit"}), rec("recT_blank", {})],
            "tx": [paid("recOTHER", (day - timedelta(days=4)).isoformat(), 500)] + list(tx), "unmatched": list(unmatched),
            "accounts": [rec("recA_main", {AC["alias"]: "Main Bank", AC["updated"]: feed or (day.isoformat() + "T11:03:29.000Z")})],
            "preSlate": set(pre), "lateBefore": set(), "noChase": set(noChase)}
def assess(tenancies, tx=(), day=DAY, **kw):
    data = world(tenancies, tx, day=day, **kw)
    return data, rc.assess(data, day, datetime(day.year, day.month, day.day, 12, 30, tzinfo=timezone.utc))
def roy(day, words, n=1):
    # His assistant's stamp, London time: 14:0n.
    return "[%s 14:0%d Roy Lavin via his assistant, recREQ%011d] %s" % (day.strftime("%d %b %Y"), n, n, words)
def task(i, key, status="Today", created=DAY, completed=None, said=(), name=None, extra="", hour=9, tenancies=None):
    notes = "\\n\\n".join([lb.SETUP_KEY_MARK + key] + ([extra] if extra else []) + [roy(d, w, n + 1) for n, (d, w) in enumerate(said)])
    return {"id": i, "name": name or (lb.ROY_PREFIX + "a task"), "notes": notes, "description": "", "status": status,
            "created": created, "made": datetime(created.year, created.month, created.day, hour, 0, tzinfo=timezone.utc),
            "completed": completed, "tenancies": [key.split(":")[0]] if tenancies is None else tenancies}
def draft(i, key, **kw): return task(i, key, name="RENT ASK: a draft", **kw)
NAMES = {"recT_uc": "Sam Sample", "recT_work": "Wendy Worker", "recT_quietuc": "Quentin Quiet"}
def plan(tenancies, tasks, tx=(), day=DAY, plans=None, windows=None, **kw):
    data, res = assess(tenancies, tx, day=day, **kw)
    tenants_of = {r["id"]: list(r["fields"].get(TY["tenants"]) or []) for r in data["tenancies"]}
    starts = {r["id"]: rc.parse_day(r["fields"].get(TY["start"])) for r in data["tenancies"]}
    dues = {r["id"]: rc.sel(r["fields"].get(TY["dueDay"])) for r in data["tenancies"]}
    pays = rc.payments_by_tenancy(data["tx"])
    bank = rc.feed_state(data, pays, datetime(day.year, day.month, day.day, 12, 30, tzinfo=timezone.utc))
    out = lb.plan(res, tasks, tenants_of, NAMES, day, starts, pays, bank, plans, dues, windows)
    lb.annotate(res, out["rows"])
    res["briefLine"] = rc.brief_line(res)
    return res, out
def new_void(i=NEW, tenant="recT_uc", status="CFV", start="2026-09-25", due=25, unit="Unit 9 – 1 Example Road"):
    return tenancy(i, due, 900.00, status=status, start=start, tenant=tenant, unit=unit)
def keys(out): return [[t["kind"], t["key"]] for t in out["raise"]]
def withdrawn(out): return [[w["id"], w["why"]] for w in out["withdraw"]]
def closes(out): return [[c["id"], c["why"], c["complete"], c["end"]] for c in out["close"]]
def stage(res, i=NEW): return [x for x in res["tenancies"] if x["id"] == i][0]["setup"]
def short(res, i=NEW): return [x for x in res["tenancies"] if x["id"] == i][0]["stage"]
`;

function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const ROY2 = [['roy', 'recLaneBTest00001:costs:2'], ['ask', 'recLaneBTest00001:costs:2']];
const ROY1 = [['roy', 'recLaneBTest00001:costs:1'], ['ask', 'recLaneBTest00001:costs:1']];
const ANSWERED = 'Roy has answered, so this check is finished';

describe('lane B: the worked examples Kevin approved (2 Oct 2026, anonymised)', () => {
  it('1. an existing void whose form is in: Roy\'s hand-raised task is adopted, nothing new is raised', () => {
    const r = py(`
t = tenancy(OLD1, 11, 900.00, status="CFV Actioned", start="2026-02-11", unit="Unit 9 – 2 Example Road")
tasks = [task("recROYTASK000001", OLD1 + ":paid:1", name="Sam Sample: chase the Universal Credit claim until his rent is in payment")]
res, out = plan([t], tasks, pre=[OLD1])
row = [x for x in res["tenancies"] if x["id"] == OLD1][0]
print(json.dumps({"raise": out["raise"], "close": out["close"], "note": row["note"], "lane": row["lane"], "line": res["briefLine"]}))`);
    expect(r.raise).toEqual([]);
    expect(r.close).toEqual([]);
    expect(r.lane).toBe('existing');
    expect(r.note).toBe('cash flow void actioned, existing, left alone; '
      + 'form sent, waiting for the first payment (Roy asked 2 Oct, 0 days ago, no reply yet)');
    // Home carries the few words; the whole stage is in the row's note.
    expect(r.line).toContain('Existing cash flow voids, left alone: Unit 9 – 2 Example Road (form sent, awaiting rent).');
  });

  it('2. the same, 14 days after Roy last checked: Roy is asked again and the tenant is not', () => {
    const r = py(`
t = tenancy(OLD2, 9, 900.00, status="CFV Actioned", start="2026-05-09", unit="Unit 9 – 3 Example Road")
answered = [task("recROYTASK000002", OLD2 + ":paid:1", created=date(2026, 9, 10), said=[(date(2026, 9, 18), "No, they said it is still being processed")])]
res, out = plan([t], answered, pre=[OLD2], tx=[paid(OLD2, "2026-09-05", 300.00)])   # a part payment from before the task
early, eout = plan([t], [task("recROYTASK000002", OLD2 + ":paid:1", created=date(2026, 9, 10), said=[(date(2026, 9, 19), "No, not yet")])], pre=[OLD2])
print(json.dumps({"raise": keys(out), "name": out["raise"][0]["name"], "label": out["raise"][0]["label"], "close": closes(out), "early": keys(eout), "earlyClose": closes(eout),
                  "says": out["raise"][0]["description"]}))`);
    // Rent WAS matched to this tenancy, before the form. Roy is told only what is known.
    expect(r.says).toContain('the direct rent application has gone to the DWP, and no rent has been matched to this tenancy since 10 Sep 2026.');
    expect(r.says).not.toMatch(/no rent is matched|has not reached the bank|since the direct rent application/);
    expect(r.raise).toEqual([['roy', 'recLaneBTest00003:paid:2']]);
    expect(r.name).toBe('NEW TENANT RENT: direct rent check 2: Unit 9 – 3 Example Road');
    expect(r.label).toBe('Roy, paid check 2: Unit 9 – 3 Example Road');
    // His answered task was still open: his answer is the end of it.
    expect(r.close).toEqual([['recROYTASK000002', ANSWERED, true, false]]);
    // 13 days after his answer nothing is raised, and the answered task is still closed.
    expect(r.early).toEqual([]);
    expect(r.earlyClose).toEqual([['recROYTASK000002', ANSWERED, true, false]]);
  });

  it('3. a new tenant whose housing-costs task was raised by hand: adopted at that step, no journal twin; a yes means the form is due', () => {
    const r = py(`
hand = "Sam Sample: confirm housing costs with Universal Credit for 1 Example Road Unit 9"
asked = [draft("recASKTASK000001", NEW + ":costs:1")]
waiting, w = plan([new_void()], [task("recROYTASK000003", NEW + ":costs:1", name=hand)] + asked)
yes, y = plan([new_void()], [task("recROYTASK000003", NEW + ":costs:1", name=hand, said=[(date(2026, 10, 2), "Yes, verified this morning")])] + asked)
no, n = plan([new_void()], [task("recROYTASK000003", NEW + ":costs:1", name=hand, created=date(2026, 9, 20), said=[(date(2026, 9, 25), "No, not yet")])] + asked)
no6, n6 = plan([new_void()], [task("recROYTASK000003", NEW + ":costs:1", name=hand, created=date(2026, 9, 20), said=[(date(2026, 9, 26), "No, not yet")])] + asked)
print(json.dumps({"waiting": [keys(w), stage(waiting)], "yes": [keys(y), stage(yes), [c["id"] for c in y["close"]]],
                  "no": [keys(n), stage(no)], "no6": keys(n6), "line": yes["briefLine"]}))`);
    expect(r.waiting).toEqual([[], 'waiting on Roy: are the housing costs verified (Roy asked 2 Oct, 0 days ago, no reply yet)']);
    // His own words go with the yes, for whoever acts on "form due".
    // A yes raises the form card for Kevin (his ruling, 3 Oct 2026: "Robot fills, you pick reason").
    expect(r.yes).toEqual([[['form', 'recLaneBTest00001:form:1']], 'housing costs verified (2 Oct, Roy: "Yes, verified this morning"), the direct rent payment form is due', ['recROYTASK000003']]);
    expect(r.line).toContain('New tenants not in payment yet: Unit 9 – 1 Example Road (form due).');
    // A no is asked again 7 days later, of Roy and of the tenant at the same time; not on day 6.
    expect(r.no).toEqual([ROY2, 'housing costs not verified yet (25 Sep)']);
    expect(r.no6).toEqual([]);
  });

  it('4. a tenant on the private do-not-chase list: late is shown, and no late-rent task is ever raised', () => {
    const r = py(`
ts = [tenancy(PAYER, 28, 300.00, tenant="recT_quiet", unit="Unit 9 – 4 Example Road")]
tx = [paid(PAYER, "2026-08-27", 300.00)]
data, res = assess(ts, tx, noChase=["recT_quiet"])
listed = rc.task_plan(res, data["tenancies"], {}, DAY)
data2, res2 = assess(ts, tx)
unlisted = rc.task_plan(res2, data2["tenancies"], {}, DAY)
row = res["tenancies"][0]
paying, pres = assess(ts, [paid(PAYER, "2026-09-27", 300.00)], noChase=["recT_quiet"])
print(json.dumps({"lane": row["lane"], "note": row["note"], "listed": listed, "unlisted": [t["name"] for t in unlisted],
                  "payingNote": [x.get("note") for x in pres["tenancies"]], "payingLight": pres["lights"][PAYER]}))`);
    expect(r.lane).toBe('late');
    expect(r.note).toBe('late 4 days, due 28 Sep, last matched payment 27 Aug; not chased: standing instruction');
    expect(r.listed).toEqual([]);
    expect(r.unlisted).toEqual(['RENT LATE: Unit 9 – 4 Example Road, rent due 28 Sep (reminder)']);
    // Paid up, the tenancy is green and says nothing about the list.
    expect([r.payingNote, r.payingLight]).toEqual([[], 'green']);
  });
});

describe('lane B: who it starts for', () => {
  it('a new Universal Credit tenant with no task gets Roy\'s journal task, once, and no tenant draft', () => {
    const r = py(`
res, out = plan([new_void()], [])
t = out["raise"][0]
again, out2 = plan([new_void()], [task("recROYTASK000010", NEW + ":journal:1")])
print(json.dumps({"keys": keys(out), "task": dict(t, due=t["due"].isoformat()), "first": stage(res), "again": keys(out2), "note": stage(again)}))`);
    expect(r.keys).toEqual([['roy', 'recLaneBTest00001:journal:1']]);
    expect(r.task.name).toBe('NEW TENANT RENT: journal upload: Unit 9 – 1 Example Road');
    expect(r.task.notes).toBe('RENT SETUP KEY: recLaneBTest00001:journal:1');
    // The key is in the description too: a Notes field cut at the front cannot lose it.
    expect(r.task.description.split('\n').pop()).toBe('RENT SETUP KEY: recLaneBTest00001:journal:1');
    expect(r.task.description).toContain('Sam Sample is a new tenant at Unit 9 – 1 Example Road');
    expect(r.task.description).toContain('Reply to this email with "done" on the day it is uploaded.');
    expect([r.task.tenancy, r.task.tenants, r.task.due]).toEqual(['recLaneBTest00001', ['recT_uc'], '2026-10-02']);
    // Before anything is raised the row says what is next, never that Roy has been asked.
    expect(r.first).toBe('new, the journal upload is next');
    expect(r.again).toEqual([]);
    expect(r.note).toBe('waiting on Roy: the journal upload (Roy asked 2 Oct, 0 days ago, no reply yet)');
  });

  it('only a Universal Credit tenant; a tenant with no rent payment type is said, not skipped in silence', () => {
    const r = py(`
_, w = plan([new_void(tenant="recT_work")], [])
_, a = plan([new_void(tenant="recT_agent")], [])
_, b = plan([new_void(tenant="recT_blank")], [])
print(json.dumps([keys(w), keys(a), keys(b), w["problems"], b["problems"]]))`);
    expect(r.slice(0, 4)).toEqual([[], [], [], []]);
    expect(r[4]).toEqual(['Unit 9 – 1 Example Road is a new cash flow void whose tenant has no rent payment type, so its clock cannot start']);
  });

  it('a void that began inside 60 days is still new after a part payment; an older void with no task is not started', () => {
    const r = py(`
young, y = plan([new_void(start="2026-08-25")], [], tx=[paid(NEW, "2026-08-26", 100.00)])
old, o = plan([new_void(start="2026-06-25")], [], tx=[paid(NEW, "2026-08-26", 100.00)])
print(json.dumps({"lanes": [young["lanes"][NEW], old["lanes"][NEW]], "young": keys(y), "old": keys(o)}))`);
    expect(r.lanes).toEqual(['late', 'late']);
    expect(r.young).toEqual([['roy', 'recLaneBTest00001:journal:1']]);
    expect(r.old).toEqual([]);
  });

  it('the 60 days are counted to the day, and a void that has had a full rent and then missed one is a late payer, not a new tenant', () => {
    const r = py(`
part = [paid(NEW, "2026-08-26", 100.00)]
_, d60 = plan([new_void(start="2026-08-03", due=25)], [], tx=part)
_, d61 = plan([new_void(start="2026-08-02", due=25)], [], tx=part)
had, h = plan([new_void(start="2026-08-10", due=25)], [], tx=[paid(NEW, "2026-08-24", 900.00)])
old, o = plan([new_void(start="2026-03-16", due=25)], [])     # a void with no rent ever linked, begun 200 days ago
ahead, a = plan([new_void(start="2026-09-27", due=25)], [], tx=[paid(NEW, "2026-09-20", 900.00)])   # paid in full a week before it began
print(json.dumps({"day60": keys(d60), "day61": keys(d61), "hadRent": [had["lanes"][NEW], keys(h)], "oldNew": [old["lanes"][NEW], keys(o)], "paidAhead": [ahead["lanes"][NEW], keys(a)]}))`);
    expect(r.day60).toEqual([['roy', 'recLaneBTest00001:journal:1']]);
    expect(r.day61).toEqual([]);
    expect(r.hadRent).toEqual(['late', []]);
    // An old void the rent check shows as "new" (no rent ever linked) is not a new tenant either.
    expect(r.oldNew).toEqual(['new', []]);
    // Nor is a young one in the "new" lane that has already had a full rent.
    expect(r.paidAhead).toEqual(['new', []]);
  });

  it('a hand-typed key is read forgivingly; one that still cannot be read, or sits on an unlinked task, is said and no twin is raised', () => {
    const r = py(`
def hand(notes, **kw):
    return dict(task("recROYTASK000003", NEW + ":costs:1", name="Raised by hand", **kw), notes=notes)
def go(notes, **kw):
    res, out = plan([new_void()], [hand(notes, **kw), draft("recASKTASK000001", NEW + ":costs:1")])
    return [keys(out), out["problems"], out["rows"].get(NEW, {}).get("short")]
# Mid-clock: the rule's own journal task is done, and a hand task carries an unusable key.
journal = task("recROYTASK000010", NEW + ":journal:1", status="Completed", created=date(2026, 9, 20), completed=date(2026, 9, 25))
res_m, mid = plan([new_void()], [journal, hand("RENT SETUP KEY: " + NEW + ":cost:1")])
_, mid_ok = plan([new_void()], [journal])
print(json.dumps({"slips": [lb.task_keys("RENT SETUP KEY:" + NEW + ":costs:1"), lb.task_keys("Rent setup key: " + NEW + ":costs:1"),
                            lb.task_keys("rent  setup  key " + NEW + ":paid:2")],
                  "midClock": [keys(mid), short(res_m), keys(mid_ok)],
                  "capital": go("Please adopt. RENT SETUP KEY: " + NEW + ":Costs:1."),
                  "wrongStep": go("RENT SETUP KEY: " + NEW + ":cost:1"),
                  "shortId": go("RENT SETUP KEY: " + NEW[:-1] + ":costs:1"),
                  "unlinked": go("RENT SETUP KEY: " + NEW + ":costs:1", tenancies=[]),
                  "closedBadKey": go("RENT SETUP KEY: " + NEW + ":cost:1", status="Completed"),
                  "wrongId": go("RENT SETUP KEY: " + rid(99) + ":costs:1"),
                  "atApproval": go("RENT SETUP KEY: " + NEW + ":cost:1", status="Approval")}))`);
    // A slip in the mark itself is read, not lost.
    expect(r.slips).toEqual([[['recLaneBTest00001', 'costs', 1]], [['recLaneBTest00001', 'costs', 1]], [['recLaneBTest00001', 'paid', 2]]]);
    // Mid-clock, an unusable key holds every raise for that tenancy, not only a fresh start.
    expect(r.midClock).toEqual([[], 'key to fix', ROY1]);
    expect(r.capital).toEqual([[], [], 'waiting on Roy']);
    expect(r.wrongStep).toEqual([[], ["task recROYTASK000003 has a key line that cannot be read ('recLaneBTest00001:cost:1'), so it is ignored"], 'key to fix']);
    expect(r.shortId).toEqual([[], ["task recROYTASK000003 has a key line that cannot be read ('recLaneBTest0000:costs:1'), so it is ignored"], 'key to fix']);
    expect(r.unlinked).toEqual([[], ['task recROYTASK000003 carries a key for a tenancy it is not linked to, so it is ignored'], 'key to fix']);
    // A slip in the id: the key names another tenancy, the task is linked to this one. Both are held.
    expect(r.wrongId).toEqual([[], ['task recROYTASK000003 carries a key for a tenancy it is not linked to, so it is ignored'], 'key to fix']);
    // A task waiting at Approval is open: its bad key holds the tenancy too.
    expect(r.atApproval).toEqual([[], ["task recROYTASK000003 has a key line that cannot be read ('recLaneBTest00001:cost:1'), so it is ignored"], 'key to fix']);
    // A finished task with a bad key holds nothing up: the tenancy starts as usual.
    expect(r.closedBadKey).toEqual([[['roy', 'recLaneBTest00001:journal:1']], [], 'journal upload next']);
  });

  it('a new tenant on the do-not-chase list gets nothing', () => {
    const r = py(`
res, out = plan([new_void(tenant="recT_quietuc")], [], noChase=["recT_quietuc"])
_, off = plan([new_void(tenant="recT_quietuc")], [])
bad = dict(task("recROYTASK000003", NEW + ":costs:1", name="Raised by hand"), notes="RENT SETUP KEY: " + NEW + ":cost:1")
_, both = plan([new_void(tenant="recT_quietuc")], [bad], noChase=["recT_quietuc"])
print(json.dumps({"raise": keys(out), "rows": out["rows"], "note": res["tenancies"][0]["note"], "offList": keys(off), "badKey": [keys(both), both["rows"]]}))`);
    // The list is weighed first: a listed tenancy with a bad key on a task is still simply not chased.
    expect(r.badKey).toEqual([[], {}]);
    expect(r.raise).toEqual([]);
    expect(r.rows).toEqual({});
    expect(r.note).toContain('not chased: standing instruction');
    // The same tenant off the list gets Roy's journal task.
    expect(r.offList).toEqual([['roy', 'recLaneBTest00001:journal:1']]);
  });
});

describe('lane B: the clock', () => {
  it('7 days after Roy says the documents are up, the housing costs check goes to Roy and the tenant; not on day 6', () => {
    const r = py(`
def go(said_on, words="done", status="Today", completed=None):
    said = [(said_on, words)] if words else []
    _, out = plan([new_void()], [task("recROYTASK000010", NEW + ":journal:1", created=date(2026, 9, 24), status=status, completed=completed, said=said)])
    return [keys(out), [c["id"] for c in out["close"]]]
print(json.dumps({"day6": go(date(2026, 9, 26)), "day7": go(date(2026, 9, 25)),
                  "tickedNoWords": go(None, words="", status="Completed", completed=date(2026, 9, 25)),
                  "tickedOddWords": go(date(2026, 9, 25), words="All sorted I think, is that everything?", status="Completed", completed=date(2026, 9, 25)),
                  "cannot": go(date(2026, 9, 25), words="Can't get hold of him"),
                  "cannotThenTicked": go(date(2026, 9, 25), words="Can't get hold of him", status="Completed", completed=date(2026, 10, 1)),
                  "tomorrow": go(date(2026, 9, 25), words="I'll get it done tomorrow")}))`);
    // His answer closes the journal task even before the next check is due.
    expect(r.day6).toEqual([[], ['recROYTASK000010']]);
    expect(r.day7).toEqual([ROY1, ['recROYTASK000010']]);
    // Ticked done with no words from Roy: the day it was ticked is day 0.
    expect(r.tickedNoWords).toEqual([ROY1, []]);
    // Ticked done with words that cannot be read: done is done. It never stalls with no open task.
    expect(r.tickedOddWords).toEqual([ROY1, []]);
    // "Not done yet" keeps the task his and starts no clock, and so does a promise.
    expect(r.cannot).toEqual([[], []]);
    expect(r.tomorrow).toEqual([[], []]);
    // Day 0 is the day he ticked it, not the day of his earlier "not yet".
    expect(r.cannotThenTicked).toEqual([[], []]);
  });

  it('no word on the journal task: after 10 days the housing costs check asks instead; not after 9', () => {
    const r = py(`
def go(created):
    res, out = plan([new_void(start="2026-09-10", due=25)], [task("recROYTASK000010", NEW + ":journal:1", created=created)])
    return [keys(out), closes(out), stage(res)]
print(json.dumps({"day9": go(date(2026, 9, 23)), "day10": go(date(2026, 9, 22))}))`);
    expect(r.day9).toEqual([[], [], 'waiting on Roy: the journal upload (Roy asked 23 Sep, 9 days ago, no reply yet)']);
    expect(r.day10[0]).toEqual(ROY1);
    expect(r.day10[1]).toEqual([['recROYTASK000010', 'not confirmed in time, so the housing costs check asks instead', true, false]]);
    expect(r.day10[2]).toBe('no word from Roy that the documents are on the journal in 10 days, so the housing costs check asks instead');
  });

  it('the furthest step with a task decides: an old journal task never raises the housing costs check twice', () => {
    const r = py(`
tasks = [task("recROYTASK000010", NEW + ":journal:1", status="Completed", created=date(2026, 9, 1), completed=date(2026, 9, 5)),
         task("recROYTASK000011", NEW + ":costs:1", created=date(2026, 9, 12), said=[(date(2026, 9, 30), "Yes, verified")]),
         draft("recASKTASK000001", NEW + ":costs:1")]
res, out = plan([new_void()], tasks)
print(json.dumps({"keys": keys(out), "note": stage(res)}))`);
    expect(r).toEqual({ keys: [['form', 'recLaneBTest00001:form:1']], note: 'housing costs verified (30 Sep, Roy: "Yes, verified"), the direct rent payment form is due' });
  });

  it('a reply that cannot be read is asked again ONCE: the same reply is never read as the answer to the question it caused', () => {
    const r = py(`
first = task("recROYTASK000011", NEW + ":costs:1", said=[(DAY, "Done")])      # his line is stamped 14:01 London
res, out = plan([new_void()], [first, draft("recASKTASK000001", NEW + ":costs:1")])
# The run that read it raised check 2 an hour later the same day (14:00 UTC is 15:00 London).
second = task("recROYTASK000012", NEW + ":costs:2", hour=14)
res2, out2 = plan([new_void()], [dict(first, status="Completed", completed=DAY), second, draft("recASKTASK000002", NEW + ":costs:2")])
print(json.dumps({"keys": keys(out), "note": stage(res), "name": out["raise"][0]["name"], "close": closes(out),
                  "next": [keys(out2), closes(out2), stage(res2)]}))`);
    expect(r.keys).toEqual(ROY2);
    expect(r.note).toBe("Roy's reply could not be read as yes or no (2 Oct), asked again");
    expect(r.name).toBe('NEW TENANT RENT: housing costs check 2: Unit 9 – 1 Example Road');
    expect(r.close).toEqual([['recROYTASK000011', ANSWERED, true, false]]);
    expect(r.next).toEqual([[], [], 'waiting on Roy: are the housing costs verified (Roy asked 2 Oct, 0 days ago, no reply yet)']);
  });

  it('the same holds for a note typed on his own page at midday, before the 12:30 run raised the next check', () => {
    const r = py(`
first = dict(task("recROYTASK000011", NEW + ":costs:1", status="Completed", completed=DAY), notes=lb.SETUP_KEY_MARK + NEW + ":costs:1\\n[2026-10-02 12:00 Roy Lavin] Done")
second = task("recROYTASK000012", NEW + ":costs:2", hour=11)          # made 11:00 UTC, which is 12:00 in London
res, out = plan([new_void()], [first, second, draft("recASKTASK000002", NEW + ":costs:2")])
later = dict(first, notes=first["notes"] + "\\n[2026-10-02 12:40 Roy Lavin] Yes, verified")
res2, out2 = plan([new_void()], [later, second, draft("recASKTASK000002", NEW + ":costs:2")])
print(json.dumps({"same": [keys(out), stage(res)], "after": stage(res2)}))`);
    expect(r.same).toEqual([[], 'waiting on Roy: are the housing costs verified (Roy asked 2 Oct, 0 days ago, no reply yet)']);
    // A note typed after the newer check was raised does count.
    expect(r.after).toBe('housing costs verified (2 Oct, Roy: "Yes, verified"), the direct rent payment form is due');
  });

  it('a form card still open on a tenancy already marked actioned: the first check is raised and the card is withdrawn, never closed', () => {
    const r = py(`
res, out = plan([new_void(status="CFV Actioned")], [task("recFORMTASK00001", NEW + ":form:1", status="Approval", name="RENT FORM: a form")])
res2, out2 = plan([new_void(status="CFV Actioned")], [task("recFORMTASK00001", NEW + ":form:1", status="Today", name="RENT FORM: a form")])
print(json.dumps([[keys(out), closes(out), stage(res), withdrawn(out)], [keys(out2), closes(out2), withdrawn(out2)]]))`);
    const gone = [['recFORMTASK00001', 'the tenancy is marked CFV Actioned, so the form went in another way']];
    expect(r[0]).toEqual([[['roy', 'recLaneBTest00001:paid:1']], [], 'form sent (the tenancy is marked actioned), so the first check on the direct payment is next', gone]);
    expect(r[1]).toEqual([[['roy', 'recLaneBTest00001:paid:1']], [], gone]);
  });

  it('a task ticked done with no yes or no is asked again; an afterthought never undoes a yes', () => {
    const r = py(`
res, out = plan([new_void()], [task("recROYTASK000011", NEW + ":costs:1", status="Completed", completed=date(2026, 10, 1))])
after = task("recROYTASK000011", NEW + ":costs:1", created=date(2026, 9, 20), said=[(date(2026, 9, 30), "Yes, verified"), (date(2026, 10, 1), "First one should be around the 20th")])
res2, out2 = plan([new_void()], [after, draft("recASKTASK000001", NEW + ":costs:1")])
changed = task("recROYTASK000011", NEW + ":costs:1", created=date(2026, 9, 20), said=[(date(2026, 9, 30), "Yes, verified"), (date(2026, 10, 1), "No, they have asked for the agreement again")])
res3, out3 = plan([new_void()], [changed, draft("recASKTASK000001", NEW + ":costs:1")])
print(json.dumps({"ticked": [keys(out), stage(res)], "after": [keys(out2), stage(res2)], "changed": stage(res3)}))`);
    expect(r.ticked).toEqual([ROY2, "Roy's reply could not be read as yes or no (1 Oct), asked again"]);
    expect(r.after).toEqual([[['form', 'recLaneBTest00001:form:1']], 'housing costs verified (30 Sep, Roy: "Yes, verified"), the direct rent payment form is due']);
    // A later line that IS a yes or a no replaces the earlier one.
    expect(r.changed).toBe('housing costs not verified yet (1 Oct)');
  });

  it('silence on a yes-or-no check is asked again after 7 days, and the old task is closed; not after 6', () => {
    const r = py(`
ask = [draft("recASKTASK000001", NEW + ":costs:1")]
def go(created):
    res, out = plan([new_void()], [task("recROYTASK000011", NEW + ":costs:1", created=created)] + ask)
    return [keys(out), closes(out)]
print(json.dumps({"day6": go(date(2026, 9, 26)), "day7": go(date(2026, 9, 25))}))`);
    expect(r.day6).toEqual([[], []]);
    expect(r.day7).toEqual([ROY2, [['recROYTASK000011', 'no reply, so asked again', true, false]]]);
  });

  it('Roy answers the email of the older check: it counts, when it was written after the newer task was raised', () => {
    const r = py(`
old = task("recROYTASK000011", NEW + ":costs:1", status="Completed", created=date(2026, 9, 10), completed=date(2026, 9, 20),
           said=[(date(2026, 9, 12), "No, not yet"), (date(2026, 9, 28), "Yes, verified now")])
new = task("recROYTASK000012", NEW + ":costs:2", created=date(2026, 9, 20))
ask = [draft("recASKTASK000002", NEW + ":costs:2")]
res, out = plan([new_void()], [old, new] + ask)
stale = dict(old, notes=old["notes"].replace("28 Sep 2026", "15 Sep 2026"))
res2, out2 = plan([new_void()], [stale, new] + ask)
print(json.dumps({"note": stage(res), "close": closes(out), "stale": stage(res2)}))`);
    expect(r.note).toBe('housing costs verified (28 Sep, Roy: "Yes, verified now"), the direct rent payment form is due');
    expect(r.close).toEqual([['recROYTASK000012', ANSWERED, true, false]]);
    // A line from before the newer task was raised answers the older question, not this one.
    expect(r.stale).toBe('waiting on Roy: are the housing costs verified (Roy asked 20 Sep, 12 days ago, no reply yet, asked again)');
  });

  it('the form card: its state is read from its outcome and from Kevin saying he finished his turn, never from its status alone', () => {
    const r = py(`
OPEN = "[02 Oct 2026 10:00 — agent-dispatch] BLOCKER OPEN (KEVIN credential): type the code Fix: f [since 2026-10-02T09:00:00.000Z]"
DONE = "[02 Oct 2026 14:00 — agent] BLOCKER CLEARED (KEVIN credential): x. evidence: Kevin finished his turn in the robot's window (send it), confirmed in the Robot sign-in app.. Carry on"
SUPERSEDED = "[02 Oct 2026 14:00 — agent-dispatch] BLOCKER CLEARED (KEVIN credential): x. superseded: a new submission replaced the work that met this wall."
def card(status="Approval", outcome="", extra="", feedback=""):
    t = task("recFORMTASK00001", NEW + ":form:1", status=status, created=date(2026, 9, 28), name="RENT FORM: direct rent payment form: Unit 9", extra=extra)
    return dict(t, outcome=outcome, feedback=feedback, notes="RENT FORM KEY: " + NEW + ":form:1\\nRENT FORM ANSWERS: abc123\\n" + t["notes"])
def go(c, status="CFV", plans=None):
    res, out = plan([new_void(status=status)], [c], plans=plans)
    return [keys(out), [f["id"] for f in out["finish"]], short(res), [w["why"] for w in out["withdraw"]]]
def prior(c):
    _, out = plan([new_void()], [c])
    p = out["raise"][0]["prior"] if out["raise"] else None
    return p and {"on": p["on"].isoformat(), "feedback": p["feedback"], "print": p["print"]}
TWO = [['form', NEW + ':form:2']]
changes = card(outcome="Changes requested", feedback="The rent is £850, not £900")
withdrawn_changes = card(status="Cancelled", extra='RENT FORM WITHDRAWN: 2026-09-30 Kevin asked for changes: "The rent is £850, not £900"')
print(json.dumps({"queue": go(card()), "turn": go(card(outcome="Approved as-is", extra=OPEN)),
                  "turnWithPlan": go(card(outcome="Approved as-is", extra=OPEN), plans={"recFORMTASK00001"}),
                  "noPlan": go(card(outcome="Approved as-is", extra=OPEN), plans=set()),
                  "edits": go(card(outcome="Approved with minor edits", extra=OPEN)),
                  "sent": go(card(outcome="Approved as-is", extra=OPEN + "\\n" + DONE)),
                  "superseded": go(card(outcome="Approved as-is", extra=OPEN + "\\n" + SUPERSEDED)),
                  "noWall": go(card(outcome="Approved as-is")),
                  "stale": go(card(outcome="Approved as-is", extra=OPEN + "\\nRENT FORM GOOD UNTIL: 2026-10-01")),
                  "fresh": go(card(outcome="Approved as-is", extra=OPEN + "\\nRENT FORM GOOD UNTIL: 2026-10-02")),
                  "staleInQueue": go(card(extra=OPEN + "\\nRENT FORM GOOD UNTIL: 2026-10-01")),
                  "sentStale": go(card(outcome="Approved as-is", extra=OPEN + "\\nRENT FORM GOOD UNTIL: 2026-10-01\\n" + DONE)),
                  "sentThenCancelled": go(card(status="Cancelled", outcome="Approved as-is", extra=OPEN + "\\n" + DONE)),
                  "checkProblem": plan([new_void()], [card(outcome="Approved as-is", extra=OPEN + "\\n" + SUPERSEDED)])[1]["problems"],
                  "cancelledActioned": go(card(status="Cancelled"), status="CFV Actioned"),
                  "changesWhenStale": go(card(outcome="Changes requested", feedback="Wrong rent", extra=OPEN + "\\nRENT FORM GOOD UNTIL: 2026-10-01")),
                  "withdrawnKeepsDay": prior(card(status="Cancelled", outcome="Changes requested",
                                                  extra='RENT FORM WITHDRAWN: 2026-09-30 Kevin asked for changes: "Wrong rent"')),
                  "parked": go(dict(card(status="", extra=OPEN + "\\nRENT FORM GOOD UNTIL: 2026-10-01"), someDay=True)),
                  "setBack": go(card(status="Completed", outcome="Approved as-is", extra=OPEN + "\\n" + DONE + "\\nRENT FORM SENT: x\\nRENT FORM COMMENTED: y\\nRENT FORM ACTIONED: z")),
                  "upcomingPark": go(card(status="Upcoming", extra=OPEN)),
                  "parkedChanges": go(dict(card(status="", outcome="Changes requested", feedback="x", extra=OPEN), someDay=True)),
                  "refusedToday": go(card(status="Cancelled", extra="RENT FORM WITHDRAWN: 2026-10-02 it could not be submitted to Kevin's queue: ERROR")),
                  "refusedYesterday": go(card(status="Cancelled", extra="RENT FORM WITHDRAWN: 2026-10-01 it could not be submitted to Kevin's queue: ERROR")),
                  "rejected": go(card(status="Completed", outcome="Rejected")), "rejectedOpen": go(card(status="Today", outcome="Rejected")),
                  "changes": go(changes), "changesPrior": prior(changes),
                  "stranded": go(card(status="Today")), "strandedToDo": go(card(status="To do")),
                  "withdrawn": go(card(status="Cancelled", extra="RENT FORM WITHDRAWN: 2026-10-01 it never reached Kevin's queue")),
                  "withdrawnChanges": go(withdrawn_changes), "withdrawnPrior": prior(withdrawn_changes),
                  "byHand": go(card(status="Cancelled")), "unknown": go(card(status="Today", outcome="Snoozed")),
                  "markedOnly": go(card(status="Completed", outcome="Approved as-is", extra="RENT FORM SENT: Kevin confirmed")),
                  "actionedAndSent": go(card(outcome="Approved as-is", extra=OPEN + "\\n" + DONE), status="CFV Actioned"),
                  "actionedAndMarked": go(card(status="Completed", outcome="Approved as-is", extra=OPEN + "\\n" + DONE + "\\nRENT FORM SENT: x"), status="CFV Actioned"),
                  "actionedAndCommented": go(card(status="Completed", outcome="Approved as-is", extra=OPEN + "\\n" + DONE + "\\nRENT FORM SENT: x\\nRENT FORM COMMENTED: y"), status="CFV Actioned"),
                  "sameWall": lb._WALL_RE.pattern == load_mod("ad", "agent-dispatch.py").BLOCKER_LINE_RE.pattern}))`);
    expect(r.queue).toEqual([[], [], 'form card with Kevin', []]);
    expect(r.turn).toEqual([[], [], 'your turn', []]);
    expect(r.turnWithPlan).toEqual([[], [], 'your turn', []]);
    expect(r.edits).toEqual([[], [], 'your turn', []]);
    // Without its plan on file there is no Your turn button: never a "your turn" nobody can take.
    const again = 'approved, but its Your turn step was closed or its plan was missing, and Kevin had not said he sent the form';
    expect(r.noPlan).toEqual([[['form', 'recLaneBTest00001:form:2']], [], 'form card raised again', [again]]);
    // Kevin said he finished: the card is finished and the tenancy marked actioned (finish_form).
    expect(r.sent).toEqual([[], ['recFORMTASK00001'], 'form sent', []]);
    // A Your turn step closed without the app's words that Kevin sent it: he may have sent it, so it is
    // never raised again on a guess (a second card could send the government form twice). Said instead.
    expect(r.superseded).toEqual([[], [], 'form card to check', []]);
    expect(r.checkProblem).toEqual(["Unit 9 – 1 Example Road: the form card's window was used but the app never recorded whether "
      + 'Kevin sent the form: if it went in, marking the tenancy CFV Actioned starts the payment checks; if it did not, '
      + 'cancelling the card raises a fresh one']);
    // No Your turn step ever opened: nothing can have been sent through it.
    expect(r.noWall).toEqual([[['form', 'recLaneBTest00001:form:2']], [], 'form card raised again', [again]]);
    // The robot's arrears answer holds only until the day before the next rent: after that a fresh count, a fresh card.
    const stale = 'its arrears answer was counted before the rent due after 1 Oct 2026';
    expect(r.stale).toEqual([[['form', 'recLaneBTest00001:form:2']], [], 'form card raised again', [stale]]);
    // Still waiting on Kevin (in his queue, deferred or parked): his card, however old its count.
    expect(r.staleInQueue).toEqual([[], [], 'form card with Kevin', []]);
    expect(r.fresh).toEqual([[], [], 'your turn', []]);
    // Sent is sent: neither a stale count nor a hand cancel undoes Kevin's word.
    expect(r.sentStale).toEqual([[], ['recFORMTASK00001'], 'form sent', []]);
    expect(r.sentThenCancelled).toEqual([[], ['recFORMTASK00001'], 'form sent', []]);
    expect(r.rejected).toEqual([[], [], 'form sent back', []]);
    expect(r.rejectedOpen).toEqual([[], [], 'form sent back', []]);
    // Request changes: withdrawn quoting him, and the next card waits for an answer to change (raise_form).
    expect(r.changes).toEqual([[['form', 'recLaneBTest00001:form:2']], [], 'form card changes', ['Kevin asked for changes: "The rent is £850, not £900"']]);
    expect(r.changesPrior).toEqual({ on: '2026-10-02', feedback: 'The rent is £850, not £900', print: 'abc123' });
    expect(r.withdrawnChanges).toEqual([[['form', 'recLaneBTest00001:form:2']], [], 'form card changes', []]);
    expect(r.withdrawnPrior).toEqual({ on: '2026-09-30', feedback: 'The rent is £850, not £900', print: 'abc123' });
    // Created but never submitted, and its cancel failed too: nobody would ever see it.
    expect(r.stranded).toEqual([[['form', 'recLaneBTest00001:form:2']], [], 'form card raised again', ["it never reached Kevin's queue"]]);
    expect(r.strandedToDo).toEqual(r.stranded);
    expect(r.withdrawn).toEqual([[['form', 'recLaneBTest00001:form:2']], [], 'form card raised again', []]);
    // Cancelled by hand, with no WITHDRAWN line: the clock stops, as for any of Roy's tasks.
    expect(r.byHand).toEqual([[], [], 'stopped by hand', []]);
    expect(r.unknown).toEqual([[], [], 'form card to check', []]);
    // A sent mark typed on a card is not Kevin's word: only his finished turn is.
    expect(r.markedOnly).toEqual([[], [], 'form card closed', []]);
    // Once actioned the first direct rent check is raised; an unfinished card is finished until its comment is written.
    expect(r.actionedAndSent).toEqual([[['roy', 'recLaneBTest00001:paid:1']], ['recFORMTASK00001'], 'form sent, awaiting rent', []]);
    expect(r.actionedAndMarked).toEqual([[['roy', 'recLaneBTest00001:paid:1']], ['recFORMTASK00001'], 'form sent, awaiting rent', []]);
    expect(r.actionedAndCommented).toEqual([[['roy', 'recLaneBTest00001:paid:1']], [], 'form sent, awaiting rent', []]);
    expect(r.sameWall).toBe(true);
    // Cancelled by hand on a tenancy marked actioned: the form was done another way, so Roy's checks follow.
    expect(r.cancelledActioned).toEqual([[['roy', 'recLaneBTest00001:paid:1']], [], 'form sent, awaiting rent', []]);
    // Kevin's request for changes beats the expiry: his words are quoted and his wait applies.
    expect(r.changesWhenStale).toEqual([[['form', 'recLaneBTest00001:form:2']], [], 'form card changes', ['Kevin asked for changes: "Wrong rent"']]);
    // A card already withdrawn for changes keeps the day it was withdrawn, whatever its old verdict says.
    expect(r.withdrawnKeepsDay).toEqual({ on: '2026-09-30', feedback: 'Wrong rent', print: 'abc123' });
    // Parked with the Some Day tick (Status blanked): his park stands, even past the good-until day.
    expect(r.parked).toEqual([[], [], 'form card parked', []]);
    // Marked CFV Actioned once by the rent check, then set back to CFV by somebody: left as it is.
    expect(r.setBack).toEqual([[], [], 'form sent, set back by hand', []]);
    // Submitted (its step is open), then moved out of his queue by him: parked, never "stranded".
    expect(r.upcomingPark).toEqual([[], [], 'form card parked', []]);
    // Parked with Some Day after asking for changes: the park is his newer word.
    expect(r.parkedChanges).toEqual([[], [], 'form card parked', []]);
    // Refused at submit: raised again the next day, not at the 12:30 run.
    expect(r.refusedToday).toEqual([[], [], 'form card raised again tomorrow', []]);
    expect(r.refusedYesterday).toEqual([[['form', 'recLaneBTest00001:form:2']], [], 'form card raised again', []]);
  });

  it('three refusals at submit in a row stop and say so; Kevin\'s request for changes is quoted on every later card', () => {
    const r = py(`
def card(i, n, extra, status="Cancelled", outcome=""):
    t = task("recFORMTASK0000%d" % i, NEW + ":form:%d" % n, status=status, created=date(2026, 9, 20 + n), name="RENT FORM: a form", extra=extra)
    return dict(t, outcome=outcome, notes="RENT FORM KEY: " + NEW + ":form:%d\\n" % n + t["notes"])
REF = "RENT FORM WITHDRAWN: 2026-09-2%d it could not be submitted to Kevin's queue: ERROR"
three = [card(1, 1, REF % 7), card(2, 2, REF % 8), card(3, 3, REF % 9)]
res, out = plan([new_void()], three)
_, week = plan([new_void()], three, day=date(2026, 10, 6))
two = [card(1, 1, 'RENT FORM WITHDRAWN: 2026-09-21 Kevin asked for changes: "Wrong rent"'), card(2, 2, REF % 2), card(3, 3, REF % 3)]
_, out2 = plan([new_void()], two)
expired = [card(1, 1, 'RENT FORM WITHDRAWN: 2026-09-21 Kevin asked for changes: "Wrong rent"'),
           card(2, 2, "RENT FORM WITHDRAWN: 2026-09-30 its arrears answer was counted before the rent due after 29 Sep 2026")]
_, out3 = plan([new_void()], expired)
p3 = out3["raise"][0]["prior"]
print(json.dumps({"stop": [keys(out), short(res), out["problems"]], "notThree": keys(out2), "week": keys(week),
                  "quoted": [keys(out3), p3["on"].isoformat(), p3["feedback"], p3["print"]]}))`);
    expect(r.stop[0]).toEqual([]);
    expect(r.stop[1]).toBe('form card to check');
    expect(r.stop[2][0]).toMatch(/refused at submit 3 times in a row .*it is tried again on 6 Oct/);
    // A week after the last refusal it is tried again: the stop is never for good.
    expect(r.week).toEqual([['form', 'recLaneBTest00001:form:4']]);
    // A request for changes in between breaks the run of refusals.
    expect(r.notThree).toEqual([['form', 'recLaneBTest00001:form:4']]);
    expect(r.quoted).toEqual([[['form', 'recLaneBTest00001:form:3']], '2026-09-21', 'Wrong rent', null]);
  });

  it('a card Kevin may have sent is never withdrawn or raised again, whatever else is true; it is said instead', () => {
    const r = py(`
OPEN = "[02 Oct 2026 10:00 — agent-dispatch] BLOCKER OPEN (KEVIN credential): type the code Fix: f [since 2026-10-02T09:00:00.000Z]"
SUPERSEDED = "[02 Oct 2026 14:00 — agent-dispatch] BLOCKER CLEARED (KEVIN credential): x. superseded: a new submission replaced the work that met this wall."
NOT_YET = "[02 Oct 2026 15:00 — agent] Your turn window closed without Kevin finishing. The task stays his, and the Your turn button stays on the AI Agents page."
def card(extra="", outcome="Approved as-is", status="Today"):
    t = task("recFORMTASK00001", NEW + ":form:1", status=status, created=date(2026, 9, 28), name="RENT FORM: a form", extra=extra)
    return dict(t, outcome=outcome, notes="RENT FORM KEY: " + NEW + ":form:1\\n" + t["notes"])
EXPIRED = "\\nRENT FORM GOOD UNTIL: 2026-10-01"
def go(c, windows=None, tenancies=None):
    res, out = lb_plan(tenancies or [new_void()], [c], windows)
    return [keys(out), withdrawn(out), short(res) if tenancies is None else None]
def lb_plan(tenancies, tasks, windows):
    data, res = assess(tenancies)
    tenants_of = {r["id"]: list(r["fields"].get(TY["tenants"]) or []) for r in data["tenancies"]}
    starts = {r["id"]: rc.parse_day(r["fields"].get(TY["start"])) for r in data["tenancies"]}
    pays = rc.payments_by_tenancy(data["tx"])
    out = lb.plan(res, tasks, tenants_of, NAMES, DAY, starts, pays, rc.feed_state(data, pays, datetime(2026, 10, 2, 12, 30, tzinfo=timezone.utc)), None, {}, windows)
    lb.annotate(res, out["rows"])
    return res, out
print(json.dumps({
  "closedAndExpired": go(card(OPEN + "\\n" + SUPERSEDED + EXPIRED)),
  "windowNoAnswerExpired": go(card(OPEN + EXPIRED), windows={"recFORMTASK00001": 1}),
  "windowNotYetExpired": go(card(OPEN + "\\n" + NOT_YET + EXPIRED), windows={"recFORMTASK00001": 1}),
  "twoWindowsOneNotYet": go(card(OPEN + "\\n" + NOT_YET + EXPIRED), windows={"recFORMTASK00001": 2}),
  "movedOn": go(card(OPEN + "\\n" + SUPERSEDED), tenancies=[new_void(status="In Payment")]),
  "upcomingExpired": go(card(OPEN + EXPIRED, status="Upcoming")),
  "actioned": go(card(OPEN + "\\n" + SUPERSEDED), tenancies=[new_void(status="CFV Actioned")]),
  "ownClear": lb.may_have_sent({"id": "x", "notes": OPEN + "\\n[03 Oct 2026 10:00 — rent-check] BLOCKER CLEARED (KEVIN credential): withdrawn: x"}),
}))`);
    // Closed oddly and past its good-until day: still never raised again (it may have been sent).
    expect(r.closedAndExpired).toEqual([[], [], 'form card to check']);
    // The robot opened its window and the app never recorded an answer: may have been sent.
    expect(r.windowNoAnswerExpired).toEqual([[], [], 'form card to check']);
    // He said "Not yet" for the one window: not sent, so the out-of-date card is raised afresh.
    expect(r.windowNotYetExpired[0]).toEqual([['form', 'recLaneBTest00001:form:2']]);
    expect(r.twoWindowsOneNotYet).toEqual([[], [], 'form card to check']);
    // A tenancy that has moved on keeps a maybe-sent card, said, never withdrawn.
    expect(r.movedOn.slice(0, 2)).toEqual([[], []]);
    // Approved, then parked as Upcoming: past its good-until day it waits for him to move it back.
    expect(r.upcomingExpired).toEqual([[], [], 'form card parked']);
    // Marked actioned: Roy's first check follows, and the maybe-sent card is left as it is (never withdrawn).
    expect(r.actioned.slice(0, 2)).toEqual([[['roy', 'recLaneBTest00001:paid:1']], []]);
    // The rent check's own clear (a withdrawal or a closed card) is never read as Kevin's step.
    expect(r.ownClear).toBe(false);
  });

  it('a window open now leaves the card alone; a card he cancels after an unrecorded window is his "not sent"; its step is closed, never run twice', () => {
    const r = py(`
OPEN = "[02 Oct 2026 10:00 — agent-dispatch] BLOCKER OPEN (KEVIN credential): type the code Fix: f [since 2026-10-02T09:00:00.000Z]"
def card(extra="", outcome="Approved as-is", status="Today"):
    t = task("recFORMTASK00001", NEW + ":form:1", status=status, created=date(2026, 9, 28), name="RENT FORM: a form", extra=extra)
    return dict(t, outcome=outcome, notes="RENT FORM KEY: " + NEW + ":form:1\\n" + t["notes"])
def go(c, windows, status="CFV"):
    res, out = plan([new_void(status=status)], [c], windows=windows)
    return [keys(out), withdrawn(out), short(res), [x["id"] for x in out["closeSteps"]], [x["id"] for x in out["complete"]]]
EXPIRED = "\\nRENT FORM GOOD UNTIL: 2026-10-01"
print(json.dumps({
  "openNowExpired": go(card(OPEN + EXPIRED), {"recFORMTASK00001": {"used": 0, "openNow": True}}),
  "unrecorded": go(card(OPEN), {"recFORMTASK00001": {"used": 1, "openNow": False}}),
  "cancelledAfter": go(card(OPEN, status="Cancelled"), {"recFORMTASK00001": {"used": 1, "openNow": False}}),
  "actionedUnrecorded": go(card(OPEN), {"recFORMTASK00001": {"used": 1, "openNow": False}}, status="CFV Actioned"),
  "passedOver": (lambda o: [keys(o), withdrawn(o), [x["id"] for x in o["complete"]], o["problems"]])(plan([new_void(status="CFV Actioned")],
      [card(OPEN), task("recROYTASK000012", NEW + ":paid:1", created=date(2026, 9, 30))], windows={"recFORMTASK00001": {"used": 1, "openNow": False}})[1]),
  "justClosed": go(card(OPEN + EXPIRED), {"recFORMTASK00001": {"used": 1, "openNow": False, "recentClose": True}}),
  "markOnly": go(card(OPEN + "\\n[03 Oct 2026 07:30 — rent-check] BLOCKER CLEARED (KEVIN credential): the window was used but "
                      "the app never recorded whether Kevin sent the form, so this step is closed" + EXPIRED), {}),
}))`);
    // His window is open (he may be waiting for the emailed code): nothing is withdrawn, even past its day.
    expect(r.openNowExpired).toEqual([[], [], 'form window open', [], []]);
    // A window used with no answer recorded: said, and its Your turn step closed so it is never run twice.
    expect(r.unrecorded).toEqual([[], [], 'form card to check', ['recFORMTASK00001'], []]);
    // He then cancels it: his answer is "not sent", and a fresh card is raised.
    expect(r.cancelledAfter).toEqual([[['form', 'recLaneBTest00001:form:2']], [], 'form card raised again', [], []]);
    // On a tenancy marked actioned the payment checks follow, and the card is closed (never withdrawn).
    expect(r.actionedUnrecorded).toEqual([[['roy', 'recLaneBTest00001:paid:1']], [], 'form sent, awaiting rent', [], ['recFORMTASK00001']]);
    // Roy's payment checks already under way: the old card is closed once, never reported on every run.
    expect(r.passedOver.slice(1)).toEqual([[], ['recFORMTASK00001'], []]);
    // Just closed, the app may still be asking him: nothing is touched, its step stays open.
    expect(r.justClosed).toEqual([[], [], 'form window open', [], []]);
    // The step-close line is its own lasting mark: with no robot log at all it is still "may have sent".
    expect(r.markOnly).toEqual([[], [], 'form card to check', [], []]);
  });

  it('after the clock has ended, or on a do-not-chase tenancy, its open form cards are still settled', () => {
    const r = py(`
OPEN = "[02 Oct 2026 10:00 — agent-dispatch] BLOCKER OPEN (KEVIN credential): type the code Fix: f [since 2026-10-02T09:00:00.000Z]"
ended = task("recROYTASK000012", NEW + ":paid:1", status="Completed", extra="RENT SETUP ENDED: rent reached the bank, seen 2 Oct 2026.")
def card(status="Today"):
    t = task("recFORMTASK00001", NEW + ":form:1", status=status, created=date(2026, 9, 28), name="RENT FORM: a form", extra=OPEN)
    return dict(t, outcome="Approved as-is", notes="RENT FORM KEY: " + NEW + ":form:1\\n" + t["notes"])
def go(windows, tenancies=None, extra=None, **kw):
    _, out = plan(tenancies or [new_void(status="CFV Actioned")], [ended, card()] if extra is None else extra, windows=windows, **kw)
    return [withdrawn(out), [c["id"] for c in out["complete"]]]
W = lambda **k: {"recFORMTASK00001": dict({"used": 0, "openNow": False, "recentClose": False}, **k)}
print(json.dumps({"endedOpen": go({}), "endedMaybe": go(W(used=1)), "endedBusy": go(W(openNow=True)),
                  "noChaseMaybe": go(W(used=1), [new_void(status="CFV Actioned")], [card()], noChase=["recT_uc"]),
  "noChaseCheck": plan([new_void()], [card()], windows=W(used=1), noChase=["recT_uc"])[1]["problems"],
  "stoppedSent": [f["id"] for f in plan([new_void(status="CFV Actioned")], [task("recROYTASK000012", NEW + ":paid:1", status="Cancelled"),
      dict(card(status="Completed"), notes=card()["notes"] + "\\n[02 Oct 2026 14:00 — agent] BLOCKER CLEARED (KEVIN credential): x. evidence: Kevin finished his turn in the robot's window (send it).")])[1]["finish"]]}))`);
    expect(r.endedOpen).toEqual([[['recFORMTASK00001', 'rent has reached the bank, nothing more to do']], []]);
    expect(r.endedMaybe).toEqual([[], ['recFORMTASK00001']]);
    // In his turn right now: left for a later run.
    expect(r.endedBusy).toEqual([[], []]);
    expect(r.noChaseMaybe).toEqual([[], ['recFORMTASK00001']]);
    // A clock stopped by hand still records his own word that he sent a form.
    expect(r.stoppedSent).toEqual(['recFORMTASK00001']);
    // Still a CFV on the do-not-chase list: the card that needs his word is said, never silent.
    expect(r.noChaseCheck).toEqual([expect.stringMatching(/^Unit 9 – 1 Example Road: the form card's window was used but the app never recorded/)]);
  });

  it('the robot log is read for each card\'s windows; a missing log is none, a bad line is skipped', () => {
    const r = py(`
path = os.path.join(SCRATCH, "runs.jsonl")
NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
op = lambda t, at: json.dumps({"cmd": "handover-open", "task": t, "at": at})
rows = [op("recA", "2026-10-01T09:00:00Z"), json.dumps({"cmd": "handover", "task": "recA"}), "not json", json.dumps({"cmd": "commit", "task": "recA"}),
        op("recA", "2026-10-01T10:00:00Z"), json.dumps({"cmd": "handover", "task": "recA"}), "[1, 2]", json.dumps({"task": 5}),
        op("recOpen", "2026-10-02T07:00:00Z"), op("recCrash", "2026-09-30T07:00:00Z"), json.dumps({"cmd": "handover", "task": "recOld"}),
        op("recJust", "2026-10-02T09:00:00Z"), json.dumps({"cmd": "handover", "task": "recJust", "at": "2026-10-02T10:00:00Z"})]
open(path, "wb").write(("\\n".join(rows) + "\\n").encode() + b'{"cmd": "handover", "task": "recTorn\\xff\\xfe')
print(json.dumps({"counts": lb.read_windows(path, NOW), "missing": lb.read_windows(os.path.join(SCRATCH, "none.jsonl"), NOW),
                  "same": lb.ROBOT_LOG.endswith("knowledge-os/logs/agent-browser/runs.jsonl")}))`);
    // Opened and closed twice; one open now (under a day); one opened two days ago and never closed (a
    // crash: read as used); a close with no open logged (an older robot): used. A torn last line is skipped.
    expect(r.counts).toEqual({ recA: { used: 2, openNow: false, recentClose: false }, recOpen: { used: 0, openNow: true, recentClose: false },
      recCrash: { used: 1, openNow: false, recentClose: false }, recOld: { used: 1, openNow: false, recentClose: false },
      recJust: { used: 1, openNow: false, recentClose: true } });
    expect(r.missing).toEqual({});
    // The same file scripts/agent-browser.js writes (its LEDGER).
    expect(r.same).toBe(true);
  });

  it('an older form card: finished if Kevin sent it, withdrawn if still open, left if closed', () => {
    const r = py(`
DONE = "[02 Oct 2026 14:00 — agent] BLOCKER CLEARED (KEVIN credential): x. evidence: Kevin finished his turn in the robot's window (send it), confirmed in the Robot sign-in app.. Carry on"
def card(i, n, status, extra=""):
    t = task(i, NEW + ":form:%d" % n, status=status, created=date(2026, 9, 20 + n), name="RENT FORM: a form", extra=extra)
    return dict(t, notes="RENT FORM KEY: " + NEW + ":form:%d\\n" % n + t["notes"])
newest = card("recFORMTASK00003", 3, "Approval")
_, open_old = plan([new_void()], [card("recFORMTASK00001", 1, "Today"), newest])
_, sent_old = plan([new_void()], [card("recFORMTASK00001", 1, "Completed", extra=DONE), newest])
_, closed_old = plan([new_void()], [card("recFORMTASK00001", 1, "Cancelled", extra="RENT FORM WITHDRAWN: 2026-09-22 x"), newest])
print(json.dumps({"open": [withdrawn(open_old), [f["id"] for f in open_old["finish"]]],
                  "sent": [withdrawn(sent_old), [f["id"] for f in sent_old["finish"]]],
                  "closed": [withdrawn(closed_old), [f["id"] for f in closed_old["finish"]]]}))`);
    expect(r.open).toEqual([[['recFORMTASK00001', 'a newer step has taken over from this form card']], []]);
    expect(r.sent).toEqual([[], ['recFORMTASK00001']]);
    expect(r.closed).toEqual([[], []]);
  });

  it('a card Kevin sent still gets its comment when somebody has moved the tenancy on, and nothing else is done', () => {
    const r = py(`
DONE = "[02 Oct 2026 14:00 — agent] BLOCKER CLEARED (KEVIN credential): x. evidence: Kevin finished his turn in the robot's window (send it), confirmed in the Robot sign-in app.. Carry on"
def card(extra):
    t = task("recFORMTASK00001", NEW + ":form:1", status="Completed", created=date(2026, 9, 28), name="RENT FORM: a form", extra=extra)
    return dict(t, notes="RENT FORM KEY: " + NEW + ":form:1\\n" + t["notes"])
moved = new_void(status="In Payment")
_, out = plan([moved], [card(DONE)])
_, done = plan([moved], [card(DONE + "\\nRENT FORM COMMENTED: x")])
_, unsent = plan([moved], [card("")])
print(json.dumps({"finish": [f["id"] for f in out["finish"]], "raise": keys(out), "withdraw": withdrawn(out),
                  "done": [f["id"] for f in done["finish"]], "unsent": [f["id"] for f in unsent["finish"]]}))`);
    expect(r.finish).toEqual(['recFORMTASK00001']);
    expect([r.raise, r.withdraw, r.done, r.unsent]).toEqual([[], [], [], []]);
  });

  it('a card for a tenancy that has moved on leaves Kevin\'s queue, even while the bank data holds everything else; cannot tell on a CFV tenancy is not moving on', () => {
    const r = py(`
def card():
    t = task("recFORMTASK00001", NEW + ":form:1", status="Approval", created=date(2026, 9, 28), name="RENT FORM: a form")
    return dict(t, notes="RENT FORM KEY: " + NEW + ":form:1\\n" + t["notes"])
def go(tenancies, **kw):
    res, out = plan(tenancies, [card()], **kw)
    return [withdrawn(out), keys(out)]
print(json.dumps({
  "staleFeed": go([new_void(status="CFV Actioned")], feed="2026-09-20T11:03:29.000Z"),
  "inPayment": go([new_void(status="In Payment")]),
  "notLive": go([]),
  "unknownCFV": go([tenancy(NEW, 0, 900.00, status="CFV", start="2026-09-25", unit="Unit 9 – 1 Example Road")]),
  "unknownActioned": go([tenancy(NEW, 0, 900.00, status="CFV Actioned", start="2026-09-25", unit="Unit 9 – 1 Example Road")]),
}))`);
    // Marked actioned by hand over a weekend with a stale feed: the card still leaves his queue (no second DWP form).
    expect(r.staleFeed[0]).toEqual([['recFORMTASK00001', 'the tenancy is marked CFV Actioned, so the form went in another way']]);
    expect(r.staleFeed[1]).toEqual([]);
    expect(r.inPayment).toEqual([[['recFORMTASK00001', 'the tenancy is marked In Payment, so no form is needed']], []]);
    expect(r.notLive).toEqual([[['recFORMTASK00001', 'the tenancy is not a live tenancy today, so no form is needed']], []]);
    expect(r.unknownCFV).toEqual([[], []]);
    expect(r.unknownActioned).toEqual([[['recFORMTASK00001', 'the tenancy is marked CFV Actioned, so no form is needed']], []]);
  });

  it('a tenancy the rent check cannot judge, or one on the do-not-chase list, still has its form cards kept straight', () => {
    const r = py(`
DONE = "[02 Oct 2026 14:00 — agent] BLOCKER CLEARED (KEVIN credential): x. evidence: Kevin finished his turn in the robot's window (send it), confirmed in the Robot sign-in app.. Carry on"
def card(outcome="", extra="", status="Approval", feedback=""):
    t = task("recFORMTASK00001", NEW + ":form:1", status=status, created=date(2026, 9, 28), name="RENT FORM: a form", extra=extra)
    return dict(t, outcome=outcome, feedback=feedback, notes="RENT FORM KEY: " + NEW + ":form:1\\n" + t["notes"])
unknown = tenancy(NEW, 0, 900.00, status="CFV", start="2026-09-25", unit="Unit 9 – 1 Example Road")
def go(c, tenancies=None, **kw):
    _, out = plan(tenancies or [unknown], [c], **kw)
    return [withdrawn(out), [f["id"] for f in out["finish"]], keys(out)]
print(json.dumps({
  "changes": go(card(outcome="Changes requested", feedback="Wrong rent", status="Today")),
  "expired": go(card(outcome="Approved as-is", status="Today", extra="RENT FORM GOOD UNTIL: 2026-10-01")),
  "waiting": go(card()),
  "noChaseSent": go(card(outcome="Approved as-is", status="Completed", extra=DONE), [new_void()], noChase=["recT_uc"]),
  "noChaseChanges": go(card(outcome="Changes requested", feedback="Wrong rent", status="Today"), [new_void()], noChase=["recT_uc"]),
}))`);
    expect(r.changes).toEqual([[['recFORMTASK00001', 'Kevin asked for changes: "Wrong rent"']], [], []]);
    expect(r.expired).toEqual([[['recFORMTASK00001', 'its arrears answer was counted before the rent due after 1 Oct 2026']], [], []]);
    expect(r.waiting).toEqual([[], [], []]);
    expect(r.noChaseSent).toEqual([[], ['recFORMTASK00001'], []]);
    expect(r.noChaseChanges).toEqual([[['recFORMTASK00001', 'Kevin asked for changes: "Wrong rent"']], [], []]);
  });

  it('after the clock has ended, a card Kevin sent still gets its comment, and nothing else is touched', () => {
    const r = py(`
DONE = "[02 Oct 2026 14:00 — agent] BLOCKER CLEARED (KEVIN credential): x. evidence: Kevin finished his turn in the robot's window (send it), confirmed in the Robot sign-in app.. Carry on"
ended = task("recROYTASK000012", NEW + ":paid:1", status="Completed", extra="RENT SETUP ENDED: rent reached the bank, seen 2 Oct 2026.")
def card(extra):
    t = task("recFORMTASK00001", NEW + ":form:1", status="Completed", created=date(2026, 9, 28), name="RENT FORM: a form", extra=extra)
    return dict(t, notes="RENT FORM KEY: " + NEW + ":form:1\\n" + t["notes"])
_, out = plan([new_void(status="CFV Actioned")], [ended, card(DONE)])
_, done = plan([new_void(status="CFV Actioned")], [ended, card(DONE + "\\nRENT FORM COMMENTED: x")])
print(json.dumps({"finish": [f["id"] for f in out["finish"]], "rest": [keys(out), closes(out), withdrawn(out)],
                  "done": [f["id"] for f in done["finish"]]}))`);
    expect(r.finish).toEqual(['recFORMTASK00001']);
    expect(r.rest).toEqual([[], [], []]);
    expect(r.done).toEqual([]);
  });

  it('the arrears the form asks about are counted from the due days since the tenancy began', () => {
    const r = py(`
pays = lambda *xs: [{"day": date.fromisoformat(d), "amount": a} for d, a in xs]
print(json.dumps({
  "none": lb.months_unpaid(date(2026, 9, 25), 25, 900.0, [], date(2026, 10, 2)),
  "two": lb.months_unpaid(date(2026, 8, 25), 25, 900.0, [], date(2026, 10, 2)),
  "partPaid": lb.months_unpaid(date(2026, 8, 25), 25, 900.0, pays(("2026-09-01", 450.0)), date(2026, 10, 2)),
  "early": lb.months_unpaid(date(2026, 8, 25), 25, 900.0, pays(("2026-08-21", 900.0), ("2026-08-19", 900.0)), date(2026, 10, 2)),
  "shortMonth": lb.months_unpaid(date(2026, 1, 31), 31, 900.0, [], date(2026, 3, 1)),
  "tooOld": lb.months_unpaid(date(2026, 7, 1), 1, 900.0, [], date(2026, 10, 2)),
  "noDue": lb.months_unpaid(date(2026, 9, 25), 0, 900.0, [], date(2026, 10, 2)),
  "plan": plan([new_void(start="2026-08-25", due=25)], [task("recROYTASK000011", NEW + ":costs:1", said=[(date(2026, 10, 1), "Yes, verified")])])[1]["raise"][0]["arrears"]}))`);
    const at = { asAt: '2026-10-02', next: '2026-10-25' };
    expect(r.none).toEqual({ months: 1, owed: 900, falls: 1, paid: 0, ...at });
    expect(r.two).toEqual({ months: 2, owed: 1800, falls: 2, paid: 0, ...at });
    expect(r.partPaid).toEqual({ months: 1.5, owed: 1350, falls: 2, paid: 450, ...at });
    // A payment up to 5 days before the start counts; one 6 days before does not.
    expect(r.early).toEqual({ months: 1, owed: 900, falls: 2, paid: 900, ...at });
    // 31 Jan, then 28 Feb: a due day the month lacks falls on its last day.
    expect(r.shortMonth).toEqual({ months: 2, owed: 1800, falls: 2, paid: 0, asAt: '2026-03-01', next: '2026-03-31' });
    // Older than the matched payments the rent check reads, or no due day: it cannot say.
    expect(r.tooOld).toBeNull();
    expect(r.noDue).toBeNull();
    expect(r.plan).toEqual({ months: 2, owed: 1800, falls: 2, paid: 0, ...at });
  });

  it('a tenancy marked actioned with no form task: whatever Roy last said, the first check is raised that day for 14 days on', () => {
    const r = py(`
t = new_void(status="CFV Actioned")
def go(tasks):
    res, out = plan([t], tasks)
    return [keys(out), closes(out), stage(res)]
bare = go([])
silent = go([task("recROYTASK000011", NEW + ":costs:1", created=date(2026, 9, 28)), draft("recASKTASK000001", NEW + ":costs:1")])
said_no = go([task("recROYTASK000011", NEW + ":costs:1", created=date(2026, 9, 20), said=[(date(2026, 9, 22), "No, not yet")]), draft("recASKTASK000001", NEW + ":costs:1")])
_, out = plan([t], [])
first = out["raise"][0]
print(json.dumps({"bare": bare, "silent": silent, "saidNo": said_no,
                  "first": {"name": first["name"], "due": first["due"].isoformat(), "notes": first["notes"], "says": "On or after 16 Oct 2026" in first["description"]}}))`);
    expect(r.bare).toEqual([[['roy', 'recLaneBTest00001:paid:1']], [], 'marked actioned with no task on record, so the first check on the direct payment is next']);
    const moved = [[['roy', 'recLaneBTest00001:paid:1']], [['recROYTASK000011', 'the form has gone in, so this check is finished', true, false]],
      'form sent (the tenancy is marked actioned), so the first check on the direct payment is next'];
    expect(r.silent).toEqual(moved);
    expect(r.saidNo).toEqual(moved);
    expect(r.first).toEqual({ name: 'NEW TENANT RENT: direct rent check: Unit 9 – 1 Example Road', due: '2026-10-16',
      notes: 'RENT SETUP KEY: recLaneBTest00001:paid:1\nRENT SETUP FIRST CHECK: 2026-10-16', says: true });
  });

  it('that first check: the tenant is asked on its day, not before, and silence is counted from its day', () => {
    const r = py(`
t = new_void(status="CFV Actioned")
def go(check, created, drafts=()):
    _, out = plan([t], [task("recROYTASK000012", NEW + ":paid:1", created=created, extra="RENT SETUP FIRST CHECK: " + check)] + list(drafts))
    return [keys(out), closes(out)]
print(json.dumps({"before": go("2026-10-03", date(2026, 9, 19)), "onTheDay": go("2026-10-02", date(2026, 9, 18)),
                  "day13": go("2026-09-19", date(2026, 9, 5), [draft("recASKTASK000001", NEW + ":paid:1")]),
                  "day14": go("2026-09-18", date(2026, 9, 4), [draft("recASKTASK000001", NEW + ":paid:1")])}))`);
    expect(r.before).toEqual([[], []]);
    expect(r.onTheDay).toEqual([[['ask', 'recLaneBTest00001:paid:1']], []]);
    expect(r.day13).toEqual([[], []]);
    expect(r.day14).toEqual([[['roy', 'recLaneBTest00001:paid:2'], ['ask', 'recLaneBTest00001:paid:2']],
      [['recROYTASK000012', 'no reply, so asked again', true, false]]]);
  });

  it('on a paid check any reply is his check for the fortnight, readable or not', () => {
    const r = py(`
said = [(date(2026, 9, 3), "No, not set up"), (date(2026, 9, 13), "Rang again, they said next week")]
def go(day):
    res, out = plan([new_void(status="CFV Actioned")], [task("recROYTASK000012", NEW + ":paid:2", created=date(2026, 9, 1), said=said),
                                                        draft("recASKTASK000001", NEW + ":paid:2")], day=day)
    return [keys(out), stage(res)]
print(json.dumps({"day13": go(date(2026, 9, 26)), "day14": go(date(2026, 9, 27))}))`);
    expect(r.day13).toEqual([[], 'form sent, waiting for the first payment (Roy last checked 13 Sep)']);
    expect(r.day14[0]).toEqual([['roy', 'recLaneBTest00001:paid:3'], ['ask', 'recLaneBTest00001:paid:3']]);
  });

  it('silence on an ordinary paid check is asked again every 14 days; not after 13', () => {
    const r = py(`
ask = [draft("recASKTASK000001", NEW + ":paid:1")]
def go(created):
    _, out = plan([new_void(status="CFV Actioned")], [task("recROYTASK000012", NEW + ":paid:1", created=created)] + ask)
    return [keys(out), closes(out)]
print(json.dumps({"day13": go(date(2026, 9, 19)), "day14": go(date(2026, 9, 18))}))`);
    expect(r.day13).toEqual([[], []]);
    expect(r.day14).toEqual([[['roy', 'recLaneBTest00001:paid:2'], ['ask', 'recLaneBTest00001:paid:2']],
      [['recROYTASK000012', 'no reply, so asked again', true, false]]]);
  });

  it('a task cancelled by hand stops the clock: nothing is raised and nothing else of the tenancy\'s is touched', () => {
    const r = py(`
tasks = [task("recROYTASK000010", NEW + ":journal:1"), task("recROYTASK000011", NEW + ":costs:1", status="Cancelled")]
res, out = plan([new_void()], tasks)
_, rent = plan([new_void(status="CFV Actioned", start="2026-08-25", due=25)], tasks, tx=[paid(NEW, "2026-09-25", 900.00)])
stopped_paid = [task("recROYTASK000012", NEW + ":paid:1", created=date(2026, 9, 18)), task("recROYTASK000013", NEW + ":paid:2", status="Cancelled")]
_, later = plan([new_void(status="CFV Actioned", start="2026-08-03", due=3)], stopped_paid, tx=[paid(NEW, "2026-10-01", 900.00)])
print(json.dumps({"keys": keys(out), "close": closes(out), "note": stage(res), "short": short(res),
                  "rent": [keys(rent), closes(rent)], "paidLater": [keys(later), closes(later)]}))`);
    expect(r.keys).toEqual([]);
    expect(r.close).toEqual([]);
    expect([r.note, r.short]).toEqual(['stopped: its last task was cancelled by hand', 'stopped by hand']);
    // Stopped is stopped: rent arriving later closes and ends nothing, in either lane sort.
    expect(r.rent).toEqual([[], []]);
    expect(r.paidLater).toEqual([[], []]);
  });

  it('an older task of Roy\'s still open when a later check is live is closed as taken over; one at Approval is left to Kevin', () => {
    const r = py(`
tasks = [task("recROYTASK000010", NEW + ":journal:1", created=date(2026, 9, 1)), task("recROYTASK000009", NEW + ":journal:2", created=date(2026, 9, 2), status="Approval"),
         task("recROYTASK000011", NEW + ":costs:1"), draft("recASKTASK000001", NEW + ":costs:1")]
_, out = plan([new_void()], tasks)
print(json.dumps({"keys": keys(out), "close": closes(out)}))`);
    expect(r).toEqual({ keys: [], close: [['recROYTASK000010', 'a later check has taken over from this one', true, false]] });
  });

  it('the tenant draft: raised when it is missing, never twice, and never for an existing void', () => {
    const r = py(`
roy_task = task("recROYTASK000011", NEW + ":costs:1")
_, missing = plan([new_void()], [roy_task])
_, there = plan([new_void()], [roy_task, draft("recASKTASK000001", NEW + ":costs:1")])
renamed_draft = dict(draft("recASKTASK000001", NEW + ":costs:1", status="Completed"), name="Renamed by someone",
                     notes=lb.TRIAL_KEY_MARK + NEW + ":costs:1:ask\\n" + lb.SETUP_KEY_MARK + NEW + ":costs:1")
_, renamed = plan([new_void()], [roy_task, renamed_draft])
# Roy's create failed last run and the draft's did not: Roy's is raised again, the draft is not.
journal = task("recROYTASK000010", NEW + ":journal:1", status="Completed", created=date(2026, 9, 20), completed=date(2026, 9, 25))
_, half = plan([new_void()], [journal, draft("recASKTASK000001", NEW + ":costs:1")])
_, twin = plan([new_void()], [roy_task, draft("recASKTASK000001", NEW + ":costs:1"), draft("recASKTASK000002", NEW + ":costs:1")])
_, old_void = plan([tenancy(OLD1, 11, 900.00, status="CFV Actioned", start="2026-02-11")], [task("recROYTASK000001", OLD1 + ":paid:1")], pre=[OLD1])
print(json.dumps({"missing": keys(missing), "there": keys(there), "renamed": [keys(renamed), closes(renamed)], "half": keys(half),
                  "twin": twin["problems"], "existing": keys(old_void)}))`);
    expect(r.missing).toEqual([['ask', 'recLaneBTest00001:costs:1']]);
    expect(r.there).toEqual([]);
    // A renamed, completed tenant draft is still a tenant draft: it never reads as Roy's task.
    expect(r.renamed).toEqual([[], []]);
    expect(r.half).toEqual([['roy', 'recLaneBTest00001:costs:1']]);
    expect(r.twin).toEqual(['two tenant drafts carry the key recLaneBTest00001:costs:1']);
    expect(r.existing).toEqual([]);
  });
});

describe('lane B: the end', () => {
  it('rent reaches the bank: Roy\'s open tasks are closed, the end line goes on the newest, and an open form card is withdrawn, never closed', () => {
    const r = py(`
t = new_void(i=NEW, status="CFV Actioned", start="2026-08-25", due=25)
tasks = [task("recROYTASK000012", NEW + ":paid:1"), task("recROYTASK000010", NEW + ":journal:1", status="Completed", completed=date(2026, 9, 1)),
         task("recFORMTASK00001", NEW + ":form:1", status="Approval", name="RENT FORM: a form"),
         draft("recASKTASK000001", NEW + ":paid:1")]
res, out = plan([t], tasks, tx=[paid(NEW, "2026-09-25", 900.00)])
only_form, fo = plan([t], [tasks[2]], tx=[paid(NEW, "2026-09-25", 900.00)])
# Roy's costs task and a later form card: the end line goes on Roy's task, the card is not written to.
_, cf = plan([t], [task("recROYTASK000011", NEW + ":costs:1"), tasks[2]], tx=[paid(NEW, "2026-09-25", 900.00)])
open_form, of = plan([t], [dict(tasks[2], status="Today")], tx=[paid(NEW, "2026-09-25", 900.00)])
print(json.dumps({"lane": res["lanes"][NEW], "close": closes(out), "raise": keys(out), "formOnly": closes(fo), "formOpen": closes(of), "costsAndCard": closes(cf),
                  "withdrawn": [withdrawn(out), withdrawn(fo), withdrawn(of)]}))`);
    expect(r.costsAndCard).toEqual([['recROYTASK000011', 'rent has reached the bank, nothing more to do', true, true]]);
    // A card still in Kevin's queue for a tenancy now paying is withdrawn: there is no form to send.
    const gone = [['recFORMTASK00001', 'rent has reached the bank, nothing more to do']];
    expect(r.withdrawn).toEqual([gone, gone, gone]);
    // A form card is not Roy's step, whatever its status: never closed here.
    expect(r.formOpen).toEqual([['recFORMTASK00001', '', false, true]]);
    expect(r.lane).toBe('fine');
    expect(r.close).toEqual([['recROYTASK000012', 'rent has reached the bank, nothing more to do', true, true]]);
    expect(r.raise).toEqual([]);
    // Only a form card on record: the end line is written on it, and its status is left alone.
    expect(r.formOnly).toEqual([['recFORMTASK00001', '', false, true]]);
  });

  it('once the form is in, the first rent matched ends the clock, in full or short: Roy is never asked why none has come', () => {
    const r = py(`
# Due day 3: a payment on 1 Oct is for the 3 Oct rent, which the rent check does not judge until 5 Oct.
t = new_void(status="CFV Actioned", start="2026-08-03", due=3)
tasks = [task("recROYTASK000012", NEW + ":paid:1", created=date(2026, 9, 18)), draft("recASKTASK000001", NEW + ":paid:1")]
def go(tx):
    res, out = plan([t], tasks, tx=tx)
    return [res["lanes"][NEW], keys(out), closes(out), stage(res), short(res)]
_, b = plan([t], tasks, tx=[paid(NEW, "2026-09-17", 700.00)])
before_says = b["raise"][0]["description"]
# A form card still open is a form being done: money matched then is not the direct payment starting.
card = [task("recROYTASK000011", NEW + ":costs:1", created=date(2026, 9, 20), said=[(date(2026, 9, 25), "Yes, verified")]),
        task("recFORMTASK00001", NEW + ":form:1", status="Approval", created=date(2026, 9, 28), name="RENT FORM: a form"), draft("recASKTASK000002", NEW + ":costs:1")]
res_c, out_c = plan([new_void(start="2026-08-03", due=3)], card, tx=[paid(NEW, "2026-09-30", 100.00)])
done_card = [card[0], dict(card[1], status="Completed", completed=date(2026, 9, 29)), card[2]]
res_d, out_d = plan([new_void(start="2026-08-03", due=3)], done_card, tx=[paid(NEW, "2026-09-30", 100.00)])
# So is a clock stopped by hand at the paid step.
stopped = [task("recROYTASK000010", NEW + ":journal:1", created=date(2026, 9, 1)), task("recROYTASK000012", NEW + ":paid:1", status="Cancelled", created=date(2026, 9, 18))]
res_s, out_s = plan([t], stopped, tx=[paid(NEW, "2026-10-01", 100.00)])
print(json.dumps({"none": go([])[1], "full": go([paid(NEW, "2026-10-01", 900.00)]), "short": go([paid(NEW, "2026-10-01", 700.00)])[1:3],
                  "before": go([paid(NEW, "2026-09-17", 700.00)])[1], "beforeSays": "no rent has been matched to this tenancy since 18 Sep 2026." in before_says,
                  "openCard": [keys(out_c), closes(out_c), stage(res_c)], "doneCard": [keys(out_d), [c["end"] for c in out_d["close"]], stage(res_d)], "stopped": [keys(out_s), closes(out_s), stage(res_s)]}))`);
    // Roy's answered housing costs task is closed in the ordinary way; nothing is ended.
    expect(r.openCard).toEqual([[], [['recROYTASK000011', 'a later check has taken over from this one', true, false]], "the direct rent payment form card is in Kevin's queue"]);
    expect(r.doneCard).toEqual([[], [false], 'the form card was closed without Kevin saying he sent the form, so nothing more is raised; '
      + 'marking the tenancy CFV Actioned by hand starts the payment checks if it went in']);
    expect(r.stopped).toEqual([[], [], 'stopped: its last task was cancelled by hand']);
    // The control: with nothing matched, Roy is asked again after 14 days of silence.
    expect(r.none).toEqual([['roy', 'recLaneBTest00001:paid:2'], ['ask', 'recLaneBTest00001:paid:2']]);
    const ended = [['recROYTASK000012', 'a rent payment has been matched, so the direct payment has started', true, true]];
    expect(r.full).toEqual(['late', [], ended, 'a rent payment has been matched since the form went in: the direct payment has started', 'first rent matched']);
    // A short payment ends it too: the shortfall is not this lane's, and Roy is not asked every 14 days for ever.
    expect(r.short).toEqual([[], ended]);
    // Money matched before the first check was raised does not end the clock, and the next check
    // says exactly that much: "none since 18 Sep", the date the rule itself counts from.
    expect(r.before).toEqual([['roy', 'recLaneBTest00001:paid:2'], ['ask', 'recLaneBTest00001:paid:2']]);
    expect(r.beforeSays).toBe(true);
  });

  it('before the form, a full rent matched but not yet judged raises nothing; the hold is 9 days and counts money since the last task', () => {
    const r = py(`
costs = [task("recROYTASK000011", NEW + ":costs:1", created=date(2026, 9, 20)), draft("recASKTASK000002", NEW + ":costs:1")]
t = new_void(start="2026-08-03", due=3)
res, held = plan([t], costs, tx=[paid(NEW, "2026-10-01", 900.00)])
_, part = plan([t], costs, tx=[paid(NEW, "2026-10-01", 400.00)])
# An unreadable reply is asked again at once, the day after the task was raised: money matched a
# few days BEFORE the task still counts (a payment up to 5 days early is for the coming rent).
fresh = [task("recROYTASK000011", NEW + ":costs:1", created=date(2026, 10, 1), said=[(DAY, "Done")]), draft("recASKTASK000002", NEW + ":costs:1")]
_, early = plan([t], fresh, tx=[paid(NEW, "2026-09-29", 900.00)])
_, no_money = plan([t], fresh)
pay = lambda d, a: [{"day": d, "amount": a}]
window = [lb.landed(pay(DAY - timedelta(days=9), 900.00), DAY - timedelta(days=30), 900.00, DAY),
          lb.landed(pay(DAY - timedelta(days=10), 900.00), DAY - timedelta(days=30), 900.00, DAY),
          lb.landed(pay(DAY - timedelta(days=3), 900.00), DAY - timedelta(days=2), 900.00, DAY),
          lb.landed(pay(DAY - timedelta(days=3), 899.50), DAY - timedelta(days=30), 900.00, DAY)]
print(json.dumps({"held": [res["lanes"][NEW], keys(held), closes(held), stage(res), short(res)], "part": keys(part),
                  "early": [keys(early), keys(no_money)],
                  "anchor": [lb.landed(pay(date(2026, 9, 15), 900.00), date(2026, 9, 20) - timedelta(days=lb.EARLY_PAY_DAYS), 900.00, date(2026, 9, 22)),
                             lb.landed(pay(date(2026, 9, 14), 900.00), date(2026, 9, 20) - timedelta(days=lb.EARLY_PAY_DAYS), 900.00, date(2026, 9, 22)),
                             lb.EARLY_PAY_DAYS == rc.EARLY_PAY_DAYS, lb.SHORT_SLACK == rc.SHORT_SLACK, lb.WAITING_SHARE == rc.WAITING_SHARE],
                  "window": window}))`);
    expect(r.held).toEqual(['late', [], [], 'a full rent payment is matched, waiting for the rent check to judge it', 'rent matched, being checked']);
    // A part payment is not the rent: the silent check is asked again as usual.
    expect(r.part).toEqual(ROY2);
    // The hold lasts 9 days (time enough to be judged), counts money from 5 days before the last
    // task was raised and no earlier, and allows the same pound of slack the rent check does.
    expect(r.window).toEqual([true, false, false, true]);
    expect(r.anchor).toEqual([true, false, true, true, true]);
    expect(r.early).toEqual([[], ROY2]);
  });

  it('a paid check is not raised while the bank data cannot say that no rent has come: unmatched money, or a stale feed', () => {
    const r = py(`
t = new_void(status="CFV Actioned", start="2026-08-03", due=3)
tasks = [task("recROYTASK000012", NEW + ":paid:1", created=date(2026, 9, 18)), draft("recASKTASK000001", NEW + ":paid:1")]
def go(**kw):
    res, out = plan([t], tasks, **kw)
    return [keys(out), closes(out), short(res)]
costs = [task("recROYTASK000011", NEW + ":costs:1", created=date(2026, 9, 20)), draft("recASKTASK000002", NEW + ":costs:1")]
_, c = plan([new_void()], costs, unmatched=[waiting("2026-10-01", 900.00)])
res, _ = plan([t], tasks, unmatched=[waiting("2026-10-01", 900.00)])
print(json.dumps({"unmatched": go(unmatched=[waiting("2026-10-01", 900.00)]), "stale": go(feed="2026-09-27T11:00:00.000Z"),
                  "small": go(unmatched=[waiting("2026-10-01", 50.00)])[0], "old": go(unmatched=[waiting("2026-09-10", 900.00)])[0],
                  "costsStep": keys(c), "note": stage(res)}))`);
    expect(r.unmatched).toEqual([[], [], 'waiting on bank data']);
    expect(r.stale).toEqual([[], [], 'waiting on bank data']);
    expect(r.note).toContain('the next check waits until the bank data is matched and fresh');
    // Nothing was raised, so the row never says Roy was asked again.
    expect(r.note).not.toContain('asked again');
    // A few stray pounds, or money from before the last task was raised, is not this rent.
    expect(r.small).toEqual([['roy', 'recLaneBTest00001:paid:2'], ['ask', 'recLaneBTest00001:paid:2']]);
    expect(r.old).toEqual([['roy', 'recLaneBTest00001:paid:2'], ['ask', 'recLaneBTest00001:paid:2']]);
    // Only the question that says "no rent yet" waits on the bank: the housing costs question is asked as usual.
    expect(r.costsStep).toEqual(ROY2);
  });

  it('marked In Payment with no rent matched is not the end: nothing is closed and it is said', () => {
    const r = py(`
t = new_void(status="In Payment", start="2026-09-29", due=25)      # first rent not due until 25 Oct
res, out = plan([t], [task("recROYTASK000010", NEW + ":journal:1")])
print(json.dumps({"lane": res["lanes"][NEW], "close": closes(out), "raise": keys(out), "problems": out["problems"]}))`);
    expect(r.lane).toBe('fine');
    expect([r.close, r.raise]).toEqual([[], []]);
    expect(r.problems).toEqual(['1 open task carries a key for recLaneBTest00001, which reads as paying with no rent matched to it yet; left as they are']);
  });

  it('once ended, the tenancy is never lane B\'s again: a later late payment raises nothing here', () => {
    const r = py(`
ended = "RENT SETUP ENDED: rent reached the bank, seen 2 Sep 2026."
tasks = [task("recROYTASK000010", NEW + ":journal:1", status="Completed", created=date(2026, 7, 1), completed=date(2026, 8, 1),
              extra="[01 Aug 2026 — rent-check] Closed: rent has reached the bank, nothing more to do."),
         task("recROYTASK000012", NEW + ":paid:1", status="Completed", created=date(2026, 7, 20), completed=date(2026, 8, 1), extra=ended)]
out = {}
for status in ("CFV Actioned", "CFV", "In Payment"):
    t = new_void(status=status, start="2026-06-25", due=25)
    res, o = plan([t], tasks, tx=[paid(NEW, "2026-08-25", 900.00)])
    out[status] = [res["lanes"][NEW], keys(o), closes(o), o["rows"]]
# The same tasks WITHOUT the end line, tenancy back In Payment and late: lane A's, nothing here.
bare = [dict(x, notes=x["notes"].replace(ended, "")) for x in tasks]
res, o = plan([new_void(status="In Payment", start="2026-06-25", due=25)], bare, tx=[paid(NEW, "2026-08-25", 900.00)])
out["inPaymentNoEnd"] = [res["lanes"][NEW], keys(o), closes(o)]
# And still a void with no end line: a task this file closed with no answer on it is never read as Roy's "done".
res, o = plan([new_void(status="CFV", start="2026-06-25", due=25)], [bare[0]], tx=[paid(NEW, "2026-08-25", 900.00)])
out["ruleClosedJournal"] = stage(res)
print(json.dumps(out))`);
    expect(r['CFV Actioned']).toEqual(['late', [], [], {}]);
    expect(r.CFV).toEqual(['late', [], [], {}]);
    expect(r['In Payment']).toEqual(['late', [], [], {}]);
    expect(r.inPaymentNoEnd).toEqual(['late', [], []]);
    expect(r.ruleClosedJournal).toContain('no word from Roy that the documents are on the journal');
  });

  it('cannot tell closes nothing; a key for a tenancy that is not live, or that the task is not linked to, is said and never acted on', () => {
    const r = py(`
gap = new_void(); gap["fields"][TY["dueDay"]] = None
res, out = plan([gap], [task("recROYTASK000012", NEW + ":costs:1")], tx=[paid(NEW, "2026-09-25", 900.00)])
payer = [tenancy(PAYER, 2, 500, start="2022-02-16")]; ptx = [paid(PAYER, "2026-09-02", 500)]
gone, gout = plan(payer, [task("recROYTASK000013", NEW + ":costs:1")], tx=ptx)
future, fout = plan([new_void(start="2026-11-01")], [task("recROYTASK000013", NEW + ":journal:1")])
twins, tout = plan([new_void()], [task("recROYTASK000021", NEW + ":journal:1"), task("recROYTASK000020", NEW + ":journal:1")])
pair = [task("recROYTASK000021", NEW + ":journal:1", status="Completed", completed=DAY), task("recROYTASK000020", NEW + ":journal:1")]
order = [stage(plan([new_void()], pair)[0]), stage(plan([new_void()], pair[::-1])[0])]
# A hand-added key naming another, paying tenancy: without the link check Roy's task would be closed as "rent has reached the bank".
wrong, wout = plan(payer + [new_void()], [task("recROYTASK000014", PAYER + ":paid:1", tenancies=[NEW])], tx=ptx)
linked, lout = plan(payer, [task("recROYTASK000014", PAYER + ":paid:1")], tx=ptx)
_, q1 = plan(payer, [task("recROYTASK000013", NEW + ":costs:1", status="Completed", completed=date(2026, 9, 1))], tx=ptx)
_, q2 = plan(payer + [new_void()], [task("recROYTASK000014", PAYER + ":paid:1", tenancies=[NEW], status="Completed", completed=date(2026, 9, 1)),
                                    task("recROYTASK000010", NEW + ":journal:1")], tx=ptx)
_, hand = plan([new_void(status="In Payment", start="2026-06-25", due=25)], [task("recROYTASK000012", NEW + ":paid:1")], tx=[paid(NEW, "2026-08-25", 900.00)])
print(json.dumps({"quiet": [q1["problems"], q2["problems"]], "byHand": [keys(hand), closes(hand), hand["problems"]],"lane": res["lanes"][NEW], "close": out["close"], "raise": keys(out), "gone": [gout["close"], gout["problems"]],
                  "future": [fout["close"], fout["problems"]], "twins": [tout["problems"], keys(tout)], "order": order,
                  "wrong": [closes(wout), wout["problems"]], "linked": closes(lout)}))`);
    expect(r.lane).toBe('unknown');
    expect([r.close, r.raise]).toEqual([[], []]);
    expect(r.gone).toEqual([[], ['1 open task carries a key for recLaneBTest00001, which is not a live tenancy today; left as they are']]);
    expect(r.future).toEqual([[], ['1 open task carries a key for recLaneBTest00001, which is not a live tenancy today; left as they are']]);
    // Finished tasks of a tenancy that has gone, and a finished task with a stray key, are not news every run.
    expect(r.quiet).toEqual([[], []]);
    // Open tasks of a tenancy somebody set to In Payment by hand, now late: said, and left to lane A.
    expect(r.byHand).toEqual([[], [], ['1 open task carries a key for recLaneBTest00001, which is no longer marked a cash flow void; left as they are']]);
    expect(r.twins).toEqual([['two tasks carry the key recLaneBTest00001:journal:1'], []]);
    // Two tasks with one key are read the same way round whatever order Airtable returns them in.
    expect(r.order[0]).toBe(r.order[1]);
    expect(r.order[0]).toContain('documents on the Universal Credit journal 2 Oct');
    expect(r.wrong).toEqual([[], ['task recROYTASK000014 carries a key for a tenancy it is not linked to, so it is ignored']]);
    // The control: the same key on a task that IS linked to that tenancy does end it.
    expect(r.linked).toEqual([['recROYTASK000014', 'rent has reached the bank, nothing more to do', true, true]]);
  });
});

describe('lane B: reading Roy\'s reply', () => {
  it('the first word decides; "done" and "confirmed" are not a yes to the housing costs; a promise is not done; a mix is unclear', () => {
    const r = py(`
cases = [("Yes", "costs"), ("yes, verified this morning", "costs"), ("Yes, verified. Shall I do the form?", "costs"), ("Verified", "costs"),
         ("Approved this morning", "costs"), ("Yes, verified, nothing outstanding", "costs"), ("Not a problem, verified today", "costs"),
         ("Done", "journal"), ("Done. Anything else you need?", "journal"), ("Roy confirmed: done, all uploaded", "journal"),
         ("No problem, all uploaded", "journal"), ("All good, finished yesterday", "journal"), ("Completed", "journal"),
         ("No", "costs"), ("No, they said it is still being processed", "costs"), ("Not yet verified", "costs"), ("Housing costs not verified yet", "costs"),
         ("It hasn\\u2019t been verified", "costs"), ("Done, they said it is not verified yet", "costs"), ("The claim is pending", "costs"), ("Can't get hold of him", "journal"),
         ("Will do", "journal"),
         ("Done", "costs"), ("Uploaded today", "costs"), ("Is it?", "costs"), ("", "costs"), ("I think so", "costs"), ("Spoke to them today", "costs"),
         ("Rang UC, they confirmed it is with a decision maker", "costs"), ("UC confirmed they need the tenancy agreement uploading again", "costs"), ("Confirmed", "costs"),
         ("Done, but not uploaded the agreement yet", "journal"), ("I'll get it done tomorrow", "journal"), ("To be done this week", "journal"), ("No problem", "journal"),
         ("Verified?", "costs"), ("Yes?", "costs"), ("Done?", "journal"), ("Not sure", "costs"), ("No idea", "costs"),
         ("Yes, I rang them and it is still pending", "costs"), ("Yes will do", "journal"),
         ("Yes, spoke to UC. Not verified yet.", "costs"), ("Yes. It's not verified yet", "costs"), ("Yes I called. They said no.", "costs"),
         ("Done. Couldn't upload the agreement though", "journal"),
         # On the housing costs step a yes must be said first: the word alone, hedged or about something else, is not one.
         ("Done, verified", "costs"), ("They have verified the housing costs", "costs"), ("Should be verified by Friday", "costs"),
         ("UC said it would be verified in 5 days", "costs"), ("Hoping to get it verified Monday", "costs"), ("Need the tenant to get them verified", "costs"),
         ("They have verified the rent but the housing element is still under review", "costs"),
         ("Roy says UC told him the housing costs should be verified by Friday", "costs"), ("Verified by Friday hopefully", "costs"),
         ("Should be done by Friday", "journal"), ("Uploaded the agreement, still need the proof of residency", "journal"),
         ("Yes spoke to them, awaiting verification", "costs"), ("Yes, but it is under review", "costs"), ("Yes, though on hold", "costs"),
         # A "yes" that reports contact or a timeline, not verification, does not answer the question.
         ("Yes contacted them, they said 5-7 working days", "costs"), ("Yes, it's with a decision maker", "costs"),
         ("Yes, they're processing it", "costs"), ("Yes spoke to UC this morning", "costs"), ("Yes, asked them", "costs"),
         # A yes that hedges is not one.
         ("Yes, maybe verified", "costs"), ("Yes, possibly verified", "costs"), ("Yes, unsure if verified", "costs"), ("Yes I think it's verified", "costs"),
         ("Yes, it is being verified", "costs"), ("Yes, almost verified", "costs"), ("Verified I think", "costs"), ("Approved maybe", "costs"),
         ("Yes, being uploaded today", "journal")]
more = [lb.reading("Yes, verified. I will do the form tomorrow", "costs"), lb.reading("Done. Will send the screenshot later", "journal"),
        lb.reading("Yes thanks", "costs"), lb.reading("Yes, they are", "costs"), lb.reading("Yes, spoke to them and it is verified", "costs"),
        lb.reading("Yes, they confirmed it", "costs")]
print(json.dumps([lb.reading(w, s) for w, s in cases] + more))`);
    // A question is not an answer, "not sure" is not a no, and a yes that takes itself back in the
    // same sentence is not a yes. What a later sentence says does not undo the first.
    expect(r).toEqual([...Array(13).fill('yes'), ...Array(9).fill('no'), ...Array(52).fill('unclear'), 'yes', 'yes', 'yes', 'yes', 'yes', 'unclear']);
  });

  it('reads both shapes his answers arrive in, his assistant\'s and his own page\'s, both on London time', () => {
    const r = py(`
ra = load_mod("ra", "roy-assistant.py")
notes = "\\n".join([
    "RENT SETUP KEY: " + NEW + ":costs:1", "",
    "[25 Sep 2026 14:00 %s%s] No, not yet" % (ra.ROY_TASK_NOTE_TAG, "recREQ00000000001"), "they said next week", "",
    "[26 Sep 2026 — agent-dispatch] Handed over to Roy Lavin (x): reason",
    "[2026-10-01 09:15 Roy Lavin] Yes verified",
    "RENT SETUP KEY: " + NEW + ":paid:1"])
lines = [[w.isoformat(), words] for w, words in lb.roy_lines(notes)]
t = dict(task("recROYTASK000011", NEW + ":costs:1"), notes=notes)
said, on = lb.answered([t], "costs")
print(json.dumps({"lines": lines, "said": said, "on": on.isoformat(), "none": list(lb.answered([task("recX", NEW + ":costs:1")], "costs"))}))`);
    expect(r.lines).toEqual([['2026-09-25T14:00:00+01:00', 'No, not yet\nthey said next week'], ['2026-10-01T09:15:00+01:00', 'Yes verified']]);
    expect([r.said, r.on]).toEqual(['yes', '2026-10-01']);
    expect(r.none).toEqual([null, null]);
  });
});

describe('lane B: the tasks pass the estate\'s own gates', () => {
  it('Roy\'s tasks are not trial tasks and trip no private-matter filter; the tenant draft is a trial task by either mark and never Roy\'s lane', () => {
    const r = py(`
from agent_email_format import trial_problem
ad = load_mod("ad", "agent-dispatch.py")
unit = "Garden Flat – 1 Example Road"   # a unit name that reads like a repair on its own
_, j = plan([new_void(unit=unit)], [])
_, c = plan([new_void(unit=unit)], [task("recROYTASK000010", NEW + ":journal:1", created=date(2026, 9, 20), said=[(date(2026, 9, 25), "done")])])
_, p = plan([new_void(status="CFV Actioned", unit=unit)], [task("recROYTASK000012", NEW + ":paid:1", created=date(2026, 9, 18)), draft("recASKTASK000009", NEW + ":paid:1")])
_, f = plan([new_void(status="CFV Actioned", unit=unit)], [])
roys = [j["raise"][0], c["raise"][0], p["raise"][0], f["raise"][0]]
asks = [c["raise"][1], p["raise"][1]]
long_unit = "Unit 12 – The Old Example Coach House Annexe, 104 Example Road West"
_, l = plan([new_void(unit=long_unit)], [task("recROYTASK000011", NEW + ":costs:11", created=date(2026, 9, 20), said=[(date(2026, 9, 25), "No")])] + [draft("recASKTASK000001", NEW + ":costs:11")])
print(json.dumps({
    "royTrial": [trial_problem([], t["name"], t["notes"] + t["description"]) for t in roys],
    "royTier1": [ad.tier_match(ad.TIER1_PATTERNS, t["name"], t["description"], t["notes"]) for t in roys],
    "royNamed": [("Sam Sample" in t["name"], "Sam Sample" in t["label"], "Sam Sample" in t["description"]) for t in roys],
    "askTrialByName": [bool(trial_problem([], t["name"], "")) for t in asks],
    "askTrialByNotes": [bool(trial_problem([], "renamed", t["notes"])) for t in asks],
    "nameAloneIsRoys": bool(ad.roy_match(asks[0]["name"], "", "")),
    "askLanes": [[bool(ad.roy_match(t["name"], t["description"], t["notes"])), bool(ad.property_match(t["name"], t["description"], t["notes"])),
                  bool(ad.creditor_match(t["name"], t["description"], t["notes"])), ad.tier_match(ad.TIER1_PATTERNS, t["name"], t["description"], t["notes"])] for t in asks],
    "askKeyed": [lb.task_keys(t["notes"]) for t in asks],
    "subject": ["check 12" in ("Assistant: a task is yours - " + l["raise"][0]["name"])[:150], l["raise"][0]["name"].index("check 12") < l["raise"][0]["name"].index("Unit 12")],
    "ids": [lb.COMPLETION_FIELD == ad.AF["completion"], ad.ROY_EMAIL in ad.HUMANS, lb.TRIAL_KEY_MARK == rc.KEY_MARK,
            [lb.CFV, lb.CFV_ACTIONED] == [rc.CFV, rc.CFV_ACTIONED]]}))`);
    expect(r.royTrial).toEqual(['', '', '', '']);
    expect(r.royTier1).toEqual(['', '', '', '']);
    // The tenant's name is in the words Roy reads, never in the task's name or in what a run reports.
    expect(r.royNamed).toEqual(Array(4).fill([false, false, true]));
    expect(r.askTrialByName).toEqual([true, true]);
    expect(r.askTrialByNotes).toEqual([true, true]);
    // The control: this unit name alone would send the task to Roy. Its description keeps it out.
    expect(r.nameAloneIsRoys).toBe(true);
    expect(r.askLanes).toEqual([[false, false, false, ''], [false, false, false, '']]);
    expect(r.askKeyed).toEqual([[['recLaneBTest00001', 'costs', 1]], [['recLaneBTest00001', 'paid', 2]]]);
    // The check number comes before the unit, so the email subject's 150-character cut never loses it.
    expect(r.subject).toEqual([true, true]);
    expect(r.ids).toEqual([true, true, true, true]);
  });

  it('a tenancy with no unit linked is shown under the surname by the rent check: the surname never reaches a task name or a report', () => {
    const r = py(`
t = new_void()
t["fields"][TY["unitRef"]] = None
t["fields"][TY["surname"]] = "Sample"
res, out = plan([t], [task("recROYTASK000010", NEW + ":journal:1", created=date(2026, 9, 20), said=[(date(2026, 9, 25), "done")])])
b = new_void(tenant="recT_blank"); b["fields"][TY["unitRef"]] = None; b["fields"][TY["surname"]] = "Sample"
_, bout = plan([b], [])
print(json.dumps({"unit": res["tenancies"][0]["unit"], "names": [x["name"] for x in out["raise"]], "labels": [x["label"] for x in out["raise"]],
                  "told": ["Sam Sample" in out["raise"][0]["description"], "(no unit linked)" in out["raise"][0]["description"] + out["raise"][1]["description"]],
                  "problem": bout["problems"]}))`);
    expect(r.problem).toEqual(['a tenancy with no unit linked is a new cash flow void whose tenant has no rent payment type, so its clock cannot start']);
    expect(r.unit).toBe('Sample (no unit linked)');
    expect(r.names).toEqual(['NEW TENANT RENT: housing costs check: a tenancy with no unit linked', 'RENT ASK: costs check 1: a tenancy with no unit linked']);
    expect(r.labels).toEqual(['Roy, costs check 1: a tenancy with no unit linked', 'tenant draft, costs check 1: a tenancy with no unit linked']);
    // Roy still reads who it is, in the words of the task, and never the stand-in.
    expect(r.told).toEqual([true, false]);
  });
});

describe('lane B: the Home line', () => {
  it('stays inside the 700 characters Home prints, with the bank data time, however many new tenants there are', () => {
    const r = py(`
units = ["Unit %d – %d Example Road, Exampleton" % (i, 100 + i) for i in range(9)]
ts = [new_void(i=rid(10 + i), unit=units[i]) for i in range(5)]
ts += [tenancy(rid(20 + i), 11, 900.00, status="CFV Actioned", start="2026-02-11", unit=units[5 + i]) for i in range(2)]
ts += [tenancy(rid(30), 30, 1200.00, unit=units[7]), new_void(i=rid(31), start="2026-08-25", unit=units[8])]
tx = [paid(rid(30), "2026-08-29", 1200.00), paid(rid(31), "2026-08-26", 100.00)]
tasks = [task("recROYTASK%06d" % i, rid(10 + i) + ":costs:1") for i in range(5)] + [draft("recASKTASK%06d" % i, rid(10 + i) + ":costs:1") for i in range(5)]
tasks += [task("recROYTASK%06d" % (20 + i), rid(20 + i) + ":paid:1") for i in range(2)] + [task("recROYTASK000031", rid(31) + ":journal:1")]
res, out = plan(ts, tasks, tx=tx, pre=[rid(20), rid(21)])
line = res["briefLine"]
print(json.dumps({"len": len(line), "line": line}))`);
    expect(r.len).toBeLessThanOrEqual(700);
    expect(r.line).toContain('Bank data as at 2 Oct 12:03.');
    expect(r.line).toContain('(waiting on Roy)');
    expect(r.line).toContain('Existing cash flow voids, left alone: Unit 5 – 105 Example Road, Exampleton (form sent, awaiting rent)');
    // A new tenant who is late shows the days and the stage.
    expect(r.line).toContain('Unit 8 – 108 Example Road, Exampleton (7 days, waiting on Roy)');
  });

  it('a tenancy whose clock has ended, late again and still marked actioned: Home says nobody is chasing it', () => {
    const r = py(`
ended = task("recROYTASK000012", NEW + ":paid:1", status="Completed", created=date(2026, 7, 20), completed=date(2026, 8, 1),
             extra="RENT SETUP ENDED: rent reached the bank, seen 2 Sep 2026.")
t = new_void(status="CFV Actioned", start="2026-06-25", due=25)
res, out = plan([t], [ended], tx=[paid(NEW, "2026-08-25", 900.00)])
data, res2 = assess([t], [paid(NEW, "2026-08-25", 900.00)])
print(json.dumps({"line": res["briefLine"], "laneA": rc.task_plan(res2, data["tenancies"], {}, DAY), "laneB": keys(out)}))`);
    expect(r.line).toContain('Late: Unit 9 – 1 Example Road (7 days, marked actioned so not chased).');
    // The known limit, pinned: neither lane raises anything until the tenancy is marked In Payment.
    expect([r.laneA, r.laneB]).toEqual([[], []]);
  });
});

describe('lane B: reads and writes', () => {
  const FAKE = `
posts, patches, mailed = [], [], []
STORE = {}
FAIL_POST = set()
def api(method, path, payload=None, params=None):
    if method == "POST":
        f = payload["records"][0]["fields"]
        if any(x in f[TK["name"]] for x in FAIL_POST): raise RuntimeError("Airtable POST tasks 422: nope")
        posts.append(f); return {"records": [{"id": "recNEWTASK%06d" % len(posts)}]}
    if method == "PATCH":
        patches.append(payload["records"][0]); return {}
    wanted = re.search(r"RECORD_ID\\(\\)='(rec\\w+)'", params["filterByFormula"]).group(1)
    return {"records": [{"id": wanted, "fields": STORE[wanted]}] if wanted in STORE else []}
rc.api = api
class FakeAd:
    ROY_EMAIL = "roy@example.test"
    HUMANS = {"roy@example.test": {"rec": "recROYROW0000001", "name": "Roy Example"}}
    AF = {"assignee": "fldASSIGNEE000001"}
    HANDOVER_DIR = tempfile.mkdtemp()
lb.module = lambda key: FakeAd
MAIL = {}
def notify(task_id, to):
    said = MAIL.get(task_id, "ok")
    if said == "fail": raise RuntimeError("worker 500")
    mailed.append([task_id, to])
    return {"notified": task_id} if said == "ok" else {"skipped": task_id, "event": said}
lb.notify_roy = notify
lb.read_names = lambda _rc, ids: NAMES
def run_lane_b(tenancies, tasks, writes=True, on=True, tx=(), **kw):
    data, res = assess(tenancies, tx, **kw)
    lb.read_tasks = lambda _rc: tasks
    return res, lb.lane_b(rc._Here(), res, data, DAY, writes, on)
JOURNAL_DONE = task("recROYTASK000010", NEW + ":journal:1", status="Completed", created=date(2026, 9, 20), completed=date(2026, 9, 25))
`;

  it('a real run creates Roy\'s task already his and emails it, and gives the tenant draft to the trial agent', () => {
    const r = py(FAKE + `
res, out = run_lane_b([new_void()], [JOURNAL_DONE])
print(json.dumps({"out": out, "owners": [p.get(TK["teamMember"]) for p in posts], "assignee": [p.get("fldASSIGNEE000001") for p in posts],
                  "status": [p[TK["status"]] for p in posts], "due": [p[TK["due"]] for p in posts], "links": [p[TK["tenancies"]] for p in posts],
                  "mailed": mailed, "patches": patches, "line": lb.lane_b_line(out)}))`);
    expect(r.out.failed).toBe('');
    expect(r.out.raised).toEqual(['Roy, costs check 1: Unit 9 – 1 Example Road', 'tenant draft, costs check 1: Unit 9 – 1 Example Road']);
    expect(r.owners).toEqual([['recROYROW0000001'], ['rec7aHLK1Q8fMLRXH']]);
    expect(r.assignee).toEqual([{ email: 'roy@example.test' }, null]);
    expect(r.status).toEqual(['Today', 'Today']);
    expect(r.due).toEqual(['2026-10-02', '2026-10-02']);
    expect(r.links).toEqual([['recLaneBTest00001'], ['recLaneBTest00001']]);
    expect(r.mailed).toEqual([['recNEWTASK000001', 'roy@example.test']]);
    expect(r.patches).toEqual([]);
    expect(r.line).toBe('New-tenant tasks raised: Roy, costs check 1: Unit 9 – 1 Example Road; tenant draft, costs check 1: Unit 9 – 1 Example Road.');
  });

  it('an email that fails leaves the task Roy\'s and turns the run red; the next run offers it again; a cut-off send is said, not hidden', () => {
    const r = py(FAKE + `
MAIL["recNEWTASK000001"] = "fail"
res, out = run_lane_b([new_void()], [])
first = {"failed": out["failed"], "raised": out["raised"], "posts": len(posts), "patches": patches, "owner": posts[0][TK["teamMember"]]}
made = task("recNEWTASK000001", NEW + ":journal:1", name=posts[0][TK["name"]])
MAIL["recNEWTASK000001"] = "ok"
res, out2 = run_lane_b([new_void()], [made])
sent = [list(mailed), out2["failed"], out2["problems"], len(posts)]
MAIL["recNEWTASK000001"] = "uncertain"
res, out3 = run_lane_b([new_void()], [made])
MAIL["recNEWTASK000001"] = "sent"
res, out4 = run_lane_b([new_void()], [made])
print(json.dumps({"first": first, "second": sent, "cutOff": [out3["failed"], out3["problems"], lb.lane_b_line(out3)], "alreadySent": out4["problems"],
                  "line": lb.lane_b_line(out)}))`);
    expect(r.first.failed).toContain('Roy, journal check 1: Unit 9 – 1 Example Road was created (recNEWTASK000001) but its email to Roy failed; the next run offers it again: worker 500');
    expect(r.first.raised).toEqual([]);
    // Nothing is cancelled or rewritten: the task exists, is Roy's, and keeps its key.
    expect(r.first.patches).toEqual([]);
    expect(r.first.owner).toEqual(['recROYROW0000001']);
    // The next run raises no twin and offers the open task to notify again.
    expect(r.second).toEqual([[['recNEWTASK000001', 'roy@example.test']], '', [], 1]);
    // A send that was cut off part way is never repeated, and the row says so every run.
    expect(r.cutOff[0]).toBe('');
    expect(r.cutOff[1]).toEqual(['the email of task recNEWTASK000001 to Roy was cut off part way and may not have gone; it is not sent twice, and the question is asked again as a new task if he does not reply']);
    expect(r.cutOff[2]).toContain('New-tenant tasks: none needed today. Check: the email of task recNEWTASK000001');
    expect(r.alreadySent).toEqual([]);
    expect(r.line).toContain('New-tenant tasks FAILED:');
  });

  it('open tasks are offered to notify only for a tenancy still on the clock: never an ended one or one on the do-not-chase list', () => {
    const r = py(FAKE + `
def offered(tenancies, tasks, tx=(), **kw):
    del mailed[:]
    data, res = assess(tenancies, tx, **kw)
    lb.read_tasks = lambda _rc: tasks
    lb.lane_b(rc._Here(), res, data, DAY, True, True)
    return [m[0] for m in mailed]
live = task("recROYTASK000010", NEW + ":costs:1", name="NEW TENANT RENT: housing costs check: Unit 9 – 1 Example Road")
hand = task("recROYTASK000019", NEW + ":journal:1", name="Raised by hand, already emailed by its own handover", status="Completed", created=date(2026, 9, 20), completed=date(2026, 9, 25))
ended = dict(live, notes=live["notes"] + "\\nRENT SETUP ENDED: rent reached the bank, seen 1 Sep 2026.")
# A tenancy whose clock ends in this run: its open paid task is closed, not emailed first.
act = new_void(status="CFV Actioned", start="2026-08-03", due=3)
pd = task("recROYTASK000012", NEW + ":paid:2", created=date(2026, 9, 18), name="NEW TENANT RENT: direct rent check 2: Unit 9 – 1 Example Road")
STORE["recROYTASK000012"] = {TK["notes"]: pd["notes"], TK["status"]: "Today"}
ending = offered([act], [pd], tx=[paid(NEW, "2026-10-01", 900.00)])
ending_patched = [p["id"] for p in patches]
# And a task this run closes because Roy answered it is not offered either.
ans = task("recROYTASK000010", NEW + ":journal:1", created=date(2026, 9, 28), said=[(date(2026, 9, 29), "done")], name="NEW TENANT RENT: journal upload: Unit 9 – 1 Example Road")
STORE["recROYTASK000010"] = {TK["notes"]: ans["notes"], TK["status"]: "Today"}
closing = offered([new_void()], [ans])
older = task("recROYTASK000020", NEW + ":journal:1", created=date(2026, 9, 1), name="NEW TENANT RENT: journal upload: Unit 9 – 1 Example Road")
stopped = offered([new_void()], [older, task("recROYTASK000021", NEW + ":costs:1", status="Cancelled")])
print(json.dumps({"ending": [ending, ending_patched], "closing": closing, "stopped": stopped, "active": offered([new_void()], [live, hand]),
                  "noChase": offered([new_void(tenant="recT_quietuc")], [live], noChase=["recT_quietuc"]),
                  "ended": offered([new_void()], [ended]),
                  "gone": offered([tenancy(PAYER, 2, 500, start="2022-02-16")], [live], tx=[paid(PAYER, "2026-09-02", 500)])}))`);
    expect(r.ending).toEqual([[], ['recROYTASK000012']]);
    expect(r.closing).toEqual([]);
    expect(r.stopped).toEqual([]);
    expect([r.active, r.noChase, r.ended, r.gone]).toEqual([['recROYTASK000010'], [], [], []]);
  });

  it('a real run reads the bank itself: a paid check waits while money that could be the rent is unmatched', () => {
    const r = py(FAKE + `
t = new_void(status="CFV Actioned", start="2026-08-03", due=3)
tasks = [task("recROYTASK000012", NEW + ":paid:1", created=date(2026, 9, 18), name="Raised by hand"), draft("recASKTASK000001", NEW + ":paid:1")]
STORE["recROYTASK000012"] = {TK["notes"]: tasks[0]["notes"], TK["status"]: "Today"}
res, held = run_lane_b([t], tasks, unmatched=[waiting("2026-10-01", 900.00)])
res2, free = run_lane_b([t], tasks)
print(json.dumps({"held": [held["raised"], held["closed"], held["failed"]], "free": free["raised"]}))`);
    expect(r.held).toEqual([[], [], '']);
    expect(r.free).toEqual(['Roy, paid check 2: Unit 9 – 1 Example Road', 'tenant draft, paid check 2: Unit 9 – 1 Example Road']);
  });

  it('a form card is withdrawn before the next is raised; one that cannot be withdrawn raises nothing beside it; a finished card\'s plan is removed', () => {
    const r = py(FAKE + `
calls = []
FAIL_WITHDRAW = []
def withdraw(_rc, item, day):
    calls.append("withdraw " + item["id"])
    if FAIL_WITHDRAW: raise RuntimeError("Airtable PATCH 503")
    return True
def raise_form(_rc, item, day):
    calls.append("raise " + item["key"] + (" prior" if item.get("prior") else ""))
    return "recNEWCARD000001"
lb.withdraw_form = withdraw; lb.raise_form = raise_form
costs = task("recROYTASK000011", NEW + ":costs:1", status="Completed", created=date(2026, 9, 20), said=[(date(2026, 9, 25), "Yes, verified")])
card = dict(task("recFORMTASK00001", NEW + ":form:1", created=date(2026, 9, 28), name="RENT FORM: a form"), outcome="Changes requested", feedback="Wrong rent")
done = dict(task("recFORMTASK00009", NEW + ":form:0", status="Completed", created=date(2026, 9, 26), name="RENT FORM: an old form"), outcome="Rejected")
for tid in ("recFORMTASK00001", "recFORMTASK00009"):
    open(os.path.join(FakeAd.HANDOVER_DIR, tid + ".json"), "w").write("{}")
cleared = []
lb.clear_wall = lambda _rc, tid, day, why=None: cleared.append([tid, bool(why and lb.UNRECORDED in why)]) or True
# The rejected card's window was used and no answer was recorded: he may have sent it.
lb.ROBOT_LOG = os.path.join(SCRATCH, "runs.jsonl")
open(lb.ROBOT_LOG, "w").write(json.dumps({"cmd": "handover-open", "task": "recFORMTASK00009", "at": "2026-09-27T09:00:00Z"}) + "\\n"
                             + json.dumps({"cmd": "handover", "task": "recFORMTASK00009", "at": "2026-09-27T10:00:00Z"}) + "\\n")
OPEN = "[02 Oct 2026 10:00 — agent-dispatch] BLOCKER OPEN (KEVIN credential): type the code Fix: f [since 2026-10-02T09:00:00.000Z]"
done = dict(done, notes=done["notes"] + "\\n\\n" + OPEN)
res, out = run_lane_b([new_void()], [costs, done, card])
first = [list(calls), out["failed"], out["raised"]]
plans_left = sorted(f for f in os.listdir(FakeAd.HANDOVER_DIR) if f.endswith(".json"))
calls.clear(); FAIL_WITHDRAW.append(1)
res2, out2 = run_lane_b([new_void()], [costs, card])
print(json.dumps({"first": first, "plans": plans_left, "failed": [list(calls), out2["failed"], out2["raised"]], "cleared": cleared}))`);
    expect(r.first[0]).toEqual(['withdraw recFORMTASK00001', 'raise recLaneBTest00001:form:2 prior']);
    expect(r.first[1]).toBe('');
    // The rejected card's plan holds the tenant's details and opens nothing: removed. The open one is withdraw_form's.
    expect(r.plans).toEqual(['recFORMTASK00001.json']);
    expect(r.failed[0]).toEqual(['withdraw recFORMTASK00001']);
    expect(r.failed[1]).toMatch(/form card recFORMTASK00001 could not be withdrawn: Airtable PATCH 503/);
    expect(r.failed[2]).toEqual([]);
    // The rejected (closed) card's open Your turn step is cleared, so it never asks Kevin for a turn; as he
    // may have sent it, the line keeps his late "Yes, done" receivable.
    expect(r.cleared).toEqual([['recFORMTASK00009', true]]);
  });

  it('a sent card whose finish fails holds the tenancy: no end line is written over it that run', () => {
    const r = py(FAKE + `
DONE = "[02 Oct 2026 14:00 — agent] BLOCKER CLEARED (KEVIN credential): x. evidence: Kevin finished his turn in the robot's window (send it), confirmed in the Robot sign-in app.. Carry on"
def fail(_rc, item, day): raise RuntimeError("Airtable comment 500")
lb.finish_form = fail
touched = []
lb.finish_one = lambda _rc, item, day: touched.append(item["id"]) or True
card = task("recFORMTASK00001", NEW + ":form:1", status="Completed", created=date(2026, 9, 20), name="RENT FORM: a form", extra=DONE)
card = dict(card, notes="RENT FORM KEY: " + NEW + ":form:1\\n" + card["notes"])
roy_task = task("recROYTASK000012", NEW + ":paid:1", created=date(2026, 9, 26))
res, out = run_lane_b([new_void(status="CFV Actioned", start="2026-08-25", due=25)], [roy_task, card], tx=[paid(NEW, "2026-09-25", 900.00)])
print(json.dumps({"touched": touched, "failed": out["failed"]}))`);
    expect(r.touched).toEqual([]);
    expect(r.failed).toMatch(/Airtable comment 500/);
  });

  it('a later refusal by the email gate (a word Roy added) is a note on the row, not a failed run', () => {
    const r = py(FAKE + `
def refused(task_id, to): raise RuntimeError("REFUSED: recROYTASK000010 matches tier-1 ('x'). Never emailed onward")
lb.notify_roy = refused
live = task("recROYTASK000010", NEW + ":journal:1", name="NEW TENANT RENT: journal upload: Unit 9 – 1 Example Road")
res, out = run_lane_b([new_void()], [live])
print(json.dumps({"failed": out["failed"], "problems": out["problems"]}))`);
    expect(r.failed).toBe('');
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('task recROYTASK000010 was refused by the email gate: REFUSED');
  });

  it('one failed create does not stop the others; its tenant draft is not made and the task it was replacing stays open', () => {
    const r = py(FAKE + `
other = rid(7)
ts = [new_void(), new_void(i=other, unit="Unit 9 – 7 Example Road")]
tasks = [task("recROYTASK000011", NEW + ":costs:1", created=date(2026, 9, 20), said=[(date(2026, 9, 25), "No, not yet")]),
         task("recROYTASK000031", other + ":costs:1", created=date(2026, 9, 20), said=[(date(2026, 9, 25), "No, not yet")]),
         draft("recASKTASK000001", NEW + ":costs:1"), draft("recASKTASK000031", other + ":costs:1")]
for t in tasks: STORE[t["id"]] = {TK["notes"]: t["notes"], TK["status"]: "Today"}
FAIL_POST.add("NEW TENANT RENT: housing costs check 2: Unit 9 – 1 Example Road")
res, out = run_lane_b(ts, tasks)
print(json.dumps({"failed": out["failed"], "raised": out["raised"], "closed": out["closed"], "patched": [p["id"] for p in patches],
                  "posted": [p[TK["name"]] for p in posts]}))`);
    expect(r.failed).toContain('Airtable POST tasks 422: nope');
    expect(r.raised).toEqual(['Roy, costs check 2: Unit 9 – 7 Example Road', 'tenant draft, costs check 2: Unit 9 – 7 Example Road']);
    expect(r.posted).toEqual(['NEW TENANT RENT: housing costs check 2: Unit 9 – 7 Example Road', 'RENT ASK: costs check 2: Unit 9 – 7 Example Road']);
    expect(r.closed).toEqual(['recROYTASK000031']);
    expect(r.patched).toEqual(['recROYTASK000031']);
  });

  it('if Roy\'s address cannot be loaded nothing is created, at any step', () => {
    const r = py(FAKE + `
def broken(key): raise ImportError("agent-dispatch.py would not load")
lb.module = broken
res, out = run_lane_b([new_void()], [])
res, out2 = run_lane_b([new_void()], [JOURNAL_DONE])
print(json.dumps({"failed": [out["failed"], out2["failed"]], "posts": posts}))`);
    expect(r.failed[0]).toContain('agent-dispatch.py would not load');
    expect(r.failed[1]).toContain('agent-dispatch.py would not load');
    expect(r.posts).toEqual([]);
  });

  it('a dry run, a switched-off agent and an unread switch write nothing; the stage is still put on the row', () => {
    const r = py(FAKE + `
res, dry = run_lane_b([new_void()], [], writes=False)
res2, off = run_lane_b([new_void()], [], on=False)
res3, unread = run_lane_b([new_void()], [], on=None)
print(json.dumps({"dry": dry, "off": off, "posts": posts, "mailed": mailed, "note": stage(res2),
                  "lines": [lb.lane_b_line(dry), lb.lane_b_line(off), lb.lane_b_line(unread)]}))`);
    expect(r.posts).toEqual([]);
    expect(r.mailed).toEqual([]);
    expect(r.dry.planned).toEqual(['Roy, journal check 1: Unit 9 – 1 Example Road']);
    expect(r.dry.raised).toEqual([]);
    expect(r.off.planned).toEqual([]);
    // Nothing was raised, and the row does not claim Roy was asked.
    expect(r.note).toBe('new, the journal upload is next');
    expect(r.lines[0]).toBe('New-tenant tasks a real run would make: Roy, journal check 1: Unit 9 – 1 Example Road.');
    expect(r.lines[1]).toBe('New-tenant tasks: none raised, the Cash Flow Voids agent is switched off.');
    expect(r.lines[2]).toBe("New-tenant tasks: none raised, the Cash Flow Voids agent's switch could not be read.");
  });

  it('paused or unread, Kevin\'s own sends are still recorded and his sent-back card still leaves his queue; nothing new is raised', () => {
    const r = py(FAKE + `
DONE = "[02 Oct 2026 14:00 — agent] BLOCKER CLEARED (KEVIN credential): x. evidence: Kevin finished his turn in the robot's window (send it), confirmed in the Robot sign-in app.. Carry on"
finished, withdrawn_ids = [], []
lb.finish_form = lambda _rc, item, day: finished.append(item["id"]) or "CFV Actioned"
lb.withdraw_form = lambda _rc, item, day: withdrawn_ids.append(item["id"]) or True
def card(i, extra="", outcome="", status="Today", tenancy=NEW, feedback=""):
    t = task(i, tenancy + ":form:1", status=status, created=date(2026, 9, 28), name="RENT FORM: a form", extra=extra)
    return dict(t, outcome=outcome, feedback=feedback, notes="RENT FORM KEY: " + tenancy + ":form:1\\n" + t["notes"])
OTHER = rid(7)
tasks = [card("recFORMTASK00001", extra=DONE, outcome="Approved as-is", status="Completed"),
         card("recFORMTASK00002", outcome="Changes requested", feedback="Wrong rent", tenancy=OTHER)]
out = {}
for on in (False, None):
    finished.clear(); withdrawn_ids.clear(); posts.clear()
    res, o = run_lane_b([new_void(), new_void(i=OTHER, unit="Unit 8 – 1 Example Road")], tasks, on=on)
    out[str(on)] = [list(finished), list(withdrawn_ids), len(posts), o["failed"], lb.lane_b_line(o)]
print(json.dumps(out))`);
    for (const k of ['False', 'None']) {
      expect(r[k].slice(0, 4)).toEqual([['recFORMTASK00001'], ['recFORMTASK00002'], 0, '']);
      expect(r[k][4]).toContain('Form cards recorded or tidied: recFORMTASK00002; recFORMTASK00001.');
    }
  });

  it('closing keeps the Notes and adds a line; the end line is written once; a blank read is a stop; a task at Approval keeps its status', () => {
    const r = py(FAKE + `
t = new_void(status="CFV Actioned", start="2026-08-25")
tasks = [task("recROYTASK000012", NEW + ":paid:1")]
STORE["recROYTASK000012"] = {TK["notes"]: tasks[0]["notes"], TK["status"]: "Today"}
res, ok = run_lane_b([t], tasks, tx=[paid(NEW, "2026-09-25", 900.00)])
good = list(patches); del patches[:]
# Already closed by hand: only the end line is added, the status is not written.
STORE["recROYTASK000012"] = {TK["notes"]: tasks[0]["notes"], TK["status"]: "Completed"}
res, done = run_lane_b([t], [dict(tasks[0], status="Completed")], tx=[paid(NEW, "2026-09-25", 900.00)])
closed = list(patches); del patches[:]
# Moved to Approval since it was read: Kevin's to move, so nothing is written.
STORE["recROYTASK000012"] = {TK["notes"]: tasks[0]["notes"], TK["status"]: "Approval"}
lb.finish_one(rc._Here(), {"id": "recROYTASK000012", "why": "x", "complete": True, "end": False}, DAY)
approval = list(patches)
# The end line is already there: nothing is written.
STORE["recROYTASK000012"] = {TK["notes"]: good[0]["fields"][TK["notes"]], TK["status"]: "Completed"}
lb.finish_one(rc._Here(), {"id": "recROYTASK000012", "why": "x", "complete": True, "end": True}, DAY)
again = list(patches)
STORE["recROYTASK000012"] = {TK["notes"]: "", TK["status"]: "Today"}
res, bad = run_lane_b([t], tasks, tx=[paid(NEW, "2026-09-25", 900.00)])
bad_patches = list(patches)
# Blank Notes with the key still in the Description (every rule-made task has it there): still a stop.
del patches[:]
STORE["recROYTASK000012"] = {TK["notes"]: "", TK["description"]: tasks[0]["notes"], TK["status"]: "Today"}
res, bad2 = run_lane_b([t], tasks, tx=[paid(NEW, "2026-09-25", 900.00)])
after_blank = list(patches); del patches[:]
STORE["recROYTASK000012"] = {TK["notes"]: tasks[0]["notes"] + "\\nRENT SETUP ENDED: seen", TK["status"]: "Approval"}
res, raced = run_lane_b([t], tasks, tx=[paid(NEW, "2026-09-25", 900.00)])
del patches[:]
STORE["recROYTASK000012"] = {TK["notes"]: tasks[0]["notes"] + "\\n" + "x" * 95000, TK["status"]: "Today"}
lb.finish_one(rc._Here(), {"id": "recROYTASK000012", "why": "x", "complete": True, "end": True}, DAY)
kept = patches[0]["fields"][TK["notes"]]
long_notes = [len(kept), kept.endswith("once it is marked In Payment."), "Closed: x." in kept]
del patches[:]
print(json.dumps({"long": long_notes, "blankWithKeyInDescription": bad2["failed"] if not after_blank else "WROTE", "raced": [raced["closed"], patches, raced["failed"]],"closed": ok["closed"], "fields": good[0]["fields"], "handClosed": closed[0]["fields"], "approval": approval, "again": again,
                  "bad": bad["failed"], "badPatches": bad_patches, "line": lb.lane_b_line(ok)}))`);
    expect(r.closed).toEqual(['recROYTASK000012']);
    expect(r.fields.fldx4qCw17UfrKpaN).toBe('Completed');
    // Completion Date is a date and time field: a full stamp, as every other writer sends.
    expect(r.fields.fldFOi1SwEKuJRmdN).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    expect(r.fields.fldR7apBzSp3oxFxz).toBe('RENT SETUP KEY: recLaneBTest00001:paid:1\n\n'
      + '[02 Oct 2026 — rent-check] Closed: rent has reached the bank, nothing more to do.\n'
      + 'RENT SETUP ENDED: rent reached the bank, seen 2 Oct 2026. The new-tenant clock is finished for this tenancy. Late rent is chased again once it is marked In Payment.');
    expect(Object.keys(r.handClosed)).toEqual(['fldR7apBzSp3oxFxz']);
    expect(r.handClosed.fldR7apBzSp3oxFxz).toContain('RENT SETUP ENDED: rent reached the bank');
    expect(r.approval).toEqual([]);
    expect(r.again).toEqual([]);
    expect(r.bad).toContain('read back with blank Notes or no key line; nothing written');
    expect(r.blankWithKeyInDescription).toContain('read back with blank Notes or no key line; nothing written');
    // A task that moved to Approval between the read and the write is not reported as closed.
    expect(r.raced).toEqual([[], [], '']);
    expect(r.badPatches).toEqual([]);
    expect(r.line).toBe('New-tenant tasks closed or ended: recROYTASK000012.');
    expect(r.long).toEqual([90000, true, true]);
  });

  it('when one close of an ending tenancy fails, the end line is not written: the open task is not stranded behind it', () => {
    const r = py(FAKE + `
t = new_void(status="CFV Actioned", start="2026-08-03", due=3)
old = task("recROYTASK000010", NEW + ":journal:1", created=date(2026, 9, 1))
new = task("recROYTASK000012", NEW + ":paid:1", created=date(2026, 9, 18))
STORE["recROYTASK000012"] = {TK["notes"]: new["notes"], TK["status"]: "Today"}      # the older task cannot be read back
res, out = run_lane_b([t], [old, new], tx=[paid(NEW, "2026-10-01", 900.00)])
print(json.dumps({"failed": out["failed"], "closed": out["closed"], "patched": [[p["id"], "RENT SETUP ENDED" in p["fields"].get(TK["notes"], "")] for p in patches]}))`);
    expect(r.failed).toContain('recROYTASK000010 could not be read back');
    expect(r.closed).toEqual([]);
    expect(r.patched).toEqual([]);
  });

  it('the keyed-task read asks for every status, by the key mark in Notes or Description, and reads the link and both dates', () => {
    const r = py(`
calls = []
def fetch(table, params=None):
    calls.append([table, params["filterByFormula"], TK["tenancies"] in params["fields[]"]])
    return [{"id": "recROYTASK000010", "createdTime": "2026-09-20T23:30:00.000Z",
             "fields": {TK["name"]: "NEW TENANT RENT: x", TK["status"]: "Completed", TK["notes"]: "cut at the front", TK["tenancies"]: [NEW],
                        TK["description"]: "words\\nRENT SETUP KEY: " + NEW + ":journal:1", lb.COMPLETION_FIELD: "2026-09-25T09:00:00.000Z"}}]
rc.fetch_all = fetch
t = lb.read_tasks(rc._Here())[0]
grouped, asks, problems, stuck = lb.group_tasks([t])
pattern = re.search(r"'([^']+)'", calls[0][1]).group(1)
spellings = []
for mark in ["RENT SETUP KEY: ", "Rent setup  key:", "RENT SETUP\u00a0KEY: ", "RENTSETUPKEY:", "rent setup key ", "SETUP KEY: "]:
    line = mark + NEW + ":costs:1"
    spellings.append([lb.task_keys(line) == [(NEW, "costs", 1)], bool(re.search(pattern, line.upper()))])
print(json.dumps({"spellings": spellings, "calls": calls, "created": t["created"].isoformat(), "made": t["made"].isoformat(), "completed": t["completed"].isoformat(),
                  "status": t["status"], "tenancies": t["tenancies"], "keyed": sorted(grouped[NEW]), "problems": problems}))`);
    expect(r.calls).toEqual([['tblqB8b22hKBL4PF1', "OR(REGEX_MATCH(UPPER({Notes}), 'SETUP[^A-Z0-9]*KEY'), REGEX_MATCH(UPPER({Description}), 'SETUP[^A-Z0-9]*KEY'))", true]]);
    // Every spelling the key reader accepts is one the read fetches: the formula's pattern, run here.
    expect(r.spellings.every(([read, fetched]) => read && fetched)).toBe(true);
    // Made at 23:30 UTC is the 21st in London: the day counts are London days.
    expect([r.created, r.made, r.completed, r.status]).toEqual(['2026-09-21', '2026-09-20T23:30:00+00:00', '2026-09-25', 'Completed']);
    expect(r.tenancies).toEqual(['recLaneBTest00001']);
    // The key was only in the description (Notes lost it): the task is still on the clock.
    expect([r.keyed, r.problems]).toEqual([['journal'], []]);
  });
});

describe('rent-check: the do-not-chase list', () => {
  it('is read from the private file, is optional, and the wrong shape stops the run', () => {
    const r = py(`
def write(obj):
    with open(rc.PRE_SLATE_PATH, "w") as fh: json.dump(obj, fh)
write({"slate": "2026-10-02", "tenancies": []}); none = sorted(rc.read_no_chase())
write({"slate": "2026-10-02", "tenancies": [], "noChaseTenants": ["recT_quiet"]}); some = sorted(rc.read_no_chase())
out = []
for bad in ({"tenancies": [], "noChaseTenants": "recT_quiet"}, {"tenancies": [], "noChaseTenants": ["Sam Sample"]}, ["recT_quiet"]):
    write(bad)
    try: rc.read_no_chase(); out.append("passed")
    except RuntimeError as e: out.append(str(e)[:61])
os.remove(rc.PRE_SLATE_PATH)
try: rc.read_no_chase(); out.append("passed")
except RuntimeError as e: out.append(str(e)[:61])
print(json.dumps({"none": none, "some": some, "bad": out}))`);
    expect(r.none).toEqual([]);
    expect(r.some).toEqual(['recT_quiet']);
    expect(r.bad).toEqual(Array(4).fill('control failed: the list of tenants not to chase could not be'));
  });

  it('an id on the list that is not a tenant this run read stops the run: a tenancy id there would protect nobody', () => {
    const r = py(`
ok = world([tenancy(PAYER, 28, 300.00, tenant="recT_quiet")], [], noChase=["recT_quiet"])
rc.check_no_chase(ok)
bad = world([tenancy(PAYER, 28, 300.00, tenant="recT_quiet")], [], noChase=["recT_quiet", PAYER])
try: rc.check_no_chase(bad); out = "passed"
except RuntimeError as e: out = str(e)
print(json.dumps({"bad": out}))`);
    expect(r.bad).toBe('control failed: 1 id on the do-not-chase list (noChaseTenants) matched no tenant; it takes tenant ids, not tenancy ids');
  });
});

// THE BREAKS (each run against this file and tests/rent-check.test.js on 2 Oct 2026; every one
// fails at least one case): the adopted branch dropped; the `void` test removed from it; the tenant
// draft raised for an existing void; position() reading the first step; noChase removed from
// either lane; each wait set to 0 and each silence rule switched off; the Cancelled branch removed;
// a stopped clock still closing other tasks; _NEGATED, the step, the idioms or the future words
// removed from reading(), or "confirmed" put back as a yes; the ENDED check removed; a rule-closed
// task read as ticked; a ticked journal with odd words stalling; journal day 0 taken from an earlier
// "not yet"; a form card closed, or the clock ended, when rent lands with nothing matched; "cannot
// tell" read as paid; a key acted on for a tenancy the task is not linked to; an older-task answer
// ignored, or gated by the day instead of the minute; the newest line read instead of the newest
// yes or no; the Property Manager line shape dropped; the missing tenant draft not re-raised, raised
// twice, or raised before a first check's day; is_ask by name only; the "payment" line dropped from
// the draft; the trial key dropped from it; an answered or an older open task not closed; the key
// check removed from finish_one(); the end line written twice; the status rewritten on a closed or
// an Approval task; Roy's task created with no owner, not emailed, or not offered to notify again;
// a cut-off send not said; a failed create stopping the run, closing the old task or still making
// the draft; agent-dispatch loaded after the create; the Description dropped from the keyed read
// or the key from the description; the actioned status ignored; the young-void rule removed; twins
// not said; the do-not-chase shape check or check_no_chase() removed; an unread switch read as off.
