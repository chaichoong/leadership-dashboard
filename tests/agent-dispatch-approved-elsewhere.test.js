import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// AN APPROVAL KEVIN GAVE ON ANOTHER TASK.
//
// An approved card on task A routinely rules on tasks B, C, D. Every write path read approval
// evidence from the TARGET task only, and `due` refused a past date outright, so three critical
// findings sat blocked for 10 to 35 days with no door at all:
//   - 20261015-agent-dispatch-915: the approved carry-out moved checkpoint 3 from 2 Nov to 16 Nov.
//     `due` needs Kevin's words on THAT task and it has none. Same wall on 5 Oct.
//   - 20261021-agent-dispatch-1028: an approved card ruled on 13 other tasks. `due` refused 9,
//     `complete` refused item 6, and no command could untick a Hard Deadline at all.
//   - 20261108-agent-dispatch-1246: one field, a Due Date back from 2026-11-06 to 2026-11-05, and
//     `due` refuses a past date.
//
// `--approved-on <ruling task> --quote "<his words>"` is the one door. These tests drive the real
// cmd_due, cmd_complete and cmd_hard_deadline_off against an in-memory Airtable. Ids, names and
// dates are invented; the dates are computed from today so the suite cannot rot.
//
// THE BACK-TEST. Every test in the two "the new door" blocks below, and both Hard Deadline tests,
// fail on the code before this change: cmd_hard_deadline_off does not exist, and `due` on a past
// date refuses whatever is passed. Prove it without a stash:
//   git show HEAD:scripts/agent-dispatch.py > /tmp/pre.py
//   DISPATCH_PY=/tmp/pre.py npx vitest run tests/agent-dispatch-approved-elsewhere.test.js

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = process.env.DISPATCH_PY
  ? resolve(process.env.DISPATCH_PY)
  : resolve(ROOT, 'scripts/agent-dispatch.py');

const PRE = `
import importlib.util, json, os, io, sys, contextlib, types, tempfile, urllib.request
from datetime import datetime as _dt, timedelta, timezone, date as _date
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
STATE = tempfile.mkdtemp()
m.STATE_DIR = STATE
m.INTENT_LEDGER = os.path.join(STATE, "carryout-intent.jsonl")
m.NOTES_ARCHIVE = STATE
m.HANDOVER_DIR = tempfile.mkdtemp()
m.BROWSER_LEDGER = "/nonexistent/od-test-browser-ledger.jsonl"
AF = m.AF
AGENT = [k for k, v in m.ALL_AGENTS.items() if v.get("agent") == "worker-builder"][0]
CREATED = (_dt.now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
APPROVED_AT = (_dt.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
STALE_APPROVED_AT = (_dt.now(timezone.utc) - timedelta(days=60)).strftime("%Y-%m-%dT%H:%M:%S.000Z")

TODAY = m.datetime.now(m.LONDON).date()
PAST = (TODAY - timedelta(days=5)).isoformat()
FUTURE = (TODAY + timedelta(days=14)).isoformat()
FAR = (TODAY + timedelta(days=90)).isoformat()

TARGET = "recBPOCOLLECT001"
RULING = "recRULINGCARD001"
TASKS = {}

def rec(i, **f):
    base = {AF["name"]: "BPO COLLECTIONS: chase the arrears file", AF["status"]: {"name": "Today"},
            AF["teamMember"]: [AGENT], AF["notes"]: "", AF["description"]: "", AF["agentOutput"]: ""}
    base.update({(m.HARD_DEADLINE_FIELD if k == "hardDeadline" else AF[k]): v for k, v in f.items()})
    TASKS[i] = {"id": i, "createdTime": CREATED, "fields": base}

def ruling(quote, **over):
    """The card Kevin really approved: it went through the gate, his verdict is on it, and his
    Approved At is after it existed. Exactly what approval_evidence_problem asks for."""
    f = dict(name="CARRY OUT: the November collections plan", status={"name": "Today"},
             sentForApprovalBy=[AGENT], approvedAt=APPROVED_AT, approvalOutcome={"name": "Approved as-is"},
             approvalFeedback=quote)
    f.update(over)
    rec(RULING, **f)

m.get_task = lambda i: json.loads(json.dumps(TASKS[i]))
def patch(i, f):
    TASKS[i]["fields"].update(f)
    return {"id": i}
m.patch_task = patch
m.query_tasks = lambda formula, **kw: []
m.fetch_role_roster = lambda: {}
m.finding_details = lambda: {}
m.task_fields_owe_certificate = lambda *a, **k: []
m.task_owes_cost = lambda *a, **k: []

def run(fn, **a):
    """(error-or-None, printed-json-or-None). A refusal reports either way in this file."""
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            fn(types.SimpleNamespace(**a))
    except SystemExit as e:
        return str(e), None
    out = buf.getvalue().strip().splitlines()
    try:
        return None, json.loads(out[-1]) if out else None
    except ValueError:
        return None, {"printed": out[-1] if out else ""}

def due(date, quote, approved_on="", task=None, why="Kevin's approved plan sets this date"):
    return run(m.cmd_due, task=task or TARGET, date=date, why=why, quote=quote, approved_on=approved_on)

def complete(approved_on="", quote="", task=None):
    return run(m.cmd_complete, task=task or TARGET, keep_open=False, note="", until="", no_certificate="",
               evidence="Kevin's approved collections plan was carried out and the file is closed.",
               not_signed="", diary_not_written="", cost_not_written="", not_bought="",
               approved_on=approved_on, quote=quote)

def hard_off(approved_on="", quote="", task=None):
    return run(m.cmd_hard_deadline_off, task=task or TARGET, why="his approved plan drops the hard deadline",
               quote=quote, approved_on=approved_on)

def fields(i):
    return TASKS[i]["fields"]

def notes(i):
    return str(TASKS[i]["fields"].get(AF["notes"]) or "")
`;

