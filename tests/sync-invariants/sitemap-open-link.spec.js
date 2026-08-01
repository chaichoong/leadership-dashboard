// Site Map — the "Open" column must never be a dead click.
//
// Found by the drift monitor 2026-07-30. Three of the 27 registered pages have
// no in-app panel — compliance, crm and how-it-works live only as standalone
// files. The Site Map renders the same `switchTab(id)` link for every row, so
// those three rows offered an Open link that could not open anything in-app.
//
// The "nothing happens" half of that report did not reproduce. switchTab has
// guarded this since 2026-07-15 (js/shared.js): no `tab-<id>` element plus a
// standalone entry in PAGE_REGISTRY means open the standalone file in a new
// tab, and a real click does exactly that. The original check called
// switchTab() from the console, where window.open is not user-initiated and the
// popup blocker eats it silently — which looks identical to a dead link.
//
// What was real: the row gave no warning it was about to leave the app, and it
// depended on window.open, so a blocked popup left the user with no route and
// no message. These tests pin both halves:
//   1. the row routes somewhere real (test 2 — passes pre-fix, pins the route), and
//   2. the label says so BEFORE the click (test 3 — the one that catches the bug).
//
// The Site Map is client-facing now, so a silent dead click is worse than an
// error — it reads as the app being slow.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures } = require('./helpers');

// The three standalone-only pages, as of 2026-08-01. Derived in the test from
// the live registry rather than hardcoded, so a new standalone page is covered
// the day it is added.
async function standaloneOnlyIds(page) {
  return page.evaluate(() =>
    (PAGE_REGISTRY || [])
      .filter((p) => !document.getElementById('tab-' + p.id))
      .map((p) => p.id)
  );
}

test.describe('Site Map Open column', () => {
  test('every registered page has a panel or a standalone file — never neither', async ({ page }) => {
    await loadDashboardWithFixtures(page, {}, 'sitemap');
    await page.waitForTimeout(800);

    // A page with no panel AND no standalone file has nowhere to go at all.
    // switchTab would deactivate every panel and blank the content area.
    const orphans = await page.evaluate(() =>
      (PAGE_REGISTRY || [])
        .filter((p) => !document.getElementById('tab-' + p.id) && !p.standalone)
        .map((p) => p.id)
    );
    expect(orphans).toEqual([]);
  });

  test('a standalone-only row opens its real page in a new tab', async ({ page, context }) => {
    await loadDashboardWithFixtures(page, {}, 'sitemap');
    await page.waitForTimeout(800);

    const ids = await standaloneOnlyIds(page);
    expect(ids.length).toBeGreaterThan(0); // control: the case under test exists

    const id = ids[0];
    const expected = await page.evaluate(
      (pid) => PAGE_REGISTRY.find((p) => p.id === pid).standalone,
      id
    );

    // A REAL click, not switchTab() from the console. window.open only counts
    // as user-initiated inside a trusted event, so calling the function
    // directly looks like "nothing happened" — which is how this was first
    // mis-diagnosed as a dead link with no route at all.
    const row = page.locator('#sitemapTableBody tr', { has: page.locator(`[data-open-page="${id}"]`) });
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      row.locator(`[data-open-page="${id}"]`).click(),
    ]);
    expect(popup.url()).toContain(expected);
    await popup.close();

    // and the app behind it is untouched — still on the Site Map, not blanked
    await expect(page.locator('#tab-sitemap')).toHaveClass(/active/);
    await expect(page.locator('#sitemapTableBody')).not.toBeEmpty();
  });

  test('a standalone-only row says it opens a new tab, before it is clicked', async ({ page }) => {
    await loadDashboardWithFixtures(page, {}, 'sitemap');
    await page.waitForTimeout(800);

    const ids = await standaloneOnlyIds(page);
    for (const id of ids) {
      const link = page.locator(`#sitemapTableBody [data-open-page="${id}"]`);
      await expect(link).toHaveCount(1);
      // Labelled distinctly from an in-app tab switch. If a popup blocker eats
      // the new tab, the label is the only thing telling Kevin what to expect.
      await expect(link).toContainText('Open ↗');
      await expect(link).toHaveAttribute('title', /new tab/i);
    }
  });

  test('an in-app page still switches tab in place, with no popup', async ({ page, context }) => {
    await loadDashboardWithFixtures(page, {}, 'sitemap');
    await page.waitForTimeout(800);

    // pnl has a real panel — the ordinary case must not regress into a popup.
    const before = context.pages().length;
    await page.locator('#sitemapTableBody [data-open-page="pnl"]').click();
    await page.waitForTimeout(600);
    expect(context.pages().length).toBe(before);
    await expect(page.locator('#tab-pnl')).toHaveClass(/active/);
  });
});
