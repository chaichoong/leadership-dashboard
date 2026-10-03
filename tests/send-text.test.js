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
for name, value in (("GHL_KEY_PATH", "k"), ("GHL_LOCATION_PATH", "locTest")):
    path = os.path.join(SCRATCH, name)
    open(path, "w").write(value)
    setattr(st, name, path)
AF = st.AF
CFV = "rec7aHLK1Q8fMLRXH"
OTHER = "recOtherAgent0001"
OUTPUT = ("TEXT TO: 07700 900123\\nTEXT: Hello Sam, your rent due 1 Oct has not reached us. Please pay or reply. Roy, Agile Lets\\n"
          "TO: sam@example.com\\nFROM: info@agilelets.co.uk\\nSUBJECT: Your rent at 1 Example Road\\n---\\nHello Sam,\\n\\nBody.\\n\\n"
          "Kind regards\\nRoy Lavin\\nAgile Lets\\n\\n**Carrying this out will involve:** an email and a text.")
def card(output=OUTPUT, outcome="Approved as-is", agent=OTHER, name="Rent reminder: Unit 9", ttype="Correspondence",
         approved_at="2026-10-03T10:00:00.000Z", tenants=("recTenantTest0001",)):
    return {"id": "recCARDTEXT000001", "createdTime": "2026-10-03T09:00:00.000Z", "fields": {
        AF["name"]: name, AF["agentOutput"]: output, AF["approvalOutcome"]: outcome, AF["taskType"]: ttype,
        AF["sentForApprovalBy"]: [agent], AF["teamMember"]: [agent], AF["approvedAt"]: approved_at,
        AF["notes"]: "", AF["tenants"]: list(tenants)}}
TENANT_NUMBER = {"recTenantTest0001": "+44 7700 900123"}
CALLS = []
def run(rec, dry=False, contact="ghlContact1", ghl_fail=None):
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
            return {"contact": {"id": contact} if contact else None}
        if path == "/contacts/upsert":
            return {"contact": {"id": "ghlNew"}}
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
for key, rec in (("trial", card(agent=CFV)), ("trialByName", card(name="RENT LATE: Unit 9, rent due 1 Oct (reminder)")),
                 ("unapproved", card(outcome="")), ("changes", card(outcome="Changes requested")),
                 ("noMarks", card(approved_at=None)), ("admin", card(ttype="Admin")),
                 ("noText", card(output=OUTPUT.split("TO: sam")[0].replace("TEXT TO: 07700 900123\\n", "").replace(
                      "TEXT: Hello Sam, your rent due 1 Oct has not reached us. Please pay or reply. Roy, Agile Lets\\n", "") + "TO: sam" + OUTPUT.split("TO: sam")[1]))):
    res = run(rec)
    out[key] = [res.get("refused", "")[:80], len(sends(res))]
print(json.dumps(out))`);
    expect(r.trial[0]).toMatch(/trial card and is never texted/);
    expect(r.trialByName[0]).toMatch(/trial card and is never texted/);
    expect(r.unapproved[0]).toMatch(/is not approved/);
    expect(r.changes[0]).toMatch(/is not approved/);
    expect(r.noMarks[0]).toMatch(/reads 'Approved as-is', but/);
    expect(r.admin[0]).toMatch(/not Correspondence/);
    expect(r.noText[0]).toMatch(/carries no TEXT TO and TEXT lines/);
    for (const k of Object.keys(r)) expect(r[k][1]).toBe(0);
  });

  it('the number must be a UK mobile and the Contact Number of a tenant linked to the task', () => {
    const r = py(`
open(st.SWITCH, "w").write("on")
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
print(json.dumps({"sent": sends(first), "ok": first["ok"], "again": again.get("refused", ""), "ledger": ledger,
                  "upsert": [c[2] for c in new["calls"] if c[0] == "ghl"], "retry": len(sends(retry)), "after5": after5.get("refused", "")}))`);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0][3]).toEqual({ type: 'SMS', contactId: 'ghlContact1',
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
  });

  it('a dry run checks the card, finds the contact read only, and sends nothing (even switched off, even on trial)', () => {
    const r = py(`
res = run(card(agent=CFV, outcome=""), dry=True)
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
    expect(r.to).toEqual(['sam@example.com']);
    expect(r.body).not.toMatch(/TEXT|07700/);
    expect(r.text).toEqual(['07700 900123', 'Hello Sam, your rent due 1 Oct has not reached us. Please pay or reply. Roy, Agile Lets']);
    expect(r.none).toBeNull();
    expect(r.sameMap).toBe(true);
  });
});
