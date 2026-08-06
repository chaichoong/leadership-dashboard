// Invariant: the reconciliation knowledge base must survive the browser, load completely,
// and resolve the most specific rule.
//
// Before 6 Aug 2026 the rules lived only in localStorage — one browser, one device, and one
// cache clear from losing all 238 of them. That is the same failure that wiped the accuracy
// log in Apr 2026 and forced it into Airtable; the rules were simply never moved.
//
// Two matching bugs shipped with it:
//   - the key kept per-transaction references, so each payment minted a single-use rule
//     (covered by tests/recon-vendor-key.test.js)
//   - findReconRule returned the FIRST rule whose key appeared in the descriptor, so with
//     15 overlapping keys ("aldi" inside a longer key, "tesco", "coop") the winner depended
//     on insertion order and a generic rule could hijack a specific one

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, loadDashboard } = require('./helpers');

const RULES_TABLE = 'tblQ9sFD7Fs5CaVwG';
const R = {
  key: 'fldihhYBKnmL2y8qx', catId: 'fldHqfpAZwKT0bq7z', catName: 'fldQ4hSMAKSxvR7ft',
  subId: 'fldqquIn11Z0sVSxT', subName: 'fldUV6zdgwTiYuCfS', conf: 'fldgVeiG1OOkaTepr',
};

function rule(id, key, subName, conf = 1) {
  return { id, fields: { [R.key]: key, [R.subId]: 'recSub_' + key.replace(/\s/g, '_'), [R.subName]: subName, [R.conf]: conf } };
}

// Register AFTER loadDashboard — it calls setupMockAirtable() internally, and Playwright
// matches the most recently registered handler first.
async function routeRules(page, pages, sink) {
  await page.route('**/api.airtable.com/v0/**', async (route) => {
    const req = route.request();
    const url = req.url();
    if (!url.includes(RULES_TABLE)) { await route.fallback(); return; }
    if (req.method() !== 'GET') {
      if (sink) sink.push({ method: req.method(), url: url.split('/v0/')[1], body: req.postDataJSON() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'recNew1', fields: {} }) });
      return;
    }
    const m = url.match(/offset=([^&]+)/);
    const key = m ? decodeURIComponent(m[1]) : 'page0';
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pages[key] || { records: [] }) });
  });
}

