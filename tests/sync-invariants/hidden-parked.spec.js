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

// Kevin, option A, 7 and 8 Oct 2026 (task recJpS8LUkvdRThaw; finding 20261009-agent-dispatch-814): the
// invoice Apps Script is retired from Inbound Comms as ONE change. Label 3 has had no mail since 17 Aug,
// yet applying it fired the script, and the health bar and the Run health check button pinged it. This
// drives the REAL page: Gmail is a stub (one invented thread), Airtable the usual fixtures, and every
// request to script.google.com is recorded. Both pages are driven: the live one and its parked twin.
for (const pagePath of ['/follow-up.html', '/follow-up-supabase.html']) {
  test.describe(`Inbound Comms (${pagePath}): the invoice Apps Script is retired`, () => {
    test('applying label 3 (move, inbox apply, bulk apply) and every health check make no Apps Script call', async ({ page }) => {
      const calls = [];
      page.on('request', r => { if (/script\.google\.com/.test(r.url())) calls.push(r.url()); });
      await page.addInitScript((pat) => { localStorage.setItem('_dlr_pat', pat); }, MOCK_PAT);
      // Google's sign-in and API loaders never load here, so the page's own gapi start-up never runs.
      await page.route('**/accounts.google.com/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
      await page.route('**/apis.google.com/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
      await setupMockAirtable(page);
      await page.goto(pagePath);
      await page.waitForTimeout(1500);

      const res = await page.evaluate(async () => {
        const out = { url: GMAIL_INVOICE_SCRIPT_URL };
        const labels = [{ id: 'L3', name: '3: to pay' }, { id: 'L12', name: '12: kevin to respond' }];
        const thread = { id: 't1', messages: [{ id: 'm1', threadId: 't1', labelIds: ['L12'], internalDate: '1791000000000', snippet: 'Invented',
          payload: { mimeType: 'text/plain', body: { data: '' }, headers: [
            { name: 'From', value: 'Invented Supplier <billing@example.test>' }, { name: 'To', value: 'inbox@example.test' },
            { name: 'Subject', value: 'Invented invoice 001' }, { name: 'Date', value: 'Thu, 8 Oct 2026 10:00:00 +0100' }] } }] };
        window.gapi = { client: { gmail: { users: {
          labels: { list: async () => ({ result: { labels } }) },
          messages: { list: async () => ({ result: { messages: [{ id: 'm1', threadId: 't1' }] } }),
                      modify: async () => ({ result: {} }), trash: async () => ({ result: {} }) },
          threads: { get: async () => ({ result: thread }) },
        } } } };
        // The passive health bar registers on a label load.
        allLabelsRaw = labels; currentLabel = '12: kevin to respond'; isInboxView = false;
        try { await loadEmails(); } catch (e) { out.loadError = String(e); }
        out.barChecks = (typeof _syncBars !== 'undefined' && _syncBars.comms) ? _syncBars.comms.checks.map(c => c.name) : null;
        if (out.barChecks) { try { await runHealthChecks('comms'); } catch (e) { out.barRunError = String(e); } }
        // 1. move a labelled email to label 3
        const email = () => ({ threadId: 't1', msgIds: ['m1'], subject: 'Invented invoice 001', from: 'billing@example.test', messages: thread.messages });
        allEmails = [email()]; labelChangeInProgress = false;
        try { await changeLabel(0, '3: to pay'); } catch (e) { out.moveError = String(e); }
        // 2. apply label 3 from the inbox, one email
        const pick = (i) => { const s = document.createElement('select'); s.id = 'inboxApply-' + i;
          const o = document.createElement('option'); o.value = '3: to pay'; o.textContent = '3: to pay'; s.appendChild(o); s.value = '3: to pay';
          document.body.appendChild(s); return s; };
        allEmails = [email()]; const one = pick(0);
        try { await applyInboxLabel(0); } catch (e) { out.applyError = String(e); }
        one.remove();
        // 3. bulk apply
        allEmails = [email()]; const bulk = pick(0);
        try { await applyAllInboxLabels(); } catch (e) { out.bulkError = String(e); }
        bulk.remove();
        // 4. the Run health check button
        const results = document.getElementById('healthCheckResults');
        try { await runHealthCheck(); } catch (e) { out.buttonError = String(e); }
        out.buttonText = results ? results.textContent : null;
        return out;
      });
      await page.waitForTimeout(2000);   // the old trigger waited 1.5 s before it fired

      expect(res.url).toBe('');
      // Controls: each label-3 path ran to the end, so a missing call means the call is gone.
      for (const k of ['loadError', 'moveError', 'applyError', 'bulkError', 'buttonError', 'barRunError']) expect(res[k], k).toBeUndefined();
      expect(res.barChecks, 'the passive health bar registered (control)').toBeTruthy();
      expect(res.barChecks).toContain('Claude AI proxy round-trip');
      expect(res.barChecks).not.toContain('Gmail Apps Script reachable');
      expect(res.buttonText, 'the Run health check button ran (control)').toMatch(/AI \(Claude\)/);
      expect(res.buttonText).not.toMatch(/Invoices \(Gmail sync\)/);
      expect(calls).toEqual([]);
    });
  });
}
