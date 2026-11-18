import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// FOUR MORE LESSONS BECOME REFUSALS AT SUBMIT (Kevin, "Do it now", 16 Nov 2026, evening).
//   9   inbound-comms-response 27 Aug: an Inbox Response card while its twin already waits on Kevin
//   10  inbound-comms-response 25 Sep: "it will be paid" with no MARK FOR PAYMENT card anywhere
//   11  property-administration 15 Sep: a second card on one house and one certificate
//   12  property-administration 2 Oct: a quote, chase or booking with no certificate search written up
// Each was back-tested read-only on the stored outputs of the 30 days to 16 Nov 2026 before it was kept;
// the cases below that must NOT be refused are the shapes that back-test turned up.
//
// The real cmd_submit runs with Airtable swapped for in-memory fixtures. Every network door raises
// (urlopen, socket connect, create_connection). Names, addresses, amounts and ids are invented.

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
# The designated-contractor list is a private file (Kevin, 16 Nov 2026); none is designated for these houses.
open(os.path.join(m.HANDOVER_DIR, m.PREFERRED_CONTRACTORS_FILE), "w").write(json.dumps({"contractors": []}))
m.BROWSER_LEDGER = "/nonexistent/od-test-browser-ledger.jsonl"
AF = m.AF
G = m._gate().F
TODAY = datetime.now(m.LONDON).date()
def day(n): return (TODAY + timedelta(days=n)).isoformat()
CREATED = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
RESPONSE, PROPERTY = m.RESPONSE_REC_ID, m.PROPERTY_REC_ID
BUILDER = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
PROPS = [
    {"id": "recPropOneAaaaaaa", "name": "7 Example Road, Testville TE1 1AA", "short": "7 Example Road", "kind": "HMO",
     "manager": "Property Portfolio", "required": ["Landlord Insurance", "EICR", "EPC", "GSC"], "bedrooms": 2, "units": []},
    {"id": "recPropTwoAaaaaaa", "name": "9 Sample Street, Testville TE1 2BB", "short": "9 Sample Street", "kind": "Single Let",
     "manager": "Property Portfolio", "required": ["Landlord Insurance", "EICR", "EPC", "GSC"], "bedrooms": 4, "units": []},
]
m.fetch_properties = lambda refresh=False: PROPS
m.fetch_certificates = lambda refresh=False: []
m.certificate_purchase_problem = lambda *a, **k: ""
m.fetch_bank_lines = lambda since: []
WAITING = []          # cards waiting on Kevin: what "{Status}='Approval'" returns
READS = []
def records(table, formula=None, fields=None, max_records=None):
    READS.append([table, formula])
    if table == m.TASKS and formula == "{Status}='Approval'":
        return json.loads(json.dumps(WAITING))
    raise RuntimeError("no fixture for a read of " + table)
m.query_records = records
def card(cid, name, sender=None, notes="", output="", inbound="", props=None):
    f = {AF["name"]: name, AF["status"]: {"name": "Approval"}, AF["sentForApprovalBy"]: [sender or BUILDER],
         AF["notes"]: notes, AF["agentOutput"]: output}
    if inbound: f[AF["inboundSender"]] = inbound
    if props: f[G["properties"]] = props
    return {"id": cid, "createdTime": CREATED, "fields": f}
OTHERS = {}           # tasks a card may name, read by id
m.require_role_agent_live = lambda *a, **k: None
m.ledger_append = lambda *a, **k: None
m.ledger_last_events = lambda: {}
m.finding_details = lambda: {}
m.task_fields_owe_certificate = lambda *a, **k: []
m.task_owes_cost = lambda *a, **k: []
m.history = lambda **kw: {"terms": ["x"], "searched": ["tasks", "Gmail"], "entries": [], "notes": []}
m.track_record_problem = lambda *a, **k: ""
m.validate_any_submission = lambda *a, **k: None
m.coverage_problem = lambda *a, **k: ""
m.checked_problem = lambda *a, **k: ""
TASK = {}
def task(name, notes="", desc="", inbound="", holder=None, extra=None):
    TASK.clear()
    TASK.update({"id": "recTESTTESTTEST01", "createdTime": CREATED,
                 "fields": {AF["name"]: name, AF["status"]: {"name": "Today"}, AF["teamMember"]: [holder or BUILDER],
                            AF["notes"]: notes, AF["description"]: desc}})
    if inbound: TASK["fields"][AF["inboundSender"]] = inbound
    TASK["fields"].update(extra or {})
