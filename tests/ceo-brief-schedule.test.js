import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// The 09:00 CEO brief trigger — money-daily-worker.js.
//
// TWO bugs are guarded here, both found by the ceo-brief-morning-check routine.
//
// 1. (3 Aug 2026) The worker's header said "Cron: Mon–Fri 09:00 Europe/London",
//    but the gate only ever checked the hour. Two UTC crons fire so that one of
//    them lands on 09:00 London in both BST and GMT — and with no weekday test,
//    they kept landing at the weekend too. Sunday 2 Aug 2026 DM'd a full brief.
//
// 2. (7 Aug 2026) The trigger was TIME-shaped and had no redundancy. Exactly one
//    of the two crons could pass per day, and the gate accepted only a ten-minute
//    slot (`hour === 9 && minute <= 10`). One missed or late firing therefore meant
//    NO brief and NO alarm: alertFailure only runs on a thrown error, and an early
//    return throws nothing. Kevin got no brief on Fri 7 Aug and nothing complained.
//
//    The fix makes it STATE-shaped: a wide weekday window (09:00–11:59 London), a
//    cron that fires hourly across it, and alreadyBriefedToday() to deduplicate.
//    Both halves are required — widening the window without the idempotency check
//    would send Kevin three briefs a morning, so both are tested below.
//
// Parsing the functions out by regex rather than importing them: the worker is a
// Cloudflare module with a single `export default` and these are internal to it.
// The alternative is a test-only export on production code. Same approach as
// tests/constant-drift.test.js, which reads this same worker as text.

const WORKER = read('scripts/slack-automation/money-daily-worker.js');
const TOML = read('scripts/slack-automation/wrangler.money-daily.toml');

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

// The real cron hours, read from the toml rather than hardcoded here, so widening
// or narrowing the schedule cannot silently diverge from what this file asserts.
function cronExprs() {
  const m = TOML.match(/crons\s*=\s*\[([^\]]*)\]/);
  if (!m) throw new Error('no crons array in wrangler.money-daily.toml');
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function cronUtcHours() {
  const hours = new Set();
  for (const c of cronExprs()) {
    const field = c.trim().split(/\s+/)[1];
    for (const part of field.split(',')) {
      const [range, step] = part.split('/');
      const [a, b] = range === '*' ? [0, 23] : range.split('-').map(Number);
      const hi = b === undefined ? a : b;
      for (let h = a; h <= hi; h += Number(step || 1)) hours.add(h);
    }
  }
  return [...hours].sort((x, y) => x - y);
}

