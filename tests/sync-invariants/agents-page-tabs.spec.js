// AI Agents page tabs — Dashboard | Approvals | CEO Brief (25 Aug 2026).
//
// Kevin's restructure: one long page became three tabs. The invariants:
//   1. The page boots on the Dashboard with one scorecard per role agent.
//   2. The Approvals tab groups the queue by agent and the filter chips
//      actually filter — approving from a filtered view must still work.
//   3. The Duplicates check lane collides two open tasks that are the same
//      job with different reference numbers (one subject = one open task).
//   4. #tab= deep links open the right tab (the shell forwards old
//      #ceo-brief bookmarks here the same way).
//
// Airtable is mocked (agents-page.helpers.js), so this runs with no PAT.

const { test, expect } = require('@playwright/test');
const { TF, AGENT_A, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');
const { loadDashboardWithFixtures } = require('./helpers');

test.describe('AI Agents page tabs', () => {
  test('boots on the Dashboard: CEO brief on top, a scorecard per agent, no checks', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);

    await expect(page.locator('#view-dashboard')).toBeVisible();
    await expect(page.locator('#view-approvals')).toBeHidden();
    await expect(page.locator('#view-checks')).toBeHidden();

    // The CEO brief lives ON the dashboard (Kevin's ruling, 25 Aug 2026)…
    await expect(page.locator('#zoneCeoBrief')).toBeVisible();
    await expect(page.locator('#zoneCeoBrief')).toContainText('Test the onboarding flow end to end');
    // …and the checks do NOT — they have their own tab with a live count.
    await expect(page.locator('#view-dashboard #checksBody')).toHaveCount(0);
    await expect(page.locator('#checksTabBadge')).toHaveText('2');

    // One scorecard per register row, with the stats Kevin manages by.
    await expect(page.locator('.sc-card')).toHaveCount(2);
    const creditor = page.locator('.sc-card', { hasText: 'Creditor Management' });
    await expect(creditor).toContainText('Guardrails');
    await expect(creditor).toContainText('Approval required');
    await expect(creditor).toContainText('Correspondence 100% (1)'); // accuracy by kind of work
    await expect(creditor).toContainText('2 to approve');            // waiting-on-Kevin count
    await expect(creditor).toContainText('Last fired');
    await expect(creditor).toContainText('(today)');                 // daily log row dated today

    // The approvals tab badge shows the waiting count from any tab.
    await expect(page.locator('#approvalsTabBadge')).toHaveText('3');
  });

  test('the approvals queue is most-important-first and the chips filter it', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);

    await page.locator('#ptab-approvals').click();
    await expect(page.locator('#view-approvals')).toBeVisible();
    await expect(page.locator('#view-dashboard')).toBeHidden();

    // Flat list in importance order: tier 1 leads regardless of priority,
    // then Urgent beats High, then longest waiting. No agent grouping — a
    // group heading would bury an urgent item under another agent's routine.
    await expect(page.locator('.apv-card')).toHaveCount(3);
    await expect(page.locator('.apv-card').nth(0)).toContainText('TIER 1');
    await expect(page.locator('.apv-card').nth(1)).toContainText('Reply to tenant email');
    await expect(page.locator('.apv-card').nth(1)).toContainText('Urgent');
    await expect(page.locator('.apv-card').nth(2)).toContainText('Payment plan proposal');
    await expect(page.locator('.apv-group-head')).toHaveCount(0);

    // Chips carry counts; clicking one narrows the list.
    await expect(page.locator('.apv-filter', { hasText: 'All (3)' })).toHaveCount(1);
    await page.locator('.apv-filter', { hasText: 'Creditor Management (2)' }).click();
    await expect(page.locator('.apv-card')).toHaveCount(2);
    await expect(page.locator('.apv-card', { hasText: 'Reply to tenant email' })).toHaveCount(0);

    // Back to All restores the full queue.
    await page.locator('.apv-filter', { hasText: 'All (3)' }).click();
    await expect(page.locator('.apv-card')).toHaveCount(3);

    // The close button says what it does (Kevin's wording, 25 Aug 2026).
    await expect(page.locator('.apv-card').first().locator('button', { hasText: 'Reject and Close' })).toHaveCount(1);
  });

  test('an approval links to its email only when there is one a browser can open', async ({ page }) => {
    // Inbound Note URL Link holds three shapes on the live queue: a Gmail
    // thread URL, an imessage:<guid> key, and nothing. Only the first is
    // openable — a link built from the other two would be broken or unsafe.
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await page.locator('#ptab-approvals').click();

    const gmail = page.locator('.apv-card', { hasText: 'Reply to Anglian Water' }).locator('a.apv-email');
    await expect(gmail).toHaveCount(1);
    await expect(gmail).toHaveAttribute('href', 'https://mail.google.com/mail/u/0/#all/19f3c5386a9f5910');
    await expect(gmail).toHaveAttribute('target', '_blank');
    await expect(gmail).toHaveAttribute('rel', /noopener/);

    // A folded duplicate carries two threads: both are offered, numbered.
    const folded = page.locator('.apv-card', { hasText: 'Payment plan proposal' }).locator('a.apv-email');
    await expect(folded).toHaveCount(2);
    await expect(folded.first()).toContainText('Open email 1');

    // iMessage key: no link at all, rather than an unopenable one.
    await expect(page.locator('.apv-card', { hasText: 'Reply to tenant email' })
      .locator('a.apv-email')).toHaveCount(0);

    // THE GUARD: the field is external data going into an href. esc() stops
    // quote-breaking but would happily render a javascript: URL, so the
    // extractor keeps http(s) only — asserted through the real function.
    const kept = await page.evaluate(() => apvEmailLinks(
      'javascript:alert(1) imessage:ABC https://mail.google.com/mail/u/0/#all/abc https://mail.google.com/mail/u/0/#all/abc'));
    expect(kept).toEqual(['https://mail.google.com/mail/u/0/#all/abc']);
  });

  test('the tier-1 filter narrows the queue, and Clear filters puts it all back', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await page.locator('#ptab-approvals').click();

    // No filter active: no clear button to offer.
    await expect(page.locator('.apv-filter-clear')).toHaveCount(0);
    await expect(page.locator('.apv-card')).toHaveCount(3);

    // One of the three fixtures carries the tier-1 banner.
    await page.locator('.apv-filter-tier1').click();
    await expect(page.locator('.apv-filter-tier1')).toHaveText('Tier 1 (1)');
    await expect(page.locator('.apv-card')).toHaveCount(1);
    await expect(page.locator('.apv-card').first()).toContainText('TIER 1');
    await expect(page.locator('.apv-filter-clear')).toHaveCount(1);

    // Agent chips re-count inside the tier-1 subset, so a chip never
    // promises rows the click cannot deliver.
    await expect(page.locator('.apv-filter', { hasText: 'Inbound Comms Response' })).toContainText('(0)');

    // Both filters AND: an agent with no tier-1 work now yields nothing,
    // which one filter alone never could — say so, with the way out.
    await page.locator('.apv-filter', { hasText: 'Inbound Comms Response' }).click();
    await expect(page.locator('.apv-card')).toHaveCount(0);
    await expect(page.locator('#view-approvals .empty-state')).toContainText('No approvals match these filters');

    await page.locator('#view-approvals .empty-state button').click();
    await expect(page.locator('.apv-card')).toHaveCount(3);
    await expect(page.locator('.apv-filter-clear')).toHaveCount(0);
    await expect(page.locator('.apv-filter-tier1')).not.toHaveClass(/active/);

    // "All" reads as "show me everything", so it clears BOTH filters and
    // always counts the whole queue. It used to clear only the agent filter,
    // stay lit while tier-1 was on, and be a dead click.
    await page.locator('.apv-filter-tier1').click();
    await expect(page.locator('.apv-card')).toHaveCount(1);
    const all = page.locator('.apv-filter', { hasText: 'All (3)' });
    await expect(all).not.toHaveClass(/active/);
    await all.click();
    await expect(page.locator('.apv-card')).toHaveCount(3);
    await expect(page.locator('.apv-filter-tier1')).not.toHaveClass(/active/);
  });

  test('a scorecard jump shows that agent\'s whole queue, even with tier 1 left on', async ({ page }) => {
    // The scorecard's "N to approve" counts ALL of that agent's approvals, so
    // landing the click on a tier-1-filtered view could deliver an empty list
    // against a promised count.
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await page.locator('#ptab-approvals').click();
    await page.locator('.apv-filter-tier1').click();
    await expect(page.locator('.apv-card')).toHaveCount(1);

    await page.locator('#ptab-dashboard').click();
    const card = page.locator('.sc-card', { hasText: 'Inbound Comms Response' });
    await expect(card).toContainText('1 to approve');
    await card.locator('.sc-wait-link').click();

    await expect(page.locator('#view-approvals')).toBeVisible();
    await expect(page.locator('.apv-card')).toHaveCount(1);
    await expect(page.locator('.apv-card').first()).toContainText('Reply to tenant email');
    await expect(page.locator('.apv-filter-tier1')).not.toHaveClass(/active/);
  });

  test('tier 1 is judged the same way here as by the dispatcher and Slack', async ({ page }) => {
    // agent-dispatch.py (`TIER1_BANNER not in output`) and the Slack worker
    // (`.includes`) match the banner ANYWHERE. This page matched only at the
    // start, so a Correspondence output carrying TO:/SUBJECT: headers above
    // the banner was tier 1 to the router and to Slack, but invisible to this
    // page's red banner and its Tier 1 filter.
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    const verdicts = await page.evaluate(() => ({
      atStart: isTier1Output(TIER1_BANNER + '\n\nBody'),
      afterHeaders: isTier1Output('TO: a@b.com\nSUBJECT: x\n\n' + TIER1_BANNER + '\n\nBody'),
      plain: isTier1Output('An ordinary draft with no banner.'),
      empty: isTier1Output(''),
    }));
    expect(verdicts).toEqual({ atStart: true, afterHeaders: true, plain: false, empty: false });
  });

  test('a scorecard’s waiting count jumps to the approvals tab pre-filtered', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);

    await page.locator('.sc-card', { hasText: 'Creditor Management' }).locator('.sc-wait-link').click();
    await expect(page.locator('#view-approvals')).toBeVisible();
    await expect(page.locator('.apv-card')).toHaveCount(2);
    await expect(page.locator('.apv-filter.active', { hasText: 'Creditor Management' })).toHaveCount(1);
  });

  test('the Duplicates lane collides same-job open tasks despite different reference numbers', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);

    await page.locator('#ptab-checks').click();
    await expect(page.locator('#view-checks')).toBeVisible();
    const checks = page.locator('#checksBody');
    await expect(checks).toContainText('Duplicates');
    await expect(checks).toContainText('2 open tasks that look like the same job');
    await expect(checks).toContainText('Chase Acme invoice');
    await expect(checks).toContainText('One subject = one open task');
  });

  test('a jammed inbound approval rings ONE alarm, and never-logged agents get one line, not one a day', async ({ page }) => {
    // 25 Aug 2026: 70 of 91 inbound alarms were the same tasks already
    // ringing as late approvals, and four agents were flagged "silent today"
    // that had never logged in their lives. Both inflations train Kevin to
    // ignore the tab, which is how a real alarm gets missed.
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    const fx = defaultFixtures();
    // The same task is BOTH a late approval and an overdue inbound item…
    fx.approvals.push({ id: 'recJammed', createdTime: twoDaysAgo, fields: {
      [TF.name]: 'INBOUND: chase the jammed reply', [TF.status]: 'Approval',
      [TF.agentOutput]: 'Draft: reply text.', [TF.priority]: 'High',
      [TF.sentForApprovalBy]: [AGENT_A], [TF.teamMember]: [AGENT_A],
      [TF.lmt]: twoDaysAgo, [TF.taskType]: 'Correspondence',
    } });
    fx.openTasks.push({ id: 'recJammed', createdTime: twoDaysAgo, fields: {
      [TF.name]: 'INBOUND: chase the jammed reply', [TF.status]: 'Approval',
      [TF.teamMember]: [AGENT_A], [TF.lmt]: twoDaysAgo, [TF.inboundTask]: true,
    } });
    // …while a genuinely adrift inbound task (not in the queue) must still ring.
    fx.openTasks.push({ id: 'recAdrift', createdTime: twoDaysAgo, fields: {
      [TF.name]: 'INBOUND: adrift with nobody queued', [TF.status]: 'Upcoming',
      [TF.teamMember]: [AGENT_A], [TF.lmt]: twoDaysAgo, [TF.inboundTask]: true,
    } });
    await mockAgentsPage(page, { approvals: fx.approvals, openTasks: fx.openTasks });
    await loadAgentsPage(page);
    await page.locator('#ptab-checks').click();

    const checks = page.locator('#checksBody');
    await expect(checks.locator('.chk-item', { hasText: 'chase the jammed reply' })).toHaveCount(1);
    await expect(checks.locator('.chk-item', { hasText: 'chase the jammed reply' })).toContainText('should have been decided');
    await expect(checks.locator('.chk-item', { hasText: 'adrift with nobody queued' })).toHaveCount(1);
    // Never-logged agents are one wiring line, not a daily per-agent alarm.
    await expect(checks).toContainText('have never written a daily log: Inbound Comms Response');
    await expect(checks).not.toContainText('usually writes a daily log');

    // Age dividers (Kevin's ask, 26 Aug 2026): items group under date bands,
    // oldest first, so a shrinking top band shows the backlog clearing.
    // The two 2-day-old fixtures band together; today's duplicate pair bands
    // as new; the wiring line sits under Standing, outside the daily flow.
    // Assert the COUNT badge itself — the label '2 to 7 days old' contains
    // a '2' of its own, so a bare toContainText('2') passes vacuously.
    await expect(checks.locator('.chk-divider', { hasText: '2 to 7 days old' }).locator('.zone-count')).toHaveText('2');
    await expect(checks.locator('.chk-divider', { hasText: 'New today' })).toHaveCount(1);
    await expect(checks.locator('.chk-divider', { hasText: 'Standing' })).toHaveCount(1);
    const bandOrder = await checks.locator('.chk-divider').allTextContents();
    expect(bandOrder.findIndex(t => t.includes('2 to 7 days')))
      .toBeLessThan(bandOrder.findIndex(t => t.includes('New today')));
  });

  test('#tab= deep links open the requested tab on load', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page, 'tab=approvals');
    await expect(page.locator('#view-approvals')).toBeVisible();
    await expect(page.locator('#view-dashboard')).toBeHidden();
  });

  test('the retired #tab=ceo-brief deep link lands on the Dashboard, never a blank view', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page, 'tab=ceo-brief');
    await expect(page.locator('#view-dashboard')).toBeVisible();
    await expect(page.locator('#zoneCeoBrief')).toContainText('CEO Brief');
  });

  test('the shell forwards old #ceo-brief links to the brief tab on this page', async ({ page }) => {
    // The CEO Brief left the sidebar on 25 Aug 2026. Old bookmarks, the
    // workflow page's back link and muscle memory all still say #ceo-brief —
    // switchTab must forward them to the agents page with the brief tab open,
    // never blank the content area on a tab that no longer exists.
    await loadDashboardWithFixtures(page, { ceoBriefs: [] }, 'ceo-brief');

    await expect(page.locator('.sidebar-item', { hasText: 'CEO Brief' })).toHaveCount(0);
    await expect(page.locator('#tab-agents')).toHaveClass(/active/);
    const inner = page.frameLocator('#agentsFrame');
    // The brief lives on the Dashboard now; the old link must land there.
    await expect(inner.locator('#view-dashboard')).toBeVisible({ timeout: 20000 });
    await expect(inner.locator('#zoneCeoBrief')).toBeVisible();
  });

  test('approving from a filtered view still patches the task and updates the counts', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);

    await page.locator('#ptab-approvals').click();
    await page.locator('.apv-filter', { hasText: 'Inbound Comms Response (1)' }).click();
    await expect(page.locator('.apv-card')).toHaveCount(1);

    await page.locator('.apv-card button', { hasText: /^Approve$/ }).click();
    // The decided card leaves; its agent's group is now empty so the filter
    // resets to All and the remaining two (other-agent) cards show.
    await expect(page.locator('.apv-card')).toHaveCount(2, { timeout: 10000 });
    await expect(page.locator('.apv-card', { hasText: 'Reply to tenant email' })).toHaveCount(0);

    const patch = patches.find((p) => p.id === 'recApvB1');
    expect(patch, 'approving must PATCH the task').toBeTruthy();
    // The queue count and the badge drop to the remaining two.
    await expect(page.locator('#approvalsTabBadge')).toHaveText('2');
    await expect(page.locator('.apv-filter', { hasText: 'All (2)' })).toHaveCount(1);
  });
});
