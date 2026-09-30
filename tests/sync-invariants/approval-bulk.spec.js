// TICK, THEN DECIDE (Kevin, 15 Sep 2026).
//
// Two mechanisms used to decide FOR Kevin which approval cards belonged
// together: the incident groups (dupeTaskKey and dupeVerdict over the task
// names) and the "alike" batch strip (same agent, kind and recipient domain).
// He asked for both to go. Now he ticks the cards himself and one bar carries
// every verdict the single card has: Approve, Approve with minor edits,
// Request changes, the reason chips with ONE Remember box, and knock back.
//
// The invariants that keep bulk safe rather than merely fast:
//   1. Every bulk verdict is N single verdicts. Each ticked card gets its own
//      PATCH with exactly the fields the single-card path writes, so nothing
//      new can go wrong in the write and the stale guard runs per card.
//   2. The reason lands on EVERY id; Remember lands on the FIRST only (one
//      tick teaches one rule, not one rule per card).
//   3. Knock back writes the date on every id and no verdict on any.
//   4. A sign-in wait is not a decision and cannot be ticked.
//   5. After a decision or a knock-back the view moves on to the card after
//      the one decided (Kevin, 30 Sep 2026). It used to return to the first
//      card (15 Sep), which threw him back to the top every time he worked
//      the queue out of order. The decided card's Saved strip sits under the
//      top bar with the next card below it; after the fold the next card
//      takes the top. The last card hands on to the one above it.
//
// Airtable is mocked, so these assert on the PATCHes the page actually sends
// and on where the page actually puts the cards.

