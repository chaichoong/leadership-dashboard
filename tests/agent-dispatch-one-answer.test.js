import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ONE TASK, ONE ANSWER (Kevin, 15 Oct 2026).
//
// The dispatcher (scripts/agent-dispatch.py build_queue) and the Task Board Manager
// (scripts/task-manager.py cmd_board) classify the same open board. After PR #792 three kinds of
// task still got two answers, read off the live board on 15 Oct 2026:
//   (a) a task the dispatcher parks as a SYSTEM ALERT read as ordinary stuck work on the board, so
//       the foreman "left" it three times a day for a robot that would never be handed it;
//   (b) a twin HELD UNDER a lead (Roy's request, or a property group's lead) read the same way: 17
//       of the 18 held that day sat on the board's stuck list;
//   (c) a task held by an agent Kevin PAUSED went into the dispatcher's worklist while the board
//       listed it as ownerless, so two robots owned one task.
//
// The property: for a fixture set covering every dispatch lane and hold, each task gets exactly
// one answer from each reader, and the two answers agree. Both readers run for real: the
// dispatcher's offline build_queue, and the board's cmd_board, which asks the dispatcher's own
// task_lane (queue_lanes) through the same module object.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const TM = resolve(ROOT, 'scripts/task-manager.py');

const CEO = 'reciHUAEcEkbctnZ6';
const ANALYST = 'recqmKBmq8ZGkxVH9';
const BUILDER = 'recQkO6BA4w5zqwZ4';
const BOOKKEEPER = 'recAdy3T0lcr4I9eZ';   // AI agent row no robot works (not in ALL_AGENTS)
const RENT = 'rec7aHLK1Q8fMLRXH';         // Cash Flow Voids: PAUSED in this register
const TRIAGE = 'recCUfsTXzmVZynEI';       // own schedule: never handed work
const PRODUCER = 'recRcy1Edas6rGaaF';     // own schedule: works its own answered cards
const RESPONSE = 'recJ8J8idWE8d97tH';
const CREDITOR = 'recjh6mmaF8KJW8t3';     // PAUSED: creditor correspondence parks (tier 2)
const PROPERTY = 'recwWvBju2ycB63i4';
const KEVIN = 'recHEt2VPYothaqTd';        // a person

const AI = {
  [CEO]: 'AI CEO (Dan Martell)', [ANALYST]: 'AI Worker — Analyst', [BUILDER]: 'AI Worker — Builder',
  [BOOKKEEPER]: 'AI Bookkeeper', [RENT]: 'AI Cash Flow Voids', [TRIAGE]: 'AI Inbox Triage',
  [PRODUCER]: 'AI Content Producer', [RESPONSE]: 'AI Inbox Response', [CREDITOR]: 'AI Supplier and Creditor Manager',
  [PROPERTY]: 'AI Property Administration',
};
const ROSTER = {
  [RENT]: { name: 'Cash Flow Voids', status: 'Paused', dispatchable: false },
  [TRIAGE]: { name: 'Inbox Triage', status: 'Live', dispatchable: false },
  [PRODUCER]: { name: 'Content Producer', status: 'Built', dispatchable: false },
  [RESPONSE]: { name: 'Inbox Response', status: 'Live', dispatchable: true },
  [CREDITOR]: { name: 'Creditor Management', status: 'Paused', dispatchable: false },
  [PROPERTY]: { name: 'Property Administration', status: 'Live', dispatchable: true },
};

