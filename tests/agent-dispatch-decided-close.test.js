import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// THE ANSWER WAS CARRIED OUT, THEN NOTHING COULD CLOSE THE TASK.
//
// `decided` (and route / handover) carries out Kevin's answer on a decision card by archiving his verdict
// into the Agent Output ("DECIDED (Kevin, <date>): Approved as-is") and clearing Approval Outcome and
// Approved At. `complete` then refused the task for ever: "outcome is 'empty', not an approval".
//   - finding 20261106-agent-dispatch-1223: an EPC task Kevin approved on 6 Nov sat open, walled, for 12 days.
//   - finding 20261001-task-manager-board-687: a price-cap decision card approved 19 Oct sat open for a month,
//     and a "YOUR TURN PLAN REFUSED" repair task told its agent to "close this task with that result as
//     evidence", which `complete` refused as unapproved.
// Each finding has its own tests below (one test proves one finding). They drive the real cmd_complete and
// cmd_annotate against an in-memory Airtable. Ids, names and dates are invented.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

const PRE = `
import importlib.util, json, os, io, sys, contextlib, types, tempfile, urllib.request
from datetime import datetime as _dt, timedelta, timezone
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
STATE = tempfile.mkdtemp()
m.STATE_DIR = STATE
m.INTENT_LEDGER = os.path.join(STATE, "carryout-intent.jsonl")
m.NOTES_ARCHIVE = STATE
m.HANDOVER_DIR = tempfile.mkdtemp()
m.BROWSER_LEDGER = "/nonexistent/od-test-browser-ledger.jsonl"
AF = m.AF
AGENT = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
CREATED = (_dt.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
TASKS = {}
def rec(i, **f):
    base = {AF["name"]: "DECIDE: keep the example price cap?", AF["status"]: {"name": "Today"},
            AF["teamMember"]: [AGENT], AF["notes"]: "", AF["description"]: ""}
    base.update({AF[k]: v for k, v in f.items()})
    TASKS[i] = {"id": i, "createdTime": CREATED, "fields": base}
m.get_task = lambda i: json.loads(json.dumps(TASKS[i]))
def patch(i, f):
    TASKS[i]["fields"].update(f)
    return {"id": i}
m.patch_task = patch
m.query_tasks = lambda formula, **kw: []
m.fetch_role_roster = lambda: {}
m.finding_details = lambda: {}
m.task_fields_owe_certificate = lambda *a, **k: []
m.task_owes_cost = lambda *a, **k: []
def complete(i, evidence="Kevin's answer carried out on 19 Oct: the cap was deleted from the booking rules."):
    a = dict(task=i, keep_open=False, note="closed on Kevin's carried-out answer", until="", no_certificate="",
             evidence=evidence, not_signed="", diary_not_written="", cost_not_written="", not_bought="")
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            m.cmd_complete(types.SimpleNamespace(**a))
        return None
    except SystemExit as e:
        return str(e)
def status(i):
    return m.sel(TASKS[i]["fields"].get(AF["status"]))
DECIDED_OUT = "DECIDED (Kevin, 19 Oct 2026): Approved as-is\\n\\nDECIDE: keep the example price cap?\\n\\nRECOMMENDED: delete it."
MARK = "[19 Oct 2026 — agent-dispatch] Decision carried out: Approved as-is"
`;

