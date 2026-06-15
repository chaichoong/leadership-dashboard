// Invariant: App must load without JavaScript errors on any tab (meta-invariant from all fixes)
// Many bugs manifested as silent crashes on load — undefined variables, missing functions,
// null references from empty API responses.
// Rule: Every tab must render without uncaught exceptions when given valid mock data.

const { test, expect } = require('@playwright/test');
const { loadDashboard } = require('./helpers');

// Only tabs that have a matching tab-panel element in index.html
const TABS = ['overview', 'cfv', 'invoices', 'costs', 'fintable', 'sitemap', 'pnl', 'transactions'];

test.describe('No Crash on Load', () => {

  for (const tab of TABS) {
    test(`tab "${tab}" loads without uncaught errors`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));

      await loadDashboard(page, tab);

      // Try to activate the tab
      await page.evaluate((t) => switchTab(t), tab);
      await page.waitForTimeout(1000);

      // Filter out expected errors (e.g. network errors from non-mocked resources)
      const realErrors = errors.filter(e =>
        !e.includes('net::ERR') && !e.includes('Failed to fetch') && !e.includes('NetworkError')
      );
      expect(realErrors).toHaveLength(0);
    });
  }

  test('switching between all tabs does not crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await loadDashboard(page);

    for (const tab of TABS) {
      await page.evaluate((t) => switchTab(t), tab);
      await page.waitForTimeout(500);
    }

    const realErrors = errors.filter(e =>
      !e.includes('net::ERR') && !e.includes('Failed to fetch') && !e.includes('NetworkError')
    );
    expect(realErrors).toHaveLength(0);
  });
});
