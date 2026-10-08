import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const ESTATE = resolve(ROOT, 'scripts/estate-status.py');

// EVERY WALL GETS A DOOR (Kevin, 7 Oct 2026; PR 2 of 5). Measured 25 Sep to 7 Oct: 39 tasks
// carried an open wall. 19 TOOL walls waited on fixes no fixer could merge (protected files),
// 13 KEVIN walls waited on a step Kevin was never shown (the card left his lane the moment he
// approved it), and the daily dispatch and the half-hourly poll re-checked them all: 235 parks
// and 264 dispatch actions in 14 days, zero progress. These tests drive the real functions
// with Airtable stubbed: every write lands in WRITES, every read comes from TASKS. All names
// are invented (this repo is public).
function py(snippet, env = {}) {
  const script = `
import importlib.util, json, sys, io, contextlib, os
from datetime import datetime, timezone, timedelta
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
AF = m.AF
TASKS, WRITES, LEDGER = {}, [], []
def rec(i, notes="", status="Today", outcome="", name="INSURANCE: Example Lane cover", approved_at="",
        output="Draft: the quote is saved.", feedback="", sent=None, team=None, deferred=None):
    f = {AF["notes"]: notes, AF["status"]: status, AF["approvalOutcome"]: outcome, AF["name"]: name,
         AF["approvedAt"]: approved_at, AF["agentOutput"]: output, AF["approvalFeedback"]: feedback,
         AF["sentForApprovalBy"]: ["recAgentAaaaaaaaa"] if sent is None else sent,
         AF["teamMember"]: ["recAgentAaaaaaaaa"] if team is None else team}
    if deferred:
        f[AF["deferredUntil"]] = deferred
    TASKS[i] = {"id": i, "createdTime": "2026-09-20T09:00:00.000Z", "fields": f}
    return TASKS[i]
def _get(i): return json.loads(json.dumps(TASKS[i]))
def _patch(i, fields):
    WRITES.append({"task": i, "fields": fields})
    TASKS[i]["fields"].update(fields)
m.get_task = _get
m.patch_task = _patch
m.ledger_append = lambda t, e: LEDGER.append([t, e])
m.ledger_last_events = lambda: {}
m.finding_details = lambda: {}
m.load_login_sites = lambda: {}
m.BROWSER_LEDGER = "/nonexistent/od-test-browser-ledger.jsonl"
m.HANDOVER_DIR = "/nonexistent/od-test-handover"
class A:
    def __init__(self, **kw): self.__dict__.update(kw)
def run(fn, args):
    out, err, errout = io.StringIO(), None, io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(errout):
            fn(A(**args))
    except SystemExit as e:
        err = str(e)
    return {"out": out.getvalue(), "err": err, "stderr": errout.getvalue()}
def f(i, k): return TASKS[i]["fields"].get(AF[k])
def notes(i): return f(i, "notes")
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } }).trim().split('\n').pop());
}
const blk = (kind, subject, since, extra = '') =>
  `[x — agent] BLOCKER OPEN (${kind} ${subject}): why Fix: f [since ${since}]${extra}`;

describe('1. a KEVIN wall is a card with a plan', () => {
  it('refuses a new KEVIN wall with no plan file and no --steps, in one line, and writes nothing', () => {
    const r = py(`
rec("t1", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z")
a = run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "signature", "why": "Kevin signs the form.", "finding": None})
print(json.dumps({"err": a["err"], "writes": len(WRITES), "ledger": LEDGER}))`);
    expect(r.err).toMatch(/^ERROR: a KEVIN wall needs a plan: write \/nonexistent\/od-test-handover\/t1\.json .*--steps/);
    expect(r.err.split('\n')).toHaveLength(1);
    expect(r.writes).toBe(0);
    expect(r.ledger).toEqual([]);
  });

  it('accepts numbered written steps, keeps them on the wall line, and refuses steps that are not numbered', () => {
    const r = py(`
rec("t1", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z")
bad = run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "signature", "why": "Kevin signs.", "finding": None, "steps": "sign it and post it"})
ok = run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "signature", "why": "Kevin signs.", "finding": None, "steps": "1. Sign page 3.\\n2. Post it to the council."})
tool = run(m.cmd_block, {"task": "t1", "kind": "TOOL", "subject": "x", "why": "y", "finding": None, "steps": "1. a"})
print(json.dumps({"bad": bad["err"], "ok": ok["err"], "tool": tool["err"], "why": m.task_blocker(notes("t1"))["why"]}))`);
    expect(r.bad).toMatch(/--steps must be numbered written steps/);
    expect(r.ok).toBeNull();
    expect(r.tool).toMatch(/--steps is only for a KEVIN wall/);
    expect(r.why).toBe('Kevin signs. Steps: 1. Sign page 3. 2. Post it to the council.');
  });

  it('accepts a Your turn plan file instead of steps, and the step text comes from the plan', () => {
    const dir = mkdtempSync(tmpdir() + '/od-plan-');
    writeFileSync(dir + '/recPlanTaskAaaaaa.json', JSON.stringify({ why: 'answer the declarations and pay monthly', steps: [] }));
    const r = py(`
m.HANDOVER_DIR = ${JSON.stringify(dir)}
rec("recPlanTaskAaaaaa", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z")
a = run(m.cmd_block, {"task": "recPlanTaskAaaaaa", "kind": "KEVIN", "subject": "purchase", "why": "Kevin buys it.", "finding": None})
print(json.dumps({"err": a["err"], "out": f("recPlanTaskAaaaaa", "agentOutput")}))`);
    expect(r.err).toBeNull();
    expect(r.out).toMatch(/^YOUR STEP: answer the declarations and pay monthly Press Your turn on the AI Agents page, on your Mac/);
  });

  it('before a credential or identity wall it reminds the agent to search the brain and Gmail first', () => {
    const r = py(`
rec("t1", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z"); rec("t2", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z")
c = run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "credential", "why": "Needs the code.", "finding": None, "steps": "1. Find the code."})
p = run(m.cmd_block, {"task": "t2", "kind": "KEVIN", "subject": "payment", "why": "Pay it.", "finding": None, "steps": "1. Pay it."})
print(json.dumps({"c": c["stderr"], "p": p["stderr"]}))`);
    expect(r.c).toMatch(/REMINDER: a credential or identity wall is the last resort/);
    expect(r.c).toMatch(/inbound-triage\.py search --q/);
    expect(r.c).toMatch(/Companies House personal codes, for one, are in Gmail/);
    expect(r.p).not.toMatch(/REMINDER/);
  });

  it('the same wall seen again needs its plan too, unless the wall already carries numbered steps (review round 3)', () => {
    const r = py(`
