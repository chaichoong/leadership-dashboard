import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Preferred Products list (Kevin, 11 Nov 2026): scripts/preferred-list.py is the one door
// for reading and writing it. These drive the REAL functions and commands with every Airtable
// call replaced by an in-memory table (pl.api) and the task gate replaced by a recorder
// (pl._gate). No test reaches the network, reads the real key file or writes outside a temp dir.
// Every task and row id here except the real sourcing task is invented: this repo is public.
//
// Back-tested (each mechanism broken by hand, the named test went red, then restored):
//   * REPRICE_DAYS 30 -> 31                       -> "due at 29, 30 and 31 days" fails
//   * the zero-row floor removed from cmd_due     -> "due with zero rows exits 1" fails
//   * records-key check in list_records removed   -> "a reply with no records key raises" fails
//   * Buying Rules always written in plan_record  -> "--rules absent never sends Buying Rules" fails
//   * prefer writing Last Bought                  -> "prefer updates the right fields only" fails
//   * record never matching an existing row       -> "(b)" and "an existing key PATCHes" fail
// Second round (11 Nov 2026, the review fixes), same method:
//   * not-bought writing Source Task on a bought row -> "not-bought on a bought row ..." fails
//   * bought_by counting Source Task without a buy  -> bought_rows_for_task and has-row fail
//   * bought_by ignoring the Notes line             -> "an earlier buyer via Notes" fails
//   * due --apply stamping nothing                  -> the stamp, next-day and stamp-failure tests fail
//   * blank Status read as not active               -> "a row with a blank Status is due" fails
//   * future dates allowed                          -> the future --bought-on and --on tests fail
//   * prefer accepting a not-bought row             -> "refuses a row that has not been bought" and the A-then-R test fail
//   * prefer writing Full Price                     -> the prefer-fields test and the reviewer's £40/£300 case fail

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(root, 'scripts', 'preferred-list.py');

const HARNESS = `
import importlib.util, json, sys, os, io, contextlib, tempfile, urllib.parse
from datetime import date
os.environ["PREFLIST_PAT_FILE"] = os.path.join(tempfile.mkdtemp(), "no-such-key")
spec = importlib.util.spec_from_file_location("pl", ${JSON.stringify(SCRIPT)})
pl = importlib.util.module_from_spec(spec); spec.loader.exec_module(pl)

class Store:
    def __init__(self):
        self.rows = []          # Preferred Products rows, name-keyed
        self.calls = []         # (method, table, body)
        self.no_records = False
        self.drop = set()       # fields a write silently fails to keep
        self.n = 0
S = Store()

def fake_api(method, p, body=None):
    table = p.split("?")[0].strip("/")
    S.calls.append((method, table, body))
    if method == "GET":
        if S.no_records:
            return {"error": "NOT_FOUND"}
        if table != pl.TABLE:
            raise AssertionError("a read of another table: %s" % table)
        return {"records": json.loads(json.dumps(S.rows))}
    if table != pl.TABLE:
        raise AssertionError("a write to %s" % table)
    rec = body["records"][0]
    kept = {k: v for k, v in rec["fields"].items() if k not in S.drop}
    if method == "POST":
        S.n += 1
        row = {"id": "recPREF%010d" % S.n, "fields": kept}
        S.rows.append(row)
        return {"records": [row]}
    if method == "PATCH":
        row = next(r for r in S.rows if r["id"] == rec["id"])
        row["fields"].update(kept)
        return {"records": [row]}
    raise AssertionError(method)
pl.api = fake_api
pl.today_london = lambda: date(2026, 11, 11)

GATE = []
def fake_gate(fields, flags):
    GATE.append({"fields": fields, "flags": list(flags)})
    return True, {"action": "created", "taskId": "recNEWTASK0000001"}
pl._gate = fake_gate

def run(*argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            code = pl.main(list(argv))
        except SystemExit as e:
            code = e.code
    return {"code": code, "out": buf.getvalue()}

def row(rid, key, **f):
    base = {"Item": key, "Item Key": key, "Status": "Active", "Bought As": "Second-hand",
            "Full Price": 70.0, "Supplier or Seller": "Seller A", "Link": "https://example.com/a"}
    base.update(f)
    return {"id": rid, "fields": {k: v for k, v in base.items() if v is not None}}

def writes():
    return [(m, b) for (m, t, b) in S.calls if m in ("POST", "PATCH")]

def out(obj):
    print("\\n" + json.dumps(obj))
`;

