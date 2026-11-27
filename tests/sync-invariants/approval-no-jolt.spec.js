// NOTHING MOVES UNDER HIM (Kevin, 27 Nov 2026): "there's clearly a glitch there because it's
// resulted in me clicking approve on the wrong approval cards on a number of occasions."
//
// Measured on the page before the fix, with these fixtures:
//   - On Home, five seconds after an approval, the Saved strip folded and Home glided back to "the
//     next card" wherever he had gone: he scrolled 1,000px on to the next card and was pulled back
//     1,000px, a different card under his pointer. The Home copy never scrolls (Home does), so it
//     never saw him scroll.
//   - A new card arriving at the top of the queue moved the card he was reading 371px, on Home and
//     on the AI Agents tab.
//   - Where two cards met, the next card's buttons pinned to the foot of the screen under the end
//     of the one he was reading, with only 30px of the next card in view.
//   - Every card had two boxes that scrolled on their own (the work and the task it was given).
//
// The rules these tests hold:
//   1. The card at the top of what he can see stays exactly where it is on screen whatever changes
//      above it (a card arriving, a strip leaving).
//   2. The only move the page makes by itself is straight after he presses a button, at once, and
//      only if he has not scrolled, tapped, clicked or typed since.
//   3. A decided card's strip stays where it is until it is off the screen, then goes without
//      moving anything he can see.
//   4. No box inside a card scrolls; the page is the only thing that scrolls.
//   5. A row of buttons names its card, and pins only once its card's own work is on screen.
//
// Airtable is mocked. Every name here is invented.

