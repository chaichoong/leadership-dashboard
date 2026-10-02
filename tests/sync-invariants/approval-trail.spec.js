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

  test('a mention of the sender\'s file or "no attachment needed" never warns; an unstamped file is offered as an earlier one', async ({ page }) => {
    const fx = defaultFixtures();
    fx.approvals[1].fields[TF.agentOutput] = 'Reply ready.\n\n**Carrying this out will involve:** emailing HMRC a reply; no attachment is needed, the statement they attached is on file.';
    fx.approvals[2].fields[TF.agentOutput] = 'Letter ready.\n\n**Carrying this out will involve:** posting the letter with the LOA attached.';
    fx.approvals[2].fields[TF.attachments] = [{ id: 'attOld', filename: 'loa.pdf', url: 'https://example.com/loa.pdf', size: 500, type: 'application/pdf' }];
    await mockAgentsPage(page, fx);
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator('[data-apv-card="recApvA2"] [data-apv-doc-line]')).toHaveCount(0);
    const earlier = page.locator('[data-apv-card="recApvB1"] [data-apv-doc-earlier]');
    await expect(earlier).toContainText('Uses a file from an earlier round');
    await expect(earlier.locator('[data-apv-file="loa.pdf"]')).toBeVisible();
    await expect(page.locator('[data-apv-card="recApvB1"] [data-apv-doc-missing]')).toHaveCount(0);
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
    // Open on arrival since 23 Sep 2026: no click to read the story.
    await expect(trail).toHaveAttribute('open', '');
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
    await expect(card.locator('[data-apv-trail] [data-apv-file="bill.pdf"]')).toBeVisible();
  });
});

// Kevin, 2 Oct 2026 (close-out of the decision-card fix): "Do it now". An earlier draft kept under a decision card
// is quoted line by line so nothing in it reads as the card's own line. The quoting also hid that draft's history
// from the story: its TRACK RECORD lines start "> - 03 Sep 2026", which the parser stopped at.
test.describe('an earlier draft quoted under a decision card', () => {
  function withQuotedDraft() {
    const fx = defaultFixtures();
    const r = fx.approvals[1];
    r.createdTime = '2026-09-01T08:00:00.000Z';
    r.fields[TF.notes] = '';
    r.fields[TF.feedbackHistory] = '';
    r.fields[TF.attachments] = [];
    r.fields[TF.agentOutput] = [
      'DECIDE: Pay the round now, or wait?',
      'WHAT THIS IS:\nThe monthly round.',
      'TRACK RECORD: (searched tasks for ref round)\n- 20 Sep 2026 — task: completed: September round (https://airtable.com/appX/tblY/recNEWHISTORY0001)',
      'Earlier output:\n> Draft reply to the bank.\n>\n> TRACK RECORD: (searched tasks + Gmail for email bank@example.com)\n'
        + '> - 03 Sep 2026 08:47 — Kevin: This will be done on the 6th. (https://airtable.com/appX/tblY/recOLDHISTORY0001)\n'
        + '> - 04 Sep 2026 — email: Bank: Your statement is ready\n>\n> Kind regards\n> - 05 Sep 2026 — not history: this line sits after the draft\'s sign-off',
    ].join('\n\n');
    return fx;
  }

  test('its dated history lines show in the story with their links, and the story stops where the history stops', async ({ page }) => {
    await mockAgentsPage(page, withQuotedDraft());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const trail = page.locator('[data-apv-card="recApvA2"] [data-apv-trail]');
    // the card's own history, as before
    await expect(trail.locator('.apv-trail-row', { hasText: 'completed: September round' })).toHaveCount(1);
    // the quoted draft's history: both lines, the first with its Open link
    const old = trail.locator('.apv-trail-row', { hasText: 'Kevin: This will be done on the 6th.' });
    await expect(old).toHaveCount(1);
    await expect(old.locator('.apv-trail-open')).toHaveAttribute('href', 'https://airtable.com/appX/tblY/recOLDHISTORY0001');
    await expect(trail.locator('.apv-trail-row', { hasText: 'Bank: Your statement is ready' })).toHaveCount(1);
    // a dated bullet after the block has ended is not history
    await expect(trail.locator('.apv-trail-row', { hasText: 'not history' })).toHaveCount(0);
    // and the quote marks never reach the story
    await expect(trail.locator('.apv-trail-row', { hasText: '>' })).toHaveCount(0);
  });
});