describe('CEO brief send window', () => {

  // CONTROL — a regex that stops matching returns a function that throws, not a
  // silent pass. But a gate that returned `false` for everything would also pass
  // every "does not fire" assertion below while quietly killing the brief.
  it('fires on an ordinary weekday morning (control — guards against an always-false gate)', () => {
    expect(at('2026-08-03T08:00:00Z')).toBe(true); // Mon 3 Aug, 09:00 London (BST)
  });

  it('does NOT fire at the weekend — the 2 Aug 2026 bug', () => {
    expect(at('2026-08-02T08:00:00Z')).toBe(false); // Sun 2 Aug, 09:00 London
    expect(at('2026-08-01T08:00:00Z')).toBe(false); // Sat 1 Aug, 09:00 London
  });

  it('still refuses the weekend in GMT', () => {
    expect(at('2026-01-04T09:00:00Z')).toBe(false); // Sun, 09:00 London
    expect(at('2026-01-03T09:00:00Z')).toBe(false); // Sat, 09:00 London
  });

  // THE 7 AUG 2026 REGRESSION. The old gate was `hour === 9 && minute <= 10`, so
  // this exact assertion used to read `.toBe(false)` — the bug, written down as a
  // test. A firing delayed past 09:10 was silently discarded and Kevin got nothing.
  it('accepts a firing delayed past 09:10 — the 7 Aug 2026 bug', () => {
    expect(at('2026-08-03T08:11:00Z')).toBe(true); // Mon, 09:11 London
    expect(at('2026-08-03T09:00:00Z')).toBe(true); // Mon, 10:00 London
    expect(at('2026-08-03T10:30:00Z')).toBe(true); // Mon, 11:30 London
  });

  it('closes the window outside the London morning', () => {
    expect(at('2026-08-03T07:00:00Z')).toBe(false); // Mon, 08:00 London — too early
    expect(at('2026-08-03T11:00:00Z')).toBe(false); // Mon, 12:00 London — too late
  });

  it('covers the morning in GMT too', () => {
    expect(at('2026-01-05T08:00:00Z')).toBe(false); // Mon, 08:00 London — too early
    expect(at('2026-01-05T09:00:00Z')).toBe(true);  // Mon, 09:00 London
    expect(at('2026-01-05T11:00:00Z')).toBe(true);  // Mon, 11:00 London
    expect(at('2026-01-05T12:00:00Z')).toBe(false); // Mon, 12:00 London — too late
  });

  // The invariant the individual cases are examples of. Runs the REAL crons against
  // every day of 2026, so the DST changeovers (29 Mar, 25 Oct) are covered without
  // anyone remembering to hand-write them.
  //
  // Note this asserts AT LEAST TWO chances per weekday, not exactly one. Redundancy
  // is the point of the fix; duplicate sends are prevented by alreadyBriefedToday(),
  // which is tested separately below.
  it('gives every weekday multiple chances and the weekend none, all year', () => {
    const wrong = [];
    let weekdaysChecked = 0;
    const hours = cronUtcHours();

    for (let d = new Date('2026-01-01T00:00:00Z'); d.getUTCFullYear() === 2026; d.setUTCDate(d.getUTCDate() + 1)) {
      const ymd = d.toISOString().slice(0, 10);
      const fires = hours.filter((h) => at(`${ymd}T${String(h).padStart(2, '0')}:00:00Z`)).length;
      const day = d.getUTCDay(); // these firings are never near a London date boundary
      const isWeekday = day >= 1 && day <= 5;
      if (isWeekday) weekdaysChecked++;
      const ok = isWeekday ? fires >= 2 : fires === 0;
      if (!ok) wrong.push(`${londonLabel(`${ymd}T${String(hours[0]).padStart(2, '0')}:00:00Z`)} → ${fires} chance(s)`);
    }

    expect(weekdaysChecked).toBeGreaterThan(250); // control: the loop actually ran
    expect(wrong).toEqual([]);
  });
});

