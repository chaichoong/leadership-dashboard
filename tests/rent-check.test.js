// The daily rent check (Kevin, 2 Oct 2026): scripts/rent-check.py, phase 1 of the Cash Flow Voids agent.
//
// These drive the REAL rule with fixture records shaped exactly as Airtable returns them
// (returnFieldsByFieldId, selects as strings, links as id arrays). The first three cases are the
// worked examples Kevin approved at the build gate, shaped from live rows read on 2 Oct 2026 with
// every id, address, rent and start date replaced (and, for the cash flow voids, the due days and part
// payment too): this repo is public and a real address beside "late" is not.
//
// Back-tested (2 Oct 2026) by breaking the rule under test and watching its case fail:
//   * TOLERANCE_DAYS = 0                          -> "the due day itself, and the day after, are not late" fails
//   * EARLY_PAY_DAYS = 0                          -> "a payment 5 days early counts" fails
//   * due_on() without the month-end clamp        -> "a due day of 31 in a 30-day month" crashes
//   * late judged on today with a fresh feed      -> "not called late until the bank data covers the two days" fails
//   * late judged on the feed day when it is stale -> "a dead bank feed never reads as everyone paying" fails
//   * bank_view() using every account             -> "each tenancy is judged on its own rent account" fails
//   * first_uncovered() ignoring `start`          -> "is not judged on a cycle before it began" fails
//   * days late counted from the newest cycle     -> "a second missed month" fails
//   * SHORT_SLACK = 100000 (amount ignored)       -> "a payment under the rent is paid short" and "a part payment does not clear" fail
//   * short said before the cycle is covered      -> "paid short is never said of rent not yet due" fails
//   * short_by() without the two-cycle weighing   -> the same case fails (the 8-days-early split)
//   * judge() ignoring the bank faults            -> "a stale bank feed calls nobody late" fails
//   * judge() ignoring feed["waiting"]            -> "money-in waiting to be matched" fails
//   * WAITING_SHARE = 0                           -> "a stray few pounds waiting does not hide a late tenancy" fails
//   * MASS_LATE_MIN = 9999                        -> "many tenancies turning late at once" fails
//   * the surge greying every late row            -> "...while one already late stays late" fails
//   * fresh ignoring late_before                  -> "a tenancy the last run called late stays late through a surge" fails
//   * the new lane always taking the status light -> "a new cash flow void is amber until its first rent is late" fails
//   * the lookback-edge branch removed            -> "nothing matched in 80 days" fails
//   * FLOORS set to 0 / LIVE_FLOOR = 0            -> the two control cases fail
//   * pre_slate ignored                           -> worked example 3 fails
//   * read_pre_slate() without the shape check    -> "the wrong shape" case fails
//   * floor compared on the rounded figure        -> "77 of 79 is below the floor" fails
//   * the red clause dropped from `worst`         -> "one red is a fail even above the floor" fails
// Third pass (2 Oct 2026), same method, 15 more: append_history without lanes, bank_view() on the newest
// feed, a no-payment tenancy taking no account, short said on a stale feed, two-cycle weighing before the
// start, the row status either way, the void's cannot-tell gate, no fallback to the covered cycle, the feed
// day not capped at today, an old history line trusted, the feed warning hidden by any grey row, and an
// unbounded cycle window. Each fails a case in the last describe block.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(root, 'scripts');

const HARNESS = `
import importlib.util, json, sys, os, io, contextlib
from datetime import date, datetime, timedelta, timezone
spec = importlib.util.spec_from_file_location("rc", os.path.join(${JSON.stringify(SCRIPTS)}, "rent-check.py"))
rc = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc)
import tempfile
# No test may touch the real history log or the private list on this Mac (a mutation run once did).
SCRATCH = tempfile.mkdtemp()
rc.HISTORY = os.path.join(SCRATCH, "history.jsonl")
rc.PRE_SLATE_PATH = os.path.join(SCRATCH, "pre-slate.json")
# No test may reach Airtable either: the task state is read through this, replaced per test.
rc.read_task_state = lambda: {"on": False, "status": "Building", "keys": {}}
# Lane B (scripts/rent_new_tenant.py) reads and writes through these. No test here may reach
# Airtable or email Roy; its own cases are in tests/rent-new-tenant.test.js.
rc.lane_b_rules.read_tasks = lambda _rc: []
rc.lane_b_rules.read_names = lambda _rc, ids: {}
def _no_lane_b_write(*a, **k): raise RuntimeError("a rent-check test tried a real lane B write")
rc.lane_b_rules.raise_one = _no_lane_b_write
rc.lane_b_rules.finish_one = _no_lane_b_write
rc.lane_b_rules.notify_roy = _no_lane_b_write
# Roy's agent-managed late notice reads its tasks through this: never Airtable in a test.
rc.read_agent_late = lambda: {}
# Payment plans read their cards through this; their own cases are in tests/rent-plans.test.js.
rc.rent_plans.read_cards = lambda _rc: []
# Benefit-cap claims read and raise through these; their own cases are in tests/rent-cap.test.js.
rc.rent_cap.read = lambda _rc: ({}, [])
# The form chase reads tenants' form links and its own tasks through these; its cases are in tests/rent-form-chase.test.js.
rc.rent_form_chase.read_links = lambda _rc: {}
rc.rent_form_chase.read_chases = lambda _rc: {}
# The text alarm reads a ledger on this Mac and info@'s mailbox: never in a test.
rc.text_check.LEDGER = os.path.join(tempfile.mkdtemp(), "no-texts.jsonl")
def _no_mail(q):
    raise AssertionError("a rent-check test reached for info@'s mailbox")
rc.text_check.default_list_mail = _no_mail
rc.rent_cap.read_tenants = lambda _rc, ids: {}
rc.rent_cap.read_busy = lambda _rc: set()
rc.rent_cap.read_capped = lambda _rc, day: set()
def _no_cap_write(*a, **k): raise RuntimeError("a rent-check test tried a real benefit-cap card")
rc.rent_cap.raise_card = _no_cap_write
rc.rent_cap.write_mark = _no_cap_write
TY, TN, TX, AC = rc.TY, rc.TN, rc.TX, rc.AC
DAY = date(2026, 10, 2)
def rec(i, f): return {"id": i, "fields": f}
def tenancy(i, due, rent, status="In Payment", start="2025-04-10", tenant="recT_uc", unit=None, **extra):
    f = {TY["dueDay"]: str(due), TY["rent"]: rent, TY["payStatus"]: status, TY["start"]: start,
         TY["tenants"]: [tenant], TY["tenantStatus"]: ["Active"], TY["unitRef"]: [unit or ("Unit " + i)]}
    f.update(extra)
    return rec(i, f)
def paid(tid, day, amount, account="recA_main"):
    return rec("tx_" + tid + day, {TX["date"]: day, TX["tenancy"]: [tid], TX["amount"]: amount, TX["account"]: [account]})
def waiting(day, amount, account="recA_main"):
    return rec("txU" + day, {TX["date"]: day, TX["amount"]: amount, TX["account"]: [account]})
def world(tenancies, tx, unmatched=(), feed=None, pre=(), day=DAY, accounts=None, lateBefore=(), noChase=()):
    # The bank feed defaults to noon (London) on the day checked. A matched payment on a tenancy
    # outside the test keeps Main Bank a known rent account.
    feed = feed or (day.isoformat() + "T11:03:29.000Z")
    return {"tenancies": list(tenancies),
            "tenants": [rec("recT_uc", {TN["payType"]: "Universal Credit"}), rec("recT_work", {TN["payType"]: "Working"}),
                        rec("recT_agent", {TN["payType"]: "Agent-Managed"})],
            "tx": [paid("recOTHER", (day - timedelta(days=4)).isoformat(), 500)] + list(tx), "unmatched": list(unmatched),
            "accounts": accounts if accounts is not None else [rec("recA_main", {AC["alias"]: "Main Bank", AC["updated"]: feed})],
            "preSlate": set(pre), "lateBefore": set(lateBefore), "noChase": set(noChase)}
def run(tenancies, tx, day=DAY, hour=12, **kw):
    now = datetime(day.year, day.month, day.day, hour, 30, tzinfo=timezone.utc)
    res = rc.assess(world(tenancies, tx, day=day, **kw), day, now)
    return res, {r["id"]: r for r in res["tenancies"]}
`;

function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('rent-check: the worked examples Kevin approved (2 Oct 2026, anonymised)', () => {
  it('1. due day 30, last matched payment 29 Aug: amber, late 2 days, once the bank data covers the two days', () => {
    const r = py(`
res, rows = run([tenancy("recEX1", 30, 1200.00, unit="Unit 9 – 1 Example Road")], [paid("recEX1", "2026-08-29", 1200.40)])
print(json.dumps({"row": rows["recEX1"], "line": res["briefLine"], "paying": res["paying"], "total": res["total"]}))`);
    expect(r.row.light).toBe('amber');
    expect(r.row.lane).toBe('late');
    expect(r.row.daysLate).toBe(2);
    expect(r.row.note).toBe('late 2 days, due 30 Sep, last matched payment 29 Aug');
    expect(r.line).toBe('0 of 1 tenants paying (0.0%, floor 97.5%). Late: Unit 9 – 1 Example Road (2 days). Bank data as at 2 Oct 12:03.');
    expect([r.paying, r.total]).toEqual([0, 1]);
  });

  it('1b. the same tenancy is not called late until the bank data covers the two days', () => {
    const r = py(`
res, rows = run([tenancy("recEX1", 30, 1200.00)], [paid("recEX1", "2026-08-29", 1200.40)], hour=6, feed="2026-10-01T11:03:29.000Z")
print(json.dumps({"light": res["lights"]["recEX1"], "line": res["briefLine"]}))`);
    expect(r.light).toBe('green');
    expect(r.line).toContain('Bank data as at 1 Oct 12:03.');
  });

  it('2. due day 2, paid 2 Sep, checked on the due day: green', () => {
    const r = py(`
res, rows = run([tenancy("recEX2", 2, 500.00, start="2021-10-20")], [paid("recEX2", "2026-09-02", 500.00)])
print(json.dumps({"light": res["lights"]["recEX2"], "listed": list(rows), "worst": res["worst"], "line": res["briefLine"]}))`);
    expect(r.light).toBe('green');
    expect(r.listed).toEqual([]);
    expect(r.worst).toBe('ok');
    expect(r.line).toBe('1 of 1 tenants paying (100.0%, floor 97.5%). Every tenant in place is paying. Bank data as at 2 Oct 12:03.');
  });

  it('3. cash flow voids that existed on the slate date: shown, counted, left alone', () => {
    const r = py(`
ts = [tenancy("recEX3", 11, 900.00, status="CFV", start="2026-03-11", unit="Unit 9 – 2 Example Road"),
      tenancy("recEX4", 7, 900.00, status="CFV Actioned", start="2026-04-09", unit="Unit 9 – 3 Example Road")]
res, rows = run(ts, [paid("recEX3", "2026-08-11", 40.00)], pre=["recEX3", "recEX4"])
other, orows = run(ts, [paid("recEX3", "2026-08-11", 40.00)])
print(json.dumps({"a": rows["recEX3"], "b": rows["recEX4"], "line": res["briefLine"], "worst": res["worst"],
                  "notListed": [orows["recEX3"]["lane"], orows["recEX4"]["lane"], other["worst"]]}))`);
    expect([r.a.light, r.a.lane, r.a.note]).toEqual(['red', 'existing', 'cash flow void, existing, left alone']);
    expect([r.b.light, r.b.lane]).toEqual(['amber', 'existing']);
    expect(r.line).toContain('Existing cash flow voids, left alone: Unit 9 – 2 Example Road; Unit 9 – 3 Example Road.');
    // Below the floor, but only by tenancies Kevin has chosen to leave alone: amber, not red.
    expect(r.worst).toBe('warn');
    // Off the private list they are an ordinary late void and a new tenant, and the light is red.
    expect(r.notListed).toEqual(['late', 'new', 'fail']);
  });
});

