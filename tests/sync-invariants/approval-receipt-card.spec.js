// THE REDO RECEIPT and THE REPORT GATE on the card (Kevin, 7 Sep 2026).
// After "Changes requested" the agent's resubmit answers his points one by
// one (agent-dispatch.py writes them into Notes); the card leads with them.
// A report on an inbound item names the trigger that makes it his; the card
// shows it as "Why you".
const { test, expect } = require('@playwright/test');
const { TF, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

function withReceipt() {
  const fx = defaultFixtures();
  fx.approvals[0].fields[TF.notes] = [
    '[04 Sep 2026 12:03 — agent] first note',
    '[04 Sep 2026 19:10 — agent-dispatch] FEEDBACK ANSWERED (round 1):\n- check the Number of Bedrooms field → it said 2; the property has 5 across 2 units\n- resend the email -> done, figures corrected',
    '[05 Sep 2026 03:05 — agent-dispatch] FEEDBACK ANSWERED (round 2):\n- recheck the data on 6 Chedburgh Place → 5 bedrooms confirmed from the Rental Units table\n- it has two units not two bedrooms -> cannot: the units table lists 2 units; bedrooms are now stated per unit',
  ].join('\n\n');
  fx.approvals[1].fields[TF.agentOutput] = 'CHECKED: handled=no; roy=no; machine=no; open-task=no; trigger=deadline\n\nThe council wants the certificate by 26 Sep. Draft below.\n\n**Carrying this out will involve:** sending the quote request to the electrician.';
  return fx;
}

test.describe('the card leads with the answered feedback', () => {
  test('shows the NEWEST round, one line per point, and flags a cannot', async ({ page }) => {
    await mockAgentsPage(page, withReceipt());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator('[data-apv-card="recApvA1"]');
    const r = card.locator('[data-apv-receipt]');
    await expect(r).toHaveAttribute('data-apv-receipt', '2');
    await expect(r).toContainText('Your feedback, answered (round 2)');
    await expect(r.locator('.apv-receipt-line')).toHaveCount(2);
    await expect(r.locator('.apv-receipt-change.cannot')).toContainText('cannot: the units table');
    await expect(r).not.toContainText('Number of Bedrooms field');
    // The receipt sits above the ask, so it is the first thing read.
    const receiptTop = await r.boundingBox();
    const askTop = await card.locator('.apv-ask').boundingBox();
    expect(receiptTop.y).toBeLessThan(askTop.y);
  });
  test('a card with no receipt shows nothing extra', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator('[data-apv-receipt]')).toHaveCount(0);
  });
  test('a report names why it is Kevin\'s', async ({ page }) => {
    await mockAgentsPage(page, withReceipt());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const why = page.locator('[data-apv-card="recApvA2"] [data-apv-why]');
    await expect(why).toContainText('Why you: a deadline with a cost');
    await expect(page.locator('[data-apv-card="recApvB1"] [data-apv-why]')).toHaveCount(0);
  });
});
