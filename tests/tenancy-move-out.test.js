// The move-out door: scripts/tenancy-record.py move-out (finding 20261118-agent-dispatch-1345).
//
// On 18 Nov 2026 Kevin approved a move-out as-is (tenancy ended, payment status cleared, tenant Former and
// off the unit, unit Void) and there was NO door for it: this file had no move-out command, the agent rules
// forbid ending a tenancy, voiding a unit or writing a tenant record by hand-rolled PATCH, and the Cash Flow
// Voids page's Moved out button only reaches a tenancy listed on that page. So the approved work sat for
// 1.3 days. This drives the REAL Python with the Airtable calls swapped for recorders.
//
// BACK-TEST: set TENANCY_RECORD_PY to a copy of the script from before the change and every test in the
// first two describes fails (argparse: "invalid choice: 'move-out'"), which is the bug this file catches.
//   git show HEAD:scripts/tenancy-record.py > /tmp/pre.py
//   TENANCY_RECORD_PY=/tmp/pre.py npx vitest run tests/tenancy-move-out.test.js
//
// Every record id, name, date and amount below is invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOOR = process.env.TENANCY_RECORD_PY || resolve(ROOT, 'scripts/tenancy-record.py');

const TEN = 'recTENANCY0000001';
const TASK = 'recTASK0000000001';
const TENANT = 'recTENANT00000001';
const UNIT = 'recUNIT0000000001';
const OTHER = 'recOTHERTEN000001';
const END = '2026-11-15';
const APPROVED = { outcome: 'Approved as-is', sentFor: ['recAGENT00000001'], approvedAt: '2026-11-18T10:42:00.000Z' };
const CARD = `The tenant has gone. If you approve:\nRECORD CHANGE: ${TEN} Move-out = ${END}`;
const EVIDENCE = 'keys handed back on 15 November and the room photographed empty';

