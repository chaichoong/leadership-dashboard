import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// "Is the AI team healthy?" read "2 idle, 7 of 9 worked today" on 15 Oct 2026, and both idle
// agents held live work no robot would ever pick up.
//
//  1. The AI Bookkeeper held two tasks daily-ops raised from failed data invariants (a Payment
//     Run gap since 11 Oct, bank re-import duplicates since 15 Oct). The Bookkeeper is the
//     Reconciliation tab's own matcher: no agent file, not in agent-dispatch.py's ALL_AGENTS. So
//     build_queue never read the tasks as agent work (no bucket, not even `unclassified`), and the
//     Task Manager's ownerless step only looked for a BLANK holder. Eight Team Members rows with
//     Is AI Agent ticked are outside ALL_AGENTS; only the Bookkeeper held work that day.
//  2. The AI CEO held an answered DECIDE: card (the weekly trust review; Kevin asked a question on
//     12 Oct). Dispatch files every answered DECIDE: card as `decided`, "the Task Manager's move",
//     but the board only called a card decided when it carried the `escalate` stamp. A card raised
//     through `submit` or the create gate carries none: four answered cards had no consumer.
//
// These tests drive the real scripts: the dispatcher's pure test and its offline build_queue, the
// board's real task_view, classify and ownerless_views, verify's ownerless check, and the real
// cmd_route against an in-memory task.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const TM = resolve(ROOT, 'scripts/task-manager.py');
const SKILL = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/task-manager-board/SKILL.md'), 'utf8');
const CONFIG = readFileSync(resolve(ROOT, 'js/config.js'), 'utf8');

const BOOKKEEPER = 'recAdy3T0lcr4I9eZ';   // Team Members "AI Bookkeeper" (live row, 15 Oct 2026)
const CEO = 'reciHUAEcEkbctnZ6';
const ANALYST = 'recqmKBmq8ZGkxVH9';
const KEVIN = 'recHEt2VPYothaqTd';        // a person: no Is AI Agent tick
const TRIAGE_ID = 'recCUfsTXzmVZynEI';    // AI Inbox Triage (own schedule)
const PRODUCER_ID = 'recRcy1Edas6rGaaF';  // AI Content Producer (own schedule)
const AI = { [BOOKKEEPER]: 'AI Bookkeeper', [CEO]: 'AI CEO (Dan Martell)', [ANALYST]: 'AI Worker — Analyst' };
// A value handed to Python as data (JSON true/false/null are not Python literals).
const PYJ = (x) => `json.loads(${JSON.stringify(JSON.stringify(x))})`;

function py(file, body, env = {}) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, os, types, urllib.request
from datetime import datetime, timezone
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(file)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
AI = ${JSON.stringify(AI)}
${body}
`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json'), ...env } });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('1. one answer to "does any robot work this holder?" (no_lane_holders)', () => {
  it('a task held only by the AI Bookkeeper has no lane; every holder dispatch serves has one', () => {
    const r = py(DISPATCH, `
print(json.dumps({
  "bookkeeper": m.no_lane_holders(["${BOOKKEEPER}"], [], AI),
  "ceo": m.no_lane_holders(["${CEO}"], [], AI),
  "analyst": m.no_lane_holders(["${ANALYST}"], [], AI),
  "withAnalyst": m.no_lane_holders(["${BOOKKEEPER}", "${ANALYST}"], [], AI),
  "cardSender": m.no_lane_holders(["${BOOKKEEPER}"], ["${ANALYST}"], AI),
  "withPerson": m.no_lane_holders(["${BOOKKEEPER}", "${KEVIN}"], [], AI),
  "assignee": m.no_lane_holders(["${BOOKKEEPER}"], [], AI, True),
  "blank": m.no_lane_holders([], [], AI),
  "everyServedAgent": sorted(i for i in m.ALL_AGENTS if m.no_lane_holders([i], [], set(m.ALL_AGENTS))),
  "ownSchedule": sorted(i for i in m.ALL_AGENTS if m.own_go_signal(i)),
  "withVerdict": [i for i in m.ALL_AGENTS if m.no_lane_holders([i], [], set(m.ALL_AGENTS), outcome="Approved as-is")],
}))`);
    expect(r.bookkeeper).toEqual([BOOKKEEPER]);
    expect(r.ceo).toEqual([]);
    expect(r.analyst).toEqual([]);
    expect(r.withAnalyst).toEqual([]);
    expect(r.cardSender).toEqual([]);
    expect(r.withPerson).toEqual([]);
    expect(r.assignee).toEqual([]);
    expect(r.blank).toEqual([]);
    // Every agent on the list works its tasks, except the two on their own schedule (Inbox Triage,
    // the Content Engine), which are never handed work: they work only their own answered cards.
    expect(r.ownSchedule).toEqual([TRIAGE_ID, PRODUCER_ID].sort());
    expect(r.everyServedAgent).toEqual(r.ownSchedule);
    expect(r.withVerdict).toEqual([]);
  });

  it('the Team Members ids it reads match js/config.js (a drifted id reads as an empty roster)', () => {
    const r = py(DISPATCH, `print(json.dumps({"table": m.TEAM_TABLE, "fields": m.TEAM_FIELDS}))`);
    expect(CONFIG).toContain(`teamMembers:   '${r.table}'`);
    expect(CONFIG).toMatch(new RegExp(`name: '${r.fields.name}'`));
    expect(CONFIG).toMatch(new RegExp(`isAgent: '${r.fields.isAgent}'`));
  });
});

describe('2. the real build_queue lists a task no robot works, named and counted, never dropped', () => {
  const queue = (prelude) => {
    const dir = mkdtempSync(tmpdir() + '/od-nolane-');
    return py(DISPATCH, `
