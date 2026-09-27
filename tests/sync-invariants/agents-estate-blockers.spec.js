// Estate status tab: the "Robots blocked" block (the blocker loop, 25 Sep 2026).
//
// Kevin's 08:00 message links here for "each one and what clears it". The tab
// used to render only job rows plus two named reports, so the new report row
// was written to Airtable and shown nowhere. Invariants:
//   1. A row with open walls shows its Detail and lists each task, its kind and
//      what clears it.
//   2. A red row (a wall three days old, or a task closed while blocked) is red.
//   3. "No robot is blocked." renders nothing, so a quiet day is quiet.
// Airtable is mocked (agents-page.helpers.js), so this runs with no PAT.

const { test, expect } = require('@playwright/test');
const { mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

const ES = {
  key: 'fldLO6xJqkokvVR4g', kind: 'fldfjQOn76VpgKEfZ', label: 'fldlnvvTh8l5UIih4', status: 'fldhOUiva3bqPNk1c',
  lastRun: 'flduxV3TYwp9wQX9O', detail: 'fldLRFP2nJttDVQOa', payload: 'fldiqs9lvyLimoR7i', updated: 'fld3q8WN5XqrER92Z',
};
const now = () => new Date().toISOString();
const row = (id, f) => ({ id, fields: Object.fromEntries(Object.entries(f).map(([k, v]) => [ES[k], v])) });
const job = row('recJob', { key: 'handback-poll', kind: 'job', label: 'Hand-back poll', status: 'Worked', lastRun: now(), updated: now(), detail: 'ok' });
const walls = [
  { task: 'recA', name: 'INSURANCE: 6 Chedburgh Place <b>', kind: 'SITE', subject: 'namecheap.com', fix: 'Kevin adds namecheap.com to the robot\'s list with "Add a new site" in the Robot sign-in app.', days: 1.5 },
  { task: 'recB', name: 'Pay Athertons invoice', kind: 'KEVIN', subject: 'payment', fix: 'Kevin does the payment step; the task stays open until the agent sees proof it happened.', days: 0.2 },
];
const blockers = (status, detail, open) => row('recBlk', {
  key: 'agent-blockers', kind: 'report', label: 'Robots blocked', status, lastRun: now(), updated: now(), detail,
  payload: JSON.stringify({ open, stale: 0, closedWhileBlocked: [], woken: 0 }),
});

test.describe('Estate status: Robots blocked', () => {
  test('lists each blocked task and what clears it, escaped', async ({ page }) => {
    await mockAgentsPage(page, { estate: [job, blockers('Worked', "Robots blocked on 2 tasks. For you: add namecheap.com to the robot's list (Add a new site).", walls)] });
    await loadAgentsPage(page, 'tab=estate');
    const box = page.locator('#estateBlockers');
    await expect(box).toBeVisible();
    await expect(box).toContainText("Robots blocked. Robots blocked on 2 tasks. For you: add namecheap.com to the robot's list");
    await expect(box).not.toHaveClass(/zone-error/);
    await box.locator('summary').click();
    await expect(box).toContainText('Each one and what clears it (2)');
    await expect(box).toContainText('INSURANCE: 6 Chedburgh Place <b>');   // shown as text, not markup
    await expect(box).toContainText('SITE namecheap.com · 1.5 days');
    await expect(box).toContainText('Kevin does the payment step');
  });

  test('a red row is red', async ({ page }) => {
    await mockAgentsPage(page, { estate: [job, blockers('Failed', 'Robots blocked on 1 task. 1 task blocked 3 days or more.', walls.slice(0, 1))] });
    await loadAgentsPage(page, 'tab=estate');
    await expect(page.locator('#estateBlockers')).toHaveClass(/zone-error/);
  });

  test('nothing blocked shows nothing', async ({ page }) => {
    await mockAgentsPage(page, { estate: [job, blockers('Worked', 'No robot is blocked.', [])] });
    await loadAgentsPage(page, 'tab=estate');
    await expect(page.locator('#estateJobsBody')).toContainText('Hand-back poll');
    await expect(page.locator('#estateBlockers')).toHaveCount(0);
  });
});
