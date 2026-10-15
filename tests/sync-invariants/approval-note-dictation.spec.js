// A NOTE BOX IS IN USE FROM THE CLICK, NOT THE FIRST KEY (Kevin, 15 Oct 2026). On Home, Wispr Flow
// would not paste into an approval card's note box, and a manual paste often took two or three goes.
// The page counted a box as in use only after a keystroke in the last 30 seconds. Wispr Flow types
// nothing while he speaks and pastes the lot at the end, so while he dictated the box read as idle:
// a background re-read (Home's five-minute refresh, his click into the frame, coming back to the
// browser) redrew every card, the cursor fell to the page body and the paste landed nowhere. The same
// click fires the frame's window focus BEFORE the box has the cursor, so the "is a newer copy live?"
// check behind it passed as idle and could reload the whole frame under him. Invariants:
//   1. Clicked into, nothing typed, dictating for longer than 30 seconds: a re-read that brings a new
//      card waits, the cursor stays, the paste lands in the box; once he leaves the box the held
//      re-read runs and keeps his words.
//   2. Gone to another window (copying from Wispr Flow) after a long dictation: the box holds for 30
//      seconds from when he LEFT, then the queue catches up, so a parked cursor never freezes it.
//   3. On Home, clicking into a box after a newer copy went live does not reload the frame under him,
//      on the first click or any later one (the "newer copy" answer is remembered, so it comes at once).
//   4. A note left in a box holds the reload, and a reload notice that came while he was idle is
//      dropped if he starts on a box before it fires.
// Airtable is mocked; the live copy's ETag is faked on the page's own HEAD request. Names are invented.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { mockAgentsPage, defaultFixtures, TF, AGENT_B } = require('./agents-page.helpers');
const { MOCK_PAT, setupMockAirtable } = require('./helpers');

const ID = 'recApvB1';
const WORDS = 'Hold this until the second quote is in.';

async function openHomeCopy(page) {
  const fx = defaultFixtures();
  await mockAgentsPage(page, { approvals: fx.approvals });   // the same array: a card pushed to it is in the next read
  await page.goto('/os/agents/index.html?home=1');
  await page.waitForSelector('#main', { state: 'visible', timeout: 20000 });
  await expect(page.locator(`#apvNote-${ID}`)).toBeVisible();
  return fx;
}
const newCard = () => ({ id: 'recApvNew', createdTime: new Date().toISOString(), fields: {
  [TF.name]: 'A card an agent raised just now', [TF.status]: 'Approval', [TF.agentOutput]: 'Draft: confirm the booking.',
  [TF.priority]: 'High', [TF.sentForApprovalBy]: [AGENT_B], [TF.teamMember]: [AGENT_B],
  [TF.lmt]: new Date().toISOString(), [TF.taskType]: 'Drafting' } });
const activeId = page => page.evaluate(() => document.activeElement.id || document.activeElement.tagName);

// Home with the AI Agents page in its frame, where the live copy of that page is newer than this one.
async function openHomeStale(page) {
  const bytes = fs.statSync(path.resolve(__dirname, '..', '..', 'os/agents/index.html')).size;
  const heads = [];
  await page.route(/\/os\/agents\/index\.html(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'HEAD') return route.continue();
    heads.push(route.request().url());
    return route.fulfill({ status: 200, headers: { etag: `W/"6ac6757c-${(bytes + 7).toString(16)}"`, 'content-type': 'text/html' }, body: '' });
  });
  await page.addInitScript((pat) => { localStorage.setItem('_dlr_pat', pat); }, MOCK_PAT);
  await setupMockAirtable(page);
  await page.goto('/#home');
  await page.waitForFunction(() => {
    const f = document.getElementById('homeAgentsFrame'), d = f && f.contentDocument;
    return d && d.getElementById('approvalsBody') && document.getElementById('homeAgentsStatus').hidden;
  }, { timeout: 30000 });
  return heads;
}

