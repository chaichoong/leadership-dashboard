// Padel Worker logic (worker.js is the entry point): the padel group's "who can play when" page (Kevin approved the plan, 27 Oct 2026).
//
// WHAT IT DOES: an 11-person WhatsApp group ticks the hours they can play over the next 14 days on
// one phone page. The Worker knows which courts are free at three venues and sends Kevin ONE Slack
// DM the first time 4+ people line up on an hour where a court is free. Nobody has to count.
//
// Routes (JSON). Every /api request is rate limited per caller BEFORE any key check.
//   GET  /api/health                        -> { ok, version }                 no key, no data
//   GET  /api/courts      (X-Robot-Key)     -> { ok, version, matchiFetchedAt, pulseFetchedAt, venueStatus }
//   POST /api/courts      (X-Robot-Key)     -> { ok, matchiFetchedAt, pulseFetchedAt, alerted: 'checking', ready }
//        { readAt, venues: { si: { "<date>": day }, pdl: { ... } } }  the Mac mini's Matchi read
//   Every other route is open: no code, no header (Kevin, 27 Oct 2026: "do we really need the code?").
//   The rate limit is the only guard; anyone with the address can add a name and tick hours.
//   GET  /api/state                         -> the whole page state (kicks a lazy Pulse read)
//   POST /api/person  { name }              -> { id, name, venues }   creates the name if absent
//   POST /api/person  { id, venues:[...] }  -> { id, name, venues }   venue preferences
//   POST /api/vote    { person_id, add, remove } -> state            applies that person's tick changes
//   POST /api/booked  { slot, person_id, venue, booked, start?, minutes?, courts? } -> state
//        A booking carries its start ("19:30"), length in minutes and courts (1, or 2 when the group
//        booked a second court); a day with a booking shows no other ready hour (Kevin, 29 Oct 2026).
//        Kevin's phone also sends { price, players } (8 Nov 2026): booked and paid in one save and one
//        transaction; any other phone sending a price gets 403.
//   POST /api/refresh                       -> state + { refreshed }  "Check now" (Pulse only)
//   POST /api/admin   (X-Admin-Key)         -> state   Kevin's phone only (Kevin, 30 Oct 2026):
//        { action: 'name', id, real_name }            a player's real name (shown with its initials everywhere)
//        { action: 'paid', slot, price, players }     Booked and paid: the total in pounds and who is playing
//        { action: 'unpaid', slot }                   take the price off again (before the robot has sent it)
//        { action: 'retry', slot, step }              let the robot try a failed Splitwise entry or texts again
//   GET  /api/robot/paid  (X-Robot-Key)     -> { ok, bookings }   paid bookings with a step still to do
//   POST /api/robot/paid  (X-Robot-Key)     -> { ok, changed }    { slot, step, state, note, paidAt }: claimed,
//        then done or failed; a step is claimed once and never again unless Kevin taps Retry, or the
//        robot resumes one that failed only because it was signed out of Splitwise (SIGNED_OUT_MARK).
//   POST /api/robot/booking (X-Robot-Key) -> { ok, booked, paid, venue, alreadyPaid }   { slot, venue, start,
//        minutes, person_id, price_pence? }: a venue's booking email (8 Nov 2026). Marks an unmarked hour
//        booked; with a price and no price yet, pays it, players from the votes at that moment.
//   POST /api/level  { person_id, level }   -> state   a player's own starting level (Playtomic's 0 to 7),
//        only until a rated score has moved it; Kevin's phone sets anyone's ({ action: 'level' }).
//   POST /api/score  { key, entered_by, played_on, team_a, team_b, sets, rated } -> state   a 2-v-2 score
//        from one of the four (or Kevin's phone), in the last 7 days; a rated one moves all four levels
//        by Nettla's published rules (levelChanges). Kevin's phone deletes one ({ action: 'score-delete' }),
//        which reverses its changes exactly.
//   POST /api/feedback { match_id, from_id, votes: { <id>: higher|expected|lower } } -> state   within 24 h
//        of a rated score, each of the four marks the other three; 2 matching votes move a player 0.05.
//   POST /api/matchday { slot, person_id, action, ... } -> state   match day on today's booked hour (Stage 3):
//        start { mode: fair|shuffle } splits the players by Kevin's formats and picks the pairs (again, until
//        the first Kings and challengers game); swap { a, b }; kc-game { group, version, winner: kings|
//        challengers, lost_by } runs his rules and moves levels a quarter; kc-undo { group, version }.
//   GET  /api/robot/setup (X-Robot-Key) -> { ok, people }   who is on the list, for the robot's setup check
//   POST /api/robot/setup (X-Robot-Key) -> { ok, saved }    { people: { <id>: { state, notes } } } (27 Nov
//        2026): per player, ready, missing (what a booking would still lack) or unchecked. Kept in the
//        cache table and sent only to Kevin's phone (state.setup), for his People screen.
//   TWO RULES, IN THE DATABASE (review of PR #858): (1) once the robot has claimed the Splitwise step,
//   nothing changes or removes that booking, Kevin's phone included, until that step has failed; (2) the
//   texts can be claimed only after the Splitwise entry is done, and a claim names the paid_at it read, so
//   the robot never acts on a price or player list that changed under it.
// The page itself is a static asset in ./public, served without this Worker (wrangler.toml
// run_worker_first = ["/api/*"]); its headers live in public/_headers.
//
// A slot is "YYYY-MM-DD|HH": the London date and two-digit start hour, 07 to 21.
// Venues: si = St Ives Golf Club (Matchi 2619), pdl = PDL Padel United Cambridge (Matchi 3122),
// pp = Pulse Padel Huntingdon (the Nettla booking widget's public availability endpoint, called
// at most once per 15 minutes: Kevin's go-ahead, 27 Oct 2026), cu = University of Cambridge Sports
// Centre (its Gladstone Go booking portal's own feed: Kevin, 29 Oct 2026, "all the padel courts
// within 30 minutes of Willingham"; the other venues in range are members only or not built).
//
// WHO READS WHAT. Matchi answers every /book/schedule request from Cloudflare's edge with HTTP 429
// (12 of 12 probes on 27 Oct 2026) and 200 from the Mac mini. So St Ives, PDL and the University
// are read by scripts/padel-courts.mjs on the Mac every 15 minutes (06:30 to 23:00 London), which
// POSTs the parsed days to /api/courts. That script imports parseMatchi, parseGladstone, matchiUrl,
// MATCHI_HEADERS and londonDates from this file, so both sides parse one way. Pulse is read here.
//
// FRESHNESS. A venue's data counts only while it is fresh: the Mac's venues for 45 minutes after
// the Mac's read (and the evening's last read, 22:30 London or later, until 06:45 the next
// morning while the Mac sleeps: matchiFresh), Pulse for 20 minutes. A venue that is not fresh
// shows "couldn't check" with its own booking link and is NEVER counted towards a DM.
//
// NO cron (all five free-plan triggers are used) and NO KV (free-tier writes starve the other
// Workers). D1 holds everything; see schema.sql.
//
// Bindings: DB (D1), RELAY (service binding to apple-inbound's /slack-relay), WRITE_LIMIT
//           (ratelimit, optional). Secrets: ROBOT_KEY, RELAY_KEY, ADMIN_KEY (Kevin's phone: the only
//           device that may rename people, record Booked and paid, or change a paid booking).
//
// RATE LIMIT: every /api request, before any key check, counts one hit in D1's `rate` table under
// "<client>|<minute>" and the 61st in a minute is refused (429). The ratelimit binding is kept, but
// it counts per Cloudflare machine and never refused a burst (measured 27 Oct 2026), so the D1
// count is the one that holds. A D1 failure there lets the request through (fail open): a broken
// counter must not take the page down.

export const VERSION = '2026-11-28.2';
export const TZ = 'Europe/London';
export const VENUES = ['si', 'pdl', 'pp', 'cu'];
const MATCHI_VENUES = ['si', 'pdl'];                 // a Mac post must carry both, every time
const MAC_VENUES = ['si', 'pdl', 'cu'];              // everything the Mac reads (cu may be missing from an older reader)
export const HOURS = Array.from({ length: 15 }, (_, i) => i + 7);          // 7..21
const HH = new Set(HOURS.map((h) => String(h).padStart(2, '0')));
export const DAYS = 14;                          // the window: today and the 13 days after (Kevin, 27 Oct 2026)
export const MAX_MIN = 90;                       // an hour counts as free only for a start of 90 min or less
export const RUN_CAP_MIN = 180;                  // the longest booking shown from a start (Kevin, 29 Oct 2026: show longer options)
export const SECOND_COURT_AT = 8;                // a booked hour with this many in and a second court free offers it
export const MATCHI_FRESH_MS = 45 * 60 * 1000;   // St Ives and PDL count for 45 minutes after the Mac's read
export const PULSE_FRESH_MS = 20 * 60 * 1000;    // Pulse counts for 20 minutes after its read
export const PULSE_EVERY_MS = 15 * 60 * 1000;    // Pulse is called at most once per 15 minutes
export const REFRESH_GUARD_MS = 90 * 1000;       // no second Pulse read within 90 seconds
export const READ_AT_SKEW_MS = 10 * 60 * 1000;   // a Mac read older (or newer) than this is refused
export const RATE_LIMIT = 60;                    // requests a minute per client, every /api route
export const RATE_KEEP_MS = 10 * 60 * 1000;      // rate rows older than this are deleted
export const CLAIM_BUDGET_MS = 5000;             // no new claim once the background work has run this long
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
export const MAX_PRICE_POUNDS = 1000;              // a court booking above this is a typo
export const PAID_STEPS = ['splitwise', 'texts'];  // what the Mac robot does for a paid booking, in this order
// The words the robot's note carries when a step failed only because it was signed out of Splitwise
// (scripts/padel-paid.mjs SIGNED_OUT_NOTE, 27 Nov 2026). Only such a step may the robot take up again itself.
export const SIGNED_OUT_MARK = 'signed out of Splitwise';
export const PAID_KEEP_DAYS = 7;                   // a paid booking the robot has not finished is kept this long
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

// ── Venue config: labels and ids live in wrangler.toml [vars]; these defaults match it ──
export function venueConfig(env = {}) {
  return {
    si: { code: 'si', label: env.SI_LABEL || 'St Ives Golf Club', short: env.SI_SHORT || 'St Ives', matchiId: env.SI_MATCHI_ID || '2619' },
    // PDL moves from Matchi to Playtomic for games from 1 Dec 2026 (club email, 3 Nov 2026).
    pdl: { code: 'pdl', label: env.PDL_LABEL || 'PDL Padel United Cambridge', short: env.PDL_SHORT || 'Cambridge', matchiId: env.PDL_MATCHI_ID || '3122',
      playtomicFrom: env.PDL_PLAYTOMIC_FROM || '2026-12-01', playtomicId: env.PDL_PLAYTOMIC_ID || '90683b2f-2f6a-4680-a167-cbfa4fd7ea55',
      playtomicSlug: env.PDL_PLAYTOMIC_SLUG || 'pdl-padel-united-cambridge' },
    pp: { code: 'pp', label: env.PP_LABEL || 'Pulse Padel Huntingdon', short: env.PP_SHORT || 'Huntingdon', clubId: env.PP_CLUB_ID || 'VEqVgpQmiJLiEC1Lm4z3' },
    cu: { code: 'cu', label: env.CU_LABEL || 'University of Cambridge Sports Centre', short: env.CU_SHORT || 'Cambridge Uni' },
  };
}
export const matchiUrl = (id, date) => `https://www.matchi.se/book/schedule?facilityId=${id}&date=${date}&sport=5`;
// The University portal's own calendar for that day (read 29 Oct 2026): 06:00 UTC is 06:00 or
// 07:00 London, before the first slot, so the page lists the whole day.
export const UNI_HOST = 'https://cambridgesport.gladstonego.cloud';
export const UNI_ACTIVITY = 'USCAPADWO02';            // "Padel 55mins Non Member": court hire for anyone
export const uniBookUrl = (date) => `${UNI_HOST}/book/calendar/${UNI_ACTIVITY}?activityDate=${date}T06:00:00.000Z`;
// Playtomic (read 5 Nov 2026): the club's page lists its courts; the site's own availability call
// gives each court's free starts for a day, in UTC, with every booking length on offer.
export const PLAYTOMIC_HOST = 'https://playtomic.com';
export const playtomicClubUrl = (slug) => `${PLAYTOMIC_HOST}/clubs/${slug}`;
export const playtomicAvailabilityUrl = (tenantId, date) => `${PLAYTOMIC_HOST}/api/clubs/availability?tenant_id=${tenantId}&date=${date}&sport_id=PADEL`;
export const onPlaytomic = (cfg, code, date) => !!(cfg[code] && cfg[code].playtomicFrom && date >= cfg[code].playtomicFrom);
export function bookUrl(cfg, code, date) {
  if (code === 'pp') return PULSE_PAGE;
  if (code === 'cu') return uniBookUrl(date);
  if (onPlaytomic(cfg, code, date)) return playtomicClubUrl(cfg[code].playtomicSlug);
  return matchiUrl(cfg[code].matchiId, date);
}

