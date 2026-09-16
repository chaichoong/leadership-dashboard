// Real Estate Growth Plan (growth-plan.html) — renders from mocked Airtable, prices the
// levers from the model, and writes back the four things it is allowed to write.
const { test, expect } = require('@playwright/test');
const { MOCK_PAT, stubExternalHosts, loadDashboard } = require('./helpers');

// Field IDs mirror js/config.js GP (the page reads by field ID).
const P = { strategy: 'fldivZ9UbAACwv7Yh', plannedExtra: 'fldFd4scZaJsXQ0n7', owner: 'flduloaYTsuvMxvF7', ctBand: 'fldNzUqbTNzTeNJqN', ctAnnual: 'fldZsLDNeEvghtFDJ', name: 'fldqMbR329TNY974G', type: 'fldOySSrZBYkOLLTX', beds: 'fldeXUMcC6O4AcvRG', agent: 'fldEUrWVhSp3NY8Hh', ctNote: 'fldt7zY1TPihahH6H', area: 'fldYLRz2GgVojKaq9', postcode: 'fld6ebSQgD7eRsobd', active: 'fldBUeSJQZZSnFrFW', lettableRooms: 'fldzV9YbHhNUUxwmA', payg: 'fldkBSgcELtpGZhjV', ctPayer: 'fldwWcSfkdtSbVhdj' };
const U = { tenants: 'fldQO09UAFRf07V7q', type: 'fldsItq0vU3sHv7n9', number: 'fld3nPlpdXSExxDuq', property: 'fldUJNRGgzgyAwwjt', status: 'fldBvqysXBm9rIm0E', incomeType: 'fldPrhfntWO9aHl58', rent: 'fldQZEjNzhU4UDUW9' };
const T = { over35: 'flddQ2HnQEf4HBeRn', meetingDate: 'fldTz5BU7jxA2mc1B', ucPayDay: 'fldjTG9xdCLpbwOwC', ni: 'fld1rHf1qZ60qK95l', phone: 'fldraHUkWfqo4olLF', email: 'fldybEduFY3DWWTfT', name: 'fldxBKW7QnujSDWqA', status: 'fldAXzP9SGIHiAhrv', dob: 'fldv7FKsqXYswyCFE', payType: 'fldZbrk8Xw5Dcwxhi', notes: 'fldfwxEf7I3XQDVtR', capExemption: 'fldOOi3d1P4vDedm6' };
const TT = { correctAgreement: 'fldCqe5vCXSPDbGev', proofOfAddress: 'fldfTl5QcGxfIzQ8W', authoritySigned: 'fldHPe9YQ6GmlrKBt', rentUplift: 'fld4cGcQbuV2xh2rQ' };
const PX = { movingToSelfManage: 'flddfP8ClsH4JeN2o', baselineRent: 'fldfTtL7On1C2OmRU', baselineCt: 'fldFyN175n3TngNtt' };
// Rental Units fields added 16 Sep 2026: how a unit is let today, and a block flat's own plan, band and start.
const UX = { beds: 'fldGMguNbV7GvzsHs', lettingStrategy: 'fldcv02tac2Df3JlO', strategy: 'fldMg7hbVvHXXTQet', ctBand: 'fldciMGjBs3h6QAH3', baselineRent: 'fldeKsD7Hlsd2chUZ', baselineCt: 'fldh6EFTz8epLPKmU', baselineDate: 'fldRULhlR505Peqlh' };
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

