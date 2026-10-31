import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// THE COST-LINE GATE (Kevin, 31 Oct 2026): "When we get new insurance policies coming through ... we
// need to ensure that gets picked up ... creating a cost record so it goes into the reconciliation."
// Four policies bought in October never became a cost. Two cards were approved with "due NOT FOUND |
// first NOT FOUND | ends NOT FOUND" in the RECORD NEW COST line, which cost-record.py cannot write,
// and a home insurance policy was bought on a task that closed with no cost line at all. Every case
// drives the real Python: cost-record.py's owed_new_costs and agent-dispatch.py's cmd_complete.
// The shapes are the live cards'; every name, reference and amount is invented.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const DOOR = resolve(SCRIPTS, 'cost-record.py');
const DISPATCH = resolve(SCRIPTS, 'agent-dispatch.py');
const TASK = 'recTaskCostOwed01';

function py(path, body) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, os, sys, tempfile
os.environ["COST_RECORD_LEDGER"] = os.path.join(tempfile.mkdtemp(), "ledger.jsonl")
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def boom(*a, **k): raise RuntimeError("network call in a test")
import urllib.request; urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(path)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}
`], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const DATED = 'RECORD NEW COST: Example Cover - REF 99AA000001 - 1 Sample Street | 10.29 | Monthly | due 15 | first 2026-11-15 | ends 2027-07-15';
const UNDATED = 'RECORD NEW COST: Example Cover - MUL0000001 - 1 Sample Street | 10.29 | Monthly | due NOT FOUND | first NOT FOUND | ends NOT FOUND (the 9th instalment)';
const OWN_PURCHASE = '[29 Oct 2026 13:06 — Kevin] BLOCKER CLEARED (KEVIN purchase): evidence: bought in the robot\'s window';
const QUOTED_PURCHASE = '- 29 Oct 2026 13:06 — agent: BLOCKER CLEARED (KEVIN purchase): evidence: bought in the robot\'s window';

const owed = (output, notes = '', names = [], ledger = []) => py(DOOR, `
print(json.dumps(m.owed_new_costs(${JSON.stringify(TASK)}, ${JSON.stringify(output)}, ${JSON.stringify(notes)},
                                  ${JSON.stringify(names)}, ${JSON.stringify(ledger)})))`);

describe('what an approved card still owes the Costs table', () => {
  it('a dated line already in the Costs table owes nothing (control)', () => {
    expect(owed(`THE ASK: approve the cost line.\n${DATED}`, '', ['Example Cover - REF 99AA000001 - 1 Sample Street'])).toEqual([]);
  });

  it('a dated line nobody wrote is owed', () => {
    const r = owed(`THE ASK: approve the cost line.\n${DATED}`, '', ['Some other cost']);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/was approved and is not in the Costs table/);
  });

  it('a line with NOT FOUND dates can never be written, so it is owed and points at the first payment', () => {
    const r = owed(`THE ASK: approve the cost line.\n${UNDATED}`, '', ['Some other cost']);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/cannot be written/);
    expect(r[0]).toMatch(/cost-record\.py payments --payee/);
  });

  it('a cost this task created and someone renamed since is still answered by the ledger', () => {
    const ledger = [{ kind: 'create', task: TASK, name: 'Example Cover - REF 99AA000001 - 1 Sample Street', cost: 'recCostRenamed001' }];
    expect(owed(DATED, '', ['Example Cover (renamed by hand)'], ledger)).toEqual([]);
    // Another task's create is not this card's answer.
    expect(owed(DATED, '', ['Example Cover (renamed by hand)'], [{ ...ledger[0], task: 'recTaskSomeoneElse' }])).toHaveLength(1);
  });

  it('a cleared purchase step on the task itself, with no cost line, is owed', () => {
    const r = owed('DONE: Kevin bought the policy.', `earlier notes\n\n${OWN_PURCHASE}`);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/Kevin bought something on this task/);
  });

  it('a purchase quoted from ANOTHER task in the track record is not this task\'s purchase', () => {
    expect(owed('CLOSE PROPOSAL: already handled', `TRACK RECORD\n${QUOTED_PURCHASE}`)).toEqual([]);
  });

  it('a cost line quoted in the track record is not an approved line', () => {
    expect(owed(`CLOSE PROPOSAL: already handled\n- 29 Oct 2026 — agent: FIXED COST: ${UNDATED}`)).toEqual([]);
  });
});

describe('complete refuses a task whose card still owes a cost', () => {
  const complete = ({ output, notes = '', names = [], why = '', readFails = false }) => py(DISPATCH, `
