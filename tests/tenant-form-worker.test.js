// The tenant details form's routes on the property-manager Worker (task recrmZTcOHg8vPlZk; Kevin
// approved the plan on 1 Oct 2026). A public page writes a date of birth and a National Insurance
// number to a live record with no login, so the code in the tenant's link is the only key. These
// drive the REAL handler end to end with Airtable stubbed: every name, number and id is invented.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import worker, { cleanTenantAnswers, londonNow, callerKey } from '../workers/property-manager/worker.js';
import { GP, TENANT_LINK, TENANT_ANSWERS } from '../workers/property-manager/fields.mjs';
import { dateKey } from '../workers/property-manager/compute.mjs';

const ORIGIN = 'https://app.operationsdirector.co.uk';
const TENANTS = 'tblX4elTuu01gwBYh';
const ID = 'recTENANTTEST0001';
const OTHER = 'recTENANTTEST0002';
const baseEnv = { AIRTABLE_PAT: 'pat-test', PM_PASSCODE: 'roy-pass', PM_PASSCODE_KEVIN: 'kev-pass', PM_SESSION_SECRET: 'secret-123' };
let env;
const ctx = { waitUntil: () => {} };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const plusDays = (n) => { const d = londonNow(); d.setDate(d.getDate() + n); return dateKey(d); };

