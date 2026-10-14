// The gated door through which an agent changes or adds a fixed cost record (9 Oct 2026, finding
// 20261007-agent-dispatch-789; widened 14 Oct 2026, Kevin: every recurring cost goes in with its end date,
// and a lapsed policy is marked inactive, so the reports stay true).
//
// Kevin approved a subscription downgrade and the card said the robot would then update the cost
// record, but no command wrote the Costs table, so the record kept the old price. Then a card he approved
// promised a new insurance finance line whose last payment is 28 Jun 2027, and the row that was added had no
// End Date. Drives the REAL Python (scripts/cost-record.py) with the Airtable calls swapped for recorders.
// The fixtures are shaped from the live rows of 14 Oct 2026; every record id, name and amount is invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs, { readFileSync } from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOOR = resolve(ROOT, 'scripts/cost-record.py');
const COST = 'recCOST0000000001';
const OTHER = 'recCOST0000000002';
const TASK = 'recTASK0000000001';
const APPROVED = { outcome: 'Approved as-is', sentFor: ['recAGENT00000001'], approvedAt: '2026-10-07T20:09:00.000Z' };
const LINE = `If you approve, the cost record changes:\nRECORD CHANGE: ${COST} Expected Cost = 16.36`;

const F = {
  name: 'fldS6FYfpkhu6tJG0', expected: 'fld9JibXkMpTeMcxw', dueDay: 'fld7IsfiGvKpxEwSs', payStatus: 'fldXZNI96v8HgjuSh',
  inactive: 'fldQJPGLFMbwVelsW', end: 'fldhTpqQsVAnHpTCz', statusNew: 'fldWl7mp9zTC2aaaQ', frequency: 'fldvozTHvs5VH3lNi',
  subCat: 'fldRO90pSCj6ahVMC', category: 'fldv3szZSuR2fWBFt', business: 'fldrPjvdFPCKWqeyd', property: 'fld7nikJBPz3BoZJG',
  lastRecon: 'fldeMdOxYemcJwVRD', dueDate: 'fldmAaI8NSpBUjYQi',
};
const BIZ = 'recBIZ00000000001';
const CAT = 'recCAT00000000001';
const SUB = 'recSUB00000000001';
const PROP = 'recPROP0000000001';
const NEWID = 'recNEWC0000000001';
const KNOWN = { tblpqkvWJJo8Uu25q: [BIZ], tbleWb8ioptnEwPR8: [CAT], tblOTdRcPf8AgRz25: [SUB], tbl6f0OkAmTC2jbuG: [PROP] };

// `cost` is the main row's fields by name (name, expected) plus `fields` keyed by field id; `rows` are more Costs rows.
function door(argv, { task = {}, cost = {}, rows = [], lands = true, costExists = true, createLands = true, ledger = [] } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'cost-record-'));
  if (ledger.length) fs.writeFileSync(join(dir, 'ledger.jsonl'), ledger.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const main = { name: 'Video tool', expected: 23.32, ...cost };
  const costs = [
    ...(costExists ? [{ id: COST, fields: { [F.name]: main.name, [F.expected]: main.expected, ...(main.fields || {}) } }] : []),
    ...rows,
  ];
  const cfg = {
    argv, dir, lands, createLands, COST, TASK, NEWID, KNOWN, costs,
    task: { name: 'Fixed cost saving: drop a video tool to its cheaper plan', output: '', created: '2026-10-05T08:00:00.000Z', ...task },
  };
  const script = `
import importlib.util, json, os, io, contextlib
cfg = json.loads(${JSON.stringify(JSON.stringify(cfg))})
os.environ["COST_RECORD_LEDGER"] = cfg["dir"] + "/ledger.jsonl"
spec = importlib.util.spec_from_file_location("cr", ${JSON.stringify(DOOR)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.LEDGER = cfg["dir"] + "/ledger.jsonl"
rc, tr = m.rc, m.tr
costs = cfg["costs"]
reads, writes, creates, comments = [], [], [], []
def task_row():
    t = cfg["task"]
    f = {tr.TK["name"]: t["name"], tr.TK["agentOutput"]: t["output"]}
    if t.get("outcome"): f[tr.TK["approvalOutcome"]] = t["outcome"]
    if t.get("sentFor"): f["fld30Yw8SWYVp049g"] = t["sentFor"]
    if t.get("approvedAt"): f["fldr4Mvf2RzKvhZhi"] = t["approvedAt"]
    return {"id": cfg["TASK"], "createdTime": t["created"], "fields": f}
def fetch_all(table, params=None):
    formula = (params or {}).get("filterByFormula") or ""
    reads.append({"table": table, "formula": formula})
    if table == m.T_COSTS:
        return [dict(r) for r in costs if not formula or r["id"] in formula]
    if table == rc.T_TASKS:
        return [task_row()] if cfg["TASK"] in formula else []
    return [{"id": x, "fields": {}} for x in cfg["KNOWN"].get(table, []) if x in formula]
def api(method, path, payload=None, params=None):
    if method == "PATCH":
        writes.append({"path": path, "payload": payload})
        if cfg["lands"]:
            row = next(r for r in costs if path.endswith(r["id"]))
            row["fields"].update(payload["fields"])
        return {}
    if method == "POST" and path == m.T_COSTS:
        creates.append(payload)
        if cfg["createLands"]:
            costs.append({"id": cfg["NEWID"], "fields": dict(payload["fields"])})
        return {"id": cfg["NEWID"]}
    if method == "POST" and path.endswith("/comments"):
        comments.append({"path": path, "text": payload["text"]}); return {"id": "comX"}
    if method == "GET" and path.endswith("/comments"):
        return {"comments": []}
    raise AssertionError("unexpected call " + method + " " + path)
rc.fetch_all = fetch_all
rc.api = api
buf = io.StringIO(); code = None; err = ""
try:
    with contextlib.redirect_stdout(buf):
        code = m.main(cfg["argv"])
except Exception as e:
    err = repr(e)
ledger = open(m.LEDGER).read().splitlines() if os.path.exists(m.LEDGER) else []
main = next((r for r in costs if r["id"] == cfg["COST"]), {"fields": {}})
print(json.dumps({"code": code, "out": buf.getvalue(), "err": err, "reads": reads, "writes": writes, "creates": creates,
                  "comments": comments, "ledger": ledger, "costs": costs,
                  "state": {"expected": main["fields"].get(m.COST_EXPECTED), "fields": main["fields"]}}))
`;
  const res = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
  res.json = (() => { try { return JSON.parse(res.out); } catch { return null; } })();
  return res;
}
const expected = (value, extra = {}) => door(['expected', COST, value, '--task', TASK, '--why', 'The plan drops to Business from 24 Oct 2026'], extra);

