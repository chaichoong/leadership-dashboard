import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// THE BLOCKER LOOP (Kevin, 25 Sep 2026). "An AI agent tries to do something,
// hits a blockage, and then it sits there or gets forgotten." Measured that
// day: 6 Chedburgh Place landlord insurance (recPYIC5nn7v2bh8e) was PARKED nine
// times in ten days while its wall moved from "signed out" to "not on the
// robot's list" to "node not on PATH", and nobody was asked to fix the last
// two; the Swinton quote (recc2fdXwsHLMAKU3) was handed to Kevin in the
// closing line, approved, and closed with nothing done, and the policy
// renewed. These tests drive the real functions with Airtable stubbed out:
// every write lands in WRITES, every read comes from TASKS.
function py(snippet) {
  const script = `
import importlib.util, json, sys, io, contextlib
from datetime import datetime, timezone, timedelta
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
AF = m.AF
TASKS, WRITES, LEDGER = {}, [], []
def rec(i, notes="", status="Today", outcome="", name="INSURANCE: test task", approved_at=""):
    TASKS[i] = {"id": i, "fields": {AF["notes"]: notes, AF["status"]: status, AF["approvalOutcome"]: outcome,
                                      AF["name"]: name, AF["approvedAt"]: approved_at}}
    return TASKS[i]
def _get(i): return json.loads(json.dumps(TASKS[i]))
def _patch(i, fields):
    WRITES.append({"task": i, "fields": fields})
    TASKS[i]["fields"].update(fields)
m.get_task = _get
m.patch_task = _patch
m.ledger_append = lambda t, e: LEDGER.append([t, e])
SITES = {"www.topcashback.co.uk": {"label": "TopCashback", "login": True, "loginUrl": "https://www.topcashback.co.uk/logon/"},
         "namecheap.com": {"label": "Namecheap", "login": True},
         "gov.uk": {"label": "GOV.UK", "login": False}}
m.load_login_sites = lambda: SITES
m.BROWSER_LEDGER = "/nonexistent/od-test-browser-ledger.jsonl"   # never the live robot's log
class A:
    def __init__(self, **kw): self.__dict__.update(kw)
def run(fn, args):
    out, err = io.StringIO(), None
    try:
        with contextlib.redirect_stdout(out):
            fn(A(**args))
    except SystemExit as e:
        err = str(e)
    return {"out": out.getvalue(), "err": err}
def notes(i): return TASKS[i]["fields"][AF["notes"]]
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

describe('a wall is recorded with its kind, once, and reads back', () => {
  it('SITE: an address the list cannot reach is recorded, with who fixes it', () => {
    const r = py(`
rec("t1")
res = run(m.cmd_block, {"task": "t1", "kind": "SITE", "subject": "https://www.namecheap.com/myaccount/", "why": "The renewal page is on Namecheap.", "finding": None})
print(json.dumps({"res": res, "b": m.task_blocker(notes("t1")), "ledger": LEDGER}))`);
    expect(r.res.err).toBeNull();
    expect(r.b.kind).toBe('SITE');
    expect(r.b.subject).toBe('www.namecheap.com');
    expect(r.b.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.ledger).toEqual([['t1', 'parked']]);   // rests like a PARKED note did, so the poll does not spin
  });

  it('SITE is refused for a site the robot can already sign in to (that is SIGN-IN), and SIGN-IN for one it cannot', () => {
    const r = py(`
rec("t1")
a = run(m.cmd_block, {"task": "t1", "kind": "SITE", "subject": "topcashback.co.uk", "why": "x", "finding": None})
b = run(m.cmd_block, {"task": "t1", "kind": "SIGN-IN", "subject": "namecheap.com", "why": "x", "finding": None})
c = run(m.cmd_block, {"task": "t1", "kind": "SIGN-IN", "subject": "www.topcashback.co.uk", "why": "Signed out when I looked.", "finding": None})
print(json.dumps({"a": a["err"], "b": b["err"], "c": c["err"], "blk": m.task_blocker(notes("t1"))}))`);
    expect(r.a).toMatch(/IS on the robot's list with a sign-in page/);
    expect(r.b).toMatch(/That is a SITE wall/);   // namecheap is listed but has no sign-in page
    expect(r.c).toBeNull();
    expect(r.blk).toMatchObject({ kind: 'SIGN-IN', subject: 'www.topcashback.co.uk' });
  });

  it('SIGN-IN is refused for a site that showed the robot a bot check today (Cloudflare, 25 Sep 2026)', () => {
    const dir = mkdtempSync(tmpdir() + '/od-botcheck-');
    const ledger = dir + '/runs.jsonl';
    const now = new Date();
    // Today's shape: the session walk passed, then the agent's own READ met the wall.
    writeFileSync(ledger, [
      JSON.stringify({ at: new Date(now - 4 * 3600e3).toISOString(), cmd: 'session', site: 'www.topcashback.co.uk', url: 'https://www.topcashback.co.uk/home/', signedIn: true, profile: 'default' }),
      JSON.stringify({ at: new Date(now - 3 * 3600e3).toISOString(), cmd: 'read', url: 'https://www.topcashback.co.uk/logon/', botCheck: true, profile: 'default' }),
    ].join('\n') + '\n');
    const old = dir + '/old.jsonl';     // a bot check more than a day old no longer stands
    writeFileSync(old, JSON.stringify({ at: new Date(now - 26 * 3600e3).toISOString(), cmd: 'session', site: 'www.topcashback.co.uk', url: 'https://www.topcashback.co.uk/', signedIn: false, botCheck: true, profile: 'default' }) + '\n');
    const gone = dir + '/gone.jsonl';   // a later clean read means the check has gone
    writeFileSync(gone, [
      JSON.stringify({ at: new Date(now - 3 * 3600e3).toISOString(), cmd: 'read', url: 'https://www.topcashback.co.uk/logon/', botCheck: true, profile: 'default' }),
      JSON.stringify({ at: new Date(now - 1 * 3600e3).toISOString(), cmd: 'read', url: 'https://www.topcashback.co.uk/logon/', profile: 'default' }),
    ].join('\n') + '\n');
    const r = py(`
m.BROWSER_LEDGER = ${JSON.stringify(ledger)}
rec("t1")
a = run(m.cmd_block, {"task": "t1", "kind": "SIGN-IN", "subject": "www.topcashback.co.uk", "why": "Stuck on verify you are human.", "finding": None})
blk = m.task_blocker(notes("t1"))
m.BROWSER_LEDGER = ${JSON.stringify(old)}
rec("t2")
c = run(m.cmd_block, {"task": "t2", "kind": "SIGN-IN", "subject": "www.topcashback.co.uk", "why": "Signed out.", "finding": None})
m.BROWSER_LEDGER = ${JSON.stringify(gone)}
rec("t3")
d = run(m.cmd_block, {"task": "t3", "kind": "SIGN-IN", "subject": "www.topcashback.co.uk", "why": "Signed out.", "finding": None})
print(json.dumps({"a": a["err"], "blk": blk, "c": c["err"], "d": d["err"]}))`);
    expect(r.a).toMatch(/showed the robot a bot check \("verify you are human", read at/);
    expect(r.a).toMatch(/not a SIGN-IN wall/);
    expect(r.a).toMatch(/block t1 --kind KEVIN --subject credential/);   // a route block accepts, not a circle
    expect(r.blk).toBeNull();          // nothing written
    expect(r.c).toBeNull();            // 26 hours old: SIGN-IN is allowed again
    expect(r.d).toBeNull();            // cleared by a newer clean read
  });

  it('a bot check on a subdomain counts for its site; a parent or a look-alike never does', () => {
    const dir = mkdtempSync(tmpdir() + '/od-botcheck-sub-');
    const ledger = dir + '/runs.jsonl';
    writeFileSync(ledger, JSON.stringify({ at: new Date().toISOString(), cmd: 'read', url: 'https://www.loom.com/looms', botCheck: true, profile: 'default' }) + '\n');
    const r = py(`
L = ${JSON.stringify(ledger)}
print(json.dumps([bool(m.ledger_bot_check(["loom.com"], path=L)), bool(m.ledger_bot_check(["www.loom.com"], path=L)),
                  bool(m.ledger_bot_check(["app.www.loom.com"], path=L)), bool(m.ledger_bot_check(["oom.com"], path=L)),
                  bool(m.ledger_bot_check(["loom.com"], path=L, profile="spotify"))]))`);
    expect(r).toEqual([true, true, false, false, false]);
  });

  it('KEVIN only for the steps that are his by rule; "get the quote" is not one', () => {
    const r = py(`
rec("t1")
a = run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "quote", "why": "x", "finding": None})
b = run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "Purchase", "why": "Kevin buys the RightSure policy through TopCashback.", "finding": None})
print(json.dumps({"a": a["err"], "b": b["err"], "blk": m.task_blocker(notes("t1"))}))`);
    expect(r.a).toMatch(/a KEVIN wall is one of: payment, purchase, signature/);
    expect(r.b).toBeNull();
    expect(r.blk).toMatchObject({ kind: 'KEVIN', subject: 'purchase' });
  });

  it('TOOL files a HIGH finding (never the overflow log) and carries its id', () => {
    const r = py(`
