// scripts/padel-courts.mjs: the Mac mini job that reads St Ives and PDL from Matchi (which refuses
// Cloudflare with HTTP 429) and POSTs them to the padel Worker (27 Oct 2026). These drive the
// script's own run() with fetch, the clock, sleep and the log stubbed; nothing reaches the network.
// The Matchi pages are the live copies saved on 27 Oct 2026 in tests/fixtures/padel.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { run, isQuiet, buildPayload, readProblems, selftest, ENDPOINT, GAP_MS, RETRY_MS } from '../scripts/padel-courts.mjs';
import { cleanCourts, londonDates } from '../workers/padel/padel.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (f) => readFileSync(resolve(ROOT, 'tests/fixtures/padel', f), 'utf8');
const ST_IVES = fixture('matchi-2619-2026-10-28.html');
const PDL = fixture('matchi-3122-2026-10-28.html');
const CLOSED = fixture('matchi-2619-2026-11-05.html');

// 09:00 London on Wed 28 Oct 2026 (GMT): the window is 28 Oct to 3 Nov.
const START = Date.parse('2026-10-28T09:00:00Z');
const DATES = londonDates(START);
const ROBOT = 'robot-key-for-tests';
const WORKER_OK = { ok: true, matchiFetchedAt: '2026-10-28T09:00:00.000Z', pulseFetchedAt: '2026-10-28T08:50:00.000Z', alerted: 'checking', ready: 0 };

// A fake Matchi and Worker. page(id, date) decides each page; post decides the Worker's answer.
// clock: an array (each call takes the next value, the last one repeats) or a function of the call
// number and of the pages fetched so far (so time passes per fetch, whatever the script reads).
// postClock, when set, is what the clock reads once the POST has gone out.
function stubs({ page, post = () => new Response(JSON.stringify(WORKER_OK), { status: 200 }), clock = [START, START + 20 * 1000], postClock } = {}) {
  const pages = [];
  const posts = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'www.matchi.se') {
      pages.push({ id: u.searchParams.get('facilityId'), date: u.searchParams.get('date'), headers: init.headers, signal: init.signal });
      return page(u.searchParams.get('facilityId'), u.searchParams.get('date'));
    }
    if (String(url) === ENDPOINT) {
      posts.push({ headers: init.headers, body: JSON.parse(init.body), method: init.method });
      return post();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const times = Array.isArray(clock) ? [...clock] : null;
  let calls = 0;
  const now = () => {
    if (postClock !== undefined && posts.length) return postClock;
    const n = calls++;
    return times ? (times.length > 1 ? times.shift() : times[0]) : clock(n, pages.length);
  };
  const lines = [];
  const records = [];
  const sleeps = [];
  return {
    pages, posts, lines, records, sleeps, fetchImpl,
    go: (extra = {}) => run({
      fetchImpl, robotKey: ROBOT, now,
      sleep: async (ms) => { sleeps.push(ms); }, log: (l) => lines.push(l), record: (e) => records.push(e), ...extra,
    }),
  };
}
// The saved pages: St Ives closed from the 7th day on, as its window is 7 days.
// St Ives opens 7 days ahead, so from the 8th of the 14 dates its page says "not open yet" (closed).
const livePage = (id, date) => new Response(id === '2619' ? (date >= DATES[7] ? CLOSED : ST_IVES) : PDL, { status: 200 });