describe('cost-record.py: what it refuses', () => {
  it('a task Kevin has not approved, and an approval string with no approval marks', () => {
    const none = expected('16.36', { task: { output: LINE } });
    expect(none.code).toBe(2);
    expect(none.json.refused).toMatch(/has not approved/);
    const typed = expected('16.36', { task: { outcome: 'Approved as-is', output: LINE } });
    expect(typed.code).toBe(2);
    expect(typed.json.refused).toMatch(/never went through the approval gate/);
    expect([...none.writes, ...typed.writes, ...none.comments, ...typed.comments]).toEqual([]);
  });

  it('an approval with minor edits: the card may not say what he read', () => {
    const r = expected('16.36', { task: { ...APPROVED, outcome: 'Approved with minor edits', output: LINE } });
    expect(r.code).toBe(2);
    expect(r.json.refused).toMatch(/was Approved with minor edits, not Approved as-is/);
    expect(r.writes).toEqual([]);
  });

  it('a line for another cost, or for another amount', () => {
    const other = expected('16.36', { task: { ...APPROVED, output: `RECORD CHANGE: ${OTHER} Expected Cost = 16.36` } });
    expect(other.code).toBe(2);
    expect(other.json.refused).toMatch(new RegExp(`has no line 'RECORD CHANGE: ${COST} Expected Cost = 16.36'`));
    const amount = expected('18.00', { task: { ...APPROVED, output: LINE } });
    expect(amount.code).toBe(2);
    expect(amount.json.refused).toMatch(/has no line/);
    expect([...other.writes, ...amount.writes]).toEqual([]);
  });

  it('a line written by the agent above an approved card (a YOUR STEP block) is not his approval', () => {
    const output = `YOUR STEP: confirm the plan change\nRECORD CHANGE: ${COST} Expected Cost = 16.36\n` +
      "----- The agent's work, as you approved it -----\nThe plan was changed. Nothing about the cost record.";
    const r = expected('16.36', { task: { ...APPROVED, output } });
    expect(r.code).toBe(2);
    expect(r.json.refused).toMatch(/has no line/);
    expect(r.writes).toEqual([]);
  });

  it('proves the cost by a list on the Costs table, never a GET by id', () => {
    const r = expected('16.36', { task: { ...APPROVED, output: LINE }, costExists: false });
    expect(r.code).toBe(2);
    expect(r.json.refused).toMatch(/is not a cost/);
    expect(r.reads[0]).toEqual({ table: 'tblx5kvhzNEI5TFlS', formula: `RECORD_ID()='${COST}'` });
    expect(r.writes).toEqual([]);
  });

  it('a nonsense or zero amount, and a --why with no reason', () => {
    for (const v of ['0', '-5', 'sixteen', '16.367']) {
      const r = expected(v, { task: { ...APPROVED, output: LINE } });
      expect(r.code).toBe(2);
      expect(r.json.refused).toMatch(/must be a pounds amount above zero/);
    }
    const why = door(['expected', COST, '16.36', '--task', TASK, '--why', 'ok'], { task: { ...APPROVED, output: LINE } });
    expect(why.json.refused).toMatch(/--why needs the reason/);
  });
});