// Runs one door command. `others` is {tenancyId: {end}} for the tenancies linked to the unit;
// `failAt` names a field whose PATCH silently does not land, so the read-back catches it.
function door(argv, { task = {}, tenancy = {}, tenant = {}, unit = {}, others = {}, tx = [],
                      failAt = null, preLedger = [] } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'tenancy-move-out-'));
  const cfg = {
    argv, dir, others, tx, failAt, preLedger, TEN, TASK, TENANT, UNIT,
    task: { name: 'INBOUND: the tenant has moved out', output: CARD, links: [TEN], feedback: '',
            approvalFeedback: '', created: '2026-11-18T08:00:00.000Z', ...APPROVED, ...task },
    tenancy: { status: 'CFV', end: null, start: '2025-01-01', unit: [UNIT], customers: [TENANT], ...tenancy },
    tenant: { name: 'A Tenant', status: 'Active', unit: [UNIT], ...tenant },
    unit: { name: 'Unit 1 - 18 Example Road', status: 'Occupied', tenancies: [], tenanciesCopy: [], ...unit },
  };
  const script = `
import importlib.util, json, sys, io, contextlib, os
cfg = json.loads(${JSON.stringify(JSON.stringify(cfg))})
os.environ["TENANCY_RECORD_LEDGER"] = cfg["dir"] + "/ledger.jsonl"
spec = importlib.util.spec_from_file_location("tr", ${JSON.stringify(DOOR)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.LEDGER = cfg["dir"] + "/ledger.jsonl"
if cfg["preLedger"]:
    with open(m.LEDGER, "w") as fh:
        for row in cfg["preLedger"]:
            fh.write(json.dumps(row) + "\\n")
rc = m.rc
UNIT_STATUS = "fldBvqysXBm9rIm0E"
UNIT_TEN, UNIT_TEN_COPY = "fldxOnUDg49C2PNVW", "fldmpIYp1cN0eQgWt"
UNIT_TENANTS_TEXT = "fldUs1pONuxxL6Mcm"
T_UNITS = "tblM3mZCR5kiEdWMj"
state = {"end": cfg["tenancy"]["end"], "status": cfg["tenancy"]["status"],
         "tenantStatus": cfg["tenant"]["status"], "tenantUnit": list(cfg["tenant"]["unit"]),
         "unitStatus": cfg["unit"]["status"]}
reads, writes, comments = [], [], []
def tenancy_row():
    return {"id": cfg["TEN"], "createdTime": "2025-01-01T00:00:00.000Z", "fields": {
        rc.TY["payStatus"]: state["status"], rc.TY["dueDay"]: "4", rc.TY["end"]: state["end"],
        rc.TY["rent"]: 500, rc.TY["start"]: cfg["tenancy"]["start"],
        rc.TY["tenants"]: cfg["tenancy"]["customers"], "fld7cjLLEHKAx49OK": cfg["tenancy"]["unit"]}}
def task_row():
    t = cfg["task"]
    f = {m.TK["name"]: t["name"], m.TK["agentOutput"]: t["output"], m.TK["tenancies"]: t["links"],
         m.TK["feedbackHistory"]: t["feedback"], m.TK["approvalFeedback"]: t["approvalFeedback"]}
    if t.get("outcome"): f[m.TK["approvalOutcome"]] = t["outcome"]
    if t.get("sentFor"): f["fld30Yw8SWYVp049g"] = t["sentFor"]
    if t.get("approvedAt"): f["fldr4Mvf2RzKvhZhi"] = t["approvedAt"]
    return {"id": cfg["TASK"], "createdTime": t["created"], "fields": f}
def tenant_row():
    return {"id": cfg["TENANT"], "fields": {"fldxBKW7QnujSDWqA": cfg["tenant"]["name"],
            "fldAXzP9SGIHiAhrv": state["tenantStatus"], "fldeLsZYqbKS77S2V": state["tenantUnit"]}}
def unit_row(fields=None):
    f = {"fldr8sliyu8h2jw9t": cfg["unit"]["name"], UNIT_STATUS: state["unitStatus"],
         UNIT_TEN: cfg["unit"]["tenancies"], UNIT_TEN_COPY: cfg["unit"]["tenanciesCopy"],
         UNIT_TENANTS_TEXT: "a stale name nothing maintains"}
    if fields is not None:
        f = {k: v for k, v in f.items() if k in fields}
    return {"id": cfg["UNIT"], "fields": f}
def fetch_all(table, params=None):
    p = params or {}
    formula = p.get("filterByFormula") or ""
    reads.append({"table": table, "formula": formula, "fields": p.get("fields[]")})
    if table == rc.T_TENANCIES:
        if cfg["TEN"] in formula:
            return [tenancy_row()]
        out = []
        for oid, o in cfg["others"].items():
            if oid in formula:
                out.append({"id": oid, "fields": {rc.TY["end"]: o.get("end"), m.REF: o.get("ref") or "REF/" + oid}})
        return out
    if table == rc.T_TASKS:
        return [task_row()] if cfg["TASK"] in formula else []
    if table == rc.T_TENANTS:
        return [tenant_row()] if cfg["TENANT"] in formula else []
    if table == T_UNITS:
        return [unit_row(p.get("fields[]"))] if cfg["UNIT"] in formula else []
    if table == rc.T_TX:
        return cfg["tx"]
    return []
def api(method, path, payload=None, params=None):
    if method == "PATCH":
        writes.append({"path": path, "fields": payload["fields"]})
        assert "typecast" not in payload, "a renamed choice must fail, never be created by typecast"
        f = payload["fields"]
        for key, field in (("end", rc.TY["end"]), ("status", rc.TY["payStatus"]),
                           ("tenantStatus", "fldAXzP9SGIHiAhrv"), ("tenantUnit", "fldeLsZYqbKS77S2V"),
                           ("unitStatus", UNIT_STATUS)):
            if field in f and cfg["failAt"] != key:
                state[key] = f[field] if f[field] is not None else ""
        return {}
    if method == "POST" and path.endswith("/comments"):
        comments.append(payload["text"]); return {"id": "comX"}
    if method == "GET" and path.endswith("/comments"):
        return {"comments": []}
    raise AssertionError("unexpected call " + method + " " + path)
rc.fetch_all = fetch_all
rc.api = api
buf = io.StringIO(); code = None; err = ""
try:
    with contextlib.redirect_stdout(buf):
        code = m.main(cfg["argv"])
except SystemExit as e:
    err = "SystemExit: " + str(e)
except Exception as e:
    err = str(e)
ledger = open(m.LEDGER).read().splitlines() if os.path.exists(m.LEDGER) else []
print(json.dumps({"code": code, "out": buf.getvalue(), "err": err, "reads": reads, "writes": writes,
                  "comments": comments, "ledger": ledger, "state": state}))
`;
  const res = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    .trim().split('\n').pop());
  res.json = (() => { try { return JSON.parse(res.out); } catch { return null; } })();
  return res;
}

