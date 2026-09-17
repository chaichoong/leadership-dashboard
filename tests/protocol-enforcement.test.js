import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── KEVIN'S 17 SEP 2026 RULES, ENFORCED IN CODE ────────────────────────────
//
// The tranche 3 interview put three rules in the brain that no agent could keep
// by judgement alone, so they sit in the gates:
//   1. a statutory certificate booked through Roy acts with no card up to its
//      cap (gas safety and EPC £100, EICR and fire safety £200);
//   2. the create gate refuses tasks about companies that no longer trade
//      (legal mail excepted) and payment failures under £25 (rent excepted);
//   3. one weekly follow-up lists every Roy repair unmoved for 7 days.
// Nothing here lets an agent send email without a card.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const CREATE = resolve(ROOT, 'scripts/create-agent-task.py');

function py(snippet) {
  const script = `
import importlib.util, json, sys, tempfile, os
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
def level(name, output, desc=""):
    rec = {"id": "recTASK000000001", "fields": {m.AF["name"]: name, m.AF["description"]: desc, m.AF["notes"]: ""}}
    lv = m.decision_level(output, "Admin", rec, fetch=lambda i: {})
    return [lv["level"], lv["category"]]
def roy(what, amount):
    return f"PASS TO ROY: book {what}\\nSPEND: {amount}\\n**Carrying this out will involve:** Roy books it."
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
}

describe('certificate bookings through Roy have their own no-card caps', () => {
  it('acts under the cap for all four certificates and cards above it', () => {
    const out = py(`print(json.dumps({
  "eicr180": level("COMPLIANCE: EICR renewal due 2026-10-14 - 5 Dalham Place", roy("the EICR", "£180")),
  "eicr250": level("COMPLIANCE: EICR renewal due 2026-10-14 - 5 Dalham Place", roy("the EICR", "£250")),
  "gsc90": level("COMPLIANCE: GSC renewal due 2026-10-08 - 5 Dalham Place", roy("the gas safety check", "£90")),
  "gsc150": level("COMPLIANCE: GSC renewal due 2026-10-08 - 5 Dalham Place", roy("the gas safety check", "£150")),
  "epc95": level("COMPLIANCE: EPC renewal due 2026-11-01 - 34 Connaught Road", roy("the EPC", "£95")),
  "fire190": level("COMPLIANCE: fire alarm service due 2026-10-20 - 13 Chedburgh Place", roy("the fire alarm service", "£190")),
  "recurring": level("COMPLIANCE: EICR renewal due 2026-10-14 - 5 Dalham Place", roy("the EICR", "£50/month")),
  "notCompliance": level("MAINTENANCE: new kitchen - 5 Dalham Place", roy("the kitchen", "£180")),
  "veto": level("COMPLIANCE: GSC renewal due 2026-10-08 - 5 Dalham Place", roy("the gas safety check", "£90"), desc="mortgage lender requires this before sale"),
}))`);
    expect(out.eicr180).toEqual(['A', 'pass to Roy']);
    expect(out.eicr250[0]).toBe('B');
    expect(out.gsc90).toEqual(['A', 'pass to Roy']);
    expect(out.gsc150[0]).toBe('B');
    expect(out.epc95).toEqual(['A', 'pass to Roy']);
    expect(out.fire190).toEqual(['A', 'pass to Roy']);
    expect(out.recurring[0]).toBe('B');
    expect(out.notCompliance[0]).toBe('B');
    // The Roy veto still reads the whole text: a sale or a mortgage is never a Level A booking.
    expect(out.veto[0]).toBe('B');
  });
});

describe('the create gate refuses what Kevin ruled is never a card', () => {
  it('passes its selftest, including the never-a-card cases taken from the rejection log', () => {
    const out = JSON.parse(execFileSync('python3', [CREATE, 'selftest'], { encoding: 'utf8' }).trim().split('\n').pop());
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(134);
  });
});

describe('Roy gets one weekly follow-up for repairs unmoved for 7 days', () => {
  it('lists repairs only, stops on a broken read, raises once a week', () => {
    const out = py(`
calls = []
m.raise_engine_task = lambda *a, **k: calls.append(a[0])
m.property_agent_paused = lambda: False
state = os.path.join(tempfile.mkdtemp(), "roy.json")
now = datetime(2026, 9, 17, 12, tzinfo=timezone.utc)
rows = [{"id": "recR1", "fields": {m.AF["name"]: "MAINTENANCE: boiler - 13 Chedburgh Place"}},
        {"id": "recR2", "fields": {m.AF["name"]: "Leaking tap", m.AF["maintenanceTicket"]: True}},
        {"id": "recR3", "fields": {m.AF["name"]: "COMPLIANCE: EICR quotes - 5 Dalham Place"}}]
broken = m.ensure_roy_followups(fetch=lambda f: [], now=now, state_path=state)
first = m.ensure_roy_followups(fetch=lambda f: rows, now=now, state_path=state)
again = m.ensure_roy_followups(fetch=lambda f: rows, now=now, state_path=state)
dry = m.ensure_roy_followups(dry_run=True, fetch=lambda f: rows, now=now, state_path=os.path.join(tempfile.mkdtemp(), "x.json"))
print(json.dumps({"stale": [t["id"] for t in m.stale_roy_repairs(rows)], "broken": broken.get("controlFailed", False),
  "first": first["created"], "again": again["created"], "againWhy": again.get("reason"), "calls": len(calls),
  "dryCreated": dry["created"], "dryStale": len(dry["stale"])}))`);
    expect(out.stale).toEqual(['recR1', 'recR2']);
    expect(out.broken).toBe(true);
    expect(out.first).toBe(true);
    expect(out.again).toBe(false);
    expect(out.againWhy).toBe('already raised this week');
    expect(out.calls).toBe(1);
    expect(out.dryCreated).toBe(false);
    expect(out.dryStale).toBe(2);
  });
});