def get(i):
    if i == TASK.get("id"): return json.loads(json.dumps(TASK))
    if i in OTHERS: return json.loads(json.dumps(OTHERS[i]))
    raise RuntimeError("no such task " + i)
m.get_task = get
CAPTURED = {}
def patch(i, f):
    CAPTURED.update(f); TASK["fields"].update(f)
    return {"id": i}
m.patch_task = patch
def submit(output, agent=None, type_="Admin", plain_approve="The card goes to Kevin and the agent records it.",
           certificate_search=None, tenant_notice="", duplicate_check=None, same_house_check=None, on_payment_list=None,
           rent_received=None):
    CAPTURED.clear()
    fh = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False); fh.write(output); fh.close()
    err = None
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        try:
            m.cmd_submit(types.SimpleNamespace(task="recTESTTESTTEST01", agent=agent or BUILDER, type=type_,
                         output_file=fh.name, tier1=False, attach=None, plain_task="A job came in for one of the houses.",
                         plain_approve=plain_approve, tenant_notice=tenant_notice, certificate_search=certificate_search,
                         duplicate_check=duplicate_check, same_house_check=same_house_check, on_payment_list=on_payment_list,
                         rent_received=rent_received))
        except SystemExit as e:
            err = str(e)
    st = CAPTURED.get(AF["status"])
    return {"err": err, "status": st if isinstance(st, str) else (st or {}).get("name") if st else None,
            "notes": CAPTURED.get(AF["notes"], ""), "output": CAPTURED.get(AF["agentOutput"], "")}
def email(body, to="office@fixture-trade.test", subject="Your invoice", close="one email from the Agile Lets inbox to the firm.", head=""):
    return (head + f"TO: {to}\\nFROM: info@agilelets.co.uk\\nSUBJECT: {subject}\\n---\\n{body}\\n\\nKind regards\\nRoy Lavin\\nAgile Lets\\n\\n"
            "**Carrying this out will involve:** " + close)
`;

function py(snippet) {
  const out = execFileSync('python3', ['-c', PRE + snippet], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json'), SIGNIN_SKIP_WALK: '1',
           AGENT_RUN_QUEUE: '' },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('9. an Inbox Response card is refused while its twin already waits on Kevin', () => {
  it('a second card on one cancellation is refused; naming the other card, or closing as its duplicate, lands', () => {
    const r = py(`
WAITING[:] = [card("recTwinCardAaaaaa", "FIXED COST: Fixture Fitness renews 15 Dec at GBP 20.00, keep or cancel", sender=RESPONSE,
                   inbound="billing@fixture-fitness.test")]
task("CORRESPONDENCE: Fixture Fitness follow-up, cancel the plan before it renews", inbound="billing@fixture-fitness.test")
body = email("Please confirm the plan is cancelled before 15 December.", to="billing@fixture-fitness.test", subject="Cancel my plan")
out = {"first": submit(body, agent=RESPONSE, type_="Correspondence")}
named = body
out["named"] = submit(named, agent=RESPONSE, type_="Correspondence",
                      duplicate_check="not the same matter as recTwinCardAaaaaa: that card ends our cost record, this asks the firm to confirm")
out["namedStamp"] = re.findall(r"DUPLICATE CHECK \\(round \\d+\\): [^\\n]*", out["named"]["notes"])
out["vague"] = submit(body, agent=RESPONSE, type_="Correspondence", duplicate_check="different")["err"]
out["otherId"] = submit(body, agent=RESPONSE, type_="Correspondence",
                        duplicate_check="not the same matter as recSomethingElseA: it is about another plan entirely")["err"]
out["reportLine"] = submit("DUPLICATE CHECK: not the same matter as recTwinCardAaaaaa: that card ends our cost record\\nA report.\\n\\n"
                           "**Carrying this out will involve:** a note goes on the task.", agent=RESPONSE)["err"]
