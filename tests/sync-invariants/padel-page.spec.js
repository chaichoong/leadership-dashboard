// THE PADEL PAGE NEVER LOSES A TICK (workers/padel/public/index.html, 27 Oct 2026).
//
// The third review found the page's kept-ticks copy could drop a tick: tap 19:00, its save goes
// out, tap 20:00, close the tab. The fix makes every save a CHANGE ("add these hours, remove
// those") instead of the whole list, so a save can be repeated, sent late or sent alongside
// another without harm, and the page sends its unsaved changes with keepalive when it is hidden.
//
// The invariants:
//   1. Two ticks survive a reload (they reached the server).
//   2. A tap while a save is in flight is not lost: one save at a time, and the follow-up save
//      carries the second tap.
//   3. Hiding the page with unsaved ticks sends them at once, even while a save is in flight.
//   4. A 429 holds the retry for its own 10 s, never the shorter 5 s back-off.
//
// The page is the real file served by the suite's static server; /api/** is mocked by an
// in-memory store that applies the page's changes, and its state is built by the Worker's own
// computeState, so the page reads the shape the live Worker sends.

const { test, expect } = require('@playwright/test');
const { computeState, londonDates, assembleAvailability } = require('../../workers/padel/padel.js');

const KEY = '0123456789abcdef0123';
const PAGE = '/workers/padel/public/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mockPadel(page, { voteDelayMs = 0, voteStatuses = [] } = {}) {
  const person = { id: 1, name: 'Test Ann', venues: ['si', 'pdl', 'pp'], savedAt: null };
  const store = { votes: new Map(), bodies: [], times: [], inflight: 0, maxInflight: 0 };
  const state = () => {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const availability = assembleAvailability(
      { readAt: at, goodAt: { si: at, pdl: at }, venues: { si: {}, pdl: {} } },
      { fetchedAt: at, goodAt: at, days: {} },
    );
    return computeState({ people: [person], votes: [...store.votes.values()], booked: [], availability, dates: londonDates(now), nowMs: now });
  };
  const reply = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.headers()['x-group-key'] !== KEY) return reply(route, 401, { error: 'This link needs the group code. Ask Kevin.' });
    if (path === '/api/state') return reply(route, 200, state());
    if (path === '/api/vote') {
      const body = req.postDataJSON();
      store.bodies.push(body);
      store.times.push(Date.now());
      const status = voteStatuses.shift();
      if (status && status !== 200) return reply(route, status, { error: status === 429 ? 'slow down' : 'boom' });
      store.inflight++;
      store.maxInflight = Math.max(store.maxInflight, store.inflight);
      if (voteDelayMs) await sleep(voteDelayMs);
      for (const slot of body.add || []) store.votes.set(slot, { person_id: body.person_id, slot });
      for (const slot of body.remove || []) store.votes.delete(slot);
      person.savedAt = new Date().toISOString();
      store.inflight--;
      return reply(route, 200, state());
    }
    return reply(route, 404, { error: 'Not found' });
  });
  return store;
}

async function openAsTestAnn(page) {
  await page.addInitScript(() => { localStorage.setItem('padel.person', '1'); });
  await page.goto(`${PAGE}#k=${KEY}`);
  const tomorrow = londonDates(Date.now())[1];
  await page.locator(`[data-day="${tomorrow}"]`).click();
  return tomorrow;
}
const tap = (page, slot) => page.locator(`[data-slot="${slot}"]`).click();
const pressed = (page, slot) => page.locator(`[data-slot="${slot}"]`).getAttribute('aria-pressed');

test.describe('padel page: ticks reach the server', () => {
  test('two ticks survive a reload', async ({ page }) => {
    const store = await mockPadel(page);
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    await tap(page, `${day}|20`);
    await expect.poll(() => [...store.votes.keys()].sort()).toEqual([`${day}|19`, `${day}|20`]);
    await page.reload();
    await page.locator(`[data-day="${day}"]`).click();
    expect(await pressed(page, `${day}|19`)).toBe('true');
    expect(await pressed(page, `${day}|20`)).toBe('true');
  });

  test('a tap while a save is in flight ends with both ticks on the server, one save at a time', async ({ page }) => {
    const store = await mockPadel(page, { voteDelayMs: 1500 });
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);   // the 19:00 save is out
    await tap(page, `${day}|20`);
    await expect.poll(() => [...store.votes.keys()].sort(), { timeout: 10000 }).toEqual([`${day}|19`, `${day}|20`]);
    expect(store.maxInflight).toBe(1);
    expect(store.bodies.map((b) => [b.add, b.remove])).toEqual([[[`${day}|19`], []], [[`${day}|20`], []]]);
    expect(await pressed(page, `${day}|19`)).toBe('true');
    expect(await pressed(page, `${day}|20`)).toBe('true');
  });

  test('tap then untap before the save cancels out: nothing is sent', async ({ page }) => {
    const store = await mockPadel(page);
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    await tap(page, `${day}|19`);
    await sleep(1500);
    expect(store.bodies).toEqual([]);
  });

  test('hiding the page with unsaved ticks sends them at once, even while a save is in flight', async ({ page }) => {
    const store = await mockPadel(page, { voteDelayMs: 1500 });
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);   // the 19:00 save is out
    await tap(page, `${day}|20`);
    const before = store.bodies.length;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Sent straight away (not after the 800 ms wait, not after the save in flight), and it carries
    // both the in-flight 19:00 and the new 20:00, because the browser cancels the in-flight save on close.
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(before + 1);
    expect(store.bodies[before].add.sort()).toEqual([`${day}|19`, `${day}|20`]);
    await expect.poll(() => [...store.votes.keys()].sort(), { timeout: 5000 }).toEqual([`${day}|19`, `${day}|20`]);

    // pagehide (the tab closing) sends them too.
    await page.evaluate(() => { delete document.visibilityState; });
    await tap(page, `${day}|21`);
    const n = store.bodies.length;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(n + 1);
    expect(store.bodies[n].add).toEqual([`${day}|21`]);
  });

  test('a save refused with 429 waits the 429\'s 10 s before trying again, not the 5 s back-off', async ({ page }) => {
    test.setTimeout(45000);
    const store = await mockPadel(page, { voteStatuses: [429] });
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    await expect.poll(() => store.votes.has(`${day}|19`), { timeout: 20000 }).toBe(true);
    expect(store.bodies).toHaveLength(2);
    expect(store.times[1] - store.times[0]).toBeGreaterThanOrEqual(9500);
  });
});
