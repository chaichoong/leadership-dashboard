// Kevin, 16 Oct 2026: he gives the robot access ONCE; after that the estate keeps it alive.
// Measured the same day: 34 of his 57 robot sign-ins in 14 days were for a site the robot had
// had in the 30 days before. Since the 7 Oct cookie fixes, the repeats are sites that sign the
// robot out on their own servers after a short time unused (Xero: 60 minutes), which the daily
// 06:40 keep-alive can never hold, and two Acturis insurance checks that read the wrong page.
// These drive the real functions (session-keepalive.py warm_due, agent-browser.js loadSites and
// sessionVerdict); the fixtures are the shape of the robot browser's own ledger lines.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'scripts');

// Replays the hand-back poll's ticks (:00 and :30) over a ledger. At each tick warm_due decides;
// a site it lists gets a signed-in `session` line at that tick, as the real visit writes one.
// Returns every visit and the longest time the site sat untouched between FROM and TO.
function replay({ sites, events, from, to, host }) {
  const script = `
import importlib.util, json, os, sys
from datetime import timedelta
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import signin_hold as sh
spec = importlib.util.spec_from_file_location("ka", os.path.join(${JSON.stringify(SCRIPTS)}, "session-keepalive.py"))
ka = importlib.util.module_from_spec(spec); spec.loader.exec_module(ka)
a = json.loads(sys.argv[1])
ev = [dict(e, _at=sh._at(e["at"])) for e in a["events"]]
start, end = sh._at(a["from"]), sh._at(a["to"])
tick = start.replace(minute=0 if start.minute < 30 else 30, second=0, microsecond=0) + timedelta(minutes=30)
visits, why = [], {}
while tick <= end:
    due, why = ka.warm_due(a["sites"], ev, tick)
    if a["host"] in due:
        visits.append(tick.isoformat())
        ev.append({"at": tick.isoformat(), "_at": tick, "cmd": "session", "site": a["host"],
                   "signedIn": True, "signinPage": False, "profile": "default"})
    tick += timedelta(minutes=30)
touch = sorted(e["_at"] for e in ev if ka.same_site(a["host"], ka.event_host(e)) and start <= e["_at"] <= end)
gaps = [(b - c).total_seconds() / 60 for c, b in zip([start] + touch, touch + [end])]
print("---JSON---"); print(json.dumps({"visits": visits, "maxGap": round(max(gaps), 1), "why": why}))
`;
  const out = execFileSync('python3', ['-c', script, JSON.stringify({ sites, events, from, to, host })], { encoding: 'utf8' });
  return JSON.parse(out.split('---JSON---')[1]);
}

const XERO = 'login.xero.com';
const SITES = {
  [XERO]: { label: 'Xero', login: true, loginUrl: 'https://login.xero.com/identity/user/login', idleMinutes: 60 },
  'go.xero.com': { label: 'Xero (app)', login: true, loginUrl: 'https://login.xero.com/identity/user/login' },
  'swintonbusiness.acturis.com': { label: 'Swinton', login: true, loginUrl: 'https://swintonbusiness.acturis.com/AWE/Container.aspx?CurrentStep=Login',
                                   checkUrl: 'https://swintonbusiness.acturis.com/AWE/Container.aspx?CurrentStep=MyAccount', idleMinutes: 60 },
  'ewf.companieshouse.gov.uk': { label: 'WebFiling', login: true, loginUrl: 'https://ewf.companieshouse.gov.uk/seclogin', shortSession: true, idleMinutes: 30 },
  'www.edfenergy.com': { label: 'EDF', login: true, loginUrl: 'https://www.edfenergy.com/myaccount/login' },
};
const login = (at, host) => ({ at, cmd: 'login', host, profile: 'default', mode: 'plain-chrome-mock-keychain', sessionCookiesKept: 5 });
const read = (at, url) => ({ at, cmd: 'read', url, profile: 'default' });
const check = (at, site, signedIn) => ({ at, cmd: 'session', site, url: `https://${site}/`, signedIn, botCheck: false,
                                         signinPage: !signedIn, profile: 'default' });
