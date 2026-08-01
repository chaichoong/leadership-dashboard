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
  handedOff:   'fld9PQ10p8V4N8Y0U',
  moneyLight:  'fldBIbjpHlA2QmVbO',
  safeToAct:   'fldQ4JEWYpHpI2KDs',
  fullBrief:   'fldPkiaWvmYAoyHEl',
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
        [CEO.handedOff]: 'worker-writer — draft the warm-20 re-engagement message\nMica — chase the UC verification',
        [CEO.moneyLight]: 'green',
        [CEO.safeToAct]: 1234.56,
        // Full Brief is what marks a brief FINISHED — the 09:00 worker writes it,
        // the 07:30 huddle does not. Every fixture that stands for a completed
        // brief must carry it, or the tab correctly treats it as a huddle stub.
        [CEO.fullBrief]: '{"one_thing":"Test the onboarding flow end to end"}',
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
        [CEO.fullBrief]: '{"one_thing":"Yesterday thing"}',
      },
    },
  ],
};

// The 07:30 department huddle's half-written record: the one thing, the first step
// and the flags, and nothing the 09:00 worker adds.
const HUDDLE_STUB = {
  id: 'recBriefStub',
  fields: {
    [CEO.date]: londonTodayISO(),
    [CEO.oneThing]: 'Work the warm 20 out of GoHighLevel',
    [CEO.firstStep]: 'Pull the 20 names into one list. Ten minutes.',
    [CEO.boardFlags]: 'Belfort: the contract is still at old terms.',
  },
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
    // A finished brief carries no unfinished labelling. The other side of the
    // huddle-stub guard below: read the marker backwards and every real 9am brief
    // wears an alarming banner, which is how a warning stops being read.
    await expect(panel).not.toContainText('not the finished brief');
    await expect(panel).not.toContainText('NOT FINISHED');
  });

  test('shows what was handed off, and to which agent or person', async ({ page }) => {
    // Added 2026-07-29. The brief's whole job is keeping work OFF Kevin: it routes to a named
    // AI agent first, then Mica or Ericamae. If the tab silently drops that list, delegated work
    // looks like it vanished, and the next brief gets trusted a little less.
    await loadDashboardWithFixtures(page, BRIEF_FIXTURES, 'ceo-brief');
    await page.evaluate(() => switchTab('ceo-brief'));
    await page.waitForTimeout(1200);

    const panel = page.locator('#tab-ceo-brief');
    await expect(panel).toContainText('Not yours today, handed off:');
    await expect(panel).toContainText('worker-writer — draft the warm-20 re-engagement message');
    await expect(panel).toContainText('Mica — chase the UC verification');
    // one line per destination, not one run-on blob
    await expect(panel.locator('li', { hasText: 'worker-writer' })).toHaveCount(1);
  });

  test('a brief with nothing handed off omits the section entirely', async ({ page }) => {
    const noneHanded = { ceoBriefs: [{ ...BRIEF_FIXTURES.ceoBriefs[0], fields: { ...BRIEF_FIXTURES.ceoBriefs[0].fields, [CEO.handedOff]: '' } }] };
    await loadDashboardWithFixtures(page, noneHanded, 'ceo-brief');
    await page.evaluate(() => switchTab('ceo-brief'));
    await page.waitForTimeout(1200);
    await expect(page.locator('#tab-ceo-brief')).not.toContainText('handed off');
  });

  // ── The 07:30 huddle stub ───────────────────────────────────────────────────
  // Found by the drift monitor 2026-07-31. The brief is written in two stages: the
  // 07:30 huddle lays down the one thing, the first step and the flags, then the
  // 09:00 worker fills in the money light, the safe-to-act figure and the reasoning.
  // The tab used to ask only "is there a record dated today?", so for 90 minutes
  // every weekday the stub rendered as a finished brief with a dash for the money
  // light, a dash for the figure, and no warning that anything was missing.
  // Full Brief is the marker for stage two, and the worker already uses exactly this
  // test on the write side (gatherHuddle). These tests fail without that fix.

  // Card and health bar are asserted from ONE fixture load on purpose. This spec
  // shares a worker and a dev server with the rest of the suite, and the task-drawer
  // spec that runs last is timing-sensitive: three extra dashboard loads here were
  // enough to make it drop a test. Keep this file's page loads to a minimum.
  test('the 7:30 huddle stub is labelled unfinished, and the health bar agrees', async ({ page }) => {
    await loadDashboardWithFixtures(page, { ceoBriefs: [HUDDLE_STUB, BRIEF_FIXTURES.ceoBriefs[1]] }, 'ceo-brief');
    await page.evaluate(() => switchTab('ceo-brief'));
    await page.waitForTimeout(1200);

    const panel = page.locator('#tab-ceo-brief');
    // says so in plain words, above the card
    await expect(panel).toContainText('not the finished brief');
    await expect(panel).toContainText('NOT FINISHED');
    // the useful half is still shown — hiding it until 9am would waste it
    await expect(panel).toContainText('Work the warm 20 out of GoHighLevel');
    await expect(panel).toContainText('Start here (10 min):');
    // and no invented money figures. The em-dash placeholders were the whole bug.
    const todayCard = (await panel.textContent()).split('Previous briefs')[0];
    expect(todayCard).not.toContain('Safe to act');
    expect(todayCard).not.toMatch(/\b(GREEN|AMBER|RED)\b/);

    // The stub also made the sync bar lie in both directions: "today's brief
    // arrived" went green off a stub, and "latest brief is complete" went red
    // every morning between 7:30 and 9am, which is a normal state by design.
    const results = await page.evaluate(() => {
      let cfg = null;
      const orig = window.registerSyncBar;
      window.registerSyncBar = (id, c) => { if (id === 'ceo-brief') cfg = c; };
      registerCeoBriefSyncBar();
      window.registerSyncBar = orig;
      const run = (prefix) => cfg.checks.find((c) => c.name.startsWith(prefix)).run();
      return { arrived: run("Today's brief arrived"), complete: run('Latest brief is complete') };
    });

    // "arrived" is allowed to pass on the calendar alone in two cases — a weekend,
    // when no brief is due at all, and before 10am on a weekday, when one may still
    // be on its way. After 10am on a weekday a stub must read as a failure. Assert
    // on whichever branch this run took, or the gate goes red every Saturday and
    // Sunday for a reason that has nothing to do with the code under test.
    if (results.arrived.status === 'fail') {
      expect(results.arrived.detail).toContain('7:30 huddle');
    } else {
      expect(results.arrived.detail).toMatch(/Weekend|Before 10am/);
    }
    // The completeness check must judge the newest FINISHED brief, not the stub.
    expect(results.complete.status).toBe('pass');
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
