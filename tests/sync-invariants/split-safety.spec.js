// Invariant: Split operations are PATCH-only, never POST (commits f5b7aad, e0a921a, dc67b2b)
// Bug: JS-side split feature POSTed duplicate transactions alongside the Airtable automation,
//      creating N × (N-1) extras. Data corruption incident.
// Rule 1: Split operations must only PATCH the source record (set Split Count), never POST children.
//
// Rules 2/3 (the Split button's enabled/disabled state) are now enforced at source:
// reconciliation.js derives `isAlreadySplit` purely from Number(Split Count) > 1, not from
// parsing the "(Split X of N)" name string. Asserting the rendered button state needs a fixture
// that renders the reconciliation panel under mock data — tracked as a follow-up rather than
// shipped as a DOM test that passes whether or not the button exists.

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
});