// The deduplication half. Without this, the wider window above means Kevin gets a
// brief every hour from 09:00 to 12:00.
describe('CEO brief idempotency (alreadyBriefedToday)', () => {
  const FULL_BRIEF_ID = (WORKER.match(/ceoFullBrief:\s*'([^']+)'/) || [])[1];

  it('reads the real Full Brief field id (control — a renamed constant must fail here)', () => {
    expect(FULL_BRIEF_ID).toMatch(/^fld\w+$/);
  });

  // Builds the real function with stubbed collaborators, and records the URL it
  // requested so the returnFieldsByFieldId trap can be asserted on.
  function load(response) {
    const m = WORKER.match(/async function alreadyBriefedToday\([\s\S]*?\n\}/);
    if (!m) throw new Error('alreadyBriefedToday not found in money-daily-worker.js');
    const calls = [];
    const stubFetch = async (url) => { calls.push(url); return response; };
    const src = `
      const BASE_ID = 'appTEST';
      const TBL_BRIEFS = 'tblTEST';
      const F = { ceoFullBrief: ${JSON.stringify(FULL_BRIEF_ID)} };
      const getField = (rec, id) => rec.fields?.[id];
      function todayLondonISO() {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
      }
      ${m[0]};
      return alreadyBriefedToday;
    `;
    // eslint-disable-next-line no-new-func
    return { fn: new Function('fetch', src)(stubFetch), calls };
  }

  const ok = (records) => ({ ok: true, json: async () => ({ records }) });

  it('says YES when today\'s brief is already populated — stops the duplicate', async () => {
    const { fn } = load(ok([{ id: 'rec1', fields: { [FULL_BRIEF_ID]: '{"one_thing":"..."}' } }]));
    expect(await fn('pat')).toBe(true);
  });

  // The 07:30 huddle creates a stub row with no Full Brief. Treating "a row exists"
  // as sent would suppress the brief every single day — a worse bug than the one
  // being fixed, and an easy one to introduce here.
  it('says NO when only the 07:30 huddle stub exists', async () => {
    const { fn } = load(ok([{ id: 'rec1', fields: { fldOther: 'huddle output' } }]));
    expect(await fn('pat')).toBe(false);
  });

  it('says NO when Full Brief is present but blank', async () => {
    const { fn } = load(ok([{ id: 'rec1', fields: { [FULL_BRIEF_ID]: '   ' } }]));
    expect(await fn('pat')).toBe(false);
  });

  it('says NO when there is no row for today — the missed-cron recovery path', async () => {
    const { fn } = load(ok([]));
    expect(await fn('pat')).toBe(false);
  });

  // Fail-OPEN on purpose. If Airtable is unreachable we cannot know, and a
  // duplicate brief is a minor annoyance whereas a missing one is the whole bug.
  it('says NO when Airtable errors — fails open so the brief still goes', async () => {
    const { fn } = load({ ok: false, json: async () => ({}) });
    expect(await fn('pat')).toBe(false);
  });

  it('says NO when the fetch throws', async () => {
    const m = WORKER.match(/async function alreadyBriefedToday\([\s\S]*?\n\}/);
    const src = `
      const BASE_ID = 'a'; const TBL_BRIEFS = 't';
      const F = { ceoFullBrief: 'fldX' };
      const getField = (rec, id) => rec.fields?.[id];
      function todayLondonISO() { return '2026-08-07'; }
      ${m[0]}; return alreadyBriefedToday;
    `;
    // eslint-disable-next-line no-new-func
    const fn = new Function('fetch', src)(async () => { throw new Error('network'); });
    expect(await fn('pat')).toBe(false);
  });

  // returnFieldsByFieldId is the documented anti-pattern in CLAUDE.md: without it
  // Airtable keys the response by field NAME, every getField returns undefined, and
  // this function would report "not sent" every day — silently restoring duplicates.
  it('queries by field id and filters to today with DATESTR', async () => {
    const { fn, calls } = load(ok([]));
    await fn('pat');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('returnFieldsByFieldId=true');
    expect(decodeURIComponent(calls[0])).toContain('DATESTR({Date})=');
  });
});

// The other half of the original 3 Aug bug, and the more expensive half.
//
// The crons were "0 8 * * 1-5" / "0 9 * * 1-5" and every human who read them saw
// Mon–Fri. Cloudflare ran them Sun–Thu: its day-of-week field starts the week at
// Sunday = 1. Measured via workersInvocationsAdaptive over 27 Jul – 3 Aug 2026 —
// zero invocations on Sat 1 Aug, a full pair on Sun 2 Aug, no 08:00 firing on
// Fri 31 Jul. Kevin lost every Friday brief and gained a Sunday one, and because
// a brief still turned up most mornings nothing looked broken.
//
// The fix is to stop expressing the day in cron at all. These assertions keep it
// that way: the schedule fires daily, and isLondonSendTime() — tested above
// against a real calendar — owns the day.
describe('CEO brief cron schedule', () => {

  it('parses the crons (control — guards against a vacuous pass)', () => {
    expect(cronExprs().length).toBeGreaterThan(0);
    expect(cronUtcHours().length).toBeGreaterThan(0);
  });

  it('fires every day, leaving the weekday rule to the code', () => {
    for (const c of cronExprs()) {
      const dayOfWeek = c.trim().split(/\s+/)[4];
      // A day-of-week filter here is ambiguous across schedulers. That ambiguity
      // is what ate the Friday brief. Keep it "*" and let the tested gate decide.
      expect(dayOfWeek, `cron "${c}" filters by day-of-week; the code owns the day`).toBe('*');
    }
  });

  // The redundancy the 7 Aug fix depends on. One firing per day is what made a
  // single missed cron fatal, so assert there is more than one chance — and that
  // the schedule still reaches 09:00 London in BST (08:00 UTC) and GMT (09:00 UTC).
  it('gives the London morning several firings, in both BST and GMT', () => {
    const hours = cronUtcHours();
    expect(hours.length).toBeGreaterThanOrEqual(3);
    expect(hours).toContain(8); // 09:00 London in BST
    expect(hours).toContain(9); // 09:00 London in GMT
  });
});