out["namedBody"] = (m.parse_email_output(named) or {}).get("body", "")
out["closed"] = submit("CLOSE PROPOSAL: duplicate of recTwinCardAaaaaa\\n\\n**Carrying this out will involve:** this task closes.", agent=RESPONSE)
out["otherAgent"] = submit(body, agent=BUILDER, type_="Correspondence")
print(json.dumps(out))`);
    expect(r.first.err).toMatch(/a card for the same matter is already waiting on Kevin: recTwinCardAaaaaa/);
    expect(r.first.err).toMatch(/--duplicate-check "not the same matter as recTwinCardAaaaaa: <what makes it different>"/);
    expect(r.first.err).toMatch(/CLOSE PROPOSAL: duplicate of recTwinCardAaaaaa/);
    expect(r.named.err).toBeNull();
    expect(r.named.status).toBe('Approval');
    expect(r.namedStamp[0]).toMatch(/DUPLICATE CHECK \(round 1\): not the same matter as recTwinCardAaaaaa/);
    expect(r.vague).toMatch(/already waiting on Kevin/);              // a reason that names nothing is no way through
    expect(r.otherId).toMatch(/already waiting on Kevin/);
    expect(r.reportLine).toBeNull();                                 // on a card that is not an email, the line does it
    expect(r.namedBody).toMatch(/Please confirm the plan is cancelled/);
    expect(r.namedBody).not.toMatch(/DUPLICATE CHECK/);           // in the closing line: never sent
    expect(r.closed.err).toBeNull();
    expect(r.otherAgent.err).toBeNull();               // the lesson is Inbox Response's
  });

  it('two bills for two flats, another sender, another house, a sibling held under it and the card itself are not twins', () => {
    const r = py(`
out = {}
def one(waiting, name, inbound="lettings@fixture-agent.test", notes=""):
    WAITING[:] = waiting
    task(name, inbound=inbound, notes=notes)
    return submit(email("Thank you, noted.", to=inbound), agent=RESPONSE, type_="Correspondence")["err"]
out["flats"] = one([card("recFlatOneAaaaaaa", "PAY: Fixture Lettings 376 GBP in advance - Flat 1 Test House", sender=RESPONSE,
                         inbound="lettings@fixture-agent.test")], "PAY: Fixture Lettings 554 GBP in advance - Flat 5 Test House")
out["sender"] = one([card("recSenderAaaaaaaa", "INBOUND: Fixture Fitness asks to confirm cancellation", sender=RESPONSE,
                          inbound="billing@other-gym.test")], "INBOUND: Fixture Fitness asks to confirm cancellation",
                    inbound="billing@fixture-fitness.test")
out["house"] = one([card("recHouseAaaaaaaaa", "INBOUND: tenant at 7 Example Road reports a leak", sender=RESPONSE,
                         inbound="tenant@example.test")], "INBOUND: tenant at 9 Sample Street reports a leak", inbound="tenant@example.test")
out["held"] = one([card("recHeldAaaaaaaaaa", "INBOUND: Fixture Fitness asks to confirm cancellation", sender=RESPONSE,
                        inbound="billing@fixture-fitness.test", notes="HELD UNDER recTESTTESTTEST01 (EICR TE1)")],
                  "INBOUND: Fixture Fitness asks to confirm cancellation", inbound="billing@fixture-fitness.test")
out["self"] = one([dict(card("recTESTTESTTEST01", "INBOUND: Fixture Fitness asks to confirm cancellation", sender=RESPONSE,
                             inbound="billing@fixture-fitness.test"))],
                  "INBOUND: Fixture Fitness asks to confirm cancellation", inbound="billing@fixture-fitness.test")
out["noSender"] = one([dict(card("recNoSenderAaaaaa", "INBOUND: Fixture Fitness asks to confirm cancellation",
                                 inbound="billing@fixture-fitness.test"), fields=dict(card("recNoSenderAaaaaa",
                                 "INBOUND: Fixture Fitness asks to confirm cancellation", inbound="billing@fixture-fitness.test")["fields"],
                                 **{AF["sentForApprovalBy"]: []}))],
                      "INBOUND: Fixture Fitness asks to confirm cancellation", inbound="billing@fixture-fitness.test")
print(json.dumps(out))`);
    expect(r).toEqual({ flats: null, sender: null, house: null, held: null, self: null, noSender: null });
  });

  it('a read of the waiting cards that fails refuses as NOT CHECKED; a report that files itself is not judged', () => {
    const r = py(`
