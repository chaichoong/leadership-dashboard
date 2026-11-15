import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const LOOP = resolve(ROOT, 'scripts/loop-health.py');
const BOARD = resolve(ROOT, 'scripts/task-manager.py');

// A REST HOLDS ONLY WHILE THE TASK IS EXACTLY AS THE REST LEFT IT (15 Nov 2026).
//
// An independent review of PRs 925 and 926 (status updates with nothing to approve, and kept-open
// tasks that rest until a named date) found both rests woke only on a short list of stamped signals
// (a ledger fold, a newer verdict, a new holder). The three ordinary ways a reply reaches an open task
// wrote none of them: Inbox Triage's hand-appended NEW MESSAGE line, a twin closed onto the task as a
// duplicate, and a gate fold whose ledger write was lost. A creditor's final notice could sit on a
// resting task for up to 14 days. Now the event that starts a rest carries a fingerprint of the task,
// and any difference at a later read ends the rest.
//
// Everything here drives the real code: cmd_complete, cmd_submit (and through it file_status_update),
// handle_without_kevin, build_queue, the real history read with a raw Gmail-shaped worker reply,
// loop-health's own functions and the Task Manager's own board view. Airtable is an in-memory store,
// the Gmail worker is a fake HTTP answer, every other network call fails. Names, ids, addresses and
// dates are invented. Each case is one of the review's rows (K, S, E, R) or its duplicate-close case.

const PRE = `
import importlib.util, json, os, io, sys, contextlib, types, tempfile, urllib.request, urllib.error
from datetime import datetime as _dt, timedelta, timezone, date
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
STATE = tempfile.mkdtemp()
m.STATE_DIR = STATE
m.INTENT_LEDGER = os.path.join(STATE, "carryout-intent.jsonl")
m.NOTES_ARCHIVE = STATE
m.HANDOVER_DIR = tempfile.mkdtemp()
m.BROWSER_LEDGER = "/nonexistent/od-test-browser-ledger.jsonl"
AF = m.AF
SHIFT = [timedelta(0)]
class Clock(_dt):
    @classmethod
    def now(cls, tz=None):
        return _dt.now(tz) + SHIFT[0]
m.datetime = Clock
AGENT = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
OTHER = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-researcher"][0]
TODAY = _dt.now(m.LONDON).date()
def day(n): return (TODAY + timedelta(days=n)).isoformat()
CREATED = (_dt.now(timezone.utc) - timedelta(days=12)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
TASKS = {}
def rec(i, notes="", approved=True, desc="Chase Exampleton Council about the bill. Contact: recovery@exampleton-council.test",
        due="", name="Chase: Exampleton Council - council tax account 70012345"):
    f = {AF["name"]: name, AF["status"]: {"name": "Today"}, AF["teamMember"]: [AGENT], AF["notes"]: notes,
         AF["description"]: desc}
    if approved:
        f.update({AF["approvalOutcome"]: {"name": "Approved as-is"}, AF["approvedAt"]: "2026-09-01T09:00:00.000Z",
                  AF["sentForApprovalBy"]: [AGENT]})
    if due:
        f[AF["dueDate"]] = due
    TASKS[i] = {"id": i, "createdTime": CREATED, "fields": f}
    return TASKS[i]
m.get_task = lambda i: json.loads(json.dumps(TASKS[i]))
def patch(i, f):
    TASKS[i]["fields"].update(f)
    return {"id": i}
m.patch_task = patch
m.query_tasks = lambda formula, **kw: [json.loads(json.dumps(t)) for t in TASKS.values()] if formula == m.QUEUE_FORMULA else []
m.fetch_role_roster = lambda: {}
m.finding_details = lambda: {}
m.task_fields_owe_certificate = lambda *a, **k: []
m.task_owes_cost = lambda *a, **k: []
def complete(i, **kw):
    a = dict(task=i, keep_open=True, note="chased the council", until=day(10), no_certificate="", evidence="",
             not_signed="", diary_not_written="", cost_not_written="", not_bought="")
    a.update(kw)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            m.cmd_complete(types.SimpleNamespace(**a))
        return None
    except SystemExit as e:
        return str(e)
QUIET = {"terms": ["email x"], "searched": ["tasks", "Gmail"], "entries": [], "notes": []}
def status_body(line="No reply from the council yet and nothing new has arrived.", nxt=None):
    return (f"STATUS ONLY: {line}\\nNEXT CHECK: {nxt or day(3)}\\n\\nWhat I checked: the council's portal and both inboxes.\\n\\n"
            "TRACK RECORD: none found (searched tasks + Gmail for email recovery@exampleton-council.test)\\n\\n"
            "**Carrying this out will involve:** Nothing. Information only.")
def submit_status(i, body=None, history=None):
    m.history = (lambda **kw: dict(QUIET)) if history is None else history
    fh = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False); fh.write(body or status_body()); fh.close()
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            m.cmd_submit(types.SimpleNamespace(task=i, agent=AGENT, type="Research", output_file=fh.name, tier1=False,
                         attach=None, plain_task="Check whether the council has replied about the bill.",
                         plain_approve="Nothing to approve. The update is listed under Handled without you."))
        return None
    except SystemExit as e:
        return str(e)
def events(i):
    if not os.path.exists(m.INTENT_LEDGER): return []
    return [json.loads(l)["event"] for l in open(m.INTENT_LEDGER) if json.loads(l)["task"] == i]
def queue():
    q = m.build_queue()
    return {"work": sorted(t["id"] for t in q["worklist"] + q["reserve"]),
            "idle": {t["id"]: t.get("restUntil") or t["idleReason"] for t in q["idleHandbacks"]}}
LOOK = "[" + (TODAY - timedelta(days=5)).strftime("%d %b %Y") + " 09:00 — agent-dispatch] SUBMITTED (round 1) as Research with no new file"
`;

