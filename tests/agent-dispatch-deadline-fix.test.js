// Finding 20261119-agent-dispatch-1376. At 10:00 on 19 Nov 2026 Kevin approved,
// as-is, moving another card's due date to 2026-12-02. `due` reads only his words
// in the TARGET card's own newest feedback, and his approval sat on the DEADLINE FIX
// task that raised the card, so the move was refused (exit 2, nothing written). The
// approved note was appended to the target by hand and the date was left as it was:
// there was no route at all for one card's approval to move another card's date.
//
// The route added is the shape every other record-changing door uses: the card he
// read names the record and the value in ONE line, and his AS-IS approval of that
// card is the authority. Back-test: every case here fails on the code before, where
// --approved-on does not exist.
//
// Everything drives the real cmd_due. Airtable is in memory, every network call
// raises. Names, ids and dates are invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts', 'agent-dispatch.py');

const PRE = `
import importlib.util, json, os, io, sys, contextlib, types, tempfile, urllib.request
from datetime import datetime as _dt, timedelta, timezone
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
STATE = tempfile.mkdtemp()
m.STATE_DIR = STATE
m.NOTES_ARCHIVE = STATE
AF = m.AF
AGENT = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
TODAY = _dt.now(m.LONDON).date()
TARGET_DATE = (TODAY + timedelta(days=11)).isoformat()
CREATED = (_dt.now(timezone.utc) - timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
APPROVED_AT = (_dt.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
TASKS = {}

def target(i="recTargetAaaaaaaa", status="Today", feedback=""):
    TASKS[i] = {"id": i, "createdTime": CREATED, "fields": {
        AF["name"]: "CREDITOR + CORRESPONDENCE: 18 Exampleton Road council tax",
        AF["status"]: {"name": status}, AF["dueDate"]: TODAY.isoformat(),
        AF["teamMember"]: [AGENT], AF["notes"]: "", AF["approvalFeedback"]: feedback}}
    return i

def card(i="recCardAaaaaaaaaa", line=None, outcome="Approved as-is", stamped=True, approved_at=None):
    body = "DECIDE: the council tax card's due date disagrees with the agreed date. Move it?"
    if line is None:
        line = "DEADLINE FIX: recTargetAaaaaaaa Due Date = " + TARGET_DATE
    f = {AF["name"]: "DEADLINE FIX: the council tax card's due date",
         AF["status"]: {"name": "Today"}, AF["teamMember"]: [AGENT], AF["notes"]: "",
         AF["agentOutput"]: body + "\\n\\n" + line if line else body}
    if outcome:
        f[AF["approvalOutcome"]] = {"name": outcome}
    if stamped:
        f[AF["approvedAt"]] = approved_at or APPROVED_AT
        f[AF["sentForApprovalBy"]] = [AGENT]
    TASKS[i] = {"id": i, "createdTime": CREATED, "fields": f}
    return i

m.get_task = lambda i: json.loads(json.dumps(TASKS[i]))
def patch(i, f):
    TASKS[i]["fields"].update(f)
    return {"id": i}
m.patch_task = patch
m.cap_notes = lambda text, task_id=None: text

def due(task, date, **kw):
    a = dict(task=task, date=date, why="the agreed date with the council is later", quote=None, approved_on=None)
    a.update(kw)
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            code = m.cmd_due(types.SimpleNamespace(**a))
    except SystemExit as e:
        return {"exit": "ERROR", "said": str(e)}
    said = out.getvalue().strip().split("\\n")[-1] if out.getvalue().strip() else "{}"
    return {"exit": code or 0, "said": json.loads(said), "due": TASKS[task]["fields"].get(AF["dueDate"]),
            "notes": TASKS[task]["fields"].get(AF["notes"], "")}
`;

