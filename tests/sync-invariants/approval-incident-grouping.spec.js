// ONE INCIDENT, ONE DECISION (27 Aug 2026).
//
// 13 of the 60 tasks waiting that day were the same four or five incidents
// written up in fresh words each time — three "Invoices Dashboard Apps Script",
// four "Meetings Intake", two "Cloudflare KV", three "Airtable automation".
// Kevin read and decided each one separately, at roughly two and a half
// minutes a go.
//
// dupeTaskKey already grouped them correctly; it was only ever used to FLAG
// duplicates on another tab. Here it does something useful with that answer.
//
// The invariants that keep this safe rather than merely fast:
//   1. A group of one renders exactly as before — the 46 genuine one-off
//      decisions must not change shape.
//   2. The group verdict is REJECT ONLY, and only on relevance reasons.
//      Approving several different pieces of prepared work on one click would
//      approve text Kevin has not read, which is the one thing the gate exists
//      to prevent.
//   3. Every task in the group gets its own PATCH carrying the reason, so the
//      quality/relevance split still sees them.

const { test, expect } = require('@playwright/test');
const { TF, TABLES, AGENT_A, defaultFixtures, mockAgentsPage, loadAgentsPage,
        londonTodayISO } = require('./agents-page.helpers');

const VERDICT_REASON = 'fldF9Bs4N5mttQvtl';

// The REAL task names off the live queue on 27 Aug 2026. Using anything
// invented here would test the key against prose I wrote, not against the way
// an AI actually writes the same incident up twice.
const LIVE_ALERT_NAMES = [
  'INBOUND: Google Apps Script Invoices Dashboard failing, investigate and fix',
  'INBOUND: Invoices Dashboard Apps Script failures',
  'INBOUND: Invoices Dashboard Apps Script failing again',
  'INBOUND: Google Apps Script Meetings Intake failing repeatedly, investigate and fix',
  'INBOUND: Meetings Intake script failing with Gmail quota error',
  'INBOUND: Meetings Intake script failing - Gmail quota exceeded again',
  'INBOUND: Cloudflare KV put limit exceeded - investigate and fix',
  'INBOUND: Cloudflare KV at 90 percent daily limit, review usage and consider upgrade',
  'INBOUND: respond to Burnley Recovery re Liability Order 22 Newton St',
];

function approvalRows() {
  return LIVE_ALERT_NAMES.map((name, i) => ({
    id: `recALERT${String(i).padStart(8, '0')}`,
    createdTime: '2026-08-26T08:00:00.000Z',
    fields: {
      [TF.name]: name,
      [TF.status]: { name: 'Approval' },
      [TF.teamMember]: [AGENT_A.teamMemberId],
      [TF.sentForApprovalBy]: [AGENT_A.teamMemberId],
      [TF.agentOutput]: `Prepared work for: ${name}`,
      [TF.taskType]: { name: 'Analysis' },
      [TF.dueDate]: londonTodayISO(),
      [TF.lmt]: '2026-08-26T08:00:00.000Z',
    },
  }));
}

async function loadWithAlerts(page) {
  const fixtures = defaultFixtures();
  fixtures.approvals = approvalRows();
  const patches = await mockAgentsPage(page, fixtures);
  await loadAgentsPage(page);
  await page.click('#ptab-approvals');
  await expect(page.locator('#view-approvals')).toBeVisible();
  return patches;
}

test.describe('the approvals queue groups one incident into one decision', () => {
  test('the nine live task names collapse into four groups plus one loner', async ({ page }) => {
    await loadWithAlerts(page);
    // Three real clusters get a header; the Burnley task stands alone.
    await expect(page.locator('.apv-group')).toHaveCount(3);
    await expect(page.locator('.apv-card')).toHaveCount(LIVE_ALERT_NAMES.length);

    const counts = await page.locator('.apv-group-count').allTextContents();
    expect(counts.sort()).toEqual(['2 tasks, one thing', '3 tasks, one thing', '3 tasks, one thing']);
  });

  test('a one-off decision is NOT wrapped in a group', async ({ page }) => {
    await loadWithAlerts(page);
    const burnley = page.locator('.apv-card', { hasText: 'Burnley Recovery' });
    await expect(burnley).toHaveCount(1);
    // It must render as a bare card, exactly as the 46 genuine decisions do.
    await expect(burnley.locator('xpath=ancestor::div[contains(@class,"apv-group")]')).toHaveCount(0);
  });

  test('one verdict closes every task in the group, each carrying the reason', async ({ page }) => {
    const patches = await loadWithAlerts(page);
    const group = page.locator('.apv-group', { hasText: 'Meetings Intake' }).first();
    await group.locator('.apv-group-actions .apv-reason', { hasText: 'Not worth my time' }).click();
    await page.locator('button', { hasText: /^Reject all 3$/ }).click();

    await expect.poll(() => patches.filter(p => p.fields[TF.approvalOutcome] === 'Rejected').length)
      .toBe(3);
    const rejected = patches.filter(p => p.fields[TF.approvalOutcome] === 'Rejected');
    // The reason must land on EVERY one, or the split cannot see them and the
    // three come straight back to the drafting agent's score.
    rejected.forEach((p) => {
      expect(p.fields[VERDICT_REASON]).toBe('Not worth my attention');
    });
  });

  test('the group verdict cannot APPROVE — only Kevin reading each draft can', async ({ page }) => {
    await loadWithAlerts(page);
    const group = page.locator('.apv-group').first();
    const labels = await group.locator('.apv-group-actions .apv-reason').allTextContents();
    // Six relevance reasons and nothing else. No approve, and not "The work is
    // wrong" either — that is a judgement on one specific draft.
    expect(labels).toHaveLength(6);
    expect(labels).not.toContain('The work is wrong');
    await expect(group.locator('.apv-group-actions button', { hasText: /Approve/ })).toHaveCount(0);
  });

  test('remembering a group rule writes it ONCE, not once per task', async ({ page }) => {
    const patches = await loadWithAlerts(page);
    const group = page.locator('.apv-group', { hasText: 'Invoices Dashboard' }).first();
    await group.locator('.apv-group-actions .apv-reason', { hasText: 'Already done' }).click();
    await page.locator('#apvGroupRemember').check();
    await page.locator('button', { hasText: /^Reject all 3$/ }).click();

    await expect.poll(() => patches.filter(p => p.fields[TF.approvalOutcome] === 'Rejected').length)
      .toBe(3);
    const remembered = patches.filter(p => p.fields['fldZurhdHutYIDKVx'] === true);
    expect(remembered, 'one tick should teach one rule, not three copies of it').toHaveLength(1);
  });
});
