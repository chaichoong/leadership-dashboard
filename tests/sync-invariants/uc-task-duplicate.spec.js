// Invariant: one open UC verification task per tenancy per rent month.
// Bug: the dedupe test was an exact match on the full task name, which embeds the
//      computed rent due date. Change a tenancy's "Due Day of Month" (or its rent)
//      after a task exists and the name changes, the exact match misses, and a
//      SECOND task is created for a rent date that no longer exists. Nothing ever
//      retired the stale one. Found 1 Aug 2026: Ryan Lambert (one tenancy,
//      recO2ljRrTjDD0Yr8, Due Day 6) held both "due 5 August 2026" and
//      "due 6 August 2026", so Mica was queued to ring UC twice for one payment.
// Rule: when an OPEN UC task already links this tenancy for the SAME rent month,
//       PATCH it onto the current date. Only a different month is a new task.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, FIELDS } = require('./helpers');

const TASKS_TABLE = 'tblqB8b22hKBL4PF1';
const TASK_NAME_FIELD = 'fldgFjGBw6bTKJFCD';
const TASK_STATUS_FIELD = 'fldx4qCw17UfrKpaN';
const TASK_TENANCY_FIELD = 'fldmne4RYJU22ICub';
const TASK_DUE_FIELD = 'fld7XP8w8kbxfETV4';

const DUE_DAY = 6;
const RENT = 524.9;
const TENANT = 'Ryan Lambert';
const TENANCY_ID = 'recUCTenancy1';

// Mirror ucCalcNextDueDate: the next occurrence of DUE_DAY strictly after today.
function nextRentDue() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let d = new Date(today.getFullYear(), today.getMonth(), DUE_DAY);
  if (d <= today) d = new Date(today.getFullYear(), today.getMonth() + 1, DUE_DAY);
  return d;
}

function taskName(rentDue) {
  const dueStr = rentDue.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `UC verification: ${TENANT}, £${RENT.toFixed(2)} due ${dueStr}`;
}

// One UC tenancy that qualifies for a check, plus its tenant.
function ucFixtures() {
  return {
    tenancies: [{
      id: TENANCY_ID,
      fields: {
        [FIELDS.tenRef]: 'TEN-UC-1',
        [FIELDS.tenRent]: RENT,
        [FIELDS.tenDueDay]: DUE_DAY,
        [FIELDS.tenPayStatus]: 'In Payment',
        [FIELDS.tenStatus]: 'Active',
        [FIELDS.tenUnit]: ['recUnitUC'],
        [FIELDS.tenLinkedTenant]: ['recUCTenant'],
        [FIELDS.tenUnitRef]: 'Unit 1 – 5 Dalham Place',
        [FIELDS.tenProperty]: ['5 Dalham Place'],
        [FIELDS.tenStartDate]: '2025-01-01',
      },
    }],
    tenants: [{
      id: 'recUCTenant',
      fields: { [FIELDS.tenantName]: TENANT, [FIELDS.tenantPayType]: 'Universal Credit' },
    }],
  };
}

// Route every Airtable call. `existingTask` is the one UC task already in the base.
async function mockAirtable(page, existingTask, sink) {
  const fx = ucFixtures();

  await page.route('**/api.airtable.com/v0/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();

    if (method === 'POST' && url.includes(TASKS_TABLE)) {
      sink.posts.push(JSON.parse(req.postData() || '{}'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'recNewTask', fields: {} }) });
      return;
    }

    if (method === 'PATCH' && url.includes(TASKS_TABLE)) {
      sink.patches.push({ url, body: JSON.parse(req.postData() || '{}') });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'recPatched', fields: {} }) });
      return;
    }

    if (method !== 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":[]}' });
      return;
    }

    const tableMatch = url.match(/\/v0\/[^/]+\/([^?/]+)/);
    const tableId = tableMatch ? tableMatch[1] : null;

    let records = [];
    if (tableId === 'tblN51a88qTDB6iMH') records = fx.tenancies;
    else if (tableId === 'tblX4elTuu01gwBYh') records = fx.tenants;
    else if (tableId === TASKS_TABLE) records = existingTask ? [existingTask] : [];

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records }) });
  });
}

async function runEngine(page) {
  await page.addInitScript((pat) => { localStorage.setItem('_dlr_pat', pat); }, MOCK_PAT);
  await page.goto('/');
  await page.waitForFunction(() => typeof window.runArrearsEngine === 'function', null, { timeout: 15000 });
  await page.evaluate(async () => {
    allTenancies = allTenancies || [];
    await window.runArrearsEngine();
  });
  await page.waitForTimeout(1500);
}

test.describe('UC verification tasks — no duplicates per rent month', () => {

  test('a shifted rent day updates the open task instead of creating a second', async ({ page }) => {
    const rentDue = nextRentDue();
    // The stale task: same tenancy, same month, day 5 instead of day 6.
    const staleDue = new Date(rentDue.getFullYear(), rentDue.getMonth(), DUE_DAY - 1);
    const stale = {
      id: 'recStaleUC',
      fields: {
        [TASK_NAME_FIELD]: taskName(staleDue),
        [TASK_STATUS_FIELD]: 'Upcoming',
        [TASK_TENANCY_FIELD]: [TENANCY_ID],
        [TASK_DUE_FIELD]: '2026-07-29',
      },
    };

    const sink = { posts: [], patches: [] };
    await mockAirtable(page, stale, sink);
    await runEngine(page);

    // The bug: a POST here is the duplicate.
    expect(sink.posts).toHaveLength(0);
    expect(sink.patches).toHaveLength(1);
    expect(sink.patches[0].url).toContain('recStaleUC');
    expect(sink.patches[0].body.fields[TASK_NAME_FIELD]).toBe(taskName(rentDue));
    // Mica's own working status must survive the correction.
    expect(sink.patches[0].body.fields).not.toHaveProperty(TASK_STATUS_FIELD);
  });

  test('an open task for a different rent month is left alone and a new one is created', async ({ page }) => {
    const rentDue = nextRentDue();
    // Previous month's check, still open because it was never done.
    const priorMonth = new Date(rentDue.getFullYear(), rentDue.getMonth() - 1, DUE_DAY);
    const prior = {
      id: 'recPriorUC',
      fields: {
        [TASK_NAME_FIELD]: taskName(priorMonth),
        [TASK_STATUS_FIELD]: 'Overdue',
        [TASK_TENANCY_FIELD]: [TENANCY_ID],
        [TASK_DUE_FIELD]: '2026-06-29',
      },
    };

    const sink = { posts: [], patches: [] };
    await mockAirtable(page, prior, sink);
    await runEngine(page);

    expect(sink.patches).toHaveLength(0);
    expect(sink.posts).toHaveLength(1);
    expect(sink.posts[0].fields[TASK_NAME_FIELD]).toBe(taskName(rentDue));
  });

  test('the exact same task already present creates and updates nothing', async ({ page }) => {
    const rentDue = nextRentDue();
    const current = {
      id: 'recCurrentUC',
      fields: {
        [TASK_NAME_FIELD]: taskName(rentDue),
        [TASK_STATUS_FIELD]: 'Upcoming',
        [TASK_TENANCY_FIELD]: [TENANCY_ID],
        [TASK_DUE_FIELD]: '2026-07-30',
      },
    };

    const sink = { posts: [], patches: [] };
    await mockAirtable(page, current, sink);
    await runEngine(page);

    expect(sink.posts).toHaveLength(0);
    expect(sink.patches).toHaveLength(0);
  });
});
