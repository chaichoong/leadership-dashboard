import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// THE DIARY CARD (Kevin, 18 Oct 2026): "anything that comes into my inbox with something that
// should be added to my calendar: create an approval card for whether it needs to go in my
// calendar or not." Inbox Triage raises a CALENDAR: task beside the email's own task, and the
// independent review found four places that would quietly lose it before it became a card:
// the create gate folding it into the reply task, two diary dates from one sender folding into
// one, the Task Board Manager and an agent's duplicate close treating it as the reply task's
// twin, and repair or compliance words routing it to Roy or Property Administration.
// Every case drives the real Python. Names and dates are invented.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const GATE = resolve(SCRIPTS, 'create-agent-task.py');
const DISPATCH = resolve(SCRIPTS, 'agent-dispatch.py');
const TM = resolve(SCRIPTS, 'task-manager.py');
const RESPONSE = 'recJ8J8idWE8d97tH';
const PROPERTY = 'recwWvBju2ycB63i4';
const THREAD = 'https://mail.google.com/mail/u/0/#all/1a0496b9df667238';

function py(path, body) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def boom(*a, **k): raise RuntimeError("network call in a test")
import urllib.request; urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(path)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}
`], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const decide = (incoming, existing) => py(GATE, `
F = m.F
row = lambda i, n: {"id": "recOpen%010d" % i, "createdTime": "2026-10-18T09:00:00.000Z", "fields": {
    F["name"]: n, F["status"]: {"name": "Today"}, F["inboundSender"]: "bookings@example-dental.co.uk",
    F["inboundUrl"]: ${JSON.stringify(THREAD)}}}
rows = [row(i, n) for i, n in enumerate(json.loads(${JSON.stringify(JSON.stringify(existing))}))]
print(json.dumps(m.decide({F["name"]: ${JSON.stringify(incoming)}, F["inboundSender"]: "bookings@example-dental.co.uk",
                          F["inboundUrl"]: ${JSON.stringify(THREAD)}}, rows)))`);

describe('the create gate never folds a diary task away', () => {
  it('a diary task and the reply task on the same email stay two tasks, both ways round', () => {
    // CONTROL first: the same two names as reply tasks DO fold, so the lane is what refuses.
    expect(decide('INBOUND: Dentist appointment, Example Dental - confirm attendance',
      ['INBOUND: Example Dental dentist appointment - please confirm attendance']).action).toBe('update');
    expect(decide('CALENDAR: Dentist appointment, Example Dental - Tue 27 Oct',
      ['INBOUND: Example Dental dentist appointment - please confirm attendance']).action).toBe('create');
    expect(decide('INBOUND: Example Dental dentist appointment - please confirm attendance',
      ['CALENDAR: Dentist appointment, Example Dental - Tue 27 Oct']).action).toBe('create');
  });

  it('two diary dates from one sender are two entries; the same date folds', () => {
    const other = decide('CALENDAR: Hygienist appointment, Example Dental - Thu 12 Nov',
      ['CALENDAR: Dentist check-up appointment, Example Dental - Tue 27 Oct']);
    expect(other.action).toBe('create');
    expect(other.note).toMatch(/different dates/);
    expect(decide('CALENDAR: Dentist appointment, Example Dental - Tue 27 Oct',
      ['CALENDAR: Dentist appointment, Example Dental - Tue 27 Oct']).action).toBe('update');
  });

  it('reads the date at the end of the name, and refuses a fold when either name has none', () => {
    const r = py(GATE, `print(json.dumps([m.diary_date("CALENDAR: Viewing, 12 March Street - Fri 6 Nov"),
      m.fold_on_another_date("CALENDAR: Parents evening, Example School", "CALENDAR: Parents evening, Example School - Wed 4 Nov"),
      m.fold_on_another_date("INBOUND: a - Tue 27 Oct", "INBOUND: a - Thu 12 Nov")]))`);
    expect(r[0]).toEqual([6, 'nov']);
    expect(r[1]).toMatch(/carries no date/);
    expect(r[2]).toBe('');
  });
});

describe("an agent's duplicate close never closes a diary task against another task", () => {
  const close = (thisName, keeperName) => py(DISPATCH, `
AF = m.AF
keeper = {"id": "recKeeperAaaaaaaa", "createdTime": "2026-10-18T08:00:00.000Z",
          "fields": {AF["name"]: ${JSON.stringify(keeperName)}, AF["status"]: "Today", AF["teamMember"]: ["${RESPONSE}"]}}
me = {"id": "recDiaryAaaaaaaaa", "createdTime": "2026-10-18T09:00:00.000Z",
      "fields": {AF["name"]: ${JSON.stringify(thisName)}, AF["status"]: "Today", AF["teamMember"]: ["${RESPONSE}"]}}
