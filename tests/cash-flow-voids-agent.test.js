// Guards the Cash Flow Voids agent, lane A, in TRIAL (build 2 Oct 2026; chain map and trial mode
// approved by Kevin the same day; map on register row reclaAzGLA4utssxx).
//
// WHAT THIS EXISTS FOR
// The agent drafts late-rent messages to TENANTS. Until Kevin cuts it over, nothing it raises may
// reach anyone. That only holds if all of these stay true at once:
//   1. It is a dispatchable role agent, and scripts/rent-check.py (which raises its tasks) names
//      the same Team Members row and register row as scripts/agent-dispatch.py.
//   2. It is a TRIAL agent (TRIAL_AGENTS in scripts/agent_email_format.py).
//   3. send-email.py refuses a trial agent's card: approved, by rule, or on a preview.
//   4. The dispatch queue never hands an approved trial card to a carry-out run.
//   5. `trial-settle` closes an approved trial card with Kevin's verdict in Notes, and touches
//      nothing else.
//   6. `submit` refuses the shapes that act without send-email.py (Roy handover, diary, payment
//      list, signing, post) from a trial agent.
//   7. The card the agent file tells it to write passes the real submit gates.
// Each check imports or executes the real module, never a copy.
//
// Back-tested (2 Oct 2026) by breaking each rule and watching its case fail:
//   * TRIAL_AGENTS emptied                      -> cases 2, 3, 4, 5 and 6 fail
//   * the refusal removed from load_approved()  -> "refuses an approved trial card" fails
//   * the refusal moved below `if rule:`        -> "refuses a rule send too" fails
//   * the trialChecked branch removed           -> "never becomes a hand-back" fails (it drives the real build_queue)
//   * trial-settle ignoring the outcome         -> "leaves an unapproved trial card alone" fails
//   * TRIAL_ACTING_SHAPE_RE emptied             -> "submit refuses a shape that acts" fails
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
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

function py(snippet, input) {
  const script = `
import importlib.util, json, sys, os, io, contextlib, argparse, tempfile
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
sys.argv = ["test"]
def load_mod(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(SCRIPTS)}, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
ad = load_mod("ad", "agent-dispatch.py")
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
  it('the same card from an agent that is not on trial still sends', () => {
    expect(load({ ...approved, sentForApprovalBy: [PROPERTY_TM] }).refused).toBe('');
  });
});

describe('4. the queue never hands an approved trial card to a carry-out run', () => {
  // The real build_queue, offline: the board read and the register read are faked, and any other
  // network call fails the test rather than reaching Airtable (the tests/standing-holds.test.js harness).
  const queue = (tasks) => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, urllib.request
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
AF = m.AF
recs = []
for t in json.loads(sys.stdin.read()):
    f = {AF["name"]: t["name"], AF["status"]: {"name": "Today"}, AF["teamMember"]: [t["agent"]]}
    if t.get("outcome"):
        f[AF["approvalOutcome"]] = {"name": t["outcome"]}
        f[AF["approvedAt"]] = "2026-10-02T10:00:00.000Z"
        f[AF["sentForApprovalBy"]] = [t["agent"]]
    recs.append({"id": t["id"], "fields": f})
m.query_tasks = lambda formula, **kw: recs
m.fetch_role_roster = lambda: {}
q = m.build_queue()
c = q["counts"]
print(json.dumps({"trialChecked": [x["id"] for x in q["trialChecked"]], "worklist": {x["id"]: x.get("kind") for x in q["worklist"]},
                  "counts": {k: c[k] for k in ("trialChecked", "approvedHandbacks", "changesRequested", "newWork")}}))`],
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
    ]);
    expect(r.trialChecked).toEqual(['recTrialYes', 'recTrialEdit']);
    expect(r.counts).toEqual({ trialChecked: 2, approvedHandbacks: 1, changesRequested: 1, newWork: 1 });
    // The worklist is what a dispatch run works: the two approved trial cards are not on it.
    expect(Object.keys(r.worklist).sort()).toEqual(['recOtherYes', 'recTrialNew', 'recTrialRedo']);
    expect(r.worklist.recOtherYes).toBe('carry_out');
  });
});

describe('5. trial-settle closes an approved trial card with the verdict, and nothing else', () => {
  const settle = (tasks) => py(`
recs = [{"id": t["id"], "fields": {ad.AF["name"]: t["name"], ad.AF["approvalOutcome"]: t["outcome"], ad.AF["notes"]: t.get("notes", ""),
                                    ad.AF["sentForApprovalBy"]: [t["agent"]], ad.AF["teamMember"]: [t["agent"]]}} for t in a]
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
  it('is a real command', () => {
    expect(SRC).toMatch(/"trial-settle": cmd_trial_settle/);
    expect(SRC).toMatch(/sub\.add_parser\("trial-settle"/);
    expect(readFileSync(resolve(ROOT, 'scripts/handback-poll-run.sh'), 'utf8')).toMatch(/agent-dispatch\.py" trial-settle/);
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

  it.skipIf(!existsSync(AGENT_FILE))('the agent file says trial, the sender, the sign-off and the two things it never does', () => {
    const f = readFileSync(AGENT_FILE, 'utf8');
    expect(f).toMatch(/^name: cash-flow-voids$/m);
    expect(f).toContain('FROM: info@agilelets.co.uk');
    expect(f).toContain('Roy Lavin\n   Agile Lets');
    expect(f).toContain('--agent rec7aHLK1Q8fMLRXH');
    expect(f).toMatch(/You are on trial/);
    expect(f).toMatch(/Never contact the DWP/);
    expect(f).toMatch(/Never mention court, eviction, notice/);
    expect(f).toContain("## Decision criteria (Kevin's ruling, 7 Sep 2026)");
    expect(f).toContain('## Lessons from Kevin');
  });
});
