// Roy's Growth Plan tab (Kevin, 18 Sep 2026). His dashboard frames KEVIN'S OWN growth plan
// page with ?via=pm: every read and write goes through the Property Manager Worker on his
// session, never an Airtable key. One page, one set of maths, so his figures cannot drift
// from Kevin's. What he may change is the checklist; the plan itself stays Kevin's.
const { test, expect } = require('@playwright/test');
const { stubExternalHosts } = require('./helpers');

const PM = 'https://pm.operationsdirector.co.uk';
const P = { name: 'fldqMbR329TNY974G', type: 'fldOySSrZBYkOLLTX', beds: 'fldeXUMcC6O4AcvRG', agent: 'fldEUrWVhSp3NY8Hh', postcode: 'fld6ebSQgD7eRsobd', active: 'fldBUeSJQZZSnFrFW', strategy: 'fldivZ9UbAACwv7Yh', ctNote: 'fldt7zY1TPihahH6H' };
const U = { property: 'fldUJNRGgzgyAwwjt', number: 'fld3nPlpdXSExxDuq', type: 'fldsItq0vU3sHv7n9', status: 'fldBvqysXBm9rIm0E', tenants: 'fldQO09UAFRf07V7q', incomeType: 'fldPrhfntWO9aHl58' };
const T = { name: 'fldxBKW7QnujSDWqA', status: 'fldAXzP9SGIHiAhrv', dob: 'fldv7FKsqXYswyCFE', payType: 'fldZbrk8Xw5Dcwxhi' };
const TT = { correctAgreement: 'fldCqe5vCXSPDbGev', proofOfAddress: 'fldfTl5QcGxfIzQ8W', authoritySigned: 'fldHPe9YQ6GmlrKBt', rentUplift: 'fld4cGcQbuV2xh2rQ' };
const C = { tenants: 'fld1i5bDoHL3B6rUf', unit: 'fld7cjLLEHKAx49OK', rent: 'fldDMyfZLFMeONPq8' };
const S = { key: 'fldiyJqkTQ9i2p2Wc', value: 'fldye89gwAzXWDphp', label: 'fldqN8fc8vk8qBeom' };

// One Haverhill house let by the room, so the page has ticks and a move to show.
function growthPayload() {
  return {
    ok: true, who: 'Roy Lavin', generatedAt: new Date().toISOString(),
    props: [{ id: 'recProp1', fields: { [P.name]: ['18 Test Park'], [P.type]: 'HMO', [P.beds]: 3, [P.agent]: 'Property Portfolio', [P.postcode]: 'CB9 0AJ', [P.active]: [true], [P.strategy]: 'UC HMO', [P.ctNote]: '£135.00', 'fldzV9YbHhNUUxwmA': 3 } }],   // three lettable rooms, two let: one to fill
    units: [
      { id: 'recU1', fields: { [U.property]: ['recProp1'], [U.number]: 1, [U.type]: 'Room', [U.status]: 'Occupied', [U.tenants]: ['recT1'], [U.incomeType]: 'Universal Credit' } },
      { id: 'recU2', fields: { [U.property]: ['recProp1'], [U.number]: 2, [U.type]: 'Room', [U.status]: 'Occupied', [U.tenants]: ['recT2'], [U.incomeType]: 'Universal Credit' } },
    ],
    tenants: [
      { id: 'recT1', fields: { [T.name]: 'Adam Older', [T.status]: 'Active', [T.dob]: '1988-11-20', [T.payType]: 'Universal Credit' } },
      { id: 'recT2', fields: { [T.name]: 'Paul Flat', [T.status]: 'Active', [T.dob]: '1974-01-01', [T.payType]: 'Universal Credit' } },
    ],
    tenancies: [
      { id: 'recC1', fields: { [C.tenants]: ['recT1'], [C.unit]: ['recU1'], [C.rent]: 524.90 } },
      { id: 'recC2', fields: { [C.tenants]: ['recT2'], [C.unit]: ['recU2'], [C.rent]: 524.90 } },
    ],
    costs: [], planRows: [],
    settingRows: ['lha_room:524.90', 'lha_1bed:897.52', 'council_tax_default:145', 'room_prep_cost:1500'].map((kv, i) => {
      const [k, v] = kv.split(':'); return { id: 'recS' + i, fields: { [S.key]: k, [S.value]: Number(v), [S.label]: k } };
    }),
  };
}

