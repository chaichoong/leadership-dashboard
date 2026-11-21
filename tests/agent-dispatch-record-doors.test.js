import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// TWO RECORDS KEVIN APPROVED CHANGING, OUTSIDE THE TASKS TABLE.
//
// Both findings are the same shape: he approved a change to a record that is not a task, no agent
// door could make it, and the carry-out rules forbid a hand-rolled Airtable write. So the work sat.
//   - 20261011-agent-dispatch-832 (34 days, task recPoUouP5OgTtA3G): delete the 60 repeat RECORDING
//     BRIEF rows, keeping the oldest per title. There was no gated delete command at all.
//   - 20261015-agent-dispatch-917 (38 days, task rec8nPucxweLqCF0e): on one tenant, field Notes,
//     delete line 1 and keep lines 2 and 3 word for word. No door writes or deletes tenant Notes.
//
// `delete-rows` and `record-field` are the two doors, on the same evidence bar as --approved-on:
// his approval read LIVE off the task, his words word for word on it, those words naming the thing,
// and an allowlist in the code of what may ever be touched. These tests drive the real
// cmd_delete_rows and cmd_record_field against an in-memory Airtable. Every id, name and value here
// is invented; the tenant lines stand in for personal identifiers and name nobody.
//
// THE BACK-TEST. Every test below fails on the code before this change: cmd_delete_rows and
// cmd_record_field do not exist, so the module has no such attribute. Prove it without a stash:
//   git show HEAD:scripts/agent-dispatch.py > /tmp/pre.py
//   DISPATCH_PY=/tmp/pre.py npx vitest run tests/agent-dispatch-record-doors.test.js

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = process.env.DISPATCH_PY
  ? resolve(process.env.DISPATCH_PY)
  : resolve(ROOT, 'scripts/agent-dispatch.py');

