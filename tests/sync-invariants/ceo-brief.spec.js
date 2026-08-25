// CEO Brief tab — render invariants.
// The brief moved from its own shell tab into the AI Agents page (os/agents/
// index.html, CEO Brief tab) on 25 Aug 2026; js/ceo-brief.js was deleted.
// The tab READS the CEO Briefs table and renders today's brief card plus
// history. The worker writes the table; the tab never writes. Regression
// targets: tab renders from fixture data, today's card is highlighted, the
// huddle stub is labelled unfinished, the health checks agree, and the empty
// state never blanks.
//
// Fixtures are keyed by FIELD ID, matching the real returnFieldsByFieldId=true
// response. Both sides moved off field names on 2026-07-29 so the drift
// monitor can see this table; keying the fixture by name here would let the
// tab regress to names and still pass.

const { test, expect } = require('@playwright/test');
const { CEO, defaultFixtures, mockAgentsPage, loadAgentsPage, londonTodayISO, isLondonWeekend } = require('./agents-page.helpers');

const BRIEFS = defaultFixtures().ceoBriefs;

// The 07:30 department huddle's half-written record: the one thing, the first
// step and the flags, and nothing the 09:00 worker adds.
const HUDDLE_STUB = {
  id: 'recBriefStub',
  fields: {
    [CEO.date]: londonTodayISO(),
    [CEO.oneThing]: 'Work the warm 20 out of GoHighLevel',
    [CEO.firstStep]: 'Pull the 20 names into one list. Ten minutes.',
    [CEO.boardFlags]: 'Belfort: the contract is still at old terms.',
  },
};

async function openBriefTab(page) {
  await page.evaluate(() => switchAgentsView('ceo-brief'));
  await page.waitForTimeout(300);
}

