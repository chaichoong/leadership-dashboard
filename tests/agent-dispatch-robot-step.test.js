import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// A ROBOT'S SIGN-IN IS A CARD (Kevin, 8 Oct 2026): "We seem to have bits everywhere: some sign-ins at
// the top, some sign-ins on cards, some cards that need sign-ins but don't have the buttons ... even if
// a task is blocked and it needs a sign-in, I think we add that as a task as well, rather than having
// them at the top." A SIGN-IN or SITE wall puts its task in Kevin's queue as a card whose step block
// names the site; his sign-in clears it through signin_done -> wake_blocked. These drive the real
// cmd_block, blockers_scan and signin_done with Airtable stubbed; hosts are invented.
function py(snippet, ledgerLines) {
  const dir = mkdtempSync(tmpdir() + '/od-robot-step-');
  const ledger = dir + '/runs.jsonl';
  writeFileSync(ledger, (ledgerLines || []).map((l) => JSON.stringify(l)).join('\n') + '\n');
  const script = `
import importlib.util, json, os, io, contextlib
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
AF = m.AF
TASKS, WRITES, LEDGER = {}, [], []
def rec(i, notes="", status="Today", outcome="", output="Draft: the schedule is saved.", feedback="", sent=True):
    TASKS[i] = {"id": i, "createdTime": "2026-09-20T09:00:00.000Z", "fields": {
        AF["notes"]: notes, AF["status"]: status, AF["approvalOutcome"]: outcome, AF["name"]: "INSURANCE: Example cover",
        AF["agentOutput"]: output, AF["approvalFeedback"]: feedback, AF["approvedAt"]: "2026-10-01T09:00:00.000Z" if outcome else "",
        AF["sentForApprovalBy"]: ["recAgentAaaaaaaaa"] if sent else [], AF["teamMember"]: ["recAgentAaaaaaaaa"]}}
def _get(i): return json.loads(json.dumps(TASKS[i]))
def _patch(i, fields):
    WRITES.append({"task": i, "fields": fields})
    TASKS[i]["fields"].update(fields)
m.get_task = _get
m.patch_task = _patch
m.ledger_append = lambda t, e: LEDGER.append([t, e])
m.ledger_last_events = lambda: {}
m.finding_details = lambda: {}
m.finding_states = lambda: {}
SITES = {"portal.broker.example": {"label": "Broker portal", "login": True, "loginUrl": "https://portal.broker.example/login"},
         "cover.example": {"label": "Cover (landing pages)", "login": False}}
m.load_login_sites = lambda: SITES
m.BROWSER_LEDGER = ${JSON.stringify(ledger)}
m.HANDOVER_DIR = "/nonexistent/od-test-handover"
m.SIGNIN_PICKUP_DIR = ${JSON.stringify(dir)}
def q(formula, max_records=None, minimal=False):
    if formula.startswith("NOT("):
        return [{"id": "ctl", "fields": {}}]
    want_done = formula.startswith("AND({Status}='Completed'")
    return [json.loads(json.dumps(t)) for t in TASKS.values() if (t["fields"][AF["status"]] == "Completed") == want_done]
m.query_tasks = q
class A:
    def __init__(self, **kw): self.__dict__.update(kw)
def run(fn, args):
    out, err = io.StringIO(), None
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            fn(A(**args))
    except SystemExit as e:
        err = str(e)
    return {"err": err, "out": out.getvalue()}
def f(i, k): return TASKS[i]["fields"].get(AF[k])
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
}
const blk = (kind, subject, since) => `[x — agent] BLOCKER OPEN (${kind} ${subject}): why Fix: f [since ${since}]`;

describe('a SIGN-IN or SITE wall puts its task in the queue as a card', () => {
  it('block on unapproved and approved work makes the card; the verdict is kept and the draft sits under the step', () => {
    const r = py(`
rec("new"); rec("ok", outcome="Approved as-is"); rec("site")
a = run(m.cmd_block, {"task": "new", "kind": "SIGN-IN", "subject": "portal.broker.example", "why": "Signed out.", "finding": None})
b = run(m.cmd_block, {"task": "ok", "kind": "SIGN-IN", "subject": "portal.broker.example", "why": "Signed out.", "finding": None})
c = run(m.cmd_block, {"task": "site", "kind": "SITE", "subject": "cover.example", "why": "Read-only.", "finding": None})
print(json.dumps({"err": [a["err"], b["err"], c["err"]], "yourStep": [json.loads(x["out"]).get("yourStep") for x in (a, b, c)],
                  "new": [f("new", "status"), f("new", "agentOutput")], "ok": [f("ok", "status"), f("ok", "approvalOutcome")],
                  "site": f("site", "agentOutput")}))`);
    expect(r.err).toEqual([null, null, null]);
    expect(r.yourStep).toEqual([true, true, true]);
    expect(r.new[0]).toBe('Approval');
    expect(r.new[1]).toMatch(/^YOUR STEP: ROBOT SIGN-IN: portal\.broker\.example\. A robot is blocked until it is signed in to Broker portal\. Press Sign in/);
    expect(r.new[1]).toMatch(/----- The agent's work, as you approved it -----\n\nDraft: the schedule is saved\.$/);
    expect(r.ok).toEqual(['Approval', 'Approved as-is']);
    expect(r.site).toMatch(/^YOUR STEP: ROBOT SITE: cover\.example\. A robot is blocked until cover\.example is on its list\. Press \+ Add this site/);
  });

  it('a card he is deciding, a closed task and a task with no agent are left alone', () => {
    const r = py(`
rec("deciding", status="Approval", output="Draft: waiting for his yes.")
rec("noagent", sent=False); TASKS["noagent"]["fields"][AF["teamMember"]] = []
a = run(m.cmd_block, {"task": "deciding", "kind": "SIGN-IN", "subject": "portal.broker.example", "why": "Signed out.", "finding": None})
b = run(m.cmd_block, {"task": "noagent", "kind": "SIGN-IN", "subject": "portal.broker.example", "why": "Signed out.", "finding": None})
print(json.dumps({"deciding": [f("deciding", "status"), f("deciding", "agentOutput")], "noagent": f("noagent", "status"),
                  "walls": [m.task_blocker(f(i, "notes")) is not None for i in ("deciding", "noagent")]}))`);
    expect(r.deciding).toEqual(['Approval', 'Draft: waiting for his yes.']);
    expect(r.noagent).toBe('Today');
    expect(r.walls).toEqual([true, true]);     // the walls are still recorded
  });

  it('the sweep makes the card for a wall from before, and a wall that clears is woken instead', () => {
    const r = py(`
rec("old", notes="${blk('SIGN-IN', 'portal.broker.example', '2026-10-05T09:00:00.000Z')}")
rec("site", notes="${blk('SITE', 'cover.example', '2026-10-05T09:00:00.000Z')}")
res = m.blockers_scan(sweep=True)
print(json.dumps({"surfaced": sorted(x["task"] for x in res["surfaced"]), "old": f("old", "status"), "site": f("site", "status"),
                  "again": len(m.blockers_scan(sweep=True)["surfaced"])}))`);
    expect(r.surfaced).toEqual(['old', 'site']);
    expect(r.old).toBe('Approval');
    expect(r.site).toBe('Approval');
    expect(r.again).toBe(0);                     // once only
  });

  it('his sign-in clears the card: the task goes back to Today with its draft and its verdict', () => {
    const r = py(`
rec("ok", outcome="Approved as-is")
run(m.cmd_block, {"task": "ok", "kind": "SIGN-IN", "subject": "portal.broker.example", "why": "Signed out.", "finding": None})
groups = [{"host": "portal.broker.example", "label": "Broker portal", "tasks": [{"id": "ok", "agent": "recAgentAaaaaaaaa", "name": "INSURANCE: Example cover", "blocker": True}]}]
res = m.signin_done("portal.broker.example", SITES, groups)
print(json.dumps({"handed": [h["task"] for h in res["handedBack"]], "status": f("ok", "status"), "outcome": f("ok", "approvalOutcome"),
                  "output": f("ok", "agentOutput"), "wall": m.task_blocker(f("ok", "notes"))}))`);
    expect(r.handed).toEqual(['ok']);
    expect(r.status).toBe('Today');
    expect(r.outcome).toBe('Approved as-is');
    expect(r.output).toBe('Draft: the schedule is saved.');
    expect(r.wall).toBeNull();
  });

  it("I can't on a robot card sends the task back with his reason", () => {
    const r = py(`
rec("new", notes="${blk('SIGN-IN', 'portal.broker.example', '2026-10-05T09:00:00.000Z')}")
m.blockers_scan(sweep=True)
TASKS["new"]["fields"][AF["approvalFeedback"]] = "KEVIN STEP CANT [2026-10-06T10:00:00.000Z]: We have no account there."
res = m.blockers_scan(sweep=True)
print(json.dumps({"sent": [x["task"] for x in res["sentBack"]], "status": f("new", "status"), "outcome": f("new", "approvalOutcome"),
                  "fb": f("new", "approvalFeedback"), "output": f("new", "agentOutput")}))`);
    expect(r.sent).toEqual(['new']);
    expect(r.status).toBe('Today');
    expect(r.outcome).toBe('Changes requested');
    expect(r.fb).toBe("I can't do this step: We have no account there.");
    expect(r.output).toBe('Draft: the schedule is saved.');
  });
});