m.STATE_DIR = ${JSON.stringify(dir)}
m.INTENT_LEDGER = os.path.join(${JSON.stringify(dir)}, "carryout-intent.jsonl")
AF = m.AF
TASKS, TEAM = {}, []
def rec(i, team, name="Payment Run gap: six payments left the business account with no Payment Run row", **extra):
    f = {AF["name"]: name, AF["status"]: {"name": "Today"}, AF["teamMember"]: team}
    f.update(extra)
    TASKS[i] = {"id": i, "fields": f}
def team_row(i, name):
    TEAM.append({"id": i, "fields": {m.TEAM_FIELDS["name"]: name, m.TEAM_FIELDS["isAgent"]: True}})
real_query = m.query_records
def query_records(table, formula=None, fields=None, max_records=None):
    if table == m.TEAM_TABLE:
        return list(TEAM)
    return real_query(table, formula, fields, max_records)
m.query_records = query_records
m.query_tasks = lambda formula, **kw: list(TASKS.values())
m.fetch_role_roster = lambda: {}
${prelude}
q = m.build_queue()
print(json.dumps({"noLane": [(t["id"], t["noLaneHolder"]) for t in q["noLane"]], "count": q["counts"]["noLane"],
                  "error": q["noLaneError"], "work": sorted(t["id"] for t in q["worklist"] + q["reserve"])}))`);
  };

  it("the Bookkeeper's task is listed with its holder's name; the Analyst's is worked as before", () => {
    const r = queue(`
for i, n in AI.items(): team_row(i, n)
rec("recPaymentGapAaaa", ["${BOOKKEEPER}"])
rec("recAnalystWorkAaa", ["${ANALYST}"], name="Reconcile the October Payment Run rows")`);
    expect(r.noLane).toEqual([['recPaymentGapAaaa', [{ id: BOOKKEEPER, name: 'AI Bookkeeper' }]]]);
    expect(r.count).toBe(1);
    expect(r.error).toBe('');
    expect(r.work).toEqual(['recAnalystWorkAaa']);
  });

  it('a roster read that fails, or comes back without the AI CEO, is NOT CHECKED, never a quiet zero', () => {
    const failed = queue(`
def broken(*a, **k): raise RuntimeError("HTTP 503 on the Team Members read")
m.query_records = broken
rec("recPaymentGapAaaa", ["${BOOKKEEPER}"])
rec("recAnalystWorkAaa", ["${ANALYST}"], name="Reconcile the October Payment Run rows")`);
    expect(failed.error).toMatch(/^NOT CHECKED: .*503/);
    expect(failed.count).toBe(0);
    expect(failed.work).toEqual(['recAnalystWorkAaa']);   // the rest of the queue still builds
    const drifted = queue(`
team_row("${BOOKKEEPER}", "AI Bookkeeper")
rec("recPaymentGapAaaa", ["${BOOKKEEPER}"])`);
    expect(drifted.error).toMatch(/^NOT CHECKED: .*not the AI CEO's/);
  });
});

describe("3. the Task Manager's board moves both kinds of orphan", () => {
  const board = (body) => py(TM, `
now = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)
def rec(i, f): return {"id": i, "fields": dict({"Task Name": i, "Created Time": "2026-10-11T06:10:23.000Z", "Status": "Today"}, **f)}
def bucket_of(r): return m.task_view(r, set(), set(), now)[0]
${body}`);

  it('a task held only by the AI Bookkeeper is ownerless, named; held by a working agent it is not', () => {
    const r = board(`
