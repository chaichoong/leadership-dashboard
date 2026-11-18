// Eight known limits in the rent statement, set-off and move-in check (finding 20261017-agent-dispatch-971; Kevin
// approved task rechAb943JaT3d9kG on 17 Oct 2026). One test per item, named for its number in the approved plan.
// Each drives the REAL code (js/arrears.js extracted and run, the Python scripts imported) with the Airtable calls
// and the mailbox swapped for fixtures. Every id, name, date and amount here is invented: this repo is public.
//
// Back-tested (18 Nov 2026) by reverting each fix alone and watching its case fail:
//   (1) the set-off credit not cut by a payment inside the window -> paid 1000, not 500, on screen and in print
//   (2) due-day with no set-off check -> the change that leaves the window mid-period is written
//   (3) setMonth(+1) on the 31st -> 31 Jan, 3 Mar, 3 Apr (three rents, not four)
//   (4) the start read as UTC midnight and floored -> 9 days, not 10
//   (5) folding on the same minute only -> 12:59 and 13:01 are two tasks
//   (6) no reference on a no-unit check -> two open checks share one thread and the reply is refused as ambiguous
//   (7) Single beside named adults let through -> the claim is raised
//   (8) no .git check on the tripwire test -> a copy with no .git fails at load
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearGitLocalEnv } from './git-local-env.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const AR = readFileSync(resolve(ROOT, 'js/arrears.js'), 'utf8');
const CFV = readFileSync(resolve(ROOT, 'js/cfv.js'), 'utf8');
const py = (script) => JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());

function extract(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`could not parse ${name}`);
}
// Helpers a newer arrears.js has and an older one may not: an absent one is left out, so a back-test against the
// old file fails on its numbers, not on a missing name.
const maybe = (name) => (AR.includes(`function ${name}(`) ? extract(AR, name) : '');
const HELPERS = ['rsDayNo', 'rsIsoDayNo', 'rsSetOffAfterPayments'].map(maybe).join('\n');
const DATA_START_SRC = AR.match(/const DATA_START = [^;]+;/)[0];

// The page runs in London, clock changes included.
const realTz = process.env.TZ;
beforeAll(() => { process.env.TZ = 'Europe/London'; });
afterAll(() => { if (realTz === undefined) delete process.env.TZ; else process.env.TZ = realTz; });

const F = { tenRent: 'rent', tenStartDate: 'start', tenSetOffFrom: 'from', tenSetOffUntil: 'until', tenDueDay: 'due',
  txDate: 'date', txReconciled: 'rec', txDescription: 'desc' };
const getField = (o, k) => (o.fields ? o.fields[k] : o[k]);
const rentSetOffWindow = new Function('F', 'getField', `${extract(CFV, 'rentSetOffWindow')}; return rentSetOffWindow;`)(F, getField);

// computeRentStatement with the REAL start reader and the REAL data start.
function statement(ten, todayIso, payments = []) {
  // eslint-disable-next-line no-new-func
  const compute = new Function('F', 'getField', 'allTransactions', 'txLinkedToTenancy', 'txDisplayAmount',
    'S8_THRESHOLD_DAYS', 'rentSetOffWindow',
    `${DATA_START_SRC}\n${extract(AR, 'getTenancyStartDate')}\n${HELPERS}\n${extract(AR, 'computeRentStatement')}; return computeRentStatement;`)(
    F, getField, [], () => false, (tx) => tx.amount, 62, rentSetOffWindow);
  const txs = payments.map((p, i) => ({ id: `tx${i}`, fields: { date: p.date, desc: 'Rent' }, amount: p.amount }));
  return compute({ id: 'recT', fields: ten }, 'Agent-Managed', new Date(todayIso + 'T00:00:00'), new Map([['recT', txs]]));
}

