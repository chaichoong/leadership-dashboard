#!/usr/bin/env node
// padel-courts.mjs: reads which courts are free at St Ives and PDL (Matchi) on the Mac mini and
// hands the result to the padel Worker (workers/padel), every 15 minutes from 06:30 to 23:00 London.
//
// WHY (27 Oct 2026)
// -----------------
// Matchi answers every /book/schedule request from Cloudflare's edge with HTTP 429 (12 of 12 probes
// on 27 Oct 2026), and its CORS is closed, so neither the Worker nor the phones can read it. From
// this Mac all 14 pages (2 venues x 7 days) return 200 in one burst with 250 ms gaps. So this job
// reads them here and POSTs the parsed days to https://padel.kevinbrittain.workers.dev/api/courts.
// Pulse Padel is still read by the Worker itself.
//
// WHAT IT DOES
// ------------
// run       fetches the 14 pages one after another (250 ms apart, 10 s timeout each, one more try
//           after 2 s for a page lost to a timeout, a 5xx or no connection, the same
//           headers the Worker used), parses them with the Worker's own parseMatchi (imported
//           from ../workers/padel/padel.js, so both sides read a page one way), POSTs them with
//           X-Robot-Key from ~/.config/od/padel_robot_key, prints one summary line and appends one
//           JSON line of counts (never a name) to ~/knowledge-os/logs/padel-courts/runs.jsonl.
// selftest  offline checks of the pure parts.
//
// QUIET HOURS: outside 06:30 to 23:00 London it prints "quiet hours" and does nothing. The hour is
// decided here, in Europe/London, because launchd fires on the Mac's clock; the clock is read again
// just before the POST, because the Mac can sleep mid-run.
//
// FAILS LOUDLY (exit 1, a line starting "FAILED:", which ~/tools/run-job.sh records):
//   - any day the parser could not read (an error that is not a network one: Matchi changed its
//     page, or a login wall), on ANY day, even when every other page read fine;
//   - a venue that errored on every day whose booking window must be open (St Ives today and
//     tomorrow, PDL all 7 days), whatever the reason (a 404 on all 7 PDL days fails);
//   - a must-be-open day that came back closed (no court cells at all);
//   - the POST did not answer 200.
// A venue that misses a few days to a network error (a timeout, a 5xx) is not a failure on its
// own: those days read "couldn't check" on the page and the next run is 15 minutes later.
// SLEPT, not failed: the clock is read before every fetch and before the POST. When one gap
// between two consecutive reads is over 60 s, the Mac slept mid-run (no fetch takes that long:
// each has a 10 s timeout), so the read is thrown away and not posted, and the run exits 0. A
// POST that fails with a gap over 60 s across it is "slept" too. A long run with no such gap (14
// pages timing out one after another) is a FAILED run, never "slept".
//
// Usage:
//   node scripts/padel-courts.mjs run
//   node scripts/padel-courts.mjs selftest

import { readFileSync, appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMatchi, matchiUrl, londonDates, londonParts, MATCHI_HEADERS } from '../workers/padel/padel.js';

export const ENDPOINT = 'https://padel.kevinbrittain.workers.dev/api/courts';
export const KEY_FILE = join(homedir(), '.config/od/padel_robot_key');
export const LOG_DIR = join(homedir(), 'knowledge-os/logs/padel-courts');
export const VENUES = [{ code: 'si', id: '2619', name: 'St Ives' }, { code: 'pdl', id: '3122', name: 'PDL' }];
export const GAP_MS = 250;
export const PAGE_TIMEOUT_MS = 10000;
export const POST_TIMEOUT_MS = 30000;
export const MAX_GAP_MS = 60 * 1000;  // one gap this long between two clock reads means the Mac slept
export const RETRY_MS = 2000;        // a page lost to a timeout, a 5xx or no connection is fetched once more after this
const QUIET_FROM = 23 * 60;          // 23:00 London
const QUIET_UNTIL = 6 * 60 + 30;     // 06:30 London

// True outside 06:30 to 23:00 London.
export function isQuiet(nowMs) {
  const p = londonParts(nowMs);
  const m = Number(p.hh) * 60 + Number(p.mm);
  return m < QUIET_UNTIL || m >= QUIET_FROM;
}

// The days whose booking window must be open: St Ives today and tomorrow, PDL all 7.
export function mustBeOpen(code, index) {
  return code === 'si' ? index < 2 : true;
}
// The reasons readDay gives for a page that never arrived. Every other error reason comes from
// parseMatchi: the page arrived and could not be read.
export const isNetworkReason = (reason) => /^HTTP \d{3}$/.test(reason || '') || reason === 'timed out' || reason === 'could not reach the site';
// Worth one more try: a timeout, a 5xx or no connection. Never a 4xx or a 429 (Matchi refusing
// us, which another request at once would only make worse).
export const isRetryable = (reason) => /^HTTP 5\d\d$/.test(reason || '') || reason === 'timed out' || reason === 'could not reach the site';

