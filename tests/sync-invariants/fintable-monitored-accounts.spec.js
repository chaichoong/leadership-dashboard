// 23 Aug 2026 — the Fintable sync banner read "33 need reconnecting" because the
// Accounts table keeps every feed ever connected. 23 legacy Revolut / Wise / Two Chefs /
// cafe rows with NO Business link (dead 1-2.5 years) and one manual ANNA account with no
// Fintable user were all graded critical. Only feeds on an ACTIVE business with a
// Fintable user are worth reconnecting, so only those are monitored.
const { test, expect } = require('@playwright/test');
const { makeFixtures, setupMockAirtable, MOCK_PAT } = require('./helpers');
/* global switchTab */

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const acc = (id, fields) => ({ id, fields });

test('sync banner counts only feeds on an active business with a Fintable user', async ({ page }) => {
  const fixtures = makeFixtures();
  fixtures.accounts = [
    // real dead feed: linked to an active business, has a Fintable user -> counted
    acc('recDead', { 'Account Alias': 'Barclaycard', '**Fintable User': 'k@x.com', 'Active? (From Business)': [1], '**Last Successful Update': hoursAgo(384 * 24) }),
    // legacy feed with no Business link -> hidden
    acc('recLegacy', { '*Name': 'KB Director Expenses', '**Fintable User': 'k@x.com', '**Last Successful Update': hoursAgo(931 * 24) }),
    // manual account, no Fintable connection -> hidden (nothing to reconnect)
    acc('recManual', { 'Account Alias': 'Operations Director - ANNA', 'Active? (From Business)': [1] }),
    // inactive business -> hidden
    acc('recInactive', { 'Account Alias': 'Old Co', '**Fintable User': 'k@x.com', 'Active? (From Business)': [0], '**Last Successful Update': hoursAgo(500 * 24) }),
    // healthy live feed -> counted as OK
    acc('recLive', { 'Account Alias': 'Santander', '**Fintable User': 'k@x.com', 'Active? (From Business)': [1], '**Last Successful Update': hoursAgo(2) }),
  ];

  await page.addInitScript((pat) => { localStorage.setItem('_dlr_pat', pat); try { indexedDB.deleteDatabase('_dlr_cache'); } catch {} }, MOCK_PAT);
  await setupMockAirtable(page, fixtures);
  await page.goto('/');
  await page.waitForFunction(() => typeof switchTab === 'function', { timeout: 20000 });
  await page.evaluate(() => switchTab('fintable'));
  await page.waitForFunction(() => document.querySelectorAll('#fintableBody tr').length > 0 && !document.querySelector('#fintableBody .od-empty-state'), { timeout: 20000 });

  const rows = await page.locator('#fintableBody tr').allInnerTexts();
  expect(rows.join('\n')).toContain('Barclaycard');
  expect(rows.join('\n')).toContain('Santander');
  expect(rows.join('\n')).not.toContain('KB Director Expenses');
  expect(rows.join('\n')).not.toContain('ANNA');
  expect(rows.join('\n')).not.toContain('Old Co');
  expect(rows).toHaveLength(2);

  await expect(page.locator('#fintableBadge')).toHaveText('1');
  // Without the filter this fixture reads "3 need reconnecting"
  await expect(page.locator('#fintableAlertBanner')).toContainText('1 needs reconnecting');
});