recs = [rec("recPaymentGapAaaa", {"Team Member": ["${BOOKKEEPER}"]}),
        rec("recAnalystWorkAaa", {"Team Member": ["${ANALYST}"]}),
        rec("recNobodyHoldsAaa", {})]
buckets = {}
for r in recs:
    b, _, v = m.task_view(r, set(), set(), now)
    buckets.setdefault(b, []).append(v)
print(json.dumps({
  "withRoster": [(v["id"], v.get("noLaneHolder")) for v in m.ownerless_views(buckets, AI)],
  "oldCall": [v["id"] for v in m.ownerless_views(buckets)]}))`);
    expect(r.withRoster).toEqual([['recPaymentGapAaaa', ['AI Bookkeeper']], ['recNobodyHoldsAaa', null]]);
    expect(r.oldCall).toEqual(['recNobodyHoldsAaa']);
  });

  it('verify fails the slot while the Bookkeeper task has no move, and passes once it is routed', () => {
    const r = board(`
import tempfile
from pathlib import Path
tmp = tempfile.mkdtemp()
Path(tmp, "board.json").write_text(json.dumps({"ownerless": [{"id": "recPaymentGapAaaa", "name": "Payment Run gap", "noLaneHolder": ["AI Bookkeeper"]}]}))
print(json.dumps({"none": m.ownerless_problems([], scratch=tmp),
                  "routed": m.ownerless_problems([{"task": "recPaymentGapAaaa", "move": "route", "ok": True}], scratch=tmp)}))`);
    expect(r.none).toHaveLength(1);
    expect(r.none[0]).toMatch(/recPaymentGapAaaa/);
    expect(r.routed).toEqual([]);
  });

  // The real cmd_board against a stubbed Airtable: the slot's own board.json must carry both.
  const runBoard = (roster) => board(`
import io, contextlib
ROSTER = ${JSON.stringify(roster)}
def fake_query_all(table, formula, fields, why, **kw):
    if why == "AI agent roster read":
        return [{"id": i, "fields": {"Name": n}} for i, n in ROSTER.items()]
    if why != "board read":
        return []
    # Every record carries the board's control fields (Assignee present and blank, as Airtable sends it).
    return [rec("recPaymentGapAaaa", {"Team Member": ["${BOOKKEEPER}"], "Due Date": "2026-10-11", "Assignee": None}),
            rec("recAnalystWorkAaa", {"Team Member": ["${ANALYST}"], "Due Date": "2026-10-15", "Assignee": None}),
            rec("recNobodyHoldsAaa", {"Due Date": "2026-10-15", "Assignee": None}),
            rec("recTrustReviewAaa", {"Team Member": ["${CEO}"], "Sent For Approval By": ["${CEO}"], "Due Date": "2026-10-12", "Assignee": None,
                "Approval Outcome": "Changes requested", "Approved At": "2026-10-12T07:04:56.572Z",
                "Agent Output": "DECIDE: 2 trust bars crossed this week."})]
m.query_all = fake_query_all
m.read_role_roster = lambda: (None, "not read in this test")
m.read_activity = lambda *a, **k: ([], set())
buf, err = io.StringIO(), ""
try:
    with contextlib.redirect_stdout(buf):
        m.cmd_board()
except SystemExit as e:
    err = "exit %s" % e.code
b = json.loads(buf.getvalue()) if not err else {}
print(json.dumps({"err": err, "ownerless": [(v["id"], v.get("noLaneHolder")) for v in b.get("ownerless", [])],
                  "noLaneCount": (b.get("counts") or {}).get("ownerlessNoLane"), "noLaneCheck": b.get("noLaneCheck"),
                  "decided": [v["id"] for v in b.get("decided", [])]}))`);

  it("cmd_board's own output puts the Bookkeeper task on ownerless and the CEO's answered card on decided", () => {
    const r = runBoard(AI);
    expect(r.err).toBe('');
    expect(r.ownerless).toEqual([['recPaymentGapAaaa', ['AI Bookkeeper']], ['recNobodyHoldsAaa', null]]);
    expect(r.noLaneCount).toBe(1);
    expect(r.noLaneCheck).toMatch(/^checked/);
    expect(r.decided).toEqual(['recTrustReviewAaa']);
  });

  it('review 4: a roster read that cannot be true never stops the board; the agent half says NOT CHECKED', () => {
    const r = runBoard({ [BOOKKEEPER]: 'AI Bookkeeper' });   // no AI CEO row: a broken read
    expect(r.err).toBe('');
    expect(r.noLaneCheck).toMatch(/^NOT CHECKED: .*not the AI CEO's/);
    expect(r.ownerless).toEqual([['recNobodyHoldsAaa', null]]);   // the blank-holder half still runs
    expect(r.decided).toEqual(['recTrustReviewAaa']);
  });

  it('the skill tells the foreman a no-lane holder is ownerless and moves it with route', () => {
    expect(SKILL).toMatch(/`noLaneHolder`/);
    expect(SKILL).toMatch(/route` refuses a target no robot works/);
  });
});

