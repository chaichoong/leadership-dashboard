// Invariant: this suite never touches the public internet.
//
// Bug (17 Jul 2026): the pre-push gate failed at random, roughly one test in a full run,
// always with a misleading message ("the weekly cost should render on the costs tab").
// Root cause was not the app and not the assertion. Every page load fetched Chart.js from
// cdnjs (a PARSER-BLOCKING <script> in index.html:7) and DM Sans from Google Fonts
// (@import in css/tokens.css:12). When either was slow, page load stalled past the 20s
// wait in helpers.js, that timeout was swallowed by a `.catch(() => {})`, the row was
// never rendered, and the null surfaced as a nonsense assertion failure. Proven by
// delaying fonts to 25s, which reproduced the null row exactly.
//
// Why it matters beyond the flake: this suite is the pre-push gate on main. A gate that
// goes red because Google is having a moment trains everyone to reach for
// SKIP_SYNC_TESTS=1, and that is how a real regression ships.
//
// helpers.js now stubs those hosts. This test fails if a new external dependency appears
// (a CDN script, a font, an analytics beacon), because the next one would reintroduce the
// same random redness.
//
// Regression (4 Aug 2026): the guard covered ONLY the main shell at '/', so it never saw
// os/tasks/index.html — and task-drawer-comments.spec.js, which rolls its own Airtable
// mock rather than calling setupMockAirtable, let Google Fonts and the Apps Script
// endpoint out to the real internet on every run. The gate went red with a different test
// failing each time. The second test below closes that hole by walking the OS pages too.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, setupMockAirtable } = require('./helpers');

// Registered FIRST on purpose. Playwright matches routes in reverse registration order, so
// every stub added later takes precedence and this only ever sees genuinely unstubbed
// traffic. Returns the two buckets for the caller to assert on.
async function recordEscapedRequests(page) {
  const escaped = [];
  const localHandled = [];
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
      localHandled.push(url);
    } else if (!url.startsWith('data:') && !url.startsWith('blob:')) {
      escaped.push(url.split('?')[0]);
    }
    await route.continue();
  });
  return { escaped, localHandled };
}

test('no request escapes to the public internet during a dashboard load', async ({ page }) => {
  const { escaped, localHandled } = await recordEscapedRequests(page);

  await page.addInitScript((pat) => {
    localStorage.setItem('_dlr_pat', pat);
    try { indexedDB.deleteDatabase('_dlr_cache'); } catch {}
  }, MOCK_PAT);
  await setupMockAirtable(page);

  await page.goto('/');
  await page.waitForFunction(() => {
    const o = document.getElementById('loadingOverlay');
    const d = document.getElementById('dashboard');
    return (o && o.style.display === 'none') || (d && d.style.display !== 'none');
  }, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Control: if the catch-all saw nothing at all it was mis-wired and this test would
  // pass while asserting nothing — the exact failure mode a green test should never have.
  expect(localHandled.length, 'catch-all route saw no local traffic — the guard is mis-wired').toBeGreaterThan(5);

  expect(
    [...new Set(escaped)],
    'these went to the public internet — stub them in helpers.js stubExternalHosts()'
  ).toEqual([]);
});

// The OS pages load their own scripts and hit their own endpoints (Apps Script for GCal
// and Meetings, the Cloudflare workers), none of which the shell touches. They need the
// same guard, or a spec that mocks only Airtable looks hermetic and is not.
for (const osPage of ['/os/tasks/index.html', '/os/operations/index.html']) {
  test(`no request escapes to the public internet during a load of ${osPage}`, async ({ page }) => {
    const { escaped, localHandled } = await recordEscapedRequests(page);

    await page.addInitScript((pat) => {
      localStorage.setItem('_dlr_pat', pat);
      localStorage.setItem('_task_user', JSON.stringify({ key: 'kevin', name: 'Kevin Brittain', email: 'kevinbrittain@gmail.com' }));
    }, MOCK_PAT);
    await setupMockAirtable(page);

    await page.goto(osPage);
    await page.waitForTimeout(4000);

    expect(localHandled.length, 'catch-all route saw no local traffic — the guard is mis-wired').toBeGreaterThan(3);

    expect(
      [...new Set(escaped)],
      'these went to the public internet — stub them in helpers.js stubExternalHosts()'
    ).toEqual([]);
  });
}
