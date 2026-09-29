// The Tasks page moves only OPEN overdue tasks of Kevin's to today, and never
// treats a cancelled task as live work.
//
// Found on 29 Sep 2026 by the read-only page walk (scripts/prod-walk.js), which
// blocks every write: one load of this page as Kevin tried 52 PATCHes, all from
// autoRescheduleOverdue(). Read back from Airtable, 23 of the 52 were Cancelled,
// 28 were waiting in Kevin's approval queue and 1 was open. The cause sat one
// level down: deriveTaskStatus() kept Completed and Approval but turned a
// Cancelled task into Overdue/Today/Upcoming by its date, so the reschedule
// filter (status !== 'Completed') and _isOpen() both saw it as open. 32
// cancelled tasks showed on Kevin's board that day, 30 of them as Overdue.
// Kevin chose to stop moving approval cards too: their status does not follow
// their date, so moving it only hid how long a card had waited.
//
// Airtable is mocked. The mock ignores filterByFormula and returns every
// record, so the cancelled task still reaches the page here: that exercises the
// status and reschedule layers, not only the fetch filter. Back-tested: with
// Cancelled removed from deriveTaskStatus() and the reschedule filter put back
// to `status !== 'Completed'`, the no-write and board tests fail.

const { test, expect } = require('@playwright/test');
const { stubExternalHosts, localTodayISO } = require('./helpers');

const PAGE = '/os/tasks/index.html';
const TASKS_TABLE = 'tblqB8b22hKBL4PF1';
const F = {
  name: 'fldgFjGBw6bTKJFCD',
  dueDate: 'fld7XP8w8kbxfETV4',
  status: 'fldx4qCw17UfrKpaN',
  assignee: 'fldELMncVJYPDRJNc',
};
const KEVIN = { key: 'kevin', name: 'Kevin Brittain', email: 'kevin@runpreneur.org.uk' };
const OPEN = 'recOpenOverdue001';
const CANCELLED = 'recCancelledTsk01';
const APPROVAL = 'recApprovalCard01';

function daysAgo(n) {
  const d = new Date(localTodayISO() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function records() {
  const rec = (id, name, status, due) => ({
    id, createdTime: new Date().toISOString(),
    fields: { [F.name]: name, [F.status]: status, [F.dueDate]: due,
      [F.assignee]: { id: 'usrKkopUJSGsBhWMD', email: KEVIN.email, name: KEVIN.name } },
  });
  return { records: [
    rec(OPEN, 'An open task that slipped', 'Today', daysAgo(3)),
    rec(CANCELLED, 'A task that was cancelled', 'Cancelled', daysAgo(20)),
    rec(APPROVAL, 'A card waiting for Kevin', 'Approval', daysAgo(10)),
  ] };
}

async function load(page) {
  const patches = [];
  const taskFormulas = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await stubExternalHosts(page);
  await page.route('**/api.airtable.com/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/comments')) return json({ comments: [] });
    if (url.includes(TASKS_TABLE)) {
      if (req.method() === 'GET') {
        const f = new URL(url).searchParams.get('filterByFormula');
        if (f) taskFormulas.push(f);
        return json(records());
      }
      if (req.method() === 'PATCH') {
        const id = url.split('?')[0].split('/').pop();
        const body = JSON.parse(req.postData() || '{}');
        patches.push({ id, fields: body.fields || {} });
        return json({ id, fields: body.fields || {} });
      }
      return json({ id: 'recNone', fields: {} });
    }
    return json({ records: [] });
  });
  await page.addInitScript((user) => {
    localStorage.setItem('_dlr_pat', 'pat_test_mock_token_for_playwright');
    localStorage.setItem('_task_user', JSON.stringify(user));
  }, KEVIN);
  await page.goto(PAGE);
  await page.waitForFunction((id) => typeof allTasks !== 'undefined' && allTasks.some((t) => t.id === id), OPEN, { timeout: 20000 });
  // The reschedule runs after the load and moves the open task to today; wait
  // for that write, so the "no other write" checks below are not early.
  await expect.poll(() => patches.some((p) => p.id === OPEN), { timeout: 15000 }).toBe(true);
  await page.waitForTimeout(1500);
  return { patches, taskFormulas, errors };
}

test.describe('Tasks page: the overdue reschedule touches open tasks only', () => {
  test('CONTROL: an open overdue task of Kevin\'s is still moved to today', async ({ page }) => {
    const { patches } = await load(page);
    const mine = patches.filter((p) => p.id === OPEN);
    expect(mine).toHaveLength(1);
    expect(mine[0].fields[F.dueDate]).toBe(localTodayISO());
  });

  test('a cancelled task and an approval card are never written on load', async ({ page }) => {
    const { patches, errors } = await load(page);
    expect(patches.map((p) => p.id)).not.toContain(CANCELLED);
    expect(patches.map((p) => p.id)).not.toContain(APPROVAL);
    expect(patches).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('a cancelled task reads as Cancelled, is not open, and is off the active list', async ({ page }) => {
    await load(page);
    const r = await page.evaluate((id) => {
      const t = allTasks.find((x) => x.id === id);
      return { status: t && t.status, open: _isOpen(t), inList: getFilteredTasks().some((x) => x.id === id) };
    }, CANCELLED);
    expect(r).toEqual({ status: 'Cancelled', open: false, inList: false });
  });

  test('the task fetch asks Airtable to leave cancelled tasks out', async ({ page }) => {
    const { taskFormulas } = await load(page);
    const active = taskFormulas.filter((f) => f.includes('{Status}!="Completed"'));
    expect(active.length, 'the active-task fetch was not seen').toBeGreaterThan(0);
    for (const f of active) expect(f).toContain('{Status}!="Cancelled"');
  });
});
