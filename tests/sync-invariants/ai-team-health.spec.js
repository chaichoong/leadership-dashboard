// Invariant: the AI Team section of the Leadership Dashboard leads with ONE panel (Kevin, 15 Oct
// 2026), drawn from the Mac's Estate Status row ai-team-verdict (scripts/ai_team_health.py). It
// replaced the Agent Work, Defects, Bottleneck and Fix of a Fix cards, and the same day was made
// simpler (Kevin: the fourteen lines were "too cluttered and confusing"): one answer top right,
// ONE number ("Things needing a fix") against last week, weekly bars, and three lights. Tapping a
// light opens its lines exactly as before, so nothing is lost. A red light always shows, even when
// the number falls. A missing, stale, failed or unreadable row says so in plain words, and an
// older report (the Mac not yet on the new code) is drawn from its groups with no number.
//
// The fixture is shaped from the live dry run of 15 Oct 2026 (names invented: the repo is public).

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, loadDashboard } = require('./helpers');

const ESTATE = 'tblZVrdzivyBueZVf';
const ES = {
  key: 'fldLO6xJqkokvVR4g', status: 'fldhOUiva3bqPNk1c', lastRun: 'flduxV3TYwp9wQX9O',
  detail: 'fldLRFP2nJttDVQOa', payload: 'fldiqs9lvyLimoR7i',
};
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

const GROUPS = [['flow', 'Is work flowing?'], ['broken', 'Is anything broken?'], ['keep', 'Can it keep going?']];
// [key, group, question, colour, answer, number, unit, before, direction, fullWeek]
const SPEC = [
  ['emails', 'flow', 'Emails are getting cleared', 'green', 'Inbox clear', 0, '', 3, 'better', true],
  ['responses', 'flow', 'Responses are getting written', 'amber', '1 email task waiting for a draft', 1, '', null, null, false],
  ['moving', 'flow', "Everything's moving", 'red', '23 of 74 live tasks stuck (31%)', 31, '%', 28, 'worse', true],
  ['bottlenecks', 'flow', 'No bottlenecks', 'red', '11 blocked tasks past their limit', 11, '', null, null, false],
  ['carried', 'flow', 'Approved work gets carried out', 'green', 'Every approved job done', 0, '', null, null, false],
  ['agents', 'broken', 'Every agent is working', 'amber', '9 of 10 worked today', 1, '', null, null, false],
  ['jobs', 'broken', 'No job is broken', 'red', '3 jobs failed', 3, '', null, null, false],
  ['bugs', 'broken', 'No bugs or errors', 'red', '167 open, up from 149', 167, '', 149, 'worse', true],
  ['data', 'broken', 'The data is accurate', 'grey', "Can't tell: the data check has not run since Tue 13 Oct 06:42", null, '', null, null, false],
  ['missed', 'broken', "Nothing's getting missed", 'amber', '1 thing missed', 1, '', null, null, false],
  ['ontop', 'keep', 'Agents are on top of their work', 'amber', '147 done, 153 new in 7 days', 96, '%', 90, 'better', false],
  ['queue', 'keep', 'Your queue is under control', 'green', '7 cards, oldest under a day', 7, '', null, null, false],
  ['firsttime', 'keep', 'Drafts are right first time', 'green', '90% approved without changes', 90, '%', null, null, false],
  ['allowance', 'keep', 'Enough allowance to finish the week', 'green', 'No pause this week', 0, 'h', null, null, false],
];

const WEEKS = [
  { start: '2026-09-21', end: '2026-09-27', day: '2026-09-27', number: 71, atLeast: false, current: false },
  { start: '2026-09-28', end: '2026-10-04', day: null, number: null, atLeast: false, current: false },
  { start: '2026-10-05', end: '2026-10-11', day: '2026-10-11', number: 58, atLeast: false, current: false },
  { start: '2026-10-12', end: '2026-10-18', day: '2026-10-15', number: 46, atLeast: false, current: true },
];

