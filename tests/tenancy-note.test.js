// The tenancy shows every action (Kevin, 5 Oct 2026, on the Connaught Road card: "ensure the tenancy record is
// updated with all the actions"). When a rent lane's tenant card is sent, the send door itself leaves one dated
// comment on each tenancy the card names. Drives the REAL send-email.py with the worker and Airtable stubbed:
// every id, address and amount is invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(root, 'scripts');
const EMAIL = 'TO: sam@example.com\nFROM: info@agilelets.co.uk\nSUBJECT: Your rent at 1 Example Road\n---\nHello Sam,\n\n'
  + 'Your rent due 30 Sep has not reached us.\n\nKind regards\nRoy Lavin\nAgile Lets\n\n'
  + '**Carrying this out will involve:** sending the reminder to the tenant.';

function send(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenancy-note-'));
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, argparse, io, contextlib, urllib.parse, re
sys.argv = ["send-email.py"]
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
spec = importlib.util.spec_from_file_location("se", ${JSON.stringify(path.join(SCRIPTS, 'send-email.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
import agent_email_format as aef
aef.TRIAL_ENDED["rec7aHLK1Q8fMLRXH"] = "2026-10-05T11:44:00Z"   # off trial, as since 5 Oct 2026, whatever this branch was cut from
aef.TRIAL_AGENTS.pop("rec7aHLK1Q8fMLRXH", None)
a = json.loads(sys.stdin.read())
m.SENT_LEDGER = a["dir"] + "/sent-email.jsonl"; m.STATE_DIR = a["dir"]
F = {m.AF["name"]: a["name"], m.AF["agentOutput"]: a["output"], m.AF["taskType"]: {"name": "Correspondence"},
     m.AF["status"]: {"name": "Today"}, m.AF["approvalOutcome"]: {"name": "Approved as-is"},
     m.AF["approvedAt"]: "2026-10-05T13:00:00.000Z", m.AF["notes"]: a["notes"],
     m.AF["sentForApprovalBy"]: a["holders"], m.AF["teamMember"]: a["holders"], aef.TASK_TENANCIES: a["tenancies"]}
m.get_task = lambda tid: {"id": tid, "createdTime": "2026-10-05T12:00:00.000Z", "fields": F}
m.load_approved.__globals__["approval_evidence_problem"] = lambda f, created: ""
sent, comments = [], []
def worker(url, payload=None):
    sent.append(payload["to"]); return {"id": "msg-1"}
m.worker_call = worker
LOOKUPS = []
def api(method, url, payload=None):
    if url.endswith("/comments"):
        if a.get("commentFails") and (a["commentFails"] is True or len(comments) >= a["commentFails"]):
            if a.get("failAsExit"):
                sys.exit("ERROR: Airtable POST 422: INVALID_REQUEST")
            raise RuntimeError("Airtable 503")
        comments.append([url.split("/v0/")[1], payload["text"]])
        return {}
    q = urllib.parse.unquote(url)
    if "tblX4elTuu01gwBYh?" in url:
        LOOKUPS.append("tenants")
        # One record per tenant sharing the address: a.get("tenants") is a list of their Tenancies links.
        return {"records": [{"id": "recTENANTNOTE%04d" % i, "fields": {m.TENANT_TENANCIES: ts}}
                            for i, ts in enumerate(a.get("tenants", [a.get("tenantTenancies", [])]))]
                if "sam@example.com" in q else []}
    if "tblqB8b22hKBL4PF1?" in url:
        LOOKUPS.append("tasks")
        return {"records": [{"id": "recOPENRENT%06d" % i, "fields": {m.TASK_TENANCIES: [t]}} for i, t in enumerate(a.get("chased", []))]}
    if "tblN51a88qTDB6iMH?" in url:
        LOOKUPS.append("tenancies")
        asked = set(re.findall(r"RECORD_ID\\(\\)='(rec\\w+)'", q))
        return {"records": [{"id": t, "fields": {m.TENANCY_STATUS: s}} for t, s in a.get("tenancyStatus", {}).items() if t in asked]}
    return {}
m.api = api
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m.cmd_send(argparse.Namespace(task="recRENTCARD000001", dry_run=False, rule=None))
ledger = [json.loads(l)["event"] for l in open(m.SENT_LEDGER)]
print(json.dumps({"out": json.loads(buf.getvalue().strip().splitlines()[-1]), "sent": sent, "comments": comments, "ledger": ledger,
                  "lookups": LOOKUPS}))
`], { input: JSON.stringify({ dir, output: EMAIL, name: 'RENT LATE: Unit 9 – 1 Example Road, rent due 30 Sep (reminder)',
    notes: 'RENT CHECK KEY: recTENANCYNOTE001:2026-09-30:1', holders: ['rec7aHLK1Q8fMLRXH'], tenancies: ['recTENANCYNOTE001'], ...opts }),
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('which cards leave a note on the tenancy', () => {
  it('a rent lane card by its name, its key line or its holder; the tenancies it links, or its PLAN FOR', () => {
    const r = JSON.parse(execFileSync('python3', ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import agent_email_format as aef
t = aef.tenancies_to_note
T = ["recTENANCYNOTE001"]
plan = "PLAN FOR: recTENANCYNOTE002\\nPLAN: 2026-10-10 £100.00\\nTO: a@b.com\\n---\\nx"
print(json.dumps({"byName": t("RENT LATE: Unit 9", "", [], T), "byKey": t("Renamed", "RENT CHECK KEY: x", [], T),
                  "byHolder": t("INBOUND: reply from Sam", "", ["rec7aHLK1Q8fMLRXH"], T), "cap": t("RENT CAP: Unit 9", "", [], T),
                  "other": t("INBOUND: council letter", "", ["recOtherAgent0001"], T), "plan": t("INBOUND: reply", "", ["rec7aHLK1Q8fMLRXH"], [], plan),
                  "none": t("RENT LATE: Unit 9", "", [], []), "junk": t("RENT LATE: Unit 9", "", [], ["Unit 9"]),
                  "comment": aef.tenancy_comment("05 Oct 2026 14:00", "emailed the tenant (sam@example.com): \\"Your rent\\"", "recRENTCARD000001")}))`],
    { encoding: 'utf8' }).trim().split('\n').pop());
    expect([r.byName, r.byKey, r.byHolder, r.cap]).toEqual([['recTENANCYNOTE001'], ['recTENANCYNOTE001'], ['recTENANCYNOTE001'], ['recTENANCYNOTE001']]);
    expect(r.other).toBeNull();
    expect(r.plan).toEqual(['recTENANCYNOTE002']);
    expect([r.none, r.junk]).toEqual([[], []]);
    expect(r.comment).toBe('05 Oct 2026 14:00: Agile Lets emailed the tenant (sam@example.com): "Your rent" (rent task recRENTCARD000001).');
  });
});

