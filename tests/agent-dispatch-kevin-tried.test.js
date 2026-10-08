import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// HIS TRY IS ASKED FOR ONCE (Kevin, 8 Oct 2026): "There are a lot of them that ask me to sign in or
// say Add this site. Every time I add it or every time I try and sign in, it doesn't disappear. It just
// keeps asking." On that day a broker portal's wall had three of his windows close and every robot
// check after each still landed on its login page; the agent re-opened the wall after each try, so it
// asked again. A SIGN-IN or SITE wall his own try did not clear goes back to its agent, and `block` and
// submit refuse to raise it again for a week. These drive the real blockers_scan, cmd_block and
// cmd_submit with Airtable stubbed; the browser ledger is a temp file. Hosts are invented.
function py(snippet, ledgerLines) {
  const dir = mkdtempSync(tmpdir() + '/od-kevin-tried-');
  const ledger = dir + '/runs.jsonl';
  writeFileSync(ledger, (ledgerLines || []).map((l) => JSON.stringify(l)).join('\n') + '\n');
  const script = `
import importlib.util, json, os, io, contextlib, tempfile
from datetime import datetime, timezone, timedelta
os.environ["SIGNIN_SKIP_WALK"] = "1"
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
AF = m.AF
TASKS, WRITES, LEDGER = {}, [], []
def rec(i, notes="", status="Today", outcome="", name="INSURANCE: Example cover", approved_at=""):
    TASKS[i] = {"id": i, "createdTime": "2026-09-20T09:00:00.000Z", "fields": {
        AF["notes"]: notes, AF["status"]: status, AF["approvalOutcome"]: outcome, AF["name"]: name,
        AF["approvedAt"]: approved_at, AF["sentForApprovalBy"]: ["recAgentAaaaaaaaa"],
        AF["teamMember"]: ["recAgentAaaaaaaaa"]}}
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
m.finding_states = lambda: {}
SITES = {"portal.broker.example": {"label": "Broker portal", "login": True, "loginUrl": "https://portal.broker.example/login"},
         "www.clips.example": {"label": "Clips (public reads)", "login": False},
         "clips.example": {"label": "clips.example", "login": True, "loginUrl": "https://clips.example/"},
         "cover.example": {"label": "Cover (landing pages)", "login": False},
         "quotes.cover-insurer.example": {"label": "Cover quotes", "login": True, "loginUrl": "https://quotes.cover-insurer.example/"}}
m.load_login_sites = lambda: SITES
m.BROWSER_LEDGER = ${JSON.stringify(ledger)}
m.HANDOVER_DIR = "/nonexistent/od-test-handover"
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
    return err
def notes(i): return TASKS[i]["fields"][AF["notes"]]
def f(i, k): return TASKS[i]["fields"].get(AF[k])
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const H = 3600e3;
const blk = (kind, subject, since) => `[x — agent] BLOCKER OPEN (${kind} ${subject}): why Fix: f [since ${since}]`;
const login = (at, host, extra = {}) => ({ at, cmd: 'login', host, profile: 'default', mode: 'plain-chrome-mock-keychain', ...extra });
const out = (at, site) => ({ at, cmd: 'session', site, url: `https://${site}/login`, signedIn: false, signinPage: true, profile: 'default' });
const seen = (at, site) => ({ at, cmd: 'session', site, url: `https://${site}/account`, signedIn: true, signinPage: false, profile: 'default' });

describe('a wall his own try did not clear goes back to its agent', () => {
  it('a SIGN-IN wall re-opened after his window, with the robot still signed out, is sent back with the route', () => {
    const P = 'portal.broker.example';
    const r = py(`
rec("failed", notes="${blk('SIGN-IN', P, iso(1 * H))}")
res = m.blockers_scan(sweep=True)
print(json.dumps({"woken": [w["task"] for w in res["woken"]], "reason": res["woken"][0]["reason"] if res["woken"] else "",
                  "wall": m.task_blocker(notes("failed")), "status": f("failed", "status"), "ledger": LEDGER}))`,
    [login(iso(3 * H), P), out(iso(3 * H - 60e3), P)]);
    expect(r.woken).toEqual(['failed']);
    expect(r.reason).toMatch(/^Kevin's sign-in window on portal\.broker\.example closed at .* and the robot's next check still landed on the sign-in page/);
    expect(r.reason).toMatch(/Asking Kevin again cannot get the robot in.*KEVIN ONLY: credential/);
    expect(r.wall).toBeNull();
    expect(r.status).toBe('Today');
    expect(r.ledger).toEqual([['failed', 'unblocked']]);
  });

  it('a wall stays when the robot got in after his window, when nothing was read yet, or when his try is over a week old', () => {
    const P = 'portal.broker.example';
    const cases = {
      gotIn: [login(iso(3 * H), P), out(iso(3 * H - 60e3), P), seen(iso(2 * H), P)],
      noRead: [login(iso(3 * H), P)],
      old: [login(iso(8 * 24 * H), P), out(iso(8 * 24 * H - 60e3), P)],
    };
    const res = {};
    for (const [k, lines] of Object.entries(cases)) {
      res[k] = py(`
rec("t1", notes="${blk('SIGN-IN', P, iso(1 * H))}")
res = m.blockers_scan(sweep=True)
print(json.dumps([w["task"] for w in res["woken"]]))`, lines);
    }
    expect(res).toEqual({ gotIn: [], noRead: [], old: [] });
  });

  it('a SITE wall answered on another address tells the agent that address; one answered on a parent is left for the new button', () => {
    const r = py(`
rec("answered", notes="${blk('SITE', 'cover.example', iso(5 * H))}")
rec("parent", notes="${blk('SITE', 'www.clips.example', iso(5 * H))}")
res = m.blockers_scan(sweep=True)
print(json.dumps({"woken": sorted(w["task"] for w in res["woken"]), "reason": [w["reason"] for w in res["woken"]],
                  "still": sorted(w["task"] for w in res["open"])}))`,
    [login(iso(2 * H), 'quotes.cover-insurer.example', { forWall: 'cover.example' }), login(iso(2 * H), 'clips.example')]);
    expect(r.woken).toEqual(['answered']);
    expect(r.reason[0]).toMatch(/^Kevin answered this wall by signing in at quotes\.cover-insurer\.example .*use quotes\.cover-insurer\.example/);
    expect(r.still).toEqual(['parent']);
  });
});

describe('the same wall is refused for a week after his try', () => {
  it('block refuses SIGN-IN after a failed try, and SITE after an answered one; a clean site is untouched', () => {
    const P = 'portal.broker.example';
    const r = py(`
rec("t1"); rec("t2"); rec("t3")
a = run(m.cmd_block, {"task": "t1", "kind": "SIGN-IN", "subject": "${P}", "why": "Signed out.", "finding": None})
b = run(m.cmd_block, {"task": "t2", "kind": "SITE", "subject": "cover.example", "why": "Not a sign-in site.", "finding": None})
c = run(m.cmd_block, {"task": "t3", "kind": "SITE", "subject": "www.clips.example", "why": "Public reads only.", "finding": None})
print(json.dumps({"a": a, "b": b, "c": c, "walls": [m.task_blocker(notes(i)) is not None for i in ("t1", "t2", "t3")]}))`,
    [login(iso(30 * H), P), out(iso(30 * H - 60e3), P),
     login(iso(30 * H), 'quotes.cover-insurer.example', { forWall: 'cover.example' })]);
    expect(r.a).toMatch(/^ERROR: refusing a SIGN-IN wall on portal\.broker\.example: Kevin's sign-in window/);
    expect(r.a).toMatch(/KEVIN ONLY: credential/);
    expect(r.b).toMatch(/^ERROR: refusing a SITE wall on cover\.example: Kevin answered this wall by signing in at quotes\.cover-insurer\.example/);
    expect(r.c).toBeNull();
    expect(r.walls).toEqual([false, false, true]);
  });

  it('submit refuses a SIGN-IN NEEDED line for a site his try did not get the robot into', () => {
    const P = 'portal.broker.example';
    const r = py(`
m.require_role_agent_live = lambda *a, **k: None
class Reached(Exception): pass
def stop(*a, **k): raise Reached()
m.get_task = stop
def submit(text):
    p = os.path.join(tempfile.mkdtemp(), "o.md"); open(p, "w").write(text)
    try:
        return run(m.cmd_submit, {"agent": "recwWvBju2ycB63i4", "task": "t1", "type": "Research", "output_file": p, "tier1": False,
                                   "plain_task": None, "plain_approve": None, "files": [], "receipt": None})
    except Reached:
        return "REACHED-THE-RECORD"
body = "Report body. " * 30 + "\\n\\nSIGN-IN NEEDED: Broker portal (https://${P}/login)\\n\\n**Carrying this out will involve:** reading the policy schedule."
print(json.dumps({"tried": submit(body)}))`,
    [login(iso(30 * H), P), out(iso(30 * H - 60e3), P)]);
    expect(r.tried).toMatch(/^ERROR: refusing to submit t1 — its SIGN-IN NEEDED line names 'Broker portal', but Kevin's sign-in window/);
  });

  it('back-to-back: with no try on the ledger the same SIGN-IN NEEDED line reaches the record', () => {
    const P = 'portal.broker.example';
    const r = py(`
m.require_role_agent_live = lambda *a, **k: None
class Reached(Exception): pass
def stop(*a, **k): raise Reached()
m.get_task = stop
p = os.path.join(tempfile.mkdtemp(), "o.md")
open(p, "w").write("Report body. " * 30 + "\\n\\nSIGN-IN NEEDED: Broker portal (https://${P}/login)\\n\\n**Carrying this out will involve:** reading the policy schedule.")
try:
    got = run(m.cmd_submit, {"agent": "recwWvBju2ycB63i4", "task": "t1", "type": "Research", "output_file": p, "tier1": False,
                              "plain_task": None, "plain_approve": None, "files": [], "receipt": None})
except Reached:
    got = "REACHED-THE-RECORD"
print(json.dumps({"got": got}))`, []);
    expect(r.got).toBe('REACHED-THE-RECORD');
  });
});
