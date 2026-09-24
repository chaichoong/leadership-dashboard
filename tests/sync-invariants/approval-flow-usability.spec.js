// THE APPROVAL GATE FOR A 13-YEAR-OLD (Kevin, 7 Sep 2026). The usability audit
// measured 16 buttons per card, a 600px jump after every decision, no saving
// state, open panels snapping shut, Approve below the fold on a laptop, and a
// wait dressed up as a decision. These guard the shape that replaced it: the
// decision saved in place with an Undo, nothing else on the page rebuilt, and
// (since 23 Sep 2026) every option on the card rather than two buttons and a
// More panel. (The alike-items strip was removed
// on 15 Sep 2026: Kevin ticks the cards he wants decided together instead.)
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

// EVERY OPTION ON THE CARD (Kevin, 23 Sep 2026): "When I need to provide
// feedback, I don't want to have to click the More button. When I want to
// knock it back, I don't want to have to click a checkbox and then a Knock
// Back button. All of my options need to be available." The More panel and
// the "No" toggle are gone; each option is one click, feedback is typing plus
// one click, and the work, the task given and the story so far start open.
function withLongWork() {
  const fx = defaultFixtures();
  const r = fx.approvals[1]; // recApvA2
  r.fields[TF.agentOutput] = Array.from({ length: 60 },(_, i) => `Line ${i + 1} of the agent's report.`).join('\n')
    + '\n\nLAST LINE OF THE WORK';
  r.fields[TF.description] = 'Draft the lowest possible payment plan for the lender.';
  return fx;
}

