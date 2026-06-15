// Invariant: Business dropdowns only show Active businesses (commit 9e0309a, edf1a8a)
// Bug: Inactive businesses appeared in pickers, allowing assignment to defunct entities.
// Rule: getActiveBusinesses() must filter by BIZ_ACTIVE_FIELD; inactive businesses
//       only appear if they are the CURRENT value on an existing record.

const { test, expect } = require('@playwright/test');
const { loadDashboard, loadDashboardWithFixtures, FIELDS, makeFixtures } = require('./helpers');

test.describe('Active Business Filter', () => {

  test('invoice business dropdown excludes inactive businesses', async ({ page }) => {
    await loadDashboard(page, 'invoices');
    // Switch to invoices tab
    await page.evaluate(() => switchTab('invoices'));
    await page.waitForTimeout(1000);

    // Get all business <select> options in the invoice table
    const bizOptions = await page.evaluate(() => {
      const selects = document.querySelectorAll('select');
      const options = [];
      selects.forEach(s => {
        if (s.innerHTML.includes('Active Corp') || s.innerHTML.includes('Inactive Ltd')) {
          s.querySelectorAll('option').forEach(o => {
            if (o.value) options.push(o.textContent.trim());
          });
        }
      });
      return [...new Set(options)];
    });

    // Active Corp and Another Active should be present
    expect(bizOptions).toContain('Active Corp');
    expect(bizOptions).toContain('Another Active');
    // Inactive Ltd should NOT be in any picker (unless it's the current value for recInv2)
    // recInv2 has recBiz2 (Inactive Ltd) — so the ONLY select showing it should be its own row
    const inactiveCount = await page.evaluate(() => {
      const selects = document.querySelectorAll('select');
      let count = 0;
      selects.forEach(s => {
        const opts = [...s.options].filter(o => o.textContent.includes('Inactive Ltd'));
        // Count selects where Inactive Ltd appears AND it's NOT selected
        const selected = s.value;
        const inactiveOpt = opts.find(o => o.textContent.includes('Inactive Ltd'));
        if (inactiveOpt && s.value !== inactiveOpt.value) count++;
      });
      return count;
    });
    // Inactive Ltd should not appear as an unselected option in any dropdown
    expect(inactiveCount).toBe(0);
  });

  test('inactive business is preserved as current value on existing record', async ({ page }) => {
    await loadDashboard(page, 'invoices');
    await page.evaluate(() => switchTab('invoices'));
    await page.waitForTimeout(1000);

    // recInv2 has business=recBiz2 (Inactive Ltd) — it should still show as selected
    const hasInactiveSelected = await page.evaluate(() => {
      const selects = document.querySelectorAll('select');
      for (const s of selects) {
        const selected = s.options[s.selectedIndex];
        if (selected && selected.textContent.includes('Inactive Ltd')) return true;
      }
      return false;
    });
    expect(hasInactiveSelected).toBe(true);
  });
});
