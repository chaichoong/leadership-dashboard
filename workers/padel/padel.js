// Padel Worker logic (worker.js is the entry point): the padel group's "who can play when" page (Kevin approved the plan, 27 Oct 2026).
//
// WHAT IT DOES: an 11-person WhatsApp group ticks the hours they can play over the next 7 days on
// one phone page. The Worker knows which courts are free at three venues and sends Kevin ONE Slack
// DM the first time 4+ people line up on an hour where a court is free. Nobody has to count.
//
// Routes (JSON). Every /api request is rate limited per caller BEFORE any key check.
//   GET  /api/health                        -> { ok, version }                 no key, no data
//   GET  /api/courts      (X-Robot-Key)     -> { ok, version, matchiFetchedAt, pulseFetchedAt, venueStatus }
//   POST /api/courts      (X-Robot-Key)     -> { ok, matchiFetchedAt, pulseFetchedAt, alerted: 'checking', ready }
//        { readAt, venues: { si: { "<date>": day }, pdl: { ... } } }  the Mac mini's Matchi read
//   Every other route needs X-Group-Key = GROUP_KEY:
//   GET  /api/ping                          -> { ok }                          the key register's test
//   GET  /api/state                         -> the whole page state (kicks a lazy Pulse read)
//   POST /api/person  { name }              -> { id, name, venues }   creates the name if absent
//   POST /api/person  { id, venues:[...] }  -> { id, name, venues }   venue preferences
//   POST /api/vote    { person_id, add, remove } -> state            applies that person's tick changes
//   POST /api/booked  { slot, person_id, venue, booked } -> state
//   POST /api/refresh                       -> state + { refreshed }  "Check now" (Pulse only)
// The page itself is a static asset in ./public, served without this Worker (wrangler.toml
// run_worker_first = ["/api/*"]); its headers live in public/_headers.
//
// A slot is "YYYY-MM-DD|HH": the London date and two-digit start hour, 07 to 21.
// Venues: si = St Ives Golf Club (Matchi 2619), pdl = PDL Padel United Cambridge (Matchi 3122),
// pp = Pulse Padel Huntingdon (the Nettla booking widget's public availability endpoint, called
// at most once per 15 minutes: Kevin's go-ahead, 27 Oct 2026).
//
// WHO READS WHAT. Matchi answers every /book/schedule request from Cloudflare's edge with HTTP 429
// (12 of 12 probes on 27 Oct 2026) and 200 from the Mac mini. So St Ives and PDL are read by
// scripts/padel-courts.mjs on the Mac every 15 minutes (06:30 to 23:00 London), which POSTs the
// parsed days to /api/courts. That script imports parseMatchi, matchiUrl, MATCHI_HEADERS and
// londonDates from this file, so both sides parse one way. Pulse is read here.
//
// FRESHNESS. A venue's data counts only while it is fresh: St Ives and PDL for 45 minutes after
// the Mac's read, Pulse for 20 minutes. A venue that is not fresh shows "couldn't check" with its
// own booking link and is NEVER counted towards a DM.
//
// NO cron (all five free-plan triggers are used) and NO KV (free-tier writes starve the other
// Workers). D1 holds everything; see schema.sql.
//
// Bindings: DB (D1), RELAY (service binding to apple-inbound's /slack-relay), WRITE_LIMIT
//           (ratelimit, optional). Secrets: GROUP_KEY, ROBOT_KEY, RELAY_KEY.

