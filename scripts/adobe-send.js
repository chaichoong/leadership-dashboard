#!/usr/bin/env node
/**
 * adobe-send.js — press Send on ONE named Adobe draft, after Kevin's yes in a chat he is in.
 *
 * WHY THIS EXISTS (Kevin, 10 Nov 2026)
 * ------------------------------------
 * adobe-assign.js builds a tenancy agreement in Adobe and stops before Send, on purpose:
 * Kevin checks the boxes first. The tenant-doc-generator skill then said "turn signing
 * order on, then Send", but nothing in the repo did it, so every pack session wrote its
 * own one-off browser script (George O'Reilly, 10 Nov 2026). Kevin asked for the gap
 * closed the same day.
 *
 * WHAT IT REFUSES, IN CODE
 * ------------------------
 * - Any run that is not a chat Kevin is in: a robot slot (AGENT_SLOT_SCRATCH), the task
 *   manager (TASK_MANAGER_SCRATCH), or any session not marked attended
 *   (CLAUDE_CODE_SESSION_ATTENDED=1). Sending a legal document is Kevin's yes, and only a
 *   chat he is in can carry it. Robots keep adobe-assign.js, which cannot send.
 * - A name that matches no draft, or more than one. A sent agreement leaves Drafts, so a
 *   later run for the same document normally finds nothing and refuses. The list can lag a
 *   send, though, so exit 3 (pressed, not confirmed) is never a reason to run it again
 *   (28 Sep 2026: a retry made a second proof of residency after Kevin had signed the first).
 * - A draft whose first recipient is not info@agilelets.co.uk (Agile Lets signs first).
 * - A draft with two or more recipients whose "Recipients must complete in order" switch
 *   does not read ON after the script turns it on (Kevin, 28 Sep 2026).
 *
 * PROOF
 * -----
 * Adobe's own line "<name> was successfully sent for signature". Without it the run exits 3
 * and says not to run it again: read Waiting for you first.
 *
 * USAGE
 *   node scripts/adobe-send.js --title "AST_Jane_Testwood_5_Dalham_Place" --shot out.png [--open-only]
 *   node scripts/adobe-send.js --selftest
 *   --open-only opens the draft, reads its recipients and the switch, screenshots, presses nothing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROFILE = path.join(os.homedir(), '.config', 'od', 'agent-browser', 'default');
const DRAFTS_URL = 'https://acrobat.adobe.com/link/documents/agreements/#agreement_type=agreement&agreement_state=draft';
const FIRST_SIGNER = 'info@agilelets.co.uk';
const SEL = {
  draftsFilter: '[data-testid="draft"]',
  send: '[data-testid="review-send-button"]',
  recipientRow: '[data-testid^="recipient-list-item-"]',
};
// Measured 10 Nov 2026: the drafts list paints about 20 s after its nav, the filter in 9 s.
const WAIT = { list: 20000, filter: 9000, editor: 60000, settle: 3000, confirm: 90000 };

let THROW_ON_REFUSE = require.main !== module;
function die(msg, code = 1) {
  if (THROW_ON_REFUSE) throw new Error('SEND REFUSED: ' + msg);
  console.error('SEND REFUSED: ' + msg);
  process.exit(code);
}

/** Why this process may not send, or '' when it may. */
function headlessRefusal(env) {
  if (env.AGENT_SLOT_SCRATCH) return 'this is a robot slot run. Robots build drafts with adobe-assign.js and never send.';
  if (env.TASK_MANAGER_SCRATCH) return 'this is a task manager run. Only a chat Kevin is in may send.';
  if (String(env.CLAUDE_CODE_SESSION_ATTENDED || '') !== '1') {
    return 'this session is not one Kevin is in (CLAUDE_CODE_SESSION_ATTENDED is not 1). Sending needs his yes in the chat.';
  }
  return '';
}

/** The draft name: long enough that it cannot match the wrong agreement. */
function checkTitle(raw) {
  const t = String(raw || '').trim();
  if (!t) die('--title is required: the draft\'s name as Adobe lists it.');
  if (t.length < 12) die(`"${t}" is too short to pick one draft safely. Give at least 12 characters.`);
  return t;
}

/** Recipient rows as Adobe prints them ("info@agilelets.co.uk (myself)"), checked. */
function checkRecipients(rows) {
  const list = (rows || []).map((r) => String(r).replace(/\s+/g, ' ').replace(/\(myself\)/i, '').trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) die('the draft lists no recipients.');
  if (list[0] !== FIRST_SIGNER) die(`the first recipient is ${list[0]}, not ${FIRST_SIGNER}. Agile Lets signs first.`);
  return { recipients: list, needsOrder: list.length > 1 };
}

/** Adobe's confirmation for exactly this draft. */
function confirmed(bodyText, title) {
  const t = String(bodyText || '').replace(/\s+/g, ' ');
  return t.includes(`${title} was successfully sent for signature`);
}

