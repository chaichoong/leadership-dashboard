import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// THE GAPS THE REVIEWS OF PR 950 AND PR 951 LEFT OPEN (Kevin, "Do it now", 16 Nov 2026).
//   F5  a booked visit in other words, or in a PASS TO ROY line, still says how the tenants are told
//   F6  "please go ahead and renew" in the email itself is a renewal
//   F7  a licence task whose name cuts the address short, or names gas, is still checked
//   F8  a payee of three letters (AXA, EDF) is matched against the bank
//   F11 a check that let a card through without looking says NOT CHECKED where Kevin reads it
//   PR 951  a cancelled policy can be marked Expired by a robot, so the double-cover task stops coming back
// Each widening was back-tested read-only on the 1,883 stored Agent Outputs before it was kept; the
// cases below that must NOT be refused are the shapes that back-test turned up.
//
// The real cmd_submit and cmd_certificate_expire run with Airtable swapped for in-memory fixtures. Every
// network door raises (urlopen, socket connect, create_connection). Names, addresses, amounts and ids are
// invented.

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
TODAY = datetime.now(m.LONDON).date()
def day(n): return (TODAY + timedelta(days=n)).isoformat()
CREATED = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
BUILDER = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
PROPS = [
    {"id": "recPropOneAaaaaaa", "name": "7 Example Road, Testville TE1 1AA", "short": "7 Example Road", "kind": "HMO",
     "manager": "Property Portfolio", "required": ["Landlord Insurance", "EICR", "EPC", "GSC"], "bedrooms": 2, "units": []},
    {"id": "recPropTwoAaaaaaa", "name": "9 Sample Street, Testville TE1 2BB", "short": "9 Sample Street", "kind": "Single Let",
     "manager": "Property Portfolio", "required": ["Landlord Insurance", "EICR", "EPC", "GSC"], "bedrooms": 4, "units": []},
    {"id": "recPropRocAaaaaaa", "name": "11 Test Lane, Testville TE1 3CC", "short": "11 Test Lane", "kind": "Single Let",
     "manager": "Roc Immo", "required": ["Landlord Insurance", "EICR", "EPC"], "bedrooms": 3, "units": []},
]
def cert(cid, pid, typ, renewal, status="Active", units=()):
    return {"id": cid, "type": typ, "propertyIds": [pid], "unitIds": list(units), "status": status,
            "renewalDate": renewal, "hasFile": True, "taskIds": [], "created": "2026-01-01"}
CERTS = [cert("recCertEicrOneAaa", "recPropOneAaaaaaa", "EICR", "2026-01-01", "Expired"),
         cert("recCertEicrTwoAaa", "recPropTwoAaaaaaa", "EICR", day(900)), cert("recCertGscTwoAaaa", "recPropTwoAaaaaaa", "GSC", day(200))]
m.fetch_properties = lambda refresh=False: PROPS
m.fetch_certificates = lambda refresh=False: CERTS
BANK = []
m.fetch_bank_lines = lambda since: [b for b in BANK if b["date"] > since]
TENANCIES = {"recTenancyAaaaaaa": 500.0, "recTenancyNoRentA": 0.0}
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
m.track_record_problem = lambda *a, **k: ""
m.validate_any_submission = lambda *a, **k: None
m.coverage_problem = lambda *a, **k: ""
m.checked_problem = lambda *a, **k: ""
TASK = {}
def task(name, notes="", desc="", props=None, extra=None):
    TASK.clear()
    TASK.update({"id": "recTESTTESTTEST01", "createdTime": CREATED,
                 "fields": {AF["name"]: name, AF["status"]: {"name": "Today"}, AF["teamMember"]: [BUILDER],
                            AF["notes"]: notes, AF["description"]: desc}})
    if props is not None:
        TASK["fields"][m.TASK_PROPERTIES_FIELD] = props
    TASK["fields"].update(extra or {})
m.get_task = lambda i: json.loads(json.dumps(TASK))
CAPTURED = {}
def patch(i, f):
    CAPTURED.update(f); TASK["fields"].update(f)
    return {"id": i}
