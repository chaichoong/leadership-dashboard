// Strategy push — the "N tasks already linked" count on an existing project.
//
// The defect this pins (found 6 Aug 2026): the count was ALWAYS 0, so the
// approval modal told you an existing project had no tasks on it no matter how
// many it really had. Two independent faults in one block, either enough alone:
//
//   1. It queried the Tasks table with FIND(projectId, ARRAYJOIN({Projects})).
//      ARRAYJOIN over a LINK field joins primary-field NAMES, never record IDs,
//      so that filter matches nothing and returns 200 OK with an empty list.
//      The identical trap is already documented on fetchOpenTasksForProject.
//   2. It sent pageSize=200. Airtable's maximum is 100, so the request came
//      back HTTP 422, airtableFetch threw, and the catch left the count at 0.
//
// Fault 2 masked fault 1 — the request never even succeeded.
//
// The fix counts the project's own 'Linked Tasks' field, captured when the
// project records are fetched for collaborator inheritance. No second request.
//
// Back-test: restore either fault and this spec fails, because a 0 count makes
// the modal print the bare fallback with no number in it.
//
// Airtable + the AI proxy are mocked (page.route) so this runs without a PAT.

const { test, expect } = require('@playwright/test');

const PAGE = '/os/strategy/index.html';

const T = {
  businesses: 'tblpqkvWJJo8Uu25q',
  objStrat: 'tblEBvFw8DonwxzGh',
  projects: 'tblHrpTMd5LNYn8v1',
  tasks: 'tblqB8b22hKBL4PF1',
  teamMembers: 'tblco0p2OnlLQVAX7',
};

const F = {
  osQuarter: 'fldQl2h3gCxYacE1k',
  osYear: 'fldARVrVpuCWxufQO',
  osBusiness: 'fldLt6uDJ2xKCMlj2',
  osQp1: 'fldMRcqBdI6sixquu',
  osQp1Stone1: 'fldA66Xm4zVoClUva',
  qp1LinkedProject: 'fldtBMn2nwhMBEtwh',  // qpDetails[0].linkedProject
  projName: 'fldBg0rQy0FrOAkRN',
  projLinkedTasks: 'fldbXYUzJXqrRjfyn',   // 'Linked Tasks' — inverse of Task.Projects
  projCollabs: 'fldN5l2H4WCsM0S3x',
};

const BIZ_ID = 'recBizCount1';
const PLAN_ID = 'recPlanCount1';
const PROJ_ID = 'recProjCount1';
const PROJ_NAME = 'Existing project with three tasks';

// Three linked tasks. The number is what the modal must report.
const LINKED_TASK_IDS = ['recTaskA', 'recTaskB', 'recTaskC'];

function plan() {
  return {
    id: PLAN_ID, createdTime: '2026-07-01T00:00:00.000Z',
    fields: {
      [F.osQuarter]: 'Q2', [F.osYear]: '2026', [F.osBusiness]: [BIZ_ID],
      [F.osQp1]: PROJ_NAME,
      // The record-ID link is dedup signal #1 — it makes the project "already exist".
      [F.qp1LinkedProject]: [PROJ_ID],
      [F.osQp1Stone1]: 'A stone that must not be pushed',
    },
  };
}

function projectRecord() {
  return {
    id: PROJ_ID,
    fields: {
      [F.projName]: PROJ_NAME,
      [F.projLinkedTasks]: LINKED_TASK_IDS,
      [F.projCollabs]: [],
    },
  };
}

async function mockAirtable(page, seen) {
  await page.route('**/api.airtable.com/**', async (route) => {
    const url = decodeURIComponent(route.request().url().replace(/\+/g, ' '));
    const method = route.request().method();
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    seen.push({ method, url });

    if (method !== 'GET') return json({ id: 'recW', fields: {} });

    if (url.includes(T.businesses)) {
      return json({ records: [{ id: BIZ_ID, fields: { 'Business Name': 'Count Test Co' } }] });
    }
    if (url.includes(`${T.objStrat}/${PLAN_ID}`)) return json(plan());
    if (url.includes(T.objStrat)) {
      if (url.includes('{Quarter} = "Q2"')) return json({ records: [plan()] });
      return json({ records: [] });
    }
    if (url.includes(T.projects)) return json({ records: [projectRecord()] });

    // Behave like the real API: reject pageSize over 100 exactly as Airtable does,
    // so the old code's 422 is reproduced rather than papered over by a kind mock.
    if (url.includes(T.tasks)) {
      const m = url.match(/pageSize=(\d+)/);
      if (m && Number(m[1]) > 100) {
        return json({ error: { type: 'INVALID_PAGE_SIZE_ARGUMENT', message: 'Page size argument should be between 0 and 100' } }, 422);
      }
      return json({ records: [] });
    }
    if (url.includes(T.teamMembers)) return json({ records: [] });
    return json({ records: [] });
  });

  await page.route('**/*.workers.dev/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.addInitScript(() => {
    localStorage.setItem('_dlr_pat', 'pat_test_mock_token_for_playwright');
  });
}

test.describe('Strategy push — existing-project task count', () => {
  test('reports the real number of linked tasks, and never asks Airtable for an illegal page size', async ({ page }) => {
    const seen = [];
    await mockAirtable(page, seen);
    await page.goto(PAGE);
    await page.waitForFunction(
      () => typeof allBusinessesLocal !== 'undefined' && allBusinessesLocal.length > 0,
      null, { timeout: 20000 });

    await page.evaluate((biz) => {
      document.getElementById('businessSel').value = biz;
      document.getElementById('quarterSel').value = 'Q2';
      document.getElementById('yearSel').value = '2026';
      return loadRecord();
    }, BIZ_ID);
    await page.waitForFunction(() => currentRecord && currentRecord.id, null, { timeout: 20000 });

    await page.evaluate(() => pushProjectsManually());
    await expect(page.locator('#pushModal')).toBeVisible({ timeout: 30000 });

    const modalText = await page.locator('#pushModal').innerText();

    // The whole point: the real count, not 0. Three linked tasks → "3 tasks".
    expect(modalText).toContain('3 tasks already linked');
    // The 0-count fallback prints this sentence WITHOUT a number in front of it.
    // Guard against silently regressing to it.
    expect(modalText).not.toMatch(/(^|\n)\s*No changes will be made to this project\./);

    // No request may exceed Airtable's page-size ceiling. This is what 422'd.
    const oversized = seen.filter(r => {
      const m = r.url.match(/pageSize=(\d+)/);
      return m && Number(m[1]) > 100;
    });
    expect(oversized).toEqual([]);
  });
});