function py(body) {
  const out = execFileSync('python3', ['-c', PRE + body], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('finding 20261106-agent-dispatch-1223: a decision card the dispatcher closed with his approval completes', () => {
  it('completes with evidence, and only with evidence', () => {
    const r = py(`
rec("recDECIDEDxxxxxx1", agentOutput=DECIDED_OUT, notes=MARK)
rec("recDECIDEDxxxxxx2", agentOutput=DECIDED_OUT, notes=MARK)
print(json.dumps({"ok": complete("recDECIDEDxxxxxx1"), "okStatus": status("recDECIDEDxxxxxx1"),
                  "noEvidence": complete("recDECIDEDxxxxxx2", evidence=""), "noEvStatus": status("recDECIDEDxxxxxx2")}))`);
    expect(r.ok).toBe(null);
    expect(r.okStatus).toBe('Completed');
    expect(r.noEvidence).toMatch(/with no evidence/);
    expect(r.noEvStatus).toBe('Today');
  });

  it('never for a typed or forged mark, a rejection, or a card submitted again since', () => {
    const r = py(`
rec("recNOMARKxxxxxxx1", agentOutput=DECIDED_OUT, notes="")
rec("recAGENTMARKxxxx1", agentOutput=DECIDED_OUT, notes="[19 Oct 2026 — agent] Decision carried out: Approved as-is")
rec("recREJECTEDxxxxx1", agentOutput=DECIDED_OUT.replace("Approved as-is", "Rejected"), notes=MARK.replace("Approved as-is", "Rejected"))
rec("recRESUBMITxxxxx1", agentOutput=DECIDED_OUT, notes=MARK + "\\n\\n[20 Oct 2026 09:21 — agent-dispatch] SUBMITTED (round 2) as Admin with no new file")
rec("recPLAINxxxxxxxx1", agentOutput="Findings: the council replied.", notes="")
print(json.dumps({k: complete(k) for k in ("recNOMARKxxxxxxx1", "recAGENTMARKxxxx1", "recREJECTEDxxxxx1", "recRESUBMITxxxxx1", "recPLAINxxxxxxxx1")}))`);
    for (const why of Object.values(r)) expect(why).toMatch(/outcome is 'empty', not an approval/);
  });

  it('annotate refuses to type the mark that complete reads as his approval', () => {
    const r = py(`
rec("recANNOTATExxxxx1")
err = None
try:
    with contextlib.redirect_stdout(io.StringIO()):
        m.cmd_annotate(types.SimpleNamespace(task="recANNOTATExxxxx1", note="Decision carried out: Approved as-is (by me)"))
except SystemExit as e:
    err = str(e)
print(json.dumps({"err": err, "notes": TASKS["recANNOTATExxxxx1"]["fields"][AF["notes"]]}))`);
    expect(r.err).toMatch(/refusing a note .* that writes the 'Decision carried out' mark/);
    expect(r.notes).toBe('');
  });
});

describe('finding 20261106-agent-dispatch-1223, review of PR #978: the door opens only when nothing is live', () => {
  it("the real decided output opens it: decided on an approved card, then complete", () => {
    const r = py(`
rec("recREALDECIDExxx1", agentOutput="DECIDE: keep the example price cap?\\n\\nRECOMMENDED: delete it.",
    approvalOutcome={"name": "Approved as-is"}, approvedAt="2026-10-19T08:00:00.000Z", sentForApprovalBy=[AGENT])
with contextlib.redirect_stdout(io.StringIO()):
    m.cmd_decided(types.SimpleNamespace(task="recREALDECIDExxx1", until=None, on_card=None, siblings_handled=None))
print(json.dumps({"why": complete("recREALDECIDExxx1"), "status": status("recREALDECIDExxx1")}))`);
    expect(r.why).toBe(null);
    expect(r.status).toBe('Completed');
  });

  it('never while the card is back at Approval, carries a live verdict, or sits on a park he gave', () => {
    const r = py(`
from datetime import date
FUTURE = "2099-01-17"
rec("recBACKATAPPRxxx1", agentOutput=DECIDED_OUT, notes=MARK, status={"name": "Approval"})
rec("recCHANGESxxxxxx1", agentOutput=DECIDED_OUT, notes=MARK, approvalOutcome={"name": "Changes requested"})
rec("recPARKEDxxxxxxx1", agentOutput=DECIDED_OUT, status={"name": "Upcoming"}, dueDate=FUTURE,
    notes=MARK + "\\n\\n[19 Oct 2026 — agent-dispatch] Parked until " + FUTURE + " on Kevin's answer; it comes back on the board that day.")
print(json.dumps({k: [complete(k), status(k)] for k in ("recBACKATAPPRxxx1", "recCHANGESxxxxxx1", "recPARKEDxxxxxxx1")}))`);
    expect(r.recBACKATAPPRxxx1[1]).toBe('Approval');
    expect(r.recCHANGESxxxxxx1[0]).toMatch(/not an approval/);
    expect(r.recPARKEDxxxxxxx1[0]).toMatch(/not an approval/);
    for (const [why] of Object.values(r)) expect(why).not.toBe(null);
  });

  it('an overridden park never holds it: a park followed by an escalation and his "do it now" closes (re-review)', () => {
    const r = py(`
FUTURE = "2099-01-17"
rec("recOVERRIDDENxxx1", agentOutput=DECIDED_OUT, status={"name": "Today"},
    notes="[19 Oct 2026 — agent-dispatch] Parked until " + FUTURE + " on Kevin's answer\\n\\n"
          "[05 Nov 2026 — agent-dispatch] Escalated to Kevin as a decision card (holder recX)\\n\\n" + MARK)
print(json.dumps([complete("recOVERRIDDENxxx1"), status("recOVERRIDDENxxx1")]))`);
    expect(r).toEqual([null, 'Completed']);
  });

  it('a hand-over reason is one line, so it cannot plant a stamped mark', () => {
    const src = readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/reason = " "\.join\(str\(args\.reason or ""\)\.split\(\)\) or "approved reassignment"/);
  });
});

describe('finding 20261001-task-manager-board-687: a Your turn plan repair closes once its card needs nothing', () => {
  const repair = (planState, cardStatus) => py(`
rec("recCARDxxxxxxxxx1", status={"name": "${cardStatus}"})
if "${planState}" != "none":
    with open(os.path.join(m.HANDOVER_DIR, "recCARDxxxxxxxxx1.json"), "w") as fh: fh.write("{}")
m.handover_plan_verdict = (lambda tid, real=m.handover_plan_verdict:
    ("${planState}", "") if tid == "recCARDxxxxxxxxx1" else real(tid))
rec("recREPAIRxxxxxxx1", name=m.PLAN_REPAIR_PREFIX + "Build an example search", agentOutput="",
    description="The Your turn plan for recCARDxxxxxxxxx1 (/tmp/x.json) is refused by the window, so ...")
why = complete("recREPAIRxxxxxxx1", evidence="node scripts/agent-browser.js handover --dry-run ran clean on the plan")
print(json.dumps({"why": why, "status": status("recREPAIRxxxxxxx1")}))`);

  it('closes when the plan now passes the window check', () => {
    const r = repair('ok', 'Approval');
    expect(r.why).toBe(null);
    expect(r.status).toBe('Completed');
  });

  it('closes when the plan is gone and the card no longer waits as his step', () => {
    expect(repair('none', 'Today').status).toBe('Completed');
  });

  it('never while the plan is refused, could not be checked, or the card still waits with no plan', () => {
    for (const [plan, card] of [['refused', 'Approval'], ['unchecked', 'Approval'], ['none', 'Approval']]) {
      const r = repair(plan, card);
      expect(r.why, `${plan}/${card}`).toMatch(/outcome is 'empty', not an approval/);
      expect(r.status).toBe('Today');
    }
  });

  it('the plan check fails open for the button but never for a close: "could not check" is not "ok"', () => {
    const r = py(`
m.node_bin = lambda: "/nonexistent/node"
with open(os.path.join(m.HANDOVER_DIR, "recCARDxxxxxxxxx1.json"), "w") as fh: fh.write("{}")
print(json.dumps([m.handover_plan_verdict("recCARDxxxxxxxxx1")[0], m.handover_plan_problem("recCARDxxxxxxxxx1")]))`);
    expect(r).toEqual(['unchecked', '']);
  });
});