test.describe('An approval note box keeps the cursor while Kevin dictates', () => {
  test('clicked into, nothing typed yet: a re-read waits, the cursor stays and the paste lands', async ({ page }) => {
    const fx = await openHomeCopy(page);
    await page.click(`#apvNote-${ID}`);
    await page.evaluate(() => { _apvLastKeyAt = Date.now() - 31000; });   // he has been speaking for over 30 seconds
    fx.approvals.push(newCard());
    await page.evaluate(() => apvRereadQueue());   // what Home's refresh, the frame's focus and the 30-second watch call
    await page.waitForTimeout(4500);                // two passes of the 2-second retry
    await expect(page.locator('[data-apv-card="recApvNew"]'), 'nothing is redrawn under his cursor').toHaveCount(0);
    expect(await activeId(page)).toBe(`apvNote-${ID}`);
    await page.keyboard.insertText(WORDS);           // Wispr Flow's paste
    await expect(page.locator(`#apvNote-${ID}`)).toHaveValue(WORDS);
    // He moves on: the held re-read runs, and his words survive the redraw.
    await page.evaluate(() => document.activeElement.blur());
    await expect(page.locator('[data-apv-card="recApvNew"]')).toBeVisible({ timeout: 8000 });
    await expect(page.locator(`#apvNote-${ID}`)).toHaveValue(WORDS);
  });

  test('gone to another window, the box holds for 30 seconds from when he left, then the queue catches up', async ({ page }) => {
    const fx = await openHomeCopy(page);
    await page.click(`#apvNote-${ID}`);
    await page.evaluate(() => {
      _apvLastKeyAt = Date.now() - 40000;          // a long dictation, then the paste failed
      document.hasFocus = () => false;              // he goes to the Wispr Flow window to copy it
      window.dispatchEvent(new Event('blur'));
    });
    fx.approvals.push(newCard());
    await page.evaluate(() => apvRereadQueue());
    await page.waitForTimeout(4500);
    await expect(page.locator('[data-apv-card="recApvNew"]')).toHaveCount(0);
    expect(await activeId(page)).toBe(`apvNote-${ID}`);
    await page.evaluate(() => { _apvLastKeyAt = Date.now() - 31000; });   // 30 seconds on, still away
    await expect(page.locator('[data-apv-card="recApvNew"]'), 'a parked cursor never freezes the queue').toBeVisible({ timeout: 8000 });
  });

  test('on Home, clicking into a box after a newer copy went live never reloads the frame under him, first click or later', async ({ page }) => {
    const heads = await openHomeStale(page);
    await page.evaluate(() => {
      const w = document.getElementById('homeAgentsFrame').contentWindow, d = w.document;
      w.__sameCopy = true;
      w.__toasts = [];
      const toast = w.toast;
      w.toast = function (msg) { w.__toasts.push(String(msg)); return toast.apply(this, arguments); };
      for (const id of ['specNoteA', 'specNoteB']) {
        const t = d.createElement('textarea'); t.id = id; t.className = 'apv-note';
        d.getElementById('approvalsBody').prepend(t);
      }
    });
    for (const box of ['specNoteA', 'specNoteB']) {
      await page.click('#homeDate');   // a click on Home itself: the frame loses the keyboard and its cursor
      await page.frameLocator('#homeAgentsFrame').locator('#' + box).click();
      await page.waitForTimeout(4000);   // a reload would come 2.5 seconds after the check
      const after = await page.evaluate(() => {
        const w = document.getElementById('homeAgentsFrame').contentWindow;
        return { same: w.__sameCopy === true, active: w.document.activeElement.id,
                 notice: w.__toasts.some(m => /updated after you opened it/.test(m)) };
      });
      expect(after, box).toEqual({ same: true, active: box, notice: false });   // not even the "reloading now" notice
    }
    expect(heads.length, 'the click still asked whether a newer copy is live').toBeGreaterThan(0);
  });

  test('a note left in a box, cursor out, holds the reload: no "reloading now" notice', async ({ page }) => {
    await openHomeCopy(page);
    const bytes = fs.statSync(path.resolve(__dirname, '..', '..', 'os/agents/index.html')).size;
    await page.route(/\/os\/agents\/index\.html(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'HEAD') return route.continue();
      return route.fulfill({ status: 200, headers: { etag: `W/"6ac6757c-${(bytes + 7).toString(16)}"`, 'content-type': 'text/html' }, body: '' });
    });
    await page.locator(`#apvNote-${ID}`).fill(WORDS);
    await page.evaluate(() => document.activeElement.blur());   // he clicked out, leaving the note
    const r = await page.evaluate(async () => {
      const toasts = [];
      const toast = window.toast;
      window.toast = function (msg) { toasts.push(String(msg)); return toast.apply(this, arguments); };
      const reloading = await apvStaleTab({ unlessBusy: true });   // Home's refresh on an old copy
      return { reloading, notice: toasts.some(m => /updated after you opened it/.test(m)) };
    });
    expect(r).toEqual({ reloading: false, notice: false });
    await expect(page.locator(`#apvNote-${ID}`)).toHaveValue(WORDS);
  });

  test('a reload notice that came while he was idle is dropped when he starts on a box before it fires', async ({ page }) => {
    await openHomeStale(page);
    const toastShown = await page.evaluate(async () => {
      const w = document.getElementById('homeAgentsFrame').contentWindow, d = w.document;
      w.__sameCopy = true;
      const t = d.createElement('textarea'); t.id = 'specNote'; t.className = 'apv-note';
      d.getElementById('approvalsBody').prepend(t);
      const reloading = await w.apvStaleTab({ unlessBusy: true });   // Home's refresh found him idle: the notice shows
      return reloading && /updated after you opened it/.test((d.getElementById('toast') || {}).textContent || '');
    });
    expect(toastShown).toBe(true);
    await page.frameLocator('#homeAgentsFrame').locator('#specNote').click();   // he starts on a box straight away
    await page.waitForTimeout(4000);
    const after = await page.evaluate(() => {
      const w = document.getElementById('homeAgentsFrame').contentWindow;
      return { same: w.__sameCopy === true, kept: w.sessionStorage.getItem(w.eval('APV_DRAFT_CARRY')), reread: w.eval('_apvDirty') };
    });
    // Same copy; no notes left kept for a reload that never came; the skipped re-read is owed.
    expect(after).toEqual({ same: true, kept: null, reread: true });
  });
});
