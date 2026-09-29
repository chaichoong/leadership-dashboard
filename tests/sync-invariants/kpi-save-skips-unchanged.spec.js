// Loading the dashboard must not rewrite a strategic KPI that has not changed.
//
// Found 29 Sep 2026 by the read-only prod walk: every dashboard load PATCHed all five
// open automated KPI projects (KPI Current, KPI Last Updated, Last Updated By and the
// detail JSON), even when nothing had changed, so a robot visit counted as an update.
//
// The fix skips the save when the value AND the drilldown are unchanged AND the record
// was already saved today. The daily save stays on purpose: KPI Last Updated is the
// freshness signal (the kpi 14-day invariant in scripts/check-data-invariants.py reads
// it), so a value that holds steady for a week must still be stamped once a day.
//
// Each case carries a control: a second project whose value DID change must still be
// saved, which proves the compute ran before "no save" is read as a pass.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, FIELDS, makeFixtures } = require('./helpers');

const PROJECTS_TABLE = 'tblHrpTMd5LNYn8v1';
const BUSINESSES_TABLE = 'tblpqkvWJJo8Uu25q';
const TRANSACTIONS_TABLE = 'tbln0gzhCAorFc3zB';

// Field ids from js/dashboard.js → STRAT_PF.
const PF = {
    name:           'fldiMZICg1KOORpte',
    business:       'fldtdJTFkMtldxEVf',
    start:          'fldGIlsn0cSEpnj18',
    end:            'fldU0cJparnkvOUsV',
    status:         'fldZ0SpReVaDS1VXb',
    kpiName:        'fldABYFMf2yBKWdlD',
    kpiTarget:      'fldaI0voHia91SYZz',
    kpiCurrent:     'fldB1QJDUsukxKzjQ',
    kpiLastUpdated: 'fldNk2U74jBxZ6esJ',
    kpiDetailJson:  'fldeGDKEg6HEXCUh4',
    kpiComputeCode: 'fldA7vPiLnbgEoKh1',
    kpiAutomated:   'fldU7tTf8aRgG60wI',
};

function project(id, value, saved = {}) {
    return { id, fields: {
        [PF.name]: 'KPI ' + id, [PF.business]: ['recBiz1'],
        [PF.start]: '2026-07-01', [PF.end]: '2026-12-31', [PF.status]: 'On Track',
        [PF.kpiName]: 'KPI ' + id, [PF.kpiTarget]: 10, [PF.kpiAutomated]: true,
        [PF.kpiComputeCode]: 'return { value: ' + value + ', months: { "2026-09": ' + value + ' } };',
        ...saved,
    } };
}

/** Load the dashboard with `projects`; returns the PATCH bodies sent per project id. */
async function loadDashboardWith(page, projects) {
    const saves = {};
    await page.addInitScript((pat) => {
        localStorage.setItem('_dlr_pat', pat);
        try { indexedDB.deleteDatabase('_dlr_cache'); } catch {}
    }, MOCK_PAT);
    await page.route('**/v0/**', async (route) => {
        const req = route.request();
        const url = req.url();
        if (req.method() !== 'GET') {
            const m = url.match(new RegExp(PROJECTS_TABLE + '/(rec\\w+)'));
            if (m && req.method() === 'PATCH') (saves[m[1]] = saves[m[1]] || []).push(req.postDataJSON().fields);
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: [] }) });
        }
        if (url.includes(BUSINESSES_TABLE)) {
            return route.fulfill({ status: 200, contentType: 'application/json',
                body: JSON.stringify({ records: [{ id: 'recBiz1', fields: {
                    [FIELDS.bizName]: 'Operations Director', [FIELDS.bizActive]: true } }] }) });
        }
        if (url.includes(PROJECTS_TABLE)) {
            return route.fulfill({ status: 200, contentType: 'application/json',
                body: JSON.stringify({ records: projects }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: [] }) });
    });
    await page.goto('/');
    return saves;
}

// What a project looks like after a real save: exactly the fields the dashboard sent.
// The page is closed afterwards: while it holds the dashboard's IndexedDB cache open,
// the next page's deleteDatabase blocks, its cache read never returns and the KPI
// compute never starts.
async function savedStateFor(page, value) {
    const saves = await loadDashboardWith(page, [project('recFirst', value)]);
    await expect.poll(() => (saves.recFirst || []).length, { timeout: 30000,
        message: 'a never-saved KPI was not saved at all' }).toBe(1);
    await page.close();
    return saves.recFirst[0];
}