describe('cost-record.py: the approved change', () => {
  it('writes Expected Cost as a Number, reads it back, comments with the date and the task, and logs it', () => {
    const r = expected('£16.36', { task: { ...APPROVED, output: LINE } });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([{ path: `tblx5kvhzNEI5TFlS/${COST}`, payload: { fields: { fld9JibXkMpTeMcxw: 16.36 } } }]);
    expect(r.state.expected).toBe(16.36);
    expect(r.json).toMatchObject({ cost: COST, from: '£23.32', to: '£16.36', task: TASK, commented: true });
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0].path).toBe(`tblx5kvhzNEI5TFlS/${COST}/comments`);
    expect(r.comments[0].text).toMatch(/^\d{2} \w{3} \d{4} \d{2}:\d{2}: Expected Cost changed from £23\.32 to £16\.36 /);
    expect(r.comments[0].text).toContain(`task ${TASK}`);
    expect(r.comments[0].text).toContain('Why: The plan drops to Business from 24 Oct 2026');
    expect(r.ledger).toHaveLength(1);
    expect(JSON.parse(r.ledger[0])).toMatchObject({ kind: 'write', cost: COST, to: '£16.36', task: TASK });
  });

  it('a write that does not land fails loudly and leaves no comment', () => {
    const r = expected('16.36', { task: { ...APPROVED, output: LINE }, lands: false });
    expect(r.code).toBe(1);
    expect(r.json.failed).toMatch(/the write did not land/);
    expect(r.comments).toEqual([]);
    expect(JSON.parse(r.ledger[0]).kind).toBe('unlanded');
  });

  it('a dry run and an unchanged value write nothing', () => {
    const dry = door(['expected', COST, '16.36', '--task', TASK, '--why', 'The plan drops to Business from 24 Oct 2026', '--dry-run'],
      { task: { ...APPROVED, output: LINE } });
    expect(dry.code).toBe(0);
    expect(dry.json).toMatchObject({ dryRun: true, from: '£23.32', to: '£16.36' });
    const same = expected('16.36', { task: { ...APPROVED, output: LINE }, cost: { expected: 16.36 } });
    expect(same.json.unchanged).toBe(true);
    expect([...dry.writes, ...same.writes, ...dry.comments, ...same.comments]).toEqual([]);
  });
});

const WHY = 'The policy was replaced by the new one Kevin bought';
const end = (value, extra = {}) => door(['end', COST, value, '--task', TASK, '--why', WHY], extra);
const inactive = (extra = {}) => door(['inactive', COST, '--task', TASK, '--why', WHY], extra);
// Shaped from the 3 Oct 2026 insurance finance card: a new monthly line whose last payment is 28 Jun 2027.
const NEW_ARGS = ['new', '--name', 'Premium finance - Example Road insurance - REF EX-011', '--expected', '31.27',
  '--frequency', 'Monthly', '--due-day', '28', '--first-payment', '2026-10-28'];
const NEW_LINE = 'RECORD NEW COST: Premium finance - Example Road insurance - REF EX-011 | £31.27 | Monthly | due 28 | first 2026-10-28 | ends 2027-06-28';
const create = (args, extra = {}) => door([...NEW_ARGS, ...args, '--task', TASK, '--why', WHY], extra);

describe('cost-record.py end: the date of the last payment, on an approved line', () => {
  const line = `RECORD CHANGE: ${COST} End Date = 2027-06-28`;

  it('writes the date, reads it back, comments and logs it', () => {
    const r = end('2027-06-28', { task: { ...APPROVED, output: line } });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([{ path: `tblx5kvhzNEI5TFlS/${COST}`, payload: { fields: { [F.end]: '2027-06-28' } } }]);
    expect(r.json).toMatchObject({ cost: COST, field: 'End Date', from: 'blank', to: '2027-06-28', commented: true });
    expect(r.comments[0].text).toMatch(/End Date \(the last payment\) changed from blank to 2027-06-28 .*task recTASK0000000001/);
    expect(JSON.parse(r.ledger[0])).toMatchObject({ kind: 'write', field: 'End Date', to: '2027-06-28' });
  });

  it('refuses with no line, a line for another date, an unapproved card, or a date that is not a real day', () => {
    const none = end('2027-06-28', { task: { ...APPROVED, output: `RECORD CHANGE: ${COST} Expected Cost = 16.36` } });
    expect(none.json.refused).toMatch(new RegExp(`has no line 'RECORD CHANGE: ${COST} End Date = 2027-06-28'`));
    const other = end('2027-07-28', { task: { ...APPROVED, output: line } });
    expect(other.json.refused).toMatch(/has no line/);
    const unapproved = end('2027-06-28', { task: { output: line } });
    expect(unapproved.json.refused).toMatch(/has not approved/);
    for (const v of ['28/06/2027', '2027-02-30', 'June']) {
      expect(end(v, { task: { ...APPROVED, output: line } }).json.refused).toMatch(/must be a real date written YYYY-MM-DD/);
    }
    expect([...none.writes, ...other.writes, ...unapproved.writes]).toEqual([]);
  });

  it('a write that does not land fails loudly; the same date again writes nothing', () => {
    const lost = end('2027-06-28', { task: { ...APPROVED, output: line }, lands: false });
    expect(lost.code).toBe(1);
    expect(lost.json.failed).toMatch(/the write did not land/);
    expect(lost.comments).toEqual([]);
    const same = end('2027-06-28', { task: { ...APPROVED, output: line }, cost: { fields: { [F.end]: '2027-06-28' } } });
    expect(same.json.unchanged).toBe(true);
    expect(same.writes).toEqual([]);
  });
});

