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

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, setupMockAirtable } = require('./helpers');

test('no request escapes to the public internet during a dashboard load', async ({ page }) => {
  const escaped = [];
  const localHandled = [];

  // Registered FIRST on purpose. Playwright matches routes in reverse registration order,
  // so every stub added later (setupMockAirtable's) takes precedence and this only ever
  // sees what nothing else claimed — i.e. genuinely unstubbed traffic.
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
      localHandled.push(url);
    } else if (!url.startsWith('data:') && !url.startsWith('blob:')) {
      escaped.push(url.split('?')[0]);
    }
    await route.continue();
  });

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
