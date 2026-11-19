// AN AGENT RENT LATE EMAIL IS CHECKED AGAINST THE BANK AT THE SEND, UNIT BY UNIT (Kevin, "Do it now", 16 Nov 2026,
// after PR 959). A letting agent's card may cover several of its units for one due date, one RENT AGENT KEY line
// each. The send reads every unit again and never sends an email that chases rent the agent has already paid. These
// drive the REAL send script with Airtable and the worker stubbed: every network door raises, nothing can be sent,
// and every id, name, address and amount is invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(root, 'scripts');

const HARNESS = `
import importlib.util, json, sys, os, io, contextlib, tempfile, argparse, socket, urllib.request, urllib.parse
from datetime import date, timedelta
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
socket.socket.connect = boom
socket.create_connection = boom
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def load_mod(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(SCRIPTS)}, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
SE = load_mod("se_rent", "send-" + "email.py")
ST = load_mod("st_rent", "send-" + "text.py")
AD = SE.dispatch_module()
import agent_email_format as aef
aef.TRIAL_ENDED["rec7aHLK1Q8fMLRXH"] = "2026-10-05T11:44:00Z"
aef.TRIAL_AGENTS.pop("rec7aHLK1Q8fMLRXH", None)
SCRATCH = tempfile.mkdtemp()
SE.SENT_LEDGER = os.path.join(SCRATCH, "sent-email.jsonl"); SE.STATE_DIR = SCRATCH
ST.STATE_DIR = SCRATCH; ST.LEDGER = os.path.join(SCRATCH, "sent-text.jsonl"); ST.SWITCH = os.path.join(SCRATCH, "on")
open(ST.SWITCH, "w").close()
ST.send_email_module = lambda: SE
SE.load_approved.__globals__["approval_evidence_problem"] = lambda f, created: ""
ST.approval_evidence_problem = lambda f, created: ""
AF = SE.AF
TENANCY = "recTenancyLandAaa"
UNITS = {"recUnitOneAaaaaaa": ("Unit 1 – 7 Example Road", 641.20, 3), "recUnitTwoAaaaaaa": ("Unit 2 – 7 Example Road", 618.30, 17),
         "recUnitThreeAaaaa": ("Unit 3 – 7 Example Road", 687.00, 24)}
MISSING, NORENT = set(), set()
OWED = (date.today() - timedelta(days=6)).isoformat()
NAME = "AGENT RENT LATE: Fixture Lettings, 3 units, rent due (first email)"
OUTPUT = ("TO: accounts@fixture-lettings.test\\nFROM: info@agilelets.co.uk\\nSUBJECT: Your rent at 1 Example Road\\n---\\nHello,\\n\\n"
          "The rent for Units 1, 2 and 3 has not reached us.\\n\\nKind regards\\nRoy Lavin\\nAgile Lets\\n\\n"
          "**Carrying this out will involve:** one email to the letting agent.")
def fields(name=NAME):
    return {AF["name"]: name, AF["agentOutput"]: OUTPUT, AF["taskType"]: {"name": "Correspondence"},
            AF["status"]: {"name": "Today"}, AF["approvalOutcome"]: {"name": "Approved as-is"},
            AF["approvedAt"]: "2026-11-10T13:00:00.000Z", AF["notes"]: "\\n".join("RENT AGENT KEY: %s:%s" % (t, OWED) for t in UNITS),
            AF["description"]: "Reference for the rent check, please leave it in:\\n" + "\\n".join("RENT AGENT KEY: %s:%s" % (t, OWED) for t in UNITS),
            AF["sentForApprovalBy"]: ["rec7aHLK1Q8fMLRXH"], AF["teamMember"]: ["rec7aHLK1Q8fMLRXH"],
            AF["tenants"] if "tenants" in AF else ST.AF["tenants"]: ["recTenantRentAaaa"], aef.TASK_TENANCIES: [TENANCY]}
BANK, READS, SENT = [], [], []
# A tenancy's comments, for the letting agent's nil statements (finding 1354). None = a read that fails.
COMMENTS = {}
STATE = {"bankFails": False, "rent": 500.0, "tenancyFound": True}
def rows_for(url):
    q = urllib.parse.unquote(url)
    if AD.TENANCIES_TABLE in q and AD.RENT_FIELD in q:
        tid = q.split("RECORD_ID()='")[1].split("'")[0]
        READS.append("rent:" + tid)
        if tid in MISSING or tid not in UNITS:
            return {"records": []}
        unit, rent, due = UNITS[tid]
        return {"records": [{"id": tid, "fields": {AD.RENT_FIELD: 0 if tid in NORENT else rent,
                                                   AD.RENT_DUE_DAY_FIELD: int(OWED[8:10]), AD.UNIT_REF_FIELD: [unit]}}]}
    if AD.TRANSACTIONS_TABLE in q:
        READS.append("bank")
        if STATE["bankFails"]:
            return {"error": {"type": "SERVER_ERROR"}}
        return {"records": [{"id": b["id"], "fields": {AD.TX_FIELDS["date"]: b["date"], AD.TX_FIELDS["amount"]: b["amount"],
                                                       AD.TX_FIELDS["name"]: "FIXTURE LETTINGS", AD.TX_TENANCY_FIELD: [b["tenancy"]]}}
                            for b in BANK]}
    return None
def api(method, url, payload=None):
    r = rows_for(url)
    if r is not None: return r
    if method == "GET" and "/comments" in url:
        tid = url.split("/comments")[0].rsplit("/", 1)[1]
        if COMMENTS.get(tid, []) is None: return {"error": {"type": "SERVER_ERROR"}}
        return {"comments": COMMENTS.get(tid, [])}
    if url.endswith("/comments") or method == "PATCH": return {}
    raise RuntimeError("no fixture for " + method + " " + url[:80])
SE.api = api
SE.get_task = lambda tid: {"id": tid, "createdTime": "2026-11-09T12:00:00.000Z", "fields": CARD}
SE.worker_call = lambda url, payload=None: SENT.append(payload.get("to")) or {"id": "msg-1", "threadId": "t-1"}
CARD = fields()
def st_airtable(method, p, payload=None):
    if p.startswith(ST.TENANTS + "/"):
        return {"id": "recTenantRentAaaa", "fields": {ST.TENANT_PHONE: "+44 7700 900123"}}
    if method == "PATCH" or p.endswith("/comments"): return {}
    return {"id": "recRentCardAaaaa1", "createdTime": "2026-11-09T12:00:00.000Z", "fields": CARD}
ST.airtable = st_airtable
def run(which, dry=False):
    READS.clear(); SENT.clear()
    for f in (SE.SENT_LEDGER, ST.LEDGER):
        if os.path.exists(f): os.remove(f)
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            if which == "email":
                SE.cmd_send(argparse.Namespace(task="recRentCardAaaaa1", dry_run=dry, rule=None))
            else:
                ST.cmd_send(argparse.Namespace(task="recRentCardAaaaa1", dry_run=dry))
        out = buf.getvalue().strip()
        return {"refused": None, "sent": list(SENT), "reads": list(READS), "out": json.loads(out[out.index("{"):]) if "{" in out else out}
    except SystemExit as e:
        return {"refused": str(e.code), "sent": list(SENT), "reads": list(READS), "out": buf.getvalue()}
def line(tid, amount, days_ago=1, lid=None):
    return {"id": lid or ("recPay" + tid[3:14]), "date": (date.today() - timedelta(days=days_ago)).isoformat(), "amount": amount, "tenancy": tid}
`;


