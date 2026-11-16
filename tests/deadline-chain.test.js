// The post Deadline enforcement chain (built 25 Aug 2026).
//
// Between 3 Jul and 24 Aug 2026 several dated legal response windows in
// scanned post closed unread: the post-manager routine put the date in its
// email, and nothing downstream ever read it. Worse, the routine's own doc
// CLAIMED a full enforcement chain existed, which stopped anyone building it.
// The chain is now real, and this file is what keeps each link attached:
//
//   post-manager email "Deadline: YYYY-MM-DD"
//     → scripts/create-agent-task.py parse_deadline_line() reads it when the
//       triage robot creates the task (Due Date = the real date, Hard Deadline
//       ticked — never rolled; covered in tests/inbound-email-triage.test.js).
//       The Inbound Comms page (follow-up.html) that parsed it for hand-made
//       tasks was removed on 15 Nov 2026.
//     → scripts/loop-health.py rule "deadline" warns from 3 days out
//       (twin-tested against os/tasks in tests/loop-health.test.js)
//     → scripts/check-data-invariants.py fails the daily sweep when a hard
//       deadline passes with the task still open.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const INVARIANTS = readFileSync(resolve(ROOT, 'scripts/check-data-invariants.py'), 'utf8');

describe('the chain is closed end to end', () => {
  it('the daily invariant exists, excludes the UC lane, and guards the date fields', () => {
    expect(INVARIANTS).toContain('"name": "hard-deadline-passed-still-open"');
    expect(INVARIANTS).toMatch(/\{Hard Deadline\} = 1, \{Due Date\}, \{Due Date\} < TODAY\(\)/);
    expect(INVARIANTS).toContain("FIND('UC verification:', {Task Name}) = 0");
  });

  it('loop-health carries the deadline rule (twin-tested elsewhere) and its control', () => {
    const py = readFileSync(resolve(ROOT, 'scripts/loop-health.py'), 'utf8');
    expect(py).toMatch(/STALL_DEADLINE_DAYS = 3/);
    expect(py).toContain('"rule": "deadline"');
    expect(py).toContain('tasks carrying Hard Deadline');
  });

  it('the triage skill mirror instructs the Due Date + Hard Deadline stamp', () => {
    const skill = readFileSync(
      resolve(ROOT, '.claude/scheduled-tasks/inbound-email-triage/SKILL.md'), 'utf8');
    expect(skill).toMatch(/Deadline: YYYY-MM-DD/);
    expect(skill).toContain('fldZKzIxgyrQ8CG8a');
  });

  it('the post-manager doc no longer claims more than exists — the chain note names real pieces', () => {
    const doc = readFileSync(
      resolve(ROOT, '.claude/scheduled-tasks/post-manager-weekly/SKILL.md'), 'utf8');
    expect(doc).not.toContain('NOT YET BUILT');
    expect(doc).toContain('hard-deadline-passed-still-open');
  });
});
