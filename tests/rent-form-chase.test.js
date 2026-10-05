// The form chase (Kevin, 5 Oct 2026: "We need to have the follow-up process for those and get Roy's involvement
// when we get to a certain stage where we're not getting engagement"; plan approved as-is the same day): a tenant
// sent a details-form link who has not filled it in gets reminder 1 on day 3, reminder 2 on day 7 (the agent's
// cards, Kevin approves each) and a task for Roy on day 10. These drive the REAL module on the three real link dates
// of 5 Oct 2026 (links made 4 and 5 Oct), with invented ids and names, and Airtable stubbed.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'scripts');

const HARNESS = `
import json, sys, os, types
from datetime import date, timedelta
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import rent_form_chase as fc
TN = fc.TN
def tenant(name, expires, saved=None, tenancies=("recTENANCYFORM001",)):
    return {TN["name"]: name, TN["expires"]: expires, TN["saved"]: saved, TN["tenancies"]: list(tenancies)}
SAM = "recTENANTFORM0001"            # link made 5 Oct (expires 19 Oct), like the first capped tenant
ALEX = "recTENANTFORM0002"           # link made 4 Oct (expires 18 Oct)
LIVE = {"recTENANCYFORM001", "recTENANCYFORM002"}
def task(status="Completed", sent=None): return {"id": "recT", "status": status, "sent": sent}
def plan(tid, f, chases, day, **k):
    item, stage = fc.plan(tid, f, chases, day, LIVE, **k)
    return [item and [item["step"], item["key"]], stage]
D = lambda m, d: date(2026, m, d)
`;
function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('the form chase: day 3, day 7, then Roy on day 10, and nothing once the form is saved', () => {
  it('the real dates: a link made 5 Oct is chased 8 Oct, 12 Oct and 15 Oct; one made 4 Oct, a day earlier', () => {
    const r = py(`
sam = tenant("Sam Example", "2026-10-19")
alex = tenant("Alex Example", "2026-10-18", tenancies=("recTENANCYFORM002",))
K = SAM + ":2026-10-05:"
out = {
  "today": plan(SAM, sam, {}, D(10, 5)),
  "r1": plan(SAM, sam, {}, D(10, 8)),
  "alexR1": plan(ALEX, alex, {}, D(10, 7)),
  "waitR2": plan(SAM, sam, {K + "1": task(sent=D(10, 8))}, D(10, 11)),
  "r2": plan(SAM, sam, {K + "1": task(sent=D(10, 8))}, D(10, 12)),
  "waitRoy": plan(SAM, sam, {K + "1": task(sent=D(10, 8)), K + "2": task(sent=D(10, 12))}, D(10, 14)),
  "roy": plan(SAM, sam, {K + "1": task(sent=D(10, 8)), K + "2": task(sent=D(10, 12))}, D(10, 15)),
  "done": plan(SAM, sam, {K + "1": task(sent=D(10, 8)), K + "2": task(sent=D(10, 12)), K + "roy": task()}, D(10, 20)),
}
print(json.dumps(out))`);
    expect(r.today).toEqual([null, 'the form is not filled in; reminder 1 on 8 Oct']);
    expect(r.r1).toEqual([['1', 'recTENANTFORM0001:2026-10-05:1'], '']);
    expect(r.alexR1).toEqual([['1', 'recTENANTFORM0002:2026-10-04:1'], '']);
    expect(r.waitR2).toEqual([null, 'the form is not filled in; reminder 2 on 12 Oct']);
    expect(r.r2).toEqual([['2', 'recTENANTFORM0001:2026-10-05:2'], '']);
    expect(r.waitRoy).toEqual([null, 'the form is not filled in; Roy on 15 Oct']);
    expect(r.roy).toEqual([['roy', 'recTENANTFORM0001:2026-10-05:roy'], '']);
    expect(r.done).toEqual([null, 'the form chase is done: Roy has it']);
  });

  it('saved since the link was made: nothing; saved before it: still chased', () => {
    const r = py(`
print(json.dumps({
  "savedAfter": plan(SAM, tenant("Sam", "2026-10-19", saved="2026-10-06T09:00:00.000Z"), {}, D(10, 9)),
  "savedBefore": plan(SAM, tenant("Sam", "2026-10-19", saved="2026-09-01T09:00:00.000Z"), {}, D(10, 9)),
}))`);
    expect(r.savedAfter).toEqual([null, '']);
    expect(r.savedBefore).toEqual([['1', 'recTENANTFORM0001:2026-10-05:1'], '']);
  });

  it('one step at a time: a reminder with Kevin holds the next; turned down ends the chase; a late approval keeps a 3-day gap', () => {
    const r = py(`
sam = tenant("Sam", "2026-10-19")
K = SAM + ":2026-10-05:"
print(json.dumps({
  "withKevin": plan(SAM, sam, {K + "1": task(status="Approval")}, D(10, 13)),
  "turnedDown": plan(SAM, sam, {K + "1": task(status="Cancelled")}, D(10, 13)),
  "lateApproval": plan(SAM, sam, {K + "1": task(sent=D(10, 11))}, D(10, 13)),
  "lateApprovalDue": plan(SAM, sam, {K + "1": task(sent=D(10, 11))}, D(10, 14)),
  "royWithRoy": plan(SAM, sam, {K + "1": task(sent=D(10, 8)), K + "2": task(sent=D(10, 12)), K + "roy": task(status="Today")}, D(10, 18)),
}))`);
    expect(r.withKevin).toEqual([null, 'form chase step 1 is with Kevin']);
    expect(r.turnedDown).toEqual([null, 'the form chase stopped: Kevin turned down step 1']);
    expect(r.lateApproval).toEqual([null, 'the form is not filled in; reminder 2 on 14 Oct']);
    expect(r.lateApprovalDue).toEqual([['2', 'recTENANTFORM0001:2026-10-05:2'], '']);
    expect(r.royWithRoy).toEqual([null, 'Roy is reaching the tenant']);
  });

  it('a link made again mid-chase carries on the same chase; a chase the tenant answered starts fresh; 30 days on it is history', () => {
    const r = py(`
K = SAM + ":2026-10-05:"
again = tenant("Sam", "2026-10-26")                       # a new link made 12 Oct, form still not saved
answered = tenant("Sam", "2026-11-20", saved="2026-10-10T09:00:00.000Z")   # saved after the first, new link 6 Nov
print(json.dumps({
  "carriesOn": plan(SAM, again, {K + "1": task(sent=D(10, 8))}, D(10, 13)),
  "fresh": plan(SAM, answered, {K + "1": task(sent=D(10, 8))}, D(11, 9)),
  "history": plan(SAM, tenant("Sam", "2026-10-19"), {}, D(11, 5)),
}))`);
    expect(r.carriesOn).toEqual([['2', 'recTENANTFORM0001:2026-10-05:2'], '']);
    expect(r.fresh).toEqual([['1', 'recTENANTFORM0001:2026-11-06:1'], '']);
    expect(r.history).toEqual([null, '']);
  });

  it('no live tenancy, a do-not-chase tenant, or a late-rent chase talking to them: nobody is chased, and it is said', () => {
    const r = py(`
print(json.dumps({
  "noTenancy": plan(SAM, tenant("Sam", "2026-10-19", tenancies=("recENDEDTENANCY01",)), {}, D(10, 9)),
  "noChase": plan(SAM, tenant("Sam", "2026-10-19"), {}, D(10, 9), no_chase=True),
  "busy": plan(SAM, tenant("Sam", "2026-10-19"), {}, D(10, 9), busy=True),
  "noLink": plan(SAM, tenant("Sam", None), {}, D(10, 9)),
}))`);
    expect(r.noTenancy).toEqual([null, 'the form is not filled in, but the tenant has no live tenancy linked, so nobody is chased']);
    expect(r.noChase).toEqual([null, 'the form is not filled in; the tenant is on the do-not-chase list']);
    expect(r.busy).toEqual([null, 'the form is not filled in; a late-rent chase is talking to the tenant, so this one waits']);
    expect(r.noLink).toEqual([null, '']);
  });

  it('a run raises the agent card for a reminder and the Roy task (emailed to him) for the last step; dry or switched off, nothing', () => {
    const r = py(`
posts, mailed = [], []
class FakeAd:
    ROY_EMAIL = "roy@example.test"
    HUMANS = {"roy@example.test": {"rec": "recROYROW0000001"}}
    AF = {"assignee": "fldASSIGNEE000001"}
K = SAM + ":2026-10-05:"
def rc_for(chases):
    rc = types.SimpleNamespace(
        T_TENANTS="tblX4elTuu01gwBYh", T_TASKS="tblqB8b22hKBL4PF1", AGENT_TEAM_MEMBER="rec7aHLK1Q8fMLRXH",
        TK={"name": "fN", "status": "fS", "due": "fD", "description": "fDe", "notes": "fNo", "tenancies": "fTy",
            "tenants": "fTe", "teamMember": "fTm"},
        sel=lambda v: v.get("name", "") if isinstance(v, dict) else (v or ""), TY={"unitRef": "fUnit"},
        first=lambda v: (v or [None])[0] if isinstance(v, list) else v,
        api=lambda method, path, payload=None, params=None: posts.append(payload["records"][0]["fields"]) or {"records": [{"id": "recNEW%011d" % len(posts)}]},
        rent_cap=types.SimpleNamespace(read_busy=lambda _rc: set()),
        lane_b_rules=types.SimpleNamespace(place_name=lambda u: u, module=lambda k: FakeAd, cut_off=lambda res: False,
                                           notify_roy=lambda tid, to: mailed.append([tid, to]) or {"notified": tid}))
    fc.read_links = lambda _rc: {SAM: tenant("Sam Example", "2026-10-19")}
    fc.read_chases = lambda _rc: chases
    return rc
# A green tenancy has no row of its own, only its lane: the chase must still find it live.
RES = {"tenancies": [], "lanes": {"recTENANCYFORM001": "fine"}}
DATA = {"tenancies": [{"id": "recTENANCYFORM001", "fields": {"fUnit": ["Unit 9 – 1 Example Road"]}}]}
off = fc.run(rc_for({}), DATA, D(10, 8), RES, True, False)
dry = fc.run(rc_for({}), DATA, D(10, 8), RES, False, True)
before = len(posts)
r1 = fc.run(rc_for({}), DATA, D(10, 8), RES, True, True)
r1_fields = posts[-1]
roy = fc.run(rc_for({K + "1": task(sent=D(10, 8)), K + "2": task(sent=D(10, 12))}), DATA, D(10, 15), RES, True, True)
roy_fields = posts[-1]
lapsed = fc.run(rc_for({K + "1": task(sent=D(10, 15))}), DATA, D(10, 20), RES, True, True)
print(json.dumps({"off": [off["raised"], fc.line(off)], "dry": [dry["planned"], before, fc.line(dry)],
                  "r1": [r1["raised"], r1_fields["fTm"], r1_fields["fNo"], r1_fields["fTy"], r1_fields["fTe"]],
                  "r1Desc": r1_fields["fDe"], "roy": [roy["raised"], roy_fields["fTm"], roy_fields["fldASSIGNEE000001"]],
                  "royDesc": roy_fields["fDe"], "mailed": mailed, "lapsedDesc": posts[-1]["fDe"], "line": fc.line(r1)}))`);
    expect(r.off[0]).toEqual([]);
    expect(r.off[1]).toMatch(/switched off/);
    expect(r.dry[0]).toEqual(['RENT DETAILS: Unit 9 – 1 Example Road, reminder 1 to fill in the details form']);
    expect(r.dry[1]).toBe(0);
    expect(r.dry[2]).toMatch(/^Form chase: a real run would raise: RENT DETAILS: Unit 9/);
    expect(r.r1).toEqual([['RENT DETAILS: Unit 9 – 1 Example Road, reminder 1 to fill in the details form'], ['rec7aHLK1Q8fMLRXH'],
      'RENT CHECK KEY: details:recTENANTFORM0001:2026-10-05:1', ['recTENANCYFORM001'], ['recTENANTFORM0001']]);
    expect(r.r1Desc).toContain('Sam was sent the tenant details form link on 5 Oct 2026 (it works until 19 Oct 2026)');
    expect(r.r1Desc).toContain('from info@agilelets.co.uk, signed Roy Lavin, Agile Lets, with the TEXT TO and TEXT lines');
    expect(r.r1Desc).not.toContain('tenant-link.py');
    expect(r.roy).toEqual([['RENT DETAILS: Unit 9 – 1 Example Road, reach Sam in person: details form not filled in'], ['recROYROW0000001'],
      { email: 'roy@example.test' }]);
    expect(r.royDesc).toContain('reminders went on 2026-10-08 and 2026-10-12');
    // Roy's step is emailed to him; a reminder never is.
    expect(r.mailed).toEqual([['recNEW00000000002', 'roy@example.test']]);
    // Reminder 2 after the link lapsed: the agent makes a fresh one for the email.
    expect(r.lapsedDesc).toContain('python3 scripts/tenant-link.py make --tenant recTENANTFORM0001');
    expect(r.line).toBe('Form chase: raised: RENT DETAILS: Unit 9 – 1 Example Road, reminder 1 to fill in the details form.');
  });

  it('a reminder card is never the robot\'s direct rent payment form card, and the text door takes it', () => {
    const r = py(`
import agent_email_format as aef
item = {"step": "1", "key": SAM + ":2026-10-05:1", "anchor": D(10, 5), "tenancy": "recTENANCYFORM001",
        "made": D(10, 5), "expires": D(10, 19)}
name, desc = fc.describe(item, "Sam", "Unit 9 – 1 Example Road", {}, SAM, D(10, 8))
notes = fc.KEY_MARK + item["key"]
holders = ["rec7aHLK1Q8fMLRXH"]
print(json.dumps({"name": name, "form": aef.form_card(name, notes, holders) or aef.form_card(name, notes), "text": aef.text_card(name, notes, "", holders),
                  "lane": aef.tenancies_to_note(name, notes, holders, ["recTENANCYFORM001"], "")}))`);
    expect(r.name).toBe('RENT DETAILS: Unit 9 – 1 Example Road, reminder 1 to fill in the details form');
    // Approving a robot form card opens the robot's DWP window: a reminder must never read as one.
    expect(r.form).toBeFalsy();
    expect(r.text).toBe(true);
    expect(r.lane).toEqual(['recTENANCYFORM001']);
  });

  it('reads the SENT stamp off a card, and finds chase tasks and links by field NAME formulas', () => {
    const r = py(`
seen = []
def fetch_all(table, params):
    seen.append([table, params.get("filterByFormula")])
    if table == "tblqB8b22hKBL4PF1":
        return [{"id": "recCHASE00000001", "fields": {"fS": "Completed", "fNo": "RENT CHECK KEY: details:recTENANTFORM0001:2026-10-05:1\\n\\n[08 Oct 2026 10:15 — send-email] SENT: email to sam@example.com"}}]
    return [{"id": SAM, "fields": tenant("Sam", "2026-10-19")}]
rc = types.SimpleNamespace(T_TENANTS="tblX4elTuu01gwBYh", T_TASKS="tblqB8b22hKBL4PF1", TK={"status": "fS", "notes": "fNo"},
                           sel=lambda v: v or "", fetch_all=fetch_all)
chases = fc.read_chases(rc)
links = fc.read_links(rc)
print(json.dumps({"chases": {k: [v["id"], v["status"], str(v["sent"])] for k, v in chases.items()}, "links": list(links), "seen": seen}))`);
    expect(r.chases).toEqual({ 'recTENANTFORM0001:2026-10-05:1': ['recCHASE00000001', 'Completed', '2026-10-08'] });
    expect(r.links).toEqual(['recTENANTFORM0001']);
    expect(r.seen).toEqual([['tblqB8b22hKBL4PF1', "FIND('RENT CHECK KEY: details:', {Notes}&'')"],
      ['tblX4elTuu01gwBYh', "LEN({Tenant Form Code Expires}&'')>0"]]);
  });
});
