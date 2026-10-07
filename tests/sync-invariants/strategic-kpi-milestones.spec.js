// Every quarterly project on the Leadership Dashboard shows its monthly milestones, and the
// block counts the open projects Kevin owns against his limit of three (Kevin, 7 Oct 2026:
// the rule of three, three quarterly projects each with three monthly milestones).
//
// Milestones live on the quarter's plan (Objective & Strategy), tied to a project by the
// plan's "linked project" field, so this test serves both tables. The clock is fixed to
// 10 Nov 2026, so November is "this month". Names and texts are invented: the repo is public.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, FIELDS } = require('./helpers');

const PROJECTS_TABLE = 'tblHrpTMd5LNYn8v1';
const BUSINESSES_TABLE = 'tblpqkvWJJo8Uu25q';
const PLANS_TABLE = 'tblEBvFw8DonwxzGh';
const PF = {
    name: 'fldiMZICg1KOORpte', business: 'fldtdJTFkMtldxEVf', start: 'fldGIlsn0cSEpnj18',
    end: 'fldU0cJparnkvOUsV', status: 'fldZ0SpReVaDS1VXb', kpiName: 'fldABYFMf2yBKWdlD',
    kpiTarget: 'fldaI0voHia91SYZz', kpiCurrent: 'fldB1QJDUsukxKzjQ', kpiUnit: 'fldrYZEghROXYf6w0',
    owner: 'fldXUAPrpStGwc2V9', closedOn: 'fldzGI0ywBTpOK2dy',
};
// OBJSTRAT in js/config.js
const OS = {
    quarter: 'fldQl2h3gCxYacE1k', year: 'fldARVrVpuCWxufQO',
    linked: ['fldtBMn2nwhMBEtwh', 'fldEdCkinxZZuDVw8', 'fldtQWnYYi9X1dah9'],
    stones: [
        ['fldA66Xm4zVoClUva', 'fldP91H4XWknwmlzo', 'fldglTQ9Ljyba0IqK'],
        ['fldBcYzfU8zheE00j', 'fldr6WW4Xubhe2Vtm', 'fldqD4uHoPFIfR7Yi'],
        ['fldayHcCRQlG3mLxe', 'fldp1YRY0eGzVJQqU', 'fldZ87UWBj2NYU9Jl'],
    ],
};
const KEVIN = { id: 'usrKevin', email: 'kevin@runpreneur.org.uk', name: 'Sample Founder' };
const ROY = { id: 'usrRoy', email: 'property.head@example.com', name: 'Sample Head' };

function project(id, name, extra = {}) {
    return { id, fields: {
        [PF.name]: name, [PF.business]: ['recBiz1'], [PF.start]: '2026-10-01', [PF.end]: '2026-12-31',
        [PF.status]: 'On-Track', [PF.kpiName]: 'Sample count', [PF.kpiTarget]: 4, [PF.kpiCurrent]: 1, [PF.kpiUnit]: 'count',
        ...extra,
    } };
}
function plan(id, quarter, year, slots) {
    const fields = { [OS.quarter]: quarter, [OS.year]: year };
    slots.forEach((s, i) => {
        if (!s) return;
        fields[OS.linked[i]] = [s.project];
        s.stones.forEach((t, m) => { fields[OS.stones[i][m]] = t; });
    });
    return { id, fields };
}

const PROJECTS = [
    project('recMine', 'Sample compliance push', { [PF.owner]: KEVIN }),
    project('recRoy', 'Sample lettings push', { [PF.owner]: ROY }),
    project('recOrphan', 'Sample project with no plan'),
    // Closed last quarter: never uses a slot, never shows.
    project('recOldMine', 'Sample closed project', { [PF.owner]: KEVIN, [PF.start]: '2026-07-01', [PF.end]: '2026-09-30', [PF.closedOn]: '2026-09-30' }),
];
const PLANS = [
    // An older plan also links recMine. The plan whose quarter holds the project's start date wins.
    plan('recPlanQ3', 'Q3', '2026', [null, { project: 'recMine', stones: ['July old stone', 'August old stone', 'September old stone'] }]),
    plan('recPlanQ4', 'Q4', '2026', [
        { project: 'recMine', stones: ['October: buy the sample certificates', 'November: book the sample inspections', 'December: file every sample certificate'] },
        { project: 'recRoy', stones: ['October: advertise the sample room', 'November: sign the sample tenant', 'December: sample tenant in payment'] },
    ]),
];

async function loadDashboard(page, { projects = PROJECTS, plans = PLANS, plansStatus = 200, now = '2026-11-10T12:00:00' } = {}) {
    await page.clock.setFixedTime(new Date(now));
    await page.addInitScript((pat) => {
        localStorage.setItem('_dlr_pat', pat);
        try { indexedDB.deleteDatabase('_dlr_cache'); } catch {}
    }, MOCK_PAT);
    await page.route('**/v0/**', async (route) => {
        const url = route.request().url();
        const json = (records, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { records } : { error: 'SERVER_ERROR' }) });
        if (url.includes(BUSINESSES_TABLE)) return json([{ id: 'recBiz1', fields: { [FIELDS.bizName]: 'Real Estate', [FIELDS.bizActive]: true } }]);
        if (url.includes(PROJECTS_TABLE)) return json(projects);
        if (url.includes(PLANS_TABLE)) return json(plans, plansStatus);
        return json([]);
    });
    await page.goto('/');
}

