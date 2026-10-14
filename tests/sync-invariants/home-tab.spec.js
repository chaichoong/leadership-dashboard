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

  test('in a hidden tab (no animation frames) the frame still grows to its content', async ({ page }) => {
    await page.addInitScript(() => { if (window !== window.top) window.requestAnimationFrame = () => 1; });
    await open(page, 'home');
    await waitForHomeFrame(page);
    await page.evaluate(() => {
      const d = document.getElementById('homeAgentsFrame').contentDocument;
      const tall = d.createElement('div'); tall.style.height = '3000px';
      d.getElementById('zoneApprovals').appendChild(tall);
    });
    await page.waitForFunction(() => document.getElementById('homeAgentsFrame').getBoundingClientRect().height > 3000, null, { timeout: 5000 });
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

  test('each section folds from its header, and stays folded after a reload', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    const f = homeFrame(page);
    const frameH = () => page.evaluate(() => Math.round(document.getElementById('homeAgentsFrame').getBoundingClientRect().height));
    const tall = await frameH();
    // Inside the approvals frame: sign-ins, approvals and the brief fold by their own headers.
    for (const zone of ['zoneSignins', 'zoneApprovals', 'zoneCeoBrief']) {
      await f.locator(`#${zone} > .zone-header.home-fold`).click();
      await expect(f.locator(`#${zone}`)).toHaveClass(/home-collapsed/);
      await expect(f.locator(`#${zone} .home-fold-toggle`)).toHaveAttribute('aria-expanded', 'false');
    }
    await expect(f.locator('#approvalsBody')).toBeHidden();
    await page.waitForFunction(t => document.getElementById('homeAgentsFrame').getBoundingClientRect().height < t, tall, { timeout: 5000 });
    // On Home itself: the dashboard and Wealth fold by theirs.
    await page.locator('[data-home-fold="dashboard"]').click();
    await page.locator('[data-home-fold="wealth"]').click();
    expect(await shown(page, 'tab-overview')).toBe(false);
    expect(await shown(page, 'tab-wealth')).toBe(false);
    // Reload: everything comes back folded.
    await page.reload();
    await waitForHomeFrame(page);
    for (const zone of ['zoneSignins', 'zoneApprovals', 'zoneCeoBrief']) await expect(homeFrame(page).locator(`#${zone}`)).toHaveClass(/home-collapsed/);
    expect(await shown(page, 'tab-overview')).toBe(false);
    expect(await shown(page, 'tab-wealth')).toBe(false);
    // And unfolds again.
    await homeFrame(page).locator('#zoneApprovals > .zone-header.home-fold').click();
    await expect(homeFrame(page).locator('#approvalsBody')).toBeVisible();
    await page.locator('[data-home-fold="dashboard"]').click();
    expect(await shown(page, 'tab-overview')).toBe(true);
  });

  test('a folded Wealth is never drawn, even scrolled to, and is drawn when unfolded', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('od_home_folded', JSON.stringify({ wealth: true })); } catch (e) {} });
    await open(page, 'home');
    await waitForHomeFrame(page);
    await page.locator('#homeWealthDivider').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__wealthDrawnAt), 'drawn while folded').toBe(0);
    await page.locator('[data-home-fold="wealth"]').click();
    await page.waitForFunction(() => window.__wealthDrawnAt > 0, { timeout: 10000 });
  });

  // Review, 14 Oct 2026: with the dashboard folded, Wealth's heading sat near the top while the frame
  // was still at its first 600px, so Wealth drew at load.
  test('with the dashboard folded, Wealth still waits until it is scrolled to', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('od_home_folded', JSON.stringify({ dashboard: true })); } catch (e) {}
      // A queue of cards a few screens tall, as Kevin's is, so Wealth's heading is far below once the frame is in.
      if (window !== window.top) document.addEventListener('DOMContentLoaded', () => {
        const tall = document.createElement('div'); tall.style.height = '3000px';
        document.getElementById('zoneApprovals').appendChild(tall);
      });
      // The reload below is slow, as a real one is, so its short loading screen is on show for a while.
      if (window !== window.top && localStorage.getItem('__specSlowFrame')) {
        const real = window.fetch; window.fetch = (...a) => new Promise(r => setTimeout(r, 3000)).then(() => real(...a));
      }
    });
    await open(page, 'home');
    await waitForHomeFrame(page);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__wealthDrawnAt), 'drawn at load').toBe(0);
    // A new version reloads the Home copy: its loading screen is short, which must not count as "near".
    await page.evaluate(() => { localStorage.setItem('__specSlowFrame', '1'); document.getElementById('homeAgentsFrame').contentWindow.location.reload(); });
    await page.waitForFunction(() => window.__shellMessages.filter(t => t === 'agentsHomeReady').length >= 2, null, { timeout: 20000 });
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__wealthDrawnAt), 'drawn during the reload').toBe(0);
    await page.locator('#homeWealthDivider').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => window.__wealthDrawnAt > 0, { timeout: 10000 });
  });

  test('Wealth scrolled to while the approvals load says why it is empty, then draws', async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('od_home_folded', JSON.stringify({ dashboard: true })); } catch (e) {}
      // A slow Home copy: every read it makes waits 3 seconds.
      if (window !== window.top) { const real = window.fetch; window.fetch = (...a) => new Promise(r => setTimeout(r, 3000)).then(() => real(...a)); }
    });
    await open(page, 'home');
    await expect(page.locator('#homeWealthWait')).toBeVisible();
    expect(await page.evaluate(() => window.__wealthDrawnAt), 'drawn before the approvals').toBe(0);
    await page.waitForFunction(() => window.__wealthDrawnAt > 0, { timeout: 30000 });
    await expect(page.locator('#homeWealthWait')).toBeHidden();
  });

  test('a section folds from its arrow button with Enter and Space, named by its title', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    const f = homeFrame(page);
    const btn = f.locator('#zoneApprovals .home-fold-toggle');
    await expect(btn).toHaveAccessibleName('Waiting for your approval');
    await btn.focus();
    await page.keyboard.press('Enter');
    await expect(f.locator('#zoneApprovals')).toHaveClass(/home-collapsed/);
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Space');
    await expect(f.locator('#zoneApprovals')).not.toHaveClass(/home-collapsed/);
    // The sign-ins status line is never inside a button (it would be read out as the button's name)
    // and still speaks while its section is folded.
    await f.locator('#zoneSignins > .zone-header').click();
    await expect(f.locator('#zoneSignins')).toHaveClass(/home-collapsed/);
    const live = await f.locator('#signinsLive').evaluate(el => ({ inButton: !!el.closest('button,[role="button"]'), display: getComputedStyle(el).display }));
    expect(live).toEqual({ inButton: false, display: expect.not.stringMatching(/^none$/) });
  });

  test('the AI Agents tab itself has no fold arrows: folding is Home only', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    await page.evaluate(() => switchTab('agents'));
    await page.waitForFunction(() => { const f = document.getElementById('agentsFrame'); const d = f && f.contentDocument; return d && d.getElementById('approvalsBody') && !d.querySelector('#approvalsBody .zone-loading'); }, null, { timeout: 20000 });
    const a = page.frameLocator('#agentsFrame');
    await expect(a.locator('.home-fold-toggle')).toHaveCount(0);
    await expect(a.locator('.zone-header.home-fold')).toHaveCount(0);
    await expect(a.locator('#zoneSignins > .zone-header > #signinsLive')).toHaveCount(1);
  });


  test('the CEO brief shows one title on Home, the one it folds by', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    const f = homeFrame(page);
    await expect(f.getByRole('heading', { name: 'CEO brief', exact: true })).toBeVisible();
    await expect(f.locator('#zoneCeoBrief > .zone-header .zone-title')).toHaveText('CEO brief');
    await expect(f.locator('#ceoBriefBody h2')).toHaveCount(1);
    await expect(f.locator('#ceoBriefBody h2')).toBeHidden();
  });

  test('folding the approvals clears ticked cards, so hidden ticks never hold off a new version', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    const fr = page.frame({ url: /home=1/ });
    // A ticked card makes the copy "busy", which holds off the reload a new version needs.
    expect(await fr.evaluate(() => { _apvSelected.add('recSpecTicked'); return apvBusy(); })).toBe(true);
    await homeFrame(page).locator('#zoneApprovals > .zone-header.home-fold').click();
    await expect(homeFrame(page).locator('#zoneApprovals')).toHaveClass(/home-collapsed/);
    expect(await fr.evaluate(() => ({ ticked: _apvSelected.size, busy: apvBusy() }))).toEqual({ ticked: 0, busy: false });
  });

  test('Wealth is not drawn until it is scrolled into view', async ({ page }) => {
    await open(page, 'home');
    await waitForHomeFrame(page);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__wealthDrawnAt), 'drawn before any scroll').toBe(0);
    await page.locator('#homeWealthDivider').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => window.__wealthDrawnAt > 0, { timeout: 10000 });
  });

  test('opened in a background tab, Home still loads the approvals, so they are ready when Kevin looks', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'hidden', configurable: true });
    });
    await open(page, '');
    await page.waitForFunction(() => /home=1/.test(document.getElementById('homeAgentsFrame').getAttribute('src') || ''), { timeout: 15000 });
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

  // Kevin, 14 Oct 2026: the sections inside the frame sat 138px further in than the dashboard and Wealth on
  // his 1,920px screen, and the three links at the top opened pages already in the sidebar. Now every
  // section shares one left and right edge, and a pinned row of five buttons jumps to each.
  test('on a wide screen every section starts and ends on the same edges', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await open(page, 'home');
    await waitForHomeFrame(page);
    const edges = await page.evaluate(() => {
      const f = document.getElementById('homeAgentsFrame'), d = f.contentDocument, fr = f.getBoundingClientRect();
      const own = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; };
      const inner = el => { const r = el.getBoundingClientRect(); return [Math.round(fr.left + r.left), Math.round(fr.left + r.right)]; };
      return {
        signins: inner(d.querySelector('#zoneSignins > .zone-header')),
        approvals: inner(d.querySelector('#zoneApprovals > .zone-header')),
        brief: inner(d.querySelector('#zoneCeoBrief > .zone-header')),
        dashboard: own(document.querySelector('#tab-home .home-dash-divider')),
        dashboardPanel: own(document.getElementById('tab-overview')),
        wealth: own(document.getElementById('homeWealthDivider')),
      };
    });
    for (const k of ['signins', 'approvals', 'brief', 'dashboardPanel', 'wealth']) expect(edges[k], k).toEqual(edges.dashboard);
  });

  async function settled(page) {
    let last = -1;
    for (let i = 0; i < 40; i++) {
      const y = await page.evaluate(() => window.scrollY);
      if (y === last) return y;
      last = y;
      await page.waitForTimeout(150);
    }
    return last;
  }
  async function tallHome(page, folded, opts = {}) {
    await page.addInitScript(({ st, slow }) => {
      try { if (st) localStorage.setItem('od_home_folded', JSON.stringify(st)); } catch (e) {}
      if (window !== window.top) {
        // A queue and a brief a few screens tall, as Kevin's are.
        document.addEventListener('DOMContentLoaded', () => {
          for (const id of ['zoneApprovals', 'zoneCeoBrief']) {
            const tall = document.createElement('div'); tall.style.height = '3000px';
            document.getElementById(id).appendChild(tall);
          }
        });
        if (slow) { const real = window.fetch; window.fetch = (...a) => new Promise(r => setTimeout(r, 3000)).then(() => real(...a)); }
      }
    }, { st: folded || null, slow: !!opts.slow });
    // Kevin's drawn Wealth is long; the fixture's is one line. Only DRAWN content is lengthened, so an
    // undrawn Wealth is still the empty panel a first jump meets.
    await page.addInitScript(() => {
      if (window === window.top) document.addEventListener('DOMContentLoaded', () => {
        const st = document.createElement('style'); st.textContent = '#tab-wealth > * { min-height: 2000px; }'; document.head.appendChild(st);
      });
    });
    await open(page, 'home');
    if (!opts.slow) await waitForHomeFrame(page);
  }
  // Where a section's heading sits on screen, against the bottom of the jump row.
  const headingTop = (page, key) => page.evaluate((k) => {
    const f = document.getElementById('homeAgentsFrame'), d = f.contentDocument;
    const inFrame = { signins: '#zoneSignins', approvals: '#zoneApprovals', brief: '#zoneCeoBrief' }[k];
    const top = inFrame ? f.getBoundingClientRect().top + d.querySelector(`${inFrame} > .zone-header`).getBoundingClientRect().top
      : (k === 'dashboard' ? document.querySelector('#tab-home .home-dash-divider') : document.getElementById('homeWealthDivider')).getBoundingClientRect().top;
    return { top: Math.round(top), barBottom: Math.round(document.getElementById('homeJump').getBoundingClientRect().bottom) };
  }, key);

  test('the jump row replaces the three page links, and each button lands its section just below the row', async ({ page }) => {
    await tallHome(page);
    await expect(page.locator('[data-home-tab]')).toHaveCount(0);
    await expect(page.locator('#homeJump button')).toHaveText(['Sign-ins', 'Approvals', 'CEO brief', 'Dashboard', 'Wealth']);
    for (const key of ['wealth', 'brief', 'dashboard', 'signins', 'approvals', 'wealth']) {
      await page.locator(`[data-home-jump="${key}"]`).click();
      await settled(page);
      const at = await headingTop(page, key);
      expect(at.top, `${key} heading under the row`).toBeGreaterThanOrEqual(at.barBottom - 1);
      expect(at.top, `${key} heading far below the row`).toBeLessThanOrEqual(at.barBottom + 40);
    }
  });

  test('a keyboard jump moves the keyboard to the section, and a control reached by Tab is never left under the row', async ({ page }) => {
    await tallHome(page);
    const press = async (key) => { await page.locator(`[data-home-jump="${key}"]`).focus(); await page.keyboard.press('Enter'); await settled(page); };
    await press('dashboard');
    expect(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-home-fold'))).toBe('dashboard');
    await press('approvals');
    expect(await page.frame({ url: /home=1/ }).evaluate(() => document.activeElement && document.activeElement.closest('.zone').id)).toBe('zoneApprovals');
    // A mouse jump leaves focus where it was.
    await page.locator('[data-home-jump="wealth"]').click();
    await settled(page);
    expect(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-home-jump'))).toBe('wealth');
    // The Dashboard heading parked under the pinned row, then reached by keyboard: it is scrolled clear.
    await page.evaluate(() => {
      const b = document.querySelector('[data-home-fold="dashboard"]');
      window.scrollTo(0, b.getBoundingClientRect().top + window.scrollY - 10);
    });
    await expect(page.locator('#homeJump')).toHaveClass(/home-jump-pinned/);
    await page.evaluate(() => { document.activeElement.blur(); document.querySelector('[data-home-fold="dashboard"]').focus(); });
    const at = await page.evaluate(() => ({ top: document.querySelector('[data-home-fold="dashboard"]').getBoundingClientRect().top,
      barBottom: document.getElementById('homeJump').getBoundingClientRect().bottom }));
    expect(at.top).toBeGreaterThanOrEqual(at.barBottom);
  });

  test('a jump made while the approvals load lands once they are in', async ({ page }) => {
    // Safari keeps no scroll anchor, so content growing above the screen throws the view; Chromium's
    // anchoring would hide the bug, so it is switched off here.
    await page.addInitScript(() => { if (window === window.top) document.addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style'); st.textContent = '* { overflow-anchor: none !important; }'; document.head.appendChild(st);
    }); });
    await tallHome(page, null, { slow: true });
    await page.locator('[data-home-jump="dashboard"]').click();
    await page.waitForFunction(() => window.__shellMessages.includes('agentsHomeReady'), null, { timeout: 30000 });
    await settled(page);
    const at = await headingTop(page, 'dashboard');
    expect(at.top).toBeGreaterThanOrEqual(at.barBottom - 1);
    expect(at.top).toBeLessThanOrEqual(at.barBottom + 40);
  });

  // Review, 14 Oct 2026: a jump waiting for the approvals to load must never pull Kevin back once he has
  // moved on, take the keyboard from where he is typing, or run on another page.
  test('a waiting jump never pulls Kevin back after he drags the page elsewhere', async ({ page }) => {
    await tallHome(page, null, { slow: true });
    await page.locator('[data-home-jump="signins"]').click();
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, 1500));   // a scroll bar drag: scrolling, and no wheel, key or touch
    await page.waitForFunction(() => window.__shellMessages.includes('agentsHomeReady'), null, { timeout: 30000 });
    await settled(page);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
  });

  test('a waiting jump never takes the keyboard from where Kevin is typing', async ({ page }) => {
    await tallHome(page, null, { slow: true });
    await page.locator('[data-home-jump="approvals"]').focus();
    await page.keyboard.press('Enter');
    await page.evaluate(() => { const i = document.createElement('input'); i.id = 'specTyping'; document.getElementById('tab-home').prepend(i); i.focus({ preventScroll: true }); });
    await page.waitForFunction(() => window.__shellMessages.includes('agentsHomeReady'), null, { timeout: 30000 });
    await settled(page);
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('specTyping');
  });

  test('a waiting jump is dropped when Kevin leaves Home', async ({ page }) => {
    await tallHome(page, { approvals: true }, { slow: true });
    await page.locator('[data-home-jump="approvals"]').click();
    await page.evaluate(() => switchTab('overview'));
    await page.waitForFunction(() => window.__shellMessages.includes('agentsHomeReady'), null, { timeout: 30000 });
    await page.waitForTimeout(1000);
    // Aimed again on another page, it would have opened the approvals (and saved that) out of sight.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('od_home_folded')).approvals)).toBe(true);
  });

  test('a jump to a folded section further down the frame lands on it', async ({ page }) => {
    await tallHome(page, { signins: true, approvals: true, brief: true, dashboard: true, wealth: true });
    await page.locator('[data-home-jump="brief"]').click();
    await settled(page);
    const at = await headingTop(page, 'brief');
    expect(at.top).toBeGreaterThanOrEqual(at.barBottom - 1);
    expect(at.top).toBeLessThanOrEqual(at.barBottom + 40);
  });

  test('a jump to a folded section opens it first', async ({ page }) => {
    await tallHome(page, { signins: true, approvals: true, brief: true, dashboard: true, wealth: true });
    const f = homeFrame(page);
    await page.locator('[data-home-jump="approvals"]').click();
    await expect(f.locator('#zoneApprovals')).not.toHaveClass(/home-collapsed/);
    await expect(f.locator('#zoneSignins')).toHaveClass(/home-collapsed/);
    await page.locator('[data-home-jump="brief"]').click();
    await expect(f.locator('#zoneCeoBrief')).not.toHaveClass(/home-collapsed/);
    await page.locator('[data-home-jump="dashboard"]').click();
    expect(await shown(page, 'tab-overview')).toBe(true);
    await page.locator('[data-home-jump="wealth"]').click();
    expect(await shown(page, 'tab-wealth')).toBe(true);
    await page.waitForFunction(() => window.__wealthDrawnAt > 0, { timeout: 10000 });
    // Opened by a jump is remembered, as opened by its arrow is.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('od_home_folded'))))
      .toEqual({ signins: true, approvals: false, brief: false, dashboard: false, wealth: false });
  });

  test('the row stays pinned while Home scrolls, and the queue\'s own pinned bars sit below it', async ({ page }) => {
    await tallHome(page);
    const bar = page.locator('#homeJump');
    await expect(bar).not.toHaveClass(/home-jump-pinned/);
    const slotH = await page.evaluate(() => document.getElementById('homeJumpSlot').offsetHeight);
    await page.evaluate(() => window.scrollTo(0, 1500));
    await expect(bar).toHaveClass(/home-jump-pinned/);
    const pinned = await page.evaluate(() => {
      const b = document.getElementById('homeJump').getBoundingClientRect(), slot = document.getElementById('homeJumpSlot');
      const f = document.getElementById('homeAgentsFrame'), fr = f.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), slotH: slot.offsetHeight, frameTop: fr.top };
    });
    expect(pinned.top).toBe(0);
    // It runs from the sidebar to the screen's edge, with its buttons still in line with the page.
    const span = await page.evaluate(() => {
      const b = document.getElementById('homeJump').getBoundingClientRect(), side = document.getElementById('sidebar').getBoundingClientRect();
      const btn = document.querySelector('.home-jump-btn').getBoundingClientRect(), title = document.querySelector('#tab-home .home-header h1').getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right), side: Math.round(side.right), vw: document.documentElement.clientWidth, btn: Math.round(btn.left), title: Math.round(title.left) };
    });
    expect([span.left, span.right, span.btn]).toEqual([span.side, span.vw, span.title]);
    expect(pinned.slotH, 'the page under the row did not move').toBe(slotH);
    // The frame is told its visible band starts under the row, so its sticky bars and dialogs never hide behind it.
    await page.waitForFunction((p) => {
      const d = document.getElementById('homeAgentsFrame').contentDocument;
      const visTop = parseFloat(d.documentElement.style.getPropertyValue('--home-vis-top')) || 0;
      return Math.abs(visTop - (p.bottom - p.frameTop)) <= 2;
    }, pinned, { timeout: 5000 });
    // Further down, over the dashboard and Wealth, it is still there; back at the top it rests in place.
    await page.evaluate(() => window.scrollTo(0, document.getElementById('homeWealthDivider').getBoundingClientRect().top + window.scrollY));
    await expect(bar).toHaveClass(/home-jump-pinned/);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(bar).not.toHaveClass(/home-jump-pinned/);
  });

  test('on a phone every button fits on screen, the pinned row starts clear of the menu button, and an open menu never squeezes it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await tallHome(page);
    const fits = () => page.evaluate(() => [...document.querySelectorAll('.home-jump-btn')].every(b => b.getBoundingClientRect().right <= document.documentElement.clientWidth));
    expect(await fits(), 'unpinned').toBe(true);
    await page.evaluate(() => window.scrollTo(0, 1500));
    await expect(page.locator('#homeJump')).toHaveClass(/home-jump-pinned/);
    expect(await fits(), 'pinned').toBe(true);
    const at = await page.evaluate(() => ({ menu: document.querySelector('.sidebar-toggle').getBoundingClientRect().right,
      btn: document.querySelector('.home-jump-btn').getBoundingClientRect().left, bar: document.getElementById('homeJump').getBoundingClientRect().left }));
    expect(at.bar).toBe(0);
    expect(at.btn).toBeGreaterThan(at.menu);
    // Scroll with the menu open, then close it: the row still spans the screen.
    await page.evaluate(() => toggleSidebar());
    await page.evaluate(() => window.scrollTo(0, 1600));
    await page.evaluate(() => toggleSidebar());
    await page.waitForTimeout(400);
    const span = await page.evaluate(() => { const b = document.getElementById('homeJump').getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width), document.documentElement.clientWidth]; });
    expect([span[0], span[1]]).toEqual([0, span[2]]);
  });
});