rec("t1", notes="${blk('KEVIN', 'payment', '2026-09-30T09:00:00.000Z')}", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z")
a = run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "payment", "why": "Kevin pays.", "finding": None})
b = run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "payment", "why": "Kevin pays.", "finding": None, "steps": "1. Pay by transfer."})
rec("t2", notes="[x — agent] BLOCKER OPEN (KEVIN payment): 1. Pay the invoice. 2. Reply to the email. Fix: f [since 2026-09-30T09:00:00.000Z]", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z")
c = run(m.cmd_block, {"task": "t2", "kind": "KEVIN", "subject": "payment", "why": "Kevin pays.", "finding": None})
print(json.dumps({"a": a["err"], "b": b["err"], "c": c["err"], "ledger": LEDGER}))`);
    expect(r.a).toMatch(/^ERROR: a KEVIN wall needs a plan/);
    expect(r.b).toBeNull();
    expect(r.c).toBeNull();                       // its own words are numbered steps
    expect(r.ledger).toEqual([['t1', 'parked'], ['t2', 'parked']]);
  });

  it('a KEVIN ONLY submit needs its plan file or numbered steps on the line, in one line saying what to write', () => {
    const dir = mkdtempSync(tmpdir() + '/od-submitplan-');
    writeFileSync(dir + '/recPlanTaskBbbbbb.json', '{"why": "pay online"}');
    const r = py(`
import tempfile
m.HANDOVER_DIR = ${JSON.stringify(dir)}
m.require_role_agent_live = lambda *a, **k: None
class Reached(Exception): pass
def stop(*a, **k): raise Reached()
m.get_task = stop; m.query_tasks = stop; m.load_login_sites = stop
AGENT = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
def submit(task, text):
    p = os.path.join(tempfile.mkdtemp(), "o.md"); open(p, "w").write(text)
    try:
        return run(m.cmd_submit, {"agent": AGENT, "task": task, "type": "Research", "output_file": p, "tier1": False,
                                   "plain_task": None, "plain_approve": None, "files": [], "receipt": None})["err"]
    except Reached:
        return "REACHED-THE-RECORD"
tail = "\\n\\nReport.\\n\\n**Carrying this out will involve:** saving the quote."
print(json.dumps({"bare": submit("recNoPlanAaaaaaaa", "KEVIN ONLY: signature: sign the form" + tail),
                  "steps": submit("recNoPlanAaaaaaaa", "KEVIN ONLY: signature: 1. Sign page 3. 2. Post it." + tail),
                  "plan": submit("recPlanTaskBbbbbb", "KEVIN ONLY: payment: pay online" + tail)}))`);
    expect(r.bare).toMatch(/^ERROR: refusing to submit recNoPlanAaaaaaaa: its KEVIN ONLY step has no plan\. Write .*recNoPlanAaaaaaaa\.json .*KEVIN ONLY: signature: 1\. /);
    expect(r.bare.split('\n')).toHaveLength(1);
    expect(r.steps).toBe('REACHED-THE-RECORD');
    expect(r.plan).toBe('REACHED-THE-RECORD');
  });

  it('a KEVIN wall on work Kevin has not approved is refused: it would have no door (review, 7 Oct 2026)', () => {
    const r = py(`
rec("new")
rec("redo", outcome="Changes requested", approved_at="2026-10-01T09:00:00.000Z", notes="${blk('KEVIN', 'payment', '2026-09-30T09:00:00.000Z')}")
a = run(m.cmd_block, {"task": "new", "kind": "KEVIN", "subject": "payment", "why": "Pay.", "finding": None, "steps": "1. Pay."})
b = run(m.cmd_block, {"task": "redo", "kind": "KEVIN", "subject": "payment", "why": "Pay.", "finding": None})
print(json.dumps({"a": a["err"], "b": b["err"], "writes": len(WRITES), "ledger": LEDGER}))`);
    expect(r.a).toMatch(/^ERROR: new is not approved, so a KEVIN wall would leave it with no way back\..*KEVIN ONLY: /);
    expect(r.b).toMatch(/^ERROR: redo is not approved/);
    expect(r.writes).toBe(0);
    expect(r.ledger).toEqual([]);   // never parked: the next slot works it, and the agent submits a card
  });

  it('a KEVIN wall left on unapproved work from before keeps the day clock, so it can never rest for ever', () => {
    const r = py(`
now = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)
t = {"outcome": "", "approvedAt": "", "notes": "${blk('KEVIN', 'payment', '2026-10-01T09:00:00.000Z')}"}
s = dict(t, notes="${blk('SITE', 'example-portal.test', '2026-10-01T09:00:00.000Z')}")
print(json.dumps([m.blocked_rest(t, ("parked", "2026-10-07T09:00:00.000Z"), now), m.blocked_rest(t, ("parked", "2026-10-05T09:00:00.000Z"), now),
                  m.blocked_rest(s, ("parked", "2026-10-05T09:00:00.000Z"), now)]))`);
    expect(r[0]).toMatch(/rests until the wall clears/);
    expect(r[1]).toBe('');
    expect(r[2]).toMatch(/rests until the wall clears/);   // a SITE wall has a door: no clock
  });
});

describe('2. the KEVIN card returns to his lane as Your step', () => {
  it('on an approved task: Status Approval, verdict kept, YOUR STEP on top, original below the divider, knock-back cleared, one write', () => {
    const r = py(`
rec("t1", status="Today", outcome="Approved with minor edits", approved_at="2026-10-01T09:00:00.000Z",
    output="Quote ready: Example Insurer, 41 a month.", deferred="2026-10-30")
a = run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "purchase", "why": "Kevin buys.", "finding": None, "steps": "1. Open the saved quote.\\n2. Pay monthly."})
print(json.dumps({"err": a["err"], "out": json.loads(a["out"]), "status": f("t1", "status"), "outcome": f("t1", "approvalOutcome"),
                  "approvedAt": f("t1", "approvedAt"), "deferred": f("t1", "deferredUntil"), "output": f("t1", "agentOutput"),
                  "writes": len(WRITES), "split": m.your_step_split(f("t1", "agentOutput"))}))`);
    expect(r.err).toBeNull();
    expect(r.out.yourStep).toBe(true);
    expect(r.status).toBe('Approval');
    expect(r.outcome).toBe('Approved with minor edits');
    expect(r.approvedAt).toBe('2026-10-01T09:00:00.000Z');
    expect(r.deferred).toBeNull();
    expect(r.output).toBe("YOUR STEP: 1. Open the saved quote.\n2. Pay monthly.\n\n----- The agent's work, as you approved it -----\n\nQuote ready: Example Insurer, 41 a month.");
    expect(r.split).toEqual(['1. Open the saved quote.\n2. Pay monthly.', 'Quote ready: Example Insurer, 41 a month.']);
    expect(r.writes).toBe(1);   // the wall and the move in the same write
  });

  it('the round trip gives back the output byte for byte, blank lines and trailing spaces included', () => {
    const r = py(`
orig = "\\n\\nLine one.\\n\\n  indented  \\n"
w = m.your_step_output("1. Pay.", orig)
print(json.dumps([m.your_step_split(w)[1] == orig, m.your_step_split(m.your_step_output("2. Sign.", w))[1] == orig,
                  m.your_step_split(m.your_step_output("2. Sign.", w))[0]]))`);
    expect(r).toEqual([true, true, '2. Sign.']);
  });

  it('an approved task with no agent link at all is left where it is: Status Approval would hide it everywhere', () => {
    const r = py(`
rec("t1", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z", sent=[], team=[])
a = run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "payment", "why": "Pay.", "finding": None, "steps": "1. Pay."})
print(json.dumps([a["err"], f("t1", "status"), f("t1", "agentOutput"), m.task_blocker(notes("t1"))["kind"]]))`);
    expect(r).toEqual([null, 'Today', 'Draft: the quote is saved.', 'KEVIN']);
  });

  it('an approved task with no Sent For Approval By gets one from its Team Member, or the queue would hide the card', () => {
    const r = py(`
rec("t1", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z", sent=[])
run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "payment", "why": "Pay.", "finding": None, "steps": "1. Pay."})
print(json.dumps(f("t1", "sentForApprovalBy")))`);
    expect(r).toEqual(['recAgentAaaaaaaaa']);
  });

  it('a decision card is never wrapped: its DECIDE: first line is what the board reads', () => {
    const r = py(`
rec("t1", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z", output="DECIDE: which policy?")
run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "payment", "why": "Pay.", "finding": None, "steps": "1. Pay."})
print(json.dumps([f("t1", "status"), f("t1", "agentOutput")]))`);
    expect(r).toEqual(['Today', 'DECIDE: which policy?']);
  });

  it('the agent re-blocking (or trying to close) an approved task on a submit-time wall moves it, once, never wrapped twice', () => {
    const r = py(`
rec("t1", notes="${blk('KEVIN', 'signature', '2026-09-30T09:00:00.000Z')}", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z")
a = run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "signature", "why": "Sign.", "finding": None, "steps": "1. Sign it."})
first = f("t1", "agentOutput")
b = run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "signature", "why": "Sign.", "finding": None, "steps": "1. Sign it."})
rec("t2", notes="${blk('KEVIN', 'payment', '2026-09-30T09:00:00.000Z')}", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z")
c = run(m.cmd_complete, {"task": "t2", "keep_open": False, "note": None})
print(json.dumps({"a": json.loads(a["out"]), "status": f("t1", "status"), "same": first == f("t1", "agentOutput"),
                  "count": f("t1", "agentOutput").count("YOUR STEP:"), "c": c["err"], "status2": f("t2", "status"),
                  "ledger": LEDGER}))`);
    expect(r.a.already).toBe(true);
    expect(r.a.yourStep).toBe(true);
    expect(r.status).toBe('Approval');
    expect(r.same).toBe(true);
    expect(r.count).toBe(1);
    expect(r.c).toMatch(/refusing to complete t2: it is blocked[\s\S]*back in Kevin's approval queue as Your step/);
    expect(r.status2).toBe('Approval');
    expect(r.ledger).toEqual([['t1', 'parked'], ['t1', 'parked'], ['t2', 'parked']]);
  });

  it('when the wall clears the card leaves his lane: Status Today, the output as he approved it, and his done line taken out', () => {
    const r = py(`
out = m.your_step_output("1. Pay.", "Invoice 77 drafted.")
rec("t1", notes="${blk('KEVIN', 'payment', '2026-10-01T09:00:00.000Z')}", status="Approval", outcome="Approved with minor edits",
    approved_at="2026-10-01T08:00:00.000Z", output=out,
    feedback="Use the business account.\\nKEVIN STEP DONE [2026-10-02T10:00:00.000Z]: paid, ref EX-12")
b = m.task_blocker(notes("t1"))
m.wake_blocked("t1", b, "Kevin says the step is done: paid, ref EX-12", by="Kevin")
print(json.dumps({"status": f("t1", "status"), "out": f("t1", "agentOutput"), "fb": f("t1", "approvalFeedback"),
                  "outcome": f("t1", "approvalOutcome"), "blk": m.task_blocker(notes("t1")), "ledger": LEDGER,
                  "writes": len(WRITES)}))`);
    expect(r.status).toBe('Today');
    expect(r.out).toBe('Invoice 77 drafted.');
    expect(r.fb).toBe('Use the business account.');   // his edit note survives; the done line does not
    expect(r.outcome).toBe('Approved with minor edits');
    expect(r.blk).toBeNull();
    expect(r.ledger).toEqual([['t1', 'unblocked']]);
    expect(r.writes).toBe(1);
  });

  it('complete still refuses while the wall is open', () => {
    const r = py(`
rec("t1", notes="${blk('KEVIN', 'payment', '2026-10-01T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-01T08:00:00.000Z", output=m.your_step_output("1. Pay.", "x"))
c = run(m.cmd_complete, {"task": "t1", "keep_open": False, "note": None})
print(json.dumps([c["err"], f("t1", "status")]))`);
    expect(r[0]).toMatch(/refusing to complete t1: it is blocked \(KEVIN payment/);
    expect(r[1]).toBe('Approval');
  });
});

describe("2b. the sweep reads Kevin's \"Done, here is the proof\" and surfaces walls nobody moved", () => {
  const setup = `
NOW = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)
def q(formula, max_records=None, minimal=False):
    if formula.startswith("NOT("):
        return [{"id": "ctl", "fields": {}}]
    want_done = formula.startswith("AND({Status}='Completed'")
    if formula.startswith("LEFT({Task Name}"):
        return []
    return [json.loads(json.dumps(t)) for t in TASKS.values() if (t["fields"][AF["status"]] == "Completed") == want_done]
