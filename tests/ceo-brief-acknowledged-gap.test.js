// A brief day that cannot be rebuilt is PRINTED, not counted — and only that
// exact row is covered.
//
// Regression origin: finding 20261013-worker-auditor-855. 5 Oct 2026's CEO
// Briefs row recwxCjRvfEaluUtX holds the fallback stub ("Slack post failed:
// invalid_blocks") and the written brief was never stored, so the row cannot be
// rebuilt. ceo-brief-complete failed every 06:42 run from 13 Oct and would have
// gone on failing until 26 Oct, when the 21-day window drops the date. Every
// agent slot re-read and re-annotated the same closed day.
//
// These tests drive the real check out of the script with a stubbed Airtable
// read. Back-tested by emptying ACKNOWLEDGED_BRIEF_GAPS: the first test goes
// red (1 violation) exactly as the live run did.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/check-data-invariants.py');

function py(code) {
  return execFileSync('python3', ['-c', code], { encoding: 'utf8', timeout: 30000 });
}

const LOAD = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("cdi", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# One real brief in the window keeps the JSON-shape control alive, plus the row
# under test. Dates are fixed in the past so the weekday/past gates hold.
GOOD = json.dumps({"headline": "A real morning", "body": "x" * 3000})
STUB = json.dumps({"headline": "Brief failed today", "fallback": True,
                   "fallback_reason": "Slack post failed: invalid_blocks"})

def rows(gap_id):
    return [
      {"id": "recGOODbrief00001", "fields": {"Date": "2026-10-06", "Full Brief": GOOD}},
      {"id": gap_id, "fields": {"Date": "2026-10-05", "Full Brief": STUB}},
    ]
`;

describe('ceo-brief-complete acknowledged gap', () => {
  it('prints the acknowledged 5 Oct row and counts no violation', () => {
    const out = py(`${LOAD}
m.query = lambda *a, **k: rows("recwxCjRvfEaluUtX")
v, control = m.check_ceo_brief_complete("pat")
print("VIOLATIONS", len(v))
print("CONTROL", control)
`);
    expect(out).toContain('ACKNOWLEDGED 2026-10-05 recwxCjRvfEaluUtX');
    expect(out).toContain('invalid_blocks');
    expect(out).toContain('VIOLATIONS 0');
    // the control must still count the day — acknowledging is not excluding
    expect(out).toContain('CONTROL 2');
  });

  it('still fails when a DIFFERENT row carries that date', () => {
    const out = py(`${LOAD}
m.query = lambda *a, **k: rows("recSOMEotherROW01")
v, control = m.check_ceo_brief_complete("pat")
print("VIOLATIONS", len(v))
print(json.dumps(v))
`);
    expect(out).toContain('VIOLATIONS 1');
    expect(out).not.toContain('ACKNOWLEDGED');
    expect(out).toContain('recSOMEotherROW01');
  });

  it('still fails on a duplicate pair that includes the acknowledged row', () => {
    const out = py(`${LOAD}
r = rows("recwxCjRvfEaluUtX")
r.append({"id": "recDUPEonthatday1", "fields": {"Date": "2026-10-05", "Full Brief": STUB}})
m.query = lambda *a, **k: r
v, control = m.check_ceo_brief_complete("pat")
print("VIOLATIONS", len(v))
print(json.dumps(v))
`);
    // the duplicate-row violation carries TWO ids, so no acknowledgement covers it
    expect(out).toContain('2 rows for one date');
    expect(out).not.toContain('VIOLATIONS 0');
  });

  it('the acknowledgement is an exception list, not a start date', () => {
    const out = py(`${LOAD}
print(json.dumps(sorted(m.ACKNOWLEDGED_BRIEF_GAPS)))
print("HASRECORD", all("record" in e and "reason" in e and "acknowledged" in e
                       for e in m.ACKNOWLEDGED_BRIEF_GAPS.values()))
`);
    expect(out).toContain('HASRECORD True');
    expect(out).toContain('2026-10-05');
  });
});
