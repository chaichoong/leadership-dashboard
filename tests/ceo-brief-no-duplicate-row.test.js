import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = readFileSync(resolve(ROOT, 'scripts/slack-automation/money-daily-worker.js'), 'utf8');

// ONE DATE, ONE CEO BRIEF ROW (30 Sep 2026, found by the daily ceo-brief-complete check).
//
// 31 Jul 2026 produced two rows for one date. The cause recorded then was a missing
// `returnFieldsByFieldId` in gatherHuddle, which made it return null every day; the null meant
// storeBrief had no recordId, and no recordId sent it down the POST branch. The query parameter
// was fixed. The CONFLATION was not: storeBrief still decided PATCH-or-POST from whether the
// HUDDLE had something to say, which is a different question from whether today's ROW exists.
//
// gatherHuddle returns null on four routes, and a row for today can exist on all four:
//   1. the Airtable read came back not-ok (rate limit, transient 5xx)
//   2. every row for today already carries a Full Brief (the worker already ran)
//   3. the 07:30 stub exists but holds neither One Thing nor Board Flags
//   4. anything inside it threw
// Route 3 is the likeliest explanation for 30 Sep: a stub with both fields empty.
//
// So these tests drive the REAL functions with a stubbed fetch and assert on the HTTP method and
// body the worker would actually send. They are not greps: deleting the fix makes them fail.
// Back-tested by restoring `const usePatch = Boolean(huddle && huddle.recordId)`, which turns
// every "exists" case below red.

const F_FULL_BRIEF = 'fldPkiaWvmYAoyHEl';   // F.ceoFullBrief, as the worker writes it
const F_DATE = 'fldzLwBd3Mjg7rDxM';         // F.ceoDate

function isFallbackBriefSrc() {
  const m = WORKER.match(/const isFallbackBrief = \(raw\) => \{[\s\S]*?\n\};/);
  if (!m) throw new Error('isFallbackBrief not found in money-daily-worker.js');
  return m[0];
}