describe('4. a re-route reads back off the record and leaves no orphan', () => {
  const route = (to) => py(DISPATCH, `
TASK = {"id": "recPaymentGapAaaa", "fields": {m.AF["name"]: "Payment Run gap", m.AF["teamMember"]: ["${BOOKKEEPER}"]}}
m.get_task = lambda tid: json.loads(json.dumps(TASK))
def patch_task(tid, fields):
    TASK["fields"].update(fields)
    return TASK
m.patch_task = patch_task
err = ""
try:
    m.cmd_route(types.SimpleNamespace(task="recPaymentGapAaaa", to=os.environ["TO"]))
except SystemExit as e:
    err = str(e)
held = m.get_task("recPaymentGapAaaa")["fields"][m.AF["teamMember"]]
print(json.dumps({"err": err, "holder": held, "orphan": m.no_lane_holders(held, [], AI)}))`, { TO: to });

  it('route moves it to the Analyst, the read-back shows the Analyst, and it is no longer an orphan', () => {
    const r = route(ANALYST);
    expect(r.err).toBe('');
    expect(r.holder).toEqual([ANALYST]);
    expect(r.orphan).toEqual([]);
  });

  it('route refuses to hand it back to the Bookkeeper (no robot works it), and nothing is written', () => {
    const r = route(BOOKKEEPER);
    expect(r.err).toMatch(/not a dispatchable AI agent record/);
    expect(r.holder).toEqual([BOOKKEEPER]);
  });
});

// ─── Review of PR #792 (15 Oct 2026): one test per point, each failing on the first version ───

const RENT = 'rec7aHLK1Q8fMLRXH';       // AI Cash Flow Voids: a role agent, paused in these fixtures
const TRIAGE = 'recCUfsTXzmVZynEI';     // AI Inbox Triage: own schedule, never handed work
const PRODUCER = 'recRcy1Edas6rGaaF';   // AI Content Producer: own schedule, works its own answered cards
const ALL_AI = { ...AI, [RENT]: 'AI Cash Flow Voids', [TRIAGE]: 'AI Inbox Triage', [PRODUCER]: 'AI Content Producer' };
const ROSTER = {
  [RENT]: { name: 'Cash Flow Voids', status: 'Paused', dispatchable: false },
  [TRIAGE]: { name: 'Inbox Triage', status: 'Live', dispatchable: false },
  [PRODUCER]: { name: 'Content Producer', status: 'Built', dispatchable: false },
};