// The club's courts from its Playtomic page, where the court list sits in the page's data with its
// quotes escaped: [{ id, name, double }], or null when the page has no readable list. Only courts
// marked "Double" are ever counted (a singles court is no use to four).
export function parsePlaytomicCourts(html) {
  const key = '\\"resources\\":[';
  const at = typeof html === 'string' ? html.indexOf(key) : -1;
  if (at < 0) return null;
  const s = html.slice(at + key.length - 1, at + 40000).replace(/\\(["\\])/g, '$1');   // the page's string escapes, one level
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    if (inString) {                             // a "[" or "]" in a court's name is not structure
      if (s[i] === '\\') i++;
      else if (s[i] === '"') inString = false;
      continue;
    }
    if (s[i] === '"') inString = true;
    else if (s[i] === '[') depth++;
    else if (s[i] === ']' && --depth === 0) {
      try {
        return JSON.parse(s.slice(0, i + 1)).map((r) => ({ id: String(r.resourceId), name: String(r.name || ''), double: (r.features || []).includes('Double') }));
      } catch { return null; }
    }
  }
  return null;
}
// One London day from Playtomic's availability reply, [{ resource_id, start_date, slots: [{
// start_time: "HH:MM:SS" UTC, duration: minutes }] }], counted as Matchi is: per start, the doubles
// courts free and the shortest and longest booking (capped at RUN_CAP_MIN).
export function parsePlaytomic(reply, courts, date) {
  if (!Array.isArray(reply)) return { status: 'error', reason: 'unexpected shape' };
  if (!Array.isArray(courts) || !courts.length) return { status: 'error', reason: 'no courts listed on Playtomic' };
  const doubles = new Set(courts.filter((c) => c.double).map((c) => c.id));
  // Never "no court free" by mistake: a club with no doubles listed, or a reply about courts the club
  // page does not list, is a page that changed, not a full day.
  if (!doubles.size) return { status: 'error', reason: 'no doubles courts listed on Playtomic' };
  const listed = new Set(courts.map((c) => c.id));
  if (reply.some((r) => r && r.resource_id) && !reply.some((r) => r && listed.has(String(r.resource_id)))) return { status: 'error', reason: 'the reply names courts the club page does not list' };
  const per = new Map();
  for (const r of reply) {
    if (!r || !doubles.has(String(r.resource_id))) continue;
    for (const sl of r.slots || []) {
      const ms = Date.parse(`${r.start_date}T${sl.start_time}Z`);
      const dur = Math.min(Number(sl.duration) || 0, RUN_CAP_MIN);
      if (!Number.isFinite(ms) || dur <= 0) return { status: 'error', reason: 'unexpected shape' };
      const p = londonParts(ms);
      if (p.date !== date) continue;
      const key = `${p.hh}:${p.mm}`;
      const e = per.get(key) || { ids: new Set(), min: dur, max: dur };
      e.ids.add(String(r.resource_id));
      e.min = Math.min(e.min, dur);
      e.max = Math.max(e.max, dur);
      per.set(key, e);
    }
  }
  const starts = {};
  for (const key of [...per.keys()].sort()) { const e = per.get(key); starts[key] = { courts: e.ids.size, min: e.min, max: e.max }; }
  return { status: 'ok', starts };
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
// read as "no court". Each <tr> is one court with its cells in time order, so the longest booking
// from a start is that cell plus every open cell after it on the same row (free or can-not-start:
// both are unbooked), capped at RUN_CAP_MIN. Kevin, 29 Oct 2026: show where a longer booking fits.
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

// One walk over every tag, each read to its quote-aware end, so a "<tr" inside any attribute is
// never a row. A comment, script or style is skipped whole; a <tr> starts a court row; a <td> is a cell.
const WALK_RE = /<(!--|[a-zA-Z][\w-]*)/g;
const SKIP_END = { '!--': /-->/g, script: /<\/script\s*>/gi, style: /<\/style\s*>/gi };
export function parseMatchi(html) {
  if (typeof html !== 'string' || !/class="schedule[\s"]/.test(html)) return { status: 'error', reason: 'not a schedule page' };
  const rows = [];
  let row = null;
  let cells = 0;
  WALK_RE.lastIndex = 0;
  let w;
  while ((w = WALK_RE.exec(html))) {
    const open = w.index;
    const name = w[1].toLowerCase();
    const end = name === '!--' ? open + 3 : tagEnd(html, open);
    if (end === -1) break;
    WALK_RE.lastIndex = end;
    if (Object.hasOwn(SKIP_END, name)) {
      const endRe = SKIP_END[name];
      endRe.lastIndex = end;
      const e = endRe.exec(html);
      if (!e) break;
      WALK_RE.lastIndex = e.index + e[0].length;
      continue;
    }
    if (name === 'tr') { row = []; rows.push(row); continue; }
    if (name !== 'td') continue;
    const at = tagAttrs(html.slice(open + 3, end));
    const cls = String(at.class || '').split(/\s+/);
    if (!cls.includes('slot')) continue;
    // A court cell of a kind this parser does not know (a renamed class) is an error for the day,
    // never "no court free" (checked 27 Oct 2026: only these four kinds exist on either venue).
    if (!CELL_KINDS.some((k) => cls.includes(k))) return { status: 'error', reason: 'unknown court cell' };
    cells++;
    const cell = { open: cls.includes('free') || cls.includes('can-not-start'), minutes: Number(at['data-slot-duration']) || 30 };
    if (cls.includes('free') && at['data-slot-can-start'] === 'true') {
      const m = TITLE_RE.exec(at.title || '');
      if (!m) return { status: 'error', reason: 'a free court cell could not be read' };
      const min = Number(at['data-slot-min-duration']);
      if (!Number.isInteger(min) || min <= 0) return { status: 'error', reason: 'a free court cell has no minimum booking' };
      cell.court = unent(m[1]).replace(/\s+/g, ' ').trim();
      cell.start = `${m[2].padStart(2, '0')}:${m[3]}`;
      cell.min = min;
    }
    if (!row) { row = []; rows.push(row); }
    row.push(cell);
  }
  const starts = {};
  for (const r of rows) {
    for (let c = 0; c < r.length; c++) {
      const cell = r[c];
      if (!cell.start || /single/i.test(cell.court)) continue;   // two players only: never a doubles court
      let run = 0;
      for (let k = c; k < r.length && r[k].open && run < RUN_CAP_MIN; k++) run += r[k].minutes;
      const max = Math.max(cell.min, Math.min(run, RUN_CAP_MIN));
      const s = starts[cell.start] || (starts[cell.start] = { courts: 0, min: cell.min, max, names: [] });
      if (!s.names.includes(cell.court)) { s.names.push(cell.court); s.courts++; }
      s.min = Math.min(s.min, cell.min);
      s.max = Math.max(s.max, max);
    }
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
// durations[].minutes (60 when a court gives none) and its longest the largest. Any other shape is
// an error: never guess slots.
const isDoubles = (c) => !/single/i.test(String(c.name || '')) && !/single/i.test(String(c.size || ''))
  && (!Array.isArray(c.allowedPlayerCounts) || c.allowedPlayerCounts.includes(4));
export function pulseValueCourts(v) {
  if (!Array.isArray(v) || v.some((c) => !c || typeof c !== 'object' || Array.isArray(c))) return undefined;
  const courts = v.filter(isDoubles);
  if (!courts.length) return null;
  const lens = courts.map((c) => {
    if (c.durations === undefined) return [60, 60];
    if (!Array.isArray(c.durations)) return [NaN, NaN];
    const m = c.durations.map((d) => Number(d && d.minutes)).filter((n) => n > 0);
    return m.length ? [Math.min(...m), Math.min(Math.max(...m), RUN_CAP_MIN)] : [NaN, NaN];
  });
  const mins = lens.map((l) => l[0]);
  if (mins.some((m) => Number.isNaN(m))) return undefined;
  const ok = mins.filter((m) => m <= MAX_MIN);
  return { courts: ok.length || courts.length, min: Math.min(...mins), max: Math.max(...lens.map((l) => l[1])) };
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
    day[t] = { courts: got.courts, min: got.min, max: got.max };
  }
  return { status: 'ok', byDate };
}

// ── University of Cambridge Sports Centre (Gladstone Go), read on the Mac ──
// The portal's own feed (read live 29 Oct 2026, tests/fixtures/padel/gladstone-sessions-2026-11-03.json):
// GET /api/availability/V2/sessions?webBookableOnly=true&siteIds=CBU&activityIds=USCAPADWO02&dateFrom&dateTo,
// with the anonymous session cookie and the header X-Use-Sso: 1 (the portal's own interceptor adds
// it; without it every call is 401). One row per day, each with locations (Padel Tennis Court 1
// and 2, both doubles) holding 60-minute slots on the hour, in UTC. A slot is free when its status
// is "Available" with a place left; a slot before its booking window opens (non-members book 7
// days ahead) carries isBeforeTimetableSlotBookablePeriod, and a day of nothing but those is "not
// open yet". A slot past its bookableUntil (30 minutes before it starts) cannot be booked online, so
// it is not free. A day missing from the reply, or any other shape, is an error: never "no court free".
// nowMs is the time of the read (the cut-off is judged against it).
export function parseGladstone(json, dates, nowMs) {
  const bad = (reason) => Object.fromEntries(dates.map((d) => [d, { status: 'error', reason }]));
  if (!Array.isArray(json)) return bad('unexpected shape');
  const rows = json.filter((a) => a && a.id === UNI_ACTIVITY);
  if (!rows.length) return bad('no padel court hire in the reply');
  const tally = Object.fromEntries(dates.map((d) => [d, { starts: {}, seen: 0, notYet: 0 }]));
  const free = (x) => x && x.status === 'Available' && x.availability && x.availability.inCentre > 0 && !x.isBeforeTimetableSlotBookablePeriod
    && !(Date.parse(x.bookableUntil || '') <= nowMs);
  for (const row of rows) {
    if (!Array.isArray(row.locations)) return bad('unexpected shape');
    for (const loc of row.locations) {
      if (!loc || !Array.isArray(loc.slots)) return bad('unexpected shape');
      if (/single/i.test(String(loc.locationNameToDisplay || ''))) continue;      // never a singles court
      // In time order, each start once (a start listed twice is one court, not two).
      const slots = [];
      for (const s of loc.slots) {
        const start = Date.parse(s && s.startTime);
        const len = Math.round((Date.parse(s && s.endTime) - start) / 60000);
        // A slot of more than RUN_CAP_MIN minutes is not a court hire: an unreadable reply, never a
        // length the Worker's own check would refuse (which would cost St Ives and PDL their update).
        if (!Number.isFinite(start) || !(len > 0 && len <= RUN_CAP_MIN) || typeof s.status !== 'string') return bad('unexpected shape');
        if (!slots.some((x) => x.start === start)) slots.push({ ...s, start, len });
      }
      slots.sort((a, b) => a.start - b.start);
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const ms = s.start;
        const p = londonParts(ms);
        const day = tally[p.date];
        if (!day) continue;
        day.seen++;
        if (s.isBeforeTimetableSlotBookablePeriod) { day.notYet++; continue; }
        if (!free(s)) continue;
        // The longest booking: this slot and every free slot that starts exactly as the one before
        // it ends, on the same court, capped at RUN_CAP_MIN.
        let run = s.len;
        for (let k = i + 1; k < slots.length && free(slots[k]) && slots[k].start === slots[k - 1].start + slots[k - 1].len * 60000 && run + slots[k].len <= RUN_CAP_MIN; k++) run += slots[k].len;
        const t = `${p.hh}:${p.mm}`;
        const st = day.starts[t] || (day.starts[t] = { courts: 0, min: s.len, max: run });
        st.courts++;
        st.min = Math.min(st.min, s.len);
        st.max = Math.max(st.max, run);
      }
    }
  }
  const out = {};
  for (const d of dates) {
    const day = tally[d];
    out[d] = !day.seen ? { status: 'error', reason: 'day not in the reply' }
      : day.notYet === day.seen ? { status: 'closed' } : { status: 'ok', starts: day.starts };
  }
  return out;
}

// ── From raw starts to the page's hour rows ──
// An hour row lists its starts with, for each, the shortest and longest booking (max falls back to
// min for a read that carried none) and how many courts are free; courts and max are the hour's best.
export function hoursFromStarts(starts) {
  const hours = {};
  for (const t of Object.keys(starts || {}).sort()) {
    const s = starts[t];
    if (!(s && s.min <= MAX_MIN && s.courts > 0)) continue;
    const hh = t.slice(0, 2);
    if (!HH.has(hh)) continue;
    const max = s.max > s.min ? s.max : s.min;
    const h = hours[hh] || (hours[hh] = { free: true, min: s.min, max, courts: 0, starts: [], mins: [], maxs: [], courtsBy: [] });
    h.starts.push(t);
    h.mins.push(s.min);
    h.maxs.push(max);
    h.courtsBy.push(s.courts);
    h.min = Math.min(h.min, s.min);
    h.max = Math.max(h.max, max);
    h.courts = Math.max(h.courts, s.courts);
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

// The Mac reads Matchi every 15 minutes from 06:30 to 23:00 London and sleeps overnight. A read
// counts for 45 minutes while the Mac is awake; the evening's last read (22:30 London or later)
// counts until 06:45 London the next morning, by when the day's first run has landed. Kevin,
// 27 Oct 2026: the page must not read "couldn't check" on two venues all night. A read older
// than nine hours never counts, so a Mac that slept through the morning still shows loudly.
export const MATCHI_QUIET_FROM = '22:30';
export const MATCHI_QUIET_UNTIL = '06:45';
export function matchiFresh(iso, nowMs) {
  if (ageOk(iso, nowMs, MATCHI_FRESH_MS)) return true;
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t) || nowMs - t > 9 * 60 * 60 * 1000) return false;
  const read = londonParts(t);
  const now = londonParts(nowMs);
  const readClock = read.hh + ':' + read.mm;
  const nowClock = now.hh + ':' + now.mm;
  return readClock >= MATCHI_QUIET_FROM && (nowClock >= MATCHI_QUIET_FROM || nowClock < MATCHI_QUIET_UNTIL);
}

// The cache keeps the Mac's Matchi read and the Worker's Pulse read under separate keys, so a Pulse
// read that finishes after a Mac POST can never overwrite the Mac's fresh St Ives and PDL days.
//   matchi: { readAt, goodAt: { si, pdl }, venues: { si: { date: day }, pdl: {...} } }
//   pulse:  { fetchedAt, goodAt, format, days: { date: day } }
export function assembleAvailability(matchi, pulse) {
  return {
    matchiFetchedAt: matchi?.readAt || null,
    pulseFetchedAt: pulse?.fetchedAt || null,
    goodAt: { si: matchi?.goodAt?.si || null, pdl: matchi?.goodAt?.pdl || null, pp: pulse?.goodAt || null, cu: matchi?.goodAt?.cu || null },
    venues: { si: matchi?.venues?.si || {}, pdl: matchi?.venues?.pdl || {}, pp: pulse?.days || {}, cu: matchi?.venues?.cu || {} },
  };
}

// ── The whole page state, pure ──
export function computeState({ people, votes, booked, availability, dates, nowMs, cfg = venueConfig() }) {
  const today = dates[0];
  const inWindow = new Set(dates);
  // A real name Kevin set replaces the name a player gave themselves everywhere (Kevin, 30 Oct 2026);
  // the name they chose stays as `nick` for Kevin's People screen.
  const ppl = people.map((p) => {
    const out = { id: p.id, name: p.realName || p.name, venues: Array.isArray(p.venues) ? p.venues : splitVenues(p.venues), savedAt: p.savedAt ?? null };
    if (p.realName) out.nick = p.name;
    return out;
  }).sort((x, y) => x.name.localeCompare(y.name, 'en', { sensitivity: 'base' }));
  const byId = new Map(ppl.map((p) => [p.id, p]));
  const voteMap = {};
  for (const v of votes) {
    const m = SLOT_RE.exec(v.slot);
    if (!m || !inWindow.has(m[1]) || !byId.has(v.person_id)) continue;
    (voteMap[v.slot] || (voteMap[v.slot] = [])).push(v.person_id);
  }
  // One booking a day (Kevin, 29 Oct 2026): a day with a booked hour shows no other ready or nearly
  // hour and sends no further DM, so the list never fills with options nobody will book.
  const bookedMap = {};
  const bookedDays = new Set();
  const bookedAt = {};
  for (const b of booked) {
    const m = SLOT_RE.exec(b.slot);
    if (!m || !inWindow.has(m[1])) continue;
    bookedMap[b.slot] = { person_id: b.person_id ?? null, venue: b.venue ?? null, start: b.start || null, minutes: b.minutes || null, courts: b.courts || 1 };
    if (b.paid_at) bookedMap[b.slot].paid = paidOf(b);
    bookedAt[b.slot] = Date.parse(b.created_at || '');
    bookedDays.add(m[1]);
  }
  const a = availability || {};
  const fetchedAt = { si: a.matchiFetchedAt || null, pdl: a.matchiFetchedAt || null, pp: a.pulseFetchedAt || null, cu: a.matchiFetchedAt || null };
  const fresh = {
    si: matchiFresh(fetchedAt.si, nowMs),
    pdl: matchiFresh(fetchedAt.pdl, nowMs),
    pp: ageOk(fetchedAt.pp, nowMs, PULSE_FRESH_MS),
    cu: matchiFresh(fetchedAt.cu, nowMs),
  };
  const checkedAt = { si: a.goodAt?.si || null, pdl: a.goodAt?.pdl || null, pp: a.goodAt?.pp || null, cu: a.goodAt?.cu || null };
  const venuesOut = {};
  for (const code of VENUES) {
    venuesOut[code] = {};
    for (const date of dates) {
      if (!fresh[code]) { venuesOut[code][date] = { status: 'error', reason: 'not checked recently', hours: {} }; continue; }
      const day = a.venues?.[code]?.[date];
      // A fresh read that lacks this date (after midnight the window gains a day the evening's
      // read never covered): "couldn't check" with the booking link, never "checking", because
      // nothing is checking until the next run. "pending" is only for a venue never read at all.
      if (!day) { venuesOut[code][date] = fetchedAt[code] ? { status: 'error', reason: 'not in the last read', hours: {} } : { status: 'pending', hours: {} }; continue; }
      const out = { status: day.status, hours: day.status === 'ok' ? hoursFromStarts(futureStarts(day.starts, date, nowMs)) : {} };
      if (day.reason) out.reason = day.reason;
      venuesOut[code][date] = out;
    }
  }
  const ready = [];
  const nearly = [];
  for (const slot of Object.keys(voteMap).sort()) {
    const [, date, hh] = SLOT_RE.exec(slot);
    if (bookedDays.has(date)) continue;
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
          maxs: c.hour.maxs, courtsBy: c.hour.courtsBy, courts: c.hour.courts, min: c.hour.min, max: c.hour.max,
          book: bookUrl(cfg, c.code, date), checkedAt: fetchedAt[c.code],
        })),
      });
    } else if (best === ALERT_AT - 1) {
      const q = counts.filter((c) => c.count === best);
      const names = [];
      for (const c of q) for (const p of c.people) if (!names.includes(p.name)) names.push(p.name);
      nearly.push({ slot, date, hh, label, count: best, names, venues: q.map((c) => ({ code: c.code, starts: c.hour.starts })) });
    }
  }
  // A booked hour with SECOND_COURT_AT or more in at its venue offers the second court when another
  // court is free at the booked start for the booked length (Kevin, 29 Oct 2026: "if 8 people can
  // play"). Never a DM. Only a read taken after the booking was marked counts: it no longer shows
  // the group's own court, so any court it shows free is another one. Before that read (15 minutes
  // at most) the Ready line's court count is the guide.
  for (const [slot, b] of Object.entries(bookedMap)) {
    if (!b.venue || b.courts >= 2 || !VENUES.includes(b.venue)) continue;
    if (!(Date.parse(fetchedAt[b.venue] || '') > bookedAt[slot])) continue;
    const [, date, hh] = SLOT_RE.exec(slot);
    const h = venuesOut[b.venue][date];
    const hour = fresh[b.venue] && h.status === 'ok' ? h.hours[hh] : null;
    if (!hour) continue;
    const at = b.start ? hour.starts.indexOf(b.start) : 0;
    if (at === -1 || (b.minutes && hour.maxs[at] < b.minutes)) continue;
    const in_ = (voteMap[slot] || []).map((id) => byId.get(id)).filter((p) => p.venues.includes(b.venue));
    if (in_.length < SECOND_COURT_AT) continue;
    b.second = { count: in_.length, names: in_.map((p) => p.name), start: hour.starts[at], book: bookUrl(cfg, b.venue, date) };
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

// A booking's Booked and paid record: the total, who is playing, and where the robot's two steps stand.
const parseIds = (raw) => { try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.filter((x) => Number.isInteger(x) && x > 0) : []; } catch { return []; } };
export function paidOf(b) {
  const step = (k) => ({ state: b[`${k}_state`] || null, at: b[`${k}_at`] || null, note: b[`${k}_note`] || null });
  return { price: b.price_pence ?? null, players: parseIds(b.players), at: b.paid_at, splitwise: step('splitwise'), texts: step('texts') };
}

