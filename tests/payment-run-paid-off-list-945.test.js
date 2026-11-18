// Finding 20261016-agent-dispatch-945 (critical): the robots had no audited door for a payment
// already made, and none for a cost line on a card approved "with minor edits".
//
// Kevin's ruling of 27 Sep 2026 ("paid off the list"): a business-account payment with no Payment
// Run row gets a Paid row added after the fact, linked to its bank line, so the daily
// payments-came-through-the-list check clears. But `payment-run.py write` refuses any row with no
// Gmail message id, and no command set Paid Date or Matched Transaction on a named row. Two tasks
// sat on a TOOL wall from 16 and 18 Oct 2026 with a dozen payments prepared and nothing written.
// `paid-off-list` is that door. Its gate is the bank line, read live: the transaction must be money
// out of the business account, a payment Kevin sent (not a card purchase, direct debit or fee), of
// the stated amount (a split payment at its own part) on the stated day, and claimed by no other
// row, nor any other part of its split. A new row is refused beside a row that may already be this
// payment's bill; a named row passes settle's own checks. Every read pages, a reply with no
// `records` list is an error, a create is sent once, and a re-run finds its own row by its marker.
// A bill emailed after an off-list payment is kept off the list as a Duplicate of it.
//
// The same task's card was approved "with minor edits" (Kevin's note was information, not an edit),
// and cost-record.py refused every such approval. It now accepts one with the same approval marks
// as "as-is", and only for a line Kevin read: with no note the card as it stands; with a note, only
// once `agent-dispatch.py revise` has applied it, only a line in BOTH the text he approved and the
// revised card (or one his note's own value changed), and never a value his note asked to change.
//
// Not decided here, on purpose: how a WEEKLY cost is written (last test).
//
// Drives the real scripts, the payment run through its real Airtable transport, against a fake
// Airtable. Every name, amount and date is invented: on 18 Nov 2026 a read-only count found no bank
// line and no Payment Run row dated March or April 2021 (controls: 41 bank lines on 1-2 Oct 2026,
// 8 Payment Run rows on 1-14 Oct 2026). The repo is public.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PR_PY = join(ROOT, 'scripts', 'payment-run.py');
const CR_PY = join(ROOT, 'scripts', 'cost-record.py');
const DISPATCH = join(ROOT, 'scripts', 'agent-dispatch.py');

// ── payment-run.py paid-off-list ───────────────────────────────────────────
const TX = 'recTXPAY000000001';
const TXLAB = 'recTXLAB000000001';
const TXOTHER = 'recTXOTH000000001';
const TXSPLIT1 = 'recTXSPL000000001';
const TXSPLIT2 = 'recTXSPL000000002';
const TXGAS = 'recTXGAS000000001';
const TASK = 'recTASK0000000001';
const BIZ = 'recBIZ00000000001';
const NEWROW = 'recNEWROW00000001';
const ROW_OPEN = 'recROWOPEN0000001';
const ROW_OTHER = 'recROWOTHER000001';
const ROW_CLAIM = 'recROWCLAIM000001';
const ROW_RIVAL = 'recROWRIVAL000001';
const ZEM = 'TNT Mgt Zempler';   // the business payment account's alias, already in the script

const tx = (id, name, gbp, day, extra = {}) => ({
  id, fields: { 'Account Alias (from **Account)': [ZEM], '**GBP': gbp, '*Name': name, '**Date': day, ...extra },
});
const row = (id, fields) => ({ id, fields });
const PAY = tx(TX, 'Oakline Ltd 18 Birch Row', -63.4, '2021-03-11');
const LABOUR = tx(TXLAB, 'R Example 3 Ash Road', -412.75, '2021-03-13');
// An unrelated paid row, so the list read is never empty.
const OTHER = row(ROW_OTHER, { Status: 'Paid', Payee: 'Elm Glass', Amount: 38.15, 'Paid Date': '2021-03-02',
  'Matched Transaction': [TXOTHER] });
const DB = (extra = {}) => ({
  tx: [PAY, LABOUR], tasks: [{ id: TASK, fields: { 'Task Name': 'Payment Run gap: two payments' } }],
  biz: [{ id: BIZ, fields: {} }], rows: [OTHER], ...extra,
});
const NEW = (more = []) => ['--transaction', TX, '--amount', '63.40', '--date', '2021-03-11', '--task', TASK,
  '--payee', 'Oakline Ltd', ...more];
const WHY = ['--bank-line-names-other', 'the labour invoice names the crew lead, who is paid in person'];
const LINK = (more = []) => ['--transaction', TXLAB, '--amount', '412.75', '--date', '2021-03-13', '--task', TASK,
  '--row', ROW_OPEN, ...more];
const OPEN_LAB = (fields = {}) => row(ROW_OPEN, { Status: 'Unpaid', Payee: 'Pine Labour Services', Amount: 412.75,
  'Email Date': '2021-03-12', ...fields });
const BILL = (mid, day, extra = {}) => ({ messageId: mid, payee: 'Oakline Ltd', amount: 63.4, emailDate: day,
  description: 'Garden clearance, 18 Birch Row', status: 'Unpaid', ...extra });

