import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// The 09:00 CEO brief gate — money-daily-worker.js `isLondonSendTime`.
//
// The bug this guards against (found 3 Aug 2026 by the ceo-brief-morning-check task):
// the worker's own header said "Cron: Mon–Fri 09:00 Europe/London", but the gate only
// ever checked the hour. Two UTC crons fire (08:00 + 09:00) so that one of them lands
// on 09:00 London in both BST and GMT — and with no weekday test, they kept landing at
// the weekend too. Sunday 2 Aug 2026 generated and DM'd a full brief. It read as normal
// output, so nothing complained.
//
// The gate is the whole schedule. It decides both "is this the right hour" (the DST
// half) and "is this a working day" (the half that was missing), so both belong here.
//
// Parsing the function out by regex rather than importing it: the worker is a Cloudflare
// module with a single `export default`, and `isLondonSendTime` is internal to it. The
// alternative is a test-only export on production code. Same approach as
// tests/constant-drift.test.js, which reads this same worker as text.

const WORKER = read('scripts/slack-automation/money-daily-worker.js');

function loadGate() {
  const m = WORKER.match(/function isLondonSendTime\([\s\S]*?\n\}/);
  if (!m) throw new Error('isLondonSendTime not found in money-daily-worker.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return isLondonSendTime;`)();
}

const isLondonSendTime = loadGate();
const at = (iso) => isLondonSendTime(new Date(iso));

// London day names for readable failures, read in London rather than assumed.
const londonLabel = (iso) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(iso));

describe('CEO brief send gate', () => {

  // CONTROL — a regex that stops matching returns a function that throws, not a silent
  // pass. But a gate that returned `false` for everything would also pass every "does
  // not fire" assertion below while quietly killing the brief. Prove it fires at all.
  it('fires on an ordinary weekday morning (control — guards against an always-false gate)', () => {
    expect(at('2026-08-03T08:00:00Z')).toBe(true); // Mon 3 Aug, 09:00 London (BST)
  });

  it('does NOT fire at the weekend — the 2 Aug 2026 bug', () => {
    expect(at('2026-08-02T08:00:00Z')).toBe(false); // Sun 2 Aug, 09:00 London
    expect(at('2026-08-01T08:00:00Z')).toBe(false); // Sat 1 Aug, 09:00 London
  });

  it('fires at 09:00 London in BST, not at the other cron', () => {
    expect(at('2026-07-31T08:00:00Z')).toBe(true);  // Fri, 09:00 London
    expect(at('2026-07-31T09:00:00Z')).toBe(false); // Fri, 10:00 London
  });

  it('fires at 09:00 London in GMT, not at the other cron', () => {
    expect(at('2026-01-05T09:00:00Z')).toBe(true);  // Mon, 09:00 London
    expect(at('2026-01-05T08:00:00Z')).toBe(false); // Mon, 08:00 London
  });

  it('still refuses the weekend in GMT', () => {
    expect(at('2026-01-04T09:00:00Z')).toBe(false); // Sun, 09:00 London
    expect(at('2026-01-03T09:00:00Z')).toBe(false); // Sat, 09:00 London
  });

  it('tolerates a late cron start but not a wandering one', () => {
    expect(at('2026-08-03T08:10:00Z')).toBe(true);  // Mon, 09:10 London
    expect(at('2026-08-03T08:11:00Z')).toBe(false); // Mon, 09:11 London
  });

  // The invariant the individual cases are examples of. Runs both real crons against
  // every day of 2026, so the DST changeovers (29 Mar, 25 Oct) are covered without
  // anyone remembering to hand-write them.
  it('sends exactly one brief per weekday and none at the weekend, all year', () => {
    const wrong = [];
    let weekdaysChecked = 0;

    for (let d = new Date('2026-01-01T00:00:00Z'); d.getUTCFullYear() === 2026; d.setUTCDate(d.getUTCDate() + 1)) {
      const ymd = d.toISOString().slice(0, 10);
      const fires = ['08:00', '09:00'].filter((hhmm) => at(`${ymd}T${hhmm}:00Z`)).length;
      const day = d.getUTCDay(); // 08:00Z/09:00Z are never near a London date boundary
      const isWeekday = day >= 1 && day <= 5;
      if (isWeekday) weekdaysChecked++;
      const expected = isWeekday ? 1 : 0;
      if (fires !== expected) wrong.push(`${londonLabel(`${ymd}T08:00:00Z`)} → ${fires} send(s), expected ${expected}`);
    }

    expect(weekdaysChecked).toBeGreaterThan(250); // control: the loop actually ran
    expect(wrong).toEqual([]);
  });
});

// The other half of the same bug, and the more expensive half.
//
// The crons were "0 8 * * 1-5" / "0 9 * * 1-5" and every human who read them saw
// Mon–Fri. Cloudflare ran them Sun–Thu: its day-of-week field starts the week at
// Sunday = 1. Measured via workersInvocationsAdaptive over 27 Jul – 3 Aug 2026 —
// zero invocations on Sat 1 Aug, a full pair on Sun 2 Aug, no 08:00 firing on
// Fri 31 Jul. Kevin lost every Friday brief and gained a Sunday one, and because
// a brief still turned up most mornings nothing looked broken.
//
// The fix is to stop expressing the day in cron at all. These assertions keep it
// that way: the schedule fires daily, and isLondonSendTime() — which is tested
// above against a real calendar — owns the day.
describe('CEO brief cron schedule', () => {
  const TOML = read('scripts/slack-automation/wrangler.money-daily.toml');

  function crons() {
    const m = TOML.match(/crons\s*=\s*\[([^\]]*)\]/);
    if (!m) throw new Error('no crons array in wrangler.money-daily.toml');
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  }

  it('parses the crons (control — guards against a vacuous pass)', () => {
    expect(crons()).toHaveLength(2);
  });

  it('fires both DST crons every day, leaving the weekday rule to the code', () => {
    for (const c of crons()) {
      const dayOfWeek = c.trim().split(/\s+/)[4];
      // A day-of-week filter here is ambiguous across schedulers. That ambiguity
      // is what ate the Friday brief. Keep it "*" and let the tested gate decide.
      expect(dayOfWeek, `cron "${c}" filters by day-of-week; the code owns the day`).toBe('*');
    }
  });

  it('still covers 09:00 London in both BST and GMT', () => {
    expect(crons().map((c) => c.trim().split(/\s+/).slice(0, 2).join(' ')).sort())
      .toEqual(['0 8', '0 9']);
  });
});
