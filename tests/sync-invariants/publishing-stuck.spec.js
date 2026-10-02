// Invariant: the Publishing page names every episode that is not going out, and a page left open keeps reading
// the report.
//
// 21 Sep 2026 (Kevin: "the publishing dashboard is not staying up to date, so it's pretty useless"). Kevin sent
// Episode 2062's card back on 18 Sep. The engine rebuilt the clip that night but could not resubmit the card, so
// 2062 was neither waiting for him nor approved, and the report dropped it. For three days the page read "No
// episode cards wait for you" while 2063, 2064, 2065 and 2067 sat approved behind it and nothing went out. Day 2066
// had the same shape waiting further down: its full clip sat on Drive under a name the scan cannot read, so only
// its teaser existed. And the page read the report once, so a tab left open showed the morning's picture all day.
//
// So: a sent-back card and a day with no full episode show in red under "Needs you", skipped raw files are listed,
// and the page reads the row again every 2 minutes.
//
// 2 Oct 2026 (Kevin: "anything that is sent back for editing goes to the back of the queue... it doesn't block any
// new episodes going out"). Episode 2081 was sent back and held approved 2082 and 2083 all day. An approved episode
// now waits for no other day, so the page lists every approved one as going out and names any day the run has gone
// past ("Not out yet") with its reason, because nothing else waits for that day any more.

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
    history, cleanDaysInRow: 0, gapDaysPaused: true, scheduled: [], nextInOrder: [2063, 2064], waitingForKevin: [], qaBlocked: {},
    tonight: [2068], failedRenders: [], retryTonight: [], renderedNoCard: [], incomplete: [], strava: {},
    sentBack: [{ day: 2062, since: '18 Sep', feedback: 'There are learnings from my diary.' }], teaserOnly: [2066],
    leftBehind: [{ day: 2060, why: 'not rendered yet' }, { day: 2062, why: 'sent back on 18 Sep, not resubmitted' }],
    skippedNames: ['2026/26 Jan 26 - 1 Mar 26/2066 Full-Real.insv'],
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
  await expect(body).toContainText('Episode 2062: you sent it back on 18 Sep ("There are learnings from my diary."). No other episode waits for it.');
  await expect(body).toContainText('Approved and going out next: Episode 2063, 2064.');
  await expect(body).not.toContainText('held for order');
  // a day the run has gone past is named once: by its own line when it has one, else as "Not out yet"
  await expect(body).toContainText('Not out yet');
  await expect(body).toContainText('Episode 2060: not rendered yet. Later episodes have gone out without it.');
  await expect(body).not.toContainText('Episode 2062: sent back on 18 Sep, not resubmitted');
  await expect(body).toContainText('Raw files the engine skips');
  await expect(body).toContainText('2066 Full-Real.insv');
  await expect(page.locator('#updated')).toContainText('Next check');
});

test('a report with nothing stuck shows no stuck rows (an older report without the newer fields still renders)', async ({ page }) => {
  const r = report({ nextInOrder: [] });
  for (const k of ['sentBack', 'teaserOnly', 'leftBehind', 'skippedNames']) delete r[k];
  // the fields the strict-order report carried until 2 Oct 2026: a row written just before the change still renders
  Object.assign(r, { heldBehind: [2063, 2064], heldWhy: 'day 2062 is not approved yet, so 2063, 2064 wait behind it', blocker: { day: 2062, why: 'x' } });
  await openPublishing(page, [r]);
  const body = page.locator('#body');
  await expect(body).toContainText('Needs you');
  await expect(body).not.toContainText('Sent back, not resubmitted');
  await expect(body).not.toContainText('No full episode');
  await expect(body).not.toContainText('Not out yet');
  await expect(body).not.toContainText('Raw files the engine skips');
  await expect(body).toContainText('No approved episode is waiting to go out.');
});

