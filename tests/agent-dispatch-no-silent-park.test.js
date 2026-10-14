// NO SILENT PARKING (Kevin, 14 Oct 2026: "Stop silent parking").
//
// On 13 Oct 2026 Roy emailed asking for a tenant's direct rent payment request (UC47 / APA) to go to
// the DWP. Three dispatch slots left the task with no card: "the direct rent form comes through the
// new-tenant rent lane after Roy answers the 15 Oct costs check; a card here would be a twin". No task
// in that lane existed to carry it, the final check's failure went only into a run report, and the
// form went in a day late, by hand.
//
// The rule: a run may leave a task with no card only when it names a door that exists (an open task
// by its id, due within 7 days; a dated recheck: Kevin's due move or an outside event at a stated
// time; Kevin's own park). With none, the final control puts the task in Kevin's queue itself. A
// direct rent request never waits on another lane: it comes to him as a KEVIN ONLY card (Your step
// once approved) the same day.
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
const UC47_NAME = 'INBOUND (follow-up): Roy says Ada Example UC housing costs verified, submit an APA';
// The incident's own words, with the date made relative.
const LANE_WORDS = 'no card by the agent: the direct rent form comes through the new-tenant rent lane after Roy '
  + 'answers the {dm:+1} costs check; a card here would be a twin. Task annotated, stays open.';