describe('cost-record.py end = none: a cost that rolls on with no end leaves the daily list', () => {
  const line = `RECORD CHANGE: ${COST} End Date = none`;

  it('clears the date (writes null, reads back blank) only on a card that says none', () => {
    const r = end('none', { task: { ...APPROVED, output: line }, cost: { fields: { [F.end]: '2026-08-26' } } });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([{ path: `tblx5kvhzNEI5TFlS/${COST}`, payload: { fields: { [F.end]: null } } }]);
    expect(r.json).toMatchObject({ from: '2026-08-26', to: 'none', commented: true });
    expect(r.comments[0].text).toMatch(/changed from 2026-08-26 to blank \(no end date\)/);
    const dated = end('none', { task: { ...APPROVED, output: `RECORD CHANGE: ${COST} End Date = 2027-08-26` }, cost: { fields: { [F.end]: '2026-08-26' } } });
    expect(dated.json.refused).toMatch(/has no line 'RECORD CHANGE: recCOST0000000001 End Date = none'/);
    const split = end('none', { task: { ...APPROVED, output: `RECORD CHANGE: ${COST} End Date =\nnone` }, cost: { fields: { [F.end]: '2026-08-26' } } });
    expect(split.json.refused).toMatch(/has no line/);
    expect(split.writes).toEqual([]);
    const blank = end('none', { task: { ...APPROVED, output: line } });
    expect(blank.json.unchanged).toBe(true);
    expect([...dated.writes, ...blank.writes]).toEqual([]);
  });
});

describe('cost-record.py amounts: an annual premium keeps its comma', () => {
  it('£1,234.50 and £ 31.27 read as amounts; a broken comma does not', () => {
    const big = expected('£1,234.50', { task: { ...APPROVED, output: `RECORD CHANGE: ${COST} Expected Cost = £1,234.50` } });
    expect(big.code).toBe(0);
    expect(big.writes[0].payload.fields[F.expected]).toBe(1234.5);
    const top = expected('9,999,999.99', { task: { ...APPROVED, output: `RECORD CHANGE: ${COST} Expected Cost = £9,999,999.99` } });
    expect(top.code).toBe(0);
    const spaced = expected('31.27', { task: { ...APPROVED, output: `RECORD CHANGE: ${COST} Expected Cost = £ 31.27` } });
    expect(spaced.code).toBe(0);
    for (const v of ['1,23', '0,500', '1,234,567,890.00', '10,000,000', '£,5', '1.234,56']) {
      expect(expected(v, { task: { ...APPROVED, output: LINE } }).json.refused, v).toMatch(/must be a pounds amount above zero/);
    }
  });
});

