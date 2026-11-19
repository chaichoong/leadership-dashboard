// A WEEKLY COST DUE ON A WEEKDAY, AND AN INFORMATIONAL MINOR-EDIT NOTE
// (19 Nov 2026, finding 20261119-agent-dispatch-1365, which blocked task recxGMGN6lP5kceWH)
//
// Kevin approved Roy's pay as a cost line and it could not be written by any route:
//   1. He approved it "with minor edits" and his note was INFORMATION (Roy now emails info@), not an edit.
//      `new` and `complete` demand that the note has been applied, and `agent-dispatch.py revise` refuses a
//      text identical to the one he approved. Deadlock.
//   2. The approved line read `due Friday` in backticks. --due-day took 1 to 31 only, and NEW_RE was anchored
//      hard to the start of the line, so the line matched NOTHING: `owed` answered [] and a close would have
//      passed with the cost unwritten, which is exactly the check `owed` exists to make.
//
// Drives the REAL Python (scripts/cost-record.py) with the Airtable calls swapped for recorders. Every record
// id, name and amount below is invented; the shapes are the live card's.
//
// BACK-TEST: set COST_RECORD_PY to another copy of the script to run these cases against it, e.g.
//   git show HEAD:scripts/cost-record.py > <dir>/cost-record.py   (beside symlinks to the other scripts/ files,
//   which the module loads from its own directory) then COST_RECORD_PY=<dir>/cost-record.py npx vitest run
//   tests/cost-record-weekly-and-revise.test.js
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOOR = process.env.COST_RECORD_PY || resolve(ROOT, 'scripts/cost-record.py');
const SCRIPTS = resolve(ROOT, 'scripts');
const COST = 'recCOST0000000001';
const TASK = 'recTASK0000000001';
const NEWID = 'recNEWC0000000001';
const BIZ = 'recBIZ00000000001';
const CAT = 'recCAT00000000001';
const SUB = 'recSUB00000000001';
const KNOWN = { tblpqkvWJJo8Uu25q: [BIZ], tbleWb8ioptnEwPR8: [CAT], tblOTdRcPf8AgRz25: [SUB], tbl6f0OkAmTC2jbuG: [] };
const F = { name: 'fldS6FYfpkhu6tJG0', dueDay: 'fld7IsfiGvKpxEwSs', dueDate: 'fldmAaI8NSpBUjYQi' };

// The card Kevin approved: a weekly cost whose due field names a weekday.
const WEEKLY_LINE = 'RECORD NEW COST: Example weekly pay - sample | 250 | Weekly | due Friday | first 2026-11-20 | no end date';
const WEEKLY_TICKED = '`RECORD NEW COST: Example weekly pay - sample | 250 | Weekly | `due Friday` | first 2026-11-20 | no end date`';
const APPROVED_AT = '2026-11-19T06:00:00.000Z';
const APPROVED = { outcome: 'Approved as-is', sentFor: ['recAGENT00000001'], approvedAt: APPROVED_AT };
// What `agent-dispatch.py revise` (and now `note-applied`) writes into Notes when the note has been applied.
const applied = (text, extra = 'no text change needed. Roy now emails info@, which changes nothing in the line.') =>
  `[19 Nov 2026 07:00 — agent] EDITS APPLIED: ${extra}\n\n--- TEXT KEVIN APPROVED, BEFORE THE EDIT ---\n${text}`;

// Loads the module and runs `body`, with no network and a throwaway ledger (tests/agent-dispatch-cost-owed.test.js).
function py(body) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, os, sys, tempfile
os.environ["COST_RECORD_LEDGER"] = os.path.join(tempfile.mkdtemp(), "ledger.jsonl")
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def boom(*a, **k): raise RuntimeError("network call in a test")
import urllib.request; urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(DOOR)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}
`], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const owed = (output, notes = '', names = [], ledger = []) => py(`
print(json.dumps(m.owed_new_costs(${JSON.stringify(TASK)}, ${JSON.stringify(output)}, ${JSON.stringify(notes)},
                                  ${JSON.stringify(names)}, ${JSON.stringify(ledger)})))`);

// The CLI, shaped from tests/cost-record.test.js's harness, with the Tasks table writable (note-applied).
function door(argv, { task = {}, createLands = true, ledger = [] } = {}) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'cost-weekly-'));
  if (ledger.length) fs.writeFileSync(join(dir, 'ledger.jsonl'), ledger.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const cfg = {
    argv, dir, COST, TASK, NEWID, KNOWN, createLands,
    task: { name: 'PAYMENT: weekly pay for the property business', output: '', created: '2026-11-18T08:00:00.000Z', ...task },
  };
  const script = `
