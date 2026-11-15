// Swinton and Everywhen come off the robot, and stay off (Kevin, 15 Nov 2026: "Remove").
// Every job on either site stalled on a sign-in that dropped or a form the robot could not drive.
// The private sites.json was edited by hand; these prove the code keeps both sites off whatever a
// later hand edit, a `login` or an agent's wall tries. They drive the real agent-browser.js (as a
// module and as a command, with a temp HOME and a temp sites.json) and the real cmd_block in
// agent-dispatch.py with Airtable stubbed out, as tests/agent-dispatch-blockers.test.js does.
// No step here reaches a real website: a browser launch is caught by a preload before it starts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'agent-browser.js');
const DISPATCH = join(ROOT, 'scripts', 'agent-dispatch.py');
const RETIRED_HOSTS = ['swintonbusiness.acturis.com', 'everywhen.co.uk', 'business.everywhen.co.uk'];
const ROUTE = /came off the robot on 2026-11-15 \(Kevin\): the site refuses the robot.*Instead: quote through RightSure via TopCashback/;

// A private sites.json that still lists all three retired hosts, as a stale hand edit would.
function home() {
  const h = mkdtempSync(join(tmpdir(), 'od-retired-'));
  const root = join(h, 'agent-browser');
  mkdirSync(root, { recursive: true });
  const sites = join(root, 'sites.json');
  writeFileSync(sites, JSON.stringify({
    'swintonbusiness.acturis.com': { label: 'Swinton', login: true, loginUrl: 'https://swintonbusiness.acturis.com/AWE/Container.aspx?CurrentStep=Login' },
    'everywhen.co.uk': { label: 'Everywhen', login: true, loginUrl: 'https://everywhen.co.uk/login' },
    'business.everywhen.co.uk': { label: 'Everywhen business', login: true, loginUrl: 'https://business.everywhen.co.uk/' },
    'quote.rightsureforbusiness.co.uk': { label: 'RightSure', login: false },
  }, null, 2));
  // Any attempt to load Playwright is recorded and stopped: proof that no browser opened.
  const marker = join(h, 'browser-opened');
  const preload = join(h, 'no-browser.cjs');
  writeFileSync(preload, `
const Module = require('module'); const fs = require('fs');
const load = Module._load;
Module._load = function (req, ...rest) {
  if (/playwright/.test(String(req))) { fs.writeFileSync(${JSON.stringify(marker)}, req); throw new Error('test: no browser'); }
  return load.call(this, req, ...rest);
};`);
  return { h, root, sites, marker, preload, env: { ...process.env, HOME: h, AGENT_BROWSER_PROFILE_ROOT: root, AGENT_BROWSER_SITES_FILE: sites, AGENT_HANDOVER_DIR: join(h, 'handover') } };
}
// agent-browser.js and the files it loads beside it, copied to D without its retired list.
function copyScript(d) {
  for (const f of ['agent-browser.js', 'declaration-words.js', 'form-facts.js', 'form-facts-schema.json']) {
    copyFileSync(join(ROOT, 'scripts', f), join(d, f));
  }
  return join(d, 'agent-browser.js');
}
function cli(t, args, script = SCRIPT) {
  const r = spawnSync(process.execPath, ['--require', t.preload, script, ...args], { env: t.env, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr, opened: existsSync(t.marker) };
}

// Module half: the env is read once, at load, so it is set before the require.
const T = home();
process.env.AGENT_BROWSER_PROFILE_ROOT = T.root;
process.env.AGENT_BROWSER_SITES_FILE = T.sites;
const b = createRequire(import.meta.url)(SCRIPT);

describe('agent-browser.js keeps the retired sites off', () => {
  it('the built-in list no longer holds Swinton (read through a copy whose retired list is empty)', () => {
    const d = mkdtempSync(join(tmpdir(), 'od-retired-builtin-'));
    const copy = copyScript(d);
    writeFileSync(join(d, 'retired-sites.json'), JSON.stringify({ version: 1, retired: [] }));
    const t = { ...home() };
    writeFileSync(t.sites, '{}');
    const r = cli(t, ['sites'], copy);
    expect(r.code, r.err).toBe(0);
    const sites = JSON.parse(r.out);
    expect(Object.keys(sites)).not.toContain('swintonbusiness.acturis.com');
    expect(Object.keys(sites)).toContain('www.landlordaxainsurance.com');      // control: the list itself loaded
  });

  it('a private file that still lists all three hosts yields none of them from `sites` or the sign-in list', () => {
    const t = home();
    const r = cli(t, ['sites']);
    expect(r.code, r.err).toBe(0);
    const sites = JSON.parse(r.out);
    for (const h of RETIRED_HOSTS) expect(Object.keys(sites)).not.toContain(h);
    expect(Object.keys(sites)).toContain('quote.rightsureforbusiness.co.uk');  // control: the rest of the file still counts
    const list = cli(t, ['signin-list']);
    expect(list.code, list.err).toBe(0);
    expect(list.out).not.toMatch(/swinton|everywhen/i);
    expect(b.loadSites()).not.toHaveProperty(['swintonbusiness.acturis.com']);
  });

  it('`sites --retired` prints the retired list as JSON', () => {
    const r = cli(home(), ['sites', '--retired']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).map(x => x.host)).toEqual(['swintonbusiness.acturis.com', 'everywhen.co.uk']);
  });

  it('hostAllowed is false for each retired host, and true for RightSure and an unrelated listed host', () => {
    for (const h of [...RETIRED_HOSTS, 'www.everywhen.co.uk', 'SwintonBusiness.Acturis.com:443']) {
      expect(b.hostAllowed(`https://${h}/x`), h).toBe(false);
    }
    expect(b.hostAllowed('https://quote.rightsureforbusiness.co.uk/start')).toBe(true);
    expect(b.hostAllowed('https://www.gov.uk/apply')).toBe(true);
    expect(b.retiredSite('https://business.everywhen.co.uk/q')).toMatchObject({ host: 'everywhen.co.uk' });
    // A name inside another word or domain is not the retired site.
    expect(b.retiredSite('notswinton.example')).toBeNull();
    expect(b.retiredSite('everywhenever.example')).toBeNull();
    expect(b.retiredSite('everywhen.co.uk.example')).toBeNull();
  });

  it('read, session, prepare and handover aimed at a retired host are refused with the route, and no browser opens', () => {
    const t = home();
    const plan = join(t.h, 'plan.json');
    writeFileSync(plan, JSON.stringify({ site: 'everywhen', why: 'tick the declarations and pay',
      steps: [{ do: 'goto', url: 'https://business.everywhen.co.uk/quote' }] }));
    const runs = {
      read: cli(t, ['read', '--url', 'https://swintonbusiness.acturis.com/AWE/Container.aspx']),
      session: cli(t, ['session', '--site', 'swintonbusiness.acturis.com']),
      prepare: cli(t, ['prepare', '--plan', plan, '--shot', join(t.h, 'p.png')]),
      handover: cli(t, ['handover', '--task', 'recAAAAAAAAAAAAAA', '--plan', plan, '--dry-run', '--shot', join(t.h, 'h.png')]),
    };
    for (const [name, r] of Object.entries(runs)) {
      expect(r.code, `${name}: ${r.err}`).toBe(1);
      expect(r.err, name).toMatch(ROUTE);
    }
    expect(existsSync(t.marker)).toBe(false);
  });

  it('recordLoginSite refuses a retired host, with or without add, and the file is unchanged byte for byte', () => {
    const before = readFileSync(T.sites);
    for (const [url, add] of [['https://swintonbusiness.acturis.com/AWE/Container.aspx?CurrentStep=Login', false],
      ['https://www.everywhen.co.uk/login', true], ['https://business.everywhen.co.uk/', true]]) {
      expect(() => b.recordLoginSite(url, { add }), url).toThrow(ROUTE);
    }
    expect(readFileSync(T.sites).equals(before)).toBe(true);
    const t = home();
    const was = readFileSync(t.sites);
    const r = cli(t, ['login', '--url', 'https://everywhen.co.uk/login', '--add']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(ROUTE);
    expect(readFileSync(t.sites).equals(was)).toBe(true);
  });

  it('a missing or broken retired-sites.json stops the command, never reads as "nothing retired"', () => {
    const d = mkdtempSync(join(tmpdir(), 'od-retired-missing-'));
    const copy = copyScript(d);
    const t = home();
    const missing = cli(t, ['sites'], copy);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/retired sites list .*could not be read/);
    expect(missing.out).toBe('');
    writeFileSync(join(d, 'retired-sites.json'), '{"version": 1, "retired": [{"host": "everywhen.co.uk"}]}');
    const broken = cli(t, ['read', '--url', 'https://www.gov.uk/x'], copy);
    expect(broken.code).toBe(1);
    expect(broken.err).toMatch(/retired sites list .*not in its shape/);
    expect(broken.opened).toBe(false);
  });
});