describe('rent-check: the rule', () => {
  it('the due day itself, and the day after, are not late', () => {
    const r = py(`
out = {}
for day in (date(2026, 9, 30), date(2026, 10, 1), date(2026, 10, 2)):
    res, rows = run([tenancy("recX", 30, 500)], [paid("recX", "2026-08-30", 500)], day=day)
    out[day.isoformat()] = res["lights"]["recX"]
print(json.dumps(out))`);
    expect(r).toEqual({ '2026-09-30': 'green', '2026-10-01': 'green', '2026-10-02': 'amber' });
  });

  it('a payment 5 days early counts for the cycle, 6 days early does not', () => {
    const r = py(`
out = {}
for when in ("2026-09-25", "2026-09-24"):
    res, rows = run([tenancy("recX", 30, 500)], [paid("recX", when, 500)])
    out[when] = res["lights"]["recX"]
print(json.dumps(out))`);
    expect(r).toEqual({ '2026-09-25': 'green', '2026-09-24': 'amber' });
  });

  it('a due day of 31 in a 30-day month falls on the 30th, and February on its last day', () => {
    const r = py(`
start = date(2020, 1, 1)
print(json.dumps({"sep": rc.due_on(2026, 9, 31).isoformat(), "feb": rc.due_on(2027, 2, 30).isoformat(),
                  "owed": rc.first_uncovered(date(2026, 8, 31), start, date(2026, 10, 2), 31).isoformat(),
                  "yearEnd": rc.first_uncovered(date(2026, 11, 30), start, date(2027, 1, 2), 31).isoformat(),
                  "prev": rc.prev_due(date(2027, 1, 31), 31).isoformat()}))`);
    expect(r).toEqual({ sep: '2026-09-30', feb: '2027-02-28', owed: '2026-09-30', yearEnd: '2026-12-31', prev: '2026-12-31' });
  });

  it('the tolerance holds across a month end and a year end', () => {
    const r = py(`
out = {}
for day in (date(2027, 1, 1), date(2027, 1, 2)):
    res, rows = run([tenancy("recX", 31, 500)], [paid("recX", "2026-11-30", 500)], day=day)
    out[day.isoformat()] = res["lights"]["recX"]
print(json.dumps(out))`);
    expect(r).toEqual({ '2027-01-01': 'green', '2027-01-02': 'amber' });
  });

  it('a second missed month counts from the first one: 31 days late on 31 Oct, 32 on 1 Nov, never back to 2', () => {
    const r = py(`
out = {}
for day in (date(2026, 10, 31), date(2026, 11, 1)):
    res, rows = run([tenancy("recX", 30, 500)], [paid("recX", "2026-08-29", 500)], day=day)
    out[day.isoformat()] = [rows["recX"]["light"], rows["recX"]["daysLate"], rows["recX"]["note"]]
print(json.dumps(out))`);
    expect(r['2026-10-31']).toEqual(['red', 31, 'late 31 days, due 30 Sep, last matched payment 29 Aug']);
    expect(r['2026-11-01']).toEqual(['red', 32, 'late 32 days, due 30 Sep, last matched payment 29 Aug']);
  });

  it('a tenancy that began this week is not judged on a cycle before it began', () => {
    const r = py(`
res, rows = run([tenancy("recA", 15, 500, start="2026-10-01"), tenancy("recB", 1, 500, start="2026-10-02"),
                 tenancy("recC", 28, 500, start="2026-09-28")], [])
print(json.dumps({"a": res["lights"]["recA"], "b": res["lights"]["recB"], "c": rows["recC"]}))`);
    expect([r.a, r.b]).toEqual(['green', 'green']);
    expect(r.c.note).toBe('late 4 days, due 28 Sep, no matched payment in the last 80 days');
  });

  it('late for 7 days or more turns red', () => {
    const r = py(`
res, rows = run([tenancy("recX", 25, 500)], [paid("recX", "2026-08-25", 500)])
print(json.dumps(rows["recX"]))`);
    expect([r.light, r.daysLate]).toEqual(['red', 7]);
  });

  it('ended, former and not-yet-started tenancies are not counted', () => {
    const r = py(`
ended = tenancy("recEnded", 1, 500); ended["fields"][TY["end"]] = "2026-10-01"
lastDay = tenancy("recLastDay", 1, 500); lastDay["fields"][TY["end"]] = "2026-10-02"
former = tenancy("recFormer", 1, 500); former["fields"][TY["tenantStatus"]] = ["Former"]
future = tenancy("recFuture", 1, 500, start="2026-10-10")
res, rows = run([ended, lastDay, former, future], [paid("recLastDay", "2026-10-01", 500)])
print(json.dumps({"ids": sorted(res["lights"]), "total": res["total"]}))`);
    expect(r).toEqual({ ids: ['recLastDay'], total: 1 });
  });

  it('a new tenant who has never paid is the new-tenant lane, with the day count', () => {
    const r = py(`
res, rows = run([tenancy("recNew", 28, 600, status="CFV", start="2026-09-28")], [])
print(json.dumps({"row": rows["recNew"], "line": res["briefLine"], "worst": res["worst"]}))`);
    expect([r.row.light, r.row.lane]).toEqual(['red', 'new']);
    expect(r.row.note).toBe('new tenant not in payment yet, day 4, first rent due 28 Sep, cash flow void');
    expect(r.line).toContain('New tenants not in payment yet: Unit recNew.');
    expect(r.worst).toBe('fail');
  });

  it('a cash flow void whose full rent has been matched reads green, and is still listed so the status gets put right', () => {
    const r = py(`
res, rows = run([tenancy("recBack", 28, 600, status="CFV Actioned")], [paid("recBack", "2026-09-29", 600)])
print(json.dumps({"row": rows["recBack"], "paying": res["paying"]}))`);
    expect(r.row.light).toBe('green');
    expect(r.row.note).toBe('paid in full (last matched payment 29 Sep), still marked cash flow void actioned');
    expect(r.paying).toBe(1);
  });

  it('a part payment does not clear a cash flow void', () => {
    const r = py(`
res, rows = run([tenancy("recPart", 11, 900.00, status="CFV")], [paid("recPart", "2026-09-11", 40.00)])
print(json.dumps({"row": rows["recPart"], "paying": res["paying"]}))`);
    expect([r.row.light, r.row.lane]).toEqual(['red', 'late']);
    expect(r.row.note).toBe('cash flow void, last matched payment 11 Sep, part payment £40.00 of £900.00');
    expect(r.paying).toBe(0);
  });

  it('a payment under the rent is paid short: amber, named, still counted as paying', () => {
    const r = py(`
ts = [tenancy("recShort", 23, 900.00, unit="Unit 9 – 4 Example Road"), tenancy("recAgent", 23, 900.00, tenant="recT_agent"),
      tenancy("recSplit", 23, 900.00), tenancy("recPenny", 23, 900.00)]
tx = [paid("recShort", "2026-09-23", 839.00), paid("recAgent", "2026-09-23", 720.00),
      paid("recSplit", "2026-09-20", 500.00), paid("recSplit", "2026-09-27", 400.00), paid("recPenny", "2026-09-23", 899.50)]
res, rows = run(ts, tx)
print(json.dumps({"short": rows["recShort"], "lights": res["lights"], "paying": res["paying"], "total": res["total"],
                  "line": res["briefLine"], "worst": res["worst"]}))`);
    expect([r.short.light, r.short.lane]).toEqual(['amber', 'short']);
    expect(r.short.note).toBe('paid short: £839.00 of £900.00, last matched payment 23 Sep');
    // The cycle weighed rides on the row: lane C raises one benefit-cap task per short cycle (scripts/rent_cap.py).
    expect(r.short.cycle).toBe('2026-09-23');
    // Agent-managed rent arrives net of fees, two part payments make the rent, and 50p under is the rent.
    expect([r.lights.recAgent, r.lights.recSplit, r.lights.recPenny]).toEqual(['green', 'green', 'green']);
    expect([r.paying, r.total]).toEqual([4, 4]);
    expect(r.line).toBe('4 of 4 tenants paying (100.0%, floor 97.5%). Paid short: Unit 9 – 4 Example Road (£839.00 of £900.00). Bank data as at 2 Oct 12:03.');
    expect(r.worst).toBe('warn');
  });

  it('paid in full is said only of a rent weighed on trusted bank data: lane C\'s full-payer claim reads it', () => {
    const r = py(`
ts = [tenancy("recFull", 23, 900.00), tenancy("recShortP", 23, 900.00), tenancy("recNew", 23, 900.00, start="2026-09-28"),
      tenancy("recVoidPaid", 23, 900.00, status="CFV")]
tx = [paid("recFull", "2026-09-23", 900.00), paid("recShortP", "2026-09-23", 700.00), paid("recVoidPaid", "2026-09-23", 900.00)]
res, rows = run(ts, tx)
stale, _ = run(ts, tx, feed="2026-09-20T11:00:00.000Z")
print(json.dumps({"full": res["paidFull"], "stale": stale["paidFull"], "rowKeys": sorted(set(k for t in res["tenancies"] for k in t))}))`);
    // The full payer only: not the one paid short, not the new tenant with no rent due yet, not a cash flow void that paid.
    expect(r.full).toEqual(['recFull']);
    // Old bank data proves nothing: nobody is said to have paid in full.
    expect(r.stale).toEqual([]);
    // The flag never reaches the rows written to the status board.
    expect(r.rowKeys).not.toContain('full');
  });

  it('a tenancy with no due day, rent or tenant is cannot tell, never late and never fine', () => {
    const r = py(`
bad = tenancy("recBad", 1, 0); bad["fields"][TY["dueDay"]] = None; bad["fields"][TY["tenants"]] = []
nounit = tenancy("recNoUnit", 30, 500); nounit["fields"][TY["unitRef"]] = []; nounit["fields"][TY["surname"]] = "Example"
res, rows = run([bad, nounit], [])
print(json.dumps({"bad": rows["recBad"], "unit": rows["recNoUnit"]["unit"], "paying": res["paying"]}))`);
    expect(r.bad.light).toBe('grey');
    expect(r.bad.note).toBe('cannot tell: the tenancy has no due day, no rent amount, no linked tenant');
    expect(r.unit).toBe('Example (no unit linked)');
    expect(r.paying).toBe(0);
  });
});