describe('cost-record.py inactive: an ended cost leaves every report, and says when it ended', () => {
  const line = `RECORD CHANGE: ${COST} Payment Status = Inactive`;

  it('sets both status fields, reads them back, comments with the last payment', () => {
    const r = inactive({ task: { ...APPROVED, output: line }, cost: { fields: { [F.payStatus]: 'Overdue', [F.end]: '2026-08-11' } } });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([{ path: `tblx5kvhzNEI5TFlS/${COST}`, payload: { fields: { [F.payStatus]: 'Inactive', [F.statusNew]: 'Inactive' } } }]);
    expect(r.json).toMatchObject({ from: 'Overdue', to: 'Inactive', commented: true });
    expect(r.comments[0].text).toMatch(/marked Inactive \(was Overdue; last payment 2026-08-11\)/);
  });

  it('refuses a cost with no End Date, even on an approved line', () => {
    const r = inactive({ task: { ...APPROVED, output: line }, cost: { fields: { [F.payStatus]: 'In Payment' } } });
    expect(r.code).toBe(2);
    expect(r.json.refused).toMatch(/has no End Date: an ended cost says when its last payment was/);
    expect(r.writes).toEqual([]);
  });

  it('refuses with no line, and any other status on the line is not this approval', () => {
    const fields = { [F.payStatus]: 'In Payment', [F.end]: '2026-10-01' };
    const none = inactive({ task: { ...APPROVED, output: `RECORD CHANGE: ${COST} End Date = 2026-10-01` }, cost: { fields } });
    expect(none.json.refused).toMatch(/has no line 'RECORD CHANGE: recCOST0000000001 Payment Status = Inactive'/);
    const paused = inactive({ task: { ...APPROVED, output: `RECORD CHANGE: ${COST} Payment Status = Paused` }, cost: { fields } });
    expect(paused.json.refused).toMatch(/has no line/);
    expect([...none.writes, ...paused.writes]).toEqual([]);
  });

  it('a write that does not land fails loudly; an inactive cost is left alone', () => {
    const fields = { [F.payStatus]: 'In Payment', [F.end]: '2026-10-01' };
    const lost = inactive({ task: { ...APPROVED, output: line }, cost: { fields }, lands: false });
    expect(lost.code).toBe(1);
    expect(lost.json.failed).toMatch(/the write did not land/);
    const done = inactive({ task: { ...APPROVED, output: line },
      cost: { fields: { [F.payStatus]: 'Inactive', [F.statusNew]: 'Inactive', [F.end]: '2026-10-01' } } });
    expect(done.json.unchanged).toBe(true);
    expect(done.writes).toEqual([]);
  });
});

// The ledger line a landed create writes (cmd_new's `out`), shaped from NEW_LINE.
const LOGGED = { kind: 'create', cost: NEWID, task: TASK, name: 'Premium finance - Example Road insurance - REF EX-011',
  expectedCost: '£31.27', frequency: 'Monthly', dueDay: 28, firstPayment: '2026-10-28', endDate: '2027-06-28' };