rec("t1")
CALLS = []
m.file_tool_finding = lambda t, s, w: (CALLS.append([t, s]), "20260925-agent-dispatch-777")[1]
res = run(m.cmd_block, {"task": "t1", "kind": "TOOL", "subject": "node missing from PATH", "why": "command not found: node", "finding": None})
print(json.dumps({"err": res["err"], "calls": CALLS, "blk": m.task_blocker(notes("t1"))}))`);
    expect(r.err).toBeNull();
    expect(r.calls).toEqual([['t1', 'node missing from PATH']]);
    expect(r.blk.finding).toBe('20260925-agent-dispatch-777');
    expect(r.blk.why).toBe('command not found: node');
  });

  it('file_tool_finding asks findings.py for severity high, which the cap never refuses', () => {
    const r = py(`
import subprocess, os, tempfile
d = tempfile.mkdtemp()
os.environ["FINDINGS_FILE"] = os.path.join(d, "q.jsonl")
os.environ["FINDINGS_OVERFLOW_FILE"] = os.path.join(d, "o.jsonl")
fid = m.file_tool_finding("t1", "no retype command", "send-email refuses an Admin task")
rows = [json.loads(l) for l in open(os.environ["FINDINGS_FILE"])]
print(json.dumps({"fid": fid, "sev": rows[0]["severity"], "title": rows[0]["title"], "overflow": os.path.exists(os.environ["FINDINGS_OVERFLOW_FILE"])}))`);
    expect(r.fid).toMatch(/^\d{8}-agent-dispatch-\d{3}$/);
    expect(r.sev).toBe('high');
    expect(r.title).toBe('Agent blocked: no retype command');
    expect(r.overflow).toBe(false);
  });

  it('the same wall seen again rests again but writes no second line', () => {
    const r = py(`
rec("t1")
for _ in range(3):
    run(m.cmd_block, {"task": "t1", "kind": "SITE", "subject": "namecheap.com", "why": "Renewal page.", "finding": None})
print(json.dumps({"lines": notes("t1").count(m.BLOCKER_OPEN_MARK), "ledger": [e for _, e in LEDGER]}))`);
    expect(r.lines).toBe(1);
    expect(r.ledger).toEqual(['parked', 'parked', 'parked']);
  });

  it('the newest marker wins: OPEN, then CLEARED, then OPEN again', () => {
    const r = py(`
o = "[25 Sep 2026 09:00 — agent] BLOCKER OPEN (SITE namecheap.com): x Fix: y [since 2026-09-25T08:00:00.000Z]"
c = "[25 Sep 2026 10:00 — agent-dispatch] BLOCKER CLEARED (SITE namecheap.com): on the list now."
print(json.dumps([m.task_blocker(o), m.task_blocker(o + "\\n\\n" + c), m.task_blocker(o + "\\n\\n" + c + "\\n\\n" + o.replace("SITE namecheap.com", "TOOL retype")) ]))`);
    expect(r[0]).toMatchObject({ kind: 'SITE', subject: 'namecheap.com', why: 'x', since: '2026-09-25T08:00:00.000Z' });
    expect(r[1]).toBeNull();
    expect(r[2]).toMatchObject({ kind: 'TOOL', subject: 'retype' });
  });

  it('a free-text PARKED note is refused and points at block (it rested the task and did nothing else)', () => {
    const r = py(`
rec("t1")
res = run(m.cmd_annotate, {"task": "t1", "note": "PARKED: TopCashback (https://www.topcashback.co.uk/logon/) off the allowlist."})
ok = run(m.cmd_annotate, {"task": "t1", "note": "Checked the compliance book: no policy on record."})
print(json.dumps({"err": res["err"], "ok": ok["err"], "writes": len(WRITES)}))`);
    expect(r.err).toMatch(/refusing a PARKED\/BLOCKED note/);
    expect(r.err).toMatch(/agent-dispatch\.py block t1 --kind/);
    expect(r.ok).toBeNull();
    expect(r.writes).toBe(1);
  });
});

describe('a blocked task cannot close', () => {
  it('complete refuses while the wall stands, keeps --keep-open, and completes once it is cleared with evidence', () => {
    const r = py(`
