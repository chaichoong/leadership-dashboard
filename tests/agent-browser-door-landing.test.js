// A sign-in door with nothing on it that says so is still signed out (7 Oct 2026).
// GoHighLevel's daily check landed on app.gohighlevel.com/?logout=true and read "signed in" (ledger
// L2897, L3042), which reset the sign-in count and raised a fresh card. Virgin Media's landed on
// /myvmo2/existing-customer ("Sign in to see your bills") and read "signed in" every time (L3158,
// L3204, L3215, L3230), so a sign-in wall was cleared twice on a session that was not there. The
// unit half drives sessionVerdict on those real landings; the second half runs the real `session`
// command against a local site, to prove the check walks the site's checkUrl and reads the door.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'agent-browser.js');
const b = createRequire(import.meta.url)(SCRIPT);

// The entries as recorded in the private sites.json on 7 Oct 2026 (backup sites.json.bak-20261007-pr1).
const BILLS = 'https://www.virginmedia.com/support/help/billing-and-payment/my-virgin-media/billing';
const VM = { label: 'virginmedia.com', login: true, loginUrl: 'https://virginmedia.com/', checkUrl: BILLS,
  doorUrls: ['oauth.virginmediao2.co.uk/as/authorization.oauth2', 'www.virginmedia.com/myvmo2/existing-customer'] };
const GHL = { label: 'app.gohighlevel.com', login: true, loginUrl: 'https://app.gohighlevel.com/',
  checkUrl: 'https://app.gohighlevel.com/settings/billing' };
const AMAZON = { label: 'Amazon', login: true, loginUrl: 'https://www.amazon.co.uk/gp/css/order-history' };
const walk = (entry) => ({ entry, start: entry.checkUrl || entry.loginUrl });
const signedIn = (url, entry, pw = 0) => b.sessionVerdict(url, pw, '', '', entry && walk(entry)).signedIn;

describe('the session verdict reads a door that shows no password box', () => {
  it('the real landings of 5 to 7 Oct read signed out', () => {
    // GoHighLevel, ledger L2897 and L3042: a sign-out address, with or without the site's entry.
    expect(signedIn('https://app.gohighlevel.com/?logout=true')).toBe(false);
    expect(signedIn('https://app.gohighlevel.com/?logout=true', GHL)).toBe(false);
    expect(b.sessionVerdict('https://app.gohighlevel.com/?logout=true', 0).door).toBe('a sign-out address');
    // Virgin Media, ledger L3158/L3204/L3215/L3230: the existing-customer page is one of its doors.
    expect(signedIn('https://www.virginmedia.com/myvmo2/existing-customer', VM)).toBe(false);
    // Where its bills link sent the robot on 7 Oct (ledger L3232): the VMO2 sign-in, email first, no password box.
    // A fresh browser with no session, sent straight to the check page (the bills link's own address) the
    // same day, landed on that sign-in too, so the check page does send a signed-out robot to the door.
    expect(signedIn('https://oauth.virginmediao2.co.uk/as/authorization.oauth2?client_id=vm-onprem-pingfederate'
      + '&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3ALf5OcWSDw7MEjmq6VeW3cw2vIYVs_jah', VM)).toBe(false);
    // GoHighLevel's billing page with no session (a fresh browser, 7 Oct): back to the app's own door.
    expect(signedIn('https://app.gohighlevel.com/?url=%252Fsettings%252Fbilling', GHL)).toBe(false);
    expect(b.onSigninPage('https://app.gohighlevel.com/?url=%252Fsettings%252Fbilling', 0, '', '', walk(GHL))).toBe(true);
  });
  it('every other sign-out spelling, and only as a word of the address', () => {
    for (const u of ['https://x.example/logout', 'https://x.example/log-out?next=/', 'https://x.example/signout',
      'https://x.example/sign-out/', 'https://x.example/LogOff.aspx', 'https://x.example/account?action=log-off']) {
      expect(signedIn(u), u).toBe(false);
    }
    expect(signedIn('https://x.example/dialogoutline')).toBe(true);
    expect(signedIn('https://x.example/catalogue/outlet')).toBe(true);
  });
  it('controls: a page of the account still reads signed in, and a site checked at its own loginUrl is never sent "to its door"', () => {
    expect(signedIn('https://app.gohighlevel.com/settings/billing', GHL)).toBe(true);
    expect(signedIn('https://app.gohighlevel.com/v2/location/abc/dashboard', GHL)).toBe(true);
    expect(signedIn('https://www.virginmedia.com/myvmo2/your-bills', VM)).toBe(true);
    // Amazon is checked at its loginUrl, its order history: landing there is the signed-in page itself.
    expect(signedIn('https://www.amazon.co.uk/gp/css/order-history', AMAZON)).toBe(true);
    // With no entry the verdict is the old one: a bare page is signed in, a password box is not.
    expect(signedIn('https://www.virginmedia.com/myvmo2/existing-customer')).toBe(true);
    expect(signedIn('https://app.gohighlevel.com/settings/billing', GHL, 1)).toBe(false);
  });
});

