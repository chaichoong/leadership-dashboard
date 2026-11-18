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
// when the card carries a real approval with no words of his, and one line of the card names that
// task AND that exact date.
//
// These tests drive the real cmd_decided against in-memory tasks. Ids, places and sums are invented.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const TM_SRC = readFileSync(resolve(ROOT, 'scripts/task-manager.py'), 'utf8');

const LEAD = 'recLEADCARDxxxxx1';
const SIB = 'recSIBPLACExxxxx1';     // held to 31 Mar 2027 on the card
const LATE = 'recSIBCLOSExxxxx1';    // back on 14 Dec 2026 on the card
const OFF = 'recNOTONCARDxxxx1';     // a task the card never names

function run(cmds, leadOver = {}, taskOver = {}) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, types, urllib.request
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
AF = m.AF
m.today_london = lambda: "2026-11-18"
CARD = (m.TIER1_BANNER + "\\n\\nDECIDE: keep your council tax hold, now dated to 31 March 2027, for all three tasks.\\n\\n"
        "## The three tasks this card covers\\n\\n| Task | Property | What it asks | If you approve |\\n|---|---|---|---|\\n"
        "| ${LEAD} | 1 Example Place | Raise standing order to £100 | Held to 31 Mar 2027. £90 carries on |\\n"
        "| ${SIB} | 2 Example Place | Raise standing order to £110 | Held to 31 Mar 2027. £95 carries on |\\n"
        "| ${LATE} | 3 Example Close | Change standing order to £80 | Back on 14 Dec 2026 for the overpay check |")
WALL = "[24 Oct 2026 13:34 — agent] BLOCKER OPEN (TOOL agent-dispatch parking door): decided refuses. [finding 20261015-agent-dispatch-907]"
def task(i, **f):
    base = {AF["name"]: i, AF["status"]: "Today", AF["dueDate"]: "2026-10-24", AF["notes"]: WALL}
    base.update(f)
    return {"id": i, "createdTime": "2026-01-15T11:00:00.000Z", "fields": base}
TASKS = {
    "${LEAD}": task("${LEAD}", **{AF["agentOutput"]: CARD, AF["approvalOutcome"]: "Approved as-is",
                                  AF["approvedAt"]: "2026-10-24T12:20:40.545Z", AF["sentForApprovalBy"]: ["recAGENTxxxxxxxx1"]}),
    "${SIB}": task("${SIB}"), "${LATE}": task("${LATE}"), "${OFF}": task("${OFF}"),
}
for k, v in json.loads(sys.argv[1]).items():
    TASKS["${LEAD}"]["fields"][AF[k]] = v
for k, v in json.loads(sys.argv[2]).items():
    for t in ("${SIB}", "${LATE}"):
        TASKS[t]["fields"][AF[k]] = v
m.get_task = lambda tid: json.loads(json.dumps(TASKS[tid]))
def patch_task(tid, fields):
    TASKS[tid]["fields"].update(fields)
    return TASKS[tid]
m.patch_task = patch_task
res = []
for task_id, until, card in json.loads(sys.argv[3]):
    err = ""
    try:
        m.cmd_decided(types.SimpleNamespace(task=task_id, until=until, on_card=card))
    except SystemExit as e:
        err = str(e)
    f = TASKS[task_id]["fields"]
    res.append({"err": err, "status": f.get(AF["status"]), "due": f.get(AF["dueDate"]),
                "note": (f.get(AF["notes"]) or "").split("\\n\\n")[-1][:220],
                "output": str(f.get(AF["agentOutput"]) or "")[:40]})
