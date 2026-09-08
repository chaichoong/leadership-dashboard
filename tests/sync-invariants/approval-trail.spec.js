// The dated trail on the approval card (Kevin, 8 Sep 2026): the file this
// round uses is marked and first, earlier files say when they came, and
// "What has happened so far" lists every stamped event in date order with
// the latest day marked, including the SENT stamp and the TRACK RECORD.
const { test, expect } = require('@playwright/test');
const { TF, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

function withTrail() {
  const fx = defaultFixtures();
  const r = fx.approvals[1]; // recApvA2: a plain Correspondence card
  r.createdTime = '2026-09-01T08:00:00.000Z'; // opened before the stamps, so the order is fixed
  r.fields[TF.agentOutput] = 'Draft: lowest possible plan.\n\n**Carrying this out will involve:** posting the letter with the cover attached.';
  r.fields[TF.notes] = [
    '[03 Sep 2026 10:12 — agent] ATTACHED: loa.pdf — signed letter of authority',
    '[03 Sep 2026 10:13 — agent-dispatch] SUBMITTED (round 1) as Correspondence with loa.pdf',
    '[05 Sep 2026 09:00 — send-letter] SENT: letter 123 posted via Pingen to HMRC Self Assessment',
    '[08 Sep 2026 — create-agent-task] TRACK RECORD: (searched tasks + Gmail for email hmrc@example.com)\n- 03 Jul 2026 09:06 — email: Kevin Brittain: Re: Outstanding penalty\n- 07 Sep 2026 — task: task opened: INBOUND: HMRC penalty',
    '[08 Sep 2026 08:34 — agent] ATTACHED: cover.pdf — cover letter for the second posting',
    '[08 Sep 2026 08:35 — agent-dispatch] SUBMITTED (round 2) as Correspondence with cover.pdf',
  ].join('\n\n');
  r.fields[TF.feedbackHistory] = '[2026-09-04 11:02] Too soft. Ask for a freeze first.';
  r.fields[TF.attachments] = [
    { id: 'att1', filename: 'loa.pdf', url: 'https://example.com/loa.pdf', size: 2048, type: 'application/pdf' },
    { id: 'att2', filename: 'notice.pdf', url: 'https://example.com/notice.pdf', size: 900, type: 'application/pdf' },
    { id: 'att3', filename: 'cover.pdf', url: 'https://example.com/cover.pdf', size: 1000, type: 'application/pdf' },
  ];
  return fx;
}

test.describe('the file this round uses, and the dated trail', () => {
  test('one line names the document the agent will use, with an Open button; other files live in the trail (8 Sep 2026)', async ({ page }) => {
    await mockAgentsPage(page, withTrail());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator('[data-apv-card="recApvA2"]');
    await expect(card.locator('.apv-ask-stem')).toHaveText('If you approve, the agent will:');
    const doc = card.locator('[data-apv-doc-line]');
    await expect(doc).toContainText('The document the agent will use:');
    await expect(doc.locator('[data-apv-file]')).toHaveCount(1);
    await expect(doc.locator('[data-apv-file]')).toHaveAttribute('data-apv-file', 'cover.pdf');
    // No separate files block any more: the earlier and sender files are trail rows.
    await expect(card.locator('[data-apv-files]')).toHaveCount(0);
    await card.locator('[data-apv-trail] summary').click();
    await expect(card.locator('[data-apv-trail] [data-apv-file="loa.pdf"]')).toBeVisible();
    await expect(card.locator('[data-apv-trail] [data-apv-file="notice.pdf"]')).toBeVisible();
    await expect(card.locator('[data-apv-trail] .apv-trail-row', { hasText: 'Came with the task: notice.pdf' })).toHaveCount(1);
  });

  test('a promise to post a document with no file this round shows a red warning, never nothing', async ({ page }) => {
    const fx = defaultFixtures();
    fx.approvals[1].fields[TF.agentOutput] = 'Letter ready.\n\n**Carrying this out will involve:** uploading the combined PDF to Pingen, then posting it by 1st class to HMRC.';
    await mockAgentsPage(page, fx);
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator('[data-apv-card="recApvA2"] [data-apv-doc-missing]')).toContainText('No document was attached this round');
  });

  test('the trail lists every dated event oldest first, shows the SENT letter and the track record, and marks the latest day', async ({ page }) => {
    await mockAgentsPage(page, withTrail());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator('[data-apv-card="recApvA2"]');
    const trail = card.locator('[data-apv-trail]');
    await expect(trail).toBeVisible();
    await expect(trail.locator('summary')).toContainText('The story so far · 12 steps');
    await expect(trail.locator('summary')).toContainText('latest: 8 Sep 2026');
    await trail.locator('summary').click();
    const rows = trail.locator('.apv-trail-row');
    await expect(rows).toHaveCount(12);
    // Oldest first: the track record's July email leads, the round-2 submit ends.
    await expect(rows.nth(0)).toContainText('Re: Outstanding penalty');
    await expect(rows.nth(0)).toHaveAttribute('data-apv-trail-kind', 'record');
    await expect(rows.last()).toContainText('Sent for your approval (round 2');
    // Plain words: the SENT stamp reads as a posting; Kevin's own round says "you".
    await expect(trail.locator('[data-apv-trail-kind="sent"]')).toContainText('Letter posted to HMRC Self Assessment');
    await expect(trail.locator('[data-apv-trail-kind="kevin"] .apv-trail-who')).toHaveText('you');
    // Every row that has somewhere to go carries an Open button: the file rows and the email.
    await expect(trail.locator('.apv-trail-row', { hasText: 'File added: cover.pdf' }).locator('.apv-trail-open')).toHaveAttribute('href', 'https://example.com/cover.pdf');
    await expect(trail.locator('.apv-trail-row', { hasText: 'Email 1 received' }).locator('.apv-trail-open')).toHaveAttribute('href', /mail\.google\.com/);
    await expect(trail.locator('.apv-trail-row', { hasText: 'Searched tasks + Gmail' })).toHaveCount(1);
    // Day headers in order; only the last day is marked latest.
    const days = trail.locator('.apv-trail-day');
    await expect(days.first()).toHaveText('3 Jul 2026');
    await expect(days.last()).toContainText('8 Sep 2026 · latest');
    await expect(trail.locator('.apv-trail-day.latest')).toHaveCount(1);
    // Open state survives a silent redraw.
    await page.evaluate(() => window.apvSilentRefresh());
    await expect(card.locator('[data-apv-trail]')).toHaveAttribute('open', '');
  });

  test('a card with no stamps shows its files as before and no trail', async ({ page }) => {
    const fx = defaultFixtures();
    fx.approvals[1].fields[TF.attachments] = [{ id: 'att9', filename: 'bill.pdf', url: 'https://example.com/bill.pdf', size: 500, type: 'application/pdf' }];
    await mockAgentsPage(page, fx);
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator('[data-apv-card="recApvA2"]');
    // No stamps and no document promise: no document line, and the sender's
    // file is the trail's only step.
    await expect(card.locator('[data-apv-doc-line]')).toHaveCount(0);
    await card.locator('[data-apv-trail] summary').click();
    await expect(card.locator('[data-apv-trail] [data-apv-file="bill.pdf"]')).toBeVisible();
  });
});
