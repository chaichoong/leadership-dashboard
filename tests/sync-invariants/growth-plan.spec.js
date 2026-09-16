// Real Estate Growth Plan (growth-plan.html) — renders from mocked Airtable, prices the
// levers from the model, and writes back the four things it is allowed to write.
const { test, expect } = require('@playwright/test');
const { MOCK_PAT, stubExternalHosts, loadDashboard } = require('./helpers');

// Field IDs mirror js/config.js GP (the page reads by field ID).
const P = { strategy: 'fldivZ9UbAACwv7Yh', plannedExtra: 'fldFd4scZaJsXQ0n7', owner: 'flduloaYTsuvMxvF7', ctBand: 'fldNzUqbTNzTeNJqN', ctAnnual: 'fldZsLDNeEvghtFDJ', name: 'fldqMbR329TNY974G', type: 'fldOySSrZBYkOLLTX', beds: 'fldeXUMcC6O4AcvRG', agent: 'fldEUrWVhSp3NY8Hh', ctNote: 'fldt7zY1TPihahH6H', area: 'fldYLRz2GgVojKaq9', postcode: 'fld6ebSQgD7eRsobd', active: 'fldBUeSJQZZSnFrFW', lettableRooms: 'fldzV9YbHhNUUxwmA', payg: 'fldkBSgcELtpGZhjV', ctPayer: 'fldwWcSfkdtSbVhdj' };
const U = { tenants: 'fldQO09UAFRf07V7q', type: 'fldsItq0vU3sHv7n9', number: 'fld3nPlpdXSExxDuq', property: 'fldUJNRGgzgyAwwjt', status: 'fldBvqysXBm9rIm0E', incomeType: 'fldPrhfntWO9aHl58', rent: 'fldQZEjNzhU4UDUW9' };
const T = { over35: 'flddQ2HnQEf4HBeRn', meetingDate: 'fldTz5BU7jxA2mc1B', ucPayDay: 'fldjTG9xdCLpbwOwC', ni: 'fld1rHf1qZ60qK95l', phone: 'fldraHUkWfqo4olLF', email: 'fldybEduFY3DWWTfT', name: 'fldxBKW7QnujSDWqA', status: 'fldAXzP9SGIHiAhrv', dob: 'fldv7FKsqXYswyCFE', payType: 'fldZbrk8Xw5Dcwxhi', notes: 'fldfwxEf7I3XQDVtR', capExemption: 'fldOOi3d1P4vDedm6' };
const C = { tenants: 'fld1i5bDoHL3B6rUf', unit: 'fld7cjLLEHKAx49OK', rent: 'fldDMyfZLFMeONPq8', actual: 'fldzrqp2fHRaBBnnc' };
const K = { name: 'fldS6FYfpkhu6tJG0', expected: 'fld9JibXkMpTeMcxw', payStatus: 'fldXZNI96v8HgjuSh', property: 'fld7nikJBPz3BoZJG', frequency: 'fldvozTHvs5VH3lNi' };
const S = { key: 'fldiyJqkTQ9i2p2Wc', value: 'fldye89gwAzXWDphp', label: 'fldqN8fc8vk8qBeom', note: 'fldRtEN92vZUZKjBU' };
const PLAN = { key: 'fldhurLB2tXHqXOdg', status: 'fldDKDIgcekYZSFp7', tasks: 'fldJKJ9XiXSfLT5Vq', title: 'fldbjOfQOnUnpFmkZ' };
const TBL = { properties: 'tbl6f0OkAmTC2jbuG', units: 'tblM3mZCR5kiEdWMj', tenants: 'tblX4elTuu01gwBYh', tenancies: 'tblN51a88qTDB6iMH', costs: 'tblx5kvhzNEI5TFlS', plan: 'tblHqr2kyiL15a8LN', settings: 'tbl6hJaGOijdcvRdw', tasks: 'tblqB8b22hKBL4PF1' };

