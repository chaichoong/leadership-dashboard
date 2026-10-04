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
def card(i="recPLANCARD00001", outcome="Approved as-is", notes=SENT, out=None, agent=CFV, approved="2026-10-05T09:00:00.000Z", name="INBOUND: reply from Sam"):
    return {"id": i, "fields": {F["name"]: name, F["status"]: "Completed", F["notes"]: notes, F["output"]: out if out is not None else output(),
                               F["outcome"]: outcome, F["approvedAt"]: approved, F["sentBy"]: [agent], F["teamMember"]: [agent]}}
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
    for (const k of ['ukDate', 'noPound', 'lower']) expect(r[k], k).toMatch(/written exactly as "PLAN: 2026-10-10 £100.00"/);
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
class RC:
    T_TASKS, TY = rc.T_TASKS, rc.TY
    first = staticmethod(rc.first)
    payments_by_tenancy = staticmethod(rc.payments_by_tenancy)
    lane_b_rules = rc.lane_b_rules
    def __init__(self, cards, keys=None): self.cards, self.keys = cards, keys or {}
    def fetch_all(self, table, params=None): return self.cards
    def read_task_state(self): return {"on": True, "status": "Built", "keys": self.keys}
    def raise_task(self, item, day): raised.append({"key": item["key"], "name": item["name"], "tenants": item["tenants"]}); return "recNEW"
    def api(self, method, path, payload=None, params=None):
        tid = path.split("/")[-1]
        if method == "GET":
            return {"id": tid, "fields": {F["notes"]: CARDS.get(tid, "")}}
        notes_written[tid] = payload["fields"][F["notes"]]
        return {}
def data_with(tx):
    return {"tenancies": [{"id": TEN, "fields": {rc.TY["unitRef"]: ["Unit 9 – 1 Example Road"], rc.TY["tenants"]: ["recTENANTPLAN001"]}}],
            "tx": [{"fields": {rc.TX["date"]: d, rc.TX["tenancy"]: [TEN], rc.TX["amount"]: a}} for d, a in tx]}
`;
  it('a missed promise raises one RENT LATE task back to the chase, with the tenants linked, and marks the card', () => {
    const r = py(RUN + `
fake = RC([card()])
data = data_with([("2026-10-10", 40)])
plans = rp.read(fake, data, date(2026, 10, 12))
out = rp.act(fake, plans, data, date(2026, 10, 12), True, True)
again = rp.act(RC([card()], keys={raised[0]["key"]: date(2026, 10, 12)}), rp.read(RC([card()]), data, date(2026, 10, 13)), data, date(2026, 10, 13), True, True)
print(json.dumps({"out": out, "raised": raised, "note": notes_written.get("recPLANCARD00001", ""), "againRaised": len(raised), "line": rp.line(out)}))`);
    expect(r.out.missed).toEqual(['recPLANCARD00001']);
    expect(r.raised[0]).toEqual({ key: 'recTENANCYPLAN001:plan:recPLANCARD00001:2026-10-10', name: 'RENT LATE: Unit 9 – 1 Example Road, payment plan promise of 10 Oct missed', tenants: ['recTENANTPLAN001'] });
    expect(r.note).toMatch(/RENT PLAN MISSED: 2026-10-10: £100.00 promised by then, £40.00 received; the chase starts again/);
    // A second run with the task already raised raises no second one.
    expect(r.againRaised).toBe(1);
    expect(r.line).toBe('Payment plans: 1 missed a promise.');
  });

  it('a kept plan is marked kept; an open plan is on track and lane A does not chase that tenancy', () => {
    const r = py(RUN + `
data = data_with([("2026-10-10", 100), ("2026-10-24", 300)])
kept = rp.act(RC([card()]), rp.read(RC([card()]), data, date(2026, 10, 26)), data, date(2026, 10, 26), True, True)
opened = rp.read(RC([card()]), data_with([("2026-10-10", 100)]), date(2026, 10, 20))
res = {"tenancies": [{"id": TEN, "lane": "late", "status": "In Payment", "type": "Universal Credit", "unit": "Unit 9 – 1 Example Road",
                      "rent": 500, "owed": "2026-10-01", "daysLate": 19, "note": "late"}], "feed": {"asAt": "x"}}
chased = rc.task_plan(res, [], {}, date(2026, 10, 20))
paused = rc.task_plan(res, [], {}, date(2026, 10, 20), opened["onTrack"])
print(json.dumps({"kept": kept["kept"], "note": notes_written.get("recPLANCARD00001", ""), "onTrack": sorted(opened["onTrack"]),
                  "chased": len(chased), "paused": len(paused), "line": rp.line(rp.act(RC([card()]), opened, data, date(2026, 10, 20), True, True))}))`);
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
plans = rp.read(RC([card()]), data, date(2026, 10, 12))
off = rp.act(RC([card()]), plans, data, date(2026, 10, 12), True, False)
dry = rp.act(RC([card()]), plans, data, date(2026, 10, 12), False, True)
stranger = rp.read(RC([card(out=output(tenancy="recNOTLIVETENANCY"))]), data, date(2026, 10, 12))
bad = rp.act(RC([]), stranger, data, date(2026, 10, 12), True, True)
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
failed = rp.read(Broken([]), data_with([]), date(2026, 10, 12))
CARDS["recPLANCARD00001"] = ""
data = data_with([])
out = rp.act(RC([card()]), rp.read(RC([card()]), data, date(2026, 10, 12)), data, date(2026, 10, 12), True, True)
print(json.dumps({"failed": failed["failed"], "onTrack": sorted(failed["onTrack"]), "actFailed": out["failed"], "written": len(notes_written),
                  "line": rp.line(rp.act(RC([]), failed, data, date(2026, 10, 12), True, True))}))`);
    expect(r.failed).toMatch(/payment plans could not be read: Airtable 500/);
    expect(r.onTrack).toEqual([]);
    expect(r.line).toMatch(/^Payment plans FAILED/);
    expect(r.actFailed).toMatch(/read back empty/);
    expect(r.written).toBe(0);
  });
});
