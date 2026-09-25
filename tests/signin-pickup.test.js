// A task waiting on a site sign-in is a wait, not a decision (Kevin, 4 Sep
// 2026). These pin the pieces that turn "SIGN-IN NEEDED: <site>" into one
// sitting for him and an immediate pickup for the robot.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = join(ROOT, 'scripts', 'agent-dispatch.py');

function py(body, arg) {
  const script = `
import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}
`;
  // signin-done appends to pending.jsonl; a test must never write the live one
  // (three fixture lines reached the real file on 8 Sep 2026 and were queued
  // for a robot as tasks "rec1").
  // SIGNIN_SKIP_WALK: a submit with a SIGN-IN NEEDED line walks the site's door
  // (15 Sep 2026); a test never opens the robot browser. The refusal path
  // mocks m.session_check instead.
  const env = { ...process.env, SIGNIN_PICKUP_DIR: mkdtempSync(join(tmpdir(), 'od-signin-pending-')), SIGNIN_SKIP_WALK: '1' };
  return JSON.parse(execFileSync('python3', ['-c', script, JSON.stringify(arg || {})], { encoding: 'utf8', env }).split('---JSON---')[1]);
}
const SITES = {
  'gov.uk': { label: 'GOV.UK', login: false },
  'ewf.companieshouse.gov.uk': { label: 'Companies House WebFiling (via One Login)', login: true, loginUrl: 'https://ewf.companieshouse.gov.uk/seclogin?tc=1' },
  'app.pingen.com': { label: 'Pingen (letters)', login: true, loginUrl: 'https://app.pingen.com/' },
};

