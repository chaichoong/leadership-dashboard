#!/usr/bin/env node
/**
 * signature-watch.js — notices when a document comes back signed.
 *
 * WHY THIS EXISTS (28 Aug 2026)
 * -----------------------------
 * Kevin's workflow has two gates and a wait in the middle:
 *
 *   "They would create the PDF and show me it for approval. They would then
 *    send it off to be signed by the relevant people. Once it comes back, they
 *    would then show me that document with the email correspondence ready to
 *    go, and I would then confirm it. They would then send it off."
 *
 * "Once it comes back" had nothing behind it. Every other stage worked and the
 * chain broke in the middle: an agent could send a document for signature and
 * then never learn it had been signed, so gate two never happened.
 *
 * WHY ADOBE AND NOT GMAIL
 * -----------------------
 * Adobe emails a "Signed and Filed" notice, so watching Gmail looks easier. It
 * is the wrong source:
 *
 *   * Adobe is the RECORD. The email is a notification, and a notification can
 *     be filtered, archived by the triage agent, or never arrive.
 *   * The signed PDF has to come from Adobe anyway; the worker's Gmail
 *     endpoints have no attachment route.
 *   * Measured 28 Aug: the worker's /gmail/list returns HTTP 200 and ZERO
 *     messages for kevinbrittain@gmail.com, because only the runpreneur mailbox
 *     is connected. A broken query and an empty inbox are indistinguishable —
 *     exactly the silent-zero this codebase has been bitten by before.
 *
 * So: one source, the authoritative one, with a control that fails loudly.
 *
 * THE CONTROL
 * -----------
 * An empty Completed list is a legitimate answer ("nothing signed yet") AND
 * what a logged-out session looks like. Those must never be confused, so the
 * poll asserts the agreements app actually rendered before it believes a zero.
 * If it cannot see the nav, it FAILS rather than reporting nothing to do.
 *
 * USAGE
 *   node scripts/signature-watch.js register --task recXXX --agreement "NAME" --then post
 *   node scripts/signature-watch.js poll
 *   node scripts/signature-watch.js status
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const PROFILE = path.join(os.homedir(), '.config', 'od', 'agent-browser', 'default');
const LEDGER = process.env.SIGNATURE_WATCH_LEDGER ||
  path.join(os.homedir(), 'knowledge-os', 'logs', 'signature-watch', 'watch.jsonl');
const OUT_DIR = path.join(os.homedir(), 'knowledge-os', 'attachments');
// Overridable so the CONTROL can be back-tested. A guard nobody has watched
// fire is not a guard: the test points this at a page with no agreements nav
// and asserts the poll REFUSES rather than reporting "nothing signed yet".
const COMPLETED_URL = process.env.SIGNATURE_WATCH_URL ||
  'https://acrobat.adobe.com/link/documents/agreements/#agreement_type=agreement&agreement_state=completed';

function die(msg) {
  if (require.main !== module) throw new Error('WATCH REFUSED: ' + msg);
  console.error('WATCH REFUSED: ' + msg);
  process.exit(1);
}

function rows() {
  try {
    return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
}

function append(row) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
}

/** Registered and not yet seen signed. Last write per task wins. */
function pending() {
  const state = new Map();
  for (const r of rows()) {
    if (r.cmd === 'register') state.set(r.task, { ...r, signed: false });
    if (r.cmd === 'signed' && state.has(r.task)) state.get(r.task).signed = true;
  }
  return [...state.values()].filter((r) => !r.signed);
}

function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'signed';
}

async function withPage(fn) {
  let chromium;
  for (const m of ['playwright-core', '@playwright/test',
                   path.join(REPO, 'node_modules', 'playwright-core')]) {
    try { ({ chromium } = require(m)); break; } catch { /* next */ }
  }
  if (!chromium) die('playwright not found. Run npm install in the repo.');
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, viewport: { width: 1400, height: 950 }, acceptDownloads: true,
  });
  try { return await fn(ctx.pages()[0] || await ctx.newPage()); }
  finally { await ctx.close().catch(() => {}); }
}

async function cmdRegister(args) {
  const task = args.task, agreement = args.agreement, then = (args.then || 'post').toLowerCase();
  if (!/^rec[A-Za-z0-9]{14}$/.test(task || '')) die(`--task must be an Airtable record id, got "${task}"`);
  if (!agreement) die('--agreement is required — the Adobe agreement NAME, exactly as sent');
  if (!['post', 'email'].includes(then)) die('--then must be post or email');
  append({ cmd: 'register', task, agreement, then });
  console.log(JSON.stringify({ registered: task, agreement, then,
    note: 'poll will watch Adobe Completed for this name' }, null, 2));
}

