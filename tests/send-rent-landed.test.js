// THE RENT IS READ AGAIN AT THE SEND (Kevin, 16 Nov 2026; cash-flow-voids lesson of 30 Oct 2026: a chase
// reached a tenant for rent Kevin had already seen arrive). agent-dispatch.py refuses a RENT LATE card when
// the bank shows the cycle's rent at SUBMIT; Kevin approves later, and the rent often lands in between. The
// email door and the text door now read the bank again, through the same rent_landed_state the card used,
// and refuse to send a chase whose rent has landed. These drive the REAL send scripts with Airtable and the
// worker stubbed: every network door raises, no test can send anything, and every id, name and number is
// invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
OWED = (date.today() - timedelta(days=6)).isoformat()
NAME = "RENT LATE: Unit 9 - 1 Example Road, rent due (reminder)"
OUTPUT = ("TEXT TO: 07700 900123\\nTEXT: Hello Sam, your rent has not reached us yet. Please pay or reply. Roy, Agile Lets\\n"
          "TO: sam@example.com\\nFROM: info@agilelets.co.uk\\nSUBJECT: Your rent at 1 Example Road\\n---\\nHello Sam,\\n\\n"
          "Your rent has not reached us.\\n\\nKind regards\\nRoy Lavin\\nAgile Lets\\n\\n"
          "**Carrying this out will involve:** an email and a text to the tenant.")
def fields(name=NAME):
    return {AF["name"]: name, AF["agentOutput"]: OUTPUT, AF["taskType"]: {"name": "Correspondence"},
            AF["status"]: {"name": "Today"}, AF["approvalOutcome"]: {"name": "Approved as-is"},
            AF["approvedAt"]: "2026-11-10T13:00:00.000Z", AF["notes"]: "RENT CHECK KEY: %s:%s:1" % (TENANCY, OWED),
            AF["sentForApprovalBy"]: ["rec7aHLK1Q8fMLRXH"], AF["teamMember"]: ["rec7aHLK1Q8fMLRXH"],
            AF["tenants"] if "tenants" in AF else ST.AF["tenants"]: ["recTenantRentAaaa"], aef.TASK_TENANCIES: [TENANCY]}
BANK, READS, SENT = [], [], []
STATE = {"bankFails": False, "rent": 500.0, "tenancyFound": True}
def rows_for(url):
    q = urllib.parse.unquote(url)
    if AD.TENANCIES_TABLE in q and AD.RENT_FIELD in q:
        READS.append("rent")
        if not STATE["tenancyFound"]:
            return {"records": []}
        return {"records": [{"id": TENANCY, "fields": {AD.RENT_FIELD: STATE["rent"], AD.RENT_DUE_DAY_FIELD: int(OWED[8:10])}}]}
    if AD.TRANSACTIONS_TABLE in q:
        READS.append("bank")
        if STATE["bankFails"]:
            return {"error": {"type": "SERVER_ERROR"}}
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
`;

function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('a late-rent message is refused at the send when the rent has landed since the card', () => {
  it('the email and the text both refuse, say what landed, and send nothing; with nothing landed both go', () => {
    const r = py(`
BANK[:] = [{"id": "recRentLineAaaaaa", "date": (date.today() - timedelta(days=1)).isoformat(), "amount": 500.0}]
landed = {"email": run("email"), "text": run("text")}
BANK[:] = []
clear = {"email": run("email"), "text": run("text")}
print(json.dumps({"landed": landed, "clear": clear}))`);
    for (const k of ['email', 'text']) {
      expect([k, r.landed[k].refused]).toEqual([k, expect.stringMatching(/the rent for the cycle due .* has arrived since the check ran: .*recRentLineAaaaaa/)]);
      expect(r.landed[k].refused).toMatch(/Nothing was sent/);
      expect(r.landed[k].refused).toMatch(/agent-dispatch\.py complete recRentCardAaaaa1 --evidence "rent arrived before the send/);
      expect([k, r.landed[k].sent]).toEqual([k, []]);
      expect([k, r.landed[k].reads]).toEqual([k, ['rent', 'bank']]);
      expect([k, r.clear[k].refused]).toEqual([k, null]);
      expect([k, r.clear[k].sent.length]).toEqual([k, 1]);
    }
  });

  it('a bank that cannot be read refuses as NOT CHECKED; part of the rent is still a chase; a dry run reports and sends nothing', () => {
    const r = py(`