describe('review 1: an approved card nobody escalated is carried out, never asked again', () => {
  const view = (output, extra = {}) => py(TM, `
now = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)
f = dict({"Task Name": "x", "Created Time": "2026-10-01T10:00:00.000Z", "Status": "Today", "Team Member": ["${ANALYST}"],
          "Sent For Approval By": ["${ANALYST}"], "Approval Outcome": "Approved as-is", "Approved At": "2026-10-14T09:54:01.000Z",
          "Agent Output": ${JSON.stringify(output)}}, **${JSON.stringify(extra)})
b, _, v = m.task_view({"id": "recCardAaaaaaaaaa", "fields": f}, set(), set(), now)
print(json.dumps({"bucket": b, "recommended": v.get("recommended"), "from": v.get("recommendedFrom"),
                  "missing": v.get("answersMissing")}))`);

  it('reads the carrying-out line on a card with no RECOMMENDED (the move-to-27-October card)', () => {
    const r = view('DECIDE: move this task to 27 October so it stops coming back every slot.\n\n## The answer\nCheck 1 is done.\n\n'
      + '**Carrying this out will involve:** The task moves to 27 October and waits as upcoming. On that day the robot runs the second check.');
    expect(r.bucket).toBe('decided');
    expect(r.recommended).toBe('The task moves to 27 October and waits as upcoming. On that day the robot runs the second check.');
    expect(r.from).toBe('carrying-out line');
    expect(r.missing).toBe('');
  });

  it('reads an option marked RECOMMENDED (the score-rules card), never one marked "not recommended"', () => {
    const r = view('DECIDE: 8 agents show Live with no score.\n\nOPTIONS\n1. Approve the 8 score rules as written. RECOMMENDED.\n'
      + '2. Approve the rules for 6 only (not recommended).\n\n**Carrying this out will involve:** writing a score rule on all eight agents.');
    expect(r.recommended).toBe('Approve the 8 score rules as written.');
    expect(r.from).toBe('option marked RECOMMENDED');
    const neg = view('DECIDE: x\n\nOPTIONS\nA. Do it.\nB. Do nothing (not recommended).');
    expect(neg.recommended).toBe('');
  });

  it('reads a bare RECOMMENDED heading, and names the answers an approval left out instead of re-asking', () => {
    const r = view('DECIDE: 8 facts the quote form needs and no record holds. Reply with the answers in the box and the robot fills the form.\n\n'
      + 'OPTIONS\nA. Answer the 8 facts in the box.\nB. Do nothing.\n\nRECOMMENDED\nA. The market is worth testing.\n\nWhat happens after\n- x\n\n'
      + '**Carrying this out will involve:** With your 8 answers, the robot fills the form.');
    expect(r.recommended).toBe('A. The market is worth testing.');
    expect(r.from).toBe('RECOMMENDED heading');
    expect(r.missing).toMatch(/Reply with the answers in the box/);
    // his words in the box are the answers: nothing is missing then
    const answered = view('DECIDE: Reply with the answers in the box.\n\nRECOMMENDED\nA. Fill it.', { 'Approval Feedback': '1. 1990 2. Brick' });
    expect(answered.missing).toBe('');
  });

  it("a briefed card still reads its RECOMMENDED: line, and verify's strict check is unchanged", () => {
    const r = view('DECIDE: sell or keep?\n\nRECOMMENDED: B, keep it.\n\n**Carrying this out will involve:** nothing is sold.');
    expect(r.recommended).toBe('B, keep it.');
    expect(r.from).toBe('RECOMMENDED: line');
    const strict = py(TM, `print(json.dumps(m.card_recommended("DECIDE: x\\n\\n**Carrying this out will involve:** y")))`);
    expect(strict).toBe('');
  });

  it('the skill carries the move out and asks only for what is missing', () => {
    expect(SKILL).toMatch(/`recommendedFrom`/);
    expect(SKILL).toMatch(/`answersMissing`/);
    expect(SKILL).toMatch(/Never the whole question again/);
  });
});