rec("t1", outcome="Approved as-is", approved_at="2026-09-25T09:00:00.000Z")
run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "purchase", "why": "Kevin buys the policy.", "finding": None})
a = run(m.cmd_complete, {"task": "t1", "keep_open": False, "note": None})
k = run(m.cmd_complete, {"task": "t1", "keep_open": True, "note": "saved the quote"})
thin = run(m.cmd_unblock, {"task": "t1", "evidence": "done"})
u = run(m.cmd_unblock, {"task": "t1", "evidence": "Policy RS-1234 schedule email from RightSure, 25 Sep 14:02, in Gmail."})
b = run(m.cmd_complete, {"task": "t1", "keep_open": False, "note": None})
f = TASKS["t1"]["fields"]
print(json.dumps({"a": a["err"], "k": k["err"], "thin": thin["err"], "u": u["err"], "b": b["err"],
                  "status": f[AF["status"]], "outcome": f[AF["approvalOutcome"]], "approvedAt": f[AF["approvedAt"]]}))`);
    expect(r.a).toMatch(/refusing to complete t1: it is blocked \(KEVIN purchase/);
    expect(r.k).toBeNull();
    expect(r.thin).toMatch(/--evidence must say what you SAW/);
    expect(r.u).toBeNull();
    expect(r.b).toBeNull();
    expect(r.status).toBe('Completed');
    expect(r.outcome).toBe('Approved as-is');          // his verdict was never touched
    expect(r.approvedAt).toBe('2026-09-25T09:00:00.000Z');
  });
});

describe('the sweep wakes a task when its cause is fixed, and reports what is stuck', () => {
  const setup = `
NOW = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
def openline(kind, subj, since, extra=""):
    return f"[x — agent] BLOCKER OPEN ({kind} {subj}): why Fix: f [since {since}]{extra}"
rec("site_fixed", openline("SITE", "www.topcashback.co.uk", "2026-09-24T10:00:00.000Z"), outcome="Approved as-is", approved_at="2026-09-20T10:00:00.000Z")
rec("site_open", openline("SITE", "namecheap.com", "2026-09-20T10:00:00.000Z"), status="Upcoming")
rec("tool_fixed", openline("TOOL", "node PATH", "2026-09-25T08:00:00.000Z", " [finding 20260923-agent-dispatch-587]"), status="Upcoming")
rec("tool_deferred", openline("TOOL", "retype", "2026-09-25T08:00:00.000Z", " [finding 20260925-agent-dispatch-606]"))
rec("kevin", openline("KEVIN", "signature", "2026-09-25T09:00:00.000Z"), status="Approval")
rec("closed", openline("SITE", "namecheap.com", "2026-09-20T10:00:00.000Z"), status="Completed")
def q(formula, max_records=None, minimal=False):
    if formula.startswith("NOT("):
        return [TASKS["kevin"]]
    want_done = formula.startswith("AND({Status}='Completed'")
    return [json.loads(json.dumps(t)) for t in TASKS.values() if (t["fields"][AF["status"]] == "Completed") == want_done]
m.query_tasks = q
m.finding_states = lambda: {"20260923-agent-dispatch-587": "fixed", "20260925-agent-dispatch-606": "deferred"}
`;

  it('dry read lists every wall, marks the ones that clear now, the stale one and the task closed while blocked', () => {
    const r = py(setup + `
res = m.blockers_scan(sweep=False, now=NOW)
print(json.dumps({"open": {w["task"]: [w["clearsNow"], w["days"], w["findingStatus"]] for w in res["open"]},
                  "stale": [s["task"] for s in res["stale"]], "closed": [c["task"] for c in res["closedWhileBlocked"]],
                  "woken": res["woken"], "writes": len(WRITES), "read": res["openTasksRead"]}))`);
    expect(r.open.site_fixed[0]).toBe(true);
    expect(r.open.tool_fixed[0]).toBe(true);
    expect(r.open.site_open).toEqual([false, 5.1, '']);
    expect(r.open.tool_deferred).toEqual([false, 0.2, 'deferred']);
    expect(r.open.kevin[0]).toBe(false);                  // a KEVIN wall clears only on evidence
    expect(r.stale).toEqual(['site_open']);
    expect(r.closed).toEqual(['closed']);
    expect(r.woken).toEqual([]);
    expect(r.writes).toBe(0);                              // a dry read writes nothing
    expect(r.read).toBe(1);
  });

  it('--sweep wakes exactly the fixed ones: the approved task keeps its verdict, the unapproved one goes back on today', () => {
    const r = py(setup + `
res = m.blockers_scan(sweep=True, now=NOW)
f1, f2 = TASKS["site_fixed"]["fields"], TASKS["tool_fixed"]["fields"]
print(json.dumps({"woken": sorted(w["task"] for w in res["woken"]), "still": sorted(w["task"] for w in res["open"]),
                  "ledger": sorted(LEDGER), "b1": m.task_blocker(f1[AF["notes"]]), "b2": m.task_blocker(f2[AF["notes"]]),
                  "outcome1": f1[AF["outcome"] if "outcome" in AF else AF["approvalOutcome"]], "status1": f1[AF["status"]],
                  "status2": f2[AF["status"]], "due2": f2.get(AF["dueDate"]), "note1": f1[AF["notes"]].split("\\n\\n")[-1]}))`);
    expect(r.woken).toEqual(['site_fixed', 'tool_fixed']);
    expect(r.still).toEqual(['kevin', 'site_open', 'tool_deferred']);
    expect(r.ledger).toEqual([['site_fixed', 'unblocked'], ['tool_fixed', 'unblocked']]);
    expect(r.b1).toBeNull();
    expect(r.b2).toBeNull();
    expect(r.outcome1).toBe('Approved as-is');
    expect(r.status1).toBe('Today');
    expect(r.status2).toBe('Today');
    expect(r.due2).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.note1).toMatch(/BLOCKER CLEARED \(SITE www\.topcashback\.co\.uk\): www\.topcashback\.co\.uk is on the robot's list now, with its sign-in page .*Carry on from where you stopped and finish the job/);
  });

  it('an "unblocked" ledger event ends the idle rest at once, so the next poll picks the approved task up', () => {
    const r = py(`
t = {"outcome": "Approved as-is", "notes": "", "approvedAt": "2026-09-20T09:00:00.000Z"}
now = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
print(json.dumps([m.idle_handback(t, ("parked", "2026-09-25T11:00:00.000Z"), now), m.idle_handback(t, ("unblocked", "2026-09-25T11:30:00.000Z"), now)]))`);
    expect(r[0]).toMatch(/rests/);
    expect(r[1]).toBe('');
  });

  it('--check fails loudly on a stale wall, a task closed while blocked, and a blind read', () => {
    const r = py(setup + `