export const VERSION = '2026-10-27.6';
export const TZ = 'Europe/London';
export const VENUES = ['si', 'pdl', 'pp'];
const MATCHI_VENUES = ['si', 'pdl'];
export const HOURS = Array.from({ length: 15 }, (_, i) => i + 7);          // 7..21
const HH = new Set(HOURS.map((h) => String(h).padStart(2, '0')));
export const DAYS = 7;
export const MAX_MIN = 90;                       // an hour counts as free only for a start of 90 min or less
export const MATCHI_FRESH_MS = 45 * 60 * 1000;   // St Ives and PDL count for 45 minutes after the Mac's read
export const PULSE_FRESH_MS = 20 * 60 * 1000;    // Pulse counts for 20 minutes after its read
export const PULSE_EVERY_MS = 15 * 60 * 1000;    // Pulse is called at most once per 15 minutes
export const REFRESH_GUARD_MS = 90 * 1000;       // no second Pulse read within 90 seconds
export const READ_AT_SKEW_MS = 10 * 60 * 1000;   // a Mac read older (or newer) than this is refused
export const CLAIM_BUDGET_MS = 5000;             // a check claims no new slot once it has run this long
export const SAVE_REPLY_RETRIES = 3;             // after a relay 200, the reply write is retried up to 3 times
export const SAVE_REPLY_PAUSES_MS = [500, 1000, 2000];   // ...with these pauses between the tries
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const FETCH_TIMEOUT_MS = 8000;
export const RELAY_TIMEOUT_MS = 20000;          // the background check has 30 s in all
export const RELAY_BODY_TIMEOUT_MS = 5000;      // reading a 200's body, after the placeholder is in
export const ALERT_AT = 4;
const MAX_PEOPLE = 40;
const MAX_BODY = 16 * 1024;
const MAX_COURTS_BODY = 64 * 1024;
// Latin letters only (A-Z, a-z and the Latin-1 letters), spaces, hyphens and straight apostrophes.
const NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ' -]+$/;
const NAME_LETTER_RE = /[A-Za-zÀ-ÖØ-öø-ÿ]/g;
const SLOT_RE = /^(\d{4}-\d{2}-\d{2})\|(\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const START_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export const MATCHI_HEADERS = Object.freeze({ 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' });
const PULSE_RPC = 'https://europe-west1-nettle-prod-2024.cloudfunctions.net/rpc/availability/search';
const PULSE_PAGE = 'https://pulsepadel.co.uk/venue/huntingdon/';
const RELAY_URL = 'https://apple-inbound/slack-relay';
const GATE_MSG = 'This link needs the group code. Ask Kevin.';

// ── Venue config: labels and ids live in wrangler.toml [vars]; these defaults match it ──
export function venueConfig(env = {}) {
  return {
    si: { code: 'si', label: env.SI_LABEL || 'St Ives Golf Club', short: env.SI_SHORT || 'St Ives', matchiId: env.SI_MATCHI_ID || '2619' },
    pdl: { code: 'pdl', label: env.PDL_LABEL || 'PDL Padel United Cambridge', short: env.PDL_SHORT || 'PDL', matchiId: env.PDL_MATCHI_ID || '3122' },
    pp: { code: 'pp', label: env.PP_LABEL || 'Pulse Padel Huntingdon', short: env.PP_SHORT || 'Pulse', clubId: env.PP_CLUB_ID || 'VEqVgpQmiJLiEC1Lm4z3' },
  };
}
export const matchiUrl = (id, date) => `https://www.matchi.se/book/schedule?facilityId=${id}&date=${date}&sport=5`;
export function bookUrl(cfg, code, date) {
  return code === 'pp' ? PULSE_PAGE : matchiUrl(cfg[code].matchiId, date);
}

// ── London time. Workers run in UTC; every date and hour the group sees is London local. ──
// UK clocks run BST (UTC+1) from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last
// Sunday of October. Arithmetic, not Intl: a refresh converts ~150 Pulse instants and Intl's
// formatToParts cost more CPU than the free plan's 10 ms leaves room for. Checked against Intl for
// every hour of 2025 to 2027 in tests/padel-worker.test.js.
const BST = new Map();
function bstBounds(y) {
  if (!BST.has(y)) {
    const last = (m) => { const d = new Date(Date.UTC(y, m + 1, 0)); return Date.UTC(y, m, d.getUTCDate() - d.getUTCDay(), 1); };
    BST.set(y, [last(2), last(9)]);
  }
  return BST.get(y);
}
export function londonOffsetMin(ms) {
  const [on, off] = bstBounds(new Date(ms).getUTCFullYear());
  return ms >= on && ms < off ? 60 : 0;
}
export function londonParts(ms) {
  const iso = new Date(ms + londonOffsetMin(ms) * 60000).toISOString();
  return { date: iso.slice(0, 10), hh: iso.slice(11, 13), mm: iso.slice(14, 16) };
}
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}
export function londonDates(nowMs, n = DAYS) {
  const today = londonParts(nowMs).date;
  return Array.from({ length: n }, (_, i) => addDays(today, i));
}
// The UTC instant of 00:00 London on a date (London is UTC+0 or UTC+1, never behind UTC).
export function londonMidnightMs(date) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const p = londonParts(guess);
  return guess - (Number(p.hh) * 60 + Number(p.mm)) * 60 * 1000;
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${WD[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()]} ${d} ${MON[m - 1]}`;
}
const londonHHMM = (iso) => { const p = londonParts(Date.parse(iso)); return `${p.hh}:${p.mm}`; };

// ── Matchi: one schedule page per venue per date (parsed on the Mac, see the header) ──
// Each 30-minute cell is a <td class="slot free|red|can-not-start|not-available">. A bookable start
// is a "slot free" cell with data-slot-can-start="true"; its title reads "Available<br>Court 1<br>
// 07:00 - 08:00" (the court and the MINIMUM booking from that cell) and data-slot-min-duration is
// 60 or 90. Attribute order is not fixed and titles can hold newlines, so each cell's tag is read
// whole, quote-aware, and classes count in any order ("free slot" is "slot free"). A free, bookable
// cell this parser cannot read makes the whole day an error: a court it failed to see must never
// read as "no court".
function tagEnd(s, from) {
  let q = '';
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') return j;
  }
  return -1;
}
const ATTR_RE = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
function tagAttrs(text) {
  const at = {};
  ATTR_RE.lastIndex = 0;
  let a;
  while ((a = ATTR_RE.exec(text))) at[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
  return at;
}
const unent = (s) => s.replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const TITLE_RE = /Available\s*<br\s*\/?>\s*([\s\S]*?)\s*<br\s*\/?>\s*(\d{1,2}):(\d{2})\s*-\s*\d{1,2}:\d{2}/i;
const CELL_KINDS = ['free', 'red', 'can-not-start', 'not-available'];

export function parseMatchi(html) {
  if (typeof html !== 'string' || !/class="schedule[\s"]/.test(html)) return { status: 'error', reason: 'not a schedule page' };
  const starts = {};
  let cells = 0;
  let i = 0;
  while ((i = html.indexOf('<td', i)) !== -1) {           // every cell, whatever order its classes are in
    const open = i;
    i += 3;
    if (!/[\s>]/.test(html[open + 3] || '')) continue;       // <tdx...> is not a cell
    const end = tagEnd(html, open);
    if (end === -1) break;
    i = end;
    const at = tagAttrs(html.slice(open + 3, end));
    const cls = String(at.class || '').split(/\s+/);
    if (!cls.includes('slot')) continue;
    // A court cell of a kind this parser does not know (a renamed class) is an error for the day,
    // never "no court free" (checked 27 Oct 2026: only these four kinds exist on either venue).
    if (!CELL_KINDS.some((k) => cls.includes(k))) return { status: 'error', reason: 'unknown court cell' };
    cells++;
    if (!cls.includes('free') || at['data-slot-can-start'] !== 'true') continue;
    const m = TITLE_RE.exec(at.title || '');
    if (!m) return { status: 'error', reason: 'a free court cell could not be read' };
    const min = Number(at['data-slot-min-duration']);
    if (!Number.isInteger(min) || min <= 0) return { status: 'error', reason: 'a free court cell has no minimum booking' };
    const court = unent(m[1]).replace(/\s+/g, ' ').trim();
    if (/single/i.test(court)) continue;                  // two players only: never a doubles court
    const t = `${m[2].padStart(2, '0')}:${m[3]}`;
    const s = starts[t] || (starts[t] = { courts: 0, min, names: [] });
    if (!s.names.includes(court)) { s.names.push(court); s.courts++; }
    s.min = Math.min(s.min, min);
  }
  if (cells === 0) {
    // St Ives beyond its 7-day window (checked 27 Oct 2026 on 5 Nov) sends no table at all, only
    // "... allows bookings no more than 7 days in the future". That is "not open yet". A table
    // with no cell this parser recognises is an error: Matchi changed its page.
    if (/allows bookings no more than/i.test(html)) return { status: 'closed' };
    return { status: 'error', reason: 'no court cells recognised' };
  }
  return { status: 'ok', starts };
}

// ── Pulse Padel (Nettla widget) ──
// The search reply (oRPC) is { json: { availableSlots: { "<ISO instant>": [court, ...] } } }. Read
// live on 27 Oct 2026 (tests/fixtures/padel/pulse-search.json): each court is { courtId, name
// "Court 1", size "DoubleRegular", allowedPlayerCounts [4], durations [{ minutes: 60 }, { minutes:
// 90 }, ...], ... }. A start is bookable on a doubles court; its shortest booking is the smallest
// durations[].minutes (60 when a court gives none). Any other shape is an error: never guess slots.
const isDoubles = (c) => !/single/i.test(String(c.name || '')) && !/single/i.test(String(c.size || ''))
  && (!Array.isArray(c.allowedPlayerCounts) || c.allowedPlayerCounts.includes(4));
export function pulseValueCourts(v) {
  if (!Array.isArray(v) || v.some((c) => !c || typeof c !== 'object' || Array.isArray(c))) return undefined;
  const courts = v.filter(isDoubles);
  if (!courts.length) return null;
  const mins = courts.map((c) => {
    if (c.durations === undefined) return 60;
    if (!Array.isArray(c.durations)) return NaN;
    const m = c.durations.map((d) => Number(d && d.minutes)).filter((n) => n > 0);
    return m.length ? Math.min(...m) : NaN;
  });
  if (mins.some((m) => Number.isNaN(m))) return undefined;
  const ok = mins.filter((m) => m <= MAX_MIN);
  return { courts: ok.length || courts.length, min: Math.min(...mins) };
}
export function parsePulse(json, nowMs) {
  const slots = json && typeof json === 'object' ? (json.availableSlots ?? json.result?.availableSlots) : undefined;
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return { status: 'error', reason: 'unexpected shape' };
  const byDate = {};
  for (const [iso, v] of Object.entries(slots)) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return { status: 'error', reason: 'unexpected shape' };
    const got = pulseValueCourts(v);
    if (got === undefined) return { status: 'error', reason: 'unexpected shape' };
    if (got === null || ms < nowMs) continue;              // the widget drops starts earlier than now too
    const p = londonParts(ms);
    const t = `${p.hh}:${p.mm}`;
    const day = byDate[p.date] || (byDate[p.date] = {});
    day[t] = { courts: got.courts, min: got.min };
  }
  return { status: 'ok', byDate };
}

// ── From raw starts to the page's hour rows ──
export function hoursFromStarts(starts) {
  const hours = {};
  for (const t of Object.keys(starts || {}).sort()) {
    const s = starts[t];
    if (!(s && s.min <= MAX_MIN && s.courts > 0)) continue;
    const hh = t.slice(0, 2);
    if (!HH.has(hh)) continue;
    const h = hours[hh] || (hours[hh] = { free: true, min: s.min, starts: [], mins: [] });
    h.starts.push(t);
    h.mins.push(s.min);
    h.min = Math.min(h.min, s.min);
  }
  return hours;
}

// Drop starts that have already passed today, so nothing in the past shows green.
function futureStarts(starts, date, nowMs) {
  const now = londonParts(nowMs);
  if (date !== now.date) return starts || {};
  const cut = `${now.hh}:${now.mm}`;
  const out = {};
  for (const [t, s] of Object.entries(starts || {})) if (t >= cut) out[t] = s;
  return out;
}

const splitVenues = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter((x) => VENUES.includes(x));
const ageOk = (iso, nowMs, limit) => { const t = Date.parse(iso || ''); return Number.isFinite(t) && nowMs - t < limit; };

// The cache keeps the Mac's Matchi read and the Worker's Pulse read under separate keys, so a Pulse
// read that finishes after a Mac POST can never overwrite the Mac's fresh St Ives and PDL days.
//   matchi: { readAt, goodAt: { si, pdl }, venues: { si: { date: day }, pdl: {...} } }
//   pulse:  { fetchedAt, goodAt, format, days: { date: day } }
export function assembleAvailability(matchi, pulse) {
  return {
    matchiFetchedAt: matchi?.readAt || null,
    pulseFetchedAt: pulse?.fetchedAt || null,
    goodAt: { si: matchi?.goodAt?.si || null, pdl: matchi?.goodAt?.pdl || null, pp: pulse?.goodAt || null },
    venues: { si: matchi?.venues?.si || {}, pdl: matchi?.venues?.pdl || {}, pp: pulse?.days || {} },
  };
}

// ── The whole page state, pure ──
export function computeState({ people, votes, booked, availability, dates, nowMs, cfg = venueConfig() }) {
  const today = dates[0];
  const inWindow = new Set(dates);
  const ppl = people.map((p) => ({ id: p.id, name: p.name, venues: Array.isArray(p.venues) ? p.venues : splitVenues(p.venues), savedAt: p.savedAt ?? null }));
  const byId = new Map(ppl.map((p) => [p.id, p]));
  const voteMap = {};
  for (const v of votes) {
    const m = SLOT_RE.exec(v.slot);
    if (!m || !inWindow.has(m[1]) || !byId.has(v.person_id)) continue;
    (voteMap[v.slot] || (voteMap[v.slot] = [])).push(v.person_id);
  }
  const bookedMap = {};
  for (const b of booked) {
    const m = SLOT_RE.exec(b.slot);
    if (m && inWindow.has(m[1])) bookedMap[b.slot] = { person_id: b.person_id ?? null, venue: b.venue ?? null };
  }
  const a = availability || {};
  const fetchedAt = { si: a.matchiFetchedAt || null, pdl: a.matchiFetchedAt || null, pp: a.pulseFetchedAt || null };
  const fresh = {
    si: ageOk(fetchedAt.si, nowMs, MATCHI_FRESH_MS),
    pdl: ageOk(fetchedAt.pdl, nowMs, MATCHI_FRESH_MS),
    pp: ageOk(fetchedAt.pp, nowMs, PULSE_FRESH_MS),
  };
  const checkedAt = { si: a.goodAt?.si || null, pdl: a.goodAt?.pdl || null, pp: a.goodAt?.pp || null };
  const venuesOut = {};
  for (const code of VENUES) {
    venuesOut[code] = {};
    for (const date of dates) {
      if (!fresh[code]) { venuesOut[code][date] = { status: 'error', reason: 'not checked recently', hours: {} }; continue; }
      const day = a.venues?.[code]?.[date];
      if (!day) { venuesOut[code][date] = { status: 'pending', hours: {} }; continue; }
      const out = { status: day.status, hours: day.status === 'ok' ? hoursFromStarts(futureStarts(day.starts, date, nowMs)) : {} };
      if (day.reason) out.reason = day.reason;
      venuesOut[code][date] = out;
    }
  }
  const ready = [];
  const nearly = [];
  for (const slot of Object.keys(voteMap).sort()) {
    if (bookedMap[slot]) continue;
    const [, date, hh] = SLOT_RE.exec(slot);
    const voters = voteMap[slot].map((id) => byId.get(id));
    const counts = [];
    for (const code of VENUES) {
      const h = venuesOut[code][date];
      if (!fresh[code] || h.status !== 'ok' || !h.hours[hh]?.free) continue;
      const in_ = voters.filter((p) => p.venues.includes(code));
      counts.push({ code, count: in_.length, people: in_, hour: h.hours[hh] });
    }
    if (!counts.length) continue;
    const best = Math.max(...counts.map((c) => c.count));
    const label = `${dayLabel(date)} ${hh}:00`;
    if (best >= ALERT_AT) {
      const q = counts.filter((c) => c.count >= ALERT_AT);
      const names = [];
      const ids = [];
      for (const c of q) for (const p of c.people) if (!ids.includes(p.id)) { ids.push(p.id); names.push(p.name); }
      ready.push({
        slot, date, hh, label, count: best, names, person_ids: ids,
        venues: q.map((c) => ({
          code: c.code, count: c.count, names: c.people.map((p) => p.name), starts: c.hour.starts, mins: c.hour.mins,
          min: c.hour.min, book: bookUrl(cfg, c.code, date), checkedAt: fetchedAt[c.code],
        })),
      });
    } else if (best === ALERT_AT - 1) {
      const q = counts.filter((c) => c.count === best);
      const names = [];
      for (const c of q) for (const p of c.people) if (!names.includes(p.name)) names.push(p.name);
      nearly.push({ slot, date, hh, label, count: best, names, venues: q.map((c) => ({ code: c.code, starts: c.hour.starts })) });
    }
  }
  const venueInfo = {};
  for (const code of VENUES) {
    venueInfo[code] = { label: cfg[code].label, short: cfg[code].short, book: Object.fromEntries(dates.map((d) => [d, bookUrl(cfg, code, d)])) };
  }
  return {
    today, days: dates, hours: HOURS, people: ppl, votes: voteMap, booked: bookedMap,
    availability: { stale: false, fresh, checkedAt, fetchedAt, venues: venuesOut }, venueInfo, ready, nearly,
  };
}

// The ready slots that still need their one DM.
export function decideAlerts(state, alreadyAlerted) {
  const done = alreadyAlerted instanceof Set ? alreadyAlerted : new Set(alreadyAlerted || []);
  return state.ready.filter((r) => !done.has(r.slot) && !state.booked[r.slot]);
}

function startsText(v) {
  const same = v.mins.every((m) => m === v.mins[0]);
  return same ? `${v.starts.join(', ')} (${v.mins[0]} min)` : v.starts.map((t, i) => `${t} (${v.mins[i]} min)`).join(', ');
}
const slackSafe = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function checkedText(venues, cfg) {
  const groups = [];
  for (const v of venues) {
    const t = v.checkedAt ? londonHHMM(v.checkedAt) : '?';
    const g = groups.find((x) => x.t === t);
    if (g) g.names.push(cfg[v.code].short); else groups.push({ t, names: [cfg[v.code].short] });
  }
  if (groups.length === 1) return `Courts checked ${groups[0].t}.`;
  return `Courts checked: ${groups.map((g) => `${g.names.join(' and ')} ${g.t}`).join(', ')}.`;
}
// One line per venue, each with its OWN count and names: people are never added up across venues.
export function alertText(r, cfg, pageUrl) {
  const lines = r.venues.map((v) => `${cfg[v.code].short}: ${v.count} in (${v.names.map(slackSafe).join(', ')}), starts ${startsText(v)}, book <${v.book}>.`);
  return `Padel: ${r.label}. ${lines.join(' ')} ${checkedText(r.venues, cfg)} Whoever books taps Booked on the page ${pageUrl}`;
}

// Names: one person, one row. Accents and case are folded before comparing, so "Zoë" and "ZOE"
// find the same person.
export const foldName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ── D1 access, behind one small object so tests can swap in a Map-backed copy ──
const toPerson = (r) => ({ id: r.id, name: r.name, venues: splitVenues(r.venues), savedAt: r.votes_at || null });
export function makeRepo(db) {
  return {
    async listPeople() {
      const r = await db.prepare('SELECT id, name, venues, votes_at FROM people ORDER BY name COLLATE NOCASE').all();
      return (r.results || []).map(toPerson);
    },
    async getPerson(id) {
      const r = await db.prepare('SELECT id, name, venues, votes_at FROM people WHERE id = ?').bind(id).first();
      return r ? toPerson(r) : null;
    },
    async countPeople() {
      const r = await db.prepare('SELECT COUNT(*) AS n FROM people').first();
      return Number(r?.n || 0);
    },
    async addPerson(name, nowIso) {
      await db.prepare("INSERT INTO people (name, venues, created_at) VALUES (?, 'si,pdl,pp', ?) ON CONFLICT(name) DO NOTHING").bind(name, nowIso).run();
      const r = await db.prepare('SELECT id, name, venues, votes_at FROM people WHERE name = ? COLLATE NOCASE').bind(name).first();
      return r ? toPerson(r) : null;
    },
    async setVenues(id, venues) {
      const r = await db.prepare('UPDATE people SET venues = ? WHERE id = ?').bind(venues.join(','), id).run();
      return (r.meta?.changes || 0) === 1;
    },
    async listVotes(fromDate) {
      const r = await db.prepare('SELECT person_id, slot FROM votes WHERE slot >= ? ORDER BY slot').bind(fromDate).all();
      return r.results || [];
    },
    // A save is a change, never the whole list: the hours ticked since the last save are added, the
    // hours unticked are removed, in one batch, and votes_at says when this person last saved. Two
    // phones adding different hours therefore merge, and a late or repeated save does no harm.
    async applyVotes(personId, add, remove, nowIso) {
      if (!add.length && !remove.length) return;            // nothing changed: votes_at keeps the last real save
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO votes (person_id, slot, created_at) SELECT ?1, value, ?3 FROM json_each(?2)').bind(personId, JSON.stringify(add), nowIso),
        db.prepare('DELETE FROM votes WHERE person_id = ?1 AND slot IN (SELECT value FROM json_each(?2))').bind(personId, JSON.stringify(remove)),
        db.prepare('UPDATE people SET votes_at = ?2 WHERE id = ?1').bind(personId, nowIso),
      ]);
    },
    async listBooked(fromDate) {
      const r = await db.prepare('SELECT slot, person_id, venue FROM booked WHERE slot >= ?').bind(fromDate).all();
      return r.results || [];
    },
    async setBooked(slot, personId, venue, nowIso) {
      await db.prepare('INSERT INTO booked (slot, person_id, venue, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(slot) DO UPDATE SET person_id = excluded.person_id, venue = excluded.venue, created_at = excluded.created_at')
        .bind(slot, personId, venue, nowIso).run();
    },
    async clearBooked(slot) {
      await db.prepare('DELETE FROM booked WHERE slot = ?').bind(slot).run();
    },
    // The slots whose DM is done, under way, or given up: every row. A claimed row is final.
    async alertSlots(fromDate) {
      const r = await db.prepare('SELECT slot FROM alerts WHERE slot >= ?').bind(fromDate).all();
      return (r.results || []).map((x) => x.slot);
    },
    // Only the request whose insert changed a row sends the DM. The row carries a "claimed" reply
    // from the start, so a Worker stopped mid-send leaves a final row, never one to send again.
    async claimAlert(slot, names, venues, nowIso) {
      const r = await db.prepare('INSERT OR IGNORE INTO alerts (slot, sent_at, names, venues, relay_reply) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(slot, nowIso, names, venues, JSON.stringify({ claimed: true, at: nowIso })).run();
      return (r.meta?.changes || 0) === 1;
    },
    async saveRelayReply(slot, reply) {
      await db.prepare('UPDATE alerts SET relay_reply = ? WHERE slot = ?').bind(reply, slot).run();
    },
    async releaseAlert(slot) {
      await db.prepare('DELETE FROM alerts WHERE slot = ?').bind(slot).run();
    },
    async getCache(key) {
      const r = await db.prepare('SELECT value FROM cache WHERE key = ?').bind(key).first();
      return r ? r.value : null;
    },
    async setCache(key, value, nowIso) {
      await db.prepare('INSERT INTO cache (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .bind(key, value, nowIso).run();
    },
    // Atomic: the upsert only lands when the last start is older than the guard.
    async claimRefresh(nowMs, guardMs) {
      const r = await db.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('refresh_started_at', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE CAST(cache.value AS INTEGER) <= ?3")
        .bind(String(nowMs), new Date(nowMs).toISOString(), nowMs - guardMs).run();
      return (r.meta?.changes || 0) === 1;
    },
    async prune(today) {
      await db.batch([
        db.prepare('DELETE FROM votes WHERE slot < ?').bind(today),
        db.prepare('DELETE FROM booked WHERE slot < ?').bind(today),
        db.prepare('DELETE FROM alerts WHERE slot < ?').bind(today),
      ]);
    },
  };
}

// ── Cache reads ──
async function readJsonCache(repo, key) {
  const raw = await repo.getCache(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { console.error('padel: cached value unreadable', key, String(e)); return null; }
}
async function loadAvailability(repo) {
  const [matchi, pulse] = await Promise.all([readJsonCache(repo, 'matchi'), readJsonCache(repo, 'pulse')]);
  return { matchi, pulse, availability: assembleAvailability(matchi, pulse) };
}
const pulseDue = (pulse, nowMs) => !ageOk(pulse?.fetchedAt, nowMs, PULSE_EVERY_MS);

// ── Pulse read ──
const failReason = (e) => (e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timed out' : 'could not reach the site');
function withTimeout(promise, ms) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => { const e = new Error('timed out'); e.name = 'TimeoutError'; reject(e); }, ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// One search for the whole 7-day range. Three body formats, the one that worked last first:
//   orpc     { json: {...} } in, { json: {...}, meta } out. What the endpoint speaks: on 27 Oct 2026
//            both other formats got HTTP 400 {"json":{"code":"BAD_REQUEST","message":"Input
//            validation failed", ... "expected object, received undefined"}}, an oRPC reply.
//   plain    the bare body; envelope: Firebase callable { data } in, { result } out.
// Only an HTTP 400 (the endpoint refusing the body format) moves on to the next format. A timeout,
// a 429, a 5xx or a reply in a shape we do not know stops at once with that reason: trying again
// in another format would only hide the real fault and spend more calls.
const PULSE_FORMATS = {
  orpc: { wrap: (b) => ({ json: b }), unwrap: (j) => j?.json },
  plain: { wrap: (b) => b, unwrap: (j) => j },
  envelope: { wrap: (b) => ({ data: b }), unwrap: (j) => j?.result },
};
export async function readPulse(fetchImpl, clubId, dates, nowMs, preferred) {
  const startDateTime = new Date(londonMidnightMs(dates[0])).toISOString();
  const endDateTime = new Date(londonMidnightMs(addDays(dates[dates.length - 1], 1)) - 1).toISOString();
  const body = { clubId, startDateTime, endDateTime };
  const order = ['orpc', 'plain', 'envelope'].sort((a, b) => (b === preferred) - (a === preferred));
  let last = { status: 'error', reason: 'no answer' };
  for (const format of order) {
    let res;
    try {
      res = await fetchImpl(PULSE_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: 'https://pulsepadel.co.uk', Referer: PULSE_PAGE },
        body: JSON.stringify(PULSE_FORMATS[format].wrap(body)),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      return { status: 'error', reason: failReason(e) };
    }
    if (res.status === 400) { last = { status: 'error', reason: 'HTTP 400' }; continue; }
    if (res.status !== 200) return { status: 'error', reason: `HTTP ${res.status}` };
    let json;
    try { json = await res.json(); } catch (e) { return { status: 'error', reason: 'unexpected shape' }; }
    const parsed = parsePulse(PULSE_FORMATS[format].unwrap(json), nowMs);
    return parsed.status === 'ok' ? { ...parsed, format } : parsed;
  }
  return last;
}

// Read Pulse when its last read is 15 minutes old or more; returns whether it read.
export async function refreshPulse(env, repo, nowMs, fetchImpl = globalThis.fetch) {
  const prev = await readJsonCache(repo, 'pulse');
  if (!pulseDue(prev, nowMs)) return false;
  const cfg = venueConfig(env);
  const dates = londonDates(nowMs);
  const got = await readPulse(fetchImpl, cfg.pp.clubId, dates, nowMs, prev?.format);
  const nowIso = new Date(nowMs).toISOString();
  const days = {};
  for (const date of dates) days[date] = got.status === 'ok' ? { status: 'ok', starts: got.byDate[date] || {} } : { status: 'error', reason: got.reason };
  const next = { fetchedAt: nowIso, goodAt: got.status === 'ok' ? nowIso : (prev?.goodAt || null), format: got.format || prev?.format || null, days };
  await repo.setCache('pulse', JSON.stringify(next), nowIso);
  await repo.prune(dates[0]);
  return true;
}

// ── The Mac's Matchi read ──
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const posInt = (v, max) => Number.isInteger(v) && v > 0 && v <= max;
function cleanDay(day) {
  if (!isObj(day)) return { error: 'a day must be an object' };
  if (day.status === 'closed') return { day: { status: 'closed' } };
  if (day.status === 'error') return { day: { status: 'error', reason: typeof day.reason === 'string' && day.reason.trim() ? day.reason.trim().slice(0, 120) : 'unknown' } };
  if (day.status !== 'ok') return { error: 'status must be ok, closed or error' };
  if (!isObj(day.starts)) return { error: 'an ok day needs starts' };
  const keys = Object.keys(day.starts);
  if (keys.length > 96) return { error: 'too many starts' };
  const starts = {};
  for (const t of keys) {
    const s = day.starts[t];
    if (!START_RE.test(t)) return { error: `not a start time: ${t.slice(0, 10)}` };
    if (!isObj(s) || !posInt(s.courts, 50) || !posInt(s.min, 600)) return { error: `courts and min must be positive whole numbers (${t})` };
    starts[t] = { courts: s.courts, min: s.min };
  }
  return { day: { status: 'ok', starts } };
}
export function cleanCourts(body, nowMs) {
  const readAtMs = Date.parse(typeof body.readAt === 'string' ? body.readAt : '');
  if (!Number.isFinite(readAtMs)) return { error: 'readAt must be a date and time' };
  if (Math.abs(nowMs - readAtMs) > READ_AT_SKEW_MS) return { error: 'readAt is not within 10 minutes of now' };
  if (!isObj(body.venues)) return { error: 'venues must be an object' };
  // Both venues, every time: a venue left out would keep its old days under the new readAt and
  // read as fresh.
  for (const code of MATCHI_VENUES) if (!isObj(body.venues[code])) return { error: `venues.${code} is needed` };
  const window = new Set(londonDates(nowMs));
  const venues = {};
  for (const [code, days] of Object.entries(body.venues)) {
    if (!MATCHI_VENUES.includes(code)) return { error: `unknown venue: ${code.slice(0, 10)}` };
    if (!isObj(days)) return { error: `${code} must be an object of dates` };
    venues[code] = {};
    for (const [date, day] of Object.entries(days)) {
      if (!DATE_RE.test(date) || !window.has(date)) continue;          // outside the 7 days: ignored
      const c = cleanDay(day);
      if (c.error) return { error: `${code} ${date}: ${c.error}` };
      venues[code][date] = c.day;
    }
    if (!Object.keys(venues[code]).length) return { error: `${code}: no dates inside the next 7 days` };
  }
  return { readAt: new Date(readAtMs).toISOString(), venues };
}
async function saveMatchi(repo, prev, clean) {
  const next = { readAt: clean.readAt, goodAt: { si: prev?.goodAt?.si || null, pdl: prev?.goodAt?.pdl || null }, venues: { si: prev?.venues?.si || {}, pdl: prev?.venues?.pdl || {} } };
  for (const [code, days] of Object.entries(clean.venues)) {
    next.venues[code] = days;
    if (Object.values(days).some((d) => d.status !== 'error')) next.goodAt[code] = clean.readAt;
  }
  await repo.setCache('matchi', JSON.stringify(next), clean.readAt);
  return next;
}

// ── Alerts ──
// At most one DM per slot, ever. A claim is FINAL: the row goes in with a "claimed" reply before the
// relay call, and the relay's own reply (or a timeout or error marker) overwrites it. Only a definite
// refusal (a non-200) deletes the row, so a later check sends it. A Worker stopped between the claim
// and the reply leaves the slot claimed: a miss, accepted over a second DM.
// One check claims no new slot once it has run 5 s, so a check with several slots due is never cut
// off (the background limit is 30 s) between a claim and its relay call; the rest wait for the next
// check.
export async function checkAlerts(state, env, repo, nowMs, sleep = realSleep, clock = Date.now) {
  const nowIso = new Date(nowMs).toISOString();
  const started = clock();
  const due = decideAlerts(state, await repo.alertSlots(state.today));
  const cfg = venueConfig(env);
  const sent = [];
  for (const r of due) {
    if (clock() - started > CLAIM_BUDGET_MS) break;
    const claimed = await repo.claimAlert(r.slot, r.names.join(', '), r.venues.map((v) => v.code).join(','), nowIso);
    if (!claimed) continue;
    if (!env.RELAY || !env.RELAY_KEY) {
      // Nothing was sent: free the slot so a configured Worker can send it.
      console.error('padel: alert DM not sent, relay not configured', r.slot);
      try { await repo.releaseAlert(r.slot); } catch (e) { console.error('padel: alert row not released', r.slot, String(e)); }
      continue;
    }
    let res;
    try {
      res = await withTimeout(env.RELAY.fetch(new Request(RELAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Relay-Key': env.RELAY_KEY },
        body: JSON.stringify({ text: alertText(r, cfg, env.PAGE_URL || 'https://padel.kevinbrittain.workers.dev/').slice(0, 4000), recipients: [env.ALERT_TO || 'kevin@runpreneur.org.uk'] }),
      })), RELAY_TIMEOUT_MS);
    } catch (e) {
      // No answer in 20 s, or a dropped call: the DM may or may not have gone. The row stays final,
      // with a marker saying which.
      const timedOut = e && e.name === 'TimeoutError';
      console.error('padel: alert DM unanswered, not retried', r.slot, String(e));
      await writeReply(repo, r.slot, JSON.stringify(timedOut ? { timeout: true, at: nowIso } : { error: String(e && e.message || e).slice(0, 200), at: nowIso }), sleep);
      continue;
    }
    if (res.status !== 200) {
      // A definite "not sent": delete the row so a later check sends it.
      let said = '';
      try { said = await withTimeout(res.text(), RELAY_BODY_TIMEOUT_MS); } catch (e) { said = '(reply unreadable)'; }
      console.error('padel: alert DM failed, will retry', r.slot, `relay HTTP ${res.status}: ${said.slice(0, 300)}`);
      try { await repo.releaseAlert(r.slot); } catch (e) { console.error('padel: alert row not released', r.slot, String(e)); }
      continue;
    }
    sent.push(r.slot);
    // A 200: the DM is out. The relay's own words replace the claim marker (a body that stalls
    // past 5 s is stored as "pending"). The row stays final even if this write fails.
    let reply;
    try { reply = (await withTimeout(res.text(), RELAY_BODY_TIMEOUT_MS)) || '(empty reply)'; } catch (e) {
      console.error('padel: DM sent, its reply body was not read', r.slot, String(e));
      reply = RELAY_PENDING;
    }
    await writeReply(repo, r.slot, reply, sleep);
  }
  return sent;
}
export const RELAY_PENDING = '{"ok":true,"pending":true}';
// A reply that makes the row final, tried up to 3 more times with 0.5, 1 and 2 s pauses.
async function writeReply(repo, slot, reply, sleep) {
  for (let attempt = 0; attempt <= SAVE_REPLY_RETRIES; attempt++) {
    if (attempt) await sleep(SAVE_REPLY_PAUSES_MS[attempt - 1]);
    try {
      await repo.saveRelayReply(slot, reply);
      return true;
    } catch (e) {
      console.error('padel: DM sent, reply not saved', slot, `attempt ${attempt + 1}`, String(e));
    }
  }
  return false;
}

// ── HTTP ──
const BASE_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
const fail = (error, status) => json({ error }, status);

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
const keyOk = (given, want) => !!want && timingSafeEqual(given || '', want);

// Copied from workers/property-manager/worker.js. IPv6 hands out whole blocks, so a caller is
// counted by its /64; an IPv4 address written inside IPv6 (::ffff:1.2.3.4) is counted as itself.
export function callerKey(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (!s.includes(':')) return s;
  const v4 = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  const halves = s.split('::');
  if (halves.length > 2) return s;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return s;
  return groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':') + '::/64';
}

export function cleanName(raw) {
  const name = String(raw ?? '').normalize('NFC').replace(/[‘’ʼ]/g, "'").trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 30) return { error: 'A name is 2 to 30 letters.' };
  if (!NAME_RE.test(name)) return { error: 'Use letters, spaces, hyphens or apostrophes only.' };
  if ((name.match(NAME_LETTER_RE) || []).length < 2) return { error: 'A name needs at least two letters.' };
  return { name };
}
// Past dates are dropped (a page left open over midnight still sends yesterday's ticks); anything
// else outside the next 7 days or the hours 07 to 21 refuses the whole list.
export function cleanSlots(raw, dates) {
  if (!Array.isArray(raw)) return { error: 'slots must be a list' };
  if (raw.length > (dates.length + 1) * HOURS.length) return { error: 'too many slots' };
  const ok = new Set(dates);
  const out = new Set();
  for (const s of raw) {
    const m = SLOT_RE.exec(String(s));
    if (m && m[1] < dates[0] && HH.has(m[2])) continue;
    if (!m || !ok.has(m[1]) || !HH.has(m[2])) return { error: `Not an hour in the next 7 days: ${String(s).slice(0, 20)}` };
    out.add(m[0]);
  }
  return { slots: [...out].sort() };
}

async function loadState(env, repo, nowMs) {
  const dates = londonDates(nowMs);
  const [{ pulse, availability }, people, votes, booked] = await Promise.all([
    loadAvailability(repo), repo.listPeople(), repo.listVotes(dates[0]), repo.listBooked(dates[0]),
  ]);
  const state = computeState({ people, votes, booked, availability, dates, nowMs, cfg: venueConfig(env) });
  state.availability.stale = pulseDue(pulse, nowMs);
  return state;
}

// Read Pulse (when due), then run the alert check on the fresh state. Never throws: it runs inside
// waitUntil, where a throw would vanish.
async function refreshAndAlert(env, repo, nowMs, fetchImpl, clock, sleep) {
  try {
    const read = await refreshPulse(env, repo, nowMs, fetchImpl);
    const now = clock();
    await checkAlerts(await loadState(env, repo, now), env, repo, now, sleep);
    return read;
  } catch (e) {
    console.error('padel: refresh failed', String(e && e.stack || e));
    return false;
  }
}
async function alertSafely(state, env, repo, nowMs, sleep) {
  try { return await checkAlerts(state, env, repo, nowMs, sleep); } catch (e) { console.error('padel: alert check failed', String(e && e.stack || e)); return []; }
}

// Bytes, not characters: a body of emoji is four bytes a character.
async function readBody(request, limit = MAX_BODY) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > limit) return { error: 'Too big', status: 413 };
  try {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > limit) return { error: 'Too big', status: 413 };
    const body = JSON.parse(new TextDecoder().decode(buf) || '{}');
    if (!isObj(body)) return { error: 'Bad request', status: 400 };
    return { body };
  } catch {
    return { error: 'Bad request', status: 400 };
  }
}
const intId = (v) => (Number.isInteger(v) && v > 0 ? v : (typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null));

function venueStatus(a, dates) {
  const out = {};
  for (const code of VENUES) {
    const counts = {};
    for (const d of dates) { const s = a.venues[code]?.[d]?.status || 'missing'; counts[s] = (counts[s] || 0) + 1; }
    out[code] = counts;
  }
  return out;
}

async function handleCourts(request, env, ctx, repo, nowMs, fetchImpl, clock, sleep) {
  if (!keyOk(request.headers.get('X-Robot-Key'), env.ROBOT_KEY)) return fail('Robot key needed', 401);
  if (request.method === 'GET') {
    const { availability } = await loadAvailability(repo);
    return json({ ok: true, version: VERSION, matchiFetchedAt: availability.matchiFetchedAt, pulseFetchedAt: availability.pulseFetchedAt, venueStatus: venueStatus(availability, londonDates(nowMs)) });
  }
  if (request.method !== 'POST') return fail('Not found', 404);
  const parsed = await readBody(request, MAX_COURTS_BODY);
  if (parsed.error) return fail(parsed.error, parsed.status);
  const clean = cleanCourts(parsed.body, nowMs);
  if (clean.error) return fail(clean.error, 400);
  const prev = await readJsonCache(repo, 'matchi');
  if (prev?.readAt && Date.parse(prev.readAt) > Date.parse(clean.readAt)) return fail('A newer read is already stored', 409);
  await saveMatchi(repo, prev, clean);
  await repo.prune(londonDates(nowMs)[0]);
  const pulse = await readJsonCache(repo, 'pulse');
  if (pulseDue(pulse, nowMs) && await repo.claimRefresh(nowMs, REFRESH_GUARD_MS)) await refreshPulse(env, repo, nowMs, fetchImpl);
  const now = clock();
  const state = await loadState(env, repo, now);
  // In waitUntil, so the Mac going away cannot stop a DM between its claim and its reply. The reply
  // says only that the check is under way; the Mac does not depend on what it sends.
  ctx.waitUntil(alertSafely(state, env, repo, now, sleep));
  const { availability } = await loadAvailability(repo);
  return json({ ok: true, matchiFetchedAt: availability.matchiFetchedAt, pulseFetchedAt: availability.pulseFetchedAt, alerted: 'checking', ready: state.ready.length });
}

export async function handleRequest(request, env, ctx, repo, deps = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const clock = deps.now || Date.now;
  const sleep = deps.sleep || realSleep;
  const nowMs = clock();
  try {
    // The page is served as a static asset before this Worker runs; anything else is not ours.
    if (!path.startsWith('/api/')) return new Response('Not found', { status: 404, headers: BASE_HEADERS });
    if (env.WRITE_LIMIT) {
      const { success } = await env.WRITE_LIMIT.limit({ key: callerKey(request.headers.get('CF-Connecting-IP')) });
      if (!success) return fail('slow down', 429);
    }
    if (path === '/api/health' && request.method === 'GET') return json({ ok: true, version: VERSION });
    if (path === '/api/courts') return await handleCourts(request, env, ctx, repo, nowMs, fetchImpl, clock, sleep);
    if (!keyOk(request.headers.get('X-Group-Key'), env.GROUP_KEY)) return fail(GATE_MSG, 401);

    if (path === '/api/ping' && request.method === 'GET') return json({ ok: true });
    if (path === '/api/state' && request.method === 'GET') {
      const state = await loadState(env, repo, nowMs);
      if (state.availability.stale && await repo.claimRefresh(nowMs, REFRESH_GUARD_MS)) {
        ctx.waitUntil(refreshAndAlert(env, repo, nowMs, fetchImpl, clock, sleep));
      }
      return json(state);
    }
    if (request.method !== 'POST') return fail('Not found', 404);
    const dates = londonDates(nowMs);
    const nowIso = new Date(nowMs).toISOString();

    if (path === '/api/refresh') {
      let refreshed = false;
      if (await repo.claimRefresh(nowMs, REFRESH_GUARD_MS)) {
        try { refreshed = await refreshPulse(env, repo, nowMs, fetchImpl); } catch (e) { console.error('padel: Pulse read failed', String(e && e.stack || e)); }
      }
      const now = clock();
      const state = await loadState(env, repo, now);
      // The alert check runs in waitUntil: a caller going away cannot stop it between claim and reply.
      ctx.waitUntil(alertSafely(state, env, repo, now, sleep));
      return json({ ...state, refreshed });
    }

    const parsed = await readBody(request);
    if (parsed.error) return fail(parsed.error, parsed.status);
    const body = parsed.body;

    if (path === '/api/person') {
      if (body.id !== undefined) {
        const id = intId(body.id);
        if (!id || !Array.isArray(body.venues)) return fail('id and venues are needed', 400);
        const venues = [...new Set(body.venues.map(String))];
        if (venues.some((v) => !VENUES.includes(v))) return fail('Unknown venue', 400);
        if (!(await repo.setVenues(id, VENUES.filter((v) => venues.includes(v))))) return fail('No such person', 404);
        return json(await repo.getPerson(id));
      }
      const clean = cleanName(body.name);
      if (clean.error) return fail(clean.error, 400);
      const people = await repo.listPeople();
      const fold = foldName(clean.name);
      const found = people.find((p) => foldName(p.name) === fold);
      if (found) return json(found);
      if (people.length >= MAX_PEOPLE) return fail('The group list is full. Ask Kevin.', 409);
      const person = await repo.addPerson(clean.name, nowIso);
      if (!person) return fail('Could not save that name. Try again.', 500);
      return json(person);
    }

    if (path === '/api/vote') {
      const id = intId(body.person_id);
      if (!id) return fail('person_id is needed', 400);
      if (body.slots !== undefined) return fail('A save sends add and remove, not slots. Reload the page.', 400);
      const add = cleanSlots(body.add ?? [], dates);
      if (add.error) return fail(add.error, 400);
      const remove = cleanSlots(body.remove ?? [], dates);
      if (remove.error) return fail(remove.error, 400);
      const both = add.slots.filter((x) => remove.slots.includes(x));
      if (both.length) return fail(`An hour cannot be added and removed at once: ${both[0]}`, 400);
      if (!(await repo.getPerson(id))) return fail('No such person', 404);
      await repo.applyVotes(id, add.slots, remove.slots, nowIso);
      const state = await loadState(env, repo, nowMs);
      // The save answers at once; the DM (up to 20 s on the relay) goes in the background.
      ctx.waitUntil(alertSafely(state, env, repo, nowMs, sleep));
      return json(state);
    }

    if (path === '/api/booked') {
      const clean = cleanSlots([body.slot], dates);
      if (clean.error || !clean.slots.length) return fail(clean.error || 'That hour has passed', 400);
      const slot = clean.slots[0];
      if (body.booked === false) {
        await repo.clearBooked(slot);
      } else if (body.booked === true) {
        const id = intId(body.person_id);
        if (!id || !(await repo.getPerson(id))) return fail('No such person', 404);
        if (!VENUES.includes(body.venue)) return fail('Unknown venue', 400);
        await repo.setBooked(slot, id, body.venue, nowIso);
      } else {
        return fail('booked must be true or false', 400);
      }
      return json(await loadState(env, repo, nowMs));
    }
    return fail('Not found', 404);
  } catch (e) {
    console.error('padel: request failed', path, String(e && e.stack || e));
    return fail('Something went wrong. Try again.', 500);
  }
}