function payload(over = {}) {
  const lines = SPEC.map(([key, group, question, colour, answer, number, unit, before, direction, fullWeek], i) => ({
    key, n: i + 1, group, question, colour, answer, number, unit, better: key === 'ontop' || key === 'firsttime' ? 'higher' : 'lower',
    rule: `Green means the ${question.toLowerCase()} rule holds.`,
    items: key === 'bottlenecks' ? [{ name: 'Reconnect the bank feed', id: 'recWALL1', note: 'KEVIN wall, 6.5 days (limit 3)' },
                                   { name: 'Fix the robot setup', id: 'recWALL2', note: 'TOOL wall, 8.0 days (limit 3)' }] : [],
    itemsTotal: key === 'bottlenecks' ? 11 : 0,
    extra: key === 'bugs' ? [['Code fixes waiting', 167], ['A week ago', 149], ['Fix of a fix (14 days)', '49% (41 of 84 fixes, baseline 32%)']]
      : key === 'moving' ? [['Live', 74], ['Waiting for your approval', 7], ['Waiting on a reply', 42], ['Scheduled for later', 72]]
      : key === 'bottlenecks' ? [['Waiting on a code fix', 25], ['Waiting on a step only you can do', 8]] : [],
    source: 'a fixture', why: colour === 'grey' ? 'the data check has not run since Tue 13 Oct 06:42' : undefined,
    count: ['bugs', 'ontop', 'firsttime'].includes(key) || colour === 'grey' ? null : number,
    trend: { vsDate: before == null ? null : (fullWeek ? '2026-10-08' : '2026-10-13'), before, after: number, direction,
             fullWeek, since: '2026-10-13' },
  }));
  return {
    version: 2, computedAt: minutesAgo(5),
    // The number fell (58 to 46) while "Something is broken" stayed red: the answer is amber and
    // still names the red light.
    verdict: { colour: 'amber', text: 'Getting better', reason: '46 things to fix, down from 58 last week. Still red: Work is held up, Something is broken',
               why: 'x', redLights: ['flow', 'broken'], turnedRed: [], worseLights: [] },
    headline: { number: 46, atLeast: false, parts: [], shared: 1, unread: [] },
    lastWeek: WEEKS[2], weeks: WEEKS, weeksSince: '2026-09-21',
    lights: [
      { key: 'flow', colour: 'red', title: 'Work is held up', text: '23 tasks stuck, 11 tasks blocked too long +1 more', lines: [] },
      { key: 'broken', colour: 'red', title: 'Something is broken', text: '3 jobs failing, code problems up 18 +3 more', lines: [] },
      { key: 'keep', colour: 'amber', title: 'It may not keep going', text: 'agents behind: 96% done', lines: [] },
    ],
    overall: { colour: 'red', text: "Needs attention: Everything's moving · 1 line can't be read: The data is accurate",
               worst: 'moving', red: 4, amber: 4, green: 5, grey: 1, greyLines: ['data'], better: 2, worse: 2 },
    groups: GROUPS.map(([key, title]) => ({ key, title, colour: key === 'keep' ? 'amber' : 'red',
      text: key === 'flow' ? '2 red, 1 amber' : key === 'broken' ? "2 red, 2 amber, 1 can't tell" : '1 amber' })),
    lines, history: {}, historyCheck: null, ...over,
  };
}

// `age` is how old the answer is: when the Mac worked it out (payload.computedAt). `runAge` is
// the row's Last Run, which moves on every pass, a failed one included.
const verdictRow = (age = 5, over = {}, p = payload(), runAge = age) => ({
  id: 'recVerdict', fields: {
    [ES.key]: 'ai-team-verdict', [ES.status]: 'Worked', [ES.lastRun]: minutesAgo(runAge),
    [ES.detail]: 'Getting better: 46 things need a fix (58 last week).',
    [ES.payload]: JSON.stringify({ ...p, computedAt: minutesAgo(age) }), ...over,
  },
});

// Register AFTER loadDashboard(): Playwright matches the newest handler first.
async function routeEstate(page, rows, status = 200) {
  await page.route('**/api.airtable.com/v0/**', async (route) => {
    if (route.request().method() === 'GET' && route.request().url().includes(ESTATE)) {
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { records: rows } : { error: 'x' }) });
    }
    return route.fallback();
  });
}

async function load(page, rows, status) {
  await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
  await loadDashboard(page);
  await routeEstate(page, rows, status);
  await page.evaluate(async () => await loadAiTeamHealth());
}

const panelText = (page) => page.evaluate(() => document.getElementById('aiHealthPanel').innerText);

