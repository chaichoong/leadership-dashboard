// Invariant: the AI Team section of the Leadership Dashboard (Kevin, 9 Oct 2026; brain
// Decisions/2026-10-09) shows the four health numbers from the Mac's Estate Status rows,
// holds the four AI cards that used to sit in the operational section, and never shows a
// stale or failed row as a calm number.
//
// The fixture is the live state read on 9 Oct 2026: 178 agent tasks open, 40 not moving,
// 164 in and 119 done in 7 days; 207 defects open, 95 filed and 14 fixed; 26 robots
// blocked (17 TOOL, 7 KEVIN, 2 SIGN-IN); 43 of 105 fixes a fix of a fix (41%, baseline 32%).

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, loadDashboard } = require('./helpers');

const ESTATE = 'tblZVrdzivyBueZVf';
const ES = {
  key: 'fldLO6xJqkokvVR4g', status: 'fldhOUiva3bqPNk1c', lastRun: 'flduxV3TYwp9wQX9O',
  detail: 'fldLRFP2nJttDVQOa', payload: 'fldiqs9lvyLimoR7i',
};

const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

const healthRow = (age = 5, over = {}) => ({
  id: 'recHealth', fields: {
    [ES.key]: 'ai-team-health', [ES.status]: 'Worked', [ES.lastRun]: minutesAgo(age),
    [ES.detail]: 'Agent work: 178 open ...',
    [ES.payload]: JSON.stringify({
      work: { open: 178, notMoving: 40, created7d: 164, done7d: 119 },
      defects: { open: 207, filed7d: 95, fixed7d: 14 },
      rework: { days: 14, fixes: 105, fixOfFix: 43, pct: 41, baselinePct: 32 },
    }),
    ...over,
  },
});

const wall = (kind, n) => Array.from({ length: n }, (_, i) => ({ task: `rec${kind}${i}`, kind }));
const blockersRow = (age = 5) => ({
  id: 'recBlockers', fields: {
    [ES.key]: 'agent-blockers', [ES.status]: 'Failed', [ES.lastRun]: minutesAgo(age),
    [ES.detail]: 'Robots blocked on 26 tasks.',
    [ES.payload]: JSON.stringify({ open: [...wall('TOOL', 17), ...wall('KEVIN', 7), ...wall('SIGN-IN', 2)] }),
  },
});

// Register AFTER loadDashboard(): Playwright matches the newest handler first.
async function routeEstate(page, rows) {
  await page.route('**/api.airtable.com/v0/**', async (route) => {
    if (route.request().method() === 'GET' && route.request().url().includes(ESTATE)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: rows }) });
    }
    return route.fallback();
  });
}

const card = (page, id) => page.evaluate((cid) => {
  const c = document.getElementById(cid);
  if (!c) return null;
  const v = c.querySelector('.kpi-card-value');
  const s = c.querySelector('.kpi-card-sub');
  return { head: v ? v.textContent.trim() : '', cls: v ? v.className : '', sub: s ? s.textContent.trim() : '',
           inSection: !!c.closest('#aiTeamCards') };
}, id);

test.describe('AI Team section', () => {
  test('shows the four health numbers from the 9 Oct worked example', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await routeEstate(page, [healthRow(), blockersRow()]);
    await page.evaluate(async () => await loadAiTeamHealth());

    const work = await card(page, 'aiWorkCard');
    expect(work.head).toBe('178 open');
    expect(work.sub).toBe('40 not moving · 7 days: 164 in, 119 done');
    expect(work.cls).toContain('text-amber');           // more in than done

    const defects = await card(page, 'aiDefectsCard');
    expect(defects.head).toBe('207 open');
    expect(defects.sub).toBe('7 days: 95 filed, 14 fixed');
    expect(defects.cls).toContain('text-red');          // filed beats fixed

    const blocked = await card(page, 'aiBlockedCard');
    expect(blocked.head).toBe('26 blocked');
    expect(blocked.sub).toBe('Biggest: 17 waiting on a code fix · 9 need you');
    expect(blocked.cls).toContain('text-red');          // the sweep's own red

    const rework = await card(page, 'aiReworkCard');
    expect(rework.head).toBe('41%');
    expect(rework.sub).toBe('43 of 105 fixes in 14 days · baseline 32%');
    expect(rework.cls).toContain('text-red');           // over 40%
  });

  test('holds all eight AI cards, and the operational section none of them', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    // By label, not id: some cards replace their slot with an element that carries no id.
    // The label is upper-cased by CSS, so match case-insensitively on textContent.
    const LABELS = ['Agent Work', 'Defects', 'Bottleneck', 'Fix of a Fix',
      'AI Agents', 'Agent Approvals', 'Work Done by AI', 'AI Time & Money Saved'];
    await page.waitForFunction((n) => document.querySelectorAll('#aiTeamCards .kpi-card').length >= n, LABELS.length, { timeout: 15000 });
    const where = await page.evaluate((labels) => labels.map(label => {
      const has = (sel) => [...document.querySelectorAll(`${sel} .kpi-card-label`)]
        .some(el => el.textContent.replace('▸', '').trim().toLowerCase() === label.toLowerCase());
      return { label, inSection: has('#aiTeamCards'), inOps: has('#operationalCards') };
    }), LABELS);
    for (const w of where) {
      expect(w.inSection, `${w.label} not in the AI Team section`).toBe(true);
      expect(w.inOps, `${w.label} still in the operational section`).toBe(false);
    }
    // A second load (the 15-minute refresh runs the same path) must not duplicate the cards.
    await page.evaluate(() => loadDashboard());
    await page.waitForTimeout(2500);
    const count = await page.evaluate(() => document.querySelectorAll('#aiTeamCards .kpi-card').length);
    expect(count).toBe(LABELS.length);
  });

  test('a row over two hours old says so and goes amber', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await routeEstate(page, [healthRow(180), blockersRow(180)]);
    await page.evaluate(async () => await loadAiTeamHealth());
    for (const id of ['aiWorkCard', 'aiDefectsCard', 'aiBlockedCard', 'aiReworkCard']) {
      const c = await card(page, id);
      expect(c.sub, id).toMatch(/^Not updated since /);
      expect(c.cls, id).toContain('text-amber');
    }
  });

  test('a failed row shows its reason, never a number', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await routeEstate(page, [
      { id: 'recHealth', fields: { [ES.key]: 'ai-team-health', [ES.status]: 'Failed', [ES.lastRun]: minutesAgo(5),
        [ES.detail]: 'The defect queue or the rework rate could not be read: rework-rate.py exited 1' } },
      blockersRow(),
    ]);
    await page.evaluate(async () => await loadAiTeamHealth());
    const rework = await card(page, 'aiReworkCard');
    expect(rework.head).toBe('—');
    expect(rework.sub).toContain('rework-rate.py exited 1');
    expect(rework.cls).toContain('text-red');
  });
});
