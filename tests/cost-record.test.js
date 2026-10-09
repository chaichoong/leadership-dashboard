// The gated door through which an agent changes a fixed cost's Expected Cost (9 Oct 2026,
// finding 20261007-agent-dispatch-789).
//
// Kevin approved a subscription downgrade and the card said the robot would then update the cost
// record, but no command wrote the Costs table, so the record kept the old price. Drives the REAL
// Python (scripts/cost-record.py) with the Airtable calls swapped for recorders. Every record id,
// name and amount below is invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs, { readFileSync } from 'node:fs';
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

function door(argv, { task = {}, cost = {}, lands = true, costExists = true } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'cost-record-'));
  const cfg = {
    argv, dir, lands, costExists, COST, TASK,
    task: { name: 'Fixed cost saving: drop a video tool to its cheaper plan', output: '', created: '2026-10-05T08:00:00.000Z', ...task },
    cost: { name: 'Video tool', expected: 23.32, ...cost },
  };
  const script = `
import importlib.util, json, os, io, contextlib
cfg = json.loads(${JSON.stringify(JSON.stringify(cfg))})
os.environ["COST_RECORD_LEDGER"] = cfg["dir"] + "/ledger.jsonl"
spec = importlib.util.spec_from_file_location("cr", ${JSON.stringify(DOOR)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.LEDGER = cfg["dir"] + "/ledger.jsonl"
rc, tr = m.rc, m.tr
state = {"expected": cfg["cost"]["expected"]}
reads, writes, comments = [], [], []
def cost_row():
    return {"id": cfg["COST"], "fields": {m.COST_NAME: cfg["cost"]["name"], m.COST_EXPECTED: state["expected"]}}
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
        return [cost_row()] if (cfg["costExists"] and cfg["COST"] in formula) else []
    if table == rc.T_TASKS:
        return [task_row()] if cfg["TASK"] in formula else []
    return []
def api(method, path, payload=None, params=None):
    if method == "PATCH":
        writes.append({"path": path, "payload": payload})
        if cfg["lands"]:
            state["expected"] = payload["fields"][m.COST_EXPECTED]
        return {}
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
print(json.dumps({"code": code, "out": buf.getvalue(), "err": err, "reads": reads, "writes": writes,
                  "comments": comments, "ledger": ledger, "state": state}))
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

describe('cost-record.py: ids come from js/config.js', () => {
  it('the Costs table and field ids match config.js (drift guard)', () => {
    const cfg = readFileSync(resolve(ROOT, 'js/config.js'), 'utf8');
    const src = readFileSync(DOOR, 'utf8');
    const pick = (re) => { const m = cfg.match(re); expect(m, String(re)).not.toBeNull(); return m[1]; };
    const want = {
      T_COSTS: pick(/\bcosts:\s*'(tbl[A-Za-z0-9]+)'/),
      COST_NAME: pick(/\bcostName:\s*'(fld[A-Za-z0-9]+)'/),
      COST_EXPECTED: pick(/\bcostExpected:\s*'(fld[A-Za-z0-9]+)'/),
      COST_DUE_DAY: pick(/\bcostDueDay:\s*'(fld[A-Za-z0-9]+)'/),
      COST_PAY_STATUS: pick(/\bcostPayStatus:\s*'(fld[A-Za-z0-9]+)'/),
      COST_INACTIVE: pick(/\bcostInactive:\s*'(fld[A-Za-z0-9]+)'/),
    };
    for (const [name, id] of Object.entries(want)) {
      expect(src, name).toMatch(new RegExp(`^${name} = "${id}"`, 'm'));
    }
  });
});
