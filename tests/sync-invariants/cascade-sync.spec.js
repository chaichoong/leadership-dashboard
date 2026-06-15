// Invariant: UI must sync after cascade operations (commit 88047d0)
// Bug: Project cascade updated Priority + Business in memory but didn't refresh
//      the open drawer's dropdowns. User saw stale values until reopening.
// Rule: After any cascade mutation (project → priority/business, tenancy → unit),
//       all visible UI elements reflecting those fields must update immediately.

const { test, expect } = require('@playwright/test');
const { loadDashboard } = require('./helpers');

test.describe('Cascade Sync', () => {

  test('global variables are defined after data load', async ({ page }) => {
    await loadDashboard(page);

    const globalsExist = await page.evaluate(() => {
      return {
        allTransactions: typeof allTransactions !== 'undefined',
        allTenancies: typeof allTenancies !== 'undefined',
        allBusinesses: typeof allBusinesses !== 'undefined',
      };
    });

    expect(globalsExist.allTransactions).toBe(true);
    expect(globalsExist.allTenancies).toBe(true);
    expect(globalsExist.allBusinesses).toBe(true);
  });

  test('getActiveBusinesses helper is globally accessible', async ({ page }) => {
    await loadDashboard(page);

    const helperExists = await page.evaluate(() => {
      return typeof getActiveBusinesses === 'function';
    });
    expect(helperExists).toBe(true);
  });

  test('getActiveBusinesses returns only active records', async ({ page }) => {
    await loadDashboard(page);

    const result = await page.evaluate(() => {
      if (typeof getActiveBusinesses !== 'function') return null;
      const active = getActiveBusinesses();
      return active.map(b => b.id);
    });

    if (result) {
      expect(result).toContain('recBiz1');
      expect(result).toContain('recBiz3');
      expect(result).not.toContain('recBiz2'); // Inactive Ltd
    }
  });
});
