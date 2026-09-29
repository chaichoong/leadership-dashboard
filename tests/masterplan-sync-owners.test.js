import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── THE PLAN SYNC NEVER ROUTES WORK TO SOMEONE WHO TAKES NONE (29 Sep 2026) ──
//
// The nightly sync pushes every open, dated, ref-less MASTER-PLAN.md line to
// Airtable with the lane's owner as Assignee. Its owner map still held Mica
// (no work routed since 25 Aug 2026) and Ericamae (left 17 Sep 2026), so a new
// plan line written in either lane would have become a task assigned to them.
// These tests drive the real selection function on a throwaway plan.
//
// Back-test: SYNC_SCRIPT=<a copy with "MICA" and "ERICAMAE" put back in
// OWNERS and removed from RETIRED_LANES> npx vitest run this file — the
// "never pushed" and "flagged" tests fail.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SYNC = process.env.SYNC_SCRIPT || resolve(ROOT, 'scripts/sync-master-plan.py');

const PLAN = [
  '# Plan',
  '- [ ] KEVIN — Kevin line (due 20 Oct)',
  '- [ ] OPUS — AI line (due 21 Oct)',
  '- [ ] MICA — Mica line (due 22 Oct)',
  '- [ ] ERICAMAE — Ericamae line (due 23 Oct)',
  '- [ ] MICA+KEVIN — Mica-first shared line (due 24 Oct)',
  '- [ ] ERICAMAE — Marked no-task line (due 25 Oct) [AT:-]',
  '- [x] ERICAMAE — Done line (due 26 Oct)',
].join('\n');

function select() {
  const dir = mkdtempSync(join(tmpdir(), 'plan-sync-owners-'));
  const plan = join(dir, 'MASTER-PLAN.md');
  writeFileSync(plan, PLAN + '\n');
  const script = `
import importlib.util, json, sys
sys.argv = ['sync', '--dry-run']
spec = importlib.util.spec_from_file_location('s', ${JSON.stringify(SYNC)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
lines, tasks = m.parse_plan(${JSON.stringify(plan)})
creatable, flags = m.creatable_lines(lines, tasks)
print(json.dumps({"lanes": [t["lane"] for t in creatable],
                  "bodies": [t["body"] for t in creatable],
                  "owners": sorted(m.OWNERS), "flags": flags}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

describe('master-plan sync owners', () => {
  const r = select();

  it('still pushes Kevin and AI lines (control — guards a vacuous pass)', () => {
    expect(r.lanes).toEqual(['KEVIN', 'OPUS']);
  });

  it('never pushes a Mica or Ericamae line to Airtable', () => {
    for (const b of r.bodies) {
      expect(b).not.toMatch(/Mica|Ericamae/);
    }
    expect(r.owners).not.toContain('MICA');
    expect(r.owners).not.toContain('ERICAMAE');
  });

  it('flags each held-back line so it gets re-owned', () => {
    expect(r.flags).toHaveLength(3);
    expect(r.flags.join('\n')).toMatch(/Mica line/);
    expect(r.flags.join('\n')).toMatch(/Ericamae line/);
    expect(r.flags.join('\n')).toMatch(/Mica-first shared line/);
  });

  it('leaves [AT:-] and done lines alone', () => {
    expect(r.flags.join('\n')).not.toMatch(/Marked no-task|Done line/);
  });
});
