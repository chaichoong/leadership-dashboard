// Kevin, 25 Sep 2026: "Where is the signing section now? ... Ultimately it
// probably needs to be on my Operations Director app, in the AI agent section."
// The Approvals tab leads with a Robot sign-ins panel: every login the robots
// use, read from the robot-signins row that scripts/estate-status.py writes to
// the Estate Status table. The sign-in happens in the Robot sign-in app on his
// Mac, so the buttons are robotsignin:// links, and a phone shows no buttons.
const { test, expect } = require('@playwright/test');
const { TF, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

// Field ids of the Estate Status table, as the page's ES block names them.
const ES = { key: 'fldLO6xJqkokvVR4g', kind: 'fldfjQOn76VpgKEfZ', status: 'fldhOUiva3bqPNk1c',
  detail: 'fldLRFP2nJttDVQOa', payload: 'fldiqs9lvyLimoR7i', updated: 'fld3q8WN5XqrER92Z' };
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const line = (label, host, state, extra = {}) => Object.assign(
  { label, host, url: `https://${host}/`, profile: 'default', state, at: ago(90), how: '06:40 check' }, extra);

function signinRow(lines, over = {}) {
  const payload = { asOf: ago(3), lines, unlisted: ['Evernote', 'Strava'], skipped: [] };
  return { id: 'recSignins', createdTime: ago(3), fields: Object.assign({
    [ES.key]: 'robot-signins', [ES.kind]: 'report', [ES.status]: 'Worked',
    [ES.detail]: 'fixture', [ES.payload]: JSON.stringify(payload), [ES.updated]: ago(3) }, over) };
}
const MIXED = [
  line('EDF Energy', 'www.edfenergy.com', 'signed-out'),
  line('Utilita Apartment 1', 'my.utilita.co.uk', 'signed-out', { profile: 'utilita-apt1', how: 'hourly read' }),
  line('Pingen (letters)', 'app.pingen.com', 'signed-in'),
  line('HMRC', 'tax.service.gov.uk', 'on-demand', { at: null, how: 'short login' }),
  line('Loom (video archive)', 'loom.com', 'you-signed-in', { at: ago(4), how: 'you signed in' }),
];

async function open(page, estate, extra = {}) {
  const fx = Object.assign(defaultFixtures(), { estate }, extra);
  await mockAgentsPage(page, fx);
  await loadAgentsPage(page);
  await page.click('#ptab-approvals');
  return page.locator('#signinsBody');
}

test.describe('Robot sign-ins panel on a Mac', () => {
  test.use({ userAgent: MAC_UA });

  test('what needs him leads, each with its own Sign in link; a flat opens its own profile', async ({ page }) => {
    const panel = await open(page, [signinRow(MIXED)]);
    await expect(panel).toContainText('2 sign-ins need you: EDF Energy, Utilita Apartment 1.');
    await expect(page.locator('#signinsCount')).toHaveText('2');
    await expect(panel.locator('[data-rs-signin="www.edfenergy.com"]')).toHaveAttribute('href', 'robotsignin://site/www.edfenergy.com');
    // One flat, not both: /site/my.utilita.co.uk would open every flat on that host.
    await expect(panel.locator('[data-rs-signin="utilita-apt1"]')).toHaveAttribute('href', 'robotsignin://profile/utilita-apt1');
    await expect(panel.locator('[data-rs-add]')).toHaveAttribute('href', 'robotsignin://add');
    // What he has just signed in to stays on show, with no button and no green claim.
    const mine = panel.locator('[data-rs-line="you-signed-in"]');
    await expect(mine).toContainText('Loom (video archive)');
    await expect(mine).toContainText('The robot confirms it at its next check.');
    await expect(mine.locator('a')).toHaveCount(0);
    // The rest waits behind "Show all".
    await expect(panel.locator('[data-rs-line="signed-in"]')).toHaveCount(0);
    await panel.locator('[data-rs-toggle]').click();
    await expect(panel.locator('[data-rs-toggle]')).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.locator('[data-rs-line="signed-in"]')).toContainText('Pingen (letters)');
    await expect(panel.locator('[data-rs-line="on-demand"]')).toContainText('Short login: sign in when a task asks for it');
    await expect(panel.locator('[data-rs-signin="tax.service.gov.uk"]')).toHaveAttribute('href', 'robotsignin://site/tax.service.gov.uk');
    // A login with no sign-in page on file is named, never hidden.
    await expect(panel).toContainText('No sign-in page on file yet, so not listed: Evernote, Strava.');
  });

  test('all good is one line, and nothing asks for a tap until the list is opened', async ({ page }) => {
    const panel = await open(page, [signinRow([line('Pingen (letters)', 'app.pingen.com', 'signed-in'),
      line('HMRC', 'tax.service.gov.uk', 'on-demand', { at: null })])]);
    await expect(panel).toContainText('All good. 1 signed in, 1 sign in when a task needs them.');
    await expect(page.locator('#signinsCount')).toHaveText('0');
    await expect(panel.locator('[data-rs-signin]')).toHaveCount(0);
    await expect(panel.locator('[data-rs-toggle]')).toHaveText('Show all 2');
  });

  test('a failed refresh, a stale row and a missing row each say so; none reads as an empty list', async ({ page }) => {
    let panel = await open(page, [signinRow(MIXED, { [ES.status]: 'Failed', [ES.detail]: 'node not found' })]);
    await expect(panel).toContainText('The sign-in list could not be refreshed: node not found');
    await expect(panel.locator('[data-rs-signin="www.edfenergy.com"]')).toBeVisible();   // the last good list stays
    panel = await open(page, [signinRow(MIXED, { [ES.updated]: ago(95) })]);
    await expect(panel).toContainText('The estate-status job that refreshes it has stopped');
    panel = await open(page, [signinRow(MIXED, { [ES.payload]: '{"lines":[' })]);
    await expect(panel).toContainText('The sign-in list could not be read');
    await expect(page.locator('#signinsCount')).toHaveText('?');
    panel = await open(page, [signinRow([])]);
    await expect(panel).toContainText('The sign-in list could not be read');   // never "All good. 0 signed in"
    await expect(panel).not.toContainText('All good');
    panel = await open(page, []);
    await expect(panel).toContainText('No sign-in list yet.');
  });

  test('the waiting-task strip now leads the panel, not the queue', async ({ page }) => {
    const fx = defaultFixtures();
    fx.approvals = fx.approvals.map((r, i) => {
      if (i === 0) r.fields[TF.agentOutput] = 'Letter built.\nSIGN-IN NEEDED: Pingen (https://app.pingen.com/)';
      return r;
    });
    const panel = await open(page, [signinRow(MIXED)], { approvals: fx.approvals });
    await expect(panel.locator('[data-apv-signin-strip]')).toContainText('One task is waiting on a sign-in');
    await expect(page.locator('#approvalsBody [data-apv-signin-strip]')).toHaveCount(0);
    // The card keeps its own Sign in now button.
    await expect(page.locator('[data-apv-signin="app.pingen.com"] a', { hasText: 'Sign in now' })).toHaveAttribute('href', 'robotsignin://site/app.pingen.com');
  });
});

test.describe('Robot sign-ins panel on a phone', () => {
  test.use({ userAgent: PHONE_UA });

  test('shows where each sign-in stands, with no button that cannot work there', async ({ page }) => {
    const panel = await open(page, [signinRow(MIXED)]);
    await expect(panel).toContainText('2 sign-ins need you: EDF Energy, Utilita Apartment 1.');
    await expect(panel.locator('a[href^="robotsignin://"]')).toHaveCount(0);
    await expect(panel.locator('[data-rs-line="signed-out"]').first()).toContainText('Sign in on your Mac');
    await expect(panel).toContainText("Sign-ins open on your Mac, where the robots' browser lives.");
  });
});
