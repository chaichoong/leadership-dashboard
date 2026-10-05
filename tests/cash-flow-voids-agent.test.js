// Guards the Cash Flow Voids agent, lane A, in TRIAL (build 2 Oct 2026; chain map and trial mode
// approved by Kevin the same day; map on register row reclaAzGLA4utssxx).
//
// WHAT THIS EXISTS FOR
// The agent drafts late-rent messages to TENANTS. Until Kevin cuts it over, nothing it raises may
// reach anyone. That only holds if all of these stay true at once:
//   1. It is a dispatchable role agent, and scripts/rent-check.py (which raises its tasks) names
//      the same Team Members row and register row as scripts/agent-dispatch.py.
//   2. The trial machinery holds a trial agent back (its trial ENDED 5 Oct 2026; each run here puts it back on
//      trial in its own process, see ON_TRIAL, so the doors stay proved for the next agent on trial).
//   3. send-email.py refuses a trial agent's card: approved, by rule, or on a preview.
//   4. The dispatch queue never hands an approved trial card to a carry-out run.
//   5. `trial-settle` closes an approved trial card with Kevin's verdict in Notes, and touches
//      nothing else.
//   6. `submit` refuses the shapes that act without send-email.py (Roy handover, diary, payment
//      list, signing, post) from a trial agent.
//   8. The TASK is on trial whoever holds it: a RENT LATE task re-routed or resubmitted under
//      another agent's id is refused at every door (send, notify, handover, letters, diary, the
//      browser's submit gate), and is settled as checked like any other trial card.
//   7. The card the agent file tells it to write passes the real submit gates.
//  10. The real state (5 Oct 2026): the agent is off trial, and Kevin's approval still guards every send.
//   9. The cut-over MOVES the agent to TRIAL_ENDED with the moment it ended: a card Kevin approved
//      before then stays a check at every door (queue, settle, email, text); one approved after is
//      an ordinary card (independent review, 4 Oct 2026).
// Each check imports or executes the real module, never a copy.
//
// Back-tested (2 Oct 2026) by breaking each rule and watching its case fail:
//   * TRIAL_AGENTS emptied                      -> cases 2, 3, 4, 5 and 6 fail
//   * the refusal removed from load_approved()  -> "refuses an approved trial card" fails
//   * the refusal moved below `if rule:`        -> "refuses a rule send too" fails
//   * the trialChecked branch removed           -> "never becomes a hand-back" fails (it drives the real build_queue)
//   * trial-settle ignoring the outcome         -> "leaves an unapproved trial card alone" fails
//   * TRIAL_ACTING_SHAPE_RE emptied             -> "submit refuses a shape that acts" fails
//   * the task marks ignored at any one door    -> that door's case in block 3, 4, 5, 6 or 8 fails
//   * assertApproved() ignoring `trial`          -> "the robot browser itself refuses" fails
//   * the carry keeping the key line            -> "does not turn the keeper into a trial task" fails
//   * TRIAL_ENDED ignored, or the time compared the wrong way -> block 9 and the "after the trial ends" case fail
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