const { test, expect } = require('@playwright/test');
const { TF, AGENT_B, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

// Field ids the helpers do not export, mirrored from os/agents/index.html.
const VERDICT_REASON = 'fldF9Bs4N5mttQvtl';
const REMEMBER_THIS = 'fldZurhdHutYIDKVx';
const APPROVAL_FEEDBACK = 'fldtI7SJI4gEohHD1';

function isoPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function openApprovals(page) {
  await page.click('#ptab-approvals');
  await expect(page.locator('#view-approvals')).toBeVisible();
}

/** Tick the cards at these positions and return their task ids. */
async function tick(page, positions) {
  const ids = [];
  for (const i of positions) {
    const card = page.locator('.apv-card').nth(i);
    ids.push(await card.getAttribute('data-apv-card'));
    await card.locator('[data-apv-pick]').check();
  }
  await expect(page.locator('#apvBulk')).toBeVisible();
  await expect(page.locator('#apvBulk .apv-bulk-count')).toContainText(`${positions.length} selected`);
  return ids;
}

/** Enough cards that the page scrolls, so "at the top" means something. */
function withMany(n = 8) {
  const fx = defaultFixtures();
  const now = new Date().toISOString();
  for (let i = 0; i < n; i++) fx.approvals.push({ id: 'recMany' + i, createdTime: now, fields: {
    [TF.name]: 'Chase supplier ' + i, [TF.status]: 'Approval', [TF.priority]: 'Medium',
    [TF.agentOutput]: `Draft: chasing supplier ${i} for the outstanding invoice.\n\n**Carrying this out will involve:** sending this email to supplier${i}@example.co.uk.`,
    [TF.sentForApprovalBy]: [AGENT_B], [TF.teamMember]: [AGENT_B], [TF.lmt]: now, [TF.taskType]: 'Correspondence',
  } });
  return fx;
}

/** Three alike emails plus a sign-in wait: the shapes the old strip and groups keyed on. */
function withAlikeAndSignIn() {
  const fx = defaultFixtures();
  const now = new Date().toISOString();
  for (let i = 0; i < 3; i++) fx.approvals.push({ id: 'recAlike' + i, createdTime: now, fields: {
    [TF.name]: 'Warm lane touch ' + i, [TF.status]: 'Approval', [TF.priority]: 'Medium',
    [TF.agentOutput]: `TO: founder${i}@example.co.uk\nFROM: kevin@operationsdirector.co.uk\nSUBJECT: Closing the loop\n---\nHi, closing the loop. Kevin\n\n**Carrying this out will involve:** sending this email to founder${i}@example.co.uk.`,
    [TF.sentForApprovalBy]: [AGENT_B], [TF.teamMember]: [AGENT_B], [TF.lmt]: now, [TF.taskType]: 'Correspondence',
  } });
  fx.approvals.push({ id: 'recSignIn', createdTime: now, fields: {
    [TF.name]: 'File the CS01', [TF.status]: 'Approval', [TF.priority]: 'Medium',
    [TF.agentOutput]: 'Verified from the register.\nSIGN-IN NEEDED: Companies House WebFiling (https://ewf.companieshouse.gov.uk/seclogin?tc=1)',
    [TF.sentForApprovalBy]: [AGENT_B], [TF.teamMember]: [AGENT_B], [TF.lmt]: now, [TF.taskType]: 'Admin',
  } });
  return fx;
}

/** The card with this id sits directly under the sticky top bar. */
async function expectCardAtTop(page, id) {
  const top = await page.locator('.topbar').boundingBox();
  const card = await page.locator(`[data-apv-card="${id}"]`).boundingBox();
  expect(Math.abs(card.y - (top.y + top.height))).toBeLessThanOrEqual(2);
}

/** The card with this id starts straight after the one above it, on screen. */
async function expectCardJustBelow(page, aboveId, id) {
  const above = await page.locator(`[data-apv-card="${aboveId}"]`).boundingBox();
  const card = await page.locator(`[data-apv-card="${id}"]`).boundingBox();
  const gap = card.y - (above.y + above.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(40);
  expect(card.y).toBeLessThan(page.viewportSize().height);
}

const idAt = (page, i) => page.locator('.apv-card').nth(i).getAttribute('data-apv-card');

test.describe('the groupings are gone; the tick is what groups', () => {
  test('alike cards render flat with no strip and no incident group, and a sign-in wait has no tick', async ({ page }) => {
    await mockAgentsPage(page, withAlikeAndSignIn());
    await loadAgentsPage(page);
    await openApprovals(page);
    await expect(page.locator('.apv-card')).toHaveCount(7);
    await expect(page.locator('[data-apv-batch-group]')).toHaveCount(0);
    await expect(page.locator('.apv-group')).toHaveCount(0);
    await expect(page.locator('[data-apv-card="recSignIn"] [data-apv-pick]')).toHaveCount(0);
    await expect(page.locator('[data-apv-pick]')).toHaveCount(6);
    // The bar is hidden until something is ticked.
    await expect(page.locator('#apvBulk')).toBeHidden();
    // Select all shown skips the sign-in wait; Clear hides the bar again.
    await page.locator('[data-apv-select-all]').click();
    await expect(page.locator('#apvBulk .apv-bulk-count')).toContainText('6 selected');
    await page.locator('#apvBulk button', { hasText: /^Clear$/ }).click();
    await expect(page.locator('#apvBulk')).toBeHidden();
  });
});

test.describe('every bulk verdict is N single verdicts', () => {
  test('Approve: one PATCH per ticked id, the same fields as the single path', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    const ids = await tick(page, [1, 2]);
    await page.locator('[data-apv-bulk-approve]').click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches.map((p) => p.id)).toEqual(ids);
    // Now the single path on the remaining card, for the comparison.
    await page.locator('.apv-card').nth(0).locator('.apv-actions button', { hasText: /^Approve$/ }).click();
    await expect.poll(() => patches.length).toBe(3);
    const single = patches[2];
    for (const p of patches.slice(0, 2)) {
      expect(Object.keys(p.fields).sort()).toEqual(Object.keys(single.fields).sort());
      expect(p.fields[TF.approvalOutcome]).toBe('Approved as-is');
      expect(p.fields[TF.status]).toBe(single.fields[TF.status]);
      expect(p.fields[TF.dueDate]).toBe(single.fields[TF.dueDate]);
      expect(p.fields[TF.completionDate]).toBeNull();
    }
    // Every decided card shows its own Saved strip with an Undo, as a single one does.
    for (const id of ids) await expect(page.locator(`[data-apv-card="${id}"] [data-apv-undo]`)).toBeVisible();
    // The bar goes away with the selection.
    await expect(page.locator('#apvBulk')).toBeHidden();
  });

  test('No with a reason chip: the reason on every id, Remember on the first only', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    const ids = await tick(page, [0, 2]);
    await page.locator('[data-apv-bulk-open="reasons"]').click();
    await expect(page.locator('#apvBulkRemember')).toBeChecked();
    await page.locator('#apvBulkPanel-reasons .apv-reason', { hasText: 'Roy owns it' }).click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches.map((p) => p.id)).toEqual(ids);
    for (const p of patches) {
      expect(p.fields[TF.approvalOutcome]).toBe('Rejected');
      expect(p.fields[VERDICT_REASON]).toBe('Roy owns it');
      expect(p.fields[APPROVAL_FEEDBACK]).toBe('Roy is dealing with this directly.');
      expect(p.fields[TF.status]).toBe('Completed');
    }
    expect(patches[0].fields[REMEMBER_THIS]).toBe(true);
    expect(patches[1].fields[REMEMBER_THIS]).toBeUndefined();
  });

  test('Something else needs his words first, then they land on every id', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    await tick(page, [0, 1]);
    await page.locator('[data-apv-bulk-open="reasons"]').click();
    await page.locator('#apvBulkPanel-reasons .apv-reason', { hasText: 'Something else' }).click();
    await expect(page.locator('#apvBulkRejectNote')).toBeVisible();
    expect(patches).toHaveLength(0);
    await page.locator('#apvBulkNote-reasons').fill('Not something I want to see.');
    await page.locator('[data-apv-bulk-reject]').click();
    await expect.poll(() => patches.length).toBe(2);
    const unclassified = await page.evaluate(() => APV_UNCLASSIFIED);
    for (const p of patches) {
      expect(p.fields[TF.approvalOutcome]).toBe('Rejected');
      expect(p.fields[VERDICT_REASON]).toBe(unclassified);
      expect(p.fields[APPROVAL_FEEDBACK]).toBe('Not something I want to see.');
    }
  });

  test('Request changes refuses without a note, then sends every id back with it', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    await tick(page, [1, 2]);
    await page.locator('[data-apv-bulk-open="changes"]').click();
    await page.locator('[data-apv-bulk-changes]').click();
    await expect(page.locator('#toast')).toContainText('Say what needs changing first');
    expect(patches).toHaveLength(0);
    await page.locator('#apvBulkNote-changes').fill('Shorter, and lead with the ask.');
    await page.locator('[data-apv-bulk-changes]').click();
    await expect.poll(() => patches.length).toBe(2);
    for (const p of patches) {
      expect(p.fields[TF.approvalOutcome]).toBe('Changes requested');
      expect(p.fields[APPROVAL_FEEDBACK]).toBe('Shorter, and lead with the ask.');
      expect(p.fields[TF.status]).toBe('Today');
    }
  });

  test('Approve with minor edits carries the one edit to every id', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    await tick(page, [0, 1]);
    await page.locator('[data-apv-bulk-open="edits"]').click();
    await page.locator('#apvBulkNote-edits').fill('Signed off as Kevin, not Operations Director.');
    await page.locator('[data-apv-bulk-edits]').click();
    await expect.poll(() => patches.length).toBe(2);
    for (const p of patches) {
      expect(p.fields[TF.approvalOutcome]).toBe('Approved with minor edits');
      expect(p.fields[APPROVAL_FEEDBACK]).toBe('Signed off as Kevin, not Operations Director.');
    }
  });

  test('Knock back writes the date on every id and no verdict on any', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    const ids = await tick(page, [1, 2]);
    await page.locator('[data-apv-bulk-open="defer"]').click();
    await page.locator('#apvBulkDeferWhy').fill('waiting on the authentication codes');
    await page.locator('#apvBulkPanel-defer .apv-defer-btn', { hasText: 'A week' }).click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches.map((p) => p.id)).toEqual(ids);
    for (const p of patches) {
      expect(p.fields[TF.deferredUntil]).toBe(isoPlus(7));
      expect(p.fields[TF.approvalOutcome]).toBeUndefined();
      expect(p.fields[TF.approvedAt]).toBeUndefined();
      expect(p.fields[TF.status]).toBeUndefined();
      expect(String(p.fields[TF.feedbackHistory])).toContain('waiting on the authentication codes');
    }
    await expect(page.locator('#toast')).toContainText('Knocked back 2');
  });

  test('a card decided elsewhere mid-bulk is reported, not counted, and the rest still save', async ({ page }) => {
    // The single path's stale guard re-reads each task before writing. The
    // mock keeps a reference to this array, so flipping a record after the
    // page loaded is exactly what Slack deciding it under him looks like.
    const fx = defaultFixtures();
    const patches = await mockAgentsPage(page, { approvals: fx.approvals });
    await loadAgentsPage(page);
    await openApprovals(page);
    const ids = await tick(page, [0, 1]);
    const stale = fx.approvals.find((r) => r.id === ids[0]);
    stale.fields[TF.status] = 'Completed';
    await page.locator('[data-apv-bulk-approve]').click();
    await expect(page.locator('#toast')).toContainText('Approved 1 of 2. 1 already decided elsewhere');
    expect(patches.map((p) => p.id)).toEqual([ids[1]]);
    await expect(page.locator('#apvBulk')).toBeHidden();
  });

  test('a bulk date in the past is refused, nothing written', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    await tick(page, [0, 1]);
    await page.locator('[data-apv-bulk-open="defer"]').click();
    await page.locator('#apvBulkDeferDate').fill(isoPlus(-2));
    await page.locator('#apvBulkPanel-defer .apv-defer-btn', { hasText: 'Go' }).click();
    await expect(page.locator('#toast')).toContainText('after today');
    expect(patches).toHaveLength(0);
  });
});

