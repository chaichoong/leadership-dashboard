// THE PADEL PAGE SHOWS THE TRUTH (workers/padel/public/index.html, 27 Oct 2026).
//
// THE INVARIANT: after every reply, what the page shows = the server's truth in that reply + the
// changes not yet sent. A save sends CHANGES ("add these hours, remove those"), never the whole
// list. A failed save is never put back: the page reads the truth again, and the person sees
// what is really saved. No save goes while a hide-flush is unconfirmed, and only the save that
// owns the in-flight promise can unlock the next one.
//
// The cases:
//   1. Two ticks survive a reload (they reached the server).
//   2. A tap while a save is in flight is not lost: one save at a time.
//   3. Tap then untap before the save cancels out: nothing is sent.
//   4. Hiding the page sends the unsent changes at once, even while a save is in flight.
//   5. A save refused with 429 shows the truth (not ticked); a new tap waits out the 429's 10 s.
//   6. A save that fails after a hide flush never brings back the hour the flush removed.
//   7. A removed person's unsaved changes are dropped, never sent as the next person's.
//   8. A removed person's save answering 404 shows the name list.
//   9. S2: untick an hour while its flush is still landing: server and page agree.
//  10. During a back-off, "Save now", the page shown again and switching person all wait.
//  11. Review finding 1: a save applied on the server but answered 500, then untapped inside the
//      back-off: server and page agree after the retry.
//  12. Review finding 2: S2 with the flush taking 9 s: server and page agree once it lands.
//  13. Review finding 6: a removed person's slow 404 arriving after the next person started
//      saving does not unlock the next person's saves.
//
// The page is the real file served by the suite's static server; /api/** is mocked by an
// in-memory store that applies the page's changes, and its state is built by the Worker's own
// computeState, so the page reads the shape the live Worker sends.

const { test, expect } = require('@playwright/test');
const { computeState, londonDates, assembleAvailability } = require('../../workers/padel/padel.js');

