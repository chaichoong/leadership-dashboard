// Invariant: Auth token handling is secure and consistent (various commits)
// Bug: 401/403 responses didn't clear stale PAT from localStorage, causing infinite retry loops.
// Rule 1: On 401/403, localStorage PAT must be cleared and auth screen shown.
// Rule 2: PAT must be sent in Authorization header, never in URL params.
// Rule 3: Missing PAT must show auth screen, not crash.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT } = require('./helpers');

test.describe('Auth Token Handling', () => {

  test('401 response clears PAT and shows auth screen', async ({ page }) => {
    await page.addInitScript((pat) => {
      localStorage.setItem('_dlr_pat', pat);
    }, MOCK_PAT);

    // Return 401 for all API calls
    await page.route('**/api.airtable.com/v0/**', async (route) => {
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"AUTHENTICATION_REQUIRED"}' });
    });

    await page.goto('/');
    // Wait for the auth screen to become visible (the 401 triggers it)
    await page.waitForFunction(() => {
      const el = document.getElementById('authScreen');
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);

    // Auth screen should be visible
    const authVisible = await page.evaluate(() => {
      const el = document.getElementById('authScreen');
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    });
    expect(authVisible).toBe(true);

    // PAT should be cleared from localStorage
    const patCleared = await page.evaluate(() => {
      return localStorage.getItem('_dlr_pat') === null;
    });
    expect(patCleared).toBe(true);
  });

  test('missing PAT shows auth screen without crashing', async ({ page }) => {
    // Don't set any PAT — ensure localStorage is clear
    await page.addInitScript(() => {
      localStorage.removeItem('_dlr_pat');
    });

    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.goto('/');
    await page.waitForTimeout(3000);

    // Auth screen should be visible (it's the default state when no PAT)
    const authVisible = await page.evaluate(() => {
      const el = document.getElementById('authScreen');
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    });
    expect(authVisible).toBe(true);

    // Should not have uncaught page errors
    const realErrors = pageErrors.filter(e =>
      !e.includes('net::ERR') && !e.includes('Failed to fetch')
    );
    expect(realErrors).toHaveLength(0);
  });

  test('PAT sent in Authorization header not URL params', async ({ page }) => {
    let patInUrl = false;

    await page.addInitScript((pat) => {
      localStorage.setItem('_dlr_pat', pat);
    }, MOCK_PAT);

    await page.route('**/api.airtable.com/v0/**', async (route) => {
      const url = route.request().url();
      const headers = route.request().headers();

      // Check if PAT appears in URL
      if (url.includes(MOCK_PAT) || url.includes('api_key=') || url.includes('apiKey=')) {
        patInUrl = true;
      }

      // Verify Authorization header is present
      const authHeader = headers['authorization'] || headers['Authorization'];
      expect(authHeader).toContain('Bearer');

      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' });
    });

    await page.goto('/');
    await page.waitForTimeout(3000);

    expect(patInUrl).toBe(false);
  });
});
