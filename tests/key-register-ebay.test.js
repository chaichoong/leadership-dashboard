import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// The eBay pair in the robots' key register (approved build recDPkv36UXe8QDD9, finding
// 20261116-agent-dispatch-1331).
//
// 18 Nov 2026: Kevin was sent to "+ Replace a key" to paste the eBay Cert ID and there was no eBay
// row in the list, so he had nowhere to paste. "Replace a key" only offers a key the register
// already holds, and the register only held keys whose FILE already existed — and his paste is what
// creates the file. These tests hold that door open: the two eBay rows are listed before either file
// exists, the row is amber (never red) while it waits for him, the App ID can be written before the
// Cert ID arrives, and the Cert ID is tested against eBay before anything is written.
//
// Every run drives the real scripts/key-register.py against a throwaway HOME with a stand-in for
// eBay. No real key is read and no request leaves the machine. The values here are invented.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts', 'key-register.py');
const APP_ID = 'KevinBri-brittain-PRD-0123456789-01234567';
const CERT_ID = 'PRD-0123456789ab-cdef-4321-9876-543210fedcba';

function home() {
  const h = mkdtempSync(join(tmpdir(), 'keyreg-ebay-'));
  const od = join(h, '.config', 'od');
  mkdirSync(od, { recursive: true });
  writeFileSync(join(od, 'airtable_pat'), 'patOLDoldOLDold1234.0123456789abcdefOLD\n');
  chmodSync(join(od, 'airtable_pat'), 0o600);
  return { h, od };
}

// `fake` maps a bit of a URL to the (status, headers) the stand-in answers with. Anything else
// reads "could not reach".
function py(env, code, fake = '{}') {
  const script = `
import importlib.util, json, os, sys, io, contextlib
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location("kr", ${JSON.stringify(SCRIPT)})
kr = importlib.util.module_from_spec(spec); spec.loader.exec_module(kr)
kr.worker_names = lambda repo=None: []
kr.readers_of = lambda name, repo=None: ["scripts/ebay-search.py"]
FAKE = ${fake}
CALLS = []
def fake_http(url, headers=None, data=None, method=None):
    CALLS.append({"url": url, "auth": (headers or {}).get("Authorization", ""), "data": (data or b"").decode()})
    for key, (status, hdrs) in FAKE.items():
        if key in url:
            return status, hdrs, {}
    return None, {}, {"error": "no answer"}
kr._http = fake_http
NOW = datetime(2026, 11, 21, 8, 0, tzinfo=timezone.utc)
def run_main(args, stdin=""):
    out, err = io.StringIO(), io.StringIO()
    sys.stdin = io.StringIO(stdin)
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = kr.main(args)
    return rc, out.getvalue(), err.getvalue()
${code}
`;
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c', script], {
    encoding: 'utf8', env: { ...process.env, HOME: env.h },
  }));
}

describe('the eBay rows exist before the keys do, so Kevin has somewhere to paste', () => {
  it('seed writes both eBay rows with no key file present, and Replace a key lists them', () => {
    const env = home();
    const out = py(env, `
kr.seed(None, with_readers=False)
rc, listed, _ = run_main(["names"])
reg = json.load(open(kr.REGISTER))
print(json.dumps({"rows": sorted(n for n in reg["keys"] if n.startswith("ebay_")),
                  "kinds": {n: reg["keys"][n]["kind"] for n in ("ebay_app_id", "ebay_cert_id")},
                  "offered": sorted(l.split("\\t")[0] for l in listed.splitlines() if l.startswith("ebay_")),
                  "fileOnDisk": os.path.exists(os.path.join(kr.CONFIG_DIR, "ebay_cert_id"))}))`);
    expect(out.rows).toEqual(['ebay_app_id', 'ebay_cert_id']);
    expect(out.kinds).toEqual({ ebay_app_id: 'key', ebay_cert_id: 'key' });
    expect(out.offered).toEqual(['ebay_app_id', 'ebay_cert_id']);     // "+ Replace a key" shows them
    expect(out.fileOnDisk).toBe(false);                               // and no value has been invented
  });

  it('a row still waiting for his paste is amber, never red, and never turns the Estate row Failed', () => {
    const env = home();
    const out = py(env, `
kr.seed(None, with_readers=False)
res = kr.check()
rows = {r["name"]: (r["status"], r["said"]) for r in res["rows"]}
print(json.dumps({"cert": rows["ebay_cert_id"], "red": res["counts"].get("red", 0),
                  "estate": res["estate"]["status"] if isinstance(res.get("estate"), dict) else res.get("status", "")}))`,
      '{"airtable": (200, {})}');
    expect(out.cert[0]).toBe('amber');
    expect(out.cert[1]).toContain('Replace a key');
    expect(out.red).toBe(0);                 // a red row raises a Builder task nobody could act on
  });
});