print(json.dumps(res))
`, JSON.stringify(leadOver), JSON.stringify(taskOver), JSON.stringify(cmds)], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('one approved card parks the tasks it names, each to its own date (finding 907)', () => {
  it('the card under the tier-1 banner is a decision card, so decided closes it', () => {
    const [lead] = run([[LEAD, '2027-03-31', null]]);
    expect(lead.err).toBe('');
    expect(lead.status).toBe('Upcoming');
    expect(lead.due).toBe('2027-03-31');
    expect(lead.output).toMatch(/^DECIDED \(Kevin, /);
    expect(lead.note).toMatch(/^\[\d{2} \w{3} \d{4} — agent-dispatch\] Parked until 2027-03-31 on Kevin's answer/);
  });

  it('a sibling parks to the date its own line gives, and the board reads the stamp as parked', () => {
    const [sib, late] = run([[SIB, '2027-03-31', LEAD], [LATE, '2026-12-14', LEAD]]);
    for (const r of [sib, late]) {
      expect(r.err).toBe('');
      expect(r.status).toBe('Upcoming');
      expect(r.note).toMatch(new RegExp(`^\\[\\d{2} \\w{3} \\d{4} — agent-dispatch\\] Parked until ${r.due} on Kevin's answer on card ${LEAD} \\(Approved as-is, 2026-10-24\\)`));
    }
    expect(sib.due).toBe('2027-03-31');
    expect(late.due).toBe('2026-12-14');
  });

  it("never to another row's date, and never for a task the card does not name", () => {
    const [wrong, off] = run([[LATE, '2027-03-31', LEAD], [OFF, '2027-03-31', LEAD]]);
    expect(wrong.err).toMatch(/no line of recLEADCARDxxxxx1 that names recSIBCLOSExxxxx1 also names 2027-03-31/);
    expect(wrong.status).toBe('Today');
    expect(off.err).toMatch(/never names recNOTONCARDxxxx1/);
    expect(off.status).toBe('Today');
  });

  it('a month alone is not the date: 1 Mar 2027 is refused where the line says 31 Mar 2027', () => {
    const [r] = run([[SIB, '2027-03-01', LEAD]]);
    expect(r.err).toMatch(/also names 2027-03-01/);
  });

  it('his words decide: a card he answered with words, or never approved, parks nothing', () => {
    const [worded] = run([[SIB, '2027-03-31', LEAD]], { approvalFeedback: 'Hold them to June instead.' });
    expect(worded.err).toMatch(/Kevin wrote words with his answer/);
    const [none] = run([[SIB, '2027-03-31', LEAD]], { approvalOutcome: null });
    expect(none.err).toMatch(/Kevin has not approved recLEADCARDxxxxx1 .*siblings are parked BEFORE the card itself/);
    const [forged] = run([[SIB, '2027-03-31', LEAD]], { sentForApprovalBy: [] });
    expect(forged.err).toMatch(/carries no real approval: it never went through the approval gate/);
    const [rejected] = run([[SIB, '2027-03-31', LEAD]], { approvalOutcome: 'Rejected' });
    expect(rejected.err).toMatch(/has not approved/);
    for (const r of [worded, none, forged, rejected]) expect(r.status).toBe('Today');
  });

  it('a closed task is never reopened, and a past date is refused', () => {
    const [done] = run([[SIB, '2027-03-31', LEAD]], {}, { status: 'Completed' });
    expect(done.err).toMatch(/is Completed; parking it would reopen it/);
    const [past] = run([[SIB, '2026-11-01', LEAD]]);
    expect(past.err).toMatch(/is not in the future/);
  });

  it('CONTROL: without --on-card a sibling is still not a decision card, and the refusal names the way through', () => {
    const [r] = run([[SIB, '2027-03-31', null]]);
    expect(r.err).toMatch(/is not an answered decision card .*--on-card/);
    expect(r.status).toBe('Today');
  });

  it("the board reads a decision card by dispatch's own is_decide_card (one answer)", () => {
    const classify = TM_SRC.slice(TM_SRC.indexOf('def classify'), TM_SRC.indexOf('def metric_text'));
    expect(classify).toContain('_load_dispatch().is_decide_card(f.get("Agent Output"))');
  });
});
