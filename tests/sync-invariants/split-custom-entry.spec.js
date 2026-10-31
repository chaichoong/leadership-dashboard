// Invariant: a custom split amount takes what is typed, and a portion is set by
// Category, Sub-category and Business (Kevin, 31 Oct 2026).
//
// Bug: every keystroke in a Custom Amounts field redrew the whole split body and
// then called select() on the field, so the next key replaced the selection.
// Typing "123.45" left "5". Kevin: "you can't type into the amount field. It keeps
// overwriting itself." The same redraw also rebuilt every dropdown on each key.
//
// The fix redraws only the totals line. These tests type through the real
// keyboard into the real modal, so a revert to the full redraw fails at once,
// and they read the PATCH the real performReconSplit sends.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures, FIELDS } = require('./helpers');

const CAT_NAME_FIELD = 'fldii4oUzSfmplihO';
const SUB_NAME_FIELD = 'fldO4BTJhFv5EsN6i';
const TX_TABLE = 'tbln0gzhCAorFc3zB';
const F_CATEGORY = 'fldFPmNixqHPQy4D6';
const F_SUBCAT = 'fldMRjSVzZVYeHb0A';
const F_SPLIT_OVERRIDE = 'fldQ37YsyR9r3EbkP';
const F_TX_UNIT = 'fldJGIhSbgXNIEW4a';

const FIXTURES = {
  businesses: [
    { id: 'recBizRE', fields: { [FIELDS.bizName]: 'Real Estate', [FIELDS.bizActive]: true } },
  ],
  categories: [
    { id: 'recCatOpEx', fields: { [CAT_NAME_FIELD]: 'Operating Expenses' } },
  ],
  subCategories: [
    { id: 'recSubRepairs', fields: { [SUB_NAME_FIELD]: 'Repairs and Maintenance' } },
  ],
};

async function openCustomSplit(page, amount) {
  await page.evaluate(([amount, txAmountField]) => {
    (0, eval)(`allTransactions = [{ id:'recSplitSrc', fields: { '${txAmountField}': ${amount}, 'fld0Xr8sboQ0ekJQJ': 'Test Builders' } }]`);
    window._reconResults = [{
      txId: 'recSplitSrc', txDate: '2026-10-20', txVendor: 'Test Builders',
      txAccount: 'Santander', txAmount: amount, categoryId: '', subCatId: '', businessId: '',
    }];
    const existing = document.getElementById('reconSplitModal');
    if (existing) existing.remove();
    window.openReconSplitModal(0);
    window.setSplitMode('custom');
  }, [amount, FIELDS.txAmount]);
}

// Pick a datalist option the way a person does: its text in the input, then change.
async function pick(page, inputId, text) {
  await page.evaluate(([id, text]) => {
    const el = document.getElementById(id);
    el.value = text;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [inputId, text]);
}

test.describe('Split modal: custom amounts and the portion fields', () => {
  test.beforeEach(async ({ page }) => {
    await loadDashboardWithFixtures(page, FIXTURES);
    await page.waitForFunction(() => typeof window.openReconSplitModal === 'function', { timeout: 15000 });
  });

  test('a custom amount keeps every key typed', async ({ page }) => {
    await openCustomSplit(page, -300);
    const field = page.locator('#splitCustomRow-0 input[type="number"]');
    await field.click();
    await page.keyboard.type('123.45');
    // The old redraw left only the last key: "5".
    await expect(field).toHaveValue('123.45');
    expect(await page.evaluate(() => window._splitState.customRows[0].amount)).toBe(123.45);
    await expect(page.locator('#splitTotals')).toContainText('Left to allocate: £176.55');
  });

  test('the second amount types cleanly too and balancing opens Save', async ({ page }) => {
    await openCustomSplit(page, -300);
    await page.locator('#splitCustomRow-0 input[type="number"]').click();
    await page.keyboard.type('123.45');
    await page.locator('#splitCustomRow-1 input[type="number"]').click();
    await page.keyboard.type('176.55');
    await expect(page.locator('#splitCustomRow-1 input[type="number"]')).toHaveValue('176.55');
    await expect(page.locator('#splitTotals')).toContainText('Balanced');
    await expect(page.locator('#splitSaveBtn')).toBeEnabled();
  });

  test('a portion asks for Category, Sub-Category and Business, and no Tenancy', async ({ page }) => {
    await openCustomSplit(page, -300);
    const heads = await page.locator('#splitModalBody thead th').allTextContents();
    expect(heads.map(h => h.trim()).filter(Boolean)).toEqual(['#', 'Amount', 'Category', 'Sub-Category', 'Business']);
    await expect(page.locator('#split-cat-0')).toHaveCount(1);
    await expect(page.locator('[id^="split-tenancy-"]')).toHaveCount(0);
  });

  test('saving writes each portion its Category and clears inherited tenancy on the child', async ({ page }) => {
    const patches = [];
    // Registered after the fixture routes, so it wins for the transactions table.
    await page.route(`**/v0/*/${TX_TABLE}**`, async (route) => {
      const req = route.request();
      if (req.method() === 'PATCH') {
        patches.push({ url: req.url(), body: req.postDataJSON() });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', fields: {} }) });
        return;
      }
      // The poll for the automation's children: one child, created just now.
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: [
        { id: 'recSplitChild', createdTime: new Date().toISOString(), fields: {} },
      ] }) });
    });
    await openCustomSplit(page, -300);
    await page.locator('#splitCustomRow-0 input[type="number"]').click();
    await page.keyboard.type('100');
    await page.locator('#splitCustomRow-1 input[type="number"]').click();
    await page.keyboard.type('200');
    await pick(page, 'split-cat-0', 'Operating Expenses');
    await pick(page, 'split-subcat-0', 'Repairs and Maintenance');
    await pick(page, 'split-cat-1', 'Operating Expenses');
    await page.locator('#splitSaveBtn').click();
    await expect.poll(() => patches.filter(p => p.url.includes('recSplitChild')).length, { timeout: 15000 }).toBeGreaterThan(0);

    const src = patches.find(p => p.url.includes('recSplitSrc')).body.fields;
    expect(src[F_CATEGORY]).toEqual(['recCatOpEx']);
    expect(src[F_SUBCAT]).toEqual(['recSubRepairs']);
    // The sign guard still holds: an expense portion is written negative.
    expect(src[F_SPLIT_OVERRIDE]).toBe(-100);

    const child = patches.find(p => p.url.includes('recSplitChild')).body.fields;
    expect(child[F_CATEGORY]).toEqual(['recCatOpEx']);
    expect(child[F_SPLIT_OVERRIDE]).toBe(-200);
    // The automation copies the parent's tenancy onto the child; the split clears it.
    expect(child[FIELDS.txTenancy]).toEqual([]);
    expect(child[F_TX_UNIT]).toEqual([]);
  });
});
