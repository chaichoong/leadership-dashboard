// WHY, NOT JUST NO — the reason chips on the approvals gate (27 Aug 2026).
//
// Measured live that day across every approval decision Kevin had made:
// 175 decisions, 58 rejections, and NOT ONE said the draft was wrong. Every
// rejection said the task should not have existed. He was typing the same
// sentence over and over ("Roy is dealing with this" seven separate times) at
// roughly two and a half minutes a decision, and every one of those rejections
// counted against the agent that WROTE the draft rather than whatever created
// the task.
//
// The invariants that make the fix real rather than decorative:
//
//   1. One tap records a verdict, a reason AND a sentence. If the reason did
//      not reach Airtable, nothing downstream can separate a bad draft from a
//      task that should not have existed, and the score stays wrong.
//   2. A chip never overwrites words Kevin has already typed. His words are
//      more specific than the default, and losing them mid-click is exactly
//      the small betrayal that stops someone using the fast path.
//   3. "The work is wrong" — the ONE reason that counts against the agent —
//      still demands he says what is wrong, because that is the only feedback
//      an agent can act on.
//
// Airtable is mocked, so this asserts on the PATCH the page actually sends.

const { test, expect } = require('@playwright/test');
const { TF, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

const VERDICT_REASON = 'fldF9Bs4N5mttQvtl';
// agents-page.helpers.js does not export this one, so it is named here from
// the same constants block in os/agents/index.html.
const APPROVAL_FEEDBACK = 'fldtI7SJI4gEohHD1';

async function openApprovals(page) {
  await page.click('#ptab-approvals');
  await expect(page.locator('#view-approvals')).toBeVisible();
  return page.locator('.apv-card').first();
}

/** "No", then one chip. No dialog since 7 Sep 2026: the chip IS the rejection,
 *  with a five-second Undo in place of a confirm. Returns the PATCH sent. */
async function rejectVia(page, patches, chipText) {
  const card = await openApprovals(page);
  const taskId = await card.getAttribute('data-apv-card');
  await card.locator('.apv-actions button', { hasText: /^No$/ }).click();
  await card.locator('.apv-reason', { hasText: chipText }).first().click();
  await expect(page.locator('button', { hasText: 'Reject and close' })).toHaveCount(0);
  await expect.poll(() => patches.some((p) => p.id === taskId)).toBe(true);
  return patches.find((p) => p.id === taskId);
}

test.describe('the approvals gate records WHY', () => {
  test('every reason Kevin actually gave has a chip', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    const card = await openApprovals(page);
    await card.locator('.apv-actions button', { hasText: /^No$/ }).click();
    // Derived from classifying all 58 of his rejections. If a chip goes
    // missing he goes back to typing, which is the cost this removes.
    for (const label of ['Already done', 'Roy owns it', 'Not worth my time',
                         'Duplicate', 'Parked', 'No longer relevant', 'The work is wrong']) {
      await expect(card.locator('.apv-reason', { hasText: label }).first(),
        `chip missing: ${label}`).toBeVisible();
    }
  });

  test('one tap writes the verdict, the reason and the sentence', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    const patch = await rejectVia(page, patches, 'Roy owns it');

    expect(patch.fields[TF.approvalOutcome]).toBe('Rejected');
    // THE load-bearing assertion. Without the reason on the record, the
    // quality/relevance split has nothing to read and accuracy stays wrong.
    expect(patch.fields[VERDICT_REASON]).toBe('Roy owns it');
    // And he typed nothing at all.
    expect(String(patch.fields[APPROVAL_FEEDBACK] || '')).toContain('Roy is dealing with this');
  });

  test('a chip does NOT overwrite words Kevin already typed', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    const card = await openApprovals(page);
    const taskId = await card.getAttribute('data-apv-card');

    const mine = 'Roy owns 1406 Oldham Road specifically, not the whole portfolio.';
    await card.locator('.apv-more').click();
    await card.locator('#apvNote-' + taskId).fill(mine);
    await card.locator('.apv-actions button', { hasText: /^No$/ }).click();
    await card.locator('.apv-reason', { hasText: 'Roy owns it' }).first().click();
    await expect.poll(() => patches.some((p) => p.id === taskId)).toBe(true);

    const patch = patches.find((p) => p.id === taskId);
    expect(patch.fields[VERDICT_REASON]).toBe('Roy owns it');
    expect(String(patch.fields[APPROVAL_FEEDBACK])).toBe(mine);
  });

  test('"The work is wrong" refuses to proceed on a default sentence', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    const card = await openApprovals(page);
    const taskId = await card.getAttribute('data-apv-card');
    await card.locator('.apv-actions button', { hasText: /^No$/ }).click();
    await card.locator('.apv-reason', { hasText: 'The work is wrong' }).first().click();
    // No dialog: it is the one reason an agent can act on, so it needs words.
    // The note opens in place, focused, with its own Reject button.
    await expect(page.locator('button', { hasText: 'Reject and close' })).toHaveCount(0);
    await expect(card.locator('#apvNote2-' + taskId)).toBeFocused();
  });

  test('a relevance chip closes in one tap, says Saved in place, and can be undone for five seconds', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    const card = await openApprovals(page);
    const taskId = await card.getAttribute('data-apv-card');
    // The chip title carries the truth about the score: the old dialog said
    // every rejection counted against the agent, which was true of none of
    // the 58 he had made.
    await card.locator('.apv-actions button', { hasText: /^No$/ }).click();
    await expect(card.locator('.apv-reason', { hasText: 'Already done' }).first()).toHaveAttribute('title', /does not count against/);
    await card.locator('.apv-reason', { hasText: 'Already done' }).first().click();
    await expect(card.locator('[data-apv-state="saved"]')).toContainText('Closed');
    await expect(page.locator('.modal, [role="dialog"]')).toHaveCount(0);
    // The card is still where it was; nothing else on the page was rebuilt.
    await expect(page.locator('.apv-card')).toHaveCount(3);
    await card.locator('[data-apv-undo]').click();
    await expect.poll(() => patches.filter((p) => p.id === taskId).length).toBe(2);
    const undo = patches.filter((p) => p.id === taskId)[1];
    expect(undo.fields[TF.status]).toBe('Approval');
    expect(undo.fields[TF.approvalOutcome]).toBeNull();
    expect(undo.fields[VERDICT_REASON]).toBeNull();
    await expect(card.locator('.apv-actions button', { hasText: /^Approve$/ })).toBeVisible();
  });

  // ─── THE GAP THE CHIPS LEFT (4 Sep 2026) ─────────────────────────
  //
  // The red Reject button sits beside the chips and skips them, so a rejection
  // could be written with Verdict Reason EMPTY. Four of Kevin's on 3 Sep were
  // (rec6x6sfB3kmL7Vfi, rec7alvvt370LsEf6, rec8Gh5YGCNf332Pg,
  // recrHeCCTna0WluLl): he typed his own sentence and pressed Reject. Empty
  // reads exactly like a field that was never written, so nobody saw it for
  // three days, and the lesson writer had nothing to route.
  //
  // Rejecting in his own words stays a first-class route (his ruling, 28 Aug
  // 2026, guarded in approval-knock-back.spec.js). It now records "Something
  // else" — he did not say which kind — which scores as a blank always did.
  test('a reject in his own words records Something else, never a blank', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    const card = await openApprovals(page);
    const taskId = await card.getAttribute('data-apv-card');

    const his = 'I am not interested in this at this moment in time.';
    await card.locator('.apv-actions button', { hasText: /^No$/ }).click();
    await card.locator('.apv-reason', { hasText: 'Something else' }).first().click();
    await card.locator('#apvNote2-' + taskId).fill(his);
    await card.locator('#apvRejectNote-' + taskId + ' button', { hasText: 'Reject' }).click();
    await expect.poll(() => patches.some((p) => p.id === taskId)).toBe(true);

    const patch = patches.find((p) => p.id === taskId);
    expect(patch.fields[TF.approvalOutcome]).toBe('Rejected');
    // THE load-bearing assertion: never blank, never absent.
    expect(patch.fields[VERDICT_REASON]).toBe('Something else');
    expect(String(patch.fields[APPROVAL_FEEDBACK])).toBe(his);
  });

  test('a failed write stays on the card with Try again, never a vanishing toast', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await page.route('**/api.airtable.com/**', async (route) => {
      if (route.request().method() === 'PATCH') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"server"}}' });
      return route.fallback();
    });
    await loadAgentsPage(page);
    const card = await openApprovals(page);
    await card.locator('.apv-actions button', { hasText: /^Approve$/ }).click();
    const strip = card.locator('[data-apv-state="failed"]');
    await expect(strip).toContainText('Not saved');
    await expect(strip.locator('[data-apv-retry]')).toBeVisible();
    // The card is untouched and still decidable.
    await expect(card.locator('.apv-actions button', { hasText: /^Approve$/ })).toBeEnabled();
    expect(patches.length).toBe(0);
  });

  test('the approve buttons are untouched — this changed rejection only', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    const card = await openApprovals(page);
    await expect(card.locator('.apv-actions button', { hasText: /^Approve$/ })).toBeVisible();
    // The two slower approvals live behind "More" (7 Sep 2026): two buttons
    // on the card, everything else one tap away.
    await card.locator('.apv-more').click();
    await expect(card.locator('.apv-panel button', { hasText: 'Approve with minor edits' })).toBeVisible();
    await expect(card.locator('.apv-panel button', { hasText: 'Request changes' })).toBeVisible();
  });

  // Kevin's ruling, 4 Sep 2026, reversing 26 Aug: over 14 days he wrote 132
  // pieces of feedback and ticked Remember on 18, while nearly every rejection
  // was a rule ("Roy is dealing with this", "only bring me this if major"). So
  // a rejection is remembered unless he unticks the box in the dialog.
  test('a rejection is remembered by default', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    const patch = await rejectVia(page, patches, 'Roy owns it');
    expect(patch.fields[TF.approvalOutcome]).toBe('Rejected');
    expect(patch.fields['fldZurhdHutYIDKVx']).toBe(true);
  });
  test('unticking Remember on the card makes the rejection a one-off', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    const card = await openApprovals(page);
    const taskId = await card.getAttribute('data-apv-card');
    await card.locator('.apv-actions button', { hasText: /^No$/ }).click();
    // ONE Remember box, beside the reasons, at the moment of commitment.
    const box = card.locator('#apvRemember-' + taskId);
    await expect(box).toBeChecked();
    await expect(page.locator('#apvRememberConfirm')).toHaveCount(0);
    await box.uncheck();
    await card.locator('.apv-reason', { hasText: 'Roy owns it' }).first().click();
    await expect.poll(() => patches.some((p) => p.id === taskId)).toBe(true);
    const oneOff = patches.find((p) => p.id === taskId);
    expect(oneOff.fields[TF.approvalOutcome]).toBe('Rejected');
    expect(oneOff.fields['fldZurhdHutYIDKVx']).toBeUndefined();
  });
});
