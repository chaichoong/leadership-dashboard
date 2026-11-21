// Finding 20261116-agent-dispatch-1333. TopCashback's CloudFront answered 403
// "ERROR Request blocked" to the robot browser on the click-through to
// RightSure, three dry runs on 16 Nov 2026 including one after a four-minute
// wait, while the same route reached Your Details for another house minutes
// earlier. Proved with curl from this Mac on 19 Nov: 200 to a normal Chrome
// user agent, 403 to the byte-identical request carrying "HeadlessChrome", on
// the homepage and the RightSure landing page alike. Two tasks waited on it.
//
// Back-test: every case here fails on the code before the fix, where plainUA
// and dropHeadlessUA do not exist.
import { describe, it, expect } from 'vitest';
import { plainUA, dropHeadlessUA } from '../scripts/agent-browser.js';

const HEADLESS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.7444.0 Safari/537.36';
const PLAIN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.0 Safari/537.36';

function fakeCtx() {
  const calls = { headers: [], init: [] };
  return {
    calls,
    async setExtraHTTPHeaders(h) { calls.headers.push(h); },
    async addInitScript(fn, arg) { calls.init.push(arg); },
  };
}
const fakePage = (ua) => ({ async evaluate() { return ua; } });

describe('a headless run never announces HeadlessChrome', () => {
  it('reads the browser own agent as plain Chrome, version untouched', () => {
    expect(plainUA(HEADLESS)).toBe(PLAIN);
  });

  it('changes nothing it does not have to: a headed run, a blank agent', () => {
    // A pinned version string would go stale; nothing is invented here.
    expect(plainUA(PLAIN)).toBe('');
    expect(plainUA('')).toBe('');
    expect(plainUA(undefined)).toBe('');
  });

  it('puts the plain agent on the CONTEXT header, which is what a CDN reads', async () => {
    const ctx = fakeCtx();
    const got = await dropHeadlessUA(ctx, fakePage(HEADLESS));
    expect(got).toBe(PLAIN);
    // Context-level, so a page this run opens later carries it too.
    expect(ctx.calls.headers).toEqual([{ 'User-Agent': PLAIN }]);
    // navigator's own copy is patched in the same breath, so a site's script
    // and the request it makes cannot disagree.
    expect(ctx.calls.init).toEqual([PLAIN]);
  });

  it('touches nothing on a headed run', async () => {
    const ctx = fakeCtx();
    expect(await dropHeadlessUA(ctx, fakePage(PLAIN))).toBe('');
    expect(ctx.calls.headers).toEqual([]);
    expect(ctx.calls.init).toEqual([]);
  });

  it('is never fatal: an unreadable agent or a refused header leaves the step running', async () => {
    const ctx = fakeCtx();
    const blind = { async evaluate() { throw new Error('page closed'); } };
    expect(await dropHeadlessUA(ctx, blind)).toBe('');

    const refusing = {
      calls: { headers: [], init: [] },
      async setExtraHTTPHeaders() { throw new Error('nope'); },
      async addInitScript() { throw new Error('nope'); },
    };
    expect(await dropHeadlessUA(refusing, fakePage(HEADLESS))).toBe('');
  });
});
