// Quarter close — the freeze-first / carry-second protocol.
//
// The invariant this guards (Kevin's rule 8, 31 Jul 2026 strategy session):
// a carried task belongs to BOTH quarters. If the old quarter's snapshot
// (Status Override, KPI at Close, Progress at Close, Closed On, Closing Note)
// is not frozen before the carry, a task finished months later raises the old
// quarter's completion percentage and a missed quarter starts reading as a
// win. So:
//   1. The snapshot PATCH on the project must land BEFORE any task re-link.
//   2. A carried task keeps its old project link — the new quarter's project
//      is ADDED, never swapped in.
//   3. If the snapshot PATCH fails, the project's tasks are NOT carried.
//
// Airtable is mocked (page.route on api.airtable.com) so this runs without a PAT.

const { test, expect } = require('@playwright/test');

const PAGE = '/os/strategy/index.html';

// Table IDs (js/config.js TABLES)
const T = {
  businesses: 'tblpqkvWJJo8Uu25q',
  objStrat: 'tblEBvFw8DonwxzGh',
  projects: 'tblHrpTMd5LNYn8v1',
  tasks: 'tblqB8b22hKBL4PF1',
  mainMethods: 'tbl065D58MBEJhjlp',
  teamMembers: 'tblco0p2OnlLQVAX7',
};

// Field IDs (js/config.js OBJSTRAT + strategy.js PROJ_F / PROJ_CLOSE_F / TASK_F)
const F = {
  // Objective & Strategy
  osQuarter: 'fldQl2h3gCxYacE1k',
  osYear: 'fldARVrVpuCWxufQO',
  osBusiness: 'fldLt6uDJ2xKCMlj2',
  osQp1: 'fldMRcqBdI6sixquu',
  osQp1LinkedProject: 'fldtBMn2nwhMBEtwh',
  // Projects
  projName: 'fldiMZICg1KOORpte',
  projStatusOverride: 'fldgA0nMgLx5jijyG',
  projClosedOn: 'fldzGI0ywBTpOK2dy',
  projKpiAtClose: 'fld59dgl4EoQmrXT6',
  projProgressAtClose: 'fldHZWpvuYF1xsnfs',
  projClosingNote: 'fldEx9EOsPeqpJ2gy',
  projKpiCurrent: 'fldB1QJDUsukxKzjQ',
  projKpiName: 'fldABYFMf2yBKWdlD',
  projKpiTarget: 'fldaI0voHia91SYZz',
  projTotalTasks: 'fldtw6NQZ8CSF3RXi',
  projCompletedTasks: 'fld7IDjY0xB4JGBfn',
  projLinkedTasks: 'fldbXYUzJXqrRjfyn',
  // Tasks
  taskName: 'fldgFjGBw6bTKJFCD',
  taskStatus: 'fldx4qCw17UfrKpaN',
  taskProjects: 'fldBg0rQy0FrOAkRN',
};

const BIZ_ID = 'recBizClose1';
const PLAN_Q2_ID = 'recPlanQ2Close';
const PLAN_Q3_ID = 'recPlanQ3Close';
const PROJ_OLD = 'recProjOldQ2';
const PROJ_NEXT = 'recProjNextQ3';
const TASK_OPEN = 'recTaskOpen1';

function planQ2() {
  return {
    id: PLAN_Q2_ID, createdTime: '2026-04-01T00:00:00.000Z',
    fields: {
      [F.osQuarter]: 'Q2', [F.osYear]: '2026',
      [F.osBusiness]: [BIZ_ID],
      [F.osQp1]: 'Test project — quarter close',
      [F.osQp1LinkedProject]: [PROJ_OLD],
    },
  };
}

function planQ3() {
  return {
    id: PLAN_Q3_ID, createdTime: '2026-07-01T00:00:00.000Z',
    fields: {
      [F.osQuarter]: 'Q3', [F.osYear]: '2026',
      [F.osBusiness]: [BIZ_ID],
      [F.osQp1LinkedProject]: [PROJ_NEXT],
    },
  };
}

function projectOld() {
  return {
    id: PROJ_OLD, createdTime: '2026-04-01T00:00:00.000Z',
    fields: {
      [F.projName]: 'Close Me — Q2 test project',
      [F.projKpiName]: 'Test KPI',
      [F.projKpiTarget]: 100,
      [F.projKpiCurrent]: 40,
      [F.projTotalTasks]: 4,
      [F.projCompletedTasks]: 3,
      [F.projLinkedTasks]: [TASK_OPEN, 'recTaskDone1'],
    },
  };
}

