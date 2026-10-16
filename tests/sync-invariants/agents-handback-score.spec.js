// The hand-back score on every AI Agents scorecard (Kevin, 16 Oct 2026): he does four things only
// (approve, correct wrong work, pay, give access), and each agent is scored on the cards that
// asked him for anything else. The Mac works it out (scripts/ai_team_health.py, the "You only
// approve, pay or give access" line of the ai-team-verdict row); this page only draws it. A row
// that cannot be read, is stale or is grey must say so, never show a number.
const { test, expect } = require('@playwright/test');
const { AGENT_A, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

const ES = { key: 'fldLO6xJqkokvVR4g', payload: 'fldiqs9lvyLimoR7i' };

function verdictRow({ minutesOld = 5, line } = {}) {
  const computedAt = new Date(Date.now() - minutesOld * 60000).toISOString();
  const hb = line || {
    key: 'handback', colour: 'red', number: 56, answer: '4 of 9 cards came back to you',
    byAgent: [{ id: AGENT_A, name: 'Creditor Management', cards: 8, back: 3, score: 62, colour: 'red',
      reasons: { 'you did a sign-in or settings step': 2, 'you could not do the step it gave you': 1 } }],
  };
  return { id: 'recEsVerdict', createdTime: computedAt, fields: {
    [ES.key]: 'ai-team-verdict',
    [ES.payload]: JSON.stringify({ version: 2, computedAt, lines: [hb], overall: { colour: 'red' } }),
  } };
}

const card = (page, name) => page.locator('.sc-card', { hasText: name });

test.describe('AI Agents scorecards: Came back to you', () => {
  test('each agent shows the cards that came back, in its colour, with the reasons on hover', async ({ page }) => {
    await mockAgentsPage(page, { estate: [verdictRow()] });
    await loadAgentsPage(page);
    const creditor = card(page, 'Creditor Management');
    await expect(creditor).toContainText('Came back to you');
    const val = creditor.locator('.sc-val.bad', { hasText: '3 of 8 (score 62)' });
    await expect(val).toHaveCount(1);
    await expect(val).toHaveAttribute('title', /3 of 8 cards asked you for more than approving, correcting, paying or giving access/);
    await expect(val).toHaveAttribute('title', /2 × you did a sign-in or settings step/);
    // An agent the Mac found no cards for says so in words, never "0 of 0".
    await expect(card(page, 'Inbound Comms Response')).toContainText('no cards in 14 days');
  });

  test('a row over 2 hours old, or a grey line, reads "can\'t tell", never the old number', async ({ page }) => {
    await mockAgentsPage(page, { estate: [verdictRow({ minutesOld: 180 })] });
    await loadAgentsPage(page);
    const v = card(page, 'Creditor Management').locator('.sc-val.warn', { hasText: "can't tell" });
    await expect(v).toHaveCount(1);
    await expect(v).toHaveAttribute('title', /over 2 hours ago/);
    await expect(card(page, 'Creditor Management')).not.toContainText('score 62');

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await mockAgentsPage(page, { estate: [verdictRow({ line: { key: 'handback', colour: 'grey', why: 'the 14-day read missed 1 the task board shows' } })] });
    await loadAgentsPage(page);
    await expect(card(page, 'Creditor Management').locator('.sc-val.warn', { hasText: "can't tell" }))
      .toHaveAttribute('title', /the 14-day read missed 1/);
  });

  test('a status table that cannot be read says unavailable, never a score', async ({ page }) => {
    await mockAgentsPage(page, { estate: [verdictRow()] });
    await page.route('**/api.airtable.com/**/tblZVrdzivyBueZVf**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"SERVER_ERROR"}' }));
    await loadAgentsPage(page);
    await expect(card(page, 'Creditor Management').locator('.sc-val.warn', { hasText: 'unavailable' })).toHaveCount(1);
    await expect(card(page, 'Creditor Management')).not.toContainText('score 62');
  });
});