// rsGeneratePrintStatement run for real: the print window is a stub that keeps what is written to it.
function printStatement(ten, startIso, endIso, payments = []) {
  let html = '';
  const win = { document: { write: (s) => { html += s; }, close: () => {} } };
  const txs = payments.map((p, i) => ({ id: `tx${i}`, fields: { date: p.date, rec: true, desc: 'Rent' }, amount: p.amount }));
  const scope = {
    F, getField, getNumVal: (o, k, d) => Number(getField(o, k) || d), allTransactions: txs, txLinkedToTenancy: () => true,
    txDisplayAmount: (tx) => tx.amount, rentSetOffWindow, escHtml: (s) => String(s),
    fmtMoney: (n) => `£${Number(n).toFixed(2)}`, showToast: () => {}, window: { open: () => win },
  };
  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const gen = new Function(...names, `${HELPERS}\n${extract(AR, 'rsGeneratePrintStatement')}; return rsGeneratePrintStatement;`)(
    ...names.map((n) => scope[n]));
  gen({ id: 'recT', fields: ten }, 'A Tenant', 'Unit 1', '9 Example Road', 'Agent-Managed', Number(ten.rent),
    new Date(startIso + 'T00:00:00'), new Date(endIso + 'T00:00:00'));
  const rows = [...html.matchAll(/<tr><td>([^<]*)<\/td><td>([^<]*)<\/td><td class="text-right">([^<]*)<\/td><td class="text-right">([^<]*)<\/td>/g)]
    .map((m) => ({ date: m[1], desc: m[2], debit: m[3], credit: m[4] }));
  const box = (label) => (html.match(new RegExp(`<div class="label">${label}</div><div class="value[^"]*">([^<]*)</div>`)) || [])[1];
  return { rows, paid: box('Total paid'), owed: box('Total rent owed'), balance: box('Balance') };
}

describe('finding 971: the rent statement', () => {
  it('item 1: a payment inside a set-off window cuts the set-off credit, so the window is paid once, on screen and in print', () => {
    const ten = { rent: 500, start: '2026-10-01', due: '1', from: '2026-10-01', until: '2026-10-31' };
    const s = statement(ten, '2026-11-01', [{ date: '2026-10-15', amount: 500 }]);
    expect(s.totalRentOwed).toBeCloseTo(500, 6);                   // 1 to 31 Oct: one period
    expect(s.setOff.amount).toBeCloseTo(0, 6);
    expect(s.setOff.paidInside).toBe(500);
    expect(s.payments).toHaveLength(1);                            // the payment stays on the ledger as money received
    expect(s.totalRentPaid).toBeCloseTo(500, 6);                   // one period, not two
    expect(s.balance).toBeCloseTo(0, 6);
    // Floor zero, and only payments dated inside the window: a part payment leaves the rest of the credit.
    const part = statement(ten, '2026-11-01', [{ date: '2026-10-15', amount: 200 }, { date: '2026-09-30', amount: 75 }]);
    expect(part.setOff.amount).toBeCloseTo(300, 6);
    // A refund inside the window never raises the credit above the full window.
    expect(statement(ten, '2026-11-01', [{ date: '2026-10-15', amount: -40 }]).setOff.amount).toBeCloseTo(500, 6);

    const p = printStatement(ten, '2026-10-01', '2026-10-31', [{ date: '2026-10-15', amount: 500 }]);
    expect(p.owed).toBe('£500.00');
    expect(p.paid).toBe('£500.00');
    expect(p.balance).toBe('£0.00');
    expect(p.rows.filter((r) => /set-off/.test(r.desc))).toEqual([]);
  });

  it('item 1, review of PR #980: rent is paid oldest first, so a late payment for the month before the window, or an early one for the month after, never cuts the set-off', () => {
    // £500 due on the 1st, the set-off covers October, September's rent arrives late on 5 Oct: nothing is owed.
    const ten = { rent: 500, start: '2026-09-01', due: '1', from: '2026-10-01', until: '2026-10-31' };
    const late = statement(ten, '2026-11-01', [{ date: '2026-10-05', amount: 500 }]);
    expect(late.balance).toBeCloseTo(0, 6);                        // the head under review showed £483.87 owed
    expect(late.daysInArrears).toBe(0);                            // and 30 days in arrears
    expect(late.setOff.paidInside).toBeCloseTo(500 - (500 / 31) * 30, 6);   // only what was left after September
    const latePrint = printStatement(ten, '2026-09-01', '2026-10-31', [{ date: '2026-10-05', amount: 500 }]);
    expect([latePrint.owed, latePrint.paid, latePrint.balance]).toEqual(['£1000.00', '£1000.00', '£0.00']);
    expect(latePrint.rows.filter((r) => /set-off/.test(r.desc)).map((r) => r.credit)).toEqual(['£500.00']);

    // September paid on time, November's rent paid early on 28 Oct: the set-off still pays October in full.
    const early = statement(ten, '2026-11-01', [{ date: '2026-09-01', amount: 500 }, { date: '2026-10-28', amount: 500 }]);
    expect(early.setOff.amount).toBeCloseTo(500, 6);
    expect(early.balance).toBeCloseTo((500 / 31) * 61 - 1500, 6);  // in credit by November's rent, paid in advance
    const earlyPrint = printStatement(ten, '2026-09-01', '2026-11-30',
      [{ date: '2026-09-01', amount: 500 }, { date: '2026-10-28', amount: 500 }]);
    expect([earlyPrint.owed, earlyPrint.paid, earlyPrint.balance]).toEqual(['£1500.00', '£1500.00', '£0.00']);
  });

  it('item 3: the printed statement keeps a due day of 31 on each month\'s last day when the month is short', () => {
    const p = printStatement({ rent: 600, start: '2026-06-01', due: '31' }, '2027-01-31', '2027-04-30');
    expect(p.rows.filter((r) => r.desc === 'Monthly rent due').map((r) => r.date))
      .toEqual(['31 Jan 2027', '28 Feb 2027', '31 Mar 2027', '30 Apr 2027']);
    expect(p.owed).toBe('£2400.00');
  });

  it('item 4: the day count is by calendar day in summer time (1 Jun to 11 Jun 2026 is 10 days)', () => {
    const s = statement({ rent: 310, start: '2026-06-01' }, '2026-06-11');
    expect(s.daysSinceStart).toBe(10);
    expect(s.totalRentOwed).toBeCloseTo(100, 6);
    // The data start is 1 Apr 2025 as a London calendar day too.
    expect(statement({ rent: 310, start: '2024-01-01' }, '2025-04-11').daysSinceStart).toBe(10);
  });
});

