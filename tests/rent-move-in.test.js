// A signed agreement that never became a tenancy (Kevin, 9 Oct 2026): scripts/rent_signed_check.py in the rent check,
// and the two doors that record one, scripts/tenancy-record.py `onboard` and `rent-change`.
//
// Found that day: two signed agreements (a move-in on 8 Oct, a new rent from 10 Sep) were on no tenancy record, so
// the rent check could not even see them. A first build was reviewed and not merged; each numbered review finding
// below is a case that fails without its fix. Every name, id, date and amount here is invented: this repo is public.
//
// Back-tested (9 Oct 2026) by breaking each fix once and watching its case fail:
//   (4)  rent-change without the on-record / same tenant-start-rent re-check -> "a re-run refuses" and "already on record"
//        rent-change forcing In Payment -> "keeps the old Payment Status"; no try round the end -> "ending the old fails"
//   (5)  change_problem not called for onboard / rent-change -> "only on a card approved as-is"; the AGREEMENT lines
//        not compared -> "the task and the agreement disagree"
//   (6)  a closed task still counted -> "a task the agent closed"; no renewal rule -> "a renewal at the same rent"
//   (7)  the old any-line house regex -> "never from any other line"; no doc-name fallback -> "falls back to the
//        document name"; a house that must start with a number -> "a named building"
//   (8)  a substring house match -> "8 Example Park is not 18 Example Park"
//   (9)  the name from Adobe's last signer -> "a guarantor signing last"; no two-people check -> "A and B"
//   (10) a Billing Year written whatever the choices -> "Billing Year left blank and said"
//   (11) a cache entry with no house trusted -> "re-reads an agreement whose cached house is missing"
//   (13) no ledger reuse -> "a tenant its own failed run created is reused"
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const py = (script) => JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());

// ─── the move-in check ───
const SIGNED = `
import importlib.util, json, os, sys, tempfile
from datetime import date, datetime, timezone
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import rent_signed_check as rsc
spec = importlib.util.spec_from_file_location("rc", os.path.join(${JSON.stringify(SCRIPTS)}, "rent-check.py"))
rc = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc)
TY = rc.TY
def mail(i, doc, who, day):
    ms = int(datetime(*day, 12, tzinfo=timezone.utc).timestamp() * 1000)
    return {"id": i, "internalDate": str(ms), "attachments": [{"filename": doc + " - signed.pdf", "attachmentId": "a" + i}],
            "headers": {"from": "Adobe Sign <adobesign@adobesign.com>",
                        "subject": doc + " between Agile Lets, Agile Lets and " + who + " is Signed and Filed!"}}
TEXT = {
  "aa0000000000000a1": "Assured shorthold tenancy agreement\\nPat Example — 7 Example Close, Testtown, AB1 2CD — one room, £897.52 a month from\\n7 October 2026\\n'the Term' means six months commencing on 7 October 2026.\\nthe rent of £897.52 (or",
  "aa0000000000000a2": "Assured shorthold tenancy agreement\\nSam Sample — 3 Sample Street, Testtown — one room, £897.52 a month\\ncommencing on 10 September 2026. the rent of £897.52",
  "aa0000000000000a3": "Assured shorthold tenancy agreement\\nLee Recorded — 5 Sample Street, Testtown — one room, £897.52 a month\\ncommencing on 28 September 2026 the rent of £897.52",
  "aa0000000000000a4": "a scan with no words we can read",
}
MAILS = [mail("a0000000000000a1", "AST_Pat_Example_7_Example_Close", "Pat example", (2026, 10, 8)),
         mail("a0000000000000a2", "AST_Sam_Sample_3_Sample_Street", "Sam Sample", (2026, 9, 11)),
         mail("a0000000000000a3", "AST_Lee_Recorded_5_Sample_Street", "Lee recorded", (2026, 9, 29)),
         mail("a0000000000000a4", "AST_Kim_Blank_1_Nowhere_Lane", "Kim Blank", (2026, 9, 30)),
         mail("a0000000000000a5", "AST_Old_Pack_2_Old_Road", "Old Pack", (2026, 8, 1)),
         mail("a0000000000000a6", "Proof_of_Residency_Pat_Example", "Someone", (2026, 10, 8))]
def tenancy(i, tenant, start, rent, unit="Unit 1 – 9 Elsewhere Road", end=None):
    return {"id": i, "fields": {TY["start"]: start, TY["rent"]: rent, TY["tenants"]: [tenant], TY["unitRef"]: [unit], TY["end"]: end}}
NAMES = {"recSAM": "Sam Sample", "recLEE": "Lee Recorded"}
class World:
    def __init__(self, raised=None):
        self.created, self.raised = [], dict(raised or {})
    def fetch_all(self, table, params=None):
        if table == rc.T_TENANTS:
            return [{"id": k, "fields": {rc.lane_b_rules.TENANT_NAME_FIELD: v}} for k, v in NAMES.items()]
        if table == rc.T_TASKS:
            return [{"id": t, "fields": {rc.TK["notes"]: rsc.KEY_MARK + m, rc.TK["status"]: s}} for m, (t, s) in self.raised.items()]
        raise AssertionError(table)
    def api(self, method, path, payload=None, params=None):
        assert method == "POST" and path == rc.T_TASKS, (method, path)
        f = payload["records"][0]["fields"]; self.created.append(f)
        return {"records": [{"id": "recNEWTASK%d" % len(self.created)}]}
FETCHED = []
def run(tenancies, writes=True, raised=None, mails=None, start=rsc.START, cache=None, text=None):
    w = World(raised); rc.fetch_all, rc.api = w.fetch_all, w.api
    cache = cache or os.path.join(tempfile.mkdtemp(), "cache.json")
    texts = text or TEXT
    def fetch(m, a, acc):
        FETCHED.append(m); return ("%PDF-" + a).encode()
    out = rsc.run(rc, datetime(2026, 10, 9, 11, tzinfo=timezone.utc), writes, True, {"tenancies": tenancies},
                  day=date(2026, 10, 9), list_mail=lambda q, acc: ((MAILS if mails is None else mails), False),
                  fetch=fetch, text_of=lambda raw: (texts.get(raw.decode()[5:], ""), None),
                  cache_path=cache, start=start)
    return out, w.created
`;

