// Invariant: paying a bill EARLY must not flag the cost as overdue (commit fbe6ce3)
//
// Bug: enrichCost tested `paidThisPeriod = lastRecon >= expectedThisPeriod`. Direct debits
// routinely clear a few days before the due day, so an early payment scored as UNPAID and
// daysOverdue was then counted from the due date. Paying ahead of time made a bill read as
// overdue. 5 of 21 overdue costs were this — Sky TV (due 30, paid 29 Jun) read 16d overdue
// while fully paid. Fix: a 7-day early-payment tolerance.
//
// The tolerance is deliberately scoped to the Due-Day-anchored path (Monthly, or frequency
// unset). Every other frequency derives `expected` FROM lastReconDate, so lastRecon can never
// reach it. On Daily/Weekly, `expected - 7d` lands on or before lastRecon itself, so a blanket
// tolerance would mark those costs permanently paid and silence real overdues. The Weekly case
// below is the guard against exactly that over-correction — it is the test that fails if
// someone "simplifies" the fix by dropping the dueDayAnchored condition.
//
// Clock is frozen so the arithmetic is deterministic. All dates are weekdays, so
// shiftWeekendToMonday is a no-op and the expected dates are exactly as written.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures, FIELDS } = require('./helpers');

// Thu 16 Jul 2026. Chosen so that for dueDay 30 the current month's due day (30 Jul) is still
// in the future, making "expected this period" = Tue 30 Jun 2026.
const FROZEN_NOW = new Date('2026-07-16T09:00:00Z');

const COSTS = [
  {
    // Sky TV, exactly as it was in production: due 30, cleared 29 Jun. One day early.
    // expected = 30 Jun; tolerance cutoff = 23 Jun; 29 Jun >= 23 Jun => paid.
    id: 'recCostPaidEarly',
    fields: {
      [FIELDS.costName]: 'ZZ Test Paid One Day Early',
      [FIELDS.costExpected]: 129.99,
      [FIELDS.costDueDay]: 30,
      [FIELDS.costFrequency]: 'Monthly',
      [FIELDS.costPayStatus]: 'In Payment',
      [FIELDS.costLastReconDate]: '2026-06-29',
    },
  },
  {
    // Control: genuinely unpaid. Same due day, but last payment was 30 Apr — far outside the
    // 7-day window. Must still read overdue, proving the tolerance does not mask real misses.
    id: 'recCostReallyOverdue',
    fields: {
      [FIELDS.costName]: 'ZZ Test Genuinely Overdue',
      [FIELDS.costExpected]: 50,
      [FIELDS.costDueDay]: 30,
      [FIELDS.costFrequency]: 'Monthly',
      [FIELDS.costPayStatus]: 'In Payment',
      [FIELDS.costLastReconDate]: '2026-04-30',
    },
  },
  {
    // The over-correction guard. Weekly: expected = lastRecon + 7d = 8 Jun, which is exactly
    // 7 days after lastRecon (1 Jun). A blanket tolerance computes cutoff = 8 Jun - 7d = 1 Jun,
    // and 1 Jun >= 1 Jun is TRUE — the cost would read "paid" forever despite being ~38 days
    // overdue. Scoping the tolerance to Monthly keeps this correctly flagged.
    id: 'recCostWeekly',
    fields: {
      [FIELDS.costName]: 'ZZ Test Weekly Not Paid',
      [FIELDS.costExpected]: 25,
      [FIELDS.costDueDay]: 1,
      [FIELDS.costFrequency]: 'Weekly',
      [FIELDS.costPayStatus]: 'In Payment',
      [FIELDS.costLastReconDate]: '2026-06-01',
    },
  },
];

async function rowText(page, costName) {
  return page.evaluate((name) => {
    const scope = document.getElementById('tab-costs');
    if (!scope) return null;
    const tr = [...scope.querySelectorAll('table tr')].find((r) => r.innerText.includes(name));
    return tr ? tr.innerText.replace(/\s+/g, ' ').trim() : null;
  }, costName);
}

test.describe('Overdue: early payment tolerance', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: FROZEN_NOW });
  });

  test('a bill paid one day early is NOT overdue', async ({ page }) => {
    await loadDashboardWithFixtures(page, { costs: COSTS }, 'costs');
    const row = await rowText(page, 'ZZ Test Paid One Day Early');
    expect(row, 'the early-paid cost should render on the costs tab').toBeTruthy();
    // The regression: this row used to read "16d overdue" despite being paid.
    expect(row).not.toMatch(/\d+d overdue/);
    expect(row).toContain('paid this period');
  });

  test('a genuinely unpaid bill IS still overdue (tolerance does not mask real misses)', async ({ page }) => {
    await loadDashboardWithFixtures(page, { costs: COSTS }, 'costs');
    const row = await rowText(page, 'ZZ Test Genuinely Overdue');
    expect(row, 'the overdue cost should render on the costs tab').toBeTruthy();
    expect(row).toMatch(/\d+d overdue/);
  });

  test('Weekly costs keep a real overdue — tolerance must not apply off the Due-Day path', async ({ page }) => {
    await loadDashboardWithFixtures(page, { costs: COSTS }, 'costs');
    const row = await rowText(page, 'ZZ Test Weekly Not Paid');
    expect(row, 'the weekly cost should render on the costs tab').toBeTruthy();
    // Fails if the tolerance is ever applied to non-Monthly frequencies: a blanket
    // `expected - 7d` marks every Weekly cost permanently paid.
    expect(row).not.toContain('paid this period');
    expect(row).toMatch(/\d+d overdue/);
  });
});