a = run(lambda x: sys.exit(m.cmd_blockers(x)), {"sweep": False, "check": True})
m.query_tasks = lambda *a, **k: []
b = run(lambda x: sys.exit(m.cmd_blockers(x)), {"sweep": False, "check": True})
print(json.dumps({"a": a["err"], "b": b["err"]}))`);
    expect(r.a).toBe('1');
    expect(r.b).toBe('1');
  });
});

describe('a sign-in clears a SIGN-IN wall without touching Kevin\'s verdict', () => {
  it('signin_done wakes the blocked task (not the SIGN-IN NEEDED reset that clears the approval)', () => {
    const r = py(`
rec("t1", "[x — agent] BLOCKER OPEN (SIGN-IN www.topcashback.co.uk): signed out Fix: f [since 2026-09-25T08:00:00.000Z]",
    outcome="Approved as-is", approved_at="2026-09-25T07:00:00.000Z")
import tempfile
m.SIGNIN_PICKUP_DIR = tempfile.mkdtemp()
groups = [{"host": "www.topcashback.co.uk", "label": "TopCashback", "tasks": [{"id": "t1", "name": "x", "agent": "property-administration", "blocker": True}]}]
res = m.signin_done("www.topcashback.co.uk", SITES, groups)
f = TASKS["t1"]["fields"]
print(json.dumps({"handed": res["handedBack"], "outcome": f[AF["approvalOutcome"]], "approvedAt": f[AF["approvedAt"]],
                  "b": m.task_blocker(f[AF["notes"]]), "ledger": LEDGER}))`);
    expect(r.handed).toHaveLength(1);
    expect(r.outcome).toBe('Approved as-is');
    expect(r.approvedAt).toBe('2026-09-25T07:00:00.000Z');
    expect(r.b).toBeNull();
    expect(r.ledger).toEqual([['t1', 'unblocked']]);
  });
});

describe('the work itself is never handed to Kevin in the closing line', () => {
  const lines = {
    swinton: 'Kevin visiting TopCashback.co.uk, clicking through to Everywhen (formerly Towergate) landlord/property owners insurance, and completing an online quote for the TNT Management portfolio.',
    chedburgh: 'Flagging that this house has no buildings insurance yet, so someone can get three price quotes for Kevin to look at and buy, nothing bought yet.',
    closeBrothers: "Sends one email to Close Brothers asking for the £58.50 back and no further payments. You'd still need to get the Everywhen insurance quote yourself before 15 October.",
    // shapes the back-test showed are NOT hand-offs
    draft: 'creating this post as a DRAFT in the GoHighLevel planner, for you to open and check.',
    decide: 'closing this task. Kevin needs to decide if the warm lane continues.',
    already: "Nothing sent. This just records that you already pay this card's minimum yourself every month.",
  };
  const out = (tail) => `Report body.\n\n**Carrying this out will involve:** ${tail}`;

  it('the three real insurance lines are caught, the three look-alikes are not', () => {
    const r = py(`print(json.dumps({k: bool(m.work_handoff_problem(v)) for k, v in ${JSON.stringify(Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, out(v)])))}.items()}))`);
    expect(r).toEqual({ swinton: true, chedburgh: true, closeBrothers: true, draft: false, decide: false, already: false });
  });

  it('submit refuses the Swinton line even with a KEVIN ONLY line (the quote was never his), and accepts a line naming only the declared step', () => {
    const agent = 'recwWvBju2ycB63i4';
    const r = py(`
import tempfile, os
m.require_role_agent_live = lambda *a, **k: None
class Reached(Exception): pass
def stop(*a, **k): raise Reached()
m.get_task = stop; m.query_tasks = stop; m.load_login_sites = stop
def submit(text):
    p = os.path.join(tempfile.mkdtemp(), "o.md"); open(p, "w").write(text)
    try:
        return run(m.cmd_submit, {"agent": "${agent}", "task": "t1", "type": "Research", "output_file": p, "tier1": False,
                                   "plain_task": None, "plain_approve": None, "files": [], "receipt": None})["err"]
    except Reached:
        return "REACHED-THE-RECORD"
K = "KEVIN ONLY: purchase: buy the Everywhen policy through the TopCashback link once the quote is saved.\\n\\n"
bad = ${JSON.stringify(out(lines.swinton))}
own = "Report body.\\n\\n**Carrying this out will involve:** saving the Everywhen quote on TopCashback, so that Kevin then buys the policy through the TopCashback link."
mixed = "Report body.\\n\\n**Carrying this out will involve:** Kevin then pays the £20 fee, and someone can get three quotes."
print(json.dumps({"bad": submit(bad), "badDeclared": submit(K + bad), "own": submit(K + own),
                  "ownUndeclared": submit(own), "mixed": submit(K.replace("purchase", "payment") + mixed),
                  "wrong": submit(K.replace("KEVIN ONLY: purchase", "KEVIN ONLY: quote") + own)}))`);
    expect(r.bad).toMatch(/its closing line hands the job to Kevin or 'someone': '.*Kevin visiting/);
    expect(r.badDeclared).toMatch(/A KEVIN ONLY line covers only its own step \(purchase\)/);
    expect(r.own).toBe('REACHED-THE-RECORD');          // passed every text gate and went on to read the task
    expect(r.ownUndeclared).toMatch(/hands the job to Kevin/);
    expect(r.mixed).toMatch(/someone can get/);        // the declared payment is covered, the quotes are not
    expect(r.wrong).toMatch(/KEVIN ONLY line names 'quote'/);
  });
});

describe('retype changes the label, never what Kevin approved', () => {
  const email = 'TO: monika@example.com\nFROM: kevinbrittain@gmail.com\nSUBJECT: RE: Renewal\n---\nHi Monika,\n\nThank you. I will be in touch before 3 October.\n\nKind regards,\nKevin Brittain\n\n**Carrying this out will involve:** sending the reply to Monika.';
  const brief = 'CHECKED: handled=no; roy=no; machine=no; open-task=no; trigger=deadline\n\n---\n\nRENEWAL BRIEF\n\n' + email;

  it('an approved Admin task whose text IS an email becomes Correspondence; the verdict and text are untouched', () => {
    const r = py(`