def down(*a, **k): raise RuntimeError("HTTP 503")
task("INBOUND: Fixture Fitness asks to confirm cancellation", inbound="billing@fixture-fitness.test")
m.query_records = down
out = {"down": submit(email("Thank you, noted.", to="billing@fixture-fitness.test"), agent=RESPONSE, type_="Correspondence")["err"]}
out["info"] = submit("STATUS ONLY: the firm has not replied yet.\\nNEXT CHECK: " + day(3) + "\\n\\n**Carrying this out will involve:** Nothing. Information only.",
                     agent=RESPONSE)["err"]
print(json.dumps(out))`);
    expect(r.down).toMatch(/a submit check could not run \(RuntimeError: HTTP 503\), so it is NOT CHECKED/);
    expect(r.info === null || !/could not run/.test(r.info)).toBe(true);
  });
});

describe('10. a bill said to be paid needs a MARK FOR PAYMENT card', () => {
  it('"it will go on our next payment run" with no card is refused, on an email, a close and a report that files itself', () => {
    const r = py(`
task("INBOUND: pay Fixture Electrical invoice INV-1001, 168 GBP - 9 Sample Street", inbound="accounts@fixture-electrical.test")
mail = email("Thank you for invoice INV-1001 for £168.00. It will go on our next payment run, this Friday.",
             to="accounts@fixture-electrical.test")
out = {"email": submit(mail, type_="Correspondence")["err"]}
out["info"] = submit("The £168 bill will be paid on Friday's payment run.\\n\\n**Carrying this out will involve:** Nothing. Information only.")["err"]
out["close"] = submit("CLOSE PROPOSAL: covered. We will pay the £168 invoice on Friday.\\n\\n**Carrying this out will involve:** this task closes.")["err"]
out["plainLine"] = submit("Report.\\n\\n**Carrying this out will involve:** a note goes on the task.",
                          plain_approve="We will pay the £168 invoice on Friday once this is approved.")["err"]
print(json.dumps(out))`);
    for (const k of ['email', 'info', 'close', 'plainLine']) {
      expect([k, r[k]]).toEqual([k, expect.stringMatching(/it says a bill will be paid .* no card lists it/)]);
      expect(r[k]).toMatch(/MARK FOR PAYMENT block/);
      expect(r[k]).toMatch(/--on-payment-list <its rec id>/);
      expect(r[k]).toMatch(/PAID CHECK: <the payment's date, amount and transaction id>/);
    }
  });

  it('each way through the refusal lands: the block, a named card code can read, a PAID CHECK line', () => {
    const r = py(`
task("INBOUND: Fixture Electrical asks when invoice INV-1001 will be paid", inbound="accounts@fixture-electrical.test")
OTHERS["recPayCardAaaaaaa"] = {"id": "recPayCardAaaaaaa", "fields": {AF["name"]: "INBOUND: pay Fixture Electrical 168 GBP",
    AF["agentOutput"]: "MARK FOR PAYMENT: Fixture Electrical INV-1001\\nAMOUNT: £168.00\\nPAYEE: Fixture Electrical\\n\\n**Carrying this out will involve:** the list."}}
OTHERS["recNotACardAaaaaa"] = {"id": "recNotACardAaaaaa", "fields": {AF["name"]: "INBOUND: some other reply", AF["agentOutput"]: "A reply."}}
say = "Invoice INV-1001 for £168.00 is approved and is on our payment run for Friday."
m.fetch_bank_lines = lambda since: [{"id": "recOtherLineAaaaa", "date": day(-1), "amount": -12.0, "name": "SOMETHING ELSE", "tenancyIds": []}]
out = {}
out["named"] = submit(email(say, to="accounts@fixture-electrical.test"), type_="Correspondence", on_payment_list="recPayCardAaaaaaa")["err"]
out["reportLine"] = submit("ON PAYMENT LIST: recPayCardAaaaaaa\\nThe £168 bill will be paid on Friday's payment run.\\n\\n"
                           "**Carrying this out will involve:** Nothing. Information only.")["err"]
out["trackLink"] = submit(email(say, to="accounts@fixture-electrical.test",
    head="TRACK RECORD:\\n- 7 Oct 2026, payment card approved (https://airtable.com/appX/tblY/recPayCardAaaaaaa)\\n\\n"), type_="Correspondence")["err"]
