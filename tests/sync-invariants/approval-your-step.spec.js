// YOUR STEP (Kevin, 7 Oct 2026; PR 2 of 5). 13 tasks sat on a step only Kevin could take and
// none was in front of him: the card left this queue the moment he approved it. Now
// scripts/agent-dispatch.py puts such a task back here, still APPROVED, with a YOUR STEP block
// on top of the agent's work. Invariants:
//   1. The card shows the step (as text), the Your turn button when the sweep marked a plan,
//      and a "Done, here is the proof" box; NO approve, edit, change or reject buttons, and no
//      tick box, because it is approved already.
//   2. Done writes his proof into Approval Feedback under KEVIN STEP DONE, keeping any note
//      already there, and never touches the verdict, the status or Approved At.
//   3. No route can write a verdict on it: the card's own write path refuses (a no-op).
//   4. A proof already given shows as given, with no second box.
// Airtable is mocked (agents-page.helpers.js), so this runs with no PAT. Names are invented.
const { test, expect } = require('@playwright/test');
const { TF, AGENT_A, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

const FEEDBACK = 'fldtI7SJI4gEohHD1';
const ID = 'recYourStepAaaaaa';
const DIVIDER = "----- The agent's work, as you approved it -----";
const ES = {
  key: 'fldLO6xJqkokvVR4g', kind: 'fldfjQOn76VpgKEfZ', label: 'fldlnvvTh8l5UIih4', status: 'fldhOUiva3bqPNk1c',
  lastRun: 'flduxV3TYwp9wQX9O', detail: 'fldLRFP2nJttDVQOa', payload: 'fldiqs9lvyLimoR7i', updated: 'fld3q8WN5XqrER92Z',
};

function withStep({ feedback = '', turn = false, step = '1. Sign page 3 <b>now</b>.\n2. Post it to the council.' } = {}) {
  const fx = defaultFixtures();
  const now = new Date().toISOString();
  fx.approvals.push({ id: ID, createdTime: now, fields: {
    [TF.name]: 'INSURANCE: Example Lane cover', [TF.status]: 'Approval', [TF.priority]: 'High',
    [TF.approvalOutcome]: 'Approved with minor edits',
    [TF.agentOutput]: `YOUR STEP: ${step}\n\n${DIVIDER}\n\nQuote ready from Example Insurer, 41 a month.`,
    [FEEDBACK]: feedback, [TF.sentForApprovalBy]: [AGENT_A], [TF.teamMember]: [AGENT_A], [TF.lmt]: now,
    [TF.taskType]: 'Admin',
  } });
  if (turn) {
    fx.estate = [{ id: 'recBlk', fields: {
      [ES.key]: 'agent-blockers', [ES.kind]: 'report', [ES.label]: 'Robots blocked', [ES.status]: 'Worked',
      [ES.lastRun]: now, [ES.updated]: now, [ES.detail]: 'Robots blocked on 1 task.',
      [ES.payload]: JSON.stringify({ open: [{ task: ID, name: 'INSURANCE: Example Lane cover', kind: 'KEVIN',
        subject: 'purchase', turn: true, step: '1. Buy it.', yourStep: true }], stale: 0, closedWhileBlocked: [], woken: 0 }),
    } }];
  }
  return fx;
}

test.describe('Your step: an approved card back in his lane', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' });

  test('shows the step as text, the agent\'s work below, and no verdict buttons or tick box', async ({ page }) => {
    await mockAgentsPage(page, withStep());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator(`[data-apv-card="${ID}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('[data-apv-step-text]')).toHaveText('1. Sign page 3 <b>now</b>.\n2. Post it to the council.');
    await expect(card.locator('[data-apv-step-text] b')).toHaveCount(0);       // escaped, never markup
    await expect(card.locator('[data-apv-work]')).toContainText('Quote ready from Example Insurer');
    await expect(card.locator('[data-apv-work]')).not.toContainText('YOUR STEP');
    await expect(card.locator('button[onclick*="agDecide"]')).toHaveCount(0);
    await expect(card.locator('.apv-defer')).toBeVisible();   // a knock-back to a date is still his
    await expect(card.locator('button', { hasText: /^Approve/ })).toHaveCount(0);
    await expect(card.locator('button', { hasText: 'Request changes' })).toHaveCount(0);
    await expect(card.locator('.apv-reason')).toHaveCount(0);
    await expect(card.locator('[data-apv-pick]')).toHaveCount(0);
    await expect(card.locator('[data-apv-step-done]')).toHaveText('Done, here is the proof');
    // An ordinary card on the same page still has its buttons: the change is scoped to Your step.
    await expect(page.locator('[data-apv-card="recApvB1"] button[onclick*="agDecide"]').first()).toBeVisible();
  });

  test('carries the Your turn button when the sweep marked a plan, from the same row the sign-ins panel reads', async ({ page }) => {
    await mockAgentsPage(page, withStep({ turn: true }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const btn = page.locator(`[data-apv-card="${ID}"] [data-apv-step-turn="${ID}"]`);
    await expect(btn).toHaveAttribute('href', `robotsignin://turn/${ID}`);
    await expect(btn).toHaveText('Your turn');
  });

  test('Done writes the proof under KEVIN STEP DONE, keeps his note, and never touches the verdict', async ({ page }) => {
    const fx = withStep({ feedback: 'Use the business card.' });
    const patches = await mockAgentsPage(page, fx);
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator(`[data-apv-card="${ID}"]`);
    // An empty box writes nothing.
    await card.locator('[data-apv-step-done]').click();
    await page.waitForTimeout(300);
    expect(patches.filter((p) => p.id === ID)).toHaveLength(0);
    await card.locator(`#apvNote-${ID}`).fill('Signed and posted,   recorded delivery EX123');
    await card.locator('[data-apv-step-done]').click();
    await expect.poll(() => patches.filter((p) => p.id === ID).length).toBe(1);
    const p = patches.find((x) => x.id === ID).fields;
    expect(p[FEEDBACK]).toMatch(/^Use the business card\.\nKEVIN STEP DONE \[\d{4}-\d{2}-\d{2}T[0-9:.]+Z\]: Signed and posted, recorded delivery EX123$/);
    expect(p[TF.feedbackHistory]).toMatch(/Done, here is the proof: Signed and posted, recorded delivery EX123$/);
    for (const k of [TF.approvalOutcome, TF.approvedAt, TF.status, TF.agentOutput, TF.completionDate]) {
      expect(k in p, `the Done box wrote ${k}`).toBe(false);
    }
    await expect(page.locator(`[data-apv-card="${ID}"] [data-apv-step-said]`)).toContainText('You said it is done');
    await expect(page.locator(`[data-apv-card="${ID}"] [data-apv-step-done]`)).toHaveCount(0);
  });

  test('approving it again is a no-op: the write path refuses it and Select all never ticks it', async ({ page }) => {
    const patches = await mockAgentsPage(page, withStep());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator(`[data-apv-card="${ID}"]`)).toBeVisible();
    const said = await page.evaluate((id) => window.applyApprovalDecision(id, 'Approved as-is', false), ID);
    expect(said).toBe('elsewhere');
    await page.waitForTimeout(300);
    expect(patches.filter((x) => x.id === ID)).toHaveLength(0);
    const ticked = await page.evaluate((id) => { apvSelectAllShown(); return apvBulkIds().includes(id); }, ID);
    expect(ticked).toBe(false);
  });

  test('a proof already given shows as given, with no second box', async ({ page }) => {
    await mockAgentsPage(page, withStep({ feedback: 'KEVIN STEP DONE [2026-10-07T10:00:00.000Z]: paid, ref EX-12' }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator(`[data-apv-card="${ID}"]`);
    await expect(card.locator('[data-apv-step-said]')).toContainText('paid, ref EX-12');
    await expect(card.locator('[data-apv-step-done]')).toHaveCount(0);
  });
});
