import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// The robots' key register (Kevin, 16 Oct 2026): "If you log them all in a central place that's not
// publicly available and police that, then you can manage that side of things for me." Every test
// drives the real scripts/key-register.py against a throwaway HOME, with stand-ins for wrangler, gh
// and every service, so no real key, Worker or GitHub secret is ever touched. The rule above all
// the others: a key's value never reaches stdout, stderr, a log, the register or a command line.
// Values here are invented.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts', 'key-register.py');
const OLD = 'patOLDoldOLDold1234.0123456789abcdefOLD';
const NEW = 'patNEWnewNEWnew5678.fedcba9876543210NEW';

function home() {
  const h = mkdtempSync(join(tmpdir(), 'keyreg-'));
  const od = join(h, '.config', 'od');
  mkdirSync(od, { recursive: true });
  const put = (n, v, mode = 0o600) => { writeFileSync(join(od, n), v + '\n'); chmodSync(join(od, n), mode); };
  put('airtable_pat', OLD);
  put('github_pat', 'github_pat_OLD0123456789abcdefghij');
  put('gmail_send_key', 'shared-OLD-0123456789abcdef');
  put('property_manager_passcode_roy', '123456');
  put('ghl_location_id', 'LOC123');
  put('content_engine_mode', 'live');
  put('mystery_file', 'what-is-this-0123456789');
  // Stand-ins: each records its arguments and its stdin, never anything else.
  const bin = join(h, 'bin');
  mkdirSync(bin);
  const stub = (name, listing) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/bash
echo "$*" >> "${h}/${name}.argv"
if [ "$2" = "list" ]; then echo '${listing}'; exit 0; fi
cat >> "${h}/${name}.stdin"; echo >> "${h}/${name}.stdin"
if [ -e "${h}/${name}.fail" ] && grep -q -- "$(cat "${h}/${name}.fail")" <<< "$*"; then exit 1; fi
exit 0
`);
    chmodSync(p, 0o755);
    return p;
  };
  // wrangler is called as: <stub> secret list --name W; gh as: <stub> secret list --repo R --json name
  const w = stub('wrangler', '[{"name":"AIRTABLE_PAT","type":"secret_text"},{"name":"ANTHROPIC_API_KEY","type":"secret_text"},{"name":"PM_PASSCODE","type":"secret_text"},{"name":"FROM_EMAIL","type":"secret_text"}]');
  const g = stub('gh', '[{"name":"AIRTABLE_PAT"}]');
  return { h, od, w, g };
}

// Runs Python with HOME pointed at the throwaway folder. `fake` is a dict of test name -> (status,
// headers) the stand-in _http answers with; anything else reads "could not reach".
function py(env, code, fake = '{}') {
  const script = `
import importlib.util, json, os, sys, io, contextlib
from datetime import datetime, timedelta, timezone
spec = importlib.util.spec_from_file_location("kr", ${JSON.stringify(SCRIPT)})
kr = importlib.util.module_from_spec(spec); spec.loader.exec_module(kr)
kr.worker_names = lambda repo=None: ["w1", "w2"]
kr.readers_of = lambda name, repo=None: ["scripts/example.py"]
FAKE = ${fake}
CALLS = []
def fake_http(url, headers=None, data=None, method=None):
    CALLS.append({"url": url, "headers": headers, "data": data})
    for key, (status, hdrs) in FAKE.items():
        if key in url:
            return status, hdrs, {"result": {"status": "active"}} if "cloudflare" in url else {}
    return None, {}, {"error": "no answer"}
kr._http = fake_http
NOW = datetime(2026, 10, 16, 12, 0, tzinfo=timezone.utc)
def run_main(args, stdin=""):
    out, err = io.StringIO(), io.StringIO()
    sys.stdin = io.StringIO(stdin)
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = kr.main(args)
    return rc, out.getvalue(), err.getvalue()
def tree_text():
    """Every file the script could have written to, as one string, to search for a value."""
    t = []
    for root in (os.path.expanduser("~/.config/od"), os.path.expanduser("~/knowledge-os")):
        for d, _, fs in os.walk(root):
            for f in fs:
                p = os.path.join(d, f)
                if os.path.basename(p) in ("airtable_pat", "github_pat", "gmail_send_key"):
                    continue          # the key files themselves hold values by design
                t.append(open(p, errors="replace").read())
    return "\\n".join(t)
${code}
`;
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: env.h, KEY_REGISTER_WRANGLER: env.w, KEY_REGISTER_GH: env.g },
  }));
}

const read = (p) => execFileSync('/bin/cat', [p], { encoding: 'utf8' });
const tryRead = (p) => { try { return read(p); } catch (e) { return ''; } };

describe('the register: names, places and dates, never a value', () => {
  it('describes every file, finds every Worker and GitHub copy, and is readable by its owner only', () => {
    const env = home();
    const out = py(env, `
kr.seed(kr.discover())
reg = json.load(open(kr.REGISTER))
k = reg["keys"]
print(json.dumps({"mode": oct(os.stat(kr.REGISTER).st_mode & 0o777),
  "kinds": {n: k[n]["kind"] for n in ("airtable_pat", "gmail_send_key", "property_manager_passcode_roy", "ghl_location_id",
                                       "content_engine_mode", "mystery_file", "worker:ANTHROPIC_API_KEY", "worker:PM_PASSCODE", "worker:FROM_EMAIL")},
  "copies": [(c.get("worker") or c["where"], c["secret"]) for c in k["airtable_pat"]["copies"]],
  "anthropic": [c["worker"] for c in k["worker:ANTHROPIC_API_KEY"]["copies"]],
  "valueInRegister": ${JSON.stringify(OLD)} in open(kr.REGISTER).read()}))`);
    expect(out.mode).toBe('0o600');
    expect(out.kinds).toEqual({ airtable_pat: 'key', gmail_send_key: 'shared', property_manager_passcode_roy: 'passcode',
      ghl_location_id: 'id', content_engine_mode: 'setting', mystery_file: 'unknown',
      'worker:ANTHROPIC_API_KEY': 'worker-only', 'worker:PM_PASSCODE': 'passcode', 'worker:FROM_EMAIL': 'setting' });
    expect(out.copies).toEqual([['w1', 'AIRTABLE_PAT'], ['w2', 'AIRTABLE_PAT'], ['github', 'AIRTABLE_PAT']]);
    expect(out.anthropic).toEqual(['w1', 'w2']);           // one Worker-only key, one row, every copy
    expect(out.valueInRegister).toBe(false);
  });
});

describe('the daily check', () => {
  it('green only on a real pass; a refusal is red, no answer is "could not test", never green', () => {
    const env = home();
    const soon = new Date(Date.UTC(2026, 9, 26)).toUTCString().replace('GMT', 'UTC');   // 10 days away
    const out = py(env, `
kr.seed(None, with_readers=False)
res = kr.check(NOW, None)
by = {r["name"]: r for r in res["rows"]}
print(json.dumps({n: [by[n]["status"], by[n]["said"]] for n in ("airtable_pat", "github_pat", "gmail_send_key", "property_manager_passcode_roy", "mystery_file")}))`,
    `{"api.airtable.com": [200, {}], "api.github.com": [200, {"github-authentication-token-expiration": "2026-10-26 23:00:00 UTC"}]}`);
    expect(out.airtable_pat).toEqual(['green', 'works']);
    expect(out.github_pat[0]).toBe('red');                                    // works, but runs out in 10 days
    expect(out.github_pat[1]).toMatch(/^runs out in 10 days \(26 Oct 2026\): renew it now$/);
    expect(out.gmail_send_key[0]).toBe('grey');                               // a key we made: never "green" untested
    expect(out.property_manager_passcode_roy[1]).toBe('a passcode people type: never changed by a script');
    expect(out.mystery_file[0]).toBe('amber');                                // nobody has described it
    void soon;
  });

  it('a rejected key is red; an unreachable service is grey; a readable file is tightened; a missing one is red', () => {
    const env = home();
    chmodSync(join(env.od, 'airtable_pat'), 0o644);
    const out = py(env, `
kr.seed(None, with_readers=False)
os.remove(os.path.join(kr.CONFIG_DIR, "gmail_send_key"))
res = kr.check(NOW, None)
by = {r["name"]: r for r in res["rows"]}
print(json.dumps({"air": [by["airtable_pat"]["status"], by["airtable_pat"]["said"]], "gh": [by["github_pat"]["status"], by["github_pat"]["said"]],
                  "gone": [by["gmail_send_key"]["status"], by["gmail_send_key"]["said"]],
                  "mode": oct(os.stat(os.path.join(kr.CONFIG_DIR, "airtable_pat")).st_mode & 0o777)}))`,
    `{"api.airtable.com": [401, {}]}`);
    expect(out.air).toEqual(['red', 'the service refused it (HTTP 401); other users could read it: tightened to owner-only']);
    expect(out.mode).toBe('0o600');
    expect(out.gh[0]).toBe('grey');
    expect(out.gh[1]).toMatch(/^could not test: could not reach the service/);
    expect(out.gone).toEqual(['red', 'the key file is missing']);
  });

  it('a pasted key left behind for over an hour is deleted and named, never kept', () => {
    const env = home();
    mkdirSync(join(env.od, '.incoming'), { mode: 0o700 });
    writeFileSync(join(env.od, '.incoming', 'key.ABC123'), NEW);
    const out = py(env, `
p = os.path.join(kr.INCOMING, "key.ABC123")
os.utime(p, (NOW.timestamp() - 7200, NOW.timestamp() - 7200))
kr.seed(None, with_readers=False)
res = kr.check(NOW, None)
row = [r for r in res["rows"] if r["name"] == "pasted key"][0]
print(json.dumps({"exists": os.path.exists(p), "status": row["status"], "said": row["said"], "leak": ${JSON.stringify(NEW)} in tree_text()}))`);
    expect(out).toEqual({ exists: false, status: 'red', said: 'a pasted key was left behind and has been deleted (key.ABC123): paste it again', leak: false });
  });

  it('the Estate row is Failed on any red key, says why in one sentence, and carries no value', () => {
    const env = home();
    const out = py(env, `
kr.seed(None, with_readers=False)
kr.discover = lambda: {"workers": {}, "github": [], "errors": []}
row = kr.status_row(NOW)
print(json.dumps({"status": row["status"], "detail": row["detail"], "leak": ${JSON.stringify(OLD)} in row["payload"]}))`,
    `{"api.airtable.com": [401, {}]}`);
    expect(out.status).toBe('Failed');
    expect(out.detail).toMatch(/need fixing \(airtable_pat: the service refused it \(HTTP 401\)/);
    expect(out.leak).toBe(false);
  });
});

describe('Replace a key: one paste, tested first, every copy, never on a command line', () => {
  it('tests the new key, writes it owner-only, pushes it to every copy through stdin, and deletes the pasted file', () => {
    const env = home();
    const out = py(env, `
kr.seed(kr.discover(), with_readers=False)
inc = os.path.join(kr.CONFIG_DIR, ".incoming"); os.makedirs(inc, mode=0o700, exist_ok=True)
pf = os.path.join(inc, "key.XYZ"); open(pf, "w").write(${JSON.stringify(NEW)})
rc, so, se = run_main(["replace", "airtable_pat", "--from-file", pf])
print(json.dumps({"rc": rc, "out": so, "err": se, "pasted": os.path.exists(pf),
  "file": open(os.path.join(kr.CONFIG_DIR, "airtable_pat")).read().strip(),
  "mode": oct(os.stat(os.path.join(kr.CONFIG_DIR, "airtable_pat")).st_mode & 0o777),
  "testedWith": [c["headers"].get("Authorization") == "Bearer " + ${JSON.stringify(NEW)} for c in CALLS],
  "leak": ${JSON.stringify(NEW)} in (so + se + tree_text())}))`, `{"api.airtable.com": [200, {}]}`);
    expect(out.rc).toBe(0);
    expect(out.file).toBe(NEW);
    expect(out.mode).toBe('0o600');
    expect(out.pasted).toBe(false);
    expect(out.testedWith).toEqual([true, true]);            // before the write, and again after it
    expect(out.out).toMatch(/Reached 4 places: the key file on the Mac mini; Worker w1 \(AIRTABLE_PAT\); Worker w2 \(AIRTABLE_PAT\); GitHub \(AIRTABLE_PAT\)/);
    expect(out.leak).toBe(false);
    const argv = read(join(env.h, 'wrangler.argv')) + read(join(env.h, 'gh.argv'));
    expect(argv).not.toContain(NEW);                          // never an argument: ps would show it
    expect(argv).toContain('secret put AIRTABLE_PAT --name w1');
    expect(argv).toContain('secret set AIRTABLE_PAT --repo chaichoong/leadership-dashboard');
    expect(read(join(env.h, 'wrangler.stdin')).split('\n').filter(Boolean)).toEqual([NEW, NEW]);
    expect(read(join(env.h, 'gh.stdin')).trim()).toBe(NEW);
  });

  it('a new key that fails its test changes nothing anywhere, and the pasted file is still deleted', () => {
    const env = home();
    const out = py(env, `
kr.seed(kr.discover(), with_readers=False)
pf = os.path.join(kr.CONFIG_DIR, "pasted"); open(pf, "w").write(${JSON.stringify(NEW)})
rc, so, se = run_main(["replace", "airtable_pat", "--from-file", pf])
print(json.dumps({"rc": rc, "err": se, "pasted": os.path.exists(pf), "file": open(os.path.join(kr.CONFIG_DIR, "airtable_pat")).read().strip()}))`,
    `{"api.airtable.com": [401, {}]}`);
    expect(out.rc).toBe(3);
    expect(out.err).toMatch(/^REFUSED: the new key did not work \(the service refused it \(HTTP 401\)\)\. Nothing was changed/);
    expect(out.file).toBe(OLD);
    expect(out.pasted).toBe(false);
    expect(tryRead(join(env.h, 'wrangler.stdin'))).toBe('');  // no copy was touched
    expect(tryRead(join(env.h, 'gh.stdin'))).toBe('');
  });

  it('refuses a passcode, an id, a setting and a name it does not know; generates only a key we made', () => {
    const env = home();
    const out = py(env, `
kr.seed(kr.discover(), with_readers=False)
res = {}
for name, args in (("property_manager_passcode_roy", ["--stdin"]), ("ghl_location_id", ["--stdin"]), ("nope", ["--stdin"]),
                   ("airtable_pat", ["--generate"])):
    rc, so, se = run_main(["replace", name] + args, stdin="0123456789abcdefghijk")
    res[name] = [rc, se.strip()]
before = open(os.path.join(kr.CONFIG_DIR, "gmail_send_key")).read()
rc, so, se = run_main(["replace", "gmail_send_key", "--generate"])
after = open(os.path.join(kr.CONFIG_DIR, "gmail_send_key")).read()
res["generated"] = [rc, before != after and len(after.strip()) >= 32, after.strip() in (so + se + tree_text())]
print(json.dumps(res))`);
    expect(out.property_manager_passcode_roy).toEqual([2, 'REFUSED: property_manager_passcode_roy is a passcode people type, not a key a script may change.']);
    expect(out.ghl_location_id[0]).toBe(2);
    expect(out.nope).toEqual([2, 'REFUSED: nope is not in the key register. Run seed first.']);
    expect(out.airtable_pat).toEqual([2, 'REFUSED: only a key we made ourselves (shared with a Worker) may be generated here.']);
    expect(out.generated).toEqual([0, true, false]);          // a new value, in place, and never shown
  });

  it('a copy that refuses is named and the run fails; the others still get the new key', () => {
    const env = home();
    writeFileSync(join(env.h, 'wrangler.fail'), '--name w2');
    const out = py(env, `
kr.seed(kr.discover(), with_readers=False)
rc, so, se = run_main(["replace", "airtable_pat", "--stdin"], stdin=${JSON.stringify(NEW)})
print(json.dumps({"rc": rc, "err": se}))`, `{"api.airtable.com": [200, {}]}`);
    expect(out.rc).toBe(4);
    expect(out.err).toMatch(/NOT REACHED \(1\): Worker w2 \(AIRTABLE_PAT\): refused \(exit 1\)/);
    expect(out.err).toMatch(/Reached 3 places/);
  });
});