describe('move-in check: a signed agreement with no tenancy record raises one task', () => {
  it('back-test: the move-in and the new rent are flagged, the recorded one is not, nothing before the start date', () => {
    const r = py(SIGNED + `
old = [tenancy("recSAMOLD", "recSAM", "2021-03-19", 524.6, unit="Unit 3 – 3 Sample Street"), tenancy("recLEE1", "recLEE", "2026-09-28", 897.52)]
out, made = run(old)
print(json.dumps({"out": out, "made": made, "line": rsc.line(out), "brief": rsc.brief(out)}))
`);
    expect(r.out.failed).toBe('');
    expect(r.out.checked).toBe(4);
    expect(r.out.recorded).toEqual(['Lee Recorded, 5 Sample Street (recLEE1)']);
    expect(r.out.unrecorded.join(' | ')).toMatch(/Pat Example, 7 Example Close/);
    expect(r.out.unrecorded.join(' | ')).toMatch(/Sam Sample, 3 Sample Street/);
    expect(r.out.unrecorded.join(' | ')).toMatch(/Kim Blank, 1 Nowhere Lane/);
    expect(r.made).toHaveLength(3);
    const pat = r.made.find(f => /7 Example Close/.test(f.fldgFjGBw6bTKJFCD));
    expect(pat.fldgFjGBw6bTKJFCD).toBe('TENANCY RECORD: signed agreement with no tenancy: 7 Example Close');
    expect(pat.flduCtmQGpOA4eWaj).toEqual(['rec7aHLK1Q8fMLRXH']);
    expect(pat.fldRGhBQViKZKtkQ6).toMatch(/AGREEMENT NAME: Pat Example\nAGREEMENT RENT: 897.52\nAGREEMENT START: 2026-10-07\nAGREEMENT HOUSE: 7 Example Close/);
    expect(pat.fldRGhBQViKZKtkQ6).toMatch(/RECORD CHANGE: a0000000000000a1 Onboard = unit <rental unit id> \(<its Rental Unit name, e\.g\. Unit 2 – 7 Example Close>\), due <day>/);
    expect(pat.fldRGhBQViKZKtkQ6).toMatch(/add `, replace <live tenancy id> \(<its Unit Reference>\)`/);
    expect(pat.fldR7apBzSp3oxFxz).toBe('TENANCY RECORD KEY: a0000000000000a1');
    const blank = r.made.find(f => /Kim Blank/.test(f.fldRGhBQViKZKtkQ6));
    expect(blank.fldRGhBQViKZKtkQ6).toMatch(/Could not read the rent or the start date/);
    expect(r.brief).toBe('Signed agreements with no tenancy record: 3. The Cash Flow Voids agent has the task.');
  });

  it('once recorded there is nothing to raise; an open task is never raised twice but still said', () => {
    const r = py(SIGNED + `
done = [tenancy("recSAMNEW", "recSAM", "2026-09-10", 897.52), tenancy("recLEE1", "recLEE", "2026-09-28", 897.52)]
a, made_a = run(done, raised={"a0000000000000a1": ("recT1", "Today"), "a0000000000000a4": ("recT2", "Approval")})
print(json.dumps({"a": a, "made": made_a}))
`);
    expect(r.made).toEqual([]);
    expect(r.a.unrecorded.join(' | ')).toMatch(/Pat Example, 7 Example Close \(task recT1\)/);
    expect(r.a.recorded.join(' | ')).toMatch(/Sam Sample, 3 Sample Street \(recSAMNEW\)/);
  });

  it('(6) a task the agent closed takes its agreement off Home and the count, and the row still lists it', () => {
    const r = py(SIGNED + `
done = [tenancy("recSAMNEW", "recSAM", "2026-09-10", 897.52), tenancy("recLEE1", "recLEE", "2026-09-28", 897.52)]
out, made = run(done, raised={"a0000000000000a1": ("recT1", "Completed"), "a0000000000000a4": ("recT2", "Cancelled")})
print(json.dumps({"out": out, "made": made, "brief": rsc.brief(out), "line": rsc.line(out)}))
`);
    expect(r.made).toEqual([]);
    expect(r.out.unrecorded).toEqual([]);
    expect(r.brief).toBe('');
    expect(r.out.closed).toEqual(['Pat Example, 7 Example Close (closed by its task recT1, Completed)',
                                  'Kim Blank, 1 Nowhere Lane (closed by its task recT2, Cancelled)']);
    expect(r.line).toMatch(/^Signed agreements: 2 of 4 since 10 Sep 2026 on record\. not recorded, closed by its task: /);
  });

  it('(6) a renewal at the SAME rent for a tenant with a live tenancy at that house is recorded; another house or an ended tenancy is not', () => {
    const r = py(SIGNED + `
lee = tenancy("recLEE1", "recLEE", "2026-09-28", 897.52)
same = [tenancy("recSAMLIVE", "recSAM", "2024-02-01", 897.52, unit="Unit 3 – 3 Sample Street"), lee]
other = [tenancy("recSAMLIVE", "recSAM", "2024-02-01", 897.52, unit="Unit 3 – 13 Sample Street"), lee]
ended = [tenancy("recSAMLIVE", "recSAM", "2024-02-01", 897.52, unit="Unit 3 – 3 Sample Street", end="2026-09-30"), lee]
rise = [tenancy("recSAMLIVE", "recSAM", "2024-02-01", 524.6, unit="Unit 3 – 3 Sample Street"), lee]
res = {}
for k, ts in (("same", same), ("other", other), ("ended", ended), ("rise", rise)):
    out, _ = run(ts, writes=False)
    res[k] = [x for x in out["recorded"] + out["unrecorded"] if x.startswith("Sam Sample")]
print(json.dumps(res))
`);
    expect(r.same).toEqual(['Sam Sample, 3 Sample Street (recSAMLIVE, a renewal at the same rent)']);
    expect(r.other).toEqual(['Sam Sample, 3 Sample Street']);
    expect(r.ended).toEqual(['Sam Sample, 3 Sample Street']);
    expect(r.rise).toEqual(['Sam Sample, 3 Sample Street']);
  });

  it('two copies of one Signed and Filed (same document, same minute) are one agreement: one task, found by either copy', () => {
    const r = py(SIGNED + `
TEXT["aa0000000000000a7"] = TEXT["aa0000000000000a1"]
copy = mail("a0000000000000a7", "AST_Pat_Example_7_Example_Close", "Pat example", (2026, 10, 8))
copy["internalDate"] = str(int(copy["internalDate"]) + 20000)          # 20 seconds later, the same minute
old = [tenancy("recSAMOLD", "recSAM", "2021-03-19", 524.6), tenancy("recLEE1", "recLEE", "2026-09-28", 897.52)]
out, made = run(old, mails=MAILS + [copy])
second, made2 = run(old, mails=MAILS + [copy], raised={"a0000000000000a7": ("recT9", "Today")})
print(json.dumps({"out": out, "made": made, "second": second, "made2": made2}))
`);
    expect(r.out.checked).toBe(4);
    expect(r.made).toHaveLength(3);
    const pat = r.made.filter(f => /7 Example Close/.test(f.fldgFjGBw6bTKJFCD));
    expect(pat).toHaveLength(1);
    expect(pat[0].fldR7apBzSp3oxFxz).toBe('TENANCY RECORD KEY: a0000000000000a1');
    expect(pat[0].fldRGhBQViKZKtkQ6).toMatch(/Adobe emailed 2 copies of this agreement \(Gmail a0000000000000a1, a0000000000000a7\)/);
    expect(r.made2.filter(f => /7 Example Close/.test(f.fldgFjGBw6bTKJFCD))).toEqual([]);
    expect(r.second.unrecorded.join(' | ')).toMatch(/Pat Example, 7 Example Close \(task recT9\)/);
  });

  it('a dry run raises nothing; a blind mailbox read fails loudly', () => {
    const r = py(SIGNED + `
dry, made = run([], writes=False)
blind, _ = run([], mails=[])
print(json.dumps({"dry": dry, "made": made, "blind": blind}))
`);
    expect(r.made).toEqual([]);
    expect(r.dry.planned.length).toBe(4);
    expect(r.blind.failed).toMatch(/control failed/);
  });

  it('a name match needs two words: a shared surname alone is not the same person', () => {
    const r = py(SIGNED + `
print(json.dumps([rsc.same_person("Pat example", "Pat Example"), rsc.same_person("Ann lee jones", "Ann Lee Jones"),
                  rsc.same_person("Smith", "Sam Smith"), rsc.same_person("Jo Smith", "Sam Smith")]))
`);
    expect(r).toEqual([true, true, false, false]);
  });

  it('(11) re-reads an agreement whose cached house, rent or start is missing, or that an older parser read', () => {
    const r = py(SIGNED + `
cache = os.path.join(tempfile.mkdtemp(), "cache.json")
good = dict(rsc.parse_agreement(TEXT["aa0000000000000a2"], "AST_Sam_Sample_3_Sample_Street", MAILS[1]["headers"]["subject"]),
            mail="a0000000000000a2", doc="AST_Sam_Sample_3_Sample_Street", subject="x", signed="11 Sep 2026 13:00")
seed = {"a0000000000000a2": good,
        "a0000000000000a1": dict(good, mail="a0000000000000a1", house=None),
        "a0000000000000a3": dict(good, mail="a0000000000000a3", v=1),
        "a0000000000000a4": dict(good, mail="a0000000000000a4", rent=None)}
rsc.write_cache(cache, seed)
FETCHED.clear()
out, _ = run([], writes=False, cache=cache)
print(json.dumps(sorted(FETCHED)))
`);
    expect(r).toEqual(['a0000000000000a1', 'a0000000000000a3', 'a0000000000000a4']);
  });
});