const REPORT = 'https://reporting.xero.com/!AbCdE/v1/Run/1000';
// warm_due once, at AT, over EVENTS.
const dueAt = (events, at) => JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, os, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import signin_hold as sh
spec = importlib.util.spec_from_file_location("ka", os.path.join(${JSON.stringify(SCRIPTS)}, "session-keepalive.py"))
ka = importlib.util.module_from_spec(spec); spec.loader.exec_module(ka)
a = json.loads(sys.argv[1])
due, why = ka.warm_due(a["sites"], [dict(e, _at=sh._at(e["at"])) for e in a["events"]], sh._at(a["at"]))
print(json.dumps({"due": due, "why": why}))`, JSON.stringify({ sites: SITES, events, at })], { encoding: 'utf8' }));

describe('a short-session site in use is kept warm (session-keepalive.py warm_due)', () => {
  // 14 Oct 2026: Kevin signed in at 09:55, the robot's reads stopped at 10:18, and the read at 11:20
  // found Xero signed out (62 minutes unused, past Xero's 60), so he signed in again at 11:26.
  const OCT14 = [login('2026-10-14T09:55:30Z', XERO), read('2026-10-14T09:55:59Z', REPORT),
                 read('2026-10-14T10:18:30Z', REPORT), read('2026-10-14T11:20:48Z', REPORT)];

  it('reproduces the lapse: with no visit between them, the gap the robot left is past Xero\'s 60 minutes', () => {
    const r = replay({ sites: { ...SITES, [XERO]: { ...SITES[XERO], idleMinutes: 0 } }, events: OCT14,
                       from: '2026-10-14T09:55:30Z', to: '2026-10-14T11:20:48Z', host: XERO });
    expect(r.visits).toEqual([]);
    expect(r.maxGap).toBeGreaterThan(60);
  });

  it('the 11:00 poll visits Xero, so the 11:20 read finds the session the robot was given', () => {
    const r = replay({ sites: SITES, events: OCT14, from: '2026-10-14T09:55:30Z', to: '2026-10-14T11:20:48Z', host: XERO });
    expect(r.visits).toEqual(['2026-10-14T11:00:00+00:00']);
    expect(r.maxGap).toBeLessThan(60);
  });

  // 13 Oct 2026: signed in 07:44, reads until 10:25, and the next need at 22:42 found Xero signed out.
  it('holds Xero overnight between two jobs, visiting at every poll and never leaving it an hour', () => {
    const events = [login('2026-10-13T07:44:11Z', XERO), read('2026-10-13T07:44:53Z', 'https://go.xero.com/app/!AbCdE/homepage'),
                    read('2026-10-13T10:25:03Z', REPORT), read('2026-10-13T22:42:51Z', REPORT)];
    const r = replay({ sites: SITES, events, from: '2026-10-13T07:44:11Z', to: '2026-10-13T22:42:51Z', host: XERO });
    expect(r.visits.length).toBeGreaterThanOrEqual(23);
    expect(r.maxGap).toBeLessThan(60);
  });

  it('stops 24 hours after the last use: no portal is visited round the clock', () => {
    const events = [login('2026-10-13T07:44:11Z', XERO), read('2026-10-13T10:25:03Z', REPORT)];
    const r = replay({ sites: SITES, events, from: '2026-10-13T07:44:11Z', to: '2026-10-15T10:00:00Z', host: XERO });
    const last = Date.parse(r.visits[r.visits.length - 1]);
    expect(last).toBeLessThanOrEqual(Date.parse('2026-10-14T10:25:03Z'));
    expect(last).toBeGreaterThan(Date.parse('2026-10-14T09:00:00Z'));
    expect(r.why[XERO]).toBe('not used in the last 24 hours');
  });

  it('holds nothing once a check reads signed out after the last sign-in, and starts again at the next sign-in', () => {
    const lapsed = [login('2026-10-13T07:44:11Z', XERO), read('2026-10-13T08:00:00Z', REPORT),
                    check('2026-10-13T09:30:00Z', 'go.xero.com', false)];
    const r = replay({ sites: SITES, events: lapsed, from: '2026-10-13T07:44:11Z', to: '2026-10-13T12:00:00Z', host: XERO });
    expect(r.visits).toEqual(['2026-10-13T08:30:00+00:00', '2026-10-13T09:00:00+00:00']);
    expect(r.why[XERO]).toBe('signed out since the last sign-in: nothing to hold');
    const back = replay({ sites: SITES, events: [...lapsed, login('2026-10-13T10:05:00Z', XERO)],
                          from: '2026-10-13T07:44:11Z', to: '2026-10-13T12:00:00Z', host: XERO });
    expect(back.visits.filter(v => v > '2026-10-13T10:05')).not.toEqual([]);
  });

  it('a step on a sibling host is use of the site, but never across a platform that hosts other brokers', () => {
    expect(dueAt([read('2026-10-14T09:00:00Z', 'https://go.xero.com/app/x')], '2026-10-14T09:40:00Z').due).toEqual([XERO]);
    const other = dueAt([read('2026-10-14T09:00:00Z', 'https://autonetbusiness.acturis.com/AWE/Container.aspx')], '2026-10-14T09:40:00Z');
    expect(other.due).toEqual([]);
    expect(other.why['swintonbusiness.acturis.com']).toBe('not used in the last 24 hours');
    // A short GOV.UK session needs Kevin's code every time, and a site with no limit is the daily keep-alive's.
    const both = dueAt([read('2026-10-14T09:00:00Z', 'https://ewf.companieshouse.gov.uk/x'), read('2026-10-14T09:00:00Z', 'https://www.edfenergy.com/myaccount')],
                       '2026-10-14T09:40:00Z');
    expect(both.due).not.toContain('ewf.companieshouse.gov.uk');
    expect(both.due).not.toContain('www.edfenergy.com');
  });
});

describe('which site a ledger line used (review, 16 Oct 2026)', () => {
  const SW = 'swintonbusiness.acturis.com';
  const AXA = 'www.landlordaxainsurance.com';
  const sites = { [SW]: SITES[SW], [AXA]: { label: 'AXA', login: true, loginUrl: 'https://www.landlordaxainsurance.com/', idleMinutes: 60 } };
  const at = (events) => JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, os, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import signin_hold as sh
spec = importlib.util.spec_from_file_location("ka", os.path.join(${JSON.stringify(SCRIPTS)}, "session-keepalive.py"))
ka = importlib.util.module_from_spec(spec); spec.loader.exec_module(ka)
a = json.loads(sys.argv[1])
due, why = ka.warm_due(a["sites"], [dict(e, _at=sh._at(e["at"])) for e in a["events"]], sh._at("2026-10-08T14:00:00Z"))
print(json.dumps(due))`, JSON.stringify({ sites, events })], { encoding: 'utf8' }));

  it('a prepare step is the site at its address, never the agent\'s words in `site`', () => {
    // 8 Oct 2026: five prepares named "www.topcashback.co.uk" ran on Swinton's pages.
    expect(at([{ at: '2026-10-08T13:10:00Z', cmd: 'prepare', site: 'www.topcashback.co.uk', profile: 'default',
                 url: 'https://swintonbusiness.acturis.com/AWE/Container.aspx?CurrentStep=Quote' }])).toEqual([SW]);
  });

  it('a handover, and its dry run, are use of the site they reached', () => {
    expect(at([{ at: '2026-10-08T13:10:00Z', cmd: 'handover', site: 'axa-via-topcashback', profile: 'default',
                 url: 'https://www.landlordaxainsurance.com/AWE/Container.aspx?CurrentStep=MyAXA' }])).toEqual([AXA]);
    expect(at([{ at: '2026-10-08T13:10:00Z', cmd: 'handover-dry-run', site: 'axa-via-topcashback', profile: 'default',
                 url: 'https://www.landlordaxainsurance.com/AWE/Container.aspx?CurrentStep=Quote' }])).toEqual([AXA]);
  });

  it('free text that is no address is no site, and never stops the pass', () => {
    expect(at([{ at: '2026-10-08T13:10:00Z', cmd: 'handover', site: 'axa quote ]retry', profile: 'default' },
               { at: '2026-10-08T13:11:00Z', cmd: 'read', url: 'https://swintonbusiness.acturis.com/AWE/Container.aspx', profile: 'default' }])).toEqual([SW]);
  });

  it('a line from another profile, or stamped in the future, is not use now', () => {
    const quote = 'https://swintonbusiness.acturis.com/AWE/Container.aspx';
    expect(at([{ at: '2026-10-08T13:10:00Z', cmd: 'read', url: quote, profile: 'utilita-apt1' }])).toEqual([]);
    expect(at([{ at: '2026-10-08T13:10:00Z', cmd: 'read', url: quote, profile: 'default' },
               { at: '2026-10-08T13:55:00Z', cmd: 'read', url: quote, profile: 'default' },
               { at: '2026-10-08T15:00:00Z', cmd: 'read', url: quote, profile: 'default' }])).toEqual([]);
    expect(at([{ at: '2026-10-08T13:10:00Z', cmd: 'read', url: quote, profile: 'default' },
               { at: '2026-10-08T15:00:00Z', cmd: 'read', url: quote, profile: 'default' }])).toEqual([SW]);
  });
});

