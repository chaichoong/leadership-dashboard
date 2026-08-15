// Invariant: every transaction-backed figure on the Wealth tab opens its transaction list.
// Bug (reported 2026-07-29): the Monthly cash flow matrix was clickable but the Income
// buckets matrix directly below it was not, so there was no way to see what had drained a
// pot. The buckets rows carried no `drill`, and the cash-flow index they would have read
// (_cfTxIndex, keyed by sub-category) groups credit-card payments differently from the way
// buildBucketBalances totals them — so reusing it would have shown a list that did not add
// up to the figure clicked.
//
// Fix: buildBucketBalances populates _bucketTxIndex (bucket → month → [tx]) in the SAME pass
// that totals the spend, and the Spent row drills that index via drillSrc:'bucket'.
//
// Money in and Running balance stay non-clickable on purpose: both are derived from net cash
// flow, not from a transaction list, so a drill could never total to the figure shown. This
// test pins that too — a future change that makes them clickable has to justify the figure.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures, FIELDS, makeFixtures } = require('./helpers');

const SUBCAT_NAME = 'fldO4BTJhFv5EsN6i';   // Sub Category Name (SUBCAT.name)
const BUCKET_NAME = 'fld58yk6iOatTIIxJ';   // Bucket (BUCKET.name)
const BUCKET_PCT = 'fldJkDpfd9p36ddbC';    // Allocation % (BUCKET.pct)
const BUCKET_SORT = 'fldtUTeLjEpPJAcoy';   // Sort Order (BUCKET.sort)
const BUCKET_SUBS = 'fld6yClkQoMlOkiU4';   // Spend Sub-Categories (BUCKET.spendSubs)
const NW = {                               // Specific Net Worth Statement by Month
  name: 'fldswqUWxdoQj1QPC',
  amount: 'fld4biGCBBQbknNmF',
  type: 'fld2uSD30IeWqEJYU',
  month: 'fldN3YpeJVK9MtW2d',
  year: 'fld0iFQ9PwFv0jKBa',
};

// The matrix shows a rolling 12 months ending on the current one. Anchor the fixtures on
// the LAST COMPLETED month so the figures land in a column that is not still in progress.
function lastCompletedMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const monthName = d.toLocaleDateString('en-GB', { month: 'long' });
  return { key, date: `${key}-10`, monthName, year: String(d.getFullYear()) };
}

function bucketFixtures() {
  const { date, monthName, year } = lastCompletedMonth();
  return {
    // The Wealth tab short-circuits to "No net worth data yet" with an empty statement,
    // so one snapshot row is the minimum needed to render the buckets matrix at all.
    netWorthByMonth: [
      { id: 'recNw1', fields: { [NW.name]: 'Santander', [NW.amount]: 15000, [NW.type]: 'Cash', [NW.month]: monthName, [NW.year]: year } },
    ],
    subCategories: [
      { id: 'recSubRentalIncome', fields: { [SUBCAT_NAME]: 'Rental Income' } },
      { id: 'recSubTravel', fields: { [SUBCAT_NAME]: 'Personal Travel' } },
    ],
    transactions: [
      {
        id: 'recTxIncome', fields: {
          [FIELDS.txName]: 'Rent received June',
          [FIELDS.txAmount]: 5000,
          [FIELDS.txReportAmount]: 5000,
          [FIELDS.txDate]: date,
          [FIELDS.txSubCategory]: ['recSubRentalIncome'],
          [FIELDS.txAccountAlias]: ['Santander'],
        }
      },
      {
        id: 'recTxTravel', fields: {
          [FIELDS.txName]: 'Flights to Lisbon',
          [FIELDS.txAmount]: -300,
          [FIELDS.txReportAmount]: -300,
          [FIELDS.txDate]: date,
          [FIELDS.txSubCategory]: ['recSubTravel'],
          [FIELDS.txAccountAlias]: ['Santander'],
        }
      },
    ],
    incomeBuckets: [
      {
        id: 'recBucketDreams', fields: {
          [BUCKET_NAME]: 'Dreams',
          [BUCKET_PCT]: 100,
          [BUCKET_SORT]: 1,
          [BUCKET_SUBS]: ['recSubTravel'],
        }
      },
    ],
  };
}

