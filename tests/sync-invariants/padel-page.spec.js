// THE PADEL PAGE SHOWS THE TRUTH (workers/padel/public/index.html, 27 Oct 2026).
//
// THE INVARIANT: after every reply, what the page shows = the server's truth in that reply + the
// changes not yet sent. A save sends CHANGES ("add these hours, remove those"), never the whole
// list. A failed save is never put back: the page reads the truth again, and the person sees
// what is really saved. Only the save that started alone may clear the back-off, and a late
// answer for a dropped save changes nothing.
//
// Every save goes with keepalive, so a save on its way survives the page being hidden or closed
// and is never sent twice. Hiding or closing the page sends the unsent changes at once.
//
// The cases:
//   1. Two ticks survive a reload (they reached the server).
//   2. A tap while a save is in flight is not lost: one save at a time.
//   3. Tap then untap before the save cancels out: nothing is sent.
//   4. Hiding the page sends the unsent changes at once, alongside a save in flight.
//   5. A save refused with 429 shows the truth (not ticked); a new tap waits out the 429's 10 s.
//   6. A save that fails after a hide-send never brings back the hour the hide-send removed.
//   7. A removed person's unsaved changes are dropped, never sent as the next person's.
//   8. A removed person's save answering 404 shows the name list.
//   9. Untick an hour while its save is out, and that save fails: server and page agree.
//  10. During a back-off, "Save now", the page shown again and switching person all wait.
//  11. A save applied on the server but answered 500, untapped inside the back-off: they agree.
//  12. Tick, untick before the save answers, close the tab: the server ends unticked, two bodies.
//  13. A removed person's slow 404 arriving after the next person started saving does not unlock
//      the next person's saves.
//  14. With the network down: tick, hide inside the debounce, show: unticked plus the toast; a
//      retap saves when the network is back.
//  15. Tap A, hide (A sent), show, tap B, hide and close: the server ends with A and B.
//  16. A save whose reply is older than a Check-now reply still ends with the truth shown.
//  17. A hide-send that fails with the page still open shows the truth and the toast.
//  18. A hide-send reply older than a newer write's reply still ends with the truth shown.
//  19. Every failed save that carried a change shows the toast, not only the first in a row.
//  20. Two overlapping saves (a hide-send during a save in flight): the truth is read again once
//      the last of them lands.
//  21. The day strip shows 14 days; a St Ives day beyond its booking window reads "not open yet".
//  22. No code (Kevin, 27 Oct 2026): the bare address opens straight to the name list with no
//      header sent, and an old #k= link still opens, with the code dropped from the address bar
//      and from this phone's memory.
//
// The page is the real file served by the suite's static server; /api/** is mocked by an
// in-memory store that applies the page's changes, and its state is built by the Worker's own
// computeState, so the page reads the shape the live Worker sends.

const { test, expect } = require('@playwright/test');
const { computeState, londonDates, assembleAvailability } = require('../../workers/padel/padel.js');