describe('the reply lane and the tenancy note read the same open rent tasks', () => {
  it('OPEN_RENT_TASKS in send-email.py is the routing formula in agent-dispatch.py', () => {
    const r = JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, sys, os
sys.argv = ["x"]
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(SCRIPTS)}, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
print(json.dumps([load("se", "send-email.py").OPEN_RENT_TASKS, load("ad", "agent-dispatch.py").RENT_REPLY_FORMULA]))`],
    { encoding: 'utf8' }).trim().split('\n').pop());
    expect(r[0]).toBe(r[1]);
  });
});

describe('send-email.py notes the tenancy after a rent card goes', () => {
  it('one dated comment on the linked tenancy, after the email went', () => {
    const r = send({});
    expect(r.sent).toEqual(['sam@example.com']);
    expect(r.ledger).toEqual(['intent', 'sent']);
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0][0]).toBe('appnqjDpqDniH3IRl/tblN51a88qTDB6iMH/recTENANCYNOTE001/comments');
    expect(r.comments[0][1]).toMatch(/^\d\d \w{3} \d{4} \d\d:\d\d: Agile Lets emailed the tenant \(sam@example\.com\): "Your rent at 1 Example Road" \(rent task recRENTCARD000001\)\.$/);
    expect(r.out.tenancyNoted).toEqual(['recTENANCYNOTE001']);
    expect(r.out.tenancyNoteProblem).toBeNull();
  });

  it('a late agent-managed rent card says it emailed the letting agent, never the tenant (Kevin, 5 Oct 2026)', () => {
    const r = send({ name: 'AGENT RENT LATE: Unit 9 – 1 Example Road, rent due 30 Sep' });
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0][1]).toMatch(/: Agile Lets emailed the letting agent \(sam@example\.com\): "Your rent at 1 Example Road"/);
  });

  it('any other card notes nothing; a rent card naming no tenancy, or a failed comment, is said and the email still stands', () => {
    const other = send({ name: 'INBOUND: council letter', notes: '', holders: ['recOtherAgent0001'] });
    expect([other.sent, other.comments, other.out.tenancyNoted, other.out.tenancyNoteProblem]).toEqual([['sam@example.com'], [], [], null]);
    const none = send({ tenancies: [] });
    expect(none.sent).toEqual(['sam@example.com']);
    expect(none.out.tenancyNoteProblem).toBe('the card names no tenancy and its address matches no tenant with a tenancy, so no tenancy comment was written');
    const failed = send({ commentFails: true });
    expect([failed.sent, failed.ledger]).toEqual([['sam@example.com'], ['intent', 'sent']]);
    expect(failed.out.tenancyNoteProblem).toBe('the tenancy comment could not be written: Airtable 503');
    // Airtable's own refusal ends api() with SystemExit: still said, still exit 0, the email still stands.
    const exited = send({ commentFails: true, failAsExit: true });
    expect([exited.sent, exited.out.tenancyNoteProblem]).toEqual([['sam@example.com'], 'the tenancy comment could not be written: ERROR: Airtable POST 422: INVALID_REQUEST']);
  });

  it('a reply to a tenant names no tenancy: it is found by the address it went to, only the one live tenancy a rent task chases', () => {
    const REPLY = { name: 'INBOUND: reply from Sam', notes: '', tenancies: [] };
    const r = send({ ...REPLY, tenantTenancies: ['recTENANCYNOTE001', 'recTENANCYOLD0001', 'recTENANCYCALM001'],
      chased: ['recTENANCYNOTE001', 'recTENANCYOLD0001', 'recTENANCYELSE001'],
      tenancyStatus: { recTENANCYNOTE001: 'Live', recTENANCYOLD0001: 'Ended', recTENANCYCALM001: 'Live' } });
    expect(r.lookups).toEqual(['tenants', 'tasks', 'tenancies']);
    expect(r.out.tenancyNoted).toEqual(['recTENANCYNOTE001']);
    expect(r.comments.map((c) => c[0])).toEqual(['appnqjDpqDniH3IRl/tblN51a88qTDB6iMH/recTENANCYNOTE001/comments']);
    // An address several tenants share, both chased: nothing is noted, and it says how many matched.
    const shared = send({ ...REPLY, tenants: [['recTENANCYNOTE001'], ['recTENANCYNOTE002']], chased: ['recTENANCYNOTE001', 'recTENANCYNOTE002'],
      tenancyStatus: { recTENANCYNOTE001: 'Live', recTENANCYNOTE002: 'Live' } });
    expect([shared.comments, shared.out.tenancyNoted]).toEqual([[], []]);
    expect(shared.out.tenancyNoteProblem).toBe('the card names no tenancy and its address matches 2 live tenancies with an open rent task, not one, so no tenancy comment was written');
    // Nobody chased at that address: nothing noted.
    const calm = send({ ...REPLY, tenantTenancies: ['recTENANCYCALM001'], chased: [], tenancyStatus: { recTENANCYCALM001: 'Live' } });
    expect([calm.comments, calm.out.tenancyNoteProblem]).toEqual([[], 'the card names no tenancy and its address matches 0 live tenancies with an open rent task, not one, so no tenancy comment was written']);
    // An unknown address: said as such.
    expect(send({ ...REPLY, output: EMAIL.replace('sam@example.com', 'nobody@example.com') }).out.tenancyNoteProblem)
      .toBe('the card names no tenancy and its address matches no tenant with a tenancy, so no tenancy comment was written');
    // A card that links its tenancy never looks anyone up.
    expect(send({}).lookups).toEqual([]);
  });

  it('two tenancies, the second comment fails: the first is reported as written, so nobody writes it twice', () => {
    const r = send({ tenancies: ['recTENANCYNOTE001', 'recTENANCYNOTE002'], commentFails: 1 });
    expect(r.out.tenancyNoted).toEqual(['recTENANCYNOTE001']);
    expect(r.out.tenancyNoteProblem).toBe('the tenancy comment could not be written: Airtable 503');
  });

  it('a PLAN FOR card that links no tenancy is noted on the plan\'s tenancy', () => {
    const plan = 'PLAN FOR: recTENANCYNOTE003\nPLAN: 2026-10-10 £100.00\n' + EMAIL;
    const r = send({ name: 'INBOUND: reply from Sam', notes: '', tenancies: [], output: plan });
    expect(r.out.tenancyNoted).toEqual(['recTENANCYNOTE003']);
    expect(r.lookups).toEqual([]);
  });
});
