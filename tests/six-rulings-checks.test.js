import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SCRIPTS = resolve(ROOT, 'scripts');

// KEVIN'S SIX RULINGS BECOME REFUSALS (decision card recinoFWz6fQ6JVVB, approved as-is, option A, 16 Nov 2026).
//   1  every email to a letting agent goes FROM info@agilelets.co.uk signed "Roy Lavin" then "Agile Lets",
//      AGENT RENT LATE included; mail from info@ is signed that way; Kevin's Gmail is refused on property mail
//   3  a Haverhill certificate goes to the designated engineer first (a private file names them)
//   6  a quote request is one email per company, never two firms on one
// (Ruling 5, the 90-day trust bar, is in tests/autonomy-30-days.test.js and tests/agent-accuracy.test.js.)
// Each case below was back-tested on the stored Agent Outputs of the 90 days to 18 Nov 2026 before it was
// kept; the cases that must NOT be refused are the shapes that back-test turned up. Names, addresses and
// emails are invented. Every network door raises.

function run(code) {
  const out = execFileSync('python3', ['-c', code], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json'), SIGNIN_SKIP_WALK: '1',
           AGENT_RUN_QUEUE: '' },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

// ─── The email module on its own ──────────────────────────────────────────────────────────────────────
const EF = `
import sys, json
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import agent_email_format as ef
def mail(body, frm="info@agilelets.co.uk", to="office@fixture-trade.test", cc="", subject="Your visit", head=""):
    return (head + f"TO: {to}\\n" + (f"CC: {cc}\\n" if cc else "") + f"FROM: {frm}\\nSUBJECT: {subject}\\n---\\n{body}\\n\\n"
            "**Carrying this out will involve:** one email goes.")
def refused(output, task_name=None):
    try:
        ef.validate_submission(output, task_name=task_name)
        return None
    except ef.EmailFormatError as e:
        return str(e)
ROY = "Kind regards\\nRoy Lavin\\nAgile Lets"
# Roy's own address, read from the code's list of our addresses rather than typed into a public test.
ROY_ADDR = sorted(a for a in ef.RULE_OWN_ADDRESSES if a.startswith("roy"))[0]
`;

describe('ruling 1: mail from info@ is signed Roy Lavin, then Agile Lets', () => {
  it('refuses the old and wrong sign-offs to someone outside, and lets every right one through', () => {
    const r = run(EF + `
out = {
  "kevinOnBehalf": refused(mail("Please send your earliest date.\\n\\nKind regards\\nKevin Brittain\\non behalf of Agile Lets")),
  "kevinAlone": refused(mail("Thanks for the invoice.\\n\\nBest regards,\\nKevin")),
  "teamOnly": refused(mail("Thank you both.\\n\\nKind regards\\nAgile Lets")),
  "agileEstates": refused(mail("Noted.\\n\\nKind regards\\nRoy Lavin\\nAgile Lets\\nAgile Estates")),
  "noSignoff": refused(mail("Please send your earliest date.")),
  "roy": refused(mail("Please send your earliest date.\\n\\n" + ROY)),
  "royOwner": refused(mail("Please send your earliest date.\\n\\n" + ROY + "\\nOn behalf of the owner")),
  "royLtd": refused(mail("Please send your earliest date.\\n\\nKind regards\\nRoy Lavin\\nAgile Lets Ltd")),
  # A note to Roy, a reply to a tenant's text through the bridge, and a ClickSend text carry no email sign-off.
  "toRoy": refused(mail("Please chase the plumber.\\n\\nThanks,\\nKevin", to=ROY_ADDR)),
  "text": refused(mail("Hi Sam, the engineer comes Friday morning.", to="447700900318@sms.clicksend.com")),
  # Kevin's own mail from his Gmail keeps his own sign-off.
  "gmail": refused(mail("Thank you.\\n\\nKind regards\\nKevin Brittain", frm="kevinbrittain@gmail.com", to="help@fixture-bank.test")),
  "quotedBelow": refused(mail("Thanks, noted.\\n\\n" + ROY + "\\n\\nOn Mon, 2 Nov 2026 at 09:00, Sam wrote:\\n> Thanks\\n> Kevin")),
  # Review of this PR: an inline reply signs BELOW the quote, and an Outlook header block can sit above the signature.
  "inline": refused(mail("On Tue, 10 Nov 2026, Sam wrote:\\n> Can you do Friday?\\n\\nYes, Friday works.\\n\\n> And the keys?\\n\\nThey are in the lockbox.\\n\\n" + ROY)),
  "headerBlock": refused(mail("Thanks, Friday is fine.\\n\\nFrom: Sam <sam@fixture-trade.test>\\nSent: 10 November 2026\\nSubject: Friday\\n\\nCan you do Friday?\\n\\n" + ROY)),
  # A quoted thread below a top-posted reply carries other people's sign-offs, Kevin's own earlier ones included.
  "topPosted": refused(mail("Thanks, noted.\\n\\n" + ROY + "\\n\\nFrom: Kevin Brittain <kb@fixture-old.test>\\nSent: 1 Nov 2026\\n\\nHello\\n\\nKind regards\\nKevin Brittain")),
  "inlineKevin": refused(mail("On Tue, 10 Nov 2026, Sam wrote:\\n> Can you do Friday?\\n\\nYes, Friday works.\\n\\nKind regards\\nKevin Brittain")),
  # Second review: a quoted earlier "Roy Lavin / Agile Lets" under a top-posted reply or a forward is not this email's.
  "outlookQuotedRoy": refused(mail("Noted, thanks.\\n\\nKind regards\\nAgile Lets Team\\n\\nFrom: Roy Lavin <ops@fixture-old.test>\\n"
                                    "Sent: 1 Nov 2026\\nSubject: Visit\\n\\nHello\\n\\n" + ROY)),
  "forwardRoy": refused(mail("Please see below.\\n\\n---------- Forwarded message ---------\\nFrom: Sam <sam@fixture-trade.test>\\n"
                              "Subject: Visit\\n\\nHello\\n\\n" + ROY)),
}
print(json.dumps(out))`);
    expect(r.kevinOnBehalf).toMatch(/goes from info@agilelets.co.uk but is signed 'Kevin Brittain'/);
    expect(r.kevinOnBehalf).toMatch(/`Roy Lavin` with `Agile Lets` on the next line/);
    expect(r.kevinOnBehalf).toMatch(/send it from kevinbrittain@gmail.com instead/);
    expect(r.kevinAlone).toMatch(/is signed 'Kevin'/);
    expect(r.teamOnly).toMatch(/ends with the sign-off `Roy Lavin` and `Agile Lets`/);
    expect(r.agileEstates).toMatch(/is signed 'Agile Estates'/);
    expect(r.noSignoff).toMatch(/ends with the sign-off `Roy Lavin`/);
    for (const k of ['roy', 'royOwner', 'royLtd', 'toRoy', 'text', 'gmail', 'quotedBelow', 'inline', 'topPosted']) {
      expect(r[k], k).toBeNull();
    }
    expect(r.inlineKevin).toMatch(/ends with the sign-off `Roy Lavin`/);
    expect(r.outlookQuotedRoy).toMatch(/ends with the sign-off `Roy Lavin`/);
    // Signed below an Outlook header block with no ">" quoting: it cannot be told from a forwarded old sign-off, so it
    // is refused (the safe side); sign above the quoted message instead.
    expect(r.headerBlock).toMatch(/ends with the sign-off `Roy Lavin`/);
    expect(r.forwardRoy).toMatch(/ends with the sign-off `Roy Lavin`/);
  });

  it('an AGENT RENT LATE email goes from info@, signed Roy, never from Kevin\'s Gmail (the 5 Oct rule is retired)', () => {
    const r = run(EF + `
name = "AGENT RENT LATE: Fixture Lettings, rent due 10 Nov (2 units)"
out = {
  "gmail": refused(mail("Please tell us when the November rent will be paid.\\n\\nKind regards\\nKevin Brittain",
                        frm="kevinbrittain@gmail.com", to="accounts@fixture-lettings.test"), name),
  "infoKevin": refused(mail("Please tell us when the November rent will be paid.\\n\\nKind regards\\nKevin Brittain",
                            to="accounts@fixture-lettings.test"), name),
  "infoRoy": refused(mail("Please tell us when the November rent will be paid.\\n\\n" + ROY, to="accounts@fixture-lettings.test"), name),
  "otherTask": refused(mail("Thank you.\\n\\nKind regards\\nKevin Brittain", frm="kevinbrittain@gmail.com",
                            to="help@fixture-bank.test"), "INBOUND: the bank asks for a statement"),
  # A note to Roy on the task is not the email to the letting agent.
  "noteToRoy": refused(mail("Roy, the agent has not paid yet.\\n\\nThanks,\\nKevin", frm="kevinbrittain@gmail.com",
                            to=ROY_ADDR), name),
}
print(json.dumps(out))`);
    expect(r.gmail).toMatch(/an AGENT RENT LATE email goes to the letting agent FROM info@agilelets.co.uk/);
    expect(r.gmail).toMatch(/replacing the 5 Oct 2026 rule/);
    expect(r.infoKevin).toMatch(/is signed 'Kevin Brittain'/);
    expect(r.infoRoy).toBeNull();
    expect(r.otherTask).toBeNull();
    expect(r.noteToRoy).toBeNull();
  });
});

describe('ruling 6: one company per quote request', () => {
  it('refuses two firms on one quote email, points to TO-EACH, and leaves every other shape alone', () => {
    const r = run(EF + `
ask = "Please could you send us a quote for a gas safety check at 7 Example Road, Testville TE1 1AA?\\n\\n" + ROY
out = {
  "twoFirms": refused(mail(ask, to="jobs@fixture-gas.test, office@other-gas.test", subject="Quote request: gas safety check")),
  "ccFirm": refused(mail(ask, to="jobs@fixture-gas.test", cc="office@other-gas.test", subject="Gas safety check")),
  "twoSoleTraders": refused(mail(ask, to="gasman.one@gmail.com, gasman.two@gmail.com", subject="Gas safety check")),
  "oneFirmTwoPeople": refused(mail(ask, to="jobs@fixture-gas.test, lee@fixture-gas.test", subject="Quote request")),
  "firmAndRoy": refused(mail(ask, to="jobs@fixture-gas.test", cc=ROY_ADDR, subject="Quote request")),
  "toEach": refused(mail(ask, to="", subject="Quote request", head="").replace("TO: \\n", "TO-EACH: jobs@fixture-gas.test, office@other-gas.test\\n")),
  # Two companies with no quote asked: a reply that copies a managing agent's sister branch.
  "noQuote": refused(mail("Please release the October rent and quote the clause you rely on.\\n\\n" + ROY,
                          to="manager@fixture-agent.test", cc="lettings@fixture-agent-group.test", subject="Re: October rent")),
  "quoteRef": refused(mail("Please send the policy schedule.\\n\\n" + ROY, to="renewals@fixture-broker.test",
                           cc="service@fixture-insurer.test", subject="RE: Renewal [Quote Ref: 931520229]")),
  # Review of this PR: accepting a quote in its own thread, copying the tenant, asks no firm for a price.
  "acceptReply": refused(mail("Thank you, we accept. Please call Sam to arrange access.\\n\\n" + ROY, to="jobs@fixture-gas.test",
                              cc="sam.tenant@gmail.com", subject="Re: Quote for boiler repair")),
  "subdomain": refused(mail(ask, to="jobs@fixture-gas.co.uk, office@mail.fixture-gas.co.uk", subject="Quote request")),
  "howMuch": refused(mail("How much would it cost to clear the garden at 7 Example Road?\\n\\n" + ROY,
                          to="jobs@fixture-waste.test, office@other-waste.test", subject="Garden clearance")),
  "btconnect": refused(mail(ask, to="gas.one@btconnect.com, gas.two@btconnect.com", subject="Gas safety check")),
  "replyAsk": refused(mail(ask, to="jobs@fixture-gas.test", cc="office@other-gas.test", subject="Re: gas safety check")),
  # Second review: only a mail-system label is folded; per-user and per-tenant provider domains are different firms.
  "plusnet": refused(mail(ask, to="gas@smithgas.plus.test.co.uk, gas@jonesgas.plus.test.co.uk", subject="Gas safety check")),
  "tenantsOnProvider": refused(mail(ask, to="jobs@smithgas.onmicrosoft.test, jobs@jonesgas.onmicrosoft.test", subject="Gas safety check")),
  "howMuchOrder": refused(mail("Please tell us how much it would cost to clear the garden.\\n\\n" + ROY,
                               to="jobs@fixture-waste.test, office@other-waste.test", subject="Garden clearance")),
}
print(json.dumps(out))`);
    expect(r.twoFirms).toMatch(/asks for a quote \(the subject says 'Quote'\) and its TO and CC lines reach 2 companies \(fixture-gas.test, other-gas.test\)/);
    expect(r.twoFirms).toMatch(/one email per company, always, never two firms on one email/);
    expect(r.twoFirms).toMatch(/Use `TO-EACH:` in place of TO and CC/);
    expect(r.ccFirm).toMatch(/reach 2 companies/);
    expect(r.twoSoleTraders).toMatch(/reach 2 companies \(gasman.one@gmail.com, gasman.two@gmail.com\)/);
    for (const k of ['oneFirmTwoPeople', 'firmAndRoy', 'toEach', 'noQuote', 'quoteRef', 'acceptReply', 'subdomain']) {
      expect(r[k], k).toBeNull();
    }
    expect(r.howMuch).toMatch(/reach 2 companies/);
    expect(r.btconnect).toMatch(/reach 2 companies/);
    expect(r.replyAsk).toMatch(/the email asks/);         // a reply subject is not read, the request in its words is
    expect(r.plusnet).toMatch(/reach 2 companies/);
    expect(r.tenantsOnProvider).toMatch(/reach 2 companies/);
    expect(r.howMuchOrder).toMatch(/reach 2 companies/);
  });

  it('the Level A quote request (no card) is one company too, in the copy send-email.py re-checks', () => {
    const r = run(EF + `
task = {"name": "COMPLIANCE: GSC renewal due 2026-12-01 - 7 Example Road", "taskType": "Correspondence",
        "notes": "COVERAGE CHECKED: TE1\\n" + ef.RULE_STAMP + ": quote-request"}
def q(to):
    return {"to": to, "cc": [], "from": "info@agilelets.co.uk", "subject": "Quote: gas safety check",
            "body": "Please could you quote for a gas safety check?\\n\\nRoy Lavin\\nAgile Lets", "attach": None, "toEach": []}
out = {"two": ef.rule_send_problem("quote-request", q(["jobs@fixture-gas.test", "office@other-gas.test"]), task),
       "sameFirm": ef.rule_send_problem("quote-request", q(["jobs@fixture-gas.test", "lee@fixture-gas.test"]), task),
       "one": ef.rule_send_problem("quote-request", q(["jobs@fixture-gas.test"]), task)}
print(json.dumps(out))`);
    expect(r.two).toMatch(/one company per email, never two firms on one/);
    expect(r.sameFirm).toBe('');
    expect(r.one).toBe('');
  });
});

// ─── The submit gate, driven for real with Airtable swapped for fixtures ──────────────────────────────
const PRE = `
import importlib.util, json, os, io, sys, contextlib, types, tempfile, socket, urllib.request, re
from datetime import datetime, timedelta, timezone
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
socket.socket.connect = boom
socket.create_connection = boom
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
STATE = tempfile.mkdtemp()
m.STATE_DIR = STATE
m.INTENT_LEDGER = os.path.join(STATE, "carryout-intent.jsonl")
m.HANDOVER_DIR = tempfile.mkdtemp()
m.BROWSER_LEDGER = "/nonexistent/od-test-browser-ledger.jsonl"
AF = m.AF
CREATED = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
BUILDER = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
CREDITOR = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "creditor-management"][0]
PROPS = [
    {"id": "recPropHaveAaaaaa", "name": "12 Example Lane, Haverhill, Suffolk CB9 9ZZ", "short": "12 Example Lane", "kind": "HMO",
     "manager": "Property Portfolio", "postcode": "CB9 9ZZ", "required": ["EICR", "GSC"], "bedrooms": 4, "units": [], "managerEmail": ""},
    {"id": "recPropElseAaaaaa", "name": "7 Example Road, Testville TE1 1AA", "short": "7 Example Road", "kind": "Single Let",
     "manager": "Property Portfolio", "postcode": "TE1 1AA", "required": ["EICR", "GSC"], "bedrooms": 2, "units": [], "managerEmail": ""},
]
m.fetch_properties = lambda refresh=False: PROPS
m.fetch_certificates = lambda refresh=False: []
m.certificate_purchase_problem = lambda *a, **k: ""
m.fetch_bank_lines = lambda since: []
TENANT_ROWS = [{"id": "recTenantAaaaaaaa", "fields": {m.TENANT_EMAIL: "sam.tenant@fixture-mail.test"}}]
AGENT_ROWS = [{"id": "recAgentLateAaaaa", "fields": {AF["name"]: "AGENT RENT LATE: Fixture Lettings, rent due 1 Oct (1 unit)",
               AF["agentOutput"]: "TO: accounts@fixture-lettings.test\\nFROM: info@agilelets.co.uk\\nSUBJECT: Rent\\n---\\nHi\\n\\nRoy Lavin\\nAgile Lets"}}]
READ_FAIL = set()
def records(table, formula=None, fields=None, max_records=None):
    if table in READ_FAIL: raise RuntimeError("read failed")
    if table == m.TASKS and formula == "{Status}='Approval'": return []
    if table == m.TENANTS_TABLE: return json.loads(json.dumps(TENANT_ROWS))
    if table == m.TASKS and "AGENT RENT LATE" in str(formula): return json.loads(json.dumps(AGENT_ROWS))
    raise RuntimeError("no fixture for a read of " + table)
m.query_records = records
m.require_role_agent_live = lambda *a, **k: None
m.ledger_append = lambda *a, **k: None
m.ledger_last_events = lambda: {}
m.finding_details = lambda: {}
m.task_fields_owe_certificate = lambda *a, **k: []
m.task_owes_cost = lambda *a, **k: []
m.history = lambda **kw: {"terms": ["x"], "searched": ["tasks", "Gmail"], "entries": [], "notes": []}
m.track_record_problem = lambda *a, **k: ""
m.coverage_problem = lambda *a, **k: ""
m.checked_problem = lambda *a, **k: ""
TASK = {}
def task(name, notes="", desc=""):
    TASK.clear()
    TASK.update({"id": "recTESTTESTTEST01", "createdTime": CREATED,
                 "fields": {AF["name"]: name, AF["status"]: {"name": "Today"}, AF["teamMember"]: [BUILDER],
                            AF["notes"]: notes, AF["description"]: desc}})
def get(i):
    if i == TASK.get("id"): return json.loads(json.dumps(TASK))
    raise RuntimeError("no such task " + i)
m.get_task = get
CAPTURED = {}
def patch(i, f):
    CAPTURED.update(f); TASK["fields"].update(f)
    return {"id": i}
m.patch_task = patch
CONTRACTORS = {"contractors": [
    {"certificate": "gas", "towns": ["Haverhill"], "districts": ["CB9"], "name": "Fixture Gas Care", "aliases": ["Fixture Gas"],
     "emails": ["fixturegascare@gmail.com"], "domains": [], "sources": ["Airtable Tasks recFIXTURESOURCE1"]},
    {"certificate": "eicr", "towns": ["Haverhill"], "districts": ["CB9"], "name": "Fixture Sparks", "emails": ["office@fixture-sparks.test"],
     "domains": ["fixture-sparks.test"], "sources": ["Gmail 1a0000000000test"]}]}
def contractors(data):
    path = os.path.join(m.HANDOVER_DIR, m.PREFERRED_CONTRACTORS_FILE)
    if data is None:
        if os.path.exists(path): os.remove(path)
        return
    with open(path, "w") as fh:
        fh.write(data if isinstance(data, str) else json.dumps(data))
contractors(CONTRACTORS)
SEARCH = "searched the compliance book, the task history and both inboxes (info@ and Kevin's Gmail): nothing held"
def submit(output, agent=None, type_="Correspondence", tier1=False, declined="", tenant_notice=""):
    CAPTURED.clear()
    fh = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False); fh.write(output); fh.close()
    err, out, se = None, io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(se):
        try:
            m.cmd_submit(types.SimpleNamespace(task="recTESTTESTTEST01", agent=agent or BUILDER, type=type_,
                         output_file=fh.name, tier1=tier1, attach=None, plain_task="A job came in for one of the houses.",
                         plain_approve="The email goes and the task is noted.", tenant_notice=tenant_notice,
                         certificate_search=SEARCH, duplicate_check=None, same_house_check=None, on_payment_list=None,
                         rent_received=None, preferred_declined=declined))
        except SystemExit as e:
            err = str(e)
    st = CAPTURED.get(AF["status"])
    lines = [l for l in out.getvalue().strip().splitlines() if l.startswith("{")]
    return {"err": err, "status": st if isinstance(st, str) else (st or {}).get("name") if st else None,
            "notes": CAPTURED.get(AF["notes"], ""), "stdout": json.loads(lines[-1]) if lines else None,
            "stderr": se.getvalue()}
def email(body, to, frm="kevinbrittain@gmail.com", subject="Your visit", sign="Kind regards\\nKevin Brittain"):
    return (f"TO: {to}\\nFROM: {frm}\\nSUBJECT: {subject}\\n---\\n{body}\\n\\n{sign}\\n\\n"
            "**Carrying this out will involve:** one email goes.")
ROY = "Kind regards\\nRoy Lavin\\nAgile Lets"
ROY_ADDR = sorted(a for a in m.RULE_OWN_ADDRESSES if a.startswith("roy"))[0]
`;

describe('ruling 1: Kevin\'s Gmail is refused on property mail at submit', () => {
  it('refuses the property lanes and a tenant, letting agent or designated contractor on record', () => {
    const r = run(PRE + `
out = {}
def one(name, to, **kw):
    task(name)
    return submit(email("Please let us know.", to), **kw)["err"]
out["rent"] = one("RENT LATE: Unit 1 – 7 Example Road, rent due 1 Nov", "sam.tenant@fixture-mail.test")
out["agentLate"] = one("AGENT RENT LATE: Fixture Lettings, rent due 10 Nov (1 unit)", "accounts@fixture-lettings.test")
out["maintenance"] = one("MAINTENANCE: 7 Example Road - leaking tap", "jobs@fixture-plumbing.test")
out["cert"] = one("COMPLIANCE: EICR renewal due 2026-12-01 - 7 Example Road", "office@fixture-electric.test")
out["tenant"] = one("INBOUND: a tenant asks about the bins", "sam.tenant@fixture-mail.test")
out["agent"] = one("INBOUND: the letting agent asks about Apartment 7", "manager@fixture-lettings.test")
out["contractor"] = one("INBOUND: the gas engineer asks for a date", "fixturegascare@gmail.com")
print(json.dumps(out))`);
    expect(r.rent).toMatch(/goes from kevinbrittain@gmail.com, but it is a rent-lane email to a tenant or a letting agent/);
    expect(r.rent).toMatch(/goes FROM info@agilelets.co.uk, signed `Roy Lavin` then `Agile Lets`/);
    expect(r.agentLate).toMatch(/AGENT RENT LATE email goes to the letting agent FROM info@agilelets.co.uk|rent-lane email/);
    expect(r.maintenance).toMatch(/it is a MAINTENANCE email \(a repair\)/);
    expect(r.cert).toMatch(/it is certificate work \(EICR\)/);
    expect(r.tenant).toMatch(/sam.tenant@fixture-mail.test is a tenant on record/);
    expect(r.agent).toMatch(/manager@fixture-lettings.test is a letting agent on record/);
    expect(r.contractor).toMatch(/fixturegascare@gmail.com is a designated contractor on record/);
  });

  it('lets through what the back-test showed is his: insurers, lenders, councils, Roy, tier 1 and creditors', () => {
    const r = run(PRE + `
out = {}
def one(name, to, **kw):
    task(name)
    res = submit(email("Please send the schedule.", to), **kw)
    return [res["err"], res["status"]]
out["insurer"] = one("COMPLIANCE: Landlord Insurance missing - 7 Example Road", "renewals@fixture-insurer.test")
out["licence"] = one("COMPLIANCE: Testville Council HMO licence fee overdue - 7 Example Road", "licensing@testville.gov.test")
out["lender"] = one("INBOUND: the lender asks for a statement", "help@fixture-lender.test")
out["roy"] = one("COMPLIANCE: EICR renewal due 2026-12-01 - 7 Example Road", ROY_ADDR)
out["tier1"] = one("INBOUND: the letting agent asks about Apartment 7", "manager@fixture-lettings.test", tier1=True)
out["creditor"] = one("INBOUND: the letting agent asks about Apartment 7", "manager@fixture-lettings.test", agent=CREDITOR)
task("RENT LATE: Unit 1 – 7 Example Road, rent due 1 Nov")
out["rentInfo"] = [submit(email("Please let us know.", "sam.tenant@fixture-mail.test", frm="info@agilelets.co.uk", sign=ROY))["err"]]
print(json.dumps(out))`);
    for (const k of ['insurer', 'licence', 'lender', 'roy', 'tier1', 'creditor']) {
      expect(r[k][0], k).toBeNull();
      expect(r[k][1], k).toBe('Approval');
    }
    expect(r.rentInfo[0]).toBeNull();
  });

  it('a record it cannot read is NOT CHECKED, said on the card and in the output, and never a pass on the lanes', () => {
    const r = run(PRE + `
READ_FAIL.add(m.TENANTS_TABLE)
task("INBOUND: someone asks about the bins")
res = submit(email("Please let us know.", "someone@fixture-mail.test"))
task("RENT LATE: Unit 1 – 7 Example Road, rent due 1 Nov")
lane = submit(email("Please let us know.", "someone@fixture-mail.test"))
print(json.dumps({"err": res["err"], "status": res["status"], "stamp": re.findall(r"NOT CHECKED BY CODE[^\\n]*Gmail sender check[^\\n]*", res["notes"]),
                  "out": res["stdout"].get("notChecked"), "laneErr": lane["err"]}))`);
    expect(r.err).toBeNull();
    expect(r.status).toBe('Approval');
    expect(r.stamp[0]).toMatch(/could not read the Tenants table/);
    expect(r.out.join(' ')).toMatch(/Gmail sender check/);
    expect(r.laneErr).toMatch(/rent-lane email/);
  });
});

describe('ruling 3: a Haverhill certificate goes to the designated engineer first', () => {
  const quote = `email("Please could you send us a quote for a gas safety check at 12 Example Lane, Haverhill CB9 9ZZ?", to, frm="info@agilelets.co.uk", subject="Quote request: gas safety check", sign=ROY)`;
  it('refuses a gas or EICR quote that leaves the designated contractor out, and names the way through', () => {
    const r = run(PRE + `
out = {}
def q(name, to, declined=""):
    task(name)
    return submit(${quote}, declined=declined)
out["gasOther"] = q("COMPLIANCE: GSC renewal due 2026-12-01 - 12 Example Lane", "jobs@other-gas.test")["err"]
out["gasDesignated"] = q("COMPLIANCE: GSC renewal due 2026-12-01 - 12 Example Lane", "fixturegascare@gmail.com")
out["eicrOther"] = q("COMPLIANCE: EICR renewal due 2026-12-01 - 12 Example Lane", "jobs@other-electric.test")["err"]
out["eicrDomain"] = q("COMPLIANCE: EICR renewal due 2026-12-01 - 12 Example Lane", "lee@fixture-sparks.test")["err"]
d = q("COMPLIANCE: GSC renewal due 2026-12-01 - 12 Example Lane", "jobs@other-gas.test",
      declined="Fixture Gas Care said on 2 Dec they are fully booked until February")
out["declined"] = [d["err"], d["status"], re.findall(r"PREFERRED DECLINED \\(round \\d+\\): [^\\n]*", d["notes"])]
out["short"] = q("COMPLIANCE: GSC renewal due 2026-12-01 - 12 Example Lane", "jobs@other-gas.test", declined="busy")["err"]
out["elsewhere"] = q("COMPLIANCE: GSC renewal due 2026-12-01 - 7 Example Road", "jobs@other-gas.test")["err"]
out["epc"] = q("COMPLIANCE: EPC expired - 12 Example Lane", "jobs@other-epc.test")["err"]
print(json.dumps(out))`);
    expect(r.gasOther).toMatch(/it is a gas quote for 12 Example Lane, and 12 Example Lane has a designated contractor for that certificate: Fixture Gas Care \(fixturegascare@gmail.com\)/);
    expect(r.gasOther).toMatch(/--preferred-declined "<what they said and when, or why the job is new>"/);
    expect(r.gasDesignated.err).toBeNull();
    expect(r.gasDesignated.status).toBe('Approval');
    expect(r.eicrOther).toMatch(/designated contractor for that certificate: Fixture Sparks/);
    expect(r.eicrDomain).toBeNull();                          // another address at the firm's own domain
    expect(r.declined[0]).toBeNull();
    expect(r.declined[1]).toBe('Approval');
    expect(r.declined[2][0]).toMatch(/PREFERRED DECLINED \(round 1\): Fixture Gas Care said on 2 Dec they are fully booked/);
    expect(r.short).toMatch(/too short to say why/);
    expect(r.elsewhere).toBeNull();                            // not a town the file covers
    expect(r.epc).toBeNull();                                  // not a type the file covers
  });

  it('a PASS TO ROY booking must name them; a chase is not a new quote', () => {
    const r = run(PRE + `
out = {}
task("COMPLIANCE: GSC renewal due 2026-12-01 - 12 Example Lane")
book = ("PASS TO ROY: please book Fixture Gas for the gas safety check at 12 Example Lane on Friday 4 December.\\n\\n"
        "**Carrying this out will involve:** Roy books the visit.")
out["named"] = submit(book, type_="Admin", tenant_notice="2026-12-04: Roy texts every tenant by ClickSend")["err"]
other = book.replace("Fixture Gas", "Other Gas Ltd")
out["other"] = submit(other, type_="Admin", tenant_notice="2026-12-04: Roy texts every tenant by ClickSend")["err"]
chase = email("Any update on the report from your visit?", "jobs@other-gas.test", frm="info@agilelets.co.uk",
              subject="Chasing the gas safety record", sign=ROY)
out["chase"] = submit(chase)["err"]
print(json.dumps(out))`);
    expect(r.named).toBeNull();
    expect(r.other).toMatch(/it is a gas booking for 12 Example Lane/);
    expect(r.chase).toBeNull();
  });

  it('a missing or unreadable file is loud (stderr, the card, the output) but never refuses the card', () => {
    const r = run(PRE + `
out = {}
for label, data in (("missing", None), ("unreadable", "{ not json"), ("badEntry", {"contractors": [{"certificate": "gas", "name": "No Email Co"}]})):
    contractors(data)
    task("COMPLIANCE: GSC renewal due 2026-12-01 - 12 Example Lane")
    res = submit(${quote.replace('to,', '"jobs@other-gas.test",')})
    out[label] = {"err": res["err"], "status": res["status"],
                  "stamp": re.findall(r"NOT CHECKED BY CODE[^\\n]*designated-contractor check[^\\n]*", res["notes"]),
                  "stdout": (res["stdout"] or {}).get("notChecked"), "stderr": "designated-contractor check" in res["stderr"]}
print(json.dumps(out))`);
    for (const k of ['missing', 'unreadable', 'badEntry']) {
      expect(r[k].err, k).toBeNull();
      expect(r[k].status, k).toBe('Approval');
      expect(r[k].stamp.length, k).toBe(1);
      expect(r[k].stdout.join(' '), k).toMatch(/designated-contractor check/);
      expect(r[k].stderr, k).toBe(true);
    }
    expect(r.missing.stamp[0]).toMatch(/preferred-contractors.json is missing/);
    expect(r.unreadable.stamp[0]).toMatch(/could not be read/);
    expect(r.badEntry.stamp[0]).toMatch(/entries it cannot use: entry 1 \(No Email Co\)/);
  });
});

describe('what the independent review of this PR found, each now a case', () => {
  it('ruling 3: a notice to the tenants or Roy is not a quote; the designated firm comes first, alone', () => {
    const r = run(PRE + `
out = {}
N = "COMPLIANCE: GSC renewal due 2026-12-01 - 12 Example Lane"
NOTICE = "2026-12-04: the tenants are told by this email and a ClickSend text"
def go(to, body="Fixture Gas Care is booked for Friday 4 December at 10am for the gas safety check.", cc=""):
    task(N)
    head = f"TO: {to}\\n" + (f"CC: {cc}\\n" if cc else "")
    out_ = (head + "FROM: info@agilelets.co.uk\\nSUBJECT: Gas safety check on Friday\\n---\\nHello,\\n\\n" + body + "\\n\\n" + ROY +
            "\\n\\n**Carrying this out will involve:** one email goes.")
    return submit(out_, tenant_notice=NOTICE)["err"]
out["tenant"] = go("sam.tenant@fixture-mail.test")
out["roy"] = go(ROY_ADDR)
out["designatedCcTenant"] = go("fixturegascare@gmail.com", cc="sam.tenant@fixture-mail.test")
QUOTE = "Please could you send us a quote for a gas safety check at 12 Example Lane, Haverhill CB9 9ZZ?"
out["designatedCcFirm"] = go("fixturegascare@gmail.com", body=QUOTE, cc="office@other-gas.test")
out["bookingCcFirm"] = go("fixturegascare@gmail.com", cc="office@other-gas.test")
out["councilCc"] = go("sam.tenant@fixture-mail.test", cc="housing@testville.gov.uk")
out["agentCc"] = go("sam.tenant@fixture-mail.test", cc="accounts@fixture-lettings.test")
out["newTenant"] = go("new.tenant@fixture-mail.test")
task(N)
each = ("TO-EACH: fixturegascare@gmail.com, office@other-gas.test, jobs@third-gas.test\\nFROM: info@agilelets.co.uk\\n"
        "SUBJECT: Quote request: gas safety check\\n---\\nHello,\\n\\nPlease could you send us a quote for a gas safety check at "
        "12 Example Lane, Haverhill CB9 9ZZ?\\n\\n" + ROY + "\\n\\n**Carrying this out will involve:** three separate emails go.")
out["toEachFirst"] = submit(each)["err"]
READ_FAIL.add(m.TENANTS_TABLE)
out["tenantUnread"] = go("sam.tenant@fixture-mail.test")
print(json.dumps(out))`);
    expect(r.tenant).toBeNull();
    expect(r.roy).toBeNull();
    expect(r.designatedCcTenant).toBeNull();
    expect(r.designatedCcFirm).toMatch(/quote request for 12 Example Lane to the designated contractor \(Fixture Gas Care .*\) and to another firm at the same time \(office@other-gas.test\)/);
    expect(r.bookingCcFirm).toBeNull();                      // a booking WITH them may copy whoever needs to know
    expect(r.councilCc).toBeNull();
    expect(r.agentCc).toBeNull();
    expect(r.newTenant).toMatch(/must be on record \(the Tenants table/);
    expect(r.toEachFirst).toMatch(/and to another firm at the same time \(office@other-gas.test, jobs@third-gas.test\)/);
    expect(r.tenantUnread).toMatch(/could not read the Tenants table .*NOT CHECKED/);
  });

  it('ruling 3: a street named after the town is not the town, and a file with odd value types neither crashes nor goes quiet', () => {
    const r = run(PRE + `
PROPS.append({"id": "recPropRoadAaaaaa", "name": "3 Haverhill Road, Testville TE9 9ZZ", "short": "3 Haverhill Road", "kind": "HMO",
              "manager": "Property Portfolio", "postcode": "TE9 9ZZ", "required": ["GSC"], "bedrooms": 3, "units": [], "managerEmail": ""})
def q(name, data=None):
    if data is not None: contractors(data)
    task(name)
    res = submit(email("Please could you send us a quote for a gas safety check?", "jobs@other-gas.test", frm="info@agilelets.co.uk",
                       subject="Quote request: gas safety check", sign=ROY))
    return {"err": res["err"], "nc": re.findall(r"NOT CHECKED BY CODE[^\\n]*designated-contractor[^\\n]*", res["notes"])}
out = {"road": q("COMPLIANCE: GSC renewal due 2026-12-01 - 3 Haverhill Road")}
strings = {"contractors": [{"certificate": "gas", "towns": "Haverhill", "districts": "CB9", "name": "Fixture Gas Care",
                            "emails": "fixturegascare@gmail.com", "domains": 7, "sources": "Airtable Tasks recFIXTURESOURCE1"}]}
out["strings"] = q("COMPLIANCE: GSC renewal due 2026-12-01 - 12 Example Lane", strings)
broken = {"contractors": [{"certificate": "gas", "towns": ["Haverhill"], "name": 5, "emails": 7, "sources": 5}]}
out["broken"] = q("COMPLIANCE: GSC renewal due 2026-12-01 - 12 Example Lane", broken)
contractors(CONTRACTORS)
out["twoTypes"] = q("COMPLIANCE: GSC and EICR renewals due 2026-12-01 - 12 Example Lane")
out["mixed"] = q("COMPLIANCE: Gas safety certificate for HMO licence - 12 Example Lane")
print(json.dumps(out))`);
    expect(r.road.err).toBeNull();
    expect(r.strings.err).toMatch(/designated contractor for that certificate: Fixture Gas Care/);   // a string is one item
    expect(r.broken.err).toBeNull();
    expect(r.broken.nc[0]).toMatch(/entries it cannot use: entry 1 \(no name\)/);
    expect(r.twoTypes.err).toBeNull();
    expect(r.twoTypes.nc[0]).toMatch(/names EICR and GSC beside another subject/);
    expect(r.mixed.err).toBeNull();
    expect(r.mixed.nc[0]).toMatch(/names GSC beside another subject/);
  });

  it('ruling 1: zero letting-agent cards read is NOT CHECKED, and a property\'s agent email is matched exactly', () => {
    const r = run(PRE + `
out = {}
PROPS[1]["managerEmail"] = "lettings@fixture-manager.test"
def one(to):
    task("INBOUND: a question about a property")
    res = submit(email("Please let us know.", to))
    return {"err": res["err"], "nc": re.findall(r"NOT CHECKED BY CODE[^\\n]*Gmail sender check[^\\n]*", res["notes"])}
out["exact"] = one("lettings@fixture-manager.test")
out["otherDept"] = one("council.tax@fixture-manager.test")
AGENT_ROWS[:] = []
out["noAgents"] = one("someone@fixture-mail.test")
print(json.dumps(out))`);
    expect(r.exact.err).toMatch(/lettings@fixture-manager.test is a letting agent on record/);
    expect(r.otherDept.err).toBeNull();
    expect(r.noAgents.err).toBeNull();
    expect(r.noAgents.nc[0]).toMatch(/AGENT RENT LATE cards \(none read back\)/);
  });
});