describe('(7) the house and (9) the tenant come from the header line only', () => {
  it('reads the header, folds ligatures, skips a unit part, and takes a named building with no number', () => {
    const r = py(SIGNED + `
P = rsc.parse_agreement
print(json.dumps({
  "lig": P("Assured shorthold tenancy agreement\\nPat Example — 18 Oak\\ufb01eld Close, Testtown — one room, £897.52 a month\\ncommencing on 7 October 2026 the rent of £897.52"),
  "flat": P("Pat Example — Flat 2, 18 Example Road, Testtown — one room, £500.00 a month")["house"],
  "building": P("Pat Example — Example Building, Back Lane Crescent, Testtown — one room, £500.00 a month")["house"],
  "wrapped": P("Assured shorthold tenancy agreement\\nPat Example — 7 Example Close, Testtown, AB1 2CD — one room,\\n£500.00 a month from 7 October 2026")["house"],
}))
`);
    expect(r.lig).toMatchObject({ rent: 897.52, start: '2026-10-07', house: '18 Oakfield Close', name: 'Pat Example', several: false });
    expect(r.flat).toBe('18 Example Road');
    expect(r.building).toBe('Example Building');
    expect(r.wrapped).toBe('7 Example Close');
  });

  it('never reads a house from any other line, and falls back to the document name', () => {
    const r = py(SIGNED + `
P = rsc.parse_agreement
text = ("Assured Shorthold Tenancy - 2 parts\\nTHIS AGREEMENT is made on 7 October 2026\\ncommencing on 7 October 2026 the rent of £500.00\\n"
        "Schedule — 4 Other Street — £20.00 a week for parking")
doc = "AST_Pat_Example_7_Example_Close"
subj = doc + " between Agile Lets, Agile Lets and Pat example is Signed and Filed!"
a = P(text, doc, subj)
b = P(text, "AST_Joint_9_Shared_Road", "AST_Joint_9_Shared_Road between Agile Lets, Ann One and Bob Two is Signed and Filed!")
c = P(text, "AST_Pat_Example_Example_Building", subj)
print(json.dumps({"a": a, "b": b, "c": c["house"]}))
`);
    // The old any-line pattern read "2 parts" off the first line, and a schedule line would give "4 Other Street".
    expect(r.a.house).toBe('7 Example Close');
    expect(r.a.name).toBe('Pat example');
    expect(r.b).toMatchObject({ house: '9 Shared Road', name: '', several: true, signers: ['Ann One', 'Bob Two'] });
    expect(r.c).toBe('Example Building');
  });

  it('(9) the name is the header\'s, never a guarantor signing last; "A and B" is two people', () => {
    const r = py(SIGNED + `
P = rsc.parse_agreement
g = P("Pat Example — 7 Example Close, Testtown — one room, £500.00 a month", "AST_Pat_Example_7_Example_Close",
      "AST_Pat_Example_7_Example_Close between Agile Lets, Pat Example and Gary Guarantor is Signed and Filed!")
two = P("Ann One and Bob Two — 9 Shared Road, Testtown — one room, £500.00 a month", "AST_Ann_One_9_Shared_Road",
        "AST_Ann_One_9_Shared_Road between Agile Lets, Ann One and Bob Two is Signed and Filed!")
nohead = P("no header here", "AST_Pat_Example_7_Example_Close",
           "AST_Pat_Example_7_Example_Close between Kevin Brittain, Pat Example and Gary Guarantor is Signed and Filed!")
two_a = dict(two, mail="a0000000000000b1", doc="AST_Ann_One_9_Shared_Road", subject="s", signed="9 Oct 2026 10:00")
print(json.dumps({"g": [g["name"], g["several"]], "two": [two["name"], two["several"]], "nohead": [nohead["name"], nohead["several"]],
                  "task": rsc.task_text(two_a, date(2026, 10, 9))[1]}))
`);
    expect(r.g).toEqual(['Pat Example', false]);
    expect(r.two).toEqual(['Ann One and Bob Two', true]);
    expect(r.nohead).toEqual(['', true]);
    expect(r.task).toMatch(/This agreement names more than one person \(Ann One and Bob Two\): onboard refuses it/);
  });

  it('(8) a house matches whole words only: 8 Example Park is not 18 Example Park', () => {
    const r = py(SIGNED + `
print(json.dumps([rsc.same_house("8 Example Park", "Unit 1 – 18 Example Park"), rsc.same_house("18 Example Park", "Unit 1 – 18 Example Park"),
                  rsc.same_house("Example Building", "Unit 2 – Example Buildings"), rsc.same_house("Example Building", "Unit 2 – Example Building")]))
`);
    expect(r).toEqual([false, true, false, true]);
  });
});