let store, writes, uploads, reads;
function row(r) {
  return { id: r.id, fields: { [GP.tenant.name]: r.name, [GP.tenant.notes]: r.notes, [GP.tenant.documents]: r.documents,
    [TENANT_LINK.codeHash]: r.hash, [TENANT_LINK.codeExpires]: r.expires } };
}
beforeEach(() => {
  env = { ...baseEnv };
  store = {
    [ID]: { id: ID, name: 'Sam Example', notes: '[2026-09-01 09:00 Kevin Brittain] earlier note', documents: [], hash: '', expires: '' },
    [OTHER]: { id: OTHER, name: 'Alex Other', notes: '', documents: [], hash: '', expires: '' },
  };
  writes = []; uploads = []; reads = 0;
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'content.airtable.com') {
      uploads.push({ path: u.pathname, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: 'recX', fields: {} }), { status: 200 });
    }
    const key = u.pathname.replace(/^\/v0\/[^/]+\//, '');
    if (key === TENANTS && (!init.method || init.method === 'GET')) {
      reads++;
      const f = u.searchParams.get('filterByFormula') || '';
      let hit;
      if ((hit = f.match(/^\{Tenant Form Code Hash\}='([0-9a-f]{64})'$/))) {
        return new Response(JSON.stringify({ records: Object.values(store).filter(r => r.hash && r.hash === hit[1]).map(row) }), { status: 200 });
      }
      if ((hit = f.match(/^RECORD_ID\(\)='(rec\w+)'$/))) {
        return new Response(JSON.stringify({ records: store[hit[1]] ? [row(store[hit[1]])] : [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected formula ' + f }), { status: 422 });
    }
    const m = key.match(new RegExp(`^${TENANTS}/(rec\\w+)$`));
    if (m && init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      writes.push({ id: m[1], body });
      const r = store[m[1]];
      if (Object.prototype.hasOwnProperty.call(body.fields, TENANT_LINK.codeHash)) r.hash = body.fields[TENANT_LINK.codeHash] || '';
      if (Object.prototype.hasOwnProperty.call(body.fields, TENANT_LINK.codeExpires)) r.expires = body.fields[TENANT_LINK.codeExpires] || '';
      if (body.fields[GP.tenant.notes] != null) r.notes = body.fields[GP.tenant.notes];
      return new Response(JSON.stringify({ id: m[1], fields: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'no stub for ' + key }), { status: 404 });
  });
});

// The tenant's code travels in the JSON body (never a header or the URL, so no request log keeps it).
const call = (path, { method = 'POST', body, code, token, origin = ORIGIN, headers = {} } = {}) => {
  const payload = code !== undefined ? { code, ...(body || {}) } : body;
  return worker.fetch(new Request('https://pm.test' + path, {
    method, body: method === 'GET' || payload === undefined ? undefined : JSON.stringify(payload),
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
  }), env, ctx);
};
const open = (code) => call('/tenant-form/open', { code });
async function signIn(pass = 'roy-pass') {
  return (await (await call('/login', { body: { passcode: pass } })).json()).token;
}
async function makeLink(id = ID) {
  const r = await call('/tenant-form/link', { method: 'POST', body: { tenantId: id }, token: await signIn() });
  const body = await r.json();
  return { status: r.status, body, code: String(body.url || '').split('#c=')[1] };
}
const GONE = /This link is not working/;

describe('making a link (signed in only)', () => {
  it('needs a session; writes only the hash and the expiry, with typecast off; the code is 32 random characters', async () => {
    expect((await call('/tenant-form/link', { method: 'POST', body: { tenantId: ID } })).status).toBe(401);
    expect(writes).toEqual([]);
    const { status, body, code } = await makeLink();
    expect(status).toBe(200);
    expect(body.url).toMatch(/^https:\/\/app\.operationsdirector\.co\.uk\/tenant-details\.html#c=[A-Za-z0-9_-]{32}$/);
    expect(body.firstName).toBe('Sam');
    expect(body.expires).toBe(plusDays(14));
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe(ID);
    expect(writes[0].body).toEqual({ fields: { [TENANT_LINK.codeHash]: sha(code), [TENANT_LINK.codeExpires]: plusDays(14) }, typecast: false });
    // The record keeps the hash, never the code.
    expect(store[ID].hash).not.toContain(code);
    expect((await makeLink()).code).not.toBe(code);
  });
  it('refuses an id that is not a tenant, or not an id at all', async () => {
    expect((await makeLink('recNOTATENANT0001')).status).toBe(400);
    expect((await makeLink("recX') OR TRUE()")).status).toBe(400);
    expect(writes).toEqual([]);
  });
  it('a tenant code is not a session: it opens no signed-in route', async () => {
    const { code } = await makeLink();
    writes = [];
    expect((await call('/tenant-form/link', { method: 'POST', body: { tenantId: OTHER }, token: code })).status).toBe(401);
    expect((await call('/growth-plan', { method: 'GET', token: code })).status).toBe(401);
    expect(writes).toEqual([]);
  });
});

describe('the public read gives a first name and nothing else', () => {
  it('a good code: the first name only, never a saved answer', async () => {
    const { code } = await makeLink();
    const r = await open(code);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, firstName: 'Sam' });
  });
  it('a bad shape, an unknown code, an expired link, a switched-off link and a code two records share all get the same words', async () => {
    const { code } = await makeLink();
    const cases = {};
    cases.none = await call('/tenant-form/open', { body: {} });
    cases.shape = await open(code.slice(0, 31));
    cases.quote = await open("abc'def" + 'x'.repeat(25));
    cases.unknown = await open('A'.repeat(32));
    store[ID].expires = plusDays(-1);
    cases.expired = await open(code);
    store[ID].expires = '';
    cases.noExpiry = await open(code);
    store[ID].expires = plusDays(3);
    store[OTHER].hash = store[ID].hash; store[OTHER].expires = plusDays(3);
    cases.twoMatch = await open(code);
    for (const [k, r] of Object.entries(cases)) {
      expect(r.status, k).toBe(404);
      expect((await r.json()).error, k).toMatch(GONE);
    }
  });
  it('a code of the right shape that this Worker did not make costs no read, from anywhere', async () => {
    const real = (await makeLink()).code;
    // A code made with another secret: right shape, a hash that would even be on a record.
    env.PM_SESSION_SECRET = 'some-other-secret';
    const forged = (await makeLink(OTHER)).code;
    env.PM_SESSION_SECRET = baseEnv.PM_SESSION_SECRET;
    reads = 0;
    expect((await open(forged)).status).toBe(404);
    expect((await open('A'.repeat(32))).status).toBe(404);
    // One character changed in a real code breaks its tag.
    const flipped = real.slice(0, 5) + (real[5] === 'A' ? 'B' : 'A') + real.slice(6);
    expect((await open(flipped)).status).toBe(404);
    expect(reads).toBe(0);
    expect((await open(real)).status).toBe(200);
    expect(reads).toBe(1);
  });
  it('a code of the wrong shape is refused before anything is read', async () => {
    reads = 0;
    for (const code of ['', 'short', "abc'def" + 'x'.repeat(25), 'A'.repeat(33), 'A'.repeat(31) + '.']) {
      expect((await open(code)).status, code).toBe(404);
    }
    expect(reads).toBe(0);
  });
  it('the link still works on its last day', async () => {
    const { code } = await makeLink();
    store[ID].expires = dateKey(londonNow());
    expect((await open(code)).status).toBe(200);
  });
  it('a record the name formula matched but whose hash, read by id, is different is refused', async () => {
    const { code } = await makeLink();
    // As if the field had been renamed and the formula matched another column: the id check stops it.
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      const u = new URL(url);
      if (u.searchParams.get('filterByFormula') && u.searchParams.get('filterByFormula').startsWith('{Tenant Form Code Hash}')) {
        return new Response(JSON.stringify({ records: [{ ...row(store[OTHER]), fields: { ...row(store[OTHER]).fields, [TENANT_LINK.codeHash]: 'f'.repeat(64), [TENANT_LINK.codeExpires]: plusDays(3) } }] }), { status: 200 });
      }
      return realFetch(url, init);
    });
    expect((await open(code)).status).toBe(404);
  });
  it('a new link switches the old one off, and "off" switches the new one off', async () => {
    const first = (await makeLink()).code;
    const second = (await makeLink()).code;
    expect((await open(first)).status).toBe(404);
    expect((await open(second)).status).toBe(200);
    const off = await call('/tenant-form/link/off', { method: 'POST', body: { tenantId: ID }, token: await signIn('kev-pass') });
    expect(off.status).toBe(200);
    expect(writes.at(-1).body).toEqual({ fields: { [TENANT_LINK.codeHash]: null, [TENANT_LINK.codeExpires]: null }, typecast: false });
    expect((await open(second)).status).toBe(404);
    expect((await call('/tenant-form/link/off', { method: 'POST', body: { tenantId: ID } })).status).toBe(401);
  });
});