// 2 Oct 2026: the history lists a file held on ANOTHER task, and its Open button carried Airtable's signed file
// link, which dies within hours. Five such buttons sat dead on three waiting cards (the first: a servicing PDF on
// the Mears invoice card, HTTP 410). The row now links the task that holds the file and the button re-reads that
// task for a live link. Rows written before the fix still carry the dead link: their task is found from the
// "task opened" row of the same name and day, and a row whose task cannot be found gets no button rather than a
// dead one. The independent review added: a name shared by two tasks, a name cut at 90 characters that ends in a
// space, a block quoted under a decision card, a step listed twice, and the dead link in the agent's full work.
test.describe('a file on another task, listed in the history', () => {
  const HOLDER = 'recHOLDSTHEFILE01';
  const OLD_HOLDER = 'recWATERBILL00001';
  const WEEKLY_HOLDER = 'recWEEKLYCHECK002';
  const CUT_HOLDER = 'recCUTNAMEHOLDER1';
  const REPEAT_HOLDER = 'recREPEATHOLDER01';
  const QUOTED_HOLDER = 'recQUOTEDHOLDER01';
  const JOB_B = 'recJOBBHOLDER0001';
  const FRESH = 'https://v5.airtableusercontent.com/v3/u/fresh/';
  const DEAD = 'https://v5.airtableusercontent.com/v3/u/dead/';

  function withHeldFiles() {
    const fx = defaultFixtures();
    const r = fx.approvals[1];
    r.createdTime = '2026-10-01T08:00:00.000Z';
    r.fields[TF.feedbackHistory] = '';
    r.fields[TF.attachments] = [];
    r.fields[TF.agentOutput] = [
      'Draft reply.',
      // the agent pasted a newer block: this row has its task link, the copy in Notes below has only the dead one
      `TRACK RECORD: (searched tasks for ref S772844)\n- 15 Sep 2026 — file: file on that task: repeat.pdf (12 KB) — from "A task whose opening line was cut" (https://airtable.com/appX/tblY/${REPEAT_HOLDER})`,
      // an earlier draft kept under a decision card is quoted line by line
      'Earlier output:\n> TRACK RECORD: (searched tasks for ref S772844)\n'
        + `> - 16 Sep 2026 — task: task opened: Quoted holder (Completed) (https://airtable.com/appX/tblY/${QUOTED_HOLDER})\n`
        + `> - 16 Sep 2026 — file: file on that task: quoted.pdf (40 KB) — from "Quoted holder" (${DEAD}quoted.pdf)`,
      '**Carrying this out will involve:** sending the reply.',
    ].join('\n\n');
    r.fields[TF.notes] = '[01 Oct 2026 — create-agent-task] TRACK RECORD: (searched tasks for ref S772844)\n' + [
      // written since the fix: the row links the task that holds the file
      `- 30 Jul 2026 — file: file on that task: Servicing_1024091608.pdf (706 KB) — from "INBOUND: New Servicing Job Raised (S772844)" (https://airtable.com/appX/tblY/${HOLDER})`,
      // written before it: the dead signed link, and the "task opened" row that names its task
      // (the name ends in brackets, like the servicing job that showed the bug)
      `- 11 Sep 2026 — task: task opened: INBOUND: Water bill forwarded for review (WB-1024) (Completed) (https://airtable.com/appX/tblY/${OLD_HOLDER})`,
      `- 11 Sep 2026 — file: file on that task: tenancy.pdf (170 KB) — from "INBOUND: Water bill forwarded for review (WB-1024)" (${DEAD}tenancy.pdf)`,
      // its "task opened" row was cut from the block
      `- 12 Sep 2026 — file: file on that task: orphan.png (2191 KB) — from "CONTENT: the opening line was cut" (${DEAD}orphan.png)`,
      // one name, two tasks opened the same day: nothing says which one holds the file
      '- 14 Sep 2026 — task: task opened: Monthly round (Completed) (https://airtable.com/appX/tblY/recROUNDAUGUST001)',
      '- 14 Sep 2026 — task: task opened: Monthly round (Today) (https://airtable.com/appX/tblY/recROUNDSEPTEMBR1)',
      `- 14 Sep 2026 — file: file on that task: statement.pdf (88 KB) — from "Monthly round" (${DEAD}statement.pdf)`,
      // one name, two tasks opened on different days: the file row carries its own task's day
      '- 20 Sep 2026 — task: task opened: Weekly check (Completed) (https://airtable.com/appX/tblY/recWEEKLYCHECK001)',
      `- 27 Sep 2026 — task: task opened: Weekly check (Today) (https://airtable.com/appX/tblY/${WEEKLY_HOLDER})`,
      `- 27 Sep 2026 — file: file on that task: check.pdf (9 KB) — from "Weekly check" (${DEAD}check.pdf)`,
      // a name cut at 90 characters ends in a space; the "task opened" row has lost the double space
      `- 28 Sep 2026 — task: task opened: CONTENT: Five signs your business runs on you. Score three or (Completed) (https://airtable.com/appX/tblY/${CUT_HOLDER})`,
      `- 28 Sep 2026 — file: file on that task: od.png (2191 KB) — from "CONTENT: Five signs your business runs on you. Score three or " (${DEAD}od.png)`,
      // the same step as in the agent's work above, written here with the dead link and no "task opened" row
      `- 15 Sep 2026 — file: file on that task: repeat.pdf (12 KB) — from "A task whose opening line was cut" (${DEAD}repeat.pdf)`,
      // a note on another task that quoted a file link: not a file row, and never a button
      `- 29 Sep 2026 — agent: saved the scan (${DEAD}scan.pdf)`,
      // a note that quotes a file row is a note: its button opens the task, not a file
      `- 30 Sep 2026 — agent: copied from the history: file on that task: quoted-in-a-note.pdf (https://airtable.com/appX/tblY/${HOLDER})`,
      // two files of one name the same day, from tasks whose names share their first words: only the second
      // task's opening line is here, and its link must never land on the first file's row
      `- 02 Sep 2026 — task: task opened: INBOUND: Notification about your property - Job B (Completed) (https://airtable.com/appX/tblY/${JOB_B})`,
      `- 02 Sep 2026 — file: file on that task: image001.png (3 KB) — from "INBOUND: Notification about your property - Job A" (${DEAD}a.png)`,
      `- 02 Sep 2026 — file: file on that task: image001.png (3 KB) — from "INBOUND: Notification about your property - Job B" (${DEAD}b.png)`,
    ].join('\n');
    return fx;
  }

  // The task that holds a file, as a re-read returns it: a freshly signed link.
  async function mockHolders(page, context, files) {
    await context.route('**v5.airtableusercontent.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>the file</title>' }));
    await context.route('https://airtable.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>the task</title>' }));
    await page.route('**/api.airtable.com/**', async (route) => {
      const hit = /\/(rec[A-Za-z0-9]{14})\?/.exec(route.request().url());
      if (route.request().method() === 'GET' && hit && files[hit[1]]) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          id: hit[1], createdTime: '2026-07-30T08:00:00.000Z',
          fields: { [TF.attachments]: files[hit[1]].map((filename, i) => ({ id: 'att' + i, filename, size: 1024, url: FRESH + filename.trim() })) },
        }) });
      }
      return route.fallback();
    });
  }

  async function openTrail(page) {
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    return page.locator('[data-apv-card="recApvA2"] [data-apv-trail]');
  }

  test('Open re-reads the task that holds the file and lands on a live link', async ({ page, context }) => {
    await mockAgentsPage(page, withHeldFiles());
    // Airtable holds the name with a stray space; the history prints it stripped, and it must still be found.
    await mockHolders(page, context, { [HOLDER]: ['Servicing_1024091608.pdf '] });
    const trail = await openTrail(page);
    const open = trail.locator('.apv-trail-row', { hasText: 'Servicing_1024091608.pdf' }).locator('.apv-trail-open');
    await expect(open).toHaveAttribute('data-apv-file-task', HOLDER);
    await expect(open).toHaveAttribute('href', `https://airtable.com/appX/tblY/${HOLDER}`);
    const [popup] = await Promise.all([context.waitForEvent('page'), open.click()]);
    await expect.poll(() => popup.url(), { timeout: 10000 }).toBe(FRESH + 'Servicing_1024091608.pdf');
    await popup.close();
  });

  test('a row written with the dead link finds its task by name, and no history button points at a signed file link', async ({ page, context }) => {
    await mockAgentsPage(page, withHeldFiles());
    await mockHolders(page, context, { [OLD_HOLDER]: ['tenancy.pdf'] });
    const trail = await openTrail(page);
    const open = trail.locator('.apv-trail-row', { hasText: 'tenancy.pdf' }).locator('.apv-trail-open');
    await expect(open).toHaveAttribute('data-apv-file-task', OLD_HOLDER);
    const hrefs = await trail.locator('[data-apv-trail-kind="record"] .apv-trail-open').evaluateAll((as) => as.map((a) => a.href));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((h) => /airtableusercontent/.test(h))).toEqual([]);
    const [popup] = await Promise.all([context.waitForEvent('page'), open.click()]);
    await expect.poll(() => popup.url(), { timeout: 10000 }).toBe(FRESH + 'tenancy.pdf');
    await popup.close();
  });

  test('a row whose task cannot be told gets no button, never a dead one', async ({ page, context }) => {
    await mockAgentsPage(page, withHeldFiles());
    await mockHolders(page, context, {});
    const trail = await openTrail(page);
    for (const name of ['orphan.png', 'statement.pdf', 'saved the scan']) {
      const row = trail.locator('.apv-trail-row', { hasText: name });
      await expect(row).toHaveCount(1);
      await expect(row.locator('.apv-trail-open')).toHaveCount(0);
    }
  });

  test('the right task is found when a name is shared, cut short, quoted, or the step is listed twice', async ({ page, context }) => {
    await mockAgentsPage(page, withHeldFiles());
    await mockHolders(page, context, {});
    const trail = await openTrail(page);
    const holder = { 'check.pdf': WEEKLY_HOLDER, 'od.png': CUT_HOLDER, 'quoted.pdf': QUOTED_HOLDER, 'repeat.pdf': REPEAT_HOLDER, 'tenancy.pdf': OLD_HOLDER };
    for (const [name, task] of Object.entries(holder)) {
      const row = trail.locator('.apv-trail-row', { hasText: `file on that task: ${name}` });
      await expect(row, name).toHaveCount(1);
      await expect(row.locator('.apv-trail-open'), name).toHaveAttribute('data-apv-file-task', task);
      await expect(row.locator('.apv-trail-open'), name).toHaveAttribute('data-apv-file', name);
    }
    // One row, Job A's, with no button. Job B's row is dropped by the 80-character step key (old behaviour); what
    // matters here is that B's link never lands on A's row.
    const twins = trail.locator('.apv-trail-row', { hasText: 'file on that task: image001.png' });
    await expect(twins).toHaveCount(1);
    await expect(twins).toContainText('Job A');
    await expect(twins.locator('.apv-trail-open')).toHaveCount(0);
    // A note that quotes a file row keeps a plain link to the task.
    const note = trail.locator('.apv-trail-row', { hasText: 'copied from the history' }).locator('.apv-trail-open');
    await expect(note).toHaveAttribute('href', `https://airtable.com/appX/tblY/${HOLDER}`);
    expect(await note.getAttribute('data-apv-file')).toBeNull();
  });

  test('nothing on the card links to a signed file link, the agent\'s full work included', async ({ page, context }) => {
    await mockAgentsPage(page, withHeldFiles());
    await mockHolders(page, context, {});
    await openTrail(page);
    const card = page.locator('[data-apv-card="recApvA2"]');
    // the work is on the card (open or not), with its dead link left as text
    await expect(card.locator('[data-apv-work]')).toContainText(DEAD + 'quoted.pdf');
    const hrefs = await card.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThan(5);
    expect(hrefs.filter((h) => /airtableusercontent/.test(h))).toEqual([]);
  });

  test('a file that has since left its task opens the task instead', async ({ page, context }) => {
    await mockAgentsPage(page, withHeldFiles());
    await mockHolders(page, context, { [HOLDER]: ['something-else.pdf'] });
    const trail = await openTrail(page);
    const open = trail.locator('.apv-trail-row', { hasText: 'Servicing_1024091608.pdf' }).locator('.apv-trail-open');
    const [popup] = await Promise.all([context.waitForEvent('page'), open.click()]);
    await expect.poll(() => popup.url(), { timeout: 10000 }).toBe(`https://airtable.com/appX/tblY/${HOLDER}`);
    await popup.close();
  });
});