const ROY_STAMP = '[15 Oct 2026 — roy-assistant]';
// An escalate stamp from yesterday, so the board's seven-day escalation window is live whenever this runs.
const YESTERDAY = new Date(Date.now() - 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
const ESC_STAMP = `[${YESTERDAY} — agent-dispatch] Escalated to Kevin as a decision card (holder ${'recqmKBmq8ZGkxVH9'})`;
// id, status, due, team, sentBy, outcome, feedback, agentOutput, notes, name, extra
const ROWS = [
  // Worked by dispatch
  ['recNewWorkAaaaaaa', 'Today', '2026-10-14', [ANALYST], [], '', '', '', '', 'Draft the October rent summary', {}],
  ['recCarryOutAaaaaa', 'Today', '2026-10-14', [ANALYST], [ANALYST], 'Approved as-is', '', 'Dear Sir, thank you for the survey.', '', 'Reply to the surveyor', {}],
  ['recRedoAaaaaaaaaa', 'Today', '2026-10-14', [ANALYST], [ANALYST], 'Changes requested', 'Shorter, please.', 'Dear Sir, ...', '', 'Reply to the valuer', {}],
  ['recCeoRouteAaaaaa', 'Today', '2026-10-14', [CEO], [], '', '', '', '', 'Look into a second business bank account', {}],
  ['recAlertMoneyAaaa', 'Today', '2026-10-14', [BUILDER], [], '', '', '', '', 'Apps Script add-on renewal £12.00', {}],
  ['recBlankCarryAaaa', 'Today', '2026-10-14', [], [ANALYST], 'Approved as-is', '', 'Dear Sir, the meter reading is attached.', '', 'Send the meter reading', {}],
  // escalated yesterday, then a draft written over the card and approved: a carry-out, never also decided
  ['recEscRewrittenAa', 'Today', '2026-10-14', [ANALYST], [ANALYST], 'Approved as-is', '', 'Dear Sir, our final offer is attached.', ESC_STAMP, 'Reply to the buyer', {}],
  // Kevin's answer: the Task Manager's move
  ['recDecidedAaaaaaa', 'Today', '2026-10-13', [ANALYST], [ANALYST], 'Approved as-is', '', 'DECIDE: archive the old folder?\n\nRECOMMENDED: archive it.', '', 'Old folder clean-up', {}],
  ['recDecideAlertAaa', 'Today', '2026-10-13', [BUILDER], [BUILDER], 'Changes requested', 'Why did it stop?', 'DECIDE: restart the stopped trigger?\n\nRECOMMENDED: restart it.', '', 'Apps Script trigger stopped', {}],
  // Held by agents no robot works: the board's ownerless step
  ['recBookkeeperAaaa', 'Today', '2026-10-11', [BOOKKEEPER], [], '', '', '', '', 'Payment Run gap', {}],
  ['recPausedAgentAaa', 'Today', '2026-10-11', [RENT], [], '', '', '', '', 'Monthly rent summary', {}],
  ['recPausedCarryAaa', 'Today', '2026-10-11', [RENT], [RENT], 'Approved as-is', '', 'Dear tenant, your statement is attached.', '', 'Send the rent statement', {}],
  ['recTriageHeldAaaa', 'Today', '2026-10-11', [TRIAGE], [], '', '', '', '', 'Sort the folder', {}],
  ['recPausedAlertAaa', 'Today', '2026-10-11', [RENT], [], '', '', '', '', 'Apps Script failure: rent sync', {}],
  // Held on a door: never worked, never the foreman's move
  ['recAlertNameAaaaa', 'Today', '2026-10-01', [BUILDER], [], '', '', '', '', 'Apps Script failure: daily sync stopped', {}],
  ['recAlertSendAaaaa', 'Today', '2026-10-01', [BUILDER], [], '', '', '', '', 'Your worker hit an error', { 'Inbound Sender': 'noreply@notify.cloudflare.com' }],
  ['recRoyTwinAaaaaaa', 'Today', '2026-10-01', [RESPONSE], [], '', '', '', `${ROY_STAMP} ROY IS HANDLING THIS: recRoyLeadAaaaaaa`, 'Tenant asks about the spare keys', {}],
  ['recRoyRequestAaaa', 'Today', '2026-10-01', [RESPONSE], [], '', '', '', `${ROY_STAMP} ROY REQUEST from Roy`, 'ROY: send the tenant the bin collection days', {}],
  ['recSiblingAaaaaaa', 'Today', '2026-10-01', [PROPERTY], [], '', '', '', '[1 Oct 2026 — agent-dispatch] HELD UNDER recLeadPropAaaaaa', 'COMPLIANCE: GSC expired - 42 Example Road', {}],
  ['recStandingHoldAa', 'Today', '2026-10-01', [ANALYST], [], '', '', '', '', 'Survey report for 32 Example Road', {}],
  ['recTier2ParkAaaaa', 'Today', '2026-10-01', [ANALYST], [], '', '', '', '', 'Reply to the statutory demand', {}],
  // Another robot's lane
  ['recFormCardAaaaaa', 'Today', '2026-10-01', [RENT], [RENT], 'Approved as-is', '', 'Form ready.', 'RENT FORM KEY: example', 'RENT FORM: UC47 for Flat 2', {}],
  ['recMergeCardAaaaa', 'Today', '2026-10-01', [BUILDER], [BUILDER], 'Approved as-is', '', 'Merge it.', '', 'MERGE: PR #9001 — example', {}],
  // a merge card is merged by its robot on his yes, even one carrying a DECIDE: ask: never the board's move too
  ['recMergeDecideAaa', 'Today', '2026-10-01', [BUILDER], [BUILDER], 'Approved as-is', '', 'DECIDE: merge it?\n\nRECOMMENDED: merge it.', '', 'MERGE: PR #9002 — example', {}],
  ['recRoyLaneAaaaaaa', 'Today', '2026-10-01', [ANALYST], [], '', '', '', '', 'Fix the leaking tap at 5 Example Street', {}],
  ['recOwnGoCardAaaaa', 'Today', '2026-10-01', [PRODUCER], [PRODUCER], 'Approved as-is', '', 'Monthly performance read.', '', 'CONTENT: monthly performance read', {}],
  // Dispatch cannot place it: the board's to place
  ['recUnclassifiedAa', 'Today', '2026-10-01', [], [ANALYST], '', '', '', '', 'Check the tenancy end date', {}],
  // Not the dispatcher's at all
  ['recPersonTaskAaaa', 'Today', '2026-10-01', [KEVIN], [], '', '', '', '', 'Sign the lease extension', {}],
  ['recNobodyAaaaaaaa', 'Today', '2026-10-01', [], [], '', '', '', '', 'Renew the domain', {}],
  ['recLaterAaaaaaaaa', 'Upcoming', '2099-01-01', [ANALYST], [], '', '', '', '', 'Review the 2099 plan', {}],
  // The leads the holds wait on: open, at Kevin's gate (outside dispatch's window)
  ['recRoyLeadAaaaaaa', 'Approval', '2026-10-01', [RESPONSE], [RESPONSE], '', '', 'Draft.', `${ROY_STAMP} ROY REQUEST from Roy`, 'ROY: tenant asks about the spare keys', {}],
  ['recLeadPropAaaaaa', 'Approval', '2026-10-01', [PROPERTY], [PROPERTY], '', '', 'Three quotes.', '', 'COMPLIANCE: GSC expired - 40 Example Road', {}],
];

// Where each dispatch bucket may land on the board. One answer: a task dispatch works is never
// ownerless, decided or held on the board; what it holds is held there with the same lane; its
// decided is the board's decided; its noLane is the board's ownerless.
const WORKED = ['worklist', 'reserve', 'routingNeeded', 'idleHandbacks'];
const HELD = ['systemAlerts', 'heldUnderLead', 'heldByStandingHold', 'skippedTier2', 'royRequests'];
const OTHER_ROBOT = ['royLane', 'mergeCards', 'ownGoSignal', 'trialChecked'];
const DISPATCH_LISTS = [...WORKED, ...HELD, ...OTHER_ROBOT, 'decided', 'noLane', 'formCards', 'unmappedAgent', 'unclassified'];
const BOARD_LISTS = ['stuck', 'waitingOnKevin', 'inFlight', 'withRoy', 'escalated', 'decided', 'parked', 'ownLane', 'held'];

let run;

beforeAll(() => {
  const dir = mkdtempSync(tmpdir() + '/od-one-answer-');
  const holds = resolve(dir, 'holds.json');
  writeFileSync(holds, JSON.stringify({ holds: [{
    id: 'hold-example-road', status: 'active', created: '2026-10-13', title: 'Example Road waits on the surveyor',
    match: { name: ['32 Example Road'] },
    examples: { held: ['Survey report for 32 Example Road'], free: ['Survey report for 6 Other Close'] } }] }));
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, os, re, io, contextlib
from datetime import datetime, timezone
def boom(*a, **k): raise RuntimeError("network call in a test")
import urllib.request; urllib.request.urlopen = boom
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod
d = load(${JSON.stringify(DISPATCH)}, "od_dispatch")
tm = load(${JSON.stringify(TM)}, "tm")
tm._SCRIPT_MODS["agent-dispatch.py"] = d          # the board imports THIS dispatcher, stubs and all
d.STATE_DIR = ${JSON.stringify(dir)}
d.INTENT_LEDGER = os.path.join(${JSON.stringify(dir)}, "carryout-intent.jsonl")
AI = json.loads(${JSON.stringify(JSON.stringify(AI))})
ROSTER = json.loads(${JSON.stringify(JSON.stringify(ROSTER))})
ROWS = json.loads(${JSON.stringify(JSON.stringify(ROWS))})
AF = d.AF
NAME_TO_AF = {"Inbound Sender": "inboundSender"}
def drec(r):
    i, st, due, team, sfab, out, fb, output, notes, name, extra = r
    f = {AF["name"]: name, AF["status"]: {"name": st}, AF["dueDate"]: due, AF["teamMember"]: team,
         AF["sentForApprovalBy"]: sfab, AF["agentOutput"]: output, AF["notes"]: notes, AF["approvalFeedback"]: fb}
    if out:
        f[AF["approvalOutcome"]] = {"name": out}; f[AF["approvedAt"]] = "2026-10-14T09:00:00.000Z"
    for k, v in extra.items():
        f[AF[NAME_TO_AF[k]]] = v
    return {"id": i, "fields": f}
def brec(r):
    i, st, due, team, sfab, out, fb, output, notes, name, extra = r
    f = {"Task Name": name, "Status": st, "Due Date": due, "Team Member": team, "Sent For Approval By": sfab,
         "Agent Output": output, "Notes": notes, "Approval Feedback": fb, "Created Time": "2026-10-01T10:00:00.000Z",
         "Assignee": None}
    if out:
        f["Approval Outcome"] = out; f["Approved At"] = "2026-10-14T09:00:00.000Z"
    f.update(extra)
    return {"id": i, "fields": f}
today = d.today_london()
def query_tasks(formula, **kw):
    ids = re.findall(r"RECORD_ID\\(\\)='(rec[A-Za-z0-9]+)'", formula)
    if ids:                                         # open_lead_ids: a lead read by id, any status
        return [drec(r) for r in ROWS if r[0] in ids]
    if formula == d.QUEUE_FORMULA:
        return [drec(r) for r in ROWS if d.in_dispatch_window(r[1], r[2], today)]
    return []
d.query_tasks = query_tasks
d.fetch_role_roster = lambda: ROSTER
d.fetch_ai_agents = lambda: dict(AI)
d.rent_reply_senders = lambda *a, **k: set()
d.compliance_book_pages = lambda *a, **k: []
d.fetch_plans = lambda: []

q = d.build_queue()
qpath = os.path.join(${JSON.stringify(dir)}, "dispatch-queue.json")
json.dump(q, open(qpath, "w"))

def fake_query_all(table, formula, fields, why, **kw):
    if why == "AI agent roster read":
        return [{"id": i, "fields": {"Name": n}} for i, n in AI.items()]
    if why == "board read":
        return [brec(r) for r in ROWS if r[1] in tm.OPEN_STATUSES]
    return []
tm.query_all = fake_query_all
tm.read_activity = lambda *a, **k: ([], set())
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    tm.cmd_board(qpath)
b = json.loads(buf.getvalue())
print(json.dumps({"queue": q, "board": b}))
`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OD_HOLDS_FILE: holds } });
  run = JSON.parse(out.trim().split('\n').pop());
});

function answers() {
  const { queue, board } = run;
  const dispatchOf = {}; const boardOf = {}; const view = {};
  for (const key of DISPATCH_LISTS) {
    for (const t of queue[key] || []) (dispatchOf[t.id] = dispatchOf[t.id] || []).push(key);
  }
  for (const key of BOARD_LISTS) {
    for (const v of board[key] || []) {
      const id = typeof v === 'string' ? v : v.id;
      (boardOf[id] = boardOf[id] || []).push(key);
      if (typeof v !== 'string') view[id] = v;
    }
  }
  const ownerless = Object.fromEntries((board.ownerless || []).map((v) => [v.id, v]));
  return { dispatchOf, boardOf, ownerless, view };
}

describe('one task, one answer: the dispatcher and the task board on every lane and hold', () => {
  it('both readers read the whole fixture set (a broken read is not a pass)', () => {
    expect(run.board.counts.openTasksRead).toBe(ROWS.filter((r) => r[1] !== 'Completed').length);
    expect(run.board.dispatchLaneCheck).toBe('checked');
    expect(run.board.noLaneCheck).toMatch(/^checked/);
    expect(run.queue.noLaneError).toBe('');
  });

  it('every task gets exactly one answer from each reader', () => {
    const { dispatchOf, boardOf } = answers();
    for (const [id] of ROWS) {
      expect((dispatchOf[id] || []).length, `${id} in dispatch lists ${dispatchOf[id]}`).toBeLessThanOrEqual(1);
      expect((boardOf[id] || []).length, `${id} in board lists ${boardOf[id]}`).toBeLessThanOrEqual(1);
    }
  });

  it('the two answers agree for every task (the property)', () => {
    const { dispatchOf, boardOf, ownerless } = answers();
    const bad = [];
    for (const [id] of ROWS) {
      const dsp = (dispatchOf[id] || [])[0] || 'none';
      const brd = (boardOf[id] || [])[0] || 'moving';
      const own = Boolean(ownerless[id]);
      let ok;
      if (WORKED.includes(dsp)) ok = ['stuck', 'moving', 'inFlight'].includes(brd) && !own;
      else if (dsp === 'decided') ok = brd === 'decided' && !own;
      else if (dsp === 'noLane') ok = ['stuck', 'moving'].includes(brd) && own && Boolean(ownerless[id].noLaneHolder);
      else if (HELD.includes(dsp)) ok = brd === 'held' && !own;
      else if (dsp === 'formCards') ok = brd === 'ownLane' && !own;
      else if (OTHER_ROBOT.includes(dsp)) ok = ['stuck', 'moving', 'inFlight'].includes(brd) && !own;
      else if (dsp === 'unmappedAgent' || dsp === 'unclassified') ok = ['stuck', 'moving'].includes(brd);
      else ok = brd !== 'held' && !(own && ownerless[id].noLaneHolder);   // not the dispatcher's
      if (!ok) bad.push(`${id}: dispatch ${dsp}, board ${brd}${own ? ' + ownerless' : ''}`);
    }
    expect(bad).toEqual([]);
  });

  it("the board's held list names the same lane dispatch holds it in, and what it waits on", () => {
    const { dispatchOf } = answers();
    const held = Object.fromEntries(run.board.held.map((v) => [v.id, v]));
    for (const [id] of ROWS) {
      const dsp = (dispatchOf[id] || [])[0];
      if (HELD.includes(dsp)) {
        expect(held[id], id).toBeTruthy();
        expect(held[id].lane).toBe(dsp);
        expect(held[id].why).not.toBe('');
      } else {
        expect(held[id], `${id} is held on the board but dispatch says ${dsp}`).toBeUndefined();
      }
    }
    expect(held.recRoyTwinAaaaaaa.groupLead).toBe('recRoyLeadAaaaaaa');
    expect(held.recSiblingAaaaaaa.groupLead).toBe('recLeadPropAaaaaa');
    expect(run.board.counts.held).toBe(run.board.held.length);
  });

  it("each board view carries dispatch's own lane for it", () => {
    const { dispatchOf, view, ownerless } = answers();
    const queueLane = (dsp) => (WORKED.includes(dsp) ? null : dsp);
    // Full views only (the stuck, decided, Roy and Kevin lists, and every ownerless one, moving
    // included); the slim held list carries `lane`, checked above.
    const full = Object.entries({ ...view, ...ownerless }).filter(([, v]) => 'dispatchLane' in v);
    expect(full.length).toBe(14);   // the full views this fixture set yields: a broken read is not a pass
    for (const [id, v] of full) {
      const dsp = (dispatchOf[id] || [])[0];
      if (!dsp) { expect(v.dispatchLane ?? '', id).toBe(''); continue; }
      if (queueLane(dsp)) expect(v.dispatchLane, id).toBe(dsp);
      else expect(['approvedHandbacks', 'changesRequested', 'routingNeeded', 'newWork'], id).toContain(v.dispatchLane);
    }
  });
});

describe('the three disagreements of 15 Oct 2026, by name', () => {
  it('(a) a system alert is held on both sides, never stuck work on the board', () => {
    const { dispatchOf, boardOf } = answers();
    for (const id of ['recAlertNameAaaaa', 'recAlertSendAaaaa']) {
      expect(dispatchOf[id]).toEqual(['systemAlerts']);
      expect(boardOf[id]).toEqual(['held']);
    }
    // the veto still holds: a sum of money is worked, whatever the name says
    expect(dispatchOf.recAlertMoneyAaaa[0]).toMatch(/^(worklist|reserve)$/);
  });

  it("(b) a twin held for Roy's request, and a property sibling under its lead, are held on both sides", () => {
    const { dispatchOf, boardOf } = answers();
    expect(dispatchOf.recRoyTwinAaaaaaa).toEqual(['heldUnderLead']);
    expect(boardOf.recRoyTwinAaaaaaa).toEqual(['held']);
    expect(dispatchOf.recSiblingAaaaaaa).toEqual(['heldUnderLead']);
    expect(boardOf.recSiblingAaaaaaa).toEqual(['held']);
    expect(dispatchOf.recRoyRequestAaaa).toEqual(['royRequests']);
    expect(boardOf.recRoyRequestAaaa).toEqual(['held']);
  });

  it("(c) a paused agent's task, new or approved, leaves the worklist and is the board's ownerless move", () => {
    const { dispatchOf, ownerless } = answers();
    const work = new Set([...run.queue.worklist, ...run.queue.reserve].map((t) => t.id));
    for (const id of ['recPausedAgentAaa', 'recPausedCarryAaa', 'recTriageHeldAaaa', 'recPausedAlertAaa']) {
      expect(work.has(id), id).toBe(false);
      expect(dispatchOf[id], id).toEqual(['noLane']);
      expect(ownerless[id].noLaneHolder, id).toBeTruthy();
    }
    expect(ownerless.recBookkeeperAaaa.noLaneHolder).toEqual(['AI Bookkeeper']);
  });

  it('an approved card whose holder was cleared is carried out by its sender, never also ownerless', () => {
    const { dispatchOf, ownerless } = answers();
    expect(dispatchOf.recBlankCarryAaaa[0]).toMatch(/^(worklist|reserve)$/);
    expect(ownerless.recBlankCarryAaaa).toBeUndefined();
    // ...while a task dispatch cannot place, or nobody holds, still is
    expect(ownerless.recUnclassifiedAa).toBeTruthy();
    expect(ownerless.recNobodyAaaaaaaa).toBeTruthy();
  });

  it("Kevin's answer on a DECIDE: card is decided on both sides, whatever the card is about", () => {
    const { dispatchOf, boardOf } = answers();
    for (const id of ['recDecidedAaaaaaa', 'recDecideAlertAaa']) {
      expect(dispatchOf[id], id).toEqual(['decided']);
      expect(boardOf[id], id).toEqual(['decided']);
    }
  });

  it('an approved draft written over an escalated card is carried out, never also decided on the board', () => {
    const { dispatchOf, boardOf } = answers();
    expect(dispatchOf.recEscRewrittenAa[0]).toMatch(/^(worklist|reserve)$/);
    expect(['moving', 'inFlight']).toContain((boardOf.recEscRewrittenAa || ['moving'])[0]);   // never decided
  });
});

describe('a lanes read that fails never stops the board, and says so', () => {
  it('NOT CHECKED, and the board falls back to its own rules', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location("tm", ${JSON.stringify(TM)})
tm = importlib.util.module_from_spec(spec); spec.loader.exec_module(tm)
class D:
    NOT_READ = "NOT READ"
    def queue_lanes(self, *a, **k): raise RuntimeError("HTTP 503 on the queue read")
tm._load_dispatch = lambda: D()
print(json.dumps(tm.read_dispatch_lanes({}, {}, "")))
`], { encoding: 'utf8' });
    const [lanes, why] = JSON.parse(out.trim());
    expect(lanes).toBeNull();
    expect(why).toMatch(/dispatch lanes read failed .*503/);
  });
});
