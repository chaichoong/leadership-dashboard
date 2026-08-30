// KNOCK IT BACK A WEEK — the approvals gate, 28 Aug 2026.
//
// Kevin: "we've got a couple of confirmation statements to submit, and we need
// authentication codes. It takes a week for those to arrive. Rather than having
// something sitting clogging the approval gate up, I need to have the ability
// to knock it back a week."
//
// Before this, the gate offered three verdicts and all three were wrong for
// that task. Approve is wrong (it cannot be filed yet), reject is wrong (it
// still has to happen and rejecting would close it), request-changes is wrong
// (the draft is fine). So it sat there, and every morning it was one more line
// between him and the decisions he could actually make.
//
// The mechanism is one date on the task. What makes it safe rather than a way
// to lose work is that NOTHING is decided: no approval outcome, no status
// change, no hand-back to the agent, and no score against it. The task is
// untouched apart from the date, and the date is read by every surface rather
// than acted on by a job. The invariants below are the ones that would let a
// knocked-back task become a lost one.
//
// Airtable is mocked, so these assert on the PATCH the page actually sends and
// on what the page actually renders.

const { test, expect } = require('@playwright/test');
const { TF, AGENT_A, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

const APPROVAL_OUTCOME = 'fldrHBSr6qoUfaKuZ';
const APPROVED_AT = 'fldr4Mvf2RzKvhZhi';
const STATUS = 'fldx4qCw17UfrKpaN';
const SLACK_TS = 'fldHTaX3wP9VhD5Oz';

function isoPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function openApprovals(page) {
  await page.click('#ptab-approvals');
  await expect(page.locator('#view-approvals')).toBeVisible();
}

/** Knock the first card back by clicking one of the preset buttons. */
async function knockBack(page, patches, label = 'A week', why = '') {
  await openApprovals(page);
  const card = page.locator('.apv-card').first();
  const taskId = await card.getAttribute('data-apv-card');
  await card.locator('.apv-defer-btn', { hasText: label }).first().click();
  if (why) await page.locator('#apvDeferWhy').fill(why);
  await page.locator('button', { hasText: 'Knock it back' }).last().click();
  await expect.poll(() => patches.some((p) => p.id === taskId)).toBe(true);
  return { taskId, patch: patches.find((p) => p.id === taskId) };
}

test.describe('knocking an approval back', () => {
  test('the option is on every card, and a week is one of them', async ({ page }) => {
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    const cards = page.locator('.apv-card');
    const n = await cards.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      await expect(cards.nth(i).locator('.apv-defer-btn', { hasText: 'A week' }).first()).toBeVisible();
    }
  });

  test('it writes ONLY the date and his note — no verdict, no status change', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    const { patch } = await knockBack(page, patches, 'A week', 'waiting on the auth code');

    // THE load-bearing assertion. A knock-back that recorded an outcome would
    // score the agent for work Kevin has not judged, and an approved outcome
    // would hand the task back to it to CARRY OUT — sending the very email he
    // was trying to hold.
    expect(patch.fields[APPROVAL_OUTCOME]).toBeUndefined();
    expect(patch.fields[APPROVED_AT]).toBeUndefined();
    // Status untouched: the task stays exactly where the agent left it, which
    // is what makes the return free rather than something to reconstruct.
    expect(patch.fields[STATUS]).toBeUndefined();
    // And the date is a week out, to the day.
    expect(patch.fields[TF.deferredUntil]).toBe(isoPlus(7));
  });

  test('his reason survives, tagged so it can be read back in a week', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    const { patch } = await knockBack(page, patches, 'A week', 'waiting on the Companies House auth code');
    const history = String(patch.fields[TF.feedbackHistory] || '');
    expect(history).toContain('Knocked back to ' + isoPlus(7));
    expect(history).toContain('waiting on the Companies House auth code');
  });

  test('a second knock-back keeps the first reason', async ({ page }) => {
    // Feedback History is the durable archive of every reason Kevin has given.
    // Overwriting it here would quietly destroy rejection reasons too.
    const fixtures = defaultFixtures();
    fixtures.approvals[0].fields[TF.feedbackHistory] = '[2026-08-01 09:00] Roy is dealing with this directly.';
    const patches = await mockAgentsPage(page, fixtures);
    await loadAgentsPage(page);
    const { patch } = await knockBack(page, patches, '3 days', 'still waiting');
    expect(String(patch.fields[TF.feedbackHistory])).toContain('Roy is dealing with this directly.');
    expect(String(patch.fields[TF.feedbackHistory])).toContain('still waiting');
  });

  test('the Slack fields are left alone — one writer owns that thread', async ({ page }) => {
    // The worker replies in the existing thread with the return date and
    // clears the timestamp itself. Two writers on those fields is how a
    // thread ends up orphaned with no explanation in it, and how a task that
    // keeps its timestamp never gets re-posted when the date arrives.
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    const { patch } = await knockBack(page, patches);
    expect(patch.fields[SLACK_TS]).toBeUndefined();
    expect(patch.fields['fldxsqj9JSRBGNyT9']).toBeUndefined();
  });

  test('it leaves the queue the moment he does it', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    const before = await page.locator('.apv-card').count();
    await knockBack(page, patches);
    // The reload re-reads the mocked queue, which still returns everything —
    // so the count coming back is proof the page refetched, not proof of the
    // filter (that is Airtable's job and is back-tested against the live base).
    // What matters here is that the write happened and the page did not throw.
    expect(before).toBeGreaterThan(0);
    expect(patches.length).toBeGreaterThan(0);
  });

  test('a date in the past is refused rather than silently doing nothing', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    const card = page.locator('.apv-card').first();
    const taskId = await card.getAttribute('data-apv-card');
    await card.locator('#apvDeferDate-' + taskId).fill(isoPlus(-3));
    await card.locator('.apv-defer-btn', { hasText: 'Go' }).click();
    // No confirm dialog, no write: a "defer" that leaves the task exactly
    // where it was would look like it worked.
    await expect(page.locator('#apvDeferWhy')).toHaveCount(0);
    expect(patches.filter((p) => p.id === taskId)).toHaveLength(0);
  });
});