const { test, expect } = require('@playwright/test');
const { TF, AGENT_B, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i} of the draft.`).join('\n');
function withMany(n = 10) {
  const fx = defaultFixtures();
  const now = new Date().toISOString();
  for (let i = 0; i < n; i++) fx.approvals.push({ id: 'recJolt' + i, createdTime: now, fields: {
    [TF.name]: 'Chase the plumber ' + i, [TF.status]: 'Approval', [TF.priority]: 'Medium',
    [TF.agentOutput]: `Draft ${i}:\n${LONG}\n\n**Carrying this out will involve:** sending this email to trade${i}@example.co.uk.`,
    [TF.description]: `The job ${i}:\n${LONG}`,
    [TF.sentForApprovalBy]: [AGENT_B], [TF.teamMember]: [AGENT_B], [TF.lmt]: now, [TF.taskType]: 'Correspondence',
  } });
  return fx;
}
function urgentArrival() {
  const now = new Date().toISOString();
  return { id: 'recJoltNew', createdTime: now, fields: {
    [TF.name]: 'A new urgent card', [TF.status]: 'Approval', [TF.priority]: 'Urgent',
    [TF.agentOutput]: 'Draft:\n' + Array.from({ length: 30 }, (_, i) => 'Urgent line ' + i).join('\n'),
    [TF.sentForApprovalBy]: [AGENT_B], [TF.teamMember]: [AGENT_B], [TF.lmt]: now, [TF.taskType]: 'Correspondence',
  } };
}

// The card under a fixed line on the screen (200px down: below Home's pinned row) and where its top is.
function eye(page, home) {
  return page.evaluate((home) => {
    const f = home ? document.getElementById('homeAgentsFrame') : null;
    const d = f ? f.contentDocument : document;
    const lineY = f ? 200 - f.getBoundingClientRect().top : 200;
    const card = Array.from(d.querySelectorAll('.apv-card')).find(c => { const r = c.getBoundingClientRect(); return r.height && r.top <= lineY && r.bottom > lineY; });
    return { id: card ? card.getAttribute('data-apv-card') : null, off: card ? Math.round(card.getBoundingClientRect().top - lineY) : null, scrollY: Math.round(window.scrollY) };
  }, home);
}
function expectSamePlace(a, b) {
  expect(b.id, 'the same card is under his eye').toBe(a.id);
  expect(Math.abs(b.off - a.off), `card ${a.id} stays where it was on screen`).toBeLessThanOrEqual(2);
}

async function openHome(page, fx) {
  await mockAgentsPage(page, fx);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#home');
  await page.waitForFunction((n) => {
    const f = document.getElementById('homeAgentsFrame');
    const d = f && f.contentDocument;
    return d && document.getElementById('homeAgentsStatus').hidden && d.querySelectorAll('#approvalsBody .apv-card').length >= n;
  }, fx.approvals.length, { timeout: 40000 });
  await page.waitForTimeout(800);   // the frame has its full height and Home has said where he is
  return page.frameLocator('#homeAgentsFrame');
}
async function openTab(page, fx) {
  const patches = await mockAgentsPage(page, fx);
  await page.setViewportSize({ width: 1280, height: 900 });
  await loadAgentsPage(page);
  await page.click('#ptab-approvals');
  await expect(page.locator('#view-approvals')).toBeVisible();
  return patches;
}
const approveBtn = (scope, id) => scope.locator(`[data-apv-card="${id}"] .apv-actions button`, { hasText: /^Approve$/ });
function inSixDays() {
  const d = new Date(); d.setDate(d.getDate() + 6);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function withKnockedBack(fx) {
  const now = new Date().toISOString();
  fx.deferred = [1, 2, 3].map(i => ({ id: 'recJoltLater' + i, createdTime: now, fields: {
    [TF.name]: 'Book the gas check ' + i, [TF.status]: 'Approval', [TF.agentOutput]: 'Draft: booking.',
    [TF.sentForApprovalBy]: [AGENT_B], [TF.teamMember]: [AGENT_B], [TF.deferredUntil]: inSixDays(), [TF.lmt]: now,
  } }));
  return fx;
}
// Each write takes a second and a half, as Airtable can.
async function slowSaves(page) {
  await page.route('**/api.airtable.com/**', async (route) => {
    if (route.request().method() === 'PATCH') await new Promise(r => setTimeout(r, 1500));
    return route.fallback();
  });
}

test.describe('a card arriving never moves the card he is reading', () => {
  for (const where of ['the AI Agents tab', 'Home']) {
    test(`on ${where}`, async ({ page }) => {
      const fx = withMany();
      const home = where === 'Home';
      const scope = home ? await openHome(page, fx) : (await openTab(page, fx), page);
      await scope.locator('[data-apv-card="recJolt3"]').scrollIntoViewIfNeeded();
      await page.mouse.move(640, 500);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(700);
      const before = await eye(page, home);
      expect(before.id).toBe('recJolt3');
      fx.approvals.unshift(urgentArrival());   // it sorts to the top, above everything he can see
      await page.evaluate((home) => (home ? document.getElementById('homeAgentsFrame').contentWindow : window).apvRereadQueue(), home);
      await expect(scope.locator('[data-apv-card="recJoltNew"]')).toHaveCount(1, { timeout: 8000 });
      await page.waitForTimeout(300);
      expectSamePlace(before, await eye(page, home));
    });
  }
});

test.describe('after a decision, nothing moves him except the one move straight after his press', () => {
  test('Home: he approves, scrolls on to another card, and is never pulled back (the Undo window and 3s after)', async ({ page }) => {
    const f = await openHome(page, withMany());
    await approveBtn(f, 'recJolt2').scrollIntoViewIfNeeded();
    await approveBtn(f, 'recJolt2').click();
    await expect(f.locator('[data-apv-card="recJolt2"] [data-apv-state="saved"]')).toBeVisible();
    await page.waitForTimeout(300);
    await page.mouse.move(640, 500);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 250); await page.waitForTimeout(60); }
    await page.waitForTimeout(500);
    const there = await eye(page, true);
    expect(there.id).not.toBe('recJolt2');
    // 8.5 seconds: past the five-second Undo window and three seconds more.
    for (let i = 0; i < 34; i++) {
      await page.waitForTimeout(250);
      expectSamePlace(there, await eye(page, true));
    }
  });

  test('Home: with no scrolling, one instant move puts the strip at the top and the next card under it, and nothing moves at five seconds', async ({ page }) => {
    const f = await openHome(page, withMany());
    await approveBtn(f, 'recJolt2').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.__ys = []; window.addEventListener('scroll', () => window.__ys.push(Math.round(scrollY)), { passive: true }); });
    await approveBtn(f, 'recJolt2').click();
    await expect(f.locator('[data-apv-card="recJolt2"] [data-apv-state="saved"]')).toBeVisible();
    await page.waitForTimeout(800);
    // A glide reports many positions on the way; an instant move reports one.
    const ys = await page.evaluate(() => [...new Set(window.__ys)]);
    expect(ys.length, `scroll positions during the move: ${ys.join(', ')}`).toBeLessThanOrEqual(1);
    const geo = await page.evaluate(() => {
      const fr = document.getElementById('homeAgentsFrame');
      const d = fr.contentDocument, top = fr.getBoundingClientRect().top;
      const box = id => { const r = d.querySelector(`[data-apv-card="${id}"]`).getBoundingClientRect(); return { top: r.top + top, bottom: r.bottom + top }; };
      const row = document.querySelector('.home-jump-pinned');
      return { strip: box('recJolt2'), next: box('recJolt3'), rowBottom: row ? row.getBoundingClientRect().bottom : 0 };
    });
    expect(geo.strip.top).toBeGreaterThanOrEqual(geo.rowBottom - 2);
    expect(geo.strip.top).toBeLessThan(geo.rowBottom + 40);
    expect(geo.next.top - geo.strip.bottom).toBeLessThanOrEqual(40);
    const settled = await eye(page, true);
    await page.waitForTimeout(6000);   // past the Undo window
    expectSamePlace(settled, await eye(page, true));
    await expect(f.locator('[data-apv-card="recJolt2"] [data-apv-state="saved"]')).toBeVisible();   // the strip stays on screen
    await expect(f.locator('[data-apv-card="recJolt2"] [data-apv-undo]')).toHaveCount(0);           // without its Undo
  });

  test('a slow save does not throw him once he has scrolled on to another card during it', async ({ page }) => {
    await openTab(page, withMany());
    await slowSaves(page);
    await approveBtn(page, 'recJolt2').scrollIntoViewIfNeeded();
    await approveBtn(page, 'recJolt2').click();
    await page.mouse.move(640, 500);
    for (let i = 0; i < 30 && (await eye(page, false)).id !== 'recJolt4'; i++) { await page.mouse.wheel(0, 250); await page.waitForTimeout(60); }
    await page.waitForTimeout(300);
    const there = await eye(page, false);
    expect(there.id).toBe('recJolt4');
    await expect(page.locator('[data-apv-card="recJolt2"] [data-apv-state="saved"]')).toHaveCount(1, { timeout: 8000 });
    await page.waitForTimeout(400);
    expectSamePlace(there, await eye(page, false));
  });

  test('a slow save that lands while he is still on that card puts its strip at the top, the next card under it', async ({ page }) => {
    await openTab(page, withMany());
    await slowSaves(page);
    // Reading the middle of the card, its buttons pinned at the foot of the screen.
    await page.locator('[data-apv-card="recJolt2"]').evaluate(c => window.scrollTo(0, c.getBoundingClientRect().top + window.pageYOffset + 300));
    await page.waitForTimeout(200);
    await approveBtn(page, 'recJolt2').click();
    await page.mouse.move(640, 500);
    await page.mouse.wheel(0, 120);   // a little, still in the card he decided
    await page.waitForTimeout(300);
    expect((await eye(page, false)).id).toBe('recJolt2');
    await expect(page.locator('[data-apv-card="recJolt2"] [data-apv-state="saved"]')).toBeVisible({ timeout: 8000 });
    await page.waitForTimeout(200);
    const g = await page.evaluate(() => {
      const r = id => document.querySelector(`[data-apv-card="${id}"]`).getBoundingClientRect();
      return { bar: document.querySelector('.topbar').getBoundingClientRect().bottom, strip: r('recJolt2'), next: r('recJolt3') };
    });
    expect(Math.abs(g.strip.top - g.bar)).toBeLessThanOrEqual(2);
    expect(g.next.top - g.strip.bottom).toBeLessThanOrEqual(40);
  });

  test('a slow save that lands once he is reading the next card leaves the next card where it is', async ({ page }) => {
    await openTab(page, withMany());
    await slowSaves(page);
    await page.locator('[data-apv-card="recJolt2"]').evaluate(c => window.scrollTo(0, c.getBoundingClientRect().top + window.pageYOffset + 300));
    await page.waitForTimeout(200);
    await approveBtn(page, 'recJolt2').click();
    // He scrolls on until the next card's header is under his eye, the decided card's foot still on screen.
    await page.locator('[data-apv-card="recJolt3"]').evaluate(c => window.scrollTo(0, c.getBoundingClientRect().top + window.pageYOffset - 150));
    await page.waitForTimeout(300);
    const there = await eye(page, false);
    expect(there.id).toBe('recJolt3');
    await expect(page.locator('[data-apv-card="recJolt2"] [data-apv-state="saved"]')).toHaveCount(1, { timeout: 8000 });
    await page.waitForTimeout(300);
    expectSamePlace(there, await eye(page, false));
  });

  test('a strip that has left the screen goes, and nothing he can see moves', async ({ page }) => {
    await openTab(page, withMany());
    await approveBtn(page, 'recJolt2').scrollIntoViewIfNeeded();
    await approveBtn(page, 'recJolt2').click();
    await expect(page.locator('[data-apv-card="recJolt2"] [data-apv-state="saved"]')).toBeVisible();
    await page.waitForTimeout(5600);   // the Undo window closes; the strip is on screen, so it stays
    await expect(page.locator('[data-apv-card="recJolt2"]')).toHaveCount(1);
    // He scrolls on, past the strip (one step, so it has stopped before the strip goes).
    await page.evaluate(() => window.scrollBy(0, 1000));
    await page.waitForTimeout(50);   // the strip is above the screen and not gone yet
    const before = await eye(page, false);
    await expect(page.locator('[data-apv-card="recJolt2"]')).toHaveCount(0, { timeout: 3000 });
    expectSamePlace(before, await eye(page, false));
  });
});

test.describe('a card reads as one card', () => {
  test('no box inside a card scrolls: the work and the task it was given show in full', async ({ page }) => {
    await openTab(page, withMany(3));
    const scrollers = await page.evaluate(() => Array.from(document.querySelectorAll('.apv-card *'))
      .filter(e => e.tagName !== 'TEXTAREA' && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 2)
      .map(e => e.className));
    expect(scrollers).toEqual([]);
    const work = page.locator('[data-apv-card="recJolt0"] [data-apv-work]');
    await expect(work).toContainText('Line 39 of the draft.');
    expect(await work.evaluate(e => e.scrollHeight - e.clientHeight)).toBeLessThanOrEqual(2);
  });

  test('each row of buttons names its card, and pins only once that card\'s own work is on screen', async ({ page }) => {
    await openTab(page, withMany(4));
    const labels = await page.evaluate(() => Array.from(document.querySelectorAll('.apv-card')).map(c =>
      [c.getAttribute('data-apv-card'), (c.querySelector('[data-apv-decide-for]') || {}).textContent || '']));
    for (const [id, label] of labels) expect(label, `card ${id}`).toMatch(/^Deciding: /);
    await expect(page.locator('[data-apv-card="recJolt1"] [data-apv-decide-for]')).toHaveText('Deciding: Chase the plumber 1');
    // Step the next card up from the foot of the screen: its buttons never sit over its own header.
    const card = page.locator('[data-apv-card="recJolt2"]');
    for (const showing of [40, 120, 200, 320, 480]) {
      await card.evaluate((c, s) => window.scrollTo(0, c.getBoundingClientRect().top + window.pageYOffset - innerHeight + s), showing);
      await page.waitForTimeout(80);
      const g = await card.evaluate((c) => {
        const r = (sel) => c.querySelector(sel).getBoundingClientRect();
        return { headerBottom: r('.apv-meta').bottom, buttonsTop: r('.apv-decide').top, vh: innerHeight };
      });
      if (g.buttonsTop < g.vh) expect(g.buttonsTop, `with ${showing}px of the card showing`).toBeGreaterThanOrEqual(g.headerBottom);
    }
  });
});

// The independent review of 27 Nov 2026 found each of these moving something on screen.
test.describe('the review round: his own changes, a knock-back, a bulk run, the brief', () => {
  test('a knock-back while he has scrolled on leaves the card he is reading where it is, though the knocked-back list above grows', async ({ page }) => {
    await openTab(page, withMany());
    await slowSaves(page);
    await page.locator('[data-apv-card="recJolt2"]').evaluate(c => window.scrollTo(0, c.getBoundingClientRect().top + window.pageYOffset + 300));
    await page.waitForTimeout(200);
    await page.locator('[data-apv-card="recJolt2"] .apv-defer-btn', { hasText: 'A week' }).first().click();
    await page.locator('[data-apv-card="recJolt4"]').evaluate(c => window.scrollTo(0, c.getBoundingClientRect().top + window.pageYOffset - 150));
    await page.waitForTimeout(300);
    const there = await eye(page, false);
    expect(there.id).toBe('recJolt4');
    await expect(page.locator('[data-apv-card="recJolt2"] [data-apv-state="saved"]')).toHaveCount(1, { timeout: 8000 });
    await expect(page.locator('[data-apv-later]')).toHaveCount(1);   // the list above was drawn
    await page.waitForTimeout(300);
    expectSamePlace(there, await eye(page, false));
  });

  test('a bulk run never lifts another card into the place of the one in front of him while it saves', async ({ page }) => {
    await openTab(page, withMany());
    await slowSaves(page);
    for (const id of ['recJolt2', 'recJolt3']) await page.locator(`[data-apv-card="${id}"] [data-apv-pick]`).check();
    await page.locator('[data-apv-card="recJolt2"]').evaluate(c => window.scrollTo(0, c.getBoundingClientRect().top + window.pageYOffset + 300));
    await page.waitForTimeout(200);
    await page.locator('[data-apv-bulk-approve]').click();
    // The first card saves; the second is still being written.
    await expect(page.locator('[data-apv-card="recJolt2"] [data-apv-state="saved"]')).toHaveCount(1, { timeout: 8000 });
    await page.waitForTimeout(150);
    const g = await page.evaluate(() => {
      const bar = document.querySelector('.topbar').getBoundingClientRect().bottom;
      const bulk = document.getElementById('apvBulk');
      const cover = bulk && bulk.classList.contains('on') ? bulk.getBoundingClientRect().height + 12 : 0;
      return { top: bar + cover, strip: document.querySelector('[data-apv-card="recJolt2"]').getBoundingClientRect().top };
    });
    // The card he was reading became its strip, at the top: not some other card lifted into view.
    expect(Math.abs(g.strip - g.top)).toBeLessThanOrEqual(2);
  });

  test('opening the knocked-back list above the cards leaves its heading where he clicked it', async ({ page }) => {
    await openTab(page, withKnockedBack(withMany()));
    const sum = page.locator('[data-apv-later] > summary');
    await sum.evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + window.pageYOffset - 350));
    await page.waitForTimeout(200);
    const before = (await sum.boundingBox()).y;
    await sum.click();
    await expect(page.locator('[data-apv-later]')).toHaveAttribute('open', '');
    await page.waitForTimeout(200);
    expect(Math.abs((await sum.boundingBox()).y - before)).toBeLessThanOrEqual(2);
  });

  test('pressing a decision on the card he is reading the middle of does not drop the line he is on while it saves', async ({ page }) => {
    await openTab(page, withMany());
    await slowSaves(page);
    await page.locator('[data-apv-card="recJolt2"]').evaluate(c => window.scrollTo(0, c.getBoundingClientRect().top + window.pageYOffset + 300));
    await page.waitForTimeout(200);
    const work = page.locator('[data-apv-card="recJolt2"] [data-apv-work]');
    const before = (await work.boundingBox()).y;
    await approveBtn(page, 'recJolt2').click();
    await expect(page.locator('[data-apv-card="recJolt2"] [data-apv-state="saving"]')).toBeVisible();
    await page.waitForTimeout(100);
    expect(Math.abs((await work.boundingBox()).y - before)).toBeLessThanOrEqual(2);
  });

  test('pressing the Approvals tab again goes back to the top', async ({ page }) => {
    await openTab(page, withMany());
    await page.evaluate(() => window.scrollTo(0, 2500));
    await page.waitForTimeout(200);
    await page.click('#ptab-approvals');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.pageYOffset)).toBe(0);
  });

  test('the pinned bulk bar opening a panel, or clearing, leaves the card he is reading where it is', async ({ page }) => {
    await openTab(page, withMany());
    for (const id of ['recJolt0', 'recJolt1']) await page.locator(`[data-apv-card="${id}"] [data-apv-pick]`).check();
    await page.locator('[data-apv-card="recJolt4"]').evaluate(c => window.scrollTo(0, c.getBoundingClientRect().top + window.pageYOffset - 120));
    await page.waitForTimeout(300);
    const before = await eye(page, false);
    expect(before.id).toBe('recJolt4');
    await page.locator('[data-apv-bulk-open="changes"]').click();
    await page.waitForTimeout(200);
    expectSamePlace(before, await eye(page, false));
    await page.locator('#apvBulk button', { hasText: /^Clear$/ }).click();
    await expect(page.locator('#apvBulk')).toBeHidden();
    await page.waitForTimeout(200);
    expectSamePlace(before, await eye(page, false));
  });

  test('Home: a bulk run started at the top still lands on its lowest card, though its first card\'s move pinned the jump row', async ({ page }) => {
    const fx = withMany(4);
    fx.approvals = fx.approvals.filter(r => r.id.startsWith('recJolt'));
    const f = await openHome(page, fx);
    await slowSaves(page);   // Home's word on where he is arrives between the two writes, as it does live
    // The second ticked card is far down, off the screen: only the landing at the end reaches it.
    for (const id of ['recJolt0', 'recJolt2']) await f.locator(`[data-apv-card="${id}"] [data-apv-pick]`).check();
    // The frame's top on screen, just under where the row pins: the first card fills the middle.
    await page.evaluate(() => window.scrollTo(0, window.scrollY + document.getElementById('homeAgentsFrame').getBoundingClientRect().top - 120));
    await page.waitForTimeout(600);
    await f.locator('[data-apv-bulk-approve]').click();
    await expect(f.locator('#toast')).toContainText('Approved all 2', { timeout: 15000 });
    await page.waitForTimeout(500);
    const g = await page.evaluate(() => {
      const fr = document.getElementById('homeAgentsFrame');
      const d = fr.contentDocument, top = fr.getBoundingClientRect().top;
      const box = id => { const r = d.querySelector(`[data-apv-card="${id}"]`).getBoundingClientRect(); return { top: r.top + top, bottom: r.bottom + top }; };
      const row = document.querySelector('.home-jump-pinned');
      return { strip: box('recJolt2'), next: box('recJolt3'), rowBottom: row ? row.getBoundingClientRect().bottom : 0 };
    });
    expect(g.strip.top).toBeGreaterThanOrEqual(g.rowBottom - 2);
    expect(g.strip.top).toBeLessThan(g.rowBottom + 40);
    expect(g.next.top - g.strip.bottom).toBeLessThanOrEqual(40);
  });

  test('Home: a card arriving while he reads the CEO brief below the queue leaves the brief where it is', async ({ page }) => {
    const fx = withMany(3);
    const f = await openHome(page, fx);
    await expect(f.locator('#zoneCeoBrief')).toBeVisible();
    const briefTop = () => page.evaluate(() => {
      const fr = document.getElementById('homeAgentsFrame');
      return Math.round(fr.getBoundingClientRect().top + fr.contentDocument.getElementById('zoneCeoBrief').getBoundingClientRect().top);
    });
    await page.evaluate(() => {
      const fr = document.getElementById('homeAgentsFrame');
      const z = fr.contentDocument.getElementById('zoneCeoBrief');
      window.scrollTo(0, window.scrollY + fr.getBoundingClientRect().top + z.getBoundingClientRect().top - 150);
    });
    await page.waitForTimeout(600);
    const before = await briefTop();
    fx.approvals.unshift(urgentArrival());
    await page.evaluate(() => document.getElementById('homeAgentsFrame').contentWindow.apvRereadQueue());
    await expect(f.locator('[data-apv-card="recJoltNew"]')).toHaveCount(1, { timeout: 8000 });
    await page.waitForTimeout(300);
    expect(Math.abs((await briefTop()) - before)).toBeLessThanOrEqual(2);
  });

  test('Home: knocking back the last card, then scrolling on to the brief, leaves the brief where it is though the list above grows', async ({ page }) => {
    const fx = withMany(2);
    fx.approvals = fx.approvals.filter(r => r.id.startsWith('recJolt'));
    const f = await openHome(page, fx);
    await slowSaves(page);
    const briefTop = () => page.evaluate(() => {
      const fr = document.getElementById('homeAgentsFrame');
      return Math.round(fr.getBoundingClientRect().top + fr.contentDocument.getElementById('zoneCeoBrief').getBoundingClientRect().top);
    });
    // The last card's buttons and the top of the brief both on screen.
    await page.evaluate(() => {
      const fr = document.getElementById('homeAgentsFrame');
      const z = fr.contentDocument.getElementById('zoneCeoBrief');
      window.scrollTo(0, window.scrollY + fr.getBoundingClientRect().top + z.getBoundingClientRect().top - 600);
    });
    await page.waitForTimeout(600);
    await f.locator('[data-apv-card="recJolt1"] .apv-defer-btn', { hasText: 'A week' }).first().click();
    await page.evaluate(() => window.scrollBy(0, 200));   // he scrolls on, towards the brief
    await page.waitForTimeout(400);
    const before = await briefTop();
    await expect(f.locator('[data-apv-card="recJolt1"] [data-apv-state="saved"]')).toHaveCount(1, { timeout: 8000 });
    await expect(f.locator('[data-apv-later]')).toHaveCount(1);
    await page.waitForTimeout(300);
    expect(Math.abs((await briefTop()) - before)).toBeLessThanOrEqual(2);
  });
});

// The final review of 27 Nov 2026.
test.describe('the final review: a jump in flight, the browser\'s own correction, what he is reading, press times', () => {
  test('Home: a jump to the dashboard still lands when the queue changes during the glide', async ({ page }) => {
    const f = await openHome(page, withMany(3));
    // Reading a card part way down the queue, so the change below lands above what he is reading.
    await f.locator('[data-apv-card="recJolt1"]').evaluate(c => c.scrollIntoView());
    await page.mouse.move(640, 500);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(600);
    await page.locator('[data-home-jump="dashboard"]').click();
    await page.waitForTimeout(120);
    // A re-read lands mid-glide: 400px more at the top of the copy.
    await f.locator('#signinsBody').evaluate(b => { const d = document.createElement('div'); d.style.height = '400px'; b.prepend(d); });
    await page.waitForTimeout(3500);
    const g = await page.evaluate(() => {
      const row = document.getElementById('homeJump');
      return { heading: document.querySelector('[data-home-fold="dashboard"]').getBoundingClientRect().top, row: row.getBoundingClientRect().bottom };
    });
    expect(g.heading - g.row).toBeGreaterThanOrEqual(-2);
    expect(g.heading - g.row).toBeLessThanOrEqual(30);
  });

  test('Home: a jump to the CEO brief, a section of the queue\'s own page, still lands when the queue grows during the glide', async ({ page }) => {
    const f = await openHome(page, withMany(3));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await page.locator('[data-home-jump="brief"]').click();
    await page.waitForTimeout(120);
    await f.locator('#signinsBody').evaluate(b => { const d = document.createElement('div'); d.style.height = '400px'; b.prepend(d); });
    await page.waitForTimeout(3500);
    const g = await page.evaluate(() => {
      const fr = document.getElementById('homeAgentsFrame');
      return { heading: fr.getBoundingClientRect().top + fr.contentDocument.getElementById('zoneCeoBrief').getBoundingClientRect().top,
        row: document.getElementById('homeJump').getBoundingClientRect().bottom };
    });
    expect(g.heading - g.row).toBeGreaterThanOrEqual(-2);
    expect(g.heading - g.row).toBeLessThanOrEqual(30);
  });

  test('the AI Agents tab: the sign-ins above growing moves the card he is reading by nothing, not twice', async ({ page }) => {
    await openTab(page, withMany());
    await page.locator('[data-apv-card="recJolt3"]').evaluate(c => window.scrollTo(0, c.getBoundingClientRect().top + window.pageYOffset - 120));
    await page.waitForTimeout(300);
    const before = await eye(page, false);
    await page.evaluate(() => { const d = document.createElement('div'); d.style.height = '400px'; document.getElementById('signinsBody').prepend(d); });
    await page.waitForTimeout(300);
    expectSamePlace(before, await eye(page, false));
  });

  test('reading the sign-ins with the first card below: a row added there leaves the heading where it is', async ({ page }) => {
    await openTab(page, withMany());
    const head = page.locator('#zoneSignins .zone-header');
    await head.evaluate(h => window.scrollTo(0, h.getBoundingClientRect().top + window.pageYOffset - 100));
    await page.waitForTimeout(300);
    const before = (await head.boundingBox()).y;
    await page.evaluate(() => { const d = document.createElement('div'); d.style.height = '150px'; document.getElementById('signinsBody').append(d); });
    await page.waitForTimeout(300);
    expect(Math.abs((await head.boundingBox()).y - before)).toBeLessThanOrEqual(2);
  });

  test('Bring back now, then a scroll and a click elsewhere while it saves: the page stays where he went', async ({ page }) => {
    await openTab(page, withKnockedBack(withMany()));
    await slowSaves(page);
    await page.locator('[data-apv-later] > summary').click();
    await page.locator('[data-apv-later] button', { hasText: /Bring back/ }).first().click();
    await page.mouse.move(640, 500);
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 250); await page.waitForTimeout(40); }
    await page.waitForTimeout(300);
    // A click on a link in a card he has scrolled to (its kind of work).
    const card = await eye(page, false);
    await page.locator(`[data-apv-card="${card.id}"] .apv-kind a`).click();
    const there = await eye(page, false);
    await expect(page.locator('#toast')).toContainText('Back in your queue', { timeout: 8000 });
    await page.waitForTimeout(300);
    expectSamePlace(there, await eye(page, false));
  });
});