function py(snippet) {
  const stdout = execFileSync('python3', ['-c', HARNESS + '\n' + snippet], { encoding: 'utf8' });
  const lines = stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

const TASK = 'reck5ZY5MoXulxJz8';
const FRIDGE = 'Fridge freezer, full height';
const RULES = '£75 or under each. 175 cm or taller. Clean inside and out. Near Haverhill.';

describe('pure functions', () => {
  it('item_key lower-cases and hyphen-joins letters and digits', () => {
    const r = py(`out([pl.item_key(${JSON.stringify(FRIDGE)}), pl.item_key("  A--B  c3 "), pl.item_key("")])`);
    expect(r).toEqual(['fridge-freezer-full-height', 'a-b-c3', '']);
  });

  it('due at 29, 30 and 31 days; blank Last Checked is due', () => {
    const r = py(`
rows = [row("rec29", "a", **{"Last Checked": "2026-11-12"}), row("rec30", "b", **{"Last Checked": "2026-11-11"}),
        row("rec31", "c", **{"Last Checked": "2026-11-10"}), row("recNEVER", "d")]
out([x["id"] for x in pl.due_rows(rows, date(2026, 12, 11))])`);
    expect(r).toEqual(['rec30', 'rec31', 'recNEVER']);
  });

  it('a blank price, zero price, Not bought yet and Retired are never due', () => {
    const r = py(`
rows = [row("recBLANK", "a", **{"Full Price": None}), row("recZERO", "b", **{"Full Price": 0}),
        row("recNOT", "c", **{"Bought As": "Not bought yet", "Full Price": None}),
        row("recNOT2", "c2", **{"Bought As": "Not bought yet"}),
        row("recRET", "d", Status="Retired")]
out([x["id"] for x in pl.due_rows(rows, date(2027, 6, 1))])`);
    expect(r).toEqual([]);
  });

  it('duplicate_keys counts Active rows only', () => {
    const r = py(`
rows = [row("r1", "a"), row("r2", "a"), row("r3", "b"), row("r4", "b", Status="Retired")]
out(pl.duplicate_keys(rows))`);
    expect(r).toEqual(['a']);
  });

  it('a reply with no records key raises, never reads as zero rows', () => {
    const r = py(`
S.no_records = True
try:
    pl.read_rows(); out("no error")
except RuntimeError as e:
    out("raised: " + str(e))`);
    expect(r).toMatch(/^raised: .*no records list/);
  });

  it('read_rows follows offset to the last page', () => {
    const r = py(`
pages = [{"records": [row("r1", "a")], "offset": "p2"}, {"records": [row("r2", "b")]}]
seen = []
def paged(method, p, body=None):
    seen.append(p); return pages[len(seen) - 1]
pl.api = paged
out([[x["id"] for x in pl.read_rows()], "offset=p2" in seen[1]])`);
    expect(r).toEqual([['r1', 'r2'], true]);
  });
});

describe('due: the daily clock', () => {
  it('zero rows exits 1 with the floor ERROR line', () => {
    const r = py(`out(run("due"))`);
    expect(r.code).toBe(1);
    expect(r.out.trim()).toBe('ERROR: Preferred Products read 0 rows; the list is never empty once seeded');
  });

  it('duplicate Active keys exit 1', () => {
    const r = py(`S.rows = [row("r1", "a"), row("r2", "a")]\nout(run("due"))`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ERROR: duplicate Item Key(s): a');
  });

  it('--apply with due rows calls the real create exactly once, owned by Inbox Response', () => {
    const r = py(`
S.rows = [row("r1", "a"), row("r2", "b"), row("r3", "c", **{"Last Checked": "2026-11-01"})]
res = run("due", "--apply")
real = [g for g in GATE if "--force" in g["flags"]]
f = real[0]["fields"]
out(dict(res, real=len(real), dry=len([g for g in GATE if "--dry-run" in g["flags"]]),
         owner=real[0]["flags"], name=f[pl.TF["name"]], desc=f[pl.TF["desc"]], type=f[pl.TF["taskType"]],
         approver=f[pl.TF["approver"]], status=f[pl.TF["status"]], due=f[pl.TF["due"]]))`);
    expect(r.code).toBe(0);
    expect(r.real).toBe(1);
    expect(r.dry).toBe(1);
    expect(r.name).toBe('PREFERRED LIST: monthly re-price, 2 item(s) (Nov 2026)');
    expect(r.desc.split('\n')[0]).toBe('PREFLIST-REVIEW 2026-11');
    expect(r.desc).toContain('python3 scripts/preferred-list.py checked --key <key>');
    expect(r.type).toBe('Research');
    expect(r.approver).toEqual({ id: 'usrKkopUJSGsBhWMD' });
    expect([r.status, r.due]).toEqual(['Today', '2026-11-11']);
    expect(r.out.trim().split('\n').pop()).toBe(
      'PREFERRED LIST: 3 item(s) on the list, 3 priced, 2 due for a re-price, 2 awaiting a result, review task: raised recNEWTASK0000001');
  });

  it('after a raise every due row is stamped and read back, and the next day raises nothing', () => {
    const r = py(`
S.rows = [row("r1", "a"), row("r2", "b", **{"Last Checked": "2026-10-01"}), row("r3", "c", **{"Last Checked": "2026-11-01"})]
first = run("due", "--apply")
stamps = [(b["records"][0]["id"], b["records"][0]["fields"]) for m, b in writes()]
GATE.clear()
pl.today_london = lambda: date(2026, 11, 12)
second = run("due", "--apply")
out(dict(first=first, stamps=stamps, second=second, gate2=len(GATE),
         reads=len([c for c in S.calls if c[0] == "GET"])))`);
    expect(r.first.code).toBe(0);
    expect(r.stamps.map((x) => x[0])).toEqual(['r1', 'r2']);
    expect(r.stamps[0][1]).toEqual({ 'Last Checked': '2026-11-11',
      'Last Check Result': 'review raised 2026-11-11 (task recNEWTASK0000001): awaiting result' });
    expect(r.reads).toBeGreaterThanOrEqual(4);   // one read per run plus one read-back per stamp
    expect(r.second.code).toBe(0);
    expect(r.gate2).toBe(0);
    expect(r.second.out.trim().split('\n').pop()).toBe(
      'PREFERRED LIST: 3 item(s) on the list, 3 priced, 0 due for a re-price, 2 awaiting a result, review task: none needed');
  });

  it('a refused create stamps nothing and exits 1', () => {
    const r = py(`
S.rows = [row("r1", "a")]
pl._gate = lambda fields, flags: (False, {"action": "error", "why": "refused for the test"})
res = run("due", "--apply")
out(dict(res, writes=len(writes())))`);
    expect(r.code).toBe(1);
    expect(r.writes).toBe(0);
    expect(r.out).toContain('ERROR: the review task was not raised: refused for the test');
    expect(r.out.trim().split('\n').pop()).toMatch(/review task: not raised \(gate refused\)$/);
  });

  it('a stamp that does not stick exits 1 naming the row', () => {
    const r = py(`
S.rows = [row("r1", "a")]
S.drop = {"Last Check Result"}
out(run("due", "--apply"))`);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ERROR: review task recNEWTASK0000001 raised but row r1 \(a\) was not stamped: Last Check Result/);
  });

  it('a row with a blank Status is due and counted', () => {
    const r = py(`S.rows = [row("r1", "a", Status=None)]\nout(run("due"))`);
    expect(r.out.trim().split('\n').pop()).toBe(
      'PREFERRED LIST: 1 item(s) on the list, 1 priced, 1 due for a re-price, 0 awaiting a result, review task: would raise (dry run)');
  });

  it('without --apply it creates nothing and says would raise', () => {
    const r = py(`
S.rows = [row("r1", "a")]
res = run("due")
out(dict(res, real=len([g for g in GATE if "--force" in g["flags"]]), writes=len(writes())))`);
    expect(r.real).toBe(0);
    expect(r.writes).toBe(0);
    expect(r.out.trim().split('\n').pop()).toBe(
      'PREFERRED LIST: 1 item(s) on the list, 1 priced, 1 due for a re-price, 0 awaiting a result, review task: would raise (dry run)');
  });

  it('nothing due: none needed, and the line stays within 220 characters', () => {
    const r = py(`
S.rows = [row("r1", "a", **{"Last Checked": "2026-11-01"})]
res = run("due", "--apply")
out(dict(res, gate=len(GATE), long=len(pl.summary_line(99999, 99999, 99999, 99999, "raised " + "x" * 300))))`);
    expect(r.gate).toBe(0);
    expect(r.long).toBeLessThanOrEqual(220);
    expect(r.out.trim().split('\n').pop()).toBe(
      'PREFERRED LIST: 1 item(s) on the list, 1 priced, 0 due for a re-price, 0 awaiting a result, review task: none needed');
  });
});

describe('record: the write after an approved buy', () => {
  it('(a) the fridge stored as not-bought with its rules: one POST, no price, never due', () => {
    const r = py(`
res = run("record", "--task", "${TASK}", "--item", ${JSON.stringify(FRIDGE)}, "--bought-as", "not-bought",
          "--rules", ${JSON.stringify(RULES)}, "--category", "Appliance")
w = writes()
out(dict(res, methods=[m for m, b in w], fields=w[0][1]["records"][0]["fields"],
         due=len(pl.due_rows(S.rows, date(2027, 6, 1)))))`);
    expect(r.code).toBe(0);
    expect(r.methods).toEqual(['POST']);
    expect(r.fields['Item Key']).toBe('fridge-freezer-full-height');
    expect(r.fields['Bought As']).toBe('Not bought yet');
    expect(r.fields['Buying Rules']).toBe(RULES);
    expect(r.fields['Source Task']).toBe(TASK);
    expect('Full Price' in r.fields).toBe(false);
    expect(r.due).toBe(0);
    expect(r.out).toMatch(/^RECORDED: created recPREF0000000001 fridge-freezer-full-height £- Not bought yet$/m);
  });

  it('(b) then bought second-hand at 70.00: a PATCH on the same row, rules untouched', () => {
    const r = py(`
run("record", "--task", "${TASK}", "--item", ${JSON.stringify(FRIDGE)}, "--bought-as", "not-bought",
    "--rules", ${JSON.stringify(RULES)})
S.calls.clear()
res = run("record", "--task", "${TASK}", "--item", ${JSON.stringify(FRIDGE)}, "--bought-as", "second-hand",
          "--price", "70.00", "--supplier", "Facebook Marketplace seller", "--link", "https://example.com/item/1",
          "--bought-on", "2026-11-11")
w = writes()
out(dict(res, methods=[m for m, b in w], sent=w[0][1]["records"][0], rows=S.rows))`);
    expect(r.code).toBe(0);
    expect(r.methods).toEqual(['PATCH']);
    expect(r.sent.id).toBe('recPREF0000000001');
    expect('Buying Rules' in r.sent.fields).toBe(false);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].fields['Buying Rules']).toBe(RULES);
    expect(r.rows[0].fields['Full Price']).toBe(70);
    expect(r.rows[0].fields['Last Checked']).toBe('2026-11-11');
    expect(r.rows[0].fields.Notes).toBe(
      '2026-11-11: bought Second-hand £70.00 from Facebook Marketplace seller (task reck5ZY5MoXulxJz8). Was £-, Not bought yet, from no supplier.');
    expect(r.out).toContain('RECORDED: updated recPREF0000000001 fridge-freezer-full-height £70.00 Second-hand');
  });

  it('(c) that row 30 days later is due and raises one review task', () => {
    const r = py(`
run("record", "--task", "${TASK}", "--item", ${JSON.stringify(FRIDGE)}, "--bought-as", "second-hand",
    "--price", "70", "--supplier", "Seller", "--link", "https://example.com/item/1", "--bought-on", "2026-11-11")
res = run("due", "--apply", "--as-of", "2026-12-11")
out(dict(res, real=len([g for g in GATE if "--force" in g["flags"]])))`);
    expect(r.real).toBe(1);
    expect(r.out).toContain('1 due for a re-price, 1 awaiting a result, review task: raised recNEWTASK0000001');
  });

  it('a new key POSTs; an existing key PATCHes', () => {
    const r = py(`
S.rows = [row("recEXISTING000001", "single-bed-frame")]
run("record", "--task", "${TASK}", "--item", "Single bed frame", "--bought-as", "new", "--price", "89.99",
    "--supplier", "Shop", "--link", "https://example.com/bed")
run("record", "--task", "${TASK}", "--item", "Double mattress", "--bought-as", "new", "--price", "120",
    "--supplier", "Shop", "--link", "https://example.com/mattress")
w = writes()
out([[m, b["records"][0].get("id")] for m, b in w])`);
    expect(r).toEqual([['PATCH', 'recEXISTING000001'], ['POST', null]]);
  });

  it('--rules absent never sends Buying Rules (and --category absent never sends Category)', () => {
    const r = py(`
S.rows = [row("recEXISTING000001", "kettle", **{"Buying Rules": "Under £20", "Category": "Appliance"})]
run("record", "--task", "${TASK}", "--item", "Kettle", "--bought-as", "new", "--price", "15",
    "--supplier", "Shop", "--link", "https://example.com/k")
f = writes()[0][1]["records"][0]["fields"]
out(["Buying Rules" in f, "Category" in f, S.rows[0]["fields"]["Buying Rules"]])`);
    expect(r).toEqual([false, false, 'Under £20']);
  });

  it('a field that does not stick on read-back exits 4 naming it', () => {
    const r = py(`
S.drop = {"Full Price"}
out(run("record", "--task", "${TASK}", "--item", "Kettle", "--bought-as", "new", "--price", "15",
        "--supplier", "Shop", "--link", "https://example.com/k"))`);
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/ERROR: .*did not stick.*Full Price/);
  });

  it('record never sends a Preferred field, buy or not-bought, new row or existing', () => {
    const r = py(`
S.rows = [row("recKETTLE00000001", "kettle", **{"Preferred Supplier": "A Shop", "Preferred Price": 300.0,
          "Preferred Link": "https://example.com/new", "Preferred Since": "2026-11-01"})]
run("record", "--task", "${TASK}", "--item", "Kettle", "--bought-as", "new", "--price", "300",
    "--supplier", "A Shop", "--link", "https://example.com/new")
run("record", "--task", "${TASK}", "--item", "Kettle", "--bought-as", "not-bought", "--rules", "Under £400")
run("record", "--task", "${TASK}", "--item", "Toaster", "--bought-as", "new", "--price", "20",
    "--supplier", "Shop", "--link", "https://example.com/t")
sent = [k for m, b in writes() for k in b["records"][0]["fields"]]
out([len(writes()), [k for k in sent if k.startswith("Preferred")], S.rows[0]["fields"]["Preferred Price"]])`);
    expect(r).toEqual([3, [], 300]);
  });

  it.each([
    ['a bad task id', ['--task', 'recSHORT', '--bought-as', 'new', '--price', '10', '--supplier', 'S', '--link', 'https://x.co']],
    ['a zero price', ['--task', TASK, '--bought-as', 'new', '--price', '0', '--supplier', 'S', '--link', 'https://x.co']],
    ['a non-http link', ['--task', TASK, '--bought-as', 'new', '--price', '10', '--supplier', 'S', '--link', 'ftp://x.co']],
    ['a buy with no supplier', ['--task', TASK, '--bought-as', 'new', '--price', '10', '--link', 'https://x.co']],
    ['an unknown category', ['--task', TASK, '--bought-as', 'new', '--price', '10', '--supplier', 'S', '--link', 'https://x.co', '--category', 'Cars']],
    ['an unknown bought-as', ['--task', TASK, '--bought-as', 'used', '--price', '10', '--supplier', 'S', '--link', 'https://x.co']],
    ['a future --bought-on', ['--task', TASK, '--bought-as', 'new', '--price', '10', '--supplier', 'S', '--link', 'https://x.co', '--bought-on', '2026-11-12']],
    ['not-bought with --supplier', ['--task', TASK, '--bought-as', 'not-bought', '--supplier', 'S']],
    ['not-bought with --link', ['--task', TASK, '--bought-as', 'not-bought', '--link', 'https://x.co']],
    ['not-bought with --price', ['--task', TASK, '--bought-as', 'not-bought', '--price', '10']],
    ['not-bought with --cashback', ['--task', TASK, '--bought-as', 'not-bought', '--cashback', '5%']],
  ])('refuses %s with exit 2 and writes nothing', (_label, args) => {
    const r = py(`res = run("record", "--item", "Kettle", *${JSON.stringify(args)})\nout(dict(res, writes=len(writes())))`);
    expect(r.code).toBe(2);
    expect(r.writes).toBe(0);
    expect(r.out).toMatch(/^ERROR: /m);
  });

  it('--dry-run writes nothing', () => {
    const r = py(`res = run("record", "--task", "${TASK}", "--item", "Kettle", "--bought-as", "new", "--price", "15",
        "--supplier", "Shop", "--link", "https://example.com/k", "--dry-run")\nout(dict(res, writes=len(writes())))`);
    expect(r.code).toBe(0);
    expect(r.writes).toBe(0);
    expect(r.out).toContain('DRY RUN: would record created');
  });
});