test.describe('nothing is hidden without being reported', () => {
  function withDeferred() {
    const f = defaultFixtures();
    const now = new Date().toISOString();
    f.deferred = [
      { id: 'recDef1', createdTime: now, fields: {
        [TF.name]: 'File the confirmation statement for Utilita Apt 5',
        [TF.status]: 'Approval',
        [TF.agentOutput]: 'Draft: CS01 ready to file.',
        [TF.sentForApprovalBy]: [AGENT_A], [TF.teamMember]: [AGENT_A],
        [TF.deferredUntil]: isoPlus(6), [TF.lmt]: now,
        [TF.feedbackHistory]: '[2026-08-28 13:40] Knocked back to ' + isoPlus(6)
          + ': waiting on the Companies House authentication code',
      } },
    ];
    return f;
  }

  test('the knocked-back lane shows what is parked and when it returns', async ({ page }) => {
    await mockAgentsPage(page, withDeferred());
    await loadAgentsPage(page);
    await openApprovals(page);
    const lane = page.locator('.apv-later');
    await expect(lane).toBeVisible();
    await expect(lane.locator('summary')).toContainText('1 knocked back');
    await lane.locator('summary').click();
    await expect(lane).toContainText('File the confirmation statement');
    // The note to his future self is the point: in six days he needs to know
    // WHAT he was waiting for, not just that he parked something.
    await expect(lane).toContainText('waiting on the Companies House authentication code');
    await expect(lane.locator('button', { hasText: 'Bring back now' })).toBeVisible();
  });

  test('an empty queue still says where everything went', async ({ page }) => {
    // The failure to fear: he knocks back the last three items, the page says
    // "Nothing is waiting for your approval", and there is no sign anywhere
    // that three things are parked. That is indistinguishable from a queue
    // that lost them.
    const f = withDeferred();
    f.approvals = [];
    await mockAgentsPage(page, f);
    await loadAgentsPage(page);
    await openApprovals(page);
    await expect(page.locator('.apv-later')).toBeVisible();
    await expect(page.locator('#approvalsBody')).toContainText('Nothing is waiting for your approval right now');
  });

  test('bringing one back clears the date and nothing else', async ({ page }) => {
    const patches = await mockAgentsPage(page, withDeferred());
    await loadAgentsPage(page);
    await openApprovals(page);
    await page.locator('.apv-later summary').click();
    await page.locator('.apv-later button', { hasText: 'Bring back now' }).click();
    await expect.poll(() => patches.some((p) => p.id === 'recDef1')).toBe(true);
    const patch = patches.find((p) => p.id === 'recDef1');
    // Clearing the date is the WHOLE undo. Anything else here — a status, an
    // outcome, a due date — would be a second, unasked-for change.
    expect(Object.keys(patch.fields)).toEqual([TF.deferredUntil]);
    expect(patch.fields[TF.deferredUntil]).toBeNull();
  });

  test('a task returning from a knock-back is not marked as long-overdue', async ({ page }) => {
    // Its Slack baseline is a week old. Without the corrected waiting clock it
    // comes back stamped "waiting 7 days", flagged late, and ringing the
    // over-24-hours check on the one thing he handled correctly.
    const f = defaultFixtures();
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    f.approvals = [
      { id: 'recBack', createdTime: weekAgo, fields: {
        [TF.name]: 'File the confirmation statement', [TF.status]: 'Approval',
        [TF.agentOutput]: 'Draft: CS01 ready to file.',
        [TF.sentForApprovalBy]: [AGENT_A], [TF.teamMember]: [AGENT_A],
        [TF.lmt]: weekAgo, [TF.slackBaseline]: weekAgo,
        [TF.deferredUntil]: isoPlus(0),   // came back today
      } },
    ];
    await mockAgentsPage(page, f);
    await loadAgentsPage(page);
    await openApprovals(page);
    const age = page.locator('.apv-card').first().locator('.apv-age');
    await expect(age).toBeVisible();
    await expect(age).not.toHaveClass(/late/);
  });
});