m.query_tasks = q
m.finding_states = lambda: {}
STEP = m.your_step_output("1. Sign page 3.", "The form is ready.")
`;

  it('a done line written after the wall opened wakes it in the same sweep; one before it, or with no words, does not', () => {
    const r = py(setup + `
rec("fresh", notes="${blk('KEVIN', 'signature', '2026-10-05T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-04T09:00:00.000Z", output=STEP, feedback="KEVIN STEP DONE [2026-10-06T10:00:00.000Z]: signed and posted, recorded delivery EX123")
rec("stale", notes="${blk('KEVIN', 'signature', '2026-10-05T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-04T09:00:00.000Z", output=STEP, feedback="KEVIN STEP DONE [2026-10-01T10:00:00.000Z]: signed the old form")
rec("empty", notes="${blk('KEVIN', 'signature', '2026-10-05T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-04T09:00:00.000Z", output=STEP, feedback="KEVIN STEP DONE [2026-10-06T10:00:00.000Z]:   ")
rec("nosince", notes="[x — agent] BLOCKER OPEN (KEVIN signature): why Fix: f", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-04T09:00:00.000Z", output=STEP, feedback="KEVIN STEP DONE [2026-10-06T10:00:00.000Z]: signed it")
dry = m.blockers_scan(sweep=False, now=NOW)
dry_rows = {w["task"]: [w["clearsNow"], w.get("doneSaid")] for w in dry["open"]}
writes_dry = len(WRITES)
res = m.blockers_scan(sweep=True, now=NOW)
print(json.dumps({"dry": dry_rows, "writesDry": writes_dry, "woken": sorted(w["task"] for w in res["woken"]),
                  "still": sorted(w["task"] for w in res["open"]), "fresh": [f("fresh", "status"), f("fresh", "agentOutput"), f("fresh", "approvalFeedback")],
                  "note": notes("fresh").split("\\n\\n")[-1]}))`);
    expect(r.dry.fresh).toEqual([true, 'signed and posted, recorded delivery EX123']);
    expect(r.dry.stale[0]).toBe(false);
    expect(r.dry.empty[0]).toBe(false);
    expect(r.dry.nosince[0]).toBe(true);     // a wall with no since takes any done line
    expect(r.writesDry).toBe(0);
    expect(r.woken).toEqual(['fresh', 'nosince']);
    expect(r.still).toEqual(['empty', 'stale']);
    expect(r.fresh).toEqual(['Today', 'The form is ready.', null]);
    expect(r.note).toMatch(/— Kevin\] BLOCKER CLEARED \(KEVIN signature\): Kevin says the step is done: signed and posted/);
  });

  it('an approved KEVIN wall the agent has parked since his approval is put in his lane; one still owed a carry-out is not', () => {
    const r = py(setup + `
rec("parked", notes="${blk('KEVIN', 'purchase', '2026-09-30T09:00:00.000Z')}", status="Today", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z")
rec("fresh", notes="${blk('KEVIN', 'purchase', '2026-09-30T09:00:00.000Z')}", status="Today", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z")
rec("after", notes="${blk('KEVIN', 'identity', '2026-10-02T09:00:00.000Z')}", status="Today", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z")
rec("draft", notes="${blk('KEVIN', 'payment', '2026-10-02T09:00:00.000Z')}", status="Today")
m.ledger_last_events = lambda: {"parked": ("parked", "2026-10-03T09:00:00.000Z"), "fresh": ("parked", "2026-09-30T09:00:00.000Z"),
                                "draft": ("parked", "2026-10-03T09:00:00.000Z")}
res = m.blockers_scan(sweep=True, now=NOW)
rows = {w["task"]: [w.get("yourStep"), w.get("step")] for w in res["open"]}
print(json.dumps({"surfaced": sorted(s["task"] for s in res["surfaced"]), "rows": rows,
                  "status": {k: f(k, "status") for k in ("parked", "fresh", "after", "draft")}}))`);
    expect(r.surfaced).toEqual(['after', 'parked']);
    expect(r.status).toEqual({ parked: 'Approval', fresh: 'Today', after: 'Approval', draft: 'Today' });
    expect(r.rows.parked[0]).toBe(true);
    expect(r.rows.parked[1]).toBe('why');                 // the wall's own words when no plan or steps
    expect(r.rows.fresh).toEqual([false, 'why']);
  });

  it('a Your step card approved again from an out-of-date tab goes straight back to his lane, with no carry-out first', () => {
    // 7 Oct 2026: a tab opened before Your step shipped showed the card with Approve. Each approval
    // wrote Status Today and a new Approved At over the YOUR STEP block, so the agent was "owed" a
    // carry-out, a hand-back run met the same wall, and the card came back an hour later. Shaped
    // from a payment card approved three times that day; every name, date and figure is invented.
    const r = py(setup + `
rec("again", notes="${blk('KEVIN', 'payment', '2026-09-26T08:15:00.000Z')}", status="Today", outcome="Approved as-is",
    approved_at="2026-10-07T13:41:05.120Z", output=m.your_step_output("1. Pay the 60 EUR toll by card.", "Draft: the toll is due by 12 Nov."))
rec("owed", notes="${blk('KEVIN', 'payment', '2026-09-26T08:15:00.000Z')}", status="Today", outcome="Approved as-is",
    approved_at="2026-10-07T13:41:05.120Z", output="Draft: the toll is due by 12 Nov.")
m.ledger_last_events = lambda: {"again": ("parked", "2026-10-07T08:00:00.000Z"), "owed": ("parked", "2026-10-07T08:00:00.000Z")}
res = m.blockers_scan(sweep=True, now=NOW)
print(json.dumps({"surfaced": sorted(s["task"] for s in res["surfaced"]),
                  "again": [f("again", "status"), f("again", "approvalOutcome"), f("again", "approvedAt"), m.your_step_split(f("again", "agentOutput"))],
                  "owed": f("owed", "status")}))`);
    expect(r.surfaced).toEqual(['again']);
    // The step is written from the wall again (its words here are "why"), and there is one block, never two.
    expect(r.again).toEqual(['Approval', 'Approved as-is', '2026-10-07T13:41:05.120Z', ['why', 'Draft: the toll is due by 12 Nov.']]);
    // The control: the same wall and verdict without the block is a fresh approval, owed its carry-out.
    expect(r.owed).toBe('Today');
  });

  it('a Your turn plan the window would refuse shows no button, and its agent gets ONE repair task (8 Oct 2026)', () => {
    // The 8 Oct shape: a hand-written plan whose last Kevin step had no "until", so Your turn opened
    // nothing but "BROWSER REFUSED". The check is agent-browser.js's own, run through node.
    const dir = mkdtempSync(tmpdir() + '/od-plans-');
    const good = { label: 'Example cover', site: 'acrobat.adobe.com', why: 'Kevin signs.', sources: 'Invented for a test.',
      steps: [{ do: 'goto', url: 'https://acrobat.adobe.com/link/documents/agreements/' },
              { do: 'kevin', say: 'Sign the document, then press Submit.', untilText: 'successfully signed', minutes: 5 }] };
    const bad = JSON.parse(JSON.stringify(good)); delete bad.steps[1].untilText;
    writeFileSync(dir + '/recPlanGoodAaaaaa.json', JSON.stringify(good));
    writeFileSync(dir + '/recPlanBadAaaaaaa.json', JSON.stringify(bad));
    const r = py(setup + `
m.HANDOVER_DIR = ${JSON.stringify(dir)}
m.STATE_DIR = ${JSON.stringify(dir)}
CREATED = []
class Gate:
    def cmd_create(self, fields, force=False):
        CREATED.append([fields, force]); print(json.dumps({"action": "created", "taskId": "recRepairAaaaaaaa"})); return 0
m._gate = lambda: Gate()
OPEN_REPAIRS = []
base_q = m.query_tasks
m.query_tasks = lambda formula, max_records=None, minimal=False: (list(OPEN_REPAIRS) if formula.startswith("AND({Task Name}=")
                                                                 else base_q(formula, max_records, minimal))
for i in ("recPlanGoodAaaaaa", "recPlanBadAaaaaaa"):
    rec(i, notes="${blk('KEVIN', 'signature', '2026-10-05T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
        approved_at="2026-10-04T09:00:00.000Z", output=STEP, name="TENANCY: Example Lane agreement " + i[-6:])
dry = m.blockers_scan(sweep=False, now=NOW)
made_dry = len(CREATED)
one = m.blockers_scan(sweep=True, now=NOW)
OPEN_REPAIRS.append({"id": "recRepairAaaaaaaa", "fields": {}})
two = m.blockers_scan(sweep=True, now=NOW + timedelta(days=5))          # one open: never a second
OPEN_REPAIRS.clear()
three = m.blockers_scan(sweep=True, now=NOW + timedelta(days=1))        # closed, same plan, inside the clock
four = m.blockers_scan(sweep=True, now=NOW + timedelta(days=4))         # closed, same plan, past the clock
rows = {w["task"]: [w.get("turn"), w.get("planProblem")] for w in one["open"]}
print(json.dumps({"rows": rows, "dry": made_dry, "repairs": [len(x["planRepairs"]) for x in (one, two, three, four)],
                  "first": one["planRepairs"],
                  "created": [[f[AF["name"]], f[AF["teamMember"]], f[AF["status"]], force] for f, force in CREATED],
                  "desc": CREATED[0][0][AF["description"]] if CREATED else ""}))`);
    expect(r.rows.recPlanGoodAaaaaa).toEqual([true, null]);
    expect(r.rows.recPlanBadAaaaaaa[0]).toBeFalsy();
    expect(r.rows.recPlanBadAaaaaaa[1]).toMatch(/step 2 \(kevin\) needs "say" and one of untilUrl/);
    expect(r.dry).toBe(0);                                   // a read-only scan raises nothing
    expect(r.first).toEqual([{ task: 'recPlanBadAaaaaaa', repair: 'recRepairAaaaaaaa', action: 'created' }]);
    expect(r.repairs).toEqual([1, 0, 0, 1]);                // open: never twice; closed: again only after 3 days
    // No "repair" word (the gate's maintenance lane would fold it away), created straight: this is its own check.
    // The fixture's card is linked to no real agent, so the AI CEO gets it, never a person.
    expect(r.created[0]).toEqual(['YOUR TURN PLAN REFUSED: TENANCY: Example Lane agreement aaaaaa', ['reciHUAEcEkbctnZ6'], 'Today', true]);
    expect(r.desc).toMatch(/--dry-run --shot/);
  });

  it('a done line the sweep cannot take comes out with a note, so the box comes back', () => {
    const r = py(setup + `
rec("stale", notes="${blk('KEVIN', 'signature', '2026-10-05T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-04T09:00:00.000Z", output=STEP, feedback="Keep it short.\\nKEVIN STEP DONE [2026-10-01T10:00:00.000Z]: signed the old form")
res = m.blockers_scan(sweep=True, now=NOW)
print(json.dumps({"refused": [x["task"] for x in res["doneRefused"]], "fb": f("stale", "approvalFeedback"),
                  "note": notes("stale").split("\\n\\n")[-1], "status": f("stale", "status"), "woken": res["woken"]}))`);
    expect(r.refused).toEqual(['stale']);
    expect(r.fb).toBe('Keep it short.');
    expect(r.note).toMatch(/Kevin's done line was not used: it was written before this wall opened/);
    expect(r.status).toBe('Approval');
    expect(r.woken).toEqual([]);
  });

  // "I CAN'T DO THIS" (Kevin, 8 Oct 2026): a Your step card had two exits, done or a knock-back,
  // so a step he could not take (a portal that opens on a login he has no account for) waited on
  // him for ever. His reason sends the task back to its agent as Changes requested.
  it("a can't line sends the task back as Changes requested with his reason, the wall cleared", () => {
    const r = py(setup + `
CANT = "KEVIN STEP CANT [2026-10-06T10:00:00.000Z]: Your turn opens a login page and we have no account"
rec("cant", notes="${blk('KEVIN', 'identity', '2026-10-05T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-04T09:00:00.000Z", output=STEP, feedback="Use the business card.\\n" + CANT, deferred="2026-10-20")
rec("stale", notes="${blk('KEVIN', 'identity', '2026-10-05T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-04T09:00:00.000Z", output=STEP, feedback="KEVIN STEP CANT [2026-10-01T10:00:00.000Z]: no account")
rec("empty", notes="${blk('KEVIN', 'identity', '2026-10-05T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-04T09:00:00.000Z", output=STEP, feedback="KEVIN STEP CANT [2026-10-06T10:00:00.000Z]:   ")
rec("cantlast", notes="${blk('KEVIN', 'identity', '2026-10-05T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-04T09:00:00.000Z", output=STEP,
    feedback="KEVIN STEP DONE [2026-10-06T10:00:00.000Z]: signed it\\nKEVIN STEP CANT [2026-10-06T11:00:00.000Z]: the form wants a director")
rec("donelast", notes="${blk('KEVIN', 'identity', '2026-10-05T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-04T09:00:00.000Z", output=STEP,
    feedback="KEVIN STEP CANT [2026-10-06T10:00:00.000Z]: no account\\nKEVIN STEP DONE [2026-10-06T11:00:00.000Z]: made one and sent it")
dry = m.blockers_scan(sweep=False, now=NOW)
dry_rows = {w["task"]: [w.get("cantSaid"), w.get("doneSaid")] for w in dry["open"]}
writes_dry = len(WRITES)
res = m.blockers_scan(sweep=True, now=NOW)
LEDGER_NOW = {t: ("unblocked", "2026-10-07T12:00:00.000Z") for t, e in LEDGER if e == "unblocked"}
view = m.task_view(TASKS["cant"])
print(json.dumps({"dry": dry_rows, "writesDry": writes_dry,
                  "sentBack": sorted(x["task"] for x in res["sentBack"]), "woken": sorted(x["task"] for x in res["woken"]),
                  "refused": sorted(x["task"] for x in res["doneRefused"]),
                  "cant": [f("cant", k) for k in ("status", "approvalOutcome", "approvedAt", "approvalFeedback", "agentOutput", "deferredUntil")],
                  "due": f("cant", "dueDate") == m.today_london(),
                  "note": notes("cant").split("\\n\\n")[-1], "wall": m.task_blocker(notes("cant")),
                  "rest": m.blocked_rest(view, LEDGER_NOW.get("cant")), "ledger": [x for x in LEDGER if x[0] == "cant"],
                  "cantlast": [f("cantlast", "approvalOutcome"), f("cantlast", "approvalFeedback")],
                  "donelast": [f("donelast", "approvalOutcome"), f("donelast", "status"), f("donelast", "approvalFeedback")],
                  "stale": [f("stale", "approvalFeedback"), f("stale", "approvalOutcome"), f("stale", "status")]}))`);
    expect(r.dry.cant).toEqual(['Your turn opens a login page and we have no account', null]);
    expect(r.dry.cantlast).toEqual(['the form wants a director', null]);
    expect(r.dry.donelast).toEqual([null, 'made one and sent it']);
    expect(r.dry.stale[0]).toBeNull();
    expect(r.writesDry).toBe(0);
    expect(r.sentBack).toEqual(['cant', 'cantlast']);
    expect(r.woken).toEqual(['donelast']);
    expect(r.refused).toEqual(['empty', 'stale']);
    expect(r.cant).toEqual(['Today', 'Changes requested', '2026-10-06T10:00:00.000Z',
      "I can't do this step: Your turn opens a login page and we have no account", 'The form is ready.', null]);
    expect(r.due).toBe(true);
    expect(r.note).toMatch(/— Kevin\] BLOCKER CLEARED \(KEVIN identity\): Kevin cannot take this step: Your turn opens a login page and we have no account\. Sent back to you as Changes requested/);
    expect(r.wall).toBeNull();
    expect(r.rest).toBe('');
    expect(r.ledger).toEqual([['cant', 'unblocked']]);
    expect(r.cantlast).toEqual(['Changes requested', "I can't do this step: the form wants a director"]);
    expect(r.donelast).toEqual(['Approved as-is', 'Today', null]);
    expect(r.stale).toEqual([null, 'Approved as-is', 'Approval']);
  });

  it("a can't retires the task's Your turn plan, so a later wall cannot bring back the same button", () => {
    const dir = mkdtempSync(tmpdir() + '/od-cant-plan-');
    writeFileSync(dir + '/recCantPlanAaaaaa.json', JSON.stringify({ why: 'log in to the example portal and pay', steps: [] }));
    const r = py(setup + `
import os
m.HANDOVER_DIR = ${JSON.stringify(dir)}
rec("recCantPlanAaaaaa", notes="${blk('KEVIN', 'identity', '2026-10-05T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-04T09:00:00.000Z", output=STEP, feedback="KEVIN STEP CANT [2026-10-06T10:00:00.000Z]: we have no account")
res = m.blockers_scan(sweep=True, now=NOW)
left = sorted(os.listdir(m.HANDOVER_DIR))
print(json.dumps({"sent": res["sentBack"], "left": left, "plan": m.handover_plan("recCantPlanAaaaaa"),
                  "missing": m.kevin_plan_missing("recCantPlanAaaaaa"), "note": notes("recCantPlanAaaaaa").split("\\n\\n")[-1]}))`);
    expect(r.sent.map((x) => [x.task, x.planRetired])).toEqual([['recCantPlanAaaaaa', true]]);
    expect(r.left).toHaveLength(1);
    expect(r.left[0]).toMatch(/^recCantPlanAaaaaa\.json\.cant-\d{12}$/);
    expect(r.plan).toBeNull();
    expect(r.missing).toBe(true);      // a new KEVIN wall needs a new plan or written steps
    expect(r.note).toMatch(/The old Your turn plan is retired to .*recCantPlanAaaaaa\.json\.cant-\d{12}\./);
  });

  it("a long reason is sent back whole, so the resubmit's archive never stamps a second can't line", () => {
    const r = py(setup + `
long = "the portal wants an account " + "and a director's code " * 60
hist = "[2026-10-06 10:00] I can't do this step: " + " ".join(long.split())
rec("t1", notes="${blk('KEVIN', 'identity', '2026-10-05T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-04T09:00:00.000Z", output=STEP, feedback="KEVIN STEP CANT [2026-10-06T10:00:00.000Z]: " + long)
res = m.blockers_scan(sweep=True, now=NOW)
fb = f("t1", "approvalFeedback")
print(json.dumps({"sent": [x["task"] for x in res["sentBack"]], "len": len(long), "whole": fb == "I can't do this step: " + " ".join(long.split()),
                  "archived": m.feedback_archived(hist, fb)}))`);
    expect(r.sent).toEqual(['t1']);
    expect(r.len).toBeGreaterThan(1000);
    expect(r.whole).toBe(true);
    expect(r.archived).toBe(true);
  });

  it("the send-back decides on a fresh read: a newer done line written since wins, and nothing is written", () => {
    const r = py(setup + `
b = m.task_blocker("${blk('KEVIN', 'identity', '2026-10-05T09:00:00.000Z')}")
rec("t1", notes="${blk('KEVIN', 'identity', '2026-10-05T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-04T09:00:00.000Z", output=STEP,
    feedback="KEVIN STEP CANT [2026-10-06T10:00:00.000Z]: no account\\nKEVIN STEP DONE [2026-10-06T10:30:00.000Z]: made one and sent it")
rec("t2", notes="${blk('KEVIN', 'identity', '2026-10-05T09:00:00.000Z')}", status="Approval", outcome="Approved as-is",
    approved_at="2026-10-04T09:00:00.000Z", output=STEP, feedback="Use the business card.")
print(json.dumps({"t1": m.send_back_blocked("t1", b), "t2": m.send_back_blocked("t2", b), "writes": len(WRITES)}))`);
    expect(r.t1).toBeNull();
    expect(r.t2).toBeNull();
    expect(r.writes).toBe(0);
  });

  it('a task a standing hold covers is never surfaced: the hold parks it and the sweep must not undo that', () => {
    const r = py(setup + `
rec("held", notes="${blk('KEVIN', 'payment', '2026-10-02T09:00:00.000Z')}", status="Upcoming", outcome="Approved as-is",
    approved_at="2026-10-01T09:00:00.000Z", name="COUNCIL TAX: Example District account")
rec("free", notes="${blk('KEVIN', 'payment', '2026-10-02T09:00:00.000Z')}", status="Today", outcome="Approved as-is",
    approved_at="2026-10-01T09:00:00.000Z", name="Pay the Example Water bill")
m.load_standing_holds = lambda: ([{"id": "h1"}], "")
m.standing_holds.hold_for = lambda t, holds: holds[0] if "COUNCIL TAX" in t["name"] else None
res = m.blockers_scan(sweep=True, now=NOW)
m.load_standing_holds = lambda: ([], "holds file unreadable")
rec("free2", notes="${blk('KEVIN', 'payment', '2026-10-02T09:00:00.000Z')}", status="Today", outcome="Approved as-is",
    approved_at="2026-10-01T09:00:00.000Z", name="Pay the Example Gas bill")
res2 = m.blockers_scan(sweep=True, now=NOW)
print(json.dumps({"surfaced": [x["task"] for x in res["surfaced"]], "held": f("held", "status"), "surfaced2": res2["surfaced"],
                  "errors2": res2["readErrors"]}))`);
    expect(r.surfaced).toEqual(['free']);
    expect(r.held).toBe('Upcoming');
    expect(r.surfaced2).toEqual([]);                          // holds unreadable: nothing surfaced blind
    expect(r.errors2).toEqual({ holds: 'holds file unreadable' });
  });

  it('an approved KEVIN wall the sweep cannot surface (a decision card) keeps the day clock, so it is never a wall with no door', () => {
    const r = py(`
now = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)
k = {"outcome": "Approved as-is", "approvedAt": "2026-10-01T09:00:00.000Z", "agentOutput": "DECIDE: which?",
     "notes": "${blk('KEVIN', 'payment', '2026-10-02T09:00:00.000Z')}"}
s = dict(k, notes="${blk('SITE', 'example-portal.test', '2026-10-02T09:00:00.000Z')}")
print(json.dumps([m.idle_handback(k, ("parked", "2026-10-07T09:00:00.000Z"), now), m.idle_handback(k, ("parked", "2026-10-05T09:00:00.000Z"), now),
                  m.idle_handback(s, ("parked", "2026-10-05T09:00:00.000Z"), now)]))`);
    expect(r[0]).toMatch(/rests \d+h more/);
    expect(r[1]).toBe('');                               // a day on: worked again, as before this PR
    expect(r[2]).toMatch(/rests until the wall clears/);  // a wall with a door: no clock
  });

  it('a MERGE card can be neither blocked nor reassigned', () => {
    const r = py(`
rec("mc", status="Approval", name="MERGE: PR #812 — fix", outcome="Approved as-is", approved_at="2026-10-07T09:00:00.000Z")
a = run(m.cmd_block, {"task": "mc", "kind": "KEVIN", "subject": "payment", "why": "x", "finding": None, "steps": "1. x"})
b = run(m.cmd_reassign, {"task": "mc", "reason": "x"})
print(json.dumps([a["err"], b["err"], len(WRITES)]))`);
    expect(r[0]).toMatch(/is a MERGE card/);
    expect(r[1]).toMatch(/refusing to reassign mc: it is a MERGE card/);
    expect(r[2]).toBe(0);
  });

  it('a ledger that cannot be read is said, never read as "nothing parked"', () => {
    const r = py(setup + `
rec("parked", notes="${blk('KEVIN', 'purchase', '2026-09-30T09:00:00.000Z')}", status="Today", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z")
def boom(): raise OSError("ledger unreadable")
m.ledger_last_events = boom
res = m.blockers_scan(sweep=True, now=NOW)
print(json.dumps(res["readErrors"]))`);
    expect(r).toEqual({ ledger: 'ledger unreadable' });
  });
});

describe('2c. a Your step card and a MERGE card are not anyone else\'s to rewrite (review, 7 Oct 2026)', () => {
  it('held_card_problem names both; handover and escalate refuse them; a plain task passes', () => {
    const r = py(`
step = m.your_step_output("1. Pay.", "Invoice drafted.")
rec("ys", status="Approval", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z", output=step,
    notes="${blk('KEVIN', 'payment', '2026-10-02T09:00:00.000Z')}")
rec("mc", status="Approval", name="MERGE: PR #812 — fix: retype", output="MERGE CARD: PR #812, fix")
rec("plain")
m.HUMANS = {"roy": {"email": "roy@example.test", "name": "Roy"}}
h1 = run(m.cmd_handover, {"task": "ys", "to": "roy", "reason": "x"})
h2 = run(m.cmd_handover, {"task": "mc", "to": "roy", "reason": "x"})
e1 = run(m.cmd_escalate, {"task": "mc", "reason": "x"})
print(json.dumps({"ys": m.held_card_problem(TASKS["ys"]["fields"]), "mc": m.held_card_problem(TASKS["mc"]["fields"]),
                  "plain": m.held_card_problem(TASKS["plain"]["fields"]), "h1": h1["err"], "h2": h2["err"], "e1": e1["err"],
                  "writes": len(WRITES)}))`);
    expect(r.ys).toMatch(/in Kevin's approval queue as Your step/);
    expect(r.mc).toMatch(/it is a MERGE card/);
    expect(r.plain).toBe('');
    expect(r.h1).toMatch(/^ERROR: refusing to hand over ys: it is in Kevin's approval queue as Your step/);
    expect(r.h2).toMatch(/^ERROR: refusing to hand over mc: it is a MERGE card/);
    expect(r.e1).toMatch(/^REFUSED: mc is not a decision for Kevin: it is a MERGE card/);
    expect(r.writes).toBe(0);
  });

  it('a MERGE card closes only with its merge commit as evidence', () => {
    const r = py(`
rec("mc", status="Today", outcome="Approved as-is", approved_at="2026-10-07T09:00:00.000Z", name="MERGE: PR #812 — fix: retype")
m.task_owes_certificate = lambda *a, **k: ""
a = run(m.cmd_complete, {"task": "mc", "keep_open": False, "note": None, "evidence": "looked fine"})
b = run(m.cmd_complete, {"task": "mc", "keep_open": False, "note": None, "evidence": "PR #81 merged as abc1234def"})
c = run(m.cmd_complete, {"task": "mc", "keep_open": False, "note": None, "evidence": "PR #812 merged as abc1234def (green). Deploy: live."})
print(json.dumps([a["err"], b["err"], c["err"], f("mc", "status"), notes("mc").split("\\n\\n")[-1]]))`);
    expect(r[0]).toMatch(/it is the MERGE card for PR #812, and it closes only when that PR has merged/);
    expect(r[1]).toMatch(/it is the MERGE card for PR #812/);   // another PR's merge is not this one's
    expect(r[2]).toBeNull();
    expect(r[3]).toBe('Completed');
    expect(r[4]).toMatch(/DONE, evidence: PR #812 merged as abc1234def/);
  });

  it('a SIGN-IN NEEDED line inside the approved work under a Your step is never a sign-in wait', () => {
    const r = py(`
step = m.your_step_output("1. Pay.", "Draft.\\nSIGN-IN NEEDED: Example Portal (https://portal.example.test/login)")
rec("ys", status="Approval", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z", output=step)
rec("wait", status="Approval", output="Draft.\\nSIGN-IN NEEDED: Example Portal (https://portal.example.test/login)")
m.query_tasks = lambda formula, **k: [json.loads(json.dumps(TASKS[i])) for i in ("ys", "wait")] if formula.startswith("AND({Status}='Approval'") else []
groups = m.signin_waiting({})
print(json.dumps(sorted(t["id"] for g in groups.values() for t in g["tasks"]) if isinstance(groups, dict) else
                 sorted(t["id"] for g in groups for t in g["tasks"])))`);
    expect(r).toEqual(['wait']);
  });
});

describe('2d. the review of round 3: no sweep writes from a stale read, and no alert sweep touches a held card', () => {
  const setup = `
NOW = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)
def q(formula, max_records=None, minimal=False):
    if formula.startswith("NOT("):
        return [{"id": "ctl", "fields": {}}]
    if formula.startswith("AND({Status}='Completed'") or formula.startswith("LEFT({Task Name}"):
        return []
    return [json.loads(json.dumps(t)) for t in BULK]
m.query_tasks = q
m.finding_states = lambda: {}
`;

  it('a done line Kevin writes after the bulk read is never wiped, and a new wall opened since is never cleared', () => {
    const r = py(setup + `
STEP = m.your_step_output("1. Sign page 3.", "The form is ready.")
OLD = "${blk('KEVIN', 'signature', '2026-10-05T09:00:00.000Z')}"
rec("t1", notes=OLD, status="Approval", outcome="Approved as-is", approved_at="2026-10-04T09:00:00.000Z", output=STEP,
    feedback="KEVIN STEP DONE [2026-10-01T10:00:00.000Z]: signed the old form")
rec("t2", notes=OLD, status="Approval", outcome="Approved as-is", approved_at="2026-10-04T09:00:00.000Z", output=STEP,
    feedback="KEVIN STEP DONE [2026-10-06T10:00:00.000Z]: signed and posted")
BULK = [json.loads(json.dumps(TASKS["t1"])), json.loads(json.dumps(TASKS["t2"]))]
# Between the bulk read and the writes: Kevin writes a fresh proof on t1, and a NEW wall opens on t2.
TASKS["t1"]["fields"][AF["approvalFeedback"]] = "KEVIN STEP DONE [2026-10-07T11:00:00.000Z]: signed the new form, sent EX9"
NEWWALL = "${blk('KEVIN', 'payment', '2026-10-07T11:00:00.000Z')}"
TASKS["t2"]["fields"][AF["notes"]] = OLD + "\\n\\n" + NEWWALL
res = m.blockers_scan(sweep=True, now=NOW)
print(json.dumps({"fb1": f("t1", "approvalFeedback"), "refused": res["doneRefused"], "woken": res["woken"],
                  "wall2": m.task_blocker(notes("t2"))["subject"], "writes": [w["task"] for w in WRITES]}))`);
    expect(r.fb1).toBe('KEVIN STEP DONE [2026-10-07T11:00:00.000Z]: signed the new form, sent EX9');
    expect(r.refused).toEqual([]);
    expect(r.woken).toEqual([]);
    expect(r.wall2).toBe('payment');            // the new wall stands: nothing cleared it
    expect(r.writes).toEqual([]);
  });

  it('a wall surfaced from the bulk read is not written when the task changed since', () => {
    const r = py(setup + `
rec("t1", notes="${blk('KEVIN', 'purchase', '2026-10-02T09:00:00.000Z')}", status="Today", outcome="Approved as-is", approved_at="2026-10-01T09:00:00.000Z")
BULK = [json.loads(json.dumps(TASKS["t1"]))]
m.ledger_last_events = lambda: {"t1": ("parked", "2026-10-03T09:00:00.000Z")}
m.load_standing_holds = lambda: ([], "")
TASKS["t1"]["fields"][AF["notes"]] += "\\n\\n[y — agent] BLOCKER CLEARED (KEVIN purchase): evidence: bought it, policy EX-1."
res = m.blockers_scan(sweep=True, now=NOW)
print(json.dumps({"surfaced": res["surfaced"], "status": f("t1", "status"), "writes": len(WRITES)}))`);
    expect(r.surfaced).toEqual([]);
    expect(r.status).toBe('Today');
    expect(r.writes).toBe(0);
  });

  it('the clear-alerts sweep leaves a MERGE card and a Your step card alone, whatever their names match', () => {
    const r = py(`
step = m.your_step_output("1. Pick the plan.", "Quote: Workers Paid.")
rec("mc", status="Approval", name="MERGE: PR #812 — fix: send-email.py waits out the Gmail quota", outcome="",
    output="MERGE CARD: PR #812, fix")
rec("ys", status="Approval", name="Upgrade the Cloudflare Workers plan", outcome="Approved as-is",
    approved_at="2026-10-01T09:00:00.000Z", output=step)
rec("alert", status="Approval", name="Cloudflare Worker error rate alert")
m.query_tasks = lambda formula, **k: [json.loads(json.dumps(TASKS[i])) for i in ("mc", "ys", "alert")]
res = run(m.cmd_clear_alerts, {"dry_run": False})
out = json.loads(res["out"])
print(json.dumps({"moved": [x["task"] for x in out["items"]], "left": sorted(x["task"] for x in out["leftWithKevin"]),
                  "mc": [f("mc", "status"), f("mc", "sentForApprovalBy")], "ys": [f("ys", "status"), f("ys", "approvalOutcome")]}))`);
    expect(r.left).toEqual(['mc', 'ys']);
    expect(r.mc).toEqual(['Approval', ['recAgentAaaaaaaaa']]);
    expect(r.ys).toEqual(['Approval', 'Approved as-is']);
    expect(r.moved).toEqual(['alert']);          // the control: a real alert still moves
  });
});

describe('4. a TOOL wall says who can clear it', () => {
  it('waiting on a merge card once its card exists; no fixer can reach it (with the protected file) when none does', () => {
    const r = py(`
b = {"kind": "TOOL", "subject": "x", "why": "the runner refuses osascript", "finding": "20261001-agent-dispatch-901", "since": ""}
detail = {"title": "Agent blocked: osascript denied", "where": "scripts/agent-settings.json deny list", "detail": "", "fix": ""}
card = {"pr": 812, "id": "recCard", "status": "Approval", "outcome": "", "findings": ["20261001-agent-dispatch-901"]}
print(json.dumps([
  m.tool_wall_state(b, "open", detail, [card], 5),
  m.tool_wall_state(b, "pending", dict(detail, pr="812"), [dict(card, findings=[])], 5),
  m.tool_wall_state(b, "open", detail, [], 5),
  m.tool_wall_state(b, "deferred", {"title": "Agent blocked: retype", "where": "the robot's own setup"}, [], 1),
  m.tool_wall_state(b, "open", detail, [], 1),
  m.tool_wall_state(b, "", {}, [], 5),
  m.tool_wall_state(dict(b, finding=""), "", {}, [], 5),
  m.tool_wall_state(b, "open", detail, [dict(card, status="Completed", outcome="Rejected")], 5),
  m.tool_wall_state(b, "open", detail, [dict(card, outcome="Approved as-is")], 5),
  m.tool_wall_state(b, "open", detail, [], 5, findings_error="queue unreadable"),
  m.tool_wall_state(b, "open", {"title": "Agent blocked: retype", "where": "the robot's own setup"}, [], 4),
  m.tool_wall_state(b, "open", {"where": "/Users/example/Projects/leadership-dashboard/scripts/agent-settings.json"}, [], 4),
  m.tool_wall_state(b, "open", {"where": "./scripts/agent-dispatch.py"}, [], 4),
  m.tool_wall_state(b, "fixed", detail, [dict(card, status="Completed", outcome="Approved as-is")], 5),
]))`);
    expect(r[0]).toEqual(['merge-card', 'waiting on a merge card (PR #812)']);
    expect(r[1]).toEqual(['merge-card', 'waiting on a merge card (PR #812)']);   // matched by the PR it is pending on
    expect(r[2]).toEqual(['no-fixer', 'no fixer can reach it (protected file: scripts/agent-settings.json)']);
    // Deferred is final: nothing will clear it, protected file named or not (review round 2).
    expect(r[3]).toEqual(['deferred', 'the fixer deferred it, so nothing will clear this wall']);
    expect(r[4]).toEqual(['fixer', 'waiting on the daily robot fix']);           // open under 3 days
    expect(r[5][0]).toBe('no-finding');
    expect(r[6]).toEqual(['no-finding', 'no finding was filed, so nothing will clear this wall']);
    expect(r[7][0]).toBe('merge-rejected');
    expect(r[8][0]).toBe('merge-approved');
    expect(r[9][1]).toMatch(/^the findings queue could not be read/);
    expect(r[10]).toEqual(['unclaimed', 'no fixer has taken it in 4 days']);
    expect(r[11]).toEqual(['no-fixer', 'no fixer can reach it (protected file: scripts/agent-settings.json)']);   // an absolute path
    expect(r[12]).toEqual(['no-fixer', 'no fixer can reach it (protected file: scripts/agent-dispatch.py)']);
    expect(r[13][0]).toBe('merge-closed');          // merged, yet this finding did not land
    expect(r[8][1]).toBe('you approved the merge card for PR #812; the robot is merging it');
  });

  it('the Estate row counts the three kinds separately and the payload carries step, turn and the TOOL state', () => {
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('e', ${JSON.stringify(ESTATE)})
e = importlib.util.module_from_spec(spec); spec.loader.exec_module(e)
s = {"openTasksRead": 1, "woken": [], "closedWhileBlocked": [], "sitesError": "", "findingsError": "", "stale": [], "open": [
  {"task": "a", "name": "n", "kind": "TOOL", "subject": "x", "fix": "f", "days": 5, "findingStatus": "open", "toolState": "merge-card", "tool": "waiting on a merge card (PR #812)", "mergeCard": {"pr": 812}},
  {"task": "b", "name": "n", "kind": "TOOL", "subject": "y", "fix": "f", "days": 5, "findingStatus": "open", "toolState": "no-fixer", "tool": "no fixer can reach it (protected file: scripts/agent-dispatch.py)"},
  {"task": "c", "name": "n", "kind": "TOOL", "subject": "z", "fix": "f", "days": 1, "findingStatus": "open", "toolState": "fixer", "tool": "waiting on the daily robot fix"},
  {"task": "d", "name": "n", "kind": "KEVIN", "subject": "signature", "fix": "f", "days": 1, "findingStatus": "", "step": "1. Sign page 3.", "turn": True, "yourStep": True},
]}
st, detail, payload = e.blockers_summary(s)
print(json.dumps({"detail": detail, "open": payload["open"], "counts": [payload["noFixer"], payload["mergeCard"], payload["dailyFix"]]}))`;
    const r = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
    expect(r.detail).toBe('Robots blocked on 4 tasks. For you: 1 step only you can do (signature); 1 step ready for Your turn on the AI Agents page (your Mac); 1 step in your approval queue as Your step; 1 fix waiting on a merge card in your approval queue (PR #812). 1 task: no fixer can reach it (protected file: scripts/agent-dispatch.py). 1 task waiting on the daily robot fix.');
    expect(r.counts).toEqual([1, 1, 1]);
    const d = r.open.find((w) => w.task === 'd');
    expect(d).toMatchObject({ step: '1. Sign page 3.', turn: true, yourStep: true });
    const b = r.open.find((w) => w.task === 'b');
    expect(b).toMatchObject({ toolState: 'no-fixer', fix: 'no fixer can reach it (protected file: scripts/agent-dispatch.py)' });
  });
});

