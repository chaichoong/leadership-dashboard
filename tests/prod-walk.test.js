import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { createServer } from 'http';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const SCRIPT = resolve(ROOT, 'scripts/prod-walk.js');
const walk = require(SCRIPT);
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// 27 Sep 2026: prod-sweep-weekly is a headless slot, and its skill told it to use
// mcp__Claude_Browser__* and the Airtable MCP, neither of which exists in a
// headless run. The walk never ran from 13 Sep. scripts/prod-walk.js is the
// robots' route: Playwright, signed in from the token file, read-only.
const ORIGIN = 'https://app.operationsdirector.co.uk';
const SECRET = 'patAbCdEfGhIjKlMnOp.0123456789abcdef0123456789abcdef';

describe('prod-walk.js keeps the token to itself', () => {
  it('refuses to walk any site but the live app or a local copy, before it reads the token', () => {
    for (const bad of ['https://any.example/', 'https://app.operationsdirector.co.uk.evil.example/',
                       'http://app.operationsdirector.co.uk/', 'file:///etc/passwd', 'nonsense']) {
      expect(walk.allowedBase(bad), bad).toBe('');
    }
    expect(walk.allowedBase('https://app.operationsdirector.co.uk')).toBe(ORIGIN + '/');
    expect(walk.allowedBase('http://localhost:8951/x')).toBe('http://localhost:8951/');
  });
  it('exits 2 on a foreign --base, printing no token (drives the real script)', () => {
    let out = '', code = 0;
    try { out = execFileSync('node', [SCRIPT, '--base', 'https://any.example/'], { encoding: 'utf8' }); }
    catch (e) { out = e.stdout; code = e.status; }
    expect(code).toBe(2);
    expect(JSON.parse(out).reason).toMatch(/refused --base/);
  });
  it('removes every copy of the token from what it prints', () => {
    expect(walk.scrub(`a ${SECRET} b ${SECRET}`, SECRET)).toBe('a [REDACTED] b [REDACTED]');
  });
  it('scrubs before it cuts, so a cut can never leave part of the token behind', () => {
    const text = 'x'.repeat(30) + SECRET;
    const out = walk.clip(text, 50, SECRET);
    expect(out).not.toContain(SECRET.slice(0, 10));
    // BACK-TEST: the old order (cut, then scrub) leaves a prefix.
    expect(walk.scrub(text.slice(0, 50), SECRET)).toContain(SECRET.slice(0, 10));
  });
  it('never scrubs with a short or missing secret, which would shred the report', () => {
    expect(walk.scrub('the cat sat', 'at')).toBe('the cat sat');
    expect(walk.scrub('x', '')).toBe('x');
  });
});

describe('prod-walk.js classify', () => {
  const ok = { rendered: true, chars: 500, consoleErrors: [], failedRequests: [], leaks: [], softLeaks: [] };
  it('passes a rendered page with content and no errors', () => {
    expect(walk.classify(ok)).toBe('PASS');
  });
  it('fails a blank panel, an app error, a value-shaped leak, an HTTP error and a page not reached', () => {
    expect(walk.classify({ ...ok, chars: 3 })).toBe('FAIL');
    expect(walk.classify({ ...ok, rendered: false })).toBe('FAIL');
    expect(walk.classify({ ...ok, consoleErrors: ['TypeError: x is undefined'] })).toBe('FAIL');
    expect(walk.classify({ ...ok, leaks: ['Total: £NaN'] })).toBe('FAIL');
    expect(walk.classify({ ...ok, httpStatus: 404 })).toBe('FAIL');
    expect(walk.classify({ ...ok, error: 'not reached: the 8-minute budget ran out first' })).toBe('FAIL');
  });
  it('never passes a page that stopped at its gate: its data went unchecked', () => {
    expect(walk.classify({ ...ok, gate: 'asks who is viewing' })).toBe('WARN');
  });
  it('fails a broken value after a label or with a unit, which a WARN would let through unreported', () => {
    for (const t of ['Voids: NaN', 'Tenant: undefined', 'Arrears for NaN days', 'Rent = NaN']) {
      expect(walk.findLeaks(t, SECRET).hard, t).toHaveLength(1);
    }
    expect(walk.findLeaks('task: fix pnl NaN leak', SECRET).hard).toHaveLength(0);
  });
  it('warns, not fails, on a bare NaN or undefined, which can be someone\'s own words', () => {
    expect(walk.classify({ ...ok, softLeaks: ['task: fix pnl NaN leak'] })).toBe('WARN');
  });
});

describe('prod-walk.js findLeaks', () => {
  it('splits value-shaped leaks from bare words', () => {
    const l = walk.findLeaks('Balance £NaN and [object Object] here; task named undefined thing', SECRET);
    expect(l.hard).toHaveLength(2);
    expect(l.soft).toHaveLength(2);    // the NaN inside £NaN, and "undefined"
  });
  it('scrubs the snippets it returns', () => {
    const l = walk.findLeaks(`${SECRET} [object Object]`, SECRET);
    expect(l.hard.join(' ')).not.toContain(SECRET.slice(0, 10));
  });
});

