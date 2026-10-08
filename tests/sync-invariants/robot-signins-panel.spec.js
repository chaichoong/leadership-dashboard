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

  test('a site that stops the robot with a bot check is shown, never counted as a sign-in, and has no button (25 Sep 2026)', async ({ page }) => {
    const panel = await open(page, [signinRow([line('Pingen (letters)', 'app.pingen.com', 'signed-in'),
      line('dash.cloudflare.com', 'dash.cloudflare.com', 'bot-check', { how: 'robot check' })])]);
    await expect(panel).toContainText('No sign-in needed. One site stops the robot with a bot check, which a sign-in cannot fix: dash.cloudflare.com. 1 signed in, 0 sign in when a task needs them.');
    await expect(panel).not.toContainText('All good');
    await expect(page.locator('#signinsCount')).toHaveText('0');
    const bot = panel.locator('[data-rs-line="bot-check"]');
    await expect(bot).toContainText('dash.cloudflare.com');
    await expect(bot).toContainText('Signing in will not help.');
    await expect(bot.locator('a')).toHaveCount(0);
  });

  test('all good is one line, and nothing asks for a tap until the list is opened', async ({ page }) => {
    const panel = await open(page, [signinRow([line('Pingen (letters)', 'app.pingen.com', 'signed-in'),
      line('HMRC', 'tax.service.gov.uk', 'on-demand', { at: null })])]);
    await expect(panel).toContainText('All good. 1 signed in, 1 sign in when a task needs them.');
    await expect(page.locator('#signinsCount')).toHaveText('0');
    await expect(panel.locator('[data-rs-signin]')).toHaveCount(0);
    await expect(panel.locator('[data-rs-toggle]')).toHaveText('Show all 2');
    // The keyboard stays on the toggle through the redraw, and each button names its site.
    await panel.locator('[data-rs-toggle]').focus();
    await page.keyboard.press('Enter');
    await expect(panel.locator('[data-rs-toggle]')).toBeFocused();
    await expect(panel.locator('[data-rs-signin="tax.service.gov.uk"]')).toHaveAttribute('aria-label', 'Sign in to HMRC');
  });

  test('a site that keeps signing out after his sign-ins is not asked for, and says why (2 Oct 2026)', async ({ page }) => {
    // The real case: BW Legal's portal, which has no account yet, asked for every morning.
    const panel = await open(page, [signinRow([line('Pingen (letters)', 'app.pingen.com', 'signed-in'),
      line('portal.bwlegal.co.uk', 'portal.bwlegal.co.uk', 'on-demand', { how: 'did not stay signed in' })])]);
    await expect(panel).toContainText('All good. 1 signed in, 1 sign in when a task needs them.');
    await expect(page.locator('#signinsCount')).toHaveText('0');
    await panel.locator('[data-rs-toggle]').click();
    const ln = panel.locator('[data-rs-line="on-demand"]');
    await expect(ln).toContainText('Keeps signing out after you sign in: sign in when a task asks for it');
    await expect(ln).not.toContainText('Short login');
    await expect(panel.locator('[data-rs-signin="portal.bwlegal.co.uk"]')).toHaveAttribute('href', 'robotsignin://site/portal.bwlegal.co.uk');
  });

  test('the keyboard stays on a Sign in button through a redraw, and the change is said once', async ({ page }) => {
    const panel = await open(page, [signinRow(MIXED)]);
    await panel.locator('[data-rs-signin="utilita-apt1"]').focus();
    await page.evaluate(() => renderSignins());   // the 30-second re-read redraws the whole panel
    await expect(panel.locator('[data-rs-signin="utilita-apt1"]')).toBeFocused();
    await expect(page.locator('#signinsLive')).toHaveText('2 robot sign-ins need you');
    await expect(page.locator('#signinsLive')).toHaveAttribute('role', 'status');
    // The redraw never pulls the page back up to the panel while he works the queue below.
    await page.setViewportSize({ width: 1000, height: 400 });
    await page.evaluate(() => { document.body.style.minHeight = '4000px'; window.scrollTo(0, 1500); });
    const before = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => renderSignins());
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    await expect(panel.locator('[data-rs-signin="utilita-apt1"]')).toBeFocused();
    // An unreadable list says so in the live region too.
    await page.evaluate(() => { _estateState = 'error: boom'; renderSignins(); });
    await expect(page.locator('#signinsLive')).toHaveText('Robot sign-ins could not be read');
  });

  test('the health-bar check fails on any mark but Worked, as the panel warns', async ({ page }) => {
    await open(page, [signinRow(MIXED, { [ES.status]: 'Idle', [ES.detail]: 'No longer scheduled' })]);
    expect(await page.evaluate(() => signinsHealth())).toEqual({ status: 'fail', detail: 'Idle: No longer scheduled' });
    await open(page, [signinRow(MIXED)]);
    expect(await page.evaluate(() => signinsHealth())).toEqual({ status: 'pass', detail: '5 sign-ins listed, 2 signed out' });
  });


  test('a line in a state the page does not know is shown as needing him, never hidden', async ({ page }) => {
    const panel = await open(page, [signinRow([line('Pingen (letters)', 'app.pingen.com', 'signed-in'),
      line('Mystery', 'mystery.example.com', 'half-signed-in')])]);
    await expect(panel).toContainText('One sign-in needs you: Mystery.');
    await expect(panel.locator('[data-rs-signin="mystery.example.com"]')).toBeVisible();
  });


  test('a failed refresh, a stale row and a missing row each say so; none reads as an empty list', async ({ page }) => {
    let panel = await open(page, [signinRow(MIXED, { [ES.status]: 'Failed', [ES.detail]: 'node not found' })]);
    await expect(panel).toContainText('The sign-in list could not be refreshed (Failed): node not found');
    await expect(panel.locator('[data-rs-signin="www.edfenergy.com"]')).toBeVisible();   // the last good list stays
    // Any mark but Worked is a warning: an older writer once called an unknown row "Idle,
    // No longer scheduled" and froze it with a fresh time.
    panel = await open(page, [signinRow(MIXED, { [ES.status]: 'Idle', [ES.detail]: 'No longer scheduled' })]);
    await expect(panel).toContainText('The sign-in list could not be refreshed (Idle): No longer scheduled');
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

  // Kevin, 8 Oct 2026: "we seem to have bits everywhere". The panel is the list of sites; a task
  // waiting on a sign-in is its own card, which keeps its Sign in now button.
  test('the panel carries no waiting-task strip; the card keeps its own Sign in now', async ({ page }) => {
    const fx = defaultFixtures();
    fx.approvals = fx.approvals.map((r, i) => {
      if (i === 0) r.fields[TF.agentOutput] = 'Letter built.\nSIGN-IN NEEDED: Pingen (https://app.pingen.com/)';
      return r;
    });
    const panel = await open(page, [signinRow(MIXED)], { approvals: fx.approvals });
    await expect(panel).toContainText('2 sign-ins need you: EDF Energy, Utilita Apartment 1.');
    await expect(page.locator('[data-apv-signin-strip]')).toHaveCount(0);
    await expect(page.locator('[data-apv-signin="app.pingen.com"] a', { hasText: 'Sign in now' })).toHaveAttribute('href', 'robotsignin://site/app.pingen.com');
  });
});

