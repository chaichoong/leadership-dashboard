// PDL Padel United Cambridge moves from Matchi to Playtomic for games from 1 Dec 2026 (club email,
// 3 Nov 2026). The Mac reader reads Cambridge from Playtomic for those days and from Matchi before
// them, and the page's Book link follows. Playtomic's shapes were read live on 5 Nov 2026: the club
// page carries its courts (features "Double" or "Single"); the availability call gives each court's
// free starts in UTC with every booking length on offer. The club page here is invented, laid out
// as Playtomic's own.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readAll, readProblems, RETRY_MS } from '../scripts/padel-courts.mjs';
import { parsePlaytomic, parsePlaytomicCourts, bookUrl, venueConfig, londonDates } from '../workers/padel/padel.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (f) => readFileSync(resolve(ROOT, 'tests/fixtures/padel', f), 'utf8');
const CLUB = fixture('playtomic-club-sample.html');
const PDL_PAGE = fixture('matchi-3122-2026-10-28.html');
const SI_PAGE = fixture('matchi-2619-2026-10-28.html');
const C = (n) => `c0000000-0000-4000-8000-00000000000${n}`;
const COURTS = parsePlaytomicCourts(CLUB);

describe('the club page: its courts, doubles marked', () => {
  it('reads every court, and which are doubles, from the escaped data (a "[" in a name included)', () => {
    expect(COURTS).toEqual([
      { id: C(1), name: 'Court 1', double: true }, { id: C(2), name: 'Court 2', double: true },
      { id: C(3), name: 'Court 3 [New]', double: true }, { id: C(4), name: 'Singles', double: false }]);
  });
  it('names with quotes and brackets are names, not structure (the page escapes them twice)', () => {
    const esc = (t) => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');           // how the page's data string escapes JSON
    const list = [{ resourceId: 'x1', name: 'Court "B" ] odd [', features: ['Double'] }, { resourceId: 'x2', name: 'Plain', features: ['Single'] }];
    const page = `<script>self.__next_f.push([1,"${esc(JSON.stringify({ resources: list, after: [1, 2] }))}"])</script>`;
    expect(parsePlaytomicCourts(page)).toEqual([{ id: 'x1', name: 'Court "B" ] odd [', double: true }, { id: 'x2', name: 'Plain', double: false }]);
  });
  it('a page with no court list is unreadable; a club not live yet has an empty list', () => {
    expect(parsePlaytomicCourts('<html>Not found</html>')).toBeNull();
    expect(parsePlaytomicCourts(null)).toBeNull();
    expect(parsePlaytomicCourts('x \\"resources\\":[] y')).toEqual([]);
  });
});