const PR_HARNESS = String.raw`
import importlib.util, json, sys, os, io, contextlib, urllib.parse, urllib.request, copy, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("pr", sys.argv[1])
pr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pr)
pr.PRIVATE_CONFIG = Path("/nonexistent-od-test/payment-run.json")
pr.time.sleep = lambda s: None
pr.read_secret = lambda path, what: "test-token"
TABLES = {pr.T_TRANSACTIONS: "tx", pr.T_TASKS: "tasks", pr.T_BUSINESSES: "biz", pr.T_INVOICES: "rows"}
class Resp:
    def __init__(self, body): self._b = json.dumps(body).encode()
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False
def run(c):
    db = copy.deepcopy(c["db"])
    writes, gets, made = [], [], [0]
    def fake(method, path, payload):
        head, _, qs = path.partition("?")
        table = head.strip("/").split("/")[1]
        if table not in TABLES:
            raise AssertionError("unexpected table %s" % table)
        src = db.setdefault(TABLES[table], [])
        q = urllib.parse.parse_qs(qs)
        if method == "GET":
            formula = (q.get("filterByFormula") or [""])[0]
            gets.append({"table": TABLES[table], "formula": formula, "offset": (q.get("offset") or [""])[0]})
            if formula.startswith("AND(DATESTR("):
                day = formula.split("'")[1]
                return {"records": [copy.deepcopy(r) for r in src if r["fields"].get("**Date") == day
                                    and float(r["fields"].get("**GBP") or 0) < 0]}
            if formula:
                rid = formula.split("'")[1]
                return {"records": [copy.deepcopy(r) for r in src if r["id"] == rid]}
            if c.get("noRecords"):
                return {"error": {"type": "INVALID_PERMISSIONS"}}
            size = c.get("pageSize", 100)
            start = int((q.get("offset") or ["0"])[0])
            page = {"records": copy.deepcopy(src[start:start + size])}
            if start + size < len(src):
                page["offset"] = str(start + size)
            return page
        writes.append({"method": method, "table": TABLES[table], "records": copy.deepcopy(payload["records"])})
        out = []
        for rec in payload["records"]:
            if method == "POST":
                made[0] += 1
                new = {"id": "recNEWROW%08d" % made[0], "fields": dict(rec["fields"])}
                if not c.get("ignoreWrites"):
                    src.append(new)
                out.append(new)
            else:
                target = next(r for r in src if r["id"] == rec["id"])
                if not c.get("ignoreWrites"):
                    target["fields"].update(rec["fields"])
                out.append(target)
        return {"records": out}
    def urlopen(req, timeout=None):
        method = req.get_method()
        body = fake(method, req.full_url.split("/v0/", 1)[1], json.loads(req.data.decode()) if req.data else None)
        if method == "POST" and c.get("postTimeout"):
            raise TimeoutError("the read operation timed out")   # it landed, the answer never came back
        return Resp(body)
    urllib.request.urlopen = urlopen
    unlisted = lambda: sorted(t["id"] for t in pr.unlisted_transfers(db.get("tx", []), db.get("rows", [])))
    before = unlisted()
    steps = c.get("steps") or [{"argv": c["argv"]}]
    results = []
    for step in steps:
        if "write" in step:
            path = os.path.join(tempfile.mkdtemp(), "items.json")
            open(path, "w").write(json.dumps(step["write"]))
            argv = ["write", "--items", path, "--run-date", "2021-03-19"]
        else:
            argv = ["paid-off-list"] + step["argv"]
        buf, err, code = io.StringIO(), io.StringIO(), 0
        try:
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err):
                pr.main(argv)
        except SystemExit as e:
            code = e.code
        except Exception as e:
            code, err = "crash", io.StringIO("%s: %s" % (type(e).__name__, e))
        text = buf.getvalue().strip()
        try:
            out = json.loads(text) if text else None
        except ValueError:
            out = {"raw": text}
        results.append({"code": code, "out": out, "err": err.getvalue()})
    _links, settles, _probable = pr.plan_all(db.get("rows", []), pr.index_by_amount(db.get("tx", [])), "")
    return dict(results[-1], steps=results, writes=writes, gets=gets, rows=db.get("rows", []),
                unlistedBefore=before, unlistedAfter=unlisted(),
                owed=sorted(r["id"] for r in db.get("rows", []) if pr.status_of(r) in ("Unpaid", "")),
                settles=sorted(r["id"] for r, _t in settles))
print(json.dumps({k: run(c) for k, c in json.loads(sys.argv[2]).items()}))
`;

