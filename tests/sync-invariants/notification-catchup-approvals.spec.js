// The catch-up DM must never fire for an approval-gate item — 4 Sep 2026.
//
// What happened: at 12:06:29 BST nine Slack DMs landed in Kevin's DM with the
// Operations Director app inside 158 milliseconds (ts 1788519989.738939 →
// .896119). Every one of them read "*<Business>* assigned to you:" and every
// one of them was an approval-gate item. Five were CONTENT (OD) posts he had
// REJECTED between 11:55 and 11:59, one was an EICR follow-up he had sent back
// for changes at 12:03, one he had approved as-is, and two were still sitting
// at the gate waiting for him. Nothing had been assigned to him. He was being
// told about decisions he had just made.
//
// The mechanism: an agent submitting work sets Assignee to the approver so the
// task lands in his queue. runNotificationCatchup() in os/tasks/index.html
// sweeps allTasks on every loadAllData() and DMs anything assigned to him,
// created in the last 48 hours, that the web app did not create — which
// describes every agent approval submission exactly. The burst is a
// client-side forEach, which is why all nine share one second.
//
// This is the SECOND home of one bug. The Airtable automation "When task is
// assigned to team member" was given the same guard on 21 Aug 2026, after 26
// duplicate DMs landed in one second on 20 Aug; its script still carries the
// comment. The page's catch-up path was never given it.
//
// Gate on the RAISER LINK, not on status. All three decide surfaces null the
// Assignee and move status to Today or Completed, yet on 4 Sep seven DECIDED
// tasks still reached this sweep with his name on them — the null had not
// landed in the list the page read. A status test lets all seven through, and
// separately matches nothing: the one live row at Status=Approval without a
// raiser link has no assignee either, so it never reaches the send.
//
// The twin at os/tasks/index-supabase.html runs the same catch-up. It needs
// the field requested and mapped, not just the guard pasted in — covered by
// tests/notification-catchup-guard.test.js.
//
// Airtable is mocked and stubExternalHosts() blocks the internet, so the
// assertion is on the payloads the page actually POSTs to the slack-notify
// worker.

const { test, expect } = require('@playwright/test');
const { stubExternalHosts, localTodayISO } = require('./helpers');

const PAGE = '/os/tasks/index.html';
const TASKS_TABLE = 'tblqB8b22hKBL4PF1';
const ME = 'kevinbrittain@gmail.com';

// Mirrored from the F constants block in os/tasks/index.html.
const F = {
  name: 'fldgFjGBw6bTKJFCD',
  dueDate: 'fld7XP8w8kbxfETV4',
  status: 'fldx4qCw17UfrKpaN',
  assignee: 'fldELMncVJYPDRJNc',
  created: 'fldywB2EXESbXB7it',
  business: 'fldLu1Y4GzyWcDoxr',
  createdByEmail: 'fldtzljV5m0eTgBK5',
  sentForApprovalBy: 'fld30Yw8SWYVp049g',
  approvalOutcome: 'fldrHBSr6qoUfaKuZ',
};

const AGENT = 'recTmContentEngine';
const KEVIN = { id: 'usrKevinMock', email: ME, name: 'Kevin Brittain' };

// Every task below is assigned to Kevin, created an hour ago, and carries no
// web-app creator — i.e. every one clears the catch-up's original three gates.
// What separates them is only whether an agent raised them for approval.
function taskRecords() {
  const created = new Date(Date.now() - 3600e3).toISOString();
  const base = {
    [F.assignee]: KEVIN,
    [F.created]: created,
    [F.dueDate]: localTodayISO(),
  };
  return { records: [
    // Real delegation: an external system genuinely gave Kevin work. This is
    // the case the catch-up exists for and it MUST still fire.
    { id: 'recRealAssignment', createdTime: created, fields: {
      ...base, [F.name]: 'INBOUND: NatWest minimum payment missed', [F.status]: 'Today',
    } },
    // Waiting at the gate. The agent set Assignee to the approver.
    { id: 'recAtTheGate', createdTime: created, fields: {
      ...base, [F.name]: 'CONTENT: Publish Episode 2195 of Diary of a Runpreneur',
      [F.status]: 'Approval', [F.sentForApprovalBy]: [AGENT],
    } },
    // Already decided: an approval outcome is recorded and status has moved
    // off Approval, but his name is still on it. This is the shape seven of
    // the nine arrived in on 4 Sep, and the reason the guard cannot key on
    // status alone.
    { id: 'recAlreadyRejected', createdTime: created, fields: {
      ...base, [F.name]: 'CONTENT (OD): Wed 9 Sep, Proof', [F.status]: 'Today',
      [F.sentForApprovalBy]: [AGENT], [F.approvalOutcome]: 'Rejected',
    } },
  ] };
}