describe('not-bought is rules only, and one definition of "this task bought it"', () => {
  it('not-bought on a bought row leaves the task, supplier, link, price, Bought As and dates alone', () => {
    const r = py(`
S.rows = [row("recEXISTING000001", "kettle", **{"Source Task": "${TASK}", "Last Bought": "2026-11-01",
          "Last Checked": "2026-11-01", "Notes": "2026-11-01: bought Second-hand £70.00 from Seller A (task ${TASK})"})]
before = json.loads(json.dumps(S.rows[0]["fields"]))
res = run("record", "--task", "recOTHERTASK00001", "--item", "Kettle", "--bought-as", "not-bought",
          "--rules", "Under £20", "--category", "Appliance")
sent = writes()[0][1]["records"][0]
after = S.rows[0]["fields"]
out(dict(res, method=writes()[0][0], keys=sorted(sent["fields"]),
         same=all(after.get(k) == before.get(k) for k in ("Source Task", "Supplier or Seller", "Link",
              "Full Price", "Bought As", "Last Bought", "Last Checked", "Item")),
         first=[x["id"] for x in pl.bought_rows_for_task("${TASK}")],
         other=[x["id"] for x in pl.bought_rows_for_task("recOTHERTASK00001")]))`);
    expect(r.code).toBe(0);
    expect(r.method).toBe('PATCH');
    expect(r.keys).toEqual(['Buying Rules', 'Category', 'Notes']);
    expect(r.same).toBe(true);
    expect(r.first).toEqual(['recEXISTING000001']);
    expect(r.other).toEqual([]);
  });

  it('a buy writes the "bought ... (task rec...)" Notes line, even on a new row', () => {
    const r = py(`
run("record", "--task", "${TASK}", "--item", "Kettle", "--bought-as", "new", "--price", "15",
    "--supplier", "Shop", "--link", "https://example.com/k", "--bought-on", "2026-11-10")
out(S.rows[0]["fields"]["Notes"])`);
    expect(r).toBe(`2026-11-10: bought New £15.00 from Shop (task ${TASK})`);
  });

  it('bought_rows_for_task: the bought Source Task row, never a Not bought yet row, and an earlier buyer via Notes', () => {
    const r = py(`
S.rows = [row("recBOUGHT00000001", "kettle", **{"Source Task": "${TASK}",
          "Notes": "2026-11-01: bought Second-hand £70.00 from Seller A (task ${TASK})"}),
          row("recNOTBOUGHT00001", "toaster", **{"Source Task": "${TASK}", "Bought As": "Not bought yet", "Full Price": None})]
a = [x["id"] for x in pl.bought_rows_for_task("${TASK}")]
# A later task buys the same kettle: Source Task moves to it, the first task still reads as a buyer.
run("record", "--task", "recLATERTASK00001", "--item", "Kettle", "--bought-as", "new", "--price", "18",
    "--supplier", "Shop", "--link", "https://example.com/k")
c = [x["id"] for x in pl.bought_rows_for_task("${TASK}")]
later = [x["id"] for x in pl.bought_rows_for_task("recLATERTASK00001")]
S.no_records = True
try:
    pl.bought_rows_for_task("${TASK}"); err = "no error"
except RuntimeError:
    err = "raised"
out([a, S.rows[0]["fields"]["Source Task"], c, later, err])`);
    expect(r[0]).toEqual(['recBOUGHT00000001']);
    expect(r[1]).toBe('recLATERTASK00001');
    expect(r[2]).toEqual(['recBOUGHT00000001']);
    expect(r[3]).toEqual(['recBOUGHT00000001']);
    expect(r[4]).toBe('raised');
  });
});