describe('rent-check: cannot tell beats a wrong chase', () => {
  it('a stale bank feed calls nobody late', () => {
    const r = py(`
res, rows = run([tenancy("recX", 25, 500), tenancy("recY", 1, 500)],
                [paid("recX", "2026-08-25", 500), paid("recY", "2026-09-29", 500)], hour=6, feed="2026-09-30T10:00:00.000Z")
print(json.dumps({"x": rows["recX"], "y": res["lights"]["recY"], "blocked": res["bankBlocked"], "line": res["briefLine"], "counts": res["counts"]}))`);
    expect(r.x.light).toBe('grey');
    expect(r.x.note).toBe('cannot tell: Main Bank bank feed last updated 44 hours ago');
    expect(r.y).toBe('green');
    expect(r.blocked).toBe(true);
    expect(r.counts.amber + r.counts.red).toBe(0);
    expect(r.line).toContain('Cannot tell for 1: Main Bank bank feed last updated 44 hours ago.');
  });

  it('money-in waiting to be matched that could be the rent calls nobody late, however long it waits', () => {
    const r = py(`
t, tx = [tenancy("recX", 30, 500)], [paid("recX", "2026-08-30", 500)]
could, crows = run(t, tx, unmatched=[waiting("2026-10-01", 500)])
other, _ = run(t, tx, unmatched=[waiting("2026-10-01", 500, account="recA_personal")])
before, _ = run(t, tx, unmatched=[waiting("2026-09-10", 500)])
old, orows = run(t, tx, unmatched=[waiting("2026-09-26", 500)], day=date(2026, 10, 20))
print(json.dumps({"could": crows["recX"], "otherAccount": other["lights"]["recX"], "beforeTheCycle": before["lights"]["recX"],
                  "stillWaitingOn20Oct": orows["recX"]["light"]}))`);
    expect(r.could.light).toBe('grey');
    expect(r.could.note).toBe('cannot tell: 1 payment into the rent accounts (£500.00) not matched yet');
    expect(r.otherAccount).toBe('amber');
    expect(r.beforeTheCycle).toBe('amber');
    expect(r.stillWaitingOn20Oct).toBe('grey');
  });

  it('many tenancies turning late at once is cannot tell, in one short line, while one already late stays late', () => {
    const r = py(`
day = date(2026, 9, 27)
ts = [tenancy("rec%02d" % i, 25, 500) for i in range(63)] + [tenancy("recOld", 15, 500, unit="Unit 9 – 5 Example Road")]
tx = [paid("rec%02d" % i, "2026-08-25", 500) for i in range(63)] + [paid("recOld", "2026-08-15", 500)]
res, rows = run(ts, tx, day=day)
print(json.dumps({"total": res["total"], "worst": res["worst"], "counts": res["counts"], "blocked": res["bankBlocked"],
                  "old": rows["recOld"], "line": res["briefLine"], "payload": len(json.dumps({k: v for k, v in res.items() if k != "lights"}))}))`);
    expect(r.total).toBe(64);
    expect(r.counts).toEqual({ green: 0, amber: 0, red: 1, grey: 63 });
    expect([r.old.light, r.old.daysLate]).toEqual(['red', 12]);
    expect(r.blocked).toBe(true);
    expect(r.line).toContain('Late: Unit 9 – 5 Example Road (12 days).');
    expect(r.line).toContain('Cannot tell for 63: 63 tenancies turned late at once');
    expect(r.line.length).toBeLessThan(700);
    expect(r.payload).toBeLessThan(95000);
    expect(r.worst).toBe('fail');
  });

  it('nine late at once among many is still nine late, named five at a time', () => {
    const r = py(`
day = date(2026, 9, 28)
ts = [tenancy("recL%02d" % i, 25, 500) for i in range(9)] + [tenancy("recG%02d" % i, 1, 500) for i in range(55)]
res, rows = run(ts, [paid("recG%02d" % i, "2026-09-01", 500) for i in range(55)] + [paid("recL%02d" % i, "2026-08-25", 500) for i in range(9)], day=day)
print(json.dumps({"counts": res["counts"], "line": res["briefLine"]}))`);
    expect(r.counts).toEqual({ green: 55, amber: 9, red: 0, grey: 0 });
    expect(r.line).toContain('Unit recL04 (3 days); and 4 more.');
  });

  it('a near-empty read stops the run instead of reporting an empty business', () => {
    const r = py(`
try:
    rc.check_controls(world([tenancy("recX", 30, 500)], [])); out = "passed"
except RuntimeError as e:
    out = str(e)
rc.check_controls({"tenancies": [0] * 64, "tenants": [0] * 60, "tx": [0] * 150, "accounts": [0, 0], "unmatched": []})
print(json.dumps({"small": out}))`);
    expect(r.small).toContain('control failed: tenancies read returned 1 rows');
  });

  it('too few live tenancies judged is a failed run, never "5 of 5, all fine"', () => {
    const r = py(`
rows = []
today = rc.today_london()
rc.load = lambda day: world([tenancy("rec%02d" % i, 1, 500) for i in range(5)], [paid("rec%02d" % i, today.isoformat(), 500) for i in range(5)], day=today)
rc.write_row = lambda status, text, payload, now: rows.append([status, payload])
with contextlib.redirect_stdout(io.StringIO()):
    code = rc.main(["run"])
empty, _ = run([], [])
print(json.dumps({"code": code, "status": rows[0][0], "line": rows[0][1]["briefLine"], "emptyWorst": empty["worst"], "emptyLine": empty["briefLine"]}))`);
    expect(r.code).toBe(1);
    expect(r.status).toBe('Failed');
    expect(r.line).toContain('only 5 live tenancies were judged (expected 20+)');
    expect(r.emptyWorst).toBe('fail');
    expect(r.emptyLine).toBe('No live tenancy could be judged, so the rent check tells you nothing today.');
  });

  it('an unreadable list of existing cash flow voids stops the run', () => {
    const r = py(`
import tempfile
out = {}
for name, body in (("missing", None), ("damaged", "{not json"), ("wrongShape", json.dumps({"ids": []}))):
    path = os.path.join(tempfile.mkdtemp(), "pre.json")
    if body is not None:
        open(path, "w").write(body)
    try:
        rc.read_pre_slate(path); out[name] = "passed"
    except RuntimeError as e:
        out[name] = str(e)[:70]
good = os.path.join(tempfile.mkdtemp(), "pre.json"); open(good, "w").write(json.dumps({"tenancies": ["recA", "recB"]}))
out["good"] = sorted(rc.read_pre_slate(good))
print(json.dumps(out))`);
    for (const k of ['missing', 'damaged', 'wrongShape']) expect(r[k]).toContain('control failed: the list of existing cash flow voids could not be read');
    expect(r.good).toEqual(['recA', 'recB']);
  });
});

describe('rent-check: the report', () => {
  it('counts, percentage against the floor and the payload Home reads', () => {
    const r = py(`
ts = [tenancy("recG%02d" % i, 1, 500, tenant="recT_agent") for i in range(39)] + [tenancy("recLate", 30, 500, tenant="recT_work")]
tx = [paid("recG%02d" % i, "2026-10-01", 500) for i in range(39)] + [paid("recLate", "2026-08-30", 500)]
res, rows = run(ts, tx)
print(json.dumps({"asAt": res["asAt"], "paying": res["paying"], "total": res["total"], "pct": res["pct"], "worst": res["worst"],
                  "below": res["belowFloor"], "marked": res["markedInPayment"], "type": rows["recLate"]["type"], "detail": rc.detail(res),
                  "keys": sorted(rows["recLate"])}))`);
    expect([r.asAt, r.paying, r.total, r.pct, r.marked, r.below]).toEqual(['2026-10-02', 39, 40, 97.5, 40, false]);
    expect(r.worst).toBe('warn');
    expect(r.type).toBe('Working');
    expect(r.keys).toEqual(['daysLate', 'id', 'lane', 'light', 'note', 'owed', 'rent', 'status', 'type', 'unit']);
    expect(r.detail).toContain('Marked In Payment in Airtable: 40 of 40.');
    expect(r.detail).toContain('AMBER Unit recLate (Working, £500.00): late 2 days, due 30 Sep, last matched payment 30 Aug');
    expect(r.detail).toContain('Bank feeds: Main Bank 1 hours old.');
  });

  it('below the floor with someone new not paying is a fail', () => {
    const r = py(`
ts = [tenancy("recG%02d" % i, 1, 500) for i in range(38)] + [tenancy("recLate", 30, 500)]
tx = [paid("recG%02d" % i, "2026-10-01", 500) for i in range(38)] + [paid("recLate", "2026-08-30", 500)]
res, rows = run(ts, tx)
print(json.dumps({"pct": res["pct"], "worst": res["worst"]}))`);
    expect(r).toEqual({ pct: 97.4, worst: 'fail' });
  });

  it('77 of 79 is below the floor even though it prints as 97.5%', () => {
    const r = py(`
ts = [tenancy("recG%02d" % i, 1, 500) for i in range(77)] + [tenancy("recL%d" % i, 30, 500) for i in range(2)]
tx = [paid("recG%02d" % i, "2026-10-01", 500) for i in range(77)] + [paid("recL%d" % i, "2026-08-30", 500) for i in range(2)]
res, rows = run(ts, tx)
print(json.dumps({"pct": res["pct"], "below": res["belowFloor"], "worst": res["worst"]}))`);
    expect(r).toEqual({ pct: 97.5, below: true, worst: 'fail' });
  });

  it('--dry-run and status never reach a write', () => {
    const r = py(`
calls = []
today = rc.today_london()
rc.load = lambda day: world([tenancy("rec%02d" % i, 1, 500) for i in range(20)], [], day=today)
rc.api = lambda *a, **k: calls.append(a) or {}
rc.append_history = lambda *a, **k: calls.append("history")
with contextlib.redirect_stdout(io.StringIO()):
    codes = [rc.main(["status"]), rc.main(["run", "--dry-run"])]
print(json.dumps({"codes": codes, "calls": len(calls)}))`);
    expect(r).toEqual({ codes: [0, 0], calls: 0 });
  });

  it('a real run writes one row and one history line, and the payload leaves the per-tenancy lights out', () => {
    const r = py(`
rows, hist = [], []
today = rc.today_london()
rc.load = lambda day: world([tenancy("rec%02d" % i, 1, 500) for i in range(20)], [], day=today)
rc.write_row = lambda status, text, payload, now: rows.append([status, payload])
rc.append_history = lambda res, now: hist.append(res["lights"])
with contextlib.redirect_stdout(io.StringIO()):
    code = rc.main(["run"])
print(json.dumps({"code": code, "rows": len(rows), "hasLights": "lights" in rows[0][1],
                  "payloadKeys": sorted(k for k in rows[0][1] if k in ("asAt", "worst", "briefLine")), "hist": len(hist[0])}))`);
    expect(r).toEqual({ code: 0, rows: 1, hasLights: false, payloadKeys: ['asAt', 'briefLine', 'worst'], hist: 20 });
  });

  it('a payment plan stuck waiting on bank data turns the row Blocked, and says why', () => {
    const r = py(`
rows = []
today = rc.today_london()
rc.load = lambda day: world([tenancy("rec%02d" % i, 1, 500) for i in range(20)], [paid("rec%02d" % i, today.isoformat(), 500) for i in range(20)],
                            day=today, feed=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
rc.write_row = lambda status, text, payload, now: rows.append([status, text])
rc.append_history = lambda *a, **k: None
rc.read_task_state = lambda: {"on": True, "status": "Built", "keys": {}}
rc.rent_plans.read = lambda *a, **k: {"plans": [{"id": "recPLANSTUCK0001", "tenancy": "rec00", "state": "waiting", "stuck": True,
                                                 "why": "still waiting on bank data 9 days after its last promise"}], "onTrack": {"rec00"}, "failed": ""}
with contextlib.redirect_stdout(io.StringIO()):
    code = rc.main(["run"])
print(json.dumps({"code": code, "status": rows[0][0], "line": next(l for l in rows[0][1].splitlines() if l.startswith("Payment plans"))}))`);
    expect(r.code).toBe(0);
    expect(r.status).toBe('Blocked');
    expect(r.line).toMatch(/Check: card recPLANSTUCK0001: still waiting on bank data 9 days after its last promise/);
  });

  it('a broken read writes a Failed row that Home reads as today, and exits 1', () => {
    const r = py(`
rows = []
def boom(day): raise RuntimeError("control failed: tenancies read returned 0 rows")
rc.load = boom
rc.write_row = lambda status, text, payload, now: rows.append([status, text, payload])
with contextlib.redirect_stdout(io.StringIO()):
    code = rc.main(["run"])
print(json.dumps({"code": code, "status": rows[0][0], "worst": rows[0][2]["worst"], "line": rows[0][2]["briefLine"], "asAt": rows[0][2]["asAt"] == rc.today_london().isoformat()}))`);
    expect(r.code).toBe(1);
    expect(r.status).toBe('Failed');
    expect(r.worst).toBe('fail');
    expect(r.line).toContain('The rent check could not run: control failed');
    expect(r.asAt).toBe(true);
  });
});

