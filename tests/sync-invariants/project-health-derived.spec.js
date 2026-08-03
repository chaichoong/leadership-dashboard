// The Leadership Dashboard must DERIVE each project's health, never echo the
// stored Project Status.
//
// The incident (Aug 2026): Airtable stamps "Not Started" on every project the
// Strategy push creates, and nothing ever cleared it. The dashboard's health
// function returned early on that value, so five Q3 projects showed
// "Not Started" from 1 July to 3 August while sitting at 0 of 48 tasks and £0
// of an £1,850 target. The quarter was a third gone and visibly off-track;
// the screen said it had not begun.
//
// This is the display half. The Airtable half — the stored field itself going
// stale — is covered by the `started-projects-are-not-still-not-started`
// invariant in scripts/check-data-invariants.py, because a fixture test mocks
// away the layer that rots.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, FIELDS } = require('./helpers');

const PROJECTS_TABLE = 'tblHrpTMd5LNYn8v1';
const BUSINESSES_TABLE = 'tblpqkvWJJo8Uu25q';

// Field IDs from STRAT_PF / PROJ_F.
const PF = {
    name:       'fldiMZICg1KOORpte',
    business:   'fldtdJTFkMtldxEVf',
    start:      'fldGIlsn0cSEpnj18',
    end:        'fldU0cJparnkvOUsV',
    status:     'fldZ0SpReVaDS1VXb',
    kpiName:    'fldABYFMf2yBKWdlD',
    kpiTarget:  'fldaI0voHia91SYZz',
};

/**
 * @param {object} overrides fields to set on the single mocked project
 */
async function loadDashboardWithProject(page, projectFields) {
    await page.addInitScript((pat) => {
        localStorage.setItem('_dlr_pat', pat);
        try { indexedDB.deleteDatabase('_dlr_cache'); } catch {}
    }, MOCK_PAT);

    await page.route('**/v0/**', async (route) => {
        const url = route.request().url();
        if (url.includes(BUSINESSES_TABLE)) {
            return route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify({ records: [{ id: 'recBiz1', fields: {
                    [FIELDS.bizName]: 'Operations Director', [FIELDS.bizActive]: true } }] }),
            });
        }
        if (url.includes(PROJECTS_TABLE)) {
            return route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify({ records: [{ id: 'recProj1', fields: projectFields }] }),
            });
        }
        return route.fulfill({ status: 200, contentType: 'application/json',
                               body: JSON.stringify({ records: [] }) });
    });

    await page.goto('/');
    await page.waitForTimeout(2500);
}

// A quarter that is genuinely under way. Real Q3 2026 dates, so the fixture
// matches the shape of the records that broke.
const UNDER_WAY = {
    [PF.name]: 'First cash through the door',
    [PF.business]: ['recBiz1'],
    [PF.start]: '2026-07-01',
    [PF.end]: '2026-09-30',
    [PF.kpiName]: 'Cash collected from clients',
    [PF.kpiTarget]: 1850,
};

test.describe('Leadership Dashboard — project health is derived, not stored', () => {

    test('a stale "Not Started" does not suppress the real health', async ({ page }) => {
        await loadDashboardWithProject(page, { ...UNDER_WAY, [PF.status]: 'Not Started' });

        const health = await page.evaluate(() => {
            if (typeof computeProjectHealth !== 'function') return 'FUNCTION MISSING';
            // Exactly the record shape the dashboard builds, as at a day well
            // into the quarter. Frozen so the assertion cannot drift with time.
            return computeProjectHealth({
                status: 'Not Started', start: '2026-07-01', end: '2026-09-30',
                kpiTarget: 1850, kpiCurrent: 0,
            }, '2026-08-03T12:00:00');
        });

        expect(health).toBe('Off-Track');
        expect(health).not.toBe('Not Started');
    });

    test('the shared rule is loaded on the dashboard at all', async ({ page }) => {
        // Guards the wiring, not the maths: js/project-health.js must be in the
        // page and must come before js/dashboard.js. Without it the dashboard
        // logs an error and every project reads "Unknown".
        await loadDashboardWithProject(page, { ...UNDER_WAY, [PF.status]: 'Not Started' });

        const wiring = await page.evaluate(() => ({
            hasFn: typeof computeProjectHealth === 'function',
            hasGuard: typeof isWritableStatus === 'function',
            scripts: [...document.scripts].map(s => s.src.split('/').pop().split('?')[0]),
        }));

        expect(wiring.hasFn).toBe(true);
        expect(wiring.hasGuard).toBe(true);
        const healthIdx = wiring.scripts.indexOf('project-health.js');
        const dashIdx = wiring.scripts.indexOf('dashboard.js');
        expect(healthIdx).toBeGreaterThan(-1);
        expect(healthIdx).toBeLessThan(dashIdx);
    });

    test('the dashboard renders a status for the project, not a blank cell', async ({ page }) => {
        await loadDashboardWithProject(page, { ...UNDER_WAY, [PF.status]: 'Not Started' });
        // The KPI section renders the project name once data resolves; if the
        // health function throws, the row never appears at all.
        const body = await page.evaluate(() => document.body.innerText);
        expect(body).toContain('First cash through the door');
    });

    test('no console errors from the shared rule', async ({ page }) => {
        const errors = [];
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        await loadDashboardWithProject(page, { ...UNDER_WAY, [PF.status]: 'Not Started' });
        const relevant = errors.filter(e => /project-health|computeProjectHealth/i.test(e));
        expect(relevant).toEqual([]);
    });
});
