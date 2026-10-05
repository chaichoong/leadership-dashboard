// Benefit-cap claims (Cash Flow Voids lane C; Kevin approved "Build as-is" on 4 Oct 2026, and "Yes, runs for real"
// for the claim card). scripts/rent_cap.py raises the agent's RENT CAP task, Kevin's RENT CLAIM and RENT CLAIM
// DECISION cards, reads his verdicts and keeps each claim moving; the signed step ticks Authority Signed; the
// robots' link script makes a tenant's form link. These drive the REAL code with Airtable stubbed: every id,
// name, number and amount is invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(root, 'scripts');
const require_ = createRequire(import.meta.url);

const HARNESS = `
import importlib.util, json, sys, os, io, contextlib, argparse, re, tempfile
from datetime import date, timedelta
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
# The Cash Flow Voids trial ended on 5 Oct 2026; these cases were written for the trial and prove its doors, so
# each run puts the agent back on trial in its own process (tests/cash-flow-voids-agent.test.js block 10 reads
# the real lists).
import agent_email_format as _aef_trial
_aef_trial.TRIAL_AGENTS["rec7aHLK1Q8fMLRXH"] = "the Cash Flow Voids agent is on its trial run, so Kevin checks its drafts and nothing is sent to a tenant"
_aef_trial.TRIAL_ENDED.pop("rec7aHLK1Q8fMLRXH", None)
sys.argv = ["test"]
def load_mod(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(SCRIPTS)}, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
import agent_email_format as aef
import rent_cap as cap
rc = load_mod("rc", "rent-check.py")
F, TN = cap.F, cap.TN
CFV, OTHER = "rec7aHLK1Q8fMLRXH", "recOtherAgent0001"
TEN, TENANT = "recTENANCYCAP0001", "recTENANTCAP00001"
CYCLE = "2026-09-23"
def task(i, name, notes, status="Completed", outcome="", feedback="", approved=None, created="2026-09-25T09:00:00.000Z",
         desc="", some_day=False):
    return {"id": i, "createdTime": created, "fields": {F["name"]: name, F["status"]: status, F["notes"]: notes,
            F["description"]: desc, F["outcome"]: outcome, F["feedback"]: feedback, F["approvedAt"]: approved,
            F["someDay"]: some_day, F["tenancies"]: [TEN]}}
def cap_task(case=CYCLE, status="Completed", created="2026-09-25T09:00:00.000Z", i="recCAPTASK0000001", got="836.52"):
    desc = ("The rent due 23 Sep 2026 arrived short: £%s of £897.52.\\n\\nRENT CHECK KEY: cap:%s:%s" % (got, TEN, case)
            if not case.startswith("renew:") else "RENT CHECK KEY: cap:%s:%s" % (TEN, case))
    return task(i, "RENT CAP: Unit 9, rent due 23 Sep paid short", "RENT CHECK KEY: cap:" + TEN + ":" + case, status, created=created,
                desc=desc)
SUBMITTED = "[25 Sep 2026 09:05 — agent-dispatch] SUBMITTED (round 1)"
def claim(n=1, case=CYCLE, status="Approval", outcome="", feedback="", approved=None, notes_extra="", created="2026-09-26T09:00:00.000Z",
          i=None, some_day=False):
    return task(i or "recCLAIMCARD%05d" % n, "RENT CLAIM: Unit 9, council housing payment",
                "RENT CLAIM KEY: claim:%s:%s:%d\\n%s%s" % (TEN, case, n, SUBMITTED, notes_extra), status, outcome, feedback, approved, created,
                some_day=some_day)
def decision(n=1, case=CYCLE, status="Approval", outcome="", feedback="", approved=None, notes_extra="", created="2026-10-20T09:00:00.000Z"):
    return task("recDECISION%06d" % n, "RENT CLAIM DECISION: Unit 9, has the council answered?",
                "RENT CLAIM KEY: decision:%s:%s:%d\\n%s%s" % (TEN, case, n, SUBMITTED, notes_extra), status, outcome, feedback, approved, created)
class Fake:
    T_TASKS, T_TENANTS = "tblqB8b22hKBL4PF1", "tblX4elTuu01gwBYh"
    def __init__(self, caps=(), cards=(), tenants=None, late=(), capped=()):
        self.caps, self.cards, self.tenants, self.late, self.capped = list(caps), list(cards), tenants or {}, list(late), list(capped)
    def fetch_all(self, table, params):
        f = params.get("filterByFormula", "")
        if table == self.T_TENANTS and "Benefit Cap Exemption" in f:
            return [{"id": k, "fields": {}} for k in self.capped]
        if table == self.T_TENANTS:
            return [{"id": k, "fields": v} for k, v in self.tenants.items() if k in f]
        if "RENT LATE" in f:
            return self.late
        return self.caps if "RENT CAP" in f else self.cards
def view(caps=(), cards=()):
    v, problems = cap.read(Fake(caps, cards))
    return v.get(TEN, {"caps": [], "claims": [], "decisions": []})
GOOD = {TN["name"]: "Sam Example", TN["dob"]: "1980-03-07", TN["ni"]: "QQ123456C", TN["household"]: {"name": "Single"},
        TN["weeklyIncome"]: 210.5, TN["weeklySpending"]: 190.0, TN["saved"]: "2026-09-28T10:00:00.000Z", TN["authority"]: True,
        TN["phone"]: "07700 900123", TN["email"]: "sam@example.com", TN["cap"]: {"name": "None (capped)"}}
TENANCY = {"fld1i5bDoHL3B6rUf": [TENANT]}
SHORT = {"id": TEN, "lane": "short", "type": "Universal Credit", "status": "In Payment", "cycle": CYCLE, "got": 836.52, "rent": 897.52}
def plan(caps=(), cards=(), row=SHORT, tenant=GOOD, day=date(2026, 10, 1), no_chase=False):
    return cap.plan(TEN, view(caps, cards), row, TENANCY, {TENANT: dict(tenant)} if tenant is not None else {}, day, no_chase)
def kinds(p): return [(x["kind"], x["case"], x.get("n")) for x in p["raise"]]
def acts(p): return [(c["id"], c["do"]) for c in p["acts"]]
`;
function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('the marks: a cap task is the trial lane\'s, a claim card is Kevin\'s with every door shut', () => {
  it('RENT CAP is on trial by name or key and may text; the claim cards are shut to every agent door but never open a window', () => {
    const r = py(`
print(json.dumps({
  "capByName": bool(aef.trial_problem([OTHER], "RENT CAP: Unit 9, rent due 23 Sep paid short", "")),
  "capByKey": bool(aef.trial_problem([OTHER], "Renamed", "RENT CHECK KEY: cap:" + TEN + ":" + CYCLE)),
  "capText": aef.text_card("RENT CAP: Unit 9", ""),
  "claimShut": [aef.form_card("RENT CLAIM: Unit 9, council housing payment", ""), aef.form_card("Renamed", "x\\nRENT CLAIM KEY: claim:a"),
                aef.form_card("RENT CLAIM DECISION: Unit 9, has the council answered?", "")],
  "claimWindow": [aef.form_card("RENT CLAIM: Unit 9", "RENT CLAIM KEY: claim:a", holders=[CFV]),
                  aef.form_card("RENT CLAIM DECISION: Unit 9", "RENT CLAIM KEY: decision:a", holders=[CFV])],
  "formWindow": aef.form_card("RENT FORM: x", "RENT FORM KEY: y", holders=[CFV]),
  "others": [aef.form_card("RENT LATE: Unit 9", "RENT CHECK KEY: x"), aef.form_card("RENT CAP: Unit 9", "RENT CHECK KEY: cap:x"),
             aef.text_card("RENT CLAIM: Unit 9", "RENT CLAIM KEY: claim:a")],
  "same": [cap.CLAIM_KEY_MARK == aef.KEVIN_CARDS[CFV]["note"], cap.CLAIM_PREFIX.startswith(aef.KEVIN_CARDS[CFV]["prefix"]),
           cap.DECISION_PREFIX.startswith(aef.KEVIN_CARDS[CFV]["prefix"]), cap.CAP_KEY_MARK == rc.KEY_MARK,
           cap.CAP_PREFIX in aef.TRIAL_TASK_MARKS[CFV]["prefix"], cap.CAP_PREFIX in aef.TEXT_CARD_MARKS["prefix"]],
  "taskManager": load_mod("tm", "task-manager.py").KEVIN_CARD_MARKS == aef.KEVIN_CARDS,
  "tmOwnLane": load_mod("tm2", "task-manager.py").form_card_task({"Task Name": "RENT CLAIM: Unit 9", "Notes": ""}),
  "kevinCards": aef.KEVIN_CARDS, "clause": load_mod("ar", "agent-accuracy-report.py").FORM_KEY_CLAUSE}))`);
    expect([r.capByName, r.capByKey, r.capText]).toEqual([true, true, true]);
    expect(r.claimShut).toEqual([true, true, true]);
    expect(r.claimWindow).toEqual([false, false]);
    expect(r.formWindow).toBe(true);
    expect(r.others).toEqual([false, false, false]);
    expect(r.same).toEqual([true, true, true, true, true, true]);
    expect([r.taskManager, r.tmOwnLane]).toEqual([true, true]);
    // The accuracy page reads the same marks and leaves the same cards out of every score.
    const A = require_(path.join(root, 'js', 'agent-accuracy.js'));
    expect(A.KEVIN_CARD_MARKS).toEqual(r.kevinCards);
    expect(A.isFormCard('RENT CLAIM: Unit 9, council housing payment', '')).toBe(true);
    expect(A.isFormCard('Renamed', 'RENT CLAIM KEY: decision:x')).toBe(true);
    expect(A.isFormCard('RENT CAP: Unit 9', 'RENT CHECK KEY: cap:x')).toBe(false);
    expect(', ' + A.FORM_CARD_CLAUSE).toBe(r.clause);
    expect(r.clause).toContain("NOT(FIND('RENT CLAIM KEY: ', {Notes}&''))");
  });

  it('the queue never settles a claim card as a trial check, the lessons job never learns from it, and the report never scores it', () => {
    const r = py(`
ad = load_mod("ad", "agent-dispatch.py")
def rec(i, name, notes, outcome="Approved as-is"):
    return {"id": i, "fields": {ad.AF["name"]: name, ad.AF["notes"]: notes, ad.AF["approvalOutcome"]: outcome,
            ad.AF["approvedAt"]: "2026-10-02T09:00:00.000Z", ad.AF["sentForApprovalBy"]: [CFV], ad.AF["teamMember"]: [CFV],
            ad.AF["status"]: {"name": "Approval"}, ad.AF["agentOutput"]: "x"}}
CLAIM = rec("recCLAIMCARD00001", "RENT CLAIM: Unit 9, council housing payment", "RENT CLAIM KEY: claim:" + TEN + ":" + CYCLE + ":1")
LATE = rec("recLATECARD000001", "RENT LATE: Unit 9, rent due 1 Oct (reminder)", "RENT CHECK KEY: x")
ad.query_tasks = lambda *a, **k: [CLAIM, LATE]
settle = [t["id"] for t in ad.trial_approved_tasks()]
CLAIM["fields"]["Remember This"] = True
CLAIM["fields"][ad.AF["approvalFeedback"]] = "Use the other council"
ad.pending_lessons = lambda: [CLAIM]
stamped, wrote = [], []
ad.patch_task = lambda tid, fields: stamped.append(tid)
ad.append_lesson_to_file = lambda *a, **k: wrote.append(a) or {}
ad.mirror_lesson_to_register = lambda *a, **k: wrote.append(a)
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    ad.cmd_lessons(argparse.Namespace())
lessons = json.loads(buf.getvalue())
ar = load_mod("ar", "agent-accuracy-report.py")
scored = ar.decisions_from([{"fields": {"Task Name": "RENT CLAIM: Unit 9, council housing payment", "Approval Outcome": "Approved as-is",
                                        "Sent For Approval By": [CFV], "Task Type": "Admin"}}])
print(json.dumps({"settle": settle, "formCards": lessons["formCards"], "written": lessons["written"], "wrote": len(wrote), "scored": scored}))`);
    // The late-rent card is a trial check the queue closes; the claim card is the rent check's to close.
    expect(r.settle).toEqual(['recLATECARD000001']);
    expect([r.formCards, r.written, r.wrote]).toEqual([['recCLAIMCARD00001'], [], 0]);
    expect(r.scored).toEqual([]);
  });
});