// The blocker sweep's row (agent-blockers): a robot blocked on a sign-in the last check
// called fine, a site missing from the list, and a step only Kevin can do (not a sign-in).
function blockersRow(open, sweptMinAgo = 5) {
  return { id: 'recBlockers', createdTime: ago(3), fields: {
    [ES.key]: 'agent-blockers', [ES.kind]: 'report', [ES.status]: 'Worked', [ES.detail]: 'fixture',
    [ES.payload]: JSON.stringify({ open, stale: 0, closedWhileBlocked: [], sweptAt: ago(sweptMinAgo) }), [ES.updated]: ago(3) } };
}
const WALLS = [
  { task: 'recW1', name: 'Match the 12 Sep card charge', agent: 'Finance', kind: 'SIGN-IN', subject: 'www.amazon.co.uk', fix: 'sign in', days: 1 },
  { task: 'recW2', name: 'Read the council portal', agent: 'Property', kind: 'SITE', subject: 'portal.fylde.gov.uk', fix: 'add it', days: 0 },
  { task: 'recW3', name: 'Phone-free step', agent: 'Admin', kind: 'KEVIN', subject: 'signature', fix: 'sign it', days: 0 },
];

// Kevin, 8 Oct 2026: blocked robots are approval cards now (a SIGN-IN or SITE wall puts its task
// in the queue with its button; a KEVIN step is a Your step card with Your turn on it). The panel
// shows none of them, never counts them, and never offers Your turn.
test.describe('blocked robots are cards, never panel rows', () => {
  test.use({ userAgent: MAC_UA });

  test('SIGN-IN, SITE and KEVIN walls on the blocker row add nothing to the panel or its count', async ({ page }) => {
    const walls = WALLS.concat(TURNS);
    const panel = await open(page, [signinRow([line('Pingen (letters)', 'app.pingen.com', 'signed-in')]), blockersRow(walls)]);
    await expect(panel).toContainText('All good.');
    await expect(page.locator('#signinsCount')).toHaveText('0');
    await expect(panel.locator('a[href^="robotsignin://turn/"]')).toHaveCount(0);
    await expect(panel.locator('a[href^="robotsignin://add/"]')).toHaveCount(0);
    await expect(panel).not.toContainText('www.amazon.co.uk');
    await expect(panel).not.toContainText('portal.fylde.gov.uk');
    await expect(panel).not.toContainText('Chedburgh');
    // A failed blocker sweep is not the panel's to report either: the Estate tab's "Robots blocked" row says it.
    const failed = blockersRow(walls);
    failed.fields[ES.status] = 'Failed';
    failed.fields[ES.detail] = 'The blocker sweep has not run for 9 hours.';
    const again = await open(page, [signinRow([line('Pingen (letters)', 'app.pingen.com', 'signed-in')]), failed]);
    await expect(again).not.toContainText('Blocked robots could not be checked');
  });
});