async function run({ title, shot, openOnly }) {
  const { chromium } = require('playwright');
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, viewport: { width: 1280, height: 2400 },
    channel: fs.existsSync('/Applications/Google Chrome.app') ? 'chrome' : undefined,
    ignoreDefaultArgs: fs.existsSync('/Applications/Google Chrome.app') ? ['--enable-automation'] : undefined,
  });
  const log = (m) => console.error(new Date().toISOString().slice(11, 19) + ' ' + m);
  const snap = async () => { if (shot) await page.screenshot({ path: shot }).catch(() => {}); };
  let page;
  try {
    page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(DRAFTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(WAIT.list);
    // The address alone shows ALL agreements; the side panel's Drafts item filters (adobe-drafts.js, 11 Sep 2026).
    if (!(await page.locator(SEL.draftsFilter).first().click({ timeout: 15000 }).then(() => true).catch(() => false))) {
      await snap();
      die('the Drafts filter did not draw (signed out?). Nothing was sent.');
    }
    await page.waitForTimeout(WAIT.filter);
    const rows = page.locator('[role="row"]', { hasText: title });
    const n = await rows.count();
    log(`drafts matching "${title}": ${n}`);
    if (n !== 1) {
      await snap();
      die(n ? `${n} drafts match "${title}". Delete the duplicate (adobe-drafts.js) first. Nothing was sent.`
            : `no draft matches "${title}". If it was sent already, it is in Waiting for you. Nothing was sent.`);
    }
    const row = rows.first();
    const cell = row.locator(`[title*=${JSON.stringify(title)}]`).first();
    await ((await cell.count()) ? cell : row).click({ timeout: 15000 });
    const open = await page.locator(SEL.send).waitFor({ state: 'visible', timeout: WAIT.editor }).then(() => true).catch(() => false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(WAIT.settle);
    if (!open) { await snap(); die('the draft did not open in the editor. Nothing was sent.'); }

    const { recipients, needsOrder } = checkRecipients(await page.locator(SEL.recipientRow).allInnerTexts());
    log('recipients in order: ' + recipients.join(', '));
    const named = page.getByRole('switch', { name: /complete in order/i });
    const hasSwitch = (await named.count()) === 1;
    let orderOn = hasSwitch ? await named.isChecked().catch(() => null) : null;
    if (needsOrder) {
      if (!hasSwitch) { await snap(); die('no "Recipients must complete in order" switch on a draft with two recipients. Nothing was sent.'); }
      if (!orderOn) {
        await named.click({ force: true });
        await page.waitForTimeout(WAIT.settle);
        orderOn = await named.isChecked().catch(() => null);
      }
      log('signing order: ' + (orderOn ? 'ON' : 'OFF'));
      if (!orderOn) { await snap(); die('the signing order switch would not turn on. Nothing was sent.'); }
    }
    if (openOnly) {
      await snap();
      return { title, recipients, orderOn, sent: false, note: 'Opened only. Nothing was pressed except the order switch.' };
    }
    await page.locator(SEL.send).click();
    log('pressed Send');
    const seen = await page.getByText(new RegExp(`${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} was successfully sent for signature`))
      .first().waitFor({ state: 'visible', timeout: WAIT.confirm }).then(() => true).catch(() => false);
    await snap();
    const body = await page.locator('body').innerText().catch(() => '');
    if (!seen || !confirmed(body, title)) {
      die('Send was pressed but Adobe\'s "successfully sent" line did not show. Do NOT run this again: '
        + 'read Waiting for you and Completed for the name first.', 3);
    }
    return { title, recipients, orderOn, sent: true, proof: `${title} was successfully sent for signature`, screenshot: shot || null };
  } finally {
    await ctx.close();
  }
}

function arg(list, name) {
  const i = list.indexOf('--' + name);
  return i >= 0 ? list[i + 1] : null;
}

async function main() {
  const rest = process.argv.slice(2);
  if (rest.includes('--selftest')) return selftest();
  const why = headlessRefusal(process.env);
  if (why) die(why);
  const title = checkTitle(arg(rest, 'title'));
  const res = await run({ title, shot: arg(rest, 'shot'), openOnly: rest.includes('--open-only') });
  console.log(JSON.stringify(res, null, 2));
}

function selftest() {
  THROW_ON_REFUSE = true;
  const cases = [];
  const check = (n, f) => { try { cases.push([n, !!f()]); } catch { cases.push([n, false]); } };
  const refuses = (f) => { try { f(); return false; } catch { return true; } };
  check('a robot slot may not send', () => /robot/.test(headlessRefusal({ AGENT_SLOT_SCRATCH: '/x', CLAUDE_CODE_SESSION_ATTENDED: '1' })));
  check('the task manager may not send', () => !!headlessRefusal({ TASK_MANAGER_SCRATCH: '/x', CLAUDE_CODE_SESSION_ATTENDED: '1' }));
  check('an unattended session may not send', () => !!headlessRefusal({}));
  check('an attended chat may send', () => headlessRefusal({ CLAUDE_CODE_SESSION_ATTENDED: '1' }) === '');
  check('a short title is refused', () => refuses(() => checkTitle('AST_Jane')));
  check('info@ first passes and two recipients need the order', () => {
    const r = checkRecipients(['info@agilelets.co.uk (myself)', 'jane@example.com']);
    return r.needsOrder && r.recipients[1] === 'jane@example.com';
  });
  check('one recipient needs no order', () => checkRecipients(['info@agilelets.co.uk (myself)']).needsOrder === false);
  check('the tenant first is refused', () => refuses(() => checkRecipients(['jane@example.com', 'info@agilelets.co.uk'])));
  check('the confirmation must name this draft', () => confirmed('X  AST_Jane_Testwood was successfully sent for signature A PDF', 'AST_Jane_Testwood')
    && !confirmed('AST_Other was successfully sent for signature', 'AST_Jane_Testwood'));
  const failed = cases.filter(([, ok]) => !ok);
  cases.forEach(([n, ok]) => console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}`));
  if (failed.length) { console.log(`selftest FAILED: ${failed.length}`); process.exit(1); }
  console.log(`selftest OK: ${cases.length} cases`);
}

module.exports = { headlessRefusal, checkTitle, checkRecipients, confirmed };

if (require.main === module) main().catch((e) => die(e.message.split('\n')[0]));