test.describe('every option on the card, one click each', () => {
  test('Approve, the note, both slower approvals, every reason and every date show without a click', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    const card = page.locator('.apv-card').first();
    const taskId = await card.getAttribute('data-apv-card');
    await expect(card.locator('.apv-actions button', { hasText: /^Approve$/ })).toBeVisible();
    await expect(card.locator('#apvNote-' + taskId)).toBeVisible();
    await expect(card.locator('.apv-actions label', { hasText: 'Attach' })).toBeVisible();
    await expect(card.locator('.apv-actions button', { hasText: 'Approve with minor edits' })).toBeVisible();
    await expect(card.locator('.apv-actions button', { hasText: 'Request changes' })).toBeVisible();
    await expect(card.locator('.apv-reasons')).toBeVisible();
    await expect(card.locator('.apv-reason')).toHaveCount(8);
    for (const label of ['3 days', 'A week', '2 weeks', 'A month']) {
      await expect(card.locator('.apv-defer-btn', { hasText: label }).first()).toBeVisible();
    }
    await expect(card.locator('#apvDeferDate-' + taskId)).toBeVisible();
    // Nothing left to open first.
    await expect(page.locator('.apv-more')).toHaveCount(0);
    await expect(page.locator('.apv-panel')).toHaveCount(0);
    await expect(card.locator('.apv-actions button', { hasText: /^No$/ })).toHaveCount(0);
    await expect(card.locator('.apv-kind')).toContainText('Kind of work: Correspondence');
    await expect(card.locator('.apv-kind select')).toBeHidden();
    // The old dialog and the bare Reject button are gone.
    await expect(card.locator('.apv-actions button', { hasText: /^Reject$/ })).toHaveCount(0);
    await expect(page.locator('#apvRememberConfirm')).toHaveCount(0);
    // The promise line is never a bare task name: a short draft still gets one.
    const tenant = page.locator('.apv-card', { hasText: 'Reply to tenant email' });
    await expect(tenant.locator('.apv-ask')).toContainText('Drafting: Draft: thanks, will confirm.');
    // The task name moved to the top, as the plain summary's fallback (22 Sep 2026).
    await expect(tenant.locator('[data-apv-plain-task]')).toHaveText('Reply to tenant email');
  });

  test('feedback is typing plus one click: Request changes sends the note', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    const card = page.locator('.apv-card').first();
    const taskId = await card.getAttribute('data-apv-card');
    await card.locator('#apvNote-' + taskId).fill('Ask for a freeze first, then the plan.');
    await card.locator('.apv-actions button', { hasText: 'Request changes' }).click();
    await expect.poll(() => patches.some((p) => p.id === taskId)).toBe(true);
    const patch = patches.find((p) => p.id === taskId);
    expect(patch.fields[TF.approvalOutcome]).toBe('Changes requested');
    expect(patch.fields['fldtI7SJI4gEohHD1']).toBe('Ask for a freeze first, then the plan.');
  });

  // SCROLL, NEVER A CLICK (Kevin, 24 Sep 2026): "When I click the agent's full
  // work ... it needs to be like how it is with the task it was given: I can
  // just scroll down in a larger box rather than having to click another Show
  // all button." The work box capped at eight lines had scrolling switched off.
  test('the work, the task it was given and the story so far start open; a long report scrolls in its box with no Show all', async ({ page }) => {
    await mockAgentsPage(page, withLongWork());
    await loadAgentsPage(page);
    await openApprovals(page);
    const card = page.locator('[data-apv-card="recApvA2"]');
    await expect(card.locator('.apv-details')).toHaveAttribute('open', '');
    await expect(card.locator('[data-apv-given]')).toContainText('lowest possible payment plan');
    const body = card.locator('[data-apv-work]');
    await expect(body).toContainText('Line 1 of the agent');
    await expect(card.locator('button', { hasText: /Show (all|less)/ })).toHaveCount(0);
    // The same box as the task it was given: same height cap, scrollable.
    const style = (el) => { const s = getComputedStyle(el); return { maxHeight: s.maxHeight, overflowY: s.overflowY }; };
    const work = await body.evaluate(style);
    expect(work).toEqual(await card.locator('[data-apv-given]').evaluate(style));
    expect(work.overflowY).toBe('auto');
    // The report is longer than the box, and the mouse wheel reaches its end.
    const fit = await body.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(fit.sh).toBeGreaterThan(fit.ch * 1.5);
    await body.scrollIntoViewIfNeeded();
    const box = await body.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 20);
    await page.mouse.wheel(0, 5000);
    await expect.poll(() => body.evaluate((el) => el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2)).toBe(true);
  });

  test('a long note grows the box only so far, so the buttons never cover the work', async ({ page }) => {
    // Found in review, 23 Sep 2026: a pasted 25-line note grew the pinned
    // block to 481px and hid the card behind it on a laptop screen.
    await page.setViewportSize({ width: 1280, height: 720 });
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    const card = page.locator('.apv-card').first();
    const taskId = await card.getAttribute('data-apv-card');
    await card.locator('#apvNote-' + taskId).fill(Array.from({ length: 25 }, (_, i) => 'Point ' + (i + 1)).join('\n'));
    const box = await card.locator('#apvNote-' + taskId).boundingBox();
    expect(box.height).toBeLessThanOrEqual(162);
    expect(box.height).toBeGreaterThan(60);
    const decide = await card.locator('[data-apv-decide]').boundingBox();
    expect(decide.height).toBeLessThan(300);
  });

  test('a sign-in wait has one button and no approve, but can still be closed or knocked back in one click', async ({ page }) => {
    await mockAgentsPage(page, withAlike());
    await loadAgentsPage(page);
    await openApprovals(page);
    const card = page.locator('[data-apv-card="recSignIn"]');
    await expect(card.locator('[data-apv-signin-actions] a', { hasText: 'Sign in now' })).toHaveAttribute('href', 'robotsignin://site/ewf.companieshouse.gov.uk');
    await expect(card.locator('button', { hasText: /^Approve$/ })).toHaveCount(0);
    await expect(card.locator('button', { hasText: 'Request changes' })).toHaveCount(0);
    // A wait still needs a way out (Kevin, 23 Sep 2026).
    await expect(card.locator('.apv-reason', { hasText: 'No longer relevant' })).toBeVisible();
    await expect(card.locator('.apv-defer-btn', { hasText: 'A week' }).first()).toBeVisible();
    await expect(card.locator('.apv-ask')).toContainText('Waiting on a sign-in: Companies House WebFiling. Not a decision.');
  });
});

