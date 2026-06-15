// Invariant: CFV / arrears detection is driven by reconciled-payment presence,
// not by a transaction's calendar position relative to a fixed window (commit 55d4974).
// Bug 1: Early payment (e.g. paid on the 1st for a 1st-due rent) flagged as CFV.
// Bug 2: Tenant with a reconciled payment this month still flagged (false positive).
// Bug 3: UC tenants with a future dueDay were skipped entirely (invisible to detector).
//
// These tests drive window.isCurrentlyInArrears() directly with an explicit `today`
// and a controlled allTransactions array. That exercises the REAL detection logic
// deterministically — no DOM scraping, no dependence on the wall-clock date.

const { test, expect } = require('@playwright/test');
const { loadDashboard, FIELDS } = require('./helpers');

// Build the global allTransactions array and call isCurrentlyInArrears in-page.
// `today` is passed as an ISO string and rebuilt inside the page.
async function checkArrears(page, { tenancy, transactions, tenantType, todayISO }) {
  return page.evaluate(({ tenancy, transactions, tenantType, todayISO }) => {
    if (typeof isCurrentlyInArrears !== 'function') return 'NO_FN';
    // NB: the app's `allTransactions` is a top-level lexical global, not a window
    // property — a bare assignment reaches the binding the function reads; `window.x` does not.
    allTransactions = transactions; // eslint-disable-line no-undef
    return isCurrentlyInArrears(tenancy, tenantType, new Date(todayISO));
  }, { tenancy, transactions, tenantType, todayISO });
}

test.describe('CFV Detection Invariants', () => {

  test.beforeEach(async ({ page }) => {
    await loadDashboard(page);
    // The detection function must be exposed before we can test the invariant.
    await page.waitForFunction(() => typeof isCurrentlyInArrears === 'function', { timeout: 10000 });
  });

  test('a reconciled payment in the current month means NOT in arrears', async ({ page }) => {
    const tenancy = { id: 'recTenA', fields: { [FIELDS.tenDueDay]: 1, [FIELDS.tenStartDate]: '2025-01-01' } };
    const paidThisMonth = [{
      id: 'recTxA', fields: {
        [FIELDS.txTenancy]: ['recTenA'],
        [FIELDS.txReconciled]: true,
        [FIELDS.txDate]: '2026-05-01', // on/early for a 1st-due rent
      },
    }];

    // Paid this month → not in arrears (guards Bug 1 + Bug 2).
    const withPayment = await checkArrears(page, {
      tenancy, transactions: paidThisMonth, tenantType: 'Working', todayISO: '2026-05-15',
    });
    expect(withPayment).toBe(false);

    // Teeth: same tenancy, NO payment this or last month → must be in arrears.
    // If this returned false too, the test above would be passing vacuously.
    const noPayment = await checkArrears(page, {
      tenancy, transactions: [], tenantType: 'Working', todayISO: '2026-05-15',
    });
    expect(noPayment).toBe(true);
  });

  test('UC tenant with a future dueDay is still evaluated (not skipped)', async ({ page }) => {
    // dueDay 27, today the 5th → due date is in the future this month.
    // The old bug hid these tenants entirely. The detector must still evaluate them:
    // with no payment and nothing paid last month, the tenant is in arrears.
    const ucTenancy = { id: 'recTenUC', fields: { [FIELDS.tenDueDay]: 27, [FIELDS.tenStartDate]: '2025-01-01' } };

    const flagged = await checkArrears(page, {
      tenancy: ucTenancy, transactions: [], tenantType: 'UC', todayISO: '2026-05-05',
    });
    expect(flagged).toBe(true);

    // And a UC tenant WITH a reconciled payment this month is cleared, not stuck flagged.
    const paid = [{
      id: 'recTxUC', fields: {
        [FIELDS.txTenancy]: ['recTenUC'],
        [FIELDS.txReconciled]: true,
        [FIELDS.txDate]: '2026-05-02',
      },
    }];
    const cleared = await checkArrears(page, {
      tenancy: ucTenancy, transactions: paid, tenantType: 'UC', todayISO: '2026-05-05',
    });
    expect(cleared).toBe(false);
  });

  test('an unreconciled payment does NOT clear arrears', async ({ page }) => {
    // A payment that exists but is not reconciled must not count as "paid".
    const tenancy = { id: 'recTenB', fields: { [FIELDS.tenDueDay]: 1, [FIELDS.tenStartDate]: '2025-01-01' } };
    const unreconciled = [{
      id: 'recTxB', fields: {
        [FIELDS.txTenancy]: ['recTenB'],
        [FIELDS.txReconciled]: false, // key: not reconciled
        [FIELDS.txDate]: '2026-05-01',
      },
    }];

    const result = await checkArrears(page, {
      tenancy, transactions: unreconciled, tenantType: 'Working', todayISO: '2026-05-15',
    });
    expect(result).toBe(true);
  });
});
