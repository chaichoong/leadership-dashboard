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
  why: 'fldKVSBHfcHN0U7mW', lastWorn: 'fldyl27uPPhXH7LkL', prevWorn: 'fld4iO9GEkFP0nR4z' };
const T_WR = 'tblxcSDis9Tl1dFge', T_OF = 'tblqGdFI6VUH1wUdq';

const piece = (id, name, type, extra = {}) => ({ id, fields: { [WR.name]: name, [WR.type]: type, [WR.status]: 'Own', [WR.swatch]: '#1F2A44', [WR.colour]: 'navy', [WR.usedFor]: ['Work'], ...extra } });
const wardrobe = () => [
  piece('recTee', 'Test white tee', 'Tee'), piece('recKnit', 'Test navy jumper', 'Knit'), piece('recJeans', 'Test navy jeans', 'Trousers'),
  piece('recBoots', 'Test tan boots', 'Shoes', { [WR.layerRole]: 'Leather boots casual' }),
  piece('recRain', 'Test quilted jacket', 'Jacket', { [WR.layerRole]: 'Rain jacket' }),
  piece('recBeanie', 'Test olive beanie', 'Accessory', { [WR.layerRole]: 'Beanie' }),
  piece('recRoll', 'Test black turtleneck', 'Knit'), piece('recBlack', 'Test black jeans', 'Trousers'),
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
  await page.goto('/' + (hash ? '#' + hash : ''));
  return errors;
}
const realErrors = errs => errs.filter(e => !/net::ERR|Failed to fetch|NetworkError/.test(e));

test.describe('What to wear today', () => {
  test('sits at the top of My Dashboard with the date, the weather, a reason and three options', async ({ page }) => {
    const errors = await open(page, 'home');
    const card = page.locator('#homeWear');
    await expect(card.locator('.wear-opt')).toHaveCount(3, { timeout: 20000 });
    const top = await page.evaluate(() => [document.getElementById('homeWear'), document.getElementById('homeJumpSlot')].map(e => e.getBoundingClientRect().top));
    expect(top[0]).toBeLessThan(top[1]);
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
