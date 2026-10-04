// The tenant details form's routes on the property-manager Worker (task recrmZTcOHg8vPlZk; Kevin
// approved the plan on 1 Oct 2026). A public page writes a date of birth and a National Insurance
// number to a live record with no login, so the code in the tenant's link is the only key. These
// drive the REAL handler end to end with Airtable stubbed: every name, number and id is invented.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import worker, { cleanTenantAnswers, londonNow } from '../workers/property-manager/worker.js';
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

const call = (path, { method = 'GET', body, code, token, origin = ORIGIN, headers = {} } = {}) => worker.fetch(new Request('https://pm.test' + path, {
  method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { Origin: origin, 'Content-Type': 'application/json', ...(code !== undefined ? { 'X-Tenant-Code': code } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
}), env, ctx);
async function signIn(pass = 'roy-pass') {
  return (await (await call('/login', { method: 'POST', body: { passcode: pass } })).json()).token;
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
    expect((await call('/growth-plan', { token: code })).status).toBe(401);
    expect(writes).toEqual([]);
  });
});

describe('the public read gives a first name and nothing else', () => {
  it('a good code: the first name only, never a saved answer', async () => {
    const { code } = await makeLink();
    const r = await call('/tenant-form', { code });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, firstName: 'Sam' });
  });
  it('a bad shape, an unknown code, an expired link, a switched-off link and a code two records share all get the same words', async () => {
    const { code } = await makeLink();
    const cases = {};
    cases.none = await call('/tenant-form', {});
    cases.shape = await call('/tenant-form', { code: code.slice(0, 31) });
    cases.quote = await call('/tenant-form', { code: "abc'def" + 'x'.repeat(25) });
    cases.unknown = await call('/tenant-form', { code: 'A'.repeat(32) });
    store[ID].expires = plusDays(-1);
    cases.expired = await call('/tenant-form', { code });
    store[ID].expires = '';
    cases.noExpiry = await call('/tenant-form', { code });
    store[ID].expires = plusDays(3);
    store[OTHER].hash = store[ID].hash; store[OTHER].expires = plusDays(3);
    cases.twoMatch = await call('/tenant-form', { code });
    for (const [k, r] of Object.entries(cases)) {
      expect(r.status, k).toBe(404);
      expect((await r.json()).error, k).toMatch(GONE);
    }
  });
  it('a code of the wrong shape is refused before anything is read', async () => {
    reads = 0;
    for (const code of ['', 'short', "abc'def" + 'x'.repeat(25), 'A'.repeat(33), 'A'.repeat(31) + '.']) {
      expect((await call('/tenant-form', { code })).status, code).toBe(404);
    }
    expect(reads).toBe(0);
  });
  it('the link still works on its last day', async () => {
    const { code } = await makeLink();
    store[ID].expires = dateKey(londonNow());
    expect((await call('/tenant-form', { code })).status).toBe(200);
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
    expect((await call('/tenant-form', { code })).status).toBe(404);
  });
  it('a new link switches the old one off, and "off" switches the new one off', async () => {
    const first = (await makeLink()).code;
    const second = (await makeLink()).code;
    expect((await call('/tenant-form', { code: first })).status).toBe(404);
    expect((await call('/tenant-form', { code: second })).status).toBe(200);
    const off = await call('/tenant-form/link/off', { method: 'POST', body: { tenantId: ID }, token: await signIn('kev-pass') });
    expect(off.status).toBe(200);
    expect(writes.at(-1).body).toEqual({ fields: { [TENANT_LINK.codeHash]: null, [TENANT_LINK.codeExpires]: null }, typecast: false });
    expect((await call('/tenant-form', { code: second })).status).toBe(404);
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
    expect(body.fields[T.notes]).toMatch(/^\[2026-09-01 09:00 Kevin Brittain\] earlier note\n\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} tenant link\] Tenant details form saved from the tenant's own link: 11 answers\.$/);
    // Exactly the allowed answers, the saved time and the note: nothing else.
    const allowed = new Set([...Object.values(TENANT_ANSWERS).map(s => s.id), T.formLastSaved, T.notes]);
    expect(Object.keys(body.fields).filter(k => !allowed.has(k))).toEqual([]);
    // The note carries no value.
    expect(body.fields[T.notes]).not.toMatch(/AB123456C|sam@example/);
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
    const r = await call('/tenant-form', { method: 'POST', code, body: { answers: GOOD } });
    expect(r.status).toBe(429);
    expect([reads, writes.length]).toEqual([0, 0]);
  });

  it('lets the page send the tenant code header', async () => {
    const r = await worker.fetch(new Request('https://pm.test/tenant-form', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env, ctx);
    expect(r.headers.get('Access-Control-Allow-Headers')).toMatch(/X-Tenant-Code/);
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
  const b64 = (n) => Buffer.alloc(n, 7).toString('base64');
  it('goes to his own documents field only, named as a tenant upload', async () => {
    const { code } = await makeLink();
    writes = [];
    const r = await call('/tenant-form/upload', { method: 'POST', code, body: { filename: '../../IMG_0001.jpg', contentType: 'image/jpeg', file: b64(1000) } });
    expect(r.status).toBe(200);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toBe(`/v0/appnqjDpqDniH3IRl/${ID}/${GP.tenant.documents}/uploadAttachment`);
    expect(uploads[0].body.contentType).toBe('image/jpeg');
    expect(uploads[0].body.filename).toMatch(/^Tenant upload \d{4}-\d{2}-\d{2} IMG_0001\.jpg$/);
    expect(writes).toEqual([]);
  });
  it('refuses another type, a file over 3.7MB, junk, and an eleventh file', async () => {
    const { code } = await makeLink();
    const up = (body) => call('/tenant-form/upload', { method: 'POST', code, body });
    expect((await up({ filename: 'a.html', contentType: 'text/html', file: b64(10) })).status).toBe(400);
    expect((await up({ filename: 'a.svg', contentType: 'image/svg+xml', file: b64(10) })).status).toBe(400);
    expect((await up({ filename: 'a.jpg', contentType: 'image/jpeg', file: b64(Math.floor(3.7 * 1024 * 1024) + 1) })).status).toBe(413);
    expect((await up({ filename: 'a.jpg', contentType: 'image/jpeg', file: 'not base64!' })).status).toBe(400);
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
