// Kevin, 2 Oct 2026: "Amazon for historical order deliveries. When I click on
// the link for Amazon, it's already logged in." Amazon sent the robot's own
// browser to its sign-in page on 7 mornings of 7, while the plain window the
// Robot sign-in app opened showed order history every time with no password
// asked. Proved live the same day (20:13Z): signed out in the robot's browser,
// that plain window opened for 20 seconds with nobody touching it, signed in
// again. So for a site marked selfRefresh the robot opens the window itself.
//
// These drive the real functions. The window is a stand-in process that
// carries the profile flag and the refresh marker the way Chrome does, so no
// browser opens in a test. An independent review found the first version
// killed whatever was on the profile and left the window open when its own
// process was killed; each of those is a test below.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

// Builtins only: the test never reads this Mac's own sites.json.
process.env.AGENT_BROWSER_SITES_FILE = join(tmpdir(), 'od-refresh-no-sites.json');
const require_ = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'agent-browser.js');
const b = require_(SCRIPT);

const made = [];
const reap = (dir) => spawnSync('pkill', ['-9', '-f', `user-data-dir=${dir}`]);
afterAll(() => { for (const d of made) { reap(d); rmSync(d, { recursive: true, force: true }); } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const running = (dir) => spawnSync('pgrep', ['-f', `user-data-dir=${dir}`]).status === 0;
async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(100); }
  return fn();
}
function profile() {
  const h = mkdtempSync(join(tmpdir(), 'od-refresh-'));
  made.push(h);
  const dir = join(h, 'default');
  mkdirSync(dir, { recursive: true });
  return dir;
}
// A process on the profile: the stand-in window (with the marker), or a robot's headless browser.
const onProfile = (dir, extra = [], body = 'setInterval(() => {}, 1000)') =>
  spawn(process.execPath, ['-e', body, 'x', `--user-data-dir=${dir}`, ...extra], { stdio: 'ignore', detached: true });
const fakeWindow = (body) => (dir, url, marker) => { onProfile(dir, [marker], body).unref(); };
const FAST = { settleMs: 50, freeMs: 1500, openMs: 4000, closeMs: 3000, lingerMs: 500 };

// What the robot's check read on 2 Oct 2026, before and after.
const AMAZON = { label: 'Amazon (order history)', login: true, selfRefresh: true, loginUrl: 'https://www.amazon.co.uk/gp/css/order-history' };
const SIGNED_OUT = { url: 'https://www.amazon.co.uk/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.co.uk%2Fyour-orders%2Forders', title: 'Amazon Sign In', passwordFields: 0, text: 'Sign in or create account' };
const SIGNED_IN = { url: 'https://www.amazon.co.uk/gp/css/order-history', title: 'Your Orders', passwordFields: 0, text: 'Your Orders' };

describe('which sites the robot signs itself back in to', () => {
  it('Amazon is marked, and a site that needs his password is not', () => {
    const sites = b.loadSites();
    expect(sites['www.amazon.co.uk'].selfRefresh).toBe(true);
    expect(Object.keys(sites).filter(h => sites[h].selfRefresh)).toEqual(['www.amazon.co.uk']);
    expect(b.selfRefreshEntry('https://www.amazon.co.uk/gp/your-account/order-details?orderID=1', sites).loginUrl).toBe('https://www.amazon.co.uk/gp/css/order-history');
    expect(b.selfRefreshEntry('https://www.edfenergy.com/myaccount/login', sites)).toBeNull();
    expect(b.selfRefreshEntry('not a url', sites)).toBeNull();
  });

  it('the window is found by its own marker: never the launcher, a helper, Kevin\'s window or a robot', () => {
    const m = '--od-refresh=123-abc';
    const dir = '/Users/x/.config/od/agent-browser/default';
    expect(b.isRefreshWindowLine(`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir} --use-mock-keychain --no-first-run ${m} https://www.amazon.co.uk/`, m)).toBe(true);
    expect(b.isRefreshWindowLine(`open -g -na Google Chrome --args --user-data-dir=${dir} ${m} https://www.amazon.co.uk/`, m)).toBe(false);
    expect(b.isRefreshWindowLine(`/usr/bin/open -g -na Google Chrome --args ${m}`, m)).toBe(false);
    expect(b.isRefreshWindowLine(`/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper --type=renderer --user-data-dir=${dir} ${m}`, m)).toBe(false);
    expect(b.isRefreshWindowLine(`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir} --use-mock-keychain --no-first-run https://www.edfenergy.com/`, m)).toBe(false);
    expect(b.isRefreshWindowLine(`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir} --headless --remote-debugging-pipe`, m)).toBe(false);
    expect(b.isRefreshWindowLine(`Google Chrome ${m}x`, m)).toBe(false);
  });
});