function py(snippet, env = {}) {
  const out = execFileSync('python3', ['-c', PRE + snippet], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json'), SIGNIN_SKIP_WALK: '1', ...env },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('a kept-open rest holds only while the task is as the rest left it (findings 1, 2, 14)', () => {
  it('K0 control rests; K2 a NEW MESSAGE line, K3 a fold block with no ledger line, K5 the holder removed and the duplicate close each wake it', () => {
    const r = py(`
ids = ["recK0Aaaaaaaaaaaa", "recK2Aaaaaaaaaaaa", "recK3Aaaaaaaaaaaa", "recK5Aaaaaaaaaaaa", "recKeeperAaaaaaaa", "recK6Aaaaaaaaaaaa"]
for i in ids:
    rec(i)
    assert complete(i) is None
F = lambda i: TASKS[i]["fields"]
# K2: Inbox Triage Step 3, a hand PATCH of the Description, no gate, no ledger event
F("recK2Aaaaaaaaaaaa")[AF["description"]] += "\\n\\nNEW MESSAGE " + day(0) + ": Exampleton Council replied on the same thread. Final notice."
# K3: the gate's own UPDATE block, its ledger write lost
F("recK3Aaaaaaaaaaaa")[AF["description"]] += ("\\n\\nUPDATE " + day(0) + ": new item folded in by the duplicate gate "
                                              "(one subject = one open task).\\nFinal notice. Enforcement agents from the 24th.")
# K5: the holder taken off and Team Member left blank
F("recK5Aaaaaaaaaaaa")[AF["teamMember"]] = []
# K6: another holder
F("recK6Aaaaaaaaaaaa")[AF["teamMember"]] = [OTHER]
# the duplicate close (finding 2): a reply became its own task and closes at Level A onto the resting keeper
rec("recTwinAaaaaaaaaa", approved=False, desc="From recovery@exampleton-council.test: FINAL NOTICE. Enforcement agents from the 24th.",
    name="INBOUND (follow-up): Exampleton Council - council tax account 70012345 final notice")
level = {"level": "A", "category": "close: duplicate", "carry": "close", "keeper": "recKeeperAaaaaaaa",
         "evidence": "folded into keeper recKeeperAaaaaaaa", "money": "log", "amount": 0}
args = types.SimpleNamespace(task="recTwinAaaaaaaaaa", agent=AGENT, type="Admin", plain_task="A duplicate of the council chase.",
                             plain_approve="This duplicate closes.")
with contextlib.redirect_stdout(io.StringIO()):
    m.handle_without_kevin(args, "CLOSE PROPOSAL: duplicate of recKeeperAaaaaaaa", m.get_task("recTwinAaaaaaaaaa"), level, [])
TASKS.pop("recTwinAaaaaaaaaa")
SHIFT[0] = timedelta(hours=1)
print(json.dumps(queue()))`);
    expect(Object.keys(r.idle)).toEqual(['recK0Aaaaaaaaaaaa']);
    expect(r.work).toEqual(['recK2Aaaaaaaaaaaa', 'recK3Aaaaaaaaaaaa', 'recK5Aaaaaaaaaaaa', 'recK6Aaaaaaaaaaaa', 'recKeeperAaaaaaaa']);
  });

  it('the event that starts the rest carries the fingerprint, taken after the carry-out line is written', () => {
    const r = py(`
rec("recPrintAaaaaaaaa")
complete("recPrintAaaaaaaaa")
row = json.loads(open(m.INTENT_LEDGER).read().strip().splitlines()[-1])
print(json.dumps({"event": row["event"], "fp": bool(row.get("fp")), "notesHaveLine": m.CARRIED_OUT_MARK in TASKS["recPrintAaaaaaaaa"]["fields"][AF["notes"]]}))`);
    expect(r).toEqual({ event: 'done', fp: true, notesHaveLine: true });
  });
});

