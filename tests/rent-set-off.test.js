// Rent paid by set-off (Kevin, 6 Oct 2026): a letting agent keeping the rent against a repair bill we owe them means
// the rent IS paid, "so it's not a cash flow void". The tenancy carries the window (Rent Set-off From / Until) and the
// rent check, the Cash Flow Voids page, the dashboard's count and the rent statement all count it as paid, for the rent
// that falls due INSIDE the window only. Independent review, 9 Oct 2026: rent owed before the window began must still
// be owed, a half-written window covers nothing, and the five readers must agree. Every value below is invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const py = (script) => JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
const CFV = readFileSync(resolve(ROOT, 'js/cfv.js'), 'utf8');
const DASH = readFileSync(resolve(ROOT, 'js/dashboard.js'), 'utf8');
const AR = readFileSync(resolve(ROOT, 'js/arrears.js'), 'utf8');

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

// One case table, run through BOTH the rent check (Python) and the page rule (JS). A tenancy: rent due on `due`,
// started `start`, last paid `paid` (or never), window `from`..`until`, judged on `today`.
const CASES = [
  // The 30 Burnbank shape: paid 1 Sep, then the agent keeps Oct to Apr.
  { name: 'inside the window', start: '2025-11-21', due: 1, paid: '2026-09-01', from: '2026-10-01', until: '2027-04-30', today: '2026-12-09', covered: true },
  { name: 'last period of the window', start: '2025-11-21', due: 1, paid: '2026-09-01', from: '2026-10-01', until: '2027-04-30', today: '2027-04-20', covered: true },
  { name: 'first rent after the window is owed again', start: '2025-11-21', due: 1, paid: '2026-09-01', from: '2026-10-01', until: '2027-04-30', today: '2027-05-09', covered: false },
  // The review's example: arrears from before a later window are still owed.
  { name: 'unpaid rent before the window began', start: '2025-11-21', due: 1, paid: '2026-08-01', from: '2026-12-01', until: '2026-12-31', today: '2026-10-09', covered: false },
  { name: 'no From: covers nothing', start: '2025-11-21', due: 1, paid: '2026-09-01', from: null, until: '2027-04-30', today: '2026-12-09', covered: false },
  { name: 'From after Until: covers nothing', start: '2025-11-21', due: 1, paid: '2026-09-01', from: '2027-05-01', until: '2027-04-30', today: '2026-12-09', covered: false },
  // Review round 2: a payment 80 to 85 days old is outside the rent check's read, so the page must ignore it too.
  { name: 'a payment just outside the 80-day read', start: '2025-11-21', due: 1, paid: '2025-12-27', from: '2026-02-01', until: '2026-06-30', today: '2026-03-19', covered: false },
  { name: 'no start date: cannot tell, never covered', start: null, due: 1, paid: '2026-09-01', from: '2026-10-01', until: '2027-04-30', today: '2026-12-09', covered: false },
  { name: 'due day 31 in short months', start: '2025-11-21', due: 31, paid: '2026-08-31', from: '2026-09-30', until: '2026-12-30', today: '2026-11-15', covered: true },
];

