import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// RULES THE ROBOTS KEPT BREAKING ARE REFUSALS AT SUBMIT (Kevin, "Do it now", 16 Nov 2026).
// The estate review of 13 Nov 2026 found 21 of 32 testable lessons broken again after they were
// written. Each rule here is a lesson row the review sorted as CODE, back-tested on the 1,862 stored
// Agent Outputs before it was built:
//   inbound-comms-response 3 Sep  a bill reaches Kevin only after a paid check (the bank and a PAID CHECK line)
//   inbound-comms-response 30 Sep and property-administration 25 Sep  never renew insurance; TopCashback
//   inbound-comms-response 29 Oct  a booked contractor visit says how the tenants are told
//   cash-flow-voids 30 Oct  check the bank again before a RENT LATE card
//   creditor-management 3 Oct  a cost that changes is written on the same card
//   property-administration 4 Sep  bedrooms come from the Properties table
//   property-administration 24 Sep  no licence fee or application without in-date EICR and gas certificates
//   property-administration 19 Oct  a house Rob Jackson's agency manages is not ours to certify
//
// The real cmd_submit runs with Airtable swapped for in-memory fixtures. Every network door raises
// (urlopen, socket connect, create_connection). Names, addresses, amounts and ids are invented.

const PRE = `
import importlib.util, json, os, io, sys, contextlib, types, tempfile, socket, urllib.request
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
TODAY = datetime.now(m.LONDON).date()
def day(n): return (TODAY + timedelta(days=n)).isoformat()
CREATED = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
BUILDER = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
CREDITOR = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "creditor-management"][0]
PROPS = [
    {"id": "recPropOneAaaaaaa", "name": "7 Example Road, Testville TE1 1AA", "short": "7 Example Road", "kind": "HMO",
     "manager": "Property Portfolio", "required": ["Landlord Insurance", "EICR", "EPC", "GSC"], "bedrooms": 2, "units": []},
    {"id": "recPropTwoAaaaaaa", "name": "9 Sample Street, Testville TE1 2BB", "short": "9 Sample Street", "kind": "Single Let",
     "manager": "Property Portfolio", "required": ["Landlord Insurance", "EICR", "EPC", "GSC"], "bedrooms": 4, "units": []},
    {"id": "recPropRocAaaaaaa", "name": "11 Test Lane, Testville TE1 3CC", "short": "11 Test Lane", "kind": "Single Let",
     "manager": "Roc Immo", "required": ["Landlord Insurance", "EICR", "EPC"], "bedrooms": 3, "units": []},
    {"id": "recPropBlockAaaaa", "name": "Fixture Building, Testville TE1 4DD", "short": "Fixture Building", "kind": "Block",
     "manager": "Property Portfolio", "required": ["Landlord Insurance", "EICR", "EPC"], "bedrooms": 13, "units": []},
]
def cert(pid, typ, renewal, status="In Date"):
    return {"id": "rec" + (pid[3:9] + typ + renewal.replace("-", ""))[:14].ljust(14, "a"), "type": typ, "propertyIds": [pid],
            "unitIds": [], "status": status, "renewalDate": renewal, "hasFile": True, "taskIds": [], "created": "2026-01-01"}
CERTS = [cert("recPropOneAaaaaaa", "EICR", "2026-01-01", "Expired"),
         cert("recPropTwoAaaaaaa", "EICR", day(900)), cert("recPropTwoAaaaaaa", "GSC", day(200))]
m.fetch_properties = lambda refresh=False: PROPS
m.fetch_certificates = lambda refresh=False: CERTS
BANK = []
BANK_CALLS = []
def bank(since):
    BANK_CALLS.append(since)
    return [b for b in BANK if b["date"] > since]
m.fetch_bank_lines = bank
TENANCIES = {"recTenancyAaaaaaa": 500.0}
def records(table, formula=None, fields=None, max_records=None):
    if table == m.TENANCIES_TABLE:
        tid = formula.split("'")[1]
        return [{"id": tid, "fields": {m.RENT_FIELD: TENANCIES[tid]}}] if tid in TENANCIES else []
    raise RuntimeError("no fixture for a read of " + table)
m.query_records = records
m.require_role_agent_live = lambda *a, **k: None
m.ledger_append = lambda *a, **k: None
m.ledger_last_events = lambda: {}
m.finding_details = lambda: {}
m.task_fields_owe_certificate = lambda *a, **k: []
m.task_owes_cost = lambda *a, **k: []
m.history = lambda **kw: {"terms": ["x"], "searched": ["tasks", "Gmail"], "entries": [], "notes": []}
TASK = {}
def task(name, notes="", desc="", created=CREATED):
    TASK.clear()
    TASK.update({"id": "recTESTTESTTEST01", "createdTime": created,
                 "fields": {AF["name"]: name, AF["status"]: {"name": "Today"}, AF["teamMember"]: [BUILDER],
                            AF["notes"]: notes, AF["description"]: desc}})
m.get_task = lambda i: json.loads(json.dumps(TASK))
CAPTURED = {}
def patch(i, f):
    CAPTURED.update(f); TASK["fields"].update(f)
    return {"id": i}
m.patch_task = patch
def submit(output, agent=None, type_="Admin", plain_approve="The card closes and the agent records it.",
           plain_task="A bill or a booking came in for one of the houses.", tenant_notice="", tier1=False):
    CAPTURED.clear(); BANK_CALLS.clear()
    fh = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False); fh.write(output); fh.close()
    err = None
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            m.cmd_submit(types.SimpleNamespace(task="recTESTTESTTEST01", agent=agent or BUILDER, type=type_,
                         output_file=fh.name, tier1=tier1, attach=None, plain_task=plain_task,
                         plain_approve=plain_approve, tenant_notice=tenant_notice))
    except SystemExit as e:
        err = str(e)
    st = CAPTURED.get(AF["status"])
    return {"err": err, "status": st if isinstance(st, str) else (st or {}).get("name") if st else None,
            "bankCalls": len(BANK_CALLS), "notes": CAPTURED.get(AF["notes"], "")}
def email(body, to="bookings@fixture-trade.test", subject="Your visit"):
    return (f"TO: {to}\\nFROM: info@agilelets.co.uk\\nSUBJECT: {subject}\\n---\\n{body}\\n\\nKind regards\\nRoy Lavin\\nAgile Lets\\n\\n"
            "**Carrying this out will involve:** one email from the Agile Lets inbox to the firm.")
`;

