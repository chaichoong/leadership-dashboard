// THE ATTACHMENT THAT OPENED A BLANK SCREEN (27 Aug 2026).
//
// The approvals gate tells Kevin to open the agent's file "before you
// decide". Clicking it opened a new tab that stayed white for ever, so the
// one instruction on the card was the one thing that did not work — and the
// tab still LOOKED like it was loading, which is why it read as a slow page
// rather than a bug for weeks.
//
// The cause is a single word. The handler opened the tab up front:
//
//     const tab = window.open('', '_blank', 'noopener');
//
// so the click still counted as the gesture that permits a pop-up, then
// re-read the task and pointed that tab at a freshly signed URL. But the HTML
// standard says window.open() returns NULL whenever 'noopener' is set — there
// is deliberately no handle to a window you promised not to keep. So `tab`
// was always null, `if(tab) tab.location = ...` never ran, and the blank tab
// was orphaned. Every `if(tab) tab.close()` was dead for the same reason, so
// the error paths could not clean up either. Nothing threw, and no console
// error was ever logged. Reproduced in Kevin's own Chrome before the fix:
// window.open('','_blank','noopener') → null, window.open('','_blank') → a
// real window handle.
//
// The three invariants below are what make it stay fixed:
//
//   1. The tab Kevin gets actually lands on the file. This is the bug.
//   2. It lands on the URL from the RE-READ, not the one rendered at page
//      load. Airtable's attachment links are short-lived and this queue exists
//      because things wait, so a card open since this morning holds an expired
//      link. "Simplifying" the handler away to the plain href would look fine
//      in every test that does not check WHICH url was used.
//   3. A pop-up the browser refuses says so. A silently-dead click is the
//      same failure as the original bug from where Kevin is sitting.
//
// Airtable is mocked, and so is the attachment host, so this is hermetic.

const { test, expect } = require('@playwright/test');
const { TABLES, TF, AGENT_A, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

const TASK_ID = 'recApvFile';
const FILENAME = 'letter-of-authority.pdf';
// What the card renders at page load: the link that will have expired.
const STALE_URL = 'https://v5.airtableusercontent.com/v3/u/stale/loa.pdf';
// What re-reading the task returns: the live link Kevin must actually get.
const FRESH_URL = 'https://v5.airtableusercontent.com/v3/u/fresh/loa.pdf';

/** One approval carrying an agent-attached deliverable. */
function withAttachment() {
  const now = new Date().toISOString();
  return {
    approvals: [
      { id: TASK_ID, createdTime: now, fields: {
        [TF.name]: 'Letter of authority for HMRC', [TF.status]: 'Approval',
        [TF.agentOutput]: 'Drafted the letter of authority and attached it for your signature.',
        [TF.priority]: 'High', [TF.taskType]: 'Drafting',
        [TF.sentForApprovalBy]: [AGENT_A], [TF.teamMember]: [AGENT_A], [TF.lmt]: now,
        [TF.attachments]: [{ id: 'attMock1', filename: FILENAME, size: 20480, url: STALE_URL }],
      } },
    ],
  };
}

/**
 * Serve the attachment host, and rotate the signed URL on the single-record
 * re-read the way Airtable does. Registered after mockAgentsPage so it wins;
 * everything else falls through to the shared handler.
 */
async function mockAttachmentHost(page) {
  await page.route('**v5.airtableusercontent.com/**', async (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>the file</title>' }));
  await page.route('**/api.airtable.com/**', async (route) => {
    const url = route.request().url();
    if (route.request().method() === 'GET' && url.includes(`${TABLES.tasks}/${TASK_ID}`)) {
      const rec = withAttachment().approvals[0];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ...rec,
        fields: { ...rec.fields, [TF.attachments]: [{ id: 'attMock1', filename: FILENAME, size: 20480, url: FRESH_URL }] },
      }) });
    }
    return route.fallback();
  });
}

async function attachmentLink(page) {
  await page.click('#ptab-approvals');
  await expect(page.locator('#view-approvals')).toBeVisible();
  const link = page.locator(`[data-apv-card="${TASK_ID}"] .apv-agent-file`, { hasText: FILENAME });
  await expect(link, 'the card must offer the agent’s file').toBeVisible();
  return link;
}

test.describe('an attachment on the approvals gate opens', () => {
  test('the new tab lands on the file, not a blank screen', async ({ page, context }) => {
    await mockAgentsPage(page, withAttachment());
    await mockAttachmentHost(page);
    await loadAgentsPage(page);
    const link = await attachmentLink(page);

    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);

    // THE BUG: with 'noopener' the handler holds no reference to this tab, so
    // it sits on about:blank for ever. Poll — the navigation follows an async
    // re-read, so the first url() is legitimately about:blank.
    await expect.poll(() => popup.url(), {
      message: 'the attachment tab never navigated — it stayed blank',
      timeout: 10000,
    }).not.toBe('about:blank');

    // INVARIANT 2: the freshly signed link, never the one rendered at load.
    expect(popup.url(), 'opened the stale page-load URL instead of re-reading the task').toBe(FRESH_URL);
    await popup.close();
  });

  test('a file no longer on the task closes the tab and says so', async ({ page, context }) => {
    await mockAgentsPage(page, withAttachment());
    await page.route('**v5.airtableusercontent.com/**', async (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>the file</title>' }));
    // Re-read returns the task with the attachment gone (Kevin deleted it in
    // Airtable while the queue sat open).
    await page.route('**/api.airtable.com/**', async (route) => {
      const url = route.request().url();
      if (route.request().method() === 'GET' && url.includes(`${TABLES.tasks}/${TASK_ID}`)) {
        const rec = withAttachment().approvals[0];
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          ...rec, fields: { ...rec.fields, [TF.attachments]: [] },
        }) });
      }
      return route.fallback();
    });
    await loadAgentsPage(page);
    const link = await attachmentLink(page);

    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);

    // close() was dead code while window.open returned null, so the orphan
    // tab is exactly the symptom that has to stay fixed.
    await expect.poll(() => popup.isClosed(), {
      message: 'the tab was left open on a file that is gone',
      timeout: 10000,
    }).toBe(true);
    await expect(page.locator('#toast')).toContainText('no longer on this task');
  });

  test('a blocked pop-up tells Kevin instead of doing nothing', async ({ page }) => {
    await mockAgentsPage(page, withAttachment());
    // Every browser that refuses a pop-up returns null here. Without a branch
    // for it the click is silently dead, which reads as the original bug.
    await page.addInitScript(() => { window.open = () => null; });
    await loadAgentsPage(page);
    const link = await attachmentLink(page);
    await link.click();
    await expect(page.locator('#toast')).toContainText('blocked the new tab');
  });
});
