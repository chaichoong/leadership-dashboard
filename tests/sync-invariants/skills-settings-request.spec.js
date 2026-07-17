// Invariant: the Skills tab reads its active-preset setting with a bare single-record GET.
// Bug (found by the prod E2E sweep, 17 Jul 2026): js/skills.js built the settings URL as
//   GET /v0/{base}/tblHGNzDmOs59r9QD/recqbcIz2R2griDn3?fields[]=Active%20Skill%20IDs
// Airtable's SINGLE-RECORD GET endpoint rejects the fields[] parameter with a 422 (only the
// LIST endpoint accepts it), so the fetch failed on every Skills tab load. It was invisible
// because `if (!res.ok) return;` swallowed it, and the "Active" filter counts silently stale.
//
// Rule 1: the settings request must NOT carry a fields[] param — that is what caused the 422.
// Rule 2: it must stay on the single-record endpoint (.../{table}/{record}), NOT the list
//   endpoint. This is a SECURITY rule, not a style one. That table keys rows by Name and
//   another row ('PROXY_SERVICE_TOKEN', read by scripts/monthly-valuations.py) stores a live
//   service token in the very same 'Active Skill IDs' field. The list endpoint returns every
//   row, so "fixing" a future 422 by switching to list would pull that secret into the
//   browser on every Skills tab load. A single-record GET can only ever return SETTINGS_RECORD.
// Rule 3: a failed settings fetch must not break the tab — the skills still render.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, setupMockAirtable } = require('./helpers');

const SETTINGS_TABLE = 'tblHGNzDmOs59r9QD';
const SETTINGS_RECORD = 'recqbcIz2R2griDn3';

// Playwright matches routes in REVERSE registration order, so this must be registered
// AFTER setupMockAirtable or its /v0/** catch-all wins and nothing is captured.
async function captureSettingsRequests(page, { status = 200, body = null } = {}) {
  const calls = [];
  await page.route(`**/api.airtable.com/v0/**/${SETTINGS_TABLE}**`, async (route) => {
    calls.push({ url: route.request().url(), method: route.request().method() });
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: body !== null ? body : JSON.stringify({
        id: SETTINGS_RECORD,
        fields: { Name: 'System Record' }, // 'Active Skill IDs' empty, as in production
      }),
    });
  });
  return calls;
}

async function openSkillsTab(page) {
  await page.addInitScript((pat) => {
    localStorage.setItem('_dlr_pat', pat);
    try { indexedDB.deleteDatabase('_dlr_cache'); } catch {}
  }, MOCK_PAT);
  await page.goto('/');
  await page.waitForFunction(() => typeof window.switchTab === 'function', { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => window.switchTab('skills'));
  await page.waitForTimeout(2500);
}

test.describe('Skills active-preset settings request', () => {

  test('settings GET carries no fields[] param and uses the single-record endpoint', async ({ page }) => {
    await setupMockAirtable(page);
    const calls = await captureSettingsRequests(page); // registered last so it wins
    await openSkillsTab(page);

    const gets = calls.filter(c => c.method === 'GET');
    expect(gets.length).toBeGreaterThan(0); // control: if this is 0 the test asserts nothing

    for (const c of gets) {
      // Rule 1 — the 422 cause. Airtable 422s a single-record GET carrying fields[].
      expect(c.url).not.toContain('fields[]');
      expect(c.url).not.toContain('fields%5B%5D');

      // Rule 2 — must target the one record, never the whole table (token exposure).
      const path = new URL(c.url).pathname;
      expect(path.endsWith(`/${SETTINGS_TABLE}/${SETTINGS_RECORD}`)).toBe(true);
    }
  });

  test('a failed settings fetch leaves the Skills tab rendering', async ({ page }) => {
    await setupMockAirtable(page);
    // registered last so it wins
    const calls = await captureSettingsRequests(page, { status: 422, body: '{"error":{"type":"INVALID_REQUEST_UNKNOWN"}}' });

    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await openSkillsTab(page);

    // Control: if the settings fetch never fired, this test is asserting nothing.
    expect(calls.length).toBeGreaterThan(0);

    // Assert on real rendered output, NOT the panel's innerHTML length — #tab-skills
    // ships static markup in index.html, so a length check passes even when the list
    // renders nothing at all.
    const cardCount = await page.locator('#skillsLibraryContent .skills-card').count();
    expect(cardCount).toBeGreaterThan(0);

    const realErrors = pageErrors.filter(e => !e.includes('net::ERR') && !e.includes('Failed to fetch'));
    expect(realErrors).toHaveLength(0);
  });
});
