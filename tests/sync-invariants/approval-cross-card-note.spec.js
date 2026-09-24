// ONE NOTE, EVERY CARD IT FITS (Kevin, 24 Sep 2026).
//
// On 23 Sep he told the agents three times in one evening that Haverhill now
// has approved EICR and gas contractors (rec0D35XfxR2QgvIX at 14:10 and 23:31,
// recZcjAT1ODRYQPMf at 23:37). A note landed on the one task it was typed on;
// nothing read the other cards already waiting. And the Remember box sat in
// the reject row, read for rejections only, so none of those notes (all given
// on approvals) was ever kept as a standing rule.
//
// The invariants:
//   1. Saving a note sends it, with every OTHER waiting card, to the model,
//      and the cards it names carry a strip with the note and the reason.
//      A card it does not name, or an id that is not a waiting card, gets
//      nothing.
//   2. Nothing moves until he taps. "Send back with my note" writes Request
//      changes with his words and where they came from, and never sets
//      Remember on the copy (the card he wrote on carries the rule).
//   3. A tap never goes further than his own verdict: a rejection's copy is
//      a rejection with the same reason, never an approval.
//   4. A failed or unreadable check says so on screen. It never reads as
//      "none look affected".
//   5. Remember sits beside the note, ticked, and is written for an approval
//      or a Request changes that carries words; never for a decision with
//      none.
//   6. No check for a decision with no note, for "Duplicate" (the card most
//      like a duplicate is the one being KEPT), or for the bulk bar.
//
// Airtable and the AI proxy are mocked: these assert on the PATCHes the page
// sends and the prompt it posts. The model's judgement itself was back-tested
// live on real cards (the fix's report); a fixture cannot test that.

const { test, expect } = require('@playwright/test');
const { TF, AGENT_B, defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

const REMEMBER_THIS = 'fldZurhdHutYIDKVx';
const APPROVAL_FEEDBACK = 'fldtI7SJI4gEohHD1';
const VERDICT_REASON = 'fldF9Bs4N5mttQvtl';
const PROXY_HOST = 'claude-proxy.kevinbrittain.workers.dev';

const HAVERHILL_NOTE = 'We now have approved contractors for EICRs and gas safety certificates for Haverhill, so no need to find further quotes.';

function card(id, name, work) {
  const now = new Date().toISOString();
  return { id, createdTime: now, fields: {
    [TF.name]: name, [TF.status]: 'Approval', [TF.priority]: 'Medium',
    [TF.agentOutput]: `${work}\n\n**Carrying this out will involve:** sending this email.`,
    [TF.sentForApprovalBy]: [AGENT_B], [TF.teamMember]: [AGENT_B], [TF.lmt]: now, [TF.taskType]: 'Correspondence',
  } };
}

function queue() {
  const fx = defaultFixtures();
  fx.approvals = [
    card('recSrc', 'CORRESPONDENCE: EICR quote request - ELECSI (5 Dalham Place)', 'Draft quote request to ELECSI for 5 Dalham Place, Haverhill, CB9 0AL.'),
    card('recGas', 'COMPLIANCE: GSC quote chase - 6 Chedburgh Place', 'Chasing a gas safety certificate quote for 6 Chedburgh Place, Haverhill, CB9 0AJ.'),
    card('recBootle', 'COMPLIANCE: EICR quote reply - 23 Viola Street Bootle', 'EICR quote reply for 23 Viola Street, Bootle L20 7DR.'),
  ];
  return fx;
}

/** Route the AI proxy. `answer` is the model's text, or a status number to fail. */
async function mockProxy(page, answer) {
  const calls = [];
  await page.route((url) => url.hostname === PROXY_HOST, async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    calls.push(body);
    if (typeof answer === 'number') return route.fulfill({ status: answer, contentType: 'text/plain', body: 'boom' });
    const text = typeof answer === 'function' ? answer(body) : answer;
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ content: [{ type: 'text', text }] }) });
  });
  return calls;
}

const matchGas = JSON.stringify({ scope: 'standing', matches: [{ id: 'recGas', why: 'Gas quote chase in Haverhill' }] });