describe('a status rest holds only while the task is as the filing left it (findings 1, 7, 14)', () => {
  it('S0 control rests; S2 a NEW MESSAGE line, S3 a same-day fold block, S7 the holder removed and a note each wake it', () => {
    const r = py(`
ids = ["recS0Aaaaaaaaaaaa", "recS2Aaaaaaaaaaaa", "recS3Aaaaaaaaaaaa", "recS7Aaaaaaaaaaaa", "recSnAaaaaaaaaaaa"]
errs = {}
for i in ids:
    rec(i, notes=LOOK, approved=False)
    errs[i] = submit_status(i)
F = lambda i: TASKS[i]["fields"]
F("recS2Aaaaaaaaaaaa")[AF["description"]] += "\\n\\nNEW MESSAGE " + day(0) + ": the council replied, final notice."
F("recS3Aaaaaaaaaaaa")[AF["description"]] += "\\n\\nUPDATE " + day(0) + ": new item folded in by the duplicate gate (one subject = one open task)."
F("recS7Aaaaaaaaaaaa")[AF["teamMember"]] = []
F("recSnAaaaaaaaaaaa")[AF["notes"]] += "\\n\\n[" + TODAY.strftime("%d %b %Y") + " — agent] the council rang Roy: a letter is on its way."
SHIFT[0] = timedelta(hours=1)
print(json.dumps({"errs": errs, "q": queue(), "events": events("recS0Aaaaaaaaaaaa")}))`);
    expect(Object.values(r.errs)).toEqual([null, null, null, null, null]);
    expect(r.events).toEqual(['status']);
    expect(Object.keys(r.q.idle)).toEqual(['recS0Aaaaaaaaaaaa']);
    // S7 has no holder left, so it is listed for routing rather than worked: awake either way
    expect(r.q.work).toEqual(['recS2Aaaaaaaaaaaa', 'recS3Aaaaaaaaaaaa', 'recSnAaaaaaaaaaaa']);
  });

  it('finding 7: a second status update on a task that changed since its last rest is refused; an unchanged one files', () => {
    const r = py(`
rec("recSevenAaaaaaaaa", notes=LOOK, approved=False)
rec("recSevenQuietAaaa", notes=LOOK, approved=False)
first = [submit_status("recSevenAaaaaaaaa"), submit_status("recSevenQuietAaaa")]
# a scanned letter folded in by the gate four days later (no email, so the Gmail read is quiet)
TASKS["recSevenAaaaaaaaa"]["fields"][AF["description"]] += ("\\n\\nUPDATE " + day(0) + ": new item folded in by the duplicate gate "
                                                           "(one subject = one open task).\\nScanned letter: FINAL NOTICE.")
SHIFT[0] = timedelta(days=4)
second = [submit_status("recSevenAaaaaaaaa", status_body(nxt=day(7))), submit_status("recSevenQuietAaaa", status_body(nxt=day(7)))]
print(json.dumps({"first": first, "second": second}))`);
    expect(r.first).toEqual([null, null]);
    expect(r.second[0]).toMatch(/the task has changed since it last rested \(Description changed\)/);
    expect(r.second[1]).toBeNull();
  });
});