function paid(cases) {
  const out = execFileSync('python3', ['-c', PR_HARNESS, PR_PY, JSON.stringify(cases)], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const refused = (r) => (r.out && r.out.refused) || '';
const byId = (r, id) => r.rows.find((x) => x.id === id);

describe('payment-run.py paid-off-list: a payment already made goes on the list against its bank line', () => {
  it('a dry run says what it would write and writes nothing', () => {
    const { dry } = paid({ dry: { db: DB(), argv: NEW() } });
    expect(dry.code).toBe(0);
    expect(dry.out.dryRun).toBe(true);
    expect(dry.out.action).toBe('add a Paid row');
    expect(dry.writes).toEqual([]);
  });

  it('adds ONE Paid row linked to the bank line, with no Gmail message id, and the absence check clears', () => {
    const { create } = paid({ create: { db: DB(), argv: NEW(['--business', BIZ, '--apply']) } });
    expect(create.code).toBe(0);
    expect(create.out.written).toBe(true);
    expect(create.out.row).toBe(NEWROW);
    expect(create.writes).toHaveLength(1);
    expect(create.writes[0].method).toBe('POST');
    const f = create.writes[0].records[0].fields;
    expect(f).toMatchObject({ Status: 'Paid', 'Paid Date': '2021-03-11', 'Matched Transaction': [TX],
      Amount: 63.4, Payee: 'Oakline Ltd', Business: [BIZ] });
    expect(f).not.toHaveProperty('Gmail Message ID');
    expect(f.Notes).toMatch(/Paid off the list \(Kevin's ruling, 27 Sep 2026\)/);
    expect(f.Notes).toContain(TASK);
    expect(create.unlistedBefore).toContain(TX);
    expect(create.unlistedAfter).not.toContain(TX);
  });

  it('refuses a bank line that is not money out, not from the business account, or not a payment Kevin sent', () => {
    const r = paid({
      moneyIn: { db: DB({ tx: [tx(TX, 'Oakline Ltd refund', 63.4, '2021-03-11')] }), argv: NEW() },
      otherAccount: { db: DB({ tx: [tx(TX, 'Oakline Ltd', -63.4, '2021-03-11',
        { 'Account Alias (from **Account)': ['Personal Current'] })] }), argv: NEW() },
      cardPurchase: { db: DB({ tx: [tx(TX, 'Fin: OAKLINE*ORDER 1234', -63.4, '2021-03-11')] }), argv: NEW() },
    });
    expect(refused(r.moneyIn)).toMatch(/is not money out/);
    expect(refused(r.otherAccount)).toMatch(/not the business payment account/);
    expect(refused(r.cardPurchase)).toMatch(/card purchase/);
    for (const c of Object.values(r)) {
      expect(c.code).toBe(2);
      expect(c.writes).toEqual([]);
    }
  });

  it('refuses when the amount or the date does not agree with the bank line', () => {
    const r = paid({
      amount: { db: DB(), argv: ['--transaction', TX, '--amount', '64.40', '--date', '2021-03-11', '--task', TASK,
        '--payee', 'Oakline Ltd'] },
      date: { db: DB(), argv: ['--transaction', TX, '--amount', '63.40', '--date', '2021-03-12', '--task', TASK,
        '--payee', 'Oakline Ltd'] },
    });
    expect(r.amount.code).toBe(2);
    expect(refused(r.amount)).toMatch(/pays £63\.40, not £64\.40/);
    expect(r.date.code).toBe(2);
    expect(refused(r.date)).toMatch(/is dated 2021-03-11, not 2021-03-12/);
    expect([...r.amount.writes, ...r.date.writes]).toEqual([]);
  });

  const SPLIT1 = tx(TXSPLIT1, 'Oakline Ltd 3 Ash Road 9 Elm Road (Split 1 of 2)', -91.2, '2021-03-18',
    { 'Split Override Amount': -45.6 });
  const SPLIT2 = tx(TXSPLIT2, 'Oakline Ltd 3 Ash Road 9 Elm Road (Split 2 of 2)', -45.6, '2021-03-18');
  const SPLIT_ARGV = (amt, txid = TXSPLIT1) => ['--transaction', txid, '--amount', amt, '--date', '2021-03-18',
    '--task', TASK, '--payee', 'Oakline Ltd'];

  it('a split payment is recorded at its own part only, never the whole, and never its second part', () => {
    const r = paid({
      part: { db: DB({ tx: [SPLIT1, SPLIT2] }), argv: SPLIT_ARGV('45.60') },
      whole: { db: DB({ tx: [SPLIT1, SPLIT2] }), argv: SPLIT_ARGV('91.20') },
      secondPart: { db: DB({ tx: [SPLIT1, SPLIT2] }), argv: SPLIT_ARGV('45.60', TXSPLIT2) },
    });
    expect(r.part.out.dryRun).toBe(true);
    expect(r.whole.code).toBe(2);
    expect(refused(r.whole)).toMatch(/pays £45\.60 \(its own split part; the whole bank payment is £91\.20/);
    expect(refused(r.secondPart)).toMatch(/second part of a split/);
  });

  it('refuses a split part when another row already holds any part of that split payment', () => {
    const heldPart2 = row(ROW_CLAIM, { Status: 'Paid', Payee: 'Oakline Ltd', Amount: 45.6, 'Paid Date': '2021-03-18',
      Description: '9 Elm Road', 'Matched Transaction': [TXSPLIT2] });
    const { held } = paid({ held: { db: DB({ tx: [SPLIT1, SPLIT2], rows: [OTHER, heldPart2] }),
      argv: SPLIT_ARGV('45.60', TXSPLIT1).concat(['--apply']) } });
    expect(held.code).toBe(2);
    expect(refused(held)).toMatch(new RegExp(`another part of this split payment is already held by row ${ROW_CLAIM}`));
    expect(held.writes).toEqual([]);
  });

  it('refuses a bank line another row already claims, even when that row is on a later page', () => {
    const claimed = row(ROW_CLAIM, { Status: 'Paid', Payee: 'Oakline Ltd', Amount: 63.4, 'Paid Date': '2021-03-11',
      'Matched Transaction': [TX] });
    const { page2 } = paid({ page2: { db: DB({ rows: [OTHER, OPEN_LAB(), claimed] }), pageSize: 2, argv: NEW() } });
    expect(page2.code).toBe(2);
    expect(refused(page2)).toMatch(new RegExp(`already claimed by row ${ROW_CLAIM}`));
    expect(page2.gets.filter((g) => g.table === 'rows' && !g.formula).map((g) => g.offset)).toEqual(['', '2']);
    expect(page2.writes).toEqual([]);
  });

  it('a list reply with no records is an error, never an empty list, and an empty list is a broken read', () => {
    const r = paid({
      noRecords: { db: DB(), noRecords: true, argv: NEW(['--apply']) },
      empty: { db: DB({ rows: [] }), argv: NEW(['--apply']) },
    });
    expect(r.noRecords.code).toBe(1);
    expect(r.noRecords.err).toMatch(/no records list/);
    expect(r.empty.code).toBe(1);
    expect(r.empty.err).toMatch(/returned no rows at all/);
    expect([...r.noRecords.writes, ...r.empty.writes]).toEqual([]);
  });

  it('never adds a second row while an open bill of the same payee and amount is on the list', () => {
    const open = row(ROW_OPEN, { Status: 'Unpaid', Payee: 'Oakline Limited', Amount: 63.4, 'Email Date': '2021-03-09' });
    const { twin } = paid({ twin: { db: DB({ rows: [OTHER, open] }), argv: NEW(['--apply']) } });
    expect(twin.code).toBe(2);
    expect(refused(twin)).toMatch(new RegExp(`link it with --row ${ROW_OPEN}`));
    expect(twin.writes).toEqual([]);
  });

  it('never adds a second row beside a hand-paid row with no bank line, or a Historic row, of that payee and amount', () => {
    const hand = row(ROW_OPEN, { Status: 'Paid', Payee: 'Oakline Ltd', Amount: 63.4, 'Paid Date': '2021-03-10' });
    const historic = row(ROW_OPEN, { Status: 'Historic', Payee: 'Oakline Ltd', Amount: 63.4, 'Email Date': '2020-11-02' });
    const r = paid({
      hand: { db: DB({ rows: [OTHER, hand] }), argv: NEW(['--apply']) },
      historic: { db: DB({ rows: [OTHER, historic] }), argv: NEW(['--apply']) },
      // A Paid row linked to ANOTHER bank line is another payment: a contractor paid the same sum weekly.
      lastWeek: { db: DB({ rows: [OTHER, row(ROW_CLAIM, { Status: 'Paid', Payee: 'Oakline Ltd', Amount: 63.4,
        'Paid Date': '2021-03-04', 'Matched Transaction': [TXOTHER] })] }), argv: NEW() },
    });
    expect(r.hand.code).toBe(2);
    expect(refused(r.hand)).toMatch(new RegExp(`marked Paid by hand with no bank line.*--row ${ROW_OPEN}`));
    expect(r.historic.code).toBe(2);
    expect(refused(r.historic)).toMatch(new RegExp(`is Historic.*historic --ids ${ROW_OPEN} --restore`));
    expect([...r.hand.writes, ...r.historic.writes]).toEqual([]);
    expect(r.lastWeek.out.dryRun).toBe(true);
  });

  it('a bill emailed AFTER an off-list payment is kept off the list, so it is never owed and paid twice', () => {
    const { flow } = paid({ flow: { db: DB(), steps: [
      { argv: NEW(['--apply']) },
      { write: [BILL('18a0f00dcafe0101', '2021-03-15')] },
      // A second bill of the same size from the same firm is a second bill: it is listed.
      { write: [BILL('18a0f00dcafe0102', '2021-03-16')] },
    ] } });
    expect(flow.steps.map((s) => s.code)).toEqual([0, 0, 0]);
    const rows = flow.rows.filter((x) => x.fields['Gmail Message ID']);
    const first = rows.find((x) => x.fields['Gmail Message ID'] === '18a0f00dcafe0101');
    const second = rows.find((x) => x.fields['Gmail Message ID'] === '18a0f00dcafe0102');
    expect(first.fields.Status).toBe('Duplicate');
    expect(first.fields.Notes).toMatch(new RegExp(`Same bill as row ${NEWROW}.*paid off the list on 2021-03-11`));
    expect(byId(flow, NEWROW).fields.Notes).toMatch(/This payment's bill came later by email 18a0f00dcafe0101/);
    expect(second.fields.Status).toBe('Unpaid');
    expect(flow.owed).toEqual([second.id]);
    expect(flow.settles).toEqual([]);
    // Long after the payment, or for another amount, it is not that payment's bill: listed as owed.
    const { far } = paid({ far: { db: DB(), steps: [
      { argv: NEW(['--apply']) },
      { write: [BILL('18a0f00dcafe0201', '2021-04-20'), BILL('18a0f00dcafe0202', '2021-03-12', { amount: 70.1 })] },
    ] } });
    expect(far.rows.filter((x) => x.fields['Gmail Message ID']).map((x) => x.fields.Status)).toEqual(['Unpaid', 'Unpaid']);
  });

  it('settles a named row: Paid, the bank date and the bank line appended, and the absence check clears', () => {
    const { link } = paid({ link: { db: DB({ rows: [OTHER, OPEN_LAB()] }), argv: LINK([...WHY, '--apply']) } });
    expect(link.code).toBe(0);
    expect(link.writes).toHaveLength(1);
    expect(link.writes[0].method).toBe('PATCH');
    expect(link.writes[0].records[0]).toMatchObject({ id: ROW_OPEN, fields: { Status: 'Paid',
      'Paid Date': '2021-03-13', 'Matched Transaction': [TXLAB] } });
    expect(link.writes[0].records[0].fields.Notes).toMatch(/The bank line names someone else: the labour invoice/);
    expect(link.unlistedBefore).toContain(TXLAB);
    expect(link.unlistedAfter).not.toContain(TXLAB);
  });

  it('a named row passes settle\'s own checks: the payee on the bank line or a reason, no better row, no rejection', () => {
    const GAS = tx(TXGAS, 'Kestrel Gas Ltd 5 Mill Lane', -87.5, '2021-03-13');
    const gasA = row(ROW_OPEN, { Status: 'Unpaid', Payee: 'Kestrel Gas Ltd', Amount: 87.5, 'Email Date': '2021-03-08',
      Description: 'LGSR, 22 Oak Road' });
    const gasB = row(ROW_RIVAL, { Status: 'Unpaid', Payee: 'Kestrel Gas Ltd', Amount: 87.5, 'Email Date': '2021-03-09',
      Description: 'LGSR, 5 Mill Lane' });
    const gasArgv = ['--transaction', TXGAS, '--amount', '87.50', '--date', '2021-03-13', '--task', TASK, '--row', ROW_OPEN];
    const rival = row(ROW_RIVAL, { Status: 'Unpaid', Payee: 'R Example Builds', Amount: 412.75, 'Email Date': '2021-03-12' });
    const r = paid({
      noReason: { db: DB({ rows: [OTHER, OPEN_LAB()] }), argv: LINK() },
      shortReason: { db: DB({ rows: [OTHER, OPEN_LAB()] }), argv: LINK(['--bank-line-names-other', 'yes']) },
      rejected: { db: DB({ rows: [OTHER, OPEN_LAB({ 'AI Match Rejected': true })] }), argv: LINK(WHY) },
      better: { db: DB({ tx: [GAS], rows: [OTHER, gasA, gasB] }), argv: gasArgv },
      named: { db: DB({ rows: [OTHER, OPEN_LAB(), rival] }), argv: LINK(WHY) },
    });
    expect(refused(r.noReason)).toMatch(/does not name row recROWOPEN0000001's payee.*--bank-line-names-other/);
    expect(refused(r.shortReason)).toMatch(/--bank-line-names-other/);
    expect(refused(r.rejected)).toMatch(/Kevin rejected the suggested payment/);
    expect(refused(r.better)).toMatch(/fits this payment better/);
    expect(refused(r.named)).toMatch(new RegExp(`the bank line names the payee of row ${ROW_RIVAL}`));
    for (const c of Object.values(r)) {
      expect(c.code).toBe(2);
      expect(c.writes).toEqual([]);
    }
  });

  it('refuses a named row of another amount, another bank line, a status it cannot settle, or no row at all', () => {
    const r = paid({
      amount: { db: DB({ rows: [OTHER, OPEN_LAB({ Amount: 402.75 })] }), argv: LINK(WHY) },
      otherTx: { db: DB({ rows: [OTHER, OPEN_LAB({ Status: 'Paid', 'Matched Transaction': [TXOTHER] })] }), argv: LINK(WHY) },
      historic: { db: DB({ rows: [OTHER, OPEN_LAB({ Status: 'Historic' })] }), argv: LINK(WHY) },
      missing: { db: DB({ rows: [OTHER] }), argv: LINK(WHY) },
    });
    expect(refused(r.amount)).toMatch(new RegExp(`row ${ROW_OPEN} is for £402\\.75, not £412\\.75`));
    expect(refused(r.otherTx)).toMatch(/already claimed by row|already names transaction/);
    expect(refused(r.historic)).toMatch(/is Historic.*--restore/);
    expect(refused(r.missing)).toMatch(/is not a row on the Payment Run/);
    for (const c of Object.values(r)) {
      expect(c.code).toBe(2);
      expect(c.writes).toEqual([]);
    }
  });

  it('a named row already holding another bank line is refused even when no other row claims this one', () => {
    const { linked } = paid({ linked: { db: DB({ rows: [OTHER, OPEN_LAB({ 'Matched Transaction': ['recTXGONE00000001'] })] }),
      argv: LINK(WHY) } });
    expect(linked.code).toBe(2);
    expect(refused(linked)).toMatch(/already names transaction recTXGONE00000001/);
  });

  it('a re-run on a row that already records the payment writes nothing', () => {
    const { rerun } = paid({ rerun: { db: DB({ rows: [OTHER, OPEN_LAB({ Status: 'Paid', 'Paid Date': '2021-03-13',
      'Matched Transaction': [TXLAB] })] }), argv: LINK(['--apply']) } });
    expect(rerun.code).toBe(0);
    expect(rerun.out.unchanged).toBe(true);
    expect(rerun.writes).toEqual([]);
  });

  it('a create that times out is sent ONCE, and the re-run finds its row by its marker and writes nothing', () => {
    const { timeout } = paid({ timeout: { db: DB(), postTimeout: true, steps: [
      { argv: NEW(['--apply']) }, { argv: NEW(['--apply']) },
    ] } });
    expect(timeout.steps[0].code).toBe(1);
    expect(timeout.steps[0].err).toMatch(/was not sent again: run the same command again/);
    expect(timeout.writes.filter((w) => w.method === 'POST')).toHaveLength(1);
    expect(timeout.steps[1].code).toBe(0);
    expect(timeout.steps[1].out.unchanged).toBe(true);
    expect(timeout.rows.filter((x) => (x.fields['Matched Transaction'] || []).includes(TX))).toHaveLength(1);
  });

  it('refuses an unknown task or bank line, a bad id, and a write that does not land', () => {
    const r = paid({
      noTask: { db: DB({ tasks: [] }), argv: NEW() },
      noTx: { db: DB({ tx: [] }), argv: NEW() },
      badId: { db: DB(), argv: ['--transaction', 'tx-123', '--amount', '63.40', '--date', '2021-03-11', '--task', TASK,
        '--payee', 'Oakline Ltd'] },
      notLanded: { db: DB(), ignoreWrites: true, argv: NEW(['--apply']) },
    });
    expect(refused(r.noTask)).toMatch(/is not a task/);
    expect(refused(r.noTx)).toMatch(/is not a bank line/);
    expect(refused(r.badId)).toMatch(/is not a record id/);
    for (const k of ['noTask', 'noTx', 'badId']) {
      expect(r[k].code).toBe(2);
      expect(r[k].writes).toEqual([]);
    }
    expect(r.notLanded.code).toBe(1);
    expect(r.notLanded.err).toMatch(/did not land/);
  });

  it("the script's own selftest still passes", () => {
    const out = execFileSync('python3', [PR_PY, 'selftest'], { encoding: 'utf8' });
    expect(out).toMatch(/all checks pass/);
  });
});

// ── cost-record.py on a card approved "with minor edits" ───────────────────
const COST = 'recCOST0000000001';
const CAT = 'recCAT00000000001';
const SUB = 'recSUB00000000001';
const APPROVED_AT = '2021-03-20T10:41:07.000Z';
const MARKS = { sentFor: ['recAGENT00000001'], approvedAt: APPROVED_AT };
const CLOSE = '\n\n**Carrying this out will involve:** Changing the cost record to the new price. No money moves.';
const LINE = `RECORD CHANGE: ${COST} Expected Cost = 16.36`;
const CARD = `Fixed cost check: the video tool drops to its cheaper plan.\n\n${LINE}${CLOSE}`;
const NEWLINE = 'RECORD NEW COST: Oakline van hire | 31.27 | Monthly | due 28 | first 2021-04-28 | no end date';
const NEWCARD = `A van hire contract started this month.\n\n${NEWLINE}${CLOSE}`;
const NOTE = 'Thanks, I have spoken to the supplier about this.';
const OLD_BLOCK = (text) => '[19 Mar 2021 18:30 — agent] EDITS APPLIED: an earlier round\n\n' +
  `--- TEXT KEVIN APPROVED, BEFORE THE EDIT ---\n${text}`;

const CR_HARNESS = String.raw`
import importlib.util, json, os, io, contextlib, sys, argparse, tempfile
CR, DISPATCH, cases = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
os.environ["COST_RECORD_LEDGER"] = os.path.join(tempfile.mkdtemp(), "ledger.jsonl")
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m
m = load("cr", CR)
rc, tr = m.rc, m.tr
ad = None
TASK, COST = "recTASK0000000001", "recCOST0000000001"
KNOWN = {m.T_BUSINESSES: ["recBIZ00000000001"], m.T_CATEGORIES: ["recCAT00000000001"],
         m.T_SUBCATEGORIES: ["recSUB00000000001"]}
def revised_by_dispatch(original, revised, feedback):
    """The Notes block the REAL agent-dispatch.py cmd_revise writes, and the output it stores."""
    global ad
    if ad is None:
        ad = load("ad", DISPATCH)
    patched = []
    ad.get_task = lambda tid: {}
    ad.task_view = lambda rec: {"id": TASK, "outcome": "Approved with minor edits", "feedback": feedback,
                                "agentOutput": original, "taskType": "Analysis", "notes": "", "name": "Fixed cost check"}
    ad.patch_task = lambda tid, fields: patched.append(fields)
    path = os.path.join(tempfile.mkdtemp(), "revised.md")
    open(path, "w").write(revised)
    with contextlib.redirect_stdout(io.StringIO()):
        ad.cmd_revise(argparse.Namespace(task=TASK, output_file=path))
    return patched[0][ad.AF["agentOutput"]], patched[0][ad.AF["notes"]]
def run(c):
    t = dict(c["task"])
    if c.get("revise"):
        r = c["revise"]
        t["output"], notes = revised_by_dispatch(r["original"], r["revised"], t.get("feedback", ""))
        t["notes"] = notes + (c.get("laterNote") or "")
    f = {tr.TK["name"]: "Fixed cost check", tr.TK["agentOutput"]: t.get("output", "")}
    for key, field in (("outcome", tr.TK["approvalOutcome"]), ("sentFor", "fld30Yw8SWYVp049g"),
                       ("approvedAt", "fldr4Mvf2RzKvhZhi"), ("feedback", tr.TK["approvalFeedback"]),
                       ("notes", tr.TK["notes"])):
        if t.get(key):
            f[field] = t[key]
    task_row = {"id": TASK, "createdTime": "2021-03-15T09:02:11.000Z", "fields": f}
    costs = [{"id": COST, "fields": {m.COST_NAME: "Video tool", m.COST_EXPECTED: 23.32}}]
    def fetch_all(table, params=None):
        formula = (params or {}).get("filterByFormula") or ""
        if table == m.T_COSTS:
            return [r for r in costs if not formula or r["id"] in formula]
        if table == rc.T_TASKS:
            return [task_row] if TASK in formula else []
        return [{"id": x, "fields": {}} for x in KNOWN.get(table, []) if x in formula]
    def api(*a, **k):
        raise AssertionError("a dry run made a write")
    rc.fetch_all, rc.api = fetch_all, api
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = m.main(c["argv"])
    return {"code": code, "out": json.loads(buf.getvalue())}
print(json.dumps({k: run(c) for k, c in cases.items()}))
`;

function costRecord(cases) {
  const out = execFileSync('python3', ['-c', CR_HARNESS, CR_PY, DISPATCH, JSON.stringify(cases)], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}
const EXPECTED = (value) => ['expected', COST, value, '--task', TASK, '--why', 'The plan drops to the cheaper tier', '--dry-run'];
const NEWCOST = ['new', '--name', 'Oakline van hire', '--expected', '31.27', '--frequency', 'Monthly', '--due-day', '28',
  '--first-payment', '2021-04-28', '--no-end-date', '--business', 'recBIZ00000000001', '--category', CAT,
  '--sub-category', SUB, '--task', TASK, '--why', 'The van hire contract started this month', '--dry-run'];
const MINOR = { outcome: 'Approved with minor edits', ...MARKS };

describe('cost-record.py accepts "Approved with minor edits", for the lines Kevin read', () => {
  it('as-is still works, and minor edits with no note is the card as it stands', () => {
    const r = costRecord({
      asIs: { task: { outcome: 'Approved as-is', ...MARKS, output: CARD }, argv: EXPECTED('16.36') },
      noNote: { task: { ...MINOR, output: CARD }, argv: EXPECTED('16.36') },
    });
    expect(r.asIs.code).toBe(0);
    expect(r.asIs.out.dryRun).toBe(true);
    expect(r.noNote.code).toBe(0);
    expect(r.noNote.out.dryRun).toBe(true);
  });

  it('the same approval marks as as-is: a typed "Approved with minor edits" with no gate stamp is refused', () => {
    const { typed } = costRecord({ typed: { task: { outcome: 'Approved with minor edits', approvedAt: APPROVED_AT,
      output: CARD }, argv: EXPECTED('16.36') } });
    expect(typed.code).toBe(2);
    expect(typed.out.refused).toMatch(/never went through the approval gate/);
  });

  it('a note never applied is refused, and so is one applied only BEFORE this approval', () => {
    const r = costRecord({
      unapplied: { task: { ...MINOR, feedback: NOTE, output: CARD }, argv: EXPECTED('16.36') },
      earlier: { task: { ...MINOR, feedback: NOTE, output: CARD, notes: OLD_BLOCK(CARD) }, argv: EXPECTED('16.36') },
    });
    for (const c of Object.values(r)) {
      expect(c.code).toBe(2);
      expect(c.out.refused).toMatch(/has not been applied to the card: run agent-dispatch\.py revise/);
    }
  });

  it('once revise has applied an edit that leaves the line alone, the line is written (a change and a new cost)', () => {
    const r = costRecord({
      change: { task: { ...MINOR, feedback: NOTE }, revise: { original: CARD, revised: `${NOTE}\n\n${CARD}` },
        argv: EXPECTED('16.36') },
      newCost: { task: { ...MINOR, feedback: NOTE }, revise: { original: NEWCARD, revised: `${NOTE}\n\n${NEWCARD}` },
        argv: NEWCOST },
    });
    expect(r.change.code).toBe(0);
    expect(r.change.out.dryRun).toBe(true);
    expect(r.newCost.code).toBe(0);
    expect(r.newCost.out.dryRun).toBe(true);
  });

  it('"make it 15.99": 16.36 is never written, even when revise only put the note on top of the card', () => {
    const r = costRecord({
      prepended: { task: { ...MINOR, feedback: 'Make it 15.99' },
        revise: { original: CARD, revised: `Kevin asked: make it 15.99.\n\n${CARD}` }, argv: EXPECTED('16.36') },
      changedOld: { task: { ...MINOR, feedback: 'Make it 15.99' },
        revise: { original: CARD, revised: CARD.replace('16.36', '15.99') }, argv: EXPECTED('16.36') },
      newCostPrepended: { task: { ...MINOR, feedback: 'Make it £29.99 a month' },
        revise: { original: NEWCARD, revised: `Kevin asked for 29.99.\n\n${NEWCARD}` }, argv: NEWCOST },
    });
    for (const c of Object.values(r)) expect(c.code).toBe(2);
    expect(r.prepended.out.refused).toMatch(/which names £15\.99, and this writes £16\.36/);
    expect(r.newCostPrepended.out.refused).toMatch(/which names £29\.99, and this writes £31\.27/);
  });

  it('"make it 15.99": once revise has changed the line, the value his note gives is written', () => {
    const { changedNew } = costRecord({ changedNew: { task: { ...MINOR, feedback: 'Make it 15.99' },
      revise: { original: CARD, revised: CARD.replace('16.36', '15.99') }, argv: EXPECTED('15.99') } });
    expect(changedNew.code).toBe(0);
    expect(changedNew.out.dryRun).toBe(true);
  });

  it('a line changed to a value his note does not name, or added after he read the card, is refused', () => {
    const added = `Fixed cost check, no change proposed.${CLOSE}`;
    const r = costRecord({
      otherValue: { task: { ...MINOR, feedback: 'Make it 15.99' }, revise: { original: CARD, revised: CARD.replace('16.36', '14.50') },
        argv: EXPECTED('14.50') },
      addedLine: { task: { ...MINOR, feedback: 'Add the change' }, revise: { original: added, revised: CARD },
        argv: EXPECTED('16.36') },
    });
    for (const c of Object.values(r)) {
      expect(c.code).toBe(2);
      expect(c.out.refused).toMatch(/that he read and his edit left alone/);
    }
  });

  it('a line written into a LATER note is not part of the text he approved', () => {
    const added = `Fixed cost check, no change proposed.${CLOSE}`;
    const { later } = costRecord({ later: { task: { ...MINOR, feedback: 'Add the change' },
      revise: { original: added, revised: CARD },
      laterNote: `\n\n[22 Mar 2021 11:05 — agent] Proposed again:\n${LINE}`, argv: EXPECTED('16.36') } });
    expect(later.code).toBe(2);
    expect(later.out.refused).toMatch(/has no line/);
  });

  it('cost-record reads the archive exactly as agent-dispatch.py writes it', () => {
    const dispatch = readFileSync(DISPATCH, 'utf8');
    const door = readFileSync(CR_PY, 'utf8');
    expect(dispatch).toContain('EDITS_APPLIED_MARK = "EDITS APPLIED:"');
    expect(door).toContain('EDITS_APPLIED_MARK = "EDITS APPLIED:"');
    expect(dispatch).toContain('"--- TEXT KEVIN APPROVED, BEFORE THE EDIT ---\\n"');
    expect(door).toContain('EDITS_ARCHIVE_HEAD = "--- TEXT KEVIN APPROVED, BEFORE THE EDIT ---"');
    const revise = dispatch.slice(dispatch.indexOf('def cmd_revise'), dispatch.indexOf('def cmd_retype'));
    expect(revise).toContain('stamp = datetime.now(LONDON).strftime("%d %b %Y %H:%M")');
  });

  it('NOT decided here: a weekly cost written "due Friday" is still not a line this door reads', () => {
    const weekly = 'RECORD NEW COST: Oakline weekly pay | 118 | Weekly | due Friday | first 2021-03-05 | no end date';
    const card = `Weekly pay as a fixed cost.\n\n${weekly}${CLOSE}`;
    const argv = ['new', '--name', 'Oakline weekly pay', '--expected', '118', '--frequency', 'Weekly', '--due-day', '5',
      '--first-payment', '2021-03-05', '--no-end-date', '--business', 'recBIZ00000000001', '--category', CAT,
      '--sub-category', SUB, '--task', TASK, '--why', 'Weekly pay as a fixed cost line', '--dry-run'];
    const { weeklyLine } = costRecord({ weeklyLine: { task: { outcome: 'Approved as-is', ...MARKS, output: card }, argv } });
    expect(weeklyLine.code).toBe(2);
    expect(weeklyLine.out.refused).toMatch(/has no line/);
  });
});
