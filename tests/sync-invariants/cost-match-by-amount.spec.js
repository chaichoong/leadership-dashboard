// Invariant: a vendor billing SEVERAL costs must be matched by amount, not last-writer-wins
//
// Bug (Jul 2026): Close Brothers finances several Swinton policies under ONE direct-debit
// mandate, so every payment arrives with a byte-identical descriptor:
//     DIRECT DEBIT PAYMENT TO CLOSE-SWINTON REF 85376969, MANDATE NO 0207
// Only the amount and day separate the policies — £42.01 on the 27th (RSAP6837602300) vs
// £45.30 on the 2nd (BE26ACTP...). The history map stored a single costId per vendor key
// (`vendorOnly[key].costId = data.costId`, last writer wins) and applyHistoricalToResult
// applied it with no amount check at all, commenting "Cost — stable per vendor". All 12
// payments landed on one policy; the other read overdue for four months while being paid
// every month, and the first policy carried a permanent variance from the other's amounts.
//
// Note what does NOT fix this: a tolerance alone. £45.30 against £42.01 is 7.8% out, inside
// any sane threshold. The decisive part is picking the BEST candidate among the vendor's
// costs. The tolerance is the second guard, for when no candidate fits at all.
//
// These call the REAL window.pickCostForAmount from js/reconciliation.js. They deliberately
// do not copy the logic into the test — tests/shared.test.js copies its functions, which
// means it cannot catch a regression in the shipped file.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures, FIELDS } = require('./helpers');

// The two real Swinton policies, reduced to what the picker reads.
const LOOKUP = {
  rsap: { id: 'rsap', fields: { [FIELDS.costName]: 'Swinton RSAP6837602300', [FIELDS.costExpected]: 42.01 } },
  be26: { id: 'be26', fields: { [FIELDS.costName]: 'Swinton BE26ACTP000000015675', [FIELDS.costExpected]: 45.30 } },
};

async function pick(page, ids, amount, lookup = LOOKUP) {
  return page.evaluate(
    ([ids, amount, lookup]) => window.pickCostForAmount(ids, amount, lookup),
    [ids, amount, lookup]
  );
}

test.describe('Reconciliation: pick the cost by amount', () => {
  test.beforeEach(async ({ page }) => {
    await loadDashboardWithFixtures(page, {});
    await page.waitForFunction(() => typeof window.pickCostForAmount === 'function', { timeout: 15000 });
  });

  test('the Swinton regression: £45.30 goes to the £45.30 policy, not the £42.01 one', async ({ page }) => {
    // Both policies share a vendor key. Before the fix this returned whichever cost was
    // written last, which is exactly how 4 payments landed on the wrong policy.
    expect(await pick(page, ['rsap', 'be26'], -45.30)).toBe('be26');
  });

  test('the other series still goes to its own policy', async ({ page }) => {
    expect(await pick(page, ['rsap', 'be26'], -42.01)).toBe('rsap');
  });

  test('candidate order does not decide the match (last-writer-wins is dead)', async ({ page }) => {
    // Same inputs, reversed order. A last-writer-wins picker flips with the order;
    // an amount-aware one cannot.
    expect(await pick(page, ['be26', 'rsap'], -45.30)).toBe('be26');
    expect(await pick(page, ['rsap', 'be26'], -45.30)).toBe('be26');
  });

  test('a 1p drift still matches (the real 5 May payment was £45.31)', async ({ page }) => {
    expect(await pick(page, ['rsap', 'be26'], -45.31)).toBe('be26');
  });

  test('sign is irrelevant — outflows are negative', async ({ page }) => {
    expect(await pick(page, ['rsap', 'be26'], 45.30)).toBe('be26');
  });

  test('no candidate within tolerance leaves the cost blank for a human', async ({ page }) => {
    // £60 is 42.8% from RSAP and 32.5% from BE26 — nothing fits. Better an empty cost
    // than a confidently wrong attribution.
    expect(await pick(page, ['rsap', 'be26'], -60.00)).toBe('');
  });

  test('a single-candidate vendor still matches when the amount is right', async ({ page }) => {
    expect(await pick(page, ['rsap'], -42.01)).toBe('rsap');
  });

  test('a single-candidate vendor is rejected when the amount is far out', async ({ page }) => {
    // Guards the case a tolerance IS for: a big unexplained change on a lone cost.
    expect(await pick(page, ['rsap'], -99.99)).toBe('');
  });

  test('no candidates returns blank rather than throwing', async ({ page }) => {
    expect(await pick(page, [], -42.01)).toBe('');
  });

  test('a cost with no Expected Cost cannot be judged, so it is not rejected', async ({ page }) => {
    const lookup = { bare: { id: 'bare', fields: { [FIELDS.costName]: 'No expected amount' } } };
    expect(await pick(page, ['bare'], -42.01, lookup)).toBe('bare');
  });
});
