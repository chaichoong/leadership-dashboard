// A TEXT GOES BY WHAT THE CARD IS, NOT BY WHAT IT IS CALLED (findings 20261118-agent-dispatch-1344 and
// 20261118-agent-dispatch-1355, both high, both blocking a task). text_card gated texting on the task NAME
// carrying a rent-lane prefix or the rent check's key note, so on 18 Nov 2026 two texts Kevin had approved
// as-is could not be sent at all: a `RENT ARREARS:` card from Accounts Receivable (the lane was renamed) and
// a plain Correspondence chase whose second nudge was agreed as a text. send-text.py refused both with "not
// a rent lane's tenant card", the words stayed in Agent Output and nothing was texted. A lane keyed on the
// task name is only as good as every door that writes the name (.claude/rules/agent-task-pipeline.md).
// The gate now reads the card's own approved output. Nothing else is loosened: this file drives the REAL
// send-text.py with Airtable and the worker stubbed (every network door raises, so no test can send
// anything, and every id, name and number is invented) and pins the guards that must still refuse — no
// approval evidence, no TO number, and a RENT ARREARS chase whose rent has landed since the card.
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
SE = load_mod("se_text", "send-" + "email.py")
ST = load_mod("st_text", "send-" + "text.py")
AD = SE.dispatch_module()
import agent_email_format as aef
import approval_evidence as AE
aef.TRIAL_ENDED["rec7aHLK1Q8fMLRXH"] = "2026-10-05T11:44:00Z"
aef.TRIAL_AGENTS.pop("rec7aHLK1Q8fMLRXH", None)
SCRATCH = tempfile.mkdtemp()
SE.SENT_LEDGER = os.path.join(SCRATCH, "sent-email.jsonl"); SE.STATE_DIR = SCRATCH
ST.STATE_DIR = SCRATCH; ST.LEDGER = os.path.join(SCRATCH, "sent-text.jsonl"); ST.SWITCH = os.path.join(SCRATCH, "on")
open(ST.SWITCH, "w").close()
ST.send_email_module = lambda: SE
# The approval evidence is the REAL check (scripts/approval_evidence.py), so "no approval evidence refuses"
# is the live rule, not a stub. Every card below carries the marks of a real approval unless it says not to.
ST.approval_evidence_problem = AE.approval_evidence_problem
SE.load_approved.__globals__["approval_evidence_problem"] = lambda f, created: ""
AF = SE.AF
CFV = "rec7aHLK1Q8fMLRXH"            # Accounts Receivable (the rent lane's own agent)
OTHER = "recJ8J8idWE8d97tH"          # Customer Service: the agent that holds the plain chase card
TENANCY = "recTenancyTextAaa"
TENANT = "recTenantTextAaaa"
OWED = (date.today() - timedelta(days=6)).isoformat()
ARREARS_NAME = "RENT ARREARS: Unit 2 - 6 Example Place, rent due 31 Oct unpaid after three chases"
CHASE_NAME = "CHASE 2: tenant to sign the letter of authority, by text and email - Unit 1, 13 Example Place"
def output(number="07700 900123", text="Hello, your letter of authority is still waiting for your signature. Roy, Agile Lets", email=True):
    lines = []
    if number: lines.append("TEXT TO: " + number)
    if text: lines.append("TEXT: " + text)
    if email:
        lines += ["TO: tenant@example.com", "FROM: " + aef.PROPERTY_SENDER,
                  "SUBJECT: Your letter of authority", "---", "Hello,", "", "Please sign it.", "",
                  "Kind regards", "Roy Lavin", "Agile Lets"]
    return "\\n".join(lines)
def fields(name=CHASE_NAME, holder=OTHER, out=None, notes="", tenants=True, tenancy=False, approval=True):
    f = {AF["name"]: name, AF["agentOutput"]: output() if out is None else out,
         AF["taskType"]: {"name": "Correspondence"}, AF["status"]: {"name": "Today"},
         AF["approvalOutcome"]: {"name": "Approved as-is"}, AF["approvedAt"]: "2026-11-18T13:00:00.000Z",
         AF["notes"]: notes, AF["teamMember"]: [holder],
         AF["sentForApprovalBy"]: [holder] if approval else []}
    if tenants: f[ST.AF["tenants"]] = [TENANT]
    if tenancy: f[aef.TASK_TENANCIES] = [TENANCY]
    return f
