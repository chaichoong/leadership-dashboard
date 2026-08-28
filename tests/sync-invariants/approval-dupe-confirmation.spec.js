// SAME MATTER, DIFFERENT WORDS (28 Aug 2026).
//
// Kevin, working the queue that morning: "there's still a lot where I seem to
// see some duplication with something referencing the same issue but with
// slightly different information, so we just need a little bit better
// confirmation of that."
//
// Measured against the 55 tasks waiting: the exact key grouped them into 43
// cards and missed SEVEN real pairs. All seven are in this file, verbatim off
// the live queue, because a fixture I invent tests my own prose rather than the
// way an AI actually writes one incident up twice.
//
// The three things the key alone could not do:
//   1. It keeps only two distinctive words, so "Sefton Council" and "pay
//      Sefton" differ.
//   2. It deletes every number — and a phone number IS the identity.
//   3. It splits on the lane prefix, so one SMS thread appears in both.
//
// And the two directions this must NOT go, both found by testing rather than
// by reasoning:
//   * An address says WHERE, not WHICH. Kevin has ~27 properties with many
//     open tasks each; counting address words would eventually fold a garden
//     complaint into a rent arrears chase at the same house.
//   * One shared word is a coincidence.

const { test, expect } = require('@playwright/test');
const { TF, AGENT_A, AGENT_B, defaultFixtures, mockAgentsPage, loadAgentsPage,
        londonTodayISO } = require('./agents-page.helpers');

/** Evaluate the page's OWN dupe functions — never a copy of them. */
async function verdict(page, a, b, mode = 'group') {
  return page.evaluate(([x, y, m]) => {
    const key = (n) => dupeTaskKey(n || '') || 'id:none';
    if (key(x) === key(y)) return { match: true, why: 'same subject' };
    return dupeVerdict(x, y, m);
  }, [a, b, mode]);
}

test.describe('duplicate detection catches the pairs Kevin was seeing twice', () => {
  test.beforeEach(async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
  });

  // The seven, verbatim off the live queue of 28 Aug 2026.
  const REAL_PAIRS = [
    ['two slots is not enough for "Sefton Council" vs "pay Sefton"',
     'INBOUND: Sefton Council HMO licence fee 150 unpaid 23 Viola St Bootle urgent',
     'INBOUND: pay Sefton landlord licence fee 150 GBP for 23 Viola Street Bootle'],
    ['a verb is not identity: "respond to X" is X',
     'INBOUND: Anglia Revenues council tax arrears further recovery - call or respond',
     'INBOUND: respond to Anglia Revenues re council tax arrears (Kevin & Ciara)'],
    ['word order moved the distinctive pair',
     'INBOUND: Stripe Boost 100 payouts paused - provide business info urgently',
     'INBOUND: Stripe action required - provide business info for Boost 100'],
    ['a house number is the identity, and the key deleted it',
     'INBOUND: 1406 Oldham Road electrical safety cert outstanding - Hannah Lea chasing',
     'INBOUND (follow-up): 1406 Oldham Road EICR cert - send to Manchester Council'],
    ['one SMS thread, once in each lane',
     'INBOUND: SMS reply from +447538631747',
     'MAINTENANCE: SMS from 447538631747 - maintenance reply'],
    ['the same number written three different ways',
     'INBOUND: Incoming SMS from +447738707077',
     'MAINTENANCE: SMS reply from 447738707077 - unknown content'],
    ['same sender, same matter, different summary',
     'MAINTENANCE: SSE Energy Solutions important information',
     'MAINTENANCE: SSE Energy Solutions smart meter national upgrade notice'],
  ];

  for (const [why, a, b] of REAL_PAIRS) {
    test(`catches: ${why}`, async ({ page }) => {
      const v = await verdict(page, a, b);
      expect(v.match, `${a}\n  vs\n${b}`).toBe(true);
      expect(v.why, 'a grouping with no stated reason is one Kevin has to take on trust')
        .toBeTruthy();
    });
  }

  test('says WHY in words Kevin can check, not a key', async ({ page }) => {
    expect((await verdict(page,
      'INBOUND: SMS reply from +447538631747',
      'MAINTENANCE: SMS from 447538631747 - maintenance reply')).why)
      .toBe('same phone 538631747');
    expect((await verdict(page,
      'INBOUND: Sefton Council HMO licence fee 150 unpaid 23 Viola St Bootle urgent',
      'INBOUND: pay Sefton landlord licence fee 150 GBP for 23 Viola Street Bootle')).why)
      .toContain('licence');
  });
});

