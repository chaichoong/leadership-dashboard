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
def rec(i, notes="", status="Today", outcome="", output="Draft: the schedule is saved.", feedback="", sent=True, approver=None, due=""):
    TASKS[i] = {"id": i, "createdTime": "2026-09-20T09:00:00.000Z", "fields": {
        AF["notes"]: notes, AF["status"]: status, AF["approvalOutcome"]: outcome, AF["name"]: "INSURANCE: Example cover",
        AF["agentOutput"]: output, AF["approvalFeedback"]: feedback, AF["approvedAt"]: "2026-10-01T09:00:00.000Z" if outcome else "",
        AF["sentForApprovalBy"]: ["recAgentAaaaaaaaa"] if sent else [], AF["teamMember"]: ["recAgentAaaaaaaaa"]}}
    if approver:
        TASKS[i]["fields"][AF["approver"]] = {"email": approver}
    if due:
        TASKS[i]["fields"][AF["dueDate"]] = due
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
         "shop.self.example": {"label": "Shop (signs itself back in)", "login": True, "loginUrl": "https://shop.self.example/", "selfRefresh": True},
         "cover.example": {"label": "Cover (landing pages)", "login": False}}
m.load_login_sites = lambda: SITES
m.BROWSER_LEDGER = ${JSON.stringify(ledger)}
m.HANDOVER_DIR = ${JSON.stringify(dir)}
m.file_tool_finding = lambda *a, **k: "20261008-test-1"
m.load_standing_holds = lambda: ([], "")
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

  it('a wall that could not be a card is refused, so every new one has a door', () => {
    const r = py(`
rec("deciding", status="Approval", output="Draft: waiting for his yes.")
rec("noagent", sent=False); TASKS["noagent"]["fields"][AF["teamMember"]] = []
a = run(m.cmd_block, {"task": "deciding", "kind": "SIGN-IN", "subject": "portal.broker.example", "why": "Signed out.", "finding": None})
b = run(m.cmd_block, {"task": "noagent", "kind": "SIGN-IN", "subject": "portal.broker.example", "why": "Signed out.", "finding": None})
rec("parked", status="Upcoming"); rec("cancelled", status="Cancelled"); rec("someday", status="")
rec("mica", approver="someone@example.co.uk")
rest = {k: run(m.cmd_block, {"task": k, "kind": "SITE", "subject": "cover.example", "why": "Read-only.", "finding": None})["err"]
        for k in ("parked", "cancelled", "someday", "mica")}
odd = run(m.cmd_block, {"task": "someday", "kind": "SITE", "subject": "portal_x.example.co.uk", "why": "x", "finding": None})["err"]
print(json.dumps({"a": a["err"], "b": b["err"], "rest": rest, "odd": odd,
                  "deciding": [f("deciding", "status"), f("deciding", "agentOutput")],
                  "walls": [m.task_blocker(f(i, "notes")) is not None for i in ("deciding", "noagent", "parked", "cancelled", "someday", "mica")]}))`);
    expect(r.a).toMatch(/^ERROR: refusing a SIGN-IN wall on deciding: it is a card waiting on Kevin's verdict/);
    expect(r.b).toMatch(/no agent is named on it/);
    expect(r.rest.parked).toMatch(/it is Upcoming, so it is not being worked/);
    expect(r.rest.cancelled).toMatch(/it is Cancelled, so it is not being worked/);
    expect(r.rest.someday).toMatch(/it is on Some Day, so it is not being worked/);
    expect(r.rest.mica).toMatch(/its approver is not Kevin/);
    expect(r.odd).toMatch(/is not a plain host name/);
    expect(r.deciding).toEqual(['Approval', 'Draft: waiting for his yes.']);
    expect(r.walls).toEqual([false, false, false, false, false, false]);     // nothing written
  });

  it('an internationalised host is carried in its plain form, so the button opens the right site', () => {
    const r = py(`
rec("idn")
a = run(m.cmd_block, {"task": "idn", "kind": "SITE", "subject": "https://www.bücher.example/login", "why": "x", "finding": None})
print(json.dumps({"err": a["err"], "out": f("idn", "agentOutput"), "step": list(m.robot_step(TASKS["idn"]["fields"] and m.task_view(TASKS["idn"])) or [])}))`);
    expect(r.err).toBeNull();
    expect(r.out).toMatch(/^YOUR STEP: ROBOT SITE: www\.xn--bcher-kva\.example\. /);
    expect(r.step).toEqual(['SITE', 'www.xn--bcher-kva.example', '']);
  });

  it('a second wall rewrites the card, a Your step card that meets a sign-in becomes its card, and a TOOL wall takes the card out', () => {
    const r = py(`
rec("two")
run(m.cmd_block, {"task": "two", "kind": "SIGN-IN", "subject": "portal.broker.example", "why": "Signed out.", "finding": None})
run(m.cmd_block, {"task": "two", "kind": "SITE", "subject": "cover.example", "why": "Read-only.", "finding": None})
second = m.robot_step(m.task_view(TASKS["two"]))
run(m.cmd_block, {"task": "two", "kind": "TOOL", "subject": "node", "why": "node not found", "finding": None})
rec("kev", outcome="Approved as-is", status="Approval", output=m.your_step_output("1. Pay it.", "Draft: the schedule is saved."))
run(m.cmd_block, {"task": "kev", "kind": "SIGN-IN", "subject": "portal.broker.example", "why": "Signed out.", "finding": None})
print(json.dumps({"second": list(second), "tool": [f("two", "status"), f("two", "agentOutput")],
                  "kev": [f("kev", "status"), list(m.robot_step(m.task_view(TASKS["kev"])) or []), f("kev", "approvalOutcome")],
                  "kevWork": m.your_step_split(f("kev", "agentOutput"))[1]}))`);
    expect(r.second).toEqual(['SITE', 'cover.example', '']);
    expect(r.tool).toEqual(['Today', 'Draft: the schedule is saved.']);
    expect(r.kev).toEqual(['Approval', ['SIGN-IN', 'portal.broker.example', ''], 'Approved as-is']);
    expect(r.kevWork).toBe('Draft: the schedule is saved.');      // never wrapped twice
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

  it('the sweep leaves a task a standing hold covers parked, and stamps when it read the board', () => {
    const r = py(`
rec("held", notes="${blk('SIGN-IN', 'portal.broker.example', '2026-10-05T09:00:00.000Z')}")
m.load_standing_holds = lambda: ([{"id": "sample"}], "")
m.standing_holds.hold_for = lambda t, holds: holds[0] if t["id"] == "held" else None
res = m.blockers_scan(sweep=True)
print(json.dumps({"surfaced": res["surfaced"], "status": f("held", "status"), "readAt": res["readAt"]}))`);
    expect(r.surfaced).toEqual([]);
    expect(r.status).toBe('Today');
    expect(r.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  });

  it('an agent cannot rewrite, re-escalate or hand over a robot card, approved or not', () => {
    const r = py(`
rec("new")
run(m.cmd_block, {"task": "new", "kind": "SIGN-IN", "subject": "portal.broker.example", "why": "Signed out.", "finding": None})
print(json.dumps({"held": m.held_card_problem(TASKS["new"]["fields"])}))`);
    expect(r.held).toMatch(/robot sign-in card/);
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
print(json.dumps({"sent": [x["task"] for x in res["sentBack"]], "status": f("new", "status"), "outcome": f("new", "approvalOutcome") or "",
                  "fb": f("new", "approvalFeedback"), "output": f("new", "agentOutput")}))`);
    expect(r.sent).toEqual(['new']);
    expect(r.status).toBe('Today');
    expect(r.outcome).toBe('');                 // never submitted, so never marked down
    expect(r.fb).toBe("I can't do this step: We have no account there.");
    expect(r.output).toBe('Draft: the schedule is saved.');
  });

  it("I can't on a redo keeps his earlier points; on a sign-in card the task's Your turn plan is left alone", () => {
    const r = py(`
import os
open(os.path.join(m.HANDOVER_DIR, "recRedoTaskAaaaaa.json"), "w").write("{}")
rec("recRedoTaskAaaaaa", outcome="Changes requested", feedback="Use the business card.",
    notes="${blk('SIGN-IN', 'portal.broker.example', '2026-10-05T09:00:00.000Z')}")
m.blockers_scan(sweep=True)
TASKS["recRedoTaskAaaaaa"]["fields"][AF["approvalFeedback"]] += "\\nKEVIN STEP CANT [2026-10-06T10:00:00.000Z]: No account."
m.blockers_scan(sweep=True)
print(json.dumps({"fb": f("recRedoTaskAaaaaa", "approvalFeedback"), "outcome": f("recRedoTaskAaaaaa", "approvalOutcome"),
                  "plan": os.path.exists(os.path.join(m.HANDOVER_DIR, "recRedoTaskAaaaaa.json"))}))`);
    expect(r.fb).toBe("Use the business card.\nI can't do this step: No account.");
    expect(r.outcome).toBe('Changes requested');
    expect(r.plan).toBe(true);
  });

  // Second review round, 8 Oct 2026.
  it('a card moved off the queue (a hold released it, a drag to Today) is put back by the sweep and by a re-block', () => {
    const r = py(`
rec("moved")
run(m.cmd_block, {"task": "moved", "kind": "SITE", "subject": "cover.example", "why": "Read-only.", "finding": None})
TASKS["moved"]["fields"][AF["status"]] = "Today"
res = m.blockers_scan(sweep=True)
back = f("moved", "status")
TASKS["moved"]["fields"][AF["status"]] = "Today"
again = run(m.cmd_block, {"task": "moved", "kind": "SITE", "subject": "cover.example", "why": "Read-only.", "finding": None})
print(json.dumps({"surfaced": [x["task"] for x in res["surfaced"]], "back": back, "again": [again["err"], f("moved", "status")],
                  "wrapped": f("moved", "agentOutput").count("----- The agent's work, as you approved it -----")}))`);
    expect(r.surfaced).toEqual(['moved']);
    expect(r.back).toBe('Approval');
    expect(r.again).toEqual([null, 'Approval']);
    expect(r.wrapped).toBe(1);
  });

  it('an Upcoming task due today is being worked and gets its card; one due later is refused', () => {
    const r = py(`
rec("due", status="Upcoming", due=m.today_london()); rec("later", status="Upcoming", due="2099-01-01")
rec("prog", status="In Progress")
c = run(m.cmd_block, {"task": "prog", "kind": "SITE", "subject": "cover.example", "why": "x", "finding": None})
a = run(m.cmd_block, {"task": "due", "kind": "SITE", "subject": "cover.example", "why": "x", "finding": None})
b = run(m.cmd_block, {"task": "later", "kind": "SITE", "subject": "cover.example", "why": "x", "finding": None})
print(json.dumps({"a": [a["err"], f("due", "status")], "b": b["err"], "c": [c["err"], f("prog", "status")]}))`);
    expect(r.a).toEqual([null, 'Approval']);
    expect(r.b).toMatch(/it is Upcoming, so it is not being worked/);
    expect(r.c).toEqual([null, 'Approval']);          // the board spells it "In Progress"
  });

  it("after his I can't, the agent may not raise the same wall on that task again", () => {
    const r = py(`
rec("new", notes="${blk('SIGN-IN', 'portal.broker.example', '2026-10-05T09:00:00.000Z')}")
m.blockers_scan(sweep=True)
TASKS["new"]["fields"][AF["approvalFeedback"]] = "KEVIN STEP CANT [2026-10-06T10:00:00.000Z]: We have no account there."
m.blockers_scan(sweep=True)
note = f("new", "notes").split("\\n\\n")[-1]
again = run(m.cmd_block, {"task": "new", "kind": "SIGN-IN", "subject": "portal.broker.example", "why": "Signed out.", "finding": None})
other = run(m.cmd_block, {"task": "new", "kind": "SITE", "subject": "cover.example", "why": "x", "finding": None})
print(json.dumps({"note": note, "again": again["err"], "other": other["err"]}))`);
    expect(r.note).toMatch(/Kevin cannot take this step: We have no account there\. Sent back to you\. This wall is not fixed/);
    expect(r.note).not.toMatch(/Changes requested/);
    expect(r.again).toMatch(/^ERROR: refusing a SIGN-IN wall on portal\.broker\.example: Kevin said he cannot do this step on this task \(We have no account there\)/);
    expect(r.other).toBeNull();                        // another wall is a new question
  });

  it('a profile in capitals is read, an internationalised SITE wall is stored plain and clears once added, and a self-refreshing site asks nothing', () => {
    const r = py(`
step = m.robot_step({"agentOutput": m.your_step_output("ROBOT SIGN-IN: my.flats.example (Apt1). Blocked.", "x")})
rec("idn"); rec("self")
run(m.cmd_block, {"task": "idn", "kind": "SITE", "subject": "https://www.bücher.example/login", "why": "x", "finding": None})
wall = m.task_blocker(f("idn", "notes"))
SITES["www.xn--bcher-kva.example"] = {"label": "Bücher", "login": True, "loginUrl": "https://www.xn--bcher-kva.example/login"}
res = m.blockers_scan(sweep=True)
s = run(m.cmd_block, {"task": "self", "kind": "SIGN-IN", "subject": "shop.self.example", "why": "Signed out.", "finding": None})
print(json.dumps({"step": list(step), "subject": wall["subject"], "woken": [w["task"] for w in res["woken"]],
                  "self": [s["err"], f("self", "status"), m.task_blocker(f("self", "notes")) is not None]}))`);
    expect(r.step).toEqual(['SIGN-IN', 'my.flats.example', 'Apt1']);
    expect(r.subject).toBe('www.xn--bcher-kva.example');
    expect(r.woken).toEqual(['idn']);
    expect(r.self).toEqual([null, 'Today', true]);       // the wall stands, no card: it clears itself
  });

  // Third review round, 8 Oct 2026.
  it("the I can't refusal: SIGN-IN and SITE only, the same flat only, and only a line written on this task", () => {
    const r = py(`
cant = lambda kind, subj, reason, prof="": (f"[08 Oct 2026 15:01 — Kevin] BLOCKER CLEARED ({kind} {subj}): Kevin cannot take this step: "
                                           f"{reason}. Sent back to you. This wall is not fixed." + (f" [profile {prof}]" if prof else ""))
kev = cant("KEVIN", "identity", "not until the housing costs are verified")
flat1 = cant("SIGN-IN", "my.flats.example", "no password for flat 1", "apt1")
plain = cant("SIGN-IN", "portal.broker.example", "no account")
quoted = "TRACK RECORD\\n- 08 Oct 2026 15:01 — Kevin: BLOCKER CLEARED (SIGN-IN portal.broker.example): Kevin cannot take this step: no account. Sent back to you."
print(json.dumps({
  "kevin": m.kevin_said_cant(kev, "KEVIN", "identity"),
  "flat1": m.kevin_said_cant(flat1, "SIGN-IN", "my.flats.example", "apt1"),
  "flat2": m.kevin_said_cant(flat1, "SIGN-IN", "my.flats.example", "apt2"),
  "mainOfFlat": m.kevin_said_cant(flat1, "SIGN-IN", "my.flats.example"),
  "plain": m.kevin_said_cant(plain, "SIGN-IN", "portal.broker.example"),
  "quoted": m.kevin_said_cant(quoted, "SIGN-IN", "portal.broker.example")}))`);
    expect(r.kevin).toBe('');                       // a KEVIN reason can mean "later": never a lock
    expect(r.flat1).toBe('no password for flat 1');
    expect(r.flat2).toBe('');
    expect(r.mainOfFlat).toBe('');
    expect(r.plain).toBe('no account');
    expect(r.quoted).toBe('');                      // another task's history, quoted: not his word on this task
  });

  it('a self-refreshing site takes an older card out of the queue until it clears itself', () => {
    const r = py(`
rec("t1")
run(m.cmd_block, {"task": "t1", "kind": "SITE", "subject": "cover.example", "why": "Read-only.", "finding": None})
was = f("t1", "status")
run(m.cmd_block, {"task": "t1", "kind": "SIGN-IN", "subject": "shop.self.example", "why": "Signed out.", "finding": None})
print(json.dumps({"was": was, "now": f("t1", "status"), "out": f("t1", "agentOutput")}))`);
    expect(r.was).toBe('Approval');
    expect(r.now).toBe('Today');
    expect(r.out).toBe('Draft: the schedule is saved.');
  });
});
