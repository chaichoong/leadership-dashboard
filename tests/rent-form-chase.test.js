// The form chase (Kevin, 5 Oct 2026: "We need to have the follow-up process for those and get Roy's involvement
// when we get to a certain stage where we're not getting engagement"; plan approved as-is the same day): a tenant
// emailed a details-form link who has not filled it in gets reminder 1 on day 3, reminder 2 on day 7 (the agent's
// cards, Kevin approves each) and a task for Roy on day 10, counted from the day the email carrying the link went.
// These drive the REAL module on the real dates of 5 Oct 2026 (links made 4 and 5 Oct, emailed 5 Oct), with
// invented ids and names, and Airtable stubbed.
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
SAM = "recTENANTFORM0001"            # link made 5 Oct (expires 19 Oct), emailed 5 Oct
ALEX = "recTENANTFORM0002"           # link made 4 Oct (expires 18 Oct), emailed 5 Oct
LIVE = {"recTENANCYFORM001", "recTENANCYFORM002"}
D = lambda m, d: date(2026, m, d)
def task(status="Completed", sent=None): return {"id": "recT", "status": status, "sent": sent}
CARRIED = [task(sent=date(2026, 10, 5))]          # the card that carried the link went on 5 Oct
def plan(tid, f, chases, day, cards=None, **k):
    item, stage = fc.plan(tid, f, chases, CARRIED if cards is None else cards, day, LIVE, **k)
    return [item and [item["step"], item["key"]], stage]
`;
function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('the form chase: day 3, day 7, then Roy on day 10 after the link email went, and nothing once the form is saved', () => {
  it('the real dates: links emailed 5 Oct are chased 8 Oct, 12 Oct and 15 Oct, whichever day the link was made', () => {
    const r = py(`
sam = tenant("Sam Example", "2026-10-19")
alex = tenant("Alex Example", "2026-10-18", tenancies=("recTENANCYFORM002",))
K = SAM + ":2026-10-05:"
out = {
  "today": plan(SAM, sam, {}, D(10, 5)),
  "r1": plan(SAM, sam, {}, D(10, 8)),
  "alexEarly": plan(ALEX, alex, {}, D(10, 7)),
  "alexR1": plan(ALEX, alex, {}, D(10, 8)),
  "waitR2": plan(SAM, sam, {K + "1": task(sent=D(10, 8))}, D(10, 11)),
  "r2": plan(SAM, sam, {K + "1": task(sent=D(10, 8))}, D(10, 12)),
  "waitRoy": plan(SAM, sam, {K + "1": task(sent=D(10, 8)), K + "2": task(sent=D(10, 12))}, D(10, 14)),
  "roy": plan(SAM, sam, {K + "1": task(sent=D(10, 8)), K + "2": task(sent=D(10, 12))}, D(10, 15)),
  "royOpen": plan(SAM, sam, {K + "1": task(sent=D(10, 8)), K + "2": task(sent=D(10, 12)), K + "roy": task(status="Today")}, D(10, 18)),
  "done": plan(SAM, sam, {K + "1": task(sent=D(10, 8)), K + "2": task(sent=D(10, 12)), K + "roy": task()}, D(10, 20)),
}
print(json.dumps(out))`);
    expect(r.today).toEqual([null, 'the form is not filled in; reminder 1 on 8 Oct']);
    expect(r.r1).toEqual([['1', 'recTENANTFORM0001:2026-10-05:1'], '']);
    // Made 4 Oct but emailed 5 Oct: counted from the email.
    expect(r.alexEarly).toEqual([null, 'the form is not filled in; reminder 1 on 8 Oct']);
    expect(r.alexR1).toEqual([['1', 'recTENANTFORM0002:2026-10-04:1'], '']);
    expect(r.waitR2).toEqual([null, 'the form is not filled in; reminder 2 on 12 Oct']);
    expect(r.r2).toEqual([['2', 'recTENANTFORM0001:2026-10-05:2'], '']);
    expect(r.waitRoy).toEqual([null, 'the form is not filled in; Roy on 15 Oct']);
    expect(r.roy).toEqual([['roy', 'recTENANTFORM0001:2026-10-05:roy'], '']);
    expect(r.royOpen).toEqual([null, 'Roy is reaching the tenant']);
    expect(r.done).toEqual([null, 'the form chase is done: Roy has had it']);
  });

  it('the link email: while it is with Kevin nothing is chased; one never sent is never chased; an older one does not count', () => {
    const r = py(`
