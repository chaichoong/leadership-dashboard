// Invariant: Home (Kevin, 29 Sep 2026; rebuilt 14 Oct 2026 to the plan he approved on 9 Oct, task
// recwJcP4xIgAeR723) is ONE scroll of the real pages, nothing copied: the approval queue, then the CEO
// brief (the AI Agents page itself in its Home mode, os/agents/index.html?home=1), then the Leadership
// Dashboard and Wealth panels (shown by body.home-mode, Wealth drawn only when scrolled to). The app
// opens on Home; a link that names a page still opens that page; leaving Home puts the shell back.
// The queue runs twice (Home and the AI Agents tab), so a task write in either copy makes the other
// re-read it (Kevin, 9 Oct: "all of the information on the Home page synced"). The review of
// 14 Oct found dialogs and toasts opening off-screen inside the tall frame, a frame that could not
// shrink, a Home copy loading behind the sign-in screen and a deep link it swallowed: each is a test.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, setupMockAirtable } = require('./helpers');

async function open(page, hash, opts = {}) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript((pat) => {
    if (pat) localStorage.setItem('_dlr_pat', pat); else localStorage.removeItem('_dlr_pat');
    try { indexedDB.deleteDatabase('_dlr_cache'); } catch {}
    // Every message the shell receives, by type, for the deep-link check.
    window.__shellMessages = [];
    window.addEventListener('message', e => { if (e.data && e.data.type) window.__shellMessages.push(e.data.type); });
    // When the Wealth panel first gets any content.
    document.addEventListener('DOMContentLoaded', () => {
      const w = document.getElementById('tab-wealth');
      window.__wealthDrawnAt = 0;
      if (w) new MutationObserver(() => { if (!window.__wealthDrawnAt && w.childElementCount) window.__wealthDrawnAt = Date.now(); })
        .observe(w, { childList: true });
    });
  }, opts.signedOut ? '' : MOCK_PAT);
  await setupMockAirtable(page);
  await page.goto('/' + (hash ? '#' + hash : ''));
  await page.waitForFunction(() => {
    const dash = document.getElementById('dashboard');
    const auth = document.getElementById('authScreen');
    return (dash && dash.style.display !== 'none') || (auth && auth.style.display !== 'none');
  }, { timeout: 20000 }).catch(() => {});
  return errors;
}
const shown = (page, id) => page.evaluate(i => getComputedStyle(document.getElementById(i)).display !== 'none', id);
const homeFrame = page => page.frameLocator('#homeAgentsFrame');
// Ready = the Home copy said so (its status line hides) and its queue has finished reading.
async function waitForHomeFrame(page) {
  await page.waitForFunction(() => {
    const f = document.getElementById('homeAgentsFrame');
    const d = f && f.contentDocument;
    return d && document.getElementById('homeAgentsStatus').hidden
      && d.getElementById('approvalsBody') && !d.querySelector('#approvalsBody .zone-loading');
  }, { timeout: 20000 });
}

