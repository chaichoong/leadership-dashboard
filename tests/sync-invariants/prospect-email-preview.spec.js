// Invariant: the Prospecting review card shows the REAL email, and approving sends that email.
//
// Before 7 Aug 2026 the card showed a bare textarea. Kevin could not see who it came from,
// who it went to, what the subject was, or how it signed off, and the body carried the raw
// api.leadconnectorhq.com widget URL on 131 of 136 records. He was about to approve 131
// emails he had never actually seen.
//
// Rule: one builder (buildProspectEmail) produces both the preview and the sent email. A
// second code path is how a preview starts lying about what goes out.

const { test, expect } = require('@playwright/test');
const { loadDashboard } = require('./helpers');

const CARD = '[data-prospect-id="recProsLtd"]';

async function openProspecting(page) {
  await loadDashboard(page);
  await page.evaluate(() => switchTab('prospecting'));
  await page.waitForSelector('[data-prospect-id]', { timeout: 15000 });
}

test.describe('Prospecting email preview', () => {

  test('control — the review queue renders the fixture prospects', async ({ page }) => {
    await openProspecting(page);
    // Guards against a vacuous pass: every assertion below is scoped to a card,
    // and a selector typo would silently match nothing.
    expect(await page.locator('[data-prospect-id]').count()).toBe(3);
  });

  test('shows who it is from, who it goes to, and the subject', async ({ page }) => {
    await openProspecting(page);
    const card = page.locator(CARD);
    await expect(card).toContainText('Kevin Brittain <kevin@operationsdirector.co.uk>');
    await expect(card).toContainText('Jane Whitehouse <enquiries@is-group.co.uk>');
    await expect(card.locator('input[data-subject-for="recProsLtd"]'))
      .toHaveValue('your part-time bookkeeper ad');
  });

  test('renders the body signed off, with a clickable booking link', async ({ page }) => {
    await openProspecting(page);
    const preview = page.locator('[data-email-preview="recProsLtd"]');
    await expect(preview).toContainText('Hi Jane, I saw your part-time bookkeeper ad');
    await expect(preview).toContainText('Founder, Operations Director');
    const link = preview.locator('a[href="https://operationsdirector.co.uk/book-a-demo/"]');
    await expect(link).toHaveCount(1);
  });

  test('the preview updates live as the wording is edited', async ({ page }) => {
    await openProspecting(page);
    await page.fill(`textarea[data-draft-for="recProsLtd"]`, 'Completely rewritten opener.');
    const preview = page.locator('[data-email-preview="recProsLtd"]');
    await expect(preview).toContainText('Completely rewritten opener.');
    await expect(preview).not.toContainText('bookkeeper ad');
    // The signature survives an edit — it is not part of the editable body.
    await expect(preview).toContainText('Founder, Operations Director');
  });

  test('a blank subject falls back rather than sending an empty subject line', async ({ page }) => {
    await openProspecting(page);
    const subject = page.locator('input[data-subject-for="recProsLtd"]');
    await subject.fill('');
    // The placeholder tells Kevin what will actually be used.
    await expect(subject).toHaveAttribute('placeholder', 'A thought for IS Group Signs Limited');
  });

  test('non-email routes get no envelope, no subject and no signature', async ({ page }) => {
    await openProspecting(page);
    const card = page.locator('[data-prospect-id="recProsLinkedIn"]');
    await expect(card.locator('[data-email-preview="recProsLinkedIn"]')).toHaveCount(0);
    await expect(card.locator('input[data-subject-for="recProsLinkedIn"]')).toHaveCount(0);
    await expect(card).not.toContainText('Founder, Operations Director');
    // It still has an editable message.
    await expect(card.locator('textarea[data-draft-for="recProsLinkedIn"]')).toHaveCount(1);
  });

  test('warns on a draft still carrying the raw CRM widget URL, and fixes it in one click', async ({ page }) => {
    await openProspecting(page);
    const card = page.locator('[data-prospect-id="recProsStale"]');
    await expect(card).toContainText('old raw booking link');

    await card.getByRole('button', { name: 'Use the website link' }).click();

    const draft = await page.inputValue('textarea[data-draft-for="recProsStale"]');
    expect(draft).toContain('https://operationsdirector.co.uk/book-a-demo/');
    expect(draft).not.toContain('api.leadconnectorhq.com');
    await expect(card).not.toContainText('old raw booking link');
  });

  test('approving sends the subject and body that were on screen', async ({ page }) => {
    await openProspecting(page);
    await page.fill('textarea[data-draft-for="recProsLtd"]', 'Edited body before approval.');
    await page.fill('input[data-subject-for="recProsLtd"]', 'edited subject');

    const writes = [];
    page.on('request', req => {
      if (req.method() === 'PATCH' && req.url().includes('tbljHVGJoKJf8acy3')) {
        try { writes.push(req.postDataJSON()); } catch {}
      }
    });

    await page.locator(CARD).getByRole('button', { name: 'Approve' }).click();
    await page.waitForTimeout(1200);

    const saved = JSON.stringify(writes);
    expect(saved).toContain('Edited body before approval.');
    expect(saved).toContain('edited subject');
  });

  test('no console errors while rendering the previews', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await openProspecting(page);
    await page.fill('textarea[data-draft-for="recProsLtd"]', 'typing triggers a re-render');
    await page.waitForTimeout(400);
    expect(errors.filter(e => /prospect|email|preview/i.test(e))).toHaveLength(0);
  });
});