describe('neither rest runs past the task\'s own due date (finding 6)', () => {
  it('--until and NEXT CHECK later than a due date still ahead are refused, naming the due date; on or before it they pass', () => {
    const r = py(`
rec("recDueKeepAaaaaaa", due=day(4)); rec("recDueKeepOkAaaaa", due=day(4)); rec("recDuePastAaaaaaa", due=day(-3))
rec("recDueStatAaaaaaa", notes=LOOK, approved=False, due=day(2)); rec("recDueStatOkAaaaa", notes=LOOK, approved=False, due=day(2))
print(json.dumps({
  "keep": complete("recDueKeepAaaaaaa", until=day(10)),
  "keepOk": complete("recDueKeepOkAaaaa", until=day(4)),
  "past": complete("recDuePastAaaaaaa", until=day(10)),
  "stat": submit_status("recDueStatAaaaaaa", status_body(nxt=day(5))),
  "statOk": submit_status("recDueStatOkAaaaa", status_body(nxt=day(2))),
  "due": day(4), "due2": day(2)}))`);
    expect(r.keep).toContain(`is after this task's own due date, ${r.due}: pick ${r.due} or earlier`);
    expect(r.keepOk).toBeNull();
    expect(r.past).toBeNull();
    expect(r.stat).toContain(`is after this task's own due date, ${r.due2}: pick ${r.due2} or earlier`);
    expect(r.statOk).toBeNull();
  });

  it('K4 and S6: a rest whose due date falls inside it ends when the due date arrives', () => {
    const r = py(`
UTC = timezone.utc
H = "recHolderAaaaaaaa"
line = ("[16 Nov 2026 — agent] CARRIED OUT (task left open): chased. Left OPEN deliberately: the approval said so. "
        "Next look: it rests until 2026-11-30. Holder: %s." % H)
kt = {"outcome": "Approved as-is", "approvedAt": "2026-11-15T09:00:00.000Z", "notes": line, "description": "Chase.",
      "teamMemberIds": [H], "dueDate": "2026-11-21"}
sline = ("[16 Nov 2026 10:00 — agent-dispatch] HANDLED WITHOUT YOU (status update): No reply. Nothing to approve: the task stays "
         "Today, its card and Kevin's verdict are untouched, and it rests until 2026-11-23. Level A, Kevin's ruling 14 Nov 2026. Holder: %s." % H)
st = {"outcome": "", "approvedAt": "", "notes": sline, "description": "Chase.", "teamMemberIds": [H], "dueDate": "2026-11-18"}
ts = "2026-11-16T10:00:00.000Z"
# the fingerprint the rest's own event carries: the task as the rest began (nothing changed since)
def fp(t):
    return m.rest_fingerprint(t) if hasattr(m, "rest_fingerprint") else ""
def ih(t, now):
    try: return m.idle_handback(t, ("done", ts), now, fingerprint=fp(t))
    except TypeError: return m.idle_handback(t, ("done", ts), now)
def sr(t, now):
    try: return m.status_rest(t, ("status", ts), now, fingerprint=fp(t))
    except TypeError: return m.status_rest(t, ("status", ts), now)
print(json.dumps({
  "k4before": bool(ih(kt, _dt(2026, 11, 20, 9, 0, tzinfo=UTC))), "k4on": bool(ih(kt, _dt(2026, 11, 21, 9, 0, tzinfo=UTC))),
  "s6before": bool(sr(st, _dt(2026, 11, 17, 9, 0, tzinfo=UTC))), "s6on": bool(sr(st, _dt(2026, 11, 18, 9, 0, tzinfo=UTC)))}))`);
    expect(r).toEqual({ k4before: true, k4on: false, s6before: true, s6on: false });
  });
});

