// The padel group's Worker (workers/padel, Kevin approved the plan on 27 Oct 2026). These drive the
// REAL parsers and the REAL request handler. The venue pages are live copies saved on 27 Oct 2026
// (tests/fixtures/padel): Matchi St Ives (2619) and PDL (3122) for Wed 28 Oct, St Ives for Thu 5 Nov
// (beyond its 7-day window), and the Pulse Padel availability reply for 27 Oct to 2 Nov. Every
// person in here is invented. The alert rules run twice: on a Map-backed repo, and on the Worker's
// own makeRepo SQL over an in-memory SQLite database built from workers/padel/schema.sql.
//
// Second pass (27 Oct 2026): Matchi refuses Cloudflare, so St Ives and PDL now arrive from the Mac
// (POST /api/courts with the robot key) and the Worker reads Pulse only. Each review finding fixed
// in that pass has its own test below, named with the finding's number.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import worker from '../workers/padel/worker.js';
import {
  parseMatchi, parsePulse, hoursFromStarts, londonParts, londonDates, londonMidnightMs, computeState,
  decideAlerts, handleRequest, makeRepo, cleanName, cleanSlots, alertText, venueConfig, callerKey,
  readPulse, checkAlerts, assembleAvailability, VERSION, RELAY_PENDING,
} from '../workers/padel/padel.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (f) => readFileSync(resolve(ROOT, 'tests/fixtures/padel', f), 'utf8');
const ST_IVES = fixture('matchi-2619-2026-10-28.html');
const PDL = fixture('matchi-3122-2026-10-28.html');
const CLOSED = fixture('matchi-2619-2026-11-05.html');
const ST_IVES_TODAY = fixture('matchi-2619-2026-10-27.html');    // read live on 27 Oct 2026 at 13:10
const PDL_TODAY = fixture('matchi-3122-2026-10-27.html');
const PULSE = JSON.parse(fixture('pulse-search.json'));
const countClass = (html, cls) => (html.match(new RegExp(`class="slot ${cls}"`, 'g')) || []).length;

// 09:45 London on Tue 27 Oct 2026 (GMT since 25 Oct): the window is 27 Oct to 2 Nov.
const NOW = Date.parse('2026-10-27T09:45:00Z');
const ROBOT = 'robot0000111122223333444455556666';
const RELAY_OK = JSON.stringify({ ok: true, sent: [{ email: 'kevin@runpreneur.org.uk', ok: true, ts: '1793000000.000100', error: null }], refused: [] });
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60 * 1000;

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

const table = (cells) => `<div class="schedule"><table id="schedule-table"><tr>${cells}</tr></table></div>`;
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
    const html = table(`<td title="Available<br>
        Court 2<br>
        18:30 - 20:00" data-slot-can-start="true" data-slot-min-duration="90" class="slot free"></td>
      <td class="slot free" data-slot-can-start="false" data-slot-min-duration="60" title="Available<br>Court 1<br> 19:00 - 20:00"></td>`);
    expect(parseMatchi(html)).toEqual({ status: 'ok', starts: { '18:30': { courts: 1, min: 90, names: ['Court 2'] } } });
  });

  it('F3: class="free slot" still parses as free (class order carries no meaning)', () => {
    const html = table('<td class="free slot" data-slot-can-start="true" data-slot-min-duration="60" title="Available<br>Court 1<br>19:00 - 20:00"></td>');
    expect(parseMatchi(html)).toEqual({ status: 'ok', starts: { '19:00': { courts: 1, min: 60, names: ['Court 1'] } } });
  });

  it('F3 and item 3: a court cell of a kind the parser does not know is an error, never "no court free"', () => {
    const html = table('<td class="slot vacant" data-slot-can-start="true" data-slot-min-duration="60" title="Available<br>Court 1<br>19:00 - 20:00"></td><td class="slot taken"></td>');
    expect(parseMatchi(html)).toEqual({ status: 'error', reason: 'unknown court cell' });
    // An empty schedule table is an error too (it used to read as "closed").
    expect(parseMatchi(table(''))).toEqual({ status: 'error', reason: 'no court cells recognised' });
    // A renamed class on a live page: one "slot red" becomes "slot booked".
    expect(parseMatchi(ST_IVES_TODAY.replace('class="slot red"', 'class="slot booked"'))).toEqual({ status: 'error', reason: 'unknown court cell' });
  });

  it('item 3: today\'s live pages (27 Oct, past hours not-available) parse, the not-available cells ignored', () => {
    expect([countClass(ST_IVES_TODAY, 'free'), countClass(ST_IVES_TODAY, 'red'), countClass(ST_IVES_TODAY, 'can-not-start'), countClass(ST_IVES_TODAY, 'not-available')]).toEqual([13, 5, 3, 26]);
    expect([countClass(PDL_TODAY, 'free'), countClass(PDL_TODAY, 'red'), countClass(PDL_TODAY, 'can-not-start'), countClass(PDL_TODAY, 'not-available')]).toEqual([7, 29, 6, 39]);
    const si = parseMatchi(ST_IVES_TODAY);
    expect(si.status).toBe('ok');
    expect(Object.values(si.starts).reduce((n, x) => n + x.courts, 0)).toBe(13);
    expect(Object.keys(si.starts).sort()[0]).toBe('13:30');            // nothing before the time the page was read
    const pdl = parseMatchi(PDL_TODAY);
    expect(pdl.status).toBe('ok');
    expect(Object.values(pdl.starts).reduce((n, x) => n + x.courts, 0)).toBe(7);
  });

  it('F4: a free, bookable cell whose title cannot be read makes the day an error', () => {
    const html = table('<td class="slot red"></td><td class="slot free" data-slot-can-start="true" data-slot-min-duration="60" title="Ledig<br>Bana 1<br>19.00"></td>');
    expect(parseMatchi(html)).toEqual({ status: 'error', reason: 'a free court cell could not be read' });
  });

  it('F4: a free, bookable cell with no minimum booking makes the day an error', () => {
    const html = table('<td class="slot free" data-slot-can-start="true" title="Available<br>Court 1<br>19:00 - 20:00"></td>');
    expect(parseMatchi(html)).toEqual({ status: 'error', reason: 'a free court cell has no minimum booking' });
  });

  it('a schedule with only not-available cells is open with no courts (grey), not closed', () => {
    expect(parseMatchi(table('<td class="slot not-available" title="x"></td>'))).toEqual({ status: 'ok', starts: {} });
  });

  it('anything that is not a schedule page is an error, never closed', () => {
    expect(parseMatchi('<html><body>Please log in</body></html>')).toEqual({ status: 'error', reason: 'not a schedule page' });
    expect(parseMatchi('<div class="schedule"><p>Maintenance</p></div>')).toEqual({ status: 'error', reason: 'no court cells recognised' });
    expect(parseMatchi(undefined).status).toBe('error');
  });
});