m.patch_task = patch
def submit(output, type_="Admin", plain_approve="The card closes and the agent records it.", tenant_notice=""):
    CAPTURED.clear()
    fh = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False); fh.write(output); fh.close()
    err = None
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        try:
            m.cmd_submit(types.SimpleNamespace(task="recTESTTESTTEST01", agent=BUILDER, type=type_,
                         output_file=fh.name, tier1=False, attach=None, plain_task="A job came in for one of the houses.",
                         plain_approve=plain_approve, tenant_notice=tenant_notice,
                         certificate_search='searched the compliance book, the task history and each inbox (info@ and Gmail): no certificate held for this house'))
        except SystemExit as e:
            err = str(e)
    st = CAPTURED.get(AF["status"])
    return {"err": err, "status": st if isinstance(st, str) else (st or {}).get("name") if st else None,
            "notes": CAPTURED.get(AF["notes"], ""), "output": CAPTURED.get(AF["agentOutput"], "")}
def email(body, to="bookings@fixture-trade.test", subject="Your visit", close="one email from the Agile Lets inbox to the firm."):
    return (f"TO: {to}\\nFROM: info@agilelets.co.uk\\nSUBJECT: {subject}\\n---\\n{body}\\n\\nKind regards\\nRoy Lavin\\nAgile Lets\\n\\n"
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

describe('F5. a visit booked in other words, or through Roy, still says how the tenants are told', () => {
  it('the booking wordings the back-test found are caught; deadlines, past visits, questions, ranges and start dates are not', () => {
    const r = py(`
N = "COMPLIANCE: EICR renewal due - 9 Sample Street"
P = lambda body: m.tenant_notice_problem(N, email(body), "Correspondence", None)
caught = {k: bool(P(b)) for k, b in {
    "confirmStart": "Can you confirm you can start at 9 Sample Street at 11:00 on Friday 4 December?",
    "confirmGoIn": "Confirm the gas engineer can go in on Monday 7 December as well.",
    "isGreat": "Friday 4 December is great.",
    "yesPlease": "Yes please to Friday 4 December at 12:00 for the EICR at 9 Sample Street.",
    "carryOut": "Please carry out the EPC at 9 Sample Street on Friday 4 December, at the £80 you quoted.",
    "takeSlot": "They have offered Wednesday 9 December at 08:00 for the EICR, and I want to take that slot.",
    "cleared": "I have now cleared the house for Monday 7 December 2026, any time between 9am and 4pm.",
}.items()}
left = {k: P(b) for k, b in {
    "deadline": "Could you reply by Friday 4 December with your price?",
    "pastVisit": "The visit on Monday 12 October did not go ahead because nobody could get in.",
    "question": "Could you let us know if you have a free slot on Friday 4 December?",
    "range": "Any day from Monday 7 to Friday 11 December works for us.",
    "thanks": "Thanks for going round on Friday 6 November.",
    "cancel": "Please cancel the visit booked for Thursday 26 November.",
    "quoted": "Thank you.\\n\\n> We can start on Friday 4 December, please confirm.",
    "notTake": "We cannot take that slot on Friday 4 December, sorry.",
}.items()}
start = m.tenant_notice_problem("INSURANCE: buildings cover - 9 Sample Street",
                                email("A start date of 1 December is fine for the new policy."), "Correspondence", None)
roy = lambda text: m.tenant_notice_problem(N, text + "\\n\\n**Carrying this out will involve:** Roy does it.", "Admin", None)
royBooked = roy("PASS TO ROY: the EICR at 9 Sample Street is booked for Thursday 26 November at 9am with Fixture Electrical.")
royNoDay = roy("PASS TO ROY: book the EICR at 9 Sample Street with the cheapest of the three quotes.")
print(json.dumps({"caught": caught, "left": left, "start": start, "royBooked": royBooked, "royNoDay": royNoDay}))`);
    for (const [k, v] of Object.entries(r.caught)) expect([k, v]).toEqual([k, true]);
    for (const [k, v] of Object.entries(r.left)) expect([k, v]).toEqual([k, '']);
    expect(r.start).toBe('');
    expect(r.royBooked).toMatch(/it books a contractor visit \("PASS TO ROY: the EICR at 9 Sample Street is booked for Thursday 26 November/);
    expect(r.royBooked).toMatch(/--tenant-notice/);
    expect(r.royNoDay).toBe('');
  });
});

describe('F6. a renewal said in the email itself is a renewal', () => {
  it('the three shapes the review found are refused; a refusal to renew and a question about the date are not', () => {
    const r = py(`
N = "INSURANCE: buildings cover renewal - 9 Sample Street"
mail = lambda body, close="this email goes to the insurer.": email(body, to="renewals@fixture-insure.test", subject="Policy FX-1", close=close)
R = lambda out, pa="The email goes to the insurer.": m.renewal_problem(N, out, pa)
print(json.dumps({
  "body": R(mail("Please go ahead and renew the policy from 1 December.")),
  "pays": R(mail("Thank you for the reminder.", close="the agent pays the renewal premium by card.")),
  "continue": R(mail("Thank you.", close="this email tells Fixture Insure we will continue cover from 1 December.")),
  "myInsurance": R(mail("Please renew my buildings insurance for 9 Sample Street.")),
  "notContinue": R(mail("We will not continue cover after 1 December, as we are buying elsewhere.")),
  "askDate": R(mail("Please confirm the renewal date for policy FX-1.")),
  "quoted": R(mail("Thank you.\\n\\n> Please renew the policy by replying yes.")),
  "withLine": R(mail("Please go ahead and renew the policy from 1 December.", close="this email goes to the insurer. NO TOPCASHBACK QUOTE: no TopCashback insurer covers a house let to a council scheme.")),
}))`);
    expect(r.body).toMatch(/renews an insurance policy or signs its renewal \("Please go ahead and renew the policy from 1 December/);
    expect(r.pays).toMatch(/renews an insurance policy/);
    expect(r.continue).toMatch(/renews an insurance policy/);
    expect(r.myInsurance).toMatch(/renews an insurance policy/);
    expect(r.notContinue).toBe('');
    expect(r.askDate).toBe('');
    expect(r.quoted).toBe('');
    expect(r.withLine).toBe('');
  });
});

describe('F7. a licence task with a short name, a Properties link or "gas" in its name is still checked', () => {
  it('places the house by link or number and street, reads a licence act on a certificate-named task, and leaves a certificate purchase alone', () => {
    const r = py(`
L = lambda name, out, tf=None: m.licence_cert_problem(name, out, "", tf)
fee = "The fee is £150.\\nSPEND: £150\\n\\n**Carrying this out will involve:** the agent submits the licence application."
link = {m.TASK_PROPERTIES_FIELD: ["recPropOneAaaaaaa"]}
two = {m.TASK_PROPERTIES_FIELD: ["recPropOneAaaaaaa", "recPropTwoAaaaaaa"]}
with contextlib.redirect_stderr(io.StringIO()):
    out = {
      "shortName": L("COMPLIANCE: HMO licence fee - 7 Example Rd", fee),
      "byLink": L("COMPLIANCE: licensing fee due", fee, link),
      "inDateHouse": L("COMPLIANCE: HMO licence fee - 9 Sample St", fee),
      "gasPays": L("COMPLIANCE: HMO licence - gas and EICR first - 7 Example Road",
                   "Report.\\n\\n**Carrying this out will involve:** the agent pays the licence fee to the council."),
      "gasBuysCert": L("COMPLIANCE: gas safety check for the HMO licence - 7 Example Road",
                       "Quote £80.\\nSPEND: £80\\n\\n**Carrying this out will involve:** the agent books the gas safety check."),
      "gasBillLicence": L("COMPLIANCE: HMO licence - gas and EICR first - 7 Example Road",
                          "MARK FOR PAYMENT: Testville Council HMO licence fee\\nPAYEE: Testville Council\\nAMOUNT: £150.00\\n\\n**Carrying this out will involve:** it goes on the Friday list."),
    }
    m._SUBMIT_NOT_CHECKED.clear()
    out["twoHouses"] = L("COMPLIANCE: licensing fee due", fee, two)
    out["twoHousesNote"] = list(m._SUBMIT_NOT_CHECKED)
print(json.dumps(out))`);
    expect(r.shortName).toMatch(/puts a licence application in for 7 Example Road, and the book holds no in-date EICR or GSC/);
    expect(r.byLink).toMatch(/for 7 Example Road/);
    expect(r.inDateHouse).toBe('');
    expect(r.gasPays).toMatch(/for 7 Example Road/);
    expect(r.gasBuysCert).toBe('');
    expect(r.gasBillLicence).toMatch(/for 7 Example Road/);
    expect(r.twoHouses).toBe('');
    expect(r.twoHousesNote[0]).toMatch(/licence check: .*the task names more than one house/);
  });
});

describe('F8. a payee of three letters or fewer is matched', () => {
  it('AXA and EDF match their bank lines; a small word in lower case and a bank abbreviation do not', () => {
    const r = py(`
W = m.payee_words
print(json.dumps({
  "axa": sorted(W("AXA") & W("AXA INSURANCE DD 61.20", bank=True)),
  "edf": sorted(W("EDF Energy") & W("EDF ENERGY CUSTOMERS", bank=True)),
  "lower": sorted(W("Fixture Plumbing of Testville") - {"fixture", "plumbing", "testville"}),
  "abbrev": sorted(W("Fixture DD Ltd UK") & W("SOMEONE ELSE DD UK", bank=True)),
}))`);
    expect(r.axa).toEqual(['axa']);
    expect(r.edf).toContain('edf');
    expect(r.lower).toEqual([]);
    expect(r.abbrev).toEqual([]);
  });
});

describe('F11. NOT CHECKED reaches the card trail, never the email', () => {
  it('a rent card for a tenancy with no rent, a bill with no amount and a licence card with no house each land with a dated NOT CHECKED line', () => {
    const r = py(`
out = {}
task("RENT LATE: Unit 2 - 9 Sample Street, rent due (reminder)", notes="RENT CHECK KEY: recTenancyNoRentA:" + day(-6) + ":1")
BANK[:] = [{"id": "recRentInAaaaaaaa", "date": day(-1), "amount": 450.0, "name": "RECEIPT", "tenancyIds": ["recTenancyNoRentA"]}]
out["rent"] = submit(email("Your rent has not reached us.", to="tenant@example.test", subject="Rent",
                           close="one email from the Agile Lets inbox to the tenant."), type_="Correspondence")
task("INBOUND: pay a Fixture Fines penalty")
out["bill"] = submit("MARK FOR PAYMENT: a fine, EUR 45\\nPAYEE: Fixture Fines\\nPAID CHECK: none found (searched the bank and Gmail)\\n\\n"
                     "**Carrying this out will involve:** it goes on the Friday payment list.")
task("COMPLIANCE: licensing fee due")
out["licence"] = submit("The fee is £150.\\nSPEND: £150\\n\\n**Carrying this out will involve:** the agent submits the licence application.")
task("COMPLIANCE: HMO licence fee - 9 Sample Street")
out["clean"] = submit("The fee is £150.\\nSPEND: £150\\n\\n**Carrying this out will involve:** the agent submits the licence application.")
print(json.dumps({k: {"err": v["err"], "status": v["status"], "nc": re.findall(r"NOT CHECKED BY CODE \\(round \\d+\\): [^\\n]*", v["notes"]),
                      "inOutput": "NOT CHECKED" in v["output"]} for k, v in out.items()}))`);
    for (const k of ['rent', 'bill', 'licence']) {
      expect([k, r[k].err]).toEqual([k, null]);
      expect([k, r[k].status]).toEqual([k, 'Approval']);
      expect([k, r[k].inOutput]).toEqual([k, false]);
      expect([k, r[k].nc.length]).toEqual([k, 1]);
    }
    expect(r.rent.nc[0]).toMatch(/rent paid-again check: tenancy recTenancyNoRentA has no rent on its record/);
    expect(r.bill.nc[0]).toMatch(/paid check: the bill has no amount code can read/);
    expect(r.licence.nc[0]).toMatch(/licence check: .*neither the task name nor its Properties link names a house/);
    expect(r.clean.nc).toEqual([]);
  });

  it('a bought-twice check that cannot run says NOT CHECKED on the trail and still lets the card through', () => {
    const r = py(`
task("COMPLIANCE: EICR renewal due - 9 Sample Street")
def down(*a, **k): raise RuntimeError("HTTP 503")
m.certificate_purchase_problem = down
res = submit(email("Please send your price for an EICR at 9 Sample Street.", subject="EICR quote"), type_="Correspondence")
print(json.dumps({"err": res["err"], "nc": re.findall(r"NOT CHECKED BY CODE \\(round \\d+\\): [^\\n]*", res["notes"])}))`);
    expect(r.err).toBeNull();
    expect(r.nc[0]).toMatch(/bought-twice check: it could not run \(RuntimeError: HTTP 503\)/);
  });
});

// PR 951's review: "no robot can mark a cancelled policy Expired", so the double-cover task came back 14
// days after it closed. certificate-expire is the door; certificate_watch's own insurance_doubles proves
// the house stops reading as a double once it is used.
const EXPIRE = `
POL_KEEP, POL_GO = "recPolKeepAaaaaaa", "recPolGoneAaaaaaa"
CERTS[:] = [cert(POL_KEEP, "recPropTwoAaaaaaa", "Landlord Insurance", day(300)),
            cert(POL_GO, "recPropTwoAaaaaaa", "Landlord Insurance", day(200)),
            cert("recPolOnlyAaaaaaa", "recPropOneAaaaaaa", "Landlord Insurance", day(100)),
            cert("recCertGscTwoAaaa", "recPropTwoAaaaaaa", "GSC", day(200))]
ROWS = {c["id"]: c for c in CERTS}
WRITES = []
def req(method, path, body=None):
    rid = path.split("/")[2].split("?")[0]
    if method == "PATCH":
        WRITES.append((rid, body))
        f = body["fields"]
        if m.CERT_FIELDS["status"] in f: ROWS[rid]["status"] = f[m.CERT_FIELDS["status"]]
        return {"id": rid}
    c = ROWS[rid]
    return {"id": rid, "fields": {m.CERT_FIELDS["type"]: c["type"], m.CERT_FIELDS["property"]: c["propertyIds"],
                                  m.CERT_FIELDS["status"]: c["status"], m.CERT_FIELDS["renewal"]: c["renewalDate"],
                                  m.CERT_FIELDS["notes"]: "policy FX-1", m.CERT_FIELDS["tasks"]: []}}
m._request = req
UPLOADS = []
m.upload_attachment = lambda tid, path: (UPLOADS.append(path), os.path.basename(path))[1]
EVIDENCE = "Fixture Insure email 20 Nov 2026: policy FX-2 cancelled from 25 Nov 2026, refund £41.20"
def card(text):
    task("INSURANCE: two live policies on 9 Sample Street - keep the cheapest",
         extra={AF["approvalOutcome"]: {"name": "Approved as-is"}, AF["approvedAt"]: "2026-11-16T10:00:00.000Z",
                AF["agentOutput"]: text})
def expire(row, evidence=EVIDENCE, file=None):
    WRITES.clear(); CAPTURED.clear()
    err, out = None, io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        try:
            m.cmd_certificate_expire(types.SimpleNamespace(row=row, task="recTESTTESTTEST01", evidence=evidence, file=file))
        except SystemExit as e:
            err = str(e)
    return {"err": err, "writes": len(WRITES), "json": json.loads(out.getvalue().strip().split("\\n")[-1]) if out.getvalue().strip() else None,
            "notes": CAPTURED.get(AF["notes"], "")}
GOOD = "Keep: row " + POL_KEEP + " (Fixture Mutual, £300/yr)\\nCancel: row " + POL_GO + " (Fixture Insure, policy FX-2, £410/yr)\\n\\n**Carrying this out will involve:** the agent asks Fixture Insure to cancel FX-2."
def doubles():
    pages = [{"id": p["id"], "short": p["short"], "name": p["name"], "active": True} for p in PROPS]
    policies = [c for c in CERTS if c["type"] == "Landlord Insurance"]      # as double_cover_check passes them
    return [d["propertyId"] for d in m.certificate_watch.insurance_doubles(pages, policies, None, (), TODAY.isoformat())[0]]
`;

describe('PR 951. a cancelled policy is marked Expired by a robot, so the double cover does not come back', () => {
  it('expected: on the approved card naming the row on its cancel line, with the insurer\'s word, the row reads Expired and the house is no longer a double', () => {
    const r = py(EXPIRE + `
card(GOOD)
before = doubles()
pdf = tempfile.NamedTemporaryFile("wb", suffix=".pdf", delete=False); pdf.write(b"%PDF-1.4 cancellation " * 200); pdf.close()
res = expire(POL_GO, file=pdf.name)
after = doubles()
again = expire(POL_GO)
print(json.dumps({"before": before, "after": after, "res": res, "again": again, "status": ROWS[POL_GO]["status"],
                  "uploads": len(UPLOADS)}))`);
    expect(r.before).toEqual(['recPropTwoAaaaaaa']);
    expect(r.res.err).toBeNull();
    expect(r.res.json.changed).toBe(true);
    expect(r.res.writes).toBe(1);
    expect(r.uploads).toBe(1);
    expect(r.status).toBe('Expired');
    expect(r.after).toEqual([]);
    expect(r.res.notes).toMatch(/POLICY MARKED EXPIRED: row recPolGoneAaaaaaa \(9 Sample Street\), cancelled in writing: Fixture Insure email 20 Nov 2026.* The confirmation is attached: /);
    // edge: run twice, nothing is written the second time
    expect(r.again.err).toBeNull();
    expect(r.again.json.changed).toBe(false);
    expect(r.again.writes).toBe(0);
  });

  it('refuses each wrong case with a way through, and following it gets through', () => {
    const r = py(EXPIRE + `
out, writes = {}, []
def refused(key, row, **kw):
    res = expire(row, **kw)
    out[key] = res["err"]; writes.append(res["writes"])
    return res
card(GOOD)
refused("notInTable", "recNoSuchRowAaaaa")
refused("certificate", "recCertGscTwoAaaa")
refused("noDate", POL_GO, evidence="the insurer said it is cancelled")
refused("lastPolicy", "recPolOnlyAaaaaaa")
card("Cancel: row recPolOnlyAaaaaaa (Fixture Insure)\\n\\n**Carrying this out will involve:** it is cancelled.")
refused("lastPolicyNamed", "recPolOnlyAaaaaaa")
card("Keep " + POL_KEEP + " and cancel " + POL_GO + ".\\n\\n**Carrying this out will involve:** the agent asks for the cancellation.")
both = refused("bothOnOneLine", POL_GO)
card("Cancel: row " + POL_KEEP + " - do not cancel, this is the one we keep\\n\\n**Carrying this out will involve:** nothing yet.")
refused("keepLine", POL_KEEP)
task("INSURANCE: two live policies on 9 Sample Street - keep the cheapest", extra={AF["agentOutput"]: GOOD})
refused("notApproved", POL_GO)
# the way through the one-line refusal: the card raised again with the row on a cancel line of its own, then approved
way = re.search(r'"Cancel: row [^"]+"', both["err"]).group(0).strip('"').replace("<insurer>", "Fixture Insure").replace("<policy number>", "FX-2")
card(way + "\\n\\n**Carrying this out will involve:** the agent asks Fixture Insure to cancel FX-2.")
through = expire(POL_GO)
print(json.dumps({"out": out, "writes": writes, "through": through["err"], "status": ROWS[POL_GO]["status"]}))`);
    expect(r.writes.every((n) => n === 0)).toBe(true);     // nothing is written on any refusal
    const o = r.out;
    expect(o.notInTable).toMatch(/is not a row of the Property Certificates table\. Pass the book row's own id/);
    expect(o.certificate).toMatch(/is a GSC row\. Only a landlord policy .* file the new one with `certificate` instead/);
    expect(o.noDate).toMatch(/--evidence must quote the insurer's written confirmation, with its date/);
    expect(o.lastPolicy).toMatch(/does not name recPolOnlyAaaaaaa on a line of its own/);
    expect(o.lastPolicyNamed).toMatch(/7 Example Road would have no landlord policy in force on the book\. .*put it to Kevin as a card/);
    expect(o.bothOnOneLine).toMatch(/Raise the card again with a line of its own, "Cancel: row recPolGoneAaaaaaa/);
    expect(o.keepLine).toMatch(/does not name recPolKeepAaaaaaa on a line of its own/);
    expect(o.notApproved).toMatch(/is not work Kevin approved .* put the cancellation to him as a card naming the row first/);
    expect(r.through).toBeNull();
    expect(r.status).toBe('Expired');
  });
});
