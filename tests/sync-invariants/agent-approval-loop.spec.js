// AI agent approval loop — the two invariants that make the gate safe.
//
// Built 31 Jul 2026, when 157 of 315 open tasks were assigned to AI agents and
// there was no approval mechanism at all.
//
//   1. APPROVAL RETURNS THE TASK TO THE AGENT THAT RAISED IT.
//      If approval left the task on Kevin, or cleared the agent link, the work
//      would dead-end: nobody would carry out the thing he just approved.
//
//   2. NOTHING GOES FROM Approval STRAIGHT TO Completed.
//      A task in Approval is a PROPOSAL the agent has not carried out. Letting
//      it jump to Completed would mark work done that was never approved and
//      never actually performed — the exact failure the gate exists to stop.
//
// Airtable is mocked (page.route on api.airtable.com), so this runs with no PAT
// and asserts on the PATCH payloads the page actually sends.

const { test, expect } = require('@playwright/test');

const PAGE = '/os/tasks/index.html';
const TASKS_TABLE = 'tblqB8b22hKBL4PF1';
const TEAM_TABLE = 'tblco0p2OnlLQVAX7';

const F = {
  name: 'fldgFjGBw6bTKJFCD',
  dueDate: 'fld7XP8w8kbxfETV4',
  status: 'fldx4qCw17UfrKpaN',
  assignee: 'fldELMncVJYPDRJNc',
  description: 'fldRGhBQViKZKtkQ6',
  completion: 'fldFOi1SwEKuJRmdN',
  teamMember: 'flduCtmQGpOA4eWaj',
  sentForApprovalBy: 'fld30Yw8SWYVp049g',
  approvalOutcome: 'fldrHBSr6qoUfaKuZ',
  agentOutput: 'fldzswp8fx6PqpLQ5',
  approvalFeedback: 'fldtI7SJI4gEohHD1',
  approvedBy: 'fldNntfwSzU5DlYS4',
  approvedAt: 'fldr4Mvf2RzKvhZhi',
  taskType: 'fldZ2moDV2041Sobc',
};
const TM = {
  name: 'flds7xoRFQhcRTnbB',
  member: 'fldh16yvEgBy8uLKQ',
  active: 'fld2YLfcPqSe6b60u',
  fullLegalName: 'fld1DYEbtyVsO2GVP',
  isAgent: 'fldKGsz9kTpFypeOr',
};

const AGENT_ID = 'recAgentWriter1';
const WAITING_ID = 'recWaitingOnKevin';
const DECIDED_ID = 'recAlreadyDecided';
const KEVIN = 'kevin@runpreneur.org.uk';

function taskRecords() {
  const today = new Date().toISOString().slice(0, 10);
  return { records: [
    // Waiting on Kevin: raised by an agent, assigned to him, no outcome yet.
    { id: WAITING_ID, createdTime: new Date().toISOString(), fields: {
      [F.name]: 'Draft the welcome email',
      [F.status]: 'Approval',
      [F.dueDate]: today,
      [F.description]: 'Proposed draft, not sent.',
      [F.agentOutput]: 'Subject: Welcome\n\nHi there, thanks for coming on board.',
      [F.assignee]: { id: 'usrKevin', email: KEVIN, name: 'Kevin Brittain' },
      [F.teamMember]: [AGENT_ID],
      [F.sentForApprovalBy]: [AGENT_ID],
      [F.taskType]: 'Drafting',
    } },
    // Already approved and handed back — the agent may complete this one, it
    // has carried the action out.
    { id: DECIDED_ID, createdTime: new Date().toISOString(), fields: {
      [F.name]: 'Send the welcome email',
      [F.status]: 'Approval',
      [F.dueDate]: today,
      [F.approvalOutcome]: 'Approved as-is',
      [F.teamMember]: [AGENT_ID],
      [F.sentForApprovalBy]: [AGENT_ID],
      [F.taskType]: 'Drafting',
    } },
  ] };
}