// The ready slots that still need their one DM.
export function decideAlerts(state, alreadyAlerted) {
  const done = alreadyAlerted instanceof Set ? alreadyAlerted : new Set(alreadyAlerted || []);
  const bookedDays = new Set(Object.keys(state.booked).map((s) => s.split('|')[0]));
  return state.ready.filter((r) => !done.has(r.slot) && !state.booked[r.slot] && !bookedDays.has(r.date));
}

// "19:00, 19:30 (60 to 90 min, 3 courts)", or one bracket per start when they differ.
export const lengthText = (min, max) => (max > min ? `${min} to ${max} min` : `${min} min`);
export function startsText(v) {
  const maxs = v.maxs || v.mins;
  const courtsBy = v.courtsBy || v.starts.map(() => 1);
  const part = (i) => lengthText(v.mins[i], maxs[i]) + (courtsBy[i] > 1 ? `, ${courtsBy[i]} courts` : '');
  const same = v.starts.every((_, i) => part(i) === part(0));
  return same ? `${v.starts.join(', ')} (${part(0)})` : v.starts.map((t, i) => `${t} (${part(i)})`).join(', ');
}
const slackSafe = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// With nowMs, a read from another London day says so ("22:45 yesterday"): a DM sent at 02:00 on
// the evening's last read must not read like a check made minutes ago.
function checkedText(venues, cfg, nowMs) {
  const today = Number.isFinite(nowMs) ? londonParts(nowMs).date : null;
  const groups = [];
  for (const v of venues) {
    let t = '?';
    if (v.checkedAt) {
      t = londonHHMM(v.checkedAt);
      const d = londonParts(Date.parse(v.checkedAt)).date;
      if (today && d !== today) t += d === addDays(today, -1) ? ' yesterday' : ' on ' + d;
    }
    const g = groups.find((x) => x.t === t);
    if (g) g.names.push(cfg[v.code].short); else groups.push({ t, names: [cfg[v.code].short] });
  }
  if (groups.length === 1) return `Courts checked ${groups[0].t}.`;
  return `Courts checked: ${groups.map((g) => `${g.names.join(' and ')} ${g.t}`).join(', ')}.`;
}
// One line per venue, each with its OWN count and names: people are never added up across venues.
export function alertText(r, cfg, pageUrl, nowMs) {
  const lines = r.venues.map((v) => `${cfg[v.code].short}: ${v.count} in (${v.names.map(slackSafe).join(', ')}), starts ${startsText(v)}, book <${v.book}>.`);
  return `Padel: ${r.label}. ${lines.join(' ')} ${checkedText(r.venues, cfg, nowMs)} Whoever books taps Booked on the page ${pageUrl}`;
}

// Names: one person, one row. Accents and case are folded before comparing, so "Zoë" and "ZOE"
// find the same person.
export const foldName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ── Levels (Stage 2, Kevin 27 Nov 2026) ──
// The scale is Playtomic's, 0 to 7 (the starting levels on the page are Playtomic's chart steps). How a
// score moves a level follows Nettla's published rules (player-help.nettla.co, "How do Nettla padel
// levels work?", read 27 Nov 2026): a win always goes up and a loss down; beating stronger opponents
// counts for more; a close match counts for less than a clear win; your partner's level matters; lower
// levels and players with fewer matches move faster; an unfinished match with a completed set moves
// half as far, and one with no completed set (or level) not at all; peer feedback has a small extra
// effect from 2 matching votes; 90 days without a match drops a level 0.10. Nettla does not publish its
// numbers, so the sizes below are ours: a new player moves about 0.2 a match, a settled one about 0.05.
export const LEVEL_MIN = 0;
export const LEVEL_MAX = 7;
export const LEVEL_SCALE = 2;          // a 1.0 gap between the pairs: the stronger pair expected to win 76%
export const LEVEL_K = 0.15;           // the size of a change for a settled player at level 2
export const LEVEL_CAP = 0.4;          // no one moves more than this in one score
export const RELIABLE_AT = 20;         // rated scores in the last RELIABLE_DAYS for 100% reliability
export const RELIABLE_DAYS = 180;
export const DECAY_DAYS = 90;          // Nettla: 90 days without a match, the level drops 0.10, and again
export const DECAY_STEP = 0.1;
export const FEEDBACK_STEP = 0.05;
export const FEEDBACK_MS = 24 * 3600 * 1000;
export const SCORE_DAYS = 7;           // a score can go in for today and the 6 days before
export const SCORE_REPEAT_MS = 30 * 60 * 1000;   // the same pairs and games again within this is the same match entered twice
export const KC_WEIGHT = 0.25;         // Stage 3: a first-to-3 Kings and challengers game counts a quarter
export const VOTES = ['higher', 'expected', 'lower'];
const r3 = (x) => Math.round(x * 1000) / 1000;
export const clampLevel = (x) => Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, x));
// A finished set: 6 games with a 2-game lead, or 7-5, or 7-6.
export const setDone = (a, b) => { const hi = Math.max(a, b), lo = Math.min(a, b); return (hi === 6 && hi - lo >= 2) || (hi === 7 && (lo === 5 || lo === 6)); };
// The result of a score: first to 2 sets is finished; otherwise the team with more finished sets (or, if
// equal, more games) wins, at half the change (Nettla's unfinished match); no finished set, no winner.
export function matchResult(sets) {
  let setsA = 0, setsB = 0, gamesA = 0, gamesB = 0, completed = 0;
  for (const [x, y] of sets) {
    gamesA += x; gamesB += y;
    if (setDone(x, y)) { completed += 1; if (x > y) setsA += 1; else setsB += 1; }
  }
  const finished = setsA === 2 || setsB === 2;
  let winner = null;
  if (completed) winner = setsA > setsB ? 'a' : setsB > setsA ? 'b' : gamesA > gamesB ? 'a' : gamesB > gamesA ? 'b' : null;
  return { setsA, setsB, gamesA, gamesB, completed, finished, winner, half: finished ? 1 : 0.5 };
}
export const expectedWin = (win, lose) => 1 / (1 + 10 ** ((lose - win) / LEVEL_SCALE));
export const reliabilityOf = (recent) => Math.min(1, recent / RELIABLE_AT);
// Lower levels and fewer matches move faster: up to three times for a new player.
export const kFactor = (level, reliability) => LEVEL_K * (1.2 - level / 10) * (1 + 2 * (1 - reliability));
// The change to each level for a score. a and b: [{ id, level, recent }] (recent = rated scores in the last
// RELIABLE_DAYS). weight is 1 for a match (KC_WEIGHT for a Kings and challengers game in Stage 3).
export function levelChanges({ a, b, sets, weight = 1 }) {
  const res = matchResult(sets);
  if (!res.winner) return { ...res, changes: {} };
  const [win, lose] = res.winner === 'a' ? [a, b] : [b, a];
  const [gw, gl] = res.winner === 'a' ? [res.gamesA, res.gamesB] : [res.gamesB, res.gamesA];
  const margin = Math.max(0.25, 0.5 + (gw - gl) / (gw + gl));   // a close match counts for less than a clear one
  return { ...res, changes: pairChanges({ win, lose, margin, half: res.half, weight }) };
}
// The change for each player when one pair beat the other: the less likely the win, the bigger it is.
export function pairChanges({ win, lose, margin = 1, half = 1, weight = 1 }) {
  const avg = (t) => (t[0].level + t[1].level) / 2;
  const base = 1 - expectedWin(avg(win), avg(lose));
  const changes = {};
  for (const [team, sign] of [[win, 1], [lose, -1]]) {
    for (const p of team) {
      const size = Math.min(LEVEL_CAP, kFactor(p.level, reliabilityOf(p.recent)) * base * margin * half * weight);
      changes[p.id] = r3(clampLevel(p.level + sign * size) - p.level);
    }
  }
  return changes;
}
// The level shown: 0.10 off for every 90 days since the last level pick or rated score.
export function decayedLevel(level, activeAt, today) {
  if (level == null) return null;
  if (!activeAt) return level;
  const days = Math.floor((Date.parse(today) - Date.parse(activeAt)) / 86400000);
  return days >= DECAY_DAYS ? r3(Math.max(LEVEL_MIN, level - DECAY_STEP * Math.floor(days / DECAY_DAYS))) : level;
}
// A level typed on a phone: a number from 0 to 7, kept to 2 decimals.
export function cleanLevel(raw) {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d(\.\d{1,2})?$/.test(raw.trim()) ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= LEVEL_MIN && n <= LEVEL_MAX ? Math.round(n * 100) / 100 : null;
}
// A score as a phone sends it, checked. people: the list; levels: id -> level; dates: the page's days
// (today first); admin: Kevin's phone, which may enter a score it did not play in.
export function cleanScore(body, people, levels, dates, admin = false) {
  const key = String(body.key || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(key)) return { error: 'The score has no id: reload the page and try again' };
  const today = dates[0];
  const playedOn = String(body.played_on || '');
  const realDay = /^\d{4}-\d{2}-\d{2}$/.test(playedOn) && !Number.isNaN(Date.parse(`${playedOn}T12:00:00Z`)) && new Date(`${playedOn}T12:00:00Z`).toISOString().slice(0, 10) === playedOn;
  if (!realDay || playedOn > today || playedOn < addDays(today, -(SCORE_DAYS - 1))) return { error: `A score is for today or the ${SCORE_DAYS - 1} days before` };
  const team = (t) => (Array.isArray(t) && t.length === 2 ? t.map(intId) : null);
  const a = team(body.team_a), b = team(body.team_b);
  if (!a || !b || [...a, ...b].some((x) => !x) || new Set([...a, ...b]).size !== 4) return { error: 'Pick two pairs: four different players' };
  const known = new Map(people.map((p) => [p.id, p]));
  if ([...a, ...b].some((x) => !known.has(x))) return { error: 'One of those players is not on the list' };
  const enteredBy = admin ? (intId(body.entered_by) || 0) : intId(body.entered_by);
  if (!admin && (!enteredBy || ![...a, ...b].includes(enteredBy))) return { error: 'Only someone who played can put the score in' };
  if (!Array.isArray(body.sets) || !body.sets.length || body.sets.length > 3) return { error: 'Put in 1 to 3 sets' };
  const sets = [];
  let wonA = 0, wonB = 0;
  for (const [i, raw] of body.sets.entries()) {
    const g = Array.isArray(raw) && raw.length === 2 ? raw.map((x) => (Number.isInteger(x) && x >= 0 && x <= 7 ? x : null)) : null;
    if (!g || g.includes(null)) return { error: 'Games in a set are 0 to 7' };
    const [x, y] = g;
    if (wonA === 2 || wonB === 2) return { error: 'The match was over after two sets: leave the third set empty' };
    const last = i === body.sets.length - 1;
    if (!setDone(x, y) && (!last || Math.max(x, y) === 7 || (Math.max(x, y) === 6 && Math.min(x, y) <= 4) || x + y === 0)) {
      return { error: last ? `Set ${i + 1} is not a set score (6-4, 7-5, 7-6, or the games when you stopped)` : `Set ${i + 1} is not finished: only the last set can be` };
    }
    if (setDone(x, y)) { if (x > y) wonA += 1; else wonB += 1; }
    sets.push([x, y]);
  }
  const rated = body.rated !== false;
  if (rated) {
    const none = [...a, ...b].filter((x) => levels.get(x) == null).map((x) => known.get(x).realName || known.get(x).name);
    if (none.length) return { error: `${none.join(', ')} ${none.length === 1 ? 'has' : 'have'} no level yet: pick one first, or tick Friendly`, status: 409 };
  }
  return { key, playedOn, a, b, sets, rated, enteredBy };
}
// The same match entered twice (review of PR #1023): the two pairs and the games, the same whichever pair
// entered it. Within SCORE_REPEAT_MS it is refused; a unique index on (played_on, fingerprint), where the
// fingerprint ends in the half hour it went in, refuses a second one even when both pairs send it at the
// same moment. The same pairs and games later the same day is a new match.
export function scoreFingerprint(a, b, sets) {
  const pa = [...a].sort((x, y) => x - y), pb = [...b].sort((x, y) => x - y);
  const flip = pb[0] < pa[0];
  const [p1, p2] = flip ? [pb, pa] : [pa, pb];
  const games = (flip ? sets.map(([x, y]) => [y, x]) : sets).map(([x, y]) => `${x}-${y}`).join(' ');
  return `${p1.join(',')}|${p2.join(',')}|${games}`;
}
// Rated scores in the window, a Kings and challengers game counting a quarter (Kevin, 28 Nov 2026).
const countRecent = (matches, from) => {
  const n = new Map();
  for (const m of matches) if (m.rated && m.playedOn >= from) for (const id of [...m.a, ...m.b]) n.set(id, (n.get(id) || 0) + (m.kind === 'kc' ? KC_WEIGHT : 1));
  return n;
};
// The league table and the last month's scores, for everyone's page.
export function computeLevels({ levels, matches, voters = [], today, nowMs }) {
  const recent = countRecent(matches, addDays(today, -RELIABLE_DAYS));
  const last = new Map();
  for (const m of [...matches].sort((x, y) => (x.playedOn === y.playedOn ? x.id - y.id : x.playedOn < y.playedOn ? -1 : 1))) {
    for (const id of [...m.a, ...m.b]) if (m.rated && (m.changes[id] != null || m.feedback[id] != null)) last.set(id, r3((m.changes[id] || 0) + (m.feedback[id] || 0)));
  }
  const players = levels.map((l) => ({
    id: l.id, level: l.level == null ? null : Math.round(decayedLevel(l.level, l.level_active_at, today) * 100) / 100,
    matches: l.level_matches || 0, reliability: Math.round(reliabilityOf(recent.get(l.id) || 0) * 100), last: last.has(l.id) ? last.get(l.id) : null,
  }));
  const votedBy = new Map();
  for (const v of voters) { if (!votedBy.has(v.match_id)) votedBy.set(v.match_id, new Set()); votedBy.get(v.match_id).add(v.from_id); }
  const scores = matches.filter((m) => m.kind !== 'kc' && m.playedOn >= addDays(today, -30)).sort((x, y) => (x.playedOn === y.playedOn ? y.id - x.id : x.playedOn < y.playedOn ? 1 : -1)).map((m) => {
    const r = matchResult(m.sets);
    const until = Date.parse(m.enteredAt) + FEEDBACK_MS;
    return {
      id: m.id, on: m.playedOn, a: m.a, b: m.b, sets: m.sets, rated: m.rated, kind: m.kind, winner: r.winner, finished: r.finished,
      changes: m.changes, feedback: m.feedback, enteredBy: m.enteredBy, feedbackOpen: m.rated && !!r.winner && nowMs < until, voted: [...(votedBy.get(m.id) || [])],
    };
  });
  return { players, scores };
}

