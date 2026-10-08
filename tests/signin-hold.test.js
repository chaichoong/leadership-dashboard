// Kevin, 2 Oct 2026: "The robot sign-in constantly asks me to re-sign in for
// three specific sites ... ensure it doesn't happen moving forwards and only
// when required." The 06:40 keep-alive raised a sign-in card every morning for
// any listed site that read signed out, with no memory of whether his last
// sign-in had stuck: EDF 15 cards, Amazon 7, and BW Legal's portal (no account
// yet) one a day. scripts/signin_hold.py is the memory. These drive the real
// functions; the fixtures are the sites' own ledger lines.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'scripts');

function py(body, arg) {
  const script = `
import importlib.util, json, os, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import signin_hold as sh
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(SCRIPTS)}, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
arg = json.loads(sys.argv[1])
${body}
`;
  return JSON.parse(execFileSync('python3', ['-c', script, JSON.stringify(arg || {})], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('---JSON---')[1]);
}

const login = (at, host, profile = 'default') => ({ at, cmd: 'login', host, profile, mode: 'plain-chrome-mock-keychain', sessionCookiesKept: 0 });
const check = (at, site, signedIn, extra = {}) => ({ at, cmd: 'session', site, url: `https://${site}/`, signedIn, botCheck: false, profile: 'default', ...extra });
const out = (at, site) => check(at, site, false, { signinPage: true });
const seen = (at, site) => check(at, site, true, { signinPage: false });

// EDF's ledger, 30 Sep to 2 Oct 2026: signed out at the 06:40 check the morning after each sign-in.
const EDF = 'www.edfenergy.com';
const EDF_LINES = [
  out('2026-09-30T05:40:28.912Z', EDF),
  login('2026-09-30T08:24:12.926Z', EDF),
  out('2026-10-01T05:40:30.352Z', EDF),
  login('2026-10-01T08:48:10.871Z', EDF),
  out('2026-10-02T05:40:30.921Z', EDF),
];
// A site that holds: one sign-in, seen signed in every morning for three weeks, then a real lapse.
const P = 'app.pingen.com';
const daily = (site, from, days) => Array.from({ length: days }, (_, i) =>
  seen(new Date(Date.parse(from) + i * 86400000).toISOString(), site));
const HELD_THEN_LAPSED = [login('2026-09-01T08:00:00Z', P), ...daily(P, '2026-09-02T05:40:00Z', 20), out('2026-09-22T05:40:00Z', P)];

const unheld = (events, host, urlHost) => py(`
print('---JSON---'); print(json.dumps([d.strftime('%Y-%m-%d') for d in sh.unheld_signins(arg['events'], arg['host'], arg.get('urlHost'))]))`,
  { events, host, urlHost });

describe('a site that does not stay signed in (signin_hold.unheld_signins)', () => {
  it('EDF, signed out the morning after each of the last two sign-ins: both are named', () => {
    expect(unheld(EDF_LINES, EDF)).toEqual(['2026-09-30', '2026-10-01']);
  });

  it('one sign-in that did not hold is not enough: he is asked a second time', () => {
    expect(unheld(EDF_LINES.slice(3), EDF)).toEqual([]);
    expect(unheld([], EDF)).toEqual([]);
  });

  it('BW Legal, no account yet: each window closes still signed out, minutes later', () => {
    const BW = 'portal.bwlegal.co.uk';
    expect(unheld([
      login('2026-09-30T08:23:04.392Z', BW), out('2026-09-30T09:00:57.048Z', BW),
      login('2026-10-01T08:47:23.974Z', BW), out('2026-10-01T08:49:13.499Z', BW),
    ], BW)).toEqual(['2026-09-30', '2026-10-01']);
  });

  it('Amazon and EDF today: signed in minutes after the window closes, signed out the next morning', () => {
    const now = [...EDF_LINES, login('2026-10-02T16:45:34.303Z', EDF), seen('2026-10-02T16:49:42Z', EDF)];
    // A sign-in that cannot be judged yet changes nothing either way.
    expect(unheld(now, EDF)).toEqual(['2026-09-30', '2026-10-01']);
    expect(unheld([...now, out('2026-10-03T05:40:30Z', EDF)], EDF)).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('a sign-in seen still signed in 36 hours later puts the site back on the daily list', () => {
    const held = [...EDF_LINES, login('2026-10-02T16:45:34Z', EDF), seen('2026-10-03T05:40:30Z', EDF), seen('2026-10-04T05:40:30Z', EDF)];
    expect(unheld(held, EDF)).toEqual([]);
    // ...and when that session lapses a week on, he is asked: it is a site that holds now.
    expect(unheld([...held, out('2026-10-11T05:40:30Z', EDF)], EDF)).toEqual([]);
  });

  it('a session that held for weeks and then lapsed is a real lapse: the site stays on the daily list', () => {
    expect(unheld(HELD_THEN_LAPSED, P)).toEqual([]);
  });

  // The app writes the `login` line whether or not he got in, and closes the card unchecked.
  it('a site that has held before needs four failed sign-ins running, not two: a window he closed early is not the site failing', () => {
    const again = (day) => [login(`2026-09-${day}T08:00:00Z`, P), out(`2026-09-${day + 1}T05:40:00Z`, P)];
    const two = [...HELD_THEN_LAPSED, ...again(22), ...again(23)];
    expect(unheld(two, P)).toEqual([]);
    expect(unheld([...two, ...again(24)], P)).toEqual([]);
    expect(unheld([...two, ...again(24), ...again(25)], P)).toEqual(['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']);
  });

  it('signed in again with no window on the ledger (Your turn, a sister site, a wrong read put right) is a sign-in, and clears old strikes', () => {
    // Two sign-ins that did not hold, then seen signed in daily for 25 days, then a lapse.
    const came_back = [login('2026-09-01T08:00:00Z', P), out('2026-09-02T05:40:00Z', P), login('2026-09-02T08:00:00Z', P), out('2026-09-03T05:40:00Z', P),
      ...daily(P, '2026-09-05T05:40:00Z', 25), out('2026-10-01T05:40:00Z', P)];
    expect(unheld(came_back, P)).toEqual([]);
    // Spotify, 15 Sep 2026: its one sign-in read signed out at the door at 09:35:52 and signed in 39 seconds later.
    const S = 'creators.spotify.com';
    const spotify = [login('2026-09-15T07:30:00Z', S), check('2026-09-15T09:35:52Z', S, false, { url: 'https://creators.spotify.com/pod/login' }),
      seen('2026-09-15T09:36:31Z', S), ...daily(S, '2026-09-16T05:41:00Z', 14),
      out('2026-09-30T05:41:00Z', S), login('2026-09-30T08:00:00Z', S), out('2026-10-01T05:41:00Z', S)];
    expect(unheld(spotify, S)).toEqual([]);
    // It is judged from the moment it came back, not from the window before it: back on
    // day 10 and out again on day 11 is a sign-in that did not hold, not one that held 8 days.
    const E = 'www.example-energy.co.uk';
    const back_then_out = [login('2026-09-01T08:00:00Z', E), out('2026-09-02T05:40:00Z', E), login('2026-09-02T08:00:00Z', E), out('2026-09-03T05:40:00Z', E),
      seen('2026-09-10T10:00:00Z', E), out('2026-09-11T05:40:00Z', E)];
    expect(unheld(back_then_out, E)).toEqual(['2026-09-01', '2026-09-10']);
  });

  it('signed in again with no window never erases a sign-in that HELD: the site keeps its four-in-a-row bar', () => {
    // Held three weeks, lapsed, came back with no window at 09:00, out the next morning, then ONE closed window.
    const once = [...HELD_THEN_LAPSED, seen('2026-09-22T09:00:00Z', P), out('2026-09-23T05:40:00Z', P),
      login('2026-09-23T08:00:00Z', P), out('2026-09-24T05:40:00Z', P)];
    expect(unheld(once, P)).toEqual([]);
    // One wrong signed-out read in the middle of a held session, a real lapse a day later, one closed window.
    const wrong_read = [login('2026-09-01T08:00:00Z', P), ...daily(P, '2026-09-02T05:40:00Z', 9), out('2026-09-11T05:40:00Z', P),
      seen('2026-09-11T09:00:00Z', P), out('2026-09-12T09:00:00Z', P), login('2026-09-12T10:00:00Z', P), out('2026-09-13T05:40:00Z', P)];
    expect(unheld(wrong_read, P)).toEqual([]);
  });

  it('one window whose reads went signed out, signed in, signed out is ONE sign-in that did not hold, never two', () => {
    const S = 'creators.spotify.com';
    expect(unheld([login('2026-09-15T07:30:00Z', S), out('2026-09-15T09:35:52Z', S), seen('2026-09-15T09:36:31Z', S), out('2026-09-16T05:41:00Z', S)], S)).toEqual([]);
  });

  it('the time of day he signs in does not change the verdict: signed out inside 36 hours is not holding', () => {
    const E = 'www.example-energy.co.uk';
    const evening = [login('2026-09-01T18:30:00Z', E), seen('2026-09-02T05:40:00Z', E), out('2026-09-03T05:40:00Z', E),
      login('2026-09-03T18:30:00Z', E), seen('2026-09-04T05:40:00Z', E), out('2026-09-05T05:40:00Z', E)];
    const morning = [login('2026-09-01T08:30:00Z', E), seen('2026-09-02T05:40:00Z', E), out('2026-09-03T05:40:00Z', E),
      login('2026-09-03T08:30:00Z', E), seen('2026-09-04T05:40:00Z', E), out('2026-09-05T05:40:00Z', E)];
    expect(unheld(evening, E)).toEqual(['2026-09-01', '2026-09-03']);
    expect(unheld(morning, E)).toEqual(['2026-09-01', '2026-09-03']);
  });

  it('a morning with no check does not restart the asking (EDF had none on 22 Sep 2026)', () => {
    // Signed out 44.9 hours after the third sign-in, with no read in between: that sign-in
    // is not judged, and the two before it still stand.
    const missed = [...EDF_LINES, login('2026-10-02T08:48:00Z', EDF), out('2026-10-04T05:40:30Z', EDF)];
    expect(unheld(missed, EDF)).toEqual(['2026-09-30', '2026-10-01']);
  });

  it('a signed-out read after days of nothing usable is not a strike: nobody saw whether it held', () => {
    // Cloudflare's shape: signed in minutes after the window, then bot checks for five days, then signed out.
    const C = 'dash.cloudflare.com';
    const bots = (from) => Array.from({ length: 5 }, (_, i) => check(new Date(Date.parse(from) + i * 86400000).toISOString(), C, false, { botCheck: true, signinPage: false }));
    const round = (d) => [login(`2026-09-${d}T06:00:00Z`, C), seen(`2026-09-${d}T06:21:00Z`, C), ...bots(`2026-09-${d + 1}T05:42:00Z`), out(`2026-09-${d + 6}T05:42:00Z`, C)];
    expect(unheld([...round(10), ...round(17)], C)).toEqual([]);
    // The same with no reads at all for two mornings: signed in at 21.7 hours, signed out at 93.7.
    const E = 'www.example-energy.co.uk';
    const gap = (d) => [login(`2026-09-${d}T08:00:00Z`, E), seen(`2026-09-${d + 1}T05:42:00Z`, E), out(`2026-09-${d + 4}T05:42:00Z`, E)];
    expect(unheld([...gap(10), ...gap(15)], E)).toEqual([]);
  });

  it('a sign-in that is not judged does not break a run of sign-ins that did not hold', () => {
    const E = 'www.example-energy.co.uk';
    expect(unheld([login('2026-09-10T08:00:00Z', E), out('2026-09-11T05:40:00Z', E),
      login('2026-09-11T08:00:00Z', E), seen('2026-09-12T05:40:00Z', E),               // alive at 22 hours, then he opens a window again
      login('2026-09-12T14:00:00Z', E), out('2026-09-13T05:40:00Z', E)], E)).toEqual(['2026-09-10', '2026-09-12']);
  });

  it('two windows with no check between them are one sign-in, judged from the later one', () => {
    const twice = [...EDF_LINES.slice(0, 2), login('2026-09-30T08:30:00Z', EDF), ...EDF_LINES.slice(2)];
    expect(unheld(twice, EDF)).toEqual(['2026-09-30', '2026-10-01']);
  });

  it('a bot check, and a read that did not land on a sign-in page, are not signed-out reads', () => {
    const bot = [...EDF_LINES.slice(0, 4), check('2026-10-02T05:40:30Z', EDF, false, { botCheck: true, signinPage: false })];
    expect(unheld(bot, EDF)).toEqual([]);
    const slow = [...EDF_LINES.slice(0, 4), check('2026-10-02T05:40:30Z', EDF, false, { signinPage: false })];
    expect(unheld(slow, EDF)).toEqual([]);
  });

  it("a signed-out read where the robot's own refresh could not run, or its second read failed, is not a strike", () => {
    const A = 'www.amazon.co.uk';
    const lines = (refresh) => [login('2026-10-01T08:47:44Z', A), check('2026-10-02T05:40:40Z', A, false, { signinPage: true, selfRefresh: refresh }),
      login('2026-10-02T16:45:03Z', A), check('2026-10-03T05:40:40Z', A, false, { signinPage: true, selfRefresh: refresh })];
    expect(unheld(lines('not run: the profile is in use'), A)).toEqual([]);
    expect(unheld(lines('ran, then the second read failed: page.goto: Timeout 45000ms exceeded'), A)).toEqual([]);
    expect(unheld(lines('ran, still signed out'), A)).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('a line from before signinPage was recorded is a signed-out read only on a sign-in address', () => {
    const old = (url) => [login('2026-09-22T07:14:16Z', EDF), check('2026-09-23T05:40:37Z', EDF, false, { url }),
      login('2026-09-23T07:14:50Z', EDF), check('2026-09-24T05:40:29Z', EDF, false, { url })];
    expect(unheld(old('https://www.edfenergy.com/myaccount/login'), EDF)).toEqual(['2026-09-22', '2026-09-23']);
    expect(unheld(old('https://www.amazon.co.uk/ap/signin?openid.pape.max_auth_age=0'), EDF)).toEqual(['2026-09-22', '2026-09-23']);
    expect(unheld(old('https://signin.account.gov.uk/enter-email'), EDF)).toEqual(['2026-09-22', '2026-09-23']);
    expect(unheld(old('https://www.edfenergy.com/500'), EDF)).toEqual([]);
    expect(unheld(old('https://www.edfenergy.com/cdn-cgi/challenge'), EDF)).toEqual([]);
  });

  it("the sign-in page's host counts as the site's (www.loom.com for loom.com); another site's and another profile's do not", () => {
    const loom = [login('2026-09-30T08:00:00Z', 'www.loom.com'), out('2026-10-01T05:40:00Z', 'loom.com'),
      login('2026-10-01T08:00:00Z', 'www.loom.com'), out('2026-10-02T05:40:00Z', 'loom.com')];
    expect(unheld(loom, 'loom.com', 'www.loom.com')).toEqual(['2026-09-30', '2026-10-01']);
    expect(unheld(loom, 'loom.com')).toEqual([]);
    expect(unheld(EDF_LINES, 'www.amazon.co.uk')).toEqual([]);
    expect(unheld(EDF_LINES.map(e => e.cmd === 'login' ? { ...e, profile: 'utilita-apt1' } : e), EDF)).toEqual([]);
  });

  it('the order of the lines and the form of the timestamp do not matter', () => {
    const shuffled = [EDF_LINES[4], EDF_LINES[1], EDF_LINES[3], EDF_LINES[0], EDF_LINES[2]];
    expect(unheld(shuffled, EDF)).toEqual(['2026-09-30', '2026-10-01']);
    const offset = EDF_LINES.map(e => ({ ...e, at: e.at.replace(/T(\d\d):(\d\d:\d\d)\.\d+Z$/, (_, h, r) => `T${String(Number(h) + 1).padStart(2, '0')}:${r}+01:00`) }));
    expect(unheld(offset, EDF)).toEqual(['2026-09-30', '2026-10-01']);
  });

  it('load_events keeps only sign-ins and checks, and a missing ledger is no history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'od-signin-hold-'));
    const file = join(dir, 'runs.jsonl');
    const noise = Array.from({ length: 200 }, (_, i) => JSON.stringify({ at: '2026-10-01T10:00:00Z', cmd: 'read', url: `https://www.amazon.co.uk/your-orders/orders?startIndex=${i}`, profile: 'default' }));
    writeFileSync(file, [...EDF_LINES.map(e => JSON.stringify(e)), 'not json {"session"', ...noise].join('\n') + '\n');
    const got = py(`
ev = sh.load_events(arg['file'])
print('---JSON---'); print(json.dumps({'n': len(ev), 'cmds': sorted({e['cmd'] for e in ev}), 'missing': sh.load_events(arg['file'] + '.nope'),
  'unheld': len(sh.unheld_signins(ev, 'www.edfenergy.com'))}))`, { file });
    expect(got).toEqual({ n: 5, cmds: ['login', 'session'], missing: [], unheld: 2 });
  });
});

describe('the 06:40 keep-alive (session-keepalive.py cmd_run)', () => {
  // The real cmd_run with Airtable and the task create stubbed. The browser stub
  // does what `agent-browser.js session` does: it writes this morning's read to
  // the ledger and returns it, so the rule only sees today's read if it looks
  // AFTER the check.
  const TCB = 'www.topcashback.co.uk';
  // Before this morning's run. TopCashback: signed in 22 Sep, seen signed in for a week.
  const BEFORE = [...EDF_LINES.slice(0, 4), login('2026-09-22T07:15:00Z', TCB), ...daily(TCB, '2026-09-23T05:41:00Z', 9)];
  const run = (events, opts = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'od-keepalive-'));
    const ledger = join(dir, 'runs.jsonl');
    writeFileSync(ledger, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    return py(`
import contextlib, io
ka = load('ka', 'session-keepalive.py')
sh.LEDGER = arg['ledger']
ka.STATE_DIR = arg['dir']; ka.STATUS = os.path.join(arg['dir'], 'status.json')
ka.load_sites = lambda: {
  'www.edfenergy.com': {'label': 'EDF Energy', 'login': True, 'loginUrl': 'https://www.edfenergy.com/myaccount/login'},
  'www.topcashback.co.uk': {'label': 'TopCashback', 'login': True, 'loginUrl': 'https://www.topcashback.co.uk/logon/'}}
def read_site(host, entry):
    line = {'at': arg.get('readAt', '2026-10-02T05:40:30.921Z'), 'cmd': 'session', 'site': host, 'url': entry['loginUrl'], 'signedIn': False,
            'botCheck': False, 'signinPage': True, 'profile': 'default'}
    with open(arg['ledger'], 'a') as fh:
        fh.write(json.dumps(line) + '\\n')
    return line
ka.read_site = read_site
# The waiting read (agent-dispatch.py signin-waiting --no-walk), stubbed: by default a task of real
# work waits on each site, so the sign-in rule above is what decides (7 Oct 2026).
WORK = {'host': None, 'tasks': [{'id': 'recWork', 'name': 'Read the bill'}]}
groups = arg.get('groups', [dict(WORK, host='www.edfenergy.com'), dict(WORK, host='www.topcashback.co.uk')])
reads = []
def waiting_groups():
    reads.append(1)
    if arg.get('waitingBroken'): raise RuntimeError('signin-waiting failed: Airtable unreachable')
    return groups
ka.waiting_groups = waiting_groups
# The read before 7 Oct 2026, stubbed as well: a revert of that change must never reach Airtable from a test.
ka.already_waiting = lambda host: False
created = []
ka.create_task = lambda fields, dry_run: created.append(fields[ka.F['name']]) or {'created': True}
if arg.get('broken'):
    def boom(*a, **k): raise RuntimeError('ledger unreadable')
    sh.unheld_signins = boom
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = ka.cmd_run()
print('---JSON---'); print(json.dumps({'code': code, 'created': created, 'said': json.loads(buf.getvalue()),
  'status': json.load(open(ka.STATUS))['sites'], 'reads': len(reads)}))`, { ledger, dir, ...opts });
  };

  it('raises no card for EDF, still raises one for a site that held and then lapsed, and says so', () => {
    const got = run(BEFORE);
    expect(got.code).toBe(0);
    expect(got.created).toEqual(['SIGN-IN: TopCashback session lapsed']);
    expect(got.status[EDF].state).toBe('signed-out');
    expect(got.status[EDF].notHolding).toBe(true);
    expect(got.status[EDF].task).toBe('not raised: signed out again after the sign-ins of 30 Sep and 1 Oct');
    expect(got.status[TCB].notHolding).toBeUndefined();
    expect(got.said.signedOut).toEqual(['EDF Energy', 'TopCashback']);
    expect(got.said.signInWhenNeeded).toEqual(['EDF Energy']);
  });

  it('with one sign-in on the ledger, EDF is asked for as before', () => {
    expect(run(BEFORE.filter(e => e !== EDF_LINES[1])).created).toEqual(['SIGN-IN: EDF Energy session lapsed', 'SIGN-IN: TopCashback session lapsed']);
  });

  it('a rule that cannot be worked out never silences the ask: both cards are raised and the row says why', () => {
    const got = run(BEFORE, { broken: true });
    expect(got.created).toEqual(['SIGN-IN: EDF Energy session lapsed', 'SIGN-IN: TopCashback session lapsed']);
    expect(got.status[EDF].notHoldingError).toBe('ledger unreadable');
  });

  // 7 Oct 2026: 46 keep-alive cards in 31 days, and 81 of Kevin's 109 sign-ins handed no task to a
  // robot. A signed-out site is asked for only when work waits on it.
  const ONE_SIGNIN = BEFORE.filter(e => e !== EDF_LINES[1]);    // EDF's rule no longer excuses it
  it('a signed-out site with no task waiting raises no card: the state is recorded and nothing is asked', () => {
    const got = run(ONE_SIGNIN, { groups: [] });
    expect(got.created).toEqual([]);
    expect(got.status[TCB].state).toBe('signed-out');
    expect(got.status[TCB].nothingWaiting).toBe(true);
    expect(got.status[TCB].task).toBe('not raised: no task is waiting on this site');
    expect(got.said.nothingWaiting).toEqual(['EDF Energy', 'TopCashback']);
    expect(got.reads).toBe(1);                                   // one read for the whole run
  });

  it('a task waiting on the site raises its card, naming that task; another site\'s task does not', () => {
    const got = run(ONE_SIGNIN, { groups: [{ host: TCB, tasks: [{ id: 'recQuote', name: 'Get the Chedburgh quote' }] }] });
    expect(got.created).toEqual(['SIGN-IN: TopCashback session lapsed']);
    expect(got.status[TCB].waiting).toEqual(['recQuote']);
    expect(got.status[EDF].nothingWaiting).toBe(true);
  });

  it('the keep-alive\'s own open card is not work: alone it raises nothing, beside work it is the one card', () => {
    const own = { id: 'recOwn', name: 'SIGN-IN: TopCashback session lapsed' };
    expect(run(ONE_SIGNIN, { groups: [{ host: TCB, tasks: [own] }] }).created).toEqual([]);
    const both = run(ONE_SIGNIN, { groups: [{ host: TCB, tasks: [own, { id: 'recQuote', name: 'Get the Chedburgh quote' }] }] });
    expect(both.created).toEqual([]);
    expect(both.status[TCB].task).toBe('already waiting');
  });

  // Kevin, 8 Oct 2026: his window closed and this check still found the site signed out. Asking him
  // again cannot help, and the blocker sweep sends the waiting task another route.
  it('a site his own sign-in did not get the robot into raises no card, even with work waiting', () => {
    const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
    const waiting = { groups: [{ host: TCB, tasks: [{ id: 'recQuote', name: 'Get the Chedburgh quote' }] }] };
    const got = run([...ONE_SIGNIN, login(ago(1), TCB)], { ...waiting, readAt: ago(0.5) });
    expect(got.created).toEqual([]);
    expect(got.status[TCB].kevinTried).toBe(true);
    expect(got.status[TCB].task).toBe('not raised: his own sign-in did not get the robot in');
    // His window a day earlier, read next morning: it may have worked and expired, so he is asked.
    expect(run([...ONE_SIGNIN, login(ago(20), TCB)], { ...waiting, readAt: ago(0.5) }).created)
      .toEqual(['SIGN-IN: TopCashback session lapsed']);
  });

  it('a waiting read that fails raises nothing and says NOT CHECKED, never a quiet board', () => {
    const got = run(ONE_SIGNIN, { waitingBroken: true });
    expect(got.created).toEqual([]);
    expect(got.status[TCB].task.error).toMatch(/signin-waiting failed/);
    expect(got.said.notChecked).toEqual(['EDF Energy', 'TopCashback']);
    expect(got.said.nothingWaiting).toEqual([]);
  });

  it('the reason names his sign-ins by the London day, and all four for a site that has held', () => {
    const note = (events) => py(`
ka = load('ka', 'session-keepalive.py')
print('---JSON---'); print(json.dumps(ka.not_holding_note(arg['host'], {'loginUrl': 'https://' + arg['host'] + '/'}, arg['events'])))`, { events, host: EDF });
    // 23:10 UTC on 29 Sep is 00:10 on 30 Sep in London.
    expect(note([login('2026-09-29T23:10:00Z', EDF), ...EDF_LINES.slice(2)]))
      .toBe('not raised: signed out again after the sign-ins of 30 Sep and 1 Oct');
    const again = (day) => [login(`2026-09-${day}T08:00:00Z`, EDF), out(`2026-09-${day + 1}T05:40:00Z`, EDF)];
    expect(note([login('2026-09-01T08:00:00Z', EDF), ...daily(EDF, '2026-09-02T05:40:00Z', 5), out('2026-09-18T05:40:00Z', EDF),
      ...again(18), ...again(19), ...again(20), ...again(21)]))
      .toBe('not raised: signed out again after the sign-ins of 18 Sep, 19 Sep, 20 Sep and 21 Sep');
    expect(note(EDF_LINES.slice(3))).toBe('');
  });
});

describe('the Robot sign-ins panel row (estate-status.py)', () => {
  const payload = (history, ledger) => py(`
from datetime import datetime, timezone
es = load('es', 'estate-status.py')
src = {'targets': [{'label': 'EDF Energy', 'host': 'www.edfenergy.com', 'url': 'https://www.edfenergy.com/myaccount/login', 'profile': 'default'}],
       'sites': {'www.edfenergy.com': {'login': True, 'loginUrl': 'https://www.edfenergy.com/myaccount/login'}},
       'keepalive': {}, 'ledger': arg['ledger'], 'signinHistory': arg['history'], 'readings': [], 'accounts': []}
now = datetime(2026, 10, 2, 6, 0, tzinfo=timezone.utc)
print('---JSON---'); print(json.dumps({'line': es.signin_payload(now, src)['lines'][0], 'detail': es.robot_signins_row(now, src)['detail']}))`,
  { history, ledger });

  it('EDF reads "sign in when needed" with the reason, never a red Signed out', () => {
    const got = payload(EDF_LINES, EDF_LINES);
    expect(got.line.state).toBe('on-demand');
    expect(got.line.how).toBe('did not stay signed in');
    expect(got.line.at).toBe('2026-10-02T05:40:30.000Z');
    expect(got.detail).toBe('1 sign-ins: 0 signed in, 0 signed out, 1 sign in when needed.');
  });

  it('after ONE sign-in that did not hold it is still Signed out, with its button', () => {
    expect(payload(EDF_LINES.slice(3), EDF_LINES.slice(3)).line.state).toBe('signed-out');
  });

  it('with no history read it is Signed out: a missing read never quietens the panel', () => {
    expect(payload(null, EDF_LINES).line.state).toBe('signed-out');
  });

  it('his sign-in after the last look reads "you signed in", and a signed-in look reads signed in, whatever came before', () => {
    const mine = [...EDF_LINES, login('2026-10-02T05:50:00Z', EDF)];
    expect(payload(mine, mine).line.state).toBe('you-signed-in');
    const live = [...mine, seen('2026-10-02T05:55:00Z', EDF)];
    expect(payload(live, live).line.state).toBe('signed-in');
  });

  it('load_signin_sources hands the rule the WHOLE ledger: sign-ins older than the 2 MB tail still count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'od-estate-signins-'));
    const ledger = join(dir, 'runs.jsonl');
    const pad = 'x'.repeat(400);
    const noise = Array.from({ length: 6000 }, (_, i) => JSON.stringify({ at: '2026-10-01T10:00:00Z', cmd: 'read', url: `https://www.amazon.co.uk/o?i=${i}&p=${pad}`, profile: 'default' }));
    writeFileSync(ledger, [...EDF_LINES.slice(0, 4).map(e => JSON.stringify(e)), ...noise, JSON.stringify(EDF_LINES[4])].join('\n') + '\n');
    const got = py(`
from datetime import datetime, timezone
import types
es = load('es', 'estate-status.py')
es.BROWSER_LEDGER = arg['ledger']
es.KEEPALIVE_STATUS = arg['ledger'] + '.none'; es.UTILITA_READINGS = arg['ledger'] + '.none'; es.UTILITA_ACCOUNTS = arg['ledger'] + '.none'
sites = {'www.edfenergy.com': {'label': 'EDF Energy', 'login': True, 'loginUrl': 'https://www.edfenergy.com/myaccount/login'}}
es._browser = lambda *a: types.SimpleNamespace(stderr='', stdout=json.dumps(sites) if a[0] == 'sites'
    else 'EDF Energy | www.edfenergy.com | https://www.edfenergy.com/myaccount/login | default\\n')
src = es.load_signin_sources()
line = es.signin_payload(datetime(2026, 10, 2, 6, 0, tzinfo=timezone.utc), src)['lines'][0]
print('---JSON---'); print(json.dumps({'size': os.path.getsize(arg['ledger']), 'tail': es.LEDGER_TAIL_BYTES,
  'loginsInTail': sum(1 for e in src['ledger'] if e.get('cmd') == 'login'), 'history': len(src['signinHistory']), 'state': line['state']}))`, { ledger });
    expect(got.size).toBeGreaterThan(got.tail);
    expect(got.loginsInTail).toBe(0);
    expect(got.history).toBe(5);
    expect(got.state).toBe('on-demand');
  });

  // Drift only: the wording itself is tested on the page, in tests/sync-invariants/robot-signins-panel.spec.js.
  it('the page matches on the same reason string the script writes', () => {
    const why = py(`print('---JSON---'); print(json.dumps(sh.WHY))`);
    expect(readFileSync(join(ROOT, 'os', 'agents', 'index.html'), 'utf8')).toContain(`ln.how === '${why}'`);
    expect(readFileSync(join(ROOT, 'tests', 'sync-invariants', 'robot-signins-panel.spec.js'), 'utf8')).toContain(`how: '${why}'`);
  });
});

// Kevin, 8 Oct 2026: "every time I add it or every time I try and sign in, it doesn't disappear.
// It just keeps asking." These two read his own try off the ledger, so the blocker sweep sends
// such a wall back to its agent and `block` refuses to raise it again. Shaped from the 7 and 8 Oct
// ledger (a portal whose every check after his window still landed on its login page); hosts and
// times are invented.
describe("his own try that did not get the robot in", () => {
  const PORTAL = 'portal.example-broker.co.uk';
  it('a window on the site, then a signed-out read and no signed-in read since, is a failed try', () => {
    const r = py(`
ev = arg["ev"]
print("---JSON---" + json.dumps({
  "failed": sh.kevin_signin_failed(ev, {arg["host"]}, "2026-10-06T00:00:00Z"),
  "before": sh.kevin_signin_failed(ev, {arg["host"]}, "2026-10-08T12:00:00Z"),
  "later_in": sh.kevin_signin_failed(ev + [arg["inn"]], {arg["host"]}, "2026-10-06T00:00:00Z"),
  "no_read": sh.kevin_signin_failed(ev[:2], {arg["host"]}, "2026-10-06T00:00:00Z"),
  "other": sh.kevin_signin_failed(ev, {"another.example.com"}, "2026-10-06T00:00:00Z"),
  "child_read": sh.kevin_signin_failed(arg["child"], {arg["host"]}, "2026-10-06T00:00:00Z"),
  "next_morning": sh.kevin_signin_failed(arg["late"], {arg["host"]}, "2026-10-06T00:00:00Z")}))`, {
      host: PORTAL,
      ev: [out('2026-10-07T05:43:00.000Z', PORTAL), login('2026-10-07T10:52:00.000Z', PORTAL),
           out('2026-10-07T10:53:00.000Z', PORTAL), login('2026-10-08T11:59:13.000Z', PORTAL),
           out('2026-10-08T11:59:42.000Z', PORTAL)],
      inn: seen('2026-10-08T13:00:00.000Z', PORTAL),
      // A read of a different address under it says nothing about this one.
      child: [login('2026-10-08T11:59:13.000Z', PORTAL), out('2026-10-08T12:10:00.000Z', 'www.' + PORTAL)],
      // A sign-in that may have worked and expired overnight is not a failed try (review, 8 Oct 2026).
      late: [login('2026-10-06T12:11:00.000Z', PORTAL), out('2026-10-07T05:43:00.000Z', PORTAL)],
    });
    // His newest window, and the first signed-out read after it.
    expect(r.failed).toEqual(['2026-10-08T11:59:13.000Z', '2026-10-08T11:59:42.000Z', PORTAL]);
    expect(r.before).toBeNull();      // no window after the look-back start
    expect(r.later_in).toBeNull();    // the robot got in after all
    expect(r.no_read).toBeNull();     // nothing read since his window yet
    expect(r.other).toBeNull();
    expect(r.child_read).toBeNull();
    expect(r.next_morning).toBeNull();
  });

  it('a window he walked away from (still open when the time ran out) is not his try', () => {
    const r = py(`
ev = arg["ev"]
print("---JSON---" + json.dumps({"after": sh.kevin_login_after(ev, {arg["host"]}, "2026-10-06T00:00:00Z"),
                               "failed": sh.kevin_signin_failed(ev, {arg["host"]}, "2026-10-06T00:00:00Z")}))`, {
      host: PORTAL,
      ev: [{ ...login('2026-10-08T11:59:13.000Z', PORTAL), timedOut: true }, out('2026-10-08T12:10:00.000Z', PORTAL)],
    });
    expect(r.after).toBeNull();
    expect(r.failed).toBeNull();
  });

  it('a window opened from a blocked robot counts for the address it was opened for, wherever he signed in', () => {
    const r = py(`
ev = arg["ev"]
print("---JSON---" + json.dumps({
  "child": sh.kevin_login_after(ev, {"www.clips.example"}, "2026-10-06T00:00:00Z"),
  "wall": sh.kevin_login_after(ev, {"cover.example"}, "2026-10-06T00:00:00Z"),
  "own": sh.kevin_login_after(ev, {"clips.example"}, "2026-10-06T00:00:00Z")}))`, {
      ev: [login('2026-10-07T10:51:00.000Z', 'clips.example'),
           { ...login('2026-10-08T12:04:00.000Z', 'quotes.cover-insurer.example'), forWall: 'cover.example' }],
    });
    // Exact hosts only (review, 8 Oct 2026): a parent and its www. site are separate sign-ins.
    expect(r.child).toBeNull();                                        // tiktok.com is not www.tiktok.com
    expect(r.wall).toEqual(['2026-10-08T12:04:00.000Z', 'quotes.cover-insurer.example']);
    expect(r.own).toEqual(['2026-10-07T10:51:00.000Z', 'clips.example']);
  });
});
