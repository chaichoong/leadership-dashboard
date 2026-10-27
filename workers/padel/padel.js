// Padel Worker logic (worker.js is the entry point): the padel group's "who can play when" page (Kevin approved the plan, 27 Oct 2026).
//
// WHAT IT DOES: an 11-person WhatsApp group ticks the hours they can play over the next 7 days on
// one phone page. The Worker reads which courts are free at three venues and sends Kevin ONE Slack
// DM the first time 4+ people line up on an hour where a court is free. Nobody has to count.
//
// Routes (JSON; every /api route except /api/health needs header X-Group-Key = GROUP_KEY):
//   GET  /api/state                         -> the whole page state (kicks a lazy venue refresh)
//   POST /api/person  { name }              -> { id, name, venues }   creates the name if absent
//   POST /api/person  { id, venues:[...] }  -> { id, name, venues }   venue preferences
//   POST /api/vote    { person_id, slots }  -> state                  replaces that person's ticks
//   POST /api/booked  { slot, person_id, venue, booked } -> state
//   POST /api/refresh                       -> state + { refreshed }  "Check courts now"
//   GET  /api/health                        -> { ok, fetchedAt, venueStatus }   no key, no data
// Anything else is the static page in ./public (wrangler.toml [assets]).
//
// A slot is "YYYY-MM-DD|HH": the London date and two-digit start hour, 07 to 21.
// Venues: si = St Ives Golf Club (Matchi 2619), pdl = PDL Padel United Cambridge (Matchi 3122),
// pp = Pulse Padel Huntingdon (the Nettla booking widget's public availability endpoint, called
// at most once per 15 minutes: Kevin's go-ahead, 27 Oct 2026).
//
// NO cron (all five free-plan triggers are used) and NO KV (free-tier writes starve the other
// Workers). D1 holds everything; see schema.sql.
//
// Bindings: DB (D1), ASSETS (static page), RELAY (service binding to apple-inbound's /slack-relay),
//           WRITE_LIMIT (ratelimit, optional). Secrets: GROUP_KEY, RELAY_KEY.

export const TZ = 'Europe/London';
export const VENUES = ['si', 'pdl', 'pp'];
export const HOURS = Array.from({ length: 15 }, (_, i) => i + 7);          // 7..21
const HH = new Set(HOURS.map((h) => String(h).padStart(2, '0')));
export const DAYS = 7;
export const MAX_MIN = 90;                       // an hour counts as free only for a start of 90 min or less
export const STALE_MS = 15 * 60 * 1000;          // availability older than this is refreshed
export const REFRESH_GUARD_MS = 90 * 1000;       // no second refresh within 90 seconds
export const PULSE_EVERY_MS = 15 * 60 * 1000;    // Pulse is called at most once per 15 minutes
export const FETCH_TIMEOUT_MS = 8000;
export const ALERT_AT = 4;
const MAX_PEOPLE = 40;
const MAX_BODY = 16 * 1024;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} '’-]*$/u;
const SLOT_RE = /^(\d{4}-\d{2}-\d{2})\|(\d{2})$/;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
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

// ── Matchi: one schedule page per venue per date ──
// Each 30-minute cell is a <td class="slot free|red|can-not-start|not-available">. A bookable start
// is a "slot free" cell with data-slot-can-start="true"; its title reads "Available<br>Court 1<br>
// 07:00 - 08:00" (the court and the MINIMUM booking from that cell) and data-slot-min-duration is
// 60 or 90. Attribute order is not fixed and titles can hold newlines, so each cell's tag is read
// whole, quote-aware. indexOf, not one big regex: 14 pages a refresh must stay cheap on CPU.
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