// What the panel shows before anything is tapped.
const view = (page) => page.evaluate(() => {
  const p = document.getElementById('aiHealthPanel');
  const t = (sel) => { const e = p.querySelector(sel); return e ? e.textContent.trim() : null; };
  return {
    title: t('.aih-title'), answer: t('.aih-verdict-text'), answerCls: p.querySelector('.aih-verdict') && p.querySelector('.aih-verdict').className,
    reason: t('.aih-reason'), number: t('.aih-fix-num'), label: t('.aih-fix-label'), last: t('.aih-fix-last'), unread: t('.aih-unread'),
    bars: [...p.querySelectorAll('.aih-bar-col')].map(c => ({
      v: c.querySelector('.aih-bar-val').textContent, lab: c.querySelector('.aih-bar-lab').textContent,
      h: c.querySelector('.aih-bar') ? c.querySelector('.aih-bar').style.height : null,
    })),
    barsStale: !!p.querySelector('.aih-bars-stale'), barsEmpty: t('.aih-bars-empty'),
    lights: [...p.querySelectorAll('.aih-light')].map(b => ({
      dot: b.querySelector('.aih-dot').className.replace('aih-dot ', ''), label: b.querySelector('.aih-dot').getAttribute('aria-label'),
      title: b.querySelector('.aih-light-title').textContent, text: b.querySelector('.aih-light-text') ? b.querySelector('.aih-light-text').textContent : '',
    })),
    visibleLines: [...p.querySelectorAll('.aih-line')].filter(b => b.offsetParent !== null).length,
    allLines: p.querySelectorAll('.aih-line').length,
  };
});