// Fetch one page. Never throws: a failure is an error day with its reason.
export async function readDay(fetchImpl, id, date) {
  try {
    const res = await fetchImpl(matchiUrl(id, date), { headers: { ...MATCHI_HEADERS }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    if (res.status !== 200) return { status: 'error', reason: `HTTP ${res.status}` };
    return parseMatchi(await res.text());
  } catch (e) {
    return { status: 'error', reason: e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timed out' : 'could not reach the site' };
  }
}

// What the Worker stores: no court names, just counts and the shortest booking.
export function toPayloadDay(day) {
  if (day.status !== 'ok') return day.status === 'closed' ? { status: 'closed' } : { status: 'error', reason: day.reason || 'unknown' };
  const starts = {};
  for (const [t, s] of Object.entries(day.starts)) starts[t] = { courts: s.courts, min: s.min };
  return { status: 'ok', starts };
}

// Read the 14 pages one after another.
export async function readAll({ fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), nowMs, beforeFetch = () => {} }) {
  const dates = londonDates(nowMs);
  const raw = {};
  let first = true;
  for (const v of VENUES) {
    raw[v.code] = {};
    for (const date of dates) {
      if (!first) await sleep(GAP_MS);
      first = false;
      beforeFetch();
      let day = await readDay(fetchImpl, v.id, date);
      // A page lost to a timeout, a 5xx or no connection gets one more try before it counts. A
      // 4xx, a 429, or a page that arrived and could not be parsed does not.
      if (day.status === 'error' && isRetryable(day.reason)) {
        await sleep(RETRY_MS);
        beforeFetch();
        day = await readDay(fetchImpl, v.id, date);
      }
      raw[v.code][date] = day;
    }
  }
  return { dates, raw };
}

export function buildPayload(raw, readAtMs) {
  const venues = {};
  for (const [code, days] of Object.entries(raw)) {
    venues[code] = {};
    for (const [date, day] of Object.entries(days)) venues[code][date] = toPayloadDay(day);
  }
  return { readAt: new Date(readAtMs).toISOString(), venues };
}

export function countStatuses(raw) {
  const out = {};
  for (const [code, days] of Object.entries(raw)) {
    out[code] = { ok: 0, closed: 0, error: 0 };
    for (const d of Object.values(days)) out[code][d.status in out[code] ? d.status : 'error']++;
  }
  return out;
}

// The read's own problems, before any POST. Each is a sentence for the FAILED line.
const reasonsOf = (days) => [...new Set(days.map((d) => d.reason))].slice(0, 3).join(', ');
export function readProblems(raw, dates) {
  const problems = [];
  const all = Object.values(raw).flatMap((days) => Object.values(days));
  const everyPage = all.length > 0 && all.every((d) => d.status === 'error');
  if (everyPage) problems.push(`every Matchi page errored (${reasonsOf(all)})`);
  for (const v of VENUES) {
    const open = [];
    dates.forEach((date, i) => {
      const d = raw[v.code]?.[date];
      if (!d) return;
      if (d.status === 'error' && !isNetworkReason(d.reason)) problems.push(`${v.name} ${date} could not be read (${d.reason})`);
      if (!mustBeOpen(v.code, i)) return;
      open.push(d);
      if (d.status === 'closed') problems.push(`${v.name} ${date} has no court cells`);
    });
    if (!everyPage && open.length && open.every((d) => d.status === 'error')) problems.push(`${v.name} errored on every day that should be open (${reasonsOf(open)})`);
  }
  return problems;
}

export async function postCourts(fetchImpl, payload, robotKey) {
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Robot-Key': robotKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: { error: e && e.name === 'TimeoutError' ? 'timed out' : 'could not reach the Worker' } };
  }
}

// The longest gap between two consecutive clock reads.
export function maxGap(stamps) {
  let gap = 0;
  for (let i = 1; i < stamps.length; i++) gap = Math.max(gap, stamps[i] - stamps[i - 1]);
  return gap;
}

function readKey() {
  try { return readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; }
}
const hhmm = (iso) => { if (!iso) return 'never'; const p = londonParts(Date.parse(iso)); return `${p.hh}:${p.mm}`; };
const summaryOf = (counts) => VENUES.map((v) => {
  const c = counts[v.code];
  return `${v.name} ok ${c.ok}${c.closed ? `, closed ${c.closed}` : ''}${c.error ? `, error ${c.error}` : ''}`;
}).join('; ');

// One run. Everything outside is passed in, so the tests drive this exact code.
export async function run({
  fetchImpl = globalThis.fetch, now = Date.now, sleep, robotKey = readKey(), log = (line) => process.stdout.write(`${line}\n`),
  record = (entry) => { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(join(LOG_DIR, 'runs.jsonl'), `${JSON.stringify(entry)}\n`); },
} = {}) {
  const startMs = now();
  if (isQuiet(startMs)) { log('quiet hours'); return 0; }
  if (!robotKey) { log(`FAILED: no robot key at ${KEY_FILE}`); return 1; }
  const stamps = [startMs];
  const { dates, raw } = await readAll({ fetchImpl, sleep, nowMs: startMs, beforeFetch: () => stamps.push(now()) });
  const counts = countStatuses(raw);
  const endMs = now();
  stamps.push(endMs);
  if (isQuiet(endMs)) { log('quiet hours'); return 0; }
  const seconds = Math.round((endMs - startMs) / 1000);
  const gap = maxGap(stamps);
  if (gap > MAX_GAP_MS) {
    log(`padel-courts: the Mac slept mid-read (a ${Math.round(gap / 1000)} s gap), not posted; ${summaryOf(counts)}`);
    record({ ts: new Date(endMs).toISOString(), ok: true, posted: false, seconds, counts, slept: true });
    return 0;
  }
  // readAt is when the read STARTED: the oldest page in it.
  const post = await postCourts(fetchImpl, buildPayload(raw, startMs), robotKey);
  if (post.status !== 200) {
    // A Mac that slept while the POST was out gets a 400 or 409 for an old read: the sleep, not a
    // fault. Judged by the gap across the POST alone (its own timeout is 30 s).
    const afterMs = now();
    if (afterMs - endMs > MAX_GAP_MS) {
      log(`padel-courts: the Mac slept while posting (a ${Math.round((afterMs - endMs) / 1000)} s gap), Worker answered ${post.status || 'nothing'}; not counted; ${summaryOf(counts)}`);
      record({ ts: new Date(afterMs).toISOString(), ok: true, posted: false, http: post.status, seconds, counts, slept: true });
      return 0;
    }
  }
  const problems = readProblems(raw, dates);
  if (post.status !== 200) problems.push(`the Worker answered ${post.status || 'nothing'} (${String(post.body?.error || 'no reason').slice(0, 120)})`);
  record({ ts: new Date(endMs).toISOString(), ok: !problems.length, posted: post.status === 200, http: post.status, seconds, counts, problems: problems.length });
  if (problems.length) { log(`FAILED: ${problems.join('; ')}. ${summaryOf(counts)}`); return 1; }
  log(`padel-courts: ${summaryOf(counts)}; posted 200 in ${seconds} s; Pulse read ${hhmm(post.body?.pulseFetchedAt)}`);
  return 0;
}

// ── selftest: the pure parts, offline ──
export function selftest(log = (line) => process.stdout.write(`${line}\n`)) {
  const checks = [];
  const check = (name, cond) => checks.push([name, !!cond]);
  check('06:29 BST is quiet', isQuiet(Date.parse('2026-07-01T05:29:00Z')));
  check('06:30 BST is not quiet', !isQuiet(Date.parse('2026-07-01T05:30:00Z')));
  check('22:59 BST is not quiet', !isQuiet(Date.parse('2026-07-01T21:59:00Z')));
  check('23:00 BST is quiet', isQuiet(Date.parse('2026-07-01T22:00:00Z')));
  check('06:30 GMT is not quiet', !isQuiet(Date.parse('2026-11-01T06:30:00Z')));
  check('23:00 GMT is quiet', isQuiet(Date.parse('2026-11-01T23:00:00Z')));
  check('St Ives day 3 may be closed', !mustBeOpen('si', 2) && mustBeOpen('si', 1) && mustBeOpen('pdl', 6));
  const page = '<div class="schedule"><table><tr><td class="slot free" data-slot-can-start="true" data-slot-min-duration="60" title="Available<br>Court 1<br>19:00 - 20:00"></td></tr></table></div>';
  const day = parseMatchi(page);
  check('a free cell parses', day.status === 'ok' && day.starts['19:00'].courts === 1);
  check('the payload drops court names', JSON.stringify(toPayloadDay(day)) === '{"status":"ok","starts":{"19:00":{"courts":1,"min":60}}}');
  const dates = londonDates(Date.parse('2026-10-28T09:00:00Z'));
  const raw = { si: Object.fromEntries(dates.map((d) => [d, { status: 'error', reason: 'HTTP 429' }])), pdl: Object.fromEntries(dates.map((d) => [d, { status: 'error', reason: 'HTTP 429' }])) };
  check('all errors fail', readProblems(raw, dates).some((p) => p.startsWith('every Matchi page errored')));
  raw.si[dates[0]] = { status: 'closed' };
  check('St Ives today closed fails', readProblems(raw, dates).some((p) => p.includes(`St Ives ${dates[0]}`)));
  const bad = checks.filter(([, ok]) => !ok);
  for (const [name] of bad) log(`FAILED: selftest ${name}`);
  log(`selftest: ${checks.length - bad.length} of ${checks.length} checks passed`);
  return bad.length ? 1 : 0;
}

async function main(argv) {
  const cmd = argv[2];
  if (cmd === 'run') return run();
  if (cmd === 'selftest') return selftest();
  process.stdout.write('Usage: padel-courts.mjs run | selftest\n');
  return 64;
}

let invoked = false;
try { invoked = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { invoked = false; }
if (invoked) {
  main(process.argv).then((code) => { process.exitCode = code; }, (e) => {
    process.stdout.write(`FAILED: ${String(e && e.stack || e).split('\n')[0]}\n`);
    process.exitCode = 1;
  });
}
