// The Runpreneur Q4 2026 money KPI (Kevin, 10 Oct 2026) must save only money a cause has
// confirmed, and must never save a figure when the money record did not load.
//
// The rule is unit-tested in tests/runpreneur-kpis.test.js. This spec covers what a unit test
// cannot reach in js/dashboard.js: the record is read before the compute pass, the project's
// KPI Compute Code (ctx.runpreneur.moneyConfirmed) reaches the rule, and a failed read THROWS so
// nothing is saved. Each case carries a control project, which proves the compute pass ran.
// Names and amounts are invented: the repo is public.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, FIELDS } = require('./helpers');

const PROJECTS_TABLE = 'tblHrpTMd5LNYn8v1';
const BUSINESSES_TABLE = 'tblpqkvWJJo8Uu25q';
const MONEY_TABLE = 'tblsH8x6fjWJC26Sa';
const PF = {
    name: 'fldiMZICg1KOORpte', business: 'fldtdJTFkMtldxEVf', start: 'fldGIlsn0cSEpnj18', end: 'fldU0cJparnkvOUsV',
    kpiName: 'fldABYFMf2yBKWdlD', kpiTarget: 'fldaI0voHia91SYZz', kpiCurrent: 'fldB1QJDUsukxKzjQ', kpiUnit: 'fldrYZEghROXYf6w0',
    kpiComputeCode: 'fldA7vPiLnbgEoKh1', kpiAutomated: 'fldU7tTf8aRgG60wI', kpiDetailJson: 'fldeGDKEg6HEXCUh4',
};
const M = { line: 'fldyKmfKIyx52ZJAl', cause: 'fldJUKHkBJogRWhwJ', source: 'fldv4IShZu7n6Jw7w', amount: 'fld0baTCCR9cV3h5f', receipt: 'fld3VVlIrhOS9rGI8', confirmed: 'fld7lQmNJCVBpKfgE' };

const project = (id, code) => ({ id, fields: {
    [PF.name]: 'KPI ' + id, [PF.business]: ['recBiz1'], [PF.start]: '2026-10-10', [PF.end]: '2026-12-31',
    [PF.kpiName]: 'KPI ' + id, [PF.kpiTarget]: 40000, [PF.kpiUnit]: '£', [PF.kpiAutomated]: true, [PF.kpiComputeCode]: code,
} });
const receipt = [{ id: 'att1', url: 'https://example.invalid/receipt.pdf' }];
const MONEY = [
    { id: 'recM1', fields: { [M.line]: 'Sample child, sample event', [M.cause]: 'Sample child fund', [M.source]: 'Event', [M.amount]: 1000, [M.receipt]: receipt, [M.confirmed]: true } },
    { id: 'recM2', fields: { [M.line]: 'Sample charities, card gifts', [M.cause]: 'Sample charities', [M.source]: 'Stripe', [M.amount]: 400, [M.confirmed]: true } },
    { id: 'recM3', fields: { [M.line]: 'Sample marathon', [M.cause]: 'Sample charity', [M.source]: 'Direct to cause' } },
];

async function loadDashboard(page, money) {
    const saves = {};
    await page.addInitScript((pat) => {
        localStorage.setItem('_dlr_pat', pat);
        try { indexedDB.deleteDatabase('_dlr_cache'); } catch {}
    }, MOCK_PAT);
    await page.route('**/v0/**', async (route) => {
        const req = route.request();
        const url = req.url();
        const json = (records) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records }) });
        if (req.method() !== 'GET') {
            const m = url.match(new RegExp(PROJECTS_TABLE + '/(rec\\w+)'));
            if (m && req.method() === 'PATCH') (saves[m[1]] = saves[m[1]] || []).push(req.postDataJSON().fields);
            return json([]);
        }
        if (url.includes(BUSINESSES_TABLE)) return json([{ id: 'recBiz1', fields: { [FIELDS.bizName]: 'Runpreneur', [FIELDS.bizActive]: true } }]);
        if (url.includes(PROJECTS_TABLE)) return json([project('recMoney', 'return ctx.runpreneur.moneyConfirmed();'), project('recControl', 'return { value: 7 };')]);
        if (url.includes(MONEY_TABLE)) {
            if (money === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
            return json(money);
        }
        return json([]);
    });
    await page.goto('/');
    return saves;
}

test.describe('the Runpreneur money KPI saves only money a cause confirmed', () => {
    test('only the row with a receipt AND the tick counts: £1,000 saved, and the opened row shows the gap', async ({ page }) => {
        const saves = await loadDashboard(page, MONEY);
        await expect.poll(() => (saves.recMoney || []).length, { timeout: 30000,
            message: 'the money KPI was never saved, so this test cannot tell £1,000 from "never ran"' }).toBeGreaterThan(0);
        expect(saves.recMoney[0][PF.kpiCurrent]).toBe(1000);
        await page.locator('.strat-kpi-row[data-project-id="recMoney"]').click();
        const panel = page.locator('#stratKpiInfo-recMoney');
        await expect(panel).toContainText('£1,000 confirmed by the causes, of £1,400 traced so far (the website shows £76,920)');
        await expect(panel).toContainText('Receipt needed');
        await expect(panel).toContainText('No amount yet');
    });

    test('a failed read of the money record saves nothing', async ({ page }) => {
        const saves = await loadDashboard(page, 'fail');
        await expect.poll(() => (saves.recControl || []).length, { timeout: 30000,
            message: 'control: the plain KPI was never saved, so the compute pass did not run' }).toBeGreaterThan(0);
        await page.waitForTimeout(1000);
        expect(saves.recMoney || [], 'a money figure was saved after the record failed to load').toEqual([]);
        await expect(page.locator('.strat-kpi-row[data-project-id="recMoney"]')).toContainText('Compute failed');
    });
});