// The harness of tests/agent-dispatch-approved-elsewhere.test.js, with the two tables these doors
// touch added: query_records and _request are mocked, so a DELETE or a PATCH is state, not network.
const PRE = `
import importlib.util, json, os, io, sys, contextlib, types, tempfile, urllib.request, urllib.parse, re
from datetime import datetime as _dt, timedelta, timezone, date as _date
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
STATE = tempfile.mkdtemp()
m.STATE_DIR = STATE
m.INTENT_LEDGER = os.path.join(STATE, "carryout-intent.jsonl")
m.NOTES_ARCHIVE = STATE
m.HANDOVER_DIR = tempfile.mkdtemp()
m.BROWSER_LEDGER = "/nonexistent/od-test-browser-ledger.jsonl"
AF = m.AF
AGENT = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
CREATED = (_dt.now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
APPROVED_AT = (_dt.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
STALE_APPROVED_AT = (_dt.now(timezone.utc) - timedelta(days=60)).strftime("%Y-%m-%dT%H:%M:%S.000Z")

# The one table a robot may delete from, and one it may not.
BRIEFS = "tblEPzZdwBZeSXFRB"
OTHER = "tbl" + "OTHERTABLE0001"
TENANTS = m.TENANTS_TABLE
NOTES_FLD = m.TENANT_NOTES_FIELD
TEN = "rec" + "TENANT0000000A"
def ROW(i):
    return "rec" + ("BRIEF%09d" % i)

TASK = "recRECORDINGFIX01"[:17]
TASKS = {}
# The non-Tasks tables, as Airtable holds them: {table: {record id: {"id":…, "fields": {fld: v}}}}
DATA = {BRIEFS: {}, OTHER: {}, TENANTS: {}}

def rec(i, **f):
    base = {AF["name"]: "TIDY UP: the repeat RECORDING BRIEF rows", AF["status"]: {"name": "Today"},
            AF["teamMember"]: [AGENT], AF["notes"]: "", AF["description"]: "", AF["agentOutput"]: ""}
    base.update({AF[k]: v for k, v in f.items()})
    TASKS[i] = {"id": i, "createdTime": CREATED, "fields": base}

def approved(quote, task=None, **over):
    """The card Kevin really approved: it went through the gate, his verdict is on it, and his
    Approved At is after it existed. Exactly what approval_evidence_problem asks for."""
    f = dict(sentForApprovalBy=[AGENT], approvedAt=APPROVED_AT,
             approvalOutcome={"name": "Approved as-is"}, approvalFeedback=quote)
    f.update(over)
    t = TASKS[task or TASK]["fields"]
    for k, v in f.items():
        if v == "__DELETE__":
            t.pop(AF[k], None)
        else:
            t[AF[k]] = v

def row(table, rid, fields=None):
    DATA.setdefault(table, {})[rid] = {"id": rid, "fields": dict(fields or {})}

m.get_task = lambda i: json.loads(json.dumps(TASKS[i]))
def patch(i, f):
    TASKS[i]["fields"].update(f)
    return {"id": i}
m.patch_task = patch
m.query_tasks = lambda formula, **kw: []
m.fetch_role_roster = lambda: {}
m.finding_details = lambda: {}

def query_records(table, formula=None, fields=None, max_records=None):
    """The real paginated read, faked: the only formula these doors build is RECORD_ID() equality."""
    want = set(re.findall(r"RECORD_ID\\(\\)='(rec[A-Za-z0-9]{14})'", formula or ""))
    rows = DATA.get(table) or {}
    return [json.loads(json.dumps(rows[r])) for r in sorted(want) if r in rows]
m.query_records = query_records

CALLS = []
def request(method, path, body=None):
    CALLS.append((method, path, body))
    if method == "DELETE":
        table, _, qs = path.lstrip("/").partition("?")
        ids = urllib.parse.parse_qs(qs).get("records[]", [])
        out = []
        for r in ids:
            if r in (DATA.get(table) or {}):
                del DATA[table][r]
                out.append({"id": r, "deleted": True})
        return {"records": out}
    if method == "PATCH":
        table, _, rid = path.lstrip("/").partition("/")
        DATA[table][rid]["fields"].update(body["fields"])
        return DATA[table][rid]
    raise RuntimeError("unexpected %s %s" % (method, path))
m._request = request

def run(fn, **a):
    """(error-or-None, printed-json-or-None). A refusal reports either way in this file."""
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            fn(types.SimpleNamespace(**a))
    except SystemExit as e:
        return str(e), None
    out = buf.getvalue().strip().splitlines()
    try:
        return None, json.loads(out[-1]) if out else None
    except ValueError:
        return None, {"printed": out[-1] if out else ""}

def delete_rows(table, ids, quote, task=None):
    return run(m.cmd_delete_rows, table=table, ids=",".join(ids), task=task or TASK, quote=quote)

def tmpfile(text):
    fd, path = tempfile.mkstemp()
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    return path

def record_field(rid, before, after, quote, table=None, field="Notes", task=None):
    return run(m.cmd_record_field, record=rid, table=table or TENANTS, field=field,
               task=task or TASK, quote=quote,
               expect_before=tmpfile(before), after=tmpfile(after))

def notes(i=None):
    return str(TASKS[i or TASK]["fields"].get(AF["notes"]) or "")

def value(table, rid, fld):
    r = (DATA.get(table) or {}).get(rid)
    return None if r is None else r["fields"].get(fld)

def ids_in(table):
    return sorted(DATA.get(table) or {})
`;

