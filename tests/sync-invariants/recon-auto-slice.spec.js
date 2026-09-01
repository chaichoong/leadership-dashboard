// Invariants for the auto-tier extension (Agent Gate, 1 Sep 2026):
//
// 1. The accuracy stats must carry a separate score for the 'auto-eligible' slice — the
//    rows the auto tier would have approved — and the register Metric Score must report
//    BOTH readings. The guardrail flip decision keys on the slice score, because the
//    blended score forever includes the hard cases that stay manual.
// 2. The auto run must fail CLOSED when the Airtable-backed undo-log/suppression store
//    cannot be read: no transaction may be auto-approved without a working undo path.
//    (The store moved out of localStorage precisely because it is safety-critical.)
// 3. Rows marked Undone in the store ARE the never-auto-again suppression list, and the
//    active rows feed the visible "Auto-reconciled today" panel.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, loadDashboard } = require('./helpers');

const AUDIT_TABLE = 'tblbfuxYxu4uMMWwT';
const AUTOLOG_TABLE = 'tblPg6Uk8AlmQnofu';
const TX_TABLE = 'tbln0gzhCAorFc3zB';
const REGISTER_TABLE = 'tbl9msVjyQWslLOIZ';

const F_ACC = 'fld9n62GxQijQWqSA';    // AI Recon Audit: Was Accurate
const F_SLICE = 'fldzAqifUzN5HIQpE';  // AI Recon Audit: Slice
const F_METRIC = 'fldkGxrOlrfuLlH3J'; // AI Agents: Metric Score
const F_GUARD = 'fldWgqxMFmaAAvUHC';  // AI Agents: Guardrail Level

const A_VENDOR = 'fldoaPh36BVnPVxoU'; // Auto Log: Vendor
const A_KEY = 'fld8uHHkINZj39dbv';    // Auto Log: Vendor Key
const A_TXID = 'fldN4D106HHlpz9pX';   // Auto Log: Tx ID
const A_AMOUNT = 'fldful1fmSiNj7Zpu'; // Auto Log: Amount
const A_SET = 'fldByQpyur3xlGwsf';    // Auto Log: Set Fields (JSON)
const A_UNDONE = 'fldSLhjeaBepaBC9w'; // Auto Log: Undone

// Register table-specific GET routes AFTER loadDashboard() — its generic mock is
// registered first and Playwright matches the newest handler first (see
// recon-accuracy-stats.spec.js for the original note).
async function routeTableGet(page, tableId, body) {
  await page.route(`**/api.airtable.com/v0/**${tableId}**`, async (route) => {
    if (route.request().method() !== 'GET') { await route.fallback(); return; }
    if (typeof body === 'number') { await route.fulfill({ status: body, contentType: 'application/json', body: '{}' }); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

function auditRow(id, accurate, slice) {
  return { id, fields: { [F_ACC]: accurate, [F_SLICE]: slice } };
}

test.describe('Recon auto-tier: slice score, fail-closed store, suppression', () => {

  test('stats carry the auto-slice score and the register receives BOTH readings', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);

    const patches = [];
    await page.route(`**/api.airtable.com/v0/**/${REGISTER_TABLE}/**`, async (route) => {
      if (route.request().method() !== 'PATCH') { await route.fallback(); return; }
      patches.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'recyrN5YCQFssAniE' }) });
    });
    await routeTableGet(page, AUDIT_TABLE, { records: [
      // Auto-eligible slice: 4 of 6 right. Everything else: 2 of 4 right.
      auditRow('recS1', true, 'auto-eligible'), auditRow('recS2', true, 'auto-eligible'),
      auditRow('recS3', true, 'auto-eligible'), auditRow('recS4', true, 'auto-eligible'),
      auditRow('recS5', false, 'auto-eligible'), auditRow('recS6', false, 'auto-eligible'),
      auditRow('recO1', true, 'income-tenancy'), auditRow('recO2', true, 'other'),
      auditRow('recO3', false, ''), auditRow('recO4', false, 'other'),
    ] });

    const stats = await page.evaluate(async () => await refreshReconAccuracyStats());

    expect(stats.total).toBe(10);
    expect(stats.accurate).toBe(6);
    expect(stats.autoSlice).toEqual({ total: 6, accurate: 4, pct: 67 });

    await expect.poll(() => patches.length, { timeout: 5000 }).toBe(1);
    expect(patches[0].fields[F_METRIC]).toBe('60% (6/10 checked, last 31 days); auto-slice 67% (4/6)');
  });

  test('auto run performs ZERO writes when the undo-log store cannot be read (fails closed)', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);

    // Guardrail says GO — the store failure alone must stop the run.
    await routeTableGet(page, REGISTER_TABLE, { id: 'recyrN5YCQFssAniE', fields: { [F_GUARD]: 'Hybrid escalation' } });
    await routeTableGet(page, AUTOLOG_TABLE, 500);

    const txWrites = [];
    await page.route(`**/api.airtable.com/v0/**/${TX_TABLE}/**`, async (route) => {
      if (route.request().method() === 'PATCH') txWrites.push(route.request().url());
      await route.fallback();
    });

    const loaded = await page.evaluate(async () => await loadAutoState(true));
    expect(loaded).toBe(false);
    await page.evaluate(async () => await runAutoReconcile());

    expect(txWrites.length).toBe(0);
    // And with the store unreadable, the gate itself refuses everything.
    expect(await page.evaluate(() => getAutoSuppress())).toEqual([]);
  });

  test('Undone rows load as the suppression list; active rows feed the visible undo panel', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);

    const nowIso = new Date().toISOString();
    await routeTableGet(page, AUTOLOG_TABLE, { records: [
      { id: 'recU1', createdTime: nowIso, fields: { [A_KEY]: 'one stop', [A_VENDOR]: 'ONE STOP 1036', [A_UNDONE]: true } },
      { id: 'recA1', createdTime: nowIso, fields: {
        [A_TXID]: 'recTxAmazon', [A_VENDOR]: 'AMAZON', [A_KEY]: 'amazon', [A_AMOUNT]: -12.5,
        [A_SET]: JSON.stringify({ setFields: { cat: 'c1', sub: 's1' }, categoryName: 'Operations', subCatName: 'Software', date: '2026-09-01' }),
      } },
    ] });

    const loaded = await page.evaluate(async () => await loadAutoState(true));
    expect(loaded).toBe(true);

    expect(await page.evaluate(() => getAutoSuppress())).toEqual(['one stop']);

    const log = await page.evaluate(() => getAutoLog());
    expect(log.length).toBe(1);
    expect(log[0].txId).toBe('recTxAmazon');
    expect(log[0].setFields).toEqual({ cat: 'c1', sub: 's1' });

    const panel = await page.evaluate(() => buildAutoPanelHtml());
    expect(panel).toContain('AMAZON');
    expect(panel).toContain('Software');
    expect(panel).toContain('Undo');
  });
});
