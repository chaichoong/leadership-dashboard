// A task waiting on a site sign-in is a wait, not a decision (Kevin's ruling,
// 4 Sep 2026). The card must show a "Sign in now" link that opens the Robot
// sign-in app on his Mac at that site, and the queue must lead with a strip
// naming every site waiting, with one link that does them all in turn.
const { test, expect } = require('@playwright/test');
const { TF, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

function withSignIns() {
  const fx = defaultFixtures();
  fx.approvals = fx.approvals.map((r, i) => {
    if (i === 0) r.fields[TF.agentOutput] = 'Verified from the public register.\nSIGN-IN NEEDED: Companies House WebFiling (https://ewf.companieshouse.gov.uk/seclogin?tc=1)';
    if (i === 1) r.fields[TF.agentOutput] = 'Letter built.\nSIGN-IN NEEDED: Pingen (https://app.pingen.com/)';
    return r;
  });
  return fx;
}

test.describe('sign-ins waiting are a tap, not a decision', () => {
  test('the strip names each site with its count and offers all of them in one link', async ({ page }) => {
    await mockAgentsPage(page, withSignIns());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const strip = page.locator('[data-apv-signin-strip]');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText('2 tasks are waiting on a sign-in');
    await expect(strip.locator('a', { hasText: 'Sign in to all (2)' })).toHaveAttribute('href', 'robotsignin://all');
    await expect(strip.locator('.apv-signin-site', { hasText: 'Companies House WebFiling' })).toHaveAttribute('href', 'robotsignin://site/ewf.companieshouse.gov.uk');
    await expect(strip.locator('.apv-signin-site', { hasText: 'Pingen' })).toHaveAttribute('href', 'robotsignin://site/app.pingen.com');
  });
  test('the card carries its own Sign in now link to that site', async ({ page }) => {
    await mockAgentsPage(page, withSignIns());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const box = page.locator('[data-apv-signin="app.pingen.com"]');
    await expect(box).toBeVisible();
    await expect(box).toContainText('Not a decision');
    await expect(box.locator('a', { hasText: 'Sign in now' })).toHaveAttribute('href', 'robotsignin://site/app.pingen.com');
  });
  test('no strip and no button when nothing waits on a sign-in', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator('[data-apv-signin-strip]')).toHaveCount(0);
    await expect(page.locator('[data-apv-signin]')).toHaveCount(0);
  });
});