describe('rent check: set-off rent is paid, only for rent due inside the window', () => {
  const r = py(`
import importlib.util, json, os
from datetime import date
spec = importlib.util.spec_from_file_location("rc", os.path.join(${JSON.stringify(SCRIPTS)}, "rent-check.py"))
rc = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc)
TY = rc.TY
out = []
for c in json.loads(${JSON.stringify(JSON.stringify(CASES))}):
    day = date.fromisoformat(c["today"])
    f = {TY["dueDay"]: str(c["due"]), TY["rent"]: 500, TY["payStatus"]: "CFV", TY["start"]: c["start"] or None,
         TY["tenants"]: ["recTEN"], TY["tenantStatus"]: ["Active"], TY["unitRef"]: ["Unit 1 – 9 Example Road"], TY["hasTx"]: True}
    if c["from"]: f[TY["setOffFrom"]] = c["from"]
    if c["until"]: f[TY["setOffUntil"]] = c["until"]
    rc.bank_view = lambda feed, payments, d=day: (d, [])
    rc.tenant_type = lambda f, tenants: "Agent-Managed"
    # load() reads only payments dated after today minus TX_LOOKBACK_DAYS: the same filter here.
    pays = [{"day": date.fromisoformat(c["paid"]), "amount": 500}] if c["paid"] else []
    pays = [p for p in pays if p["day"] > day - __import__("datetime").timedelta(days=rc.TX_LOOKBACK_DAYS)]
    row = rc.judge({"id": "recTENANCY", "fields": f}, {}, pays, day, {"asAt": day, "waiting": []}, set(), set())
    out.append({"name": c["name"], "lane": row["lane"], "note": row["note"], "owed": row.get("owed")})
print(json.dumps(out))
`);
  for (const [i, c] of CASES.entries()) {
    it(`${c.name}: ${c.covered ? 'paying by set-off' : 'judged as usual'}`, () => {
      if (c.covered) {
        expect(r[i].lane).toBe('fine');
        expect(r[i].note).toMatch(/rent paid by set-off until/);
      } else {
        expect(r[i].note).not.toMatch(/set-off/);
      }
    });
  }
  it('the arrears case is late on the old rent, not hidden behind the later window', () => {
    expect(r[3]).toMatchObject({ lane: 'late', owed: '2026-09-01' });
    expect(r[2]).toMatchObject({ lane: 'late', owed: '2027-05-01' });
  });
});