rec("t1", outcome="Approved with minor edits", approved_at="2026-09-23T23:26:49.360Z")
TASKS["t1"]["fields"][AF["agentOutput"]] = ${JSON.stringify(email)}
TASKS["t1"]["fields"][AF["taskType"]] = "Admin"
res = run(m.cmd_retype, {"task": "t1", "type": "Correspondence", "reason": "The approved text is the email; it was filed as Admin."})
f = TASKS["t1"]["fields"]
print(json.dumps({"err": res["err"], "type": f[AF["taskType"]], "outcome": f[AF["approvalOutcome"]], "at": f[AF["approvedAt"]],
                  "same": f[AF["agentOutput"]] == ${JSON.stringify(email)}, "note": m.RETYPED_MARK in f[AF["notes"]]}))`);
    expect(r).toEqual({ err: null, type: 'Correspondence', outcome: 'Approved with minor edits', at: '2026-09-23T23:26:49.360Z', same: true, note: true });
  });

  it('refuses when the approved text is a briefing the send path cannot read (the real PIB card), and any other type on an approved task', () => {
    const r = py(`
rec("t1", outcome="Approved with minor edits")
TASKS["t1"]["fields"][AF["agentOutput"]] = ${JSON.stringify(brief)}
TASKS["t1"]["fields"][AF["taskType"]] = "Admin"
a = run(m.cmd_retype, {"task": "t1", "type": "Correspondence", "reason": "x"})
b = run(m.cmd_retype, {"task": "t1", "type": "Research", "reason": "x"})
print(json.dumps({"a": a["err"], "b": b["err"], "writes": len(WRITES)}))`);
    expect(r.a).toMatch(/does not parse as an email/);
    expect(r.b).toMatch(/may only be retyped INTO Correspondence/);
    expect(r.writes).toBe(0);
  });
});

describe('Kevin sees it: the Estate status row and the 08:00 line', () => {
  const ESTATE = resolve(ROOT, 'scripts/estate-status.py');
  function est(snippet) {
    const script = `
import importlib.util, json, os, tempfile, time
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location('e', ${JSON.stringify(ESTATE)})
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)
${snippet}
`;
    return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
  }
  const sweep = {
    openTasksRead: 1, woken: [], closedWhileBlocked: [], sitesError: '', findingsError: '',
    open: [
      { task: 'a', name: 'n', kind: 'SITE', subject: 'namecheap.com', fix: 'f', days: 5, findingStatus: '' },
      { task: 'b', name: 'n', kind: 'SIGN-IN', subject: 'www.topcashback.co.uk', fix: 'f', days: 0.1, findingStatus: '' },
      { task: 'c', name: 'n', kind: 'KEVIN', subject: 'purchase', fix: 'f', days: 1, findingStatus: '' },
      { task: 'd', name: 'n', kind: 'TOOL', subject: 'retype', fix: 'f', days: 1, findingStatus: 'deferred' },
      { task: 'e', name: 'n', kind: 'TOOL', subject: 'node', fix: 'f', days: 1, findingStatus: 'open' },
    ],
  };

  it('the row names what only Kevin can clear, in plain words, and goes red on a stale wall', () => {
    const r = est(`
s = ${JSON.stringify(sweep)}
fine = dict(s, open=s["open"][1:], stale=[])
red = dict(s, stale=[s["open"][0]])
print(json.dumps([e.blockers_summary(fine)[:2], e.blockers_summary(red)[:2], e.blockers_summary(dict(s, open=[], stale=[]))[:2],
                  e.blockers_summary(dict(s, openTasksRead=0))[0]]))`);
    expect(r[0][0]).toBe('Worked');
    expect(r[0][1]).toBe("Robots blocked on 4 tasks. For you: sign the robot in to www.topcashback.co.uk; 1 step only you can do (purchase); 1 task need a Claude Code session to fix the robot. 1 task waiting on the daily robot fix.");
    expect(r[1][0]).toBe('Failed');
    expect(r[1][1]).toMatch(/add namecheap\.com to the robot's list \(Add a new site\).*1 task blocked 3 days or more\./);
    expect(r[2]).toEqual(['Worked', 'No robot is blocked.']);
    expect(r[3]).toBe('Failed');   // a blind read is never "nothing blocked"
  });

  it('a sweep file that has stopped being written is a Failed row, never an old "all clear"', () => {
    const r = est(`
d = tempfile.mkdtemp(); p = os.path.join(d, "b.json")
json.dump({"openTasksRead": 1, "open": [], "stale": [], "woken": [], "closedWhileBlocked": []}, open(p, "w"))
old = time.time() - 5 * 3600; os.utime(p, (old, old))
now = datetime.now(timezone.utc)
print(json.dumps([e.blockers_row(now, path=p)["status"], e.blockers_row(now, path=p)["detail"][:60], e.blockers_row(now, path=os.path.join(d, "none"))["status"]]))`);
    expect(r).toEqual(['Failed', 'The blocker sweep has not run for 5 hours. It runs every 30 ', 'Failed']);
  });

  it('the 08:00 message carries the row, says nothing when nothing is blocked, and says so when it cannot read it', async () => {
    const { blockersLine, buildDigestText, buildContentOnlyText } = await import('../scripts/slack-automation/approvals.js');
    const now = new Date('2026-09-26T07:00:00Z');
    const line = blockersLine({ fields: { Detail: "Robots blocked on 1 task. For you: add namecheap.com to the robot's list (Add a new site).", Updated: '2026-09-26T06:40:00Z' } }, now);
    expect(line).toContain("*Robots blocked on 1 task. For you: add namecheap.com to the robot's list (Add a new site).*");
    expect(line).toContain('#tab=estate');
    expect(blockersLine({ fields: { Detail: 'No robot is blocked.', Updated: '2026-09-26T06:40:00Z' } }, now)).toBe('');
    expect(blockersLine(null, now)).toBe('');
    expect(blockersLine(undefined, now)).toMatch(/could not be read this morning/);
    expect(blockersLine({ fields: { Detail: 'Robots blocked on 1 task.', Updated: '2026-09-25T06:40:00Z' } }, now)).toMatch(/24 hours ago: the blocker check has stopped/);
    expect(buildDigestText(2, ['A', 'B'], 'u', false, [], 0, '', line)).toContain('Robots blocked on 1 task');
    expect(buildContentOnlyText('C', line)).toContain('Robots blocked on 1 task');
  });
});

describe('the review of 25 Sep 2026: walls that could never clear, or cleared wrongly', () => {
  it('a SIGN-IN wall is stored and listed under the door the sign-in app opens, and that tap clears it', () => {
    const r = py(`
