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
  readPulse, checkAlerts, assembleAvailability, VERSION, RELAY_PENDING, matchiFresh, parseGladstone, bookUrl,
} from '../workers/padel/padel.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (f) => readFileSync(resolve(ROOT, 'tests/fixtures/padel', f), 'utf8');
const ST_IVES = fixture('matchi-2619-2026-10-28.html');
const PDL = fixture('matchi-3122-2026-10-28.html');
const CLOSED = fixture('matchi-2619-2026-11-05.html');
const ST_IVES_TODAY = fixture('matchi-2619-2026-10-27.html');    // read live on 27 Oct 2026 at 13:10
const PDL_TODAY = fixture('matchi-3122-2026-10-27.html');
const PULSE = JSON.parse(fixture('pulse-search.json'));
const GLADSTONE = JSON.parse(fixture('gladstone-sessions-2026-11-03.json'));   // the University feed for 3 to 6 Nov, read 29 Oct 2026
const countClass = (html, cls) => (html.match(new RegExp(`class="slot ${cls}"`, 'g')) || []).length;

// 09:45 London on Tue 27 Oct 2026 (GMT since 25 Oct): the window is 27 Oct to 2 Nov.
const NOW = Date.parse('2026-10-27T09:45:00Z');
const ROBOT = 'robot0000111122223333444455556666';
const ADMIN = 'admin0000111122223333444455556666';
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
    // The best court from 07:00 is open for three hours or more: the longest booking shown is the cap
    // (Court 1's own run ends at 09:30; the length is the best court's, the legend says so).
    expect(r.starts['07:00']).toEqual({ courts: 2, min: 60, max: 180, names: ['Court 1', 'Court 2'] });
    // 16:30 on Court 1: the 16:30 cell plus the 17:00 cannot-start cell, then booked: 60 minutes at most.
    expect(r.starts['16:30']).toEqual({ courts: 1, min: 60, max: 60, names: ['Court 1'] });
    // Every one of the 31 free cells can start and sits on a doubles court.
    expect(Object.values(r.starts).reduce((n, s) => n + s.courts, 0)).toBe(31);
    // 17:00 to 21:00 are booked or cannot start on both courts.
    expect(Object.keys(r.starts).filter((t) => t >= '17:00')).toEqual([]);
  });

  it('worked example 2: PDL 09:00 counts three doubles courts, never the Singles Court', () => {
    const r = parseMatchi(PDL);
    expect(r.status).toBe('ok');
    expect(r.starts['09:00']).toEqual({ courts: 3, min: 60, max: 180, names: ['Court 1', 'Court 2', 'Court 3'] });
    // Court 1's 09:00 start is the 90-minute one; the hour still reads free with min <= 90.
    expect(PDL).toMatch(/data-slot-min-duration="90"\s+data-slot-can-start="true"\s+title="Available<br>Court 1<br> 09:00 - 10:30"/);
    expect(hoursFromStarts(r.starts)['09']).toEqual({ free: true, min: 60, max: 180, courts: 3, starts: ['09:00', '09:30'], mins: [60, 60], maxs: [180, 180], courtsBy: [3, 3] });
    // Court 1 10:30 is booked ("slot red"): the 10:30 start is Court 3's alone, open until 13:00 (150 min).
    expect(r.starts['10:30']).toEqual({ courts: 1, min: 60, max: 150, names: ['Court 3'] });
    // The Singles Court's free 09:00 and 12:00 are ignored.
    expect(r.starts['12:00']).toEqual({ courts: 2, min: 60, max: 60, names: ['Court 2', 'Court 3'] });
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
    expect(parseMatchi(html)).toEqual({ status: 'ok', starts: { '18:30': { courts: 1, min: 90, max: 90, names: ['Court 2'] } } });
  });

  it('F3: class="free slot" still parses as free (class order carries no meaning)', () => {
    const html = table('<td class="free slot" data-slot-can-start="true" data-slot-min-duration="60" title="Available<br>Court 1<br>19:00 - 20:00"></td>');
    expect(parseMatchi(html)).toEqual({ status: 'ok', starts: { '19:00': { courts: 1, min: 60, max: 60, names: ['Court 1'] } } });
  });

  it('the longest booking from a start is the open run on that court: free and cannot-start cells count, a booked cell ends it', () => {
    const cell = (cls, court, t, extra = '') => `<td class="slot ${cls}" ${extra} title="Available<br>${court}<br>${t} - 20:00"></td>`;
    const start = (court, t) => cell('free', court, t, 'data-slot-can-start="true" data-slot-min-duration="60"');
    // Court 1: 19:00 free, 19:30 free, 20:00 cannot start, 20:30 booked -> 90 minutes from 19:00.
    // Court 2: 19:00 free, 19:30 booked -> 60 minutes (the minimum booking, longer than the single open cell).
    const html = `<div class="schedule"><table><tr>${start('Court 1', '19:00')}${start('Court 1', '19:30')}<td class="slot can-not-start"></td><td class="slot red"></td></tr>`
      + `<tr>${start('Court 2', '19:00')}<td class="slot red"></td></tr></table></div>`;
    const r = parseMatchi(html);
    expect(r.starts['19:00']).toEqual({ courts: 2, min: 60, max: 90, names: ['Court 1', 'Court 2'] });
    expect(r.starts['19:30']).toEqual({ courts: 1, min: 60, max: 60, names: ['Court 1'] });
    // Eight open cells in a row: the cap, never more.
    const long = `<div class="schedule"><table><tr>${start('Court 1', '07:00')}${'<td class="slot free"></td>'.repeat(8)}</tr></table></div>`;
    expect(parseMatchi(long).starts['07:00'].max).toBe(180);
    // A row never leaks into the next: Court 2's open cells do not lengthen Court 1's run.
    const rows = `<div class="schedule"><table><tr>${start('Court 1', '19:00')}<td class="slot red"></td></tr><tr><td class="slot free"></td><td class="slot free"></td></tr></table></div>`;
    expect(parseMatchi(rows).starts['19:00'].max).toBe(60);
    // An upper-case <TR> still starts a row (no leak across courts).
    expect(parseMatchi(rows.replace('<tr><td class="slot free">', '<TR><td class="slot free">')).starts['19:00'].max).toBe(60);
    // A "<tr" inside an attribute, a comment or a script never splits a court's row.
    const split = (junk) => `<div class="schedule"><table><tr>${start('Court 1', '19:00')}${junk}<td class="slot free"></td><td class="slot free"></td><td class="slot red"></td></tr></table></div>`;
    expect(parseMatchi(split('<td class="slot can-not-start" title="x<tr>y"></td>')).starts['19:00'].max).toBe(120);
    expect(parseMatchi(split('<span title="<tr>"></span>')).starts['19:00'].max).toBe(90);
    expect(parseMatchi(split('<style>.a<tr{}</style>')).starts['19:00'].max).toBe(90);
    expect(parseMatchi(split('<constructor></constructor>')).starts['19:00'].max).toBe(90);   // a tag named like an object property
    expect(parseMatchi(split('<!-- <tr> -->')).starts['19:00'].max).toBe(90);
    expect(parseMatchi(split('<script>var s = "<tr>";</script>')).starts['19:00'].max).toBe(90);
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

describe('parseGladstone (the University feed, read live on 29 Oct 2026)', () => {
  const DATES = ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
  it('matches the University calendar for Tue 3 Nov, hour by hour (read in the browser the same day)', () => {
    const r = parseGladstone(GLADSTONE, DATES, Date.parse('2026-10-29T12:00:00Z'));
    // The portal's calendar for 3 Nov offered "Book now" at: 07 (both courts), 08 (both), 09 (Court 2),
    // 11 (Court 2), 14 (Court 1), 15 (Court 1), 17 (Court 2), 21 (Court 1).
    expect(r['2026-11-03']).toEqual({ status: 'ok', starts: {
      '07:00': { courts: 2, min: 60, max: 180 }, '08:00': { courts: 2, min: 60, max: 120 }, '09:00': { courts: 1, min: 60, max: 60 },
      '11:00': { courts: 1, min: 60, max: 60 }, '14:00': { courts: 1, min: 60, max: 120 }, '15:00': { courts: 1, min: 60, max: 60 },
      '17:00': { courts: 1, min: 60, max: 60 }, '21:00': { courts: 1, min: 60, max: 60 },
    } });
    // 6 Nov is beyond a non-member's 7 days: every slot is before its window, so "not open yet".
    expect(r['2026-11-06']).toEqual({ status: 'closed' });
    // 7 Nov is not in the reply at all: an error, never "no court free".
    expect(r['2026-11-07']).toEqual({ status: 'error', reason: 'day not in the reply' });
  });
  it('a reply it does not recognise is an error on every day, never guessed slots', () => {
    expect(parseGladstone({}, ['2026-11-03'])).toEqual({ '2026-11-03': { status: 'error', reason: 'unexpected shape' } });
    expect(parseGladstone([{ id: 'SOMETHING_ELSE', locations: [] }], ['2026-11-03'])).toEqual({ '2026-11-03': { status: 'error', reason: 'no padel court hire in the reply' } });
    const broken = JSON.parse(JSON.stringify(GLADSTONE));
    delete broken[0].locations[0].slots;
    expect(parseGladstone(broken, ['2026-11-03'])['2026-11-03']).toEqual({ status: 'error', reason: 'unexpected shape' });
  });
  it('a court named singles never counts, and a taken slot ends the longest booking', () => {
    const slot = (start, status, inCentre = 1) => ({ startTime: start, endTime: start.replace(':00:00Z', ':59:59Z'), status, availability: { inCentre }, isBeforeTimetableSlotBookablePeriod: false });
    const reply = [{ id: 'USCAPADWO02', locations: [
      { locationNameToDisplay: 'Padel Tennis Court 1', slots: [slot('2026-11-03T19:00:00Z', 'Available'), slot('2026-11-03T20:00:00Z', 'Unavailable', 0)] },
      { locationNameToDisplay: 'Singles Court', slots: [slot('2026-11-03T19:00:00Z', 'Available'), slot('2026-11-03T20:00:00Z', 'Available')] },
    ] }];
    expect(parseGladstone(reply, ['2026-11-03'])['2026-11-03']).toEqual({ status: 'ok', starts: { '19:00': { courts: 1, min: 60, max: 60 } } });
  });
  it('the longest booking needs slots that follow on exactly; a start listed twice is one court; a slot past its online cut-off is not free (review of PR #854)', () => {
    const slot = (start, mins = 60, extra = {}) => ({ startTime: start, endTime: new Date(Date.parse(start) + mins * 60000 - 1000).toISOString(), status: 'Available', availability: { inCentre: 1 }, isBeforeTimetableSlotBookablePeriod: false, ...extra });
    const day = (slots, nowMs) => parseGladstone([{ id: 'USCAPADWO02', locations: [{ locationNameToDisplay: 'Padel Tennis Court 1', slots }] }], ['2026-11-03'], nowMs)['2026-11-03'];
    // Out of order, a gap at 20:00, and 19:00 listed twice: 18:00 runs 120 minutes, 21:00 stands alone, one court each.
    expect(day([slot('2026-11-03T21:00:00Z'), slot('2026-11-03T19:00:00Z'), slot('2026-11-03T18:00:00Z'), slot('2026-11-03T19:00:00Z')])).toEqual({ status: 'ok', starts: {
      '18:00': { courts: 1, min: 60, max: 120 }, '19:00': { courts: 1, min: 60, max: 60 }, '21:00': { courts: 1, min: 60, max: 60 },
    } });
    // Five hours in a row: the cap, 180.
    expect(day(['07', '08', '09', '10', '11'].map((h) => slot(`2026-11-03T${h}:00:00Z`)))['starts']['07:00'].max).toBe(180);
    // Half-hour slots at 19:00 and 20:00 with nothing at 19:30 do not follow on: 30 minutes each.
    expect(day([slot('2026-11-03T19:00:00Z', 30), slot('2026-11-03T20:00:00Z', 30)])['starts']['19:00']).toEqual({ courts: 1, min: 30, max: 30 });
    // A slot of more than 180 minutes (or one ending a day later) is an unreadable reply, never a 240-minute booking.
    expect(day([slot('2026-11-03T07:00:00Z', 240)])).toEqual({ status: 'error', reason: 'unexpected shape' });
    expect(day([slot('2026-11-03T07:00:00Z', 1500)])).toEqual({ status: 'error', reason: 'unexpected shape' });
    // Half-hour slots: three in a row is 90 minutes, not 180.
    expect(day([slot('2026-11-03T19:00:00Z', 30), slot('2026-11-03T19:30:00Z', 30), slot('2026-11-03T20:00:00Z', 30)])['starts']['19:00']).toEqual({ courts: 1, min: 30, max: 90 });
    // 18:40 London: the 19:00 slot closed for online booking at 18:30, the 20:00 slot has not.
    const cutOff = [slot('2026-11-03T19:00:00Z', 60, { bookableUntil: '2026-11-03T18:30:00Z' }), slot('2026-11-03T20:00:00Z', 60, { bookableUntil: '2026-11-03T19:30:00Z' })];
    expect(Object.keys(day(cutOff, Date.parse('2026-11-03T18:40:00Z')).starts)).toEqual(['20:00']);
    expect(Object.keys(day(cutOff, Date.parse('2026-11-03T18:00:00Z')).starts)).toEqual(['19:00', '20:00']);
  });
  it('London time: in summer a 06:00 UTC slot is the 07:00 London start', () => {
    const reply = [{ id: 'USCAPADWO02', locations: [{ locationNameToDisplay: 'Padel Tennis Court 1', slots: [{ startTime: '2026-07-01T06:00:00Z', endTime: '2026-07-01T06:59:59Z', status: 'Available', availability: { inCentre: 1 }, isBeforeTimetableSlotBookablePeriod: false }] }] }];
    expect(Object.keys(parseGladstone(reply, ['2026-07-01'])['2026-07-01'].starts)).toEqual(['07:00']);
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
    // Each court lists the lengths it sells from that start: 60 to 120 at 07:00, 90 only at 21:30.
    expect(r.byDate['2026-10-28']['07:00']).toEqual({ courts: 3, min: 60, max: 120 });
    expect(r.byDate['2026-10-28']['21:30']).toEqual({ courts: 2, min: 90, max: 90 });
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
  const out = (p) => ({ id: p.id, name: p.name, venues: p.venues.split(',').filter(Boolean), savedAt: p.votes_at || null, ...(p.real_name ? { realName: p.real_name } : {}) });
  return {
    rows: { alerts: () => [...alerts.values()], people: () => [...people.values()], votes: () => [...votes.values()], rate: () => [...rate.values()] },
    putAlert: (row) => alerts.set(row.slot, { names: '', venues: '', relay_reply: null, ...row }),
    repo: {
      async listPeople() { return [...people.values()].sort((a, b) => a.name.localeCompare(b.name)).map(out); },
      async getPerson(id) { return people.has(id) ? out(people.get(id)) : null; },
      async countPeople() { return people.size; },
      async addPerson(name, now) {
        let p = [...people.values()].find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!p) { p = { id: nextId++, name, venues: 'si,pdl,pp,cu', created_at: now }; people.set(p.id, p); }
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
      async getBooked(slot) { return booked.get(slot) || null; },
      async setRealName(id, realName) { const p = people.get(id); if (!p) return false; p.real_name = realName; return true; },
      async setPaid(slot, price, players, now) {
        const b = booked.get(slot);
        if (!b || !(b.splitwise_state == null || b.splitwise_state === 'failed')) return false;
        Object.assign(b, { price_pence: price, players: JSON.stringify(players), paid_at: now, splitwise_state: null, splitwise_at: null, splitwise_note: null, texts_state: null, texts_at: null, texts_note: null });
        return true;
      },
      async clearPaid(slot) {
        const b = booked.get(slot);
        if (!b || !b.paid_at || !(b.splitwise_state == null || b.splitwise_state === 'failed')) return false;
        Object.assign(b, { price_pence: null, players: null, paid_at: null, splitwise_state: null, splitwise_at: null, splitwise_note: null, texts_state: null, texts_at: null, texts_note: null });
        return true;
      },
      async markStep(slot, step, state, note, now) {
        const b = booked.get(slot);
        if (!b || !b.paid_at || !['splitwise', 'texts'].includes(step)) return false;
        const cur = b[`${step}_state`] ?? null;
        const ok = state === 'claimed' ? cur === null : state === 'retry' ? cur === 'failed' : cur === 'claimed';
        if (!ok) return false;
        const to = state === 'retry' ? null : state;
        Object.assign(b, { [`${step}_state`]: to, [`${step}_at`]: to ? now : null, [`${step}_note`]: to ? note : null });
        return true;
      },
      async listPaidPending(from) { return [...booked.values()].filter((b) => b.slot >= from && b.paid_at && !(b.splitwise_state === 'done' && b.texts_state === 'done')).sort((a, b) => a.slot.localeCompare(b.slot)); },
      async setBooked(slot, person_id, venue, now, d = {}) {
        const was = booked.get(slot) || {};
        booked.set(slot, { slot, person_id, venue, created_at: now, start: d.start ?? was.start ?? null, minutes: d.minutes ?? was.minutes ?? null, courts: d.courts ?? was.courts ?? 1 });
      },
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
        const weekAgo = new Date(Date.parse(`${today}T12:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
        for (const m of [votes, alerts]) for (const [k, v] of [...m]) if (v.slot < today) m.delete(k);
        for (const [k, v] of [...booked]) if (v.slot < today && (!v.paid_at || v.slot < weekAgo || (v.splitwise_state === 'done' && v.texts_state === 'done'))) booked.delete(k);
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
    ADMIN_KEY: ADMIN,
    RELAY_KEY: 'relay-key-test',
    PAGE_URL: 'https://padel.kevinbrittain.workers.dev/',
    RELAY: { fetch: vi.fn(async (req) => { relayCalls.push({ url: req.url, key: req.headers.get('X-Relay-Key'), body: await req.json() }); return relayReply(); }) },
    WRITE_LIMIT: { limit: async ({ key }) => { limited.keys.push(key); limited.n++; return { success: limited.n <= limited.max }; } },
  };
  const ctx = { waitUntil: (p) => waits.push(p) };
  let now = NOW;
  let fetchImpl = pulseFetch(calls);
  const drain = async () => { while (waits.length) await Promise.all(waits.splice(0)); };
  const call = async (path, body, { robot, admin, method, raw, drain: doDrain = true, ip } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (robot) headers['X-Robot-Key'] = robot;
    if (admin) headers['X-Admin-Key'] = admin;
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
      + 'St Ives: 4 in (Test Ann, Test Bob, Test Cat, Test Dan), starts 19:00 (60 min), 19:30 (60 min, 2 courts), book <https://www.matchi.se/book/schedule?facilityId=2619&date=2026-10-28&sport=5>. '
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
    expect(s.availability.fresh).toEqual({ si: false, pdl: false, pp: true, cu: false });
    expect(s.availability.venues.si['2026-10-28']).toEqual({ status: 'error', reason: 'not checked recently', hours: {} });
    expect(s.availability.checkedAt.si).toBe(iso(NOW - 2 * 24 * 60 * MIN));
  });

  it('freshness edges: Matchi counts for 45 minutes, Pulse for 20', async () => {
    const ids = await t.addPeople(NAMES.slice(0, 4));
    await t.seedAvailability(EVENING, NOW - 44 * MIN, NOW - 19 * MIN);
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: ['2026-10-29|08'] });
    let s = (await t.call('/api/state')).json;
    expect(s.availability.fresh).toEqual({ si: true, pdl: true, pp: true, cu: true });
    await t.seedAvailability(EVENING, NOW - 46 * MIN, NOW - 21 * MIN);
    s = (await t.call('/api/state', undefined, { drain: false })).json;
    expect(s.availability.fresh).toEqual({ si: false, pdl: false, pp: false, cu: false });
    expect(s.ready).toEqual([]);
    expect(s.nearly).toEqual([]);
  });

  // The Mac sleeps from 23:00 to 06:30 London. Without this rule the page read "couldn't check"
  // on St Ives and Cambridge every night from 23:30 (Kevin, 27 Oct 2026: "Do it now").
  it('overnight: the evening\'s last Matchi read (22:30 London or later) counts until 06:45, never past nine hours', () => {
    const at = (s) => Date.parse(s);
    expect(matchiFresh('2026-10-27T14:00:00Z', at('2026-10-27T14:44:00Z'))).toBe(true);     // by day: 45 minutes
    expect(matchiFresh('2026-10-27T14:00:00Z', at('2026-10-27T14:46:00Z'))).toBe(false);
    expect(matchiFresh('2026-10-27T22:45:00Z', at('2026-10-27T23:40:00Z'))).toBe(true);     // the 22:45 read, late evening
    expect(matchiFresh('2026-10-27T22:45:00Z', at('2026-10-28T05:30:00Z'))).toBe(true);     // small hours
    expect(matchiFresh('2026-10-27T22:45:00Z', at('2026-10-28T06:44:00Z'))).toBe(true);     // until 06:45
    expect(matchiFresh('2026-10-27T22:45:00Z', at('2026-10-28T06:45:00Z'))).toBe(false);    // the morning run is due by now
    expect(matchiFresh('2026-10-27T22:15:00Z', at('2026-10-27T23:30:00Z'))).toBe(false);    // not one of the evening's last reads
    expect(matchiFresh('2026-10-27T22:30:00Z', at('2026-10-28T06:00:00Z'))).toBe(true);     // 22:30 is the first late slot
    expect(matchiFresh('2026-07-01T21:45:00Z', at('2026-07-02T01:00:00Z'))).toBe(true);     // BST: 22:45 read, 02:00 now
    expect(matchiFresh('2026-07-01T21:15:00Z', at('2026-07-02T01:00:00Z'))).toBe(false);    // BST: a 22:15 read does not
    expect(matchiFresh('2026-07-01T21:45:00Z', at('2026-07-02T05:50:00Z'))).toBe(false);    // BST: 06:50 London, past the morning run
    expect(matchiFresh('', at('2026-10-27T23:40:00Z'))).toBe(false);
    expect(matchiFresh('2026-10-27T22:45:00Z', at('2026-10-28T08:00:00Z'))).toBe(false);    // the Mac slept in: loud, not covered
    expect(matchiFresh('2026-10-25T22:45:00Z', at('2026-10-27T23:40:00Z'))).toBe(false);    // two nights old: the nine-hour cap alone stops it
  });

  it('after midnight the window\'s new last day, which the evening read never covered, reads "couldn\'t check", not "checking"', async () => {
    await t.seedAvailability(EVENING, Date.parse('2026-10-27T22:45:00Z'), Date.parse('2026-10-27T22:42:00Z'));
    t.setNow(Date.parse('2026-10-28T00:30:00Z'));
    const s = (await t.call('/api/state')).json;
    expect(s.days[0]).toBe('2026-10-28');
    expect(s.days[13]).toBe('2026-11-10');
    expect(s.availability.fresh).toEqual({ si: true, pdl: true, pp: false, cu: true });
    expect(s.availability.venues.si['2026-10-28'].status).toBe('ok');
    expect(s.availability.venues.si['2026-11-10']).toEqual({ status: 'error', reason: 'not in the last read', hours: {} });
    expect(s.availability.venues.pdl['2026-11-10']).toEqual({ status: 'error', reason: 'not in the last read', hours: {} });
  });

  it('a state read at 23:40 shows St Ives and Cambridge from the 22:45 read, and a DM can still fire on them', async () => {
    const ids = await t.addPeople(NAMES.slice(0, 4));
    await t.seedAvailability(EVENING, Date.parse('2026-10-27T22:45:00Z'), Date.parse('2026-10-27T22:42:00Z'));
    t.setNow(Date.parse('2026-10-27T23:40:00Z'));
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: ['2026-10-28|19'] });
    const s = (await t.call('/api/state')).json;
    expect(s.availability.fresh).toEqual({ si: true, pdl: true, pp: false, cu: true });
    expect(s.availability.venues.si['2026-10-28'].status).toBe('ok');
    expect(s.availability.venues.pp['2026-10-28']).toEqual({ status: 'error', reason: 'not checked recently', hours: {} });
    expect(s.ready.map((r) => r.slot)).toEqual(['2026-10-28|19']);
    expect(t.relayCalls).toHaveLength(1);
    expect(t.relayCalls[0].body.text).toMatch(/St Ives: 4 in .* Cambridge: 4 in .* Courts checked 22:45\./);
  });

  it('a DM sent at 02:00 on the evening\'s read says "Courts checked 22:45 yesterday", never a bare time', async () => {
    const ids = await t.addPeople(NAMES.slice(0, 4));
    await t.seedAvailability(EVENING, Date.parse('2026-10-27T22:45:00Z'), Date.parse('2026-10-27T22:42:00Z'));
    t.setNow(Date.parse('2026-10-28T02:00:00Z'));
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: ['2026-10-28|19'] });
    expect(t.relayCalls).toHaveLength(1);
    expect(t.relayCalls[0].body.text).toMatch(/Courts checked 22:45 yesterday\. Whoever books/);
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
    expect(s.booked[SLOT]).toEqual({ person_id: ids[0], venue: 'si', start: null, minutes: null, courts: 1 });
    // Undo the booking: the slot is ready again and the next save sends its one DM.
    await t.call('/api/booked', { slot: SLOT, booked: false });
    await t.call('/api/vote', { person_id: ids[0], add: [SLOT] });
    expect(t.relayCalls).toHaveLength(1);
  });

  it('one booking a day: a booking at 19:30 drops the other ready hours that day and their DMs (Kevin, 29 Oct 2026)', async () => {
    await t.seedAvailability({
      si: {
        '2026-10-28': { status: 'ok', starts: { '18:00': { courts: 2, min: 60, max: 120 }, '19:00': { courts: 1, min: 60 }, '20:30': { courts: 3, min: 60, max: 90 }, '21:00': { courts: 1, min: 60 } } },
        '2026-10-29': { status: 'ok', starts: { '18:00': { courts: 3, min: 60, max: 120 } } },
      },
      pdl: {}, pp: {},
    });
    const ids = await t.addPeople(NAMES.slice(0, 4));
    expect((await t.call('/api/booked', { slot: SLOT, person_id: ids[0], venue: 'si', booked: true, start: '19:30', minutes: 90 })).status).toBe(200);
    for (const id of ids) await t.call('/api/vote', { person_id: id, add: ['2026-10-28|18', SLOT, '2026-10-28|20', '2026-10-29|18'] });
    for (const id of ids.slice(0, 3)) await t.call('/api/vote', { person_id: id, add: ['2026-10-28|21'] });   // three in: a "nearly" hour
    const s = (await t.call('/api/state')).json;
    expect(s.booked[SLOT]).toEqual({ person_id: ids[0], venue: 'si', start: '19:30', minutes: 90, courts: 1 });
    // The 28th has a booking: its three hours with four in are not ready and its 21:00 with three is not nearly; the 29th is ready.
    expect(s.ready.map((r) => r.slot)).toEqual(['2026-10-29|18']);
    expect(s.nearly).toEqual([]);
    expect(t.relayCalls).toHaveLength(1);
    expect(t.relayCalls[0].body.text).toContain('Padel: Thu 29 Oct 18:00. St Ives: 4 in (Test Ann, Test Bob, Test Cat, Test Dan), starts 18:00 (60 to 120 min, 3 courts), book <');
    // Undo the booking: the 28th's three hours are ready again and each gets its one DM.
    await t.call('/api/booked', { slot: SLOT, booked: false });
    await t.call('/api/vote', { person_id: ids[0], add: [SLOT] });
    const back = (await t.call('/api/state')).json;
    expect(back.ready.map((r) => r.slot)).toEqual(['2026-10-28|18', SLOT, '2026-10-28|20', '2026-10-29|18']);
    expect(back.nearly.map((r) => r.slot)).toEqual(['2026-10-28|21']);
    expect(t.relayCalls).toHaveLength(4);
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
    // Booking details: the start sits inside the hour, minutes in fives up to 180, courts 1 or 2.
    expect((await t.call('/api/booked', { slot: SLOT, person_id: id, venue: 'si', booked: true, start: '18:30' })).status).toBe(400);
    expect((await t.call('/api/booked', { slot: SLOT, person_id: id, venue: 'si', booked: true, start: '19:15' })).status).toBe(400);
    expect((await t.call('/api/booked', { slot: SLOT, person_id: id, venue: 'si', booked: true, minutes: 61 })).status).toBe(400);
    expect((await t.call('/api/booked', { slot: SLOT, person_id: id, venue: 'si', booked: true, minutes: 240 })).status).toBe(400);
    expect((await t.call('/api/booked', { slot: SLOT, person_id: id, venue: 'si', booked: true, courts: 3 })).status).toBe(400);
    expect((await t.call('/api/booked', { slot: SLOT, person_id: id, venue: 'si', booked: true, start: '19:30', minutes: 90 })).json.booked[SLOT]).toEqual({ person_id: id, venue: 'si', start: '19:30', minutes: 90, courts: 1 });
    // "Booked 2nd court" sends courts alone: the start and length stay.
    expect((await t.call('/api/booked', { slot: SLOT, person_id: id, venue: 'si', booked: true, courts: 2 })).json.booked[SLOT]).toEqual({ person_id: id, venue: 'si', start: '19:30', minutes: 90, courts: 2 });
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
    expect(a).toEqual({ id: a.id, name: 'test ann', venues: ['si', 'pdl', 'pp', 'cu'], savedAt: null });
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

  describe("Kevin's phone, real names and Booked and paid (Kevin, 30 Oct 2026)", () => {
    const book = async (id, extra = {}) => t.call('/api/booked', { slot: SLOT, person_id: id, venue: 'pdl', booked: true, start: '19:30', minutes: 90, ...extra });
    it('only a request with the admin key may use /api/admin, and the state says which phone is which', async () => {
      const [a] = await t.addPeople(['Test Ann']);
      expect((await t.call('/api/admin', { action: 'name', id: a, real_name: 'Test Annabel' })).status).toBe(401);
      expect((await t.call('/api/admin', { action: 'name', id: a, real_name: 'Test Annabel' }, { admin: 'wrong-key' })).status).toBe(401);
      expect((await t.call('/api/state')).json.admin).toBe(false);
      expect((await t.call('/api/state', undefined, { admin: ADMIN })).json.admin).toBe(true);
      // Every reply that carries the state says so, a tick's included, so Kevin's buttons never vanish after a save.
      expect((await t.call('/api/vote', { person_id: a, add: [SLOT] }, { admin: ADMIN })).json.admin).toBe(true);
      expect((await t.call('/api/vote', { person_id: a, remove: [SLOT] })).json.admin).toBe(false);
      expect((await t.call('/api/refresh', {}, { admin: ADMIN })).json.admin).toBe(true);
      expect((await t.call('/api/admin', { action: 'name', id: a, real_name: 'Test Annabel' }, { admin: ADMIN })).status).toBe(200);
    });
    it('a real name replaces the chosen name everywhere, keeps it as nick, and either name finds the same person', async () => {
      const [a, b] = await t.addPeople(['Test Sparky', 'Test Bob']);
      const r = await t.call('/api/admin', { action: 'name', id: a, real_name: 'Test Simon' }, { admin: ADMIN });
      expect(r.json.people.find((p) => p.id === a)).toEqual({ id: a, name: 'Test Simon', nick: 'Test Sparky', venues: ['si', 'pdl', 'pp', 'cu'], savedAt: null });
      expect(r.json.people.find((p) => p.id === b)).toEqual({ id: b, name: 'Test Bob', venues: ['si', 'pdl', 'pp', 'cu'], savedAt: null });
      expect((await t.call('/api/person', { name: 'test simon' })).json.id).toBe(a);
      expect((await t.call('/api/person', { name: 'Test Sparky' })).json.id).toBe(a);
      expect((await t.call('/api/admin', { action: 'name', id: a, real_name: '12' }, { admin: ADMIN })).status).toBe(400);
      expect((await t.call('/api/admin', { action: 'name', id: 999, real_name: 'Test Zed' }, { admin: ADMIN })).status).toBe(404);
      // An empty real name gives the chosen name back.
      expect((await t.call('/api/admin', { action: 'name', id: a, real_name: '' }, { admin: ADMIN })).json.people.find((p) => p.id === a)).toEqual({ id: a, name: 'Test Sparky', venues: ['si', 'pdl', 'pp', 'cu'], savedAt: null });
    });
    it('Booked and paid needs a booked hour with its details, a sane price and real players; it shows on the booking', async () => {
      const [a, b, c] = await t.addPeople(['Test Ann', 'Test Bob', 'Test Cat']);
      const paid = (body) => t.call('/api/admin', { action: 'paid', slot: SLOT, ...body }, { admin: ADMIN });
      expect((await paid({ price: 36, players: [a, b] })).status).toBe(409);            // not booked yet
      await book(a);
      for (const price of [0, -1, 1001, 'x', null]) expect((await paid({ price, players: [a, b] })).status).toBe(400);
      expect((await paid({ price: 36, players: [] })).status).toBe(400);
      expect((await paid({ price: 36, players: [a, a] })).status).toBe(400);
      expect((await paid({ price: 36, players: [a, 999] })).status).toBe(400);
      const r = await paid({ price: 36.5, players: [a, b, c] });
      expect(r.status).toBe(200);
      expect(r.json.admin).toBe(true);
      expect(r.json.booked[SLOT]).toMatchObject({ person_id: a, venue: 'pdl', start: '19:30', minutes: 90, courts: 1 });
      expect(r.json.booked[SLOT].paid).toEqual({ price: 3650, players: [a, b, c], at: iso(NOW), splitwise: { state: null, at: null, note: null }, texts: { state: null, at: null, note: null } });
      // A price change before the robot starts is fine; Undo by anyone but Kevin's phone is refused.
      expect((await paid({ price: 40, players: [a, b] })).json.booked[SLOT].paid.price).toBe(4000);
      expect((await t.call('/api/booked', { slot: SLOT, booked: false })).status).toBe(409);
      expect((await book(b)).status).toBe(409);
      expect((await t.call('/api/admin', { action: 'unpaid', slot: SLOT }, { admin: ADMIN })).json.booked[SLOT].paid).toBeUndefined();
      expect((await t.call('/api/booked', { slot: SLOT, booked: false })).status).toBe(200);   // unpaid again: anyone may undo
    });
    it('the robot claims each step once: done or failed only from claimed, nothing after a claim until Kevin retries a failure', async () => {
      const [a, b] = await t.addPeople(['Test Ann', 'Test Bob']);
      await t.call('/api/admin', { action: 'name', id: b, real_name: 'Test Robert' }, { admin: ADMIN });
      await book(a);
      await t.call('/api/admin', { action: 'paid', slot: SLOT, price: 36, players: [a, b] }, { admin: ADMIN });
      expect((await t.call('/api/robot/paid')).status).toBe(401);
      const list = (await t.call('/api/robot/paid', undefined, { robot: ROBOT })).json.bookings;
      expect(list).toEqual([{
        slot: SLOT, date: '2026-10-28', day: 'Wed 28 Oct', venue: { code: 'pdl', short: 'Cambridge', label: 'PDL Padel United Cambridge' }, start: '19:30', minutes: 90, pricePence: 3600,
        splitwise: { state: null, at: null, note: null }, texts: { state: null, at: null, note: null },
        players: [{ id: a, name: 'Test Ann', nick: 'Test Ann' }, { id: b, name: 'Test Robert', nick: 'Test Bob' }],
      }]);
      const step = (step, state, note) => t.call('/api/robot/paid', { slot: SLOT, step, state, note }, { robot: ROBOT });
      expect((await step('splitwise', 'done')).json.changed).toBe(false);               // never done without a claim
      expect((await step('splitwise', 'claimed')).json.changed).toBe(true);
      expect((await step('splitwise', 'claimed')).json.changed).toBe(false);            // a second claim never wins
      expect((await t.call('/api/admin', { action: 'paid', slot: SLOT, price: 50, players: [a, b] }, { admin: ADMIN })).status).toBe(409);
      expect((await t.call('/api/admin', { action: 'retry', slot: SLOT, step: 'splitwise' }, { admin: ADMIN })).status).toBe(409);   // claimed is not failed
      expect((await step('splitwise', 'failed', 'Splitwise refused it')).json.changed).toBe(true);
      expect((await t.call('/api/state')).json.booked[SLOT].paid.splitwise).toMatchObject({ state: 'failed', note: 'Splitwise refused it' });
      expect((await t.call('/api/admin', { action: 'retry', slot: SLOT, step: 'splitwise' }, { admin: ADMIN })).status).toBe(200);
      expect((await step('splitwise', 'claimed')).json.changed).toBe(true);
      expect((await step('splitwise', 'done', 'expense 123')).json.changed).toBe(true);
      expect((await step('texts', 'claimed')).json.changed).toBe(true);
      expect((await step('texts', 'done', '1 of 1 sent')).json.changed).toBe(true);
      expect((await t.call('/api/robot/paid', undefined, { robot: ROBOT })).json.bookings).toEqual([]);
      expect((await t.call('/api/robot/paid', { slot: SLOT, step: 'nope', state: 'done' }, { robot: ROBOT })).status).toBe(400);
    });
    it('a paid booking the robot has not finished survives midnight; a finished or unpaid one is cleared as before', async () => {
      const [a] = await t.addPeople(['Test Ann']);
      await book(a);
      await t.call('/api/admin', { action: 'paid', slot: SLOT, price: 36, players: [a] }, { admin: ADMIN });
      await t.repo.prune('2026-10-29');
      expect(await t.repo.getBooked(SLOT)).toMatchObject({ slot: SLOT, price_pence: 3600 });
      await t.repo.markStep(SLOT, 'splitwise', 'claimed', null, iso(NOW));
      await t.repo.markStep(SLOT, 'splitwise', 'done', null, iso(NOW));
      await t.repo.markStep(SLOT, 'texts', 'claimed', null, iso(NOW));
      await t.repo.markStep(SLOT, 'texts', 'done', null, iso(NOW));
      await t.repo.prune('2026-10-29');
      expect(await t.repo.getBooked(SLOT)).toBeNull();
    });
  });

  describe('POST /api/courts (the Mac\'s Matchi read)', () => {
    it('University days in the Mac\'s read: its hours show, count towards a DM, and Book opens its calendar on that day (Kevin, 29 Oct 2026)', async () => {
      const ids = await t.addPeople(NAMES.slice(0, 4));
      expect((await t.call('/api/state')).json.people.every((p) => p.venues.includes('cu'))).toBe(true);   // new people can do every venue
      const body = macBody(NOW);                              // the seed's read is at NOW: an older one is refused (409)
      body.venues.cu = parseGladstone(GLADSTONE, londonDates(NOW), NOW);
      // Leave St Ives and PDL with no free court at 07:00 on 3 Nov, so the University alone is ready.
      body.venues.si['2026-11-03'] = { status: 'ok', starts: {} };
      body.venues.pdl['2026-11-03'] = { status: 'ok', starts: {} };
      expect((await t.call('/api/courts', body, { robot: ROBOT })).status).toBe(200);
      for (const id of ids) await t.call('/api/vote', { person_id: id, add: ['2026-11-03|07'] });
      const s = (await t.call('/api/state')).json;
      expect(s.availability.fresh.cu).toBe(true);
      expect(s.availability.venues.cu['2026-11-03'].hours['07']).toMatchObject({ free: true, courts: 2, min: 60, max: 180 });
      expect(s.availability.venues.cu['2026-11-06']).toEqual({ status: 'closed', hours: {} });
      expect(s.availability.venues.cu['2026-10-28']).toEqual({ status: 'error', reason: 'day not in the reply', hours: {} });
      const r = s.ready.find((x) => x.slot === '2026-11-03|07');
      expect(r.venues.map((v) => v.code)).toEqual(['cu']);   // St Ives and PDL have no court then; Huntingdon's seed has no 3 Nov
      const cu = r.venues.find((v) => v.code === 'cu');
      expect(cu).toMatchObject({ count: 4, courts: 2, book: 'https://cambridgesport.gladstonego.cloud/book/calendar/USCAPADWO02?activityDate=2026-11-03T06:00:00.000Z' });
      expect(s.venueInfo.cu).toMatchObject({ label: 'University of Cambridge Sports Centre', short: 'Cambridge Uni' });
      expect(t.relayCalls.some((c) => /Cambridge Uni: 4 in \(Test Ann, Test Bob, Test Cat, Test Dan\), starts 07:00 \(60 to 180 min, 2 courts\), book <https:\/\/cambridgesport\.gladstonego\.cloud\/book\/calendar\/USCAPADWO02\?activityDate=2026-11-03T06:00:00\.000Z>/.test(c.body.text))).toBe(true);
      expect(bookUrl(venueConfig(), 'cu', '2026-07-01')).toBe('https://cambridgesport.gladstonego.cloud/book/calendar/USCAPADWO02?activityDate=2026-07-01T06:00:00.000Z');
    });

    it('a later read without University days (an older reader) leaves it "couldn\'t check", never the last read\'s days (review of PR #854)', async () => {
      const first = macBody(NOW);
      first.venues.cu = parseGladstone(GLADSTONE, londonDates(NOW), NOW);
      expect((await t.call('/api/courts', first, { robot: ROBOT })).status).toBe(200);
      expect((await t.call('/api/state')).json.availability.venues.cu['2026-11-03'].status).toBe('ok');
      expect((await t.call('/api/courts', macBody(NOW), { robot: ROBOT })).status).toBe(200);
      const s = (await t.call('/api/state')).json;
      expect(s.availability.venues.cu['2026-11-03']).toEqual({ status: 'error', reason: 'not in the last read', hours: {} });
      expect(s.availability.venues.si['2026-10-28'].status).toBe('ok');
    });

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
      // The saved body carries no max (strip), so the longest booking falls back to the shortest.
      expect(s.availability.venues.si['2026-10-28'].hours['07']).toEqual({ free: true, min: 60, max: 60, courts: 2, starts: ['07:00', '07:30'], mins: [60, 60], maxs: [60, 60], courtsBy: [2, 2] });
      // St Ives day 10 (5 Nov) is beyond its booking window: "not open yet", never counted.
      expect(s.availability.venues.si['2026-11-05']).toEqual({ status: 'closed', hours: {} });
      expect(s.availability.venues.pdl['2026-11-09'].status).toBe('ok');
      expect(s.availability.venues.pdl['2026-10-28'].hours['09'].free).toBe(true);
      expect(s.availability.checkedAt).toEqual({ si: iso(NOW - 30 * 1000), pdl: iso(NOW - 30 * 1000), pp: iso(NOW), cu: null });
      // A read with no University days (an older reader) stores none under its readAt: "couldn't check", never stale days passed off as fresh.
      expect(s.availability.venues.cu['2026-10-28']).toEqual({ status: 'error', reason: 'not in the last read', hours: {} });

      const g = await t.call('/api/courts', undefined, { robot: ROBOT });
      expect(g.json).toEqual({
        ok: true, version: VERSION, matchiFetchedAt: iso(NOW - 30 * 1000), pulseFetchedAt: iso(NOW),
        venueStatus: { si: { ok: 7, closed: 7 }, pdl: { ok: 14 }, pp: { ok: 14 }, cu: { missing: 14 } },   // this body has no University days (an older reader)
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
      expect(s.availability.venues.pdl['2026-10-29']).toEqual({ status: 'error', reason: 'not in the last read', hours: {} });   // not posted: never the old day, and not "checking" either
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
    expect(s.availability.venues.pp['2026-10-28']).toEqual({ status: 'error', reason: 'not in the last read', hours: {} });   // read, but no day for this date
  });
  it('a venue never read counts for nothing', () => {
    const s = computeState({ people, votes, booked: [], availability: null, dates, nowMs: NOW });
    expect(s.availability.fresh).toEqual({ si: false, pdl: false, pp: false, cu: false });
    expect(s.ready).toEqual([]);
  });
  it('a booked hour offers a second court only with 8 in at that venue and another court free at the booked start (Kevin, 29 Oct 2026)', () => {
    const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, name: `P${id}`, venues: ['si', 'pdl', 'pp'] }));
    const v8 = eight.map((p) => ({ person_id: p.id, slot: SLOT }));
    const at = (starts) => fresh({ si: { '2026-10-28': { status: 'ok', starts } } });
    const before = iso(NOW + MIN);                            // marked after the read: the read still shows our court
    const after = iso(NOW - 10 * MIN);                        // marked before the read: the read no longer shows it
    const booking = (created_at, extra = {}) => [{ slot: SLOT, person_id: 1, venue: 'si', start: '19:00', minutes: 90, courts: 1, created_at, ...extra }];
    const second = (opts) => computeState({ people: eight, votes: v8, availability: at({ '19:00': { courts: 1, min: 60, max: 120 } }), dates, nowMs: NOW, ...opts }).booked[SLOT].second;
    const book = 'https://www.matchi.se/book/schedule?facilityId=2619&date=2026-10-28&sport=5';
    // Read after the mark with one court free at 19:00 for 120 min: it is another court, so it is offered (the review's St Ives case).
    expect(second({ booked: booking(after) })).toEqual({ count: 8, names: eight.map((p) => p.name), start: '19:00', book });
    // A read from before the mark may still show our own court: nothing is offered until the next read, whatever it shows.
    expect(second({ booked: booking(before) })).toBeUndefined();
    expect(second({ booked: booking(before), availability: at({ '19:00': { courts: 2, min: 60, max: 120 } }) })).toBeUndefined();
    expect(second({ booked: booking(undefined) })).toBeUndefined();
    // The booked start and length decide: a court free only at 19:30, or only for 60 minutes, offers nothing.
    expect(second({ booked: booking(after), availability: at({ '19:30': { courts: 2, min: 60, max: 120 } }) })).toBeUndefined();
    expect(second({ booked: booking(after), availability: at({ '19:00': { courts: 2, min: 60, max: 60 } }) })).toBeUndefined();
    // Seven in, or eight with one who cannot get to St Ives: none. Two courts already booked: none.
    expect(second({ booked: booking(after), votes: v8.slice(0, 7) })).toBeUndefined();
    expect(second({ booked: booking(after), people: [...eight.slice(0, 7), { id: 8, name: 'P8', venues: ['pdl'] }] })).toBeUndefined();
    expect(second({ booked: booking(after, { courts: 2 }) })).toBeUndefined();
    expect(computeState({ people: eight, votes: v8, booked: booking(after), availability: at({ '19:00': { courts: 1, min: 60, max: 120 } }), dates, nowMs: NOW }).ready).toEqual([]);
  });
  it('decideAlerts sends nothing for a ready hour on a booked day, whatever the state handed to it', () => {
    const state = { ready: [{ slot: '2026-10-28|18', date: '2026-10-28' }, { slot: '2026-10-29|18', date: '2026-10-29' }], booked: { '2026-10-28|20': { venue: 'si' } } };
    expect(decideAlerts(state, []).map((r) => r.slot)).toEqual(['2026-10-29|18']);
  });
  it('the DM names the lengths and court counts per start', () => {
    const s = computeState({ people, votes, booked: [], availability: fresh({ pdl: { '2026-10-28': { status: 'ok', starts: { '19:00': { courts: 3, min: 60, max: 120 }, '19:30': { courts: 1, min: 60, max: 60 } } } } }), dates, nowMs: NOW });
    expect(alertText(s.ready[0], venueConfig(), 'p')).toContain('Cambridge: 4 in (P1, P2, P3, P4), starts 19:00 (60 to 120 min, 3 courts), 19:30 (60 min), book <');
    expect(s.ready[0].venues[0]).toMatchObject({ courts: 3, max: 120, maxs: [120, 60], courtsBy: [3, 1] });
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
