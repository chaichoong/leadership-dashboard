// A single-select must never drop the value the record actually holds.
//
// FINDING 20260809-drift-037 — and what investigating it actually found.
//
// The finding said the drawer and the drill-down modal drop a task's Status when
// Airtable holds a legacy value ('To do' / 'Current'), showing 'Today' instead,
// because both build the dropdown straight from a hardcoded array:
//
//     ${STATUS_OPTIONS.map(s => `<option ... ${t.status===s?'selected':''}>`)}
//
// The STATUS half does NOT reproduce, and the control below is what proves it.
// `t.status` is not Airtable's value: parseTask runs it through
// deriveTaskStatus(dueDate, storedStatus), which returns one of Completed,
// Approval, Overdue, Today or Upcoming and nothing else. The raw value is kept
// separately as `t.storedStatus`. So a task stored as 'To do' and due today
// really does read 'Today' in the drawer — by design, from the date, not from a
// missing <option>. The 11 live tasks are a stored-vs-derived question for
// Kevin, not a render bug.
//
// The PRIORITY half is real. `priority: selectName(priorityObj)` is the raw
// Airtable value, so legacy 'High' does reach the dropdown — and it was being
// held up by a bespoke one-off:
//
//     ${t.priority==='High' ? '<option value="High" selected>High (legacy)</option>' : ''}
//
// One hardcoded value, patched in two of the four places a select is built. The
// grid already had the general fix inside inlineSelectCell. That one line is now
// buildOptions(), used by all four, so the next retired option needs no patch.
//
// Airtable is mocked, so this is a fixture test and sees only the RENDER half.
// That is the right layer: the defect is entirely in how markup is built from a
// value, not in the shape of the data.

const { test, expect } = require('@playwright/test');
const { stubExternalHosts, localTodayISO } = require('./helpers');

const PAGE = '/os/tasks/index.html';
const TASKS_TABLE = 'tblqB8b22hKBL4PF1';
const F = {
  name: 'fldgFjGBw6bTKJFCD',
  dueDate: 'fld7XP8w8kbxfETV4',
  status: 'fldx4qCw17UfrKpaN',
  priority: 'fldS21RwmwOqt71LI',
};

const LEGACY_ID = 'recLegacyMock1';
const MODERN_ID = 'recModernMock1';

function taskRecords() {
  const today = localTodayISO();
  return { records: [
    { id: LEGACY_ID, createdTime: new Date().toISOString(), fields: {
      [F.name]: 'Legacy value task', [F.status]: 'To do', [F.priority]: 'High', [F.dueDate]: today } },
    { id: MODERN_ID, createdTime: new Date().toISOString(), fields: {
      [F.name]: 'Modern value task', [F.status]: 'Upcoming', [F.priority]: 'Urgent', [F.dueDate]: today } },
  ] };
}

async function mockAirtable(page) {
  await stubExternalHosts(page);
  await page.route('**/api.airtable.com/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/comments')) return json({ comments: [] });
    if (url.includes(TASKS_TABLE)) return method === 'GET' ? json(taskRecords()) : json({ id: LEGACY_ID, fields: {} });
    return json({ records: [] });
  });
  await page.addInitScript(() => {
    localStorage.setItem('_dlr_pat', 'pat_test_mock_token_for_playwright');
    localStorage.setItem('_task_user', JSON.stringify({ key: 'kevin', name: 'Kevin Brittain', email: 'kevinbrittain@gmail.com' }));
  });
}

async function waitForTasks(page) {
  await page.waitForFunction(
    (id) => typeof allTasks !== 'undefined' && allTasks.some(t => t.id === id),
    LEGACY_ID, { timeout: 20000 });
}

async function load(page) {
  await mockAirtable(page);
  await page.goto(PAGE);
  await waitForTasks(page);
}

test.describe('legacy single-select values survive rendering', () => {
  test('CONTROL — the fixture carries a legacy Priority, and Status is derived not raw', async ({ page }) => {
    await load(page);
    const t = await page.evaluate((id) => {
      const x = allTasks.find(y => y.id === id);
      return { status: x.status, storedStatus: x.storedStatus, priority: x.priority };
    }, LEGACY_ID);

    // Priority is raw — so a retired option genuinely reaches the dropdown, and
    // everything below has something real to catch.
    expect(t.priority).toBe('High');
    const known = await page.evaluate(() => PRIORITY_OPTIONS);
    expect(known, "'High' must NOT be in PRIORITY_OPTIONS, or there is no bug to catch").not.toContain('High');

    // Status is NOT raw. This is the half of the finding that does not hold: the
    // drawer shows 'Today' because the due date says today, not because an
    // <option> went missing. If someone later stops deriving status, this fails
    // and the Status dropdown needs the same scrutiny as Priority.
    expect(t.storedStatus).toBe('To do');
    expect(t.status).toBe('Today');
  });

  test('THE REGRESSION: drawer keeps a legacy Priority instead of falling to the first option', async ({ page }) => {
    await load(page);
    await page.evaluate((id) => openTaskDrawer(id), LEGACY_ID);
    // Falling through to the first option is the corruption: with no matching
    // <option> the browser selects index 0, and the next save writes that back.
    await expect(page.locator('#drwPrioritySel')).toHaveValue('High');
    await expect(page.locator('#drwPrioritySel')).toContainText('High (legacy)');
  });

  test('drill-down modal keeps it too', async ({ page }) => {
    await load(page);
    await page.evaluate((id) => {
      openDrillDown('Mock drill', [allTasks.find(t => t.id === id)]);
      openDrillDownTaskDetail(id);
    }, LEGACY_ID);
    await expect(page.locator('#drillModalInner #drwPrioritySel')).toHaveValue('High');
  });

  test('a current value is not mislabelled as legacy', async ({ page }) => {
    await load(page);
    await page.evaluate((id) => openTaskDrawer(id), MODERN_ID);
    await expect(page.locator('#drwPrioritySel')).toHaveValue('Urgent');
    await expect(page.locator('#drwPrioritySel')).not.toContainText('legacy');
  });

  test('buildOptions is the ONE construction, and every select uses it', async ({ page }) => {
    await load(page);
    // Guards the extraction itself: inlining a .map() back into any one of the
    // four sites reintroduces the bug in that spot alone, silently.
    expect(await page.evaluate(() => typeof buildOptions)).toBe('function');

    const cases = await page.evaluate(() => ({
      legacyKept: buildOptions('High', ['', ...PRIORITY_OPTIONS]),
      knownValue: buildOptions('Urgent', ['', ...PRIORITY_OPTIONS]),
      blank: buildOptions('', ['', ...PRIORITY_OPTIONS]),
      noBlankOption: buildOptions('', PRIORITY_OPTIONS),
    }));

    expect(cases.legacyKept).toContain('value="High" selected');
    expect(cases.legacyKept).toContain('High (legacy)');
    expect(cases.knownValue).toContain('value="Urgent" selected');
    expect(cases.knownValue).not.toContain('legacy');
    // A blank current value selects the blank option, never invents one.
    expect(cases.blank).toContain('value="" selected');
    expect(cases.noBlankOption).not.toContain('selected');
  });

  test('the bespoke High patch is gone from every select', async ({ page }) => {
    await load(page);
    const src = await page.evaluate(() => document.documentElement.outerHTML);
    // Belt and braces on the extraction: the one-off is what buildOptions replaced.
    expect(src).not.toContain("t.priority==='High'?");
  });
});
