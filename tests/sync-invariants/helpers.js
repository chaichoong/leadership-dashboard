// Shared helpers for sync-invariant tests.
// The live site requires an Airtable PAT — tests intercept API calls
// and return deterministic fixtures so tests run without credentials.

const { expect } = require('@playwright/test');

const MOCK_PAT = 'pat_test_mock_token_for_playwright';

// Real field IDs from js/config.js
const FIELDS = {
  bizName: 'fldbbRqVxLxUdHwIR',
  bizActive: 'fldhXBnRrngCVsgSk',
  tenRef: 'fldyNVvFn4x8GY14q',
  tenRent: 'fldDMyfZLFMeONPq8',
  tenDueDay: 'fldhy2U0CQmM2oS4P',
  tenPayStatus: 'fldxU3dPUnbK0SCDq',
  tenUnit: 'fld7cjLLEHKAx49OK',
  tenLinkedTenant: 'fld1i5bDoHL3B6rUf',
  tenStatus: 'fldgWAyha1Uij1SZP',
  tenUnitRef: 'fldql2nyQlPfkPP4p',
  tenProperty: 'fldxfIa0W1nqCbLo2',
  tenStartDate: 'fld2rPXwwV8dXb1zF',
  tenantPayType: 'fldZbrk8Xw5Dcwxhi',
  tenantName: 'fldxBKW7QnujSDWqA',
  txDate: 'fldoyQ6Rr9cHp3bgQ',
  txAmount: 'fldN01r1hp7UQjgtm',
  txReportAmount: 'fldot7iisZeL3WrdR',
  txReconciled: 'fldxKX1IbIFcAOnn5',
  txName: 'fldsbuAJCTsXHug4C',
  txTenancy: 'fldPmAMmxwqs4SdPa',
  txCategory: 'fldFPmNixqHPQy4D6',
  txSplitCount: 'fld20FWX7yjM8P2Kz',
  txBusiness: 'fldX1aFlJyzpXGhbF',
  txAccountAlias: 'fldBrjlbeaKFm3WzQ',
  txUnit: 'fldJGIhSbgXNIEW4a',
  txProperty: 'fldvp44VfF8uTTthp',
  txSubCategory: 'fldMRjSVzZVYeHb0A',
  txCost: 'fldGkpkVqSeiGvUGL',
  txVendor: 'fld0Xr8sboQ0ekJQJ',
  invDesc: 'fldT0onwVg9JDJ1sv',
  invAmount: 'fldauZCUSWeIfGryG',
  invBusiness: 'fldzGhwp6rxwEFoxu',
  invStatus: 'fldJ5InUPlY4t7MgP',
  costName: 'fldS6FYfpkhu6tJG0',
  costExpected: 'fld9JibXkMpTeMcxw',
  costDueDay: 'fld7IsfiGvKpxEwSs',
  costStatusNew: 'fldWl7mp9zTC2aaaQ',
  // Costs filter on the LEGACY Payment Status, not Cost Status (New) — see the
  // Data Lookups rule in CLAUDE.md. A fixture that only sets costStatusNew will
  // not appear in the active list.
  costPayStatus: 'fldXZNI96v8HgjuSh',
  costFrequency: 'fldvozTHvs5VH3lNi',
  costLastReconDate: 'fldeMdOxYemcJwVRD',
  accGBP: 'fldhDG5jDA8Tu2JyI',
  accountAlias: 'fld21HAxSawQCxICj',
  unitName: 'fldr8sliyu8h2jw9t',
  unitProperty: 'fldUJNRGgzgyAwwjt',
};