import types, io, contextlib
AF = m.AF
state = {AF["name"]: "COMPLIANCE: insurance schedule - 1 Sample Street", AF["status"]: "Today",
         AF["approvalOutcome"]: "Approved as-is", AF["taskType"]: "Admin", AF["notes"]: ${JSON.stringify(notes)},
         AF["agentOutput"]: ${JSON.stringify(output)}}
m.get_task = lambda t: {"id": t, "createdTime": "2026-10-29T09:00:00.000Z", "fields": dict(state)}
def patch(t, f):
    state.update(f)
    return {"id": t}
m.patch_task = patch
m.ledger_append = lambda *a, **k: None
reads = []
def costs(table, formula=None, fields=None, max_records=None):
    reads.append(table)
    if ${readFails ? 'True' : 'False'}: raise RuntimeError("Airtable GET 503")
    cr = m._cost_record()
    return [{"id": "recCost%010d" % i, "fields": {cr.COST_NAME: n}} for i, n in enumerate(${JSON.stringify(names)})]
m.query_records = costs
try:
    with contextlib.redirect_stdout(io.StringIO()):
        m.cmd_complete(types.SimpleNamespace(task=${JSON.stringify(TASK)}, keep_open=False, note="", no_certificate="",
                                             evidence="", not_signed="", diary_not_written="",
                                             cost_not_written=${JSON.stringify(why)}))
    print(json.dumps({"status": state.get(AF["status"]), "notes": state.get(AF["notes"]), "reads": reads}))
except SystemExit as e:
    print(json.dumps({"exit": str(e), "reads": reads}))`);

  it('refused while the approved NOT FOUND line is unwritten (the RightSure cards)', () => {
    const r = complete({ output: `THE ASK: approve the cost line.\n${UNDATED}`, names: ['Some other cost'] });
    expect(r.exit).toMatch(/still owes the Costs table/);
    expect(r.exit).toMatch(/--cost-not-written/);
  });

  it('refused when Kevin bought on this task and no cost line was approved (the home insurance task)', () => {
    const r = complete({ output: 'YOUR TURN: buy only if one beats the renewal.', notes: OWN_PURCHASE, names: ['Some other cost'] });
    expect(r.exit).toMatch(/Kevin bought something on this task/);
  });

  it('closes once the cost is in the table (control)', () => {
    const r = complete({ output: `THE ASK: approve the cost line.\n${DATED}`, names: ['Example Cover - REF 99AA000001 - 1 Sample Street'] });
    expect(r.status).toBe('Completed');
  });

  it('closes without a cost only with the reason on the record', () => {
    const r = complete({ output: 'YOUR TURN: buy the fridges.', notes: OWN_PURCHASE, why: 'one-off purchase, no recurring cost' });
    expect(r.status).toBe('Completed');
    expect(r.notes).toMatch(/COST NOT WRITTEN: one-off purchase, no recurring cost/);
  });

  it('an unreadable Costs table refuses, never clears', () => {
    const r = complete({ output: `THE ASK: approve the cost line.\n${DATED}`, readFails: true });
    expect(r.exit).toMatch(/could not be read/);
  });

  it('an ordinary task with no cost line and no purchase closes without reading the Costs table', () => {
    const r = complete({ output: 'Sent the email Kevin approved.' });
    expect(r.status).toBe('Completed');
    expect(r.reads).toEqual([]);
  });
});