describe('saving the answers', () => {
  const GOOD = { phone: '07700 900123', email: 'sam@example.com', dob: '1985-04-12', ni: 'ab 12 34 56 c', ucPayDay: '14', household: 'Single',
    otherAdults: '', capExemption: 'None (capped)', ctAccount: 'CT-123', weeklyIncome: '£120.50', weeklySpending: '95', otherBenefits: 'PIP daily living' };

  it('writes the answers, the saved time and one dated Notes line to his own record, typecast off, blanks dropped', async () => {
    const { code } = await makeLink();
    writes = [];
    const r = await call('/tenant-form', { method: 'POST', code, body: { answers: GOOD } });
    expect(r.status).toBe(200);
    expect((await r.json()).saved).toBe(11);
    expect(writes).toHaveLength(1);
    const { id, body } = writes[0];
    expect(id).toBe(ID);
    expect(body.typecast).toBe(false);
    const T = GP.tenant;
    expect(body.fields[T.ni]).toBe('AB123456C');
    expect(body.fields[T.ucPayDay]).toBe(14);
    expect(body.fields[T.weeklyIncome]).toBe(120.5);
    expect(body.fields[T.otherBenefits]).toBe('PIP daily living');
    // A blank answer never reaches the record, so the form cannot wipe what is there.
    expect(Object.prototype.hasOwnProperty.call(body.fields, T.otherAdults)).toBe(false);
    expect(body.fields[T.formLastSaved]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.fields[T.notes]).toMatch(/^\[2026-09-01 09:00 Kevin Brittain\] earlier note\n\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} tenant link\] Tenant details form saved from the tenant's own link: mobile, email, date of birth, National Insurance number, UC payment day, household, benefit cap, council tax account, weekly income, weekly spending, other benefits\.$/);
    // Exactly the allowed answers, the saved time and the note: nothing else.
    const allowed = new Set([...Object.values(TENANT_ANSWERS).map(s => s.id), T.formLastSaved, T.notes]);
    expect(Object.keys(body.fields).filter(k => !allowed.has(k))).toEqual([]);
    // The note carries no value.
    expect(body.fields[T.notes]).not.toMatch(/AB123456C|sam@example/);
    // A second save the same day adds no second line: Tenant Form Last Saved carries the time.
    writes = [];
    expect((await call('/tenant-form', { code, body: { answers: { phone: '07700 900999' } } })).status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(writes[0].body.fields, T.notes)).toBe(false);
    expect(writes[0].body.fields[T.formLastSaved]).toMatch(/^\d{4}-/);
  });

  it('one question the form does not ask refuses the whole save; nothing is written', async () => {
    const { code } = await makeLink();
    writes = [];
    for (const extra of [{ name: 'New Name' }, { [GP.tenant.name]: 'x' }, { idSeen: 'Passport' }, { authoritySigned: true }, { notes: 'x' }, { __proto__: { phone: '1' }, documents: 'x' }]) {
      const r = await call('/tenant-form', { method: 'POST', code, body: { answers: { ...GOOD, ...extra } } });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect(writes).toEqual([]);
  });

  it('a bad or expired code writes nothing, whatever the answers', async () => {
    const { code } = await makeLink();
    writes = [];
    expect((await call('/tenant-form', { method: 'POST', code: 'B'.repeat(32), body: { answers: GOOD } })).status).toBe(404);
    store[ID].expires = plusDays(-1);
    expect((await call('/tenant-form', { method: 'POST', code, body: { answers: GOOD } })).status).toBe(404);
    expect(writes).toEqual([]);
  });

  it('the rate limit answers before any read or write', async () => {
    const { code } = await makeLink();
    writes = []; reads = 0;
    env.TENANT_LIMIT = { limit: async () => ({ success: false }) };
    const r = await call('/tenant-form', { code, body: { answers: GOOD } });
    expect(r.status).toBe(429);
    expect([reads, writes.length]).toEqual([0, 0]);
    // A caller already refused uses up no slot everyone shares.
    let shared = 0;
    env.TENANT_ALL = { limit: async () => { shared++; return { success: true }; } };
    expect((await open(code)).status).toBe(429);
    expect(shared).toBe(0);
    // Nor does a made-up code from a caller still within his own limit.
    env.TENANT_LIMIT = { limit: async () => ({ success: true }) };
    expect((await open('A'.repeat(32))).status).toBe(404);
    expect(shared).toBe(0);
    expect((await open(code)).status).toBe(200);
    expect(shared).toBe(1);
    reads = 0;
    // And the limit on all callers together, whoever is asking.
    const asked = [];
    env.TENANT_LIMIT = { limit: async ({ key }) => { asked.push(key); return { success: true }; } };
    env.TENANT_ALL = { limit: async () => ({ success: false }) };
    expect((await open(code)).status).toBe(429);
    expect([reads, writes.length]).toEqual([0, 0]);
    env.TENANT_ALL = { limit: async () => ({ success: true }) };
    await worker.fetch(new Request('https://pm.test/tenant-form/open', { method: 'POST', body: JSON.stringify({ code }), headers: { Origin: ORIGIN, 'CF-Connecting-IP': '2001:db8:aa:bb:1:2:3:4' } }), env, ctx);
    // The caller's own limit is asked first, by its /64.
    expect(asked).toEqual(['unknown', '2001:db8:aa:bb::/64']);
  });

  it('a broken body or a missing code uses no shared slot and reads nothing', async () => {
    let shared = 0;
    env.TENANT_LIMIT = { limit: async () => ({ success: true }) };
    env.TENANT_ALL = { limit: async () => { shared++; return { success: true }; } };
    reads = 0;
    const raw = (body) => worker.fetch(new Request('https://pm.test/tenant-form/open', { method: 'POST', body, headers: { Origin: ORIGIN, 'Content-Type': 'application/json' } }), env, ctx);
    expect((await raw('not json')).status).toBe(400);
    for (const body of ['null', '7', '{}', '{"code":null}', '{"code":["x"]}']) expect((await raw(body)).status, body).toBe(404);
    expect([shared, reads]).toEqual([0, 0]);
  });

  it('a public route never retries a refused Airtable call', async () => {
    const { code } = await makeLink();
    let hits = 0;
    globalThis.fetch = vi.fn(async () => { hits++; return new Response('{}', { status: 429 }); });
    const r = await open(code);
    expect(r.status).toBe(502);
    expect(hits).toBe(1);
  });

  it('an oversize request is refused before anything is read', async () => {
    const { code } = await makeLink();
    reads = 0;
    const r = await call('/tenant-form/upload', { code, body: { file: 'x' }, headers: { 'Content-Length': String(6 * 1024 * 1024 + 1) } });
    expect(r.status).toBe(413);
    expect(reads).toBe(0);
  });

  it('the link\'s days are London days, whatever the clock', async () => {
    vi.useFakeTimers();
    try {
      // 23:30 UTC on 4 Oct is 00:30 on 5 Oct in London (summer time).
      vi.setSystemTime(new Date('2026-10-04T23:30:00Z'));
      const { code, body } = await makeLink();
      expect(body.expires).toBe('2026-10-19');
      store[ID].expires = '2026-10-04';
      expect((await open(code)).status).toBe(404);
      store[ID].expires = '2026-10-05';
      expect((await open(code)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the code from the body and nowhere else', async () => {
    // The code is read from the body only: in a header, in the URL or by GET it opens nothing.
    const { code } = await makeLink();
    const viaHeader = await worker.fetch(new Request('https://pm.test/tenant-form/open', { method: 'POST', body: '{}', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Tenant-Code': code } }), env, ctx);
    expect(viaHeader.status).toBe(404);
    const viaUrl = await worker.fetch(new Request('https://pm.test/tenant-form/open?code=' + code, { method: 'POST', body: '{}', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' } }), env, ctx);
    expect(viaUrl.status).toBe(404);
    expect((await call('/tenant-form', { method: 'GET' })).status).toBe(404);
  });
});

describe('who counts as one caller', () => {
  it('an IPv4 address is itself; an IPv6 address counts by its /64, however it is written', () => {
    expect(callerKey('203.0.113.9')).toBe('203.0.113.9');
    expect(callerKey('2001:db8:aa:bb:1:2:3:4')).toBe('2001:db8:aa:bb::/64');
    expect(callerKey('2001:db8:aa:bb:9:9:9:9')).toBe(callerKey('2001:db8:aa:bb:1:2:3:4'));
    // Shortened forms are expanded first, so one /64 is one caller.
    expect(callerKey('2001:db8::1')).toBe(callerKey('2001:db8::2'));
    expect(callerKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(callerKey('2001:db8:1::5')).toBe(callerKey('2001:db8:1:0:5:6:7:8'));
    expect(callerKey('2001:0DB8:0000:0001::9')).toBe('2001:db8:0:1::/64');
    // IPv4 written as IPv6 is that IPv4 address.
    expect(callerKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(callerKey('')).toBe('unknown');
  });
});

describe('the answer rules', () => {
  const one = (k, v) => cleanTenantAnswers({ [k]: v });
  it('refuses what does not look right, in words a tenant can act on', () => {
    expect(one('ni', 'AB123456')).toHaveProperty('error');
    expect(one('ni', 'AB123456E')).toHaveProperty('error');
    expect(one('dob', '1900-01-01')).toHaveProperty('error');
    expect(one('dob', '2015-01-01')).toHaveProperty('error');
    expect(one('dob', '1985-02-30')).toHaveProperty('error');
    expect(one('ucPayDay', '0')).toHaveProperty('error');
    expect(one('ucPayDay', '32')).toHaveProperty('error');
    expect(one('ucPayDay', '3.5')).toHaveProperty('error');
    expect(one('weeklyIncome', '-1')).toHaveProperty('error');
    expect(one('weeklyIncome', '5000.01')).toHaveProperty('error');
    expect(one('weeklyIncome', 'lots')).toHaveProperty('error');
    expect(one('household', 'single')).toHaveProperty('error');
    // A tenant never replaces a known answer with Unknown.
    expect(one('capExemption', 'Unknown')).toHaveProperty('error');
    expect(one('email', 'not-an-email')).toHaveProperty('error');
    expect(one('phone', '12345')).toHaveProperty('error');
    expect(one('phone', '0770090012<script>')).toHaveProperty('error');
    expect(one('otherBenefits', 'x'.repeat(1001))).toHaveProperty('error');
    expect(one('ctAccount', 'x'.repeat(41))).toHaveProperty('error');
    expect(one('phone', { a: 1 })).toHaveProperty('error');
    expect(cleanTenantAnswers({})).toHaveProperty('error');
    expect(cleanTenantAnswers(null)).toHaveProperty('error');
    expect(cleanTenantAnswers(['phone'])).toHaveProperty('error');
    expect(cleanTenantAnswers({ phone: '   ' })).toEqual({ error: 'Nothing was filled in.' });
  });
  it('accepts the spellings a tenant types', () => {
    expect(one('ni', 'ab 12 34 56 d').fields).toEqual({ [GP.tenant.ni]: 'AB123456D' });
    expect(one('weeklyIncome', '£1,200').fields).toEqual({ [GP.tenant.weeklyIncome]: 1200 });
    expect(one('phone', '+44 (0)7700 900123').fields).toEqual({ [GP.tenant.phone]: '+44 (0)7700 900123' });
    expect(one('dob', '1985-04-12').fields).toEqual({ [GP.tenant.dob]: '1985-04-12' });
  });
});

describe('the statement photo', () => {
  const JPEG = [0xFF, 0xD8, 0xFF, 0xE0];
  const b64 = (n, head = JPEG) => Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, n - head.length), 7)]).toString('base64');
  it('goes to his own documents field only, named as a tenant upload', async () => {
    const { code } = await makeLink();
    writes = [];
    const r = await call('/tenant-form/upload', { method: 'POST', code, body: { filename: '../../IMG_0001.jpg', contentType: 'image/jpeg', file: b64(1000) } });
    expect(r.status).toBe(200);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toBe(`/v0/appnqjDpqDniH3IRl/${ID}/${GP.tenant.documents}/uploadAttachment`);
    expect(uploads[0].body.contentType).toBe('image/jpeg');
    expect(uploads[0].body.filename).toMatch(/^Tenant upload \d{4}-\d{2}-\d{2} IMG_0001\.jpg$/);
    // The stored name always ends in the type's own extension.
    expect((await call('/tenant-form/upload', { code, body: { filename: 'page.html', contentType: 'image/jpeg', file: b64(100) } })).status).toBe(200);
    expect(uploads[1].body.filename).toMatch(/^Tenant upload \d{4}-\d{2}-\d{2} page\.jpg$/);
    expect(writes).toEqual([]);
  });
  it('refuses another type, a file over 3.7MB, junk, and an eleventh file', async () => {
    const { code } = await makeLink();
    const up = (body) => call('/tenant-form/upload', { method: 'POST', code, body });
    expect((await up({ filename: 'a.html', contentType: 'text/html', file: b64(10) })).status).toBe(400);
    expect((await up({ filename: 'a.svg', contentType: 'image/svg+xml', file: b64(10) })).status).toBe(400);
    expect((await up({ filename: 'a.jpg', contentType: 'image/jpeg', file: b64(Math.floor(3.7 * 1024 * 1024) + 1) })).status).toBe(413);
    expect((await up({ filename: 'a.jpg', contentType: 'image/jpeg', file: 'not base64!' })).status).toBe(400);
    // A page called a photo: the bytes are not what the type says.
    expect((await up({ filename: 'x.png', contentType: 'image/png', file: Buffer.from('<html><script>x</script></html>').toString('base64') })).status).toBe(400);
    expect((await up({ filename: 'x.pdf', contentType: 'application/pdf', file: b64(100) })).status).toBe(400);
    // Each allowed type with its own first bytes goes through.
    expect((await up({ filename: 'x.png', contentType: 'image/png', file: b64(100, [0x89, 0x50, 0x4E, 0x47]) })).status).toBe(200);
    expect((await up({ filename: 'x.pdf', contentType: 'application/pdf', file: b64(100, [0x25, 0x50, 0x44, 0x46]) })).status).toBe(200);
    expect((await up({ filename: 'x.heic', contentType: 'image/heic', file: b64(100, [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]) })).status).toBe(200);
    uploads.length = 0;
    store[ID].documents = Array.from({ length: 10 }, (_, i) => ({ id: 'att' + i }));
    expect((await up({ filename: 'a.jpg', contentType: 'image/jpeg', file: b64(10) })).status).toBe(409);
    expect(uploads).toEqual([]);
  });
  it('a bad code uploads nothing', async () => {
    expect((await call('/tenant-form/upload', { method: 'POST', code: 'C'.repeat(32), body: { filename: 'a.jpg', contentType: 'image/jpeg', file: b64(10) } })).status).toBe(404);
    expect(uploads).toEqual([]);
  });
});

describe('no page ever reads the link', () => {
  it('the hash and the expiry are Worker-only: not in the Growth Plan field map, so neither page reads them', async () => {
    const { readFileSync } = await import('node:fs');
    const config = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
    expect(Object.values(GP.tenant)).not.toContain(TENANT_LINK.codeHash);
    expect(Object.values(GP.tenant)).not.toContain(TENANT_LINK.codeExpires);
    // config.js names them only in a comment, never as a field a page asks for.
    expect(config).not.toMatch(new RegExp(`:\\s*'${TENANT_LINK.codeHash}'`));
    expect(config).not.toMatch(new RegExp(`:\\s*'${TENANT_LINK.codeExpires}'`));
  });
});