out["wrongCard"] = submit(email(say, to="accounts@fixture-electrical.test"), type_="Correspondence", on_payment_list="recNotACardAaaaaa")["err"]
out["unreadable"] = submit(email(say, to="accounts@fixture-electrical.test"), type_="Correspondence", on_payment_list="recGoneMissingAaa")["err"]
out["block"] = submit("MARK FOR PAYMENT: Fixture Electrical INV-1001\\nAMOUNT: £168.00\\nPAYEE: Fixture Electrical\\n"
                      "PAID CHECK: none found (searched the bank and Gmail from 1 Nov to 16 Nov)\\n\\nIt will be paid on Friday.\\n\\n"
                      "**Carrying this out will involve:** it goes on the Friday payment list.")["err"]
out["paid"] = submit("PAID CHECK: paid 13 Nov, £168.00 to Fixture Electrical, recBankLineAaaaaa\\n\\nThe £168 bill will be paid by nobody again.\\n\\n"
                     "**Carrying this out will involve:** Nothing. Information only.")["err"]
print(json.dumps(out))`);
    expect(r.named).toBeNull();
    expect(r.reportLine).toBeNull();
    expect(r.trackLink).toBeNull();
    expect(r.wrongCard).toMatch(/no card lists it/);
    expect(r.unreadable).toMatch(/Code could not read recGoneMissingAaa .*NOT CHECKED/);
    expect(r.block).toBeNull();
    expect(r.paid).toBeNull();
  });

  it('an automatic collection or someone else paying is not a bill for the Friday list, and the refusal says the robot may reword', () => {
    const r = py(`
S = lambda t: m.bill_promise_sentence(m.bill_own_words(t))
task("FIXED COST: Fixture Gym renews 15 Dec at GBP 20.00")
ref = submit("The £20 renewal will be paid on Friday.\\n\\n**Carrying this out will involve:** Nothing. Information only.")["err"]
print(json.dumps({
  "dd": S("The £20 renewal will be paid by direct debit on 15 Dec."),
  "so": S("The £500 rent to the head landlord will be paid by standing order on the 1st."),
  "pcl": S("The £61.20 premium will be paid monthly through Premium Credit."),
  "card": S("The £45 annual fee will be paid from the card already on file."),
  "auto": S("The £9.99 invoice will be paid automatically when it renews."),
  "insurer": S("The £300 repair invoice will be paid, and the insurer pays it under the claim."),
  "agent": S("The £80 invoice will be paid on Friday; the agent pays it from the rent."),
  "tenant": S("The £60 call-out charge will be paid on Friday, as the tenant pays it under the lease."),
  "ours": S("The £20 renewal will be paid on Friday."),
  "message": ref,
}))`);
    for (const k of ['dd', 'so', 'pcl', 'card', 'auto', 'insurer', 'agent', 'tenant']) expect([k, r[k]]).toEqual([k, '']);
    expect(r.ours).toBe('The £20 renewal will be paid on Friday.');
    expect(r.message).toMatch(/if it is collected automatically \(a direct debit, a standing order, Premium Credit, a card already on file\) or someone else pays \(the insurer, the agent, the tenant\), reword the sentence to name that payer/);
    expect(r.message).toMatch(/a MARK FOR PAYMENT card would pay it twice/);
  });

  it('money owed to us, a tenant\'s arrears, reported words, a quoted line and a TRACK RECORD line are not our promise', () => {
    const r = py(`
S = lambda t: m.bill_promise_sentence(m.bill_own_words(t))
print(json.dumps({
  "owesUs": S("The council owes us £897.52 for October, to be paid with the next bulk payment, and it will be paid on Friday."),
  "arrears": S("Arrears of £205.00 will be paid within the next 7 days."),
  "rent": S("Your rent of £500 will be paid by standing order."),
  "says": S("It says the £376 and £554 will be paid in advance by Friday."),
  "tenant": S("The tenant will pay the £60 call-out fee."),
  "byTenant": S("The £60 call-out fee will be paid by the tenant."),
  "notYet": S("The invoice will not be paid until the work is signed off."),
  "question": S("Could you confirm the invoice will be paid by Friday?"),
  "yearly": S("The council charges £53 a year for the bin, and it has to be paid again every year."),
  "quoted": S("Thanks.\\n> The £168 invoice will be paid on Friday."),
  "track": S("TRACK RECORD:\\n- 3 Nov 2026: the £350 bill goes on this Friday's payment list\\n\\nThanks for the photos."),
  "ours": S("We will pay the £168 invoice on Friday."),
  "list": S("The £350 bill for the garden clearance is on this Friday's payment list."),
}))`);
    for (const k of ['owesUs', 'arrears', 'rent', 'says', 'tenant', 'byTenant', 'notYet', 'question', 'yearly', 'quoted', 'track']) {
      expect([k, r[k]]).toEqual([k, '']);
    }
    expect(r.ours).toBe('We will pay the £168 invoice on Friday.');
    expect(r.list).toMatch(/on this Friday's payment list/);
  });
});

describe('11. a second card on one house and one certificate is refused for Property Administration', () => {
  it('a booking while a card asking the letting agent for the same certificate waits is refused; naming it lands', () => {
    const r = py(`
