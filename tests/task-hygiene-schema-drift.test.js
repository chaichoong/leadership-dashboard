import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SWEEP = resolve(ROOT, 'scripts/task-hygiene-sweep.py');

// ─── FINDING 20260907-task-manager-board-492 ─────────────────────────
//
// load_schema compared the live select options against EXPECTED_CHOICES with a
// set EQUALITY test, so somebody adding a choice in the Airtable grid killed
// the whole sweep with SystemExit — while every value the sweep actually writes
// stayed perfectly valid.
//
// Measured against the live base on 8 Sep 2026: Time Estimate had gained
// '3 hours', '20 min' and '1 hour' (two of them re-wordings of options that
// already existed), the original load_schema raised
// "FAIL: schema drift" and the fixed one passed.
//
// The asymmetry is the point. A REMOVED option is dangerous — the sweep would
// write a value Airtable rejects, which is the whole reason this check exists.
// An ADDED option cannot hurt a writer that only ever writes from
// EXPECTED_CHOICES, so it is reported, not fatal.

// A fake Airtable meta response, so the test never depends on the live base.
function runSchema(choices) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('s', ${JSON.stringify(SWEEP)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

fields = []
for key, (name, fid) in m.FIELDS.items():
    f = {"name": name, "id": fid, "type": "singleLineText"}
    if key in m.EXPECTED_CHOICES:
        opts = ${JSON.stringify(choices)}.get(key, list(m.EXPECTED_CHOICES[key]))
        f["type"] = "singleSelect"
        f["options"] = {"choices": [{"name": c} for c in opts]}
    fields.append(f)

m.api = lambda *a, **k: {"tables": [{"id": m.TASKS, "fields": fields}]}
try:
    m.load_schema("fake-token")
    print(json.dumps({"ok": True}))
except SystemExit as e:
    print(json.dumps({"ok": False, "why": str(e)}))
`;
  return JSON.parse(
    execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop()
  );
}

describe('load_schema treats added and removed options differently', () => {
  it('CONTROL — an exactly matching schema passes', () => {
    expect(runSchema({}).ok).toBe(true);
  });

  it('an ADDED option does not kill the sweep', () => {
    // The real 8 Sep 2026 drift, verbatim.
    const live = ['15 min', '30 min', '45 min', '1 hr', '2 hr', '3 hr', '4 hr', '8 hr',
      '3 hours', '20 min', '1 hour'];
    expect(runSchema({ timeEstimate: live }).ok).toBe(true);
  });

  it('a REMOVED option still fails loudly', () => {
    // This is what the check is for: the sweep would write a value Airtable
    // rejects, and the write would look like it succeeded.
    const live = ['15 min', '30 min', '45 min', '1 hr', '2 hr', '3 hr', '4 hr'];
    const out = runSchema({ timeEstimate: live });
    expect(out.ok).toBe(false);
    expect(out.why).toMatch(/schema drift/i);
  });

  it('a rename — one option gone, one added — still fails', () => {
    // The dangerous case hiding inside the harmless one. Same count, and the
    // set-equality check caught it only by accident.
    const live = ['15 min', '30 min', '45 min', '1 hr', '2 hr', '3 hr', '4 hr', '8 hours'];
    expect(runSchema({ timeEstimate: live }).ok).toBe(false);
  });

  it('a missing FIELD still fails — this fix must not soften that', () => {
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('s', ${JSON.stringify(SWEEP)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.api = lambda *a, **k: {"tables": [{"id": m.TASKS, "fields": []}]}
try:
    m.load_schema("fake-token")
    print(json.dumps({"ok": True}))
except SystemExit as e:
    print(json.dumps({"ok": False, "why": str(e)}))
`;
    const out = JSON.parse(
      execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop()
    );
    expect(out.ok).toBe(false);
  });

  it('the sweep still writes ONLY the canonical options', () => {
    // The added options must never become writable: '1 hour' alongside '1 hr'
    // fragments the 30-day load figure.
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('s', ${JSON.stringify(SWEEP)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([
    m.validate({"field": "timeEstimate", "value": "1 hr"}, set(), set()),
    m.validate({"field": "timeEstimate", "value": "1 hour"}, set(), set()),
    m.validate({"field": "timeEstimate", "value": "20 min"}, set(), set()),
]))
`;
    const [canonical, reworded, added] = JSON.parse(
      execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop()
    );
    expect(canonical).toBeNull();
    expect(reworded).toMatch(/not a Time Estimate option/);
    expect(added).toMatch(/not a Time Estimate option/);
  });
});