describe('a read that lands on the sign-in page is taken again after the refresh (withSelfRefresh)', () => {
  const drive = async (entry, reads, refreshResult = { ok: true }) => {
    const calls = { runs: 0, refresh: [], noted: [] };
    const res = await b.withSelfRefresh(entry, '/profile', async () => {
      const r = reads[Math.min(calls.runs++, reads.length - 1)];
      if (r instanceof Error) throw r;
      return { ...r };
    }, async (dir, url) => { calls.refresh.push([dir, url]); return refreshResult; }, (n) => calls.noted.push(n));
    return { res, calls };
  };

  it('Amazon signed out, then signed in after the window: one refresh at its sign-in page, two reads, the second one returned', async () => {
    const { res, calls } = await drive(AMAZON, [SIGNED_OUT, SIGNED_IN]);
    expect(calls.refresh).toEqual([['/profile', 'https://www.amazon.co.uk/gp/css/order-history']]);
    expect(calls.runs).toBe(2);
    expect(calls.noted).toEqual(['ran']);
    expect(res.title).toBe('Your Orders');
    expect(res.selfRefresh).toBe('signed back in');
  });

  it('already signed in: no window, one read, nothing added to the result', async () => {
    const { res, calls } = await drive(AMAZON, [SIGNED_IN]);
    expect(calls.refresh).toEqual([]);
    expect(calls.runs).toBe(1);
    expect(calls.noted).toEqual([]);
    expect(res.selfRefresh).toBeUndefined();
  });

  it('a site that is not marked never gets a window, whatever it reads (EDF needs his password)', async () => {
    const edf = { label: 'EDF Energy', login: true, loginUrl: 'https://www.edfenergy.com/myaccount/login' };
    const out = { url: 'https://www.edfenergy.com/myaccount/login', title: 'Log in', passwordFields: 1, text: 'Log in' };
    for (const entry of [edf, null]) {
      const { res, calls } = await drive(entry, [out, SIGNED_IN]);
      expect(calls.refresh).toEqual([]);
      expect(calls.runs).toBe(1);
      expect(res.url).toBe(out.url);
    }
  });

  it('still signed out after the window: says so, and never tries a second time', async () => {
    const { res, calls } = await drive(AMAZON, [SIGNED_OUT, SIGNED_OUT, SIGNED_IN]);
    expect(calls.refresh.length).toBe(1);
    expect(calls.runs).toBe(2);
    expect(res.title).toBe('Amazon Sign In');
    expect(res.selfRefresh).toBe('ran, still signed out');
  });

  it('the outcome is read off the second page: a bot check or a browser error page is never "signed back in"', async () => {
    const bot = { url: 'https://www.amazon.co.uk/gp/css/order-history', title: 'Just a moment...', passwordFields: 0, text: 'Verify you are human' };
    expect((await drive(AMAZON, [SIGNED_OUT, bot])).res.selfRefresh).toBe('ran, then met a bot check');
    const broken = { url: 'chrome-error://chromewebdata/', title: '', passwordFields: 0, text: '' };
    expect((await drive(AMAZON, [SIGNED_OUT, broken])).res.selfRefresh).toBe('ran, the page did not settle');
  });

  it('a window that could not run leaves the signed-out read standing, with the reason, and is noted', async () => {
    const { res, calls } = await drive(AMAZON, [SIGNED_OUT, SIGNED_IN], { ok: false, why: 'the profile is in use' });
    expect(calls.runs).toBe(1);
    expect(calls.noted).toEqual(['not run: the profile is in use']);
    expect(res.title).toBe('Amazon Sign In');
    expect(res.selfRefresh).toBe('not run: the profile is in use');
  });

  it('a second read that fails keeps the first read and says why: the refresh is on the record before it', async () => {
    const { res, calls } = await drive(AMAZON, [SIGNED_OUT, new Error('page.goto: Timeout 45000ms exceeded')]);
    expect(calls.noted).toEqual(['ran']);
    expect(res.title).toBe('Amazon Sign In');
    expect(res.selfRefresh).toBe('ran, then the second read failed: page.goto: Timeout 45000ms exceeded');
  });

  it('a bot check is not a sign-in page: no window', async () => {
    const bot = { url: 'https://www.amazon.co.uk/errors/validateCaptcha', title: 'Just a moment...', passwordFields: 0, text: 'Verify you are human' };
    const { calls } = await drive(AMAZON, [bot, SIGNED_IN]);
    expect(calls.refresh).toEqual([]);
    expect(calls.runs).toBe(1);
  });
});

