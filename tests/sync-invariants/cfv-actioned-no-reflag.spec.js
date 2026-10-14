// Invariant: a tenancy already marked CFV or CFV Actioned is never "re-flagged" as a CFV.
//
// Kevin, 14 Oct 2026: "if it's a CFV or a CFV Actioned, it's still a CFV. It doesn't need to be
// re-flagged as one." The CFV page used to re-flag every CFV Actioned tenancy once this month's
// rent day was 2 days past with no payment. An actioned tenancy is unpaid by definition, so it
// re-flagged every month, and "Confirm CFV" cleared the dismissal, so the row came straight back
// after he marked it Actioned again: three Confirm CFV -> Mark Actioned loops in 22 minutes on one
// tenancy on 28 Sep 2026. A CFV Actioned row now keeps "In Payment" and "Move to CFV"; moving it
// back when an expected payment is missed is his call, one click.
//
// Drives the real detector and the real render (renderCFVTab) on fixtures, with the clock pinned
// 19 days past the actioned tenancy's rent day, so the old rule would fire on any run date.
// Names, refs and amounts are invented.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures, FIELDS } = require('./helpers');

const F_SURNAME = 'fldOXazTqBWieEOK2';   // F.tenSurname in js/config.js
const FROZEN_NOW = new Date('2026-05-20T10:00:00');

function tenancy(id, ref, surname, status, dueDay, rent) {
  return {
    id, fields: {
      [FIELDS.tenRef]: ref,
      [F_SURNAME]: surname,
      [FIELDS.tenRent]: rent,
      [FIELDS.tenDueDay]: dueDay,
      [FIELDS.tenPayStatus]: status,
      [FIELDS.tenStatus]: 'Active',
      [FIELDS.tenStartDate]: '2025-01-01',
      [FIELDS.tenantPayType]: 'UC',
    },
  };
}

const TENANCIES = [
  tenancy('recTenActioned', 'TEN-ACT-1', 'Fernwick', 'CFV Actioned', 1, 650),
  tenancy('recTenConfirmed', 'TEN-CFV-1', 'Halloway', 'CFV', 3, 700),
  tenancy('recTenPotential', 'TEN-POT-1', 'Brackley', 'In Payment', 5, 725),
];

// One row of the CFV table, read by its tenancy ref: the status badge and the button labels.
async function readRow(page, ref) {
  return page.evaluate((ref) => {
    const row = [...document.querySelectorAll('#cfvTableBody tr')].find(tr => tr.textContent.includes(ref));
    if (!row) return null;
    const badge = row.querySelector('.cfv-status-badge');
    return {
      badge: badge ? badge.textContent.trim() : '',
      buttons: [...row.querySelectorAll('button')].map(b => b.textContent.trim()),
    };
  }, ref);
}

test.describe('CFV Actioned is never re-flagged', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: FROZEN_NOW });
    await loadDashboardWithFixtures(page, { tenancies: TENANCIES, transactions: [] }, 'cfv');
    await page.waitForFunction(
      () => [...document.querySelectorAll('#cfvTableBody tr')].some(tr => tr.textContent.includes('TEN-POT-1')),
      null, { timeout: 15000 });
  });

  test('a CFV Actioned tenancy past its rent day stays CFV Actioned, with no Confirm CFV step', async ({ page }) => {
    const row = await readRow(page, 'TEN-ACT-1');
    expect(row, 'the CFV Actioned tenancy is missing from the CFV table').not.toBeNull();
    expect(row.badge, 'a CFV Actioned tenancy was re-flagged').toBe('CFV Actioned');
    expect(row.buttons).not.toContain('Confirm CFV');
    expect(row.buttons).not.toContain('Dismiss');
    expect(row.buttons).toContain('In Payment');
    expect(row.buttons).toContain('Move to CFV');
  });

  test('a confirmed CFV stays a CFV and offers Mark Actioned', async ({ page }) => {
    const row = await readRow(page, 'TEN-CFV-1');
    expect(row).not.toBeNull();
    expect(row.badge).toBe('CFV');
    expect(row.buttons).toContain('Mark Actioned');
    expect(row.buttons).not.toContain('Confirm CFV');
  });

  test('a potential CFV still asks to be confirmed (unchanged)', async ({ page }) => {
    const row = await readRow(page, 'TEN-POT-1');
    expect(row).not.toBeNull();
    expect(row.badge).toBe('Potential CFV');
    expect(row.buttons).toContain('Confirm CFV');
    expect(row.buttons).toContain('Not a CFV');
  });
});