describe('a status update is refused while an approval waits to be carried out (finding 5)', () => {
  it('E2: approved two hours ago, nothing carried out: refused; carried out after the approval: files', () => {
    const r = py(`
approved = (_dt.now(timezone.utc) - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
rec("recOwedAaaaaaaaaa", notes=LOOK)
TASKS["recOwedAaaaaaaaaa"]["fields"][AF["approvedAt"]] = approved
rec("recCarriedAaaaaaa", notes=LOOK)
TASKS["recCarriedAaaaaaa"]["fields"][AF["approvedAt"]] = approved
with open(m.INTENT_LEDGER, "a") as fh:
    fh.write(json.dumps({"task": "recCarriedAaaaaaa", "event": "done",
                         "ts": (_dt.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}) + "\\n")
print(json.dumps({"owed": submit_status("recOwedAaaaaaaaaa"),
                  "owedNotes": TASKS["recOwedAaaaaaaaaa"]["fields"][AF["notes"]] == LOOK,
                  "carried": submit_status("recCarriedAaaaaaa")}))`);
    expect(r.owed).toMatch(/Kevin approved this task .* and the approved action has not been carried out since: carry it out/);
    expect(r.owedNotes).toBe(true);
    expect(r.carried).toBeNull();
  });

  it('an approval that lands while the filing is being written: the line stands, but no rest begins', () => {
    const r = py(`
rec("recRaceAaaaaaaaaa", notes=LOOK, approved=False)
def racing_patch(i, f):
    TASKS[i]["fields"].update(f)
    TASKS[i]["fields"].update({AF["approvalOutcome"]: {"name": "Approved as-is"},
                               AF["approvedAt"]: _dt.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")})
    return {"id": i}
m.patch_task = racing_patch
err = submit_status("recRaceAaaaaaaaaa")
print(json.dumps({"err": err, "events": events("recRaceAaaaaaaaaa")}))`);
    expect(r.err).toMatch(/was approved while the status update was being written/);
    expect(r.events).toEqual([]);
  });
});

describe('creation is not a look (finding 12)', () => {
  it('a brand-new inbound task, never carded, cannot file a status update over its own message', () => {
    const r = py(`
rec("recNewAaaaaaaaaaa", notes="", approved=False, desc="From recovery@exampleton-council.test. FINAL NOTICE. Please pay by the 21st.",
    name="INBOUND: Exampleton Council - final notice")
TASKS["recNewAaaaaaaaaaa"]["createdTime"] = (_dt.now(timezone.utc) - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
print(json.dumps({"err": submit_status("recNewAaaaaaaaaaa", status_body("I read the council's letter and nothing has changed since.")),
                  "events": events("recNewAaaaaaaaaaa")}))`);
    expect(r.err).toMatch(/no card or status update has been filed on this task before, so there is no earlier look/);
    expect(r.events).toEqual([]);
  });
});

