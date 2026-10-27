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
//   5. A save that fails AFTER a hide flush never puts its older change back over the newer one.
//   6. When the person is removed from the list, their unsaved changes are dropped, never sent.
//   7. Untick an hour whose tick is still on its way (a flush the page was shown again before):
//      the server ends with the hour absent, as the page shows.
//   8. During a back-off, "Save now", the page shown again and switching person all wait.
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
  const other = { id: 2, name: 'Test Bob', venues: ['si', 'pdl', 'pp'], savedAt: null };
  const store = { votes: new Map(), bodies: [], times: [], inflight: 0, maxInflight: 0 };
  store.removePerson = () => { store.gone = true; };
  // The hours a person has ticked on the server (votes are keyed by person and hour).
  store.ticks = (pid = 1) => [...store.votes.values()].filter((v) => v.person_id === pid).map((v) => v.slot).sort();
  const state = () => {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const availability = assembleAvailability(
      { readAt: at, goodAt: { si: at, pdl: at }, venues: { si: {}, pdl: {} } },
      { fetchedAt: at, goodAt: at, days: {} },
    );
    return computeState({ people: store.gone ? [other] : [person, other], votes: [...store.votes.values()], booked: [], availability, dates: londonDates(now), nowMs: now });
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
      if (store.gone && body.person_id === 1) return reply(route, 404, { error: 'No such person' });
      const status = voteStatuses.shift();
      store.inflight++;
      store.maxInflight = Math.max(store.maxInflight, store.inflight);
      if (voteDelayMs) await sleep(voteDelayMs);
      if (status && status !== 200) { store.inflight--; return reply(route, status, { error: status === 429 ? 'slow down' : 'boom' }); }
      for (const slot of body.add || []) store.votes.set(`${body.person_id}|${slot}`, { person_id: body.person_id, slot });
      for (const slot of body.remove || []) store.votes.delete(`${body.person_id}|${slot}`);
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
    await expect.poll(() => store.ticks()).toEqual([`${day}|19`, `${day}|20`]);
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
    await expect.poll(() => store.ticks(), { timeout: 10000 }).toEqual([`${day}|19`, `${day}|20`]);
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
    await expect.poll(() => store.ticks(), { timeout: 5000 }).toEqual([`${day}|19`, `${day}|20`]);

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
    await expect.poll(() => store.ticks().includes(`${day}|19`), { timeout: 20000 }).toBe(true);
    expect(store.bodies).toHaveLength(2);
    expect(store.times[1] - store.times[0]).toBeGreaterThanOrEqual(9500);
  });

  test('a save that fails after a hide flush never brings back the hour the flush removed', async ({ page }) => {
    // The first save (adding 19:00) is slow and then fails; meanwhile 19:00 is unticked and the page hidden.
    const store = await mockPadel(page, { voteDelayMs: 1500, voteStatuses: [500] });
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);   // the add is out
    await tap(page, `${day}|19`);                                          // untick while it is out
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(2);
    expect(store.bodies[1]).toMatchObject({ add: [], remove: [`${day}|19`] });
    // Past the failure, the 5 s retry and the flush's own reply: the server must not hold 19:00.
    await sleep(8000);
    expect(store.ticks().includes(`${day}|19`)).toBe(false);
    expect(store.bodies.slice(2).some((b) => (b.add || []).includes(`${day}|19`))).toBe(false);
  });

  test('a person removed from the list loses their unsaved changes; they are never sent, not even as the next person', async ({ page }) => {
    const store = await mockPadel(page);
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    store.removePerson();
    await page.evaluate(() => document.getElementById('retry').click());   // the page reads the state again
    await expect(page.locator('#pick')).toBeVisible();
    await page.locator('[data-person="2"]').click();                      // someone else picks their name
    await page.locator(`[data-day="${day}"]`).click();
    expect(await pressed(page, `${day}|19`)).toBe('false');                // Test Ann's tick is not shown as theirs
    await tap(page, `${day}|20`);                                          // and their own tap goes alone
    await expect.poll(() => store.bodies.length, { timeout: 3000 }).toBe(1);
    expect(store.bodies[0]).toEqual({ person_id: 2, add: [`${day}|20`], remove: [] });
    expect(store.ticks(2)).toEqual([`${day}|20`]);
    expect(store.ticks(1)).toEqual([]);
  });

  test('a removed person\'s failing save (404) shows the name list instead of "check your signal"', async ({ page }) => {
    const store = await mockPadel(page);
    const day = await openAsTestAnn(page);
    store.removePerson();                                                   // removed before the save lands
    await tap(page, `${day}|19`);
    await expect(page.locator('#pick')).toBeVisible({ timeout: 4000 });
    expect(await page.locator('#unsaved').isHidden()).toBe(true);
    expect(store.bodies).toHaveLength(1);
    expect(store.ticks(1)).toEqual([]);
  });

  test('S2: untick an hour while its flush is still landing: the server ends with it absent, as the page shows', async ({ page }) => {
    // The first save (add A) is slow and then fails. The page is hidden (the flush carries add A),
    // shown again before the flush's reply, and A is unticked.
    const store = await mockPadel(page, { voteDelayMs: 1500, voteStatuses: [500] });
    const day = await openAsTestAnn(page);
    const A = `${day}|19`;
    await tap(page, A);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(2);   // the flush is out
    await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
    await tap(page, A);                                                        // untick, before the flush lands
    expect(await pressed(page, A)).toBe('false');
    await sleep(10000);                                                        // the failure, the 5 s retry, its reply
    expect(store.ticks()).toEqual([]);
    expect(await pressed(page, A)).toBe('false');
  });

  test('during a back-off, "Save now", the page shown again and switching person all wait', async ({ page }) => {
    test.setTimeout(45000);
    const store = await mockPadel(page, { voteStatuses: [429] });
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    await expect.poll(() => store.bodies.length, { timeout: 3000 }).toBe(1);   // refused with 429: 10 s back-off
    await sleep(300);
    await page.evaluate(() => document.getElementById('save-now').click());    // "Save now"
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // the page shown again
    await page.locator('#switch').click();                                      // switching person
    await sleep(2000);
    expect(store.bodies).toHaveLength(1);                                       // none of them went early
    await expect(page.locator('#who')).toBeVisible();                           // the switch waited: still Test Ann
    await expect(page.locator('#who-name')).toHaveText('Test Ann');
    await expect.poll(() => store.ticks(), { timeout: 15000 }).toEqual([`${day}|19`]);
    expect(store.times[1] - store.times[0]).toBeGreaterThanOrEqual(9500);
  });
});