const MOVE = (extra = []) => ['move-out', TEN, '--end', END, '--task', TASK, '--evidence', EVIDENCE, ...extra];

describe('tenancy-record.py move-out: it carries out the approved move-out', () => {
  it('writes all four changes in the declared order, reads each back, comments and logs it', () => {
    const r = door(MOVE());
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.writes.map(w => w.path)).toEqual([
      `tblN51a88qTDB6iMH/${TEN}`, `tblN51a88qTDB6iMH/${TEN}`, `tblX4elTuu01gwBYh/${TENANT}`, `tblM3mZCR5kiEdWMj/${UNIT}`,
    ]);
    expect(r.writes[0].fields).toEqual({ fldwHhhKAq4f1nY9e: END });
    expect(r.writes[1].fields).toEqual({ fldxU3dPUnbK0SCDq: null });
    expect(r.writes[2].fields).toEqual({ fldAXzP9SGIHiAhrv: 'Former', fldeLsZYqbKS77S2V: [] });
    expect(r.writes[3].fields).toEqual({ fldBvqysXBm9rIm0E: 'Void' });
    expect(r.state).toEqual({ end: END, status: '', tenantStatus: 'Former', tenantUnit: [], unitStatus: 'Void' });
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]).toMatch(/moved out 15 Nov 2026/);
    expect(r.comments[0]).toMatch(/six-question safety gate/);
    expect(r.comments[0]).toContain(TASK);
    expect(r.comments[0]).toContain('keys handed back');
    expect(JSON.parse(r.ledger[0])).toMatchObject({ kind: 'move-out', tenancy: TEN, task: TASK, end: END });
  });

  it('a dry run answers the gate and changes nothing', () => {
    const r = door(MOVE(['--dry-run']));
    expect(r.json).toMatchObject({ tenancy: TEN, end: END, unit: UNIT, dryRun: true });
    expect([...r.writes, ...r.comments, ...r.ledger]).toEqual([]);
  });

  it('a second run writes nothing new (the ledger keys it on the tenancy)', () => {
    const first = door(MOVE());
    expect(first.code).toBe(0);
    const again = door(MOVE(), { preLedger: first.ledger.map(l => JSON.parse(l)),
                                 tenancy: { end: END, status: '' }, tenant: { status: 'Former', unit: [] },
                                 unit: { status: 'Void' } });
    expect(again.code).toBe(2);
    expect(again.json.refused).toMatch(/was moved out already/);
    expect([...again.writes, ...again.comments]).toEqual([]);
  });
});

