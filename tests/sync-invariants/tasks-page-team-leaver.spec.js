// The Tasks page never offers someone who has left for new work, and still
// names them on a task they hold.
//
// Ericamae left on 17 Sep 2026 (Team Members recEvm9wgsEnoNVZh: Active=false,
// Status=Offboarded). PR #498 fixed the shell's quick-task panel (TASK_TEAM in
// js/config.js). os/tasks/index.html keeps its OWN TEAM list, and every picker
// and every "create a task for whoever is on screen" default on that page read
// it unfiltered, so she was still offered in Add Task, the drawer and grid
// assignee pickers, bulk assign, collaborators, project owner and the "who are
// you" screen, and every new maintenance task copied her in as a collaborator.
//
// Deleting her from TEAM would fix the pickers and break the lookups: an old
// task of hers would open with no assignee selected, and the next save could
// drop the assignment. So she stays in TEAM marked `left`, and the pickers
// filter on it (teamForNewWork), exactly as js/shared.js does for TASK_TEAM.
//
// Karlo (left 28 Jul 2026) and Giezel (Offboarded) are in no team list on this
// page or on os/systemisation/, so there is nothing of theirs to hide.
//
// Airtable is mocked (fixture test): this covers the render, the lookups and
// the create payloads. Back-tested both ways: with `left` removed from her TEAM
// entry all eight fail; with teamForNewWork() returning TEAM unfiltered, the
// four picker and maintenance tests fail (the team bar and the "whose view is
// this" default read `left` directly, and her own task shows her either way).

const { test, expect } = require('@playwright/test');
const { stubExternalHosts, localTodayISO } = require('./helpers');

const PAGE = '/os/tasks/index.html';
const TASKS_TABLE = 'tblqB8b22hKBL4PF1';
const F = {
  name: 'fldgFjGBw6bTKJFCD',
  dueDate: 'fld7XP8w8kbxfETV4',
  status: 'fldx4qCw17UfrKpaN',
  assignee: 'fldELMncVJYPDRJNc',
  collaborators: 'fldcq3t6uAPgWSOP8',
};
const LEFT = { key: 'erica', name: 'Ericamae Atenta', email: 'atentaerica@gmail.com' };
const USER = { key: 'kevin', name: 'Kevin Brittain', email: 'kevin@runpreneur.org.uk' };
const HERS = 'recHersMockTask01';
const KEVINS = 'recKevinMockTsk01';

function taskRecords(withHers) {
  const today = localTodayISO();
  const rec = (id, name, who) => ({
    id, createdTime: new Date().toISOString(),
    fields: { [F.name]: name, [F.status]: 'Today', [F.dueDate]: today, [F.assignee]: { id: `usr${id.slice(3, 17)}`, ...who } },
  });
  const out = [rec(KEVINS, 'A task Kevin holds', { email: USER.email, name: USER.name })];
  if (withHers) out.push(rec(HERS, 'An old task she still holds', { email: LEFT.email, name: LEFT.name }));
  return { records: out };
}

async function load(page, { withHers = true } = {}) {
  const posts = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await stubExternalHosts(page);
  await page.route('**/api.airtable.com/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/comments')) return json({ comments: [] });
    if (url.includes(TASKS_TABLE)) {
      if (req.method() === 'GET') return json(taskRecords(withHers));
      if (req.method() === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        posts.push(body);
        return json({ id: 'recNewMockTask001', createdTime: new Date().toISOString(), fields: body.fields || {} });
      }
      return json({ id: HERS, fields: {} });
    }
    return json({ records: [] });
  });
  await page.addInitScript((user) => {
    localStorage.setItem('_dlr_pat', 'pat_test_mock_token_for_playwright');
    localStorage.setItem('_task_user', JSON.stringify(user));
  }, USER);
  await page.goto(PAGE);
  await page.waitForFunction(
    (id) => typeof allTasks !== 'undefined' && allTasks.some((t) => t.id === id),
    KEVINS, { timeout: 20000 });
  return { posts, errors };
}

const optionsOf = (page, sel) => page.$$eval(`${sel} option`, (os) => os.map((o) => ({ value: o.value, text: o.textContent.trim(), selected: o.selected })));