test('each project row shows this month\'s milestone, and opens to all three months', async ({ page }) => {
    await loadDashboard(page);
    const row = page.locator('.strat-kpi-row[data-project-id="recMine"]');
    await expect(row, 'control: the strategic row never drew, so the milestone test proves nothing').toBeVisible({ timeout: 30000 });

    const line = row.locator('.strat-kpi-milestone');
    await expect(line).toContainText('November milestone');
    await expect(line).toContainText('this month, due 30 Nov, 20 days left');
    await expect(line).toContainText('November: book the sample inspections');
    await expect(line).not.toContainText('old stone');
    await expect(page.locator('.strat-kpi-row[data-project-id="recRoy"] .strat-kpi-milestone')).toContainText('November: sign the sample tenant');

    await row.click();
    const months = page.locator('#stratKpiInfo-recMine .strat-kpi-month');
    await expect(months).toHaveCount(3);
    await expect(months.nth(0)).toHaveAttribute('data-state', 'past');
    await expect(months.nth(0)).toContainText('October ended 31 Oct');
    await expect(months.nth(0)).toContainText('October: buy the sample certificates');
    await expect(months.nth(1)).toHaveAttribute('data-state', 'now');
    await expect(months.nth(2)).toHaveAttribute('data-state', 'next');
    await expect(months.nth(2)).toContainText('December starts 1 Dec, due 31 Dec');
});

test('a project with no plan says it has no milestones, rather than showing nothing', async ({ page }) => {
    await loadDashboard(page);
    const line = page.locator('.strat-kpi-row[data-project-id="recOrphan"] .strat-kpi-milestone');
    await expect(line).toBeVisible({ timeout: 30000 });
    await expect(line).toHaveText('No monthly milestones on the plan for this project.');
    await page.locator('.strat-kpi-row[data-project-id="recOrphan"]').click();
    await expect(page.locator('#stratKpiInfo-recOrphan .strat-kpi-month')).toHaveCount(0);
});

test('a failed plan fetch is shown on every row', async ({ page }) => {
    await loadDashboard(page, { plansStatus: 500 });
    const lines = page.locator('.strat-kpi-row .strat-kpi-milestone');
    await expect(page.locator('.strat-kpi-row[data-project-id="recMine"]'), 'control: rows never drew').toBeVisible({ timeout: 30000 });
    await expect(lines).toHaveCount(3);
    for (const l of await lines.all()) await expect(l).toContainText('Monthly milestones could not be loaded');
});

test('the slot count counts only open projects Kevin owns, across every business', async ({ page }) => {
    await loadDashboard(page);
    const cap = page.locator('#strategicKpiCapacity');
    await expect(cap).toContainText('Projects you own: 1 of 3', { timeout: 30000 });
    await expect(cap).toContainText('(Sample compliance push)');
    await expect(cap).toContainText('2 slots free.');
    await expect(cap).not.toContainText('Sample closed project');
});

test('a fourth project Kevin owns shows as over the limit', async ({ page }) => {
    const extra = ['recMine2', 'recMine3', 'recMine4'].map((id, i) => project(id, `Sample extra ${i + 1}`, { [PF.owner]: KEVIN }));
    await loadDashboard(page, { projects: [...PROJECTS, ...extra] });
    const cap = page.locator('#strategicKpiCapacity');
    await expect(cap).toContainText('Projects you own: 4 of 3', { timeout: 30000 });
    await expect(cap).toContainText('1 over the limit: hand one to Roy or an agent, or drop it.');
});

// Found in review, 7 Oct 2026.
test('a project that starts on the last day of a quarter takes that quarter\'s plan', async ({ page }) => {
    const late = project('recLate', 'Sample late starter', { [PF.start]: '2026-12-31', [PF.end]: '2027-03-31' });
    const plans = [
        plan('recPlanQ4b', 'Q4', '2026', [{ project: 'recLate', stones: ['October late stone', 'November late stone', 'December late stone'] }]),
        plan('recPlanQ1', 'Q1', '2027', [{ project: 'recLate', stones: ['January next-year stone', 'February next-year stone', 'March next-year stone'] }]),
    ];
    await loadDashboard(page, { projects: [late], plans });
    const line = page.locator('.strat-kpi-row[data-project-id="recLate"] .strat-kpi-milestone');
    await expect(line).toBeVisible({ timeout: 30000 });
    await expect(line).toContainText('November late stone');
});

test('on the due date the milestone says due today, not 0 days left', async ({ page }) => {
    await loadDashboard(page, { now: '2026-11-30T09:00:00' });
    const line = page.locator('.strat-kpi-row[data-project-id="recMine"] .strat-kpi-milestone');
    await expect(line).toContainText('this month, due today, 30 Nov', { timeout: 30000 });
    await expect(line).not.toContainText('0 days left');
});

test('a project Kevin owns that has not started yet does not use a slot', async ({ page }) => {
    const next = project('recNextMine', 'Sample next-quarter project', { [PF.owner]: KEVIN, [PF.start]: '2027-01-01', [PF.end]: '2027-03-31' });
    await loadDashboard(page, { projects: [...PROJECTS, next] });
    const cap = page.locator('#strategicKpiCapacity');
    await expect(cap).toContainText('Projects you own: 1 of 3', { timeout: 30000 });
    await expect(cap).not.toContainText('Sample next-quarter project');
});

test('a project linked twice on its plan says so, rather than picking one set of milestones', async ({ page }) => {
    const plans = [plan('recPlanDup', 'Q4', '2026', [
        { project: 'recMine', stones: ['October slot one', 'November slot one', 'December slot one'] },
        null,
        { project: 'recMine', stones: ['October slot three', 'November slot three', 'December slot three'] },
    ])];
    await loadDashboard(page, { plans });
    const line = page.locator('.strat-kpi-row[data-project-id="recMine"] .strat-kpi-milestone');
    await expect(line).toContainText('linked twice on its plan', { timeout: 30000 });
    await page.locator('.strat-kpi-row[data-project-id="recMine"]').click();
    await expect(page.locator('#stratKpiInfo-recMine .strat-kpi-month')).toHaveCount(0);
});
