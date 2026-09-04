// A task waiting on a site sign-in is a wait, not a decision (Kevin, 4 Sep
// 2026). These pin the pieces that turn "SIGN-IN NEEDED: <site>" into one
// sitting for him and an immediate pickup for the robot.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
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
  return JSON.parse(execFileSync('python3', ['-c', script, JSON.stringify(arg || {})], { encoding: 'utf8' }).split('---JSON---')[1]);
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
]))`, SITES);
    expect(out).toEqual(['app.pingen.com', 'ewf.companieshouse.gov.uk', 'ewf.companieshouse.gov.uk', null]);
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
});

describe('the Robot sign-in app and its link', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'robot-signin.applescript'), 'utf8');
  const build = readFileSync(join(ROOT, 'scripts', 'build-robot-signin.sh'), 'utf8');
  it('handles robotsignin://all and robotsignin://site/<host>', () => {
    expect(src).toMatch(/on open location theURL/);
    expect(src).toMatch(/starts with "all"/);
    expect(src).toMatch(/starts with "site\/"/);
  });
  it('opens sites one after another and wakes the pickup run through the job queue after each window closes', () => {
    expect(src).toMatch(/agent-browser\.js login --url/);
    expect(src).toMatch(/job-queue\.py run signin-pickup -- .*signin-pickup-run\.sh/);
    expect(src.indexOf('agent-browser.js login')).toBeLessThan(src.indexOf('job-queue.py run signin-pickup'));
  });
  it('the build registers the URL scheme in the app bundle', () => {
    expect(build).toMatch(/CFBundleURLSchemes:0 string robotsignin/);
    expect(build).toMatch(/lsregister/);
  });
  it('the pickup run works only the handed-back task ids and is registered on-demand', () => {
    const run = readFileSync(join(ROOT, 'scripts', 'signin-pickup-run.sh'), 'utf8');
    expect(run).toMatch(/signin-done --site/);
    expect(run).toMatch(/WORK ONLY THESE TASK IDS/);
    // On demand, so deliberately NOT in job-schedule.json (every entry there
    // must have a cron and a lateness limit, and this has nothing to be late
    // for). job-queue still gives it the lock: an unknown job is never skipped.
    const sched = JSON.parse(readFileSync(join(ROOT, 'scripts', 'job-schedule.json'), 'utf8'));
    expect(sched['signin-pickup']).toBeUndefined();
    // and not in the scheduled-jobs list either, which is only for jobs on a clock.
  });
});
