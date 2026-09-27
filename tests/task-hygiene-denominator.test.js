import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SWEEP = resolve(ROOT, 'scripts/task-hygiene-sweep.py');

// 20260816-task-hygiene-sweep-183.
//
// The compliance score is clean tasks over LIVE work, and Approval-status
// tasks are deliberately excluded from live work — they are waiting on Kevin,
// not being worked. So every task an agent sends for approval LEAVES the
// denominator and the percentage rises without a single field being filled.
// The sweep reported that rise as progress.
//
// Real numbers, from the worklists on disk: 14 Aug 217... no — 14 Aug had 251
// live tasks at 95.2% and 29 waiting on Kevin; 16 Aug had 217 at 97.7% and 74
// waiting. Live work fell 34 while the approval queue grew 45, and only 14
// tasks were genuinely completed in between (verified against Airtable Tasks
// on 22 Aug 2026). The sweep called that a 2.5-point improvement.
//
// Runs the real functions out of the script, so the assertions are against
// shipping code rather than a copy of it.
function denom({ open, waiting, completions, prev }) {
  const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('ths', ${JSON.stringify(SWEEP)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
records = [{"fields": {m.fname("completionDate"): d}} for d in ${JSON.stringify(completions)}]
prev = ${JSON.stringify(prev)}
print('@@@' + json.dumps(m.denominator_check(${open}, ${waiting}, records, prev)))
`;
  const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  return JSON.parse(out.slice(out.indexOf('@@@') + 3));
}

const aug14 = { openTasks: 251, generatedAt: '2026-08-14T02:31:00', excluded: { waitingApproval: 29 } };

describe('task hygiene — the compliance denominator cannot shrink unnoticed', () => {

  it('fires on the real 14 -> 16 Aug fall, which the sweep reported as progress', () => {
    // 14 real completions against a fall of 34.
    const r = denom({
      open: 217, waiting: 74,
      completions: Array(14).fill('2026-08-15'),
      prev: aug14,
    });
    expect(r.droppedBy).toBe(34);
    expect(r.droppedPct).toBeCloseTo(13.5, 1);
    expect(r.completedSince).toBe(14);
    expect(r.unexplained).toBe(20);
    expect(r.reconciles, 'a 34-task fall against 14 completions read as fine').toBe(false);
  });

  it('names the approval queue growth, because that is where the work went', () => {
    const r = denom({ open: 217, waiting: 74, completions: [], prev: aug14 });
    expect(r.approvalQueueGrowth).toBe(45);
  });

  it('passes when the fall IS the completed work', () => {
    const r = denom({
      open: 217, waiting: 29,
      completions: Array(34).fill('2026-08-15'),
      prev: aug14,
    });
    expect(r.reconciles).toBe(true);
    expect(r.unexplained).toBeLessThanOrEqual(0);
  });

  it('a small fall is not an alarm — daily noise is not a regression', () => {
    const r = denom({ open: 245, waiting: 30, completions: [], prev: aug14 });
    expect(r.reconciles).toBe(true);
    expect(r.droppedPct).toBeLessThan(10);
  });

  it('growing live work can never alarm — it cannot flatter the score', () => {
    const r = denom({ open: 300, waiting: 29, completions: [], prev: aug14 });
    expect(r.reconciles).toBe(true);
  });

  it('the first ever run has nothing to compare and says so, rather than passing blind', () => {
    const r = denom({ open: 217, waiting: 74, completions: [], prev: null });
    expect(r.previous).toBeNull();
    expect(r.note).toMatch(/no earlier worklist/);
  });

  it('completions are counted off the FULL record set, not the gap list', () => {
    // The report's recentlyCompleted list holds only completed tasks WITH field
    // gaps. Counting finished work from it understates it and would alarm on
    // healthy days — on 16 Aug that list held zero completions since 14 Aug
    // while Airtable held 14.
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('ths', ${JSON.stringify(SWEEP)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
recs = [{"fields": {m.fname("completionDate"): "2026-08-15T09:00:00.000Z"}},
        {"fields": {m.fname("completionDate"): "2026-08-13"}},
        {"fields": {}}]
print('@@@' + json.dumps({"since14": m.completed_since(recs, "2026-08-14"),
                          "noSince": m.completed_since(recs, "")}))
`;
    const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
    const r = JSON.parse(out.slice(out.indexOf('@@@') + 3));
    expect(r.since14).toBe(1);
    expect(r.noSince).toBe(0);
  });

  it('the audit prints compliance and the approval queue as a pair, never alone', () => {
    const src = execFileSync('cat', [SWEEP], { encoding: 'utf8' });
    const line = src.match(/print\(f"Live work:[\s\S]{0,220}/);
    expect(line, 'the compliance print line moved').toBeTruthy();
    expect(line[0]).toMatch(/waiting on Kevin/);
  });

  it('an unreconciled fall exits non-zero — a better percentage is not a pass', () => {
    const src = execFileSync('cat', [SWEEP], { encoding: 'utf8' });
    const audit = src.slice(src.indexOf('def cmd_audit('));
    expect(audit).toMatch(/reconciles"\) is False/);
    expect(audit).toMatch(/return 2/);
  });
});
