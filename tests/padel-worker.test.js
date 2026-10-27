// The padel group's Worker (workers/padel, Kevin approved the plan on 27 Oct 2026). These drive the
// REAL parsers and the REAL request handler. The venue pages are live copies saved on 27 Oct 2026
// (tests/fixtures/padel): Matchi St Ives (2619) and PDL (3122) for Wed 28 Oct, St Ives for Thu 5 Nov
// (beyond its 7-day window), and the Pulse Padel availability reply for 27 Oct to 2 Nov. Every
// person in here is invented. The alert rules run twice: on a Map-backed repo, and on the Worker's
// own makeRepo SQL over an in-memory SQLite database built from workers/padel/schema.sql.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import worker from '../workers/padel/worker.js';
import {
  parseMatchi, parsePulse, hoursFromStarts, londonParts, londonDates, londonMidnightMs, computeState,
  decideAlerts, handleRequest, makeRepo, cleanName, cleanSlots, alertText, venueConfig,
} from '../workers/padel/padel.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (f) => readFileSync(resolve(ROOT, 'tests/fixtures/padel', f), 'utf8');
const ST_IVES = fixture('matchi-2619-2026-10-28.html');
const PDL = fixture('matchi-3122-2026-10-28.html');
const CLOSED = fixture('matchi-2619-2026-11-05.html');
const PULSE = JSON.parse(fixture('pulse-search.json'));
const countClass = (html, cls) => (html.match(new RegExp(`class="slot ${cls}"`, 'g')) || []).length;

// 09:45 London on Tue 27 Oct 2026 (GMT since 25 Oct): the window is 27 Oct to 2 Nov.
const NOW = Date.parse('2026-10-27T09:45:00Z');
const KEY = 'feedc0de1234567890abcdef';
const RELAY_OK = JSON.stringify({ ok: true, sent: [{ email: 'kevin@runpreneur.org.uk', ok: true, ts: '1793000000.000100', error: null }], refused: [] });

