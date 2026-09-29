// Invariant: Home (Kevin, 29 Sep 2026) is added BESIDE the old screens and changes none of them.
// Home shows one list of what needs Kevin today and, only while it is open, the real Leadership
// Dashboard panel underneath (body.home-mode in css/home.css). Leaving Home must put the shell back
// exactly as it was, the app must still open on the Leadership Dashboard, and a #home link must
// work cold. The list's pick rules are tested in tests/home-list.test.js; this spec drives js/home.js.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, setupMockAirtable, localTodayISO } = require('./helpers');

const TASKS = 'tblqB8b22hKBL4PF1';
const ESTATE = 'tblZVrdzivyBueZVf';

function homeFixtures() {
  const today = localTodayISO();
  const rec = (id, name, fields) => ({ id, fields: { 'Task Name': name, Status: 'Today', ...fields } });
  return {
    today,
    tasks: [
      rec('recHomeSpec000001', 'INBOUND: Example court notice due today', { 'Hard Deadline': true, 'Due Date': today, Status: 'Approval', 'Sent For Approval By': ['recAgentXXXXXXXXX'] }),
      rec('recHomeSpec000002', 'Example standing order change', { 'Due Date': today, 'Team Member': ['recHEt2VPYothaqTd'] }),
      rec('recHomeSpec000003', 'Reply to the example agent', { 'Due Date': today, Status: 'Approval', 'Sent For Approval By': ['recAgentXXXXXXXXX'], 'Task Type': 'Correspondence' }),
    ],
  };
}

// Home reads Tasks and Estate Status by field NAME, like the 09:00 brief. Answer those reads with
// by-name fixtures and pass every field-ID read back to the shared mock, so the rest of the shell
// (the Leadership Dashboard included) loads exactly as in every other spec.
async function routeHome(page, fx) {
  await page.route('**/api.airtable.com/v0/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('returnFieldsByFieldId') === 'true') return route.fallback();
    const formula = url.searchParams.get('filterByFormula') || '';
    if (url.pathname.includes(TASKS)) {
      const records = /Sent For Approval By/.test(formula) ? fx.tasks.filter(r => r.fields.Status === 'Approval') : fx.tasks;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records }) });
    }
    if (url.pathname.includes(ESTATE)) {
      const key = (formula.match(/\{Key\}='([^']+)'/) || [])[1];
      const payloads = {
        'daily-ops-needs-you': { date: fx.today, items: ['Example note from the 07:00 check'] },
        'agent-blockers': { open: [], sweptAt: new Date().toISOString() },
        'tenant-chain': { asAt: fx.today, worst: 'ok', briefLine: 'working, nothing to watch' },
      };
      const records = payloads[key] ? [{ id: 'recEstateSpec0001', fields: { Key: key, Payload: JSON.stringify(payloads[key]) } }] : [];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records }) });
    }
    return route.fallback();
  });
}

async function open(page, hash) {
  await page.addInitScript((pat) => { localStorage.setItem('_dlr_pat', pat); try { indexedDB.deleteDatabase('_dlr_cache'); } catch {} }, MOCK_PAT);
  await setupMockAirtable(page);
  const fx = homeFixtures();
  await routeHome(page, fx);   // registered last, so it is asked first
  await page.goto('/' + (hash ? '#' + hash : ''));
  await page.waitForFunction(() => {
    const dash = document.getElementById('dashboard');
    return dash && dash.style.display !== 'none';
  }, { timeout: 20000 }).catch(() => {});
  return fx;
}

const shown = (page, id) => page.evaluate(i => getComputedStyle(document.getElementById(i)).display !== 'none', id);

test.describe('Home tab sits beside the old screens', () => {
  test('the app still opens on the Leadership Dashboard, with Home closed', async ({ page }) => {
    await open(page, '');
    await page.waitForTimeout(1000);
    expect(await shown(page, 'tab-overview')).toBe(true);
    expect(await shown(page, 'tab-home')).toBe(false);
    expect(await page.evaluate(() => document.body.classList.contains('home-mode'))).toBe(false);
  });

  test('a cold #home link shows the one list, then the real Leadership Dashboard underneath', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await open(page, 'home');
    await page.waitForFunction(() => document.querySelectorAll('#homeList .home-row').length > 0, { timeout: 20000 });
    expect(await page.evaluate(() => document.body.classList.contains('home-mode'))).toBe(true);
    expect(await shown(page, 'tab-home')).toBe(true);
    expect(await shown(page, 'tab-overview')).toBe(true);
    // Home comes first on the page, the dashboard after it.
    const homeFirst = await page.evaluate(() => Boolean(document.getElementById('tab-home')
      .compareDocumentPosition(document.getElementById('tab-overview')) & Node.DOCUMENT_POSITION_FOLLOWING));
    expect(homeFirst).toBe(true);
    const rows = await page.locator('#homeList .home-row .home-name').allTextContents();
    expect(rows[0]).toBe('INBOUND: Example court notice due today');
    expect(rows).toEqual(expect.arrayContaining(['Example standing order change', 'Example note from the 07:00 check', 'Reply to the example agent']));
    // The court notice is a deadline AND a queue card: shown once, with the queue button.
    expect(rows.filter(r => /court notice/.test(r))).toHaveLength(1);
    await expect(page.locator('#homeList .home-summary')).toContainText('4 things need you today');
    await expect(page.locator('#homeList .home-tenants')).toContainText('working, nothing to watch');
    expect(errors.filter(e => !/net::ERR|Failed to fetch|NetworkError/.test(e))).toEqual([]);
  });

  test('leaving Home puts the shell back exactly as it was', async ({ page }) => {
    await open(page, 'home');
    await page.waitForFunction(() => document.body.classList.contains('home-mode'), { timeout: 20000 });
    await page.evaluate(() => switchTab('overview'));
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.body.classList.contains('home-mode'))).toBe(false);
    expect(await shown(page, 'tab-home')).toBe(false);
    expect(await shown(page, 'tab-overview')).toBe(true);
    await page.evaluate(() => switchTab('home'));
    await page.evaluate(() => switchTab('invoices'));
    await page.waitForTimeout(200);
    expect(await shown(page, 'tab-overview')).toBe(false);
    expect(await shown(page, 'tab-home')).toBe(false);
  });

  test('"Open the queue" opens the AI Agents approvals, and Home has no dot in the Leadership roll-up', async ({ page }) => {
    await open(page, 'home');
    await page.waitForFunction(() => document.querySelector('#homeList [data-home-queue]'), { timeout: 20000 });
    await page.locator('#homeList [data-home-queue]').first().click();
    await page.waitForTimeout(300);
    expect(await shown(page, 'tab-agents')).toBe(true);
    expect(await page.evaluate(() => document.body.classList.contains('home-mode'))).toBe(false);
    expect(await page.locator('[data-sidebar-health="home"]').count()).toBe(0);
  });
});