describe('reviews 2, 4 and 5: the board and dispatch give one answer on the same rows', () => {
  // Rows in both shapes; dispatch's real build_queue (offline) and the board's real task_view and
  // ownerless_views judge them; the decided set and the no-robot set must be identical.
  const dir = mkdtempSync(tmpdir() + '/od-one-answer-');
  const holds = resolve(dir, 'holds.json');
  writeFileSync(holds, JSON.stringify({ holds: [{
    id: 'hold-example-road', status: 'active', created: '2026-10-13', title: 'Example Road waits on the surveyor',
    match: { name: ['Example Road'] },
    examples: { held: ['Survey report for 32 Example Road'], free: ['Survey report for 6 Other Close'] } }] }));
  const both = () => py(TM, `
spec2 = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
d = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(d)
d.STATE_DIR = ${JSON.stringify(dir)}
d.INTENT_LEDGER = os.path.join(${JSON.stringify(dir)}, "carryout-intent.jsonl")
ALL_AI = ${JSON.stringify(ALL_AI)}
ROSTER = ${PYJ(ROSTER)}
ROWS = [
  # id, status, due, team, sent by, outcome, approved at, feedback, output, notes, name
  ("recTrustReviewAaa", "Today", "2026-10-12", ["${CEO}"], ["${CEO}"], "Changes requested", "2026-10-12T07:04:56.000Z",
   "How many days has this run for?", "DECIDE: 2 trust bars crossed this week.", "", "TRUST REVIEW: 2 bars crossed"),
  ("recSubmittedCardA", "Today", "2026-10-14", ["${ANALYST}"], ["${ANALYST}"], "Approved as-is", "2026-10-14T09:54:01.000Z", "",
   "DECIDE: move this task to 27 October.\\n\\n**Carrying this out will involve:** it waits until 27 October.", "", "Merge gate checks"),
  ("recEscalatedCardA", "Today", "2026-10-13", ["${ANALYST}"], [], "Approved as-is", "2026-10-13T09:00:00.000Z", "",
   "DECIDE: archive the old folder?\\n\\nRECOMMENDED: archive it.", "[13 Oct 2026 — agent-dispatch] Escalated to Kevin as a decision card (holder ${ANALYST})", "Old folder clean-up"),
  ("recCarriedOutAaaa", "Today", "2026-10-14", ["${ANALYST}"], [], "", "", "",
   "DECIDED (Kevin, 14 Oct 2026): Approved as-is\\n\\nDECIDE: archive it?", "[14 Oct 2026 — agent-dispatch] Decision carried out: Approved as-is", "Archive clean-up"),
  ("recPlainDraftAaaa", "Today", "2026-10-14", ["${ANALYST}"], ["${ANALYST}"], "Approved as-is", "2026-10-14T09:00:00.000Z", "", "Dear Sir, ...", "", "Reply to the surveyor"),
  # review 2: a card under Kevin's standing hold, answered before the hold began, and one parked to a future date
  ("recHeldCardAaaaaa", "Today", "2026-10-12", ["${ANALYST}"], ["${ANALYST}"], "Approved as-is", "2026-10-12T09:00:00.000Z", "",
   "DECIDE: book the surveyor?\\n\\nRECOMMENDED: book it.", "", "Survey report for 32 Example Road"),
  ("recFutureCardAaaa", "Upcoming", "2099-01-01", ["${ANALYST}"], ["${ANALYST}"], "Approved as-is", "2026-10-12T09:00:00.000Z", "",
   "DECIDE: look again in 2099?\\n\\nRECOMMENDED: yes.", "", "Look again later"),
  # reviews 4 and 5: holders no robot works
  ("recBookkeeperAaaa", "Today", "2026-10-11", ["${BOOKKEEPER}"], [], "", "", "", "", "", "Payment Run gap"),
  ("recPausedAgentAaa", "Today", "2026-10-11", ["${RENT}"], [], "", "", "", "", "", "Monthly summary"),
  ("recTriageHeldAaaa", "Today", "2026-10-11", ["${TRIAGE}"], [], "", "", "", "", "", "Sort the folder"),
  ("recProducerCardAa", "Today", "2026-10-11", ["${PRODUCER}"], ["${PRODUCER}"], "Approved as-is", "2026-10-11T09:00:00.000Z", "",
   "Monthly performance read.", "", "CONTENT: monthly performance read"),
]
AF = d.AF
def drec(r):
    i, st, due, team, sfab, out, at, fb, output, notes, name = r
    f = {AF["name"]: name, AF["status"]: {"name": st}, AF["dueDate"]: due, AF["teamMember"]: team,
         AF["sentForApprovalBy"]: sfab, AF["agentOutput"]: output, AF["notes"]: notes, AF["approvalFeedback"]: fb}
    if out:
        f[AF["approvalOutcome"]] = {"name": out}; f[AF["approvedAt"]] = at
    return {"id": i, "fields": f}
def brec(r):
    i, st, due, team, sfab, out, at, fb, output, notes, name = r
    f = {"Task Name": name, "Status": st, "Due Date": due, "Team Member": team, "Sent For Approval By": sfab,
         "Agent Output": output, "Notes": notes, "Approval Feedback": fb, "Created Time": "2026-10-01T10:00:00.000Z"}
    if out:
        f["Approval Outcome"] = out; f["Approved At"] = at
    return {"id": i, "fields": f}
today = d.today_london()
d.query_tasks = lambda formula, **kw: [drec(r) for r in ROWS if d.in_dispatch_window(r[1], r[2], today)]
d.fetch_role_roster = lambda: ROSTER
real = d.query_records
def qr(table, formula=None, fields=None, max_records=None):
    if table == d.TEAM_TABLE:
        return [{"id": i, "fields": {d.TEAM_FIELDS["name"]: n, d.TEAM_FIELDS["isAgent"]: True}} for i, n in ALL_AI.items()]
    return real(table, formula, fields, max_records)
d.query_records = qr
q = d.build_queue()
now = datetime.now(timezone.utc)
buckets, bucket_of = {}, {}
for r in ROWS:
    b, _, v = m.task_view(brec(r), set(), set(), now)
    buckets.setdefault(b, []).append(v); bucket_of[r[0]] = b
own = m.ownerless_views(buckets, ALL_AI, roster=ROSTER)
print(json.dumps({
  "dispatchDecided": sorted(t["id"] for t in q["decided"]),
  "boardDecided": sorted(i for i, b in bucket_of.items() if b == "decided"),
  "dispatchNoLane": sorted(t["id"] for t in q["noLane"]),
  "boardNoLane": sorted(v["id"] for v in own if v.get("noLaneHolder")),
  "held": sorted(t["id"] for t in q["heldByStandingHold"]),
  "noLaneError": q["noLaneError"],
}))`, { OD_HOLDS_FILE: holds });

  it('review 2: decided only where dispatch reads the card (its window, no standing hold), identical on both sides', () => {
    const r = both();
    expect(r.held).toEqual(['recHeldCardAaaaaa']);   // control: the hold really holds in dispatch
    expect(r.boardDecided).toEqual(['recEscalatedCardA', 'recSubmittedCardA', 'recTrustReviewAaa']);
    expect(r.boardDecided).toEqual(r.dispatchDecided);
  });

  it('reviews 4 and 5: the same holders read as no robot on both sides: off the list, paused, or never handed work', () => {
    const r = both();
    expect(r.noLaneError).toBe('');
    expect(r.dispatchNoLane).toEqual(['recBookkeeperAaaa', 'recPausedAgentAaa', 'recTriageHeldAaaa']);
    expect(r.boardNoLane).toEqual(r.dispatchNoLane);   // the board's ownerless list consumes exactly dispatch's noLane
  });
});

