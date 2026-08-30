// Shared mock harness for os/agents/index.html specs.
//
// The AI Agents page reads seven tables at boot (Tasks three ways, Team
// Members, AI Agents register, Daily Log, Workflows/Steps/Businesses, CEO
// Briefs). This module intercepts api.airtable.com and serves deterministic
// fixtures so the page boots with no PAT, and exposes the PATCH log so specs
// can assert on writes.
//
// Tasks-table routing: the page hits the SAME table with three different
// formulas. The routing keys on distinctive substrings of each formula —
// 'Sent For Approval By' (approval queue), 'Approval Outcome' (workload +
// accuracy history), anything else (open tasks). If a page formula changes,
// update TASK_QUERY_MARKERS here in the same commit.

const { MOCK_PAT, stubExternalHosts } = require('./helpers');

const TABLES = {
  tasks: 'tblqB8b22hKBL4PF1',
  team: 'tblco0p2OnlLQVAX7',
  agents: 'tbl9msVjyQWslLOIZ',
  dailyLog: 'tbl6VQKVMnK0Q7hbJ',
  workflows: 'tblLPoRHFBl0vqR24',
  steps: 'tblTadoyWXFHbmYxm',
  businesses: 'tblpqkvWJJo8Uu25q',
  ceoBriefs: 'tblIxbzDSOCI5hqJn',
};

// Field IDs mirrored from the constants block in os/agents/index.html.
const TF = {
  name: 'fldgFjGBw6bTKJFCD',
  status: 'fldx4qCw17UfrKpaN',
  description: 'fldRGhBQViKZKtkQ6',
  notes: 'fldR7apBzSp3oxFxz',
  dueDate: 'fld7XP8w8kbxfETV4',
  teamMember: 'flduCtmQGpOA4eWaj',
  sentForApprovalBy: 'fld30Yw8SWYVp049g',
  agentOutput: 'fldzswp8fx6PqpLQ5',
  approvalOutcome: 'fldrHBSr6qoUfaKuZ',
  approvedAt: 'fldr4Mvf2RzKvhZhi',
  taskType: 'fldZ2moDV2041Sobc',
  completionDate: 'fldFOi1SwEKuJRmdN',
  priority: 'fldS21RwmwOqt71LI',
  lmt: 'flddJA23cJRX5cs1K',
  inboundTask: 'fldueazD67F7fUGee',
  inboundUrl: 'fldXf1p0vtHqOZcKl',
  attachments: 'fldEbs9cscRr8elcw',
  slackBaseline: 'fldxsqj9JSRBGNyT9',
  feedbackHistory: 'fldOzsq68lhfprKJu',
  deferredUntil: 'fldJ9IHS1yxwYzYSN',
};
const TM = { name: 'flds7xoRFQhcRTnbB', active: 'fld2YLfcPqSe6b60u', isAi: 'fldKGsz9kTpFypeOr' };
const AG = {
  name: 'fldhtLvryVEzeGbl8',
  goal: 'fldz8O9KihauZ46Cd',
  status: 'fld71vXWqcxhdljac',
  guardrail: 'fldWgqxMFmaAAvUHC',
  teamMember: 'fldEtzFGbNe4te9xL',
  metricScore: 'fldkGxrOlrfuLlH3J',
};
const ALOG = {
  date: 'fldr9ktRlG8e93AMN',
  agent: 'fld8OSVSzfXcDjDIl',
  summary: 'fld0vrdlfSiZjR6wg',
};
// Mirrors CEOB in os/agents/index.html and F.ceo* in js/config.js.
const CEO = {
  date: 'fldzLwBd3Mjg7rDxM',
  oneThing: 'fldQDCAcd74Bb6mpY',
  firstStep: 'fld4O4EuxHzMWARV7',
  why: 'fldqooUbDCQ4yNlWQ',
  ignoreToday: 'fldmC5AYRaJdfyFGx',
  boardFlags: 'fldS7ZoGAS7sAJfJq',
  handedOff: 'fld9PQ10p8V4N8Y0U',
  moneyLight: 'fldBIbjpHlA2QmVbO',
  safeToAct: 'fldQ4JEWYpHpI2KDs',
  fullBrief: 'fldPkiaWvmYAoyHEl',
};

const AGENT_A = 'recTmCreditorMgmt';
const AGENT_B = 'recTmInboundResp';

function londonTodayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