test.describe('AI team panel: one number, weekly bars, three lights', () => {
  test('one answer, the number against last week, weekly bars and three lights; the fourteen lines wait behind the lights', async ({ page }) => {
    await load(page, [verdictRow()]);
    const v = await view(page);
    expect(v.title).toBe('AI team');
    expect(v.answer).toBe('Getting better');
    expect(v.answerCls).toContain('aih-verdict-amber');
    expect(v.reason).toMatch(/^46 things to fix, down from 58 last week\. Still red: Work is held up, Something is broken Updated /);
    expect(v.label).toBe('Things needing a fix');
    expect(v.number).toBe('46');
    expect(v.last).toBe('last week: 58');
    expect(v.unread).toBeNull();
    // Oldest first, a week with no number keeps its place with no bar, this week is labelled.
    expect(v.bars).toEqual([
      { v: '71', lab: '21 Sept', h: '100%' }, { v: '-', lab: '28 Sept', h: null },
      { v: '58', lab: '5 Oct', h: '82%' }, { v: '46', lab: 'This week', h: '65%' }]);
    // A red light shows red even though the number fell, with what is wrong under it.
    expect(v.lights).toEqual([
      { dot: 'aih-red', label: 'Red', title: 'Work is held up', text: '23 tasks stuck, 11 tasks blocked too long +1 more' },
      { dot: 'aih-red', label: 'Red', title: 'Something is broken', text: '3 jobs failing, code problems up 18 +3 more' },
      { dot: 'aih-amber', label: 'Amber', title: 'It may not keep going', text: 'agents behind: 96% done' }]);
    expect(v.allLines).toBe(14);
    expect(v.visibleLines).toBe(0);                                   // no clutter until a light is tapped
    expect(await page.evaluate(() => aiTeamCheck())).toMatchObject({ status: 'warn', detail: expect.stringMatching(/1 line can't be read$/) });
  });

  test('a green light shows no words; the bars carry their numbers for a screen reader', async ({ page }) => {
    const p = payload();
    p.lights[2] = { key: 'keep', colour: 'green', title: 'It can keep going', text: 'should not show' };
    await load(page, [verdictRow(5, {}, p)]);
    const v = await view(page);
    expect(v.lights[2]).toEqual({ dot: 'aih-green', label: 'Green', title: 'It can keep going', text: '' });
    expect(await page.locator('#aiHealthPanel .aih-bars').getAttribute('aria-label'))
      .toBe('Things needing a fix each week, oldest first. 21 Sept: 71, 28 Sept: no number, 5 Oct: 58, This week: 46. Shorter is better.');
  });

  test('tapping a light opens its lines exactly as before; a line opens its rule, its list and the old card\'s numbers', async ({ page }) => {
    await load(page, [verdictRow()]);
    const broken = page.locator('.aih-light', { hasText: 'Something is broken' });
    const group = page.locator('#aihl-broken');
    await expect(group).toBeHidden();
    await broken.click();
    await expect(broken).toHaveAttribute('aria-expanded', 'true');
    await expect(group).toBeVisible();
    await expect(group.locator('.aih-q')).toHaveText(['Every agent is working', 'No job is broken', 'No bugs or errors',
      'The data is accurate', "Nothing's getting missed"]);
    await expect(page.locator('#aihl-flow')).toBeHidden();             // only the tapped light opens
    // A line inside opens as it always did: the old Defects and Fix of a Fix numbers live on here.
    await group.locator('.aih-line', { hasText: 'No bugs or errors' }).click();
    await expect(page.locator('#aihd-bugs')).toContainText('Fix of a fix (14 days)');
    await expect(page.locator('#aihd-bugs')).toContainText('49% (41 of 84 fixes, baseline 32%)');
    await group.locator('.aih-line', { hasText: 'The data is accurate' }).click();
    await expect(page.locator('#aihd-data')).toContainText("Why it can't tell: the data check has not run since Tue 13 Oct 06:42.");
    // The flow light holds the bottleneck list and the old Bottleneck card's split.
    await page.locator('.aih-light', { hasText: 'Work is held up' }).click();
    await page.locator('#aihl-flow .aih-line', { hasText: 'No bottlenecks' }).click();
    await expect(page.locator('#aihd-bottlenecks .aih-items li')).toHaveText([
      'Reconnect the bank feed · KEVIN wall, 6.5 days (limit 3)', 'Fix the robot setup · TOOL wall, 8.0 days (limit 3)', 'and 9 more']);
    await expect(page.locator('#aihd-bottlenecks')).toContainText('Waiting on a code fix');
    // The trend on a line is drawn as before.
    await expect(page.locator('#aihl-flow .aih-line', { hasText: "Everything's moving" }).locator('.aih-trend'))
      .toHaveText('↑ was 28% last week (worse than last week)');
    await broken.click();
    await expect(group).toBeHidden();
  });

  test('fewer than two weeks with a number: no chart, it says when the bars start', async ({ page }) => {
    const p = payload({ weeks: [WEEKS[3]], weeksSince: '2026-10-15', lastWeek: null,
      verdict: { colour: 'grey', text: "Can't tell", reason: 'No number from last week to compare with yet. Still red: Work is held up, Something is broken' } });
    await load(page, [verdictRow(5, {}, p)]);
    const v = await view(page);
    expect(v.barsEmpty).toBe('Weekly bars build from 15 Oct.');
    expect(v.bars).toEqual([]);
    expect(v.last).toBe('last week: no number yet');
    expect(v.answer).toBe("Can't tell");
    expect(v.answerCls).toContain('aih-verdict-grey');
    // The red lights still show red under a grey answer.
    expect(v.lights.map(l => l.dot)).toEqual(['aih-red', 'aih-red', 'aih-amber']);
  });

  test('a number with a check it could not read says "at least" and names the check', async ({ page }) => {
    const p = payload({ headline: { number: 46, atLeast: true, parts: [], shared: 0,
      unread: [{ key: 'data', question: 'The data is accurate', why: 'not run' }, { key: 'jobs', question: 'No job is broken', why: 'read only in part' }] } });
    p.weeks = WEEKS.map(w => (w.current ? { ...w, atLeast: true } : w));
    await load(page, [verdictRow(5, {}, p)]);
    const v = await view(page);
    expect(v.number).toBe('at least 46');
    expect(v.unread).toBe('Could not read all of: The data is accurate, No job is broken.');
    expect(v.bars[3]).toMatchObject({ v: '46+', lab: 'This week' });
  });

  // Review of PR #790, items 1 and 6: the age is the ANSWER's (payload.computedAt), never the
  // row's Last Run, and a stale answer is never drawn in its old colours.
  test('an answer over two hours old turns the answer, the lights, the bars and every dot grey, however fresh the Last Run', async ({ page }) => {
    await load(page, [verdictRow(180, {}, payload(), 3)]);
    const v = await view(page);
    expect(v.answer).toMatch(/^Not updated since /);
    expect(v.answerCls).toContain('aih-verdict-grey');
    expect(v.reason).toMatch(/^The Mac's report has stopped, so these numbers may be out of date\. Its last answer: Getting better\./);
    // A grey light never carries a claim: it shows its question.
    expect(v.lights).toEqual([
      { dot: 'aih-grey', label: "Can't tell", title: 'Is work flowing?', text: 'Not updated' },
      { dot: 'aih-grey', label: "Can't tell", title: 'Is anything broken?', text: 'Not updated' },
      { dot: 'aih-grey', label: "Can't tell", title: 'Can it keep going?', text: 'Not updated' }]);
    expect(v.barsStale).toBe(true);
    const dots = await page.evaluate(() => [...document.querySelectorAll('#aiHealthPanel .aih-dot')].map(d => d.className));
    expect(dots).toHaveLength(18);                                     // the answer, 3 lights and 14 lines
    expect(dots.every(c => c === 'aih-dot aih-grey')).toBe(true);
    expect(await page.evaluate(() => document.querySelectorAll('#aiHealthPanel .aih-trend.aih-better, #aiHealthPanel .aih-trend.aih-worse').length)).toBe(0);
    expect(await page.evaluate(() => aiTeamCheck())).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^Not updated since/) });
  });

  test('an older report (no number yet) is drawn from its groups and says the number comes on the next run', async ({ page }) => {
    const p = payload();
    for (const k of ['verdict', 'headline', 'lastWeek', 'weeks', 'weeksSince', 'lights']) delete p[k];
    p.version = 1;
    await load(page, [verdictRow(5, {}, p)]);
    const v = await view(page);
    expect(v.answer).toBe("Can't tell");
    expect(v.number).toBe('not known yet');
    expect(v.reason).toMatch(/^The Mac is still sending its older report\. The number and weekly bars appear on its next run/);
    expect(v.bars).toEqual([]);
    expect(v.lights.map(l => [l.dot, l.title, l.text])).toEqual([
      ['aih-red', 'Work is held up', '2 red, 1 amber'],
      ['aih-red', 'Something is broken', "2 red, 2 amber, 1 can't tell"],
      ['aih-amber', 'It may not keep going', '1 amber']]);
    expect((await page.evaluate(() => aiTeamCheck())).detail).toMatch(/still sending its older report/);
  });

  test('the four old cards are gone, and the north-star cards stay below under their heading', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await page.waitForFunction(() => document.querySelectorAll('#aiTeamCards .kpi-card').length >= 4, null, { timeout: 15000 });
    const where = await page.evaluate(() => {
      const grid = document.getElementById('aiTeamCards');
      const order = [...grid.children].map(c => c.id || c.textContent.trim().slice(0, 40));
      const label = (t) => [...grid.querySelectorAll('.kpi-card-label')].some(el => el.textContent.replace('▸', '').trim() === t);
      return {
        old: ['aiWorkCard', 'aiDefectsCard', 'aiBlockedCard', 'aiReworkCard'].filter(id => document.getElementById(id)),
        order, share: label('Work Done by AI'), saved: label('AI Time & Money Saved'),
        agents: label('AI Agents'), approvals: label('Agent Approvals'),
      };
    });
    expect(where.old).toEqual([]);
    expect(where.order[0]).toBe('aiHealthPanel');
    expect(where.order[1]).toBe('North star: how much work AI does');
    expect(where.order.slice(2, 4)).toEqual(['aiShareCard', 'aiSavedCard']);
    expect(where.share && where.saved && where.agents && where.approvals).toBe(true);
    // The 15-minute refresh runs the same path and must not duplicate the panel.
    await page.evaluate(() => loadDashboard());
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => document.querySelectorAll('#aiHealthPanel').length)).toBe(1);
  });

  test('no row yet: says the Mac has not written it, and the health check fails', async ({ page }) => {
    await load(page, []);
    expect(await panelText(page)).toContain("Can't read the Mac's report: it has not written the AI team answer yet.");
    expect(await page.evaluate(() => document.querySelectorAll('#aiHealthPanel .aih-light, #aiHealthPanel .aih-line').length)).toBe(0);
    expect((await page.evaluate(() => aiTeamCheck())).status).toBe('fail');
  });

  test('Airtable not answering: says so, never a calm panel', async ({ page }) => {
    await load(page, [], 500);
    expect(await panelText(page)).toContain("Can't read the Mac's report: Airtable did not answer. Refresh to retry.");
    expect((await page.evaluate(() => aiTeamCheck())).status).toBe('warn');
  });

  test('a failed row with no answer shows its reason in red; a fresh healthy row passes the check', async ({ page }) => {
    await load(page, [verdictRow(5, { [ES.status]: 'Failed', [ES.detail]: 'The AI team verdict could not be built: KeyError: x', [ES.payload]: undefined })]);
    await expect(page.locator('#aiHealthPanel .aih-notice-red')).toHaveText("Can't read the Mac's report: The AI team verdict could not be built: KeyError: x");
    expect(await page.evaluate(() => document.querySelectorAll('#aiHealthPanel .aih-fix').length)).toBe(0);
    const healthy = payload({ overall: { colour: 'green', text: 'Healthy', red: 0, amber: 1, green: 13, grey: 0, greyLines: [] },
      verdict: { colour: 'green', text: 'Working well', reason: '3 things to fix' }, headline: { number: 3, atLeast: false, unread: [] } });
    await routeEstate(page, [verdictRow(5, {}, healthy)]);
    await page.evaluate(async () => await loadAiTeamHealth());
    await expect(page.locator('#aiHealthPanel .aih-verdict-text')).toHaveText('Working well');
    await expect(page.locator('#aiHealthPanel .aih-fix-num')).toHaveText('3');
    expect((await page.evaluate(() => aiTeamCheck())).status).toBe('pass');
  });

  test('payload text never runs as HTML, and an unknown colour is drawn grey', async ({ page }) => {
    const p = payload();
    p.lines[0].answer = '<img src=x onerror="window.__aiXss=1">';
    p.lines[0].colour = 'red" onmouseover="window.__aiXss=2';
    p.lines[3].items = [{ name: '<b id="aiInjected">x</b>' }];
    p.verdict.text = '<script>window.__aiXss=3</script>';
    p.verdict.reason = '<img src=x onerror="window.__aiXss=4">';
    p.lights[0].title = '<img src=x onerror="window.__aiXss=5">';
    p.lights[1].text = '<b id="aiInjected2">x</b>';
    p.lights[2].colour = 'amber" onclick="window.__aiXss=6';
    p.headline.number = '<b id="aiInjected3">1</b>';
    p.weeks[0].number = '<b id="aiInjected4">1</b>';
    p.weeksSince = '<b id="aiInjected5">x</b>';
    await load(page, [verdictRow(5, {}, p)]);
    await page.locator('.aih-light').first().click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__aiXss)).toBeUndefined();
    expect(await page.evaluate(() => document.querySelectorAll('#aiHealthPanel img, #aiHealthPanel script, #aiInjected, #aiInjected2, #aiInjected3, #aiInjected4, #aiInjected5').length)).toBe(0);
    expect(await page.evaluate(() => document.querySelector('#aiHealthPanel .aih-line .aih-dot').className)).toBe('aih-dot aih-grey');
    expect(await page.evaluate(() => document.querySelectorAll('#aiHealthPanel .aih-light .aih-dot')[2].className)).toBe('aih-dot aih-grey');
    expect(await page.locator('#aiHealthPanel .aih-fix-num').textContent()).toBe('not known');   // never a number it cannot read
  });

  test('the panel says it is checking while Airtable answers, never sits blank', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await page.route('**/api.airtable.com/v0/**', async (route) => {
      if (route.request().method() === 'GET' && route.request().url().includes(ESTATE)) {
        await new Promise((r) => setTimeout(r, 1500));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: [verdictRow()] }) });
      }
      return route.fallback();
    });
    await page.evaluate(() => { document.getElementById('aiHealthPanel').innerHTML = ''; window.__aiLoad = loadAiTeamHealth(); });
    expect(await panelText(page)).toContain('Checking the AI team…');
    await page.evaluate(async () => await window.__aiLoad);
    expect(await page.evaluate(() => document.querySelectorAll('#aiHealthPanel .aih-light').length)).toBe(3);
  });

  test('fits a phone: the lights stack and nothing is wider than the screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await load(page, [verdictRow()]);
    await page.locator('.aih-light', { hasText: 'Something is broken' }).click();
    const fit = await page.evaluate(() => {
      const panel = document.getElementById('aiHealthPanel');
      const w = panel.getBoundingClientRect().right;
      const lights = [...panel.querySelectorAll('.aih-light')].map(e => e.getBoundingClientRect());
      return {
        over: [...panel.querySelectorAll('.aih-light, .aih-verdict, .aih-bars, .aih-fix, .aih-line')]
          .filter(e => e.offsetParent !== null && e.getBoundingClientRect().right > w + 1).length,
        stacked: lights[1].top > lights[0].bottom - 1 && lights[2].top > lights[1].bottom - 1,
      };
    });
    expect(fit.over).toBe(0);
    expect(fit.stacked).toBe(true);
  });
});