function verify({ tasks, actions, dryRun = false, queue = null }) {
  const cfg = { tasks, actions, dryRun, queue };
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
# The queue the run was handed: every task it acted on, as the kind of work it was owed.
queue = cfg["queue"] if cfg["queue"] is not None else {"generatedAt": report["startedAt"], "worklist": [
    {"id": tid, "kind": "carry_out" if any(a.get("kind") == "carry_out" for a in cfg["actions"] if a.get("task") == tid) else "new"}
    for tid in dict.fromkeys(a.get("task") for a in cfg["actions"])]}
open(os.path.join(rundir, 'queue.json'), 'w').write(json.dumps(queue))
AF = m.AF
store = {}
for tid, t in cfg["tasks"].items():
    store[tid] = {AF["name"]: t.get("name", "A task"), AF["description"]: t.get("description", ""),
                  AF["status"]: t.get("status", "Today") or None,
                  AF["dueDate"]: t.get("due", TODAY.isoformat()), AF["notes"]: t.get("notes", ""),
                  AF["teamMember"]: [{"id": i} for i in t.get("teamMember", [${JSON.stringify(INBOX)}])],
                  AF["inboundTask"]: t.get("inbound", True), AF["agentOutput"]: t.get("agentOutput", ""),
                  AF["approvalOutcome"]: t.get("outcome") or None}
writes, listed, gets = [], [], []
def sel_name(v): return v.get("name") if isinstance(v, dict) else v
def fake_get_task(tid):
    gets.append(tid)
    if tid not in store: raise RuntimeError('no such task')
    return {"id": tid, "fields": dict(store[tid])}
def fake_query_tasks(formula, max_records=None, minimal=False):
    listed.append(formula)
    ids = re.findall(r"RECORD_ID\\(\\)='(rec[A-Za-z0-9]+)'", formula or "")
    return [{"id": i, "fields": dict(store[i])} for i in ids if i in store]
def fake_patch(tid, fields):
    writes.append({"task": tid, "fields": fields})
    for k, v in fields.items():
        store.setdefault(tid, {})[k] = v
    return {}
m.get_task, m.query_tasks, m.patch_task = fake_get_task, fake_query_tasks, fake_patch
m.history = lambda **kw: {"terms": ["ref EXAMPLE"], "searched": ["tasks", "Gmail"], "notes": [], "entries": []}
m.fetch_role_roster = lambda: {${JSON.stringify(INBOX)}: {"name": "AI Inbox Response", "status": "Live", "dispatchable": True, "learningLog": ""}}
m.ledger_last_events = lambda: {}
m.overdue_lessons = lambda: []
out, err, code = io.StringIO(), io.StringIO(), 0
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
    try:
        m.cmd_verify(types.SimpleNamespace(report=os.path.join(rundir, 'report.json'), dry_run=cfg["dryRun"]))
    except SystemExit as e:
        code = e.code or 0
printed = [ln for ln in out.getvalue().splitlines() if ln.startswith('{')]
final = {tid: {"status": sel_name(f.get(AF["status"])), "agentOutput": f.get(AF["agentOutput"]) or "",
               "notes": f.get(AF["notes"]) or "", "sentBy": [x.get("id") if isinstance(x, dict) else x for x in (f.get(AF["sentForApprovalBy"]) or [])],
               "plain": f.get(AF["plainSummary"]) or ""} for tid, f in store.items()}
print('@@@' + json.dumps({"code": code, "out": json.loads(printed[-1]) if printed else {}, "err": err.getvalue(),
                          "writes": writes, "listed": listed, "gets": gets, "final": final}))
`;
  const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  return JSON.parse(raw.slice(raw.indexOf('@@@') + 3));
}

// The pure door rule, at a fixed moment (14 Oct 2026, 13:18 London), for the time-of-day cases.
function door({ task, said, named = {}, at = '2026-10-14T13:18' }) {
  const script = `
import importlib.util, json
from datetime import datetime
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
now = datetime.fromisoformat(${JSON.stringify(at)}).replace(tzinfo=m.LONDON)
cfg = json.loads(${JSON.stringify(JSON.stringify({ task, said, named }))})
d, why = m.no_card_door(cfg["task"], cfg["said"], cfg["named"], now.date(), now)
print('@@@' + json.dumps({"door": d, "why": why}))
`;
  const raw = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  return JSON.parse(raw.slice(raw.indexOf('@@@') + 3));
}

const noCard = (task, words, extra = {}) => ({ task, kind: 'new', ok: false, error: words, ...extra });

describe('Case A: a task parked with no door comes to Kevin as a card (the 13-14 Oct bug)', () => {
  it('the direct rent request parked on "the new-tenant rent lane" becomes a KEVIN ONLY card in his queue the same run', () => {
    const r = verify({
      tasks: { [UC47]: { name: UC47_NAME, description: 'Roy: housing cost has been verified, please submit an APA.' } },
      actions: [noCard(UC47, LANE_WORDS, { tier1: true })],
    });
    expect(r.err).not.toContain('action failed');
    expect(r.code).toBe(0);
    const t = r.final[UC47];
    expect(t.status).toBe('Approval');
    expect(t.sentBy).toEqual([INBOX]);
    // Kevin's own step, numbered, so his approval returns it as Your step with a Done box.
    expect(t.agentOutput).toMatch(/^KEVIN ONLY: credential: 1\. Open https:\/\/directpayment\.universal-credit\.service\.gov\.uk\//m);
    expect(t.agentOutput).toContain('the code the DWP emails to info@agilelets.co.uk');
    expect(t.agentOutput).toContain('TRACK RECORD: none found');
    expect(t.agentOutput.trim().split('\n').pop()).toMatch(/^\*\*Carrying this out will involve:\*\* the card coming back to you as your step/);
    // Tier 1 keeps its banner, and the robot's own words are on the card.
    expect(t.agentOutput).toMatch(/^:rotating_light: TIER 1\./);
    expect(t.agentOutput).toContain('comes through the new-tenant rent lane');
    // The KEVIN wall the approval turns into Your step, carrying every step (none cut off).
    expect(t.notes).toMatch(/BLOCKER OPEN \(KEVIN credential\): 1\. Open .* 5\. Put what the last page said in the Done box\./);
    expect(t.plain).toContain('which only you can send');
    expect(r.out.cardedNoDoor).toEqual([{ task: UC47, card: 'your step', agent: INBOX }]);
  });

  it('the same words on an ordinary task become a decision card from the Task Board Manager', () => {
    const T = 'recGENERICTASK001';
    const r = verify({
      tasks: { [T]: { name: 'INBOUND: council asks for the HMO licence renewal form' } },
      actions: [noCard(T, 'no card: the renewal comes through the compliance lane once the book is updated, a card here would be a twin')],
    });
    expect(r.code).toBe(0);
    const t = r.final[T];
    expect(t.status).toBe('Approval');
    expect(t.sentBy).toEqual([TASKMGR]);
    expect(t.agentOutput).toMatch(/^DECIDE: A robot left this task with no card and nothing lined up to pick it up\./);
    expect(t.agentOutput).toContain("it hands the work to another lane ('comes through')");
    expect(t.agentOutput).toMatch(/^B\. It waits: approve with the date in your note/m);
    expect(r.out.cardedNoDoor[0]).toMatchObject({ task: T, card: 'decision' });
  });

  it('a no-card written only as an annotate note is caught too (the 13 Oct 17:13 slot)', () => {
    const r = verify({
      tasks: { [UC47]: { name: UC47_NAME } },
      actions: [{ task: UC47, kind: 'annotate', ok: true, tier1: true, note: 'no card: held by the rent check housing-costs step' }],
    });
    expect(r.code).toBe(0);
    expect(r.final[UC47].status).toBe('Approval');
    expect(r.out.cardedNoDoor[0].card).toBe('your step');
  });

  it('the self-check names the missing door and writes nothing, so the run can fix it first', () => {
    const r = verify({ tasks: { [UC47]: { name: UC47_NAME } }, actions: [noCard(UC47, LANE_WORDS, { tier1: true })], dryRun: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${UC47} was left with no card and no door`);
    expect(r.err).toContain('never waits on another lane');
    expect(r.err).not.toContain('action failed');
    expect(r.writes).toEqual([]);
  });

  it('a direct rent request never waits on another lane: an open task of Roy\'s due tomorrow is not its door', () => {
    const ROY = 'recROYCOSTSCHECK1';
    const r = verify({
      tasks: { [UC47]: { name: UC47_NAME }, [ROY]: { name: 'NEW TENANT RENT: housing costs check: Unit 1', due: '{d:+1}', teamMember: ['recROYLAVIN000001'] } },
      actions: [noCard(UC47, `no card: the form card follows Roy's answer on ${ROY}, due {dm:+1}`)],
    });
    expect(r.final[UC47].status).toBe('Approval');
    expect(r.final[ROY].status).toBe('Today');
    expect(r.out.cardedNoDoor[0].card).toBe('your step');
  });

  it('...but a form card already in his queue IS its door', () => {
    const FORM = 'recRENTFORMCARD01';
    const r = verify({
      tasks: { [UC47]: { name: UC47_NAME }, [FORM]: { name: 'RENT FORM: Ada Example, Unit 1', status: 'Approval' } },
      actions: [noCard(UC47, `no card: the direct rent form card ${FORM} is already with Kevin`)],
    });
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([]);
    expect(r.out.parkedWithDoor).toEqual([{ task: UC47, door: `${FORM} is already a card in Kevin's queue` }]);
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
});