WAITING[:] = [card("recAskAgentAaaaaa", "COMPLIANCE: 9 Sample Street gas safety check - ask the letting agent for an access day", sender=PROPERTY)]
task("COMPLIANCE: 9 Sample Street gas safety check - book Fixture Gas", holder=PROPERTY)
book = "PASS TO ROY: book Fixture Gas for the gas safety check at 9 Sample Street.\\n\\n**Carrying this out will involve:** Roy books it."
S = "searched the compliance book, the task history and each inbox (info@ and Gmail): no gas certificate held"
out = {"first": submit(book, agent=PROPERTY, certificate_search=S)["err"]}
named = "SAME HOUSE CHECK: recAskAgentAaaaaa is a different job: that card asks the agent for access, this books the engineer\\n" + book
out["named"] = submit(named, agent=PROPERTY, certificate_search=S)["err"]
out["flag"] = submit(book, agent=PROPERTY, certificate_search=S,
                     same_house_check="recAskAgentAaaaaa is a different job: that card asks the agent for access, this books the engineer")["err"]
out["closed"] = submit("CLOSE PROPOSAL: duplicate of recAskAgentAaaaaa\\n\\n**Carrying this out will involve:** this task closes.", agent=PROPERTY)["err"]
out["builder"] = submit(book, agent=BUILDER, certificate_search=S)["err"]
print(json.dumps(out))`);
    expect(r.first).toMatch(/another card on 9 Sample Street and the same certificate \(GSC\) is already waiting on Kevin: recAskAgentAaaaaa/);
    expect(r.first).toMatch(/--same-house-check "recAskAgentAaaaaa is a different job: <why>"/);
    expect(r.named).toBeNull();
    expect(r.flag).toBeNull();
    expect(r.closed).toBeNull();
    expect(r.builder).toBeNull();
  });

  it('two waiting cards on the same house and certificate, both other jobs: one flag each lands, one flag alone names the other', () => {
    const r = py(`
WAITING[:] = [card("recAskAgentAaaaaa", "COMPLIANCE: 9 Sample Street gas safety check - ask the letting agent for an access day", sender=PROPERTY),
              card("recFileCopyAaaaaa", "COMPLIANCE: 9 Sample Street gas safety check - file last year's copy", sender=PROPERTY)]
task("COMPLIANCE: 9 Sample Street gas safety check - book Fixture Gas", holder=PROPERTY)
book = "PASS TO ROY: book Fixture Gas for the gas safety check at 9 Sample Street.\\n\\n**Carrying this out will involve:** Roy books it."
S = "searched the compliance book, the task history and each inbox (info@ and Gmail): no gas certificate held"
one = submit(book, agent=PROPERTY, certificate_search=S, same_house_check=["recAskAgentAaaaaa is a different job: that card asks for access"])
both = submit(book, agent=PROPERTY, certificate_search=S, same_house_check=[
    "recAskAgentAaaaaa is a different job: that card asks the agent for access",
    "recFileCopyAaaaaa is a different job: that card files last year's certificate"])
print(json.dumps({"one": one["err"], "both": both["err"],
                  "stamps": re.findall(r"SAME HOUSE CHECK \\(round \\d+\\): (rec\\w+)", both["notes"])}))`);
    expect(r.one).toMatch(/already waiting on Kevin: recFileCopyAaaaaa/);
    expect(r.both).toBeNull();
    expect(r.stamps).toEqual(['recAskAgentAaaaaa', 'recFileCopyAaaaaa']);
  });

  it('another house, another certificate, a group sibling and a card with no single house are not refused; the last says NOT CHECKED', () => {
    const r = py(`
