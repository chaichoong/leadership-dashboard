import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// The CEO brief pipeline, audited end to end on 21 Aug 2026 while reverse-
// engineering it for client onboarding (docs/ceo-brief-client-onboarding.md).
// Each block below is one finding from that audit that had no guard.
//
// Functions are parsed out of the worker by regex, the same approach as
// tests/ceo-brief-schedule.test.js, because the worker is a Cloudflare module
// with a single default export.

const WORKER = read('scripts/slack-automation/money-daily-worker.js');
const HUDDLE_PHASE = read('.claude/scheduled-tasks/ceo-huddle/SKILL.md');
// The tab's render moved into the AI Agents page on 25 Aug 2026
// (js/ceo-brief.js was deleted); the same function names and guards live on.
const TAB = read('os/agents/index.html');

function loadFn(name) {
  const m = WORKER.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`${name} not found in money-daily-worker.js`);
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return ${name};`)();
}

const ELEVEN_SEATS = ['Keller', 'Hormozi', 'Belfort', 'Wickman', 'Jenyns', 'Crabtree',
  'Cunningham', 'Lencioni', 'Kiyosaki', 'Bailey', 'DeMartini'];

describe('board flag seats match the org chart', () => {
  // Finding 2. The prompt carried seven hand-typed names, three of which were
  // not seats (Michalowicz, Peters, Martell), and told the CEO to keep only
  // flags matching its own list. Five real seats survived by luck.
  const block = WORKER.match(/const BOARD_FLAG_SEATS = \[([\s\S]*?)\];/);

  it('defines the seat list once (control)', () => {
    expect(block).not.toBeNull();
  });

  it('names all eleven department heads and nothing else', () => {
    const surnames = [...block[1].matchAll(/'([A-Za-z]+) \(/g)].map((m) => m[1]);
    expect(surnames.sort()).toEqual([...ELEVEN_SEATS].sort());
  });

  it('the prompt reads the list rather than a hand-typed copy', () => {
    expect(WORKER).toMatch(/BOARD_FLAG_SEATS\.join\(/);
    expect(WORKER).not.toMatch(/Michalowicz \(Profit First/);
    expect(WORKER).not.toMatch(/Peters \(overwhelm/);
  });

  it('the huddle phase writes flags from the same eleven seats', () => {
    for (const s of ELEVEN_SEATS) expect(HUDDLE_PHASE).toContain(s);
  });
});

describe('huddle phase writes Handed Off and skips the weekend', () => {
  // Finding 2b: the phase's write step listed three fields; the huddle skill
  // has always required Handed Off too. Finding 5: weekend huddles left
  // orphan stubs on 9 and 16 Aug 2026 that the tab reported as unfinished.
  it('step 4 names the Handed Off field id', () => {
    expect(HUDDLE_PHASE).toContain('fld9PQ10p8V4N8Y0U Handed Off');
  });
  it('step 0 stops on Saturday and Sunday', () => {
    expect(HUDDLE_PHASE).toMatch(/If it is Saturday or Sunday, stop here/);
  });
});

describe('parseIcsToday — the calendar parser', () => {
  // Finding 6. Folded lines truncated titles, SUMMARY;LANGUAGE=en dropped the
  // event entirely, and UTC stamps printed an hour early in summer.
  const parseIcsToday = loadFn('parseIcsToday');
  const today = '2026-08-21'; // a Friday in BST

  it('lists a plain local event on the day (control)', () => {
    const ics = 'BEGIN:VEVENT\nDTSTART;TZID=Europe/London:20260821T100000\nSUMMARY:Call with Mica\nEND:VEVENT\n';
    expect(parseIcsToday(ics, today)).toBe('10:00 — Call with Mica');
  });

  it('ignores other days', () => {
    const ics = 'BEGIN:VEVENT\nDTSTART:20260820T100000\nSUMMARY:Yesterday\nEND:VEVENT\n';
    expect(parseIcsToday(ics, today)).toBe('');
  });

  it('unfolds a continuation line so the title is whole', () => {
    const ics = 'BEGIN:VEVENT\nDTSTART:20260821T140000\nSUMMARY:Operations review call with a very long\r\n  title that Google folds\nEND:VEVENT\n';
    expect(parseIcsToday(ics, today)).toBe('14:00 — Operations review call with a very long title that Google folds');
  });

  it('matches SUMMARY with parameters', () => {
    const ics = 'BEGIN:VEVENT\nDTSTART:20260821T090000\nSUMMARY;LANGUAGE=en-GB:Dentist\nEND:VEVENT\n';
    expect(parseIcsToday(ics, today)).toBe('09:00 — Dentist');
  });

  it('converts a UTC stamp to London time', () => {
    const ics = 'BEGIN:VEVENT\nDTSTART:20260821T080000Z\nSUMMARY:Zoom\nEND:VEVENT\n';
    expect(parseIcsToday(ics, today)).toBe('09:00 — Zoom');
  });

  it('a UTC stamp late on the previous evening that is today in London counts as today', () => {
    const ics = 'BEGIN:VEVENT\nDTSTART:20260820T234500Z\nSUMMARY:Midnight job\nEND:VEVENT\n';
    expect(parseIcsToday(ics, today)).toBe('00:45 — Midnight job');
  });

  it('all-day events read "all day" and sort first', () => {
    const ics = 'BEGIN:VEVENT\nDTSTART;VALUE=DATE:20260821\nSUMMARY:Holiday\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20260821T110000\nSUMMARY:Later\nEND:VEVENT\n';
    expect(parseIcsToday(ics, today).split('\n')).toEqual(['11:00 — Later', 'all day — Holiday']);
  });
});

describe('dedupeHandedOff', () => {
  // Finding 13. Exact-string dedupe let "Draft X" and "draft X" both reach Kevin.
  const dedupeHandedOff = loadFn('dedupeHandedOff');
  it('keeps the first wording and drops case or spacing twins', () => {
    expect(dedupeHandedOff([
      'worker-writer — Draft the Sefton email',
      'worker-writer — draft the  Sefton email ',
      'Mica — chase the UC form',
    ])).toEqual(['worker-writer — Draft the Sefton email', 'Mica — chase the UC form']);
  });
  it('drops blanks', () => {
    expect(dedupeHandedOff(['', '  ', 'x'])).toEqual(['x']);
  });
});

describe('a failed morning still marks today as sent', () => {
  // Finding 3. Only Full Brief stops the 10:00 and 11:00 firings. A CEO-layer
  // failure sent the money-only fallback and never wrote it, so the fallback
  // (and its alert) repeated up to three times.
  it('the CEO-failure path stores a fallback marker', () => {
    const fallbackPath = WORKER.match(/catch \(ceoErr\) \{[\s\S]*?\n    \}/);
    expect(fallbackPath).not.toBeNull();
    expect(fallbackPath[0]).toContain('storeFallbackMarker(');
  });
  it('the sent-but-not-stored path retries with the marker', () => {
    const notStored = WORKER.match(/Brief sent but NOT stored[\s\S]*?\n        \}/);
    expect(notStored).not.toBeNull();
    expect(notStored[0]).toContain('storeFallbackMarker(');
  });
  it('the marker is flagged so the tab cannot call it a good morning', () => {
    expect(WORKER).toMatch(/marker\.fallback = true/);
    expect(TAB).toMatch(/function ceoBriefIsFallback/);
    expect(TAB).toMatch(/ceoBriefIsFallback\(rec\)\) return \{ status: 'fail'/);
  });
  it('alerts carry a title naming the failure', () => {
    expect(WORKER).toMatch(/alertFailure\(env, new Error\('Brief sent but NOT stored: ' \+ e\.message\), '/);
    expect(WORKER).toMatch(/alertFailure\(env, new Error\('CEO brief failed \(money DM sent as fallback\): ' \+ ceoErr\.message\), '/);
  });
});

describe('no stale defaults or local clocks', () => {
  it('QUARTER_CONTEXT has no hard-typed quarter paragraph fallback (finding 11)', () => {
    expect(WORKER).toMatch(/env\.QUARTER_CONTEXT \|\| QUARTER_CONTEXT_MISSING/);
    expect(WORKER).not.toMatch(/QUARTER_CONTEXT \|\| 'Q3 2026/);
  });
  it('the board huddle is kept inside the stored JSON (finding 7)', () => {
    expect(WORKER).toMatch(/brief\.huddle = huddle \?/);
  });
  it('isTenancyEnded uses the London date, not the runtime clock (finding 14)', () => {
    const fn = WORKER.match(/function isTenancyEnded\([\s\S]*?\n\}/)[0];
    expect(fn).toContain('todayLondonISO()');
    expect(fn).not.toMatch(/new Date\(\);/);
  });
  it('the tab decides the weekend from the London date, not getDay() (finding 8)', () => {
    expect(TAB).not.toMatch(/getDay\(\)\)/);
    expect(TAB).toMatch(/function ceoBriefIsWeekendDate/);
  });
  it('the tab prefers a finished row when a day has two (finding 9)', () => {
    expect(TAB).toMatch(/rows\.find\(ceoBriefIsComplete\) \|\| rows\[0\]/);
  });
  it('the worker header no longer claims a Mon–Fri cron (finding 12)', () => {
    expect(WORKER.split('\n').slice(0, 12).join('\n')).not.toMatch(/Cron: Mon–Fri 09:00/);
  });
});
