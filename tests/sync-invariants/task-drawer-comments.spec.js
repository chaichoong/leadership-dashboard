// Task drawer / drill-down comments — render invariants.
//
// Guards the swap made on 2026-07-30: comments render inline and expanded on
// every surface that opens a task, activity is collapsed behind a View toggle.
//
// The bug this exists to catch: loadCommentsIntoDrawer and friends used to gate
// on `drawerTaskId===taskId`, but openTaskDrawer calls closeDrawer(), which
// nulls drawerTaskId — so the gate was always false and an inline list would
// have stayed blank forever. The gate is now the wrap element plus its
// data-task-id. If someone reintroduces a drawerTaskId gate, these fail.
//
// Airtable is mocked (page.route on api.airtable.com) so this runs without a PAT, and
// stubExternalHosts() blocks the public internet. Both matter: until 2026-08-04 this spec
// stubbed Airtable alone, so every run really fetched Google Fonts and the Apps Script
// endpoint, and under parallel load that pushed page init past waitForTask's 20s budget.
// The gate went red with a DIFFERENT test failing each run while all 5 passed in isolation.

const { test, expect } = require('@playwright/test');
const { stubExternalHosts } = require('./helpers');

const PAGE = '/os/tasks/index.html';
const TASKS_TABLE = 'tblqB8b22hKBL4PF1';
const ACTIVITY_TABLE = 'tbl2ZTHBDBPo681UL';
const F = {
  name: 'fldgFjGBw6bTKJFCD',
  dueDate: 'fld7XP8w8kbxfETV4',
  status: 'fldx4qCw17UfrKpaN',
};
const TASK_ID = 'recTaskMock1';

function taskRecords() {
  return { records: [{ id: TASK_ID, createdTime: new Date().toISOString(), fields: {
    [F.name]: 'Mock drawer task',
    [F.status]: 'In Progress',
    [F.dueDate]: new Date().toISOString().slice(0, 10),
  } }] };
}

function activityRecords() {
  const now = new Date().toISOString();
  return { records: [
    { id: 'recAct1', createdTime: now, fields: { Actor: 'Kevin Brittain', 'Actor Email': 'kevinbrittain@gmail.com', Field: 'Status', Summary: 'Status changed to In Progress', Source: 'app', At: now } },
    { id: 'recAct2', createdTime: now, fields: { Actor: 'Automation', Field: 'Created', Summary: 'Task created', Source: 'automation', At: new Date(Date.now() - 7200e3).toISOString() } },
  ] };
}

// Comments carry the app's embedded-author prefix, so a renderer that forgets
// to parse it leaks "[author:...]" into the visible text.
const SEEDED_COMMENT = {
  id: 'comSeed1',
  text: '[author:Mica|mica@example.com]\nSeeded comment from the mock API.',
  createdTime: new Date(Date.now() - 3600e3).toISOString(),
  author: { name: 'Mica', email: 'mica@example.com' },
};

// opts.commentsGetFails — a predicate read on every comments GET, so a test can flip the
// endpoint from failing to healthy mid-run (the retry case) without registering a second,
// competing route for the same URL.
async function mockAirtable(page, opts = {}) {
  const posted = [];
  // Without this the page fetches Google Fonts and the Apps Script endpoint for real on
  // every run. See stubExternalHosts() in helpers.js for why that made this spec flaky.
  await stubExternalHosts(page);
  await page.route('**/api.airtable.com/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/comments')) {
      if (method === 'POST') {
        const body = JSON.parse(route.request().postData() || '{}');
        const c = { id: 'comMock' + (posted.length + 1), text: body.text, createdTime: new Date().toISOString(), author: { name: 'Kevin Brittain', email: 'kevinbrittain@gmail.com' } };
        posted.push(c);
        return json(c);
      }
      if (opts.commentsGetFails && opts.commentsGetFails()) return json({ error: 'forbidden' }, 403);
      return json({ comments: [...posted].reverse().concat([SEEDED_COMMENT]) });
    }
    if (url.includes(ACTIVITY_TABLE)) return json(activityRecords());
    if (url.includes(TASKS_TABLE)) return method === 'GET' ? json(taskRecords()) : json({ id: TASK_ID, fields: {} });
    return json({ records: [] });
  });
  await page.addInitScript(() => {
    localStorage.setItem('_dlr_pat', 'pat_test_mock_token_for_playwright');
    localStorage.setItem('_task_user', JSON.stringify({ key: 'kevin', name: 'Kevin Brittain', email: 'kevinbrittain@gmail.com' }));
  });
}

