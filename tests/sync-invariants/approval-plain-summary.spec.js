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
  fx.approvals[0].fields[TF.name] = 'HMRC CFS-0000000: send tranche 1';
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
    await expect(page.locator('[data-apv-card="recApvA1"] [data-apv-plain-task]')).toHaveText('HMRC CFS-0000000: send tranche 1');
  });
});

// THEN YOUR STEP (Kevin, 27 Oct 2026): "If I approve should basically mean what happens if I press
// the approve button. If there's anything that I need to do, it needs to be the other version of
// the approval card where it tells me to do it." A step of his is the agent's KEVIN ONLY line, and
// the card says on a line of its own that it comes back as its own card, never inside the approve line.
test.describe('a step of Kevin\'s shows as Then your step, on its own line', () => {
  function withStep() {
    const fx = withPlain();
    fx.approvals[1].fields[TF.agentOutput] = 'The quote form was filled from the records line by line. '.repeat(8)
      + '\n\nKEVIN ONLY: purchase: buy the chosen policy in one session, paying monthly. 1. Open the window. 2. Buy it.'
      + '\n\n**Carrying this out will involve:** the robot filling the quote form for 18 Example Road.';
    fx.approvals[1].fields[TF.plainSummary] =
      'TASK: The landlord insurance for 18 Example Road renews next week.\nIF YOU APPROVE: The robot fills the quote form for 18 Example Road.';
    fx.approvals[2].fields[TF.agentOutput] = 'KEVIN ONLY: review: 1. Paste the prompt into a new chat. 2. Go through the records.';
    return fx;
  }

  test('the declared step reads after the approve line, cut before its numbered steps', async ({ page }) => {
    await mockAgentsPage(page, withStep());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const then = page.locator('[data-apv-card="recApvA2"] [data-apv-then-step]');
    await expect(then).toHaveAttribute('data-apv-then-step', 'purchase');
    await expect(then).toHaveText('Buy the chosen policy in one session, paying monthly. This comes back to you as its own card once you approve: you do it there and add the proof.');
    // It follows the approve line, inside the same plain block.
    const order = await page.locator('[data-apv-card="recApvA2"] [data-apv-plain]').evaluate(el =>
      [...el.querySelectorAll('[data-apv-plain-approve],[data-apv-then-step]')].map(n => n.hasAttribute('data-apv-then-step')));
    expect(order).toEqual([false, true]);
  });

  test('a step written only as numbered steps reads as its kind', async ({ page }) => {
    await mockAgentsPage(page, withStep());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator('[data-apv-card="recApvB1"] [data-apv-then-step]'))
      .toHaveText('You go through it in a chat with Claude. This comes back to you as its own card once you approve: you do it there and add the proof.');
  });

  test('a card with no declared step has no Then your step line', async ({ page }) => {
    await mockAgentsPage(page, withStep());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator('[data-apv-card="recApvA1"] [data-apv-then-step]')).toHaveCount(0);
  });
});
