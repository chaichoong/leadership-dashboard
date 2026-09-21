// Invariant: the Publishing page names whatever holds the Content Engine's queue, and a page left open keeps
// reading the report.
//
// 21 Sep 2026 (Kevin: "the publishing dashboard is not staying up to date, so it's pretty useless"). Kevin sent
// Episode 2062's card back on 18 Sep. The engine rebuilt the clip that night but could not resubmit the card, so
// 2062 was neither waiting for him nor approved, and the report dropped it. For three days the page read "No
// episode cards wait for you" while 2063, 2064, 2065 and 2067 sat approved behind it and nothing went out. Day 2066
// had the same shape waiting further down: its full clip sat on Drive under a name the scan cannot read, so only
// its teaser existed. And the page read the report once, so a tab left open showed the morning's picture all day.
//
// So: a sent-back card and a day with no full episode show in red under "Needs you", the held line names the day
// the queue waits on and why, skipped raw files are listed, and the page reads the row again every 5 minutes.

const { test, expect } = require('@playwright/test');

const ESTATE_TBL = 'tblZVrdzivyBueZVf';

function londonToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

function report(over) {
  const today = londonToday();
  const [y, m, d] = today.split('-').map(Number);
  const history = [...Array(7)].map((_, i) => ({ date: new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10), episodes: [] }));
  return Object.assign({
    asOf: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), today, mode: 'live', streakDay: 2304, lastInOrder: 2061, daysBehind: 243,
    history, cleanDaysInRow: 0, gapDaysPaused: true, scheduled: [], nextInOrder: [], heldBehind: [2063, 2064],
    heldWhy: 'day 2062 is not approved yet, so 2063, 2064 wait behind it', waitingForKevin: [], qaBlocked: {},
    tonight: [2068], failedRenders: [], retryTonight: [], renderedNoCard: [], incomplete: [], strava: {},
    sentBack: [{ day: 2062, since: '18 Sep', feedback: 'There are learnings from my diary.' }], teaserOnly: [2066],
    blocker: { day: 2062, why: 'sent back on 18 Sep, not resubmitted' }, skippedNames: ['2026/26 Jan 26 - 1 Mar 26/2066 Full-Real.insv'],
    headline: 'Content: NOTHING went out yesterday.',
  }, over || {});
}

async function openPublishing(page, reports) {
  let reads = 0;
  await page.addInitScript(() => {
    try { localStorage.setItem('_dlr_pat', 'patFIXTURE.test'); } catch (e) { /* storage blocked */ }
  });
  await page.route('**/api.airtable.com/v0/**', async (route) => {
    if (!route.request().url().includes(ESTATE_TBL)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' });
      return;
    }
    const r = reports[Math.min(reads, reports.length - 1)];
    reads += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: [{
      id: 'recREPORT', createdTime: new Date().toISOString(),
      fields: { Key: 'content-publishing', Updated: new Date().toISOString(), Payload: JSON.stringify(r) } }] }) });
  });
  await page.goto('/publishing.html');
  await expect(page.locator('#body .card').first()).toBeVisible();
  return () => reads;
}

test('a sent-back card and a day with no full episode are named, not hidden', async ({ page }) => {
  await openPublishing(page, [report()]);
  const body = page.locator('#body');
  await expect(body).toContainText('Sent back, not resubmitted');
  await expect(body).toContainText('Episode 2062: you sent it back on 18 Sep');
  await expect(body).toContainText('No full episode');
  await expect(body).toContainText('Day 2066: the engine has found only its teaser');
  await expect(body).toContainText('Episode 2063, 2064 wait behind day 2062 (sent back on 18 Sep, not resubmitted)');
  await expect(body).toContainText('Raw files the engine skips');
  await expect(body).toContainText('2066 Full-Real.insv');
  await expect(page.locator('#updated')).toContainText('Next update');
});

test('a report with nothing stuck shows no stuck rows (an older report without the new fields still renders)', async ({ page }) => {
  const r = report();
  for (const k of ['sentBack', 'teaserOnly', 'blocker', 'skippedNames']) delete r[k];
  await openPublishing(page, [r]);
  const body = page.locator('#body');
  await expect(body).toContainText('Needs you');
  await expect(body).not.toContainText('Sent back, not resubmitted');
  await expect(body).not.toContainText('No full episode');
  await expect(body).not.toContainText('Raw files the engine skips');
  await expect(body).toContainText('day 2062 is not approved yet');
});

