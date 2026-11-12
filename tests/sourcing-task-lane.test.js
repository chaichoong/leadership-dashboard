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
          "${PROPERTY}": {"name": "Property Administration", "status": "Live", "dispatchable": True}}
ctx = m.lane_context([], roster, "", [], {})
T = {"id": "recSourcingLaneAa", "createdTime": "2026-11-12T09:45:00.000Z",
     "fields": {AF["name"]: ${JSON.stringify(name)}, AF["description"]: ${JSON.stringify(description)},
                AF["status"]: "Today", AF["teamMember"]: [${JSON.stringify(holder)}],
                AF["taskType"]: "Admin", AF["inboundTask"]: ${inbound ? 'True' : 'False'}}}
t = m.task_view(T)
l, extra = m.task_lane(t, ctx)
print(json.dumps({"lane": l, "property": t.get("property") or "", "target": t.get("autoTarget") or "",
                  "tier1": bool(t.get("tier1")), "creditor": bool(t.get("creditor"))}))`], { encoding: 'utf8' });
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

  it('tier 1 and the creditor lane still win over a buying task', () => {
    // A creditor's demand named as a buying task is still the creditor lane's (the steal is by lane, not by words here).
    const c = lane('SOURCING: final demand from British Gas for the boiler invoice, debt collection');
    expect(c.creditor || c.tier1 || c.lane !== 'newWork').toBe(true);
  });
});