const PAGE = '/workers/padel/public/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// voteDelayMs: a number, or a function of the request number (0, 1, ...).
// voteStatuses: one per request in order; 'applied-500' applies the change and then answers 500.
// The phone key the mock Worker accepts (Kevin's phone, 30 Oct 2026): a request carrying it gets admin: true.
const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
async function mockPadel(page, { voteDelayMs = 0, voteStatuses = [], siClosedFrom = null, siFree = null, readyAt = null, crowdAt = null, booked = [], earlier = [] } = {}) {
  const person = { id: 1, name: 'Test Ann', venues: ['si', 'pdl', 'pp'], savedAt: null };
  const other = { id: 2, name: 'Test Bob', venues: ['si', 'pdl', 'pp'], savedAt: null };
  // readyAt 'HH': two more people, and Bob, Cat and Dan already on tomorrow at that hour, so
  // Ann's tick makes four (the Worker's ALERT_AT) and the day turns ready.
  // crowdAt 'HH': six more people, and all eight (Ann too) on tomorrow at that hour: a second court's crowd.
  const PEOPLE = ['Test Cat', 'Test Dan', 'Test Eve', 'Test Fay', 'Test Gus', 'Test Hal'].map((name, i) => ({ id: i + 3, name, venues: ['si', 'pdl', 'pp'], savedAt: null }));
  const extras = crowdAt ? PEOPLE : readyAt ? PEOPLE.slice(0, 2) : [];
  const store = { votes: new Map(), booked: booked.map((b) => ({ ...b })), bookedBodies: [], adminBodies: [], realNames: new Map(), added: [], headers: [], bodies: [], times: [], stateTimes: [], replyTimes: [], answered: 0, inflight: 0, maxInflight: 0, inflightBy: {}, maxInflightBy: {} };
  if (readyAt) {
    const slot = `${londonDates(Date.now())[1]}|${readyAt}`;
    for (const pid of [2, 3, 4]) store.votes.set(`${pid}|${slot}`, { person_id: pid, slot });
  }
  if (crowdAt) {
    const slot = `${londonDates(Date.now())[1]}|${crowdAt}`;
    for (const pid of [1, 2, 3, 4, 5, 6, 7, 8]) store.votes.set(`${pid}|${slot}`, { person_id: pid, slot });
  }
  store.removePerson = () => { store.gone = true; };
  // The hours a person has ticked on the server (votes are keyed by person and hour).
  store.ticks = (pid = 1) => [...store.votes.values()].filter((v) => v.person_id === pid).map((v) => v.slot).sort();
  const state = () => {
    const now = Date.now();
    const at = new Date(now).toISOString();
    // siClosedFrom: St Ives open before that date number, "not open yet" from it. An open day has
    // no court free unless siFree gives its starts ({ 'HH:MM': { courts, min } }, the Worker's shape).
    const si = {};
    if (siClosedFrom !== null) londonDates(now).forEach((d, i) => { si[d] = i >= siClosedFrom ? { status: 'closed' } : { status: 'ok', starts: siFree || {} }; });
    const availability = assembleAvailability(
      { readAt: at, goodAt: { si: at, pdl: at }, venues: { si, pdl: {} } },
      { fetchedAt: at, goodAt: at, days: {} },
    );
    const named = (p) => (store.realNames.has(p.id) ? { ...p, realName: store.realNames.get(p.id) } : p);
    const everyone = (store.gone ? [other, ...extras] : [person, other, ...extras]).concat(store.added);
    return { ...computeState({ people: everyone.map(named), votes: [...store.votes.values()], booked: store.booked, availability, dates: londonDates(now), nowMs: now }), earlier };
  };
  const reply = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (store.offline) return route.abort('internetdisconnected');      // no signal at all
    store.headers.push(req.headers());
    const admin = req.headers()['x-admin-key'] === ADMIN_KEY;
    if (path === '/api/state') { store.stateTimes.push(Date.now()); return reply(route, 200, { ...state(), admin }); }
    if (path === '/api/refresh') return reply(route, 200, { ...state(), refreshed: false, admin });
    if (path === '/api/admin') {                                         // the Worker's admin route, as far as the page uses it
      if (!admin) return reply(route, 401, { error: "Only Kevin's phone can do that" });
      const body = req.postDataJSON();
      store.adminBodies.push(body);
      if (body.action === 'name') { if (body.real_name) store.realNames.set(body.id, body.real_name); else store.realNames.delete(body.id); }
      if (body.action === 'paid') Object.assign(store.booked.find((b) => b.slot === body.slot), { price_pence: Math.round(body.price * 100), players: JSON.stringify(body.players), paid_at: new Date().toISOString() });
      if (body.action === 'retry') { const e = earlier.find((x) => x.slot === body.slot); if (e) e.paid[body.step] = { state: null, at: null, note: null }; }
      return reply(route, 200, { ...state(), admin: true });
    }
    if (path === '/api/person') {                                        // adding a player by name
      const body = req.postDataJSON();
      const p = { id: 100 + store.added.length, name: body.name, venues: ['si', 'pdl', 'pp', 'cu'], savedAt: null };
      store.added.push(p);
      return reply(route, 200, p);
    }
    if (path === '/api/booked') {                                        // the Worker's rule: a detail left out keeps its stored value
      const body = req.postDataJSON();
      store.bookedBodies.push(body);
      const was = store.booked.find((b) => b.slot === body.slot) || {};
      store.booked = store.booked.filter((b) => b.slot !== body.slot);
      if (body.booked === true) store.booked.push({ slot: body.slot, person_id: body.person_id, venue: body.venue, start: body.start ?? was.start ?? null, minutes: body.minutes ?? was.minutes ?? null, courts: body.courts ?? was.courts ?? 1 });
      return reply(route, 200, { ...state(), admin });
    }
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
      store.replyTimes.push(Date.now());
      if (store.gone && pid === 1) return reply(route, 404, { error: 'No such person' });
      const apply = () => {
        for (const slot of body.add || []) store.votes.set(`${pid}|${slot}`, { person_id: pid, slot });
        for (const slot of body.remove || []) store.votes.delete(`${pid}|${slot}`);
      };
      if (status === 'applied-500') { apply(); return reply(route, 500, { error: 'boom after the write' }); }
      if (status && status !== 200) return reply(route, status, { error: status === 429 ? 'slow down' : 'boom' });
      apply();
      return reply(route, 200, { ...state(), admin });
    }
    return reply(route, 404, { error: 'Not found' });
  });
  return store;
}