test('a rejected card and an old sent-back day say so, and an old day claims to hold nothing', async ({ page }) => {
  await openPublishing(page, [report({ blocker: null, sentBack: [
    { day: 2063, since: '19 Sep', feedback: '', rejected: true, holdsOrder: true },
    { day: 1841, since: '15 Sep', feedback: '', rejected: false, holdsOrder: false }] })]);
  const body = page.locator('#body');
  await expect(body).toContainText('Rejected, not resubmitted');
  await expect(body).toContainText('Episode 2063: you rejected it on 19 Sep. Every later episode waits');
  await expect(body).toContainText('Episode 1841: you sent it back on 15 Sep. It is an older day, so no other episode waits for it.');
});

test('a page left open reads the report again every 5 minutes', async ({ page }) => {
  await page.clock.install();
  const reads = await openPublishing(page, [report({ headline: 'Content: the first read.' }), report({ headline: 'Content: the second read.' })]);
  await expect(page.locator('#headline')).toHaveText('Content: the first read.');
  expect(reads()).toBe(1);
  await page.clock.runFor(4 * 60 * 1000);
  expect(reads(), 'no read before the 5 minutes are up').toBe(1);
  await page.clock.runFor(76 * 1000);
  await expect.poll(reads).toBe(2);
  await expect(page.locator('#headline')).toHaveText('Content: the second read.');
});

// Inside the app the page is a frame the shell hides on other tabs. Switching back fires no visibilitychange, so the
// frame checks its own visibility: hidden, it never reads; back in view with an old copy, it reads straight away.
test('inside the app shell: a hidden frame does not read, and reads as soon as it is shown again', async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  await page.addInitScript(() => { try { localStorage.setItem('_dlr_pat', 'patFIXTURE.test'); } catch (e) { /* storage blocked */ } });
  await page.route('**/shell-fixture.html', (route) => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><div id="panel"><iframe id="f" src="/publishing.html" style="width:900px;height:600px"></iframe></div>' }));
  await page.route('**/api.airtable.com/v0/**', async (route) => {
    reads += route.request().url().includes(ESTATE_TBL) ? 1 : 0;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: [{
      id: 'recREPORT', createdTime: new Date().toISOString(),
      fields: { Key: 'content-publishing', Updated: new Date().toISOString(), Payload: JSON.stringify(report()) } }] }) });
  });
  await page.goto('/shell-fixture.html');
  await expect(page.frameLocator('#f').locator('#body')).toContainText('Needs you');
  expect(reads).toBe(1);
  await page.evaluate(() => { document.getElementById('panel').style.display = 'none'; });   // Kevin opens another tab
  await page.clock.runFor(10 * 60 * 1000);
  expect(reads, 'a hidden frame never reads').toBe(1);
  await page.evaluate(() => { document.getElementById('panel').style.display = ''; });       // and comes back
  await page.clock.runFor(16 * 1000);
  await expect.poll(() => reads).toBe(2);
});

test('the next update time follows the last write, not the clock', async ({ page }) => {
  await openPublishing(page, [report()]);
  const cases = await page.evaluate(() => [
    ['07:15 BST, last write 20:17 the night before', '2026-09-21T06:15:00Z', '2026-09-20T19:17:00Z'],
    ['07:17 BST, the 07:15 write landed', '2026-09-21T06:17:00Z', '2026-09-21T06:16:30Z'],
    ['15:52 BST, written 15:17', '2026-09-21T14:52:00Z', '2026-09-21T14:17:00Z'],
    ['20:30 BST, written 20:17', '2026-09-21T19:30:00Z', '2026-09-21T19:17:00Z'],
    ['23:40 BST, the night render wrote at 23:20', '2026-09-21T22:40:00Z', '2026-09-21T22:20:00Z'],
    ['00:30 BST, the night render still running', '2026-09-21T23:30:00Z', '2026-09-21T19:17:00Z'],
    ['03:00 BST, the night render wrote at 00:09', '2026-09-22T02:00:00Z', '2026-09-21T23:09:00Z'],
    ['07:15 GMT in December, last write 20:17 the night before', '2026-12-01T07:15:00Z', '2026-11-30T20:17:00Z'],
  ].map(([label, now, upd]) => [label, nextUpdateText(Date.parse(now), upd)]));
  expect(cases).toEqual([
    ['07:15 BST, last write 20:17 the night before', 'Next update about 07:15.'],
    ['07:17 BST, the 07:15 write landed', 'Next update about 08:15.'],
    ['15:52 BST, written 15:17', 'Next update about 16:15.'],
    ['20:30 BST, written 20:17', "Next update after tonight's render, then 07:15."],
    ['23:40 BST, the night render wrote at 23:20', 'Next update about 07:15.'],
    ['00:30 BST, the night render still running', 'Next update when the night render finishes, or at 07:15.'],
    ['03:00 BST, the night render wrote at 00:09', 'Next update about 07:15.'],
    ['07:15 GMT in December, last write 20:17 the night before', 'Next update about 07:15.'],
  ]);
});