// The page rule, run with the same table: it must agree with the rent check on every case.
function pageScope(extra = {}) {
  const F = { tenSetOffFrom: 'from', tenSetOffUntil: 'until', tenDueDay: 'due', tenStartDate: 'start', txDate: 'date' };
  const scope = {
    F, getField: (o, k) => (o.fields ? o.fields[k] : o[k]), getNumVal: (o, k, d) => Number((o.fields ? o.fields[k] : o[k]) || d),
    CFV_TOLERANCE_DAYS: 2, allTransactions: [], txLinkedToTenancy: () => false, window: {}, ...extra,
  };
  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${extract(CFV, 'rentSetOffWindow')}\n${extract(CFV, 'cfvSetOffCovers')}\nreturn { rentSetOffWindow, cfvSetOffCovers };`)(...names.map(n => scope[n]));
}
const atNoon = (iso) => { const d = new Date(iso + 'T00:00:00'); return d; };
const tenancyOf = (c) => ({ id: 'recT', fields: { start: c.start, due: String(c.due), from: c.from, until: c.until } });
const indexOf = (c) => new Map([['recT', c.paid ? [{ fields: { date: c.paid } }] : []]]);

describe('Cash Flow Voids page: the same rule as the rent check, case for case', () => {
  const { cfvSetOffCovers } = pageScope();
  for (const c of CASES) {
    it(`${c.name}`, () => {
      expect(cfvSetOffCovers(tenancyOf(c), atNoon(c.today), indexOf(c))).toBe(c.covered);
    });
  }
});

describe('Cash Flow Voids page: detectCFVs, run for real, lists neither a covered CFV nor a covered potential one', () => {
  function detect(tenancies, paidMap) {
    const { cfvSetOffCovers } = pageScope();
    const scope = {
      allTenancies: tenancies, getPaymentStatusName: (v) => v, getField: (o, k) => o.fields[k], getNumVal: (o, k, d) => Number(o.fields[k] || d),
      F: { tenPayStatus: 'status', tenRent: 'rent', tenDueDay: 'due' }, localStorage: { getItem: () => null, setItem: () => {} },
      isTenantStatusFormer: () => false, isTenantStatusActive: () => true, buildTenantLookup: () => ({}),
      buildTxByTenancyIndex: () => paidMap, hasLinkedPaymentThisMonth: () => false, getTenantForTenancy: () => ({}),
      buildCFVEntry: (t, tenant, status) => ({ tenancyId: t.id, status }), CFV_TOLERANCE_DAYS: 2,
      cfvAutoReturnToPayment: () => {}, cfvSetOffCovers: (t, today, idx) => cfvSetOffCovers(
        { id: t.id, fields: { start: t.fields.start, due: t.fields.due, from: t.fields.from, until: t.fields.until } }, today, idx),
    };
    const names = Object.keys(scope);
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, `${extract(CFV, 'detectCFVs')}; return detectCFVs;`)(...names.map(n => scope[n]));
    return fn({ autoReturn: false }).map(e => `${e.tenancyId}:${e.status}`);
  }
  it('a window that covers today hides both; arrears before the window still list', () => {
    const base = { start: '2025-11-21', due: '1', rent: 500 };
    const now = new Date(); const y = now.getFullYear(), m = now.getMonth();
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const firstOf = (k) => new Date(y, m + k, 1);
    const paidLast = new Date(y, m - 1, 1);                       // paid the rent due the 1st of last month
    const win = { from: iso(firstOf(0)), until: iso(new Date(y, m + 3, 0)) };   // this month to the end of month+2
    const ts = [
      { id: 'recCFV', fields: { ...base, status: 'cfv', ...win } },
      { id: 'recPAYING', fields: { ...base, status: 'in payment', ...win } },
      { id: 'recOLDDEBT', fields: { ...base, status: 'cfv', from: iso(firstOf(2)), until: iso(new Date(y, m + 3, 0)) } },
    ];
    const paid = new Map(ts.map(t => [t.id, [{ fields: { date: iso(paidLast) } }]]));
    paid.set('recOLDDEBT', [{ fields: { date: iso(new Date(y, m - 3, 1)) } }]);
    const listed = detect(ts, paid);
    expect(listed).toEqual(['recOLDDEBT:cfv']);
  });
});

describe('Leadership Dashboard: the potential cash flow void count skips a set-off the same way', () => {
  it('runs the real counting block: the covered tenancy is not counted, the uncovered one is', () => {
    const start = DASH.indexOf('let potentialCfvCount = 0;');
    const end = DASH.indexOf('const potentialCfvAlert', start);
    const block = DASH.slice(start, end);
    const scope = {
      tenancies: [{ id: 'recA' }, { id: 'recB' }], getPaymentStatusName: () => 'In Payment', getField: () => 500,
      F: {}, isTenantStatusActive: () => true, localStorage: { getItem: () => null }, buildTxByTenancyIndex: () => new Map(),
      isCurrentlyInArrears: () => true, getNumVal: () => 1, CFV_TOLERANCE_DAYS: 2,
      cfvSetOffCovers: (t) => t.id === 'recA',
    };
    const names = Object.keys(scope);
    // eslint-disable-next-line no-new-func
    const count = new Function(...names, `${block}; return potentialCfvCount;`)(...names.map(n => scope[n]));
    expect(count).toBe(1);
  });
});

describe('rent statement: set-off days are paid at the daily rate, over the days the rent is charged', () => {
  function statement(ten, todayIso, payments = []) {
    const { rentSetOffWindow } = pageScope();
    const getField = (o, k) => o[k];
    // eslint-disable-next-line no-new-func
    const compute = new Function('F', 'getField', 'getTenancyStartDate', 'DATA_START', 'allTransactions', 'txLinkedToTenancy',
      'txDisplayAmount', 'S8_THRESHOLD_DAYS', 'rentSetOffWindow', `${extract(AR, 'computeRentStatement')}; return computeRentStatement;`)(
      { tenRent: 'rent', txDate: 'date' }, getField,
      (t) => new Date(t.start),                                    // the real reader: new Date('YYYY-MM-DD'), UTC midnight
      new Date('2025-04-01'), [], () => false, (tx) => tx.amount, 62,
      (t) => rentSetOffWindow({ from: t.from, until: t.until }));
    return compute(ten, 'Agent-Managed', new Date(todayIso + 'T00:00:00'), new Map([['recT', payments]]));
  }
  it('a window across the October clock change credits every calendar day, today excluded, and the balance is right', () => {
    const s = statement({ id: 'recT', rent: 310, start: '2026-09-01', from: '2026-10-01', until: '2027-04-30' }, '2026-11-01',
      [{ date: '2026-09-01', amount: 310 }]);
    expect(s.setOff.days).toBe(31);                               // 1 to 31 Oct; 1 Nov (today) is not charged yet
    expect(s.setOff.amount).toBeCloseTo(310, 6);
    expect(s.payments).toHaveLength(1);                           // never a fake payment row
    expect(s.totalRentPaid).toBeCloseTo(620, 6);
    expect(s.balance).toBeCloseTo(s.totalRentOwed - 620, 6);
    expect(Math.round(s.totalRentOwed / 10)).toBe(s.daysSinceStart);
  });
  it('no window, or a window not yet begun, credits nothing', () => {
    expect(statement({ id: 'recT', rent: 310, start: '2026-09-01' }, '2026-11-01').setOff).toBe(null);
    expect(statement({ id: 'recT', rent: 310, start: '2026-09-01', from: '2026-12-01', until: '2026-12-31' }, '2026-11-01').setOff).toBe(null);
  });
});

// ─── the door ───
describe('tenancy-record.py set-off: whole rent periods, on a card approved as-is', () => {
  const r = py(`
import importlib.util, json, os, io, contextlib, tempfile
os.environ["TENANCY_RECORD_LEDGER"] = os.path.join(tempfile.mkdtemp(), "ledger.jsonl")
spec = importlib.util.spec_from_file_location("tr", os.path.join(${JSON.stringify(SCRIPTS)}, "tenancy-record.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rc = m.rc; TK = m.TK
rc.today_london = lambda: __import__("datetime").date(2026, 10, 9)
TEN, TASK = "recBURN0000000001", "recCARD0000000001"
W = {rc.T_TENANCIES: {TEN: {rc.TY["start"]: "2025-11-21", rc.TY["dueDay"]: "1"}},
     rc.T_TASKS: {TASK: {"fldrHBSr6qoUfaKuZ": "Approved as-is", "fld30Yw8SWYVp049g": ["recAG"],
                         "fldr4Mvf2RzKvhZhi": "2026-10-06T10:00:00.000Z", TK["tenancies"]: [TEN],
                         TK["agentOutput"]: "If you approve, the rent the agent keeps counts as paid.\\nRECORD CHANGE: " + TEN + " Set-off = 2026-10-01 to 2027-04-30"}}}
comments = []
def fetch_all(table, params=None):
    f = (params or {}).get("filterByFormula") or ""
    return [{"id": k, "createdTime": "2026-10-01T00:00:00.000Z", "fields": dict(v)} for k, v in W[table].items() if k in f]
def api(method, path, payload=None, params=None):
    if path.endswith("/comments"):
        comments.append(payload["text"]); return {"id": "c"}
    assert method == "PATCH" and "typecast" not in payload
    W[rc.T_TENANCIES][path.split("/")[1]].update(payload["fields"]); return {}
rc.fetch_all, rc.api = fetch_all, api
def run(*argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = m.main(["set-off", TEN, "--task", TASK, "--why", "Kevin ruled the kept rent paid"] + list(argv))
    return [code, json.loads(buf.getvalue())]
out = {"midStart": run("--from", "2026-10-05", "--until", "2027-04-30"), "midEnd": run("--from", "2026-10-01", "--until", "2027-04-15"),
       "otherWindow": run("--from", "2026-11-01", "--until", "2027-04-30"), "ok": run("--from", "2026-10-01", "--until", "2027-04-30"),
       "row": W[rc.T_TENANCIES][TEN], "comments": comments}
print(json.dumps(out))
`);
  it('refuses a window that starts or ends mid-period', () => {
    expect(r.midStart[1].refused).toMatch(/whole rent periods/);
    expect(r.midEnd[1].refused).toMatch(/whole rent periods/);
  });
  it('refuses a window the card did not name, writes the one it did, reads it back and comments', () => {
    expect(r.otherWindow[1].refused).toMatch(/no line 'RECORD CHANGE: recBURN0000000001 Set-off = 2026-11-01 to 2027-04-30'/);
    expect(r.ok[0]).toBe(0);
    expect(r.row.fldkeJL4wXDcO6wqq).toBe('2026-10-01');
    expect(r.row.fldwvF3MrJXlQMoCk).toBe('2027-04-30');
    expect(r.comments[0]).toMatch(/rent paid by set-off from 1 Oct 2026 to 30 Apr 2027/);
  });
});