function fixtures() {
  return {
    [TBL.properties]: [
      { id: 'recProp1', fields: { [P.name]: ['18 Test Park'], [P.type]: 'HMO', [P.beds]: 3, [P.agent]: 'Property Portfolio', [P.postcode]: 'CB9 0AJ', [P.area]: 'Haverhill', [P.ctNote]: '£135.00', [P.active]: [true], [P.strategy]: 'HMO', [P.plannedExtra]: 1 } },
      { id: 'recAgent', fields: { [P.name]: ['9 Agent Road'], [P.type]: 'Single Let', [P.beds]: 2, [P.agent]: 'Roc Immo', [P.postcode]: 'CB9 0AH', [P.active]: [true], [P.ctBand]: 'B' } },
      { id: 'recProp2', fields: { [P.name]: ['13 Far Street'], [P.type]: 'Single Let', [P.beds]: 2, [P.agent]: 'Simon Collins', [P.postcode]: 'BB5 5PT', [P.active]: [true], [P.ctBand]: 'A' } },
    ],
    [TBL.units]: [
      { id: 'recU1', fields: { [U.property]: ['recProp1'], [U.number]: 1, [U.type]: 'Room', [U.status]: 'Occupied', [U.rent]: 524.90, [U.incomeType]: 'Universal Credit', [U.tenants]: ['recT1'] } },
      { id: 'recU2', fields: { [U.property]: ['recProp1'], [U.number]: 2, [U.type]: 'Flat-Let', [U.status]: 'Occupied', [U.rent]: 897.52, [U.incomeType]: 'Universal Credit', [U.tenants]: ['recT2'] } },
      { id: 'recU3', fields: { [U.property]: ['recProp1'], [U.number]: 3, [U.type]: 'Room', [U.status]: 'Occupied', [U.rent]: 524.90, [U.incomeType]: 'Universal Credit', [U.tenants]: ['recT3'] } },
      { id: 'recU4', fields: { [U.property]: ['recProp2'], [U.number]: 1, [U.type]: 'Whole Property', [U.status]: 'Occupied', [U.rent]: 257, [U.incomeType]: 'Working', [U.tenants]: ['recT4'] } },
    ],
    [TBL.tenants]: [
      { id: 'recT1', fields: { [T.name]: 'Adam Older', [T.status]: 'Active', [T.dob]: '1988-11-24', [T.payType]: 'Universal Credit', [T.capExemption]: 'Unknown' } },
      { id: 'recT2', fields: { [T.name]: 'Paul Flat', [T.status]: 'Active', [T.dob]: '1974-01-01', [T.payType]: 'Universal Credit', [T.capExemption]: 'LCWRA' } },
      { id: 'recT3', fields: { [T.name]: 'Gary Unknown', [T.status]: 'Active', [T.payType]: 'Universal Credit' } },
      { id: 'recT4', fields: { [T.name]: 'Simon Collins', [T.status]: 'Active', [T.payType]: 'Working' } },
    ],
    [TBL.tenancies]: [
      { id: 'recC1', fields: { [C.tenants]: ['recT1'], [C.unit]: ['recU1'], [C.rent]: 524.90 } },
      { id: 'recC2', fields: { [C.tenants]: ['recT2'], [C.unit]: ['recU2'], [C.rent]: 897.52, [C.actual]: 836.52 } },
      { id: 'recC3', fields: { [C.tenants]: ['recT3'], [C.unit]: ['recU3'], [C.rent]: 524.90 } },
      { id: 'recC4', fields: { [C.tenants]: ['recT4'], [C.unit]: ['recU4'], [C.rent]: 257 } },
    ],
    [TBL.costs]: [{ id: 'recK1', fields: { [K.name]: 'West Suffolk Council - 18TP CT', [K.expected]: 135, [K.payStatus]: 'In Payment', [K.property]: ['recProp1'], [K.frequency]: 'Monthly' } }],
    [TBL.plan]: [],
    [TBL.settings]: ['lha_room:524.90', 'lha_1bed:897.52', 'utilities_per_tenant:75', 'council_tax_default:145', 'room_prep_cost:1500', 'void_weeks_new_room:4', 'siddows_market_rent:850', 'collins_margin_per_property:250', 'ct_credit_share:100', 'benefit_cap_single:1229.42', 'benefit_cap_family:1835', 'uc_standard_single_25:424.90'].map((kv, i) => { const [k, v] = kv.split(':'); return { id: 'recS' + i, fields: { [S.key]: k, [S.value]: Number(v), [S.label]: k, [S.note]: 'test' } }; }),
    [TBL.tasks]: [],
  };
}