// Expand the bucket row and return the Spent row's cell for the last completed month.
async function spentCell(page) {
  const parent = page.locator('#wealthBuckets tr', { hasText: 'Dreams (100%)' }).first();
  await expect(parent).toBeVisible({ timeout: 15000 });
  await parent.locator('td').first().click();
  const spentRow = page.locator('#wealthBuckets tr', { hasText: 'Spent' }).first();
  await expect(spentRow).toBeVisible();
  // Columns: label, "In the pot" lead, then 12 months. The last completed month is the
  // second-to-last month column, i.e. index 12 of the row's cells.
  return spentRow.locator('td').nth(12);
}

test.describe('Income buckets — spend drill-down', () => {

  test('clicking a Spent figure opens the transactions behind it', async ({ page }) => {
    // The Wealth tab is not in no-crash-on-load's tab list, so this doubles as the
    // uncaught-error check for the buckets render + drill path.
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await loadDashboardWithFixtures(page, bucketFixtures(), 'wealth');
    await page.waitForTimeout(2500);

    const cell = await spentCell(page);
    await expect(cell).toHaveAttribute('onclick', /wealthDrill\(/);
    await expect(cell).toHaveText(/300/);

    await cell.click();
    const overlay = page.locator('#wealthDrillOverlay');
    await expect(overlay).toBeVisible({ timeout: 5000 });
    await expect(overlay).toContainText('Dreams');   // the bucket, not just the row label
    await expect(overlay).toContainText('Flights to Lisbon');
    await expect(overlay).toContainText('1 transaction');
    // The income transaction belongs to a different row and must not leak in.
    await expect(overlay).not.toContainText('Rent received June');

    expect(errors, `Uncaught errors on the Wealth tab:\n${errors.join('\n')}`).toEqual([]);
  });

  // A credit-card payment leaves two records with OPPOSITE Report Amounts: money out of
  // the current account and money into the card. cardPaymentsByMonth sums the signed
  // contributions; a drill that listed raw Report Amounts would show them cancelling.
  // Caught in review before this shipped: a £1,000 card leg and a £25 cash leg totalled
  // £975 in the modal against a Spent figure of £1,025.
  test('a credit-card bucket drill totals to the figure clicked, not to the two legs cancelling', async ({ page }) => {
    const { date } = lastCompletedMonth();
    const ACC_ALIAS = 'fld21HAxSawQCxICj';       // Account Alias (F.accountAlias)
    const ACC_NW_CLASS = 'fld8MHoybEal88D0Z';    // Net Worth Class (F.accNetWorthClass)
    const ACC_GBP = 'fldhDG5jDA8Tu2JyI';         // **GBP (F.accGBP)
    const fixtures = bucketFixtures();
    // cardPaymentsByMonth identifies the card leg by the account's Net Worth Class, so
    // the account fixtures have to carry it — the shared defaults do not.
    fixtures.accounts = [
      { id: 'recAccSantander', fields: { [ACC_ALIAS]: 'Santander', [ACC_GBP]: 15000, [ACC_NW_CLASS]: 'Cash' } },
      { id: 'recAccAmex', fields: { [ACC_ALIAS]: 'American Express', [ACC_GBP]: -1000, [ACC_NW_CLASS]: 'Credit Card' } },
    ];
    fixtures.subCategories.push({ id: 'recSubCardTransfer', fields: { [SUBCAT_NAME]: 'Personal Credit Card Transfer' } });
    fixtures.subCategories.push({ id: 'recSubTransfer', fields: { [SUBCAT_NAME]: 'Transfer' } });
    fixtures.incomeBuckets.push({
      id: 'recBucketDebt', fields: {
        [BUCKET_NAME]: 'Debt', [BUCKET_PCT]: 0, [BUCKET_SORT]: 2, [BUCKET_SUBS]: ['recSubCardTransfer'],
      }
    });
    fixtures.transactions.push(
      // Card leg: money INTO the Amex account, positive. Amex is a Credit Card account
      // in the default fixtures, so this is picked up with no tagging.
      { id: 'recTxCardLeg', fields: { [FIELDS.txName]: 'Amex paydown (card leg)', [FIELDS.txAmount]: 1000, [FIELDS.txReportAmount]: 1000, [FIELDS.txDate]: date, [FIELDS.txSubCategory]: ['recSubTransfer'], [FIELDS.txAccountAlias]: ['American Express'] } },
      // Cash leg on a card with no feed: negative, and the only record of that payment.
      { id: 'recTxCashLeg', fields: { [FIELDS.txName]: 'Barclaycard DD (cash leg)', [FIELDS.txAmount]: -25, [FIELDS.txReportAmount]: -25, [FIELDS.txDate]: date, [FIELDS.txSubCategory]: ['recSubCardTransfer'], [FIELDS.txAccountAlias]: ['Santander'] } },
    );

    await loadDashboardWithFixtures(page, fixtures, 'wealth');
    await page.waitForTimeout(2500);

    const parent = page.locator('#wealthBuckets tr', { hasText: 'Debt (0%)' }).first();
    await expect(parent).toBeVisible({ timeout: 15000 });
    await parent.locator('td').first().click();
    // Child rows carry class wm-child-<parent row id>, so locate Debt's Spent row via
    // its parent rather than by ordinal — bucket sort order must not decide what we test.
    const rid = await parent.evaluate(tr => tr.nextElementSibling.className.replace('wm-child-', ''));
    // Locate Spent BY TEXT among the bucket's children, never by ordinal. Until
    // 15 Aug 2026 this took .first() and assumed Spent led; PR #86 made the pot
    // an actual balance, which put "Money in" first and left this asserting
    // against the wrong row. What the test is really about is the card-leg
    // arithmetic below, so it must not be sensitive to row order.
    const spentRow = page.locator(`#wealthBuckets tr.wm-child-${rid}`, { hasText: 'Spent' }).first();
    await expect(spentRow).toContainText('Spent');
    const cell = spentRow.locator('td').nth(12);
    await expect(cell).toHaveText(/1,025/);

    await cell.click();
    const overlay = page.locator('#wealthDrillOverlay');
    await expect(overlay).toBeVisible({ timeout: 5000 });
    await expect(overlay).toContainText('2 transactions');
    // Spend rows show a positive magnitude; the drill shows money out as a minus.
    await expect(overlay).toContainText('−£1,025.00');
  });

  // Only Spent is transaction-backed. Money in is a percentage share of net cash
  // flow and the pot is the cumulative of the two, so neither has a transaction
  // list that would total to the figure shown — offering a drill on them would
  // open a modal that cannot reconcile to the number clicked.
  //
  // Rewritten 15 Aug 2026. It used to look for a "Running balance" CHILD row;
  // PR #86 made the pot an actual balance and moved it onto the PARENT row, so
  // the locator matched nothing and the assertion passed against an empty set
  // in one direction while failing in the other. The balance is still asserted
  // here, on the row that now carries it.
  test('derived rows (money in, the pot balance) are not clickable', async ({ page }) => {
    await loadDashboardWithFixtures(page, bucketFixtures(), 'wealth');
    await page.waitForTimeout(2500);

    await spentCell(page); // expands the bucket

    // The parent row IS the balance now.
    const potRow = page.locator('#wealthBuckets tr', { hasText: 'Dreams (100%)' }).first();
    await expect(potRow).toBeVisible();
    await expect(potRow.locator('td').nth(12)).not.toHaveAttribute('onclick', /wealthDrill/);

    const rid = await potRow.evaluate(tr => tr.nextElementSibling.className.replace('wm-child-', ''));
    const moneyIn = page.locator(`#wealthBuckets tr.wm-child-${rid}`, { hasText: 'Money in' }).first();
    await expect(moneyIn).toBeVisible();
    await expect(moneyIn.locator('td').nth(12)).not.toHaveAttribute('onclick', /wealthDrill/);

    // Control: the sibling Spent row IS clickable, so a locator that quietly
    // matched nothing could not pass this block by default.
    const spent = page.locator(`#wealthBuckets tr.wm-child-${rid}`, { hasText: 'Spent' }).first();
    await expect(spent.locator('td').nth(12)).toHaveAttribute('onclick', /wealthDrill/);
  });

});
