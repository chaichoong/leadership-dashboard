import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// scripts/ebay-search.py (approved build recDPkv36UXe8QDD9, finding 20261116-agent-dispatch-1331).
// eBay blocks the robot browser and the page fetch route, so the sourcing card said NOT CHECKED for
// the most obvious second-hand seller there is. The proper route is eBay's Browse API.
//
// Every test here drives the real script against a stub server standing in eBay's place, so no
// request ever leaves the machine and no real key is read. The keys are invented.
//
// The stub runs as its own process (tests/helpers/ebay-stub-server.js): the script is driven with
// execFileSync, which blocks Node's event loop, so a server created in here could never answer.
//
// THE RULE UNDER TEST ABOVE ALL OTHERS: a failure says NOT CHECKED, never "no results". A blocked
// page's silence written on a card as "nothing found" is the mistake this build exists to end.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts', 'ebay-search.py');
const STUB = resolve(ROOT, 'tests', 'helpers', 'ebay-stub-server.js');
const APP_ID = 'KevinBri-brittain-PRD-0123456789-01234567';
const CERT_ID = 'PRD-0123456789ab-cdef-4321-9876-543210fedcba';

let child;
let base;
let planPath;
let callsPath;

// The answers the stub gives next. Written to disk, because the stub is another process.
function setPlan(p) {
  writeFileSync(planPath, JSON.stringify(p));
  writeFileSync(callsPath, '');
}
const calls = () => readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ebay-stub-'));
  planPath = join(dir, 'plan.json');
  callsPath = join(dir, 'calls.jsonl');
  setPlan({ token: { status: 200, body: {} }, search: { status: 200, body: {} } });
  child = spawn('node', [STUB, planPath, callsPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((done, fail) => {
    let buf = '';
    child.stdout.on('data', (c) => {
      buf += c;
      const m = /PORT=(\d+)/.exec(buf);
      if (m) done(Number(m[1]));
    });
    child.on('exit', (code) => fail(new Error('the eBay stub server exited with ' + code)));
  });
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => { if (child) child.kill(); });

function home({ appId = APP_ID, certId = CERT_ID, keys = true } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'ebay-'));
  const od = join(h, '.config', 'od');
  mkdirSync(od, { recursive: true });
  if (keys) {
    for (const [n, v] of [['ebay_app_id', appId], ['ebay_cert_id', certId]]) {
      writeFileSync(join(od, n), v + '\n');
      chmodSync(join(od, n), 0o600);
    }
  }
  return h;
}

