#!/usr/bin/env node
/**
 * prod-walk.js — the Sunday production walk, as a script a robot can run.
 *
 * WHY THIS EXISTS (27 Sep 2026)
 * -----------------------------
 * prod-sweep-weekly is a launchd slot: a headless `claude -p` run. Its skill told
 * it to walk the app with `mcp__Claude_Browser__*` and to raise tasks "via the
 * Airtable MCP". Neither exists in a headless run (scripts/agent-tools.sh says
 * why: those are desktop-app tools, launchd never sees them). So from 13 Sep the
 * walk never ran, every Sunday, and on 27 Sep the run could not reach Airtable
 * either (findings 20260808-prod-e2e-sweep-023, 20260906-prod-sweep-weekly-480,
 * 20260918-daily-ops-phase2-excepti-545).
 *
 * The robots' browser route is Playwright driven by a script (agent-browser.js
 * set that pattern), and `node` is already on the robots' allowed list. This
 * script does the mechanical half of the walk; the slot does the judging.
 *
 * WHAT IT DOES, READ-ONLY
 *   1. Opens the live app in a throwaway browser context (nothing kept on disk).
 *      Only the live app, or a local copy of it, is accepted as --base: the
 *      token goes to whatever site is walked.
 *   2. Signs in the way a returning user is signed in. The token is read HERE
 *      from ~/.config/od/airtable_pat and seeded into the app origin's own
 *      localStorage keys (`_dlr_pat`, which js/shared.js reads, and
 *      `airtable_pat`, which compliance.html and growth-plan.html read) through
 *      Playwright's storageState, which reaches that one origin and no frame
 *      from anywhere else. It is never printed, logged or passed on a command
 *      line, and every string is scrubbed of it before it is cut or printed.
 *      The same storageState remembers Kevin as the Tasks page's viewer
 *      (`_task_user`, exactly what that page writes when Kevin picks his own
 *      name), so Tasks shows his data instead of "Who are you?" (29 Sep 2026).
 *   3. Waits until the data has actually loaded (bare `PAT` and `allTransactions`,
 *      never the `window.` forms, which are undefined on a healthy app).
 *   4. Reads PAGE_REGISTRY live and visits every entry: a tab with a `tab-<id>`
 *      panel through switchTab(), reading the page inside its iframe when it has
 *      one, anything else by opening its standalone page. It clicks nothing.
 *      `--only id1,id2` walks just those registry ids (sign-in and the data load
 *      still happen first). An id not in PAGE_REGISTRY is a FAIL named "not in
 *      PAGE_REGISTRY", so a stale list is loud rather than walking nothing.
 *   5. BLOCKS EVERY WRITE, MECHANICALLY (29 Sep 2026). Every request from the
 *      browser context goes through a route: GET, HEAD and OPTIONS are sent,
 *      any other method (POST, PATCH, PUT, DELETE...) to any host is never sent.
 *      It is answered locally with a 200 and a harmless Airtable-shaped body, and
 *      logged as "METHOD host/path" on the page that tried it. Service workers
 *      are blocked so none can send around the route. Why: the merge gate
 *      (scripts/merge-pr.py) runs this walk against UNMERGED code with Kevin's
 *      real token, so "it clicks nothing" is manners, not a guarantee. A blocked
 *      write is reported, never judged: it does not change PASS / WARN / FAIL.
 *      Limit: a GET that changes something server-side still goes out (the app
 *      shell fires the invoice sync as a GET on every load).
 *      ONE NAMED EXCEPTION (29 Sep 2026), in ALLOWED_WRITES: POST
 *      https://pm.operationsdirector.co.uk/login-airtable, exactly that, no
 *      query. It is Property Manager signing Kevin in: the page sends the app's
 *      Airtable key to Kevin's own Worker, which asks Airtable whose key it is,
 *      checks it can read one task, and returns a signed session. It writes no
 *      data (workers/property-manager/worker.js handleLoginAirtable); it ticks
 *      the Worker's sign-in rate limit, 5 a minute. It goes out only when the
 *      caller counts it: each one is listed as `writesAllowed` on the page that
 *      sent it, with a total at the top. Any other method, path or host is
 *      blocked as before.
 *   6. Prints one JSON result: per page PASS / WARN / FAIL. A page that stops at
 *      its own entry gate (who is viewing, a Google sign-in, its own token
 *      screen, still loading) is WARN with the gate named, never PASS: it
 *      rendered, but its data went unchecked. A frame whose text is still a
 *      "Loading..." line is read again until it changes or its 30 seconds run
 *      out. Two gates have no read-only way through and stay WARN:
 *        - Inbound Comms (follow-up.html) reads Gmail with a Google access token
 *          it gets from Google's own consent pop-up, kept in sessionStorage. Only
 *          Kevin's Google session can issue one; the walk has none and never
 *          signs in to Google.
 *        - CRM (crm-supabase.html) reads the parked Supabase build and needs a
 *          Supabase session, which only a Supabase password or email-link
 *          sign-in issues. The walk holds no such session and never signs in
 *          with a password.
 *      Errors from telemetry hosts and
 *      browser extensions are counted as outsideNoise, never as a failure.
 *      Error text and leak snippets are short and scrubbed. Every DISTINCT
 *      console error and leak snippet is kept, up to 50 per list, beside a
 *      total count, and `truncated` says when a list hit 50. Error text has the
 *      walked origin stripped before it is cut, so the same error reads the
 *      same on the live app and on a local copy (29 Sep 2026: the merge gate
 *      compares the two, and a cap of 3 hid a new 4th error).
 *
 * Usage:  node scripts/prod-walk.js [--base URL] [--settle-ms N] [--only id1,id2]
 *         Run it with a 10-minute command timeout: it stops itself at 8.
 * Exit:   0 no page FAILED, 1 a page FAILED or was not reached, 2 cannot run
 *         (an empty --only, no token file, no Playwright, a --base that is not
 *         the app), 3 the walk did not happen (never signed in, site
 *         unreachable, empty page catalogue).
 * Guarded by tests/prod-walk.test.js.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_BASE = 'https://app.operationsdirector.co.uk/';
const PAT_FILE = path.join(os.homedir(), '.config/od/airtable_pat');
// Measured 1 Aug 2026: auth completes well before the ~8,800-record fetch does,
// so the sign-in check polls rather than waits a fixed time.
const SIGNIN_BUDGET_MS = 150000;
// The robot's shell allows at most 10 minutes for one command. A walk killed by
// that prints nothing, so the walk stops itself first and says what it missed.
const TOTAL_BUDGET_MS = 480000;
const FRAME_BUDGET_MS = 30000;
// The budget is checked between pages. A page that hangs inside one step would
// run past it into the command timeout and print nothing, so a hard stop prints
// what was walked and exits 1 first.
const HARD_STOP_MS = 560000;
// A panel shorter than this after settling is blank.
const MIN_CHARS = 40;

// A broken value leaking into the page. The value-shaped ones are FAILs: an
// object, money or a percentage, a value after a label ("Voids: NaN", "Tenant:
// undefined") and a count with a unit ("NaN days"). A bare "undefined" or "NaN"
// elsewhere can be someone's own words (a task titled "pnl NaN leak" on the
// agents page), so it is a WARN the slot reads, never a FAIL on its own.
const HARD_LEAK_RE = /\[object Object\]|£\s?NaN|NaN\s?%|[:=]\s*(NaN|undefined)\b|\bNaN\s+(days?|weeks?|months?|years?|hours?|units?|rooms?|tenants?|tasks?)\b/g;
const SOFT_LEAK_RE = /\bundefined\b|\bNaN\b/g;

// A page that stops at its own entry gate rendered, but its data went unchecked.
// Measured 27 Sep 2026: Tasks asks "Who are you?", Inbound Comms asks for a
// Google sign-in, Systemisation sat on "Loading..." for 30 seconds. The walk
// never signs in to Google. Since 29 Sep 2026 it remembers Kevin, and only
// Kevin, as the Tasks viewer (TASK_VIEWER), so a "Who are you?" now means that
// remembered identity stopped working.
const GATES = [
  [/Who are you\?/, 'asks who is viewing'],
  [/Sign in with (your )?Google/i, 'asks for a Google sign-in'],
  [/Personal Access Token|Sign in from the main app|passcode/i, 'shows its own sign-in screen'],
  [/\bLoading\b[^\n]{0,40}(\.\.\.|…)/, 'still loading'],
];

// Registry pages that live on another host of Kevin's (Content Machine). Their
// uncaught exceptions are the app's, not outside noise.
const APP_HOSTS = ['https://chaichoong.github.io'];

// Hosts that are never the app: telemetry and browser extensions. Everything
// else, including the Google and CDN hosts the app calls on purpose, is charged
// to the app. On 27 Sep 2026 the first walk failed three pages on these alone.
const NOISE_RE = /^(chrome-extension:|https?:\/\/(csi\.gstatic\.com|[^/]*datadoghq\.com|[^/]*google-analytics\.com|[^/]*googletagmanager\.com|[^/]*doubleclick\.net)(\/|$))/;

// ─── pure helpers (tested) ───────────────────────────────────────────────

let SECRET = '';

/** Replace every occurrence of the secret. A short or missing secret is left
 *  alone rather than scrubbing half the output. */