describe('which allowlist site a SIGN-IN NEEDED line means', () => {
  it('resolves by URL host first, then by label, and says unknown otherwise', () => {
    const out = py(`
sites = json.loads(sys.argv[1])
print('---JSON---'); print(json.dumps([
  m.signin_site_for('Pingen', 'https://app.pingen.com/login', sites),
  m.signin_site_for('Companies House', '', sites),
  m.signin_site_for('Companies House WebFiling', 'https://ewf.companieshouse.gov.uk/seclogin?tc=1', sites),
  m.signin_site_for('Xero', 'https://go.xero.com/', sites),
  m.signin_site_for('pingen.com', 'https://www.pingen.com/en/login', sites),
]))`, SITES);
    expect(out).toEqual(['app.pingen.com', 'ewf.companieshouse.gov.uk', 'ewf.companieshouse.gov.uk', null, 'app.pingen.com']);
  });
  it('a Gmail link never lands on another Google sign-in by sharing google.com (17 Sep 2026)', () => {
    const out = py(`
sites = json.loads(sys.argv[1])
sites['aistudio.google.com'] = {'label': 'Google AI Studio', 'login': True}
line = 'SIGN-IN NEEDED: Bromcom Parent App / Example Village College portal (check the email at https://mail.google.com/mail/u/0/#search/from%3A10001%40bromcomcloud.com+after%3A2026/09/13)'
p = m.parse_signin_line(line)
print('---JSON---'); print(json.dumps([
  m.signin_site_for(p['site'], p['url'], sites),
  m.signin_site_for('Google AI Studio', 'https://aistudio.google.com/app', sites),
  m.signin_site_for('pingen.com', 'https://www.pingen.com/en/login', sites),
]))`, SITES);
    expect(out).toEqual([null, 'aistudio.google.com', 'app.pingen.com']);
  });
  it('a Gmail sign-in line is refused with the command that reads the mailbox (17 Sep 2026)', () => {
    const out = py(`
sites = json.loads(sys.argv[1])
live = 'The agent cannot read the email content without Gmail access.\\n\\nSIGN-IN NEEDED: Gmail (https://mail.google.com/mail/u/0/#all/1a0a4390289d7805)'
print('---JSON---'); print(json.dumps([
  m.signin_line_problem(live, sites)[:400],
  m.signin_line_problem('SIGN-IN NEEDED: mail.google.com', sites)[:60],
  m.signin_line_problem('SIGN-IN NEEDED: Pingen (letters) (https://app.pingen.com/)', sites),
]))`, SITES);
    expect(out[0]).toContain('never a sign-in Kevin is asked for');
    expect(out[0]).toContain('inbound-triage.py search');
    expect(out[1]).toContain('names Gmail');
    expect(out[2], 'a real robot site must still pass').toBe('');
  });
  it('by label, a site the robot can sign into wins over a same-named entry it cannot (8 Sep 2026)', () => {
    const out = py(`
sites = {'companieshouse.gov.uk': {'label': 'Companies House', 'login': False}}
sites.update(json.loads(sys.argv[1]))
print('---JSON---'); print(json.dumps([m.signin_site_for('Companies House', '', sites), m.signin_domain('www.topcashback.co.uk'), m.signin_domain('app.pingen.com')]))`, SITES);
    expect(out).toEqual(['ewf.companieshouse.gov.uk', 'topcashback.co.uk', 'pingen.com']);
  });
  it('a One Login task folds onto the WebFiling door, so one chain never opens it twice (review, 8 Sep 2026)', () => {
    const out = py(`
sites = json.loads(sys.argv[1])
sites['signin.account.gov.uk'] = {'label': 'GOV.UK One Login', 'login': True, 'shortSession': True, 'loginUrl': 'https://ewf.companieshouse.gov.uk/seclogin?tc=1'}
print('---JSON---'); print(json.dumps([m.signin_site_for('GOV.UK One Login', '', sites), m.signin_site_for('', 'https://signin.account.gov.uk/enter-email', sites)]))`, SITES);
    expect(out).toEqual(['ewf.companieshouse.gov.uk', 'ewf.companieshouse.gov.uk']);
  });
  it('reads the login URL from anywhere on the line and the site from the text before it (the four live lines of 8 Sep 2026)', () => {
    const out = py(`
lines = [
  'SIGN-IN NEEDED: pingen.com (https://www.pingen.com/en/login) \u2014 to send the already-approved HMRC letter (ID b8caaaf2). Once Kevin is signed in, this task will complete the send.',
  'SIGN-IN NEEDED: Namecheap (https://www.namecheap.com/myaccount/login/) \u2014 renewal requires payment.',
  'Verified.\\nSIGN-IN NEEDED: Companies House WebFiling (https://ewf.companieshouse.gov.uk/seclogin?tc=1)',
  'SIGN-IN NEEDED: GOV.UK One Login (one-hour window)',
  'SIGN-IN NEEDED: Pingen (letters) (https://app.pingen.com/)',
  'SIGN-IN NEEDED: HMRC - https://www.tax.service.gov.uk/gg/sign-in.',
  'nothing here',
]
print('---JSON---'); print(json.dumps([m.parse_signin_line(l) for l in lines]))`);
    expect(out).toEqual([
      { site: 'pingen.com', url: 'https://www.pingen.com/en/login', verified: true },
      { site: 'Namecheap', url: 'https://www.namecheap.com/myaccount/login/', verified: true },
      { site: 'Companies House WebFiling', url: 'https://ewf.companieshouse.gov.uk/seclogin?tc=1', verified: true },
      { site: 'GOV.UK One Login', url: '', verified: true },
      { site: 'Pingen (letters)', url: 'https://app.pingen.com/', verified: true },
      { site: 'HMRC', url: 'https://www.tax.service.gov.uk/gg/sign-in', verified: true },
      null,
    ]);
  });
  it('groups the waiting tasks by site, most waiting first', () => {
    const out = py(`
sites = json.loads(sys.argv[1])
recs = [
  {'id': 'rec1', 'fields': {m.AF['name']: 'CS01 for Brittain Holdings', m.AF['agentOutput']: 'Verified.\\nSIGN-IN NEEDED: Companies House WebFiling (https://ewf.companieshouse.gov.uk/seclogin?tc=1)', m.AF['teamMember']: ['recJ8J8idWE8d97tH']}},
  {'id': 'rec2', 'fields': {m.AF['name']: 'CS01 for Agile Estates', m.AF['agentOutput']: 'SIGN-IN NEEDED: Companies House', m.AF['teamMember']: ['recjh6mmaF8KJW8t3']}},
  {'id': 'rec3', 'fields': {m.AF['name']: 'HMRC letter', m.AF['agentOutput']: 'Letter ready.\\nSIGN-IN NEEDED: Pingen (https://app.pingen.com/)', m.AF['teamMember']: ['recjh6mmaF8KJW8t3']}},
  {'id': 'rec4', 'fields': {m.AF['name']: 'normal draft', m.AF['agentOutput']: 'no sign-in line here', m.AF['teamMember']: ['recjh6mmaF8KJW8t3']}},
]
m.query_tasks = lambda formula, **kw: recs
groups = m.signin_waiting(sites)
print('---JSON---'); print(json.dumps([[g['host'], g['label'], g['loginUrl'], [t['id'] for t in g['tasks']], [t['agent'] for t in g['tasks']]] for g in groups]))`, SITES);
    expect(out).toEqual([
      ['ewf.companieshouse.gov.uk', 'Companies House WebFiling (via One Login)', 'https://ewf.companieshouse.gov.uk/seclogin?tc=1', ['rec1', 'rec2'], ['inbound-comms-response', 'creditor-management']],
      ['app.pingen.com', 'Pingen (letters)', 'https://app.pingen.com/', ['rec3'], ['creditor-management']],
    ]);
  });
  it('short-session sites come first, and two strangers never share a group (8 Sep 2026)', () => {
    const out = py(`
sites = json.loads(sys.argv[1])
sites['tax.service.gov.uk'] = {'label': 'HMRC', 'login': True, 'shortSession': True, 'loginUrl': 'https://www.tax.service.gov.uk/gg/sign-in'}
recs = [
  {'id': 'p1', 'fields': {m.AF['name']: 'a', m.AF['agentOutput']: 'SIGN-IN NEEDED: pingen.com (https://www.pingen.com/en/login) \u2014 to send the letter', m.AF['teamMember']: ['recjh6mmaF8KJW8t3']}},
  {'id': 'p2', 'fields': {m.AF['name']: 'b', m.AF['agentOutput']: 'SIGN-IN NEEDED: Pingen (https://app.pingen.com/)', m.AF['teamMember']: ['recjh6mmaF8KJW8t3']}},
  {'id': 'h1', 'fields': {m.AF['name']: 'c', m.AF['agentOutput']: 'SIGN-IN NEEDED: HMRC (https://www.tax.service.gov.uk/gg/sign-in)', m.AF['teamMember']: ['recjh6mmaF8KJW8t3']}},
  {'id': 'n1', 'fields': {m.AF['name']: 'd', m.AF['agentOutput']: 'SIGN-IN NEEDED: Namecheap (https://www.namecheap.com/myaccount/login/)', m.AF['teamMember']: ['recJ8J8idWE8d97tH']}},
  {'id': 'x1', 'fields': {m.AF['name']: 'e', m.AF['agentOutput']: 'SIGN-IN NEEDED: Xero (https://go.xero.com/)', m.AF['teamMember']: ['recJ8J8idWE8d97tH']}},
]
m.query_tasks = lambda formula, **kw: recs
print('---JSON---'); print(json.dumps([[g['host'], g['label'], [t['id'] for t in g['tasks']]] for g in m.signin_waiting(sites)]))`, SITES);
    expect(out).toEqual([
      ['tax.service.gov.uk', 'HMRC', ['h1']],
      ['app.pingen.com', 'Pingen (letters)', ['p1', 'p2']],
      ['unknown', 'Namecheap', ['n1']],
      ['unknown', 'Xero', ['x1']],
    ]);
  });
  it('signin-done reopens ONLY that site\'s tasks for their robots and clears the gate-1 fields', () => {
    const out = py(`
sites = json.loads(sys.argv[1])
recs = [
  {'id': 'rec1', 'fields': {m.AF['name']: 'CS01', m.AF['agentOutput']: 'SIGN-IN NEEDED: Companies House WebFiling (https://ewf.companieshouse.gov.uk/seclogin?tc=1)', m.AF['teamMember']: ['recJ8J8idWE8d97tH'], m.AF['notes']: 'earlier'}},
  {'id': 'rec3', 'fields': {m.AF['name']: 'HMRC letter', m.AF['agentOutput']: 'SIGN-IN NEEDED: Pingen (https://app.pingen.com/)', m.AF['teamMember']: ['recjh6mmaF8KJW8t3']}},
]
m.query_tasks = lambda formula, **kw: recs
m.get_task = lambda tid: next(r for r in recs if r['id'] == tid)
m.load_login_sites = lambda: sites
patched = {}
m.patch_task = lambda tid, fields: patched.__setitem__(tid, fields)
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m.cmd_signin_done(types.SimpleNamespace(site='ewf.companieshouse.gov.uk'))
f = patched.get('rec1', {})
print('---JSON---'); print(json.dumps({'patched': sorted(patched), 'status': f.get(m.AF['status']), 'team': f.get(m.AF['teamMember']), 'outcome': f.get(m.AF['approvalOutcome'], 'unset'), 'note': f.get(m.AF['notes'], '')}))`, SITES);
    expect(out.patched).toEqual(['rec1']);
    expect(out.status).toBe('Today');
    expect(out.team).toEqual(['recJ8J8idWE8d97tH']);
    expect(out.outcome).toBeNull();
    // the host rides in the note, so the agent that carries on knows what to pass to `session --site`
    expect(out.note).toMatch(/SIGNED IN: Kevin signed in to Companies House WebFiling \(via One Login\) \(ewf\.companieshouse\.gov\.uk\)\./);
    expect(out.note).toMatch(/^earlier/);
  });
  it('signin-done leaves the handed-back ids in pending.jsonl for the one pickup run after the last window (8 Sep 2026)', () => {
    const { mkdtempSync, rmSync, readFileSync: rf, existsSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'od-signin-'));
    try {
      const out = py(`
sites = json.loads(sys.argv[1])
m.SIGNIN_PICKUP_DIR = ${JSON.stringify(dir)}
recs = [
  {'id': 'rec1', 'fields': {m.AF['name']: 'CS01', m.AF['agentOutput']: 'SIGN-IN NEEDED: Companies House WebFiling (https://ewf.companieshouse.gov.uk/seclogin?tc=1)', m.AF['teamMember']: ['recJ8J8idWE8d97tH']}},
  {'id': 'recK', 'fields': {m.AF['name']: 'SIGN-IN: lapsed', m.AF['agentOutput']: 'SIGN-IN NEEDED: Companies House WebFiling (https://ewf.companieshouse.gov.uk/seclogin?tc=1)', m.AF['teamMember']: ['rec1hYELb4zS8pjjO'], m.AF['notes']: 'KEEPALIVE CHECK: signed out'}},
]
m.query_tasks = lambda formula, **kw: recs
m.get_task = lambda tid: next(r for r in recs if r['id'] == tid)
m.load_login_sites = lambda: sites
m.patch_task = lambda tid, fields: None
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    m.cmd_signin_done(types.SimpleNamespace(site='ewf.companieshouse.gov.uk'))
print('---JSON---'); print(json.dumps(True))`, SITES);
      expect(out).toBe(true);
      const lines = rf(join(dir, 'pending.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(lines).toHaveLength(1);
      expect(lines[0].host).toBe('ewf.companieshouse.gov.uk');
      // The keep-alive task was closed, not reopened, so it is not for the robot.
      expect(lines[0].tasks).toEqual(['rec1']);
      expect(existsSync(join(dir, 'pending.jsonl'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the Robot sign-in app and its link', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'robot-signin.applescript'), 'utf8');
  const build = readFileSync(join(ROOT, 'scripts', 'build-robot-signin.sh'), 'utf8');
  it('handles robotsignin://all and robotsignin://site/<host>', () => {
    expect(src).toMatch(/on open location theURL/);
    expect(src).toMatch(/starts with "all"/);
    expect(src).toMatch(/starts with "site\/"/);
  });
  it('strips the scheme prefix exactly (found in review: text 14 kept the slash), run through osascript', () => {
    const { mkdtempSync, rmSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'od-robot-'));
    try {
      execFileSync('osacompile', ['-o', join(dir, 'r.scpt'), join(ROOT, 'scripts', 'robot-signin.applescript')]);
      const out = execFileSync('osascript', ['-e',
        `set s to (load script POSIX file "${join(dir, 'r.scpt')}")\n` +
        `return (s's bodyOf("robotsignin://all")) & "|" & (s's bodyOf("robotsignin://site/app.pingen.com"))`],
        { encoding: 'utf8' }).trim();
      expect(out).toBe('all|site/app.pingen.com');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // 25 Sep 2026: each Duckworth flat is its own Utilita login in its own robot profile, and the
  // app opened only the main one. Driven through osascript, not read off the source.
  it('opens each sign-in on its own profile, and a waiting-task line always on the main one', () => {
    const { mkdtempSync, rmSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'od-robot-'));
    try {
      execFileSync('osacompile', ['-o', join(dir, 'r.scpt'), join(ROOT, 'scripts', 'robot-signin.applescript')]);
      const run = (expr) => execFileSync('osascript', ['-e',
        `set s to (load script POSIX file "${join(dir, 'r.scpt')}")\nreturn ${expr}`], { encoding: 'utf8' }).trim();
      const flat = 'Utilita Apartment 1 (a@b.com) | my.utilita.co.uk | https://my.utilita.co.uk/energy | utilita-apt1';
      const waiting = 'Pingen (letters) (2 waiting) | app.pingen.com | https://app.pingen.com/';
      expect(run(`s's profileOf("${flat}")`)).toBe('utilita-apt1');
      expect(run(`s's profileOf("${waiting}")`)).toBe('default');
      const flatCmd = run(`s's loginCommand("${flat}")`);
      expect(flatCmd).toMatch(/agent-browser\.js login --url 'https:\/\/my\.utilita\.co\.uk\/energy' --profile 'utilita-apt1' --label 'Utilita Apartment 1 \(a@b\.com\)'$/);
      expect(flatCmd).not.toMatch(/--add/);
      // A waiting line's name carries "(2 waiting)", so it is never offered as the site's name.
      expect(run(`s's loginCommand("${waiting}")`)).toMatch(/login --url 'https:\/\/app\.pingen\.com\/' --profile 'default'$/);
      // Add a new site: a bar in the typed name cannot shift the fields, and a blank name is the host.
      const added = run(`s's newSiteLine("Acme | Portal", "portal.acme.co.uk", "https://portal.acme.co.uk/login")`);
      expect(added).toBe('Acme - Portal | portal.acme.co.uk | https://portal.acme.co.uk/login | default | new');
      expect(run(`s's newSiteLine("", "portal.acme.co.uk", "https://portal.acme.co.uk/login")`))
        .toBe('portal.acme.co.uk | portal.acme.co.uk | https://portal.acme.co.uk/login | default | new');
      // Only a line Kevin added on purpose carries --add, and it still opens on the main profile.
      expect(run(`s's loginCommand("${added}")`)).toMatch(/--url 'https:\/\/portal\.acme\.co\.uk\/login' --profile 'default' --label 'Acme - Portal' --add$/);
      // login's NOTE lines reach Kevin; its other output does not.
      expect(run(`s's notesIn("Plain Chrome window open" & linefeed & "NOTE: gov.uk is read-only" & linefeed & "Kept 2 session cookie(s)")`))
        .toBe('gov.uk is read-only');
      expect(run(`s's addNewItem`)).toBe('+ Add a new site…');
      // A line break in a typed name is flattened, never a second line in the list.
      expect(run(`s's newSiteLine("Two" & linefeed & "Lines", "h.example.com", "https://h.example.com/")`))
        .toBe('Two Lines | h.example.com | https://h.example.com/ | default | new');
      // signin-list's SKIPPED lines are said aloud and never offered as a site (review: do shell
      // script drops stderr on success, so they arrive on stdout).
      expect(run(`((count of (sites of (s's splitSiteList("A | a.com | https://a.com/ | default" & linefeed & "SKIPPED: x: bad" & linefeed)))) as text) & "/" & (item 1 of (skipped of (s's splitSiteList("SKIPPED: x: bad"))))`))
        .toBe('1/x: bad');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('the site list comes from signin-list, a flat hands nothing back, and a site link opens every profile on it', () => {
    expect(src).toMatch(/scripts\/agent-browser\.js signin-list/);
    const signIn = src.slice(src.indexOf('on signInTo'), src.indexOf('end signInTo'));
    expect(signIn.indexOf('if theProfile is not "default"')).toBeGreaterThan(-1);
    expect(signIn.indexOf('if theProfile is not "default"')).toBeLessThan(signIn.indexOf('signin-done --site'));
    expect(src).toMatch(/signin-list 2>&1/);
    // The full list takes several picks at once: the watcher's message asks for both flats.
    const runH = src.slice(src.indexOf('\non run\n'), src.indexOf('\nend run\n'));
    expect(runH).toMatch(/choose from list \(\{addNewItem\} & allSites\(\)\)[^\n]*with multiple selections allowed/);
    // A site already on the list opens on its own lines (a flat's profile), never as a new main-profile line.
    const ask = src.slice(src.indexOf('on askNewSite'), src.indexOf('end askNewSite'));
    expect(ask).toMatch(/agent-browser\.js signin-list --for " & quoted form of theUrl/);
    expect(ask.indexOf('return known')).toBeGreaterThan(-1);
    expect(ask.indexOf('return known')).toBeLessThan(ask.indexOf('newSiteLine('));
    const link = src.slice(src.indexOf('on open location'), src.indexOf('end open location'));
    expect(link).toMatch(/set end of matches to/);
    expect(link).toMatch(/runChain\(matches, liveN\)/);
  });
  it('resolves node the way the runners do, never a bare "node" under launchd', () => {
    const py = readFileSync(join(ROOT, 'scripts', 'agent-dispatch.py'), 'utf8');
    expect(py).toMatch(/AGENT_NODE_BIN/);
    expect(py).toMatch(/UPPER\(\{Agent Output\}\)/);
  });
  it('opens sites one after another, hands each back as its window closes, and starts ONE detached pickup after the last (8 Sep 2026)', () => {
    expect(src).toMatch(/agent-browser\.js login --url/);
    expect(src).toMatch(/signin-done --site/);
    expect(src).toMatch(/detach\.py --cwd .* -- \/usr\/bin\/python3 scripts\/job-queue\.py run signin-pickup -- .*signin-pickup-run\.sh/);
    // Window, then hand-back, inside signInTo; the pickup only in startPickup,
    // called once from runChain after the loop.
    expect(src.indexOf('agent-browser.js login')).toBeLessThan(src.indexOf('signin-done --site'));
    expect(src.indexOf('on startPickup()')).toBeGreaterThan(src.indexOf('end signInTo'));
    expect(src.indexOf('startPickup()')).toBeLessThan(src.indexOf('on runChain'));
    const chain = src.slice(src.indexOf('on runChain'), src.indexOf('end runChain'));
    expect(chain.indexOf('end repeat')).toBeLessThan(chain.indexOf('startPickup()'));
    // Never the shell's own "&": that is what held the app's pipe for a whole run.
    expect(src).not.toMatch(/2>&1 &"/);
    expect(src).not.toMatch(/nohup/);
    // stderr is what do shell script reports as the error; never hide it.
    expect(src).not.toMatch(/login --url[^\n]*2>&1/);
    expect(src).not.toMatch(/signin-done --site[^\n]*2>\/dev\/null/);
    // Every window failure is a notification and the chain carries on.
    expect(src).toMatch(/Could not open the window/);
    expect(src).toMatch(/cannot sign into/);
    // The card's per-site link is resolved through the engine (www.pingen.com -> app.pingen.com).
    expect(src).toMatch(/signin-site --url/);
  });
  it('the session check is code: the WebFiling door walks two clicks and the verdict reads the landing (8 Sep 2026)', () => {
    const b = require(join(ROOT, 'scripts', 'agent-browser.js'));
    const sites = b.loadSites();
    expect(sites['ewf.companieshouse.gov.uk'].sessionWalk).toEqual(['Continue', 'Go to GOV.UK One Login']);
    expect(sites['signin.account.gov.uk'].loginUrl).toBe('https://ewf.companieshouse.gov.uk/seclogin?tc=1');
    // The real landings of 8 Sep 2026: signed in, and the door the old check stopped at.
    expect(b.sessionVerdict('https://ewf.companieshouse.gov.uk///runpage?page=savedCompanies&.dyn=n8nvyu3', 0).signedIn).toBe(true);
    expect(b.sessionVerdict('https://ewf.companieshouse.gov.uk/runpage?page=oauthSignIn', 0).signedIn).toBe(false);
    expect(b.sessionVerdict('https://signin.account.gov.uk/enter-email', 0).signedIn).toBe(false);
    expect(b.sessionVerdict('https://app.pingen.com/dashboard', 1).signedIn).toBe(false);
    expect(b.sessionVerdict('https://app.pingen.com/dashboard', 0).signedIn).toBe(true);
    expect(b.sessionVerdict('https://www.tax.service.gov.uk/gg/sign-in', 0).signedIn).toBe(false);
    // A hyphenated landing is not the door (review, 8 Sep 2026).
    expect(b.sessionVerdict('https://app.pingen.com/login-success', 0).signedIn).toBe(true);
    expect(b.sessionVerdict('https://app.pingen.com/auth-callback?ok=1', 0).signedIn).toBe(true);
    const run = readFileSync(join(ROOT, 'scripts', 'signin-pickup-run.sh'), 'utf8');
    expect(run).toMatch(/agent-browser\.js session --site/);
    expect(run).toMatch(/Never run agent-browser\.js login/);
  });
  it('the detached launcher leaves no inherited descriptor in the child (this is the hang, in miniature)', () => {
    const out = execFileSync('python3', [join(ROOT, 'scripts', 'detach.py'), 'selftest'], { encoding: 'utf8' });
    expect(out).toMatch(/selftest OK/);
  });
  it('the build registers the URL scheme in the app bundle', () => {
    expect(build).toMatch(/CFBundleURLSchemes:0 string robotsignin/);
    expect(build).toMatch(/lsregister/);
  });
  it('the pickup run works only the handed-back task ids (from pending.jsonl, copied, trimmed after a clean run) and is registered on-demand', () => {
    const run = readFileSync(join(ROOT, 'scripts', 'signin-pickup-run.sh'), 'utf8');
    expect(run).toMatch(/PENDING=.*pending\.jsonl/);
    // A COPY (15 Sep 2026): the rename lost three hand-backs when the run died.
    expect(run).toMatch(/shutil\.copyfile\(sys\.argv\[1\], sys\.argv\[2\]\)/);   // under the append lock
    expect(run).not.toMatch(/mv "\$PENDING"/);
    expect(run).toMatch(/WORK ONLY THESE TASK IDS/);
    expect(run).toMatch(/short-session sites/i);
    // Nothing pending is a clean exit, not a failure.
    expect(run).toMatch(/nothing was handed back since the last run/);
    // On demand, so deliberately NOT in job-schedule.json (every entry there
    // must have a cron and a lateness limit, and this has nothing to be late
    // for). job-queue still gives it the lock: an unknown job is never skipped.
    const sched = JSON.parse(readFileSync(join(ROOT, 'scripts', 'job-schedule.json'), 'utf8'));
    expect(sched['signin-pickup']).toBeUndefined();
    // and not in the scheduled-jobs list either, which is only for jobs on a clock.
  });
});

// Kevin, 4 Sep 2026: sign-ins arrive once, with the 08:00 message, and the
// robot keeps sticky sessions alive so they rarely arrive at all.
describe('sign-in waits are batched to the morning and sessions are kept alive', () => {
  it('submit refuses a SIGN-IN NEEDED line for a site the robot cannot sign into (Namecheap, 8 Sep 2026)', () => {
    const out = py(`
m.load_login_sites = lambda: json.loads(sys.argv[1])
m.patch_task = lambda t, f: None
m.get_task = lambda t: {'id': t, 'fields': {}}
m.supersede_attachments = lambda *a, **k: None
import tempfile, os
fh = tempfile.NamedTemporaryFile('w', suffix='.md', delete=False)
fh.write('Checked the register. ' * 12 + '\\nSIGN-IN NEEDED: Namecheap (https://www.namecheap.com/myaccount/login/) \u2014 renewal needs payment.\\n\\n**Carrying this out will involve:** Nothing until you sign in.')
fh.close()
agent = sorted(m.AGENTS)[0]
try:
    m.cmd_submit(types.SimpleNamespace(task='recT1', agent=agent, type='Research', output_file=fh.name, tier1=False))
    refused = False
except SystemExit as e:
    refused = str(e)
os.unlink(fh.name)
print('---JSON---'); print(json.dumps({'refused': refused}))`, SITES);
    expect(out.refused).toMatch(/names 'Namecheap', which is not a site the robot can sign into/);
    expect(out.refused).toMatch(/Pingen \(letters\)/);
    // 25 Sep 2026: the old "The robot has no access" line was a dead end; the refusal now
    // points at a SITE wall, which asks Kevin to add the site and wakes the task when he does.
    expect(out.refused).toMatch(/block TASKID --kind SITE --subject <the site's host>/);
  });
  it('submit parks a SIGN-IN NEEDED output until tomorrow (the queue and digest hide it today)', () => {
    const out = py(`
m.load_login_sites = lambda: json.loads(sys.argv[1])
captured = {}
m.patch_task = lambda t, f: captured.setdefault('fields', f)
m.get_task = lambda t: {'id': t, 'fields': dict(captured.get('fields', {}))}
m.supersede_attachments = lambda *a, **k: None
import tempfile, os
fh = tempfile.NamedTemporaryFile('w', suffix='.md', delete=False)
fh.write('TRACK RECORD: none found (searched tasks + Gmail for email hmrc@example.com)\\n\\n' + 'Verified from the register. ' * 12 + '\\nSIGN-IN NEEDED: Pingen (https://app.pingen.com/)\\n\\n**Carrying this out will involve:** Nothing until you sign in; then the robot posts the letter.')
fh.close()
agent = sorted(m.AGENTS)[0]
try:
    m.cmd_submit(types.SimpleNamespace(task='recT1', agent=agent, type='Research', output_file=fh.name, tier1=False))
    refused = False
except SystemExit as e:
    refused = str(e)
os.unlink(fh.name)
f = captured.get('fields', {})
print('---JSON---'); print(json.dumps({'refused': refused, 'status': f.get(m.AF['status']), 'deferred': f.get(m.AF['deferredUntil']), 'tomorrow': m.tomorrow_london()}))`, SITES);
    expect(out.refused).toBe(false);
    expect(out.status).toBe('Approval');
    expect(out.deferred).toBe(out.tomorrow);
  });
  it('signin-done closes a keep-alive task outright instead of reopening it for a robot', () => {
    const out = py(`
sites = {'app.pingen.com': {'label': 'Pingen (letters)', 'login': True, 'loginUrl': 'https://app.pingen.com/'}}
recs = [{'id': 'recK', 'fields': {m.AF['name']: 'SIGN-IN: Pingen session lapsed', m.AF['agentOutput']: 'SIGN-IN NEEDED: Pingen (letters) (https://app.pingen.com/)', m.AF['teamMember']: ['rec1hYELb4zS8pjjO'], m.AF['notes']: '[x] KEEPALIVE CHECK: Pingen signed out.'}}]
m.query_tasks = lambda formula, **kw: recs
m.get_task = lambda tid: recs[0]
m.load_login_sites = lambda: sites
patched = {}
m.patch_task = lambda tid, fields: patched.__setitem__(tid, fields)
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    m.cmd_signin_done(types.SimpleNamespace(site='app.pingen.com'))
f = patched['recK']
print('---JSON---'); print(json.dumps({'status': f.get(m.AF['status']), 'completed': bool(f.get(m.AF['completion'])), 'deferred': f.get(m.AF['deferredUntil'], 'unset')}))`);
    expect(out.status).toBe('Completed');
    expect(out.completed).toBe(true);
    expect(out.deferred).toBeNull();
  });
  it('the keep-alive selftest passes and it skips the short-session sites', () => {
    const out = execFileSync('python3', [join(ROOT, 'scripts', 'session-keepalive.py'), 'selftest'], { encoding: 'utf8' });
    expect(out).toMatch(/selftest OK/);
    const browser = readFileSync(join(ROOT, 'scripts', 'agent-browser.js'), 'utf8');
    expect(browser).toMatch(/passwordFields/);
    // GOV.UK x3, HMRC, gov.uk, and GoCardless (90-minute cookie, 15 Sep 2026).
    expect((browser.match(/shortSession: true/g) || []).length).toBe(6);
    const b = require(join(ROOT, 'scripts', 'agent-browser.js'));
    const sites = b.loadSites();
    expect(sites['manage.gocardless.com'].shortSession).toBe(true);
    // Spotify's door shows "Continue with Spotify" whether or not the cookie is
    // live; the walk is what tells them apart (proven 15 Sep 2026).
    expect(sites['creators.spotify.com'].sessionWalk).toEqual(['Continue with Spotify']);
    expect(sites['creators.spotify.com'].loginUrl).toBe('https://creators.spotify.com/pod/login');
  });
  it('the keep-alive reads the session verdict, not a path heuristic, and lists without walking', () => {
    const ka = readFileSync(join(ROOT, 'scripts', 'session-keepalive.py'), 'utf8');
    expect(ka).toMatch(/"session", "--site", host/);
    expect(ka).not.toMatch(/SIGNIN_PATH_RE/);
    expect(ka).toMatch(/"signin-waiting", "--no-walk"/);
  });
});

// 15 Sep 2026. Three faults in one loop: agents wrote SIGN-IN NEEDED without
// looking (recmtmvJTP1MRXLZE asked for Facebook on 14 Sep while the ledger
// showed the session live every hour), the app opened a window for every site
// a task named, and a pickup that died on the allowance limit (11 Sep, eight
// seconds) lost its three tasks because the poll only counted approved,
// changes-requested and deferred hand-backs.
describe('a sign-in is asked once, and only when the site is really signed out', () => {
  const report = 'TRACK RECORD: none found (searched tasks + Gmail for email hmrc@example.com)\n\n' + 'Verified from the register. '.repeat(12) + '\n';
  const CARRY = '\n\n**Carrying this out will involve:** Nothing until you sign in; then the robot posts the letter.';
  function submitWith(check) {
    return py(`
m.load_login_sites = lambda: json.loads(sys.argv[1])
${check}
captured = {}
m.patch_task = lambda t, f: captured.setdefault('fields', f)
m.get_task = lambda t: {'id': t, 'fields': dict(captured.get('fields', {}))}
m.supersede_attachments = lambda *a, **k: None
import tempfile, os
fh = tempfile.NamedTemporaryFile('w', suffix='.md', delete=False)
fh.write(${JSON.stringify(report)} + 'SIGN-IN NEEDED: Pingen (https://app.pingen.com/)' + ${JSON.stringify(CARRY)})
fh.close()
agent = sorted(m.AGENTS)[0]
try:
    m.cmd_submit(types.SimpleNamespace(task='recT1', agent=agent, type='Research', output_file=fh.name, tier1=False))
    refused = False
except SystemExit as e:
    refused = str(e)
os.unlink(fh.name)
f = captured.get('fields', {})
print('---JSON---'); print(json.dumps({'refused': refused, 'output': f.get(m.AF['agentOutput'], ''), 'status': f.get(m.AF['status'])}))`, SITES);
  }
  it('submit REFUSES the line when the session walk finds the site signed in, and says what to do instead', () => {
    const out = submitWith(`m.session_check = lambda host, **k: {'signedIn': True, 'url': 'https://app.pingen.com/organisation/x/dashboard', 'at': '2026-09-15T09:23:03.000Z', 'source': 'walk'}`);
    expect(out.refused).toMatch(/but the robot IS signed in to Pingen \(letters\)/);
    expect(out.refused).toMatch(/landed on https:\/\/app\.pingen\.com\/organisation\/x\/dashboard/);
    expect(out.refused).toMatch(/session --site app\.pingen\.com/);
    expect(out.status).toBeNull();   // nothing was patched
  });
  it('submit keeps the line when the walk says signed out', () => {
    const out = submitWith(`m.session_check = lambda host, **k: {'signedIn': False, 'url': 'https://app.pingen.com/login', 'at': 'x', 'source': 'walk'}`);
    expect(out.refused).toBe(false);
    expect(out.status).toBe('Approval');
    expect(out.output).toMatch(/SIGN-IN NEEDED: Pingen \(https:\/\/app\.pingen\.com\/\)\n/);
    expect(out.output).not.toMatch(/unverified/);
  });
  it('submit keeps the line but marks it (unverified) when the walk itself cannot run, and the mark parses away', () => {
    const out = submitWith(`m.session_check = lambda host, **k: {'error': 'session walk timed out after 90s (robot profile busy)'}`);
    expect(out.refused).toBe(false);
    expect(out.output).toMatch(/^SIGN-IN NEEDED: Pingen \(https:\/\/app\.pingen\.com\/\) — \(unverified: session walk timed out after 90s robot profile busy\)$/m);
    // the blank line before the closing line survives the mark (review, 15 Sep 2026)
    expect(out.output).toMatch(/robot profile busy\)\n\n\*\*Carrying this out/);
    const parsed = py(`
print('---JSON---'); print(json.dumps([
  m.parse_signin_line('SIGN-IN NEEDED: Pingen (https://app.pingen.com/) — (unverified: profile busy)'),
  m.parse_signin_line('SIGN-IN NEEDED: GOV.UK One Login (one-hour window) — (unverified)'),
  m.parse_signin_line('SIGN-IN NEEDED: HMRC (https://www.tax.service.gov.uk/gg/sign-in) (unverified)'),
]))`);
    expect(parsed).toEqual([
      { site: 'Pingen', url: 'https://app.pingen.com/', verified: false },
      { site: 'GOV.UK One Login', url: '', verified: false },
      { site: 'HMRC', url: 'https://www.tax.service.gov.uk/gg/sign-in', verified: false },
    ]);
  });
  it('SIGNIN_SKIP_WALK leaves the line untouched (the seam every other test relies on)', () => {
    const out = submitWith(``);
    expect(out.refused).toBe(false);
    expect(out.output).not.toMatch(/unverified/);
  });
  it('the ledger verdict is reused only while fresh, and only the newest line for that site counts', () => {
    const { writeFileSync: wf, mkdtempSync: md } = require('node:fs');
    const dir = md(join(tmpdir(), 'od-ledger-'));
    const ledger = join(dir, 'runs.jsonl');
    wf(ledger, [
      '{"at":"2026-09-15T07:33:25.750Z","cmd":"session","site":"www.facebook.com","url":"https://www.facebook.com/login","signedIn":false,"profile":"default"}',
      '{"at":"2026-09-15T09:23:03.599Z","cmd":"session","site":"www.facebook.com","url":"https://www.facebook.com/home.php","signedIn":true,"profile":"default"}',
      '{"at":"2026-09-15T09:25:00.000Z","cmd":"read","url":"https://www.facebook.com/x","profile":"default"}',
      '{"at":"2026-09-15T09:30:00.000Z","cmd":"session","site":"www.facebook.com","url":"https://www.facebook.com/login","signedIn":false,"profile":"spotify"}',
      'not json',
    ].join('\n') + '\n');
    const out = py(`
from datetime import datetime, timezone
L = ${JSON.stringify(ledger)}
print('---JSON---'); print(json.dumps([
  m.ledger_session_verdict('www.facebook.com', 30, L, datetime(2026, 9, 15, 9, 40, tzinfo=timezone.utc)),
  m.ledger_session_verdict('www.facebook.com', 30, L, datetime(2026, 9, 15, 10, 0, tzinfo=timezone.utc)),
  m.ledger_session_verdict('app.pingen.com', 30, L, datetime(2026, 9, 15, 9, 40, tzinfo=timezone.utc)),
  m.ledger_session_verdict('www.facebook.com', 30, L + '.missing', datetime(2026, 9, 15, 9, 40, tzinfo=timezone.utc)),
]))`);
    // the default profile's verdict, not the later one from another profile
    expect(out[0]).toEqual({ signedIn: true, url: 'https://www.facebook.com/home.php', at: '2026-09-15T09:23:03.599Z', source: 'ledger' });
    expect(out.slice(1)).toEqual([null, null, null]);
  });
  it('signin-waiting hands a site already signed in straight back (alreadyLive) and lists the rest with its check', () => {
    const out = py(`
sites = json.loads(sys.argv[1])
recs = [
  {'id': 'rec1', 'fields': {m.AF['name']: 'CS01', m.AF['agentOutput']: 'SIGN-IN NEEDED: Companies House WebFiling (https://ewf.companieshouse.gov.uk/seclogin?tc=1)', m.AF['teamMember']: ['recJ8J8idWE8d97tH']}},
  {'id': 'rec3', 'fields': {m.AF['name']: 'HMRC letter', m.AF['agentOutput']: 'SIGN-IN NEEDED: Pingen (https://app.pingen.com/) — (unverified: busy)', m.AF['teamMember']: ['recjh6mmaF8KJW8t3']}},
  {'id': 'rec4', 'fields': {m.AF['name']: 'Xero thing', m.AF['agentOutput']: 'SIGN-IN NEEDED: Xero (https://go.xero.com/)', m.AF['teamMember']: ['recjh6mmaF8KJW8t3']}},
]
m.query_tasks = lambda formula, **kw: recs
m.get_task = lambda tid: next(r for r in recs if r['id'] == tid)
m.load_login_sites = lambda: sites
patched = {}
m.patch_task = lambda tid, fields: patched.__setitem__(tid, fields)
walked = []
def check(host, use_ledger=False, **k):
    walked.append((host, use_ledger))
    return {'signedIn': host == 'app.pingen.com', 'url': 'https://' + host + '/x', 'at': 't', 'source': 'walk'}
m.session_check = check
import io, contextlib, os
os.environ.pop('SIGNIN_SKIP_WALK', None)
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m.cmd_signin_waiting(types.SimpleNamespace(no_walk=False, dry_run=False))
d = json.loads(buf.getvalue())
print('---JSON---'); print(json.dumps({'walked': walked, 'waiting': [(g['host'], g.get('sessionCheck', {}).get('state'), [t['verified'] for t in g['tasks']]) for g in d['sites']],
  'live': [(g['host'], [h['task'] for h in g['handedBack']]) for g in d['alreadyLive']], 'patched': sorted(patched), 'status': patched.get('rec3', {}).get(m.AF['status'])}))`, SITES);
    // One walk per real site, none for the stranger; the WebFiling entry has no shortSession here so the ledger is allowed.
    expect(out.walked).toEqual([['ewf.companieshouse.gov.uk', true], ['app.pingen.com', true]]);
    expect(out.waiting).toEqual([['ewf.companieshouse.gov.uk', 'signed-out', [true]], ['unknown', null, [true]]]);
    expect(out.live).toEqual([['app.pingen.com', ['rec3']]]);
    expect(out.patched).toEqual(['rec3']);
    expect(out.status).toBe('Today');
  });
  it('signin-waiting --site checks that one host only and lists the rest unchecked (the per-site link)', () => {
    const out = py(`
sites = json.loads(sys.argv[1])
recs = [
  {'id': 'rec1', 'fields': {m.AF['name']: 'CS01', m.AF['agentOutput']: 'SIGN-IN NEEDED: Companies House WebFiling (https://ewf.companieshouse.gov.uk/seclogin?tc=1)', m.AF['teamMember']: ['recJ8J8idWE8d97tH']}},
  {'id': 'rec3', 'fields': {m.AF['name']: 'HMRC letter', m.AF['agentOutput']: 'SIGN-IN NEEDED: Pingen (https://app.pingen.com/)', m.AF['teamMember']: ['recjh6mmaF8KJW8t3']}},
]
m.query_tasks = lambda formula, **kw: recs
m.get_task = lambda tid: next(r for r in recs if r['id'] == tid)
m.load_login_sites = lambda: sites
patched = []
m.patch_task = lambda tid, fields: patched.append(tid)
walked = []
m.session_check = lambda host, **k: (walked.append(host), {'signedIn': True, 'url': 'u', 'at': 't', 'source': 'walk'})[1]
import io, contextlib, os
os.environ.pop('SIGNIN_SKIP_WALK', None)
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m.cmd_signin_waiting(types.SimpleNamespace(no_walk=False, dry_run=False, site='app.pingen.com'))
d = json.loads(buf.getvalue())
print('---JSON---'); print(json.dumps({'walked': walked, 'patched': patched, 'sites': [(g['host'], 'sessionCheck' in g) for g in d['sites']], 'live': [g['host'] for g in d['alreadyLive']]}))`, SITES);
    expect(out.walked).toEqual(['app.pingen.com']);
    expect(out.patched).toEqual(['rec3']);
    expect(out.sites).toEqual([['ewf.companieshouse.gov.uk', false]]);
    expect(out.live).toEqual(['app.pingen.com']);
  });
  it('signin-waiting --no-walk and --dry-run never hand anything back', () => {
    const out = py(`
sites = json.loads(sys.argv[1])
recs = [{'id': 'rec3', 'fields': {m.AF['name']: 'HMRC letter', m.AF['agentOutput']: 'SIGN-IN NEEDED: Pingen (https://app.pingen.com/)', m.AF['teamMember']: ['recjh6mmaF8KJW8t3']}}]
m.query_tasks = lambda formula, **kw: recs
m.get_task = lambda tid: recs[0]
m.load_login_sites = lambda: sites
patched = []
m.patch_task = lambda tid, fields: patched.append(tid)
walked = []
m.session_check = lambda host, **k: (walked.append(host), {'signedIn': True, 'url': 'u', 'at': 't', 'source': 'walk'})[1]
import io, contextlib, os
os.environ.pop('SIGNIN_SKIP_WALK', None)
res = []
for ns in (types.SimpleNamespace(no_walk=True, dry_run=False), types.SimpleNamespace(no_walk=False, dry_run=True)):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        m.cmd_signin_waiting(ns)
    d = json.loads(buf.getvalue())
    res.append({'sites': [g['host'] for g in d['sites']], 'live': [(g['host'], g['handedBack'], g['wouldHandBack']) for g in d['alreadyLive']], 'dry': d['dryRun']})
print('---JSON---'); print(json.dumps({'res': res, 'walked': walked, 'patched': patched}))`, SITES);
    expect(out.res[0]).toEqual({ sites: ['app.pingen.com'], live: [], dry: false });
    expect(out.res[1]).toEqual({ sites: [], live: [['app.pingen.com', [], ['rec3']]], dry: true });
    expect(out.walked).toEqual(['app.pingen.com']);
    expect(out.patched).toEqual([]);
  });
});

describe('a task a sign-in reopened is a hand-back the poll must wake for (11 Sep 2026)', () => {
  const NOTE = '[15 Sep 2026 08:30 — Robot sign-in] SIGNED IN: Kevin signed in to Pingen (letters). The session is live now: carry on.';
  it('flags Status Today, no outcome, SIGNED IN as the newest stamp, under 24h old; nothing else', () => {
    const out = py(`
from datetime import datetime, timezone
NOW = datetime(2026, 9, 15, 9, 0, tzinfo=timezone.utc)   # 10:00 London
def t(**kw):
    base = {'id': 'r', 'status': 'Today', 'outcome': '', 'notes': 'earlier\\n\\n' + ${JSON.stringify(NOTE)}}
    base.update(kw); return base
cases = {
  'fresh': t(),
  'overdue': t(status='Overdue'),
  'submitted since': t(notes=t()['notes'] + '\\n[15 Sep 2026 08:45 — agent-dispatch] SUBMITTED (round 2) as Admin with no new file'),
  'annotated since': t(notes=t()['notes'] + '\\n[15 Sep 2026 08:50 — agent] PARKED: still signed out'),
  'at approval': t(status='Approval'),
  'approved': t(outcome='Approved as-is'),
  'stale (yesterday)': t(notes='[14 Sep 2026 08:30 — Robot sign-in] SIGNED IN: Kevin signed in to Pingen.'),
  'no stamp': t(notes='plain notes'),
}
print('---JSON---'); print(json.dumps({k: bool(m.signin_reopened_reason(v, NOW)) for k, v in cases.items()}))`);
    expect(out).toEqual({ fresh: true, overdue: true, 'submitted since': false, 'annotated since': false, 'at approval': false, approved: false, 'stale (yesterday)': false, 'no stamp': false });
    const why = py(`
from datetime import datetime, timezone
NOW = datetime(2026, 9, 15, 9, 0, tzinfo=timezone.utc)
print('---JSON---'); print(json.dumps(m.signin_reopened_reason({'status': 'Today', 'outcome': '', 'notes': '[15 Sep 2026 08:30 — Robot sign-in] SIGNED IN: Kevin signed in to Pingen (letters) (app.pingen.com). The session is live now: carry on from where you stopped.'}, NOW)))`);
    // the host rides in the reason, so the poll's agent knows what to pass to `session --site`
    expect(why).toMatch(/to app\.pingen\.com; nothing has touched the task since .* \(session --site app\.pingen\.com first\)$/);
  });
  it('mark_signin_reopened flags the task dicts and returns the ids once each', () => {
    const out = py(`
from datetime import datetime, timezone
NOW = datetime(2026, 9, 15, 9, 0, tzinfo=timezone.utc)
a = {'id': 'a', 'status': 'Today', 'outcome': '', 'notes': ${JSON.stringify(NOTE)}}
b = {'id': 'b', 'status': 'Today', 'outcome': '', 'notes': 'nothing'}
ids = m.mark_signin_reopened([a, b, a], NOW)
print('---JSON---'); print(json.dumps({'ids': ids, 'a': bool(a.get('signinReopened')), 'b': 'signinReopened' in b}))`);
    expect(out).toEqual({ ids: ['a'], a: true, b: false });
  });
  it('the queue emits the list and the count, and the poll and the runners read them', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'agent-dispatch.py'), 'utf8');
    const fn = src.slice(src.indexOf('def build_queue('), src.indexOf('def cmd_queue('));
    expect(fn).toMatch(/^    mark_signin_reopened\(agent_linked\)$/m);
    // counted from the WORKLIST only: a reopened task a lane diverts must not wake the poll for nothing (review, 15 Sep 2026)
    expect(fn).toMatch(/signin_reopened = \[t\["id"\] for t in worklist if t\.get\("signinReopened"\)\]/);
    expect(fn).toMatch(/"signinReopened": signin_reopened,/);
    expect(fn).toMatch(/"signinReopened": len\(signin_reopened\),/);
    // marked BEFORE the lanes copy the dicts
    expect(fn.indexOf('mark_signin_reopened(agent_linked)')).toBeLessThan(fn.indexOf('for t in agent_linked:'));
    const poll = readFileSync(join(ROOT, 'scripts', 'handback-poll.py'), 'utf8');
    expect(poll).toMatch(/HANDBACK_KEYS = \("approvedHandbacks", "changesRequested", "deferredRedos", "signinReopened"\)/);
    const runner = readFileSync(join(ROOT, 'scripts', 'handback-poll-run.sh'), 'utf8');
    expect(runner).toMatch(/every item carrying signinReopened/);
    const pickup = readFileSync(join(ROOT, 'scripts', 'signin-pickup-run.sh'), 'utf8');
    expect(pickup).toMatch(/if "signinReopened" not in q: sys.exit\(2\)/);
  });
});

// The pickup runner itself, run with stubs: a fake repo whose scripts/ answer
// as the real ones would, a fake claude that writes report.json and exits as
// told, and a pending.jsonl that must survive everything but a clean run.
describe('the pickup run never loses a hand-back (11 Sep 2026)', () => {
  const { mkdtempSync: md, mkdirSync, writeFileSync: wf, existsSync, readFileSync: rf, chmodSync, cpSync } = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const RUN = join(ROOT, 'scripts', 'signin-pickup-run.sh');
  const LINE = JSON.stringify({ at: '2026-09-11T09:22:00Z', host: 'app.pingen.com', label: 'Pingen (letters)', tasks: ['recA', 'recB'] });
  function stage({ rc = 0, paused = false, reopened = ['recA', 'recB'], midRun = '', noKey = false, pendingText = LINE + '\n' } = {}) {
    const d = md(join(tmpdir(), 'od-pickup-'));
    const repo = join(d, 'repo', 'scripts'); mkdirSync(repo, { recursive: true });
    cpSync(join(ROOT, 'scripts', 'agent-tools.sh'), join(repo, 'agent-tools.sh'));
    wf(join(repo, 'agent-dispatch.py'), noKey ? `import json\nprint(json.dumps({"counts": {"worklist": 1}}))\n`
      : `import json, sys\nprint(json.dumps({"signinReopened": ${JSON.stringify(reopened)}, "counts": {"worklist": 1}}))\n`);
    wf(join(repo, 'allowance.py'), `import sys, os\nopen(os.environ["STAGE"] + "/allowance-calls", "a").write(" ".join(sys.argv[1:]) + "\\n")\nif sys.argv[1] == "check" and os.environ.get("PAUSED") == "1":\n    print("paused"); sys.exit(3)\nprint("{}")\n`);
    const claude = join(d, 'claude');
    wf(claude, `#!/bin/bash\necho called >> "$STAGE/claude-calls"\nR=$(printf '%s\\n' "$@" | grep -o 'RUNDIR is [^ ]*' | head -1 | cut -d' ' -f3)\necho '{"actions":[]}' > "$R/report.json"\n${midRun ? `echo '${midRun}' >> "$STAGE/pending/pending.jsonl"\n` : ''}exit ${rc}\n`);
    chmodSync(claude, 0o755);
    mkdirSync(join(d, 'pending')); wf(join(d, 'pending', 'pending.jsonl'), pendingText);
    mkdirSync(join(d, 'logs')); mkdirSync(join(d, 'runs')); wf(join(d, 'token'), 'tok');
    const env = { ...process.env, STAGE: d, PAUSED: paused ? '1' : '0', SIGNIN_PICKUP_REPO: join(d, 'repo'), SIGNIN_PICKUP_DIR: join(d, 'pending'),
      SIGNIN_PICKUP_LOG_DIR: join(d, 'logs'), SIGNIN_PICKUP_RUNS: join(d, 'runs'), SIGNIN_PICKUP_CLAUDE: claude, SIGNIN_PICKUP_TOKEN: join(d, 'token') };
    const r = spawnSync('bash', [RUN], { env, encoding: 'utf8' });
    const pending = existsSync(join(d, 'pending', 'pending.jsonl')) ? rf(join(d, 'pending', 'pending.jsonl'), 'utf8') : null;
    const log = existsSync(join(d, 'logs', 'runs.log')) ? rf(join(d, 'logs', 'runs.log'), 'utf8') : '';
    const calls = existsSync(join(d, 'claude-calls')) ? rf(join(d, 'claude-calls'), 'utf8').trim().split('\n').length : 0;
    const allowance = existsSync(join(d, 'allowance-calls')) ? rf(join(d, 'allowance-calls'), 'utf8') : '';
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, pending, log, calls, allowance };
  }
  it('a clean run (rc=0) works the ids and removes its lines from pending.jsonl', () => {
    const r = stage({ rc: 0 });
    expect(r.status).toBe(0);
    expect(r.calls).toBe(1);
    expect(r.stdout).toMatch(/signin-pickup OK — worked: recA recB/);
    // trimmed IN PLACE to empty (never unlinked: a signin-done waiting on the lock holds this inode)
    expect(r.pending).toBe('');
    expect(r.allowance).toMatch(/check --job signin-pickup/);
    expect(r.allowance).toMatch(/mark --job signin-pickup/);
  });
  it('a failed run (rc=1, the 11 Sep shape) keeps pending.jsonl, writes one FAILED line and exits 1 for job-queue to record', () => {
    const r = stage({ rc: 1 });
    expect(r.status).toBe(1);
    expect(r.pending).toBe(LINE + '\n');
    expect(r.log).toMatch(/===== signin-pickup FAILED .*rc=1.*pending\.jsonl kept; the 30-minute poll works the reopened tasks =====/);
    expect(r.stderr).toMatch(/signin-pickup FAILED/);
  });
  it('while the allowance is out the claude call is skipped, pending.jsonl is kept and the exit is clean', () => {
    const r = stage({ paused: true });
    expect(r.status).toBe(0);
    expect(r.calls).toBe(0);
    expect(r.pending).toBe(LINE + '\n');
    expect(r.stdout).toMatch(/the Claude allowance is out/);
    expect(r.log).toMatch(/SKIPPED: the Claude allowance is out/);
  });
  it('a hand-back landing mid-run survives the trim, and ids the poll has already worked are not re-worked', () => {
    const later = JSON.stringify({ at: 'later', host: 'www.facebook.com', label: 'Facebook', tasks: ['recC'] });
    const r = stage({ rc: 0, midRun: later, reopened: ['recA'] });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/worked: recA$/m);
    expect(r.pending).toBe(later + '\n');
  });
  it('a queue.json without the signinReopened key is a broken read: fail, keep pending, no claude call (review, 15 Sep 2026)', () => {
    const r = stage({ noKey: true });
    expect(r.status).toBe(1);
    expect(r.calls).toBe(0);
    expect(r.pending).toBe(LINE + '\n');
    expect(r.log).toMatch(/FAILED .*carries no signinReopened key/);
  });
  it('nothing still waiting (all worked since) trims the file without a claude call', () => {
    const r = stage({ reopened: [] });
    expect(r.status).toBe(0);
    expect(r.calls).toBe(0);
    expect(r.pending).toBe('');
    expect(r.stdout).toMatch(/none of the handed-back tasks still waits/);
  });
  it('a half-written line in pending.jsonl fails the run and trims nothing (review, 15 Sep 2026)', () => {
    const r = stage({ pendingText: LINE + '\n{"at":"x","host":"app.pin' });
    expect(r.status).toBe(1);
    expect(r.calls).toBe(0);
    expect(r.pending).toBe(LINE + '\n{"at":"x","host":"app.pin');
    expect(r.log).toMatch(/FAILED .*pending\.jsonl is unreadable/);
  });
});

describe('the Robot sign-in app opens a window only for a site that is really signed out (15 Sep 2026)', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'robot-signin.applescript'), 'utf8');
  it('asks signin-waiting once per chain, reads alreadyLive from its answer, and starts the pickup for those tasks too', () => {
    expect(src).toMatch(/on refreshWaiting\(onlyHost\)/);
    expect(src).toMatch(/signin-waiting" & siteArg & " > " & quoted form of waitingFile/);
    // the per-site link checks that site only, and a failed check is a notification, not an error dialog
    expect(src).toMatch(/refreshWaiting\(wantHost\)/);
    expect(src).toMatch(/Could not check the sites/);
    expect((src.match(/agent-dispatch\.py signin-waiting/g) || []).length).toBe(1);
    expect(src).toMatch(/d\.alreadyLive/);
    expect(src).toMatch(/on runChain\(theLines, liveHanded\)/);
    expect(src).toMatch(/set handed to liveHanded/);
    expect(src).toMatch(/liveHosts\(\) contains wantHost/);
    // The old promise was false: nothing polled a reopened task. It is true now, and worded so.
    expect(src).not.toMatch(/30-minute poller will pick/);
    expect(src).toMatch(/counts a sign-in as a hand-back/);
  });
});