S = "searched the compliance book, the task history and each inbox (info@ and Gmail): nothing held"
book = "PASS TO ROY: book Fixture Gas for the visit.\\n\\n**Carrying this out will involve:** Roy books it."
def one(waiting, name, notes=""):
    WAITING[:] = waiting
    task(name, holder=PROPERTY, notes=notes)
    res = submit(book, agent=PROPERTY, certificate_search=S)
    return {"err": res["err"], "nc": re.findall(r"NOT CHECKED BY CODE \\(round \\d+\\): [^\\n]*", res["notes"])}
out = {
  "house": one([card("recOtherHouseAaaa", "COMPLIANCE: 7 Example Road gas safety check - ask the agent", sender=PROPERTY)],
               "COMPLIANCE: 9 Sample Street gas safety check - book Fixture Gas"),
  "cert": one([card("recOtherCertAaaaa", "COMPLIANCE: 9 Sample Street EICR - ask the agent", sender=PROPERTY)],
              "COMPLIANCE: 9 Sample Street gas safety check - book Fixture Gas"),
  "sibling": one([card("recSiblingAaaaaaa", "COMPLIANCE: 9 Sample Street gas safety check - ask the agent", sender=PROPERTY,
                       notes="HELD UNDER recTESTTESTTEST01 (GSC TE1)")],
                 "COMPLIANCE: 9 Sample Street gas safety check - book Fixture Gas"),
  "noHouse": one([], "COMPLIANCE: gas safety check due - book Fixture Gas"),
}
print(json.dumps(out))`);
    for (const k of ['house', 'cert', 'sibling', 'noHouse']) expect([k, r[k].err]).toEqual([k, null]);
    expect(r.house.nc).toEqual([]);
    expect(r.noHouse.nc.some((l) => /same-house check: the card is about one certificate \(GSC\) and neither the task name nor its Properties link names a house/.test(l))).toBe(true);
  });
});

describe('12. a certificate quote, chase or booking writes up its search for a certificate we may already hold', () => {
  it('a quote request, a booking, a chase and a Roy booking with no search are refused; the flag or a line outside the email lands', () => {
    const r = py(`
N = "COMPLIANCE: EICR renewal due - 9 Sample Street"
task(N, holder=PROPERTY)
quote = email("Please could you quote for an EICR at 9 Sample Street?", to="jobs@fixture-electrical.test", subject="EICR at 9 Sample Street")
book = email("Please book us in for Friday 4 December at 9am for the EICR at 9 Sample Street.", to="jobs@fixture-electrical.test", subject="EICR booking")
chase = email("Just following up on the EICR quote for 9 Sample Street.", to="jobs@fixture-electrical.test", subject="EICR at 9 Sample Street")
roy = "PASS TO ROY: book the EICR at 9 Sample Street with the cheapest of the three quotes.\\n\\n**Carrying this out will involve:** Roy books it."
S = "searched the compliance book, the task history and each inbox (info@ and Gmail): the last EICR expired in 2025, none since"
NOTICE = "none needed: the house is empty between tenancies"
out = {k: submit(o, type_=t, agent=PROPERTY, tenant_notice=NOTICE)["err"]
       for k, o, t in (("quote", quote, "Correspondence"), ("book", book, "Correspondence"),
                       ("chase", chase, "Correspondence"), ("roy", roy, "Admin"))}
flag = submit(quote, type_="Correspondence", agent=PROPERTY, certificate_search=S)
out["flag"], out["flagStamp"] = flag["err"], re.findall(r"CERTIFICATE SEARCH \\(round \\d+\\): [^\\n]*", flag["notes"])
out["flagInEmail"] = "CERTIFICATE SEARCH" in flag["output"]
out["lineInClose"] = submit(email("Please could you quote for an EICR at 9 Sample Street?", to="jobs@fixture-electrical.test",
                                  subject="EICR at 9 Sample Street", close="one email to the firm. CERTIFICATE SEARCH: " + S),
                            type_="Correspondence", agent=PROPERTY)["err"]
out["lineInRoy"] = submit("CERTIFICATE SEARCH: " + S + "\\n" + roy, agent=PROPERTY, tenant_notice=NOTICE)["err"]
# Above an email's headers is not a place for it: the email parser reads every line there as a header.
try:
    m._gate()   # (loaded already)
    import agent_email_format as aef
    aef.parse_output("CERTIFICATE SEARCH: " + S + "\\n\\n" + quote)
    out["aboveHeaders"] = "parsed"
