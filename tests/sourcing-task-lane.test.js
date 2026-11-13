import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// A BUYING TASK STAYS WITH INBOX RESPONSE (Kevin, 11 Nov 2026: sourcing is that agent's work).
// On 12 Nov 2026 the first buying task raised by hand, "SOURCING: mains smoke alarms and a heat
// alarm ...", sat with Inbox Response and the dispatcher's queue listed it under routingNeeded with
// Property Administration as its target, because its words match the compliance lane ("smoke
// alarm"). That agent has no buying rules. The same words in Roy's lane would hand a boiler to buy
// to Roy as a repair. Every case drives the real task_lane; the smoke alarm name is the real one.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const DISPATCH = resolve(SCRIPTS, 'agent-dispatch.py');
const RESPONSE = 'recJ8J8idWE8d97tH';
const PROPERTY = 'recwWvBju2ycB63i4';
const CEO = 'reciHUAEcEkbctnZ6';
const TASK_MANAGER = resolve(SCRIPTS, 'task-manager.py');
const REAL = 'SOURCING: mains smoke alarms and a heat alarm, radio interlinked, for the four-unit HMO (13 Chedburgh Place to confirm)';

function lane(name, { inbound = false, description = '', holder = RESPONSE } = {}) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def boom(*a, **k): raise RuntimeError("network call in a test")
import urllib.request; urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
AF = m.AF
roster = {"${RESPONSE}": {"name": "Inbox Response", "status": "Live", "dispatchable": True},
          "${PROPERTY}": {"name": "Property Administration", "status": "Live", "dispatchable": True},
          m.CREDITOR_REC_ID: {"name": "Creditor Management", "status": "Live", "dispatchable": True}}
ctx = m.lane_context([], roster, "", [], {})
T = {"id": "recSourcingLaneAa", "createdTime": "2026-11-12T09:45:00.000Z",
     "fields": {AF["name"]: ${JSON.stringify(name)}, AF["description"]: ${JSON.stringify(description)},
                AF["status"]: "Today", AF["teamMember"]: [${JSON.stringify(holder)}],
                AF["taskType"]: "Admin", AF["inboundTask"]: ${inbound ? 'True' : 'False'}}}