describe('fixtures are the live pages they claim to be (controls)', () => {
  it('St Ives 28 Oct: 31 free, 8 booked, 6 cannot-start cells', () => {
    expect([countClass(ST_IVES, 'free'), countClass(ST_IVES, 'red'), countClass(ST_IVES, 'can-not-start')]).toEqual([31, 8, 6]);
  });
  it('PDL 28 Oct: 25 free (2 on the Singles Court), 46 booked, 12 cannot-start cells', () => {
    expect([countClass(PDL, 'free'), countClass(PDL, 'red'), countClass(PDL, 'can-not-start')]).toEqual([25, 46, 12]);
    expect((PDL.match(/Available<br>Singles Court<br>/g) || []).length).toBe(2);
  });
  it('St Ives 5 Nov has no slot cells at all, only the booking-window message', () => {
    expect((CLOSED.match(/class="slot/g) || []).length).toBe(0);
    expect(CLOSED).toMatch(/allows bookings no more than 7 days in the future/);
  });
});

describe('parseMatchi', () => {
  it('worked example 1: St Ives Court 1 at 07:00 is free, can start, 60 min', () => {
    const r = parseMatchi(ST_IVES);
    expect(r.status).toBe('ok');
    expect(r.starts['07:00']).toEqual({ courts: 2, min: 60, names: ['Court 1', 'Court 2'] });
    // Every one of the 31 free cells can start and sits on a doubles court.
    expect(Object.values(r.starts).reduce((n, s) => n + s.courts, 0)).toBe(31);
    // 17:00 to 21:00 are booked or cannot start on both courts.
    expect(Object.keys(r.starts).filter((t) => t >= '17:00')).toEqual([]);
  });

  it('worked example 2: PDL 09:00 counts three doubles courts, never the Singles Court', () => {
    const r = parseMatchi(PDL);
    expect(r.status).toBe('ok');
    expect(r.starts['09:00']).toEqual({ courts: 3, min: 60, names: ['Court 1', 'Court 2', 'Court 3'] });
    // Court 1's 09:00 start is the 90-minute one; the hour still reads free with min <= 90.
    expect(PDL).toMatch(/data-slot-min-duration="90"\s+data-slot-can-start="true"\s+title="Available<br>Court 1<br> 09:00 - 10:30"/);
    expect(hoursFromStarts(r.starts)['09']).toEqual({ free: true, min: 60, starts: ['09:00', '09:30'], mins: [60, 60] });
    // Court 1 10:30 is booked ("slot red"): the 10:30 start is Court 3's alone.
    expect(r.starts['10:30'].names).toEqual(['Court 3']);
    // The Singles Court's free 09:00 and 12:00 are ignored.
    expect(r.starts['12:00']).toEqual({ courts: 2, min: 60, names: ['Court 2', 'Court 3'] });
    expect(Object.values(r.starts).some((s) => s.names.some((n) => /single/i.test(n)))).toBe(false);
    // 25 free cells minus 2 singles = 23 starts; the 12 cannot-start cells add none.
    expect(Object.values(r.starts).reduce((n, s) => n + s.courts, 0)).toBe(23);
  });

  it('worked example 3: St Ives 5 Nov is closed ("not open yet")', () => {
    expect(parseMatchi(CLOSED)).toEqual({ status: 'closed' });
  });

  it('reads a cell whatever the attribute order and with newlines in the title', () => {
    const html = `<div class="schedule"><table id="schedule-table"><tr><td title="Available<br>
        Court 2<br>
        18:30 - 20:00" data-slot-can-start="true" data-slot-min-duration="90" class="slot free"></td>
      <td class="slot free" data-slot-can-start="false" data-slot-min-duration="60" title="Available<br>Court 1<br> 19:00 - 20:00"></td></tr></table></div>`;
    expect(parseMatchi(html)).toEqual({ status: 'ok', starts: { '18:30': { courts: 1, min: 90, names: ['Court 2'] } } });
  });

  it('a schedule with only not-available cells is open with no courts (grey), not closed', () => {
    const html = '<div class="schedule"><table id="schedule-table"><tr><td class="slot not-available" title="x"></td></tr></table></div>';
    expect(parseMatchi(html)).toEqual({ status: 'ok', starts: {} });
  });

  it('anything that is not a schedule page is an error, never closed', () => {
    expect(parseMatchi('<html><body>Please log in</body></html>')).toEqual({ status: 'error', reason: 'not a schedule page' });
    expect(parseMatchi('<div class="schedule"><p>Maintenance</p></div>')).toEqual({ status: 'error', reason: 'no schedule table' });
    expect(parseMatchi(undefined).status).toBe('error');
  });
});

describe('parsePulse (the saved live reply)', () => {
  it('Wed 28 Oct starts match the widget read on 27 Oct 2026', () => {
    const r = parsePulse(PULSE.json, NOW);
    expect(r.status).toBe('ok');
    expect(Object.keys(r.byDate)).toEqual(londonDates(NOW));
    expect(Object.keys(r.byDate['2026-10-28']).sort()).toEqual([
      '07:00', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '15:30', '16:30', '17:00', '21:30',
    ]);
    expect(r.byDate['2026-10-28']['07:00']).toEqual({ courts: 3, min: 60 });
    expect(r.byDate['2026-10-28']['21:30']).toEqual({ courts: 2, min: 90 });
  });

  it('drops starts earlier than now, as the widget does', () => {
    const r = parsePulse(PULSE.json, Date.parse('2026-10-27T15:00:00Z'));
    expect(Object.keys(r.byDate['2026-10-27']).every((t) => t >= '15:00')).toBe(true);
  });

  it('a reply it does not recognise is an error, never guessed slots', () => {
    expect(parsePulse({}, NOW)).toEqual({ status: 'error', reason: 'unexpected shape' });
    expect(parsePulse({ availableSlots: { '2026-10-28T19:00:00.000Z': 3 } }, NOW)).toEqual({ status: 'error', reason: 'unexpected shape' });
    expect(parsePulse({ availableSlots: { 'not a date': [] } }, NOW)).toEqual({ status: 'error', reason: 'unexpected shape' });
  });

  it('a singles court never counts', () => {
    const r = parsePulse({ availableSlots: { '2026-10-28T19:00:00.000Z': [{ name: 'Singles Court', size: 'SingleRegular', durations: [{ minutes: 60 }] }] } }, NOW);
    expect(r).toEqual({ status: 'ok', byDate: {} });
  });
});

describe('London time without Intl', () => {
  it('matches Intl Europe/London for every half hour of 2025 to 2027', () => {
    const dtf = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const bad = [];
    for (let ms = Date.UTC(2025, 0, 1); ms < Date.UTC(2028, 0, 1); ms += 30 * 60 * 1000) {
      const p = {};
      for (const x of dtf.formatToParts(new Date(ms))) p[x.type] = x.value;
      const a = londonParts(ms);
      if (a.date !== `${p.year}-${p.month}-${p.day}` || a.hh !== p.hour || a.mm !== p.minute) bad.push(new Date(ms).toISOString());
    }
    expect(bad).toEqual([]);
  });
  it('London midnight in summer is 23:00 UTC the day before', () => {
    expect(new Date(londonMidnightMs('2026-07-01')).toISOString()).toBe('2026-06-30T23:00:00.000Z');
    expect(new Date(londonMidnightMs('2026-10-27')).toISOString()).toBe('2026-10-27T00:00:00.000Z');
  });
  it('the 7 days start today in London, even at 23:30 UTC in summer', () => {
    expect(londonDates(Date.parse('2026-07-31T23:30:00Z'))[0]).toBe('2026-08-01');
    expect(londonDates(NOW)).toEqual(['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });
});

describe('input checks', () => {
  it('names: trimmed, spaces collapsed, 2 to 30 letters, spaces, hyphens, apostrophes', () => {
    expect(cleanName('  Ann   Marie ')).toEqual({ name: 'Ann Marie' });
    expect(cleanName("Siobhán O'Neil-Smith")).toEqual({ name: "Siobhán O'Neil-Smith" });
    expect(cleanName('A').error).toBeTruthy();
    expect(cleanName('x'.repeat(31)).error).toBeTruthy();
    expect(cleanName('<b>Bob</b>').error).toBeTruthy();
    expect(cleanName('Bob2').error).toBeTruthy();
  });
  it('slots: only the next 7 days, hours 07 to 21', () => {
    const dates = londonDates(NOW);
    expect(cleanSlots(['2026-10-28|07', '2026-11-02|21', '2026-10-28|07'], dates)).toEqual({ slots: ['2026-10-28|07', '2026-11-02|21'] });
    for (const bad of ['2026-10-26|10', '2026-11-03|10', '2026-10-28|06', '2026-10-28|22', '2026-10-28 07', '2026-10-28|7']) {
      expect(cleanSlots([bad], dates).error, bad).toBeTruthy();
    }
    expect(cleanSlots('2026-10-28|07', dates).error).toBeTruthy();
  });
});

// ── Repos: the brief's Map-backed one, and the Worker's real SQL on SQLite ──
function mapRepo() {
  const people = new Map();
  let nextId = 1;
  const votes = new Map();
  const booked = new Map();
  const alerts = new Map();
  const cache = new Map();
  const out = (p) => ({ id: p.id, name: p.name, venues: p.venues.split(',').filter(Boolean) });
  return {
    rows: { alerts: () => [...alerts.values()], people: () => [...people.values()], votes: () => [...votes.values()] },
    repo: {
      async listPeople() { return [...people.values()].sort((a, b) => a.name.localeCompare(b.name)).map(out); },
      async getPerson(id) { return people.has(id) ? out(people.get(id)) : null; },
      async countPeople() { return people.size; },
      async addPerson(name, now) {
        let p = [...people.values()].find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!p) { p = { id: nextId++, name, venues: 'si,pdl,pp', created_at: now }; people.set(p.id, p); }
        return out(p);
      },
      async setVenues(id, venues) { const p = people.get(id); if (!p) return false; p.venues = venues.join(','); return true; },
      async listVotes(from) { return [...votes.values()].filter((v) => v.slot >= from).map(({ person_id, slot }) => ({ person_id, slot })); },
      async replaceVotes(pid, slots, now) {
        for (const [k, v] of [...votes]) if (v.person_id === pid && !slots.includes(v.slot)) votes.delete(k);
        for (const s of slots) if (!votes.has(`${pid}|${s}`)) votes.set(`${pid}|${s}`, { person_id: pid, slot: s, created_at: now });
      },
      async listBooked(from) { return [...booked.values()].filter((b) => b.slot >= from); },
      async setBooked(slot, person_id, venue, now) { booked.set(slot, { slot, person_id, venue, created_at: now }); },
      async clearBooked(slot) { booked.delete(slot); },
      async alertSlots(from) { return [...alerts.keys()].filter((s) => s >= from); },
      async claimAlert(slot, names, venues, now) {
        if (alerts.has(slot)) return false;
        alerts.set(slot, { slot, sent_at: now, names, venues, relay_reply: null });
        return true;
      },
      async saveRelayReply(slot, reply) { if (alerts.has(slot)) alerts.get(slot).relay_reply = reply; },
      async releaseAlert(slot) { alerts.delete(slot); },
      async getCache(k) { return cache.has(k) ? cache.get(k).value : null; },
      async setCache(k, value, now) { cache.set(k, { value, updated_at: now }); },
      async claimRefresh(nowMs, guardMs) {
        const c = cache.get('refresh_started_at');
        if (c && Number(c.value) > nowMs - guardMs) return false;
        cache.set('refresh_started_at', { value: String(nowMs) });
        return true;
      },
      async prune(today) {
        for (const m of [votes, booked, alerts]) for (const [k, v] of [...m]) if (v.slot < today) m.delete(k);
      },
    },
  };
}

// A D1 look-alike over node:sqlite, so makeRepo's own SQL (upserts, json_each, INSERT OR IGNORE)
// runs for real. createRequire keeps Vite away from the node:sqlite import.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const SCHEMA = readFileSync(resolve(ROOT, 'workers/padel/schema.sql'), 'utf8');
function sqlRepo() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
    runSync: () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  const d1 = {
    prepare: (sql) => stmt(sql),
    async batch(list) {
      db.exec('BEGIN');
      try { const out = list.map((s) => s.runSync()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
  return {
    rows: {
      alerts: () => db.prepare('SELECT * FROM alerts').all().map((r) => ({ ...r })),
      people: () => db.prepare('SELECT * FROM people').all().map((r) => ({ ...r })),
      votes: () => db.prepare('SELECT * FROM votes').all().map((r) => ({ ...r })),
    },
    repo: makeRepo(d1),
  };
}

// The venues, stubbed: Matchi answers with the saved pages, Pulse with the saved reply.
function venueFetch(calls, { pulse = 'ok', matchiFor = null } = {}) {
  return vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ host: u.hostname, url: String(url), init });
    if (u.hostname === 'www.matchi.se') {
      if (matchiFor) return matchiFor(u);
      const id = u.searchParams.get('facilityId');
      const date = u.searchParams.get('date');
      if (date === '2026-11-02') return new Response(CLOSED, { status: 200 });
      return new Response(id === '2619' ? ST_IVES : PDL, { status: 200 });
    }
    if (u.hostname.endsWith('cloudfunctions.net')) {
      if (pulse === 'down') return new Response('{"error":"boom"}', { status: 500 });
      if (pulse === 'odd') return new Response('{"json":{"availableSlots":{"2026-10-28T19:00:00.000Z":7}}}', { status: 200 });
      const body = JSON.parse(init.body);
      if (!body.json) return new Response('{"json":{"code":"BAD_REQUEST"}}', { status: 400 });
      return new Response(JSON.stringify(PULSE), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function harness(make) {
  const h = make();
  const relayCalls = [];
  let relayReply = () => new Response(RELAY_OK, { status: 200 });
  const waits = [];
  const calls = [];
  const env = {
    GROUP_KEY: KEY,
    RELAY_KEY: 'relay-key-test',
    PAGE_URL: 'https://padel.kevinbrittain.workers.dev/',
    RELAY: { fetch: vi.fn(async (req) => { relayCalls.push({ url: req.url, key: req.headers.get('X-Relay-Key'), body: await req.json() }); return relayReply(); }) },
    ASSETS: { fetch: async () => new Response('<!doctype html><title>Padel this week</title>', { status: 200, headers: { 'Content-Type': 'text/html' } }) },
  };
  const ctx = { waitUntil: (p) => waits.push(p) };
  let now = NOW;
  let fetchImpl = venueFetch(calls);
  const call = async (path, body, { key = KEY, method } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['X-Group-Key'] = key;
    const req = new Request(`https://padel.kevinbrittain.workers.dev${path}`, { method: method || (body ? 'POST' : 'GET'), headers, body: body ? JSON.stringify(body) : undefined });
    const res = await handleRequest(req, env, ctx, h.repo, { now: () => now, fetch: fetchImpl });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text, headers: res.headers };
  };
  return {
    ...h, env, ctx, waits, calls, relayCalls, call,
    setNow: (ms) => { now = ms; },
    setRelay: (fn) => { relayReply = fn; },
    setFetch: (f) => { fetchImpl = f; },
    async seedAvailability(venues, fetchedAt = NOW) {
      await h.repo.setCache('availability', JSON.stringify({ fetchedAt: new Date(fetchedAt).toISOString(), pulseFetchedAt: new Date(fetchedAt).toISOString(), pulseFormat: 'orpc', venues }), new Date(fetchedAt).toISOString());
    },
    async addPeople(names) {
      const ids = [];
      for (const name of names) ids.push((await call('/api/person', { name })).json.id);
      return ids;
    },
  };
}

const SLOT = '2026-10-28|19';
// Wed 28 Oct 19:00: St Ives free at 19:00 and 19:30 (60 min), PDL free at 19:30 (90 min), Pulse closed.
const EVENING = {
  si: { '2026-10-28': { status: 'ok', starts: { '19:00': { courts: 1, min: 60 }, '19:30': { courts: 2, min: 60 } } } },
  pdl: { '2026-10-28': { status: 'ok', starts: { '19:30': { courts: 1, min: 90 } } } },
  pp: { '2026-10-28': { status: 'closed' } },
};
const NAMES = ['Test Ann', 'Test Bob', 'Test Cat', 'Test Dan', 'Test Eve'];

describe.each([['Map repo', mapRepo], ['makeRepo SQL on SQLite', sqlRepo]])('alerts and routes (%s)', (_label, make) => {
  let t;
  beforeEach(async () => {
    t = harness(make);
    await t.seedAvailability(EVENING);
  });

  it('no DM at 3, one DM at 4, none again at 5', async () => {
    const ids = await t.addPeople(NAMES);
    for (const id of ids.slice(0, 3)) await t.call('/api/vote', { person_id: id, slots: [SLOT] });
    let s = (await t.call('/api/state')).json;
    expect(t.relayCalls).toHaveLength(0);
    expect(s.ready).toEqual([]);
    expect(s.nearly.map((n) => [n.slot, n.count])).toEqual([[SLOT, 3]]);

    s = (await t.call('/api/vote', { person_id: ids[3], slots: [SLOT] })).json;
    expect(t.relayCalls).toHaveLength(1);
    expect(s.ready.map((r) => [r.slot, r.count])).toEqual([[SLOT, 4]]);
    const dm = t.relayCalls[0];
    expect(dm.url).toBe('https://apple-inbound/slack-relay');
    expect(dm.key).toBe('relay-key-test');
    expect(dm.body.recipients).toEqual(['kevin@runpreneur.org.uk']);
    expect(dm.body.text).toBe('Padel: 4 in for Wed 28 Oct 19:00: Test Ann, Test Bob, Test Cat, Test Dan. Courts free: '
      + 'St Ives 19:00, 19:30 (60 min) <https://www.matchi.se/book/schedule?facilityId=2619&date=2026-10-28&sport=5|book>; '
      + 'PDL 19:30 (90 min) <https://www.matchi.se/book/schedule?facilityId=3122&date=2026-10-28&sport=5|book>. '
      + 'Whoever books: tap Booked on the page https://padel.kevinbrittain.workers.dev/');
    expect(dm.body.text).not.toContain(KEY);
    const rows = t.rows.alerts();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].relay_reply).ok).toBe(true);

    await t.call('/api/vote', { person_id: ids[4], slots: [SLOT] });
    expect(t.relayCalls).toHaveLength(1);
  });

  it('no DM when the only free venue is one the 4th person cannot do', async () => {
    await t.seedAvailability({ si: EVENING.si, pdl: { '2026-10-28': { status: 'closed' } }, pp: { '2026-10-28': { status: 'error', reason: 'HTTP 500' } } });
    const ids = await t.addPeople(NAMES.slice(0, 4));
    expect((await t.call('/api/person', { id: ids[3], venues: ['pdl', 'pp'] })).json.venues).toEqual(['pdl', 'pp']);
    for (const id of ids) await t.call('/api/vote', { person_id: id, slots: [SLOT] });
    const s = (await t.call('/api/state')).json;
    expect(t.relayCalls).toHaveLength(0);
    expect(s.ready).toEqual([]);
    expect(s.nearly.map((n) => [n.slot, n.count, n.venues.map((v) => v.code)])).toEqual([[SLOT, 3, ['si']]]);
  });

  it('no DM for a booked slot', async () => {
    const ids = await t.addPeople(NAMES.slice(0, 4));
    expect((await t.call('/api/booked', { slot: SLOT, person_id: ids[0], venue: 'si', booked: true })).status).toBe(200);
    for (const id of ids) await t.call('/api/vote', { person_id: id, slots: [SLOT] });
    const s = (await t.call('/api/state')).json;
    expect(t.relayCalls).toHaveLength(0);
    expect(s.ready).toEqual([]);
    expect(s.booked[SLOT]).toEqual({ person_id: ids[0], venue: 'si' });
    // Undo the booking: the slot is ready again and the next save sends its one DM.
    await t.call('/api/booked', { slot: SLOT, booked: false });
    await t.call('/api/vote', { person_id: ids[0], slots: [SLOT] });
    expect(t.relayCalls).toHaveLength(1);
  });

  it('a failed DM leaves no alert row, logs, and the next save retries', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.setRelay(() => new Response('{"ok":false,"sent":[{"ok":false,"error":"channel_not_found"}]}', { status: 502 }));
    const ids = await t.addPeople(NAMES.slice(0, 4));
    for (const id of ids) await t.call('/api/vote', { person_id: id, slots: [SLOT] });
    expect(t.relayCalls).toHaveLength(1);
    expect(t.rows.alerts()).toHaveLength(0);
    expect(err).toHaveBeenCalledWith('padel: alert DM failed, will retry', SLOT, expect.stringContaining('relay HTTP 502'));
    t.setRelay(() => new Response(RELAY_OK, { status: 200 }));
    await t.call('/api/vote', { person_id: ids[0], slots: [SLOT] });
    expect(t.relayCalls).toHaveLength(2);
    expect(t.rows.alerts()).toHaveLength(1);
    err.mockRestore();
  });

  it('two saves at once send one DM, and both saves persist', async () => {
    const ids = await t.addPeople(NAMES);
    for (const id of ids.slice(0, 3)) await t.call('/api/vote', { person_id: id, slots: [SLOT] });
    const [a, b] = await Promise.all([
      t.call('/api/vote', { person_id: ids[3], slots: [SLOT] }),
      t.call('/api/vote', { person_id: ids[4], slots: [SLOT, '2026-10-29|08'] }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(t.relayCalls).toHaveLength(1);
    const s = (await t.call('/api/state')).json;
    expect(s.votes[SLOT].length).toBe(5);
    expect(s.votes['2026-10-29|08']).toEqual([ids[4]]);
  });

  it('a save replaces the whole list: an untick removes the vote', async () => {
    const [id] = await t.addPeople(['Test Ann']);
    await t.call('/api/vote', { person_id: id, slots: ['2026-10-28|07', '2026-10-28|08'] });
    const s = (await t.call('/api/vote', { person_id: id, slots: ['2026-10-28|08'] })).json;
    expect(s.votes).toEqual({ '2026-10-28|08': [id] });
  });

  it('the key gate: 401 without it, 401 with a wrong one, health needs none and shows no people', async () => {
    await t.addPeople(['Test Ann']);
    for (const path of ['/api/state']) {
      const none = await t.call(path, undefined, { key: '' });
      expect(none.status).toBe(401);
      expect(none.json).toEqual({ error: 'This link needs the group code. Ask Kevin.' });
      expect((await t.call(path, undefined, { key: 'feedc0de1234567890abcdee' })).status).toBe(401);
    }
    for (const path of ['/api/vote', '/api/person', '/api/booked', '/api/refresh']) {
      expect((await t.call(path, { name: 'Test Bob' }, { key: '' })).status, path).toBe(401);
    }
    const health = await t.call('/api/health', undefined, { key: '' });
    expect(health.status).toBe(200);
    expect(health.json.ok).toBe(true);
    expect(health.text).not.toContain('Test Ann');
    expect(health.headers.get('X-Robots-Tag')).toContain('noindex');
  });

  it('no GROUP_KEY set means every route is shut', async () => {
    delete t.env.GROUP_KEY;
    expect((await t.call('/api/state')).status).toBe(401);
  });

  it('slot validation refuses a slot outside the window or the hours', async () => {
    const [id] = await t.addPeople(['Test Ann']);
    for (const slot of ['2026-11-03|10', '2026-10-26|10', '2026-10-28|06', '2026-10-28|22', 'garbage']) {
      expect((await t.call('/api/vote', { person_id: id, slots: [slot] })).status, slot).toBe(400);
    }
    expect((await t.call('/api/vote', { person_id: 999, slots: [SLOT] })).status).toBe(404);
    expect((await t.call('/api/booked', { slot: '2026-11-09|10', person_id: id, venue: 'si', booked: true })).status).toBe(400);
    expect((await t.call('/api/booked', { slot: SLOT, person_id: id, venue: 'xx', booked: true })).status).toBe(400);
    expect(t.rows.votes()).toEqual([]);
  });

  it('names: created once, case-insensitive, and bad ones refused', async () => {
    const a = (await t.call('/api/person', { name: '  test   ann ' })).json;
    const b = (await t.call('/api/person', { name: 'TEST ANN' })).json;
    expect(a.id).toBe(b.id);
    expect(a).toEqual({ id: a.id, name: 'test ann', venues: ['si', 'pdl', 'pp'] });
    expect((await t.call('/api/person', { name: '<script>' })).status).toBe(400);
    expect((await t.call('/api/person', { id: a.id, venues: ['si', 'nope'] })).status).toBe(400);
    expect(t.rows.people()).toHaveLength(1);
  });

  it('every response carries noindex; the page gets the security headers', async () => {
    const page = await t.call('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(page.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
    expect((await t.call('/api/state')).headers.get('X-Robots-Tag')).toContain('noindex');
    expect((await t.call('/api/state', undefined, { key: '' })).headers.get('X-Robots-Tag')).toContain('noindex');
  });

  it('a stale read kicks ONE background refresh, which reads all three venues and alerts', async () => {
    await t.seedAvailability(EVENING, NOW - 20 * 60 * 1000);
    const ids = await t.addPeople(NAMES.slice(0, 4));
    // 07:00 on Wed 28 Oct is free at St Ives in the saved page.
    for (const id of ids) await t.call('/api/vote', { person_id: id, slots: ['2026-10-28|07'] });
    expect(t.relayCalls).toHaveLength(0);                 // the seeded evening data has nothing at 07:00
    const first = (await t.call('/api/state')).json;
    expect(first.availability.stale).toBe(true);
    expect(t.waits).toHaveLength(1);
    expect((await t.call('/api/state')).json.availability.stale).toBe(true);
    expect(t.waits).toHaveLength(1);                      // the 90-second guard holds the second kick
    await Promise.all(t.waits);

    expect(t.calls.filter((c) => c.host === 'www.matchi.se')).toHaveLength(14);
    const pulse = t.calls.filter((c) => c.host.endsWith('cloudfunctions.net'));
    expect(pulse).toHaveLength(1);                        // oRPC first: one call
    const sent = JSON.parse(pulse[0].init.body);
    expect(sent).toEqual({ json: { clubId: 'VEqVgpQmiJLiEC1Lm4z3', startDateTime: '2026-10-27T00:00:00.000Z', endDateTime: '2026-11-02T23:59:59.999Z' } });
    expect(pulse[0].init.headers.Origin).toBe('https://pulsepadel.co.uk');
    for (const c of t.calls) expect(c.init.headers['User-Agent']).toMatch(/Mozilla/);

    const s = (await t.call('/api/state')).json;
    expect(s.availability.stale).toBe(false);
    expect(s.availability.venues.si['2026-10-28'].hours['07']).toEqual({ free: true, min: 60, starts: ['07:00', '07:30'], mins: [60, 60] });
    expect(s.availability.venues.si['2026-11-02']).toEqual({ status: 'closed', hours: {} });
    expect(s.availability.venues.pp['2026-10-28'].hours['21'].free).toBe(true);
    expect(t.relayCalls).toHaveLength(1);                 // the refresh found the court and sent the DM
    expect(t.relayCalls[0].body.text).toContain('Padel: 4 in for Wed 28 Oct 07:00');

    // Forced again within 90 seconds: refused. After 90 seconds: Matchi again, Pulse not (15-minute rule).
    t.setNow(NOW + 30 * 1000);
    expect((await t.call('/api/refresh', {})).json.refreshed).toBe(false);
    t.setNow(NOW + 120 * 1000);
    expect((await t.call('/api/refresh', {})).json.refreshed).toBe(true);
    expect(t.calls.filter((c) => c.host.endsWith('cloudfunctions.net'))).toHaveLength(1);
    expect(t.calls.filter((c) => c.host === 'www.matchi.se')).toHaveLength(28);
    t.setNow(NOW + 16 * 60 * 1000);
    await t.call('/api/refresh', {});
    expect(t.calls.filter((c) => c.host.endsWith('cloudfunctions.net'))).toHaveLength(2);
  });

  it('a venue that fails reads "couldn\'t check" for its dates and the others stay fresh', async () => {
    const calls = [];
    t.setFetch(venueFetch(calls, { pulse: 'down' }));
    t.setNow(NOW + 16 * 60 * 1000);                       // past the seeded read's 15-minute Pulse rule
    expect((await t.call('/api/refresh', {})).json.refreshed).toBe(true);
    let s = (await t.call('/api/state')).json;
    for (const d of s.days) expect(s.availability.venues.pp[d]).toEqual({ status: 'error', reason: 'HTTP 500', hours: {} });
    expect(s.availability.venues.si['2026-10-28'].status).toBe('ok');
    // A reply in a shape we do not know is an error too, never guessed slots.
    t.setFetch(venueFetch([], { pulse: 'odd' }));
    t.setNow(NOW + 32 * 60 * 1000);
    await t.call('/api/refresh', {});
    s = (await t.call('/api/state')).json;
    expect(s.availability.venues.pp['2026-10-28']).toEqual({ status: 'error', reason: 'unexpected shape', hours: {} });
    // Matchi timing out is an error for those dates only.
    t.setFetch(venueFetch([], { matchiFor: () => { throw new DOMException('signal timed out', 'TimeoutError'); } }));
    t.setNow(NOW + 48 * 60 * 1000);
    await t.call('/api/refresh', {});
    s = (await t.call('/api/state')).json;
    expect(s.availability.venues.si['2026-10-28']).toEqual({ status: 'error', reason: 'timed out', hours: {} });
    expect(s.availability.venues.pp['2026-10-28'].status).toBe('ok');
  });

  it('Matchi refusing us (429, as it does from Cloudflare) costs one request per venue, not seven', async () => {
    const calls = [];
    t.setFetch(venueFetch(calls, { matchiFor: () => new Response('<html><title>429 Too Many Requests</title></html>', { status: 429 }) }));
    t.setNow(NOW + 16 * 60 * 1000);
    await t.call('/api/refresh', {});
    expect(calls.filter((c) => c.host === 'www.matchi.se')).toHaveLength(2);
    const s = (await t.call('/api/state')).json;
    for (const d of s.days) {
      expect(s.availability.venues.si[d]).toEqual({ status: 'error', reason: 'HTTP 429', hours: {} });
      expect(s.availability.venues.pdl[d].status).toBe('error');
    }
    expect(s.availability.venues.pp['2026-10-28'].status).toBe('ok');
  });

  it('old votes, bookings and alerts are pruned on refresh', async () => {
    const [id] = await t.addPeople(['Test Ann']);
    await t.call('/api/vote', { person_id: id, slots: ['2026-10-27|20'] });
    t.setNow(Date.parse('2026-10-28T09:00:00Z'));
    await t.call('/api/refresh', {});
    expect(t.rows.votes()).toEqual([]);
  });
});

describe('pure state rules', () => {
  const dates = londonDates(NOW);
  const people = [1, 2, 3, 4].map((id) => ({ id, name: `P${id}`, venues: ['si', 'pdl', 'pp'] }));
  const votes = people.map((p) => ({ person_id: p.id, slot: SLOT }));
  it('an hour needs a start of 90 minutes or less', () => {
    const availability = { fetchedAt: 'x', venues: { si: { '2026-10-28': { status: 'ok', starts: { '19:00': { courts: 1, min: 120 } } } } } };
    const s = computeState({ people, votes, booked: [], availability, dates, nowMs: NOW });
    expect(s.availability.venues.si['2026-10-28'].hours).toEqual({});
    expect(s.ready).toEqual([]);
  });
  it('closed and error never count as free', () => {
    const availability = { fetchedAt: 'x', venues: { si: { '2026-10-28': { status: 'closed' } }, pdl: { '2026-10-28': { status: 'error', reason: 'HTTP 500' } } } };
    const s = computeState({ people, votes, booked: [], availability, dates, nowMs: NOW });
    expect(s.ready).toEqual([]);
    expect(s.availability.venues.pp['2026-10-28'].status).toBe('pending');
  });
  it('decideAlerts skips slots already alerted', () => {
    const s = computeState({ people, votes, booked: [], availability: { fetchedAt: 'x', venues: EVENING }, dates, nowMs: NOW });
    expect(decideAlerts(s, new Set()).map((r) => r.slot)).toEqual([SLOT]);
    expect(decideAlerts(s, new Set([SLOT]))).toEqual([]);
    expect(alertText(s.ready[0], venueConfig(), 'https://padel.kevinbrittain.workers.dev/').length).toBeLessThan(4000);
  });
});

describe('Worker entry point', () => {
  it('only exports a fetch handler (workerd refuses any other main-module export)', () => {
    expect(Object.keys(worker)).toEqual(['fetch']);
  });
});