describe('Case B: a no-card that names an open task due within 7 days is allowed', () => {
  const T = 'recWAITSONOTHER01';
  const OTHER = 'recCARRIESTHEWORK';
  it('names the open task due in 3 days: no card, no alarm, the door is listed', () => {
    const r = verify({
      tasks: { [T]: { name: 'INBOUND: tenant asks when the boiler is fixed' }, [OTHER]: { name: 'MAINTENANCE: boiler repair', due: '{d:+3}' } },
      actions: [noCard(T, `no card: the boiler job ${OTHER} carries this and is due {dm:+3}`)],
    });
    expect(r.err).not.toContain('action failed');
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([]);
    expect(r.out.parkedWithDoor).toHaveLength(1);
    expect(r.out.parkedWithDoor[0].task).toBe(T);
    expect(r.out.parkedWithDoor[0].door).toMatch(new RegExp(`^open task ${OTHER} \\(Today, due \\d{4}-\\d{2}-\\d{2}\\) carries it$`));
    // Read by listing the Tasks table on RECORD_ID(), never a GET by id.
    expect(r.listed.some((f) => f.includes(`RECORD_ID()='${OTHER}'`))).toBe(true);
    expect(r.gets).not.toContain(OTHER);
  });

  it('CONTROL: the task it names is Completed, so it is no door and a card is made', () => {
    const r = verify({
      tasks: { [T]: { name: 'INBOUND: tenant asks when the boiler is fixed' }, [OTHER]: { name: 'MAINTENANCE: boiler repair', status: 'Completed' } },
      actions: [noCard(T, `no card: the boiler job ${OTHER} carries this`)],
    });
    expect(r.final[T].status).toBe('Approval');
    expect(r.final[T].agentOutput).toContain(`${OTHER} is Completed`);
  });

  it('CONTROL: the task it names is due beyond 7 days, so it is no door', () => {
    const r = verify({
      tasks: { [T]: { name: 'INBOUND: tenant asks when the boiler is fixed' }, [OTHER]: { name: 'MAINTENANCE: boiler repair', due: '{d:+17}' } },
      actions: [noCard(T, `no card: the boiler job ${OTHER} carries this`)],
    });
    expect(r.final[T].status).toBe('Approval');
  });

  it('CONTROL: an id that is not a task on the board is no door', () => {
    const r = verify({
      tasks: { [T]: { name: 'INBOUND: tenant asks when the boiler is fixed' } },
      actions: [noCard(T, 'no card: recNOTONTHEBOARD1 carries this')],
    });
    expect(r.final[T].status).toBe('Approval');
    expect(r.final[T].agentOutput).toContain('recNOTONTHEBOARD1 is not a task on the board');
  });
});

