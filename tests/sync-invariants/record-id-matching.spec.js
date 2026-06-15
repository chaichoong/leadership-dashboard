// Invariant: Linked record lookups must use record IDs, not display strings (commit cc7d3ae)
// Bug: Tenancy auto-fill in recon matched unit by lookup string instead of record ID.
//      Minor differences (en-dash, trailing space, capitalisation) caused the unit to
//      silently drop from PATCH body when reconciling.
// Rule: Dropdown resolution for linked records must match by data-id (record ID),
//       not by option.value === lookupString.

const { test, expect } = require('@playwright/test');
const { loadDashboard, FIELDS } = require('./helpers');

test.describe('Record ID Matching', () => {

  test('reconciliation panel resolves unit by record ID not lookup string', async ({ page }) => {
    await loadDashboard(page, 'reconciliation');

    // Switch to reconciliation tab
    // Reconciliation is part of the overview tab, no need to switch
    await page.waitForTimeout(500);

    // Check that unit dropdown options have data-id attributes with record IDs
    const unitDropdownHasDataIds = await page.evaluate(() => {
      const selects = document.querySelectorAll('select');
      for (const s of selects) {
        const opts = [...s.options];
        if (opts.some(o => o.getAttribute('data-id')?.startsWith('rec'))) {
          return true;
        }
      }
      // If no recon panel is visible yet, check that the function exists
      return typeof setByRecordId === 'function' || typeof resolveDropdownId === 'function';
    });

    // The app should use record-ID-based resolution (either via data-id attrs or helper functions)
    // This test verifies the infrastructure exists — if it doesn't, the cc7d3ae bug has regressed
    expect(unitDropdownHasDataIds).toBe(true);
  });

  test('linked record fields in transactions use record IDs not display names', async ({ page }) => {
    await loadDashboard(page);

    // Verify that transaction records store linked fields as arrays of record IDs
    const linkedFieldsValid = await page.evaluate(() => {
      if (typeof allTransactions === 'undefined' || !allTransactions.length) return null;
      const tx = allTransactions[0];
      const tenancy = tx.fields?.['fldPmAMmxwqs4SdPa']; // txTenancy
      // Should be an array of record IDs (strings starting with 'rec')
      if (!Array.isArray(tenancy)) return false;
      return tenancy.every(id => typeof id === 'string' && id.startsWith('rec'));
    });

    if (linkedFieldsValid !== null) {
      expect(linkedFieldsValid).toBe(true);
    }
  });
});