describe('4b. the row never hides a gap', () => {
  it('unclaimed and open-PR walls are counted on their own, and a failed sweep read makes the row Failed', () => {
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('e', ${JSON.stringify(ESTATE)})
e = importlib.util.module_from_spec(spec); spec.loader.exec_module(e)
s = {"openTasksRead": 1, "woken": [], "closedWhileBlocked": [], "sitesError": "", "findingsError": "", "stale": [], "open": [
  {"task": "a", "name": "n", "kind": "TOOL", "subject": "x", "fix": "f", "days": 4, "findingStatus": "open", "toolState": "unclaimed", "tool": "no fixer has taken it in 4 days"},
  {"task": "b", "name": "n", "kind": "TOOL", "subject": "y", "fix": "f", "days": 4, "findingStatus": "pending", "toolState": "pending", "tool": "waiting on PR #9 to merge"},
]}
ok = e.blockers_summary(s)
bad = e.blockers_summary(dict(s, readErrors={"cards": "HTTP 503"}))
unk = e.blockers_summary(dict(s, open=[{"task": "c", "name": "n", "kind": "TOOL", "subject": "z", "fix": "f", "days": 1, "findingStatus": "open",
                                         "toolState": "unknown", "tool": "the protected-file list could not be read: boom"},
                                        {"task": "d", "name": "n", "kind": "TOOL", "subject": "w", "fix": "f", "days": 1, "findingStatus": "pending",
                                         "toolState": "merge-approved", "tool": "you approved the merge card for PR #9; the robot is merging it"}]))
print(json.dumps({"ok": ok[:2], "bad": bad[:2], "counts": [ok[2]["unclaimed"], ok[2]["openPr"], ok[2]["dailyFix"]], "unk": unk[:2]}))`;
    const r = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
    expect(r.ok).toEqual(['Worked', 'Robots blocked on 2 tasks. 1 task: no fixer has taken the fix in 3 days or more. 1 task waiting on an open fix PR to merge.']);
    expect(r.counts).toEqual([1, 1, 0]);
    expect(r.bad[0]).toBe('Failed');
    expect(r.bad[1]).toMatch(/The sweep could not read: cards: HTTP 503\.$/);
    // A wall the sweep could not judge fails the row and is never "the daily robot fix" (review round 2).
    expect(r.unk[0]).toBe('Failed');
    expect(r.unk[1]).not.toMatch(/daily robot fix/);
    expect(r.unk[1]).toMatch(/c: the protected-file list could not be read: boom/);
    expect(r.unk[1]).toMatch(/1 fix approved by you and being merged by the robot\./);   // not "in your approval queue"
  });
});

describe('4c. the payload keeps every step Kevin needs (review round 3)', () => {
  it('KEVIN walls with a step lead the list, and the list holds 80', () => {
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('e', ${JSON.stringify(ESTATE)})
e = importlib.util.module_from_spec(spec); spec.loader.exec_module(e)
walls = [{"task": "s%d" % i, "name": "n", "kind": "SITE", "subject": "x%d.example.test" % i, "fix": "f", "days": 1, "findingStatus": ""} for i in range(90)]
walls += [{"task": "k1", "name": "n", "kind": "KEVIN", "subject": "payment", "fix": "f", "days": 1, "findingStatus": "", "step": "1. Pay."}]
st, detail, payload = e.blockers_summary({"openTasksRead": 1, "woken": [], "closedWhileBlocked": [], "stale": [], "open": walls})
print(json.dumps([len(payload["open"]), payload["open"][0]["task"]]))`;
    const r = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
    expect(r).toEqual([80, 'k1']);
  });
});