describe('finding 971: the set-off door and the due day', () => {
  it('item 2: due-day refuses a new day that leaves a running set-off mid-period, and says to re-record it first', () => {
    const r = py(`
import importlib.util, json, os, io, contextlib, tempfile
from datetime import date
os.environ["TENANCY_RECORD_LEDGER"] = os.path.join(tempfile.mkdtemp(), "ledger.jsonl")
spec = importlib.util.spec_from_file_location("tr", os.path.join(${JSON.stringify(SCRIPTS)}, "tenancy-record.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rc = m.rc; TK = m.TK
rc.today_london = lambda: date(2026, 10, 9)
TEN, TASK = "recDUEDAYTEST0001", "recDUEDAYCARD0001"
def run(window, output):
    W = {rc.T_TENANCIES: {TEN: dict({rc.TY["start"]: "2025-11-21", rc.TY["dueDay"]: "1"}, **window)},
         rc.T_TASKS: {TASK: {"fldrHBSr6qoUfaKuZ": "Approved as-is", "fld30Yw8SWYVp049g": ["recAG"],
                             "fldr4Mvf2RzKvhZhi": "2026-10-08T10:00:00.000Z", TK["tenancies"]: [TEN], TK["agentOutput"]: output}}}
    def fetch_all(table, params=None):
        f = (params or {}).get("filterByFormula") or ""
        return [{"id": k, "createdTime": "2026-10-01T00:00:00.000Z", "fields": dict(v)} for k, v in W[table].items() if k in f]
    def api(method, path, payload=None, params=None):
        if path.endswith("/comments"):
            return {"id": "c"}
        assert method == "PATCH" and "typecast" not in payload
        W[rc.T_TENANCIES][path.split("/")[1]].update(payload["fields"]); return {}
    rc.fetch_all, rc.api = fetch_all, api
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = m.main(["due-day", TEN, "15", "--task", TASK, "--why", "the tenant's pay day moved to the 15th"])
    row = W[rc.T_TENANCIES][TEN]
    return [code, json.loads(buf.getvalue()), row[rc.TY["dueDay"]], [row.get(m.SET_OFF_FROM), row.get(m.SET_OFF_UNTIL)]]
WIN = {m.SET_OFF_FROM: "2026-10-01", m.SET_OFF_UNTIL: "2026-11-30"}
DUE = "If you approve, the due day moves.\\nRECORD CHANGE: " + TEN + " Due Day = 15"
print(json.dumps({
    "refused": run(WIN, DUE),
    "noWindow": run({}, DUE),
    "reRecorded": run(WIN, DUE + "\\nRECORD CHANGE: " + TEN + " Set-off = 2026-10-15 to 2026-12-14"),
    "reRecordedWrong": run(WIN, DUE + "\\nRECORD CHANGE: " + TEN + " Set-off = 2026-10-01 to 2026-11-30"),
    "over": run({m.SET_OFF_FROM: "2026-08-01", m.SET_OFF_UNTIL: "2026-09-30"}, DUE),
    # Review of PR #980: the card's set-off must pass the set-off command's own checks and carry on from the running one.
    "pastWindow": run({m.SET_OFF_FROM: "2026-08-01", m.SET_OFF_UNTIL: "2026-11-30"},
                      DUE + "\\nRECORD CHANGE: " + TEN + " Set-off = 2026-08-15 to 2026-09-14"),
    "overThreeYears": run(WIN, DUE + "\\nRECORD CHANGE: " + TEN + " Set-off = 2026-10-15 to 2030-10-14"),
    "unrelated": run(WIN, DUE + "\\nRECORD CHANGE: " + TEN + " Set-off = 2027-06-15 to 2027-07-14"),
    # Re-review: a line the set-off command's own gate would not take is refused before the due day is written.
    "twoSpaces": run(WIN, DUE + "\\nRECORD CHANGE: " + TEN + " Set-off = 2026-10-15 to  2026-12-14"),
}))
`);
    expect(r.refused[0]).toBe(2);
    expect(r.refused[1].refused).toMatch(/no longer be whole rent periods with due day 15: re-record the set-off first/);
    expect(r.refused[2]).toBe('1');                                // nothing written
    expect(r.noWindow[0]).toBe(0);
    expect(r.noWindow[2]).toBe('15');
    // The same card re-records the window, lined up with the new day, and this command writes both.
    expect(r.reRecorded[0]).toBe(0);
    expect(r.reRecorded[2]).toBe('15');
    expect(r.reRecorded[3]).toEqual(['2026-10-15', '2026-12-14']);
    expect(r.reRecorded[1].setOff.to).toBe('2026-10-15 to 2026-12-14');
    expect(r.reRecordedWrong[1].refused).toMatch(/re-record the set-off first.*whole rent periods/);
    expect(r.over[0]).toBe(0);                                     // a window already over is left alone
    // Each refused case writes nothing: the due day and the running window are as they were.
    for (const [k, why] of [['pastWindow', /the card's set-off ended on 2026-09-14/],
      ['overThreeYears', /longer than three years/], ['unrelated', /does not carry on from the running one/],
      ['twoSpaces', /has no line 'RECORD CHANGE: recDUEDAYTEST0001 Set-off = 2026-10-15 to 2026-12-14'/]]) {
      expect(r[k][0], k).toBe(2);
      expect(r[k][1].refused, k).toMatch(why);
      expect(r[k][2], k).toBe('1');
    }
    expect(r.pastWindow[3]).toEqual(['2026-08-01', '2026-11-30']);
    expect(r.overThreeYears[3]).toEqual(['2026-10-01', '2026-11-30']);
    expect(r.twoSpaces[3]).toEqual(['2026-10-01', '2026-11-30']);
  });
});

describe('finding 971: the move-in check', () => {
  it('item 5: copies of one agreement signed within 15 minutes fold into one task, hours apart they do not', () => {
    const r = py(`
import json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import rent_signed_check as rsc
DOC = "AST - Unit 1, 9 Example Road"
def a(mail, signed, doc=DOC): return {"mail": mail, "doc": doc, "signed": signed}
print(json.dumps({
    "straddle": [x["copies"] for x in rsc.one_per_agreement([a("m00000000000002", "9 Oct 2026 12:59"), a("m00000000000001", "9 Oct 2026 13:01")])],
    "apart": [x["copies"] for x in rsc.one_per_agreement([a("m00000000000003", "9 Oct 2026 09:00"), a("m00000000000004", "9 Oct 2026 15:00")])],
    "otherDoc": len(rsc.one_per_agreement([a("m00000000000005", "9 Oct 2026 12:59"), a("m00000000000006", "9 Oct 2026 13:00", "AST - Unit 2, 9 Example Road")])),
}))
`);
    expect(r.straddle).toEqual([['m00000000000001', 'm00000000000002']]);
    expect(r.apart).toEqual([['m00000000000003'], ['m00000000000004']]);
    expect(r.otherDoc).toBe(2);
  });

  it('item 6: two open no-unit housing costs checks are two threads; a reply lands on its own check only', () => {
    const r = py(`
import importlib.util, json, sys, os, tempfile
from datetime import date, datetime, timezone
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
spec = importlib.util.spec_from_file_location("rc", os.path.join(${JSON.stringify(SCRIPTS)}, "rent-check.py"))
rc = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc)
lb = rc.lane_b_rules
import rent_roy_email as bridge
def _no(*a, **k): raise RuntimeError("a test reached a real read, write or email")
rc.fetch_all = _no; lb.module = _no; lb.notify_roy = _no
TY, TK = rc.TY, rc.TK
DAY = date(2026, 10, 2)
NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
ROY = "roy@example.com"
A, B = "recNoUnitTestAb12", "recNoUnitTestCd34"
def tenancy(i, tenant):
    return {"id": i, "fields": {TY["dueDay"]: "25", TY["rent"]: 900.00, TY["payStatus"]: "CFV", TY["start"]: "2026-09-10",
                                TY["tenants"]: [tenant], TY["tenantStatus"]: ["Active"], TY["unitRef"]: None, TY["surname"]: "Sample"}}
def costs_task(i, tenancy_id, name):
    return {"id": i, "name": name, "notes": lb.SETUP_KEY_MARK + tenancy_id + ":costs:1", "description": "", "status": "Today",
            "created": date(2026, 9, 28), "made": datetime(2026, 9, 28, 9, 0, tzinfo=timezone.utc), "completed": None,
            "tenancies": [tenancy_id]}
def name_of(tid):
    return lb.roy_task({"id": tid, "unit": "Sample (no unit linked)", "tenant": "Sam Sample", "tenants": ["recT"]}, "costs", 1, DAY)["name"]
OLD = lb.ROY_PREFIX + "housing costs check: a tenancy with no unit linked"
def email(i, subject):
    ms = int(datetime(2026, 10, 1, 10, 0, tzinfo=timezone.utc).timestamp() * 1000)
    return {"id": i, "internalDate": str(ms), "headers": {"from": "Roy Lavin <" + ROY + ">", "subject": subject},
            "body": "Yes, housing costs verified on the journal today"}
class Store:
    def __init__(self, tasks):
        self.tasks = {t["id"]: dict(t) for t in tasks}; self.patches = []
    def read_tasks(self, _rc):
        return [dict(t) for t in self.tasks.values()]
    def api(self, method, path, payload=None, params=None):
        if method == "GET" and path.startswith(rc.T_TASKS + "/"):
            return {"id": path.split("/")[1], "fields": {TK["notes"]: self.tasks[path.split("/")[1]]["notes"]}}
        if method == "PATCH" and path == rc.T_TASKS:
            x = payload["records"][0]; self.tasks[x["id"]]["notes"] = x["fields"][TK["notes"]]; self.patches.append(x["id"]); return {}
        raise AssertionError(method + " " + path)
def run(tasks, subject):
    store = Store(tasks)
    lb.read_tasks = store.read_tasks
    lb.read_names = lambda _rc, ids: {}
    rc.api = store.api
    data = {"tenancies": [tenancy(A, "recTa"), tenancy(B, "recTb")]}
    out = bridge.run(rc, data, NOW, True, True, list_mail=lambda q, acc: ([email("1b0000000000bbb1", subject)], False),
                     count_mail=lambda q, acc: 5, ledger=os.path.join(tempfile.mkdtemp(), "ledger.jsonl"), roy=ROY)
    return {"patches": store.patches, "ambiguous": out["ambiguous"], "failed": out["failed"]}
NA, NB = name_of(A), name_of(B)
print(json.dumps({
    "names": [NA, NB],
    "first": run([costs_task("recROYCHECK00001", A, NA), costs_task("recROYCHECK00002", B, NB)], "Re: " + NA),
    "oldShape": run([costs_task("recROYCHECK00001", A, OLD)], "Re: " + OLD),
    "oldAndNew": run([costs_task("recROYCHECK00001", A, OLD), costs_task("recROYCHECK00002", B, NB)], "Re: " + NB),
    "caseApart": bridge.in_thread("Re: " + NA.replace("Ab12", "ab12"), bridge.task_place(NA)),
}))
`);
    // The reference is the record's last four characters; never a surname.
    expect(r.names).toEqual(['NEW TENANT RENT: housing costs check: a tenancy with no unit linked (ref Ab12)',
      'NEW TENANT RENT: housing costs check: a tenancy with no unit linked (ref Cd34)']);
    expect(r.names.join(' ')).not.toMatch(/Sample/);
    expect(r.first).toEqual({ patches: ['recROYCHECK00001'], ambiguous: [], failed: '' });
    expect(r.oldShape.patches).toEqual(['recROYCHECK00001']);     // a check named before the reference still matches
    expect(r.oldAndNew.patches).toEqual(['recROYCHECK00002']);    // a reply to the new one is not also the old one's
    expect(r.caseApart).toBe(false);
  });
});

describe('finding 971: the benefit-cap card', () => {
  it('item 7: "Single" beside named other adults waits for a real answer; "Single" with "none" passes', () => {
    const r = py(`
import json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import rent_cap as cap
TN = cap.TN
single = {TN["household"]: {"name": "Single"}}
print(json.dumps({
    "named": cap.household_gap(dict(single, **{TN["otherAdults"]: "Jo (partner)"}), 1),
    "none": cap.household_gap(dict(single, **{TN["otherAdults"]: "none"}), 1),
    "blank": cap.household_gap(dict(single), 1),
    "couple": cap.household_gap({TN["household"]: {"name": "Couple"}, TN["otherAdults"]: "Jo (partner)"}, 1),
}))
`);
    expect(r.named).toBe('household (the record says Single but names other adults)');
    expect(r.none).toBe('');
    expect(r.blank).toBe('');
    expect(r.couple).toBe('');
  });
});

describe('finding 971: the tripwire test in a copy with no .git', () => {
  it('item 8: the tripwire test file skips itself where there is no .git, and the run passes', () => {
    const CARRIED = ['vitest.config.js', 'tests/real-repo-config-tripwire.js', 'tests/real-repo-config-tripwire.test.js',
      'tests/git-local-env.js', 'tests/setup-git-env.js', 'tests/setup-state-dirs.js', 'tests/setup-yield.js',
      'tests/clock-skew-reporter.js'];
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-971-'));
    try {
      for (const f of CARRIED) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        copyFileSync(join(ROOT, f), join(dir, f));
      }
      writeFileSync(join(dir, 'package.json'), '{"type": "module"}');
      symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
      const env = clearGitLocalEnv({ ...process.env });
      delete env.TRIPWIRE_PROBE;                                   // the real file, not the inner-run probe
      const r = spawnSync('npx', ['vitest', 'run', 'tests/real-repo-config-tripwire.test.js'],
        { cwd: dir, encoding: 'utf8', timeout: 50000, env });
      const out = (r.stdout || '') + (r.stderr || '');
      expect(r.status, out.slice(-1500)).toBe(0);
      expect(out).toMatch(/real-repo config tripwire: skipped, .* is not a git checkout/);
      expect(out).toMatch(/skipped/);
      expect(out).not.toMatch(/passed|failed/i);                   // control: nothing ran, so nothing recursed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