def arrears_fields(**kw):
    kw.setdefault("notes", "RENT CHECK KEY: %s:%s:1" % (TENANCY, OWED))
    # A real RENT ARREARS card names the TENANCY and no tenant: the number is corroborated through it.
    return fields(ARREARS_NAME, CFV, tenants=kw.pop("tenants", False), tenancy=kw.pop("tenancy", True), **kw)
BANK, READS, SENT = [], [], []
STATE = {"rent": 500.0}
def rows_for(url):
    q = urllib.parse.unquote(url)
    if AD.TENANCIES_TABLE in q and AD.RENT_FIELD in q:
        READS.append("rent")
        return {"records": [{"id": TENANCY, "fields": {AD.RENT_FIELD: STATE["rent"], AD.RENT_DUE_DAY_FIELD: int(OWED[8:10])}}]}
    if AD.TRANSACTIONS_TABLE in q:
        READS.append("bank")
        return {"records": [{"id": b["id"], "fields": {AD.TX_FIELDS["date"]: b["date"], AD.TX_FIELDS["amount"]: b["amount"],
                                                       AD.TX_FIELDS["name"]: "BANK CREDIT", AD.TX_TENANCY_FIELD: [TENANCY]}}
                            for b in BANK]}
    return None
def api(method, url, payload=None):
    r = rows_for(url)
    if r is not None: return r
    if url.endswith("/comments") or method == "PATCH": return {}
    raise RuntimeError("no fixture for " + method + " " + url[:80])
SE.api = api
SE.get_task = lambda tid: {"id": tid, "createdTime": "2026-11-17T12:00:00.000Z", "fields": CARD}
SE.worker_call = lambda url, payload=None: SENT.append(dict(payload or {})) or {"id": "msg-1", "threadId": "t-1"}
CARD = fields()
def st_airtable(method, p, payload=None):
    if p.endswith("/comments") or method == "PATCH": return {}
    if p.startswith(ST.TENANTS + "/"):
        READS.append("tenant")
        return {"id": TENANT, "fields": {ST.TENANT_PHONE: "+44 7700 900123"}}
    if p.startswith(aef.TENANCIES_TABLE + "/"):
        READS.append("tenancy-tenants")
        return {"id": TENANCY, "fields": {ST.TENANCY_TENANTS: [TENANT]}}
    return {"id": "recTextCardAaaaa1", "createdTime": "2026-11-17T12:00:00.000Z", "fields": CARD}
ST.airtable = st_airtable
def run(dry=False):
    READS.clear(); SENT.clear()
    if os.path.exists(ST.LEDGER): os.remove(ST.LEDGER)
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            ST.cmd_send(argparse.Namespace(task="recTextCardAaaaa1", dry_run=dry))
        out = buf.getvalue().strip()
        return {"refused": None, "sent": list(SENT), "reads": list(READS),
                "out": json.loads(out[out.index("{"):]) if "{" in out else out}
    except SystemExit as e:
        return {"refused": str(e.code), "sent": list(SENT), "reads": list(READS), "out": buf.getvalue()}
`;

function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('an approved text is sent by what the card is, not by what the card is called', () => {
  it('an approved RENT ARREARS card from the rent lane texts, and its rent is read again first', () => {
    const r = py(`
CARD = arrears_fields()
sent = run()
dry = run(dry=True)
print(json.dumps({"sent": [sent["refused"], len(sent["sent"]), sent["reads"]],
                  "gate": aef.text_card(ARREARS_NAME, "", output(), [CFV]),
                  "rentCheck": dry["out"].get("rentCheck")}))`);
    expect(r.sent[0]).toBe(null);                       // the refusal of finding 1355 is gone
    expect(r.sent[1]).toBe(1);
    expect(r.sent[2]).toEqual(['tenancy-tenants', 'tenant', 'rent', 'bank']);
    expect(r.gate).toBe(true);
    expect(r.rentCheck).toMatch(/^CHECKED: the rent for the owed cycle has not arrived/);
  });

  it('an approved non-rent Correspondence chase texts, and says the rent check is NOT APPLICABLE', () => {
    const r = py(`
