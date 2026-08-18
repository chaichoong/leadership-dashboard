// Invariant: picking a personal Chart of Accounts entry moves Business to Personal
//
// Personal money can only belong to the Personal business. Before this rule the
// Business column kept whatever got there first — the AI matcher's guess, or the
// hard-coded 'Real Estate' that reconTenancyChanged() writes. Measured in Airtable
// on 2026-08-18: of 2,612 transactions sitting on a Personal sub-category, 58 were
// filed under Real Estate. Every one of those was a personal cost counted against
// the property portfolio's P&L.
//
// This drives the REAL reconRowHtml markup and the REAL inline onchange handlers,
// then reads back through the REAL resolveDropdownId — the same function Approve
// calls to decide what gets written to Airtable. Asserting on the input's visible
// text alone would pass even if the value failed to resolve to a record ID, which
// is the exact failure mode that silently drops a link on save.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures, FIELDS } = require('./helpers');

const CAT_NAME_FIELD = 'fldii4oUzSfmplihO'; // Chart of Accounts - Categories > Category Name
const SUB_NAME_FIELD = 'fldO4BTJhFv5EsN6i'; // Chart of Accounts - Sub Categories > Sub Category Name
const PERSONAL_BIZ_ID = 'reclAPC2vMx2Umuzb'; // pinned in REC.bizPersonal
const REAL_ESTATE_ID = 'recoGcXRXCniyJsTz';

// Real record IDs and names, read from the live base on 2026-08-18.
const FIXTURES = {
  businesses: [
    { id: PERSONAL_BIZ_ID, fields: { [FIELDS.bizName]: 'Personal', [FIELDS.bizActive]: true } },
    { id: REAL_ESTATE_ID, fields: { [FIELDS.bizName]: 'Real Estate', [FIELDS.bizActive]: true } },
    { id: 'reca9ofzhuw13ZzGE', fields: { [FIELDS.bizName]: 'Operations Director', [FIELDS.bizActive]: true } },
  ],
  categories: [
    { id: 'recudu9dEMx6e4v8z', fields: { [CAT_NAME_FIELD]: 'Personal Expense Tax Deductible' } },
    { id: 'recdy7UvyFQkJf8Fs', fields: { [CAT_NAME_FIELD]: 'Personal Income' } },
    { id: 'recPLQpXJCZQdxC7A', fields: { [CAT_NAME_FIELD]: 'Operating Expenses' } },
    { id: 'recnq8wLnvOOd20MG', fields: { [CAT_NAME_FIELD]: 'Revenue' } },
  ],
  tenancies: [
    {
      id: 'recTen1', fields: {
        [FIELDS.tenRef]: 'TEN-001',
        [FIELDS.tenRent]: 1200,
        [FIELDS.tenDueDay]: 1,
        [FIELDS.tenUnit]: ['recUnit1'],
        [FIELDS.tenLinkedTenant]: ['recTenant1'],
        [FIELDS.tenStatus]: 'Active',
        // The dropdown filters on Payment Status, not Status — a fixture that
        // only sets Status renders an empty tenancy picker and the test skips.
        [FIELDS.tenPayStatus]: 'In Payment',
        [FIELDS.tenUnitRef]: '12 High St, Flat 1',
        [FIELDS.tenProperty]: ['12 High St'],
        [FIELDS.tenStartDate]: '2025-01-01',
      }
    },
  ],
  subCategories: [
    { id: 'rec4fuKSWoK8ftkLJ', fields: { [SUB_NAME_FIELD]: 'Personal Health' } },
    { id: 'recS1AiGq8oDEzmZD', fields: { [SUB_NAME_FIELD]: 'Personal Tax' } },
    { id: 'recVYBcayO0dMsvsg', fields: { [SUB_NAME_FIELD]: 'Marketing' } },
    { id: 'recI8yCstyDP1Nd4b', fields: { [SUB_NAME_FIELD]: 'Rental Income' } },
  ],
};

const row = (over = {}) => ({
  txId: 'recTest1', txDate: '2026-08-01', txAccount: 'Santander',
  txVendor: 'BOOTS', txDesc: 'pharmacy', txAmount: -24.5,
  categoryId: '', subCatId: '', businessId: '', tenantId: '',
  tenancyId: '', unitId: '', propertyId: '', costId: '', status: '', matchType: '',
  ...over,
});

