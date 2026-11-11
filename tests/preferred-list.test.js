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
        self.tasks = []         # Tasks rows, name-keyed
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
        src = S.rows if table == pl.TABLE else S.tasks if table == pl.TASKS else None
        if src is None:
            raise AssertionError("unexpected table %s" % table)
        return {"records": json.loads(json.dumps(src))}
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

  it('an open review task means nothing is created and the line says already open', () => {
    const r = py(`
S.rows = [row("r1", "a")]
S.tasks = [{"id": "recOPENREVIEW0001", "fields": {"Task Name": "x", "Status": "Today",
            "Description": "PREFLIST\\\\-REVIEW 2026-11\\nstuff"}}]
res = run("due", "--apply")
out(dict(res, gate=len(GATE)))`);
    expect(r.code).toBe(0);
    expect(r.gate).toBe(0);
    expect(r.out).toContain('review task: already open recOPENREVIEW0001');
  });

  it('a completed review task does not count as open', () => {
    const r = py(`
S.rows = [row("r1", "a")]
S.tasks = [{"id": "recDONEREVIEW0001", "fields": {"Status": "Completed", "Description": "PREFLIST-REVIEW 2026-10"}}]
res = run("due", "--apply")
out(dict(res, real=len([g for g in GATE if "--force" in g["flags"]])))`);
    expect(r.real).toBe(1);
    expect(r.out).toContain('review task: raised recNEWTASK0000001');
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
      'PREFERRED LIST: 3 item(s) on the list, 3 priced, 2 due for a re-price, review task: raised recNEWTASK0000001');
  });

  it('without --apply it creates nothing and says would raise', () => {
    const r = py(`
S.rows = [row("r1", "a")]
res = run("due")
out(dict(res, real=len([g for g in GATE if "--force" in g["flags"]]), writes=len(writes())))`);
    expect(r.real).toBe(0);
    expect(r.writes).toBe(0);
    expect(r.out.trim().split('\n').pop()).toBe(
      'PREFERRED LIST: 1 item(s) on the list, 1 priced, 1 due for a re-price, review task: would raise (dry run)');
  });

  it('nothing due: no task read, none needed, and the line stays under 220 characters', () => {
    const r = py(`
S.rows = [row("r1", "a", **{"Last Checked": "2026-11-01"})]
res = run("due", "--apply")
out(dict(res, gate=len(GATE), taskReads=len([c for c in S.calls if c[1] == pl.TASKS]),
         long=len(pl.summary_line(99999, 99999, 99999, "already open " + "x" * 300))))`);
    expect(r.gate).toBe(0);
    expect(r.taskReads).toBe(0);
    expect(r.long).toBeLessThanOrEqual(220);
    expect(r.out.trim().split('\n').pop()).toBe(
      'PREFERRED LIST: 1 item(s) on the list, 1 priced, 0 due for a re-price, review task: none needed');
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
    expect(r.rows[0].fields.Notes).toMatch(/^2026-11-11: updated from task reck5ZY5MoXulxJz8\. Was £-, Not bought yet/);
    expect(r.out).toContain('RECORDED: updated recPREF0000000001 fridge-freezer-full-height £70.00 Second-hand');
  });

  it('(c) that row 30 days later is due and raises one review task', () => {
    const r = py(`
run("record", "--task", "${TASK}", "--item", ${JSON.stringify(FRIDGE)}, "--bought-as", "second-hand",
    "--price", "70", "--supplier", "Seller", "--link", "https://example.com/item/1", "--bought-on", "2026-11-11")
res = run("due", "--apply", "--as-of", "2026-12-11")
out(dict(res, real=len([g for g in GATE if "--force" in g["flags"]])))`);
    expect(r.real).toBe(1);
    expect(r.out).toContain('1 due for a re-price, review task: raised recNEWTASK0000001');
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

  it.each([
    ['a bad task id', ['--task', 'recSHORT', '--bought-as', 'new', '--price', '10', '--supplier', 'S', '--link', 'https://x.co']],
    ['a zero price', ['--task', TASK, '--bought-as', 'new', '--price', '0', '--supplier', 'S', '--link', 'https://x.co']],
    ['a non-http link', ['--task', TASK, '--bought-as', 'new', '--price', '10', '--supplier', 'S', '--link', 'ftp://x.co']],
    ['a buy with no supplier', ['--task', TASK, '--bought-as', 'new', '--price', '10', '--link', 'https://x.co']],
    ['an unknown category', ['--task', TASK, '--bought-as', 'new', '--price', '10', '--supplier', 'S', '--link', 'https://x.co', '--category', 'Cars']],
    ['an unknown bought-as', ['--task', TASK, '--bought-as', 'used', '--price', '10', '--supplier', 'S', '--link', 'https://x.co']],
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

describe('prefer: the monthly review changes the preferred option', () => {
  const PREF = ['--key', 'kettle', '--task', TASK, '--price', '12.50', '--supplier', 'Cheaper Shop',
    '--link', 'https://example.com/k2', '--on', '2026-12-11'];

  it('updates the right fields only and leaves Last Bought, Source Task, rules, category and status alone', () => {
    const r = py(`
S.rows = [row("recEXISTING000001", "kettle", **{"Full Price": 15.0, "Supplier or Seller": "Shop",
          "Last Bought": "2026-11-11", "Source Task": "recOLDTASK0000001", "Buying Rules": "Under £20",
          "Category": "Appliance", "Notes": "older line"})]
res = run("prefer", *${JSON.stringify(PREF)})
sent = writes()[0][1]["records"][0]["fields"]
out(dict(res, keys=sorted(sent), row=S.rows[0]["fields"]))`);
    expect(r.code).toBe(0);
    expect(r.keys).toEqual(['Full Price', 'Last Check Result', 'Last Checked', 'Link', 'Notes', 'Supplier or Seller']);
    expect(r.row['Last Bought']).toBe('2026-11-11');
    expect(r.row['Source Task']).toBe('recOLDTASK0000001');
    expect(r.row['Buying Rules']).toBe('Under £20');
    expect(r.row['Last Check Result']).toBe(`adopted on review (${TASK}): £12.50 at Cheaper Shop`);
    expect(r.row.Notes).toBe(`older line\n2026-12-11: preferred option changed on review (${TASK}): was £15.00 at Shop, now £12.50 at Cheaper Shop`);
    expect(r.out).toContain('PREFERRED: recEXISTING000001 kettle £15.00 -> £12.50 Cheaper Shop');
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
    const r = py(`S.rows = [row("recEXISTING000001", "kettle")]\nS.drop = {"Link"}\nout(run("prefer", *${JSON.stringify(PREF)}))`);
    expect(r.code).toBe(4);
    expect(r.out).toContain('Link');
  });
});

describe('checked, has-row and list', () => {
  it('checked stamps the row; an unknown key exits 2', () => {
    const r = py(`
S.rows = [row("recEXISTING000001", "kettle")]
a = run("checked", "--key", "kettle", "--result", "no change", "--on", "2026-12-11")
b = run("checked", "--key", "toaster", "--result", "no change")
out([a, b["code"], S.rows[0]["fields"]["Last Check Result"]])`);
    expect(r[0].code).toBe(0);
    expect(r[0].out.trim()).toBe('CHECKED: recEXISTING000001 kettle 2026-12-11');
    expect(r[1]).toBe(2);
    expect(r[2]).toBe('no change');
  });

  it('has-row exits 0 with the ids, or 1 with NO ROW', () => {
    const r = py(`
S.rows = [row("recEXISTING000001", "kettle", **{"Source Task": "${TASK}"})]
out([run("has-row", "--task", "${TASK}"), run("has-row", "--task", "recOTHERTASK00001")])`);
    expect(r[0]).toEqual({ code: 0, out: 'recEXISTING000001\n' });
    expect(r[1]).toEqual({ code: 1, out: 'NO ROW for recOTHERTASK00001\n' });
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
