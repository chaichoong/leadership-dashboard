// The Cash Flow Voids "Moved out" button ends a tenancy in one confirmed click (Kevin, 31 Oct 2026):
// "when a cash flow void turns into a move-out, we can just click a button ... and the system is accurate once
// again." It runs the airtable-tenancy-ender skill's six-question gate in the box before anything is written:
// a unit is voided only when no other live tenancy sits on it, a tenant who still lives in another of our houses
// stays Active, legacy-table rows on the unit do not count, an agent-managed tenancy never gets the button, and
// a failed write stops the run, names the step and leaves a note saying where. The last five cases are the
// independent review of 31 Oct 2026: two tenants leaving one unit on the same day, a second live tenancy on the
// same unit, records changed while the box was open, a future date, and a busy-moment 429.
//
// Drives the real button, box and writes against a fake Airtable that keeps every PATCH, so each read-back sees
// what was written, exactly as the live API would. Names, refs, dates and amounts are invented.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures, FIELDS } = require('./helpers');

const T = { tenancies: 'tblN51a88qTDB6iMH', tenants: 'tblX4elTuu01gwBYh', units: 'tblM3mZCR5kiEdWMj', tasks: 'tblqB8b22hKBL4PF1',
            legacy: 'tblCGmeUTyx1N7LNe' };   // the dead legacy tenancies table the unit's Tenancies copy link points at
const F = {
  surname: 'fldOXazTqBWieEOK2', endDate: 'fldwHhhKAq4f1nY9e', tenTasks: 'fldXEmcZb1TMUa9i2',
  tenantStatus: 'fldAXzP9SGIHiAhrv', currentUnit: 'fldeLsZYqbKS77S2V', tenantTenancies: 'fldWijr5nOIcKJMP4',
  unitStatus: 'fldBvqysXBm9rIm0E', unitTenancies: 'fldxOnUDg49C2PNVW', unitLegacy: 'fldmpIYp1cN0eQgWt',
  taskName: 'fldgFjGBw6bTKJFCD', taskStatus: 'fldx4qCw17UfrKpaN',
};
const FROZEN_NOW = new Date('2026-05-20T10:00:00');
const MOVE_OUT = '2026-05-18';

const TENANCY = 'recMoTenancy00001', OTHER = 'recMoTenancy00002', ELSEWHERE = 'recMoTenancy00003';
const TENANT = 'recMoTenant000001', UNIT = 'recMoUnit00000001', UNIT_2 = 'recMoUnit00000002';
const TASK_OPEN = 'recMoTask00000001', TASK_DONE = 'recMoTask00000002';
const TODAY = '2026-05-20';   // FROZEN_NOW's date

function tenancy(id, ref, surname, status, unit, extra = {}) {
  return {
    id, fields: {
      [FIELDS.tenRef]: ref, [F.surname]: surname, [FIELDS.tenRent]: 650, [FIELDS.tenDueDay]: 3,
      [FIELDS.tenPayStatus]: status, [FIELDS.tenStatus]: 'Active', [FIELDS.tenStartDate]: '2025-02-01',
      [FIELDS.tenUnit]: [unit], [FIELDS.tenLinkedTenant]: [TENANT], ...extra,
    },
  };
}

// One tenant in a CFV tenancy on one unit, with one open and one finished task. Each test bends one part of it.
function world({ payType = 'Universal Credit', otherOnUnit = false, otherEnd = null, livesElsewhere = false,
                 alsoOnThisUnit = false, legacyRow = false } = {}) {
  const tenancies = [tenancy(TENANCY, 'TEN-MO-1', 'Pellow', 'CFV', UNIT, { [F.tenTasks]: [TASK_OPEN, TASK_DONE] })];
  const unitLinks = [TENANCY];
  const tenantLinks = [TENANCY];
  const current = [UNIT];
  if (otherOnUnit) {
    tenancies.push(tenancy(OTHER, 'TEN-MO-2', 'Quarrie', 'In Payment', UNIT, { [FIELDS.tenLinkedTenant]: ['recMoTenant000002'],
      ...(otherEnd ? { [F.endDate]: otherEnd } : {}) }));
    unitLinks.push(OTHER);
  }
  if (alsoOnThisUnit) {
    // Their old record on the SAME unit, left open by a rent change: still live, so the unit is still theirs.
    tenancies.push(tenancy(ELSEWHERE, 'TEN-MO-3', 'Pellow', 'In Payment', UNIT));
    tenantLinks.push(ELSEWHERE);
    unitLinks.push(ELSEWHERE);
  }
  if (livesElsewhere) {
    tenancies.push(tenancy(ELSEWHERE, 'TEN-MO-3', 'Pellow', 'In Payment', UNIT_2));
    tenantLinks.push(ELSEWHERE);
    current.push(UNIT_2);
  }
  return {
    tenancies,
    tenants: [{ id: TENANT, fields: { [FIELDS.tenantName]: 'Arlo Pellow', [FIELDS.tenantPayType]: payType,
      [F.tenantStatus]: 'Active', [F.currentUnit]: current, [F.tenantTenancies]: tenantLinks } }],
    rentalUnits: [
      { id: UNIT, fields: { [FIELDS.unitName]: 'Unit 2 – 9 Example Row', [F.unitStatus]: 'Occupied',
        [F.unitTenancies]: unitLinks, ...(legacyRow ? { [F.unitLegacy]: ['recMoLegacyRow001'] } : {}) } },
      { id: UNIT_2, fields: { [FIELDS.unitName]: 'Unit 1 – 4 Sample Lane', [F.unitStatus]: 'Occupied',
        [F.unitTenancies]: livesElsewhere ? [ELSEWHERE] : [] } },
    ],
    tasks: [
      { id: TASK_OPEN, fields: { [F.taskName]: 'NEW TENANT RENT: housing costs check: Unit 2', [F.taskStatus]: 'Upcoming' } },
      { id: TASK_DONE, fields: { [F.taskName]: 'RENT LATE: Unit 2', [F.taskStatus]: 'Completed' } },
    ],
    // A years-old legacy row that still reads Live, with no end date: it must never count as a tenant.
    legacyTenancies: legacyRow ? [{ id: 'recMoLegacyRow001', fields: { 'Tenancy Status': 'Live' } }] : [],
    transactions: [],
  };
}