// Fixture data: minimal Airtable-style records for each table
function makeFixtures() {
  return {
    businesses: [
      { id: 'recBiz1', fields: { [FIELDS.bizName]: 'Active Corp', [FIELDS.bizActive]: true } },
      { id: 'recBiz2', fields: { [FIELDS.bizName]: 'Inactive Ltd', [FIELDS.bizActive]: false } },
      { id: 'recBiz3', fields: { [FIELDS.bizName]: 'Another Active', [FIELDS.bizActive]: true } },
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
          [FIELDS.tenUnitRef]: '12 High St, Flat 1',
          [FIELDS.tenProperty]: ['12 High St'],
          [FIELDS.tenStartDate]: '2025-01-01',
          [FIELDS.tenantPayType]: 'Working',
        }
      },
      {
        id: 'recTen2', fields: {
          [FIELDS.tenRef]: 'TEN-002',
          [FIELDS.tenRent]: 800,
          [FIELDS.tenDueDay]: 27,
          [FIELDS.tenUnit]: ['recUnit2'],
          [FIELDS.tenLinkedTenant]: ['recTenant2'],
          [FIELDS.tenStatus]: 'Active',
          [FIELDS.tenUnitRef]: '5 Low Rd, Ground',
          [FIELDS.tenProperty]: ['5 Low Rd'],
          [FIELDS.tenStartDate]: '2025-06-01',
          [FIELDS.tenantPayType]: 'UC',
        }
      },
    ],
    transactions: [
      {
        id: 'recTx1', fields: {
          [FIELDS.txName]: 'Rent Payment A',
          [FIELDS.txAmount]: 1200,
          [FIELDS.txReportAmount]: 1200,
          [FIELDS.txDate]: '2026-05-01',
          [FIELDS.txTenancy]: ['recTen1'],
          [FIELDS.txCategory]: ['recCat1'],
          [FIELDS.txSplitCount]: 1,
          [FIELDS.txReconciled]: true,
          [FIELDS.txBusiness]: ['recBiz1'],
          [FIELDS.txAccountAlias]: ['Santander'],
        }
      },
      {
        id: 'recTx2', fields: {
          [FIELDS.txName]: 'Rent Payment B',
          [FIELDS.txAmount]: 800,
          [FIELDS.txReportAmount]: 800,
          [FIELDS.txDate]: '2026-04-28',
          [FIELDS.txTenancy]: ['recTen2'],
          [FIELDS.txCategory]: ['recCat1'],
          [FIELDS.txSplitCount]: 1,
          [FIELDS.txReconciled]: true,
          [FIELDS.txBusiness]: ['recBiz1'],
          [FIELDS.txAccountAlias]: ['Santander'],
        }
      },
      {
        id: 'recTx3', fields: {
          [FIELDS.txName]: 'Stale Split Parent (Split 1 of 3)',
          [FIELDS.txAmount]: 3000,
          [FIELDS.txReportAmount]: 3000,
          [FIELDS.txDate]: '2026-04-15',
          [FIELDS.txCategory]: ['recCat2'],
          [FIELDS.txSplitCount]: 1,
          [FIELDS.txReconciled]: false,
          [FIELDS.txBusiness]: ['recBiz1'],
          [FIELDS.txAccountAlias]: ['Santander'],
        }
      },
    ],
    invoices: [
      { id: 'recInv1', fields: { [FIELDS.invDesc]: 'Plumbing repair', [FIELDS.invAmount]: 350, [FIELDS.invBusiness]: ['recBiz1'], [FIELDS.invStatus]: 'Unpaid' } },
      { id: 'recInv2', fields: { [FIELDS.invDesc]: 'Old service', [FIELDS.invAmount]: 100, [FIELDS.invBusiness]: ['recBiz2'], [FIELDS.invStatus]: 'Unpaid' } },
    ],
    rentalUnits: [
      { id: 'recUnit1', fields: { [FIELDS.unitName]: '12 High St, Flat 1', [FIELDS.unitProperty]: ['recProp1'] } },
      { id: 'recUnit2', fields: { [FIELDS.unitName]: '5 Low Rd, Ground', [FIELDS.unitProperty]: ['recProp2'] } },
    ],
    tenants: [
      { id: 'recTenant1', fields: { [FIELDS.tenantName]: 'John Smith', [FIELDS.tenantPayType]: 'Working' } },
      { id: 'recTenant2', fields: { [FIELDS.tenantName]: 'Jane Doe', [FIELDS.tenantPayType]: 'UC' } },
    ],
    categories: [
      { id: 'recCat1', fields: { 'fldCatName': 'Rent' } },
      { id: 'recCat2', fields: { 'fldCatName': 'Maintenance' } },
    ],
    subCategories: [
      { id: 'recSub1', fields: { 'fldSubName': 'Plumbing' } },
    ],
    costs: [
      { id: 'recCost1', fields: { [FIELDS.costName]: 'Insurance', [FIELDS.costExpected]: 200, [FIELDS.costDueDay]: 15, [FIELDS.costStatusNew]: 'In Payment' } },
    ],
    properties: [
      { id: 'recProp1', fields: { 'fldPropName': '12 High St' } },
      { id: 'recProp2', fields: { 'fldPropName': '5 Low Rd' } },
    ],
    accounts: [
      { id: 'rec3LiEiifomEHlvy', fields: { [FIELDS.accGBP]: 15000, [FIELDS.accountAlias]: 'Santander' } },
      { id: 'recsR9QhRKYwgV8oP', fields: { [FIELDS.accGBP]: 5000, [FIELDS.accountAlias]: 'TNT Mgt Zempler' } },
      { id: 'recPdnCnL0QvUQOiX', fields: { [FIELDS.accGBP]: -500, [FIELDS.accountAlias]: 'Lloyds CC' } },
      { id: 'recjJMy49enwgqWpo', fields: { [FIELDS.accGBP]: 200, [FIELDS.accountAlias]: 'American Express' } },
      { id: 'recwmjHfRZhODkFPV', fields: { [FIELDS.accGBP]: 4500, [FIELDS.accountAlias]: 'Santander CC' } },
    ],
    tasks: [],
    arrears: [],
  };
}