async function cmdPoll() {
  const waiting = pending();
  if (!waiting.length) {
    const handoff = handOffAll();
    console.log(JSON.stringify({ pending: 0, ready: [], handoff, note: 'nothing registered and unsigned' }, null, 2));
    if (handoff.failed) process.exit(1);
    return;
  }
  const ready = await withPage(async (page) => {
    await page.goto(COMPLETED_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(Number(process.env.SIGNATURE_WATCH_WAIT_MS || 24000));

    // THE CONTROL. An empty list is a real answer and also what a logged-out
    // session looks like. Prove the agreements app rendered before believing a
    // zero, or a broken session reports "nothing signed yet" for ever.
    const navOk = await page.locator('text=/Drafts \\(\\d+\\)/').count();
    if (!navOk) {
      die('the Adobe agreements list did not render — session expired or the page changed. ' +
          'This is NOT "nothing signed yet". Re-run: node scripts/agent-browser.js login ' +
          '--url https://acrobat.adobe.com');
    }

    const found = [];
    for (const item of waiting) {
      const row = page.locator(
        `[role=row]:has-text(${JSON.stringify(item.agreement)}), tr:has-text(${JSON.stringify(item.agreement)})`
      ).first();
      if (!(await row.count())) continue;

      await row.click();
      await page.waitForTimeout(12000);
      const dl = page.locator('text=Download PDF').first();
      if (!(await dl.count())) {
        console.error(`WARNING: ${item.agreement} is completed but has no Download PDF action`);
        await page.goBack().catch(() => {});
        await page.waitForTimeout(6000);
        continue;
      }
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 90000 }),
        dl.click(),
      ]);
      fs.mkdirSync(OUT_DIR, { recursive: true });
      // Named by TASK, not by Adobe's filename: the next step looks it up by
      // task, and Adobe's name is not ours to depend on.
      const out = path.join(OUT_DIR, `signed_${item.task}_${safeName(item.agreement)}.pdf`);
      await download.saveAs(out);
      const bytes = fs.statSync(out).size;
      append({ cmd: 'signed', task: item.task, agreement: item.agreement,
               then: item.then, pdf: out, bytes });
      found.push({ task: item.task, agreement: item.agreement, then: item.then, pdf: out, bytes });

      await page.goto(COMPLETED_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(16000);
    }
    return found;
  });

  const handoff = handOffAll();
  console.log(JSON.stringify({
    pending: waiting.length,
    ready,
    handoff,
    next: ready.length || handoff.handedOff
      ? 'Each signed document is now an open task for its agent (gate 2): it prepares the POST or email with the signed PDF attached, then Kevin approves.'
      : 'None signed yet. The control passed, so this is a real zero.',
  }, null, 2));
  if (handoff.failed) process.exit(1);
}

async function cmdStatus() {
  const waiting = pending();
  const signed = rows().filter((r) => r.cmd === 'signed');
  console.log(JSON.stringify({
    awaitingSignature: waiting.map((w) => ({ task: w.task, agreement: w.agreement, since: w.at })),
    signedAndFiled: signed.map((s) => ({ task: s.task, agreement: s.agreement, pdf: s.pdf })),
    signedAwaitingHandoff: unhandedSigned(rows()).map((s) => ({ task: s.task, agreement: s.agreement })),
    ledger: LEDGER,
  }, null, 2));
}

// A signed row is a fact; the hand-off is the work. Until 4 Sep 2026 the poll
// printed "next: submit gate 2" and stopped, and the three letters of authority
// it had found sat on disk for a day with their tasks Completed at gate 1, so no
// agent could ever see them. Now every signed row is handed to the task's agent
// through `agent-dispatch.py signed` and the ledger records that it was.
function unhandedSigned(allRows) {
  const handed = new Set(allRows.filter((r) => r.cmd === 'handoff').map((r) => r.task + '|' + r.agreement));
  return allRows.filter((r) => r.cmd === 'signed' && !handed.has(r.task + '|' + r.agreement));
}
function handOff(row) {
  const { spawnSync } = require('child_process');
  const r = spawnSync('python3', [path.join(REPO, 'scripts', 'agent-dispatch.py'), 'signed', row.task,
    '--agreement', row.agreement, '--pdf', row.pdf, '--then', row.then], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`HANDOFF FAILED for ${row.task} (${row.agreement}): ${(r.stderr || r.stdout || '').trim()}`);
    return false;
  }
  append({ cmd: 'handoff', task: row.task, agreement: row.agreement, result: (r.stdout || '').trim().slice(0, 300) });
  return true;
}
function handOffAll() {
  const todo = unhandedSigned(rows());
  const done = todo.filter(handOff);
  return { signedAwaitingHandoff: todo.length, handedOff: done.length,
           failed: todo.length - done.length, tasks: done.map((r) => r.task) };
}
function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1];
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd === 'register') return cmdRegister(args);
  if (cmd === 'poll') return cmdPoll();
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'handoff') { const r = handOffAll(); console.log(JSON.stringify(r, null, 2)); if (r.failed) process.exit(1); return; }
  die('usage: register --task recXXX --agreement "NAME" --then post|email | poll | status | handoff');
}

if (require.main === module) main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
module.exports = { pending, safeName, unhandedSigned, LEDGER, OUT_DIR, COMPLETED_URL };