// ─── the door: onboard and rent-change ───
const DOOR = `
import importlib.util, json, os, sys, io, contextlib, tempfile
from datetime import date
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
os.environ["TENANCY_RECORD_LEDGER"] = os.path.join(tempfile.mkdtemp(), "ledger.jsonl")
spec = importlib.util.spec_from_file_location("tr", os.path.join(${JSON.stringify(SCRIPTS)}, "tenancy-record.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
import rent_signed_check as rsc
rc = m.rc
rsc.CACHE = os.path.join(tempfile.mkdtemp(), "cache.json")
rc.today_london = lambda: date(2026, 10, 9)
CHOICES = ["2025", "2026"]
rc.field_choices = lambda table, field: list(CHOICES)
TK, TEN, TY_IN = m.TK, m.TEN, m.TY_IN
T_TEN, T_TENANTS, T_TASKS, T_TX = rc.T_TENANCIES, rc.T_TENANTS, rc.T_TASKS, rc.T_TX
W = {T_TEN: {}, T_TENANTS: {}, T_TASKS: {}, m.T_UNITS: {}, T_TX: {}}
log = {"posts": [], "patches": [], "comments": []}
FAIL = {}
def fetch_all(table, params=None):
    rows = [{"id": k, "createdTime": "2026-10-01T00:00:00.000Z", "fields": dict(v)} for k, v in W[table].items()]
    f = (params or {}).get("filterByFormula") or ""
    if f.startswith("RECORD_ID()="):
        rows = [r for r in rows if r["id"] in f]
    if table == T_TX and "IS_AFTER" in f:
        cut = f.split("'")[1]
        rows = [r for r in rows if r["fields"].get(m.TX_DATE, "") > cut]
    return rows
n = [0]
def api(method, path, payload=None, params=None):
    if path.endswith("/comments"):
        log["comments"].append((path.split("/")[1], payload["text"])); return {"id": "com"}
    table = path.split("/")[0]
    if FAIL.get((method, path)):
        FAIL[(method, path)] -= 1
        raise RuntimeError("Airtable %s %s 422: refused for the test" % (method, path))
    if method == "POST":
        assert "typecast" not in payload
        n[0] += 1; rid = "recMADE%010d" % n[0]
        W[table][rid] = dict(payload["records"][0]["fields"]); log["posts"].append((table, rid, payload["records"][0]["fields"]))
        return {"records": [{"id": rid}]}
    if method == "PATCH":
        rid = path.split("/")[1]
        assert "typecast" not in payload
        W[table][rid].update(payload["fields"]); log["patches"].append((table, rid, payload["fields"])); return {}
    raise AssertionError(method + path)
rc.fetch_all, rc.api = fetch_all, api
def run(argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = m.main(argv)
    return code, json.loads(buf.getvalue())
APPROVED = {"fldrHBSr6qoUfaKuZ": "Approved as-is", "fld30Yw8SWYVp049g": ["recAG"], "fldr4Mvf2RzKvhZhi": "2026-10-06T10:00:00.000Z"}
def agreement(mail, name, rent, start, house, several=False):
    a = {"mail": mail, "name": name, "rent": rent, "start": start, "house": house, "doc": "AST_x", "several": several,
         "signers": [name], "subject": "AST_x between Agile Lets and " + name + " is Signed and Filed!",
         "signed": "8 Oct 2026 14:09", "v": rsc.PARSE_VERSION}
    rsc.write_cache(rsc.CACHE, dict(rsc.read_cache(rsc.CACHE), **{mail: a}))
    return a
def record_task(tid, a, output=None, outcome="Approved as-is", desc=None):
    f = {TK["name"]: rsc.PREFIX + a["house"], TK["notes"]: rsc.KEY_MARK + a["mail"],
         TK["description"]: desc if desc is not None else rsc.task_text(a, date(2026, 10, 9))[1]}
    if output is not None:
        f.update(APPROVED); f[TK["approvalOutcome"]] = outcome; f[TK["agentOutput"]] = output
    W[T_TASKS][tid] = f
UNIT_LINKS = {TY_IN["metrics"]: ["recMETRICS"], TY_IN["fixedCost"]: ["recFIXED"], TY_IN["maintenance"]: ["recMAINT"], TY_IN["cashflow"]: ["recCASH"]}
W[m.T_UNITS]["recUNITFREE000001"] = {m.UNIT_NAME: "Unit 2 – 7 Example Close"}
W[m.T_UNITS]["recUNITTAKEN00001"] = {m.UNIT_NAME: "Unit 1 – 7 Example Close"}
W[m.T_UNITS]["recUNITELSEWHER0E"] = {m.UNIT_NAME: "Unit 1 – 17 Example Close"}
W[T_TEN]["recLIVEONUNIT0001"] = dict({TY_IN["unit"]: ["recUNITTAKEN00001"], m.UNIT_REF: ["Unit 1 – 7 Example Close"],
                                      TY_IN["customers"]: ["recOLDTENANT00001"], TY_IN["start"]: "2024-10-15", TY_IN["rent"]: 500}, **UNIT_LINKS)
W[T_TEN]["recPASTONFREE0001"] = dict({TY_IN["unit"]: ["recUNITFREE000001"], m.UNIT_REF: ["Unit 2 – 7 Example Close"], TY_IN["start"]: "2023-01-01",
                                      TY_IN["end"]: "2025-01-01", TY_IN["rent"]: 450, TY_IN["customers"]: ["recGONE0000000001"]}, **UNIT_LINKS)
W[T_TENANTS]["recOLDTENANT00001"] = {TEN["name"]: "Old Tenant", TEN["unit"]: ["recUNITTAKEN00001"]}
W[T_TENANTS]["recGONE0000000001"] = {TEN["name"]: "Gone Before"}
MAIL = "a1b2c3d4e5f60001"
ONB = ["--due-day", "24", "--type", "Universal Credit", "--email", "pat@example.com", "--why", "agreement signed, room 2 named on the pack task"]
def onboard_line(unit, replace=None, name=None, replace_name=None):
    name = name or W[m.T_UNITS][unit][m.UNIT_NAME]
    extra = (", replace %s (%s)" % (replace, replace_name or W[T_TEN][replace][m.UNIT_REF][0])) if replace else ""
    return "If you approve:\\nRECORD CHANGE: %s Onboard = unit %s (%s), due 24, Universal Credit, pat@example.com%s" % (MAIL, unit, name, extra)
def tenants_named(name):
    return [k for k, v in W[T_TENANTS].items() if v.get(TEN["name"]) == name]
out = {}
`;