d = m.decision_level("CLOSE PROPOSAL: duplicate of recKeeperAaaaaaaa", "Admin", me,
                     fetch=lambda i: json.loads(json.dumps(keeper)))
print(json.dumps({"level": d["level"], "why": d.get("why") or d.get("evidence")}))`);

  it('a diary task is not the twin of the reply task on its email', () => {
    const r = close('CALENDAR: Dentist appointment, Example Dental - Tue 27 Oct',
      'INBOUND: Example Dental dentist appointment - please confirm attendance');
    expect(r.level).toBe('B');
    expect(r.why).toMatch(/calendar task/);
  });

  it('two diary tasks on different dates are not twins; the same date closes at Level A', () => {
    const r = close('CALENDAR: Hygienist appointment, Example Dental - Thu 12 Nov',
      'CALENDAR: Hygienist appointment, Example Dental - Tue 27 Oct');
    expect(r.level).toBe('B');
    expect(r.why).toMatch(/different dates/);
    expect(close('CALENDAR: Hygienist appointment, Example Dental - Tue 27 Oct',
      'CALENDAR: Hygienist appointment, Example Dental - Tue 27 Oct').level).toBe('A');
  });
});

describe('the Task Board Manager never lists a diary task as closable', () => {
  const groups = (names) => py(TM, `
names = json.loads(${JSON.stringify(JSON.stringify(names))})
views = [{"id": "recView%010d" % i, "name": n, "status": "Today", "createdTime": "2026-10-18T0%d:00:00.000Z" % (i + 1),
          "inboundUrl": ${JSON.stringify(THREAD)}, "teamMember": ["${RESPONSE}"], "maintenanceTicket": False,
          "description": ""} for i, n in enumerate(names)]
print(json.dumps([{"lane": g["lane"], "closable": g["closable"]} for g in m.duplicate_groups(views)]))`);

  it('the reply task and the diary task on one thread are two lanes, not a pair', () => {
    // CONTROL: two reply tasks on the thread do pair up, so the grouping itself works here.
    expect(groups(['INBOUND: Example Dental dentist appointment - please confirm attendance',
      'INBOUND: Dentist appointment, Example Dental - confirm attendance'])).toHaveLength(1);
    expect(groups(['INBOUND: Example Dental dentist appointment - please confirm attendance',
      'CALENDAR: Dentist appointment, Example Dental - Tue 27 Oct'])).toEqual([]);
  });

  it('two diary tasks on one thread with different dates: neither is closable', () => {
    const g = groups(['CALENDAR: Hygienist appointment, Example Dental - Tue 27 Oct',
      'CALENDAR: Hygienist appointment, Example Dental - Thu 12 Nov']);
    expect(g).toHaveLength(1);
    expect(g[0].lane).toBe('calendar');
    expect(g[0].closable).toEqual([]);
  });
});

describe('a diary task stays with Inbox Response whatever words it carries', () => {
  const lane = (name, inbound) => py(DISPATCH, `
AF = m.AF
roster = {"${RESPONSE}": {"name": "Inbox Response", "status": "Live", "dispatchable": True},
          "${PROPERTY}": {"name": "Property Administration", "status": "Live", "dispatchable": True}}
ctx = m.lane_context([], roster, "", [], {})
T = {"id": "recDiaryLaneAaaa", "createdTime": "2026-10-18T10:00:00.000Z",
     "fields": {AF["name"]: ${JSON.stringify(name)}, AF["status"]: "Today", AF["teamMember"]: ["${RESPONSE}"],
                AF["taskType"]: "Admin", AF["inboundTask"]: ${inbound ? 'True' : 'False'}}}
t = m.task_view(T)
l, extra = m.task_lane(t, ctx)
print(json.dumps({"lane": l, "property": t.get("property") or ""}))`);

  it('a repair word does not send it to Roy', () => {
    expect(lane('INBOUND: Boiler service, British Gas', true).lane).toBe('royLane');   // CONTROL
    expect(lane('CALENDAR: Boiler service, British Gas - Tue 27 Oct', false).lane).toBe('newWork');
  });

  it('a compliance word does not hand it to Property Administration', () => {
    expect(lane('INBOUND: Gas safety check due - 5 Example Street', true).property).not.toBe('');  // CONTROL
    const r = lane('CALENDAR: Gas safety check, Example Gas - Tue 27 Oct', false);
    expect(r.property).toBe('');
    expect(r.lane).toBe('newWork');
  });
});

describe('an approved diary card closes only once the entry is written', () => {
  const complete = (written, why = '') => py(DISPATCH, `