describe('cost-record.py new: a recurring cost goes in with its end, on an approved line', () => {
  const links = { [F.business]: [BIZ], [F.category]: [CAT], [F.subCat]: [SUB], [F.property]: [PROP] };
  const old = { name: 'Premium finance - Example Road insurance - REF EX-010', fields: { [F.payStatus]: 'Inactive', ...links } };

  it('creates the cost In Payment with its End Date, copying the links from the cost it replaces', () => {
    const r = create(['--end-date', '2027-06-28', '--like', COST], { task: { ...APPROVED, output: NEW_LINE }, cost: old });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.creates).toEqual([{ fields: {
      [F.name]: 'Premium finance - Example Road insurance - REF EX-011', [F.expected]: 31.27, [F.frequency]: 'Monthly',
      [F.dueDay]: '28', [F.dueDate]: '2026-10-28', [F.payStatus]: 'In Payment', [F.statusNew]: 'In Payment', ...links,
      [F.end]: '2027-06-28',
    } }]);
    expect(r.json).toMatchObject({ cost: NEWID, endDate: '2027-06-28', commented: true });
    expect(r.comments[0].path).toBe(`tblx5kvhzNEI5TFlS/${NEWID}/comments`);
    expect(r.comments[0].text).toMatch(/created by an agent \(£31\.27 Monthly, due 28, first payment 2026-10-28, last payment 2027-06-28\)/);
    expect(JSON.parse(r.ledger[0])).toMatchObject({ kind: 'create', cost: NEWID, task: TASK });
  });

  it('refuses a cost that does not say how it ends', () => {
    const neither = create([], { task: { ...APPROVED, output: NEW_LINE }, cost: old });
    expect(neither.json.refused).toMatch(/say how the cost ends: --end-date YYYY-MM-DD \(the last payment\) or --no-end-date/);
    const both = create(['--end-date', '2027-06-28', '--no-end-date'], { task: { ...APPROVED, output: NEW_LINE }, cost: old });
    expect(both.json.refused).toMatch(/say how the cost ends/);
    expect([...neither.creates, ...both.creates]).toEqual([]);
  });

  it('the card must say the same end: "no end date" on the card is not an end date in the command, nor the reverse', () => {
    const open = NEW_LINE.replace('ends 2027-06-28', 'no end date');
    const r1 = create(['--end-date', '2027-06-28', '--like', COST], { task: { ...APPROVED, output: open }, cost: old });
    expect(r1.json.refused).toMatch(/has no line 'RECORD NEW COST: .* \| ends 2027-06-28'/);
    const r2 = create(['--no-end-date', '--like', COST], { task: { ...APPROVED, output: NEW_LINE }, cost: old });
    expect(r2.json.refused).toMatch(/\| no end date'/);
    const r3 = create(['--no-end-date', '--like', COST], { task: { ...APPROVED, output: open }, cost: old });
    expect(r3.code).toBe(0);
    expect(r3.creates[0].fields[F.end]).toBeUndefined();
    expect([...r1.creates, ...r2.creates]).toEqual([]);
  });

  it('refuses a different amount, due day or frequency from the card, and an unapproved card', () => {
    const amount = door(['new', '--name', 'Premium finance - Example Road insurance - REF EX-011', '--expected', '36.27',
      '--frequency', 'Monthly', '--due-day', '28', '--first-payment', '2026-10-28', '--end-date', '2027-06-28', '--like', COST,
      '--task', TASK, '--why', WHY], { task: { ...APPROVED, output: NEW_LINE }, cost: old });
    expect(amount.json.refused).toMatch(/has no line/);
    const quarterly = door(['new', '--name', 'Premium finance - Example Road insurance - REF EX-011', '--expected', '31.27',
      '--frequency', 'Quarterly', '--due-day', '28', '--first-payment', '2026-10-28', '--end-date', '2027-06-28', '--like', COST,
      '--task', TASK, '--why', WHY], { task: { ...APPROVED, output: NEW_LINE }, cost: old });
    expect(quarterly.json.refused).toMatch(/has no line/);
    const unapproved = create(['--end-date', '2027-06-28', '--like', COST], { task: { output: NEW_LINE }, cost: old });
    expect(unapproved.json.refused).toMatch(/has not approved/);
    expect([...amount.creates, ...quarterly.creates, ...unapproved.creates]).toEqual([]);
  });

  it('refuses a name the table already holds, whatever its case or spacing', () => {
    const r = create(['--end-date', '2027-06-28', '--like', COST], { task: { ...APPROVED, output: NEW_LINE }, cost: old,
      rows: [{ id: 'recCOST0000000003', fields: { [F.name]: 'premium finance -  Example Road insurance - REF EX-011' } }] });
    expect(r.json.refused).toMatch(/already exists \(recCOST0000000003\)/);
    expect(r.creates).toEqual([]);
  });

  it('a re-run of the same approved create answers with the row it made, and makes no second one', () => {
    const made = { id: NEWID, fields: { [F.name]: 'Premium finance - Example Road insurance - REF EX-011' } };
    const r = create(['--end-date', '2027-06-28', '--like', COST], { task: { ...APPROVED, output: NEW_LINE }, cost: old,
      rows: [made], ledger: [LOGGED] });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ cost: NEWID, unchanged: true });
    expect(r.creates).toEqual([]);
  });

  it('a re-run after the new row was renamed still answers from the ledger, and makes no second cost', () => {
    const renamed = { id: NEWID, fields: { [F.name]: 'Example Road insurance (renamed by hand)' } };
    const r = create(['--end-date', '2027-06-28', '--like', COST], { task: { ...APPROVED, output: NEW_LINE }, cost: old,
      rows: [renamed], ledger: [LOGGED] });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ cost: NEWID, unchanged: true });
    expect(r.creates).toEqual([]);
  });

  it('a re-run on the same task with different terms refuses, never a silent "unchanged"', () => {
    const made = { id: NEWID, fields: { [F.name]: 'Premium finance - Example Road insurance - REF EX-011' } };
    const logged = LOGGED;
    const same = create(['--end-date', '2027-06-28', '--like', COST], { task: { ...APPROVED, output: NEW_LINE }, cost: old, rows: [made], ledger: [logged] });
    expect(same.json).toMatchObject({ cost: NEWID, unchanged: true });
    const dearer = door(['new', '--name', 'Premium finance - Example Road insurance - REF EX-011', '--expected', '36.27',
      '--frequency', 'Monthly', '--due-day', '28', '--first-payment', '2026-10-28', '--end-date', '2027-06-28', '--like', COST,
      '--task', TASK, '--why', WHY], { task: { ...APPROVED, output: NEW_LINE.replace('£31.27', '£36.27') }, cost: old, rows: [made], ledger: [logged] });
    expect(dearer.code).toBe(2);
    expect(dearer.json.refused).toMatch(/this task already created recNEWC0000000001 as £31\.27.*a RECORD CHANGE line/);
    expect([...same.creates, ...dearer.creates]).toEqual([]);
  });

  it('a retired cost of the same name still blocks the name: the new one carries its own policy number', () => {
    const r = create(['--end-date', '2027-06-28', '--like', COST], { task: { ...APPROVED, output: NEW_LINE }, cost: old,
      rows: [{ id: 'recCOST0000000004', fields: { [F.name]: 'Premium finance - Example Road insurance - REF EX-011', [F.payStatus]: 'Inactive' } }] });
    expect(r.json.refused).toMatch(/already exists \(recCOST0000000004\).*a policy number tells two apart/);
    expect(r.creates).toEqual([]);
  });

  it('refuses a cost with no business, category or sub-category, and a link that is not a record of its table', () => {
    const bare = create(['--end-date', '2027-06-28'], { task: { ...APPROVED, output: NEW_LINE } });
    expect(bare.json.refused).toMatch(/needs its business, category, sub-category/);
    const wrong = create(['--end-date', '2027-06-28', '--like', COST, '--property', 'recNOTAPROPERTY01'],
      { task: { ...APPROVED, output: NEW_LINE }, cost: old });
    expect(wrong.json.refused).toMatch(/--property 'recNOTAPROPERTY01' is not a record in its table/);
    expect([...bare.creates, ...wrong.creates]).toEqual([]);
  });

  it('a create that does not read back as approved fails loudly', () => {
    const r = create(['--end-date', '2027-06-28', '--like', COST], { task: { ...APPROVED, output: NEW_LINE }, cost: old, createLands: false });
    expect(r.code).toBe(1);
    expect(r.json.failed).toMatch(/the write did not land as approved/);
    expect(r.comments).toEqual([]);
    expect(JSON.parse(r.ledger[0]).kind).toBe('unlanded');
  });
});