async function openAsTestAnn(page) {
  await page.addInitScript(() => { localStorage.setItem('padel.person', '1'); });
  await page.goto(PAGE);
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
const close = (page) => page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
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

  test('hiding the page sends the unsent changes at once, alongside a save in flight', async ({ page }) => {
    const store = await mockPadel(page, { voteDelayMs: 1500 });
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);   // the 19:00 save is out
    await tap(page, `${day}|20`);
    const before = store.bodies.length;
    await hide(page);
    // 20:00 goes straight away; 19:00 is not sent again (its own save survives with keepalive).
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(before + 1);
    expect(store.bodies[before]).toMatchObject({ add: [`${day}|20`], remove: [] });
    await expect.poll(() => store.ticks(), { timeout: 5000 }).toEqual([`${day}|19`, `${day}|20`]);
    expect(store.bodies).toHaveLength(2);

    // pagehide (the tab closing) sends too.
    await page.evaluate(() => { delete document.visibilityState; });
    await tap(page, `${day}|21`);
    const n = store.bodies.length;
    await close(page);
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

  test('a save that fails after a hide-send never brings back the hour the hide-send removed', async ({ page }) => {
    const store = await mockPadel(page, { voteDelayMs: 1500, voteStatuses: [500] });
    const day = await openAsTestAnn(page);
    await tap(page, `${day}|19`);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);   // the add is out
    await tap(page, `${day}|19`);                                          // untick while it is out
    await hide(page);                                                      // the remove goes now
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

  test('untick an hour while its save is out, and that save fails: server and page agree', async ({ page }) => {
    const store = await mockPadel(page, { voteDelayMs: 1500, voteStatuses: [500] });
    const day = await openAsTestAnn(page);
    const A = `${day}|19`;
    await tap(page, A);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);
    await hide(page);                                                          // nothing unsent: nothing sent
    await show(page);
    await tap(page, A);                                                        // untick: an explicit remove, unsent
    expect(await pressed(page, A)).toBe('false');
    await sleep(10000);                                                        // the failure, the 5 s retry, its reply
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

  test('tick, untick before the save answers, close the tab: the server ends unticked, two bodies at most', async ({ page }) => {
    const store = await mockPadel(page, { voteDelayMs: 1500 });
    const day = await openAsTestAnn(page);
    const A = `${day}|19`;
    await tap(page, A);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);       // the add is out (keepalive)
    await tap(page, A);                                                        // untick before it answers
    await hide(page);
    await close(page);
    await expect.poll(() => store.inflight, { timeout: 5000 }).toBe(0);
    await sleep(500);
    expect(store.ticks()).toEqual([]);
    expect(store.bodies).toEqual([{ person_id: 1, add: [A], remove: [] }, { person_id: 1, add: [], remove: [A] }]);
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

  test('with the network down: tick, hide inside the debounce, show: unticked plus the toast; a retap saves when it is back', async ({ page }) => {
    test.setTimeout(45000);
    const store = await mockPadel(page);
    const day = await openAsTestAnn(page);
    const A = `${day}|19`;
    await page.evaluate(() => {
      window.__toasts = [];
      const t = document.getElementById('toast');
      new MutationObserver(() => { if (!t.hidden) window.__toasts.push(t.textContent); }).observe(t, { attributes: true, childList: true, subtree: true, characterData: true });
    });
    store.offline = true;
    await tap(page, A);
    await hide(page);                                                          // inside the 800 ms timer
    await show(page);
    await expect.poll(() => pressed(page, A), { timeout: 3000 }).toBe('false');   // the last known truth
    expect(await page.evaluate(() => window.__toasts)).toContain("Couldn't save. The page shows what is saved; tap again to change it.");
    expect(store.ticks()).toEqual([]);
    store.offline = false;
    await tap(page, A);
    await expect.poll(() => store.ticks(), { timeout: 10000 }).toEqual([A]);  // after the 5 s back-off
    expect(await pressed(page, A)).toBe('true');
  });

  test('tap A, hide (A sent), show, tap B, hide and close: the server ends with A and B', async ({ page }) => {
    const store = await mockPadel(page, { voteDelayMs: (i) => (i === 0 ? 5000 : 0) });
    const day = await openAsTestAnn(page);
    const A = `${day}|19`;
    const B = `${day}|20`;
    await tap(page, A);
    await hide(page);                                                          // A goes now, slow
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(1);
    await show(page);
    await tap(page, B);
    await hide(page);                                                          // B goes now, alongside A
    await close(page);
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(2);
    expect(store.bodies[1]).toMatchObject({ add: [B], remove: [] });
    await expect.poll(() => store.ticks(), { timeout: 8000 }).toEqual([A, B]);
    expect(store.bodies).toHaveLength(2);
  });

  test('a save whose reply is older than a Check-now reply still ends with the truth shown', async ({ page }) => {
    const store = await mockPadel(page, { voteDelayMs: 2000 });
    const day = await openAsTestAnn(page);
    const A = `${day}|19`;
    await tap(page, A);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);       // the save is out, slow
    await page.locator('#check-now').click();                                  // a newer reply, taken before the save landed
    await expect.poll(() => store.ticks(), { timeout: 5000 }).toEqual([A]);
    await expect.poll(() => pressed(page, A), { timeout: 3000 }).toBe('true'); // the truth, read again
  });

  test('a hide-send that fails with the page still open shows the truth and the toast', async ({ page }) => {
    const store = await mockPadel(page, { voteStatuses: [500] });
    const day = await openAsTestAnn(page);
    const A = `${day}|19`;
    await page.evaluate(() => {
      window.__toasts = [];
      const t = document.getElementById('toast');
      new MutationObserver(() => { if (!t.hidden) window.__toasts.push(t.textContent); }).observe(t, { attributes: true, childList: true, subtree: true, characterData: true });
    });
    await tap(page, A);
    await hide(page);                                                          // sent now, refused with 500
    await show(page);
    await expect.poll(() => pressed(page, A), { timeout: 3000 }).toBe('false');
    expect(await page.evaluate(() => window.__toasts)).toContain("Couldn't save. The page shows what is saved; tap again to change it.");
    expect(store.ticks()).toEqual([]);
    await agree(page, store, A);
  });

  test('a hide-send reply older than a newer write reply still ends with the truth shown', async ({ page }) => {
    const store = await mockPadel(page, { voteDelayMs: (i) => (i === 0 ? 3000 : 0) });
    const day = await openAsTestAnn(page);
    const A = `${day}|19`;
    await tap(page, A);
    await hide(page);                                                          // A goes now, slow
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(1);
    await show(page);
    await page.locator('#check-now').click();                                  // a newer write reply, taken before A landed
    await expect.poll(() => store.ticks(), { timeout: 6000 }).toEqual([A]);
    await expect.poll(() => pressed(page, A), { timeout: 3000 }).toBe('true'); // the older reply lost: the truth was read
  });

  test('every failed save that carried a change shows the toast, not only the first in a row', async ({ page }) => {
    test.setTimeout(45000);
    const store = await mockPadel(page, { voteStatuses: [429, 429] });
    const day = await openAsTestAnn(page);
    const A = `${day}|19`;
    const B = `${day}|20`;
    await page.evaluate(() => {
      window.__toasts = [];
      const t = document.getElementById('toast');
      new MutationObserver(() => { if (!t.hidden) window.__toasts.push(t.textContent); }).observe(t, { attributes: true, childList: true, subtree: true, characterData: true });
    });
    await tap(page, A);
    await expect.poll(() => store.bodies.length, { timeout: 3000 }).toBe(1);   // refused: 429
    await expect.poll(() => pressed(page, A), { timeout: 3000 }).toBe('false');
    await sleep(5500);
    await page.evaluate(() => { window.__toasts = []; });
    await tap(page, B);
    await hide(page);                                                          // the hide-send, refused again
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(2);
    await show(page);
    await expect.poll(() => pressed(page, B), { timeout: 3000 }).toBe('false');
    expect(await page.evaluate(() => window.__toasts)).toContain("Couldn't save. The page shows what is saved; tap again to change it.");
    expect(store.ticks()).toEqual([]);
  });

  test('two overlapping saves: the truth is read again once the last of them lands', async ({ page }) => {
    // The save of A answers after 1 s; the hide-send of B, sent while A is out, after 2 s.
    const store = await mockPadel(page, { voteDelayMs: (i) => (i === 0 ? 1000 : 2000) });
    const day = await openAsTestAnn(page);
    const A = `${day}|19`;
    const B = `${day}|20`;
    await tap(page, A);
    await expect.poll(() => store.inflight, { timeout: 3000 }).toBe(1);
    await tap(page, B);
    await hide(page);
    await expect.poll(() => store.bodies.length, { timeout: 600 }).toBe(2);
    await expect.poll(() => store.answered, { timeout: 5000 }).toBe(2);
    const lastLanded = Math.max(...store.replyTimes);
    await expect.poll(() => store.stateTimes.some((t) => t >= lastLanded), { timeout: 3000 }).toBe(true);
    await show(page);
    expect(store.ticks()).toEqual([A, B]);
    expect(await pressed(page, A)).toBe('true');
    expect(await pressed(page, B)).toBe('true');
  });

  test('the day strip shows 14 days, and a St Ives day beyond its booking window reads "not open yet"', async ({ page }) => {
    await mockPadel(page, { siClosedFrom: 7 });
    await openAsTestAnn(page);
    const dates = londonDates(Date.now());
    expect(await page.locator('[data-day]').count()).toBe(14);
    expect(await page.locator('[data-day]').evaluateAll((b) => b.map((x) => x.dataset.day))).toEqual(dates);
    await page.locator(`[data-day="${dates[9]}"]`).click();                   // day 10
    await expect(page.locator('#day-note')).toContainText('St Ives: not open yet for this day.');
    const siChip = page.locator(`[data-slot="${dates[9]}|19"]`).locator('xpath=..').locator('.chip').first();
    await expect(siChip).toHaveClass(/striped/);
    await expect(siChip.locator('.sr')).toHaveText('St Ives: not open yet.');
    await page.locator(`[data-day="${dates[1]}"]`).click();                   // day 2: open, no court free
    const busyChip = page.locator(`[data-slot="${dates[1]}|19"]`).locator('xpath=..').locator('.chip').first();
    await expect(busyChip.locator('.sr')).toHaveText('St Ives: no court free.');
    await expect(busyChip).toHaveClass(/busy/);                                // red with a cross (Kevin, 27 Oct 2026)
    await expect(busyChip.locator('[aria-hidden]')).toHaveText('St Ives ✗');
  });

  test('chips are named by place, green with a tick when a court is free; the day strip shows the most people on one hour', async ({ page }) => {
    await mockPadel(page, { siClosedFrom: 7, siFree: { '19:00': { courts: 1, min: 60 } } });
    const tomorrow = await openAsTestAnn(page);
    const chips = page.locator(`[data-slot="${tomorrow}|19"]`).locator('xpath=..').locator('.chip');
    await expect(chips.locator('[aria-hidden]')).toHaveText(['St Ives ✓', /^Cambridge /, /^Huntingdon /, /^Cambridge Uni /]);   // four venues since 29 Oct 2026
    await expect(chips.first()).toHaveClass(/free/);
    await expect(chips.first().locator('.sr')).toHaveText('St Ives: a court free at 19:00 (60 min).');
    await expect(page.locator(`[data-day="${tomorrow}"] small`)).toHaveText('');
    await page.locator(`[data-slot="${tomorrow}|19"]`).click();
    await expect(page.locator(`[data-day="${tomorrow}"] small`)).toHaveText('1 in');
    await expect(page.locator(`[data-day="${tomorrow}"]`)).toHaveAttribute('aria-label', /up to 1 on one hour$/);
  });

  test('four people on an hour with a court free: the day reads "4 in ✓" in green and the Ready panel shows', async ({ page }) => {
    await mockPadel(page, { siClosedFrom: 7, siFree: { '19:00': { courts: 1, min: 60 } }, readyAt: '19' });
    const tomorrow = await openAsTestAnn(page);
    const day = page.locator(`[data-day="${tomorrow}"]`);
    await expect(day.locator('small')).toHaveText('3 in');
    await expect(day).not.toHaveClass(/has-ready/);
    await expect(page.locator('#ready')).toBeHidden();
    await page.locator(`[data-slot="${tomorrow}|19"]`).click();
    await expect(day.locator('small')).toHaveText('4 in ✓');
    await expect(day).toHaveClass(/has-ready/);
    await expect(day).toHaveAttribute('aria-label', /up to 4 on one hour, ready to book$/);
    await expect(page.locator('#ready')).toContainText('Ready to book');
    await expect(page.locator('#ready')).toContainText('St Ives');
  });

  test('a booked day: one Booked line with its details, no Ready entry, "Booked ✓" on the day; a half-hour start names itself on the chip (Kevin, 29 Oct 2026)', async ({ page }) => {
    const tomorrow = londonDates(Date.now())[1];
    await mockPadel(page, { siClosedFrom: 7, siFree: { '19:30': { courts: 2, min: 60, max: 90 } }, readyAt: '19', booked: [{ slot: `${tomorrow}|19`, person_id: 2, venue: 'si', start: '19:30', minutes: 90, courts: 1 }] });
    await openAsTestAnn(page);
    const day = page.locator(`[data-day="${tomorrow}"]`);
    await expect(day.locator('small')).toHaveText('Booked ✓');
    await expect(day).toHaveClass(/has-booked/);
    await page.locator(`[data-slot="${tomorrow}|19"]`).click();      // four in now, but the day is booked: never ready
    await expect(day.locator('small')).toHaveText('Booked ✓');
    await expect(page.locator('#ready')).toBeHidden();
    const row = page.locator('#row-19');
    await expect(row.locator('.booked-line')).toContainText('Booked by Test Bob: St Ives 19:30, 90 min');
    await expect(row.locator('.chip').first().locator('[aria-hidden]')).toHaveText('St Ives ✓2 19:30');
    await expect(row.locator('.chip').first().locator('.sr')).toHaveText('St Ives: 2 courts free at 19:30 (60 to 90 min).');
    await expect(row.locator('[data-mark]')).toHaveCount(0);
  });

  test('the Booked picker: "Booked?" on an hour sends where, from when and for how long; Undo brings the hour back', async ({ page }) => {
    const store = await mockPadel(page, { siClosedFrom: 7, siFree: { '19:00': { courts: 1, min: 60, max: 120 }, '19:30': { courts: 1, min: 60, max: 90 } } });
    const tomorrow = await openAsTestAnn(page);
    const row = page.locator('#row-19');
    await row.locator('[data-mark]').click();
    await expect(row.locator('[data-book-form] select[name="venue"]')).toHaveValue('si');
    await expect(row.locator('[data-book-form] select[name="start"]')).toHaveValue('19:00');
    await expect(row.locator('[data-book-form] select[name="minutes"]')).toHaveValue('60');
    await expect(row.locator('[data-book-form] select[name="minutes"] option[value="120"]')).toHaveText('120 min (free)');
    await row.locator('[data-book-form] select[name="start"]').selectOption('19:30');
    await expect(row.locator('[data-book-form] select[name="minutes"] option[value="120"]')).toHaveText('120 min');   // 90 at most from 19:30
    await row.locator('[data-book-form] select[name="minutes"]').selectOption('90');
    await row.locator('[data-book-form] button[type="submit"]').click();
    await expect(row.locator('.booked-line')).toContainText('Booked by Test Ann: St Ives 19:30, 90 min');
    expect(store.bookedBodies).toEqual([{ slot: `${tomorrow}|19`, person_id: 1, venue: 'si', start: '19:30', minutes: 90, booked: true }]);
    await expect(page.locator(`[data-day="${tomorrow}"] small`)).toHaveText('Booked ✓');
    await row.locator('[data-unbook]').click();
    await expect(row.locator('.booked-line')).toHaveCount(0);
    await expect(row.locator('[data-mark]')).toHaveCount(1);
    await expect(page.locator(`[data-day="${tomorrow}"] small`)).toHaveText('');
  });

  test('the Ready line\'s Booked button opens the picker in view, filled from that line', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await mockPadel(page, { siClosedFrom: 7, siFree: { '19:00': { courts: 1, min: 60, max: 90 } }, readyAt: '19' });
    const tomorrow = await openAsTestAnn(page);
    await page.locator(`[data-slot="${tomorrow}|19"]`).click();
    await expect(page.locator('#ready')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#ready [data-book-slot]').click();
    const form = page.locator('#row-19 [data-book-form]');
    await expect(form).toBeInViewport();
    await expect(form.locator('select[name="venue"]')).toHaveValue('si');
    await expect(form.locator('select[name="start"]')).toHaveValue('19:00');
    await expect(form.locator('select[name="minutes"]')).toHaveValue('60');
  });

  test('eight in and another court free: "Booked 2nd court" keeps the first booker and records two courts', async ({ page }) => {
    const tomorrow = londonDates(Date.now())[1];
    // Marked a minute ago; every mock read is "now", so the read is after the mark and its free court is another one.
    const markedAt = new Date(Date.now() - 60000).toISOString();
    const store = await mockPadel(page, { siClosedFrom: 7, siFree: { '19:00': { courts: 1, min: 60, max: 120 } }, crowdAt: '19', booked: [{ slot: `${tomorrow}|19`, person_id: 2, venue: 'si', start: '19:00', minutes: 60, courts: 1, created_at: markedAt }] });
    await openAsTestAnn(page);
    const row = page.locator('#row-19');
    await expect(row.locator('.second')).toContainText('Second court? 8 can play, and another court is free at St Ives 19:00 for 60 min.');
    await row.locator('[data-book-second]').click();
    await expect(row.locator('.booked-line')).toContainText('Booked by Test Bob: St Ives 19:00, 60 min, 2 courts');
    await expect(row.locator('.second')).toHaveCount(0);
    expect(store.bookedBodies).toEqual([{ slot: `${tomorrow}|19`, person_id: 2, venue: 'si', courts: 2, booked: true }]);
  });

  test('an open picker closes when someone else books that hour first, and never overwrites them', async ({ page }) => {
    const store = await mockPadel(page, { siClosedFrom: 7, siFree: { '19:00': { courts: 1, min: 60 } } });
    const tomorrow = await openAsTestAnn(page);
    const row = page.locator('#row-19');
    await row.locator('[data-mark]').click();
    await expect(row.locator('[data-book-form]')).toBeVisible();
    store.booked.push({ slot: `${tomorrow}|19`, person_id: 2, venue: 'pdl', start: '19:30', minutes: 90, courts: 1 });
    await page.locator('#check-now').click();
    await expect(row.locator('.booked-line')).toContainText('Booked by Test Bob: Cambridge 19:30, 90 min');
    await expect(row.locator('[data-book-form]')).toHaveCount(0);
    expect(store.bookedBodies).toEqual([]);
  });

  test.describe("Kevin's phone: People and Booked and paid (Kevin, 30 Oct 2026)", () => {
    const bookedRow = (tomorrow, extra = {}) => ({ slot: `${tomorrow}|19`, person_id: 2, venue: 'si', start: '19:00', minutes: 60, courts: 1, ...extra });
    test('a phone without the key sees no People screen and no Booked and paid button', async ({ page }) => {
      const tomorrow = londonDates(Date.now())[1];
      await mockPadel(page, { siClosedFrom: 7, siFree: { '19:00': { courts: 1, min: 60 } }, booked: [bookedRow(tomorrow)] });
      await openAsTestAnn(page);
      await expect(page.locator('#row-19 .booked-line')).toBeVisible();
      await expect(page.locator('#people-card')).toBeHidden();
      await expect(page.locator('[data-paid-open]')).toHaveCount(0);
    });

    test('a #admin= link keeps the key on this phone, drops it from the address bar, and opens the People screen; a real name replaces the nickname and its initials', async ({ page }) => {
      const store = await mockPadel(page, { siClosedFrom: 7, readyAt: '19' });
      await page.addInitScript(() => { localStorage.setItem('padel.person', '1'); });
      await page.goto(PAGE + '#admin=' + ADMIN_KEY);
      await expect(page.locator('#people-card')).toBeVisible();
      expect(new URL(page.url()).hash).toBe('');
      expect(await page.evaluate(() => localStorage.getItem('padel.admin'))).toBe(ADMIN_KEY);
      expect(store.headers.some((h) => h['x-admin-key'] === ADMIN_KEY)).toBe(true);
      await page.locator('[data-real-name="2"]').fill('Test Robin');
      await page.locator('[data-rename="2"]').click();
      await expect(page.locator('[data-real-name="2"]')).toHaveValue('Test Robin');   // redrawn from the reply, which carries the real name
      expect(store.adminBodies).toEqual([{ action: 'name', id: 2, real_name: 'Test Robin' }]);
      await page.locator(`[data-day="${londonDates(Date.now())[1]}"]`).click();
      await expect(page.locator('#row-19 .initials')).toContainText('TR');
      // Adding a player by hand.
      await page.locator('#add-player').fill('Test Carl');
      await page.locator('#add-player-form button').click();
      await expect(page.locator('#people-rows')).toContainText('Test Carl');
    });

    test('Booked and paid: the players who said they were in are ticked, the price splits, and Save sends it', async ({ page }) => {
      const tomorrow = londonDates(Date.now())[1];
      const store = await mockPadel(page, { siClosedFrom: 7, siFree: { '19:00': { courts: 1, min: 60 } }, readyAt: '19', booked: [bookedRow(tomorrow)] });
      await page.addInitScript((k) => { localStorage.setItem('padel.person', '1'); localStorage.setItem('padel.admin', k); }, ADMIN_KEY);
      await page.goto(PAGE);
      await page.locator(`[data-day="${tomorrow}"]`).click();
      const row = page.locator('#row-19');
      await row.locator('[data-paid-open]').click();
      const form = row.locator('[data-paid-form]');
      // Bob, Cat and Dan said they were in at 19:00 (Ann has not ticked); Bob booked it.
      await expect(form.locator('[data-paid-player][aria-pressed="true"]')).toHaveText(['Test Bob', 'Test Cat', 'Test Dan']);
      await form.locator('[data-paid-player="1"]').click();             // add Ann
      await form.locator('input[name="price"]').fill('36');
      await expect(form.locator('.note')).toContainText('4 playing, £9.00 each.');
      await form.locator('button[type="submit"]').click();
      await expect(row.locator('[data-paid-form]')).toHaveCount(0);       // the panel closes once it is saved
      await expect(row.locator('.paid-line')).toContainText('Paid £36.00, 4 playing (TB TC TD TA), £9.00 each.');
      await expect(row.locator('.paid-line')).toContainText('Splitwise: waiting');
      await expect(row.locator('.paid-line')).toContainText('Texts: waiting');
      expect(store.adminBodies).toEqual([{ action: 'paid', slot: `${tomorrow}|19`, price: 36, players: [2, 3, 4, 1] }]);
    });

    test('names typed on the People screen survive a redraw; saving one keeps the others (review of PR #858)', async ({ page }) => {
      await mockPadel(page, { siClosedFrom: 7, readyAt: '19' });
      await page.addInitScript((k) => { localStorage.setItem('padel.person', '1'); localStorage.setItem('padel.admin', k); }, ADMIN_KEY);
      await page.goto(PAGE);
      await page.locator('[data-real-name="3"]').fill('Test Cathy');
      await page.locator('[data-real-name="2"]').fill('Test Robin');
      await page.locator('[data-rename="2"]').click();
      await expect(page.locator('[data-real-name="2"]')).toHaveValue('Test Robin');
      await expect(page.locator('[data-real-name="3"]')).toHaveValue('Test Cathy');   // not saved, not lost
    });

    test('Kevin\'s phone lists last night\'s unfinished booking with Retry; once the robot has started there is no Undo (review of PR #858)', async ({ page }) => {
      const tomorrow = londonDates(Date.now())[1];
      const yesterday = new Date(Date.parse(`${londonDates(Date.now())[0]}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
      const store = await mockPadel(page, {
        siClosedFrom: 7,
        booked: [bookedRow(tomorrow, { price_pence: 3600, players: '[1,2]', paid_at: new Date().toISOString(), splitwise_state: 'claimed' })],
        earlier: [{ slot: `${yesterday}|20`, day: 'Earlier day', venue: 'Cambridge', start: '20:00', minutes: 60, paid: { price: 3000, players: [1, 2], at: 'x', splitwise: { state: 'failed', at: 'x', note: 'n' }, texts: { state: null, at: null, note: null } } }],
      });
      await page.addInitScript((k) => { localStorage.setItem('padel.person', '1'); localStorage.setItem('padel.admin', k); }, ADMIN_KEY);
      await page.goto(PAGE);
      const earlier = page.locator('#earlier');
      await expect(earlier).toContainText('Earlier day, Cambridge 20:00');
      await expect(earlier).toContainText("Splitwise: couldn't add");
      await earlier.locator('[data-retry]').click();
      expect(store.adminBodies).toEqual([{ action: 'retry', slot: `${yesterday}|20`, step: 'splitwise' }]);
      await page.locator(`[data-day="${tomorrow}"]`).click();
      await expect(page.locator('#row-19 .paid-line')).toContainText('Splitwise: adding now');
      await expect(page.locator('#row-19 [data-unbook]')).toHaveCount(0);
      await expect(page.locator('#row-19 [data-paid-open]')).toHaveCount(0);
    });

    test('a paid booking shows its status to everyone, with no Undo except on Kevin\'s phone', async ({ page }) => {
      const tomorrow = londonDates(Date.now())[1];
      await mockPadel(page, { siClosedFrom: 7, booked: [bookedRow(tomorrow, { price_pence: 3600, players: '[1,2]', paid_at: new Date().toISOString(), splitwise_state: 'done', texts_state: 'failed', texts_note: 'Messages refused' })] });
      await openAsTestAnn(page);
      const row = page.locator('#row-19');
      await expect(row.locator('.paid-line')).toContainText('Paid £36.00, 2 playing (TA TB), £18.00 each. Splitwise: added Texts: couldn\'t send');
      await expect(row.locator('[data-unbook]')).toHaveCount(0);
      await expect(row.locator('[data-retry]')).toHaveCount(0);
    });
  });

  test.describe('no code (Kevin, 27 Oct 2026)', () => {
    test('the bare address opens straight to the name list, with no code header and no gate', async ({ page }) => {
      const store = await mockPadel(page);
      await page.goto(PAGE);
      await expect(page.locator('#pick')).toBeVisible();
      await expect(page.locator('#gate')).toHaveCount(0);
      await expect(page.locator('#code-input')).toHaveCount(0);
      expect(store.headers.length).toBeGreaterThan(0);
      expect(store.headers.every((h) => !('x-group-key' in h))).toBe(true);
    });

    test('an old #k= link still opens, and the code is dropped from the address bar and from this phone', async ({ page }) => {
      await mockPadel(page);
      await page.addInitScript(() => { localStorage.setItem('padel.k', '0123456789abcdef0123'); });
      await page.goto(`${PAGE}#k=0123456789abcdef0123`);
      await expect(page.locator('#pick')).toBeVisible();
      expect(page.url()).not.toContain('#k=');
      expect(page.url().endsWith(PAGE)).toBe(true);
      expect(await page.evaluate(() => localStorage.getItem('padel.k'))).toBeNull();
    });
  });
});
