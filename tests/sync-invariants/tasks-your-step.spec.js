// YOUR STEP in the Tasks drawer (review, 7 Oct 2026; PR 2 of 5). The AI Agents queue already
// refuses a verdict on an approved card the robots put back for Kevin's own step. The Tasks drawer
// showed Approve and Reject on the same card: Approve re-dispatched the agent to the same wall,
// Reject closed it unfinished. Invariants:
//   1. A Your step card in the drawer shows the step as text and NO verdict button.
//   2. apvDecide refuses it even when called directly, and writes nothing.
//   3. An ordinary approval card still has its buttons (the change is scoped).
// Airtable is mocked, so this runs with no PAT. Names are invented (the repo is public).
const { test, expect } = require('@playwright/test');
const { stubExternalHosts, localTodayISO } = require('./helpers');

const PAGE = '/os/tasks/index.html';
const TASKS_TABLE = 'tblqB8b22hKBL4PF1';
const F = {
  name: 'fldgFjGBw6bTKJFCD', dueDate: 'fld7XP8w8kbxfETV4', status: 'fldx4qCw17UfrKpaN',
  agentOutput: 'fldzswp8fx6PqpLQ5', approvalOutcome: 'fldrHBSr6qoUfaKuZ',
};
const STEP_ID = 'recYourStepTasksA';
const PLAIN_ID = 'recPlainApprovalA';
const DIVIDER = "----- The agent's work, as you approved it -----";

function taskRecords() {
  const now = new Date().toISOString();
  return { records: [
    { id: STEP_ID, createdTime: now, fields: {
      [F.name]: 'Pay the Example Water bill', [F.status]: 'Approval', [F.dueDate]: localTodayISO(),
      [F.approvalOutcome]: 'Approved as-is',
      [F.agentOutput]: `YOUR STEP: 1. Pay <b>by transfer</b>.\n2. Reply to the email.\n\n${DIVIDER}\n\nInvoice checked: 42.10.`,
    } },
    { id: PLAIN_ID, createdTime: now, fields: {
      [F.name]: 'Reply to the Example Lane tenant', [F.status]: 'Approval', [F.dueDate]: localTodayISO(),
      [F.agentOutput]: 'Draft: thanks, we will confirm.',
    } },
  ] };
}

async function mockAirtable(page) {
  const patches = [];
  await stubExternalHosts(page);
  await page.route('**/api.airtable.com/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/comments')) return json(method === 'POST' ? { id: 'c1', text: '', createdTime: new Date().toISOString() } : { comments: [] });
    if (method === 'PATCH') {
      patches.push({ url, body: route.request().postData() });
      return json({ id: url.split('/').pop().split('?')[0], fields: {} });
    }
    if (url.includes(TASKS_TABLE)) return json(taskRecords());
    return json({ records: [] });
  });
  await page.addInitScript(() => {
    localStorage.setItem('_dlr_pat', 'pat_test_mock_token_for_playwright');
    localStorage.setItem('_task_user', JSON.stringify({ key: 'kevin', name: 'Kevin Brittain', email: 'kevinbrittain@gmail.com' }));
  });
  return patches;
}

async function waitForTasks(page) {
  await page.waitForFunction((ids) => typeof allTasks !== 'undefined' && ids.every((id) => allTasks.some((t) => t.id === id)),
    [STEP_ID, PLAIN_ID], { timeout: 20000 });
}

test.describe('Tasks drawer: Your step', () => {
  test('shows the step as text and no verdict buttons; an ordinary card keeps them', async ({ page }) => {
    await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTasks(page);
    const html = await page.evaluate(([a, b]) => [renderApprovalBlock(findTaskAnywhere(a)), renderApprovalBlock(findTaskAnywhere(b))], [STEP_ID, PLAIN_ID]);
    expect(html[0]).toContain('data-your-step');
    expect(html[0]).toContain('1. Pay &lt;b&gt;by transfer&lt;/b&gt;.');   // escaped
    expect(html[0]).not.toContain('apvDecide(');
    expect(html[0]).not.toContain('apvRejectWithReason(');
    expect(html[0]).toContain('Invoice checked: 42.10.');
    expect(html[1]).toContain("apvDecide('" + PLAIN_ID + "','Approved as-is')");
  });

  test('apvDecide refuses a Your step card even when called directly, and writes nothing', async ({ page }) => {
    const patches = await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTasks(page);
    await page.evaluate((id) => apvDecide(id, 'Approved as-is', false), STEP_ID);   // needs no note, so only the guard stops it
    await page.waitForTimeout(300);
    expect(patches.filter((p) => p.url.includes(STEP_ID))).toHaveLength(0);
  });
});