async function openApprovals(page) {
  await page.click('#ptab-approvals');
  await expect(page.locator('#view-approvals')).toBeVisible();
}
const cardEl = (page, id) => page.locator(`[data-apv-card="${id}"]`);

async function decideWithNote(page, id, button, note) {
  const c = cardEl(page, id);
  await c.locator(`#apvNote-${id}`).fill(note);
  await c.locator('.apv-actions button', { hasText: new RegExp(`^${button}$`) }).click();
}

test.describe('one note, every card it fits', () => {
  test('a saved note marks the cards the model names, and only those', async ({ page }) => {
    const patches = await mockAgentsPage(page, queue());
    const calls = await mockProxy(page, matchGas);
    await loadAgentsPage(page);
    await openApprovals(page);

    await decideWithNote(page, 'recSrc', 'Approve', HAVERHILL_NOTE);
    await expect.poll(() => patches.some((p) => p.id === 'recSrc')).toBe(true);

    const strip = cardEl(page, 'recGas').locator('.apv-cross');
    await expect(strip).toBeVisible();
    await expect(strip.locator('[data-apv-cross-note]')).toHaveText(HAVERHILL_NOTE);
    await expect(strip.locator('[data-apv-cross-why]')).toContainText('Gas quote chase in Haverhill');
    await expect(strip.locator('[data-apv-cross-why]')).toContainText('EICR quote request - ELECSI (5 Dalham Place)');
    await expect(strip.locator('[data-apv-cross-apply]')).toHaveText('Send back with my note');
    await expect(cardEl(page, 'recBootle').locator('.apv-cross')).toHaveCount(0);
    await expect(page.locator('[data-apv-cross-notice="found"]')).toContainText('may apply to 1 other card');

    // The prompt: his note, every OTHER waiting card, never the one decided,
    // and the model from js/ai-models.js rather than a literal.
    expect(calls.length).toBe(1);
    const prompt = calls[0].messages[0].content;
    expect(prompt).toContain(HAVERHILL_NOTE);
    expect(prompt).toContain('id=recGas');
    expect(prompt).toContain('id=recBootle');
    expect(prompt).not.toContain('id=recSrc');
    expect(calls[0].model).toBe(await page.evaluate(() => window.AI_MODELS.default));
    // Nothing moved on its own.
    expect(patches.some((p) => p.id === 'recGas' || p.id === 'recBootle')).toBe(false);
  });

  test('Send back with my note writes Request changes, his words and their source, no Remember', async ({ page }) => {
    const patches = await mockAgentsPage(page, queue());
    await mockProxy(page, matchGas);
    await loadAgentsPage(page);
    await openApprovals(page);
    await decideWithNote(page, 'recSrc', 'Approve', HAVERHILL_NOTE);
    await cardEl(page, 'recGas').locator('[data-apv-cross-apply]').click();

    await expect.poll(() => patches.some((p) => p.id === 'recGas')).toBe(true);
    const sent = patches.find((p) => p.id === 'recGas');
    expect(sent.fields[TF.approvalOutcome]).toBe('Changes requested');
    expect(sent.fields[APPROVAL_FEEDBACK]).toContain(HAVERHILL_NOTE);
    expect(sent.fields[APPROVAL_FEEDBACK]).toContain('Same as my note on another card ("EICR quote request - ELECSI (5 Dalham Place)")');
    expect(sent.fields[REMEMBER_THIS]).toBeUndefined();
    // Nothing is approved on his behalf.
    expect(String(sent.fields[TF.approvalOutcome])).not.toMatch(/^Approved/);
    await expect(page.locator('[data-apv-cross-notice="found"]')).toHaveCount(0);
  });

  test('the copy of a rejection is a rejection with the same reason', async ({ page }) => {
    const patches = await mockAgentsPage(page, queue());
    await mockProxy(page, matchGas);
    await loadAgentsPage(page);
    await openApprovals(page);
    await cardEl(page, 'recSrc').locator('.apv-reason', { hasText: 'Roy owns it' }).first().click();
    await expect.poll(() => patches.some((p) => p.id === 'recSrc')).toBe(true);

    const apply = cardEl(page, 'recGas').locator('[data-apv-cross-apply]');
    await expect(apply).toHaveText('Close this too, same reason');
    await apply.click();
    await expect.poll(() => patches.some((p) => p.id === 'recGas')).toBe(true);
    const closed = patches.find((p) => p.id === 'recGas');
    expect(closed.fields[TF.approvalOutcome]).toBe('Rejected');
    expect(closed.fields[VERDICT_REASON]).toBe('Roy owns it');
    expect(closed.fields[REMEMBER_THIS]).toBeUndefined();
  });

  test('Send all back applies the note to every marked card', async ({ page }) => {
    const patches = await mockAgentsPage(page, queue());
    await mockProxy(page, JSON.stringify({ matches: [
      { id: 'recGas', why: 'Haverhill gas' }, { id: 'recBootle', why: 'EICR quote' }] }));
    await loadAgentsPage(page);
    await openApprovals(page);
    await decideWithNote(page, 'recSrc', 'Request changes', HAVERHILL_NOTE);
    await page.locator('[data-apv-cross-all]').click();
    await expect.poll(() => ['recGas', 'recBootle'].every((id) => patches.some((p) => p.id === id))).toBe(true);
    for (const id of ['recGas', 'recBootle']) {
      expect(patches.find((p) => p.id === id).fields[TF.approvalOutcome]).toBe('Changes requested');
    }
  });

  test('an id the model invents, or the decided card itself, gets nothing', async ({ page }) => {
    await mockAgentsPage(page, queue());
    await mockProxy(page, JSON.stringify({ matches: [
      { id: 'recNotInQueue', why: 'x' }, { id: 'recSrc', why: 'itself' }] }));
    await loadAgentsPage(page);
    await openApprovals(page);
    await decideWithNote(page, 'recSrc', 'Approve', HAVERHILL_NOTE);
    await expect(page.locator('[data-apv-cross-notice="none"]')).toContainText('None look affected');
    await expect(page.locator('.apv-cross')).toHaveCount(0);
  });

  test('Not this one removes the strip and sends nothing', async ({ page }) => {
    const patches = await mockAgentsPage(page, queue());
    await mockProxy(page, matchGas);
    await loadAgentsPage(page);
    await openApprovals(page);
    await decideWithNote(page, 'recSrc', 'Approve', HAVERHILL_NOTE);
    await cardEl(page, 'recGas').locator('[data-apv-cross-dismiss]').click();
    await expect(cardEl(page, 'recGas').locator('.apv-cross')).toHaveCount(0);
    expect(patches.some((p) => p.id === 'recGas')).toBe(false);
  });

  test('a failed check says so, never "none affected"', async ({ page }) => {
    await mockAgentsPage(page, queue());
    await mockProxy(page, 500);
    await loadAgentsPage(page);
    await openApprovals(page);
    await decideWithNote(page, 'recSrc', 'Approve', HAVERHILL_NOTE);
    await expect(page.locator('[data-apv-cross-notice="failed"]')).toContainText('Could not check the other cards');
    await expect(page.locator('[data-apv-cross-notice="none"]')).toHaveCount(0);
  });

  test('an answer cut off mid-list reads as a failure', async ({ page }) => {
    await mockAgentsPage(page, queue());
    await mockProxy(page, '{"scope":"standing","matches":[{"id":"recGas","why":"Haverhill gas"}');
    await loadAgentsPage(page);
    await openApprovals(page);
    await decideWithNote(page, 'recSrc', 'Approve', HAVERHILL_NOTE);
    await expect(page.locator('[data-apv-cross-notice="failed"]')).toBeVisible();
    await expect(page.locator('.apv-cross')).toHaveCount(0);
  });

  test('an answer with a line and braces after its JSON is still read', async ({ page }) => {
    await mockAgentsPage(page, queue());
    await mockProxy(page, '```json\n' + matchGas + '\n```\nNote: {recBootle} is in another town.');
    await loadAgentsPage(page);
    await openApprovals(page);
    await decideWithNote(page, 'recSrc', 'Approve', HAVERHILL_NOTE);
    await expect(cardEl(page, 'recGas').locator('.apv-cross')).toBeVisible();
  });

  test('Undo on the card he wrote on takes its suggestions back', async ({ page }) => {
    await mockAgentsPage(page, queue());
    await mockProxy(page, matchGas);
    await loadAgentsPage(page);
    await openApprovals(page);
    await decideWithNote(page, 'recSrc', 'Approve', HAVERHILL_NOTE);
    await expect(cardEl(page, 'recGas').locator('.apv-cross')).toBeVisible();
    await cardEl(page, 'recSrc').locator('[data-apv-undo]').click();
    await expect(cardEl(page, 'recGas').locator('.apv-cross')).toHaveCount(0);
    await expect(page.locator('[data-apv-cross-notice]')).toHaveCount(0);
  });

  test('no check without a note, for Duplicate, or from the bulk bar', async ({ page }) => {
    const patches = await mockAgentsPage(page, queue());
    const calls = await mockProxy(page, matchGas);
    await loadAgentsPage(page);
    await openApprovals(page);
    // No words: nothing to carry.
    await cardEl(page, 'recSrc').locator('.apv-actions button', { hasText: /^Approve$/ }).click();
    await expect.poll(() => patches.some((p) => p.id === 'recSrc')).toBe(true);
    // Duplicate: the card most like it is the one being kept.
    await cardEl(page, 'recBootle').locator('.apv-reason', { hasText: 'Duplicate' }).first().click();
    await expect.poll(() => patches.some((p) => p.id === 'recBootle')).toBe(true);
    // Bulk with a note: one decision on the ticked cards, no fan-out.
    await cardEl(page, 'recGas').locator('[data-apv-pick]').check();
    await page.locator('#apvBulk [data-apv-bulk-open="changes"]').click();
    await page.locator('#apvBulkNote-changes').fill(HAVERHILL_NOTE);
    await page.locator('#apvBulk [data-apv-bulk-changes]').click();
    await expect.poll(() => patches.some((p) => p.id === 'recGas')).toBe(true);
    expect(calls.length).toBe(0);
  });
});

