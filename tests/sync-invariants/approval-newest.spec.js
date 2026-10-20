// FIND WHAT JUST ARRIVED (Kevin, 20 Oct 2026).
//
// "When the number keeps going up, I can never find the new thing without
// having to scroll through the whole lot." The queue is most important first
// (tier 1, then Priority, then longest waiting: his ruling of 25 Aug 2026), so
// a new card lands at the END of its priority band, somewhere mid-list. On the
// live queue that day his newest card sat at number 8 of 14.
//
// The invariants:
//   1. The default order is unchanged, and it now knows all six live Priority
//      options. Medium (5 of his 14 cards that day) used to rank as blank and
//      sank below Not Urgent; Low did the same.
//   2. "Newest first" puts the card that reached him last on top, says so in
//      the caption, survives a reload and is not cleared by Clear filters.
//   3. "Today (n)" shows only the cards that reached him since midnight, is
//      AND-ed with the agent and Tier 1 chips, and its count matches.
//   4. Select all ticks only the cards on screen, and a bulk verdict runs in
//      screen order, newest first included.
//
//   5. "Arrived" is when the card reached him, never its last edit. The Slack
//      baseline the page used has not been stamped since the per-card Slack
//      posts stopped (0 of 37 live cards on 20 Oct 2026), so every card fell
//      back to its last edit and any sweep made an old card look new. The
//      clock now reads the dispatcher's own dated Notes lines. Every card's
//      last-modified time is NOW in these fixtures, so a pass proves the order
//      comes from the baseline or the Notes lines, not the edit time.