// Shaped from the 7 counted costs past their End Date on 14 Oct 2026: 3 still paid well after it (renewed),
// 4 whose last payment landed on or a day after it (ended). Names, ids and amounts invented.
const ENDED_ROWS = [
  { id: 'recEND0000000001', fields: { [F.name]: 'Block policy A', [F.expected]: 77.3, [F.payStatus]: 'Overdue', [F.end]: '2026-08-11', [F.lastRecon]: '2026-09-16' } },
  { id: 'recEND0000000002', fields: { [F.name]: 'Block policy B', [F.expected]: 70.7, [F.payStatus]: 'In Payment', [F.end]: '2026-08-26', [F.lastRecon]: '2026-10-12' } },
  { id: 'recEND0000000003', fields: { [F.name]: 'Council debt plan', [F.expected]: 100, [F.payStatus]: 'In Payment', [F.end]: '2026-09-20', [F.lastRecon]: '2026-09-21' } },
  { id: 'recEND0000000004', fields: { [F.name]: 'Home policy', [F.expected]: 64.81, [F.payStatus]: 'In Payment', [F.end]: '2026-10-01', [F.lastRecon]: '2026-10-01' } },
  // Not listed: inside the 5-day grace, in the future, no End Date, Inactive, Paused, the Inactive tick.
  { id: 'recEND0000000005', fields: { [F.name]: 'Ends inside grace', [F.expected]: 9, [F.payStatus]: 'In Payment', [F.end]: '2026-10-09' } },
  { id: 'recEND0000000006', fields: { [F.name]: 'Ends next year', [F.expected]: 45.3, [F.payStatus]: 'In Payment', [F.end]: '2027-02-02' } },
  { id: 'recEND0000000007', fields: { [F.name]: 'No end', [F.expected]: 12, [F.payStatus]: 'In Payment' } },
  { id: 'recEND0000000008', fields: { [F.name]: 'Retired', [F.expected]: 20, [F.payStatus]: 'Inactive', [F.end]: '2025-12-10' } },
  { id: 'recEND0000000009', fields: { [F.name]: 'Paused', [F.expected]: 20, [F.payStatus]: 'Paused', [F.end]: '2025-12-10' } },
  { id: 'recEND0000000010', fields: { [F.name]: 'Ticked', [F.expected]: 20, [F.payStatus]: 'In Payment', [F.inactive]: true, [F.end]: '2025-12-10' } },
];