describe('prod-walk.js findGate', () => {
  it('names the gates measured on 27 Sep 2026, and the pages that show their own token screen', () => {
    expect(walk.findGate('Who are you? Select your name to personalise your task view.')).toBe('asks who is viewing');
    expect(walk.findGate('Inbound Comms Tracker Sign in with your Google account to view emails')).toBe('asks for a Google sign-in');
    expect(walk.findGate('Loading... SOP generated')).toBe('still loading');
    expect(walk.findGate('Payment Run  Loading the week… ')).toBe('still loading');
    expect(walk.findGate('Property Compliance Enter your Airtable Personal Access Token to continue')).toBe('shows its own sign-in screen');
    expect(walk.findGate('CRM Sign in from the main app to see your contacts')).toBe('shows its own sign-in screen');
  });
  it('does not call a long page with sign-in words in it a gate', () => {
    expect(walk.findGate('Who are you? ' + 'real content '.repeat(200))).toBe('');
    expect(walk.findGate('Objective & Strategy Live, linked to Airtable')).toBe('');
  });
});

describe('prod-walk.js noise and app errors', () => {
  it('treats telemetry and extensions as outside noise (the three false FAILs of the first run)', () => {
    expect(walk.isNoise('https://csi.gstatic.com/csi')).toBe(true);
    expect(walk.isNoise('https://logs.browser-intake-datadoghq.com/api/v2/logs')).toBe(true);
    expect(walk.isNoise('chrome-extension://invalid/')).toBe(true);
  });
  it('charges everything else to the app, including the Google and CDN hosts it calls on purpose', () => {
    for (const u of [ORIGIN + '/js/shared.js', 'https://api.airtable.com/v0/app/tbl', 'https://www.googleapis.com/drive/v3',
                     'https://script.google.com/macros/s/x', 'https://cdn.jsdelivr.net/npm/chart.js', '']) {
      expect(walk.isNoise(u), u).toBe(false);
    }
  });
  it('is not fooled by a lookalike telemetry host', () => {
    expect(walk.isNoise('https://csi.gstatic.com.evil.example/x')).toBe(false);
  });
  it('charges an uncaught exception to the app only when its stack runs through the app', () => {
    expect(walk.isAppError(`TypeError: x\n    at render (${ORIGIN}/js/pnl.js:10:5)`, ORIGIN)).toBe(true);
    expect(walk.isAppError('Error: boom', ORIGIN)).toBe(true);
    expect(walk.isAppError('Error: x\n    at https://accounts.google.com/gsi/client:1:2', ORIGIN)).toBe(false);
    // Content Machine is a registry page on Kevin's other host: its crash is the app's.
    expect(walk.isAppError('Error: x\n    at https://chaichoong.github.io/content-machine/app.js:3:1', ORIGIN)).toBe(true);
  });
});

describe('prod-walk.js routeFor', () => {
  it('walks a panel in the shell and anything else as its own page, hash dropped', () => {
    expect(walk.routeFor({ standalone: 'index.html#cfv' }, true)).toEqual({ kind: 'shell' });
    expect(walk.routeFor({ standalone: 'compliance.html' }, false)).toEqual({ kind: 'page', file: 'compliance.html' });
    expect(walk.routeFor({ standalone: 'os/agents/index.html#ceo-brief' }, false)).toEqual({ kind: 'page', file: 'os/agents/index.html' });
    expect(walk.routeFor({ standalone: '' }, false)).toEqual({ kind: 'none' });
  });
});