// Duckworth Building in miniature (Kevin, 16 Sep 2026): one block, a serviced-accommodation
// 2-bed and a single-let 1-bed, each with its own live tenancy and band.
function withBlock(fx, agent) {
  fx[TBL.properties].push({ id: 'recBlock', fields: { [P.name]: ['Duckworth Building'], [P.type]: 'Block', [P.beds]: 2, [P.agent]: agent, [P.postcode]: 'FY8 1SQ', [P.active]: [true] } });
  fx[TBL.units].push(
    { id: 'recApt1', fields: { [U.property]: ['recBlock'], [U.number]: 1, [U.type]: 'Flat', [U.status]: 'Occupied', [U.tenants]: ['recT5'], [UX.beds]: 2, [UX.lettingStrategy]: 'Serviced accommodation', [UX.ctBand]: 'A' } },
    { id: 'recApt2', fields: { [U.property]: ['recBlock'], [U.number]: 2, [U.type]: 'Flat', [U.status]: 'Occupied', [U.tenants]: ['recT6'], [UX.beds]: 1, [UX.lettingStrategy]: 'Single let', [UX.ctBand]: 'A' } },
  );
  fx[TBL.tenants].push(
    { id: 'recT5', fields: { [T.name]: 'Staycay Management', [T.status]: 'Active', [T.payType]: 'Working' } },
    { id: 'recT6', fields: { [T.name]: 'Flat Tenant', [T.status]: 'Active', [T.payType]: 'Working' } },
  );
  fx[TBL.tenancies].push(
    { id: 'recC5', fields: { [C.tenants]: ['recT5'], [C.unit]: ['recApt1'], [C.rent]: 500 } },
    { id: 'recC6', fields: { [C.tenants]: ['recT6'], [C.unit]: ['recApt2'], [C.rent]: 687 } },
  );
  return fx;
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

  test('leads with the grid, and splits our properties from the agent-run ones', async ({ page }) => {
    await openPage(page, fixtures());
    const grid = page.locator('#kpis table.grid');
    await expect(grid.locator('thead [data-kpi]')).toHaveCount(4);
    await expect(grid.locator('thead')).toContainText('Where we started');
    await expect(grid.locator('thead')).toContainText('Where we are now');
    await expect(grid.locator('thead')).toContainText('If the plan is done');
    await expect(grid.locator('thead')).toContainText('Best possible');
    await expect(grid.locator('tbody tr')).toHaveCount(3);
    await expect(grid.locator('tbody')).toContainText('Rent a month');
    await expect(grid.locator('tbody')).toContainText('Council tax we pay');
    await expect(grid.locator('tbody')).toContainText('Left for us');
    // Rent now: 524.90 + 897.52 + 524.90 + 257; the agent house has no units in this fixture
    await expect(grid.locator('tbody tr').first().locator('td').nth(1)).toHaveText('£2,204');
    // Council tax now: £135 on the room-let house we run; the single lets and the agent house carry none
    await expect(grid.locator('tbody tr').nth(1).locator('td').nth(1)).toHaveText('−£135');
    await expect(page.locator('#selfCount')).toHaveText('2 properties');
    await expect(page.locator('#agentCount')).toHaveText('1 properties');
    await expect(page.locator('#selfList')).toContainText('13 Far Street');   // Simon Collins is ours
    await expect(page.locator('#agentList')).toContainText('9 Agent Road');
  });

  test('every property is priced four ways under the new names, council tax on its own line', async ({ page }) => {
    await openPage(page, fixtures());
    const open = await openSelf(page, '18 Test Park');
    const rows = open.locator('.fourtbl tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('Single let');
    await expect(rows.nth(1)).toContainText('UC joint tenancy');
    await expect(rows.nth(2)).toContainText('UC HMO');
    await expect(rows.nth(3)).toContainText('Serviced accommodation');
    await expect(rows.nth(0)).toContainText('The tenant pays the council tax, not us');
    await expect(rows.nth(1)).toContainText('only once EVERY tenant has signed the one joint agreement');
    await expect(rows.nth(2)).toContainText('We pay the council tax: £135.00 a month');
    await expect(rows.nth(1)).toContainText('£1,795.04');
    await expect(rows.nth(3)).toContainText('£365.00');
    // and the start-to-ceiling table sits above it for this property
    await expect(open.locator('.nowtbl tbody tr')).toHaveCount(4);
    await expect(open.locator('.nowtbl')).toContainText('Let by the room, so the council tax is ours');
  });

  test('the picker offers all four strategies and Leave as is, and picking one shows its paperwork', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    const open = await openSelf(page, '18 Test Park');
    const picker = open.locator('select[data-prop-field="strategy"]');
    await expect(picker.locator('option')).toHaveText(['Not decided yet', 'Single let', 'UC joint tenancy', 'UC HMO', 'Serviced accommodation', 'Leave as is']);
    await expect(picker).toHaveValue('UC HMO');   // stored as the old "HMO", read through the alias
    await expect(open).toContainText('What we have to do for UC HMO');
    await picker.selectOption('Single let');
    await expect(page.locator('#toast')).toContainText('Saved');
    const w = writes.filter(x => x.tableId === TBL.properties).pop();
    expect(w.records[0].fields[P.strategy]).toBe('Single let');
    await expect(page.locator('#selfList .pack.open')).toContainText('What we have to do for Single let');
    await page.locator('#selfList .pack.open select[data-prop-field="strategy"]').selectOption('Serviced accommodation');
    await expect(page.locator('#selfList .pack.open')).toContainText('What we have to do for Serviced accommodation');
    await expect(page.locator('#selfList .pack.open')).toContainText('Nothing for us to sign');
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
    await open.locator('select[data-prop-field="strategy"]').selectOption('UC HMO');
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

  test('each tenant has four ticks, and each writes its own field', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    const open = await openSelf(page, '18 Test Park');
    const adam = open.locator('li', { hasText: 'Adam Older' }).first();
    await expect(adam.locator('label.tick')).toHaveText(['Correct tenancy agreement', 'Proof of address', 'Letter of authority', /Rent uplift/]);
    await adam.locator('input[data-tenant-tick="proofOfAddress"]').check();
    await expect(page.locator('#toast')).toContainText('Proof of address ticked for Adam Older');
    let w = writes.filter(x => x.tableId === TBL.tenants).pop();
    expect(w.records[0]).toEqual({ id: 'recT1', fields: { [TT.proofOfAddress]: true } });
    await page.locator('#selfList .pack.open li', { hasText: 'Adam Older' }).first().locator('input[data-tenant-tick="authoritySigned"]').check();
    w = writes.filter(x => x.tableId === TBL.tenants).pop();
    expect(w.records[0].fields[TT.authoritySigned]).toBe(true);
  });

  test('ticking a rent uplift done writes Done, marks its move done, and puts the rent into now', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    const nowRent = () => page.locator('#kpis table.grid tbody tr').first().locator('td').nth(1);
    await expect(nowRent()).toHaveText('£2,204');
    const open = await openSelf(page, '18 Test Park');
    await open.locator('li', { hasText: 'Adam Older' }).first().locator('input[data-tenant-tick="rentUplift"]').check();
    await expect(page.locator('#toast')).toContainText('Rent uplift done for Adam Older');
    const tenantWrite = writes.find(x => x.tableId === TBL.tenants);
    expect(tenantWrite.records[0]).toEqual({ id: 'recT1', fields: { [TT.rentUplift]: 'Done' } });
    const planWrite = writes.filter(x => x.tableId === TBL.plan).pop();
    expect(planWrite.records[0].fields[PLAN.key]).toBe('uplift:recT1');
    expect(planWrite.records[0].fields[PLAN.status]).toBe('Done');
    await expect(nowRent()).toHaveText('£2,577');   // + £372.62, the gap to the 1-bed rate
  });

  test('a tenant preset as Not needed shows ticked and adds nothing', async ({ page }) => {
    const fx = fixtures();
    fx[TBL.tenants][0].fields[TT.rentUplift] = 'Not needed';
    await openPage(page, fx);
    await expect(page.locator('#kpis table.grid tbody tr').first().locator('td').nth(1)).toHaveText('£2,204');
    const open = await openSelf(page, '18 Test Park');
    const adam = open.locator('li', { hasText: 'Adam Older' }).first();
    await expect(adam.locator('input[data-tenant-tick="rentUplift"]')).toBeChecked();
    await expect(adam).toContainText('nothing to chase');
    await expect(open.locator('tr', { hasText: 'room rate to 1-bed rate' })).toHaveCount(0);
  });

  test('a joint tenancy keeps council tax on us until every tenant has the correct agreement', async ({ page }) => {
    const fx = fixtures();
    fx[TBL.properties][0].fields[P.strategy] = 'Joint tenancy';
    const writes = await openPage(page, fx);
    const ctNow = () => page.locator('#kpis table.grid tbody tr').nth(1).locator('td').nth(1);
    await expect(ctNow()).toHaveText('−£135');
    const open = await openSelf(page, '18 Test Park');
    await expect(open.locator('.nowtbl')).toContainText('0 of 3 so far');
    for (const name of ['Adam Older', 'Paul Flat', 'Gary Unknown']) {
      await page.locator('#selfList .pack.open li', { hasText: name }).first().locator('input[data-tenant-tick="correctAgreement"]').check();
      await expect(page.locator('#toast')).toContainText('Correct tenancy agreement ticked for ' + name);
      if (name !== 'Gary Unknown') await expect(ctNow()).toHaveText('−£135');   // not yet: every tenant
    }
    expect(writes.filter(x => x.tableId === TBL.tenants).every(w => w.records[0].fields[TT.correctAgreement] === true)).toBe(true);
    await expect(ctNow()).toHaveText('£0');
    await expect(page.locator('#selfList .pack.open .nowtbl')).toContainText('Every tenant has signed the joint agreement');
  });

  test('an agent-run property shows only the self-manage toggle, and ticking it moves it into our list', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    const agent = page.locator('#agentList .pack', { hasText: '9 Agent Road' });
    await agent.locator('.pack-head').click();
    const open = page.locator('#agentList .pack.open');
    await expect(open.locator('input[data-prop-field="movingToSelfManage"]')).toHaveCount(1);
    await expect(open.locator('.fourtbl')).toHaveCount(0);
    await expect(open.locator('.ticks')).toHaveCount(0);
    await expect(open.locator('select[data-prop-field="strategy"]')).toHaveCount(0);
    // click, not check(): ticking moves the property into the other list and redraws it, so the
    // checkbox Playwright clicked is detached before it could confirm it reads ticked.
    await open.locator('input[data-prop-field="movingToSelfManage"]').click();
    await expect(page.locator('#toast')).toContainText('Moved to the properties we run ourselves');
    const w = writes.filter(x => x.tableId === TBL.properties).pop();
    expect(w.records[0]).toMatchObject({ id: 'recAgent', fields: { [PX.movingToSelfManage]: true } });
    await expect(page.locator('#selfCount')).toHaveText('3 properties');
    await expect(page.locator('#agentList')).not.toContainText('9 Agent Road');
    await expect(page.locator('#selfList')).toContainText('9 Agent Road');
  });

  test('where we started reads the frozen snapshot once one exists', async ({ page }) => {
    const fx = fixtures();
    fx[TBL.properties].forEach(r => { r.fields[PX.baselineRent] = 1000; r.fields[PX.baselineCt] = 50; });
    await openPage(page, fx);
    const started = page.locator('#kpis table.grid tbody tr');
    await expect(started.nth(0).locator('td').nth(0)).toHaveText('£3,000');
    await expect(started.nth(1).locator('td').nth(0)).toHaveText('−£150');
    await expect(page.locator('#kpis')).not.toContainText('not frozen yet');
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
    // the status pill carries its colour class: the regex once matched a literal backslash, so it never did
    await expect(page.locator('#selfList .pack.open tr', { hasText: 'room rate to 1-bed rate' }).locator('.pill.st-in-progress')).toHaveCount(1);
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
    await expect(page.locator('#glossaryBody')).toContainText('short for House in Multiple Occupation');
    await expect(page.locator('#glossaryBody')).toContainText('the leadership dashboard is where you see it arrive');
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

  test('a grid column opens to show the properties behind it', async ({ page }) => {
    await openPage(page, fixtures());
    await expect(page.locator('#kpiDetail')).toBeHidden();
    await page.locator('[data-kpi="now"]').click();
    await expect(page.locator('#kpiDetail')).toBeVisible();
    await expect(page.locator('#kpiDetail')).toContainText('Where we are now, property by property');
    await expect(page.locator('#kpiDetail')).toContainText('18 Test Park');
    await expect(page.locator('#kpiDetail')).toContainText('9 Agent Road (Roc Immo)');
    await page.locator('[data-kpi="now"]').click();
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

  test('review fix 2: unknown council tax is marked on the grid and named', async ({ page }) => {
    const fx = fixtures();
    fx[TBL.costs] = [];
    fx[TBL.properties][0].fields[P.postcode] = 'CO12 3DB';   // Tendring: no council tax rate on file
    delete fx[TBL.properties][0].fields[P.ctBand];
    await openPage(page, fx);
    await expect(page.locator('#ctUnknownNote')).toContainText('Council tax is not known on 1 property');
    await expect(page.locator('#ctUnknownNote')).toContainText('18 Test Park');
    await expect(page.locator('#kpis table.grid .unk').first()).toBeVisible();
    const open = await openSelf(page, '18 Test Park');
    await expect(open.locator('.nowtbl')).toContainText('not known');
    await expect(open.locator('.nowtbl')).toContainText('before council tax');
    await page.locator('[data-kpi="best"]').click();
    await expect(page.locator('#kpiDetail tr', { hasText: '18 Test Park' })).toContainText('not known');
  });

  test('review fix 4: a move left open with nothing behind it can be dropped', async ({ page }) => {
    const fx = fixtures();
    fx[TBL.tenants][0].fields[TT.rentUplift] = 'Not needed';
    fx[TBL.plan].push({ id: 'recStranded', fields: { [PLAN.key]: 'uplift:recT1', [PLAN.status]: 'Adopted', [PLAN.title]: 'Adam Older: room rate to 1-bed rate' } });
    const writes = await openPage(page, fx);
    const open = await openSelf(page, '18 Test Park');
    const stranded = open.locator('.stranded');
    await expect(stranded).toContainText('No longer on the plan, but still open');
    await expect(stranded).toContainText('Adam Older: room rate to 1-bed rate');
    await stranded.locator('button[data-act="drop-row"]').click();
    await expect(page.locator('#toast')).toContainText('Dropped: Adam Older');
    const w = writes.filter(x => x.tableId === TBL.plan).pop();
    expect(w.records[0]).toEqual({ id: 'recStranded', fields: { [PLAN.status]: 'Dropped' } });
    await expect(page.locator('#selfList .pack.open .stranded')).toHaveCount(0);
  });

  test('review fix 5: Freeze writes only the starting figures still missing', async ({ page }) => {
    const fx = fixtures();
    fx[TBL.properties][2].fields[PX.baselineRent] = 777;   // 13 Far Street already has a starting rent
    fx[TBL.properties][2].fields['fldp0bTV5uUIQkHh6'] = '2026-09-01';
    const writes = await openPage(page, fx);
    await expect(page.locator('#kpis')).toContainText('not frozen for 3 properties');
    await page.locator('button[data-act="freeze-started"]').click();
    await expect(page.locator('#toast')).toContainText('Froze where we started for 3 properties');
    const recs = writes.filter(x => x.tableId === TBL.properties).flatMap(x => x.records);
    const byId = Object.fromEntries(recs.map(r => [r.id, r.fields]));
    expect(byId.recProp1[PX.baselineRent]).toBe(1947.32);
    expect(byId.recProp1[PX.baselineCt]).toBe(135);
    expect(PX.baselineRent in byId.recProp2).toBe(false);          // the saved rent is never overwritten
    expect('fldp0bTV5uUIQkHh6' in byId.recProp2).toBe(false);      // nor its date
    expect(byId.recProp2[PX.baselineCt]).toBe(0);                  // a single let: no council tax to us
    await expect(page.locator('#kpis')).not.toContainText('not frozen');
    await expect(page.locator('button[data-act="freeze-started"]')).toHaveCount(0);
  });

  test('review fix 1: a promoted property\'s tenants reach the meeting form', async ({ page }) => {
    const fx = fixtures();
    fx[TBL.properties][0].fields[P.agent] = 'Roc Immo';
    fx[TBL.properties][0].fields[PX.movingToSelfManage] = true;
    await openPage(page, fx);
    await expect(page.locator('#formTenant option', { hasText: 'Adam Older' })).toHaveCount(1);
    const open = await openSelf(page, '18 Test Park');
    await expect(open.locator('tr', { hasText: 'room rate to 1-bed rate' }).first()).toBeVisible();
  });

  test('every row shows our plan and the ceiling side by side', async ({ page }) => {
    const fx = fixtures();
    fx[TBL.properties][2].fields[P.strategy] = 'Single let';   // 13 Far Street: a single let at £257
    await openPage(page, fx);
    const far = page.locator('#selfList .pack', { hasText: '13 Far Street' });
    const figs = far.locator('.pack-fig .figcol');
    await expect(figs).toHaveCount(2);
    await expect(figs.nth(0).locator('.figlbl')).toHaveText('Our plan');
    await expect(figs.nth(1).locator('.figlbl')).toHaveText('Ceiling');
    // 13 Far Street has no researched market rent, so the plan uses the 2-bed housing allowance
    // estimate (£473.72), which is above its £257: picking Single let must show that rise
    await expect(figs.nth(0).locator('b')).not.toHaveText('no change');
    await expect(figs.nth(0)).toContainText('Single let');
    // a property with no plan still shows its ceiling beside a clear "no plan picked"
    const park = page.locator('#selfList .pack', { hasText: '18 Test Park' });
    await expect(park.locator('.pack-fig .figcol')).toHaveCount(2);
    const agent = page.locator('#agentList .pack', { hasText: '9 Agent Road' });
    await expect(agent.locator('.pack-fig .figcol').nth(0)).toContainText('agent-run');
    await expect(agent.locator('.pack-fig .figcol').nth(1).locator('.figlbl')).toHaveText('Ceiling');
  });

  test('extra tenants is worked out from lettable rooms, and has no box to type in', async ({ page }) => {
    const writes = await openPage(page, fixtures());   // the fixture still carries a typed Planned Extra Tenants of 1
    const open = await openSelf(page, '18 Test Park');
    await expect(open.locator('input[data-prop-field="plannedExtra"]')).toHaveCount(0);
    const extra = () => page.locator('#selfList .pack.open [data-extra-tenants="recProp1"]');
    await expect(extra()).toHaveText('1');                                   // 4 rooms (a flat-let is two) − 3 tenants
    await expect(page.locator('#selfList .pack.open .calcfield')).toContainText('4 lettable rooms − 3 tenants');
    const rooms = open.locator('input[data-prop-field="lettableRooms"]');
    await rooms.fill('6');
    await rooms.dispatchEvent('change');
    await expect(page.locator('#toast')).toContainText('Saved');
    expect(writes.filter(x => x.tableId === TBL.properties).pop().records[0].fields[P.lettableRooms]).toBe(6);
    await expect(extra()).toHaveText('3');                                   // 6 rooms − 3 tenants
    await expect(page.locator('#selfList .pack.open .calcfield')).toContainText('6 lettable rooms − 3 tenants');
    expect(writes.some(w => w.records.some(r => P.plannedExtra in (r.fields || {})))).toBe(false);   // nothing writes the old field
  });

  test('extra tenants shows a number only where it counts, and says why elsewhere', async ({ page }) => {
    const fx = fixtures();
    fx[TBL.properties][2].fields[P.strategy] = 'Single let';   // 13 Far Street
    await openPage(page, fx);
    let open = await openSelf(page, '13 Far Street');
    await expect(open.locator('[data-extra-tenants="recProp2"]')).toHaveText('—');
    await expect(open.locator('.calcfield')).toContainText('only counts for a UC HMO, and the plan is Single let');
    await page.locator('#selfList .pack.open .pack-head').click();   // close it
    open = await openSelf(page, '18 Test Park');
    await expect(open.locator('[data-extra-tenants="recProp1"]')).toHaveText('1');
  });

  test('a negative figure prints its minus before the pound sign', async ({ page }) => {
    const fx = fixtures();
    // 13 Far Street, empty: nothing coming in, band A council tax owed, so "left for us" is negative
    fx[TBL.units].find(u => u.id === 'recU4').fields[U.status] = 'Void';
    fx[TBL.units].find(u => u.id === 'recU4').fields[U.tenants] = [];
    await openPage(page, fx);
    const open = await openSelf(page, '13 Far Street');
    const now = open.locator('.nowtbl tr', { hasText: 'Where we are now' });
    await expect(now).toContainText('Empty, so the council tax is ours');
    await expect(now.locator('td').last()).toHaveText(/^−£137\.00$/);
    await expect(page.locator('#gp-self')).not.toContainText('£-');
  });

  // 16 Sep 2026: 22 Newton Street read £1,800 because the unit rollup adds ended tenancies.
  test('rent now reads the live tenancies, never the unit rollup', async ({ page }) => {
    const fx = fixtures();
    fx[TBL.units][3].fields[U.rent] = 1800;   // 13 Far Street: the rollup still carries a tenancy that ended
    await openPage(page, fx);
    await expect(page.locator('#kpis table.grid tbody tr').first().locator('td').nth(1)).toHaveText('£2,204');
    await expect(selfPack(page, '13 Far Street').locator('.pill', { hasText: ' rent' })).toHaveText('£257 rent');
  });

  test('a block of flats shows one row per apartment, each with its own letting and council tax', async ({ page }) => {
    const writes = await openPage(page, withBlock(fixtures(), 'Intus Lettings'));
    const list = page.locator('#agentList');
    await expect(page.locator('#agentCount')).toHaveText('3 properties');
    const a1 = list.locator('.pack', { hasText: 'Duckworth Building, Apartment 1' });
    const a2 = list.locator('.pack', { hasText: 'Duckworth Building, Apartment 2' });
    await expect(a1).toContainText('Now: Serviced accommodation');
    await expect(a1.locator('.pill', { hasText: ' rent' })).toHaveText('£500 rent · −£139 council tax');   // St Annes band A: ours, though an agent runs it
    await expect(a2).toContainText('Now: Single let');
    await expect(a2.locator('.pill', { hasText: ' rent' })).toHaveText('£687 rent');
    // Ticking self-manage on one apartment takes back the whole block.
    await a1.locator('.pack-head').click();
    await page.locator('#agentList .pack.open input[data-prop-field="movingToSelfManage"]').click();
    await expect(page.locator('#toast')).toContainText('Moved to the properties we run ourselves');
    expect(writes.filter(x => x.tableId === TBL.properties).pop().records[0].id).toBe('recBlock');
    await expect(page.locator('#selfList')).toContainText('Duckworth Building, Apartment 2');
  });

  test('an apartment\'s plan saves to its own rental unit, and a flat is never let by the room', async ({ page }) => {
    const writes = await openPage(page, withBlock(fixtures(), 'Property Portfolio'));
    const open = await openSelf(page, 'Duckworth Building, Apartment 2');
    await expect(open.locator('.fourtbl tr', { hasText: 'UC HMO' })).toContainText('Does not apply to a flat');
    await expect(open.locator('.fourtbl tr', { hasText: 'UC joint tenancy' })).toContainText('Does not apply to a one-bedroom flat');
    await open.locator('.pick select[data-prop-field="strategy"]').selectOption('Single let');
    await expect(page.locator('#toast')).toContainText('Saved to the apartment');
    const w = writes.filter(x => x.tableId === TBL.units).pop();
    expect(w.records[0].id).toBe('recApt2');
    expect(w.records[0].fields[UX.strategy]).toBe('Single let');
    expect(writes.filter(x => x.tableId === TBL.properties)).toHaveLength(0);
  });

  test('how a one-unit property is let today is set on the page and saved to its rental unit', async ({ page }) => {
    const writes = await openPage(page, fixtures());
    const open = await openSelf(page, '13 Far Street');
    await expect(open.locator('.pill', { hasText: 'Now:' })).toHaveText('Now: Single let');
    await open.locator('select[data-prop-field="lettingStrategy"]').selectOption('Serviced accommodation');
    await expect(page.locator('#toast')).toContainText('Let today as Serviced accommodation');
    const w = writes.filter(x => x.tableId === TBL.units).pop();
    expect(w.records[0].id).toBe('recU4');
    expect(w.records[0].fields[UX.lettingStrategy]).toBe('Serviced accommodation');
    await expect(page.locator('#selfList .pack.open .pill', { hasText: 'Now:' })).toHaveText('Now: Serviced accommodation');
    // 18 Test Park has three units, so how it is let is worked out, not typed
    await openSelf(page, '18 Test Park');
    await expect(page.locator('#selfList .pack.open select[data-prop-field="lettingStrategy"]')).toHaveCount(0);
  });

  test('a move on an apartment links to its block property and to the flat', async ({ page }) => {
    const fx = withBlock(fixtures(), 'Property Portfolio');
    const apt2 = fx[TBL.units].find(r => r.id === 'recApt2');
    apt2.fields[U.status] = 'Void'; apt2.fields[U.tenants] = [];
    fx[TBL.tenancies] = fx[TBL.tenancies].filter(r => r.id !== 'recC6');
    const writes = await openPage(page, fx);
    const open = await openSelf(page, 'Duckworth Building, Apartment 2');
    await open.locator('button[data-act="adopt"]').first().click();
    await expect(page.locator('#toast')).toContainText('Adopted: Duckworth Building, Apartment 2');
    const w = writes.filter(x => x.tableId === TBL.plan).pop();
    expect(w.records[0].fields[PLAN.key]).toBe('void:recApt2');
    expect(w.records[0].fields['fldYjvuoYHNlumtHd']).toEqual(['recBlock']);   // Growth Plan → Property
    expect(w.records[0].fields['flddfpEZqcrxBIlf2']).toEqual(['recApt2']);    // Growth Plan → Rental Unit
  });

  test('Freeze saves an apartment\'s starting figures on its rental unit', async ({ page }) => {
    const writes = await openPage(page, withBlock(fixtures(), 'Intus Lettings'));
    await page.locator('button[data-act="freeze-started"]').click();
    await expect(page.locator('#toast')).toContainText('Froze where we started for 5 properties');
    const units = writes.filter(x => x.tableId === TBL.units).flatMap(x => x.records);
    const byId = Object.fromEntries(units.map(r => [r.id, r.fields]));
    expect(Object.keys(byId).sort()).toEqual(['recApt1', 'recApt2']);
    expect(byId.recApt1[UX.baselineRent]).toBe(500);
    expect(byId.recApt1[UX.baselineCt]).toBe(139.41);
    expect(byId.recApt2[UX.baselineCt]).toBe(0);
    const props = writes.filter(x => x.tableId === TBL.properties).flatMap(x => x.records.map(r => r.id));
    expect(props).not.toContain('recApt1');
    expect(props).not.toContain('recBlock');
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
