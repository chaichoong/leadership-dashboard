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
  test('a login URL mid-line with a sentence after it still makes a sign-in card (the four live lines of 8 Sep 2026)', async ({ page }) => {
    const fx = defaultFixtures();
    fx.approvals[0].fields[TF.agentOutput] = 'Letter approved.\nSIGN-IN NEEDED: pingen.com (https://www.pingen.com/en/login) — to send the already-approved HMRC notification letter (ID b8caaaf2). Once Kevin is signed in, this task will complete the send.';
    await mockAgentsPage(page, fx);
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const strip = page.locator('[data-apv-signin-strip]');
    await expect(strip).toContainText('One task is waiting on a sign-in');
    // The site is the name, not the sentence; the host comes from the URL.
    await expect(strip.locator('.apv-signin-site')).toHaveText(/^pingen\.com \(1\)$/);
    await expect(strip.locator('.apv-signin-site')).toHaveAttribute('href', 'robotsignin://site/www.pingen.com');
    await expect(page.locator('[data-apv-signin="www.pingen.com"]')).toContainText('Waiting on a sign-in: pingen.com.');
  });
  test('sign-in waits never fold into a "one thing" group, and trigger=none gets no Why-you chip (8 Sep 2026)', async ({ page }) => {
    const fx = defaultFixtures();
    const now = new Date().toISOString();
    const AGENT = fx.approvals[0].fields[TF.teamMember];
    ['LinkedIn|https://www.linkedin.com/login', 'Stripe|https://dashboard.stripe.com/login', 'GoCardless|https://manage.gocardless.com/sign-in'].forEach((s, i) => {
      const [label, url] = s.split('|');
      fx.approvals.push({ id: 'recLapse' + i, createdTime: now, fields: {
        [TF.name]: `SIGN-IN: ${label} session lapsed`, [TF.status]: 'Approval', [TF.priority]: 'Medium',
        [TF.agentOutput]: `SIGN-IN NEEDED: ${label} (${url})\n\nThe robot's login has lapsed.\n\n**Carrying this out will involve:** Nothing until you sign in.`,
        [TF.sentForApprovalBy]: AGENT, [TF.teamMember]: AGENT, [TF.lmt]: now, [TF.taskType]: 'Admin',
      } });
    });
    fx.approvals[1].fields[TF.agentOutput] = 'CHECKED: handled=no; roy=no; machine=no; open-task=no; trigger=none\nNothing. Information only.\n\n**Carrying this out will involve:** Nothing. Information only.';
    await mockAgentsPage(page, fx);
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator('[data-apv-signin]')).toHaveCount(3);
    await expect(page.locator('.apv-group-count', { hasText: /session|sign/i })).toHaveCount(0);
    for (const id of ['recLapse0', 'recLapse1', 'recLapse2']) {
      await expect(page.locator(`[data-apv-card="${id}"]`)).toBeVisible();
    }
    await expect(page.locator('[data-apv-card="recApvA2"] [data-apv-why]')).toHaveCount(0);
  });
  test('after he signs in, the cards clear without the Refresh button (8 Sep 2026)', async ({ page }) => {
    const fx = withSignIns();
    await mockAgentsPage(page, fx);
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator('[data-apv-signin]')).toHaveCount(2);
    // Tapping a sign-in link arms the watch (the link itself is a Mac URL scheme, so stop the navigation).
    const armed = await page.evaluate(() => {
      const a = document.querySelector('[data-apv-signin-strip] a');
      a.addEventListener('click', (e) => e.preventDefault());
      a.click();
      return _apvSignInClickedAt > 0;
    });
    expect(armed).toBe(true);
    // The Robot sign-in app hands one site's task back: it leaves the Approval status.
    // In place: the mock keeps a reference to this array and reads it per request.
    fx.approvals.splice(fx.approvals.findIndex((r) => r.id === 'recApvA2'), 1);
    const changed = await page.evaluate(() => window.apvSilentRefresh());
    expect(changed).toBe(true);
    await expect(page.locator('[data-apv-signin]')).toHaveCount(1);
    await expect(page.locator('[data-apv-card="recApvA2"]')).toHaveCount(0);
    await expect(page.locator('[data-apv-signin-strip]')).toContainText('One task is waiting');
    // Nothing changed: no redraw (open panels and scroll survive).
    expect(await page.evaluate(() => window.apvSilentRefresh())).toBe(false);
  });
  test('no strip and no button when nothing waits on a sign-in', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator('[data-apv-signin-strip]')).toHaveCount(0);
    await expect(page.locator('[data-apv-signin]')).toHaveCount(0);
  });
});