describe('review 5: a holder works only if dispatch would work it, by the check route uses', () => {
  it('paused, never handed work, or unread register: each judged as route judges it', () => {
    const r = py(DISPATCH, `
ROSTER = ${PYJ(ROSTER)}
LIVE = dict(ROSTER, **{"${RENT}": {"status": "Live", "dispatchable": True}})
print(json.dumps({
  "paused": m.no_lane_holders(["${RENT}"], [], {"${RENT}": 1}, roster=ROSTER),
  "live": m.no_lane_holders(["${RENT}"], [], {"${RENT}": 1}, roster=LIVE),
  "unread": m.no_lane_holders(["${RENT}"], [], {"${RENT}": 1}, roster=None),
  "triage": m.no_lane_holders(["${TRIAGE}"], [], {"${TRIAGE}": 1}, roster=ROSTER),
  "producerOwnCard": m.no_lane_holders(["${PRODUCER}"], ["${PRODUCER}"], {"${PRODUCER}": 1}, roster=ROSTER, outcome="Approved as-is"),
  "strategic": m.no_lane_holders(["${ANALYST}"], [], {"${ANALYST}": 1}, roster=ROSTER),
  "sameAsRoute": m.role_agent_problem("${RENT}", ROSTER, "route"),
}))`);
    expect(r.paused).toEqual([RENT]);
    expect(r.live).toEqual([]);
    expect(r.unread).toEqual([]);          // never guesses every role agent paused
    expect(r.triage).toEqual([TRIAGE]);
    expect(r.producerOwnCard).toEqual([]);
    expect(r.strategic).toEqual([]);
    expect(r.sameAsRoute).toMatch(/is not dispatchable \(register status: Paused\)/);
  });
});

describe('review 3: a task no robot works cannot be left for ever', () => {
  const run = (prior, actions, viewExtra = {}) => {
    const dir = mkdtempSync(tmpdir() + '/od-leave-');
    return py(TM, `
import tempfile, time
from pathlib import Path
start = time.time()
PRIOR = ${JSON.stringify(prior)}
rows = [{"task": "recPaymentGapAaaa", "move": mv, "reason": "x",
         "ts": datetime.fromtimestamp(start - 3600 * (len(PRIOR) - n)).isoformat(timespec="seconds")}
        for n, mv in enumerate(PRIOR)]
# this slot's own leave is in the digest too (note runs before verify): it must not count as a prior one
rows.append({"task": "recPaymentGapAaaa", "move": "leave", "reason": "now",
             "ts": datetime.fromtimestamp(start + 5).isoformat(timespec="seconds")})
Path(${JSON.stringify(dir)}, "digest-2026-10-15.jsonl").write_text("".join(json.dumps(r) + "\\n" for r in rows))
scratch = tempfile.mkdtemp()
VIEW = dict({"id": "recPaymentGapAaaa", "name": "Payment Run gap", "noLaneHolder": ["AI Bookkeeper"]}, **${PYJ(viewExtra)})
Path(scratch, "board.json").write_text(json.dumps({"ownerless": [VIEW]}))
os.environ["TASK_MANAGER_RUN_START"] = str(start)
print(json.dumps(m.ownerless_problems(${PYJ(actions)}, scratch=scratch)))`, { TASK_MANAGER_DIR: dir });
  };
  const leave = [{ task: 'recPaymentGapAaaa', move: 'leave', ok: true }];

  it('after three leaves in a row, another leave fails the slot', () => {
    const r = run(['leave', 'leave', 'leave'], leave);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/left 3 slots running: route it .* or escalate it to Kevin, never another leave/);
  });

  it('a route or an escalate passes; two leaves, or a streak a route broke, still allow a leave', () => {
    expect(run(['leave', 'leave', 'leave'], [{ task: 'recPaymentGapAaaa', move: 'route', ok: true }])).toEqual([]);
    expect(run(['leave', 'leave', 'leave'], [{ task: 'recPaymentGapAaaa', move: 'escalate', ok: true }])).toEqual([]);
    expect(run(['leave', 'leave'], leave)).toEqual([]);
    expect(run(['leave', 'leave', 'route', 'leave'], leave)).toEqual([]);
  });

  it('round 2: a correct close, finish or chase after three leaves passes', () => {
    for (const move of ['close', 'finish', 'chase']) {
      expect(run(['leave', 'leave', 'leave'], [{ task: 'recPaymentGapAaaa', move, ok: true }]), move).toEqual([]);
    }
  });

  it("round 2: a hand-over to Roy settles it only where the view says it is Roy's lane", () => {
    const roy = [{ task: 'recPaymentGapAaaa', move: 'roy', ok: true }];
    expect(run(['leave', 'leave', 'leave'], roy, { royAllowed: true })).toEqual([]);
    const refused = run(['leave', 'leave', 'leave'], roy, { royAllowed: false });
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/not a placement here: it is not his lane/);
  });
});

