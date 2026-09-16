// ─── FINDING 20260902-ceo-agent-432 ──────────────────────────────────
//
// The 06:45 CEO slot on 2 Sep 2026 could not reconcile its own approval-queue
// count: a curl it wrote at run time returned 0 while
// scripts/agent-accuracy-report.py returned 77. It reported both numbers and
// could not say which was true.
//
// The cause was not the script. The huddle told the slot to work out "stuck
// approvals" itself — Status=Approval AND Sent For Approval By set AND created
// more than 24 hours ago — and an improvised Airtable query is the silent-zero
// trap by default: a bare date comparison, or FIND(recXXX, ARRAYJOIN({Link}))
// against a link field, each return 200 OK with an empty list, which reads as
// "nothing is stuck".
//
// The fix is to leave ONE reader of this number. The script now answers the
// stuck question too, from the SAME population as waiting_for_kevin, with age
// taken from Airtable's own createdTime rather than from a formula. The skill
// says so and says not to hand-roll it.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SCRIPT = resolve(ROOT, 'scripts/agent-accuracy-report.py');
const SKILL = resolve(ROOT, '.claude/scheduled-tasks/ceo-huddle/SKILL.md');

// Run the real function out of the real file. Copying it into the test would
// let the two drift, which is the class of bug this file is about.
function stuckOver(records, hours) {
  const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
recs = json.loads(sys.argv[1])
print(json.dumps([r["id"] for r in m.stuck_over(recs, ${hours})]))
`;
  return JSON.parse(
    execFileSync('python3', ['-c', py, JSON.stringify(records)], { encoding: 'utf8' })
  );
}

const nowIso = (hoursAgo) =>
  new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');

const rec = (id, hoursAgo, sentBy = ['recAGENT']) => ({
  id,
  createdTime: nowIso(hoursAgo),
  fields: sentBy ? { 'Task Name': id, 'Sent For Approval By': sentBy } : { 'Task Name': id },
});

describe('the huddle has ONE reader for the approval queue (finding 432)', () => {
  it('counts only what was sent for approval and has sat longer than the window', () => {
    const got = stuckOver(
      [rec('recOLD', 48), rec('recFRESH', 2), rec('recEDGE', 25)],
      24
    );
    expect(got.sort()).toEqual(['recEDGE', 'recOLD']);
  });

  it('a task nobody sent for approval is not a stuck approval', () => {
    // It is in the queue by Status alone. Counting it would inflate the number
    // the huddle raises a Board Flag on.
    expect(stuckOver([rec('recNOAGENT', 96, null)], 24)).toEqual([]);
  });

  it('is a SUBSET of the waiting population, so the two can never disagree', () => {
    const waiting = [rec('recA', 48), rec('recB', 1), rec('recC', 72)];
    const stuck = stuckOver(waiting, 24);
    expect(stuck.length).toBeLessThanOrEqual(waiting.length);
    for (const id of stuck) expect(waiting.map((r) => r.id)).toContain(id);
  });

  it('an unreadable createdTime is COUNTED, never silently treated as fresh', () => {
    const bad = { id: 'recBAD', createdTime: '', fields: { 'Sent For Approval By': ['recX'] } };
    expect(stuckOver([bad], 24)).toEqual(['recBAD']);
  });

  it('an empty queue returns an empty list rather than throwing', () => {
    expect(stuckOver([], 24)).toEqual([]);
  });

  it('the script prints both numbers together, so a zero is always zero-of-N', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('Waiting for Kevin right now');
    expect(src).toContain('Of those, stuck over');
    expect(src).toContain('"stuck_over_hours"');
  });

  it('the huddle skill points at the script and forbids a hand-rolled curl', () => {
    const skill = readFileSync(SKILL, 'utf8');
    expect(skill).toContain('agent-accuracy-report.py --json');
    expect(skill).toMatch(/Do not hand-roll a curl for this number/i);
    expect(skill).toContain('20260902-ceo-agent-432');
    // The old instruction described the query in enough detail to invite one.
    expect(skill).not.toContain("Tasks where `{Status}='Approval'` AND Sent For Approval By");
  });
});
