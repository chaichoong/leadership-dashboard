// A LETTING AGENT'S NIL STATEMENT (finding 1354, 19 Nov 2026). `tenancy-record.py nil-statement` records, as one
// dated comment on the tenancy, that the agent's statement showed no payout for one rent due date; the rent check
// reads that comment and does not count the rent as owed (tests/rent-check.test.js, "nil statement"). These drive
// the REAL door with Airtable swapped for recorders, and read the written comment back through the rent check's own
// reader, so the two can never disagree on the shape. Every id, name, date and figure below is invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOOR = resolve(ROOT, 'scripts/tenancy-record.py');
const TEN = 'recTENANCYnil0001';
const TASK = 'recTASKnil0000001';
const EVIDENCE = 'Example Lettings statement for September, emailed 8 Oct 2026: income 0.00, payout 0.00';

function door(argv, { payType = 'Agent-Managed', end = null, comments = [], linked = true } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'nil-statement-'));
  const cfg = { argv, dir, payType, end, comments, linked, TEN, TASK };
  const script = `
import importlib.util, json, io, contextlib, os
from datetime import date
cfg = json.loads(${JSON.stringify(JSON.stringify(cfg))})
os.environ["TENANCY_RECORD_LEDGER"] = cfg["dir"] + "/ledger.jsonl"
spec = importlib.util.spec_from_file_location("tr", ${JSON.stringify(DOOR)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.LEDGER = cfg["dir"] + "/ledger.jsonl"
rc = m.rc
rc.today_london = lambda: date(2026, 11, 18)
posted = []
def ALL():
    return ([{"text": t, "createdTime": "2026-11-18T10:00:00.000Z"} for t in cfg["comments"]]
            + [{"text": t, "createdTime": "2026-11-19T09:00:00.000Z"} for t in posted])
def fetch_all(table, params=None):
    formula = (params or {}).get("filterByFormula") or ""
    if table == rc.T_TENANCIES and cfg["TEN"] in formula:
        return [{"id": cfg["TEN"], "fields": {rc.TY["dueDay"]: "10", rc.TY["rent"]: 500, rc.TY["start"]: "2025-01-10",
                 rc.TY["end"]: cfg["end"], rc.TY["tenants"]: ["recTENANTnil00001"], rc.TY["tenantStatus"]: ["Active"]}}]
    if table == rc.T_TASKS and cfg["TASK"] in formula:
        return [{"id": cfg["TASK"], "createdTime": "2026-11-18T08:00:00.000Z", "fields": {
            m.TK["name"]: "AGENT RENT LATE: Unit 1 - 2 Example Street", m.TK["tenancies"]: [cfg["TEN"]] if cfg["linked"] else []}}]
    if table == rc.T_TENANTS and "recTENANTnil00001" in formula:
        return [{"id": "recTENANTnil00001", "fields": {rc.TN["payType"]: cfg["payType"]}}]
    return []
def api(method, path, payload=None, params=None):
    if method == "GET" and path.endswith("/comments"):
        return {"comments": ALL()}
    if method == "POST" and path.endswith("/comments"):
        posted.append(payload["text"]); return {"id": "comNIL0001"}
    raise AssertionError("unexpected call " + method + " " + path)
rc.fetch_all, rc.api = fetch_all, api
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = m.main(cfg["argv"])
out = buf.getvalue().strip()
read_back = sorted(d.isoformat() for d in rc.nil_statement_dates(ALL()))
print(json.dumps({"code": code, "out": json.loads(out), "posted": posted, "readBack": read_back}))`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
}

const ARGS = (due = '2026-10-10', evidence = EVIDENCE) => ['nil-statement', TEN, '--due', due, '--task', TASK, '--evidence', evidence];