// A fake Airtable on top of the shared mock: lists by RECORD_ID and keeps every PATCH, so a read-back sees it.
// failStatus(table, recId, n) returns the status to answer the n-th PATCH of that record with (0 = accept it).
async function fakeAirtable(page, fixtures, failStatus = () => 0) {
  const db = { [T.tenancies]: fixtures.tenancies, [T.tenants]: fixtures.tenants, [T.units]: fixtures.rentalUnits, [T.tasks]: fixtures.tasks,
              [T.legacy]: fixtures.legacyTenancies };
  const log = { patches: [], comments: [], db };
  await page.route('**/api.airtable.com/v0/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const [, , , table, recId, sub] = url.pathname.split('/');
    if (req.method() === 'POST' && sub === 'comments') {
      log.comments.push({ table, recId, text: req.postDataJSON().text });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"comMock"}' });
    }
    if (req.method() === 'PATCH' && recId) {
      const fields = req.postDataJSON().fields;
      const n = log.patches.filter(p => p.table === table && p.recId === recId).length;
      log.patches.push({ table, recId, fields });
      const status = failStatus(table, recId, n);
      if (status) {
        return route.fulfill({ status, contentType: 'application/json', body: '{"error":{"type":"INVALID_VALUE","message":"mock refusal"}}' });
      }
      const rec = db[table].find(r => r.id === recId);
      for (const [k, v] of Object.entries(fields)) { if (v === null) delete rec.fields[k]; else rec.fields[k] = v; }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rec) });
    }
    const formula = url.searchParams.get('filterByFormula') || '';
    if (req.method() === 'GET' && db[table] && /^(OR\()?RECORD_ID\(\)=/.test(formula)) {
      const ids = [...formula.matchAll(/RECORD_ID\(\)='(rec[A-Za-z0-9]+)'/g)].map(m => m[1]);
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ records: db[table].filter(r => ids.includes(r.id)) }) });
    }
    return route.fallback();
  });
  return log;
}

async function open(page, fixtures, failStatus) {
  await page.clock.install({ time: FROZEN_NOW });
  await loadDashboardWithFixtures(page, fixtures, 'cfv');
  await page.waitForFunction(() => [...document.querySelectorAll('#cfvTableBody tr')].some(tr => tr.textContent.includes('TEN-MO-1')),
    null, { timeout: 15000 });
  return fakeAirtable(page, fixtures, failStatus);
}

function row(page) {
  return page.locator('#cfvTableBody tr', { hasText: 'TEN-MO-1' });
}

// Press Moved out, set the date, read the box, press End tenancy, wait for the run to finish.
async function moveOut(page) {
  await row(page).getByRole('button', { name: 'Moved out' }).click();
  const box = page.locator('#cfvMovedOutBox');
  await expect(box).toContainText('What will change');
  await page.$eval('#cfvMoDate', (el, d) => { el.value = d; el.dispatchEvent(new Event('change')); }, MOVE_OUT);
  const preview = await box.locator('#cfvMoBody').innerText();
  await box.locator('#cfvMoGo').click();
  await expect(box.locator('#cfvMoCancel')).toHaveText('Close', { timeout: 10000 });
  return { box, preview, progress: await box.locator('#cfvMoProgress').innerText() };
}