CARD = fields()
sent = run()
dry = run(dry=True)
print(json.dumps({"sent": [sent["refused"], len(sent["sent"]), sent["reads"]],
                  "gate": aef.text_card(CHASE_NAME, "", output(), [OTHER]),
                  "nameGateAlone": aef.text_card(CHASE_NAME, "", "", [OTHER]),
                  "rentCheck": dry["out"].get("rentCheck"), "rentLanded": dry["out"].get("rentLanded")}))`);
    expect(r.sent[0]).toBe(null);                       // the refusal of finding 1344 is gone
    expect(r.sent[1]).toBe(1);
    expect(r.sent[2]).toEqual(['tenant']);              // no rent cycle, so no bank read
    expect(r.gate).toBe(true);
    expect(r.nameGateAlone).toBe(false);                // the card's own words are what carry it
    expect(r.rentCheck).toMatch(/^NOT APPLICABLE: this card chases no rent/);
    expect(r.rentLanded).toBe(null);
  });

  it('a RENT ARREARS card whose rent has landed since still REFUSES, exactly as RENT LATE does', () => {
    const r = py(`
BANK[:] = [{"id": "recRentLineTextAa", "date": (date.today() - timedelta(days=1)).isoformat(), "amount": 500.0}]
CARD = arrears_fields()
landed = run()
dry = run(dry=True)
CARD = arrears_fields(notes="no key line on this card")
nokey = run()
print(json.dumps({"landed": [landed["refused"], landed["sent"]], "dry": dry["out"].get("rentCheck"),
                  "nokey": [nokey["refused"], nokey["sent"]],
                  "checkName": aef.rent_chase_check_name(ARREARS_NAME)[:11].strip(),
                  "isChase": [aef.rent_chase_card(ARREARS_NAME), aef.rent_chase_card(CHASE_NAME)]}))`);
    expect(r.landed[0]).toMatch(/the rent for the cycle due .* has arrived since the check ran: .*recRentLineTextAa/);
    expect(r.landed[0]).toMatch(/Nothing was sent/);
    expect(r.landed[1]).toEqual([]);
    expect(r.dry).toMatch(/has arrived since the check ran/);
    expect(r.nokey[0]).toMatch(/no RENT CHECK KEY line.*NOT CHECKED\. Nothing was sent/);
    expect(r.nokey[1]).toEqual([]);
    expect(r.checkName).toBe('RENT LATE:');             // one name for one matter, so no rename skips it
    expect(r.isChase).toEqual([true, false]);
  });

  it('no approval evidence refuses, and so does a card with no TO number in its approved output', () => {
    const r = py(`
out = {}
CARD = fields(approval=False)
out["noEvidence"] = run()
CARD = arrears_fields(approval=False)
out["noEvidenceArrears"] = run()
CARD = fields(out=output(number=""))
out["noNumber"] = run()
CARD = arrears_fields(out=output(number=""))
out["noNumberArrears"] = run()
CARD = fields(out=output(number="020 7946 0018"))
out["notMobile"] = run()
CARD = fields(out=output(number="07700 900999"))
out["notOurs"] = run()
print(json.dumps({k: [v["refused"], v["sent"]] for k, v in out.items()}))`);
    for (const k of ['noEvidence', 'noEvidenceArrears']) {
      expect([k, r[k][0]]).toEqual([k, expect.stringMatching(/never went through the approval gate/)]);
      expect([k, r[k][1]]).toEqual([k, []]);
    }
    for (const k of ['noNumber', 'noNumberArrears']) {
      expect([k, r[k][0]]).toEqual([k, expect.stringMatching(/TEXT TO|no text to send/)]);
      expect([k, r[k][1]]).toEqual([k, []]);
    }
    expect(r.notMobile[0]).toMatch(/not a UK mobile/);
    expect(r.notOurs[0]).toMatch(/not the Contact Number of a tenant linked to the task/);
    expect([r.notMobile[1], r.notOurs[1]]).toEqual([[], []]);
  });

  it('the text always leaves from the Agile Lets number, on both kinds of card', () => {
    const r = py(`
CARD = fields(); plain = run()
CARD = arrears_fields(); arrears = run()
print(json.dumps({"plain": plain["sent"], "arrears": arrears["sent"], "number": ST.AGILE_LETS_NUMBER,
                  "from": ST.TEXT_FROM == aef.PROPERTY_SENDER}))`);
    expect(r.number).toBe('+447984393339');             // Agile Lets, never Kevin's own number
    expect(r.from).toBe(true);
    for (const k of ['plain', 'arrears']) {
      expect([k, r[k].length]).toEqual([k, 1]);
      expect([k, r[k][0].to]).toEqual([k, '447700900123@sms.clicksend.com']);
      expect([k, r[k][0].from]).toEqual([k, 'info@agilelets.co.uk']);
      expect([k, r[k][0].text]).toEqual([k, expect.stringMatching(/Roy, Agile Lets$/)]);
    }
  });
});
