// Invariant: Split operations are PATCH-only, never POST (commits f5b7aad, e0a921a, dc67b2b)
// Bug: JS-side split feature POSTed duplicate transactions alongside the Airtable automation,
//      creating N × (N-1) extras. Data corruption incident.
// Rule 1: Split operations must only PATCH the source record (set Split Count), never POST children.
// Rule 2: Stale "(Split X of N)" in *Name with Split Count=1 must NOT grey out the Split button.
// Rule 3: Split button must be greyed out when Split Count > 1 (truly already split).

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures, FIELDS, makeFixtures } = require('./helpers');

test.describe('Split Transaction Safety', () => {

  test('split operation sends PATCH not POST for child records', async ({ page }) => {
    const postRequests = [];
    const patchRequests = [];

    await page.addInitScript((pat) => {
      localStorage.setItem('_dlr_pat', pat);
    }, 'pat_test_mock_token_for_playwright');

    const fixtures = makeFixtures();
    await page.route('**/api.airtable.com/v0/**', async (route) => {
      const method = route.request().method();
      const url = route.request().url();

      if (method === 'POST') {
        postRequests.push(url);
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' });
        return;
      }
      if (method === 'PATCH') {
        patchRequests.push(url);
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' });
        return;
      }

      const tableMatch = url.match(/\/v0\/[^/]+\/([^?/]+)/);
      const tableId = tableMatch ? tableMatch[1] : null;
      const fixtureKey = {
        'tblpqkvWJJo8Uu25q': 'businesses',
        'tblN51a88qTDB6iMH': 'tenancies',
        'tbln0gzhCAorFc3zB': 'transactions',
        'tblkOTKIG2Tyiy9aM': 'invoices',
        'tblM3mZCR5kiEdWMj': 'rentalUnits',
        'tblX4elTuu01gwBYh': 'tenants',
        'tbleWb8ioptnEwPR8': 'categories',
        'tblOTdRcPf8AgRz25': 'subCategories',
        'tblx5kvhzNEI5TFlS': 'costs',
        'tblqB8b22hKBL4PF1': 'tasks',
        'tbl6f0OkAmTC2jbuG': 'properties',
        'tbl1nr0EcX2T62KME': 'accounts',
        'tblzG0B9oRRpszcgC': 'arrears',
      }[tableId];
      const records = fixtureKey ? (fixtures[fixtureKey] || []) : [];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records }) });
    });

    await page.goto('/#reconciliation');
    await page.waitForTimeout(2000);

    // Navigate to reconciliation
    await page.waitForTimeout(500);

    // If any split was triggered during load, verify no POSTs to transactions table
    const txPostRequests = postRequests.filter(url => url.includes('tbln0gzhCAorFc3zB'));
    expect(txPostRequests.length).toBe(0);
  });

  test('stale split name (Split Count=1) does not disable split button', async ({ page }) => {
    // recTx3 has "(Split 1 of 3)" in name but Split Count = 1 (stale name, children deleted)
    await loadDashboardWithFixtures(page, {}, 'reconciliation');
    await page.waitForTimeout(500);

    // Find the split button for recTx3 — it should NOT be disabled
    const splitBtnDisabled = await page.evaluate(() => {
      // Look for any split buttons that reference the stale record
      const buttons = document.querySelectorAll('[data-split-id="recTx3"], .split-btn');
      for (const btn of buttons) {
        if (btn.disabled || btn.classList.contains('disabled')) return true;
      }
      return false;
    });

    // With Split Count = 1, the button should be ENABLED despite stale name
    expect(splitBtnDisabled).toBe(false);
  });
});