// (exit code, stdout, stderr) for one run. Never throws on a non-zero exit: the exit code is the test.
function run(args, h = home(), apiBase = base) {
  writeFileSync(callsPath, '');
  try {
    const out = execFileSync('/usr/bin/python3', [SCRIPT, ...args], {
      encoding: 'utf8', env: { ...process.env, HOME: h, EBAY_API_BASE: apiBase },
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status, out: e.stdout || '', err: e.stderr || '' };
  }
}

const GOOD_TOKEN = { status: 200, body: { access_token: 'tok-abc', expires_in: 7200, token_type: 'Application' } };
const TWO_ITEMS = {
  status: 200,
  body: {
    total: 2,
    itemSummaries: [
      { title: 'Bosch washing machine 8kg', price: { value: '149.99', currency: 'GBP' },
        condition: 'Used', itemWebUrl: 'https://www.ebay.co.uk/itm/111',
        itemLocation: { city: 'Haverhill', postalCode: 'CB9', country: 'GB' },
        shippingOptions: [{ shippingCost: { value: '0.0', currency: 'GBP' } }] },
      { title: 'Hotpoint washer', price: { value: '85.00', currency: 'GBP' },
        condition: 'Used', itemWebUrl: 'https://www.ebay.co.uk/itm/222',
        itemLocation: { city: 'Cambridge', country: 'GB' },
        shippingOptions: [{ shippingCost: { value: '12.50', currency: 'GBP' }, shippingCostType: 'FIXED' }] },
    ],
  },
};

describe('the search itself', () => {
  it('asks eBay for an application token with the two keys, searches the UK marketplace, and prints title, price, postage, location and link', () => {
    setPlan({ token: GOOD_TOKEN, search: TWO_ITEMS });
    const r = run(['--q', 'washing machine', '--max-price', '150', '--condition', 'used']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Bosch washing machine 8kg');
    expect(r.out).toContain('£149.99');
    expect(r.out).toContain('postage free');
    expect(r.out).toContain('Haverhill, CB9, GB');
    expect(r.out).toContain('https://www.ebay.co.uk/itm/111');
    expect(r.out).toContain('postage £12.50');
    expect(r.out).toMatch(/^2 results for 'washing machine' on eBay UK:/m);

    // The token request: client credentials, the public read scope, the keys in a Basic header only.
    const tokenCall = calls().find((c) => c.url.startsWith('/identity'));
    expect(tokenCall.method).toBe('POST');
    expect(tokenCall.body).toContain('grant_type=client_credentials');
    expect(tokenCall.body).toContain(encodeURIComponent('https://api.ebay.com/oauth/api_scope'));
    expect(tokenCall.headers.authorization).toBe(
      'Basic ' + Buffer.from(`${APP_ID}:${CERT_ID}`).toString('base64'));

    // The search: the Browse API, the bearer token, UK marketplace, and the filters we asked for.
    const call = calls().find((c) => c.url.startsWith('/buy/browse/v1/item_summary/search'));
    expect(call.headers.authorization).toBe('Bearer tok-abc');
    expect(call.headers['x-ebay-c-marketplace-id']).toBe('EBAY_GB');
    const filter = decodeURIComponent(new URL(base + call.url).searchParams.get('filter'));
    expect(filter).toContain('itemLocationCountry:GB');
    expect(filter).toContain('deliveryCountry:GB');
    expect(filter).toContain('price:[..150]');
    expect(filter).toContain('priceCurrency:GBP');
    expect(filter).toContain('conditions:{USED}');
    expect(new URL(base + call.url).searchParams.get('q')).toBe('washing machine');
  });

  it('a postcode asks eBay for collection near the property, and tells it where the buyer is', () => {
    setPlan({ token: GOOD_TOKEN, search: TWO_ITEMS });
    const r = run(['--q', 'fridge', '--postcode', 'cb9 8pu', '--radius', '15']);
    expect(r.code).toBe(0);
    const call = calls().find((c) => c.url.startsWith('/buy/browse'));
    const filter = decodeURIComponent(new URL(base + call.url).searchParams.get('filter'));
    expect(filter).toContain('pickupCountry:GB');
    expect(filter).toContain('pickupPostalCode:CB9 8PU');
    expect(filter).toContain('pickupRadius:15');
    expect(filter).toContain('pickupRadiusUnit:mi');
    expect(call.headers['x-ebay-c-enduserctx']).toContain('zip%3DCB9%208PU');
  });

  it('--json carries the same rows as data for the sourcing card', () => {
    setPlan({ token: GOOD_TOKEN, search: TWO_ITEMS });
    const r = run(['--q', 'washer', '--json']);
    expect(r.code).toBe(0);
    const d = JSON.parse(r.out);
    expect(d.count).toBe(2);
    expect(d.marketplace).toBe('EBAY_GB');
    expect(d.results[0]).toEqual({ title: 'Bosch washing machine 8kg', price: '£149.99', postage: 'free',
      condition: 'Used', location: 'Haverhill, CB9, GB', link: 'https://www.ebay.co.uk/itm/111' });
  });

  it('no key value ever reaches stdout or stderr', () => {
    setPlan({ token: GOOD_TOKEN, search: TWO_ITEMS });
    const r = run(['--q', 'washer']);
    expect(r.out + r.err).not.toContain(CERT_ID);
    expect(r.out + r.err).not.toContain(APP_ID);
  });
});

describe('zero results is a real answer, not a failure', () => {
  it('says 0 results and exits 0, and never says NOT CHECKED', () => {
    setPlan({ token: GOOD_TOKEN, search: { status: 200, body: { total: 0, itemSummaries: [] } } });
    const r = run(['--q', 'nothing like this exists']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('0 results');
    expect(r.out + r.err).not.toContain('NOT CHECKED');
  });

  it('an answer with total 0 and no itemSummaries at all is still 0 results (eBay leaves the key out)', () => {
    setPlan({ token: GOOD_TOKEN, search: { status: 200, body: { total: 0, href: '...' } } });
    const r = run(['--q', 'nothing']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('0 results');
  });
});

describe('every failure says NOT CHECKED, never "no results"', () => {
  const notChecked = (r) => {
    expect(r.code).toBe(2);
    expect(r.err).toContain('NOT CHECKED');
    expect(r.out).toBe('');                       // nothing on stdout to mistake for a result
    expect(r.err).not.toContain('0 results');
  };

  it('the keys are not there yet (Kevin has not pasted the Cert ID)', () => {
    setPlan({ token: GOOD_TOKEN, search: TWO_ITEMS });
    const r = run(['--q', 'washer'], home({ keys: false }));
    notChecked(r);
    expect(r.err).toContain('ebay_app_id');
    expect(calls().length).toBe(0);                  // nothing was asked of eBay at all
  });

  it('eBay refuses the keys', () => {
    setPlan({ token: { status: 401, body: { errors: [{ errorId: 1001, message: 'invalid client' }] } }, search: TWO_ITEMS });
    notChecked(run(['--q', 'washer']));
  });

  it('eBay answers the search 200 with an error body: that is an error, never an empty result', () => {
    // The converse of "a wrong query still returns 200" (CLAUDE.md, finding 20261104-phase-2-1187):
    // reading a body with no itemSummaries and no total as zero gives a confident wrong answer.
    setPlan({ token: GOOD_TOKEN, search: { status: 200, body: { warnings: [{ errorId: 12001 }] } } });
    const r = run(['--q', 'washer']);
    notChecked(r);
    expect(r.err).toContain('error, not an empty result');
  });

  it('eBay answers the search 500, or something that is not JSON', () => {
    setPlan({ token: GOOD_TOKEN, search: { status: 500, body: {} } });
    notChecked(run(['--q', 'washer']));
    setPlan({ token: GOOD_TOKEN, search: { status: 200, body: 'Pardon our interruption' } });
    notChecked(run(['--q', 'washer']));
  });

  it('eBay cannot be reached at all', () => {
    const r = run(['--q', 'washer'], home(), 'http://127.0.0.1:1');
    notChecked(r);
    expect(r.err).toContain('could not be reached');
  });

  it('a town typed where a postcode belongs, and an unknown condition, are refused rather than quietly dropped', () => {
    setPlan({ token: GOOD_TOKEN, search: TWO_ITEMS });
    notChecked(run(['--q', 'washer', '--postcode', 'Haverhill']));
    notChecked(run(['--q', 'washer', '--condition', 'refurbished']));
    notChecked(run(['--q', '']));
  });
});

describe('the script policies itself', () => {
  it('passes its own selftest', () => {
    const out = execFileSync('/usr/bin/python3', [SCRIPT, 'selftest'], { encoding: 'utf8' });
    expect(out).toContain('selftest OK');
  });
});