SITES["signin.account.gov.uk"] = {"label": "GOV.UK One Login", "login": True, "loginUrl": "https://ewf.companieshouse.gov.uk/"}
SITES["ewf.companieshouse.gov.uk"] = {"label": "Companies House WebFiling", "login": True, "loginUrl": "https://ewf.companieshouse.gov.uk/"}
rec("t1", outcome="Approved as-is", approved_at="2026-09-25T07:00:00.000Z")
res = run(m.cmd_block, {"task": "t1", "kind": "SIGN-IN", "subject": "signin.account.gov.uk", "why": "Signed out.", "finding": None})
stored = m.task_blocker(notes("t1"))["subject"]
m.query_tasks = lambda f, **k: [json.loads(json.dumps(TASKS["t1"]))] if "SIGN-IN" in f else []
import tempfile
m.SIGNIN_PICKUP_DIR = tempfile.mkdtemp()
groups = m.signin_waiting(SITES)
door = m.signin_site_for("", "https://ewf.companieshouse.gov.uk/", SITES)
done = m.signin_done(door, SITES, groups)
print(json.dumps({"err": res["err"], "stored": stored, "groups": [g["host"] for g in groups], "door": door,
                  "handed": [h["task"] for h in done["handedBack"]], "open": m.task_blocker(notes("t1"))}))`);
    expect(r.err).toBeNull();
    expect(r.stored).toBe('ewf.companieshouse.gov.uk');   // the host the session check is logged under
    expect(r.groups).toEqual(['ewf.companieshouse.gov.uk']);
    expect(r.door).toBe('ewf.companieshouse.gov.uk');
    expect(r.handed).toEqual(['t1']);
    expect(r.open).toBeNull();
  });

  it('a site kept on per-flat profiles (Utilita) is on the list: SITE is refused, so no wall is created that can never clear', () => {
    const r = py(`
SITES["my.utilita.co.uk"] = {"label": "Utilita", "login": True, "profiles": [{"profile": "flat1", "label": "Flat 1"}]}
rec("t1")
print(json.dumps(run(m.cmd_block, {"task": "t1", "kind": "SITE", "subject": "my.utilita.co.uk", "why": "x", "finding": None})["err"]))`);
    expect(r).toMatch(/IS on the robot's list/);
  });

  it('a wall and its wake keep an earlier carry-out intent open, so the woken run still checks what already happened', () => {
    const r = py(`
import tempfile, os
m.INTENT_LEDGER = os.path.join(tempfile.mkdtemp(), "l.jsonl")
with open(m.INTENT_LEDGER, "w") as fh:
    for e in ("intent", "parked", "unblocked"):
        fh.write(json.dumps({"task": "t1", "ts": "2026-09-25T10:00:00Z", "event": e}) + "\\n")
print(json.dumps(sorted(m.open_intents())))`);
    expect(r).toEqual(['t1']);
  });

  it('the pickup run works a task the sign-in woke through its wall (new, approved, or a redo he asked for); a plain agent note is not that', () => {
    const r = py(`
from datetime import datetime
now = datetime.now(m.LONDON)
stamp = now.strftime("%d %b %Y %H:%M")
woke = f"[{stamp} — Robot sign-in] BLOCKER CLEARED (SIGN-IN www.topcashback.co.uk): Kevin signed in to TopCashback (www.topcashback.co.uk). The session is live now. Carry on."
agent = f"[{stamp} — agent] BLOCKER CLEARED (SIGN-IN www.topcashback.co.uk): evidence: saw the account page."
print(json.dumps([bool(m.signin_reopened_reason({"status": "Today", "outcome": "", "notes": woke})),
                  bool(m.signin_reopened_reason({"status": "Today", "outcome": "Approved as-is", "notes": woke})),
                  bool(m.signin_reopened_reason({"status": "Today", "outcome": "Changes requested", "notes": woke})),
                  bool(m.signin_reopened_reason({"status": "Today", "outcome": "", "notes": agent}))]))`);
    expect(r).toEqual([true, true, true, false]);   // a redo Kevin asked for is worked too (25 Sep 2026)
  });

  it('a resubmit supersedes the old wall, and a declared step opens (only) its own KEVIN wall', () => {
    const r = py(`
o = "[x — agent] BLOCKER OPEN (SITE namecheap.com): why Fix: f [since 2026-09-25T08:00:00.000Z]"
k = {"reason": "payment", "step": "pay the £12 renewal"}
a = m.submit_wall_notes(o, None)
b = m.submit_wall_notes(o, k)
c = m.submit_wall_notes(b, k)
d = m.submit_wall_notes("", None)
print(json.dumps([m.task_blocker(a), m.task_blocker(b), c, d, b.count("BLOCKER CLEARED (SITE namecheap.com): superseded")]))`);
    expect(r[0]).toBeNull();
    expect(r[1]).toMatchObject({ kind: 'KEVIN', subject: 'payment', why: 'pay the £12 renewal' });
    expect(r[2]).toBeNull();     // the same KEVIN wall already open: nothing written
    expect(r[3]).toBeNull();
    expect(r[4]).toBe(1);
  });

  it("Kevin's Reject is not a close while blocked: the query leaves Rejected cards out", () => {
    const r = py(`
F = []
def q(formula, max_records=None, minimal=False):
    F.append(formula); return [{"id": "c", "fields": {AF["notes"]: "", AF["status"]: "Today"}}]
m.query_tasks = q
m.finding_states = lambda: {}
m.blockers_scan(sweep=False)
print(json.dumps([f for f in F if f.startswith("AND({Status}='Completed'")]))`);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("NOT({Approval Outcome}='Rejected')");
  });

  it('annotate cannot write or clear a wall; only block, unblock with evidence and the sweep can', () => {
    const r = py(`
rec("t1", outcome="Approved as-is")
run(m.cmd_block, {"task": "t1", "kind": "KEVIN", "subject": "payment", "why": "Kevin pays.", "finding": None})
a = run(m.cmd_annotate, {"task": "t1", "note": "BLOCKER CLEARED (KEVIN payment): paid"})
print(json.dumps({"err": a["err"], "still": m.task_blocker(notes("t1"))["kind"]}))`);
    expect(r.err).toMatch(/writes a blocker line/);
    expect(r.still).toBe('KEVIN');
  });

  it('a TOOL wall with a mistyped finding id is refused, so it cannot sit "being fixed" for ever', () => {
    const r = py(`
rec("t1")
m.finding_states = lambda: {"20260925-agent-dispatch-606": "open"}
a = run(m.cmd_block, {"task": "t1", "kind": "TOOL", "subject": "retype", "why": "x", "finding": "606"})
b = run(m.cmd_block, {"task": "t1", "kind": "TOOL", "subject": "retype", "why": "x", "finding": "20260925-agent-dispatch-606"})
print(json.dumps([a["err"], b["err"], m.task_blocker(notes("t1"))["finding"]]))`);
    expect(r[0]).toMatch(/is not a finding in the queue/);
    expect(r[1]).toBeNull();
    expect(r[2]).toBe('20260925-agent-dispatch-606');
  });

  it('blocked work Kevin has not approved rests a day too, and wakes when the wall clears or his verdict moves', () => {
    const r = py(`