describe('door: onboard a new tenant from the agreement the rent check read', () => {
  it('creates the tenant and a CFV tenancy at the agreement rent and start, with the unit links copied', () => {
    const r = py(DOOR + `
a = agreement(MAIL, "Pat Example", 897.52, "2026-10-07", "7 Example Close")
record_task("recRECORDTASK0001", a, onboard_line("recUNITFREE000001"))
out["res"] = run(["onboard", "--task", "recRECORDTASK0001", "--unit", "recUNITFREE000001"] + ONB)
out["tenant"] = W[T_TENANTS].get(out["res"][1].get("tenantId"))
out["tenancy"] = W[T_TEN].get(out["res"][1].get("tenancy"))
print(json.dumps(out))
`);
    expect(r.res[0]).toBe(0);
    expect(r.tenant).toMatchObject({ fldxBKW7QnujSDWqA: 'Pat Example', fldAXzP9SGIHiAhrv: 'Active', fldZbrk8Xw5Dcwxhi: 'Universal Credit',
                                     fldeLsZYqbKS77S2V: ['recUNITFREE000001'], fldWjCUbAOQmTKfFP: '24' });
    expect(r.tenancy).toMatchObject({ fld2rPXwwV8dXb1zF: '2026-10-07', fldDMyfZLFMeONPq8: 897.52, fldxU3dPUnbK0SCDq: 'CFV',
                                      fldhy2U0CQmM2oS4P: '24', fldlZKHKwmEUl7YPm: '2026-10-24', fld7cjLLEHKAx49OK: ['recUNITFREE000001'],
                                      fldtuYDCmzfO7EB8a: ['recMETRICS'], fldhnwX4fCmr0jU71: '2026' });
    expect(r.res[1].billingYear).toBeUndefined();
  });

  it('(5) only on a card approved as-is whose RECORD CHANGE line the arguments equal, and AGREEMENT lines that equal the agreement', () => {
    const r = py(DOOR + `
a = agreement(MAIL, "Pat Example", 897.52, "2026-10-07", "7 Example Close")
go = lambda: run(["onboard", "--task", "recRECORDTASK0001", "--unit", "recUNITFREE000001"] + ONB)
record_task("recRECORDTASK0001", a)                       # raised, never approved
out["unapproved"] = go()
record_task("recRECORDTASK0001", a, onboard_line("recUNITFREE000001"), outcome="Approved with minor edits")
out["edited"] = go()
record_task("recRECORDTASK0001", a, onboard_line("recUNITFREE000001").replace("due 24", "due 23"))
out["otherDay"] = go()
desc = rsc.task_text(a, date(2026, 10, 9))[1].replace("AGREEMENT RENT: 897.52", "AGREEMENT RENT: 800.00")
record_task("recRECORDTASK0001", a, onboard_line("recUNITFREE000001"), desc=desc)
out["lines"] = go()
W[T_TASKS]["recPLAINTASK00001"] = dict(APPROVED, **{TK["name"]: "Onboard Pat", TK["notes"]: rsc.KEY_MARK + MAIL,
                                                    TK["agentOutput"]: onboard_line("recUNITFREE000001")})
out["plain"] = run(["onboard", "--task", "recPLAINTASK00001", "--unit", "recUNITFREE000001"] + ONB)
rsc.write_cache(rsc.CACHE, {MAIL: dict(a, v=1)})
record_task("recRECORDTASK0001", a, onboard_line("recUNITFREE000001"))
out["older"] = go()
out["posts"] = log["posts"]
print(json.dumps(out))
`);
    expect(r.unapproved[1].refused).toMatch(/Kevin has not approved task recRECORDTASK0001/);
    expect(r.edited[1].refused).toMatch(/was Approved with minor edits, not Approved as-is/);
    expect(r.otherDay[1].refused).toMatch(/no line 'RECORD CHANGE: a1b2c3d4e5f60001 Onboard = unit recUNITFREE000001 \(Unit 2 – 7 Example Close\), due 24, Universal Credit, pat@example.com'/);
    expect(r.lines[1].refused).toMatch(/AGREEMENT RENT line reads '800.00' but the rent check read '897.52'/);
    expect(r.plain[1].refused).toMatch(/not a TENANCY RECORD task the rent check raised/);
    expect(r.older[1].refused).toMatch(/reading of agreement a1b2c3d4e5f60001 is from an older reader/);
    expect(r.posts).toEqual([]);
  });

  it('refuses: a unit at another house (whole words), a tenant on record, an occupied unit the line does not replace, two people, an agreement on record', () => {
    const r = py(DOOR + `
a = agreement(MAIL, "Pat Example", 897.52, "2026-10-07", "7 Example Close")
def go(unit, replace=None):
    record_task("recRECORDTASK0001", a, onboard_line(unit, replace))
    return run(["onboard", "--task", "recRECORDTASK0001", "--unit", unit] + ONB + (["--replace", replace] if replace else []))
out["elsewhere"] = go("recUNITELSEWHER0E")              # Unit 1 – 17 Example Close is not 7 Example Close
out["occupied"] = go("recUNITTAKEN00001")
agreement(MAIL, "Ann One and Bob Two", 897.52, "2026-10-07", "7 Example Close", several=True)
record_task("recRECORDTASK0001", rsc.read_cache(rsc.CACHE)[MAIL], onboard_line("recUNITFREE000001"))
out["two"] = run(["onboard", "--task", "recRECORDTASK0001", "--unit", "recUNITFREE000001"] + ONB)
agreement(MAIL, "Pat Example", 897.52, "2026-10-07", "7 Example Close")
W[T_TENANTS]["recPATALREADY0001"] = {TEN["name"]: "Pat Example", TEN["email"]: "other@example.com"}
out["known"] = go("recUNITFREE000001")
del W[T_TENANTS]["recPATALREADY0001"]
W[T_TENANTS]["recPATRECORDED001"] = {TEN["name"]: "Pat Example"}
W[T_TEN]["recPATTENANCY0001"] = {TY_IN["customers"]: ["recPATRECORDED001"], TY_IN["start"]: "2026-10-07", TY_IN["rent"]: 897.52}
out["onRecord"] = go("recUNITFREE000001")
out["posts"] = log["posts"]
print(json.dumps(out))
`);
    expect(r.elsewhere[1].refused).toMatch(/unit recUNITELSEWHER0E \(Unit 1 – 17 Example Close\) is not at 7 Example Close/);
    expect(r.occupied[1].refused).toMatch(/has live tenancy recLIVEONUNIT0001: the Onboard line Kevin approves names it/);
    expect(r.two[1].refused).toMatch(/names more than one person \(Ann One and Bob Two\)/);
    expect(r.known[1].refused).toMatch(/already on record/);
    expect(r.onRecord[1].refused).toMatch(/agreement a1b2c3d4e5f60001 is on record already: tenancy recPATTENANCY0001 starts with it/);
    expect(r.posts).toEqual([]);
  });

  it('the Onboard line carries each record\'s own name, and a line naming another room is refused', () => {
    const r = py(DOOR + `
a = agreement(MAIL, "Pat Example", 897.52, "2026-10-07", "7 Example Close")
record_task("recRECORDTASK0001", a, onboard_line("recUNITFREE000001", name="Unit 1 – 7 Example Close"))
out["otherRoom"] = run(["onboard", "--task", "recRECORDTASK0001", "--unit", "recUNITFREE000001"] + ONB)
record_task("recRECORDTASK0001", a, onboard_line("recUNITTAKEN00001", "recLIVEONUNIT0001", replace_name="Unit 2 – 7 Example Close"))
out["otherReplace"] = run(["onboard", "--task", "recRECORDTASK0001", "--unit", "recUNITTAKEN00001", "--replace", "recLIVEONUNIT0001"] + ONB)
W[T_TEN]["recLIVEONUNIT0001"][m.UNIT_REF] = ["Unit 3 – 7 Example Close"]
record_task("recRECORDTASK0001", a, onboard_line("recUNITTAKEN00001", "recLIVEONUNIT0001"))
out["refElsewhere"] = run(["onboard", "--task", "recRECORDTASK0001", "--unit", "recUNITTAKEN00001", "--replace", "recLIVEONUNIT0001"] + ONB)
out["posts"] = log["posts"]
print(json.dumps(out))
`);
    expect(r.otherRoom[0]).toBe(2);
    expect(r.otherRoom[1].refused).toMatch(/The line, exactly: RECORD CHANGE: a1b2c3d4e5f60001 Onboard = unit recUNITFREE000001 \(Unit 2 – 7 Example Close\), due 24/);
    expect(r.otherReplace[1].refused).toMatch(/replace recLIVEONUNIT0001 \(Unit 1 – 7 Example Close\)'/);
    expect(r.refElsewhere[1].refused).toMatch(/tenancy recLIVEONUNIT0001's Unit Reference is 'Unit 3 – 7 Example Close', not this unit 'Unit 1 – 7 Example Close'/);
    expect(r.posts).toEqual([]);
  });

  it('an occupied unit: only when the approved Onboard line says replace; the old tenancy stays live, off the unit', () => {
    const r = py(DOOR + `
a = agreement(MAIL, "Pat Example", 897.52, "2026-10-07", "7 Example Close")
record_task("recRECORDTASK0001", a, onboard_line("recUNITTAKEN00001", "recLIVEONUNIT0001"))
out["res"] = run(["onboard", "--task", "recRECORDTASK0001", "--unit", "recUNITTAKEN00001", "--replace", "recLIVEONUNIT0001"] + ONB)
out["old"] = W[T_TEN]["recLIVEONUNIT0001"]; out["oldTenant"] = W[T_TENANTS]["recOLDTENANT00001"]
print(json.dumps(out))
`);
    expect(r.res[0]).toBe(0);
    expect(r.old.fld7cjLLEHKAx49OK).toEqual([]);
    expect(r.old.fldwHhhKAq4f1nY9e).toBeUndefined();
    expect(r.oldTenant.fldeLsZYqbKS77S2V).toEqual([]);
  });

  it('(10) a start year that is not a Billing Year choice is left blank and said, never created', () => {
    const r = py(DOOR + `
CHOICES[:] = ["2025"]
a = agreement(MAIL, "Pat Example", 897.52, "2026-10-07", "7 Example Close")
record_task("recRECORDTASK0001", a, onboard_line("recUNITFREE000001"))
out["res"] = run(["onboard", "--task", "recRECORDTASK0001", "--unit", "recUNITFREE000001"] + ONB)
out["tenancy"] = W[T_TEN].get(out["res"][1].get("tenancy"))
print(json.dumps(out))
`);
    expect(r.res[0]).toBe(0);
    expect(r.tenancy.fldhnwX4fCmr0jU71).toBeUndefined();
    expect(r.res[1].billingYear).toBe('Billing Year left blank: 2026 is not one of its choices (2025); set it once the choice exists');
  });

  it('(13) a tenant its own failed run created is reused on the retry, never refused as already on record', () => {
    const r = py(DOOR + `
a = agreement(MAIL, "Pat Example", 897.52, "2026-10-07", "7 Example Close")
record_task("recRECORDTASK0001", a, onboard_line("recUNITFREE000001"))
args = ["onboard", "--task", "recRECORDTASK0001", "--unit", "recUNITFREE000001"] + ONB
FAIL[("POST", T_TEN)] = 1
out["first"] = run(args)
out["afterFirst"] = tenants_named("Pat Example")
out["retry"] = run(args)
out["afterRetry"] = tenants_named("Pat Example")
out["tenancy"] = W[T_TEN].get(out["retry"][1].get("tenancy"))
out["again"] = run(args)
print(json.dumps(out))
`);
    expect(r.first[0]).toBe(1);
    expect(r.afterFirst).toHaveLength(1);
    expect(r.retry[0]).toBe(0);
    expect(r.retry[1].reuseTenant).toBe(r.afterFirst[0]);
    expect(r.afterRetry).toEqual(r.afterFirst);
    expect(r.tenancy.fld1i5bDoHL3B6rUf).toEqual(r.afterFirst);
    expect(r.again[1].refused).toMatch(/was onboarded already/);
  });
});

describe('door: a rent change is a new tenancy from the agreement start', () => {
  const OLD = `
W[T_TENANTS]["recSAM00000000001"] = {TEN["name"]: "Sam Sample"}
def old(rent=524.6, start="2021-03-19", unit="Unit 3 – 3 Sample Street", status="CFV Actioned"):
    W[T_TEN]["recSAMOLD00000001"] = dict({TY_IN["customers"]: ["recSAM00000000001"], TY_IN["start"]: start, TY_IN["rent"]: rent,
        TY_IN["dueDay"]: "9", TY_IN["frequency"]: "Monthly", TY_IN["payStatus"]: status, m.UNIT_REF: [unit],
        TY_IN["unit"]: ["recUNITSAM0000001"]}, **UNIT_LINKS)
old()
RISE = "a1b2c3d4e5f60002"
a = agreement(RISE, "Sam Sample", 897.52, "2026-09-10", "3 Sample Street")
LINE = "RECORD CHANGE: recSAMOLD00000001 Rent change = " + RISE
record_task("recRECORDTASK0002", a, LINE)
ARGS = ["rent-change", "recSAMOLD00000001", "--task", "recRECORDTASK0002", "--why", "new agreement signed at the new rent"]
`;
  it('ends the old the day before, keeps its Payment Status, moves later payments and open tasks; a re-run refuses', () => {
    const r = py(DOOR + OLD + `
W[T_TX]["recTXBEFORE000001"] = {m.TX_TENANCY: ["recSAMOLD00000001"], m.TX_DATE: "2026-09-09"}
W[T_TX]["recTXAFTER0000001"] = {m.TX_TENANCY: ["recSAMOLD00000001"], m.TX_DATE: "2026-10-09"}
W[T_TASKS]["recOPENTASK000001"] = {TK["tenancies"]: ["recSAMOLD00000001"], TK["status"]: "Today"}
out["res"] = run(ARGS)
new = out["res"][1].get("tenancy")
out["new"] = W[T_TEN].get(new); out["old"] = W[T_TEN]["recSAMOLD00000001"]
out["txBefore"] = W[T_TX]["recTXBEFORE000001"]; out["txAfter"] = W[T_TX]["recTXAFTER0000001"]
out["task"] = W[T_TASKS]["recOPENTASK000001"]; out["newId"] = new
out["again"] = run(ARGS)
out["posts"] = len(log["posts"])
print(json.dumps(out))
`);
    expect(r.res[0]).toBe(0);
    expect(r.new).toMatchObject({ fld2rPXwwV8dXb1zF: '2026-09-10', fldDMyfZLFMeONPq8: 897.52, fldxU3dPUnbK0SCDq: 'CFV Actioned',
                                  fldhy2U0CQmM2oS4P: '9', fld1i5bDoHL3B6rUf: ['recSAM00000000001'], fldtuYDCmzfO7EB8a: ['recMETRICS'] });
    expect(r.old.fldwHhhKAq4f1nY9e).toBe('2026-09-09');
    expect(r.old.fldxU3dPUnbK0SCDq).toBe(null);
    expect(r.txBefore.fldPmAMmxwqs4SdPa).toEqual(['recSAMOLD00000001']);
    expect(r.txAfter.fldPmAMmxwqs4SdPa).toEqual([r.newId]);
    expect(r.task.fldmne4RYJU22ICub).toEqual([r.newId]);
    expect(r.again[0]).toBe(2);
    expect(r.again[1].refused).toMatch(new RegExp(`tenancy ${r.newId} already records this agreement`));
    expect(r.posts).toBe(1);
  });

  it('(4) ending the old failing after the create is said loudly (exit 1) and never creates again', () => {
    const r = py(DOOR + OLD + `
FAIL[("PATCH", T_TEN + "/recSAMOLD00000001")] = 1
out["first"] = run(ARGS)
out["again"] = run(ARGS)
out["posts"] = len(log["posts"])
out["oldEnd"] = W[T_TEN]["recSAMOLD00000001"].get(TY_IN["end"])
print(json.dumps(out))
`);
    expect(r.first[0]).toBe(1);
    expect(r.first[1].failed).toMatch(/new tenancy recMADE\d+ was created, but ending tenancy recSAMOLD00000001 on 2026-09-09 failed/);
    expect(r.again[0]).toBe(2);
    expect(r.again[1].refused).toMatch(/already records this agreement .* tenancy recSAMOLD00000001 still has no end date/);
    expect(r.posts).toBe(1);
    expect(r.oldEnd).toBeNull();
  });

  it('(4) re-checks the agreement is still unrecorded before creating anything', () => {
    const r = py(DOOR + OLD + `
W[T_TENANTS]["recSAMTWIN0000001"] = {TEN["name"]: "Sam Sample"}
W[T_TEN]["recSAMBYHAND00001"] = {TY_IN["customers"]: ["recSAMTWIN0000001"], TY_IN["start"]: "2026-09-12", TY_IN["rent"]: 897.52}
out["res"] = run(ARGS)
out["posts"] = log["posts"]
print(json.dumps(out))
`);
    expect(r.res[1].refused).toMatch(/is on record already: tenancy recSAMBYHAND00001 starts with it/);
    expect(r.posts).toEqual([]);
  });

  it('(5) refuses without its approved line; refuses another tenant, another house, the same rent, an earlier start, an unknown status', () => {
    const r = py(DOOR + OLD + `
record_task("recRECORDTASK0002", a, "RECORD CHANGE: recSOMEOTHER00001 Rent change = " + RISE)
out["line"] = run(ARGS)
record_task("recRECORDTASK0002", a, LINE)
W[T_TENANTS]["recSAM00000000001"] = {TEN["name"]: "Jo Other"}
out["person"] = run(ARGS)
W[T_TENANTS]["recSAM00000000001"] = {TEN["name"]: "Sam Sample"}
old(unit="Unit 3 – 13 Sample Street"); out["house"] = run(ARGS)
old(rent=897.52); out["same"] = run(ARGS)
old(start="2026-09-20"); out["early"] = run(ARGS)
old(status=None); out["status"] = run(ARGS)
out["posts"] = log["posts"]
print(json.dumps(out))
`);
    expect(r.line[1].refused).toMatch(/no line 'RECORD CHANGE: recSAMOLD00000001 Rent change = a1b2c3d4e5f60002'/);
    expect(r.person[1].refused).toMatch(/is not Sam Sample/);
    expect(r.house[1].refused).toMatch(/\(Unit 3 – 13 Sample Street\) is not at 3 Sample Street/);
    expect(r.same[1].refused).toMatch(/on record already: tenancy recSAMOLD00000001 carries it as a renewal|there is no rent change/);
    expect(r.early[1].refused).toMatch(/not after tenancy/);
    expect(r.status[1].refused).toMatch(/Payment Status is 'blank', not one of In Payment, CFV, CFV Actioned/);
    expect(r.posts).toEqual([]);
  });
});
