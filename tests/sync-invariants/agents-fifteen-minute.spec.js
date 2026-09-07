// AUTONOMY LEVELS on the AI Agents page (Kevin's ruling, 7 Sep 2026; Chen
// Book 4 ch 5 and ch 7).
//
// Two surfaces, built in the SAME change as the suppression they report on:
//   1. "Handled without you" on Check these — every Level A carry-out the
//      dispatcher made (its Notes marker), with a one-tap Reverse on a close.
//   2. The 15-Minute Dashboard on the Dashboard tab — exception rate, quality,
//      learning loop, trust levels with migration candidates, cross-function
//      health. Read-only: candidates are named, Kevin clicks.
const { test, expect } = require('@playwright/test');
const { TF, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

const AGENT_A = 'recTmCreditorMgmt';
const AGENT_B = 'recTmInboundResp';

function withHandled() {
  const fx = defaultFixtures();
  const now = new Date().toISOString();
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  fx.handled = [
    { id: 'recHandledClose', createdTime: dayAgo, fields: {
      [TF.name]: 'INBOUND: Sefton licence fee reminder', [TF.status]: 'Completed', [TF.completionDate]: dayAgo, [TF.lmt]: dayAgo,
      [TF.teamMember]: [AGENT_B], [TF.taskType]: 'Admin',
      [TF.agentOutput]: 'CLOSE PROPOSAL: duplicate of recKEEPER00000001 — folded into it',
      [TF.notes]: '[06 Sep 2026 13:02 — agent-dispatch] HANDLED WITHOUT YOU (close: duplicate): folded into keeper recKEEPER00000001 "INBOUND: pay Sefton licence" (Today, created 2026-09-01). Level A, Kevin\'s ruling 7 Sep 2026. Reverse it within 24 hours from Check these → Handled without you.',
    } },
    { id: 'recHandledRoy', createdTime: now, fields: {
      [TF.name]: 'MAINTENANCE: boiler repair 6 Chedburgh Place', [TF.status]: 'Today', [TF.lmt]: now,
      [TF.teamMember]: [AGENT_A], [TF.taskType]: 'Admin',
      [TF.agentOutput]: 'PASS TO ROY: boiler not firing',
      [TF.notes]: '[07 Sep 2026 09:10 — agent-dispatch] HANDLED WITHOUT YOU (pass to Roy): name matched \'repair\', nothing vetoed; Roy\'s standing approval. Level A, Kevin\'s ruling 7 Sep 2026. Reverse it within 24 hours from Check these → Handled without you.\n\n[07 Sep 2026 — agent-dispatch] Handed over to Roy Lavin (roy.lavin1978@gmail.com): PASS TO ROY at Level A',
    } },
    { id: 'recHandledReversed', createdTime: dayAgo, fields: {
      [TF.name]: 'INBOUND: something Kevin took back', [TF.status]: 'Today', [TF.lmt]: now,
      [TF.teamMember]: [AGENT_B], [TF.taskType]: 'Admin',
      [TF.notes]: '[06 Sep 2026 13:02 — agent-dispatch] HANDLED WITHOUT YOU (close: already handled): already handled by Completed task recDONE0000000001. Level A.\n\n[07 Sep 2026 08:30 — Kevin] REVERSED from Handled without you: reopened for a second look.',
    } },
  ];
  // Thirty days of history for the dashboard: A finished 4 without a card
  // (no outcome), 6 through Kevin; B finished 2 through Kevin.
  const hist = [];
  for (let i = 0; i < 4; i++) hist.push({ id: 'recNoCard' + i, createdTime: now, fields: {
    [TF.teamMember]: [AGENT_A], [TF.status]: 'Completed', [TF.completionDate]: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
    [TF.taskType]: 'Admin', [TF.name]: 'closed quietly ' + i, [TF.notes]: i < 2 ? 'HANDLED WITHOUT YOU (close: duplicate): x' : '',
  } });
  for (let i = 0; i < 6; i++) hist.push({ id: 'recThroughA' + i, createdTime: now, fields: {
    [TF.teamMember]: [AGENT_A], [TF.sentForApprovalBy]: [AGENT_A], [TF.status]: 'Completed', [TF.completionDate]: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
    [TF.approvalOutcome]: i === 5 ? 'Rejected' : 'Approved as-is', [TF.approvedAt]: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
    [TF.verdictReason]: i === 5 ? 'Already done elsewhere' : undefined,
    [TF.taskType]: 'Correspondence', [TF.name]: 'INBOUND: reply ' + i, [TF.agentOutput]: 'TO: a@b.com\nFROM: k@g.com\nSUBJECT: x\n---\nhi',
    [TF.lessonWrittenAt]: i === 5 ? new Date(Date.now() - 86400000).toISOString() : undefined,
  } });
  for (let i = 0; i < 2; i++) hist.push({ id: 'recThroughB' + i, createdTime: now, fields: {
    [TF.teamMember]: [AGENT_B], [TF.sentForApprovalBy]: [AGENT_B], [TF.status]: 'Completed', [TF.completionDate]: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
    [TF.approvalOutcome]: 'Approved as-is', [TF.approvedAt]: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
    [TF.taskType]: 'Admin', [TF.name]: 'CLOSE ' + i, [TF.agentOutput]: 'CLOSE PROPOSAL: dead — stale',
  } });
  fx.taskHistory = hist;
  return fx;
}

test.describe('Handled without you — every Level A action is listed and reversible', () => {
  test('the lane names the agent, the category and the evidence, and hides what Kevin already reversed', async ({ page }) => {
    await mockAgentsPage(page, withHandled());
    await loadAgentsPage(page);
    await page.click('#ptab-checks');
    const body = page.locator('#checksBody');
    await expect(body).toContainText('Inbound Comms Response handled "INBOUND: Sefton licence fee reminder" without you (close: duplicate).');
    await expect(body).toContainText('folded into keeper recKEEPER00000001');
    await expect(body).toContainText('Creditor Management handled "MAINTENANCE: boiler repair 6 Chedburgh Place" without you (pass to Roy).');
    await expect(body).not.toContainText('something Kevin took back');
  });
  test('Reverse reopens a close on today\'s board and notes the reversal; a handover has no Reverse button', async ({ page }) => {
    const patches = await mockAgentsPage(page, withHandled());
    await loadAgentsPage(page);
    await page.click('#ptab-checks');
    await expect(page.locator('[data-handled-reverse="recHandledRoy"]')).toHaveCount(0);
    page.once('dialog', d => d.accept());
    await page.click('[data-handled-reverse="recHandledClose"]');
    await expect.poll(() => patches.length).toBeGreaterThan(0);
    const p = patches.find(x => x.id === 'recHandledClose');
    expect(p.fields[TF.status]).toBe('Today');
    expect(p.fields[TF.completionDate]).toBeNull();
    expect(p.fields[TF.notes]).toMatch(/REVERSED from Handled without you/);
    // The original marker is kept: the reversal is appended, never overwritten.
    expect(p.fields[TF.notes]).toMatch(/HANDLED WITHOUT YOU \(close: duplicate\)/);
  });
  test('a lane that cannot be read says so instead of reading as clean', async ({ page }) => {
    const fx = withHandled();
    await mockAgentsPage(page, fx);
    await page.route('**/api.airtable.com/**', async (route) => {
      const url = decodeURIComponent(route.request().url().replace(/\+/g, ' '));
      if (url.includes('HANDLED WITHOUT YOU')) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
      return route.fallback();
    });
    await loadAgentsPage(page);
    await page.click('#ptab-checks');
    await expect(page.locator('#checksBody')).toContainText('The "Handled without you" check could not run');
  });
});

test.describe('the 15-Minute Dashboard', () => {
  test('exception rate, quality, learning loop, levels and health all render from the 30-day read', async ({ page }) => {
    await mockAgentsPage(page, withHandled());
    await loadAgentsPage(page);
    const zone = page.locator('[data-fifteen]');
    await expect(zone).toBeVisible();
    // 1. Exception rate: 12 finished, 4 without a card = 33%.
    const ex = zone.locator('[data-f15="exceptions"]');
    await expect(ex).toContainText('33%');
    await expect(ex).toContainText('of 12 tasks finished in 30 days ran without a card from you (4)');
    await expect(ex.locator('tr', { hasText: 'Creditor Management' })).toContainText('(2 Level A)');
    // 2. Quality: 8 decisions, 1 relevance failure = 88% worth his time.
    const q = zone.locator('[data-f15="quality"]');
    await expect(q).toContainText('88%');
    await expect(q).toContainText('1 of 8 were noise');
    // 3. Learning loop: one lesson written this week, one rejection reason.
    const l = zone.locator('[data-f15="learning"]');
    await expect(l).toContainText('1');
    await expect(l).toContainText('Already done elsewhere 1');
    // 4. Levels: the table names every category with its level; nothing is a candidate on 5 decisions.
    const lv = zone.locator('[data-f15="levels"]');
    await expect(lv).toContainText('close: duplicate');
    await expect(lv).toContainText('A — runs without you');
    await expect(lv).toContainText('C — yours only');
    await expect(lv.locator('[data-f15-candidates]')).toHaveCount(0);
    await expect(lv.locator('.f15-big')).toHaveText('0');
    await expect(lv).toContainText('categories ready to move');
    // 5. Health.
    const h = zone.locator('[data-f15="health"]');
    await expect(h).toContainText('Handled without you: 2 this week, 1 reversed');
    await expect(h).toContainText('Queue now: 3');
  });
  test('a broken 30-day read shows an error, never zeros', async ({ page }) => {
    const fx = withHandled();
    fx.taskHistory = [];
    await mockAgentsPage(page, fx);
    await loadAgentsPage(page);
    await expect(page.locator('[data-fifteen] .zone-error')).toContainText('none of these numbers can be trusted today');
    await expect(page.locator('#fifteenCount')).toHaveText('?');
  });
});