test.describe('the view moves on to the next card', () => {
  test('after Approve on a card part way down, its strip sits at the top with the next card below, then the next card takes the top', async ({ page }) => {
    const patches = await mockAgentsPage(page, withMany());
    await loadAgentsPage(page);
    await openApprovals(page);
    const before = await page.locator('.apv-card').count();
    expect(before).toBe(11);
    const decided = await idAt(page, 4);
    const next = await idAt(page, 5);
    await page.locator(`[data-apv-card="${decided}"]`).scrollIntoViewIfNeeded();
    await page.locator(`[data-apv-card="${decided}"] .apv-actions button`, { hasText: /^Approve$/ }).click();
    await expect.poll(() => patches.length).toBe(1);
    await expect(page.locator(`[data-apv-card="${decided}"] [data-apv-state="saved"]`)).toBeVisible();
    // Straight away, before the fold: the Undo at the top, the next card under it.
    await expectCardAtTop(page, decided);
    await expectCardJustBelow(page, decided, next);
    // And after the decided card folds away, the next card is at the top,
    // not the first card.
    await expect(page.locator('.apv-card')).toHaveCount(before - 1, { timeout: 8000 });
    await expectCardAtTop(page, next);
    expect(await page.evaluate(() => window.pageYOffset)).toBeGreaterThan(300);
  });

  test('after Approve on the LAST card, the view stays down on the card above it', async ({ page }) => {
    const patches = await mockAgentsPage(page, withMany());
    await loadAgentsPage(page);
    await openApprovals(page);
    const before = await page.locator('.apv-card').count();
    const above = await idAt(page, before - 2);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.locator('.apv-card').last().locator('.apv-actions button', { hasText: /^Approve$/ }).click();
    await expect.poll(() => patches.length).toBe(1);
    await expect(page.locator('.apv-card')).toHaveCount(before - 1, { timeout: 8000 });
    // Nothing below it to put at the top, so the page is as far down as it
    // goes, with the card above in view: never thrown back to the top.
    expect(await page.evaluate(() => window.pageYOffset)).toBeGreaterThan(300);
    await expect(page.locator(`[data-apv-card="${above}"]`)).toBeInViewport();
  });

  test('if he scrolls away during the Undo window, the fold leaves him there', async ({ page }) => {
    const patches = await mockAgentsPage(page, withMany());
    await loadAgentsPage(page);
    await openApprovals(page);
    const before = await page.locator('.apv-card').count();
    await page.locator('.apv-card').nth(0).locator('.apv-actions button', { hasText: /^Approve$/ }).click();
    await expect.poll(() => patches.length).toBe(1);
    await expect(page.locator('[data-apv-state="saved"]')).toBeVisible();
    // He goes to read the bottom of the list while the Undo counts down.
    await page.waitForTimeout(400);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const there = await page.evaluate(() => window.pageYOffset);
    expect(there).toBeGreaterThan(300);
    await expect(page.locator('.apv-card')).toHaveCount(before - 1, { timeout: 8000 });
    await page.waitForTimeout(100);
    // Within the height of the folded strip of where he was, not back at the top.
    expect(await page.evaluate(() => window.pageYOffset)).toBeGreaterThan(there - 120);
  });

  test('a one-click Knock back part way down saves in place: the next card takes the top, nothing typed is lost', async ({ page }) => {
    const patches = await mockAgentsPage(page, withMany());
    await loadAgentsPage(page);
    await openApprovals(page);
    const before = await page.locator('.apv-card').count();
    // A half-written note on the second card, then knock back a card further down.
    const secondId = await idAt(page, 1);
    await page.locator('#apvNote-' + secondId).fill('Check the dates with Roy first.');
    const decided = await idAt(page, 4);
    const next = await idAt(page, 5);
    await page.locator(`[data-apv-card="${decided}"]`).scrollIntoViewIfNeeded();
    await page.locator(`[data-apv-card="${decided}"] .apv-defer-btn`, { hasText: 'A week' }).first().click();
    await expect.poll(() => patches.some((p) => p.id === decided)).toBe(true);
    await expect(page.locator(`[data-apv-card="${decided}"] [data-apv-state="saved"]`)).toContainText('Knocked back to');
    // No rebuild: the note is still there, and the view is on this card and the next.
    await expect(page.locator('#apvNote-' + secondId)).toHaveValue('Check the dates with Roy first.');
    await expectCardAtTop(page, decided);
    await expectCardJustBelow(page, decided, next);
    await expect(page.locator('.apv-card')).toHaveCount(before - 1, { timeout: 8000 });
    await expectCardAtTop(page, next);
    await expect(page.locator('#apvNote-' + secondId)).toHaveValue('Check the dates with Roy first.');
  });

  test('a bulk Approve lands on the lowest ticked card, then the card after it', async ({ page }) => {
    const patches = await mockAgentsPage(page, withMany());
    await loadAgentsPage(page);
    await openApprovals(page);
    const before = await page.locator('.apv-card').count();
    const ids = await tick(page, [2, 3]);
    const next = await idAt(page, 4);
    await page.locator('[data-apv-bulk-approve]').click();
    await expect.poll(() => patches.length).toBe(2);
    await expect(page.locator('#toast')).toContainText('Approved all 2');
    await expect(page.locator(`[data-apv-card="${ids[1]}"] [data-apv-state="saved"]`)).toBeVisible();
    await expectCardAtTop(page, ids[1]);
    await expectCardJustBelow(page, ids[1], next);
    await expect(page.locator('.apv-card')).toHaveCount(before - 2, { timeout: 8000 });
    await expectCardAtTop(page, next);
  });

  test('after an Undo, a bulk Approve still lands on the lowest ticked card ON SCREEN', async ({ page }) => {
    // An Undo puts the card back where it was on the page, but at the end of
    // its rank in the page's list. Taking "lowest" from that list landed on
    // the undone card instead (review finding, 30 Sep 2026).
    const patches = await mockAgentsPage(page, withMany());
    await loadAgentsPage(page);
    await openApprovals(page);
    const before = await page.locator('.apv-card').count();
    const undone = await idAt(page, 4);
    await page.locator(`[data-apv-card="${undone}"]`).scrollIntoViewIfNeeded();
    await page.locator(`[data-apv-card="${undone}"] .apv-actions button`, { hasText: /^Approve$/ }).click();
    await expect.poll(() => patches.length).toBe(1);
    await page.locator(`[data-apv-card="${undone}"] [data-apv-undo]`).click();
    await expect.poll(() => patches.length).toBe(2);
    await expect(page.locator(`[data-apv-card="${undone}"] [data-apv-state]`)).toHaveCount(0);
    const ids = await tick(page, [4, 6]);
    expect(ids[0]).toBe(undone);
    const next = await idAt(page, 7);
    await page.locator('[data-apv-bulk-approve]').click();
    await expect.poll(() => patches.length).toBe(4);
    // The toast is set in the same step as the landing scroll. Card 6 is
    // written FIRST here, so its strip alone does not mean the run is over.
    await expect(page.locator('#toast')).toContainText('Approved all 2');
    await expect(page.locator(`[data-apv-card="${ids[1]}"] [data-apv-state="saved"]`)).toBeVisible();
    await expectCardAtTop(page, ids[1]);
    await expect(page.locator('.apv-card')).toHaveCount(before - 2, { timeout: 8000 });
    await expectCardAtTop(page, next);
  });

  test('a slow bulk run that finishes while the lowest card is folding still lands on the card after it', async ({ page }) => {
    // After an Undo the lowest card on screen is written FIRST, so it can
    // start folding before the run ends. Finishing inside that 320ms fold
    // used to point the view at a card on its way out, and every fold after
    // fell back to the first card (re-review finding, 30 Sep 2026). Card 4's
    // save is slowed to land the finish in that window. Outside the window
    // old and new code agree, so a busy machine cannot make this fail.
    const patches = await mockAgentsPage(page, withMany());
    await loadAgentsPage(page);
    await openApprovals(page);
    const before = await page.locator('.apv-card').count();
    const undone = await idAt(page, 4);
    const next = await idAt(page, 7);
    await page.locator(`[data-apv-card="${undone}"]`).scrollIntoViewIfNeeded();
    await page.locator(`[data-apv-card="${undone}"] .apv-actions button`, { hasText: /^Approve$/ }).click();
    await expect.poll(() => patches.length).toBe(1);
    await page.locator(`[data-apv-card="${undone}"] [data-apv-undo]`).click();
    await expect.poll(() => patches.length).toBe(2);
    await expect(page.locator(`[data-apv-card="${undone}"] [data-apv-state]`)).toHaveCount(0);
    let slowed = false;
    await page.route('**/v0/**', async (route) => {
      const r = route.request();
      if (!slowed && r.method() === 'PATCH' && r.url().includes(undone)) {
        slowed = true;
        await new Promise((res) => setTimeout(res, 5160));
      }
      return route.fallback();
    });
    await tick(page, [4, 6]);
    await page.locator('[data-apv-bulk-approve]').click();
    await expect(page.locator('#toast')).toContainText('Approved all 2', { timeout: 15000 });
    await expect(page.locator('.apv-card')).toHaveCount(before - 2, { timeout: 12000 });
    await page.waitForTimeout(400);
    await expectCardAtTop(page, next);
  });

  test('a bulk knock back lands on the card after the lowest ticked one', async ({ page }) => {
    const patches = await mockAgentsPage(page, withMany());
    await loadAgentsPage(page);
    await openApprovals(page);
    const next = await idAt(page, 4);
    await tick(page, [2, 3]);
    await page.locator('[data-apv-bulk-open="defer"]').click();
    await page.locator('#apvBulkPanel-defer .apv-defer-btn', { hasText: '3 days' }).click();
    await expect.poll(() => patches.length).toBe(2);
    await expect(page.locator('#toast')).toContainText('Knocked back 2');
    await expectCardAtTop(page, next);
  });
});
