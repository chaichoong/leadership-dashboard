// CEO Brief tab — render invariants.
// The tab READS the CEO Briefs table (by field name — allowlisted) and renders
// today's brief card plus history. The worker writes the table; the tab never
// writes. Regression targets: tab renders from fixture data, today's card is
// highlighted, the health bar registers, and the empty state never blanks.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures } = require('./helpers');

function londonTodayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

const BRIEF_FIXTURES = {
  ceoBriefs: [
    {
      id: 'recBriefToday',
      fields: {
        'Date': londonTodayISO(),
        'One Thing': 'Test the onboarding flow end to end',
        'First Step': 'Open the staging site and create one pretend client',
        'Why': 'First client by 31 August depends on onboarding working.',
        'Ignore Today': 'Old invoice filing\nNon-urgent email',
        'Board Flags': 'Keller: two of today’s tasks are scatter — refocus.',
        'Money Light': 'green',
        'Safe To Act': 1234.56,
      },
    },
    {
      id: 'recBriefPrev',
      fields: {
        'Date': '2026-07-25',
        'One Thing': 'Yesterday thing',
        'First Step': 'Yesterday step',
        'Money Light': 'amber',
        'Safe To Act': 900,
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

  test('health bar registers for the tab', async ({ page }) => {
    await loadDashboardWithFixtures(page, BRIEF_FIXTURES, 'ceo-brief');
    await page.evaluate(() => switchTab('ceo-brief'));
    await page.waitForTimeout(1200);
    const bar = page.locator('#tab-ceo-brief [data-sync-bar="ceo-brief"]');
    await expect(bar).toHaveCount(1);
  });
});
