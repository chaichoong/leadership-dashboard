// Invariant: the "What to wear today" card on My Dashboard and the Wardrobe page (Kevin, 27 Oct 2026).
// The card shows the date, place, feels-like temperature and conditions, a plain reason, and three
// options; Wearing stamps today's date on the outfit and every piece it lists (layers included) in
// Airtable, then holds that outfit for the day. The Wardrobe page lists owned clothes, the buys and
// the clear-out. Fixture names are generic: the real wardrobe lives only in Airtable.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, localTodayISO, makeFixtures, setupMockAirtable } = require('./helpers');

const WR = { name: 'fldG9hxGddp8ijUwW', type: 'fldnUA7o3eR62r1FW', colour: 'fldbA3Yql3NAjdUAq', swatch: 'fld44tZ76VsKRH0Db',
  usedFor: 'fldqINoZ665Tdmb0V', status: 'fld8Z9QI5pP97cymY', action: 'fldoYeCu7oAqgPZd8', layerRole: 'fld7VonuseNOhkCcw',
  buyIn: 'fldEvjSCyCQ1NLdWj', cap: 'fldqyRbEeDxDKUupb', reason: 'fldIrdIdrYXKvhktk', lastWorn: 'fldc0Wa3pND9EbAI2' };
const OF = { name: 'fldLpZormElc2HJ3s', option: 'fld6mmKM5Nw7jz3lC', items: 'fldyXeckfm9O39d7o', season: 'fldz3FqdChXD0ZRK5',
  why: 'fldKVSBHfcHN0U7mW', lastWorn: 'fldyl27uPPhXH7LkL', prevWorn: 'fld4iO9GEkFP0nR4z', order: 'fldKIzCbsNESKdwd0' };
const T_WR = 'tblxcSDis9Tl1dFge', T_OF = 'tblqGdFI6VUH1wUdq';

const piece = (id, name, type, extra = {}) => ({ id, fields: { [WR.name]: name, [WR.type]: type, [WR.status]: 'Own', [WR.swatch]: '#1F2A44', [WR.colour]: 'navy', [WR.usedFor]: ['Work'], ...extra } });
const wardrobe = () => [
  piece('recTee', 'Test white tee', 'Tee'), piece('recKnit', 'Test navy jumper', 'Knit'), piece('recJeans', 'Test navy jeans', 'Trousers'),
  piece('recBoots', 'Test tan boots', 'Shoes', { [WR.layerRole]: 'Leather boots casual' }),
  piece('recRain', 'Test quilted jacket', 'Jacket', { [WR.layerRole]: 'Rain jacket' }),
  piece('recBeanie', 'Test olive beanie', 'Accessory', { [WR.layerRole]: 'Beanie' }),
  piece('recRoll', 'Test black turtleneck', 'Knit', { [WR.lastWorn]: '2026-10-20' }), piece('recBlack', 'Test black jeans', 'Trousers'),
  piece('recChelsea', 'Test Chelsea boots', 'Shoes', { [WR.layerRole]: 'Leather boots smart' }),
  piece('recCoat', 'Test grey coat', 'Coat', { [WR.layerRole]: 'Smart coat', [WR.status]: 'Bought' }),
  piece('recSweat', 'Test grey sweatshirt', 'Lounge'), piece('recJog', 'Test navy joggers', 'Lounge'),
  piece('recNeed', 'Test stripe top', 'Tee', { [WR.status]: 'Need', [WR.buyIn]: 'March', [WR.cap]: '£10 + delivery', [WR.reason]: 'Spring weekends' }),
  piece('recOut', 'Test orange hoodie', 'Lounge', { [WR.status]: 'Clear out', [WR.action]: 'Donate', [WR.reason]: 'Outside your colours' }),
];
const outfit = (id, name, option, items, extra = {}) => ({ id, fields: { [OF.name]: name, [OF.option]: option, [OF.items]: items, [OF.season]: 'All', [OF.why]: `${name} why`, ...extra } });
const outfits = () => [
  outfit('recO1', 'Knit and denim', 'Out casual', ['recTee', 'recKnit', 'recJeans', 'recBoots'], { [OF.lastWorn]: '2026-10-20' }),
  outfit('recO2', 'All black', 'Out smart casual', ['recRoll', 'recBlack', 'recChelsea']),
  outfit('recO3', 'Sofa day', 'Stay at home', ['recSweat', 'recJog']),
  outfit('recO4', 'Stripe weekend', 'Out casual', ['recNeed', 'recJeans', 'recBoots']),
];

