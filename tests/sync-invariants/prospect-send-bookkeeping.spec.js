// Invariant: the approve-time toast tells the truth about what happened to the EMAIL.
//
// 12 Aug 2026: Kevin approved 18 prospects. All 18 emails sent through GoHighLevel
// perfectly. Then every status write 422'd — the Status field had no "Contacted (1:1)"
// option and patchProspectingRecord sent no typecast — and one catch wrapped both
// steps, so the toast said "the GHL email send failed — the daily agent will send it
// instead". A sent email recorded as unsent is a double-send waiting to happen: the
// agent's catch-up pass re-sends anything left at "Synced to GHL".
//
// Rules under test:
//   1. A bookkeeping failure AFTER a successful send must say the email WAS sent.
//   2. A genuine send failure keeps the original "daily agent will send it" message.
//   3. The PECR gate blocks cold email to non-Ltd entities, but NOT the solicited
//      "Email reply (they asked)" route (skill §4.5 — they publicly asked for help).

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures, makeFixtures, MOCK_PAT } = require('./helpers');

const GHL_KEYS = { key: 'pit_mock_ghl_key', loc: 'locMockOD' };

function prospectFixture(id, over = {}) {
  return {
    id,
    fields: {
      'Name': 'Jane Whitehouse',
      'Company': 'IS Group Signs Limited',
      'Contact Email': 'enquiries@is-group.co.uk',
      'Email Confidence': 'High',
      'Entity Type': 'Limited Company',
      'Contact Route': 'Email sequence (Ltd)',
      'Pain Signal': 'Advertising a part-time Bookkeeper.',
      'Email Subject': 'your part-time bookkeeper ad',
      'Draft Message': 'Hi Jane. Worth a quick call? https://operationsdirector.co.uk/book-a-demo/',
      'Status': 'Ready for Review',
      'Date Found': '2026-08-11',
      ...over,
    },
  };
}

// Registers GHL mocks and records what was called. messagesStatus lets a test
// simulate a genuine send failure.
async function mockGhl(page, { messagesStatus = 201 } = {}) {
  const calls = { contacts: 0, messages: 0 };
  await page.route('**/services.leadconnectorhq.com/contacts/**', async (route) => {
    calls.contacts++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ contact: { id: 'ghlContact1' } }) });
  });
  await page.route('**/services.leadconnectorhq.com/conversations/messages', async (route) => {
    calls.messages++;
    await route.fulfill({
      status: messagesStatus,
      contentType: 'application/json',
      body: JSON.stringify(messagesStatus === 201 ? { messageId: 'm1', msg: 'Email queued successfully.' } : { error: 'boom' }),
    });
  });
  return calls;
}

async function openQueue(page, prospects) {
  await page.addInitScript((k) => {
    localStorage.setItem('od_prospecting_ghl_key', k.key);
    localStorage.setItem('od_prospecting_ghl_location', k.loc);
  }, GHL_KEYS);
  await loadDashboardWithFixtures(page, { prospects, prospectKeywords: makeFixtures().prospectKeywords });
  await page.evaluate(() => switchTab('prospecting'));
  await page.waitForSelector('[data-prospect-id]', { timeout: 15000 });
}

test.describe('Approve-time send: the toast tells the truth', () => {

  test('THE 12 AUG BUG: send succeeds, status write 422s — toast says the email WAS sent', async ({ page }) => {
    const rec = prospectFixture('recProsA');
    const ghl = await mockGhl(page);
    await openQueue(page, [rec]);

    // Specific route registered AFTER load wins; anything that is not the
    // Contacted write falls through to the generic fixture mock.
    await page.route('**/api.airtable.com/v0/**', async (route) => {
      const req = route.request();
      if (req.method() === 'PATCH' && (req.postData() || '').includes('Contacted (1:1)')) {
        await route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({ error: { type: 'INVALID_MULTIPLE_CHOICE_OPTIONS', message: 'no such option' } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.locator('[data-prospect-id="recProsA"]').getByRole('button', { name: 'Approve' }).click();

    // Retry happens after 800ms, then the honest toast.
    await expect(page.locator('body')).toContainText('The email WAS sent', { timeout: 15000 });
    await expect(page.locator('body')).toContainText('do not approve this prospect again');
    await expect(page.locator('body')).not.toContainText('the daily agent will send it instead');
    expect(ghl.messages).toBe(1);
  });

  test('a genuine send failure still says the daily agent will send it', async ({ page }) => {
    const rec = prospectFixture('recProsB');
    const ghl = await mockGhl(page, { messagesStatus: 500 });
    await openQueue(page, [rec]);

    await page.locator('[data-prospect-id="recProsB"]').getByRole('button', { name: 'Approve' }).click();

    await expect(page.locator('body')).toContainText('the daily agent will send it instead', { timeout: 15000 });
    await expect(page.locator('body')).not.toContainText('The email WAS sent');
    expect(ghl.messages).toBe(1);
  });

  test('PECR: a sole trader on the COLD route is never emailed', async ({ page }) => {
    const rec = prospectFixture('recProsC', { 'Entity Type': 'Sole Trader / Partnership' });
    const ghl = await mockGhl(page);
    await openQueue(page, [rec]);

    await page.locator('[data-prospect-id="recProsC"]').getByRole('button', { name: 'Approve' }).click();

    await expect(page.locator('body')).toContainText('only lawful to a Limited Company', { timeout: 15000 });
    expect(ghl.messages).toBe(0);
  });

  test('PECR: a sole trader who publicly ASKED gets the reply (solicited route)', async ({ page }) => {
    const rec = prospectFixture('recProsD', {
      'Entity Type': 'Sole Trader / Partnership',
      'Contact Route': 'Email reply (they asked)',
    });
    const ghl = await mockGhl(page);
    await openQueue(page, [rec]);

    await page.locator('[data-prospect-id="recProsD"]').getByRole('button', { name: 'Approve' }).click();

    await expect(page.locator('body')).toContainText('Email sent via GoHighLevel', { timeout: 15000 });
    expect(ghl.messages).toBe(1);
  });
});