// Capture what the page sends to the slack-notify worker. Registered AFTER
// stubExternalHosts so this route wins for workers.dev.
async function mockTasksPage(page, opts = {}) {
  const dms = [];
  await stubExternalHosts(page);
  await page.route('**/slack-notify.kevinbrittain.workers.dev/**', async (route) => {
    try { dms.push(JSON.parse(route.request().postData() || '{}')); } catch { dms.push({}); }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api.airtable.com/**', async (route) => {
    const url = route.request().url();
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/comments')) return json({ comments: [] });
    if (url.includes(TASKS_TABLE)) {
      return route.request().method() === 'GET' ? json(taskRecords()) : json({ id: 'recX', fields: {} });
    }
    return json({ records: [] });
  });
  await page.addInitScript((args) => {
    localStorage.setItem('_dlr_pat', 'pat_test_mock_token_for_playwright');
    localStorage.setItem('_task_user', JSON.stringify({ key: 'kevin', name: 'Kevin Brittain', email: args.me }));
    // The catch-up dedupes against this key. Start clean or it no-ops and the
    // spec passes for the wrong reason. `seed` sets it deliberately instead.
    if (args.seed === null) localStorage.removeItem('_slack_notified_tasks');
    else localStorage.setItem('_slack_notified_tasks', JSON.stringify(args.seed));
  }, { me: ME, seed: opts.seed === undefined ? null : opts.seed });
  return dms;
}

// Read the dedupe store back out of the page.
async function readStore(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('_slack_notified_tasks') || 'null'));
}

// The catch-up runs at the end of loadAllData(). Wait for the task it is
// always allowed to send, then let the burst drain — a fixed timeout here
// would go flaky under parallel load.
async function loadAndSettle(page, dms) {
  await page.goto(PAGE);
  await page.waitForFunction(() => typeof allTasks !== 'undefined' && allTasks.length >= 3, null, { timeout: 20000 });
  await expect.poll(() => dms.some((d) => d.taskId === 'recRealAssignment'), { timeout: 20000 }).toBe(true);
  // The nine on 4 Sep went out inside 158ms of each other, so anything the
  // guard failed to stop has landed by the time the allowed one has.
  await page.waitForTimeout(500);
}

test.describe('notification catch-up and the approval gate', () => {
  test('never DMs a task an agent raised for approval', async ({ page }) => {
    const dms = await mockTasksPage(page);
    await loadAndSettle(page, dms);

    const ids = dms.map((d) => d.taskId);
    expect(ids).not.toContain('recAtTheGate');
    expect(ids).not.toContain('recAlreadyRejected');
  });

  test('still DMs work that was genuinely assigned to him', async ({ page }) => {
    const dms = await mockTasksPage(page);
    await loadAndSettle(page, dms);

    // CONTROL. Without this the spec would pass just as well if the catch-up
    // were deleted outright, which is not the fix.
    const real = dms.filter((d) => d.taskId === 'recRealAssignment');
    expect(real).toHaveLength(1);
    expect(real[0].action).toBe('assigned');
    expect(real[0].recipientEmail).toBe(ME);
  });

  test('one page load sends exactly one DM, not a burst', async ({ page }) => {
    const dms = await mockTasksPage(page);
    await loadAndSettle(page, dms);

    // Three tasks in, one DM out. The 4 Sep burst was nine.
    expect(dms.map((d) => d.taskId).sort()).toEqual(['recRealAssignment']);
  });
});

// ── THE DEDUPE STORE ────────────────────────────────────────────────────────
//
// Same routine, second defect, found reviewing the fix above. The store of
// "already DM'd" ids was an array trimmed to its last 500 entries. It trims
// from the FRONT, so past 500 remembered tasks the page forgets one it has
// already sent and sends it again. It also grew for ever inside that cap:
// every task the sweep skipped was added too, not just the ones it sent.
//
// The board was 232 open tasks on 4 Sep 2026 so the cap had never bitten, but
// the Q2->Q3 cleanse ran at 303. Eviction is now by AGE, using the same 48h
// cutoff the sweep already applies, which cannot resurrect anything: a task
// past that age is refused whether or not the store remembers it.
test.describe('the dedupe store cannot forget and re-send', () => {
  test('a task already sent is not sent again', async ({ page }) => {
    const first = await mockTasksPage(page);
    await loadAndSettle(page, first);
    const store = await readStore(page);
    expect(Object.keys(store)).toContain('recRealAssignment');

    // Second visit carrying what the first one learned.
    const second = await mockTasksPage(page, { seed: store });
    await page.goto(PAGE);
    await page.waitForFunction(() => typeof allTasks !== 'undefined' && allTasks.length >= 3, null, { timeout: 20000 });
    await page.waitForTimeout(1000);
    expect(second).toEqual([]);
  });

  test('THE REGRESSION: 600 remembered ids do not evict a live one', async ({ page }) => {
    // Exactly what .slice(-500) did — recRealAssignment sits at the FRONT, so
    // the old trim dropped it and the DM went out a second time.
    const seed = { recRealAssignment: Date.now() + 48 * 3600e3 };
    for (let i = 0; i < 600; i++) seed['recFiller' + i] = Date.now() + 48 * 3600e3;

    const dms = await mockTasksPage(page, { seed });
    await page.goto(PAGE);
    await page.waitForFunction(() => typeof allTasks !== 'undefined' && allTasks.length >= 3, null, { timeout: 20000 });
    await page.waitForTimeout(1000);
    expect(dms.map((d) => d.taskId)).not.toContain('recRealAssignment');
  });

  test('expired entries are dropped, so the store cannot grow for ever', async ({ page }) => {
    const seed = { recAncient: Date.now() - 1000, recRealAssignment: Date.now() + 48 * 3600e3 };
    const dms = await mockTasksPage(page, { seed });
    await loadAndSettle2(page);
    const store = await readStore(page);
    expect(Object.keys(store)).not.toContain('recAncient');
    // CONTROL: an unexpired entry survives the same pass.
    expect(Object.keys(store)).toContain('recRealAssignment');
    expect(dms.map((d) => d.taskId)).not.toContain('recRealAssignment');
  });

  test('the legacy array format migrates instead of re-sending everything', async ({ page }) => {
    // Every browser holds the old shape on first load after this ships. If the
    // reader does not understand it, every id is forgotten at once and the
    // whole 48h window is re-sent — a duplicate burst per device.
    const dms = await mockTasksPage(page, { seed: ['recRealAssignment'] });
    await loadAndSettle2(page);
    expect(dms.map((d) => d.taskId)).not.toContain('recRealAssignment');
    const store = await readStore(page);
    expect(Array.isArray(store), 'still the legacy shape — no migration happened').toBe(false);
    expect(typeof store.recRealAssignment).toBe('number');
  });
});

// Load and let the sweep finish, without asserting that anything was sent —
// these tests seed the store precisely so nothing is.
async function loadAndSettle2(page) {
  await page.goto(PAGE);
  await page.waitForFunction(() => typeof allTasks !== 'undefined' && allTasks.length >= 3, null, { timeout: 20000 });
  await page.waitForTimeout(1000);
}