describe('rent-check: hardening from the independent review (2 Oct 2026)', () => {
  it('a dead bank feed never reads as everyone paying', () => {
    const r = py(`
day = date(2026, 10, 20)
ts = [tenancy("recX", 25, 500), tenancy("recY", 25, 500)]
tx = [paid("recX", "2026-08-25", 500), paid("recY", "2026-08-25", 500)]
dead, drows = run(ts, tx, day=day, feed="2026-09-20T11:00:00.000Z")
missed, mrows = run([tenancy("recX", 30, 500)], [paid("recX", "2026-08-30", 500)], feed="2026-09-30T20:30:00.000Z")
quiet, _ = run([tenancy("recX", 1, 500)], [paid("recX", "2026-10-01", 500)], feed="2026-09-28T11:00:00.000Z")
print(json.dumps({"paying": dead["paying"], "worst": dead["worst"], "counts": dead["counts"], "note": drows["recX"]["note"],
                  "missed": mrows["recX"]["note"], "quiet": [quiet["worst"], quiet["briefLine"]]}))`);
    expect(r.paying).toBe(0);
    expect(r.worst).toBe('fail');
    expect(r.counts).toEqual({ green: 0, amber: 0, red: 0, grey: 2 });
    expect(r.note).toBe('cannot tell: Main Bank bank feed last updated 722 hours ago');
    // One missed sync (40 hours) is enough.
    expect(r.missed).toBe('cannot tell: Main Bank bank feed last updated 40 hours ago');
    // A stale feed that hides nothing is still said, and is never an all-clear.
    expect(r.quiet[0]).toBe('warn');
    expect(r.quiet[1]).toContain('Check the bank feed: Main Bank bank feed last updated 98 hours ago.');
  });

  it('each tenancy is judged on its own rent account, and one with no payments on the oldest', () => {
    const r = py(`
accts = [rec("recA_main", {AC["alias"]: "Main Bank", AC["updated"]: "2026-10-02T11:00:00.000Z"}),
         rec("recA_side", {AC["alias"]: "Side Bank", AC["updated"]: "2026-09-11T11:00:00.000Z"}),
         rec("recA_none", {AC["alias"]: "No Time Bank"})]
ts = [tenancy("recMain", 30, 500), tenancy("recSide", 30, 500), tenancy("recNone", 30, 500), tenancy("recNew", 28, 500, start="2026-09-28")]
tx = [paid("recMain", "2026-08-30", 500), paid("recSide", "2026-08-30", 500, account="recA_side"), paid("recNone", "2026-08-30", 500, account="recA_none")]
res, rows = run(ts, tx, accounts=accts)
print(json.dumps({"main": rows["recMain"]["note"], "side": rows["recSide"]["note"], "none": rows["recNone"]["note"], "new": rows["recNew"]["note"],
                  "asAt": res["feed"]["asAt"]}))`);
    expect(r.main).toBe('late 2 days, due 30 Sep, last matched payment 30 Aug');
    expect(r.side).toBe('cannot tell: Side Bank bank feed last updated 506 hours ago');
    expect(r.none).toBe('cannot tell: No Time Bank has no bank feed time');
    // No payment read, so it could be paid into any rent account: every fault applies.
    expect(r.new).toBe('cannot tell: No Time Bank has no bank feed time; Side Bank bank feed last updated 506 hours ago');
    expect(r.asAt).toBe('11 Sep 12:00');
  });

  it('days late are counted to today even when the bank data stops yesterday', () => {
    const r = py(`
res, rows = run([tenancy("recX", 28, 500)], [paid("recX", "2026-08-28", 500)], hour=6, feed="2026-10-01T11:03:29.000Z")
print(json.dumps(rows["recX"]))`);
    expect(r.note).toBe('late 4 days, due 28 Sep, last matched payment 28 Aug');
  });

  it('the surge is 25% of the tenancies turning late within three days, no fewer', () => {
    const r = py(`
day = date(2026, 9, 27)
def mix(n_fresh):
    ts = [tenancy("recF%02d" % i, 25, 500) for i in range(n_fresh)] + [tenancy("recG%02d" % i, 1, 500) for i in range(63 - n_fresh)] + [tenancy("recFour", 23, 500)]
    tx = [paid("recF%02d" % i, "2026-08-25", 500) for i in range(n_fresh)] + [paid("recG%02d" % i, "2026-09-01", 500) for i in range(63 - n_fresh)] + [paid("recFour", "2026-08-23", 500)]
    res, rows = run(ts, tx, day=day)
    return res["counts"], rows["recFour"]["light"]
print(json.dumps({"fifteen": mix(15), "sixteen": mix(16)}))`);
    // 15 of 64 turning late is under the threshold: all late. At 16 the surge holds them, but not
    // the tenancy already 4 days late.
    expect(r.fifteen).toEqual([{ green: 48, amber: 16, red: 0, grey: 0 }, 'amber']);
    expect(r.sixteen).toEqual([{ green: 47, amber: 1, red: 0, grey: 16 }, 'amber']);
  });

  it('a tenancy the last run called late stays late through a surge', () => {
    const r = py(`
import tempfile
day = date(2026, 9, 27)
ts = [tenancy("rec%02d" % i, 25, 500) for i in range(63)] + [tenancy("recKnown", 25, 500, unit="Unit 9 – 6 Example Road")]
tx = [paid("rec%02d" % i, "2026-08-25", 500) for i in range(63)] + [paid("recKnown", "2026-08-25", 500)]
res, rows = run(ts, tx, day=day, lateBefore=["recKnown"])
log = os.path.join(tempfile.mkdtemp(), "history.jsonl")
open(log, "w").write(json.dumps({"day": "2026-09-26", "lanes": {"recA": "late", "recB": "fine"}}) + "\\n" + json.dumps({"day": "2026-09-27", "lanes": {"recKnown": "late", "recC": "short", "recD": "unknown"}}) + "\\n")
bad = os.path.join(tempfile.mkdtemp(), "history.jsonl"); open(bad, "w").write("{not json\\n")
print(json.dumps({"known": rows["recKnown"]["light"], "counts": res["counts"], "read": sorted(rc.read_late_before(day, log)),
                  "missing": sorted(rc.read_late_before(day, log + ".none")), "damaged": sorted(rc.read_late_before(day, bad)),
                  "threeDaysOn": sorted(rc.read_late_before(day + timedelta(days=3), log)), "fourDaysOn": sorted(rc.read_late_before(day + timedelta(days=4), log))}))`);
    expect(r.known).toBe('amber');
    expect(r.counts).toEqual({ green: 0, amber: 1, red: 0, grey: 63 });
    expect(r.read).toEqual(['recKnown']);
    expect([r.missing, r.damaged]).toEqual([[], []]);
    // A last run from weeks ago says nothing about who was late yesterday.
    expect([r.threeDaysOn, r.fourDaysOn]).toEqual([['recKnown'], []]);
  });

  it('a stray few pounds waiting does not hide a late tenancy, a quarter of the rent does', () => {
    const r = py(`
t, tx = [tenancy("recX", 30, 500)], [paid("recX", "2026-08-30", 500)]
stray, _ = run(t, tx, unmatched=[waiting("2026-10-01", 2.19)])
quarter, _ = run(t, tx, unmatched=[waiting("2026-10-01", 125)])
print(json.dumps({"stray": stray["lights"]["recX"], "quarter": quarter["lights"]["recX"]}))`);
    expect(r).toEqual({ stray: 'amber', quarter: 'grey' });
  });

  it('paid short is never said of rent not yet due, of money paid before the tenancy began, or of a split paid early', () => {
    const r = py(`
early, _ = run([tenancy("recX", 15, 900)], [paid("recX", "2026-09-15", 900), paid("recX", "2026-10-12", 200)], day=date(2026, 10, 13))
pre, _ = run([tenancy("recX", 15, 900, start="2026-10-01")], [paid("recX", "2026-09-28", 100)])
split, _ = run([tenancy("recX", 23, 900)], [paid("recX", "2026-08-23", 900), paid("recX", "2026-09-15", 500), paid("recX", "2026-09-24", 400)])
real, rrows = run([tenancy("recX", 23, 900)], [paid("recX", "2026-08-23", 900), paid("recX", "2026-09-24", 400)])
print(json.dumps({"early": early["lights"]["recX"], "pre": pre["lights"]["recX"], "split": split["lights"]["recX"], "real": rrows["recX"]["note"]}))`);
    expect([r.early, r.pre, r.split]).toEqual(['green', 'green', 'green']);
    expect(r.real).toBe('paid short: £400.00 of £900.00, last matched payment 24 Sep');
  });

  it('a short amount of £1,000 or more prints whole on the Home line', () => {
    const r = py(`
res, rows = run([tenancy("recX", 23, 1250.00, unit="Unit 9 – 7 Example Road")], [paid("recX", "2026-09-23", 1100.00)])
print(json.dumps({"line": res["briefLine"], "got": rows["recX"]["got"]}))`);
    expect(r.line).toContain('Paid short: Unit 9 – 7 Example Road (£1,100.00 of £1,250.00).');
    expect(r.got).toBe(1100);
  });

  it('a new cash flow void is amber until its first rent is late, and does not turn Home red', () => {
    const r = py(`
res, rows = run([tenancy("recNew", 15, 600, status="CFV", start="2026-10-01")] + [tenancy("recG%02d" % i, 1, 500) for i in range(20)],
                [paid("recG%02d" % i, "2026-10-01", 500) for i in range(20)])
print(json.dumps({"row": rows["recNew"], "worst": res["worst"], "paying": res["paying"], "below": res["belowFloor"]}))`);
    expect([r.row.light, r.row.lane]).toEqual(['amber', 'new']);
    expect(r.row.note).toBe('new tenant not in payment yet, day 1, first rent due 15 Oct, cash flow void');
    expect([r.worst, r.paying, r.below]).toEqual(['warn', 20, true]);
  });

  it('nothing matched in 80 days on an old tenancy is red with no invented day count', () => {
    const r = py(`
res, rows = run([tenancy("recX", 15, 500, unit="Unit 9 – 8 Example Road")], [])
print(json.dumps({"row": rows["recX"], "line": res["briefLine"]}))`);
    expect([r.row.light, r.row.lane, 'daysLate' in r.row]).toEqual(['red', 'late', false]);
    expect(r.line).toContain('Late: Unit 9 – 8 Example Road (no matched payment in the last 80 days).');
  });

  it('one red is a fail even above the floor', () => {
    const r = py(`
ts = [tenancy("recG%02d" % i, 1, 500) for i in range(79)] + [tenancy("recRed", 25, 500)]
res, rows = run(ts, [paid("recG%02d" % i, "2026-10-01", 500) for i in range(79)] + [paid("recRed", "2026-08-25", 500)])
print(json.dumps({"pct": res["pct"], "below": res["belowFloor"], "light": rows["recRed"]["light"], "worst": res["worst"]}))`);
    expect(r).toEqual({ pct: 98.8, below: false, light: 'red', worst: 'fail' });
  });

  it('the private list of existing voids in the wrong shape stops the run, an empty list is fine', () => {
    const r = py(`
import tempfile
out = {}
for name, body in (("string", {"tenancies": "recABC"}), ("numbers", {"tenancies": [1, 2]}), ("notIds", {"tenancies": ["5 Some Street"]}), ("empty", {"tenancies": []})):
    path = os.path.join(tempfile.mkdtemp(), "pre.json"); open(path, "w").write(json.dumps(body))
    try:
        out[name] = sorted(rc.read_pre_slate(path))
    except RuntimeError as e:
        out[name] = "refused"
print(json.dumps(out))`);
    expect(r).toEqual({ string: 'refused', numbers: 'refused', notIds: 'refused', empty: [] });
  });

  it('load() reads matched and unmatched money over the same 80 days, by field name', () => {
    const r = py(`
calls = []
def fake(table, params=None):
    calls.append([table, (params or {}).get("filterByFormula", "")])
    return [{"id": "recN", "fields": {}}] * 200
rc.fetch_all = fake
rc.read_pre_slate = lambda path=None: {"recP"}
rc.read_no_chase = lambda path=None: {"recN"}
rc.read_late_before = lambda day, path=None: {"recL"}
data = rc.load(date(2026, 10, 2))
print(json.dumps({"calls": calls, "pre": sorted(data["preSlate"]), "late": sorted(data["lateBefore"]), "noChase": sorted(data["noChase"])}))`);
    expect(r.noChase).toEqual(['recN']);
    // And load() itself refuses a list naming an id it did not read as a tenant.
    const bad = py(`
rc.fetch_all = lambda table, params=None: [{"id": "recN", "fields": {}}] * 200
rc.read_pre_slate = lambda path=None: set()
rc.read_no_chase = lambda path=None: {"recZ"}
rc.read_late_before = lambda day, path=None: set()
try: rc.load(date(2026, 10, 2)); out = "passed"
except RuntimeError as e: out = str(e)[:48]
print(json.dumps(out))`);
    expect(bad).toBe('control failed: 1 id on the do-not-chase list (n');
    const formulas = r.calls.map(c => c[1]).filter(Boolean);
    expect(formulas).toEqual([
      "AND({Reconciled}, {Tenancy}!='', IS_AFTER({**Date}, '2026-07-14'))",
      "AND(NOT({Reconciled}), {Report Amount}>0, IS_AFTER({**Date}, '2026-07-14'))",
    ]);
    expect(r.calls.length).toBe(5);
    expect([r.pre, r.late]).toEqual([['recP'], ['recL']]);
  });
});