describe('parsePulse (the saved live reply)', () => {
  it('Wed 28 Oct starts match the widget read on 27 Oct 2026', () => {
    const r = parsePulse(PULSE.json, NOW);
    expect(r.status).toBe('ok');
    expect(Object.keys(r.byDate)).toEqual(londonDates(NOW, 7));          // the saved reply covers 7 days
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

describe('readPulse: only an HTTP 400 tries the next body format (F5)', () => {
  const dates = londonDates(NOW);
  const stub = (answer) => {
    const calls = [];
    const f = vi.fn(async (url, init) => { calls.push(JSON.parse(init.body)); return answer(calls.length, JSON.parse(init.body)); });
    return { f, calls };
  };
  it('a 503 makes exactly one call and keeps the real reason', async () => {
    const { f } = stub(() => new Response('down', { status: 503 }));
    expect(await readPulse(f, 'club', dates, NOW, 'orpc')).toEqual({ status: 'error', reason: 'HTTP 503' });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('a 429, a timeout and an unknown shape each stop at one call', async () => {
    let s = stub(() => new Response('slow', { status: 429 }));
    expect((await readPulse(s.f, 'club', dates, NOW)).reason).toBe('HTTP 429');
    expect(s.f).toHaveBeenCalledTimes(1);
    s = stub(() => { throw new DOMException('signal timed out', 'TimeoutError'); });
    expect((await readPulse(s.f, 'club', dates, NOW)).reason).toBe('timed out');
    expect(s.f).toHaveBeenCalledTimes(1);
    s = stub(() => new Response('{"json":{"availableSlots":7}}', { status: 200 }));
    expect((await readPulse(s.f, 'club', dates, NOW)).reason).toBe('unexpected shape');
    expect(s.f).toHaveBeenCalledTimes(1);
  });
  it('a 400 (body format refused) moves on, and the format that worked is reported', async () => {
    const { f, calls } = stub((n, body) => (body.json ? new Response(JSON.stringify(PULSE), { status: 200 }) : new Response('{"json":{"code":"BAD_REQUEST"}}', { status: 400 })));
    const r = await readPulse(f, 'club', dates, NOW, 'plain');
    expect(r.status).toBe('ok');
    expect(r.format).toBe('orpc');
    expect(calls.map((c) => (c.json ? 'orpc' : 'plain'))).toEqual(['plain', 'orpc']);
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
    expect(londonDates(NOW, 7)).toEqual(['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });
  it('the window is 14 days: today and the 13 days after, across the clock change', () => {
    const d = londonDates(NOW);
    expect(d).toHaveLength(14);
    expect([d[0], d[6], d[7], d[13]]).toEqual(['2026-10-27', '2026-11-02', '2026-11-03', '2026-11-09']);
    expect(londonDates(Date.parse('2026-03-25T12:00:00Z'))[13]).toBe('2026-04-07');   // over the spring change
  });
});

describe('input checks', () => {
  it('names: trimmed, spaces collapsed, 2 to 30 characters, letters, spaces, hyphens, apostrophes', () => {
    expect(cleanName('  Ann   Marie ')).toEqual({ name: 'Ann Marie' });
    expect(cleanName("Siobhán O'Neil-Smith")).toEqual({ name: "Siobhán O'Neil-Smith" });
    expect(cleanName('A').error).toBeTruthy();
    expect(cleanName('x'.repeat(31)).error).toBeTruthy();
    expect(cleanName('<b>Bob</b>').error).toBeTruthy();
    expect(cleanName('Bob2').error).toBeTruthy();
  });
  it('F15/F16/S9: Latin letters only, at least two of them; a curly apostrophe is stored straight', () => {
    expect(cleanName('Zoë Ørsted')).toEqual({ name: 'Zoë Ørsted' });
    expect(cleanName('Test O’Neil')).toEqual({ name: "Test O'Neil" });
    expect(cleanName('Zoë')).toEqual({ name: 'Zoë' });                 // a decomposed ë is stored composed
    for (const bad of ['Аnn', '李雷', 'Ann😀', '--', "' -", 'A-', 'Ann×Bob', 'Ann_B', 'Ann.B']) {
      expect(cleanName(bad).error, bad).toBeTruthy();
    }
  });
  it('slots: only the next 14 days, hours 07 to 21', () => {
    const dates = londonDates(NOW);
    expect(cleanSlots(['2026-10-28|07', '2026-11-09|21', '2026-10-28|07'], dates)).toEqual({ slots: ['2026-10-28|07', '2026-11-09|21'] });
    for (const bad of ['2026-11-10|10', '2026-10-28|06', '2026-10-28|22', '2026-10-28 07', '2026-10-28|7']) {
      expect(cleanSlots([bad], dates).error, bad).toBeTruthy();
    }
    expect(cleanSlots('2026-10-28|07', dates).error).toBeTruthy();
  });
  it('F11: a past-dated slot is dropped, not a reason to refuse the list (a page open over midnight)', () => {
    const dates = londonDates(NOW);
    expect(cleanSlots(['2026-10-26|20', '2026-10-26|21', '2026-10-27|20'], dates)).toEqual({ slots: ['2026-10-27|20'] });
    expect(cleanSlots(['2026-10-26|23'], dates).error).toBeTruthy();            // still not an hour we offer
  });
  it('F17: callerKey copies property-manager: IPv4 inside IPv6 is counted as itself', () => {
    expect(callerKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(callerKey('::ffff:1.2.3.4')).not.toBe(callerKey('::ffff:5.6.7.8'));
    expect(callerKey('2001:db8:1:2:aaaa::1')).toBe(callerKey('2001:db8:1:2:bbbb::9'));
    expect(callerKey('2001:db8:1:3::1')).not.toBe(callerKey('2001:db8:1:2::1'));
    expect(callerKey('1.2.3.4')).toBe('1.2.3.4');
    expect(callerKey('')).toBe('unknown');
  });
});

// ── Repos: the brief's Map-backed one, and the Worker's real SQL on SQLite ──
function mapRepo() {
  const people = new Map();
  let nextId = 1;
  const votes = new Map();
  const booked = new Map();
  const alerts = new Map();
  const rate = new Map();
  const cache = new Map();
  const out = (p) => ({ id: p.id, name: p.name, venues: p.venues.split(',').filter(Boolean), savedAt: p.votes_at || null });
  return {
    rows: { alerts: () => [...alerts.values()], people: () => [...people.values()], votes: () => [...votes.values()], rate: () => [...rate.values()] },
    putAlert: (row) => alerts.set(row.slot, { names: '', venues: '', relay_reply: null, ...row }),
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
      async applyVotes(pid, add, remove, now) {
        if (!add.length && !remove.length) return;
        for (const s of add) if (!votes.has(`${pid}|${s}`)) votes.set(`${pid}|${s}`, { person_id: pid, slot: s, created_at: now });
        for (const s of remove) votes.delete(`${pid}|${s}`);
        if (people.has(pid)) people.get(pid).votes_at = now;
      },
      async listBooked(from) { return [...booked.values()].filter((b) => b.slot >= from); },
      async setBooked(slot, person_id, venue, now) { booked.set(slot, { slot, person_id, venue, created_at: now }); },
      async clearBooked(slot) { booked.delete(slot); },
      async alertSlots(from) { return [...alerts.keys()].filter((s) => s >= from); },
      async claimAlert(slot, names, venues, now) {
        if (alerts.has(slot)) return false;
        alerts.set(slot, { slot, sent_at: now, names, venues, relay_reply: JSON.stringify({ claimed: true, at: now }) });
        return true;
      },
      async saveRelayReply(slot, reply) { if (alerts.has(slot)) alerts.get(slot).relay_reply = reply; },
      async countHit(key, now) { const r = rate.get(key) || { key, n: 0, created_at: now }; r.n++; rate.set(key, r); return r.n; },
      async pruneRate(before) { for (const [k, v] of [...rate]) if (v.created_at < before) rate.delete(k); },
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

// A D1 look-alike over node:sqlite, so makeRepo's own SQL (upserts, json_each, ON CONFLICT ... WHERE)
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
      rate: () => db.prepare('SELECT * FROM rate ORDER BY key').all().map((r) => ({ ...r })),
    },
    putAlert: (row) => db.prepare('INSERT INTO alerts (slot, sent_at, names, venues, relay_reply) VALUES (?, ?, ?, ?, ?)').run(row.slot, row.sent_at, row.names || '', row.venues || '', row.relay_reply ?? null),
    repo: makeRepo(d1),
  };
}

// The Worker must never fetch Matchi any more; Pulse answers with the saved reply.
function pulseFetch(calls, { pulse = 'ok' } = {}) {
  return vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ host: u.hostname, url: String(url), init });
    if (u.hostname === 'www.matchi.se') throw new Error('the Worker fetched Matchi');
    if (u.hostname.endsWith('cloudfunctions.net')) {
      if (pulse === 'down') return new Response('{"error":"boom"}', { status: 503 });
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
  const limited = { n: 0, max: Infinity, keys: [] };
  const sleeps = [];
  const env = {
    ROBOT_KEY: ROBOT,
    RELAY_KEY: 'relay-key-test',
    PAGE_URL: 'https://padel.kevinbrittain.workers.dev/',
    RELAY: { fetch: vi.fn(async (req) => { relayCalls.push({ url: req.url, key: req.headers.get('X-Relay-Key'), body: await req.json() }); return relayReply(); }) },
    WRITE_LIMIT: { limit: async ({ key }) => { limited.keys.push(key); limited.n++; return { success: limited.n <= limited.max }; } },
  };
  const ctx = { waitUntil: (p) => waits.push(p) };
  let now = NOW;
  let fetchImpl = pulseFetch(calls);
  const drain = async () => { while (waits.length) await Promise.all(waits.splice(0)); };
  const call = async (path, body, { robot, method, raw, drain: doDrain = true, ip } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (robot) headers['X-Robot-Key'] = robot;
    if (ip) headers['CF-Connecting-IP'] = ip;
    const payload = raw !== undefined ? raw : (body ? JSON.stringify(body) : undefined);
    const req = new Request(`https://padel.kevinbrittain.workers.dev${path}`, { method: method || (payload !== undefined ? 'POST' : 'GET'), headers, body: payload });
    const res = await handleRequest(req, env, ctx, h.repo, { now: () => now, fetch: fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
    if (doDrain) await drain();
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text, headers: res.headers };
  };
  return {
    ...h, env, ctx, waits, calls, relayCalls, call, drain, limited, sleeps,
    setNow: (ms) => { now = ms; },
    setRelay: (fn) => { relayReply = fn; },
    setFetch: (f) => { fetchImpl = f; },
    // The two cache rows the Worker reads: the Mac's Matchi read and the Worker's Pulse read.
    async seedAvailability(venues, matchiAt = NOW, pulseAt = matchiAt) {
      await h.repo.setCache('matchi', JSON.stringify({ readAt: iso(matchiAt), goodAt: { si: iso(matchiAt), pdl: iso(matchiAt) }, venues: { si: venues.si || {}, pdl: venues.pdl || {} } }), iso(matchiAt));
      await h.repo.setCache('pulse', JSON.stringify({ fetchedAt: iso(pulseAt), goodAt: iso(pulseAt), format: 'orpc', days: venues.pp || {} }), iso(pulseAt));
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
const strip = (day) => (day.status === 'ok' ? { status: 'ok', starts: Object.fromEntries(Object.entries(day.starts).map(([t, s]) => [t, { courts: s.courts, min: s.min }])) } : day);
// What the Mac posts: the saved pages for every date, St Ives closed on the last day.
function macBody(readAtMs = NOW) {
  const dates = londonDates(NOW);
  const si = {};
  const pdl = {};
  // St Ives opens 7 days ahead: from the 8th date its page says "not open yet" (closed). PDL opens all 14.
  dates.forEach((d, i) => { si[d] = i >= 7 ? { status: 'closed' } : strip(parseMatchi(ST_IVES)); pdl[d] = strip(parseMatchi(PDL)); });
  return { readAt: iso(readAtMs), venues: { si, pdl } };
}

describe.each([['Map repo', mapRepo], ['makeRepo SQL on SQLite', sqlRepo]])('alerts and routes (%s)', (_label, make) => {
  let t;
  beforeEach(async () => {
    t = harness(make);
    await t.seedAvailability(EVENING);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('no DM at 3, one DM at 4, none again at 5; the DM gives each venue its own count and names', async () => {
    const ids = await t.addPeople(NAMES);
    for (const id of ids.slice(0, 3)) await t.call('/api/vote', { person_id: id, add: [SLOT] });
    let s = (await t.call('/api/state')).json;
    expect(t.relayCalls).toHaveLength(0);
    expect(s.ready).toEqual([]);
    expect(s.nearly.map((n) => [n.slot, n.count])).toEqual([[SLOT, 3]]);

    // Test Eve cannot do St Ives and Test Dan only St Ives: PDL has 4 (Ann, Bob, Cat, Eve), St Ives 4
    // (Ann, Bob, Cat, Dan) once Dan ticks. Never "5 in": people are not added up across venues.
    await t.call('/api/person', { id: ids[4], venues: ['pdl', 'pp'] });
    await t.call('/api/person', { id: ids[3], venues: ['si'] });
    await t.call('/api/vote', { person_id: ids[4], add: [SLOT] });
    expect(t.relayCalls).toHaveLength(1);
    const dm = t.relayCalls[0];
    expect(dm.url).toBe('https://apple-inbound/slack-relay');
    expect(dm.key).toBe('relay-key-test');
    expect(dm.body.recipients).toEqual(['kevin@runpreneur.org.uk']);
    expect(dm.body.text).toBe('Padel: Wed 28 Oct 19:00. Cambridge: 4 in (Test Ann, Test Bob, Test Cat, Test Eve), starts 19:30 (90 min), '
      + 'book <https://www.matchi.se/book/schedule?facilityId=3122&date=2026-10-28&sport=5>. Courts checked 09:45. '
      + 'Whoever books taps Booked on the page https://padel.kevinbrittain.workers.dev/');
    const rows = t.rows.alerts();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].relay_reply).ok).toBe(true);

    s = (await t.call('/api/vote', { person_id: ids[3], add: [SLOT] })).json;
    expect(t.relayCalls).toHaveLength(1);
    expect(s.ready[0].venues.map((v) => [v.code, v.count, v.names])).toEqual([
      ['si', 4, ['Test Ann', 'Test Bob', 'Test Cat', 'Test Dan']], ['pdl', 4, ['Test Ann', 'Test Bob', 'Test Cat', 'Test Eve']],
    ]);
    expect(alertText(s.ready[0], venueConfig(), 'https://p/')).toBe('Padel: Wed 28 Oct 19:00. '
      + 'St Ives: 4 in (Test Ann, Test Bob, Test Cat, Test Dan), starts 19:00, 19:30 (60 min), book <https://www.matchi.se/book/schedule?facilityId=2619&date=2026-10-28&sport=5>. '
      + 'Cambridge: 4 in (Test Ann, Test Bob, Test Cat, Test Eve), starts 19:30 (90 min), book <https://www.matchi.se/book/schedule?facilityId=3122&date=2026-10-28&sport=5>. '
      + 'Courts checked 09:45. Whoever books taps Booked on the page https://p/');
  });

  it('F1: St Ives data 2 days old plus 4 ticks sends nothing, and the page says "couldn\'t check"', async () => {
    await t.seedAvailability(EVENING, NOW - 2 * 24 * 60 * MIN, NOW);
    const ids = await t.addPeople(NAMES.slice(0, 4));
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: [SLOT] });
    const s = (await t.call('/api/state')).json;
    expect(t.relayCalls).toHaveLength(0);
    expect(t.rows.alerts()).toHaveLength(0);
    expect(s.ready).toEqual([]);
    expect(s.nearly).toEqual([]);
    expect(s.availability.fresh).toEqual({ si: false, pdl: false, pp: true });
    expect(s.availability.venues.si['2026-10-28']).toEqual({ status: 'error', reason: 'not checked recently', hours: {} });
    expect(s.availability.checkedAt.si).toBe(iso(NOW - 2 * 24 * 60 * MIN));
  });

  it('freshness edges: Matchi counts for 45 minutes, Pulse for 20', async () => {
    const ids = await t.addPeople(NAMES.slice(0, 4));
    await t.seedAvailability(EVENING, NOW - 44 * MIN, NOW - 19 * MIN);
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: ['2026-10-29|08'] });
    let s = (await t.call('/api/state')).json;
    expect(s.availability.fresh).toEqual({ si: true, pdl: true, pp: true });
    await t.seedAvailability(EVENING, NOW - 46 * MIN, NOW - 21 * MIN);
    s = (await t.call('/api/state', undefined, { drain: false })).json;
    expect(s.availability.fresh).toEqual({ si: false, pdl: false, pp: false });
    expect(s.ready).toEqual([]);
    expect(s.nearly).toEqual([]);
  });

  it('item 1 (6th pass): a claim is final; the row carries a claimed marker from the start', async () => {
    expect(await t.repo.claimAlert('2026-10-28|08', 'a', 'si', iso(NOW))).toBe(true);
    expect(await t.repo.claimAlert('2026-10-28|08', 'a', 'si', iso(NOW + 3 * MIN))).toBe(false);
    expect(t.rows.alerts().map((r) => [r.slot, JSON.parse(r.relay_reply)])).toEqual([['2026-10-28|08', { claimed: true, at: iso(NOW) }]]);
  });

  it('item 1 (6th pass): a Worker killed right after the claim leaves the slot claimed: no DM 10 s or 3 min later', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ids = await t.addPeople(NAMES.slice(0, 4));
    // The "kill": the relay call throws and no reply can be written, so only the claim is left.
    t.env.RELAY.fetch = vi.fn(async () => { throw new Error('the isolate went away'); });
    t.repo.saveRelayReply = vi.fn(async () => { throw new Error('the isolate went away'); });
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: [SLOT] });
    expect(t.env.RELAY.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(t.rows.alerts()[0].relay_reply)).toEqual({ claimed: true, at: iso(NOW) });
    t.env.RELAY.fetch = vi.fn(async () => new Response(RELAY_OK, { status: 200 }));
    for (const later of [NOW + 10 * 1000, NOW + 3 * MIN]) {
      t.setNow(later);
      await t.call('/api/vote', { person_id: ids[0], add: ['2026-10-29|08'] });
      await t.call('/api/state');
    }
    expect(t.env.RELAY.fetch).not.toHaveBeenCalled();
  });

  it('item 1 (6th pass): a relay that throws (not a timeout) writes its error marker, and the slot is final', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ids = await t.addPeople(NAMES.slice(0, 4));
    t.env.RELAY.fetch = vi.fn(async () => { throw new TypeError('network connection lost'); });
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: [SLOT] });
    expect(JSON.parse(t.rows.alerts()[0].relay_reply)).toEqual({ error: 'network connection lost', at: iso(NOW) });
    await t.call('/api/state');
    expect(t.env.RELAY.fetch).toHaveBeenCalledTimes(1);
  });

  it('item 1 (6th pass): with 3 slots due and a relay that hangs 20 s, a check claims only the first; the next check the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const ids = await t.addPeople(NAMES.slice(0, 4));
    const slots = ['2026-10-28|19', '2026-10-29|08', '2026-10-29|09'];
    await t.seedAvailability({ ...EVENING, si: { ...EVENING.si, '2026-10-29': { status: 'ok', starts: { '08:00': { courts: 1, min: 60 }, '09:00': { courts: 1, min: 60 } } } } });
    t.env.RELAY = undefined;                                   // build the votes with no DM going
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: slots });
    expect(t.rows.alerts()).toEqual([]);                       // relay not configured: nothing is claimed
    t.env.RELAY = { fetch: vi.fn(() => new Promise(() => {})) };
    const state = (await t.call('/api/state', undefined, { drain: false })).json;
    expect(state.ready.map((r) => r.slot)).toEqual(slots);
    const p = checkAlerts(state, t.env, t.repo, NOW, async () => {});
    await vi.advanceTimersByTimeAsync(20001);
    expect(await p).toEqual([]);
    expect(t.rows.alerts().map((r) => r.slot)).toEqual([slots[0]]);   // the 5 s budget was spent on the first
    t.env.RELAY = { fetch: vi.fn(async () => new Response(RELAY_OK, { status: 200 })) };
    expect(await checkAlerts(state, t.env, t.repo, NOW + 30 * 1000, async () => {})).toEqual(slots.slice(1));
    vi.useRealTimers();
    expect(t.rows.alerts().map((r) => r.slot).sort()).toEqual(slots);
  });

  it('F9: relay 200 then every reply write fails: one DM, the claimed row kept, pauses of 0.5, 1 and 2 s, no second DM', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.repo.saveRelayReply = vi.fn(async () => { throw new Error('D1 busy'); });
    const ids = await t.addPeople(NAMES);
    for (const id of ids.slice(0, 4)) await t.call('/api/vote', { person_id: id, add: [SLOT] });
    expect(t.relayCalls).toHaveLength(1);
    expect(t.rows.alerts()).toHaveLength(1);                // the claimed row stays: the DM went
    expect(t.repo.saveRelayReply).toHaveBeenCalledTimes(4);  // the write and 3 retries
    expect(t.sleeps).toEqual([500, 1000, 2000]);
    expect(err).toHaveBeenCalledWith('padel: DM sent, reply not saved', SLOT, 'attempt 4', expect.stringContaining('D1 busy'));
    await t.call('/api/vote', { person_id: ids[4], add: [SLOT] });
    await t.call('/api/state');
    expect(t.relayCalls).toHaveLength(1);
  });

  it('item 1: relay 200, the reply write fails twice then succeeds: one DM and the relay reply stored', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = t.repo.saveRelayReply.bind(t.repo);
    let n = 0;
    t.repo.saveRelayReply = vi.fn(async (slot, reply) => { n++; if (n <= 2) throw new Error('D1 busy'); return real(slot, reply); });
    const ids = await t.addPeople(NAMES.slice(0, 4));
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: [SLOT] });
    expect(t.relayCalls).toHaveLength(1);
    expect(t.repo.saveRelayReply.mock.calls.map((c) => c[1])).toEqual([RELAY_OK, RELAY_OK, RELAY_OK]);
    expect(t.sleeps).toEqual([500, 1000]);
    expect(t.rows.alerts().map((r) => [r.slot, r.relay_reply])).toEqual([[SLOT, RELAY_OK]]);
  });

  it('item 2: a relay 200 whose body stalls leaves the placeholder, so no re-claim 3 minutes later', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const ids = await t.addPeople(NAMES.slice(0, 4));
    t.env.RELAY.fetch = vi.fn(async () => new Response(new ReadableStream({ start() {} }), { status: 200 }));
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: [SLOT] }, { drain: false });
    const p = t.drain();
    await vi.advanceTimersByTimeAsync(8001);
    await p;
    expect(t.env.RELAY.fetch).toHaveBeenCalledTimes(1);
    expect(t.rows.alerts().map((r) => r.relay_reply)).toEqual([RELAY_PENDING]);
    t.setNow(NOW + 3 * MIN);
    vi.useRealTimers();
    await t.call('/api/vote', { person_id: ids[0], add: ['2026-10-29|08'] });
    await t.call('/api/state');
    expect(t.env.RELAY.fetch).toHaveBeenCalledTimes(1);
  });



  it('a save stamps the person with savedAt, the time of their last save', async () => {
    const [id] = await t.addPeople(['Test Ann']);
    expect((await t.call('/api/state')).json.people[0].savedAt).toBeNull();
    t.setNow(NOW + MIN);
    let s = (await t.call('/api/vote', { person_id: id, add: ['2026-10-28|07'] })).json;
    expect(s.people[0]).toMatchObject({ id, savedAt: iso(NOW + MIN) });
    // Item 4: an empty save changes nothing, so it does not move the stamp.
    t.setNow(NOW + 2 * MIN);
    s = (await t.call('/api/vote', { person_id: id, add: [], remove: [] })).json;
    expect(s.people[0]).toMatchObject({ id, savedAt: iso(NOW + MIN) });
    expect(s.votes).toEqual({ '2026-10-28|07': [id] });
  });

  it('B1: a 502 from the relay leaves the row final with its marker; a later check sends nothing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.setRelay(() => new Response('{"ok":false,"sent":[{"ok":false,"error":"channel_not_found"}]}', { status: 502 }));
    const ids = await t.addPeople(NAMES.slice(0, 4));
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: [SLOT] });
    expect(t.relayCalls).toHaveLength(1);
    const rows = t.rows.alerts();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].relay_reply)).toEqual({ relay: 502, body: '{"ok":false,"sent":[{"ok":false,"error":"channel_not_found"}]}', at: iso(NOW) });
    expect(err).toHaveBeenCalledWith('padel: alert DM refused, not retried', SLOT, expect.stringContaining('relay HTTP 502'));
    t.setRelay(() => new Response(RELAY_OK, { status: 200 }));
    t.setNow(NOW + 3 * MIN);
    await t.call('/api/vote', { person_id: ids[0], add: ['2026-10-29|08'] });
    await t.call('/api/state');
    expect(t.relayCalls).toHaveLength(1);                    // never sent twice
  });

  it('B3: a 503 whose body never finishes ends at 5 s with the final marker written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const ids = await t.addPeople(NAMES.slice(0, 4));
    t.env.RELAY.fetch = vi.fn(async () => new Response(new ReadableStream({ start() {} }), { status: 503 }));
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: [SLOT] }, { drain: false });
    const p = t.drain();
    await vi.advanceTimersByTimeAsync(4900);
    expect(JSON.parse(t.rows.alerts()[0].relay_reply)).toEqual({ claimed: true, at: iso(NOW) });   // still reading at 4.9 s
    await vi.advanceTimersByTimeAsync(200);
    await p;
    vi.useRealTimers();
    expect(JSON.parse(t.rows.alerts()[0].relay_reply)).toEqual({ relay: 503, body: '(reply unreadable)', at: iso(NOW) });
    expect(t.env.RELAY.fetch).toHaveBeenCalledTimes(1);
  });

  it('B2: claims stop 5 s after the background work started: after a 24 s Pulse read nothing is claimed; a later check claims', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    // Pulse is due, and free at 21:00 on 28 Oct: four people tick it while Pulse reads as stale.
    await t.seedAvailability({ si: {}, pdl: {} }, NOW, NOW - 20 * MIN);
    const ids = await t.addPeople(NAMES.slice(0, 4));
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: ['2026-10-28|21'] }, { drain: false });
    await t.drain();
    expect(t.relayCalls).toHaveLength(0);
    // The lazy refresh (GET /api/state) reads Pulse; this read takes 24 s.
    const slow = pulseFetch([]);
    t.setFetch(vi.fn(async (url, init) => { await new Promise((r) => setTimeout(r, 24 * 1000)); return slow(url, init); }));
    await t.call('/api/state', undefined, { drain: false });
    expect(t.waits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(24 * 1000 + 10);
    await Promise.all(t.waits.splice(0));
    expect(t.relayCalls).toHaveLength(0);                    // Pulse is fresh now, but the window was spent
    expect(t.rows.alerts()).toEqual([]);
    // The next check (a vote, its own background work) claims the slot.
    await t.call('/api/vote', { person_id: ids[0], add: ['2026-10-29|20'] });
    vi.useRealTimers();
    expect(t.relayCalls).toHaveLength(1);
    expect(t.relayCalls[0].body.text).toContain('Padel: Wed 28 Oct 21:00. Huntingdon: 4 in');
  });

  it('F20 and item 2: the vote answers before the DM; a relay that hangs is cut off at 20 s and the row made final', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ids = await t.addPeople(NAMES.slice(0, 4));
    for (const id of ids.slice(0, 3)) await t.call('/api/vote', { person_id: id, add: [SLOT] });
    let release;
    t.env.RELAY.fetch = vi.fn(() => new Promise((r) => { release = r; }));
    const res = await t.call('/api/vote', { person_id: ids[3], add: [SLOT] }, { drain: false });
    expect(res.status).toBe(200);
    expect(res.json.ready.map((r) => r.slot)).toEqual([SLOT]);   // the state computed before the check
    expect(t.waits).toHaveLength(1);                              // the DM runs in waitUntil
    expect(t.env.RELAY.fetch).toHaveBeenCalledTimes(1);
    release(new Response(RELAY_OK, { status: 200 }));
    await t.drain();
    expect(t.rows.alerts()[0].relay_reply).toBe(RELAY_OK);

    // A relay that never answers: cut off at 20 s, and the row gets a final placeholder reply.
    vi.useFakeTimers();
    t.env.RELAY.fetch = vi.fn(() => new Promise(() => {}));
    const state = (await t.call('/api/state', undefined, { drain: false })).json;
    state.ready = [{ ...state.ready[0], slot: '2026-10-29|19' }];
    const p = checkAlerts(state, t.env, t.repo, NOW, async () => {});
    await vi.advanceTimersByTimeAsync(19000);
    expect(JSON.parse(t.rows.alerts().find((r) => r.slot === '2026-10-29|19').relay_reply)).toEqual({ claimed: true, at: iso(NOW) });   // still waiting at 19 s
    await vi.advanceTimersByTimeAsync(1001);
    expect(await p).toEqual([]);
    vi.useRealTimers();
    const row = t.rows.alerts().find((r) => r.slot === '2026-10-29|19');
    expect(JSON.parse(row.relay_reply)).toEqual({ timeout: true, at: iso(NOW) });
    expect(err).toHaveBeenCalledWith('padel: alert DM unanswered, not retried', '2026-10-29|19', expect.stringContaining('timed out'));
    // Never claimed again: a check 10 s later, and one 3 minutes later, send nothing.
    t.env.RELAY.fetch = vi.fn(async () => new Response(RELAY_OK, { status: 200 }));
    expect(await checkAlerts(state, t.env, t.repo, NOW + 10 * 1000, async () => {})).toEqual([]);
    expect(await checkAlerts(state, t.env, t.repo, NOW + 3 * MIN, async () => {})).toEqual([]);
    expect(t.env.RELAY.fetch).not.toHaveBeenCalled();
  });

  it('item 7: /api/refresh runs the alert check in the background: a relay that never answers does not hold the reply', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Pulse last read 20 minutes ago: not fresh, so the votes alone send nothing.
    await t.seedAvailability({ si: {}, pdl: {} }, NOW, NOW - 20 * MIN);
    const ids = await t.addPeople(NAMES.slice(0, 4));
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: ['2026-10-28|21'] }, { drain: false });
    await t.drain();
    expect(t.relayCalls).toHaveLength(0);
    vi.useFakeTimers();
    t.env.RELAY.fetch = vi.fn(() => new Promise(() => {}));
    const r = await t.call('/api/refresh', {}, { drain: false });
    expect(r.status).toBe(200);                              // answered while the relay still hangs
    expect(r.json.refreshed).toBe(true);
    expect(t.waits).toHaveLength(1);                         // the check was handed to waitUntil
    expect(t.env.RELAY.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20001);
    await Promise.all(t.waits.splice(0));
    vi.useRealTimers();
    expect(JSON.parse(t.rows.alerts()[0].relay_reply).timeout).toBe(true);
  });

  it('no DM when the only free venue is one the 4th person cannot do', async () => {
    await t.seedAvailability({ si: EVENING.si, pdl: { '2026-10-28': { status: 'closed' } }, pp: { '2026-10-28': { status: 'error', reason: 'HTTP 500' } } });
    const ids = await t.addPeople(NAMES.slice(0, 4));
    expect((await t.call('/api/person', { id: ids[3], venues: ['pdl', 'pp'] })).json.venues).toEqual(['pdl', 'pp']);
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: [SLOT] });
    const s = (await t.call('/api/state')).json;
    expect(t.relayCalls).toHaveLength(0);
    expect(s.ready).toEqual([]);
    expect(s.nearly.map((n) => [n.slot, n.count, n.venues.map((v) => v.code)])).toEqual([[SLOT, 3, ['si']]]);
  });

  it('no DM for a booked slot', async () => {
    const ids = await t.addPeople(NAMES.slice(0, 4));
    expect((await t.call('/api/booked', { slot: SLOT, person_id: ids[0], venue: 'si', booked: true })).status).toBe(200);
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: [SLOT] });
    const s = (await t.call('/api/state')).json;
    expect(t.relayCalls).toHaveLength(0);
    expect(s.ready).toEqual([]);
    expect(s.booked[SLOT]).toEqual({ person_id: ids[0], venue: 'si' });
    // Undo the booking: the slot is ready again and the next save sends its one DM.
    await t.call('/api/booked', { slot: SLOT, booked: false });
    await t.call('/api/vote', { person_id: ids[0], add: [SLOT] });
    expect(t.relayCalls).toHaveLength(1);
  });

  it('two saves at once send one DM, and both saves persist', async () => {
    const ids = await t.addPeople(NAMES);
    for (const id of ids.slice(0, 3)) await t.call('/api/vote', { person_id: id, add: [SLOT] });
    const [a, b] = await Promise.all([
      t.call('/api/vote', { person_id: ids[3], add: [SLOT] }),
      t.call('/api/vote', { person_id: ids[4], add: [SLOT, '2026-10-29|08'] }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(t.relayCalls).toHaveLength(1);
    const s = (await t.call('/api/state')).json;
    expect(s.votes[SLOT].length).toBe(5);
    expect(s.votes['2026-10-29|08']).toEqual([ids[4]]);
  });

  it('item 1: a save is a change: add, remove, both at once, and an empty save', async () => {
    const [id] = await t.addPeople(['Test Ann']);
    let s = (await t.call('/api/vote', { person_id: id, add: ['2026-10-28|07', '2026-10-28|08'] })).json;
    expect(s.votes).toEqual({ '2026-10-28|07': [id], '2026-10-28|08': [id] });
    s = (await t.call('/api/vote', { person_id: id, remove: ['2026-10-28|07'] })).json;
    expect(s.votes).toEqual({ '2026-10-28|08': [id] });
    s = (await t.call('/api/vote', { person_id: id, add: ['2026-10-29|10'], remove: ['2026-10-28|08', '2026-10-30|11'] })).json;
    expect(s.votes).toEqual({ '2026-10-29|10': [id] });                 // removing an hour never ticked is a no-op
    s = (await t.call('/api/vote', { person_id: id, add: ['2026-10-29|10'] })).json;
    expect(s.votes).toEqual({ '2026-10-29|10': [id] });                 // adding twice is a no-op
    expect((await t.call('/api/vote', { person_id: id })).status).toBe(200);
  });

  it('item 1: two phones adding different hours merge instead of overwriting (review finding 10)', async () => {
    const [id] = await t.addPeople(['Test Ann']);
    await t.call('/api/vote', { person_id: id, add: ['2026-10-28|07'] });     // phone A
    await t.call('/api/vote', { person_id: id, add: ['2026-10-29|20'] });     // phone B, which never saw 07
    expect((await t.call('/api/state')).json.votes).toEqual({ '2026-10-28|07': [id], '2026-10-29|20': [id] });
  });

  it('item 1: past hours are dropped from add and remove; an hour in both lists, or the old slots list, is refused', async () => {
    const [id] = await t.addPeople(['Test Ann']);
    expect((await t.call('/api/vote', { person_id: id, add: ['2026-10-26|20', '2026-10-27|20'], remove: ['2026-10-26|21'] })).json.votes).toEqual({ '2026-10-27|20': [id] });
    const both = await t.call('/api/vote', { person_id: id, add: ['2026-10-28|07'], remove: ['2026-10-28|07'] });
    expect(both).toMatchObject({ status: 400, json: { error: 'An hour cannot be added and removed at once: 2026-10-28|07' } });
    expect((await t.call('/api/vote', { person_id: id, remove: ['2026-11-10|10'] })).status).toBe(400);
    expect((await t.call('/api/vote', { person_id: id, add: 'x' })).status).toBe(400);
    expect((await t.call('/api/vote', { person_id: id, slots: ['2026-10-28|07'] })).status).toBe(400);
    expect(t.rows.votes().map((v) => v.slot)).toEqual(['2026-10-27|20']);
  });

  it('no code (Kevin, 27 Oct 2026): the page routes answer with no header at all, /api/ping is gone, health says only ok and version', async () => {
    await t.addPeople(['Test Ann']);
    expect((await t.call('/api/state')).status).toBe(200);
    expect((await t.call('/api/refresh', {})).status).toBe(200);
    const made = await t.call('/api/person', { name: 'Test Bob' });
    expect(made.status).toBe(200);
    expect(made.json.name).toBe('Test Bob');
    expect((await t.call('/api/vote', { person_id: made.json.id, add: ['2026-10-28|19'], remove: [] })).status).toBe(200);
    expect((await t.call('/api/booked', { slot: '2026-10-28|19', person_id: made.json.id, venue: 'pdl', booked: true })).status).toBe(200);
    expect(t.rows.people().map((p) => p.name)).toEqual(['Test Ann', 'Test Bob']);
    expect((await t.call('/api/ping')).status).toBe(404);
    const health = await t.call('/api/health');
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ ok: true, version: VERSION });
    expect(health.headers.get('X-Robots-Tag')).toContain('noindex');
  });

  it('S1: every /api request is rate limited per caller, GETs included', async () => {
    t.limited.max = 2;
    expect((await t.call('/api/health', undefined, { ip: '::ffff:1.2.3.4' })).status).toBe(200);
    expect((await t.call('/api/state', undefined, { ip: '::ffff:1.2.3.4' })).status).toBe(200);
    expect((await t.call('/api/state', undefined, { ip: '::ffff:1.2.3.4' })).status).toBe(429);
    expect((await t.call('/api/courts', undefined, { robot: ROBOT })).status).toBe(429);
    expect(t.limited.keys.slice(0, 3)).toEqual(['1.2.3.4', '1.2.3.4', '1.2.3.4']);
  });

  describe('the D1 rate limit: 60 requests a minute per client, every /api route', () => {
    const hitN = async (n, opts) => { const out = []; for (let i = 0; i < n; i++) out.push((await t.call('/api/health', undefined, { drain: false, ...opts })).status); return out; };
    it('60 requests in one minute pass, the 61st is 429, and a new minute passes again', async () => {
      expect(new Set(await hitN(60, { ip: '1.2.3.4' }))).toEqual(new Set([200]));
      const r61 = await t.call('/api/health', undefined, { ip: '1.2.3.4' });
      expect(r61).toMatchObject({ status: 429, json: { error: 'slow down' } });
      const stateToo = await t.call('/api/state', undefined, { ip: '1.2.3.4' });
      expect(stateToo.status).toBe(429);                     // every route, not only health
      t.setNow(NOW + 60 * 1000);
      expect((await t.call('/api/health', undefined, { ip: '1.2.3.4' })).status).toBe(200);
      expect(t.rows.rate().map((r) => [r.key, r.n])).toEqual([[`1.2.3.4|${Math.floor(NOW / 60000)}`, 62], [`1.2.3.4|${Math.floor(NOW / 60000) + 1}`, 1]]);
    });
    it('two different clients count apart; an IPv6 /64 counts as one client', async () => {
      await hitN(60, { ip: '1.2.3.4' });
      expect((await t.call('/api/health', undefined, { ip: '5.6.7.8' })).status).toBe(200);
      expect((await t.call('/api/health', undefined, { ip: '1.2.3.4' })).status).toBe(429);
      await hitN(60, { ip: '2001:db8:1:2::1' });
      expect((await t.call('/api/health', undefined, { ip: '2001:db8:1:2:ffff::9' })).status).toBe(429);
      expect((await t.call('/api/health', undefined, { ip: '2001:db8:1:3::1' })).status).toBe(200);
    });
    it('the Mac post deletes rate rows older than 10 minutes', async () => {
      await hitN(3, { ip: '1.2.3.4' });
      t.setNow(NOW + 11 * MIN);
      expect((await t.call('/api/courts', macBody(NOW + 11 * MIN), { robot: ROBOT })).status).toBe(200);
      expect(t.rows.rate().map((r) => r.key)).toEqual([`unknown|${Math.floor((NOW + 11 * MIN) / 60000)}`]);
    });
    it('a D1 failure in the count lets the request through (fail open) and logs it', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      t.repo.countHit = vi.fn(async () => { throw new Error('D1 overloaded'); });
      expect((await t.call('/api/health', undefined, {})).status).toBe(200);
      expect((await t.call('/api/state')).status).toBe(200);
      expect(err).toHaveBeenCalledWith('padel: rate count failed, request let through', expect.stringContaining('D1 overloaded'));
    });
  });

  it('no ROBOT_KEY means /api/courts is shut', async () => {
    delete t.env.ROBOT_KEY;
    expect((await t.call('/api/courts', undefined, { robot: ROBOT })).status).toBe(401);
    expect((await t.call('/api/courts', undefined, { robot: '' })).status).toBe(401);
  });

  it('slot validation refuses a slot outside the window or the hours', async () => {
    const [id] = await t.addPeople(['Test Ann']);
    for (const slot of ['2026-11-10|10', '2026-10-28|06', '2026-10-28|22', 'garbage']) {
      expect((await t.call('/api/vote', { person_id: id, add: [slot] })).status, slot).toBe(400);
    }
    expect((await t.call('/api/vote', { person_id: 999, add: [SLOT] })).status).toBe(404);
    expect((await t.call('/api/booked', { slot: '2026-11-12|10', person_id: id, venue: 'si', booked: true })).status).toBe(400);
    expect((await t.call('/api/booked', { slot: '2026-10-26|10', person_id: id, venue: 'si', booked: true })).status).toBe(400);
    expect((await t.call('/api/booked', { slot: SLOT, person_id: id, venue: 'xx', booked: true })).status).toBe(400);
    expect(t.rows.votes()).toEqual([]);
  });

  it('F11: a save from a page left open over midnight drops yesterday and keeps today', async () => {
    const [id] = await t.addPeople(['Test Ann']);
    const r = await t.call('/api/vote', { person_id: id, add: ['2026-10-26|20', '2026-10-27|20'] });
    expect(r.status).toBe(200);
    expect(r.json.votes).toEqual({ '2026-10-27|20': [id] });
  });

  it('names: created once, case and accents folded, and bad ones refused', async () => {
    const a = (await t.call('/api/person', { name: '  test   ann ' })).json;
    const b = (await t.call('/api/person', { name: 'TEST ANN' })).json;
    expect(a.id).toBe(b.id);
    expect(a).toEqual({ id: a.id, name: 'test ann', venues: ['si', 'pdl', 'pp'], savedAt: null });
    const z = (await t.call('/api/person', { name: 'Test Zoë' })).json;
    expect((await t.call('/api/person', { name: 'TEST ZOË' })).json.id).toBe(z.id);
    expect((await t.call('/api/person', { name: 'test zoe' })).json.id).toBe(z.id);
    expect((await t.call('/api/person', { name: 'Test O’Neil' })).json.name).toBe("Test O'Neil");
    expect((await t.call('/api/person', { name: "TEST O'NEIL" })).json.name).toBe("Test O'Neil");
    expect((await t.call('/api/person', { name: '<script>' })).status).toBe(400);
    expect((await t.call('/api/person', { name: 'Тest Ann' })).status).toBe(400);   // a Cyrillic T
    expect((await t.call('/api/person', { id: a.id, venues: ['si', 'nope'] })).status).toBe(400);
    expect(t.rows.people()).toHaveLength(3);
  });

  it('S8: the body limit counts bytes, not characters', async () => {
    const r = await t.call('/api/person', undefined, { raw: JSON.stringify({ name: '€'.repeat(6000) }) });   // 6,000 characters, 18,000 bytes
    expect(r.status).toBe(413);
  });

  it('the page is not this Worker\'s: any non-/api path is a 404 with noindex', async () => {
    const page = await t.call('/');
    expect(page.status).toBe(404);
    expect(page.headers.get('X-Robots-Tag')).toContain('noindex');
    expect((await t.call('/api/state')).headers.get('X-Robots-Tag')).toContain('noindex');
  });

  it('a stale Pulse read kicks ONE background read of Pulse only (never Matchi), then alerts', async () => {
    await t.seedAvailability({ si: EVENING.si, pdl: EVENING.pdl }, NOW, NOW - 20 * MIN);
    const ids = await t.addPeople(NAMES.slice(0, 4));
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: ['2026-10-28|21'] }, { drain: false });
    await t.drain();
    expect(t.relayCalls).toHaveLength(0);                 // nothing free at 21:00 yet, Pulse is not fresh
    const first = (await t.call('/api/state', undefined, { drain: false })).json;
    expect(first.availability.stale).toBe(true);
    expect(t.waits).toHaveLength(1);
    await t.call('/api/state', undefined, { drain: false });   // stale or just refreshed, it never kicks a second read
    expect(t.waits).toHaveLength(1);                      // the 90-second guard holds the second kick
    await t.drain();

    expect(t.calls.filter((c) => c.host === 'www.matchi.se')).toHaveLength(0);
    const pulse = t.calls.filter((c) => c.host.endsWith('cloudfunctions.net'));
    expect(pulse).toHaveLength(1);                        // oRPC first: one call
    expect(JSON.parse(pulse[0].init.body)).toEqual({ json: { clubId: 'VEqVgpQmiJLiEC1Lm4z3', startDateTime: '2026-10-27T00:00:00.000Z', endDateTime: '2026-11-09T23:59:59.999Z' } });   // the Pulse search covers all 14 days
    expect(pulse[0].init.headers.Origin).toBe('https://pulsepadel.co.uk');

    const s = (await t.call('/api/state')).json;
    expect(s.availability.stale).toBe(false);
    expect(s.availability.venues.pp['2026-10-28'].hours['21'].free).toBe(true);
    expect(s.availability.venues.si['2026-10-28'].hours['19'].free).toBe(true);   // the Mac's days are kept
    expect(t.relayCalls).toHaveLength(1);                 // the read found the court and sent the DM
    expect(t.relayCalls[0].body.text).toContain('Padel: Wed 28 Oct 21:00. Huntingdon: 4 in');

    // Forced within 15 minutes: Pulse is not called again.
    t.setNow(NOW + 2 * MIN);
    expect((await t.call('/api/refresh', {})).json.refreshed).toBe(false);
    t.setNow(NOW + 16 * MIN);
    expect((await t.call('/api/refresh', {})).json.refreshed).toBe(true);
    expect(t.calls.filter((c) => c.host.endsWith('cloudfunctions.net'))).toHaveLength(2);
  });

  it('Pulse failing reads "couldn\'t check" for its dates and keeps its last good read time', async () => {
    t.setFetch(pulseFetch(t.calls, { pulse: 'down' }));
    t.setNow(NOW + 16 * MIN);
    expect((await t.call('/api/refresh', {})).json.refreshed).toBe(true);
    let s = (await t.call('/api/state')).json;
    for (const d of s.days) expect(s.availability.venues.pp[d]).toEqual({ status: 'error', reason: 'HTTP 503', hours: {} });
    expect(t.calls.filter((c) => c.host.endsWith('cloudfunctions.net'))).toHaveLength(1);   // F5: one call on a 503
    expect(s.availability.checkedAt.pp).toBe(iso(NOW));
    t.setFetch(pulseFetch([], { pulse: 'odd' }));
    t.setNow(NOW + 32 * MIN);
    await t.call('/api/refresh', {});
    s = (await t.call('/api/state')).json;
    expect(s.availability.venues.pp['2026-10-28']).toEqual({ status: 'error', reason: 'unexpected shape', hours: {} });
  });

  it('old votes, bookings and alerts are pruned on a Pulse read', async () => {
    const [id] = await t.addPeople(['Test Ann']);
    await t.call('/api/vote', { person_id: id, add: ['2026-10-27|20'] });
    t.setNow(Date.parse('2026-10-28T09:00:00Z'));
    await t.call('/api/refresh', {});
    expect(t.rows.votes()).toEqual([]);
  });

  describe('POST /api/courts (the Mac\'s Matchi read)', () => {
    it('needs the robot key: none, another key, or a wrong one is 401', async () => {
      for (const robot of ['', 'feedc0de1234567890abcdef', `${ROBOT}x`]) expect((await t.call('/api/courts', macBody(), { robot })).status, robot).toBe(401);
    });

    it('stores the saved pages, reads Pulse once (it is due), alerts, and answers with both read times', async () => {
      await t.seedAvailability({}, NOW - 60 * MIN);
      const ids = await t.addPeople(NAMES.slice(0, 4));
      for (const id of ids) await t.call('/api/vote', { person_id: id, add: ['2026-10-28|07'] }, { drain: false });
      await t.drain();
      t.relayCalls.length = 0;
      t.calls.length = 0;
      const body = macBody(NOW - 30 * 1000);
      expect([Object.keys(body.venues.si).length, Object.keys(body.venues.pdl).length]).toEqual([14, 14]);   // 14 dates per venue
      const r = await t.call('/api/courts', body, { robot: ROBOT, drain: false });
      expect(r.status).toBe(200);
      // The alert check runs in waitUntil: the reply only says it is under way.
      expect(r.json).toEqual({ ok: true, matchiFetchedAt: iso(NOW - 30 * 1000), pulseFetchedAt: iso(NOW), alerted: 'checking', ready: 1 });
      expect(t.waits).toHaveLength(1);                        // handed to waitUntil, not awaited by the reply
      await t.drain();
      expect(t.calls.filter((c) => c.host.endsWith('cloudfunctions.net'))).toHaveLength(1);
      expect(t.relayCalls).toHaveLength(1);
      expect(t.relayCalls[0].body.text).toMatch(/^Padel: Wed 28 Oct 07:00\. St Ives: 4 in .* Huntingdon: 4 in .* Courts checked: St Ives 09:44, Huntingdon 09:45\./);
      const s = (await t.call('/api/state')).json;
      expect(s.availability.venues.si['2026-10-28'].hours['07']).toEqual({ free: true, min: 60, starts: ['07:00', '07:30'], mins: [60, 60] });
      // St Ives day 10 (5 Nov) is beyond its booking window: "not open yet", never counted.
      expect(s.availability.venues.si['2026-11-05']).toEqual({ status: 'closed', hours: {} });
      expect(s.availability.venues.pdl['2026-11-09'].status).toBe('ok');
      expect(s.availability.venues.pdl['2026-10-28'].hours['09'].free).toBe(true);
      expect(s.availability.checkedAt).toEqual({ si: iso(NOW - 30 * 1000), pdl: iso(NOW - 30 * 1000), pp: iso(NOW) });

      const g = await t.call('/api/courts', undefined, { robot: ROBOT });
      expect(g.json).toEqual({
        ok: true, version: VERSION, matchiFetchedAt: iso(NOW - 30 * 1000), pulseFetchedAt: iso(NOW),
        venueStatus: { si: { ok: 7, closed: 7 }, pdl: { ok: 14 }, pp: { ok: 14 } },
      });
    });

    it('does not call Pulse when its last read is under 15 minutes old', async () => {
      t.setNow(NOW + 5 * MIN);
      expect((await t.call('/api/courts', macBody(NOW + 5 * MIN), { robot: ROBOT })).status).toBe(200);
      expect(t.calls).toHaveLength(0);
    });

    it('refuses a read older (or newer) than 10 minutes: the Mac may have slept mid-run', async () => {
      expect((await t.call('/api/courts', macBody(NOW - 11 * MIN), { robot: ROBOT })).json).toEqual({ error: 'readAt is not within 10 minutes of now' });
      expect((await t.call('/api/courts', macBody(NOW + 11 * MIN), { robot: ROBOT })).status).toBe(400);
      expect((await t.call('/api/courts', { ...macBody(), readAt: 'yesterday' }, { robot: ROBOT })).status).toBe(400);
    });

    it('refuses a read older than the one stored (409)', async () => {
      expect((await t.call('/api/courts', macBody(NOW), { robot: ROBOT })).status).toBe(200);
      expect((await t.call('/api/courts', macBody(NOW - MIN), { robot: ROBOT })).status).toBe(409);
    });

    it('validates strictly: venues, statuses, start times, whole numbers', async () => {
      const PDL_OK = { '2026-10-28': { status: 'closed' } };
      const day = (d) => ({ readAt: iso(NOW), venues: { si: { '2026-10-28': d }, pdl: PDL_OK } });
      const both = (v) => ({ readAt: iso(NOW), venues: { ...v, pdl: v.pdl || PDL_OK } });
      const bad = [
        both({ si: PDL_OK, pp: { '2026-10-28': { status: 'closed' } } }),
        both({ si: [] }),
        { readAt: iso(NOW), venues: [] },
        day({ status: 'open' }),
        day({ status: 'ok' }),
        day({ status: 'ok', starts: { '7:00': { courts: 1, min: 60 } } }),
        day({ status: 'ok', starts: { '24:00': { courts: 1, min: 60 } } }),
        day({ status: 'ok', starts: { '19:00': { courts: 0, min: 60 } } }),
        day({ status: 'ok', starts: { '19:00': { courts: 1, min: 1.5 } } }),
        day({ status: 'ok', starts: { '19:00': { courts: '1', min: 60 } } }),
        day('ok'),
        both({ si: { '2026-11-10': { status: 'closed' }, '2026-10-26': { status: 'closed' } } }),   // nothing inside the window
      ];
      for (const b of bad) expect((await t.call('/api/courts', b, { robot: ROBOT })).status, JSON.stringify(b)).toBe(400);
      // Item 3: both venues every time. A body without pdl would have kept PDL's old days under the
      // new readAt, reading as fresh.
      const noPdl = await t.call('/api/courts', { readAt: iso(NOW), venues: { si: { '2026-10-28': { status: 'closed' } } } }, { robot: ROBOT });
      expect(noPdl).toMatchObject({ status: 400, json: { error: 'venues.pdl is needed' } });
      expect((await t.call('/api/courts', { readAt: iso(NOW), venues: { pdl: { '2026-10-28': { status: 'closed' } } } }, { robot: ROBOT })).json).toEqual({ error: 'venues.si is needed' });
      // Item 5: each venue needs at least one date inside the 7 days; an empty or all-outside venue is refused.
      for (const pdl of [{}, { '2026-11-10': { status: 'closed' } }]) {
        const r = await t.call('/api/courts', { readAt: iso(NOW), venues: { si: { '2026-10-28': { status: 'closed' } }, pdl } }, { robot: ROBOT });
        expect(r, JSON.stringify(pdl)).toMatchObject({ status: 400, json: { error: 'pdl: no dates inside the next 14 days' } });
      }
      // Dates outside the window are ignored without refusing the rest; an error day keeps its reason.
      const ok = await t.call('/api/courts', { readAt: iso(NOW), venues: { si: { '2026-11-10': { status: 'nonsense' }, '2026-10-28': { status: 'error', reason: 'HTTP 500' } }, pdl: { '2026-10-28': { status: 'closed' } } } }, { robot: ROBOT });
      expect(ok.status).toBe(200);
      const s = (await t.call('/api/state')).json;
      expect(s.availability.venues.si['2026-10-28']).toEqual({ status: 'error', reason: 'HTTP 500', hours: {} });
      expect(s.availability.venues.pdl['2026-10-28']).toEqual({ status: 'closed', hours: {} });
      expect(s.availability.venues.pdl['2026-10-29']).toEqual({ status: 'pending', hours: {} });   // not posted: never the old day
    });

    it('takes a body up to 64 KB, refuses one over it', async () => {
      const filler = { readAt: iso(NOW), venues: { pdl: { '2026-10-28': { status: 'closed' } }, si: { '2026-10-28': { status: 'closed' }, '2030-01-01': { status: 'error', reason: 'x'.repeat(30000) } } } };
      expect((await t.call('/api/courts', filler, { robot: ROBOT })).status).toBe(200);
      filler.venues.si['2030-01-01'].reason = 'x'.repeat(70000);
      expect((await t.call('/api/courts', filler, { robot: ROBOT })).status).toBe(413);
    });
  });
});

