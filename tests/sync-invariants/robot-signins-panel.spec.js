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

  test('closing the last sign-in card mid re-read clears the strip at once', async ({ page }) => {
    const fx = defaultFixtures();
    fx.approvals = fx.approvals.map((r, i) => {
      if (i === 0) r.fields[TF.agentOutput] = 'Letter built.\nSIGN-IN NEEDED: Pingen (https://app.pingen.com/)';
      return r;
    });
    const panel = await open(page, [signinRow(MIXED)], { approvals: fx.approvals });
    await expect(panel.locator('[data-apv-signin-strip]')).toBeVisible();
    // The queue is re-reading, and the sign-in card leaves the list (a decision edits allApprovals).
    await page.evaluate(() => { _approvalsState = 'loading'; allApprovals = allApprovals.filter(t => !apvSignInNeeded(t.agentOutput)); renderSignins(); });
    await expect(panel.locator('[data-apv-signin-strip]')).toHaveCount(0);
  });

  test('a line in a state the page does not know is shown as needing him, never hidden', async ({ page }) => {
    const panel = await open(page, [signinRow([line('Pingen (letters)', 'app.pingen.com', 'signed-in'),
      line('Mystery', 'mystery.example.com', 'half-signed-in')])]);
    await expect(panel).toContainText('One sign-in needs you: Mystery.');
    await expect(panel.locator('[data-rs-signin="mystery.example.com"]')).toBeVisible();
  });

  test('the waiting strip survives the 30-second re-read after a Sign in tap', async ({ page }) => {
    const fx = defaultFixtures();
    fx.approvals = fx.approvals.map((r, i) => {
      if (i === 0) r.fields[TF.agentOutput] = 'Letter built.\nSIGN-IN NEEDED: Pingen (https://app.pingen.com/)';
      return r;
    });
    const panel = await open(page, [signinRow(MIXED)], { approvals: fx.approvals });
    await expect(panel.locator('[data-apv-signin-strip]')).toBeVisible();
    // The queue re-read is still in flight when the estate re-read lands (the race the review proved).
    await page.route('**/api.airtable.com/**tblqB8b22hKBL4PF1**', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.fallback(); });
    await page.evaluate(async () => { const q = window.apvSilentRefresh(); await loadEstateStatus(); await q; });
    await expect(panel.locator('[data-apv-signin-strip]')).toContainText('One task is waiting on a sign-in');
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

test.describe('Robot sign-ins panel and blocked robots', () => {
  test.use({ userAgent: MAC_UA });

  test('a robot blocked on a sign-in the list calls fine still needs him, never "All good"', async ({ page }) => {
    // The last check called Amazon fine two days ago; the wall is a day old.
    const panel = await open(page, [signinRow([line('Amazon (order history)', 'www.amazon.co.uk', 'signed-in', { at: ago(2880), how: 'robot check' }),
      line('Pingen (letters)', 'app.pingen.com', 'signed-in')]), blockersRow(WALLS)]);
    await expect(panel).not.toContainText('All good');
    await expect(panel).toContainText('2 sign-ins need you: www.amazon.co.uk, portal.fylde.gov.uk.');
    await expect(page.locator('#signinsCount')).toHaveText('2');
    await expect(panel.locator('[data-rs-wall-line="SIGN-IN"]')).toContainText('One task is blocked until the robot is signed in to www.amazon.co.uk.');
    await expect(panel.locator('[data-rs-wall="www.amazon.co.uk"]')).toHaveAttribute('href', 'robotsignin://site/www.amazon.co.uk');
    await expect(panel.locator('[data-rs-wall-add="portal.fylde.gov.uk"]')).toHaveAttribute('href', 'robotsignin://add');
    await expect(panel.locator('[data-rs-wall-line]')).toHaveCount(2);   // a KEVIN step is not a sign-in
    // The keyboard stays on the blocked site's own button through a redraw.
    await panel.locator('[data-rs-wall-add="portal.fylde.gov.uk"]').focus();
    await page.evaluate(() => renderSignins());
    await expect(panel.locator('[data-rs-wall-add="portal.fylde.gov.uk"]')).toBeFocused();
  });

  test('a SIGN-IN wall on a site that stops the robot with a bot check has no Sign in button and is not counted (25 Sep 2026)', async ({ page }) => {
    const wall = { task: 'recW9', name: 'Fix SPF and DKIM', agent: 'Builder', kind: 'SIGN-IN', subject: 'dash.cloudflare.com', fix: 'sign in', days: 0 };
    // The bot check was seen a minute ago, after the wall opened (the sweep ran 5 minutes ago).
    const panel = await open(page, [signinRow([line('dash.cloudflare.com', 'dash.cloudflare.com', 'bot-check', { how: 'robot check', at: ago(1) })]),
      blockersRow([wall])]);
    await expect(panel.locator('[data-rs-wall-line="bot-check"]')).toContainText('One task is blocked: dash.cloudflare.com stops the robot with a bot check, which a sign-in cannot fix.');
    await expect(panel.locator('[data-rs-wall="dash.cloudflare.com"]')).toHaveCount(0);
    await expect(page.locator('#signinsCount')).toHaveText('0');
    await expect(panel).not.toContainText('All good');
  });

  test('a bot check seen BEFORE a sign-in wall opened does not hide that wall\'s Sign in button (review round 3)', async ({ page }) => {
    const wall = { task: 'recW9', name: 'Fix SPF and DKIM', agent: 'Builder', kind: 'SIGN-IN', subject: 'dash.cloudflare.com', fix: 'sign in', days: 0 };
    const panel = await open(page, [signinRow([line('dash.cloudflare.com', 'dash.cloudflare.com', 'bot-check', { how: 'robot check', at: ago(300) })]),
      blockersRow([wall])]);
    await expect(panel.locator('[data-rs-wall="dash.cloudflare.com"]')).toHaveAttribute('href', 'robotsignin://site/dash.cloudflare.com');
    await expect(page.locator('#signinsCount')).toHaveText('1');
  });

  test('a wall on a site he has just signed in to says so, with no second button and no count', async ({ page }) => {
    // The wall is a day old; he signed in two minutes ago.
    const panel = await open(page, [signinRow([line('Amazon (order history)', 'www.amazon.co.uk', 'you-signed-in', { at: ago(2), how: 'you signed in' })]),
      blockersRow(WALLS.slice(0, 1))]);
    await expect(panel.locator('[data-rs-wall-line="done"]')).toContainText('You signed in since. The robot picks the task up at its next pass.');
    await expect(panel.locator('[data-rs-wall="www.amazon.co.uk"]')).toHaveCount(0);
    await expect(page.locator('#signinsCount')).toHaveText('0');
    await expect(panel).not.toContainText('needs you');
  });

  test('a robot confirming his sign-in keeps the wall cleared; a check from before the wall does not', async ({ page }) => {
    // Wall 0.2 days old at a sweep 25 min ago; the robot found the site signed in 2 min ago.
    const w = Object.assign({}, WALLS[0], { days: 0.2 });
    let panel = await open(page, [signinRow([line('Amazon (order history)', 'www.amazon.co.uk', 'signed-in', { at: ago(2), how: 'robot check' })]),
      blockersRow([w], 25)]);
    await expect(panel.locator('[data-rs-wall-line="done"]')).toContainText('The robot has found it signed in since.');
    await expect(page.locator('#signinsCount')).toHaveText('0');
    // The Amazon case: a check said signed in BEFORE the wall opened (the password prompt came
    // back after it), so the wall still needs him.
    const fresh = Object.assign({}, WALLS[0], { days: 0 });
    panel = await open(page, [signinRow([line('Amazon (order history)', 'www.amazon.co.uk', 'signed-in', { at: ago(300), how: 'robot check' })]),
      blockersRow([fresh], 5)]);
    await expect(panel.locator('[data-rs-wall="www.amazon.co.uk"]')).toBeVisible();
    await expect(page.locator('#signinsCount')).toHaveText('1');
  });

  test('a wall that may have opened AFTER his sign-in still needs him', async ({ page }) => {
    // He signed in 150 minutes ago; a robot then met the password prompt again (the wall is fresh).
    const fresh = Object.assign({}, WALLS[0], { days: 0 });
    let panel = await open(page, [signinRow([line('Amazon (order history)', 'www.amazon.co.uk', 'you-signed-in', { at: ago(150), how: 'you signed in' })]),
      blockersRow([fresh])]);
    await expect(panel.locator('[data-rs-wall="www.amazon.co.uk"]')).toBeVisible();
    await expect(page.locator('#signinsCount')).toHaveText('1');
    // The review's case: sign-in 190 min ago, wall opened 100 min later, swept at 86 min old,
    // which rounds to 0.1 of a day. It may have opened after him, so it still needs him.
    const later = Object.assign({}, WALLS[0], { days: 0.1 });
    panel = await open(page, [signinRow([line('Amazon (order history)', 'www.amazon.co.uk', 'you-signed-in', { at: ago(190), how: 'you signed in' })]),
      blockersRow([later], 4)]);
    await expect(panel.locator('[data-rs-wall="www.amazon.co.uk"]')).toBeVisible();
    // A writer without sweptAt never marks a wall done.
    const noSweep = blockersRow(WALLS.slice(0, 1));
    noSweep.fields[ES.payload] = JSON.stringify({ open: WALLS.slice(0, 1) });
    panel = await open(page, [signinRow([line('Amazon (order history)', 'www.amazon.co.uk', 'you-signed-in', { at: ago(2), how: 'you signed in' })]), noSweep]);
    await expect(panel.locator('[data-rs-wall="www.amazon.co.uk"]')).toBeVisible();
  });

  test('a check that worked but found an old wall is not called a failed check', async ({ page }) => {
    const old = blockersRow(WALLS.slice(0, 1));
    old.fields[ES.status] = 'Failed';
    old.fields[ES.detail] = 'Robots blocked on 1 task. For you: sign the robot in to www.amazon.co.uk. 1 task blocked 3 days or more.';
    const panel = await open(page, [signinRow([line('Pingen (letters)', 'app.pingen.com', 'signed-in')]), old]);
    await expect(panel).not.toContainText('could not be checked');
    await expect(panel.locator('[data-rs-wall="www.amazon.co.uk"]')).toBeVisible();
  });

  test('a failed blocked-robots check says so, and a broken sign-in list never hides a stuck robot', async ({ page }) => {
    const failedRow = blockersRow(WALLS.slice(0, 1));
    failedRow.fields[ES.status] = 'Failed';
    failedRow.fields[ES.detail] = 'The blocker sweep has not run for 9 hours.';
    let panel = await open(page, [signinRow([line('Pingen (letters)', 'app.pingen.com', 'signed-in')]), failedRow]);
    await expect(panel).toContainText('Blocked robots could not be checked just now: The blocker sweep has not run for 9 hours.');
    panel = await open(page, [signinRow([], { [ES.payload]: '{"lines":[' }), blockersRow(WALLS.slice(0, 1))]);
    await expect(panel).toContainText('The sign-in list could not be read');
    await expect(panel.locator('[data-rs-wall="www.amazon.co.uk"]')).toBeVisible();
  });

  test('a wall on one Utilita flat opens that flat, is named by it, and only its own sign-in clears it', async ({ page }) => {
    // PR #561: a flat's wall subject reads "my.utilita.co.uk (utilita-apt2)".
    const flat = { task: 'recW9', name: 'Read the Duckworth meter', agent: 'Property', kind: 'SIGN-IN', subject: 'my.utilita.co.uk (utilita-apt2)', fix: 'sign in', days: 1 };
    const lines = [line('Utilita Apartment 1', 'my.utilita.co.uk', 'you-signed-in', { profile: 'utilita-apt1', at: ago(2), how: 'you signed in' }),
      line('Utilita Apartment 2', 'my.utilita.co.uk', 'signed-in', { profile: 'utilita-apt2', how: 'hourly read', at: ago(2880) })];   // read before the wall
    const panel = await open(page, [signinRow(lines), blockersRow([flat])]);
    const btn = panel.locator('[data-rs-wall="my.utilita.co.uk (utilita-apt2)"]');
    await expect(btn).toHaveAttribute('href', 'robotsignin://profile/utilita-apt2');   // never site/<"host (profile)">
    await expect(panel.locator('[data-rs-wall-line="SIGN-IN"]')).toContainText('blocked until the robot is signed in to Utilita Apartment 2.');
    // Flat 1's fresh sign-in does not clear flat 2's wall.
    await expect(page.locator('#signinsCount')).toHaveText('1');
    await expect(panel).toContainText('One sign-in needs you: Utilita Apartment 2.');
  });

  test('a blocked site the list already calls signed out is counted once', async ({ page }) => {
    const panel = await open(page, [signinRow([line('Amazon (order history)', 'www.amazon.co.uk', 'signed-out')]), blockersRow(WALLS.slice(0, 1))]);
    await expect(panel).toContainText('One sign-in needs you: Amazon (order history).');
    await expect(page.locator('#signinsCount')).toHaveText('1');
  });
});

test.describe('Robot sign-ins panel on a phone', () => {
  test.use({ userAgent: PHONE_UA });

  test('shows where each sign-in stands, with no button that cannot work there', async ({ page }) => {
    const fx = defaultFixtures();
    fx.approvals = fx.approvals.map((r, i) => {
      if (i === 0) r.fields[TF.agentOutput] = 'Letter built.\nSIGN-IN NEEDED: Pingen (https://app.pingen.com/)';
      return r;
    });
    const panel = await open(page, [signinRow(MIXED)], { approvals: fx.approvals });
    await expect(panel.locator('[data-apv-signin-strip]')).toContainText('One task is waiting on a sign-in');   // control: the strip is there
    await expect(panel).toContainText('2 sign-ins need you: EDF Energy, Utilita Apartment 1.');
    await expect(panel.locator('a[href^="robotsignin://"]')).toHaveCount(0);
    await expect(panel.locator('[data-rs-line="signed-out"]').first()).toContainText('Sign in on your Mac');
    await expect(panel).toContainText("Sign-ins open on your Mac, where the robots' browser lives.");
  });
});