const KEY = '0123456789abcdef0123';
const PAGE = '/workers/padel/public/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// voteDelayMs: a number, or a function of the request number (0, 1, ...).
// voteStatuses: one per request in order; 'applied-500' applies the change and then answers 500.
async function mockPadel(page, { voteDelayMs = 0, voteStatuses = [] } = {}) {
  const person = { id: 1, name: 'Test Ann', venues: ['si', 'pdl', 'pp'], savedAt: null };
  const other = { id: 2, name: 'Test Bob', venues: ['si', 'pdl', 'pp'], savedAt: null };
  const store = { votes: new Map(), bodies: [], times: [], answered: 0, inflight: 0, maxInflight: 0, inflightBy: {}, maxInflightBy: {} };
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
      const i = store.bodies.length;
      store.bodies.push(body);
      store.times.push(Date.now());
      const status = voteStatuses[i];
      const pid = body.person_id;
      store.inflight++;
      store.inflightBy[pid] = (store.inflightBy[pid] || 0) + 1;
      store.maxInflight = Math.max(store.maxInflight, store.inflight);
      store.maxInflightBy[pid] = Math.max(store.maxInflightBy[pid] || 0, store.inflightBy[pid]);
      const delay = typeof voteDelayMs === 'function' ? voteDelayMs(i) : voteDelayMs;
      if (delay) await sleep(delay);
      store.inflight--;
      store.inflightBy[pid]--;
      store.answered++;
      if (store.gone && pid === 1) return reply(route, 404, { error: 'No such person' });
      const apply = () => {
        for (const slot of body.add || []) store.votes.set(`${pid}|${slot}`, { person_id: pid, slot });
        for (const slot of body.remove || []) store.votes.delete(`${pid}|${slot}`);
      };
      if (status === 'applied-500') { apply(); return reply(route, 500, { error: 'boom after the write' }); }
      if (status && status !== 200) return reply(route, status, { error: status === 429 ? 'slow down' : 'boom' });
      apply();
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
const hide = (page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
const show = (page) => page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
// Server and page agree on an hour: ticked on both, or on neither.
async function agree(page, store, slot) {
  expect(await pressed(page, slot)).toBe(String(store.ticks().includes(slot)));
}

test.describe('padel page: shown = server truth + unsent changes', () => {
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

  test('hiding the page with unsent changes sends them at once, even while a save is in flight', async ({ page }) => {
    const store = await mockPadel(page, { voteDelayMs: 1500 });
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);   // the 19:00 save is out
    await tap(page, `${day}|20`);
    const before = store.bodies.length;
    await hide(page);
    // Sent straight away, carrying the in-flight 19:00 too (the browser cancels it on close).
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(before + 1);
    expect(store.bodies[before].add.sort()).toEqual([`${day}|19`, `${day}|20`]);
    await expect.poll(() => store.ticks(), { timeout: 5000 }).toEqual([`${day}|19`, `${day}|20`]);

    // pagehide (the tab closing) sends them too.
    await page.evaluate(() => { delete document.visibilityState; });
    await sleep(300);
    await tap(page, `${day}|21`);
    const n = store.bodies.length;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(n + 1);
    expect(store.bodies[n].add).toEqual([`${day}|21`]);
  });

  test('a save refused with 429 shows the truth; a new tap waits out the 429\'s 10 s', async ({ page }) => {
    test.setTimeout(45000);
    const store = await mockPadel(page, { voteStatuses: [429] });
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    await expect.poll(() => store.bodies.length, { timeout: 3000 }).toBe(1);
    await expect.poll(() => pressed(page, `${day}|19`), { timeout: 3000 }).toBe('false');   // not saved: shown as not saved
    await tap(page, `${day}|19`);
    await expect.poll(() => store.ticks().includes(`${day}|19`), { timeout: 20000 }).toBe(true);
    expect(store.bodies).toHaveLength(2);
    expect(store.times[1] - store.times[0]).toBeGreaterThanOrEqual(9500);
  });

  test('a save that fails after a hide flush never brings back the hour the flush removed', async ({ page }) => {
    const store = await mockPadel(page, { voteDelayMs: 1500, voteStatuses: [500] });
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);   // the add is out
    await tap(page, `${day}|19`);                                          // untick while it is out
    await hide(page);
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(2);
    expect(store.bodies[1]).toMatchObject({ add: [], remove: [`${day}|19`] });
    await sleep(8000);
    expect(store.ticks().includes(`${day}|19`)).toBe(false);
    expect(store.bodies.slice(2).some((b) => (b.add || []).includes(`${day}|19`))).toBe(false);
    await agree(page, store, `${day}|19`);
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
    expect(await pressed(page, `${day}|19`)).toBe('false');
    await tap(page, `${day}|20`);
    await expect.poll(() => store.bodies.length, { timeout: 3000 }).toBe(1);
    expect(store.bodies[0]).toEqual({ person_id: 2, add: [`${day}|20`], remove: [] });
    expect(store.ticks(2)).toEqual([`${day}|20`]);
    expect(store.ticks(1)).toEqual([]);
  });

  test('a removed person\'s failing save (404) shows the name list instead of "check your signal"', async ({ page }) => {
    const store = await mockPadel(page);
    const day = await openAsTestAnn(page);
    store.removePerson();
    await tap(page, `${day}|19`);
    await expect(page.locator('#pick')).toBeVisible({ timeout: 4000 });
    expect(await page.locator('#unsaved').isHidden()).toBe(true);
    expect(store.bodies).toHaveLength(1);
    expect(store.ticks(1)).toEqual([]);
  });

  test('S2: untick an hour while its flush is still landing: the server ends with it absent, as the page shows', async ({ page }) => {
    const store = await mockPadel(page, { voteDelayMs: 1500, voteStatuses: [500] });
    const day = await openAsTestAnn(page);
    const A = `${day}|19`;
    await tap(page, A);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);
    await hide(page);
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(2);   // the flush is out
    await show(page);
    await tap(page, A);                                                        // untick, before the flush lands
    expect(await pressed(page, A)).toBe('false');
    await sleep(10000);
    expect(store.ticks()).toEqual([]);
    await agree(page, store, A);
  });

  test('during a back-off, "Save now", the page shown again and switching person all wait', async ({ page }) => {
    test.setTimeout(45000);
    const store = await mockPadel(page, { voteStatuses: [429] });
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    await expect.poll(() => store.bodies.length, { timeout: 3000 }).toBe(1);   // refused with 429: 10 s back-off
    await expect.poll(() => pressed(page, `${day}|19`), { timeout: 3000 }).toBe('false');
    await tap(page, `${day}|19`);                                               // tapped again: unsent, waiting
    await page.evaluate(() => document.getElementById('save-now').click());    // "Save now"
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // the page shown again
    await page.locator('#switch').click();                                      // switching person
    await sleep(2000);
    expect(store.bodies).toHaveLength(1);                                       // none of them went early
    await expect(page.locator('#who-name')).toHaveText('Test Ann');            // the switch waited
    await expect.poll(() => store.ticks(), { timeout: 15000 }).toEqual([`${day}|19`]);
    expect(store.times[1] - store.times[0]).toBeGreaterThanOrEqual(9500);
  });

  test('finding 1: a save applied on the server but answered 500, untapped inside the back-off: server and page agree', async ({ page }) => {
    test.setTimeout(45000);
    const store = await mockPadel(page, { voteStatuses: ['applied-500'] });
    const day = await openAsTestAnn(page);
    const A = `${day}|19`;
    await tap(page, A);
    await expect.poll(() => store.bodies.length, { timeout: 3000 }).toBe(1);
    // The failure is not put back: the page reads the truth, and the server did apply it.
    await expect.poll(() => pressed(page, A), { timeout: 3000 }).toBe('true');
    await agree(page, store, A);
    await tap(page, A);                                                        // untick inside the 5 s back-off
    expect(await pressed(page, A)).toBe('false');
    await expect.poll(() => store.bodies.length, { timeout: 10000 }).toBe(2);
    expect(store.bodies[1]).toMatchObject({ add: [], remove: [A] });
    expect(store.times[1] - store.times[0]).toBeGreaterThanOrEqual(4500);
    await sleep(500);
    expect(store.ticks()).toEqual([]);
    await agree(page, store, A);
  });

  test('finding 2: S2 with the flush taking 9 s: server and page agree once it lands', async ({ page }) => {
    test.setTimeout(45000);
    // Request 0 (the save) is slow and fails; request 1 (the flush) takes 9 s.
    const store = await mockPadel(page, { voteDelayMs: (i) => (i === 0 ? 1500 : i === 1 ? 9000 : 0), voteStatuses: [500] });
    const day = await openAsTestAnn(page);
    const A = `${day}|19`;
    await tap(page, A);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);
    await hide(page);
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(2);
    await show(page);
    await tap(page, A);
    expect(await pressed(page, A)).toBe('false');
    await sleep(3000);
    expect(store.bodies).toHaveLength(2);                                      // no save while the flush is unconfirmed
    await expect.poll(() => store.bodies.length, { timeout: 15000 }).toBe(3); // the remove, after the flush answered
    expect(store.bodies[2]).toMatchObject({ add: [], remove: [A] });
    expect(store.times[2] - store.times[1]).toBeGreaterThanOrEqual(9000);       // never before the flush landed
    await expect.poll(() => store.inflight, { timeout: 15000 }).toBe(0);       // every request has landed
    await sleep(500);
    expect(store.ticks()).toEqual([]);
    await agree(page, store, A);
  });

  test('finding 6: a removed person\'s slow 404 arriving after the next person started saving does not unlock their saves', async ({ page }) => {
    test.setTimeout(45000);
    // Test Ann's save (request 0) answers in 3 s, Test Bob's first save (request 1) in 6 s.
    const store = await mockPadel(page, { voteDelayMs: (i) => (i === 0 ? 3000 : i === 1 ? 6000 : 0) });
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);       // Test Ann's save is out (it will 404)
    store.removePerson();
    await page.evaluate(() => document.getElementById('retry').click());
    await expect(page.locator('#pick')).toBeVisible();
    await page.locator('[data-person="2"]').click();
    await page.locator(`[data-day="${day}"]`).click();
    await tap(page, `${day}|20`);
    await expect.poll(() => store.inflightBy[2] || 0, { timeout: 3000 }).toBe(1);   // Test Bob's save is out
    await expect.poll(() => store.answered, { timeout: 6000 }).toBe(1);       // Test Ann's 404 has landed
    expect(store.inflightBy[2]).toBe(1);                                       // inside Test Bob's save
    await tap(page, `${day}|21`);                                              // must wait behind Bob's save
    await expect.poll(() => store.ticks(2), { timeout: 15000 }).toEqual([`${day}|20`, `${day}|21`]);
    expect(store.maxInflightBy[2]).toBe(1);
    expect(store.ticks(1)).toEqual([]);
  });
});
