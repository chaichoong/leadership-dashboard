// Strategy push — task assignee comes from the project's OWNER.
//
// The defect this pins (raised 31 Jul 2026, fixed 1 Aug): every pushed task
// was hardcoded to Kevin's email regardless of the project owner. Fine for
// Kevin's own build; wrong the moment a client pushes their plan — their
// tasks would land in Kevin's queue. The rule now: owner first, Kevin only
// as the fallback when no owner is set, and the approval preview says which.
//
// Airtable + the AI proxy are mocked (page.route) so this runs without a PAT.

const { test, expect } = require('@playwright/test');

const PAGE = '/os/strategy/index.html';

const T = {
  businesses: 'tblpqkvWJJo8Uu25q',
  objStrat: 'tblEBvFw8DonwxzGh',
  projects: 'tblHrpTMd5LNYn8v1',
  tasks: 'tblqB8b22hKBL4PF1',
  mainMethods: 'tbl065D58MBEJhjlp',
  teamMembers: 'tblco0p2OnlLQVAX7',
};

const F = {
  osQuarter: 'fldQl2h3gCxYacE1k',
  osYear: 'fldARVrVpuCWxufQO',
  osBusiness: 'fldLt6uDJ2xKCMlj2',
  osQp1: 'fldMRcqBdI6sixquu',
  osQp1Owner: 'fld9HlP2aGAfVfQiE',    // qpDetails[0].owner (singleCollaborator)
  osQp1Stone1: 'fldA66Xm4zVoClUva',   // monthlyStones[0][0]
  osQp2: 'fldzTGq0bsvSIch4v',
  osQp2Stone1: 'fldBcYzfU8zheE00j',   // monthlyStones[1][0]
  taskAssignee: 'fldELMncVJYPDRJNc',
  tmMember: 'fldh16yvEgBy8uLKQ',
  tmPreferredName: 'fldFyTZu3vu1a7X3a',
};

const BIZ_ID = 'recBizPush1';
const PLAN_ID = 'recPlanPush1';
const OWNER_EMAIL = 'owner@example.com';
const KEVIN = 'kevin@runpreneur.org.uk';

function plan() {
  return {
    id: PLAN_ID, createdTime: '2026-07-01T00:00:00.000Z',
    fields: {
      [F.osQuarter]: 'Q2', [F.osYear]: '2026', [F.osBusiness]: [BIZ_ID],
      // QP1 has an owner; QP2 deliberately has none (tests the fallback).
      [F.osQp1]: 'Owned project — tasks go to the owner',
      [F.osQp1Owner]: { email: OWNER_EMAIL, name: 'Olive Owner' },
      [F.osQp1Stone1]: 'Ship the owned thing',
      [F.osQp2]: 'Ownerless project — tasks fall back to Kevin',
      [F.osQp2Stone1]: 'Ship the ownerless thing',
    },
  };
}

async function mockAirtable(page, writes) {
  await page.route('**/api.airtable.com/**', async (route) => {
    const url = decodeURIComponent(route.request().url().replace(/\+/g, ' '));
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (method === 'PATCH' || method === 'POST') {
      const entry = { method, url, body: JSON.parse(route.request().postData() || '{}') };
      if (url.includes(T.tasks) && method === 'POST') {
        writes.push({ kind: 'task-create', ...entry });
        return json({ id: 'recTaskNew' + writes.length, fields: entry.body.fields || {} });
      }
      if (url.includes(T.projects) && method === 'POST') {
        writes.push({ kind: 'project-create', ...entry });
        return json({ id: 'recProjNew' + writes.length, fields: entry.body.fields || {} });
      }
      writes.push({ kind: 'other-write', ...entry });
      return json({ id: 'recW', fields: entry.body.fields || {} });
    }

    if (url.includes(T.businesses)) return json({ records: [{ id: BIZ_ID, fields: { 'Business Name': 'Push Test Co' } }] });
    if (url.includes(`${T.objStrat}/${PLAN_ID}`)) return json(plan());
    if (url.includes(T.objStrat)) {
      if (url.includes('{Quarter} = "Q2"')) return json({ records: [plan()] });
      return json({ records: [] });
    }
    if (url.includes(T.teamMembers)) {
      return json({ records: [{ id: 'recTmOwner', fields: {
        [F.tmMember]: { email: OWNER_EMAIL, name: 'Olive Owner' },
        [F.tmPreferredName]: 'Olive Owner',
      } }] });
    }
    return json({ records: [] });
  });
  // AI proxy (stone → tasks) responds empty, so the code falls back to one
  // task per stone — deterministic without a model.
  await page.route('**/*.workers.dev/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.addInitScript(() => { localStorage.setItem('_dlr_pat', 'pat_test_mock_token_for_playwright'); });
}

test.describe('Strategy push — owner-first task assignment', () => {
  test('tasks assign to the project owner, falling back to Kevin, and the preview says so', async ({ page }) => {
    const writes = [];
    await mockAirtable(page, writes);
    await page.goto(PAGE);
    await page.waitForFunction(() => typeof allBusinessesLocal !== 'undefined' && allBusinessesLocal.length > 0, null, { timeout: 20000 });
    await page.evaluate((biz) => {
      document.getElementById('businessSel').value = biz;
      document.getElementById('quarterSel').value = 'Q2';
      document.getElementById('yearSel').value = '2026';
      return loadRecord();
    }, BIZ_ID);
    await page.waitForFunction(() => currentRecord && currentRecord.id, null, { timeout: 20000 });

    await page.evaluate(() => pushProjectsManually());
    await expect(page.locator('#pushModal')).toBeVisible({ timeout: 30000 });

    // The preview names the assignee per project — no silent Kevin default.
    const modalText = await page.locator('#pushModal').innerText();
    expect(modalText).toContain('Tasks assigned to: Olive Owner');
    expect(modalText).toContain('no owner set on this project');
    expect(modalText).not.toContain('assigned to Kevin,');

    await page.click('#pushApproveBtn');
    await page.waitForFunction(() => {
      const bar = document.getElementById('statusBar');
      return bar && /Tasks & Projects/.test(bar.textContent || '');
    }, null, { timeout: 30000 });

    const taskCreates = writes.filter(w => w.kind === 'task-create');
    expect(taskCreates.length).toBe(2);
    const byName = Object.fromEntries(taskCreates.map(w => [
      w.body.fields['fldgFjGBw6bTKJFCD'], w.body.fields[F.taskAssignee],
    ]));
    // Owned project's task → the owner. Ownerless project's task → Kevin.
    expect(byName['Ship the owned thing']).toEqual({ email: OWNER_EMAIL });
    expect(byName['Ship the ownerless thing']).toEqual({ email: KEVIN });
  });
});