// Review, 2 Oct 2026: a day the page already treats as normal (a card waiting for Kevin, a render retrying tonight)
// must not turn the "Nothing stuck" check red or show twice; a day nothing else names must do both.
test('a day left behind shows once, and only a day nothing else names counts as stuck', async ({ page }) => {
  await openPublishing(page, [report({ sentBack: [], teaserOnly: [], waitingForKevin: [2081], retryTonight: [2084], leftBehind: [
    { day: 2081, why: 'its card waits for your approval' }, { day: 2084, why: 'its render failed' },
    { day: 2079, why: 'its YouTube post is creating, with no link yet' }] })]);
  const body = page.locator('#body');
  await expect(body).toContainText('Episode 2079: its YouTube post is creating, with no link yet. Later episodes have gone out without it.');
  await expect(body).not.toContainText('Episode 2081: its card waits for your approval');
  await expect(body).not.toContainText('Episode 2084: its render failed');
  const unnamed = await page.evaluate(() => behindUnnamed({ sentBack: [{ day: 2062 }], teaserOnly: [2066], waitingForKevin: [2081], qaBlocked: { 2070: 'x' },
    failedRenders: [2071], retryTonight: [2084], renderedNoCard: [2085],
    leftBehind: [2062, 2066, 2070, 2071, 2079, 2081, 2084, 2085].map(day => ({ day, why: 'w' })) }).map(b => b.day));
  expect(unnamed).toEqual([2079]);
});

test('a rejected card and a sent-back day say so, and neither claims to hold another episode', async ({ page }) => {
  await openPublishing(page, [report({ leftBehind: [], sentBack: [
    { day: 2063, since: '19 Sep', feedback: '', rejected: true },
    { day: 1841, since: '15 Sep', feedback: '', rejected: false }] })]);
  const body = page.locator('#body');
  await expect(body).toContainText('Rejected, not resubmitted');
  await expect(body).toContainText('Episode 2063: you rejected it on 19 Sep. No other episode waits for it.');
  await expect(body).toContainText('Episode 1841: you sent it back on 15 Sep. No other episode waits for it.');
  await expect(body).not.toContainText('Every later episode waits');
});

test('a page left open reads the report again every 2 minutes', async ({ page }) => {
  await page.clock.install();
  const reads = await openPublishing(page, [report({ headline: 'Content: the first read.' }), report({ headline: 'Content: the second read.' })]);
  await expect(page.locator('#headline')).toHaveText('Content: the first read.');
  expect(reads()).toBe(1);
  await page.clock.runFor(100 * 1000);
  expect(reads(), 'no read before the 2 minutes are up').toBe(1);
  await page.clock.runFor(36 * 1000);
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

// 29 Sep 2026 (Kevin: "when I look at it, I know the actual situation and there's no lag"): the report is rewritten every
// 10 minutes round the clock by the live check, so the next check is ten minutes after the last write, day or night.
test('the next check is the first ten-minute mark after the last write, day and night', async ({ page }) => {
  await openPublishing(page, [report()]);
  const cases = await page.evaluate(() => [
    ['23:38 BST, the 23:30 check wrote at 23:30:04', '2026-09-29T22:38:00Z', '2026-09-29T22:30:04Z'],
    ['00:56 BST, the first check wrote at 00:54 on load', '2026-09-29T23:56:00Z', '2026-09-29T23:54:11Z'],
    ['14:18 BST, the hourly publisher wrote at 14:17', '2026-09-30T13:18:00Z', '2026-09-30T13:17:30Z'],
    ['a check overdue by 5 minutes', '2026-09-29T22:45:00Z', '2026-09-29T22:30:04Z'],
    ['07:12 GMT in December, written 07:10:02', '2026-12-01T07:12:00Z', '2026-12-01T07:10:02Z'],
    ['no update time on the row', '2026-09-29T22:40:00Z', ''],
  ].map(([label, now, upd]) => [label, nextUpdateText(Date.parse(now), upd)]));
  expect(cases).toEqual([
    ['23:38 BST, the 23:30 check wrote at 23:30:04', 'Next check about 23:40.'],
    ['00:56 BST, the first check wrote at 00:54 on load', 'Next check about 01:00.'],
    ['14:18 BST, the hourly publisher wrote at 14:17', 'Next check about 14:20.'],
    ['a check overdue by 5 minutes', 'Next check due now.'],
    ['07:12 GMT in December, written 07:10:02', 'Next check about 07:20.'],
    ['no update time on the row', 'Checked every 10 minutes.'],
  ]);
});

// Before the live check the page allowed 90 minutes in the day and 12 hours overnight before saying the report had
// stopped, so a dead report looked current all night. Now 30 minutes round the clock, and the page reads every 2 minutes.
test('a report over 30 minutes old says it has stopped, day or night, and a page in view reads every 2 minutes', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-30T01:00:00Z') });                         // 02:00 BST, mid-render
  let reads = 0, updated = '2026-09-30T00:35:00.000Z';                                         // 25 minutes old
  await page.addInitScript(() => { try { localStorage.setItem('_dlr_pat', 'patFIXTURE.test'); } catch (e) { /* storage blocked */ } });
  await page.route('**/api.airtable.com/v0/**', async (route) => {
    if (!route.request().url().includes(ESTATE_TBL)) { await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' }); return; }
    reads += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: [{
      id: 'recREPORT', createdTime: updated, fields: { Key: 'content-publishing', Updated: updated, Payload: JSON.stringify(report()) } }] }) });
  });
  await page.goto('/publishing.html');
  await expect(page.locator('#updated')).toContainText('Updated 25 min ago');
  await expect(page.locator('#updated')).not.toContainText('has stopped');
  updated = '2026-09-30T00:29:00.000Z';                                                        // the next read finds it 33 minutes old
  await page.clock.runFor(2 * 60 * 1000 + 16 * 1000);
  await expect.poll(() => reads).toBe(2);
  await expect(page.locator('#updated')).toContainText('The ten-minute check has stopped writing this report');
});