describe('prefer: the monthly review changes the preferred option', () => {
  const PREF = ['--key', 'kettle', '--task', TASK, '--price', '12.50', '--supplier', 'Cheaper Shop',
    '--link', 'https://example.com/k2', '--on', '2026-11-10'];

  it('writes only the Preferred fields, the check and a Notes line; Last Bought, Source Task, rules, category and status stay', () => {
    const r = py(`
S.rows = [row("recEXISTING000001", "kettle", **{"Full Price": 15.0, "Supplier or Seller": "Shop",
          "Last Bought": "2026-11-11", "Source Task": "recOLDTASK0000001", "Buying Rules": "Under £20",
          "Category": "Appliance", "Notes": "older line"})]
res = run("prefer", *${JSON.stringify(PREF)})
sent = writes()[0][1]["records"][0]["fields"]
out(dict(res, keys=sorted(sent), row=S.rows[0]["fields"]))`);
    expect(r.code).toBe(0);
    expect(r.keys).toEqual(['Last Check Result', 'Last Checked', 'Notes', 'Preferred Link', 'Preferred Price',
      'Preferred Since', 'Preferred Supplier']);
    expect(r.row['Last Bought']).toBe('2026-11-11');
    expect(r.row['Source Task']).toBe('recOLDTASK0000001');
    expect(r.row['Buying Rules']).toBe('Under £20');
    expect(r.row['Preferred Since']).toBe('2026-11-10');
    expect(r.row['Last Check Result']).toBe(`adopted on review (${TASK}): £12.50 at Cheaper Shop`);
    expect(r.row.Notes).toBe(`older line\n2026-11-10: preferred option set on review (${TASK}): £12.50 at Cheaper Shop; last buy stays £15.00 from Shop`);
    expect(r.out).toContain('PREFERRED: recEXISTING000001 kettle £12.50 Cheaper Shop (last buy £15.00 unchanged)');
  });

  it("the reviewer's case: a second-hand kettle bought at £40, then £300 preferred at a shop, keeps the last buy", () => {
    const r = py(`
S.rows = [row("recKETTLE00000001", "kettle", **{"Full Price": 40.0, "Bought As": "Second-hand",
          "Supplier or Seller": "Marketplace seller", "Link": "https://example.com/used", "Last Bought": "2026-10-01",
          "Cashback": "none"})]
before = json.loads(json.dumps(S.rows[0]["fields"]))
res = run("prefer", "--key", "kettle", "--task", "${TASK}", "--price", "300", "--supplier", "A Shop",
          "--link", "https://example.com/new")
after = S.rows[0]["fields"]
out(dict(res, kept={k: after.get(k) == before.get(k) for k in ("Full Price", "Bought As", "Supplier or Seller",
         "Link", "Last Bought", "Cashback")},
         pref=[after.get(k) for k in ("Preferred Supplier", "Preferred Link", "Preferred Price", "Preferred Since")],
         due=len(pl.due_rows(S.rows, date(2026, 11, 11)))))`);
    expect(r.code).toBe(0);
    expect(Object.values(r.kept).every(Boolean)).toBe(true);
    expect(r.pref).toEqual(['A Shop', 'https://example.com/new', 300, '2026-11-11']);
    expect(r.due).toBe(0);
    expect(r.out).toContain('(last buy £40.00 unchanged)');
  });

  it('no longer accepts --cashback', () => {
    const r = py(`S.rows = [row("recEXISTING000001", "kettle")]\nres = run("prefer", *${JSON.stringify(PREF)}, "--cashback", "5%")\nout(dict(res, writes=len(writes())))`);
    expect(r.code).toBe(2);
    expect(r.writes).toBe(0);
  });

  it('refuses a row that has not been bought, and no longer accepts --bought-as', () => {
    const r = py(`
S.rows = [row("recEXISTING000001", "kettle", **{"Bought As": "Not bought yet", "Full Price": None})]
a = run("prefer", *${JSON.stringify(PREF)})
b = run("prefer", *${JSON.stringify(PREF)}, "--bought-as", "new")
out([a, b["code"], len(writes())])`);
    expect(r[0].code).toBe(2);
    expect(r[0].out).toContain('ERROR: prefer changes the preferred option of an item we have bought; this one has not been bought yet');
    expect(r[1]).toBe(2);
    expect(r[2]).toBe(0);
  });

  it('rules stored by task A, then prefer by review task R, never makes A read as a buyer', () => {
    const r = py(`
A, R = "recTASKAAAAAAAAAA", "recTASKRRRRRRRRRR"
run("record", "--task", A, "--item", "Kettle", "--bought-as", "not-bought", "--rules", "Under £20")
p = run("prefer", "--key", "kettle", "--task", R, "--price", "12", "--supplier", "Shop", "--link", "https://x.co")
out([p["code"], S.rows[0]["fields"]["Bought As"], [x["id"] for x in pl.bought_rows_for_task(A)],
     [x["id"] for x in pl.bought_rows_for_task(R)]])`);
    expect(r).toEqual([2, 'Not bought yet', [], []]);
  });

  it('an unknown key exits 2', () => {
    const r = py(`S.rows = [row("recEXISTING000001", "toaster")]\nres = run("prefer", *${JSON.stringify(PREF)})\nout(dict(res, writes=len(writes())))`);
    expect(r.code).toBe(2);
    expect(r.writes).toBe(0);
  });

  it('--dry-run writes nothing', () => {
    const r = py(`S.rows = [row("recEXISTING000001", "kettle")]\nres = run("prefer", *${JSON.stringify(PREF)}, "--dry-run")\nout(dict(res, writes=len(writes())))`);
    expect(r.code).toBe(0);
    expect(r.writes).toBe(0);
  });

  it('a field that does not stick exits 4', () => {
    const r = py(`S.rows = [row("recEXISTING000001", "kettle")]\nS.drop = {"Preferred Link"}\nout(run("prefer", *${JSON.stringify(PREF)}))`);
    expect(r.code).toBe(4);
    expect(r.out).toContain('Link');
  });
});

