// A letter's deadline must become a DATED, IMMOVABLE task — not prose.
//
// WHAT THIS IS GUARDING (findings 20260825-daily-ops-354, 20260821-ceo-huddle-271,
// 20260824-post-manager-weekly-343)
// A council tax liability hearing passed unnoticed on 24 Aug 2026. The date was
// in the letter, the letter was scanned, emailed and turned into an Airtable
// task — and every step lost it:
//
//   1. The AI summary was cut at 500 chars, so the hearing date, the amount and
//      the reference fell off the end of the description.
//   2. Due Date was hardcoded to today on every inbound task, so the real date
//      was never recorded anywhere structured.
//   3. Hard Deadline was never ticked by any inbound lane, so the browser's
//      auto-rescheduler rolled the due date forward every morning and the task
//      never once read as overdue.
//
// The functions are extracted from the real page source rather than copied, so
// this cannot pass while the shipped code says something different.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const PAGES = ['follow-up.html', 'follow-up-supabase.html'];

function source(page) {
  return readFileSync(resolve(ROOT, page), 'utf8');
}

// Pull the real function out of the page and make it callable.
function extractNormaliseDeadline(src) {
  const start = src.indexOf('function normaliseDeadline(');
  if (start < 0) throw new Error('normaliseDeadline not found');
  const end = src.indexOf('\n    }', start);
  if (end < 0) throw new Error('normaliseDeadline end not found');
  const body = src.slice(start, end + '\n    }'.length);
  return new Function(`${body}; return normaliseDeadline;`)();
}

const iso = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return d.toISOString().slice(0, 10);
};

describe.each(PAGES)('%s — inbound deadline capture', (page) => {
  const src = source(page);

  describe('normaliseDeadline', () => {
    const normalise = extractNormaliseDeadline(src);

    it('accepts a real date inside the plausible window', () => {
      expect(normalise(iso(14))).toBe(iso(14));
      expect(normalise(iso(-3))).toBe(iso(-3));
    });

    it('refuses anything that is not YYYY-MM-DD', () => {
      for (const bad of ['', null, undefined, 'none', '14 days', '2026/09/01',
                         '01-09-2026', 'next Tuesday', '2026-9-1']) {
        expect(normalise(bad)).toBe('');
      }
    });

    it('refuses a date that does not exist, which Date silently rolls over', () => {
      // new Date('2026-02-30') gives 2 March. Accepting it would put a wrong,
      // immovable date on a live task.
      expect(normalise('2026-02-30')).toBe('');
      expect(normalise('2026-13-01')).toBe('');
    });

    it('refuses a date more than a year away in either direction', () => {
      // A statutory window is days or weeks out. Anything else is the model
      // guessing, and Hard Deadline makes a guess permanent.
      expect(normalise(iso(400))).toBe('');
      expect(normalise(iso(-400))).toBe('');
      expect(normalise('2019-01-01')).toBe('');
    });
  });

  describe('the task the page actually writes', () => {
    it('uses the stated deadline as the Due Date, not today', () => {
      expect(src).toContain('[AIRTABLE_FIELDS.dueDate]: content.deadline || today');
      // The old shape hardcoded today for every inbound task.
      expect(src).not.toMatch(/AIRTABLE_FIELDS\.dueDate\]: today \}/);
    });

    it('ticks Hard Deadline whenever a deadline was found', () => {
      // Without this the auto-rescheduler moves the date forward every morning
      // and the task never reads as overdue, however close the hearing is.
      expect(src).toContain("hardDeadline: 'fldZKzIxgyrQ8CG8a'");
      expect(src).toContain('[AIRTABLE_FIELDS.hardDeadline]: true');
    });

    it('never ticks Hard Deadline without a date to go with it', () => {
      // An immovable task with no real date can never be satisfied.
      const line = src.split('\n').find(l => l.includes('AIRTABLE_FIELDS.hardDeadline]: true'));
      expect(line).toMatch(/content\.deadline \?/);
    });

    it('asks the model for the deadline and gives it today for relative windows', () => {
      expect(src).toMatch(/"deadline":/);
      expect(src).toMatch(/Today is \$\{todayIso\}/);
    });

    it('no longer cuts the summary at 500 characters', () => {
      // 500 chars is about one paragraph of a summons — the date, the amount
      // and the reference were routinely the part that got chopped.
      expect(src).toContain('const DESCRIPTION_LIMIT = 1800');
      expect(src).toMatch(/description: \(parsed\.description \|\| [^)]*\)\.substring\(0, DESCRIPTION_LIMIT\)/);
      expect(src).not.toMatch(/parsed\.description[\s\S]{0,120}substring\(0, 500\)/);
    });

    it('the AI-failure fallback still returns a deadline key', () => {
      // createAirtableTask reads content.deadline unconditionally. A fallback
      // that omitted it would read undefined and quietly skip the whole
      // mechanism on exactly the emails the model could not parse.
      const fb = src.slice(src.indexOf('AI task generation failed'));
      expect(fb.slice(0, 400)).toContain("deadline: ''");
    });
  });
});

describe('the post-manager email carries the deadline through', () => {
  const skill = readFileSync(
    resolve(ROOT, '.claude/scheduled-tasks/post-manager-weekly/SKILL.md'), 'utf8');

  it('puts a Deadline line in the email body it sends to the inbox', () => {
    // The scanned letter never reaches Airtable directly: it becomes an email,
    // and follow-up.html parses that email. Drop the line and the whole chain
    // goes quiet with nothing erroring.
    expect(skill).toContain('Deadline: YYYY-MM-DD');
  });

  it('tells the routine to resolve relative windows and never to guess', () => {
    expect(skill).toMatch(/within 14 days/);
    expect(skill).toMatch(/do NOT guess/i);
  });

  it('keeps the tier-1 rule: prepared for approval, never carried out', () => {
    expect(skill).toMatch(/MUST NOT pay anything/);
  });
});