function projectNext() {
  return {
    id: PROJ_NEXT, createdTime: '2026-07-01T00:00:00.000Z',
    fields: { [F.projName]: 'Next Quarter — Q3 target project' },
  };
}

function openTask() {
  return {
    id: TASK_OPEN, createdTime: '2026-05-01T00:00:00.000Z',
    fields: {
      [F.taskName]: 'Still open — must carry',
      [F.taskStatus]: 'Upcoming',
      [F.taskProjects]: [PROJ_OLD],
    },
  };
}

function completedTask() {
  return {
    id: 'recTaskDone1', createdTime: '2026-05-01T00:00:00.000Z',
    fields: {
      [F.taskName]: 'Already finished — must NOT carry',
      [F.taskStatus]: 'Completed',
      [F.taskProjects]: [PROJ_OLD],
    },
  };
}

// Mocks the Airtable API and records every write (PATCH/POST) in arrival
// order so the test can assert on ordering. opts.failSnapshot makes the
// project snapshot PATCH return 500.
async function mockAirtable(page, writes, opts = {}) {
  await page.route('**/api.airtable.com/**', async (route) => {
    // URLSearchParams encodes spaces as '+', which decodeURIComponent leaves
    // alone — normalise both so filter-formula matching below sees real spaces.
    const url = decodeURIComponent(route.request().url().replace(/\+/g, ' '));
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (method === 'PATCH' || method === 'POST') {
      const entry = { method, url, body: JSON.parse(route.request().postData() || '{}') };
      // The write log is the whole point of this spec — capture before responding.
      if (url.includes(`${T.projects}/${PROJ_OLD}`) && method === 'PATCH') {
        writes.push({ kind: 'project-snapshot', ...entry });
        if (opts.failSnapshot) return json({ error: 'INTERNAL_SERVER_ERROR' }, 500);
        return json({ id: PROJ_OLD, fields: entry.body.fields || {} });
      }
      if (url.includes('/comments') && method === 'POST') {
        writes.push({ kind: 'comment', ...entry });
        return json({ id: 'comMock1', text: entry.body.text });
      }
      if (url.includes(`${T.tasks}/${TASK_OPEN}`) && method === 'PATCH') {
        writes.push({ kind: 'task-carry', ...entry });
        return json({ id: TASK_OPEN, fields: entry.body.fields || {} });
      }
      writes.push({ kind: 'other-write', ...entry });
      return json({ id: 'recMockWrite', fields: {} });
    }

    // GET routes
    if (url.includes(T.businesses)) {
      return json({ records: [{ id: BIZ_ID, fields: { 'Business Name': 'Close Test Co' } }] });
    }
    if (url.includes(`${T.objStrat}/${PLAN_Q2_ID}`)) return json(planQ2());
    if (url.includes(T.objStrat)) {
      if (url.includes('{Quarter} = "Q2"')) return json({ records: [planQ2()] });
      if (url.includes('{Quarter} = "Q3"')) return json({ records: [planQ3()] });
      return json({ records: [] });
    }
    if (url.includes(`${T.tasks}/${TASK_OPEN}`)) return json(openTask());
    if (url.includes(T.tasks)) {
      // Honour the status filter like Airtable would. If a regression drops
      // the {Status}!="Completed" clause, the completed task leaks into the
      // preview and the single-locator assertions below fail loudly.
      const excludesCompleted = url.includes('{Status}!="Completed"');
      return json({ records: excludesCompleted ? [openTask()] : [openTask(), completedTask()] });
    }
    if (url.includes(T.projects)) {
      const records = [];
      if (url.includes(PROJ_OLD)) records.push(projectOld());
      if (url.includes(PROJ_NEXT)) records.push(projectNext());
      return json({ records });
    }
    if (url.includes(T.mainMethods)) return json({ records: [] });
    if (url.includes(T.teamMembers)) return json({ records: [] });
    return json({ records: [] });
  });
  await page.route('**/*.workers.dev/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.addInitScript(() => {
    localStorage.setItem('_dlr_pat', 'pat_test_mock_token_for_playwright');
  });
}

async function loadQ2Plan(page) {
  await page.goto(PAGE);
  await page.waitForFunction(() => typeof allBusinessesLocal !== 'undefined' && allBusinessesLocal.length > 0, null, { timeout: 20000 });
  await page.evaluate((bizId) => {
    document.getElementById('businessSel').value = bizId;
    document.getElementById('quarterSel').value = 'Q2';
    document.getElementById('yearSel').value = '2026';
    return loadRecord();
  }, BIZ_ID);
  await page.waitForFunction(() => currentRecord && currentRecord.id, null, { timeout: 20000 });
}

