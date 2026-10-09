// Estate status tab: a "Missed" row (Kevin approved 2 Oct 2026, task recJfXJeMwZPENonk).
//
// scripts/estate-status.py marks a job Missed when its slot passed with no record of
// any kind while other jobs ran. Before this, a job that went silent kept its last
// status and drifted to Idle, which nothing counted. Invariants:
//   1. A Missed row sorts to the top with the failures, in the danger colour.
//   2. It counts toward the tab badge and the "need attention" line.
//   3. Control: the same board with that row Worked counts nothing.
// Airtable is mocked (agents-page.helpers.js), so this runs with no PAT.

const { test, expect } = require('@playwright/test');
const { mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

const ES = {
  key: 'fldLO6xJqkokvVR4g', kind: 'fldfjQOn76VpgKEfZ', label: 'fldlnvvTh8l5UIih4', status: 'fldhOUiva3bqPNk1c',
  lastRun: 'flduxV3TYwp9wQX9O', detail: 'fldLRFP2nJttDVQOa', updated: 'fld3q8WN5XqrER92Z',
};
const now = () => new Date().toISOString();
const row = (id, f) => ({ id, fields: Object.fromEntries(Object.entries(f).map(([k, v]) => [ES[k], v])) });
const worked = row('recA', { key: 'alpha-job', kind: 'job', label: 'Alpha job', status: 'Worked', lastRun: now(), updated: now(), detail: 'Ran at its slot and finished cleanly.' });
const night = (status, detail) => row('recZ', { key: 'zulu-publish', kind: 'job', label: 'Zulu publish', status, lastRun: now(), updated: now(), detail });

test.describe('Estate status: a Missed row', () => {
  test('is red, sorts first and counts toward the badge', async ({ page }) => {
    await mockAgentsPage(page, { estate: [worked, night('Missed', 'Due at Thu 08 Oct 23:20 London and nothing was recorded for it.')] });
    await loadAgentsPage(page, 'tab=estate');
    const rows = page.locator('#estateJobsBody tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Zulu publish');   // sorted above the Worked row despite its name
    const pill = rows.first().locator('.agent-pill');
    await expect(pill).toHaveText('Missed');
    const [bg, danger] = await pill.evaluate((el) => [getComputedStyle(el).backgroundColor,
      getComputedStyle(document.documentElement).getPropertyValue('--danger-bg').trim()]);
    expect(danger, 'control: the danger token exists').not.toBe('');
    const probe = await page.evaluate((v) => { const d = document.createElement('div'); d.style.background = v;
      document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; }, danger);
    expect(bg).toBe(probe);
    await expect(page.locator('#estateTabBadge')).toHaveText('1');
    await expect(page.locator('#estateJobsSub')).toContainText('1 need attention');
  });

  test('control: the same board with that job Worked needs no attention', async ({ page }) => {
    await mockAgentsPage(page, { estate: [worked, night('Worked', 'Ran at its slot and finished cleanly.')] });
    await loadAgentsPage(page, 'tab=estate');
    await expect(page.locator('#estateJobsBody tbody tr')).toHaveCount(2);
    await expect(page.locator('#estateTabBadge')).toBeHidden();
    await expect(page.locator('#estateJobsSub')).toContainText('All working');
  });
});