describe('tenancy-record nil-statement: the letting agent\'s nil payout, recorded once, read by the rent check', () => {
  it('writes one dated comment the rent check reads back as that due date, and a second run writes nothing', () => {
    const r = door(ARGS());
    expect(r.code).toBe(0);
    expect(r.out).toEqual({ tenancy: TEN, nilStatement: '2026-10-10', commented: 'comNIL0001' });
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0]).toMatch(/: NIL STATEMENT 2026-10-10: the letting agent's statement shows no payout .*Evidence: Example Lettings statement for September, emailed 8 Oct 2026: income 0\.00, payout 0\.00 \(task recTASKnil0000001/);
    expect(r.readBack).toEqual(['2026-10-10']);
    const again = door(ARGS(), { comments: [r.posted[0]] });
    expect([again.code, again.posted]).toEqual([0, []]);
    expect(again.out.unchanged).toMatch(/already recorded/);
  });

  it('refuses a rent that is not agent-managed, a day that is not a due date, a future rent, an ended tenancy and thin evidence', () => {
    const cases = {
      notAgent: door(ARGS(), { payType: 'Universal Credit' }),
      notDue: door(ARGS('2026-10-11')),
      future: door(ARGS('2026-12-10')),
      ended: door(ARGS(), { end: '2026-10-31' }),
      noFigure: door(ARGS('2026-10-10', 'Example Lettings statement for September, emailed 8 Oct 2026, nothing paid')),
      noPayoutWord: door(ARGS('2026-10-10', 'Example Lettings statement for September, emailed 8 Oct 2026: 0.00')),
      notNamed: door(ARGS(), { linked: false }),
    };
    for (const [k, v] of Object.entries(cases)) {
      expect([k, v.code, v.posted]).toEqual([k, 2, []]);
    }
    expect(cases.notAgent.out.refused).toMatch(/is not Agent-Managed/);
    expect(cases.notDue.out.refused).toMatch(/is not one of this tenancy's due dates \(its rent falls due on the 10th\)/);
    expect(cases.future.out.refused).toMatch(/is in the future/);
    expect(cases.ended.out.refused).toMatch(/has ended/);
    expect(cases.noFigure.out.refused).toMatch(/--evidence quotes the statement itself/);
    expect(cases.noPayoutWord.out.refused).toMatch(/--evidence quotes the statement itself/);
    expect(cases.notNamed.out.refused).toMatch(/does not name tenancy/);
  });

  // The independent review of the first draft (19 Nov 2026).
  it('a real payout beside a 0.00 fee is refused, a plain comment cannot write the marker, and --withdraw takes a date back', () => {
    const fee = door(ARGS('2026-10-10', 'Example Lettings statement for September, emailed 8 Oct 2026: payout £450.00, fees 0.00'));
    expect([fee.code, fee.posted]).toEqual([2, []]);
    expect(fee.out.refused).toMatch(/--evidence quotes the statement itself/);
    // Review round 2: another item's nil between the payout words and the payout figure.
    const advice = door(ARGS('2026-10-10', 'Example Lettings statement, emailed 8 Oct 2026. Remittance advice: nil deductions this month. Payout £450.00'));
    expect([advice.code, advice.posted]).toEqual([2, []]);
    const real = door(ARGS('2026-10-10', 'Example Lettings statement for September, emailed 8 Oct 2026: Balance paid to landlord: £0.00'));
    expect([real.code, real.readBack]).toEqual([0, ['2026-10-10']]);
    const hand = door(['comment', TEN, '--task', TASK, '--text', 'per Example Lettings NIL STATEMENT 2026-10-10: payout 0.00']);
    expect([hand.code, hand.posted]).toEqual([2, []]);
    expect(hand.out.refused).toMatch(/written by `tenancy-record.py nil-statement`/);
    const own = real.posted[0];
    const back = door([...ARGS('2026-10-10', 'the statement was for another unit at the house'), '--withdraw'], { comments: [own] });
    expect([back.code, back.out.withdrawn, back.readBack]).toEqual([0, '2026-10-10', []]);
    expect(back.posted[0]).toMatch(/: NIL STATEMENT WITHDRAWN 2026-10-10: the nil statement recorded for that rent is withdrawn/);
    const none = door([...ARGS('2026-10-10', 'the statement was for another unit at the house'), '--withdraw']);
    expect([none.code, none.posted]).toEqual([0, []]);
    expect(none.out.unchanged).toMatch(/no nil statement for 2026-10-10 is recorded/);
  });

  // The first live record (19 Nov 2026): the letting agent's own statement heads its payout line "TOTAL PAYMENTS TO
  // LANDLORD", which the phrase list did not hold, so the very statement 1354 was built for was refused.
  it('reads a statement that heads its payout line "Total payments to landlord"', () => {
    const quote = 'Example Lettings landlord statement, 01 Sep 2026 to 30 Sep 2026, emailed 8 Oct 2026: Total income £0.00, '
      + 'Total payments to landlord £0.00, Rent to be collected £0.00';
    const ok = door(ARGS('2026-10-10', quote));
    expect([ok.code, ok.readBack]).toEqual([0, ['2026-10-10']]);
    // A real payment under the same heading, with a nil elsewhere on the line, is still refused.
    const paid = door(ARGS('2026-10-10', 'Example Lettings statement, emailed 8 Oct 2026: Total payments to landlord £454.40, '
      + 'Rent to be collected £0.00'));
    expect([paid.code, paid.posted]).toEqual([2, []]);
    // "Rent to be collected £0.00" alone is not a payout line.
    const owed = door(ARGS('2026-10-10', 'Example Lettings statement, emailed 8 Oct 2026: Rent to be collected £0.00'));
    expect([owed.code, owed.posted]).toEqual([2, []]);
  });
});