test.describe('Strategic KPI save on load', () => {

    test('an unchanged KPI already saved today is not saved again', async ({ page, context }) => {
        const saved = await savedStateFor(page, 3);
        expect(saved[PF.kpiCurrent]).toBe(3);

        const next = await context.newPage();
        const saves = await loadDashboardWith(next, [
            project('recSame', 3, saved),                 // unchanged, saved today
            project('recChanged', 7, { ...saved }),        // control: value moved 3 -> 7
        ]);
        await expect.poll(() => (saves.recChanged || []).length, { timeout: 30000,
            message: 'control: the changed KPI was never saved, so the compute did not run' }).toBe(1);
        await next.waitForTimeout(1000);
        expect(saves.recSame || [], 'an unchanged KPI saved today was rewritten on load').toEqual([]);
    });

    test('an unchanged KPI last saved yesterday IS saved, so Last Updated stays fresh', async ({ page, context }) => {
        const saved = await savedStateFor(page, 3);
        const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();

        const next = await context.newPage();
        const saves = await loadDashboardWith(next, [
            project('recStale', 3, { ...saved, [PF.kpiLastUpdated]: yesterday }),
        ]);
        await expect.poll(() => (saves.recStale || []).length, { timeout: 30000,
            message: 'an unchanged KPI from yesterday must still get its daily save' }).toBe(1);
        expect(saves.recStale[0][PF.kpiLastUpdated] > yesterday).toBe(true);
    });

    test('a changed drilldown with the same value IS saved', async ({ page, context }) => {
        const saved = await savedStateFor(page, 3);

        const next = await context.newPage();
        const saves = await loadDashboardWith(next, [
            project('recDetail', 3, { ...saved, [PF.kpiDetailJson]: '{"value":3,"months":{"2026-08":3}}' }),
        ]);
        await expect.poll(() => (saves.recDetail || []).length, { timeout: 30000,
            message: 'a changed drilldown must be saved even when the headline value matches' }).toBe(1);
    });

    // Found 29 Sep 2026 in review: a load that opened from the dashboard cache (up to
    // 24h old) released the KPI compute on the CACHED data, saved that number, and never
    // recomputed once the fresh fetch landed. So a KPI could store yesterday's value.
    test('a cache hit never computes or saves a KPI from the cached data', async ({ page, context }) => {
        const tx = makeFixtures().transactions[0];
        const txs = n => Array.from({ length: n }, (_, i) => ({ ...tx, id: 'recTxK' + i }));
        const state = { txRecords: txs(2), txDelayMs: 0 };
        const saves = [];
        const handler = async (route) => {
            const req = route.request();
            const url = req.url();
            if (req.method() !== 'GET') {
                if (req.method() === 'PATCH' && url.includes(PROJECTS_TABLE)) saves.push(req.postDataJSON().fields[PF.kpiCurrent]);
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: [] }) });
            }
            let records = [];
            if (url.includes(BUSINESSES_TABLE)) records = [{ id: 'recBiz1', fields: { [FIELDS.bizName]: 'Operations Director', [FIELDS.bizActive]: true } }];
            else if (url.includes(PROJECTS_TABLE)) records = [project('recCount', 0, { [PF.kpiComputeCode]: 'return { value: ctx.transactions.length };' })];
            else if (url.includes(TRANSACTIONS_TABLE)) {
                if (state.txDelayMs) await new Promise(r => setTimeout(r, state.txDelayMs));
                records = state.txRecords;
            }
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records }) });
        };
        const cacheWritten = () => new Promise(res => {
            const r = indexedDB.open('_dlr_cache', 1);
            r.onsuccess = () => {
                const db = r.result;
                try {
                    const g = db.transaction('kv', 'readonly').objectStore('kv').get('_dlr_dashcache_v2');
                    g.onsuccess = () => { res(!!g.result); db.close(); };
                    g.onerror = () => { res(false); db.close(); };
                } catch (e) { res(false); db.close(); }
            };
            r.onerror = () => res(false);
        });

        // Load 1: two transactions, fresh from Airtable. Saves 2 and writes the cache.
        await page.addInitScript((pat) => {
            localStorage.setItem('_dlr_pat', pat);
            try { indexedDB.deleteDatabase('_dlr_cache'); } catch {}
        }, MOCK_PAT);
        await page.route('**/v0/**', handler);
        await page.goto('/');
        await expect.poll(() => saves.includes(2), { timeout: 30000, message: 'load 1 never saved the KPI' }).toBe(true);
        await expect.poll(() => page.evaluate(cacheWritten), { timeout: 15000, message: 'load 1 never wrote the cache' }).toBe(true);
        await page.close();

        // Load 2: the cache still says two; Airtable now says five, and answers late.
        saves.length = 0;
        state.txRecords = txs(5);
        state.txDelayMs = 4000;
        const next = await context.newPage();
        await next.route('**/v0/**', handler);
        await next.goto('/');
        // Control: the cache hit really happened, with the old data on the page.
        await next.waitForFunction(() => typeof allTransactions !== 'undefined' && allTransactions.length === 2, null, { timeout: 3500 });

        await expect.poll(() => saves.includes(5), { timeout: 30000,
            message: 'the KPI was never computed from the fresh data' }).toBe(true);
        expect(saves, 'a KPI was saved from the day-old cached data').not.toContain(2);
    });
});