describe('the Acturis checks read the account, not the door (agent-browser.js built-in sites)', () => {
  const root = mkdtempSync(join(tmpdir(), 'od-keepwarm-'));
  // Before the module loads: SITES_FILE is read once, at load. Kevin's file carries these hosts
  // with a label, login and loginUrl only, as `login` wrote them.
  process.env.AGENT_BROWSER_PROFILE_ROOT = root;
  process.env.AGENT_BROWSER_SITES_FILE = join(root, 'sites.json');
  writeFileSync(process.env.AGENT_BROWSER_SITES_FILE, JSON.stringify({
    'swintonbusiness.acturis.com': { label: 'swintonbusiness.acturis.com', login: true,
      loginUrl: 'https://swintonbusiness.acturis.com/AWE/Container.aspx?CurrentStep=Login&CurrentWorkflow=StandardB2C&RefererWorkflow=StandardB2C&RefererStep=MyAccount' },
    'landlordaxainsurance.com': { label: 'AXA landlord insurance', login: true, loginUrl: 'https://landlordaxainsurance.com/' },
    'login.xero.com': { label: 'login.xero.com', login: true, loginUrl: 'https://login.xero.com/identity/user/login' },
  }));
  const b = createRequire(import.meta.url)(join(SCRIPTS, 'agent-browser.js'));
  const sites = b.loadSites();

  it('Swinton is checked on My account, which a dead session leaves for the Login step', () => {
    expect(sites['swintonbusiness.acturis.com'].checkUrl).toMatch(/CurrentStep=MyAccount/);
    expect(sites['swintonbusiness.acturis.com'].loginUrl).toMatch(/CurrentStep=Login/);
    expect(sites['swintonbusiness.acturis.com'].idleMinutes).toBe(60);
    expect(sites['login.xero.com'].idleMinutes).toBe(60);
    expect(sites['login.xero.com'].label).toBe('login.xero.com');           // Kevin's own fields still win
  });

  it('the bare AXA host no longer reads "signed in" off the marketing front page', () => {
    const entry = sites['landlordaxainsurance.com'];
    // Before: the check began at the front page and stayed there, with no password box: "signed in".
    expect(b.sessionVerdict('https://landlordaxainsurance.com/', 0, 'Landlord insurance', 'AXA', { entry, start: entry.loginUrl }).signedIn).toBe(true);
    // Now it begins at My AXA, so a landing back on the front page is the site's door.
    expect(entry.checkUrl).toMatch(/^https:\/\/www\.landlordaxainsurance\.com\/AWE\/Container\.aspx\?CurrentStep=MyAXA/);
    expect(b.sessionVerdict('https://landlordaxainsurance.com/', 0, 'Landlord insurance', 'AXA', { entry, start: entry.checkUrl }).signedIn).toBe(false);
  });
});