t = m.task_view(T)
l, extra = m.task_lane(t, ctx)
print(json.dumps({"lane": l, "property": t.get("property") or "", "target": t.get("autoTarget") or "",
                  "tier1": bool(t.get("tier1")), "creditor": bool(t.get("creditor")),
                  "toCreditor": t.get("autoTarget") == m.CREDITOR_REC_ID}))`], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('a buying task stays with Inbox Response whatever is being bought', () => {
  it('the real smoke alarm task is new work for Inbox Response, not a move to Property Administration', () => {
    // CONTROL: the same words without the prefix are still the compliance lane's, and still move.
    const control = lane(REAL.replace('SOURCING: ', 'Buy '));
    expect(control.property).not.toBe('');
    expect(control.lane).toBe('routingNeeded');
    expect(control.target).toBe(PROPERTY);
    const r = lane(REAL);
    expect(r.property).toBe('');
    expect(r.target).toBe('');
    expect(r.lane).toBe('newWork');
  });

  // The lanes match on the NAME (lane_match: match on the name, veto on everything), so the name is
  // what must be protected. Other compliance items a house needs bought:
  it.each([
    ['carbon monoxide alarms x4 for 5 Example Street'],
    ['emergency lighting units for the Example Building'],
    ['fire alarm call points x2'],
  ])('another compliance item stays too: SOURCING: %s', (item) => {
    expect(lane(`Buy ${item}`).lane).toBe('routingNeeded');   // CONTROL
    const r = lane(`SOURCING: ${item}`);
    expect(r.lane).toBe('newWork');
    expect(r.property).toBe('');
  });

  it('a repair word does not send a buying task to Roy', () => {
    expect(lane('INBOUND: Boiler service, British Gas', { inbound: true }).lane).toBe('royLane');   // CONTROL
    expect(lane('SOURCING: a replacement boiler for 5 Example Street').lane).toBe('newWork');
  });

  it('the prefix is read at the start of the name only, in any case, after spaces', () => {
    expect(lane('  sourcing: smoke alarm heads x6').lane).toBe('newWork');
    // CONTROL: the word later in the name is not the prefix, so the compliance lane still takes it.
    expect(lane('Smoke alarm sourcing: who fits them?').lane).toBe('routingNeeded');
    expect(lane('RESOURCING: smoke alarm rota').lane).toBe('routingNeeded');
  });

  it('the creditor lane still takes a buying task that is really a creditor matter', () => {
    // Review, 12 Nov 2026: the first version of this test passed whatever the lane was.
    const c = lane('SOURCING: final demand from British Gas for the boiler invoice, debt collection');
    expect(c.creditor).toBe(true);
    expect(c.lane).toBe('routingNeeded');
    expect(c.toCreditor).toBe(true);
    // CONTROL: an ordinary buying task has no creditor mark and no target.
    const plain = lane(REAL);
    expect(plain.creditor).toBe(false);
    expect(plain.toCreditor).toBe(false);
  });
});

// A BUYING REQUEST THAT ARRIVES BY EMAIL (Kevin, 13 Nov 2026: "Yes, fix it"). The inbox sorter
// named every emailed request "INBOUND: ...", so PR #911's rule never saw one: Roy's own fridge
// freezer request of 29 Oct was "INBOUND: Roy asks us to source 4 fridge freezers ..." and stayed
// with Inbox Response only because a fridge freezer is in no lane's word list. The sorter now names
// a buying request SOURCING: at birth (its skill, rule 1d). A sorter task is born inbound and held
// by the AI CEO, so the dispatcher's FRESH routes place it: these drive that path.
describe('a buying request born from an email reaches Inbox Response', () => {
  const born = (name) => lane(name, { inbound: true, holder: CEO });

  it('a compliance item to buy goes to Inbox Response, not Property Administration', () => {
    // CONTROL: the name the sorter gave it before, the same request, moves to the compliance lane.
    const before = born('INBOUND: Roy asks us to source 6 smoke alarms for 5 Example Street');
    expect(before.lane).toBe('routingNeeded');
    expect(before.target).toBe(PROPERTY);
    const r = born('SOURCING: 6 smoke alarms for 5 Example Street');
    expect(r.lane).toBe('routingNeeded');
    expect(r.target).toBe(RESPONSE);
    expect(r.property).toBe('');
  });

  it('a repair item to buy goes to Inbox Response, not to Roy', () => {
    // CONTROL: named as before, a boiler is Roy's repair lane and never reaches a buying agent.
    expect(born('INBOUND: Roy asks us to buy a replacement boiler for 5 Example Street').lane).toBe('royLane');
    const r = born('SOURCING: a replacement boiler for 5 Example Street');
    expect(r.lane).toBe('routingNeeded');
    expect(r.target).toBe(RESPONSE);
  });

  it('an item in no lane word list is placed the same way under either name', () => {
    // The 29 Oct shape: nothing here was ever broken, and the new name must not break it.
    const before = born('INBOUND: Roy asks us to source 4 fridge freezers for the Example HMOs');
    const after = born('SOURCING: 4 fridge freezers for the Example HMOs');
    expect(before.target).toBe(RESPONSE);
    expect(after.target).toBe(RESPONSE);
    expect(after.lane).toBe(before.lane);
  });

  it('a creditor matter born from an email still goes to the creditor lane', () => {
    const c = born('SOURCING: final demand from British Gas for the boiler invoice, debt collection');
    expect(c.lane).toBe('routingNeeded');
    expect(c.toCreditor).toBe(true);
  });
});

// The Task Board Manager offers Roy a stuck task that is "his lane" (task-manager.py roy_lane, which
// reads the dispatcher's own lane words). It must not offer him a buy.
describe("the Task Manager's Roy check leaves a buying task alone", () => {
  function royLane(fields) {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def boom(*a, **k): raise RuntimeError("network call in a test")
import urllib.request; urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location("tm", ${JSON.stringify(TASK_MANAGER)})
tm = importlib.util.module_from_spec(spec); spec.loader.exec_module(tm)
print(json.dumps({"why": tm.roy_lane(json.loads(sys.argv[1]))}))`, JSON.stringify(fields)], { encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop()).why;
  }

  it('a boiler to buy is not offered to Roy; the same boiler as a repair is', () => {
    expect(royLane({ 'Task Name': 'INBOUND: Boiler service, British Gas' })).not.toBe('');   // CONTROL
    expect(royLane({ 'Task Name': 'SOURCING: a replacement boiler for 5 Example Street' })).toBe('');
  });

  it('a compliance item to buy is not offered to Roy either', () => {
    expect(royLane({ 'Task Name': 'Buy 6 smoke alarms for 5 Example Street' })).not.toBe('');   // CONTROL
    expect(royLane({ 'Task Name': 'SOURCING: 6 smoke alarms for 5 Example Street' })).toBe('');
  });

  it('a maintenance ticket tick does not make a buying task Roy\'s', () => {
    expect(royLane({ 'Task Name': 'Two desk lamps for 5 Example Street', 'Maintenance Ticket': true })).toBe('maintenance ticket');   // CONTROL
    expect(royLane({ 'Task Name': 'SOURCING: two desk lamps for 5 Example Street', 'Maintenance Ticket': true })).toBe('');
  });
});

