// THE APPROVAL GATE FOR A 13-YEAR-OLD (Kevin, 7 Sep 2026). The usability audit
// measured 16 buttons per card, a 600px jump after every decision, no saving
// state, open panels snapping shut, Approve below the fold on a laptop, and a
// wait dressed up as a decision. These guard the shape that replaced it: two
// buttons, everything else one tap away, the decision saved in place with an
// Undo, nothing else on the page rebuilt, and alike items approvable as one.
const { test, expect } = require('@playwright/test');
const { TF, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

const AGENT_B = 'recTmInboundResp';

function withAlike() {
  const fx = defaultFixtures();
  const now = new Date().toISOString();
  // Three warm-lane emails to the same domain from the same agent and kind.
  for (let i = 0; i < 3; i++) fx.approvals.push({ id: 'recAlike' + i, createdTime: now, fields: {
    [TF.name]: 'Warm lane touch ' + i, [TF.status]: 'Approval', [TF.priority]: 'Medium',
    [TF.agentOutput]: `TO: founder${i}@example.co.uk\nFROM: kevin@operationsdirector.co.uk\nSUBJECT: Closing the loop\n---\nHi, just closing the loop on the note I sent last week. Would a ten minute call help? Kevin\n\n**Carrying this out will involve:** sending this email to founder${i}@example.co.uk.`,
    [TF.sentForApprovalBy]: [AGENT_B], [TF.teamMember]: [AGENT_B], [TF.lmt]: now, [TF.taskType]: 'Correspondence',
  } });
  fx.approvals.push({ id: 'recSignIn', createdTime: now, fields: {
    [TF.name]: 'File the CS01', [TF.status]: 'Approval', [TF.priority]: 'Medium',
    [TF.agentOutput]: 'Verified from the register.\nSIGN-IN NEEDED: Companies House WebFiling (https://ewf.companieshouse.gov.uk/seclogin?tc=1)',
    [TF.sentForApprovalBy]: [AGENT_B], [TF.teamMember]: [AGENT_B], [TF.lmt]: now, [TF.taskType]: 'Admin',
  } });
  return fx;
}

async function openApprovals(page) {
  await page.click('#ptab-approvals');
  await expect(page.locator('#view-approvals')).toBeVisible();
}

test.describe('two buttons, everything else one tap away', () => {
  test('a card shows Approve, No and More; the reasons and the rest are hidden until asked', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    const card = page.locator('.apv-card').first();
    await expect(card.locator('.apv-actions button', { hasText: /^Approve$/ })).toBeVisible();
    await expect(card.locator('.apv-actions button', { hasText: /^No$/ })).toBeVisible();
    await expect(card.locator('.apv-more')).toBeVisible();
    await expect(card.locator('.apv-reasons')).toBeHidden();
    await expect(card.locator('.apv-panel')).toBeHidden();
    // The old dialog and the bare Reject button are gone.
    await expect(card.locator('.apv-actions button', { hasText: /^Reject$/ })).toHaveCount(0);
    await expect(page.locator('#apvRememberConfirm')).toHaveCount(0);
    // The promise line is never a bare task name: a short draft still gets one.
    const tenant = page.locator('.apv-card', { hasText: 'Reply to tenant email' });
    await expect(tenant.locator('.apv-ask')).toContainText('Drafting: Draft: thanks, will confirm.');
    await expect(tenant).toContainText('Task: Reply to tenant email');
  });
  test('More opens the note, attach, kind of work, the two slower approvals and knock-back', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    const card = page.locator('.apv-card').first();
    await card.locator('.apv-more').click();
    const panel = card.locator('.apv-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.apv-note')).toBeVisible();
    await expect(panel.locator('.apv-kind')).toContainText('Kind of work: Correspondence');
    await expect(panel.locator('.apv-kind select')).toBeHidden();
    await expect(panel.locator('button', { hasText: 'Approve with minor edits' })).toBeVisible();
    await expect(panel.locator('button', { hasText: 'Request changes' })).toBeVisible();
    await expect(panel.locator('.apv-defer-btn', { hasText: 'A week' })).toBeVisible();
  });
  test('a sign-in wait has one button, no verdicts', async ({ page }) => {
    await mockAgentsPage(page, withAlike());
    await loadAgentsPage(page);
    await openApprovals(page);
    const card = page.locator('[data-apv-card="recSignIn"]');
    await expect(card.locator('[data-apv-signin-actions] a', { hasText: 'Sign in now' })).toHaveAttribute('href', 'robotsignin://site/ewf.companieshouse.gov.uk');
    await expect(card.locator('button', { hasText: /^Approve$/ })).toHaveCount(0);
    await expect(card.locator('.apv-reason')).toHaveCount(0);
    await expect(card.locator('.apv-ask')).toContainText('Waiting on a sign-in: Companies House WebFiling. Not a decision.');
  });
});