function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('an AGENT RENT LATE email is refused at the send when rent it chases has landed', () => {
  it('a batched card for 3 units where 1 has paid: refused, naming the paid unit and the 2 still unpaid; nothing sent', () => {
    const r = py(`
BANK[:] = [line("recUnitTwoAaaaaaa", 618.30)]
res = run("email")
print(json.dumps({"refused": res["refused"], "sent": res["sent"], "reads": res["reads"]}))`);
    expect(r.refused).toMatch(/1 unit\(s\) on this card have been paid since the card was made: Unit 2 – 7 Example Road \(recUnitTwoAaaaaaa\): .*£618\.30/);
    expect(r.refused).toMatch(/Still unpaid: Unit 1 – 7 Example Road \(recUnitOneAaaaaaa\); Unit 3 – 7 Example Road \(recUnitThreeAaaaa\)/);
    expect(r.refused).toMatch(/Rewrite the email for the unpaid units only and submit the card again with one --rent-received/);
    expect(r.sent).toEqual([]);
    expect(r.reads).toEqual(['rent:recUnitOneAaaaaaa', 'rent:recUnitTwoAaaaaaa', 'rent:recUnitThreeAaaaa', 'bank']);   // each key once
  });

  it('rewritten for the unpaid units and declared with RENT RECEIVED, it goes; a declaration for an unpaid unit changes nothing', () => {
    const r = py(`
BANK[:] = [line("recUnitTwoAaaaaaa", 618.30)]
CARD = dict(fields(), **{AF["notes"]: fields()[AF["notes"]] + "\\n[16 Nov 2026 20:00 — agent-dispatch] RENT RECEIVED (round 2): recUnitTwoAaaaaaa: recPayUnitTwoAaaaaaa"})
declared = run("email")
CARD = dict(fields(), **{AF["notes"]: fields()[AF["notes"]] + "\\n[16 Nov 2026 20:00 — agent-dispatch] RENT RECEIVED (round 2): recUnitOneAaaaaaa: wrong"})
wrong = run("email")
print(json.dumps({"declared": [declared["refused"], len(declared["sent"])], "wrong": [wrong["refused"] or "", len(wrong["sent"])]}))`);
    expect(r.declared).toEqual([null, 1]);
    expect(r.wrong[0]).toMatch(/Still unpaid: Unit 1 – 7 Example Road/);
    expect(r.wrong[1]).toBe(0);
  });

  it('every unit paid: refused, close the task; nothing paid: it goes', () => {
    const r = py(`
BANK[:] = [line("recUnitOneAaaaaaa", 641.20), line("recUnitTwoAaaaaaa", 618.30), line("recUnitThreeAaaaa", 687.00)]
allPaid = run("email")
BANK[:] = []
none = run("email")
print(json.dumps({"all": [allPaid["refused"], allPaid["sent"]], "none": [none["refused"], len(none["sent"])]}))`);
    expect(r.all[0]).toMatch(/every unit on this card has been paid since the card was made: Unit 1 .*Unit 2 .*Unit 3 /);
    expect(r.all[0]).toMatch(/agent-dispatch\.py complete recRentCardAaaaa1 --evidence/);
    expect(r.all[1]).toEqual([]);
    expect(r.none).toEqual([null, 1]);
  });

  it('a payout net of a letting fee, or in two shares, counts as paid; money that came back does not; another unit\'s payment never counts', () => {
    const r = py(`
out = {}
BANK[:] = [line("recUnitOneAaaaaaa", 281.20)]                              # the letting fee came out at source
out["fee"] = run("email")["refused"] or ""
BANK[:] = [line("recUnitOneAaaaaaa", 300.00, lid="recShareOneAaaaaa"), line("recUnitOneAaaaaaa", 341.20, lid="recShareTwoAaaaaa")]
out["shares"] = run("email")["refused"] or ""
BANK[:] = [line("recUnitOneAaaaaaa", 641.20, 3, "recInAaaaaaaaaaaa"), line("recUnitOneAaaaaaa", -641.20, 1, "recBackAaaaaaaaaa")]
bounced = run("email")
out["bounced"] = [bounced["refused"], len(bounced["sent"])]
BANK[:] = [line("recOtherTenancyAa", 641.20)]
other = run("email")
out["other"] = [other["refused"], len(other["sent"])]
print(json.dumps(out))`);
    expect(r.fee).toMatch(/have been paid since the card was made: Unit 1 – 7 Example Road .*£281\.20/);
    expect(r.shares).toMatch(/Unit 1 – 7 Example Road \(recUnitOneAaaaaaa\): .*£300\.00 \(recShareOneAaaaaa\); .*£341\.20 \(recShareTwoAaaaaa\)/);
    expect(r.bounced).toEqual([null, 1]);
    expect(r.other).toEqual([null, 1]);
  });

  it('a card the check cannot place is refused loudly: no key line, a unit not found, a unit with no rent, a bank that cannot be read', () => {
    const r = py(`
out = {}
CARD = dict(fields(), **{AF["notes"]: "no key", AF["description"]: "no key here either"})
out["noKey"] = run("email")
CARD = fields()
MISSING.add("recUnitThreeAaaaa")
out["noTenancy"] = run("email")
MISSING.clear(); NORENT.add("recUnitOneAaaaaaa")
out["noRent"] = run("email")
NORENT.clear(); STATE["bankFails"] = True
out["bank"] = run("email")
print(json.dumps({k: [v["refused"], v["sent"]] for k, v in out.items()}))`);
    expect(r.noKey[0]).toMatch(/an AGENT RENT LATE card with no RENT AGENT KEY line.*NOT CHECKED\. Nothing was sent/);
    expect(r.noTenancy[0]).toMatch(/the tenancy recUnitThreeAaaaa in a RENT AGENT KEY line is not in the Tenancies table.*Nothing was sent/);
    expect(r.noRent[0]).toMatch(/tenancy recUnitOneAaaaaaa has no rent on its record.*NOT CHECKED\. Nothing was sent/);
    expect(r.bank[0]).toMatch(/the bank could not be read again for this card's units .*NOT CHECKED\. Nothing was sent/);
    for (const k of ['noKey', 'noTenancy', 'noRent', 'bank']) expect([k, r[k][1]]).toEqual([k, []]);
  });

  it('a second-step key (:2) is read as the same unit and cycle', () => {
    const r = py(`
CARD = dict(fields(), **{AF["notes"]: "RENT AGENT KEY: recUnitOneAaaaaaa:%s:2" % OWED, AF["description"]: ""})
BANK[:] = [line("recUnitOneAaaaaaa", 641.20)]
res = run("email")
print(json.dumps({"refused": res["refused"], "reads": res["reads"]}))`);
    expect(r.refused).toMatch(/every unit on this card has been paid since the card was made: Unit 1 – 7 Example Road/);
    expect(r.reads).toEqual(['rent:recUnitOneAaaaaaa', 'bank']);
  });

  // Finding 1354: a nil statement moves the rent check past a month, so the card raised before it (keyed on that
  // month) must not go out on its own: the send reads the tenancy's nil statements too.
  it('a unit the letting agent\'s statement showed as nil counts as covered; a comments read that fails refuses', () => {
    const r = py(`
NIL = "18 Nov 2026 10:00: NIL STATEMENT %s: the letting agent's statement shows no payout for the rent due that day, so the rent check does not count it as owed. Evidence: x" % OWED
out = {}
COMMENTS.update({t: [{"text": NIL, "createdTime": "2026-11-18T10:00:00.000Z"}] for t in UNITS})
out["allNil"] = run("email")
COMMENTS.clear(); COMMENTS["recUnitOneAaaaaaa"] = [{"text": NIL, "createdTime": "2026-11-18T10:00:00.000Z"}]
BANK[:] = [line("recUnitTwoAaaaaaa", 618.30)]
out["oneNilOnePaid"] = run("email")
BANK[:] = []
COMMENTS.clear(); COMMENTS["recUnitOneAaaaaaa"] = [{"text": "Kevin: per the agent, NIL STATEMENT %s: the letting agent's statement shows no payout for the rent due that day" % OWED}]
out["quoted"] = run("email")
COMMENTS.clear(); COMMENTS["recUnitTwoAaaaaaa"] = None
out["broken"] = run("email")
print(json.dumps({k: [v["refused"], v["sent"]] for k, v in out.items()}))`);
    expect(r.allNil[0]).toMatch(/every unit on this card has been paid since the card was made: .*the letting agent's statement showed no payout for the rent due/);
    expect(r.allNil[1]).toEqual([]);
    expect(r.oneNilOnePaid[0]).toMatch(/2 unit\(s\) on this card have been paid since the card was made/);
    expect(r.oneNilOnePaid[0]).toMatch(/Still unpaid: Unit 3 – 7 Example Road/);
    // A comment that only quotes the marker is not a nil statement: the email goes.
    expect([r.quoted[0], r.quoted[1].length]).toEqual([null, 1]);
    expect(r.broken[0]).toMatch(/NOT CHECKED\. Nothing was sent/);
    expect(r.broken[1]).toEqual([]);
  });
});