// A wardrobe and outfits store that keeps writes, so a page that reads again after an edit sees it.
// fail: (method, table) => true to answer that write with a 500.
async function liveTables(page, fail = () => false) {
  const db = { [T_WR]: wardrobe(), [T_OF]: outfits() };
  const writes = [];
  let n = 0;
  await page.route(/api\.airtable\.com\/v0\/[^/]+\/(tblxcSDis9Tl1dFge|tblqGdFI6VUH1wUdq)/, async (route) => {
    const req = route.request(), method = req.method();
    const table = req.url().includes(T_WR) ? T_WR : T_OF;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (method === 'GET') return json({ records: db[table] });
    const body = method === 'DELETE' ? null : req.postDataJSON();
    writes.push({ method, table, body, url: req.url() });
    if (fail(method, table)) return route.fulfill({ status: 500, body: '{}' });
    if (method === 'POST') {
      const made = body.records.map(r => ({ id: 'recNew' + (++n), fields: Object.fromEntries(Object.entries(r.fields).filter(([, v]) => v != null)) }));
      db[table].push(...made);
      return json({ records: made });
    }
    if (method === 'DELETE') {
      const ids = new URL(req.url()).searchParams.getAll('records[]');
      db[table] = db[table].filter(r => !ids.includes(r.id));
      return json({ records: ids.map(id => ({ id, deleted: true })) });
    }
    body.records.forEach(u => { const r = db[table].find(x => x.id === u.id); if (r) Object.assign(r.fields, u.fields); });
    return json({ records: body.records });
  });
  return { db, writes };
}

async function open(page, hash, opts = {}) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript((pat) => {
    localStorage.setItem('_dlr_pat', pat);
    if (window !== window.top) return;
    try { indexedDB.deleteDatabase('_dlr_cache'); } catch {}
  }, MOCK_PAT);
  await setupMockAirtable(page, { ...makeFixtures(), wardrobe: wardrobe(), outfits: outfits(), ...(opts.fixtures || {}) });
  if (opts.weatherDown) await page.route('**/api.open-meteo.com/**', r => r.fulfill({ status: 503, body: 'down' }));
  if (opts.live) opts.store = await liveTables(page, opts.fail);
  await page.goto('/' + (hash ? '#' + hash : ''));
  return errors;
}
const realErrors = errs => errs.filter(e => !/net::ERR|Failed to fetch|NetworkError/.test(e));

