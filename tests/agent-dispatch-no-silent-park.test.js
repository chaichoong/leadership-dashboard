// NO SILENT PARKING (Kevin, 14 Oct 2026: "Stop silent parking").
//
// On 13 Oct 2026 Roy emailed asking for a tenant's direct rent payment request (UC47 / APA) to go to
// the DWP. Three dispatch slots left the task with no card: "the direct rent form comes through the
// new-tenant rent lane after Roy answers the 15 Oct costs check; a card here would be a twin". No task
// in that lane existed to carry it, the final check's failure went only into a run report, and the
// form went in a day late, by hand.
//
// The rule: a task a run leaves with no card (in any words, or owed new work it touched and ended with
// no outcome) stays off Kevin's queue only at a door the live board proves: an open task by its id,
// due within 7 days, not on a wall and not itself parked; an outside event with a clock time in the
// task's own words; Kevin's own park. With none, the final control puts it in his queue itself. A
// direct rent request never waits on another lane: it reaches him as a KEVIN ONLY card (Your step once
// approved) the same day, and its tenancy is marked so the rent lane raises no second form.
//
// These drive the real cmd_verify (and through it the real cmd_submit and cmd_escalate) with only the
// Airtable reads and writes swapped for an in-memory board. Every name is invented. Dates are written
// relative to today as {d:+N} (ISO) and {dm:+N} ("15 Oct"), so the tests hold on any day.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const INBOX = 'recJ8J8idWE8d97tH';      // AI Inbox Response, a live role agent (RESPONSE_REC_ID)
const TASKMGR = 'rec1hYELb4zS8pjjO';    // AI Task Board Manager (TASKMGR_REC_ID): escalate's sender

const UC47 = 'recUCFORTYSEVEN01';
const TENANCY = 'recTENANCYEXAMPL1';
const UC47_NAME = 'INBOUND (follow-up): Roy says Ada Example UC housing costs verified, submit an APA';
// The incident's own words, with the date made relative.
const LANE_WORDS = 'no card by the agent: the direct rent form comes through the new-tenant rent lane after Roy '
  + 'answers the {dm:+1} costs check; a card here would be a twin. Task annotated, stays open.';

// tasks: {id: {name, status, due, notes, description, teamMember, inbound, agentOutput, outcome, tenancies}}
// owed: the queue's worklist as [[id, kind]]; by default every task the run acted on, as new work.
function verify({ tasks, actions, dryRun = false, owed = null, tenancies = {}, readFails = false, runs = 1 }) {
  const cfg = { tasks, actions, dryRun, owed, tenancies, readFails, runs };
  const script = `
import importlib.util, json, os, re, io, sys, types, tempfile, contextlib
from datetime import datetime, timedelta
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
TODAY = datetime.now(m.LONDON).date()
def rel(txt):
    txt = re.sub(r"\\{d:([+-]\\d+)\\}", lambda g: (TODAY + timedelta(days=int(g.group(1)))).isoformat(), txt)
    return re.sub(r"\\{dm:([+-]\\d+)\\}", lambda g: (TODAY + timedelta(days=int(g.group(1)))).strftime("%-d %b"), txt)
cfg = json.loads(rel(${JSON.stringify(JSON.stringify(cfg))}))
tmp = tempfile.mkdtemp()
m.STATE_DIR = tmp
m.HANDOVER_DIR = os.path.join(tmp, 'handover')
rundir = os.path.join(tmp, 'run'); os.makedirs(rundir)
report = {"startedAt": datetime.now(m.LONDON).isoformat(), "queueCounts": {"worklist": len(cfg["tasks"]), "openTasksRead": 50},
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
                  AF["inboundTask"]: t.get("inbound", True), AF["agentOutput"]: t.get("agentOutput", ""),
                  AF["approvalOutcome"]: t.get("outcome") or None, m.TASK_TENANCIES: t.get("tenancies", [])}
writes, listed, gets = [], [], []
def fake_get_task(tid):
    gets.append(tid)
    if tid not in store: raise RuntimeError('no such task')
    return {"id": tid, "fields": dict(store[tid])}
def fake_query_records(table, formula=None, fields=None, max_records=None):
    listed.append([table, formula])
    if cfg["readFails"]: raise RuntimeError("Airtable GET 503")
    ids = re.findall(r"RECORD_ID\\(\\)='(rec[A-Za-z0-9]+)'", formula or "")
    if table == m.TENANCIES_TABLE:
        return [{"id": i, "fields": {m.TENANCY_PAY_STATUS: cfg["tenancies"][i]}} for i in ids if i in cfg["tenancies"]]
    assert table == m.TASKS, table
    if ids:
        return [{"id": i, "fields": dict(store[i])} for i in ids if i in store]
    marks = re.findall(r"FIND\\('([^']+)'", formula or "")
    return [{"id": i, "fields": dict(f)} for i, f in store.items() if f.get(AF["status"]) != "Cancelled"
            and any(mk in str(f.get(AF["notes"]) or "") for mk in marks)]
def fake_patch(tid, fields):
    writes.append({"task": tid, "fields": fields})
    store.setdefault(tid, {}).update(fields)
    return {}
m.get_task, m.query_records, m.patch_task = fake_get_task, fake_query_records, fake_patch
m.history = lambda **kw: {"terms": ["ref EXAMPLE"], "searched": ["tasks", "Gmail"], "notes": [], "entries": []}
m.fetch_role_roster = lambda: {${JSON.stringify(INBOX)}: {"name": "AI Inbox Response", "status": "Live", "dispatchable": True, "learningLog": ""}}
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
               "sentBy": f.get(AF["sentForApprovalBy"]) or [], "plain": f.get(AF["plainSummary"]) or ""} for tid, f in store.items()}
print('@@@' + json.dumps({**results[-1], "first": results[0], "writes": writes, "listed": listed, "gets": gets, "final": final}))
`;
  const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  return JSON.parse(raw.slice(raw.indexOf('@@@') + 3));
}