test.describe('Remember sits beside the note, for every verdict', () => {
  test('an approval with a note is remembered by default', async ({ page }) => {
    const patches = await mockAgentsPage(page, queue());
    await mockProxy(page, '{"matches":[]}');
    await loadAgentsPage(page);
    await openApprovals(page);
    const box = cardEl(page, 'recSrc').locator('.apv-note-row #apvRemember-recSrc');
    await expect(box).toBeChecked();
    await decideWithNote(page, 'recSrc', 'Approve', HAVERHILL_NOTE);
    await expect.poll(() => patches.some((p) => p.id === 'recSrc')).toBe(true);
    expect(patches.find((p) => p.id === 'recSrc').fields[REMEMBER_THIS]).toBe(true);
  });

  test('Request changes with a note is remembered; unticked, it is a one-off', async ({ page }) => {
    const patches = await mockAgentsPage(page, queue());
    await mockProxy(page, '{"matches":[]}');
    await loadAgentsPage(page);
    await openApprovals(page);
    await decideWithNote(page, 'recSrc', 'Request changes', 'Use the approved contractor.');
    await cardEl(page, 'recGas').locator('#apvRemember-recGas').uncheck();
    await decideWithNote(page, 'recGas', 'Request changes', 'Wrong date in the second line.');
    await expect.poll(() => ['recSrc', 'recGas'].every((id) => patches.some((p) => p.id === id))).toBe(true);
    expect(patches.find((p) => p.id === 'recSrc').fields[REMEMBER_THIS]).toBe(true);
    expect(patches.find((p) => p.id === 'recGas').fields[REMEMBER_THIS]).toBeUndefined();
  });

  test('an approval with no note never writes Remember', async ({ page }) => {
    const patches = await mockAgentsPage(page, queue());
    await loadAgentsPage(page);
    await openApprovals(page);
    await expect(cardEl(page, 'recSrc').locator('#apvRemember-recSrc')).toBeChecked();
    await cardEl(page, 'recSrc').locator('.apv-actions button', { hasText: /^Approve$/ }).click();
    await expect.poll(() => patches.some((p) => p.id === 'recSrc')).toBe(true);
    expect(patches.find((p) => p.id === 'recSrc').fields[REMEMBER_THIS]).toBeUndefined();
  });
});