function scrub(text, secret = SECRET) {
  const s = String(text == null ? '' : text);
  if (!secret || secret.length < 20) return s;
  return s.split(secret).join('[REDACTED]');
}

/** Scrub FIRST, then cut. Cutting first can leave a partial token that the
 *  final scrub no longer recognises. */
function clip(text, n, secret = SECRET) {
  return scrub(text, secret).slice(0, n);
}

// Every list the merge gate compares between two walks (live, then the PR) keeps
// each DISTINCT entry up to this many, beside a total count. Until 29 Sep 2026 a
// page kept its first 3 errors, so a PR that added a 4th to a page already
// showing 3 compared as unchanged.
const LIST_CAP = 50;

/** Add an entry only when it is new and the list has room. */
function pushDistinct(list, item, cap = LIST_CAP) {
  if (list.length < cap && !list.includes(item)) list.push(item);
}

/** Short scrubbed context around each match: every distinct one up to the
 *  cap, and the count of every match, repeats included. */
function snippets(text, re, secret = SECRET) {
  const t = scrub(text, secret);
  const list = [];
  let count = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(t))) {
    count += 1;
    pushDistinct(list, t.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).replace(/\s+/g, ' ').trim());
  }
  return { list, count };
}

function findLeaks(text, secret = SECRET) {
  const hard = snippets(text, HARD_LEAK_RE, secret);
  const soft = snippets(text, SOFT_LEAK_RE, secret);
  return { hard: hard.list, soft: soft.list, hardCount: hard.count, softCount: soft.count };
}