test.describe('What to wear today', () => {
  test('sits at the top of My Dashboard with the date, the weather, a reason and three options', async ({ page }) => {
    const errors = await open(page, 'home');
    const card = page.locator('#homeWear');
    await expect(card.locator('.wear-opt')).toHaveCount(3, { timeout: 20000 });
    // The jump row sits above the card (Kevin, 28 Oct 2026).
    const top = await page.evaluate(() => [document.getElementById('homeWear'), document.getElementById('homeJumpSlot')].map(e => e.getBoundingClientRect().top));
    expect(top[1]).toBeLessThan(top[0]);
    const longDate = await page.evaluate(() => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }));
    await expect(card.locator('.wear-date')).toContainText(longDate);
    await expect(card.locator('.wear-temp')).toContainText('11°C');
    await expect(card.locator('.wear-chips')).toContainText('Drizzle');
    await expect(card.locator('.wear-chips')).toContainText('Rain 80%');
    await expect(card.locator('.wear-why')).toContainText('feel 4° colder');
    const casual = card.locator('.wear-opt', { hasText: 'Out casual' });
    await expect(casual).toContainText('Best for today');
    await expect(casual).toContainText('Test quilted jacket');
    await expect(casual).toContainText('Test olive beanie');
    await expect(casual).not.toContainText('Test stripe top');
    await expect(card.locator('.wear-opt', { hasText: 'Out smart casual' })).toContainText('Test grey coat');
    await expect(card.locator('.wear-opt', { hasText: 'Stay at home' })).toContainText('Test grey sweatshirt');
    expect(realErrors(errors)).toEqual([]);
  });

  test('list order is the Order field, whatever order the API returns them in', async ({ page }) => {
    const ordered = [...outfits(), outfit('recO5', 'Tee and boots', 'Out casual', ['recTee', 'recJeans', 'recBoots'])]
      .map((o, i) => ({ id: o.id, createdTime: '2026-10-27T11:35:16.000Z', fields: { ...o.fields, [OF.lastWorn]: undefined, [OF.order]: i + 1 } }));
    // None worn yet, all created in the same second (as live). Last in Order, returned first: without the sort it would be picked.
    await open(page, 'home', { fixtures: { outfits: [ordered[4], ordered[2], ordered[1], ordered[3], ordered[0]] } });
    await expect(page.locator('#homeWear .wear-opt', { hasText: 'Out casual' }).locator('.wear-outfit')).toHaveText('Knit and denim', { timeout: 20000 });
  });

  test('on a phone the recommended option is shown first', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 900 });
    await open(page, 'home');
    await expect(page.locator('#homeWear .wear-opt')).toHaveCount(3, { timeout: 20000 });
    const tops = await page.evaluate(() => [...document.querySelectorAll('#homeWear .wear-opt')].map(o => [o.classList.contains('wear-opt-best'), o.getBoundingClientRect().top]));
    const best = tops.find(t => t[0])[1];
    expect(tops.every(t => t[1] >= best)).toBe(true);
  });

  test('Wearing stamps today on the outfit and on every piece it lists, then holds it for the day', async ({ page }) => {
    await open(page, 'home');
    const patches = [];
    page.on('request', r => { if (r.method() === 'PATCH' && /api\.airtable\.com/.test(r.url())) patches.push({ url: r.url(), body: r.postDataJSON() }); });
    const casual = page.locator('#homeWear .wear-opt', { hasText: 'Out casual' });
    await expect(casual.locator('[data-wear-option]')).toBeVisible({ timeout: 20000 });
    await casual.locator('[data-wear-option]').click();
    await expect(casual.locator('.wear-btn-done')).toHaveText('Wearing today');
    await expect.poll(() => patches.length).toBe(2);
    const today = localTodayISO();
    const outfitPatch = patches.find(p => p.url.includes(T_OF));
    expect(outfitPatch.body.records).toEqual([{ id: 'recO1', fields: { [OF.lastWorn]: today, [OF.prevWorn]: '2026-10-20' } }]);
    const itemPatch = patches.find(p => p.url.includes(T_WR));
    expect(itemPatch.body.records.map(r => r.id).sort()).toEqual(['recBeanie', 'recBoots', 'recJeans', 'recKnit', 'recRain', 'recTee']);
    expect(itemPatch.body.records.every(r => r.fields[WR.lastWorn] === today)).toBe(true);
  });

  test('a failed save puts the card back and says so', async ({ page }) => {
    await open(page, 'home');
    await page.route('**/api.airtable.com/v0/**', async (route) => {
      if (route.request().method() === 'PATCH') return route.fulfill({ status: 500, body: '{}' });
      return route.fallback();
    });
    const casual = page.locator('#homeWear .wear-opt', { hasText: 'Out casual' });
    await expect(casual.locator('[data-wear-option]')).toBeVisible({ timeout: 20000 });
    await casual.locator('[data-wear-option]').click();
    await expect(page.locator('#appToast')).toContainText('did not save');
    await expect(casual.locator('[data-wear-option]')).toBeVisible();
  });

  test('a part-saved Wearing is undone in Airtable, not just on screen', async ({ page }) => {
    await open(page, 'home');
    const patches = [];
    await page.route('**/api.airtable.com/v0/**', async (route) => {
      const req = route.request();
      if (req.method() !== 'PATCH') return route.fallback();
      patches.push({ url: req.url(), body: req.postDataJSON() });
      if (req.url().includes(T_OF)) return route.fulfill({ status: 500, body: '{}' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(req.postDataJSON()) });
    });
    const casual = page.locator('#homeWear .wear-opt', { hasText: 'Out casual' });
    await expect(casual.locator('[data-wear-option]')).toBeVisible({ timeout: 20000 });
    await casual.locator('[data-wear-option]').click();
    await expect(page.locator('#appToast')).toContainText('nothing changed');
    const wardrobePatches = patches.filter(p => p.url.includes(T_WR));
    expect(wardrobePatches).toHaveLength(2);
    expect(wardrobePatches[1].body.records.every(r => r.fields[WR.lastWorn] === null)).toBe(true);
  });

  test('with the weather down the options still show, and the card says why', async ({ page }) => {
    const errors = await open(page, 'home', { weatherDown: true });
    await expect(page.locator('#homeWear .wear-opt')).toHaveCount(3, { timeout: 20000 });
    await expect(page.locator('#homeWear .wear-error')).toContainText("weather could not be read");
    expect(realErrors(errors)).toEqual([]);
  });
});

