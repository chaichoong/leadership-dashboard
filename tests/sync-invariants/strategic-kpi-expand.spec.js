// Every Strategic KPIs row on the Leadership Dashboard opens to show where the KPI is up
// to (Kevin, 6 Oct 2026). Before this, a row only opened when bank transactions sat
// behind it, so none of the three Q4 real estate rows could be opened at all.
//
// The project here carries a saved units breakdown in "KPI Detail JSON" and no compute
// code, so the panel must draw from the saved breakdown. Names are invented: the repo is public.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, FIELDS } = require('./helpers');

const PROJECTS_TABLE = 'tblHrpTMd5LNYn8v1';
const BUSINESSES_TABLE = 'tblpqkvWJJo8Uu25q';
const PF = {
    name: 'fldiMZICg1KOORpte', business: 'fldtdJTFkMtldxEVf', start: 'fldGIlsn0cSEpnj18',
    end: 'fldU0cJparnkvOUsV', status: 'fldZ0SpReVaDS1VXb', kpiName: 'fldABYFMf2yBKWdlD',
    kpiTarget: 'fldaI0voHia91SYZz', kpiCurrent: 'fldB1QJDUsukxKzjQ', kpiUnit: 'fldrYZEghROXYf6w0',
    kpiDetailJson: 'fldeGDKEg6HEXCUh4', defOfDone: 'fldgjzVEnfnZowrBD', kpiTracking: 'fld2wYB5ZEn9WRcjN',
    totalTasks: 'fldtw6NQZ8CSF3RXi', completedTasks: 'fld7IDjY0xB4JGBfn',
};

const DETAIL = {
    value: 1, filled: 1, of: 2, stretchOf: 3, notes: [],
    rows: [
        { id: 'uA', label: 'Unit 3 – 9 Sample Row', stretch: false, filled: true, tenant: 'Newcomer', outgoing: '' },
        { id: 'uB', label: 'Unit 2 – 4 Test Lane', stretch: false, filled: false, tenant: '', outgoing: 'Leaver' },
        { id: 'uC', label: 'Unit 1 – 7 Example Way', stretch: true, filled: false, tenant: '', outgoing: '' },
    ],
};

// A rent KPI whose saved breakdown holds a re-let BELOW the old rent and a stale
// transaction drill. Neither may mislead: the loss keeps its minus sign, and no button is
// drawn for transactions the page has not loaded (found in review, 6 Oct 2026).
const RENT_DETAIL = {
    value: -60.4, committed: 0, stretch: -60.4, notes: [], detail: { rolling: { revTxs: [], costTxs: [] } },
    rows: [{ label: 'New tenant, Unit 3 – 4 Test Lane', stretch: true, rent: -60.4, status: 'In Payment', replaces: 510.4 }],
};

async function loadDashboard(page, extra = []) {
    await page.addInitScript((pat) => {
        localStorage.setItem('_dlr_pat', pat);
        try { indexedDB.deleteDatabase('_dlr_cache'); } catch {}
    }, MOCK_PAT);
    await page.route('**/v0/**', async (route) => {
        const url = route.request().url();
        const json = (records) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records }) });
        if (url.includes(BUSINESSES_TABLE)) return json([{ id: 'recBiz1', fields: { [FIELDS.bizName]: 'Real Estate', [FIELDS.bizActive]: true } }]);
        if (url.includes(PROJECTS_TABLE)) return json([{ id: 'recUnits', fields: {
            [PF.name]: 'Fill the sample rooms', [PF.business]: ['recBiz1'], [PF.start]: '2026-10-01', [PF.end]: '2026-12-31',
            [PF.status]: 'On-Target', [PF.kpiName]: 'Named units with a signed tenant in', [PF.kpiTarget]: 2, [PF.kpiCurrent]: 1,
            [PF.kpiUnit]: 'units', [PF.kpiDetailJson]: JSON.stringify(DETAIL),
            [PF.defOfDone]: 'Both sample rooms let by 31 December.', [PF.kpiTracking]: 'Counted from the tenancy records.',
            [PF.totalTasks]: 4, [PF.completedTasks]: 1,
        } }, ...extra]);
        return json([]);
    });
    await page.goto('/');
}

test('a Strategic KPIs row opens to show where it is up to, and closes again', async ({ page }) => {
    await loadDashboard(page);
    const row = page.locator('.strat-kpi-row[data-project-id="recUnits"]');
    const panel = page.locator('#stratKpiInfo-recUnits');
    await expect(row, 'control: the strategic row never drew, so the open test proves nothing').toBeVisible({ timeout: 30000 });
    await expect(panel).toBeHidden();

    await row.click();
    await expect(panel).toBeVisible();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toContainText('1 of 2 committed units have a tenant in. With the stretch unit: 1 of 3.');
    await expect(panel).toContainText('In: Newcomer');
    await expect(panel).toContainText('To re-let: Leaver still on record');
    await expect(panel).toContainText('Unit 1 – 7 Example Way (stretch)');
    await expect(panel).toContainText('Both sample rooms let by 31 December.');
    await expect(panel).toContainText('Counted from the tenancy records.');
    await expect(panel).toContainText('1 of 4 tasks done');

    await row.click();
    await expect(panel).toBeHidden();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
});

test('an open row stays open when the list draws again', async ({ page }) => {
    await loadDashboard(page);
    const row = page.locator('.strat-kpi-row[data-project-id="recUnits"]');
    await expect(row).toBeVisible({ timeout: 30000 });
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#stratKpiInfo-recUnits')).toBeVisible();
    await page.evaluate(() => window.setStrategicKpiFilter('all'));   // redraws the whole list
    await expect(page.locator('#stratKpiInfo-recUnits')).toBeVisible();
    await expect(page.locator('#stratKpiInfo-recUnits')).toContainText('In: Newcomer');
});

test('a re-let below the old rent shows as a loss, and no drill button is drawn without its transactions', async ({ page }) => {
    await loadDashboard(page, [{ id: 'recRent', fields: {
        [PF.name]: 'Get the sample rent in', [PF.business]: ['recBiz1'], [PF.start]: '2026-10-01', [PF.end]: '2026-12-31',
        [PF.status]: 'On-Target', [PF.kpiName]: 'New rent in payment', [PF.kpiTarget]: 900, [PF.kpiCurrent]: 0,
        [PF.kpiUnit]: '£ a month', [PF.kpiDetailJson]: JSON.stringify(RENT_DETAIL),
    } }]);
    const row = page.locator('.strat-kpi-row[data-project-id="recRent"]');
    await expect(row, 'control: the rent row never drew').toBeVisible({ timeout: 30000 });
    await row.click();
    const panel = page.locator('#stratKpiInfo-recRent');
    await expect(panel).toContainText('− £60.40 a month in payment');
    await expect(panel.locator('.od-breakdown-row', { hasText: 'counts the rise over the outgoing £510.40' })).toContainText('− £60.40');
    await expect(panel.locator('.text-red', { hasText: 'Unit 3 – 4 Test Lane' })).toHaveCount(1);
    await expect(panel.getByText('Show the transactions')).toHaveCount(0);
});