// Mount a real recon row, set one dropdown the way a person does (type the option
// text, fire `change`), and report what the Business column resolves to afterwards.
async function pickAndRead(page, { r, inputId, optionText }) {
  return page.evaluate(({ r, inputId, optionText }) => {
    const host = document.createElement('table');
    host.className = 'od-table';
    host.innerHTML = '<tbody>' + window.reconRowHtml(r, 0) + '</tbody>';
    document.body.appendChild(host);
    // reconRowHtml's handlers write back into _reconResults, so it must exist.
    window._reconResults = [JSON.parse(JSON.stringify(r))];

    const before = document.getElementById('recon-business-0').value;

    if (inputId) {
      const el = document.getElementById(inputId);
      el.value = optionText;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const bizInput = document.getElementById('recon-business-0');
    const out = {
      before,
      after: bizInput.value,
      // What Approve would actually send to Airtable.
      resolvedId: window.resolveDropdownId
        ? window.resolveDropdownId('recon-business-0')
        : [...document.getElementById(bizInput.getAttribute('list')).options]
            .find(o => o.value === bizInput.value)?.getAttribute('data-id') || '',
      persisted: window._reconResults[0].businessId,
    };
    host.remove();
    return out;
  }, { r, inputId, optionText });
}

test.describe('Reconciliation: personal Chart of Accounts forces Business = Personal', () => {
  test.beforeEach(async ({ page }) => {
    await loadDashboardWithFixtures(page, FIXTURES);
    await page.waitForFunction(() => typeof window.reconRowHtml === 'function', { timeout: 15000 });
  });

  test('a personal SUB-CATEGORY overwrites a business the AI already guessed', async ({ page }) => {
    // The regression itself: this row kept Real Estate on all 58 mismatched records.
    const out = await pickAndRead(page, {
      r: row({ businessId: REAL_ESTATE_ID }),
      inputId: 'recon-subcat-0',
      optionText: 'Personal Health',
    });
    expect(out.before).toBe('Real Estate');
    expect(out.after).toBe('Personal');
    expect(out.resolvedId).toBe(PERSONAL_BIZ_ID);
    // Without this a re-render (Split, panel reopen, smart refresh) reverts it.
    expect(out.persisted).toBe(PERSONAL_BIZ_ID);
  });

  test('a personal CATEGORY does it too, on its own', async ({ page }) => {
    const out = await pickAndRead(page, {
      r: row({ businessId: REAL_ESTATE_ID }),
      inputId: 'recon-cat-0',
      optionText: 'Personal Income',
    });
    expect(out.after).toBe('Personal');
    expect(out.resolvedId).toBe(PERSONAL_BIZ_ID);
  });

  test('it fills an empty Business column', async ({ page }) => {
    const out = await pickAndRead(page, {
      r: row({ businessId: '' }),
      inputId: 'recon-subcat-0',
      optionText: 'Personal Tax',
    });
    expect(out.before).toBe('');
    expect(out.resolvedId).toBe(PERSONAL_BIZ_ID);
  });

  // The rule must not fire on business money, or it would quietly reassign
  // every Marketing and Rental Income row to Personal.
  test('a business sub-category leaves the Business column untouched', async ({ page }) => {
    const out = await pickAndRead(page, {
      r: row({ businessId: REAL_ESTATE_ID }),
      inputId: 'recon-subcat-0',
      optionText: 'Marketing',
    });
    expect(out.after).toBe('Real Estate');
    expect(out.resolvedId).toBe(REAL_ESTATE_ID);
  });

  test('a business category leaves the Business column untouched', async ({ page }) => {
    const out = await pickAndRead(page, {
      r: row({ businessId: REAL_ESTATE_ID }),
      inputId: 'recon-cat-0',
      optionText: 'Revenue',
    });
    expect(out.after).toBe('Real Estate');
  });

  // One-way by design. Which business a business cost belongs to is a real
  // decision; moving it back off Personal automatically would undo Kevin's edit.
  test('switching back to a business category does NOT move Business off Personal', async ({ page }) => {
    const out = await pickAndRead(page, {
      r: row({ businessId: PERSONAL_BIZ_ID, subCatId: 'recVYBcayO0dMsvsg' }),
      inputId: 'recon-cat-0',
      optionText: 'Operating Expenses',
    });
    expect(out.after).toBe('Personal');
  });

  // A half-typed entry resolves to no record. Reacting to it would be guessing.
  test('an unresolved half-typed sub-category changes nothing', async ({ page }) => {
    const out = await pickAndRead(page, {
      r: row({ businessId: REAL_ESTATE_ID }),
      inputId: 'recon-subcat-0',
      optionText: 'Person',
    });
    expect(out.after).toBe('Real Estate');
  });
  // The DOM rule alone would leave two paths wide open. Both write to Airtable
  // without any row on screen, and one of them TEACHES what it wrote.
  test.describe('the headless paths obey the same rule', () => {
    // reconTenancyChanged hard-sets Business to Real Estate and only fills
    // Sub-Category when it is empty, so a personal sub-category already on the
    // row survives the tenancy pick. Setting a value in code fires no change
    // event, so nothing re-runs the rule unless it is re-asserted.
    test('picking a tenancy does not strand a personal sub-category on Real Estate', async ({ page }) => {
      const after = await page.evaluate(() => {
        const host = document.createElement('table');
        host.className = 'od-table';
        host.innerHTML = '<tbody>' + window.reconRowHtml({
          txId: 'recTest1', txDate: '2026-08-01', txAccount: 'Santander',
          txVendor: 'BOOTS', txDesc: 'pharmacy', txAmount: -24.5,
          categoryId: '', subCatId: 'rec4fuKSWoK8ftkLJ', businessId: '',
          tenantId: '', tenancyId: '', unitId: '', propertyId: '', costId: '',
          status: '', matchType: '',
        }, 0) + '</tbody>';
        document.body.appendChild(host);
        window._reconResults = [{ subCatId: 'rec4fuKSWoK8ftkLJ' }];

        // Pick the first real tenancy the dropdown offers, the way a person would.
        const ten = document.getElementById('recon-tenancy-0');
        const opts = [...document.getElementById(ten.getAttribute('list')).options];
        if (!opts.length) return { skipped: true };
        ten.value = opts[0].value;
        ten.dispatchEvent(new Event('input', { bubbles: true }));
        ten.dispatchEvent(new Event('change', { bubbles: true }));

        const out = { biz: document.getElementById('recon-business-0').value,
                      sub: document.getElementById('recon-subcat-0').value };
        host.remove();
        return out;
      });
      if (after.skipped) test.skip(true, 'no tenancy fixtures loaded');
      expect(after.sub).toBe('Personal Health');
      expect(after.biz).toBe('Personal'); // not 'Real Estate'
    });

    // The auto-reconcile agent PATCHes straight from the match result and then
    // feeds that same pairing to saveReconRule. A wrong business there does not
    // just mis-file one transaction, it becomes a learned rule.
    test('the matcher output carries Personal, so the agent and the knowledge base do too', async ({ page }) => {
      const out = await page.evaluate(() => {
        const r = {
          txId: 'recTest9', txVendor: 'BOOTS', txAmount: -24.5,
          categoryId: '', categoryName: '',
          subCatId: 'rec4fuKSWoK8ftkLJ', subCatName: 'Personal Health',
          businessId: 'recoGcXRXCniyJsTz', businessName: 'Real Estate',
        };
        window.forcePersonalBusiness(r);
        return { id: r.businessId, name: r.businessName };
      });
      expect(out.id).toBe(PERSONAL_BIZ_ID);
      expect(out.name).toBe('Personal');
    });

    test('the matcher output leaves business money alone', async ({ page }) => {
      const out = await page.evaluate(() => {
        const r = {
          txId: 'recTest8', txVendor: 'GOOGLE ADS', txAmount: -300,
          categoryId: '', categoryName: 'Operating Expenses',
          subCatId: 'recVYBcayO0dMsvsg', subCatName: 'Marketing',
          businessId: 'recoGcXRXCniyJsTz', businessName: 'Real Estate',
        };
        window.forcePersonalBusiness(r);
        return { id: r.businessId, name: r.businessName };
      });
      expect(out.id).toBe(REAL_ESTATE_ID);
      expect(out.name).toBe('Real Estate');
    });

    // Never invent a value the picker cannot hold: an input whose text is not a
    // datalist option resolves to '' on Approve and the business silently drops.
    test('it leaves the column alone when Personal is not in the pick list', async ({ page }) => {
      const out = await page.evaluate(() => {
        const host = document.createElement('table');
        host.className = 'od-table';
        host.innerHTML = '<tbody>' + window.reconRowHtml({
          txId: 'recTest7', txDate: '2026-08-01', txAccount: 'Santander',
          txVendor: 'BOOTS', txDesc: 'pharmacy', txAmount: -24.5,
          categoryId: '', subCatId: '', businessId: 'recoGcXRXCniyJsTz',
          tenantId: '', tenancyId: '', unitId: '', propertyId: '', costId: '',
          status: '', matchType: '',
        }, 0) + '</tbody>';
        document.body.appendChild(host);
        window._reconResults = [{}];

        // Strip Personal out of the business picker, then make a personal pick.
        const bizEl = document.getElementById('recon-business-0');
        [...document.getElementById(bizEl.getAttribute('list')).options]
          .filter(o => o.getAttribute('data-id') === 'reclAPC2vMx2Umuzb')
          .forEach(o => o.remove());

        const sub = document.getElementById('recon-subcat-0');
        sub.value = 'Personal Health';
        sub.dispatchEvent(new Event('input', { bubbles: true }));
        sub.dispatchEvent(new Event('change', { bubbles: true }));

        const after = bizEl.value;
        host.remove();
        return after;
      });
      expect(out).toBe('Real Estate');
    });

  });
});