// Table ID → fixture key mapping
const TABLE_MAP = {
  'tblpqkvWJJo8Uu25q': 'businesses',
  'tblN51a88qTDB6iMH': 'tenancies',
  'tbln0gzhCAorFc3zB': 'transactions',
  'tblkOTKIG2Tyiy9aM': 'invoices',
  'tblM3mZCR5kiEdWMj': 'rentalUnits',
  'tblX4elTuu01gwBYh': 'tenants',
  'tbleWb8ioptnEwPR8': 'categories',
  'tblOTdRcPf8AgRz25': 'subCategories',
  'tblx5kvhzNEI5TFlS': 'costs',
  'tblqB8b22hKBL4PF1': 'tasks',
  'tbl6f0OkAmTC2jbuG': 'properties',
  'tbl1nr0EcX2T62KME': 'accounts',
  'tblzG0B9oRRpszcgC': 'arrears',
  'tblEBvFw8DonwxzGh': 'objStrat',
  'tbl065D58MBEJhjlp': 'mainMethods',
  'tblHrpTMd5LNYn8v1': 'projects',
  'tblbfuxYxu4uMMWwT': 'reconAudit',
};

/**
 * Set up route interception so Airtable API calls return fixture data.
 * Optionally pass custom fixtures to override defaults.
 */
async function setupMockAirtable(page, customFixtures = null) {
  const fixtures = customFixtures || makeFixtures();

  // Block Gmail script calls
  await page.route('**/script.google.com/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok","count":0}' });
  });

  await page.route('**/api.airtable.com/v0/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (method === 'PATCH' || method === 'POST' || method === 'DELETE') {
      let records = [];
      try { records = route.request().postDataJSON()?.records || []; } catch {}
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ records }),
      });
      return;
    }

    const tableMatch = url.match(/\/v0\/[^/]+\/([^?/]+)/);
    const tableId = tableMatch ? tableMatch[1] : null;
    const fixtureKey = TABLE_MAP[tableId];
    const records = fixtureKey ? (fixtures[fixtureKey] || []) : [];

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ records }),
    });
  });
}

/**
 * Navigate to the dashboard with mock auth pre-set.
 */
async function loadDashboard(page, hash = '') {
  await page.addInitScript((pat) => {
    localStorage.setItem('_dlr_pat', pat);
    // Clear IndexedDB cache so dashboard uses fresh mock data, not stale cached data
    try {
      indexedDB.deleteDatabase('_dlr_cache');
    } catch {}
  }, MOCK_PAT);

  await setupMockAirtable(page);
  await page.goto('/' + (hash ? '#' + hash : ''));
  await page.waitForFunction(() => {
    const overlay = document.getElementById('loadingOverlay');
    const dash = document.getElementById('dashboard');
    return (overlay && overlay.style.display === 'none') || (dash && dash.style.display !== 'none');
  }, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

/**
 * Load with custom fixture overrides.
 */
async function loadDashboardWithFixtures(page, fixtureOverrides, hash = '') {
  const fixtures = { ...makeFixtures(), ...fixtureOverrides };

  await page.addInitScript((pat) => {
    localStorage.setItem('_dlr_pat', pat);
    // Force-skip the dashboard cache so tests use fresh mock data.
    // indexedDB.deleteDatabase is async and may not finish before scripts run,
    // so we also monkeypatch the IDB open to return a dummy that always misses.
    try { indexedDB.deleteDatabase('_dlr_cache'); } catch {}
    // Override indexedDB.open to return a store that always yields undefined
    const origOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = function(name) {
      if (name === '_dlr_cache') {
        // Return a request that resolves to a DB with an empty store
        const req = origOpen(name + '_test_empty', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        return req;
      }
      return origOpen.apply(indexedDB, arguments);
    };
  }, MOCK_PAT);

  await setupMockAirtable(page, fixtures);
  await page.goto('/' + (hash ? '#' + hash : ''));
  await page.waitForFunction(() => {
    const overlay = document.getElementById('loadingOverlay');
    const dash = document.getElementById('dashboard');
    return (overlay && overlay.style.display === 'none') || (dash && dash.style.display !== 'none');
  }, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

module.exports = { MOCK_PAT, FIELDS, TABLE_MAP, makeFixtures, setupMockAirtable, loadDashboard, loadDashboardWithFixtures };