test.describe('Home: one scroll of the real pages', () => {
  test('the app opens on Home, with the dashboard and Wealth underneath', async ({ page }) => {
    const errors = await open(page, '');
    await page.waitForFunction(() => location.hash === '#home', { timeout: 15000 });
    expect(await page.evaluate(() => document.getElementById('tab-home').classList.contains('active'))).toBe(true);
    expect(await page.evaluate(() => document.body.classList.contains('home-mode'))).toBe(true);
    for (const id of ['tab-home', 'tab-overview', 'tab-wealth', 'homeWealthDivider']) expect(await shown(page, id), id).toBe(true);
    const order = await page.evaluate(() => ['tab-home', 'tab-overview', 'homeWealthDivider', 'tab-wealth']
      .map(id => document.getElementById(id).getBoundingClientRect().top + window.scrollY));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(await page.locator('#homeList').count(), 'the old task list is gone').toBe(0);
    expect(errors.filter(e => !/net::ERR|Failed to fetch|NetworkError/.test(e))).toEqual([]);
  });

  test('approvals then the CEO brief come from the AI Agents page in Home mode', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    expect(await page.getAttribute('#homeAgentsFrame', 'src')).toMatch(/^os\/agents\/index\.html\?home=1&cb=\d+$/);
    const f = homeFrame(page);
    await expect(f.locator('.page-tabs')).toBeHidden();
    await expect(f.locator('#topbar')).toBeHidden();
    await expect(f.locator('#zoneApprovals')).toBeVisible();
    await expect(f.locator('#zoneCeoBrief')).toBeVisible();
    await expect(f.locator('#zoneRegister')).toBeHidden();
    await expect(f.locator('#view-checks')).toBeHidden();
    const tops = await page.evaluate(() => {
      const d = document.getElementById('homeAgentsFrame').contentDocument;
      return [d.getElementById('zoneApprovals').getBoundingClientRect().top, d.getElementById('zoneCeoBrief').getBoundingClientRect().top];
    });
    expect(tops[0], 'approvals sit above the CEO brief').toBeLessThan(tops[1]);
  });

  test('the frame grows and shrinks with its content, so Home never has a second scroll bar', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    const frameH = () => page.evaluate(() => Math.round(document.getElementById('homeAgentsFrame').getBoundingClientRect().height));
    const before = await frameH();
    await page.evaluate(() => {
      const d = document.getElementById('homeAgentsFrame').contentDocument;
      const tall = d.createElement('div'); tall.id = 'specTall'; tall.style.height = '3000px';
      d.getElementById('zoneApprovals').appendChild(tall);
    });
    await page.waitForFunction(b => document.getElementById('homeAgentsFrame').getBoundingClientRect().height > b + 2500, before, { timeout: 5000 });
    await page.evaluate(() => document.getElementById('homeAgentsFrame').contentDocument.getElementById('specTall').remove());
    await page.waitForFunction(b => Math.abs(document.getElementById('homeAgentsFrame').getBoundingClientRect().height - b) <= 4, before, { timeout: 5000 });
  });

  test('a toast and a dialog inside the frame open where Kevin is looking, not at the frame\'s far end', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    await page.evaluate(() => {
      const d = document.getElementById('homeAgentsFrame').contentDocument;
      const tall = d.createElement('div'); tall.style.height = '4000px';
      d.getElementById('zoneApprovals').appendChild(tall);
    });
    await page.waitForFunction(() => document.getElementById('homeAgentsFrame').getBoundingClientRect().height > 4000, null, { timeout: 5000 });
    // Scroll to the middle of the frame.
    await page.evaluate(() => { const r = document.getElementById('homeAgentsFrame').getBoundingClientRect(); window.scrollTo(0, window.scrollY + r.top + 1800); });
    await page.waitForTimeout(400);
    const inView = await page.evaluate(() => {
      const f = document.getElementById('homeAgentsFrame'), w = f.contentWindow, d = f.contentDocument;
      w.toast('Saved');
      const ov = d.createElement('div'); ov.className = 'modal-overlay'; d.body.appendChild(ov);
      const fr = f.getBoundingClientRect();
      const t = d.querySelector('.toast').getBoundingClientRect(), o = ov.getBoundingClientRect();
      return { toastTop: fr.top + t.top, overlayTop: fr.top + o.top, overlayBottom: fr.top + o.bottom, vh: window.innerHeight };
    });
    expect(inView.toastTop).toBeGreaterThan(0);
    expect(inView.toastTop).toBeLessThan(inView.vh);
    expect(inView.overlayTop).toBeGreaterThanOrEqual(-2);
    expect(inView.overlayBottom).toBeLessThanOrEqual(inView.vh + 2);
  });

  test('Wealth is not drawn until it is scrolled into view', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__wealthDrawnAt), 'drawn before any scroll').toBe(0);
    await page.locator('#homeWealthDivider').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => window.__wealthDrawnAt > 0, { timeout: 10000 });
  });

  test('signed out, Home loads no approvals frame behind the sign-in screen, even past its 20-second fallback', async ({ page }) => {
    await page.clock.install();
    await open(page, '', { signedOut: true });
    await page.clock.fastForward(25000);   // past the 20-second "dashboard never finished" fallback
    await page.waitForTimeout(300);
    expect(await page.getAttribute('#homeAgentsFrame', 'src')).toBe('');
  });

  test('Refresh and reopening never reload the Home copy (a note being typed would be lost): they ask it to re-read', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    await page.evaluate(() => {
      const w = document.getElementById('homeAgentsFrame').contentWindow;
      w.__sameCopy = true;
      w.__fromHome = [];
      w.addEventListener('message', e => { if (e.data && e.data.source === 'home-shell') w.__fromHome.push(e.data.type); });
      const t = w.document.createElement('textarea'); t.id = 'specNote'; t.value = 'half-typed note';
      w.document.getElementById('approvalsBody').appendChild(t);
    });
    await page.locator('[data-sync-bar="home"] button', { hasText: 'Refresh' }).click();
    await page.waitForFunction(() => document.getElementById('homeAgentsFrame').contentWindow.__fromHome.includes('homeRefresh'), { timeout: 5000 });
    await page.evaluate(() => switchTab('overview'));
    await page.evaluate(() => switchTab('home'));
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => {
      const w = document.getElementById('homeAgentsFrame').contentWindow;
      return { same: w.__sameCopy === true, note: (w.document.getElementById('specNote') || {}).value };
    });
    expect(after).toEqual({ same: true, note: 'half-typed note' });
  });

  test('each copy keeps its own carried-over notes, so a reload of one never hands its notes to the other', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    await page.evaluate(() => switchTab('agents'));
    await page.waitForFunction(() => { const f = document.getElementById('agentsFrame'); return f && f.contentWindow && typeof f.contentWindow.apvSilentRefresh === 'function'; }, { timeout: 20000 });
    const keys = await page.evaluate(() => ['homeAgentsFrame', 'agentsFrame'].map(id => document.getElementById(id).contentWindow.eval('APV_DRAFT_CARRY')));
    expect(keys).toEqual(['apv_drafts_over_reload:home', 'apv_drafts_over_reload']);
  });

  test('a read dropped because a write landed during it is read again, never left stale', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    await page.evaluate(() => {
      const w = document.getElementById('homeAgentsFrame').contentWindow;
      w.__loads = 0;
      const load = w.loadApprovals;
      w.loadApprovals = function () { w.__loads++; return load.apply(this, arguments); };
      let bumped = false;
      const read = w.atFetch;
      // The first read sees a write land mid-flight (what a knock-back or Undo does), so it is dropped.
      w.atFetch = function () { if (!bumped) { bumped = true; w.eval('_apvQueueEpoch++'); } return read.apply(this, arguments); };
      w.eval('apvRereadQueue()');
    });
    await page.waitForFunction(() => document.getElementById('homeAgentsFrame').contentWindow.__loads >= 2, { timeout: 8000 });
  });

  test('a change announced while a read is running waits for it, then reads again', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    await page.evaluate(() => {
      const w = document.getElementById('homeAgentsFrame').contentWindow;
      w.__rereads = 0;
      const orig = w.apvSilentRefresh;
      w.apvSilentRefresh = function () { w.__rereads++; return orig.apply(this, arguments); };
      w.eval("_approvalsState = 'loading'; apvRereadQueue();");
    });
    await page.waitForTimeout(3000);
    expect(await page.evaluate(() => document.getElementById('homeAgentsFrame').contentWindow.__rereads), 'no re-read while a read runs').toBe(0);
    await page.evaluate(() => document.getElementById('homeAgentsFrame').contentWindow.eval("_approvalsState = 'ready';"));
    await page.waitForFunction(() => document.getElementById('homeAgentsFrame').contentWindow.__rereads > 0, { timeout: 5000 });
  });

  test('the Home copy never takes part in the AI Agents deep-link handshake', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    expect(await page.evaluate(() => window.__shellMessages.includes('agentsPageReady'))).toBe(false);
  });

  test('a link that names a page still opens that page, and leaving Home puts the shell back', async ({ page }) => {
    await open(page, 'overview');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.body.classList.contains('home-mode'))).toBe(false);
    expect(await shown(page, 'tab-home')).toBe(false);
    expect(await shown(page, 'tab-wealth')).toBe(false);
    await page.evaluate(() => switchTab('home'));
    await page.waitForTimeout(200);
    expect(await shown(page, 'tab-wealth')).toBe(true);
    await page.evaluate(() => switchTab('invoices'));
    await page.waitForTimeout(200);
    for (const id of ['tab-home', 'tab-overview', 'tab-wealth', 'homeWealthDivider']) expect(await shown(page, id), id).toBe(false);
  });

  test('a task written in either copy of the queue makes the other copy re-read it', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    await page.evaluate(() => switchTab('agents'));
    await page.waitForFunction(() => {
      const f = document.getElementById('agentsFrame');
      const d = f && f.contentDocument;
      return d && typeof f.contentWindow.apvSilentRefresh === 'function' && d.getElementById('main') && getComputedStyle(d.getElementById('main')).display !== 'none';
    }, { timeout: 20000 });
    const spy = id => page.evaluate((frameId) => {
      const w = document.getElementById(frameId).contentWindow;
      w.__rereads = 0;
      const orig = w.apvSilentRefresh;
      w.apvSilentRefresh = function () { w.__rereads++; return orig.apply(this, arguments); };
    }, id);
    await spy('agentsFrame');
    await spy('homeAgentsFrame');
    // A real write through each copy's own atUpdate (the mock answers the PATCH).
    await page.evaluate(() => document.getElementById('homeAgentsFrame').contentWindow.eval("atUpdate(TASKS_TBL, 'recHomeSyncSpec01', {})"));
    await page.waitForFunction(() => document.getElementById('agentsFrame').contentWindow.__rereads > 0, { timeout: 5000 });
    // The other way round: Home is hidden while the AI Agents tab is open, so its copy marks itself due
    // and re-reads only once Home is shown again (no reads from a copy nobody can see).
    await page.evaluate(() => document.getElementById('agentsFrame').contentWindow.eval("atUpdate(TASKS_TBL, 'recHomeSyncSpec02', {})"));
    await page.waitForTimeout(3000);
    expect(await page.evaluate(() => document.getElementById('homeAgentsFrame').contentWindow.__rereads), 'no read while hidden').toBe(0);
    await page.evaluate(() => switchTab('home'));
    await page.waitForFunction(() => document.getElementById('homeAgentsFrame').contentWindow.__rereads > 0, { timeout: 5000 });
  });
});