// ── the real `session` command, end to end ──────────────────────────────────
let server, port, signedInNow = false;
const made = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const page = (body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><html><body>${body}</body></html>`); };
    if (u.pathname === '/bills') {
      if (signedInNow) return page('<h1>Your bills</h1>');
      res.writeHead(302, { location: '/as/authorization.oauth2?request_uri=one-time' }); return res.end();
    }
    if (u.pathname === '/as/authorization.oauth2') return page('<h1>Sign in</h1><label>Email address<input type="email"></label><button>Next</button>');
    if (u.pathname === '/billing') { res.writeHead(302, { location: '/?url=%252Fbilling' }); return res.end(); }
    return page('<h1>Welcome</h1><p>Pick a product.</p>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterAll(() => { server.close(); for (const d of made) rmSync(d, { recursive: true, force: true }); });

function home(entry) {
  const h = mkdtempSync(join(tmpdir(), 'od-door-'));
  made.push(h);
  const root = join(h, '.config', 'od', 'agent-browser');
  mkdirSync(join(root, 'default'), { recursive: true });
  const sites = join(root, 'sites.json');
  writeFileSync(sites, JSON.stringify({ '127.0.0.1': entry }));
  return { HOME: h, AGENT_BROWSER_SITES_FILE: sites, AGENT_BROWSER_PROFILE_ROOT: root };
}
function session(env) {
  return new Promise(res => {
    const c = spawn(process.execPath, [SCRIPT, 'session', '--site', '127.0.0.1'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), 90000);
    c.on('exit', code => {
      clearTimeout(t);
      let json = null;
      try { json = JSON.parse(out.trim().split('\n').pop()); } catch { /* reported by the assertion */ }
      const ledger = readFileSync(join(env.HOME, 'knowledge-os', 'logs', 'agent-browser', 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      res({ code, json, err, ledger });
    });
  });
}

describe('`session` walks the checkUrl and reads where it lands', () => {
  it('signed out: the check page sends the robot to a door with no password box, and the ledger says so', async () => {
    signedInNow = false;
    const env = home({ label: 'Local VM', login: true, loginUrl: `http://127.0.0.1:${port}/`,
      checkUrl: `http://127.0.0.1:${port}/bills`, doorUrls: ['127.0.0.1/as/authorization.oauth2'] });
    const r = await session(env);
    expect(r.code, r.err).toBe(0);
    expect(r.json.url).toMatch(/\/as\/authorization\.oauth2\?request_uri=one-time$/);
    expect(r.json.passwordFields).toBe(0);
    expect(r.json.signedIn).toBe(false);
    expect(r.json.signinPage).toBe(true);
    const line = r.ledger.filter(l => l.cmd === 'session').pop();
    expect(line).toMatchObject({ site: '127.0.0.1', signedIn: false, signinPage: true });
    // Signed in: the same check page shows the account.
    signedInNow = true;
    const live = await session(env);
    expect(live.json.url).toBe(`http://127.0.0.1:${port}/bills`);
    expect(live.json.signedIn).toBe(true);
  }, 120000);
  it('a check page that sends the robot back to the site\'s own loginUrl reads signed out (GoHighLevel\'s shape)', async () => {
    const env = home({ label: 'Local GHL', login: true, loginUrl: `http://127.0.0.1:${port}/`, checkUrl: `http://127.0.0.1:${port}/billing` });
    const r = await session(env);
    expect(r.code, r.err).toBe(0);
    expect(r.json.url).toBe(`http://127.0.0.1:${port}/?url=%252Fbilling`);
    expect(r.json.passwordFields).toBe(0);
    expect(r.json.signedIn).toBe(false);
    expect(r.json.door).toBe("the site's own sign-in page");
  }, 120000);
});