describe('Case C: a no-card waiting on a dated outside event is allowed', () => {
  const T = 'recAUTHORITYFORM1';
  it('"the signing service sends its own reminder tonight": no card, no alarm', () => {
    const r = verify({
      tasks: { [T]: { name: 'Ada Example (Unit 1): authority to act still unsigned, send a reminder' } },
      actions: [noCard(T, 'no card by the agent: authority form still unsigned and the signing service sends its own reminder tonight; a chase now would duplicate it')],
    });
    expect(r.err).not.toContain('action failed');
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([]);
    expect(r.out.parkedWithDoor[0].door).toMatch(/^an outside event dated \d{4}-\d{2}-\d{2} tonight$/);
  });

  it('the live wording, "reminder 14 Oct 21:41", is a door at 13:18 and none once 21:41 has gone', () => {
    const task = { id: T, name: 'authority to act', status: 'Today', dueDate: '2026-10-13', notes: '' };
    const said = 'no card by the agent: the signing service sends its own reminder 14 Oct 21:41; re-check 15 Oct noted on task';
    expect(door({ task, said }).door).toBe('an outside event dated 2026-10-14 21:41');
    expect(door({ task, said, at: '2026-10-14T22:05' }).door).toBe('');
  });

  it('CONTROL: a day with no time is not an outside event ("the 15 Oct costs check")', () => {
    const task = { id: T, name: 'something', status: 'Today', dueDate: '2026-10-14', notes: '' };
    expect(door({ task, said: 'no card: re-check 15 Oct' }).door).toBe('');
    // A time in the next clause is not that day's: it belongs to whatever that clause is about.
    expect(door({ task, said: 'no card: re-check 16 Oct; 09:30 is when the agent looks again' }).door).toBe('');
    expect(door({ task, said: 'no card: the council replies 16 Oct at 09:30' }).door).toBe('an outside event dated 2026-10-16 09:30');
  });

  it('CONTROL: a dated event beyond 7 days is no door', () => {
    const r = verify({
      tasks: { [T]: { name: 'Ada Example (Unit 1): authority to act still unsigned, send a reminder' } },
      actions: [noCard(T, 'no card: the signing service sends its own reminder {dm:+12} at 21:41')],
    });
    expect(r.final[T].status).toBe('Approval');
  });

  it('CONTROL: a time beside a hand-off to another lane is that lane\'s date, never an outside event', () => {
    const task = { id: T, name: 'something', status: 'Today', dueDate: '2026-10-14', notes: '' };
    expect(door({ task, said: 'no card: the rent lane raises the card tomorrow at 11:30' }).door).toBe('');
  });
});

describe('Kevin\'s own park, and what the rule leaves alone', () => {
  it('a park his answer recorded (decided --until) is a door', () => {
    const T = 'recPARKEDBYKEVIN1';
    const r = verify({
      tasks: { [T]: { name: 'COMPLIANCE: EPC expired - 1 Example Place', notes: "[08 Oct 2026 — agent-dispatch] Parked until {d:+20} on Kevin's answer; it comes back on the board that day." } },
      actions: [noCard(T, "no card: Kevin's ruling holds this")],
    });
    expect(r.writes).toEqual([]);
    expect(r.out.parkedWithDoor[0].door).toMatch(/^Kevin's answer parks it until \d{4}-\d{2}-\d{2}$/);
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

  it('a task on an open wall is the blocker loop\'s: no card is made, and its failure still alarms as before', () => {
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
    const r = verify({
      tasks: { [T]: { name: 'Pay the council' } },
      actions: [{ task: T, kind: 'carry_out', ok: false, error: 'no card payment found in Gmail, so nothing was carried out' }],
    });
    expect(r.writes).toEqual([]);
    expect(r.out.cardedNoDoor).toBeUndefined();
    expect(r.err).toContain(`action failed: carry_out ${T}`);
  });

  it('a task the run did put a card on is not parked, whatever a note says', () => {
    const T = 'recESCALATEDTASK1';
    const r = verify({
      tasks: { [T]: { name: 'INBOUND: something', status: 'Approval' } },
      actions: [noCard(T, 'no card from the agent'), { task: T, kind: 'escalate', ok: true }],
    });
    expect(r.writes).toEqual([]);
    expect(r.err).toContain(`action failed: new ${T}`);
  });
});