async function openCloseModal(page) {
  await page.evaluate(() => openQuarterClose());
  await expect(page.locator('#qcModal')).toBeVisible({ timeout: 20000 });
}

test.describe('Quarter close — freeze first, carry second', () => {
  test('snapshot is written before any task is re-linked, and the carried task keeps its old link', async ({ page }) => {
    const writes = [];
    await mockAirtable(page, writes);
    await loadQ2Plan(page);
    await openCloseModal(page);

    // Preview sanity: project shown, KPI pre-filled from KPI Current, the
    // open task defaults to carrying into the next quarter's project.
    await expect(page.locator('.qc-project')).toContainText('Close Me — Q2 test project');
    await expect(page.locator('.qc-kpi')).toHaveValue('40');
    await expect(page.locator('.qc-progress')).toHaveValue('75');
    await expect(page.locator('.qc-closedon')).toHaveValue('2026-06-30');
    await expect(page.locator('.qc-task-row')).toHaveCount(1); // completed task filtered out server-side
    await expect(page.locator('.qc-carry-sel')).toHaveValue(PROJ_NEXT);

    await page.click('#qcApproveBtn');
    await page.waitForFunction(() => {
      const bar = document.getElementById('statusBar');
      return bar && /carried/.test(bar.textContent || '');
    }, null, { timeout: 30000 });

    // THE INVARIANT — write order. The snapshot PATCH must exist and must
    // precede every task re-link. The comment sits between them.
    const snapIdx = writes.findIndex(w => w.kind === 'project-snapshot');
    const carryIdx = writes.findIndex(w => w.kind === 'task-carry');
    expect(snapIdx, 'snapshot PATCH never happened').toBeGreaterThanOrEqual(0);
    expect(carryIdx, 'task carry PATCH never happened').toBeGreaterThanOrEqual(0);
    expect(snapIdx, 'task was re-linked BEFORE the quarter was frozen').toBeLessThan(carryIdx);

    // The snapshot is complete: all five protocol fields in ONE atomic write,
    // so a task can never be carried against a half-frozen project.
    const snap = writes[snapIdx].body.fields;
    expect(snap[F.projStatusOverride]).toBe('Off-Track'); // KPI 40 < 100 and tasks 3/4 → honest default
    expect(snap[F.projKpiAtClose]).toBe(40);
    expect(snap[F.projProgressAtClose]).toBe(75);
    expect(snap[F.projClosedOn]).toBe('2026-06-30');
    expect(String(snap[F.projClosingNote])).toContain('Q2');

    // The permanent record comment is written after the snapshot, before the carry.
    const commentIdx = writes.findIndex(w => w.kind === 'comment');
    expect(commentIdx).toBeGreaterThan(snapIdx);
    expect(commentIdx).toBeLessThan(carryIdx);

    // THE CARRY — the next quarter's project is ADDED; the old link survives.
    const carried = writes[carryIdx].body.fields[F.taskProjects];
    expect(carried).toContain(PROJ_OLD);
    expect(carried).toContain(PROJ_NEXT);
    expect(carried.length).toBe(2);

    // Three counts reported.
    await expect(page.locator('#statusBar')).toContainText('1 carried');
    await expect(page.locator('#statusBar')).toContainText('1 closed');
    await expect(page.locator('#statusBar')).toContainText('0 parked');
  });

  test('if the snapshot write fails, no task is carried', async ({ page }) => {
    const writes = [];
    await mockAirtable(page, writes, { failSnapshot: true });
    await loadQ2Plan(page);
    await openCloseModal(page);

    await page.click('#qcApproveBtn');
    await page.waitForFunction(() => {
      const bar = document.getElementById('statusBar');
      return bar && /failed/i.test(bar.textContent || '');
    }, null, { timeout: 30000 });

    // The freeze failed, so carrying would create exactly the bug the
    // protocol exists to prevent. Nothing else may have been written.
    expect(writes.filter(w => w.kind === 'task-carry').length).toBe(0);
    expect(writes.filter(w => w.kind === 'comment').length).toBe(0);
  });

  // Pins the two behaviours the single-project tests cannot see:
  // (i) carry defaults match by QP SLOT, not by first-option order — old QP2's
  //     tasks default to new QP2 even when a new QP1 project exists;
  // (ii) an already-closed project is carry-only — its frozen snapshot is
  //      NEVER re-written, but stranded open tasks can still be re-linked.
  test('slot-matched carry defaults, and carry-only for an already-closed project', async ({ page }) => {
    const QP2_LINK = 'fldEdCkinxZZuDVw8';   // qpDetails[1].linkedProject
    const QP3_LINK = 'fldtQWnYYi9X1dah9';   // qpDetails[2].linkedProject
    const P_SLOT2 = 'recProjSlot2Open';
    const P_CLOSED = 'recProjSlot3Closed';
    const NEXT_S1 = 'recNextSlot1';
    const NEXT_S2 = 'recNextSlot2';
    const TASK_S2 = 'recTaskSlot2Open';
    const TASK_STR = 'recTaskStranded';

    const mkTask = (id, name, projs) => ({ id, createdTime: '2026-05-01T00:00:00.000Z', fields: {
      [F.taskName]: name, [F.taskStatus]: 'Upcoming', [F.taskProjects]: projs } });
    const tasksById = {
      [TASK_S2]: mkTask(TASK_S2, 'Open on slot-2 project', [P_SLOT2]),
      [TASK_STR]: mkTask(TASK_STR, 'Stranded on closed project', [P_CLOSED]),
    };
    const projectsById = {
      [P_SLOT2]: { id: P_SLOT2, createdTime: '2026-04-01T00:00:00.000Z', fields: {
        [F.projName]: 'Slot 2 — still open', [F.projKpiTarget]: 100, [F.projKpiCurrent]: 10,
        [F.projTotalTasks]: 1, [F.projCompletedTasks]: 0, [F.projLinkedTasks]: [TASK_S2] } },
      [P_CLOSED]: { id: P_CLOSED, createdTime: '2026-04-01T00:00:00.000Z', fields: {
        [F.projName]: 'Slot 3 — closed in an earlier run', [F.projClosedOn]: '2026-06-30',
        [F.projStatusOverride]: 'Off-Track', [F.projKpiAtClose]: 5, [F.projProgressAtClose]: 20,
        [F.projLinkedTasks]: [TASK_STR] } },
      [NEXT_S1]: { id: NEXT_S1, createdTime: '2026-07-01T00:00:00.000Z', fields: { [F.projName]: 'Q3 slot 1' } },
      [NEXT_S2]: { id: NEXT_S2, createdTime: '2026-07-01T00:00:00.000Z', fields: { [F.projName]: 'Q3 slot 2' } },
    };
    const plan2 = { id: PLAN_Q2_ID, createdTime: '2026-04-01T00:00:00.000Z', fields: {
      [F.osQuarter]: 'Q2', [F.osYear]: '2026', [F.osBusiness]: [BIZ_ID],
      [QP2_LINK]: [P_SLOT2], [QP3_LINK]: [P_CLOSED] } };
    const plan3 = { id: PLAN_Q3_ID, createdTime: '2026-07-01T00:00:00.000Z', fields: {
      [F.osQuarter]: 'Q3', [F.osYear]: '2026', [F.osBusiness]: [BIZ_ID],
      [F.osQp1LinkedProject]: [NEXT_S1], [QP2_LINK]: [NEXT_S2] } };

    const writes = [];
    await page.route('**/api.airtable.com/**', async (route) => {
      const url = decodeURIComponent(route.request().url().replace(/\+/g, ' '));
      const method = route.request().method();
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (method === 'PATCH' || method === 'POST') {
        const entry = { method, url, body: JSON.parse(route.request().postData() || '{}') };
        const projHit = Object.keys(projectsById).find(id => url.includes(`${T.projects}/${id}`));
        if (projHit && method === 'PATCH') { writes.push({ kind: 'project-snapshot', id: projHit, ...entry }); return json({ id: projHit, fields: entry.body.fields || {} }); }
        if (url.includes('/comments')) { writes.push({ kind: 'comment', ...entry }); return json({ id: 'comX', text: entry.body.text }); }
        const taskHit = Object.keys(tasksById).find(id => url.includes(`${T.tasks}/${id}`));
        if (taskHit && method === 'PATCH') { writes.push({ kind: 'task-carry', id: taskHit, ...entry }); return json({ id: taskHit, fields: entry.body.fields || {} }); }
        writes.push({ kind: 'other-write', ...entry });
        return json({ id: 'recW', fields: {} });
      }
      if (url.includes(T.businesses)) return json({ records: [{ id: BIZ_ID, fields: { 'Business Name': 'Close Test Co' } }] });
      if (url.includes(`${T.objStrat}/${PLAN_Q2_ID}`)) return json(plan2);
      if (url.includes(T.objStrat)) {
        if (url.includes('{Quarter} = "Q2"')) return json({ records: [plan2] });
        if (url.includes('{Quarter} = "Q3"')) return json({ records: [plan3] });
        return json({ records: [] });
      }
      const taskGet = Object.keys(tasksById).find(id => url.includes(`${T.tasks}/${id}`));
      if (taskGet) return json(tasksById[taskGet]);
      if (url.includes(T.tasks)) {
        const excludesCompleted = url.includes('{Status}!="Completed"');
        const matches = Object.keys(tasksById).filter(id => url.includes(id)).map(id => tasksById[id]);
        return json({ records: excludesCompleted ? matches : matches });
      }
      if (url.includes(T.projects)) {
        return json({ records: Object.keys(projectsById).filter(id => url.includes(id)).map(id => projectsById[id]) });
      }
      return json({ records: [] });
    });
    await page.route('**/*.workers.dev/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.addInitScript(() => { localStorage.setItem('_dlr_pat', 'pat_test_mock_token_for_playwright'); });

    await loadQ2Plan(page);
    await openCloseModal(page);

    // (i) Slot matching: the open slot-2 project's task defaults to the
    // slot-2 next project, NOT the first option (Q3 slot 1).
    const openPanel = page.locator(`.qc-project[data-project-id="${P_SLOT2}"]`);
    await expect(openPanel.locator('.qc-carry-sel')).toHaveValue(NEXT_S2);

    // (ii) Carry-only: the closed project shows no snapshot inputs, keeps its
    // badge, and lists the stranded task. No next project exists at slot 3,
    // so it defaults to Park — carry it into Q3 slot 1 by hand.
    const closedPanel = page.locator(`.qc-project[data-carry-only="1"]`);
    await expect(closedPanel).toContainText('Already closed on 2026-06-30');
    await expect(closedPanel.locator('.qc-status')).toHaveCount(0);
    await expect(closedPanel.locator('.qc-carry-sel')).toHaveValue('');
    await closedPanel.locator('.qc-carry-sel').selectOption(NEXT_S1);

    await page.click('#qcApproveBtn');
    await page.waitForFunction(() => {
      const bar = document.getElementById('statusBar');
      return bar && /carried/.test(bar.textContent || '');
    }, null, { timeout: 30000 });

    // The frozen snapshot is NEVER re-written: exactly one snapshot PATCH,
    // and it targets the open project.
    const snaps = writes.filter(w => w.kind === 'project-snapshot');
    expect(snaps.length).toBe(1);
    expect(snaps[0].id).toBe(P_SLOT2);

    // Both carries happened, each keeping its old link, each AFTER the snapshot.
    const snapIdx = writes.findIndex(w => w.kind === 'project-snapshot');
    const carryS2 = writes.find(w => w.kind === 'task-carry' && w.id === TASK_S2);
    const carryStr = writes.find(w => w.kind === 'task-carry' && w.id === TASK_STR);
    expect(carryS2.body.fields[F.taskProjects]).toEqual([P_SLOT2, NEXT_S2]);
    expect(carryStr.body.fields[F.taskProjects]).toEqual([P_CLOSED, NEXT_S1]);
    expect(writes.indexOf(carryS2)).toBeGreaterThan(snapIdx);

    await expect(page.locator('#statusBar')).toContainText('2 carried · 1 closed · 0 parked');
  });

  test('parking a task leaves it untouched', async ({ page }) => {
    const writes = [];
    await mockAirtable(page, writes);
    await loadQ2Plan(page);
    await openCloseModal(page);

    // Park the open task instead of carrying it.
    await page.selectOption('.qc-carry-sel', '');
    await page.click('#qcApproveBtn');
    await page.waitForFunction(() => {
      const bar = document.getElementById('statusBar');
      return bar && /parked/.test(bar.textContent || '');
    }, null, { timeout: 30000 });

    expect(writes.filter(w => w.kind === 'task-carry').length).toBe(0);
    expect(writes.findIndex(w => w.kind === 'project-snapshot')).toBeGreaterThanOrEqual(0);
    await expect(page.locator('#statusBar')).toContainText('0 carried');
    await expect(page.locator('#statusBar')).toContainText('1 parked');
  });
});
