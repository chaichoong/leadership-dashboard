import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ONE CARD, SEVERAL TASKS (finding 20261015-agent-dispatch-907).
//
// On 24 Oct 2026 Kevin approved, as-is, ONE decision card covering seven council tax tasks: "hold all
// seven to 31 March 2027; bring one back on 14 December for a balance check". Two things stopped his
// answer reaching the tasks, and seven of them sat at Today behind a wall for 25 days:
//   1. the card opens with the tier-1 banner, so is_decide_card never saw its DECIDE: line and
//      `decided` refused the card itself ("not an answered decision card");
//   2. the six siblings are not decision cards at all, and `due` needs his dated words on each task.
// Now `decided` reads under the banner, and `decided SIB --until D --on-card CARD` parks a sibling only
// when the card carries a real approval with no words of his, and one of the card's own table rows
// names that task alone AND that exact date with its year. The review of the first draft found that the
// wall's fix would wake a parked task back to Today, that closing the card first strands the siblings,
// that a history line could supply a date, and that "14 Dec" matched any year: each is a test here.
//
// These tests drive the real cmd_decided against in-memory tasks, and the real task-manager classify on
// the result. Ids, places and sums are invented.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const TM = resolve(ROOT, 'scripts/task-manager.py');

const LEAD = 'recLEADCARDxxxxx1';
const SIB = 'recSIBPLACExxxxx1';     // held to 31 Mar 2027 on the card
const LATE = 'recSIBCLOSExxxxx1';    // back on 14 Dec 2026 on the card
const OFF = 'recNOTONCARDxxxx1';     // a task the card never names

const ROWS = [
  `| ${LEAD} | 1 Example Place | Raise standing order to £100 | Held to 31 Mar 2027. £90 carries on |`,
  `| ${SIB} | 2 Example Place | Raise standing order to £110 | Held to 31 Mar 2027. £95 carries on |`,
  `| ${LATE} | 3 Example Close | Change standing order to £80 | Back on 14 Dec 2026 for the overpay check |`,
];
const card = (rows = ROWS, tail = '') => 'DECIDE: keep your council tax hold, now dated to 31 March 2027, for all three tasks.\n\n'
  + '## The three tasks this card covers\n\n| Task | Property | What it asks | If you approve |\n|---|---|---|---|\n'
  + rows.join('\n') + tail;

function run(cmds, { lead = {}, sibs = {}, cardText = card() } = {}) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, types, urllib.request
from datetime import datetime, timezone
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
tspec = importlib.util.spec_from_file_location("tm", ${JSON.stringify(TM)})
tm = importlib.util.module_from_spec(tspec); tspec.loader.exec_module(tm)
AF = m.AF
m.today_london = lambda: "2026-11-18"
args = json.loads(sys.argv[1])
CARD = m.TIER1_BANNER + "\\n\\n" + args["card"]
WALL = "[24 Oct 2026 13:34 — agent] BLOCKER OPEN (TOOL agent-dispatch parking door): decided refuses. [since 2026-10-24T12:34:37.000Z] [finding 20261015-agent-dispatch-907]"
def task(i, **f):
    base = {AF["name"]: i, AF["status"]: "Today", AF["dueDate"]: "2026-10-24", AF["notes"]: WALL}
    base.update(f)
    return {"id": i, "createdTime": "2026-01-15T11:00:00.000Z", "fields": base}
TASKS = {
    "${LEAD}": task("${LEAD}", **{AF["agentOutput"]: CARD, AF["approvalOutcome"]: "Approved as-is",
                                  AF["approvedAt"]: "2026-10-24T12:20:40.545Z", AF["sentForApprovalBy"]: ["recAGENTxxxxxxxx1"]}),
    "${SIB}": task("${SIB}"), "${LATE}": task("${LATE}"), "${OFF}": task("${OFF}"),
}
for k, v in args["lead"].items():
    TASKS["${LEAD}"]["fields"][AF[k]] = v
for k, v in args["sibs"].items():
    for t in ("${SIB}", "${LATE}"):
        TASKS[t]["fields"][AF[k]] = v
m.get_task = lambda tid: json.loads(json.dumps(TASKS[tid]))
def patch_task(tid, fields):
    TASKS[tid]["fields"].update(fields)
    return TASKS[tid]