// 29 Sep 2026: the merge gate (scripts/merge-pr.py) runs this walk against
// UNMERGED code with Kevin's real token, on only the pages a PR touches. Before
// this, "read-only" meant "clicks nothing": any page code that wrote on load
// would have written to live Airtable. Now every non-read method is answered
// locally and never sent, and --only narrows the walk without ever letting a
// stale id walk nothing.
describe('prod-walk.js --only', () => {
  const reg = [{ id: 'overview' }, { id: 'tasks' }, { id: 'growth-plan' }, { id: 'agents' }];
  it('walks every entry when --only is absent', () => {
    expect(walk.selectEntries(reg, null)).toEqual({ entries: reg, missing: [] });
  });
  it('keeps the named ids, in the registry\'s own order', () => {
    const { entries, missing } = walk.selectEntries(reg, ['agents', 'overview']);
    expect(entries.map(e => e.id)).toEqual(['overview', 'agents']);
    expect(missing).toEqual([]);
  });
  it('reports an id the registry does not have, so a stale map is loud', () => {
    const { entries, missing } = walk.selectEntries(reg, ['growth-plan', 'retired-page', 'growth-plan']);
    expect(entries.map(e => e.id)).toEqual(['growth-plan']);
    expect(missing).toEqual(['retired-page']);
  });
  it('parses --only in both spellings, drops blanks and repeats, and tells absent from empty', () => {
    expect(walk.args([]).only).toBeNull();
    expect(walk.args(['--only', 'growth-plan, tasks,,growth-plan']).only).toEqual(['growth-plan', 'tasks']);
    expect(walk.args(['--only=agents', '--base', 'http://localhost:8951/']).only).toEqual(['agents']);
    expect(walk.args(['--only', '']).only).toEqual([]);
    expect(walk.args(['--only']).only).toEqual([]);
  });
  it('exits 2 on an empty --only before it reads the token or starts a browser (drives the real script)', () => {
    // An empty HOME has no token file: if the token were read first, the
    // reason would be "no usable token file", not the --only refusal.
    const home = mkdtempSync(join(tmpdir(), 'prod-walk-home-'));
    try {
      for (const argv of [['--only', ''], ['--only', ' , '], ['--only']]) {
        let out = '', code = 0;
        try { out = execFileSync('node', [SCRIPT, ...argv], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 20000 }); }
        catch (e) { out = e.stdout; code = e.status; }
        expect(code, argv.join(' ')).toBe(2);
        const res = JSON.parse(out);
        expect(res.reason).toMatch(/refused --only/);
        expect(res.ran).toBe(false);
        expect(res.only).toEqual([]);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('prod-walk.js blocks every write', () => {
  it('lets only GET, HEAD and OPTIONS out, in any case, and fails closed on a missing method', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get', 'Head', 'options']) expect(walk.isWrite(m), m).toBe(false);
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE', 'post', 'Patch', 'put', 'delete', 'PROPFIND', '', undefined]) {
      expect(walk.isWrite(m), String(m)).toBe(true);
    }
  });
  it('names a blocked write as METHOD host/path, with no query string and no token', () => {
    expect(walk.describeWrite('patch', `https://api.airtable.com/v0/appX/tblY?api_key=${SECRET}#x`, SECRET))
      .toBe('PATCH api.airtable.com/v0/appX/tblY');
    expect(walk.describeWrite('POST', `https://x.workers.dev/${SECRET}/send`, SECRET)).not.toContain(SECRET.slice(0, 10));
  });
  it('answers in both Airtable shapes, so page code does not throw on the block', () => {
    const body = JSON.parse(walk.BLOCKED_BODY);
    expect(body).toMatchObject({ records: [], id: 'recBLOCKEDBYWALK', fields: {}, blockedByWalk: true });
  });
  it('reports a blocked write but never judges on it', () => {
    const ok = { rendered: true, chars: 500, consoleErrors: [], failedRequests: [], leaks: [], softLeaks: [] };
    expect(walk.classify({ ...ok, writesBlocked: ['PATCH api.airtable.com/v0/appX/tblY'] })).toBe('PASS');
  });

  it('never sends a write from a real browser: fetch, XHR and beacon, same-origin and cross-origin (real Playwright)', async () => {
    let chromium;
    try { ({ chromium } = require('playwright-core')); } catch { /* asserted below */ }
    expect(chromium, 'playwright-core is not installed').toBeTruthy();

    // Two local servers that record every request that actually reaches them.
    const seen = [];
    const serve = (name, handler) => new Promise((ok) => {
      const s = createServer((req, res) => { seen.push(`${name} ${req.method} ${req.url}`); handler(req, res); });
      s.listen(0, '127.0.0.1', () => ok(s));
    });
    const api = await serve('api', (req, res) => {
      res.writeHead(200, { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*',
                           'access-control-allow-headers': '*', 'content-type': 'application/json' });
      res.end('{"records":[{"id":"recREAL"}]}');
    });
    const app = await serve('app', (req, res) => {
      if (req.url.startsWith('/read')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"read":true}'); }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body>walk test</body></html>');
    });
    const A = `http://127.0.0.1:${app.address().port}`;
    const B = `http://127.0.0.1:${api.address().port}`;

    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext({ serviceWorkers: 'block' });
      const blocked = [];
      await walk.blockWrites(ctx, (label) => blocked.push(label));
      const page = await ctx.newPage();
      await page.goto(A + '/');
      const got = await page.evaluate(async ({ A, B }) => {
        const out = {};
        const json = async (p) => { try { return await (await p).json(); } catch (e) { return { threw: String(e) }; } };
        out.patch = await json(fetch(B + '/v0/appX/tblY?secret=1', { method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: '{"records":[]}' }));
        out.post = await json(fetch(A + '/write', { method: 'POST', body: 'x' }));
        out.del = await new Promise((ok) => {
          const x = new XMLHttpRequest();
          x.open('DELETE', B + '/v0/appX/tblY/rec1');
          x.onload = () => ok({ status: x.status, body: x.responseText });
          x.onerror = () => ok({ threw: 'xhr error' });
          x.send();
        });
        out.beacon = navigator.sendBeacon(A + '/beacon', 'x');
        out.read = await json(fetch(A + '/read?q=1'));
        out.crossRead = await json(fetch(B + '/v0/appX/tblY'));
        return out;
      }, { A, B });
      await page.waitForTimeout(800);   // let the beacon go, if it were going to

      // The page read the block as a normal answer, including cross-origin.
      expect(got.patch).toMatchObject({ id: 'recBLOCKEDBYWALK', blockedByWalk: true });
      expect(got.post).toMatchObject({ blockedByWalk: true });
      expect(got.del.status).toBe(200);
      expect(JSON.parse(got.del.body).blockedByWalk).toBe(true);
      // Reads still go out and come back.
      expect(got.read).toEqual({ read: true });
      expect(got.crossRead).toEqual({ records: [{ id: 'recREAL' }] });

      // THE CONTRACT: nothing but reads ever reached either server.
      const writesThatLeaked = seen.filter(s => !/ (GET|HEAD|OPTIONS) /.test(s));
      expect(writesThatLeaked).toEqual([]);
      expect(seen).toContain(`api GET /v0/appX/tblY`);

      // Each block is named, without its query string.
      expect(blocked).toContain(`PATCH 127.0.0.1:${api.address().port}/v0/appX/tblY`);
      expect(blocked).toContain(`POST 127.0.0.1:${app.address().port}/write`);
      expect(blocked).toContain(`DELETE 127.0.0.1:${api.address().port}/v0/appX/tblY/rec1`);
      expect(blocked).toContain(`POST 127.0.0.1:${app.address().port}/beacon`);
      expect(blocked.join(' ')).not.toContain('secret=1');
    } finally {
      await browser.close();
      app.close();
      api.close();
    }
  }, 60000);
});

// 29 Sep 2026, caught in review: the merge gate compares the live walk with the
// walk of a PR served locally. Two things made that comparison blind:
// 1. each page kept its first 3 console errors (and the sign-in its first 5,
//    and each page its first 3 leak snippets), so when live already showed 3
//    errors, a PR's 4th was cut off and the pages compared as equal;
// 2. an error was cut at 200 characters as "message @ full URL", and the live
//    origin (37 characters) and a local one (about 22) cut the same message at
//    different points, so an unchanged error read as new.
describe('prod-walk.js keeps every distinct error, and a count, for the merge gate', () => {
  const base = { id: 'p', name: 'P', status: 'FAIL', consoleErrors: [], failedRequests: [], leaks: [], softLeaks: [], writesBlocked: [] };
  it('keeps a 4th distinct error, counts repeats, and says when nothing was cut', () => {
    const r = { ...base, consoleErrors: [] };
    for (const e of ['E1', 'E2', 'E3', 'E4', 'E2']) walk.recordError(r, e);
    const out = walk.pageReport(r);
    expect(out.consoleErrors).toEqual(['E1', 'E2', 'E3', 'E4']);
    expect(out.consoleErrorCount).toBe(5);
    expect(out.truncated).toBe(false);
  });
  it('stops listing at 50 distinct errors, keeps counting, and flags the cut', () => {
    const r = { ...base, consoleErrors: [] };
    for (let i = 0; i < 70; i += 1) walk.recordError(r, 'E' + i);
    const out = walk.pageReport(r);
    expect(out.consoleErrors).toHaveLength(walk.LIST_CAP);
    expect(walk.LIST_CAP).toBe(50);
    expect(out.consoleErrorCount).toBe(70);
    expect(out.truncated).toBe(true);
  });
  it('keeps every distinct leak snippet up to 50, with a count of every match', () => {
    // Each leak padded wider than the 20-character context, so a repeat reads the same.
    const item = (i) => '.'.repeat(25) + `Rent${i}: NaN` + '.'.repeat(25);
    const text = Array.from({ length: 8 }, (_, i) => item(i)).join('');
    const l = walk.findLeaks(text + text, SECRET);           // each leak twice
    expect(l.hard).toHaveLength(8);                          // distinct, not the first 3
    expect(l.hardCount).toBe(16);                            // repeats counted
    expect(l.softCount).toBe(16);
    const many = Array.from({ length: 60 }, (_, i) => item(i)).join('');
    const lm = walk.findLeaks(many, SECRET);
    expect(lm.hard).toHaveLength(50);
    expect(lm.hardCount).toBe(60);
    const out = walk.pageReport({ ...base, leaks: lm.hard, softLeaks: lm.soft, leakCount: lm.hardCount, softLeakCount: lm.softCount });
    expect(out.leakCount).toBe(60);
    expect(out.softLeakCount).toBe(60);
    expect(out.truncated).toBe(true);
  });
  it('keeps every field the Sunday slot already reads', () => {
    const out = walk.pageReport({ ...base, kind: 'page', chars: 900, httpStatus: 200, gate: '',
                                  failedRequests: ['a', 'b', 'c', 'd'], writesBlocked: ['1', '2', '3', '4', '5', '6'] });
    for (const k of ['id', 'name', 'kind', 'status', 'chars', 'consoleErrors', 'failedRequests', 'leaks', 'softLeaks', 'writesBlocked']) {
      expect(out, k).toHaveProperty(k);
    }
    expect(out.gate).toBeUndefined();
    expect(out.failedRequests).toHaveLength(3);
    expect(out.writesBlocked).toHaveLength(5);
  });
  it('reports every distinct sign-in error, with a count and a cut flag', () => {
    const boot = { consoleErrors: [], consoleErrorCount: 0 };
    for (let i = 0; i < 7; i += 1) walk.recordError(boot, 'B' + i);
    walk.recordError(boot, 'B0');
    expect(walk.bootReport(boot)).toEqual({ bootErrors: ['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6'], bootErrorCount: 8, bootTruncated: false });
  });
});

describe('prod-walk.js reads the same error the same on any origin', () => {
  const LIVE = 'https://app.operationsdirector.co.uk';
  const LOCAL = 'http://127.0.0.1:51234';
  const long = 'TypeError: Cannot read properties of undefined (reading \'fields\') while rendering the rent statement table for the selected tenancy and its linked payments ' + 'x'.repeat(40);
  it('strips the walked origin before cutting, and cuts message and path on their own', () => {
    const live = walk.errorLine(long, `${LIVE}/js/cfv.js?v=30`, LIVE, SECRET);
    const local = walk.errorLine(long, `${LOCAL}/js/cfv.js?v=30`, LOCAL, SECRET);
    expect(local).toBe(live);
    expect(live).toBe(long.slice(0, 200) + ' @ /js/cfv.js');
    // A path is cut at 120 without eating into the message.
    const deep = walk.errorLine('short', `${LIVE}/` + 'a/'.repeat(100) + 'x.js', LIVE, SECRET);
    expect(deep.split(' @ ')[0]).toBe('short');
    expect(deep.split(' @ ')[1]).toHaveLength(120);
  });
  it('strips the origin from the message too, and leaves other hosts whole', () => {
    expect(walk.errorLine(`Failed to load ${LOCAL}/js/x.js`, '', LOCAL, SECRET)).toBe('Failed to load /js/x.js');
    expect(walk.errorLine('boom', 'https://api.airtable.com/v0/appX/tblY?offset=1', LIVE, SECRET)).toBe('boom @ https://api.airtable.com/v0/appX/tblY');
  });
  it('records identical errors from two origins through the real browser hooks (real Playwright)', async () => {
    let chromium;
    try { ({ chromium } = require('playwright-core')); } catch { /* asserted below */ }
    expect(chromium, 'playwright-core is not installed').toBeTruthy();
    const APP_JS = `
      const pad = 'y'.repeat(180);
      for (const m of ['E1 ' + pad, 'E2', 'E3', 'E4', 'E2']) console.error(m);
      console.error('Failed at ' + location.origin + '/js/thing.js ' + pad);
      setTimeout(() => { throw new Error('boom at ' + location.origin + '/js/x.js'); }, 0);`;
    const serve = () => new Promise((ok) => {
      const s = createServer((req, res) => {
        if (req.url.startsWith('/app.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(APP_JS); }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><body>errors<script src="/app.js?v=1"></script></body></html>');
      });
      s.listen(0, '127.0.0.1', () => ok(s));
    });
    // Two servers, two origins, as the live walk and the merge gate's local walk are.
    const a = await serve();
    const b = await serve();
    const browser = await chromium.launch({ headless: true });
    try {
      const walkOne = async (server) => {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const rec = { consoleErrors: [], consoleErrorCount: 0, failedRequests: [], outsideNoise: 0 };
        const page = await browser.newPage();
        walk.attachHooks(page, origin, () => rec);
        await page.goto(origin + '/');
        await page.waitForTimeout(500);
        await page.close();
        return rec;
      };
      const ra = await walkOne(a);
      const rb = await walkOne(b);
      expect(ra.consoleErrors).toEqual(rb.consoleErrors);
      expect(ra.consoleErrors).toHaveLength(6);          // E1..E4, the origin message, the pageerror
      expect(ra.consoleErrorCount).toBe(7);              // the repeated E2 is counted
      expect(ra.consoleErrors).toContain('E2 @ /app.js');
      expect(ra.consoleErrors).toContain('pageerror: boom at /js/x.js');
      expect(ra.consoleErrors.join(' ')).not.toContain('127.0.0.1');
    } finally {
      await browser.close();
      a.close();
      b.close();
    }
  }, 60000);
});

// 29 Sep 2026: the merge gate refused PR #624 because Inbound Comms, a page it
// never changed, logged "403 @ googleapis.com/discovery/.../gmail" on the local
// copy and nothing live. Google API keys are locked to the live address, so a
// keyed Google call from 127.0.0.1 always answers 403. Back-test: with the
// isOriginLocked checks removed from attachHooks, the hooks test below fails.
describe('prod-walk.js does not charge an origin-locked Google 403 on a local copy', () => {
  const LOCAL = 'http://127.0.0.1:5173', LIVE = 'https://app.operationsdirector.co.uk';
  const GMAIL = 'https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest?key=AIza-test';
  it('only a 403, only from googleapis.com, only on a local origin', () => {
    expect(walk.isOriginLocked(GMAIL, 403, LOCAL)).toBe(true);
    expect(walk.isOriginLocked(GMAIL, 403, 'http://localhost:8080')).toBe(true);
    expect(walk.isOriginLocked(GMAIL, 403, LIVE)).toBe(false);           // live: still the app's error
    expect(walk.isOriginLocked(GMAIL, 404, LOCAL)).toBe(false);
    expect(walk.isOriginLocked('https://api.airtable.com/v0/appX/tblY', 403, LOCAL)).toBe(false);
    expect(walk.isOriginLocked('https://googleapis.com.evil.test/x', 403, LOCAL)).toBe(false);
  });
  it('through the real browser hooks: the Google 403 is noise, any other 403 is still charged (real Playwright)', async () => {
    let chromium;
    try { ({ chromium } = require('playwright-core')); } catch { /* asserted below */ }
    expect(chromium, 'playwright-core is not installed').toBeTruthy();
    const server = await new Promise((ok) => {
      const s = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><html><body>comms<script>
          fetch(${JSON.stringify(GMAIL)}).catch(() => {});
          fetch('https://api.airtable.com/v0/appX/tblY').catch(() => {});
        </script></body></html>`);
      });
      s.listen(0, '127.0.0.1', () => ok(s));
    });
    const browser = await chromium.launch({ headless: true });
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const rec = { consoleErrors: [], consoleErrorCount: 0, failedRequests: [], outsideNoise: 0 };
      const page = await browser.newPage();
      await page.route('https://www.googleapis.com/**', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: '{}', headers: { 'access-control-allow-origin': '*' } }));
      await page.route('https://api.airtable.com/**', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: '{}', headers: { 'access-control-allow-origin': '*' } }));
      walk.attachHooks(page, origin, () => rec);
      await page.goto(origin + '/');
      await page.waitForTimeout(800);
      await page.close();
      const all = rec.consoleErrors.concat(rec.failedRequests).join(' | ');
      expect(all).not.toContain('googleapis');
      expect(all).toContain('api.airtable.com');                          // a real 403 still counts
      expect(rec.outsideNoise).toBeGreaterThanOrEqual(1);
    } finally {
      await browser.close();
      server.close();
    }
  }, 60000);
});

// 29 Sep 2026, the same day: with the 403 excused, the merge gate still refused
// PR #632 (Tasks page) on Inbound Comms. After the local-only 403,
// follow-up.html's `await gapi.client.init()` rejects with a plain object nobody
// catches, reported as "pageerror: Object". Main itself, served locally, failed
// that page on it. Excused only when the same page saw the origin-locked Google
// 403 on a local origin. Back-test: make settleLockedRejections() always record
// and the first case fails; make it always excuse and the second case fails.
describe('prod-walk.js excuses the uncaught Google rejection only after a local Google 403', () => {
  const GMAIL = 'https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest?key=AIza-test';
  const run = async (withGoogle403) => {
    let chromium;
    try { ({ chromium } = require('playwright-core')); } catch { /* asserted below */ }
    expect(chromium, 'playwright-core is not installed').toBeTruthy();
    const server = await new Promise((ok) => {
      const s = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        // Like gapi.client.init(): a failed call, then a plain object rejected
        // and never caught.
        res.end(`<!doctype html><html><body>comms<script>
          (async () => {
            ${withGoogle403 ? `await fetch(${JSON.stringify(GMAIL)}).catch(() => {});` : ''}
            await Promise.reject({ error: { code: 403 } });
          })();
        </script></body></html>`);
      });
      s.listen(0, '127.0.0.1', () => ok(s));
    });
    const browser = await chromium.launch({ headless: true });
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const rec = { consoleErrors: [], consoleErrorCount: 0, failedRequests: [], outsideNoise: 0 };
      const page = await browser.newPage();
      await page.route('https://www.googleapis.com/**', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: '{}', headers: { 'access-control-allow-origin': '*' } }));
      walk.attachHooks(page, origin, () => rec);
      await page.goto(origin + '/');
      await page.waitForTimeout(800);
      await page.close();
      walk.settleLockedRejections(rec, origin);
      return rec;
    } finally {
      await browser.close();
      server.close();
    }
  };
  it('after the Google 403 on a local copy: the rejection is noise (real Playwright)', async () => {
    const rec = await run(true);
    expect(rec.consoleErrors).toEqual([]);
    expect(rec.outsideNoise).toBeGreaterThanOrEqual(2);                    // the 403 and the rejection
  }, 60000);
  it('with no Google 403: the same rejection is still the app\'s error (real Playwright)', async () => {
    const rec = await run(false);
    expect(rec.consoleErrors).toEqual(['pageerror: Object']);
  }, 60000);
  it('on the live origin a held rejection is always recorded, 403 or not', () => {
    const rec = { consoleErrors: [], consoleErrorCount: 0, outsideNoise: 0, googleLocked403: true, pendingObjectRejections: 1 };
    walk.settleLockedRejections(rec, 'https://app.operationsdirector.co.uk');
    expect(rec.consoleErrors).toEqual(['pageerror: Object']);
    expect(rec.pendingObjectRejections).toBeUndefined();
  });
});

// 29 Sep 2026: on the live app 5 of 31 pages stopped at an entry screen, so
// the walk said WARN and never checked their data. Tasks asked "Who are you?"
// and Property Manager's own sign-in POST was blocked by the write block. The
// walk now remembers Kevin as the Tasks viewer, lets out exactly that one
// sign-in request, and counts it. Inbound Comms (Google) and CRM (Supabase)
// have no read-only way through and stay WARN.
describe('prod-walk.js gets past the Tasks viewer screen as Kevin, and only Kevin', () => {
  // The page's own code, run on what the walk seeds: its TEAM list and the
  // initIdentity() that decides between the tasks and "Who are you?".
  const runTasksIdentity = (seed) => {
    const src = read('os/tasks/index.html');
    const team = (src.match(/const TEAM = \[[\s\S]*?\n\];/) || [])[0];
    const init = (src.match(/function initIdentity\(\)\{[\s\S]*?\n\}/) || [])[0];
    expect(team, 'os/tasks/index.html no longer declares TEAM as the walk expects').toBeTruthy();
    expect(init, 'os/tasks/index.html no longer has initIdentity()').toBeTruthy();
    const store = new Map(seed.map(e => [e.name, e.value]));
    const box = { localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null) }, overlay: 0, badge: 0 };
    vm.runInNewContext(`${team}
      var currentUser = null;
      function renderUserBadge(){ badge += 1; }
      function showIdentityOverlay(){ overlay += 1; }
      ${init}
      result = { ok: initIdentity(), user: currentUser, kevin: TEAM.find(m => m.key === 'kevin') };`, box);
    return { ...box.result, overlay: box.overlay, badge: box.badge };
  };

  it('seeds the token under both keys and the viewer under the key the page reads', () => {
    const seed = walk.seedStorage(SECRET);
    expect(seed.map(e => e.name)).toEqual(['_dlr_pat', 'airtable_pat', '_task_user']);
    expect(seed[0].value).toBe(SECRET);
    expect(seed[1].value).toBe(SECRET);
    expect(JSON.parse(seed[2].value)).toEqual(walk.TASK_VIEWER);
  });

  it("is let in by the page's own initIdentity(), as Kevin's own TEAM entry (drives os/tasks/index.html)", () => {
    const r = runTasksIdentity(walk.seedStorage(SECRET));
    expect(r.ok).toBe(true);
    expect(r.overlay).toBe(0);               // no "Who are you?"
    expect(r.badge).toBe(1);
    // Exactly what selectIdentity('kevin') writes: never an invented person.
    expect(r.kevin).toBeTruthy();
    expect(r.kevin.left).toBeUndefined();
    expect(r.user).toEqual({ key: r.kevin.key, name: r.kevin.name, email: r.kevin.email });
  });

  it('shows "Who are you?" without the seed, so the test can tell the two apart', () => {
    const r = runTasksIdentity(walk.seedStorage(SECRET).filter(e => e.name !== '_task_user'));
    expect(r.ok).toBe(false);
    expect(r.overlay).toBe(1);
  });
});

describe('prod-walk.js waits for a loading frame instead of calling it a gate', () => {
  const content = 'Property Manager Rent collected this month £12,400 across 26 tenancies';
  it('settles on stable content, and not while it is still growing', () => {
    expect(walk.frameSettled(content, content.length)).toBe(true);
    expect(walk.frameSettled(content, content.length - 5)).toBe(false);
    expect(walk.frameSettled('tiny', 4)).toBe(false);
  });
  it('never settles on a "Loading..." line, however still it holds', () => {
    const loading = 'Property Manager Loading the property figures… a fresh load reads a year of transactions';
    expect(walk.frameSettled(loading, loading.length)).toBe(false);
    const tasks = 'Tasks & Projects Loading tasks from Airtable... please wait for the data to arrive';
    expect(walk.frameSettled(tasks, tasks.length)).toBe(false);
  });
});

describe('prod-walk.js lets out exactly one write: the Property Manager sign-in', () => {
  const PM = 'https://pm.operationsdirector.co.uk';
  it('allows POST to /login-airtable on that host, and nothing else', () => {
    expect(walk.allowedWrite('POST', PM + '/login-airtable')).toBe(true);
    expect(walk.allowedWrite('post', PM + '/login-airtable')).toBe(true);
    expect(walk.allowedWrite('POST', 'https://pm.operationsdirector.co.uk:443/login-airtable')).toBe(true);
    expect(walk.ALLOWED_WRITES).toHaveLength(1);
    expect(Object.isFrozen(walk.ALLOWED_WRITES)).toBe(true);
  });
  it('blocks a POST to any other path on that host, including the passcode sign-in and every data write', () => {
    for (const p of ['/login', '/task/recAbC123', '/growth-plan/tick', '/growth-plan/task', '/data', '/',
                     '/login-airtable/', '/login-airtable2', '/Login-Airtable', '/login-airtable/../task/recX',
                     '/login-airtable?refresh=1', '/login-airtable#x']) {
      expect(walk.allowedWrite('POST', PM + p), p).toBe(false);
    }
  });
  it('blocks any other method, scheme or host on that path', () => {
    for (const m of ['PATCH', 'PUT', 'DELETE', '', undefined]) expect(walk.allowedWrite(m, PM + '/login-airtable'), String(m)).toBe(false);
    for (const u of ['http://pm.operationsdirector.co.uk/login-airtable', 'https://pm.operationsdirector.co.uk.evil.example/login-airtable',
                     'https://evil.example/login-airtable', 'https://pm.operationsdirector.co.uk@evil.example/login-airtable',
                     'https://x@pm.operationsdirector.co.uk/login-airtable', 'https://api.airtable.com/login-airtable',
                     'https://pm.example.workers.dev/login-airtable', 'not a url', '', undefined]) {
      expect(walk.allowedWrite('POST', u), String(u)).toBe(false);
    }
  });
  it('lists an allowed write on the page that sent it', () => {
    const out = walk.pageReport({ id: 'property-manager', consoleErrors: [], leaks: [], softLeaks: [],
                                  writesBlocked: [], writesAllowed: ['POST pm.operationsdirector.co.uk/login-airtable'] });
    expect(out.writesAllowed).toEqual(['POST pm.operationsdirector.co.uk/login-airtable']);
    expect(out.writesBlocked).toEqual([]);
  });

  it('sends that one request, counted, and still blocks every other write to the Worker (real Playwright)', async () => {
    let chromium;
    try { ({ chromium } = require('playwright-core')); } catch { /* asserted below */ }
    expect(chromium, 'playwright-core is not installed').toBeTruthy();
    const app = await new Promise((ok) => {
      const s = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><body>pm</body>'); });
      s.listen(0, '127.0.0.1', () => ok(s));
    });
    const A = `http://127.0.0.1:${app.address().port}`;
    const browser = await chromium.launch({ headless: true });
    // Plain-text bodies: no CORS preflight, so nothing here can reach the real Worker.
    const tryAll = (page) => page.evaluate(async (PM) => {
      const post = async (path, method = 'POST') => {
        try { return await (await fetch(PM + path, { method, body: 'x' })).json(); } catch (e) { return { threw: String(e) }; }
      };
      return { signIn: await post('/login-airtable'), passcode: await post('/login'), task: await post('/task/recAbC123'),
               query: await post('/login-airtable?x=1'), patch: await post('/login-airtable', 'PATCH') };
    }, PM);
    try {
      // The walk's route is installed after the stand-in, so it runs first. A
      // request it lets out falls back to the stand-in instead of the internet.
      const withCount = async (onAllowed) => {
        const ctx = await browser.newContext({ serviceWorkers: 'block' });
        const reached = [];
        await ctx.route(PM + '/**', (route) => {
          const u = new URL(route.request().url());
          reached.push(route.request().method() + ' ' + u.pathname + u.search);
          return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
                                 body: JSON.stringify({ ok: true, token: 'session', who: 'Kevin Brittain' }) });
        });
        const blocked = [];
        await walk.blockWrites(ctx, (l) => blocked.push(l), onAllowed);
        const page = await ctx.newPage();
        await page.goto(A + '/');
        const got = await tryAll(page);
        await ctx.close();
        return { got, reached, blocked };
      };

      const allowed = [];
      const on = await withCount((l) => allowed.push(l));
      // The sign-in reached the Worker and the page got its session back.
      expect(on.reached).toEqual(['POST /login-airtable']);
      expect(on.got.signIn).toMatchObject({ token: 'session' });
      expect(allowed).toEqual(['POST pm.operationsdirector.co.uk/login-airtable']);
      // Every other write to that host was answered locally, never sent.
      for (const k of ['passcode', 'task', 'query', 'patch']) expect(on.got[k], k).toMatchObject({ blockedByWalk: true });
      expect(on.blocked).toEqual(['POST pm.operationsdirector.co.uk/login', 'POST pm.operationsdirector.co.uk/task/recAbC123',
                                  'POST pm.operationsdirector.co.uk/login-airtable', 'PATCH pm.operationsdirector.co.uk/login-airtable']);

      // No counter, no exception: the sign-in is blocked like any other write.
      const off = await withCount(undefined);
      expect(off.reached).toEqual([]);
      expect(off.got.signIn).toMatchObject({ blockedByWalk: true });
      // A counter that fails blocks it too: an exception nobody counted is not taken.
      const broken = await withCount(() => { throw new Error('count failed'); });
      expect(broken.reached).toEqual([]);
      expect(broken.got.signIn).toMatchObject({ blockedByWalk: true });
      expect(broken.blocked).toContain('POST pm.operationsdirector.co.uk/login-airtable');
    } finally {
      await browser.close();
      app.close();
    }
  }, 60000);
});

describe('the weekly sweep skill gives the robot routes that work', () => {
  const skill = read('.claude/scheduled-tasks/prod-sweep-weekly/SKILL.md');
  const title = (skill.match(/`(SITE CHECK: [^`]+)`/) || [])[1];
  const status = (skill.match(/Status\s+`fldx4qCw17UfrKpaN`\s*=\s*`([^`]+)`/) || [])[1];

  it('runs the walk script with a long enough command timeout', () => {
    expect(skill).toMatch(/node scripts\/prod-walk\.js/);
    expect(skill).toMatch(/600000/);
  });

  it('names a task title and status that the real duplicate gate accepts (drives create-agent-task.py)', () => {
    expect(title, 'the skill must name one fixed SITE CHECK title').toBeTruthy();
    const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("cat", "scripts/create-agent-task.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
F = m.F
T, S = sys.argv[1], sys.argv[2]
def row(i, name): return {"id": i, "createdTime": "2026-09-01T00:00:00Z", "fields": {F["name"]: name, F["status"]: "Today"}}
others = [row("rX", "Fix compliance page auth screen"), row("rY", "Check CFV figures for Elmdon"),
          row("rZ", "E2E Sweep [CRITICAL]: hard-deadline-passed-still-open"), row("rV", "Dashboard: fix overview KPI tiles"),
          row("rA", "Fix dashboard faults"), row("rB", "Faults found on the Money dashboard"),
          row("rC", "Leadership dashboard faults on cash flow"), row("rD", "Sunday walk faults"),
          row("rE", "SITE CHECK: payments page walk")]
print(json.dumps({"statusOk": S in m.NEW_TASK_STATUSES,
                  "first": m.decide({F["name"]: T}, others)["action"],
                  "again": m.decide({F["name"]: T}, others + [row("rS", T)]).get("taskId")}))
`;
    const out = JSON.parse(execFileSync('python3', ['-c', py, title, status], { cwd: ROOT, encoding: 'utf8' }));
    expect(out.statusOk).toBe(true);           // "To do" was not a valid status
    expect(out.first).toBe('create');          // never folded into an unrelated task
    expect(out.again).toBe('rS');              // next Sunday folds into its own open task
  });
});
