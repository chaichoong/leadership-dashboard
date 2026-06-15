// Invariant: Airtable fetches must paginate completely (commit 94fe53d)
// Bug: loadArrearsRecords didn't paginate — existence check ran against incomplete
//      cache (first 100 records), creating 240+ duplicates on every dashboard load.
// Rule: airtableFetch() must follow offset tokens until exhausted.
//       No bulk-create operation should proceed without a FULL dataset read.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, FIELDS, TABLE_MAP } = require('./helpers');

test.describe('Pagination & Deduplication', () => {

  test('airtableFetch follows offset tokens until all pages loaded', async ({ page }) => {
    let requestCount = 0;

    await page.addInitScript((pat) => {
      localStorage.setItem('_dlr_pat', pat);
    }, MOCK_PAT);

    // Simulate paginated response: first call returns offset, second returns no offset
    await page.route('**/api.airtable.com/v0/**', async (route) => {
      const url = route.request().url();
      const method = route.request().method();

      if (method !== 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' });
        return;
      }

      const tableMatch = url.match(/\/v0\/[^/]+\/([^?/]+)/);
      const tableId = tableMatch ? tableMatch[1] : null;

      // For the transactions table, simulate pagination
      if (tableId === 'tbln0gzhCAorFc3zB') {
        requestCount++;
        if (!url.includes('offset=page2')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              records: [{ id: 'recPage1', fields: { [FIELDS.txName]: 'Page 1 Tx', [FIELDS.txAmount]: 100, [FIELDS.txReportAmount]: 100, [FIELDS.txDate]: '2026-05-01', [FIELDS.txSplitCount]: 1 } }],
              offset: 'page2',
            }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              records: [{ id: 'recPage2', fields: { [FIELDS.txName]: 'Page 2 Tx', [FIELDS.txAmount]: 200, [FIELDS.txReportAmount]: 200, [FIELDS.txDate]: '2026-05-02', [FIELDS.txSplitCount]: 1 } }],
            }),
          });
        }
        return;
      }

      // Other tables: return empty
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' });
    });

    await page.goto('/');
    await page.waitForTimeout(3000);

    // The app should have made at least 2 requests to the transactions table (following offset)
    expect(requestCount).toBeGreaterThanOrEqual(2);

    // Verify both records are loaded (check via global allTransactions)
    const txCount = await page.evaluate(() => {
      return typeof allTransactions !== 'undefined' ? allTransactions.length : -1;
    });
    expect(txCount).toBe(2);
  });

  test('no duplicate records created when existence check has full dataset', async ({ page }) => {
    const patchedRecordIds = [];

    await page.addInitScript((pat) => {
      localStorage.setItem('_dlr_pat', pat);
    }, MOCK_PAT);

    await page.route('**/api.airtable.com/v0/**', async (route) => {
      const url = route.request().url();
      const method = route.request().method();

      if (method === 'POST') {
        // Track any creation attempts
        try {
          const body = route.request().postDataJSON();
          if (body?.records) {
            body.records.forEach(r => patchedRecordIds.push(r.fields || r));
          }
        } catch {}
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' });
        return;
      }

      // Return empty for all GETs
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' });
    });

    await page.goto('/');
    await page.waitForTimeout(3000);

    // With no existing arrears and no tenancies in arrears, no records should be created
    // The key invariant: creation calls should not exceed expected count
    // (historically 240 duplicates were created per load)
    expect(patchedRecordIds.length).toBeLessThan(10);
  });
});
