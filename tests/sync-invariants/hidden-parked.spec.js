// Invariant: the parked and duplicate screens hidden on 30 Sep 2026 (MASTER-PLAN §4 Hide; brain
// Decisions/2026-09-29 Home screen is one list) are HIDDEN, NOT DELETED. Each stays reachable by
// its direct link, so bringing one back is removing a display:none, and the dead invoice email
// sync is no longer fired on every dashboard load.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, loadDashboard, setupMockAirtable } = require('./helpers');

const hidden = (page, sel) => page.evaluate(s => {
  const el = document.querySelector(s);
  return el ? getComputedStyle(el).display === 'none' : 'missing';
}, sel);

async function openOsPage(page, path) {
  await page.addInitScript((pat) => {
    localStorage.setItem('_dlr_pat', pat);
    localStorage.setItem('_task_user', JSON.stringify({ key: 'kevin', name: 'Kevin Brittain', email: 'kevinbrittain@gmail.com' }));
  }, MOCK_PAT);
  await setupMockAirtable(page);
  await page.goto(path);
  await page.waitForTimeout(2500);
}

test.describe('Parked screens are hidden, not deleted', () => {
  test('a cold #prospecting link still opens the hidden tab', async ({ page }) => {
    await loadDashboard(page, 'prospecting');
    expect(await page.evaluate(() => document.getElementById('tab-prospecting').classList.contains('active'))).toBe(true);
  });

  test('Tasks: the duplicate Approvals view is hidden, the AI Agents view (Add agent) stays', async ({ page }) => {
    await openOsPage(page, '/os/tasks/index.html');
    expect(await hidden(page, '.view-tab[data-view="approvals"]')).toBe(true);
    expect(await hidden(page, '.view-tab[data-view="agents"]')).toBe(false);
  });

  test('Operations Customers demo and the Systemisation pointer are hidden', async ({ page }) => {
    await openOsPage(page, '/os/operations/index.html');
    expect(await hidden(page, '.view-tab[data-tab="customers"]')).toBe(true);
    await page.goto('/os/systemisation/index.html');
    await page.waitForTimeout(1500);
    expect(await hidden(page, '.pipeline-tab[data-tab="automation"]')).toBe(true);
  });

  test('AI Agents: the Recording brief is hidden and not read', async ({ page }) => {
    const briefReads = [];
    // The brief is the only read of the Content Machine table (CM_TBL) on this page.
    page.on('request', r => { if (/api\.airtable\.com\/v0\/[^/]+\/tblEPzZdwBZeSXFRB/.test(r.url())) briefReads.push(r.url()); });
    await openOsPage(page, '/os/agents/index.html');
    expect(await hidden(page, '#zoneRecordingBrief')).toBe(true);
    expect(briefReads).toEqual([]);
  });

  test('Prospecting and KPI Library are out of the sidebar but still open by link', async ({ page }) => {
    await loadDashboard(page);
    expect(await hidden(page, `.sidebar-item[onclick="switchTab('prospecting')"]`)).toBe(true);
    expect(await hidden(page, `.sidebar-item[onclick="switchTab('kpi-library')"]`)).toBe(true);
    for (const tab of ['prospecting', 'kpi-library']) {
      await page.evaluate(t => switchTab(t), tab);
      await page.waitForTimeout(200);
      expect(await page.evaluate(t => document.getElementById('tab-' + t).classList.contains('active'), tab)).toBe(true);
    }
  });

  test('the Backfill tool and the old explainer buttons are hidden, and still in the page', async ({ page }) => {
    await loadDashboard(page);
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('costsBackfillBtn').closest('.section')).display)).toBe('none');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('a[href="architecture.html"]').parentElement).display)).toBe('none');
  });

  test('a dashboard load no longer fires the dead invoice email sync', async ({ page }) => {
    const calls = [];
    page.on('request', r => { if (/script\.google\.com/.test(r.url())) calls.push(r.url()); });
    await loadDashboard(page);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => GMAIL_SCRIPT_URL)).toBe('');
    expect(calls).toEqual([]);
  });
});