// The live check keeps the report fresh even when the hourly publisher itself has died (review, 29 Sep 2026), so the
// publisher's own last write is judged separately: 90 minutes in the day, the evening write stands overnight.
test('a stopped hourly publisher is named even though the report is fresh', async ({ page }) => {
  await openPublishing(page, [report()]);
  const cases = await page.evaluate(() => [
    ['15:00 BST, last ran 12:17 (the 13:15 run is overdue)', '2026-09-30T14:00:00Z', '2026-09-30T11:17:00Z'],
    ['14:00 BST, last ran 12:17 (13:15 still inside its 75 minutes)', '2026-09-30T13:00:00Z', '2026-09-30T11:17:00Z'],
    ['14:00 BST, last ran 13:17', '2026-09-30T13:00:00Z', '2026-09-30T12:17:00Z'],
    ['21:00 BST, died after 13:17 (review round 2)', '2026-09-30T20:00:00Z', '2026-09-30T12:17:00Z'],
    ['01:17 BST, died after 13:17 the day before', '2026-10-01T00:17:00Z', '2026-09-30T12:17:00Z'],
    ['03:00 BST, last ran 20:17', '2026-10-01T02:00:00Z', '2026-09-30T19:17:00Z'],
    ['08:00 BST, last ran 20:17 the night before', '2026-10-01T07:00:00Z', '2026-09-30T19:17:00Z'],
    ['08:31 BST, the 07:15 run never came', '2026-10-01T07:31:00Z', '2026-09-30T19:17:00Z'],
    ['03:00 BST, the night render stamped 01:05', '2026-10-01T02:00:00Z', '2026-10-01T00:05:00Z'],
    ['09:00 GMT in December, last ran 08:17', '2026-12-01T09:00:00Z', '2026-12-01T08:17:00Z'],
    ['02:20 GMT on 25 Oct, the 25-hour day, last ran 20:17 BST the night before', '2026-10-25T02:20:00Z', '2026-10-24T19:17:00Z'],
    ['08:29 GMT on 25 Oct, last ran 20:17 BST the night before', '2026-10-25T08:29:00Z', '2026-10-24T19:17:00Z'],
    ['01:30 GMT on 1 Jan, last ran 20:17 on 31 Dec', '2027-01-01T01:30:00Z', '2026-12-31T20:17:00Z'],
    ['not stamped yet', '2026-09-30T13:00:00Z', ''],
  ].map(([label, now, at]) => [label, publisherNote(Date.parse(now), at).stale]));
  expect(cases).toEqual([
    ['15:00 BST, last ran 12:17 (the 13:15 run is overdue)', true],
    ['14:00 BST, last ran 12:17 (13:15 still inside its 75 minutes)', false],
    ['14:00 BST, last ran 13:17', false],
    ['21:00 BST, died after 13:17 (review round 2)', true],
    ['01:17 BST, died after 13:17 the day before', true],
    ['03:00 BST, last ran 20:17', false],
    ['08:00 BST, last ran 20:17 the night before', false],
    ['08:31 BST, the 07:15 run never came', true],
    ['03:00 BST, the night render stamped 01:05', false],
    ['09:00 GMT in December, last ran 08:17', false],
    ['02:20 GMT on 25 Oct, the 25-hour day, last ran 20:17 BST the night before', false],
    ['08:29 GMT on 25 Oct, last ran 20:17 BST the night before', false],
    ['01:30 GMT on 1 Jan, last ran 20:17 on 31 Dec', false],
    ['not stamped yet', false],
  ]);
});