test.describe('a decision is saved in place; nothing else moves', () => {
  test('Approve shows Saving then Saved with Undo, the other cards keep their open panels and their place', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    const cards = page.locator('.apv-card');
    // Open the second card's work and More panel, then decide the first.
    await cards.nth(1).locator('.apv-details summary').click();
    await cards.nth(1).locator('.apv-more').click();
    const secondTop = (await cards.nth(1).boundingBox()).y;
    await cards.nth(0).locator('.apv-actions button', { hasText: /^Approve$/ }).click();
    await expect(cards.nth(0).locator('[data-apv-state="saved"]')).toContainText('Saved');
    await expect(cards.nth(0).locator('[data-apv-undo]')).toBeVisible();
    await expect.poll(() => patches.length).toBe(1);
    // Still three cards in the DOM (the decided one is folding, not re-rendered).
    await expect(page.locator('.apv-card')).toHaveCount(3);
    await expect(cards.nth(1).locator('.apv-details')).toHaveAttribute('open', '');
    await expect(cards.nth(1).locator('.apv-panel')).toBeVisible();
    // The counts updated in place.
    await expect(page.locator('#approvalsTabBadge')).toHaveText('2');
    await expect(page.locator('.apv-filter', { hasText: 'All (2)' })).toHaveCount(1);
    // After the Undo window the card folds and the next one rises into its place.
    await expect(page.locator('.apv-card')).toHaveCount(2, { timeout: 8000 });
    const newTop = (await page.locator('.apv-card').first().boundingBox()).y;
    expect(newTop).toBeLessThan(secondTop);
  });
});

test.describe('alike items approve as one, after the list has been read', () => {
  test('the strip lists every promise line and approves them all in order', async ({ page }) => {
    const patches = await mockAgentsPage(page, withAlike());
    await loadAgentsPage(page);
    await openApprovals(page);
    const strip = page.locator('[data-apv-batch-group]');
    await expect(strip).toHaveCount(1);
    await expect(strip).toContainText('3 alike: Inbound Comms Response · Correspondence to example.co.uk');
    await expect(strip.locator('.apv-batch-list div')).toHaveCount(3);
    await expect(strip.locator('.apv-batch-list')).toContainText('sending this email to founder0@example.co.uk');
    await strip.locator('[data-apv-batch-approve]').click();
    await expect.poll(() => patches.filter(p => /^recAlike/.test(p.id)).length).toBe(3);
    for (const p of patches.filter(p => /^recAlike/.test(p.id))) expect(p.fields[TF.approvalOutcome]).toBe('Approved as-is');
    // Tier-1 and sign-in cards never batch: the other cards are untouched.
    expect(patches.filter(p => !/^recAlike/.test(p.id))).toHaveLength(0);
  });
  test('no strip when nothing is alike', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    await expect(page.locator('[data-apv-batch-group]')).toHaveCount(0);
  });
});

test.describe('the Slack link works every time', () => {
  test('a second #tab=approvals while the page is open switches to the queue', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await expect(page.locator('#view-dashboard')).toBeVisible();
    await page.evaluate(() => { location.hash = '#tab=approvals'; });
    await expect(page.locator('#view-approvals')).toBeVisible();
    await page.evaluate(() => { location.hash = '#tab=dashboard'; });
    await expect(page.locator('#view-dashboard')).toBeVisible();
  });
});
