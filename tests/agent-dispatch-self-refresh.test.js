// Kevin, 3 Oct 2026, on the one gap left in the Amazon self-refresh: "Do it
// now." agent-browser.js now signs the robot back in to Amazon itself when a
// check lands on Amazon's sign-in page, and writes the outcome on the session
// line (selfRefresh). When that refresh could not run (another robot held the
// profile) the line still reads signed out, and the dispatcher trusted it: the
// Robot sign-in app would open Kevin's window, and the pickup run would wait on
// a sign-in, when a fresh walk would have run the refresh and needed nobody.
// These drive the real readers against a ledger shaped like the real one.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = join(ROOT, 'scripts', 'agent-dispatch.py');

function py(body, arg) {
  const script = `
import importlib.util, json, sys
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
arg = json.loads(sys.argv[1])
${body}
`;
  return JSON.parse(execFileSync('python3', ['-c', script, JSON.stringify(arg || {})], { encoding: 'utf8' }).split('---JSON---')[1]);
}
const A = 'www.amazon.co.uk';
// The real lines of 2 Oct 2026: Kevin's window at 16:45, then the robot's checks.
const LINES = (refresh) => [
  { at: '2026-10-02T16:45:03.344Z', cmd: 'login', host: A, profile: 'default', mode: 'plain-chrome-mock-keychain', sessionCookiesKept: 0 },
  ...(refresh === 'ran' ? [{ at: '2026-10-03T05:40:30.000Z', cmd: 'refresh', site: A, profile: 'default', result: 'ran' }] : []),
  { at: '2026-10-03T05:40:40.655Z', cmd: 'session', site: A, url: 'https://www.amazon.co.uk/ap/signin?openid.pape.max_auth_age=0', signedIn: false, botCheck: false,
    signinPage: true, profile: 'default', ...(refresh ? { selfRefresh: refresh === 'ran' ? 'ran, still signed out' : refresh } : {}) },
];
const read = (lines) => {
  const file = join(mkdtempSync(join(tmpdir(), 'od-dispatch-refresh-')), 'runs.jsonl');
  writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return py(`
now = datetime(2026, 10, 3, 5, 50, tzinfo=timezone.utc)
print('---JSON---'); print(json.dumps({
  'signedOut': m.ledger_signed_out('${A}', path=arg['file']),
  'recent': m.ledger_session_verdict('${A}', 30, arg['file'], now)}))`, { file });
};