test('the publisher line shows on the page when it has stopped', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-30T14:00:00Z') });                           // 15:00 BST
  await openPublishing(page, [report({ publisherAt: '2026-09-30T11:17:00Z' })]);                    // last ran 12:17
  await expect(page.locator('#publisherNote')).toContainText('The hourly publisher last ran 2 h 43 min ago');
});

// 30 Sep 2026: the day-1990 extra take Kevin ruled on (21 Sep) still read as an unsorted skipped file. Files he has
// ruled on leave the list and are counted, never dropped silently.
test('skipped files Kevin has ruled on leave the list and are counted', async ({ page }) => {
  await openPublishing(page, [report({ skippedNames: [], skippedRuled: 2 })]);
  const body = page.locator('#body');
  await expect(body).toContainText('None left to sort. 2 you have already ruled on are kept as they are.');
  await expect(body).not.toContainText('The engine cannot read these file names');
});

// A post the live check could not ask GoHighLevel about keeps its last recorded status, and the page says so.
test('items the live check could not read are named, not shown as done', async ({ page }) => {
  await openPublishing(page, [report({ live: { checkedAt: new Date().toISOString(), errors: ['episode 2074 linkedin lfmd: GHL GET -> 502: gateway'] } })]);
  await expect(page.locator('#liveErrors')).toContainText('1 item(s) could not be checked live this time');
  await expect(page.locator('#liveErrors')).toContainText('episode 2074 linkedin lfmd');
});

// A read that never answers (the Mac asleep mid-request) used to hold the page's "already loading" flag for ever, so no
// later read ever ran. It now gives up after 30 seconds, says so, and the next read goes through.
test('a read that never answers gives up after 30 seconds, and the page reads again', async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  await page.addInitScript(() => { try { localStorage.setItem('_dlr_pat', 'patFIXTURE.test'); } catch (e) { /* storage blocked */ } });
  await page.route('**/api.airtable.com/v0/**', async (route) => {
    if (!route.request().url().includes(ESTATE_TBL)) { await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' }); return; }
    reads += 1;
    if (reads === 1) return;                                  // the first read hangs
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: [{
      id: 'recREPORT', createdTime: new Date().toISOString(),
      fields: { Key: 'content-publishing', Updated: new Date().toISOString(), Payload: JSON.stringify(report({ headline: 'Content: read after the hang.' })) } }] }) });
  });
  await page.goto('/publishing.html');
  await expect.poll(() => reads).toBe(1);
  await page.clock.runFor(31 * 1000);
  await expect(page.locator('#error')).toContainText('did not answer within 30 seconds');
  await page.clock.runFor(2 * 60 * 1000);
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#headline')).toHaveText('Content: read after the hang.');
});

// 2 Oct 2026, episode 2082: no diary section, so no Learnings clip and no Short, and the page read "3 of 7 sections" with
// both in red. A section the episode never had is greyed out, struck through, said in words, and not counted.
test('a clip the episode never had is struck out and not counted against it; a made clip still shows red', async ({ page }) => {
  const r = report();
  const sections = { 'YouTube episode': 'done', 'YouTube Short': 'none', 'Teaser clips': 'done', 'Learnings clips': 'none',
                     Blog: 'done', Podcast: 'pending', 'Facebook share': 'pending' };
  r.history[1].episodes = [
    { day: 2190, youtube: 'https://youtu.be/q', blog: '', podcast: '', sections, done: 3, owed: 5, missing: [], pending: ['Podcast', 'Facebook share'] },
    { day: 2191, youtube: 'https://youtu.be/w', blog: '', podcast: '', done: 5, owed: 7, missing: ['YouTube Short', 'Learnings clips'], pending: [],
      sections: Object.assign({}, sections, { 'YouTube Short': 'missing', 'Learnings clips': 'missing', Podcast: 'done', 'Facebook share': 'done' }) },
  ];
  await openPublishing(page, [r]);
  const rows = page.locator('#body tr', { hasText: 'Episode 219' });
  const none = rows.filter({ hasText: 'Episode 2190' });
  await expect(none).toContainText('3 of 5 sections');
  await expect(none.locator('.chip.notmade')).toHaveText(['YouTube Short', 'Learnings clips']);
  await expect(none.locator('.chip.missing')).toHaveCount(0);
  await expect(none).toContainText('Struck out: not in this episode');
  const made = rows.filter({ hasText: 'Episode 2191' });
  await expect(made).toContainText('5 of 7 sections');
  await expect(made.locator('.chip.missing')).toHaveText(['YouTube Short', 'Learnings clips']);
  await expect(made).not.toContainText('Struck out');
});