// The AI agents are Team Member records with no Airtable login, so they carry
// no Member/email. A fixture that gives them one would not exercise the real
// AGENT_MAP path.
function teamRecords() {
  return { records: [
    { id: AGENT_ID, createdTime: new Date().toISOString(), fields: {
      [TM.name]: 'AI Worker — Writer',
      [TM.fullLegalName]: 'AI Worker — Writer',
      [TM.active]: true,
    } },
    { id: 'recMica', createdTime: new Date().toISOString(), fields: {
      [TM.name]: 'Mica Albovias',
      [TM.member]: { id: 'usrMica', email: 'micaa.work@gmail.com', name: 'Mica Albovias' },
      [TM.active]: true,
    } },
    // An agent whose name does NOT start with "AI". Adding an agent must be one
    // step — add the row, tick the box — with no naming convention to remember
    // and no code change.
    { id: 'recZeta', createdTime: new Date().toISOString(), fields: {
      [TM.name]: 'Zeta Ops Bot',
      [TM.fullLegalName]: 'Zeta Ops Bot',
      [TM.isAgent]: true,
      [TM.active]: true,
    } },
  ] };
}

async function mockAirtable(page) {
  const patches = [];
  await page.route('**/api.airtable.com/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/comments')) {
      if (method === 'POST') return json({ id: 'comMock1', text: 'ok', createdTime: new Date().toISOString() });
      return json({ comments: [] });
    }
    if (url.includes(TEAM_TABLE)) {
      if (method === 'POST') {
        const body = JSON.parse(route.request().postData() || '{}');
        return json({ records: [{ id: 'recNewAgent', fields: body.records[0].fields }] });
      }
      return json(teamRecords());
    }
    if (url.includes(TASKS_TABLE)) {
      if (method === 'PATCH') {
        const body = JSON.parse(route.request().postData() || '{}');
        const id = url.split('/').pop().split('?')[0];
        patches.push({ id, fields: body.fields });
        // Echo the payload back keyed by field ID — the page verifies that what
        // it sent actually persisted, and a bare {} would read as silent drift.
        return json({ id, fields: body.fields });
      }
      return json(taskRecords());
    }
    return json({ records: [] });
  });
  await page.route('**/*.workers.dev/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/script.google.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.addInitScript(() => {
    localStorage.setItem('_dlr_pat', 'pat_test_mock_token_for_playwright');
    localStorage.setItem('_task_user', JSON.stringify({ key: 'kevin', name: 'Kevin Brittain', email: 'kevin@runpreneur.org.uk' }));
  });
  return patches;
}

async function waitForTasks(page) {
  await page.waitForFunction(
    (id) => typeof allTasks !== 'undefined' && allTasks.some(t => t.id === id),
    WAITING_ID, { timeout: 20000 });
}