test.describe('Wardrobe page', () => {
  test('lists owned clothes, the buys and the clear-out, with a working health bar', async ({ page }) => {
    const errors = await open(page, 'wardrobe');
    const pageEl = page.locator('#wardrobePage');
    await expect(pageEl.locator('.wr-stat').first()).toContainText('12', { timeout: 20000 });
    await expect(pageEl.locator('.wr-stats')).toContainText('3 / 4');
    await expect(pageEl.locator('#wrPanel-own')).toContainText('Test grey coat');
    await expect(pageEl.locator('#wrPanel-own')).not.toContainText('Test orange hoodie');
    await expect(pageEl.locator('#wrPanel-own tr', { hasText: 'Test black turtleneck' })).toContainText('20/10/2026');
    await pageEl.locator('[data-wr-view="own"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(pageEl.locator('[data-wr-view="add"]')).toHaveAttribute('aria-selected', 'true');
    await expect(pageEl.locator('[data-wr-view="add"]')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await pageEl.locator('[data-wr-view="add"]').click();
    await expect(pageEl.locator('#wrPanel-add')).toContainText('Test stripe top');
    await expect(pageEl.locator('#wrPanel-add')).toContainText('1 outfit');
    await expect(pageEl.locator('#wrPanel-add')).toContainText('March');
    await pageEl.locator('[data-wr-view="out"]').click();
    await expect(pageEl.locator('#wrPanel-out')).toContainText('Test orange hoodie');
    await expect(pageEl.locator('#wrPanel-out')).toContainText('Donate');
    await expect(pageEl.locator('#wrPanel-own')).toBeHidden();
    await expect(page.locator('[data-sync-bar="wardrobe"]')).not.toBeEmpty();
    expect(realErrors(errors)).toEqual([]);
  });

  test('an outfit pointing at a missing piece fails the health check, it never reads as fine', async ({ page }) => {
    await open(page, 'wardrobe', { fixtures: { outfits: [...outfits(), outfit('recO9', 'Broken', 'Out casual', ['recGone'])] } });
    await expect(page.locator('#wardrobePage .wr-stat').first()).toBeVisible({ timeout: 20000 });
    await page.locator('[data-sync-bar="wardrobe"] .sync-bar-health').click();
    await expect(page.locator('[data-sync-bar="wardrobe"]')).toContainText('point at missing clothes: Broken');
  });
});

test.describe('Jump row', () => {
  test('sits above the card, and What to wear brings the card back from further down', async ({ page }) => {
    await open(page, 'home');
    await expect(page.locator('#homeWear .wear-opt')).toHaveCount(3, { timeout: 20000 });
    await expect(page.locator('#homeJump .home-jump-btn').first()).toHaveText('What to wear');
    await page.evaluate(() => window.scrollTo(0, 2500));
    await expect.poll(() => page.evaluate(() => document.getElementById('homeWear').getBoundingClientRect().bottom < 0)).toBe(true);
    await page.locator('[data-home-jump="wear"]').click();
    await expect.poll(() => page.evaluate(() => { const r = document.getElementById('homeWear').getBoundingClientRect(); return r.top >= 0 && r.top < 200; })).toBe(true);
  });
});

test.describe('Editing the wardrobe', () => {
  test('add a piece in place of an old one: it joins its outfits, today\'s picks use it, the old one goes', async ({ page }) => {
    const opts = { live: true };
    const errors = await open(page, 'wardrobe', opts);
    const pg = page.locator('#wardrobePage');
    await pg.locator('[data-wr-add]').click({ timeout: 20000 });
    await expect(pg.locator('[data-wr-addform] input[name="name"]')).toBeFocused();
    await pg.locator('input[name="name"]').fill('Test indigo jeans');
    await pg.locator('select[name="type"]').selectOption('Trousers');
    await pg.locator('input[name="colour"]').fill('indigo');
    await pg.locator('input[name="usedFor"][value="Work"]').check();
    await pg.locator('select[name="replaces"]').selectOption('recJeans');
    await pg.locator('[data-wr-addform] button[type="submit"]').click();
    await expect(page.locator('#appToast')).toContainText('stands in for Test navy jeans');
    const post = opts.store.writes.find(w => w.method === 'POST');
    expect(post.body.records[0].fields).toMatchObject({ [WR.name]: 'Test indigo jeans', [WR.type]: 'Trousers', [WR.status]: 'Own', [WR.usedFor]: ['Work'] });
    const o1 = opts.store.db[T_OF].find(o => o.id === 'recO1');
    expect(o1.fields[OF.items]).toEqual(['recTee', 'recKnit', 'recNew1', 'recBoots']);
    expect(opts.store.db[T_WR].find(r => r.id === 'recJeans').fields[WR.status]).toBe('Clear out');
    await expect(pg.locator('#wrPanel-own')).toContainText('Test indigo jeans');
    await expect(pg.locator('#wrPanel-own')).not.toContainText('Test navy jeans');
    await page.evaluate(() => switchTab('home'));
    await expect(page.locator('#homeWear .wear-opt', { hasText: 'Out casual' })).toContainText('Test indigo jeans', { timeout: 20000 });
    expect(realErrors(errors)).toEqual([]);
  });

  test('remove a piece: it moves to Get rid of, its outfit stops being offered, Keep it brings it back', async ({ page }) => {
    const opts = { live: true };
    await open(page, 'wardrobe', opts);
    const pg = page.locator('#wardrobePage');
    await pg.locator('[data-wr-remove="recRoll"]').click({ timeout: 20000 });
    await pg.locator('[data-wr-removeform] select[name="action"]').selectOption('Sell');
    await pg.locator('[data-wr-removeform] input[name="reason"]').fill('Bobbled');
    await pg.locator('[data-wr-removeform] button[type="submit"]').click();
    await expect(page.locator('#appToast')).toContainText('Moved Test black turtleneck to Get rid of');
    expect(opts.store.db[T_WR].find(r => r.id === 'recRoll').fields).toMatchObject({ [WR.status]: 'Clear out', [WR.action]: 'Sell', [WR.reason]: 'Bobbled' });
    await pg.locator('[data-wr-view="out"]').click();
    await expect(pg.locator('#wrPanel-out tr', { hasText: 'Test black turtleneck' })).toContainText('Sell');
    await page.evaluate(() => switchTab('home'));
    await expect(page.locator('#homeWear .wear-opt', { hasText: 'Out smart casual' })).toContainText('No outfit ready', { timeout: 20000 });
    await page.evaluate(() => switchTab('wardrobe'));
    await pg.locator('[data-wr-keep="recRoll"]').click();
    await expect(page.locator('#appToast')).toContainText('Kept Test black turtleneck');
    expect(opts.store.db[T_WR].find(r => r.id === 'recRoll').fields[WR.status]).toBe('Own');
  });

  test('Arrived turns a new piece into an owned one; Bought it moves an addition into your clothes', async ({ page }) => {
    const opts = { live: true };
    await open(page, 'wardrobe', opts);
    const pg = page.locator('#wardrobePage');
    const coat = pg.locator('#wrPanel-own tr', { hasText: 'Test grey coat' });
    await expect(coat.locator('.wr-pill-new')).toBeVisible({ timeout: 20000 });
    await coat.locator('[data-wr-arrived]').click();
    await expect(page.locator('#appToast')).toContainText('arrived');
    await expect(coat.locator('.wr-pill-new')).toHaveCount(0);
    await pg.locator('[data-wr-view="add"]').click();
    await pg.locator('[data-wr-bought="recNeed"]').click();
    await expect(page.locator('#appToast')).toContainText('Test stripe top moved to your clothes');
    expect(opts.store.db[T_WR].find(r => r.id === 'recNeed').fields[WR.status]).toBe('Bought');
  });

  test('a failed outfit update deletes the piece just added, so nothing half-saves', async ({ page }) => {
    const opts = { live: true, fail: (method, table) => method === 'PATCH' && table === T_OF };
    await open(page, 'wardrobe', opts);
    const pg = page.locator('#wardrobePage');
    await pg.locator('[data-wr-add]').click({ timeout: 20000 });
    await pg.locator('input[name="name"]').fill('Test indigo jeans');
    await pg.locator('select[name="replaces"]').selectOption('recJeans');
    await pg.locator('[data-wr-addform] button[type="submit"]').click();
    await expect(page.locator('#appToast')).toContainText('nothing changed');
    expect(opts.store.writes.map(w => w.method)).toEqual(['POST', 'PATCH', 'DELETE']);
    expect(opts.store.db[T_WR].some(r => r.fields[WR.name] === 'Test indigo jeans')).toBe(false);
    expect(opts.store.db[T_WR].find(r => r.id === 'recJeans').fields[WR.status]).toBe('Own');
    await expect(pg.locator('[data-wr-addform]')).toBeVisible();   // the form stays, so he can try again
  });
});

test.describe('Today hour by hour', () => {
  test('the card shows 06:00 to 23:00 with feels-like °C, rain in mm and wind in mph, and never km/h', async ({ page }) => {
    const errors = await open(page, 'home');
    const strip = page.locator('#homeWear .wear-hours');
    await expect(strip.locator('thead th[scope="col"]')).toHaveCount(18, { timeout: 20000 });
    await expect(strip.locator('thead th[scope="col"]').first()).toHaveText('06:00');
    await expect(strip.locator('thead th[scope="col"]').last()).toHaveText('23:00');
    const row = (label) => strip.locator('tbody tr', { hasText: label }).locator('td');
    // Fixture: hour h feels 5 + h/4, rain 0.4 mm at 08:00 and 1.2 mm at 17:00, wind 10 + h/2 mph.
    await expect(row('Feels like').first()).toHaveText('7°');        // 06:00: 6.5 rounds to 7
    await expect(row('Feels like').last()).toHaveText('11°');        // 23:00: 10.75
    await expect(row('Rain (mm)').nth(2)).toHaveText('0.4');         // 08:00
    await expect(row('Rain (mm)').nth(11)).toHaveText('1.2');        // 17:00
    await expect(row('Rain (mm)').nth(11)).toHaveClass(/wear-wet/);
    await expect(row('Rain (mm)').nth(0)).toHaveText('0.0');
    await expect(row('Wind (mph)').first()).toHaveText('13');         // 06:00
    await expect(row('Wind (mph)').last()).toHaveText('22');          // 23:00: 21.5
    await expect(page.locator('#homeWear .wear-chips')).toContainText('Wind 17 mph');
    await expect(page.locator('#homeWear')).not.toContainText('km/h');
    const now = new Date().getHours();
    if (now >= 6) await expect(strip.locator('thead th[aria-current="time"]')).toHaveText(String(now).padStart(2, '0') + ':00');
    expect(realErrors(errors)).toEqual([]);
  });

  test('on a phone the strip scrolls inside the card, never the page', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await open(page, 'home');
    await expect(page.locator('#homeWear .wear-hours')).toBeVisible({ timeout: 20000 });
    const w = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth,
      strip: document.querySelector('#homeWear .wear-hours').scrollWidth > document.querySelector('#homeWear .wear-hours').clientWidth }));
    expect(w.page).toBeLessThanOrEqual(w.view);
    expect(w.strip).toBe(true);
  });
});