now = datetime(2026, 9, 25, 12, 0, tzinfo=timezone.utc)
n = "[x — agent] BLOCKER OPEN (SITE namecheap.com): why Fix: f [since 2026-09-25T10:00:00.000Z]"
t = {"outcome": "", "notes": n, "approvedAt": ""}
print(json.dumps([m.blocked_rest(t, ("parked", "2026-09-25T10:00:00.000Z"), now),
                  m.blocked_rest(t, ("unblocked", "2026-09-25T11:00:00.000Z"), now),
                  m.blocked_rest(dict(t, approvedAt="2026-09-25T11:00:00.000Z"), ("parked", "2026-09-25T10:00:00.000Z"), now),
                  m.blocked_rest(dict(t, notes=""), ("parked", "2026-09-25T10:00:00.000Z"), now),
                  m.blocked_rest(t, ("parked", "2026-09-24T10:00:00.000Z"), now),
                  m.blocked_rest(dict(t, outcome="Approved as-is"), ("parked", "2026-09-25T10:00:00.000Z"), now)]))`);
    expect(r[0]).toMatch(/^blocked on SITE namecheap\.com since 2026-09-25T10:00; rests 2[0-2]h more/);
    expect(r.slice(1)).toEqual(['', '', '', '', '']);
  });

  it('a SIGN-IN wall also clears when the browser ledger shows the session live after the wall', () => {
    const r = py(`
b = {"kind": "SIGN-IN", "subject": "www.topcashback.co.uk", "since": "2026-09-25T08:00:00.000Z", "finding": ""}
m.ledger_session_verdict = lambda h, max_age_minutes=None, **k: {"signedIn": True, "at": "2026-09-25T09:00:00.000Z", "url": "", "source": "ledger"}
live = m.blocker_clear_reason(b, SITES, {})
m.ledger_session_verdict = lambda h, max_age_minutes=None, **k: {"signedIn": True, "at": "2026-09-25T07:00:00.000Z", "url": "", "source": "ledger"}
before = m.blocker_clear_reason(b, SITES, {})
m.ledger_session_verdict = lambda h, max_age_minutes=None, **k: {"signedIn": False, "at": "2026-09-25T09:00:00.000Z", "url": "", "source": "ledger"}
out = m.blocker_clear_reason(b, SITES, {})
print(json.dumps([live, before, out]))`);
    expect(r[0]).toMatch(/session on www\.topcashback\.co\.uk was live at 2026-09-25T09:00/);
    expect(r[1]).toBe('');
    expect(r[2]).toBe('');
  });
});

describe('the second review of 25 Sep 2026', () => {
  it('submit refuses while a SIGN-IN, SITE or TOOL wall stands (it would bury it), but a KEVIN wall may come back as a new card', () => {
    const agent = 'recwWvBju2ycB63i4';
    const r = py(`
import tempfile, os
m.require_role_agent_live = lambda *a, **k: None
class Reached(Exception): pass
def submit(wall):
    n = f"[x — agent] BLOCKER OPEN ({wall}): why Fix: f [since 2026-09-25T08:00:00.000Z]"
    calls = []
    def g(i):
        calls.append(i)
        if len(calls) > 1: raise Reached()
        return {"id": i, "fields": {AF["notes"]: n, AF["status"]: "Today"}}
    m.get_task = g; m.query_tasks = lambda *a, **k: (_ for _ in ()).throw(Reached())
    m.load_login_sites = lambda: (_ for _ in ()).throw(Reached())
    p = os.path.join(tempfile.mkdtemp(), "o.md")
    open(p, "w").write("Report body.\\n\\n**Carrying this out will involve:** sending the saved quote summary to the file.")
    try:
        return run(m.cmd_submit, {"agent": "${agent}", "task": "t1", "type": "Research", "output_file": p, "tier1": False,
                                   "plain_task": None, "plain_approve": None, "files": [], "receipt": None})["err"]
    except Reached:
        return "PAST-THE-WALL-GATE"
print(json.dumps({w: submit(w) for w in ("SITE namecheap.com", "TOOL retype", "SIGN-IN www.topcashback.co.uk", "KEVIN payment")}))`);
    expect(r['SITE namecheap.com']).toMatch(/refusing to submit t1: it is blocked \(SITE namecheap\.com/);
    expect(r['SITE namecheap.com']).toMatch(/unblock t1 --evidence/);
    expect(r['TOOL retype']).toMatch(/it is blocked \(TOOL retype/);
    expect(r['SIGN-IN www.topcashback.co.uk']).toMatch(/it is blocked \(SIGN-IN/);
    expect(r['KEVIN payment']).not.toMatch(/it is blocked/);
  });

  it('submit refuses a task someone cancelled while the agent worked on it (the withdrawn tenant card, 25 Sep 2026)', () => {
    const agent = 'recwWvBju2ycB63i4';
    const r = py(`
import tempfile, os
m.require_role_agent_live = lambda *a, **k: None
class Reached(Exception): pass
def submit(status):
    calls = []
    def g(i):
        calls.append(i)
        if len(calls) > 1: raise Reached()
        return {"id": i, "fields": {AF["notes"]: "TENANT CHAIN SUPERSEDED: withdrawn", AF["status"]: status}}
    m.get_task = g; m.query_tasks = lambda *a, **k: (_ for _ in ()).throw(Reached())
    m.load_login_sites = lambda: (_ for _ in ()).throw(Reached())
    p = os.path.join(tempfile.mkdtemp(), "o.md")
    open(p, "w").write("Report body.\\n\\n**Carrying this out will involve:** sending the saved quote summary to the file.")
    try:
        return run(m.cmd_submit, {"agent": "${agent}", "task": "t1", "type": "Research", "output_file": p, "tier1": False,
                                   "plain_task": None, "plain_approve": None, "files": [], "receipt": None})["err"]
    except Reached:
        return "PAST-THE-GATE"
print(json.dumps({s: submit(s) for s in ("Cancelled", "Today")}))`);
    expect(r.Cancelled).toMatch(/refusing to submit t1: it was cancelled while you worked on it/);
    expect(r.Today).not.toMatch(/cancelled while you worked/);
  });

  it('a declared step covers only its own verb in the phrase: the Chedburgh quotes and "someone can post" stay refused', () => {
    const r = py(`
