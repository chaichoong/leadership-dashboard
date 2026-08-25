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
const { mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');
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