const ROOT = resolve(__dirname, '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SCRIPTS = resolve(ROOT, 'scripts');
const SRC = readFileSync(DISPATCH, 'utf8');
const AGENT_FILE = resolve(homedir(), '.claude/agents/cash-flow-voids.md');

const RENT_TM = 'rec7aHLK1Q8fMLRXH';
const RENT_ROW = 'reclaAzGLA4utssxx';
const PROPERTY_TM = 'recwWvBju2ycB63i4';
// What Kevin's cut-over PR does: the entry moves from TRIAL_AGENTS to TRIAL_ENDED with the moment it ended.
const CUTOVER = (at) => `
import agent_email_format as aef
aef.TRIAL_ENDED["${RENT_TM}"] = "${at}"
aef.TRIAL_AGENTS.clear()
`;

// The trial ENDED on 5 Oct 2026 (Kevin: "Let's take it off trial"). The doors that hold a trial agent back stay
// in the code for the next agent on trial, so this file still proves every one of them: each run puts the Cash
// Flow Voids agent back on trial inside its own Python process, unless it is the real-state check (pyReal), which
// reads the lists as they ship.
const ON_TRIAL = `
import agent_email_format as _aef
_aef.TRIAL_AGENTS["${RENT_TM}"] = "the Cash Flow Voids agent is on its trial run, so Kevin checks its drafts and nothing is sent to a tenant"
_aef.TRIAL_ENDED.pop("${RENT_TM}", None)
`;
const pyReal = (snippet, input) => py(snippet, input, true);
function py(snippet, input, real = false) {
  const script = `
import importlib.util, json, sys, os, io, contextlib, argparse, tempfile
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
sys.argv = ["test"]
def load_mod(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(SCRIPTS)}, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
ad = load_mod("ad", "agent-dispatch.py")
${real ? '' : ON_TRIAL}
a = json.loads(sys.stdin.read() or "null")
${snippet}
`;
  const out = execFileSync('python3', ['-c', script], { input: JSON.stringify(input ?? null), encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('1. the agent is wired in, and the rent check names the same rows', () => {
  it('is a dispatchable role agent with its register row', () => {
    const r = py(`
rc = load_mod("rc", "rent-check.py")
e = ad.ROLE_AGENTS.get("${RENT_TM}") or {}
print(json.dumps({"entry": e, "alias": [ad.RENT_REC_ID, ad.RENT_REGISTER_ROW], "rentCheck": [rc.AGENT_TEAM_MEMBER, rc.REGISTER_ROW],
                  "ownSignal": ad.own_go_signal("${RENT_TM}"), "inAll": "${RENT_TM}" in ad.ALL_AGENTS}))`);
    expect(r.entry).toEqual({ name: 'AI Cash Flow Voids', agent: 'cash-flow-voids', role: 'worker', registerRow: RENT_ROW });
    expect(r.alias).toEqual([RENT_TM, RENT_ROW]);
    expect(r.rentCheck).toEqual([RENT_TM, RENT_ROW]);
    expect(r.ownSignal).toBe(false);
    expect(r.inAll).toBe(true);
  });

  it('a RENT LATE task name falls in nobody else\'s lane', () => {
    const r = py(`
rc = load_mod("rc", "rent-check.py")
name = rc.TASK_PREFIX + "Unit 9 – 1 Example Road, rent due 30 Sep (reminder)"
desc = "Late rent found by the daily rent check. TRIAL: you draft, Kevin checks, nothing is sent to the tenant."
print(json.dumps({"roy": bool(ad.roy_match(name, desc, "")), "property": bool(ad.property_match(name, desc, "")),
                  "creditor": bool(ad.creditor_match(name, desc, "")), "tier1": bool(ad.tier_match(ad.TIER1_PATTERNS, name, desc, "")),
                  "void": "void" in name.lower()}))`);
    expect(r).toEqual({ roy: false, property: false, creditor: false, tier1: false, void: false });
  });
});

describe('2. it is a trial agent', () => {
  it('trial_problem names it and nobody else', () => {
    const r = py(`
from agent_email_format import TRIAL_AGENTS, trial_problem
print(json.dumps({"listed": sorted(TRIAL_AGENTS), "rent": bool(trial_problem(["${RENT_TM}"])), "mixed": bool(trial_problem(["${PROPERTY_TM}", "${RENT_TM}"])),
                  "property": trial_problem(["${PROPERTY_TM}"]), "none": trial_problem([]), "blank": trial_problem(None)}))`);
    expect(r).toEqual({ listed: [RENT_TM], rent: true, mixed: true, property: '', none: '', blank: '' });
  });

  it('its TASKS are on trial whoever holds them: by name or by the key line, and the marks are the rent check\'s own', () => {
    const r = py(`
from agent_email_format import TRIAL_TASK_MARKS, trial_problem
rc = load_mod("rc", "rent-check.py")
other = ["${PROPERTY_TM}"]
print(json.dumps({"byName": bool(trial_problem(other, "RENT LATE: Unit 9, rent due 30 Sep (reminder)", "")),
                  "byKey": bool(trial_problem(other, "Renamed by someone", "note\\nRENT CHECK KEY: recT:2026-09-30:1")),
                  "neither": trial_problem(other, "COMPLIANCE: EICR renewal", "RENT in the notes"),
                  "midName": trial_problem(other, "Re: RENT LATE: Unit 9", ""),
                  "byAsk": bool(trial_problem(other, "RENT ASK: Unit 9, ask for a Universal Credit screenshot", "")),
                  "marks": TRIAL_TASK_MARKS["${RENT_TM}"],
                  "rentCheck": {"prefix": [rc.TASK_PREFIX, rc.lane_b_rules.ASK_PREFIX, rc.rent_plans.PLAN_PREFIX, rc.rent_cap.CAP_PREFIX, rc.rent_form_chase.PREFIX],
                                "note": rc.KEY_MARK},
                  "askKey": rc.lane_b_rules.TRIAL_KEY_MARK}))`);
    expect([r.byName, r.byKey, r.neither, r.midName, r.byAsk]).toEqual([true, true, '', '', true]);
    expect(r.marks).toEqual(r.rentCheck);
    // Lane B's tenant drafts carry the same key mark, so they are trial tasks by either mark too.
    expect(r.askKey).toBe(r.rentCheck.note);
  });
});

describe('9. a trial ends by MOVING its entry to TRIAL_ENDED', () => {
  it('every trial lane\'s marks sit in exactly one list, and every end time reads as a time', () => {
    const r = pyReal(`
from agent_email_format import TRIAL_AGENTS, TRIAL_ENDED, TRIAL_TASK_MARKS, _utc
print(json.dumps({"orphans": [x for x in TRIAL_TASK_MARKS if x not in TRIAL_AGENTS and x not in TRIAL_ENDED],
                  "both": [x for x in TRIAL_ENDED if x in TRIAL_AGENTS], "unreadable": [x for x, v in TRIAL_ENDED.items() if _utc(v) is None]}))`);
    expect(r).toEqual({ orphans: [], both: [], unreadable: [] });
  });

  it('a card approved before the end is still a trial card wherever it is acted on; after the end it is ordinary', () => {
    const r = py(`${CUTOVER('2026-11-24T09:00:00Z')}
tp = aef.trial_problem
print(json.dumps({"before": tp(["${RENT_TM}"], "", "", "2026-11-24T08:59:00.000Z"), "after": tp(["${RENT_TM}"], "", "", "2026-11-24T09:01:00.000Z"),
                  "blank": tp(["${RENT_TM}"], "", "", ""), "junk": tp(["${RENT_TM}"], "", "", "soon"), "notActing": tp(["${RENT_TM}"]),
                  "byName": tp(["${PROPERTY_TM}"], "RENT LATE: Unit 9", "", "2026-11-23T10:00:00.000Z"),
                  "byKey": tp(["${PROPERTY_TM}"], "Renamed", "RENT CHECK KEY: recT:1", "2026-11-23T10:00:00.000Z"),
                  "other": tp(["${PROPERTY_TM}"], "COMPLIANCE: EICR", "", "2026-11-23T10:00:00.000Z")}))`);
    expect(r.before).toMatch(/approved during the trial run, which ended 2026-11-24T09:00:00Z/);
    expect(r.after).toBe('');
    expect(r.blank).toMatch(/no readable approval time/);
    expect(r.junk).toMatch(/no readable approval time/);
    // A caller not acting on an approval (submit, handover) treats it as an ordinary agent again.
    expect(r.notActing).toBe('');
    expect(r.byName).toMatch(/approved during the trial run/);
    expect(r.byKey).toMatch(/approved during the trial run/);
    expect(r.other).toBe('');
  });
});

describe('10. the trial ended on 5 Oct 2026, and Kevin still approves every send', () => {
  it('the agent is off trial: in TRIAL_ENDED with a readable time, its task marks kept, nobody on trial', () => {
    const r = pyReal(`
from agent_email_format import TRIAL_AGENTS, TRIAL_ENDED, TRIAL_TASK_MARKS, _utc, trial_problem
print(json.dumps({"onTrial": sorted(TRIAL_AGENTS), "ended": TRIAL_ENDED.get("${RENT_TM}"), "readable": bool(_utc(TRIAL_ENDED.get("${RENT_TM}"))),
                  "marksKept": "${RENT_TM}" in TRIAL_TASK_MARKS, "submit": trial_problem(["${RENT_TM}"]),
                  "duringTrial": trial_problem(["${RENT_TM}"], "RENT LATE: Unit 9", "", "2026-10-05T07:00:00.000Z"),
                  "after": trial_problem(["${RENT_TM}"], "RENT LATE: Unit 9", "", "2026-10-05T13:00:00.000Z")}))`);
    expect(r.onTrial).toEqual([]);
    expect(r.ended).toMatch(/^2026-10-05T\d\d:\d\d:00Z$/);
    expect([r.readable, r.marksKept]).toEqual([true, true]);
    expect(r.submit).toBe('');
    // This morning's cards Kevin approved as checks are never sent; one he approves after the cut-over is.
    expect(r.duringTrial).toMatch(/approved during the trial run/);
    expect(r.after).toBe('');
  });

  it('the approval card still guards every send: no approval, no email; an approval after the cut-over sends', () => {
    const OUT = 'TO: tenant@example.com\nFROM: info@agilelets.co.uk\nSUBJECT: Your rent\n---\nHello.\n\nKind regards\nRoy Lavin\nAgile Lets';
    const r = pyReal(`
se = load_mod("se", "send-email.py")
se.rule_send_problem = lambda *x, **y: ""
def load(outcome, approved):
    F = {se.AF["name"]: "RENT LATE: Unit 9", se.AF["approvalOutcome"]: {"name": outcome} if outcome else None,
         se.AF["taskType"]: {"name": "Correspondence"}, se.AF["agentOutput"]: a["out"], se.AF["approvedAt"]: approved,
         se.AF["sentForApprovalBy"]: ["${RENT_TM}"], se.AF["teamMember"]: ["${RENT_TM}"]}
    se.get_task = lambda task_id: {"id": task_id, "createdTime": "2026-10-05T12:00:00.000Z", "fields": F}
    try:
        se.load_approved("recTEST", require_approval=True, rule=None); return ""
    except SystemExit as e:
        return str(e)
print(json.dumps({"none": load(None, None), "changes": load("Changes requested", None),
                  "morning": load("Approved as-is", "2026-10-05T07:00:00.000Z"), "after": load("Approved as-is", "2026-10-05T13:00:00.000Z")}))`, { out: OUT });
    expect(r.none).not.toBe('');
    expect(r.changes).not.toBe('');
    expect(r.morning).toMatch(/approved during the trial run/);
    expect(r.after).toBe('');
  });
});

describe('3. send-email.py never sends a trial card', () => {
  const OUTPUT = 'TO: tenant@example.com\nFROM: info@agilelets.co.uk\nSUBJECT: Your rent\n---\nHello.\n\nKind regards\nRoy Lavin\nAgile Lets';
  const load = (fields, opts = {}) => py(`
se = load_mod("se", "send-email.py")
F = {se.AF[k]: v for k, v in a["fields"].items()}
se.get_task = lambda task_id: {"id": task_id, "createdTime": "2026-10-02T09:00:00.000Z", "fields": F}
se.rule_send_problem = lambda *x, **y: ""
try:
    se.load_approved("recTEST", require_approval=a["requireApproval"], rule=a["rule"])
    print(json.dumps({"refused": ""}))
except SystemExit as e:
    print(json.dumps({"refused": str(e)}))`, { fields, requireApproval: opts.requireApproval ?? true, rule: opts.rule ?? null });
  const approved = { name: 'RENT LATE: Unit 9', approvalOutcome: { name: 'Approved as-is' }, taskType: { name: 'Correspondence' },
    agentOutput: OUTPUT, approvedAt: '2026-10-02T10:00:00.000Z' };

  it('refuses an approved trial card', () => {
    const r = load({ ...approved, sentForApprovalBy: [RENT_TM] });
    expect(r.refused).toMatch(/REFUSED: task recTEST is a trial card and is never sent/);
  });
  it('refuses on the Team Member link alone', () => {
    expect(load({ ...approved, sentForApprovalBy: ['recAGENT000000001'], teamMember: [RENT_TM] }).refused).toMatch(/trial card/);
  });
  it('refuses a rule send too, and a preview that needs no approval', () => {
    expect(load({ ...approved, sentForApprovalBy: [RENT_TM] }, { rule: 'quote-request' }).refused).toMatch(/trial card/);
    expect(load({ ...approved, sentForApprovalBy: [RENT_TM] }, { requireApproval: false }).refused).toMatch(/trial card/);
  });
  it('an ordinary card from an agent that is not on trial still sends', () => {
    expect(load({ ...approved, name: 'COMPLIANCE: EICR quote', sentForApprovalBy: [PROPERTY_TM] }).refused).toBe('');
  });
  it('after the trial ends, a card the trial settled (TRIAL CHECKED) is history and is never emailed', () => {
    const r = py(`
${CUTOVER('2026-10-02T09:30:00Z')}
se = load_mod("se", "send-email.py")
def go(notes, approved="2026-10-02T10:00:00.000Z"):
    F = {se.AF["name"]: "RENT LATE: Unit 9", se.AF["approvalOutcome"]: {"name": "Approved as-is"}, se.AF["taskType"]: {"name": "Correspondence"},
         se.AF["agentOutput"]: ${JSON.stringify(OUTPUT)}, se.AF["approvedAt"]: approved,
         se.AF["sentForApprovalBy"]: ["${RENT_TM}"], se.AF["notes"]: notes}
    se.get_task = lambda task_id: {"id": task_id, "createdTime": "2026-10-02T09:00:00.000Z", "fields": F}
    try:
        se.load_approved("recTEST"); return ""
    except SystemExit as e:
        return str(e)
print(json.dumps({"settled": go("RENT CHECK KEY: x\\n[03 Oct 2026] TRIAL CHECKED: Kevin's verdict was 'Approved as-is'"), "fresh": go("RENT CHECK KEY: x"),
                  "inTrial": go("RENT CHECK KEY: x", "2026-10-02T09:15:00.000Z"), "blank": go("RENT CHECK KEY: x", "")}))`);
    expect(r.settled).toMatch(/was settled on the trial \(TRIAL CHECKED\); it is history/);
    // A card approved after the trial ends sends as any other.
    expect(r.fresh).toBe('');
    // One approved before the end, but not yet settled when the PR merged, is never emailed.
    expect(r.inTrial).toMatch(/trial card and is never sent: it was approved during the trial run, which ended 2026-10-02T09:30:00Z/);
    expect(r.blank).toMatch(/trial card and is never sent: it carries no readable approval time/);
  });
  it('a RENT LATE task resubmitted or re-routed under another agent is still refused, by its name or its key line', () => {
    expect(load({ ...approved, sentForApprovalBy: [PROPERTY_TM], teamMember: [PROPERTY_TM] }).refused).toMatch(/trial card/);
    expect(load({ ...approved, name: 'Renamed', notes: 'RENT CHECK KEY: recT:2026-09-30:1', sentForApprovalBy: [PROPERTY_TM] }).refused).toMatch(/trial card/);
  });
});

describe('4. the queue never hands an approved trial card to a carry-out run', () => {
  // The real build_queue, offline: the board read and the register read are faked, and any other
  // network call fails the test rather than reaching Airtable (the tests/standing-holds.test.js harness).
  const queue = (tasks, prelude = '') => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, urllib.request
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${prelude}
AF = m.AF
recs = []
for t in json.loads(sys.stdin.read()):
    f = {AF["name"]: t["name"], AF["status"]: {"name": "Today"}, AF["teamMember"]: t.get("teamMember", [t["agent"]]), AF["notes"]: t.get("notes", "")}
    if t.get("outcome"):
        f[AF["approvalOutcome"]] = {"name": t["outcome"]}
        f[AF["approvedAt"]] = t.get("approvedAt", "2026-10-02T10:00:00.000Z")
        f[AF["sentForApprovalBy"]] = t.get("sentBy", [t["agent"]])
    recs.append({"id": t["id"], "fields": f})
m.query_tasks = lambda formula, **kw: recs
m.fetch_role_roster = lambda: {}
q = m.build_queue()
c = q["counts"]
print(json.dumps({"trialChecked": [x["id"] for x in q["trialChecked"]], "worklist": {x["id"]: x.get("kind") for x in q["worklist"]},
                  "formCards": [x["id"] for x in q["formCards"]],
                  "counts": {k: c[k] for k in ("trialChecked", "approvedHandbacks", "changesRequested", "newWork", "formCards")}}))`],
      { input: JSON.stringify(tasks), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json') } });
    return JSON.parse(out.trim().split('\n').pop());
  };

  it('an approved trial card is listed as trialChecked and never becomes a hand-back; everything else is as before', () => {
    const r = queue([
      { id: 'recTrialYes', name: 'RENT LATE: Unit 9, rent due 30 Sep (reminder)', agent: RENT_TM, outcome: 'Approved as-is' },
      { id: 'recTrialEdit', name: 'RENT LATE: Unit 8, rent due 30 Sep (reminder)', agent: RENT_TM, outcome: 'Approved with minor edits' },
      { id: 'recTrialRedo', name: 'RENT LATE: Unit 7, rent due 30 Sep (reminder)', agent: RENT_TM, outcome: 'Changes requested' },
      { id: 'recTrialNew', name: 'RENT LATE: Unit 6, rent due 30 Sep (reminder)', agent: RENT_TM },
      { id: 'recOtherYes', name: 'COMPLIANCE: EICR renewal', agent: PROPERTY_TM, outcome: 'Approved as-is' },
      // Re-routed: another agent submitted the card for a RENT LATE task. Still a trial card.
      { id: 'recRerouted', name: 'RENT LATE: Unit 5, rent due 30 Sep (reminder)', agent: PROPERTY_TM, outcome: 'Approved as-is' },
    ]);
    expect(r.trialChecked).toEqual(['recTrialYes', 'recTrialEdit', 'recRerouted']);
    expect(r.counts).toEqual({ trialChecked: 3, approvedHandbacks: 1, changesRequested: 1, newWork: 1, formCards: 0 });
    // The worklist is what a dispatch run works: the two approved trial cards are not on it.
    expect(Object.keys(r.worklist).sort()).toEqual(['recOtherYes', 'recTrialNew', 'recTrialRedo']);
    expect(r.worklist.recOtherYes).toBe('carry_out');
  });

  it('reads the Team Member as send-email does: a card held by the trial agent but sent by another is checked, never handed out', () => {
    const r = queue([
      { id: 'recHeld', name: 'Draft with no lane marks', agent: PROPERTY_TM, teamMember: [RENT_TM], outcome: 'Approved as-is' },
      // Every Sent For Approval By link, not only the first, as send-email.py reads them.
      { id: 'recSecond', name: 'Another unmarked draft', agent: PROPERTY_TM, sentBy: [PROPERTY_TM, RENT_TM], teamMember: [PROPERTY_TM], outcome: 'Approved as-is' },
      { id: 'recOtherYes', name: 'COMPLIANCE: EICR renewal', agent: PROPERTY_TM, outcome: 'Approved as-is' },
    ]);
    // Handed out, it would be refused by send-email.py every 30 minutes for ever (review, 4 Oct 2026).
    expect(r.trialChecked).toEqual(['recHeld', 'recSecond']);
    expect(Object.keys(r.worklist)).toEqual(['recOtherYes']);
  });

  it('after the cut-over, a card approved during the trial is still only checked; one approved after it is carried out', () => {
    const r = queue([
      { id: 'recInTrial', name: 'RENT LATE: Unit 9, rent due 30 Sep (reminder)', agent: RENT_TM, outcome: 'Approved as-is', approvedAt: '2026-10-02T10:00:00.000Z' },
      { id: 'recAfter', name: 'RENT LATE: Unit 8, rent due 30 Sep (reminder)', agent: RENT_TM, outcome: 'Approved as-is', approvedAt: '2026-10-02T12:00:00.000Z' },
      { id: 'recRerouted', name: 'RENT LATE: Unit 7, rent due 30 Sep (reminder)', agent: PROPERTY_TM, outcome: 'Approved as-is', approvedAt: '2026-10-02T10:00:00.000Z' },
      { id: 'recOtherYes', name: 'COMPLIANCE: EICR renewal', agent: PROPERTY_TM, outcome: 'Approved as-is', approvedAt: '2026-10-02T10:00:00.000Z' },
    ], CUTOVER('2026-10-02T11:00:00Z'));
    expect(r.trialChecked).toEqual(['recInTrial', 'recRerouted']);
    expect(r.worklist.recAfter).toBe('carry_out');
    expect(r.worklist.recOtherYes).toBe('carry_out');
    expect(r.worklist.recInTrial).toBeUndefined();
  });

  it('a form card is never an agent\'s work: listed as a form card whatever its outcome, by either mark, never carried out or trial-checked', () => {
    const KEY = 'RENT FORM KEY: recFormTest000001:form:1';
    const r = queue([
      { id: 'recFormYes', name: 'RENT FORM: direct rent payment form: Unit 9', agent: RENT_TM, outcome: 'Approved as-is', notes: KEY },
      // A renamed card, or one whose Notes lost the key, is still a form card: either mark keeps every door shut.
      { id: 'recFormNoKey', name: 'RENT FORM: direct rent payment form: Unit 8', agent: RENT_TM, outcome: 'Approved as-is' },
      { id: 'recFormRenamed', name: 'Unit 7 form', agent: RENT_TM, outcome: 'Approved as-is', notes: KEY },
      // Sent back for changes, or stranded with no outcome: the rent check works these, never a redo run.
      { id: 'recFormRedo', name: 'RENT FORM: direct rent payment form: Unit 6', agent: RENT_TM, outcome: 'Changes requested', notes: KEY },
      { id: 'recFormStranded', name: 'RENT FORM: direct rent payment form: Unit 5', agent: RENT_TM, notes: KEY },
      { id: 'recOtherYes', name: 'COMPLIANCE: EICR renewal', agent: PROPERTY_TM, outcome: 'Approved as-is' },
    ]);
    expect(r.formCards).toEqual(['recFormYes', 'recFormNoKey', 'recFormRenamed', 'recFormRedo', 'recFormStranded']);
    expect(r.trialChecked).toEqual([]);
    expect(Object.keys(r.worklist)).toEqual(['recOtherYes']);
    expect(r.counts.formCards).toBe(5);
  });
});

describe('5. trial-settle closes an approved trial card with the verdict, and nothing else', () => {
  const settle = (tasks, prelude = '') => py(`${prelude}
recs = [{"id": t["id"], "fields": {ad.AF["name"]: t["name"], ad.AF["approvalOutcome"]: t["outcome"], ad.AF["notes"]: t.get("notes", ""),
                                    ad.AF["approvedAt"]: t.get("approvedAt", ""), ad.AF["agentOutput"]: t.get("output", ""),
                                    ad.AF["sentForApprovalBy"]: [t["agent"]], ad.AF["teamMember"]: t.get("teamMember", [t["agent"]])}} for t in a]
patched, ledger = [], []
ad.query_tasks = lambda formula, **k: recs
ad.patch_task = lambda tid, fields: patched.append([tid, {k: v for k, v in fields.items()}])
ad.ledger_append = lambda tid, event: ledger.append([tid, event])
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    ad.cmd_trial_settle(argparse.Namespace())
print(json.dumps({"out": json.loads(buf.getvalue()), "patched": [[tid, f.get(ad.AF["status"]), bool(f.get(ad.AF["completion"])), f.get(ad.AF["notes"], "")] for tid, f in patched], "ledger": ledger}))`, tasks);

  it('an approved trial card is completed with the TRIAL CHECKED stamp, keeping its notes', () => {
    const r = settle([{ id: 'recA', name: 'RENT LATE: Unit 9', outcome: 'Approved with minor edits', agent: RENT_TM, notes: 'RENT CHECK KEY: recT:2026-09-30:1' }]);
    expect(r.out.trialSettled).toEqual([{ task: 'recA', name: 'RENT LATE: Unit 9', outcome: 'Approved with minor edits' }]);
    expect(r.patched).toHaveLength(1);
    const [id, status, completed, notes] = r.patched[0];
    expect([id, status, completed]).toEqual(['recA', 'Completed', true]);
    expect(notes).toMatch(/^RENT CHECK KEY: recT:2026-09-30:1/);
    expect(notes).toMatch(/TRIAL CHECKED: Kevin's verdict was 'Approved with minor edits'\. Nothing was sent/);
    expect(r.ledger).toEqual([['recA', 'done']]);
  });
  it('leaves an unapproved trial card, and an approved card of any other agent, alone', () => {
    const r = settle([
      { id: 'recB', name: 'RENT LATE: Unit 8', outcome: 'Changes requested', agent: RENT_TM },
      { id: 'recC', name: 'RENT LATE: Unit 7', outcome: 'Rejected', agent: RENT_TM },
      { id: 'recD', name: 'COMPLIANCE: EICR', outcome: 'Approved as-is', agent: PROPERTY_TM },
    ]);
    expect(r.out.trialSettled).toEqual([]);
    expect(r.patched).toEqual([]);
  });
  it('after the cut-over, settles a card approved during the trial and leaves one approved after it to be sent', () => {
    const r = settle([
      { id: 'recInTrial', name: 'RENT LATE: Unit 9', outcome: 'Approved as-is', agent: RENT_TM, approvedAt: '2026-10-02T10:00:00.000Z' },
      { id: 'recAfter', name: 'RENT LATE: Unit 8', outcome: 'Approved as-is', agent: RENT_TM, approvedAt: '2026-10-02T12:00:00.000Z' },
    ], CUTOVER('2026-10-02T11:00:00Z'));
    expect(r.out.trialSettled.map(x => x.task)).toEqual(['recInTrial']);
    expect(r.patched).toHaveLength(1);
    expect(r.patched[0][3]).toMatch(/TRIAL CHECKED: .*Nothing was sent: it was approved during the trial run, which ended 2026-10-02T11:00:00Z/);
  });
  it('settles a card the trial agent holds as Team Member, whoever sent it', () => {
    const r = settle([{ id: 'recHeld', name: 'Draft with no lane marks', outcome: 'Approved as-is', agent: PROPERTY_TM, teamMember: [RENT_TM] }]);
    expect(r.out.trialSettled.map(x => x.task)).toEqual(['recHeld']);
  });
  it('never settles what the queue sends elsewhere first: Kevin\'s answer to a DECIDE card, or a card of an agent on its own go signal', () => {
    const TASK_MANAGER = 'recAGENTTASKMGR01';
    const CONTENT = 'recRcy1Edas6rGaaF';
    const r = settle([
      { id: 'recDecide', name: 'RENT LATE: Unit 9', outcome: 'Approved as-is', agent: TASK_MANAGER, teamMember: [RENT_TM],
        output: 'DECIDE: keep chasing or write it off?\n\nOption A ...' },
      { id: 'recOwnSignal', name: 'Episode 12', outcome: 'Approved as-is', agent: CONTENT, teamMember: [RENT_TM] },
      { id: 'recPlain', name: 'RENT LATE: Unit 8', outcome: 'Approved as-is', agent: RENT_TM },
    ]);
    expect(r.out.trialSettled.map(x => x.task)).toEqual(['recPlain']);
  });
  it('settles a RENT LATE card another agent submitted', () => {
    const r = settle([{ id: 'recE', name: 'RENT LATE: Unit 5, rent due 30 Sep (reminder)', outcome: 'Approved as-is', agent: PROPERTY_TM }]);
    expect(r.out.trialSettled.map(x => x.task)).toEqual(['recE']);
  });
  it('is a real command', () => {
    expect(SRC).toMatch(/"trial-settle": cmd_trial_settle/);
    expect(SRC).toMatch(/sub\.add_parser\("trial-settle"/);
    const poll = readFileSync(resolve(ROOT, 'scripts/handback-poll-run.sh'), 'utf8');
    expect(poll).toMatch(/agent-dispatch\.py" trial-settle/);
    // After `lessons`, so a note Kevin ticked Remember on is stored before the card is closed,
    // and before the queue is read, so a settled card is never offered to a carry-out run.
    const at = (needle) => poll.indexOf(needle);
    expect(at('agent-dispatch.py" lessons')).toBeGreaterThan(-1);
    expect(at('agent-dispatch.py" lessons')).toBeLessThan(at('agent-dispatch.py" trial-settle'));
    expect(at('agent-dispatch.py" trial-settle')).toBeLessThan(at('agent-dispatch.py" queue'));
  });
});

describe('6. submit refuses a shape that acts without the send script', () => {
  const submit = (agent, output) => py(`
ad.require_role_agent_live = lambda rec, verb: None
path = os.path.join(tempfile.mkdtemp(), "out.md"); open(path, "w").write(a["output"])
reached = []
ad.plain_summary_problem = lambda *x: reached.append("past the trial guard") or "stop here"
try:
    ad.cmd_submit(argparse.Namespace(task="recTEST", agent=a["agent"], type="Admin", output_file=path, plain_task="x", plain_approve="y",
                                     tier1=False, siblings=None, coverage=None, receipt=None, attach=None))
    print(json.dumps({"refused": ""}))
except SystemExit as e:
    print(json.dumps({"refused": str(e), "reached": reached}))`, { agent, output });

  it.each(['PASS TO ROY: tell the letting agent', 'CALENDAR: 2026-10-05 10:00 call', 'MARK FOR PAYMENT: rent refund',
    'DOCUMENT: ~/x.pdf\nSIGNERS: a@b.com\n---\nSign this', 'TRACK RECORD: none found (searched tasks)\nPOST:\nA Tenant\n1 Example Road\nDOCUMENT: ~/x.pdf\n---\nLetter'])(
    'from the trial agent: %s', (output) => {
      const r = submit(RENT_TM, output);
      expect(r.refused).toMatch(/A trial agent's card is a draft for Kevin to check/);
      expect(r.reached).toEqual([]);
    });
  it('a decorated heading does not slip past: bold, bulleted, numbered or quoted', () => {
    for (const output of ['**MARK FOR PAYMENT**: rent refund', '- PASS TO ROY: chase the agent', '1. CALENDAR: 2026-10-05', '> POST:\nA Tenant']) {
      expect(submit(RENT_TM, output).refused, output).toMatch(/A trial agent's card is a draft/);
    }
  });
  it('a RENT LATE task submitted under another agent\'s id is held to the same rule', () => {
    const r = py(`
ad.require_role_agent_live = lambda rec, verb: None
ad.get_task = lambda tid: {"id": tid, "fields": {ad.AF["name"]: "RENT LATE: Unit 9, rent due 30 Sep (reminder)", ad.AF["notes"]: "RENT CHECK KEY: recT:2026-09-30:1"}}
path = os.path.join(tempfile.mkdtemp(), "out.md"); open(path, "w").write("PASS TO ROY: ask the tenant to pay\\n\\n**Carrying this out will involve:** Roy is told.")
ad.plain_summary_problem = lambda *x: ""
try:
    ad.cmd_submit(argparse.Namespace(task="recTEST", agent="${PROPERTY_TM}", type="Admin", output_file=path, plain_task="x", plain_approve="y",
                                     tier1=False, siblings=None, coverage=None, receipt=None, attach=None))
    print(json.dumps({"refused": ""}))
except SystemExit as e:
    print(json.dumps({"refused": str(e)}))`);
    expect(r.refused).toMatch(/This task belongs to a lane on trial, whoever submits it/);
  });
  it('a task the trial agent holds as Team Member is held to the same rule, whoever submits it', () => {
    const r = py(`
ad.require_role_agent_live = lambda rec, verb: None
ad.get_task = lambda tid: {"id": tid, "fields": {ad.AF["name"]: "Unmarked task", ad.AF["notes"]: "", ad.AF["teamMember"]: ["${RENT_TM}"]}}
path = os.path.join(tempfile.mkdtemp(), "out.md"); open(path, "w").write("PASS TO ROY: ask the tenant to pay\\n\\n**Carrying this out will involve:** Roy is told.")
ad.plain_summary_problem = lambda *x: ""
try:
    ad.cmd_submit(argparse.Namespace(task="recTEST", agent="${PROPERTY_TM}", type="Admin", output_file=path, plain_task="x", plain_approve="y",
                                     tier1=False, siblings=None, coverage=None, receipt=None, attach=None))
    print(json.dumps({"refused": ""}))
except SystemExit as e:
    print(json.dumps({"refused": str(e)}))`);
    expect(r.refused).toMatch(/This task belongs to a lane on trial, whoever submits it/);
  });
  it('the same shape from another agent goes on to the ordinary gates, and so does a trial agent\'s email', () => {
    expect(submit(PROPERTY_TM, 'PASS TO ROY: book the visit').reached).toEqual(['past the trial guard']);
    expect(submit(RENT_TM, 'TO: tenant@example.com\nFROM: info@agilelets.co.uk\nSUBJECT: Your rent\n---\nHello').reached).toEqual(['past the trial guard']);
  });
});

describe('7. the card the agent file describes passes the real submit gates', () => {
  const CARD = [
    'TRACK RECORD: none found (searched tasks and Gmail for tenant@example.com, 1 Example Road)',
    'TO: tenant@example.com',
    'FROM: info@agilelets.co.uk',
    'SUBJECT: Your rent at 1 Example Road',
    '---',
    'Hello Sam,',
    '',
    'Your rent of £500.00 was due on 30 September and we have not received it yet. Please pay it today, or reply to this email to tell us what has happened.',
    '',
    'Kind regards',
    'Roy Lavin',
    'Agile Lets',
    '',
    '**Carrying this out will involve:** Trial card. Approving it records your verdict and sends nothing to the tenant.',
  ].join('\n');

  it('clears the email, carry-out, track record, plain summary, hand-back and tier-1 checks', () => {
    const r = py(`
from agent_email_format import validate_submission_any
parsed = validate_submission_any(a)
print(json.dumps({"from": parsed["from"], "to": parsed["to"], "body": parsed["body"],
                  "gates": [ad.carry_out_problem(a), ad.track_record_problem(a, True),
                            ad.plain_summary_problem("Sam at 1 Example Road is 2 days late with the rent due 30 September.", "Trial: nothing is sent. Your verdict teaches the agent."),
                            ad.handback_problem(a, "Correspondence") or "", ad.tier_match(ad.TIER1_PATTERNS, "RENT LATE: Unit 9", "", a) or "",
                            "trial guard: " + ("refuses" if ad.TRIAL_ACTING_SHAPE_RE.search(a) else "passes")]}))`, CARD);
    expect(r.from).toBe('info@agilelets.co.uk');
    expect(r.to).toEqual(['tenant@example.com']);
    expect(r.gates).toEqual(['', '', '', '', '', 'trial guard: passes']);
    expect(r.body).toMatch(/Kind regards\nRoy Lavin\nAgile Lets$/);
    expect(r.body).not.toMatch(/Carrying this out|TRACK RECORD/);
  });

  it.skipIf(!existsSync(AGENT_FILE))('the agent file says the trial ended and approval still sends, the sender, the sign-off and the two things it never does', () => {
    const f = readFileSync(AGENT_FILE, 'utf8');
    expect(f).toMatch(/^name: cash-flow-voids$/m);
    expect(f).toContain('FROM: info@agilelets.co.uk');
    expect(f).toContain('Roy Lavin\n   Agile Lets');
    expect(f).toContain('--agent rec7aHLK1Q8fMLRXH');
    // The trial ended on 5 Oct 2026: the file says so, and that every card still waits for Kevin's approval.
    expect(f).toMatch(/Your trial ended \(Kevin, 5 Oct 2026/);
    expect(f).toMatch(/Every card still waits for\s+Kevin's approval/);
    expect(f).not.toMatch(/You are on trial/);
    expect(f).toMatch(/Never contact the DWP/);
    expect(f).toMatch(/Never mention court, eviction, notice/);
    expect(f).toContain("## Decision criteria (Kevin's ruling, 7 Sep 2026)");
    expect(f).toContain('## Lessons from Kevin');
  });
});

describe('8. every other door refuses a trial task', () => {
  const TASK = { name: 'RENT LATE: Unit 9, rent due 30 Sep (reminder)', notes: 'RENT CHECK KEY: recT:2026-09-30:1' };

  it('notify: the task and its draft are never mailed to a colleague', () => {
    const r = py(`
se = load_mod("se", "send-email.py")
se.team_roster = lambda: ({"roy.lavin1978@gmail.com": {"name": "Roy Lavin"}}, [], lambda *x: "")
def run(fields):
    se.get_task = lambda tid: {"id": tid, "createdTime": "2026-10-02T09:00:00.000Z", "fields": {se.AF[k]: v for k, v in fields.items()}}
    try:
        se.cmd_notify(argparse.Namespace(task="recTEST", to="roy.lavin1978@gmail.com", reason="x", dry_run=True, note=None, by=None))
        return ""
    except SystemExit as e:
        return str(e)
    except Exception as e:
        return "past the trial stop: " + type(e).__name__
print(json.dumps({"byAgent": run({"name": "A task", "teamMember": ["${RENT_TM}"]}), "byTask": run({"name": a["name"], "teamMember": ["${PROPERTY_TM}"]}),
                  "ordinary": run({"name": "COMPLIANCE: EICR", "teamMember": ["${PROPERTY_TM}"]})}))`, TASK);
    expect(r.byAgent).toMatch(/REFUSED: task recTEST is a trial task and is not mailed to anyone/);
    expect(r.byTask).toMatch(/REFUSED: task recTEST is a trial task/);
    expect(r.ordinary).not.toMatch(/trial/);
  });

  it('handover: a trial task is never handed to a person', () => {
    const r = py(`
def run(fields):
    ad.get_task = lambda tid: {"id": tid, "fields": {ad.AF[k]: v for k, v in fields.items()}}
    ad.patch_task = lambda *x: (_ for _ in ()).throw(RuntimeError("a write was reached"))
    try:
        ad.cmd_handover(argparse.Namespace(task="recTEST", to=ad.ROY_EMAIL, reason="x"))
        return ""
    except SystemExit as e:
        return str(e)
    except RuntimeError as e:
        return str(e)
print(json.dumps({"byAgent": run({"name": "A task", "teamMember": ["${RENT_TM}"]}), "byKey": run({"name": "Renamed", "notes": a["notes"], "teamMember": ["${PROPERTY_TM}"]}),
                  "ordinary": run({"name": "Fix the boiler at 1 Example Road", "teamMember": ["${PROPERTY_TM}"]})}))`, TASK);
    expect(r.byAgent).toMatch(/refusing to hand over recTEST/);
    expect(r.byKey).toMatch(/refusing to hand over recTEST/);
    expect(r.ordinary).toBe('a write was reached');
  });

  it('the browser\'s submit gate reads a trial task as not approved', () => {
    const r = py(`
def run(fields):
    f = {ad.AF[k]: v for k, v in fields.items()}
    f[ad.AF["approvalOutcome"]] = {"name": "Approved as-is"}
    ad.get_task = lambda tid: {"id": tid, "fields": f}
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        ad.cmd_outcome(argparse.Namespace(task="recTEST"))
    o = json.loads(buf.getvalue()); return [o["approved"], bool(o["trial"])]
print(json.dumps({"trial": run({"name": a["name"], "teamMember": ["${PROPERTY_TM}"]}), "ordinary": run({"name": "COMPLIANCE: licence form", "teamMember": ["${PROPERTY_TM}"]})}))`, TASK);
    expect(r).toEqual({ trial: [false, true], ordinary: [true, false] });
  });

  it('the robot browser itself refuses to press submit for a trial task, whatever the outcome reads', () => {
    const gate = (state) => {
      const dir = mkdtempSync(resolve(tmpdir(), 'outcome-'));
      const fake = resolve(dir, 'outcome.py');
      writeFileSync(fake, `import json\nprint(json.dumps(${JSON.stringify(state)}))\n`.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False'));
      return execFileSync('node', ['-e', `
const b = require(${JSON.stringify(resolve(ROOT, 'scripts/agent-browser.js'))});
try { b.assertApproved('recAAAAAAAAAAAAAA'); console.log('passed'); } catch (e) { console.log(e.message); }`],
        { encoding: 'utf8', env: { ...process.env, AGENT_OUTCOME_SCRIPT: fake } }).trim();
    };
    expect(gate({ outcome: 'Approved as-is', approved: false, trial: 'the Cash Flow Voids agent is on its trial run' }))
      .toMatch(/is a trial task and no form is submitted for it: the Cash Flow Voids agent is on its trial run/);
    expect(gate({ outcome: 'Approved as-is', approved: false, trial: '' })).toMatch(/is a trial task and no form is submitted/);
    expect(gate({ outcome: 'Approved as-is', approved: true, trial: '' })).toBe('passed');
    expect(gate({ outcome: '', approved: false, trial: '' })).toMatch(/is not approved/);
  });

  it('a RENT LATE task folded into another task does not turn the keeper into a trial task', () => {
    const r = py(`
from agent_email_format import trial_problem, strip_trial_marks
written = {}
ad.get_task = lambda tid: {"id": tid, "fields": {ad.AF["name"]: "INBOUND: tenant asks about the rent", ad.AF["notes"]: "earlier note"}}
ad.patch_task = lambda tid, fields: written.update(fields)
twin = {ad.AF["name"]: "RENT LATE: Unit 9, rent due 30 Sep (reminder)",
        ad.AF["description"]: "Late rent found by the daily rent check.\\nRent: 500 a month\\n\\nRENT CHECK KEY: recT:2026-09-30:1"}
block = ad.carry_output_to_keeper("recTWIN", twin, "recKEEPER", "02 Oct 2026 14:00")
notes = written[ad.AF["notes"]]
print(json.dumps({"hasKey": "RENT CHECK KEY" in notes, "carried": "Rent: 500 a month" in notes, "kept": notes.startswith("earlier note"),
                  "keeperTrial": trial_problem(["${PROPERTY_TM}"], "INBOUND: tenant asks about the rent", notes),
                  "strip": strip_trial_marks("a\\nRENT CHECK KEY: x:1\\nb")}))`);
    expect(r).toEqual({ hasKey: false, carried: true, kept: true, keeperTrial: '', strip: 'a\nb' });
  });

  it('letters and the diary refuse it at their own doors', () => {
    const r = py(`
sl = load_mod("sl", "send-letter.py")
cw = load_mod("cw", "calendar-write.py")
def letter(fields):
    sl.get_task = lambda tid: {"id": tid, "createdTime": "2026-10-02T09:00:00.000Z", "fields": {sl.AF[k]: v for k, v in fields.items()}}
    try:
        sl.load_approved("recTEST"); return ""
    except SystemExit as e:
        return str(e)
def diary(name, tm):
    cw.get_task = lambda tid: {"id": tid, "createdTime": "2026-10-02T09:00:00.000Z", "fields": {cw.AF["name"]: name, cw.TEAM_MEMBER: [tm]}}
    try:
        cw.cmd_create(argparse.Namespace(task="recTEST", handled=False, dry_run=True)); return ""
    except SystemExit as e:
        return str(e)
    except Exception as e:
        return "past the trial stop"
print(json.dumps({"letter": letter({"name": a["name"], "teamMember": ["${PROPERTY_TM}"]}), "letterAgent": letter({"name": "x", "sentForApprovalBy": ["${RENT_TM}"]}),
                  "letterOrdinary": letter({"name": "COMPLIANCE: notice"}),
                  "diary": diary(a["name"], "${PROPERTY_TM}"), "diaryOrdinary": diary("Inspection at 1 Example Road", "${PROPERTY_TM}")}))`, TASK);
    expect(r.letter).toMatch(/is a trial task and no letter is posted/);
    expect(r.letterAgent).toMatch(/is a trial task and no letter is posted/);
    expect(r.letterOrdinary).not.toMatch(/trial/);
    expect(r.diary).toMatch(/is a trial task and no diary entry is made/);
    expect(r.diaryOrdinary).not.toMatch(/trial/);
  });
});