describe('the RENT CAP task', () => {
  it('worked example: a Universal Credit tenancy paid £836.52 of £897.52 raises one task, once for that cycle', () => {
    const r = py(`
first = plan()
item = cap.cap_item(rc, TEN, first["raise"][0], "Unit 9", [TENANT], date(2026, 10, 1))
again = plan(caps=[cap_task(status="Completed")])
print(json.dumps({"first": kinds(first), "stage": first["stage"], "item": item, "again": [k for k in kinds(again) if k[0] == "cap"]}))`);
    expect(r.first).toEqual([['cap', '2026-09-23', null]]);
    expect(r.stage).toBe('benefit-cap task raised for the agent');
    expect(r.item.name).toBe('RENT CAP: Unit 9, rent due 23 Sep paid short');
    expect(r.item.key).toBe('cap:recTENANCYCAP0001:2026-09-23');
    expect(r.item.description).toContain('arrived short: £836.52 of £897.52');
    expect(r.item.description).toContain('TRIAL: you draft, Kevin checks, nothing is sent to the tenant.');
    expect(r.item.description.trim().split('\n').pop()).toBe('RENT CHECK KEY: cap:recTENANCYCAP0001:2026-09-23');
    expect(r.item.tenants).toEqual(['recTENANTCAP00001']);
    expect(r.again).toEqual([]);
  });

  it('worked example: a tenancy paying in full raises nothing; nor does a working tenant, a void, the do-not-chase list or an open task', () => {
    const r = py(`
full = plan(row={"id": TEN, "lane": "fine"})
working = plan(row=dict(SHORT, type="Working"))
agent = plan(row=dict(SHORT, type="Agent-Managed"))
void = plan(row=dict(SHORT, status="CFV"))
nochase = plan(no_chase=True)
nocycle = plan(row=dict(SHORT, cycle=None))
open_task = plan(caps=[cap_task(case="2026-08-23", status="Today")], row=SHORT, tenant=dict(GOOD, **{TN["authority"]: False}))
print(json.dumps({"k": [kinds(x) for x in (full, working, agent, void, nochase, nocycle, open_task)], "openStage": open_task["stage"]}))`);
    expect(r.k).toEqual([[], [], [], [], [], [], []]);
    expect(r.openStage).toBe('benefit-cap task with the agent; claim not raised yet: the letter of authority is not ticked as signed');
  });

  it('a later short cycle raises the next task once the last is closed, unless a claim is under way or an award is in force', () => {
    const r = py(`
oct = dict(SHORT, cycle="2026-10-23")
day = date(2026, 10, 26)
nxt = plan(caps=[cap_task()], row=oct, day=day, tenant=dict(GOOD, **{TN["authority"]: False}))
with_kevin = plan(caps=[cap_task()], cards=[claim()], row=oct, day=day)
sent = plan(caps=[cap_task()], cards=[claim(status="Completed", outcome="Approved as-is", approved="2026-10-02T09:00:00.000Z")], row=oct, day=day)
award = plan(caps=[cap_task()], cards=[claim(status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x"),
                                         decision(status="Completed", notes_extra="\\nRENT CLAIM AWARD: 2027-03-31 (x)")], row=oct, day=day)
refused = plan(caps=[cap_task()], cards=[claim(status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x"),
                                         decision(status="Completed", notes_extra="\\nRENT CLAIM AWARD: REFUSED (x)")], row=oct, day=day)
print(json.dumps({"next": kinds(nxt), "withKevin": kinds(with_kevin), "sent": [k for k in kinds(sent) if k[0] == "cap"],
                  "award": kinds(award), "awardStage": award["stage"], "refused": kinds(refused)}))`);
    expect(r.next).toEqual([['cap', '2026-10-23', null]]);
    expect(r.withKevin).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(r.award).toEqual([]);
    expect(r.awardStage).toBe('award until 31 Mar 2027');
    expect(r.refused).toEqual([['cap', '2026-10-23', null]]);
  });
});

describe('the RENT CLAIM card is raised once the tenant has done their part', () => {
  it('needs a recent case, a saved form, the authority ticked and every answer the council needs', () => {
    const r = py(`
base = [cap_task()]
ok = plan(caps=base, row={"id": TEN, "lane": "fine"})
nosave = plan(caps=base, tenant={k: v for k, v in GOOD.items() if k != TN["saved"]})
noauth = plan(caps=base, tenant=dict(GOOD, **{TN["authority"]: False}))
blank = plan(caps=base, tenant=dict(GOOD, **{TN["ni"]: "", TN["weeklyIncome"]: None}))
early = plan(caps=base, tenant=dict(GOOD, **{TN["saved"]: "2026-07-01T10:00:00.000Z"}))
inwindow = plan(caps=base, tenant=dict(GOOD, **{TN["saved"]: "2026-08-10T10:00:00.000Z"}))
old_case = plan(caps=[cap_task(created="2026-06-01T09:00:00.000Z")], row={"id": TEN, "lane": "fine"})
gone = plan(caps=base, row=None)
print(json.dumps({"ok": kinds(ok), "okStage": ok["stage"], "claimant": ok["raise"][0]["claimant"]["id"],
                  "why": [x["stage"] for x in (nosave, noauth, blank, early)], "raised": [kinds(x) for x in (nosave, noauth, blank, early)],
                  "inwindow": kinds(inwindow), "oldCase": kinds(old_case), "gone": kinds(gone)}))`);
    expect(r.ok).toEqual([['claim', '2026-09-23', 1]]);
    expect(r.okStage).toBe('claim card raised for Kevin');
    expect(r.claimant).toBe('recTENANTCAP00001');
    expect(r.why).toEqual([
      'claim not raised yet: the tenant has not saved the details form',
      'claim not raised yet: the letter of authority is not ticked as signed',
      'claim not raised yet: blank on the tenant record: ni, weeklyIncome',
      'claim not raised yet: the details form was last saved 1 Jul, before this case',
    ]);
    expect(r.raised).toEqual([[], [], [], []]);
    // A form saved up to 60 days before the case still counts; a case older than 90 days is over.
    expect(r.inwindow).toEqual([['claim', '2026-09-23', 1]]);
    expect(r.oldCase).toEqual([]);
    expect(r.gone).toEqual([]);
  });

  it('Approve = the claim went in: marked sent, then the council\'s answer is asked for three weeks on', () => {
    const r = py(`
approved = claim(status="Approval", outcome="Approved as-is", approved="2026-10-02T09:00:00.000Z")
today = plan(caps=[cap_task()], cards=[approved], day=date(2026, 10, 2))
marked = claim(status="Completed", outcome="Approved as-is", approved="2026-10-02T09:00:00.000Z", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x")
early = plan(caps=[cap_task()], cards=[marked], day=date(2026, 10, 22))
due = plan(caps=[cap_task()], cards=[marked], day=date(2026, 10, 23))
print(json.dumps({"acts": acts(today), "raise": kinds(today), "early": [kinds(early), early["stage"]], "due": kinds(due),
                  "sent": due["raise"][0]["sent"]}, default=str))`);
    expect(r.acts).toEqual([['recCLAIMCARD00001', 'sent']]);
    expect(r.raise).toEqual([]);
    expect(r.early).toEqual([[], "claim sent 2 Oct; asking for the council's answer from 23 Oct"]);
    expect(r.due).toEqual([['decision', '2026-09-23', 1]]);
    expect(r.sent).toBe('2026-10-02');
  });

  it('Request changes withdraws it; it comes again a week later, or as soon as the form is saved again, quoting what Kevin said', () => {
    const r = py(`
changes = claim(outcome="Changes requested", feedback="The NI number is wrong")
now = plan(caps=[cap_task()], cards=[changes], day=date(2026, 10, 3))
gone = claim(status="Cancelled", outcome="Changes requested", notes_extra='\\nRENT CLAIM WITHDRAWN: 2026-10-03 Kevin asked for changes: "The NI number is wrong"')
wait = plan(caps=[cap_task()], cards=[gone], day=date(2026, 10, 9))
week = plan(caps=[cap_task()], cards=[gone], day=date(2026, 10, 10))
saved = plan(caps=[cap_task()], cards=[gone], day=date(2026, 10, 5), tenant=dict(GOOD, **{TN["saved"]: "2026-10-04T08:00:00.000Z"}))
print(json.dumps({"now": [acts(now), kinds(now)], "wait": [kinds(wait), wait["stage"]], "week": kinds(week),
                  "prior": week["raise"][0]["prior"], "saved": kinds(saved)}))`);
    expect(r.now).toEqual([[['recCLAIMCARD00001', 'withdraw']], []]);
    expect(r.wait).toEqual([[], 'claim card withdrawn, raised again when ready']);
    expect(r.week).toEqual([['claim', '2026-09-23', 2]]);
    expect(r.prior).toBe('The NI number is wrong');
    expect(r.saved).toEqual([['claim', '2026-09-23', 2]]);
  });

  it('Reject ends the case; a later case needs the form saved again. Closed by hand ends it too. Parked stays his.', () => {
    const r = py(`
rej = plan(caps=[cap_task()], cards=[claim(outcome="Rejected")])
ended = claim(status="Completed", outcome="Rejected", notes_extra="\\nRENT CLAIM ENDED: 2026-10-01 Kevin rejected the claim card")
oct = dict(SHORT, cycle="2026-10-23")
later_cap = cap_task(case="2026-10-23", created="2026-10-26T09:00:00.000Z", i="recCAPTASK0000002")
not_saved = plan(caps=[cap_task(), later_cap], cards=[ended], row=oct, day=date(2026, 10, 27))
resaved = plan(caps=[cap_task(), later_cap], cards=[ended], row=oct, day=date(2026, 10, 27),
               tenant=dict(GOOD, **{TN["saved"]: "2026-10-20T08:00:00.000Z"}))
by_hand = plan(caps=[cap_task()], cards=[claim(status="Cancelled")])
parked = plan(caps=[cap_task()], cards=[claim(status="Upcoming")], row=oct, day=date(2026, 10, 26))
some_day = plan(caps=[cap_task()], cards=[claim(status="", some_day=True)])
# Parked for some day before its submit stamp was read back: still his, never withdrawn as lost.
unstamped = task("recCLAIMCARD00001", "RENT CLAIM: Unit 9, council housing payment", "RENT CLAIM KEY: claim:%s:%s:1" % (TEN, CYCLE), "",
                 some_day=True)
some_day_raw = plan(caps=[cap_task()], cards=[unstamped])
print(json.dumps({"rej": acts(rej), "notSaved": [kinds(not_saved), not_saved["stage"]], "resaved": kinds(resaved),
                  "byHand": acts(by_hand), "parked": [acts(parked), kinds(parked), parked["stage"]], "someDay": acts(some_day),
                  "someDayRaw": [acts(some_day_raw), some_day_raw["stage"]]}))`);
    expect(r.rej).toEqual([['recCLAIMCARD00001', 'end']]);
    expect(r.notSaved).toEqual([[], 'claim ended (Kevin rejected the claim card); claim not raised yet: the last claim was ended and the form has not been saved since']);
    expect(r.resaved).toEqual([['claim', '2026-10-23', 1]]);
    expect(r.byHand).toEqual([['recCLAIMCARD00001', 'end']]);
    expect(r.parked).toEqual([[], [], 'claim card parked by Kevin']);
    expect(r.someDay).toEqual([]);
    expect(r.someDayRaw).toEqual([[], 'claim card parked by Kevin']);
  });

  it('a card that never reached Kevin\'s queue is withdrawn and raised again the next day', () => {
    const r = py(`
lost = task("recCLAIMCARD00001", "RENT CLAIM: Unit 9, council housing payment", "RENT CLAIM KEY: claim:%s:%s:1" % (TEN, CYCLE), "Today",
            created="2026-09-26T09:00:00.000Z")
now = plan(caps=[cap_task()], cards=[lost], day=date(2026, 10, 1))
gone = task("recCLAIMCARD00001", "RENT CLAIM: Unit 9, council housing payment",
            "RENT CLAIM KEY: claim:%s:%s:1\\nRENT CLAIM WITHDRAWN: 2026-10-01 it never reached Kevin's queue" % (TEN, CYCLE), "Cancelled",
            created="2026-09-26T09:00:00.000Z")
same = plan(caps=[cap_task()], cards=[gone], day=date(2026, 10, 1))
nxt = plan(caps=[cap_task()], cards=[gone], day=date(2026, 10, 2))
print(json.dumps({"now": [acts(now), kinds(now)], "same": kinds(same), "next": kinds(nxt), "prior": nxt["raise"][0]["prior"]}))`);
    expect(r.now).toEqual([[['recCLAIMCARD00001', 'lost']], []]);
    expect(r.same).toEqual([]);
    expect(r.next).toEqual([['claim', '2026-09-23', 2]]);
    expect(r.prior).toBeNull();
  });
});

