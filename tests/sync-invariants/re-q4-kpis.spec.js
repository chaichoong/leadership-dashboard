// The Q4 2026 Real Estate KPIs must never save, or show, a figure worked out from data
// that did not load.
//
// The rules themselves are unit-tested in tests/re-kpis.test.js. This spec covers the two
// places a unit test cannot reach, both in js/dashboard.js:
//   1. reKpiForProject(): a project's KPI Compute Code calls ctx.reKpis.*, and a red alarm
//      must THROW so nothing is saved. KPI Last Updated then stops moving, which is what
//      the daily invariant q4-real-estate-kpis-are-current watches. Saving a calm 0 here
//      would defeat that alarm.
//   2. reCard(): a red result is drawn as "Not updating" with no number.
//
// Each case carries a control: a plain project KPI in the same load IS saved, which
// proves the compute pass ran before "no save" is read as a pass.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, FIELDS } = require('./helpers');

const PROJECTS_TABLE = 'tblHrpTMd5LNYn8v1';
const BUSINESSES_TABLE = 'tblpqkvWJJo8Uu25q';
const PROPERTIES_TABLE = 'tbl6f0OkAmTC2jbuG';
const CERTS_TABLE = 'tbl35rf9qtmq0P87r';

// Field ids from js/dashboard.js → STRAT_PF and js/config.js → RE_CERT.
const PF = {
    name: 'fldiMZICg1KOORpte', business: 'fldtdJTFkMtldxEVf', start: 'fldGIlsn0cSEpnj18',
    end: 'fldU0cJparnkvOUsV', status: 'fldZ0SpReVaDS1VXb', kpiName: 'fldABYFMf2yBKWdlD',
    kpiTarget: 'fldaI0voHia91SYZz', kpiCurrent: 'fldB1QJDUsukxKzjQ',
    kpiComputeCode: 'fldA7vPiLnbgEoKh1', kpiAutomated: 'fldU7tTf8aRgG60wI',
};
const CERT = {
    type: 'fld00ZuxT8uKagM0b', property: 'fldXdDStBL7xrytgT', status: 'fldcSmrEQxoqpEQYF',
    renewalDate: 'fldhZw8IrmgLt1hLY', attachments: 'fld8dwyOKs4AA0L9v',
    propName: 'fldqMbR329TNY974G', propAgent: 'fldEUrWVhSp3NY8Hh', propNoGas: 'fld0nfqquZXCvGqJs',
};

const project = (id, code) => ({ id, fields: {
    [PF.name]: 'KPI ' + id, [PF.business]: ['recBiz1'], [PF.start]: '2026-10-01', [PF.end]: '2026-12-31',
    [PF.status]: 'On Track', [PF.kpiName]: 'KPI ' + id, [PF.kpiTarget]: 13, [PF.kpiAutomated]: true,
    [PF.kpiComputeCode]: code,
} });

const cert = (type) => ({ id: 'recCert' + type.replace(/\W/g, ''), fields: {
    [CERT.type]: type, [CERT.property]: ['recProp1'], [CERT.status]: 'Active',
    [CERT.renewalDate]: '2031-01-01', [CERT.attachments]: [{ id: 'att1', url: 'https://example.invalid/c.pdf' }],
} });
const PROPERTY = { id: 'recProp1', fields: { [CERT.propName]: 'Test House', [CERT.propAgent]: 'Property Portfolio' } };

/** Load the dashboard; `certs` is the certificate book (or 'fail' for a 500). Returns saves per project id. */
async function loadDashboard(page, certs) {
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
        if (url.includes(BUSINESSES_TABLE)) return json([{ id: 'recBiz1', fields: { [FIELDS.bizName]: 'Real Estate', [FIELDS.bizActive]: true } }]);
        if (url.includes(PROJECTS_TABLE)) return json([
            project('recCompliance', 'return ctx.reKpis.compliance();'),
            project('recControl', 'return { value: 7 };'),
        ]);
        if (url.includes(PROPERTIES_TABLE)) return json([PROPERTY]);
        if (url.includes(CERTS_TABLE)) {
            if (certs === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
            return json(certs);
        }
        return json([]);
    });
    await page.goto('/');
    return saves;
}

const complianceCard = (page) => page.locator('#reQ4Cards .kpi-card', { hasText: 'Self-managed properties fully compliant' });

// The Intus move (10 Oct 2026): three units leave a serviced-accommodation arrangement. Each
// already holds live tenancies (an old record with no end date and the current arrangement),
// so only a tenancy that STARTS on or after 9 Oct may count. Unit ids are the real ones from
// RE_Q4.intus in js/config.js; every other value is invented.
const TENANCIES_TABLE = 'tblN51a88qTDB6iMH';
const UNITS_TABLE = 'tblM3mZCR5kiEdWMj';
const TEN = { unit: 'fld7cjLLEHKAx49OK', tenant: 'fld1i5bDoHL3B6rUf', surname: 'fldOXazTqBWieEOK2', start: 'fld2rPXwwV8dXb1zF', end: 'fldwHhhKAq4f1nY9e', rent: 'fldDMyfZLFMeONPq8' };
const MOVING = ['recQt9s4XMNW1IpNp', 'recskqALqQ4VvL9l2', 'rec4cTQjjLrVF6RNj'];
const tenancy = (id, unit, start, surname) => ({ id, fields: { [TEN.unit]: [unit], [TEN.tenant]: ['recTen' + id], [TEN.surname]: surname, [TEN.start]: start, [TEN.rent]: 500 } });

