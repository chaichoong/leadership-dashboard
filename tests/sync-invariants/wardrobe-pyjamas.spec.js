// Invariant: the What to wear card names tonight's pyjamas and when they go in the wash, and the
// night's log and the day's log never undo each other (Kevin, 31 Oct 2026).
//
// Pyjamas sat in the wardrobe as "Lounge" pieces: washed after every wear and never offered. Kevin:
// "what pyjamas we're going to wear in the evening, and also when to put them in the wash". The
// trap this guards: the day's Wearing this takes back any piece logged today that it does not list,
// so a pyjama night logged first would be wiped by the next day press, unless each log keeps to its
// own pieces. Generic names only: the real wardrobe lives in Airtable.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, localTodayISO, makeFixtures, setupMockAirtable } = require('./helpers');

const WR = { name: 'fldG9hxGddp8ijUwW', type: 'fldnUA7o3eR62r1FW', swatch: 'fld44tZ76VsKRH0Db', status: 'fld8Z9QI5pP97cymY',
  usedFor: 'fldqINoZ665Tdmb0V', lastWorn: 'fldc0Wa3pND9EbAI2', prevWorn: 'fldqoYAnlsITO1GLt', wears: 'fldBDNIOVC0VFkQjR', inWashSince: 'fldfjRleBvHsIbJyl' };
const OF = { name: 'fldLpZormElc2HJ3s', option: 'fld6mmKM5Nw7jz3lC', items: 'fldyXeckfm9O39d7o', season: 'fldz3FqdChXD0ZRK5', lastWorn: 'fldyl27uPPhXH7LkL' };
const T_WR = 'tblxcSDis9Tl1dFge', T_OF = 'tblqGdFI6VUH1wUdq';

const dayBefore = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const piece = (id, name, type, extra = {}) => ({ id, fields: { [WR.name]: name, [WR.type]: type, [WR.status]: 'Own', [WR.swatch]: '#1F2A44', [WR.usedFor]: ['Home'], ...extra } });
const wardrobe = (today) => [
  piece('recTee', 'Test white tee', 'Tee'), piece('recJeans', 'Test navy jeans', 'Trousers'), piece('recShoes', 'Test trainers', 'Shoes'),
  piece('recSweat', 'Test grey sweatshirt', 'Lounge'), piece('recJog', 'Test navy joggers', 'Lounge'),
  // Worn last night, 1 of 3: tonight is its second night.
  piece('recPjBlue', 'Test blue pyjamas', 'Pyjamas', { [WR.lastWorn]: dayBefore(today, 1), [WR.wears]: 1 }),
  piece('recPjCheck', 'Test check pyjamas', 'Pyjamas', { [WR.lastWorn]: dayBefore(today, 9) }),
  piece('recPjGrey', 'Test grey pyjamas', 'Pyjamas', { [WR.lastWorn]: dayBefore(today, 1), [WR.wears]: 3, [WR.inWashSince]: dayBefore(today, 1) }),
];
const outfit = (id, name, option, items) => ({ id, fields: { [OF.name]: name, [OF.option]: option, [OF.items]: items, [OF.season]: 'All' } });
const outfits = () => [
  outfit('recO1', 'Tee and jeans', 'Out casual', ['recTee', 'recJeans', 'recShoes']),
  outfit('recO2', 'Sofa day', 'Stay at home', ['recSweat', 'recJog']),
];

async function open(page) {
  const today = localTodayISO();
  const db = { [T_WR]: wardrobe(today), [T_OF]: outfits() };
  const writes = [];
  await page.addInitScript((pat) => {
    localStorage.setItem('_dlr_pat', pat);
    if (window !== window.top) return;
    try { indexedDB.deleteDatabase('_dlr_cache'); } catch {}
  }, MOCK_PAT);
  await setupMockAirtable(page, { ...makeFixtures(), wardrobe: db[T_WR], outfits: db[T_OF] });
  await page.route(/api\.airtable\.com\/v0\/[^/]+\/(tblxcSDis9Tl1dFge|tblqGdFI6VUH1wUdq)/, async (route) => {
    const req = route.request();
    const table = req.url().includes(T_WR) ? T_WR : T_OF;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'GET') return json({ records: db[table] });
    const body = req.postDataJSON();
    writes.push({ table, body });
    body.records.forEach(u => { const r = db[table].find(x => x.id === u.id); if (r) Object.assign(r.fields, u.fields); });
    return json({ records: body.records });
  });
  await page.goto('/#home');
  return { db, writes, today };
}

test.describe('Tonight\'s pyjamas', () => {
  test('names the pair part-way through its nights, which night tonight is, and when it is washed', async ({ page }) => {
    await open(page);
    const pj = page.locator('#homeWear .wear-pj');
    await expect(pj).toContainText('Test blue pyjamas', { timeout: 20000 });
    await expect(pj).toContainText('Night 2 of 3. Into the wash after');
    // The other clean pair is offered; the pair in the wash is listed with the day it is back.
    await expect(pj.locator('[data-wear-pyjamas="recPjCheck"]')).toBeVisible();
    await expect(pj).toContainText('In the wash: Test grey pyjamas');
    // Pyjamas are not day clothes: not in the day picker, not in Tonight's wash.
    await page.locator('#homeWear [data-wear-other]').click();
    await expect(page.locator('#homeWear [data-wear-otherform]')).not.toContainText('pyjamas');
  });

  test('Wearing these tonight logs only the pair, and the day\'s Wearing this never takes it back', async ({ page }) => {
    const { db, writes, today } = await open(page);
    await page.locator('#homeWear [data-wear-pyjamas="recPjBlue"]').click({ timeout: 20000 });
    await expect(page.locator('#homeWear .wear-pj .wear-btn-done')).toHaveText('Wearing tonight');
    const night = writes.filter(w => w.table === T_WR);
    expect(night).toHaveLength(1);
    expect(night[0].body.records.map(r => r.id)).toEqual(['recPjBlue']);
    expect(night[0].body.records[0].fields[WR.wears]).toBe(2);
    expect(writes.some(w => w.table === T_OF)).toBe(false);   // a night is no outfit

    await page.locator('#homeWear .wear-opt', { hasText: 'Out casual' }).locator('[data-wear-option]').click();
    await expect(page.locator('#homeWear .wear-opt', { hasText: 'Out casual' }).locator('.wear-btn-done')).toBeVisible();
    const day = writes.filter(w => w.table === T_WR).slice(1).flatMap(w => w.body.records.map(r => r.id));
    expect(day).not.toContain('recPjBlue');
    expect(db[T_WR].find(r => r.id === 'recPjBlue').fields[WR.lastWorn]).toBe(today);
    await expect(page.locator('#homeWear .wear-pj')).toContainText('Wearing tonight');
  });

  test('switching to another pair tonight takes the first pair\'s night back', async ({ page }) => {
    const { db, today } = await open(page);
    await page.locator('#homeWear [data-wear-pyjamas="recPjBlue"]').click({ timeout: 20000 });
    await expect(page.locator('#homeWear .wear-pj .wear-btn-done')).toBeVisible();
    await page.locator('#homeWear [data-wear-pyjamas="recPjCheck"]').click();
    await expect(page.locator('#homeWear .wear-pj')).toContainText('Test check pyjamas');
    await expect.poll(() => db[T_WR].find(r => r.id === 'recPjCheck').fields[WR.lastWorn]).toBe(today);
    const blue = db[T_WR].find(r => r.id === 'recPjBlue').fields;
    expect(blue[WR.lastWorn]).toBe(dayBefore(today, 1));
    expect(blue[WR.wears]).toBe(1);
  });
});