describe('checked, has-row and list', () => {
  it('checked stamps the row; an unknown key exits 2', () => {
    const r = py(`
S.rows = [row("recEXISTING000001", "kettle")]
a = run("checked", "--key", "kettle", "--result", "no change", "--on", "2026-11-10")
b = run("checked", "--key", "toaster", "--result", "no change")
out([a, b["code"], S.rows[0]["fields"]["Last Check Result"]])`);
    expect(r[0].code).toBe(0);
    expect(r[0].out.trim()).toBe('CHECKED: recEXISTING000001 kettle 2026-11-10');
    expect(r[1]).toBe(2);
    expect(r[2]).toBe('no change');
  });

  it('has-row uses bought_rows_for_task: exits 0 with the ids, or 1 with NO ROW', () => {
    const r = py(`
S.rows = [row("recEXISTING000001", "kettle", **{"Source Task": "${TASK}"}),
          row("recEXISTING000002", "toaster", **{"Source Task": "recNOTBOUGHT00001", "Bought As": "Not bought yet"})]
out([run("has-row", "--task", "${TASK}"), run("has-row", "--task", "recOTHERTASK00001"),
     run("has-row", "--task", "recNOTBOUGHT00001")["code"]])`);
    expect(r[0]).toEqual({ code: 0, out: `recEXISTING000001 (bought by ${TASK})\n` });
    expect(r[1]).toEqual({ code: 1, out: 'NO ROW for recOTHERTASK00001 (no row on the list was bought by this task)\n' });
    expect(r[2]).toBe(1);
  });

  it('a future --on date exits 2 for checked and prefer', () => {
    const r = py(`
S.rows = [row("recEXISTING000001", "kettle")]
out([run("checked", "--key", "kettle", "--result", "x", "--on", "2026-11-12")["code"],
     run("prefer", "--key", "kettle", "--task", "${TASK}", "--price", "5", "--supplier", "S",
         "--link", "https://x.co", "--on", "2026-11-12")["code"], len(writes())])`);
    expect(r).toEqual([2, 2, 0]);
  });

  it('list --item shows the last buy, then the option preferred on review, then the last check', () => {
    const r = py(`
S.rows = [row("recKETTLE00000001", "kettle", **{"Full Price": 40.0, "Supplier or Seller": "Marketplace seller",
          "Preferred Supplier": "A Shop", "Preferred Price": 300.0, "Preferred Link": "https://example.com/new",
          "Preferred Since": "2026-11-10", "Last Checked": "2026-11-10", "Last Check Result": "adopted"})]
out(run("list", "--item", "kettle")["out"].strip().split("\\n"))`);
    expect(r[0]).toBe('BASELINE:');
    expect(r[1]).toMatch(/^kettle \| kettle \| £40\.00 \| Second-hand \| Marketplace seller \|/);
    expect(r[2]).toBe('PREFERRED ON REVIEW (2026-11-10): £300.00 at A Shop https://example.com/new');
    expect(r[3]).toBe('last checked 2026-11-10 (adopted)');
  });

  // Fourth review, 11 Nov 2026: a review preferred £60 at a shop on 10 Nov; a real buy at £50 followed.
  // The buy is then the price to beat: the old option is not shown and the old review's words are gone.
  it('a real buy after a review replaces the review as the thing to beat', () => {
    const r = py(`
S.rows = [row("recKETTLE00000001", "kettle", **{"Full Price": 40.0, "Last Bought": "2026-10-01",
          "Preferred Supplier": "A Shop", "Preferred Price": 60.0, "Preferred Link": "https://example.com/new",
          "Preferred Since": "2026-11-10", "Last Checked": "2026-11-10",
          "Last Check Result": "adopted on review (recREVIEWTASK0001): £60.00 at A Shop"})]
before = run("list", "--item", "kettle")["out"]
buy = run("record", "--task", "${TASK}", "--item", "kettle", "--bought-as", "second-hand", "--price", "50",
          "--supplier", "Gumtree seller", "--link", "https://example.com/g", "--bought-on", "2026-11-11")
sent = writes()[-1][1]["records"][0]["fields"]
out({"before": before, "code": buy["code"], "result": sent.get("Last Check Result"),
     "preferredSent": [k for k in sent if k.startswith("Preferred")],
     "after": run("list", "--item", "kettle")["out"]})`);
    expect(r.before).toContain('PREFERRED ON REVIEW (2026-11-10): £60.00 at A Shop');
    expect(r.code).toBe(0);
    expect(r.result).toBe('bought Second-hand £50.00 from Gumtree seller (task ' + TASK + ')');
    expect(r.preferredSent).toEqual([]);
    expect(r.after).toContain('£50.00 | Second-hand | Gumtree seller');
    expect(r.after).not.toContain('PREFERRED ON REVIEW');
    expect(r.after).toContain('last checked 2026-11-11 (bought Second-hand £50.00 from Gumtree seller');
    expect(r.after).not.toContain('adopted on review');
  });

  it('list --item prints the baseline with the last check, or the none line', () => {
    const r = py(`
S.rows = [row("recEXISTING000001", "fridge-freezer-full-height", **{"Last Checked": "2026-12-11",
          "Last Check Result": "no change"}), row("recEXISTING000002", "kettle")]
out([run("list", "--item", "freezer fridge"), run("list", "--item", "Washing machine")])`);
    expect(r[0].code).toBe(0);
    expect(r[0].out.split('\n')[0]).toBe('BASELINE:');
    expect(r[0].out).toContain('last checked 2026-12-11 (no change)');
    expect(r[0].out).not.toContain('kettle');
    expect(r[1].out.trim()).toBe('BASELINE: none on the list for Washing machine');
  });
});

describe('selftest', () => {
  it('passes with no network', () => {
    const out = execFileSync('python3', [SCRIPT, 'selftest'], {
      encoding: 'utf8', env: { ...process.env, PREFLIST_PAT_FILE: '/nonexistent/key' } });
    expect(out).toMatch(/^SELFTEST: \d+ checks passed/);
  });
});
