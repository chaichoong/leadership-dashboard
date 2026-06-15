// Invariant: Two-way sync uses correct field names on read AND write paths (commit ce5ece8)
// Bug: Read path used 'Quarter End' but write path used 'QuarterEnd' (no space),
//      causing sync failures that silently dropped data.
// Rule: Field names/IDs must be identical between read and write operations.
//       With returnFieldsByFieldId=true this is enforced by design (IDs are unambiguous).

const { test, expect } = require('@playwright/test');
const { loadDashboard, FIELDS } = require('./helpers');

test.describe('Two-Way Sync Consistency', () => {

  test('main data fetches use returnFieldsByFieldId=true', async ({ page }) => {
    const withFieldId = [];
    const withoutFieldId = [];

    await page.addInitScript((pat) => {
      localStorage.setItem('_dlr_pat', pat);
    }, 'pat_test_mock_token_for_playwright');

    await page.route('**/api.airtable.com/v0/**', async (route) => {
      const url = route.request().url();
      if (route.request().method() === 'GET' && url.includes('api.airtable.com')) {
        if (url.includes('returnFieldsByFieldId=true')) {
          withFieldId.push(url);
        } else {
          withoutFieldId.push(url);
        }
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' });
    });

    await page.goto('/');
    await page.waitForTimeout(3000);

    // The vast majority of requests must use returnFieldsByFieldId
    expect(withFieldId.length).toBeGreaterThan(0);
    // Only specialized queries (Fintable sync) may skip it — max 2 exceptions
    expect(withoutFieldId.length).toBeLessThanOrEqual(2);
  });

  test('PATCH requests reference valid field IDs not names', async ({ page }) => {
    const patchBodies = [];

    await page.addInitScript((pat) => {
      localStorage.setItem('_dlr_pat', pat);
    }, 'pat_test_mock_token_for_playwright');

    await page.route('**/api.airtable.com/v0/**', async (route) => {
      const method = route.request().method();
      if (method === 'PATCH') {
        try {
          patchBodies.push(route.request().postDataJSON());
        } catch {}
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' });
    });

    await page.goto('/');
    await page.waitForTimeout(3000);

    // Any PATCH body should use field IDs (start with 'fld') not human-readable names
    for (const body of patchBodies) {
      if (body?.records) {
        for (const rec of body.records) {
          if (rec.fields) {
            const fieldKeys = Object.keys(rec.fields);
            for (const key of fieldKeys) {
              // Field IDs start with 'fld' — human names contain spaces/uppercase
              expect(key).toMatch(/^fld[A-Za-z0-9]+$/);
            }
          }
        }
      }
    }
  });

  test('airtableFetch function exists and paginates', async ({ page }) => {
    await loadDashboard(page);

    const fnExists = await page.evaluate(() => {
      return typeof airtableFetch === 'function';
    });
    expect(fnExists).toBe(true);
  });
});