test.describe('Reconciliation knowledge base', () => {

  test('loads every page of rules from Airtable, not just the first 100', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    const p0 = Array.from({ length: 100 }, (_, i) => rule('recA' + i, 'vendor a' + i, 'Cat A'));
    const p1 = Array.from({ length: 40 }, (_, i) => rule('recB' + i, 'vendor b' + i, 'Cat B'));
    await routeRules(page, { page0: { records: p0, offset: 'page1' }, page1: { records: p1 } });

    const loaded = await page.evaluate(async () => (await loadReconRules()).length);
    // A partial read would make the matcher silently forget rules AND make saveReconRule
    // create duplicates for rules it could not see.
    expect(loaded).toBe(140);
  });

  test('returns the most specific rule, not whichever was stored first', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    // "tesco" is stored FIRST and is a substring of "tesco stores metro". Under the old
    // first-match-wins behaviour the generic rule won purely because of ordering.
    await routeRules(page, { page0: { records: [
      rule('recGeneric', 'tesco', 'Groceries General'),
      rule('recSpecific', 'tesco stores metro', 'Groceries Metro'),
    ] } });

    const hit = await page.evaluate(async () => {
      await loadReconRules();
      return findReconRule('TESCO STORES METRO 1234');
    });
    expect(hit.vendorKey).toBe('tesco stores metro');
    expect(hit.subCatName).toBe('Groceries Metro');
  });

  test('still matches the generic rule when no specific rule exists', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await routeRules(page, { page0: { records: [rule('recGeneric', 'tesco', 'Groceries General')] } });

    const hit = await page.evaluate(async () => {
      await loadReconRules();
      return findReconRule('TESCO PETROL 99');
    });
    expect(hit.vendorKey).toBe('tesco');
  });

  test('reinforcing a known rule PATCHes it instead of creating a duplicate', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    const writes = [];
    await routeRules(page, { page0: { records: [rule('recTesco', 'tesco', 'Groceries', 3)] } }, writes);

    const conf = await page.evaluate(async () => {
      await loadReconRules();
      saveReconRule('tesco', { subCatId: 'recSubX', subCatName: 'Groceries' }, 'TESCO STORES');
      await new Promise(r => setTimeout(r, 400));
      return getReconRules().find(r => r.vendorKey === 'tesco').confidence;
    });

    // Confidence compounds, and the write updates the existing row.
    expect(conf).toBe(4);
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('PATCH');
    expect(writes[0].url).toContain('recTesco');
  });

  test('migration lifts local rules to Airtable and merges the duplicates', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    const writes = [];
    await routeRules(page, { page0: { records: [] } }, writes);

    const result = await page.evaluate(async () => {
      // The five real "british" rules: one recurring £2 charge stored five times because the
      // old key baked the payment reference into the rule's identity.
      const legacy = [
        { vendorKey: 'british a1252236611488', subCatId: 'recT', subCatName: 'Personal Transport', confidence: 1 },
        { vendorKey: 'british a1252236611489', subCatId: 'recT', subCatName: 'Personal Transport', confidence: 1 },
        { vendorKey: 'british a1252236611490', subCatId: 'recT', subCatName: 'Personal Transport', confidence: 3 },
        { vendorKey: 'british a1252236611491', subCatId: 'recT', subCatName: 'Personal Transport', confidence: 1 },
        { vendorKey: 'one stop 1036', subCatId: 'recG', subCatName: 'Groceries', confidence: 2 },
      ];
      localStorage.setItem('recon_rules', JSON.stringify(legacy));
      localStorage.removeItem('_recon_rules_migrated');
      _reconRules = null;
      await migrateReconRulesToAirtable();
      return { migratedFlag: localStorage.getItem('_recon_rules_migrated') };
    });

    const created = writes.filter(w => w.method === 'POST').flatMap(w => (w.body.records || []));
    const keys = created.map(r => r.fields[R.key]).sort();
    // Five rules collapse to two, and the merged rule keeps the HIGHEST confidence (3),
    // so re-keying never throws away what the knowledge base had already learned.
    expect(keys).toEqual(['british', 'one stop']);
    const brit = created.find(r => r.fields[R.key] === 'british');
    expect(brit.fields[R.conf]).toBe(3);
    expect(result.migratedFlag).toBe('1');
  });

  test('migration runs once, not on every dashboard load', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    const writes = [];
    await routeRules(page, { page0: { records: [] } }, writes);

    await page.evaluate(async () => {
      localStorage.setItem('recon_rules', JSON.stringify([{ vendorKey: 'aldi', subCatId: 'recG', confidence: 1 }]));
      localStorage.removeItem('_recon_rules_migrated');
      _reconRules = null;
      await migrateReconRulesToAirtable();
      await migrateReconRulesToAirtable();   // a second dashboard load
      await migrateReconRulesToAirtable();
    });

    // Re-running must not duplicate the knowledge base every time Kevin opens the dashboard.
    const creates = writes.filter(w => w.method === 'POST');
    expect(creates).toHaveLength(1);
  });

  test('a failed load keeps the cached rules rather than blanking the knowledge base', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await page.route('**/api.airtable.com/v0/**', async (route) => {
      if (!route.request().url().includes(RULES_TABLE)) { await route.fallback(); return; }
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
    });

    // Boot already ran a (successful, empty) load, so re-seed the mirror and clear the
    // in-memory copy to isolate the failure path: Airtable is down, the mirror has rules.
    const rules = await page.evaluate(async () => {
      localStorage.setItem('recon_rules', JSON.stringify([{ vendorKey: 'aldi', subCatName: 'Groceries', confidence: 5 }]));
      _reconRules = null;
      return await loadReconRules();
    });
    // An outage must not look like "Kevin has taught it nothing".
    expect(rules.length).toBe(1);
    expect(rules[0].vendorKey).toBe('aldi');
  });
});
