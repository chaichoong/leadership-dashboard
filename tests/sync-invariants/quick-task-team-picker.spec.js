// The quick-task panel never offers someone who has left, and still names them
// on a task they hold.
//
// Ericamae left on 17 Sep 2026 (Team Members recEvm9wgsEnoNVZh: Active=false,
// Status=Offboarded). TASK_TEAM in js/config.js does two jobs for the panel in
// js/shared.js openQuickTaskModal: it builds the Assignee picker, and it is read
// back by key or email to show who holds a task opened for editing. Deleting her
// from the list would fix the first and break the second: an old task of hers
// would open with the assignee blank, and a save could then drop the assignment.
// So she stays in the list marked `left`, and the picker filters on it.
//
// Airtable is mocked (fixture test): this covers the render and the lookup.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures } = require('./helpers');

const LEFT = { key: 'erica', name: 'Ericamae Atenta', email: 'atentaerica@gmail.com' };

async function pickerOptions(page) {
  return page.$$eval('#qtAssignee option', opts => opts.map(o => ({ value: o.value, text: o.textContent.trim(), selected: o.selected })));
}

test.describe('Quick-task assignee picker and people who have left', () => {
  test.beforeEach(async ({ page }) => {
    await loadDashboardWithFixtures(page, {});
    await page.waitForFunction(() => typeof window.openQuickTaskModal === 'function', { timeout: 15000 });
  });

  test('CONTROL: she is still in TASK_TEAM, marked as left', async ({ page }) => {
    // Without this, the tests below would pass just as well if she had been
    // deleted outright, which is the version that breaks old tasks.
    const member = await page.evaluate((key) => TASK_TEAM.find(m => m.key === key), LEFT.key);
    expect(member).toMatchObject({ name: LEFT.name, email: LEFT.email });
    expect(member.left).toBeTruthy();
  });

  test('a new task never offers her', async ({ page }) => {
    await page.evaluate(() => window.openQuickTaskModal({}));
    const opts = await pickerOptions(page);
    expect(opts.length, 'the picker rendered no team at all').toBeGreaterThan(3);
    expect(opts.map(o => o.value)).toContain('roy');
    expect(opts.map(o => o.value)).not.toContain(LEFT.key);
    expect(opts.map(o => o.text).join('|')).not.toContain(LEFT.name);
  });

  test('a task she already holds still shows her name, selected', async ({ page }) => {
    const assigneeField = await page.evaluate(() => TASK_FIELDS.assignee);
    const nameField = await page.evaluate(() => TASK_FIELDS.name);
    await page.evaluate(({ assigneeField, nameField, email }) => window.openQuickTaskModal({
      task: { id: 'recOldTask0000001', fields: { [nameField]: 'An old task', [assigneeField]: { email } } },
    }), { assigneeField, nameField, email: LEFT.email });
    const opts = await pickerOptions(page);
    const hers = opts.find(o => o.value === LEFT.key);
    expect(hers, 'an old task of hers lost its assignee').toBeTruthy();
    expect(hers.selected).toBe(true);
    expect(hers.text).toBe(`${LEFT.name} (left)`);
    expect(await page.inputValue('#qtAssignee')).toBe(LEFT.key);
  });

  test('a task held by a current member shows them and still hides her', async ({ page }) => {
    const assigneeField = await page.evaluate(() => TASK_FIELDS.assignee);
    await page.evaluate(({ assigneeField }) => window.openQuickTaskModal({
      task: { id: 'recRoyTask0000001', fields: { [assigneeField]: { email: 'roy.lavin1978@gmail.com' } } },
    }), { assigneeField });
    expect(await page.inputValue('#qtAssignee')).toBe('roy');
    const opts = await pickerOptions(page);
    expect(opts.map(o => o.value)).not.toContain(LEFT.key);
  });
});