describe('rent-check: third review pass (2 Oct 2026)', () => {
  it('a real run records who was late, and the next run reads it back', () => {
    const r = py(`
today = rc.today_london()
due = (today - timedelta(days=3)).day
ts = [tenancy("recLate", due, 500)] + [tenancy("recG%02d" % i, due, 500) for i in range(20)]
month_ago = today - timedelta(days=34)
tx = [paid("recLate", month_ago.isoformat(), 500)] + [paid("recG%02d" % i, (today - timedelta(days=3)).isoformat(), 500) for i in range(20)]
rc.load = lambda day: world(ts, tx, day=today, feed=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
rc.write_row = lambda status, text, payload, now: None
with contextlib.redirect_stdout(io.StringIO()):
    code = rc.main(["run"])
print(json.dumps({"code": code, "readBack": sorted(rc.read_late_before(today)), "inScratch": rc.HISTORY.startswith(SCRATCH)}))`);
    expect(r).toEqual({ code: 0, readBack: ['recLate'], inScratch: true });
  });

  it('the row is Blocked when the bank data hid a verdict, Worked when the only grey is a data gap', () => {
    const r = py(`
today = rc.today_london()
out = {}
def go(name, extra, feed):
    rows = []
    rc.load = lambda day: world([tenancy("recG%02d" % i, 1, 500) for i in range(20)] + extra, [], day=today, feed=feed)
    rc.write_row = lambda status, text, payload, now: rows.append(status)
    rc.append_history = lambda res, now: None
    with contextlib.redirect_stdout(io.StringIO()):
        rc.main(["run"])
    out[name] = rows[0]
gap = tenancy("recGap", 1, 500); gap["fields"][TY["dueDay"]] = None
fresh = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
stale = (datetime.now(timezone.utc) - timedelta(hours=60)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
go("gapOnly", [gap], fresh)
go("staleFeed", [], stale)
print(json.dumps(out))`);
    // Twenty old tenancies with nothing matched: plain late on a fresh feed, cannot tell on a stale one.
    expect(r).toEqual({ gapOnly: 'Worked', staleFeed: 'Blocked' });
  });

  it('a tenancy paid into two accounts is judged on the older feed, and one with no payments on the oldest of all', () => {
    const r = py(`
accts = [rec("recA_main", {AC["alias"]: "Main Bank", AC["updated"]: "2026-10-02T11:00:00.000Z"}),
         rec("recA_side", {AC["alias"]: "Side Bank", AC["updated"]: "2026-10-01T11:00:00.000Z"})]
ts = [tenancy("recBoth", 30, 500), tenancy("recMain", 30, 500), tenancy("recNew", 30, 500, start="2026-09-28")]
tx = [paid("recBoth", "2026-08-29", 250), paid("recBoth", "2026-08-30", 250, account="recA_side"), paid("recMain", "2026-08-30", 500),
      paid("recKeep", "2026-09-20", 500, account="recA_side")]
res, rows = run(ts, tx, accounts=accts)
print(json.dumps({"lights": res["lights"], "asAt": res["feed"]["asAt"]}))`);
    // Due 30 Sep. Main Bank's data runs to 2 Oct (late), Side Bank's to 1 Oct (not yet).
    expect(r.lights).toEqual({ recBoth: 'green', recMain: 'amber', recNew: 'green' });
    expect(r.asAt).toBe('1 Oct 12:00');
  });

  it('paid short is not said on a stale feed, and money paid before the tenancy began is not weighed with the first cycle', () => {
    const r = py(`
stale, _ = run([tenancy("recX", 23, 900)], [paid("recX", "2026-09-23", 400)], feed="2026-09-29T11:00:00.000Z")
fresh, frows = run([tenancy("recX", 23, 900)], [paid("recX", "2026-09-23", 400)])
pre, prows = run([tenancy("recX", 23, 900, start="2026-09-01")], [paid("recX", "2026-08-20", 1400), paid("recX", "2026-09-23", 400)])
print(json.dumps({"stale": [stale["lights"]["recX"], stale["worst"]], "fresh": frows["recX"]["lane"], "pre": prows["recX"]["note"]}))`);
    expect(r.stale).toEqual(['green', 'warn']);
    expect(r.fresh).toBe('short');
    expect(r.pre).toBe('paid short: £400.00 of £900.00, last matched payment 23 Sep');
  });

  it('a paid-up tenancy still marked as a void is not called late on a stale feed or before its rent is due', () => {
    const r = py(`
day = date(2026, 10, 18)
stale, srows = run([tenancy("recV", 15, 900, status="CFV")], [paid("recV", "2026-09-15", 900)], day=day, feed="2026-10-10T11:00:00.000Z")
early, erows = run([tenancy("recV", 15, 900, status="CFV Actioned")], [paid("recV", "2026-09-15", 900), paid("recV", "2026-10-12", 200)], day=date(2026, 10, 13))
due, drows = run([tenancy("recV", 15, 900, status="CFV Actioned")], [paid("recV", "2026-09-15", 900), paid("recV", "2026-10-12", 200)], day=date(2026, 10, 17))
print(json.dumps({"stale": [srows["recV"]["light"], srows["recV"]["note"]], "early": erows["recV"]["note"], "due": drows["recV"]["note"]}))`);
    expect(r.stale).toEqual(['grey', 'cannot tell: Main Bank bank feed last updated 194 hours ago']);
    expect(r.early).toBe('paid in full (last matched payment 12 Oct), still marked cash flow void actioned');
    expect(r.due).toBe('cash flow void actioned, last matched payment 12 Oct, part payment £200.00 of £900.00');
  });

  it('a stale feed is said on the Home line even when another tenancy is grey for a data gap', () => {
    const r = py(`
gap = tenancy("recGap", 1, 500); gap["fields"][TY["dueDay"]] = None
res, rows = run([gap, tenancy("recX", 1, 500)], [paid("recX", "2026-10-01", 500)], feed="2026-09-28T11:00:00.000Z")
print(json.dumps({"line": res["briefLine"], "blocked": res["bankBlocked"]}))`);
    expect(r.blocked).toBe(false);
    expect(r.line).toContain('Cannot tell for 1: the tenancy has no due day.');
    expect(r.line).toContain('Check the bank feed: Main Bank bank feed last updated 98 hours ago.');
  });

  it('a regular short payer stays amber on the day after paying, when the newest cycle is not yet covered', () => {
    const r = py(`
out = {}
for day in (date(2026, 9, 22), date(2026, 9, 24), date(2026, 9, 26)):
    res, rows = run([tenancy("recX", 23, 900)], [paid("recX", "2026-07-23", 839), paid("recX", "2026-08-23", 839)] + ([paid("recX", "2026-09-23", 839)] if day.day > 22 else []), day=day)
    out[day.isoformat()] = rows["recX"]["note"] if "recX" in rows else res["lights"]["recX"]
print(json.dumps(out))`);
    // Each cycle's money is its own: September's payment never tops up August.
    expect(r['2026-09-22']).toBe('paid short: £839.00 of £900.00, last matched payment 23 Aug');
    expect(r['2026-09-24']).toBe('paid short: £839.00 of £900.00, last matched payment 23 Sep');
    expect(r['2026-09-26']).toBe('paid short: £839.00 of £900.00, last matched payment 23 Sep');
  });

  it('a bank feed stamped in the future is never judged a day ahead of today', () => {
    const r = py(`
res, rows = run([tenancy("recX", 1, 500)], [paid("recX", "2026-09-01", 500)], feed="2026-10-03T11:00:00.000Z")
print(json.dumps({"light": res["lights"]["recX"]}))`);
    // Due 1 Oct, checked 2 Oct: one day, not late, whatever the feed's stamp says.
    expect(r.light).toBe('green');
  });
});