import types
AF = m.AF
state = {AF["name"]: "CALENDAR: Dentist appointment, Example Dental - Tue 27 Oct", AF["status"]: "Today",
         AF["approvalOutcome"]: "Approved as-is", AF["taskType"]: "Admin", AF["notes"]: "",
         AF["agentOutput"]: "CALENDAR:\\nTITLE: Dentist\\nSTART: 2099-10-27 10:00\\nEND: 2099-10-27 10:30\\n---\\nA check-up.\\n**Carrying this out will involve:** adding it to your diary."}
m.get_task = lambda t: {"id": t, "createdTime": "2026-10-18T09:00:00.000Z", "fields": dict(state)}
def patch(t, f):
    state.update(f)
    return {"id": t}
m.patch_task = patch
m.diary_written = lambda t: ${written ? 'True' : 'False'}
m.ledger_append = lambda *a, **k: None
import io, contextlib
try:
    with contextlib.redirect_stdout(io.StringIO()):
        m.cmd_complete(types.SimpleNamespace(task="recDiaryDoneAaaa", keep_open=False, note="", no_certificate="",
                                             evidence="", not_signed="", diary_not_written=${JSON.stringify(why)}))
    print(json.dumps({"status": state.get(AF["status"]), "notes": state.get(AF["notes"])}))
except SystemExit as e:
    print(json.dumps({"exit": str(e)}))`);

  it('refused while calendar-write.py has no record of writing it', () => {
    expect(complete(false).exit).toMatch(/approved diary card and calendar-write\.py has no record/);
  });
  it('closes once the ledger shows it written', () => {
    expect(complete(true).status).toBe('Completed');
  });
  it('closes without the write only with the reason on the record', () => {
    const r = complete(false, 'approved after the appointment had passed');
    expect(r.status).toBe('Completed');
    expect(r.notes).toMatch(/DIARY NOT WRITTEN: approved after the appointment had passed/);
  });
  it('the ledger reader counts a created row only, never the intent row alone', () => {
    const r = py(resolve(SCRIPTS, 'agent_calendar_format.py'), `
import tempfile, os
fh = tempfile.NamedTemporaryFile('w', suffix='.jsonl', delete=False)
fh.write(json.dumps({"task": "recA", "event": "intent"}) + "\\n" + json.dumps({"task": "recB", "event": "intent"}) + "\\n"
         + json.dumps({"task": "recB", "event": "created", "id": "evt1"}) + "\\n")
fh.close()
print(json.dumps([m.diary_written("recA", fh.name), m.diary_written("recB", fh.name), m.diary_written("recC", fh.name)]))
os.unlink(fh.name)`);
    expect(r).toEqual([false, true, false]);
  });
});

describe('second review (18 Oct 2026): what else could lose or change a diary card', () => {
  it('a new message never folds into a diary card already waiting on Kevin; it folds while the task is drafted', () => {
    const at = (status) => py(GATE, `
F = m.F
rows = [{"id": "recCardWaitingAaa", "createdTime": "2026-10-18T09:00:00.000Z", "fields": {
    F["name"]: "CALENDAR: Dentist appointment, Example Dental - Tue 27 Oct", F["status"]: {"name": "${status}"},
    F["inboundSender"]: "bookings@example-dental.co.uk"}}]
print(json.dumps(m.decide({F["name"]: "CALENDAR: Dentist appointment, Example Dental - Tue 27 Oct",
                          F["inboundSender"]: "bookings@example-dental.co.uk"}, rows)))`);
    expect(at('Today').action).toBe('update');
    const waiting = at('Approval');
    expect(waiting.action).toBe('create');
    expect(waiting.note).toMatch(/waiting on Kevin is never changed under him/);
  });

  const level = (out, name, keeper) => py(DISPATCH, `
AF = m.AF
k = ${keeper ? `{"id": "recKeeperAaaaaaaa", "createdTime": "2026-10-18T08:00:00.000Z", "fields": {AF["name"]: ${JSON.stringify(keeper.name)}, AF["status"]: ${JSON.stringify(keeper.status)}, AF["teamMember"]: ["${RESPONSE}"]}}` : 'None'}
me = {"id": "recDiaryAaaaaaaaa", "createdTime": "2026-10-18T09:00:00.000Z",
      "fields": {AF["name"]: ${JSON.stringify(name)}, AF["status"]: "Today", AF["teamMember"]: ["${RESPONSE}"]}}