sam = tenant("Sam", "2026-10-19")
print(json.dumps({
  "withKevin": plan(SAM, sam, {}, D(10, 9), cards=[task(status="Approval")]),
  "rejected": plan(SAM, sam, {}, D(10, 9), cards=[task(status="Completed")]),
  "none": plan(SAM, sam, {}, D(10, 9), cards=[]),
  "older": plan(SAM, sam, {}, D(10, 9), cards=[task(sent=D(10, 1))]),
  "lateApproval": plan(SAM, sam, {}, D(10, 9), cards=[task(sent=D(10, 8))]),
  "otherCardWaits": plan(SAM, sam, {}, D(10, 9), cards=CARRIED + [task(status="Approval")]),
}))`);
    expect(r.withKevin).toEqual([null, "the form link's email is with Kevin, so no reminder yet"]);
    // Kevin's "Reject and close" (Completed, nothing sent): the link never reached them.
    expect(r.rejected).toEqual([null, 'a form link was made, but no card has carried it to the tenant, so nobody is chased']);
    expect(r.none).toEqual([null, 'a form link was made, but no card has carried it to the tenant, so nobody is chased']);
    expect(r.older).toEqual([null, 'a form link was made, but no card has carried it to the tenant, so nobody is chased']);
    // Emailed 8 Oct (Kevin approved late): reminder 1 on 11 Oct, not 8 Oct.
    expect(r.lateApproval).toEqual([null, 'the form is not filled in; reminder 1 on 11 Oct']);
    expect(r.otherCardWaits).toEqual([null, 'the form is not filled in; a card to the tenant is with Kevin, so this one waits']);
  });

  it('saved since the link was made (in London time): nothing; saved before it: still chased', () => {
    const r = py(`
print(json.dumps({
  "savedAfter": plan(SAM, tenant("Sam", "2026-10-19", saved="2026-10-06T09:00:00.000Z"), {}, D(10, 9)),
  "savedEarlyMorning": plan(SAM, tenant("Sam", "2026-10-19", saved="2026-10-04T23:30:00.000Z"), {}, D(10, 9)),
  "savedBefore": plan(SAM, tenant("Sam", "2026-10-19", saved="2026-09-01T09:00:00.000Z"), {}, D(10, 9)),
}))`);
    expect(r.savedAfter).toEqual([null, '']);
    // 23:30 UTC on 4 Oct is 00:30 on 5 Oct in London: saved on the day the link was made.
    expect(r.savedEarlyMorning).toEqual([null, '']);
    expect(r.savedBefore).toEqual([['1', 'recTENANTFORM0001:2026-10-05:1'], '']);
  });

  it('one step at a time: with Kevin holds the next; turned down or closed unsent ends the chase; a late approval keeps a 3-day gap', () => {
    const r = py(`
sam = tenant("Sam", "2026-10-19")
K = SAM + ":2026-10-05:"
print(json.dumps({
  "withKevin": plan(SAM, sam, {K + "1": task(status="Approval")}, D(10, 13)),
  "cancelled": plan(SAM, sam, {K + "1": task(status="Cancelled")}, D(10, 13)),
  "rejectAndClose": plan(SAM, sam, {K + "1": task(status="Completed")}, D(10, 13)),
  "lateApproval": plan(SAM, sam, {K + "1": task(sent=D(10, 11))}, D(10, 13)),
  "lateApprovalDue": plan(SAM, sam, {K + "1": task(sent=D(10, 11))}, D(10, 14)),
}))`);
    expect(r.withKevin).toEqual([null, 'form chase reminder 1 is with Kevin']);
    expect(r.cancelled).toEqual([null, 'the form chase stopped: reminder 1 was closed without going (turned down or refused)']);
    // The queue's "Reject and close" sets Completed with nothing sent: the chase ends, never runs on to Roy.
    expect(r.rejectAndClose).toEqual([null, 'the form chase stopped: reminder 1 was closed without going (turned down or refused)']);
    expect(r.lateApproval).toEqual([null, 'the form is not filled in; reminder 2 on 14 Oct']);
    expect(r.lateApprovalDue).toEqual([['2', 'recTENANTFORM0001:2026-10-05:2'], '']);
  });

  it('a link made again mid-chase carries on the same chase; one the tenant answered starts fresh; a chase under way outlives the window', () => {
    const r = py(`
