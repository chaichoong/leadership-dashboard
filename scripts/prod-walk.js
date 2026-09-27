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
 *   3. Waits until the data has actually loaded (bare `PAT` and `allTransactions`,
 *      never the `window.` forms, which are undefined on a healthy app).
 *   4. Reads PAGE_REGISTRY live and visits every entry: a tab with a `tab-<id>`
 *      panel through switchTab(), reading the page inside its iframe when it has
 *      one, anything else by opening its standalone page. It clicks nothing, so
 *      it can never create, approve, pay or send.
 *   5. Prints one JSON result: per page PASS / WARN / FAIL. A page that stops at
 *      its own entry gate (who is viewing, a Google sign-in, its own token
 *      screen, still loading) is WARN with the gate named, never PASS: it
 *      rendered, but its data went unchecked. Errors from telemetry hosts and
 *      browser extensions are counted as outsideNoise, never as a failure.
 *      Error text and leak snippets are short and scrubbed.
 *
 * Usage:  node scripts/prod-walk.js [--base URL] [--settle-ms N]
 *         Run it with a 10-minute command timeout: it stops itself at 8.
 * Exit:   0 no page FAILED, 1 a page FAILED or was not reached, 2 cannot run
 *         (no token file, no Playwright, a --base that is not the app),
 *         3 the walk did not happen (never signed in, site unreachable, empty
 *         page catalogue).
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
// never picks an identity or signs in to Google.
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

/** Short scrubbed context around each match, at most three. */
function snippets(text, re, secret = SECRET) {
  const t = scrub(text, secret);
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(t)) && out.length < 3) {
    out.push(t.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).replace(/\s+/g, ' ').trim());
  }
  return out;
}

function findLeaks(text, secret = SECRET) {
  return { hard: snippets(text, HARD_LEAK_RE, secret), soft: snippets(text, SOFT_LEAK_RE, secret) };
}

/** The gate a page stopped at, or '' when it showed its content. Only a short
 *  page can be a gate: a long page that mentions sign-in is showing content. */
function findGate(text) {
  const t = String(text || '').trim();
  if (t.length > 1500) return '';
  for (const [re, label] of GATES) if (re.test(t)) return label;
  return '';
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

// ─── the walk ────────────────────────────────────────────────────────────

function loadChromium() {
  for (const mod of ['playwright-core', '@playwright/test', path.join(REPO, 'node_modules', 'playwright-core')]) {
    try { return require(mod).chromium; } catch (e) { /* try the next */ }
  }
  return null;
}

function args(argv) {
  const a = { base: DEFAULT_BASE, settleMs: 3500 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') a.base = argv[++i];
    else if (argv[i] === '--settle-ms') a.settleMs = Number(argv[++i]) || a.settleMs;
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

async function main() {
  const a = args(process.argv.slice(2));
  const started = Date.now();
  setTimeout(() => finish({ ok: false, ran: true, reason: `HARD STOP: a page hung past ${HARD_STOP_MS / 1000}s; the pages after the last one listed were not walked`,
                            pagesWalked: DONE.length, counts: summarise(DONE),
                            pages: DONE.map(({ id, status, gate, error }) => ({ id, status, gate: gate || undefined, error })) }, 1),
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
    storageState: { cookies: [], origins: [{ origin, localStorage: [
      { name: '_dlr_pat', value: SECRET }, { name: 'airtable_pat', value: SECRET }] }] },
  });

  let current = null;           // the page record errors are charged to
  const hook = (page) => {
    page.on('console', (m) => {
      if (m.type() !== 'error' || !current) return;
      const where = (m.location() || {}).url || '';
      const text = m.text();
      // A 429 is Airtable's rate limit, which airtableFetch retries.
      if (isNoise(where) || /status of 429/.test(text)) { current.outsideNoise += 1; return; }
      current.consoleErrors.push(clip(text + (where ? ' @ ' + where.split('?')[0] : ''), 200));
    });
    page.on('pageerror', (e) => {
      if (!current) return;
      if (isAppError(e.stack, origin)) current.consoleErrors.push(clip('pageerror: ' + e.message, 200));
      else current.outsideNoise += 1;
    });
    page.on('requestfailed', (r) => {
      if (!current) return;
      const why = (r.failure() || {}).errorText || '';
      if (isNoise(r.url()) || /ERR_ABORTED/.test(why)) { current.outsideNoise += 1; return; }
      current.failedRequests.push(clip(why + ' ' + r.url().split('?')[0], 140));
    });
    page.on('response', (r) => {
      if (current && r.status() >= 400 && r.status() !== 429 && !isNoise(r.url())) {
        current.failedRequests.push(clip(r.status() + ' ' + r.url().split('?')[0], 140));
      }
    });
  };

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
        const n = text.trim().length;
        if (n >= MIN_CHARS && n === last) break;
        last = n;
      }
      await page.waitForTimeout(2500);
    }
    return { text, gated, url };
  };

  const page = await ctx.newPage();
  hook(page);
  const boot = { id: '(sign-in)', consoleErrors: [], failedRequests: [], outsideNoise: 0 };
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
                    bootErrors: boot.consoleErrors.slice(0, 5) }, 3);
  }

  const registry = await page.evaluate(() => {
    // eslint-disable-next-line no-undef
    const reg = typeof PAGE_REGISTRY !== 'undefined' ? PAGE_REGISTRY : [];
    return reg.map(p => ({ id: p.id, name: p.name, standalone: p.standalone || '',
                           hasPanel: !!document.getElementById('tab-' + p.id) }));
  });
  // CONTROL: an empty catalogue reads as "nothing to walk" for ever.
  if (!registry.length) {
    return finish({ ok: false, ran: false, reason: 'PAGE_REGISTRY read as empty on a signed-in app: the walk would pass on nothing' }, 3);
  }

  const pages = [];
  for (const entry of registry) {
    const r = { id: entry.id, name: entry.name, consoleErrors: [], failedRequests: [], leaks: [], softLeaks: [], outsideNoise: 0 };
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

  const counts = summarise(pages);
  const result = {
    ok: counts.FAIL === 0,
    ran: true,
    mode: 'FULL (signed in, scripted)',
    base,
    signedIn: true,
    records: signedIn,
    pagesWalked: pages.length,
    counts,
    bootErrors: boot.consoleErrors.slice(0, 5),
    bootFailedRequests: boot.failedRequests.slice(0, 5),
    outsideNoise: pages.reduce((n, p) => n + p.outsideNoise, boot.outsideNoise),
    pages: pages.map(({ id, name, kind, status, chars, frame, gate, httpStatus, error, consoleErrors, failedRequests, leaks, softLeaks }) =>
      ({ id, name, kind, status, chars, frame, gate: gate || undefined, httpStatus, error,
         consoleErrors: consoleErrors.slice(0, 3), failedRequests: failedRequests.slice(0, 3), leaks, softLeaks })),
    seconds: Math.round((Date.now() - started) / 1000),
  };
  return finish(result, result.ok ? 0 : 1);
}

module.exports = { scrub, clip, findLeaks, findGate, isNoise, isAppError, allowedBase, routeFor, classify, summarise, MIN_CHARS };

if (require.main === module) {
  main().catch((e) => {
    finish({ ok: false, ran: false, reason: 'walk crashed: ' + clip(e && e.message, 300) }, 2);
  });
}