describe('pure state rules', () => {
  const dates = londonDates(NOW);
  const people = [1, 2, 3, 4].map((id) => ({ id, name: `P${id}`, venues: ['si', 'pdl', 'pp'] }));
  const votes = people.map((p) => ({ person_id: p.id, slot: SLOT }));
  const fresh = (venues) => assembleAvailability(
    { readAt: iso(NOW), goodAt: { si: iso(NOW), pdl: iso(NOW) }, venues: { si: venues.si || {}, pdl: venues.pdl || {} } },
    { fetchedAt: iso(NOW), goodAt: iso(NOW), days: venues.pp || {} },
  );
  it('an hour needs a start of 90 minutes or less', () => {
    const s = computeState({ people, votes, booked: [], availability: fresh({ si: { '2026-10-28': { status: 'ok', starts: { '19:00': { courts: 1, min: 120 } } } } }), dates, nowMs: NOW });
    expect(s.availability.venues.si['2026-10-28'].hours).toEqual({});
    expect(s.ready).toEqual([]);
  });
  it('closed and error never count as free', () => {
    const s = computeState({ people, votes, booked: [], availability: fresh({ si: { '2026-10-28': { status: 'closed' } }, pdl: { '2026-10-28': { status: 'error', reason: 'HTTP 500' } } }), dates, nowMs: NOW });
    expect(s.ready).toEqual([]);
    expect(s.availability.venues.pp['2026-10-28'].status).toBe('pending');
  });
  it('a venue never read counts for nothing', () => {
    const s = computeState({ people, votes, booked: [], availability: null, dates, nowMs: NOW });
    expect(s.availability.fresh).toEqual({ si: false, pdl: false, pp: false });
    expect(s.ready).toEqual([]);
  });
  it('decideAlerts skips slots already alerted', () => {
    const s = computeState({ people, votes, booked: [], availability: fresh(EVENING), dates, nowMs: NOW });
    expect(decideAlerts(s, new Set()).map((r) => r.slot)).toEqual([SLOT]);
    expect(decideAlerts(s, new Set([SLOT]))).toEqual([]);
    expect(alertText(s.ready[0], venueConfig(), 'https://padel.kevinbrittain.workers.dev/').length).toBeLessThan(4000);
  });
  it('the DM groups venues checked at the same minute', () => {
    const v = (code, checkedAt) => ({ code, count: 4, names: ['A1', 'B1', 'C1', 'D1'], starts: ['19:00'], mins: [60], min: 60, book: 'u', checkedAt });
    const r = { label: 'Wed 28 Oct 19:00', venues: [v('si', '2026-10-28T18:45:10Z'), v('pdl', '2026-10-28T18:45:10Z'), v('pp', '2026-10-28T18:50:00Z')] };
    expect(alertText(r, venueConfig(), 'p')).toContain('Courts checked: St Ives and Cambridge 18:45, Huntingdon 18:50. Whoever');
  });
});