// ── the robot's browser never reaches a retired host, by any road ─────────────
// One loopback practice server answers three names, each pointed at 127.0.0.1 by the test-only
// AGENT_BROWSER_TEST_RESOLVER: allowed.test and other.test (on the list) and retired.test, which the
// test retires with AGENT_RETIRED_SITES_TEST. The retired rule comes first, so retired.test never
// resolves (Chrome takes the first rule that matches a name: checked by hand on Chrome 157 with both
// orders). Every request is logged with the name it was sent to, so "never reached" is read off the
// server, not off the robot's word.
const hits = [];
let server, port;
const html = (res, body, headers = {}) => {
  res.writeHead(200, { 'content-type': 'text/html', ...headers });
  res.end(`<!doctype html><html><head><title>${body.title}</title></head><body>${body.body}</body></html>`);
};
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const name = String(req.headers.host || '').split(':')[0];
    hits.push(`${name}${req.url}`);
    const u = new URL(req.url, 'http://x');
    const R = `http://retired.test:${port}`;
    if (name === 'retired.test') {
      // A form, an asset and a reporter that tells allowed.test of any keystroke or click, so a step
      // run on this page would show up even though its own server is never reached.
      return html(res, { title: 'Retired page', body: '<h1>Retired page</h1><img src="/asset.png">'
        + '<form method="post" action="/post"><input id="name" name="name"><button id="send">Send</button></form>'
        + `<script>const tell = (w) => fetch("http://allowed.test:${port}/" + w, { mode: "no-cors" });`
        + 'document.addEventListener("click", () => tell("clicked")); document.addEventListener("input", () => tell("typed"));</script>' });
    }
    if (u.pathname === '/link') return html(res, { title: 'Allowed', body: `<a id="go" href="${R}/page">Next page</a>` });
    if (u.pathname === '/redirect') { res.writeHead(302, { location: `${R}/page` }); return res.end(); }
    if (u.pathname === '/blank') return html(res, { title: 'Allowed', body: `<a id="go" target="_blank" href="${R}/page">Open</a>` });
    if (u.pathname === '/blank-ok') return html(res, { title: 'Allowed', body: '<a id="go" target="_blank" href="/">Open</a>' });
    if (u.pathname === '/image') return html(res, { title: 'Allowed with image', body: `<h1>Allowed with image</h1><img src="${R}/pic.png">` });
    if (u.pathname === '/cached') return html(res, { title: 'Cached', body: '<img src="/asset.png">' });
    if (u.pathname === '/asset.png') {
      res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'max-age=3600' });
      return res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
    }
    return html(res, { title: 'Allowed home', body: '<h1>Allowed home</h1>' });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  port = server.address().port;
});
afterAll(() => server && server.close());

