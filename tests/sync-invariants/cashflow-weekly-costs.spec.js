// Cash flow "Weekly costs" box: Kevin's edits of 7 Oct 2026 (task rectkiXQ2jzhCbq4L).
//
// The Together arrears top-ups became fixed costs due on the 1st on 5 Oct 2026, so the
// box's Friday "Top-up" row (£140) counted them twice, and wages are Roy's £150 a week,
// not £330. On the app's starting figures that is about £1,600 too much going out over
// 31 days. The box is saved only in the browser, so no robot could make the edit.
// Invariants:
//   1. A browser with nothing saved starts at Wages £150 every Friday and no Top-up row.
//   2. A browser holding the old figures gets Kevin's two edits once, other rows kept.
//   3. After that his own edits stand: a later Top-up row he adds is not removed again.
// Airtable is mocked (helpers.js), so this runs with no PAT.

const { test, expect } = require('@playwright/test');
const { loadDashboard } = require('./helpers');

async function weeklyRows(page) {
  await page.waitForFunction(() => document.querySelectorAll('#cfWaControls [data-cost-row]').length > 0, null, { timeout: 20000 });
  return page.evaluate(() => [...document.querySelectorAll('#cfWaControls [data-cost-row]')].map((r) => ({
    label: r.querySelector('[data-cost-field="label"]').value,
    amount: Number(r.querySelector('[data-cost-field="amount"]').value),
    day: Number(r.querySelector('[data-cost-field="day"]').value),
  })));
}

async function seed(page, settings) {
  await page.addInitScript((s) => {
    if (!sessionStorage.getItem('_seeded')) {          // once per tab, so a reload keeps what the page saved
      localStorage.setItem('_wa_settings', JSON.stringify(s));
      sessionStorage.setItem('_seeded', '1');
    }
  }, settings);
}

test.describe('Cash flow weekly costs (Kevin, 7 Oct 2026)', () => {
  test('nothing saved: Wages £150 every Friday, no Top-up row', async ({ page }) => {
    await loadDashboard(page);
    expect(await weeklyRows(page)).toEqual([{ label: 'Wages', amount: 150, day: 5 }]);
  });

  test('the old starting figures get both edits, and the save sticks across a reload', async ({ page }) => {
    await seed(page, { commitments: [
      { label: 'Wages', amount: 330, day: 5 },
      { label: 'Top-up', amount: 140, day: 5 },
      { label: 'Cleaner', amount: 40, day: 2 },
    ] });
    await loadDashboard(page);
    const want = [{ label: 'Wages', amount: 150, day: 5 }, { label: 'Cleaner', amount: 40, day: 2 }];
    expect(await weeklyRows(page)).toEqual(want);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('_wa_settings')));
    expect(saved.weeklyCostsRuling20261007).toBe(true);
    expect(saved.commitments.map((c) => c.label)).toEqual(['Wages', 'Cleaner']);
    await page.reload();
    expect(await weeklyRows(page)).toEqual(want);
  });

  test('control: once applied, Kevin\'s own later rows stand', async ({ page }) => {
    const own = [{ label: 'Wages', amount: 200, day: 5 }, { label: 'Top-up', amount: 90, day: 1 }];
    await seed(page, { weeklyCostsRuling20261007: true, commitments: own });
    await loadDashboard(page);
    expect(await weeklyRows(page)).toEqual(own);
  });
});