describe('the page and its headers (workers/padel/public)', () => {
  const page = readFileSync(resolve(ROOT, 'workers/padel/public/index.html'), 'utf8');
  const headers = readFileSync(resolve(ROOT, 'workers/padel/public/_headers'), 'utf8');
  it('S7: the CSP allows the one inline script by its sha256 hash, and the hash matches the page', () => {
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(page).not.toMatch(/<script[^>]+src=/);
    const hash = createHash('sha256').update(scripts[0][1], 'utf8').digest('base64');
    const csp = headers.match(/Content-Security-Policy: (.*)/)[1];
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("connect-src 'self'");
    // The live page is served with no charset in its content-type, so this meta line is what makes
    // the browser decode the script as UTF-8, the bytes the hash was taken from.
    expect(page).toMatch(/^<!doctype html>\s*<html[^>]*>\s*<head>\s*<meta charset="utf-8">/i);
  });
  it('S4: the page headers live in _headers, for every path', () => {
    expect(headers).toMatch(/^\/\*$/m);
    for (const h of ['X-Robots-Tag: noindex, nofollow', 'X-Content-Type-Options: nosniff', 'Referrer-Policy: no-referrer', 'X-Frame-Options: DENY', 'Cache-Control: no-cache']) {
      expect(headers).toContain(`  ${h}`);
    }
  });
  it('F25: light only, no dark theme (design-system rule 3), and no code box or code header anywhere', () => {
    expect(page).not.toMatch(/prefers-color-scheme/);
    expect(page).toContain('content="light"');
    expect(page).not.toMatch(/X-Group-Key|code-input|id="gate"|\/api\/ping/);
  });
});

describe('Worker entry point', () => {
  it('only exports a fetch handler (workerd refuses any other main-module export)', () => {
    expect(Object.keys(worker)).toEqual(['fetch']);
  });
});
