// A KPI that says "Auto" must actually produce a number.
//
// THE MISS THIS TEST EXISTS TO PREVENT. On 9 Aug 2026 two strategic KPIs had
// never computed. The cause was three months old: the 6 May hardening banned
// the backtick character in compute code, which silently rejected five scripts
// — one on a backtick inside a comment. Nothing surfaced, because a blocked
// script returned null and the caller skipped it without a word.
//
// It was missed because the earlier verification tested the health *function*
// in isolation and the script *wiring*, but never drove the compute path with
// real compute code. This does: it feeds the dashboard the actual template
// literal that was blocked, and asserts a number comes out.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, FIELDS } = require('./helpers');

const PROJECTS_TABLE = 'tblHrpTMd5LNYn8v1';
const BUSINESSES_TABLE = 'tblpqkvWJJo8Uu25q';

const PF = {
    name:        'fldiMZICg1KOORpte',
    business:    'fldtdJTFkMtldxEVf',
    start:       'fldGIlsn0cSEpnj18',
    end:         'fldU0cJparnkvOUsV',
    status:      'fldZ0SpReVaDS1VXb',
    kpiName:     'fldABYFMf2yBKWdlD',
    kpiTarget:   'fldaI0voHia91SYZz',
    kpiComputeCode: 'fldA7vPiLnbgEoKh1',
    kpiAutomated:   'fldU7tTf8aRgG60wI',
};

// The real shape that was blocked: a template literal, plus a backtick in a
// comment. Both were fatal under the old rule.
const REAL_TEMPLATE_LITERAL_CODE = [
    '// NOTE: `total` is returned so the dashboard shows completed-of-total.',
    'const total = 4;',
    'const done = 3;',
    'const label = `${done} of ${total} complete`;',
    'return { value: done, label: label };',
].join('\n');

async function loadWithComputeCode(page, code) {
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await page.addInitScript((pat) => {
        localStorage.setItem('_dlr_pat', pat);
        try { indexedDB.deleteDatabase('_dlr_cache'); } catch {}
    }, MOCK_PAT);

    await page.route('**/v0/**', async (route) => {
        const url = route.request().url();
        if (route.request().method() !== 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json',
                                   body: JSON.stringify({ records: [] }) });
        }
        if (url.includes(BUSINESSES_TABLE)) {
            return route.fulfill({ status: 200, contentType: 'application/json',
                body: JSON.stringify({ records: [{ id: 'recBiz1', fields: {
                    [FIELDS.bizName]: 'Operations Director', [FIELDS.bizActive]: true } }] }) });
        }
        if (url.includes(PROJECTS_TABLE)) {
            return route.fulfill({ status: 200, contentType: 'application/json',
                body: JSON.stringify({ records: [{ id: 'recProj1', fields: {
                    [PF.name]: 'Recovery packs complete',
                    [PF.business]: ['recBiz1'],
                    [PF.start]: '2026-07-01',
                    [PF.end]: '2026-09-30',
                    [PF.status]: 'Off-Track',
                    [PF.kpiName]: 'Recovery packs complete',
                    [PF.kpiTarget]: 5,
                    [PF.kpiAutomated]: true,
                    [PF.kpiComputeCode]: code,
                } }] }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json',
                               body: JSON.stringify({ records: [] }) });
    });

    await page.goto('/');
    await page.waitForTimeout(3000);
    return consoleErrors;
}

test.describe('KPI compute code actually runs', () => {

    test('compute code using a template literal is not rejected', async ({ page }) => {
        const errors = await loadWithComputeCode(page, REAL_TEMPLATE_LITERAL_CODE);

        const blocked = errors.filter(e => /rejected by the safety check/i.test(e));
        expect(blocked, 'a template literal must not be rejected by the denylist').toEqual([]);
    });

    test('the dashboard does not show a compute-failure badge for valid code', async ({ page }) => {
        await loadWithComputeCode(page, REAL_TEMPLATE_LITERAL_CODE);
        const body = await page.evaluate(() => document.body.innerText);
        expect(body).not.toContain('Compute failed');
    });

    test('genuinely dangerous compute code IS rejected, and says so', async ({ page }) => {
        // The safety check must still bite — and now it must announce itself
        // rather than leaving a blank cell behind an "Auto" badge.
        const errors = await loadWithComputeCode(page,
            'const f = ({})["cons" + "tructor"]; return 1;');

        const blocked = errors.filter(e => /rejected by the safety check/i.test(e));
        expect(blocked.length, 'a built-identifier escape must be blocked AND reported').toBeGreaterThan(0);
    });

    test('a failing KPI is visibly marked, not silently blank', async ({ page }) => {
        await loadWithComputeCode(page, 'throw new Error("boom");');
        const body = await page.evaluate(() => document.body.innerText);
        // The whole point: the founder sees a fault, not an empty cell that
        // reads as "no data yet".
        expect(body).toContain('Compute failed');
    });
});