describe('quiet hours, decided in Europe/London', () => {
  it('BST: quiet before 06:30 and from 23:00', () => {
    expect(isQuiet(Date.parse('2026-07-01T05:29:00Z'))).toBe(true);    // 06:29 BST
    expect(isQuiet(Date.parse('2026-07-01T05:30:00Z'))).toBe(false);   // 06:30 BST
    expect(isQuiet(Date.parse('2026-07-01T21:59:00Z'))).toBe(false);   // 22:59 BST
    expect(isQuiet(Date.parse('2026-07-01T22:00:00Z'))).toBe(true);    // 23:00 BST
  });
  it('GMT: the same London hours are an hour later in UTC', () => {
    expect(isQuiet(Date.parse('2026-11-01T06:29:00Z'))).toBe(true);
    expect(isQuiet(Date.parse('2026-11-01T06:30:00Z'))).toBe(false);
    expect(isQuiet(Date.parse('2026-11-01T22:59:00Z'))).toBe(false);
    expect(isQuiet(Date.parse('2026-11-01T23:00:00Z'))).toBe(true);
  });
  it('on the clock-change days', () => {
    expect(isQuiet(Date.parse('2026-03-29T05:30:00Z'))).toBe(false);   // 06:30 BST, first day of summer time
    expect(isQuiet(Date.parse('2026-10-25T05:30:00Z'))).toBe(true);    // 05:30 GMT, first day of winter time
    expect(isQuiet(Date.parse('2026-10-25T06:30:00Z'))).toBe(false);
  });
  it('in quiet hours it fetches nothing and exits 0', async () => {
    const s = stubs({ page: livePage, clock: [Date.parse('2026-10-28T23:10:00Z')] });
    expect(await s.go()).toBe(0);
    expect(s.lines).toEqual(['quiet hours']);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
  it('re-reads the clock before the POST: a run that drifts into quiet hours does not post', async () => {
    const s = stubs({ page: livePage, clock: [Date.parse('2026-10-28T22:59:00Z'), Date.parse('2026-10-28T23:00:30Z')] });
    expect(await s.go()).toBe(0);
    expect(s.pages).toHaveLength(28);
    expect(s.posts).toHaveLength(0);
    expect(s.lines).toEqual(['quiet hours']);
  });
});

describe('a normal run', () => {
  it('reads 28 pages (14 days at each venue) one after another, posts what the Worker accepts, prints one line, logs counts only', async () => {
    const s = stubs({ page: livePage });
    expect(await s.go()).toBe(0);
    expect(s.pages.map((p) => `${p.id} ${p.date}`)).toEqual([...DATES.map((d) => `2619 ${d}`), ...DATES.map((d) => `3122 ${d}`)]);
    expect(DATES).toHaveLength(14);
    expect(s.sleeps).toEqual(Array(27).fill(GAP_MS));
    expect(s.pages[0].headers['User-Agent']).toMatch(/^Mozilla\/5\.0/);
    expect(s.pages[0].headers.Accept).toBe('text/html');
    expect(s.pages[0].signal).toBeInstanceOf(AbortSignal);

    expect(s.posts).toHaveLength(1);
    const { headers, body, method } = s.posts[0];
    expect(method).toBe('POST');
    expect(headers['X-Robot-Key']).toBe(ROBOT);
    expect(body.readAt).toBe('2026-10-28T09:00:00.000Z');      // when the read started
    expect(Object.keys(body.venues)).toEqual(['si', 'pdl']);
    expect(body.venues.si[DATES[0]].starts['07:00']).toEqual({ courts: 2, min: 60 });
    expect(body.venues.si[DATES[6]].status).toBe('ok');
    expect(body.venues.si[DATES[9]]).toEqual({ status: 'closed' });   // St Ives day 10: not open yet, and the run still exits 0
    expect(Object.keys(body.venues.pdl)).toHaveLength(14);
    expect(JSON.stringify(body)).not.toMatch(/Court|names/);   // no court names, only counts
    // The Worker's own validator takes it as it is.
    expect(cleanCourts(body, START + 20 * 1000).error).toBeUndefined();

    expect(s.lines).toEqual(['padel-courts: St Ives ok 7, closed 7; PDL ok 14; posted 200 in 20 s; Pulse read 08:50']);
    expect(s.records).toEqual([{ ts: '2026-10-28T09:00:20.000Z', ok: true, posted: true, http: 200, seconds: 20, counts: { si: { ok: 7, closed: 7, error: 0 }, pdl: { ok: 14, closed: 0, error: 0 } }, problems: 0 }]);
  });


  it('28 pages timing out (12 s per fetch, each tried twice) is a FAILED run', async () => {
    const s = stubs({ page: () => { throw new DOMException('signal timed out', 'TimeoutError'); }, clock: (n, fetched) => START + fetched * 12 * 1000 });
    expect(await s.go()).toBe(1);
    expect(s.pages).toHaveLength(56);                          // each page tried twice
    expect(s.posts).toHaveLength(1);
    expect(s.lines[0]).toMatch(/^FAILED: every Matchi page errored \(timed out\)/);
  });

});

describe('fails loudly', () => {
  it('when every page of both venues errored (still posts, so the page says "couldn\'t check")', async () => {
    const s = stubs({ page: () => new Response('<title>429 Too Many Requests</title>', { status: 429 }) });
    expect(await s.go()).toBe(1);
    expect(s.pages).toHaveLength(28);                          // a 429 is never retried
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0].body.venues.si[DATES[0]]).toEqual({ status: 'error', reason: 'HTTP 429' });
    expect(s.lines[0]).toMatch(/^FAILED: every Matchi page errored \(HTTP 429\)/);
    expect(s.records[0].ok).toBe(false);
  });

  it('when a page times out on every request (same rule, the reason kept)', async () => {
    const s = stubs({ page: () => { throw new DOMException('signal timed out', 'TimeoutError'); } });
    expect(await s.go()).toBe(1);
    expect(s.lines[0]).toMatch(/^FAILED: every Matchi page errored \(timed out\)/);
  });


  it('item 4: a page lost to the network is fetched once more after 2 s before it counts', async () => {
    const tries = {};
    const s = stubs({ page: (id, date) => {
      const k = `${id} ${date}`;
      tries[k] = (tries[k] || 0) + 1;
      if (k === `3122 ${DATES[3]}` && tries[k] === 1) return new Response('busy', { status: 503 });
      if (k === `2619 ${DATES[0]}` && tries[k] === 1) throw new DOMException('signal timed out', 'TimeoutError');
      if (k === `2619 ${DATES[1]}` && tries[k] === 1) throw new TypeError('fetch failed');   // no connection
      return livePage(id, date);
    } });
    expect(await s.go()).toBe(0);
    expect(s.pages).toHaveLength(31);                          // 28 pages and 3 second tries
    expect(s.sleeps.filter((ms) => ms === RETRY_MS)).toHaveLength(3);
    expect(s.lines[0]).toContain('St Ives ok 7, closed 7; PDL ok 14');
    // A page that arrived and could not be parsed gets no second try.
    const t = stubs({ page: (id, date) => (id === '3122' && date === DATES[2] ? new Response('<div class="schedule"><table><tr><td class="slot vacant"></td></tr></table></div>', { status: 200 }) : livePage(id, date)) });
    expect(await t.go()).toBe(1);
    expect(t.pages).toHaveLength(28);
    expect(t.lines[0]).toMatch(/^FAILED: PDL 2026-10-30 could not be read \(unknown court cell\)/);
  });

  it('but a few days lost to the network (timeouts, a 5xx) are not a failure of the run', async () => {
    const down = new Set([DATES[2], DATES[4], DATES[5]]);
    const s = stubs({ page: (id, date) => {
      if (id === '3122' && date === DATES[2]) throw new DOMException('signal timed out', 'TimeoutError');
      return id === '3122' && down.has(date) ? new Response('x', { status: 503 }) : livePage(id, date);
    } });
    expect(await s.go()).toBe(0);
    expect(s.lines[0]).toContain('PDL ok 11, error 3');
  });

  it('item 2: a venue that errors on every day that should be open fails, whatever the reason (PDL 404 on all 14)', async () => {
    let s = stubs({ page: (id, date) => (id === '3122' ? new Response('gone', { status: 404 }) : livePage(id, date)) });
    expect(await s.go()).toBe(1);
    expect(s.lines[0]).toMatch(/^FAILED: PDL errored on every day that should be open \(HTTP 404\)/);
    // Item 1: a 404 is not retried (only a timeout, a 5xx or no connection is).
    expect(s.pages).toHaveLength(28);
    expect(s.sleeps).not.toContain(RETRY_MS);
    // St Ives must be open today and tomorrow: both lost is a failure even with the rest fine.
    s = stubs({ page: (id, date) => (id === '2619' && date <= DATES[1] ? new Response('x', { status: 502 }) : livePage(id, date)) });
    expect(await s.go()).toBe(1);
    expect(s.lines[0]).toMatch(/^FAILED: St Ives errored on every day that should be open \(HTTP 502\)/);
  });

  it('item 2: a Matchi markup change fails the run even when one page still reads (the 21:45 case)', async () => {
    // The reviewer's change: "Available<br>" became "Bookable<br>" in the saved pages. One St Ives
    // page still reads ok; the other 13 cannot be read. That must never exit 0.
    const changed = ST_IVES.replace(/Available<br>/g, 'Bookable<br>');
    const s = stubs({ page: (id, date) => (id === '2619' && date !== DATES[0] ? new Response(changed, { status: 200 }) : livePage(id, date)) });
    expect(await s.go()).toBe(1);
    expect(s.lines[0]).toMatch(/^FAILED: St Ives 2026-10-29 could not be read \(a free court cell could not be read\)/);
    expect(s.lines[0]).toContain('St Ives ok 1, error 13');
    expect(s.posts).toHaveLength(1);                           // still posted: the page says "couldn't check"
  });

  it('when a day whose window must be open has zero court cells (St Ives today and tomorrow, PDL all 14)', async () => {
    const empty = '<div class="schedule"><table id="schedule-table"><tr></tr></table></div>';
    let s = stubs({ page: (id, date) => (id === '2619' && date === DATES[1] ? new Response(empty, { status: 200 }) : livePage(id, date)) });
    expect(await s.go()).toBe(1);
    expect(s.lines[0]).toMatch(/^FAILED: St Ives 2026-10-29 could not be read \(no court cells recognised\)/);
    s = stubs({ page: (id, date) => (id === '3122' && date === DATES[6] ? new Response(CLOSED, { status: 200 }) : livePage(id, date)) });
    expect(await s.go()).toBe(1);
    expect(s.lines[0]).toMatch(/^FAILED: PDL 2026-11-03 has no court cells/);
    // St Ives closed beyond tomorrow is its booking window, not a fault.
    s = stubs({ page: (id, date) => (id === '2619' && date >= DATES[2] ? new Response(CLOSED, { status: 200 }) : livePage(id, date)) });
    expect(await s.go()).toBe(0);
  });

  it('when the POST is not 200, or never answers', async () => {
    let s = stubs({ page: livePage, post: () => new Response('{"error":"Robot key needed"}', { status: 401 }) });
    expect(await s.go()).toBe(1);
    expect(s.lines[0]).toMatch(/^FAILED: the Worker answered 401 \(Robot key needed\)/);
    expect(s.records[0]).toMatchObject({ ok: false, posted: false, http: 401 });
    s = stubs({ page: livePage, post: () => { throw new TypeError('fetch failed'); } });
    expect(await s.go()).toBe(1);
    expect(s.lines[0]).toMatch(/^FAILED: the Worker answered nothing \(could not reach the Worker\)/);
  });

  it('a read the Worker refuses as over 10 minutes old fails ONCE, loudly: "did the Mac sleep?"', async () => {
    const s = stubs({ page: livePage, post: () => new Response('{"error":"readAt is not within 10 minutes of now"}', { status: 400 }), postClock: START + 11 * 60 * 1000 });
    expect(await s.go()).toBe(1);
    expect(s.lines[0]).toMatch(/^FAILED: the read took too long for the Worker \(did the Mac sleep\?\)\. St Ives ok 7, closed 7; PDL ok 14$/);
    expect(s.records[0]).toMatchObject({ ok: false, posted: false, http: 400 });
    // Any other refusal keeps its own words.
    const t = stubs({ page: livePage, post: () => new Response('{"error":"A newer read is already stored"}', { status: 409 }) });
    expect(await t.go()).toBe(1);
    expect(t.lines[0]).toMatch(/^FAILED: the Worker answered 409 \(A newer read is already stored\)/);
  });

  it('when there is no robot key file, before reading anything', async () => {
    const s = stubs({ page: livePage });
    expect(await s.go({ robotKey: '' })).toBe(1);
    expect(s.lines[0]).toMatch(/^FAILED: no robot key at /);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('pure parts', () => {
  it('buildPayload keeps statuses and reasons, drops names', () => {
    const raw = { si: { [DATES[0]]: { status: 'ok', starts: { '19:00': { courts: 1, min: 60, names: ['Court 1'] } } }, [DATES[1]]: { status: 'error', reason: 'HTTP 500' } } };
    expect(buildPayload(raw, START)).toEqual({ readAt: '2026-10-28T09:00:00.000Z', venues: { si: { [DATES[0]]: { status: 'ok', starts: { '19:00': { courts: 1, min: 60 } } }, [DATES[1]]: { status: 'error', reason: 'HTTP 500' } } } });
  });
  it('readProblems is empty for a clean read', () => {
    const ok = { status: 'ok', starts: {} };
    const raw = { si: Object.fromEntries(DATES.map((d) => [d, ok])), pdl: Object.fromEntries(DATES.map((d) => [d, ok])) };
    expect(readProblems(raw, DATES)).toEqual([]);
  });
  it('the selftest passes', () => {
    const lines = [];
    expect(selftest((l) => lines.push(l))).toBe(0);
    expect(lines.at(-1)).toMatch(/^selftest: (\d+) of \1 checks passed$/);
  });
});