function browserRun(steps) {
  const t = home();
  writeFileSync(t.sites, JSON.stringify({ 'allowed.test': { label: 'Practice', login: false }, 'other.test': { label: 'Practice two', login: false } }));
  const plan = join(t.h, 'plan.json');
  writeFileSync(plan, JSON.stringify({ site: 'practice', steps }));
  const env = { ...t.env, AGENT_RETIRED_SITES_TEST: 'retired.test',
    AGENT_BROWSER_TEST_RESOLVER: 'allowed.test=127.0.0.1,other.test=127.0.0.1,retired.test=127.0.0.1' };
  return new Promise((ok) => {
    // Async on purpose: the practice server lives in this process and must keep answering.
    const c = spawn(process.execPath, [SCRIPT, 'prepare', '--plan', plan, '--shot', join(t.h, 'shot.png')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => c.kill('SIGKILL'), 90000);
    c.on('exit', (code) => {
      clearTimeout(timer);
      const file = join(t.h, 'knowledge-os', 'logs', 'agent-browser', 'runs.jsonl');
      const ledger = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
      ok({ code, out, err, ledger });
    });
  });
}
const A = (p) => `http://allowed.test:${port}${p}`;
const LOCAL_ROUTE = /BROWSER REFUSED: retired\.test came off the robot on test \(Kevin\)/;
const retiredHits = () => hits.filter(h => h.startsWith('retired.test'));

describe('a click, a redirect, a tab or an image never reaches a retired host in the robot\'s browser', () => {
  it('a link on an allowed page to the retired host: never reached, and the step after it fails with the route message', async () => {
    hits.length = 0;
    const r = await browserRun([{ do: 'goto', url: A('/link') }, { do: 'click', selector: '#go' },
      { do: 'fill', selector: '#name', value: 'robot' }]);
    expect(r.code, r.err).toBe(1);
    expect(r.err).toMatch(LOCAL_ROUTE);
    expect(r.err).not.toMatch(/net::ERR_/);
    expect(retiredHits()).toEqual([]);
  }, 120000);

  it('a 302 from the allowed host to the retired one: the retired server receives nothing, and no queued step runs', async () => {
    hits.length = 0;
    const r = await browserRun([{ do: 'goto', url: A('/redirect') }, { do: 'fill', selector: '#name', value: 'robot' },
      { do: 'click', selector: '#send' }]);
    expect(r.code, r.err).toBe(1);
    expect(r.err).toMatch(LOCAL_ROUTE);
    expect(r.err).not.toMatch(/net::ERR_/);
    expect(retiredHits()).toEqual([]);
    expect(hits).toEqual(['allowed.test/redirect']);               // no keystroke or click was ever reported
  }, 120000);

  it('an image from the retired host is blocked while the allowed page loads; a second allowed host still loads', async () => {
    hits.length = 0;
    const img = await browserRun([{ do: 'goto', url: A('/image') }]);
    expect(img.code, img.err).toBe(0);
    expect(JSON.parse(img.out).title).toBe('Allowed with image');
    expect(retiredHits()).toEqual([]);
    const other = await browserRun([{ do: 'goto', url: `http://other.test:${port}/` }]);
    expect(other.code, other.err).toBe(0);
    expect(JSON.parse(other.out).title).toBe('Allowed home');
  }, 120000);

  it('a new tab to the retired host is refused while the run\'s own work finishes: exit 0, retiredBlocked on its ledger line', async () => {
    hits.length = 0;
    const r = await browserRun([{ do: 'goto', url: A('/blank') }, { do: 'click', selector: '#go' }, { do: 'wait', ms: 2000 }]);
    expect(r.code, r.err).toBe(0);
    expect(retiredHits()).toEqual([]);
    expect(r.ledger.find(l => l.cmd === 'prepare')).toMatchObject({ retiredBlocked: ['retired.test'] });
    const ok = await browserRun([{ do: 'goto', url: A('/blank-ok') }, { do: 'click', selector: '#go' }, { do: 'wait', ms: 2000 }]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.ledger.find(l => l.cmd === 'prepare')).not.toHaveProperty('retiredBlocked');
    expect(hits.filter(h => h === 'allowed.test/')).toHaveLength(1);   // the allowed tab did load
  }, 120000);

  it('the HTTP cache still works with the block on: an asset with max-age is fetched once for two loads', async () => {
    hits.length = 0;
    const r = await browserRun([{ do: 'goto', url: A('/cached') }, { do: 'wait', ms: 500 }, { do: 'goto', url: A('/cached') }, { do: 'wait', ms: 500 }]);
    expect(r.code, r.err).toBe(0);
    expect(hits.filter(h => h === 'allowed.test/cached')).toHaveLength(2);
    expect(hits.filter(h => h === 'allowed.test/asset.png')).toHaveLength(1);
  }, 120000);

  it('the retired rules come first in --host-resolver-rules, and an existing value is kept after them', () => {
    const args = b.withRetiredRules(['--mute-audio', '--host-resolver-rules=MAP keep.test 127.0.0.1']);
    expect(args[0]).toBe('--mute-audio');
    expect(args.filter(a => a.startsWith('--host-resolver-rules='))).toHaveLength(1);
    expect(args[1]).toBe('--host-resolver-rules=MAP swintonbusiness.acturis.com ~NOTFOUND, MAP *.swintonbusiness.acturis.com ~NOTFOUND, '
      + 'MAP everywhen.co.uk ~NOTFOUND, MAP *.everywhen.co.uk ~NOTFOUND, MAP keep.test 127.0.0.1');
  });

  it('the test switches take .test and .example names only, the resolver only 127.0.0.1, and the list only grows', () => {
    const t = home();
    for (const bad of ['everywhen.co.uk', 'example.com', '127.0.0.1:4100', 'localhost']) {
      const r = spawnSync(process.execPath, [SCRIPT, 'sites', '--retired'], { env: { ...t.env, AGENT_RETIRED_SITES_TEST: bad }, encoding: 'utf8' });
      expect(r.status, bad).toBe(1);
      expect(r.stderr, bad).toMatch(/names ending \.test or \.example only/);
    }
    const ok = spawnSync(process.execPath, [SCRIPT, 'sites', '--retired'], { env: { ...t.env, AGENT_RETIRED_SITES_TEST: 'retired.test' }, encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout).map(x => x.host)).toEqual(['swintonbusiness.acturis.com', 'everywhen.co.uk', 'retired.test']);
    const prev = process.env.AGENT_BROWSER_TEST_RESOLVER;
    try {
      for (const bad of ['everywhen.co.uk=127.0.0.1', 'a.test=10.0.0.1', 'a.test', 'a.test=127.0.0.1=x', 'evil.com=127.0.0.1']) {
        process.env.AGENT_BROWSER_TEST_RESOLVER = bad;
        expect(() => b.retiredResolverRules(), bad).toThrow(/name=127\.0\.0\.1 pairs/);
      }
      process.env.AGENT_BROWSER_TEST_RESOLVER = 'a.test=127.0.0.1';
      expect(b.retiredResolverRules().slice(-1)).toEqual(['MAP a.test 127.0.0.1']);     // after every retired rule
    } finally {
      if (prev === undefined) delete process.env.AGENT_BROWSER_TEST_RESOLVER; else process.env.AGENT_BROWSER_TEST_RESOLVER = prev;
    }
  });
});

// ── agent-dispatch.py cmd_block ───────────────────────────────────────────────
function py(snippet) {
  const script = `
import importlib.util, json, sys, io, contextlib
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
AF = m.AF
TASKS, WRITES, FINDINGS = {}, [], []
def rec(i):
    TASKS[i] = {"id": i, "fields": {AF["notes"]: "", AF["status"]: "Today", AF["approvalOutcome"]: "",
                                      AF["name"]: "INSURANCE: test task", AF["approvedAt"]: "",
                                      AF["teamMember"]: ["recAgentAaaaaaaaa"]}}
def _get(i): return json.loads(json.dumps(TASKS[i]))
def _patch(i, fields):
    WRITES.append(i)
    TASKS[i]["fields"].update(fields)
m.get_task = _get
m.patch_task = _patch
m.ledger_append = lambda t, e: None
# The retired hosts as a stale list would still hold them, so only the new refusal stops a wall.
m.load_login_sites = lambda: {
    "swintonbusiness.acturis.com": {"label": "Swinton", "login": True, "loginUrl": "https://swintonbusiness.acturis.com/"},
    "everywhen.co.uk": {"label": "Everywhen", "login": True, "loginUrl": "https://everywhen.co.uk/login"},
    "www.topcashback.co.uk": {"label": "TopCashback", "login": True, "loginUrl": "https://www.topcashback.co.uk/logon/"}}
m.BROWSER_LEDGER = "/nonexistent/od-test-browser-ledger.jsonl"
m.ledger_last_events = lambda: {}
m.finding_details = lambda: {}
m.file_tool_finding = lambda t, s, w, agent="": (FINDINGS.append(s), "20261115-agent-dispatch-901")[1]
def _no_walk(*a, **k): raise RuntimeError("test: a door walk would open the robot's browser")
m.session_walk = _no_walk
class A:
    def __init__(self, **kw): self.__dict__.update(kw)
def block(i, kind, subject, why="Seen when I looked."):
    rec(i)
    out, err = io.StringIO(), None
    try:
        with contextlib.redirect_stdout(out):
            m.cmd_block(A(task=i, kind=kind, subject=subject, why=why, finding=None, steps=None, profile=None))
    except SystemExit as e:
        err = str(e)
    except Exception as e:
        err = "RAISED " + type(e).__name__ + ": " + str(e)
    return {"err": err, "wrote": i in WRITES, "blk": m.task_blocker(TASKS[i]["fields"][AF["notes"]])}
${snippet}
`;
  // A temp HOME, no door walks: nothing here reads the robot's own files or opens its browser.
  const h = mkdtempSync(join(tmpdir(), 'od-retired-py-home-'));
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: h, SIGNIN_SKIP_WALK: '1' } }));
}