function py(snippet) {
  const out = execFileSync('python3', ['-c', PRE + snippet], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json'), SIGNIN_SKIP_WALK: '1',
           AGENT_RUN_QUEUE: '' },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const CARD = (extra = '') => `MARK FOR PAYMENT: Fixture Plumbing invoice 4411, boiler repair at 7 Example Road
PAYEE: Fixture Plumbing Ltd
AMOUNT: £90.00
REFERENCE: 4411
DUE DATE: ${'${day(10)}'}
${extra}
**Carrying this out will involve:** the £90 bill goes on the Friday payment list.`;

describe('the paid check: a bill reaches Kevin only after the bank, and the agent, have looked', () => {
  it('a bill the bank already shows paid is refused, naming the payment; a different payment is passed only when named', () => {
    const r = py(`
task("INBOUND: pay Fixture Plumbing invoice 4411 GBP 90 - 7 Example Road")
BANK.extend([{"id": "recBankPaidAaaaaa", "date": day(-2), "amount": -90.0, "name": "FIXTURE PLUMBING LTD 7 EXAMPLE", "tenancyIds": []},
             {"id": "recBankOtherAaaaa", "date": day(-1), "amount": -90.0, "name": "Somebody Else Ltd", "tenancyIds": []},
             {"id": "recBankInAaaaaaaa", "date": day(-3), "amount": 90.0, "name": "FIXTURE PLUMBING REFUND", "tenancyIds": []}])   # money in BEFORE the payment: it returns nothing
paid = submit(${JSON.stringify(CARD('PAID CHECK: none found (searched the bank and Gmail this week)'))}.replace("\${day(10)}", day(10)))
named = submit(${JSON.stringify(CARD('PAID CHECK: not this bill: recBankPaidAaaaaa (that was the March call-out, invoice 4102)'))}.replace("\${day(10)}", day(10)))
print(json.dumps({"paid": paid, "named": named}))`);
    expect(r.paid.err).toMatch(/refusing to submit recTESTTESTTEST01: the bank already shows 1 payment\(s\) that match this bill \(£90\.00/);
    expect(r.paid.err).toMatch(/recBankPaidAaaaaa/);
    expect(r.paid.err).not.toMatch(/recBankOtherAaaaa|recBankInAaaaaaaa/);   // another payee, money in: not this bill
    expect(r.paid.err).toMatch(/PAID CHECK: not this bill: 1 payments from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} \(<why they are other payments>\)/);
    expect(r.paid.status).toBeNull();
    expect(r.named.err).toBeNull();
    expect(r.named.status).toBe('Approval');
  });

  it("with no match in the bank the card still needs the agent's PAID CHECK line, and lands with it", () => {
    const r = py(`
task("INBOUND: pay Fixture Plumbing invoice 4411 GBP 90 - 7 Example Road")
BANK.extend([{"id": "recBankOldAaaaaaa", "date": day(-40), "amount": -90.0, "name": "FIXTURE PLUMBING LTD", "tenancyIds": []},
             {"id": "recBankCoffeeAaaa", "date": day(-1), "amount": -4.5, "name": "Sample Cafe", "tenancyIds": []}])
bare = submit(${JSON.stringify(CARD())}.replace("\${day(10)}", day(10)))
lined = submit(${JSON.stringify(CARD('PAID CHECK: none found (searched the bank, Gmail and the other Fixture Plumbing tasks since 1 Nov)'))}.replace("\${day(10)}", day(10)))
# A PAY: task's email to the supplier is a question, not a card that lists the bill: never checked, never
# asked for the line (it would be sent to the supplier).
task("PAY: Fixture Lettings 376 GBP in advance - Flat 1 Fixture Building")
asked = submit(email("Could you take the £376 from the rent for another flat instead?", to="office@fixture-lettings.test"), type_="Correspondence")
print(json.dumps({"bare": bare, "lined": lined, "asked": asked, "since": (TODAY - timedelta(days=3 + 14)).isoformat()}))`);
    expect(r.bare.err).toMatch(/it lists a bill to pay \(£90\.00\) with no PAID CHECK line\. Code searched the bank from /);
    expect(r.bare.err).toContain(`from ${r.since}`);
    expect(r.bare.err).toMatch(/PAID CHECK: none found \(searched/);
    expect(r.lined.err).toBeNull();
    expect(r.lined.status).toBe('Approval');
    expect(r.lined.bankCalls).toBe(1);
    expect(r.asked.bankCalls).toBe(0);
    expect(String(r.asked.err)).not.toMatch(/PAID CHECK|bank/);
  });

  it('a bank read that returns nothing, or fails, is NOT CHECKED and refused; an amount code cannot read needs the line', () => {
    const r = py(`
task("INBOUND: pay Fixture Plumbing invoice 4411 GBP 90 - 7 Example Road")
empty = submit(${JSON.stringify(CARD('PAID CHECK: none found (searched the bank)'))}.replace("\${day(10)}", day(10)))
def broken(since): raise RuntimeError("HTTP 503")
m.fetch_bank_lines = broken
failed = submit(${JSON.stringify(CARD('PAID CHECK: none found (searched the bank)'))}.replace("\${day(10)}", day(10)))
m.fetch_bank_lines = bank
noamount = submit("MARK FOR PAYMENT: a speeding fine, EUR 45 reduced rate\\nPAYEE: Fixture Fines Agency\\n\\n**Carrying this out will involve:** the fine goes on the Friday payment list.")
print(json.dumps({"empty": empty, "failed": failed, "noamount": noamount}))`);
    expect(r.empty.err).toMatch(/the bank read returned no lines at all since .*NOT CHECKED/);
    expect(r.failed.err).toMatch(/the bank lines could not be read .*HTTP 503.*NOT CHECKED/);
    expect(r.noamount.err).toMatch(/code cannot read its amount, so the bank was NOT CHECKED by code/);
  });

});

describe('never renew insurance: a fresh quote through TopCashback, or the reason there is none', () => {
  it('telling the insurer to renew is refused; the TopCashback reason or quotes let it through; asking to confirm a renewal date is not renewing', () => {
    const r = py(`
task("INSURANCE: buildings cover renewal - 9 Sample Street")
mail = lambda close: ("TO: renewals@fixture-insure.test\\nFROM: info@agilelets.co.uk\\nSUBJECT: Policy FX-1\\n---\\nPlease see below.\\n\\n"
                      "Kind regards\\nRoy Lavin\\nAgile Lets\\n\\n**Carrying this out will involve:** " + close)
renew = submit(mail("this email goes to the insurer telling them to renew the insurance on 9 Sample Street from 1 December."), type_="Correspondence")
accept = submit(mail("the agent signs the renewal and its finance agreement with the insurer."), type_="Correspondence")
reason = m.renewal_problem("INSURANCE: buildings cover renewal - 9 Sample Street",
    mail("this email tells the insurer to renew the insurance. NO TOPCASHBACK QUOTE: four insurers through TopCashback each stopped at a page only Kevin can answer."), "")
quotes = m.renewal_problem("INSURANCE: buildings cover renewal - 9 Sample Street",
    "TOPCASHBACK QUOTE: Fixture Mutual £412 net\\nTOPCASHBACK QUOTE: Sample Cover £455 net\\n\\n**Carrying this out will involve:** renews the policy with the current insurer, the cheapest.", "")
confirm = m.renewal_problem("INSURANCE: buildings cover renewal - 9 Sample Street", mail("this email asks the insurer to confirm the renewal date and premium."), "")
notrenew = m.renewal_problem("INSURANCE: buildings cover renewal - 9 Sample Street", mail("this email asks them not to renew and to refund the payment."), "")
other = m.renewal_problem("COMPLIANCE: EICR renewal due - 9 Sample Street", mail("this email tells them to renew the insurance."), "")
print(json.dumps({"renew": renew, "accept": accept, "reason": reason, "quotes": quotes, "confirm": confirm, "notrenew": notrenew, "other": other}))`);
    expect(r.renew.err).toMatch(/renews an insurance policy or signs its renewal .*never renew an existing policy.*NO TOPCASHBACK QUOTE: <what stopped the quotes>/);
    expect(r.accept.err).toMatch(/renews an insurance policy or signs its renewal/);
    expect(r.reason).toBe('');
    expect(r.quotes).toBe('');
    expect(r.confirm).toBe('');
    expect(r.notrenew).toBe('');
    expect(r.other).toBe('');      // not the insurance lane by its name
  });
});

describe('a booked contractor visit says how the tenants are told', () => {
  it('a booking email with no --tenant-notice is refused; a notice with the date passes; inside 24 hours it is a text; an empty house says so', () => {
    const r = py(`
NAME = "COMPLIANCE: EICR renewal due - 9 Sample Street"
task(NAME)
book = email("Thank you for the dates. Please book us in for Thursday 26 November at 9am for the EICR at 9 Sample Street.")
bare = submit(book, type_="Correspondence")
dated = m.tenant_notice_problem(NAME, book, "Correspondence", day(10) + ": every tenant by text and email from info@ two days before")
soon = m.tenant_notice_problem(NAME, book, "Correspondence", day(1) + ": every tenant by email this afternoon")
soon_text = m.tenant_notice_problem(NAME, book, "Correspondence", day(1) + ": every tenant by ClickSend text now and email")
empty = m.tenant_notice_problem(NAME, book, "Correspondence", "none needed: the house is empty until the new tenants move in")
nodate = m.tenant_notice_problem(NAME, book, "Correspondence", "the tenants will be told")
cancel = m.tenant_notice_problem(NAME, email("Please cancel the visit booked for Thursday 26 November."), "Correspondence", "")
asking = m.tenant_notice_problem(NAME, email("Could you send two or three dates that suit you next week?"), "Correspondence", "")
print(json.dumps({"bare": bare, "dated": dated, "soon": soon, "soonText": soon_text, "empty": empty, "nodate": nodate,
                  "cancel": cancel, "asking": asking}))`);
    expect(r.bare.err).toMatch(/it books a contractor visit \("Please book us in for Thursday 26 November/);
    expect(r.bare.err).toMatch(/--tenant-notice "<visit date>: <who is told and how/);
    expect(r.dated).toBe('');
    expect(r.soon).toMatch(/within 24 hours, so the tenants are told by a ClickSend text/);
    expect(r.soonText).toBe('');
    expect(r.empty).toBe('');
    expect(r.nodate).toMatch(/names no visit date/);
    expect(r.cancel).toBe('');
    expect(r.asking).toBe('');
  });

  it('the notice is stamped on the task with the card, never put in the email', () => {
    const r = py(`
task("COMPLIANCE: EICR renewal due - 9 Sample Street")
m.track_record_problem = lambda *a, **k: ""
m.validate_any_submission = lambda *a, **k: None
m.coverage_problem = lambda *a, **k: ""
book = email("Please book us in for Thursday 26 November at 9am for the EICR at 9 Sample Street.")
out = submit(book, type_="Correspondence", tenant_notice=day(10) + ": every tenant by text and email from info@ two days before")
print(json.dumps(out))`);
    expect(r.err).toBeNull();
    expect(r.status).toBe('Approval');
    expect(r.notes).toMatch(/— agent-dispatch\] TENANT NOTICE \(round 1\): \d{4}-\d{2}-\d{2}: every tenant by text and email from info@ two days before/);
  });
});

describe('check the bank again before a RENT LATE card', () => {
  it('rent matched to the tenancy for the owed cycle refuses the card; a part payment, a bounced one or the next month\'s does not; an information-only filing never reads the bank', () => {
    const r = py(`
KEY = "RENT CHECK KEY: recTenancyAaaaaaa:" + day(-6) + ":1"
NAME = "RENT LATE: Unit 1 - 7 Example Road, rent due 10 Nov (reminder)"
draft = email("Hello, your rent due last week has not reached us yet. Could you let us know when it will be paid?", to="tenant@example.test", subject="Rent")
task(NAME, notes=KEY)
BANK.append({"id": "recRentInAaaaaaaa", "date": day(-1), "amount": 500.0, "name": "FASTER PAYMENTS RECEIPT", "tenancyIds": ["recTenancyAaaaaaa"]})
paid = submit(draft, type_="Correspondence")
BANK.clear(); BANK.append({"id": "recRentPartAaaaaa", "date": day(-1), "amount": 200.0, "name": "FASTER PAYMENTS RECEIPT", "tenancyIds": ["recTenancyAaaaaaa"]})
part = m.rent_paid_problem(NAME, KEY, "")
BANK.clear(); BANK.extend([{"id": "recRentBackInAaaa", "date": day(-3), "amount": 500.0, "name": "FASTER PAYMENTS RECEIPT", "tenancyIds": ["recTenancyAaaaaaa"]},
                           {"id": "recRentBackOutAaa", "date": day(-2), "amount": -500.0, "name": "RETURNED PAYMENT", "tenancyIds": ["recTenancyAaaaaaa"]},
                           {"id": "recRentElseAaaaaa", "date": day(-1), "amount": 500.0, "name": "FASTER PAYMENTS RECEIPT", "tenancyIds": ["recTenancyBbbbbbb"]}])
bounced = m.rent_paid_problem(NAME, KEY, "")
BANK.clear(); BANK.append({"id": "recRentNextAaaaaa", "date": day(30), "amount": 500.0, "name": "FASTER PAYMENTS RECEIPT", "tenancyIds": ["recTenancyAaaaaaa"]})
next_cycle = m.rent_paid_problem(NAME, KEY, "")
other = m.rent_paid_problem(NAME.replace("RENT LATE", "RENT PLAN"), KEY, "")
m.fetch_bank_lines = lambda since: (_ for _ in ()).throw(AssertionError("the bank must not be read"))
info = submit("The rent arrived this morning: £500 on the tenancy.\\n\\n**Carrying this out will involve:** Nothing. Information only.", type_="Analysis")
print(json.dumps({"paid": paid, "part": part, "bounced": bounced, "nextCycle": next_cycle, "other": other, "info": info}))`);
    expect(r.paid.err).toMatch(/the rent for the cycle due .* has arrived since the check ran: .*£500\.00 \(recRentInAaaaaaaa\).*Nothing\. Information only\./);
    expect(r.part).toBe('');
    expect(r.bounced).toBe('');      // paid in, sent back out, and another tenancy's rent: the owed cycle is not paid
    expect(r.nextCycle).toBe('');    // next month's rent does not pay this month's
    expect(r.other).toBe('');
    expect(r.info.err).toBeNull();
    expect(r.info.status).toBe('Completed');
  });
});

describe('a cost that changes is written on the same card', () => {
  it('a fixed-cost card that changes the cost record with no RECORD line is refused; with the line, or the reason none is owed, it lands', () => {
    const r = py(`
task("FIXED COST: Fixture Software billing rise - check the seat count")
close = "**Carrying this out will involve:** The Fixture Software monthly cost in your cost list changes from £40.11 to £50.51, to match the bill."
bare = submit("Fixture Software now bills £50.51 a month.\\n\\n" + close)
lined = submit("Fixture Software now bills £50.51 a month.\\n\\nRECORD CHANGE: recCostFixtureAaa Expected Cost = 50.51\\n\\n" + close)
none = submit("Fixture Software now bills £50.51 a month.\\n\\n" + close + " NO COST CHANGE: the rise was refunded the same day.")
already = m.cost_line_problem(False, "FIXED COST: x", "**Carrying this out will involve:** This task closes because the payments are already in your costs list.", "")
tasks_line = m.cost_line_problem(False, "FIXED COST: x", "Report.\\n\\n**Carrying this out will involve:** nothing new.", "TASK: Check the fixed costs for rises.")
task("INBOUND: Fixture Energy direct debit review")
creditor = submit("CHECKED: handled=no; roy=no; machine=no; open-task=no; trigger=money\\n\\n" + close, agent=CREDITOR)
print(json.dumps({"bare": bare, "lined": lined, "none": none, "already": already, "tasks": tasks_line, "creditor": creditor}))`);
    expect(r.bare.err).toMatch(/it says the cost record changes \("The Fixture Software monthly cost in your cost list changes from £40\.11 to £50\.51/);
    expect(r.bare.err).toMatch(/RECORD CHANGE: <cost id> <field> = <value>/);
    expect(r.lined.err).toBeNull();
    expect(r.lined.status).toBe('Approval');
    expect(r.none.err).toBeNull();
    expect(r.already).toBe('');
    expect(r.tasks).toBe('');
    expect(r.creditor.err).toMatch(/it says the cost record changes/);      // the creditor agent's card, whatever its name
  });
});

describe('bedrooms come from the Properties table', () => {
  it('a count that differs from the table is refused, naming both; each house is judged by the count beside it; a block, a unit number and a quote are not statements', () => {
    const r = py(`
NAME = "COMPLIANCE: fire alarm quote - 7 Example Road"
task(NAME)
wrong = submit(email("It is a three-bedroom shared house let as three rooms, at 7 Example Road.", subject="Fire alarm quote"), type_="Correspondence")
two = m.bedroom_problem(NAME, email("1. 7 Example Road (2-bedroom house)\\n2. 9 Sample Street (4-bedroom house)"))
unit = m.bedroom_problem(NAME, email("A separate reply for 7 Example Road needs the Unit 3 bedroom count first."))
block = m.bedroom_problem("COMPLIANCE: EPC - Fixture Building", email("Flat 2 at Fixture Building is a 2-bedroom flat."))
quoted = m.bedroom_problem(NAME, email('Changed from the last draft: "3 bedrooms" removed for 7 Example Road.'))
right = m.bedroom_problem(NAME, email("7 Example Road is a two-bedroom house."))
print(json.dumps({"wrong": wrong, "two": two, "unit": unit, "block": block, "quoted": quoted, "right": right}))`);
    expect(r.wrong.err).toMatch(/its email gives 7 Example Road 3 bedroom\(s\) \("three-bedroom shared house"\), but the Properties table says 2 \(No\. of Bedrooms\)/);
    expect(r.two).toBe('');
    expect(r.unit).toBe('');
    expect(r.block).toBe('');
    expect(r.quoted).toBe('');
    expect(r.right).toBe('');
  });
});

describe('no licence fee or application without in-date EICR and gas certificates', () => {
  it('a licence fee for a house with an expired EICR is refused; a house with both in date passes; "once the certificates are done" is not paying', () => {
    const r = py(`
task("COMPLIANCE: HMO licence fee - 7 Example Road")
spend = submit("The council's licence fee is £150.\\nSPEND: £150\\n\\n**Carrying this out will involve:** the agent submits the licence application on the council portal.")
good = m.licence_cert_problem("COMPLIANCE: HMO licence fee - 9 Sample Street", "SPEND: £150\\n\\n**Carrying this out will involve:** the agent submits the licence application.", "")
later = m.licence_cert_problem("COMPLIANCE: HMO licence fee - 7 Example Road",
    "**Carrying this out will involve:** the agent gets gas and electrical quotes through Roy. The licence fee comes back to you once the certificates are done.", "")
zero = m.licence_cert_problem("COMPLIANCE: HMO licence missing - 7 Example Road", "SPEND: £0\\n\\n**Carrying this out will involve:** the task closes with a note.", "")
cert_task = m.licence_cert_problem("COMPLIANCE: EICR needed for the licence - 7 Example Road", "SPEND: £180\\n\\n**Carrying this out will involve:** the EICR is booked.", "")
print(json.dumps({"spend": spend, "good": good, "later": later, "zero": zero, "certTask": cert_task}))`);
    expect(r.spend.err).toMatch(/it pays a licence fee or puts a licence application in for 7 Example Road, and the book holds no in-date EICR or GSC for it/);
    expect(r.good).toBe('');
    expect(r.later).toBe('');
    expect(r.zero).toBe('');
    expect(r.certTask).toBe('');     // buying the certificate itself is the remedy, never refused here
  });
});

describe("a house Rob Jackson's agency manages is not ours to certify", () => {
  it('a booking at such a house is refused with "ask the managing agent"; a self-managed house and its insurance are not', () => {
    const r = py(`
task("COMPLIANCE: GSC renewal due 2026-12-01 - 11 Test Lane")
roc = submit("PASS TO ROY: book the gas safety check at 11 Test Lane.\\n\\n**Carrying this out will involve:** Roy books the gas safety check.")
own = m.managed_compliance_problem("COMPLIANCE: GSC renewal due 2026-12-01 - 9 Sample Street", "PASS TO ROY: book it.", "")
ins = m.managed_compliance_problem("COMPLIANCE: Landlord Insurance renewal - 11 Test Lane", "PASS TO ROY: insure it.", "")
asking = m.managed_compliance_problem("COMPLIANCE: GSC renewal due 2026-12-01 - 11 Test Lane", "Email to the agent.", "Latest gas certificate please")
print(json.dumps({"roc": roc, "own": own, "ins": ins, "asking": asking}))`);
    expect(r.roc.err).toMatch(/11 Test Lane is managed by Roc Immo, who arranges all its compliance .*send the managing agent an email asking for the latest copy/);
    expect(r.own).toBe('');
    expect(r.ins).toBe('');
    expect(r.asking).toBe('');
  });
});

describe('a check that cannot run refuses, never passes', () => {
  it('a property read that fails mid-check is NOT CHECKED and refused', () => {
    const r = py(`
task("COMPLIANCE: fire alarm quote - 7 Example Road")
def down(refresh=False): raise RuntimeError("HTTP 502")
m.fetch_properties = down
out = submit(email("It is a three-bedroom shared house, at 7 Example Road."), type_="Correspondence")
print(json.dumps(out))`);
    expect(r.err).toMatch(/a submit check could not run \(RuntimeError: HTTP 502\), so it is NOT CHECKED/);
  });
});

// ─── THE REVIEW OF PR 950 (16 Nov 2026) ───────────────────────────────────────────────────────────
// R1: every refusal names a way through, and doing exactly what the message says gets through.
// R2: every check reads the agent's own words (the tier-1 banner taken off first).
// R3: the paid check never demands more than it lists (every match shown; one line may cover them all).
// R5: a check that would refuse correct work is narrowed (bedroom sizes, the licence application, the
//     rent cycle, Kevin's own words on a managed house).

const TABLE_PRE = `
import re
# The later gates that are not these rules' business (the track record, the email shape, the coverage
# file) are passed here, so "gets through" means the card is written.
m.track_record_problem = lambda *a, **k: ""
m.validate_any_submission = lambda *a, **k: None
m.coverage_problem = lambda *a, **k: ""
m.checked_problem = lambda *a, **k: ""
def ok(res):
    return res["err"] is None and res["status"] in ("Approval", "Completed")
def fill(template, why="the earlier payments were last month's"):
    return re.sub(r"<[^>]+>", why, template)
`;

describe('R1. every new refusal names a way through, and doing exactly what it says gets through', () => {
  it("applies each refusal's own instruction and the next submit lands", () => {
    const r = py(TABLE_PRE + `
out = {}
FIXNAME = "INBOUND: pay Fixture Plumbing invoice 4411 GBP 90 - 7 Example Road"
def card(extra=""):
    return ("MARK FOR PAYMENT: Fixture Plumbing invoice 4411\\nPAYEE: Fixture Plumbing Ltd\\nAMOUNT: £90.00\\n" + extra +
            "\\n\\n**Carrying this out will involve:** the £90 bill goes on the Friday payment list.")
# 1. paid, no line: the message gives the line to add
task(FIXNAME); BANK[:] = [{"id": "recBankCafeAaaaaa", "date": day(-1), "amount": -4.5, "name": "Sample Cafe", "tenancyIds": []}]
e = submit(card())["err"]; line = re.search(r"PAID CHECK: none found \\(searched [^)]*\\)", e).group(0)
out["paidNoLine"] = [bool(e), ok(submit(card(fill(line, "the bank and Gmail this week"))))]
# 2. paid, a match that is another bill: the count line the message gives
BANK[:] = [{"id": "recBankOtherAaaaa", "date": day(-2), "amount": -90.0, "name": "FIXTURE PLUMBING LTD", "tenancyIds": []}]
e = submit(card("PAID CHECK: none found (searched the bank)"))["err"]
line = re.search(r"PAID CHECK: not this bill: \\d+ payments from \\S+ to \\S+ \\(<[^>]+>\\)", e).group(0)
out["paidOther"] = [bool(e), ok(submit(card(fill(line))))]
# 3. paid, the match IS this bill: take the block off and file it as information only
done = "The bank shows £90 paid to Fixture Plumbing (recBankOtherAaaaa): the bill is paid.\\n\\n**Carrying this out will involve:** Nothing. Information only."
out["paidThisBill"] = [ "file the task as information only" in e, ok(submit(done, type_="Analysis"))]
# 4. paid, no readable amount
e = submit("MARK FOR PAYMENT: a fine, EUR 45\\nPAYEE: Fixture Fines\\n\\n**Carrying this out will involve:** it goes on the Friday payment list.")["err"]
line = re.search(r"PAID CHECK: none found \\(searched [^)]*\\)", e).group(0)
out["paidNoAmount"] = [bool(e), ok(submit("MARK FOR PAYMENT: a fine, EUR 45\\nPAYEE: Fixture Fines\\n" + fill(line, "the bank and Gmail") + "\\n\\n**Carrying this out will involve:** it goes on the Friday payment list."))]
# 5. paid, the bank read came back empty: try again once it reads
BANK[:] = []
e = submit(card("PAID CHECK: none found (searched the bank)"))["err"]
BANK[:] = [{"id": "recBankCafeAaaaaa", "date": day(-1), "amount": -4.5, "name": "Sample Cafe", "tenancyIds": []}]
out["paidEmpty"] = ["Try again" in e, ok(submit(card("PAID CHECK: none found (searched the bank)")))]
# 6. renewal: the reason line, in the closing line of an email card
task("INSURANCE: buildings cover renewal - 9 Sample Street")
mail = lambda close: ("TO: renewals@fixture-insure.test\\nFROM: info@agilelets.co.uk\\nSUBJECT: Policy FX-1\\n---\\nPlease see below.\\n\\n"
                      "Kind regards\\nRoy Lavin\\nAgile Lets\\n\\n**Carrying this out will involve:** " + close)
e = submit(mail("this email tells the insurer to renew the insurance on 9 Sample Street."), type_="Correspondence")["err"]
line = re.search(r"NO TOPCASHBACK QUOTE: <[^>]+>", e).group(0)
out["renewal"] = [bool(e), ok(submit(mail("this email tells the insurer to renew the insurance on 9 Sample Street. " + fill(line, "the three TopCashback insurers that cover this house refused an online quote for a flat over a shop")), type_="Correspondence"))]
# 7. tenant notice: no flag, then a past date, then inside 24 hours without a text
task("COMPLIANCE: EICR renewal due - 9 Sample Street")
book = email("Please book us in for Thursday 26 November at 9am for the EICR at 9 Sample Street.")
e = submit(book, type_="Correspondence")["err"]
out["noticeNone"] = [ "--tenant-notice" in e, ok(submit(book, type_="Correspondence", tenant_notice=day(10) + ": every tenant by text and email from info@"))]
e = submit(book, type_="Correspondence", tenant_notice=day(-2) + ": tenants told")["err"]
out["noticePast"] = ["already past" in e, ok(submit(book, type_="Correspondence", tenant_notice=day(10) + ": every tenant by text and email"))]
e = submit(book, type_="Correspondence", tenant_notice=day(1) + ": every tenant by email")["err"]
out["noticeSoon"] = ["ClickSend text" in e, ok(submit(book, type_="Correspondence", tenant_notice=day(1) + ": every tenant by ClickSend text and email"))]
e = submit(book, type_="Correspondence", tenant_notice="the tenants will be told")["err"]
out["noticeNoDate"] = ["names no visit date" in e, ok(submit(book, type_="Correspondence", tenant_notice="none needed: empty"))]
# 8. rent arrived: file it as information only
task("RENT LATE: Unit 1 - 7 Example Road, rent due (reminder)", notes="RENT CHECK KEY: recTenancyAaaaaaa:" + day(-6) + ":1")
BANK[:] = [{"id": "recRentInAaaaaaaa", "date": day(-1), "amount": 500.0, "name": "RECEIPT", "tenancyIds": ["recTenancyAaaaaaa"]}]
e = submit(email("Your rent has not reached us.", to="tenant@example.test", subject="Rent"), type_="Correspondence")["err"]
close = re.search(r"\\*\\*Carrying this out will involve:\\*\\* Nothing\\. Information only", e).group(0)
out["rent"] = [bool(e), ok(submit("The rent arrived: £500 (recRentInAaaaaaaa).\\n\\n" + close + ".", type_="Analysis"))]
# 9. cost line: the RECORD line, or the reason none is owed
task("FIXED COST: Fixture Software billing rise")
cl = "**Carrying this out will involve:** The Fixture Software cost in your cost list changes from £40.11 to £50.51."
e = submit("Billing rose.\\n\\n" + cl)["err"]
out["costRecord"] = ["RECORD CHANGE: <cost id>" in e, ok(submit("Billing rose.\\n\\nRECORD CHANGE: recCostFixtureAaa Expected Cost = 50.51\\n\\n" + cl))]
out["costNone"] = ["NO COST CHANGE: <why>" in e, ok(submit("Billing rose.\\n\\n" + cl + " " + fill("NO COST CHANGE: <why>", "the rise was refunded")))]
# 10. bedrooms: use the table's number, or reword
task("COMPLIANCE: fire alarm quote - 7 Example Road")
e = submit(email("It is a three-bedroom shared house let as three rooms, at 7 Example Road."), type_="Correspondence")["err"]
n = re.search(r"the Properties table says (\\d+)", e).group(1)
out["bedTable"] = [bool(e), ok(submit(email("It is a " + n + "-bedroom shared house let as three rooms, at 7 Example Road."), type_="Correspondence"))]
out["bedReword"] = ["reword it" in e, ok(submit(email("It is a shared house with three rooms let, at 7 Example Road."), type_="Correspondence"))]
# 11. licence: make the card get the certificates, with the fee as its own card once they are filed
task("COMPLIANCE: HMO licence fee - 7 Example Road")
e = submit("The fee is £150.\\nSPEND: £150\\n\\n**Carrying this out will involve:** the agent submits the licence application.")["err"]
out["licence"] = ["comes back as its own card once they are filed" in e,
                  ok(submit("The certificates are missing.\\n\\n**Carrying this out will involve:** the agent books the EICR and the gas check; the licence fee comes back as its own card once they are filed."))]
# 12. managed house: ask the agent for the copy, no quote subject and no PASS TO ROY line
task("COMPLIANCE: GSC renewal due 2026-12-01 - 11 Test Lane")
e = submit("PASS TO ROY: book the gas safety check at 11 Test Lane.\\n\\n**Carrying this out will involve:** Roy books it.")["err"]
out["managed"] = ["send the managing agent an email asking for the latest copy" in e,
                  ok(submit(email("Could you send us the latest gas safety certificate for 11 Test Lane?", to="office@fixture-agency.test", subject="Latest gas certificate"), type_="Correspondence"))]
# 13. a check that could not run: try again once the read works
task("COMPLIANCE: fire alarm quote - 7 Example Road")
real = m.fetch_properties
m.fetch_properties = lambda refresh=False: (_ for _ in ()).throw(RuntimeError("HTTP 502"))
e = submit(email("It is a two-bedroom house, at 7 Example Road."), type_="Correspondence")["err"]
m.fetch_properties = real
out["couldNotRun"] = ["Try again" in e, ok(submit(email("It is a two-bedroom house, at 7 Example Road."), type_="Correspondence"))]
# ─── the gaps the review of PR 950 left open (16 Nov 2026), each refusal followed once ───
# 14. tenant notice, another booking wording (finding 5)
task("COMPLIANCE: EICR renewal due - 9 Sample Street")
start = email("Can you confirm you can start at 9 Sample Street at 9am on Thursday 26 November for the EICR?")
e = submit(start, type_="Correspondence")["err"]
out["noticeMoreWords"] = ["--tenant-notice" in e, ok(submit(start, type_="Correspondence", tenant_notice=day(10) + ": every tenant by text and email from info@"))]
# 15. tenant notice, a PASS TO ROY booking on a named day (finding 5); Roy's handover itself is not this test's business
m.handle_without_kevin = lambda args, output, trec, level, attached: (CAPTURED.update({AF["status"]: "Completed"}), 0)[1]
roy = ("PASS TO ROY: the EICR at 9 Sample Street is booked for Thursday 26 November at 9am with Fixture Electrical; please be there to let them in.\\n\\n"
       "**Carrying this out will involve:** Roy meets the electrician at the house.")
e = submit(roy)["err"]
out["noticeRoy"] = ["--tenant-notice" in e, ok(submit(roy, tenant_notice=day(10) + ": every tenant by text and email from info@"))]
# 16. renewal, said in the email's own words (finding 6)
task("INSURANCE: buildings cover renewal - 9 Sample Street")
e = submit(mail("this email goes to the insurer.").replace("Please see below.", "Please go ahead and renew the policy from 1 December."), type_="Correspondence")["err"]
line = re.search(r"NO TOPCASHBACK QUOTE: <[^>]+>", e).group(0)
out["renewalInBody"] = [bool(e), ok(submit(mail("this email goes to the insurer. " + fill(line, "no TopCashback insurer quotes a house let to a council scheme")).replace("Please see below.", "Please go ahead and renew the policy from 1 December."), type_="Correspondence"))]
# 17. licence, a task name with the address cut short (finding 7)
task("COMPLIANCE: HMO licence fee - 7 Example Rd")
e = submit("The fee is £150.\\nSPEND: £150\\n\\n**Carrying this out will involve:** the agent submits the licence application.")["err"]
out["licenceShortName"] = ["comes back as its own card once they are filed" in e,
                           ok(submit("The certificates are missing.\\n\\n**Carrying this out will involve:** the agent books the EICR and the gas check; the licence fee comes back as its own card once they are filed."))]
# 18. licence, "gas" in the task's name (finding 7)
task("COMPLIANCE: HMO licence - gas and EICR first - 7 Example Road")
e = submit("Report.\\n\\n**Carrying this out will involve:** the agent pays the licence fee to the council.")["err"]
out["licenceGasInName"] = ["comes back as its own card once they are filed" in e,
                           ok(submit("Report.\\n\\n**Carrying this out will involve:** the agent books the EICR and the gas check; the licence fee comes back as its own card once they are filed."))]
# 19. paid check, a payee of three letters (finding 8)
task("INBOUND: pay AXA landlord insurance premium GBP 61.20")
BANK[:] = [{"id": "recBankAxaAaaaaaa", "date": day(-2), "amount": -61.20, "name": "AXA INSURANCE DD", "tenancyIds": []}]
axa = lambda line: ("MARK FOR PAYMENT: AXA premium for November\\nPAYEE: AXA\\nAMOUNT: £61.20\\n" + line +
                    "\\n\\n**Carrying this out will involve:** £61.20 goes on the Friday payment list.")
e = submit(axa("PAID CHECK: none found (searched the bank)"))["err"]
line = re.search(r"PAID CHECK: not this bill: \\d+ payments from \\S+ to \\S+ \\(<[^>]+>\\)", e).group(0)
out["paidShortPayee"] = ["recBankAxaAaaaaa" in e, ok(submit(axa(fill(line, "that was October's premium, this bill is November's"))))]
print(json.dumps(out))`);
    for (const [k, v] of Object.entries(r)) expect([k, v]).toEqual([k, [true, true]]);
    expect(Object.keys(r).length).toBe(24);      // every refusal, each followed once (18 from PR 950, 6 added 16 Nov)
  });
});

describe("R2 and R3. the agent's own words; every match shown, and one line may cover them all", () => {
  it('a tier-1 PAY: task closed as already paid gets through; six instalments are all listed and one line covers them; a bounced payment needs no false line', () => {
    const r = py(TABLE_PRE + `
task("PAY: Fixture Solicitors invoice 1200 GBP - fees")
BANK[:] = [{"id": "recBankPaidAaaaaa", "date": day(-1), "amount": -1200.0, "name": "FIXTURE SOLICITORS LLP", "tenancyIds": []}]
close = ("CLOSE PROPOSAL: already handled — see recDoneTaskAaaaaa\\n\\nThe bank shows £1,200 paid to Fixture Solicitors (recBankPaidAaaaaa).\\n\\n"
         "**Carrying this out will involve:** this task closes as already paid.")
tier1 = submit(close, tier1=True)
lic = m.licence_cert_problem("COMPLIANCE: HMO licence fee - 7 Example Road", m.agent_own_text(m.TIER1_BANNER + "\\n\\nCLOSE PROPOSAL: duplicate of recOtherAaaaaaaa\\nSPEND: £150\\n\\n**Carrying this out will involve:** this closes."), "")
task("INBOUND: Fixture Debt Recovery payment plan", created=(datetime.now(timezone.utc) - timedelta(days=200)).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
BANK[:] = [{"id": "recInst%07dAaa" % i, "date": day(-30 * i), "amount": -50.0, "name": "FIXTURE DEBT RECOVERY", "tenancyIds": []} for i in range(1, 7)]
card = lambda line: ("MARK FOR PAYMENT: Fixture Debt Recovery instalment for December\\nPAYEE: Fixture Debt Recovery\\nAMOUNT: £50.00\\n" + line +
                     "\\n\\n**Carrying this out will involve:** £50 goes on the Friday payment list.")
first = submit(card("PAID CHECK: none found for December (searched the bank)"))["err"]
ids = sorted(set(re.findall(r"rec[A-Za-z0-9]{14}", first.replace("recTESTTESTTEST01", ""))))
count_line = fill(re.search(r"PAID CHECK: not this bill: \\d+ payments from \\S+ to \\S+ \\(<[^>]+>\\)", first).group(0))
by_count = submit(card(count_line))
by_ids = submit(card("PAID CHECK: not this bill: " + ", ".join(ids) + " (earlier months' instalments)"))
five = submit(card("PAID CHECK: not this bill: " + ", ".join(ids[:5]) + " (earlier months' instalments)"))
short_count = submit(card(count_line.replace("6 payments", "5 payments")))
task("INBOUND: pay Fixture Plumbing invoice 4411 GBP 90")
BANK[:] = [{"id": "recBankOutAaaaaaa", "date": day(-3), "amount": -90.0, "name": "FIXTURE PLUMBING LTD", "tenancyIds": []},
           {"id": "recBankBackAaaaaa", "date": day(-2), "amount": 90.0, "name": "FIXTURE PLUMBING LTD RETURNED", "tenancyIds": []}]
bounced = submit("MARK FOR PAYMENT: Fixture Plumbing invoice 4411 (the first payment bounced back)\\nPAYEE: Fixture Plumbing Ltd\\nAMOUNT: £90.00\\n"
                 "PAID CHECK: none found that stayed paid (paid and returned this week)\\n\\n**Carrying this out will involve:** £90 goes on the Friday payment list again.")
print(json.dumps({"tier1": tier1, "lic": lic, "ids": ids, "byCount": by_count, "byIds": by_ids, "five": five["err"], "shortCount": short_count["err"], "bounced": bounced}))`);
    expect(r.tier1.err).toBeNull();
    expect(r.tier1.status).toBe('Approval');
    expect(r.lic).toBe('');
    expect(r.ids.length).toBe(6);
    expect(r.byCount.err).toBeNull();
    expect(r.byIds.err).toBeNull();
    expect(r.five).toMatch(/the bank already shows 6 payment\(s\)/);
    expect(r.shortCount).toMatch(/the bank already shows 6 payment\(s\)/);
    expect(r.bounced.err).toBeNull();
  });
});

describe('R5. checks that would refuse correct work are narrowed', () => {
  it("bedroom counts that are not a house's size; a document sent for an application; March's early rent; Kevin asking for the booking", () => {
    const r = py(TABLE_PRE + `
N = "MAINTENANCE: carpets - 9 Sample Street"
b = {"B1": m.bedroom_problem(N, email("Please quote to replace the carpet in two bedrooms at 9 Sample Street.")),
     "B2": m.bedroom_problem(N, email("The tenant at 9 Sample Street reports mould in one bedroom. Please inspect.")),
     "B3": m.bedroom_problem("COMPLIANCE: EICR - 7 Example Road", email("We need EICRs at 7 Example Road and 9 Sample Street. 7 Example Road has 2 bedrooms and the other has 4 bedrooms.")),
     "B4": m.bedroom_problem("COMPLIANCE: EICR - 7 Example Road", email("Your price list says £150 for 1-3 bed houses. 7 Example Road fits that band.")),
     "B5": m.bedroom_problem(N, email("Thanks for your reply.\\n\\n> We can quote for your 3 bedroom house at 9 Sample Street."))}
still = m.bedroom_problem(N, email("9 Sample Street is a three-bedroom house."))
L = "INBOUND: selective licence application - 7 Example Road"
lic = {"floorPlan": m.licence_cert_problem(L, "Report.\\n\\n**Carrying this out will involve:** the agent sends the floor plan for the application.", ""),
       "query": m.licence_cert_problem(L, "Report.\\n\\n**Carrying this out will involve:** the agent files a reply to the council's question on the application.", "")}
lic_still = m.licence_cert_problem(L, "Report.\\n\\n**Carrying this out will involve:** the agent submits the licence application.", "")
TENANCIES["recTenancyAaaaaaa"] = 500.0
m.query_records = lambda table, formula=None, fields=None, max_records=None: [{"id": "recTenancyAaaaaaa", "fields": {m.RENT_FIELD: 500.0, m.RENT_DUE_DAY_FIELD: 1}}]
BANK[:] = [{"id": "recEarlyMarAaaaaa", "date": "2027-02-25", "amount": 500.0, "name": "TENANT", "tenancyIds": ["recTenancyAaaaaaa"]}]
march = m.rent_paid_problem("RENT LATE: Unit 1", "RENT CHECK KEY: recTenancyAaaaaaa:2027-02-01:1", "")
BANK[:] = [{"id": "recFebAaaaaaaaaaa", "date": "2027-02-23", "amount": 500.0, "name": "TENANT", "tenancyIds": ["recTenancyAaaaaaa"]}]
february = m.rent_paid_problem("RENT LATE: Unit 1", "RENT CHECK KEY: recTenancyAaaaaaa:2027-02-01:1", "")
task("COMPLIANCE: EICR expired - 11 Test Lane")
TASK["fields"][AF["approvalFeedback"]] = "Please book the EICR at 11 Test Lane, the agent says this one is ours."
asked = submit("PASS TO ROY: book the EICR at 11 Test Lane.\\n\\n**Carrying this out will involve:** Roy books it.")
task("COMPLIANCE: EICR expired - 11 Test Lane")    # fresh: the card above archived his words into Feedback History
TASK["fields"][AF["approvalFeedback"]] = "Thanks."
unasked = submit("PASS TO ROY: book the EICR at 11 Test Lane.\\n\\n**Carrying this out will involve:** Roy books it.")
print(json.dumps({"b": b, "still": still, "lic": lic, "licStill": lic_still, "march": march, "february": february,
                  "asked": asked["err"], "unasked": unasked["err"]}))`);
    expect(r.b).toEqual({ B1: '', B2: '', B3: '', B4: '', B5: '' });
    expect(r.still).toMatch(/gives 9 Sample Street 3 bedroom\(s\)/);
    expect(r.lic).toEqual({ floorPlan: '', query: '' });
    expect(r.licStill).toMatch(/puts a licence application in for 7 Example Road/);
    expect(r.march).toBe('');                     // 25 Feb is the March cycle: rent-check's next due (1 Mar) less 5 days
    expect(r.february).toMatch(/the rent for the cycle due 01 Feb 2027 has arrived/);
    expect(r.asked).toBeNull();
    expect(r.unasked).toMatch(/managed by Roc Immo/);
  });
});

// PR 951 built mailout_recipients_problem in agent_email_format.py, but submit called the
// strict validator without the task name, so the check never ran (16 Nov 2026). This drives
// the real cmd_submit: a tenant mail-out that shows recipients each other is refused.
describe('submit passes the task name, so a tenant mail-out never shows its recipients each other', () => {
  it('refuses two addresses on TO for a TENANT MAILOUT card, and passes one', () => {
    const r = py(`
task("TENANT MAILOUT: Exampletown rooms 1 Nov 2026")
TR = "\\n\\nTRACK RECORD: none found (searched tasks and Gmail for example-charity)\\n\\n**Carrying"
def mail(to): return email("We have a room free now in Exampletown.", to=to, subject="Rooms for single adults").replace("\\n\\n**Carrying", TR)
two = submit(mail("one@example-charity.test, two@example-council.test"), type_="Correspondence")
one = submit(mail("one@example-charity.test"), type_="Correspondence")
print(json.dumps({"two": two, "one": one}))`);
    expect(r.two.err).toMatch(/tenant mail-out/);
    expect(r.one.err).toBeNull();
  });
});