/** Remove the walked origin, so "/js/x.js" reads the same on the live app and
 *  on a local copy served from http://127.0.0.1:<port>. */
function stripOrigin(s, origin) {
  const t = String(s == null ? '' : s);
  return origin ? t.split(origin).join('') : t;
}

/** One console error as "message @ path". The origin is stripped from both
 *  BEFORE either is cut, and each is cut on its own (message 200, path 120):
 *  cutting "message @ full URL" at 200 cut the same message at a different
 *  point on each origin, so an unchanged error read as new. */
function errorLine(text, url, origin, secret = SECRET) {
  const msg = clip(stripOrigin(text, origin), 200, secret);
  const path = clip(stripOrigin(String(url == null ? '' : url).split(/[?#]/)[0], origin), 120, secret);
  return path ? msg + ' @ ' + path : msg;
}

/** Charge one error to a page record: counted always, listed once. */
function recordError(rec, line) {
  rec.consoleErrorCount = (rec.consoleErrorCount || 0) + 1;
  pushDistinct(rec.consoleErrors, line);
}

/** One page as printed. Every field the Sunday slot already reads keeps its
 *  name and meaning; the counts and `truncated` are additions. `truncated` is
 *  true when any compared list reached the cap, so a comparison knows it may
 *  not have seen everything. */
function pageReport(r) {
  const errs = r.consoleErrors || [], leaks = r.leaks || [], soft = r.softLeaks || [];
  return {
    id: r.id, name: r.name, kind: r.kind, status: r.status, chars: r.chars, frame: r.frame,
    gate: r.gate || undefined, httpStatus: r.httpStatus, error: r.error,
    // The merge gate reads this: a hidden panel still has innerText (29 Sep 2026).
    rendered: r.rendered,
    consoleErrors: errs.slice(0, LIST_CAP), consoleErrorCount: r.consoleErrorCount || 0,
    failedRequests: (r.failedRequests || []).slice(0, 3),
    leaks: leaks.slice(0, LIST_CAP), softLeaks: soft.slice(0, LIST_CAP),
    leakCount: r.leakCount || 0, softLeakCount: r.softLeakCount || 0,
    truncated: [errs, leaks, soft].some(l => l.length >= LIST_CAP),
    writesBlocked: (r.writesBlocked || []).slice(0, 5),
    // The named exceptions this page sent (ALLOWED_WRITES), listed like blocks.
    writesAllowed: (r.writesAllowed || []).slice(0, 5),
  };
}

/** The sign-in's errors, as the top-level fields of the result. */
function bootReport(boot) {
  const errs = boot.consoleErrors || [];
  return { bootErrors: errs.slice(0, LIST_CAP), bootErrorCount: boot.consoleErrorCount || 0,
           bootTruncated: errs.length >= LIST_CAP };
}

/** The gate a page stopped at, or '' when it showed its content. Only a short
 *  page can be a gate: a long page that mentions sign-in is showing content. */
function findGate(text) {
  const t = String(text || '').trim();
  if (t.length > 1500) return '';
  for (const [re, label] of GATES) if (re.test(t)) return label;
  return '';
}

/** A frame has settled when its text is long enough, the same length as on
 *  the last read, and not a "Loading..." line. A loading line holds still for
 *  seconds while the page waits for its data (Property Manager's first read
 *  takes several), and judging it then called a working page a gate. */
function frameSettled(text, lastLength) {
  const n = String(text || '').trim().length;
  return n >= MIN_CHARS && n === lastLength && findGate(text) !== 'still loading';
}

// Who is viewing, for the Tasks page (os/tasks/index.html). It remembers its
// viewer in localStorage `_task_user` as selectIdentity() writes it: that TEAM
// entry's key, name and email. The walk holds Kevin's token, so it views as
// Kevin and never as anyone else. A test runs the page's own initIdentity() on
// this value and checks it is Kevin's TEAM entry, so a change there is loud.
const TASK_VIEWER = Object.freeze({ key: 'kevin', name: 'Kevin Brittain', email: 'kevin@runpreneur.org.uk' });

/** The app origin's localStorage as a returning Kevin has it: the token under
 *  both keys the app reads, and the Tasks viewer. */
function seedStorage(secret = SECRET) {
  return [
    { name: '_dlr_pat', value: secret },
    { name: 'airtable_pat', value: secret },
    { name: '_task_user', value: JSON.stringify(TASK_VIEWER) },
  ];
}

function isNoise(url) {
  return NOISE_RE.test(String(url || ''));
}

/** Charge an uncaught exception to the app only when its stack runs through the
 *  app, or names no URL at all. A Google sign-in frame throwing is not the app. */
function isAppError(stack, origin) {
  const urls = String(stack || '').match(/(https?|chrome-extension):\/\/[^\s)]+/g) || [];
  if (!urls.length) return true;
  return urls.some(u => [origin, ...APP_HOSTS].some(o => u === o || u.startsWith(o + '/')));
}

/** Only the live app, or a local copy of it, may be walked: the token goes to
 *  whatever site this is. Returns the normalised base, or '' to refuse. */
function allowedBase(url) {
  let u;
  try { u = new URL(url); } catch (e) { return ''; }
  const live = u.protocol === 'https:' && u.host === 'app.operationsdirector.co.uk';
  const local = u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  if (!live && !local) return '';
  return u.origin + '/';
}

/** How to reach a registry entry: 'shell' when the app has its panel, else the
 *  standalone page with any #hash dropped. */
function routeFor(entry, hasPanel) {
  if (hasPanel) return { kind: 'shell' };
  const file = String((entry && entry.standalone) || '').split('#')[0];
  if (!file) return { kind: 'none' };
  return { kind: 'page', file };
}

/** PASS / WARN / FAIL for one visited page. */
function classify(r) {
  if (r.error) return 'FAIL';
  if (r.httpStatus && r.httpStatus >= 400) return 'FAIL';
  if (!r.rendered) return 'FAIL';
  if ((r.chars || 0) < MIN_CHARS) return 'FAIL';
  if ((r.consoleErrors || []).length) return 'FAIL';
  if ((r.leaks || []).length) return 'FAIL';
  if (r.gate) return 'WARN';
  if ((r.softLeaks || []).length) return 'WARN';
  if ((r.failedRequests || []).length) return 'WARN';
  return 'PASS';
}

function summarise(pages) {
  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const p of pages) counts[p.status] = (counts[p.status] || 0) + 1;
  return counts;
}

/** The ids named by --only: split on commas, trimmed, blanks and repeats
 *  dropped. An empty list means --only was given with nothing in it. */
function parseOnly(raw) {
  const out = [];
  for (const id of String(raw == null ? '' : raw).split(',').map(s => s.trim())) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The registry entries to walk. With no --only (null), every entry. With
 *  --only, the named entries in the registry's own order, plus the ids the
 *  registry does not have, which the walk reports as FAILs. */
function selectEntries(registry, only) {
  const reg = Array.isArray(registry) ? registry : [];
  if (only == null) return { entries: reg.slice(), missing: [] };
  const want = parseOnly(Array.isArray(only) ? only.join(',') : only);
  const have = new Set(reg.map(e => e && e.id));
  return {
    entries: reg.filter(e => e && want.includes(e.id)),
    missing: want.filter(id => !have.has(id)),
  };
}

// Methods that only read. Everything else is a write and is never sent.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True for any method that is not GET, HEAD or OPTIONS, in any case. A
 *  missing method counts as a write: the block fails closed. */
function isWrite(method) {
  return !READ_METHODS.has(String(method == null ? '' : method).trim().toUpperCase());
}

/** "METHOD host/path" for a blocked write: no query string, no hash, scrubbed. */
function describeWrite(method, url, secret = SECRET) {
  const m = String(method == null ? '' : method).toUpperCase() || '?';
  let where;
  try {
    const u = new URL(url);
    where = u.host + u.pathname;
  } catch (e) {
    where = String(url == null ? '' : url).split(/[?#]/)[0];
  }
  return clip(m + ' ' + where, 160, secret);
}

// What a blocked write gets back. It satisfies both Airtable shapes (a batch
// reads `records`, a single write reads `id` and `fields`), so page code that
// awaits the write does not throw on the block and charge an error to itself.
const BLOCKED_BODY = JSON.stringify({ records: [], id: 'recBLOCKEDBYWALK', fields: {}, blockedByWalk: true });

// The only writes the walk lets out: each a method, an origin and an exact path.
// Property Manager's sign-in (29 Sep 2026): the Worker's handleLoginAirtable
// makes two Airtable GETs (whoami, one task) and signs a session. It stores
// nothing and writes no record. Its passcode sign-in (/login) and every data
// write (/task/<id>, /growth-plan/<what>) stay blocked. Add to this list only
// what has been read end to end and proved to write nothing.
const ALLOWED_WRITES = Object.freeze([
  Object.freeze({ method: 'POST', origin: 'https://pm.operationsdirector.co.uk', path: '/login-airtable' }),
]);

/** True only for a request ALLOWED_WRITES names exactly: same method, same
 *  origin (https, that host), same path, and no query, hash or user name.
 *  Anything else, a trailing slash included, is false, so it is blocked. */
function allowedWrite(method, url) {
  const m = String(method == null ? '' : method).toUpperCase();
  let u;
  try { u = new URL(String(url == null ? '' : url)); } catch (e) { return false; }
  if (u.username || u.password || u.search || u.hash) return false;
  return ALLOWED_WRITES.some(w => w.method === m && w.origin === u.origin && w.path === u.pathname);
}

/** Route every request in the context: reads go out, writes never do. Each
 *  blocked write is answered locally and passed to onBlocked("METHOD host/path").
 *  Cross-origin callers get CORS headers so the page reads the answer.
 *  A write allowedWrite() names goes out only when onAllowed is given and
 *  counts it without throwing; otherwise it is blocked like any other write.
 *  Reads and allowed writes use fallback(), which sends them exactly as
 *  continue() does when no other route matches (the walk has none); a test
 *  that stands in for a server by routing it first receives them instead. */
async function blockWrites(ctx, onBlocked, onAllowed) {
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    if (!isWrite(req.method())) return route.fallback();
    if (typeof onAllowed === 'function' && allowedWrite(req.method(), req.url())) {
      // An exception nobody counted is not taken: a reporting fault blocks it.
      let counted = false;
      try { onAllowed(describeWrite(req.method(), req.url())); counted = true; } catch (e) {
        process.stderr.write('prod-walk: an allowed write could not be counted, so it was blocked: ' + clip(e && e.message, 120) + '\n');
      }
      if (counted) return route.fallback();
    }
    // Reporting must never decide whether a write goes out: log the fault, block anyway.
    try { onBlocked(describeWrite(req.method(), req.url())); } catch (e) {
      process.stderr.write('prod-walk: a write was blocked but could not be logged: ' + clip(e && e.message, 120) + '\n');
    }
    const origin = (req.headers() || {}).origin;
    const headers = origin
      ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' }
      : { 'access-control-allow-origin': '*' };
    return route.fulfill({ status: 200, contentType: 'application/json', headers, body: BLOCKED_BODY });
  });
}

/** Charge a page's console errors, uncaught exceptions and failed requests to
 *  whichever record getCurrent() returns (none while no record is open). */
function attachHooks(page, origin, getCurrent) {
  page.on('console', (m) => {
    const current = getCurrent();
    if (m.type() !== 'error' || !current) return;
    const where = (m.location() || {}).url || '';
    const text = m.text();
    // A 429 is Airtable's rate limit, which airtableFetch retries.
    if (isNoise(where) || /status of 429/.test(text)) { current.outsideNoise += 1; return; }
    recordError(current, errorLine(text, where, origin));
  });
  page.on('pageerror', (e) => {
    const current = getCurrent();
    if (!current) return;
    if (isAppError(e.stack, origin)) recordError(current, errorLine('pageerror: ' + e.message, '', origin));
    else current.outsideNoise += 1;
  });
  page.on('requestfailed', (r) => {
    const current = getCurrent();
    if (!current) return;
    const why = (r.failure() || {}).errorText || '';
    if (isNoise(r.url()) || /ERR_ABORTED/.test(why)) { current.outsideNoise += 1; return; }
    current.failedRequests.push(clip(why + ' ' + stripOrigin(r.url().split('?')[0], origin), 140));
  });
  page.on('response', (r) => {
    const current = getCurrent();
    if (current && r.status() >= 400 && r.status() !== 429 && !isNoise(r.url())) {
      current.failedRequests.push(clip(r.status() + ' ' + stripOrigin(r.url().split('?')[0], origin), 140));
    }
  });
}

// ─── the walk ────────────────────────────────────────────────────────────

function loadChromium() {
  for (const mod of ['playwright-core', '@playwright/test', path.join(REPO, 'node_modules', 'playwright-core')]) {
    try { return require(mod).chromium; } catch (e) { /* try the next */ }
  }
  return null;
}

/** `only` is null when --only is absent, else the list of ids it named (which
 *  can be empty: main() refuses that before it reads the token). */
function args(argv) {
  const a = { base: DEFAULT_BASE, settleMs: 3500, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') a.base = argv[++i];
    else if (argv[i] === '--settle-ms') a.settleMs = Number(argv[++i]) || a.settleMs;
    else if (argv[i] === '--only') a.only = parseOnly(argv[++i]);
    else if (String(argv[i]).startsWith('--only=')) a.only = parseOnly(String(argv[i]).slice('--only='.length));
  }
  return a;
}

/** Print once, scrubbed, and exit only after the write has drained: a pipe
 *  cuts a larger write short when process.exit follows it at once. */
function finish(result, code) {
  process.stdout.write(scrub(JSON.stringify(result, null, 2)) + '\n', () => process.exit(code));
}

// A page that renders its own sign-in form, in the page or in a panel's frame.
function authFormVisible() {
  const shown = (el) => !!el && el.offsetParent !== null;
  return shown(document.querySelector('input[type=password]')) ||
    ['patInput', 'authScreen', 'loginNote'].some(id => shown(document.getElementById(id)));
}

// The pages walked so far, for the hard stop.
const DONE = [];
// Every write the route blocked (total) and every named exception it let out
// (allowed), whichever page (or none) was current.
const WRITES = { total: 0, allowed: 0 };

async function main() {
  const a = args(process.argv.slice(2));
  const started = Date.now();
  // Before the token is read or a browser starts: an empty --only would walk
  // nothing and report a pass.
  if (a.only && !a.only.length) {
    return finish({ ok: false, ran: false, only: a.only, reason: 'refused --only: it names no page ids, so the walk would check nothing' }, 2);
  }
  setTimeout(() => finish({ ok: false, ran: true, reason: `HARD STOP: a page hung past ${HARD_STOP_MS / 1000}s; the pages after the last one listed were not walked`,
                            only: a.only, pagesWalked: DONE.length, counts: summarise(DONE), writesBlocked: WRITES.total,
                            writesAllowed: WRITES.allowed,
                            pages: DONE.map(({ id, status, gate, error, writesBlocked, writesAllowed }) =>
                              ({ id, status, gate: gate || undefined, error, writesBlocked: (writesBlocked || []).slice(0, 5),
                                 writesAllowed: (writesAllowed || []).slice(0, 5) })) }, 1),
             HARD_STOP_MS).unref();
  const base = allowedBase(a.base);
  if (!base) return finish({ ok: false, ran: false, reason: 'refused --base: only the live app or a local copy may be walked' }, 2);
  try { SECRET = fs.readFileSync(PAT_FILE, 'utf8').trim(); } catch (e) { /* reported below */ }
  if (SECRET.length < 40) return finish({ ok: false, ran: false, reason: `no usable token file at ${PAT_FILE}` }, 2);
  const chromium = loadChromium();
  if (!chromium) return finish({ ok: false, ran: false, reason: 'playwright not found; run npm install in the repo' }, 2);

  const origin = new URL(base).origin;
  const launch = { headless: true };
  // Kevin's installed Chrome, as agent-browser.js does: the bundled test build
  // is not installed on every Mac (the Mac mini had none on 27 Sep 2026).
  if (fs.existsSync('/Applications/Google Chrome.app')) launch.channel = 'chrome';
  let browser;
  try { browser = await chromium.launch(launch); } catch (e) {
    return finish({ ok: false, ran: false, reason: 'browser would not start: ' + clip(e.message, 200) }, 2);
  }
  try {
    return await walk(browser, a, base, origin, started);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function walk(browser, a, base, origin, started) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // A service worker's own fetches would not pass through the route below.
    serviceWorkers: 'block',
    storageState: { cookies: [], origins: [{ origin, localStorage: seedStorage(SECRET) }] },
  });

  let current = null;           // the page record errors are charged to
  const idleWrites = [];        // writes tried while no page record was open
  const idleAllowed = [];       // named exceptions sent while no page record was open
  // Installed before the first page opens, so nothing is ever sent unrouted.
  await blockWrites(ctx, (label) => {
    WRITES.total += 1;
    const list = current ? current.writesBlocked : idleWrites;
    if (list.length < 5) list.push(label);
  }, (label) => {
    WRITES.allowed += 1;
    const list = current ? current.writesAllowed : idleAllowed;
    if (list.length < 5) list.push(label);
  });
  const hook = (page) => attachHooks(page, origin, () => current);

  // An iframe panel loads its page only once the tab opens, then fetches its
  // own data. Read the frame (Playwright reaches cross-origin frames too) until
  // its text stops growing, rather than judging the empty frame at once.
  const readFrame = async (page, handle) => {
    let last = -1, text = '', gated = false, url = '';
    const until = Date.now() + FRAME_BUDGET_MS;
    while (Date.now() < until) {
      const fr = await handle.contentFrame().catch(() => null);
      if (fr && fr.url() && fr.url() !== 'about:blank') {
        url = fr.url();
        text = await fr.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
        gated = await fr.evaluate(authFormVisible).catch(() => false);
        if (frameSettled(text, last)) break;
        last = text.trim().length;
      }
      await page.waitForTimeout(2500);
    }
    return { text, gated, url };
  };

  const page = await ctx.newPage();
  hook(page);
  const boot = { id: '(sign-in)', consoleErrors: [], consoleErrorCount: 0, failedRequests: [], outsideNoise: 0, writesBlocked: [], writesAllowed: [] };
  current = boot;
  let signedIn = null;
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const deadline = Date.now() + SIGNIN_BUDGET_MS;
    while (Date.now() < deadline) {
      signedIn = await page.evaluate(() => {
        try {
          // Bare identifiers: script-scope globals, not window properties.
          // eslint-disable-next-line no-undef
          const ok = typeof PAT === 'string' && PAT.length > 40 && typeof allTransactions !== 'undefined' && allTransactions.length > 0;
          // eslint-disable-next-line no-undef
          return ok ? { transactions: allTransactions.length } : null;
        } catch (e) { return null; }
      }).catch(() => null);
      if (signedIn) break;
      await page.waitForTimeout(5000);
    }
  } catch (e) {
    return finish({ ok: false, ran: false, reason: 'could not open ' + base + ': ' + clip(e.message, 200) }, 3);
  }
  if (!signedIn) {
    return finish({ ok: false, ran: false, reason: `NOT SIGNED IN: no data loaded within ${SIGNIN_BUDGET_MS / 1000}s`,
                    only: a.only, ...bootReport(boot),
                    writesBlocked: WRITES.total, bootWritesBlocked: boot.writesBlocked,
                    writesAllowed: WRITES.allowed, bootWritesAllowed: boot.writesAllowed }, 3);
  }

  const registry = await page.evaluate(() => {
    // eslint-disable-next-line no-undef
    const reg = typeof PAGE_REGISTRY !== 'undefined' ? PAGE_REGISTRY : [];
    return reg.map(p => ({ id: p.id, name: p.name, standalone: p.standalone || '',
                           hasPanel: !!document.getElementById('tab-' + p.id) }));
  });
  // CONTROL: an empty catalogue reads as "nothing to walk" for ever.
  if (!registry.length) {
    return finish({ ok: false, ran: false, only: a.only, reason: 'PAGE_REGISTRY read as empty on a signed-in app: the walk would pass on nothing' }, 3);
  }

  const { entries, missing } = selectEntries(registry, a.only);
  const pages = [];
  for (const entry of entries) {
    const r = { id: entry.id, name: entry.name, consoleErrors: [], consoleErrorCount: 0, failedRequests: [], leaks: [], softLeaks: [],
                leakCount: 0, softLeakCount: 0, outsideNoise: 0, writesBlocked: [], writesAllowed: [] };
    if (Date.now() - started > TOTAL_BUDGET_MS) {
      r.error = `not reached: the ${TOTAL_BUDGET_MS / 60000}-minute budget ran out first`;
      r.status = classify(r);
      pages.push(r);
      continue;
    }
    current = r;
    const route = routeFor(entry, entry.hasPanel);
    r.kind = route.kind;
    let p2 = null;
    try {
      let text = '';
      let gated = false;
      if (route.kind === 'shell') {
        await page.evaluate((id) => { window.switchTab(id); }, entry.id);
        await page.waitForTimeout(a.settleMs);
        const seen = await page.evaluate((id) => {
          const el = document.getElementById('tab-' + id);
          if (!el) return { rendered: false, text: '' };
          return { rendered: el.classList.contains('active') && el.offsetParent !== null, text: el.innerText || '' };
        }, entry.id);
        r.rendered = seen.rendered;
        text = seen.text;
        const frame = await page.$('#tab-' + entry.id + ' iframe');
        if (frame) {
          r.kind = 'shell+iframe';
          const f = await readFrame(page, frame);
          r.frame = { url: clip(f.url.split('?')[0].replace(origin, ''), 120), chars: f.text.trim().length };
          gated = f.gated;
          text += '\n' + f.text;
          // Stop the frame, so its polling cannot charge errors to later pages.
          await frame.evaluate((el) => { el.src = 'about:blank'; }).catch(() => {});
        }
      } else if (route.kind === 'page') {
        p2 = await ctx.newPage();
        hook(p2);
        const resp = await p2.goto(base + route.file, { waitUntil: 'domcontentloaded', timeout: 60000 });
        r.httpStatus = resp ? resp.status() : 0;
        await p2.waitForTimeout(a.settleMs + 2000);
        text = await p2.evaluate(() => (document.body && document.body.innerText) || '');
        gated = await p2.evaluate(authFormVisible).catch(() => false);
        r.rendered = true;
      } else {
        r.error = 'no panel and no standalone page';
      }
      r.chars = text.trim().length;
      const leaks = findLeaks(text);
      r.leaks = leaks.hard;
      r.softLeaks = leaks.soft;
      r.leakCount = leaks.hardCount;
      r.softLeakCount = leaks.softCount;
      r.gate = findGate(text) || (gated ? 'shows its own sign-in screen' : '');
    } catch (e) {
      r.error = clip(e.message, 200);
    } finally {
      if (p2) await p2.close().catch(() => {});
    }
    current = null;
    r.status = classify(r);
    pages.push(r);
    DONE.push(r);
  }
  // A --only id the live registry does not have: a stale map, never a silent skip.
  for (const id of missing) {
    const r = { id, name: '', consoleErrors: [], consoleErrorCount: 0, failedRequests: [], leaks: [], softLeaks: [],
                leakCount: 0, softLeakCount: 0, outsideNoise: 0, writesBlocked: [], writesAllowed: [], error: 'not in PAGE_REGISTRY' };
    r.status = classify(r);
    pages.push(r);
    DONE.push(r);
  }

  const counts = summarise(pages);
  const result = {
    ok: counts.FAIL === 0,
    ran: true,
    mode: a.only ? 'ONLY (signed in, scripted, named pages)' : 'FULL (signed in, scripted)',
    base,
    only: a.only,
    signedIn: true,
    records: signedIn,
    pagesWalked: pages.length,
    counts,
    writesBlocked: WRITES.total,
    bootWritesBlocked: boot.writesBlocked,
    idleWritesBlocked: idleWrites,
    writesAllowed: WRITES.allowed,
    bootWritesAllowed: boot.writesAllowed,
    idleWritesAllowed: idleAllowed,
    ...bootReport(boot),
    bootFailedRequests: boot.failedRequests.slice(0, 5),
    outsideNoise: pages.reduce((n, p) => n + p.outsideNoise, boot.outsideNoise),
    pages: pages.map(pageReport),
    seconds: Math.round((Date.now() - started) / 1000),
  };
  return finish(result, result.ok ? 0 : 1);
}

module.exports = { scrub, clip, findLeaks, findGate, isNoise, isAppError, allowedBase, routeFor, classify, summarise, MIN_CHARS,
                   args, parseOnly, selectEntries, isWrite, describeWrite, blockWrites, BLOCKED_BODY,
                   LIST_CAP, stripOrigin, errorLine, recordError, pageReport, bootReport, attachHooks,
                   frameSettled, TASK_VIEWER, seedStorage, ALLOWED_WRITES, allowedWrite };

if (require.main === module) {
  main().catch((e) => {
    finish({ ok: false, ran: false, reason: 'walk crashed: ' + clip(e && e.message, 300) }, 2);
  });
}