describe('the council\'s answer', () => {
  const SENT = `claim(status="Completed", outcome="Approved as-is", approved="2026-10-02T09:00:00.000Z", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x")`;
  it('an end date records the award: no short-cycle task while it runs, a renewal a month before it ends', () => {
    const r = py(`
sent = ${SENT}
d = decision(outcome="Approved with minor edits", feedback="AWARD UNTIL: 31 March 2027", approved="2026-10-25T09:00:00.000Z")
now = plan(caps=[cap_task()], cards=[sent, d], day=date(2026, 10, 25), row=dict(SHORT, cycle="2026-10-23"))
d2 = decision(status="Completed", outcome="Approved with minor edits", notes_extra="\\nRENT CLAIM AWARD: 2027-03-31 (read)")
before = plan(caps=[cap_task()], cards=[sent, d2], day=date(2027, 2, 28), row=dict(SHORT, cycle="2027-02-23"))
renew = plan(caps=[cap_task()], cards=[sent, d2], day=date(2027, 3, 1), row=dict(SHORT, cycle="2027-02-23"))
rcap = cap_task(case="renew:2027-03-31", created="2027-03-01T09:00:00.000Z", i="recCAPTASK0000003")
old_save = plan(caps=[cap_task(), rcap], cards=[sent, d2], day=date(2027, 3, 3), row={"id": TEN, "lane": "fine"},
                tenant=dict(GOOD, **{TN["saved"]: "2027-02-15T08:00:00.000Z"}))
new_save = plan(caps=[cap_task(), rcap], cards=[sent, d2], day=date(2027, 3, 3), row={"id": TEN, "lane": "fine"},
                tenant=dict(GOOD, **{TN["saved"]: "2027-03-02T08:00:00.000Z"}))
item = cap.cap_item(rc, TEN, renew["raise"][0], "Unit 9", [], date(2027, 3, 1))
print(json.dumps({"now": [acts(now), kinds(now), now["stage"]], "before": kinds(before), "renew": kinds(renew), "name": item["name"],
                  "oldSave": [kinds(old_save), old_save["stage"]], "newSave": kinds(new_save),
                  "newSavePayee": new_save["raise"][0]["payee"] if new_save["raise"] else None}, default=str))`);
    expect(r.now).toEqual([[['recDECISION000001', 'award']], [], 'award until 31 Mar 2027']);
    expect(r.before).toEqual([]);
    expect(r.renew).toEqual([['cap', 'renew:2027-03-31', null]]);
    expect(r.name).toBe('RENT CAP: Unit 9, housing payment ends 31 Mar (renewal)');
    // The renewal's claim waits for answers saved after the renewal began.
    expect(r.oldSave[0]).toEqual([]);
    // Saved two weeks before the renewal began: a short case would take it, a renewal does not.
    expect(r.oldSave[1]).toMatch(/^award until 31 Mar 2027; claim not raised yet: the details form was last saved 15 Feb, before this case$/);
    expect(r.newSave).toEqual([['claim', 'renew:2027-03-31', 1]]);
    // The award came from a short payer's claim (no tenant payee on its card): its renewal is paid to us too.
    expect(r.newSavePayee).toBe('landlord');
  });

  it('no answer yet asks again two weeks on; a note it cannot read asks the next day; six asks then it stops and says so', () => {
    const r = py(`
sent = ${SENT}
changes = decision(outcome="Changes requested")
a = plan(caps=[cap_task()], cards=[sent, changes], day=date(2026, 10, 25))
waited = decision(status="Cancelled", outcome="Changes requested", notes_extra="\\nRENT CLAIM NO ANSWER: 2026-10-25 no answer yet")
b13 = plan(caps=[cap_task()], cards=[sent, waited], day=date(2026, 11, 7))
b14 = plan(caps=[cap_task()], cards=[sent, waited], day=date(2026, 11, 8))
odd = decision(outcome="Approved as-is", feedback="Yes they paid", approved="2026-10-25T09:00:00.000Z")
c = plan(caps=[cap_task()], cards=[sent, odd], day=date(2026, 10, 25))
odd_done = decision(status="Completed", outcome="Approved as-is",
                    notes_extra="\\nRENT CLAIM NO ANSWER: 2026-10-25 your note had no answer the rent check could read (the note has no end date)")
d = plan(caps=[cap_task()], cards=[sent, odd_done], day=date(2026, 10, 26))
six = [decision(n=i, status="Cancelled", outcome="Changes requested", notes_extra="\\nRENT CLAIM NO ANSWER: 2026-10-%02d no answer yet" % (i + 10),
                created="2026-10-%02dT09:00:00.000Z" % (i + 10)) for i in range(1, 7)]
e = plan(caps=[cap_task()], cards=[sent] + six, day=date(2027, 1, 1))
rej = plan(caps=[cap_task()], cards=[sent, decision(outcome="Rejected")], day=date(2026, 10, 25))
print(json.dumps({"a": acts(a), "b13": kinds(b13), "b14": kinds(b14), "c": acts(c), "d": kinds(d), "again": d["raise"][0]["again"],
                  "e": [kinds(e), e["stage"], e["problems"]], "rej": acts(rej)}))`);
    expect(r.a).toEqual([['recDECISION000001', 'no-answer']]);
    expect(r.b13).toEqual([]);
    expect(r.b14).toEqual([['decision', '2026-09-23', 2]]);
    expect(r.c).toEqual([['recDECISION000001', 'no-answer']]);
    expect(r.d).toEqual([['decision', '2026-09-23', 2]]);
    expect(r.again).toBe('your note had no answer the rent check could read (the note has no end date)');
    expect(r.e[0]).toEqual([]);
    expect(r.e[1]).toBe('no council answer recorded after 6 asks: asking has stopped');
    expect(r.e[2]).toEqual(['no council answer recorded for the claim sent 2 Oct after 6 asks']);
    expect(r.rej).toEqual([['recDECISION000001', 'stop']]);
  });

  it('reads the answer only in its three exact forms, and never guesses at other words', () => {
    const r = py(`
on = date(2026, 10, 25)
cases = ["AWARD UNTIL: 31 Mar 2027", "award until 31 March 2027.", "Award until: 2027-03-31", "AWARD UNTIL: 31/03/2027",
         "REFUSED", "refused.", "ONE-OFF", "one off",
         "Awarded until 31 March 2027", "no award letter", "Award pending, decision expected by 20 Nov 2026", "Refused - not eligible",
         "AWARD UNTIL: 31/02/2027", "AWARD UNTIL: 2031-01-01", "AWARD UNTIL: 1 Oct 2026 to 31 Mar 2027", ""]
print(json.dumps([list(cap.award_from(c, on)) for c in cases], default=str))`);
    const other = [null, 'write exactly one of AWARD UNTIL: 31 Mar 2027, ONE-OFF or REFUSED'];
    expect(r).toEqual([
      ['award', '2027-03-31'], ['award', '2027-03-31'], ['award', '2027-03-31'], ['award', '2027-03-31'],
      ['refused', null], ['refused', null], ['one-off', null], ['one-off', null],
      // His own words are asked again, never read: a misread closes a live claim or invents an award.
      other, other, other, other,
      [null, 'the date 31/2/2027 is not a real day'], [null, '2031-01-01 is too far from today to be the award\'s end'],
      [null, 'the date after AWARD UNTIL could not be read; write it as 31 Mar 2027'], other,
    ]);
  });

  it('ONE-OFF closes the claim with nothing to renew, and a later short cycle can claim again', () => {
    const r = py(`
sent = claim(status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x")
d = decision(outcome="Approved as-is", feedback="One-off", approved="2026-10-25T09:00:00.000Z")
now = plan(caps=[cap_task()], cards=[sent, d], day=date(2026, 10, 25))
done = decision(status="Completed", outcome="Approved as-is", approved="2026-10-25T09:00:00.000Z",
                notes_extra="\\nRENT CLAIM AWARD: ONE-OFF (read from Kevin's note on 2026-10-25)")
cap_b = cap_task(case="2026-11-23", created="2026-11-26T09:00:00.000Z", i="recCAPTASK0000002")
later = plan(caps=[cap_task()], cards=[sent, done], day=date(2026, 11, 26), row=dict(SHORT, cycle="2026-11-23"))
claim_b = plan(caps=[cap_task(), cap_b], cards=[sent, done], day=date(2026, 11, 27), row={"id": TEN, "lane": "fine"},
               tenant=dict(GOOD, **{TN["saved"]: "2026-11-01T08:00:00.000Z"}))
print(json.dumps({"now": [acts(now), kinds(now), now["stage"]], "later": kinds(later), "claimB": kinds(claim_b)}))`);
    expect(r.now).toEqual([[['recDECISION000001', 'one-off']], [], 'a one-off award was paid']);
    expect(r.later).toEqual([['cap', '2026-11-23', null]]);
    expect(r.claimB).toEqual([['claim', '2026-11-23', 1]]);
  });
});