describe('rent-check: lane A, one task per late tenancy per stage (2 Oct 2026)', () => {
  it('first contact is always the reminder; the follow-up waits 3 days after it, the firmer message 4 days after that', () => {
    const r = py(`
c = "recT:2026-09-30"
d = date(2026, 10, 2)
def nxt(existing, day): return rc.next_stage(c, {k: date.fromisoformat(v) for k, v in existing.items()}, day)
print(json.dumps({
  "none": nxt({}, d),
  "sameDay": nxt({c + ":1": "2026-10-02"}, d),
  "twoDays": nxt({c + ":1": "2026-10-02"}, date(2026, 10, 4)),
  "threeDays": nxt({c + ":1": "2026-10-02"}, date(2026, 10, 5)),
  "afterFollowUp3": nxt({c + ":1": "2026-10-02", c + ":2": "2026-10-05"}, date(2026, 10, 8)),
  "afterFollowUp4": nxt({c + ":1": "2026-10-02", c + ":2": "2026-10-05"}, date(2026, 10, 9)),
  "allDone": nxt({c + ":1": "2026-10-02", c + ":2": "2026-10-05", c + ":3": "2026-10-09"}, date(2026, 11, 20)),
  "otherCycle": nxt({"recT:2026-08-30:3": "2026-09-09"}, d),
}))`);
    expect(r).toEqual({ none: 1, sameDay: null, twoDays: null, threeDays: 2, afterFollowUp3: null, afterFollowUp4: 3, allDone: null, otherCycle: 1 });
  });

  it('raises for a late tenancy we chase ourselves, and for nobody else', () => {
    const r = py(`
ts = [tenancy("recLate", 30, 500, unit="Unit 9 – 1 Example Road"),
      tenancy("recAgent", 30, 500, tenant="recT_agent"),
      tenancy("recExisting", 30, 500, status="CFV"),
      tenancy("recActioned", 30, 500, status="CFV Actioned"),
      tenancy("recVoid", 30, 500, status="CFV", unit="Unit 9 – 2 Example Road"),
      tenancy("recShort", 23, 900), tenancy("recFine", 1, 500),
      tenancy("recGap", 1, 500)]
ts[-1]["fields"][TY["dueDay"]] = None
tx = [paid(i, "2026-08-30", 500) for i in ("recLate", "recAgent", "recExisting", "recActioned", "recVoid")] + [paid("recShort", "2026-09-23", 400), paid("recFine", "2026-10-01", 500)]
res, rows = run(ts, tx, pre=["recExisting"])
plan = rc.task_plan(res, ts, {}, DAY)
print(json.dumps({"lanes": {k: v["lane"] for k, v in rows.items()}, "plan": [[p["tenancy"], p["key"], p["name"], p["tenants"]] for p in plan], "desc": plan[0]["description"]}))`);
    expect(r.lanes).toMatchObject({ recLate: 'late', recAgent: 'late', recExisting: 'existing', recActioned: 'late', recVoid: 'late', recShort: 'short', recGap: 'unknown' });
    expect(r.plan).toEqual([
      ['recVoid', 'recVoid:2026-09-30:1', 'RENT LATE: Unit 9 – 2 Example Road, rent due 30 Sep (reminder)', ['recT_uc']],
      ['recLate', 'recLate:2026-09-30:1', 'RENT LATE: Unit 9 – 1 Example Road, rent due 30 Sep (reminder)', ['recT_uc']],
    ]);
    expect(r.desc).toContain('TRIAL: you draft, Kevin checks, nothing is sent to the tenant.');
    expect(r.desc).toContain('Rent owed: the payment due 30 Sep 2026, 2 days late today');
    expect(r.desc).toContain('Stage: 1 of 3, the reminder');
    expect(r.desc).toContain('Bank data as at 2 Oct 12:03.');
    // The key is carried in the description as well as the Notes, so losing one cannot raise a twin.
    expect(r.desc.split('\n').pop()).toBe('RENT CHECK KEY: recVoid:2026-09-30:1');
  });

  it('a cash flow void that has paid part of rent not yet due gets no task', () => {
    const r = py(`
day = date(2026, 10, 20)
ts = [tenancy("recPart", 15, 900, status="CFV")]
res, rows = run(ts, [paid("recPart", "2026-09-15", 900), paid("recPart", "2026-10-12", 200)], day=day)
print(json.dumps({"row": [rows["recPart"]["lane"], "daysLate" in rows["recPart"], rows["recPart"]["note"]], "plan": rc.task_plan(res, ts, {}, day)}))`);
    expect(r.row).toEqual(['late', false, 'cash flow void, last matched payment 12 Oct, part payment £200.00 of £900.00']);
    expect(r.plan).toEqual([]);
  });

  it('nothing is raised when the check cannot tell', () => {
    const r = py(`
ts = [tenancy("recLate", 30, 500)]
res, rows = run(ts, [paid("recLate", "2026-08-30", 500)], hour=6, feed="2026-09-30T05:00:00.000Z")
print(json.dumps({"light": rows["recLate"]["light"], "plan": rc.task_plan(res, ts, {}, DAY)}))`);
    expect(r).toEqual({ light: 'grey', plan: [] });
  });

  it('one task per owed payment per stage: a repeat run raises nothing, and a tenancy first seen 9 days late still starts with the reminder', () => {
    const r = py(`
ts = [tenancy("recLate", 30, 500)]
tx = [paid("recLate", "2026-08-30", 500)]
def keys(day, existing):
    res, rows = run(ts, tx, day=day)
    return [p["key"] for p in rc.task_plan(res, ts, {k: date.fromisoformat(v) for k, v in existing.items()}, day)]
k = "recLate:2026-09-30:"
print(json.dumps({
  "first": keys(date(2026, 10, 2), {}),
  "again": keys(date(2026, 10, 2), {k + "1": "2026-10-02"}),
  "day4": keys(date(2026, 10, 4), {k + "1": "2026-10-02"}),
  "day5": keys(date(2026, 10, 5), {k + "1": "2026-10-02"}),
  "day9": keys(date(2026, 10, 9), {k + "1": "2026-10-02", k + "2": "2026-10-05"}),
  "firstSeenLate": keys(date(2026, 10, 9), {}),
  "nextMonth": keys(date(2026, 11, 1), {k + "1": "2026-10-02", k + "2": "2026-10-05", k + "3": "2026-10-09"}),
}))`);
    expect(r.first).toEqual(['recLate:2026-09-30:1']);
    expect(r.again).toEqual([]);
    expect(r.day4).toEqual([]);
    expect(r.day5).toEqual(['recLate:2026-09-30:2']);
    expect(r.day9).toEqual(['recLate:2026-09-30:3']);
    expect(r.firstSeenLate).toEqual(['recLate:2026-09-30:1']);
    // Still unpaid a month on: the same owed payment, already at its last stage, raises nothing new.
    expect(r.nextMonth).toEqual([]);
  });

  it('nothing matched in 80 days is raised as a reminder that says so', () => {
    const r = py(`
ts = [tenancy("recX", 15, 500)]
res, rows = run(ts, [])
plan = rc.task_plan(res, ts, {}, DAY)
print(json.dumps({"beyond": rows["recX"].get("beyond"), "key": plan[0]["key"].split(":")[-1], "desc": plan[0]["description"]}))`);
    expect(r.beyond).toBe(true);
    expect(r.key).toBe('1');
    expect(r.desc).toContain('no payment matched in the last 80 days');
  });

  it('a late agent-managed tenancy gives Roy one task per owed payment, emailed, and nobody else; never a tenant message', () => {
    const r = py(`
ts = [tenancy("recAgent", 30, 500, tenant="recT_agent", unit="Unit 9 – 1 Example Road"),
      tenancy("recAgentFine", 1, 500, tenant="recT_agent"),
      tenancy("recAgentVoid", 30, 500, tenant="recT_agent", status="CFV"),
      tenancy("recLate", 30, 500),
      tenancy("recAgentNoUnit", 30, 500, tenant="recT_agent", unitRef=None)]
ts[-1]["fields"][TY["unitRef"]] = []
ts[-1]["fields"][TY["surname"]] = "Sample"
tx = [paid(i, "2026-08-30", 500) for i in ("recAgent", "recAgentVoid", "recLate", "recAgentNoUnit")] + [paid("recAgentFine", "2026-10-01", 500)]
res, rows = run(ts, tx)
plan = rc.agent_late_plan(res, ts, {}, DAY)
again = rc.agent_late_plan(res, ts, {"recAgent:2026-09-30": {"id": "recOLD", "status": "Completed"}}, DAY)
lane_a = [p["tenancy"] for p in rc.task_plan(res, ts, {}, DAY)]
res2, _ = run(ts, tx, noChase=["recT_agent"])
quiet = rc.agent_late_plan(res2, ts, {}, DAY)
print(json.dumps({"plan": sorted([p["tenancy"], p["key"], p["name"]] for p in plan), "again": [p["tenancy"] for p in again],
                  "laneA": lane_a, "quiet": quiet, "desc": [p for p in plan if p["tenancy"] == "recAgent"][0]["description"],
                  "noUnitDesc": [p for p in plan if p["tenancy"] == "recAgentNoUnit"][0]["description"]}))`);
    expect(r.plan).toEqual([
      ['recAgent', 'recAgent:2026-09-30', 'AGENT RENT LATE: Unit 9 – 1 Example Road, rent due 30 Sep'],
      // No unit linked: the surname never reaches a task name.
      ['recAgentNoUnit', 'recAgentNoUnit:2026-09-30', 'AGENT RENT LATE: a tenancy with no unit linked, rent due 30 Sep'],
      // A late agent-managed cash flow void: the agent holds this rent too.
      ['recAgentVoid', 'recAgentVoid:2026-09-30', 'AGENT RENT LATE: Unit recAgentVoid, rent due 30 Sep'],
    ]);
    // One task per owed payment: a task for it already exists (even closed), so none again.
    expect(r.again.sort()).toEqual(['recAgentNoUnit', 'recAgentVoid']);
    // Lane A still never chases an agent-managed tenant.
    expect(r.laneA).toEqual(['recLate']);
    expect(r.quiet).toEqual([]);
    expect(r.desc).toContain('the letting agent collects this rent');
    expect(r.desc).toContain('RENT AGENT KEY: recAgent:2026-09-30');
    expect(r.noUnitDesc).not.toMatch(/Sample/);
  });

  it('the letting-agent tasks are found by name or by their key line (a task renamed by hand is still found), never by an empty read', () => {
    const r = py(`
seen = []
def fetch_all(table, params):
    seen.append(params["filterByFormula"])
    return [{"id": "recRENAMED000001", "fields": {rc.TK["name"]: "Ask the agent about Unit 9", rc.TK["status"]: "Today",
             rc.TK["notes"]: "x\\nRENT AGENT KEY: recAgent:2026-09-30", rc.TK["description"]: ""}}]
rc.fetch_all = fetch_all
spec2 = importlib.util.spec_from_file_location("rc2", os.path.join(${JSON.stringify(SCRIPTS)}, "rent-check.py"))
rc2 = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(rc2)
rc2.fetch_all = fetch_all
print(json.dumps({"found": rc2.read_agent_late(), "formula": seen[-1]}))`);
    expect(r.found).toEqual({ 'recAgent:2026-09-30': { id: 'recRENAMED000001', status: 'Today', sent: null } });
    expect(r.formula).toContain("FIND('RENT AGENT KEY: ', {Notes}&'')");
    expect(r.formula).toContain("LEFT({Task Name}, 17)='AGENT RENT LATE: '");
  });

  it('the letting-agent chase (Kevin, 5 Oct 2026): first email, a second 3 days after it went, Roy 4 days after that; each step waits for the one before', () => {
    const r = py(`
ts = [tenancy("recAgent", 30, 500, tenant="recT_agent", unit="Unit 9 – 1 Example Road")]
res, rows = run(ts, [paid("recAgent", "2026-08-30", 500)])
B = "recAgent:2026-09-30"
def steps(existing, day=DAY): return [[p["step"], p["key"], p["name"]] for p in rc.agent_late_plan(res, ts, existing, day)]
first = lambda status="Completed", sent=DAY - timedelta(days=3): {"id": "recA1", "status": status, "sent": sent}
second = lambda status="Completed", sent=DAY - timedelta(days=4): {"id": "recA2", "status": status, "sent": sent}
roy_plan = rc.agent_late_plan(res, ts, {B: first(sent=DAY - timedelta(days=8)), B + ":2": second()}, DAY)
print(json.dumps({
  "none": steps({}),
  "withKevin": steps({B: first(status="Approval", sent=None)}),
  "tooSoon": steps({B: first(sent=DAY - timedelta(days=2))}),
  "second": steps({B: first()}),
  "noSend": steps({B: first(sent=None)}),
  "turnedDown": steps({B: first(status="Cancelled", sent=None)}),
  "secondWithKevin": steps({B: first(sent=DAY - timedelta(days=8)), B + ":2": second(status="Approval", sent=None)}),
  "royTooSoon": steps({B: first(sent=DAY - timedelta(days=6)), B + ":2": second(sent=DAY - timedelta(days=3))}),
  "roy": [[p["step"], p["key"]] for p in roy_plan], "royDesc": roy_plan[0]["description"] if roy_plan else "",
  "secondTurnedDown": steps({B: first(sent=DAY - timedelta(days=8)), B + ":2": second(status="Cancelled", sent=None)}),
  "royDone": steps({B: first(sent=DAY - timedelta(days=12)), B + ":2": second(sent=DAY - timedelta(days=8)), B + ":roy": {"id": "recR", "status": "Completed", "sent": None}}),
  "paid": [p["key"] for p in rc.agent_late_plan(run(ts, [paid("recAgent", "2026-09-30", 500)])[0], ts, {B: first()}, DAY)],
}))`);
    expect(r.none).toEqual([['1', 'recAgent:2026-09-30', 'AGENT RENT LATE: Unit 9 – 1 Example Road, rent due 30 Sep']]);
    expect(r.withKevin).toEqual([]);
    expect(r.tooSoon).toEqual([]);
    expect(r.second).toEqual([['2', 'recAgent:2026-09-30:2', 'AGENT RENT LATE: Unit 9 – 1 Example Road, rent due 30 Sep (second email)']]);
    // Closed with nothing sent (a refusal at the send door), or turned down by Kevin: no second email.
    expect(r.noSend).toEqual([]);
    expect(r.turnedDown).toEqual([]);
    expect(r.secondWithKevin).toEqual([]);
    expect(r.royTooSoon).toEqual([]);
    expect(r.roy).toEqual([['roy', 'recAgent:2026-09-30:roy']]);
    expect(r.royDesc).toContain('Please phone them');
    expect(r.secondTurnedDown).toEqual([]);
    expect(r.royDone).toEqual([]);
    // The rent arrived: nothing at all.
    expect(r.paid).toEqual([]);
  });

  it('a lane A task for a tenancy with no unit linked never carries the surname in its name', () => {
    const r = py(`
ts = [tenancy("recNoUnit", 30, 500)]
ts[0]["fields"][TY["unitRef"]] = []
ts[0]["fields"][TY["surname"]] = "Sample"
res, rows = run(ts, [paid("recNoUnit", "2026-08-30", 500)])
print(json.dumps([p["name"] for p in rc.task_plan(res, ts, {}, DAY)]))`);
    expect(r).toEqual(['RENT LATE: a tenancy with no unit linked, rent due 30 Sep (reminder)']);
  });

  it('the first email is the agent\'s card, never Roy\'s and never emailed to him; an open Roy step is offered again; switched off or dry, nothing is written', () => {
    const r = py(`
ts = [tenancy("recAgent", 30, 500, tenant="recT_agent", unit="Unit 9 – 1 Example Road")]
res, rows = run(ts, [paid("recAgent", "2026-08-30", 500)])
posts, mailed = [], []
rc.api = lambda method, path, payload=None, params=None: posts.append(payload["records"][0]["fields"]) or {"records": [{"id": "recNEWROY0000001"}]}
class FakeAd:
    ROY_EMAIL = "roy@example.test"
    HUMANS = {"roy@example.test": {"rec": "recROYROW0000001"}}
    AF = {"assignee": "fldASSIGNEE000001"}
rc.lane_b_rules.module = lambda key: FakeAd
rc.lane_b_rules.notify_roy = lambda tid, to: mailed.append([tid, to]) or {"notified": tid}
off = rc.agent_late(res, ts, DAY, True, False)
dry = rc.agent_late(res, ts, DAY, False, True)
written_dry = [len(posts), len(mailed)]
rc.read_agent_late = lambda: {"recOther:2026-09-01:roy": {"id": "recOPENROY000001", "status": "Today", "sent": None},
                              "recOther:2026-09-01": {"id": "recOPENAGENT0001", "status": "Today", "sent": None}}
on = rc.agent_late(res, ts, DAY, True, True)
print(json.dumps({"off": [off["raised"], rc.agent_late_line(off)], "dry": [dry["planned"], written_dry, rc.agent_late_line(dry)],
                  "on": on["raised"], "owner": posts[0][rc.TK["teamMember"]], "assignee": posts[0].get("fldASSIGNEE000001"),
                  "key": posts[0][rc.TK["notes"]], "desc": posts[0][rc.TK["description"]], "mailed": mailed, "line": rc.agent_late_line(on)}))`);
    expect(r.off[0]).toEqual([]);
    expect(r.off[1]).toMatch(/switched off/);
    expect(r.dry[0]).toEqual(['AGENT RENT LATE: Unit 9 – 1 Example Road, rent due 30 Sep']);
    expect(r.dry[1]).toEqual([0, 0]);
    expect(r.dry[2]).toMatch(/^Agent-managed late rent a real run would raise: AGENT RENT LATE/);
    expect(r.on).toEqual(['AGENT RENT LATE: Unit 9 – 1 Example Road, rent due 30 Sep']);
    // Kevin, 5 Oct 2026: "Anything administrative, the AI agent can do." The agent's card, nobody assigned.
    expect(r.owner).toEqual(['rec7aHLK1Q8fMLRXH']);
    expect(r.assignee).toBeNull();
    expect(r.key).toBe('RENT AGENT KEY: recAgent:2026-09-30');
    expect(r.desc).toContain('It goes from kevinbrittain@gmail.com, signed Kevin Brittain');
    // Only the open ROY step is offered to his email again (its ledger never sends a second copy); the agent's card never.
    expect(r.mailed).toEqual([['recOPENROY000001', 'roy@example.test']]);
    expect(r.line).toMatch(/^Agent-managed late rent raised: AGENT RENT LATE: Unit 9/);
  });

  it('at the Roy step, an email to Roy that fails turns the run red (the task stands and is offered again); a refusal by the email gate is a note', () => {
    const r = py(`
ts = [tenancy("recAgent", 30, 500, tenant="recT_agent", unit="Unit 9 – 1 Example Road")]
res, rows = run(ts, [paid("recAgent", "2026-08-30", 500)])
from datetime import date as _d
TWO = {"recAgent:2026-09-30": {"id": "recFIRST00000001", "status": "Completed", "sent": DAY - timedelta(days=9)},
       "recAgent:2026-09-30:2": {"id": "recSECOND0000001", "status": "Completed", "sent": DAY - timedelta(days=5)}}
rc.read_agent_late = lambda: dict(TWO)
rc.api = lambda method, path, payload=None, params=None: {"records": [{"id": "recNEWROY0000001"}]}
class FakeAd:
    ROY_EMAIL = "roy@example.test"
    HUMANS = {"roy@example.test": {"rec": "recROYROW0000001"}}
    AF = {"assignee": "fldASSIGNEE000001"}
rc.lane_b_rules.module = lambda key: FakeAd
def broken(tid, to): raise RuntimeError("worker 500")
rc.lane_b_rules.notify_roy = broken
failed = rc.agent_late(res, ts, DAY, True, True)
def refused(tid, to): raise RuntimeError("REFUSED: a word in the task")
rc.lane_b_rules.notify_roy = refused
rc.read_agent_late = lambda: dict(TWO, **{"recAgent:2026-09-30:roy": {"id": "recOPENROY000001", "status": "Today", "sent": None}})
noted = rc.agent_late(res, ts, DAY, True, True)
rc.read_agent_late = lambda: dict(TWO)
fresh = rc.agent_late(res, ts, DAY, True, True)
print(json.dumps({"failed": failed["failed"], "line": rc.agent_late_line(failed), "noted": [noted["failed"], noted["problems"]],
                  "fresh": [fresh["failed"], fresh["problems"], fresh["raised"]]}))`);
    expect(r.failed).toMatch(/was created but its email to Roy failed \(offered again next run\): worker 500/);
    expect(r.line).toMatch(/^Agent-managed late rent FAILED/);
    expect(r.noted[0]).toBe('');
    expect(r.noted[1][0]).toMatch(/refused by the email gate/);
    // A refusal on the day the task is raised reads the same: a note, never red, and the task stands.
    expect(r.fresh[0]).toBe('');
    expect(r.fresh[1]).toEqual([expect.stringMatching(/task recNEWROY0000001 was refused by the email gate/)]);
    expect(r.fresh[2]).toHaveLength(1);
  });

  it('the pause lever: nothing is planned or raised while the agent is switched off, and the row says so', () => {
    const r = py(`
ts = [tenancy("recLate", 30, 500)]
res, rows = run(ts, [paid("recLate", "2026-08-30", 500)])
made = []
rc.raise_task = lambda item, day: made.append(item["key"]) or "recNEW"
off = rc.lane_a(res, ts, DAY, True)
rc.read_task_state = lambda: {"on": True, "status": "Built", "keys": {}}
dry = rc.lane_a(res, ts, DAY, False)
on = rc.lane_a(res, ts, DAY, True)
rc.read_task_state = lambda: {"on": True, "status": "Built", "keys": {"recLate:2026-09-30:1": DAY}}
done = rc.lane_a(res, ts, DAY, True)
print(json.dumps({"off": off, "offLine": rc.lane_a_line(off), "dryRaised": dry["raised"], "dryPlanned": len(dry["planned"]), "dryLine": rc.lane_a_line(dry),
                  "on": on["raised"], "made": made, "onLine": rc.lane_a_line(on), "doneLine": rc.lane_a_line(done)}))`);
    expect(r.off).toEqual({ on: false, status: 'Building', raised: [], planned: [], failed: '' });
    expect(r.offLine).toBe('Late-rent tasks: none raised, the Cash Flow Voids agent is switched off (register status Building).');
    expect([r.dryRaised, r.dryPlanned]).toEqual([[], 1]);
    expect(r.dryLine).toMatch(/^Late-rent tasks a real run would raise: RENT LATE: Unit recLate/);
    expect(r.on).toEqual(['RENT LATE: Unit recLate, rent due 30 Sep (reminder)']);
    expect(r.made).toEqual(['recLate:2026-09-30:1']);
    expect(r.onLine).toMatch(/^Late-rent tasks raised for the agent \(trial, nothing is sent\): RENT LATE/);
    expect(r.doneLine).toBe('Late-rent tasks: none needed today.');
  });

  it('a task is created for the agent with its key, its links and no "void" in the name', () => {
    const r = py(`
posts = []
rc.api = lambda method, path, payload=None, params=None: posts.append([method, path, payload]) or {"records": [{"id": "recNEW"}]}
rid = rc.raise_task({"key": "recLate:2026-09-30:1", "tenancy": "recLate", "tenants": ["recT_uc"], "name": "RENT LATE: Unit 9, rent due 30 Sep (reminder)", "description": "d"}, DAY)
f = posts[0][2]["records"][0]["fields"]
print(json.dumps({"rid": rid, "method": posts[0][0], "table": posts[0][1], "name": f[rc.TK["name"]], "status": f[rc.TK["status"]], "due": f[rc.TK["due"]],
                  "tm": f[rc.TK["teamMember"]], "notes": f[rc.TK["notes"]], "tenancies": f[rc.TK["tenancies"]], "tenants": f[rc.TK["tenants"]], "count": len(posts)}))`);
    expect(r).toEqual({ rid: 'recNEW', method: 'POST', table: 'tblqB8b22hKBL4PF1', name: 'RENT LATE: Unit 9, rent due 30 Sep (reminder)', status: 'Today', due: '2026-10-02',
      tm: ['rec7aHLK1Q8fMLRXH'], notes: 'RENT CHECK KEY: recLate:2026-09-30:1', tenancies: ['recLate'], tenants: ['recT_uc'], count: 1 });
  });

  it('the select-field control reads the base schema through the same retrying call, and fails loudly on a missing field', () => {
    const r = py(`
import io, urllib.error
seen, sleeps = [], []
class Resp(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False
SCHEMA = {"tables": [{"id": "tblX4elTuu01gwBYh", "fields": [{"id": "fldOOi3d1P4vDedm6", "options": {"choices": [{"name": "LCWRA"}, {"name": "None (capped)"}]}}]}]}
def fake_open(req, timeout=None):
    seen.append(req.full_url)
    if len(seen) == 1:
        raise urllib.error.HTTPError(req.full_url, 429, "slow down", {}, io.BytesIO(b"{}"))
    return Resp(json.dumps(SCHEMA).encode())
rc.urllib.request.urlopen = fake_open
rc._pat = lambda: "x"
rc.time.sleep = lambda s: sleeps.append(s)
got = rc.field_choices("tblX4elTuu01gwBYh", "fldOOi3d1P4vDedm6")
try:
    rc.field_choices("tblX4elTuu01gwBYh", "fldMISSING00000")
    missing = "passed"
except RuntimeError as e:
    missing = str(e)
print(json.dumps({"got": got, "urls": sorted(set(seen)), "retried": len(sleeps), "missing": missing}))`);
    expect(r.got).toEqual(['LCWRA', 'None (capped)']);
    expect(r.urls).toEqual(['https://api.airtable.com/v0/meta/bases/appnqjDpqDniH3IRl/tables']);
    expect(r.retried).toBe(1);
    expect(r.missing).toMatch(/control failed: field fldMISSING00000 is not in table tblX4elTuu01gwBYh/);
  });

  it('the task state reads the pause lever, and each key with the day it was raised, from Notes or the description', () => {
    const r = py(`
import importlib
def state(status):
    calls = []
    def fake_api(method, path, payload=None, params=None):
        calls.append((params or {}).get("filterByFormula", ""))
        if path == rc.T_REGISTER:
            return {"records": [{"id": rc.REGISTER_ROW, "fields": {rc.REGISTER_STATUS: status}}]}
        return {"records": [{"id": "recT1", "createdTime": "2026-10-02T06:30:10.000Z", "fields": {rc.TK["notes"]: "RENT CHECK KEY: recLate:2026-09-30:1\\n\\n[note] TRIAL CHECKED: ..."}},
                            {"id": "recT2", "createdTime": "2026-10-05T06:30:10.000Z", "fields": {rc.TK["description"]: "Late rent...\\n\\nRENT CHECK KEY: recLate:2026-09-30:2"}},
                            {"id": "recT3", "createdTime": "2026-10-06T06:30:10.000Z", "fields": {}}]}
    spec = importlib.util.spec_from_file_location("rc2", os.path.join(${JSON.stringify(SCRIPTS)}, "rent-check.py"))
    rc2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc2)
    rc2.api = fake_api
    st = rc2.read_task_state()
    return rc2, st, calls
rc2, live, calls = state("Live")
_, built, _ = state("Built")
_, building, _ = state("Building")
_, paused, _ = state("Paused")
def broken(method, path, payload=None, params=None): return {"records": []}
rc2.api = broken
try:
    rc2.read_task_state(); unread = "passed"
except RuntimeError as e:
    unread = str(e)
print(json.dumps({"on": [live["on"], built["on"], building["on"], paused["on"]], "keys": {k: v.isoformat() for k, v in live["keys"].items()}, "formulas": calls, "unread": unread}))`);
    expect(r.on).toEqual([true, true, false, false]);
    expect(r.keys).toEqual({ 'recLate:2026-09-30:1': '2026-10-02', 'recLate:2026-09-30:2': '2026-10-05' });
    expect(r.formulas).toEqual(["RECORD_ID()='reclaAzGLA4utssxx'", "LEFT({Task Name}, 11)='RENT LATE: '"]);
    expect(r.unread).toContain('control failed: the Cash Flow Voids register row could not be read');
  });

  it('when the agent\'s switch cannot be read, lane B is told so and never reports it as switched off', () => {
    const r = py(`
rows = []
today = rc.today_london()
ts = [tenancy("recG%02d" % i, 1, 500) for i in range(20)]
rc.load = lambda day: world(ts, [paid("recG%02d" % i, today.isoformat(), 500) for i in range(20)], day=today, feed=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
def unread(): raise RuntimeError("control failed: the Cash Flow Voids register row could not be read")
rc.read_task_state = unread
rc.write_row = lambda status, text, payload, now: rows.append([status, text])
rc.append_history = lambda res, now: None
with contextlib.redirect_stdout(io.StringIO()):
    code = rc.main(["run"])
# Each lane's line found by its own words, so a lane added after it never moves them.
line = lambda start: next(l for l in rows[0][1].splitlines() if l.startswith(start))
print(json.dumps({"code": code, "status": rows[0][0], "laneB": line("New-tenant tasks"), "agentLate": line("Agent-managed late rent")}))`);
    expect(r.code).toBe(1);
    expect(r.status).toBe('Failed');
    expect(r.laneB).toBe("New-tenant tasks: none raised, the Cash Flow Voids agent's switch could not be read.");
    // Roy's notice is gated on the same switch: unread raises nothing either.
    expect(r.agentLate).toMatch(/^Agent-managed late rent: none raised/);
  });

  it('benefit-cap claims have their own line on the row, and a failed read of them turns the run red', () => {
    const r = py(`
rows = []
today = rc.today_london()
ts = [tenancy("recG%02d" % i, 1, 500) for i in range(20)]
rc.load = lambda day: world(ts, [paid("recG%02d" % i, today.isoformat(), 500) for i in range(20)], day=today, feed=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
rc.read_task_state = lambda: {"on": True, "status": "Built", "keys": {}}
rc.write_row = lambda status, text, payload, now: rows.append([status, text])
line = lambda n, start: next(l for l in rows[n][1].splitlines() if l.startswith(start))
with contextlib.redirect_stdout(io.StringIO()):
    calm = rc.main(["run"])
def boom(_rc): raise RuntimeError("Airtable 503")
rc.rent_cap.read = boom
with contextlib.redirect_stdout(io.StringIO()):
    broken = rc.main(["run"])
print(json.dumps({"codes": [calm, broken], "status": [rows[0][0], rows[1][0]], "calm": line(0, "Benefit-cap claims"), "broken": line(1, "Benefit-cap claims")}))`);
    expect(r.codes).toEqual([0, 1]);
    expect(r.status).toEqual(['Worked', 'Failed']);
    expect(r.calm).toBe('Benefit-cap claims: none needed today.');
    expect(r.broken).toBe('Benefit-cap claims FAILED: benefit-cap claims could not be read: Airtable 503');
  });

  it('the text alarm (5 Oct 2026): its line is on the row, a flagged text leads the Home line, and a blind check turns the run red', () => {
    const r = py(`
rows, prints = [], []
today = rc.today_london()
ts = [tenancy("recG%02d" % i, 1, 500) for i in range(20)]
rc.load = lambda day: world(ts, [paid("recG%02d" % i, today.isoformat(), 500) for i in range(20)], day=today, feed=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
rc.read_task_state = lambda: {"on": True, "status": "Built", "keys": {}}
rc.write_row = lambda status, text, payload, now: rows.append([status, text, payload.get("briefLine", "")])
line = lambda n: next(l for l in rows[n][1].splitlines() if l.startswith("Text check"))
real = rc.text_check.run
with contextlib.redirect_stdout(io.StringIO()):
    quiet = rc.main(["run"])
rc.text_check.run = lambda *a, **k: {"checked": 1, "flagged": ["recTEXTCARD00001"], "noted": [], "failed": ""}
with contextlib.redirect_stdout(io.StringIO()):
    flagged = rc.main(["run"])
rc.text_check.run = lambda *a, **k: {"checked": 2, "flagged": [], "noted": [], "failed": "control failed: blind"}
with contextlib.redirect_stdout(io.StringIO()):
    blind = rc.main(["run"])
rc.text_check.run = real
print(json.dumps({"codes": [quiet, flagged, blind], "status": [x[0] for x in rows], "quiet": line(0), "flagged": line(1),
                  "brief": rows[1][2], "blind": line(2)}))`);
    expect(r.codes).toEqual([0, 0, 1]);
    expect(r.status).toEqual(['Worked', 'Worked', 'Failed']);
    expect(r.quiet).toBe('Text check: no rent text sent in the last 3 days.');
    expect(r.flagged).toMatch(/^Text check: ClickSend wrote back after 1 rent text \(task recTEXTCARD00001\)/);
    // Straight after the paying figure: Home prints only the first 700 characters.
    expect(r.brief).toMatch(/^20 of 20 tenants paying \(100\.0%, floor [\d.]+%\)\. Text check: ClickSend wrote back after 1 rent text/);
    expect(r.blind).toBe('Text check FAILED: control failed: blind.');
  });

  it('a failed raise is said on the row, turns the run red, and the rent line is still written', () => {
    const r = py(`
rows = []
today = rc.today_london()
due = (today - timedelta(days=3)).day
ts = [tenancy("recLate", due, 500)] + [tenancy("recG%02d" % i, due, 500) for i in range(20)]
tx = [paid("recLate", (today - timedelta(days=34)).isoformat(), 500)] + [paid("recG%02d" % i, (today - timedelta(days=3)).isoformat(), 500) for i in range(20)]
rc.load = lambda day: world(ts, tx, day=today, feed=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
rc.read_task_state = lambda: {"on": True, "status": "Built", "keys": {}}
def boom(item, day): raise RuntimeError("Airtable POST tasks 422: nope")
rc.raise_task = boom
rc.write_row = lambda status, text, payload, now: rows.append([status, text])
with contextlib.redirect_stdout(io.StringIO()):
    code = rc.main(["run"])
line = lambda start: next(l for l in rows[0][1].splitlines() if l.startswith(start))
print(json.dumps({"code": code, "status": rows[0][0], "lastLine": line("Late-rent tasks"), "laneB": line("New-tenant tasks"), "firstLine": rows[0][1].splitlines()[0][:22]}))`);
    expect(r.code).toBe(1);
    expect(r.status).toBe('Failed');
    expect(r.lastLine).toBe('Late-rent tasks FAILED: Airtable POST tasks 422: nope');
    // Lane B still runs and has its own line, after lane A's.
    expect(r.laneB).toBe('New-tenant tasks: none needed today.');
    expect(r.firstLine).toBe('20 of 21 tenants payin');
  });
});