describe('the two keys arrive one at a time', () => {
  it('the public App ID is written before the Cert ID exists, and says plainly it was not tested yet', () => {
    const env = home();
    const out = py(env, `
kr.seed(None, with_readers=False)
rc, out, err = run_main(["replace", "ebay_app_id", "--stdin"], stdin=${JSON.stringify(APP_ID)} + "\\n")
p = os.path.join(kr.CONFIG_DIR, "ebay_app_id")
print(json.dumps({"rc": rc, "out": out, "err": err, "written": open(p).read().strip() if os.path.exists(p) else None,
                  "calls": [c["url"] for c in CALLS],
                  "tested": json.load(open(kr.REGISTER))["keys"]["ebay_app_id"]["lastReplace"]["tested"]}))`,
      '{"api.ebay.com/identity": (200, {})}');
    expect(out.rc).toBe(0);                           // it is not refused for want of its pair
    expect(out.written).toBe(APP_ID);
    expect(out.out).toContain('not tested yet');
    expect(out.out).toContain('ebay_cert_id');        // and it says which half is still missing
    expect(out.tested).toBe('untestable');
    expect(out.calls).toEqual([]);                    // eBay was never asked: there was nothing to ask it
    expect(out.out + out.err).not.toContain(APP_ID);
  });

  it('once both halves are there, the daily check tests the pair and calls it green', () => {
    const env = home();
    const out = py(env, `
kr.seed(None, with_readers=False)
for n, v in (("ebay_app_id", ${JSON.stringify(APP_ID)}), ("ebay_cert_id", ${JSON.stringify(CERT_ID)})):
    kr.write_private(os.path.join(kr.CONFIG_DIR, n), v + "\\n")
kr.seed(None, with_readers=False)
rows = {r["name"]: (r["status"], r["said"]) for r in kr.check()["rows"]}
print(json.dumps({"app": rows["ebay_app_id"], "cert": rows["ebay_cert_id"],
                  "auths": sorted(set(c["auth"] for c in CALLS if "ebay" in c["url"]))}))`,
      '{"api.ebay.com/identity": (200, {}), "airtable": (200, {})}');
    expect(out.app[0]).toBe('green');
    expect(out.cert[0]).toBe('green');
    expect(out.auths).toEqual(['Basic ' + Buffer.from(`${APP_ID}:${CERT_ID}`).toString('base64')]);
  });
});

describe('Replace a key, for real, with both halves', () => {
  const both = `
kr.seed(None, with_readers=False)
kr.write_private(os.path.join(kr.CONFIG_DIR, "ebay_app_id"), ${JSON.stringify(APP_ID)} + "\\n")
rc, out, err = run_main(["replace", "ebay_cert_id", "--stdin"], stdin=${JSON.stringify(CERT_ID)} + "\\n")
certPath = os.path.join(kr.CONFIG_DIR, "ebay_cert_id")
print(json.dumps({"rc": rc, "out": out, "err": err,
                  "written": open(certPath).read().strip() if os.path.exists(certPath) else None,
                  "calls": CALLS, "register": open(kr.REGISTER).read()}))`;

  it('tests the Cert ID against eBay first, with both keys in one Basic header, then writes it owner-only', () => {
    const env = home();
    const out = py(env, both, '{"api.ebay.com/identity": (200, {})}');
    expect(out.rc).toBe(0);
    expect(out.written).toBe(CERT_ID);
    expect(out.calls.length).toBe(2);                 // tested before the write, and again after it
    expect(out.calls[0].url).toBe('https://api.ebay.com/identity/v1/oauth2/token');
    expect(out.calls[0].data).toContain('grant_type=client_credentials');
    expect(out.calls[0].data).toContain(encodeURIComponent('https://api.ebay.com/oauth/api_scope'));
    expect(out.calls[0].auth).toBe('Basic ' + Buffer.from(`${APP_ID}:${CERT_ID}`).toString('base64'));
    expect(out.out).toContain('the new key works');
    // The rule above all the others: no value in the register, the output or the log.
    expect(out.register).not.toContain(CERT_ID);
    expect(out.out + out.err).not.toContain(CERT_ID);
    expect(out.out + out.err).not.toContain(APP_ID);
  });

  it('a Cert ID eBay refuses changes nothing: the old value stays and no file is written', () => {
    const env = home();
    const out = py(env, both, '{"api.ebay.com/identity": (401, {})}');
    expect(out.rc).toBe(3);
    expect(out.written).toBe(null);
    expect(out.err).toContain('did not work');
    expect(out.err).not.toContain(CERT_ID);
  });

  it('eBay unreachable is "could not judge it", and still changes nothing', () => {
    const env = home();
    const out = py(env, both, '{}');
    expect(out.rc).toBe(3);
    expect(out.written).toBe(null);
  });
});

describe('the pasted file never lingers', () => {
  it('a value pasted into the incoming folder is read once and deleted', () => {
    const env = home();
    const out = py(env, `
kr.seed(None, with_readers=False)
kr.write_private(os.path.join(kr.CONFIG_DIR, "ebay_app_id"), ${JSON.stringify(APP_ID)} + "\\n")
os.makedirs(kr.INCOMING, mode=0o700, exist_ok=True)
pasted = os.path.join(kr.INCOMING, "ebay_cert_id")
kr.write_private(pasted, ${JSON.stringify(CERT_ID)} + "\\n")
rc, out, err = run_main(["replace", "ebay_cert_id", "--from-file", pasted])
print(json.dumps({"rc": rc, "pastedStillThere": os.path.exists(pasted),
                  "written": open(os.path.join(kr.CONFIG_DIR, "ebay_cert_id")).read().strip()}))`,
      '{"api.ebay.com/identity": (200, {})}');
    expect(out.rc).toBe(0);
    expect(out.pastedStillThere).toBe(false);
    expect(out.written).toBe(CERT_ID);
  });
});

describe('the script policies itself', () => {
  it('passes its own selftest, which now covers the awaited eBay rows', () => {
    const out = JSON.parse(execFileSync('/usr/bin/python3', [SCRIPT, 'selftest'], { encoding: 'utf8' }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(14);
  });
});