except Exception as e:
    out["aboveHeaders"] = str(e)[:80]
out["lineInBody"] = submit(email("CERTIFICATE SEARCH: " + S + "\\nPlease could you quote for an EICR at 9 Sample Street?",
                                 to="jobs@fixture-electrical.test", subject="EICR at 9 Sample Street"), type_="Correspondence", agent=PROPERTY)["err"]
out["thin"] = submit(quote, type_="Correspondence", agent=PROPERTY, certificate_search="checked, nothing found anywhere at all")["err"]
print(json.dumps(out))`);
    for (const k of ['quote', 'book', 'chase', 'roy']) {
      expect([k, r[k]]).toEqual([k, expect.stringMatching(/it is a certificate (quote|booking|chase) .* does not say where you searched/)]);
      expect(r[k]).toMatch(/--certificate-search/);
    }
    expect(r.quote).toMatch(/certificate quote/);
    expect(r.book).toMatch(/certificate booking/);
    expect(r.chase).toMatch(/certificate chase/);
    expect(r.flag).toBeNull();
    expect(r.flagStamp[0]).toMatch(/CERTIFICATE SEARCH \(round 1\): searched the compliance book/);
    expect(r.flagInEmail).toBe(false);
    expect(r.lineInClose).toBeNull();
    expect(r.lineInRoy).toBeNull();
    expect(r.aboveHeaders).toMatch(/unsupported header\(s\): CERTIFICATE SEARCH/);   // why the message says the closing line
    expect(r.lineInBody).toMatch(/does not say where you searched/);   // a line in the email would be sent
    expect(r.thin).toMatch(/does not name both the mail and the records it searched/);
  });

  it('insurance, a licence, a close, a thank-you and the engine\'s own filing task are not quote, chase or booking steps', () => {
    const r = py(`
C = lambda name, out, desc="": m.certificate_search_problem(name, out, (m.parse_email_output(out) or {}).get("subject", "") if out.startswith("TO:") else "", desc, None)
thanks = email("Thank you for the certificate.", to="jobs@fixture-electrical.test", subject="EICR at 9 Sample Street")
quote = email("Please could you quote for the work?", to="jobs@fixture-electrical.test", subject="Quote request")
print(json.dumps({
  "insurance": C("COMPLIANCE: landlord insurance - 9 Sample Street", quote),
  "licence": C("COMPLIANCE: HMO licence - 9 Sample Street", quote),
  "notCompliance": C("INBOUND: EICR question - 9 Sample Street", quote),
  "close": C("COMPLIANCE: EICR renewal due - 9 Sample Street", "CLOSE PROPOSAL: duplicate of recAaaaaaaaaaaaaa\\n\\n**Carrying this out will involve:** closes."),
  "thanks": C("COMPLIANCE: EICR renewal due - 9 Sample Street", thanks),
  "filing": C("COMPLIANCE: file the certificate paid for - 9 Sample Street", quote, desc=m.certificate_watch.FILING_TASK_MARK),
}))`);
    expect(r).toEqual({ insurance: '', licence: '', notCompliance: '', close: '', thanks: '', filing: '' });
  });
});

describe('an AGENT RENT LATE card rewritten for its unpaid units declares each paid unit with --rent-received', () => {
  it('each flag is stamped on Notes in the shape the send reads, once per unit', () => {
    const r = py(`
task("AGENT RENT LATE: Fixture Lettings, 3 units, rent due (first email)")
res = submit("A report for the card.\\n\\n**Carrying this out will involve:** a note goes on the task.",
             rent_received=["recUnitTwoAaaaaaa: recPayUnitTwoAaaa", "recUnitOneAaaaaaa: recPayUnitOneAaaa"])
print(json.dumps({"err": res["err"], "stamps": re.findall(r"RENT RECEIVED \\(round \\d+\\): [^\\n]*", res["notes"]),
                  "read": sorted(m.RENT_RECEIVED_RE.findall(res["notes"]))}))`);
    expect(r.err).toBeNull();
    expect(r.stamps).toEqual(['RENT RECEIVED (round 1): recUnitTwoAaaaaaa: recPayUnitTwoAaaa', 'RENT RECEIVED (round 1): recUnitOneAaaaaaa: recPayUnitOneAaaa']);
    expect(r.read).toEqual(['recUnitOneAaaaaaa', 'recUnitTwoAaaaaaa']);
  });
});