async function openPage(page, fx) {
  await page.addInitScript(pat => { localStorage.setItem('airtable_pat', pat); }, MOCK_PAT);
  await stubExternalHosts(page);
  const writes = [];
  let nextId = 900;
  await page.route('**/api.airtable.com/v0/**', async route => {
    const req = route.request(); const url = req.url(); const method = req.method();
    const tableId = (url.match(/\/v0\/[^/]+\/([^?/]+)/) || [])[1];
    if (method === 'POST' || method === 'PATCH') {
      const body = req.postDataJSON();
      writes.push({ method, tableId, records: body.records });
      const records = body.records.map(r => ({ id: r.id || ('recNew' + (nextId++)), fields: r.fields }));
      if (method === 'POST' && tableId === TBL.plan) fx[TBL.plan].push(...records);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: fx[tableId] || [] }) });
  });
  await page.goto('/growth-plan.html');
  await expect(page.locator('#dashboard')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#selfList .pack').first()).toBeVisible();
  return writes;
}

test.describe('Growth Plan page', () => {
  const selfPack = (page, name) => page.locator('#selfList .pack', { hasText: name });
  const openSelf = async (page, name) => { await selfPack(page, name).locator('.pack-head').first().click(); return page.locator('#selfList .pack.open'); };

  test('leads with six plain metrics and splits our properties from the agent-run ones', async ({ page }) => {
    await openPage(page, fixtures());
    await expect(page.locator('#kpis .kpi')).toHaveCount(6);
    await expect(page.locator('.kpi[data-kpi="rentNow"]')).toContainText('£2,204');   // 524.90+897.52+524.90+257
    await expect(page.locator('.kpi[data-kpi="realised"]')).toContainText('expected');
    // Simon Collins is OURS now; only a letting agent goes in the agent list.
    await expect(page.locator('#selfCount')).toHaveText('2 properties');
    await expect(page.locator('#agentCount')).toHaveText('1 properties');
    await expect(page.locator('#selfList')).toContainText('18 Test Park');
    await expect(page.locator('#selfList')).toContainText('13 Far Street');
    await expect(page.locator('#agentList')).toContainText('9 Agent Road');
    await expect(page.locator('#selfList')).not.toContainText('9 Agent Road');
    // Counts, in words a 13-year-old reads.
    await expect(page.locator('#countStrip')).toContainText('places let today');
    await expect(page.locator('#countStrip')).toContainText('tenants living there now');
  });

  test('every property is priced four ways, with council tax on its own line', async ({ page }) => {
    await openPage(page, fixtures());
    const open = await openSelf(page, '18 Test Park');
    const rows = open.locator('.strattbl tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('Single let');
    await expect(rows.nth(1)).toContainText('Joint tenancy');
    await expect(rows.nth(2)).toContainText('HMO');
    await expect(rows.nth(3)).toContainText('Serviced accommodation');
    // The tenants carry the council tax on the first two; we carry it on the last two.
    await expect(rows.nth(0)).toContainText('The tenant pays the council tax, not us');
    await expect(rows.nth(1)).toContainText('moves the council tax to the tenants');
    await expect(rows.nth(2)).toContainText('We pay the council tax: £135.00 a month');
    await expect(rows.nth(3)).toContainText('We pay the council tax: £135.00 a month');
    // Joint tenancy = the 1-bed rate twice, two places to let.
    await expect(rows.nth(1)).toContainText('£1,795.04');
    await expect(rows.nth(3)).toContainText('£500.00');   // the short-let budget
    await expect(rows.nth(3)).toContainText('£365.00');   // net of council tax
  });

  test('picking a plan writes it, re-prices the property and shows the paperwork', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    const open = await openSelf(page, '18 Test Park');
    await expect(open).toContainText('What we have to do for HMO');
    await expect(open).toContainText('Individual tenancy agreement at the 1-bed rate');
    await expect(open).toContainText('Letter of authority');
    await expect(open).toContainText('Proof of address');
    await open.locator('select[data-prop-field="strategy"]').selectOption('Joint tenancy');
    await expect(page.locator('#toast')).toContainText('Saved');
    expect(writes.filter(x => x.tableId === TBL.properties).pop().records[0].fields[P.strategy]).toBe('Joint tenancy');
    const reopened = page.locator('#selfList .pack.open');
    await expect(reopened).toContainText('What we have to do for Joint tenancy');
    await expect(reopened).toContainText('Joint tenancy agreement, one agreement with both names on it');
    await expect(reopened).not.toContainText('Individual tenancy agreement');
  });

  test('a single let needs no paperwork, and the page says so rather than showing an empty list', async ({ page }) => {
    const fx = fixtures();
    fx[TBL.properties][2].fields[P.strategy] = 'Leave as is';   // 13 Far Street is a single let today
    await openPage(page, fx);
    const open = await openSelf(page, '13 Far Street');
    await expect(open).toContainText('What we have to do for Single let');
    await expect(open).toContainText('Usually nothing to do');
  });

  test('places to let count the plan, and the extra ones say they are not in the database yet', async ({ page }) => {
    await openPage(page, fixtures());
    const open = await openSelf(page, '18 Test Park');
    await expect(open).toContainText('3 let today');
    await expect(open).toContainText('Places to let, and who is in them');
    await expect(open).toContainText('Adam Older');
    await expect(open).toContainText('Paul Flat');
    await open.locator('select[data-prop-field="strategy"]').selectOption('HMO');
    const reopened = page.locator('#selfList .pack.open');
    await expect(reopened).toContainText('not in the database yet: we add');
  });

  test('a property with no plan picked is flagged Not decided and sorts to the top', async ({ page }) => {
    const fx = fixtures();
    delete fx[TBL.properties][0].fields[P.strategy];
    await openPage(page, fx);
    await expect(page.locator('#selfList .pack').first()).toContainText('Not decided');
    await expect(page.locator('#countStrip')).toContainText('still need a plan picked');
    const open = await openSelf(page, '18 Test Park');
    await expect(open).toContainText('Pick a plan above and the paperwork list appears here');
  });

  test('the status filter narrows our list', async ({ page }) => {
    await openPage(page, fixtures());
    await expect(page.locator('#statusSeg button', { hasText: 'All' })).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#statusSeg button', { hasText: 'Not decided' }).click();
    await expect(page.locator('#selfList')).toContainText('13 Far Street');
    await expect(page.locator('#selfList')).not.toContainText('18 Test Park');
  });

  test('marking a move done saves the starting rent, so what landed is measured not assumed', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    const open = await openSelf(page, '18 Test Park');
    const row = open.locator('tr', { hasText: 'room rate to 1-bed rate' });
    await row.locator('button[data-act="adopt"]').click();
    await expect(page.locator('#toast')).toContainText('Adopted');
    await page.locator('#selfList .pack.open tr', { hasText: 'room rate to 1-bed rate' }).locator('button[data-act="done"]').click();
    await expect(page.locator('#toast')).toContainText('Done');
    const snap = writes.filter(x => x.tableId === TBL.properties).pop();
    expect(snap.method).toBe('PATCH');
    expect(snap.records[0].id).toBe('recProp1');
    expect(snap.records[0].fields['fldfTtL7On1C2OmRU']).toBe(1947.32);   // the rent the day it was finished
    expect(snap.records[0].fields['fldp0bTV5uUIQkHh6']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('the starting rent is saved once and never overwritten by a later move', async ({ page }) => {
    const fx = fixtures();
    fx[TBL.properties][0].fields['fldfTtL7On1C2OmRU'] = 1500;
    fx[TBL.properties][0].fields['fldp0bTV5uUIQkHh6'] = '2026-08-01';
    const writes = await openPage(page, fx);
    const open = await openSelf(page, '18 Test Park');
    await open.locator('tr', { hasText: 'room rate to 1-bed rate' }).locator('button[data-act="adopt"]').click();
    await page.locator('#selfList .pack.open tr', { hasText: 'room rate to 1-bed rate' }).locator('button[data-act="done"]').click();
    await expect(page.locator('#toast')).toContainText('Done');
    expect(writes.filter(x => x.tableId === TBL.properties)).toEqual([]);   // nothing rewritten
    // and the landed card measures against it: 1947.32 now, 1500 then
    await page.locator('.kpi[data-kpi="realised"]').click();
    await expect(page.locator('#kpiDetail')).toContainText('£447.32');
  });

  test('a date of birth is fixed where the tenant is, and brings them into the plan', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    const open = await openSelf(page, '18 Test Park');
    await expect(open).toContainText('Gary Unknown');
    await open.locator('input[data-dob="recT3"]').fill('1980-06-01');
    await open.locator('button[data-act="save-dob"][data-tenant="recT3"]').click();
    await expect(page.locator('#toast')).toContainText('Date of birth saved');
    const w = writes.find(x => x.tableId === TBL.tenants);
    expect(w.records[0].fields[T.dob]).toBe('1980-06-01');
    expect(w.records[0].fields[T.notes]).toMatch(/Growth Plan page/);
    await expect(page.locator('#selfList .pack.open')).toContainText('Gary Unknown: room rate to 1-bed rate (age 46)');
    await expect(page.locator('#selfList .pack.open input[data-dob="recT3"]')).toHaveCount(0);
  });

  test('refuses an implausible date of birth without writing', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    const open = await openSelf(page, '18 Test Park');
    await open.locator('input[data-dob="recT3"]').fill('2019-06-01');
    await open.locator('button[data-act="save-dob"][data-tenant="recT3"]').click();
    await expect(page.locator('#toast')).toContainText('does not look like');
    expect(writes.filter(x => x.tableId === TBL.tenants)).toEqual([]);
  });

  test('confirming 35+ brings the tenant into the plan', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    const open = await openSelf(page, '18 Test Park');
    await open.locator('button[data-act="confirm-35"][data-tenant="recT3"]').click();
    await expect(page.locator('#toast')).toContainText('recorded as 35 or over');
    expect(writes.find(x => x.tableId === TBL.tenants).records[0].fields[T.over35]).toBe(true);
    await expect(page.locator('#selfList .pack.open')).toContainText('Gary Unknown: room rate to 1-bed rate (35+ confirmed)');
  });

  test('adopting a move creates a Growth Plan row and a task links to it', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    const open = await openSelf(page, '18 Test Park');
    await open.locator('tr', { hasText: 'room rate to 1-bed rate' }).locator('button[data-act="adopt"]').click();
    await expect(page.locator('#toast')).toContainText('Adopted');
    const planWrite = writes.find(x => x.tableId === TBL.plan);
    expect(planWrite.records[0].fields[PLAN.key]).toBe('uplift:recT1');
    expect(planWrite.records[0].fields[PLAN.status]).toBe('Adopted');
    await page.locator('#selfList .pack.open tr', { hasText: 'room rate to 1-bed rate' }).locator('button[data-act="task"]').click();
    await expect(page.locator('#toast')).toContainText('Task created for Kevin Brittain');
    const tf = writes.find(x => x.tableId === TBL.tasks).records[0].fields;
    expect(tf['fldgFjGBw6bTKJFCD']).toMatch(/^Growth plan: Adam Older/);
    expect(tf['fldLu1Y4GzyWcDoxr']).toEqual(['recoGcXRXCniyJsTz']);
    await expect(page.locator('#selfList .pack.open tr', { hasText: 'room rate to 1-bed rate' })).toContainText('In progress');
  });

  test('a works move goes to Roy unless the house says otherwise', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    const open = await openSelf(page, '18 Test Park');
    await open.locator('tr', { hasText: 'more room' }).locator('button[data-act="task"]').click();
    await expect(page.locator('#toast')).toContainText('Task created for Roy Lavin');
    expect(writes.find(x => x.tableId === TBL.tasks).records[0].fields['flduCtmQGpOA4eWaj']).toEqual(['reclbdjfVev3bqNHS']);
    await page.locator('#selfList .pack.open select[data-prop-field="owner"]').selectOption('Kevin');
    await expect(page.locator('#toast')).toContainText('Saved');
    expect(writes.filter(x => x.tableId === TBL.properties).pop().records[0].fields[P.owner]).toBe('Kevin');
  });

  test('setting a council tax band re-prices the HMO and short-let figures', async ({ page }) => {
    const fx = fixtures();
    delete fx[TBL.properties][2].fields[P.ctBand];          // 13 Far Street, BB5 = Hyndburn, no band
    const writes = await openPage(page, fx);
    let open = await openSelf(page, '13 Far Street');
    await expect(open).toContainText('not known yet');
    await open.locator('select[data-prop-field="ctBand"]').selectOption('A');
    await expect(page.locator('#toast')).toContainText('Saved');
    expect(writes.filter(x => x.tableId === TBL.properties).pop().records[0].fields[P.ctBand]).toBe('A');
    open = page.locator('#selfList .pack.open');
    await expect(open).toContainText('£137.00');            // Hyndburn band A ÷ 12
    await expect(open).not.toContainText('not known yet');
  });

  test('every reference section is behind a toggle and closed on arrival', async ({ page }) => {
    await openPage(page, fixtures());
    const more = page.locator('#gp-more details.more');
    await expect(more).toHaveCount(8);
    for (let i = 0; i < 8; i++) await expect(more.nth(i)).not.toHaveAttribute('open', '');
    await expect(page.locator('#glossaryBody')).not.toBeVisible();
    await expect(page.locator('#calcOut')).not.toBeVisible();
    await more.filter({ hasText: 'plain English' }).locator('summary').click();
    await expect(page.locator('#glossaryBody')).toBeVisible();
    await expect(page.locator('#glossaryBody')).toContainText('Short for House in Multiple Occupation');
    await expect(page.locator('#glossaryBody')).toContainText('Money the rent records actually show');
  });

  test('the benefit cap calculator still works inside Further information', async ({ page }) => {
    await openPage(page, fixtures());
    await page.locator('#gp-more details.more').filter({ hasText: 'Benefit cap calculator' }).locator('summary').click();
    await expect(page.locator('#calcOut')).toContainText('Capped: £95.48 short');
    await page.locator('#c-pip').check();
    await expect(page.locator('#calcOut')).toContainText('Not capped');
  });

  test('every property stays editable in the set-up table, agent-run ones included', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    const panel = page.locator('#gp-more details.more').filter({ hasText: 'Set up every property' });
    await panel.locator('summary').click();
    await expect(page.locator('#setupBody')).toContainText('18 Test Park');
    await expect(page.locator('#setupBody')).toContainText('13 Far Street');
    await expect(page.locator('#setupBody')).toContainText('9 Agent Road');
    const pick = async (value) => page.locator('#setupBody select[data-prop-field="strategy"]').first()
      .evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, value);
    await pick('Leave as is');
    await expect(page.locator('#toast')).toContainText('Saved');
    expect(writes.filter(x => x.tableId === TBL.properties).pop().records[0].fields[P.strategy]).toBe('Leave as is');
    await expect(panel).toHaveAttribute('open', '');    // the panel survives the re-render
  });

  test('a done move stays hidden until asked for', async ({ page }) => {
    const fx = fixtures();
    fx[TBL.plan].push({ id: 'recPlanDone', fields: { [PLAN.key]: 'uplift:recT1', [PLAN.status]: 'Done', [PLAN.title]: 'old' } });
    await openPage(page, fx);
    const open = await openSelf(page, '18 Test Park');
    await expect(open.locator('tr', { hasText: 'Adam Older' })).toHaveCount(0);
    await open.locator('#showDone').check();
    await expect(page.locator('#selfList .pack.open tr', { hasText: 'Adam Older' })).toContainText('Done');
  });

  test('metric cards expand to show the properties behind them', async ({ page }) => {
    await openPage(page, fixtures());
    await expect(page.locator('#kpiDetail')).toBeHidden();
    await page.locator('.kpi[data-kpi="rentNow"]').click();
    await expect(page.locator('#kpiDetail')).toBeVisible();
    await expect(page.locator('#kpiDetail')).toContainText('18 Test Park');
    await expect(page.locator('#kpiDetail')).toContainText('13 Far Street');
    await page.locator('.kpi[data-kpi="rentNow"]').click();
    await expect(page.locator('#kpiDetail')).toBeHidden();
  });

  test('the meeting form opens on the tenant you clicked and saves every field', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    const open = await openSelf(page, '18 Test Park');
    await expect(open).toContainText('Still to collect');
    await open.locator('button[data-act="open-form"]').first().click();
    await expect(page.locator('#meetingForm')).toBeVisible();
    await expect(page.locator('#formTenant')).toHaveValue('recT1');
    await page.locator('#meetingForm input[name="ni"]').fill('QQ 12 34 56 C');
    await page.locator('#meetingForm select[name="capExemption"]').selectOption('PIP or DLA');
    await page.locator('#meetingForm input[name="meetingDate"]').fill('2026-09-16');
    await page.locator('#meetingSave').click();
    await expect(page.locator('#toast')).toContainText('Meeting saved');
    const w = writes.filter(x => x.tableId === TBL.tenants).pop();
    expect(w.records[0].id).toBe('recT1');
    expect(w.records[0].fields[T.ni]).toBe('QQ123456C');
    expect(w.records[0].fields[T.capExemption]).toBe('PIP or DLA');
  });

  test('shows the empty state and no crash when nothing loads', async ({ page }) => {
    const fx = fixtures(); Object.keys(fx).forEach(k => { fx[k] = []; });
    await page.addInitScript(pat => { localStorage.setItem('airtable_pat', pat); }, MOCK_PAT);
    await stubExternalHosts(page);
    await page.route('**/api.airtable.com/v0/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: [] }) }));
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/growth-plan.html');
    await expect(page.locator('#dashboard')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#selfList')).toContainText('No property is at that stage');
    await expect(page.locator('#agentList')).toContainText('No agent-run properties');
    expect(errors).toEqual([]);
  });

  test('a refused token clears both stores and shows the sign-in box', async ({ page }) => {
    await page.addInitScript(pat => { localStorage.setItem('airtable_pat', pat); }, MOCK_PAT);
    await stubExternalHosts(page);
    await page.route('**/api.airtable.com/v0/**', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"AUTHENTICATION_REQUIRED"}' }));
    await page.goto('/growth-plan.html');
    await expect(page.locator('#authScreen')).toBeVisible();
    await expect(page.locator('#authError')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('airtable_pat'))).toBeNull();
  });
});

test('the shell lists Growth Plan under Leadership and lazy-loads the page into its tab', async ({ page }) => {
  await loadDashboard(page);
  const item = page.locator('.sidebar-item', { hasText: 'Growth Plan' });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator('#tab-growth-plan')).toHaveClass(/active/);
  await expect(page.locator('#growthPlanFrame')).toHaveAttribute('src', /growth-plan\.html/);
});