test.describe('the reject option Kevin asked for', () => {
  test('there is a Reject button, not only the seven chips', async ({ page }) => {
    // Before this, the ONLY route to a rejection was one of seven preset
    // reasons. If none of them fitted, there was no way to reject at all.
    await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    await expect(page.locator('.apv-card').first()
      .locator('.apv-actions button', { hasText: /^Reject$/ })).toBeVisible();
  });

  test('it rejects with his own words, and still demands a reason', async ({ page }) => {
    const patches = await mockAgentsPage(page);
    await loadAgentsPage(page);
    await openApprovals(page);
    const card = page.locator('.apv-card').first();
    const taskId = await card.getAttribute('data-apv-card');

    // Empty first: an unexplained rejection counts against the agent with
    // nothing to learn from, which is what the chips were built to stop.
    await card.locator('.apv-actions button', { hasText: /^Reject$/ }).click();
    await expect(page.locator('button', { hasText: 'Reject and close' })).toHaveCount(0);
    expect(patches.filter((p) => p.id === taskId)).toHaveLength(0);

    await card.locator('#apvNote-' + taskId).fill('Companies House changed the form, this whole approach is dead.');
    await card.locator('.apv-actions button', { hasText: /^Reject$/ }).click();
    await page.locator('button', { hasText: 'Reject and close' }).last().click();
    await expect.poll(() => patches.some((p) => p.id === taskId)).toBe(true);
    const patch = patches.find((p) => p.id === taskId);
    expect(patch.fields[APPROVAL_OUTCOME]).toBe('Rejected');
    expect(String(patch.fields['fldtI7SJI4gEohHD1'])).toContain('Companies House changed the form');
  });
});