// BUYING IS ITS OWN FOLD LANE (review, 13 Nov 2026). The creation gate folds a new task into an
// open one about the same matter. A request to buy alarms folded into an open "INBOUND: ... smoke
// alarms ..." reply task would keep that task's name, and the name is what the dispatcher routes
// on, so the buy would go to Property Administration after all. These drive the gate's real
// decide(); every "create" has a control showing the same pair folds when the lanes agree.
describe('the creation gate keeps a buying task apart from a reply task', () => {
  const GATE = resolve(SCRIPTS, 'create-agent-task.py');
  function gate(body) {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def boom(*a, **k): raise RuntimeError("network call in a test")
import urllib.request; urllib.request.urlopen = boom
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod
g = load("g", ${JSON.stringify(GATE)})
F = g.F
def row(name):
    return {"id": "recOpenTaskAaaaaa", "createdTime": "2026-11-01T00:00:00.000Z",
            "fields": {F["name"]: name, F["status"]: {"name": "Today"}, F["inboundSender"]: "sender@example.com"}}
def decide(incoming, open_name):
    d = g.decide({F["name"]: incoming, F["inboundSender"]: "sender@example.com", F["status"]: "Today",
                  F["desc"]: "x"}, [row(open_name)])
    return d.get("action")
${body}`], { encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop());
  }
  const OPEN_REPLY = 'INBOUND: Sender re smoke alarms not linking at 5 Example Street';
  const OPEN_BUY = 'SOURCING: smoke alarms and a heat alarm for 5 Example Street';

  it('a request to buy is not folded into an open reply task about the same item', () => {
    const r = gate(`print(json.dumps({
      "control": decide("INBOUND: Sender asks us to buy 6 smoke alarms for 5 Example Street", ${JSON.stringify(OPEN_REPLY)}),
      "buy": decide("SOURCING: 6 smoke alarms for 5 Example Street", ${JSON.stringify(OPEN_REPLY)})}))`);
    expect(r.control).toBe('update');   // CONTROL: named as a reply, the same request folds in
    expect(r.buy).toBe('create');
  });

  it('a second request for the same buy still folds into the open buying task', () => {
    const r = gate(`print(json.dumps({"again": decide("SOURCING: 6 smoke alarms for 5 Example Street", ${JSON.stringify(OPEN_BUY)})}))`);
    expect(r.again).toBe('update');
  });

  it('a reply about the same item is not folded into an open buying task', () => {
    const incoming = 'INBOUND: Sender asks about smoke alarms and a heat alarm for 5 Example Street';
    const r = gate(`print(json.dumps({
      "control": decide(${JSON.stringify(incoming)}, ${JSON.stringify(OPEN_BUY.replace('SOURCING:', 'INBOUND:'))}),
      "reply": decide(${JSON.stringify(incoming)}, ${JSON.stringify(OPEN_BUY)})}))`);
    expect(r.control).toBe('update');   // CONTROL: against a reply task of the same words it folds
    expect(r.reply).toBe('create');
  });

  it('a repair ticket or a task Roy holds is still the repair lane, whatever its name', () => {
    const r = gate(`print(json.dumps({"plain": g.fold_lane("SOURCING: a boiler"),
      "roy": g.fold_lane("SOURCING: a boiler", [g.ROY_TEAM_MEMBER]),
      "ticket": g.fold_lane("SOURCING: a boiler", None, True),
      "later": g.fold_lane("INBOUND: sourcing: a boiler")}))`);
    expect(r).toEqual({ plain: 'sourcing', roy: 'maintenance', ticket: 'maintenance', later: 'reply' });
  });

  it('the gate and the dispatcher read the same prefix', () => {
    const r = gate(`s = load("s", ${JSON.stringify(resolve(SCRIPTS, 'agent_sourcing_format.py'))})
names = ["SOURCING: x", "  sourcing: x", "INBOUND: x", "RESOURCING: x", "Sourcing x", ""]
print(json.dumps({"gate": g.SOURCING_TASK_PREFIX, "dispatch": s.SOURCING_TASK_PREFIX,
                  "agree": [g.sourcing_task(n) == s.sourcing_task(n) for n in names],
                  "reads": [g.sourcing_task(n) for n in names]}))`);
    expect(r.gate).toBe(r.dispatch);
    expect(r.agree).toEqual([true, true, true, true, true, true]);
    expect(r.reads).toEqual([true, true, false, false, false, false]);
  });

  it('an out-of-office reply named as a buying task is still refused', () => {
    const r = gate(`print(json.dumps({
      "auto": g.auto_reply_refusal({F["name"]: "SOURCING: Automatic reply: out of office"}, {}),
      "real": g.auto_reply_refusal({F["name"]: "SOURCING: 6 smoke alarms for 5 Example Street"}, {})}))`);
    expect(r.auto).toMatch(/auto-reply subject/);
    expect(r.real).toBeNull();   // CONTROL: a real buying request is not refused
  });
});

describe('an email written from a buying task never shows the internal prefix', () => {
  it('the redirect email subject drops SOURCING: as it drops INBOUND:', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def boom(*a, **k): raise RuntimeError("network call in a test")
import urllib.request; urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def subject(name):
    mail = m.redirect_email({m.AF["name"]: name, m.AF["inboundSender"]: "sender@example.com"})
    return [l for l in mail.splitlines() if l.startswith("SUBJECT:")][0]
print(json.dumps({"buy": subject("SOURCING: 6 smoke alarms for 5 Example Street"),
                  "reply": subject("INBOUND: 6 smoke alarms for 5 Example Street")}))`], { encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').pop());
    expect(r.reply).toBe('SUBJECT: Re: 6 smoke alarms for 5 Example Street');   // CONTROL
    expect(r.buy).toBe(r.reply);
  });
});
