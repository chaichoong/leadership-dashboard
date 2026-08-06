// Invariant: the AI Reconciliation Accuracy card must measure EVERY audit row in the
// window, and must record which field missed.
//
// Bug (found by the 6 Aug 2026 e2e sweep): refreshReconAccuracyStats() fetched the audit
// table with `pageSize=100` and never followed the `offset` token. There were 259 rows in
// the last 31 days, so the card measured the first 100 and displayed "66/100 correct" as
// though it were the whole population. The true figure was 167/259 = 64%.
//
// Why this spec and not the existing `pagination-dedup` one: that spec guards
// `airtableFetch()`, the shared helper that DOES paginate. refreshReconAccuracyStats()
// hand-rolls its own `fetch`, which is exactly how it slipped past that guard. Any other
// hand-rolled Airtable read is vulnerable the same way.
//
// The second and third tests guard the diagnostics added alongside the fix: a headline
// that is graded all-or-nothing across seven fields cannot be acted on unless the audit
// says WHICH field missed and WHICH matcher produced the suggestion.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, loadDashboard } = require('./helpers');

const AUDIT_TABLE = 'tblbfuxYxu4uMMWwT';
const F_ACC = 'fld9n62GxQijQWqSA';   // Was Accurate (checkbox)
const F_MISS = 'fldm4i2tYHhi4jFJb';  // Mismatched Fields (CSV)
const F_TYPE = 'fld2Vv0QJ2dNq5iVv';  // Match Type

// Build `n` audit rows. `accurateEvery` controls how many are marked correct.
function auditRows(prefix, n, opts = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const accurate = opts.allAccurate ?? (i % 2 === 0);
    rows.push({
      id: `${prefix}${i}`,
      fields: {
        [F_ACC]: accurate,
        [F_MISS]: accurate ? '' : (opts.missField || 'propertyId'),
        [F_TYPE]: opts.matchType || 'Vendor',
      },
    });
  }
  return rows;
}

// Route the audit table across pages, handing everything else to the standard fixture mock.
//
// Register this AFTER loadDashboard(), never before. loadDashboard() calls
// setupMockAirtable() internally, and Playwright matches the most recently registered
// handler first — so a route added beforehand is shadowed by the generic mock and never
// runs, which silently yields `{records:[]}` and a null stats object.
async function routeAuditPages(page, pages) {
  await page.route('**/api.airtable.com/v0/**', async (route) => {
    const url = route.request().url();
    if (!url.includes(AUDIT_TABLE) || route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const m = url.match(/offset=([^&]+)/);
    const key = m ? decodeURIComponent(m[1]) : 'page0';
    const body = pages[key];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body || { records: [] }),
    });
  });
}

test.describe('AI Reconciliation Accuracy stats', () => {

  test('counts every page of audit rows, not just the first 100', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await routeAuditPages(page, {
      page0: { records: auditRows('recA', 100), offset: 'page1' },
      page1: { records: auditRows('recB', 100), offset: 'page2' },
      page2: { records: auditRows('recC', 59) },
    });

    const stats = await page.evaluate(async () => await refreshReconAccuracyStats());

    // The regression: an un-paged read stops at exactly 100.
    expect(stats.total).toBe(259);
    expect(stats.total).not.toBe(100);
    // 130 accurate across the even indices of 100/100/59 -> 50 + 50 + 30.
    expect(stats.accurate).toBe(130);
    expect(stats.pct).toBe(Math.round((130 / 259) * 100));
  });

  test('records which field missed, so the score is actionable', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await routeAuditPages(page, {
      page0: { records: [
        ...auditRows('recP', 10, { missField: 'propertyId' }),
        ...auditRows('recT', 4, { missField: 'tenancyId' }),
      ] },
    });

    const stats = await page.evaluate(async () => await refreshReconAccuracyStats());

    // 5 of 10 and 2 of 4 are inaccurate (odd indices).
    expect(stats.byField.propertyId).toBe(5);
    expect(stats.byField.tenancyId).toBe(2);
    // Property is the biggest offender, so the card can name it.
    const worst = Object.entries(stats.byField).sort((a, b) => b[1] - a[1])[0];
    expect(worst[0]).toBe('propertyId');
  });

  test('splits accuracy by matcher, so "is it learning?" is answerable', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await routeAuditPages(page, {
      page0: { records: [
        // Knowledge Base rows come from Kevin's own past corrections: all correct.
        ...auditRows('recKB', 10, { matchType: 'Knowledge Base', allAccurate: true }),
        // Cold vendor guesses: half correct.
        ...auditRows('recV', 10, { matchType: 'Vendor' }),
      ] },
    });

    const stats = await page.evaluate(async () => await refreshReconAccuracyStats());

    expect(stats.byMatchType['Knowledge Base'].pct).toBe(100);
    expect(stats.byMatchType['Vendor'].pct).toBe(50);
    // The whole point: corrections must outperform cold guesses, or nothing is being learned.
    expect(stats.byMatchType['Knowledge Base'].pct)
      .toBeGreaterThan(stats.byMatchType['Vendor'].pct);
  });
});