function slice(name) {
  const m = WORKER.match(new RegExp(`async function ${name}\\(pat[\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`${name} not found in money-daily-worker.js`);
  return m[0];
}

/**
 * Builds the two functions under test against a stubbed fetch, and records every call.
 * `rowsForToday` is what Airtable answers the date lookup with; `readOk` false makes that
 * read fail so the "cannot tell" path runs.
 */
function harness({ rowsForToday = [], readOk = true } = {}) {
  const calls = [];
  const logs = [];
  const fetchStub = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if ((opts.method || 'GET') === 'GET') {
      if (!readOk) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ records: rowsForToday }) };
    }
    return { ok: true, status: 200, json: async () => ({ records: [{ id: 'recWritten' }] }) };
  };
  // eslint-disable-next-line no-new-func
  const build = new Function('fetch', 'getField', 'todayLondonISO', 'BASE_ID', 'TBL_BRIEFS', 'F', 'console', `
    ${isFallbackBriefSrc()}
    ${slice('findTodayBriefRow')}
    ${slice('storeBrief')}
    ${slice('storeFallbackMarker')}
    return { findTodayBriefRow, storeBrief, storeFallbackMarker };
  `);
  const fns = build(
    fetchStub,
    (rec, id) => rec.fields?.[id],
    () => '2026-09-30',
    'appTEST',
    'tblBRIEFS',
    { ceoDate: F_DATE, ceoOneThing: 'f1', ceoFirstStep: 'f2', ceoWhy: 'f3', ceoIgnoreToday: 'f4',
      ceoBoardFlags: 'f5', ceoHandedOff: 'f6', ceoMoneyLight: 'f7', ceoSafeToAct: 'f8',
      ceoFullBrief: F_FULL_BRIEF, ceoSourceStats: 'f9' },
    { error: (...a) => logs.push(a.join(' ')) },
  );
  return { ...fns, calls, logs };
}

const BRIEF = {
  one_thing: 'one thing', first_step: 'first step', why: 'why',
  ignore: [], flags: [], handed_off: [],
};
const MONEY = { light: 'green', safeToActToday: 1234.5 };
const TASKS = { counts: {} };

const store = (h, huddle) => h.storeBrief('pat', BRIEF, MONEY, TASKS, huddle);
const writes = (h) => h.calls.filter(c => c.method !== 'GET');

const stub = (id, extra = {}) => ({ id, fields: { [F_DATE]: '2026-09-30', ...extra } });
const finished = (id) => stub(id, { [F_FULL_BRIEF]: '{"one_thing":"done"}' });

describe('one date, one CEO brief row', () => {
  it('patches the existing row when the huddle said nothing (route 3: an empty 07:30 stub)', async () => {
    const h = harness({ rowsForToday: [stub('recStub')] });
    await store(h, null);
    const w = writes(h);
    expect(w).toHaveLength(1);
    expect(w[0].method).toBe('PATCH');
    expect(w[0].body.records[0].id).toBe('recStub');
  });

  it('patches the existing row when the huddle read failed (routes 1 and 4)', async () => {
    for (const huddle of [null, undefined, {}, { recordId: null }]) {
      const h = harness({ rowsForToday: [stub('recStub')] });
      await store(h, huddle);
      expect(writes(h).map(c => c.method)).toEqual(['PATCH']);
      expect(writes(h)[0].body.records[0].id).toBe('recStub');
    }
  });

  it('patches rather than adds a third when the worker already ran (route 2)', async () => {
    const h = harness({ rowsForToday: [finished('recDone')] });
    await store(h, null);
    const w = writes(h);
    expect(w[0].method).toBe('PATCH');
    expect(w[0].body.records[0].id).toBe('recDone');
  });

  it('posts exactly once when the day genuinely has no row', async () => {
    const h = harness({ rowsForToday: [] });
    await store(h, null);
    const w = writes(h);
    expect(w).toHaveLength(1);
    expect(w[0].method).toBe('POST');
    expect(w[0].body.records[0].fields[F_DATE]).toBe('2026-09-30');
  });

  it('refuses to write at all when it cannot tell whether a row exists', async () => {
    const h = harness({ readOk: false });
    await expect(store(h, null)).rejects.toThrow(/refusing to POST a possible duplicate/);
    expect(writes(h)).toHaveLength(0);     // a blind POST is what made the duplicates
  });

  it('prefers the unfinished row on a day that already holds a duplicate', async () => {
    const h = harness({ rowsForToday: [finished('recDone'), stub('recStub')] });
    await store(h, null);
    expect(writes(h)[0].body.records[0].id).toBe('recStub');
  });

  it('trusts the huddle id when it has one, and spends no extra read', async () => {
    const h = harness({ rowsForToday: [stub('recStub')] });
    await store(h, { recordId: 'recFromHuddle' });
    expect(h.calls.filter(c => c.method === 'GET')).toHaveLength(0);
    expect(writes(h)[0].body.records[0].id).toBe('recFromHuddle');
  });

  it('does not let the failure marker overwrite a brief that was written (30 Sep 2026)', async () => {
    const h = harness({ rowsForToday: [finished('recRealBrief')] });
    await h.storeFallbackMarker('pat', MONEY, TASKS, null, 'CEO layer failed', null);
    expect(writes(h)).toHaveLength(0);
    expect(h.logs.join(' ')).toMatch(/NOT written: today already holds a finished brief/);
  });

  it('still writes the marker when the day holds only an unfinished stub', async () => {
    const h = harness({ rowsForToday: [stub('recStub')] });
    await h.storeFallbackMarker('pat', MONEY, TASKS, null, 'CEO layer failed', null);
    const w = writes(h);
    expect(w).toHaveLength(1);
    expect(w[0].method).toBe('PATCH');
    expect(w[0].body.records[0].id).toBe('recStub');
  });

  it('refreshes an earlier FALLBACK row, which is not a real brief', async () => {
    const fallbackRow = stub('recFallback', { [F_FULL_BRIEF]: '{"one_thing":"failed","fallback":true}' });
    const h = harness({ rowsForToday: [fallbackRow] });
    await h.storeFallbackMarker('pat', MONEY, TASKS, null, 'failed twice', null);
    expect(writes(h).map(c => c.method)).toEqual(['PATCH']);
  });

  it('writes the marker after a SAVE error, when the day has no finished brief', async () => {
    const h = harness({ rowsForToday: [stub('recStub')] });
    await h.storeFallbackMarker('pat', MONEY, TASKS, null, 'stored after a save error', BRIEF);
    expect(writes(h)).toHaveLength(1);
    expect(JSON.parse(writes(h)[0].body.records[0].fields[F_FULL_BRIEF]).fallback).toBe(true);
  });

  it('asks by date, so the answer cannot depend on huddle content', () => {
    expect(slice('findTodayBriefRow')).toMatch(/DATESTR\(\{Date\}\)=/);
    // and the upsert reads its target from that lookup, never from the huddle alone
    expect(WORKER).toContain('const usePatch = target.exists;');
  });
});