describe('the run: what it writes, and the cards Kevin sees', () => {
  const RUN = `
class RC:
    T_TASKS, T_TENANTS, T_TENANCIES = "tblqB8b22hKBL4PF1", "tblX4elTuu01gwBYh", "tblN51a88qTDB6iMH"
    TK, TY, AGENT_TEAM_MEMBER = rc.TK, rc.TY, rc.AGENT_TEAM_MEMBER
    first, lane_b_rules, tenant_type = staticmethod(rc.first), rc.lane_b_rules, staticmethod(rc.tenant_type)
    CHOICES = ["Unknown", "None (capped)", "LCWRA", "PIP or DLA", "Carer", "Earnings over threshold", "Not on UC"]
    def field_choices(self, table, field):
        return list(self.CHOICES)
    def __init__(self, caps=(), cards=(), tenants=None, late=(), capped=()):
        self.fake = Fake(caps, cards, tenants or {TENANT: dict(GOOD)}, late, capped)
        self.raised, self.posts, self.patches, self.reads = [], [], [], []
        self.store = {r["id"]: dict(r["fields"]) for r in list(caps) + list(cards)}
    def fetch_all(self, table, params):
        self.reads.append(table); return self.fake.fetch_all(table, params)
    def raise_task(self, item, day):
        self.raised.append(item); return "recRAISED00000001"
    def api(self, method, table, payload=None, params=None):
        if method == "POST":
            i = "recNEWCARD%07d" % len(self.posts)
            self.posts.append(payload["records"][0]["fields"]); self.store[i] = dict(payload["records"][0]["fields"])
            return {"records": [{"id": i}]}
        if method == "PATCH":
            rec = payload["records"][0]; self.patches.append(rec); self.store.setdefault(rec["id"], {}).update(rec["fields"]); return {}
        wanted = re.search(r"RECORD_ID\\(\\)='(rec\\w+)'", params["filterByFormula"]).group(1)
        return {"records": [{"id": wanted, "fields": self.store[wanted]}] if wanted in self.store else []}
TYS = [{"id": TEN, "fields": {rc.TY["tenants"]: [TENANT], rc.TY["unitRef"]: ["Unit 9 – 4 Example Road"]}}]
def res(row=SHORT): return {"tenancies": [row] if row.get("lane") != "fine" else [], "lanes": {TEN: row["lane"]}}
DATA = {"tenancies": TYS, "noChase": []}
import rent_new_tenant as lb
SUBMITS, MODES, FAIL = [], [], []
_REAL_AD = load_mod("real_ad", "agent-dispatch.py")
class FakeAd:
    HANDBACK_KEVIN_RE, HANDBACK_YOU_RE = _REAL_AD.HANDBACK_KEVIN_RE, _REAL_AD.HANDBACK_YOU_RE
    def cmd_submit(self, args):
        MODES.append(oct(os.stat(args.output_file).st_mode)[-3:]); SUBMITS.append({"task": args.task, "agent": args.agent, "type": args.type,
                     "text": open(args.output_file).read(), "plainTask": args.plain_task, "plainApprove": args.plain_approve, "file": args.output_file})
        if FAIL: raise SystemExit("ERROR: refusing to submit: " + FAIL[0])
        print(json.dumps({"submitted": args.task}))
lb.module = lambda key: FakeAd()
lb.read_form_records = lambda r, tid: {"tenancy": {"id": tid, "rent": 897.52, "frequency": "Monthly"},
    "tenant": {"id": TENANT, "name": "Alex First", "dob": "1980-03-07"},
    "property": {"id": "recPROPCAP0000001", "address": "4 Example Road, Haverhill", "postcode": "CB9 0ZZ", "area": "Haverhill"}}
lb.read_landlord = lambda: {"full_name": "Lee Landlord", "address": {"line1": "2 Office Street", "town_city": "Officetown", "postcode": "OF1 1CE"}}
`;

  it('a real run raises the cap task through the rent check\'s own create, and writes nothing on a dry run or with the agent off', () => {
    const r = py(RUN + `
live = RC(); out = cap.run(live, DATA, date(2026, 10, 1), res(), True, True)
dry = RC(); dout = cap.run(dry, DATA, date(2026, 10, 1), res(), False, True)
off = RC(); oout = cap.run(off, DATA, date(2026, 10, 1), res(), True, False)
unread = RC(); uout = cap.run(unread, DATA, date(2026, 10, 1), res(), True, None)
print(json.dumps({"raised": [x["key"] for x in live.raised], "caps": out["caps"], "line": cap.line(out),
                  "dry": [len(dry.raised), len(dry.posts), len(dry.patches), dout["caps"]],
                  "off": [off.reads, oout["caps"], cap.line(oout)], "unread": [unread.reads, len(unread.raised)]}))`);
    expect(r.raised).toEqual(['cap:recTENANCYCAP0001:2026-09-23']);
    expect(r.caps).toEqual(['RENT CAP: Unit 9 – 4 Example Road, rent due 23 Sep paid short']);
    expect(r.line).toBe('Benefit-cap claims: benefit-cap tasks for the agent (trial, nothing is sent): RENT CAP: Unit 9 – 4 Example Road, rent due 23 Sep paid short. '
      + 'where each stands: Unit 9 – 4 Example Road: benefit-cap task raised for the agent.');
    expect(r.dry).toEqual([0, 0, 0, ['RENT CAP: Unit 9 – 4 Example Road, rent due 23 Sep paid short']]);
    expect(r.off[0]).toEqual([]);
    expect(r.off[2]).toMatch(/switched off or unread/);
    expect(r.unread).toEqual([[], 0]);
  });

  it('raises the claim card under the agent, submits it privately with plain lines, and its words pass every submit gate', () => {
    const r = py(RUN + `
live = RC(caps=[cap_task()])
out = cap.run(live, DATA, date(2026, 10, 1), res({"id": TEN, "lane": "fine"}), True, True)
s = SUBMITS[0]
ad = load_mod("ad", "agent-dispatch.py")
text = s["text"]
gates = {"carry": ad.carry_out_problem(text), "send": ad.send_promise_problem(text, "Admin"), "handoff": ad.work_handoff_problem(text, None),
         "handback": ad.handback_problem(text, "Admin"), "doc": ad.document_action_problem(text, "Admin", "", set()),
         "plain": ad.plain_summary_problem(s["plainTask"], s["plainApprove"]), "acting": bool(aef.TRIAL_ACTING_SHAPE_RE.search(text)),
         "kevinOnly": ad.kevin_only_step(text)}
post = live.posts[0]
print(json.dumps({"claims": out["claims"], "name": post[rc.TK["name"]], "owner": post[rc.TK["teamMember"]], "notes": post[rc.TK["notes"]],
                  "desc": post[rc.TK["description"]][-160:], "submit": [s["agent"], s["type"]], "mode": MODES, "left": os.path.exists(s["file"]),
                  "gates": gates, "text": text, "line": cap.line(out), "failed": out["failed"]}))`);
    expect(r.failed).toBe('');
    expect(r.claims).toEqual(['Unit 9 – 4 Example Road (claim 1)']);
    expect(r.name).toBe('RENT CLAIM: Unit 9 – 4 Example Road, council housing payment');
    expect(r.owner).toEqual(['rec7aHLK1Q8fMLRXH']);
    // The claimant rides on the card, so the question about the council's answer names the right tenant.
    expect(r.notes).toBe('RENT CLAIM KEY: claim:recTENANCYCAP0001:2026-09-23:1\nRENT CLAIM FOR: recTENANTCAP00001\nRENT CLAIM PAYEE: landlord');
    expect(r.desc).toContain('RENT CLAIM KEY: claim:recTENANCYCAP0001:2026-09-23:1');
    // The claimant and the payee ride in the Description too: Notes are trimmed from the front once very long.
    expect(r.desc).toContain('RENT CLAIM FOR: recTENANTCAP00001\nRENT CLAIM PAYEE: landlord');
    expect(r.submit).toEqual(['rec7aHLK1Q8fMLRXH', 'Admin']);
    // The card's words name the tenant: its file is the owner's alone, and gone once submitted.
    expect([r.mode, r.left]).toEqual([['600'], false]);
    expect(r.gates).toEqual({ carry: '', send: '', handoff: '', handback: '', doc: '', plain: '', acting: false, kevinOnly: null });
    expect(r.text).toContain('WHERE: West Suffolk Council, through Anglia Revenues Partnership. Form: https://www.angliarevenues.gov.uk/westsuffolk/');
    expect(r.text).toContain('WHO GETS THE MONEY: ask for it to be paid to the landlord, Lee Landlord, 2 Office Street, Officetown, OF1 1CE.');
    expect(r.text).toContain('- National Insurance number: QQ123456C (their details form)');
    expect(r.text).toContain('- Weekly income: £210.50 (their details form)');
    expect(r.text).toContain('- Rent: £897.52 (monthly) (tenancy record)');
    expect(r.text.trim().split('\n').pop()).toBe("**Carrying this out will involve:** the rent check noting the claim as gone in today and asking you for the council's answer in three weeks.");
    // The row never carries a tenant's answers.
    expect(r.line).not.toMatch(/QQ123456C|1980|210\.50|sam@example/);
  });

  it('writes Kevin\'s verdict once, with the card\'s status, and refuses a card that reads back blank', () => {
    const r = py(RUN + `
sent_card = claim(outcome="Approved as-is", approved="2026-10-02T09:00:00.000Z")
live = RC(caps=[cap_task()], cards=[sent_card])
cap.run(live, DATA, date(2026, 10, 2), res({"id": TEN, "lane": "fine"}), True, True)
p = live.patches[0]["fields"]
again = RC(caps=[cap_task()], cards=[claim(status="Completed", outcome="Approved as-is", approved="2026-10-02T09:00:00.000Z",
                                          notes_extra="\\n\\nRENT CLAIM SENT: 2026-10-02 Kevin approved the card: the claim went in.")])
cap.run(again, DATA, date(2026, 10, 3), res({"id": TEN, "lane": "fine"}), True, True)
blank = RC(caps=[cap_task()], cards=[sent_card]); blank.store[sent_card["id"]][F["notes"]] = ""
bout = cap.run(blank, DATA, date(2026, 10, 2), res({"id": TEN, "lane": "fine"}), True, True)
d = decision(outcome="Approved as-is", feedback="AWARD UNTIL: 31 Mar 2027", approved="2026-10-25T09:00:00.000Z")
dec = RC(caps=[cap_task()], cards=[claim(status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x"), d])
cap.run(dec, DATA, date(2026, 10, 25), res({"id": TEN, "lane": "fine"}), True, True)
print(json.dumps({"status": p[F["status"]], "done": F["completion"] in p, "line": p[F["notes"]].splitlines()[-1],
                  "again": len(again.patches), "blank": [len(blank.patches), bout["failed"]],
                  "award": dec.patches[0]["fields"][F["notes"]].splitlines()[-1], "awardStatus": dec.patches[0]["fields"][F["status"]]}))`);
    expect([r.status, r.done]).toEqual(['Completed', true]);
    expect(r.line).toBe('RENT CLAIM SENT: 2026-10-02 Kevin approved the card: the claim went in.');
    expect(r.again).toBe(0);
    expect(r.blank[0]).toBe(0);
    expect(r.blank[1]).toMatch(/read back with blank Notes or no claim key; nothing written/);
    expect(r.award).toBe('RENT CLAIM AWARD: 2027-03-31 (read from Kevin\'s note on 2026-10-25)');
    expect(r.awardStatus).toBe('Completed');
  });

  it('a refused submit withdraws the card so the next run raises it again, and says so on the row', () => {
    const r = py(RUN + `
FAIL.append("its closing line hands the job to Kevin")
live = RC(caps=[cap_task()])
out = cap.run(live, DATA, date(2026, 10, 1), res({"id": TEN, "lane": "fine"}), True, True)
w = live.patches[-1]["fields"]
view_now = cap.read(Fake([cap_task()], [{"id": "recNEWCARD0000000", "createdTime": "2026-10-01T09:00:00.000Z", "fields": live.store["recNEWCARD0000000"]}]))[0][TEN]
nxt = cap.plan(TEN, view_now, {"id": TEN, "lane": "fine"}, TENANCY, {TENANT: GOOD}, date(2026, 10, 2))
print(json.dumps({"failed": out["failed"], "status": w[F["status"]], "why": w[F["notes"]].splitlines()[-1][:80], "next": kinds(nxt)}))`);
    expect(r.failed).toMatch(/could not be submitted \(recNEWCARD0000000 withdrawn, the next run raises it again\)/);
    expect(r.status).toBe('Cancelled');
    expect(r.why).toBe("RENT CLAIM WITHDRAWN: 2026-10-01 it could not be submitted to Kevin's queue: ERR");
    expect(r.next).toEqual([['claim', '2026-09-23', 2]]);
  });

  it('the decision card asks plainly, passes every gate, and names the council', () => {
    const r = py(RUN + `
live = RC(caps=[cap_task()], cards=[claim(status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x")])
out = cap.run(live, DATA, date(2026, 10, 23), res({"id": TEN, "lane": "fine"}), True, True)
s = SUBMITS[0]
ad = load_mod("ad", "agent-dispatch.py")
text = s["text"]
print(json.dumps({"decisions": out["decisions"], "name": live.posts[0][rc.TK["name"]], "first": text.splitlines()[0],
                  "gates": [ad.carry_out_problem(text), ad.send_promise_problem(text, "Admin"), ad.work_handoff_problem(text, None),
                            ad.handback_problem(text, "Admin"), ad.plain_summary_problem(s["plainTask"], s["plainApprove"])]}))`);
    expect(r.decisions).toEqual(['Unit 9 – 4 Example Road (decision 1)']);
    expect(r.name).toBe('RENT CLAIM DECISION: Unit 9 – 4 Example Road, has the council answered?');
    expect(r.first).toBe('THE ASK: has West Suffolk Council, through Anglia Revenues Partnership answered the housing payment claim for Sam Example at Unit 9 – 4 Example Road, which went in on 2 Oct 2026?');
    expect(r.gates).toEqual(['', '', '', '', '']);
  });

  it('review, 5 Oct 2026: a renewal claim while the rent reads short raises cleanly, with no shortfall figures from today', () => {
    const r = py(RUN + `
sent = claim(status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x")
d2 = decision(status="Completed", outcome="Approved as-is", notes_extra="\\nRENT CLAIM AWARD: 2027-03-31 (read)")
rcap = cap_task(case="renew:2027-03-31", created="2027-03-01T09:00:00.000Z", i="recCAPTASK0000003")
live = RC(caps=[cap_task(), rcap], cards=[sent, d2], tenants={TENANT: dict(GOOD, **{TN["saved"]: "2027-03-02T08:00:00.000Z"})})
out = cap.run(live, DATA, date(2027, 3, 3), res(dict(SHORT, cycle="2027-02-23", got=500.0)), True, True)
text = SUBMITS[0]["text"] if SUBMITS else ""
print(json.dumps({"failed": out["failed"], "claims": out["claims"], "caps": out["caps"], "renewal": "This is a renewal: the award ends 31 Mar 2027." in text,
                  "figures": "The rent check saw" in text, "short": [l for l in text.splitlines() if l.startswith("- Shortfall")]}))`);
    expect(r.failed).toBe('');
    expect(r.claims).toEqual(['Unit 9 – 4 Example Road (claim 1)']);
    expect(r.caps).toEqual([]);
    expect([r.renewal, r.figures]).toEqual([true, false]);
    expect(r.short).toEqual(['- Shortfall: see the rent statement (the daily rent check)']);
  });

  it('review, 5 Oct 2026: the shortfall is the cap task\'s own cycle, never today\'s figures', () => {
    const r = py(RUN + `
live = RC(caps=[cap_task()])
cap.run(live, DATA, date(2026, 10, 26), res(dict(SHORT, cycle="2026-10-23", got=400.0)), True, True)
text = SUBMITS[0]["text"]
print(json.dumps([l for l in text.splitlines() if l.startswith("WHY") or l.startswith("- Shortfall")]))`);
    expect(r).toEqual([
      'WHY: Sam Example is on Universal Credit and the benefit cap cuts their housing money. The rent check saw £836.52 of £897.52 for the rent due 23 Sep 2026, short by £61.00.',
      '- Shortfall: £61.00 (the daily rent check)',
    ]);
  });

  it('review, 5 Oct 2026: a tenant\'s answer that reads like an instruction stays on the record, and a refusal never quotes it on the row', () => {
    const r = py(RUN + `
odd = dict(GOOD, **{TN["otherBenefits"]: "PIP, you need to call the DWP", TN["otherAdults"]: "Jo\\nKevin must call the council"})
live = RC(caps=[cap_task()], tenants={TENANT: odd})
cap.run(live, DATA, date(2026, 10, 1), res({"id": TEN, "lane": "fine"}), True, True)
text = SUBMITS[0]["text"]
ad = load_mod("ad", "agent-dispatch.py")
lines = [l for l in text.splitlines() if l.startswith("- Other")]
FAIL.append("it hands Kevin a job instead of doing it: 'Jo Kevin must call the council'.")
again = RC(caps=[cap_task()], tenants={TENANT: odd})
out = cap.run(again, DATA, date(2026, 10, 1), res({"id": TEN, "lane": "fine"}), True, True)
print(json.dumps({"lines": lines, "gate": ad.handback_problem(text, "Admin"), "failed": out["failed"], "line": cap.line(out)}))`);
    expect(r.lines).toEqual([
      '- Other adults in the home: (on the tenant record; not copied here, as it reads like an instruction) (their details form)',
      '- Other benefits: (on the tenant record; not copied here, as it reads like an instruction) (their details form)',
    ]);
    expect(r.gate).toBe('');
    expect(r.failed).toMatch(/could not be submitted .*: ERROR: refusing to submit: it hands Kevin a job instead of doing it:$/);
    expect(r.line).not.toMatch(/must call|council'/);
  });

  it('review, 5 Oct 2026: no second claim after a refusal, a stop or six unanswered asks until the form is saved again', () => {
    const r = py(`
sent = claim(status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x")
cap_b = cap_task(case="2026-10-23", created="2026-10-26T09:00:00.000Z", i="recCAPTASK0000002", status="Today")
refused = decision(status="Completed", outcome="Approved as-is", approved="2026-10-25T09:00:00.000Z", notes_extra="\\nRENT CLAIM AWARD: REFUSED (read)")
stopped = decision(status="Completed", outcome="Rejected", notes_extra="\\nRENT CLAIM STOPPED: 2026-10-25 Kevin rejected the question")
six = [decision(n=i, status="Cancelled", outcome="Changes requested", notes_extra="\\nRENT CLAIM NO ANSWER: 2026-10-%02d no answer yet" % (i + 10),
                created="2026-10-%02dT09:00:00.000Z" % (i + 10)) for i in range(1, 7)]
out = {}
for name, cards in (("refused", [sent, refused]), ("stopped", [sent, stopped]), ("asked", [sent] + six)):
    stale = plan(caps=[cap_task(), cap_b], cards=cards, row={"id": TEN, "lane": "fine"}, day=date(2026, 10, 27))
    fresh = plan(caps=[cap_task(), cap_b], cards=cards, row={"id": TEN, "lane": "fine"}, day=date(2026, 10, 27),
                 tenant=dict(GOOD, **{TN["saved"]: "2026-10-26T08:00:00.000Z"}))
    out[name] = [kinds(stale), stale["stage"].split("claim not raised yet: ")[-1], kinds(fresh)]
print(json.dumps(out))`);
    expect(r.refused).toEqual([[], 'the council refused the last claim and the form has not been saved since', [['claim', '2026-10-23', 1]]]);
    expect(r.stopped).toEqual([[], "the questions about the council's answer were stopped and the form has not been saved since", [['claim', '2026-10-23', 1]]]);
    expect(r.asked).toEqual([[], 'no council answer was recorded and the form has not been saved since', [['claim', '2026-10-23', 1]]]);
  });

  it('review, 5 Oct 2026: no renewal for a tenancy that has ended or a tenant on the do-not-chase list', () => {
    const r = py(`
sent = claim(status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x")
d2 = decision(status="Completed", outcome="Approved as-is", notes_extra="\\nRENT CLAIM AWARD: 2027-03-31 (read)")
day = date(2027, 3, 1)
print(json.dumps([kinds(plan(caps=[cap_task()], cards=[sent, d2], day=day, row=None)),
                  kinds(plan(caps=[cap_task()], cards=[sent, d2], day=day, row={"id": TEN, "lane": "fine"}, no_chase=True)),
                  kinds(plan(caps=[cap_task()], cards=[sent, d2], day=day, row={"id": TEN, "lane": "fine"}))]))`);
    expect(r).toEqual([[], [], [['cap', 'renew:2027-03-31', null]]]);
  });

  it('review, 5 Oct 2026: a claim withdrawn near the end of its case is still raised again', () => {
    const r = py(`
old = cap_task(created="2026-07-01T09:00:00.000Z")
gone = claim(status="Cancelled", outcome="Changes requested", created="2026-09-22T09:00:00.000Z",
             notes_extra='\\nRENT CLAIM WITHDRAWN: 2026-09-25 Kevin asked for changes: "Wrong NI"')
p = plan(caps=[old], cards=[gone], row={"id": TEN, "lane": "fine"}, day=date(2026, 10, 2))
print(json.dumps(kinds(p)))`);
    expect(r).toEqual([['claim', '2026-09-23', 2]]);
  });

  it('a renewal claim never prints a shortfall date, even if it were handed one', () => {
    const r = py(`
item = {"case": "renew:2027-03-31", "claimant": {"fields": dict(GOOD), "saved": date(2027, 3, 2)}, "short": (500.0, 897.52)}
rec = {"tenancy": {"rent": 897.52, "frequency": "Monthly"}, "property": {"address": "4 Example Road", "postcode": "CB9 0ZZ"}}
text = cap.claim_text(item, rec, {"full_name": "Lee Landlord", "address": "2 Office Street"}, "Unit 9")
print(json.dumps([l for l in text.splitlines() if l.startswith("WHY") or l.startswith("- Shortfall") or l.startswith("This is")]))`);
    expect(r).toEqual(['This is a renewal: the award ends 31 Mar 2027.',
      'WHY: Sam Example is on Universal Credit and the benefit cap cuts their housing money.',
      '- Shortfall: see the rent statement (the daily rent check)']);
  });

  it('second review, 5 Oct 2026: a withdrawal keeps its case current, an award ending before the claim is asked again, the right tenant is named', () => {
    const r = py(`
old_cap = cap_task(created="2026-06-01T09:00:00.000Z")
parked_long = claim(status="Cancelled", outcome="Changes requested", created="2026-06-20T09:00:00.000Z",
                    notes_extra='\\nRENT CLAIM WITHDRAWN: 2026-09-28 Kevin asked for changes: "Wrong NI"')
w = plan(caps=[old_cap], cards=[parked_long], row={"id": TEN, "lane": "fine"}, day=date(2026, 10, 6))
sent = claim(status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x\\nRENT CLAIM FOR: recTENANTCAP00001")
slip = decision(outcome="Approved as-is", feedback="AWARD UNTIL: 31 Mar 2026", approved="2026-10-25T09:00:00.000Z")
a = plan(caps=[cap_task()], cards=[sent, slip], day=date(2026, 10, 25))
two = {"fld1i5bDoHL3B6rUf": [TENANT, "recTENANTCAP00002"]}
tenants = {TENANT: dict(GOOD), "recTENANTCAP00002": dict(GOOD, **{TN["name"]: "Alex Later", TN["saved"]: "2026-10-20T08:00:00.000Z"})}
d = cap.plan(TEN, view([cap_task()], [sent]), {"id": TEN, "lane": "fine"}, two, tenants, date(2026, 10, 23))
print(json.dumps({"withdrawn": kinds(w), "slip": [acts(a), a["acts"][0]["detail"], a["stage"]], "who": d["raise"][0]["who"]}, default=str))`);
    expect(r.withdrawn).toEqual([['claim', '2026-09-23', 2]]);
    expect(r.slip[0]).toEqual([['recDECISION000001', 'no-answer']]);
    expect(r.slip[1]).toBe('your note had no answer the rent check could read (the end date 2026-03-31 is before the claim went in; a payment made once is ONE-OFF)');
    expect(r.slip[2]).not.toMatch(/award until/);
    expect(r.who).toBe('Sam Example');
  });

  it('second review, 5 Oct 2026: one voice at a time: no benefit-cap task while a late-rent chase or a payment plan is open', () => {
    const r = py(RUN + `
late = [{"id": "recLATETASK000001", "fields": {F["tenancies"]: [TEN]}}]
busy = RC(late=late); bout = cap.run(busy, DATA, date(2026, 10, 1), res(), True, True)
planned = RC(); pout = cap.run(planned, DATA, date(2026, 10, 1), res(), True, True, on_plan={TEN})
free = RC(); fout = cap.run(free, DATA, date(2026, 10, 1), res(), True, True)
print(json.dumps({"busy": [len(busy.raised), bout["stages"]], "plan": len(planned.raised), "free": len(free.raised)}))`);
    expect(r.busy).toEqual([0, ['Unit 9 – 4 Example Road: a late-rent chase or payment plan is open, so no benefit-cap task yet']]);
    expect([r.plan, r.free]).toEqual([0, 1]);
  });

  it('third review, 5 Oct 2026: £0 is an answer, not a blank; a renewal waits while a late-rent chase is open', () => {
    const r = py(`
zero = plan(caps=[cap_task()], row={"id": TEN, "lane": "fine"}, tenant=dict(GOOD, **{TN["weeklyIncome"]: 0}))
sent = claim(status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x")
d2 = decision(status="Completed", outcome="Approved as-is", notes_extra="\\nRENT CLAIM AWARD: 2027-03-31 (read)")
busy = cap.plan(TEN, view([cap_task()], [sent, d2]), {"id": TEN, "lane": "fine"}, TENANCY, {TENANT: GOOD}, date(2027, 3, 1), busy=True)
print(json.dumps({"zero": kinds(zero), "busy": kinds(busy)}))`);
    expect(r.zero).toEqual([['claim', '2026-09-23', 1]]);
    expect(r.busy).toEqual([]);
  });

  it('fourth review, 5 Oct 2026: a renewal held back while a chase or plan is open still comes once it clears', () => {
    const r = py(`
sent = claim(status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x")
d2 = decision(status="Completed", outcome="Approved as-is", notes_extra="\\nRENT CLAIM AWARD: 2027-03-31 (read)")
v = lambda caps: view(caps, [sent, d2])
fine = {"id": TEN, "lane": "fine"}
held = cap.plan(TEN, v([cap_task()]), fine, TENANCY, {TENANT: GOOD}, date(2027, 3, 31), busy=True)
after = cap.plan(TEN, v([cap_task()]), fine, TENANCY, {TENANT: GOOD}, date(2027, 4, 15))
newer = cap_task(case="2027-04-23", created="2027-04-26T09:00:00.000Z", i="recCAPTASK0000004")
superseded = cap.plan(TEN, v([cap_task(), newer]), fine, TENANCY, {TENANT: GOOD}, date(2027, 4, 27))
lapsed = cap.plan(TEN, v([cap_task()]), fine, TENANCY, {TENANT: GOOD}, date(2027, 7, 1))
print(json.dumps({"held": [kinds(held), held["stage"]], "after": [kinds(after), after["stage"]], "superseded": kinds(superseded),
                  "lapsed": [kinds(lapsed), lapsed["stage"]]}))`);
    expect(r.held).toEqual([[], 'renewal waits: a late-rent chase or payment plan is open']);
    expect(r.after).toEqual([[['cap', 'renew:2027-03-31', null]], 'renewal task raised for the agent']);
    expect(r.superseded).toEqual([]);
    expect(r.lapsed).toEqual([[], 'the award ended 31 Mar 2027']);
  });

  it('fifth review, 5 Oct 2026: one ask at a time, and a short award still gets its renewal', () => {
    const r = py(`
sent = claim(status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x")
d2 = decision(status="Completed", outcome="Approved as-is", notes_extra="\\nRENT CLAIM AWARD: 2027-03-31 (read)")
v = lambda caps: view(caps, [sent, d2])
short_apr = dict(SHORT, cycle="2027-04-23")
both = cap.plan(TEN, v([cap_task()]), short_apr, TENANCY, {TENANT: GOOD}, date(2027, 4, 27))
renewed = cap_task(case="renew:2027-03-31", created="2027-04-20T09:00:00.000Z", i="recCAPTASK0000005")
soon = cap.plan(TEN, v([cap_task(), renewed]), short_apr, TENANCY, {TENANT: dict(GOOD, **{TN["authority"]: False})}, date(2027, 4, 26))
later = cap.plan(TEN, v([cap_task(), renewed]), short_apr, TENANCY, {TENANT: dict(GOOD, **{TN["authority"]: False})}, date(2027, 5, 21))
open_cap = cap.plan(TEN, v([cap_task(status="Today")]), {"id": TEN, "lane": "fine"}, TENANCY, {TENANT: GOOD}, date(2027, 3, 5))
quick = decision(status="Completed", outcome="Approved as-is", approved="2026-10-15T09:00:00.000Z",
                 notes_extra="\\nRENT CLAIM AWARD: 2026-10-20 (read)")
short_award = cap.plan(TEN, view([cap_task()], [sent, quick]), {"id": TEN, "lane": "fine"}, TENANCY, {TENANT: GOOD}, date(2026, 10, 16))
print(json.dumps({"both": kinds(both), "soon": [k for k in kinds(soon) if k[0] == "cap"], "later": [k for k in kinds(later) if k[0] == "cap"],
                  "openCap": [kinds(open_cap), open_cap["stage"]], "shortAward": kinds(short_award)}))`);
    // The award ended and the rent reads short: the renewal goes, the short-cycle task waits.
    expect(r.both).toEqual([['cap', 'renew:2027-03-31', null]]);
    // A renewal raised in the last month holds the short-cycle task back; a month on, it can go.
    expect(r.soon).toEqual([]);
    expect(r.later).toEqual([['cap', '2027-04-23', null]]);
    expect(r.openCap).toEqual([[], 'renewal waits: a benefit-cap task is still with the agent']);
    // An award ending within a month of its own case's task still gets its renewal.
    expect(r.shortAward).toEqual([['cap', 'renew:2026-10-20', null]]);
  });

  it('fourth review, 5 Oct 2026: notes the rent check could not read are asked again but never use up the six asks', () => {
    const r = py(`
sent = claim(status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x")
bad = [decision(n=i, status="Completed", outcome="Approved as-is",
                notes_extra="\\nRENT CLAIM NO ANSWER: 2026-10-%02d your note had no answer the rent check could read (x)" % (i + 20),
                created="2026-10-%02dT09:00:00.000Z" % (i + 20)) for i in range(1, 8)]
p = plan(caps=[cap_task()], cards=[sent] + bad, day=date(2026, 10, 29))
print(json.dumps({"raise": kinds(p), "stage": p["stage"], "problems": p["problems"]}))`);
    expect(r.raise).toEqual([['decision', '2026-09-23', 8]]);
    expect(r.stage).toBe("asking Kevin for the council's answer");
    expect(r.problems).toEqual([]);
  });

  it('Kevin, 5 Oct 2026: a tenancy left with no unit on purpose gets no benefit-cap task or claim, but his verdicts are still read', () => {
    const r = py(RUN + `
rogue = [{"id": TEN, "fields": {rc.TY["tenants"]: [TENANT]}}]
live = RC(); out = cap.run(live, {"tenancies": rogue, "noChase": []}, date(2026, 10, 1), res(), True, True)
ready = RC(caps=[cap_task()]); rout = cap.run(ready, {"tenancies": rogue, "noChase": []}, date(2026, 10, 1), res({"id": TEN, "lane": "fine"}), True, True)
verdict = RC(caps=[cap_task()], cards=[claim(outcome="Approved as-is", approved="2026-10-02T09:00:00.000Z")])
vout = cap.run(verdict, {"tenancies": rogue, "noChase": []}, date(2026, 10, 2), res({"id": TEN, "lane": "fine"}), True, True)
linked = RC(); lout = cap.run(linked, DATA, date(2026, 10, 1), res(), True, True)
print(json.dumps({"raised": [len(live.raised), len(ready.posts)], "stages": out["stages"] + rout["stages"], "acted": vout["acted"],
                  "patched": len(verdict.patches), "linked": len(linked.raised)}))`);
    expect(r.raised).toEqual([0, 0]);
    expect(r.stages).toEqual([
      'a tenancy with no unit linked: left unlinked on purpose, so no new benefit-cap task or claim',
      'a tenancy with no unit linked: left unlinked on purpose, so no new benefit-cap task or claim',
    ]);
    expect(r.acted).toEqual(['RENT CLAIM: Unit 9, council housing payment: sent']);
    expect(r.patched).toBe(1);
    expect(r.linked).toBe(1);
  });

  it('review, 5 Oct 2026: an unlinked tenancy still gets the question about a claim already sent, and keeps its award on the row', () => {
    const r = py(`
sent = claim(status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x")
ask = cap.plan(TEN, view([cap_task()], [sent]), {"id": TEN, "lane": "fine"}, TENANCY, {TENANT: GOOD}, date(2026, 10, 23), unlinked=True)
waited = decision(status="Cancelled", outcome="Changes requested", notes_extra="\\nRENT CLAIM NO ANSWER: 2026-10-25 no answer yet")
again = cap.plan(TEN, view([cap_task()], [sent, waited]), {"id": TEN, "lane": "fine"}, TENANCY, {TENANT: GOOD}, date(2026, 11, 8), unlinked=True)
d2 = decision(status="Completed", outcome="Approved as-is", notes_extra="\\nRENT CLAIM AWARD: 2027-03-31 (read)")
renew = cap.plan(TEN, view([cap_task()], [sent, d2]), {"id": TEN, "lane": "fine"}, TENANCY, {TENANT: GOOD}, date(2027, 3, 1), unlinked=True)
print(json.dumps({"ask": [kinds(ask), ask["stage"]], "again": kinds(again), "renew": [kinds(renew), renew["stage"]]}))`);
    expect(r.ask).toEqual([[['decision', '2026-09-23', 1]], "asking Kevin for the council's answer; left unlinked on purpose, so no new benefit-cap task or claim"]);
    expect(r.again).toEqual([['decision', '2026-09-23', 2]]);
    expect(r.renew).toEqual([[], 'award until 31 Mar 2027; left unlinked on purpose, so no new benefit-cap task or claim']);
  });

  it('Kevin, 5 Oct 2026: a capped tenant who pays in full gets a claim from their own form, with the award paid to them', () => {
    const r = py(RUN + `
fine = {"id": TEN, "lane": "fine", "paidFull": True}
day = date(2026, 10, 6)
p = cap.plan(TEN, view(), fine, TENANCY, {TENANT: GOOD}, day, uc=True)
others = {
  "notUC": cap.plan(TEN, view(), fine, TENANCY, {TENANT: GOOD}, day),
  "notCapped": cap.plan(TEN, view(), fine, TENANCY, {TENANT: dict(GOOD, **{TN["cap"]: {"name": "PIP or DLA"}})}, day, uc=True),
  "stale": cap.plan(TEN, view(), fine, TENANCY, {TENANT: dict(GOOD, **{TN["saved"]: "2026-07-01T08:00:00.000Z"})}, day, uc=True),
  "unlinked": cap.plan(TEN, view(), fine, TENANCY, {TENANT: GOOD}, day, uc=True, unlinked=True),
  "noChase": cap.plan(TEN, view(), fine, TENANCY, {TENANT: GOOD}, day, uc=True, no_chase=True),
  "noAuthority": cap.plan(TEN, view(), fine, TENANCY, {TENANT: dict(GOOD, **{TN["authority"]: False})}, day, uc=True),
}
short_case = plan(caps=[cap_task()], row={"id": TEN, "lane": "fine"})
live = RC(capped=[TENANT])
data = {"tenancies": TYS, "noChase": [], "tenants": [{"id": TENANT, "fields": {rc.TN["payType"]: {"name": "Universal Credit"}}}]}
out = cap.run(live, data, day, {"tenancies": [], "lanes": {TEN: "fine"}, "paidFull": [TEN]}, True, True)
text = SUBMITS[0]["text"] if SUBMITS else ""
print(json.dumps({"raise": kinds(p), "payee": p["raise"][0]["payee"], "others": {k: kinds(v) for k, v in others.items()},
                  "authorityStage": others["noAuthority"]["stage"], "shortPayee": short_case["raise"][0]["payee"],
                  "claims": out["claims"], "failed": out["failed"], "key": live.posts[0][rc.TK["notes"]].splitlines()[0] if live.posts else "",
                  "payeeLine": live.posts[0][rc.TK["notes"]].splitlines()[-1] if live.posts else "",
                  "lines": [l for l in text.splitlines() if l.startswith(("WHY", "WHO GETS", "- Shortfall"))]}))`);
    expect(r.raise).toEqual([['claim', 'full:2026-09-28', 1]]);
    expect(r.payee).toBe('tenant');
    expect(r.others).toEqual({ notUC: [], notCapped: [], stale: [], unlinked: [], noChase: [], noAuthority: [] });
    expect(r.authorityStage).toBe('claim not raised yet: the letter of authority is not ticked as signed');
    // A short payer's claim still asks for the award to come to us.
    expect(r.shortPayee).toBe('landlord');
    // The daily run finds the capped tenant with no short payment, and the card pays the tenant.
    expect([r.claims, r.failed]).toEqual([['Unit 9 – 4 Example Road (claim 1)'], '']);
    expect(r.key).toBe('RENT CLAIM KEY: claim:recTENANCYCAP0001:full:2026-09-28:1');
    expect(r.payeeLine).toBe('RENT CLAIM PAYEE: tenant');
    expect(r.lines[0]).toBe('WHY: Sam Example is on Universal Credit and the benefit cap cuts their housing money. They pay the full rent, so the top-up is paid to them.');
    expect(r.lines[1]).toMatch(/^WHO GETS THE MONEY: ask for it to be paid to Sam Example, the tenant \(Kevin's ruling, 5 Oct 2026/);
    expect(r.lines[1]).toMatch(/bank details, which are not on our records: ask them for these, never guess/);
    expect(r.lines[2]).toBe('- Shortfall: none: the tenant pays the full rent (the daily rent check)');
  });

  it('Kevin, 5 Oct 2026: the full payer\'s award is renewed to the tenant too, and a sent claim is not raised again', () => {
    const r = py(`
FULL = "full:2026-09-28"
sent = claim(case=FULL, status="Completed", notes_extra="\\nRENT CLAIM PAYEE: tenant\\nRENT CLAIM SENT: 2026-10-02 x")
d2 = decision(case=FULL, status="Completed", outcome="Approved as-is", notes_extra="\\nRENT CLAIM AWARD: 2027-03-31 (read)")
fine = {"id": TEN, "lane": "fine", "paidFull": True}
waiting = cap.plan(TEN, view([], [sent]), fine, TENANCY, {TENANT: GOOD}, date(2026, 10, 10), uc=True)
renew = cap.plan(TEN, view([], [sent, d2]), fine, TENANCY, {TENANT: GOOD}, date(2027, 3, 1), uc=True)
rcap = cap_task(case="renew:2027-03-31", created="2027-03-01T09:00:00.000Z", i="recCAPTASK0000003")
again = cap.plan(TEN, view([rcap], [sent, d2]), fine, TENANCY, {TENANT: dict(GOOD, **{TN["saved"]: "2027-03-02T08:00:00.000Z"})},
                 date(2027, 3, 3), uc=True)
print(json.dumps({"waiting": [kinds(waiting), waiting["stage"]], "renew": kinds(renew), "again": kinds(again),
                  "payee": again["raise"][0]["payee"] if again["raise"] else None}))`);
    expect(r.waiting[0]).toEqual([]);
    expect(r.waiting[1]).toMatch(/^claim sent 2 Oct/);
    expect(r.renew).toEqual([['cap', 'renew:2027-03-31', null]]);
    expect(r.again).toEqual([['claim', 'renew:2027-03-31', 1]]);
    expect(r.payee).toBe('tenant');
  });

  it('review, 5 Oct 2026: only rent paid in full on trusted bank data, with nobody chasing, starts a full payer\'s claim', () => {
    const r = py(`
day = date(2026, 10, 6)
def k(row, **kw): return kinds(cap.plan(TEN, view(), row, TENANCY, {TENANT: GOOD}, day, uc=True, **kw))
print(json.dumps({"full": k({"id": TEN, "lane": "fine", "paidFull": True}),
                  "fineDoubtful": k({"id": TEN, "lane": "fine"}), "late": k({"id": TEN, "lane": "late"}), "new": k({"id": TEN, "lane": "new"}),
                  "unknown": k({"id": TEN, "lane": "unknown"}), "existing": k({"id": TEN, "lane": "existing"}),
                  "busy": k({"id": TEN, "lane": "fine", "paidFull": True}, busy=True),
                  "saved60": kinds(cap.plan(TEN, view(), {"id": TEN, "lane": "fine", "paidFull": True}, TENANCY,
                                            {TENANT: dict(GOOD, **{TN["saved"]: "2026-08-07T08:00:00.000Z"})}, day, uc=True)),
                  "saved61": kinds(cap.plan(TEN, view(), {"id": TEN, "lane": "fine", "paidFull": True}, TENANCY,
                                            {TENANT: dict(GOOD, **{TN["saved"]: "2026-08-06T08:00:00.000Z"})}, day, uc=True))}))`);
    expect(r.full).toEqual([['claim', 'full:2026-09-28', 1]]);
    for (const k of ['fineDoubtful', 'late', 'new', 'unknown', 'existing', 'busy']) expect(r[k], k).toEqual([]);
    expect(r.saved60).toEqual([['claim', 'full:2026-08-07', 1]]);
    expect(r.saved61).toEqual([]);
  });

  it('review, 5 Oct 2026: the payee holds through every renewal, turns to us when the rent is short, and no twin case starts', () => {
    const r = py(`
FULL = "full:2026-09-28"
full = {"id": TEN, "lane": "fine", "paidFull": True}
c1 = claim(case=FULL, status="Completed", notes_extra="\\nRENT CLAIM PAYEE: tenant\\nRENT CLAIM SENT: 2026-10-02 x")
d1 = decision(case=FULL, status="Completed", outcome="Approved as-is", notes_extra="\\nRENT CLAIM AWARD: 2027-03-31 (read)")
cap1 = cap_task(case="renew:2027-03-31", created="2027-03-01T09:00:00.000Z", i="recCAPTASK0000003")
c2 = claim(n=1, case="renew:2027-03-31", status="Completed", created="2027-03-05T09:00:00.000Z", i="recCLAIMRENEW0001",
           notes_extra="\\nRENT CLAIM PAYEE: tenant\\nRENT CLAIM SENT: 2027-03-06 x")
d2 = decision(n=1, case="renew:2027-03-31", status="Completed", outcome="Approved as-is", created="2027-03-28T09:00:00.000Z",
              notes_extra="\\nRENT CLAIM AWARD: 2027-09-30 (read)")
d2["id"] = "recDECISIONRENEW1"
cap2 = cap_task(case="renew:2027-09-30", created="2027-09-01T09:00:00.000Z", i="recCAPTASK0000004")
saved = {TENANT: dict(GOOD, **{TN["saved"]: "2027-09-02T08:00:00.000Z"})}
second = cap.plan(TEN, view([cap1, cap2], [c1, d1, c2, d2]), full, TENANCY, saved, date(2027, 9, 3), uc=True)
short_now = cap.plan(TEN, view([cap1, cap2], [c1, d1, c2, d2]), dict(SHORT, cycle="2027-08-23"), TENANCY, saved, date(2027, 9, 3), uc=True)
in_award = cap.plan(TEN, view([], [c1, d1]), full, TENANCY, {TENANT: dict(GOOD, **{TN["saved"]: "2027-03-10T08:00:00.000Z"})},
                    date(2027, 3, 12), uc=True, busy=True)
oneoff = decision(case=FULL, status="Completed", outcome="Approved as-is", approved="2026-10-07T09:00:00.000Z",
                  notes_extra="\\nRENT CLAIM AWARD: ONE-OFF (read)")
resaved = cap.plan(TEN, view([], [c1, oneoff]), full, TENANCY, {TENANT: dict(GOOD, **{TN["saved"]: "2026-10-08T08:00:00.000Z"})},
                   date(2026, 10, 9), uc=True)
print(json.dumps({"second": [kinds(second), second["raise"][0]["payee"] if second["raise"] else None],
                  "shortNow": [x["payee"] for x in short_now["raise"] if x["kind"] == "claim"],
                  "inAward": kinds(in_award), "oneOff": kinds(resaved)}))`);
    expect(r.second).toEqual([[['claim', 'renew:2027-09-30', 1]], 'tenant']);
    expect(r.shortNow).toEqual(['landlord']);
    expect(r.inAward).toEqual([]);
    expect(r.oneOff).toEqual([]);
  });

  it('second review, 5 Oct 2026: a tenant-paid renewal waits unless the rent is seen paid in full; a tenant-paid card is flagged when the rent turns short', () => {
    const r = py(`
FULL = "full:2026-09-28"
c1 = claim(case=FULL, status="Completed", notes_extra="\\nRENT CLAIM PAYEE: tenant\\nRENT CLAIM SENT: 2026-10-02 x")
d1 = decision(case=FULL, status="Completed", outcome="Approved as-is", notes_extra="\\nRENT CLAIM AWARD: 2027-03-31 (read)")
cap1 = cap_task(case="renew:2027-03-31", created="2027-03-01T09:00:00.000Z", i="recCAPTASK0000003")
saved = {TENANT: dict(GOOD, **{TN["saved"]: "2027-03-02T08:00:00.000Z"})}
def renew(row, **kw): return cap.plan(TEN, view([cap1], [c1, d1]), row, TENANCY, saved, date(2027, 3, 3), uc=True, **kw)
late, unknown, doubtful = renew({"id": TEN, "lane": "late"}), renew({"id": TEN, "lane": "unknown"}), renew({"id": TEN, "lane": "fine"})
waiting = claim(case=FULL, notes_extra="\\nRENT CLAIM PAYEE: tenant")
flag = cap.plan(TEN, view([], [waiting]), dict(SHORT, cycle="2026-10-23"), TENANCY, {TENANT: GOOD}, date(2026, 10, 26), uc=True)
sent_flag = cap.plan(TEN, view([], [c1]), dict(SHORT, cycle="2026-10-23"), TENANCY, {TENANT: GOOD}, date(2026, 10, 26), uc=True)
ours = cap.plan(TEN, view([], [claim(notes_extra="\\nRENT CLAIM PAYEE: landlord")]), dict(SHORT, cycle="2026-10-23"), TENANCY, {TENANT: GOOD},
                date(2026, 10, 26))
print(json.dumps({"late": [kinds(late), late["stage"]], "unknown": kinds(unknown), "doubtful": kinds(doubtful),
                  "flag": flag["problems"], "sentFlag": sent_flag["problems"], "ours": ours["problems"]}))`);
    expect(r.late[0]).toEqual([]);
    expect(r.late[1]).toMatch(/claim waits: the rent is not seen paid in full yet$/);
    expect([r.unknown, r.doubtful]).toEqual([[], []]);
    expect(r.flag).toEqual(['a claim asks for the award to go to the tenant, but the rent is now short: press Request changes on the card']);
    expect(r.sentFlag).toEqual(['a claim asks for the award to go to the tenant, but the rent is now short: tell the council']);
    expect(r.ours).toEqual([]);
  });

  it('polish, 5 Oct 2026: red-late warns too, a settled claim stops warning, a joint household is said, a change note survives a re-save', () => {
    const r = py(`
FULL = "full:2026-09-28"
sent = claim(case=FULL, status="Completed", notes_extra="\\nRENT CLAIM PAYEE: tenant\\nRENT CLAIM SENT: 2026-10-02 x")
late7 = dict(SHORT, lane="late", daysLate=7)
late3 = dict(SHORT, lane="late", daysLate=3)
red = cap.plan(TEN, view([], [sent]), late7, TENANCY, {TENANT: GOOD}, date(2026, 10, 26), uc=True)
amber = cap.plan(TEN, view([], [sent]), late3, TENANCY, {TENANT: GOOD}, date(2026, 10, 26), uc=True)
refused = decision(case=FULL, status="Completed", outcome="Approved as-is", approved="2026-10-25T09:00:00.000Z", notes_extra="\\nRENT CLAIM AWARD: REFUSED (read)")
after_no = cap.plan(TEN, view([], [sent, refused]), dict(SHORT, cycle="2026-10-23"), TENANCY, {TENANT: GOOD}, date(2026, 10, 26), uc=True)
awarded = decision(case=FULL, status="Completed", outcome="Approved as-is", approved="2026-10-25T09:00:00.000Z", notes_extra="\\nRENT CLAIM AWARD: 2027-03-31 (read)")
in_force = cap.plan(TEN, view([], [sent, awarded]), dict(SHORT, cycle="2026-10-23"), TENANCY, {TENANT: GOOD}, date(2026, 10, 26), uc=True)
TWO = {"fld1i5bDoHL3B6rUf": [TENANT, "recTENANTCAP00002"]}
couple = {TENANT: GOOD, "recTENANTCAP00002": dict(GOOD, **{TN["cap"]: {"name": "LCWRA"}, TN["saved"]: "2026-10-01T08:00:00.000Z"})}
joint = cap.plan(TEN, view(), {"id": TEN, "lane": "fine", "paidFull": True}, TWO, couple, date(2026, 10, 6), uc=True)
gone = claim(case="full:2026-09-01", status="Cancelled", outcome="Changes requested", created="2026-09-05T09:00:00.000Z",
             notes_extra='\\nRENT CLAIM WITHDRAWN: 2026-09-06 Kevin asked for changes: "Use her other bank"')
resave = cap.plan(TEN, view([], [gone]), {"id": TEN, "lane": "fine", "paidFull": True}, TENANCY, {TENANT: GOOD}, date(2026, 10, 6), uc=True)
trimmed = claim(case=FULL, status="Completed", notes_extra="\\nRENT CLAIM SENT: 2026-10-02 x")
trimmed["fields"][F["description"]] = "RENT CLAIM KEY: claim:x\\nRENT CLAIM PAYEE: tenant"
d1 = decision(case=FULL, status="Completed", outcome="Approved as-is", notes_extra="\\nRENT CLAIM AWARD: 2027-03-31 (read)")
cap1 = cap_task(case="renew:2027-03-31", created="2027-03-01T09:00:00.000Z", i="recCAPTASK0000003")
renew = cap.plan(TEN, view([cap1], [trimmed, d1]), {"id": TEN, "lane": "fine", "paidFull": True}, TENANCY,
                 {TENANT: dict(GOOD, **{TN["saved"]: "2027-03-02T08:00:00.000Z"})}, date(2027, 3, 3), uc=True)
print(json.dumps({"red": red["problems"], "amber": amber["problems"], "afterNo": after_no["problems"], "inForce": in_force["problems"],
                  "joint": [kinds(joint), joint["stage"]], "prior": resave["raise"][0]["prior"] if resave["raise"] else None,
                  "trimmedPayee": renew["raise"][0]["payee"] if renew["raise"] else None}))`);
    expect(r.red).toEqual(['a claim asks for the award to go to the tenant, but the rent is now late: tell the council']);
    expect(r.amber).toEqual([]);
    // A refused claim pays nobody: no more warnings. An award still in force does warn.
    expect(r.afterNo).toEqual([]);
    expect(r.inForce).toEqual(['a claim asks for the award to go to the tenant, but the rent is now short: tell the council']);
    expect(r.joint).toEqual([[], 'no claim: the latest details form answers the benefit cap as "LCWRA", not capped']);
    expect(r.prior).toBe('Use her other bank');
    expect(r.trimmedPayee).toBe('tenant');
  });

  it('polish, 5 Oct 2026: a renamed capped choice stops the run loudly instead of reading as nobody', () => {
    const r = py(RUN + `
live = RC(); live.CHOICES = ["Unknown", "Capped"]
out = cap.run(live, DATA, date(2026, 10, 1), res(), True, True)
print(json.dumps({"failed": out["failed"], "raised": len(live.raised)}))`);
    expect(r.failed).toMatch(/control failed: the Benefit Cap Exemption field has no "None \(capped\)" choice/);
    expect(r.raised).toBe(0);
  });

  it('a postcode with no form on file says so instead of guessing', () => {
    const r = py(`print(json.dumps([cap.council_for("CB9 0AJ")[0], cap.council_for("fy8 1aa")[0], cap.council_for("BB5 2ZZ")[0], cap.council_for("ML3 0AA"), cap.council_for("")]))`);
    expect(r).toEqual(['West Suffolk Council, through Anglia Revenues Partnership', 'Fylde Council', 'Hyndburn Borough Council', null, null]);
  });
});

describe('a signed letter of authority ticks the tenant who signed it', () => {
  const AD = `
ad = load_mod("ad", "agent-dispatch.py")
HAVE = {"recTENANTCAP00001": {"tick": False, "email": "Sam@Example.com"}, "recTENANTCAP00002": {"tick": False, "email": "alex@example.com"},
        "recTENANTCAP00003": {"tick": True, "email": "jo@example.com"}}
patches, reads = [], []
def records(table, formula=None, fields=None, max_records=None):
    reads.append(table)
    return [{"id": t, "fields": {ad.AUTHORITY_SIGNED: v["tick"], ad.TENANT_EMAIL: v["email"]}} for t, v in HAVE.items() if t in formula]
ad.query_records = records
ad._request = lambda method, path, body=None: patches.append([method, path, body])
CARD = "DOCUMENT: ~/knowledge-os/attachments/loa.pdf\\nSIGNERS: sam@example.com, jo@example.com\\nSUBJECT: Letter of authority\\n---\\nx"
def tf(tenants, out=CARD): return {ad.TASK_TENANTS: tenants, ad.AF["agentOutput"]: out}
`;
  it('ticks only a linked tenant whose email signed it, only for a letter of authority, and fails loudly on a missing read', () => {
    const r = py(AD + `
both = ["recTENANTCAP00001", "recTENANTCAP00002", "recTENANTCAP00003"]
out = {"joint": list(ad.tick_authority(tf(both), "Letter of authority - Unit 9")), "patch": patches[:]}
patches.clear(); reads.clear()
out["other"] = [list(ad.tick_authority(tf(both), n)) for n in ("Tenancy agreement - Unit 9", "Local Authority council tax form",
                                                                  "Renewal - letter of authority")] + [reads[:], patches[:]]
out["noTenants"] = list(ad.tick_authority(tf([]), "Letter of Authority"))
out["noSigners"] = list(ad.tick_authority(tf(both, "x"), "Letter of authority"))
out["notSigned"] = list(ad.tick_authority(tf(["recTENANTCAP00002"]), "Letter of authority"))
out["spelling"] = list(ad.tick_authority(tf(["recTENANTCAP00001"]), "LETTER OF AUTHORISATION for Sam"))
many = {"recTENANTMANY%04d" % i: {"tick": False, "email": "t%d@example.com" % i} for i in range(12)}
HAVE.update(many); patches.clear()
card = "SIGNERS: " + ", ".join(v["email"] for v in many.values()) + "\\n---\\nx"
out["many"] = [len(ad.tick_authority(tf(sorted(many), card), "Letter of authority")[0]), [len(p[2]["records"]) for p in patches]]
HAVE["recTENANTPAIR0001"] = {"tick": False, "email": "couple@example.com"}
HAVE["recTENANTPAIR0002"] = {"tick": False, "email": "Couple@Example.com"}
HAVE["recTENANTOFFICE01"] = {"tick": False, "email": "info@agilelets.co.uk"}
patches.clear()
out["shared"] = list(ad.tick_authority(tf(["recTENANTPAIR0001", "recTENANTPAIR0002"], "SIGNERS: couple@example.com\\n---\\nx"), "Letter of authority"))
out["office"] = list(ad.tick_authority(tf(["recTENANTOFFICE01", "recTENANTCAP00001"], "SIGNERS: info@agilelets.co.uk, sam@example.com\\n---\\nx"),
                                       "Letter of authority"))
HAVE.pop("recTENANTCAP00002")
try:
    ad.tick_authority(tf(both), "Letter of authority"); out["missing"] = "ticked"
except RuntimeError as e:
    out["missing"] = str(e)
print(json.dumps(out))`);
    // Sam signed (email in another case) and is ticked; Alex did not sign; Jo signed but is ticked already.
    expect(r.joint).toEqual([['recTENANTCAP00001'], '']);
    expect(r.patch).toEqual([['PATCH', '/tblX4elTuu01gwBYh', { records: [{ id: 'recTENANTCAP00001', fields: { fldHPe9YQ6GmlrKBt: true } }], typecast: false }]]);
    expect(r.other).toEqual([[[], ''], [[], ''], [[], ''], [], []]);
    expect(r.noTenants).toEqual([[], 'the task links no tenant']);
    expect(r.noSigners).toEqual([[], "the task's card names no SIGNERS"]);
    expect(r.notSigned).toEqual([[], 'no tenant the task links signed it (matched by email)']);
    expect(r.spelling).toEqual([['recTENANTCAP00001'], '']);
    expect(r.many).toEqual([12, [10, 2]]);
    // Two tenants on one email cannot say who signed; our own address on a record is never a signature.
    expect(r.shared).toEqual([[], "the signer's email is shared by more than one linked tenant, so who signed is not known"]);
    expect(r.office).toEqual([['recTENANTCAP00001'], '']);
    expect(r.missing).toMatch(/could not be read, so Authority Signed was not ticked/);
  });

  it('the hand-off never waits on the tick: a failed tick is said and exits 1, and the next poll ticks it', () => {
    const r = py(AD + `
pdf = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False).name
FAIL = [1]
real = ad.tick_authority
def flaky(t, agreement):
    if FAIL: FAIL.pop(); raise RuntimeError("Airtable 503")
    return real(t, agreement)
ad.tick_authority = flaky
NOTES, OUT = [""], [CARD]
ad.get_task = lambda tid: {"id": tid, "fields": {ad.AF["notes"]: NOTES[0], ad.AF["teamMember"]: [CFV], ad.TASK_TENANTS: ["recTENANTCAP00001"],
                                                 ad.AF["agentOutput"]: OUT[0]}}
ad.patch_task = lambda tid, fields: NOTES.__setitem__(0, fields[ad.AF["notes"]])
outs = []
for _ in range(2):
    if outs:
        OUT[0] = "The signed letter is filed as evidence.\\n\\n**Carrying this out will involve:** Nothing."    # the agent's report
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = ad.cmd_signed(argparse.Namespace(task="recSIGNTASK000001", agreement="Letter of authority - Unit 9", pdf=pdf, then="email"))
    outs.append([code, json.loads(buf.getvalue())])
print(json.dumps({"codes": [o[0] for o in outs], "reopened": [o[1]["reopened"] for o in outs],
                  "ticked": [o[1]["authorityTicked"] for o in outs], "error": outs[0][1]["authorityError"], "handed": "SIGNED COPY BACK" in NOTES[0],
                  "kept": [l for l in NOTES[0].splitlines() if l.startswith("AUTHORITY SIGNERS:")]}))`);
    expect(r.codes).toEqual([1, 0]);
    expect(r.reopened).toEqual([true, false]);
    expect(r.handed).toBe(true);
    expect(r.error).toBe('Authority Signed could not be ticked: Airtable 503');
    expect(r.ticked).toEqual([[], ['recTENANTCAP00001']]);
    // The signers are kept on the task: by the retry the agent has replaced the card's text with its report.
    expect(r.kept).toEqual(['AUTHORITY SIGNERS: jo@example.com, sam@example.com']);
  });

  it('a tick that fails again on the next poll still exits 1, so the row is offered once more', () => {
    {
      const r = py(AD + `
pdf = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False).name
FAIL = [1, 1]
def flaky(t, agreement):
    if FAIL: FAIL.pop(); raise RuntimeError("Airtable 503")
    return [], ""
ad.tick_authority = flaky
NOTES = [""]
ad.get_task = lambda tid: {"id": tid, "fields": {ad.AF["notes"]: NOTES[0], ad.AF["teamMember"]: [CFV]}}
ad.patch_task = lambda tid, fields: NOTES.__setitem__(0, fields[ad.AF["notes"]])
codes = []
for _ in range(3):
    with contextlib.redirect_stdout(io.StringIO()):
        codes.append(ad.cmd_signed(argparse.Namespace(task="recSIGNTASK000001", agreement="Letter of authority - Unit 9", pdf=pdf, then="email")))
print(json.dumps(codes))`);
      expect(r).toEqual([1, 1, 0]);
    }
  });
});

describe("the robots' link script", () => {
  const LINK = `
tl = load_mod("tl", "tenant-link.py")
KEY = tempfile.NamedTemporaryFile("w", delete=False); KEY.write("robot-key-test\\n"); KEY.close()
SEEN = []
class Resp(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False
def answer(status, body):
    def fake(req, timeout=None):
        SEEN.append({"url": req.full_url, "auth": req.get_header("Authorization"), "ua": req.get_header("User-agent"),
                     "body": json.loads(req.data)})
        if status == 200: return Resp(json.dumps(body).encode())
        import urllib.error
        raise urllib.error.HTTPError(req.full_url, status, "x", {}, io.BytesIO(json.dumps(body).encode()))
    return fake
`;
  it('makes no link while the agent is on trial; after it, posts with the robots\' key and a browser-like agent', () => {
    const r = py(LINK + `
tl.urllib.request.urlopen = answer(200, {"ok": True, "url": "https://x/tenant-details.html#c=abc", "expires": "2026-12-08", "firstName": "Sam"})
trial = tl.make("recTENANTCAP00001", key_path=KEY.name)
aef.TRIAL_ENDED[CFV] = "2026-11-24T09:00:00Z"; aef.TRIAL_AGENTS.clear()
made = tl.make("recTENANTCAP00001", key_path=KEY.name)
tl.urllib.request.urlopen = answer(409, {"ok": False, "error": "live", "expires": "2026-12-01"})
live = tl.make("recTENANTCAP00001", key_path=KEY.name)
tl.urllib.request.urlopen = answer(401, {"error": "Sign in needed"})
refused = tl.make("recTENANTCAP00001", key_path=KEY.name)
bad = tl.make("Unit 9", key_path=KEY.name)
nokey = tl.make("recTENANTCAP00001", key_path=KEY.name + ".missing")
print(json.dumps({"trial": trial, "made": made, "live": live, "refused": refused, "bad": bad, "nokey": nokey, "seen": SEEN}))`);
    expect(r.trial[0]).toBe(0);
    expect(r.trial[1].ok).toBe(false);
    expect(r.trial[1].trial).toMatch(/on its trial run/);
    expect(r.made).toEqual([0, { ok: true, url: 'https://x/tenant-details.html#c=abc', expires: '2026-12-08', firstName: 'Sam' }]);
    expect(r.live).toEqual([0, { ok: false, live: true, expires: '2026-12-01' }]);
    expect(r.refused).toEqual([1, { ok: false, status: 401, error: 'Sign in needed' }]);
    expect(r.bad[0]).toBe(2);
    expect(r.nokey[0]).toBe(1);
    expect(JSON.stringify(r.nokey)).not.toContain('robot-key-test');
    // The trial call reached nothing; the three after it each posted once, with the key and a browser-like agent.
    expect(r.seen).toHaveLength(3);
    expect(r.seen[0]).toEqual({ url: 'https://pm.operationsdirector.co.uk/tenant-form/robot-link', auth: 'Robot robot-key-test',
      ua: expect.stringMatching(/^Mozilla\/5\.0/), body: { tenantId: 'recTENANTCAP00001' } });
  });
});