K = SAM + ":2026-10-05:"
again = tenant("Sam", "2026-10-26")                       # a new link made 12 Oct, form still not saved
answered = tenant("Sam", "2026-11-20", saved="2026-10-10T09:00:00.000Z")   # saved after the first, new link 6 Nov
print(json.dumps({
  "carriesOn": plan(SAM, again, {K + "1": task(sent=D(10, 8))}, D(10, 13)),
  "fresh": plan(SAM, answered, {K + "1": task(sent=D(10, 8))}, D(11, 9), cards=[task(sent=D(11, 6))]),
  "history": plan(SAM, tenant("Sam", "2026-10-19"), {}, D(11, 5)),
  "lateRoy": plan(SAM, tenant("Sam", "2026-10-19"), {K + "1": task(sent=D(10, 20)), K + "2": task(sent=D(11, 2))}, D(11, 7)),
}))`);
    expect(r.carriesOn).toEqual([['2', 'recTENANTFORM0001:2026-10-05:2'], '']);
    expect(r.fresh).toEqual([['1', 'recTENANTFORM0001:2026-11-06:1'], '']);
    expect(r.history).toEqual([null, '']);
    // Late approvals pushed Roy past day 30: a chase under way still reaches Roy.
    expect(r.lateRoy).toEqual([['roy', 'recTENANTFORM0001:2026-10-05:roy'], '']);
  });

  it('no live tenancy, a do-not-chase tenant, or a late-rent chase talking to them: nobody is chased, and it is said', () => {
    const r = py(`