// ── Match day (Stage 3, Kevin 28 Nov 2026) ──
// The format by players and courts (Kevin: up to 12 on 2 courts; 4 a match; 5 or 6 Kings and challengers;
// 8 two matches; 12 two groups of 6; the rest as he approved: 7 one court of Kings and challengers, 9 a
// match and 5, 10 two groups of 5, 11 groups of 5 and 6).
export const MATCH_DAY_MAX = 12;
export const KC_SESSION_CAP = 0.4;     // one session moves a level no more than one match can
export const PARTNER_DAYS = 90;        // "played with least": partners in the last 90 days
export const KC_HISTORY = 40;          // states kept for Undo
export function formatPlan(n, courts = 1) {
  if (n < 4) return { groups: [], note: 'Match day needs at least 4 players' };
  const take = Math.min(n, MATCH_DAY_MAX);
  const g = (kind, size) => ({ kind, size });
  const notes = [];
  if (n > MATCH_DAY_MAX) notes.push(`Only ${MATCH_DAY_MAX} fit: ${n - MATCH_DAY_MAX} sit out`);
  let groups;
  if (courts < 2 || take <= 7) {
    groups = take === 4 ? [g('match', 4)] : [g('kc', take)];
    if (courts >= 2) notes.push(take === 4 ? 'One court is enough for 4' : 'One court of Kings and challengers');
    else if (take > 7) notes.push('A long queue on one court: a second court would help');
  } else if (take === 8) groups = [g('match', 4), g('match', 4)];
  else if (take === 9) groups = [g('match', 4), g('kc', 5)];
  else if (take === 10) groups = [g('kc', 5), g('kc', 5)];
  else if (take === 11) groups = [g('kc', 5), g('kc', 6)];
  else groups = [g('kc', 6), g('kc', 6)];
  return { groups, note: notes.join('. ') };
}
const pairKey = (x, y) => (x < y ? `${x}-${y}` : `${y}-${x}`);
// How often each two have been partners (both pairs of every score and game since `from`).
export function partnerCounts(matches, from) {
  const n = new Map();
  for (const m of matches) {
    if (m.playedOn < from) continue;
    for (const t of [m.a, m.b]) if (t.length === 2) n.set(pairKey(t[0], t[1]), (n.get(pairKey(t[0], t[1])) || 0) + 1);
  }
  return n;
}
const shuffled = (ids, rng) => { const a = [...ids]; for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// Two pairs from four players. fair: the two pairs' levels as close as they can be (when all four have one),
// then the partners who have played together least; shuffle: any of the three ways, at random.
export function bestPairs(four, levelOf, partners, mode = 'fair', rng = Math.random) {
  const [p, q, r, t] = four;
  const ways = [[[p, q], [r, t]], [[p, r], [q, t]], [[p, t], [q, r]]];
  if (mode === 'shuffle') { const w = ways[Math.floor(rng() * 3)]; return { a: w[0], b: w[1] }; }
  const known = four.every((id) => levelOf(id) != null);
  const cost = ([a, b]) => (known ? Math.abs(levelOf(a[0]) + levelOf(a[1]) - levelOf(b[0]) - levelOf(b[1])) * 10 : 0)
    + (partners.get(pairKey(a[0], a[1])) || 0) + (partners.get(pairKey(b[0], b[1])) || 0);
  const best = Math.min(...ways.map(cost));
  const tied = ways.filter((w) => Math.abs(cost(w) - best) < 1e-9);
  const w = tied[Math.floor(rng() * tied.length)];
  return { a: w[0], b: w[1] };
}
// Players into groups of the given sizes. fair: a snake draft by level, strongest first (court 1, 2, 2, 1,
// 1, 2 ...), so both courts end up with close levels; players with no level fill what is left, spread
// evenly. shuffle: at random.
export function splitGroups(ids, sizes, levelOf, mode = 'fair', rng = Math.random) {
  if (sizes.length === 1) return [ids.slice(0, sizes[0])];
  const out = sizes.map(() => []);
  if (mode === 'shuffle') { const order = shuffled(ids, rng); let i = 0; for (const [gi, n] of sizes.entries()) { out[gi] = order.slice(i, i + n); i += n; } return out; }
  const ranked = shuffled(ids.filter((id) => levelOf(id) != null), rng).sort((x, y) => levelOf(y) - levelOf(x));
  const snake = [];
  for (let round = 0; snake.length < ranked.length + sizes.length; round += 1) snake.push(...(round % 2 ? [...sizes.keys()].reverse() : [...sizes.keys()]));
  let k = 0;
  for (const id of ranked) {
    while (out[snake[k % snake.length]].length >= sizes[snake[k % snake.length]]) k += 1;
    out[snake[k % snake.length]].push(id);
    k += 1;
  }
  for (const id of shuffled(ids.filter((x) => levelOf(x) == null), rng)) {
    const open = [...sizes.keys()].filter((i) => out[i].length < sizes[i]).sort((x, y) => out[x].length / sizes[x] - out[y].length / sizes[y]);
    out[open[0]].push(id);
  }
  return out;
}
// The start of a Kings and challengers group: four on court as two pairs (as bestPairs), which pair is
// king decided at random (on court they play for serve), the rest queuing at random.
export function kcStart(ids, levelOf, partners, mode = 'fair', rng = Math.random) {
  const order = shuffled(ids, rng);
  const { a, b } = bestPairs(order.slice(0, 4), levelOf, partners, mode, rng);
  const [kings, challengers] = rng() < 0.5 ? [a, b] : [b, a];
  return { players: [...ids], kings, challengers, queue: order.slice(4), streak: 0, points: Object.fromEntries(ids.map((id) => [id, 0])), games: 0, history: [] };
}
// One Kings and challengers game, by Kevin's rules (27 Nov 2026): first to 3 points; the player on the
// losing side who lost the last point comes off and the next in line comes on beside the other loser as
// the challengers; when the challengers win they become the kings; every time the kings win, both kings
// get a point; after 3 points in a row both kings come off, the challengers step up to be the kings and
// the next two in line come on. Only kings score. Returns the next state and who won and lost.
export function kcApply(st, winner, lostBy) {
  if (!['kings', 'challengers'].includes(winner)) return { error: 'Who won: the kings or the challengers?' };
  const winners = winner === 'kings' ? [...st.kings] : [...st.challengers];
  const losers = winner === 'kings' ? [...st.challengers] : [...st.kings];
  if (!losers.includes(lostBy)) return { error: 'Pick the player who lost the last point' };
  const queue = [...st.queue];
  const points = { ...st.points };
  const stay = losers.find((x) => x !== lostBy);
  queue.push(lostBy);
  const comer = queue.shift();
  let kings = winners;
  let challengers = [stay, comer];
  let streak = winner === 'kings' ? st.streak + 1 : 0;
  if (winner === 'kings') for (const k of winners) points[k] = (points[k] || 0) + 1;
  if (streak >= 3) {
    queue.push(...winners);
    kings = challengers;
    challengers = [queue.shift(), queue.shift()];
    streak = 0;
  }
  const snapshot = { kings: st.kings, challengers: st.challengers, queue: st.queue, streak: st.streak, points: st.points, games: st.games };
  return {
    state: { ...st, kings, challengers, queue, streak, points, games: st.games + 1, history: [...(st.history || []), snapshot].slice(-KC_HISTORY) },
    winners, losers,
  };
}
// A session's cap: a game's change trimmed so that no one's total for the session passes +-KC_SESSION_CAP.
export function capSession(changes, soFar) {
  const out = {};
  for (const [id, d] of Object.entries(changes)) {
    const had = soFar.get(Number(id)) || 0;
    out[id] = r3(Math.min(KC_SESSION_CAP, Math.max(-KC_SESSION_CAP, had + d)) - had);
  }
  return out;
}

// ── D1 access, behind one small object so tests can swap in a Map-backed copy ──
const toPerson = (r) => {
  const p = { id: r.id, name: r.name, venues: splitVenues(r.venues), savedAt: r.votes_at || null };
  if (r.real_name) p.realName = r.real_name;
  return p;
};
const PEOPLE_COLS = 'id, name, venues, votes_at, real_name';
const MATCH_COLS = 'id, key, played_on, team_a, team_b, sets, rated, kind, entered_by, entered_at, changes, feedback_changes, deleted_at, fingerprint, session_id';
// A level moved BY an amount, in the database (review of PR #1023: two saves at once must both count,
// never the second overwriting the first), kept within 0 to 7; the rated-score count moved; the active
// date only ever moved later. ?5 and ?6, when given, make it conditional on this request's own write to
// the matches row (a delete, a feedback version), so a request that lost a race moves no level.
const PEOPLE_LEVEL_SQL = `UPDATE people SET level = MIN(${LEVEL_MAX}, MAX(${LEVEL_MIN}, ROUND(COALESCE(level, 0) + ?2, 3))), level_matches = MAX(0, level_matches + ?3),
  level_active_at = CASE WHEN ?4 IS NULL THEN level_active_at WHEN level_active_at IS NULL OR level_active_at < ?4 THEN ?4 ELSE level_active_at END WHERE id = ?1`;
const PEOPLE_LEVEL_IF_SQL = (col) => `${PEOPLE_LEVEL_SQL} AND (SELECT ${col} FROM matches WHERE id = ?5) = ?6`;
// A 90-day drop a score settles, taken only while the active date is still the one read: two scores at
// the same moment, or a level Kevin set meanwhile, never take it twice.
const PEOPLE_SETTLE_SQL = `UPDATE people SET level = MIN(${LEVEL_MAX}, MAX(${LEVEL_MIN}, ROUND(COALESCE(level, 0) + ?2, 3))) WHERE id = ?1 AND level_active_at IS ?3`;
const parseChanges = (raw) => { try { const o = JSON.parse(raw || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'number')) : {}; } catch { return {}; } };
const parseSets = (raw) => { try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const toMatch = (r) => ({
  id: r.id, key: r.key, playedOn: r.played_on, a: parseIds(r.team_a), b: parseIds(r.team_b), sets: parseSets(r.sets), rated: !!r.rated, kind: r.kind,
  enteredBy: r.entered_by, enteredAt: r.entered_at, changes: parseChanges(r.changes), feedback: parseChanges(r.feedback_changes), feedbackRaw: r.feedback_changes || '{}',
  deletedAt: r.deleted_at || null, fingerprint: r.fingerprint || null, sessionId: r.session_id ?? null,
});
const parseState = (raw) => { try { const o = JSON.parse(raw || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const toSession = (r) => ({ id: r.id, slot: r.slot, no: r.group_no, kind: r.kind, state: parseState(r.state), version: r.version });
// Booked and paid, or a change to it: only while the robot has not started on Splitwise (or it failed).
const SET_PAID_SQL = `UPDATE booked SET price_pence = ?2, players = ?3, paid_at = ?4, splitwise_state = NULL, splitwise_at = NULL, splitwise_note = NULL,
  texts_state = NULL, texts_at = NULL, texts_note = NULL WHERE slot = ?1 AND COALESCE(splitwise_state, '') IN ('', 'failed') AND texts_state IS NULL`;
// A booking, or a change to it. A detail left out keeps its stored value; a paid booking changes only by
// Kevin's phone, and only before the robot starts on Splitwise.
const SET_BOOKED_SQL = `INSERT INTO booked (slot, person_id, venue, start, minutes, courts, created_at) VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, 1), ?7)
  ON CONFLICT(slot) DO UPDATE SET person_id = excluded.person_id, venue = excluded.venue, start = COALESCE(excluded.start, booked.start), minutes = COALESCE(excluded.minutes, booked.minutes), courts = COALESCE(?6, booked.courts), created_at = excluded.created_at,
    paid_at = CASE WHEN booked.paid_at IS NULL THEN NULL ELSE excluded.created_at END   -- a re-marked paid booking is a new version: a robot holding the old one cannot claim it
  WHERE booked.paid_at IS NULL OR (?8 = 1 AND COALESCE(booked.splitwise_state, '') IN ('', 'failed'))`;
const bookedArgs = (slot, personId, venue, nowIso, details = {}, admin = false) =>
  [slot, personId, venue, details.start ?? null, details.minutes ?? null, details.courts ?? null, nowIso, admin ? 1 : 0];
const BOOKED_COLS = 'slot, person_id, venue, start, minutes, courts, created_at, price_pence, players, paid_at, splitwise_state, splitwise_at, splitwise_note, texts_state, texts_at, texts_note';
export function makeRepo(db) {
  return {
    async listPeople() {
      const r = await db.prepare(`SELECT ${PEOPLE_COLS} FROM people ORDER BY name COLLATE NOCASE`).all();
      return (r.results || []).map(toPerson);
    },
    async getPerson(id) {
      const r = await db.prepare(`SELECT ${PEOPLE_COLS} FROM people WHERE id = ?`).bind(id).first();
      return r ? toPerson(r) : null;
    },
    async countPeople() {
      const r = await db.prepare('SELECT COUNT(*) AS n FROM people').first();
      return Number(r?.n || 0);
    },
    async addPerson(name, nowIso) {
      await db.prepare('INSERT INTO people (name, venues, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(name) DO NOTHING').bind(name, VENUES.join(','), nowIso).run();
      const r = await db.prepare(`SELECT ${PEOPLE_COLS} FROM people WHERE name = ? COLLATE NOCASE`).bind(name).first();
      return r ? toPerson(r) : null;
    },
    async setRealName(id, realName) {
      const r = await db.prepare('UPDATE people SET real_name = ? WHERE id = ?').bind(realName, id).run();
      return (r.meta?.changes || 0) === 1;
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
      const r = await db.prepare(`SELECT ${BOOKED_COLS} FROM booked WHERE slot >= ?`).bind(fromDate).all();
      return r.results || [];
    },
    async getBooked(slot) {
      return (await db.prepare(`SELECT ${BOOKED_COLS} FROM booked WHERE slot = ?`).bind(slot).first()) || null;
    },
    // Booked and paid, or a change to it: only while the robot has not started on Splitwise (or it
    // failed), so a price or player change can never race an entry already made.
    async setPaid(slot, pricePence, players, nowIso) {
      const r = await db.prepare(SET_PAID_SQL).bind(slot, pricePence, JSON.stringify(players), nowIso).run();
      return (r.meta?.changes || 0) === 1;
    },
    async clearPaid(slot) {
      const r = await db.prepare(`UPDATE booked SET price_pence = NULL, players = NULL, paid_at = NULL, splitwise_state = NULL, splitwise_at = NULL, splitwise_note = NULL,
        texts_state = NULL, texts_at = NULL, texts_note = NULL WHERE slot = ? AND paid_at IS NOT NULL AND COALESCE(splitwise_state, '') IN ('', 'failed') AND texts_state IS NULL`).bind(slot).run();
      return (r.meta?.changes || 0) === 1;
    },
    // The robot's steps: claimed from nothing, then done or failed from claimed; Retry clears a failed one.
    // Resume is the robot's own Retry, and only of a step that failed because it was signed out of
    // Splitwise (its own note says so): nothing was tried, and Kevin's sign-in is all it waited on.
    async markStep(slot, step, state, note, nowIso, paidAt = null) {
      if (!PAID_STEPS.includes(step) || !['claimed', 'done', 'failed', 'retry', 'resume'].includes(state)) return false;
      let from = state === 'claimed' ? `${step}_state IS NULL` : state === 'retry' || state === 'resume' ? `${step}_state = 'failed'` : `${step}_state = 'claimed'`;
      if (state === 'claimed' && step === 'texts') from += " AND splitwise_state = 'done'";
      if (state === 'claimed') from += ' AND paid_at = ?5';
      if (state === 'resume') from += ` AND ${step}_note LIKE ?5`;
      const to = state === 'retry' || state === 'resume' ? null : state;
      const args = [slot, to, to ? nowIso : null, to ? note : null];
      if (state === 'claimed') args.push(paidAt);            // ?5 is the version read in a claim,
      if (state === 'resume') args.push(`%${SIGNED_OUT_MARK}%`);   // and the robot's own sign-out note in a resume
      const r = await db.prepare(`UPDATE booked SET ${step}_state = ?2, ${step}_at = ?3, ${step}_note = ?4 WHERE slot = ?1 AND paid_at IS NOT NULL AND ${from}`)
        .bind(...args).run();
      return (r.meta?.changes || 0) === 1;
    },
    // Levels and scores (sql-changes/0006, 27 Nov 2026).
    async listLevels() {
      const r = await db.prepare('SELECT id, level, level_matches, level_active_at FROM people').all();
      return r.results || [];
    },
    async setLevel(id, level, activeAt, onlyUnplayed = false) {
      const r = await db.prepare(`UPDATE people SET level = ?2, level_active_at = ?3 WHERE id = ?1${onlyUnplayed ? ' AND level_matches = 0' : ''}`).bind(id, level, activeAt).run();
      return (r.meta?.changes || 0) === 1;
    },
    async listMatches(fromDate) {
      const r = await db.prepare(`SELECT ${MATCH_COLS} FROM matches WHERE played_on >= ? AND deleted_at IS NULL ORDER BY played_on, id`).bind(fromDate).all();
      return (r.results || []).map(toMatch);
    },
    async getMatch(id) {
      const r = await db.prepare(`SELECT ${MATCH_COLS} FROM matches WHERE id = ?`).bind(id).first();
      return r ? toMatch(r) : null;
    },
    async getMatchByKey(key) {
      const r = await db.prepare(`SELECT ${MATCH_COLS} FROM matches WHERE key = ?`).bind(key).first();
      return r ? toMatch(r) : null;
    },
    async getLiveMatchByFingerprint(playedOn, fingerprint) {
      const r = await db.prepare(`SELECT ${MATCH_COLS} FROM matches WHERE played_on = ?1 AND fingerprint = ?2 AND deleted_at IS NULL`).bind(playedOn, fingerprint).first();
      return r ? toMatch(r) : null;
    },
    async listFeedback(matchIds) {
      if (!matchIds.length) return [];
      const r = await db.prepare('SELECT match_id, from_id, about_id, vote FROM feedback WHERE match_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(matchIds)).all();
      return r.results || [];
    },
    // One score and the levels it moves, in one transaction: a double tap (the same key) fails whole.
    // A score and the levels it moves, in one transaction: the same key, or the same match on the same
    // day, fails the whole batch (UNIQUE), so nothing moves twice.
    async addScore(m, updates, nowIso) {
      await db.batch([
        db.prepare('INSERT INTO matches (key, played_on, team_a, team_b, sets, rated, kind, entered_by, entered_at, changes, fingerprint) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)')
          .bind(m.key, m.playedOn, JSON.stringify(m.a), JSON.stringify(m.b), JSON.stringify(m.sets), m.rated ? 1 : 0, m.kind || 'match', m.enteredBy, nowIso, JSON.stringify(m.changes || {}), m.fingerprint),
        ...updates.filter((u) => u.settle).map((u) => db.prepare(PEOPLE_SETTLE_SQL).bind(u.id, u.settle, u.readActive)),
        ...updates.map((u) => db.prepare(PEOPLE_LEVEL_SQL).bind(u.id, u.delta, u.matches, u.activeAt)),
      ]);
    },
    // The levels move back only if THIS request marked the score deleted (token), and only from the
    // feedback version it read: a second delete, or a feedback swap landing meanwhile, changes nothing here
    // (the caller reads again and retries).
    async deleteScore(id, token, feedbackRaw, updates) {
      await db.batch([
        db.prepare('UPDATE matches SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL AND feedback_changes = ?3').bind(id, token, feedbackRaw),
        ...updates.map((u) => db.prepare(PEOPLE_LEVEL_IF_SQL('deleted_at')).bind(u.id, u.delta, u.matches, null, id, token)),
      ]);
    },
    // Match day (sql-changes/0007, 28 Nov 2026).
    async listSessions(slots) {
      if (!slots.length) return [];
      const r = await db.prepare('SELECT id, slot, group_no, kind, state, version FROM sessions WHERE slot IN (SELECT value FROM json_each(?)) ORDER BY slot, group_no').bind(JSON.stringify(slots)).all();
      return (r.results || []).map(toSession);
    },
    // A fresh plan for a slot, replacing the old one in the same transaction.
    async replaceSessions(slot, groups, nowIso) {
      await db.batch([
        db.prepare('DELETE FROM sessions WHERE slot = ?').bind(slot),
        ...groups.map((g) => db.prepare('INSERT INTO sessions (slot, group_no, kind, state, version, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)').bind(slot, g.no, g.kind, JSON.stringify(g.state), nowIso)),
      ]);
    },
    // A session's new state, only from the version read (two phones: one change).
    async setSession(id, version, state, nowIso) {
      const r = await db.prepare('UPDATE sessions SET state = ?3, version = version + 1, updated_at = ?4 WHERE id = ?1 AND version = ?2').bind(id, version, JSON.stringify(state), nowIso).run();
      return (r.meta?.changes || 0) === 1;
    },
    // A Kings and challengers game: the session's next state (from the version read), the game as a
    // quarter-weight rated score, and the levels it moves, in one transaction. The game's key is the
    // session and the version, so the same game tapped twice fails whole.
    async addKcGame(sessionId, version, state, m, updates, nowIso) {
      await db.batch([
        db.prepare('UPDATE sessions SET state = ?3, version = version + 1, updated_at = ?4 WHERE id = ?1 AND version = ?2').bind(sessionId, version, JSON.stringify(state), nowIso),
        db.prepare('INSERT INTO matches (key, played_on, team_a, team_b, sets, rated, kind, entered_by, entered_at, changes, fingerprint, session_id) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?10, ?11)')
          .bind(m.key, m.playedOn, JSON.stringify(m.a), JSON.stringify(m.b), '[]', 'kc', m.enteredBy, nowIso, JSON.stringify(m.changes), m.key, sessionId),
        ...updates.filter((u) => u.settle).map((u) => db.prepare(PEOPLE_SETTLE_SQL).bind(u.id, u.settle, u.readActive)),
        ...updates.map((u) => db.prepare(`${PEOPLE_LEVEL_SQL} AND (SELECT version FROM sessions WHERE id = ?5) = ?6`).bind(u.id, u.delta, u.matches, u.activeAt, sessionId, version + 1)),
      ]);
    },
    // Undo the last game: the session back one state (from the version read), the game deleted and its
    // levels reversed only if this request did both.
    async undoKcGame(sessionId, version, state, matchId, token, updates, nowIso) {
      await db.batch([
        db.prepare('UPDATE sessions SET state = ?3, version = version + 1, updated_at = ?4 WHERE id = ?1 AND version = ?2').bind(sessionId, version, JSON.stringify(state), nowIso),
        db.prepare('UPDATE matches SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL AND (SELECT version FROM sessions WHERE id = ?3) = ?4').bind(matchId, token, sessionId, version + 1),
        ...updates.map((u) => db.prepare(PEOPLE_LEVEL_IF_SQL('deleted_at')).bind(u.id, u.delta, u.matches, null, matchId, token)),
      ]);
    },
    async listSessionGames(sessionId) {
      const r = await db.prepare(`SELECT ${MATCH_COLS} FROM matches WHERE session_id = ? AND deleted_at IS NULL ORDER BY id`).bind(sessionId).all();
      return (r.results || []).map(toMatch);
    },
    async putVotes(matchId, fromId, votes, nowIso) {
      await db.batch(votes.map(([about, vote]) => db.prepare('INSERT INTO feedback (match_id, from_id, about_id, vote, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(match_id, from_id, about_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at')
        .bind(matchId, fromId, about, vote, nowIso)));
    },
    // The feedback's effect, swapped in only from the version this request read (compare and set); the
    // levels move only if that swap was this request's.
    async swapFeedback(matchId, fromRaw, toRaw, updates) {
      await db.batch([
        db.prepare('UPDATE matches SET feedback_changes = ?3 WHERE id = ?1 AND feedback_changes = ?2 AND deleted_at IS NULL').bind(matchId, fromRaw, toRaw),
        ...updates.map((u) => db.prepare(PEOPLE_LEVEL_IF_SQL('feedback_changes')).bind(u.id, u.delta, 0, null, matchId, toRaw)),
      ]);
    },
    async listPaidPending(fromDate) {
      const r = await db.prepare(`SELECT ${BOOKED_COLS} FROM booked WHERE slot >= ? AND paid_at IS NOT NULL
        AND NOT (COALESCE(splitwise_state, '') = 'done' AND COALESCE(texts_state, '') = 'done') ORDER BY slot`).bind(fromDate).all();
      return r.results || [];
    },
    // A detail left out (an older page, or "Booked 2nd court" sending only courts) keeps its stored value.
    // A paid booking changes only by Kevin's phone, and only before the robot starts on Splitwise:
    // the check is in the statement, so no read-then-write race can get round it.
    async setBooked(slot, personId, venue, nowIso, details = {}, admin = false) {
      const r = await db.prepare(SET_BOOKED_SQL).bind(...bookedArgs(slot, personId, venue, nowIso, details, admin)).run();
      return (r.meta?.changes || 0) === 1;
    },
    // Kevin's phone books with the price (8 Nov 2026): both writes in one transaction, so the robot never
    // reads a booking between them. A batch rolls back only on an error, not on an update that matches
    // nothing; the two cannot split all the same, because the booking write is refused in exactly the
    // cases the price write is (the robot has started on Splitwise), so false always means nothing written.
    async setBookedPaid(slot, personId, venue, nowIso, details, pricePence, players) {
      const [a, b] = await db.batch([
        db.prepare(SET_BOOKED_SQL).bind(...bookedArgs(slot, personId, venue, nowIso, details, true)),
        db.prepare(SET_PAID_SQL).bind(slot, pricePence, JSON.stringify(players), nowIso),
      ]);
      return (a.meta?.changes || 0) === 1 && (b.meta?.changes || 0) === 1;
    },
    // A venue's booking email (8 Nov 2026): marks an hour only if nobody has, and pays it only if it has
    // no price yet, is at the email's venue and has its start and length. Each check is in its statement,
    // so a phone save landing at the same moment always wins.
    async markFromEmail(slot, personId, venue, details, nowIso) {
      const r = await db.prepare('INSERT INTO booked (slot, person_id, venue, start, minutes, courts, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6) ON CONFLICT(slot) DO NOTHING')
        .bind(slot, personId, venue, details.start, details.minutes, nowIso).run();
      return (r.meta?.changes || 0) === 1;
    },
    async payFromEmail(slot, venue, pricePence, players, nowIso) {
      const r = await db.prepare(`UPDATE booked SET price_pence = ?3, players = ?4, paid_at = ?5 WHERE slot = ?1 AND venue = ?2 AND paid_at IS NULL
        AND start IS NOT NULL AND minutes IS NOT NULL AND splitwise_state IS NULL AND texts_state IS NULL`)
        .bind(slot, venue, pricePence, JSON.stringify(players), nowIso).run();
      return (r.meta?.changes || 0) === 1;
    },
    // "Booked 2nd court": the court count alone, which the robot never reads, so anyone may set it.
    async setCourts(slot, courts) {
      const r = await db.prepare('UPDATE booked SET courts = ? WHERE slot = ?').bind(courts, slot).run();
      return (r.meta?.changes || 0) === 1;
    },
    async clearBooked(slot, admin = false) {
      const r = await db.prepare(`DELETE FROM booked WHERE slot = ?1 AND (paid_at IS NULL OR (?2 = 1 AND COALESCE(splitwise_state, '') IN ('', 'failed')))`)
        .bind(slot, admin ? 1 : 0).run();
      return (r.meta?.changes || 0) === 1;
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
    // One statement: count this hit for its client and minute, and say how many there have been.
    async countHit(key, nowIso) {
      const r = await db.prepare('INSERT INTO rate (key, n, created_at) VALUES (?1, 1, ?2) ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n')
        .bind(key, nowIso).first();
      return Number(r?.n || 0);
    },
    async pruneRate(beforeIso) {
      await db.prepare('DELETE FROM rate WHERE created_at < ?').bind(beforeIso).run();
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
    // A paid booking stays until the robot has done both steps (or a week has passed), so a court paid
    // for late in the evening still reaches Splitwise after midnight.
    async prune(today) {
      await db.batch([
        db.prepare('DELETE FROM votes WHERE slot < ?').bind(today),
        db.prepare(`DELETE FROM booked WHERE slot < ?1 AND (paid_at IS NULL OR slot < ?2
          OR (COALESCE(splitwise_state, '') = 'done' AND COALESCE(texts_state, '') = 'done'))`).bind(today, addDays(today, -PAID_KEEP_DAYS)),
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

// One search for the whole 14-day range. Three body formats, the one that worked last first:
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
    if (s.max !== undefined && !(posInt(s.max, 600) && s.max >= s.min)) return { error: `max must be a whole number of minutes, min or more (${t})` };
    starts[t] = s.max === undefined ? { courts: s.courts, min: s.min } : { courts: s.courts, min: s.min, max: s.max };
  }
  return { day: { status: 'ok', starts } };
}
export function cleanCourts(body, nowMs) {
  const readAtMs = Date.parse(typeof body.readAt === 'string' ? body.readAt : '');
  if (!Number.isFinite(readAtMs)) return { error: 'readAt must be a date and time' };
  if (Math.abs(nowMs - readAtMs) > READ_AT_SKEW_MS) return { error: 'readAt is not within 10 minutes of now' };
  if (!isObj(body.venues)) return { error: 'venues must be an object' };
  // St Ives and PDL every time. The University may be missing (a reader older than 29 Oct 2026);
  // saveMatchi then stores no University days under the new readAt, so it reads "couldn't check",
  // never an old read passed off as fresh.
  for (const code of MATCHI_VENUES) if (!isObj(body.venues[code])) return { error: `venues.${code} is needed` };
  const window = new Set(londonDates(nowMs));
  const venues = {};
  for (const [code, days] of Object.entries(body.venues)) {
    if (!MAC_VENUES.includes(code)) return { error: `unknown venue: ${code.slice(0, 10)}` };
    if (!isObj(days)) return { error: `${code} must be an object of dates` };
    venues[code] = {};
    for (const [date, day] of Object.entries(days)) {
      if (!DATE_RE.test(date) || !window.has(date)) continue;          // outside the 14 days: ignored
      const c = cleanDay(day);
      if (c.error) return { error: `${code} ${date}: ${c.error}` };
      venues[code][date] = c.day;
    }
    if (!Object.keys(venues[code]).length) return { error: `${code}: no dates inside the next ${DAYS} days` };
  }
  return { readAt: new Date(readAtMs).toISOString(), venues };
}
async function saveMatchi(repo, prev, clean) {
  // Every Mac venue starts empty: only what this read carries is stored under its readAt.
  const next = { readAt: clean.readAt, goodAt: Object.fromEntries(MAC_VENUES.map((c) => [c, prev?.goodAt?.[c] || null])), venues: Object.fromEntries(MAC_VENUES.map((c) => [c, {}])) };
  for (const [code, days] of Object.entries(clean.venues)) {
    next.venues[code] = days;
    if (Object.values(days).some((d) => d.status !== 'error')) next.goodAt[code] = clean.readAt;
  }
  await repo.setCache('matchi', JSON.stringify(next), clean.readAt);
  return next;
}

// ── Alerts ──
// ONE CLAIM, ONE ATTEMPT, AT MOST ONE DM, EVER. The row goes in with a "claimed" reply before the
// relay is called, and the row is never deleted once the relay has been called: its reply, a
// non-200 (a 502 can arrive after Slack has posted, so a retry could double), a timeout or an error
// each overwrite the claim with a final marker. A Worker stopped between the claim and the relay
// call leaves the slot claimed: a miss, accepted over a second DM.
// Claims stop 5 s after the BACKGROUND WORK started (bgStart: before a lazy Pulse read, or when a
// request handed the check to waitUntil), so no claim is ever made close to the 30 s limit where
// the Worker could be stopped before its relay call. Slots left over wait for the next check.
export async function checkAlerts(state, env, repo, nowMs, sleep = realSleep, bgStart = Date.now(), clock = Date.now) {
  const nowIso = new Date(nowMs).toISOString();
  if (!env.RELAY || !env.RELAY_KEY) {
    if (state.ready.length) console.error('padel: alert check skipped, relay not configured');
    return [];
  }
  const due = decideAlerts(state, await repo.alertSlots(state.today));
  const cfg = venueConfig(env);
  const sent = [];
  for (const r of due) {
    if (clock() - bgStart >= CLAIM_BUDGET_MS) break;
    const claimed = await repo.claimAlert(r.slot, r.names.join(', '), r.venues.map((v) => v.code).join(','), nowIso);
    if (!claimed) continue;
    let res;
    try {
      res = await withTimeout(env.RELAY.fetch(new Request(RELAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Relay-Key': env.RELAY_KEY },
        body: JSON.stringify({ text: alertText(r, cfg, env.PAGE_URL || 'https://padel.runpreneur.org.uk/', Date.parse(nowIso)).slice(0, 4000), recipients: [env.ALERT_TO || 'kevin@runpreneur.org.uk'] }),
      })), RELAY_TIMEOUT_MS);
    } catch (e) {
      // No answer in 20 s, or a dropped call: the DM may or may not have gone.
      const timedOut = e && e.name === 'TimeoutError';
      console.error('padel: alert DM unanswered, not retried', r.slot, String(e));
      await writeReply(repo, r.slot, JSON.stringify(timedOut ? { timeout: true, at: nowIso } : { error: String(e && e.message || e).slice(0, 200), at: nowIso }), sleep);
      continue;
    }
    // Every reply body is read under the 5 s limit.
    let body;
    try { body = await withTimeout(res.text(), RELAY_BODY_TIMEOUT_MS); } catch (e) { body = null; }
    if (res.status !== 200) {
      console.error('padel: alert DM refused, not retried', r.slot, `relay HTTP ${res.status}: ${String(body ?? '(reply unreadable)').slice(0, 300)}`);
      await writeReply(repo, r.slot, JSON.stringify({ relay: res.status, body: String(body ?? '(reply unreadable)').slice(0, 200), at: nowIso }), sleep);
      continue;
    }
    sent.push(r.slot);
    if (body === null) console.error('padel: DM sent, its reply body was not read', r.slot);
    await writeReply(repo, r.slot, body === null ? RELAY_PENDING : (body || '(empty reply)'), sleep);
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
// else outside the next 14 days or the hours 07 to 21 refuses the whole list.
export function cleanSlots(raw, dates) {
  if (!Array.isArray(raw)) return { error: 'slots must be a list' };
  if (raw.length > (dates.length + 1) * HOURS.length) return { error: 'too many slots' };
  const ok = new Set(dates);
  const out = new Set();
  for (const s of raw) {
    const m = SLOT_RE.exec(String(s));
    if (m && m[1] < dates[0] && HH.has(m[2])) continue;
    if (!m || !ok.has(m[1]) || !HH.has(m[2])) return { error: `Not an hour in the next ${DAYS} days: ${String(s).slice(0, 20)}` };
    out.add(m[0]);
  }
  return { slots: [...out].sort() };
}
// A booking's details: start on the hour or half hour inside its slot, a length in whole minutes
// (up to RUN_CAP_MIN), one court or two. Each is optional: an older page sends none.
export function cleanBooking(body, slot) {
  const hh = slot.slice(-2);
  const out = {};
  if (body.start !== undefined) {
    if (typeof body.start !== 'string' || !/^\d\d:(00|30)$/.test(body.start) || body.start.slice(0, 2) !== hh) return { error: `start must be ${hh}:00 or ${hh}:30` };
    out.start = body.start;
  }
  if (body.minutes !== undefined) {
    if (!posInt(body.minutes, RUN_CAP_MIN) || body.minutes % 5 !== 0) return { error: `minutes must be a multiple of 5, up to ${RUN_CAP_MIN}` };
    out.minutes = body.minutes;
  }
  if (body.courts !== undefined) {
    if (body.courts !== 1 && body.courts !== 2) return { error: 'courts must be 1 or 2' };
    out.courts = body.courts;
  }
  return out;
}

// Booked and paid: a price in pounds (to the penny) and 1 to 16 distinct players who are on the list.
export function cleanPaid(body, people) {
  const raw = body.price;
  const price = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,4}(\.\d{1,2})?$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isFinite(price) || Math.round(price * 100) < 1 || price > MAX_PRICE_POUNDS) return { error: `The price is a number of pounds, up to ${MAX_PRICE_POUNDS}` };
  if (!Array.isArray(body.players) || !body.players.length || body.players.length > 16) return { error: 'Pick who is playing (1 to 16 people)' };
  const ids = [...new Set(body.players.map(intId))];
  if (ids.some((id) => !id) || ids.length !== body.players.length) return { error: 'Each player is picked once, from the list' };
  const known = new Set(people.map((p) => p.id));
  if (ids.some((id) => !known.has(id))) return { error: 'One of those players is not on the list' };
  return { pricePence: Math.round(price * 100), players: ids };
}
export const isAdmin = (request, env) => keyOk(request.headers.get('X-Admin-Key'), env.ADMIN_KEY);

// ── Scores and levels (Stage 2, 27 Nov 2026) ──
const levelMap = (rows, today) => new Map(rows.map((l) => [l.id, decayedLevel(l.level, l.level_active_at, today)]));
// A score: checked, its changes worked out from the four players' levels as they stand (after any
// 90-day drop, which the score then settles), and saved with those levels in one transaction.
async function addScore(repo, body, dates, nowIso, admin) {
  const today = dates[0];
  const [people, rows] = await Promise.all([repo.listPeople(), repo.listLevels()]);
  const levels = levelMap(rows, today);
  const clean = cleanScore(body, people, levels, dates, admin);
  if (clean.error) return fail(clean.error, clean.status || 400);
  if (await repo.getMatchByKey(clean.key)) return null;                    // the same form sent twice: already in
  const base = scoreFingerprint(clean.a, clean.b, clean.sets);
  const nowMs = Date.parse(nowIso);
  const fingerprint = `${base}#${Math.floor(nowMs / SCORE_REPEAT_MS)}`;
  const recentMatches = await repo.listMatches(addDays(today, -RELIABLE_DAYS));
  if (recentMatches.some((m) => m.playedOn === clean.playedOn && String(m.fingerprint || '').split('#')[0] === base && Math.abs(nowMs - Date.parse(m.enteredAt)) < SCORE_REPEAT_MS)) return fail('That score is already in', 409);
  const recent = countRecent(recentMatches, addDays(today, -RELIABLE_DAYS));
  const side = (ids) => ids.map((id) => ({ id, level: levels.get(id), recent: recent.get(id) || 0 }));
  const result = clean.rated ? levelChanges({ a: side(clean.a), b: side(clean.b), sets: clean.sets }) : { changes: {} };
  const byId = new Map(rows.map((l) => [l.id, l]));
  // Each level moves by the score's change, after any 90-day drop the score now settles (taken once).
  const updates = Object.entries(result.changes).map(([id, d]) => {
    const n = Number(id);
    return { id: n, settle: r3(levels.get(n) - byId.get(n).level), readActive: byId.get(n).level_active_at, delta: d, matches: 1, activeAt: clean.playedOn };
  });
  try {
    await repo.addScore({ ...clean, changes: result.changes, fingerprint }, updates, nowIso);
  } catch (e) {
    if (await repo.getMatchByKey(clean.key)) return null;                  // a double tap that raced: one score
    if (await repo.getLiveMatchByFingerprint(clean.playedOn, fingerprint)) return fail('That score is already in', 409);   // the other pair sent it at the same moment
    throw e;
  }
  return null;
}
// Kevin's phone: a wrong score comes off, and every change it (and its feedback) made is reversed. A
// 90-day drop the score settled stays settled, and a level Kevin set by hand after the score is moved
// by the reversal too: delete a wrong score first, then set the level.
async function deleteScore(repo, id, nowIso) {
  for (let tries = 0; tries < 4; tries += 1) {
    const m = id ? await repo.getMatch(id) : null;
    if (!m || m.deletedAt) return tries ? null : fail('No such score', 404);
    const ids = new Set([...Object.keys(m.changes), ...Object.keys(m.feedback)].map(Number));
    const updates = [...ids].map((pid) => ({ id: pid, delta: -r3((m.changes[pid] || 0) + (m.feedback[pid] || 0)), matches: m.changes[pid] != null ? -1 : 0 }));
    const token = `${nowIso}#${Math.random().toString(36).slice(2, 10)}`;
    await repo.deleteScore(m.id, token, m.feedbackRaw, updates);
    const after = await repo.getMatch(m.id);
    if (after && after.deletedAt) return null;        // ours, or another delete's: either way reversed once
  }
  return fail('The score kept changing: try again', 409);
}
// Peer feedback: one of the four marks the others within 24 hours of a rated score. A player with 2
// matching votes (higher, or lower) moves 0.05 once for that score; a vote changed later moves it back.
async function addFeedback(repo, body, nowMs, nowIso) {
  const m = intId(body.match_id) ? await repo.getMatch(intId(body.match_id)) : null;
  if (!m || m.deletedAt) return fail('No such score', 404);
  if (!m.rated || !matchResult(m.sets).winner) return fail('This score changed no level, so it takes no feedback', 400);
  if (nowMs >= Date.parse(m.enteredAt) + FEEDBACK_MS) return fail('Feedback closes 24 hours after the score goes in', 409);
  const four = [...m.a, ...m.b];
  const from = intId(body.from_id);
  if (!from || !four.includes(from)) return fail('Only someone who played can give feedback', 400);
  const raw = body.votes && typeof body.votes === 'object' && !Array.isArray(body.votes) ? Object.entries(body.votes) : [];
  const votes = raw.map(([k, v]) => [intId(k), v]);
  if (!votes.length || new Set(votes.map(([about]) => about)).size !== votes.length
    || votes.some(([about, v]) => !about || about === from || !four.includes(about) || !VOTES.includes(v))) return fail('Mark the other three players: higher, expected or lower', 400);
  await repo.putVotes(m.id, from, votes, nowIso);
  // Then the effect of ALL the votes now stored, swapped in from the version read (compare and set). Two
  // players sending at the same moment: the one whose swap loses reads again and settles it.
  for (let tries = 0; tries < 4; tries += 1) {
    const cur = await repo.getMatch(m.id);
    if (!cur || cur.deletedAt) return null;
    const all = await repo.listFeedback([m.id]);
    const want = {};
    for (const pid of four) {
      const about = all.filter((v) => v.about_id === pid);
      const w = about.filter((v) => v.vote === 'higher').length >= 2 ? FEEDBACK_STEP : about.filter((v) => v.vote === 'lower').length >= 2 ? -FEEDBACK_STEP : 0;
      if (w) want[pid] = w;
    }
    // What the level can really move (0 to 7), so the amount recorded is the amount a delete takes back.
    const levelNow = new Map((await repo.listLevels()).map((l) => [l.id, l.level]));
    const next = {};
    const diffs = [];
    for (const pid of four) {
      const had = cur.feedback[pid] || 0;
      const lvl = levelNow.get(pid);
      const d = lvl == null ? 0 : r3(clampLevel(lvl + (want[pid] || 0) - had) - lvl);
      if (r3(had + d)) next[pid] = r3(had + d);
      if (d) diffs.push([pid, d]);
    }
    if (!diffs.length) return null;
    const toRaw = JSON.stringify({ ...next, _v: Math.random().toString(36).slice(2, 10) });
    await repo.swapFeedback(m.id, cur.feedbackRaw, toRaw, diffs.map(([pid, d]) => ({ id: pid, delta: d })));
    if ((await repo.getMatch(m.id)).feedbackRaw === toRaw) return null;
  }
  return null;
}

// ── Match day (Stage 3, 28 Nov 2026) ──
// The players on a booked hour: the paid list when the price is in, else the app's own pick for that hour.
async function bookingPlayers(repo, slot, dates) {
  const b = await repo.getBooked(slot);
  if (!b || !b.venue) return null;
  const paid = paidOf(b).players;
  if (paid.length) return { players: paid, courts: b.courts || 1 };
  return { players: playersFor(slot, b.venue, b.person_id, await repo.listVotes(dates[0]), await repo.listPeople()), courts: b.courts || 1 };
}
async function handleMatchDay(body, repo, dates, nowIso, admin, rng = Math.random) {
  const slot = String(body.slot || '');
  const m = SLOT_RE.exec(slot);
  if (!m || m[1] !== dates[0]) return fail('Match day is for a booked hour today', 400);
  const booking = await bookingPlayers(repo, slot, dates);
  if (!booking) return fail('That hour is not booked', 404);
  const who = intId(body.person_id);
  if (!admin && (!who || !booking.players.includes(who))) return fail('Only someone playing can run match day', 400);
  const today = dates[0];
  const [rows, recentMatches, sessions] = await Promise.all([repo.listLevels(), repo.listMatches(addDays(today, -RELIABLE_DAYS)), repo.listSessions([slot])]);
  const levels = levelMap(rows, today);
  const levelOf = (id) => levels.get(id) ?? null;
  const started = sessions.some((x) => x.kind === 'kc' && (x.state.games || 0) > 0);
  const action = body.action;
  if (action === 'start') {
    if (started) return fail('Kings and challengers has started: the teams stay as they are', 409);
    const mode = body.mode === 'shuffle' ? 'shuffle' : 'fair';
    const plan = formatPlan(booking.players.length, booking.courts);
    if (!plan.groups.length) return fail(plan.note, 400);
    const partners = partnerCounts(recentMatches, addDays(today, -PARTNER_DAYS));
    const take = booking.players.slice(0, MATCH_DAY_MAX);
    const split = splitGroups(take, plan.groups.map((g) => g.size), levelOf, mode, rng);
    const groups = plan.groups.map((g, i) => ({
      no: i + 1, kind: g.kind,
      state: g.kind === 'match' ? { players: split[i], ...bestPairs(split[i], levelOf, partners, mode, rng), mode, note: plan.note } : { ...kcStart(split[i], levelOf, partners, mode, rng), mode, note: plan.note },
    }));
    await repo.replaceSessions(slot, groups, nowIso);
    return null;
  }
  const session = sessions.find((x) => x.no === intId(body.group));
  if (action === 'swap') {
    if (started) return fail('Kings and challengers has started: the teams stay as they are', 409);
    const a = intId(body.a), b = intId(body.b);
    const where = (id) => sessions.find((x) => (x.state.players || []).includes(id));
    const sa = where(a), sb = where(b);
    if (!a || !b || a === b || !sa || !sb) return fail('Pick two players on match day to swap', 400);
    const swap = (list) => (list || []).map((id) => (id === a ? b : id === b ? a : id));
    const next = (x) => ({ ...x.state, players: swap(x.state.players), ...(x.kind === 'match' ? { a: swap(x.state.a), b: swap(x.state.b) } : { kings: swap(x.state.kings), challengers: swap(x.state.challengers), queue: swap(x.state.queue), points: Object.fromEntries(swap(x.state.players).map((id) => [id, 0])) }) });
    for (const x of sa === sb ? [sa] : [sa, sb]) if (!(await repo.setSession(x.id, x.version, next(x), nowIso))) return fail('Someone else changed match day: here is the latest', 409);
    return null;
  }
  if (!session || session.kind !== 'kc') return fail('Pick a Kings and challengers court', 400);
  const seen = Number.isInteger(body.version) ? body.version : intId(body.version);
  if (seen !== session.version) return fail('Someone else just recorded a game: here is the latest', 409);
  if (action === 'kc-game') {
    const step = kcApply(session.state, body.winner, intId(body.lost_by));
    if (step.error) return fail(step.error, 400);
    const recent = countRecent(recentMatches, addDays(today, -RELIABLE_DAYS));
    const side = (ids) => ids.map((id) => ({ id, level: levelOf(id), recent: recent.get(id) || 0 }));
    const rated = [...step.winners, ...step.losers].every((id) => levelOf(id) != null);
    let changes = {};
    if (rated) {
      const soFar = new Map();
      for (const g of await repo.listSessionGames(session.id)) for (const [id, d] of Object.entries(g.changes)) soFar.set(Number(id), (soFar.get(Number(id)) || 0) + d);
      changes = capSession(pairChanges({ win: side(step.winners), lose: side(step.losers), margin: 1, weight: KC_WEIGHT }), soFar);
    }
    const byId = new Map(rows.map((l) => [l.id, l]));
    const updates = Object.entries(changes).map(([id, d]) => {
      const n = Number(id);
      return { id: n, settle: r3(levels.get(n) - byId.get(n).level), readActive: byId.get(n).level_active_at, delta: d, matches: 1, activeAt: today };
    });
    const key = `kc-${session.id}-v${session.version}`;
    const state = { ...step.state, history: step.state.history.map((h, i) => (i === step.state.history.length - 1 ? { ...h, key } : h)) };
    try {
      await repo.addKcGame(session.id, session.version, state, { key, playedOn: today, a: step.winners, b: step.losers, enteredBy: who || 0, changes }, updates, nowIso);
    } catch (e) {
      if (await repo.getMatchByKey(key)) return fail('Someone else just recorded that game: here is the latest', 409);
      throw e;
    }
    return null;
  }
  if (action === 'kc-undo') {
    const hist = session.state.history || [];
    if (!hist.length) return fail('No game to undo', 400);
    const last = hist[hist.length - 1];
    const game = last.key ? await repo.getMatchByKey(last.key) : null;
    const state = { ...session.state, ...last, history: hist.slice(0, -1) };
    delete state.key;
    const token = `${nowIso}#${Math.random().toString(36).slice(2, 10)}`;
    const updates = game && !game.deletedAt ? Object.entries(game.changes).map(([id, d]) => ({ id: Number(id), delta: -d, matches: -1 })) : [];
    await repo.undoKcGame(session.id, session.version, state, game ? game.id : 0, token, updates, nowIso);
    return null;
  }
  return fail('Unknown match day action', 400);
}
// Everyone's page: today's booked hours that have a match day, as the phones show them.
async function loadMatchDay(repo, bookedSlots) {
  const sessions = await repo.listSessions(bookedSlots);
  const out = {};
  for (const x of sessions) {
    const st = x.state;
    const g = x.kind === 'match'
      ? { no: x.no, kind: 'match', version: x.version, players: st.players || [], a: st.a || [], b: st.b || [], mode: st.mode }
      : { no: x.no, kind: 'kc', version: x.version, players: st.players || [], kings: st.kings || [], challengers: st.challengers || [], queue: st.queue || [], streak: st.streak || 0, points: st.points || {}, games: st.games || 0, canUndo: (st.history || []).length > 0, mode: st.mode };
    (out[x.slot] || (out[x.slot] = { note: st.note || '', groups: [] })).groups.push(g);
  }
  return out;
}

async function handleAdmin(body, env, repo, nowMs, dates, nowIso) {
  if (body.action === 'name') {
    const id = intId(body.id);
    if (!id || !(await repo.getPerson(id))) return fail('No such person', 404);
    let realName = null;
    if (String(body.real_name ?? '').trim()) {
      const clean = cleanName(body.real_name);
      if (clean.error) return fail(clean.error, 400);
      realName = clean.name;
      // Two people shown with one name would also make that name find the wrong one.
      const f = foldName(realName);
      if ((await repo.listPeople()).some((p) => p.id !== id && (foldName(p.name) === f || (p.realName && foldName(p.realName) === f)))) return fail('Someone else already has that name', 409);
    }
    await repo.setRealName(id, realName);
  } else if (body.action === 'level') {
    const id = intId(body.id);
    if (!id || !(await repo.getPerson(id))) return fail('No such person', 404);
    const level = cleanLevel(body.level);
    if (level == null) return fail('A level is a number from 0 to 7', 400);
    await repo.setLevel(id, level, dates[0]);
  } else if (body.action === 'score-delete') {
    const r = await deleteScore(repo, intId(body.id), nowIso);
    if (r) return r;
  } else if (body.action === 'retry') {
    // A retry may be for a booking from the last week (paid late, the robot ran after midnight).
    const m = SLOT_RE.exec(String(body.slot || ''));
    if (!m || m[1] < addDays(dates[0], -PAID_KEEP_DAYS) || m[1] > dates[dates.length - 1]) return fail('Not a booking from the last week', 400);
    if (!PAID_STEPS.includes(body.step) || !(await repo.markStep(m[0], body.step, 'retry', null, nowIso))) return fail('Only a step that failed can be tried again', 409);
  } else if (['paid', 'unpaid'].includes(body.action)) {
    const clean = cleanSlots([body.slot], dates);
    if (clean.error || !clean.slots.length) return fail(clean.error || 'That hour has passed', 400);
    const slot = clean.slots[0];
    const b = await repo.getBooked(slot);
    if (!b || !b.venue || !b.start || !b.minutes) return fail('Mark the hour as booked first, with its venue, start and length', 409);
    if (body.action === 'paid') {
      const paid = cleanPaid(body, await repo.listPeople());
      if (paid.error) return fail(paid.error, 400);
      if (!(await repo.setPaid(slot, paid.pricePence, paid.players, nowIso))) return fail('This booking is already with the robot or in Splitwise. Change it in Splitwise.', 409);
    } else if (!(await repo.clearPaid(slot))) {
      return fail('This booking is already with the robot or in Splitwise. Change it in Splitwise.', 409);
    }
  } else {
    return fail('Unknown action', 400);
  }
  return json({ ...(await loadState(env, repo, nowMs, true)), admin: true });
}

// The robot's setup check (Kevin, 27 Nov 2026: adding a player must not "cock up every time"): per
// player on the list, ready, missing (with what to fix) or unchecked. Players removed since the robot
// read the list are dropped; anything else malformed refuses the whole post.
export const SETUP_STATES = ['ready', 'missing', 'unchecked'];
export function cleanSetup(body, people) {
  const raw = body && body.people;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'people is needed' };
  const known = new Set(people.map((p) => p.id));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const id = intId(k);
    if (!id) return { error: 'Each player is named by id' };
    if (!v || !SETUP_STATES.includes(v.state)) return { error: 'Each player needs a state: ready, missing or unchecked' };
    if (!known.has(id)) continue;
    const notes = Array.isArray(v.notes) ? v.notes.filter((n) => typeof n === 'string' && n.trim()).slice(0, 4).map((n) => n.trim().slice(0, 120)) : [];
    out[id] = { state: v.state, notes };
  }
  return { people: out };
}
async function handleRobotSetup(request, env, repo, nowMs) {
  if (!keyOk(request.headers.get('X-Robot-Key'), env.ROBOT_KEY)) return fail('Robot key needed', 401);
  const people = await repo.listPeople();
  if (request.method === 'GET') return json({ ok: true, people: people.map((p) => ({ id: p.id, name: p.realName || p.name, nick: p.name })) });
  if (request.method !== 'POST') return fail('Not found', 404);
  const parsed = await readBody(request, MAX_COURTS_BODY);
  if (parsed.error) return fail(parsed.error, parsed.status);
  const clean = cleanSetup(parsed.body, people);
  if (clean.error) return fail(clean.error, 400);
  const nowIso = new Date(nowMs).toISOString();
  await repo.setCache('setup', JSON.stringify({ at: nowIso, people: clean.people }), nowIso);
  return json({ ok: true, saved: Object.keys(clean.people).length });
}
// Kevin's phone only: the robot's last setup check, or null before the first one.
async function loadSetup(repo) {
  const raw = await repo.getCache('setup');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { console.error('padel: setup cache unreadable', String(e)); return null; }
}

// The Mac robot's view of a paid booking: everything it needs for the Splitwise entry and the texts.
async function handleRobotPaid(request, env, repo, nowMs) {
  if (!keyOk(request.headers.get('X-Robot-Key'), env.ROBOT_KEY)) return fail('Robot key needed', 401);
  const nowIso = new Date(nowMs).toISOString();
  if (request.method === 'GET') {
    const cfg = venueConfig(env);
    const people = new Map((await repo.listPeople()).map((p) => [p.id, p]));
    const rows = await repo.listPaidPending(addDays(londonDates(nowMs)[0], -PAID_KEEP_DAYS));
    const bookings = rows.map((b) => {
      const [, date] = SLOT_RE.exec(b.slot);
      const paid = paidOf(b);
      return {
        slot: b.slot, date, day: dayLabel(date), venue: { code: b.venue, short: cfg[b.venue]?.short || b.venue, label: cfg[b.venue]?.label || b.venue },
        start: b.start, minutes: b.minutes, pricePence: paid.price, paidAt: b.paid_at, splitwise: paid.splitwise, texts: paid.texts,
        players: paid.players.map((id) => { const p = people.get(id); return p ? { id, name: p.realName || p.name, nick: p.name } : { id, name: null }; }),
      };
    });
    return json({ ok: true, bookings });
  }
  if (request.method !== 'POST') return fail('Not found', 404);
  const parsed = await readBody(request);
  if (parsed.error) return fail(parsed.error, parsed.status);
  const { slot, step, state } = parsed.body;
  if (typeof slot !== 'string' || !SLOT_RE.test(slot) || !PAID_STEPS.includes(step) || !['claimed', 'done', 'failed', 'resume'].includes(state)) return fail('slot, step and state are needed', 400);
  const note = typeof parsed.body.note === 'string' ? parsed.body.note.slice(0, 200) : null;
  const paidAt = typeof parsed.body.paidAt === 'string' ? parsed.body.paidAt : null;
  if (state === 'claimed' && !paidAt) return fail('A claim names the paidAt it read', 400);
  return json({ ok: true, changed: await repo.markStep(slot, step, state, note, nowIso, paidAt) });
}

// Who plays, as the app has it at that moment: everyone who said they can play that hour and can get to
// that venue, and whoever booked it. The page's price boxes tick the same people (defaultPlayers there).
export function playersFor(slot, venue, bookerId, votes, people) {
  const can = new Map(people.map((p) => [p.id, p.venues.includes(venue)]));
  const ids = votes.filter((v) => v.slot === slot && can.get(v.person_id)).map((v) => v.person_id);
  if (bookerId && can.has(bookerId) && !ids.includes(bookerId)) ids.push(bookerId);
  return ids;
}

// A venue's booking email, read on the Mac (scripts/padel-emails.py), carried out by the robot (Kevin,
// 8 Nov 2026: "do it all from the booking confirmation email and the information on the app at that
// time"). An hour nobody marked is marked booked by Kevin; with a price, and no price yet, it is paid,
// players from the votes at that moment. A booking someone already marked keeps its venue and times,
// and a price already there is never replaced: whatever was typed on a phone wins.
async function handleRobotBooking(request, env, repo, nowMs) {
  if (!keyOk(request.headers.get('X-Robot-Key'), env.ROBOT_KEY)) return fail('Robot key needed', 401);
  if (request.method !== 'POST') return fail('Not found', 404);
  const parsed = await readBody(request);
  if (parsed.error) return fail(parsed.error, parsed.status);
  const body = parsed.body;
  const dates = londonDates(nowMs);
  const nowIso = new Date(nowMs).toISOString();
  const clean = cleanSlots([body.slot], dates);
  if (clean.error || !clean.slots.length) return fail(clean.error || 'That hour has passed', 400);
  const slot = clean.slots[0];
  if (!VENUES.includes(body.venue)) return fail('Unknown venue', 400);
  const details = cleanBooking({ start: body.start, minutes: body.minutes }, slot);
  if (details.error || !details.start || !details.minutes) return fail(details.error || 'start and minutes are needed', 400);
  const id = intId(body.person_id);
  if (!id || !(await repo.getPerson(id))) return fail('No such person', 404);
  const pricePence = body.price_pence == null ? null : Number(body.price_pence);
  if (pricePence !== null && !(Number.isInteger(pricePence) && pricePence >= 1 && pricePence <= MAX_PRICE_POUNDS * 100)) return fail('price_pence is a whole number of pence', 400);
  const booked = await repo.markFromEmail(slot, id, body.venue, details, nowIso);
  const existing = await repo.getBooked(slot);
  let paid = false;
  // The email's price is for the email's court: a booking marked at another venue is never paid from it.
  if (existing && pricePence !== null && !existing.paid_at && existing.venue === body.venue) {
    const players = playersFor(slot, existing.venue, existing.person_id, await repo.listVotes(dates[0]), await repo.listPeople());
    if (players.length) paid = await repo.payFromEmail(slot, body.venue, pricePence, players, nowIso);
  }
  const now = existing || {};
  return json({ ok: true, booked, paid, venue: now.venue || null, alreadyPaid: !!(now.paid_at && !paid) });
}

// Paid bookings from the last week the robot has not finished: the page lists them for Kevin's Retry.
async function earlierPaid(env, repo, today) {
  const cfg = venueConfig(env);
  return (await repo.listPaidPending(addDays(today, -PAID_KEEP_DAYS))).filter((b) => b.slot < today).map((b) => {
    const [, date] = SLOT_RE.exec(b.slot);
    return { slot: b.slot, day: dayLabel(date), venue: cfg[b.venue]?.short || b.venue, start: b.start, minutes: b.minutes, paid: paidOf(b) };
  });
}

async function loadState(env, repo, nowMs, admin = false) {
  const dates = londonDates(nowMs);
  const [{ pulse, availability }, people, votes, booked] = await Promise.all([
    loadAvailability(repo), repo.listPeople(), repo.listVotes(dates[0]), repo.listBooked(dates[0]),
  ]);
  const state = computeState({ people, votes, booked, availability, dates, nowMs, cfg: venueConfig(env) });
  state.availability.stale = pulseDue(pulse, nowMs);
  state.earlier = await earlierPaid(env, repo, dates[0]);
  state.levels = await loadLevels(repo, dates[0], nowMs);
  state.matchday = await loadMatchDay(repo, Object.keys(state.booked).filter((slot) => slot.startsWith(dates[0] + '|')));
  if (admin) state.setup = await loadSetup(repo);
  return state;
}
// Everyone's page: the league table and the last month's scores.
async function loadLevels(repo, today, nowMs) {
  const [levels, matches] = await Promise.all([repo.listLevels(), repo.listMatches(addDays(today, -RELIABLE_DAYS))]);
  const voters = await repo.listFeedback(matches.filter((m) => m.playedOn >= addDays(today, -30)).map((m) => m.id));
  return computeLevels({ levels, matches, voters: voters.map((v) => ({ match_id: v.match_id, from_id: v.from_id })), today, nowMs });
}

// Read Pulse (when due), then run the alert check on the fresh state. Never throws: it runs inside
// waitUntil, where a throw would vanish.
async function refreshAndAlert(env, repo, nowMs, fetchImpl, clock, sleep) {
  const bgStart = Date.now();                      // the background work starts here, before the Pulse read
  try {
    const read = await refreshPulse(env, repo, nowMs, fetchImpl);
    const now = clock();
    await checkAlerts(await loadState(env, repo, now), env, repo, now, sleep, bgStart);
    return read;
  } catch (e) {
    console.error('padel: refresh failed', String(e && e.stack || e));
    return false;
  }
}
// Called as ctx.waitUntil(alertSafely(...)): the background work starts now.
async function alertSafely(state, env, repo, nowMs, sleep) {
  const bgStart = Date.now();
  try { return await checkAlerts(state, env, repo, nowMs, sleep, bgStart); } catch (e) { console.error('padel: alert check failed', String(e && e.stack || e)); return []; }
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
  await repo.pruneRate(new Date(nowMs - RATE_KEEP_MS).toISOString());
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
    const caller = callerKey(request.headers.get('CF-Connecting-IP'));
    if (env.WRITE_LIMIT) {
      const { success } = await env.WRITE_LIMIT.limit({ key: caller });
      if (!success) return fail('slow down', 429);
    }
    let hits = 0;
    try {
      hits = await repo.countHit(`${caller}|${Math.floor(nowMs / 60000)}`, new Date(nowMs).toISOString());
    } catch (e) {
      console.error('padel: rate count failed, request let through', String(e));
    }
    if (hits > RATE_LIMIT) return fail('slow down', 429);
    if (path === '/api/health' && request.method === 'GET') return json({ ok: true, version: VERSION });
    if (path === '/api/courts') return await handleCourts(request, env, ctx, repo, nowMs, fetchImpl, clock, sleep);
    if (path === '/api/robot/paid') return await handleRobotPaid(request, env, repo, nowMs);
    if (path === '/api/robot/booking') return await handleRobotBooking(request, env, repo, nowMs);
    if (path === '/api/robot/setup') return await handleRobotSetup(request, env, repo, nowMs);
    const admin = isAdmin(request, env);

    if (path === '/api/state' && request.method === 'GET') {
      const state = await loadState(env, repo, nowMs, admin);
      if (state.availability.stale && await repo.claimRefresh(nowMs, REFRESH_GUARD_MS)) {
        ctx.waitUntil(refreshAndAlert(env, repo, nowMs, fetchImpl, clock, sleep));
      }
      return json({ ...state, admin });
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
      const state = await loadState(env, repo, now, admin);
      // The alert check runs in waitUntil: a caller going away cannot stop it between claim and reply.
      ctx.waitUntil(alertSafely(state, env, repo, now, sleep));
      return json({ ...state, refreshed, admin });
    }

    const parsed = await readBody(request);
    if (parsed.error) return fail(parsed.error, parsed.status);
    const body = parsed.body;

    if (path === '/api/admin') {
      if (!admin) return fail("Only Kevin's phone can do that", 401);
      return await handleAdmin(body, env, repo, nowMs, dates, nowIso);
    }

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
      // The name a player gave themselves, or the real name Kevin set: either finds the same person.
      const fold = foldName(clean.name);
      const found = people.find((p) => foldName(p.name) === fold || (p.realName && foldName(p.realName) === fold));
      if (found) return json(found);
      if (people.length >= MAX_PEOPLE) return fail('The group list is full. Ask Kevin.', 409);
      const person = await repo.addPerson(clean.name, nowIso);
      if (!person) return fail('Could not save that name. Try again.', 500);
      return json(person);
    }

    if (path === '/api/level') {
      const id = intId(body.person_id);
      const level = cleanLevel(body.level);
      if (!id || !(await repo.getPerson(id))) return fail('No such person', 404);
      if (level == null) return fail('A level is a number from 0 to 7', 400);
      if (!(await repo.setLevel(id, level, dates[0], true))) return fail('Your level has moved with your scores now: only Kevin can change it', 409);
      return json({ ...(await loadState(env, repo, nowMs, admin)), admin });
    }
    if (path === '/api/score') {
      const r = await addScore(repo, body, dates, nowIso, admin);
      if (r) return r;
      return json({ ...(await loadState(env, repo, nowMs, admin)), admin });
    }
    if (path === '/api/matchday') {
      const r = await handleMatchDay(body, repo, dates, nowIso, admin);
      if (r) return r;
      return json({ ...(await loadState(env, repo, nowMs, admin)), admin });
    }
    if (path === '/api/feedback') {
      const r = await addFeedback(repo, body, nowMs, nowIso);
      if (r) return r;
      return json({ ...(await loadState(env, repo, nowMs, admin)), admin });
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
      const state = await loadState(env, repo, nowMs, admin);
      // The save answers at once; the DM (up to 20 s on the relay) goes in the background.
      ctx.waitUntil(alertSafely(state, env, repo, nowMs, sleep));
      return json({ ...state, admin });
    }

    if (path === '/api/booked') {
      const clean = cleanSlots([body.slot], dates);
      if (clean.error || !clean.slots.length) return fail(clean.error || 'That hour has passed', 400);
      const slot = clean.slots[0];
      // A paid booking is Kevin's to change, and nobody's once the robot has started on Splitwise:
      // a removed or re-marked booking would orphan its Splitwise entry or send a second one.
      const existing = await repo.getBooked(slot);
      const paidRefusal = admin ? 'This booking is with the robot or in Splitwise. Change it in Splitwise.' : "This booking is paid. Only Kevin's phone can change it.";
      if (body.booked === false) {
        if (existing && !(await repo.clearBooked(slot, admin))) return fail(paidRefusal, 409);
      } else if (body.booked === true) {
        const id = intId(body.person_id);
        if (!id || !(await repo.getPerson(id))) return fail('No such person', 404);
        if (!VENUES.includes(body.venue)) return fail('Unknown venue', 400);
        const details = cleanBooking(body, slot);
        if (details.error) return fail(details.error, 400);
        // Kevin's phone sends the price and the players with the booking (8 Nov 2026: one Save does
        // everything). Checked before anything is written, so a bad price never leaves half a save.
        const withPaid = body.price !== undefined || body.players !== undefined;
        if (withPaid && !admin) return fail("The price goes in on Kevin's phone", 403);
        const paid = withPaid ? cleanPaid(body, await repo.listPeople()) : null;
        if (paid && paid.error) return fail(paid.error, 400);
        // A price needs the start and the length, as Booked and paid always did: the robot's entry and texts say them.
        if (paid && !((details.start ?? existing?.start) && (details.minutes ?? existing?.minutes))) return fail('Mark the hour as booked with its start and length', 400);
        const courtsOnly = !paid && existing?.paid_at && details.courts !== undefined && details.start === undefined && details.minutes === undefined && body.venue === existing.venue;
        if (courtsOnly) await repo.setCourts(slot, details.courts);
        else if (paid) { if (!(await repo.setBookedPaid(slot, id, body.venue, nowIso, details, paid.pricePence, paid.players))) return fail(paidRefusal, 409); }
        else if (!(await repo.setBooked(slot, id, body.venue, nowIso, details, admin))) return fail(paidRefusal, 409);
      } else {
        return fail('booked must be true or false', 400);
      }
      return json({ ...(await loadState(env, repo, nowMs, admin)), admin });
    }
    return fail('Not found', 404);
  } catch (e) {
    console.error('padel: request failed', path, String(e && e.stack || e));
    return fail('Something went wrong. Try again.', 500);
  }
}