function endedOn(today, rows = ENDED_ROWS) {
  const script = `
import importlib.util, json
from datetime import date
spec = importlib.util.spec_from_file_location("cr", ${JSON.stringify(DOOR)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.ended_costs(json.loads(${JSON.stringify(JSON.stringify(rows))}), date.fromisoformat("${today}"))))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
}

describe('cost-record.py ended: counted costs past their End Date, listed for judgement and never dropped', () => {
  it('lists exactly the counted costs more than 5 days past their End Date, and flags a payment well after it', () => {
    const out = endedOn('2026-10-14');
    expect(out.map((c) => c.cost)).toEqual(['recEND0000000001', 'recEND0000000002', 'recEND0000000003', 'recEND0000000004']);
    expect(Object.fromEntries(out.map((c) => [c.cost, c.paidAfterEnd]))).toEqual({
      recEND0000000001: true, recEND0000000002: true, recEND0000000003: false, recEND0000000004: false,
    });
  });

  it('the grace boundary: listed on the sixth day after the End Date, not the fifth', () => {
    const one = [ENDED_ROWS[4]];
    expect(endedOn('2026-10-14', one)).toEqual([]);
    expect(endedOn('2026-10-15', one).map((c) => c.cost)).toEqual(['recEND0000000005']);
  });

  it('the ended command reads every cost and totals what is still counted', () => {
    const r = door(['ended'], { costExists: false, rows: ENDED_ROWS });
    expect(r.code).toBe(0);
    expect(r.reads).toEqual([{ table: 'tblx5kvhzNEI5TFlS', formula: '' }]);
    expect(r.json.activeCosts).toBe(7);
    expect(r.json.ended.length).toBeGreaterThan(0);
    const total = r.json.ended.reduce((sum, c) => sum + c.expectedCost, 0);
    expect(r.json.monthlyStillCounted).toBeCloseTo(total, 2);
  });

  it('a read with no active cost fails loudly, never "nothing ended"', () => {
    const r = door(['ended'], { costExists: false, rows: ENDED_ROWS.slice(7) });
    expect(r.code).toBe(1);
    expect(r.json.failed).toMatch(/control failed: 3 costs read and none counted as active/);
  });
});

describe('cost-record.py: its active rule is the dashboard\'s', () => {
  it('is_active agrees with isCostActive in js/shared.js on every status, run both sides', () => {
    const shared = readFileSync(resolve(ROOT, 'js/shared.js'), 'utf8');
    const fn = (name) => {
      const at = shared.indexOf(`function ${name}(`);
      let depth = 0;
      for (let k = shared.indexOf('{', at); k < shared.length; k++) {
        if (shared[k] === '{') depth++;
        if (shared[k] === '}' && --depth === 0) return shared.slice(at, k + 1);
      }
      throw new Error(`${name} not found in js/shared.js`);
    };
    const ctx = { F: { costInactive: F.inactive, costPayStatus: F.payStatus } };
    vm.runInNewContext(`${fn('getField')}\n${fn('getPaymentStatusName')}\n${fn('isCostActive')}\nthis.isCostActive = isCostActive;`, ctx);
    const cases = [
      {}, { [F.payStatus]: 'In Payment' }, { [F.payStatus]: 'Overdue' }, { [F.payStatus]: 'Paused' },
      { [F.payStatus]: 'Inactive' }, { [F.payStatus]: 'In Payment', [F.inactive]: true }, { [F.payStatus]: { name: 'Overdue' } },
    ];
    const js = cases.map((fields) => ctx.isCostActive({ fields }));
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("cr", ${JSON.stringify(DOOR)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.is_active(f) for f in json.loads(${JSON.stringify(JSON.stringify(cases))})]))
`;
    const py = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
    expect(js).toEqual([false, true, true, false, false, false, true]);
    expect(py).toEqual(js);
  });
});

describe('cost-record.py: ids come from js/config.js', () => {
  it('the Costs table and field ids match config.js (drift guard)', () => {
    const cfg = readFileSync(resolve(ROOT, 'js/config.js'), 'utf8');
    const src = readFileSync(DOOR, 'utf8');
    const pick = (re) => { const m = cfg.match(re); expect(m, String(re)).not.toBeNull(); return m[1]; };
    const want = {
      T_COSTS: pick(/\bcosts:\s*'(tbl[A-Za-z0-9]+)'/),
      T_PROPERTIES: pick(/\bproperties:\s*'(tbl[A-Za-z0-9]+)'/),
      T_CATEGORIES: pick(/\bcategories:\s*'(tbl[A-Za-z0-9]+)'/),
      T_SUBCATEGORIES: pick(/\bsubCategories:\s*'(tbl[A-Za-z0-9]+)'/),
      T_BUSINESSES: pick(/\bbusinesses:\s*'(tbl[A-Za-z0-9]+)'/),
      COST_NAME: pick(/\bcostName:\s*'(fld[A-Za-z0-9]+)'/),
      COST_EXPECTED: pick(/\bcostExpected:\s*'(fld[A-Za-z0-9]+)'/),
      COST_DUE_DAY: pick(/\bcostDueDay:\s*'(fld[A-Za-z0-9]+)'/),
      COST_PAY_STATUS: pick(/\bcostPayStatus:\s*'(fld[A-Za-z0-9]+)'/),
      COST_INACTIVE: pick(/\bcostInactive:\s*'(fld[A-Za-z0-9]+)'/),
      COST_END: pick(/\bcostEndDate:\s*'(fld[A-Za-z0-9]+)'/),
      COST_STATUS_NEW: pick(/\bcostStatusNew:\s*'(fld[A-Za-z0-9]+)'/),
      COST_FREQUENCY: pick(/\bcostFrequency:\s*'(fld[A-Za-z0-9]+)'/),
      COST_SUBCAT: pick(/\bcostSubCategory:\s*'(fld[A-Za-z0-9]+)'/),
      COST_CATEGORY: pick(/\bcostCategory:\s*'(fld[A-Za-z0-9]+)'/),
      COST_BUSINESS: pick(/\bcostBusiness:\s*'(fld[A-Za-z0-9]+)'/),
      COST_PROPERTY: pick(/\bcostProperty:\s*'(fld[A-Za-z0-9]+)'/),
      COST_LAST_RECON: pick(/\bcostLastReconDate:\s*'(fld[A-Za-z0-9]+)'/),
    };
    for (const [name, id] of Object.entries(want)) {
      expect(src, name).toMatch(new RegExp(`^${name} = "${id}"`, 'm'));
    }
  });
});