// Kevin's turn (30 Sep 2026): an approved task whose website step needs him, with the robot's
// handover plan ready (the sweep marks the wall turn:true). The worked examples: Chedburgh has a
// plan, the PIB replacement and Athertons do not.
const TURNS = [
  { task: 'recPYIC5nn7v2bh8e', name: 'INSURANCE: Landlord buildings insurance via TopCashback - 6 Chedburgh Place', agent: 'Property Administration', kind: 'KEVIN', subject: 'purchase', fix: 'Kevin clicks Your turn', days: 0, turn: true },
  { task: 'recbBdOmWJASeTYLs', name: 'INSURANCE: Replacement cover - 30 Burnbank Gardens', agent: 'Property Administration', kind: 'KEVIN', subject: 'identity', fix: 'Kevin gives his date of birth', days: 1 },
  { task: 'recLRHyQ8AG0NUHt0', name: 'Athertons Exterior Cleaning invoice', agent: 'Finance', kind: 'KEVIN', subject: 'payment', fix: 'Kevin pays', days: 1 },
];


test.describe('Robot sign-ins panel on a phone', () => {
  test.use({ userAgent: PHONE_UA });


  test('shows where each sign-in stands, with no button that cannot work there', async ({ page }) => {
    const fx = defaultFixtures();
    fx.approvals = fx.approvals.map((r, i) => {
      if (i === 0) r.fields[TF.agentOutput] = 'Letter built.\nSIGN-IN NEEDED: Pingen (https://app.pingen.com/)';
      return r;
    });
    const panel = await open(page, [signinRow(MIXED)], { approvals: fx.approvals });
    await expect(panel).toContainText('2 sign-ins need you: EDF Energy, Utilita Apartment 1.');
    await expect(panel.locator('a[href^="robotsignin://"]')).toHaveCount(0);
    await expect(panel.locator('[data-rs-line="signed-out"]').first()).toContainText('Sign in on your Mac');
    await expect(panel).toContainText("Sign-ins open on your Mac, where the robots' browser lives.");
  });
});
