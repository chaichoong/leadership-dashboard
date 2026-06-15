// Invariant: Linked-record data is held as record IDs, not display strings (commit cc7d3ae)
// Bug: Tenancy auto-fill in recon matched a unit by lookup string instead of record ID.
//      Minor differences (en-dash, trailing space, capitalisation) silently dropped the
//      unit from the PATCH body when reconciling.
// Rule: Linked fields must be arrays of record IDs ('rec...'), so resolution and writes
//       key off IDs rather than fragile display text.
//
// NOTE: the recon dropdown's resolve-by-id behaviour is a UI-layer invariant that needs a
// fixture which renders the reconciliation panel. That is tracked as a follow-up; this file
// guards the data-layer half (linked fields really are record IDs) which is what the write
// path keys off.

const { test, expect } = require('@playwright/test');
const { loadDashboard } = require('./helpers');

test.describe('Record ID Matching', () => {

  test('linked record fields in transactions are arrays of record IDs, not display names', async ({ page }) => {
    await loadDashboard(page);

    // allTransactions must be populated from the mock before this assertion is meaningful.
    await page.waitForFunction(
      () => typeof allTransactions !== 'undefined' && allTransactions.length > 0,
      { timeout: 10000 }
    );

    const result = await page.evaluate(() => {
      // Find the first transaction that actually has a linked tenancy.
      const tx = allTransactions.find(t => Array.isArray(t.fields?.['fldPmAMmxwqs4SdPa']));
      if (!tx) return { found: false };
      const tenancy = tx.fields['fldPmAMmxwqs4SdPa']; // txTenancy linked field
      return {
        found: true,
        allRecordIds: tenancy.every(id => typeof id === 'string' && id.startsWith('rec')),
      };
    });

    // The fixture wires recTx1 → recTen1, so a linked tenancy must be present.
    expect(result.found).toBe(true);
    expect(result.allRecordIds).toBe(true);
  });
});
