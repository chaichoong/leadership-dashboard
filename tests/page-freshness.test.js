import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

// js/page-freshness.js: a tab older than the live page reloads instead of saving a decision
// (Kevin, 7 Oct 2026). The ETag shapes are the ones GitHub Pages sent that day for the live
// AI Agents page: "6ac6757c-7d524", weak (W/) when gzipped, where 0x7d524 = 513316 bytes, the same
// number the browser gave as the page's decoded body. Anything unknown must read as fresh.
const require = createRequire(import.meta.url);
const PF = require('../js/page-freshness.js');

const res = (etag, ok = true) => ({ ok, headers: { get: (k) => (k.toLowerCase() === 'etag' ? etag : null) } });

describe('etagBytes reads the file size out of a GitHub Pages ETag', () => {
  it('strong and weak forms', () => {
    expect(PF.etagBytes('"6ac6757c-7d524"')).toBe(513316);
    expect(PF.etagBytes('W/"6ac6757c-7d524"')).toBe(513316);
  });
  it('any other shape is 0, never a guess', () => {
    for (const e of [null, '', 'W/"abc"', '"33a64df551425fcc55e4d42a148795d9f25f89d4"', 'garbage-12', '"6ac6757c-zz"']) {
      expect(PF.etagBytes(e)).toBe(0);
    }
  });
});

describe('isStale compares the loaded size with the live copy', () => {
  beforeEach(() => {
    PF._reset();
    globalThis.location = { pathname: '/os/agents/index.html', search: '?cb=17', hash: '#approvals' };
    globalThis.sessionStorage = undefined;
  });

  it('a different size is stale, and stays stale without asking again', async () => {
    const calls = [];
    const fetch = async (url, init) => { calls.push([url, init.method, init.cache]); return res('W/"6ac6757c-7d525"'); };
    expect(await PF.isStale({ mine: 513316, fetch })).toBe(true);
    expect(await PF.isStale({ mine: 513316, fetch, force: true })).toBe(true);
    expect(calls).toHaveLength(1);
    // Asked at an address no cache has seen, keeping the page's own parameters (review, 7 Oct 2026).
    expect(calls[0][0]).toMatch(/^\/os\/agents\/index\.html\?cb=17&fresh=\d+#approvals$/);
    expect(calls[0].slice(1)).toEqual(['HEAD', 'no-store']);
  });

  it('a call made while a check is out waits for its answer, never a fresh "no" (review, 7 Oct 2026)', async () => {
    let release;
    const fetch = () => new Promise((r) => { release = () => r(res('W/"6ac6757c-7d525"')); });
    const first = PF.isStale({ mine: 513316, fetch });      // the focus check, still waiting
    const click = PF.isStale({ mine: 513316, fetch });      // the Approve click, 100 ms later
    release();
    expect(await click).toBe(true);
    expect(await first).toBe(true);
  });

  it('still different straight after its own reload: the save goes ahead rather than reload for ever', async () => {
    const KEY = 'page_freshness_reloaded_at:/os/agents/index.html';
    const store = { [KEY]: String(Date.now() - 5000) };
    globalThis.sessionStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
    expect(await PF.isStale({ mine: 513316, fetch: async () => res('W/"6ac6757c-7d525"') })).toBe(false);
    store[KEY] = String(Date.now() - 120000);   // a minute later the check is back on
    expect(await PF.isStale({ mine: 513316, fetch: async () => res('W/"6ac6757c-7d525"'), force: true })).toBe(true);
  });

  it("one page's reload never switches off the other page's check (they share sessionStorage; review round 2)", async () => {
    const store = { 'page_freshness_reloaded_at:/os/agents/index.html': String(Date.now() - 5000) };
    globalThis.sessionStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
    globalThis.location = { pathname: '/os/tasks/index.html', search: '', hash: '' };
    expect(await PF.isStale({ mine: 608599, fetch: async () => res('W/"6ac6757c-94958"') })).toBe(true);
  });

  it('freshUrl keeps every parameter and the hash, and replaces only its own', () => {
    expect(PF.freshUrl({ pathname: '/os/tasks/index.html', search: '?filter=maintenance&fresh=1', hash: '' }, 99))
      .toBe('/os/tasks/index.html?filter=maintenance&fresh=99');
    expect(PF.freshUrl({ pathname: '/p.html', search: '', hash: '#x' }, 5)).toBe('/p.html?fresh=5#x');
  });

  it('the same size is fresh, and the server is asked at most once every ten seconds', async () => {
    let n = 0;
    const fetch = async () => { n++; return res('W/"6ac6757c-7d524"'); };
    expect(await PF.isStale({ mine: 513316, fetch })).toBe(false);
    expect(await PF.isStale({ mine: 513316, fetch })).toBe(false);
    expect(n).toBe(1);
    expect(PF.CHECK_EVERY_MS).toBeLessThanOrEqual(10000);   // a deploy is seen within seconds, not a minute
    expect(await PF.isStale({ mine: 513316, fetch, force: true })).toBe(false);
    expect(n).toBe(2);
  });

  it('unknown reads as fresh: no loaded size, no ETag, a failed response, or no network', async () => {
    expect(await PF.isStale({ mine: 0, fetch: async () => res('"1-2"') })).toBe(false);
    PF._reset();
    expect(await PF.isStale({ mine: 513316, fetch: async () => res(null) })).toBe(false);
    PF._reset();
    expect(await PF.isStale({ mine: 513316, fetch: async () => res('"1-2"', false) })).toBe(false);
    PF._reset();
    expect(await PF.isStale({ mine: 513316, fetch: async () => { throw new Error('offline'); } })).toBe(false);
  });

  it('loadedBytes reads the navigation entry, and 0 when the browser gives none', () => {
    expect(PF.loadedBytes({ getEntriesByType: () => [{ decodedBodySize: 513316 }] })).toBe(513316);
    expect(PF.loadedBytes({ getEntriesByType: () => [] })).toBe(0);
    expect(PF.loadedBytes({ getEntriesByType: () => { throw new Error('no timing'); } })).toBe(0);
  });
});
