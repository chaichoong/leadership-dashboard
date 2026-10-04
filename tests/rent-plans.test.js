// Payment plans (Cash Flow Voids step 3b; Kevin approved "Build as-is" on 4 Oct 2026). The PLAN lines on a
// card, and scripts/rent_plans.py, which keeps every promise once the plan's email has gone. These drive the
// REAL code with Airtable stubbed: every id, name and amount is invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(root, 'scripts');

const HARNESS = `
import importlib.util, json, sys, os, io, contextlib
from datetime import date, timedelta
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
sys.argv = ["test"]
import agent_email_format as aef
import rent_plans as rp
spec = importlib.util.spec_from_file_location("rc", os.path.join(${JSON.stringify(SCRIPTS)}, "rent-check.py"))
rc = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc)
F = rp.F
CFV, OTHER = "rec7aHLK1Q8fMLRXH", "recOtherAgent0001"
TEN = "recTENANCYPLAN001"
EMAIL = "TO: sam@example.com\\nFROM: info@agilelets.co.uk\\nSUBJECT: Your rent plan\\n---\\nHello Sam,\\n\\nAgreed.\\n\\nKind regards\\nRoy Lavin\\nAgile Lets"
def output(plan=(("2026-10-10", 100), ("2026-10-24", 300)), tenancy=TEN):
    head = ([f"PLAN FOR: {tenancy}"] if tenancy else []) + [f"PLAN: {d} £{a:.2f}" for d, a in plan]
    return "\\n".join(head) + "\\n" + EMAIL
SENT = "[05 Oct 2026 10:00 — send-email] SENT: email to sam@example.com (Gmail id x)"
def card(i="recPLANCARD00001", outcome="Approved as-is", notes=SENT, out=None, agent=CFV, approved="2026-10-05T09:00:00.000Z", name="INBOUND: reply from Sam",
         tenancies=(TEN,), sender="", created=None):
    rec = {"id": i, "fields": {F["name"]: name, F["status"]: "Completed", F["notes"]: notes, F["output"]: out if out is not None else output(),
                              F["outcome"]: outcome, F["approvedAt"]: approved, F["sentBy"]: [agent], F["teamMember"]: [agent],
                              F["tenancies"]: list(tenancies), F["sender"]: sender}}
    if created:
        rec["createdTime"] = created
    return rec
def pays(*pairs): return [{"day": date.fromisoformat(d), "amount": a} for d, a in pairs]
def trial_ended(at="2026-10-05T00:00:00Z"):
    aef.TRIAL_ENDED[CFV] = at
    aef.TRIAL_AGENTS.clear()
`;
function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('the PLAN lines on a card', () => {
  it('reads the tenancy and the promises in date order, and keeps them out of the email', () => {
    const r = py(`
o = "PLAN FOR: recTENANCYPLAN001\\nPLAN: 2026-10-24 £300.00\\nPLAN: 2026-10-10 £100\\n" + EMAIL
mail = aef.validate_submission(o)
print(json.dumps({"plan": aef.parse_plan(o), "to": mail["to"], "body": mail["body"], "none": aef.parse_plan(EMAIL)}))`);
    expect(r.plan).toEqual({ tenancy: 'recTENANCYPLAN001', promises: [['2026-10-10', 100], ['2026-10-24', 300]] });
    expect(r.to).toEqual(['sam@example.com']);
    expect(r.body).not.toMatch(/PLAN|rec/);
    expect(r.none).toBeNull();
  });

  it('refuses at submit and at every send door what the tracker could not keep', () => {
    const r = py(`
cases = {
  "noFor": "PLAN: 2026-10-10 £100\\n" + EMAIL,
  "forOnly": "PLAN FOR: recTENANCYPLAN001\\n" + EMAIL,
  "twoFor": "PLAN FOR: recTENANCYPLAN001\\nPLAN FOR: recTENANCYPLAN002\\nPLAN: 2026-10-10 £100\\n" + EMAIL,
  "badFor": "PLAN FOR: Unit 9\\nPLAN: 2026-10-10 £100\\n" + EMAIL,
  "badDay": "PLAN FOR: recTENANCYPLAN001\\nPLAN: 2026-02-30 £100\\n" + EMAIL,
  "ukDate": "PLAN FOR: recTENANCYPLAN001\\nPLAN: 10/10/2026 £100\\n" + EMAIL,
  "noPound": "PLAN FOR: recTENANCYPLAN001\\nPLAN: 2026-10-10 100\\n" + EMAIL,
  "zero": "PLAN FOR: recTENANCYPLAN001\\nPLAN: 2026-10-10 £0\\n" + EMAIL,
  "huge": "PLAN FOR: recTENANCYPLAN001\\nPLAN: 2026-10-10 £20000\\n" + EMAIL,
  "sameDay": "PLAN FOR: recTENANCYPLAN001\\nPLAN: 2026-10-10 £100\\nPLAN: 2026-10-10 £50\\n" + EMAIL,
  "tooMany": "PLAN FOR: recTENANCYPLAN001\\n" + "".join(f"PLAN: 2026-10-{d:02d} £10\\n" for d in range(1, 14)) + EMAIL,
  "below": EMAIL + "\\nPLAN: 2026-10-10 £100",
  "forBelow": EMAIL + "\\nPLAN FOR: recTENANCYPLAN001",
  "lower": "PLAN FOR: recTENANCYPLAN001\\nplan: 2026-10-10 £100\\n" + EMAIL,
}
out = {}
for k, o in cases.items():
    try:
        aef.validate_submission(o); out[k] = "accepted"
    except aef.EmailFormatError as e:
        out[k] = str(e)
# The send door and the revise step read the same rule (they run parse_text, which runs parse_plan).
try:
    aef.parse_text(cases["below"]); out["door"] = "accepted"
except aef.EmailFormatError as e:
    out["door"] = str(e)
print(json.dumps(out))`);
    for (const k of ['noFor', 'forOnly', 'twoFor']) expect(r[k], k).toMatch(/one PLAN FOR line/);
    expect(r.badFor).toMatch(/PLAN FOR: rec/);
    expect(r.badDay).toMatch(/not a real day/);
    for (const k of ['ukDate', 'noPound']) expect(r[k], k).toMatch(/written exactly as "PLAN: 2026-10-10 £100.00"/);
    expect(r.lower).toMatch(/exactly as "PLAN FOR:" and "PLAN:", in capitals/);
    expect(r.zero).toMatch(/not one the rent check can track/);
    expect(r.huge).toMatch(/not one the rent check can track/);
    expect(r.sameDay).toMatch(/two promises on one day/);
    expect(r.tooMany).toMatch(/the most is 12/);
    expect(r.below).toMatch(/below the email's headers/);
    expect(r.forBelow).toMatch(/below the email's headers/);
    expect(r.door).toMatch(/below the email's headers/);
  });

  it('a plan card is a lane card: on trial by its name, and it may carry a text', () => {
    const r = py(`
print(json.dumps({"trial": bool(aef.trial_problem([OTHER], "RENT PLAN: Unit 9", "")), "text": aef.text_card("RENT PLAN: Unit 9", ""),
                  "prefix": rp.PLAN_PREFIX}))`);
    expect(r).toEqual({ trial: true, text: true, prefix: 'RENT PLAN: ' });
  });
});

describe('where a plan stands', () => {
  const st = (body) => py(body);
  it('only an approved card whose email went, after the trial, is a plan', () => {
    const r = st(`
day = date(2026, 10, 8)
out = {}
out["draft"] = rp.state(card(outcome=""), [], day)["why"]
out["changes"] = rp.state(card(outcome="Changes requested"), [], day)["why"]
out["onTrial"] = rp.state(card(), [], day)["why"]
trial_ended()
out["unsent"] = rp.state(card(notes="RENT CHECK KEY: x"), [], day)["why"]
out["settled"] = rp.state(card(notes=SENT + "\\n[03 Oct 2026] TRIAL CHECKED: Kevin's verdict"), [], day)["why"]
out["inTrialApproval"] = rp.state(card(approved="2026-10-04T09:00:00.000Z"), [], day)["why"]
out["open"] = rp.state(card(), [], day)["state"]
out["edits"] = rp.state(card(outcome="Approved with minor edits"), [], day)["state"]
out["noLines"] = rp.state(card(out=EMAIL), [], day)["why"]
print(json.dumps(out))`);
    expect(r.draft).toBe('not approved');
    expect(r.changes).toBe('not approved');
    expect(r.onTrial).toMatch(/a trial card/);
    expect(r.unsent).toMatch(/has not gone/);
    expect(r.settled).toMatch(/a trial card/);
    expect(r.inTrialApproval).toMatch(/a trial card/);
    expect(r.open).toBe('open');
    expect(r.edits).toBe('open');
    expect(r.noLines).toBe('no plan lines');
  });

  it('each promise is checked two days after its date against the money since the plan was sent', () => {
    const r = st(`
trial_ended()
c = card()
P = lambda *p: pays(*p)
out = {
  # 10 Oct promise of £100: not checked until 12 Oct.
  "beforeCheck": rp.state(c, [], date(2026, 10, 11))["state"],
  "missed": rp.state(c, [], date(2026, 10, 12)),
  "paidLateInGrace": rp.state(c, P(("2026-10-12", 100)), date(2026, 10, 12))["state"],
  "partOnly": rp.state(c, P(("2026-10-10", 60)), date(2026, 10, 12)),
  # Money paid before the plan was sent never counts towards it.
  "before": rp.state(c, P(("2026-10-01", 500)), date(2026, 10, 12))["state"],
  # One early lump keeps both promises.
  "lump": rp.state(c, P(("2026-10-09", 400)), date(2026, 10, 26))["state"],
  # The second promise: £400 in all by 26 Oct.
  "secondMissed": rp.state(c, P(("2026-10-10", 100), ("2026-10-24", 200)), date(2026, 10, 26)),
  "kept": rp.state(c, P(("2026-10-10", 100), ("2026-10-24", 300)), date(2026, 10, 26))["state"],
  "midway": rp.state(c, P(("2026-10-10", 100)), date(2026, 10, 20))["state"],
  "over": rp.state(card(notes=SENT + "\\nRENT PLAN MISSED: 2026-10-10"), [], date(2026, 10, 26))["state"],
  "keptOver": rp.state(card(notes=SENT + "\\nRENT PLAN KEPT: every promise kept"), [], date(2026, 10, 26))["state"],
  "long": rp.state(card(out=output(plan=(("2026-10-10", 100), ("2026-12-20", 100)))), [], date(2026, 10, 8)),
  # Approved late: the email went on 12 Oct, after the first promise; he paid on 9 Oct, on his word.
  "lateApproval": rp.state(card(notes="[12 Oct 2026 10:00 — send-email] SENT: email to sam@example.com"), P(("2026-10-09", 100)), date(2026, 10, 13))["state"],
  "tooEarly": rp.state(card(notes="[12 Oct 2026 10:00 — send-email] SENT: email to sam@example.com"), P(("2026-10-04", 100)), date(2026, 10, 13))["state"],
}
print(json.dumps(out, default=str))`);
    expect(r.beforeCheck).toBe('open');
    expect(r.missed).toMatchObject({ state: 'missed', missedOn: '2026-10-10', owed: 100, paid: 0 });
    expect(r.paidLateInGrace).toBe('open');
    expect(r.partOnly).toMatchObject({ state: 'missed', owed: 100, paid: 60 });
    expect(r.before).toBe('missed');
    expect(r.lump).toBe('kept');
    expect(r.secondMissed).toMatchObject({ state: 'missed', missedOn: '2026-10-24', owed: 400, paid: 300 });
    expect(r.kept).toBe('kept');
    expect(r.midway).toBe('open');
    expect(r.over).toBe('over');
    expect(r.keptOver).toBe('over');
    expect(r.lateApproval).toBe('open');
    // Money from before the first promise's early window is not the plan's.
    expect(r.tooEarly).toBe('missed');
    expect(r.long).toMatchObject({ state: 'bad' });
    expect(r.long.why).toMatch(/past 70 days/);
  });
});

describe('the daily tracking, inside the rent check', () => {
  const RUN = `
trial_ended()
notes_written, raised = {}, []
CARDS = {"recPLANCARD00001": SENT}
CONTACTS = {"recTENANTPLAN001": {rp.TENANT_CONTACT["email"]: "Sam@Example.com", rp.TENANT_CONTACT["phone"]: "07700 900123"}}
class RC:
    T_TASKS, T_TENANTS, TY = rc.T_TASKS, rc.T_TENANTS, rc.TY
    first = staticmethod(rc.first)
    payments_by_tenancy = staticmethod(rc.payments_by_tenancy)
    next_stage = staticmethod(rc.next_stage)
    lane_b_rules = rc.lane_b_rules
    sel, tenant_type = staticmethod(rc.sel), staticmethod(rc.tenant_type)
    IN_PAYMENT, CFV, AGENT_MANAGED, STAGES = rc.IN_PAYMENT, rc.CFV, rc.AGENT_MANAGED, rc.STAGES
    def __init__(self, cards, keys=None): self.cards, self.keys = cards, keys or {}
    def fetch_all(self, table, params=None):
        if table == rc.T_TENANTS:
            return [{"id": k, "fields": v} for k, v in CONTACTS.items()]
        return self.cards
    def read_task_state(self): return {"on": True, "status": "Built", "keys": self.keys}
    def raise_task(self, item, day): raised.append({"key": item["key"], "name": item["name"], "tenants": item["tenants"], "also": item.get("alsoKeys")}); return "recNEW"
    def api(self, method, path, payload=None, params=None):
        tid = path.split("/")[-1]
        if method == "GET":
            return {"id": tid, "fields": {F["notes"]: CARDS.get(tid, "")}}
        notes_written[tid] = payload["fields"][F["notes"]]
        return {}
def data_with(tx, rent=None, due=None):
    f = {rc.TY["unitRef"]: ["Unit 9 – 1 Example Road"], rc.TY["tenants"]: ["recTENANTPLAN001"], rc.TY["payStatus"]: "In Payment"}
    if rent:
        f.update({rc.TY["rent"]: rent, rc.TY["dueDay"]: str(due)})
    return {"tenancies": [{"id": TEN, "fields": f}],
            "tx": [{"fields": {rc.TX["date"]: d, rc.TX["tenancy"]: [TEN], rc.TX["amount"]: a}} for d, a in tx]}
RES = {"lanes": {TEN: "late"}, "feed": {"blocked": []}, "tenancies": []}
`;
  it('a missed promise raises one RENT LATE task back to the chase, with the tenants linked, and marks the card', () => {
    const r = py(RUN + `
fake = RC([card()])
data = data_with([("2026-10-10", 40)])
plans = rp.read(fake, data, date(2026, 10, 12), RES)
out = rp.act(fake, plans, data, date(2026, 10, 12), True, True, RES)
again = rp.act(RC([card()], keys={raised[0]["key"]: date(2026, 10, 12)}), rp.read(RC([card()]), data, date(2026, 10, 13), RES), data, date(2026, 10, 13), True, True, RES)
print(json.dumps({"out": out, "raised": raised, "note": notes_written.get("recPLANCARD00001", ""), "againRaised": len(raised), "line": rp.line(out)}))`);
    expect(r.out.missed).toEqual(['recPLANCARD00001']);
    expect(r.raised[0]).toEqual({ key: 'recTENANCYPLAN001:plan:recPLANCARD00001:2026-10-10', name: 'RENT LATE: Unit 9 – 1 Example Road, payment plan promise of 10 Oct missed', tenants: ['recTENANTPLAN001'], also: [] });
    expect(r.note).toMatch(/RENT PLAN MISSED: 2026-10-10: £100.00 owed by then, £40.00 received; the chase starts again/);
    // A second run with the task already raised raises no second one.
    expect(r.againRaised).toBe(1);
    expect(r.line).toBe('Payment plans: 1 missed a promise.');
  });

  it('a kept plan is marked kept; an open plan is on track and lane A does not chase that tenancy', () => {
    const r = py(RUN + `
data = data_with([("2026-10-10", 100), ("2026-10-24", 300)])
kept = rp.act(RC([card()]), rp.read(RC([card()]), data, date(2026, 10, 26), RES), data, date(2026, 10, 26), True, True, RES)
opened = rp.read(RC([card()]), data_with([("2026-10-10", 100)]), date(2026, 10, 20), RES)
res = {"tenancies": [{"id": TEN, "lane": "late", "status": "In Payment", "type": "Universal Credit", "unit": "Unit 9 – 1 Example Road",
                      "rent": 500, "owed": "2026-10-01", "daysLate": 19, "note": "late"}], "feed": {"asAt": "x"}}
chased = rc.task_plan(res, [], {}, date(2026, 10, 20))
paused = rc.task_plan(res, [], {}, date(2026, 10, 20), opened["onTrack"])
print(json.dumps({"kept": kept["kept"], "note": notes_written.get("recPLANCARD00001", ""), "onTrack": sorted(opened["onTrack"]),
                  "chased": len(chased), "paused": len(paused), "line": rp.line(rp.act(RC([card()]), opened, data, date(2026, 10, 20), True, True, RES))}))`);
    expect(r.kept).toEqual(['recPLANCARD00001']);
    expect(r.note).toMatch(/RENT PLAN KEPT: every promise kept/);
    expect(r.onTrack).toEqual(['recTENANCYPLAN001']);
    expect(r.chased).toBe(1);
    expect(r.paused).toBe(0);
    expect(r.line).toBe('Payment plans: 1 agreed and on track.');
  });

  it('switched off or a dry run: said, never acted on; a card naming a tenancy that is not live is said on the row', () => {
    const r = py(RUN + `
data = data_with([])
plans = rp.read(RC([card()]), data, date(2026, 10, 12), RES)
off = rp.act(RC([card()]), plans, data, date(2026, 10, 12), True, False, RES)
dry = rp.act(RC([card()]), plans, data, date(2026, 10, 12), False, True, RES)
stranger = rp.read(RC([card(out=output(tenancy="recNOTLIVETENANCY"), tenancies=())]), data, date(2026, 10, 12), RES)
bad = rp.act(RC([]), stranger, data, date(2026, 10, 12), True, True, RES)
print(json.dumps({"raised": len(raised), "notes": len(notes_written), "off": rp.line(off), "dry": dry["missed"], "bad": rp.line(bad), "badState": stranger["plans"][0]["state"]}))`);
    expect([r.raised, r.notes]).toEqual([0, 0]);
    expect(r.off).toBe('Payment plans: 1 missed a promise (not acted on: the agent is switched off).');
    expect(r.dry).toEqual(['recPLANCARD00001']);
    expect(r.badState).toBe('bad');
    expect(r.bad).toMatch(/Check: card recPLANCARD00001: PLAN FOR names recNOTLIVETENANCY, which is not a live tenancy/);
  });

  it('a failed read is said, red, and lane A still runs; a card whose Notes read back empty is never overwritten', () => {
    const r = py(RUN + `
class Broken(RC):
    def fetch_all(self, table, params=None): raise RuntimeError("Airtable 500")
failed = rp.read(Broken([]), data_with([]), date(2026, 10, 12), RES)
CARDS["recPLANCARD00001"] = ""
data = data_with([])
out = rp.act(RC([card()]), rp.read(RC([card()]), data, date(2026, 10, 12), RES), data, date(2026, 10, 12), True, True, RES)
print(json.dumps({"failed": failed["failed"], "onTrack": sorted(failed["onTrack"]), "actFailed": out["failed"], "written": len(notes_written),
                  "line": rp.line(rp.act(RC([]), failed, data, date(2026, 10, 12), True, True, RES))}))`);
    expect(r.failed).toMatch(/payment plans could not be read: Airtable 500/);
    expect(r.onTrack).toEqual([]);
    expect(r.line).toMatch(/^Payment plans FAILED/);
    expect(r.actFailed).toMatch(/read back empty/);
    expect(r.written).toBe(0);
  });
});

describe('the review\'s cases (4 Oct 2026): what a plan must also hold to', () => {
  const RUN2 = `
trial_ended()
CONTACTS = {"recTENANTPLAN001": {rp.TENANT_CONTACT["email"]: "Sam@Example.com", rp.TENANT_CONTACT["phone"]: "07700 900123"}}
class RC:
    T_TASKS, T_TENANTS, TY = rc.T_TASKS, rc.T_TENANTS, rc.TY
    first = staticmethod(rc.first)
    payments_by_tenancy = staticmethod(rc.payments_by_tenancy)
    next_stage = staticmethod(rc.next_stage)
    lane_b_rules = rc.lane_b_rules
    sel, tenant_type = staticmethod(rc.sel), staticmethod(rc.tenant_type)
    IN_PAYMENT, CFV, AGENT_MANAGED, STAGES = rc.IN_PAYMENT, rc.CFV, rc.AGENT_MANAGED, rc.STAGES
    BANK = None
    feed_state = staticmethod(lambda data, pay, now: "feed")
    def bank_view(self, feed, payments): return self.BANK
    def __init__(self, cards): self.cards = cards
    def fetch_all(self, table, params=None):
        return [{"id": k, "fields": v} for k, v in CONTACTS.items()] if table == rc.T_TENANTS else self.cards
def data_with(tx, rent=None, due=None):
    f = {rc.TY["unitRef"]: ["Unit 9 – 1 Example Road"], rc.TY["tenants"]: ["recTENANTPLAN001"], rc.TY["payStatus"]: "In Payment"}
    if rent:
        f.update({rc.TY["rent"]: rent, rc.TY["dueDay"]: str(due)})
    return {"tenancies": [{"id": TEN, "fields": f}],
            "tx": [{"fields": {rc.TX["date"]: d, rc.TX["tenancy"]: [TEN], rc.TX["amount"]: a}} for d, a in tx]}
def st(cards, data, day, res=None):
    return [(p["id"], p["state"], p.get("why", "")) for p in rp.read(RC(cards), data, day, res or {"lanes": {TEN: "late"}, "feed": {"blocked": []}})["plans"]]
`;
  it('a miss is never judged on doubtful bank data: the plan waits, still paused, nothing raised', () => {
    const r = py(RUN2 + `
data = data_with([])
grey = rp.read(RC([card()]), data, date(2026, 10, 12), {"lanes": {TEN: "unknown"}, "feed": {"blocked": []}})
class Stale(RC):
    BANK = (date(2026, 10, 12), ["Santander bank feed last updated 40 hours ago"])
stale = rp.read(Stale([card()]), data, date(2026, 10, 12), {"lanes": {TEN: "late"}, "feed": {"blocked": []}}, "now")
clear = rp.read(RC([card()]), data, date(2026, 10, 12), {"lanes": {TEN: "late"}, "feed": {"blocked": []}})
# Doubt never blocks a plan that was kept.
kept = rp.read(RC([card()]), data_with([("2026-10-09", 400)]), date(2026, 10, 26), {"lanes": {TEN: "unknown"}, "feed": {"blocked": ["x"]}})
print(json.dumps({"grey": grey["plans"][0]["state"], "stale": stale["plans"][0]["state"], "paused": sorted(grey["onTrack"]),
                  "clear": clear["plans"][0]["state"], "kept": kept["plans"][0]["state"],
                  "line": rp.line(rp.act(RC([]), grey, data, date(2026, 10, 12), True, True, {}))}))`);
    expect([r.grey, r.stale, r.clear, r.kept]).toEqual(['waiting', 'waiting', 'missed', 'kept']);
    expect(r.paused).toEqual(['recTENANCYPLAN001']);
    expect(r.line).toBe('Payment plans: 1 waiting on bank data before a promise can be judged.');
  });

  it('the plan is held to the rent that falls due as well as the promises, whichever is more', () => {
    const r = py(RUN2 + `
# Rent £500 due on the 15th. Plan sent 5 Oct: £250 on 20 Oct and £250 on 3 Nov (arrears only, against the agent file).
c = card(out=output(plan=(("2026-10-20", 250), ("2026-11-03", 250))))
rentOnly = st([c], data_with([("2026-10-15", 500)], rent=500, due=15), date(2026, 11, 6))
planOnly = st([c], data_with([("2026-10-20", 250), ("2026-11-03", 250)], rent=500, due=15), date(2026, 10, 18))
both = st([c], data_with([("2026-10-15", 500), ("2026-10-20", 250), ("2026-11-03", 250)], rent=500, due=15), date(2026, 11, 6))
print(json.dumps({"rentOnly": rentOnly, "planOnly": planOnly, "both": both}))`);
    // Paid the rent but no arrears: by 5 Nov £500 was promised and £500 of rent fell due; £500 paid. Promises
    // are £500 in all, so it holds; the arrears were never in the plan. The agent file says each PLAN amount
    // includes the rent, so the rent check holds him to whichever is more.
    expect(r.rentOnly[0][1]).toBe('kept');
    // Skipped the 15 Oct rent and paid nothing by 17 Oct: missed at the rent's own checkpoint.
    expect(r.planOnly[0][1]).toBe('missed');
    expect(r.both[0][1]).toBe('kept');
  });

  it('money from before the card existed is never the plan\'s', () => {
    const r = py(RUN2 + `
# £200 paid 3 Dec, the card made 5 Dec, the email the same day, promise of £200 on 7 Dec.
c = card(out=output(plan=(("2026-12-07", 200),)), notes="[05 Dec 2026 10:00 — send-email] SENT: email to sam@example.com",
         created="2026-12-05T09:00:00.000Z")
print(json.dumps(st([c], data_with([("2026-12-03", 200)]), date(2026, 12, 9))))`);
    expect(r[0][1]).toBe('missed');
  });

  it('a PLAN FOR must belong to the card: its own tenancy link, or the tenancy of the tenant who sent it', () => {
    const r = py(RUN2 + `
data = data_with([])
own = st([card()], data, date(2026, 10, 8))
bySender = st([card(tenancies=(), sender="Sam Example <sam@example.com>")], data, date(2026, 10, 8))
byText = st([card(tenancies=(), sender="+44 (0)7700 900123")], data, date(2026, 10, 8))
stranger = st([card(tenancies=(), sender="someone@example.com")], data, date(2026, 10, 8))
print(json.dumps({"own": own[0][1], "bySender": bySender[0][1], "byText": byText[0][1], "stranger": stranger[0]}))`);
    expect([r.own, r.bySender, r.byText]).toEqual(['open', 'open', 'open']);
    expect(r.stranger[1]).toBe('bad');
    expect(r.stranger[2]).toMatch(/not that tenancy's and was not sent by its tenant/);
  });

  it('two plans for one tenancy: the newer counts, the older is said on the row', () => {
    const r = py(RUN2 + `
old = card(i="recPLANCARDOLD01", notes="[03 Oct 2026 10:00 — send-email] SENT: email to sam@example.com", out=output(plan=(("2026-10-09", 100),)))
new = card(i="recPLANCARDNEW01", notes="[06 Oct 2026 10:00 — send-email] SENT: email to sam@example.com", out=output(plan=(("2026-10-20", 100),)))
plans = rp.read(RC([old, new]), data_with([]), date(2026, 10, 8), {"lanes": {TEN: "late"}, "feed": {"blocked": []}})
print(json.dumps({"states": {p["id"]: p["state"] for p in plans["plans"]}, "line": rp.line(rp.act(RC([]), plans, data_with([]), date(2026, 10, 8), False, True, {}))}))`);
    expect(r.states).toEqual({ recPLANCARDOLD01: 'superseded', recPLANCARDNEW01: 'open' });
    // Normal work, not a fault: the older card gets its SUPERSEDED mark on a real run (tested below).
    expect(r.line).toBe('Payment plans: 1 agreed and on track.');
  });

  it('an approved plan whose email has not gone is said, and pauses nothing', () => {
    const r = py(RUN2 + `
plans = rp.read(RC([card(notes="RENT CHECK KEY: x")]), data_with([]), date(2026, 10, 8), {"lanes": {TEN: "late"}, "feed": {"blocked": []}})
print(json.dumps({"state": plans["plans"][0]["state"], "paused": sorted(plans["onTrack"]), "line": rp.line(rp.act(RC([]), plans, data_with([]), date(2026, 10, 8), False, True, {}))}))`);
    expect(r.state).toBe('unsent');
    expect(r.paused).toEqual([]);
    expect(r.line).toBe('Payment plans: 1 approved with the email not gone yet.');
  });

  it('a missed promise carries lane A\'s own stage key, so lane A never raises a twin; that run lane A is paused too', () => {
    const r = py(RUN2 + `
raised = []
class W(RC):
    def read_task_state(self): return {"on": True, "status": "Built", "keys": {}}
    def raise_task(self, item, day): raised.append(item); return "recNEW"
    def api(self, method, path, payload=None, params=None):
        return {"id": "x", "fields": {F["notes"]: SENT}} if method == "GET" else {}
res = {"lanes": {TEN: "late"}, "feed": {"blocked": []},
       "tenancies": [{"id": TEN, "lane": "late", "status": "In Payment", "type": "Universal Credit", "unit": "Unit 9 – 1 Example Road",
                      "rent": 500, "owed": "2026-10-01", "daysLate": 11, "note": "late"}]}
plans = rp.read(W([card()]), data_with([]), date(2026, 10, 12), res)
out = rp.act(W([card()]), plans, data_with([]), date(2026, 10, 12), True, True, res)
paused = rc.task_plan(res, [], {}, date(2026, 10, 12), plans["onTrack"])
# The next day lane A reads the keys the missed task carried.
keys = {k: date(2026, 10, 12) for k in [raised[0]["key"]] + raised[0]["alsoKeys"]}
nextDay = rc.task_plan(res, [], keys, date(2026, 10, 13))
print(json.dumps({"also": raised[0]["alsoKeys"], "paused": len(paused), "nextDay": len(nextDay)}))`);
    expect(r.also).toEqual(['recTENANCYPLAN001:2026-10-01:1']);
    expect(r.paused).toBe(0);
    // Lane A's reminder stage is taken; its follow-up waits its own gap, so no twin the next day.
    expect(r.nextDay).toBe(0);
  });

  it('an email that says "Plan: £25 a month" in passing is untouched; a plan card may text', () => {
    const r = py(RUN2 + `
prose = EMAIL.replace("Agreed.", "Plan: £25 a month from 1 November, as we discussed.")
aef.validate_submission(prose)
print(json.dumps({"prose": "ok", "text": aef.text_card("INBOUND: reply from Sam", "", output(), [CFV]), "noPlan": aef.text_card("INBOUND: reply from Sam", "", EMAIL, [CFV]),
                  "otherAgent": aef.text_card("INBOUND: reply from Sam", "", output(), [OTHER]), "key": aef.sender_key("+44 (0)7700 900123")}))`);
    // A plan card texts only when the rent lane's own agent holds it.
    expect(r).toEqual({ prose: 'ok', text: true, noPlan: false, otherAgent: false, key: '+447700900123' });
  });
});

describe('the rent check writes every key a task carries', () => {
  it('a missed-promise task keeps both its own key and lane A\'s stage key in Notes', () => {
    const r = py(`
sent = []
rc.api = lambda method, path, payload=None, params=None: sent.append(payload) or {"records": [{"id": "recNEW"}]}
rc.raise_task({"key": "recT:plan:recC:2026-10-10", "alsoKeys": ["recT:2026-10-01:1"], "tenancy": "recT", "tenants": [], "name": "n", "description": "d"}, date(2026, 10, 12))
print(json.dumps(sent[0]["records"][0]["fields"][rc.TK["notes"]]))`);
    expect(r).toBe('RENT CHECK KEY: recT:plan:recC:2026-10-10\nRENT CHECK KEY: recT:2026-10-01:1');
  });
});

describe('the second review\'s cases (4 Oct 2026)', () => {
  const H = `
trial_ended()
CONTACTS = {"recTENANTPLAN001": {rp.TENANT_CONTACT["email"]: "Sam@Example.com"}}
written, raised = {}, []
class RC:
    T_TASKS, T_TENANTS, TY = rc.T_TASKS, rc.T_TENANTS, rc.TY
    first = staticmethod(rc.first)
    payments_by_tenancy = staticmethod(rc.payments_by_tenancy)
    lane_b_rules = rc.lane_b_rules
    sel, tenant_type = staticmethod(rc.sel), staticmethod(rc.tenant_type)
    IN_PAYMENT, CFV, AGENT_MANAGED, STAGES = rc.IN_PAYMENT, rc.CFV, rc.AGENT_MANAGED, rc.STAGES
    feed_state = staticmethod(lambda data, pay, now: "feed")
    def __init__(self, cards, bank=(None, []), keys=None): self.cards, self.bank, self.keys = cards, bank, keys or {}
    def bank_view(self, feed, payments): return self.bank
    def fetch_all(self, table, params=None):
        return [{"id": k, "fields": v} for k, v in CONTACTS.items()] if table == rc.T_TENANTS else self.cards
    def read_task_state(self): return {"on": True, "status": "Built", "keys": self.keys}
    def raise_task(self, item, day): raised.append(item); return "recNEW"
    def api(self, method, path, payload=None, params=None):
        tid = path.split("/")[-1]
        if method == "GET":
            return {"id": tid, "fields": {F["notes"]: written.get(tid) or SENT}}
        written[tid] = payload["fields"][F["notes"]]
        return {}
def data_with(tx, rent=None, due=None, status="In Payment", payType=None, noChase=()):
    f = {rc.TY["unitRef"]: ["Unit 9 – 1 Example Road"], rc.TY["tenants"]: ["recTENANTPLAN001"], rc.TY["payStatus"]: status}
    if rent:
        f.update({rc.TY["rent"]: rent, rc.TY["dueDay"]: due})
    d = {"tenancies": [{"id": TEN, "fields": f}], "noChase": list(noChase),
         "tx": [{"fields": {rc.TX["date"]: dd, rc.TX["tenancy"]: [TEN], rc.TX["amount"]: a}} for dd, a in tx]}
    if payType:
        d["tenants"] = [{"id": "recTENANTPLAN001", "fields": {rc.TN["payType"]: payType}}]
    return d
RES = {"lanes": {TEN: "late"}, "feed": {"blocked": []}, "tenancies": []}
NOW = "now"
def sent(day): return f"[{day} 10:00 — send-email] SENT: email to sam@example.com"
`;
  it('an older plan never wakes when the newer one ends, and is marked superseded for good', () => {
    const r = py(H + `
A = card(i="recPLANCARDAAAA1", notes=sent("05 Oct 2026"), out=output(plan=(("2026-10-10", 100),)))
B = card(i="recPLANCARDBBBB1", notes=sent("09 Oct 2026"), out=output(plan=(("2026-10-20", 200),)))
data = data_with([("2026-10-20", 200)])
mid = rp.read(RC([A, B]), data, date(2026, 10, 15), RES, NOW)
rp.act(RC([A, B]), mid, data, date(2026, 10, 15), True, True, RES)
B_kept = card(i="recPLANCARDBBBB1", notes=sent("09 Oct 2026") + "\\nRENT PLAN KEPT: every promise kept", out=output(plan=(("2026-10-20", 200),)))
A_marked = card(i="recPLANCARDAAAA1", notes=written.get("recPLANCARDAAAA1", ""), out=output(plan=(("2026-10-10", 100),)))
A_unmarked = A
later = rp.read(RC([A_unmarked, B_kept]), data, date(2026, 10, 23), RES, NOW)
later2 = rp.read(RC([A_marked, B_kept]), data, date(2026, 10, 23), RES, NOW)
print(json.dumps({"mid": {p["id"]: p["state"] for p in mid["plans"]}, "mark": written.get("recPLANCARDAAAA1", ""),
                  "later": {p["id"]: p["state"] for p in later["plans"]}, "later2": {p["id"]: p["state"] for p in later2["plans"]}, "raised": len(raised)}))`);
    expect(r.mid).toEqual({ recPLANCARDAAAA1: 'superseded', recPLANCARDBBBB1: 'open' });
    expect(r.mark).toMatch(/RENT PLAN SUPERSEDED: card recPLANCARDBBBB1 replaced this plan/);
    // Even before its mark is read back, the newer plan (now kept) still outranks it.
    expect(r.later.recPLANCARDAAAA1).toBe('superseded');
    expect(r.later2.recPLANCARDAAAA1).toBe('over');
    expect(r.raised).toBe(0);
  });

  it('a promise is judged as at the tenancy\'s own bank feed day, and a fault on its feed means wait', () => {
    const r = py(H + `
c = card()          # PLAN 10 Oct £100, checked from 12 Oct
data = data_with([])
behind = rp.read(RC([c], bank=(date(2026, 10, 11), [])), data, date(2026, 10, 12), RES, NOW)["plans"][0]["state"]
current = rp.read(RC([c], bank=(date(2026, 10, 12), [])), data, date(2026, 10, 12), RES, NOW)["plans"][0]["state"]
faulty = rp.read(RC([c], bank=(date(2026, 10, 12), ["Santander bank feed last updated 40 hours ago"])), data, date(2026, 10, 12), RES, NOW)["plans"][0]["state"]
noFeedDay = rp.read(RC([c], bank=(None, [])), data, date(2026, 10, 12), RES, NOW)["plans"][0]["state"]
print(json.dumps([behind, current, faulty, noFeedDay]))`);
    // The feed runs only to 11 Oct: the 12 Oct check is not due yet as far as the bank can show.
    expect(r).toEqual(['open', 'missed', 'waiting', 'waiting']);
  });

  it('a plan still waiting a week after its last promise is a problem that turns the row Blocked; one too old to see is said', () => {
    const r = py(H + `
c = card()
data = data_with([])
w = rp.read(RC([c], bank=(date(2026, 11, 8), ["feed stale"])), data, date(2026, 11, 8), RES, NOW)
out = rp.act(RC([]), w, data, date(2026, 11, 8), False, True, RES)
old = rp.read(RC([c], bank=(date(2027, 1, 1), [])), data, date(2027, 1, 1), RES, NOW)["plans"][0]
print(json.dumps({"stuck": out["stuck"], "line": rp.line(out), "old": [old["state"], old["why"]]}))`);
    expect(r.stuck).toBe(true);
    expect(r.line).toMatch(/Check: card recPLANCARD00001: still cannot be judged 29 days after a payment it was owed/);
    expect(r.old[0]).toBe('bad');
    expect(r.old[1]).toMatch(/before the payments the rent check reads/);
  });

  it('two plans sent the same day: the card made later counts, whatever its id', () => {
    const r = py(H + `
first = card(i="recZZZZPLANCARD1", notes=sent("05 Oct 2026"), created="2026-10-05T08:00:00.000Z")
second = card(i="recAAAAPLANCARD1", notes=sent("05 Oct 2026"), created="2026-10-05T09:30:00.000Z")
plans = rp.read(RC([first, second], bank=(date(2026, 10, 8), [])), data_with([]), date(2026, 10, 8), RES, NOW)
print(json.dumps({p["id"]: p["state"] for p in plans["plans"]}))`);
    expect(r).toEqual({ recZZZZPLANCARD1: 'superseded', recAAAAPLANCARD1: 'open' });
  });

  it('rent due on the plan\'s first day is the plan\'s too, and a due day read as a single select still counts', () => {
    const r = py(H + `
c = card(out=output(plan=(("2026-10-30", 200),)), notes=sent("10 Oct 2026"), created="2026-10-10T08:00:00.000Z")
asText = rp.read(RC([c], bank=(date(2026, 11, 1), [])), data_with([("2026-10-30", 200)], rent=500, due="10"), date(2026, 11, 1), RES, NOW)["plans"][0]
asSelect = rp.read(RC([c], bank=(date(2026, 11, 1), [])), data_with([("2026-10-30", 200)], rent=500, due={"name": "10"}), date(2026, 11, 1), RES, NOW)["plans"][0]
print(json.dumps([asText["state"], asSelect["state"], asText.get("owed")]))`);
    // £500 fell due on 10 Oct, the day the plan began: by 12 Oct £500 was owed and nothing paid.
    expect(r).toEqual(['missed', 'missed', 500]);
  });

  it('a missed promise takes lane A\'s next stage even inside its gap, and a tenancy lane A never chases gets a note, not a task', () => {
    const r = py(H + `
res = dict(RES, tenancies=[{"id": TEN, "lane": "late", "owed": "2026-10-01"}])
keys = {f"{TEN}:2026-10-01:1": date(2026, 10, 2), f"{TEN}:2026-10-01:2": date(2026, 10, 8)}
plans = rp.read(RC([card()], bank=(date(2026, 10, 12), [])), data_with([]), date(2026, 10, 12), res, NOW)
rp.act(RC([card()], bank=(date(2026, 10, 12), []), keys=keys), plans, data_with([]), date(2026, 10, 12), True, True, res)
also = raised[0]["alsoKeys"]
raised.clear(); written.clear()
agent = rp.read(RC([card()], bank=(date(2026, 10, 12), [])), data_with([], payType="Agent-Managed"), date(2026, 10, 12), res, NOW)
rp.act(RC([card()]), agent, data_with([], payType="Agent-Managed"), date(2026, 10, 12), True, True, res)
nochase = rp.read(RC([card()], bank=(date(2026, 10, 12), [])), data_with([], noChase=["recTENANTPLAN001"]), date(2026, 10, 12), res, NOW)
print(json.dumps({"also": also, "agentRaised": len(raised), "agentNote": written.get("recPLANCARD00001", ""), "noChase": nochase["plans"][0].get("noChase")}))`);
    expect(r.also).toEqual(['recTENANCYPLAN001:2026-10-01:3']);
    expect(r.agentRaised).toBe(0);
    expect(r.agentNote).toMatch(/RENT PLAN MISSED: 2026-10-10: .*not chased, because it is agent-managed/);
    expect(r.noChase).toBe('the tenant is on the do-not-chase list');
  });

  it('the card\'s own day is London\'s', () => {
    const r = py(H + `
print(json.dumps([str(rp.created_on({"createdTime": "2026-10-04T23:30:00.000Z"})), str(rp.created_on({"createdTime": "2026-12-04T23:30:00.000Z"}))]))`);
    expect(r).toEqual(['2026-10-05', '2026-12-04']);
  });
});

describe('the third review\'s cases (5 Oct 2026)', () => {
  const H3 = `
trial_ended()
CONTACTS = {"recTENANTPLAN001": {rp.TENANT_CONTACT["email"]: "Sam@Example.com"}}
class RC:
    T_TASKS, T_TENANTS, TY = rc.T_TASKS, rc.T_TENANTS, rc.TY
    first = staticmethod(rc.first)
    payments_by_tenancy = staticmethod(rc.payments_by_tenancy)
    lane_b_rules = rc.lane_b_rules
    sel, tenant_type = staticmethod(rc.sel), staticmethod(rc.tenant_type)
    IN_PAYMENT, CFV, AGENT_MANAGED, STAGES = rc.IN_PAYMENT, rc.CFV, rc.AGENT_MANAGED, rc.STAGES
    feed_state = staticmethod(lambda data, pay, now: "feed")
    def __init__(self, cards, bank=(None, [])): self.cards, self.bank = cards, bank
    def bank_view(self, feed, payments): return self.bank
    def fetch_all(self, table, params=None):
        return [{"id": k, "fields": v} for k, v in CONTACTS.items()] if table == rc.T_TENANTS else self.cards
TEN2 = "recTENANCYPLAN002"
def data_with(tx, rent=None, due=None):
    f = {rc.TY["unitRef"]: ["Unit 9 – 1 Example Road"], rc.TY["tenants"]: ["recTENANTPLAN001"], rc.TY["payStatus"]: "In Payment"}
    if rent:
        f.update({rc.TY["rent"]: rent, rc.TY["dueDay"]: str(due)})
    return {"tenancies": [{"id": TEN, "fields": f}, {"id": TEN2, "fields": {rc.TY["tenants"]: ["recOTHERTENANT01"], rc.TY["payStatus"]: "In Payment"}}],
            "tx": [{"fields": {rc.TX["date"]: d, rc.TX["tenancy"]: [TEN], rc.TX["amount"]: a}} for d, a in tx]}
RES = {"lanes": {TEN: "late", TEN2: "late"}, "feed": {"blocked": []}, "tenancies": []}
def sent(day): return f"[{day} 10:00 — send-email] SENT: email to sam@example.com"
`;
  it('a card the ownership check rejects never outranks a good plan', () => {
    const r = py(H3 + `
good = card(i="recPLANGOOD00001", notes=sent("05 Oct 2026"))
wrong = card(i="recPLANWRONG0001", notes=sent("06 Oct 2026"), tenancies=(TEN2,), sender="someone@example.com")
plans = rp.read(RC([good, wrong], bank=(date(2026, 10, 8), [])), data_with([]), date(2026, 10, 8), RES, "now")
print(json.dumps({"states": {p["id"]: p["state"] for p in plans["plans"]}, "onTrack": sorted(plans["onTrack"])}))`);
    expect(r.states).toEqual({ recPLANGOOD00001: 'open', recPLANWRONG0001: 'bad' });
    expect(r.onTrack).toEqual(['recTENANCYPLAN001']);
  });

  it('a stale feed past a checkpoint is waiting, not on track, and grows loud a week after the payment it waits on', () => {
    const r = py(H3 + `
c = card()          # 10 Oct £100, 24 Oct £300
stale = lambda d: rp.read(RC([c], bank=(date(2026, 10, 1), ["Santander bank feed last updated 300 hours ago"])), data_with([]), d, RES, "now")["plans"][0]
early, later = stale(date(2026, 10, 13)), stale(date(2026, 10, 20))
# Unknown lane from 12 Oct with a far second promise: loud a week after the first payment, not the last.
far = card(out=output(plan=(("2026-10-10", 100), ("2026-12-10", 400))))
grey = rp.read(RC([far], bank=(date(2026, 11, 1), [])), data_with([]), date(2026, 11, 1), dict(RES, lanes={TEN: "unknown"}), "now")["plans"][0]
print(json.dumps({"early": [early["state"], early.get("stuck")], "later": [later["state"], later.get("stuck")], "grey": [grey["state"], grey.get("stuck")]}))`);
    expect(r.early).toEqual(['waiting', false]);
    expect(r.later).toEqual(['waiting', true]);
    expect(r.grey).toEqual(['waiting', true]);
  });

  it('a rent paid early, before the plan began, is not the plan\'s to hold', () => {
    const r = py(H3 + `
# Due on the 1st; card made and sent 30 Oct; promise of £1,000 on 10 Nov; November's £500 landed 28 Oct.
c = card(out=output(plan=(("2026-11-10", 1000),)), notes=sent("30 Oct 2026"), created="2026-10-30T09:00:00.000Z")
paidEarly = rp.read(RC([c], bank=(date(2026, 11, 3), [])), data_with([("2026-10-28", 500)], rent=500, due=1), date(2026, 11, 3), RES, "now")["plans"][0]["state"]
notPaid = rp.read(RC([c], bank=(date(2026, 11, 3), [])), data_with([], rent=500, due=1), date(2026, 11, 3), RES, "now")["plans"][0]["state"]
print(json.dumps([paidEarly, notPaid]))`);
    expect(r).toEqual(['open', 'missed']);
  });
});

