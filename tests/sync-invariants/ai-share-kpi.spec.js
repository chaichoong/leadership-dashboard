// Invariant: the "Work Done by AI" card must measure ownership from Team Member, weight
// by TIME rather than task count, and refuse to print a number when it has no data.
//
// Why each of those is a real trap, not a hypothetical:
//
// 1. OWNERSHIP LIVES IN Team Member, NOT Assignee. Assignee is a human collaborator
//    field; scripts/slack-automation/approvals.js clears it when an agent takes a task,
//    with the comment "the agent owns it now; Assignee cannot hold one". On 2 Aug 2026,
//    163 of 165 tasks reported as "unassigned" already had an AI agent on Team Member.
//    A version of this card that read Assignee would score every single agent task as
//    human work and report 0% forever, which is the most expensive way to be wrong here:
//    it makes the north star look unreachable while agents are actually doing the work.
//
// 2. TIME-WEIGHTED, NOT COUNT-WEIGHTED. Fifty 15-minute email triages is not the same
//    contribution as one 8-hour build. Kevin asked for this off the Time Estimate field
//    specifically. A count-based version flatters AI whenever agents pick up the small
//    repetitive jobs, which is exactly what they pick up.
//
// 3. AN EMPTY RESULT IS NOT 0%. A filterByFormula with a renamed field returns 200 OK
//    and {"records":[]}. Dividing by that yields "0.0%", indistinguishable from a real
//    score of zero, and this base has shipped that class of bug before (the 8,667-txn
//    Report Amount blanking, the un-paged recon accuracy card). The card must say
//    "no data" instead.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, loadDashboard } = require('./helpers');

const TASKS = 'tblqB8b22hKBL4PF1';
const TEAM = 'tblco0p2OnlLQVAX7';

const F_NAME = 'fldgFjGBw6bTKJFCD';
const F_DONE = 'fldFOi1SwEKuJRmdN';   // Completion Date
const F_MINS = 'fldTK51tSz6vH3LYp';   // Estimated Minutes (formula)
const F_TM = 'flduCtmQGpOA4eWaj';     // Team Member (link)
const F_ASSIGNEE = 'fldELMncVJYPDRJNc';
const F_TM_NAME = 'flds7xoRFQhcRTnbB';
const F_IS_AGENT = 'fldKGsz9kTpFypeOr';
const F_OUTCOME = 'fldrHBSr6qoUfaKuZ';   // Approval Outcome
const F_RAISED_BY = 'fld30Yw8SWYVp049g'; // Sent For Approval By

const AGENT = 'recAgent1';
const HUMAN = 'recHuman1';

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 19) + '.000Z';
};

const task = (id, mins, owner, days) => ({
  id,
  fields: {
    [F_NAME]: id,
    [F_DONE]: daysAgo(days),
    ...(mins ? { [F_MINS]: mins } : {}),
    ...(owner ? { [F_TM]: [owner] } : {}),
  },
});

const team = [
  { id: AGENT, fields: { [F_TM_NAME]: 'AI Worker — Builder', [F_IS_AGENT]: true } },
  { id: HUMAN, fields: { [F_TM_NAME]: 'Mica Albovias' } },
];

// Register AFTER loadDashboard(). Playwright matches the most recently registered
// handler first, so a route added beforehand is shadowed by the generic fixture mock
// and silently yields {records:[]}.
async function routeAiShare(page, { tasks, teamRows = team }) {
  await page.route('**/api.airtable.com/v0/**', async (route) => {
    const url = route.request().url();
    if (route.request().method() !== 'GET') return route.fallback();
    // Match on the field ID, not the formula text. URLSearchParams encodes the
    // space in "Completion Date" as "+", not "%20", so matching the human name
    // silently never fires and the card falls through to the fixture mock.
    if (url.includes(TASKS) && url.includes(F_DONE)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: tasks }) });
    }
    if (url.includes(TEAM) && url.includes(F_IS_AGENT)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: teamRows }) });
    }
    return route.fallback();
  });
}

// The label is upper-cased by CSS, so innerText reads "WORK DONE BY AI".
// Match case-insensitively or every assertion here fails on a working card.
const cardText = async (page) => {
  await page.waitForFunction(
    () => /work done by ai/i.test(document.body.innerText),
    { timeout: 15000 },
  );
  // `head` is the headline value only. `all` is textContent, which includes the
  // collapsed detail rows — innerText omits them because the panel is hidden.
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.kpi-card')];
    const c = cards.find(el => /work done by ai/i.test(el.textContent));
    if (!c) return { head: '', all: '' };
    const v = c.querySelector('.kpi-card-value');
    return { head: v ? v.textContent.trim() : '', all: c.textContent };
  });
};