test.describe('CEO Brief tab on the AI Agents page', () => {
  test('renders today’s brief and history from the briefs table', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openBriefTab(page);

    const panel = page.locator('#zoneCeoBrief');
    await expect(panel).toBeVisible();
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
    // A finished brief carries no unfinished labelling — read the marker
    // backwards and every real 9am brief wears an alarming banner, which is
    // how a warning stops being read.
    await expect(panel).not.toContainText('not the finished brief');
    await expect(panel).not.toContainText('NOT FINISHED');
  });

  test('shows what was handed off, and omits the section when empty', async ({ page }) => {
    // The brief's whole job is keeping work OFF Kevin: it routes to a named AI
    // agent first, then the team. If the tab silently drops that list,
    // delegated work looks like it vanished.
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openBriefTab(page);

    const panel = page.locator('#zoneCeoBrief');
    await expect(panel).toContainText('Not yours today, handed off:');
    await expect(panel).toContainText('worker-writer — draft the warm-20 re-engagement message');
    await expect(panel).toContainText('Mica — chase the UC verification');
    // one line per destination, not one run-on blob
    await expect(panel.locator('li', { hasText: 'worker-writer' })).toHaveCount(1);
  });

  test('a brief with nothing handed off omits the section entirely', async ({ page }) => {
    const noneHanded = [{ ...BRIEFS[0], fields: { ...BRIEFS[0].fields, [CEO.handedOff]: '' } }];
    await mockAgentsPage(page, { ceoBriefs: noneHanded });
    await loadAgentsPage(page);
    await openBriefTab(page);
    await expect(page.locator('#zoneCeoBrief')).not.toContainText('handed off');
  });

  // ── The 07:30 huddle stub ─────────────────────────────────────────────
  // Found by the drift monitor 2026-07-31. The brief is written in two
  // stages; the tab used to ask only "is there a record dated today?", so for
  // 90 minutes every weekday the stub rendered as a finished brief. Full
  // Brief is the stage-two marker, and the worker uses exactly this test on
  // the write side (gatherHuddle). These tests fail without that fix.
  test('the 7:30 huddle stub is labelled unfinished, and the health checks agree', async ({ page }) => {
    await mockAgentsPage(page, { ceoBriefs: [HUDDLE_STUB, BRIEFS[1]] });
    await loadAgentsPage(page);
    await openBriefTab(page);

    const panel = page.locator('#zoneCeoBrief');
    // Says so in plain words, above the card. At the weekend a stub is FINAL
    // (the 9am robot never runs), so the tab must say that instead of
    // promising a brief that cannot come.
    if (isLondonWeekend()) {
      await expect(panel).toContainText('no 9am brief at the weekend');
      await expect(panel).not.toContainText('NOT FINISHED');
    } else {
      await expect(panel).toContainText('not the finished brief');
      await expect(panel).toContainText('NOT FINISHED');
    }
    // the useful half is still shown — hiding it until 9am would waste it
    await expect(panel).toContainText('Work the warm 20 out of GoHighLevel');
    await expect(panel).toContainText('Start here (10 min):');
    // and no invented money figures. The em-dash placeholders were the whole bug.
    const todayCard = (await panel.textContent()).split('Previous briefs')[0];
    expect(todayCard).not.toContain('Safe to act');
    expect(todayCard).not.toMatch(/\b(GREEN|AMBER|RED)\b/);

    // The stub also made the health checks lie in both directions: "today's
    // brief arrived" went green off a stub, and "latest brief is complete"
    // went red every morning between 7:30 and 9am, a normal state by design.
    const results = await page.evaluate(() => {
      let cfg = null;
      const orig = window.registerSyncBar;
      window.registerSyncBar = (id, c) => { if (id === 'agents') cfg = c; };
      registerAgentsSyncBar();
      window.registerSyncBar = orig;
      const run = (prefix) => cfg.checks.find((c) => c.name.startsWith(prefix)).run();
      return { arrived: run("Today's brief arrived"), complete: run('Latest brief is complete') };
    });

    // "arrived" is allowed to pass on the calendar alone in two cases — a
    // weekend, when no brief is due, and before 10am on a weekday, when one
    // may still be on its way. After 10am on a weekday a stub must read as a
    // failure. Assert on whichever branch this run took.
    if (results.arrived.status === 'fail') {
      expect(results.arrived.detail).toContain('morning huddle');
    } else {
      expect(results.arrived.detail).toMatch(/Weekend|Before 10am/);
    }
    // The completeness check must judge the newest FINISHED brief, not the stub.
    expect(results.complete.status).toBe('pass');
  });

  test('a weekend huddle stub in history is labelled as such, not as unfinished', async ({ page }) => {
    // 9 and 16 Aug 2026 (both Sundays) were huddle stubs with no Full Brief.
    // The worker correctly refuses weekends, so nothing was ever going to
    // finish them, yet the tab filed them as "NOT FINISHED" and promised the
    // money light at 9am. Any weekend stub is labelled honestly instead.
    const sundayStub = {
      id: 'recSundayStub',
      fields: {
        [CEO.date]: '2026-08-16',
        [CEO.oneThing]: 'Sunday board note',
        [CEO.firstStep]: 'Nothing until Monday',
        [CEO.boardFlags]: 'Keller: rest is part of the plan.',
      },
    };
    await mockAgentsPage(page, { ceoBriefs: [BRIEFS[0], sundayStub] });
    await loadAgentsPage(page);
    await openBriefTab(page);

    const history = (await page.locator('#zoneCeoBrief').textContent()).split('Previous briefs')[1] || '';
    expect(history).toContain('Sunday board note');
    expect(history).toContain('Weekend huddle');
    expect(history).toContain('no 9am brief at weekends');
    expect(history).not.toContain('NOT FINISHED');
    expect(history).not.toContain('land at 9am');
  });

  test('the header links to the visual workflow page', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openBriefTab(page);
    const link = page.locator('#zoneCeoBrief a[href="../../ceo-brief-workflow.html"]');
    await expect(link).toHaveCount(1);
    await expect(link).toContainText('How it works');
  });

  test('empty table shows a friendly state, never a blank tab', async ({ page }) => {
    await mockAgentsPage(page, { ceoBriefs: [] });
    await loadAgentsPage(page);
    await openBriefTab(page);
    const panel = page.locator('#zoneCeoBrief');
    if (isLondonWeekend()) {
      await expect(panel).toContainText('No brief today');
    } else {
      await expect(panel).toContainText("Today's brief has not arrived yet");
    }
    await expect(panel).toContainText('No briefs stored yet');
  });
});
