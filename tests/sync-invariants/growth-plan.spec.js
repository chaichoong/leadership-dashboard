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
      { id: 'recProp2', fields: { [P.name]: ['13 Far Street'], [P.type]: 'Single Let', [P.beds]: 2, [P.agent]: 'Simon Collins', [P.postcode]: 'BB5 5PT', [P.active]: [true] } },
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
  await expect(page.locator('#packs .pack').first()).toBeVisible();
  return writes;
}

test.describe('Growth Plan page', () => {
  test('prices the levers from the mocked portfolio and names the next action', async ({ page }) => {
    await openPage(page, fixtures());
    const kpis = page.locator('#kpis .kpi');
    await expect(kpis.nth(0)).toContainText('£2,204');            // 524.90 + 897.52 + 524.90 + 257
    await expect(page.locator('#kpis .kpi')).toHaveCount(8);
    await expect(page.locator('#gp-workflow')).toContainText('Joint tenancy');
    await expect(page.locator('#gp-workflow')).toContainText('Leave as is');
    // One pack per property, in order, carrying the whole property's value.
    const packs = page.locator('#packs .pack');
    await expect(packs.first()).toContainText('18 Test Park');
    await expect(packs.nth(1)).toContainText('13 Far Street');
    await packs.first().locator('.pack-head').click();
    const open = page.locator('#packs .pack.open');
    await expect(open).toContainText('Before you go');
    await expect(open).toContainText('At the property');
    await expect(open).toContainText('Adam Older');
    await expect(open).toContainText('Rent change letter');
    await expect(open).toContainText('CRF Housing Payment, £93.00 a month to landlord');
    await expect(open).toContainText('Fire-safe each new room');
    await expect(open).toContainText('Afterwards');
  });

  test('lists the unknown age and writes a date of birth back to the tenant', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    await page.locator('#packs .pack').first().locator('.pack-head').click();
    await expect(page.locator('#packs .pack.open')).toContainText('Paul Flat: £836.52 received against £897.52 due');
    await page.locator('#packs .pack.open input[data-dob="recT3"]').fill('1980-06-01');
    await page.locator('#packs .pack.open button[data-act="save-dob"][data-tenant="recT3"]').click();
    await expect(page.locator('#toast')).toContainText('Date of birth saved');
    const w = writes.find(x => x.tableId === TBL.tenants);
    expect(w.method).toBe('PATCH');
    expect(w.records[0].id).toBe('recT3');
    expect(w.records[0].fields[T.dob]).toBe('1980-06-01');
    expect(w.records[0].fields[T.notes]).toMatch(/Growth Plan page/);
    // The plan re-prices in the pack that is already open: Gary (46) is now an uplift.
    await expect(page.locator('#packs .pack.open')).toContainText('Gary Unknown: room rate to 1-bed rate (age 46)');
    await expect(page.locator('#packs .pack.open input[data-dob="recT3"]')).toHaveCount(0);   // no longer an unknown age
  });

  test('refuses an implausible date of birth without writing', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    await page.locator('#packs .pack').first().locator('.pack-head').click();
    await page.locator('#packs .pack.open input[data-dob="recT3"]').fill('2019-06-01');
    await page.locator('#packs .pack.open button[data-act="save-dob"][data-tenant="recT3"]').click();
    await expect(page.locator('#toast')).toContainText('does not look like');
    expect(writes.filter(x => x.tableId === TBL.tenants)).toEqual([]);
  });

  test('recording an exemption removes the CRF shortfall from the uplift row', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    await page.locator('#packs .pack').first().locator('.pack-head').click();
    await expect(page.locator('#packs .pack.open')).toContainText('£93.00');
    await page.locator('#formTenant').selectOption('recT1');
    await page.locator('#meetingForm select[name="capExemption"]').selectOption('PIP or DLA');
    await page.locator('#meetingSave').click();
    await expect(page.locator('#toast')).toContainText('Meeting saved');
    expect(writes.filter(x => x.tableId === TBL.tenants).pop().records[0].fields[T.capExemption]).toBe('PIP or DLA');
    // the pack stayed open through the re-render
    await expect(page.locator('#packs .pack.open')).toContainText('Adam Older');
    await expect(page.locator('#packs .pack.open')).not.toContainText('CRF Housing Payment, £93.00');
  });

  test('adopting a lever creates a Growth Plan row and a task links to it', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    await page.locator('#packs .pack').first().locator('.pack-head').click();
    const first = page.locator('#packs .pack.open tr', { hasText: 'room rate to 1-bed rate' });
    await first.locator('button[data-act="adopt"]').click();
    await expect(page.locator('#toast')).toContainText('Adopted');
    const planWrite = writes.find(x => x.tableId === TBL.plan);
    expect(planWrite.method).toBe('POST');
    expect(planWrite.records[0].fields[PLAN.key]).toBe('uplift:recT1');
    expect(planWrite.records[0].fields[PLAN.status]).toBe('Adopted');
    await expect(page.locator('#packs .pack.open tr', { hasText: 'room rate to 1-bed rate' })).toContainText('Adopted');

    await page.locator('#packs .pack.open tr', { hasText: 'room rate to 1-bed rate' }).locator('button[data-act="task"]').click();
    await expect(page.locator('#toast')).toContainText('Task created for Kevin Brittain');
    const taskWrite = writes.find(x => x.tableId === TBL.tasks);
    expect(taskWrite.method).toBe('POST');
    const tf = taskWrite.records[0].fields;
    expect(tf['fldgFjGBw6bTKJFCD']).toMatch(/^Growth plan: Adam Older/);
    expect(tf['fldx4qCw17UfrKpaN']).toBe('Upcoming');
    expect(tf['fldLu1Y4GzyWcDoxr']).toEqual(['recoGcXRXCniyJsTz']);
    const linkWrite = writes.filter(x => x.tableId === TBL.plan).pop();
    expect(linkWrite.method).toBe('PATCH');
    expect(linkWrite.records[0].fields[PLAN.tasks]).toEqual(['recNew901']); // 900 was the plan row created by Adopt
    await expect(page.locator('#packs .pack.open tr', { hasText: 'room rate to 1-bed rate' })).toContainText('In progress');
  });

  test('a works lever sends its task to Roy, unless the house says tasks go to Kevin', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    await page.locator('#packs .pack').first().locator('.pack-head').click();
    await page.locator('#packs .pack.open tr', { hasText: 'more room' }).locator('button[data-act="task"]').click();
    await expect(page.locator('#toast')).toContainText('Task created for Roy Lavin');
    const tf = writes.find(x => x.tableId === TBL.tasks).records[0].fields;
    expect(tf['flduCtmQGpOA4eWaj']).toEqual(['reclbdjfVev3bqNHS']);
    await page.locator('#packs .pack.open select[data-prop-field="owner"]').selectOption('Kevin');
    await expect(page.locator('#toast')).toContainText('Saved');
    expect(writes.filter(x => x.tableId === TBL.properties).pop().records[0].fields[P.owner]).toBe('Kevin');
    await expect(page.locator('#packs .pack').first()).toContainText('Kevin');
  });

  test('property card fields write to Properties and re-price the plan', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    await page.locator('#packs .pack').first().locator('.pack-head').click();
    await expect(page.locator('#packs .pack.open tr', { hasText: 'more room' })).toContainText('+£897.52'); // bills with the tenant
    await page.locator('#packs .pack.open select[data-prop-field="payg"]').selectOption('No');
    await expect(page.locator('#toast')).toContainText('Saved');
    expect(writes.find(x => x.tableId === TBL.properties).records[0].fields[P.payg]).toBe('No');
    await expect(page.locator('#packs .pack.open tr', { hasText: 'more room' })).toContainText('+£822.52'); // Kevin took the bills on: £75 off
    await page.locator('#packs .pack.open input[data-prop-field="plannedExtra"]').fill('3');
    await page.locator('#packs .pack.open input[data-prop-field="plannedExtra"]').dispatchEvent('change');
    expect(writes.filter(x => x.tableId === TBL.properties).pop().records[0].fields[P.plannedExtra]).toBe(3);
    await expect(page.locator('#packs .pack.open')).toContainText('3 more rooms let');
    await page.locator('#packs .pack.open select[data-prop-field="strategy"]').selectOption('Leave as is');
    await expect(page.locator('#packs .pack.open')).not.toContainText('more rooms let');   // Leave as is: no house lever
  });

  test('benefit cap calculator: £900 rent caps a single over-35 unless exempt, and names the CRF amount', async ({ page }) => {
    await openPage(page, fixtures());
    await expect(page.locator('#calcOut')).toContainText('Capped: £95.48 short');
    await expect(page.locator('#calcOut')).toContainText('CRF Housing Payment to apply for');
    await page.locator('#c-pip').check();
    await expect(page.locator('#calcOut')).toContainText('Not capped');
    await page.locator('#c-pip').uncheck();
    await page.locator('#c-earnings').fill('881');
    await expect(page.locator('#calcOut')).toContainText('Not capped');
  });

  test('a stored Done row drops out of the totals and stays hidden until asked for', async ({ page }) => {
    const fx = fixtures();
    fx[TBL.plan].push({ id: 'recPlanDone', fields: { [PLAN.key]: 'uplift:recT1', [PLAN.status]: 'Done', [PLAN.title]: 'old' } });
    await openPage(page, fx);
    await expect(page.locator('#packs')).not.toContainText('Adam Older');
    await page.locator('#showDone').check();
    await page.locator('#packs .pack').first().locator('.pack-head').click();
    await expect(page.locator('#packs .pack.open tr', { hasText: 'Adam Older' })).toContainText('Done');
  });

  test('metric cards expand to show the rows behind them', async ({ page }) => {
    await openPage(page, fixtures());
    await expect(page.locator('#kpiDetail')).toBeHidden();
    await page.locator('.kpi[data-kpi="paper"]').click();
    await expect(page.locator('#kpiDetail')).toBeVisible();
    await expect(page.locator('#kpiDetail')).toContainText('Adam Older');
    await expect(page.locator('#kpiDetail')).toContainText('£433.62');   // 372.62 uplift + 61 top-up
    await page.locator('.kpi[data-kpi="rentNow"]').click();
    await expect(page.locator('#kpiDetail')).toContainText('18 Test Park');
    await page.locator('.kpi[data-kpi="rentNow"]').click();
    await expect(page.locator('#kpiDetail')).toBeHidden();
  });

  test('confirming 35+ from the facts list brings the tenant into the plan', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    await page.locator('#packs .pack').first().locator('.pack-head').click();
    await page.locator('#packs .pack.open button[data-act="confirm-35"][data-tenant="recT3"]').click();
    await expect(page.locator('#toast')).toContainText('recorded as 35 or over');
    expect(writes.find(x => x.tableId === TBL.tenants).records[0].fields[T.over35]).toBe(true);
    // the pack stays open through the re-render and Gary is now a lever, not a block
    await expect(page.locator('#packs .pack.open')).toContainText('Gary Unknown: room rate to 1-bed rate (35+ confirmed)');
  });

  test('the tenant meeting form loads a tenant and saves every field to the record', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    await page.locator('#formTenant').selectOption('recT1');
    await expect(page.locator('#meetingForm')).toBeVisible();
    await expect(page.locator('#meetingForm input[name="dob"]')).toHaveValue('1988-11-24');
    await page.locator('#meetingForm input[name="ni"]').fill('QQ 12 34 56 C');
    await page.locator('#meetingForm input[name="ucPayDay"]').fill('14');
    await page.locator('#meetingForm select[name="capExemption"]').selectOption('PIP or DLA');
    await page.locator('#meetingForm input[name="authoritySigned"]').check();
    await page.locator('#meetingForm input[name="meetingDate"]').fill('2026-09-16');
    await page.locator('#meetingSave').click();
    await expect(page.locator('#toast')).toContainText('Meeting saved');
    const w = writes.filter(x => x.tableId === TBL.tenants).pop();
    expect(w.records[0].id).toBe('recT1');
    expect(w.records[0].fields[T.ni]).toBe('QQ123456C');
    expect(w.records[0].fields[T.ucPayDay]).toBe(14);
    expect(w.records[0].fields[T.capExemption]).toBe('PIP or DLA');
    expect(w.records[0].fields[T.meetingDate]).toBe('2026-09-16');
    await page.locator('#packs .pack').first().locator('.pack-head').click();
    await expect(page.locator('#packs .pack.open')).not.toContainText('CRF Housing Payment, £93.00'); // exemption recorded
  });

  test('every property stays editable in the setup table, even with no work today', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    await page.locator('#setupAll summary').click();
    await expect(page.locator('#setupAll')).toHaveAttribute('open', '');
    await expect(page.locator('#setupBody')).toContainText('18 Test Park');
    await expect(page.locator('#setupBody')).toContainText('13 Far Street');   // agent-run, no pack of its own
    // Set the only working house to Leave as is: its pack goes, the setup row does not.
    // The table re-renders under the control, so drive the change event rather than
    // Playwright's actionability loop, which re-verifies against the detached node.
    const pick = async (value) => page.locator('#setupBody select[data-prop-field="strategy"]').first()
      .evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, value);
    const testPark = page.locator('#packs .pack', { hasText: '18 Test Park' });
    await expect(testPark).toContainText('+£1,331.14');            // uplift + top-up + the room let
    await pick('Leave as is');
    await expect(page.locator('#toast')).toContainText('Saved');
    expect(writes.filter(x => x.tableId === TBL.properties).pop().records[0].fields[P.strategy]).toBe('Leave as is');
    await expect(testPark).toContainText('+£433.62');               // the room let is gone, the paper trail remains
    await expect(page.locator('#setupAll')).toHaveAttribute('open', '');           // the panel survives the re-render
    await expect(page.locator('#setupBody select[data-prop-field="strategy"]').first()).toHaveValue('Leave as is');
    await pick('HMO');                                              // and it can be put back
    await expect(testPark).toContainText('+£1,331.14');
  });

  test('a pack says what to collect, and its tenant button opens that tenant on the form', async ({ page }) => {
    await openPage(page, fixtures());
    await page.locator('#packs .pack').first().locator('.pack-head').click();
    const pack = page.locator('#packs .pack.open');
    await expect(pack).toContainText('Adam Older');
    await expect(pack).toContainText('National Insurance number');
    await expect(pack).toContainText('photo ID');
    await pack.locator('button[data-act="open-form"]').first().click();
    await expect(page.locator('#meetingForm')).toBeVisible();
    await expect(page.locator('#formTenant')).toHaveValue('recT1');
    await expect(page.locator('#mktBody')).toContainText('Use now, as soon as a room opens');
    await expect(page.locator('#mktBody')).toContainText('When we need more leads');
    await expect(page.locator('#mktBody')).not.toContainText('DSS Move');
    await expect(pack).toContainText('Gary Unknown');
    await expect(pack).toContainText('Not in the plan until the date of birth is on file');
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
    await expect(page.locator('#packs')).toContainText('No property has work outstanding');

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