// Same derivation as the page's ceoBriefIsWeekendDate: the ISO date read as a
// calendar date, never through the runner's own timezone.
function isLondonWeekend() {
  const d = new Date(`${londonTodayISO()}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

function defaultFixtures() {
  const now = new Date().toISOString();
  const today = londonTodayISO();
  return {
    team: [
      { id: AGENT_A, createdTime: now, fields: { [TM.name]: 'Creditor Management', [TM.active]: true, [TM.isAi]: true } },
      { id: AGENT_B, createdTime: now, fields: { [TM.name]: 'Inbound Comms Response', [TM.active]: true, [TM.isAi]: true } },
    ],
    agents: [
      { id: 'recRegCreditor', createdTime: now, fields: {
        [AG.name]: 'Creditor Management', [AG.goal]: 'Freeze first, plan second', [AG.status]: 'Live',
        [AG.guardrail]: 'Approval required', [AG.teamMember]: [AGENT_A],
      } },
      { id: 'recRegInbound', createdTime: now, fields: {
        [AG.name]: 'Inbound Comms Response', [AG.goal]: 'Reply within 24 hours', [AG.status]: 'Live',
        [AG.guardrail]: 'Approval required', [AG.teamMember]: [AGENT_B], [AG.metricScore]: '92% within 24h',
      } },
    ],
    // Importance spread on purpose: A1 is tier 1 (leads regardless of
    // priority), B1 is Urgent (beats High), A2 is High — so the specs can
    // assert the queue's most-important-first order.
    approvals: [
      { id: 'recApvA1', createdTime: now, fields: {
        [TF.name]: 'Reply to Anglian Water', [TF.status]: 'Approval',
        [TF.agentOutput]: '🚨 TIER 1. This touches your private legal and financial matter. Draft: please freeze the account.',
        [TF.priority]: 'High',
        [TF.inboundUrl]: 'https://mail.google.com/mail/u/0/#all/19f3c5386a9f5910',
        [TF.sentForApprovalBy]: [AGENT_A], [TF.teamMember]: [AGENT_A], [TF.lmt]: now, [TF.taskType]: 'Correspondence',
      } },
      { id: 'recApvA2', createdTime: now, fields: {
        [TF.name]: 'Payment plan proposal', [TF.status]: 'Approval', [TF.agentOutput]: 'Draft: lowest possible plan.',
        [TF.priority]: 'High',
        // Folded duplicate: the gate appended a second thread's URL.
        [TF.inboundUrl]: 'https://mail.google.com/mail/u/0/#all/1a0373a0fec1897c https://mail.google.com/mail/u/0/#all/1a02ac3541a86728',
        [TF.sentForApprovalBy]: [AGENT_A], [TF.teamMember]: [AGENT_A], [TF.lmt]: now, [TF.taskType]: 'Correspondence',
      } },
      { id: 'recApvB1', createdTime: now, fields: {
        [TF.name]: 'Reply to tenant email', [TF.status]: 'Approval', [TF.agentOutput]: 'Draft: thanks, will confirm.',
        [TF.priority]: 'Urgent',
        // iMessage: a real key, but nothing a browser can open.
        [TF.inboundUrl]: 'imessage:259F4464-838C-F860-3997-F3BD783F426E',
        [TF.sentForApprovalBy]: [AGENT_B], [TF.teamMember]: [AGENT_B], [TF.lmt]: now, [TF.taskType]: 'Drafting',
      } },
    ],
    openTasks: [
      // Two open tasks that are the same job with different reference numbers
      // — the duplicates lane must collide them.
      { id: 'recDup1', createdTime: now, fields: {
        [TF.name]: 'Chase Acme invoice #2', [TF.status]: 'This Week', [TF.dueDate]: today, [TF.teamMember]: [AGENT_A], [TF.lmt]: now,
      } },
      { id: 'recDup2', createdTime: now, fields: {
        [TF.name]: 'Chase Acme invoice #3', [TF.status]: 'This Week', [TF.dueDate]: today, [TF.teamMember]: [AGENT_A], [TF.lmt]: now,
      } },
      { id: 'recUnique', createdTime: now, fields: {
        [TF.name]: 'Draft the welcome pack', [TF.status]: 'This Week', [TF.dueDate]: today, [TF.teamMember]: [AGENT_B], [TF.lmt]: now,
      } },
    ],
    taskHistory: [
      { id: 'recHist1', createdTime: now, fields: {
        [TF.teamMember]: [AGENT_A], [TF.sentForApprovalBy]: [AGENT_A], [TF.approvalOutcome]: 'Approved as-is',
        [TF.approvedAt]: now, [TF.taskType]: 'Correspondence', [TF.status]: 'Completed', [TF.completionDate]: now,
      } },
    ],
    dailyLog: [
      { id: 'recLog1', createdTime: now, fields: {
        [ALOG.date]: today, [ALOG.agent]: ['recRegCreditor'], [ALOG.summary]: 'Ran the morning sweep',
      } },
    ],
    // Knocked back to a date. Empty by default so every existing spec sees the
    // queue exactly as it did before this feature; the knock-back specs
    // override it.
    deferred: [],
    workflows: [],
    steps: [],
    businesses: [],
    ceoBriefs: [
      { id: 'recBriefToday', createdTime: now, fields: {
        [CEO.date]: today,
        [CEO.oneThing]: 'Test the onboarding flow end to end',
        [CEO.firstStep]: 'Open the staging site and create one pretend client',
        [CEO.why]: 'First client by 31 August depends on onboarding working.',
        [CEO.ignoreToday]: 'Old invoice filing\nNon-urgent email',
        [CEO.boardFlags]: 'Keller: two of today’s tasks are scatter — refocus.',
        [CEO.handedOff]: 'worker-writer — draft the warm-20 re-engagement message\nMica — chase the UC verification',
        [CEO.moneyLight]: 'green',
        [CEO.safeToAct]: 1234.56,
        [CEO.fullBrief]: '{"one_thing":"Test the onboarding flow end to end"}',
      } },
      { id: 'recBriefPrev', createdTime: now, fields: {
        [CEO.date]: '2026-07-25',
        [CEO.oneThing]: 'Yesterday thing',
        [CEO.firstStep]: 'Yesterday step',
        [CEO.moneyLight]: 'amber',
        [CEO.safeToAct]: 900,
        [CEO.fullBrief]: '{"one_thing":"Yesterday thing"}',
      } },
    ],
  };
}

// Markers are matched against the DECODED url (URLSearchParams encodes a
// space as '+', so encoded matching would silently miss and misroute).
//
// ORDER MATTERS from 28 Aug 2026. The queue formula and the knocked-back one
// are near-identical — same table, same status, same 'Sent For Approval By'
// clause — and differ only in whether the date test is wrapped in NOT(). The
// deferred marker therefore has to be tried FIRST and has to include the
// characters that only the deferred formula has: the queue's version reads
// ", NOT(IS_AFTER({Deferred Until}", so keying on ", IS_AFTER({Deferred Until}"
// cannot match it. Get this wrong and the knocked-back lane silently renders
// the live approval fixtures, which looks like a passing test of a feature
// that is doing the opposite of its job.
const TASK_QUERY_MARKERS = [
  { marker: ', IS_AFTER({Deferred Until}', key: 'deferred' },
  { marker: 'Sent For Approval By', key: 'approvals' },
  { marker: 'Approval Outcome', key: 'taskHistory' },
];

// Route every Airtable call to fixtures. Returns the PATCH log.
async function mockAgentsPage(page, overrides = {}) {
  const fixtures = Object.assign(defaultFixtures(), overrides);
  const patches = [];
  await page.route('**/api.airtable.com/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/comments')) {
      if (method === 'POST') return json({ id: 'comMock1', text: 'ok', createdTime: new Date().toISOString() });
      return json({ comments: [] });
    }
    if (method === 'PATCH') {
      const body = JSON.parse(route.request().postData() || '{}');
      const id = url.split('/').pop().split('?')[0];
      patches.push({ id, fields: body.fields });
      return json({ id, fields: body.fields });
    }
    if (url.includes(TABLES.tasks)) {
      // Single-record read (the stale-approval guard re-reads one task).
      const one = url.match(new RegExp(`${TABLES.tasks}/(rec[A-Za-z0-9]+)`));
      if (one) {
        const all = [...fixtures.approvals, ...fixtures.deferred, ...fixtures.openTasks, ...fixtures.taskHistory];
        const rec = all.find((r) => r.id === one[1]);
        return rec ? json(rec) : json({ error: 'NOT_FOUND' }, 404);
      }
      const decoded = decodeURIComponent(url.replace(/\+/g, ' '));
      const hit = TASK_QUERY_MARKERS.find((m) => decoded.includes(m.marker));
      return json({ records: fixtures[hit ? hit.key : 'openTasks'] });
    }
    if (url.includes(TABLES.team)) return json({ records: fixtures.team });
    if (url.includes(TABLES.agents)) return json({ records: fixtures.agents });
    if (url.includes(TABLES.dailyLog)) return json({ records: fixtures.dailyLog });
    if (url.includes(TABLES.workflows)) return json({ records: fixtures.workflows });
    if (url.includes(TABLES.steps)) return json({ records: fixtures.steps });
    if (url.includes(TABLES.businesses)) return json({ records: fixtures.businesses });
    if (url.includes(TABLES.ceoBriefs)) return json({ records: fixtures.ceoBriefs });
    return json({ records: [] });
  });
  await stubExternalHosts(page);
  await page.addInitScript((pat) => {
    localStorage.setItem('_dlr_pat', pat);
  }, MOCK_PAT);
  return patches;
}

async function loadAgentsPage(page, hash = '') {
  await page.goto('/os/agents/index.html' + (hash ? '#' + hash : ''));
  await page.waitForSelector('#main', { state: 'visible', timeout: 20000 });
}

module.exports = { TABLES, TF, TM, AG, ALOG, CEO, AGENT_A, AGENT_B, londonTodayISO, isLondonWeekend, defaultFixtures, mockAgentsPage, loadAgentsPage };