describe('tenancy-record.py move-out: the six-question safety gate, in code', () => {
  it('question 3: a unit with another LIVE tenancy on its Tenancies link is never voided', () => {
    const r = door(MOVE(), { unit: { tenancies: [OTHER] }, others: { [OTHER]: { end: null } } });
    expect(r.code).toBe(2);
    expect(r.json.refused).toMatch(/question 3 \(another live tenancy on the unit\)/);
    expect(r.json.refused).toContain(OTHER);
    expect([...r.writes, ...r.comments]).toEqual([]);
  });

  it('question 3: the Tenancies COPY link counts too (occupancy lives in both)', () => {
    const r = door(MOVE(), { unit: { tenanciesCopy: [OTHER] }, others: { [OTHER]: { end: null } } });
    expect(r.code).toBe(2);
    expect(r.json.refused).toMatch(/question 3 \(another live tenancy on the unit\)/);
    expect(r.writes).toEqual([]);
  });

  it('question 3: an ENDED other tenancy on the unit does not block it (the control)', () => {
    const r = door(MOVE(), { unit: { tenancies: [OTHER] }, others: { [OTHER]: { end: '2024-06-30' } } });
    expect(r.code).toBe(0);
    expect(r.writes).toHaveLength(4);
  });

  it('question 3: a tenancy on the unit that is not in the Tenancies table is a doubt, not "gone"', () => {
    const r = door(MOVE(), { unit: { tenancies: [OTHER] }, others: {} });
    expect(r.code).toBe(2);
    expect(r.json.refused).toMatch(/question 3 .*not in the Tenancies table/s);
    expect(r.writes).toEqual([]);
  });

  it('question 2: a tenancy with no rental unit linked refuses, and two units refuse', () => {
    const none = door(MOVE(), { tenancy: { unit: [] } });
    expect(none.code).toBe(2);
    expect(none.json.refused).toMatch(/question 2 \(is a rental unit linked\)/);
    const two = door(MOVE(), { tenancy: { unit: [UNIT, 'recUNIT0000000002'] } });
    expect(two.json.refused).toMatch(/question 2 \(is a rental unit linked\)/);
    expect([...none.writes, ...two.writes]).toEqual([]);
  });

  it('question 1: identity comes from the Customers link, and an unreadable or missing tenant refuses', () => {
    const noTenant = door(MOVE(), { tenancy: { customers: [] } });
    expect(noTenant.json.refused).toMatch(/question 1 \(whose tenancy is it\)/);
    const unreadable = door(MOVE(), { tenancy: { customers: ['recGHOSTTENANT001'] } });
    expect(unreadable.json.refused).toMatch(/question 1 .*is not in the Tenants table/s);
    expect([...noTenant.writes, ...unreadable.writes]).toEqual([]);
  });

  it('question 4: the unit\'s Tenants Field is never read as evidence', () => {
    const r = door(MOVE());
    const unitReads = r.reads.filter(x => x.table === 'tblM3mZCR5kiEdWMj');
    expect(unitReads.length).toBeGreaterThan(0);
    for (const read of unitReads) expect(read.fields).not.toContain('fldUs1pONuxxL6Mcm');
  });

  it('question 5: every record is proved by a list on its own table, never a GET by id', () => {
    const r = door(MOVE());
    for (const [table, id] of [['tblN51a88qTDB6iMH', TEN], ['tblqB8b22hKBL4PF1', TASK],
                               ['tblX4elTuu01gwBYh', TENANT], ['tblM3mZCR5kiEdWMj', UNIT]]) {
      expect(r.reads.some(x => x.table === table && (x.formula || '').includes(`RECORD_ID()='${id}'`)), table).toBe(true);
    }
  });

  it('question 6: a payment after the move-out date is read off the transaction\'s own Tenancy link and said', () => {
    const r = door(MOVE(), { tx: [{ id: 'recTX00000000001', fields: { fldPmAMmxwqs4SdPa: [TEN], fldoyQ6Rr9cHp3bgQ: '2026-11-20' } },
                                  { id: 'recTX00000000002', fields: { fldPmAMmxwqs4SdPa: [OTHER], fldoyQ6Rr9cHp3bgQ: '2026-11-21' } }] });
    expect(r.code).toBe(0);
    expect(r.json.paymentsAfterEnd).toEqual(['recTX00000000001']);
    expect(r.comments[0]).toMatch(/Payments dated after the move-out: recTX00000000001/);
  });
});