import importlib.util, json, os, io, contextlib
cfg = json.loads(${JSON.stringify(JSON.stringify(cfg))})
os.environ["COST_RECORD_LEDGER"] = cfg["dir"] + "/ledger.jsonl"
spec = importlib.util.spec_from_file_location("cr", ${JSON.stringify(DOOR)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.LEDGER = cfg["dir"] + "/ledger.jsonl"
rc, tr = m.rc, m.tr
costs = [{"id": cfg["COST"], "fields": {m.COST_NAME: "An existing cost"}}]
t = dict(cfg["task"])
reads, writes, creates, comments = [], [], [], []
def task_row():
    f = {tr.TK["name"]: t["name"], tr.TK["agentOutput"]: t["output"]}
    if t.get("outcome"): f[tr.TK["approvalOutcome"]] = t["outcome"]
    if t.get("sentFor"): f["fld30Yw8SWYVp049g"] = t["sentFor"]
    if t.get("approvedAt"): f["fldr4Mvf2RzKvhZhi"] = t["approvedAt"]
    if t.get("feedback"): f[tr.TK["approvalFeedback"]] = t["feedback"]
    if t.get("notes"): f[tr.TK["notes"]] = t["notes"]
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
    if method == "PATCH" and path.startswith(rc.T_TASKS):
        writes.append({"path": path, "payload": payload})
        for k, v in payload["fields"].items():
            if k == tr.TK["notes"]: t["notes"] = v
        return {"id": cfg["TASK"]}
    if method == "PATCH":
        writes.append({"path": path, "payload": payload})
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
except SystemExit as e:
    code = e.code if isinstance(e.code, int) else 2
    err = "SystemExit: " + str(e.code)
except Exception as e:
    err = repr(e)
made = next((r for r in costs if r["id"] == cfg["NEWID"]), {"fields": {}})
print(json.dumps({"code": code, "out": buf.getvalue(), "err": err, "writes": writes, "creates": creates,
                  "comments": comments, "notes": t.get("notes") or "",
                  "ledger": open(m.LEDGER).read().splitlines() if os.path.exists(m.LEDGER) else [],
                  "made": made["fields"]}))
`;
  const res = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim().split('\n').pop());
  res.json = (() => { try { return JSON.parse(res.out); } catch { return null; } })();
  return res;
}

const NEW_WEEKLY = ['new', '--name', 'Example weekly pay - sample', '--expected', '250', '--frequency', 'Weekly',
  '--due-day', 'Friday', '--first-payment', '2026-11-20', '--no-end-date', '--business', BIZ, '--category', CAT,
  '--sub-category', SUB, '--task', TASK, '--why', 'Kevin approved the weekly pay line, due every Friday'];

describe('a weekly cost due on a weekday', () => {
  it('a card line saying `due Friday`, in backticks or not, is read as the first payment\'s day of the month', () => {
    for (const line of [WEEKLY_LINE, WEEKLY_TICKED]) {
      const parsed = py(`
m_line = [x for x in m.NEW_RE.finditer(${JSON.stringify(line)})]
print(json.dumps({"matched": len(m_line),
                  "spec": m.parse_new_line(m_line[0].group("body")) if m_line else None}, default=str))`);
      expect(parsed.matched).toBe(1);                       // the line is seen at all (it was not, in backticks)
      expect(parsed.spec).toMatchObject({ dueDay: 20, dueWeekday: 'Friday', frequency: 'Weekly',
        first: '2026-11-20', end: '' });                    // 20 Nov 2026 is the Friday of the first payment
    }
  });

  it('writes Due Day 20 and keeps "Friday" in words in the output, the comment and the ledger', () => {
    const r = door(NEW_WEEKLY, { task: { ...APPROVED, output: `THE ASK: approve the cost line.\n${WEEKLY_TICKED}` } });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ cost: NEWID, dueDay: 20, dueWeekday: 'Friday' });
    expect(r.made[F.dueDay]).toBe('20');                    // Airtable's Due Day is a 1-31 single select
    expect(r.made[F.dueDate]).toBe('2026-11-20');
    expect(r.comments[0].text).toMatch(/due 20 \(every Friday, the weekday the card named\)/);
    expect(r.ledger.join('\n')).toMatch(/"dueWeekday": "Friday"/);
  });

  it('a numeric due day of 1 to 31 still works exactly as before (control)', () => {
    const line = 'RECORD NEW COST: Example monthly policy - sample | 31.27 | Monthly | due 28 | first 2026-10-28 | ends 2027-06-28';
    const r = door(['new', '--name', 'Example monthly policy - sample', '--expected', '31.27', '--frequency', 'Monthly',
      '--due-day', '28', '--first-payment', '2026-10-28', '--end-date', '2027-06-28', '--business', BIZ,
      '--category', CAT, '--sub-category', SUB, '--task', TASK, '--why', 'The approved premium finance line'],
    { task: { ...APPROVED, output: line } });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ cost: NEWID, dueDay: 28, dueWeekday: null, endDate: '2027-06-28' });
    expect(r.made[F.dueDay]).toBe('28');
    expect(r.comments[0].text).toMatch(/due 28, first payment 2026-10-28/);
    expect(r.comments[0].text).not.toMatch(/weekday/);
    for (const bad of ['0', '32', 'Fridays']) {             // and a due day no reading gives is still refused
      const no = door(['new', '--name', 'x', '--expected', '10', '--frequency', 'Weekly', '--due-day', bad,
        '--first-payment', '2026-11-20', '--no-end-date', '--task', TASK, '--why', 'checking the gate refuses it'],
      { task: { ...APPROVED, output: line } });
      expect(no.code).toBe(2);
      expect(no.json.refused).toMatch(/--due-day/);
      expect(no.creates).toEqual([]);
    }
  });

  it('a weekly cost with no first payment yet is refused, never written as NOT FOUND', () => {
    const r = door(['new', '--name', 'Example weekly pay - sample', '--expected', '250', '--frequency', 'Weekly',
      '--due-day', 'Friday', '--first-payment', 'NOT FOUND', '--no-end-date', '--business', BIZ, '--category', CAT,
      '--sub-category', SUB, '--task', TASK, '--why', 'The first payment is not in the bank yet'],
    { task: { ...APPROVED, output: WEEKLY_LINE } });
    expect(r.code).toBe(2);
    expect(r.json.refused).toMatch(/--first-payment must be a real date/);
    expect(r.creates).toEqual([]);
    // and the same line on a card: it cannot be read, so the task still owes the cost
    const undated = 'RECORD NEW COST: Example weekly pay - sample | 250 | Weekly | due Friday | first NOT FOUND | no end date';
    const o = owed(undated, '', [['Another cost', 5]]);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatch(/cannot be written/);
    expect(o[0]).toMatch(/cost-record\.py payments --payee/);
  });

  it('a weekday that is not the first payment\'s weekday is refused, not guessed', () => {
    const r = door(['new', '--name', 'Example weekly pay - sample', '--expected', '250', '--frequency', 'Weekly',
      '--due-day', 'Monday', '--first-payment', '2026-11-20', '--no-end-date', '--business', BIZ, '--category', CAT,
      '--sub-category', SUB, '--task', TASK, '--why', 'Testing the two readings of one date must agree'],
    { task: { ...APPROVED, output: WEEKLY_LINE } });
    expect(r.code).toBe(2);
    expect(r.json.refused).toMatch(/first payment 2026-11-20 is a Friday/);
    expect(r.creates).toEqual([]);
  });
});

describe('owed never answers "nothing owed" about a line it could not read', () => {
  it('an approved cost line the parser cannot see is reported, so the task cannot close', () => {
    const labelled = `THE COST LINE: ${WEEKLY_LINE}`;     // a prefix NEW_RE does not read
    const r = owed(`THE ASK: approve the weekly pay line.\n${labelled}`, '', [['Another cost', 5]]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/names a RECORD NEW COST but cannot be read as one/);
    expect(r[0]).toMatch(/does not close on an unread line/);
  });

  it('the backticked line IS read, and owed says the cost is not in the table yet', () => {
    const r = owed(`THE ASK: approve the weekly pay line.\n${WEEKLY_TICKED}`, '', [['Another cost', 5]]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/was approved and is not in the Costs table/);
    // CONTROL: once the cost is there at that price, nothing is owed
    expect(owed(WEEKLY_TICKED, '', [['Example weekly pay - sample', 250]])).toEqual([]);
  });

  it('a cost line quoted from another task in the track record is still not this card\'s line (control)', () => {
    const quoted = '- 29 Oct 2026 13:06 — agent: FIXED COST: RECORD NEW COST: Old policy | 10.29 | Monthly | due 15 | first 2026-11-15 | ends 2027-07-15';
    expect(owed(`CLOSE PROPOSAL: already handled\n${quoted}`, '', [['Another cost', 5]])).toEqual([]);
  });
});

describe('a minor-edits note that is information, not an edit', () => {
  const INFO = 'Roy now emails info@, not his own address.';
  const CARD = `THE ASK: approve the cost line.\n${WEEKLY_TICKED}`;
  const EDITED = { ...APPROVED, outcome: 'Approved with minor edits', feedback: INFO, output: CARD };
  const noteApplied = (text, task) => {
    const f = join(fs.mkdtempSync(join(os.tmpdir(), 'cost-note-')), 'card.txt');
    fs.writeFileSync(f, text);
    return door(['note-applied', TASK, '--output-file', f, '--why',
      'His note is information: the card says nothing about where Roy emails, so no line changed'], { task });
  };

  it('is recorded as applied with the agent\'s reason in words, and `new` then proceeds', () => {
    const blocked = door(NEW_WEEKLY, { task: EDITED });
    expect(blocked.code).toBe(2);                           // the deadlock this fixes: nothing could be written
    expect(blocked.json.refused).toMatch(/has not been applied/);
    expect(blocked.json.refused).toMatch(/cost-record\.py note-applied/);

    const rec = noteApplied(CARD, EDITED);
    expect(rec.code).toBe(0);
    expect(rec.json).toMatchObject({ task: TASK, recorded: true, textChanged: false });
    expect(rec.json.reason).toMatch(/His note is information/);
    expect(rec.writes).toHaveLength(1);
    expect(rec.notes).toMatch(/EDITS APPLIED: no text change needed\./);
    expect(rec.notes).toMatch(/His note is information/);   // the words are stored, never a silent bypass
    expect(rec.notes).toMatch(/Roy now emails info@/);      // beside Kevin's own note
    expect(rec.notes).toMatch(/--- TEXT KEVIN APPROVED, BEFORE THE EDIT ---/);
    expect(rec.ledger.join('\n')).toMatch(/"kind": "note-applied"/);

    // the line can now be written, and only because the reason is on the record
    const r = door(NEW_WEEKLY, { task: { ...EDITED, notes: rec.notes } });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ cost: NEWID, dueDay: 20, dueWeekday: 'Friday' });
  });

  it('REFUSES when the texts genuinely differ: a real edit still goes through revise', () => {
    const r = noteApplied(`${CARD}\nAnd one more line the agent added.`, EDITED);
    expect(r.code).toBe(2);
    expect(r.json.refused).toMatch(/his note changed something, so it is a real edit/);
    expect(r.json.refused).toMatch(/agent-dispatch\.py revise/);
    expect(r.writes).toEqual([]);
    expect(r.notes).toBe('');
  });

  it('refuses a card that is not Approved with minor edits, or carries no note, or has an empty text', () => {
    const asIs = noteApplied(CARD, { ...APPROVED, output: CARD });
    expect(asIs.code).toBe(2);
    expect(asIs.json.refused).toMatch(/not Approved with minor edits/);
    const noNote = noteApplied(CARD, { ...EDITED, feedback: '' });
    expect(noNote.code).toBe(2);
    expect(noNote.json.refused).toMatch(/carries no note/);
    const empty = noteApplied('   ', EDITED);
    expect(empty.code).toBe(2);
    expect(empty.json.refused).toMatch(/--output-file is empty/);
    expect([...asIs.writes, ...noNote.writes, ...empty.writes]).toEqual([]);
  });

  it('says so, and writes nothing, when the note is already recorded as applied', () => {
    const r = noteApplied(CARD, { ...EDITED, notes: applied(CARD) });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ unchanged: true });
    expect(r.writes).toEqual([]);
  });
});