// The page loads its data asynchronously; wait for the mock task to land in
// allTasks rather than guessing with a fixed timeout (flaky under parallel load).
async function waitForTask(page) {
  await page.waitForFunction((id) => typeof allTasks !== 'undefined' && allTasks.some(t => t.id === id), TASK_ID, { timeout: 20000 });
}

test.describe('Task drawer comments', () => {
  test('drawer opens with comments expanded and activity collapsed', async ({ page }) => {
    await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTask(page);
    await page.evaluate((id) => openTaskDrawer(id), TASK_ID);

    const wrap = page.locator('.drw-comments-wrap');
    await expect(wrap).toBeVisible();
    await expect(wrap).toContainText('Seeded comment from the mock API.');
    await expect(wrap).not.toContainText('[author:');
    await expect(wrap.locator('.drw-comment-input')).toBeVisible();
    await expect(page.locator(`#drwCommentCount-${TASK_ID}`)).toHaveText('1');

    const activity = page.locator(`#drwActivityWrap-${TASK_ID}`);
    await expect(activity).toBeHidden();
    // Rows still load while hidden, otherwise the count badge would lie.
    await expect(page.locator(`#drwActivityCount-${TASK_ID}`)).toHaveText('2');
  });

  test('activity View toggle expands and collapses', async ({ page }) => {
    await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTask(page);
    await page.evaluate((id) => openTaskDrawer(id), TASK_ID);

    const activity = page.locator(`#drwActivityWrap-${TASK_ID}`);
    const toggle = page.locator(`#drwActivityToggle-${TASK_ID}`);
    await toggle.click();
    await expect(activity).toBeVisible();
    await expect(activity).toContainText('Status changed to In Progress');
    await expect(toggle).toHaveText('Hide');
    await toggle.click();
    await expect(activity).toBeHidden();
    await expect(toggle).toHaveText('View');
  });

  test('posting from the drawer updates the list, badge and input', async ({ page }) => {
    await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTask(page);
    await page.evaluate((id) => openTaskDrawer(id), TASK_ID);

    const wrap = page.locator('.drw-comments-wrap');
    await wrap.locator('.drw-comment-input').fill('Posted straight from the drawer.');
    await wrap.getByRole('button', { name: 'Post' }).click();
    await expect(wrap).toContainText('Posted straight from the drawer.');
    await expect(wrap.locator('.drw-comment-input')).toHaveValue('');
    await expect(page.locator(`#drwCommentCount-${TASK_ID}`)).toHaveText('2');
  });

  test('drill-down task detail renders comments inline too', async ({ page }) => {
    await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTask(page);
    await page.evaluate((id) => {
      openDrillDown('Mock drill', [allTasks.find(t => t.id === id)]);
      openDrillDownTaskDetail(id);
    }, TASK_ID);

    const wrap = page.locator('#drillModalInner .drw-comments-wrap');
    await expect(wrap).toBeVisible();
    await expect(wrap).toContainText('Seeded comment from the mock API.');
    await expect(wrap).not.toContainText('[author:');
    await wrap.locator('.drw-comment-input').fill('Comment from the drill-down.');
    await wrap.getByRole('button', { name: 'Post' }).click();
    await expect(wrap).toContainText('Comment from the drill-down.');

    // The old comments modal was removed — nothing should resurrect it.
    expect(await page.evaluate(() => typeof openCommentsModal === 'undefined' ? 'undefined' : 'defined')).toBe('undefined');
  });

  test('a failed comments fetch explains why and offers a retry', async ({ page }) => {
    let blocked = true;
    await mockAirtable(page, { commentsGetFails: () => blocked });
    await page.goto(PAGE);
    await waitForTask(page);
    await page.evaluate((id) => openTaskDrawer(id), TASK_ID);

    const wrap = page.locator('.drw-comments-wrap');
    await expect(wrap).toContainText('403');
    await expect(wrap).toContainText('comments permission');
    await expect(page.locator(`#drwCommentCount-${TASK_ID}`)).toHaveText('?');
    // The composer stays usable even when the list failed to load.
    await expect(wrap.locator('.drw-comment-input')).toBeVisible();

    blocked = false;
    await wrap.getByRole('button', { name: 'Retry' }).click();
    await expect(wrap).toContainText('Seeded comment from the mock API.');
    await expect(page.locator(`#drwCommentCount-${TASK_ID}`)).toHaveText('1');
  });
});
