// THE PLAIN SUMMARY on the card (Kevin, 22 Sep 2026): "too much information,
// quite difficult to decipher". Every card opens with what the task is and
// what approving does, in words a 13-year-old understands. agent-dispatch.py
// submit writes them into Plain Summary; a card from before that shows the
// task name with its filing tags taken off, and no guessed approve line.
const { test, expect } = require('@playwright/test');
const { TF, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

function withPlain() {
  const fx = defaultFixtures();
  fx.approvals[1].fields[TF.plainSummary] =
    'TASK: A water company wants a payment plan agreed.\nIF YOU APPROVE: The agent emails them the lowest monthly payment.';
  fx.approvals[1].fields[TF.agentOutput] = 'The plan was checked against the budget line by line. '.repeat(8)
    + '\n\n**Carrying this out will involve:** sending the payment plan proposal to the water company.';
  fx.approvals[2].fields[TF.name] = 'INBOUND: POST [MEDIUM]: Reply to tenant email';
  fx.approvals[0].fields[TF.name] = 'HMRC CFS-2427425: send tranche 1';
  return fx;
}

test.describe('the card opens with the plain summary', () => {
  test('a written summary shows both lines first, above the detailed line', async ({ page }) => {
    await mockAgentsPage(page, withPlain());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator('[data-apv-card="recApvA2"]');
    const plain = card.locator('[data-apv-plain]');
    await expect(plain).toHaveAttribute('data-apv-plain', 'written');
    await expect(plain.locator('[data-apv-plain-task]')).toHaveText('A water company wants a payment plan agreed.');
    await expect(plain.locator('[data-apv-plain-approve]')).toHaveText('The agent emails them the lowest monthly payment.');
    // The detailed line stays, relabelled so "If you approve" is not said twice.
    await expect(card.locator('.apv-ask')).toContainText('In detail, the agent will:');
    await expect(card.locator('.apv-ask')).not.toContainText('If you approve');
    // First thing on the card: nothing sits above the plain block.
    const first = await card.evaluate(el => el.firstElementChild.hasAttribute('data-apv-plain'));
    expect(first).toBe(true);
  });

  test('no summary: the tidied task name, and no guessed approve line', async ({ page }) => {
    await mockAgentsPage(page, withPlain());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const plain = page.locator('[data-apv-card="recApvB1"] [data-apv-plain]');
    await expect(plain).toHaveAttribute('data-apv-plain', 'fallback');
    await expect(plain.locator('[data-apv-plain-task]')).toHaveText('Reply to tenant email');
    await expect(plain.locator('[data-apv-plain-approve]')).toHaveCount(0);
  });

  test('every card carries the plain block, and the old small Task: line is gone', async ({ page }) => {
    await mockAgentsPage(page, withPlain());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const cards = page.locator('[data-apv-card]');
    const n = await cards.count();
    expect(n).toBeGreaterThan(0);
    await expect(page.locator('[data-apv-card] [data-apv-plain]')).toHaveCount(n);
    // innerText, line by line: a hasText regex anchored with ^ never matched
    // the old line inside the card's text, so it could not fail (review, 22 Sep 2026).
    const withOldLine = await cards.evaluateAll(cs => cs.filter(c => c.innerText.split('\n').some(l => /^\s*Task: /.test(l))).length);
    expect(withOldLine).toBe(0);
  });

  test('only known filing tags come off: a case reference stays', async ({ page }) => {
    await mockAgentsPage(page, withPlain());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator('[data-apv-card="recApvA1"] [data-apv-plain-task]')).toHaveText('HMRC CFS-2427425: send tranche 1');
  });
});
