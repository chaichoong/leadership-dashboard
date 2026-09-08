// The dated trail on the approval card (Kevin, 8 Sep 2026): the file this
// round uses is marked and first, earlier files say when they came, and
// "What has happened so far" lists every stamped event in date order with
// the latest day marked, including the SENT stamp and the TRACK RECORD.
const { test, expect } = require('@playwright/test');
const { TF, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

function withTrail() {
  const fx = defaultFixtures();
  const r = fx.approvals[1]; // recApvA2: a plain Correspondence card
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
  test('files list newest first, the current round marked, earlier ones dated, unstamped ones named as such', async ({ page }) => {
    await mockAgentsPage(page, withTrail());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator('[data-apv-card="recApvA2"]');
    const files = card.locator('[data-apv-files] [data-apv-file]');
    await expect(files).toHaveCount(3);
    await expect(files.nth(0)).toHaveAttribute('data-apv-file', 'cover.pdf');
    await expect(files.nth(0)).toHaveAttribute('data-apv-file-round', 'latest');
    await expect(files.nth(0)).toContainText('Latest, this round');
    await expect(files.nth(1)).toHaveAttribute('data-apv-file', 'loa.pdf');
    await expect(files.nth(1)).toHaveAttribute('data-apv-file-round', 'earlier');
    await expect(files.nth(1)).toContainText('earlier, 3 Sep 2026');
    await expect(files.nth(2)).toHaveAttribute('data-apv-file-round', 'unknown');
    await expect(files.nth(2)).toContainText('from the sender or earlier');
    await expect(card.locator('[data-apv-files] .apv-agent-files-label')).toContainText('The file this round uses');
  });

  test('the trail lists every dated event oldest first, shows the SENT letter and the track record, and marks the latest day', async ({ page }) => {
    await mockAgentsPage(page, withTrail());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator('[data-apv-card="recApvA2"]');
    const trail = card.locator('[data-apv-trail]');
    await expect(trail).toBeVisible();
    await expect(trail.locator('summary')).toContainText('What has happened so far · 9 events');
    await expect(trail.locator('summary')).toContainText('last: 8 Sep 2026');
    await trail.locator('summary').click();
    const rows = trail.locator('.apv-trail-row');
    await expect(rows).toHaveCount(9);
    // Oldest first: the track record's July email leads, the round-2 submit ends.
    await expect(rows.nth(0)).toContainText('Re: Outstanding penalty');
    await expect(rows.nth(0)).toHaveAttribute('data-apv-trail-kind', 'record');
    await expect(rows.last()).toContainText('SUBMITTED (round 2)');
    // The SENT stamp is there, marked as a send; Kevin's own round is marked as his.
    await expect(trail.locator('[data-apv-trail-kind="sent"]')).toContainText('letter 123 posted via Pingen');
    await expect(trail.locator('[data-apv-trail-kind="kevin"] .apv-trail-who')).toHaveText('Kevin');
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
    await expect(card.locator('[data-apv-files] .apv-agent-files-label')).toContainText('File on this task');
    await expect(card.locator('[data-apv-trail]')).toHaveCount(0);
  });
});
