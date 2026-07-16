// Invariant: the account reference decides the cost — but ONLY when it discriminates
//
// Nearly every cost in this base carries its account reference in the NAME, and the bank
// repeats it in the descriptor:
//     cost  "Kent Reliance - 4AP - MOM0840638BRI1"
//     bank  "DIRECT DEBIT PAYMENT TO KENT RELIANCE IP REF MOM0840638BRI1, MANDATE NO 0100"
// Verified 27/27 across the biggest clusters in the Jul 2026 audit (Kent Reliance 8/8,
// Birmingham Midshires 12/12, West Suffolk 7/7). That makes the reference a stronger signal
// than the amount, which matters because 13 Kent Reliance mortgages sit within 10% of each
// other and amount alone drifts onto a neighbour as soon as one is repriced.
//
// The whole safety of this rests on ONE caveat, which these tests exist to lock down:
// a reference is only trusted when history shows it against exactly one cost. Close Brothers
// finances two Swinton policies under a single agreement, so "REF 85376969" appears on BOTH
// policies' payments while living in only ONE policy's cost name. Trusting it blindly sends
// every £45.30 payment to the £42.01 policy — the exact bug fixed in 87d6b62. The last test
// here fails if anyone removes that guard.
//
// These call the REAL window.pickCostByReference / extractRefTokens from js/reconciliation.js.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures, FIELDS } = require('./helpers');

const LOOKUP = {
  kr4ap: { id: 'kr4ap', fields: { [FIELDS.costName]: 'Kent Reliance - 4AP - MOM0840638BRI1', [FIELDS.costExpected]: 695.50 } },
  kr34cr: { id: 'kr34cr', fields: { [FIELDS.costName]: 'Kent Reliance - 34CR - MOM0840782BRI1', [FIELDS.costExpected]: 686.67 } },
  rsap: { id: 'rsap', fields: { [FIELDS.costName]: 'Swinton RSAP6837602300 - Ref 85376969', [FIELDS.costExpected]: 42.01 } },
  be26: { id: 'be26', fields: { [FIELDS.costName]: 'Swinton BE26ACTP000000015675 - Ref 168263862', [FIELDS.costExpected]: 45.30 } },
};

// refIndex is built from history: token -> Set of costIds seen against it.
// Serialised as arrays across the page boundary, rehydrated to Sets inside.
const REF_INDEX = {
  MOM0840638BRI1: ['kr4ap'],            // unique to one mortgage
  MOM0840782BRI1: ['kr34cr'],           // unique to one mortgage
  '85376969': ['rsap', 'be26'],         // Close Brothers agreement — serves BOTH policies
};

async function byRef(page, desc, refIndex = REF_INDEX, lookup = LOOKUP) {
  return page.evaluate(([desc, idx, lookup]) => {
    const hydrated = {};
    Object.keys(idx).forEach(k => { hydrated[k] = new Set(idx[k]); });
    return window.pickCostByReference(desc, hydrated, lookup);
  }, [desc, refIndex, lookup]);
}

test.describe('Reconciliation: pick the cost by reference', () => {
  test.beforeEach(async ({ page }) => {
    await loadDashboardWithFixtures(page, {});
    await page.waitForFunction(
      () => typeof window.pickCostByReference === 'function' && typeof window.extractRefTokens === 'function',
      { timeout: 15000 }
    );
  });

  test('a unique reference identifies the mortgage exactly', async ({ page }) => {
    expect(await byRef(page, 'DIRECT DEBIT PAYMENT TO KENT RELIANCE IP REF MOM0840638BRI1, MANDATE NO 0100')).toBe('kr4ap');
    expect(await byRef(page, 'DIRECT DEBIT PAYMENT TO KENT RELIANCE IP REF MOM0840782BRI1, MANDATE NO 0100')).toBe('kr34cr');
  });

  test('the reference wins even when the amount has drifted far from Expected', async ({ page }) => {
    // The point of reference-matching: repricing a mortgage cannot move it onto a neighbour.
    // No amount is consulted here at all — the ref alone decides.
    expect(await byRef(page, 'KENT RELIANCE IP REF MOM0840638BRI1')).toBe('kr4ap');
  });

  test('THE GUARD: a shared reference must NOT decide the match', async ({ page }) => {
    // "85376969" is the Close Brothers agreement, seen against BOTH Swinton policies.
    // It appears in RSAP's cost name, so a naive ref match would return 'rsap' and send
    // every £45.30 payment back to the £42.01 policy. Must abstain and let amount decide.
    expect(await byRef(page, 'DIRECT DEBIT PAYMENT TO CLOSE-SWINTON REF 85376969, MANDATE NO 0207')).toBe('');
  });

  test('an unknown reference abstains rather than guessing', async ({ page }) => {
    expect(await byRef(page, 'DIRECT DEBIT PAYMENT TO SOMEONE REF 999999999')).toBe('');
  });

  test('two discriminating references that disagree abstain', async ({ page }) => {
    expect(await byRef(page, 'REF MOM0840638BRI1 AND ALSO MOM0840782BRI1')).toBe('');
  });

  test('a descriptor with no reference at all abstains', async ({ page }) => {
    expect(await byRef(page, 'CARD PAYMENT TO TESCO')).toBe('');
  });

  test('short mandate numbers are not treated as references', async ({ page }) => {
    // "MANDATE NO 553" and "0207" are short and not unique across suppliers.
    const tokens = await page.evaluate(() => window.extractRefTokens('DIRECT DEBIT REF 85376969, MANDATE NO 553'));
    expect(tokens).toContain('85376969');
    expect(tokens).not.toContain('553');
  });

  test('reference extraction ignores ordinary words', async ({ page }) => {
    const tokens = await page.evaluate(() => window.extractRefTokens('DIRECT DEBIT PAYMENT TO KENT RELIANCE IP REF MOM0840638BRI1'));
    expect(tokens).toEqual(['MOM0840638BRI1']);
  });
});