test.describe('Work Done by AI KPI', () => {

  test('weights by time, not task count', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await routeAiShare(page, {
      // Agent did ONE 8-hour job. Humans did FOUR 15-minute jobs.
      // By time the agent share is 480/540 = 88.9%. By count it would be 20%.
      tasks: [
        task('recAi1', 480, AGENT, 3),
        task('recH1', 15, HUMAN, 3),
        task('recH2', 15, HUMAN, 4),
        task('recH3', 15, HUMAN, 5),
        task('recH4', 15, HUMAN, 6),
      ],
    });
    await page.evaluate(async () => await loadAiShareKpi());

    const { head } = await cardText(page);
    expect(head).toBe('88.9%');        // time-weighted
    expect(head).not.toBe('20.0%');    // what a count-weighted version would print
  });

  test('reads ownership from Team Member, never Assignee', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    // The agent task carries NO Assignee, which is the designed state for agent work.
    // A card reading Assignee would count this as unowned or human and report 0%.
    const agentTask = task('recAi1', 120, AGENT, 2);
    delete agentTask.fields[F_ASSIGNEE];
    await routeAiShare(page, {
      tasks: [agentTask, task('recH1', 120, HUMAN, 2)],
    });
    await page.evaluate(async () => await loadAiShareKpi());

    const { head } = await cardText(page);
    expect(head).toBe('50.0%');
    expect(head).not.toBe('0.0%');     // what reading Assignee would print
  });

  test('says "no data" rather than 0% when the query comes back empty', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await routeAiShare(page, { tasks: [] });
    await page.evaluate(async () => await loadAiShareKpi());

    const { head } = await cardText(page);
    expect(head).toBe('no data');
    expect(head).not.toBe('0.0%');
  });

  // Kevin's ruling, 9 Aug 2026: work an agent prepared and he approved FIRST TIME is
  // AI work — he only spent an approval on it. The inverse is the half that keeps the
  // number honest, and it is the one that would quietly rot: work he sent back is his,
  // not the agent's, even though the agent's name is still on Team Member.
  test('work approved first time counts as AI even without a Team Member link', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    const approved = task('recApproved', 60, null, 2);   // no Team Member at all
    approved.fields[F_OUTCOME] = 'Approved as-is';
    approved.fields[F_RAISED_BY] = [AGENT];
    await routeAiShare(page, { tasks: [approved, task('recH1', 60, HUMAN, 2)] });
    await page.evaluate(async () => await loadAiShareKpi());

    const { head } = await cardText(page);
    expect(head).toBe('50.0%');
    expect(head).not.toBe('0.0%');   // what ignoring the approval record would print
  });

  test('work sent back to the agent is NOT AI work, even with an agent on Team Member', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    const rejected = task('recSentBack', 60, AGENT, 2);  // agent IS on Team Member
    rejected.fields[F_OUTCOME] = 'Changes requested';
    rejected.fields[F_RAISED_BY] = [AGENT];
    await routeAiShare(page, { tasks: [rejected, task('recH1', 60, HUMAN, 2)] });
    await page.evaluate(async () => await loadAiShareKpi());

    const { head, all } = await cardText(page);
    expect(head).toBe('0.0%');       // Kevin redid it, so it is his hour, not the agent's
    expect(head).not.toBe('50.0%');  // what counting Team Member alone would print
    expect(all).toMatch(/Sent back to the agent[\s\S]*?1/);
  });

  test('tasks with no time estimate move coverage, not the share', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await routeAiShare(page, {
      tasks: [
        task('recAi1', 60, AGENT, 2),
        task('recH1', 60, HUMAN, 2),
        task('recNoEst1', 0, HUMAN, 2),   // no Estimated Minutes
        task('recNoEst2', 0, HUMAN, 2),
      ],
    });
    await page.evaluate(async () => await loadAiShareKpi());

    const { head, all } = await cardText(page);
    expect(head).toBe('50.0%');                              // unmeasured tasks must not dilute the share
    expect(all).toMatch(/carrying a time estimate[\s\S]*?50%/); // coverage: 2 of 4 carry an estimate
  });
});