async function loadIntus(page, tenancies) {
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
        if (url.includes(BUSINESSES_TABLE)) return json([{ id: 'recBiz1', fields: { [FIELDS.bizName]: 'Real Estate', [FIELDS.bizActive]: true } }]);
        if (url.includes(PROJECTS_TABLE)) return json([project('recIntus', 'return ctx.reKpis.intusUnits();'), project('recControl', 'return { value: 7 };')]);
        if (url.includes(UNITS_TABLE)) return json(MOVING.map((id, i) => ({ id, fields: { fldr8sliyu8h2jw9t: 'Sample flat ' + (i + 1) } })));
        if (url.includes(TENANCIES_TABLE)) return json(tenancies);
        return json([]);
    });
    await page.goto('/');
    return saves;
}

test.describe('the Intus move counts only a tenancy that starts on or after the move date', () => {
    const old = [
        tenancy('o1', MOVING[0], '2021-02-24', ''), tenancy('o2', MOVING[0], '2026-01-01', 'Operator'),
        tenancy('o3', MOVING[1], '2026-01-01', 'Operator'), tenancy('o4', MOVING[2], '2026-04-01', 'Operator'),
    ];

    test('the old arrangement alone saves 0, and the opened row says so', async ({ page }) => {
        const saves = await loadIntus(page, old);
        await expect.poll(() => (saves.recIntus || []).length, { timeout: 30000,
            message: 'the Intus KPI was never saved, so this test cannot tell 0 from "never ran"' }).toBeGreaterThan(0);
        expect(saves.recIntus[0][PF.kpiCurrent]).toBe(0);
        await page.locator('.strat-kpi-row[data-project-id="recIntus"]').click();
        await expect(page.locator('#stratKpiInfo-recIntus')).toContainText('0 of 2 committed units have a tenant in');
        await expect(page.locator('#stratKpiInfo-recIntus')).toContainText('Still on the old arrangement');
    });

    test('a new tenancy from 9 Oct on the first unit saves 1', async ({ page }) => {
        const saves = await loadIntus(page, [...old, tenancy('n1', MOVING[0], '2026-10-09', 'Newcomer')]);
        await expect.poll(() => (saves.recIntus || []).length, { timeout: 30000 }).toBeGreaterThan(0);
        expect(saves.recIntus[0][PF.kpiCurrent]).toBe(1);
    });
});

test.describe('Q4 real estate KPIs refuse to save or show a figure from data that did not load', () => {

    test('control: with a full certificate book the compliance KPI is worked out and saved', async ({ page }) => {
        const saves = await loadDashboard(page, [cert('GSC'), cert('EICR'), cert('Landlord Insurance')]);
        await expect.poll(() => (saves.recCompliance || []).length, { timeout: 30000,
            message: 'the compliance KPI was never saved, so this suite cannot tell "refused" from "never ran"' }).toBe(1);
        expect(saves.recCompliance[0][PF.kpiCurrent]).toBe(1);
        await expect(complianceCard(page).locator('.kpi-card-value')).toHaveText('1 of 1');
    });

    test('an empty certificate book saves nothing and the card reads Not updating', async ({ page }) => {
        const saves = await loadDashboard(page, []);
        await expect.poll(() => (saves.recControl || []).length, { timeout: 30000,
            message: 'control: the plain KPI was never saved, so the compute pass did not run' }).toBe(1);
        await page.waitForTimeout(1000);
        expect(saves.recCompliance || [], 'a compliance figure was saved from an empty certificate book').toEqual([]);
        await expect(complianceCard(page)).toContainText('Not updating');
        await expect(complianceCard(page).locator('.kpi-card-value')).toHaveText('—');
    });

    test('a certificate type missing from the book saves nothing', async ({ page }) => {
        const saves = await loadDashboard(page, [cert('EICR'), cert('Landlord Insurance')]);
        await expect.poll(() => (saves.recControl || []).length, { timeout: 30000,
            message: 'control: the plain KPI was never saved, so the compute pass did not run' }).toBe(1);
        await page.waitForTimeout(1000);
        expect(saves.recCompliance || [], 'a compliance figure was saved with a whole certificate type missing').toEqual([]);
        await expect(complianceCard(page)).toContainText('Not updating');
    });

    test('a failed certificate fetch saves nothing and does not take the dashboard down', async ({ page }) => {
        const saves = await loadDashboard(page, 'fail');
        await expect.poll(() => (saves.recControl || []).length, { timeout: 30000,
            message: 'control: the plain KPI was never saved, so the compute pass did not run' }).toBe(1);
        await page.waitForTimeout(1000);
        expect(saves.recCompliance || [], 'a compliance figure was saved after the certificate fetch failed').toEqual([]);
        await expect(complianceCard(page)).toContainText('Not updating');
        // The other seven cards are still drawn.
        await expect(page.locator('#reQ4Cards .kpi-card')).toHaveCount(8);
    });
});