function py(snippet) {
  const out = execFileSync('python3', ['-c', PRE + snippet], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json'), SIGNIN_SKIP_WALK: '1' },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

describe("one card's approval can move another card's due date, and only his", () => {
  it("moves the date on the approved card that names the task and the date", () => {
    const r = py(`
t = target(); c = card()
print(json.dumps(due(t, TARGET_DATE, approved_on=c)))`);
    expect(r.exit).toBe(0);
    expect(r.said.approvedOn).toBe('recCardAaaaaaaaaa');
    // Written, read back, and the trail says which card carried his approval.
    expect(r.said.to).toBe(r.due);
    expect(r.notes).toMatch(/DUE MOVED from .* to .*: the agreed date with the council is later \(Kevin approved as-is on \d{4}-\d{2}-\d{2}: recCardAaaaaaaaaa "DEADLINE FIX: the council tax card's due date"\)/);
  });

  it("refuses a card that names another task, another date, or no date at all, and writes nothing", () => {
    const r = py(`
t = target()
other = card("recWrongTaskAaaaa", line="DEADLINE FIX: recSomeoneElseAaa Due Date = " + TARGET_DATE)
stale = card("recWrongDateAaaaa", line="DEADLINE FIX: recTargetAaaaaaaa Due Date = " + (TODAY + timedelta(days=30)).isoformat())
bare = card("recNoLineAaaaaaaa", line="")
two = card("recTwoLinesAaaaaa", line=("DEADLINE FIX: recTargetAaaaaaaa Due Date = " + TARGET_DATE
          + "\\nDEADLINE FIX: recTargetAaaaaaaa Due Date = " + (TODAY + timedelta(days=12)).isoformat()))
print(json.dumps({k: due(t, TARGET_DATE, approved_on=v) for k, v in
                  (("otherTask", other), ("otherDate", stale), ("noLine", bare), ("twoLines", two))}))`);
    for (const k of ['otherTask', 'otherDate', 'noLine', 'twoLines']) {
      expect(r[k].exit).toBe(2);
      expect(r[k].notes).toBe('');   // nothing written on a refusal
    }
    expect(r.otherTask.said.why).toMatch(/sets the date on recSomeoneElseAaa, not recTargetAaaaaaaa/);
    expect(r.otherDate.said.why).toMatch(/not /);
    expect(r.noLine.said.why).toMatch(/carries no 'DEADLINE FIX: <task id> Due Date = YYYY-MM-DD' line/);
    expect(r.twoLines.said.why).toMatch(/carries 2 DEADLINE FIX lines/);
    expect(r.noLine.notes).toBe('');
  });

  it("refuses an approval with edits, one not approved, and one with no approval stamp", () => {
    const r = py(`
t = target()
edits = card("recEditsAaaaaaaaa", outcome="Approved with minor edits")
none = card("recNoVerdictAaaaa", outcome=None, stamped=False)
unstamped = card("recUnstampedAaaaa", stamped=False)
early = card("recEarlyAaaaaaaaa", approved_at=(_dt.now(timezone.utc) - timedelta(days=9)).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
print(json.dumps({k: due(t, TARGET_DATE, approved_on=v) for k, v in
                  (("edits", edits), ("none", none), ("unstamped", unstamped), ("early", early))}))`);
    expect(r.edits.said.why).toMatch(/approval came WITH EDITS/);
    expect(r.none.said.why).toMatch(/not approved as-is/);
    // The marks only a real approval leaves: the gate, the queue, and a stamp after the task was born.
    expect(r.unstamped.exit).toBe(2);
    expect(r.early.exit).toBe(2);
    expect(r.edits.notes).toBe('');
  });

  it("the target's own gates still hold: never a card in his queue, never a past date", () => {
    const r = py(`
atApproval = target("recAtApprovalAaaa", status="Approval")
done = target("recDoneAaaaaaaaaa", status="Completed")
ok = target()
c = card()
past = card("recPastAaaaaaaaaa", line="DEADLINE FIX: recTargetAaaaaaaa Due Date = " + (TODAY - timedelta(days=2)).isoformat())
print(json.dumps({
  "atApproval": due(atApproval, TARGET_DATE, approved_on=card("recForApprovalAaa", line="DEADLINE FIX: recAtApprovalAaaa Due Date = " + TARGET_DATE)),
  "done": due(done, TARGET_DATE, approved_on=card("recForDoneAaaaaaa", line="DEADLINE FIX: recDoneAaaaaaaaaa Due Date = " + TARGET_DATE)),
  "past": due(ok, (TODAY - timedelta(days=2)).isoformat(), approved_on=past)}))`);
    expect(r.atApproval.exit).toBe(2);
    expect(r.atApproval.said.why).toMatch(/waiting at Approval in Kevin's queue/);
    expect(r.done.exit).toBe(2);
    expect(r.done.said.why).toMatch(/the task is Completed/);
    expect(r.past.exit).toBe(2);
    expect(r.past.said.why).toMatch(/is in the past/);
  });

  it("neither words nor an approved card is no authority, and his own card is not --approved-on", () => {
    const r = py(`
t = target()
print(json.dumps({"neither": due(t, TARGET_DATE), "itself": due(t, TARGET_DATE, approved_on=t)}))`);
    expect(r.neither.exit).toBe('ERROR');
    expect(r.neither.said).toMatch(/pass --quote .* or --approved-on/);
    expect(r.itself.exit).toBe('ERROR');
    expect(r.itself.said).toMatch(/names this same task/);
  });

  it("the old route is untouched: his own words on the task still move it", () => {
    const r = py(`
words = "Move this one to " + TARGET_DATE + " please, the council agreed that date."
t = target("recWordsAaaaaaaaa", feedback=words)
print(json.dumps({"ok": due(t, TARGET_DATE, quote=words),
                  "notHis": due(target("recNoWordsAaaaaaa"), TARGET_DATE, quote=words)}))`);
    expect(r.ok.exit).toBe(0);
    expect(r.ok.due).toBe(r.ok.said.to);
    expect(r.notHis.exit).toBe(2);
    expect(r.notHis.said.why).toMatch(/not Kevin's own words/);
  });
});