describe('tenancy-record.py move-out: what it refuses before any write', () => {
  it('refuses without real approval evidence: no approval, a typed outcome, an approval before the task', () => {
    const none = door(MOVE(), { task: { outcome: '', sentFor: null, approvedAt: null } });
    expect(none.json.refused).toMatch(/has not approved/);
    const typed = door(MOVE(), { task: { sentFor: null, approvedAt: null } });
    expect(typed.json.refused).toMatch(/never went through the approval gate/);
    const unrecorded = door(MOVE(), { task: { approvedAt: null } });
    expect(unrecorded.json.refused).toMatch(/no approval was ever recorded/);
    const copied = door(MOVE(), { task: { approvedAt: '2026-11-17T09:00:00.000Z' } });
    expect(copied.json.refused).toMatch(/earlier than the task itself/);
    expect([...none.writes, ...typed.writes, ...unrecorded.writes, ...copied.writes]).toEqual([]);
  });

  it('refuses a card approved for a DIFFERENT tenancy, a different date, or with no Move-out line', () => {
    const other = door(MOVE(), { task: { output: `RECORD CHANGE: ${OTHER} Move-out = ${END}` } });
    expect(other.json.refused).toMatch(/has no line 'RECORD CHANGE/);
    const date = door(MOVE(), { task: { output: `RECORD CHANGE: ${TEN} Move-out = 2026-10-31` } });
    expect(date.json.refused).toMatch(/has no line 'RECORD CHANGE/);
    const nothing = door(MOVE(), { task: { output: 'The tenant has gone, please end the tenancy.' } });
    expect(nothing.json.refused).toMatch(/has no line 'RECORD CHANGE/);
    const edits = door(MOVE(), { task: { outcome: 'Approved with minor edits' } });
    expect(edits.json.refused).toMatch(/not Approved as-is/);
    expect([...other.writes, ...date.writes, ...nothing.writes, ...edits.writes]).toEqual([]);
  });

  it('refuses a future date, a date before the tenancy began, a different end date already on the record, and thin evidence', () => {
    const future = door(['move-out', TEN, '--end', '2099-01-01', '--task', TASK, '--evidence', EVIDENCE]);
    expect(future.json.refused).toMatch(/in the future/);
    const early = door(MOVE(), { tenancy: { start: '2026-12-01' } });
    expect(early.json.refused).toMatch(/before tenancy .* began/);
    const already = door(MOVE(), { tenancy: { end: '2026-09-30' } });
    expect(already.json.refused).toMatch(/already ended on 2026-09-30/);
    const thin = door(['move-out', TEN, '--end', END, '--task', TASK, '--evidence', 'gone']);
    expect(thin.json.refused).toMatch(/--evidence needs/);
    expect([...future.writes, ...early.writes, ...already.writes, ...thin.writes]).toEqual([]);
  });
});

describe('tenancy-record.py move-out: a half-done move-out is never reported as success', () => {
  it('a read-back that fails part way says exactly what landed and what did not, and stops', () => {
    const r = door(MOVE(), { failAt: 'tenantStatus' });
    expect(r.code).toBe(1);
    expect(r.json.failed).toMatch(/did not land/);
    expect(r.json.failed).toMatch(/End Date 2026-11-15/);
    expect(r.json.failed).toMatch(/Payment Status cleared/);
    expect(r.json.failed).toMatch(/NOT confirmed: tenant/);
    // The unit was never touched: the room is not void while the tenant still reads Active.
    expect(r.writes.map(w => w.path)).not.toContain(`tblM3mZCR5kiEdWMj/${UNIT}`);
    expect(r.state.unitStatus).toBe('Occupied');
    expect(r.comments).toEqual([]);
    const rows = r.ledger.map(l => JSON.parse(l));
    expect(rows.map(x => x.kind)).toEqual(['partial']);
    expect(rows[0].done).toEqual([`tenancy ${TEN} End Date ${END}`, `tenancy ${TEN} Payment Status cleared`]);
  });

  it('a unit whose Void does not land is a failure, not a success', () => {
    const r = door(MOVE(), { failAt: 'unitStatus' });
    expect(r.code).toBe(1);
    expect(r.json.failed).toMatch(/Void did not land/);
    expect(r.comments).toEqual([]);
    expect(r.ledger.map(l => JSON.parse(l).kind)).toEqual(['partial']);
  });
});