STATE["bankFails"] = True
failed = run("email")
STATE["bankFails"] = False
BANK[:] = [{"id": "recPartLineAaaaaa", "date": (date.today() - timedelta(days=1)).isoformat(), "amount": 200.0}]
part = run("email")
BANK[:] = [{"id": "recRentLineAaaaaa", "date": (date.today() - timedelta(days=1)).isoformat(), "amount": 500.0}]
dry = run("email", dry=True)
print(json.dumps({"failed": [failed["refused"], failed["sent"]], "part": [part["refused"], len(part["sent"])],
                  "dry": [dry["refused"], dry["sent"], dry["out"].get("wouldSend"), dry["out"].get("rentLanded") or ""]}))`);
    expect(r.failed[0]).toMatch(/the bank could not be read again for this tenancy .*NOT CHECKED\. Nothing was sent/);
    expect(r.failed[1]).toEqual([]);
    expect(r.part).toEqual([null, 1]);
    expect(r.dry.slice(0, 3)).toEqual([null, [], false]);
    expect(r.dry[3]).toMatch(/has arrived since the check ran/);
  });

  it('a card the check cannot place is refused, never sent on a guess: no key line, no tenancy found, no rent on record', () => {
    const r = py(`
out = {}
CARD = dict(fields(), **{AF["notes"]: "no key line on this card"})
out["noKeyEmail"], out["noKeyText"] = run("email"), run("text")
CARD = fields()
STATE["tenancyFound"] = False
out["noTenancy"] = run("email")
STATE["tenancyFound"], STATE["rent"] = True, 0
out["noRent"], out["noRentText"] = run("email"), run("text")
print(json.dumps({k: [v["refused"], v["sent"], v["reads"]] for k, v in out.items()}))`);
    for (const k of ['noKeyEmail', 'noKeyText']) {
      expect([k, r[k][0]]).toEqual([k, expect.stringMatching(/a RENT LATE card with no RENT CHECK KEY line.*NOT CHECKED\. Nothing was sent/)]);
      expect([k, r[k][1], r[k][2]]).toEqual([k, [], []]);
    }
    expect(r.noTenancy[0]).toMatch(/the tenancy recTenancyLandAaa in its RENT CHECK KEY is not in the Tenancies table.*NOT CHECKED\. Nothing was sent/);
    expect(r.noTenancy.slice(1)).toEqual([[], ['rent']]);
    for (const k of ['noRent', 'noRentText']) {
      expect([k, r[k][0]]).toEqual([k, expect.stringMatching(/tenancy recTenancyLandAaa has no rent on its record.*NOT CHECKED\. Nothing was sent\. Put the rent on the tenancy record/)]);
      expect([k, r[k][1], r[k][2]]).toEqual([k, [], ['rent']]);
    }
  });

  it('only a RENT LATE card is read again: another rent lane card and an ordinary email touch no bank', () => {
    const r = py(`
BANK[:] = [{"id": "recRentLineAaaaaa", "date": (date.today() - timedelta(days=1)).isoformat(), "amount": 500.0}]
CARD = fields("INBOUND: reply from Sam about the boiler")
other = run("email")
print(json.dumps({"other": [other["refused"], len(other["sent"]), other["reads"]],
                  "state": AD.rent_landed_state("RENT ASK: Unit 9", CARD[AF["notes"]], "")}))`);
    expect(r.other).toEqual([null, 1, []]);
    expect(r.state).toEqual({ state: '' });
  });
});