describe('5. a task resting on an open wall is not re-dispatched until the wall clears', () => {
  // The real build_queue, offline: the board read and the register read are faked, any other
  // network call fails the test, and the intent ledger is a scratch file.
  const queue = (prelude) => {
    const dir = mkdtempSync(tmpdir() + '/od-rest-');
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, os, urllib.request
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.STATE_DIR = ${JSON.stringify(dir)}
m.INTENT_LEDGER = os.path.join(${JSON.stringify(dir)}, "carryout-intent.jsonl")
AF = m.AF
AGENT = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
OLD = "[x — agent] BLOCKER OPEN (SITE example-portal.test): why Fix: f [since 2026-09-20T09:00:00.000Z]"
TASKS = {}
def rec(i, notes, outcome="", name="Renew the example portal licence"):
    f = {AF["name"]: name, AF["status"]: {"name": "Today"}, AF["teamMember"]: [AGENT], AF["notes"]: notes}
    if outcome:
        f[AF["approvalOutcome"]] = {"name": outcome}; f[AF["approvedAt"]] = "2026-09-19T09:00:00.000Z"; f[AF["sentForApprovalBy"]] = [AGENT]
    TASKS[i] = {"id": i, "fields": f}
m.query_tasks = lambda formula, **kw: list(TASKS.values())
m.fetch_role_roster = lambda: {}
def ids(): return sorted(t["id"] for t in m.build_queue()["worklist"])
${prelude}
`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json') } });
    return JSON.parse(out.trim().split('\n').pop());
  };

  it('a blocked task parked eighteen days ago is excluded from the worklist, and included the tick after wake_blocked', () => {
    const r = queue(`
rec("recBlockedNewAaaa", OLD)
rec("recBlockedCarryAa", OLD, outcome="Approved as-is")
rec("recFreeWorkAaaaaa", "")
m.ledger_append("recBlockedNewAaaa", "parked")
m.ledger_append("recBlockedCarryAa", "parked")
# Back-date both parks eighteen days: the old day's clock would have woken them.
rows = [json.loads(l) for l in open(m.INTENT_LEDGER)]
for row in rows: row["ts"] = "2026-09-19T10:00:00.000Z"
open(m.INTENT_LEDGER, "w").write("".join(json.dumps(r) + "\\n" for r in rows))
q = m.build_queue()
before = sorted(t["id"] for t in q["worklist"])
idle = sorted(t["id"] for t in q["idleHandbacks"])
# The wall clears (the sweep, a sign-in or unblock): wake_blocked writes "unblocked".
TASKS["recBlockedNewAaaa"]["fields"][AF["notes"]] += "\\n\\n[y — agent-dispatch] BLOCKER CLEARED (SITE example-portal.test): on the list now."
TASKS["recBlockedCarryAa"]["fields"][AF["notes"]] += "\\n\\n[y — agent-dispatch] BLOCKER CLEARED (SITE example-portal.test): on the list now."
m.ledger_append("recBlockedNewAaaa", "unblocked")
m.ledger_append("recBlockedCarryAa", "unblocked")
print(json.dumps({"before": before, "idle": idle, "after": ids()}))`);
    expect(r.before).toEqual(['recFreeWorkAaaaaa']);
    expect(r.idle).toEqual(['recBlockedCarryAa', 'recBlockedNewAaaa']);
    expect(r.after).toEqual(['recBlockedCarryAa', 'recBlockedNewAaaa', 'recFreeWorkAaaaaa']);
  });

  it("Kevin's new verdict still ends the rest, wall or no wall", () => {
    const r = queue(`
rec("recBlockedCarryAa", OLD, outcome="Approved as-is")
m.ledger_append("recBlockedCarryAa", "parked")
rows = [json.loads(l) for l in open(m.INTENT_LEDGER)]
for row in rows: row["ts"] = "2026-09-18T10:00:00.000Z"
open(m.INTENT_LEDGER, "w").write("".join(json.dumps(r) + "\\n" for r in rows))
print(json.dumps({"ids": ids()}))`);
    // approvedAt (19 Sep) is newer than the park (18 Sep): he decided again, so it is worked.
    expect(r.ids).toEqual(['recBlockedCarryAa']);
  });

  it('a verdict on a Your step card is not new work: it rests, named, and never reaches a hand-back run', () => {
    const r = queue(`
KEVIN = "[x — agent] BLOCKER OPEN (KEVIN payment): why Fix: f [since 2026-09-17T09:00:00.000Z]"
rec("recStepAgainAaaaa", KEVIN, outcome="Approved as-is")
TASKS["recStepAgainAaaaa"]["fields"][AF["agentOutput"]] = m.your_step_output("1. Pay it by card.", "Draft: pay the toll.")
rec("recStepOwedAaaaaa", KEVIN, outcome="Approved as-is")
TASKS["recStepOwedAaaaaa"]["fields"][AF["agentOutput"]] = "Draft: pay the toll."
# Approved again WITH words typed then: both pages stamp the note with the verdict's own minute.
rec("recStepNoteAaaaaa", KEVIN, outcome="Approved with minor edits")
TASKS["recStepNoteAaaaaa"]["fields"][AF["agentOutput"]] = m.your_step_output("1. Pay it by card.", "Draft: pay the toll.")
TASKS["recStepNoteAaaaaa"]["fields"][AF["feedbackHistory"]] = "[2026-09-02 10:00] Use the business card.\\n\\n[2026-09-19 09:00] Paid it.\\n\\nRef EX-9 on the receipt."
for i in ("recStepAgainAaaaa", "recStepOwedAaaaaa", "recStepNoteAaaaaa"):
    m.ledger_append(i, "parked")
rows = [json.loads(l) for l in open(m.INTENT_LEDGER)]
for row in rows: row["ts"] = "2026-09-18T10:00:00.000Z"
open(m.INTENT_LEDGER, "w").write("".join(json.dumps(r) + "\\n" for r in rows))
q = m.build_queue()
idle = {t["id"]: t["idleReason"] for t in q["idleHandbacks"]}
print(json.dumps({"work": sorted(t["id"] for t in q["worklist"] + q["reserve"]), "idle": idle}))`);
    // All three were approved (19 Sep) after the park (18 Sep). Owed work: the one without the block,
    // and the one whose approval came with words his agent must read (review, 7 Oct 2026).
    expect(r.work).toEqual(['recStepNoteAaaaaa', 'recStepOwedAaaaaa']);
    expect(Object.keys(r.idle)).toEqual(['recStepAgainAaaaa']);
    expect(r.idle.recStepAgainAaaaa).toMatch(/^waiting on Kevin's own step \(payment\): approved already/);
  });

  it('a MERGE card is never in the worklist, whatever its outcome, and is listed under mergeCards', () => {
    const r = queue(`
rec("recMergeApprovedA", "", outcome="Approved as-is", name="MERGE: PR #812 — fix: the runner allows osascript")
rec("recMergeRedoAaaaa", "", outcome="Changes requested", name="MERGE: PR #813 — fix: retype")
rec("recMergeNoneAaaaa", "", name="MERGE: PR #814 — fix: x")
rec("recFreeWorkAaaaaa", "")
q = m.build_queue()
print(json.dumps({"work": sorted(t["id"] for t in q["worklist"] + q["reserve"]), "cards": sorted(t["id"] for t in q["mergeCards"]),
                  "count": q["counts"]["mergeCards"]}))`);
    expect(r.work).toEqual(['recFreeWorkAaaaaa']);
    expect(r.cards).toEqual(['recMergeApprovedA', 'recMergeNoneAaaaa', 'recMergeRedoAaaaa']);
    expect(r.count).toBe(3);
  });
});

describe('the retired wording (Kevin, 7 Oct 2026) is produced nowhere', () => {
  it('"a fix to a protected file needs a Claude Code session" is gone from every place that wrote it', () => {
    const pat = new RegExp(execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location('x', ${JSON.stringify(resolve(ROOT, 'scripts/agent-estate-drift.py'))})
x = importlib.util.module_from_spec(spec); spec.loader.exec_module(x)
print([p for p, d, w in x.RETIRED if d == "2026-10-07"][0].replace("(?i)", ""))`], { encoding: 'utf8' }).trim(), 'i');
    expect(pat.test('a fix to a protected file needs a Claude Code session')).toBe(true);   // control
    for (const f of ['scripts/agent-dispatch.py', 'scripts/estate-status.py', 'js/home-list.js']) {
      expect(pat.test(readFileSync(resolve(ROOT, f), 'utf8')), f).toBe(false);
    }
    const r = py(`print(json.dumps(m.blocker_fix_text({"kind": "TOOL", "subject": "x", "finding": "20261001-agent-dispatch-901"})))`);
    expect(r).toBe('the robot\'s setup is repaired (finding 20261001-agent-dispatch-901); for a protected file, the fixer opens the PR and a MERGE card comes to Kevin.');
  });
});