describe('the window itself (plainRefresh)', () => {
  it('opens, holds the profile while it is open, closes, and lets go of the hold', async () => {
    const dir = profile();
    let heldBy = null;
    const probe = (async () => { for (let i = 0; i < 80 && heldBy === null; i++) { await sleep(100); if (running(dir)) heldBy = b.signinHoldActive(dir) && b.holdBy(dir); } })();
    const r = await b.plainRefresh(dir, 'https://www.amazon.co.uk/gp/css/order-history', { ...FAST, open: fakeWindow() });
    await probe;
    expect(r).toEqual({ ok: true });
    expect(heldBy).toBe('refresh');
    expect(running(dir)).toBe(false);
    expect(b.signinHoldActive(dir)).toBe(false);
    expect(existsSync(dir + '.signin-hold')).toBe(false);
  }, 30000);

  it('a window that will not quit is killed: a window left open would block every robot step', async () => {
    const dir = profile();
    const r = await b.plainRefresh(dir, 'https://www.amazon.co.uk/', { ...FAST, closeMs: 1000, open: fakeWindow("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)") });
    expect(r).toEqual({ ok: true, forced: true });
    expect(running(dir)).toBe(false);
    expect(b.signinHoldActive(dir)).toBe(false);
  }, 30000);

  it('a robot that launches on the profile while the window is open is never killed', async () => {
    const dir = profile();
    let robot = null;
    // The window opens, then a robot (no marker) takes the profile alongside it, as one that ignores the hold would.
    const open = (d, url, marker) => { fakeWindow()(d, url, marker); robot = onProfile(d, ['--headless']); };
    const r = await b.plainRefresh(dir, 'https://www.amazon.co.uk/', { ...FAST, open });
    try {
      expect(r).toEqual({ ok: true });
      expect(alive(robot.pid)).toBe(true);
    } finally { robot && robot.kill('SIGKILL'); }
  }, 30000);

  it('a robot that launched a moment before the hold is waited for, never opened over and never killed', async () => {
    const dir = profile();
    let opened = 0;
    const pending = b.plainRefresh(dir, 'https://www.amazon.co.uk/', { ...FAST, settleMs: 600, freeMs: 800, open: () => { opened++; } });
    await sleep(100);
    const robot = onProfile(dir, ['--headless']);                 // inside the settle pause
    try {
      expect(await pending).toEqual({ ok: false, why: 'the profile is in use' });
      expect(opened).toBe(0);
      expect(alive(robot.pid)).toBe(true);
      expect(b.signinHoldActive(dir)).toBe(false);
    } finally { robot.kill('SIGKILL'); }
  }, 30000);

  it("never opens over Kevin's own sign-in, and leaves his hold alone", async () => {
    const dir = profile();
    const his = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(dir + '.signin-hold')}, JSON.stringify({ pid: process.pid, at: Date.now() })); setInterval(() => {}, 1000)`], { stdio: 'ignore' });
    try {
      expect(await until(() => b.signinHoldActive(dir), 5000)).toBe(true);
      let opened = 0;
      const r = await b.plainRefresh(dir, 'https://www.amazon.co.uk/', { ...FAST, open: () => { opened++; } });
      expect(r).toEqual({ ok: false, why: 'a sign-in window is already open on this profile' });
      expect(opened).toBe(0);
      expect(b.signinHoldActive(dir)).toBe(true);
    } finally { his.kill('SIGKILL'); }
  }, 30000);

  it('a sign-in Kevin starts while it waits for the profile wins: nothing opens, his hold stays', async () => {
    const dir = profile();
    const robot = onProfile(dir, ['--headless']);                 // the profile is busy, so the refresh waits
    let his = null, opened = 0;
    try {
      expect(await until(() => running(dir), 5000)).toBe(true);
      const pending = b.plainRefresh(dir, 'https://www.amazon.co.uk/', { ...FAST, freeMs: 5000, open: () => { opened++; } });
      await sleep(400);
      his = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(dir + '.signin-hold')}, JSON.stringify({ pid: process.pid, at: Date.now() })); setInterval(() => {}, 1000)`], { stdio: 'ignore' });
      await sleep(400);
      robot.kill('SIGKILL');                                       // the robot's step ends
      expect(await pending).toEqual({ ok: false, why: 'a sign-in window is already open on this profile' });
      expect(opened).toBe(0);
      expect(b.signinHoldActive(dir)).toBe(true);
    } finally { robot.kill('SIGKILL'); his && his.kill('SIGKILL'); }
  }, 30000);

  it('a window that never appears is reported, and the hold is let go', async () => {
    const dir = profile();
    const never = await b.plainRefresh(dir, 'https://www.amazon.co.uk/', { ...FAST, open: () => {}, openMs: 600 });
    expect(never).toEqual({ ok: false, why: 'the window did not open' });
    expect(b.signinHoldActive(dir)).toBe(false);
  }, 30000);

  // Chrome is started by `open`, so it is never in the robot's own process tree; the stand-in is put outside it the same way.
  const runnerFor = (dir, opts) => {
    const runner = join(dirname(dir), 'runner.js');
    writeFileSync(runner, `
const b = require(${JSON.stringify(SCRIPT)});
const { spawn } = require('child_process');
const open = (d, url, marker) => spawn('/bin/sh', ['-c', 'sleep ' + ${JSON.stringify(String(opts.openAfterS || 0))} + '; exec "$NODE" -e "setInterval(() => {}, 1000)" x "--user-data-dir=$D" "$M" >/dev/null 2>&1 &'],
  { stdio: 'ignore', detached: true, env: Object.assign({}, process.env, { NODE: process.execPath, D: d, M: marker }) }).unref();
b.plainRefresh(${JSON.stringify(dir)}, 'https://www.amazon.co.uk/', Object.assign({ settleMs: 50, freeMs: 1000, open }, ${JSON.stringify(opts.refresh)}))
  .then(r => console.log(JSON.stringify(r)));
`);
    return runner;
  };

  // A caller's timeout (agent-dispatch and the keep-alive kill the walk at 180 and 300 s) can land in the 20 seconds,
  // and an agent's tool timeout kills node and its children together.
  it('the window closes even when the robot process and its children are killed while it is open', async () => {
    const dir = profile();
    const proc = spawn(process.execPath, [runnerFor(dir, { refresh: { openMs: 4000, closeMs: 1000, lingerMs: 60000, watchdogMs: 6000 } })], { stdio: 'ignore' });
    try {
      expect(await until(() => running(dir), 8000)).toBe(true);    // the window is open
      spawnSync('pkill', ['-KILL', '-P', String(proc.pid)]);       // every child of the robot's node...
      proc.kill('SIGKILL');                                        // ...and node itself, mid-linger
      await sleep(1500);
      expect(running(dir)).toBe(true);                             // nothing of the robot's closed it
      expect(await until(() => !running(dir), 20000)).toBe(true);  // the watchdog did
      expect(b.signinHoldActive(dir)).toBe(false);                 // a dead holder's hold is no hold
    } finally { proc.kill('SIGKILL'); }
  }, 40000);

  it('a window that opens after the robot gave up on it is still closed', async () => {
    const dir = profile();
    const proc = spawn(process.execPath, [runnerFor(dir, { openAfterS: 2, refresh: { openMs: 500, closeMs: 1000, lingerMs: 500, watchdogMs: 5000 } })], { stdio: ['ignore', 'pipe', 'ignore'] });
    let said = '';
    proc.stdout.on('data', d => { said += d; });
    try {
      expect(await until(() => said.includes('did not open'), 8000)).toBe(true);
      expect(JSON.parse(said)).toEqual({ ok: false, why: 'the window did not open' });
      expect(await until(() => running(dir), 6000)).toBe(true);     // it opens late
      expect(await until(() => !running(dir), 20000)).toBe(true);   // and is closed all the same
    } finally { proc.kill('SIGKILL'); }
  }, 40000);
});