describe('agent-dispatch.py refuses a wall on a retired site', () => {
  it('SIGN-IN and SITE on each retired host exit with the route and write nothing', () => {
    const r = py(`
out = {}
for n, h in enumerate(["swintonbusiness.acturis.com", "https://business.everywhen.co.uk/quote", "www.everywhen.co.uk"]):
    for kind in ("SIGN-IN", "SITE"):
        out[kind + " " + h] = block(f"t{n}{kind}", kind, h)
print(json.dumps(out))`);
    for (const [k, v] of Object.entries(r)) {
      expect(v.err, k).toMatch(/^ERROR: refusing a (SIGN-IN|SITE) wall: /);
      expect(v.err, k).toMatch(ROUTE);
      expect(v.err, k).toMatch(/Do not raise a wall on it: take the route above, and if the job cannot be done that way, escalate it as a decision\./);
      expect(v.wrote, k).toBe(false);
      expect(v.blk, k).toBeNull();
    }
  });

  it('a TOOL wall that carries a retired HOST is refused; a TOOL wall on anything else still opens', () => {
    const r = py(`
print(json.dumps({"host": block("t1", "TOOL", "swintonbusiness.acturis.com quote form", "the robot cannot drive the form"),
                  "url": block("t2", "TOOL", "quote form", "https://business.everywhen.co.uk/quote drops the sign-in"),
                  "mail": block("t3", "TOOL", "form", "the reply to quotes@everywhen.co.uk. bounced"),
                  "other": block("t4", "TOOL", "node missing from PATH", "command not found: node"),
                  "findings": FINDINGS}))`);
    for (const k of ['host', 'url', 'mail']) {
      expect(r[k].err, k).toMatch(ROUTE);
      expect(r[k].wrote, k).toBe(false);
    }
    expect(r.other.err).toBeNull();                                  // control: an unrelated TOOL wall opens
    expect(r.other.blk).toMatchObject({ kind: 'TOOL', finding: '20261115-agent-dispatch-901' });
    expect(r.findings).toEqual(['node missing from PATH']);          // no finding was filed for the refused three
  });

  it('a TOOL wall that only NAMES Swinton or Everywhen opens (finding A1), as does a host that merely contains one', () => {
    const r = py(`
cases = [
    ("send-email.py Gmail send failed", "send-email.py Gmail send failed on the reply to Swinton about policy RSAP0000000 renewal"),
    ("fintable cannot match", "fintable cannot match DIRECT DEBIT TO CLOSE-SWINTON REF 000000"),
    ("Salford council portal", "Salford council portal for the flat in Swinton, M27"),
    ("the ruling", "Kevin ruled on 15 Nov 2026 that Swinton and Everywhen come off the robot; the RightSure page will not load"),
    ("noteverywhen.co.uk form", "noteverywhen.co.uk drops the session"),
    ("form", "everywhen.co.uk.evil.example refuses the robot"),
]
print(json.dumps({"tool": [block(f"t{i}", "TOOL", s, w) for i, (s, w) in enumerate(cases)],
                  "site1": block("s1", "SITE", "notswinton.example"),
                  "site2": block("s2", "SITE", "everywhenever.example"),
                  "signin": block("s3", "SIGN-IN", "www.topcashback.co.uk")}))`);
    r.tool.forEach((v, i) => {
      expect(v.err, `case ${i}`).toBeNull();
      expect(v.wrote, `case ${i}`).toBe(true);
    });
    for (const k of ['site1', 'site2', 'signin']) {
      expect(r[k].err, k).toBeNull();
      expect(r[k].wrote, k).toBe(true);
    }
  });

  it('submit refuses a SIGN-IN NEEDED line on a retired host and accepts one on any other site', () => {
    const r = py(`
import tempfile, types, os
def submit(i, line):
    rec(i)
    report = "Portfolio insurance review. " + "Detail line. " * 30 + "\\n"
    carry = "**Carrying this out will involve:** filing the findings on the task; nothing is sent."
    fh = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False)
    fh.write(report + line + "\\n\\n" + carry)
    fh.close()
    args = types.SimpleNamespace(task=i, agent=sorted(m.AGENTS)[0], type="Research", output_file=fh.name, tier1=False)
    out, err = io.StringIO(), None
    try:
        with contextlib.redirect_stdout(out):
            m.cmd_submit(args)
    except SystemExit as e:
        err = str(e)
    finally:
        os.unlink(fh.name)
    return {"err": err, "wrote": i in WRITES}
print(json.dumps({"sw": submit("recSubmitAaaaaa01", "SIGN-IN NEEDED: Swinton (https://swintonbusiness.acturis.com/AWE/Container.aspx?CurrentStep=Login)"),
                  "ew": submit("recSubmitAaaaaa02", "SIGN-IN NEEDED: business.everywhen.co.uk"),
                  "ok": submit("recSubmitAaaaaa03", "SIGN-IN NEEDED: TopCashback (https://www.topcashback.co.uk/logon/)")}))`);
    for (const k of ['sw', 'ew']) {
      expect(r[k].err, k).toMatch(/^ERROR: refusing to submit recSubmitAaaaaa0\d: its SIGN-IN NEEDED line is for a retired site\./);
      expect(r[k].err, k).toMatch(ROUTE);
      expect(r[k].err, k).toMatch(/Do not raise a wall on it/);
      expect(r[k].wrote, k).toBe(false);
    }
    expect(r.ok.err).toBeNull();                                     // control: any other sign-in line still becomes a card
    expect(r.ok.wrote).toBe(true);
  });

  it('signin-waiting leaves out a card or wall on a retired host, and lists the rest', () => {
    const r = py(`
out = lambda t: "Report.\\n\\nSIGN-IN NEEDED: " + t
def card(i, text, notes=""):
    return {"id": i, "fields": {AF["agentOutput"]: text, AF["name"]: "INSURANCE: " + i, AF["notes"]: notes, AF["teamMember"]: []}}
cards = [card("recCardSwinton001", out("Swinton (https://swintonbusiness.acturis.com/AWE/Container.aspx)")),
         card("recCardEverywhen1", out("Everywhen (https://business.everywhen.co.uk/)")),
         card("recCardTopcash001", out("TopCashback (https://www.topcashback.co.uk/logon/)"))]
walls = [card("recWallEverywhen1", "", m.blocker_note("01 Nov 2026 10:00", "agent", m.BLOCKER_OPEN_MARK,
              {"kind": "SIGN-IN", "subject": "everywhen.co.uk", "why": "x", "finding": ""}, "x [since 2026-11-01T10:00:00Z]"))]
m.query_tasks = lambda formula, *a, **k: walls if "Notes" in formula else cards
groups = m.signin_waiting()
print(json.dumps([[t["id"] for t in g["tasks"]] for g in groups]))`);
    expect(r).toEqual([['recCardTopcash001']]);
  });

  it('a missing or broken retired-sites.json raises, never reads as an empty list', () => {
    const d = mkdtempSync(join(tmpdir(), 'od-retired-py-'));
    const bad = join(d, 'bad.json');
    writeFileSync(bad, '{"version": 1, "retired": [{"host": "everywhen.co.uk", "names": []}]}');
    const truthy = join(d, 'truthy.json');
    writeFileSync(truthy, JSON.stringify({ version: true, retired: [] }));
    const r = py(`
m.RETIRED_SITES_FILE = ${JSON.stringify(join(d, 'missing.json'))}
a = block("t1", "SIGN-IN", "www.topcashback.co.uk")
b = block("t2", "TOOL", "node", "missing")
m.RETIRED_SITES_FILE = ${JSON.stringify(bad)}
c = block("t3", "SITE", "notswinton.example")
m.RETIRED_SITES_FILE = ${JSON.stringify(truthy)}
d = block("t4", "SITE", "notswinton.example")
print(json.dumps({"a": a, "b": b, "c": c, "d": d}))`);
    expect(r.a.err).toMatch(/^RAISED FileNotFoundError/);
    expect(r.b.err).toMatch(/^RAISED FileNotFoundError/);
    expect(r.c.err).toMatch(/^RAISED ValueError: .*not in its shape/);
    expect(r.d.err).toMatch(/^RAISED ValueError: .*not in its shape/);
    for (const k of ['a', 'b', 'c', 'd']) expect(r[k].wrote, k).toBe(false);
  });
});
