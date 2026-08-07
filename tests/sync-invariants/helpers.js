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
    // js/prospecting.js reads these by field NAME (see fetchProspectingTable),
    // so the fixture is keyed by name, not by field ID like the tables above.
    // Body text is a real approved draft, so the preview spec exercises the
    // wording that actually goes out.
    prospects: [
      {
        id: 'recProsLtd', fields: {
          'Name': 'Jane Whitehouse',
          'Company': 'IS Group Signs Limited',
          'Contact Email': 'enquiries@is-group.co.uk',
          'Email Confidence': 'High',
          'Entity Type': 'Limited Company',
          'Contact Route': 'Email sequence (Ltd)',
          'Pain Signal': 'Advertising a part-time Bookkeeper.',
          'Email Subject': 'your part-time bookkeeper ad',
          'Draft Message': 'Hi Jane, I saw your part-time bookkeeper ad for isGroup. Worth a quick call? https://operationsdirector.co.uk/book-a-demo/',
          'Status': 'Ready for Review',
          'Date Found': '2026-08-06',
        }
      },
      {
        // Non-email route: must NOT gain a subject line or a signature.
        id: 'recProsLinkedIn', fields: {
          'Name': 'Sophie Hackett',
          'Company': 'Sophie Hackett Design',
          'Entity Type': 'Sole Trader / Partnership',
          'Contact Route': 'LinkedIn connect',
          'Draft Message': 'Saw your post about being buried in admin. Worth a chat?',
          'Status': 'Ready for Review',
          'Date Found': '2026-08-06',
        }
      },
      {
        // Carries the retired raw CRM widget URL, so the stale-link warning renders.
        id: 'recProsStale', fields: {
          'Name': 'Old Draft',
          'Company': 'Legacy Ltd',
          'Contact Email': 'hello@legacy.co.uk',
          'Entity Type': 'Limited Company',
          'Contact Route': 'Email sequence (Ltd)',
          'Draft Message': 'Worth a quick call? https://api.leadconnectorhq.com/widget/booking/BcVVhAg1zLaPVEXj5ih0',
          'Status': 'Ready for Review',
          'Date Found': '2026-08-06',
        }
      },
    ],
    prospectKeywords: [
      { id: 'recKw1', fields: { 'Keyword': 'drowning in admin', 'Type': 'Pain Phrase', 'Active': true } },
    ],
  };
}

// Allowlist of on-load GET fetches that may legitimately SKIP returnFieldsByFieldId.
// The invariant (two-way-sync + stale-data specs) is that main data reads use field IDs,
// so read and write paths can never drift on a field name (the Quarter End/QuarterEnd bug).
// A few read-only feature fetches read the response by field NAME on purpose and have no
// matching write path, so the mismatch bug cannot bite them. Each is named here with WHY.
//
// This replaced a bare "at most 2 exceptions" count on 2026-07-27. The count let ANY new
// by-name fetch pass as long as the total stayed under the cap, and silently went red once
// a third legitimate feature fetch was added — protecting nothing while blocking pushes.
// An allowlist keeps the invariant sharp: a by-name fetch on any table NOT listed here (or
// an accounts fetch that is not the Fintable sync) fails the test and names the offending URL.
//
// `match` (optional): a substring that MUST appear in the URL for the exception to apply.
// Used to pin the accounts exception to the Fintable sync specifically, so a plain by-name
// read of the (writable) Accounts table is still caught.
const BYNAME_FETCH_ALLOWLIST = [
  { table: 'tblZ75JgE1wzDP0ps', label: 'AI Brain Today badge — read-only display feed (shared.js updateAiBrainBadge)' },
  { table: 'tblJ3GFnAAoXf99e9', label: 'Agent Activity KPI — read-only card (dashboard.js loadAgentKpi)' },
  { table: 'tbl1nr0EcX2T62KME', label: 'Fintable accounts sync — filterByFormula/sort on {**Last Successful Update}', match: 'Last+Successful+Update' },
  // CEO Briefs (tblIxbzDSOCI5hqJn) was listed here until 2026-07-29. Both sides moved to
  // field IDs, so the tab now sends returnFieldsByFieldId=true like everything else and
  // needs no exception. Removing it keeps the invariant sharp: if the tab ever regresses
  // to a by-name read, this test fails and names the URL.
];

