import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, mkdtempSync } from 'fs';
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
const AI = { [BOOKKEEPER]: 'AI Bookkeeper', [CEO]: 'AI CEO (Dan Martell)', [ANALYST]: 'AI Worker — Analyst' };

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
  "everyServedAgent": [i for i in m.ALL_AGENTS if m.no_lane_holders([i], [], set(m.ALL_AGENTS))],
}))`);
    expect(r.bookkeeper).toEqual([BOOKKEEPER]);
    expect(r.ceo).toEqual([]);
    expect(r.analyst).toEqual([]);
    expect(r.withAnalyst).toEqual([]);
    expect(r.cardSender).toEqual([]);
    expect(r.withPerson).toEqual([]);
    expect(r.assignee).toEqual([]);
    expect(r.blank).toEqual([]);
    expect(r.everyServedAgent).toEqual([]);
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

  it("an answered DECIDE: card is decided with or without the escalate stamp, as dispatch files it", () => {
    const r = board(`
spec2 = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
d = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(d)
trust = rec("recTrustReviewAaa", {"Team Member": ["${CEO}"], "Sent For Approval By": ["${CEO}"],
    "Approval Outcome": "Changes requested", "Approved At": "2026-10-12T07:04:56.572Z",
    "Approval Feedback": "How many days has this assessment run for?",
    "Agent Output": "DECIDE: 2 trust bars crossed this week. Nothing has been changed: you make every move.",
    "Notes": "[12 Oct 2026 — create-agent-task] TRACK RECORD: none found"})
submitted = rec("recSubmittedCardA", {"Team Member": ["${ANALYST}"], "Sent For Approval By": ["${ANALYST}"],
    "Approval Outcome": "Approved as-is", "Approved At": "2026-10-14T09:54:01.851Z",
    "Agent Output": "DECIDE: move this task to 27 October so it stops coming back every slot.",
    "Notes": "[14 Oct 2026 09:40 — agent-dispatch] SUBMITTED (round 1) as Analysis with no new file"})
escalated = rec("recEscalatedCardA", {"Team Member": ["${ANALYST}"], "Approval Outcome": "Approved as-is",
    "Agent Output": "DECIDE: pay it?", "Notes": "[13 Oct 2026 — agent-dispatch] Escalated to Kevin as a decision card (holder ${ANALYST})"})
waiting = rec("recWaitingCardAaa", {"Status": "Approval", "Sent For Approval By": ["${ANALYST}"], "Agent Output": "DECIDE: pay it?"})
carried = rec("recCarriedOutAaaa", {"Team Member": ["${ANALYST}"], "Agent Output": "DECIDED (Kevin, 14 Oct 2026): Approved as-is\\n\\nDECIDE: pay it?",
    "Notes": "[14 Oct 2026 — agent-dispatch] Decision carried out: Approved as-is"})
draft = rec("recPlainDraftAaaa", {"Team Member": ["${ANALYST}"], "Approval Outcome": "Approved as-is", "Agent Output": "Dear Sir, ..."})
rows = [trust, submitted, escalated, waiting, carried, draft]
print(json.dumps({
  "board": {r["id"]: bucket_of(r) for r in rows},
  "dispatch": {r["id"]: bool(r["fields"].get("Approval Outcome")) and d.is_decide_card(r["fields"].get("Agent Output")) for r in rows},
}))`);
    expect(r.board.recTrustReviewAaa).toBe('decided');
    expect(r.board.recSubmittedCardA).toBe('decided');
    expect(r.board.recEscalatedCardA).toBe('decided');
    expect(r.board.recWaitingCardAaa).toBe('waitingOnKevin');
    expect(r.board.recCarriedOutAaaa).not.toBe('decided');
    expect(r.board.recPlainDraftAaaa).not.toBe('decided');
    // One answer: every card the board files as decided is one dispatch files as decided, and back.
    for (const [id, isDecided] of Object.entries(r.dispatch)) {
      expect(r.board[id] === 'decided', id).toBe(isDecided);
    }
  });

  // The real cmd_board against a stubbed Airtable: the slot's own board.json must carry both.
  const runBoard = (roster) => board(`
import io, contextlib
ROSTER = ${JSON.stringify(roster)}
def fake_query_all(table, formula, fields, why):
    if why == "AI agent roster read":
        return [{"id": i, "fields": {"Name": n}} for i, n in ROSTER.items()]
    if why != "board read":
        return []
    # Every record carries the board's control fields (Assignee present and blank, as Airtable sends it).
    return [rec("recPaymentGapAaaa", {"Team Member": ["${BOOKKEEPER}"], "Due Date": "2026-10-11", "Assignee": None}),
            rec("recAnalystWorkAaa", {"Team Member": ["${ANALYST}"], "Due Date": "2026-10-15", "Assignee": None}),
            rec("recTrustReviewAaa", {"Team Member": ["${CEO}"], "Sent For Approval By": ["${CEO}"], "Due Date": "2026-10-12", "Assignee": None,
                "Approval Outcome": "Changes requested", "Approved At": "2026-10-12T07:04:56.572Z",
                "Agent Output": "DECIDE: 2 trust bars crossed this week."})]
m.query_all = fake_query_all
m.read_activity = lambda *a, **k: ([], set())
buf, err = io.StringIO(), ""
try:
    with contextlib.redirect_stdout(buf):
        m.cmd_board()
except SystemExit as e:
    err = "exit %s" % e.code
b = json.loads(buf.getvalue()) if not err else {}
print(json.dumps({"err": err, "ownerless": [(v["id"], v.get("noLaneHolder")) for v in b.get("ownerless", [])],
                  "noLaneCount": (b.get("counts") or {}).get("ownerlessNoLane"),
                  "decided": [v["id"] for v in b.get("decided", [])]}))`);

  it("cmd_board's own output puts the Bookkeeper task on ownerless and the CEO's answered card on decided", () => {
    const r = runBoard(AI);
    expect(r.err).toBe('');
    expect(r.ownerless).toEqual([['recPaymentGapAaaa', ['AI Bookkeeper']]]);
    expect(r.noLaneCount).toBe(1);
    expect(r.decided).toEqual(['recTrustReviewAaa']);
  });

  it('a roster read without the AI CEO stops the board loudly instead of hiding orphans', () => {
    const r = runBoard({ [BOOKKEEPER]: 'AI Bookkeeper' });
    expect(r.err).toBe('exit 1');
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