describe('a signed-out line where the robot could not run its own refresh is never trusted', () => {
  it('refresh not run (the profile was busy): neither reader reuses it, so the next check walks and refreshes', () => {
    const got = read(LINES('not run: the profile is in use'));
    expect(got.signedOut).toBeNull();
    expect(got.recent).toBeNull();
  });

  it('refresh ran but its second read failed: not reused either', () => {
    const got = read(LINES('ran, then the second read failed: page.goto: Timeout 45000ms exceeded'));
    expect(got.signedOut).toBeNull();
    expect(got.recent).toBeNull();
  });

  it('refresh ran and the site still asked for a password: a real signed-out verdict, trusted as before', () => {
    const got = read(LINES('ran'));
    expect(got.signedOut).toMatchObject({ signedIn: false, source: 'ledger' });
    expect(got.recent).toMatchObject({ signedIn: false, source: 'ledger' });
  });

  it('a site with no refresh at all (EDF and every other site) is read exactly as before', () => {
    const got = read(LINES(null));
    expect(got.signedOut).toMatchObject({ signedIn: false, source: 'ledger' });
    expect(got.recent).toMatchObject({ signedIn: false, source: 'ledger' });
  });

  it('the walk is given time for a refresh: two walks around a 20-second window, worst case about 270 s', () => {
    const t = py(`print('---JSON---'); print(json.dumps(m.SIGNIN_WALK_TIMEOUT))`);
    expect(t).toBeGreaterThanOrEqual(300);
  });

  it('the sign-in app\'s check then walks once, and only once, instead of trusting the line', () => {
    const lines = (refresh) => LINES(refresh);
    const paths = {};
    const dir = mkdtempSync(join(tmpdir(), 'od-dispatch-walks-'));
    for (const [k, r] of Object.entries({ notRun: 'not run: the profile is in use', failed: 'ran, then the second read failed: x', stillOut: 'ran', none: null })) {
      paths[k] = join(dir, k + '.jsonl');
      writeFileSync(paths[k], lines(r).map(l => JSON.stringify(l)).join('\n') + '\n');
    }
    const got = py(`
import os
os.environ.pop('SIGNIN_SKIP_WALK', None)
out = {}
for name, path in arg['paths'].items():
    walked = []
    m.BROWSER_LEDGER = path
    m.session_walk = lambda host, **k: walked.append(host) or {'signedIn': True, 'url': 'walked', 'at': 'now', 'source': 'walk'}
    v = m.session_check('${A}', use_ledger=True, trust_signed_out=True)
    out[name] = {'walks': len(walked), 'source': v.get('source')}
print('---JSON---'); print(json.dumps(out))`, { paths });
    expect(got.notRun).toEqual({ walks: 1, source: 'walk' });
    expect(got.failed).toEqual({ walks: 1, source: 'walk' });
    expect(got.stillOut).toEqual({ walks: 0, source: 'ledger' });
    expect(got.none).toEqual({ walks: 0, source: 'ledger' });
  });

  it('a live walk whose refresh could not run is not "signed out": the app marks it unverified, the submit gate sends the agent back', () => {
    const got = py(`
import subprocess, types
def fake_run(stdout):
    return lambda *a, **k: types.SimpleNamespace(returncode=0, stdout=stdout, stderr='')
walk = {}
for name, d in arg['outputs'].items():
    m.subprocess.run = fake_run(json.dumps(d))
    m.node_bin = lambda: 'node'
    walk[name] = m.session_walk('${A}')
sites = {'${A}': {'label': 'Amazon (order history)', 'login': True, 'loginUrl': 'https://www.amazon.co.uk/gp/css/order-history'}}
line = 'SIGN-IN NEEDED: Amazon (order history) (https://www.amazon.co.uk/gp/css/order-history)\\n\\nThe order history asked for a sign-in.'
gate = {name: list(m.signin_verify_line(line, sites, check=lambda host, v=v: v)) for name, v in walk.items()}
print('---JSON---'); print(json.dumps({'walk': walk, 'gate': gate}))`, { outputs: {
      notRun: { site: A, signedIn: false, botCheck: false, url: 'https://www.amazon.co.uk/ap/signin', selfRefresh: 'not run: the profile is in use' },
      readFailed: { site: A, signedIn: false, botCheck: false, url: 'https://www.amazon.co.uk/ap/signin', selfRefresh: 'ran, then the second read failed: page.goto: Timeout 45000ms exceeded' },
      stillOut: { site: A, signedIn: false, botCheck: false, url: 'https://www.amazon.co.uk/ap/signin', selfRefresh: 'ran, still signed out' },
      backIn: { site: A, signedIn: true, botCheck: false, url: 'https://www.amazon.co.uk/gp/css/order-history', selfRefresh: 'signed back in' },
    } });
    expect(got.walk.notRun.refreshNotRun).toBe(true);
    expect(got.walk.notRun.error).toMatch(/own refresh did not finish \(not run: the profile is in use\)/);
    expect(got.walk.stillOut).toMatchObject({ signedIn: false, source: 'walk' });
    expect(got.walk.backIn).toMatchObject({ signedIn: true, source: 'walk' });
    // The gate: refused with what to do for "not run"; kept for a real signed-out; refused as already signed in for "signed back in".
    expect(got.gate.notRun[0]).toMatch(/signs itself back in to.*Nothing needs Kevin/);
    expect(got.gate.notRun[0]).toMatch(/block TASKID --kind SIGN-IN --subject www\.amazon\.co\.uk/);
    expect(got.walk.readFailed.refreshNotRun).toBe(true);
    expect(got.gate.readFailed[0]).toMatch(/Nothing needs Kevin/);
    expect(got.gate.stillOut[0]).toBe('');
    expect(got.gate.backIn[0]).toMatch(/IS signed in/);
  });

  it('agrees with the other two readers on what "could not run" means (drift)', () => {
    const cases = ['not run: the profile is in use', 'ran, then the second read failed: x', 'ran, still signed out', 'signed back in', ''];
    const dispatch = py(`print('---JSON---'); print(json.dumps([m.refresh_inconclusive({'selfRefresh': c}) for c in arg['cases']]))`, { cases });
    const hold = JSON.parse(execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})
import signin_hold as sh
cases = json.loads(sys.argv[1])
print(json.dumps([sh._read({'signedIn': False, 'signinPage': True, 'selfRefresh': c}) is None for c in cases]))`, JSON.stringify(cases)], { encoding: 'utf8' }));
    const keepalive = JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ka', ${JSON.stringify(join(ROOT, 'scripts', 'session-keepalive.py'))})
ka = importlib.util.module_from_spec(spec); spec.loader.exec_module(ka)
cases = json.loads(sys.argv[1])
print(json.dumps([ka.session_state({'signedIn': False, 'url': 'https://www.amazon.co.uk/ap/signin', 'selfRefresh': c}) == 'unknown' for c in cases]))`, JSON.stringify(cases)], { encoding: 'utf8' }));
    expect(dispatch).toEqual([true, true, false, false, false]);
    expect(hold).toEqual(dispatch);
    expect(keepalive).toEqual(dispatch);
  });
});
