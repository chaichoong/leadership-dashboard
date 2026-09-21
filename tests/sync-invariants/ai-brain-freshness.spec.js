// Invariant: the AI Brain page must not call a dead feed "Synced".
//
// Finding 20260821-prod-e2e-sweep-281. On 21 Aug 2026 the nightly brain
// publisher had not run for three days. Every row in the feed carried Date
// 2026-08-18, and the page rendered "Synced · 18 August 2026" with a green dot,
// because setSync only asked whether a date existed, never how old it was. It
// also read rows[0].Date after sorting by SortOrder, so the date shown was
// whichever row sorted first, not the newest.
//
// So: the newest Date across the feed, measured against today in London,
// drives the wording and the colour. Today = Synced (green). One day behind =
// "Last published ... (1 day ago)" in amber. Two or more = red. An empty feed
// is amber, never a clean sync.

const { test, expect } = require('@playwright/test');

const FEED_TABLE = 'tblZ75JgE1wzDP0ps';

function londonDaysAgo(n) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

function row(id, date, sort) {
  return { id, createdTime: new Date().toISOString(),
    fields: { Date: date, SortOrder: sort, Kind: 'metric', Category: 'notes', Value: 2 } };
}

async function openBrain(page, records) {
  await page.addInitScript(() => {
    try { localStorage.setItem('_dlr_pat', 'patFIXTURE.test'); } catch (e) { /* storage blocked */ }
  });
  await page.route('**/api.airtable.com/v0/**', async (route) => {
    if (!route.request().url().includes(FEED_TABLE)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ records }) });
  });
  await page.goto('/ai-brain.html');
  await expect(page.locator('#syncStatus')).not.toHaveText(/Loading|Syncing/);
}

async function dotColour(page, token) {
  return page.evaluate((t) => {
    const probe = document.createElement('span');
    probe.style.background = 'var(' + t + ')';
    document.body.appendChild(probe);
    const want = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { want, got: getComputedStyle(document.getElementById('syncDot')).backgroundColor };
  }, token);
}

test('a feed published today reads Synced in green', async ({ page }) => {
  await openBrain(page, [row('rec1', londonDaysAgo(0), 1)]);
  await expect(page.locator('#syncStatus')).toHaveText(/^Synced · /);
  const c = await dotColour(page, '--success');
  expect(c.got).toBe(c.want);
});

test('a feed three days old is red and says how old it is (the 21 Aug 2026 case)', async ({ page }) => {
  await openBrain(page, [row('rec1', londonDaysAgo(3), 1), row('rec2', londonDaysAgo(3), 2)]);
  await expect(page.locator('#syncStatus')).toHaveText(/^Last published .*\(3 days ago\)$/);
  await expect(page.locator('#syncStatus')).not.toHaveText(/Synced/);
  const c = await dotColour(page, '--danger');
  expect(c.got).toBe(c.want);
});

test('one day behind is amber, not green', async ({ page }) => {
  await openBrain(page, [row('rec1', londonDaysAgo(1), 1)]);
  await expect(page.locator('#syncStatus')).toHaveText(/\(1 day ago\)$/);
  const c = await dotColour(page, '--warning');
  expect(c.got).toBe(c.want);
});

test('the NEWEST date wins, not whichever row sorts first', async ({ page }) => {
  // rows[0] after the SortOrder sort is the stale one; the feed is still fresh.
  const today = londonDaysAgo(0);
  const [y, m, d] = today.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  await openBrain(page, [row('recOld', londonDaysAgo(4), 1), row('recNew', today, 9)]);
  await expect(page.locator('#syncStatus')).toHaveText('Synced · ' + d + ' ' + months[m - 1] + ' ' + y);
});

test('an empty feed is never a clean sync', async ({ page }) => {
  await openBrain(page, []);
  await expect(page.locator('#syncStatus')).toHaveText('Nothing published yet');
  const c = await dotColour(page, '--warning');
  expect(c.got).toBe(c.want);
});