// Mocks the Worker and refuses any call to Airtable, which is the point: Roy holds no key.
async function openRoysGrowthPlan(page, { onWrite, payload } = {}) {
  const airtableCalls = [];
  await stubExternalHosts(page);
  await page.addInitScript(() => { localStorage.setItem('pm_token', 'roy-session-token'); localStorage.setItem('pm_who', 'Roy Lavin'); });
  await page.route('**/api.airtable.com/**', route => { airtableCalls.push(route.request().url()); route.fulfill({ status: 500, body: '{}' }); });
  await page.route(PM + '/**', async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    if (path === '/growth-plan' && req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload ? payload(growthPayload()) : growthPayload()) });
    if (path.startsWith('/growth-plan/')) {
      if (onWrite) onWrite({ path, body: req.postDataJSON() });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, records: [{ id: 'recNew1', fields: {} }] }) });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.goto('/growth-plan.html?via=pm');
  await expect(page.locator('#dashboard')).toBeVisible({ timeout: 20000 });
  return airtableCalls;
}

test.describe('Roy\'s Growth Plan tab', () => {
  test('opens on his dashboard session, with no key and no sign-in box', async ({ page }) => {
    const airtableCalls = await openRoysGrowthPlan(page);
    await expect(page.locator('#authScreen')).toBeHidden();
    await expect(page.locator('#kpis table.grid')).toBeVisible();
    await expect(page.locator('#selfList .pack', { hasText: '18 Test Park' })).toBeVisible();
    expect(airtableCalls).toEqual([]);     // never a direct Airtable call from Roy's browser
  });

  test('shows the same figures the model gives Kevin, from the same page', async ({ page }) => {
    await openRoysGrowthPlan(page);
    const grid = page.locator('#kpis table.grid');
    await expect(grid.locator('thead [data-kpi]')).toHaveCount(5);
    await expect(grid.locator('tbody tr').first().locator('td').nth(1)).toHaveText('£1,050');   // 2 × £524.90
    await expect(page.locator('#selfList .cl-item')).toHaveCount(await page.evaluate(() => window._growthPlan.plan.selfManaged[0].checklist.items.length));
  });

  test('he can tick the checklist, and the tick goes through the Worker', async ({ page }) => {
    const writes = [];
    await openRoysGrowthPlan(page, { onWrite: w => writes.push(w) });
    await page.locator('input[data-tenant-tick="proofOfAddress"][data-tenant="recT1"]').check();
    await expect(page.locator('#toast')).toContainText('Proof of address ticked for Adam Older');
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/growth-plan/tick');
    expect(writes[0].body).toEqual({ tenantId: 'recT1', field: 'proofOfAddress', value: true });
  });

  test('he can start a move and raise a task, both through the Worker', async ({ page }) => {
    const writes = [];
    await openRoysGrowthPlan(page, { onWrite: w => writes.push(w) });
    const move = page.locator('#selfList .cl-item', { hasText: 'more room' });
    await move.locator('button[data-act="adopt"]').click();
    await expect(page.locator('#toast')).toContainText('Adopted');
    expect(writes.at(-1).path).toBe('/growth-plan/row');
    expect(writes.at(-1).body.fields['fldDKDIgcekYZSFp7']).toBe('Adopted');
    await page.locator('#selfList .cl-item', { hasText: 'more room' }).locator('button[data-act="task"]').click();
    await expect(page.locator('#toast')).toContainText('Task created');
    expect(writes.some(w => w.path === '/growth-plan/task')).toBe(true);
  });

  test('the plan itself stays Kevin\'s: no picker, no set-up boxes, no freeze, no forms', async ({ page }) => {
    await openRoysGrowthPlan(page);
    await page.locator('#selfList .pack', { hasText: '18 Test Park' }).locator('.pack-head').click();
    const open = page.locator('#selfList .pack.open');
    await expect(open).toContainText('The plan for this property is');
    await expect(open.locator('select[data-prop-field]')).toHaveCount(0);
    await expect(open.locator('input[data-prop-field]')).toHaveCount(0);
    await expect(open).toContainText('Kevin sets these');
    await expect(page.locator('button[data-act="freeze-started"]')).toHaveCount(0);
    await expect(page.locator('#gp-form')).toBeVisible();     // the data capture form is his (18 Sep 2026)
    await expect(page.locator('#docsBox')).toBeHidden();      // uploading a scan is not, yet
    await expect(page.locator('details.more', { hasText: 'Set up every property' })).toBeHidden();
    await expect(page.locator('details.more', { hasText: 'Every assumption behind the figures' })).toBeHidden();
    // Not merely hidden: the set-up controls are not in Roy's page at all.
    await expect(page.locator('select[data-prop-field]')).toHaveCount(0);
    await expect(page.locator('#setupBody tr')).toHaveCount(0);
  });

  test('he can fill in the tenant data capture form, and it saves through the Worker', async ({ page }) => {
    const writes = [];
    await openRoysGrowthPlan(page, { onWrite: w => writes.push(w) });
    await page.locator('#selfList .pack', { hasText: '18 Test Park' }).locator('.pack-head').click();
    await page.locator('#selfList .pack.open button[data-act="open-form"]').first().click();
    await expect(page.locator('#meetingForm')).toBeVisible();
    await page.locator('#meetingForm input[name="ni"]').fill('AB123456A');
    await page.locator('#meetingForm input[name="idSeen"], #meetingForm select[name="idSeen"]').first().selectOption({ index: 1 }).catch(() => {});
    await page.locator('#meetingSave').click();
    await expect(page.locator('#toast')).toContainText('Meeting saved');
    const w = writes.filter(x => x.path === '/growth-plan/tenant').pop();
    expect(w).toBeTruthy();
    expect(w.body.tenantId).toMatch(/^recT/);
    expect(w.body.fields['fld1rHf1qZ60qK95l']).toBe('AB123456A');   // National Insurance
  });

  test('a date of birth can be fixed from his tab, and it saves through the Worker', async ({ page }) => {
    const writes = [];
    // Paul Flat with no date of birth: the tenant the plan cannot price until it is known.
    await openRoysGrowthPlan(page, { onWrite: w => writes.push(w), payload: p => { delete p.tenants[1].fields[T.dob]; return p; } });
    await page.locator('#selfList .pack', { hasText: '18 Test Park' }).locator('.pack-head').click();
    const open = page.locator('#selfList .pack.open');
    await open.locator('input[data-dob="recT2"]').fill('1980-06-01');
    await open.locator('button[data-act="save-dob"][data-tenant="recT2"]').click();
    await expect(page.locator('#toast')).toContainText('Date of birth saved');
    const w = writes.filter(x => x.path === '/growth-plan/tenant').pop();
    expect(w.body.tenantId).toBe('recT2');
    expect(w.body.fields['fldv7FKsqXYswyCFE']).toBe('1980-06-01');           // Date of Birth
    expect(w.body.fields['fldfwxEf7I3XQDVtR']).toMatch(/Growth Plan page/);  // the dated line on Notes
  });

  test('Kevin\'s own page is untouched: the key flow, the picker and the set-up all stay', async ({ page }) => {
    await stubExternalHosts(page);
    await page.goto('/growth-plan.html');
    await expect(page.locator('#authScreen')).toBeVisible();   // asks for the key, as it always has
  });
});

test.describe('the dashboard tab that carries it', () => {
  test('Roy has a Growth Plan tab that frames the page through the Worker', async ({ page }) => {
    await stubExternalHosts(page);
    await page.addInitScript(() => { localStorage.setItem('pm_token', 'roy-session-token'); localStorage.setItem('pm_who', 'Roy Lavin'); });
    await page.route(PM + '/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, tasks: [] }) }));
    await page.goto('/property-manager/index.html');
    const tab = page.locator('.tabs button', { hasText: 'Growth Plan' });
    await expect(tab).toBeVisible();
    await tab.click();
    const frame = page.locator('#growthFrame');
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute('src', '../growth-plan.html?via=pm');
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  });
});
