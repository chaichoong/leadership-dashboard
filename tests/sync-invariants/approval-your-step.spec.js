// YOUR STEP (Kevin, 7 Oct 2026; PR 2 of 5). 13 tasks sat on a step only Kevin could take and
// none was in front of him: the card left this queue the moment he approved it. Now
// scripts/agent-dispatch.py puts such a task back here, still APPROVED, with a YOUR STEP block
// on top of the agent's work. Invariants:
//   1. The card shows the step (as text), the Your turn button when the sweep marked a plan,
//      and a "Done, here is the proof" box; NO approve, edit, change or reject buttons, and no
//      tick box, because it is approved already.
//   2. Done writes his proof into Approval Feedback under KEVIN STEP DONE, keeping any note
//      already there, and never touches the verdict, the status or Approved At.
//   3. No route can write a verdict on it: the card's own write path refuses (a no-op).
//   4. A proof already given shows as given, with no second box.
// Airtable is mocked (agents-page.helpers.js), so this runs with no PAT. Names are invented.
const { test, expect } = require('@playwright/test');
const { TF, AGENT_A, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

const FEEDBACK = 'fldtI7SJI4gEohHD1';
const ID = 'recYourStepAaaaaa';
const DIVIDER = "----- The agent's work, as you approved it -----";
const ES = {
  key: 'fldLO6xJqkokvVR4g', kind: 'fldfjQOn76VpgKEfZ', label: 'fldlnvvTh8l5UIih4', status: 'fldhOUiva3bqPNk1c',
  lastRun: 'flduxV3TYwp9wQX9O', detail: 'fldLRFP2nJttDVQOa', payload: 'fldiqs9lvyLimoR7i', updated: 'fld3q8WN5XqrER92Z',
};

function withStep({ feedback = '', turn = false, step = '1. Sign page 3 <b>now</b>.\n2. Post it to the council.',
                   outcome = 'Approved with minor edits', open = null, sweptAt = undefined, lmt = undefined } = {}) {
  const fx = defaultFixtures();
  const now = new Date().toISOString();
  fx.approvals.push({ id: ID, createdTime: now, fields: {
    [TF.name]: 'INSURANCE: Example Lane cover', [TF.status]: 'Approval', [TF.priority]: 'High',
    [TF.approvalOutcome]: outcome || undefined,
    [TF.agentOutput]: `YOUR STEP: ${step}\n\n${DIVIDER}\n\nQuote ready from Example Insurer, 41 a month.`,
    [FEEDBACK]: feedback, [TF.sentForApprovalBy]: [AGENT_A], [TF.teamMember]: [AGENT_A], [TF.lmt]: lmt || now,
    [TF.taskType]: 'Admin',
  } });
  if (turn || open) {
    fx.estate = [{ id: 'recBlk', fields: {
      [ES.key]: 'agent-blockers', [ES.kind]: 'report', [ES.label]: 'Robots blocked', [ES.status]: 'Worked',
      [ES.lastRun]: now, [ES.updated]: now, [ES.detail]: 'Robots blocked on 1 task.',
      [ES.payload]: JSON.stringify(Object.assign({ open: open || [{ task: ID, name: 'INSURANCE: Example Lane cover', kind: 'KEVIN',
        subject: 'purchase', turn: true, step: '1. Buy it.', yourStep: true }], stale: 0, closedWhileBlocked: [], woken: 0 },
        sweptAt ? { sweptAt } : {})),
    } }];
  }
  return fx;
}

test.describe('Your step: an approved card back in his lane', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' });

  test('shows the step as text, the agent\'s work below, and no verdict buttons or tick box', async ({ page }) => {
    await mockAgentsPage(page, withStep());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator(`[data-apv-card="${ID}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('[data-apv-step-text]')).toHaveText('1. Sign page 3 <b>now</b>.\n2. Post it to the council.');
    await expect(card.locator('[data-apv-step-text] b')).toHaveCount(0);       // escaped, never markup
    await expect(card.locator('[data-apv-work]')).toContainText('Quote ready from Example Insurer');
    await expect(card.locator('[data-apv-work]')).not.toContainText('YOUR STEP');
    await expect(card.locator('button[onclick*="agDecide"]')).toHaveCount(0);
    await expect(card.locator('.apv-defer')).toBeVisible();   // a knock-back to a date is still his
    await expect(card.locator('button', { hasText: /^Approve/ })).toHaveCount(0);
    await expect(card.locator('button', { hasText: 'Request changes' })).toHaveCount(0);
    await expect(card.locator('.apv-reason')).toHaveCount(0);
    await expect(card.locator('[data-apv-pick]')).toHaveCount(0);
    await expect(card.locator('[data-apv-step-done]')).toHaveText('Done, here is the proof');
    await expect(card.locator('[data-apv-step-cant]')).toHaveText("I can't do this");
    await expect(card.locator('.apv-attach-btn')).toBeVisible();
    await expect(card.locator(`#apvRemember-${ID}`)).toHaveCount(0);   // proof is not a standing rule
    // An ordinary card on the same page still has its buttons: the change is scoped to Your step.
    await expect(page.locator('[data-apv-card="recApvB1"] button[onclick*="agDecide"]').first()).toBeVisible();
  });

  test('carries the Your turn button when the sweep marked a plan, from the same row the sign-ins panel reads', async ({ page }) => {
    await mockAgentsPage(page, withStep({ turn: true }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const btn = page.locator(`[data-apv-card="${ID}"] [data-apv-step-turn="${ID}"]`);
    await expect(btn).toHaveAttribute('href', `robotsignin://turn/${ID}`);
    await expect(btn).toHaveText('Your turn');
  });

  test('Done writes the proof under KEVIN STEP DONE, keeps his note, and never touches the verdict', async ({ page }) => {
    const fx = withStep({ feedback: 'Use the business card.' });
    const patches = await mockAgentsPage(page, fx);
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator(`[data-apv-card="${ID}"]`);
    // An empty box writes nothing.
    await card.locator('[data-apv-step-done]').click();
    await page.waitForTimeout(300);
    expect(patches.filter((p) => p.id === ID)).toHaveLength(0);
    await card.locator(`#apvNote-${ID}`).fill('Signed and posted,   recorded delivery EX123');
    await card.locator('[data-apv-step-done]').click();
    await expect.poll(() => patches.filter((p) => p.id === ID).length).toBe(1);
    const p = patches.find((x) => x.id === ID).fields;
    expect(p[FEEDBACK]).toMatch(/^Use the business card\.\nKEVIN STEP DONE \[\d{4}-\d{2}-\d{2}T[0-9:.]+Z\]: Signed and posted, recorded delivery EX123$/);
    expect(p[TF.feedbackHistory]).toMatch(/Done, here is the proof: Signed and posted, recorded delivery EX123$/);
    for (const k of [TF.approvalOutcome, TF.approvedAt, TF.status, TF.agentOutput, TF.completionDate]) {
      expect(k in p, `the Done box wrote ${k}`).toBe(false);
    }
    await expect(page.locator(`[data-apv-card="${ID}"] [data-apv-step-said]`)).toContainText('You said it is done');
    await expect(page.locator(`[data-apv-card="${ID}"] [data-apv-step-done]`)).toHaveCount(0);
  });

  test('approving it again is a no-op: the write path refuses it and Select all never ticks it', async ({ page }) => {
    const patches = await mockAgentsPage(page, withStep());
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator(`[data-apv-card="${ID}"]`)).toBeVisible();
    const said = await page.evaluate((id) => window.applyApprovalDecision(id, 'Approved as-is', false), ID);
    expect(said).toBe('elsewhere');
    await page.waitForTimeout(300);
    expect(patches.filter((x) => x.id === ID)).toHaveLength(0);
    const ticked = await page.evaluate((id) => { apvSelectAllShown(); return apvBulkIds().includes(id); }, ID);
    expect(ticked).toBe(false);
  });

  // Kevin, 8 Oct 2026: "I've not been able to attach documents to it like I used to be able to in
  // the approval cards." The box takes a file chosen or dropped, uploads it to the task, and names
  // it on the line; a file alone is proof enough.
  test('attached and dropped files go onto the task and are named on the done line', async ({ page }) => {
    const patches = await mockAgentsPage(page, withStep());
    const uploads = [];
    await page.route('**/content.airtable.com/**', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      uploads.push({ url: route.request().url(), filename: body.filename });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator(`[data-apv-card="${ID}"]`);
    await card.locator(`#apvFile-${ID}`).setInputFiles({ name: 'receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 receipt') });
    await page.evaluate((id) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['png bytes'], 'signed-copy.png', { type: 'image/png' }));
      document.getElementById('apvDrop-' + id).dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, ID);
    await expect(card.locator('.apv-file-chip')).toHaveCount(2);
    await card.locator('[data-apv-step-done]').click();
    await expect.poll(() => patches.filter((p) => p.id === ID).length).toBe(1);
    expect(uploads.map((u) => u.filename)).toEqual(['receipt.pdf', 'signed-copy.png']);
    expect(uploads.every((u) => u.url.includes(`/${ID}/${TF.attachments}/uploadAttachment`))).toBe(true);
    const p = patches.find((x) => x.id === ID).fields;
    expect(p[FEEDBACK]).toMatch(/^KEVIN STEP DONE \[[^\]]+\]: Attached: receipt\.pdf, signed-copy\.png$/);
    expect(p[TF.feedbackHistory]).toMatch(/Done, here is the proof: Attached: receipt\.pdf, signed-copy\.png$/);
    await expect(page.locator(`[data-apv-card="${ID}"] [data-apv-step-said]`))
      .toContainText('Attached: receipt.pdf, signed-copy.png. The robot checks it');
  });

  // Kevin, 8 Oct 2026: a portal opened on a login he has no account for, and the card
  // could only say done. "I can't do this" needs his reason, writes it under KEVIN STEP CANT, and
  // never the verdict: the sweep sends it back to the agent as Changes requested.
  test("I can't do this needs a reason, then writes it under KEVIN STEP CANT and never the verdict", async ({ page }) => {
    const patches = await mockAgentsPage(page, withStep({ feedback: 'Use the business card.' }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator(`[data-apv-card="${ID}"]`);
    await card.locator('[data-apv-step-cant]').click();
    await expect(page.locator('#toast')).toContainText("Say why you can't do it first");
    expect(patches.filter((p) => p.id === ID)).toHaveLength(0);
    await card.locator(`#apvNote-${ID}`).fill('Your turn opens a login page   and we have no account');
    await page.route('**/content.airtable.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await card.locator(`#apvFile-${ID}`).setInputFiles({ name: 'login-screen.png', mimeType: 'image/png', buffer: Buffer.from('png') });
    await card.locator('[data-apv-step-cant]').click();
    await expect.poll(() => patches.filter((p) => p.id === ID).length).toBe(1);
    const p = patches.find((x) => x.id === ID).fields;
    expect(p[FEEDBACK]).toMatch(/^Use the business card\.\nKEVIN STEP CANT \[\d{4}-\d{2}-\d{2}T[0-9:.]+Z\]: Your turn opens a login page and we have no account\. Attached: login-screen\.png$/);
    expect(p[TF.feedbackHistory]).toMatch(/I can't do this step: Your turn opens a login page and we have no account\. Attached: login-screen\.png$/);
    for (const k of [TF.approvalOutcome, TF.approvedAt, TF.status, TF.agentOutput, TF.completionDate]) {
      expect(k in p, `the can't button wrote ${k}`).toBe(false);
    }
    const said = page.locator(`[data-apv-card="${ID}"] [data-apv-step-said]`);
    await expect(said).toContainText("You said you can't do this");
    await expect(said).toContainText('we have no account. Attached: login-screen.png. Within half an hour it goes back to');
    await expect(said).toContainText('as Request changes, to find another way');
    await expect(page.locator(`[data-apv-card="${ID}"] [data-apv-step-cant]`)).toHaveCount(0);
  });

  test("a can't already given shows as given, the newer line winning over an older done", async ({ page }) => {
    await mockAgentsPage(page, withStep({ feedback:
      'KEVIN STEP DONE [2026-10-07T10:00:00.000Z]: paid\nKEVIN STEP CANT [2026-10-07T11:00:00.000Z]: the form wants a director' }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator(`[data-apv-card="${ID}"]`);
    await expect(card.locator('[data-apv-step-said]')).toContainText("You said you can't do this");
    await expect(card.locator('[data-apv-step-said]')).toContainText('the form wants a director');
    await expect(card.locator('[data-apv-step-done]')).toHaveCount(0);
  });

  test('a proof already given shows as given, with no second box', async ({ page }) => {
    await mockAgentsPage(page, withStep({ feedback: 'KEVIN STEP DONE [2026-10-07T10:00:00.000Z]: paid, ref EX-12' }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator(`[data-apv-card="${ID}"]`);
    await expect(card.locator('[data-apv-step-said]')).toContainText('paid, ref EX-12');
    await expect(card.locator('[data-apv-step-done]')).toHaveCount(0);
  });
});

// Kevin, 8 Oct 2026: "we seem to have bits everywhere: some sign-ins at the top, some sign-ins on cards,
// some cards that need sign-ins but don't have the buttons." A SIGN-IN or SITE wall puts its task in the
// queue as a card with its one button, whatever its verdict, and a Your step card's Your turn button
// shows the moment the card arrives.
const TURN_SENTENCE = 'Press Your turn on the AI Agents page, on your Mac: the robot fills in everything up to your step and hands you the window.';
test.describe("a robot's sign-in is a card", () => {
  test.use({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' });

  test('a SIGN-IN wall on unapproved work is a card with Sign in, I can\'t do this and the knock-back, and no verdict or Done', async ({ page }) => {
    await mockAgentsPage(page, withStep({ outcome: '', step: 'ROBOT SIGN-IN: portal.broker.example. A robot is blocked until it is signed in to Broker portal. Press Sign in.' }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator(`[data-apv-card="${ID}"]`);
    await expect(card.locator('.apv-step-head')).toHaveText('A robot needs you to sign it in. Nothing else is asked of you.');
    await expect(card.locator('[data-apv-step-signin]')).toHaveAttribute('href', 'robotsignin://site/portal.broker.example');
    await expect(card.locator('[data-apv-step-signin]')).toHaveText('Sign in');
    await expect(card.locator('[data-apv-step-cant]')).toBeVisible();
    await expect(card.locator('[data-apv-step-done]')).toHaveCount(0);
    await expect(card.locator('button[onclick*="agDecide"]')).toHaveCount(0);
    await expect(card.locator('.apv-defer')).toBeVisible();
    await expect(card.locator('[data-apv-step-turn]')).toHaveCount(0);
  });

  test('a flat opens its own profile, and a SITE wall adds the exact address', async ({ page }) => {
    await mockAgentsPage(page, withStep({ outcome: '', step: 'ROBOT SIGN-IN: my.utilita.example (utilita-apt2). A robot is blocked until it is signed in to Flat 2.' }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator(`[data-apv-card="${ID}"] [data-apv-step-signin]`)).toHaveAttribute('href', 'robotsignin://profile/utilita-apt2');
    await mockAgentsPage(page, withStep({ outcome: 'Approved as-is', step: 'ROBOT SITE: www.clips.example. A robot is blocked until www.clips.example is on its list.' }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const btn = page.locator(`[data-apv-card="${ID}"] [data-apv-step-signin]`);
    await expect(btn).toHaveAttribute('href', 'robotsignin://add/www.clips.example');
    await expect(btn).toHaveText('+ Add this site');
    await expect(page.locator(`[data-apv-card="${ID}"] .apv-step-head`)).toHaveText('A robot needs a site added to its list. Nothing else is asked of you.');
  });

  test("I can't on a robot card writes the reason; the page never writes a done line for one", async ({ page }) => {
    const patches = await mockAgentsPage(page, withStep({ outcome: '', step: 'ROBOT SIGN-IN: portal.broker.example. Blocked.' }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    const card = page.locator(`[data-apv-card="${ID}"]`);
    expect(await page.evaluate((id) => window.apvStepDone(id), ID)).toBe('elsewhere');
    await card.locator(`#apvNote-${ID}`).fill('We have no account there.');
    await card.locator('[data-apv-step-cant]').click();
    await expect.poll(() => patches.filter((p) => p.id === ID).length).toBe(1);
    expect(patches.find((x) => x.id === ID).fields[FEEDBACK]).toMatch(/^KEVIN STEP CANT \[[^\]]+\]: We have no account there\.$/);
  });

  test('a plain step on unapproved work is still never a Your step card', async ({ page }) => {
    await mockAgentsPage(page, withStep({ outcome: '' }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator(`[data-apv-card="${ID}"][data-apv-your-step]`)).toHaveCount(0);
  });
});

test.describe('Your turn shows the moment the card arrives', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' });
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const OTHER = [{ task: 'recOtherTaskAaaaa', name: 'Other', kind: 'KEVIN', subject: 'payment', turn: false }];

  test('before the sweep has looked, the card that says Press Your turn has the button', async ({ page }) => {
    await mockAgentsPage(page, withStep({ step: 'Answer the declarations. ' + TURN_SENTENCE, open: OTHER, sweptAt: ago(20), lmt: ago(2) }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator(`[data-apv-card="${ID}"] [data-apv-step-turn="${ID}"]`)).toHaveAttribute('href', `robotsignin://turn/${ID}`);
  });

  test('once the sweep has looked, its verdict stands: no button for a plan it did not mark', async ({ page }) => {
    await mockAgentsPage(page, withStep({ step: 'Answer the declarations. ' + TURN_SENTENCE, open: OTHER, sweptAt: ago(1), lmt: ago(30) }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator(`[data-apv-card="${ID}"]`)).toBeVisible();
    await expect(page.locator(`[data-apv-card="${ID}"] [data-apv-step-turn]`)).toHaveCount(0);
  });

  test('a plan the sweep has refused gets no button, even on a card written since', async ({ page }) => {
    const refused = [{ task: ID, name: 'INSURANCE: Example Lane cover', kind: 'KEVIN', subject: 'purchase', turn: false,
      planProblem: 'step 6 (kevin) needs say and one of untilUrl' }];
    await mockAgentsPage(page, withStep({ step: 'Answer the declarations. ' + TURN_SENTENCE, open: refused, sweptAt: ago(20), lmt: ago(2) }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator(`[data-apv-card="${ID}"]`)).toBeVisible();
    await expect(page.locator(`[data-apv-card="${ID}"] [data-apv-step-turn]`)).toHaveCount(0);
  });

  test('a card without the sentence (a plan being fixed) has no button before the sweep either', async ({ page }) => {
    await mockAgentsPage(page, withStep({ step: "Answer the declarations. The robot's plan for your window is being fixed.", open: OTHER, sweptAt: ago(20), lmt: ago(2) }));
    await loadAgentsPage(page);
    await page.click('#ptab-approvals');
    await expect(page.locator(`[data-apv-card="${ID}"]`)).toBeVisible();
    await expect(page.locator(`[data-apv-card="${ID}"] [data-apv-step-turn]`)).toHaveCount(0);
  });
});