describe('a day from the availability call', () => {
  const slot = (start_time, duration) => ({ start_time, duration, price: '30 GBP' });
  it('per London start: the doubles courts free, the shortest and longest booking; the singles court never counts', () => {
    const reply = [
      { resource_id: C(1), start_date: '2026-12-01', slots: [slot('18:00:00', 60), slot('18:00:00', 90), slot('19:30:00', 60)] },
      { resource_id: C(2), start_date: '2026-12-01', slots: [slot('18:00:00', 120)] },
      { resource_id: C(4), start_date: '2026-12-01', slots: [slot('18:00:00', 60), slot('20:00:00', 60)] },
    ];
    expect(parsePlaytomic(reply, COURTS, '2026-12-01')).toEqual({ status: 'ok', starts: {
      '18:00': { courts: 2, min: 60, max: 120 }, '19:30': { courts: 1, min: 60, max: 60 } } });
  });
  it('times are UTC: in British Summer Time 18:00 is 19:00 in London, and a slot on another London day is left out', () => {
    const reply = [{ resource_id: C(1), start_date: '2027-04-06', slots: [slot('18:00:00', 60), slot('23:30:00', 60)] }];
    expect(parsePlaytomic(reply, COURTS, '2027-04-06')).toEqual({ status: 'ok', starts: { '19:00': { courts: 1, min: 60, max: 60 } } });
  });
  it('lengths over three hours are shown as three hours; nothing free is a day with no starts', () => {
    expect(parsePlaytomic([{ resource_id: C(1), start_date: '2026-12-02', slots: [slot('10:00:00', 240)] }], COURTS, '2026-12-02').starts['10:00'].max).toBe(180);
    expect(parsePlaytomic([], COURTS, '2026-12-02')).toEqual({ status: 'ok', starts: {} });
  });
  it('a court whose day crosses midnight UTC comes back as two entries: each start counted once', () => {
    const reply = [
      { resource_id: C(1), start_date: '2026-12-01', slots: [slot('20:00:00', 60)] },
      { resource_id: C(1), start_date: '2026-12-01', slots: [slot('20:00:00', 90)] },
      { resource_id: C(1), start_date: '2026-12-02', slots: [slot('00:30:00', 60)] }];
    expect(parsePlaytomic(reply, COURTS, '2026-12-01')).toEqual({ status: 'ok', starts: { '20:00': { courts: 1, min: 60, max: 90 } } });
  });
  it('never "no court free" by mistake: no doubles listed, or a reply about courts the page does not list, is an error (review of PR 888)', () => {
    const singlesOnly = COURTS.map((c) => ({ ...c, double: false }));
    expect(parsePlaytomic([], singlesOnly, '2026-12-01')).toEqual({ status: 'error', reason: 'no doubles courts listed on Playtomic' });
    const stranger = [{ resource_id: 'not-on-the-page', start_date: '2026-12-01', slots: [slot('18:00:00', 60)] }];
    expect(parsePlaytomic(stranger, COURTS, '2026-12-01')).toEqual({ status: 'error', reason: 'the reply names courts the club page does not list' });
    const singlesBusy = [{ resource_id: C(4), start_date: '2026-12-01', slots: [slot('18:00:00', 60)] }];
    expect(parsePlaytomic(singlesBusy, COURTS, '2026-12-01')).toEqual({ status: 'ok', starts: {} });   // only the singles court free: no doubles free
  });
  it('a reply it cannot read, or a club with no courts listed, is an error with its reason', () => {
    expect(parsePlaytomic({ error: 'x' }, COURTS, '2026-12-01')).toEqual({ status: 'error', reason: 'unexpected shape' });
    expect(parsePlaytomic([{ resource_id: C(1), start_date: '2026-12-01', slots: [slot('nonsense', 60)] }], COURTS, '2026-12-01')).toEqual({ status: 'error', reason: 'unexpected shape' });
    expect(parsePlaytomic([], [], '2026-12-01')).toEqual({ status: 'error', reason: 'no courts listed on Playtomic' });
  });
});

describe('the Book link follows the club', () => {
  it('Matchi to 30 Nov, the Playtomic club page from 1 Dec', () => {
    const cfg = venueConfig();
    expect(bookUrl(cfg, 'pdl', '2026-11-30')).toBe('https://www.matchi.se/book/schedule?facilityId=3122&date=2026-11-30&sport=5');
    expect(bookUrl(cfg, 'pdl', '2026-12-01')).toBe('https://playtomic.com/clubs/pdl-padel-united-cambridge');
    expect(bookUrl(cfg, 'si', '2026-12-01')).toBe('https://www.matchi.se/book/schedule?facilityId=2619&date=2026-12-01&sport=5');
  });
});

