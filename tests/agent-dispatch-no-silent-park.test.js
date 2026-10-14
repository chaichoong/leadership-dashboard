// NO SILENT PARKING (Kevin, 14 Oct 2026: "Stop silent parking").
//
// On 13 Oct 2026 Roy emailed asking for a tenant's direct rent payment request (UC47 / APA) to go to
// the DWP. Three dispatch slots left the task with no card: "the direct rent form comes through the
// new-tenant rent lane after Roy answers the 15 Oct costs check; a card here would be a twin". No task
// in that lane existed to carry it, the final check's failure went only into a run report, and the
// form went in a day late, by hand.
//
// CLOCKS, NOT WORDS (review round 2). A task a run leaves with no card stays off Kevin's queue for ONE
// 48-hour pass, once, and only at a door: an open task named by its id (due within 7 days, clear, not a
// twin), or an event with its day and clock time in a Notes line an agent wrote; the pass lives in a
// ledger keyed by task id. Kevin's own park holds while its date does (`decided --until`, `due`, his
// knock-back, Some Day for 30 days), and his words are never read as one. Only tasks owed this run or
// held by an AI agent are parked, never Roy's or Kevin's. Anything else, and any park once the pass is
// used, becomes the same decision card for every task, quoting its name and the robot's own words.
//
// These drive the real cmd_verify (and through it the real cmd_escalate) with only the Airtable reads
// and writes swapped for an in-memory board. Every name is invented. Times are relative to now:
// {d:+N} an ISO day, {dm:+N} "15 Oct", {day:+N} "15 Oct 2026" (an agent note's stamp), and
// {stamp:-Nh} "15 Oct 2026 13:18" N hours ago (an agent-dispatch stamp), {iso:-Nh} the same as UTC ISO
// (the ledger and LMT fields), so the tests hold on any day.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const INBOX = 'recJ8J8idWE8d97tH';      // AI Inbox Response (RESPONSE_REC_ID)
const TASKMGR = 'rec1hYELb4zS8pjjO';    // AI Task Board Manager (TASKMGR_REC_ID): escalate's sender

const UC47 = 'recUCFORTYSEVEN01';
// The 13 Oct shape: no tenancy link, a name carrying "decision" and "submitted", and a robot that cites a
// lane with no task in it.
const UC47_NAME = 'INBOUND (follow-up): Roy says Ada Example UC decision is in, nothing submitted yet, submit an APA';
const LANE_WORDS = 'no card by the agent: the direct rent form comes through the new-tenant rent lane after Roy '
  + 'answers the {dm:+1} costs check; a card here would be a twin. Task annotated, stays open.';
const GENERIC = 'INBOUND: council asks for the HMO licence renewal form';

