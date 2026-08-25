// The post Deadline enforcement chain (built 25 Aug 2026).
//
// Between 3 Jul and 24 Aug 2026 several dated legal response windows in
// scanned post closed unread: the post-manager routine put the date in its
// email, and nothing downstream ever read it. Worse, the routine's own doc
// CLAIMED a full enforcement chain existed, which stopped anyone building it.
// The chain is now real, and this file is what keeps each link attached:
//
//   post-manager email "Deadline: YYYY-MM-DD"
//     → follow-up.html / follow-up-supabase.html parse it on task creation
//       (Due Date = the real date, Hard Deadline ticked — never rolled)
//     → scripts/loop-health.py rule "deadline" warns from 3 days out
//       (twin-tested against os/tasks in tests/loop-health.test.js)
//     → scripts/check-data-invariants.py fails the daily sweep when a hard
//       deadline passes with the task still open.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const FOLLOWUP = readFileSync(resolve(ROOT, 'follow-up.html'), 'utf8');
const TWIN = readFileSync(resolve(ROOT, 'follow-up-supabase.html'), 'utf8');
const INVARIANTS = readFileSync(resolve(ROOT, 'scripts/check-data-invariants.py'), 'utf8');

// Extract the REAL function (the tests/follow-up-init-errors pattern) so this
// can never pass against a stale copy.
function extract(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`could not parse ${name}`);
}

// eslint-disable-next-line no-new-func
const parseDeadlineLine = new Function(
  `${extract(FOLLOWUP, 'parseDeadlineLine')}; return parseDeadlineLine;`
)();

describe('parseDeadlineLine (real source from follow-up.html)', () => {
  it('lifts the date from the post-manager format, anywhere in the body', () => {
    expect(parseDeadlineLine('Sender: X\nSummary: Y\nDeadline: 2026-09-04\n\nThe PDF is attached.'))
      .toBe('2026-09-04');
    expect(parseDeadlineLine('deadline: 2026-09-04')).toBe('2026-09-04'); // case-insensitive
    expect(parseDeadlineLine('  Deadline:   2026-09-04  ')).toBe('2026-09-04');
  });

  it('returns null for no line, "none", and dates that only look like dates', () => {
    expect(parseDeadlineLine('no deadline mentioned here')).toBeNull();
    expect(parseDeadlineLine('Deadline: none')).toBeNull();
    expect(parseDeadlineLine('Deadline: 2026-13-45')).toBeNull();   // not a real date
    expect(parseDeadlineLine('Deadline: soon')).toBeNull();
    expect(parseDeadlineLine('')).toBeNull();
    expect(parseDeadlineLine(null)).toBeNull();
    // Mid-sentence mentions are prose, not the structured line.
    expect(parseDeadlineLine('the Deadline: 2026-09-04 was mentioned in passing')).toBeNull();
  });
});

describe('task creation carries the date (both twins)', () => {
  // The twin writes to the SAME Airtable base; a stale copy there mints
  // undated tasks for the same letters.
  for (const [label, src] of [['follow-up.html', FOLLOWUP], ['follow-up-supabase.html', TWIN]]) {
    it(`${label}: parses the body, sets Due Date to the letter date, ticks Hard Deadline`, () => {
      expect(src).toContain('function parseDeadlineLine');
      expect(src).toContain("hardDeadline: 'fldZKzIxgyrQ8CG8a'");
      expect(src).toMatch(/\[AIRTABLE_FIELDS\.dueDate\]: letterDeadline \|\| today/);
      expect(src).toMatch(/letterDeadline \? \{ \[AIRTABLE_FIELDS\.hardDeadline\]: true \}/);
      // Visible to the assignee, not only machine-readable.
      expect(src).toContain('DEADLINE FROM THE LETTER: ');
    });
  }

  it('the two parsers are byte-identical', () => {
    expect(extract(TWIN, 'parseDeadlineLine')).toBe(extract(FOLLOWUP, 'parseDeadlineLine'));
  });
});

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