m.patch_task = patch_task
now = datetime(2026, 11, 18, 21, 0, tzinfo=timezone.utc)
res = []
for task_id, until, on_card, handled in args["cmds"]:
    err = ""
    try:
        m.cmd_decided(types.SimpleNamespace(task=task_id, until=until, on_card=on_card, siblings_handled=handled))
    except SystemExit as e:
        err = str(e)
    f = TASKS[task_id]["fields"]
    named = {"Status": f.get(AF["status"]), "Due Date": f.get(AF["dueDate"]), "Notes": f.get(AF["notes"]),
             "Created Time": "2026-01-15T11:00:00.000Z", "_id": task_id}
    res.append({"err": err, "status": f.get(AF["status"]), "due": f.get(AF["dueDate"]),
                "note": (f.get(AF["notes"]) or "").split("\\n\\n")[-1][:220],
                "wall": m.task_blocker(f.get(AF["notes"])),
                "board": list(tm.classify(named, set(), now)[:2]),
                "output": str(f.get(AF["agentOutput"]) or "")[:40]})
print(json.dumps(res))
`, JSON.stringify({ cmds, lead, sibs, card: cardText })], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('one approved card parks the tasks it names, each to its own date (finding 907)', () => {
  it('siblings park to the date their own row gives, then the card under the banner closes', () => {
    const [sib, late, lead] = run([[SIB, '2027-03-31', LEAD, null], [LATE, '2026-12-14', LEAD, null],
      [LEAD, '2027-03-31', null, null]]);
    for (const r of [sib, late]) {
      expect(r.err).toBe('');
      expect(r.status).toBe('Upcoming');
      expect(r.note).toMatch(new RegExp(`^\\[\\d{2} \\w{3} \\d{4} — agent-dispatch\\] Parked until ${r.due} on Kevin's answer on card ${LEAD} \\(Approved as-is, 2026-10-24\\)\\.$`));
    }
    expect([sib.due, late.due]).toEqual(['2027-03-31', '2026-12-14']);
    expect(lead.err).toBe('');
    expect(lead.status).toBe('Upcoming');
    expect(lead.due).toBe('2027-03-31');
    expect(lead.output).toMatch(/^DECIDED \(Kevin, /);
  });

  it("the park clears the task's own tool wall in the same write, so the fix cannot wake it to Today", () => {
    const [sib, , lead] = run([[SIB, '2027-03-31', LEAD, null], [LATE, '2026-12-14', LEAD, null],
      [LEAD, '2027-03-31', null, null]]);
    expect(sib.wall).toBe(null);
    expect(lead.wall).toBe(null);
  });

  it('the board files a parked sibling as parked on his answer, never stuck', () => {
    const [sib] = run([[SIB, '2027-03-31', LEAD, null]]);
    expect(sib.board).toEqual(['parked', 'decidedUntil']);
  });

  it('the card cannot close while a task its table dates is unparked: that would strand it', () => {
    const [early] = run([[LEAD, '2027-03-31', null, null]]);
    expect(early.err).toMatch(new RegExp(`dates 2 other open task\\(s\\) not yet parked on it: ${SIB}, ${LATE}`));
    expect(early.status).toBe('Today');
    const [, half] = run([[SIB, '2027-03-31', LEAD, null], [LEAD, '2027-03-31', null, null]]);
    expect(half.err).toMatch(new RegExp(`not yet parked on it: ${LATE}`));
    const [said] = run([[LEAD, '2027-03-31', null, 'the other rows are already closed elsewhere by Kevin']]);
    expect(said.err).toBe('');
    expect(said.note).toMatch(/Dated rows on this card left as they are: the other rows/);
  });

  it("never to another row's date, never for a task the card does not name, and a month alone is not the date", () => {
    const [wrong, off, month] = run([[LATE, '2027-03-31', LEAD, null], [OFF, '2027-03-31', LEAD, null],
      [SIB, '2027-03-01', LEAD, null]]);
    expect(wrong.err).toMatch(/row for recSIBCLOSExxxxx1 does not name 2027-03-31/);
    expect(off.err).toMatch(/has no table row of its own for recNOTONCARDxxxx1/);
    expect(month.err).toMatch(/does not name 2027-03-01/);
    for (const r of [wrong, off, month]) expect(r.status).toBe('Today');
  });

  it('only the card\'s own table speaks: a history line, an earlier draft or a two-task row gives no date', () => {
    const noSibRow = [ROWS[0], ROWS[2]];
    const history = run([[SIB, '2027-03-31', LEAD, null]],
      { cardText: card(noSibRow, `\n\nTRACK RECORD:\n| ${SIB} | parked to 31 Mar 2027 in an older note |`) });
    expect(history[0].err).toMatch(/has no table row of its own/);
    const draft = run([[SIB, '2027-03-31', LEAD, null]],
      { cardText: card(noSibRow, `\n\nEarlier output:\n| ${SIB} | Held to 31 Mar 2027 |`) });
    expect(draft[0].err).toMatch(/has no table row of its own/);
    const twoTasks = run([[SIB, '2027-03-31', LEAD, null]],
      { cardText: card([ROWS[0], `| ${SIB} and ${LATE} | Held to 31 Mar 2027 |`]) });
    expect(twoTasks[0].err).toMatch(/has no table row of its own/);
    // an option he did not pick, written as prose, is not his answer for that task
    const option = run([[SIB, '2027-03-31', LEAD, null]],
      { cardText: card(noSibRow, `\n\nOPTIONS:\n- B: hold ${SIB} to 31 Mar 2027 as well (not recommended)`) });
    expect(option[0].err).toMatch(/has no table row of its own/);
  });

  it('a date with no year is not a date to park to', () => {
    const [r] = run([[LATE, '2026-12-14', LEAD, null]],
      { cardText: card([ROWS[0], ROWS[1], `| ${LATE} | 3 Example Close | Back on 14 Dec for the check |`]) });
    expect(r.err).toMatch(/does not name 2026-12-14 with its year/);
  });

  it('his words decide: a card he answered with words, or never approved, parks nothing', () => {
    const [worded] = run([[SIB, '2027-03-31', LEAD, null]], { lead: { approvalFeedback: 'Hold them to June instead.' } });
    expect(worded.err).toMatch(/Kevin wrote words with his answer/);
    const [none] = run([[SIB, '2027-03-31', LEAD, null]], { lead: { approvalOutcome: null } });
    expect(none.err).toMatch(/Kevin has not approved recLEADCARDxxxxx1 .*siblings are parked BEFORE the card itself/);
    const [forged] = run([[SIB, '2027-03-31', LEAD, null]], { lead: { sentForApprovalBy: [] } });
    expect(forged.err).toMatch(/carries no real approval: it never went through the approval gate/);
    const [rejected] = run([[SIB, '2027-03-31', LEAD, null]], { lead: { approvalOutcome: 'Rejected' } });
    expect(rejected.err).toMatch(/has not approved/);
    for (const r of [worded, none, forged, rejected]) expect(r.status).toBe('Today');
  });

  it("a sibling's own verdict, a step someone owes, a closed task or a past date is never parked", () => {
    const [own] = run([[SIB, '2027-03-31', LEAD, null]], { sibs: { approvalOutcome: 'Approved as-is' } });
    expect(own.err).toMatch(/has its own verdict standing/);
    const kevinWall = '[24 Oct 2026 13:34 — agent] BLOCKER OPEN (KEVIN payment): pay the fee. [since 2026-10-24T12:34:37.000Z]';
    const [kev] = run([[SIB, '2027-03-31', LEAD, null]], { sibs: { notes: kevinWall } });
    expect(kev.err).toMatch(/has an open KEVIN wall/);
    const [done] = run([[SIB, '2027-03-31', LEAD, null]], { sibs: { status: 'Completed' } });
    expect(done.err).toMatch(/is Completed; parking it would reopen it/);
    const [past] = run([[SIB, '2026-11-01', LEAD, null]]);
    expect(past.err).toMatch(/is not in the future/);
  });

  it('CONTROL: without --on-card a sibling is still not a decision card, and the refusal names the way through', () => {
    const [r] = run([[SIB, '2027-03-31', null, null]]);
    expect(r.err).toMatch(/is not an answered decision card .*--on-card/);
    expect(r.status).toBe('Today');
  });
});

describe("one answer on what a decision card is: dispatch's is_decide_card, read under the banner", () => {
  it('the board and the dispatcher both read a tier-1 DECIDE: card as a decision card, and nothing else as one', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.is_decide_card(m.TIER1_BANNER + "\\n\\nDECIDE: hold it?"), m.is_decide_card("DECIDE: hold it?"),
                  m.is_decide_card(m.TIER1_BANNER + "\\n\\nCLOSE PROPOSAL: done. DECIDE: later"),
                  m.is_decide_card("Findings: the council replied. DECIDE: x")]))`], { encoding: 'utf8' });
    expect(JSON.parse(out.trim().split('\n').pop())).toEqual([true, true, false, false]);
    const src = readFileSync(TM, 'utf8');
    const classify = src.slice(src.indexOf('def classify'), src.indexOf('def metric_text'));
    expect(classify).toContain('_load_dispatch().is_decide_card(f.get("Agent Output"))');
  });
});