const { test, expect } = require('@playwright/test');
const { TF, AGENT_A, AGENT_B, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

const HOUR = 3600 * 1000;

function fixtures() {
  const now = new Date();
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const sinceMidnight = now.getTime() - midnight.getTime();
  const at = (ms) => new Date(ms).toISOString();
  const todayEarly = at(midnight.getTime() + sinceMidnight * 0.25);
  const todayLate = at(midnight.getTime() + sinceMidnight * 0.75);
  const before = (h) => at(midnight.getTime() - h * HOUR);
  const nowIso = now.toISOString();
  const card = (id, name, priority, baseline, agent, extra = {}) => ({ id, createdTime: before(24 * 10), fields: Object.assign({
    [TF.name]: name, [TF.status]: 'Approval',
    [TF.agentOutput]: `Draft: ${name}.\n\n**Carrying this out will involve:** sending this email to someone@example.co.uk.`,
    [TF.sentForApprovalBy]: [agent], [TF.teamMember]: [agent], [TF.lmt]: nowIso, [TF.slackBaseline]: baseline,
    [TF.taskType]: 'Correspondence',
  }, priority ? { [TF.priority]: priority } : {}, extra) });
  const fx = defaultFixtures();
  fx.approvals = [
    card('recT1Yday', 'Freeze the water account', 'Not Urgent', before(5), AGENT_A, {
      [TF.agentOutput]: '🚨 TIER 1. This touches your private legal and financial matter. Draft: please freeze the account.' }),
    card('recUrgent', 'Book the electrician', 'Urgent', before(72), AGENT_B),
    card('recHighOld', 'Chase the insurer', 'High', before(48), AGENT_A),
    card('recHighNew', 'Reply to the letting agent', 'High', todayLate, AGENT_B),
    card('recMedium', 'File the gas certificate', 'Medium', todayEarly, AGENT_A),
    card('recNotUrg', 'Confirm the bin collection', 'Not Urgent', before(2), AGENT_B),
    card('recLow', 'Tidy the supplier list', 'Low', before(96), AGENT_B),
    card('recBlank', 'Note the meter reading', '', before(24), AGENT_A),
  ];
  return fx;
}

const DEFAULT_ORDER = ['recT1Yday', 'recUrgent', 'recHighOld', 'recHighNew', 'recMedium', 'recLow', 'recNotUrg', 'recBlank'];
const NEWEST_ORDER = ['recHighNew', 'recMedium', 'recNotUrg', 'recT1Yday', 'recBlank', 'recHighOld', 'recUrgent', 'recLow'];

async function openApprovals(page) {
  await page.click('#ptab-approvals');
  await expect(page.locator('#view-approvals')).toBeVisible();
  await expect(page.locator('#approvalsBody .apv-card').first()).toBeVisible();
}
const order = (page) => page.locator('#approvalsBody .apv-card').evaluateAll((cs) => cs.map((c) => c.getAttribute('data-apv-card')));

test.describe('Approval queue: find what just arrived', () => {
  test('the default order is unchanged and ranks Medium and Low', async ({ page }) => {
    await mockAgentsPage(page, fixtures());
    await loadAgentsPage(page);
    await openApprovals(page);
    expect(await order(page)).toEqual(DEFAULT_ORDER);
    await expect(page.locator('#approvalsOrder')).toHaveText(/Most important first/);
    await expect(page.locator('[data-apv-newest]')).toHaveAttribute('aria-pressed', 'false');
  });

  test('Newest first puts the latest card on top, survives a reload and Clear filters', async ({ page }) => {
    await mockAgentsPage(page, fixtures());
    await loadAgentsPage(page);
    await openApprovals(page);
    await page.click('[data-apv-newest]');
    expect(await order(page)).toEqual(NEWEST_ORDER);
    await expect(page.locator('#approvalsOrder')).toHaveText(/Newest first/);
    await expect(page.locator('[data-apv-newest]')).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await page.waitForSelector('#main', { state: 'visible', timeout: 20000 });
    await openApprovals(page);
    expect(await order(page)).toEqual(NEWEST_ORDER);

    // A filter on and cleared leaves the view as he set it.
    await page.click('[data-apv-today]');
    await page.locator('.apv-filter-clear').click();
    expect(await order(page)).toEqual(NEWEST_ORDER);

    await page.click('[data-apv-newest]');
    expect(await order(page)).toEqual(DEFAULT_ORDER);
  });

  test('Today shows only what reached him since midnight, with the other chips', async ({ page }) => {
    await mockAgentsPage(page, fixtures());
    await loadAgentsPage(page);
    await openApprovals(page);
    await expect(page.locator('[data-apv-today]')).toHaveText('Today (2)');
    await page.click('[data-apv-today]');
    expect(await order(page)).toEqual(['recHighNew', 'recMedium']);
    await expect(page.locator('.apv-filter-tier1')).toHaveText('Tier 1 (0)');
    await expect(page.locator('.apv-filter', { hasText: 'Inbound Comms Response' })).toHaveText('Inbound Comms Response (1)');

    // AND-ed with an agent: one card, and the Today count follows the agent.
    await page.locator('.apv-filter', { hasText: 'Inbound Comms Response' }).click();
    expect(await order(page)).toEqual(['recHighNew']);
    await expect(page.locator('[data-apv-today]')).toHaveText('Today (1)');

    // Select all ticks the shown card only, never one the chips hide.
    await page.click('[data-apv-select-all]');
    expect(await page.evaluate(() => apvBulkIds())).toEqual(['recHighNew']);

    await page.locator('.apv-filter-clear').click();
    expect(await order(page)).toEqual(DEFAULT_ORDER);
    await expect(page.locator('[data-apv-today]')).toHaveText('Today (2)');
  });

  test('a bulk verdict runs in screen order with Newest first on', async ({ page }) => {
    await mockAgentsPage(page, fixtures());
    await loadAgentsPage(page);
    await openApprovals(page);
    await page.click('[data-apv-newest]');
    await page.click('[data-apv-select-all]');
    expect(await page.evaluate(() => apvBulkIds())).toEqual(NEWEST_ORDER);
  });
});

// The dispatcher's stamp: London wall-clock time, minute precision (note_line in scripts/agent-dispatch.py).
function londonStamp(ms, withTime = true) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return `${p.day} ${p.month.slice(0, 3)} ${p.year}` + (withTime ? ` ${p.hour}:${p.minute}` : '');
}

