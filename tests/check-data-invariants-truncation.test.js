// The invariants report must never show a sample as if it were the whole set.
//
// Regression origin: 18 Oct 2026 (finding 20261018-phase-2-974). The 06:42 run
// printed "30 VIOLATION(S)" for no-reimport-duplicates and then listed 5, with
// nothing saying the list was cut. daily-ops phase 2 is told to work each failure
// from that log and raise one task per failure, so the task it raised could name
// 5 of 30. Two invariants that day had no second reader, so 25 duplicate
// transaction ids and 8 overdue hard-deadline tasks were unnameable.
//
// These tests drive the real functions out of the script, not a copy of them.
// Back-tested: dropping the "showing N of M" branch from render_report, or the
// all_violations list from write_full_violations, turns these red.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/check-data-invariants.py');

function py(code) {
  return execFileSync('python3', ['-c', code], { encoding: 'utf8', timeout: 30000 });
}

const LOAD = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("cdi", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;

// 30 violations, 5 samples — the exact shape of the 18 Oct report.
const RESULTS = `
results = [{
  "name": "no-reimport-duplicates",
  "asserts": "no transaction id appears twice",
  "status": "FAIL",
  "count": 30,
  "incident": "the 8,667-txn reimport",
  "samples": [{"id": "rec%05d" % i} for i in range(5)],
  "all_violations": [{"id": "rec%05d" % i} for i in range(30)],
}, {
  "name": "something-that-holds",
  "asserts": "nothing",
  "status": "PASS",
  "control_population": 120,
}]
`;

describe('check-data-invariants violation truncation', () => {
  it('says the printed list is cut, and where the full one lives', () => {
    const out = py(`${LOAD}${RESULTS}
print("\\n".join(m.render_report(results, "monitoring/data-invariants-2026-10-18.json", True)))
`);
    expect(out).toContain('showing 5 of 30');
    expect(out).toContain('monitoring/data-invariants-2026-10-18.json');
    // the five samples are still there — the cap exists to keep the log readable
    expect(out).toContain('rec00004');
    expect(out).not.toContain('rec00029');
  });

  it('does not claim a cut when every violation is shown', () => {
    const out = py(`${LOAD}
results = [{"name": "n", "asserts": "a", "status": "FAIL", "count": 2,
            "incident": "i", "samples": [{"id": "recA"}, {"id": "recB"}],
            "all_violations": [{"id": "recA"}, {"id": "recB"}]}]
print("\\n".join(m.render_report(results, "monitoring/x.json", True)))
`);
    expect(out).toContain('2 VIOLATION(S)');
    expect(out).not.toContain('showing');
    expect(out).not.toContain('full list of all');
  });

  it('writes every violation to the dated file, not just the samples', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdi-'));
    const rel = py(`${LOAD}${RESULTS}
print(m.write_full_violations(results, repo=${JSON.stringify(dir)}, today="2026-10-18"))
`).trim();
    expect(rel).toBe('monitoring/data-invariants-2026-10-18.json');
    const payload = JSON.parse(readFileSync(join(dir, rel), 'utf8'));
    expect(payload.failed_invariants).toHaveLength(1);
    expect(payload.failed_invariants[0].count).toBe(30);
    expect(payload.failed_invariants[0].violations).toHaveLength(30);
    expect(payload.failed_invariants[0].violations.at(-1).id).toBe('rec00029');
  });

  it('writes no file when every invariant holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdi-'));
    const out = py(`${LOAD}
print(m.write_full_violations([{"name": "n", "status": "PASS", "control_population": 9}],
                              repo=${JSON.stringify(dir)}, today="2026-10-18"))
`).trim();
    expect(out).toBe('None');
    expect(existsSync(join(dir, 'monitoring/data-invariants-2026-10-18.json'))).toBe(false);
  });
});