// Finding 3 and finding 16: the reply read fails closed, driven through the REAL history(),
// history_gmail(), worker_list() and worker_post(); only the HTTP answer is canned, shaped as the
// worker returns it (id, internalDate in ms, headers.from and headers.subject).
describe('the "no reply since the last look" read fails closed (findings 3 and 16)', () => {
  const home = mkdtempSync(join(tmpdir(), 'od-rest-home-'));
  mkdirSync(join(home, '.config/od'), { recursive: true });
  writeFileSync(join(home, '.config/od/gmail_triage_key'), 'test-key-not-real');
  const env = { HOME: home, OD_GMAIL_PACE_DIR: mkdtempSync(join(tmpdir(), 'od-rest-pace-')),
                INBOUND_TRIAGE_DIR: mkdtempSync(join(tmpdir(), 'od-rest-triage-')) };
  const READ = `
it = m._triage()
ACCTS = sorted(it.SEARCH_ACCOUNTS)
BOX = {}              # mailbox -> raw worker messages; a mailbox missing from BOX answers 409
calls = []
class Resp:
    def __init__(self, body): self._b = json.dumps(body).encode()
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False
def fake_urlopen(req, timeout=None):
    payload = json.loads(req.data.decode())
    acct = payload.get("account", "")
    calls.append(acct)
    if acct not in BOX:
        raise urllib.error.HTTPError(req.full_url, 409, "gmail not connected", {}, io.BytesIO(b"not connected"))
    return Resp({"messages": BOX[acct]})
urllib.request.urlopen = fake_urlopen
# The pacer is not under test: it holds a call when a minute's quota is spent, which here only slows the run.
import gmail_pacer
gmail_pacer.gmail_pace = lambda path, payload=None, account=None, **k: (0, 0)
m.query_tasks = lambda *a, **k: []
LON = m.LONDON
LAST = _dt(2026, 11, 10, 10, 0, tzinfo=LON)
ARRIVED = _dt(2026, 11, 13, 14, 30, tzinfo=LON)
def msg(sender, when=ARRIVED, subject="Re: Council tax account 70012345 - FINAL NOTICE"):
    return {"id": "m1", "internalDate": str(int(when.timestamp() * 1000)), "headers": {"from": sender, "subject": subject}}
def task(notes=None, approved_at="", outcome=""):
    f = {AF["name"]: "Chase: Exampleton Council - council tax bill", AF["inboundSender"]: "recovery@exampleton-council.test",
         AF["description"]: "CREDITOR MATTER. Contact: recovery@exampleton-council.test",
         AF["notes"]: "[10 Nov 2026 10:00 — agent-dispatch] HANDLED WITHOUT YOU (status update): No reply yet. Nothing to approve: it rests until 2026-11-14. Level A." if notes is None else notes}
    if approved_at: f[AF["approvedAt"]] = approved_at
    if outcome: f[AF["approvalOutcome"]] = outcome
    return {"id": "recStatAaaaaaaaaa", "createdTime": "2026-11-02T09:00:00.000Z", "fields": f}
BODY = "STATUS ONLY: No reply from the council yet.\\nNEXT CHECK: 2026-11-20\\n\\n**Carrying this out will involve:** Nothing. Information only."
def only(acct_index, messages):
    for a in ACCTS: BOX[a] = []
    BOX[ACCTS[acct_index]] = messages
`;

  it('R0 control is refused; a quiet set of mailboxes files; every mailbox the estate reads is asked', () => {
    const r = py(READ + `
only(0, [msg("Exampleton Council <recovery@exampleton-council.test>")])
r0 = m.status_reply_problem(BODY, task())
for a in ACCTS: BOX[a] = []
calls.clear()
quiet = m.status_reply_problem(BODY, task())
print(json.dumps({"r0": r0, "quiet": quiet, "asked": sorted(set(calls)) == ACCTS, "n": len(ACCTS)}))`, env);
    expect(r.r0).toMatch(/an email from recovery@exampleton-council\.test arrived 13 Nov 2026 14:30, after this task was last looked at/);
    expect(r.quiet).toBe('');
    expect(r.asked).toBe(true);
    expect(r.n).toBeGreaterThanOrEqual(3);
  });

  it('R1 a long display name, R2 a colon in the name, R3 a relay from Roy and R5 another mailbox are all refused', () => {
    const r = py(READ + `
long_name = '"Exampleton Borough Council Revenues, Benefits and Council Tax Recovery Team" <recovery@exampleton-council.test>'
out = {}
only(0, [msg(long_name)]); out["r1"] = m.status_reply_problem(BODY, task())
only(0, [msg('"Exampleton Council: Recovery" <recovery@exampleton-council.test>')]); out["r2"] = m.status_reply_problem(BODY, task())
only(0, [msg("Roy <%s>" % m.ROY_EMAIL)]); out["r3"] = m.status_reply_problem(BODY, task())
for k in range(len(ACCTS)):
    only(k, [msg("Exampleton Council <recovery@exampleton-council.test>")])
    out["r5_%d" % k] = m.status_reply_problem(BODY, task())
print(json.dumps(out))`, env);
    expect(r.r1).toMatch(/an email from recovery@exampleton-council\.test arrived/);
    expect(r.r2).toMatch(/an email from recovery@exampleton-council\.test arrived/);
    expect(r.r3).toMatch(/an email from .* arrived 13 Nov 2026 14:30/);
    for (const k of Object.keys(r).filter((x) => x.startsWith('r5_'))) {
      expect(r[k], k).toMatch(/an email from recovery@exampleton-council\.test arrived/);
    }
  });

  it('a sender that cannot be read, and a mailbox that cannot be searched, refuse the filing', () => {
    const r = py(READ + `
only(0, [msg("Exampleton Council")]); unread = m.status_reply_problem(BODY, task())
for a in ACCTS: BOX[a] = []
BOX.pop(ACCTS[1]); down = m.status_reply_problem(BODY, task())
print(json.dumps({"unread": unread, "down": down}))`, env);
    expect(r.unread).toMatch(/an email arrived 13 Nov 2026 14:30, after this task was last looked at, and its sender cannot be read/);
    expect(r.down).toMatch(/Gmail could not be searched for a reply \(Gmail not searched in /);
  });

  it('R4 Kevin\'s approval of a stale card is not a look; B1 a task opened on the same matter since the last look is refused', () => {
    const r = py(READ + `
only(0, [msg("Exampleton Council <recovery@exampleton-council.test>", when=_dt(2026, 11, 5, 11, 0, tzinfo=LON))])
r4 = m.status_reply_problem(BODY, task(notes="[03 Nov 2026 09:00 — agent-dispatch] SUBMITTED (round 1) as Research with no new file",
                                       approved_at="2026-11-08T12:00:00.000Z", outcome="Approved as-is"))
for a in ACCTS: BOX[a] = []
sibling = {"id": "recLetterAaaaaaaa", "createdTime": "2026-11-13T14:30:00.000Z",
           "fields": {AF["name"]: "INBOUND: Exampleton Council - FINAL NOTICE letter, account 70012345 (scanned post)",
                      AF["status"]: "Today", AF["description"]: "Scanned letter. Pay by the 21st.", AF["notes"]: ""}}
m.query_tasks = lambda *a, **k: [sibling]
b1 = m.status_reply_problem(BODY, task())
print(json.dumps({"r4": r4, "b1": b1}))`, env);
    expect(r.r4).toMatch(/an email from recovery@exampleton-council\.test arrived 05 Nov 2026 11:00/);
    expect(r.b1).toMatch(/another task on this matter was opened 13 Nov 2026, since this task was last looked at/);
  });
});

describe('the no-op check refuses only a line that says nothing happens (finding 11)', () => {
  it('all fourteen real cards from the review pass; the closing form and its close variants are refused', () => {
    const r = py(`
real = [
  "Nothing is paid today. The bill goes on the Friday payment list.",
  "Nothing is sent to the tenant. The agent chases the council for the missing payment instead.",
  "Nothing is signed yet. The robot signs the tenancy agreement in Adobe.",
  "Nothing changes for the tenant. The agent adds the new gas certificate to the compliance book.",
  "Nothing is booked yet. The agent accepts the electrician's quote and asks for a date.",
  "Nothing is sent today. The agent drafts the reply and brings it back for you to check.",
  "No action is taken against the tenant and the arrears task closes.",
  "Nothing happens to the tenancy and the old reminder closes.",
  "Nothing is paid. The agent tells Roy to go ahead with the repair.",
  "No action fraud report exists yet. The agent prepares one for you to check.",
  "Nothing to do with the old policy. The agent asks three insurers for a quote.",
  "Nothing is sent by post. The agent submits the form on the council's website.",
  "Nothing is bought. The agent withdraws the order request and tells the seller.",
  "Nothing changes on the plan. The agent confirms the £20 a month to the creditor in writing.",
]
noop = ["Nothing. Information only.", "Nothing.", "Nothing happens.", "nothing happens", "No action.",
        "Nothing happens. Information only.", "If you approve, nothing happens.", "Information only."]
print(json.dumps({"realRefused": [l for l in real if m.approve_line_noop(l)], "noopPassed": [l for l in noop if not m.approve_line_noop(l)]}))`);
    expect(r.realRefused).toEqual([]);
    expect(r.noopPassed).toEqual([]);
  });
});

describe('a resting task is listed as resting and never counted stuck (findings 9 and 10)', () => {
  it('loop-health: a rest from the dispatcher\'s queue is waiting, not stuck; an ended rest is due (live); a fold or status event is not a step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'od-rest-queue-'));
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, os
from datetime import datetime, timezone, timedelta
spec = importlib.util.spec_from_file_location('lh', ${JSON.stringify(LOOP)})
lh = importlib.util.module_from_spec(spec); spec.loader.exec_module(lh)
UTC = timezone.utc
H = "recHolderAaaaaaaa"
notes = ("[20 Oct 2026 — agent] CARRIED OUT (task left open): chased the council. Left OPEN deliberately: "
         "the approval said so. Next look: it rests until 2026-11-03. Holder: %s." % H)
f = {"Approval Outcome": "Approved as-is", "Approved At": "2026-10-19T09:00:00.000Z", "Notes": notes, "Status": "Today",
     "Due Date": "2026-10-20", "Task Name": "Chase: Exampleton Council"}
now = datetime(2026, 11, 16, 9, 0, tzinfo=UTC)
done = ("done", datetime(2026, 10, 20, 10, 0, tzinfo=UTC))
status = ("status", datetime(2026, 11, 13, 9, 0, tzinfo=UTC))
fold = ("folded", datetime(2026, 11, 1, 9, 0, tzinfo=UTC))
qpath = os.path.join(${JSON.stringify(dir)}, "queue.json")
json.dump({"generatedAt": (now - timedelta(minutes=10)).isoformat(), "heldUnderLead": [],
           "idleHandbacks": [{"id": "recRestAaaaaaaaaa", "restUntil": "2026-11-20", "idleReason": "status update filed"},
                             {"id": "recWallAaaaaaaaaa", "idleReason": "parked on SITE x"}]}, open(qpath, "w"))
resting, err = lh.dispatch_resting(now, path=qpath)
rows = lambda ev, rest: [r["rule"] for r in lh.reply_overdue_rows(
    [{"id": "recRestAaaaaaaaaa", "fields": f}], now, {"recRestAaaaaaaaaa": ev}, resting=rest)]
print(json.dumps({
  "resting": resting, "err": err,
  "L1bucket": lh.work_bucket(f, now, [done, status], rest_until="2026-11-20"),
  "L1rows": rows([done, status], resting),
  "dueBucket": lh.work_bucket(f, now, [done, status], rest_until=""),
  "dueRows": rows([done, status], {}),
  "L2noQueue": lh.work_bucket(f, now, [done, fold]),
  "L0noQueue": lh.work_bucket(f, now, [done]),
}))`], { encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').pop());
    expect(r.err).toBeNull();
    expect(r.resting).toEqual({ recRestAaaaaaaaaa: '2026-11-20' });
    // Carried out 27 days ago: past the stuck clock, so it is on the Stuck list whatever the rest says
    // (review of PR 936, finding 5; a short wait resting is in agent-dispatch-rest-wake.test.js).
    expect(r.L1bucket).toEqual(['live', 'overdue']);
    expect(r.L1rows).toEqual(['reply']);
    expect(r.dueBucket).toEqual(['live', 'overdue']);
    expect(r.dueRows).toEqual(['reply']);
    // no queue: the older ledger rule, with a fold skipped (it was "not waiting" before)
    expect(r.L2noQueue).toEqual(['live', 'overdue']);
    expect(r.L0noQueue).toEqual(['live', 'overdue']);
  });

  it('the Task Manager board files a resting task under resting with its date, and an ended rest as moving, not stuck', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location('tm', ${JSON.stringify(BOARD)})
tm = importlib.util.module_from_spec(spec); spec.loader.exec_module(tm)
now = datetime(2026, 11, 16, 9, 0, tzinfo=timezone.utc)
H = "recHolderAaaaaaaa"
def r(i): return {"id": i, "fields": {"Status": "Today", "Approval Outcome": "Approved as-is", "Approved At": "2026-11-08T09:00:00.000Z",
                                     "Created Time": "2026-11-01T09:00:00.000Z", "Team Member": [H], "Task Name": "Chase: Exampleton Council",
                                     "Notes": ""}}
lanes = {"recT0Aaaaaaaaaaaa": ("resting", {"restUntil": "2026-11-23", "restWhy": "carried out and kept open", "restFrom": "approvedHandbacks"}),
         "recDueAaaaaaaaaaa": ("approvedHandbacks", {"restDue": "2026-11-15"}),
         "recOldDueAaaaaaaa": ("approvedHandbacks", {"restDue": "2026-11-01"}),
         "recPlainAaaaaaaaa": ("approvedHandbacks", {})}
out = {}
for i in lanes:
    b, _k, v = tm.task_view(r(i), set(), set(), now, lanes)
    out[i] = [b, v.get("restUntil"), v.get("restDue")]
print(json.dumps(out))`], { encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').pop());
    expect(r.recT0Aaaaaaaaaaaa).toEqual(['resting', '2026-11-23', null]);
    expect(r.recDueAaaaaaaaaaa).toEqual(['moving', null, '2026-11-15']);
    // due for longer than the stuck clock: stuck again
    expect(r.recOldDueAaaaaaaa).toEqual(['stuck', null, '2026-11-01']);
    expect(r.recPlainAaaaaaaaa[0]).toBe('stuck');
  });

  it('dispatch\'s own lanes (the board\'s one answer) say resting with the date, then due on the date', () => {
    const r = py(`
rec("recLaneAaaaaaaaaa")
complete("recLaneAaaaaaaaaa", until=day(5))
m.fetch_ai_agents = lambda: {}
before = m.queue_lanes({}, {}, "")["recLaneAaaaaaaaaa"]
SHIFT[0] = timedelta(days=5)
after = m.queue_lanes({}, {}, "")["recLaneAaaaaaaaaa"]
print(json.dumps({"before": [before[0], before[1].get("restUntil")], "after": [after[0], after[1].get("restDue")], "d5": day(5)}))`);
    expect(r.before).toEqual(['resting', r.d5]);
    expect(r.after).toEqual(['approvedHandbacks', r.d5]);
  });
});