test.describe('Tasks page and people who have left', () => {
  test('CONTROL: she is still in TEAM, marked left, and her fixture task is hers', async ({ page }) => {
    // Without this the tests below would pass just as well if she had been
    // deleted from TEAM, which is the version that breaks her old tasks.
    await load(page);
    const r = await page.evaluate(({ key, id }) => ({
      member: TEAM.find((m) => m.key === key),
      holder: (allTasks.find((t) => t.id === id) || {}).assigneeEmail,
    }), { key: LEFT.key, id: HERS });
    expect(r.member).toMatchObject({ name: LEFT.name, email: LEFT.email });
    expect(r.member.left).toBeTruthy();
    expect(r.holder).toBe(LEFT.email);
  });

  test('Add Task never offers her', async ({ page }) => {
    const { errors } = await load(page);
    await page.evaluate(() => openCreateTaskModal());
    const opts = await optionsOf(page, '#ctAssignee');
    expect(opts.length, 'the picker rendered no team at all').toBeGreaterThan(3);
    expect(opts.map((o) => o.value)).toContain('roy');
    expect(opts.map((o) => o.value)).not.toContain(LEFT.key);
    expect(opts.map((o) => o.text).join('|')).not.toContain('Ericamae');
    expect(errors, 'console errors on the Tasks page').toEqual([]);
  });

  test('her own task still names her, selected, as "(left)"', async ({ page }) => {
    await load(page);
    await page.evaluate((id) => openTaskDrawer(id), HERS);
    const sel = '#drawerOverlay select[onchange*="\'assignee\'"]';
    const opts = await optionsOf(page, sel);
    const hers = opts.find((o) => o.value === LEFT.key);
    expect(hers, 'an old task of hers lost its assignee').toBeTruthy();
    expect(hers.selected).toBe(true);
    expect(hers.text).toBe(`${LEFT.name} (left)`);
    await expect(page.locator(sel)).toHaveValue(LEFT.key);
  });

  test("a current member's task, bulk assign, collaborators and project owner never offer her", async ({ page }) => {
    await load(page);
    await page.evaluate((id) => openTaskDrawer(id), KEVINS);
    const drawer = await optionsOf(page, '#drawerOverlay select[onchange*="\'assignee\'"]');
    expect(drawer.map((o) => o.value)).toContain('kevin');
    expect(drawer.map((o) => o.value)).not.toContain(LEFT.key);

    const html = await page.evaluate((id) => {
      const t = allTasks.find((x) => x.id === id);
      selectedTasks.add(id);
      updateBulkBar();
      return {
        grid: assigneeOptionsHtml(t, true),
        collab: renderCollaboratorsDrawer({ ...t, collaborators: [] }),
        bulk: document.getElementById('bulkAsgSel').innerHTML,
        owner: teamForNewWork((m) => '' === m.key).map((m) => m.key),
      };
    }, KEVINS);
    for (const where of ['grid', 'collab', 'bulk']) {
      expect(html[where], `${where} offers her`).not.toContain('Ericamae');
    }
    expect(html.bulk).toContain('Roy');
    expect(html.grid).toContain('Roy');
    expect(html.owner).toContain('roy');
    expect(html.owner).not.toContain(LEFT.key);
  });

  test('the "who are you" screen does not list her', async ({ page }) => {
    await load(page);
    await page.evaluate(() => showIdentityOverlay());
    const names = await page.$$eval('#identityBtns .identity-btn', (bs) => bs.map((b) => b.textContent));
    expect(names.join('|')).toContain('Kevin Brittain');
    expect(names.join('|')).not.toContain('Ericamae');
  });

  test('the team bar shows her only while she holds open work', async ({ browser }) => {
    const withWork = await browser.newPage();
    await load(withWork, { withHers: true });
    await withWork.evaluate(() => renderTeamBar());
    expect(await withWork.locator('#teamBar').innerText()).toContain('Ericamae');
    await withWork.close();

    const none = await browser.newPage();
    await load(none, { withHers: false });
    await none.evaluate(() => renderTeamBar());
    const bar = await none.locator('#teamBar').innerText();
    expect(bar).toContain('Kevin');
    expect(bar).not.toContain('Ericamae');
    await none.close();
  });

  test('a task created while viewing her work is not given to her', async ({ page }) => {
    const { posts } = await load(page);
    await page.evaluate(async () => { setTeam('erica'); await openNewTaskDrawer({ name: 'Created on her view' }); });
    await expect.poll(() => posts.length).toBeGreaterThan(0);
    const created = posts.find((b) => b.fields && b.fields[F.name] === 'Created on her view');
    expect(created, 'no create was sent').toBeTruthy();
    expect(created.fields[F.assignee]).toEqual({ email: USER.email });
  });

  test('a new maintenance task copies in Kevin and Mica, never her', async ({ page }) => {
    const { posts } = await load(page);
    await page.evaluate(() => createMaintenanceTask({ name: 'Boiler check' }));
    await expect.poll(() => posts.length).toBeGreaterThan(0);
    const created = posts.find((b) => b.fields && b.fields[F.name] === 'Boiler check');
    const emails = (created.fields[F.collaborators] || []).map((c) => c.email);
    expect(emails).toContain('micaa.work@gmail.com');
    expect(emails).not.toContain(LEFT.email);
  });
});