function notesFixtures() {
  const MIN = 60 * 1000;
  const now = new Date();
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const m0 = midnight.getTime();
  const floorMin = (ms) => Math.floor(ms / MIN) * MIN;
  const todayEarly = floorMin(m0 + (now.getTime() - m0) * 0.3);
  const nowIso = now.toISOString();
  const line = (ms, who, text, withTime = true) => `[${londonStamp(ms, withTime)} — ${who}] ${text}`;
  const submitted = (ms, round) => line(ms, 'agent-dispatch', `SUBMITTED (round ${round}) as Admin with no new file`);
  const card = (id, name, notes, extra = {}) => ({ id, createdTime: new Date(m0 - 10 * 24 * HOUR).toISOString(), fields: Object.assign({
    [TF.name]: name, [TF.status]: 'Approval', [TF.priority]: 'High',
    [TF.agentOutput]: `Draft: ${name}.`, [TF.notes]: notes,
    [TF.sentForApprovalBy]: [AGENT_A], [TF.teamMember]: [AGENT_A], [TF.lmt]: nowIso, [TF.taskType]: 'Admin',
  }, extra) });
  const fx = defaultFixtures();
  fx.approvals = [
    // Sent three days ago. A track record below quotes another task's newer stamp, indented: never this card's.
    card('recSubOld', 'Renew the licence', [
      submitted(floorMin(m0 - 72 * HOUR), 1),
      'TRACK RECORD:',
      '  > ' + submitted(floorMin(now.getTime()), 4),
    ].join('\n\n')),
    // Sent back after changes: the newest round counts.
    card('recSubToday', 'Chase the deposit', [submitted(floorMin(m0 - 48 * HOUR), 1), submitted(todayEarly, 2)].join('\n\n'),
      { [TF.priority]: 'Medium' }),
    // A decision card stamped with a day and no time: the start of that London day, as the AI team panel reads it.
    card('recEscToday', 'DECIDE: approve the quote', line(m0, 'agent-dispatch', 'Escalated to Kevin as a decision card (holder none): DECIDE: approve?', false)),
    // The same, five days ago, whatever the last edit says.
    card('recEscOld', 'DECIDE: pick a supplier', line(m0 - 5 * 24 * HOUR + 12 * HOUR, 'agent-dispatch', 'Escalated to Kevin as a decision card (holder none): DECIDE: pick?', false)),
    // Your step: back in his lane once he approved it (yesterday) and a wall opened (two days ago).
    card('recStep', 'Sign the council form', [submitted(floorMin(m0 - 96 * HOUR), 1), line(floorMin(m0 - 48 * HOUR), 'agent', 'BLOCKER OPEN (KEVIN signature): sign the form')].join('\n\n'), {
      [TF.agentOutput]: "YOUR STEP: Sign the form and press Done.\n\n----- The agent's work, as you approved it -----\n\nDraft: the council form.",
      [TF.approvalOutcome]: 'Approved as-is', [TF.approvedAt]: new Date(m0 - 14 * HOUR).toISOString() }),
    // A site wall on an ordinary card is the agent's business, not an arrival.
    card('recWallNotStep', 'Book the gas engineer', [submitted(floorMin(m0 - 50 * HOUR), 1), line(todayEarly, 'agent', 'BLOCKER OPEN (SITE example.com): site down')].join('\n\n')),
    // A KEVIN wall is his step, on any card (a KEVIN ONLY submit opens one).
    card('recKevinWall', 'Pay the licence fee', [submitted(floorMin(m0 - 60 * HOUR), 1), line(floorMin(m0 - 20 * HOUR), 'agent-dispatch', 'BLOCKER OPEN (KEVIN payment): pay the fee')].join('\n\n')),
    // No dispatcher line at all: the last edit is all there is.
    card('recNoStamp', 'Note the meter reading', '', { [TF.lmt]: new Date(m0 - 30 * HOUR).toISOString() }),
  ];
  return fx;
}

test.describe('Approval queue: when a card reached him', () => {
  test('Newest first and Today read the dispatcher stamps, not the last edit', async ({ page }) => {
    await mockAgentsPage(page, notesFixtures());
    await loadAgentsPage(page);
    await openApprovals(page);
    await page.click('[data-apv-newest]');
    expect(await order(page)).toEqual(['recSubToday', 'recEscToday', 'recStep', 'recKevinWall', 'recNoStamp', 'recWallNotStep', 'recSubOld', 'recEscOld']);
    await expect(page.locator('[data-apv-today]')).toHaveText('Today (2)');
    await page.click('[data-apv-today]');
    expect(await order(page)).toEqual(['recSubToday', 'recEscToday']);
  });

  test('the waiting tag counts from when it reached him', async ({ page }) => {
    await mockAgentsPage(page, notesFixtures());
    await loadAgentsPage(page);
    await openApprovals(page);
    await expect(page.locator('[data-apv-card="recSubOld"] .apv-age')).toHaveText(/waiting \d+ days/);
    await expect(page.locator('[data-apv-card="recSubOld"] .apv-age')).toHaveClass(/late/);
  });
});
