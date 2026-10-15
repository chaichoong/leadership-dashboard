// Invariant: the AI Team section of the Leadership Dashboard leads with ONE panel, "Is the AI
// team healthy?" (Kevin, 15 Oct 2026): a verdict, three groups and fourteen lines from the Mac's
// Estate Status row ai-team-verdict (scripts/ai_team_health.py). It replaced the Agent Work,
// Defects, Bottleneck and Fix of a Fix cards. A missing, stale, failed or unreadable row says so
// in plain words, a line the Mac could not read is grey and named, and the two north-star cards
// stay below under their own heading.
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
    trend: { vsDate: before == null ? null : (fullWeek ? '2026-10-08' : '2026-10-13'), before, after: number, direction,
             fullWeek, since: '2026-10-13' },
  }));
  return {
    version: 1, computedAt: minutesAgo(5),
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
    [ES.detail]: 'Needs attention. 5 green, 4 amber, 4 red, 1 can\'t tell.',
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

test.describe('Is the AI team healthy? panel', () => {
  test('one verdict, three groups and fourteen lines, each with a dot, its question, a short answer and a trend', async ({ page }) => {
    await load(page, [verdictRow()]);
    const v = await page.evaluate(() => {
      const p = document.getElementById('aiHealthPanel');
      return {
        verdict: p.querySelector('.aih-verdict-text').textContent,
        verdictCls: p.querySelector('.aih-verdict').className,
        groups: [...p.querySelectorAll('.aih-group-title')].map(e => e.textContent),
        lines: [...p.querySelectorAll('.aih-line')].map(b => ({
          dot: b.querySelector('.aih-dot').className.replace('aih-dot ', ''),
          label: b.querySelector('.aih-dot').getAttribute('aria-label'),
          q: b.querySelector('.aih-q').textContent, a: b.querySelector('.aih-a').textContent,
          t: b.querySelector('.aih-trend').textContent.trim(), tc: b.querySelector('.aih-trend').className,
        })),
      };
    });
    expect(v.verdict).toBe("Needs attention: Everything's moving · 1 line can't be read: The data is accurate");
    expect(v.verdictCls).toContain('aih-verdict-red');
    expect(v.groups).toEqual(['Is work flowing?', 'Is anything broken?', 'Can it keep going?']);
    expect(v.lines).toHaveLength(14);
    expect(v.lines.map(l => l.q)).toEqual(SPEC.map(s => s[2]));
    expect(v.lines[0]).toMatchObject({ dot: 'aih-green', label: 'Green', a: 'Inbox clear' });
    expect(v.lines[0].t).toBe('↓ was 3 last week (better than last week)');
    expect(v.lines[0].tc).toContain('aih-better');
    expect(v.lines[2].t).toBe('↑ was 28% last week (worse than last week)');   // the unit rides with the number
    expect(v.lines[2].tc).toContain('aih-worse');
    expect(v.lines[7].t).toBe('↑ was 149 last week (worse than last week)');
    // Before a week of history exists, the arrow says where the trend runs from.
    expect(v.lines[10].t).toBe('↑ trend from 13 Oct: was 90% (better than 13 Oct)');
    expect(v.lines[1].t).toBe('trend from 13 Oct');
    // A grey line: its dot, its answer, and no trend at all.
    expect(v.lines[8]).toMatchObject({ dot: 'aih-grey', label: "Can't tell", t: '' });
    expect(v.lines[8].a).toMatch(/^Can't tell: /);
    expect(await panelText(page)).toContain("4 red · 1 can't tell");
    expect(await page.evaluate(() => aiTeamCheck())).toMatchObject({ status: 'warn', detail: expect.stringMatching(/1 line can't be read$/) });
  });

  test('tapping a line opens its rule, its list and the old card\'s numbers; tapping again closes it', async ({ page }) => {
    await load(page, [verdictRow()]);
    const bottleneck = page.locator('.aih-line', { hasText: 'No bottlenecks' });
    const detail = page.locator('#aihd-bottlenecks');
    await expect(detail).toBeHidden();
    await bottleneck.click();
    await expect(bottleneck).toHaveAttribute('aria-expanded', 'true');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('Green means the no bottlenecks rule holds.');
    await expect(detail.locator('.aih-items li')).toHaveText([
      'Reconnect the bank feed · KEVIN wall, 6.5 days (limit 3)', 'Fix the robot setup · TOOL wall, 8.0 days (limit 3)', 'and 9 more']);
    await expect(detail).toContainText('Waiting on a code fix');                // the old Bottleneck card's split
    await bottleneck.click();
    await expect(detail).toBeHidden();
    // The old Defects and Fix of a Fix numbers live on inside No bugs or errors.
    await page.locator('.aih-line', { hasText: 'No bugs or errors' }).click();
    await expect(page.locator('#aihd-bugs')).toContainText('Fix of a fix (14 days)');
    await expect(page.locator('#aihd-bugs')).toContainText('49% (41 of 84 fixes, baseline 32%)');
    // A grey line says why it cannot tell.
    await page.locator('.aih-line', { hasText: 'The data is accurate' }).click();
    await expect(page.locator('#aihd-data')).toContainText("Why it can't tell: the data check has not run since Tue 13 Oct 06:42.");
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
    expect(await page.evaluate(() => document.querySelectorAll('#aiHealthPanel .aih-line').length)).toBe(0);
    expect((await page.evaluate(() => aiTeamCheck())).status).toBe('fail');
  });

  test('Airtable not answering: says so, never a calm panel', async ({ page }) => {
    await load(page, [], 500);
    expect(await panelText(page)).toContain("Can't read the Mac's report: Airtable did not answer. Refresh to retry.");
    expect((await page.evaluate(() => aiTeamCheck())).status).toBe('warn');
  });

  // Review of PR #790, items 1 and 6: the age is the ANSWER's (payload.computedAt), never the
  // row's Last Run, and a stale answer is never drawn in its old colours.
  test('an answer over two hours old turns the verdict and every dot grey, however fresh the row\'s Last Run', async ({ page }) => {
    await load(page, [verdictRow(180, {}, payload(), 3)]);
    const v = await page.evaluate(() => {
      const p = document.getElementById('aiHealthPanel');
      return {
        verdict: p.querySelector('.aih-verdict-text').textContent, cls: p.querySelector('.aih-verdict').className,
        sub: p.querySelector('.aih-verdict .aih-small').textContent,
        dots: [...p.querySelectorAll('.aih-line .aih-dot, .aih-group-head .aih-dot')].map(d => d.className),
        coloured: p.querySelectorAll('.aih-trend.aih-better, .aih-trend.aih-worse').length,
        groupText: [...p.querySelectorAll('.aih-group-head .aih-small')].map(e => e.textContent),
      };
    });
    expect(v.verdict).toMatch(/^Not updated since /);
    expect(v.cls).toContain('aih-verdict-grey');
    expect(v.sub).toMatch(/^The Mac's report has stopped, so every answer below may be out of date\. Its last verdict: Needs attention/);
    expect(v.dots).toHaveLength(17);
    expect(v.dots.every(c => c === 'aih-dot aih-grey')).toBe(true);
    expect(v.coloured).toBe(0);
    // The group headings never carry the old answer's counts either.
    expect(v.groupText).toEqual(['Not updated', 'Not updated', 'Not updated']);
    expect(await page.evaluate(() => document.querySelectorAll('#aiHealthPanel .aih-line').length)).toBe(14);
    expect(await page.evaluate(() => aiTeamCheck())).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^Not updated since/) });
  });

  test('a failed row with no answer shows its reason in red; a fresh healthy row passes the check', async ({ page }) => {
    await load(page, [verdictRow(5, { [ES.status]: 'Failed', [ES.detail]: 'The AI team verdict could not be built: KeyError: x', [ES.payload]: undefined })]);
    await expect(page.locator('#aiHealthPanel .aih-notice-red')).toHaveText("Can't read the Mac's report: The AI team verdict could not be built: KeyError: x");
    const healthy = payload({ overall: { colour: 'green', text: 'Healthy', red: 0, amber: 1, green: 13, grey: 0, greyLines: [] } });
    await routeEstate(page, [verdictRow(5, {}, healthy)]);
    await page.evaluate(async () => await loadAiTeamHealth());
    await expect(page.locator('#aiHealthPanel .aih-verdict-text')).toHaveText('Healthy');
    expect((await page.evaluate(() => aiTeamCheck())).status).toBe('pass');
  });

  test('payload text never runs as HTML, and an unknown colour is drawn grey', async ({ page }) => {
    const p = payload();
    p.lines[0].answer = '<img src=x onerror="window.__aiXss=1">';
    p.lines[0].colour = 'red" onmouseover="window.__aiXss=2';
    p.lines[3].items = [{ name: '<b id="aiInjected">x</b>' }];
    p.overall.text = '<script>window.__aiXss=3</script>';
    await load(page, [verdictRow(5, {}, p)]);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__aiXss)).toBeUndefined();
    expect(await page.evaluate(() => document.querySelectorAll('#aiHealthPanel img, #aiInjected, #aiHealthPanel script').length)).toBe(0);
    expect(await page.evaluate(() => document.querySelector('#aiHealthPanel .aih-line .aih-dot').className)).toBe('aih-dot aih-grey');
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
    expect(await page.evaluate(() => document.querySelectorAll('#aiHealthPanel .aih-line').length)).toBe(14);
  });

  test('fits a phone: no line wider than the screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await load(page, [verdictRow()]);
    const over = await page.evaluate(() => {
      const panel = document.getElementById('aiHealthPanel');
      const w = panel.getBoundingClientRect().right;
      return [...panel.querySelectorAll('.aih-line, .aih-verdict')].filter(e => e.getBoundingClientRect().right > w + 1).length;
    });
    expect(over).toBe(0);
  });
});
