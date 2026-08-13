// Invariant: the cash flow Opening Balance sub-line shows the per-account split,
// and NEVER shows a split that does not add up to the headline figure.
//
// THE MISS THIS TEST EXISTS TO PREVENT. The sub-line used to be the static text
// "Santander + TNT Zempler". Adding the real balances is easy; the trap is that
// the split is read from the `allAccounts` global rather than from the
// openingBalance argument the forecast is actually built on. If allAccounts is
// empty or a record id changes, a naive read yields 0 for both parts and the
// card renders "Santander £0.00 | TNT Zempler £0.00" under a correct total —
// a wrong number, presented confidently, with nothing thrown and nothing logged.
// That is exactly the failure mode CLAUDE.md's "every number needs a source"
// rule exists for, so the fall-back is asserted here as hard as the happy path.

const { test, expect } = require('@playwright/test');
const { FIELDS, makeFixtures, loadDashboard, loadDashboardWithFixtures } = require('./helpers');

const SANTANDER_ID = 'rec3LiEiifomEHlvy';
const ZEMPLER_ID = 'recsR9QhRKYwgV8oP';

// Read the sub-line under the cash flow "Opening Balance" card specifically.
// The dashboard has its OWN Opening Balance card in #financialCards, so this
// must be scoped to #cashflowKPIs or the test passes on the wrong element.
async function openingSubText(page) {
  return page.evaluate(() => {
    const host = document.getElementById('cashflowKPIs');
    if (!host) return null;
    const card = [...host.querySelectorAll('.kpi-card')].find(
      c => c.querySelector('.kpi-card-label')?.textContent.trim() === 'Opening Balance');
    return card ? card.querySelector('.kpi-card-sub')?.textContent.trim() : null;
  });
}

async function openingValueText(page) {
  return page.evaluate(() => {
    const host = document.getElementById('cashflowKPIs');
    const card = [...host.querySelectorAll('.kpi-card')].find(
      c => c.querySelector('.kpi-card-label')?.textContent.trim() === 'Opening Balance');
    return card?.querySelector('.kpi-card-value')?.textContent.trim();
  });
}

test.describe('Cash flow Opening Balance — per-account split', () => {

  test('sub-line shows both account balances, and they sum to the headline', async ({ page }) => {
    // Fixtures: Santander £15,000 + TNT Zempler £5,000 = £20,000
    await loadDashboard(page);
    await page.waitForFunction(() => !!document.getElementById('cashflowKPIs')?.innerHTML.trim());

    const sub = await openingSubText(page);
    expect(sub).toContain('Santander');
    expect(sub).toContain('TNT Zempler');

    // The figures must be the real balances, not the old static label.
    expect(sub).not.toBe('Santander + TNT Zempler');
    expect(sub).toMatch(/Santander\s*£15,000/);
    expect(sub).toMatch(/TNT Zempler\s*£5,000/);

    // And the parts must reconcile with the headline they sit under.
    expect(await openingValueText(page)).toMatch(/£20,000/);
  });

  test('a zero balance still renders as a figure, not a blank', async ({ page }) => {
    const f = makeFixtures();
    f.accounts = f.accounts.map(a =>
      a.id === ZEMPLER_ID ? { ...a, fields: { ...a.fields, [FIELDS.accGBP]: 0 } } : a);

    await loadDashboardWithFixtures(page, { accounts: f.accounts });
    await page.waitForFunction(() => !!document.getElementById('cashflowKPIs')?.innerHTML.trim());

    const sub = await openingSubText(page);
    expect(sub).toMatch(/TNT Zempler\s*£0/);
    expect(await openingValueText(page)).toMatch(/£15,000/);
  });

  test('falls back to the generic label rather than showing £0.00 parts under a real total', async ({ page }) => {
    // The dangerous case: the forecast has a real opening balance but the split
    // cannot be derived (record ids changed / accounts not loaded). It must NOT
    // invent "Santander £0.00 | TNT Zempler £0.00".
    const f = makeFixtures();
    const santBal = f.accounts.find(a => a.id === SANTANDER_ID).fields[FIELDS.accGBP];
    const zempBal = f.accounts.find(a => a.id === ZEMPLER_ID).fields[FIELDS.accGBP];

    await loadDashboard(page);
    await page.waitForFunction(() => !!document.getElementById('cashflowKPIs')?.innerHTML.trim());

    // Control: prove the split renders BEFORE we break it. Without this, a
    // selector typo would make the assertion below pass for the wrong reason.
    expect(await openingSubText(page)).toMatch(/Santander\s*£15,000/);

    // Now blank the accounts global and rebuild the forecast from the stored args.
    await page.evaluate(() => { allAccounts = []; waRecalc(); });

    const sub = await openingSubText(page);
    expect(sub).toBe('Santander + TNT Zempler');
    expect(sub).not.toContain('£0.00');

    // The headline itself is unaffected — it comes from the argument, not the global.
    expect(await openingValueText(page)).toMatch(/£20,000/);
    expect(santBal + zempBal).toBe(20000);
  });
});