print(json.dumps({
  "noTenancy": plan(SAM, tenant("Sam", "2026-10-19", tenancies=("recENDEDTENANCY01",)), {}, D(10, 9)),
  "noChase": plan(SAM, tenant("Sam", "2026-10-19"), {}, D(10, 9), no_chase=True),
  "busy": plan(SAM, tenant("Sam", "2026-10-19"), {}, D(10, 9), busy=True),
  "noLink": plan(SAM, tenant("Sam", None), {}, D(10, 9)),
  "noName": fc.first_name(""),
}))`);
    expect(r.noTenancy).toEqual([null, 'the form is not filled in, but the tenant has no live tenancy linked, so nobody is chased']);
    expect(r.noChase).toEqual([null, 'the form is not filled in; the tenant is on the do-not-chase list']);
    expect(r.busy).toEqual([null, 'the form is not filled in; a late-rent chase is talking to the tenant, so this one waits']);
    expect(r.noLink).toEqual([null, '']);
    expect(r.noName).toBe('the tenant');
  });

  it('a run raises the agent card for a reminder and the Roy task (emailed, and offered again while open); dry or switched off, nothing', () => {
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
            "tenants": "fTe", "teamMember": "fTm"}, TY={"unitRef": "fUnit"},
        sel=lambda v: v.get("name", "") if isinstance(v, dict) else (v or ""),
        first=lambda v: (v or [None])[0] if isinstance(v, list) else v,
        api=lambda method, path, payload=None, params=None: posts.append(payload["records"][0]["fields"]) or {"records": [{"id": "recNEW%011d" % len(posts)}]},
        rent_cap=types.SimpleNamespace(read_busy=lambda _rc: set()),
        lane_b_rules=types.SimpleNamespace(place_name=lambda u: u, module=lambda k: FakeAd, cut_off=lambda res: False,
                                           notify_roy=lambda tid, to: mailed.append([tid, to]) or {"notified": tid}))
    fc.read_links = lambda _rc: {SAM: tenant("Sam Example", "2026-10-19")}
    fc.read_cards = lambda _rc, day: (chases, {SAM: list(CARRIED)})
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
mailed_after_raise = list(mailed)
reoffer = fc.run(rc_for({K + "1": task(sent=D(10, 8)), K + "2": task(sent=D(10, 12)), K + "roy": dict(task(status="Today"), id="recOPENROY000001")}), DATA, D(10, 16), RES, True, True)
lapsed = fc.run(rc_for({K + "1": task(sent=D(10, 15))}), DATA, D(10, 20), RES, True, True)
print(json.dumps({"off": [off["raised"], fc.line(off)], "dry": [dry["planned"], before, fc.line(dry)],
                  "r1": [r1["raised"], r1_fields["fTm"], r1_fields["fNo"], r1_fields["fTy"], r1_fields["fTe"]],
                  "r1Desc": r1_fields["fDe"], "roy": [roy["raised"], roy_fields["fTm"], roy_fields["fldASSIGNEE000001"]],
                  "royDesc": roy_fields["fDe"], "mailedAfterRaise": mailed_after_raise, "mailed": mailed,
                  "lapsedDesc": posts[-1]["fDe"], "line": fc.line(r1)}))`);
    expect(r.off[0]).toEqual([]);
    expect(r.off[1]).toMatch(/switched off/);
    expect(r.dry[0]).toEqual(['RENT DETAILS: Unit 9 – 1 Example Road, reminder 1 to fill in the details form']);
    expect(r.dry[1]).toBe(0);
    expect(r.dry[2]).toMatch(/^Form chase: a real run would raise: RENT DETAILS: Unit 9/);
    expect(r.r1).toEqual([['RENT DETAILS: Unit 9 – 1 Example Road, reminder 1 to fill in the details form'], ['rec7aHLK1Q8fMLRXH'],
      'RENT CHECK KEY: details:recTENANTFORM0001:2026-10-05:1', ['recTENANCYFORM001'], ['recTENANTFORM0001']]);
    expect(r.r1Desc).toContain('Sam was emailed the tenant details form link on 5 Oct 2026 (it works until 19 Oct 2026)');
    expect(r.r1Desc).toContain('from info@agilelets.co.uk, signed Roy Lavin, Agile Lets, with the TEXT TO and TEXT lines');
    expect(r.r1Desc).not.toContain('tenant-link.py');
    expect(r.roy).toEqual([['RENT DETAILS: Unit 9 – 1 Example Road, reach Sam in person: details form not filled in'], ['recROYROW0000001'],
      { email: 'roy@example.test' }]);
    expect(r.royDesc).toContain('reminders went on 2026-10-08 and 2026-10-12');
    // Roy's step is emailed to him when raised; a reminder never is.
    expect(r.mailedAfterRaise).toEqual([['recNEW00000000002', 'roy@example.test']]);
    // While it stays open it is offered again (notify's own ledger never sends a second copy).
    expect(r.mailed).toEqual([['recNEW00000000002', 'roy@example.test'], ['recOPENROY000001', 'roy@example.test']]);
    // Reminder 2 after the link lapsed: the agent makes a fresh one for the email.
    expect(r.lapsedDesc).toContain('python3 scripts/tenant-link.py make --tenant recTENANTFORM0001');
    expect(r.line).toBe('Form chase: raised: RENT DETAILS: Unit 9 – 1 Example Road, reminder 1 to fill in the details form.');
  });

  it('a reminder card is never the robot direct rent payment form card, and the text door takes it', () => {
    const r = py(`
import agent_email_format as aef
item = {"step": "1", "key": SAM + ":2026-10-05:1", "anchor": D(10, 5), "tenancy": "recTENANCYFORM001",
        "made": D(10, 5), "expires": D(10, 19), "carried": D(10, 5)}
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

  it('reads chase steps (by Notes or Description) apart from the cards linked to a tenant, and links by a field NAME formula', () => {
    const r = py(`
seen = []
def fetch_all(table, params):
    seen.append([table, params.get("filterByFormula")])
    if table == "tblqB8b22hKBL4PF1":
        return [{"id": "recCHASE00000001", "fields": {"fS": "Completed", "fNo": "RENT CHECK KEY: details:recTENANTFORM0001:2026-10-05:1\\n\\n[08 Oct 2026 10:15 — send-email] SENT: email to sam@example.com", "fTe": [SAM]}},
                {"id": "recCHASE00000002", "fields": {"fS": "Today", "fDe": "x\\nRENT CHECK KEY: details:recTENANTFORM0001:2026-10-05:2", "fTe": [SAM]}},
                {"id": "recCARRIER000001", "fields": {"fS": "Completed", "fNo": "[05 Oct 2026 14:31 — send-email] SENT: email to sam@example.com", "fTe": [SAM]}}]
    return [{"id": SAM, "fields": tenant("Sam", "2026-10-19")}]
rc = types.SimpleNamespace(T_TENANTS="tblX4elTuu01gwBYh", T_TASKS="tblqB8b22hKBL4PF1",
                           TK={"status": "fS", "notes": "fNo", "description": "fDe", "tenants": "fTe"},
                           sel=lambda v: v or "", fetch_all=fetch_all)
chases, cards = fc.read_cards(rc, D(10, 20))
links = fc.read_links(rc)
print(json.dumps({"chases": {k: [v["id"], v["status"], str(v["sent"])] for k, v in chases.items()},
                  "cards": {k: [[c["id"], str(c["sent"])] for c in v] for k, v in cards.items()}, "links": list(links), "seen": seen}))`);
    expect(r.chases).toEqual({ 'recTENANTFORM0001:2026-10-05:1': ['recCHASE00000001', 'Completed', '2026-10-08'],
      'recTENANTFORM0001:2026-10-05:2': ['recCHASE00000002', 'Today', 'None'] });
    // A chase step is never the card that carried the link.
    expect(r.cards).toEqual({ recTENANTFORM0001: [['recCARRIER000001', '2026-10-05']] });
    expect(r.links).toEqual(['recTENANTFORM0001']);
    expect(r.seen).toEqual([['tblqB8b22hKBL4PF1', "OR(IS_AFTER(CREATED_TIME(), '2026-09-05'), FIND('RENT CHECK KEY: details:', {Notes}&''))"],
      ['tblX4elTuu01gwBYh', "LEN({Tenant Form Code Expires}&'')>0"]]);
  });
});
