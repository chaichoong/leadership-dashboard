// WHICH KIND OF NO, IN THE TASKS DRAWER (4 Sep 2026).
//
// The reason chips shipped on 27 Aug on the AI Agents gate. The Tasks drawer
// decides the SAME approvals on a different screen and never knew the Verdict
// Reason field existed, so every rejection taken here stored "no" with no kind
// of no attached. Read from Airtable, not from a log: recUE5JNhNW5rqSnF was
// rejected by Mica in this drawer on 1 Sep 2026 with Verdict Reason empty.
//
// Empty is indistinguishable from a field that was never written, so it counts
// against the agent that wrote the draft and the lesson writer has nothing to
// route — the learning loop stops compounding while the screen looks healthy.
//
// Airtable is mocked, so this asserts on the PATCH the drawer actually sends.

const { test, expect } = require('@playwright/test');
const { stubExternalHosts, localTodayISO } = require('./helpers');

const PAGE = '/os/tasks/index.html';
const TASKS_TABLE = 'tblqB8b22hKBL4PF1';
const ACTIVITY_TABLE = 'tbl2ZTHBDBPo681UL';
const F = {
  name: 'fldgFjGBw6bTKJFCD',
  dueDate: 'fld7XP8w8kbxfETV4',
  status: 'fldx4qCw17UfrKpaN',
  agentOutput: 'fldzswp8fx6PqpLQ5',
  sentForApprovalBy: 'fld30Yw8SWYVp049g',
  approvalOutcome: 'fldrHBSr6qoUfaKuZ',
  verdictReason: 'fldF9Bs4N5mttQvtl',
  approvalFeedback: 'fldtI7SJI4gEohHD1',
};
const TASK_ID = 'recDrawerApproval1';

/** @returns {Array} the PATCH bodies the drawer sent, in order. */
async function mockAirtable(page) {
  const patches = [];
  await stubExternalHosts(page);
  await page.route('**/api.airtable.com/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/comments')) {
      if (method === 'POST') return json({ id: 'comMock1', text: '', createdTime: new Date().toISOString() });
      return json({ comments: [] });
    }
    if (url.includes(ACTIVITY_TABLE)) return json({ records: [] });
    if (url.includes(TASKS_TABLE)) {
      if (method === 'PATCH') {
        patches.push(JSON.parse(route.request().postData() || '{}'));
        return json({ id: TASK_ID, fields: {} });
      }
      return json({ records: [{ id: TASK_ID, createdTime: new Date().toISOString(), fields: {
        [F.name]: 'INBOUND: Incoming SMS from a tenant',
        [F.status]: 'Approval',
        [F.dueDate]: localTodayISO(),
        [F.agentOutput]: 'Draft reply: thanks, I will look into it today.',
      } }] });
    }
    return json({ records: [] });
  });
  await page.addInitScript(() => {
    localStorage.setItem('_dlr_pat', 'pat_test_mock_token_for_playwright');
    localStorage.setItem('_task_user', JSON.stringify({ key: 'kevin', name: 'Kevin Brittain', email: 'kevinbrittain@gmail.com' }));
  });
  return patches;
}

async function openApprovalDrawer(page) {
  await page.goto(PAGE);
  await page.waitForFunction((id) => typeof allTasks !== 'undefined' && allTasks.some((t) => t.id === id), TASK_ID, { timeout: 20000 });
  await page.evaluate((id) => openTaskDrawer(id), TASK_ID);
  await expect(page.locator('.approval-box')).toBeVisible();
}

test.describe('the tasks drawer records WHY', () => {
  test('the same seven reasons are offered here as on the gate', async ({ page }) => {
    await mockAirtable(page);
    await openApprovalDrawer(page);
    const box = page.locator('.approval-box');
    for (const label of ['Already done', 'Roy owns it', 'Not worth my time',
                         'Duplicate', 'Parked', 'No longer relevant', 'The work is wrong']) {
      await expect(box.locator('.apv-reason', { hasText: label }).first(),
        `chip missing: ${label}`).toBeVisible();
    }
  });

  test('one tap writes the verdict, the reason and the sentence', async ({ page }) => {
    const patches = await mockAirtable(page);
    await openApprovalDrawer(page);
    await page.locator('.approval-box .apv-reason', { hasText: 'Roy owns it' }).first().click();
    await expect.poll(() => patches.length).toBeGreaterThan(0);

    const fields = patches[0].fields;
    expect(fields[F.approvalOutcome]).toBe('Rejected');
    // THE load-bearing assertion. This is the field recUE5JNhNW5rqSnF lost.
    expect(fields[F.verdictReason]).toBe('Roy owns it');
    expect(String(fields[F.approvalFeedback])).toContain('Roy is dealing with this');
  });

  test('a chip does NOT overwrite words already typed', async ({ page }) => {
    const patches = await mockAirtable(page);
    await openApprovalDrawer(page);
    const mine = 'Roy owns 1406 Oldham Road specifically, not the whole portfolio.';
    await page.locator('#apvNote').fill(mine);
    await page.locator('.approval-box .apv-reason', { hasText: 'Roy owns it' }).first().click();
    await expect.poll(() => patches.length).toBeGreaterThan(0);

    expect(patches[0].fields[F.verdictReason]).toBe('Roy owns it');
    expect(String(patches[0].fields[F.approvalFeedback])).toBe(mine);
  });

  test('rejecting in his own words records Something else, never a blank', async ({ page }) => {
    const patches = await mockAirtable(page);
    await openApprovalDrawer(page);
    const his = 'This has been manually actioned.';
    await page.locator('#apvNote').fill(his);
    await page.locator('.approval-box .apv-actions button.btn-danger').click();
    await expect.poll(() => patches.length).toBeGreaterThan(0);

    const fields = patches[0].fields;
    expect(fields[F.approvalOutcome]).toBe('Rejected');
    expect(fields[F.verdictReason]).toBe('Something else');
    expect(String(fields[F.approvalFeedback])).toBe(his);
  });
});
