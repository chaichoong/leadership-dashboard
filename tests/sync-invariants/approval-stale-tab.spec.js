// AN OLD TAB SAVES NOTHING (Kevin, 7 Oct 2026). The Your step cards went live at 12:43 that day,
// but his approval tab had been open since the morning and kept the old code, which showed those
// cards with an Approve button. Ten were approved two to four times; each approval sent the card
// round the robots and it came back. js/page-freshness.js now compares the page's own size with
// the live copy's (the GitHub Pages ETag) before any decision is saved. Invariants:
//   1. AI Agents queue, older than the live page: Approve writes NOTHING, says so, reloads, and the
//      note he typed is back in the box after the reload.
//   2. AI Agents queue, same as the live page: Approve saves as before (the check is not a wall).
//   3. Tasks drawer, older than the live page: apvDecide writes nothing, reloads, and his note is
//      back in that task's box.
// The live copy's ETag is faked with page.route on the page's own HEAD request; Airtable is mocked.
// Names are invented (the repo is public).
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');
const { stubExternalHosts, localTodayISO } = require('./helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const bytes = (rel) => fs.statSync(path.join(ROOT, rel)).size;
const etag = (n) => `W/"6ac6757c-${n.toString(16)}"`;

// The live copy, as the page's HEAD request sees it. `live.bytes` is read at request time.
async function fakeLiveCopy(page, pagePath, live) {
  const heads = [];
  // The check and the reload both carry a fresh query, so the route matches with or without one.
  const re = new RegExp(pagePath.replace(/[./]/g, (c) => '\\' + c) + '(\\?.*)?$');
  await page.route(re, async (route) => {
    if (route.request().method() !== 'HEAD') return route.continue();
    heads.push(live.bytes);
    return route.fulfill({ status: 200, headers: { etag: etag(live.bytes), 'content-type': 'text/html' }, body: '' });
  });
  return heads;
}

test.describe('AI Agents queue: an old tab saves nothing', () => {
  const PAGE = '/os/agents/index.html';
  const ID = 'recApvB1';

  test('older than the live page: Approve writes nothing, reloads, and the typed note comes back', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    const live = { bytes: bytes('os/agents/index.html') + 7 };   // a newer copy is live
    const heads = await fakeLiveCopy(page, PAGE, live);
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator(`[data-apv-card="${ID}"]`);
    await expect(card).toBeVisible();
    await card.locator(`#apvNote-${ID}`).fill('Send it from the info@ address.');
    const reloaded = page.waitForEvent('load', { timeout: 15000 });
    await card.locator('button[data-apv-btn]', { hasText: /^Approve$/ }).click();
    await expect(page.locator('#toast')).toContainText('updated after you opened it, so nothing was saved');
    live.bytes = bytes('os/agents/index.html');                  // after the reload this tab IS the live copy
    await reloaded;
    expect(heads.length).toBeGreaterThan(0);
    expect(patches.filter((p) => p.id === ID)).toHaveLength(0);
    expect(page.url()).toMatch(/\/os\/agents\/index\.html\?fresh=\d+/);   // the live copy, past any cache
    await page.click('#ptab-approvals');
    await expect(page.locator(`#apvNote-${ID}`)).toHaveValue('Send it from the info@ address.');
  });

  test('older than the live page: a bulk approve never starts, and says why rather than "decided elsewhere"', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    const live = { bytes: bytes('os/agents/index.html') + 7 };
    await fakeLiveCopy(page, PAGE, live);
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    for (const i of [0, 1]) await page.locator('.apv-card').nth(i).locator('[data-apv-pick]').check();
    const reloaded = page.waitForEvent('load', { timeout: 15000 });
    await page.locator('[data-apv-bulk-approve]').click();
    await expect(page.locator('#toast')).toContainText('updated after you opened it, so nothing was saved');
    await expect(page.locator('#toast')).not.toContainText('decided elsewhere');
    live.bytes = bytes('os/agents/index.html');
    await reloaded;
    expect(patches).toHaveLength(0);
  });

  test('same as the live page: Approve saves as it always did', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    const heads = await fakeLiveCopy(page, PAGE, { bytes: bytes('os/agents/index.html') });
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator(`[data-apv-card="${ID}"]`);
    await expect(card).toBeVisible();
    await card.locator('button[data-apv-btn]', { hasText: /^Approve$/ }).click();
    await expect.poll(() => patches.filter((p) => p.id === ID).length).toBe(1);
    const p = patches.find((x) => x.id === ID).fields;
    expect(p.fldrHBSr6qoUfaKuZ).toBe('Approved as-is');
    expect(heads).toHaveLength(1);
  });
});

test.describe('Tasks drawer: an old tab saves nothing', () => {
  const PAGE = '/os/tasks/index.html';
  const TASKS_TABLE = 'tblqB8b22hKBL4PF1';
  const ID = 'recPlainApprovalA';
  const F = { name: 'fldgFjGBw6bTKJFCD', dueDate: 'fld7XP8w8kbxfETV4', status: 'fldx4qCw17UfrKpaN', agentOutput: 'fldzswp8fx6PqpLQ5' };

  async function mockAirtable(page) {
    const patches = [];
    await stubExternalHosts(page);
    await page.route('**/api.airtable.com/**', async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.includes('/comments')) return json(method === 'POST' ? { id: 'c1', text: '', createdTime: new Date().toISOString() } : { comments: [] });
      if (method === 'PATCH') { patches.push(url); return json({ id: ID, fields: {} }); }
      if (url.includes(TASKS_TABLE)) return json({ records: [{ id: ID, createdTime: new Date().toISOString(), fields: {
        [F.name]: 'Reply to the Example Lane tenant', [F.status]: 'Approval', [F.dueDate]: localTodayISO(),
        [F.agentOutput]: 'Draft: thanks, we will confirm.' } }] });
      return json({ records: [] });
    });
    await page.addInitScript(() => {
      localStorage.setItem('_dlr_pat', 'pat_test_mock_token_for_playwright');
      localStorage.setItem('_task_user', JSON.stringify({ key: 'kevin', name: 'Kevin Brittain', email: 'kevin@runpreneur.org.uk' }));
    });
    return patches;
  }

  test('older than the live page: apvDecide writes nothing, reloads, and the note is back in that task\'s box', async ({ page }) => {
    const patches = await mockAirtable(page);
    const live = { bytes: bytes('os/tasks/index.html') + 3 };
    await fakeLiveCopy(page, PAGE, live);
    await page.goto(PAGE);
    await page.waitForFunction((id) => typeof allTasks !== 'undefined' && allTasks.some((t) => t.id === id), ID, { timeout: 20000 });
    await page.evaluate((id) => openTaskDrawer(id), ID);
    await page.locator('#apvNote').fill('Keep it short.');
    const reloaded = page.waitForEvent('load', { timeout: 15000 });
    await page.evaluate((id) => apvDecide(id, 'Approved with minor edits', false), ID);
    await expect(page.locator('#toast')).toContainText('updated after you opened it, so nothing was saved');
    live.bytes = bytes('os/tasks/index.html');
    await reloaded;
    expect(patches.filter((u) => u.includes(ID))).toHaveLength(0);
    await page.waitForFunction((id) => typeof allTasks !== 'undefined' && allTasks.some((t) => t.id === id), ID, { timeout: 20000 });
    const html = await page.evaluate((id) => renderApprovalBlock(findTaskAnywhere(id)), ID);
    expect(html).toContain('>Keep it short.</textarea>');
  });
});
