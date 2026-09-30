// THE FRAME FILLS THE SCREEN, AND THE QUEUE STARTS HIGH (Kevin, 30 Sep 2026).
//
// "We're not using the full screen real estate on the page... it doesn't
// stretch down to the bottom of the screen before we scroll." Measured at
// 1440 x 900: every framed page's iframe started 30px down and ended 10px
// past the bottom of the screen, so the whole app scrolled 26px on top of the
// page's own scrolling (a 20px top margin plus the gap under an inline
// iframe). And inside AI Agents, the first approval card started 445px down
// an 880px frame, under a pinned 73px title bar with a subtitle.
//
// These tests load the real shell and measure. The shared frame rule covers
// all 12 framed pages, so one page (AI Agents) is enough to catch it.

const { test, expect } = require('@playwright/test');
const { mockAgentsPage, defaultFixtures } = require('./agents-page.helpers');

for (const [w, h] of [[1440, 900], [1920, 1080]]) {
  test(`at ${w}x${h} the framed page fits the screen with no outer scroll`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await mockAgentsPage(page, defaultFixtures());
    await page.goto('/');
    await page.waitForFunction(() => typeof switchTab === 'function', { timeout: 20000 });
    await page.evaluate(() => switchTab('agents'));
    await page.frameLocator('#agentsFrame').locator('#ptab-approvals').click({ timeout: 20000 });
    await page.frameLocator('#agentsFrame').locator('.apv-card').first().waitFor({ timeout: 20000 });
    const m = await page.evaluate(() => {
      const f = document.getElementById('agentsFrame').getBoundingClientRect();
      return { vh: innerHeight, docH: document.documentElement.scrollHeight, top: f.top, bottom: f.bottom };
    });
    // The whole app does not scroll: only the page inside the frame does.
    expect(m.docH).toBeLessThanOrEqual(m.vh);
    // The frame starts near the top and reaches near the bottom, inside the screen.
    expect(m.top).toBeLessThanOrEqual(12);
    expect(m.bottom).toBeLessThanOrEqual(m.vh);
    expect(m.bottom).toBeGreaterThanOrEqual(m.vh - 12);
  });
}

test('Tasks and Operations frames fit the screen too: the rule is shared', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockAgentsPage(page, defaultFixtures());
  await page.goto('/');
  await page.waitForFunction(() => typeof switchTab === 'function', { timeout: 20000 });
  for (const [tab, frame] of [['tasks', 'tasksFrame'], ['operations', 'operationsFrame']]) {
    await page.evaluate((t) => switchTab(t), tab);
    await expect(page.locator('#' + frame)).toBeVisible();
    const m = await page.evaluate((id) => {
      const f = document.getElementById(id).getBoundingClientRect();
      return { vh: innerHeight, docH: document.documentElement.scrollHeight, top: f.top, bottom: f.bottom };
    }, frame);
    expect(m.docH, tab).toBeLessThanOrEqual(m.vh);
    expect(m.top, tab).toBeLessThanOrEqual(12);
    expect(m.bottom, tab).toBeLessThanOrEqual(m.vh);
    expect(m.bottom, tab).toBeGreaterThanOrEqual(m.vh - 12);
  }
});

test('AI Agents: the pinned title bar is one slim line and the first approval card starts higher', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 880 });
  await mockAgentsPage(page, defaultFixtures());
  await page.goto('/os/agents/index.html');
  await page.waitForSelector('#main', { state: 'visible', timeout: 20000 });
  await page.click('#ptab-approvals');
  await page.locator('.apv-card').first().waitFor();
  const bar = await page.locator('.topbar').boundingBox();
  expect(bar.height).toBeLessThanOrEqual(50);          // was 73; 47 after the change
  const card = await page.locator('.apv-card').first().boundingBox();
  expect(card.y).toBeLessThanOrEqual(430);             // was 445; 419 after the change
  // Nothing lost: the description is the heading's hover text.
  await expect(page.locator('.topbar h1')).toHaveAttribute('title', /approvals in priority order/);
});