test.describe('and does not group things that merely look alike', () => {
  test.beforeEach(async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
  });

  test('an address is WHERE, not WHICH — the expensive direction to get wrong', async ({ page }) => {
    // Same property, different obligation. Four shared words, three of them
    // the address. This is the one that would have shipped a bug.
    expect((await verdict(page,
      'INBOUND: Sefton Council HMO licence fee 150 unpaid 23 Viola St Bootle urgent',
      'INBOUND: action overdue licensing tasks 23 Viola Street Bootle - EICR and Gas')).match)
      .toBe(false);
    expect((await verdict(page,
      'MAINTENANCE: 18 Siddows Avenue Clitheroe - garden condition council complaint',
      'MAINTENANCE: 18 Siddows Avenue Clitheroe - rent arrears chase')).match)
      .toBe(false);
  });

  test('one shared word is a coincidence', async ({ page }) => {
    expect((await verdict(page,
      'Warm lane second touch: approve 18 close-the-loop emails',
      'Prospecting deliverability check: the emails ARE landing')).match).toBe(false);
  });

  test('two DIFFERENT phone numbers never merge on the words around them', async ({ page }) => {
    // The case that proves DUPE_ACTION_WORDS earns its place, found by running
    // the real queue with and without it. Both tasks say "SMS" and "reply";
    // without the action-word list those two words carry the match and FOUR
    // tasks covering TWO separate threads collapse into one cluster. Kevin
    // would be told they are one thing, and they are not.
    expect((await verdict(page,
      'INBOUND: SMS reply from +447538631747',
      'MAINTENANCE: SMS reply from 447738707077 - unknown content')).match).toBe(false);
    expect((await verdict(page,
      'INBOUND: Incoming SMS from +447738707077',
      'MAINTENANCE: SMS from 447538631747 - maintenance reply')).match).toBe(false);
  });

  test('two different creditors are not one matter', async ({ page }) => {
    expect((await verdict(page,
      'INBOUND: POST: HM Revenue and Customs - HMRC LateTaxReturnPenalty MrsCMBrittain',
      'INBOUND: POST: Companies House - CompaniesHouse ActionToStrikeOff SocialHousing')).match)
      .toBe(false);
  });

  test('FOLDING never crosses a lane, even on a shared phone number', async ({ page }) => {
    // Grouping shows; folding destroys. A maintenance job absorbed into a
    // reply task is a real obligation lost, so the destructive path keeps the
    // lane rule the display path drops.
    const pair = ['INBOUND: SMS reply from +447538631747',
                  'MAINTENANCE: SMS from 447538631747 - maintenance reply'];
    expect((await verdict(page, ...pair, 'group')).match).toBe(true);
    expect((await verdict(page, ...pair, 'fold')).match).toBe(false);
  });
});

test.describe('the queue shows the evidence on the group', () => {
  test('every cluster states why, and a single task never claims one', async ({ page }) => {
    const rows = [
      'INBOUND: SMS reply from +447538631747',
      'MAINTENANCE: SMS from 447538631747 - maintenance reply',
      'INBOUND: respond to Burnley Recovery re Liability Order 22 Newton St',
    ];
    const f = defaultFixtures();
    f.approvals = rows.map((name, i) => ({
      id: `recDUP${String(i).padStart(9, '0')}`, createdTime: '2026-08-27T08:00:00.000Z',
      fields: {
        [TF.name]: name, [TF.status]: { name: 'Approval' },
        [TF.teamMember]: [AGENT_A], [TF.sentForApprovalBy]: [AGENT_A],
        [TF.agentOutput]: 'Prepared work.', [TF.taskType]: { name: 'Analysis' },
        [TF.dueDate]: londonTodayISO(), [TF.lmt]: '2026-08-27T08:00:00.000Z',
      },
    }));
    await mockAgentsPage(page, f);
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');

    await expect(page.locator('.apv-group')).toHaveCount(1);
    await expect(page.locator('.apv-group-why')).toHaveCount(1);
    await expect(page.locator('.apv-group-why')).toContainText('same phone 538631747');
    // The Burnley task is a genuine one-off and must stay a bare card.
    await expect(page.locator('.apv-card', { hasText: 'Burnley' })
      .locator('xpath=ancestor::div[contains(@class,"apv-group")]')).toHaveCount(0);
  });
});

test.describe('the Duplicates lane sees what the queue sees', () => {
  // Two blind spots, both fixed 28 Aug 2026. It keyed on dupeTaskKey alone, so
  // it reported CLEAN while seven real pairs sat in the gate. And it bucketed
  // by OWNER, which made a cross-agent duplicate invisible by design — two
  // agents doing one job is worse than one agent doing it twice, not better.
  // AGENT_A / AGENT_B are plain Team Member record ids, and this fixture's
  // status is a bare string — matching defaultFixtures().openTasks exactly.
  const openTask = (id, name, agent) => ({
    id, createdTime: '2026-08-20T08:00:00.000Z',
    fields: {
      [TF.name]: name, [TF.status]: 'This Week',
      [TF.teamMember]: [agent], [TF.dueDate]: londonTodayISO(),
      [TF.lmt]: '2026-08-20T08:00:00.000Z',
    },
  });

  test('catches a pair the exact key misses, and says why', async ({ page }) => {
    const f = defaultFixtures();
    f.openTasks = [
      openTask('recD1', 'INBOUND: Sefton Council HMO licence fee 150 unpaid 23 Viola St Bootle urgent', AGENT_A),
      openTask('recD2', 'INBOUND: pay Sefton landlord licence fee 150 GBP for 23 Viola Street Bootle', AGENT_A),
    ];
    await mockAgentsPage(page, f);
    await loadAgentsPage(page);
    await page.click('#ptab-checks');
    const lane = page.locator('.chk-item, .check-item, li, tr').filter({ hasText: 'same job' }).first();
    await expect(lane).toContainText('licence');
  });

  test('a duplicate ACROSS two agents is reported, not hidden', async ({ page }) => {
    const f = defaultFixtures();
    f.openTasks = [
      openTask('recX1', 'INBOUND: SMS reply from +447538631747', AGENT_A),
      openTask('recX2', 'MAINTENANCE: SMS from 447538631747 - maintenance reply', AGENT_B),
    ];
    await mockAgentsPage(page, f);
    await loadAgentsPage(page);
    await page.click('#ptab-checks');
    await expect(page.locator('#checksBody')).toContainText('both have an open task for the same job');
    await expect(page.locator('#checksBody')).toContainText('same phone 538631747');
  });
});