d = m.decision_level(${JSON.stringify(out)}, "Admin", me, fetch=lambda i: json.loads(json.dumps(k)))
print(json.dumps({"level": d["level"], "why": d.get("why") or d.get("evidence")}))`);

  it("an agent cannot fold a newer diary task into a card waiting on Kevin; a drafted keeper still folds", () => {
    const name = 'CALENDAR: Dentist appointment, Example Dental - Tue 27 Oct';
    const waiting = level('CLOSE PROPOSAL: duplicate of recKeeperAaaaaaaa', name, { name, status: 'Approval' });
    expect(waiting.level).toBe('B');
    expect(waiting.why).toMatch(/diary card waiting on Kevin/);
    expect(level('CLOSE PROPOSAL: duplicate of recKeeperAaaaaaaa', name, { name, status: 'Today' }).level).toBe('A');
  });

  it('a diary task is never closed as already handled by another task; a reply task still is', () => {
    const done = { name: 'INBOUND: Example Dental dentist appointment - please confirm attendance', status: 'Completed' };
    const diary = level('CLOSE PROPOSAL: already handled — see recKeeperAaaaaaaa', 'CALENDAR: Dentist appointment, Example Dental - Tue 27 Oct', done);
    expect(diary.level).toBe('B');
    expect(diary.why).toMatch(/decided on its own card/);
    expect(level('CLOSE PROPOSAL: already handled — see recKeeperAaaaaaaa', 'INBOUND: Example Dental reminder', done).level).toBe('A');  // CONTROL
  });

  it('a creditor word does not move a diary task to the creditor agent', () => {
    const lane = (name) => py(DISPATCH, `
AF = m.AF
CRED = "recjh6mmaF8KJW8t3"
roster = {"${RESPONSE}": {"name": "Inbox Response", "status": "Live", "dispatchable": True},
          CRED: {"name": "Creditor Management", "status": "Live", "dispatchable": True}}
ctx = m.lane_context([], roster, "", [], {})
T = {"id": "recDiaryCredAaaaa", "createdTime": "2026-10-18T10:00:00.000Z",
     "fields": {AF["name"]: ${JSON.stringify(name)}, AF["status"]: "Today", AF["teamMember"]: ["${RESPONSE}"],
                AF["taskType"]: "Admin", AF["description"]: "CREDITOR MATTER"}}
t = m.task_view(T)
l, extra = m.task_lane(t, ctx)
print(json.dumps({"lane": l, "target": t.get("autoTarget") or ""}))`);
    expect(lane('INBOUND: Call with Barclaycard about the payment plan').target).toBe('recjh6mmaF8KJW8t3');  // CONTROL
    const r = lane('CALENDAR: Call with Barclaycard about the payment plan - Wed 28 Oct');
    expect(r.target).toBe('');
    expect(r.lane).not.toBe('routingNeeded');
  });

  it('the date is the first one in the last part of the name, and a damaged ledger line is never a write', () => {
    expect(py(GATE, `print(json.dumps(m.diary_date("CALENDAR: Dentist, Example Dental - Sat 31 Oct (was 24 Oct)")))`)).toEqual([31, 'oct']);
    const r = py(resolve(SCRIPTS, 'agent_calendar_format.py'), `
import tempfile, os
fh = tempfile.NamedTemporaryFile('w', suffix='.jsonl', delete=False)
fh.write('{"task": "recA", "event": "creat\\n' + json.dumps({"task": "recB", "event": "created"}) + "\\n")
fh.close()
print(json.dumps([m.diary_written("recA", fh.name), m.diary_written("recB", fh.name)]))
os.unlink(fh.name)`);
    expect(r).toEqual([false, true]);
  });
});

describe('third review (18 Oct 2026): the board never proposes closing a diary card into one waiting on Kevin', () => {
  const groups = (rows) => py(TM, `
rows = json.loads(${JSON.stringify(JSON.stringify(rows))})
views = [{"id": "recView%010d" % i, "name": r[0], "status": r[1], "createdTime": "2026-10-18T0%d:00:00.000Z" % (i + 1),
          "inboundUrl": ${JSON.stringify(THREAD)}, "teamMember": ["${RESPONSE}"], "maintenanceTicket": False,
          "description": ""} for i, r in enumerate(rows)]
print(json.dumps([{k: g[k] for k in ("keeper", "closable", "folds", "untouchable", "sameThreadDifferentMatter")}
                  for g in m.duplicate_groups(views)]))`);
  const NAME = 'CALENDAR: Dentist appointment, Example Dental - Tue 27 Oct';

  it('a newer diary task beside a waiting card is report-only, drafted or not', () => {
    for (const status of ['Today', 'Approval']) {
      const g = groups([[NAME, 'Approval'], [NAME, status]]);
      expect(g).toHaveLength(1);
      expect(g[0].closable, status).toEqual([]);
      expect(g[0].folds, status).toEqual([]);
    }
  });

  it('CONTROL: while the first diary task is still being drafted, a twin is closable as before', () => {
    expect(groups([[NAME, 'Today'], [NAME, 'Today']])[0].closable).toEqual(['recView0000000001']);
  });
});