export function parseMatchi(html) {
  if (typeof html !== 'string' || !/class="schedule[\s"]/.test(html)) return { status: 'error', reason: 'not a schedule page' };
  const starts = {};
  let cells = 0;
  let i = 0;
  while ((i = html.indexOf('class="slot', i)) !== -1) {
    const at0 = i;
    i += 11;
    const open = html.lastIndexOf('<td', at0);
    if (open === -1) continue;
    const end = tagEnd(html, open);
    if (end === -1 || end < at0) continue;                 // the class is not inside this <td>
    const at = tagAttrs(html.slice(open + 3, end));
    const cls = String(at.class || '').split(/\s+/);
    if (!cls.includes('slot')) continue;
    cells++;
    if (!cls.includes('free') || at['data-slot-can-start'] !== 'true') continue;
    const m = TITLE_RE.exec(at.title || '');
    if (!m) continue;
    const court = unent(m[1]).replace(/\s+/g, ' ').trim();
    if (/single/i.test(court)) continue;                  // two players only: never a doubles court
    const min = Number(at['data-slot-min-duration']) || 60;
    const t = `${m[2].padStart(2, '0')}:${m[3]}`;
    const s = starts[t] || (starts[t] = { courts: 0, min, names: [] });
    if (!s.names.includes(court)) { s.names.push(court); s.courts++; }
    s.min = Math.min(s.min, min);
  }
  if (cells === 0) {
    // St Ives beyond its 7-day window (checked 27 Oct 2026 on 5 Nov) sends no table at all, only
    // "... allows bookings no more than 7 days in the future". That is "not open yet".
    if (/allows bookings no more than/i.test(html) || html.includes('id="schedule-table"')) return { status: 'closed' };
    return { status: 'error', reason: 'no schedule table' };
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

// ── The whole page state, pure ──
export function computeState({ people, votes, booked, availability, dates, nowMs, cfg = venueConfig() }) {
  const today = dates[0];
  const inWindow = new Set(dates);
  const ppl = people.map((p) => ({ id: p.id, name: p.name, venues: Array.isArray(p.venues) ? p.venues : splitVenues(p.venues) }));
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
  const fetchedAt = availability?.fetchedAt || null;
  const venuesOut = {};
  for (const code of VENUES) {
    venuesOut[code] = {};
    for (const date of dates) {
      const day = availability?.venues?.[code]?.[date];
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
      if (h.status !== 'ok' || !h.hours[hh]?.free) continue;
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
        venues: q.map((c) => ({ code: c.code, count: c.count, starts: c.hour.starts, mins: c.hour.mins, min: c.hour.min, book: bookUrl(cfg, c.code, date) })),
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
    availability: { fetchedAt, stale: false, venues: venuesOut }, venueInfo, ready, nearly,
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
export function alertText(r, cfg, pageUrl) {
  const courts = r.venues.map((v) => `${cfg[v.code].short} ${startsText(v)} <${v.book}|book>`).join('; ');
  return `Padel: ${r.names.length} in for ${r.label}: ${r.names.map(slackSafe).join(', ')}. `
    + `Courts free: ${courts}. Whoever books: tap Booked on the page ${pageUrl}`;
}

// ── D1 access, behind one small object so tests can swap in a Map-backed copy ──
const toPerson = (r) => ({ id: r.id, name: r.name, venues: splitVenues(r.venues) });
export function makeRepo(db) {
  return {
    async listPeople() {
      const r = await db.prepare('SELECT id, name, venues FROM people ORDER BY name COLLATE NOCASE').all();
      return (r.results || []).map(toPerson);
    },
    async getPerson(id) {
      const r = await db.prepare('SELECT id, name, venues FROM people WHERE id = ?').bind(id).first();
      return r ? toPerson(r) : null;
    },
    async countPeople() {
      const r = await db.prepare('SELECT COUNT(*) AS n FROM people').first();
      return Number(r?.n || 0);
    },
    async addPerson(name, nowIso) {
      await db.prepare("INSERT INTO people (name, venues, created_at) VALUES (?, 'si,pdl,pp', ?) ON CONFLICT(name) DO NOTHING").bind(name, nowIso).run();
      const r = await db.prepare('SELECT id, name, venues FROM people WHERE name = ? COLLATE NOCASE').bind(name).first();
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
    // One batch, two statements, whatever the number of slots: drop the ticks not in the list, add
    // the new ones (a kept tick keeps its first created_at).
    async replaceVotes(personId, slots, nowIso) {
      const list = JSON.stringify(slots);
      await db.batch([
        db.prepare('DELETE FROM votes WHERE person_id = ?1 AND slot NOT IN (SELECT value FROM json_each(?2))').bind(personId, list),
        db.prepare('INSERT OR IGNORE INTO votes (person_id, slot, created_at) SELECT ?1, value, ?3 FROM json_each(?2)').bind(personId, list, nowIso),
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
    async alertSlots(fromDate) {
      const r = await db.prepare('SELECT slot FROM alerts WHERE slot >= ?').bind(fromDate).all();
      return (r.results || []).map((x) => x.slot);
    },
    // INSERT OR IGNORE first: only the request whose insert changed a row sends the DM.
    async claimAlert(slot, names, venues, nowIso) {
      const r = await db.prepare('INSERT OR IGNORE INTO alerts (slot, sent_at, names, venues) VALUES (?, ?, ?, ?)').bind(slot, nowIso, names, venues).run();
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

// ── Venue reads ──
async function fetchWithTimeout(fetchImpl, url, init) {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}
const failReason = (e) => (e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timed out' : 'could not reach the site');

async function readMatchiDay(fetchImpl, id, date) {
  try {
    const res = await fetchWithTimeout(fetchImpl, matchiUrl(id, date), {
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' },
    });
    if (res.status !== 200) return { status: 'error', reason: `HTTP ${res.status}` };
    return parseMatchi(await res.text());
  } catch (e) {
    return { status: 'error', reason: failReason(e) };
  }
}

// One venue's 7 days. The first date goes alone: a 429 there means Matchi is refusing this caller
// (on 27 Oct 2026 every /book/schedule request from Cloudflare's edge got "429 Too Many Requests"
// from Matchi's nginx while the same request from the Mac got 200), so the other 6 are not sent.
async function readMatchiVenue(fetchImpl, id, dates) {
  const first = await readMatchiDay(fetchImpl, id, dates[0]);
  if (first.status === 'error' && first.reason === 'HTTP 429') return dates.map(() => ({ ...first }));
  const rest = await Promise.allSettled(dates.slice(1).map((d) => readMatchiDay(fetchImpl, id, d)));
  return [first, ...rest.map((r) => (r.status === 'fulfilled' ? r.value : { status: 'error', reason: 'read failed' }))];
}

// One search for the whole 7-day range. Three body formats, the one that worked last first:
//   orpc     { json: {...} } in, { json: {...}, meta } out. What the endpoint speaks: on 27 Oct 2026
//            both other formats got HTTP 400 {"json":{"code":"BAD_REQUEST","message":"Input
//            validation failed", ... "expected object, received undefined"}}, an oRPC reply.
//   plain    the bare body; envelope: Firebase callable { data } in, { result } out.
const PULSE_FORMATS = {
  orpc: { wrap: (b) => ({ json: b }), unwrap: (j) => j?.json },
  plain: { wrap: (b) => b, unwrap: (j) => j },
  envelope: { wrap: (b) => ({ data: b }), unwrap: (j) => j?.result },
};
async function readPulse(fetchImpl, clubId, dates, nowMs, preferred) {
  const startDateTime = new Date(londonMidnightMs(dates[0])).toISOString();
  const endDateTime = new Date(londonMidnightMs(addDays(dates[dates.length - 1], 1)) - 1).toISOString();
  const body = { clubId, startDateTime, endDateTime };
  const order = ['orpc', 'plain', 'envelope'].sort((a, b) => (b === preferred) - (a === preferred));
  let last = { status: 'error', reason: 'no answer' };
  for (const format of order) {
    try {
      const res = await fetchWithTimeout(fetchImpl, PULSE_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: 'https://pulsepadel.co.uk', Referer: PULSE_PAGE },
        body: JSON.stringify(PULSE_FORMATS[format].wrap(body)),
      });
      if (res.status !== 200) { last = { status: 'error', reason: `HTTP ${res.status}` }; continue; }
      const json = await res.json();
      const parsed = parsePulse(PULSE_FORMATS[format].unwrap(json), nowMs);
      if (parsed.status === 'ok') return { ...parsed, format };
      last = parsed;
    } catch (e) {
      last = { status: 'error', reason: failReason(e) };
    }
  }
  return last;
}

export async function refreshAvailability(env, repo, nowMs, fetchImpl = globalThis.fetch, clock = Date.now) {
  const cfg = venueConfig(env);
  const dates = londonDates(nowMs);
  const prevRaw = await repo.getCache('availability');
  let prev = null;
  try { prev = prevRaw ? JSON.parse(prevRaw) : null; } catch (e) { console.error('padel: cached availability unreadable', String(e)); }
  const pulseDue = !prev?.pulseFetchedAt || nowMs - Date.parse(prev.pulseFetchedAt) >= PULSE_EVERY_MS;

  const [si, pdl, pp] = await Promise.allSettled([
    readMatchiVenue(fetchImpl, cfg.si.matchiId, dates),
    readMatchiVenue(fetchImpl, cfg.pdl.matchiId, dates),
    pulseDue ? readPulse(fetchImpl, cfg.pp.clubId, dates, nowMs, prev?.pulseFormat) : Promise.resolve(null),
  ]);
  const failed = { status: 'error', reason: 'read failed' };
  const venues = { si: {}, pdl: {}, pp: {} };
  for (const [code, got] of [['si', si], ['pdl', pdl]]) {
    dates.forEach((date, i) => { venues[code][date] = got.status === 'fulfilled' ? got.value[i] : failed; });
  }
  const pulse = pp.status === 'fulfilled' ? pp.value : failed;
  let pulseFetchedAt = prev?.pulseFetchedAt || null;
  let pulseFormat = prev?.pulseFormat || null;
  if (pulse === null) {
    for (const date of dates) venues.pp[date] = prev?.venues?.pp?.[date] || { status: 'pending' };
  } else {
    pulseFetchedAt = new Date(nowMs).toISOString();
    if (pulse.status === 'ok') {
      pulseFormat = pulse.format;
      for (const date of dates) venues.pp[date] = { status: 'ok', starts: pulse.byDate[date] || {} };
    } else {
      for (const date of dates) venues.pp[date] = { status: 'error', reason: pulse.reason };
    }
  }
  // fetchedAt = when the refresh FINISHED (never earlier than it started).
  const availability = { fetchedAt: new Date(Math.max(clock(), nowMs)).toISOString(), pulseFetchedAt, pulseFormat, venues };
  await repo.setCache('availability', JSON.stringify(availability), availability.fetchedAt);
  await repo.prune(dates[0]);
  return availability;
}

// ── Alerts ──
export async function checkAlerts(state, env, repo, nowIso) {
  const due = decideAlerts(state, await repo.alertSlots(state.today));
  const cfg = venueConfig(env);
  const sent = [];
  for (const r of due) {
    const claimed = await repo.claimAlert(r.slot, r.names.join(', '), r.venues.map((v) => v.code).join(','), nowIso);
    if (!claimed) continue;
    try {
      if (!env.RELAY || !env.RELAY_KEY) throw new Error('relay not configured');
      const res = await env.RELAY.fetch(new Request(RELAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Relay-Key': env.RELAY_KEY },
        body: JSON.stringify({ text: alertText(r, cfg, env.PAGE_URL || 'https://padel.kevinbrittain.workers.dev/').slice(0, 4000), recipients: [env.ALERT_TO || 'kevin@runpreneur.org.uk'] }),
      }));
      const reply = await res.text();
      if (res.status !== 200) throw new Error(`relay HTTP ${res.status}: ${reply.slice(0, 300)}`);
      await repo.saveRelayReply(r.slot, reply);
      sent.push(r.slot);
    } catch (e) {
      console.error('padel: alert DM failed, will retry', r.slot, String(e));
      await repo.releaseAlert(r.slot);
    }
  }
  return sent;
}

// ── HTTP ──
const BASE_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const PAGE_HEADERS = {
  ...BASE_HEADERS,
  'Cache-Control': 'no-cache',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
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
// IPv6 hands out whole blocks, so a caller is counted by its /64 (copied in spirit from property-manager).
export function callerKey(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (!s.includes(':')) return s;
  const halves = s.split('::');
  if (halves.length > 2) return s;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (groups.length !== 8) return s;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

export function cleanName(raw) {
  const name = String(raw ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 30) return { error: 'A name is 2 to 30 letters.' };
  if (!NAME_RE.test(name)) return { error: 'Use letters, spaces, hyphens or apostrophes only.' };
  return { name };
}
export function cleanSlots(raw, dates) {
  if (!Array.isArray(raw)) return { error: 'slots must be a list' };
  if (raw.length > dates.length * HOURS.length) return { error: 'too many slots' };
  const ok = new Set(dates);
  const out = new Set();
  for (const s of raw) {
    const m = SLOT_RE.exec(String(s));
    if (!m || !ok.has(m[1]) || !HH.has(m[2])) return { error: `Not an hour in the next 7 days: ${String(s).slice(0, 20)}` };
    out.add(m[0]);
  }
  return { slots: [...out].sort() };
}

async function loadState(env, repo, nowMs) {
  const dates = londonDates(nowMs);
  const [availabilityRaw, people, votes, booked] = await Promise.all([
    repo.getCache('availability'), repo.listPeople(), repo.listVotes(dates[0]), repo.listBooked(dates[0]),
  ]);
  let availability = null;
  try { availability = availabilityRaw ? JSON.parse(availabilityRaw) : null; } catch (e) { console.error('padel: cached availability unreadable', String(e)); }
  const state = computeState({ people, votes, booked, availability, dates, nowMs, cfg: venueConfig(env) });
  const age = availability?.fetchedAt ? nowMs - Date.parse(availability.fetchedAt) : Infinity;
  state.availability.stale = !(age < STALE_MS);
  return state;
}

// Refresh the venues, then run the alert check on the fresh state. Never throws: it runs inside
// waitUntil, where a throw would vanish.
async function refreshAndAlert(env, repo, nowMs, fetchImpl, clock) {
  try {
    await refreshAvailability(env, repo, nowMs, fetchImpl, clock);
    const now = clock();
    const state = await loadState(env, repo, now);
    await checkAlerts(state, env, repo, new Date(now).toISOString());
    return true;
  } catch (e) {
    console.error('padel: refresh failed', String(e && e.stack || e));
    return false;
  }
}

async function readBody(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BODY) return { error: 'Too big', status: 413 };
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return { error: 'Too big', status: 413 };
    const body = JSON.parse(text || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Bad request', status: 400 };
    return { body };
  } catch {
    return { error: 'Bad request', status: 400 };
  }
}
const intId = (v) => (Number.isInteger(v) && v > 0 ? v : (typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null));

export async function handleRequest(request, env, ctx, repo, deps = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const clock = deps.now || Date.now;
  const nowMs = clock();
  try {
    if (!path.startsWith('/api/')) {
      if (!env.ASSETS) return new Response('Not found', { status: 404, headers: BASE_HEADERS });
      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(PAGE_HEADERS)) out.headers.set(k, v);
      return out;
    }
    if (path === '/api/health' && request.method === 'GET') {
      const raw = await repo.getCache('availability');
      let a = null;
      try { a = raw ? JSON.parse(raw) : null; } catch (e) { console.error('padel: cached availability unreadable', String(e)); }
      const venueStatus = {};
      for (const code of VENUES) {
        const counts = {};
        for (const d of Object.values(a?.venues?.[code] || {})) counts[d.status] = (counts[d.status] || 0) + 1;
        venueStatus[code] = counts;
      }
      return json({ ok: true, fetchedAt: a?.fetchedAt || null, venueStatus });
    }
    if (request.method === 'POST' && env.WRITE_LIMIT) {
      const { success } = await env.WRITE_LIMIT.limit({ key: callerKey(request.headers.get('CF-Connecting-IP')) });
      if (!success) return fail('slow down', 429);
    }
    if (!env.GROUP_KEY || !timingSafeEqual(request.headers.get('X-Group-Key') || '', env.GROUP_KEY)) return fail(GATE_MSG, 401);

    if (path === '/api/state' && request.method === 'GET') {
      const state = await loadState(env, repo, nowMs);
      if (state.availability.stale && await repo.claimRefresh(nowMs, REFRESH_GUARD_MS)) {
        ctx.waitUntil(refreshAndAlert(env, repo, nowMs, fetchImpl, clock));
      }
      return json(state);
    }
    if (request.method !== 'POST') return fail('Not found', 404);
    const dates = londonDates(nowMs);
    const nowIso = new Date(nowMs).toISOString();

    if (path === '/api/refresh') {
      let refreshed = false;
      if (await repo.claimRefresh(nowMs, REFRESH_GUARD_MS)) refreshed = await refreshAndAlert(env, repo, nowMs, fetchImpl, clock);
      const state = await loadState(env, repo, clock());
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
      if ((await repo.countPeople()) >= MAX_PEOPLE) {
        const people = await repo.listPeople();
        const found = people.find((p) => p.name.toLowerCase() === clean.name.toLowerCase());
        if (!found) return fail('The group list is full. Ask Kevin.', 409);
        return json(found);
      }
      const person = await repo.addPerson(clean.name, nowIso);
      if (!person) return fail('Could not save that name. Try again.', 500);
      return json(person);
    }

    if (path === '/api/vote') {
      const id = intId(body.person_id);
      if (!id) return fail('person_id is needed', 400);
      const clean = cleanSlots(body.slots, dates);
      if (clean.error) return fail(clean.error, 400);
      if (!(await repo.getPerson(id))) return fail('No such person', 404);
      await repo.replaceVotes(id, clean.slots, nowIso);
      const state = await loadState(env, repo, nowMs);
      await checkAlerts(state, env, repo, nowIso);
      return json(state);
    }

    if (path === '/api/booked') {
      const clean = cleanSlots([body.slot], dates);
      if (clean.error) return fail(clean.error, 400);
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
