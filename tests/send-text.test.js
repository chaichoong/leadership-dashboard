// The text route (Cash Flow Voids cut-over build, 3 Oct 2026; Kevin approved "Build as-is"):
// scripts/send-text.py sends an approved card's TEXT line from the Agile Lets number through
// GoHighLevel, and refuses everything else. These drive the REAL script with Airtable and GoHighLevel
// stubbed: no test reaches either, and no test can send a text. Every id, name and number is invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(root, 'scripts');

const HARNESS = `
import importlib.util, json, sys, os, io, contextlib, tempfile, argparse
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def load_mod(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(SCRIPTS)}, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
st = load_mod("st", "send-text.py")
SCRATCH = tempfile.mkdtemp()
st.STATE_DIR = SCRATCH
st.LEDGER = os.path.join(SCRATCH, "sent-text.jsonl")
st.SWITCH = os.path.join(SCRATCH, "text-sending-on")
for name, value in (("GHL_KEY_PATH", "k"), ("GHL_LOCATION_PATH", "locTest"), ("FROM_NUMBER_PATH", "07700 900555")):
    path = os.path.join(SCRATCH, name)
    open(path, "w").write(value)
    setattr(st, name, path)
AF = st.AF
import agent_email_format as aef
def trial_ended():                                  # what Kevin's cut-over PR does: the entry moves to TRIAL_ENDED
    aef.TRIAL_ENDED["rec7aHLK1Q8fMLRXH"] = "2026-10-03T08:00:00Z"
    aef.TRIAL_AGENTS.clear()
CFV = "rec7aHLK1Q8fMLRXH"
OTHER = "recOtherAgent0001"
OUTPUT = ("TEXT TO: 07700 900123\\nTEXT: Hello Sam, your rent due 1 Oct has not reached us. Please pay or reply. Roy, Agile Lets\\n"
          "TO: sam@example.com\\nFROM: info@agilelets.co.uk\\nSUBJECT: Your rent at 1 Example Road\\n---\\nHello Sam,\\n\\nBody.\\n\\n"
          "Kind regards\\nRoy Lavin\\nAgile Lets\\n\\n**Carrying this out will involve:** an email and a text.")
def card(output=OUTPUT, outcome="Approved as-is", agent=CFV, name="RENT LATE: Unit 9, rent due 1 Oct (reminder)", ttype="Correspondence",
         approved_at="2026-10-03T10:00:00.000Z", tenants=("recTenantTest0001",), status="Today", notes="RENT CHECK KEY: recT:2026-10-01:1"):
    return {"id": "recCARDTEXT000001", "createdTime": "2026-10-03T09:00:00.000Z", "fields": {
        AF["name"]: name, AF["agentOutput"]: output, AF["approvalOutcome"]: outcome, AF["taskType"]: ttype,
        AF["sentForApprovalBy"]: [agent], AF["teamMember"]: [agent], AF["approvedAt"]: approved_at,
        AF["notes"]: notes, AF["tenants"]: list(tenants), AF["status"]: status}}
TENANT_NUMBER = {"recTenantTest0001": "+44 7700 900123"}
CALLS = []
def run(rec, dry=False, contact="ghlContact1", ghl_fail=None, contact_phone="+447700900123"):
    CALLS.clear()
    def airtable(method, path, payload=None):
        CALLS.append(["airtable", method, path.split("?")[0]])
        if path.startswith(st.TENANTS + "/"):
            tid = path.split("/")[1].split("?")[0]
            return {"id": tid, "fields": {st.TENANT_PHONE: TENANT_NUMBER.get(tid, "")}}
        if method == "PATCH":
            return {}
        return rec
    def ghl(method, path, payload=None):
        CALLS.append(["ghl", method, path.split("?")[0], payload])
        if path.startswith("/contacts/search/duplicate"):
            return {"contact": {"id": contact, "phone": contact_phone} if contact else None}
        if path == "/contacts/upsert":
            return {"contact": {"id": "ghlNew", "phone": contact_phone}}
        if ghl_fail:
            raise SystemExit(ghl_fail)
        return {"messageId": "msg1"}
    st.airtable, st.ghl = airtable, ghl
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            st.cmd_send(argparse.Namespace(task=rec["id"], dry_run=dry))
        return {"ok": buf.getvalue().strip(), "calls": list(CALLS)}
    except SystemExit as e:
        return {"refused": str(e.code), "calls": list(CALLS)}
def sends(result): return [c for c in result["calls"] if c[0] == "ghl" and c[2] == "/conversations/messages"]
`;
function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('an edit after approval cannot move the text into the email', () => {
  it('revise, retype and the email send door all refuse TEXT lines below the headers', () => {
    const r = py(`
se = load_mod("se", "send-email.py")
ad = load_mod("ad", "agent-dispatch.py")
TEXT_BLOCK = "TEXT TO: 07700 900123\\nTEXT: Hello Sam, your rent due 1 Oct has not reached us. Please pay or reply. Roy, Agile Lets\\n"
moved = OUTPUT.replace(TEXT_BLOCK, "").replace("Body.", "Body, edited.\\n" + TEXT_BLOCK.strip())
out = {}
try:
    se.parse_output(moved, "recX"); out["send"] = "parsed"
except SystemExit as e:
    out["send"] = str(e.code)
out["sendGood"] = bool(se.parse_output(OUTPUT, "recX")["to"])
patched = []
ad.patch_task = lambda tid, fields: patched.append(tid)
def view(outcome, ttype, output):
    return {"id": "recX", "outcome": outcome, "feedback": "say edited", "agentOutput": output, "taskType": ttype, "notes": "", "name": "RENT LATE: Unit 9"}
ad.get_task = lambda tid: {}
path = os.path.join(SCRATCH, "rev.md")
for key, revised in (("revise", moved), ("reviseGood", OUTPUT.replace("Body.", "Body, edited."))):
    open(path, "w").write(revised)
    ad.task_view = lambda rec: view("Approved with minor edits", "Correspondence", OUTPUT)
    try:
        ad.cmd_revise(argparse.Namespace(task="recX", output_file=path)); out[key] = "stored"
    except SystemExit as e:
        out[key] = str(e.code)
ad.task_view = lambda rec: view("Approved as-is", "Admin", moved)
try:
    ad.cmd_retype(argparse.Namespace(task="recX", type="Correspondence", reason="it is an email")); out["retype"] = "retyped"
except SystemExit as e:
    out["retype"] = str(e.code)
mixed = OUTPUT.replace("TEXT TO:", "Text to:").replace("TEXT:", "Text:")
for key, o in (("mixedAbove", mixed),
               ("mixedBelow", OUTPUT.replace(TEXT_BLOCK, "").replace("Body.", "Body.\\nText to: 07700 900123\\nText: Hello Sam")),
               ("spacedAbove", OUTPUT.replace("TEXT TO:", "TEXT TO :"))):
    try:
        se.parse_output(o, "recX"); out[key] = "parsed"
    except SystemExit as e:
        out[key] = str(e.code)
try:
    aef.validate_submission(mixed); out["mixedSubmit"] = "accepted"
except aef.EmailFormatError as e:
    out["mixedSubmit"] = str(e)
out["patched"] = patched
print(json.dumps(out))`);
    expect(r.send).toMatch(/TEXT line sits below the email's headers/);
    expect(r.sendGood).toBe(true);
    expect(r.revise).toMatch(/refusing to revise recX .*TEXT line sits below/);
    expect(r.reviseGood).toBe('stored');
    expect(r.retype).toMatch(/refusing to retype recX to Correspondence: .*TEXT line sits below/);
    // Only the good revision was written.
    expect(r.patched).toEqual(['recX']);
    // One spelling, in capitals: "Text to:" is refused above the headers, at submit and at the send door ...
    expect(r.mixedAbove).toMatch(/exactly as "TEXT TO:" and "TEXT:", in capitals, not 'Text to'/);
    expect(r.mixedSubmit).toMatch(/in capitals/);
    expect(r.spacedAbove).toMatch(/in capitals, not 'TEXT TO'/);
    // ... and a "text to:" line below them, in any case, is refused rather than emailed with its number.
    expect(r.mixedBelow).toMatch(/TEXT line sits below the email's headers/);
  });
});

describe('the text route refuses everything but an approved, matching card, and only once switched on', () => {
  it('switched off: nothing is sent, whatever the card', () => {
    const r = py(`
res = run(card())
print(json.dumps({"refused": res.get("refused"), "sends": len(sends(res)), "airtable": len([c for c in res["calls"] if c[0] == "airtable"])}))`);
    expect(r.refused).toMatch(/text sending is switched off/);
    expect(r.sends).toBe(0);
    // Refused before anything is even read.
    expect(r.airtable).toBe(0);
  });

  it('switched on: a trial card, an unapproved card, a card with no approval marks, a non-Correspondence card, and one with no text are refused', () => {
    const r = py(`
open(st.SWITCH, "w").write("on")
out = {}
res = run(card()); out["trial"] = [res.get("refused", "")[:80], len(sends(res))]
res = run(card(agent=OTHER)); out["trialByName"] = [res.get("refused", "")[:80], len(sends(res))]
trial_ended()
for key, rec in (
                 ("unapproved", card(outcome="")), ("changes", card(outcome="Changes requested")),
                 ("minorEdits", card(outcome="Approved with minor edits")), ("notRentCard", card(name="Book the boiler", notes="")),
                 ("completed", card(status="Completed")), ("cancelled", card(status="Cancelled")),
                 ("trialSettled", card(notes="RENT CHECK KEY: recT:2026-10-01:1\\n[03 Oct 2026] TRIAL CHECKED: Kevin's verdict")),
                 ("stamped", card(notes="RENT CHECK KEY: recT:2026-10-01:1\\n[03 Oct 2026 10:00 — send-text] SENT: text to the number ending 123")),
                 ("copied", card(approved_at="2026-10-03T08:30:00.000Z")), ("blankApproval", card(approved_at=None)),
                 ("inTrial", card(approved_at="2026-10-03T07:00:00.000Z")), ("admin", card(ttype="Admin")),
                 ("noText", card(output=OUTPUT.split("TO: sam")[0].replace("TEXT TO: 07700 900123\\n", "").replace(
                      "TEXT: Hello Sam, your rent due 1 Oct has not reached us. Please pay or reply. Roy, Agile Lets\\n", "") + "TO: sam" + OUTPUT.split("TO: sam")[1]))):
    res = run(rec)
    out[key] = [res.get("refused", "")[:160], len(sends(res))]
print(json.dumps(out))`);
    expect(r.trial[0]).toMatch(/trial card and is never texted/);
    expect(r.trialByName[0]).toMatch(/trial card and is never texted/);
    expect(r.unapproved[0]).toMatch(/is not approved/);
    expect(r.changes[0]).toMatch(/is not approved/);
    // An edit he asked for cannot be checked against a text: only a plain approval is texted.
    expect(r.minorEdits[0]).toMatch(/is not approved as-is/);
    expect(r.notRentCard[0]).toMatch(/not a rent lane's tenant card/);
    expect(r.completed[0]).toMatch(/closed or was settled on the trial/);
    expect(r.cancelled[0]).toMatch(/closed or was settled on the trial/);
    // At the cut-over, the cards approved during the trial are history.
    expect(r.trialSettled[0]).toMatch(/closed or was settled on the trial/);
    // The task's own SENT stamp stops a second text even with no ledger on this Mac.
    expect(r.stamped[0]).toMatch(/carries a SENT stamp/);
    // After the trial ended, but before the task existed: copied, not given.
    expect(r.copied[0]).toMatch(/reads 'Approved as-is', but its Approved At is earlier/);
    expect(r.blankApproval[0]).toMatch(/trial card and is never texted: it carries no readable approval time/);
    // Approved during the trial and not yet settled when the cut-over merged: never texted.
    expect(r.inTrial[0]).toMatch(/trial card and is never texted: it was approved during the trial run/);
    expect(r.admin[0]).toMatch(/not Correspondence/);
    expect(r.noText[0]).toMatch(/carries no TEXT TO and TEXT lines/);
    for (const k of Object.keys(r)) expect(r[k][1]).toBe(0);
  });

  it('the number must be a UK mobile and the Contact Number of a tenant linked to the task', () => {
    const r = py(`
open(st.SWITCH, "w").write("on")
trial_ended()
landline = OUTPUT.replace("TEXT TO: 07700 900123", "TEXT TO: 01234 567890")
other = OUTPUT.replace("TEXT TO: 07700 900123", "TEXT TO: 07700 900999")
long = OUTPUT.replace("Please pay or reply.", "x" * 300)
out = {k: run(rec).get("refused", "")[:90] for k, rec in (("landline", card(output=landline)), ("other", card(output=other)),
                                                          ("noTenant", card(tenants=())), ("long", card(output=long)))}
print(json.dumps(out))`);
    expect(r.landline).toMatch(/not a UK mobile/);
    expect(r.other).toMatch(/not the Contact Number of a tenant/);
    expect(r.noTenant).toMatch(/not the Contact Number of a tenant/);
    expect(r.long).toMatch(/the most is 300/);
  });

  it('an approved, matching card is texted verbatim, once; a second send, or one that may have gone, is refused', () => {
    const r = py(`
open(st.SWITCH, "w").write("on")
trial_ended()
first = run(card())
again = run(card())
ledger = [json.loads(l)["event"] for l in open(st.LEDGER)]
os.remove(st.LEDGER)
new = run(card(), contact="")
os.remove(st.LEDGER)
fail4 = run(card(), ghl_fail="ERROR: GoHighLevel 422: invalid")
retry = run(card())
os.remove(st.LEDGER)
fail5 = run(card(), ghl_fail="ERROR: GoHighLevel 502: bad gateway")
after5 = run(card())
os.remove(st.LEDGER)
wrongPhone = run(card(), contact_phone="+447700900999")
madeWrong = run(card(), contact="", contact_phone="+447700900999")
os.remove(st.FROM_NUMBER_PATH)
noFrom = run(card())
print(json.dumps({"noFrom": [noFrom.get("refused", ""), len(sends(noFrom))], "wrongPhone": wrongPhone.get("refused", ""), "wrongPhoneSends": len(sends(wrongPhone)),
                  "madeWrong": madeWrong.get("refused", ""), "madeWrongSends": len(sends(madeWrong)),"sent": sends(first), "ok": first["ok"], "again": again.get("refused", ""), "ledger": ledger,
                  "upsert": [c[2] for c in new["calls"] if c[0] == "ghl"], "retry": len(sends(retry)), "after5": after5.get("refused", "")}))`);
    expect(r.sent).toHaveLength(1);
    // From the Agile Lets number on file, never the location's default.
    expect(r.sent[0][3]).toEqual({ type: 'SMS', contactId: 'ghlContact1', fromNumber: '+447700900555',
      message: 'Hello Sam, your rent due 1 Oct has not reached us. Please pay or reply. Roy, Agile Lets' });
    expect(JSON.parse(r.ok)).toEqual({ sent: 'recCARDTEXT000001', numberEnds: '123' });
    expect(r.again).toMatch(/already texted, or its text may have gone \(sent/);
    expect(r.ledger).toEqual(['intent', 'sent']);
    // Not yet a contact in GoHighLevel: made one, then sent.
    expect(r.upsert).toEqual(['/contacts/search/duplicate', '/contacts/upsert', '/conversations/messages']);
    // Refused by GoHighLevel (4xx): nothing left, so it may be sent again.
    expect(r.retry).toBe(1);
    // Anything else may have gone: never sent twice.
    expect(r.after5).toMatch(/may have gone \(uncertain/);
    // The text goes to the contact's own phone: a contact holding another number is refused.
    expect([r.wrongPhone, r.wrongPhoneSends]).toEqual([expect.stringMatching(/holds a different phone/), 0]);
    expect([r.madeWrong, r.madeWrongSends]).toEqual([expect.stringMatching(/holds a different phone/), 0]);
    // No Agile Lets sending number on file: nothing goes from a default number.
    expect(r.noFrom).toEqual([expect.stringMatching(/no Agile Lets sending number is on file/), 0]);
  });

  it('a dry run checks the card, finds the contact read only, and sends nothing (even switched off, even on trial)', () => {
    const r = py(`
res = run(card(outcome=""), dry=True)
print(json.dumps({"out": json.loads(res["ok"]), "ghl": [[c[1], c[2]] for c in res["calls"] if c[0] == "ghl"]}))`);
    expect(r.out).toMatchObject({ dryRun: true, switchedOn: false, contactFound: true, numberEnds: '123' });
    expect(r.out.trial).toMatch(/trial run/);
    expect(r.ghl).toEqual([['GET', '/contacts/search/duplicate']]);
  });

  it('UK mobiles in every common spelling; anything else is not one', () => {
    const r = py(`
print(json.dumps([st.uk_mobile(x) for x in ("07700 900123", "+44 7700 900123", "447700900123", "0044 7700 900123",
                                            "(07700) 900-123", "01234 567890", "0770090012", "", None)]))`);
    expect(r).toEqual(['+447700900123', '+447700900123', '+447700900123', '+447700900123', '+447700900123', '', '', '', '']);
  });

  it('the email never carries the text, and the field map is the email sender\'s', () => {
    const r = py(`
import agent_email_format as aef
se = load_mod("se", "send-email.py")
mail = aef.parse_output(OUTPUT)
print(json.dumps({"to": mail["to"], "body": mail["body"], "text": list(aef.parse_text(OUTPUT)),
                  "none": aef.parse_text(OUTPUT.split("TEXT: ")[0].replace("TEXT TO: 07700 900123\\n", "") + OUTPUT.split("Roy, Agile Lets\\n", 1)[1]),
                  "sameMap": all(se.AF[k] == v for k, v in st.AF.items() if k in se.AF), "half": None}))`);
    const bad = py(`
import agent_email_format as aef
below = OUTPUT.replace("TEXT TO: 07700 900123\\nTEXT: Hello Sam, your rent due 1 Oct has not reached us. Please pay or reply. Roy, Agile Lets\\n", "") + "\\nTEXT TO: 07700 900123\\nTEXT: hi"
dash = OUTPUT.replace("Hello Sam, your rent", "Hello --- Sam, your rent")
prose = OUTPUT.replace("Body.", "Text: reply STOP to opt out.")
subject = OUTPUT.replace("SUBJECT: Your rent at 1 Example Road", "SUBJECT: Rent --- October")
out = {}
for key, o in (("below", below), ("dash", dash), ("prose", prose), ("subject", subject)):
    try:
        aef.parse_text(o); out[key] = "ok"
    except aef.EmailFormatError as e:
        out[key] = str(e)
try:
    aef.validate_submission(dash); out["submit"] = "accepted"
except aef.EmailFormatError as e:
    out["submit"] = str(e)
print(json.dumps(out))`);
    expect(bad.below).toMatch(/sits below the email's headers/);
    expect(bad.dash).toMatch(/a header line contains "---"/);
    // An email that merely says "Text: ..." is untouched.
    expect(bad.prose).toBe('ok');
    // A "---" in any header would cut the email there and push the text into its body: refused.
    expect(bad.subject).toMatch(/a header line contains "---"/);
    // And a bad text is refused at submit, before Kevin ever sees the card.
    expect(bad.submit).toMatch(/a header line contains "---"/);
    expect(r.to).toEqual(['sam@example.com']);
    expect(r.body).not.toMatch(/TEXT|07700/);
    expect(r.text).toEqual(['07700 900123', 'Hello Sam, your rent due 1 Oct has not reached us. Please pay or reply. Roy, Agile Lets']);
    expect(r.none).toBeNull();
    expect(r.sameMap).toBe(true);
  });
});
