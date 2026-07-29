// CEO Brief tab — render invariants.
// The tab READS the CEO Briefs table and renders today's brief card plus history.
// The worker writes the table; the tab never writes. Regression targets: tab
// renders from fixture data, today's card is highlighted, the health bar
// registers, and the empty state never blanks.
//
// Fixtures are keyed by FIELD ID, matching the real returnFieldsByFieldId=true
// response. Both sides moved off field names on 2026-07-29 so the drift monitor
// can see this table; keying the fixture by name here would let the tab regress
// to names and still pass.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures } = require('./helpers');

function londonTodayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

// Mirrors F.ceo* in js/config.js.
const CEO = {
  date:        'fldzLwBd3Mjg7rDxM',
  oneThing:    'fldQDCAcd74Bb6mpY',
  firstStep:   'fld4O4EuxHzMWARV7',
  why:         'fldqooUbDCQ4yNlWQ',
  ignoreToday: 'fldmC5AYRaJdfyFGx',
  boardFlags:  'fldS7ZoGAS7sAJfJq',
  moneyLight:  'fldBIbjpHlA2QmVbO',
  safeToAct:   'fldQ4JEWYpHpI2KDs',
};

const BRIEF_FIXTURES = {
  ceoBriefs: [
    {
      id: 'recBriefToday',
      fields: {
        [CEO.date]: londonTodayISO(),
        [CEO.oneThing]: 'Test the onboarding flow end to end',
        [CEO.firstStep]: 'Open the staging site and create one pretend client',
        [CEO.why]: 'First client by 31 August depends on onboarding working.',
        [CEO.ignoreToday]: 'Old invoice filing\nNon-urgent email',
        [CEO.boardFlags]: 'Keller: two of today’s tasks are scatter — refocus.',
        [CEO.moneyLight]: 'green',
        [CEO.safeToAct]: 1234.56,
      },
    },
    {
      id: 'recBriefPrev',
      fields: {
        [CEO.date]: '2026-07-25',
        [CEO.oneThing]: 'Yesterday thing',
        [CEO.firstStep]: 'Yesterday step',
        [CEO.moneyLight]: 'amber',
        [CEO.safeToAct]: 900,
      },
    },
  ],
};

test.describe('CEO Brief tab', () => {
  test('renders today’s brief and history from the briefs table', async ({ page }) => {
    await loadDashboardWithFixtures(page, BRIEF_FIXTURES, 'ceo-brief');
    await page.evaluate(() => switchTab('ceo-brief'));
    await page.waitForTimeout(1200);

    const panel = page.locator('#tab-ceo-brief');
    await expect(panel).toContainText('CEO Brief');
    await expect(panel).toContainText('Test the onboarding flow end to end');
    await expect(panel).toContainText('Start here (10 min):');
    await expect(panel).toContainText('TODAY');
    await expect(panel).toContainText('£1,234.56');
    // history renders too
    await expect(panel).toContainText('Previous briefs');
    await expect(panel).toContainText('Yesterday thing');
    // board flag renders escaped
    await expect(panel).toContainText('Keller:');
  });

  test('empty table shows a friendly state, never a blank tab', async ({ page }) => {
    await loadDashboardWithFixtures(page, { ceoBriefs: [] }, 'ceo-brief');
    await page.evaluate(() => switchTab('ceo-brief'));
    await page.waitForTimeout(1200);
    const panel = page.locator('#tab-ceo-brief');
    const text = (await panel.textContent()) || '';
    expect(text.length).toBeGreaterThan(40); // some guidance text rendered
    await expect(panel).toContainText(/brief/i);
  });

  test('reads the briefs table by field ID, never by name', async ({ page }) => {
    // The guard for the 2026-07-29 drift fix. A by-name read would render fine off a
    // by-name fixture and look healthy right up until someone renames a field in
    // Airtable, at which point the brief goes blank with nothing to catch it.
    const briefUrls = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('tblIxbzDSOCI5hqJn')) briefUrls.push(u);
    });
    await loadDashboardWithFixtures(page, BRIEF_FIXTURES, 'ceo-brief');
    await page.evaluate(() => switchTab('ceo-brief'));
    await page.waitForTimeout(1200);

    expect(briefUrls.length, 'the tab should have fetched the CEO Briefs table').toBeGreaterThan(0);
    const byName = briefUrls.filter((u) => !u.includes('returnFieldsByFieldId=true'));
    expect(byName, `CEO Briefs fetched by name:\n${byName.join('\n')}`).toEqual([]);
    // and the sort travels as a field ID too
    expect(briefUrls.some((u) => u.includes(encodeURIComponent(CEO.date)) || u.includes(CEO.date))).toBe(true);
  });

  test('health bar registers for the tab', async ({ page }) => {
    await loadDashboardWithFixtures(page, BRIEF_FIXTURES, 'ceo-brief');
    await page.evaluate(() => switchTab('ceo-brief'));
    await page.waitForTimeout(1200);
    const bar = page.locator('#tab-ceo-brief [data-sync-bar="ceo-brief"]');
    await expect(bar).toHaveCount(1);
  });
});
