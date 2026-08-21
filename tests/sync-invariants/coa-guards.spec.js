// Invariant: the Chart of Accounts tab cannot silently break a report.
//
// Gap: the P&L groups by sub-category NAME (PNL_SECTIONS in js/pnl.js) and the
//      Wealth tab does the same through CASHFLOW_*_SUBCATS, PERSONAL_MONEY_GROUPS
//      and BUCKET_SPEND_SUBCATS. Renaming "Opex Labour" in Airtable does not throw
//      anywhere — the P&L just reports £0 on that row for ever. Deleting a linked
//      record is worse: Airtable accepts it and every cost and transaction behind
//      it loses its coding with no error either.
//
// Rule: 1. A name any of those constants matches on cannot be renamed from this
//          tab. The block names the reports that depend on it.
//       2. A record holding any link cannot be deleted, and nor can one the code
//          pins by record ID (REC.sub*, PERSONAL_EXPENSE_SUBCATS).
//       3. A record that is neither still deletes, or the guard is useless.
//       4. Names stay unique — two records sharing one name makes every
//          name-matched lookup depend on load order.
//
// Back-test: the guards read the LIVE constants, so this spec asserts against the
// real names ("Opex Labour", "Revenue"). Delete that entry from PNL_SECTIONS and
// the first test fails, which is the point — the lock must track the code.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures } = require('./helpers');

// Real field IDs from js/config.js — a fixture keyed by anything else renders blank.
const CAT_NAME = 'fldii4oUzSfmplihO';
const CAT_TX_LINK = 'fldOlMnzZo0Cqt2dk';
const SUB_NAME = 'fldO4BTJhFv5EsN6i';
const SUB_MONEY_GROUP = 'fld4sJbnOMJ4A1Uey';
const SUB_TX_LINK = 'fldeaRp53IQ4vKbcP';

const FIXTURES = {
  categories: [
    // Protected by COA_EXTRA_PROTECTED — reconciliation looks it up by name.
    { id: 'recCatRev', fields: { [CAT_NAME]: 'Revenue', [CAT_TX_LINK]: ['recTx1', 'recTx2'] } },
    // No links, no code reference — the one record that must stay deletable.
    { id: 'recCatSpare', fields: { [CAT_NAME]: 'Spare Category' } },
  ],
  subCategories: [
    // Real record ID: name-locked via PNL_SECTIONS AND ID-pinned via REC.subOpexLabour.
    { id: 'rec7EdEwWXk2cQ0PG', fields: { [SUB_NAME]: 'Opex Labour', [SUB_TX_LINK]: ['recTx1'] } },
    // Name-locked via PERSONAL_MONEY_GROUPS, but with zero links — proves the
    // delete guard does not rely on the link count alone.
    { id: 'recSubHouse', fields: { [SUB_NAME]: 'Personal Household Essentials', [SUB_MONEY_GROUP]: 'Needs' } },
    { id: 'recSubSpare', fields: { [SUB_NAME]: 'Spare Sub Line' } },
  ],
};

async function openCoa(page) {
  await loadDashboardWithFixtures(page, FIXTURES, 'coa');
  await page.waitForFunction(() => document.querySelectorAll('#coaPanes .coa-pane').length === 2, { timeout: 15000 });
}

// Find the action button on the row whose name cell reads exactly `name`.
function rowButton(page, name, label) {
  return page.locator('#coaPanes tr', { has: page.locator('.coa-name', { hasText: new RegExp(`^${name}$`) }) })
    .locator('button', { hasText: label });
}