function py(body) {
  const out = execFileSync('python3', ['-c', PRE + body], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

// Three rows Kevin approved deleting, one row kept, and the words he approved them on.
const BRIEF_SETUP = `
rec(TASK)
for i in range(1, 5):
    row(BRIEFS, ROW(i), {"Title": "episode %d" % i})
QUOTE = "delete the repeat RECORDING BRIEF rows, keep the oldest per title in table tblEPzZdwBZeSXFRB"
approved("Approved as-is — " + QUOTE + ".")
`;

describe('finding 20261011-agent-dispatch-832: the rows he approved deleting', () => {
  it('deletes exactly the named ids and writes the dated audit line', () => {
    const r = py(`${BRIEF_SETUP}
err, out = delete_rows(BRIEFS, [ROW(1), ROW(2), ROW(3)], QUOTE)
print(json.dumps({"err": err, "out": out, "left": ids_in(BRIEFS), "kept": ROW(4),
                  "notes": notes(), "calls": [c[0] for c in CALLS]}))`);
    expect(r.err).toBe(null);
    expect(r.out.deleted).toBe(3);
    expect(r.out.table).toBe('tblEPzZdwBZeSXFRB');
    expect(r.left).toEqual([r.kept]);                     // the row he kept is untouched
    expect(r.calls).toEqual(['DELETE']);                  // one request, never a loop of them
    expect(r.notes).toMatch(/— agent-dispatch\] RECORD WRITE: deleted 3 rows from tblEPzZdwBZeSXFRB \(recBRIEF000000001, recBRIEF000000002, recBRIEF000000003\), on Kevin's approval recorded on recRECORDINGFIX01\. His words: "delete the repeat RECORDING BRIEF rows/);
  });

  it('refuses a table that is not on the allowlist, with nothing deleted', () => {
    const r = py(`${BRIEF_SETUP}
row(OTHER, ROW(9))
err, out = delete_rows(OTHER, [ROW(9)], QUOTE)
print(json.dumps({"err": err, "left": ids_in(OTHER), "calls": CALLS, "notes": notes()}))`);
    expect(r.err).toMatch(/not a table a robot may ever delete from/);
    expect(r.err).toMatch(/allowlist in agent-dispatch\.py holds: tblEPzZdwBZeSXFRB/);
    expect(r.err).toMatch(/lives in the code and is never a flag/);
    expect(r.left).toHaveLength(1);
    expect(r.calls).toEqual([]);
    expect(r.notes).toBe('');
  });

  it('refuses the WHOLE batch when one id lives in another table, or nowhere', () => {
    const r = py(`${BRIEF_SETUP}
row(OTHER, ROW(9))
elsewhere = delete_rows(BRIEFS, [ROW(1), ROW(9)], QUOTE)
gone = delete_rows(BRIEFS, [ROW(1), "rec" + "MISSING000000A"], QUOTE)
print(json.dumps({"a": elsewhere[1], "b": gone[1], "left": ids_in(BRIEFS),
                  "other": ids_in(OTHER), "calls": CALLS, "notes": notes()}))`);
    expect(r.a.why).toMatch(/1 of the 2 ids are not in tblEPzZdwBZeSXFRB — missing, or in another table: recBRIEF000000009\. Nothing was deleted\./);
    expect(r.b.why).toMatch(/Nothing was deleted\./);
    expect(r.left).toHaveLength(4);        // every row still there: no partial delete
    expect(r.other).toHaveLength(1);
    expect(r.calls).toEqual([]);
    expect(r.notes).toBe('');
  });

  it('refuses a task with no real approval evidence, and a bare approval string', () => {
    const r = py(`${BRIEF_SETUP}
approved("Approved as-is — " + QUOTE + ".", sentForApprovalBy="__DELETE__")
nogate = delete_rows(BRIEFS, [ROW(1)], QUOTE)
approved("Approved as-is — " + QUOTE + ".", approvedAt="__DELETE__")
noat = delete_rows(BRIEFS, [ROW(1)], QUOTE)
approved("Approved as-is — " + QUOTE + ".", approvedAt=STALE_APPROVED_AT)
copied = delete_rows(BRIEFS, [ROW(1)], QUOTE)
approved("Approved as-is — " + QUOTE + ".", approvalOutcome="Approved")
bare = delete_rows(BRIEFS, [ROW(1)], QUOTE)
approved("Approved as-is — " + QUOTE + ".", approvalOutcome={"name": "Changes requested"})
changes = delete_rows(BRIEFS, [ROW(1)], QUOTE)
print(json.dumps({"nogate": nogate[1], "noat": noat[1], "copied": copied[1], "bare": bare[1],
                  "changes": changes[1], "left": ids_in(BRIEFS), "calls": CALLS, "notes": notes()}))`);
    expect(r.nogate.why).toMatch(/does not carry the marks of a real approval: it never went through the approval gate/);
    expect(r.noat.why).toMatch(/no approval was ever recorded/);
    expect(r.copied.why).toMatch(/earlier than the task itself, so it was copied, not given/);
    // Finding 20260922-agent-dispatch-572: a typed "Approved" is not one of his verdicts.
    expect(r.bare.why).toMatch(/carries no approval of Kevin's: its Approval Outcome is 'Approved'/);
    expect(r.changes.why).toMatch(/Approval Outcome is 'Changes requested'/);
    expect(r.left).toHaveLength(4);
    expect(r.calls).toEqual([]);
    expect(r.notes).toBe('');
  });

  it('refuses words that are not in his approved text, and words that do not name the table', () => {
    const r = py(`${BRIEF_SETUP}
notmine = delete_rows(BRIEFS, [ROW(1)], "delete every row in the briefs table please")
approved("Approved as-is — go ahead and clear out those duplicate rows for me.")
unnamed = delete_rows(BRIEFS, [ROW(1)], "go ahead and clear out those duplicate rows")
short = delete_rows(BRIEFS, [ROW(1)], "yes")
print(json.dumps({"notmine": notmine[1], "unnamed": unnamed[1], "short": short[1],
                  "left": ids_in(BRIEFS), "calls": CALLS, "notes": notes()}))`);
    expect(r.notmine.why).toMatch(/--quote is not in Kevin's approved words on recRECORDINGFIX01/);
    expect(r.unnamed.why).toMatch(/Kevin's approved words do not name the table being deleted from \(tblEPzZdwBZeSXFRB, RECORDING BRIEF rows \(the paused od topics lane\)\)/);
    expect(r.short.why).toMatch(/--quote needs Kevin's own words from the approved card, verbatim/);
    expect(r.left).toHaveLength(4);
    expect(r.calls).toEqual([]);
    expect(r.notes).toBe('');
  });

  it('caps the batch at one Airtable request and refuses a repeated or malformed id', () => {
    const r = py(`${BRIEF_SETUP}
for i in range(5, 20):
    row(BRIEFS, ROW(i))
big = delete_rows(BRIEFS, [ROW(i) for i in range(1, 13)], QUOTE)
twice = delete_rows(BRIEFS, [ROW(1), ROW(1)], QUOTE)
junk = delete_rows(BRIEFS, ["tbl" + "OTHERTABLE0001"], QUOTE)
none = run(m.cmd_delete_rows, table=BRIEFS, ids="", task=TASK, quote=QUOTE)
print(json.dumps({"big": big[0], "twice": twice[0], "junk": junk[0], "none": none[0],
                  "left": len(ids_in(BRIEFS)), "calls": CALLS}))`);
    expect(r.big).toMatch(/12 ids — Airtable deletes 10 a request/);
    expect(r.twice).toMatch(/names the same record twice/);
    expect(r.junk).toMatch(/not Airtable record ids: tblOTHERTABLE0001/);
    expect(r.none).toMatch(/--ids needs at least one record id/);
    expect(r.left).toBe(19);
    expect(r.calls).toEqual([]);
  });
});

// The tenant whose Notes Kevin approved editing: line 1 goes, lines 2 and 3 stay word for word.
// The two standing-in identifier lines are invented and name nobody.
const TENANT_SETUP = `
rec(TASK, name="TENANT NOTES: drop the stale first line")
BEFORE = "No longer a tenant\\nMobile 07700 900000\\nEmail nobody@example.invalid"
AFTER = "Mobile 07700 900000\\nEmail nobody@example.invalid"
row(TENANTS, TEN, {NOTES_FLD: BEFORE})
QUOTE = "on tenant " + TEN + ", field Notes, delete line 1 only"
approved("Approved as-is — " + QUOTE + ".")
`;

describe('finding 20261015-agent-dispatch-917: one line off one tenant Notes field', () => {
  it('drops line 1 and keeps lines 2 and 3 byte for byte, and audits it without the text', () => {
    const r = py(`${TENANT_SETUP}
err, out = record_field(TEN, BEFORE, AFTER, QUOTE)
print(json.dumps({"err": err, "out": out, "live": value(TENANTS, TEN, NOTES_FLD), "after": AFTER,
                  "notes": notes(), "calls": [c[0] for c in CALLS]}))`);
    expect(r.err).toBe(null);
    expect(r.out.wrote).toBe('recTENANT0000000A');
    expect(r.out.removedLines).toEqual([1]);
    expect(r.out.linesBefore).toBe(3);
    expect(r.out.linesAfter).toBe(2);
    expect(r.live).toBe(r.after);                       // lines 2 and 3, unchanged
    expect(r.calls).toEqual(['PATCH']);
    expect(r.notes).toMatch(/— agent-dispatch\] RECORD WRITE: Notes on recTENANT0000000A in tblX4elTuu01gwBYh rewritten: 3 lines before, 2 after, line 1 removed, on Kevin's approval recorded on recRECORDINGFIX01\./);
    // The audit line never carries the text that came off: these are personal identifiers.
    expect(r.notes).not.toContain('No longer a tenant');
    expect(r.notes).not.toContain('07700 900000');
  });

  it('refuses when the live value differs from --expect-before, writing nothing', () => {
    const r = py(`${TENANT_SETUP}
DATA[TENANTS][TEN]["fields"][NOTES_FLD] = BEFORE + " "        # one trailing space
err, out = record_field(TEN, BEFORE, AFTER, QUOTE)
print(json.dumps({"err": err, "out": out, "live": value(TENANTS, TEN, NOTES_FLD),
                  "calls": CALLS, "notes": notes()}))`);
    expect(r.out.why).toMatch(/Notes on recTENANT0000000A does not match --expect-before byte for byte/);
    expect(r.out.why).toMatch(/Nothing was written\./);
    expect(r.live).toBe('No longer a tenant\nMobile 07700 900000\nEmail nobody@example.invalid ');
    expect(r.calls).toEqual([]);
    expect(r.notes).toBe('');
  });

  it('refuses a blank live read: a blank is a STOP, never a starting point', () => {
    const r = py(`${TENANT_SETUP}
DATA[TENANTS][TEN]["fields"][NOTES_FLD] = ""
blank = record_field(TEN, BEFORE, AFTER, QUOTE)
del DATA[TENANTS][TEN]["fields"][NOTES_FLD]
unset = record_field(TEN, BEFORE, AFTER, QUOTE)
print(json.dumps({"blank": blank[1], "unset": unset[1], "calls": CALLS, "notes": notes()}))`);
    expect(r.blank.why).toMatch(/Notes on recTENANT0000000A reads blank\. A blank read is a STOP, never a starting point/);
    expect(r.unset.why).toMatch(/reads blank/);
    expect(r.calls).toEqual([]);
    expect(r.notes).toBe('');
  });

  it('refuses a (table, field) pair that is not on the allowlist', () => {
    const r = py(`${TENANT_SETUP}
other = record_field(TEN, BEFORE, AFTER, QUOTE, field="Rent")
table = record_field(TEN, BEFORE, AFTER, QUOTE, table=OTHER)
print(json.dumps({"other": other[0], "table": table[0], "live": value(TENANTS, TEN, NOTES_FLD),
                  "before": BEFORE, "calls": CALLS}))`);
    expect(r.other).toMatch(/refusing to write 'Rent' on 'tblX4elTuu01gwBYh': it is not a field a robot may edit/);
    expect(r.other).toMatch(/allowlist in agent-dispatch\.py holds: tblX4elTuu01gwBYh\.Notes/);
    expect(r.table).toMatch(/refusing to write 'Notes' on 'tblOTHERTABLE0001'/);
    expect(r.live).toBe(r.before);
    expect(r.calls).toEqual([]);
  });

  it('takes the same evidence bar and quote check as the delete door', () => {
    const r = py(`${TENANT_SETUP}
approved("Approved as-is — " + QUOTE + ".", sentForApprovalBy="__DELETE__")
nogate = record_field(TEN, BEFORE, AFTER, QUOTE)
approved("Approved as-is — " + QUOTE + ".")
notmine = record_field(TEN, BEFORE, AFTER, "delete the whole Notes field on that tenant")
approved("Approved as-is — delete the first line of the notes on that tenant, the rest stays.")
unnamed = record_field(TEN, BEFORE, AFTER, "delete the first line of the notes on that tenant")
approved("Approved as-is — on tenant " + TEN + ", drop the first line, the rest stays.")
nofield = record_field(TEN, BEFORE, AFTER, "on tenant " + TEN + ", drop the first line")
print(json.dumps({"nogate": nogate[1], "notmine": notmine[1], "unnamed": unnamed[1],
                  "nofield": nofield[1], "live": value(TENANTS, TEN, NOTES_FLD), "before": BEFORE,
                  "calls": CALLS, "notes": notes()}))`);
    expect(r.nogate.why).toMatch(/does not carry the marks of a real approval/);
    expect(r.notmine.why).toMatch(/--quote is not in Kevin's approved words on recRECORDINGFIX01/);
    expect(r.unnamed.why).toMatch(/do not name the record being changed \(recTENANT0000000A\)/);
    expect(r.nofield.why).toMatch(/do not name the field being changed \(Notes\)/);
    expect(r.live).toBe(r.before);
    expect(r.calls).toEqual([]);
    expect(r.notes).toBe('');
  });

  it('is a REMOVAL door: it never clears the field, rewords a line or adds one', () => {
    const r = py(`${TENANT_SETUP}
empty = record_field(TEN, BEFORE, "   ", QUOTE)
same = record_field(TEN, BEFORE, BEFORE, QUOTE)
added = record_field(TEN, BEFORE, AFTER + "\\nNew line nobody approved", QUOTE)
reworded = record_field(TEN, BEFORE, "Mobile 07700 900001\\nEmail nobody@example.invalid", QUOTE)
missing = run(m.cmd_record_field, record=TEN, table=TENANTS, field="Notes", task=TASK, quote=QUOTE,
              expect_before="/nonexistent/before.txt", after=tmpfile(AFTER))
print(json.dumps({"empty": empty[0], "same": same[0], "added": added[0], "reworded": reworded[0],
                  "missing": missing[0], "live": value(TENANTS, TEN, NOTES_FLD), "before": BEFORE,
                  "calls": CALLS}))`);
    expect(r.empty).toMatch(/--after is empty: this door edits Notes on recTENANT0000000A, it never clears it/);
    expect(r.same).toMatch(/--after is --expect-before unchanged/);
    expect(r.added).toMatch(/--after is not --expect-before with whole lines removed/);
    expect(r.reworded).toMatch(/--after is not --expect-before with whole lines removed/);
    expect(r.missing).toMatch(/--expect-before names no file/);
    expect(r.live).toBe(r.before);
    expect(r.calls).toEqual([]);
  });

  it('refuses a record that is not in the table it was given, and a malformed id', () => {
    const r = py(`${TENANT_SETUP}
row(OTHER, "rec" + "ELSEWHERE00001")
approved("Approved as-is — on tenant rec" + "ELSEWHERE00001" + ", field Notes, delete line 1 only.")
wrong = record_field("rec" + "ELSEWHERE00001", BEFORE, AFTER,
                     "on tenant rec" + "ELSEWHERE00001" + ", field Notes, delete line 1 only")
junk = record_field("tbl" + "OTHERTABLE0001", BEFORE, AFTER, QUOTE)
print(json.dumps({"wrong": wrong[1], "junk": junk[0], "calls": CALLS, "notes": notes()}))`);
    expect(r.wrong.why).toMatch(/recELSEWHERE00001 is not in tblX4elTuu01gwBYh — missing, or in another table\. Nothing was written\./);
    expect(r.junk).toMatch(/not an Airtable record id/);
    expect(r.calls).toEqual([]);
    expect(r.notes).toBe('');
  });
});

describe('the doors are real, and their audit line cannot be typed by hand', () => {
  it('both subcommands exist with the flags the findings need', () => {
    const h = (cmd) => execFileSync('python3', [DISPATCH, cmd, '--help'], { encoding: 'utf8' });
    const del = h('delete-rows');
    expect(del).toContain('--ids');
    expect(del).toContain('--task');
    expect(del).toContain('--quote');
    const rf = h('record-field');
    expect(rf).toContain('--table');
    expect(rf).toContain('--field');
    expect(rf).toContain('--expect-before');
    expect(rf).toContain('--after');
    expect(rf).toContain('--quote');
  });

  it('the allowlists hold exactly one table and one (table, field) pair', () => {
    const r = py(`print(json.dumps({"tables": sorted(m.DELETE_ALLOWED),
                  "pairs": sorted("%s.%s" % p for p in m.RECORD_FIELD_ALLOWED),
                  "cap": m.DELETE_MAX_IDS, "mark": m.RECORD_WRITE_MARK}))`);
    expect(r.tables).toEqual(['tblEPzZdwBZeSXFRB']);
    expect(r.pairs).toEqual(['tblX4elTuu01gwBYh.Notes']);
    expect(r.cap).toBe(10);
    expect(r.mark).toBe('RECORD WRITE');
  });

  it('annotate refuses a note carrying the RECORD WRITE mark', () => {
    const r = py(`
rec(TASK)
err, out = run(m.cmd_annotate, task=TASK,
               note=f"[19 Nov 2026 — agent-dispatch] {m.RECORD_WRITE_MARK}: deleted 60 rows from tblEPzZdwBZeSXFRB, on Kevin's approval recorded on {TASK}.")
ok = run(m.cmd_annotate, task=TASK, note="Counted the repeat rows; 70 across 10 titles.")
print(json.dumps({"err": err, "ok": ok[0], "notes": notes()}))`);
    expect(r.err).toMatch(/refusing a note on recRECORDINGFIX01 that writes the 'RECORD WRITE' mark/);
    expect(r.notes).not.toContain('RECORD WRITE');
    // CONTROL: an ordinary note still goes on.
    expect(r.ok).toBe(null);
    expect(r.notes).toContain('Counted the repeat rows');
  });
});