const patchOf = (log, table, recId) => log.patches.filter(p => p.table === table && p.recId === recId).map(p => p.fields);

test.describe('Moved out ends a tenancy in one click, behind the gate', () => {
  test('a normal move-out ends the tenancy, makes the tenant Former, voids the unit and cancels the open task', async ({ page }) => {
    const fixtures = world();
    const log = await open(page, fixtures);
    const { box, preview, progress } = await moveOut(page);
    expect(preview).toContain('end date 18 May 2026');
    expect(preview).toContain('Arlo Pellow: marked Former');
    expect(preview).toContain('Unit 2 – 9 Example Row: set to Void');
    expect(progress).not.toContain('✗');

    expect(patchOf(log, T.tenancies, TENANCY)).toEqual([{ [F.endDate]: MOVE_OUT, [FIELDS.tenPayStatus]: null }]);
    expect(patchOf(log, T.tenants, TENANT)).toEqual([{ [F.tenantStatus]: 'Former', [F.currentUnit]: [] }]);
    expect(patchOf(log, T.units, UNIT)).toEqual([{ [F.unitStatus]: 'Void' }]);
    expect(patchOf(log, T.tasks, TASK_OPEN)).toEqual([{ [F.taskStatus]: 'Cancelled' }]);
    expect(patchOf(log, T.tasks, TASK_DONE), 'a finished task was touched').toEqual([]);
    expect(log.comments.some(c => c.recId === TASK_OPEN && /moved out on 18 May 2026/.test(c.text))).toBe(true);
    const summary = log.comments.find(c => c.table === T.tenancies && c.recId === TENANCY);
    expect(summary, 'no summary comment on the tenancy').toBeTruthy();
    expect(summary.text).toContain('moved out on 18 May 2026');
    expect(summary.text).toContain('Unit 2 – 9 Example Row: Void.');

    await box.locator('#cfvMoCancel').click();
    await expect(row(page), 'the ended tenancy is still listed as a cash flow void').toHaveCount(0, { timeout: 10000 });
  });

  test('another live tenancy on the unit: the tenancy ends but the unit is not voided, and the box says why', async ({ page }) => {
    const log = await open(page, world({ otherOnUnit: true }));
    const { preview, progress } = await moveOut(page);
    expect(preview).toContain('TEN-MO-2 is still live on it');
    expect(progress).not.toContain('✗');
    expect(patchOf(log, T.tenancies, TENANCY)).toHaveLength(1);
    expect(patchOf(log, T.units, UNIT), 'an occupied unit was voided').toEqual([]);
    expect(patchOf(log, T.tenancies, OTHER), 'the other tenancy was touched').toEqual([]);
  });

  test('a tenant still living in another of our houses stays Active and keeps that unit', async ({ page }) => {
    const log = await open(page, world({ livesElsewhere: true }));
    const { preview } = await moveOut(page);
    expect(preview).toContain('Arlo Pellow: stays Active, still a tenant at TEN-MO-3');
    expect(patchOf(log, T.tenants, TENANT)).toEqual([{ [F.currentUnit]: [UNIT_2] }]);
    expect(patchOf(log, T.units, UNIT)).toEqual([{ [F.unitStatus]: 'Void' }]);
    expect(patchOf(log, T.units, UNIT_2), 'the unit they still live in was touched').toEqual([]);
  });

  test('a legacy-table row on the unit does not count as a live tenancy', async ({ page }) => {
    const log = await open(page, world({ legacyRow: true }));
    const { preview } = await moveOut(page);
    expect(preview).not.toContain('still live on it');
    expect(patchOf(log, T.units, UNIT)).toEqual([{ [F.unitStatus]: 'Void' }]);
  });

  test('an agent-managed tenancy has no Moved out button', async ({ page }) => {
    await open(page, world({ payType: 'Agent-Managed' }));
    const buttons = await row(page).locator('button').allInnerTexts();
    expect(buttons.map(b => b.trim())).toContain('Mark Actioned');
    expect(buttons.map(b => b.trim())).not.toContain('Moved out');
  });

  test('a failed write stops the run, names the step, writes nothing after it and leaves a note saying where', async ({ page }) => {
    const log = await open(page, world(), (table) => (table === T.units ? 422 : 0));
    const { box, progress } = await moveOut(page);
    expect(progress).toContain('✓ Task cancelled: NEW TENANT RENT');
    expect(progress).toMatch(/✗ Unit 2 – 9 Example Row set to Void: .*mock refusal.*Stopped here/);
    expect(patchOf(log, T.tenants, TENANT), 'the tenant was written after a failed step').toEqual([]);
    expect(patchOf(log, T.tenancies, TENANCY), 'the tenancy was ended after a failed step').toEqual([]);
    const notes = log.comments.filter(c => c.table === T.tenancies);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('STOPPED at "Unit 2 – 9 Example Row set to Void"');
    expect(notes[0].text).toContain('Done before it: Task cancelled');
    expect(notes[0].text).toContain('Not confirmed: Unit 2 – 9 Example Row set to Void.');
    expect(notes[0].text).toMatch(/Not done: Arlo Pellow marked Former.*; Tenancy TEN-MO-1 ended/);
    // Nothing that hides the row was written, so pressing the button again can finish the job.
    await box.locator('#cfvMoCancel').click();
    await expect(row(page)).toHaveCount(1);
  });

  test('pressing Moved out again after a stopped run finishes the job without repeating the done steps', async ({ page }) => {
    const log = await open(page, world(), (table, recId, n) => (table === T.units && n === 0 ? 422 : 0));
    const first = await moveOut(page);
    expect(first.progress).toContain('Stopped here');
    await first.box.locator('#cfvMoCancel').click();
    await expect(page.locator('#cfvMovedOutBox')).toHaveCount(0);
    const second = await moveOut(page);
    expect(second.preview).toContain('No open tasks to cancel.');
    expect(second.progress).not.toContain('✗');
    expect(patchOf(log, T.tasks, TASK_OPEN), 'the task was cancelled twice').toHaveLength(1);
    expect(patchOf(log, T.units, UNIT), 'the unit write was not retried').toHaveLength(2);
    expect(patchOf(log, T.tenants, TENANT)).toEqual([{ [F.tenantStatus]: 'Former', [F.currentUnit]: [] }]);
    expect(patchOf(log, T.tenancies, TENANCY)).toEqual([{ [F.endDate]: MOVE_OUT, [FIELDS.tenPayStatus]: null }]);
  });

  test('two tenants leaving one unit on the same day: the second one frees the unit', async ({ page }) => {
    const log = await open(page, world({ otherOnUnit: true, otherEnd: TODAY }));
    const { preview } = await moveOut(page);
    expect(preview).not.toContain('still live on it');
    expect(patchOf(log, T.units, UNIT), 'the unit stayed Occupied with both tenants gone').toEqual([{ [F.unitStatus]: 'Void' }]);
  });

  test('a second live tenancy of the same tenant on the same unit keeps the tenant on the unit', async ({ page }) => {
    const log = await open(page, world({ alsoOnThisUnit: true }));
    const { preview } = await moveOut(page);
    expect(preview).toContain('Arlo Pellow: stays Active, still a tenant at TEN-MO-3');
    expect(patchOf(log, T.tenants, TENANT), 'the tenant was unlinked from the unit they still live in').toEqual([]);
    expect(patchOf(log, T.units, UNIT)).toEqual([]);
  });

  test('records changed while the box was open: nothing is written', async ({ page }) => {
    const log = await open(page, world());
    await row(page).getByRole('button', { name: 'Moved out' }).click();
    const box = page.locator('#cfvMovedOutBox');
    await expect(box).toContainText('Unit 2 – 9 Example Row: set to Void');
    // Someone moves a new tenant onto the unit while the box sits open.
    log.db[T.tenancies].push(tenancy(OTHER, 'TEN-MO-2', 'Quarrie', 'In Payment', UNIT));
    log.db[T.units].find(u => u.id === UNIT).fields[F.unitTenancies].push(OTHER);
    await box.locator('#cfvMoGo').click();
    await expect(box.locator('#cfvMoCancel')).toHaveText('Close', { timeout: 10000 });
    await expect(box.locator('#cfvMoProgress')).toContainText('Something changed in Airtable since this box opened');
    expect(log.patches, 'a write went out on a plan that was out of date').toEqual([]);
  });

  test('a future move-out date is refused before anything is written', async ({ page }) => {
    const log = await open(page, world());
    await row(page).getByRole('button', { name: 'Moved out' }).click();
    const box = page.locator('#cfvMovedOutBox');
    await expect(box).toContainText('What will change');
    await page.$eval('#cfvMoDate', (el) => { el.value = '2026-05-25'; el.dispatchEvent(new Event('change')); });
    await expect(box).toContainText('The move-out date cannot be in the future.');
    await expect(box.locator('#cfvMoGo')).toBeDisabled();
    expect(log.patches).toEqual([]);
  });

  test('a busy-moment 429 from Airtable is retried, not a stopped run', async ({ page }) => {
    const log = await open(page, world(), (table, recId, n) => (table === T.tenancies && n === 0 ? 429 : 0));
    const { progress } = await moveOut(page);
    expect(progress).not.toContain('✗');
    expect(patchOf(log, T.tenancies, TENANCY), 'the write was not retried').toHaveLength(2);
    expect(log.db[T.tenancies].find(r => r.id === TENANCY).fields[F.endDate]).toBe(MOVE_OUT);
  });
});