// Pull the Airtable table ID (tbl...) out of a v0 API URL.
function tableIdFromUrl(url) {
  const m = url.match(/\/v0\/[^/]+\/(tbl[A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// Assert every by-name (no returnFieldsByFieldId) on-load fetch is a known allowed exception.
// `urls` = the full URLs that skipped returnFieldsByFieldId. `expect` is passed in because
// helpers.js is required from the spec files. Fails loudly, naming each disallowed URL, so a
// new main-data by-name fetch cannot slip through.
function assertByNameFetchesAllowed(urls, expect) {
  const disallowed = urls.filter((url) => {
    const tid = tableIdFromUrl(url);
    return !BYNAME_FETCH_ALLOWLIST.some(
      (e) => e.table === tid && (!e.match || url.includes(e.match))
    );
  });
  expect(disallowed, `Unlisted by-name fetch(es) — add to BYNAME_FETCH_ALLOWLIST or use returnFieldsByFieldId=true:\n${disallowed.join('\n')}`).toEqual([]);
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
  'tblIxbzDSOCI5hqJn': 'ceoBriefs',
  'tbldMPjXTu7ho5f0T': 'incomeBuckets',
  'tblvtDXCBJCHu9hnK': 'netWorthByMonth',
  'tbljHVGJoKJf8acy3': 'prospects',
  'tblB5tZrXNaKFe02j': 'prospectKeywords',
};

// The app pulls two things off the public internet on every page load: Chart.js from
// cdnjs (a PARSER-BLOCKING <script> in <head>, index.html:7) and DM Sans from Google
// Fonts (@import in css/tokens.css:12). Left un-mocked, every test in this suite
// depended on Google and Cloudflare being healthy, and the pre-push gate failed at
// random when they were not — proven 2026-07-17 by delaying fonts past the 20s wait
// below, which reproduced the exact "row should render" null failure. Stub them so the
// suite is hermetic. hermetic-no-external-requests.spec.js fails if a new one appears.
//
// THIS IS THE ONE PLACE THAT STUBS THIRD-PARTY HOSTS. Call it from every spec, including
// specs that roll their own Airtable mock instead of using setupMockAirtable() — that gap
// is what let the same 17 Jul flake come back on 2026-08-04 in
// task-drawer-comments.spec.js, which stubbed only api.airtable.com and so let Google
// Fonts and the Apps Script endpoint out to the real internet on every run. Reproduced on
// demand by delaying those two hosts to 25s: waitForTask timed out at 20,011ms, matching
// the 20.4s failure seen in the gate.
async function stubExternalHosts(page) {
  // Chart.js: the app only ever does `new Chart(ctx, cfg)` and `.destroy()`, and pnl.js
  // guards on `typeof Chart === 'undefined'` — so a no-op class keeps every caller happy.
  await page.route('**cdnjs.cloudflare.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'window.Chart=class Chart{constructor(){}destroy(){}update(){}resize(){}};window.Chart.register=function(){};',
    });
  });
  // Empty CSS means no @font-face rules, so the gstatic font fetch never fires either.
  await page.route('**fonts.googleapis.com/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  });
  await page.route('**fonts.gstatic.com/**', async (route) => route.abort());
  // Apps Script (Gmail invoice count, GCal and Meetings sync in os/tasks/index.html) and
  // the Cloudflare workers (slack-notify, claude-proxy). Both are fire-and-forget on load,
  // so a slow response delays page init without ever failing loudly.
  await page.route('**/script.google.com/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok","count":0}' });
  });
  await page.route('**/*.workers.dev/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

/**
 * Set up route interception so Airtable API calls return fixture data.
 * Optionally pass custom fixtures to override defaults.
 */
async function setupMockAirtable(page, customFixtures = null) {
  const fixtures = customFixtures || makeFixtures();

  // Covers cdnjs, fonts, Apps Script and the workers — see stubExternalHosts().
  await stubExternalHosts(page);

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

module.exports = { MOCK_PAT, FIELDS, TABLE_MAP, BYNAME_FETCH_ALLOWLIST, tableIdFromUrl, assertByNameFetchesAllowed, makeFixtures, stubExternalHosts, setupMockAirtable, loadDashboard, loadDashboardWithFixtures };
