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
  const env = { ...process.env, SIGNIN_PICKUP_DIR: mkdtempSync(join(tmpdir(), 'od-signin-pending-')) };
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
      { site: 'pingen.com', url: 'https://www.pingen.com/en/login' },
      { site: 'Namecheap', url: 'https://www.namecheap.com/myaccount/login/' },
      { site: 'Companies House WebFiling', url: 'https://ewf.companieshouse.gov.uk/seclogin?tc=1' },
      { site: 'GOV.UK One Login', url: '' },
      { site: 'Pingen (letters)', url: 'https://app.pingen.com/' },
      { site: 'HMRC', url: 'https://www.tax.service.gov.uk/gg/sign-in' },
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
    expect(out.note).toMatch(/SIGNED IN: Kevin signed in to Companies House WebFiling/);
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
  it('the pickup run works only the handed-back task ids (from pending.jsonl, taken over by rename) and is registered on-demand', () => {
    const run = readFileSync(join(ROOT, 'scripts', 'signin-pickup-run.sh'), 'utf8');
    expect(run).toMatch(/PENDING=.*pending\.jsonl/);
    expect(run).toMatch(/mv "\$PENDING" "\$RUNDIR\/pending\.jsonl"/);
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
    expect(out.refused).toMatch(/The robot has no access to Namecheap/);
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
    expect((browser.match(/shortSession: true/g) || []).length).toBe(5);
  });
});