test.describe('a decision is saved in place; nothing else moves', () => {
  test('Approve shows Saving then Saved with Undo, the other cards keep their open panels and their place', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    const cards = page.locator('.apv-card');
    // Fold the second card's work shut and start a note on it, then decide the first.
    await cards.nth(1).locator('.apv-details summary').click();
    const secondId = await cards.nth(1).getAttribute('data-apv-card');
    await cards.nth(1).locator('#apvNote-' + secondId).fill('Half-written note');
    const secondTop = (await cards.nth(1).boundingBox()).y;
    await cards.nth(0).locator('.apv-actions button', { hasText: /^Approve$/ }).click();
    await expect(cards.nth(0).locator('[data-apv-state="saved"]')).toContainText('Saved');
    await expect(cards.nth(0).locator('[data-apv-undo]')).toBeVisible();
    await expect.poll(() => patches.length).toBe(1);
    // Still three cards in the DOM (the decided one is folding, not re-rendered).
    await expect(page.locator('.apv-card')).toHaveCount(3);
    await expect(cards.nth(1).locator('.apv-details')).not.toHaveAttribute('open', '');
    await expect(cards.nth(1).locator('#apvNote-' + secondId)).toHaveValue('Half-written note');
    // The counts updated in place.
    await expect(page.locator('#approvalsTabBadge')).toHaveText('2');
    await expect(page.locator('.apv-filter', { hasText: 'All (2)' })).toHaveCount(1);
    // After the Undo window the card folds and the next one rises into its place.
    await expect(page.locator('.apv-card')).toHaveCount(2, { timeout: 8000 });
    const newTop = (await page.locator('.apv-card').first().boundingBox()).y;
    expect(newTop).toBeLessThan(secondTop);
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

// THE COVERAGE CHECK (Kevin, 7 Sep 2026).
test.describe('quote emails show the coverage that passed', () => {
  function withQuotes() {
    const fx = defaultFixtures();
    const now = new Date().toISOString();
    const AGENT_A = 'recTmCreditorMgmt';
    ['AC1 Electrical', 'ELECSI', 'Spark Bros'].forEach((who, i) => fx.approvals.push({ id: 'recQuote' + i, createdTime: now, fields: {
      [TF.name]: `COMPLIANCE: EICR quote request - ${who} - 6 Chedburgh Place`, [TF.status]: 'Approval', [TF.priority]: 'Medium',
      [TF.agentOutput]: `TO: quotes@${who.toLowerCase().replace(/\s+/g, '')}.example\nFROM: info@agilelets.co.uk\nSUBJECT: EICR quote, 6 Chedburgh Place\n---\nPlease quote for an EICR at 6 Chedburgh Place, CB9 0AB.\n\n**Carrying this out will involve:** sending this quote request to ${who}.`,
      [TF.notes]: `[07 Sep 2026 13:00 — agent-dispatch] COVERAGE CHECKED: CB9 (6 Chedburgh Place) within ${who} covers CB9, CB8 (https://${who.toLowerCase().replace(/\s+/g, '')}.example/areas).`,
      [TF.sentForApprovalBy]: [AGENT_A], [TF.teamMember]: [AGENT_A], [TF.lmt]: now, [TF.taskType]: 'Correspondence',
    } }));
    return fx;
  }
  test('the card says which districts the tradesperson covers', async ({ page }) => {
    await mockAgentsPage(page, withQuotes());
    await loadAgentsPage(page);
    await openApprovals(page);
    const chip = page.locator('[data-apv-card="recQuote0"] [data-apv-coverage]');
    await expect(chip).toContainText('Covers CB9');
    await expect(chip).toHaveAttribute('title', /AC1 Electrical covers CB9, CB8/);
  });
});