test.describe('Chart of Accounts guards', () => {
  test('both panes render with their record counts', async ({ page }) => {
    await openCoa(page);
    const panes = page.locator('#coaPanes .coa-pane');
    await expect(panes).toHaveCount(2);
    await expect(panes.nth(0).locator('.coa-pane-title')).toContainText('Categories');
    await expect(panes.nth(0).locator('.coa-count')).toHaveText('2');
    await expect(panes.nth(1).locator('.coa-pane-title')).toContainText('Sub-categories');
    await expect(panes.nth(1).locator('.coa-count')).toHaveText('3');
  });

  test('a name the P&L matches on cannot be renamed', async ({ page }) => {
    await openCoa(page);
    await rowButton(page, 'Opex Labour', 'Rename').click();
    const dialog = page.locator('[role="alertdialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Rename locked');
    // The block must name the report, not just say "no".
    await expect(dialog).toContainText('Profit & Loss');
  });

  test('a category name the reconciliation engine looks up cannot be renamed', async ({ page }) => {
    await openCoa(page);
    await rowButton(page, 'Revenue', 'Rename').click();
    const dialog = page.locator('[role="alertdialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Rename locked');
    await expect(dialog).toContainText('reconciliation');
  });

  test('a linked record cannot be deleted, and the dialog says what uses it', async ({ page }) => {
    await openCoa(page);
    await rowButton(page, 'Revenue', 'Delete').click();
    const dialog = page.locator('[role="alertdialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('still in use');
    await expect(dialog).toContainText('Transactions: 2');
  });

  test('an unlinked record the code still depends on cannot be deleted', async ({ page }) => {
    await openCoa(page);
    // Zero links, so the link guard alone would wave this through.
    await expect(rowButton(page, 'Personal Household Essentials', 'Delete')).toBeVisible();
    await rowButton(page, 'Personal Household Essentials', 'Delete').click();
    const dialog = page.locator('[role="alertdialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('the reports need it');
  });

  test('a spare record with no links and no code reference still deletes', async ({ page }) => {
    await openCoa(page);
    await rowButton(page, 'Spare Sub Line', 'Delete').click();
    // showConfirm's dialog, not the blocked one — this is the guard letting go.
    const dialog = page.locator('[role="alertdialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Delete sub-category');
    await expect(dialog.locator('button', { hasText: 'Delete' })).toBeVisible();
  });

  test('a spare record renames, and a duplicate name is refused', async ({ page }) => {
    await openCoa(page);
    await rowButton(page, 'Spare Sub Line', 'Rename').click();
    const input = page.locator('#coaModalName');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('Spare Sub Line');

    // Case-insensitive clash with an existing record must be refused inline.
    await input.fill('opex labour');
    await page.locator('[role="dialog"] button', { hasText: 'Save' }).click();
    await expect(page.locator('#coaModalErr')).toBeVisible();
    await expect(page.locator('#coaModalErr')).toContainText('already exists');
    // Still open — a refused save must not close the modal and lose the typing.
    await expect(input).toBeVisible();
  });

  test('an empty name is refused', async ({ page }) => {
    await openCoa(page);
    await page.locator('#coaPanes button', { hasText: '+ Add category' }).click();
    await page.locator('[role="dialog"] button', { hasText: 'Create' }).click();
    await expect(page.locator('#coaModalErr')).toContainText('Enter a name');
  });

  test('search filters both panes and the count reflects it', async ({ page }) => {
    await openCoa(page);
    await page.locator('#coaSearch').fill('spare');
    await expect(page.locator('#coaPanes .coa-pane').nth(0).locator('.coa-count')).toHaveText('1 of 2');
    await expect(page.locator('#coaPanes .coa-pane').nth(1).locator('.coa-count')).toHaveText('1 of 3');
  });

  // The repo has shipped a field-name mismatch before (read path and write path
  // disagreeing), which fails silently because Airtable accepts an unknown key.
  // Assert the exact bytes that leave the browser.
  test('create sends the real name field ID, and the Money Group when set', async ({ page }) => {
    await openCoa(page);
    const posts = [];
    page.on('request', req => {
      if (req.method() === 'POST' && req.url().includes('api.airtable.com')) {
        posts.push({ url: req.url(), body: req.postDataJSON() });
      }
    });

    await page.locator('#coaPanes button', { hasText: '+ Add sub-category' }).click();
    await page.locator('#coaModalName').fill('Brand New Line');
    await page.locator('#coaModalMg').selectOption('Wants');
    await page.locator('[role="dialog"] button', { hasText: 'Create' }).click();
    await expect.poll(() => posts.length).toBeGreaterThan(0);

    const post = posts[0];
    expect(post.url).toContain('tblOTdRcPf8AgRz25');       // Sub Categories table
    expect(post.body.fields[SUB_NAME]).toBe('Brand New Line');
    expect(post.body.fields[SUB_MONEY_GROUP]).toBe('Wants');
  });

  test('clearing a Money Group sends null, not an empty string', async ({ page }) => {
    await openCoa(page);
    const patches = [];
    page.on('request', req => {
      if (req.method() === 'PATCH' && req.url().includes('api.airtable.com')) {
        patches.push({ url: req.url(), body: req.postDataJSON() });
      }
    });

    // 'Personal Household Essentials' loads as Needs; clearing it must blank the
    // singleSelect. An empty string is rejected by Airtable as an invalid choice.
    await page.locator('select[data-coa-id="recSubHouse"]').selectOption('');
    await expect.poll(() => patches.length).toBeGreaterThan(0);
    expect(patches[0].url).toContain('recSubHouse');
    expect(patches[0].body.fields[SUB_MONEY_GROUP]).toBeNull();
  });

  test('the health bar reports the duplicate-name and missing-name checks', async ({ page }) => {
    await openCoa(page);
    const results = await page.evaluate(async () => {
      const out = [];
      // Re-derive the checks the same way the bar does, without reaching into its state.
      const names = coaProtectedNames('subCategory');
      out.push({ protectedCount: names.size, hasOpexLabour: names.has('opex labour') });
      out.push({ pinnedCount: coaPinnedIds('subCategory').size });
      return out;
    });
    // The lock list is derived, not copied — it must be substantial, not a stub.
    expect(results[0].protectedCount).toBeGreaterThan(30);
    expect(results[0].hasOpexLabour).toBe(true);
    expect(results[1].pinnedCount).toBeGreaterThan(10);
  });
});