describe("round 2: royAllowed comes from the dispatcher's own lane rules and the register", () => {
  it("Roy's lane by roy_match, property_match or a Maintenance Ticket, never a parked holder or Kevin's home", () => {
    const LEAD = 'rec0unnz5sNaBoIG2';   // AI Lead Finder: Paused on the register (Operations Director, parked to January)
    const r = py(TM, `
now = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)
AGENTS = dict(AI, **{"${LEAD}": "AI Lead Finder"})
ROSTER = ${PYJ({ [BOOKKEEPER]: { status: 'Live', dispatchable: false }, rec0unnz5sNaBoIG2: { status: 'Paused', dispatchable: false } })}
def rec(i, holder, name, **extra):
    return {"id": i, "fields": dict({"Task Name": name, "Created Time": "2026-10-01T10:00:00.000Z", "Status": "Today",
                                     "Team Member": [holder]}, **extra)}
recs = [rec("recBoilerAaaaaaaa", "${BOOKKEEPER}", "MAINTENANCE: boiler not working at 5 Example Street"),
        rec("recGasSafetyAaaaa", "${BOOKKEEPER}", "COMPLIANCE: gas safety certificate for 5 Example Street"),
        rec("recTicketAaaaaaaa", "${BOOKKEEPER}", "Look at the back gate", **{"Maintenance Ticket": True}),
        rec("recHomeTicketAaaa", "${BOOKKEEPER}", "Look at the gate at my house", **{"Maintenance Ticket": True}),
        rec("recPaymentGapAaaa", "${BOOKKEEPER}", "Payment Run gap"),
        rec("recParkedBoilerAa", "${LEAD}", "MAINTENANCE: boiler not working at 5 Example Street")]
buckets = {}
for r in recs:
    b, _, v = m.task_view(r, set(), set(), now)
    buckets.setdefault(b, []).append(v)
print(json.dumps({v["id"]: v["royAllowed"] for v in m.ownerless_views(buckets, AGENTS, roster=ROSTER)}))`);
    expect(r).toEqual({
      recBoilerAaaaaaaa: true, recGasSafetyAaaaa: true, recTicketAaaaaaaa: true,
      recHomeTicketAaaa: false, recPaymentGapAaaa: false, recParkedBoilerAa: false,
    });
  });
});

describe("review 4: dispatch's verify fails loudly when the holders were not checked", () => {
  const verify = (queueExtra) => py(DISPATCH, `
import io, tempfile, contextlib
tmp = tempfile.mkdtemp(); m.STATE_DIR = tmp
rundir = os.path.join(tmp, "run"); os.makedirs(rundir)
json.dump({"startedAt": datetime.now(timezone.utc).isoformat(), "queueCounts": {"worklist": 0, "openTasksRead": 120}, "actions": []},
          open(os.path.join(rundir, "report.json"), "w"))
json.dump(dict({"worklist": [], "generatedAt": datetime.now(timezone.utc).isoformat()}, **${JSON.stringify(queueExtra)}),
          open(os.path.join(rundir, "queue.json"), "w"))
m.ledger_last_events = lambda: {}
m.overdue_lessons = lambda: []
out, err, code = io.StringIO(), io.StringIO(), 0
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
    try:
        m.cmd_verify(types.SimpleNamespace(report=os.path.join(rundir, "report.json"), dry_run=True))
    except SystemExit as e:
        code = e.code or 0
print(json.dumps({"code": code, "text": out.getvalue() + err.getvalue()}))`);

  it("a NOT CHECKED in the run's queue.json fails verify; the same run without it does not name it", () => {
    const bad = verify({ noLaneError: 'NOT CHECKED: HTTP 503 on the Team Members read' });
    expect(bad.code).not.toBe(0);
    expect(bad.text).toMatch(/holders no robot works were not checked: NOT CHECKED: HTTP 503/);
    const good = verify({ noLaneError: '' });
    expect(good.text).not.toMatch(/holders no robot works/);
  });
});
