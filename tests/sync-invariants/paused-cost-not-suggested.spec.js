// Invariant: reconciliation never proposes a Paused or Inactive cost
//
// Bug (Jul 2026): runReconciliationMatching built its costLookup from ALL costs
// (`allCosts.forEach(...)`) while buildCostDropdown offers only ACTIVE ones
// (`allCosts.filter(r => isCostActive(r))`). Two consequences, one worse than the other:
//
//   1. It proposed costs Kevin had deliberately stopped paying. Measured against the live
//      base, ALL 12 suggestions pointed at a cost paused an hour earlier.
//   2. Worse: the cost dropdown cannot hold a value it does not contain, so the suggestion
//      rendered a label and then resolveDropdownId returned '' on Approve — the cost
//      silently dropped. That is the same silent-drop trap already documented for the
//      tenancy/unit lookups in reconTenancyChanged.
//
// Fix: build costLookup with isCostActive — the single rule shared by the dropdown, the
// Leadership Dashboard and AP Fixed. Both pickers gate on costLookup, so it covers
// reference-matching and amount-matching at once.
//
// This drives the REAL window.runReconciliationMatching end-to-end over fixtures, which
// split-safety.spec.js had noted as a follow-up rather than shipped.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures, FIELDS } = require('./helpers');

const VENDOR = 'ACME SUPPLIES LTD';

// history: a reconciled payment already linked to `costId`, teaching the matcher
// "this vendor bills that cost". Then an identical unreconciled payment arrives.
function fixturesPointingAt(costId, payStatus) {
  return {
    costs: [
      { id: 'recCostTarget', fields: {
        [FIELDS.costName]: 'ZZ Acme Retainer',
        [FIELDS.costExpected]: 100,
        [FIELDS.costDueDay]: 10,
        [FIELDS.costFrequency]: 'Monthly',
        [FIELDS.costPayStatus]: payStatus,
      }},
    ],
    transactions: [
      { id: 'recTxHistory', fields: {
        [FIELDS.txName]: VENDOR + ' PAYMENT',
        [FIELDS.txVendor]: VENDOR,
        [FIELDS.txAmount]: -100,
        [FIELDS.txReportAmount]: -100,
        [FIELDS.txDate]: '2026-06-10',
        [FIELDS.txCost]: [costId],
        [FIELDS.txReconciled]: true,
        [FIELDS.txSplitCount]: 1,
      }},
      { id: 'recTxToMatch', fields: {
        [FIELDS.txName]: VENDOR + ' PAYMENT',
        [FIELDS.txVendor]: VENDOR,
        [FIELDS.txAmount]: -100,
        [FIELDS.txReportAmount]: -100,
        [FIELDS.txDate]: '2026-07-10',
        [FIELDS.txReconciled]: false,
        [FIELDS.txSplitCount]: 1,
      }},
    ],
  };
}

async function suggestedCostFor(page, txId) {
  return page.evaluate(async (txId) => {
    const results = await window.runReconciliationMatching();
    const row = results.find(r => r.txId === txId);
    return row ? { costId: row.costId, costLabel: row.costLabel } : null;
  }, txId);
}

test.describe('Reconciliation: never suggest a paused cost', () => {
  test('a Paused cost is NOT suggested, even though history points straight at it', async ({ page }) => {
    await loadDashboardWithFixtures(page, fixturesPointingAt('recCostTarget', 'Paused'));
    const row = await suggestedCostFor(page, 'recTxToMatch');
    expect(row, 'the unreconciled payment should appear in the matcher results').toBeTruthy();
    // Before the fix this returned recCostTarget — a cost the dropdown cannot even hold.
    expect(row.costId).toBe('');
    expect(row.costLabel).toBe('');
  });

  test('an Inactive cost is NOT suggested either', async ({ page }) => {
    await loadDashboardWithFixtures(page, fixturesPointingAt('recCostTarget', 'Inactive'));
    const row = await suggestedCostFor(page, 'recTxToMatch');
    expect(row).toBeTruthy();
    expect(row.costId).toBe('');
  });

  test('CONTROL: the same cost IS suggested when In Payment', async ({ page }) => {
    // Without this the pair above would pass even if the matcher suggested nothing, ever.
    await loadDashboardWithFixtures(page, fixturesPointingAt('recCostTarget', 'In Payment'));
    const row = await suggestedCostFor(page, 'recTxToMatch');
    expect(row).toBeTruthy();
    expect(row.costId).toBe('recCostTarget');
  });

  test('CONTROL: an Overdue cost counts as active and IS suggested', async ({ page }) => {
    await loadDashboardWithFixtures(page, fixturesPointingAt('recCostTarget', 'Overdue'));
    const row = await suggestedCostFor(page, 'recTxToMatch');
    expect(row).toBeTruthy();
    expect(row.costId).toBe('recCostTarget');
  });
});