function py(body) {
  const out = execFileSync('python3', ['-c', PRE + body], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('finding 20261108-agent-dispatch-1246: a past due date on the ruling card he approved', () => {
  it('moves the date back and writes the audit line naming the ruling task and his words', () => {
    const r = py(`
rec(TARGET, dueDate=(TODAY + timedelta(days=1)).isoformat())
ruling(f"Yes, put {TARGET} back to {PAST} — the 6th was never right.")
err, out = due(PAST, f"put {TARGET} back to {PAST}", approved_on=RULING)
print(json.dumps({"err": err, "out": out, "due": fields(TARGET).get(AF["dueDate"]),
                  "status": m.sel(fields(TARGET).get(AF["status"])), "notes": notes(TARGET), "past": PAST,
                  "last": notes(TARGET).split("\\n\\n")[-1]}))`);
    expect(r.err).toBe(null);
    expect(r.out.due).toBe('recBPOCOLLECT001');
    expect(r.out.approvedOn).toBe('recRULINGCARD001');
    expect(r.due).toBe(r.past);
    expect(r.status).toBe('Today');
    // The audit line: dated, stamped by the dispatcher, naming the ruling task and quoting him.
    expect(r.notes).toMatch(/— agent-dispatch\] APPROVED ELSEWHERE: due date moved to \d{4}-\d{2}-\d{2} on recBPOCOLLECT001 on Kevin's approval recorded on recRULINGCARD001, not on this task\. His words: "put recBPOCOLLECT001 back to \d{4}-\d{2}-\d{2}"/);
    // DUE MOVED stays the LAST note, so every surface that reads the last note still reads the move.
    expect(r.last).toMatch(/— agent-dispatch\] DUE MOVED from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}:/);
    expect(r.last).toContain('Kevin on recRULINGCARD001:');
  });

  it('the same past date with no --approved-on is still refused', () => {
    const r = py(`
rec(TARGET, dueDate=(TODAY + timedelta(days=1)).isoformat(),
    approvalFeedback=f"put {TARGET} back to {PAST}")
ruling(f"Yes, put {TARGET} back to {PAST}.")
err, out = due(PAST, f"put {TARGET} back to {PAST}")
print(json.dumps({"err": err, "out": out, "due": fields(TARGET).get(AF["dueDate"]),
                  "untouched": (TODAY + timedelta(days=1)).isoformat(), "notes": notes(TARGET)}))`);
    expect(r.err).toBe(null);
    expect(r.out.why).toMatch(/is in the past$/);
    expect(r.out.refused).toBe('recBPOCOLLECT001');
    expect(r.due).toBe(r.untouched);       // nothing was written
    expect(r.notes).toBe('');
  });

  it('a past date his approved words do not name the DAY of is refused, month or not', () => {
    const r = py(`
import calendar
month = calendar.month_name[(TODAY - timedelta(days=5)).month]
rec(TARGET, dueDate=(TODAY + timedelta(days=1)).isoformat())
ruling(f"Yes, pull {TARGET} back a day, some time in {month} is fine.")
a = due(PAST, f"pull {TARGET} back a day", approved_on=RULING)
b = due(PAST, f"back a day, some time in {month} is fine", approved_on=RULING)
print(json.dumps({"a": a[1], "b": b[1], "aerr": a[0], "berr": b[0],
                  "due": fields(TARGET).get(AF["dueDate"]), "notes": notes(TARGET)}))`);
    expect(r.aerr).toBe(null);
    expect(r.a.why).toMatch(/is in the past and Kevin's approved words do not name that day/);
    // Naming the MONTH is not naming the day: that is what quote_names_exact_date is for.
    expect(r.b.why).toMatch(/do not name that day|do not name this task/);
    expect(r.notes).toBe('');
  });
});

describe('the new door is a door, not a hole: the ruling task carries a REAL approval of his', () => {
  const bad = (over, quoteOverride) => py(`
rec(TARGET, dueDate=(TODAY + timedelta(days=1)).isoformat())
q = f"Yes, put {TARGET} back to {PAST}."
ruling(q, **json.loads(${JSON.stringify(JSON.stringify({}))}))
f = fields(RULING)
for k, v in json.loads(${JSON.stringify(JSON.stringify(over))}).items():
    f[AF[k]] = v if v != "__DELETE__" else None
    if v == "__DELETE__":
        del f[AF[k]]
err, out = due(PAST, ${quoteOverride || 'f"put {TARGET} back to {PAST}"'}, approved_on=RULING)
print(json.dumps({"err": err, "out": out, "due": fields(TARGET).get(AF["dueDate"]), "notes": notes(TARGET)}))`);

  it('refuses a ruling task that never went through the approval gate', () => {
    const r = bad({ sentForApprovalBy: '__DELETE__' });
    expect(r.out.why).toMatch(/does not carry the marks of a real approval: it never went through the approval gate/);
    expect(r.notes).toBe('');
  });

  it('refuses a ruling task with no Approved At, and one whose Approved At was copied from before it existed', () => {
    expect(bad({ approvedAt: '__DELETE__' }).out.why).toMatch(/no approval was ever recorded/);
    const copied = py(`
rec(TARGET, dueDate=(TODAY + timedelta(days=1)).isoformat())
ruling(f"Yes, put {TARGET} back to {PAST}.", approvedAt=STALE_APPROVED_AT)
err, out = due(PAST, f"put {TARGET} back to {PAST}", approved_on=RULING)
print(json.dumps({"out": out, "notes": notes(TARGET)}))`);
    expect(copied.out.why).toMatch(/earlier than the task itself, so it was copied, not given/);
    expect(copied.notes).toBe('');
  });

  it('refuses a ruling task whose verdict is not an approval — a bare string is never enough', () => {
    expect(bad({ approvalOutcome: { name: 'Changes requested' } }).out.why)
      .toMatch(/carries no approval of Kevin's: its Approval Outcome is 'Changes requested'/);
    expect(bad({ approvalOutcome: '__DELETE__' }).out.why).toMatch(/Approval Outcome is 'empty'/);
  });

  it('refuses words that are not in his approved text on the ruling task', () => {
    const r = py(`
rec(TARGET, dueDate=(TODAY + timedelta(days=1)).isoformat())
ruling("Yes, carry on with the plan as written.")
err, out = due(PAST, f"put {TARGET} back to {PAST}", approved_on=RULING)
print(json.dumps({"out": out, "notes": notes(TARGET)}))`);
    expect(r.out.why).toMatch(/--quote is not in Kevin's approved words on recRULINGCARD001/);
    expect(r.notes).toBe('');
  });

  it('refuses a quote that does not name this target — one approval is not a blank cheque', () => {
    const r = py(`
rec(TARGET, dueDate=(TODAY + timedelta(days=1)).isoformat())
ruling(f"Yes, pull that one back to {PAST} please, it was wrong.")
err, out = due(PAST, f"pull that one back to {PAST} please", approved_on=RULING)
print(json.dumps({"out": out, "notes": notes(TARGET)}))`);
    expect(r.out.why).toMatch(/Kevin's quoted words do not name this task: they must contain its record id \(recBPOCOLLECT001\) or at least 4 words in a row from its name/);
    expect(r.out.why).toMatch(/so recRULINGCARD001 does not rule on it/);
    expect(r.notes).toBe('');
  });

  it('accepts his words when they quote the task by NAME rather than by id', () => {
    const r = py(`
rec(TARGET, dueDate=(TODAY + timedelta(days=1)).isoformat())
ruling(f"Yes — BPO COLLECTIONS: chase the arrears file goes back to {PAST}.")
err, out = due(PAST, f"BPO COLLECTIONS: chase the arrears file goes back to {PAST}", approved_on=RULING)
print(json.dumps({"err": err, "out": out, "due": fields(TARGET).get(AF["dueDate"]), "past": PAST}))`);
    expect(r.err).toBe(null);
    expect(r.due).toBe(r.past);
  });

  it('refuses --approved-on pointing at the task itself, and a quote too short to be a sentence', () => {
    const r = py(`
rec(TARGET, dueDate=(TODAY + timedelta(days=1)).isoformat())
ruling(f"Yes, put {TARGET} back to {PAST}.")
a = due(PAST, f"put {TARGET} back to {PAST}", approved_on=TARGET)
b = due(PAST, "back", approved_on=RULING)
print(json.dumps({"a": a[1], "b": b[1], "notes": notes(TARGET)}))`);
    expect(r.a.why).toMatch(/names this same task/);
    expect(r.b.why).toMatch(/--quote needs Kevin's own words from the ruling card, verbatim/);
    expect(r.notes).toBe('');
  });
});

describe('finding 20261015-agent-dispatch-915: the approved carry-out moves a checkpoint on another task', () => {
  it('a future move the ruling card approved goes through, Upcoming on his date', () => {
    const r = py(`
rec(TARGET, name="CHECKPOINT 3: the trust review", dueDate=(TODAY + timedelta(days=1)).isoformat())
ruling(f"Approved — move {TARGET} from the 2nd to {FUTURE}.")
err, out = due(FUTURE, f"move {TARGET} from the 2nd to {FUTURE}", approved_on=RULING)
print(json.dumps({"err": err, "out": out, "due": fields(TARGET).get(AF["dueDate"]),
                  "status": m.sel(fields(TARGET).get(AF["status"])), "future": FUTURE,
                  "notes": notes(TARGET)}))`);
    expect(r.err).toBe(null);
    expect(r.due).toBe(r.future);
    expect(r.status).toBe('Upcoming');
    expect(r.notes).toContain('APPROVED ELSEWHERE: due date moved to');
  });

  it('CONTROL: every other guard on `due` stands on the new route', () => {
    const r = py(`
rec(TARGET, dueDate=(TODAY + timedelta(days=1)).isoformat())
ruling(f"Approved — move {TARGET} well out, whenever suits.")
q = f"move {TARGET} well out, whenever suits"
far = due(FAR, q, approved_on=RULING)[1]
fields(TARGET)[AF["status"]] = {"name": "Approval"}
appr = due(FUTURE, q, approved_on=RULING)[1]
fields(TARGET)[AF["status"]] = {"name": "In Progress"}
prog = due(FUTURE, q, approved_on=RULING)[1]
fields(TARGET)[AF["status"]] = {"name": "Completed"}
done = due(FUTURE, q, approved_on=RULING)[1]
shortwhy = run(m.cmd_due, task=TARGET, date=FUTURE, why="too short", quote=q, approved_on=RULING)
print(json.dumps({"far": far, "appr": appr, "prog": prog, "done": done, "shortwhy": shortwhy[0],
                  "notes": notes(TARGET)}))`);
    expect(r.far.why).toMatch(/more than 31 days out and Kevin's quoted words do not name its month or date/);
    expect(r.appr.why).toMatch(/waiting at Approval in Kevin's queue/);
    expect(r.prog.why).toMatch(/a robot holds the task In Progress/);
    expect(r.done.why).toMatch(/the task is Completed/);
    expect(r.shortwhy).toMatch(/--why needs Kevin's words/);
    expect(r.notes).toBe('');
  });

  it('CONTROL: the plain route still demands his words on the TARGET task', () => {
    const r = py(`
rec(TARGET, dueDate=(TODAY + timedelta(days=1)).isoformat())
ruling(f"Approved — move {TARGET} to {FUTURE}.")
err, out = due(FUTURE, f"move {TARGET} to {FUTURE}")
print(json.dumps({"out": out, "notes": notes(TARGET)}))`);
    expect(r.out.why).toMatch(/--quote is not Kevin's own words in his NEWEST note on this task/);
    expect(r.notes).toBe('');
  });
});

describe('finding 20261021-agent-dispatch-1028: complete, and the Hard Deadline nothing could untick', () => {
  it('completes a target with no approval of its own on the ruling card, and audits it', () => {
    const r = py(`
rec(TARGET)
ruling(f"Approved — {TARGET} is done, close it.")
err, out = complete(approved_on=RULING, quote=f"{TARGET} is done, close it")
print(json.dumps({"err": err, "out": out, "status": m.sel(fields(TARGET).get(AF["status"])),
                  "notes": notes(TARGET)}))`);
    expect(r.err).toBe(null);
    expect(r.out.completed).toBe('recBPOCOLLECT001');
    expect(r.status).toBe('Completed');
    expect(r.notes).toMatch(/— agent-dispatch\] APPROVED ELSEWHERE: closed on recBPOCOLLECT001 on Kevin's approval recorded on recRULINGCARD001, not on this task\. His words: "recBPOCOLLECT001 is done, close it"/);
  });

  it('the same close with no --approved-on is still refused as unapproved', () => {
    const r = py(`
rec(TARGET)
ruling(f"Approved — {TARGET} is done, close it.")
err, out = complete()
print(json.dumps({"err": err, "status": m.sel(fields(TARGET).get(AF["status"]))}))`);
    expect(r.err).toMatch(/refusing to complete recBPOCOLLECT001 — outcome is 'empty', not an approval/);
    expect(r.status).toBe('Today');
  });

  it('refuses the close when the ruling task is not a real approval, or his words do not name the task', () => {
    const r = py(`
rec(TARGET)
ruling(f"Approved — {TARGET} is done, close it.", sentForApprovalBy=[])
a = complete(approved_on=RULING, quote=f"{TARGET} is done, close it")
ruling(f"Approved — that one is done, close it.")
b = complete(approved_on=RULING, quote="that one is done, close it")
print(json.dumps({"a": a[0], "b": b[0], "status": m.sel(fields(TARGET).get(AF["status"]))}))`);
    expect(r.a).toMatch(/on an approval recorded elsewhere: recRULINGCARD001 does not carry the marks of a real approval/);
    expect(r.b).toMatch(/quoted words do not name this task/);
    expect(r.status).toBe('Today');
  });

  it('CONTROL: a ruling card never closes a task over a live verdict of Kevin\'s', () => {
    const r = py(`
rec(TARGET, approvalOutcome={"name": "Rejected"}, sentForApprovalBy=[AGENT], approvedAt=APPROVED_AT)
ruling(f"Approved — {TARGET} is done, close it.")
err, out = complete(approved_on=RULING, quote=f"{TARGET} is done, close it")
print(json.dumps({"err": err, "status": m.sel(fields(TARGET).get(AF["status"]))}))`);
    expect(r.err).toMatch(/outcome is 'Rejected', not an approval/);
    expect(r.status).toBe('Today');
  });

  it('unticks a Hard Deadline on the ruling card, and refuses to untick one off that route', () => {
    const r = py(`
rec(TARGET, hardDeadline=True, dueDate=(TODAY + timedelta(days=1)).isoformat())
ruling(f"Approved — {TARGET} no longer has a hard deadline.")
off, noroute = hard_off(approved_on=RULING, quote=f"{TARGET} no longer has a hard deadline"), None
plain = hard_off(quote=f"{TARGET} no longer has a hard deadline")
again = hard_off(approved_on=RULING, quote=f"{TARGET} no longer has a hard deadline")
print(json.dumps({"err": off[0], "out": off[1], "hard": bool(fields(TARGET).get(m.HARD_DEADLINE_FIELD)),
                  "plain": plain[0], "again": again[1], "notes": notes(TARGET)}))`);
    expect(r.err).toBe(null);
    expect(r.out.hardDeadlineOff).toBe('recBPOCOLLECT001');
    expect(r.out.approvedOn).toBe('recRULINGCARD001');
    expect(r.hard).toBe(false);
    expect(r.notes).toMatch(/— agent-dispatch\] APPROVED ELSEWHERE: Hard Deadline unticked \(his approved plan drops the hard deadline\) on recBPOCOLLECT001 on Kevin's approval recorded on recRULINGCARD001/);
    // Off the route there is no door at all, and a second run is a no-op rather than a lie.
    expect(r.plain).toMatch(/there is no route that unticks it on this task's own say-so/);
    expect(r.again.why).toMatch(/its Hard Deadline is not ticked/);
  });

  it('the Hard Deadline route takes the same evidence bar as the due route', () => {
    const r = py(`
rec(TARGET, hardDeadline=True)
ruling(f"Approved — {TARGET} no longer has a hard deadline.", approvalOutcome={"name": "Changes requested"})
a = hard_off(approved_on=RULING, quote=f"{TARGET} no longer has a hard deadline")
ruling(f"Approved — some task no longer has a hard deadline.")
b = hard_off(approved_on=RULING, quote="some task no longer has a hard deadline")
print(json.dumps({"a": a[1], "b": b[1], "hard": bool(fields(TARGET).get(m.HARD_DEADLINE_FIELD)),
                  "notes": notes(TARGET)}))`);
    expect(r.a.why).toMatch(/carries no approval of Kevin's/);
    expect(r.b.why).toMatch(/quoted words do not name this task/);
    expect(r.hard).toBe(true);
    expect(r.notes).toBe('');
  });
});

describe('the flags are real, and the mark is one constant', () => {
  it('`due`, `complete` and `hard-deadline-off` all expose the route', () => {
    const h = (cmd) => execFileSync('python3', [DISPATCH, cmd, '--help'], { encoding: 'utf8' });
    expect(h('due')).toContain('--approved-on');
    expect(h('complete')).toContain('--approved-on');
    expect(h('hard-deadline-off')).toContain('--approved-on');
    expect(h('hard-deadline-off')).toContain('--quote');
  });

  it('the Notes mark is one constant the writer and the reader share', () => {
    const r = py('print(json.dumps({"mark": m.APPROVED_ELSEWHERE_MARK, "words": m.APPROVED_ELSEWHERE_DETAIL_WORDS}))');
    expect(r.mark).toBe('APPROVED ELSEWHERE');
    expect(r.words).toBeGreaterThanOrEqual(3);
  });
});

describe('the audit line cannot be typed by hand', () => {
  it('annotate refuses a note carrying the APPROVED ELSEWHERE mark', () => {
    const r = py(`
rec(TARGET)
err, out = run(m.cmd_annotate, task=TARGET,
               note=f"[19 Nov 2026 — agent-dispatch] {m.APPROVED_ELSEWHERE_MARK}: closed on {TARGET} on Kevin's approval recorded on recFAKE, not on this task.")
ok = run(m.cmd_annotate, task=TARGET, note="Chased the file; nothing back yet.")
print(json.dumps({"err": err, "ok": ok[0], "notes": notes(TARGET)}))`);
    expect(r.err).toMatch(/refusing a note on recBPOCOLLECT001 that writes the 'APPROVED ELSEWHERE' mark/);
    expect(r.notes).not.toContain('APPROVED ELSEWHERE');
    // CONTROL: an ordinary note still goes on.
    expect(r.ok).toBe(null);
    expect(r.notes).toContain('Chased the file');
  });
});