// A pure helper of the rule, at a fixed moment (14 Oct 2026, 13:18 London) where the time of day matters.
function pure(code, at = '2026-10-14T13:18') {
  const script = `
import importlib.util, json
from datetime import datetime
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
now = datetime.fromisoformat(${JSON.stringify(at)}).replace(tzinfo=m.LONDON)
today = now.date()
print('@@@' + json.dumps(${code}))
`;
  const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  return JSON.parse(raw.slice(raw.indexOf('@@@') + 3));
}
const event = (text, at) => pure(`m.no_card_event(${JSON.stringify(text)}, today, now)`, at);

const noCard = (task, words, extra = {}) => ({ task, kind: 'new', ok: false, error: words, ...extra });
const GENERIC = 'INBOUND: council asks for the HMO licence renewal form';

describe('Case A: a task parked with no door comes to Kevin as a card (the 13-14 Oct bug)', () => {
  it('the direct rent request parked on "the new-tenant rent lane" becomes a KEVIN ONLY card, and its tenancy is marked', () => {
    const r = verify({
      tasks: { [UC47]: { name: UC47_NAME, description: 'Roy: housing cost has been verified, please submit an APA.', tenancies: [TENANCY] } },
      tenancies: { [TENANCY]: 'CFV' },
      actions: [noCard(UC47, LANE_WORDS, { tier1: true })],
    });
    expect(r.err).not.toContain('action failed');
    expect(r.code).toBe(0);
    const t = r.final[UC47];
    expect(t.status).toBe('Approval');
    expect(t.sentBy).toEqual([INBOX]);
    // Kevin's own step, numbered, so his approval returns it as Your step with a Done box.
    expect(t.agentOutput).toMatch(/^KEVIN ONLY: credential: 1\. Open https:\/\/directpayment\.universal-credit\.service\.gov\.uk\//m);
    expect(t.agentOutput).toContain('Check first that no direct rent form has gone in for this tenancy already.');
    expect(t.agentOutput).toContain('TRACK RECORD: none found');
    expect(t.agentOutput.trim().split('\n').pop()).toMatch(/^\*\*Carrying this out will involve:\*\* the card coming back to you as your step/);
    expect(t.agentOutput).toMatch(/^:rotating_light: TIER 1\./);
    expect(t.agentOutput).toContain('comes through the new-tenant rent lane');
    // The KEVIN wall the approval turns into Your step, carrying every step (none cut off).
    expect(t.notes).toMatch(/BLOCKER OPEN \(KEVIN credential\): 1\. Open .* 5\. Put what the last page said in the Done box\./);
    // The line the rent lane reads before it raises a form card of its own.
    expect(t.notes).toMatch(new RegExp(`— agent-dispatch\\] DIRECT RENT CARD: ${TENANCY}: Kevin has this tenancy's direct rent request`));
    expect(r.out.cardedNoDoor).toEqual([{ task: UC47, card: 'your step', agent: INBOX }]);
  });

  it('the same words on an ordinary task become a decision card from the Task Board Manager', () => {
    const T = 'recGENERICTASK001';
    const r = verify({
      tasks: { [T]: { name: GENERIC } },
      actions: [noCard(T, 'no card: the renewal comes through the compliance lane once the book is updated, a card here would be a twin')],
    });
    expect(r.code).toBe(0);
    const t = r.final[T];
    expect(t.status).toBe('Approval');
    expect(t.sentBy).toEqual([TASKMGR]);
    expect(t.agentOutput).toMatch(/^DECIDE: A robot left this task with no card and nothing lined up to pick it up\./);
    expect(t.agentOutput).toContain("the task's own words date no outside event");
    expect(t.agentOutput).toMatch(/^B\. It waits: approve with the date in your note/m);
    expect(r.out.cardedNoDoor[0]).toMatchObject({ task: T, card: 'decision' });
  });

  it('the self-check names the missing door and writes nothing, so the run can fix it first', () => {
    const r = verify({ tasks: { [UC47]: { name: UC47_NAME } }, actions: [noCard(UC47, LANE_WORDS, { tier1: true })], dryRun: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${UC47} was left with no card and no door`);
    expect(r.err).toContain('never waits on another lane');
    expect(r.err).not.toContain('action failed');
    expect(r.writes).toEqual([]);
  });

  it('a card that cannot be made fails the run loudly, never quietly', () => {
    // Kevin already answered this decision card, so escalate refuses to ask again: the run must say so.
    const T = 'recANSWEREDCARD01';
    const r = verify({
      tasks: { [T]: { name: 'Decide the garden contract', agentOutput: 'DECIDE: which contractor?', outcome: 'Approved as-is' } },
      actions: [noCard(T, 'no card: waiting')],
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${T} was left with no card and no door`);
    expect(r.err).toContain('no card could be made for Kevin');
    expect(r.err).toContain('Kevin has ANSWERED the decision card');
    expect(r.writes).toEqual([]);
  });

  it('a second verify of the same run finds the card it made and makes no other ("already in Kevin\'s queue")', () => {
    const T = 'recGENERICTASK002';
    const r = verify({ tasks: { [T]: { name: GENERIC } }, actions: [noCard(T, 'no card: later')], runs: 2 });
    expect(r.first.out.cardedNoDoor[0].task).toBe(T);
    expect(r.code).toBe(0);
    expect(r.out.cardedNoDoor).toEqual([]);
    expect(r.out.parkedWithDoor).toEqual([{ task: T, door: "it is already a card in Kevin's queue" }]);
    expect(r.first.out.cardedNoDoor).toHaveLength(1);
  });

  it('a failed read is a failure, never a pass, and nothing is written', () => {
    const r = verify({ tasks: { [UC47]: { name: UC47_NAME } }, actions: [noCard(UC47, LANE_WORDS)], readFails: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain('could not be read to check their doors (Airtable GET 503), so none is excused');
    expect(r.writes).toEqual([]);
  });

  it('a parked task that does not read back as a task is a failure too', () => {
    const r = verify({ tasks: {}, actions: [noCard('recNOTONTHEBOARD1', 'no card: later')] });
    expect(r.code).toBe(1);
    expect(r.err).toContain('recNOTONTHEBOARD1 was left with no card and does not read back as a task');
  });
});

describe('Finding 2: a park is a park whatever it says', () => {
  it('owed new work ended with only an annotate ("code build, waits for a build session") is parked', () => {
    const T = 'recCODEBUILDTASK1';
    const r = verify({ tasks: { [T]: { name: 'Build the rent statement export' } },
      actions: [{ task: T, kind: 'annotate', ok: true, note: 'code build, waits for a build session' }] });
    expect(r.final[T].status).toBe('Approval');
    expect(r.out.cardedNoDoor[0]).toMatchObject({ task: T, card: 'decision' });
  });

  it('owed new work that failed with no reason at all is parked, and the card says so', () => {
    const T = 'recFAILEDSUBMIT01';
    const r = verify({ tasks: { [T]: { name: GENERIC } }, actions: [{ task: T, kind: 'new', ok: false }] });
    expect(r.err).not.toContain('action failed');
    expect(r.final[T].agentOutput).toContain('It recorded no reason.');
  });

  it.each([
    ['no-card: held for the costs check'],
    ['no new card: the old one stands'],
    ['left without a card until Monday'],
    ['not carded, waiting on the reply'],
  ])('a task not owed this run is parked when its note says "%s"', (note) => {
    const T = 'recNOTOWEDTASK001';
    const r = verify({ tasks: { [T]: { name: GENERIC } }, owed: [], actions: [{ task: T, kind: 'annotate', ok: true, note }] });
    expect(r.final[T].status).toBe('Approval');
  });

  it('CONTROL: owed work the run never touched is the next tick\'s, as before: no card is made for it', () => {
    const DONE = 'recCARDEDTASK0001';
    const LATER = 'recUNTOUCHEDTASK1';
    const r = verify({ tasks: { [DONE]: { name: GENERIC, status: 'Approval', agentOutput: 'a card' }, [LATER]: { name: GENERIC } },
      owed: [[DONE, 'new'], [LATER, 'new']], actions: [{ task: DONE, kind: 'new', ok: true }] });
    expect(r.writes.filter((w) => w.task === LATER)).toEqual([]);
    expect(r.final[LATER].status).toBe('Today');
  });
});

describe('Finding 4: a route is an outcome, unless the run then tried the work and failed', () => {
  it('routed, with a note saying so: no card is made', () => {
    const T = 'recROUTEDTASK0001';
    const r = verify({ tasks: { [T]: { name: GENERIC } }, actions: [
      { task: T, kind: 'route', ok: true, to: INBOX }, { task: T, kind: 'annotate', ok: true, note: 'no card: routed to Inbox Response' }] });
    expect(r.out.cardedNoDoor).toEqual([]);
    expect(r.final[T].status).toBe('Today');
  });

  it('routed, then the new work failed with no card (the real 14 Oct 13:18 shape): parked', () => {
    const r = verify({ tasks: { [UC47]: { name: UC47_NAME } }, actions: [
      { task: UC47, kind: 'route', ok: true, to: INBOX }, noCard(UC47, LANE_WORDS, { tier1: true })] });
    expect(r.final[UC47].status).toBe('Approval');
    expect(r.out.cardedNoDoor[0].card).toBe('your step');
  });
});

describe('Case B and finding 3: a named task is a door only when it is open, due within 7 days, clear and not a twin', () => {
  const T = 'recWAITSONOTHER01';
  const OTHER = 'recCARRIESTHEWORK';
  const run = (other, words = `no card: the boiler job ${OTHER} carries this`) => verify({
    tasks: { [T]: { name: 'INBOUND: tenant asks when the boiler is fixed' }, [OTHER]: { name: 'MAINTENANCE: boiler repair', ...other } },
    actions: [noCard(T, words)], owed: [[T, 'new']] });

  it('names the open task due in 3 days: no card, no alarm, the door is listed (read by listing, never a GET)', () => {
    const r = run({ due: '{d:+3}' });
    expect(r.err).not.toContain('action failed');
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([]);
    expect(r.out.parkedWithDoor[0].door).toMatch(new RegExp(`^open task ${OTHER} \\(Today, due \\d{4}-\\d{2}-\\d{2}\\) carries it$`));
    expect(r.listed.some(([, f]) => (f || '').includes(`RECORD_ID()='${OTHER}'`))).toBe(true);
    expect(r.gets).not.toContain(OTHER);
  });

  it('the door may come from the newest note on the task, not only the run report', () => {
    const r = verify({
      tasks: { [T]: { name: 'INBOUND: tenant asks when the boiler is fixed', notes: `[{dm:0} 2026 — agent] waits on ${OTHER}` },
        [OTHER]: { name: 'MAINTENANCE: boiler repair', due: '{d:+2}' } },
      actions: [noCard(T, 'no card')], owed: [[T, 'new']] });
    expect(r.out.parkedWithDoor[0].door).toContain(`open task ${OTHER}`);
  });

  it.each([
    ['Completed', { status: 'Completed' }, 'is Completed'],
    ['due beyond 7 days', { due: '{d:+17}' }, 'not today or within 7 days'],
    ['Overdue, due a month ago', { status: 'Overdue', due: '{d:-30}' }, 'not today or within 7 days'],
    ['on a wall', { due: '{d:+2}', notes: '[13 Oct 2026 09:12 — agent] BLOCKER OPEN (TOOL robot setup): broken. Fix: x [since 2026-10-13T08:12:52.000Z]' }, 'is on a wall'],
  ])('CONTROL: the task it names is %s, so it is no door and a card is made', (_label, other, why) => {
    const r = run(other);
    expect(r.final[T].status).toBe('Approval');
    expect(r.final[T].agentOutput).toContain(why);
  });

  it('CONTROL: an id that is not a task on the board is no door', () => {
    const r = verify({ tasks: { [T]: { name: GENERIC } }, actions: [noCard(T, 'no card: recNOTONTHEBOARD1 carries this')] });
    expect(r.final[T].status).toBe('Approval');
    expect(r.final[T].agentOutput).toContain('recNOTONTHEBOARD1 is not a task on the board');
  });

  it('twins never vouch for each other: A cites B and B cites A, both parked this run, both become cards', () => {
    const A = 'recTWINTASKAAAAA1';
    const B = 'recTWINTASKBBBBB1';
    const r = verify({ tasks: { [A]: { name: GENERIC, due: '{d:+1}' }, [B]: { name: 'INBOUND: council chases the licence form', due: '{d:+1}' } },
      actions: [noCard(A, `no card: ${B} carries it`), noCard(B, `no card: ${A} carries it`)] });
    expect([r.final[A].status, r.final[B].status]).toEqual(['Approval', 'Approval']);
    expect(r.final[A].agentOutput).toContain(`${B} was itself left with no card this run`);
  });

  it('a task already at Approval is a door whatever its due date: it is a card in Kevin\'s queue', () => {
    const r = run({ status: 'Approval', due: '{d:-4}' });
    expect(r.writes).toEqual([]);
    expect(r.out.parkedWithDoor[0].door).toBe(`${OTHER} is already a card in Kevin's queue`);
  });
});

describe('Case C and finding 1: an outside event is a door only from the task\'s own words, with a sender and a clock time', () => {
  const T = 'recAUTHORITYFORM1';
  const NAME = 'Ada Example (Unit 1): authority to act still unsigned, send a reminder';

  it('the signing service\'s reminder at a stated time, in the task\'s own notes: no card, no alarm', () => {
    const r = verify({
      tasks: { [T]: { name: NAME, notes: "[{dm:0} 2026 — agent] still unsigned. Adobe's own reminder goes {dm:+1} at 21:41, so a chase now would duplicate it." } },
      actions: [noCard(T, 'no card by the agent: authority form still unsigned, the signing service sends its own reminder')],
    });
    expect(r.err).not.toContain('action failed');
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([]);
    expect(r.out.parkedWithDoor[0].door).toMatch(/^an outside event on the task: Adobe \d{4}-\d{2}-\d{2} 21:41$/);
  });

  it('CONTROL: the same event only in the run\'s report, never on the task, is no door (the report is the runner\'s to edit)', () => {
    const r = verify({ tasks: { [T]: { name: NAME } },
      actions: [noCard(T, 'no card: the signing service sends its own reminder {dm:+1} at 21:41')] });
    expect(r.final[T].status).toBe('Approval');
  });

  it('the live wording is a door at 13:18 and none once 21:41 has gone', () => {
    const text = 'Authority still unsigned; the signing service sends its own reminder 14 Oct 21:41; re-check 15 Oct noted on task.';
    expect(event(text)).toBe('signing service 2026-10-14 21:41');
    expect(event(text, '2026-10-14T22:05')).toBe('');
    expect(event("Adobe's own reminder fires tonight at 21:41, so no chase")).toBe('Adobe 2026-10-14 21:41');
  });

  it.each([
    ['the robot re-checks 15 Oct 09:00'],
    ['the agent tries again tomorrow at 9am'],
    ['the Task Manager sweeps it 16 Oct 07:00'],
    ['the daily rent check runs tomorrow at 09:00 and makes the form card'],
    ['Roy replied this morning'],
    ["Adobe's reminder goes tonight"],
    ['the council replies 16 Oct'],
    ['re-check 16 Oct; 09:30 is when the council opens'],
    ['the council replies 30 Oct at 10:00'],
  ])('CONTROL: "%s" is no door', (text) => {
    expect(event(text)).toBe('');
  });

  it('an outside sender with a clock time inside the window is one', () => {
    expect(event('the council replies 16 Oct at 10:00')).toBe('council 2026-10-16 10:00');
    expect(event('The DWP said its decision comes 2026-10-17 at 2pm.')).toBe('DWP 2026-10-17 14:00');
  });
});

describe("Kevin's own park, and what the rule leaves alone", () => {
  it.each([
    ['decided --until', "[08 Oct 2026 — agent-dispatch] Parked until {d:+20} on Kevin's answer; it comes back on the board that day.", {}],
    ['due on his words', '[09 Oct 2026 10:00 — agent-dispatch] DUE MOVED from 2026-10-09 to {d:+9}: give it a week (Kevin: "leave it a week")', { due: '{d:+9}' }],
  ])('a park recorded by %s is a door', (_label, notes, extra) => {
    const T = 'recPARKEDBYKEVIN1';
    const r = verify({ tasks: { [T]: { name: 'COMPLIANCE: EPC expired - 1 Example Place', notes, ...extra } },
      actions: [noCard(T, "no card: Kevin's ruling holds this")] });
    expect(r.writes).toEqual([]);
    expect(r.out.parkedWithDoor[0].door).toMatch(/^(Kevin's answer parks it until|its due date was moved to) \d{4}-\d{2}-\d{2}/);
  });

  it('CONTROL: an agent cannot type that park line itself: annotate refuses it', () => {
    const script = `
import importlib.util, types
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.get_task = lambda tid: {"id": tid, "fields": {}}
m.patch_task = lambda tid, f: (_ for _ in ()).throw(AssertionError('wrote'))
try:
    m.cmd_annotate(types.SimpleNamespace(task='recX', note="[14 Oct 2026 09:00 — agent-dispatch] Parked until 2026-12-01 on Kevin's answer"))
    print('@@@wrote')
except SystemExit as e:
    print('@@@' + str(e))
`;
    const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
    expect(raw.slice(raw.indexOf('@@@') + 3)).toContain("refusing a note on recX that writes Kevin's park line");
  });

  it('a parked task that was Completed meanwhile needs no card', () => {
    const T = 'recDONEMEANWHILE1';
    const r = verify({ tasks: { [T]: { name: GENERIC, status: 'Completed' } }, actions: [noCard(T, 'no card: later')] });
    expect(r.writes).toEqual([]);
    expect(r.out.parkedWithDoor).toEqual([{ task: T, door: 'it is Completed' }]);
  });

  it("a task on an open wall is the blocker loop's: no card is made, and its failure still alarms as before", () => {
    const T = 'recWALLEDTASK0001';
    const r = verify({
      tasks: { [T]: { name: 'INBOUND: something', notes: '[13 Oct 2026 09:12 — agent] BLOCKER OPEN (TOOL robot setup): broken. Fix: x [since 2026-10-13T08:12:52.000Z] [finding 20261013-x-1]' } },
      actions: [noCard(T, 'blocked this run: waits on the open fix; no card')],
    });
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

  it('a task the run did put a card on is not parked, whatever a note says', () => {
    const T = 'recESCALATEDTASK1';
    const r = verify({ tasks: { [T]: { name: 'INBOUND: something', status: 'Approval' } },
      actions: [noCard(T, 'no card from the agent'), { task: T, kind: 'escalate', ok: true }] });
    expect(r.writes).toEqual([]);
    expect(r.err).toContain(`action failed: new ${T}`);
  });
});

describe('Findings 5 and 6: which task is a direct rent request, and never two forms to the DWP', () => {
  it.each([
    ['Complete UC47 form for Ada', true],
    ['UC47 for Ada, Unit 1', true],
    ['Set up direct rent payment for Ada', true],
    ['Fill in the APA form', true],
    ['tenant started on UC, submit the APA', true],
    ['Ada is waiting on the APA, please submit it', true],
    ['Fwd: Direct payment to landlord request', true],
    ['Apply for Universal Credit managed payment direct to landlord where eligible', true],
    [UC47_NAME, true],
    ['Apply for HMRC managed payment plan', false],
    ['Request managed payment plan from Barclaycard', false],
    ['Request direct payment refund from British Gas', false],
    ["Check DWP decision on Ada Example's UC47 (1 Example Place) and chase if none", false],
    ['INBOUND: UC Direct Payment Arrangement started - Ada Example', false],
    ['Ada Example 1EP - UC47 submitted on the 24 March', false],
    ['NEW TENANT RENT: direct rent check: Unit 1', false],
    ['RENT FORM: direct rent payment form: Unit 1', false],
  ])('"%s" -> %s', (name, want) => {
    expect(pure(`m.direct_rent_request(${JSON.stringify(name)})`)).toBe(want);
  });

  it('its tenancy is already marked CFV Actioned: the form has gone in, so no card', () => {
    const r = verify({ tasks: { [UC47]: { name: UC47_NAME, tenancies: [TENANCY] } }, tenancies: { [TENANCY]: 'CFV Actioned' },
      actions: [noCard(UC47, LANE_WORDS)] });
    expect(r.writes).toEqual([]);
    expect(r.out.parkedWithDoor[0].door).toBe(`its tenancy ${TENANCY} is marked CFV Actioned: the form has gone in`);
  });

  it("the rent lane's own form card for the tenancy already exists: no second card", () => {
    const FORM = 'recRENTFORMCARD01';
    const r = verify({ tasks: { [UC47]: { name: UC47_NAME, tenancies: [TENANCY] },
      [FORM]: { name: 'RENT FORM: direct rent payment form: Unit 1', status: 'Today', notes: `RENT FORM KEY: ${TENANCY}:form:1\nRENT SETUP KEY: ${TENANCY}:form:1` } },
      tenancies: { [TENANCY]: 'CFV' }, actions: [noCard(UC47, LANE_WORDS)], owed: [[UC47, 'new']] });
    expect(r.writes).toEqual([]);
    expect(r.out.parkedWithDoor[0].door).toBe(`${FORM} is already the direct rent card for its tenancy (Today)`);
  });

  it("a direct rent request never waits on another lane: an open task of Roy's due tomorrow is not its door", () => {
    const ROY = 'recROYCOSTSCHECK1';
    const r = verify({
      tasks: { [UC47]: { name: UC47_NAME }, [ROY]: { name: 'NEW TENANT RENT: housing costs check: Unit 1', due: '{d:+1}', teamMember: ['recROYLAVIN000001'] } },
      actions: [noCard(UC47, `no card: the form card follows Roy's answer on ${ROY}, due {dm:+1}`)], owed: [[UC47, 'new']] });
    expect(r.final[UC47].status).toBe('Approval');
    expect(r.final[ROY].status).toBe('Today');
    expect(r.out.cardedNoDoor[0].card).toBe('your step');
  });

  it('...but a card already in his queue IS its door', () => {
    const FORM = 'recRENTFORMCARD02';
    const r = verify({ tasks: { [UC47]: { name: UC47_NAME }, [FORM]: { name: 'RENT FORM: Ada Example, Unit 1', status: 'Approval' } },
      actions: [noCard(UC47, `no card: the direct rent form card ${FORM} is already with Kevin`)], owed: [[UC47, 'new']] });
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([]);
    expect(r.out.parkedWithDoor).toEqual([{ task: UC47, door: `${FORM} is already a card in Kevin's queue` }]);
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