// tasks: {id: {name, status, due, notes, description, teamMember, agentOutput, outcome, feedback, history}}
// owed: the queue's worklist as [[id, kind]]; by default every task the run acted on, as new work.
function verify({ tasks, actions, dryRun = false, owed = null, readFails = 0, failWith = 'http', runs = 1,
                  ledger = null, blankById = [], ownerNow = {} }) {
  const cfg = { tasks, actions, dryRun, owed, readFails, failWith, runs, ledger, blankById, ownerNow };
  const script = `
import importlib.util, json, os, re, io, sys, types, tempfile, contextlib
import urllib.error
from datetime import datetime, timedelta, timezone
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = datetime.now(m.LONDON)
TODAY = NOW.date()
def rel(txt):
    txt = re.sub(r"\\{d:([+-]\\d+)\\}", lambda g: (TODAY + timedelta(days=int(g.group(1)))).isoformat(), txt)
    txt = re.sub(r"\\{dm:([+-]\\d+)\\}", lambda g: (TODAY + timedelta(days=int(g.group(1)))).strftime("%-d %b"), txt)
    txt = re.sub(r"\\{day:([+-]?\\d+)\\}", lambda g: (TODAY + timedelta(days=int(g.group(1)))).strftime("%d %b %Y"), txt)
    txt = re.sub(r"\\{iso:([+-][\\d.]+)h\\}", lambda g: (NOW + timedelta(hours=float(g.group(1)))).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"), txt)
    return re.sub(r"\\{stamp:([+-][\\d.]+)h\\}", lambda g: (NOW + timedelta(hours=float(g.group(1)))).strftime("%d %b %Y %H:%M"), txt)
cfg = json.loads(rel(${JSON.stringify(JSON.stringify(cfg))}))
tmp = tempfile.mkdtemp()
m.STATE_DIR = tmp
m.NO_CARD_RETRY_PAUSE = 0
if cfg["ledger"] is not None:
    open(os.path.join(tmp, m.NO_CARD_PASS_LEDGER), 'w').write(cfg["ledger"] if isinstance(cfg["ledger"], str) else json.dumps(cfg["ledger"]))
rundir = os.path.join(tmp, 'run'); os.makedirs(rundir)
report = {"startedAt": NOW.isoformat(), "queueCounts": {"worklist": len(cfg["tasks"]), "openTasksRead": 50},
          "actions": cfg["actions"], "parkedFlags": [], "skippedTier2": []}
open(os.path.join(rundir, 'report.json'), 'w').write(json.dumps(report))
owed = cfg["owed"] if cfg["owed"] is not None else [
    [tid, "carry_out" if any(a.get("kind") == "carry_out" for a in cfg["actions"] if a.get("task") == tid) else "new"]
    for tid in dict.fromkeys(a.get("task") for a in cfg["actions"])]
open(os.path.join(rundir, 'queue.json'), 'w').write(json.dumps(
    {"generatedAt": report["startedAt"], "worklist": [{"id": i, "kind": k} for i, k in owed]}))
AF = m.AF
store = {}
for tid, t in cfg["tasks"].items():
    store[tid] = {AF["name"]: t.get("name", "A task"), AF["description"]: t.get("description", ""),
                  AF["status"]: t.get("status", "Today") or None, AF["dueDate"]: t.get("due", TODAY.isoformat()),
                  AF["notes"]: t.get("notes", ""), AF["teamMember"]: t.get("teamMember", [${JSON.stringify(INBOX)}]),
                  AF["inboundTask"]: True, AF["agentOutput"]: t.get("agentOutput", ""),
                  AF["approvalOutcome"]: t.get("outcome") or None, AF["approvalFeedback"]: t.get("feedback", ""),
                  AF["feedbackHistory"]: t.get("history", ""), AF["deferredUntil"]: t.get("deferred") or None,
                  m.SOME_DAY_FIELD: bool(t.get("someDay")), m.LMT_DUE_FIELD: t.get("lmtDue")}
    if "due" in t and t["due"] is None:
        store[tid][AF["dueDate"]] = None
writes, listed, gets, fails = [], [], [], [cfg["readFails"]]
def fake_get_task(tid):
    gets.append(tid)
    if tid not in store: raise RuntimeError('no such task')
    f = dict(store[tid])
    if tid in cfg["blankById"]: f[AF["notes"]] = ""
    if tid in cfg["ownerNow"]: f[AF["teamMember"]] = [cfg["ownerNow"][tid]]
    return {"id": tid, "fields": f}
def fake_query_records(table, formula=None, fields=None, max_records=None):
    listed.append(formula)
    if fails[0]:
        fails[0] -= 1
        if cfg["failWith"] == "network": raise urllib.error.URLError("timed out")
        if cfg["failWith"] == "timeout": raise TimeoutError("The read operation timed out")
        raise RuntimeError("Airtable GET /tblqB8b22hKBL4PF1 → HTTP 503: service unavailable")
    assert table == m.TASKS, table
    ids = re.findall(r"RECORD_ID\\(\\)='(rec[A-Za-z0-9]+)'", formula or "")
    return [{"id": i, "fields": dict(store[i])} for i in ids if i in store]
def fake_patch(tid, fields):
    writes.append({"task": tid, "fields": fields})
    store.setdefault(tid, {}).update(fields)
    return {}
m.get_task, m.query_records, m.patch_task = fake_get_task, fake_query_records, fake_patch
m.history = lambda **kw: {"terms": ["ref EXAMPLE"], "searched": ["tasks", "Gmail"], "notes": [], "entries": []}
m.ledger_last_events = lambda: {}
m.overdue_lessons = lambda: []
results = []
for _ in range(cfg["runs"]):
    out, err, code = io.StringIO(), io.StringIO(), 0
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            m.cmd_verify(types.SimpleNamespace(report=os.path.join(rundir, 'report.json'), dry_run=cfg["dryRun"]))
        except SystemExit as e:
            code = e.code or 0
    printed = [ln for ln in out.getvalue().splitlines() if ln.startswith('{')]
    results.append({"code": code, "out": json.loads(printed[-1]) if printed else {}, "err": err.getvalue()})
final = {tid: {"status": f.get(AF["status"]), "agentOutput": f.get(AF["agentOutput"]) or "", "notes": f.get(AF["notes"]) or "",
               "sentBy": f.get(AF["sentForApprovalBy"]) or [], "history": f.get(AF["feedbackHistory"]) or ""} for tid, f in store.items()}
try: led = json.load(open(os.path.join(tmp, m.NO_CARD_PASS_LEDGER)))
except Exception: led = None
print('@@@' + json.dumps({**results[-1], "first": results[0], "writes": writes, "listed": listed, "gets": gets, "final": final, "ledger": led}))
`;
  const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  return JSON.parse(raw.slice(raw.indexOf('@@@') + 3));
}

// One helper of the rule, at a fixed moment (14 Oct 2026, 13:18 London) where the time of day matters.
function pure(code, at = '2026-10-14T13:18') {
  const script = `
import importlib.util, json
from datetime import datetime
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
now = datetime.fromisoformat(${JSON.stringify(at)}).replace(tzinfo=m.LONDON)
print('@@@' + json.dumps(${code}))
`;
  const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  return JSON.parse(raw.slice(raw.indexOf('@@@') + 3));
}
const event = (text, at) => pure(`m.no_card_event(${JSON.stringify(text)}, now)`, at);

const noCard = (task, words, extra = {}) => ({ task, kind: 'new', ok: false, error: words, ...extra });
const isCard = (t) => t.status === 'Approval' && /^DECIDE: A robot left this task with no card/.test(t.agentOutput);

