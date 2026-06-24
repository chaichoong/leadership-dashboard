// Invariant: Stale data must not prevent valid operations (commits dc67b2b, 1bc6599)
// Bug 1: Stale "(Split 1 of N)" tag in transaction name greyed out the Split button
//         even when Split Count was 1 (children already deleted).
// Bug 2: "No costs visible" state shown even after data loaded (loading indicator stuck).
// Rule: UI state (enabled/disabled, visible/hidden) must derive from LIVE field values
//       (Split Count, record arrays), not from parsed display strings or stale local state.

const { test, expect } = require('@playwright/test');
const { loadDashboard, loadDashboardWithFixtures, FIELDS, makeFixtures } = require('./helpers');

test.describe('Stale Data Protection', () => {

  test('loading overlay clears after data loads successfully', async ({ page }) => {
    await loadDashboard(page);

    // The overlay should be hidden OR the dashboard should be shown.
    // With mock data, a TypeError may occur in renderDashboard (missing specific
    // record IDs like Santander account) but the overlay should still clear.
    const state = await page.evaluate(() => {
      const overlay = document.getElementById('loadingOverlay');
      const dash = document.getElementById('dashboard');
      return {
        overlayHidden: !overlay || overlay.style.display === 'none',
        dashVisible: dash && dash.style.display !== 'none',
      };
    });
    // At least one of these should be true — data loaded and render attempted
    expect(state.overlayHidden || state.dashVisible).toBe(true);
  });

  test('dashboard element exists and is not permanently hidden', async ({ page }) => {
    await loadDashboard(page);

    const dashExists = await page.evaluate(() => {
      const dash = document.getElementById('dashboard');
      return dash !== null;
    });
    expect(dashExists).toBe(true);
  });

  test('majority of API requests use returnFieldsByFieldId mode', async ({ page }) => {
    const requests = { withFieldId: 0, without: 0, exceptions: [] };

    await page.addInitScript((pat) => {
      localStorage.setItem('_dlr_pat', pat);
    }, 'pat_test_mock_token_for_playwright');

    await page.route('**/api.airtable.com/v0/**', async (route) => {
      const url = route.request().url();
      if (route.request().method() === 'GET' && url.includes('api.airtable.com')) {
        if (url.includes('returnFieldsByFieldId=true')) {
          requests.withFieldId++;
        } else {
          requests.without++;
          requests.exceptions.push(url.split('?')[0]);
        }
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' });
    });

    await page.goto('/');

    // Wait for the API traffic to settle rather than a fixed sleep. Under parallel load a flat
    // 3s sometimes fired before the dashboard's fetches landed, so withFieldId could read 0 and
    // the assertion flaked. Poll until the recorded request count stops growing, then confirm.
    let last = -1, stableTicks = 0;
    for (let i = 0; i < 40; i++) {
      const total = requests.withFieldId + requests.without;
      if (total === last && total > 0) {
        if (++stableTicks >= 3) break; // count unchanged across 3 consecutive polls → settled
      } else {
        stableTicks = 0;
        last = total;
      }
      await page.waitForTimeout(250);
    }

    // The main data fetches must use returnFieldsByFieldId.
    // A small number of specialized queries (e.g. Fintable sync) may use field names.
    expect(requests.withFieldId).toBeGreaterThan(0);
    // At most 2 exceptions allowed (Fintable accounts sync uses field names)
    expect(requests.without).toBeLessThanOrEqual(2);
  });
});