describe('the reader across the switch', () => {
  // 09:00 London on Tue 24 Nov 2026: the window is 24 Nov to 7 Dec, so PDL is 7 days on Matchi and 7 on Playtomic.
  const NOW = Date.parse('2026-11-24T09:00:00Z');
  const DATES = londonDates(NOW);
  const fake = ({ club = () => new Response(CLUB, { status: 200 }), day = (date) => new Response(JSON.stringify([
    { resource_id: C(1), start_date: date, slots: [{ start_time: '18:00:00', duration: 90 }] }]), { status: 200 }) } = {}) => {
    const calls = { matchi: [], club: 0, days: [] };
    const fetchImpl = async (url) => {
      const u = new URL(url);
      if (u.hostname === 'www.matchi.se') { calls.matchi.push(`${u.searchParams.get('facilityId')} ${u.searchParams.get('date')}`); return new Response(u.searchParams.get('facilityId') === '3122' ? PDL_PAGE : SI_PAGE, { status: 200 }); }
      if (u.hostname === 'playtomic.com' && u.pathname === '/clubs/pdl-padel-united-cambridge') { calls.club++; return club(); }
      if (u.hostname === 'playtomic.com' && u.pathname === '/api/clubs/availability') {
        expect(u.searchParams.get('tenant_id')).toBe('90683b2f-2f6a-4680-a167-cbfa4fd7ea55');
        calls.days.push(u.searchParams.get('date'));
        return day(u.searchParams.get('date'));
      }
      if (u.hostname === 'cambridgesport.gladstonego.cloud') return new Response('[]', { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    };
    return { calls, fetchImpl };
  };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };

  it('Cambridge before 1 Dec from Matchi, from 1 Dec from Playtomic (its courts read once); St Ives untouched', async () => {
    const f = fake();
    const { raw } = await readAll({ fetchImpl: f.fetchImpl, sleep, nowMs: NOW });
    const before = DATES.filter((d) => d < '2026-12-01');
    const after = DATES.filter((d) => d >= '2026-12-01');
    expect(after).toEqual(['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06', '2026-12-07']);
    expect(f.calls.matchi.filter((c) => c.startsWith('3122')).map((c) => c.slice(5))).toEqual(before);
    expect(f.calls.matchi.filter((c) => c.startsWith('2619'))).toHaveLength(14);
    expect(f.calls.days).toEqual(after);
    expect(f.calls.club).toBe(1);
    expect(raw.pdl['2026-12-01']).toEqual({ status: 'ok', starts: { '18:00': { courts: 1, min: 90, max: 90 } } });
    expect(raw.pdl[before[0]].status).toBe('ok');                       // a Matchi day, as before
  });

  it('a club page that fails is tried twice in all, and every Playtomic day says why; no day is retried on its own', async () => {
    const f = fake({ club: () => new Response('', { status: 503 }) });
    sleeps.length = 0;
    const { raw } = await readAll({ fetchImpl: f.fetchImpl, sleep, nowMs: NOW });
    expect(f.calls.club).toBe(2);
    expect(f.calls.days).toEqual([]);
    expect(raw.pdl['2026-12-07']).toEqual({ status: 'error', reason: 'HTTP 503' });
    expect(sleeps.filter((ms) => ms === RETRY_MS)).toHaveLength(1);    // the one retry of the club page
  });

  it('a club not live on Playtomic yet: its days are "not open yet" until the switch, and the run passes; from the switch it is an error that fails the run', async () => {
    const empty = () => new Response('x \\"resources\\":[] y', { status: 200 });
    const before = await readAll({ fetchImpl: fake({ club: empty }).fetchImpl, sleep, nowMs: NOW });
    expect(before.raw.pdl['2026-12-01']).toEqual({ status: 'closed', notLive: true });
    expect(readProblems(before.raw, before.dates).filter((p) => p.startsWith('PDL'))).toEqual([]);   // (this fake University feed is empty)
    const LATER = Date.parse('2026-12-02T09:00:00Z');
    const after = await readAll({ fetchImpl: fake({ club: empty }).fetchImpl, sleep, nowMs: LATER });
    expect(after.raw.pdl['2026-12-02']).toEqual({ status: 'error', reason: 'no courts listed on Playtomic' });
    expect(readProblems(after.raw, after.dates).join(' ')).toMatch(/PDL 2026-12-02 could not be read \(no courts listed on Playtomic\)/);
  });

  it('Playtomic refusing us (a 4xx) fails the run at once, even in November when MATCHi still reads', async () => {
    const f = fake({ day: () => new Response('', { status: 403 }) });
    const { raw, dates } = await readAll({ fetchImpl: f.fetchImpl, sleep, nowMs: NOW });
    expect(raw.pdl['2026-12-01']).toEqual({ status: 'error', reason: 'Playtomic refused (HTTP 403)' });
    expect(readProblems(raw, dates).join(' ')).toMatch(/PDL 2026-12-01 could not be read \(Playtomic refused \(HTTP 403\)\)/);
  });

  it('a Playtomic day lost to a 5xx is read once more; a 4xx is not', async () => {
    const seen = {};
    const f = fake({ day: (date) => { seen[date] = (seen[date] || 0) + 1; return date === '2026-12-03' ? new Response('', { status: 502 }) : date === '2026-12-04' ? new Response('', { status: 404 }) : new Response('[]', { status: 200 }); } });
    const { raw } = await readAll({ fetchImpl: f.fetchImpl, sleep, nowMs: NOW });
    expect(seen['2026-12-03']).toBe(2);
    expect(seen['2026-12-04']).toBe(1);
    expect(raw.pdl['2026-12-03']).toEqual({ status: 'error', reason: 'HTTP 502' });
    expect(raw.pdl['2026-12-05']).toEqual({ status: 'ok', starts: {} });
  });
});

describe('the reader and the Worker agree on the club', () => {
  it('the defaults the Mac reader uses are the settings in wrangler.toml', () => {
    const toml = readFileSync(resolve(ROOT, 'workers/padel/wrangler.toml'), 'utf8');
    const v = (k) => (new RegExp(`^${k}\\s*=\\s*"([^"]+)"`, 'm').exec(toml) || [])[1];
    const pdl = venueConfig().pdl;
    expect([v('PDL_PLAYTOMIC_FROM'), v('PDL_PLAYTOMIC_ID'), v('PDL_PLAYTOMIC_SLUG')]).toEqual([pdl.playtomicFrom, pdl.playtomicId, pdl.playtomicSlug]);
  });
});