def o(k, tail): return f"KEVIN ONLY: {k}: the step\\n\\nReport.\\n\\n**Carrying this out will involve:** {tail}"
def ks(t): return m.kevin_only_step(t)
cases = {
  "chedburgh": o("purchase", "Flagging that this house has no buildings insurance yet, so someone can get three price quotes for Kevin to look at and buy, nothing bought yet."),
  "post": o("physical", "someone can post the letter to the council."),
  "pays": o("payment", "sending the reply. Kevin then pays the £45 invoice by bank transfer."),
  "sign": o("signature", "sending the agreement link, for Kevin to sign before 15 October."),
  "far": o("signature", "Kevin visiting TopCashback and completing the quote before signing the agreement."),
  "someonePays": o("payment", "sending the reminder, so someone can pay the £45 invoice."),
}
print(json.dumps({k: bool(m.work_handoff_problem(v, ks(v))) for k, v in cases.items()}))`);
    expect(r).toEqual({ chedburgh: true, post: true, pays: false, sign: false, far: true, someonePays: true });
  });

  // RUN the prompt through bash, never grep it (second review, 25 Sep 2026): a
  // bare "<what you saw>" inside the double-quoted prompt made bash read
  // `<what` as a redirect, so the poll died before Claude started and no
  // approved hand-back would ever have been worked. `bash -n` passed.
  it('both robot prompts survive bash, and carry an approved woken task out and close it, never submit it', () => {
    for (const f of ['scripts/handback-poll-run.sh', 'scripts/signin-pickup-run.sh']) {
      const lines = readFileSync(resolve(ROOT, f), 'utf8').split('\n');
      const start = lines.findIndex(l => l.startsWith('"$CLAUDE" -p "'));
      const end = lines.findIndex((l, i) => i > start && /^\s+--add-dir /.test(l));
      expect(start, f).toBeGreaterThan(0);
      expect(end, f).toBeGreaterThan(start);
      const call = lines.slice(start, end).join('\n').replace(/^"\$CLAUDE"/, 'stub').replace(/\s*\\$/, '');
      const dir = mkdtempSync(resolve(tmpdir(), 'prompt-'));
      const script = resolve(dir, 'run.sh');
      writeFileSync(script, `set -e\ncd "${dir}"\nstub() { printf '%s' "$2" > "${dir}/prompt.txt"; }\n${call}\n`);
      execFileSync('bash', [script], { encoding: 'utf8' });   // throws on "what: No such file or directory"
      const prompt = readFileSync(resolve(dir, 'prompt.txt'), 'utf8');
      expect(prompt, f).toMatch(/is CARRIED OUT and closed with complete .*NEVER submitted: a submit wipes Kevin's approval/);
      expect(prompt, f).toContain('block TASKID --kind SIGN-IN --subject <host> --why "<what you saw>" and stop.');
    }
  });
});

describe('per-flat sign-ins (Utilita): the wall names its flat, and the sweep clears it when that flat is signed in', () => {
  const UTIL = `
SITES["my.utilita.co.uk"] = {"label": "Utilita", "login": True, "profiles": [
  {"profile": "utilita-apt1", "label": "Apartment 1", "loginUrl": "https://my.utilita.co.uk/energy"},
  {"profile": "utilita-apt2", "label": "Apartment 2", "loginUrl": "https://my.utilita.co.uk/energy"}]}
`;
  it('block needs --profile on a per-flat site, records it, and two flats are two walls', () => {
    const r = py(UTIL + `
rec("t1")
a = run(m.cmd_block, {"task": "t1", "kind": "SIGN-IN", "subject": "my.utilita.co.uk", "why": "Signed out.", "finding": None})
b = run(m.cmd_block, {"task": "t1", "kind": "SIGN-IN", "subject": "my.utilita.co.uk", "why": "Flat 1 signed out.", "finding": None, "profile": "utilita-apt1"})
first = m.task_blocker(notes("t1"))
c = run(m.cmd_block, {"task": "t1", "kind": "SIGN-IN", "subject": "my.utilita.co.uk", "why": "Flat 2 signed out.", "finding": None, "profile": "utilita-apt2"})
print(json.dumps({"a": a["err"], "b": b["err"], "first": first, "second": m.task_blocker(notes("t1")), "lines": notes("t1").count("BLOCKER OPEN")}))`);
    expect(r.a).toMatch(/keeps one sign-in per profile. Name which one: --profile utilita-apt1 \| utilita-apt2/);
    expect(r.b).toBeNull();
    expect(r.first).toMatchObject({ kind: 'SIGN-IN', subject: 'my.utilita.co.uk', profile: 'utilita-apt1', why: 'Flat 1 signed out.' });
    expect(r.second.profile).toBe('utilita-apt2');
    expect(r.lines).toBe(2);
  });

  it("the sweep walks that flat's own door and clears the wall when it is signed in; a dry read never walks", () => {
    const r = py(UTIL + `
b = {"kind": "SIGN-IN", "subject": "my.utilita.co.uk", "since": "2026-09-25T08:00:00.000Z", "finding": "", "profile": "utilita-apt1"}
m.ledger_session_verdict = lambda *a, **k: None
W = []
def walk(host, profile=None, url=None):
    W.append([host, profile, url]); return {"signedIn": True}
live = m.blocker_clear_reason(b, SITES, {}, walk=walk)
dry = m.blocker_clear_reason(b, SITES, {}, walk=None)
out = m.blocker_clear_reason(b, SITES, {}, walk=lambda h, profile=None, url=None: {"signedIn": False})
print(json.dumps([live, dry, out, W]))`);
    expect(r[0]).toMatch(/session on my\.utilita\.co\.uk \(utilita-apt1\) is live/);
    expect(r[1]).toBe('');
    expect(r[2]).toBe('');
    expect(r[3]).toEqual([['my.utilita.co.uk', 'utilita-apt1', 'https://my.utilita.co.uk/energy']]);
  });
});

describe('a blocked task is never escalated to Kevin as a decision', () => {
  it('escalate refuses a task with an open wall and writes nothing; a task without one still escalates', () => {
    const r = py(`
m.TASKMGR_REC_ID = "recTM"
rec("t1", "[x — agent] BLOCKER OPEN (SIGN-IN ewf.companieshouse.gov.uk): signed out Fix: f [since 2026-09-25T11:36:00.000Z]")
a = run(m.cmd_escalate, {"task": "t1", "reason": "blocked by a code defect"})
w1 = len(WRITES)
rec("t2", "")
b = run(m.cmd_escalate, {"task": "t2", "reason": "which quote do you want?"})
print(json.dumps({"a": a["err"], "writesAfterA": w1, "b": b["err"], "t2": TASKS["t2"]["fields"][AF["status"]]}))`);
    expect(r.a).toMatch(/is blocked \(SIGN-IN ewf\.companieshouse\.gov\.uk\), so it is not a decision for Kevin/);
    expect(r.writesAfterA).toBe(0);
    expect(r.b).toBeNull();
    expect(r.t2).toBe('Approval');
  });
});