test.describe('Agent approval loop', () => {
  test('approval hands the task back to the agent that raised it, and does NOT complete it', async ({ page }) => {
    const patches = await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTasks(page);

    await page.evaluate((id) => openTaskDrawer(id), WAITING_ID);
    await expect(page.locator('.approval-box')).toBeVisible();
    await expect(page.locator('.approval-box')).toContainText('AI Worker — Writer');
    // The thing he is actually judging has to be on screen, not just the title.
    await expect(page.locator('.approval-box .apv-work-body')).toContainText('thanks for coming on board');

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('drawerOverlay'), null, { timeout: 10000 });

    const patch = patches.find(p => p.id === WAITING_ID);
    expect(patch, 'approving must PATCH the task').toBeTruthy();
    const f = patch.fields;

    // The verdict, stamped with who and when.
    expect(f[F.approvalOutcome]).toBe('Approved as-is');
    expect(f[F.approvedBy]).toEqual({ email: KEVIN });
    expect(f[F.approvedAt]).toBeTruthy();

    // Back to the agent that raised it. This is invariant 1.
    expect(f[F.teamMember]).toEqual([AGENT_ID]);
    expect(f[F.sentForApprovalBy]).toEqual([AGENT_ID]);
    expect(f[F.assignee], 'the agent owns it now, not Kevin').toBeNull();

    // Approving is NOT completing. The agent still has to carry the action out.
    expect(f[F.status]).toBe('Today');
    expect(f[F.status]).not.toBe('Completed');
    // Stronger than the original `toBeUndefined()`. Leaving the field alone was
    // the bug (20260811-daily-ops-091): a task completed once and later approved
    // kept its old stamp and stayed in every throughput and Completed Month
    // figure as finished work — 88 open tasks were carrying one on 11 Aug 2026.
    // Approving must actively clear it, and must still never stamp one.
    expect(f[F.completion], 'approving must clear any stale completion stamp').toBeNull();
  });

  test('an agent cannot move a task from Approval straight to Completed', async ({ page }) => {
    const patches = await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTasks(page);

    const before = patches.length;
    await page.evaluate((id) => updateTaskField(id, 'status', 'Completed'), WAITING_ID);
    await page.waitForTimeout(500);

    expect(patches.length, 'the blocked move must not reach Airtable').toBe(before);
    expect(await page.evaluate((id) => allTasks.find(t => t.id === id).status, WAITING_ID)).toBe('Approval');
    await expect(page.locator('#toast')).toContainText('waiting for approval');
  });

  test('once an outcome is recorded the agent may complete it', async ({ page }) => {
    const patches = await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTasks(page);

    await page.evaluate((id) => updateTaskField(id, 'status', 'Completed'), DECIDED_ID);
    await page.waitForFunction((id) => allTasks.find(t => t.id === id).status === 'Completed', DECIDED_ID, { timeout: 10000 });

    const patch = patches.find(p => p.id === DECIDED_ID);
    expect(patch, 'an approved task must be completable by the agent').toBeTruthy();
    expect(patch.fields[F.status]).toBe('Completed');
  });

  // Agent-held work was invisible before 1 Aug 2026: the page only read
  // `Assignee`, which cannot hold an agent, so 160 open agent tasks all showed
  // as "Unassigned" and read as a backlog nobody owned.
  test('agent-held tasks show as the agent, not as Unassigned', async ({ page }) => {
    await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTasks(page);

    const counts = await page.evaluate((waitingId) => {
      const active = allTasks.filter(t => t.status !== 'Completed' && !t.someDay);
      return {
        agentHeld: active.filter(t => taskAgentId(t)).length,
        trulyUnassigned: active.filter(t => taskIsTrulyUnassigned(t)).length,
        agentName: taskAgentName(allTasks.find(t => t.id === waitingId)),
      };
    }, WAITING_ID);

    expect(counts.agentHeld, 'both fixtures are agent-held').toBe(2);
    expect(counts.trulyUnassigned, 'an agent task is NOT unassigned').toBe(0);
    expect(counts.agentName).toBe('AI Worker — Writer');

    // And the team bar offers the filter, showing the agent count.
    const bar = page.locator('#teamBar');
    await expect(bar).toContainText('AI Agents');
    await expect(bar.locator('button', { hasText: 'Unassigned' })).toContainText('0');
  });

  test('the AI Agents filter selects exactly the agent-held work', async ({ page }) => {
    await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTasks(page);

    const shown = await page.evaluate(() => {
      setTeam('agents');
      return applyTeamFilter(allTasks).map(t => t.id).sort();
    });
    expect(shown).toEqual([DECIDED_ID, WAITING_ID].sort());

    const none = await page.evaluate(() => {
      setTeam('unassigned');
      return applyTeamFilter(allTasks).length;
    });
    expect(none, 'nothing is truly unassigned in the fixture').toBe(0);
  });

  test('assigning to an agent writes the Team Member link and clears Assignee', async ({ page }) => {
    const patches = await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTasks(page);

    // Assign it to an agent, the way the picker does.
    await page.evaluate((args) => updateTaskField(args.id, 'assignee', 'agent:' + args.agent), { id: WAITING_ID, agent: AGENT_ID });
    await page.waitForTimeout(500);

    const patch = [...patches].reverse().find(p => p.id === WAITING_ID && F.teamMember in p.fields);
    expect(patch).toBeTruthy();
    expect(patch.fields[F.teamMember]).toEqual([AGENT_ID]);
    expect(patch.fields[F.assignee], 'Assignee cannot hold an agent').toBeNull();

    // Handing it back to a person releases the agent, or it shows under both.
    await page.evaluate((id) => updateTaskField(id, 'assignee', 'mica'), WAITING_ID);
    await page.waitForTimeout(500);
    // Pick the patch that actually carries Assignee. A status/due-date patch
    // can land afterwards on the same task, so "the last one" is the wrong
    // thing to assert against.
    const handover = [...patches].reverse().find(p => p.id === WAITING_ID && F.assignee in p.fields);
    expect(handover.fields[F.assignee]).toEqual({ email: 'micaa.work@gmail.com' });
    expect(handover.fields[F.teamMember], 'the agent lets go').toEqual([]);
  });

  test('ticking "Is AI Agent" is all it takes — no naming convention, no code change', async ({ page }) => {
    await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTasks(page);

    const res = await page.evaluate(() => ({
      pickedUp: !!AGENT_MAP.recZeta,
      name: AGENT_MAP.recZeta || null,
      // Offered in the picker, i.e. work can actually be handed to it.
      offered: assigneeOptionsHtml(allTasks[0], false).includes('agent:recZeta'),
      // A real person with no box ticked must NOT become an agent.
      micaIsNotAnAgent: !AGENT_MAP.recMica,
    }));

    expect(res.pickedUp, 'the checkbox alone must make it an agent').toBe(true);
    expect(res.name).toBe('Zeta Ops Bot');
    expect(res.offered, 'it must be assignable').toBe(true);
    expect(res.micaIsNotAnAgent).toBe(true);
  });

  test('the Task List filter separates robot work from human work', async ({ page }) => {
    await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTasks(page);
    // The page defaults to the signed-in user's own tasks, so widen to All
    // before testing a filter that is about everyone's work.
    await page.evaluate(() => { setTeam('all'); switchView('list'); });

    // An empty result renders a single "No tasks found." row, so count real
    // task rows rather than every <tr>.
    const count = async (value) => page.evaluate((v) => {
      document.getElementById('filterOwnerType').value = v;
      renderTasks();
      const body = document.querySelector('.task-table tbody');
      if (!body || /No tasks found/.test(body.innerText)) return 0;
      return body.querySelectorAll('tr').length;
    }, value);

    expect(await count('ai'), 'both fixtures are agent-held').toBe(2);
    expect(await count('people'), 'neither is held by a person alone').toBe(0);
    expect(await count('nobody'), 'nothing is truly unassigned').toBe(0);
    expect(await count(''), 'no filter shows everything').toBe(2);
  });

  test('an agent can be added from the app, without touching Airtable', async ({ page }) => {
    await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTasks(page);
    await page.evaluate(() => switchView('agents'));
    await page.waitForSelector('#newAgentName');

    await page.locator('#newAgentName').fill('AI Worker — Bookkeeper');
    await page.getByRole('button', { name: 'Add agent' }).click();
    await page.waitForFunction(
      () => Object.values(AGENT_MAP).includes('AI Worker — Bookkeeper'), null, { timeout: 10000 });

    // Usable immediately — the point of doing it here rather than in Airtable.
    const offered = await page.evaluate(() => {
      const id = Object.keys(AGENT_MAP).find(k => AGENT_MAP[k] === 'AI Worker — Bookkeeper');
      return assigneeOptionsHtml(allTasks[0], false).includes('agent:' + id);
    });
    expect(offered).toBe(true);
  });

  test('request changes will not submit without a comment', async ({ page }) => {
    const patches = await mockAirtable(page);
    await page.goto(PAGE);
    await waitForTasks(page);

    await page.evaluate((id) => openTaskDrawer(id), WAITING_ID);
    const before = patches.length;
    await page.getByRole('button', { name: 'Request changes' }).click();
    await page.waitForTimeout(300);

    expect(patches.length, 'no comment means no write').toBe(before);
    await expect(page.locator('.approval-box')).toBeVisible();
    await expect(page.locator('#toast')).toContainText('what needs changing');

    // With a comment it goes through, back to the agent, still not completed.
    await page.locator('#apvNote').fill('Tone is too formal. Redo it warmer.');
    await page.getByRole('button', { name: 'Request changes' }).click();
    await page.waitForFunction(() => !document.getElementById('drawerOverlay'), null, { timeout: 10000 });

    const patch = patches.find(p => p.id === WAITING_ID);
    expect(patch.fields[F.approvalOutcome]).toBe('Changes requested');
    expect(patch.fields[F.teamMember]).toEqual([AGENT_ID]);
    expect(patch.fields[F.status]).not.toBe('Completed');
    // The agent has to be able to READ what to change. The Slack worker's
    // Airtable token cannot read record comments, so the field is the contract.
    expect(patch.fields[F.approvalFeedback]).toBe('Tone is too formal. Redo it warmer.');
  });
});