describe('Case A: a task parked with no door comes to Kevin as a card (the 13-14 Oct bug)', () => {
  it('the 13 Oct shape (no tenancy link, "decision" and "submitted" in the name, a lane with no task) is a card quoting the task and the robot', () => {
    const r = verify({ tasks: { [UC47]: { name: UC47_NAME, description: 'Roy: housing cost has been verified, please submit an APA.' } },
      actions: [{ task: UC47, kind: 'route', ok: true, to: INBOX }, noCard(UC47, LANE_WORDS, { tier1: true })] });
    expect(r.err).not.toContain('action failed');
    expect(r.code).toBe(0);
    const t = r.final[UC47];
    expect(isCard(t)).toBe(true);
    expect(t.sentBy).toEqual([TASKMGR]);
    expect(t.agentOutput).toContain(`the task "${UC47_NAME}"`);
    expect(t.agentOutput).toContain('comes through the new-tenant rent lane after Roy answers the');
    expect(t.agentOutput).toContain('it names no task by its id');
    expect(t.agentOutput).toMatch(/TIER 1/);
    expect(r.out.cardedNoDoor).toEqual([{ task: UC47, card: 'decision' }]);
  });

  it('the same park written only as an annotate note (the 13 Oct 17:13 slot) is a card too', () => {
    const r = verify({ tasks: { [UC47]: { name: UC47_NAME } },
      actions: [{ task: UC47, kind: 'annotate', ok: true, note: 'no card: held by the rent check housing-costs step' }] });
    expect(isCard(r.final[UC47])).toBe(true);
  });

  it('the self-check names the missing door and writes nothing, so the run can fix it first', () => {
    const r = verify({ tasks: { [UC47]: { name: UC47_NAME } }, actions: [noCard(UC47, LANE_WORDS)], dryRun: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${UC47} was left with no card and no door`);
    expect(r.err).not.toContain('action failed');
    expect(r.writes).toEqual([]);
  });

  it('a card that cannot be made fails the run loudly, never quietly', () => {
    const T = 'recANSWEREDCARD01';
    const r = verify({ tasks: { [T]: { name: 'Decide the garden contract', agentOutput: 'DECIDE: which contractor?', outcome: 'Approved as-is' } },
      actions: [noCard(T, 'no card: waiting')] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('no card could be made for Kevin');
    expect(r.err).toContain('Kevin has ANSWERED the decision card');
    expect(r.writes).toEqual([]);
  });

  it('a second verify of the same run finds the card it made and makes no other', () => {
    const T = 'recGENERICTASK002';
    const r = verify({ tasks: { [T]: { name: GENERIC } }, actions: [noCard(T, 'no card: later')], runs: 2 });
    expect(r.first.out.cardedNoDoor).toHaveLength(1);
    expect(r.out.cardedNoDoor).toEqual([]);
    expect(r.out.parkedWithDoor).toEqual([{ task: T, door: "it is already a card in Kevin's queue" }]);
  });

  it('a read that fails twice is a failure, never a pass, and nothing is written', () => {
    const r = verify({ tasks: { [UC47]: { name: UC47_NAME } }, actions: [noCard(UC47, LANE_WORDS)], readFails: 2 });
    expect(r.code).toBe(1);
    expect(r.err).toContain('could not be read to check their doors (Airtable GET /tblqB8b22hKBL4PF1 → HTTP 503');
    expect(r.writes).toEqual([]);
  });

  it('a 503 once is retried once (finding 6), and the card is made', () => {
    const r = verify({ tasks: { [UC47]: { name: UC47_NAME } }, actions: [noCard(UC47, LANE_WORDS)], readFails: 1 });
    expect(isCard(r.final[UC47])).toBe(true);
    expect(r.listed.filter((f) => (f || '').includes(UC47)).length).toBeGreaterThanOrEqual(2);
  });

  it.each([['network'], ['timeout']])('a %s error once is retried once too, and the card is made', (failWith) => {
    const r = verify({ tasks: { [UC47]: { name: UC47_NAME } }, actions: [noCard(UC47, LANE_WORDS)], readFails: 1, failWith });
    expect(isCard(r.final[UC47])).toBe(true);
  });

  it('a parked task that does not read back as a task is a failure too', () => {
    const r = verify({ tasks: {}, actions: [noCard('recNOTONTHEBOARD1', 'no card: later')] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('recNOTONTHEBOARD1 was left with no card and does not read back as a task');
  });
});

describe('a park is a park whatever it says, in the order the run acted', () => {
  it('owed new work ended with only an annotate ("code build, waits for a build session") is a card', () => {
    const T = 'recCODEBUILDTASK1';
    const r = verify({ tasks: { [T]: { name: 'Build the rent statement export' } },
      actions: [{ task: T, kind: 'annotate', ok: true, note: 'code build, waits for a build session' }] });
    expect(isCard(r.final[T])).toBe(true);
  });

  it('a failed new action with no reason at all is a card that says so', () => {
    const T = 'recFAILEDSUBMIT01';
    const r = verify({ tasks: { [T]: { name: GENERIC } }, actions: [{ task: T, kind: 'new', ok: false }] });
    expect(r.err).not.toContain('action failed');
    expect(r.final[T].agentOutput).toContain('It recorded no reason.');
  });

  it.each([['no-card: held for the costs check'], ['no new card: the old one stands'], ['left without a card until Monday'],
    ['not carded, waiting on the reply']])('a task not owed this run is parked when its note says "%s"', (note) => {
    const T = 'recNOTOWEDTASK001';
    const r = verify({ tasks: { [T]: { name: GENERIC } }, owed: [], actions: [{ task: T, kind: 'annotate', ok: true, note }] });
    expect(isCard(r.final[T])).toBe(true);
  });

  it.each([
    ['You\'ve hit your weekly limit · resets 7pm (Europe/London)'],
    ['agent hit the usage limit mid-draft'],
    ['the agent timed out after 30 minutes'],
    ['Airtable PATCH → HTTP 429: too many requests'],
    ['Gmail quota used up for the hour'],
  ])('a capacity or time failure is a pause for the next slot, never a card: "%s"', (error) => {
    const T = 'recCAPACITYTASK01';
    const r = verify({ tasks: { [T]: { name: GENERIC } }, actions: [{ task: T, kind: 'new', ok: false, error }] });
    expect(r.writes).toEqual([]);
    expect(r.out.cardedNoDoor ?? []).toEqual([]);
    expect(r.err).toContain(`action failed: new ${T}`);       // still said, as before: a pause is not hidden
  });

  it('a route AFTER a failure in the same run is an outcome: no card', () => {
    const T = 'recROUTEDAFTERFAI';
    const r = verify({ tasks: { [T]: { name: GENERIC } },
      actions: [noCard(T, 'no card: not mine'), { task: T, kind: 'route', ok: true, to: INBOX }] });
    expect(r.writes).toEqual([]);
    expect(r.final[T].status).toBe('Today');
  });

  it('a route with a note saying so, and no failure: no card', () => {
    const T = 'recROUTEDTASK0001';
    const r = verify({ tasks: { [T]: { name: GENERIC } }, actions: [
      { task: T, kind: 'route', ok: true, to: INBOX }, { task: T, kind: 'annotate', ok: true, note: 'no card: routed to Inbox Response' }] });
    expect(r.writes).toEqual([]);
  });

  it('CONTROL: owed work the run never touched is the next tick\'s, as before', () => {
    const DONE = 'recCARDEDTASK0001';
    const LATER = 'recUNTOUCHEDTASK1';
    const r = verify({ tasks: { [DONE]: { name: GENERIC, status: 'Approval', agentOutput: 'a card' }, [LATER]: { name: GENERIC } },
      owed: [[DONE, 'new'], [LATER, 'new']], actions: [{ task: DONE, kind: 'new', ok: true }] });
    expect(r.writes.filter((w) => w.task === LATER)).toEqual([]);
  });
});

describe('a redo with no door keeps Kevin\'s change request', () => {
  it('his words survive, verbatim, in the Notes the agent reads, in Feedback History, and on the card', () => {
    const T = 'recREDOTASK000001';
    const SAID = 'Use the new bank details from the 9 Oct letter and copy Roy in, not Mica.';
    const r = verify({ tasks: { [T]: { name: GENERIC, outcome: 'Changes requested', feedback: SAID, agentOutput: 'TO: council\n---\nold draft' } },
      owed: [[T, 'redo']], actions: [{ task: T, kind: 'redo', ok: false, error: 'no card: waiting on the letter' }] });
    const t = r.final[T];
    expect(isCard(t)).toBe(true);
    expect(t.notes).toContain(`KEVIN ASKED FOR CHANGES, still owed when this went back to him as a card: ${SAID}`);
    expect(t.history).toContain(SAID);
    expect(t.agentOutput).toContain(SAID);
    // Written to Notes BEFORE the card cleared the feedback field.
    const order = r.writes.map((w) => Object.keys(w.fields).length === 1 ? 'notes' : 'card');
    expect(order).toEqual(['notes', 'card']);
  });
});

describe('a door buys ONE 48-hour pass, once, kept in a ledger; then it is a card', () => {
  const T = 'recAUTHORITYFORM1';
  const NAME = 'Ada Example (Unit 1): authority to act still unsigned, send a reminder';
  const ADOBE = "[{day:0} — agent] still unsigned. Adobe reminder {dm:+1} 21:41, so a chase now would duplicate it.";

  it('a robot writing "Adobe reminder <tomorrow> 21:41" in an agent note gets the pass: in the ledger, and a line in Notes', () => {
    const r = verify({ tasks: { [T]: { name: NAME, notes: ADOBE } }, actions: [noCard(T, 'no card: the reminder goes tomorrow')] });
    expect(r.err).not.toContain('action failed');
    expect(r.code).toBe(0);
    expect(r.out.parkedWithDoor[0].door).toMatch(/^an event an agent noted on the task, \d{4}-\d{2}-\d{2} 21:41 \(its one 48-hour pass starts now\)$/);
    expect(Object.keys(r.ledger)).toEqual([T]);
    expect(r.ledger[T].began).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(r.final[T].notes).toMatch(/— agent-dispatch\] NO-CARD PASS \(48 hours, once\): left with no card at a door/);
    expect(r.final[T].status).toBe('Today');
  });

  it('parked again inside the 48 hours: still inside its pass, nothing written', () => {
    const r = verify({ tasks: { [T]: { name: NAME, notes: ADOBE } }, ledger: { [T]: { began: '{iso:-2h}', door: 'x' } },
      actions: [noCard(T, 'no card: still waiting')] });
    expect(r.writes).toEqual([]);
    expect(r.out.parkedWithDoor[0].door).toMatch(/^inside its one 48-hour pass, which ends /);
  });

  it('parked again once the 48 hours are up: a card, whatever door it names now, even with no pass line left in Notes', () => {
    const r = verify({ tasks: { [T]: { name: NAME, notes: ADOBE } }, ledger: { [T]: { began: '{iso:-49h}', door: 'x' } },
      actions: [noCard(T, 'no card: Adobe reminder tomorrow')] });
    expect(isCard(r.final[T])).toBe(true);
    expect(r.final[T].agentOutput).toContain('its one 48-hour pass ran out at');
  });

  it('a pass line in Notes that the ledger does not hold (a folded twin\'s, a hand-typed one) neither renews nor spends this task\'s pass', () => {
    const r = verify({ tasks: { [T]: { name: NAME, notes: `[{stamp:-60h} — agent-dispatch] NO-CARD PASS (48 hours, once): copied from a twin\n\n${ADOBE}` } },
      actions: [noCard(T, 'no card')] });
    expect(r.out.parkedWithDoor[0].door).toContain('(its one 48-hour pass starts now)');
    expect(Object.keys(r.ledger)).toEqual([T]);
  });

  it('a ledger entry stamped in the future, or one whose time cannot be read, buys nothing', () => {
    for (const began of ['{iso:+30h}', 'sometime']) {
      const r = verify({ tasks: { [T]: { name: NAME, notes: ADOBE } }, ledger: { [T]: { began } }, actions: [noCard(T, 'no card')] });
      expect(isCard(r.final[T])).toBe(true);
    }
  });

  it('a ledger that cannot be read means every pass is used: the park is a card, said loudly, and the slot does not fail', () => {
    const r = verify({ tasks: { [T]: { name: NAME, notes: ADOBE } }, ledger: '{not json', actions: [noCard(T, 'no card')] });
    expect(r.code).toBe(0);
    expect(isCard(r.final[T])).toBe(true);
    expect(r.err).toContain('WARNING: the no-card pass ledger cannot be read');
    expect(r.out.noCardNotices).toHaveLength(1);
    expect(r.ledger).toBe(null);                         // never overwritten
  });

  it("two runs starting passes at once lose none: the ledger's read-modify-write is locked", () => {
    const script = `
import json, os, subprocess, sys, tempfile
state = tempfile.mkdtemp()
worker = '''
import importlib.util, sys, time
from datetime import datetime
spec = importlib.util.spec_from_file_location("d", ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.STATE_DIR = sys.argv[1]
m.append_note_checked = lambda *a, **k: None
real = m.load_pass_ledger
def slow():
    led = real()
    time.sleep(0.004)                                   # widen the gap between the read and the write
    return led
m.load_pass_ledger = slow
now = datetime.now(m.LONDON)
for i in sys.argv[2:]:
    m.start_no_card_pass(i, "a door", "", now)
'''
procs = [subprocess.Popen([sys.executable, "-c", worker, state] + ["rec%s%013d" % (w, n) for n in range(25)]) for w in "AB"]
codes = [p.wait() for p in procs]
led = json.load(open(os.path.join(state, "no-card-pass.json")))
print("@@@" + json.dumps({"codes": codes, "entries": len(led), "tmpLeft": [f for f in os.listdir(state) if f.endswith(".tmp")]}))
`;
    const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
    expect(JSON.parse(raw.slice(raw.indexOf('@@@') + 3))).toEqual({ codes: [0, 0], entries: 50, tmpLeft: [] });
  });

  it('Notes that read blank by id while the listing read them: the pass stands in the ledger, Notes are not overwritten, and the run says so', () => {
    const r = verify({ tasks: { [T]: { name: NAME, notes: ADOBE } }, blankById: [T], actions: [noCard(T, 'no card')] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('its Notes read blank by id while the listing read');
    expect(r.writes).toEqual([]);
    expect(Object.keys(r.ledger)).toEqual([T]);
  });

  it('CONTROL: the event in the Description (the inbound email) never counts', () => {
    const r = verify({ tasks: { [T]: { name: NAME, description: 'From Adobe: we will remind the signer {dm:+1} 21:41.' } },
      actions: [noCard(T, 'no card')] });
    expect(isCard(r.final[T])).toBe(true);
  });

  it('CONTROL: the event only in the run\'s report, never on the task, is no door', () => {
    const r = verify({ tasks: { [T]: { name: NAME } }, actions: [noCard(T, 'no card: Adobe reminder {dm:+1} 21:41')] });
    expect(isCard(r.final[T])).toBe(true);
  });

  it('CONTROL: an event more than 48 hours away is no door', () => {
    const r = verify({ tasks: { [T]: { name: NAME, notes: '[{day:0} — agent] Adobe reminder {dm:+4} 21:41' } }, actions: [noCard(T, 'no card')] });
    expect(isCard(r.final[T])).toBe(true);
  });

  it('the clock reads the live wording: a door at 13:18, none once 21:41 has gone, none with no clock time', () => {
    const text = 'Authority still unsigned; Adobe sends its own reminder 14 Oct 21:41; re-check 15 Oct noted on task.';
    expect(event(text)).toBe('2026-10-14 21:41');
    expect(event(text, '2026-10-14T22:05')).toBe('');
    expect(event("Adobe's reminder goes tonight")).toBe('');
    expect(event('Roy replied this morning')).toBe('');
    expect(event('re-check 16 Oct; 09:30 is when the council opens')).toBe('');
    expect(event('The DWP said its decision comes 2026-10-15 at 2pm.')).toBe('2026-10-15 14:00');
  });
});

describe('a named task is a door only when it is open, due within 7 days, clear and not a twin', () => {
  const T = 'recWAITSONOTHER01';
  const OTHER = 'recCARRIESTHEWORK';
  const run = (other, words = `no card: the boiler job ${OTHER} carries this`) => verify({
    tasks: { [T]: { name: 'INBOUND: tenant asks when the boiler is fixed' }, [OTHER]: { name: 'MAINTENANCE: boiler repair', ...other } },
    actions: [noCard(T, words)], owed: [[T, 'new']] });

  it('names the open task due in 3 days: its one pass starts, read by listing, never a GET', () => {
    const r = run({ due: '{d:+3}' });
    expect(r.code).toBe(0);
    expect(r.out.parkedWithDoor[0].door).toMatch(new RegExp(`^open task ${OTHER} \\(Today, due \\d{4}-\\d{2}-\\d{2}\\) carries it \\(its one 48-hour pass starts now\\)$`));
    expect(r.listed.some((f) => (f || '').includes(`RECORD_ID()='${OTHER}'`))).toBe(true);
    expect(r.gets).not.toContain(OTHER);
  });

  it.each([
    ['Completed', { status: 'Completed' }, 'is Completed'],
    ['due beyond 7 days', { due: '{d:+17}' }, 'not today or within 7 days'],
    ['Overdue, due a month ago', { status: 'Overdue', due: '{d:-30}' }, 'not today or within 7 days'],
    ['on a wall', { due: '{d:+2}', notes: '[13 Oct 2026 09:12 — agent] BLOCKER OPEN (TOOL robot setup): broken. Fix: x [since 2026-10-13T08:12:52.000Z]' }, 'is on a wall'],
    ['citing this task back', { due: '{d:+2}', notes: '[{day:0} — agent] waits on recWAITSONOTHER01' }, 'cites this task back'],
  ])('CONTROL: the task it names is %s, so it is no door and a card is made', (_label, other, why) => {
    const r = run(other);
    expect(isCard(r.final[T])).toBe(true);
    expect(r.final[T].agentOutput).toContain(why);
  });

  it('CONTROL: an id that is not a task on the board is no door', () => {
    const r = verify({ tasks: { [T]: { name: GENERIC } }, actions: [noCard(T, 'no card: recNOTONTHEBOARD1 carries this')] });
    expect(r.final[T].agentOutput).toContain('recNOTONTHEBOARD1 is not a task on the board');
  });

  it('twins never vouch for each other: A cites B and B cites A in one run, both become cards', () => {
    const A = 'recTWINTASKAAAAA1';
    const B = 'recTWINTASKBBBBB1';
    const r = verify({ tasks: { [A]: { name: GENERIC, due: '{d:+1}' }, [B]: { name: 'INBOUND: council chases the form', due: '{d:+1}' } },
      actions: [noCard(A, `no card: ${B} carries it`), noCard(B, `no card: ${A} carries it`)] });
    expect([isCard(r.final[A]), isCard(r.final[B])]).toEqual([true, true]);
  });

  it('a task already at Approval is a door whatever its due date: a card in Kevin\'s queue', () => {
    const r = run({ status: 'Approval', due: '{d:-4}' });
    expect(r.out.parkedWithDoor[0].door).toBe(`${OTHER} is already a card in Kevin's queue (its one 48-hour pass starts now)`);
  });
});

describe('what the rule leaves alone', () => {
  it('an agent cannot type a park line or a pass line itself: annotate refuses both', () => {
    for (const note of ["[14 Oct 2026 09:00 — agent-dispatch] Parked until 2026-12-01 on Kevin's answer",
      '[14 Oct 2026 09:00 — agent-dispatch] NO-CARD PASS (48 hours, once): x']) {
      const script = `
import importlib.util, types
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.get_task = lambda tid: {"id": tid, "fields": {}}
m.patch_task = lambda tid, f: (_ for _ in ()).throw(AssertionError('wrote'))
try:
    m.cmd_annotate(types.SimpleNamespace(task='recX', note=${JSON.stringify(note)}))
    print('@@@wrote')
except SystemExit as e:
    print('@@@' + str(e))
`;
      const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
      expect(raw.slice(raw.indexOf('@@@') + 3)).toContain("refusing a note on recX that writes Kevin's park line or a no-card pass");
    }
  });

  it('a parked task that was Completed meanwhile needs no card', () => {
    const T = 'recDONEMEANWHILE1';
    const r = verify({ tasks: { [T]: { name: GENERIC, status: 'Completed' } }, actions: [noCard(T, 'no card: later')] });
    expect(r.writes).toEqual([]);
    expect(r.out.parkedWithDoor).toEqual([{ task: T, door: 'it is Completed' }]);
  });

  it("a task on an open wall is the blocker loop's: no card, and its failure still alarms as before", () => {
    const T = 'recWALLEDTASK0001';
    const r = verify({ tasks: { [T]: { name: 'INBOUND: something', notes: '[13 Oct 2026 09:12 — agent] BLOCKER OPEN (TOOL robot setup): broken. Fix: x [since 2026-10-13T08:12:52.000Z] [finding 20261013-x-1]' } },
      actions: [noCard(T, 'blocked this run: waits on the open fix; no card')] });
    expect(r.writes).toEqual([]);
    expect(r.err).toContain(`action failed: new ${T}`);
  });

  it('"no card payment" on a carry-out is a bank card, never a parked task', () => {
    const T = 'recCARRYOUTTASK01';
    const r = verify({ tasks: { [T]: { name: 'Pay the council' } },
      actions: [{ task: T, kind: 'carry_out', ok: false, error: 'no card payment found in Gmail, so nothing was carried out' }] });
    expect(r.writes).toEqual([]);
    expect(r.err).toContain(`action failed: carry_out ${T}`);
  });

  it('a task the run put a card on after the failure, and the card is in his queue, is not parked', () => {
    const T = 'recESCALATEDTASK1';
    const r = verify({ tasks: { [T]: { name: 'INBOUND: something', status: 'Approval' } },
      actions: [noCard(T, 'no card from the agent'), { task: T, kind: 'escalate', ok: true }] });
    expect(r.writes).toEqual([]);
  });
});

describe("Kevin's hold counts only from dated fields his own actions write", () => {
  const EPC = 'recEPCEXPIREDTASK';
  const QUOTES = 'recEPCQUOTESTASK1';
  const HOLD = "[2026-10-08 14:09] Let's put these on the back burner until we've got the EICRs and gas safety certificates in place.";
  // The live shape of 14 Oct: the EPC task carries nothing of Kevin's; his hold is a sentence in his verdict on
  // the quotes task, and each task names the other. Words are not a hold, so it comes to him ONCE as a card,
  // where he sets a dated hold; it never comes back while that card waits.
  const epc = (quotes, runs = 1) => verify({ runs,
    tasks: { [EPC]: { name: 'COMPLIANCE: EPC expired - 1 Example Place', notes: `[{day:0} — agent] still on hold by Kevin's ruling on ${QUOTES}` },
      [QUOTES]: { name: 'COMPLIANCE: EPC quotes received - four houses', status: 'Upcoming', due: '{d:+1}', notes: `[{day:-6} — agent] not a duplicate of ${EPC}`, ...quotes } },
    actions: [noCard(EPC, "no card: the EPC stays on hold by Kevin's ruling until the EICR is filed")], owed: [[EPC, 'new']] });

  it('the EPC shape comes to Kevin exactly once as a card', () => {
    const r = epc({ history: HOLD }, 2);
    expect(r.first.out.cardedNoDoor).toEqual([{ task: EPC, card: 'decision' }]);
    expect(isCard(r.final[EPC])).toBe(true);
    expect(r.final[EPC].agentOutput).toContain(`${QUOTES} cites this task back`);
    expect(r.out.cardedNoDoor).toEqual([]);
    expect(r.out.parkedWithDoor).toEqual([{ task: EPC, door: "it is already a card in Kevin's queue" }]);
    expect(r.writes.filter((w) => w.task === QUOTES)).toEqual([]);
  });

  it('a linked task at Approval is a door only through the ordinary rule, which spends the pass', () => {
    const r = epc({ status: 'Approval', due: '{d:-3}' });
    expect(r.out.parkedWithDoor[0].door).toBe(`${QUOTES} is already a card in Kevin's queue (its one 48-hour pass starts now)`);
    expect(Object.keys(r.ledger)).toEqual([EPC]);
  });

  it.each([
    ["Why is this still on hold?"], ['This should not be on hold.'], ["Let's put this on the back burner for now."],
  ])('his verdict words "%s" on the task itself are never read as a hold', (words) => {
    const T = 'recKEVINWORDSTASK';
    const r = verify({ tasks: { [T]: { name: GENERIC, feedback: words, outcome: 'Changes requested' } }, owed: [[T, 'redo']],
      actions: [{ task: T, kind: 'redo', ok: false, error: 'no card: Kevin is holding this' }] });
    expect(isCard(r.final[T])).toBe(true);
  });

  it.each([
    ['his knock-back to a later day (Deferred Until)', { deferred: '{d:+5}' }, /^Kevin knocked it back to \d{4}-\d{2}-\d{2}$/],
    ['the Some Day tick, dated by the due date it blanked 3 days ago', { someDay: true, due: null, lmtDue: '{iso:-72h}' }, /^Kevin put it on Some Day, which holds it until \d{2} \w{3} \d{4}$/],
    ["his answer parking it (decided --until)", { notes: "[08 Oct 2026 — agent-dispatch] Parked until {d:+20} on Kevin's answer; it comes back on the board that day." }, /^Kevin's answer parks it until \d{4}-\d{2}-\d{2}$/],
    ['his due date (due, on his words)', { notes: '[09 Oct 2026 10:00 — agent-dispatch] DUE MOVED from 2026-10-09 to {d:+9}: a week (Kevin: "leave it a week")', due: '{d:+9}' }, /^its due date was moved to \d{4}-\d{2}-\d{2} on Kevin's words$/],
  ])('%s holds it: no card, no pass', (_label, extra, door) => {
    const T = 'recKEVINHELDTASK1';
    const r = verify({ tasks: { [T]: { name: GENERIC, ...extra } }, actions: [noCard(T, 'no card: Kevin is holding this')] });
    expect(r.writes).toEqual([]);
    expect(r.ledger).toBe(null);
    expect(r.out.parkedWithDoor[0].door).toMatch(door);
  });

  it.each([
    ['ticked 31 days ago', { someDay: true, due: null, lmtDue: '{iso:-744h}' }],
    ['ticked with no readable time', { someDay: true, due: null }],
    ['ticked while a due date stands (the time is not the tick\'s)', { someDay: true, lmtDue: '{iso:-24h}' }],
    ['knocked back to a day already gone', { deferred: '{d:-1}' }],
  ])('CONTROL: Some Day or a knock-back %s holds nothing: a card', (_label, extra) => {
    const T = 'recKEVINHELDTASK2';
    const r = verify({ tasks: { [T]: { name: GENERIC, ...extra } }, actions: [noCard(T, 'no card')] });
    expect(isCard(r.final[T])).toBe(true);
  });
});

describe('only the kinds the commands write are an outcome', () => {
  it.each([['covered-by-related'], ['new-work-dispatched'], ['routing'], ['dispatch']])(
    'an owed task whose only action is "%s" is parked: a card', (kind) => {
      const T = 'recINVENTEDKIND01';
      const r = verify({ tasks: { [T]: { name: GENERIC } }, actions: [{ task: T, kind, ok: true, note: 'handled elsewhere' }] });
      expect(isCard(r.final[T])).toBe(true);
    });

  // Each reported outcome, with and without its effect on the board (review round 4: a report is the
  // runner's to write; the board is the evidence).
  const OUTCOMES = [
    ['submit', {}, { status: 'Approval', agentOutput: 'a card' }],
    ['new', {}, { status: 'Approval', agentOutput: 'a card' }],
    ['escalate', {}, { status: 'Approval', agentOutput: 'DECIDE: something' }],
    ['complete', {}, { status: 'Completed' }],
    ['block', {}, { notes: '[{day:0} — agent] BLOCKER OPEN (TOOL robot setup): broken. Fix: x [since {iso:-1h}]' }],
    ['route', { to: 'rec1hYELb4zS8pjjO' }, { teamMember: ['rec1hYELb4zS8pjjO'] }],
    ['handover', { to: 'roy.lavin1978@gmail.com' }, { teamMember: ['reclbdjfVev3bqNHS'] }],
    ['decided', {}, { status: 'Upcoming', notes: "[{day:0} — agent-dispatch] Parked until {d:+20} on Kevin's answer; it comes back on the board that day." }],
  ];
  it.each(OUTCOMES)('CONTROL: "%s" reported and on the board is an outcome: no card', (kind, extra, board) => {
    const T = 'recREALKINDTASK01';
    const r = verify({ tasks: { [T]: { name: GENERIC, ...board } }, actions: [{ task: T, kind, ok: true, ...extra }] });
    expect(r.out.cardedNoDoor ?? []).toEqual([]);
    expect(r.writes.filter((w) => JSON.stringify(w.fields).includes('DECIDE: A robot left'))).toEqual([]);
  });

  it.each(OUTCOMES)('"%s" reported ok but not on the board is no outcome: a card', (kind, extra) => {
    const T = 'recREALKINDTASK02';
    const r = verify({ tasks: { [T]: { name: GENERIC } }, actions: [{ task: T, kind, ok: true, ...extra }] });
    expect(isCard(r.final[T])).toBe(true);
  });

  it('the review\'s own case: {"kind":"escalate","ok":true} with the task still at Today is carded', () => {
    const T = 'recESCALATECLAIM1';
    const r = verify({ tasks: { [T]: { name: GENERIC, status: 'Today' } }, actions: [{ task: T, kind: 'escalate', ok: true }] });
    expect(isCard(r.final[T])).toBe(true);
    expect(r.final[T].agentOutput).toContain('It recorded no reason.');
  });
});

describe("a task Roy or Kevin holds is theirs: never parked, never escalated by this control", () => {
  it.each([['Roy', 'reclbdjfVev3bqNHS'], ['Kevin', 'recHEt2VPYothaqTd']])('owed, failed with no card, held by %s: no card, and the failure still alarms', (_who, rec) => {
    const T = 'recPERSONHELDTASK';
    const r = verify({ tasks: { [T]: { name: GENERIC, teamMember: [rec] } }, actions: [noCard(T, 'no card: with the person')] });
    expect(r.writes).toEqual([]);
    expect(r.err).toContain(`action failed: new ${T}`);
  });

  it('handed to Roy between the listing and the card: escalate reads the owner again and makes no card', () => {
    const T = 'recHANDEDTOROY001';
    const r = verify({ tasks: { [T]: { name: GENERIC } }, ownerNow: { [T]: 'reclbdjfVev3bqNHS' }, actions: [noCard(T, 'no card: later')] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('a person holds it now');
    expect(r.writes).toEqual([]);
  });

  it('not owed and held by no AI agent: not parked', () => {
    const T = 'recNOBODYSTASK001';
    const r = verify({ tasks: { [T]: { name: GENERIC, teamMember: [] } }, owed: [], actions: [{ task: T, kind: 'annotate', ok: true, note: 'no card: later' }] });
    expect(r.writes).toEqual([]);
  });
});

describe('the read is paged, never capped', () => {
  it('85 ids are listed in three pages of up to 40, every one returned', () => {
    const script = `
import importlib.util, json, re
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
calls = []
def fake(table, formula=None, fields=None, max_records=None):
    calls.append(formula)
    return [{"id": i, "fields": {}} for i in re.findall(r"RECORD_ID\\(\\)='(rec\\w+)'", formula)]
m.query_records = fake
got = m._list_by_id(m.TASKS, ["rec%014d" % n for n in range(85)], [])
print('@@@' + json.dumps({"got": len(got), "pages": len(calls)}))
`;
    const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
    expect(JSON.parse(raw.slice(raw.indexOf('@@@') + 3))).toEqual({ got: 85, pages: 3 });
  });
});
